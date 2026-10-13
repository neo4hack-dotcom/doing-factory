"""Admin: GET /admin/export, POST /admin/import, GET /admin/llm-calls?days= (SPEC §9).

A backup import replaces the collections it contains wholesale; afterwards every live MCP connection
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
from app.util import to_iso

log = logging.getLogger("factory.api.admin")
router = APIRouter(prefix="/api")

REFERENCE_COLLECTIONS = ("users", "teams", "roles", "connectors", "operations", "blueprints", "watchers")


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
