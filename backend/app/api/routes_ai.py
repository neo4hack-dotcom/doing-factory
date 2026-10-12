"""AI utilities: POST /ai/rewrite, GET /briefing?user_id=, POST /copilot, GET /copilot/{chat_id} (SPEC §9).

All of them need the LLM except the briefing, which falls back to a deterministic summary
(`ai: false`) so Home renders without a model. The others answer 424 "No LLM configured —
open Settings › AI Model" when none is set, and 502 with the provider's reason when it fails.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from app import ai_utils, copilot
from app.api import found, shape
from app.deps import container as c
from app.errors import FactoryError
from app.models import Chat

router = APIRouter(prefix="/api")


@router.post("/ai/rewrite")
async def rewrite(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    text = body.get("text")
    if not isinstance(text, str):
        raise FactoryError("Send the text to rewrite.", 422)
    style = str(body.get("style") or "professional")
    return {"text": await ai_utils.rewrite(c, text, style, str(body.get("instructions") or ""))}


@router.get("/briefing")
async def briefing(user_id: str = "", refresh: bool = False) -> dict[str, Any]:
    """Cached 10 minutes per user; `refresh=true` writes a fresh one."""
    return await ai_utils.briefing(c, user_id, refresh=refresh)


@router.post("/copilot")
async def ask_copilot(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    """→ {chat_id, messages}. A new conversation may carry a client-chosen `chat_id`
    (`chat_` + 6-32 letters/digits) so the UI can follow `copilot.progress` from the start."""
    chat = await copilot.chat(c, str(body.get("user_id") or user_id or ""), str(body.get("message") or ""),
                              chat_id=str(body.get("chat_id") or "") or None,
                              project_id=str(body.get("project_id") or ""))
    return {"chat_id": chat["id"], "messages": chat["messages"]}


@router.get("/copilot/{chat_id}")
async def get_chat(chat_id: str) -> dict[str, Any]:
    return shape(Chat, found(c.store.get("chats", chat_id), "Conversation", chat_id))
