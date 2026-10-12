"""Operations (named MCP bindings): GET|POST /operations, PUT|DELETE /operations/{id},
POST /operations/{id}/run, POST /operations/suggest (SPEC §3.3, §7, §9).

Blueprints, watchers and the notification channel refer to an operation by its `key`, so the
key is unique and cannot be renamed or deleted while something still uses it — a workflow
would otherwise fail at run time, possibly half-way through a delivery. Mutations are
audited as `settings.updated` (section operations) and emit `reference.updated`.
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Body

from app import ai_utils
from app.api import actor, editable, found, shape, shape_all, validate
from app.deps import container as c
from app.errors import Conflict, FactoryError
from app.models import Operation, OperationResult
from app.util import new_id, now_iso, truncate

router = APIRouter(prefix="/api")

_KEY = re.compile(r"[^a-z0-9_.\-]+")


def _changed() -> None:
    c.bus.emit("reference.updated", collection="operations")


def _audit(message: str, acting: str, action: str, op: dict[str, Any]) -> None:
    c.record_event("settings.updated", message, actor=actor(acting),
                   data={"section": "operations", "action": action, "operation_id": op.get("id"),
                         "key": op.get("key")})


def _normalise_key(raw: str) -> str:
    """"Portfolio / List projects" → "portfolio.list_projects"-style: lowercase, dots kept."""
    key = _KEY.sub("_", (raw or "").strip().lower().replace(" ", "_")).strip("._-")
    return re.sub(r"_+", "_", key)[:80]


def operation_users(key: str) -> list[str]:
    """Human-readable places that call operation `key`: blueprint steps, watchers, settings."""
    if not key:
        return []
    out = []
    for bp in c.store.list("blueprints"):
        for stage in bp.get("stages") or []:
            for step in stage.get("steps") or []:
                if (step.get("config") or {}).get("operation_key") == key:
                    out.append(f"blueprint '{bp.get('name')}' › {step.get('name') or step.get('id')}")
    out += [f"watcher '{w.get('name')}'" for w in c.store.list("watchers") if w.get("operation_key") == key]
    if c.app_settings().notifications.channel_operation_key == key:
        out.append("Settings › Notifications (external channel)")
    return out


def _checked(data: dict[str, Any]) -> dict[str, Any]:
    op = validate(Operation, data, "operation").model_dump()
    op["name"] = op["name"].strip()
    op["key"] = _normalise_key(op["key"] or op["name"])
    if not op["key"]:
        raise FactoryError("An operation needs a key (e.g. jira.create_issue) or a name to derive it from.", 422)
    op["name"] = op["name"] or op["key"]
    clash = next((o for o in c.store.list("operations") if o["id"] != op["id"] and o.get("key") == op["key"]), None)
    if clash is not None:
        raise Conflict(f"The key '{op['key']}' is already used by the operation '{clash.get('name')}'.")
    connector = c.store.get("connectors", op["connector_id"]) if op["connector_id"] else None
    if connector is None:
        raise FactoryError("Pick the connector (MCP server) this operation calls.", 422)
    op["tool"] = op["tool"].strip()
    if op["mode"] in ("direct", "llm") and not op["tool"]:
        raise FactoryError(f"A {op['mode']}-mode operation needs the tool it calls.", 422)
    if op["mode"] in ("llm", "agent") and not op["prompt"].strip():
        raise FactoryError(f"A {op['mode']}-mode operation needs a prompt "
                           f"({'how to build the arguments' if op['mode'] == 'llm' else 'the goal of the agent'}).", 422)
    known = {t.get("name") for t in connector.get("tools") or []}
    if known:   # only checkable once the connector was tested; otherwise the first run says it
        for name in ([op["tool"]] if op["tool"] else []) + list(op["allowed_tools"]):
            bare = name.split("__")[-1]
            if bare not in known:
                raise FactoryError(f"'{connector.get('name')}' has no tool '{name}' (known: "
                                   f"{', '.join(sorted(known)[:15])}). Test the connector to refresh its tool list.", 422)
    return op


def _tool_is_sensitive(connector_id: str, tool: str) -> bool:
    connector = c.store.get("connectors", connector_id) or {}
    return any(t.get("name") == tool and t.get("sensitive") for t in connector.get("tools") or [])


@router.get("/operations")
async def list_operations() -> list[dict[str, Any]]:
    return shape_all(Operation, c.store.list("operations"))


@router.get("/operations/{id}")
async def get_operation(id: str) -> dict[str, Any]:
    return shape(Operation, found(c.store.get("operations", id), "Operation", id))


@router.post("/operations")
async def create_operation(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    stamp = now_iso()
    op = _checked({**editable(Operation, body), "id": new_id("op"), "created_at": stamp, "updated_at": stamp})
    if "sensitive" not in body and op["tool"]:
        op["sensitive"] = _tool_is_sensitive(op["connector_id"], op["tool"])   # writes ask by default
    saved = c.store.put("operations", op)
    _audit(f"Operation '{saved['key']}' added", body.get("user_id") or user_id, "operation.created", saved)
    _changed()
    return shape(Operation, saved)


@router.put("/operations/{id}")
async def update_operation(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    current = found(c.store.get("operations", id), "Operation", id)
    op = _checked({**current, **editable(Operation, body), "updated_at": now_iso()})
    if op["key"] != current.get("key"):
        users = operation_users(current.get("key") or "")
        if users:
            raise Conflict(f"The key '{current.get('key')}' is used by {', '.join(users[:5])} — "
                           f"update them before renaming it.")
    saved = c.store.put("operations", op)
    _audit(f"Operation '{saved['key']}' updated", body.get("user_id") or user_id, "operation.updated", saved)
    _changed()
    return shape(Operation, saved)


@router.delete("/operations/{id}")
async def delete_operation(id: str, user_id: str = "") -> dict[str, Any]:
    op = found(c.store.get("operations", id), "Operation", id)
    users = operation_users(op.get("key") or "")
    if users:
        raise Conflict(f"Operation '{op.get('key')}' is used by {', '.join(users[:5])}"
                       f"{' and more' if len(users) > 5 else ''} — remove those references first.")
    c.store.delete("operations", id)
    _audit(f"Operation '{op.get('key') or id}' deleted", user_id, "operation.deleted", op)
    _changed()
    return {"ok": True, "id": id}


@router.post("/operations/suggest")
async def suggest_operation(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """An unsaved draft: the LLM picks a real tool of the connector and the argument template."""
    return await ai_utils.suggest_operation(c, str(body.get("connector_id") or ""), str(body.get("intent") or ""))


@router.post("/operations/{id}/run")
async def run_operation(id: str, body: dict[str, Any] | None = Body(default=None), user_id: str = "") -> dict[str, Any]:
    """Run from Studio › Operations with `input` (default: the operation's test input). A
    human pressed Run, so it executes with full autonomy; `prepare_only: true` returns the
    arguments that would be sent without calling anything (dry run)."""
    body = body or {}
    op = found(c.store.get("operations", id), "Operation", id)
    run_input = body.get("input")
    if run_input is None:
        run_input = op.get("test_input") or {}
    if not isinstance(run_input, dict):
        raise FactoryError("The operation input must be a JSON object.", 422)
    prepare_only = bool(body.get("prepare_only"))
    trace: list[dict[str, Any]] = []

    def sink(*args: Any, **kwargs: Any) -> None:
        """Collects trace entries however the executor reports them: a TraceEntry dict, or
        StepCtx.trace-style (text, kind=…, agent=…, data=…)."""
        if args and isinstance(args[0], dict):
            trace.append({"ts": now_iso(), **args[0]})
        else:
            text = args[0] if args else kwargs.get("text", "")
            trace.append({"ts": now_iso(), "kind": kwargs.get("kind", args[1] if len(args) > 1 else "info"),
                          "agent": kwargs.get("agent", ""), "text": str(text), "data": kwargs.get("data")})

    result = await c.ops.run(op, run_input, prepare_only=prepare_only, autonomy="full", trace=sink)
    out = result.model_dump() if isinstance(result, OperationResult) else OperationResult.model_validate(result).model_dump()
    if not out["trace"] and trace:
        out["trace"] = OperationResult.model_validate({"trace": trace}).model_dump()["trace"]
    if not prepare_only:
        c.record_event("operation.executed",
                       f"Operation '{op.get('key')}' run from the Studio: "
                       f"{'OK' if out['ok'] else 'failed — ' + truncate(out['error'], 200)}",
                       actor=actor(body.get("user_id") or user_id),
                       data={"source": "studio", "operation_key": op.get("key"), "tool": out.get("tool"),
                             "ok": out["ok"], "latency_ms": out.get("latency_ms", 0)})
    return out
