"""Contract between the workflow engine (engine.py, executors_flow.py) and the AI/MCP step
executors (executors_ai.py). See docs/SPEC.md §12.

The engine owns persistence and state transitions. An executor receives a StepCtx, does its
work (LLM calls, MCP calls) and returns a StepOutcome describing what happened. It never
writes the project document itself — the engine applies the outcome under the project lock.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Literal

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

OutcomeStatus = Literal[
    "done", "failed", "waiting_human", "waiting_approval", "waiting_children", "waiting_external",
]


@dataclass
class StepCtx:
    container: "Container"
    project: dict[str, Any]          # snapshot of the project document (read-only for executors)
    stage: dict[str, Any]
    step: dict[str, Any]             # the StepRun dict being executed (read-only for executors)
    tctx: dict[str, Any]             # Jinja context — docs/SPEC.md §4
    brief: str                       # compact project brief for LLM prompts ("" when include_context is false)
    autonomy: str                    # effective autonomy: supervised | approve_writes | full
    user_id: str = ""                # human who triggered this execution, "" for automatic runs
    on_trace: Callable[[dict[str, Any]], None] | None = None   # engine-provided sink

    def trace(self, text: str, kind: str = "info", agent: str = "", data: Any = None) -> None:
        """Append a TraceEntry to the step (live via WebSocket `step.trace`). Executors call this
        for every meaningful thing they do: prompt sent, tool called, result received, error."""
        if self.on_trace is not None:
            self.on_trace({"kind": kind, "agent": agent, "text": text, "data": data})


@dataclass
class StepOutcome:
    status: OutcomeStatus
    output: Any = None                       # stored in project.vars[store_as or step.id] when done
    summary: str = ""                        # one-line human summary → step.output_summary
    error: str = ""                          # set when status == "failed"
    retryable: bool = True                   # False → no automatic retry (e.g. misconfiguration)
    artifact: dict[str, Any] | None = None   # {"title", "kind": "markdown"|"json", "content", "data"}
    pending_action: dict[str, Any] | None = None   # PendingAction dict when waiting on a human confirmation
    links: list[dict[str, Any]] = field(default_factory=list)   # Link dicts to add to the project
    checks: list[dict[str, Any]] | None = None     # quality_gate CheckResult dicts
    agent_state: dict[str, Any] | None = None      # resumable agent transcript (agent steps/ops)
    ai: bool = True                          # completed by AI (KPI automation share / hours saved)
    form: dict[str, Any] | None = None       # values to merge into step.form (AI drafts)
    ai_draft: dict[str, Any] | None = None
    estimate: dict[str, Any] | None = None
    brief: str | None = None


def ok(output: Any = None, summary: str = "", **kw: Any) -> StepOutcome:
    return StepOutcome(status="done", output=output, summary=summary, **kw)


def fail(error: str, *, retryable: bool = True, **kw: Any) -> StepOutcome:
    return StepOutcome(status="failed", error=error, retryable=retryable, **kw)
