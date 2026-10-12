"""Inbox: GET /inbox?user_id=, GET /inbox/counts?user_id= (SPEC §9).

The inbox is derived, never stored (app.inbox): the pending actions of one person across
every project plus the intake queue, sorted overdue first, then priority, due date and age.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app import inbox as inbox_mod
from app.api import shape, shape_all
from app.deps import container as c
from app.models import InboxCounts, InboxItem

router = APIRouter(prefix="/api")


@router.get("/inbox")
async def inbox(user_id: str = "") -> list[dict[str, Any]]:
    """Nobody's inbox is empty: without a persona there is nothing to show (not an error)."""
    if not user_id:
        return []
    return shape_all(InboxItem, inbox_mod.inbox_for(c, user_id))


@router.get("/inbox/counts")
async def inbox_counts(user_id: str = "") -> dict[str, Any]:
    if not user_id:
        return InboxCounts().model_dump()
    return shape(InboxCounts, inbox_mod.inbox_counts(c, user_id))
