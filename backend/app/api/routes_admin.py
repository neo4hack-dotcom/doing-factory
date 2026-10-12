"""Admin: POST /admin/demo/install, POST /admin/demo/simulate-use-case, GET /admin/export,
POST /admin/import, GET /admin/llm-calls?days= (SPEC §9, §13).

The sandbox demo is installed only on this explicit request, and its connectors are tested
right away so the person who clicked sees them come up (or why they did not). A backup
import replaces the collections it contains wholesale; afterwards every live MCP connection
is dropped and the LLM client rebuilt, because both may describe a different setup now.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Body

from app import ai_utils
from app.api import actor
from app.deps import container as c
from app.errors import FactoryError
from app.seed.demo import install_demo
from app.util import to_iso

log = logging.getLogger("factory.api.admin")
router = APIRouter(prefix="/api")

REFERENCE_COLLECTIONS = ("users", "teams", "roles", "connectors", "operations", "blueprints", "watchers")


@router.post("/admin/demo/install")
async def demo_install(user_id: str = "") -> dict[str, Any]:
    """Idempotent → {created: {users, teams, connectors, operations, watchers}, connectors: [test results]}.
    Tests every sandbox connector that was just created or has never answered a test."""
    result = install_demo(c)
    created = result.get("created") or {}
    sandbox = [d for d in c.store.list("connectors")
               if d.get("sandbox") and d.get("enabled", True) and (d.get("status") or {}).get("ok") is not True]
    tested = await asyncio.gather(*(c.mcp.test(d["id"]) for d in sandbox), return_exceptions=True)
    report = []
    for doc, outcome in zip(sandbox, tested):
        if isinstance(outcome, BaseException):
            report.append({"id": doc["id"], "name": doc.get("name"), "ok": False, "tool_count": 0,
                           "error": str(getattr(outcome, "message", outcome))})
        else:
            status = outcome.get("status") or {}
            report.append({"id": doc["id"], "name": outcome.get("name"), "ok": bool(status.get("ok")),
                           "tool_count": int(status.get("tool_count") or 0), "error": status.get("error") or ""})
    for collection in ("users", "teams", "connectors", "operations", "watchers"):
        if created.get(collection) or (collection == "connectors" and report):
            c.bus.emit("reference.updated", collection=collection)
    return {"created": created, "connectors": report}


@router.post("/admin/demo/simulate-use-case")
async def simulate_use_case(body: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    """The LLM invents a realistic use case and creates it in the sandbox DOINg.AI → {use_case, warnings}."""
    return await ai_utils.simulate_use_case(c, str((body or {}).get("hint") or ""))


@router.get("/admin/export")
async def export_backup(user_id: str = "") -> dict[str, Any]:
    """Everything as one JSON document (secrets included — it is a restore point, keep it safe)."""
    backup = await asyncio.to_thread(c.store.export_all)
    c.record_event("settings.updated", "Full backup exported", actor=actor(user_id),
                   data={"section": "backup", "action": "backup.exported",
                         "collections": sorted(backup.get("docs") or {})})
    return backup


@router.post("/admin/import")
async def import_backup(body: Any = Body(...), user_id: str = "") -> dict[str, Any]:
    if not isinstance(body, dict):
        raise FactoryError("A backup is a JSON object exported by DOINg.AI Factory (Settings › Backup).", 422)
    try:
        counts = await asyncio.to_thread(c.store.import_all, body)
    except ValueError as exc:
        raise FactoryError(f"This backup cannot be imported: {exc}", 422) from exc
    await c.mcp.close_all()
    c.rebuild_llm()
    ai_utils.clear_briefing_cache()
    c.record_event("settings.updated", "Backup imported: " + ", ".join(f"{n} {k}" for k, n in sorted(counts.items())),
                   actor=actor(user_id), data={"section": "backup", "action": "backup.imported", "counts": counts})
    c.bus.emit("settings.updated")
    for collection in REFERENCE_COLLECTIONS:
        c.bus.emit("reference.updated", collection=collection)
    return {"ok": True, "imported": counts}


@router.get("/admin/llm-calls")
async def llm_calls(days: int = 7, limit: int = 1000) -> list[dict[str, Any]]:
    """Newest first, over the last `days` days."""
    since = to_iso(datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 365))))
    calls = c.store.list_llm_calls(since=since)
    return list(reversed(calls))[: max(1, min(limit, 5000))]
