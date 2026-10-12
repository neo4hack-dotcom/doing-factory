"""Blueprints (workflow templates): GET|POST /blueprints, GET|PUT|DELETE /blueprints/{id},
POST /blueprints/{id}/duplicate, POST /blueprints/validate, POST /blueprints/generate (SPEC §3.4, §9).

Every save is a new revision: `version` rides on the store's per-document counter, and a
project snapshots the version it started from, so editing a blueprint never rewrites a
running project. An `active` blueprint must validate (projects start from it); a `draft` may
be saved incomplete — the designer shows its errors. Deleting is refused while projects,
watchers or other blueprints use it (archive it instead), and for builtin blueprints, which
the app re-creates at startup. Saves are audited as `blueprint.saved` and emit
`reference.updated`.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from app import ai_utils
from app.api import actor, editable, found, shape, shape_all, validate
from app.deps import container as c
from app.errors import Conflict, FactoryError
from app.models import Blueprint
from app.util import new_id, now_iso, slugify, validation_message

router = APIRouter(prefix="/api")

# Fields the client never sets on a stored blueprint.
_SERVER_OWNED = {"builtin", "version"}


def _changed() -> None:
    c.bus.emit("reference.updated", collection="blueprints")


def _saved(bp: dict[str, Any], acting: str, action: str) -> None:
    c.record_event("blueprint.saved", f"Blueprint '{bp.get('name')}' {action} (v{bp.get('version')})",
                   actor=actor(acting),
                   data={"blueprint_id": bp.get("id"), "key": bp.get("key"), "version": bp.get("version"),
                         "action": action, "status": bp.get("status")})


def _unique_key(base: str, own_id: str) -> str:
    taken = {b.get("key") for b in c.store.list("blueprints") if b.get("id") != own_id}
    key, n = base, 2
    while key in taken:
        key, n = f"{base}_{n}", n + 1
    return key


def fan_out_users(key: str, own_id: str = "") -> list[str]:
    """Blueprints whose fan_out steps start projects from blueprint `key`."""
    out = []
    for bp in c.store.list("blueprints"):
        if bp.get("id") == own_id:
            continue
        for stage in bp.get("stages") or []:
            for step in stage.get("steps") or []:
                if step.get("type") == "fan_out" and (step.get("config") or {}).get("blueprint_key") == key:
                    out.append(f"'{bp.get('name')}' › {step.get('name') or step.get('id')}")
    return out


def _report(doc: dict[str, Any]) -> dict[str, Any]:
    return ai_utils.validation_report(c, doc)


def _checked(data: dict[str, Any]) -> dict[str, Any]:
    bp = validate(Blueprint, data, "blueprint").model_dump()
    bp["name"] = bp["name"].strip()
    if not bp["name"]:
        raise FactoryError("A blueprint needs a name.", 422)
    key = slugify(bp["key"] or bp["name"])
    if not key:
        raise FactoryError("A blueprint needs a key (snake_case) or a name to derive it from.", 422)
    clash = next((b for b in c.store.list("blueprints") if b.get("id") != bp["id"] and b.get("key") == key), None)
    if clash is not None:
        raise Conflict(f"The key '{key}' is already used by the blueprint '{clash.get('name')}'.")
    bp["key"] = key
    bp["key_prefix"] = "".join(ch for ch in bp["key_prefix"].upper() if ch.isalnum())[:8] or "PRJ"
    if bp["status"] == "active":
        report = _report(bp)
        if report["errors"]:
            raise FactoryError("An active blueprint must be valid — save it as a draft, or fix: "
                               + "; ".join(report["errors"][:6]), 422)
    return bp


@router.get("/blueprints")
async def list_blueprints() -> list[dict[str, Any]]:
    return shape_all(Blueprint, c.store.list("blueprints"))


@router.get("/blueprints/{id}")
async def get_blueprint(id: str) -> dict[str, Any]:
    return shape(Blueprint, found(c.get_blueprint(id), "Blueprint", id))


@router.post("/blueprints/validate")
async def validate_blueprint(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """{ok, errors, warnings} for a blueprint as edited in the designer (saved or not)."""
    doc = {k: v for k, v in body.items() if k != "user_id"}
    try:
        normalised = Blueprint.model_validate(doc).model_dump()
    except Exception as exc:  # pydantic ValidationError: the shape itself is wrong
        message = validation_message(exc) if hasattr(exc, "errors") else str(exc)
        return {"ok": False, "errors": [f"Invalid blueprint structure — {message}"], "warnings": []}
    return _report(normalised)


@router.post("/blueprints/generate")
async def generate_blueprint(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """An unsaved draft from a description, with its validation report under `validation`."""
    return await ai_utils.generate_blueprint(c, str(body.get("description") or ""))


@router.post("/blueprints")
async def create_blueprint(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    stamp = now_iso()
    fields = {k: v for k, v in editable(Blueprint, body).items() if k not in _SERVER_OWNED}
    bp = _checked({**fields, "id": new_id("bp"), "builtin": False, "created_at": stamp, "updated_at": stamp})
    saved = c.store.put("blueprints", bp)   # version 1
    _saved(saved, body.get("user_id") or user_id, "created")
    _changed()
    return shape(Blueprint, saved)


@router.put("/blueprints/{id}")
async def update_blueprint(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    current = found(c.get_blueprint(id), "Blueprint", id)
    fields = {k: v for k, v in editable(Blueprint, body).items() if k not in _SERVER_OWNED}
    bp = _checked({**current, **fields, "updated_at": now_iso()})
    if bp["key"] != current.get("key"):
        users = fan_out_users(current.get("key") or "", id)
        if users:
            raise Conflict(f"The key '{current.get('key')}' is used by the fan-out step(s) {', '.join(users[:5])} — "
                           f"update them before renaming it.")
    saved = c.store.put("blueprints", bp)   # the store bumps `version`: a new revision
    _saved(saved, body.get("user_id") or user_id, "updated")
    _changed()
    return shape(Blueprint, saved)


@router.delete("/blueprints/{id}")
async def delete_blueprint(id: str, user_id: str = "") -> dict[str, Any]:
    bp = found(c.get_blueprint(id), "Blueprint", id)
    archive = "set its status to Archived instead: it stops being offered for new projects and history stays intact."
    if bp.get("builtin"):
        raise Conflict(f"'{bp.get('name')}' is a builtin blueprint: it would be re-created at the next start — {archive}")
    projects = [p.get("key") or p["id"] for p in c.store.list("projects") if p.get("blueprint_id") == id]
    if projects:
        raise Conflict(f"{len(projects)} project(s) use '{bp.get('name')}' ({', '.join(projects[:5])}"
                       f"{'…' if len(projects) > 5 else ''}) — {archive}")
    watchers = [w.get("name") for w in c.store.list("watchers") if w.get("blueprint_id") == id]
    if watchers:
        raise Conflict(f"The watcher(s) {', '.join(watchers)} start projects from '{bp.get('name')}' — point them at "
                       f"another blueprint first.")
    users = fan_out_users(bp.get("key") or "", id)
    if users:
        raise Conflict(f"The fan-out step(s) {', '.join(users[:5])} start projects from '{bp.get('name')}' — "
                       f"update them first.")
    c.store.delete("blueprints", id)
    c.record_event("settings.updated", f"Blueprint '{bp.get('name')}' deleted", actor=actor(user_id),
                   data={"section": "blueprints", "action": "blueprint.deleted", "blueprint_id": id,
                         "key": bp.get("key")})
    _changed()
    return {"ok": True, "id": id}


@router.post("/blueprints/{id}/duplicate")
async def duplicate_blueprint(id: str, body: dict[str, Any] | None = Body(default=None),
                              user_id: str = "") -> dict[str, Any]:
    """A copy to customise: new id and key, "(copy)" name, not builtin, saved as a draft."""
    source = found(c.get_blueprint(id), "Blueprint", id)
    stamp = now_iso()
    copy = {**shape(Blueprint, source), "id": new_id("bp"), "key": _unique_key(f"{source.get('key') or 'blueprint'}_copy", ""),
            "name": f"{source.get('name') or 'Blueprint'} (copy)", "builtin": False, "status": "draft",
            "created_at": stamp, "updated_at": stamp}
    saved = c.store.put("blueprints", copy)
    _saved(saved, (body or {}).get("user_id") or user_id, f"duplicated from '{source.get('name')}'")
    _changed()
    return shape(Blueprint, saved)
