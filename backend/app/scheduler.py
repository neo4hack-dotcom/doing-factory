"""Scheduler: the Factory's background loop (SPEC §1, §5, §12).

Every `settings.scheduler.tick_s` seconds (when enabled in Settings), one tick dispatches:
- watchers that are due — next_run_at is pushed one interval ahead *before* the run, and a
  watcher never runs twice at once;
- wait_for polls — steps `waiting_external` whose next_poll_at has passed;
- SLA checks — open steps past their due date not flagged yet (every sla_check_minutes);
- risk refresh — every in-flight project, every RISK_EVERY;
- intake enrichment — AI triage of new items without a suggestion, one at a time, only
  when an LLM is configured (a failed analysis is not retried automatically: its error is
  on the item and the "Analyze" button retries it);
- daily digest — when enabled in Settings › Notifications, once per business day from the
  start of business hours (app/digest.py; the sent days are kept in the store).

A tick never waits for the work it dispatches: each job is a background task, so a slow
MCP server or a long LLM call delays nothing else. Jobs are isolated — an exception is
logged and audited (`scheduler.error`, at most once an hour per job and message) and the
loop carries on. `running` is the truth: the loop task is alive and the scheduler enabled.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from app import digest
from app.errors import FactoryError
from app.util import parse_iso, to_iso, truncate

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

log = logging.getLogger("factory.scheduler")

IN_FLIGHT = frozenset({"active", "waiting", "blocked"})
SLA_OPEN = frozenset({"running", "waiting_human", "waiting_approval", "waiting_children", "waiting_external"})
MIN_TICK_S = 5
RISK_EVERY = timedelta(minutes=10)
MIN_POLL_GAP = timedelta(seconds=60)   # floor between two polls of one step, whatever next_poll_at says
POLL_CONCURRENCY = 3
REPORT_EVERY = timedelta(hours=1)      # same job + same error → one audit event per hour


class Scheduler:
    def __init__(self, container: "Container") -> None:
        self.c = container
        self.last_tick_at: str | None = None
        self._task: asyncio.Task | None = None
        self._enabled = True
        self._jobs: dict[str, asyncio.Task] = {}          # job key → in-flight task
        self._last_sla: datetime | None = None
        self._last_risk: datetime | None = None
        self._last_poll: dict[str, datetime] = {}
        self._reported: dict[tuple[str, str], datetime] = {}
        self._poll_slots: tuple[asyncio.AbstractEventLoop, asyncio.Semaphore] | None = None

    # ------------------------------------------------------------------ lifecycle
    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done() and self._enabled

    def start(self) -> None:
        """Start the loop on the running event loop (no-op when FACTORY_BACKGROUND_JOBS is off
        or the loop is already running)."""
        if not self.c.settings.background_jobs:
            log.info("Background jobs are off (FACTORY_BACKGROUND_JOBS=false) — scheduler not started")
            return
        if self._task is not None and not self._task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            log.error("Scheduler.start() needs a running event loop — scheduler not started")
            return
        self._enabled = True
        self._task = loop.create_task(self._loop(), name="factory-scheduler")

    async def stop(self) -> None:
        """Cancel the loop and every job it dispatched, and wait for them to unwind."""
        tasks = [t for t in (self._task, *self._jobs.values()) if t is not None and not t.done()]
        self._task = None
        self._jobs.clear()
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _loop(self) -> None:
        try:
            cleared = self.c.watchers.reset_stale_busy()
            if cleared:
                log.info("Cleared %d stale intake analysis flag(s) left by a previous run", cleared)
        except Exception as exc:  # noqa: BLE001
            self._report("startup", exc)
        while True:
            interval = 20
            try:
                cfg = self.c.app_settings().scheduler
                self._enabled = bool(cfg.enabled)
                interval = max(MIN_TICK_S, int(cfg.tick_s or 20))
                if self._enabled:
                    await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — the loop must outlive any bug in one tick
                self._report("tick", exc)
            await asyncio.sleep(interval)

    # ------------------------------------------------------------------ one tick
    async def tick(self, now: datetime | None = None, *, wait: bool = False) -> list[asyncio.Task]:
        """Dispatch whatever is due at `now`. Returns the tasks started; `wait=True` awaits
        them (tests, and anyone who wants a synchronous "run the scheduler once")."""
        now = _aware(now or datetime.now(timezone.utc))
        self.last_tick_at = to_iso(now)
        started: list[asyncio.Task] = []
        for job, dispatch in (("watchers", self._dispatch_watchers), ("wait_for", self._dispatch_polls),
                              ("sla", self._dispatch_sla), ("risk", self._dispatch_risk),
                              ("intake", self._dispatch_enrichment), ("digest", self._dispatch_digest)):
            try:
                started.extend(dispatch(now))
            except Exception as exc:  # noqa: BLE001
                self._report(job, exc)
        if wait and started:
            await asyncio.gather(*started, return_exceptions=True)
        return started

    def _dispatch_watchers(self, now: datetime) -> list[asyncio.Task]:
        started = []
        for watcher in self.c.watchers.due(now):
            wid = watcher["id"]
            key = f"watcher:{wid}"
            if self._busy(key) or self.c.watchers.is_running(wid):
                continue
            self.c.watchers.schedule_next(wid, now)   # before the run: a crash cannot hot-loop it
            task = self._spawn(key, "watchers", lambda wid=wid: self.c.watchers.run(wid, actor="scheduler"))
            if task is not None:
                started.append(task)
        return started

    def _dispatch_polls(self, now: datetime) -> list[asyncio.Task]:
        started = []
        for project in self._in_flight():
            for step in _steps(project):
                if step.get("status") != "waiting_external" or step.get("type") != "wait_for":
                    continue
                next_poll = parse_iso(step.get("next_poll_at"))
                if next_poll is not None and next_poll > now:
                    continue
                key = f"poll:{project['id']}:{step.get('id')}"
                last = self._last_poll.get(key)
                if self._busy(key) or (last is not None and now - last < MIN_POLL_GAP):
                    continue
                self._last_poll[key] = now
                pid, sid = project["id"], step.get("id") or ""
                task = self._spawn(key, "wait_for", lambda pid=pid, sid=sid: self._poll(pid, sid))
                if task is not None:
                    started.append(task)
        if len(self._last_poll) > 2000:   # forget polls of steps long finished
            horizon = now - timedelta(days=1)
            self._last_poll = {k: t for k, t in self._last_poll.items() if t >= horizon}
        return started

    async def _poll(self, pid: str, sid: str) -> None:
        loop = asyncio.get_running_loop()
        if self._poll_slots is None or self._poll_slots[0] is not loop:   # a semaphore is bound to one loop
            self._poll_slots = (loop, asyncio.Semaphore(POLL_CONCURRENCY))
        async with self._poll_slots[1]:
            await self.c.engine.poll_wait_step(pid, sid)

    def _dispatch_sla(self, now: datetime) -> list[asyncio.Task]:
        every = timedelta(minutes=max(1, int(self.c.app_settings().scheduler.sla_check_minutes or 15)))
        if self._last_sla is not None and now - self._last_sla < every:
            return []
        task = self._spawn("sla", "sla", lambda: self._check_sla(now))
        if task is not None:
            self._last_sla = now
        return [task] if task else []

    async def _check_sla(self, now: datetime) -> None:
        for project in self._in_flight():
            for step in _steps(project):
                due = parse_iso(step.get("due_at"))
                if step.get("status") in SLA_OPEN and due is not None and due < now and not step.get("sla_breached"):
                    try:
                        await self.c.engine.flag_sla(project["id"], step.get("id") or "")
                    except Exception as exc:  # noqa: BLE001 — one project must not stop the others
                        self._report("sla", exc)

    def _dispatch_risk(self, now: datetime) -> list[asyncio.Task]:
        if self._last_risk is not None and now - self._last_risk < RISK_EVERY:
            return []
        task = self._spawn("risk", "risk", self._refresh_risk)
        if task is not None:
            self._last_risk = now
        return [task] if task else []

    async def _refresh_risk(self) -> None:
        for project in self._in_flight():
            try:
                await self.c.engine.refresh_risk(project["id"])
            except Exception as exc:  # noqa: BLE001
                self._report("risk", exc)

    def _dispatch_enrichment(self, now: datetime) -> list[asyncio.Task]:
        if self._busy("intake") or not self.c.ai.configured:
            return []
        candidates = [i for i in self.c.store.list("intake")
                      if i.get("status") == "new" and not i.get("suggestion") and not i.get("ai_error")
                      and not self.c.watchers.is_analyzing(i.get("id") or "")]
        if not candidates:
            return []
        target = min(candidates, key=lambda i: i.get("detected_at") or "")["id"]
        task = self._spawn("intake", "intake", lambda: self._enrich(target))
        return [task] if task else []

    async def _enrich(self, intake_id: str) -> None:
        try:
            await self.c.watchers.analyze_intake(intake_id)
        except FactoryError as exc:   # stored on the item as ai_error: visible where it matters
            log.info("Intake %s: AI triage failed — %s", intake_id, exc.message)

    def _dispatch_digest(self, now: datetime) -> list[asyncio.Task]:
        if digest.due_day(self.c, now) is None:   # cheap: settings + clock, no store scan
            return []
        task = self._spawn("digest", "digest", lambda: digest.send_due_digests(self.c, now))
        return [task] if task else []

    # ------------------------------------------------------------------ plumbing
    def _in_flight(self) -> list[dict]:
        return [p for p in self.c.store.list("projects") if p.get("status") in IN_FLIGHT and p.get("id")]

    def _busy(self, key: str) -> bool:
        task = self._jobs.get(key)
        return task is not None and not task.done()

    def _spawn(self, key: str, job: str, factory: Callable[[], Awaitable[Any]]) -> asyncio.Task | None:
        """Start `factory()` as a background task registered under `key` (None when a task
        with that key is still running). The coroutine is created inside the task, so a
        skipped job never leaves an un-awaited coroutine behind."""
        if self._busy(key):
            return None

        async def guarded() -> None:
            try:
                await factory()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self._report(job, exc)

        task = asyncio.get_running_loop().create_task(guarded(), name=f"scheduler:{key}")
        self._jobs[key] = task
        task.add_done_callback(lambda t, k=key: self._jobs.pop(k, None) if self._jobs.get(k) is t else None)
        return task

    def _report(self, job: str, exc: BaseException) -> None:
        message = exc.message if isinstance(exc, FactoryError) else f"{type(exc).__name__}: {exc}"
        if isinstance(exc, FactoryError):
            log.warning("Scheduler job '%s' failed: %s", job, message)
        else:
            log.error("Scheduler job '%s' failed", job, exc_info=exc)
        now = datetime.now(timezone.utc)
        signature = (job, truncate(message, 200))
        last = self._reported.get(signature)
        if last is not None and now - last < REPORT_EVERY:
            return
        self._reported[signature] = now
        if len(self._reported) > 500:
            self._reported = {k: t for k, t in self._reported.items() if now - t < REPORT_EVERY}
        try:
            self.c.record_event("scheduler.error", truncate(f"Background job '{job}' failed: {message}", 600),
                                actor="scheduler", data={"job": job, "error": truncate(message, 1000)})
        except Exception:  # noqa: BLE001 — auditing must not take the loop down
            log.exception("Could not record a scheduler error")


def _steps(project: dict) -> list[dict]:
    return [step for stage in project.get("stages") or [] for step in stage.get("steps") or []]


def _aware(now: datetime) -> datetime:
    return now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now.astimezone(timezone.utc)
