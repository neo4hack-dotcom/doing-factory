"""AIRuntime: the one door every LLM call goes through (SPEC §6, §12).

It adds what the raw client should not know about: the prompt library (an admin's edited
prompt wins over the default), fast-model routing, JSON that survives a small model, and
a metrics row per call. JSON is the load-bearing part — a local 4B model wraps, fences
and trail-commas its JSON, or answers prose. A tolerant parse handles the first kind; one
repair round-trip ("return ONLY valid JSON…") handles most of the rest; after that the
call fails loudly. Nothing here ever returns an invented `{}` to keep a workflow moving.

Metrics: every call — failed ones included — becomes an LLMCall row
(store.add_llm_call) and a live `llm.call` bus event. A call refused because no LLM is
configured is not recorded: no model was called, and counting it would turn an unused
feature into a 100 % error rate on the KPI page.
"""
from __future__ import annotations

import json as jsonlib
import logging
import time
from typing import TYPE_CHECKING, Any

from app.errors import FactoryError, LLMError, LLMNotConfigured, NotFound
from app.llm.client import LLMReply
from app.llm.prompts import DEFAULT_PROMPTS
from app.models import LLMCall
from app.util import new_id, now_iso, parse_json, truncate

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

log = logging.getLogger("factory.ai")

_REPAIR_ECHO_CHARS = 4000   # how much of a broken reply is shown back to the model


class AIRuntime:
    def __init__(self, container: "Container") -> None:
        self.c = container

    @property
    def configured(self) -> bool:
        return self.c.llm.configured

    # ------------------------------------------------------------------ prompt library
    def prompt(self, key: str) -> str:
        """The system prompt for `key`: the library's edited copy when it has content,
        else the default. An unknown key is a configuration error, said as such."""
        override = self._override(key)
        if override:
            return override
        default = DEFAULT_PROMPTS.get(key)
        if default is None:
            raise NotFound(f"Unknown prompt '{key}' — see Studio › Prompts for the available keys.")
        return default["content"]

    def _override(self, key: str) -> str:
        doc = self.c.store.get("prompts", key)
        if doc is None:   # documents are keyed by prompt key; tolerate one stored under another id
            doc = next((d for d in self.c.store.list("prompts") if d.get("key") == key), None)
        content = (doc or {}).get("content")
        return content.strip() if isinstance(content, str) else ""

    # ------------------------------------------------------------------ calls
    async def ask(self, role: str, user: str, *, prompt_key: str | None = None, system: str | None = None,
                  json: bool = False, json_schema: dict[str, Any] | None = None, fast: bool = False,
                  temperature: float | None = None, max_tokens: int | None = None,
                  project_id: str = "", step_id: str = "") -> str | dict | list:
        """One question, one answer. `role` labels the call in metrics and, unless
        `prompt_key` or `system` says otherwise, names the system prompt. With `json` or
        `json_schema` the answer is the parsed value (a schema is also enforced by the
        provider and checked here); otherwise the stripped text."""
        llm = self.c.llm
        if system is None:
            if prompt_key:
                system = self.prompt(prompt_key)
            else:   # a role that is not a prompt key (e.g. "draft_form") just has no default prompt
                system = self._override(role) or DEFAULT_PROMPTS.get(role, {}).get("content", "")
        want_json = json or json_schema is not None
        if json_schema is not None:
            user = (f"{user}\n\nReturn ONLY JSON matching this JSON schema:\n"
                    f"{jsonlib.dumps(json_schema, ensure_ascii=False)}")
        messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
        options = {"model": llm.fast_model if fast else llm.model,
                   # Structured answers want determinism; prose keeps the configured temperature.
                   "temperature": temperature if temperature is not None else (0.0 if want_json else None),
                   "json_mode": want_json, "json_schema": json_schema, "max_tokens": max_tokens}
        reply = await self._call(role, messages, project_id=project_id, step_id=step_id, **options)
        if not want_json:
            text = reply.content.strip()
            if not text:
                raise LLMError(f"The model returned an empty answer for '{role}'"
                               + (" — it spent its budget reasoning; turn Reasoning off in Settings › AI Model."
                                  if reply.thinking else "."))
            return text
        value, problem = _parse(reply.content, json_schema)
        if problem is None:
            return value
        shape = (f"matching this JSON schema: {jsonlib.dumps(json_schema, ensure_ascii=False)}"
                 if json_schema is not None else "with exactly the keys and shape the instructions asked for")
        repair = messages + [
            {"role": "assistant", "content": truncate(reply.content, _REPAIR_ECHO_CHARS) or "(empty reply)"},
            {"role": "user", "content": f"Your reply was not usable: {problem}. Return ONLY valid JSON {shape}. "
                                        f"No prose, no code fences, no comments."},
        ]
        reply = await self._call(role, repair, project_id=project_id, step_id=step_id, **options)
        value, problem = _parse(reply.content, json_schema)
        if problem is None:
            return value
        raise LLMError(f"The model did not return usable JSON for '{role}' after one repair attempt ({problem}). "
                       f"A larger model (Settings › AI Model) or a simpler prompt usually fixes this.")

    async def ask_json(self, role: str, user: str, **kwargs: Any) -> dict | list:
        """`ask(..., json=True)` — named for call sites where the JSON is the point."""
        return await self.ask(role, user, json=True, **kwargs)

    async def chat(self, role: str, messages: list[dict[str, Any]], *, tools: list[dict[str, Any]] | None = None,
                   fast: bool = False, temperature: float | None = None, project_id: str = "", step_id: str = "",
                   json_mode: bool = False, json_schema: dict[str, Any] | None = None,
                   max_tokens: int | None = None) -> LLMReply:
        """A raw multi-turn call (agent loops, copilot): the caller owns the messages,
        system prompt included; this records the call and returns the provider reply."""
        llm = self.c.llm
        return await self._call(role, messages, project_id=project_id, step_id=step_id,
                                model=llm.fast_model if fast else llm.model, temperature=temperature,
                                tools=tools, json_mode=json_mode, json_schema=json_schema, max_tokens=max_tokens)

    ask_tools = chat   # SPEC §6 name for the agent-loop entry point

    async def _call(self, role: str, messages: list[dict[str, Any]], *, model: str, project_id: str,
                    step_id: str, **options: Any) -> LLMReply:
        started = time.monotonic()
        try:
            reply = await self.c.llm.chat(messages, model=model, **options)
        except LLMNotConfigured:
            raise
        except Exception as exc:
            message = exc.message if isinstance(exc, FactoryError) else f"{type(exc).__name__}: {exc}"
            self._record(role, model, ok=False, latency_ms=int((time.monotonic() - started) * 1000),
                         error=message, project_id=project_id, step_id=step_id)
            raise
        self._record(role, reply.model or model, ok=True, latency_ms=reply.latency_ms,
                     tokens_in=reply.tokens_in, tokens_out=reply.tokens_out, project_id=project_id, step_id=step_id)
        return reply

    def _record(self, role: str, model: str, *, ok: bool, latency_ms: int, project_id: str, step_id: str,
                tokens_in: int = 0, tokens_out: int = 0, error: str = "") -> None:
        call = LLMCall(id=new_id("llm"), ts=now_iso(), role=role, model=model or "", ok=ok, latency_ms=latency_ms,
                       tokens_in=tokens_in, tokens_out=tokens_out, project_id=project_id, step_id=step_id,
                       error=truncate(error, 500)).model_dump()
        try:
            self.c.store.add_llm_call(call)
            self.c.bus.emit("llm.call", call=call)
        except Exception:  # noqa: BLE001 — metrics must never break the step they measure
            log.exception("Could not record an LLM call")


def _parse(text: str, schema: dict[str, Any] | None) -> tuple[Any, str | None]:
    """(value, None) when `text` holds usable JSON, else (value or None, what is wrong)."""
    if not (text or "").strip():
        return None, "the reply was empty"
    value = parse_json(text)
    if value is None:
        return None, "it is not valid JSON"
    if schema:
        problem = schema_problem(value, schema)
        if problem:
            return value, problem
    elif not isinstance(value, (dict, list)):   # every JSON role answers with an object or a list
        return value, "it is not a JSON object"
    return value, None


_TYPES: dict[str, tuple[type, ...]] = {"object": (dict,), "array": (list,), "string": (str,),
                                      "number": (int, float), "integer": (int,), "boolean": (bool,),
                                      "null": (type(None),)}


def schema_problem(value: Any, schema: dict[str, Any], path: str = "$", depth: int = 0) -> str | None:
    """The first way `value` breaks the parts of a JSON schema small models get wrong —
    type, required keys, enum — or None. Not a full validator (no jsonschema dependency);
    it is the check that decides whether a repair round-trip is worth asking for."""
    if not isinstance(schema, dict) or depth > 6:
        return None
    expected = schema.get("type")
    if expected:
        names = expected if isinstance(expected, list) else [expected]
        allowed = tuple(t for name in names for t in _TYPES.get(name, ()))
        is_bool = isinstance(value, bool)
        if allowed and (not isinstance(value, allowed) or (is_bool and bool not in allowed)):
            return f"{path} must be of type {' or '.join(names)}"
    if "enum" in schema and value not in schema["enum"]:
        return f"{path} must be one of {', '.join(jsonlib.dumps(v) for v in schema['enum'])}"
    if isinstance(value, dict):
        missing = [key for key in schema.get("required") or [] if key not in value]
        if missing:
            return f"{path} is missing the required key(s) {', '.join(missing)}"
        for key, sub in (schema.get("properties") or {}).items():
            if key in value:
                problem = schema_problem(value[key], sub, f"{path}.{key}", depth + 1)
                if problem:
                    return problem
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for index, item in enumerate(value[:50]):
            problem = schema_problem(item, schema["items"], f"{path}[{index}]", depth + 1)
            if problem:
                return problem
    return None
