"""WorkflowEngine: creates projects from blueprints and drives their steps (SPEC §5, §5b, §12, §14).

The engine is the only writer of project state. Every mutation follows one pattern:

1. take the project's asyncio.Lock, load the document, mutate it in memory through a small
   transaction object (`_Tx`) that also collects the side effects to run afterwards;
2. let `_progress` move the workflow forward as far as it can without waiting (skip `when`-false
   steps, activate the next steps, close stages, complete the project);
3. commit: recompute the risk, `store.put`, push `project.updated` on the bus;
4. outside the lock, dispatch what was collected: background step executions, AI helpers,
   notifications, kicks of other projects.

Nothing slow ever runs under a lock. Automated steps (LLM, MCP, agents) execute in tracked
background tasks against a snapshot; their StepOutcome is applied later under the lock, and
only if the step is still the run that produced it (a step reset, skipped or cancelled
meanwhile simply discards a stale outcome). A failed automated run is retried with the
critic's advice up to `engine.max_retries`, unless the failure is not retryable or the
LoopGuard sees the same error repeating; then the step fails and the project is blocked.

Human actions (`decide`, `complete_step`, `confirm`, …) check `can_act` (SPEC §12 permission
model), mutate under the lock, advance, and return the updated project.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from pydantic import ValidationError

from app.engine import executors_ai, executors_flow
from app.engine.blueprint import (instantiate_stages, project_role_users, resolve_assignees, role_holders,
                                  validate_blueprint)
from app.engine.context import StepCtx, StepOutcome, fail
from app.engine.guard import LoopGuard
from app.engine.templating import condition
from app.errors import (Conflict, EngineError, FactoryError, Forbidden, LLMNotConfigured, NotConfigured, NotFound,
                        TemplateError)
from app.models import (ApprovalConfig, Artifact, Estimate, EstimationConfig, Link, Project, ProjectSource,
                        QualityGateConfig, WaitForConfig)
from app.risk import compute_risk
from app.util import iso_add, new_id, now_iso, parse_iso, truncate, validation_message

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

log = logging.getLogger("factory.engine")

TRACE_CAP = 300
TRACE_TEXT_MAX = 4000
HISTORY_CAP = 10
FLUSH_DELAY_S = 1.5          # live trace entries of a background run are persisted in batches

FINISHED = frozenset({"done", "skipped"})
OPEN = frozenset({"running", "waiting_human", "waiting_approval", "waiting_children", "waiting_external"})
WAITING = frozenset({"waiting_human", "waiting_approval", "waiting_children", "waiting_external"})
CLOSED_PROJECT = frozenset({"done", "cancelled"})
TERMINAL_PROJECT = frozenset({"done", "cancelled", "failed"})
HUMAN_TYPES = frozenset(executors_flow.HUMAN_TYPES)

# Automated step types → (module, executor name). Looked up at call time so tests can patch.
_EXECUTORS: dict[str, tuple[Any, str]] = {
    "ai_task": (executors_ai, "exec_ai_task"),
    "mcp_operation": (executors_ai, "exec_mcp_operation"),
    "agent_task": (executors_ai, "exec_agent_task"),
    "quality_gate": (executors_ai, "exec_quality_gate"),
    "notify": (executors_flow, "exec_notify"),
    "fan_out": (executors_flow, "exec_fan_out"),
}
# A side-effect-free run can simply be repeated after a restart; the others may have written.
_RERUNNABLE = frozenset({"ai_task", "quality_gate"})
_ASSIST_HOURS = {"human_form": "human_form_ai_draft", "estimation": "estimation_ai", "approval": "approval_brief"}
_PATCHABLE = ("title", "description", "priority", "sponsor_id", "owner_id", "team_id", "tags", "due_date",
              "stakeholder_ids", "ai_summary")
_SYSTEM_ACTORS = ("ai", "system", "scheduler")
_INTERRUPTED = "Interrupted by a server restart — press Retry"


@dataclass
class _Tx:
    """One locked mutation of one project: the document plus what to do once it is saved."""
    project: dict[str, Any]
    runs: list[tuple[str, str, dict]] = field(default_factory=list)       # (step id, mode, kwargs)
    assists: list[tuple[str, str, str]] = field(default_factory=list)     # (step id, instructions, user)
    after: list[Callable[[], Awaitable[Any]]] = field(default_factory=list)
    kicks: set[str] = field(default_factory=set)


def _jsonable(value: Any) -> Any:
    if value is None:
        return None
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return str(value)


def _norm_error(text: str) -> str:
    """An error message without its numbers/ids: the LoopGuard compares *kinds* of failure."""
    return re.sub(r"[0-9a-f]{6,}|\d+", "#", (text or "").lower())[:120]


class WorkflowEngine:
    def __init__(self, container: "Container") -> None:
        self.c = container
        self._locks: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Lock]] = {}
        self._kicks: dict[str, asyncio.Task] = {}
        self._again: set[str] = set()
        self._tasks: set[asyncio.Task] = set()
        self._live: set[tuple[str, str]] = set()                 # (pid, sid) with a background run
        self._buffers: dict[tuple[str, str], list[dict]] = {}    # trace entries not persisted yet
        self._flushing: set[tuple[str, str]] = set()
        self.flush_delay_s = FLUSH_DELAY_S

    # =====================================================================================
    # Plumbing: locks, tasks, persistence
    # =====================================================================================

    def _lock(self, pid: str) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        entry = self._locks.get(pid)
        if entry is None or entry[0] is not loop:   # a lock is bound to one event loop
            entry = (loop, asyncio.Lock())
            self._locks[pid] = entry
        return entry[1]

    def _spawn(self, coro: Awaitable[Any], label: str) -> asyncio.Task:
        task = asyncio.get_running_loop().create_task(coro)   # type: ignore[arg-type]
        self._tasks.add(task)

        def done(t: asyncio.Task) -> None:
            self._tasks.discard(t)
            if not t.cancelled() and t.exception() is not None:
                log.error("Background job %s failed", label, exc_info=t.exception())
        task.add_done_callback(done)
        return task

    async def wait_idle(self, timeout: float = 30.0) -> None:
        """Wait until no background run, AI helper, notification or kick is in flight (tests,
        scripts and a graceful shutdown)."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            pending = [t for t in [*self._tasks, *self._kicks.values()]
                       if not t.done() and t.get_loop() is loop]
            if not pending:
                return
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TimeoutError(f"{len(pending)} engine job(s) still running")
            await asyncio.wait(pending, timeout=remaining)

    def _load(self, pid: str) -> dict:
        project = self.c.store.get("projects", pid)
        if project is None:
            raise NotFound(f"Project {pid} not found")
        return project

    def _find(self, project: dict, sid: str) -> tuple[dict, dict]:
        for stage in project.get("stages") or []:
            for step in stage.get("steps") or []:
                if step.get("id") == sid:
                    return stage, step
        raise NotFound(f"Step '{sid}' not found in {project.get('key') or project.get('id')}")

    @staticmethod
    def _steps(project: dict) -> list[tuple[dict, dict]]:
        return [(stage, step) for stage in project.get("stages") or [] for step in stage.get("steps") or []]

    def _commit(self, tx: _Tx) -> dict:
        project = tx.project
        now = datetime.now(timezone.utc)
        try:
            children = [c for c in (self.c.store.get("projects", cid) for cid in project.get("child_ids") or []) if c]
            project["risk"] = compute_risk(project, now, children)
        except Exception:  # noqa: BLE001 — a risk bug must never block a workflow transition
            log.exception("Risk computation failed for %s", project.get("id"))
        stored = self.c.store.put("projects", project)
        tx.project = stored
        self.c.bus.emit("project.updated", project_id=stored["id"], summary=self.summary(stored))
        return stored

    def _dispatch(self, tx: _Tx) -> None:
        pid = tx.project.get("id") or ""
        for sid, mode, kwargs in tx.runs:
            self._live.add((pid, sid))
            self._spawn(self._run(pid, sid, mode, **kwargs), f"{mode} {pid}/{sid}")
        for sid, instructions, user_id in tx.assists:
            self._spawn(self._assist(pid, sid, instructions, user_id), f"assist {pid}/{sid}")
        for effect in tx.after:
            self._spawn(self._safe(effect), f"effect {pid}")
        for other in tx.kicks:
            if other:
                self.kick(other)

    @staticmethod
    async def _safe(effect: Callable[[], Awaitable[Any]]) -> None:
        try:
            await effect()
        except Exception:  # noqa: BLE001 — a failed notification must not undo a transition
            log.exception("Engine side effect failed")

    async def _mutate(self, pid: str, fn: Callable[[_Tx], Any], *, progress: bool = True) -> dict:
        """Load → fn(tx) → progress → commit → dispatch. Returns the saved project."""
        async with self._lock(pid):
            tx = _Tx(self._load(pid))
            fn(tx)
            if progress:
                self._progress(tx)
            stored = self._commit(tx)
        self._dispatch(tx)
        return stored

    # =====================================================================================
    # Trace
    # =====================================================================================

    def _entry(self, text: str, kind: str = "info", agent: str = "", data: Any = None) -> dict:
        kind = kind if kind in ("info", "thought", "tool", "result", "error", "human", "ai") else "info"
        return {"ts": now_iso(), "kind": kind, "agent": agent or "", "text": truncate(str(text or ""), TRACE_TEXT_MAX),
                "data": _jsonable(data)}

    def _trace(self, project: dict, step: dict, text: str, kind: str = "info", agent: str = "",
               data: Any = None) -> dict:
        entry = self._entry(text, kind, agent, data)
        trace = step.setdefault("trace", [])
        trace.append(entry)
        if len(trace) > TRACE_CAP:
            del trace[: len(trace) - TRACE_CAP]
        self.c.bus.emit("step.trace", project_id=project.get("id") or "", step_id=step.get("id") or "", entry=entry)
        return entry

    def _buffered_sink(self, pid: str, sid: str) -> Callable[[dict], None]:
        """Trace sink for background runs: live on the bus now, persisted in small batches."""
        key = (pid, sid)

        def sink(raw: dict) -> None:
            entry = self._entry(raw.get("text", ""), raw.get("kind", "info"), raw.get("agent", ""), raw.get("data"))
            self.c.bus.emit("step.trace", project_id=pid, step_id=sid, entry=entry)
            self._buffers.setdefault(key, []).append(entry)
            if key not in self._flushing:
                self._flushing.add(key)
                try:
                    self._spawn(self._flush_later(pid, sid), f"trace {pid}/{sid}")
                except RuntimeError:   # no running loop: the entries are flushed with the outcome
                    self._flushing.discard(key)
        return sink

    def _take_buffer(self, project: dict, step: dict) -> None:
        entries = self._buffers.pop((project.get("id") or "", step.get("id") or ""), [])
        if entries:
            trace = step.setdefault("trace", [])
            trace.extend(entries)
            if len(trace) > TRACE_CAP:
                del trace[: len(trace) - TRACE_CAP]

    async def _flush_later(self, pid: str, sid: str) -> None:
        try:
            await asyncio.sleep(self.flush_delay_s)
            async with self._lock(pid):
                project = self.c.store.get("projects", pid)
                if project is None:
                    self._buffers.pop((pid, sid), None)
                    return
                try:
                    _, step = self._find(project, sid)
                except NotFound:
                    self._buffers.pop((pid, sid), None)
                    return
                if self._buffers.get((pid, sid)):
                    self._take_buffer(project, step)
                    self.c.store.put("projects", project)
        finally:
            self._flushing.discard((pid, sid))

    def _sync_sink(self, project: dict, step: dict) -> Callable[[dict], None]:
        def sink(raw: dict) -> None:
            self._trace(project, step, raw.get("text", ""), raw.get("kind", "info"), raw.get("agent", ""),
                        raw.get("data"))
        return sink

    # =====================================================================================
    # Context
    # =====================================================================================

    def _person(self, uid: str) -> dict | None:
        user = self.c.get_user(uid) if uid else None
        if user is None:
            return None
        return {"id": user["id"], "name": user.get("name", ""), "email": user.get("email", ""),
                "title": user.get("title", ""), "roles": list(user.get("roles") or [])}

    def build_context(self, project: dict, step: dict | None = None, item: Any = None) -> dict:
        """The Jinja context of a step (SPEC §4)."""
        team = self.c.get_team(project.get("team_id", ""))
        parent = self.c.store.get("projects", project["parent_id"]) if project.get("parent_id") else None
        ctx: dict[str, Any] = {
            "project": {k: project.get(k) for k in ("id", "key", "title", "description", "priority", "status", "tags",
                                                     "due_date", "kind")},
            "inputs": project.get("inputs") or {},
            "vars": project.get("vars") or {},
            "sponsor": self._person(project.get("sponsor_id", "")),
            "owner": self._person(project.get("owner_id", "")),
            "team": None if team is None else {
                "id": team["id"], "name": team.get("name", ""), "description": team.get("description", ""),
                "skills": team.get("skills") or [], "jira_project_key": team.get("jira_project_key", ""),
                "jira_component": team.get("jira_component", ""), "lead_user_id": team.get("lead_user_id", "")},
            "parent": None if parent is None else {k: parent.get(k) for k in ("id", "key", "title", "inputs", "vars")},
            "teams": [{"id": t["id"], "name": t.get("name", ""), "description": t.get("description", ""),
                       "skills": t.get("skills") or [], "jira_project_key": t.get("jira_project_key", ""),
                       "jira_component": t.get("jira_component", "")} for t in self.c.teams()],
            "step": {"id": (step or {}).get("id", ""), "name": (step or {}).get("name", ""),
                     "type": (step or {}).get("type", "")},
            "feedback": (step or {}).get("feedback", "") or "",
            "now": now_iso(),
        }
        if item is not None:
            ctx["item"] = item
        return ctx

    def project_brief(self, project: dict) -> str:
        """Compact facts for LLM prompts: title, description, inputs, latest artifacts."""
        budget = max(1000, int(self.c.app_settings().engine.context_chars or 6000))
        lines = [f"Project {project.get('key', '')} — {project.get('title', '')}",
                 f"Blueprint: {project.get('blueprint_name', '')} · priority {project.get('priority', 'medium')}"]
        if project.get("description"):
            lines.append(f"Description: {truncate(project['description'], 1200)}")
        inputs = {k: v for k, v in (project.get("inputs") or {}).items() if v not in (None, "", [], {})}
        if inputs:
            lines.append("Inputs:")
            for key, value in inputs.items():
                shown = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
                lines.append(f"- {key}: {truncate(shown, 400)}")
        head = "\n".join(lines)
        artifacts = sorted(project.get("artifacts") or [], key=lambda a: a.get("updated_at") or "", reverse=True)
        parts = [head]
        left = budget - len(head)
        for art in artifacts:
            if left < 300:
                break
            text = f"### {art.get('title', 'Document')}\n{truncate(art.get('content') or '', left - 40)}"
            parts.append(text)
            left -= len(text) + 2
        return truncate("\n\n".join(parts), budget)

    def autonomy(self, project: dict) -> str:
        blueprint = self.c.get_blueprint(project.get("blueprint_id", "")) or {}
        return project.get("autonomy") or blueprint.get("autonomy") or self.c.app_settings().engine.autonomy

    def _ctx(self, project: dict, stage: dict, step: dict, *, user_id: str = "",
             sink: Callable[[dict], None] | None = None, snapshot: bool = True) -> StepCtx:
        if snapshot:
            project = copy.deepcopy(project)
            stage, step = self._find(project, step["id"])
        include = (step.get("config") or {}).get("include_context", True) is not False
        return StepCtx(container=self.c, project=project, stage=stage, step=step,
                       tctx=self.build_context(project, step), brief=self.project_brief(project) if include else "",
                       autonomy=self.autonomy(project), user_id=user_id, on_trace=sink)

    # =====================================================================================
    # Lifecycle
    # =====================================================================================

    async def recover(self) -> None:
        """After a restart: no AI helper is running any more; side-effect-free runs are re-run,
        runs that may have written are failed for a human to decide; then everything in
        flight is advanced again."""
        for project in self.c.store.list("projects"):
            pid = project.get("id")
            if not pid:
                continue
            async with self._lock(pid):
                project = self.c.store.get("projects", pid)
                if project is None:
                    continue
                changed = False
                tx = _Tx(project)
                for _, step in self._steps(project):
                    if step.get("ai_busy"):
                        step["ai_busy"] = False
                        changed = True
                    if step.get("status") != "running" or project.get("status") in TERMINAL_PROJECT:
                        continue
                    changed = True
                    if step.get("type") in _RERUNNABLE:
                        step["status"] = "pending"
                        step["pending_action"] = None
                        self._trace(project, step, "Server restarted during this step — it runs again.", "info")
                    else:
                        self._fail(tx, step, _INTERRUPTED, notify=False)
                if changed:
                    self._derive_status(tx)
                    self._commit(tx)
                in_flight = project.get("status") not in TERMINAL_PROJECT
            if in_flight:
                self.kick(pid)

    def kick(self, project_id: str) -> None:
        """Schedule advance(project_id) in the background. Coalesced: while one advance is
        queued or running, further kicks only ask it to go round once more."""
        if not project_id:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            log.debug("kick(%s) without a running loop — ignored", project_id)
            return
        task = self._kicks.get(project_id)
        if task is not None and not task.done() and task.get_loop() is loop:
            self._again.add(project_id)
            return
        self._kicks[project_id] = loop.create_task(self._kick_loop(project_id))

    async def _kick_loop(self, pid: str) -> None:
        try:
            while True:
                self._again.discard(pid)
                try:
                    await self.advance(pid)
                except NotFound:
                    return
                except Exception as exc:  # noqa: BLE001 — logged where people look: the project
                    log.exception("Advancing %s failed", pid)
                    await self._record_crash(pid, "", exc)
                    return
                if pid not in self._again:
                    return
        finally:
            if self._kicks.get(pid) is asyncio.current_task():
                self._kicks.pop(pid, None)

    async def advance(self, project_id: str) -> None:
        async with self._lock(project_id):
            project = self.c.store.get("projects", project_id)
            if project is None:
                return
            before = json.dumps(project, sort_keys=True, default=str)
            tx = _Tx(project)
            self._progress(tx)
            if json.dumps(tx.project, sort_keys=True, default=str) != before:
                self._commit(tx)
        self._dispatch(tx)

    async def _record_crash(self, pid: str, sid: str, exc: BaseException) -> None:
        """An engine bug surfaced in the step (or current stage's open step) trace and as a
        failure, never lost in a log only."""
        message = f"Internal engine error: {type(exc).__name__}: {exc}"
        try:
            async with self._lock(pid):
                project = self.c.store.get("projects", pid)
                if project is None:
                    return
                tx = _Tx(project)
                target = None
                if sid:
                    target = self._find(project, sid)[1]
                else:
                    target = next((s for _, s in self._steps(project) if s.get("status") in OPEN | {"pending"}), None)
                if target is None:
                    return
                if target.get("status") == "running":
                    self._fail(tx, target, message)
                    self._derive_status(tx)
                else:
                    self._trace(project, target, message, "error")
                self._commit(tx)
            self._dispatch(tx)
        except Exception:  # noqa: BLE001
            log.exception("Could not record the engine error on %s", pid)

    # =====================================================================================
    # Projects
    # =====================================================================================

    async def create_project(self, blueprint_id: str, *, title: str, description: str = "",
                             inputs: dict | None = None, priority: str = "medium", sponsor_id: str = "",
                             owner_id: str = "", team_id: str = "", tags: list[str] | None = None,
                             due_date: str | None = None, source: dict | None = None, parent_id: str = "",
                             parent_step_id: str = "", created_by: str = "") -> dict:
        blueprint = self.c.get_blueprint(blueprint_id) or self.c.get_blueprint_by_key(blueprint_id)
        if blueprint is None:
            raise NotFound(f"Blueprint {blueprint_id or '(none)'} not found")
        report = validate_blueprint(self.c, blueprint)
        if not report["ok"]:
            raise EngineError(f"The blueprint '{blueprint.get('name')}' has errors — fix them in Studio › Blueprints: "
                              + "; ".join(report["errors"][:3]))
        title = (title or "").strip()
        if not title:
            raise EngineError("A project needs a title.")
        source = dict(source or {"type": "manual"})
        manual = (source.get("type") or "manual") == "manual"
        for label, uid in (("sponsor", sponsor_id), ("owner", owner_id)):
            if uid and self.c.get_user(uid) is None:
                raise EngineError(f"Unknown {label} {uid} — pick an existing user.")
        if team_id and self.c.get_team(team_id) is None:
            raise EngineError(f"Unknown team {team_id} — pick an existing team.")

        raw_inputs = dict(inputs or {})
        typed, problems = executors_flow.collect_values(self.c, blueprint.get("inputs") or [], raw_inputs,
                                                        require=manual, keep_extra=True)
        if problems and manual:
            raise EngineError("Please fix the project inputs: " + "; ".join(problems))
        for raw_field in blueprint.get("inputs") or []:   # automated sources: keep what we could not type
            key = raw_field.get("key")
            if key in raw_inputs and key not in typed:
                typed[key] = raw_inputs[key]

        prefix = (blueprint.get("key_prefix") or "PRJ").strip().upper() or "PRJ"
        now = now_iso()
        try:
            doc = Project.model_validate({
                "id": new_id("prj"), "key": f"{prefix}-{self.c.store.next_seq(f'project:{prefix}'):04d}",
                "title": title, "description": description or "", "blueprint_id": blueprint["id"],
                "blueprint_name": blueprint.get("name", ""), "blueprint_version": blueprint.get("version") or 1,
                "kind": blueprint.get("kind") or "custom", "status": "active", "priority": priority or "medium",
                "sponsor_id": sponsor_id or "", "owner_id": owner_id or "", "team_id": team_id or "",
                "tags": list(tags or []), "due_date": due_date or None, "inputs": typed, "vars": {},
                "source": ProjectSource.model_validate(source).model_dump(), "parent_id": parent_id or "",
                "parent_step_id": parent_step_id or "", "stages": instantiate_stages(blueprint),
                "autonomy": blueprint.get("autonomy") or "", "created_by": created_by or "",
                "created_at": now, "updated_at": now, "started_at": now,
            }).model_dump()
        except ValidationError as exc:
            raise EngineError(f"Invalid project — {validation_message(exc)}") from exc

        pid = doc["id"]
        async with self._lock(pid):
            tx = _Tx(doc)
            self._commit(tx)
            self.c.record_event("project.created", f"{doc['key']} created from {blueprint.get('name')}: {title}",
                                actor=created_by or "system", project_id=pid,
                                data={"blueprint_id": blueprint["id"], "source": doc["source"].get("type"),
                                      "parent_id": parent_id or ""})
        if parent_id:
            async with self._lock(parent_id):
                parent = self.c.store.get("projects", parent_id)
                if parent is not None and pid not in (parent.get("child_ids") or []):
                    parent.setdefault("child_ids", []).append(pid)
                    self._commit(_Tx(parent))
        await self.advance(pid)
        return self.get(pid)

    def get(self, project_id: str) -> dict:
        return self._load(project_id)

    def summary(self, project: dict) -> dict:
        steps = [step for _, step in self._steps(project)]
        finished = sum(1 for s in steps if s.get("status") in FINISHED)
        progress = finished / len(steps) if steps else (1.0 if project.get("status") == "done" else 0.0)
        current = next((st for st in project.get("stages") or [] if st.get("id") == project.get("current_stage_id")),
                       None)
        open_steps = [s for s in steps if s.get("status") in OPEN or s.get("status") in ("failed", "rejected")]
        child_ids = project.get("child_ids") or []
        children_done = 0
        for cid in child_ids:
            child = self.c.store.get("projects", cid)
            children_done += 1 if child is not None and child.get("status") == "done" else 0
        return {
            "id": project.get("id", ""), "key": project.get("key", ""), "title": project.get("title", ""),
            "kind": project.get("kind", ""), "blueprint_id": project.get("blueprint_id", ""),
            "blueprint_name": project.get("blueprint_name", ""), "status": project.get("status", "active"),
            "priority": project.get("priority", "medium"), "sponsor_id": project.get("sponsor_id", ""),
            "owner_id": project.get("owner_id", ""), "team_id": project.get("team_id", ""),
            "current_stage_id": project.get("current_stage_id", ""),
            "current_stage_name": (current or {}).get("name", ""), "progress": round(progress, 4),
            "open_step_names": [s.get("name") or s.get("id", "") for s in open_steps],
            "open_step_statuses": [s.get("status") for s in open_steps],
            "risk": project.get("risk") or {}, "parent_id": project.get("parent_id", ""),
            "child_count": len(child_ids), "children_done": children_done, "due_date": project.get("due_date"),
            "created_at": project.get("created_at", ""), "updated_at": project.get("updated_at", ""),
            "completed_at": project.get("completed_at"), "tags": project.get("tags") or [],
        }

    def list_summaries(self, *, status: str | None = None, blueprint_id: str | None = None, q: str | None = None,
                       parent_id: str | None = None, user_id: str | None = None) -> list[dict]:
        wanted = {s.strip() for s in (status or "").split(",") if s.strip()}
        needle = (q or "").strip().lower()
        out = []
        for project in self.c.store.list("projects"):
            if wanted and project.get("status") not in wanted:
                continue
            if blueprint_id and project.get("blueprint_id") != blueprint_id:
                continue
            if parent_id is not None and parent_id != "" and project.get("parent_id") != parent_id:
                continue
            if needle:
                haystack = " ".join([project.get("key", ""), project.get("title", ""), project.get("description", ""),
                                     " ".join(project.get("tags") or [])]).lower()
                if needle not in haystack:
                    continue
            if user_id and not self._involves(project, user_id):
                continue
            out.append(self.summary(project))
        out.sort(key=lambda s: s.get("updated_at") or "", reverse=True)
        return out

    def _involves(self, project: dict, uid: str) -> bool:
        if uid in (project.get("sponsor_id"), project.get("owner_id"), project.get("created_by")):
            return True
        if uid in (project.get("stakeholder_ids") or []):
            return True
        return any(uid in (s.get("assignee_user_ids") or []) for _, s in self._steps(project)
                   if s.get("status") in OPEN or s.get("status") == "failed")

    # =====================================================================================
    # Permissions
    # =====================================================================================

    def _user(self, user_id: str) -> dict:
        if user_id in _SYSTEM_ACTORS:
            return {"id": user_id, "name": user_id, "roles": [], "active": True}
        user = self.c.get_user(user_id)
        if user is None or not user.get("active", True):
            raise Forbidden(f"Unknown or inactive user '{user_id}' — choose who you are acting as.")
        return user

    @staticmethod
    def _is_admin(user: dict | None) -> bool:
        return bool(user) and "admin" in (user.get("roles") or [])

    @staticmethod
    def _holds(project: dict, user: dict, role: str) -> bool:
        """Role `sponsor` means this project's sponsor when one is set (SPEC §12)."""
        if role == "sponsor" and project.get("sponsor_id"):
            return user.get("id") == project["sponsor_id"]
        return role in (user.get("roles") or [])

    def _approval_state(self, step: dict) -> tuple[ApprovalConfig, list[str], list[dict]]:
        """(config, roles still to approve, approvals given)."""
        cfg = ApprovalConfig.model_validate(step.get("config") or {})
        approved = [a for a in step.get("approvals") or [] if a.get("decision") == "approved"]
        roles = [a.role for a in cfg.approvers]
        if cfg.policy == "all":
            done_roles = {a.get("role") for a in approved}
            pending = [r for r in roles if r not in done_roles]
        elif cfg.policy == "any":
            pending = [] if approved else roles
        else:
            pending = [] if len(approved) >= max(1, cfg.quorum) else roles
        return cfg, pending, approved

    @staticmethod
    def _has_assignee(step: dict) -> bool:
        assignee = step.get("assignee") or {}
        return bool(step.get("assignee_user_ids") or assignee.get("user_ids") or assignee.get("roles")
                    or assignee.get("project_role"))

    def can_act(self, project: dict, step: dict, user_id: str) -> bool:
        user = self.c.get_user(user_id) if user_id else None
        if user is None or not user.get("active", True):
            return False
        if self._is_admin(user):
            return True
        roles = set(user.get("roles") or [])
        assignee = step.get("assignee") or {}
        if user_id in (assignee.get("user_ids") or []):
            return True
        if step.get("type") == "approval" and step.get("status") == "waiting_approval":
            _, pending, _ = self._approval_state(step)
            return any(self._holds(project, user, role) for role in pending)
        if user_id in (step.get("assignee_user_ids") or []):
            return True
        if any(self._holds(project, user, role) for role in assignee.get("roles") or []):
            return True
        if assignee.get("project_role") and user_id in project_role_users(self.c, project, assignee["project_role"]):
            return True
        if (step.get("pending_action") or {}).get("kind") == "gate_review":
            if roles & set((step.get("config") or {}).get("override_roles") or []):
                return True
        if not self._has_assignee(step) or step.get("status") == "failed":
            # Unassigned automation (a confirmation, a failure): the project owner answers for it.
            if project.get("owner_id"):
                return user_id == project["owner_id"]
            return "product_manager" in roles
        return False

    def _who(self, project: dict, step: dict) -> str:
        labels = {r.get("key"): r.get("label") or r.get("key") for r in self.c.roles()}
        if step.get("type") == "approval" and step.get("status") == "waiting_approval":
            _, pending, _ = self._approval_state(step)
            names = [labels.get(r, r) for r in pending]
        else:
            assignee = step.get("assignee") or {}
            names = [labels.get(r, r) for r in assignee.get("roles") or []]
            names += [(self.c.get_user(u) or {}).get("name", u) for u in assignee.get("user_ids") or []]
            if (step.get("pending_action") or {}).get("kind") == "gate_review":
                names += [labels.get(r, r) for r in (step.get("config") or {}).get("override_roles") or []
                          if r != "admin"]
            if assignee.get("project_role"):
                names.append(f"the project {assignee['project_role'].replace('_', ' ')}")
            if not names:
                names = ["the project owner"]
        return " or ".join(dict.fromkeys(n for n in names if n)) or "the assignees"

    def _require(self, project: dict, step: dict, user_id: str) -> dict:
        user = self._user(user_id)
        if not self.can_act(project, step, user_id):
            verb = "approve" if step.get("type") == "approval" else "act on"
            raise Forbidden(f"Only {self._who(project, step)} or an admin can {verb} this step "
                            f"('{step.get('name') or step.get('id')}').")
        return user

    def _require_manager(self, project: dict, user_id: str, what: str, *, allow_pm: bool = False) -> dict:
        user = self._user(user_id)
        if self._is_admin(user) or user_id in (project.get("owner_id"), project.get("sponsor_id"),
                                               project.get("created_by")):
            return user
        if allow_pm and "product_manager" in (user.get("roles") or []):
            return user
        raise Forbidden(f"Only the project's owner, sponsor or creator, or an admin, can {what}.")

    # =====================================================================================
    # Progress
    # =====================================================================================

    def _progress(self, tx: _Tx) -> None:
        if tx.project.get("status") in TERMINAL_PROJECT:
            return
        for _ in range(500):   # each round changes something; a blueprint has far fewer steps
            if not self._progress_once(tx):
                break
        self._derive_status(tx)

    def _progress_once(self, tx: _Tx) -> bool:
        project = tx.project
        if project.get("status") in TERMINAL_PROJECT:
            return False
        limit = max(1, int(self.c.app_settings().engine.parallel_steps or 3))
        for stage in project.get("stages") or []:
            if stage.get("status") in ("done", "skipped"):
                continue
            project["current_stage_id"] = stage["id"]
            if stage.get("status") != "active":
                stage["status"] = "active"
                stage["started_at"] = stage.get("started_at") or now_iso()
                stage["completed_at"] = None
                self.c.record_event("stage.started", f"{project.get('key')}: stage '{stage.get('name')}' started",
                                    project_id=project["id"], data={"stage_id": stage["id"]})
                return True
            steps = stage.get("steps") or []
            for step in steps:
                if step.get("status") == "waiting_children" and self._check_children(tx, step):
                    return True
            if all(s.get("status") in FINISHED for s in steps):
                stage["status"] = "done"
                stage["completed_at"] = now_iso()
                self.c.record_event("stage.completed", f"{project.get('key')}: stage '{stage.get('name')}' completed",
                                    project_id=project["id"], data={"stage_id": stage["id"]})
                return True
            if stage.get("parallel"):
                open_count = sum(1 for s in steps if s.get("status") not in FINISHED and s.get("status") != "pending")
                for step in steps:
                    if open_count >= limit:
                        break
                    if step.get("status") == "pending" and step.get("auto_start", True):
                        self._activate(tx, stage, step)
                        return True
                return False
            step = next(s for s in steps if s.get("status") not in FINISHED)
            if step.get("status") == "pending" and step.get("auto_start", True):
                self._activate(tx, stage, step)
                return True
            return False
        self._complete_project(tx)
        return False

    def _derive_status(self, tx: _Tx) -> None:
        project = tx.project
        if project.get("status") in TERMINAL_PROJECT:
            return
        statuses = [s.get("status") for _, s in self._steps(project)]
        previous = project.get("status")
        if "failed" in statuses:
            status = "blocked"
        elif "running" in statuses:
            status = "active"
        elif any(s in WAITING for s in statuses):
            status = "waiting"
        else:
            status = "active"
        project["status"] = status
        if status == "blocked" and previous != "blocked":
            failed = [s.get("name") or s.get("id") for _, s in self._steps(project) if s.get("status") == "failed"]
            self.c.record_event("project.blocked", f"{project.get('key')} is blocked: {', '.join(failed)} failed",
                                project_id=project["id"], data={"steps": failed})

    def _complete_project(self, tx: _Tx) -> None:
        project = tx.project
        if project.get("status") == "done":
            return
        project["status"] = "done"
        project["completed_at"] = now_iso()
        self.c.record_event("project.completed", f"{project.get('key')} completed: {project.get('title')}",
                            project_id=project["id"])
        recipients = [u for u in (project.get("sponsor_id"), project.get("owner_id")) if u]
        if recipients:
            title = f"{project.get('key')} completed — {project.get('title')}"
            tx.after.append(lambda: self.c.notifier.notify(recipients, "success", title,
                                                           "Every stage of the workflow is done.",
                                                           project_id=project["id"]))
        if project.get("parent_id"):
            tx.kicks.add(project["parent_id"])

    # ------------------------------------------------------------------ activation

    def _activate(self, tx: _Tx, stage: dict, step: dict, *, user_id: str = "") -> None:
        project = tx.project
        now = now_iso()
        tctx = self.build_context(project, step)
        try:
            run = condition(step.get("when") or "", tctx)
        except TemplateError as exc:
            step["started_at"] = now
            self._fail(tx, step, f"Cannot evaluate the condition `{step.get('when')}`: {exc.message}")
            return
        if not run:
            step.update(status="skipped", started_at=now, completed_at=now, completed_by="system",
                        output_summary=f"Skipped — condition `{step.get('when')}` is false")
            self._trace(project, step, f"Skipped: the condition `{step.get('when')}` is false.", "info")
            self.c.record_event("step.skipped", f"{project.get('key')}: '{step.get('name')}' skipped (condition false)",
                                project_id=project["id"], step_id=step["id"], data={"when": step.get("when")})
            return
        step["assignee_user_ids"] = resolve_assignees(self.c, project, step)
        step.update(started_at=now, completed_at=None, completed_by="", error="", pending_action=None,
                    sla_breached=False, ai_busy=False)
        step["due_at"] = iso_add(float(step["sla_hours"])) if step.get("sla_hours") else None
        who = (self.c.get_user(user_id) or {}).get("name", user_id) if user_id else ""
        self.c.record_event("step.started", f"{project.get('key')}: '{step.get('name')}' started"
                            + (f" by {who}" if who else ""), actor=user_id or "system",
                            project_id=project["id"], step_id=step["id"], data={"type": step.get("type")})
        if step.get("type") in HUMAN_TYPES:
            sc = self._ctx(project, stage, step, user_id=user_id, sink=self._sync_sink(project, step))
            outcome = executors_flow.activate(sc)
            step["status"] = outcome.status
            step["output_summary"] = outcome.summary
            if outcome.estimate is not None:
                step["estimate"] = outcome.estimate
            if step.get("type") == "wait_for":
                step["next_poll_at"] = now
            self._trace(project, step, outcome.summary or "Waiting", "info")
            if executors_flow.assist_kind(step) and self.c.ai.configured:
                step["ai_busy"] = True
                tx.assists.append((step["id"], "", user_id))
            self._notify_waiting(tx, step)
        else:
            step["status"] = "running"
            step["attempts"] = int(step.get("attempts") or 0) + 1
            self._trace(project, step, f"Started ({step.get('type')})" + (f" by {who}" if who else ""), "info")
            tx.runs.append((step["id"], "exec", {"token": step["attempts"], "user_id": user_id}))

    def _check_children(self, tx: _Tx, step: dict) -> bool:
        """A waiting fan-out: done once every child is done or cancelled."""
        state = executors_flow.children_status(self.c, step.get("child_ids") or [])
        children = state["children"]
        output = {"children": children}
        if state["closed"]:
            done = sum(1 for c in children if c["status"] == "done")
            summary = f"All {len(children)} child project(s) closed — {done} done" if children else \
                "No child project left"
            self._finish(tx, step, output, actor="ai", ai=True, summary=summary)
            return True
        troubled = state["troubled"]
        open_count = sum(1 for c in children if c["status"] not in CLOSED_PROJECT)
        summary = f"Waiting for {open_count} of {len(children)} child project(s)"
        if troubled:
            summary += f" — {len(troubled)} blocked or failed: {', '.join(c['key'] for c in troubled)}"
        step["output"] = output
        step["output_summary"] = summary
        return False

    # ------------------------------------------------------------------ outcomes

    def _finish(self, tx: _Tx, step: dict, output: Any, *, actor: str, ai: bool, summary: str = "") -> None:
        project = tx.project
        now = now_iso()
        step.update(status="done", completed_at=now, completed_by=actor or ("ai" if ai else "system"),
                    output=output, error="", pending_action=None, ai_busy=False, next_poll_at=None)
        if summary:
            step["output_summary"] = summary
        elif not step.get("output_summary") or step["output_summary"].startswith("Waiting"):
            step["output_summary"] = "Done"
        project.setdefault("vars", {})[step.get("store_as") or step["id"]] = output
        metrics = project.setdefault("metrics", {})
        if ai and (step.get("type") in _EXECUTORS or step.get("type") == "wait_for"):
            metrics["ai_steps"] = int(metrics.get("ai_steps") or 0) + 1
            hours = self.c.app_settings().general.hours_saved.get(step.get("type") or "", 0)
            metrics["hours_saved"] = round(float(metrics.get("hours_saved") or 0) + float(hours or 0), 2)
        else:
            metrics["human_steps"] = int(metrics.get("human_steps") or 0) + 1
        self._trace(project, step, f"Completed — {step['output_summary']}", "result")
        actor_id = actor or "ai"
        self.c.record_event("step.completed", f"{project.get('key')}: '{step.get('name')}' completed — "
                            f"{truncate(step['output_summary'], 160)}", actor=actor_id, project_id=project["id"],
                            step_id=step["id"], data={"type": step.get("type"), "ai": bool(ai)})
        kind = step.get("type")
        if kind == "mcp_operation":
            self.c.record_event("operation.executed", f"{project.get('key')}: {truncate(step['output_summary'], 160)}",
                                actor=actor_id, project_id=project["id"], step_id=step["id"],
                                data={"operation_key": (step.get("config") or {}).get("operation_key", "")})
        elif kind == "quality_gate" and isinstance(output, dict) and not output.get("overridden"):
            self.c.record_event("gate.passed", f"{project.get('key')}: quality gate '{step.get('name')}' passed",
                                actor=actor_id, project_id=project["id"], step_id=step["id"])
        self._apply_team(tx, step, output)

    def _apply_team(self, tx: _Tx, step: dict, output: Any) -> None:
        """SPEC §14: a step output naming a valid team sets the project's team when it has none."""
        project = tx.project
        if project.get("team_id") or not isinstance(output, dict):
            return
        team = self.c.get_team(str(output.get("team_id") or ""))
        if team is None:
            return
        project["team_id"] = team["id"]
        self._trace(project, step, f"Project team set to {team.get('name')}.", "info")
        self.c.record_event("project.updated", f"{project.get('key')}: team set to {team.get('name')} by "
                            f"'{step.get('name')}'", actor="ai", project_id=project["id"], step_id=step["id"],
                            data={"fields": ["team_id"], "team_id": team["id"]})

    def _fail(self, tx: _Tx, step: dict, error: str, *, notify: bool = True) -> None:
        project = tx.project
        step.update(status="failed", error=error or "Failed", pending_action=None, ai_busy=False)
        self._trace(project, step, f"Failed: {error}", "error")
        self.c.record_event("step.failed", f"{project.get('key')}: '{step.get('name')}' failed — {truncate(error, 200)}",
                            project_id=project["id"], step_id=step["id"], data={"error": truncate(error, 1000)})
        if notify:
            admins = [u["id"] for u in self.c.users() if "admin" in (u.get("roles") or []) and u.get("active", True)]
            recipients = list(dict.fromkeys([u for u in [project.get("owner_id"), *admins] if u]))
            if recipients:
                title = f"{project.get('key')} · '{step.get('name')}' failed"
                body = truncate(error, 600) + "\n\nRetry it, skip it, or complete it manually from the project page."
                pid, sid = project["id"], step["id"]
                tx.after.append(lambda: self.c.notifier.notify(recipients, "warning", title, body,
                                                               project_id=pid, step_id=sid))

    def _upsert_artifact(self, tx: _Tx, step: dict, art: dict, actor: str) -> None:
        project = tx.project
        now = now_iso()
        artifacts = project.setdefault("artifacts", [])
        existing = next((a for a in artifacts if a.get("step_id") == step["id"]), None)
        content = art.get("content") or ""
        if existing is None:
            artifacts.append(Artifact.model_validate({
                "id": new_id("art"), "step_id": step["id"], "title": art.get("title") or step.get("name", ""),
                "kind": art.get("kind") if art.get("kind") in ("markdown", "json") else "markdown",
                "content": content, "data": _jsonable(art.get("data")), "version": 1, "history": [],
                "created_at": now, "updated_at": now, "updated_by": actor}).model_dump())
            return
        if existing.get("content") == content and existing.get("data") == _jsonable(art.get("data")):
            return
        self._version(existing)
        existing.update(title=art.get("title") or existing.get("title"), content=content,
                        data=_jsonable(art.get("data")), updated_at=now, updated_by=actor)
        if art.get("kind") in ("markdown", "json"):
            existing["kind"] = art["kind"]

    @staticmethod
    def _version(artifact: dict) -> None:
        """Push the current content into the history (last HISTORY_CAP versions) and bump."""
        history = artifact.setdefault("history", [])
        history.append({"version": int(artifact.get("version") or 1), "content": artifact.get("content") or "",
                        "updated_by": artifact.get("updated_by") or "", "updated_at": artifact.get("updated_at") or ""})
        del history[: max(0, len(history) - HISTORY_CAP)]
        artifact["version"] = int(artifact.get("version") or 1) + 1

    def _add_link(self, tx: _Tx, link: dict, step_id: str = "", actor: str = "system") -> dict:
        project = tx.project
        links = project.setdefault("links", [])
        key = (link.get("kind"), link.get("external_id") or link.get("url"))
        existing = next((l for l in links if key[1] and (l.get("kind"), l.get("external_id") or l.get("url")) == key),
                        None)
        if existing is not None:
            existing.update({k: v for k, v in link.items() if v and k not in ("id", "created_at")})
            return existing
        doc = Link.model_validate({**link, "id": new_id("lnk"), "step_id": link.get("step_id") or step_id,
                                   "created_at": link.get("created_at") or now_iso()}).model_dump()
        links.append(doc)
        self.c.record_event("link.added", f"{project.get('key')}: link added — {doc.get('label') or doc.get('url')}",
                            actor=actor, project_id=project["id"], step_id=doc.get("step_id", ""),
                            data={"kind": doc["kind"], "url": doc["url"], "external_id": doc["external_id"]})
        return doc

    def _apply(self, tx: _Tx, stage: dict, step: dict, outcome: StepOutcome, *, actor: str) -> None:
        """Apply an executor's outcome to the live step (under the lock)."""
        project = tx.project
        if outcome.artifact:
            self._upsert_artifact(tx, step, outcome.artifact, actor or "ai")
        elif outcome.status == "done" and step.get("type") == "ai_task" and outcome.output is not None:
            self._sync_artifact_from_output(tx, step, outcome.output, actor or "ai")
        for link in outcome.links or []:
            self._add_link(tx, link, step["id"], actor or "ai")
        if outcome.checks is not None:
            step["checks"] = _jsonable(outcome.checks)
        if outcome.agent_state is not None:
            step["agent_state"] = _jsonable(outcome.agent_state)
        if outcome.ai_draft is not None:
            step["ai_draft"] = _jsonable(outcome.ai_draft)
        if outcome.form:
            form = step.setdefault("form", {})
            for key, value in outcome.form.items():
                if key not in form or executors_flow.is_empty(form[key]):
                    form[key] = _jsonable(value)
        if outcome.estimate is not None:
            step["estimate"] = {**(step.get("estimate") or {}), **_jsonable(outcome.estimate)}
        if outcome.brief is not None:
            step["brief"] = outcome.brief
        status = outcome.status
        if status == "done":
            self._finish(tx, step, _jsonable(outcome.output), actor=actor or "ai", ai=outcome.ai,
                         summary=outcome.summary)
            if step.get("type") == "agent_task":
                step["agent_state"] = None
            return
        if status == "failed":
            self._fail(tx, step, outcome.error or outcome.summary or "Failed")
            return
        step["status"] = status
        if outcome.summary:
            step["output_summary"] = outcome.summary
        if outcome.output is not None:
            step["output"] = _jsonable(outcome.output)
        step["pending_action"] = _jsonable(outcome.pending_action) if status == "waiting_human" else None
        if step["pending_action"] is not None and not step["pending_action"].get("created_at"):
            step["pending_action"]["created_at"] = now_iso()
        if status == "waiting_children":
            ids = [c.get("id") for c in (outcome.output or {}).get("children") or [] if isinstance(c, dict)]
            step["child_ids"] = list(dict.fromkeys([*(step.get("child_ids") or []), *[i for i in ids if i]]))
            project["child_ids"] = list(dict.fromkeys([*(project.get("child_ids") or []), *step["child_ids"]]))
            self._check_children(tx, step)
        elif status == "waiting_external":
            cfg = WaitForConfig.model_validate(step.get("config") or {})
            step["next_poll_at"] = iso_add(max(1, cfg.poll_minutes) / 60)
        elif status == "waiting_human":
            kind = (step["pending_action"] or {}).get("kind", "")
            if kind == "gate_review":
                self.c.record_event("gate.failed", f"{project.get('key')}: quality gate '{step.get('name')}' blocked — "
                                    f"{truncate(outcome.summary, 160)}", actor="ai", project_id=project["id"],
                                    step_id=step["id"], data={"failed": (outcome.output or {}).get("failed", [])
                                                              if isinstance(outcome.output, dict) else []})
            self._trace(project, step, (step["pending_action"] or {}).get("title") or outcome.summary
                        or "Waiting for a person", "human")
            self._notify_waiting(tx, step)

    def _sync_artifact_from_output(self, tx: _Tx, step: dict, output: Any, actor: str) -> None:
        """An approved (possibly edited) AI draft: its artifact shows the approved version."""
        art = next((a for a in tx.project.get("artifacts") or [] if a.get("step_id") == step["id"]), None)
        if art is None:
            return
        if isinstance(output, dict) and isinstance(output.get("markdown"), str) and len(output) == 1:
            new = {"title": art.get("title"), "kind": "markdown", "content": output["markdown"], "data": None}
        else:
            new = {"title": art.get("title"), "kind": "json",
                   "content": json.dumps(output, indent=2, ensure_ascii=False, default=str), "data": output}
        self._upsert_artifact(tx, step, new, actor)

    # ------------------------------------------------------------------ notifications

    def _approver_ids(self, project: dict, step: dict) -> list[str]:
        _, pending, approved = self._approval_state(step)
        done = {a.get("user_id") for a in approved}
        ids: list[str] = list((step.get("assignee") or {}).get("user_ids") or [])
        for role in pending:
            ids += role_holders(self.c, project, role)
        return [u for u in dict.fromkeys(ids) if u and u not in done]

    def _responsible(self, project: dict, step: dict) -> list[str]:
        ids = list(step.get("assignee_user_ids") or [])
        if not ids and project.get("owner_id"):
            ids = [project["owner_id"]]
        if not ids:
            ids = [u["id"] for u in self.c.users() if "product_manager" in (u.get("roles") or [])
                   and u.get("active", True)]
        return ids

    def _notify_waiting(self, tx: _Tx, step: dict) -> None:
        project = tx.project
        status = step.get("status")
        pending = step.get("pending_action") or {}
        if status == "waiting_approval":
            recipients, kind, title = self._approver_ids(project, step), "approval", f"Approve: {step.get('name')}"
        elif pending:
            recipients, kind = self._responsible(project, step), "task"
            title = pending.get("title") or f"Review: {step.get('name')}"
        elif status in ("waiting_human", "waiting_external"):
            recipients, kind = list(step.get("assignee_user_ids") or []), "task"
            title = f"{'Estimate' if step.get('type') == 'estimation' else 'Complete'}: {step.get('name')}"
        else:
            return
        if not recipients:
            return
        title = f"{project.get('key')} · {title}"
        body = truncate(step.get("description") or (step.get("config") or {}).get("instructions")
                        or project.get("title") or "", 600)
        pid, sid = project["id"], step["id"]
        tx.after.append(lambda: self.c.notifier.notify(recipients, kind, title, body, project_id=pid, step_id=sid))

    # =====================================================================================
    # Background execution
    # =====================================================================================

    async def _call(self, mode: str, sc: StepCtx, kwargs: dict) -> StepOutcome:
        if mode == "exec":
            if sc.step.get("type") not in _EXECUTORS:
                raise EngineError(f"Step type {sc.step.get('type')} does not run automatically.")
            module, name = _EXECUTORS[sc.step["type"]]
            return await getattr(module, name)(sc)
        if mode == "confirm":
            return await executors_ai.resolve_confirmation(sc, kwargs.get("approve", True), kwargs.get("payload"))
        if mode == "rerun_gate":
            return await executors_ai.rerun_gate(sc, kwargs.get("rule_ids"))
        raise EngineError(f"Unknown run mode {mode}")

    @staticmethod
    def _as_failure(sc: StepCtx, exc: BaseException) -> StepOutcome:
        if isinstance(exc, FactoryError):
            message = exc.message
            retryable = not isinstance(exc, (NotConfigured, TemplateError, EngineError, Forbidden, NotFound,
                                             Conflict)) and exc.status_code >= 500 and exc.status_code != 501
        else:
            log.exception("Step %s raised", sc.step.get("id"))
            message, retryable = f"{type(exc).__name__}: {exc}", True
        sc.trace(message, kind="error")
        return fail(message, retryable=retryable)

    def _snapshot(self, pid: str, sid: str, token: int) -> tuple[dict, dict, dict] | None:
        project = self.c.store.get("projects", pid)
        if project is None or project.get("status") in TERMINAL_PROJECT:
            return None
        try:
            stage, step = self._find(project, sid)
        except NotFound:
            return None
        if step.get("status") != "running" or int(step.get("attempts") or 0) != token:
            return None
        return project, stage, step

    async def _run(self, pid: str, sid: str, mode: str, *, token: int, user_id: str = "", **kwargs: Any) -> None:
        """One background execution of a running step, with retries for automated runs."""
        guard = LoopGuard(0, 0, stagnation_limit=2)
        retries = 0
        try:
            while True:
                snap = self._snapshot(pid, sid, token)
                if snap is None:
                    self._buffers.pop((pid, sid), None)
                    return
                project, stage, step = snap
                if kwargs.get("pending_action") is not None:
                    step["pending_action"] = kwargs["pending_action"]
                sc = self._ctx(project, stage, step, user_id=user_id, sink=self._buffered_sink(pid, sid),
                               snapshot=False)
                try:
                    outcome = await self._call(mode, sc, kwargs)
                except Exception as exc:  # noqa: BLE001 — an executor bug becomes a failed outcome
                    outcome = self._as_failure(sc, exc)
                if not isinstance(outcome, StepOutcome):
                    outcome = fail(f"The executor returned {type(outcome).__name__} instead of an outcome",
                                   retryable=False)
                if outcome.status == "failed" and mode == "exec" and outcome.retryable:
                    cfg = step.get("config") or {}
                    signature = {"action": step.get("type"), "tool": cfg.get("operation_key") or cfg.get("tool") or "",
                                 "purpose": _norm_error(outcome.error)}
                    guard.record(signature, ok=False)
                    max_retries = max(0, int(self.c.app_settings().engine.max_retries or 0))
                    if guard.is_stagnant(signature):
                        outcome.error += " (the same error happened again — automatic retries stopped)"
                    elif retries < max_retries:
                        advice = await executors_ai.critic_advice(sc, outcome.error)
                        if advice.startswith("Retrying is unlikely to help"):
                            outcome.error += f" — {advice}"
                        else:
                            retries += 1
                            token = await self._prepare_retry(pid, sid, token, outcome.error, advice, retries)
                            if token is None:
                                return
                            continue
                await self._finish_run(pid, sid, token, outcome, actor=user_id or "ai")
                return
        except Exception as exc:  # noqa: BLE001
            log.exception("Run of %s/%s crashed", pid, sid)
            await self._record_crash(pid, sid, exc)
        finally:
            self._live.discard((pid, sid))

    async def _prepare_retry(self, pid: str, sid: str, token: int, error: str, advice: str,
                             retry: int) -> int | None:
        async with self._lock(pid):
            snap = self._snapshot(pid, sid, token)
            if snap is None:
                return None
            project, _, step = snap
            tx = _Tx(project)
            self._take_buffer(project, step)
            step["attempts"] = token + 1
            step["error"] = error
            if advice:
                step["heal_hint"] = advice
            self._trace(project, step, f"Attempt failed: {truncate(error, 300)} — retrying (retry {retry})"
                        + (f" with advice: {advice}" if advice else ""), "error")
            self.c.record_event("step.retried", f"{project.get('key')}: '{step.get('name')}' retried automatically",
                                actor="ai", project_id=pid, step_id=sid,
                                data={"error": truncate(error, 500), "heal_hint": advice, "retry": retry})
            self._commit(tx)
            return step["attempts"]

    async def _finish_run(self, pid: str, sid: str, token: int, outcome: StepOutcome, *, actor: str) -> None:
        async with self._lock(pid):
            snap = self._snapshot(pid, sid, token)
            if snap is None:
                self._buffers.pop((pid, sid), None)
                log.info("Discarding a stale outcome for %s/%s", pid, sid)
                return
            project, stage, step = snap
            tx = _Tx(project)
            self._take_buffer(project, step)
            self._apply(tx, stage, step, outcome, actor=actor)
            self._progress(tx)
            self._commit(tx)
        self._dispatch(tx)

    async def _assist(self, pid: str, sid: str, instructions: str, user_id: str) -> None:
        """Background AI helper of a human step (draft, estimate suggestion, approver brief).
        Its failure is recorded on the step; the step itself keeps working without it."""
        project = self.c.store.get("projects", pid)
        if project is None:
            return
        try:
            stage, step = self._find(project, sid)
        except NotFound:
            return
        waiting = step.get("status")
        sc = self._ctx(project, stage, step, user_id=user_id, sink=self._buffered_sink(pid, sid))
        outcome: StepOutcome | None = None
        error = ""
        try:
            outcome = await executors_flow.assist(sc, instructions)
        except FactoryError as exc:
            error = exc.message
        except Exception as exc:  # noqa: BLE001
            log.exception("AI helper of %s/%s crashed", pid, sid)
            error = f"{type(exc).__name__}: {exc}"
        async with self._lock(pid):
            project = self.c.store.get("projects", pid)
            if project is None:
                return
            try:
                stage, step = self._find(project, sid)
            except NotFound:
                return
            tx = _Tx(project)
            self._take_buffer(project, step)
            step["ai_busy"] = False
            if step.get("status") != waiting or project.get("status") in TERMINAL_PROJECT:
                self._commit(tx)
                return
            if outcome is None:
                self._trace(project, step, f"AI assistance unavailable: {error}", "error")
            else:
                first = {"human_form": step.get("ai_draft") is None,
                         "estimation": not (step.get("estimate") or {}).get("ai_suggestion"),
                         "approval": not step.get("brief")}.get(step.get("type") or "", False)
                if outcome.ai_draft is not None:
                    step["ai_draft"] = _jsonable(outcome.ai_draft)
                if outcome.form:
                    form = step.setdefault("form", {})
                    for key, value in outcome.form.items():
                        if key not in form or executors_flow.is_empty(form[key]):
                            form[key] = _jsonable(value)
                if outcome.estimate is not None:
                    step["estimate"] = {**(step.get("estimate") or {}), **_jsonable(outcome.estimate)}
                if outcome.brief is not None:
                    step["brief"] = outcome.brief
                self._trace(project, step, outcome.summary or "AI assistance ready", "ai")
                if first:
                    metrics = project.setdefault("metrics", {})
                    hours = self.c.app_settings().general.hours_saved.get(_ASSIST_HOURS.get(step.get("type"), ""), 0)
                    metrics["hours_saved"] = round(float(metrics.get("hours_saved") or 0) + float(hours or 0), 2)
            self._commit(tx)

    # =====================================================================================
    # Human actions
    # =====================================================================================

    def _open_step(self, project: dict, sid: str) -> tuple[dict, dict]:
        if project.get("status") in CLOSED_PROJECT:
            raise EngineError(f"{project.get('key')} is {project.get('status')} — nothing can change any more.")
        return self._find(project, sid)

    @staticmethod
    def _expect(step: dict, statuses: tuple[str, ...], what: str) -> None:
        if step.get("status") not in statuses:
            raise EngineError(f"'{step.get('name') or step.get('id')}' is {str(step.get('status')).replace('_', ' ')} — "
                              f"it cannot {what} now.")

    def _name(self, user_id: str) -> str:
        return (self.c.get_user(user_id) or {}).get("name") or user_id

    async def start_step(self, pid: str, sid: str, user_id: str) -> dict:
        def fn(tx: _Tx) -> None:
            stage, step = self._open_step(tx.project, sid)
            self._require(tx.project, step, user_id)
            self._expect(step, ("pending",), "be started")
            if stage.get("status") != "active":
                raise EngineError(f"'{step.get('name')}' belongs to a stage that has not started yet.")
            if not stage.get("parallel"):
                earlier = stage["steps"][: stage["steps"].index(step)]
                if any(s.get("status") not in FINISHED for s in earlier):
                    raise EngineError(f"'{step.get('name')}' starts after the earlier steps of its stage are finished.")
            self._activate(tx, stage, step, user_id=user_id)
        return await self._mutate(pid, fn)

    async def save_form(self, pid: str, sid: str, user_id: str, form: dict) -> dict:
        def fn(tx: _Tx) -> None:
            _, step = self._open_step(tx.project, sid)
            self._require(tx.project, step, user_id)
            if step.get("type") != "human_form":
                raise EngineError(f"'{step.get('name')}' has no form to save.")
            self._expect(step, ("waiting_human",), "be edited")
            step["form"] = {**(step.get("form") or {}), **_jsonable(form or {})}
        return await self._mutate(pid, fn, progress=False)

    async def complete_step(self, pid: str, sid: str, user_id: str, form: dict | None = None,
                            output: Any = None) -> dict:
        snapshot = self._load(pid)
        _, peek = self._open_step(snapshot, sid)
        pending = (peek.get("pending_action") or {}).get("kind")
        if peek.get("status") == "waiting_human" and pending == "ai_review":
            payload = {"output": output} if output is not None else None
            return await self.confirm(pid, sid, user_id, True, payload)
        if peek.get("type") == "estimation" and peek.get("status") == "waiting_human":
            estimate = output if isinstance(output, dict) else form
            if not isinstance(estimate, dict) or not estimate:
                raise EngineError("Give the estimate (value, unit, confidence…).")
            return await self.submit_estimate(pid, sid, user_id, estimate)

        def fn(tx: _Tx) -> None:
            project = tx.project
            _, step = self._open_step(project, sid)
            self._require(project, step, user_id)
            status, kind = step.get("status"), step.get("type")
            who = self._name(user_id)
            if status == "failed":
                self._trace(project, step, f"Completed manually by {who}.", "human", data={"output": output})
                self._finish(tx, step, _jsonable(output) if output is not None else {}, actor=user_id, ai=False,
                             summary=f"Completed manually by {who}")
                return
            if kind == "human_form":
                self._expect(step, ("waiting_human",), "be submitted")
                fields = (step.get("config") or {}).get("fields") or []
                values = {**(step.get("form") or {}), **(form or {})}
                typed, problems = executors_flow.collect_values(self.c, fields, values)
                if problems:
                    raise EngineError("Please fix the form: " + "; ".join(problems))
                step["form"] = _jsonable(typed)
                title = (step.get("config") or {}).get("artifact_title") or step.get("name") or "Form"
                self._upsert_artifact(tx, step, {"title": title, "kind": "markdown",
                                                 "content": executors_flow.form_markdown(self.c, fields, typed)},
                                      user_id)
                self._trace(project, step, f"Submitted by {who}.", "human")
                self.c.record_event("form.submitted", f"{project.get('key')}: '{step.get('name')}' submitted by {who}",
                                    actor=user_id, project_id=project["id"], step_id=step["id"])
                self._finish(tx, step, _jsonable(typed), actor=user_id, ai=False, summary=f"Submitted by {who}")
                return
            if kind == "wait_for":
                self._expect(step, ("waiting_external",), "be completed")
                if not WaitForConfig.model_validate(step.get("config") or {}).manual_complete:
                    raise EngineError(f"'{step.get('name')}' completes by itself when its condition is met.")
                value = _jsonable(output) if output is not None else step.get("output")
                self._trace(project, step, f"Marked complete by {who}.", "human")
                self._finish(tx, step, value, actor=user_id, ai=False, summary=f"Marked complete by {who}")
                return
            if kind == "approval":
                raise EngineError("An approval is answered with Approve or Reject.")
            if status == "waiting_human" and pending in ("confirm_operation", "agent_tool_call"):
                raise EngineError("This step waits for a confirmation: confirm or reject it.")
            if status == "waiting_human" and pending == "gate_review":
                raise EngineError("A blocked quality gate is resolved with override, re-run or send back.")
            raise EngineError(f"'{step.get('name')}' is {str(status).replace('_', ' ')} — there is nothing to complete.")
        return await self._mutate(pid, fn)

    async def request_ai_draft(self, pid: str, sid: str, user_id: str, instructions: str = "") -> dict:
        if not self.c.ai.configured:
            raise LLMNotConfigured()

        def fn(tx: _Tx) -> None:
            _, step = self._open_step(tx.project, sid)
            self._require(tx.project, step, user_id)
            expected = {"human_form": "waiting_human", "estimation": "waiting_human", "approval": "waiting_approval"}
            if step.get("type") not in expected:
                raise EngineError(f"'{step.get('name')}' has no AI draft — use the AI menu of a text field instead.")
            self._expect(step, (expected[step["type"]],), "get an AI draft")
            if step.get("ai_busy"):
                raise Conflict("The AI is already working on this step — wait for its draft.")
            step["ai_busy"] = True
            self._trace(tx.project, step, f"AI draft requested by {self._name(user_id)}"
                        + (f": {instructions.strip()}" if instructions.strip() else "."), "human")
            tx.assists.append((sid, instructions or "", user_id))
        return await self._mutate(pid, fn, progress=False)

    async def decide(self, pid: str, sid: str, user_id: str, decision: str, comment: str = "") -> dict:
        if decision not in ("approved", "rejected"):
            raise EngineError("The decision must be 'approved' or 'rejected'.")

        def fn(tx: _Tx) -> None:
            project = tx.project
            stage, step = self._open_step(project, sid)
            if step.get("type") != "approval":
                raise EngineError(f"'{step.get('name')}' is not an approval.")
            self._expect(step, ("waiting_approval",), "be decided")
            user = self._require(project, step, user_id)
            if decision == "rejected" and not (comment or "").strip():
                raise EngineError("Say why you reject — the comment goes back to the people who must rework it.")
            cfg, pending, approved = self._approval_state(step)
            if cfg.policy != "all" and any(a.get("user_id") == user_id for a in approved):
                raise EngineError("You already approved this step.")
            held = [r for r in pending if self._holds(project, user, r)]
            if held:
                role = held[0]
            elif pending:   # admin or explicitly assigned approver: answers for the first pending role
                role = pending[0]
            else:
                raise EngineError("This approval needs no further decision.")
            if any(a.get("user_id") == user_id and a.get("role") == role for a in step.get("approvals") or []):
                raise EngineError("You already decided for this role.")
            who = self._name(user_id)
            labels = {a.role: a.label or a.role for a in cfg.approvers}
            started = parse_iso(step.get("started_at"))
            wait_hours = round((datetime.now(timezone.utc) - started).total_seconds() / 3600, 2) if started else None
            step.setdefault("approvals", []).append({"user_id": user_id, "role": role, "decision": decision,
                                                     "comment": comment or "", "at": now_iso()})
            self._trace(project, step, f"{'Approved' if decision == 'approved' else 'Rejected'} by {who} "
                        f"({labels.get(role, role)})" + (f": {comment}" if comment else ""), "human",
                        data={"decision": decision, "role": role, "user_id": user_id})
            self.c.record_event(f"approval.{decision}", f"{project.get('key')}: '{step.get('name')}' {decision} by "
                                f"{who} ({labels.get(role, role)})" + (f" — {truncate(comment, 200)}" if comment else ""),
                                actor=user_id, project_id=project["id"], step_id=step["id"],
                                data={"user_id": user_id, "role": role, "comment": comment, "wait_hours": wait_hours})
            if decision == "rejected":
                if cfg.on_reject.action == "fail":
                    step.update(status="rejected", completed_at=now_iso(), completed_by=user_id,
                                output_summary=f"Rejected by {who}: {truncate(comment, 160)}")
                    project["status"] = "failed"
                    project["completed_at"] = None
                    recipients = [u for u in (project.get("owner_id"), project.get("sponsor_id")) if u]
                    if recipients:
                        title = f"{project.get('key')} rejected at '{step.get('name')}'"
                        tx.after.append(lambda: self.c.notifier.notify(recipients, "warning", title, comment,
                                                                       project_id=project["id"], step_id=sid))
                    if project.get("parent_id"):
                        tx.kicks.add(project["parent_id"])
                    return
                target = cfg.on_reject.goto_step or self._previous_step(project, sid)
                feedback = f"Rejected by {who} ({labels.get(role, role)}): {comment}"
                self._reopen(tx, target or sid, sid, feedback, user_id, notify_title="Changes requested")
                return
            _, still, approvals = self._approval_state(step)
            if not still:
                output = {"decision": "approved", "approvals": step.get("approvals") or []}
                self._finish(tx, step, _jsonable(output), actor=user_id, ai=False,
                             summary="Approved by " + ", ".join(self._name(a.get("user_id", "")) for a in approvals))
            else:
                step["output_summary"] = f"Approved by {len(approvals)} — waiting for " \
                                         + ", ".join(labels.get(r, r) for r in still)
        return await self._mutate(pid, fn)

    def _previous_step(self, project: dict, sid: str) -> str:
        """The nearest earlier step that ran (on_reject without an explicit target)."""
        ordered = [s for _, s in self._steps(project)]
        index = next(i for i, s in enumerate(ordered) if s.get("id") == sid)
        for step in reversed(ordered[:index]):
            if step.get("status") == "done":
                return step["id"]
        return ""

    def _reopen(self, tx: _Tx, target_sid: str, upto_sid: str, feedback: str, actor: str, *,
                notify_title: str = "Reopened") -> None:
        """Reset the target step and every later step up to `upto_sid` to pending (trace kept,
        feedback set on the target), move the current stage back, project active."""
        project = tx.project
        ordered = self._steps(project)
        ids = [s.get("id") for _, s in ordered]
        if target_sid not in ids:
            raise EngineError(f"Step '{target_sid}' does not exist in this project.")
        start = ids.index(target_sid)
        end = ids.index(upto_sid) if upto_sid in ids else len(ids) - 1
        if end < start:
            raise EngineError("A step can only be sent back to an earlier step.")
        target_stage, target = ordered[start]
        previous_assignees = list(target.get("assignee_user_ids") or [])
        for stage, step in ordered[start:end + 1]:
            if step is not target and step.get("status") == "pending":
                continue
            keep_form = step.get("form") if step.get("type") == "human_form" else {}
            project.get("vars", {}).pop(step.get("store_as") or step["id"], None)
            step.update(status="pending", started_at=None, completed_at=None, completed_by="", error="",
                        output=None, output_summary="", approvals=[], brief="", checks=[], estimate=None,
                        pending_action=None, agent_state=None, ai_busy=False, ai_draft=None, due_at=None,
                        sla_breached=False, next_poll_at=None, form=keep_form or {}, feedback="")
            self._trace(project, step, f"Reopened by {self._name(actor)}: {truncate(feedback, 400)}", "human")
        target["feedback"] = feedback
        stages = project.get("stages") or []
        first = next(i for i, st in enumerate(stages) if st["id"] == target_stage["id"])
        for stage in stages[first:]:
            if stage is target_stage or any(s.get("status") != "pending" for s in stage.get("steps") or []):
                stage["status"] = "active"
                stage["completed_at"] = None
            else:
                stage.update(status="pending", started_at=None, completed_at=None)
        project["current_stage_id"] = target_stage["id"]
        if project.get("status") in ("done", "blocked", "waiting", "failed"):
            project["status"] = "active"
            project["completed_at"] = None
        self.c.record_event("step.reopened", f"{project.get('key')}: '{target.get('name')}' reopened — "
                            f"{truncate(feedback, 200)}", actor=actor or "system", project_id=project["id"],
                            step_id=target["id"], data={"feedback": feedback, "upto": upto_sid})
        if previous_assignees:
            title = f"{project.get('key')} · {notify_title}: {target.get('name')}"
            pid, tsid = project["id"], target["id"]
            tx.after.append(lambda: self.c.notifier.notify(previous_assignees, "warning", title, feedback,
                                                           project_id=pid, step_id=tsid))

    async def submit_estimate(self, pid: str, sid: str, user_id: str, estimate: dict) -> dict:
        def fn(tx: _Tx) -> None:
            project = tx.project
            _, step = self._open_step(project, sid)
            if step.get("type") != "estimation":
                raise EngineError(f"'{step.get('name')}' is not an estimation step.")
            self._expect(step, ("waiting_human",), "receive an estimate")
            self._require(project, step, user_id)
            cfg = EstimationConfig.model_validate(step.get("config") or {})
            data = {k: v for k, v in (estimate or {}).items() if k not in ("ai_suggestion", "submitted_by")}
            data.setdefault("unit", cfg.unit)
            try:
                parsed = Estimate.model_validate(data)
            except ValidationError as exc:
                raise EngineError(f"Invalid estimate — {validation_message(exc)}") from exc
            if parsed.value is None or parsed.value < 0:
                raise EngineError("Give the estimate value (a positive number).")
            if cfg.require_breakdown and not parsed.breakdown:
                raise EngineError("This estimate needs a breakdown (one line per piece of work).")
            result = parsed.model_dump()
            result["submitted_by"] = user_id
            result["ai_suggestion"] = (step.get("estimate") or {}).get("ai_suggestion")
            step["estimate"] = result
            who = self._name(user_id)
            summary = f"{parsed.value:g} {parsed.unit} ({parsed.confidence} confidence) by {who}"
            self._trace(project, step, f"Estimate submitted: {summary}.", "human")
            self.c.record_event("estimate.submitted", f"{project.get('key')}: '{step.get('name')}' — {summary}",
                                actor=user_id, project_id=project["id"], step_id=step["id"],
                                data={"value": parsed.value, "unit": parsed.unit})
            self._finish(tx, step, _jsonable(result), actor=user_id, ai=False, summary=summary)
        return await self._mutate(pid, fn)

    async def confirm(self, pid: str, sid: str, user_id: str, approve: bool, payload: dict | None = None) -> dict:
        async with self._lock(pid):
            project = self._load(pid)
            stage, step = self._open_step(project, sid)
            pending = step.get("pending_action") or {}
            kind = pending.get("kind")
            if step.get("status") != "waiting_human" or kind not in ("confirm_operation", "agent_tool_call",
                                                                      "ai_review"):
                raise EngineError(f"'{step.get('name')}' is not waiting for a confirmation.")
            self._require(project, step, user_id)
            tx = _Tx(project)
            inline = (kind == "ai_review" and approve) or (kind == "confirm_operation" and not approve)
            if inline:
                sc = self._ctx(project, stage, step, user_id=user_id, sink=self._sync_sink(project, step))
                try:
                    outcome = await executors_ai.resolve_confirmation(sc, bool(approve), payload)
                except FactoryError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    outcome = self._as_failure(sc, exc)
                self._apply(tx, stage, step, outcome, actor=user_id)
                self._progress(tx)
            else:
                step["status"] = "running"
                step["pending_action"] = None
                if kind == "agent_tool_call":
                    self.c.record_event("agent.tool_call", f"{project.get('key')}: {self._name(user_id)} "
                                        f"{'approved' if approve else 'declined'} {pending.get('payload', {}).get('tool')}",
                                        actor=user_id, project_id=pid, step_id=sid,
                                        data={"tool": (pending.get("payload") or {}).get("tool"), "approve": approve})
                verb = "Confirmed" if approve else ("Regeneration requested" if kind == "ai_review" else "Declined")
                self._trace(project, step, f"{verb} by {self._name(user_id)} — working…", "human")
                tx.runs.append((sid, "confirm", {"token": int(step.get("attempts") or 0), "user_id": user_id,
                                                 "approve": bool(approve), "payload": payload,
                                                 "pending_action": pending}))
                self._derive_status(tx)
            stored = self._commit(tx)
        self._dispatch(tx)
        return stored

    async def gate_action(self, pid: str, sid: str, user_id: str, action: str, comment: str = "",
                          rule_ids: list[str] | None = None, goto_step: str = "") -> dict:
        if action not in ("override", "rerun", "send_back"):
            raise EngineError("The gate action must be override, rerun or send_back.")

        def fn(tx: _Tx) -> None:
            project = tx.project
            stage, step = self._open_step(project, sid)
            if step.get("type") != "quality_gate":
                raise EngineError(f"'{step.get('name')}' is not a quality gate.")
            if not (step.get("status") == "waiting_human"
                    and (step.get("pending_action") or {}).get("kind") == "gate_review"):
                raise EngineError(f"'{step.get('name')}' is not waiting for a gate review.")
            user = self._require(project, step, user_id)
            cfg = QualityGateConfig.model_validate(step.get("config") or {})
            who = self._name(user_id)
            if action == "override":
                if not self._is_admin(user) and not set(user.get("roles") or []) & set(cfg.override_roles):
                    labels = {r.get("key"): r.get("label") or r.get("key") for r in self.c.roles()}
                    names = " or ".join(labels.get(r, r) for r in cfg.override_roles if r != "admin") or "an authorised role"
                    raise Forbidden(f"Only {names} or an admin can override this gate.")
                if not (comment or "").strip():
                    raise EngineError("An override needs a justification comment (it is audited).")
                payload = (step.get("pending_action") or {}).get("payload") or {}
                wanted = {str(r).lower() for r in (rule_ids or [])} or \
                    {str(r).lower() for r in [*(payload.get("blocking") or []), *(payload.get("pending") or [])]}
                checks = copy.deepcopy(step.get("checks") or [])
                hit = []
                for check in checks:
                    ids = {(check.get("rule_id") or "").lower(), (check.get("code") or "").lower()}
                    if ids & wanted and check.get("status") in ("fail", "pending", "warn"):
                        check["overridden_by"] = user_id
                        check["override_comment"] = comment
                        hit.append(check.get("code") or check.get("rule_id"))
                if not hit:
                    raise EngineError("None of these rules is failing or pending — nothing to override.")
                self._trace(project, step, f"Overridden by {who} ({', '.join(hit)}): {comment}", "human")
                self.c.record_event("gate.overridden", f"{project.get('key')}: {who} overrode {', '.join(hit)} on "
                                    f"'{step.get('name')}' — {truncate(comment, 200)}", actor=user_id,
                                    project_id=project["id"], step_id=sid, data={"rules": hit, "comment": comment})
                outcome = executors_ai._gate_verdict(cfg, checks)   # same verdict rules as the gate itself
                self._apply(tx, stage, step, outcome, actor=user_id)
                return
            if action == "rerun":
                step["status"] = "running"
                step["pending_action"] = None
                step["attempts"] = int(step.get("attempts") or 0) + 1
                self._trace(project, step, f"Re-run requested by {who}"
                            + (f" for {', '.join(rule_ids)}" if rule_ids else "") + ".", "human")
                tx.runs.append((sid, "rerun_gate", {"token": step["attempts"], "user_id": user_id,
                                                    "rule_ids": list(rule_ids or []) or None}))
                return
            if not (comment or "").strip():
                raise EngineError("Say what must be reworked — the comment goes back to the people who fix it.")
            target = goto_step or self._previous_step(project, sid)
            if not target:
                raise EngineError("There is no earlier step to send the work back to.")
            self._reopen(tx, target, sid, f"Sent back by {who} from '{step.get('name')}': {comment}", user_id,
                         notify_title="Rework requested")
        return await self._mutate(pid, fn)

    async def retry_step(self, pid: str, sid: str, user_id: str) -> dict:
        def fn(tx: _Tx) -> None:
            project = tx.project
            stage, step = self._find(project, sid)
            if project.get("status") == "cancelled" or project.get("status") == "done":
                raise EngineError(f"{project.get('key')} is {project.get('status')} — it cannot be retried.")
            stuck = step.get("status") == "running" and (pid, sid) not in self._live
            if step.get("status") not in ("failed", "rejected") and not stuck:
                raise EngineError(f"'{step.get('name')}' is {step.get('status')} — only a failed step can be retried.")
            self._require(project, step, user_id)
            step.update(status="pending", error="", pending_action=None, agent_state=None, ai_busy=False,
                        completed_at=None, completed_by="")
            if step.get("type") == "approval":
                step["approvals"] = []
            if project.get("status") in ("blocked", "failed"):
                project["status"] = "active"
            self._trace(project, step, f"Retry requested by {self._name(user_id)}.", "human")
            self.c.record_event("step.retried", f"{project.get('key')}: '{step.get('name')}' retried by "
                                f"{self._name(user_id)}", actor=user_id, project_id=pid, step_id=sid)
            if stage.get("status") == "active":
                self._activate(tx, stage, step, user_id=user_id)
        return await self._mutate(pid, fn)

    async def skip_step(self, pid: str, sid: str, user_id: str, reason: str) -> dict:
        def fn(tx: _Tx) -> None:
            project = tx.project
            _, step = self._open_step(project, sid)
            user = self._user(user_id)
            if not (self._is_admin(user) or user_id == project.get("owner_id")
                    or (step.get("status") == "failed" and self.can_act(project, step, user_id))):
                raise Forbidden("Only the project owner or an admin can skip a step.")
            if step.get("status") in FINISHED:
                raise EngineError(f"'{step.get('name')}' is already {step.get('status')}.")
            if not (reason or "").strip():
                raise EngineError("Say why this step is skipped (it is audited).")
            who = self._name(user_id)
            step.update(status="skipped", completed_at=now_iso(), completed_by=user_id, pending_action=None,
                        ai_busy=False, error="", output_summary=f"Skipped by {who}: {truncate(reason, 160)}")
            self._trace(project, step, f"Skipped by {who}: {reason}", "human")
            self.c.record_event("step.skipped", f"{project.get('key')}: '{step.get('name')}' skipped by {who} — "
                                f"{truncate(reason, 200)}", actor=user_id, project_id=pid, step_id=sid,
                                data={"reason": reason})
            if project.get("status") == "failed":
                project["status"] = "active"
        return await self._mutate(pid, fn)

    async def reopen_step(self, pid: str, sid: str, user_id: str, reason: str) -> dict:
        def fn(tx: _Tx) -> None:
            project = tx.project
            if project.get("status") == "cancelled":
                raise EngineError(f"{project.get('key')} is cancelled — it cannot be reopened.")
            _, step = self._find(project, sid)
            self._require(project, step, user_id)
            if step.get("status") == "pending":
                raise EngineError(f"'{step.get('name')}' has not started — there is nothing to reopen.")
            ordered = [s for _, s in self._steps(project)]
            started = [i for i, s in enumerate(ordered) if s.get("status") != "pending"]
            upto = ordered[max(started)]["id"]
            text = (reason or "").strip() or "Reopened for changes"
            self._reopen(tx, sid, upto, f"Reopened by {self._name(user_id)}: {text}", user_id)
        return await self._mutate(pid, fn)

    async def reassign_step(self, pid: str, sid: str, user_id: str, user_ids: list[str]) -> dict:
        def fn(tx: _Tx) -> None:
            project = tx.project
            _, step = self._open_step(project, sid)
            user = self._user(user_id)
            if not (self._is_admin(user) or user_id in (project.get("owner_id"), project.get("sponsor_id"))
                    or self.can_act(project, step, user_id)):
                raise Forbidden("Only the project owner or sponsor, an assignee, or an admin can reassign a step.")
            if step.get("status") in FINISHED:
                raise EngineError(f"'{step.get('name')}' is {step.get('status')} — it cannot be reassigned.")
            unknown = [u for u in user_ids if self.c.get_user(u) is None]
            if unknown:
                raise EngineError(f"Unknown user(s): {', '.join(unknown)}")
            ids = list(dict.fromkeys(user_ids))
            step["assignee_user_ids"] = ids
            step.setdefault("assignee", {})["user_ids"] = ids
            names = ", ".join(self._name(u) for u in ids) or "nobody"
            self._trace(project, step, f"Reassigned to {names} by {self._name(user_id)}.", "human")
            self.c.record_event("step.assigned", f"{project.get('key')}: '{step.get('name')}' assigned to {names}",
                                actor=user_id, project_id=pid, step_id=sid, data={"user_ids": ids})
            if ids and step.get("status") in OPEN:
                title = f"{project.get('key')} · Assigned to you: {step.get('name')}"
                kind = "approval" if step.get("type") == "approval" else "task"
                tx.after.append(lambda: self.c.notifier.notify(ids, kind, title, project.get("title", ""),
                                                               project_id=pid, step_id=sid))
        return await self._mutate(pid, fn, progress=False)

    async def cancel_project(self, pid: str, user_id: str, reason: str) -> dict:
        def fn(tx: _Tx) -> None:
            project = tx.project
            if user_id not in _SYSTEM_ACTORS:
                self._require_manager(project, user_id, "cancel it")
            if project.get("status") in CLOSED_PROJECT:
                raise EngineError(f"{project.get('key')} is already {project.get('status')}.")
            project["status"] = "cancelled"
            for _, step in self._steps(project):
                step["ai_busy"] = False
            text = (reason or "").strip()
            self.c.record_event("project.cancelled", f"{project.get('key')} cancelled by {self._name(user_id)}"
                                + (f": {truncate(text, 200)}" if text else ""), actor=user_id or "system",
                                project_id=pid, data={"reason": text})
            recipients = [u for u in (project.get("sponsor_id"), project.get("owner_id")) if u and u != user_id]
            if recipients:
                title = f"{project.get('key')} cancelled — {project.get('title')}"
                tx.after.append(lambda: self.c.notifier.notify(recipients, "info", title, text, project_id=pid))
            for cid in project.get("child_ids") or []:
                child = self.c.store.get("projects", cid)
                if child is not None and child.get("status") not in CLOSED_PROJECT:
                    tx.after.append(lambda cid=cid: self._cancel_child(cid, project.get("key", "")))
            if project.get("parent_id"):
                tx.kicks.add(project["parent_id"])
        return await self._mutate(pid, fn, progress=False)

    async def _cancel_child(self, cid: str, parent_key: str) -> None:
        try:
            await self.cancel_project(cid, "system", f"Parent project {parent_key} was cancelled")
        except (EngineError, NotFound):
            pass

    async def update_project(self, pid: str, user_id: str, patch: dict) -> dict:
        unknown = sorted(set(patch or {}) - set(_PATCHABLE))
        if unknown:
            raise EngineError(f"These fields cannot be changed here: {', '.join(unknown)}.")

        def fn(tx: _Tx) -> None:
            project = tx.project
            if user_id in _SYSTEM_ACTORS:
                if set(patch) - {"ai_summary"}:
                    raise Forbidden("Only a person can change the project's details.")
            else:
                self._require_manager(project, user_id, "change the project", allow_pm=True)
            for key in ("sponsor_id", "owner_id"):
                if patch.get(key) and self.c.get_user(patch[key]) is None:
                    raise EngineError(f"Unknown user {patch[key]}.")
            if patch.get("team_id") and self.c.get_team(patch["team_id"]) is None:
                raise EngineError(f"Unknown team {patch['team_id']}.")
            if "title" in patch and not str(patch["title"] or "").strip():
                raise EngineError("A project needs a title.")
            if "priority" in patch and patch["priority"] not in ("low", "medium", "high", "critical"):
                raise EngineError(f"Unknown priority '{patch['priority']}'.")
            changed = [k for k, v in patch.items() if project.get(k) != v]
            if not changed:
                return
            for key in changed:
                project[key] = patch[key]
            if set(changed) & {"sponsor_id", "owner_id", "team_id"}:
                for _, step in self._steps(project):
                    if step.get("status") in WAITING:
                        explicit = (step.get("assignee") or {}).get("user_ids") or []
                        if not explicit:
                            step["assignee_user_ids"] = resolve_assignees(self.c, project, step)
            people = [k for k in changed if k != "ai_summary"]
            if people:
                self.c.record_event("project.updated", f"{project.get('key')} updated by {self._name(user_id)}: "
                                    f"{', '.join(people)}", actor=user_id, project_id=pid, data={"fields": people})
        return await self._mutate(pid, fn, progress=False)

    async def update_artifact(self, pid: str, artifact_id: str, user_id: str, content: str) -> dict:
        def fn(tx: _Tx) -> None:
            project = tx.project
            user = self._user(user_id)
            artifact = next((a for a in project.get("artifacts") or [] if a.get("id") == artifact_id), None)
            if artifact is None:
                raise NotFound(f"Artifact {artifact_id} not found")
            step = None
            if artifact.get("step_id"):
                try:
                    step = self._find(project, artifact["step_id"])[1]
                except NotFound:
                    step = None
            allowed = (self._is_admin(user) or user_id in (project.get("owner_id"), project.get("sponsor_id"),
                                                            project.get("created_by"))
                       or user_id in (project.get("stakeholder_ids") or [])
                       or "product_manager" in (user.get("roles") or [])
                       or (step is not None and self.can_act(project, step, user_id)))
            if not allowed:
                raise Forbidden("Only the project's owner, sponsor, stakeholders, assignees or an admin can edit "
                                "its documents.")
            if content == artifact.get("content"):
                return
            data = artifact.get("data")
            if artifact.get("kind") == "json":
                try:
                    data = json.loads(content)
                except ValueError as exc:
                    raise EngineError(f"This document is JSON and the new content is not valid JSON ({exc}).") from exc
            self._version(artifact)
            artifact.update(content=content, data=data, updated_at=now_iso(), updated_by=user_id)
            if step is not None and step.get("status") in ("done", "waiting_human"):
                var = step.get("store_as") or step["id"]
                output = step.get("output")
                if isinstance(output, dict) and set(output) == {"markdown"} and artifact.get("kind") == "markdown":
                    step["output"] = {"markdown": content}
                elif artifact.get("kind") == "json" and step.get("type") in ("ai_task",):
                    step["output"] = data
                else:
                    output = None
                if output is not None and step.get("status") == "done":
                    project.setdefault("vars", {})[var] = step["output"]
            self.c.record_event("artifact.updated", f"{project.get('key')}: '{artifact.get('title')}' edited by "
                                f"{self._name(user_id)} (v{artifact['version']})", actor=user_id, project_id=pid,
                                step_id=artifact.get("step_id", ""), data={"artifact_id": artifact_id,
                                                                          "version": artifact["version"]})
        return await self._mutate(pid, fn, progress=False)

    async def add_comment(self, pid: str, user_id: str, text: str) -> dict:
        project = self._load(pid)
        self._user(user_id)
        text = (text or "").strip()
        if not text:
            raise EngineError("A comment cannot be empty.")
        event = self.c.record_event("comment.added", text, actor=user_id, project_id=project["id"],
                                    data={"user_id": user_id})
        self.c.bus.emit("project.updated", project_id=project["id"], summary=self.summary(project))
        return event

    async def add_link(self, pid: str, user_id: str, link: dict) -> dict:
        def fn(tx: _Tx) -> None:
            self._user(user_id)
            self._add_link(tx, {"kind": link.get("kind") or "url", "label": link.get("label") or link.get("url") or "",
                                "url": link.get("url") or "", "external_id": link.get("external_id") or "",
                                "status": link.get("status") or "", "step_id": link.get("step_id") or ""},
                           actor=user_id)
        return await self._mutate(pid, fn, progress=False)

    async def delete_project(self, pid: str) -> None:
        async with self._lock(pid):
            project = self._load(pid)
            self.c.store.delete("projects", pid)
        self._locks.pop(pid, None)
        self.c.bus.emit("project.deleted", project_id=pid)
        self.c.record_event("project.updated", f"{project.get('key')} deleted: {project.get('title')}",
                            data={"deleted_project_id": pid, "key": project.get("key")})
        parent_id = project.get("parent_id")
        if parent_id:
            async with self._lock(parent_id):
                parent = self.c.store.get("projects", parent_id)
                if parent is not None:
                    parent["child_ids"] = [c for c in parent.get("child_ids") or [] if c != pid]
                    for _, step in self._steps(parent):
                        if pid in (step.get("child_ids") or []):
                            step["child_ids"] = [c for c in step["child_ids"] if c != pid]
                    self._commit(_Tx(parent))
            self.kick(parent_id)
        for cid in project.get("child_ids") or []:
            async with self._lock(cid):
                child = self.c.store.get("projects", cid)
                if child is not None and child.get("parent_id") == pid:
                    child["parent_id"] = ""
                    child["parent_step_id"] = ""
                    self._commit(_Tx(child))

    # =====================================================================================
    # Scheduler hooks
    # =====================================================================================

    async def poll_wait_step(self, pid: str, sid: str) -> None:
        project = self.c.store.get("projects", pid)
        if project is None or project.get("status") in TERMINAL_PROJECT:
            return
        stage, step = self._find(project, sid)
        if step.get("type") != "wait_for" or step.get("status") != "waiting_external":
            return
        sc = self._ctx(project, stage, step, sink=self._buffered_sink(pid, sid))
        try:
            outcome = await executors_flow.poll_wait_for(sc)
        except Exception as exc:  # noqa: BLE001 — a poll that crashed is a poll that did not succeed
            message = exc.message if isinstance(exc, FactoryError) else f"{type(exc).__name__}: {exc}"
            outcome = StepOutcome(status="waiting_external", error=message,
                                  summary=f"Last check failed: {truncate(message, 160)}")
        async with self._lock(pid):
            project = self.c.store.get("projects", pid)
            if project is None or project.get("status") in TERMINAL_PROJECT:
                return
            stage, step = self._find(project, sid)
            if step.get("status") != "waiting_external":
                return
            tx = _Tx(project)
            self._take_buffer(project, step)
            if outcome.status == "waiting_external":
                cfg = WaitForConfig.model_validate(step.get("config") or {})
                if outcome.summary != step.get("output_summary") or outcome.error != step.get("error"):
                    self._trace(project, step, outcome.summary or "Checked — not yet",
                                "error" if outcome.error else "info")
                step["error"] = outcome.error or ""
                step["output_summary"] = outcome.summary or step.get("output_summary", "")
                if outcome.output is not None:
                    step["output"] = _jsonable(outcome.output)
                step["next_poll_at"] = iso_add(max(1, cfg.poll_minutes) / 60)
            else:
                self._apply(tx, stage, step, outcome, actor="ai")
                self._progress(tx)
            self._commit(tx)
        self._dispatch(tx)

    async def flag_sla(self, pid: str, sid: str) -> None:
        async with self._lock(pid):
            project = self.c.store.get("projects", pid)
            if project is None or project.get("status") in TERMINAL_PROJECT:
                return
            _, step = self._find(project, sid)
            due = parse_iso(step.get("due_at"))
            if step.get("sla_breached") or step.get("status") not in OPEN or due is None \
                    or due > datetime.now(timezone.utc):
                return
            tx = _Tx(project)
            step["sla_breached"] = True
            self._trace(project, step, f"SLA breached: due {step.get('due_at')}.", "error")
            self.c.record_event("project.updated", f"{project.get('key')}: SLA breached on '{step.get('name')}'",
                                actor="scheduler", project_id=pid, step_id=sid, data={"sla_breached": True})
            if step.get("type") == "approval" and step.get("status") == "waiting_approval":
                recipients = self._approver_ids(project, step)
            else:
                recipients = self._responsible(project, step)
            recipients = list(dict.fromkeys([*recipients, *([project["owner_id"]] if project.get("owner_id") else [])]))
            if recipients:
                title = f"{project.get('key')} · Overdue: {step.get('name')}"
                body = f"This step was due {step.get('due_at')}."
                tx.after.append(lambda: self.c.notifier.notify(recipients, "warning", title, body,
                                                               project_id=pid, step_id=sid))
            self._commit(tx)
        self._dispatch(tx)

    async def refresh_risk(self, pid: str) -> None:
        async with self._lock(pid):
            project = self.c.store.get("projects", pid)
            if project is None:
                return
            children = [c for c in (self.c.store.get("projects", cid) for cid in project.get("child_ids") or []) if c]
            risk = compute_risk(project, datetime.now(timezone.utc), children)
            old = project.get("risk") or {}
            if (old.get("score"), old.get("level"), old.get("reasons")) == (risk["score"], risk["level"],
                                                                            risk["reasons"]):
                return
            project["risk"] = risk
            stored = self.c.store.put("projects", project)
            self.c.bus.emit("project.updated", project_id=pid, summary=self.summary(stored))


__all__ = ["WorkflowEngine"]
