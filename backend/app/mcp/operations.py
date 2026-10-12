"""OperationExecutor: runs an Operation — a named binding to one MCP tool — in direct, llm or
agent mode (SPEC §3.3, §7, §12).

* direct — the args template is rendered over `{input, ...ctx}`, typed against the tool's
  JSON schema, called; `output.extract` picks the useful part of the result.
* llm — the model builds the arguments from the operation's instructions, the tool schema and
  the input; they are checked against the schema (one corrective round) before any call; an
  optional `output.json_schema` pass maps the result to a fixed shape.
* agent — the bounded agent (app.mcp.agent) works toward the rendered goal with the tools of the
  operation's connector, pausing on every write it is not allowed to make alone.

The split of failures is deliberate. What a retry cannot fix — an unknown operation, a missing
or disabled connector, no LLM, a broken template, a required input left empty — raises a
FactoryError whose message names the screen to fix it in. Whatever happened at run time — the
tool said no, the server was unreachable, the model failed — is an OperationResult with
ok=False, the error, and the trace of every phase (secrets redacted). The last trace entry
of a failure says what kind it was (`failure_kind`), so a step can tell a harmless retry
from one that could write twice.
"""
from __future__ import annotations

import json
import re
import time
from typing import TYPE_CHECKING, Any

from jinja2 import Undefined
from pydantic import ValidationError

from app.engine import templating
from app.errors import FactoryError, LLMError, LLMNotConfigured, NotConfigured, TemplateError
from app.llm.runtime import schema_problem
from app.mcp.agent import Tracer, as_tracer, blank_paths, compact, elided_argument, redact, run_agent, ungrounded
from app.mcp.manager import WRITE_VERBS, tool_tokens
from app.models import Operation, OperationResult
from app.util import truncate, validation_message

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

PROMPT_INPUT_CHARS = 6000     # input data shown to the args builder
MAPPING_RESULT_CHARS = 8000   # tool result shown to the output-schema mapping pass
_BRACED = re.compile(r"^\s*\{\{(.*)\}\}\s*$", re.S)


def failure_kind(result: OperationResult) -> str:
    """Why a failed run failed: 'tool' (the tool answered with an error), 'transport' (the
    server could not be reached or timed out — a write may or may not have landed), 'llm',
    'agent', 'extract' / 'mapping' (the call succeeded, shaping its output did not). '' when
    the result is not a failure or says nothing."""
    for entry in reversed(result.trace):
        data = entry.data if isinstance(entry.data, dict) else {}
        if data.get("failure"):
            return str(data["failure"])
    return ""


def _strip_braces(expr: str) -> str:
    match = _BRACED.match(expr or "")
    return match.group(1).strip() if match and "{{" not in match.group(1) else (expr or "").strip()


def _native(value: Any) -> Any:
    """Jinja's Undefined (a path that does not exist in the result) is None to everything else."""
    return None if isinstance(value, Undefined) else value


# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

def _types(prop: Any) -> list[str]:
    kind = prop.get("type") if isinstance(prop, dict) else None
    return [kind] if isinstance(kind, str) else [k for k in kind if isinstance(k, str)] if isinstance(kind, list) else []


def _coerce(value: Any, types: list[str]) -> Any:
    """One value nudged toward its schema type — only unambiguous conversions (a form gives "10"
    where the tool takes 10; a template renders a list as its JSON text)."""
    if not types:
        return value
    if isinstance(value, str):
        text = value.strip()
        if "integer" in types and re.fullmatch(r"-?\d+", text):
            return int(text)
        if "number" in types and re.fullmatch(r"-?\d+(?:\.\d+)?", text):
            return float(text) if "." in text else int(text)
        if "boolean" in types and text.lower() in ("true", "false"):
            return text.lower() == "true"
        if "string" not in types and ("array" in types or "object" in types):
            if text[:1] in ("[", "{"):
                try:
                    parsed = json.loads(text)
                except ValueError:
                    return value
                return parsed
            if not text and "array" in types:
                return []
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if "string" in types and not {"integer", "number"} & set(types):
            return str(value)
    return value


def coerce_args(args: dict[str, Any], schema: dict[str, Any] | None) -> dict[str, Any]:
    """Arguments typed against the tool's input schema (top level). A None for an optional,
    non-nullable property means "not given" and is dropped rather than sent as null."""
    props = (schema or {}).get("properties") or {}
    required = set((schema or {}).get("required") or [])
    out: dict[str, Any] = {}
    for key, value in args.items():
        types = _types(props.get(key))
        if value is None and key not in required and types and "null" not in types:
            continue
        out[key] = _coerce(value, types)
    return out


def _empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def args_problem(args: Any, schema: dict[str, Any] | None) -> str | None:
    """Why model-built arguments cannot be sent, or None."""
    if not isinstance(args, dict):
        return "the arguments are not a JSON object"
    missing = [key for key in (schema or {}).get("required") or [] if _empty(args.get(key))]
    if missing:
        return f"missing required argument(s) {', '.join(missing)}"
    bad = elided_argument(args)
    if bad:
        return f"the `{bad}` argument is abbreviated with '...' — send the complete value"
    if schema:
        return schema_problem(args, {k: v for k, v in schema.items() if k != "required"})
    return None


# ---------------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------------

def summarize(tool: str, output: Any) -> str:
    """The one-line outcome shown on a step: "Created MCPF-14 in MCPF", "Reused existing PAY-31
    in PAY", "12 items from list_projects"."""
    tokens = set(tool_tokens(tool))
    if isinstance(output, list):
        return f"{len(output)} item{'' if len(output) == 1 else 's'}" + (f" from {tool}" if tool else "")
    if not isinstance(output, dict):
        text = " ".join(str(output if output is not None else "").split())
        return truncate(text, 140) or (f"{tool}: no content" if tool else "No content")
    keys = output.get("keys")
    if isinstance(keys, list) and keys and all(isinstance(k, str) for k in keys):
        verb = "Created" if tokens & {"create", "batch"} else "Processed"
        return f"{verb} {len(keys)} issue{'' if len(keys) == 1 else 's'}: {', '.join(keys[:6])}" \
               + ("…" if len(keys) > 6 else "")
    entity = output if (output.get("key") or output.get("id")) else next(
        (output[w] for w in ("issue", "server", "project", "item", "record") if isinstance(output.get(w), dict)), None)
    created = output.get("created") if isinstance(output.get("created"), bool) else None
    if isinstance(entity, dict):
        key = str(entity.get("key") or "")
        label = key or str(entity.get("name") or entity.get("summary") or entity.get("title") or entity.get("id") or "")
        where = str(entity.get("project_key") or output.get("project_key") or "")
        place = f" in {where}" if where and key else ""
        status = str(entity.get("status") or "")
        if "register" in tokens:
            return f"Registered {label} in the catalog" if created is not False else f"Updated {label} in the catalog"
        if created is True or (created is None and "create" in tokens):
            return f"Created {label}{place}"
        if created is False:
            return f"Reused existing {label}{place}" if key else f"Updated {label}"
        if tokens & WRITE_VERBS:
            return f"Updated {label}" + (f" ({status})" if status else "")
        return label + (f" · {status}" if status else "")
    for count in ("total", "count"):
        if isinstance(output.get(count), int):
            return f"{output[count]} result{'' if output[count] == 1 else 's'}" + (f" from {tool}" if tool else "")
    if isinstance(output.get("final"), str):
        return truncate(" ".join(output["final"].split()), 140)
    return f"{tool} succeeded" if tool else "Done"


# ---------------------------------------------------------------------------
# Executor
# ---------------------------------------------------------------------------

class OperationExecutor:
    def __init__(self, container: "Container") -> None:
        self.c = container

    # ------------------------------------------------------------------ lookups
    def resolve(self, op: dict | str) -> dict[str, Any]:
        """The Operation dict for a key (or id), or a dict given inline (unsaved draft)."""
        if isinstance(op, str):
            doc = self.c.get_operation_by_key(op) or (self.c.store.get("operations", op) if op else None)
            if doc is None:
                raise NotConfigured(f"Operation '{op}' is not configured — map it in Studio › Operations.")
        elif isinstance(op, dict):
            doc = op
        else:
            raise FactoryError("An operation must be given by its key or as an object.", 422)
        try:
            return Operation.model_validate(doc).model_dump()
        except ValidationError as exc:
            raise FactoryError(f"Operation '{doc.get('key') or doc.get('name')}' is invalid — "
                               f"{validation_message(exc)}", 422) from exc

    def connector_for(self, op: dict[str, Any]) -> dict[str, Any]:
        label = op.get("key") or op.get("name") or "(unsaved)"
        cid = op.get("connector_id") or ""
        if not cid:
            raise NotConfigured(f"Operation '{label}' has no connector — pick one in Studio › Operations.")
        doc = self.c.store.get("connectors", cid)
        if doc is None:
            raise NotConfigured(f"Operation '{label}' uses a connector that no longer exists — pick another one in "
                                f"Studio › Operations.")
        if not doc.get("enabled", True):
            raise NotConfigured(f"Connector '{doc.get('name') or cid}' (used by operation '{label}') is disabled — "
                                f"enable it in Settings › Connectors.")
        return doc

    async def tool_info(self, connector: dict[str, Any], tool: str, *, strict: bool) -> dict[str, Any] | None:
        """The ToolInfo of `tool`. Not strict: None when unknown (the server has the last word).
        Strict (llm mode needs the schema): refresh once, then NotConfigured."""
        def find(tools: list[dict[str, Any]]) -> dict[str, Any] | None:
            return next((t for t in tools if t.get("name") == tool), None)
        try:
            found = find(await self.c.mcp.list_tools(connector["id"]))
            if found is None and strict:
                found = find(await self.c.mcp.list_tools(connector["id"], refresh=True))
        except FactoryError:
            if strict:
                raise
            return None
        if found is None and strict:
            raise NotConfigured(f"Tool '{tool}' is not offered by connector '{connector.get('name')}' — test the "
                                f"connector in Settings › Connectors or fix the operation in Studio › Operations.")
        return found

    # ------------------------------------------------------------------ run
    async def run(self, op: dict | str, input: dict, *, ctx: dict | None = None, project_id: str = "",
                  step_id: str = "", args_override: dict | None = None, prepare_only: bool = False,
                  agent_state: dict | None = None, autonomy: str = "full", trace: Any = None,
                  confirmed: dict | None = None) -> OperationResult:
        """Run `op` with `input`. `args_override` replaces the rendered/LLM-built arguments
        (arguments a human confirmed or edited). `prepare_only` returns the arguments that
        would be sent and calls nothing. Agent mode: `agent_state` + `confirmed` ({approve,
        args, approve_all, comment}) resume a run paused on a write; a paused run returns
        ok=False, summary="needs_confirmation", raw={"pending", "agent_state"}."""
        tracer = as_tracer(trace, "operation")
        started = time.monotonic()
        doc = self.resolve(op)
        connector = self.connector_for(doc)
        data = dict(input or {})
        label = doc.get("key") or doc.get("name") or "(unsaved)"
        tctx = {**(ctx or {}), "input": data}
        mode = doc.get("mode") or "direct"
        if agent_state is None:
            tracer(f"Operation {label} ({mode}) on {connector.get('name')}", data={"input": data})
        if args_override is None and agent_state is None:
            self._check_inputs(doc, data)
        if mode == "agent":
            result = await self._agent(doc, connector, tctx, agent_state=agent_state, confirmed=confirmed,
                                       autonomy=autonomy, prepare_only=prepare_only, project_id=project_id,
                                       step_id=step_id, tracer=tracer)
        elif mode == "llm":
            result = await self._llm(doc, connector, tctx, args_override=args_override, prepare_only=prepare_only,
                                     project_id=project_id, step_id=step_id, tracer=tracer)
        else:
            result = await self._direct(doc, connector, tctx, args_override=args_override, prepare_only=prepare_only,
                                        tracer=tracer)
        return OperationResult.model_validate({**result.model_dump(exclude={"trace", "latency_ms"}),
                                               "latency_ms": int((time.monotonic() - started) * 1000),
                                               "trace": tracer.entries})

    @staticmethod
    def _check_inputs(op: dict[str, Any], data: dict[str, Any]) -> None:
        missing = [f for f in op.get("inputs") or [] if f.get("required") and
                   (_empty(data.get(f["key"])) or data.get(f["key"]) == [])]
        if missing:
            names = ", ".join(f"{f.get('label') or f['key']} ({f['key']})" for f in missing)
            raise FactoryError(f"Operation '{op.get('key') or op.get('name')}' needs a value for {names}, missing "
                               f"from its input.", 422)

    # ------------------------------------------------------------------ direct
    async def _direct(self, op: dict[str, Any], connector: dict[str, Any], tctx: dict[str, Any], *,
                      args_override: dict | None, prepare_only: bool, tracer: Tracer) -> OperationResult:
        tool = self._tool_name(op)
        info = await self.tool_info(connector, tool, strict=False)
        schema = (info or {}).get("input_schema") or None
        if args_override is not None:
            args = dict(args_override)
            tracer("Arguments confirmed by a human.", kind="human", data={"args": args})
        else:
            self._check_extract(op)
            rendered = templating.render_obj(op.get("args_template") or {}, tctx)
            if not isinstance(rendered, dict):
                raise TemplateError(f"The arguments template of operation '{op.get('key')}' must render to an object.")
            args = coerce_args(rendered, schema)
            empty = [k for k in (schema or {}).get("required") or [] if _empty(args.get(k))]
            if empty:
                raise FactoryError(f"Argument(s) {', '.join(empty)} of {tool} are required but rendered empty — check "
                                   f"the input of operation '{op.get('key')}' (or the step that feeds it).", 422)
            tracer("Arguments rendered.", data={"args": args})
        if prepare_only:
            return OperationResult(ok=True, tool=tool, args=args, summary="prepared")
        return await self._call(op, connector, tool, args, tracer)

    # ------------------------------------------------------------------ llm
    async def _llm(self, op: dict[str, Any], connector: dict[str, Any], tctx: dict[str, Any], *,
                   args_override: dict | None, prepare_only: bool, project_id: str, step_id: str,
                   tracer: Tracer) -> OperationResult:
        tool = self._tool_name(op)
        info = await self.tool_info(connector, tool, strict=True) or {}
        schema = info.get("input_schema") or {"type": "object", "properties": {}}
        if args_override is not None:
            args = dict(args_override)
            tracer("Arguments confirmed by a human.", kind="human", data={"args": args})
        else:
            self._check_extract(op)
            instructions = templating.render(op.get("prompt") or "", tctx).strip()
            user = self._args_prompt(tool, info, schema, instructions, tctx["input"])
            tracer(f"Asking the model for the arguments of {tool}.", kind="ai", data={"prompt": truncate(user, 1500)})
            try:
                built = await self.c.ai.ask("op_args_builder", user, prompt_key="op_args_builder", json=True,
                                            project_id=project_id, step_id=step_id)
                problem = args_problem(built, schema)
                if problem:
                    tracer(f"Arguments rejected ({problem}) — asking once more.", kind="error",
                           data={"args": built if isinstance(built, dict) else None})
                    retry = (f"{user}\n\nYour previous arguments were rejected: {problem}.\nPrevious arguments: "
                             f"{json.dumps(built, ensure_ascii=False, default=str)[:1500]}\n"
                             "Return the corrected JSON object of arguments.")
                    built = await self.c.ai.ask("op_args_builder", retry, prompt_key="op_args_builder", json=True,
                                                project_id=project_id, step_id=step_id)
                    problem = args_problem(built, schema)
            except LLMNotConfigured:
                raise
            except LLMError as exc:
                return self._failed(tool, {}, f"The model could not build the arguments of {tool}: {exc.message}",
                                    "llm", tracer)
            if problem:
                return self._failed(tool, built if isinstance(built, dict) else {},
                                    f"The model could not build valid arguments for {tool}: {problem}.", "llm", tracer)
            args = coerce_args(built, schema)
            tracer("Arguments built by the model.", kind="ai", data={"args": args})
        if prepare_only:
            return OperationResult(ok=True, tool=tool, args=args, summary="prepared")
        result = await self._call(op, connector, tool, args, tracer)
        schema_out = (op.get("output") or {}).get("json_schema")
        if result.ok and schema_out:
            result = await self._map_output(op, tool, result, schema_out, project_id, step_id, tracer)
        return result

    @staticmethod
    def _args_prompt(tool: str, info: dict[str, Any], schema: dict[str, Any], instructions: str,
                     data: dict[str, Any]) -> str:
        return (f"Tool: {tool}\n"
                f"Tool description: {truncate(' '.join((info.get('description') or '').split()), 800) or '(none)'}\n"
                f"Input schema (JSON):\n{json.dumps(schema, ensure_ascii=False)}\n\n"
                f"What the call must do:\n{instructions or '(no instructions: derive the arguments from the input data)'}"
                f"\n\nInput data (JSON):\n{truncate(json.dumps(data, ensure_ascii=False, default=str), PROMPT_INPUT_CHARS)}"
                "\n\nReturn ONLY the JSON object of arguments.")

    async def _map_output(self, op: dict[str, Any], tool: str, result: OperationResult, schema: dict[str, Any],
                          project_id: str, step_id: str, tracer: Tracer) -> OperationResult:
        observed = json.dumps(result.output, ensure_ascii=False, default=str)
        user = (f"The tool {tool} returned this result:\n{truncate(observed, MAPPING_RESULT_CHARS)}\n\n"
                "Map it to ONE JSON value matching the schema below. Use ONLY values present in the result — never "
                "invent ids, keys, URLs, names or numbers; use \"\" / [] / null for anything absent.")
        try:
            value = await self.c.ai.ask("op_output", user, prompt_key="orchestrator", json_schema=schema,
                                        project_id=project_id, step_id=step_id)
        except LLMNotConfigured:
            raise
        except LLMError as exc:
            failed = self._failed(tool, result.args, f"{tool} succeeded, but mapping its result to the output schema "
                                                     f"failed: {exc.message}", "mapping", tracer)
            failed.raw = result.raw
            return failed
        missing = ungrounded(value, observed)
        if missing:
            tracer(f"Blanked values absent from the tool result: {', '.join(missing[:8])}", kind="error")
            value = blank_paths(value, missing)
        tracer("Result mapped to the output schema.", kind="ai", data={"output": value})
        return result.model_copy(update={"output": value, "summary": summarize(tool, value) or result.summary})

    # ------------------------------------------------------------------ agent
    async def _agent(self, op: dict[str, Any], connector: dict[str, Any], tctx: dict[str, Any], *,
                     agent_state: dict | None, confirmed: dict | None, autonomy: str, prepare_only: bool,
                     project_id: str, step_id: str, tracer: Tracer) -> OperationResult:
        label = op.get("key") or op.get("name")
        if prepare_only:   # the agent decides its calls at run time; each write is confirmed on its own
            return OperationResult(ok=True, summary="prepared", args={})
        goal = ""
        if not agent_state:
            if not (op.get("prompt") or "").strip():
                raise NotConfigured(f"Agent-mode operation '{label}' has no goal — write it in Studio › Operations.")
            goal = templating.render(op["prompt"], tctx).strip()
        engine = self.c.app_settings().engine
        schema = (op.get("output") or {}).get("json_schema") or None
        outcome = await run_agent(self.c, goal=goal or (agent_state or {}).get("goal") or "",
                                  connector_ids=[connector["id"]], allowed_tools=op.get("allowed_tools") or [],
                                  max_actions=engine.max_agent_actions, timeout_s=engine.agent_timeout_s,
                                  output_schema=schema, autonomy=autonomy, state=agent_state, confirmed=confirmed,
                                  project_id=project_id, step_id=step_id, trace=tracer)
        used = [a for a in outcome.actions if a.get("status") == "ok"]
        last = used[-1] if used else {}
        if outcome.status == "needs_confirmation":
            pending = outcome.pending or {}
            return OperationResult(ok=False, summary="needs_confirmation", tool=pending.get("tool") or "",
                                   args=pending.get("args") or {},
                                   raw={"pending": pending, "agent_state": outcome.state, "actions": outcome.actions})
        if outcome.status != "done":
            failed = self._failed(last.get("tool") or "", {}, outcome.final or "The agent failed.", "agent", tracer)
            failed.raw = {"final": outcome.final, "actions": outcome.actions}
            return failed
        result = outcome.data if schema else {"final": outcome.final}
        output, error = self._extract(op, result)
        writes = [a for a in used if set(tool_tokens(a.get("tool") or "")) & WRITE_VERBS]
        tool = (writes or used or [{}])[-1].get("tool") or ""
        raw = {"final": outcome.final, "data": outcome.data, "actions": outcome.actions}
        if error:
            failed = self._failed(tool, {}, error, "extract", tracer)
            failed.raw = raw
            return failed
        summary = summarize(tool, output)
        if used:
            summary += f" ({len(outcome.actions)} tool call{'' if len(outcome.actions) == 1 else 's'})"
        return OperationResult(ok=True, output=output, raw=raw, summary=summary, tool=tool,
                               args=(writes or used or [{}])[-1].get("args") or {})

    # ------------------------------------------------------------------ shared
    @staticmethod
    def _tool_name(op: dict[str, Any]) -> str:
        tool = (op.get("tool") or "").strip()
        if not tool:
            raise NotConfigured(f"Operation '{op.get('key') or op.get('name')}' has no tool — pick one in "
                                f"Studio › Operations.")
        return tool

    @staticmethod
    def _check_extract(op: dict[str, Any]) -> None:
        """A broken extract expression is found before the call, not after a write."""
        expr = _strip_braces((op.get("output") or {}).get("extract") or "")
        if expr:
            try:
                templating.evaluate(expr, {"result": {}})
            except TemplateError as exc:
                raise TemplateError(f"Output › Extract of operation '{op.get('key')}' is invalid: {exc.message}") from exc

    @staticmethod
    def _extract(op: dict[str, Any], result: Any) -> tuple[Any, str]:
        expr = _strip_braces((op.get("output") or {}).get("extract") or "")
        if not expr:
            return result, ""
        try:
            return _native(templating.evaluate(expr, {"result": result})), ""
        except FactoryError as exc:
            return None, (f"The call succeeded, but Output › Extract ({expr}) failed: {exc.message} — fix it in "
                          f"Studio › Operations.")

    async def _call(self, op: dict[str, Any], connector: dict[str, Any], tool: str, args: dict[str, Any],
                    tracer: Tracer) -> OperationResult:
        tracer(f"→ {tool}({compact(redact(args), 240)})", kind="tool", data={"tool": tool, "args": args})
        res = await self.c.mcp.call_tool(connector["id"], tool, args)
        if not res.get("ok"):
            kind = "tool" if res.get("is_error") else "transport"
            error = res.get("error") or res.get("text") or "The tool failed without a message."
            failed = self._failed(tool, args, f"{tool} failed: {error}", kind, tracer)
            failed.raw = res.get("data") if res.get("data") is not None else (res.get("text") or None)
            return failed
        result = res.get("data") if res.get("data") is not None else res.get("text")
        tracer(f"← {tool} answered in {res.get('latency_ms', 0)} ms.", kind="result",
               data={"result": compact(redact(result), 1500)})
        output, error = self._extract(op, result)
        if error:
            failed = self._failed(tool, args, error, "extract", tracer)
            failed.raw = result
            return failed
        return OperationResult(ok=True, output=output, raw=result, summary=summarize(tool, output), tool=tool,
                               args=args)

    @staticmethod
    def _failed(tool: str, args: dict[str, Any], error: str, kind: str, tracer: Tracer) -> OperationResult:
        tracer(error, kind="error", data={"failure": kind})
        return OperationResult(ok=False, error=error, tool=tool, args=args,
                               summary=f"{tool} failed" if tool else "Failed")
