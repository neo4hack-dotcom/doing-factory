"""Bounded tool-calling agent over MCP tools, with resumable state (SPEC §6, §12).

One loop serves agent_task steps and agent-mode operations: the model is given a goal and the
MCP tools it may use, calls them one at a time, and finishes with an answer. What keeps a
small local model honest and the loop finite:

* Native tool calling when the model declares it (Settings › AI Model › Tool mode), else a
  JSON decide-act protocol (`{"thought","action","tool","args","final"}`) the 'agent' prompt
  describes. Both share everything below.
* Budget: a ceiling on tool calls and on wall-clock time (LoopGuard), the calls left are
  told to the model after every result, and a structural failure streak stops the model from
  retrying an approach that already failed twice. An identical repeat of a successful call is
  answered from the transcript instead of being run again.
* Anti-ellipsis: an argument the model abbreviated with "..." is refused before it reaches a
  tool — a Jira description that says "Acceptance criteria:   ..." is worse than no call.
* Writes wait for a human: a sensitive tool (write verb or destructiveHint) under an autonomy
  other than `full` pauses the run with the prepared call; the whole state is JSON and lives
  on the step, so the run resumes after the confirmation — or after a restart.
* The structured result comes only from what was observed: when the final answer does not
  already match the output schema (or names ids/keys/urls no tool returned), one extra LLM
  pass maps the final answer and the tool results to the schema, and any id still not found
  in a tool result is blanked rather than passed on.
* Stopping is honest: out of budget or time, the agent says what it did and what is missing;
  the run fails only when nothing useful happened.
"""
from __future__ import annotations

import copy
import hashlib
import inspect
import json
import logging
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from app.engine.guard import LoopGuard
from app.errors import FactoryError, LLMError, LLMNotConfigured, MCPError, NotConfigured
from app.llm.client import assistant_message, tool_message
from app.llm.runtime import schema_problem
from app.util import MASK, now_iso, parse_json, truncate

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

log = logging.getLogger("factory.agent")

STATE_VERSION = 1
RESULT_CHARS = 4000            # a tool result as the model sees it in the transcript (SPEC §6)
OBSERVATION_CHARS = 1500       # one tool result in the structured-output pass
OBSERVATIONS_BUDGET = 9000     # all tool results together in that pass
EXTRA_TURNS = 3                # model turns allowed beyond the action budget (invalid replies, nudges)
STAGNATION_LIMIT = 2

# ---------------------------------------------------------------------------
# Outcome
# ---------------------------------------------------------------------------


@dataclass
class AgentOutcome:
    status: Literal["done", "needs_confirmation", "failed"]
    final: str = ""
    data: Any = None
    state: dict = field(default_factory=dict)
    pending: dict | None = None
    actions: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Tracing & redaction (shared with operations.py)
# ---------------------------------------------------------------------------

_SECRET_ARG = re.compile(r"secret|token|passw|pwd|credential|authori[sz]ation|cookie|api[_-]?key|access[_-]?key|"
                         r"private[_-]?key|session[_-]?id", re.IGNORECASE)
_BEARER = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}")


def redact(value: Any) -> Any:
    """A copy of `value` safe to show in a trace: values under secret-looking keys masked,
    bearer/basic credentials inside strings masked. Keys such as `issue_key` stay readable —
    only api/access/private keys count as secrets."""
    if isinstance(value, dict):
        return {k: (MASK if _SECRET_ARG.search(str(k)) and v not in (None, "") else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return _BEARER.sub(lambda m: f"{m.group(1)} {MASK}", value)
    return value


def compact(value: Any, limit: int = 300) -> str:
    """One-line JSON excerpt of `value` for trace texts and tables."""
    try:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        text = str(value)
    return truncate(" ".join(text.split()), limit)


class Tracer:
    """Collects TraceEntry dicts and forwards each one to an optional sink: a callable shaped
    like `StepCtx.trace(text, kind, agent, data)`, one taking the entry dict (`on_trace`), or
    another Tracer. A sink that raises never breaks the work being traced."""

    def __init__(self, sink: Any = None, agent: str = "") -> None:
        self.entries: list[dict[str, Any]] = []
        self.agent = agent
        self._sink = sink
        self._dict_sink = _single_parameter(sink)

    def __call__(self, text: str, kind: str = "info", agent: str = "", data: Any = None) -> None:
        entry = {"ts": now_iso(), "kind": kind, "agent": agent or self.agent, "text": truncate(text, 2000),
                 "data": redact(data) if data is not None else None}
        self.entries.append(entry)
        if self._sink is None:
            return
        try:
            if self._dict_sink:
                self._sink(entry)
            else:
                self._sink(entry["text"], kind=kind, agent=entry["agent"], data=entry["data"])
        except Exception:  # noqa: BLE001 — tracing must never break a step
            log.exception("Trace sink failed")


def _single_parameter(fn: Any) -> bool:
    if fn is None or isinstance(fn, Tracer):
        return False
    try:
        params = [p for p in inspect.signature(fn).parameters.values()
                  if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.VAR_POSITIONAL)]
    except (TypeError, ValueError):
        return False
    return len(params) == 1 and params[0].kind is not inspect.Parameter.VAR_POSITIONAL


def as_tracer(trace: Any, agent: str = "") -> Tracer:
    return trace if isinstance(trace, Tracer) else Tracer(trace, agent)


# ---------------------------------------------------------------------------
# Argument guards
# ---------------------------------------------------------------------------

# A model abbreviating its own output does not stop at the boundary of a tool argument. What it
# produces is unmistakable: a run of spaces (often non-breaking) then an ellipsis, at the end of
# a value or alone on a line. Two spaces before the dots is the discriminator — prose that
# trails off ("wait for it...") has none or one. Ported from AGENT (agent/runner.py).
_ELISION_TAIL = re.compile(r"[\s ]{2,}(?:\.{3,}|…)[\s ]*$")
_ELISION_LINE = re.compile(r"^[\s ]*(?:\.{3,}|…)[\s ]*$", re.M)


def elided_argument(arguments: Any) -> str:
    """The name (dotted path) of the first argument that looks abbreviated, or ""."""
    items = arguments.items() if isinstance(arguments, dict) else enumerate(arguments or [])
    for key, value in items:
        if isinstance(value, str) and (_ELISION_TAIL.search(value) or _ELISION_LINE.search(value)):
            return str(key)
        if isinstance(value, (dict, list)):
            nested = elided_argument(value)
            if nested:
                return f"{key}.{nested}"
    return ""


def fingerprint(qualified: str, args: Any) -> str:
    """Identity of one exact call (tool + argument values)."""
    raw = json.dumps({"tool": qualified, "args": args}, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


# Leaf fields whose value must be copied from a tool result, never written by the model.
_ID_FIELD = re.compile(r"(^|_)(id|key|url|uri|link)s?$", re.IGNORECASE)


def ungrounded(value: Any, observed: str, path: str = "") -> list[str]:
    """Paths of id/key/url leaves of `value` whose text appears nowhere in `observed`."""
    found: list[str] = []
    if isinstance(value, dict):
        for key, sub in value.items():
            sub_path = f"{path}.{key}" if path else str(key)
            if isinstance(sub, str) and sub.strip() and _ID_FIELD.search(str(key)):
                if sub.strip() not in observed:
                    found.append(sub_path)
            elif isinstance(sub, (dict, list)):
                found.extend(ungrounded(sub, observed, sub_path))
    elif isinstance(value, list):
        for index, sub in enumerate(value):
            found.extend(ungrounded(sub, observed, f"{path}[{index}]"))
    return found


def blank_paths(value: Any, paths: list[str]) -> Any:
    """`value` with the string leaves at `paths` replaced by ""."""
    targets = set(paths)

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, dict):
            out = {}
            for key, sub in node.items():
                sub_path = f"{path}.{key}" if path else str(key)
                out[key] = "" if sub_path in targets else walk(sub, sub_path)
            return out
        if isinstance(node, list):
            return [walk(sub, f"{path}[{i}]") for i, sub in enumerate(node)]
        return node
    return walk(value, "")


# ---------------------------------------------------------------------------
# Tool catalogue
# ---------------------------------------------------------------------------


@dataclass
class _Tool:
    display: str          # the name the model sees: bare when unique in this run, else qualified
    qualified: str
    name: str
    connector_id: str
    connector_name: str
    description: str
    input_schema: dict
    sensitive: bool


class _Catalogue:
    def __init__(self, tools: list[_Tool]) -> None:
        self.tools = tools
        self._by: dict[str, _Tool] = {}
        for tool in tools:
            for alias in (tool.display, tool.qualified, tool.qualified.replace("__", ".", 1)):
                self._by.setdefault(alias, tool)
        bare: dict[str, list[_Tool]] = {}
        for tool in tools:
            bare.setdefault(tool.name, []).append(tool)
        for name, hits in bare.items():
            if len(hits) == 1:   # a bare name resolves only when unambiguous
                self._by.setdefault(name, hits[0])

    def resolve(self, name: str) -> _Tool | None:
        needle = (name or "").strip()
        return self._by.get(needle) or self._by.get(needle.split("__")[-1] if "__" in needle else "")

    def names(self) -> list[str]:
        return [t.display for t in self.tools]

    def functions(self) -> list[dict[str, Any]]:
        return [{"type": "function", "function": {"name": t.display, "description": truncate(t.description, 700),
                                                  "parameters": _parameters(t.input_schema)}} for t in self.tools]

    def describe(self) -> str:
        """The tool list in prose for the JSON decide-act mode."""
        lines = []
        for t in self.tools:
            schema = _parameters(t.input_schema)
            required = set(schema.get("required") or [])
            args = []
            for key, prop in (schema.get("properties") or {}).items():
                kind = prop.get("type", "any") if isinstance(prop, dict) else "any"
                kind = "|".join(kind) if isinstance(kind, list) else kind
                hint = truncate((prop or {}).get("description", ""), 80) if isinstance(prop, dict) else ""
                args.append(f'"{key}": {kind}{" (required)" if key in required else ""}{" — " + hint if hint else ""}')
            lines.append(f"- {t.display}: {truncate(' '.join(t.description.split()), 300)}\n"
                         f"  args: {{{'; '.join(args)}}}")
        return "\n".join(lines)


def _parameters(schema: Any) -> dict[str, Any]:
    """A tool input schema as a function `parameters` object both providers accept."""
    schema = dict(schema) if isinstance(schema, dict) else {}
    schema.pop("$schema", None)
    props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    out = {**schema, "type": "object", "properties": props}
    required = [r for r in (schema.get("required") or []) if r in props]
    if required:
        out["required"] = required
    else:
        out.pop("required", None)
    return out


def _allowed(entry: dict[str, Any], allowed: set[str]) -> bool:
    if not allowed:
        return True
    qualified = entry["qualified"]
    return bool({qualified, entry["name"], qualified.replace("__", ".", 1)} & allowed)


async def build_catalogue(c: "Container", connector_ids: list[str], allowed_tools: list[str],
                          trace: Tracer) -> _Catalogue:
    """The tools this run may call. Connectors never tested are connected once here (their
    tool list is needed); one that cannot be reached is reported and skipped. Raises
    NotConfigured when nothing usable is in scope — a retry cannot fix that."""
    wanted = [cid for cid in (connector_ids or []) if cid]
    docs = c.store.list("connectors")
    known = {d.get("id") for d in docs}
    for cid in wanted:
        if cid not in known:
            trace(f"Connector {cid} no longer exists — skipped.", kind="error")
    scope = [d for d in docs if d.get("enabled", True) and (not wanted or d.get("id") in wanted)]
    if not scope:
        raise NotConfigured("No enabled MCP connector is available to this agent — add or enable one in "
                            "Settings › Connectors" + (" (or fix the step's connector list)." if wanted else "."))
    problems = []
    for doc in scope:
        if doc.get("tools"):
            continue
        try:
            await c.mcp.list_tools(doc["id"])
        except Exception as exc:  # noqa: BLE001 — one dead connector must not sink the others
            message = exc.message if isinstance(exc, FactoryError) else f"{type(exc).__name__}: {exc}"
            problems.append(f"{doc.get('name') or doc['id']}: {message}")
            trace(f"Connector '{doc.get('name')}' is unreachable: {message}", kind="error")
    allowed = {a.strip() for a in (allowed_tools or []) if isinstance(a, str) and a.strip()}
    index = [e for e in c.mcp.tool_index([d["id"] for d in scope]) if _allowed(e, allowed)]
    if not index:
        if problems:
            raise MCPError("No tool is reachable for this agent: " + "; ".join(problems))  # transient → retryable
        what = f"none of the allowed tools ({', '.join(sorted(allowed))})" if allowed else "no tool"
        raise NotConfigured(f"The connectors in scope offer {what} — test them in Settings › Connectors "
                            f"or fix the allowed tools of this step.")
    counts: dict[str, int] = {}
    for e in index:
        counts[e["name"]] = counts.get(e["name"], 0) + 1
    tools = [_Tool(display=e["name"] if counts[e["name"]] == 1 else e["qualified"], qualified=e["qualified"],
                   name=e["name"], connector_id=e["connector_id"], connector_name=e.get("connector_name") or "",
                   description=e.get("description") or "", input_schema=e.get("input_schema") or {},
                   sensitive=bool(e.get("sensitive"))) for e in index]
    return _Catalogue(tools)


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------

_JSON_PROTOCOL = ('Reply with exactly ONE JSON object and nothing else:\n'
                  '- to call a tool: {"thought": "<why>", "action": "tool", "tool": "<tool name>", "args": {...}}\n'
                  '- when the goal is met (or cannot be met): {"thought": "<why>", "action": "finish", '
                  '"final": "<your final answer>"}')


class _Run:
    def __init__(self, c: "Container", catalogue: _Catalogue, *, goal: str, context: str, max_actions: int,
                 timeout_s: float, output_schema: dict | None, autonomy: str, state: dict | None,
                 native: bool, project_id: str, step_id: str, trace: Tracer) -> None:
        self.c = c
        self.catalogue = catalogue
        self.goal = goal
        self.context = context
        self.max_actions = max_actions
        self.timeout_s = timeout_s
        self.schema = output_schema or None
        self.autonomy = autonomy or "approve_writes"
        self.project_id = project_id
        self.step_id = step_id
        self.trace = trace
        resumed = bool(state and state.get("messages"))
        # A detached copy: the caller's state (a step snapshot) is never mutated in place.
        self.state: dict[str, Any] = copy.deepcopy(state) if resumed else {}
        self.native = self.state.get("mode", "native" if native else "json") == "native"
        self.guard = LoopGuard.from_state(self.state.get("guard"), max_total_steps=max_actions, timeout_s=timeout_s,
                                          stagnation_limit=STAGNATION_LIMIT)
        if not resumed:
            self.state = {"v": STATE_VERSION, "mode": "native" if self.native else "json",
                          "goal": goal, "context": context, "messages": self._opening(), "history": [],
                          "turns": 0, "invalid": 0, "approve_all": False, "pending": None}

    # ------------------------------------------------------------------ state helpers
    @property
    def messages(self) -> list[dict[str, Any]]:
        return self.state["messages"]

    @property
    def history(self) -> list[dict[str, Any]]:
        return self.state["history"]

    def snapshot(self) -> dict[str, Any]:
        self.state["guard"] = self.guard.to_state()
        self.state["actions_used"] = self.guard.total_attempts
        self.state["budget"] = self.guard.snapshot()
        return json.loads(json.dumps(self.state, default=str))   # JSON-serialisable, detached copy

    def actions(self) -> list[dict[str, Any]]:
        return [{k: (truncate(v, 300) if k == "result" else v) for k, v in h.items()} for h in self.history]

    def outcome(self, status: str, final: str = "", data: Any = None, pending: dict | None = None) -> AgentOutcome:
        return AgentOutcome(status=status, final=final, data=data, state=self.snapshot(), pending=pending,
                            actions=self.actions())  # type: ignore[arg-type]

    # ------------------------------------------------------------------ prompts
    def _opening(self) -> list[dict[str, Any]]:
        parts = [f"Goal:\n{self.goal.strip()}"]
        if self.context.strip():
            parts.append(f"Context:\n{self.context.strip()}")
        if self.native:
            parts.append(f"Tools you may call: {', '.join(self.catalogue.names())}.")
        else:
            parts.append(f"Tools:\n{self.catalogue.describe()}")
        budget = f"Budget: at most {self.max_actions} tool calls"
        if self.timeout_s:
            budget += f" and about {int(self.timeout_s)} seconds"
        parts.append(budget + ". Finish as soon as the goal is met.")
        if self.schema:
            parts.append("Your final answer must be ONLY a JSON value matching this JSON schema, filled from the "
                         "tool results:\n" + json.dumps(self.schema, ensure_ascii=False))
        if not self.native:
            parts.append(_JSON_PROTOCOL)
        return [{"role": "system", "content": self.c.ai.prompt("agent")},
                {"role": "user", "content": "\n\n".join(parts)}]

    def _budget_note(self) -> str:
        left = self.guard.steps_left()
        if left <= 0:
            return "\n\n[No tool calls left: give your final answer now.]"
        if left == 1:
            return "\n\n[1 tool call left — after it you must give your final answer.]"
        return f"\n\n[{left} tool calls left.]"

    def _observe(self, call: dict[str, Any], content: str) -> None:
        if self.native:
            self.messages.append(tool_message(call, content))
        else:
            self.messages.append({"role": "user", "content": f"Result of {call.get('name')}:\n{content}"})

    # ------------------------------------------------------------------ entry point
    async def go(self, confirmed: dict | None) -> AgentOutcome:
        pending = self.state.get("pending")
        if pending:
            if not isinstance(confirmed, dict):   # resumed without a decision: still waiting
                return self.outcome("needs_confirmation", pending=_public(pending))
            await self._resolve_pending(pending, confirmed)
        try:
            return await self._loop()
        except LLMNotConfigured:
            raise
        except LLMError as exc:
            self.trace(f"The model call failed: {exc.message}", kind="error")
            done = [h for h in self.history if h.get("status") == "ok"]
            tail = f" {len(done)} tool call(s) had succeeded before." if done else ""
            return self.outcome("failed", final=f"The model call failed: {exc.message}.{tail}")

    async def _loop(self) -> AgentOutcome:
        max_turns = self.max_actions + EXTRA_TURNS
        while True:
            if self.guard.over_time_budget():
                return await self._stop("time")
            if self.guard.over_step_budget():
                return await self._stop("budget")
            if self.state["turns"] >= max_turns:
                return await self._stop("turns")
            self.state["turns"] += 1
            result = await (self._native_turn() if self.native else self._json_turn())
            if result is not None:
                return result

    # ------------------------------------------------------------------ turns
    async def _native_turn(self) -> AgentOutcome | None:
        reply = await self.c.ai.chat("agent", self.messages, tools=self.catalogue.functions(),
                                     project_id=self.project_id, step_id=self.step_id)
        thought = (reply.content or "").strip()
        if reply.thinking:
            self.trace(truncate(reply.thinking, 600), kind="thought")
        if not reply.tool_calls:
            return await self._final_or_nudge(thought)
        if thought:
            self.trace(truncate(thought, 600), kind="thought")
        self.messages.append(assistant_message(reply))
        for index, call in enumerate(reply.tool_calls):
            paused = await self._handle({"id": call.get("id") or f"call_{len(self.history)}",
                                         "name": call.get("name") or "", "arguments": call.get("arguments")},
                                        thought)
            if paused is not None:
                # Calls after the paused one were never answered: drop them so the transcript
                # stays valid; the model re-issues them after the confirmation if still needed.
                self.messages[-1]["tool_calls"] = self.messages[-1]["tool_calls"][: index + 1]
                return paused
        return None

    async def _json_turn(self) -> AgentOutcome | None:
        reply = await self.c.ai.chat("agent", self.messages, json_mode=True,
                                     project_id=self.project_id, step_id=self.step_id)
        text = (reply.content or "").strip()
        decision = parse_json(text)
        self.messages.append({"role": "assistant", "content": text or "(empty)"})
        action = str(decision.get("action") or "").lower() if isinstance(decision, dict) else ""
        if isinstance(decision, dict) and not action:
            action = "tool" if decision.get("tool") else "finish" if "final" in decision else ""
        if action not in ("tool", "finish"):
            self.state["invalid"] += 1
            if self.state["invalid"] >= 2:
                return await self._stop("format")
            self.messages.append({"role": "user", "content": "That was not a valid action. " + _JSON_PROTOCOL})
            return None
        self.state["invalid"] = 0
        thought = str(decision.get("thought") or "").strip()
        if thought:
            self.trace(truncate(thought, 600), kind="thought")
        if action == "finish":
            final = decision.get("final")
            if not isinstance(final, str):
                final = json.dumps(final, ensure_ascii=False) if final is not None else ""
            return await self._final_or_nudge(final)
        call = {"id": f"json_{len(self.history) + 1}", "name": str(decision.get("tool") or ""),
                "arguments": decision.get("args") if isinstance(decision.get("args"), dict) else {}}
        return await self._handle(call, thought)

    async def _final_or_nudge(self, text: str) -> AgentOutcome | None:
        if text.strip():
            return await self._finish(text)
        if not self.state.get("nudged"):
            self.state["nudged"] = True
            if self.native:   # JSON mode already recorded the (empty) assistant turn
                self.messages.append({"role": "assistant", "content": ""})
            self.messages.append({"role": "user", "content": "Your reply was empty. Call a tool, or give your final "
                                                             "answer now." + ("" if self.native else " " + _JSON_PROTOCOL)})
            return None
        return await self._finish("")

    # ------------------------------------------------------------------ one tool call
    async def _handle(self, call: dict[str, Any], thought: str) -> AgentOutcome | None:
        name = call["name"]
        args = call["arguments"] if isinstance(call.get("arguments"), dict) else {}
        call["arguments"] = args
        tool = self.catalogue.resolve(name)
        if tool is None:
            self._refuse(call, {"action": "tool", "tool": name, "args": args}, "error",
                         f"ERROR: unknown tool '{name}'. You may only call: {', '.join(self.catalogue.names())}.")
            return None
        step = {"action": "tool", "tool": tool.qualified, "args": args}
        bad = elided_argument(args)
        if bad:
            self._refuse(call, step, "rejected",
                         f"ERROR: not executed — the `{bad}` argument is abbreviated with '...'. Send the complete "
                         f"value, copied in full from the goal or a tool result.", tool=tool)
            return None
        if self.guard.repeats_failed(step):
            self._refuse(call, step, "blocked",
                         f"ERROR: not executed — {tool.display} with these arguments already failed "
                         f"{STAGNATION_LIMIT} times in a row. Change approach (another tool or different arguments) "
                         f"or finish with what you have.", tool=tool)
            return None
        exact = fingerprint(tool.qualified, args)
        earlier = next((h for h in self.history if h.get("fingerprint") == exact and h.get("status") == "ok"), None)
        if earlier is not None:
            self._refuse(call, step, "duplicate",
                         f"Not executed again: you already made this exact call (action #{earlier['n']}) and its "
                         f"result is above. Use it, do something different, or finish.", tool=tool, ok=True)
            return None
        if tool.sensitive and self.autonomy != "full" and not self.state.get("approve_all"):
            pending = {"qualified": tool.qualified, "connector_id": tool.connector_id,
                       "connector_name": tool.connector_name, "tool": tool.name, "args": args,
                       "thought": truncate(thought, 600), "description": truncate(tool.description, 400),
                       "call": call}
            self.state["pending"] = pending
            self.trace(f"Waiting for a human to confirm {tool.display}({compact(redact(args), 200)})", kind="human",
                       data={"tool": tool.qualified, "args": args})
            return self.outcome("needs_confirmation", pending=_public(pending))
        await self._execute(call, tool, args)
        return None

    def _refuse(self, call: dict[str, Any], step: dict[str, Any], status: str, message: str, *,
                tool: _Tool | None = None, ok: bool = False) -> None:
        """A call answered without running it: still an attempt (it consumes the budget)."""
        self.guard.record(step, ok)
        self.history.append({"n": len(self.history) + 1, "tool": tool.name if tool else call["name"],
                             "qualified": tool.qualified if tool else "", "connector_id": tool.connector_id if tool else "",
                             "args": redact(call.get("arguments") or {}), "status": status, "ok": False,
                             "summary": truncate(message, 200), "result": "", "latency_ms": 0})
        self.trace(message, kind="error", data={"tool": call["name"], "args": call.get("arguments")})
        self._observe(call, message + self._budget_note())

    async def _execute(self, call: dict[str, Any], tool: _Tool, args: dict[str, Any], note: str = "") -> None:
        self.trace(f"→ {tool.display}({compact(redact(args), 240)})", kind="tool",
                   data={"tool": tool.qualified, "connector_id": tool.connector_id, "args": args})
        res = await self.c.mcp.call_tool(tool.connector_id, tool.name, args)
        ok = bool(res.get("ok"))
        text = res.get("text") or ""
        if not text and res.get("data") is not None:
            text = json.dumps(res["data"], ensure_ascii=False, default=str)
        content = (text or "(the tool returned no content)") if ok else \
            "ERROR: " + (res.get("error") or text or "the tool failed without a message")
        self.guard.record({"action": "tool", "tool": tool.qualified, "args": args}, ok)
        self.history.append({"n": len(self.history) + 1, "tool": tool.name, "qualified": tool.qualified,
                             "connector_id": tool.connector_id, "args": redact(args),
                             "status": "ok" if ok else "error", "ok": ok, "summary": _result_summary(tool.name, res),
                             "result": truncate(content, RESULT_CHARS), "latency_ms": int(res.get("latency_ms") or 0),
                             "fingerprint": fingerprint(tool.qualified, args)})
        self.trace(truncate(content, 500), kind="result" if ok else "error",
                   data={"tool": tool.qualified, "ok": ok, "latency_ms": res.get("latency_ms")})
        self._observe(call, note + truncate(content, RESULT_CHARS) + self._budget_note())

    async def _resolve_pending(self, pending: dict[str, Any], confirmed: dict[str, Any]) -> None:
        call = pending.get("call") or {"id": "pending", "name": pending.get("tool") or "", "arguments": pending.get("args")}
        tool = self.catalogue.resolve(pending.get("qualified") or "") or self.catalogue.resolve(pending.get("tool") or "")
        self.state["pending"] = None
        comment = str(confirmed.get("comment") or "").strip()
        if not confirmed.get("approve"):
            message = ("DECLINED: a human reviewer refused this call" + (f" ({comment})" if comment else "")
                       + ". It was NOT executed. Do not try it again; continue without it or finish, and say what "
                         "is left for a human.")
            self.trace("A human declined the call." + (f" {comment}" if comment else ""), kind="human")
            self._refuse(call, {"action": "tool", "tool": pending.get("qualified"), "args": pending.get("args") or {}},
                         "declined", message, tool=tool)
            return
        if confirmed.get("approve_all"):
            self.state["approve_all"] = True
        edited = confirmed.get("args")
        args = edited if isinstance(edited, dict) and edited else (pending.get("args") or {})
        note = ""
        if args != (pending.get("args") or {}):
            note = f"(A human reviewer edited the arguments before running it: {compact(redact(args), 600)})\n"
        self.trace("A human approved the call" + (" and all further writes of this run" if confirmed.get("approve_all")
                                                 else "") + (" with edited arguments." if note else "."), kind="human")
        if tool is None:
            self._refuse(call, {"action": "tool", "tool": pending.get("qualified"), "args": args}, "error",
                         f"ERROR: the tool {pending.get('qualified')} is no longer available, so it was not run.")
            return
        await self._execute(call, tool, args, note=note)

    # ------------------------------------------------------------------ finishing
    async def _finish(self, final: str, note: str = "") -> AgentOutcome:
        final = re.sub(r"^\s*<think>.*?(</think>|$)", "", final or "", flags=re.S | re.I).strip()
        shown = (note + final).strip() if note else final
        if not self.schema:
            if not final and not note:
                return self.outcome("failed", final="The model returned an empty final answer.")
            self.trace(truncate(shown, 800), kind="ai")
            return self.outcome("done", final=shown)
        data = await self._structure(final)
        if data is None:
            return self.outcome("failed", final=(shown + "\n\n" if shown else "")
                                + "The final answer could not be turned into the requested structured output.")
        self.trace(truncate(shown or compact(data, 800), 800), kind="ai", data={"output": data})
        return self.outcome("done", final=shown or json.dumps(data, ensure_ascii=False), data=data)

    def _observed(self) -> str:
        return "\n".join([self.state.get("goal") or self.goal, self.state.get("context") or self.context,
                          *(h.get("result") or "" for h in self.history if h.get("status") in ("ok", "error"))])

    async def _structure(self, final: str) -> Any:
        """The output-schema value, from the final answer when it already is one and only names
        ids it observed; else from one mapping pass over the final answer and the tool results."""
        observed = self._observed()
        direct = parse_json(final) if final else None
        if direct is not None and schema_problem(direct, self.schema) is None:
            missing = ungrounded(direct, observed)
            if not missing:
                return direct
            self.trace(f"The final answer names values no tool returned ({', '.join(missing[:5])}) — re-deriving "
                       f"the output from the tool results.", kind="info")
        try:
            value = await self.c.ai.ask("agent_output", self._mapping_prompt(final), prompt_key="orchestrator",
                                        json_schema=self.schema, project_id=self.project_id, step_id=self.step_id)
        except LLMNotConfigured:
            raise
        except LLMError as exc:
            self.trace(f"Structured output failed: {exc.message}", kind="error")
            return None
        missing = ungrounded(value, observed)
        if missing:
            self.trace(f"Blanked values that appear in no tool result: {', '.join(missing[:8])}", kind="error")
            value = blank_paths(value, missing)
        return value

    def _mapping_prompt(self, final: str) -> str:
        observations, used = [], 0
        for h in self.history:
            if h.get("status") not in ("ok", "error"):
                continue
            chunk = (f"#{h['n']} {h['tool']}({compact(h.get('args'), 200)}) → "
                     f"{'ok' if h.get('ok') else 'error'}:\n{truncate(h.get('result'), OBSERVATION_CHARS)}")
            if used + len(chunk) > OBSERVATIONS_BUDGET:
                observations.append("(older results omitted)")
                break
            observations.append(chunk)
            used += len(chunk)
        return (f"An agent worked toward this goal:\n{truncate(self.state.get('goal') or self.goal, 2500)}\n\n"
                f"The agent's final answer:\n{final or '(none)'}\n\n"
                f"Tool results the agent observed (the ONLY source of facts):\n"
                f"{chr(10).join(observations) or '(no tool was called)'}\n\n"
                "Write ONE JSON value matching the schema below. Use ONLY facts that appear in the final answer or in "
                "the tool results above — never invent ids, keys, URLs, names or numbers. When a value was not "
                "observed, use \"\" (or [] / false / 0).")

    async def _stop(self, reason: str) -> AgentOutcome:
        used = self.guard.total_attempts
        why = {"budget": f"the budget of {self.max_actions} tool calls was used up",
               "time": f"the time limit of {int(self.timeout_s)} s was reached",
               "turns": "the model kept answering without making progress",
               "format": "the model did not follow the JSON action format"}[reason]
        self.trace(f"Stopped: {why}.", kind="error", data=self.guard.snapshot())
        succeeded = [h for h in self.history if h.get("status") == "ok"]
        if not succeeded:
            last = next((h["summary"] for h in reversed(self.history) if h.get("summary")), "")
            return self.outcome("failed", final=f"Stopped after {used} action(s): {why}, and no tool call succeeded."
                                + (f" Last problem: {last}" if last else ""))
        note = f"Stopped after {used} action(s): {why}. "
        wrap = ""
        if reason in ("budget", "turns"):
            wrap = await self._wrap_up()
        if not wrap:
            note += "Results so far:\n" + "\n".join(f"- {h['tool']}: {h['summary']}" for h in succeeded) + "\n"
        return await self._finish(wrap, note=note)

    async def _wrap_up(self) -> str:
        """One last tool-less turn so a budget stop still ends with a real answer."""
        ask = ("You have no tool calls left. Do not call any tool. Give your final answer now from the results "
               "above, and say clearly what is incomplete.")
        if self.schema:
            ask += " The final answer must be ONLY the JSON value in the requested format."
        if not self.native:
            ask += ' Reply with {"thought": "...", "action": "finish", "final": "..."}.'
        messages = [*self.messages, {"role": "user", "content": ask}]
        try:
            reply = await self.c.ai.chat("agent", messages, json_mode=not self.native,
                                         project_id=self.project_id, step_id=self.step_id)
        except LLMNotConfigured:
            raise
        except LLMError as exc:
            self.trace(f"Wrap-up answer failed: {exc.message}", kind="error")
            return ""
        text = (reply.content or "").strip()
        if not self.native:
            decision = parse_json(text)
            if isinstance(decision, dict) and "final" in decision:
                final = decision["final"]
                text = final if isinstance(final, str) else json.dumps(final, ensure_ascii=False)
        return text


def _public(pending: dict[str, Any]) -> dict[str, Any]:
    """The pending call as the confirmation UI sees it (without the transcript bookkeeping)."""
    return {k: v for k, v in pending.items() if k != "call"}


def _result_summary(tool: str, res: dict[str, Any]) -> str:
    if not res.get("ok"):
        return truncate(res.get("error") or res.get("text") or "failed", 200)
    data = res.get("data")
    if isinstance(data, dict):
        for key in ("total", "count"):
            if isinstance(data.get(key), int):
                return f"{data[key]} result(s)"
        for wrap in ("issue", "server", "project"):
            inner = data.get(wrap)
            if isinstance(inner, dict):
                label = inner.get("key") or inner.get("id") or inner.get("name")
                if label:
                    return f"{wrap} {label}"
        if data.get("key"):
            return f"{data.get('key')} {truncate(data.get('summary') or data.get('status') or '', 80)}".strip()
    if isinstance(data, list):
        return f"{len(data)} item(s)"
    return truncate(" ".join((res.get("text") or "ok").split()), 120)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def run_agent(container: "Container", *, goal: str, connector_ids: list[str], allowed_tools: list[str],
                    max_actions: int, timeout_s: int, output_schema: dict | None, autonomy: str,
                    context: str = "", state: dict | None = None, confirmed: dict | None = None,
                    project_id: str = "", step_id: str = "", trace: Any = None) -> AgentOutcome:
    """Run (or resume) the agent. Returns `needs_confirmation` with the prepared call and the
    state to resume from; resume by passing that `state` back with `confirmed={"approve",
    "args", "approve_all", "comment"}`. Raises NotConfigured / LLMNotConfigured for what an
    admin must fix (no connector, no tool, no model); every other failure is an outcome."""
    c = container
    tracer = as_tracer(trace, "agent")
    engine = c.app_settings().engine
    max_actions = max(1, int(max_actions or engine.max_agent_actions or 8))
    timeout = float(timeout_s or engine.agent_timeout_s or 600)
    if not goal.strip() and not (state and state.get("messages")):
        raise NotConfigured("The agent has no goal — set one in the step or operation configuration.")
    try:
        catalogue = await build_catalogue(c, connector_ids, allowed_tools, tracer)
    except MCPError as exc:   # every connector in scope is unreachable: transient
        return AgentOutcome(status="failed", final=exc.message, state=dict(state or {}))
    resumed = bool(state and state.get("messages"))
    native = (state or {}).get("mode") == "native" if resumed else await _native_tools(c)
    run = _Run(c, catalogue, goal=goal, context=context or "", max_actions=max_actions, timeout_s=timeout,
               output_schema=output_schema, autonomy=autonomy, state=state if resumed else None, native=native,
               project_id=project_id, step_id=step_id, trace=tracer)
    if not resumed:
        tracer(f"Agent started ({'native tool calling' if native else 'JSON decide-act'}, {len(catalogue.tools)} "
               f"tools, budget {max_actions} calls / {int(timeout)} s).", data={"tools": catalogue.names()})
    return await run.go(confirmed)


async def _native_tools(c: "Container") -> bool:
    try:
        return bool(await c.llm.supports_tools())
    except Exception:  # noqa: BLE001 — capability probing must not fail a run; JSON mode always works
        return False

