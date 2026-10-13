"""Connectors (MCP servers): GET|POST /connectors, GET|PUT|DELETE /connectors/{id},
POST /connectors/{id}/test, POST /connectors/{id}/call, GET /connectors/templates,
POST /connectors/from-template, POST /connectors/{id}/standard-setup (SPEC §7, §9).

Secrets never leave the server: env/header values under secret-looking keys and credentials
embedded in URLs are masked on every read (util.public_connector), and a masked value sent
back on update keeps the stored secret, so opening a connector and saving it is harmless.
`status` and `tools` belong to the server — only a test (or a live connection) writes them.
Every mutation drops the live connection (the next call reconnects with the new launch
settings), is audited as `settings.updated` (Connectors is a Settings tab) and emits
`reference.updated` so open UIs reload their bootstrap.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from app.api import actor, editable, found, shape, validate
from app.deps import container as c
from app.errors import Conflict, FactoryError
from app.mcp.templates import connector_from_template, connector_templates
from app.models import Connector
from app.seed.standard_ops import standard_setup as run_standard_setup
from app.util import MASK, is_masked, new_id, now_iso, public_connector, slugify, truncate, unmask_mapping

router = APIRouter(prefix="/api")

_SERVER_OWNED = {"status", "tools"}


def _out(doc: dict[str, Any]) -> dict[str, Any]:
    return public_connector(shape(Connector, doc))


def _changed(collection: str = "connectors") -> None:
    c.bus.emit("reference.updated", collection=collection)


def _audit(message: str, acting: str, action: str, connector: dict[str, Any]) -> None:
    c.record_event("settings.updated", message, actor=actor(acting),
                   data={"section": "connectors", "action": action, "connector_id": connector.get("id"),
                         "name": connector.get("name")})


def _slug(wanted: str, own_id: str) -> str:
    """The tool namespace (`<slug>__<tool>`): stable once set — renaming a connector must not
    break the qualified tool names that agent steps already list — unique among connectors."""
    base = slugify(wanted) or "connector"
    taken = {d.get("slug") for d in c.store.list("connectors") if d.get("id") != own_id}
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base}_{n}", n + 1
    return slug


def _keep_masked_url(incoming: str, stored: str) -> str:
    """A URL still showing the mask (credentials hidden on read) keeps the stored one."""
    return stored if MASK in (incoming or "") and public_connector({"url": stored})["url"] == incoming else incoming


def _checked(data: dict[str, Any]) -> dict[str, Any]:
    doc = validate(Connector, data, "connector").model_dump()
    doc["name"] = doc["name"].strip()
    if not doc["name"]:
        raise FactoryError("A connector needs a name.", 422)
    clash = next((d for d in c.store.list("connectors") if d["id"] != doc["id"]
                  and (d.get("name") or "").strip().lower() == doc["name"].lower()), None)
    if clash is not None:
        raise Conflict(f"A connector named '{doc['name']}' already exists.")
    if doc["transport"] == "stdio":
        doc["command"] = doc["command"].strip()
        if not doc["command"]:
            raise FactoryError("A stdio connector needs the command that starts the MCP server "
                               "(e.g. python, npx, uvx).", 422)
    else:
        doc["url"] = doc["url"].strip()
        if not doc["url"].startswith(("http://", "https://")):
            raise FactoryError("An HTTP or SSE connector needs a URL starting with http:// or https://.", 422)
    if any(is_masked(v) for v in [*doc["env"].values(), *doc["headers"].values()]):
        raise FactoryError("A secret value is still masked (••••) — type the real value.", 422)
    doc["timeout_s"] = max(1, min(int(doc["timeout_s"] or 60), 3600))
    doc["slug"] = _slug(doc["slug"] or doc["name"], doc["id"])
    return doc


@router.get("/connectors")
async def list_connectors() -> list[dict[str, Any]]:
    return [_out(doc) for doc in c.store.list("connectors")]


@router.get("/connectors/templates")
async def list_templates() -> list[dict[str, Any]]:
    """The real MCP servers the Factory is built for, with the fields to fill (SPEC §7)."""
    return connector_templates()


@router.post("/connectors/from-template")
async def create_from_template(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    """{template_id, name?, values: {field: value}, kind?} → the saved connector, already tested
    (its status says whether the server answered and why not), secrets masked."""
    fields = connector_from_template(str(body.get("template_id") or ""), body.get("values") or {},
                                     name=str(body.get("name") or ""), kind=str(body.get("kind") or ""))
    if not str(body.get("name") or "").strip():   # default name: made unique rather than refused
        taken = {(d.get("name") or "").strip().lower() for d in c.store.list("connectors")}
        base, n = fields["name"], 2
        while fields["name"].lower() in taken:
            fields["name"], n = f"{base} {n}", n + 1
    stamp = now_iso()
    doc = _checked({**fields, "id": new_id("con"), "created_at": stamp, "updated_at": stamp})
    saved = c.store.put("connectors", doc)
    _audit(f"Connector '{saved['name']}' added from the {body.get('template_id')} template",
           body.get("user_id") or user_id, "connector.created", saved)
    saved = await c.mcp.test(saved["id"])   # a failure is recorded in its status, never raised
    _changed()
    return _out(saved)


@router.post("/connectors/{id}/standard-setup")
async def standard_setup(id: str, user_id: str = "") -> dict[str, Any]:
    """Creates the operations the builtin blueprints call (and, for DOINg.AI, the new-use-case
    watcher), bound to this connector; never overwrites what exists →
    {operations_created, operations_existing, watcher_created, notes}."""
    found(c.store.get("connectors", id), "Connector", id)
    result = run_standard_setup(c, id)
    if result["operations_created"]:
        _changed("operations")
    if result["watcher_created"]:
        _changed("watchers")
    return result


@router.get("/connectors/{id}")
async def get_connector(id: str) -> dict[str, Any]:
    return _out(found(c.store.get("connectors", id), "Connector", id))


@router.post("/connectors")
async def create_connector(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    fields = {k: v for k, v in editable(Connector, body).items() if k not in _SERVER_OWNED}
    stamp = now_iso()
    doc = _checked({**fields, "id": new_id("con"), "created_at": stamp, "updated_at": stamp})
    saved = c.store.put("connectors", doc)
    _audit(f"Connector '{saved['name']}' added", body.get("user_id") or user_id, "connector.created", saved)
    _changed()
    return _out(saved)


@router.put("/connectors/{id}")
async def update_connector(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    current = found(c.store.get("connectors", id), "Connector", id)
    fields = {k: v for k, v in editable(Connector, body).items() if k not in _SERVER_OWNED}
    # Masked values come back from the edit form: they mean "keep the stored secret".
    if "env" in fields:
        fields["env"] = unmask_mapping(fields["env"], current.get("env"))
    if "headers" in fields:
        fields["headers"] = unmask_mapping(fields["headers"], current.get("headers"))
    if "url" in fields:
        fields["url"] = _keep_masked_url(fields["url"], current.get("url") or "")
    if "args" in fields and isinstance(fields["args"], list):
        stored_args = current.get("args") or []
        fields["args"] = [_keep_masked_url(a, stored_args[i]) if i < len(stored_args) and isinstance(a, str) else a
                          for i, a in enumerate(fields["args"])]
    doc = _checked({**current, **fields, "updated_at": now_iso()})
    saved = c.store.put("connectors", doc)
    await c.mcp.disconnect(id)
    _audit(f"Connector '{saved['name']}' updated", body.get("user_id") or user_id, "connector.updated", saved)
    _changed()
    return _out(saved)


@router.delete("/connectors/{id}")
async def delete_connector(id: str, user_id: str = "") -> dict[str, Any]:
    """Refused while operations use the connector: they would fail at run time, mid-workflow."""
    connector = found(c.store.get("connectors", id), "Connector", id)
    users = [op.get("key") or op["id"] for op in c.store.list("operations") if op.get("connector_id") == id]
    if users:
        raise Conflict(f"Connector '{connector.get('name')}' is used by {len(users)} operation(s): "
                       f"{', '.join(users[:6])}{'…' if len(users) > 6 else ''} — delete or re-point them in "
                       f"Studio › Operations first.")
    await c.mcp.disconnect(id)
    c.store.delete("connectors", id)
    _audit(f"Connector '{connector.get('name') or id}' deleted", user_id, "connector.deleted", connector)
    _changed()
    return {"ok": True, "id": id}


@router.post("/connectors/{id}/test")
async def test_connector(id: str, user_id: str = "") -> dict[str, Any]:
    """Reconnect, list the tools, persist status + tools (the manager records `connector.tested`)."""
    found(c.store.get("connectors", id), "Connector", id)
    saved = await c.mcp.test(id)
    _changed()
    return _out(saved)


@router.post("/connectors/{id}/call")
async def call_tool(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    """The tool bench: one raw tool call. A tool failure is an answer ({ok: false, error}),
    not an HTTP error. Audited without the arguments, which may carry personal data."""
    connector = found(c.store.get("connectors", id), "Connector", id)
    tool = str(body.get("tool") or "").strip()
    if not tool:
        raise FactoryError("Name the tool to call.", 422)
    args = body.get("args") if body.get("args") is not None else {}
    if not isinstance(args, dict):
        raise FactoryError("Tool arguments must be a JSON object.", 422)
    result = await c.mcp.call_tool(id, tool, args)
    acting = body.get("user_id") or user_id
    c.record_event("operation.executed",
                   f"Tool '{tool}' called on '{connector.get('name')}' from the tool bench: "
                   f"{'OK' if result.get('ok') else 'failed — ' + truncate(result.get('error'), 200)}",
                   actor=actor(acting),
                   data={"source": "tool_bench", "connector_id": id, "tool": tool, "ok": bool(result.get("ok")),
                         "latency_ms": result.get("latency_ms", 0)})
    out = {"ok": bool(result.get("ok")), "data": result.get("data"), "content_text": result.get("text") or "",
           "is_error": bool(result.get("is_error")), "latency_ms": int(result.get("latency_ms") or 0),
           "error": result.get("error") or ""}
    if result.get("truncated"):
        out["truncated"] = True
    return out
