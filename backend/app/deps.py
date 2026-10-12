"""The dependency container: every subsystem, constructed once, in dependency order.

No DI framework — a file read top to bottom says what depends on what. Constructors do
no I/O (the container is built at import time); the store connects on first use and the
LLM client is built lazily from the stored settings, then rebuilt whenever they change,
so picking a model in Settings takes effect on the next call with no restart.

Subsystems receive the container and reach their peers through it at call time
(`self.c.engine…`), never by importing `app.deps` themselves — that would be circular.
"""
from __future__ import annotations

import copy
import logging
from typing import Any

from pydantic import ValidationError

from app.config import Settings, settings as env_settings
from app.engine.engine import WorkflowEngine
from app.errors import FactoryError
from app.events import EventBus
from app.llm.client import LLMClient, make_llm
from app.llm.runtime import AIRuntime
from app.mcp.manager import MCPManager
from app.mcp.operations import OperationExecutor
from app.models import AppSettings
from app.notify import Notifier
from app.scheduler import Scheduler
from app.store import SINGLETON, Store
from app.util import apply_secret_patch, deep_merge, validation_message
from app.watchers import WatcherService

log = logging.getLogger("factory.deps")

# Store bookkeeping fields that are not part of the AppSettings shape.
_DOC_META = {"id", "version", "updated_at", "created_at"}


class Container:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings: Settings = settings or env_settings
        self.store = Store(self.settings.db_file)
        self.bus = EventBus()
        self._llm: LLMClient | None = None
        self.ai = AIRuntime(self)
        self.mcp = MCPManager(self)
        self.ops = OperationExecutor(self)
        self.engine = WorkflowEngine(self)
        self.notifier = Notifier(self)
        self.watchers = WatcherService(self)
        self.scheduler = Scheduler(self)

    # ------------------------------------------------------------------ runtime settings
    def app_settings(self) -> AppSettings:
        """Stored settings merged over the model defaults — api_key in clear (internal use
        only; the API masks it). A new field added to AppSettings simply shows its default."""
        stored = {k: v for k, v in self.store.get_singleton("settings", {}).items() if k not in _DOC_META}
        defaults = AppSettings().model_dump()
        try:
            result = AppSettings.model_validate(deep_merge(defaults, stored))
        except ValidationError as exc:
            # Only reachable through a hand-edited db or an old backup: keep every section
            # that still validates rather than refusing to boot.
            log.error("Stored settings are invalid (%s) — falling back to defaults for broken sections",
                      validation_message(exc))
            sections = {}
            for name, value in stored.items():
                if name in defaults and isinstance(value, dict):
                    try:
                        AppSettings.model_validate({name: deep_merge(defaults[name], value)})
                        sections[name] = value
                    except ValidationError:
                        pass
            result = AppSettings.model_validate(deep_merge(defaults, sections))
        result.has_api_key = bool(result.llm.api_key)
        return result

    def save_app_settings(self, patch: dict) -> AppSettings:
        """Deep-merge a partial AppSettings, validate, persist, hot-swap the LLM client.
        An empty or still-masked `llm.api_key` keeps the stored key (the UI never has it);
        an explicit `null` clears it (switching to a server that needs no key)."""
        patch = copy.deepcopy(patch or {})
        patch.pop("has_api_key", None)
        if isinstance(patch.get("llm"), dict):
            apply_secret_patch(patch["llm"], "api_key")
        merged = deep_merge(self.app_settings().model_dump(exclude={"has_api_key"}), patch)
        try:
            validated = AppSettings.model_validate(merged)
        except ValidationError as exc:
            raise FactoryError(f"Invalid settings — {validation_message(exc)}", 422) from exc
        self.store.put_singleton("settings", validated.model_dump(exclude={"has_api_key"}))
        self.rebuild_llm()
        self.bus.emit("settings.updated")
        return self.app_settings()

    def seed_settings_from_env(self) -> bool:
        """First boot only: FACTORY_LLM_* pre-fill Settings › AI Model so a scripted install
        comes up connected. Once settings exist (saved from the UI), the environment no
        longer overrides them — the UI is the source of truth."""
        env = self.settings
        if not env.llm_base_url.strip() or self.store.get("settings", SINGLETON) is not None:
            return False
        llm: dict[str, Any] = {"base_url": env.llm_base_url.strip(), "model": env.llm_model.strip(),
                               "api_key": env.llm_api_key.strip()}
        if env.llm_provider.strip():
            llm["provider"] = env.llm_provider.strip().lower()
        self.save_app_settings({"llm": llm})
        self.record_event("settings.updated", "AI model settings seeded from the environment (FACTORY_LLM_*)",
                          data={"section": "llm", "action": "seeded"})
        return True

    # ------------------------------------------------------------------ LLM client
    def rebuild_llm(self) -> None:
        self._llm = make_llm(self.app_settings().llm)

    @property
    def llm(self) -> LLMClient:
        if self._llm is None:
            self.rebuild_llm()
        assert self._llm is not None
        return self._llm

    @llm.setter
    def llm(self, client: LLMClient) -> None:   # tests and the integrator may inject a client
        self._llm = client

    # ------------------------------------------------------------------ lookups
    def users(self) -> list[dict]:
        return self.store.list("users")

    def get_user(self, id: str) -> dict | None:
        return self.store.get("users", id) if id else None

    def user_by_email(self, email: str) -> dict | None:
        wanted = (email or "").strip().lower()
        if not wanted:
            return None
        return next((u for u in self.users() if (u.get("email") or "").strip().lower() == wanted), None)

    def teams(self) -> list[dict]:
        return self.store.list("teams")

    def get_team(self, id: str) -> dict | None:
        return self.store.get("teams", id) if id else None

    def roles(self) -> list[dict]:
        """RoleDef dicts. Stored as the singleton {"id": "singleton", "roles": [...]}."""
        return list(self.store.get_singleton("roles", {}).get("roles") or [])

    def get_operation_by_key(self, key: str) -> dict | None:
        return next((op for op in self.store.list("operations") if op.get("key") == key), None) if key else None

    def get_blueprint(self, id: str) -> dict | None:
        return self.store.get("blueprints", id) if id else None

    def get_blueprint_by_key(self, key: str) -> dict | None:
        return next((bp for bp in self.store.list("blueprints") if bp.get("key") == key), None) if key else None

    # ------------------------------------------------------------------ activity
    def record_event(self, kind: str, message: str, *, actor: str = "system", project_id: str = "",
                     step_id: str = "", data: dict | None = None) -> dict:
        """Persist an activity/audit Event (hash-chained) and push it live as `activity`."""
        event = self.store.add_event({"kind": kind, "message": message, "actor": actor or "system",
                                      "project_id": project_id, "step_id": step_id, "data": data or {}})
        self.bus.emit("activity", event=event)
        return event


container = Container()
