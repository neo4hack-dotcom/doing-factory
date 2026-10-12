"""Test doubles shared by the test_api_* modules (no tests here).

* ScriptedLLM — an LLM client whose replies are scripted per call: no network, deterministic,
  and it records every message list it received, so a test can assert what the model was told.
* FakeEngine — a store-backed stand-in for the WorkflowEngine, enough for the routes (which
  are thin wrappers): it creates projects from blueprints, lists summaries, applies patches
  and records every human action it receives.
* Emitted — records bus events (`reference.updated`, `copilot.progress`…).
* is_stub(module) — whether a module is still the foundation stub, so smoke tests against the
  real engine / services run automatically once those land.
"""
from __future__ import annotations

import importlib
import inspect
import json
from typing import Any, Callable

from app.errors import FactoryError, NotFound
from app.llm.client import LLMReply
from app.util import new_id, now_iso


def is_stub(module_name: str) -> bool:
    source = inspect.getsource(importlib.import_module(module_name))
    return source.lstrip().startswith("# STUB")


# ---------------------------------------------------------------------------------- LLM

Reply = LLMReply | str | dict | Callable[[list[dict], dict], "LLMReply | str | dict"]


class ScriptedLLM:
    """Pops one scripted reply per chat() call. A str is the content; a dict is JSON content
    (or, with key "tool_calls", a native tool-call turn); a callable gets (messages, kwargs)."""

    provider = "ollama"
    configured = True

    def __init__(self, replies: list[Reply] | None = None, *, tools: bool = True, model: str = "fake-model") -> None:
        self.replies = list(replies or [])
        self.tools = tools
        self.model = self.fast_model = model
        self.calls: list[dict[str, Any]] = []

    def is_remote(self, model: str | None = None) -> bool:
        return False

    async def supports_tools(self, model: str | None = None) -> bool:
        return self.tools

    async def chat(self, messages: list[dict], **kwargs: Any) -> LLMReply:
        self.calls.append({"messages": [dict(m) for m in messages], **kwargs})
        if not self.replies:
            raise AssertionError("ScriptedLLM: no reply scripted for this call")
        reply = self.replies.pop(0)
        if callable(reply):
            reply = reply(messages, kwargs)
        if isinstance(reply, LLMReply):
            return reply
        if isinstance(reply, dict) and "tool_calls" in reply:
            calls = [{"id": f"call_{i}", "name": c["name"], "arguments": c.get("arguments") or {}}
                     for i, c in enumerate(reply["tool_calls"])]
            return LLMReply(content=reply.get("content", ""), tool_calls=calls, tokens_in=10, tokens_out=5,
                            latency_ms=3, model=self.model, finish_reason="stop")
        content = reply if isinstance(reply, str) else json.dumps(reply)
        return LLMReply(content=content, tokens_in=10, tokens_out=5, latency_ms=3, model=self.model,
                        finish_reason="stop")

    async def list_models(self) -> list[dict]:
        return [{"name": self.model, "local": True}]

    async def test(self) -> dict:
        return {"ok": True, "latency_ms": 1, "model": self.model, "reply": "ok", "error": ""}


# ---------------------------------------------------------------------------------- bus

class Emitted:
    """Wraps container.bus.emit (installed with monkeypatch) and keeps what was emitted."""

    def __init__(self, bus: Any) -> None:
        self.events: list[tuple[str, dict]] = []
        self._emit = bus.emit

    def __call__(self, type: str, **payload: Any) -> None:
        self.events.append((type, payload))
        self._emit(type, **payload)

    def of(self, type: str) -> list[dict]:
        return [p for t, p in self.events if t == type]


def record_bus(monkeypatch, container) -> Emitted:
    recorder = Emitted(container.bus)
    monkeypatch.setattr(container.bus, "emit", recorder)
    return recorder


# ---------------------------------------------------------------------------------- engine

class FakeEngine:
    def __init__(self, container: Any) -> None:
        self.c = container
        self.calls: list[tuple[str, tuple]] = []

    # lifecycle
    async def recover(self) -> None:
        return None

    def kick(self, project_id: str) -> None:
        return None

    async def advance(self, project_id: str) -> None:
        return None

    # projects
    async def create_project(self, blueprint_id: str, *, title: str, description: str = "", inputs: dict | None = None,
                             priority: str = "medium", sponsor_id: str = "", owner_id: str = "", team_id: str = "",
                             tags: list[str] | None = None, due_date: str | None = None, source: dict | None = None,
                             parent_id: str = "", parent_step_id: str = "", created_by: str = "") -> dict:
        bp = self.c.get_blueprint(blueprint_id)
        if bp is None:
            raise NotFound(f"Blueprint {blueprint_id} not found")
        self.calls.append(("create_project", (blueprint_id, title)))
        stages = [{"id": s["id"], "name": s.get("name", ""), "status": "pending",
                   "steps": [{"id": t["id"], "name": t.get("name", ""), "type": t.get("type", "ai_task"),
                              "status": "pending", "config": t.get("config") or {}} for t in s.get("steps") or []]}
                  for s in bp.get("stages") or []]
        project = {"id": new_id("prj"), "key": f"{bp.get('key_prefix') or 'PRJ'}-{self.c.store.next_seq('fake'):04d}",
                   "title": title, "description": description, "blueprint_id": blueprint_id,
                   "blueprint_name": bp.get("name", ""), "blueprint_version": bp.get("version", 1),
                   "kind": bp.get("kind", "custom"), "status": "active", "priority": priority,
                   "sponsor_id": sponsor_id, "owner_id": owner_id, "team_id": team_id, "tags": tags or [],
                   "due_date": due_date, "inputs": inputs or {}, "source": source or {}, "parent_id": parent_id,
                   "stages": stages, "current_stage_id": stages[0]["id"] if stages else "",
                   "created_by": created_by, "created_at": now_iso()}
        return self.c.store.put("projects", project)

    def get(self, project_id: str) -> dict:
        project = self.c.store.get("projects", project_id)
        if project is None:
            raise NotFound(f"Project {project_id} not found")
        return project

    def summary(self, project: dict) -> dict:
        steps = [t for s in project.get("stages") or [] for t in s.get("steps") or []]
        done = sum(t.get("status") in ("done", "skipped") for t in steps)
        current = next((s for s in project.get("stages") or [] if s["id"] == project.get("current_stage_id")), {})
        return {"id": project["id"], "key": project.get("key", ""), "title": project.get("title", ""),
                "kind": project.get("kind", ""), "blueprint_id": project.get("blueprint_id", ""),
                "blueprint_name": project.get("blueprint_name", ""), "status": project.get("status", "active"),
                "priority": project.get("priority", "medium"), "sponsor_id": project.get("sponsor_id", ""),
                "owner_id": project.get("owner_id", ""), "team_id": project.get("team_id", ""),
                "current_stage_id": project.get("current_stage_id", ""), "current_stage_name": current.get("name", ""),
                "progress": done / len(steps) if steps else 0.0,
                "open_step_names": [t["name"] for t in steps if t.get("status") not in ("pending", "done", "skipped")],
                "risk": project.get("risk") or {}, "parent_id": project.get("parent_id", ""),
                "child_count": len(project.get("child_ids") or []), "due_date": project.get("due_date"),
                "created_at": project.get("created_at", ""), "tags": project.get("tags") or []}

    def list_summaries(self, *, status=None, blueprint_id=None, q=None, parent_id=None, user_id=None) -> list[dict]:
        out = []
        for p in self.c.store.list("projects"):
            if status and p.get("status") != status:
                continue
            if blueprint_id and p.get("blueprint_id") != blueprint_id:
                continue
            if parent_id and p.get("parent_id") != parent_id:
                continue
            if q and q.lower() not in f"{p.get('key')} {p.get('title')} {p.get('description')}".lower():
                continue
            if user_id and user_id not in (p.get("sponsor_id"), p.get("owner_id")):
                continue
            out.append(self.summary(p))
        return out

    def can_act(self, project: dict, step: dict, user_id: str) -> bool:
        return True

    # human actions: recorded, the project returned unchanged unless the action says otherwise
    def _act(self, name: str, pid: str, *args: Any) -> dict:
        self.calls.append((name, (pid, *args)))
        return self.get(pid)

    async def start_step(self, pid, sid, user_id):
        return self._act("start_step", pid, sid, user_id)

    async def save_form(self, pid, sid, user_id, form):
        return self._act("save_form", pid, sid, user_id, form)

    async def complete_step(self, pid, sid, user_id, form=None, output=None):
        return self._act("complete_step", pid, sid, user_id, form, output)

    async def request_ai_draft(self, pid, sid, user_id, instructions=""):
        return self._act("request_ai_draft", pid, sid, user_id, instructions)

    async def decide(self, pid, sid, user_id, decision, comment=""):
        if user_id == "usr_nobody":
            raise FactoryError("You cannot approve this step.", 403)
        return self._act("decide", pid, sid, user_id, decision, comment)

    async def submit_estimate(self, pid, sid, user_id, estimate):
        return self._act("submit_estimate", pid, sid, user_id, estimate)

    async def confirm(self, pid, sid, user_id, approve, payload=None):
        return self._act("confirm", pid, sid, user_id, approve, payload)

    async def gate_action(self, pid, sid, user_id, action, comment="", rule_ids=None, goto_step=""):
        return self._act("gate_action", pid, sid, user_id, action, comment, rule_ids, goto_step)

    async def retry_step(self, pid, sid, user_id):
        return self._act("retry_step", pid, sid, user_id)

    async def skip_step(self, pid, sid, user_id, reason):
        return self._act("skip_step", pid, sid, user_id, reason)

    async def reopen_step(self, pid, sid, user_id, reason):
        return self._act("reopen_step", pid, sid, user_id, reason)

    async def reassign_step(self, pid, sid, user_id, user_ids):
        return self._act("reassign_step", pid, sid, user_id, user_ids)

    async def cancel_project(self, pid, user_id, reason):
        project = self._act("cancel_project", pid, user_id, reason)
        return self.c.store.put("projects", {**project, "status": "cancelled"})

    async def update_project(self, pid, user_id, patch):
        project = self._act("update_project", pid, user_id, patch)
        return self.c.store.put("projects", {**project, **patch})

    async def update_artifact(self, pid, artifact_id, user_id, content):
        project = self._act("update_artifact", pid, artifact_id, user_id, content)
        artifacts = [{**a, "content": content, "version": a.get("version", 1) + 1} if a.get("id") == artifact_id else a
                     for a in project.get("artifacts") or []]
        return self.c.store.put("projects", {**project, "artifacts": artifacts})

    async def add_comment(self, pid, user_id, text):
        self._act("add_comment", pid, user_id, text)
        return self.c.record_event("comment.added", text, actor=user_id, project_id=pid)

    async def add_link(self, pid, user_id, link):
        project = self._act("add_link", pid, user_id, link)
        return self.c.store.put("projects", {**project, "links": [*(project.get("links") or []),
                                                                     {"id": new_id("lnk"), **link}]})

    async def delete_project(self, pid) -> None:
        self._act("delete_project", pid)
        self.c.store.delete("projects", pid)


def install_fake_engine(monkeypatch, container) -> FakeEngine:
    engine = FakeEngine(container)
    monkeypatch.setattr(container, "engine", engine)
    return engine


def valid_report(container, blueprint) -> dict:
    """Stand-in for engine.blueprint.validate_blueprint while it is a stub."""
    errors = [] if blueprint.get("stages") else ["A blueprint needs at least one stage."]
    return {"ok": not errors, "errors": errors, "warnings": []}
