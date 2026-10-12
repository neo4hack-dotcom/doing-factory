"""In-process pub/sub feeding the WebSocket (`/api/ws`) — docs/SPEC.md §8.

Live-only by design: the durable record is the `events` table (store.add_event); this bus
just pushes `{"type", "ts", ...payload}` to whoever is connected right now. A slow browser
must never slow the engine down, so `emit` never blocks: a full subscriber queue drops its
*oldest* message (the newest state is the one worth showing) and the drop is counted.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.util import now_iso

log = logging.getLogger("factory.events")

QUEUE_SIZE = 500


class EventBus:
    def __init__(self) -> None:
        # Each queue remembers the loop it was created on: asyncio queues are not
        # thread-safe, and emit() may be called from a worker thread (asyncio.to_thread).
        self._subs: dict[asyncio.Queue, asyncio.AbstractEventLoop] = {}
        self.dropped = 0

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._subs[queue] = asyncio.get_running_loop()
        return queue

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.pop(q, None)

    def emit(self, type: str, **payload: Any) -> None:
        event = {"type": type, "ts": now_iso(), **payload}
        try:
            current = asyncio.get_running_loop()
        except RuntimeError:
            current = None
        for queue, loop in list(self._subs.items()):
            if loop is current:
                self._put(queue, event)
            elif not loop.is_closed():
                loop.call_soon_threadsafe(self._put, queue, event)

    def _put(self, queue: asyncio.Queue, event: dict[str, Any]) -> None:
        while True:
            try:
                queue.put_nowait(event)
                return
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                self.dropped += 1
                if self.dropped in (1, 100) or self.dropped % 1000 == 0:
                    log.warning("Event bus: a slow WebSocket client is dropping events (%d so far)", self.dropped)
