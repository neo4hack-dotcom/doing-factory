"""Intake: GET /intake?status=, POST /intake/{id}/accept|dismiss|analyze (SPEC §9).

Intake items are what watchers detected (e.g. a new DOINg.AI use case) waiting for a human
to turn them into a project or dismiss them. Decisions go through the WatcherService, which
records `intake.accepted` / `intake.dismissed` and pushes `intake.updated`.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from app.api import found, shape, shape_all
from app.api.routes_projects import project_out
from app.deps import container as c
from app.errors import FactoryError
from app.models import IntakeItem

router = APIRouter(prefix="/api")

STATUSES = ("new", "accepted", "dismissed")
OVERRIDES = ("blueprint_id", "title", "priority", "sponsor_id", "team_id", "owner_id")


def _acting(body: dict[str, Any] | None, user_id: str) -> str:
    uid = str((body or {}).get("user_id") or user_id or "").strip()
    if not uid:
        raise FactoryError("Choose who you are acting as — this action needs a user_id.", 422)
    return uid


@router.get("/intake")
async def list_intake(status: str = "") -> list[dict[str, Any]]:
    if status and status not in STATUSES:
        raise FactoryError(f"Unknown intake status '{status}'. Use one of: {', '.join(STATUSES)}.", 422)
    items = [i for i in c.store.list("intake") if not status or i.get("status") == status]
    items.sort(key=lambda i: i.get("detected_at") or "", reverse=True)
    return shape_all(IntakeItem, items)


@router.post("/intake/{id}/accept")
async def accept(id: str, body: dict[str, Any] | None = Body(default=None), user_id: str = "") -> dict[str, Any]:
    """Start a project from the item (→ Project); the body may override the AI suggestion."""
    item = found(c.store.get("intake", id), "Intake item", id)
    if item.get("status") != "new":
        raise FactoryError(f"'{item.get('title')}' was already {item.get('status')}.", 409)
    overrides = {k: (body or {})[k] for k in OVERRIDES if (body or {}).get(k)}
    project = await c.watchers.accept_intake(id, _acting(body, user_id), overrides)
    return project_out(project)


@router.post("/intake/{id}/dismiss")
async def dismiss(id: str, body: dict[str, Any] | None = Body(default=None), user_id: str = "") -> dict[str, Any]:
    item = found(c.store.get("intake", id), "Intake item", id)
    if item.get("status") != "new":
        raise FactoryError(f"'{item.get('title')}' was already {item.get('status')}.", 409)
    reason = str((body or {}).get("reason") or "").strip()
    return shape(IntakeItem, await c.watchers.dismiss_intake(id, _acting(body, user_id), reason))


@router.post("/intake/{id}/analyze")
async def analyze(id: str) -> dict[str, Any]:
    """(Re-)run the AI triage: suggested blueprint, priority, team, sponsor, capabilities.
    → the IntakeItem. An AI failure (no LLM configured, model error) is not an HTTP error:
    it is recorded on the item as `ai_error` and the item is returned (200), so the card
    shows why there is no suggestion. 404 unknown id, 409 not new / already analysing."""
    found(c.store.get("intake", id), "Intake item", id)
    return shape(IntakeItem, await c.watchers.analyze_intake(id, raise_on_failure=False))
