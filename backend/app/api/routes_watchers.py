"""Watchers: GET|POST /watchers, PUT|DELETE /watchers/{id}, POST /watchers/{id}/run|reset (SPEC §3.6, §9).

A watcher polls an Operation on a schedule and turns new items into intake items (or
auto-started projects). Its `state` (seen keys, counters, last run) belongs to the
WatcherService: clients never write it, and Reset is the one way to clear the seen keys so
the next run detects everything again. Mutations are audited as `settings.updated` (section
watchers) and emit `reference.updated`; reset also pushes `watcher.updated`.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from app.api import actor, editable, found, shape, shape_all, validate
from app.deps import container as c
from app.errors import FactoryError
from app.models import Watcher, WatcherState
from app.util import new_id, now_iso

router = APIRouter(prefix="/api")

_SERVER_OWNED = {"state"}


def _changed() -> None:
    c.bus.emit("reference.updated", collection="watchers")


def _audit(message: str, acting: str, action: str, watcher: dict[str, Any]) -> None:
    c.record_event("settings.updated", message, actor=actor(acting),
                   data={"section": "watchers", "action": action, "watcher_id": watcher.get("id"),
                         "name": watcher.get("name")})


def _checked(data: dict[str, Any]) -> dict[str, Any]:
    w = validate(Watcher, data, "watcher").model_dump()
    w["name"] = w["name"].strip()
    if not w["name"]:
        raise FactoryError("A watcher needs a name.", 422)
    if not w["operation_key"]:
        raise FactoryError("Pick the operation the watcher polls (Studio › Operations).", 422)
    if c.get_operation_by_key(w["operation_key"]) is None:
        raise FactoryError(f"No operation with the key '{w['operation_key']}' — create it in Studio › Operations.", 422)
    if w["blueprint_id"] and c.get_blueprint(w["blueprint_id"]) is None:
        raise FactoryError(f"Blueprint {w['blueprint_id']} not found.", 422)
    if w["action"] == "auto_start" and not w["blueprint_id"]:
        raise FactoryError("An auto-start watcher needs the blueprint its projects start from.", 422)
    schedule = w["schedule"]
    if not 1 <= schedule["every_minutes"] <= 7 * 24 * 60:
        raise FactoryError("The polling interval must be between 1 minute and 7 days.", 422)
    for bound in ("active_hours_start", "active_hours_end"):
        if schedule[bound] is not None and not 0 <= schedule[bound] <= 24:
            raise FactoryError("Active hours must be between 0 and 24.", 422)
    if any(d not in range(1, 8) for d in schedule["days"]):
        raise FactoryError("Days are ISO weekdays: 1 (Monday) to 7 (Sunday).", 422)
    w["items_expr"] = w["items_expr"].strip() or "result"
    w["key_field"] = w["key_field"].strip() or "id"
    w["title_field"] = w["title_field"].strip() or "title"
    return w


@router.get("/watchers")
async def list_watchers() -> list[dict[str, Any]]:
    return shape_all(Watcher, c.store.list("watchers"))


@router.get("/watchers/{id}")
async def get_watcher(id: str) -> dict[str, Any]:
    return shape(Watcher, found(c.store.get("watchers", id), "Watcher", id))


@router.post("/watchers")
async def create_watcher(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    stamp = now_iso()
    fields = {k: v for k, v in editable(Watcher, body).items() if k not in _SERVER_OWNED}
    watcher = _checked({**fields, "id": new_id("wat"), "state": WatcherState().model_dump(),
                        "created_at": stamp, "updated_at": stamp})
    saved = c.store.put("watchers", watcher)
    _audit(f"Watcher '{saved['name']}' added", body.get("user_id") or user_id, "watcher.created", saved)
    _changed()
    return shape(Watcher, saved)


@router.put("/watchers/{id}")
async def update_watcher(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    current = found(c.store.get("watchers", id), "Watcher", id)
    fields = {k: v for k, v in editable(Watcher, body).items() if k not in _SERVER_OWNED}
    watcher = _checked({**current, **fields, "updated_at": now_iso()})
    if watcher["schedule"] != (current.get("schedule") or watcher["schedule"]) or watcher["enabled"] != current.get("enabled", True):
        watcher["state"]["next_run_at"] = None   # the new schedule decides the next run
    saved = c.store.put("watchers", watcher)
    _audit(f"Watcher '{saved['name']}' updated", body.get("user_id") or user_id, "watcher.updated", saved)
    _changed()
    return shape(Watcher, saved)


@router.delete("/watchers/{id}")
async def delete_watcher(id: str, user_id: str = "") -> dict[str, Any]:
    """Intake items it detected stay (they carry the watcher's name)."""
    watcher = found(c.store.get("watchers", id), "Watcher", id)
    c.store.delete("watchers", id)
    _audit(f"Watcher '{watcher.get('name') or id}' deleted", user_id, "watcher.deleted", watcher)
    _changed()
    return {"ok": True, "id": id}


@router.post("/watchers/{id}/run")
async def run_watcher(id: str) -> dict[str, Any]:
    """Run now, whatever the schedule → {ok, total, new, error, items_preview}."""
    found(c.store.get("watchers", id), "Watcher", id)
    result = await c.watchers.run(id)
    return {"ok": bool(result.get("ok")), "total": int(result.get("total") or 0), "new": int(result.get("new") or 0),
            "error": result.get("error") or "", "items_preview": list(result.get("items_preview") or [])}


@router.post("/watchers/{id}/reset")
async def reset_watcher(id: str, body: dict[str, Any] | None = Body(default=None), user_id: str = "") -> dict[str, Any]:
    """Forget the seen keys: the next run treats every item as new (run history is kept)."""
    watcher = found(c.store.get("watchers", id), "Watcher", id)
    state = {**WatcherState().model_dump(), **(watcher.get("state") or {})}
    state.update(seen_keys=[], last_new=0, next_run_at=None)
    saved = c.store.put("watchers", {**watcher, "state": state, "updated_at": now_iso()})
    out = shape(Watcher, saved)
    _audit(f"Watcher '{saved.get('name')}' reset: its next run detects every item again",
           (body or {}).get("user_id") or user_id, "watcher.reset", saved)
    c.bus.emit("watcher.updated", watcher=out)
    _changed()
    return out
