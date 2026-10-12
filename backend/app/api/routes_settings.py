"""Runtime settings (the `settings` singleton) and the AI-model helpers of Settings › AI Model:
presets, connection test and model listing — both usable on an unsaved draft (SPEC §9)."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body

from app.api import actor, public_settings, validate
from app.deps import container as c
from app.errors import FactoryError
from app.llm.client import LLM_PRESETS, make_llm
from app.models import LLMSettings
from app.util import apply_secret_patch, deep_merge

log = logging.getLogger("factory.api.settings")
router = APIRouter(prefix="/api")

# One entry per AppSettings section (tests check they stay in step).
SECTION_LABELS = {"llm": "AI model", "engine": "Engine", "scheduler": "Scheduler",
                  "notifications": "Notifications", "general": "General"}


@router.get("/settings")
async def get_settings() -> dict[str, Any]:
    return public_settings(c.app_settings())


@router.put("/settings")
async def put_settings(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    """Deep-merge a partial AppSettings. `llm.api_key` "" (or the masked value) keeps the
    stored key; `null` clears it. The audit event names the changed fields, never values."""
    patch = dict(body)
    acting = actor(patch.pop("user_id", None) or user_id)
    patch.pop("has_api_key", None)
    unknown = sorted(set(patch) - set(SECTION_LABELS))
    if unknown:
        raise FactoryError(f"Unknown settings section(s): {', '.join(unknown)}", 422)
    for name, section in patch.items():
        if not isinstance(section, dict):
            raise FactoryError(f"Settings section '{name}' must be an object", 422)

    before = c.app_settings().model_dump()
    after = c.save_app_settings(patch)
    changed = _changed_fields(before, after.model_dump())
    if changed:
        sections = sorted({f.split(".", 1)[0] for f in changed}, key=list(SECTION_LABELS).index)
        c.record_event("settings.updated",
                       "Settings updated: " + ", ".join(SECTION_LABELS[s] for s in sections),
                       actor=acting, data={"sections": sections, "fields": changed})
        if "llm" in sections:   # intake items that waited for an LLM become triage candidates again
            c.watchers.release_llm_waits()
    return public_settings(after)


def _changed_fields(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """"llm.model", "general.hours_saved"… — the dotted field names whose value changed."""
    out = []
    for section in SECTION_LABELS:
        old, new = before.get(section) or {}, after.get(section) or {}
        out += [f"{section}.{k}" for k in sorted(set(old) | set(new)) if old.get(k) != new.get(k)]
    return out


# ---------------------------------------------------------------------------------- LLM helpers

@router.get("/llm/presets")
async def llm_presets() -> list[dict[str, Any]]:
    return list(LLM_PRESETS)


@router.post("/llm/test")
async def llm_test(body: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    """Test the saved model, or a draft over it (the body is a partial LLMSettings) before
    saving. A failed test is an answer, not an HTTP error: {ok: false, error}."""
    cfg = _draft(body)
    try:
        return await make_llm(cfg).test()
    except FactoryError as exc:
        return {"ok": False, "latency_ms": 0, "model": cfg.model, "reply": "", "error": exc.message}
    except Exception as exc:   # the test exists to report whatever goes wrong
        log.exception("LLM test failed unexpectedly")
        return {"ok": False, "latency_ms": 0, "model": cfg.model, "reply": "",
                "error": f"{type(exc).__name__}: {exc}"}


@router.get("/llm/models")
async def llm_models(provider: str = "", base_url: str = "") -> dict[str, Any]:
    """Models of the saved server, or of the one named in the query (draft, before Save)."""
    draft = {k: v for k, v in {"provider": provider, "base_url": base_url}.items() if v}
    return await _list_models(_draft(draft))


@router.post("/llm/models")
async def llm_models_draft(body: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    """Same as GET, for a draft that carries a new API key: a secret never goes in a URL."""
    return await _list_models(_draft(body))


async def _list_models(cfg: LLMSettings) -> dict[str, Any]:
    try:
        return {"models": await make_llm(cfg).list_models(), "error": ""}
    except FactoryError as exc:
        return {"models": [], "error": exc.message}
    except Exception as exc:
        log.exception("Listing LLM models failed unexpectedly")
        return {"models": [], "error": f"{type(exc).__name__}: {exc}"}


def _draft(patch: dict[str, Any] | None) -> LLMSettings:
    """The saved LLM settings with a partial draft over them. Like PUT /settings, an empty or
    masked api_key means "the stored key" and null means "no key"."""
    draft = apply_secret_patch({k: v for k, v in (patch or {}).items() if k != "user_id"}, "api_key")
    merged = deep_merge(c.app_settings().llm.model_dump(), draft)
    return validate(LLMSettings, merged, "AI model settings")   # type: ignore[return-value]
