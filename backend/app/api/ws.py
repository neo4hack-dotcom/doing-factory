"""WebSocket /api/ws: the live feed of the event bus (SPEC §8).

Server → browser only. Incoming frames are read and ignored — reading is what notices a
closed socket, so a client that leaves while the bus is quiet is unsubscribed at once
instead of lingering until the next event fails to send.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import VERSION
from app.deps import container as c
from app.util import now_iso

log = logging.getLogger("factory.ws")
router = APIRouter(prefix="/api")


@router.websocket("/ws")
async def websocket_feed(ws: WebSocket) -> None:
    await ws.accept()
    queue = c.bus.subscribe()

    async def send(message: dict[str, Any]) -> None:
        # default=str: one odd value in a payload must not cut the whole live feed.
        await ws.send_text(json.dumps(message, ensure_ascii=False, default=str))

    async def forward() -> None:
        await send({"type": "hello", "version": VERSION, "ts": now_iso()})
        while True:
            await send(await queue.get())

    async def drain() -> None:
        while (await ws.receive())["type"] != "websocket.disconnect":
            pass

    tasks = [asyncio.create_task(forward()), asyncio.create_task(drain())]
    try:
        # Whichever ends first (socket closed, send failed) ends the connection.
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, WebSocketDisconnect):
                pass
            except Exception as exc:   # a socket that died mid-send: expected, but say so
                log.info("WebSocket closed: %s: %s", type(exc).__name__, exc)
        c.bus.unsubscribe(queue)
        with contextlib.suppress(RuntimeError):
            await ws.close()
