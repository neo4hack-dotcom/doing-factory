"""AI / MCP step executors (SPEC §5, §5b, §12): ai_task, mcp_operation, agent_task, quality_gate,
plus the AI helpers the flow executors use (form drafts, estimate suggestions, approval briefs,
critic advice, notification composition).

Each executor reads a StepCtx, does its LLM / MCP work and returns a StepOutcome; the engine
persists it. The step executors never raise: what goes wrong becomes a failed outcome whose
`retryable` flag says whether an automatic retry can help — a model that returned bad JSON
can do better next time, a missing operation or a broken template cannot, and a write whose
delivery is uncertain must not be repeated blindly. The helpers (draft_form, …) do raise;
their callers decide. critic_advice never raises: no advice is a valid answer.

Every LLM call carries the project and step ids (metrics, KPIs) and every step traces what it
sent and what came back, truncated, so a reviewer can see why the AI said what it said. A
retried step gets the critic's advice (`heal_hint`) and a reopened one the reviewer's
`feedback` appended to its prompt, unless the prompt template already places them.
"""
from __future__ import annotations

import functools
import json
import logging
import re
from typing import Any, Awaitable, Callable

from pydantic import ValidationError

from app.engine import templating
from app.engine.context import StepCtx, StepOutcome, fail, ok
from app.errors import (EngineError, FactoryError, Forbidden, LLMError, LLMNotConfigured, MCPError, NotConfigured,
                        NotFound, TemplateError)
from app.mcp.agent import AgentOutcome, compact, run_agent
from app.mcp.operations import failure_kind
from app.models import (AgentTaskConfig, AiTaskConfig, ApprovalConfig, Estimate, EstimationConfig, HumanFormConfig,
                        LinkSpec, McpOperationConfig, NotifyConfig, OperationResult, QualityGateConfig)
from app.util import now_iso, parse_iso, parse_json, truncate, validation_message

log = logging.getLogger("factory.executors")

TRACE_CHARS = 1500       # prompt / answer excerpts kept in a step's trace
GATE_BATCH = 4           # rules per compliance call: small models lose track beyond that
PREVIOUS_OUTPUT_CHARS = 6000
CHECK_TEXT_CHARS = 400

# ---------------------------------------------------------------------------
# Shared plumbing
# ---------------------------------------------------------------------------

_NON_RETRYABLE = (NotConfigured, TemplateError, EngineError, Forbidden, NotFound)


def _failure(sc: StepCtx, exc: BaseException) -> StepOutcome:
    """An exception as a failed outcome, with the retry policy its kind implies."""
    if isinstance(exc, FactoryError):
        message = exc.message
        if isinstance(exc, LLMNotConfigured) or isinstance(exc, _NON_RETRYABLE):
            retryable = False
        elif isinstance(exc, (LLMError, MCPError)):
            retryable = True
        else:   # input problems (422), unimplemented pieces (501): the same call fails the same way
            retryable = exc.status_code >= 500 and exc.status_code != 501
    else:
        log.exception("Step %s failed unexpectedly", sc.step.get("id"))
        message, retryable = f"{type(exc).__name__}: {exc}", True
    sc.trace(message, kind="error")
    return fail(message, retryable=retryable)


def _guarded(fn: Callable[..., Awaitable[StepOutcome]]) -> Callable[..., Awaitable[StepOutcome]]:
    @functools.wraps(fn)
    async def wrapper(sc: StepCtx, *args: Any, **kwargs: Any) -> StepOutcome:
        try:
            return await fn(sc, *args, **kwargs)
        except Exception as exc:  # noqa: BLE001 — a step executor reports, it never raises
            return _failure(sc, exc)
    return wrapper


def _config(sc: StepCtx, model: type) -> Any:
    try:
        return model.model_validate(sc.step.get("config") or {})
    except ValidationError as exc:
        raise EngineError(f"Step '{sc.step.get('name') or sc.step.get('id')}' has an invalid configuration — "
                          f"{validation_message(exc)}. Fix it in Studio › Blueprints.") from exc


def _render(sc: StepCtx, template: str, extra: dict[str, Any] | None = None) -> str:
    if not template:
        return ""
    return templating.render(template, {**sc.tctx, **(extra or {})})


def _ids(sc: StepCtx) -> dict[str, str]:
    return {"project_id": sc.project.get("id") or "", "step_id": sc.step.get("id") or ""}


def _label(sc: StepCtx) -> str:
    key, title = sc.project.get("key") or "", sc.project.get("title") or ""
    return f"{key} — {title}" if key and title else key or title or "this project"


def _step_name(sc: StepCtx) -> str:
    return sc.step.get("name") or sc.step.get("id") or "this step"


def _user_name(sc: StepCtx) -> str:
    user = sc.container.get_user(sc.user_id) if sc.user_id else None
    return (user or {}).get("name") or sc.user_id or "a reviewer"


async def _ask(sc: StepCtx, role: str, user: str, *, prompt_key: str, **kwargs: Any) -> Any:
    """AIRuntime.ask with the step's ids, traced both ways (truncated)."""
    sc.trace(f"Prompt sent to the model ({prompt_key}, {len(user)} characters).", kind="ai", agent=role,
             data={"prompt": truncate(user, TRACE_CHARS)})
    answer = await sc.container.ai.ask(role, user, prompt_key=prompt_key, **_ids(sc), **kwargs)
    shown = answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False, default=str)
    sc.trace(f"The model answered ({len(shown)} characters).", kind="ai", agent=role,
             data={"answer": truncate(shown, TRACE_CHARS)})
    return answer


def _retry_notes(sc: StepCtx, template: str) -> str:
    """Reviewer feedback and the critic's advice for a re-run, unless the template places them."""
    notes = []
    feedback = str(sc.tctx.get("feedback") or sc.step.get("feedback") or "").strip()
    if feedback and "feedback" not in (template or ""):
        notes.append(f"Reviewer feedback on the previous version (address every point):\n{feedback}")
    hint = str(sc.step.get("heal_hint") or "").strip()
    if hint:
        error = str(sc.step.get("error") or "").strip()
        notes.append("A previous attempt failed" + (f" ({truncate(error, 300)})" if error else "")
                     + f". Advice for this attempt: {hint}")
    return "\n\n".join(notes)


def _first_line(text: str, limit: int = 160) -> str:
    for line in (text or "").splitlines():
        cleaned = re.sub(r"^[#>*\-\s|]+", "", line).strip()
        if cleaned:
            return truncate(cleaned, limit)
    return ""


def as_text(value: Any) -> str:
    """A var or output as readable text for a prompt: Markdown as is, objects as `key: value`."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if isinstance(value.get("markdown"), str) and len(value) == 1:
            return value["markdown"]
        lines = []
        for key, sub in value.items():
            if isinstance(sub, str) and "\n" in sub:
                lines.append(f"{key}:\n{sub}")
            elif isinstance(sub, (dict, list)):
                lines.append(f"{key}: {json.dumps(sub, ensure_ascii=False, default=str)}")
            else:
                lines.append(f"{key}: {sub}")
        return "\n".join(lines)
    if isinstance(value, list):
        return "\n".join(f"- {as_text(item) if not isinstance(item, (dict, list)) else compact(item, 600)}"
                         for item in value)
    return str(value)


def _var_of_steps(sc: StepCtx) -> dict[str, str]:
    """step id → the var its output is stored in."""
    out = {}
    for stage in sc.project.get("stages") or []:
        for step in stage.get("steps") or []:
            out[step.get("id") or ""] = step.get("store_as") or step.get("id") or ""
    return out


def _context_chars(sc: StepCtx) -> int:
    return max(2000, int(sc.container.app_settings().engine.context_chars or 6000))


# ---------------------------------------------------------------------------
# ai_task
# ---------------------------------------------------------------------------

@_guarded
async def exec_ai_task(sc: StepCtx) -> StepOutcome:
    return await _ai_task(sc)


@_guarded
async def regenerate_ai_task(sc: StepCtx, instructions: str) -> StepOutcome:
    return await _ai_task(sc, regenerate=instructions or "")


async def _ai_task(sc: StepCtx, regenerate: str | None = None) -> StepOutcome:
    cfg: AiTaskConfig = _config(sc, AiTaskConfig)
    if not cfg.prompt.strip():
        raise EngineError(f"Step '{_step_name(sc)}' has no prompt — write one in Studio › Blueprints.")
    prompt = _render(sc, cfg.prompt).strip()
    if regenerate is not None:
        previous = _output_text(sc.step.get("output"))
        prompt += (f"\n\nPrevious version:\n{truncate(previous, PREVIOUS_OUTPUT_CHARS) or '(none)'}\n\n"
                   f"Write a new version that applies all of these reviewer instructions:\n"
                   f"{regenerate.strip() or 'Improve it.'}")
    notes = _retry_notes(sc, cfg.prompt)
    if notes:
        prompt += "\n\n" + notes
    if cfg.include_context and sc.brief:
        prompt += f"\n\nProject brief:\n{sc.brief}"
    key = cfg.system_prompt or "writer"
    title = cfg.artifact_title or _step_name(sc)
    if cfg.output == "json":
        value = await _ask(sc, key, prompt, prompt_key=key, json=True, json_schema=cfg.json_schema or None)
        output: Any = value
        artifact = {"title": title, "kind": "json", "content": json.dumps(value, indent=2, ensure_ascii=False),
                    "data": value}
        summary = json_summary(value)
    else:
        text = _unfence(await _ask(sc, key, prompt, prompt_key=key))
        output = {"markdown": text}
        artifact = {"title": title, "kind": "markdown", "content": text, "data": None}
        summary = _first_line(text)
    if cfg.review or sc.autonomy == "supervised":
        why = "this step is reviewed" if cfg.review else "the autonomy level is supervised"
        return StepOutcome(status="waiting_human", output=output, summary=f"Draft ready for review — {summary}",
                           artifact=artifact, pending_action={
                               "kind": "ai_review", "title": f"Review the AI draft: {title}",
                               "description": f"The AI drafted this output and {why}: approve it, edit it, or "
                                              f"regenerate it with instructions.",
                               "payload": {"output": output, "format": cfg.output, "artifact_title": title},
                               "created_at": now_iso()})
    return ok(output, summary, artifact=artifact)


def _unfence(text: str) -> str:
    """A Markdown answer the model wrapped whole in a ``` fence, unwrapped."""
    match = re.fullmatch(r"\s*```(?:markdown|md)?\s*\n(.*?)\n?```\s*", text or "", re.S | re.I)
    return (match.group(1) if match else text or "").strip()


def _output_text(output: Any) -> str:
    if isinstance(output, dict) and isinstance(output.get("markdown"), str):
        return output["markdown"]
    if isinstance(output, (dict, list)):
        return json.dumps(output, indent=2, ensure_ascii=False, default=str)
    return "" if output is None else str(output)


def json_summary(value: Any) -> str:
    """One line for a JSON step output: its summary-like field, else its main list's size."""
    if isinstance(value, list):
        return f"{len(value)} item{'' if len(value) == 1 else 's'}"
    if not isinstance(value, dict):
        return truncate(str(value), 160)
    for key in ("summary", "title", "name", "team_name", "decision", "recommendation", "rationale"):
        if isinstance(value.get(key), str) and value[key].strip():
            text = truncate(" ".join(value[key].split()), 160)
            return f"{text} ({value['rationale'][:0]})".replace(" ()", "") if key == "team_name" else text
    for key, sub in value.items():
        if isinstance(sub, list):
            return f"{len(sub)} {key.replace('_', ' ')}"
    return truncate(", ".join(f"{k}: {v}" for k, v in value.items() if not isinstance(v, (dict, list))), 160)


# ---------------------------------------------------------------------------
# mcp_operation
# ---------------------------------------------------------------------------

@_guarded
async def exec_mcp_operation(sc: StepCtx) -> StepOutcome:
    cfg: McpOperationConfig = _config(sc, McpOperationConfig)
    if not cfg.operation_key:
        raise EngineError(f"Step '{_step_name(sc)}' names no operation — pick one in Studio › Blueprints.")
    ops = sc.container.ops
    op = ops.resolve(cfg.operation_key)
    connector = ops.connector_for(op)
    data = templating.render_obj(cfg.input or {}, sc.tctx)
    if not isinstance(data, dict):
        raise TemplateError(f"The input of step '{_step_name(sc)}' must render to an object.")
    if op.get("mode") != "agent" and op.get("sensitive") and sc.autonomy != "full":
        prepared = await ops.run(op, data, ctx=sc.tctx, prepare_only=True, autonomy=sc.autonomy, trace=sc.trace,
                                 **_ids(sc))
        if not prepared.ok:
            return _op_failed(op, connector, prepared)
        title = f"Confirm: {op.get('name') or op.get('key')}"
        description = (f"{op.get('description') or op.get('name')} This call is sent to {connector.get('name')} only "
                       f"after you confirm; you can edit the arguments first.").strip()
        sc.trace(f"Waiting for a human to confirm {prepared.tool}({compact(prepared.args, 200)}).", kind="human")
        return StepOutcome(status="waiting_human", summary=f"Waiting for confirmation: {op.get('name') or op.get('key')}",
                           pending_action={"kind": "confirm_operation", "title": title, "description": description,
                                           "payload": {"operation_key": op.get("key"), "operation_name": op.get("name"),
                                                       "connector": connector.get("name"), "connector_id": connector["id"],
                                                       "tool": prepared.tool, "args": prepared.args,
                                                       "mode": op.get("mode"), "input": data, "title": title,
                                                       "description": description},
                                           "created_at": now_iso()})
    result = await ops.run(op, data, ctx=sc.tctx, autonomy=sc.autonomy, trace=sc.trace, **_ids(sc))
    return _op_outcome(sc, cfg, op, connector, result, data)


def _op_outcome(sc: StepCtx, cfg: McpOperationConfig, op: dict[str, Any], connector: dict[str, Any],
                result: OperationResult, data: dict[str, Any]) -> StepOutcome:
    raw = result.raw if isinstance(result.raw, dict) else {}
    if result.summary == "needs_confirmation" and raw.get("pending"):
        pending = raw["pending"]
        return StepOutcome(status="waiting_human", summary=f"Waiting for confirmation: {pending.get('tool')}",
                           agent_state=raw.get("agent_state"),
                           pending_action=_agent_pending(pending, raw.get("actions") or [],
                                                         operation_key=op.get("key") or "", input=data))
    if not result.ok:
        return _op_failed(op, connector, result)
    links = _links(sc, cfg.create_link, result.output)
    return ok(result.output, result.summary or f"{op.get('name') or op.get('key')} done", links=links)


def _op_failed(op: dict[str, Any], connector: dict[str, Any], result: OperationResult) -> StepOutcome:
    kind = failure_kind(result)
    error = result.error or "The operation failed."
    if kind == "transport" and op.get("sensitive"):
        error += (f" The call may or may not have reached {connector.get('name')}: check there before retrying.")
    retryable = {"tool": op.get("mode") != "direct",          # same arguments, same answer
                 "transport": not op.get("sensitive"),         # a write may have landed
                 "extract": False, "mapping": False}.get(kind, True)
    return fail(error, retryable=retryable)


def _links(sc: StepCtx, spec: LinkSpec | None, output: Any) -> list[dict[str, Any]]:
    if spec is None:
        return []
    ctx = {"output": output}
    try:
        label, url, external = (_render(sc, spec.label, ctx).strip(), _render(sc, spec.url, ctx).strip(),
                                _render(sc, spec.external_id, ctx).strip())
    except FactoryError as exc:   # the operation itself succeeded: a broken link template must not undo it
        sc.trace(f"No link added: {exc.message}", kind="error")
        return []
    if not (url or external):
        sc.trace("No link added: the output has no URL or id for it.", kind="info")
        return []
    status = output.get("status") if isinstance(output, dict) and isinstance(output.get("status"), str) else ""
    return [{"kind": spec.kind, "label": label or external or url, "url": url, "external_id": external,
             "status": status, "step_id": sc.step.get("id") or "", "created_at": now_iso()}]


def _agent_pending(pending: dict[str, Any], actions: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    tool = pending.get("tool") or "a tool"
    where = pending.get("connector_name") or "its connector"
    title = f"Allow the agent to call {tool}?"
    description = (pending.get("thought") or "").strip() or f"The agent wants to call {tool} on {where}."
    done = [{"n": a.get("n"), "tool": a.get("tool"), "status": a.get("status"), "summary": a.get("summary")}
            for a in actions]
    return {"kind": "agent_tool_call", "title": title, "description": truncate(description, 600),
            "payload": {**pending, **{k: v for k, v in extra.items() if v not in (None, "")}, "actions": done,
                        "title": title, "description": truncate(description, 600)},
            "created_at": now_iso()}


# ---------------------------------------------------------------------------
# agent_task
# ---------------------------------------------------------------------------

@_guarded
async def exec_agent_task(sc: StepCtx) -> StepOutcome:
    return await _agent_task(sc)


async def _agent_task(sc: StepCtx, state: dict | None = None, confirmed: dict | None = None) -> StepOutcome:
    cfg: AgentTaskConfig = _config(sc, AgentTaskConfig)
    engine = sc.container.app_settings().engine
    goal = ""
    if state is None:
        if not cfg.goal.strip():
            raise EngineError(f"Step '{_step_name(sc)}' has no goal — write one in Studio › Blueprints.")
        goal = _render(sc, cfg.goal).strip()
        notes = _retry_notes(sc, cfg.goal)
        if notes:
            goal += "\n\n" + notes
    outcome = await run_agent(sc.container, goal=goal or (state or {}).get("goal") or "",
                              connector_ids=cfg.connector_ids, allowed_tools=cfg.allowed_tools,
                              max_actions=cfg.max_actions or engine.max_agent_actions,
                              timeout_s=engine.agent_timeout_s, output_schema=cfg.output_schema or None,
                              autonomy=sc.autonomy, context=sc.brief if cfg.include_context else "",
                              state=state, confirmed=confirmed, trace=sc.trace, **_ids(sc))
    return _agent_outcome(sc, cfg, outcome)


def _agent_outcome(sc: StepCtx, cfg: AgentTaskConfig, outcome: AgentOutcome) -> StepOutcome:
    if outcome.status == "needs_confirmation":
        pending = outcome.pending or {}
        return StepOutcome(status="waiting_human", summary=f"Waiting for confirmation: {pending.get('tool')}",
                           agent_state=outcome.state, pending_action=_agent_pending(pending, outcome.actions))
    if outcome.status != "done":
        return fail(outcome.final or "The agent failed without an answer.", retryable=True)
    output = outcome.data if cfg.output_schema else {"final": outcome.final}
    calls = len(outcome.actions)
    head = json_summary(outcome.data) if cfg.output_schema else _first_line(outcome.final)
    summary = f"{head} · {calls} tool call{'' if calls == 1 else 's'}" if head else f"{calls} tool calls"
    artifact = {"title": cfg.artifact_title or _step_name(sc), "kind": "markdown",
                "content": agent_report(outcome, structured=bool(cfg.output_schema)), "data": outcome.data}
    return ok(output, summary, artifact=artifact)


def _cell(value: Any, limit: int = 90) -> str:
    text = value if isinstance(value, str) else compact(value, limit)
    return truncate(" ".join(str(text).split()), limit).replace("|", "\\|") or "—"


def _table(rows: list[dict[str, Any]], max_cols: int = 6) -> str:
    cols: list[str] = []
    for row in rows:
        for key in row:
            if key not in cols and len(cols) < max_cols:
                cols.append(key)
    head = "| " + " | ".join(c.replace("_", " ").capitalize() for c in cols) + " |"
    sep = "|" + "---|" * len(cols)
    body = ["| " + " | ".join(_cell(row.get(c, "")) for c in cols) + " |" for row in rows[:40]]
    return "\n".join([head, sep, *body])


def agent_report(outcome: AgentOutcome, structured: bool) -> str:
    """The agent_task artifact: its answer, the structured result as tables, the actions taken."""
    parts = []
    final = (outcome.final or "").strip()
    if final and not (structured and parse_json(final) is not None):
        parts.append(final)
    data = outcome.data
    if structured and isinstance(data, dict):
        for key, value in data.items():
            title = key.replace("_", " ").capitalize()
            if isinstance(value, list) and value and all(isinstance(v, dict) for v in value):
                parts.append(f"### {title}\n{_table(value)}")
            elif isinstance(value, list):
                parts.append(f"### {title}\n" + ("\n".join(f"- {_cell(v, 200)}" for v in value) or "- none"))
            else:
                parts.append(f"**{title}:** {_cell(value, 300)}")
    elif structured and data is not None:
        parts.append("```json\n" + json.dumps(data, indent=2, ensure_ascii=False) + "\n```")
    if outcome.actions:
        rows = [{"#": a.get("n"), "tool": a.get("tool"), "arguments": compact(a.get("args"), 120),
                 "result": a.get("summary") or a.get("status")} for a in outcome.actions]
        parts.append("### Actions\n" + _table(rows))
    return "\n\n".join(parts) or "_The agent produced no answer._"


# ---------------------------------------------------------------------------
# Confirmations
# ---------------------------------------------------------------------------

async def resolve_confirmation(sc: StepCtx, approve: bool, payload: dict | None) -> StepOutcome:
    """A human answered the step's pending action. confirm_operation: approve runs the prepared
    call (with the human's edited args); reject fails the step for good. agent_tool_call: the
    agent resumes, told what the human decided (approve_all lets its later writes through).
    ai_review: approve keeps the draft (or the edited one); reject regenerates with the
    instructions. Raises EngineError when the step is not waiting for any of these."""
    pending = sc.step.get("pending_action") or {}
    kind = pending.get("kind")
    if kind == "gate_review":
        raise EngineError("A quality gate is resolved with its own actions: override, re-run or send back.")
    if kind not in ("confirm_operation", "agent_tool_call", "ai_review"):
        raise EngineError(f"Step '{_step_name(sc)}' is not waiting for a confirmation.")
    return await _resolve(sc, kind, bool(approve), dict(payload or {}), pending.get("payload") or {})


@_guarded
async def _resolve(sc: StepCtx, kind: str, approve: bool, body: dict[str, Any], stored: dict[str, Any]) -> StepOutcome:
    who = _user_name(sc)
    comment = str(body.get("comment") or "").strip()
    edited = body.get("args") if isinstance(body.get("args"), dict) else None
    if kind == "ai_review":
        if not approve:
            return await _ai_task(sc, regenerate=str(body.get("instructions") or comment))
        output = body.get("output", sc.step.get("output"))
        if isinstance(body.get("markdown"), str):
            output = {"markdown": body["markdown"]}
        sc.trace(f"Approved by {who}.", kind="human")
        summary = json_summary(output) if not (isinstance(output, dict) and "markdown" in output) \
            else _first_line(output["markdown"])
        return ok(output, summary or f"Approved by {who}")
    if kind == "confirm_operation":
        if not approve:
            sc.trace(f"Rejected by {who}." + (f" {comment}" if comment else ""), kind="human")
            return fail(f"Rejected by {who}" + (f": {comment}" if comment else ""), retryable=False, ai=False)
        cfg: McpOperationConfig = _config(sc, McpOperationConfig)
        ops = sc.container.ops
        op = ops.resolve(stored.get("operation_key") or cfg.operation_key)
        connector = ops.connector_for(op)
        args = edited if edited is not None else dict(stored.get("args") or {})
        data = stored.get("input") if isinstance(stored.get("input"), dict) else templating.render_obj(cfg.input, sc.tctx)
        changed = args != (stored.get("args") or {})
        sc.trace(f"Confirmed by {who}" + (" with edited arguments." if changed else "."), kind="human",
                 data={"args": args} if changed else None)
        result = await ops.run(op, data, ctx=sc.tctx, args_override=args, autonomy="full", trace=sc.trace, **_ids(sc))
        return _op_outcome(sc, cfg, op, connector, result, data)
    # agent_tool_call
    state = sc.step.get("agent_state")
    if not state:
        return fail("The agent's saved state is missing, so its run cannot resume — press Retry to start it again.",
                    retryable=False)
    confirmed = {"approve": approve, "args": edited, "approve_all": bool(body.get("approve_all")), "comment": comment}
    sc.trace(f"{'Approved' if approve else 'Declined'} by {who}"
             + (" (and every further write of this run)" if approve and confirmed["approve_all"] else "") + ".",
             kind="human")
    if sc.step.get("type") == "mcp_operation":
        cfg = _config(sc, McpOperationConfig)
        ops = sc.container.ops
        op = ops.resolve(stored.get("operation_key") or cfg.operation_key)
        connector = ops.connector_for(op)
        data = stored.get("input") if isinstance(stored.get("input"), dict) else {}
        result = await ops.run(op, data, ctx=sc.tctx, agent_state=state, confirmed=confirmed, autonomy=sc.autonomy,
                               trace=sc.trace, **_ids(sc))
        return _op_outcome(sc, cfg, op, connector, result, data)
    return await _agent_task(sc, state=state, confirmed=confirmed)


# ---------------------------------------------------------------------------
# quality_gate
# ---------------------------------------------------------------------------

_SEVERITY = {"low": 0, "medium": 1, "high": 2, "critical": 3}
_BLOCK_AT = {"any": 0, "medium": 1, "high": 2, "critical": 3}


@_guarded
async def exec_quality_gate(sc: StepCtx) -> StepOutcome:
    return await _gate(sc, None)


async def rerun_gate(sc: StepCtx, rule_ids: list[str] | None) -> StepOutcome:
    """Re-evaluate `rule_ids` (ids or codes; None = every rule) and keep the other checks —
    their overrides included. Raises EngineError when none of the ids belongs to the gate."""
    if rule_ids:
        rules = _gate_rules(sc, _config(sc, QualityGateConfig))
        wanted = {str(r).strip().lower() for r in rule_ids}
        if not any((r.get("id") or "").lower() in wanted or (r.get("code") or "").lower() in wanted for r in rules):
            raise EngineError("None of the rules to re-run belongs to this quality gate.")
    return await _gate_guarded(sc, rule_ids or None)


@_guarded
async def _gate_guarded(sc: StepCtx, only: list[str] | None) -> StepOutcome:
    return await _gate(sc, only)


def _gate_rules(sc: StepCtx, cfg: QualityGateConfig) -> list[dict[str, Any]]:
    rules = [r for r in sc.container.store.list("rules") if r.get("enabled", True)]
    if cfg.rule_ids:
        wanted = {str(r).lower() for r in cfg.rule_ids}
        rules = [r for r in rules if (r.get("id") or "").lower() in wanted or (r.get("code") or "").lower() in wanted]
    elif cfg.rule_tags:
        tags = {t.lower() for t in cfg.rule_tags}
        rules = [r for r in rules if tags & {t.lower() for t in r.get("tags") or []}]
    return sorted(rules, key=lambda r: (r.get("code") or r.get("id") or ""))


def _check(rule: dict[str, Any], status: str, evidence: str = "", recommendation: str = "") -> dict[str, Any]:
    return {"rule_id": rule.get("id") or "", "code": rule.get("code") or "", "title": rule.get("title") or "",
            "severity": rule.get("severity") if rule.get("severity") in _SEVERITY else "medium", "status": status,
            "evidence": truncate(evidence, CHECK_TEXT_CHARS), "recommendation": truncate(recommendation, CHECK_TEXT_CHARS),
            "overridden_by": "", "override_comment": ""}


async def _gate(sc: StepCtx, only: list[str] | None) -> StepOutcome:
    cfg: QualityGateConfig = _config(sc, QualityGateConfig)
    rules = _gate_rules(sc, cfg)
    if not rules:
        sc.trace("No enabled compliance rule matches this gate — nothing to check.", kind="info")
        return ok({"passed": True, "checks": [], "failed": [], "overridden": False},
                  "No compliance rule matches this gate — nothing to check.", checks=[])
    wanted = {str(r).lower() for r in only} if only else None
    target = [r for r in rules if wanted is None or (r.get("id") or "").lower() in wanted
              or (r.get("code") or "").lower() in wanted]
    fresh: dict[str, dict[str, Any]] = {}
    for rule in target:
        if rule.get("check") == "manual":
            fresh[rule["id"]] = _check(rule, "pending", "Manual check: " + (rule.get("guidance") or rule.get("description")
                                                                             or "a reviewer must confirm this rule."))
    ai_rules = [r for r in target if r.get("check") != "manual"]
    batches = [ai_rules[i:i + GATE_BATCH] for i in range(0, len(ai_rules), GATE_BATCH)]
    errors: list[str] = []
    if batches:
        evidence = gate_evidence(sc, cfg)
        for number, batch in enumerate(batches, 1):
            sc.trace(f"Checking rules {', '.join(r.get('code') or r['id'] for r in batch)} "
                     f"(batch {number}/{len(batches)}).", kind="info")
            try:
                verdicts = await _audit(sc, batch, evidence)
            except LLMNotConfigured:
                raise
            except LLMError as exc:
                errors.append(exc.message)
                verdicts = {}
                sc.trace(f"Batch {number} could not be evaluated: {exc.message}", kind="error")
            for rule in batch:
                fresh[rule["id"]] = verdicts.get(rule["id"]) or _check(
                    rule, "pending", "The AI returned no verdict for this rule"
                    + (f" ({truncate(errors[-1], 200)})" if errors and not verdicts else "")
                    + " — re-run the gate or check it manually.")
        if len(errors) == len(batches):
            raise LLMError(f"The compliance check could not run: {errors[0]}")
    previous = {c.get("rule_id"): c for c in sc.step.get("checks") or []}
    checks = [fresh.get(r["id"]) or previous.get(r["id"]) or _check(r, "pending", "Not evaluated yet — re-run the gate.")
              for r in rules]
    return _gate_verdict(cfg, checks)


async def _audit(sc: StepCtx, batch: list[dict[str, Any]], evidence: str) -> dict[str, dict[str, Any]]:
    """One compliance call for up to GATE_BATCH rules → {rule id: CheckResult dict}. Rules are
    named by their code (SEC-01): a small model copies a code far more reliably than an id."""
    ref = {(r.get("code") or r["id"]): r for r in batch}
    lines = []
    for code, rule in ref.items():
        lines.append(f"- rule_id: {code}\n  title: {rule.get('title')}\n  severity: {rule.get('severity')}\n"
                     f"  requirement: {' '.join((rule.get('description') or '').split())}\n"
                     f"  how to check: {' '.join((rule.get('guidance') or 'judge from the requirement').split())}")
    user = (f"Project: {_label(sc)}\nDeliverable under review: {_step_name(sc)}\n\n"
            f"Rules to check ({len(ref)}):\n" + "\n".join(lines)
            + f"\n\nEvidence:\n{evidence or '(no evidence was provided)'}\n\n"
            "Return one check per rule, in the order given, with the exact rule_id.")
    schema = {"type": "object", "required": ["checks"], "properties": {"checks": {
        "type": "array", "items": {"type": "object", "required": ["rule_id", "status", "evidence", "recommendation"],
                                   "properties": {"rule_id": {"type": "string", "enum": list(ref)},
                                                  "status": {"type": "string", "enum": ["pass", "fail", "warn", "na"]},
                                                  "evidence": {"type": "string"},
                                                  "recommendation": {"type": "string"}}}}}}
    value = await _ask(sc, "compliance_auditor", user, prompt_key="compliance_auditor", json_schema=schema)
    lookup = {code.lower(): rule for code, rule in ref.items()} | {r["id"].lower(): r for r in batch}
    out: dict[str, dict[str, Any]] = {}
    for item in (value.get("checks") if isinstance(value, dict) else None) or []:
        if not isinstance(item, dict):
            continue
        rule = lookup.get(str(item.get("rule_id") or "").strip().lower())
        status = str(item.get("status") or "").strip().lower()
        if rule is None or rule["id"] in out or status not in ("pass", "fail", "warn", "na"):
            continue
        out[rule["id"]] = _check(rule, status, str(item.get("evidence") or ""), str(item.get("recommendation") or ""))
    return out


def gate_evidence(sc: StepCtx, cfg: QualityGateConfig) -> str:
    """The deliverables the auditor reads: the named vars (all of them when none is named),
    plus — with no names — artifacts whose content is not already in a var. Truncated to fit."""
    variables = sc.project.get("vars") or {}
    names = list(cfg.evidence) or [k for k in variables]
    items: list[tuple[str, str]] = []
    for name in names:
        value = variables.get(name)
        items.append((name, as_text(value) if value not in (None, "", {}, []) else "(not provided)"))
    if not cfg.evidence:
        var_of = _var_of_steps(sc)
        for art in sc.project.get("artifacts") or []:
            if var_of.get(art.get("step_id") or "") not in variables:
                items.append((art.get("title") or "Document", art.get("content") or ""))
    if not items:
        return ""
    per_item = max(800, (_context_chars(sc) + 3000) // len(items))
    return "\n\n".join(f"### {name}\n{truncate(text, per_item)}" for name, text in items)


def _gate_verdict(cfg: QualityGateConfig, checks: list[dict[str, Any]]) -> StepOutcome:
    threshold = _BLOCK_AT.get(cfg.block_on, 2)
    live = [c for c in checks if not c.get("overridden_by")]
    fails = [c for c in checks if c.get("status") == "fail"]
    blocking = [c for c in live if c.get("status") == "fail" and _SEVERITY.get(c.get("severity"), 1) >= threshold]
    pending = [c for c in live if c.get("status") == "pending"]
    count = {s: sum(1 for c in checks if c.get("status") == s) for s in ("pass", "warn", "fail", "na", "pending")}
    tally = " · ".join(f"{n} {s}" for s, n in count.items() if n)
    passed = not blocking and not pending
    output = {"passed": passed, "checks": checks, "failed": [c.get("code") or c.get("rule_id") for c in fails],
              "overridden": any(c.get("overridden_by") for c in checks)}
    if passed:
        return ok(output, f"Gate passed — {tally}", checks=checks)
    reasons = []
    if blocking:
        reasons.append(f"{len(blocking)} blocking finding{'' if len(blocking) == 1 else 's'} "
                       f"({', '.join(c.get('code') or c.get('rule_id') for c in blocking)})")
    if pending:
        reasons.append(f"{len(pending)} manual check{'' if len(pending) == 1 else 's'} pending "
                       f"({', '.join(c.get('code') or c.get('rule_id') for c in pending)})")
    title = "Quality gate: " + " and ".join(reasons)
    return StepOutcome(status="waiting_human", output=output, checks=checks, summary=f"Gate blocked — {tally}",
                       pending_action={"kind": "gate_review", "title": title,
                                       "description": f"Blocking at severity '{cfg.block_on}'. Override (with a "
                                                      f"comment, role-gated), send the work back, or re-run the gate.",
                                       "payload": {"blocking": [c.get("rule_id") for c in blocking],
                                                   "pending": [c.get("rule_id") for c in pending],
                                                   "block_on": cfg.block_on, "override_roles": cfg.override_roles},
                                       "created_at": now_iso()})


# ---------------------------------------------------------------------------
# human_form AI draft
# ---------------------------------------------------------------------------

_SKIP = object()
_TRUE = {"true", "yes", "y", "1", "on", "x", "checked"}
_FALSE = {"false", "no", "n", "0", "off", "", "none", "unchecked"}


def _spec_like(sc: StepCtx, cfg: HumanFormConfig) -> bool:
    text = " ".join([sc.step.get("id") or "", sc.step.get("name") or "", cfg.artifact_title]).lower()
    return "spec" in text


def _field_line(field: Any, users: list[dict], teams: list[dict]) -> str:
    kind = field.type
    hint = {"number": "a number", "checkbox": "true or false", "date": "a date YYYY-MM-DD",
            "list": "a list of strings", "multiselect": "a list of strings", "url": "a URL",
            "markdown": "Markdown text", "textarea": "text"}.get(kind, "text")
    extra = ""
    if field.options:
        extra = "; one of: " + " | ".join(field.options)
    elif kind in ("user", "users"):
        extra = "; " + ("a list of " if kind == "users" else "one ") + "user id(s) from: " + ", ".join(
            f"{u.get('id')} ({u.get('name')})" for u in users[:25])
    elif kind == "team":
        extra = "; one team id from: " + ", ".join(f"{t.get('id')} ({t.get('name')})" for t in teams[:25])
    help_ = f" — {field.help}" if field.help else ""
    return f'- "{field.key}" ({hint}{", required" if field.required else ""}{extra}): {field.label or field.key}{help_}'


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        parts = value.splitlines() if "\n" in value else value.split(",") if "," in value else [value]
        return [re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", p).strip() for p in parts if p.strip()]
    return [] if value is None else [value]


def _list_item(item: Any) -> str:
    if isinstance(item, dict):   # {"name", "description"} → "name — description"
        name = item.get("name") or item.get("title") or item.get("key")
        desc = item.get("description") or item.get("summary")
        if name:
            return f"{name} — {desc}" if desc else str(name)
        return compact(item, 200)
    return str(item).strip()


def coerce_field(value: Any, field: Any, users: list[dict] | None = None, teams: list[dict] | None = None) -> Any:
    """One drafted value in the type its form field takes, or _SKIP when it cannot be used
    (an option the field does not offer, a user id that does not exist…)."""
    kind = field.type
    if value is None:
        return _SKIP
    if kind == "number":
        if isinstance(value, bool):
            return _SKIP
        if isinstance(value, (int, float)):
            return value
        match = re.search(r"-?\d+(?:[.,]\d+)?", str(value))
        if not match:
            return _SKIP
        number = float(match.group(0).replace(",", "."))
        return int(number) if number.is_integer() else number
    if kind == "checkbox":
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        return True if text in _TRUE else False if text in _FALSE else _SKIP
    if kind == "select":
        text = _list_item(value[0]) if isinstance(value, list) and value else str(value).strip()
        return next((o for o in field.options if o.lower() == text.lower()), _SKIP) if field.options else text
    if kind == "multiselect":
        picked = [next((o for o in field.options if o.lower() == _list_item(v).lower()), None) for v in _as_list(value)]
        return [p for p in picked if p] if field.options else [_list_item(v) for v in _as_list(value)]
    if kind == "list":
        return [s for s in (_list_item(v) for v in _as_list(value)) if s]
    if kind in ("user", "users", "team"):
        pool = (teams or []) if kind == "team" else (users or [])

        def match(v: Any) -> str | None:
            text = str(v).strip().lower()
            return next((p["id"] for p in pool if text in ((p.get("id") or "").lower(), (p.get("name") or "").lower(),
                                                           (p.get("email") or "").lower())), None)
        if kind == "users":
            found = [m for m in (match(v) for v in _as_list(value)) if m]
            return found or _SKIP
        found = match(value[0] if isinstance(value, list) and value else value)
        return found or _SKIP
    if kind == "date":
        text = str(value).strip()
        parsed = parse_iso(text) if text else None
        return parsed.strftime("%Y-%m-%d") if parsed else _SKIP
    # text, textarea, markdown, url
    if isinstance(value, list):
        text = "\n".join(f"- {_list_item(v)}" if kind in ("markdown", "textarea") else _list_item(v) for v in value)
    elif isinstance(value, dict):
        text = as_text(value)
    else:
        text = str(value)
    return text.strip() if text.strip() else _SKIP


def coerce_form(value: dict[str, Any], fields: list[Any], users: list[dict] | None = None,
                teams: list[dict] | None = None) -> dict[str, Any]:
    """A model's form draft keyed by the field keys, each value in its field's type; unknown
    keys and unusable values are dropped (the human fills them)."""
    out: dict[str, Any] = {}
    lowered = {str(k).lower(): v for k, v in value.items()}
    for field in fields:
        raw = value[field.key] if field.key in value else lowered.get(field.key.lower())
        coerced = coerce_field(raw, field, users, teams)
        if coerced is not _SKIP:
            out[field.key] = coerced
    return out


async def draft_form(sc: StepCtx, instructions: str = "") -> dict:
    """Field values for a human_form (`ai_prefill`, or a generic draft), typed per field.
    Raises LLMNotConfigured / LLMError — the engine reports them on the step."""
    cfg: HumanFormConfig = _config(sc, HumanFormConfig)
    if not cfg.fields:
        return {}
    users, teams = sc.container.users(), sc.container.teams()
    if cfg.ai_prefill.strip():
        task = _render(sc, cfg.ai_prefill).strip()
    else:
        task = (f'Draft the form "{_step_name(sc)}" of project {_label(sc)}.'
                + (f"\nInstructions given to the person who fills it: {cfg.instructions}" if cfg.instructions else ""))
    parts = [task]
    if instructions.strip():
        parts.append(f"Additional instructions from the user:\n{instructions.strip()}")
    notes = _retry_notes(sc, cfg.ai_prefill)
    if notes:
        parts.append(notes)
    current = {k: v for k, v in (sc.step.get("form") or {}).items() if v not in (None, "", [], {})}
    if current:
        parts.append("Values the user already entered (keep them unless the instructions say otherwise):\n"
                     + json.dumps(current, ensure_ascii=False, default=str))
    parts.append("Fields — return ONE JSON object with exactly these keys:\n"
                 + "\n".join(_field_line(f, users, teams) for f in cfg.fields))
    if cfg.include_context and sc.brief:
        parts.append(f"Project brief:\n{sc.brief}")
    key = "spec_writer" if _spec_like(sc, cfg) else "writer"
    value = await _ask(sc, "draft_form", "\n\n".join(parts), prompt_key=key, json=True)
    if not isinstance(value, dict):
        raise LLMError("The model did not return a JSON object for the form draft.")
    draft = coerce_form(value, cfg.fields, users, teams)
    dropped = [f.key for f in cfg.fields if f.key in value and f.key not in draft]
    if dropped:
        sc.trace(f"Draft values not usable as typed and left for you: {', '.join(dropped)}.", kind="info")
    return draft


# ---------------------------------------------------------------------------
# estimation suggestion
# ---------------------------------------------------------------------------

async def suggest_estimate(sc: StepCtx) -> dict:
    """An Estimate-shaped suggestion (value, unit, confidence, breakdown, rationale) for an
    estimation step. Raises LLMNotConfigured / LLMError."""
    cfg: EstimationConfig = _config(sc, EstimationConfig)
    unit = cfg.unit
    task = _render(sc, cfg.prompt).strip() if cfg.prompt.strip() else \
        f'Estimate the effort of "{_step_name(sc)}" for project {_label(sc)}.'
    parts = [task, f"Unit: {unit} ({'person-days' if unit == 'days' else 'story points'})."
             + (" A breakdown is required." if cfg.require_breakdown else "")]
    notes = _retry_notes(sc, cfg.prompt)
    if notes:
        parts.append(notes)
    if not cfg.prompt.strip() and sc.brief:
        parts.append(f"Project brief:\n{sc.brief}")
    schema = {"type": "object", "required": ["value", "confidence", "breakdown", "rationale"], "properties": {
        "value": {"type": "number"}, "unit": {"type": "string", "enum": [unit]},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "breakdown": {"type": "array", "items": {"type": "object", "required": ["item", "value"],
                                                 "properties": {"item": {"type": "string"}, "value": {"type": "number"}}}},
        "rationale": {"type": "string"}}}
    value = await _ask(sc, "estimator", "\n\n".join(parts), prompt_key="estimator", json_schema=schema)
    return normalise_estimate(value, unit, sc)


def normalise_estimate(value: Any, unit: str, sc: StepCtx | None = None) -> dict:
    data = value if isinstance(value, dict) else {}
    lines = []
    for line in data.get("breakdown") or []:
        if isinstance(line, dict) and str(line.get("item") or "").strip():
            amount = coerce_field(line.get("value"), _NumberField)
            lines.append({"item": str(line["item"]).strip(), "value": amount if amount is not _SKIP else 0})
    total = coerce_field(data.get("value"), _NumberField)
    total = None if total is _SKIP else total
    summed = round(sum(l["value"] for l in lines), 1) if lines else None
    if summed is not None and (total is None or abs(summed - total) > max(0.5, 0.1 * summed)):
        if sc is not None and total is not None:
            sc.trace(f"The suggested total ({total}) did not match its breakdown; using the breakdown sum ({summed}).",
                     kind="info")
        total = summed
    confidence = str(data.get("confidence") or "").lower()
    estimate = Estimate.model_validate({
        "value": total, "unit": unit, "confidence": confidence if confidence in ("low", "medium", "high") else "low",
        "breakdown": lines, "rationale": str(data.get("rationale") or "").strip()})
    return estimate.model_dump()


class _NumberField:   # coerce_field's view of a "number" form field
    type = "number"
    options: list[str] = []


# ---------------------------------------------------------------------------
# approval brief
# ---------------------------------------------------------------------------

async def approval_brief(sc: StepCtx) -> str:
    """The decision memo approvers read (Markdown), from the step's brief prompt, the vars it
    shows and the latest documents. Raises LLMNotConfigured / LLMError."""
    cfg: ApprovalConfig = _config(sc, ApprovalConfig)
    approvers = ", ".join(a.label or a.role for a in cfg.approvers) or "the approvers"
    task = _render(sc, cfg.brief_prompt).strip() if cfg.brief_prompt.strip() else \
        f'Decision requested: {approvers} approve the step "{_step_name(sc)}" of project {_label(sc)}.'
    budget = _context_chars(sc)
    variables = sc.project.get("vars") or {}
    shown = [n for n in cfg.show_vars if variables.get(n) not in (None, "", {}, [])]
    parts = [task]
    if shown:
        per = max(600, budget // (len(shown) + 1))
        parts.append("Data for the decision:\n" + "\n\n".join(f"### {n}\n{truncate(as_text(variables[n]), per)}"
                                                              for n in shown))
    var_of = _var_of_steps(sc)
    documents = [a for a in reversed(sc.project.get("artifacts") or []) if var_of.get(a.get("step_id") or "") not in shown]
    if documents and not cfg.brief_prompt.strip():
        per = max(600, budget // 3)
        parts.append("Latest documents:\n" + "\n\n".join(f"### {a.get('title')}\n{truncate(a.get('content'), per)}"
                                                         for a in documents[:2]))
    if not cfg.brief_prompt.strip() and sc.brief:
        parts.append(f"Project brief:\n{sc.brief}")
    return _unfence(await _ask(sc, "approval_brief", "\n\n".join(parts), prompt_key="approval_brief"))


# ---------------------------------------------------------------------------
# critic
# ---------------------------------------------------------------------------

async def critic_advice(sc: StepCtx, error: str) -> str:
    """One concrete correction for the next attempt of a failed step, or "" when the critic is
    off, no model is configured, or the model has nothing usable to say. Never raises."""
    try:
        c = sc.container
        if not c.app_settings().engine.critic_enabled or not c.ai.configured:
            return ""
        cfg = sc.step.get("config") or {}
        attempted = cfg.get("prompt") or cfg.get("goal") or cfg.get("operation_key") or cfg.get("items") or ""
        recent = [e.get("text") for e in (sc.step.get("trace") or [])[-6:] if isinstance(e, dict) and e.get("text")]
        user = (f"Step: {_step_name(sc)} ({sc.step.get('type')}) of project {_label(sc)}\n"
                f"Step goal: {sc.step.get('description') or _step_name(sc)}\n"
                f"What it runs: {truncate(str(attempted), 1200) or '(see the step type)'}\n"
                f"Attempt number: {int(sc.step.get('attempts') or 0) + 1}\n"
                + (f"Advice given for the previous attempt: {sc.step.get('heal_hint')}\n" if sc.step.get("heal_hint") else "")
                + ("Recent trace:\n" + "\n".join(f"- {truncate(t, 200)}" for t in recent) + "\n" if recent else "")
                + f"\nError:\n{truncate(error, 1500)}")
        verdict = await c.ai.ask("critic", user, prompt_key="critic", json=True, fast=True, **_ids(sc))
        if not isinstance(verdict, dict):
            return ""
        status = str(verdict.get("status") or "").lower()
        reason, advice = str(verdict.get("reason") or "").strip(), str(verdict.get("advice") or "").strip()
        if status == "ok" or not (reason or advice):
            return ""
        text = f"Retrying is unlikely to help: {reason} {advice}".strip() if status == "give_up" else (advice or reason)
        sc.trace(f"Critic: {text}", kind="thought", agent="critic")
        return truncate(text, 600)
    except Exception:  # noqa: BLE001 — no advice is a valid answer
        log.debug("Critic unavailable", exc_info=True)
        return ""


# ---------------------------------------------------------------------------
# notifications
# ---------------------------------------------------------------------------

async def compose_notification(sc: StepCtx, cfg: dict) -> tuple[str, str]:
    """(subject, body) of a notify step: subject rendered from `subject` when given, body
    written by the model from `prompt`, else rendered from `body` (no LLM). Raises
    LLMNotConfigured / LLMError / TemplateError."""
    ncfg = NotifyConfig.model_validate(cfg if cfg is not None else (sc.step.get("config") or {}))
    subject = " ".join(_render(sc, ncfg.subject).split()) if ncfg.subject else ""
    if ncfg.prompt.strip():
        task = _render(sc, ncfg.prompt).strip()
        if subject:
            task += f"\n\n(The subject line, already written: {subject})"
        body = _strip_subject(_unfence(await _ask(sc, "notifier", task, prompt_key="notifier")))
    elif ncfg.body.strip():
        body = _render(sc, ncfg.body).strip()
    else:
        body = ""
    if not subject:
        subject = _first_line(body, 120) or f"{sc.project.get('key') or 'Project'} · {_step_name(sc)}"
    return truncate(subject, 160), body or subject


def _strip_subject(text: str) -> str:
    return re.sub(r"^\s*\**subject\**\s*:.*\n+", "", text or "", flags=re.I).strip()
