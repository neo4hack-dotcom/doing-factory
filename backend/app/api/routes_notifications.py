"""Notifications: GET /notifications?user_id=&unread=, POST /notifications/read (SPEC §9)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from app.api import shape_all
from app.deps import container as c
from app.errors import FactoryError
from app.models import Notification

router = APIRouter(prefix="/api")


@router.get("/notifications")
async def list_notifications(user_id: str = "", unread: bool = False, limit: int = 100) -> list[dict[str, Any]]:
    if not user_id:
        return []
    return shape_all(Notification, c.notifier.list(user_id, unread_only=unread, limit=max(1, min(limit, 500))))


@router.post("/notifications/read")
async def mark_read(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    """Mark `ids` (or `all`) of the acting user's notifications as read."""
    uid = str(body.get("user_id") or user_id or "").strip()
    if not uid:
        raise FactoryError("Choose who you are acting as — this action needs a user_id.", 422)
    ids = body.get("ids")
    if ids is not None and (not isinstance(ids, list) or not all(isinstance(i, str) for i in ids)):
        raise FactoryError("ids must be a list of notification ids.", 422)
    every = bool(body.get("all"))
    if not every and not ids:
        return {"ok": True, "updated": 0}
    updated = c.notifier.mark_read(uid, ids=None if every else ids, all=every)
    return {"ok": True, "updated": int(updated or 0)}
