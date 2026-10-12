"""Activity & KPIs: GET /events, GET /events/verify, GET /kpis?days= (SPEC §8, §9, §10).

The activity feed is the hash-chained audit trail (store.events); /events/verify walks the
chain and names the first event that no longer follows from its predecessor.
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter

from app import kpis as kpis_mod
from app.api import shape, shape_all
from app.deps import container as c
from app.models import Event, Kpis

router = APIRouter(prefix="/api")


@router.get("/events")
async def list_events(limit: int = 200, kind: str = "", project_id: str = "", before: str = "") -> list[dict[str, Any]]:
    """Newest first. `kind` takes one kind, a comma-separated list, or a prefix ending in "."
    ("step." = every step event). `before` is an event id or an ISO timestamp (paging)."""
    kinds = [k.strip() for k in kind.split(",") if k.strip()] or None
    events = c.store.list_events(project_id=project_id or None, kinds=kinds, limit=max(1, min(limit, 1000)),
                                 before=before or None)
    return shape_all(Event, events)


@router.get("/events/verify")
async def verify_events() -> dict[str, Any]:
    return await asyncio.to_thread(c.store.verify_events)


@router.get("/kpis")
async def kpis(days: int = 30) -> dict[str, Any]:
    """Computed off the event loop: a large portfolio must not stall live updates."""
    result = await asyncio.to_thread(kpis_mod.compute_kpis, c, max(1, min(days, 365)))
    return shape(Kpis, result)
