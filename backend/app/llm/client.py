"""LLM client: Ollama's native API or any OpenAI-compatible server behind one interface
(SPEC §6, §12).

Ported from the AGENT project's provider (agent/backend/app/llm/provider.py), without
streaming: Factory LLM calls are background workflow steps, not chat bubbles, so one
JSON reply per call is simpler and the whole generation is bounded by one timeout.

What this layer guarantees to everything above it:
* Ollama gets a real context window. Its default is 4096 tokens whatever the model
  supports; a step prompt with a project brief and tool schemas overflows that and the
  model silently returns a truncated or empty turn. `num_ctx` is sized from what the
  model declares (`/api/show`), capped to what this machine can hold.
* A reply cut by the token limit is an error naming the limit, never half an answer.
* Tool calls come back in one shape whatever the server did: Ollama's dict arguments,
  OpenAI's JSON strings, a call whose arguments ended up inside its name, or a call the
  model printed as text instead of emitting natively.
* Nothing configured → every call raises LLMNotConfigured naming where to fix it.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.errors import FactoryError, LLMError, LLMNotConfigured
from app.models import LLMSettings
from app.util import parse_json, truncate

LLM_PRESETS: list[dict[str, str]] = [
    {"id": "ollama", "label": "Ollama", "provider": "ollama", "base_url": "http://127.0.0.1:11434",
     "hint": "Native Ollama API, base URL without /v1 — the context window is sized automatically."},
    {"id": "lmstudio", "label": "LM Studio", "provider": "openai", "base_url": "http://127.0.0.1:1234/v1",
     "hint": "Start the server in LM Studio's Developer tab; set the context length when loading the model."},
    {"id": "vllm", "label": "vLLM", "provider": "openai", "base_url": "http://127.0.0.1:8000/v1",
     "hint": "Tool calling needs --enable-auto-tool-choice and --tool-call-parser; the window is --max-model-len."},
    {"id": "llamacpp", "label": "llama.cpp server", "provider": "openai", "base_url": "http://127.0.0.1:8080/v1",
     "hint": "Tool calling needs --jinja; the context window is -c."},
    {"id": "custom", "label": "OpenAI-compatible (custom)", "provider": "openai", "base_url": "",
     "hint": "Any server exposing /chat/completions; the base URL usually ends in /v1."},
]

NO_MODEL = "No model selected — open Settings › AI Model and pick one of the models your server offers."
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
_THINK_BLOCK = re.compile(r"^\s*<think>(.*?)(?:</think>\s*|$)", re.DOTALL | re.IGNORECASE)
_EMBEDDING_NAME = re.compile(r"(embed|bge-|e5-|gte-|minilm|rerank)", re.IGNORECASE)


@dataclass
class LLMReply:
    content: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)   # [{"id", "name", "arguments": dict}]
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: int = 0
    model: str = ""
    finish_reason: str = ""
    thinking: str = ""            # reasoning kept apart so it never leaks into `content`
    native_tools: bool = True     # False when the calls were recovered from the reply text


def runs_remotely(model: str) -> bool:
    """Whether an Ollama tag is hosted by Ollama's cloud rather than this machine. The tag
    is the only honest signal: a cloud model stores nothing locally."""
    name = (model or "").lower()
    return name.endswith("-cloud") or name.endswith(":cloud") or ":cloud-" in name


def _local_host(base_url: str) -> bool:
    host = (urlsplit(base_url).hostname or "").lower()
    return host in _LOCAL_HOSTS or host.startswith("127.") or host.endswith(".localhost")


# ---------------------------------------------------------------------------
# Conversation helpers (the message format callers use with both providers)
# ---------------------------------------------------------------------------

def assistant_message(reply: LLMReply) -> dict[str, Any]:
    """The assistant turn to append to a conversation after `reply`, tool calls included."""
    message: dict[str, Any] = {"role": "assistant", "content": reply.content}
    if reply.tool_calls:
        message["tool_calls"] = [{"id": c["id"], "type": "function",
                                  "function": {"name": c["name"], "arguments": c["arguments"]}}
                                 for c in reply.tool_calls]
    return message


def tool_message(call: dict[str, Any], content: str) -> dict[str, Any]:
    """The tool-result turn answering `call` (an item of LLMReply.tool_calls)."""
    return {"role": "tool", "tool_call_id": call.get("id", ""), "tool_name": call.get("name", ""),
            "content": content}


def _call_parts(call: dict[str, Any]) -> tuple[str, str, Any]:
    """(id, name, arguments) of a tool call in either accepted shape: LLMReply's flat
    {"id","name","arguments"} or the wire form {"id","function": {"name","arguments"}}."""
    fn = call.get("function") if isinstance(call.get("function"), dict) else call
    return str(call.get("id") or ""), str(fn.get("name") or ""), fn.get("arguments", fn.get("parameters"))


def _arguments(raw: Any) -> dict[str, Any]:
    """Tool arguments as a dict: Ollama sends a dict, OpenAI a JSON string, and small
    models sometimes a string with a fence or a trailing comma."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = parse_json(raw)
        return parsed if isinstance(parsed, dict) else {}
    return {}


# ---------------------------------------------------------------------------
# Tool-call repair (ported verbatim in spirit from AGENT)
# ---------------------------------------------------------------------------

_TAG_DEBRIS = re.compile(r"^\s*(?:<\s*/?\s*(?:function|tool_call|parameter)\s*=?\s*)+|"
                         r"(?:\s*<\s*/?\s*(?:function|tool_call|parameter)\w*\s*>?)+\s*$", re.I)
_NAME_WITH_ARGS = re.compile(r"^([A-Za-z_][\w.\-]*)\s*(?:\((.*)\)|(\{.*\}))\s*$", re.S)
# Shapes seen in practice when a model writes the call as JSON text (llama.cpp-family templates).
_TOOL_KEYS = ({"name", "arguments"}, {"name", "parameters"}, {"tool", "arguments"},
              {"function", "arguments"}, {"name"}, {"tool_name", "arguments"})


def repair_call(name: str, arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """A call whose arguments ended up inside its name, put back together. Small models and
    XML-speaking chat templates emit `get_var({"date": "2026-04-30"})</parameter` as the
    *name*: refused as an unknown tool, a right call would be lost to a formatting slip."""
    cleaned = _TAG_DEBRIS.sub("", name or "").strip()
    match = _NAME_WITH_ARGS.match(cleaned)
    if not match:
        return cleaned or name, arguments
    tool, inner = match.group(1), (match.group(2) or match.group(3) or "").strip()
    if not inner:
        return tool, arguments
    try:
        parsed = json.loads(inner)
    except ValueError:
        return tool, arguments
    if not isinstance(parsed, dict):
        return tool, arguments
    # Arguments that are only another call's debris (keyed by a tool name) lose to the
    # ones the name carried; real arguments win.
    debris = all(key == tool or "__" in key for key in arguments)
    return tool, parsed if (not arguments or debris) else arguments


def recover_tool_calls(text: str, known: set[str]) -> tuple[list[dict[str, Any]], str]:
    """Tool calls a model printed as text although it was offered native tools. Accepted
    only when the name matches a tool actually offered — that is what keeps an ordinary
    answer containing JSON from being mistaken for a call. Returns (calls, leftover text)."""
    if not text or not known:
        return [], text
    candidates: list[tuple[str, str]] = []
    for match in re.finditer(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", text, re.S):
        candidates.append((match.group(0), match.group(1)))
    for match in re.finditer(r"```(?:json|tool_call)?\s*(\{.*?\})\s*```", text, re.S):
        candidates.append((match.group(0), match.group(1)))
    stripped = text.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        candidates.append((stripped, stripped))
    calls: list[dict[str, Any]] = []
    leftover = text
    for whole, payload in candidates:
        try:
            obj = json.loads(payload)
        except ValueError:
            continue
        if not isinstance(obj, dict) or not any(set(obj) >= keys for keys in _TOOL_KEYS):
            continue
        name = obj.get("name") or obj.get("tool") or obj.get("tool_name") or obj.get("function")
        if isinstance(name, dict):
            name = name.get("name")
        if not isinstance(name, str) or name not in known:
            continue
        calls.append({"id": f"rec_{len(calls)}", "name": name,
                      "arguments": _arguments(obj.get("arguments") or obj.get("parameters"))})
        leftover = leftover.replace(whole, "", 1)
    return calls, leftover.strip()


def _parse_calls(raw_calls: list[Any] | None) -> list[dict[str, Any]]:
    calls = []
    for index, call in enumerate(raw_calls or []):
        if not isinstance(call, dict):
            continue
        call_id, name, raw_args = _call_parts(call)
        name, args = repair_call(name, _arguments(raw_args))
        if name:
            calls.append({"id": call_id or f"call_{index}", "name": name, "arguments": args})
    return calls


def _unknown_caps() -> dict[str, Any]:
    return {"tools": None, "thinking": False, "think_levels": [], "vision": False,
            "context_length": 0, "declared": []}


# ---------------------------------------------------------------------------
# Clients
# ---------------------------------------------------------------------------

class LLMClient:
    """Shared plumbing: model selection, retries, the length check, tool-call parsing.
    Subclasses implement one request (`_complete`), capabilities and the model listing."""

    provider = "ollama"
    RETRY_DELAYS: tuple[float, ...] = (2.0, 5.0)    # two retries, backing off
    CONNECT_TIMEOUT_S = 10.0

    def __init__(self, cfg: LLMSettings, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.cfg = cfg
        self.base_url = self._normalise(cfg.base_url)
        self.model = cfg.model.strip()
        self.fast_model = cfg.fast_model.strip() or self.model
        self._transport = transport          # tests inject httpx.MockTransport
        self._caps: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _normalise(base_url: str) -> str:
        return (base_url or "").strip().rstrip("/")

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model)

    def is_remote(self, model: str | None = None) -> bool:
        return runs_remotely(model or self.model) or not _local_host(self.base_url)

    # ------------------------------------------------------------------ chat
    async def chat(self, messages: list[dict[str, Any]], *, model: str | None = None,
                   temperature: float | None = None, json_mode: bool = False,
                   json_schema: dict[str, Any] | None = None, tools: list[dict[str, Any]] | None = None,
                   max_tokens: int | None = None, timeout_s: float | None = None) -> LLMReply:
        """One completion. `tools` are OpenAI-style function definitions (both providers
        take them). Raises LLMNotConfigured / LLMError — never returns a fabricated reply."""
        if not self.base_url:
            raise LLMNotConfigured()
        model = (model or self.model).strip()
        if not model:
            raise LLMNotConfigured(NO_MODEL)
        reply = await self._complete(
            model, messages,
            temperature=self.cfg.temperature if temperature is None else temperature,
            json_mode=json_mode or json_schema is not None, json_schema=json_schema, tools=tools or None,
            max_tokens=max_tokens if max_tokens is not None else (self.cfg.max_tokens or None),
            timeout_s=float(timeout_s or self.cfg.timeout_s or 240))
        if reply.finish_reason == "length":
            raise LLMError(await self._length_message(model, max_tokens or self.cfg.max_tokens, reply))
        think = _THINK_BLOCK.match(reply.content)
        if think:   # reasoning models served without a separate reasoning field
            reply.thinking = (reply.thinking + "\n" + think.group(1)).strip()
            reply.content = reply.content[think.end():]
        if tools and not reply.tool_calls:
            known = {(t.get("function") or {}).get("name") for t in tools}
            recovered, leftover = recover_tool_calls(reply.content, {k for k in known if k})
            if recovered:
                reply.tool_calls, reply.content, reply.native_tools = recovered, leftover, False
        return reply

    async def _complete(self, model: str, messages: list[dict[str, Any]], *, temperature: float,
                        json_mode: bool, json_schema: dict[str, Any] | None,
                        tools: list[dict[str, Any]] | None, max_tokens: int | None,
                        timeout_s: float) -> LLMReply:
        raise NotImplementedError

    async def _length_message(self, model: str, max_tokens: int | None, reply: LLMReply) -> str:
        head = (f"The model '{model}' stopped at its token limit before finishing (finish reason: length), "
                f"so its answer is incomplete.")
        if max_tokens and reply.tokens_out >= max_tokens * 0.95:
            return (f"{head} It produced {reply.tokens_out} tokens against the output cap of {max_tokens}: "
                    f"raise Settings › AI Model › Max tokens (0 = no cap).")
        return f"{head} {await self._window_hint(model, reply)}"

    async def _window_hint(self, model: str, reply: LLMReply) -> str:
        return ("The prompt does not fit the server's context window: raise it on the server (vLLM "
                "--max-model-len, llama.cpp -c, LM Studio context length) or shorten the prompt "
                "(Settings › Engine › Context chars).")

    # ------------------------------------------------------------------ capabilities
    async def capabilities(self, model: str | None = None) -> dict[str, Any]:
        """{tools: bool|None, thinking, think_levels: [str], vision, context_length, declared}.
        `tools` is None when the server did not say."""
        raise NotImplementedError

    async def supports_tools(self, model: str | None = None) -> bool:
        """May the agent hand this model native tools? Settings › AI Model › Tool mode
        decides first; 'auto' trusts what the model declares (unknown → JSON fallback)."""
        if not self.configured or self.cfg.tool_mode == "json":
            return False
        if self.cfg.tool_mode == "native":
            return True
        return bool((await self.capabilities(model)).get("tools"))

    async def list_models(self) -> list[dict[str, Any]]:
        """[{name, size, local, tools, context, ...}]. Raises LLMError with the reason when
        the server cannot be listed (the route turns it into `{models: [], error}`)."""
        raise NotImplementedError

    # ------------------------------------------------------------------ connection test
    async def test(self) -> dict[str, Any]:
        """Settings › AI Model › Test: does the configured model answer, how fast, and what
        should the admin know about this setup. Never raises — failures are reported."""
        report: dict[str, Any] = {"ok": False, "latency_ms": 0, "model": self.model, "reply": "", "error": "",
                                  "provider": self.provider, "base_url": self.base_url,
                                  "local": not self.is_remote(), "tools": None, "context": None,
                                  "warnings": self._warnings()}
        try:
            if not self.base_url:
                raise LLMNotConfigured()
            if not self.model:
                names = [m["name"] for m in await self.list_models()]
                listing = f" Available: {', '.join(names[:10])}." if names else " The server lists no chat model."
                report["error"] = f"The server answers, but no model is selected.{listing}"
                return report
            started = time.monotonic()
            reply = await self.chat([{"role": "user", "content": "Reply with exactly the word OK."}],
                                    temperature=0.0, timeout_s=min(float(self.cfg.timeout_s or 240), 180.0))
            report["latency_ms"] = int((time.monotonic() - started) * 1000)
            report["reply"] = truncate(reply.content.strip(), 80)
            report["ok"] = bool(reply.content.strip())
            if not report["ok"]:
                report["error"] = ("The model answered with an empty reply"
                                   + (" (it only reasoned — turn Reasoning off)." if reply.thinking else "."))
            caps = await self.capabilities()
            report["tools"] = caps.get("tools")
            report["context"] = await self.context_window(self.model) or None
            if caps.get("tools") is False:
                report["warnings"].append(f"'{self.model}' does not declare tool calling: agent steps will use "
                                          f"the JSON decide-act fallback, which is slower and less reliable.")
            if self.cfg.think and caps.get("thinking"):
                report["warnings"].append("Reasoning is on: answers take several times longer. "
                                          "Turn it off unless a step really needs it.")
        except Exception as exc:  # noqa: BLE001 — a test reports, it never raises
            report["error"] = exc.message if isinstance(exc, FactoryError) else f"{type(exc).__name__}: {exc}"
        return report

    def _warnings(self) -> list[str]:
        warnings = []
        if self.provider == "openai" and urlsplit(self.base_url).port == 11434:
            warnings.append("This is Ollama's OpenAI-compatible endpoint: it ignores the context window and "
                            "silently truncates prompts at 4096 tokens. Choose the Ollama provider with "
                            "http://127.0.0.1:11434 instead.")
        if self.model and runs_remotely(self.model):
            warnings.append(f"'{self.model}' runs on Ollama's cloud, not on this machine: prompts and project data "
                            f"leave the machine, and cloud usage is quota-limited.")
        return warnings

    async def context_window(self, model: str | None = None) -> int:
        """The window this client asks for (0 = server default / unknown)."""
        return self.cfg.num_ctx or int((await self.capabilities(model)).get("context_length") or 0)

    # ------------------------------------------------------------------ HTTP
    def _headers(self) -> dict[str, str]:
        # Ollama behind an authenticating proxy takes the same bearer key as OpenAI servers.
        return {"Authorization": f"Bearer {self.cfg.api_key}"} if self.cfg.api_key else {}

    def _http(self, timeout_s: float) -> httpx.AsyncClient:
        # A client per call: the LLM client is rebuilt whenever settings change and calls
        # are seconds long, so pooling buys nothing and a stale pool on a swapped client
        # or a closed event loop (tests) costs a confusing failure.
        return httpx.AsyncClient(timeout=httpx.Timeout(timeout_s, connect=self.CONNECT_TIMEOUT_S),
                                 transport=self._transport, headers=self._headers())

    async def _send(self, method: str, path: str, *, body: dict[str, Any] | None = None,
                    timeout_s: float = 30.0, retry: bool = True) -> httpx.Response:
        """One exchange, retried on what a second attempt can fix: a refused or dropped
        connection, a 5xx, a 429. Other 4xx come back to the caller, who knows what they
        mean. A read timeout is not retried — the generation already took the whole budget."""
        url = f"{self.base_url}{path}"
        delays = self.RETRY_DELAYS if retry else ()
        last: httpx.Response | Exception | None = None
        for attempt in range(len(delays) + 1):
            try:
                async with self._http(timeout_s) as client:
                    resp = await client.request(method, url, json=body)
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.RemoteProtocolError) as exc:
                last = exc
            except httpx.TimeoutException as exc:
                raise LLMError(f"The model server at {self.base_url} did not answer within {timeout_s:g} s. "
                               f"A local model may be loading or overloaded — retry, raise Settings › AI Model "
                               f"› Timeout, or use a smaller model.") from exc
            except httpx.HTTPError as exc:
                raise LLMError(f"Request to {url} failed: {type(exc).__name__}: {exc}") from exc
            else:
                if resp.status_code < 500 and resp.status_code != 429:
                    return resp
                last = resp
            if attempt < len(delays):
                await asyncio.sleep(delays[attempt])
        if isinstance(last, httpx.Response):
            raise LLMError(self._http_error(last))
        raise LLMError(self._unreachable(last))

    def _unreachable(self, exc: Exception | None) -> str:
        return (f"Cannot reach the model server at {self.base_url} ({type(exc).__name__}). Is it running, and is "
                f"this its base URL? Check Settings › AI Model.")

    def _http_error(self, resp: httpx.Response) -> str:
        detail = _error_detail(resp)
        code = resp.status_code
        if code in (401, 403):
            return f"The model server refused the request (HTTP {code}): the API key is missing or wrong. {detail}"
        if code == 429:
            return (f"The model server is rate-limiting requests (HTTP 429): {detail} A cloud model may have "
                    f"exhausted its quota — pick a local model in Settings › AI Model.")
        if code >= 500:
            return f"The model server failed (HTTP {code}): {detail}"
        return f"The model server rejected the request (HTTP {code}): {detail}"

    @staticmethod
    def _body(resp: httpx.Response, what: str) -> dict[str, Any]:
        try:
            body = resp.json()
        except ValueError as exc:
            raise LLMError(f"{what} did not return JSON (HTTP {resp.status_code}): "
                           f"{truncate(resp.text, 200)}") from exc
        if not isinstance(body, dict):
            raise LLMError(f"{what} returned an unexpected payload: {truncate(json.dumps(body), 200)}")
        return body


def _error_detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return truncate(resp.text.strip(), 300) or "(empty body)"
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            err = err.get("message") or json.dumps(err)
        if err:
            return truncate(str(err), 300)
    return truncate(json.dumps(body), 300)


class OllamaClient(LLMClient):
    """Ollama's native API (`/api/chat`), the only route on which the context window can be set."""

    provider = "ollama"
    # Capped, not maximised: on a model running here, the KV cache of a large window is
    # what pushes it off the GPU (measured in AGENT on a 9 GB machine: 74 % GPU at 16k
    # against 62 % at 32k, several times slower). A cloud model has no such limit here.
    AUTO_CTX_CAP = 16384
    AUTO_CTX_CAP_REMOTE = 65536
    DEFAULT_CTX = 8192   # model declares nothing: still twice Ollama's own 4096 default

    @staticmethod
    def _normalise(base_url: str) -> str:
        # The native API lives at the root: a pasted ".../v1" or ".../api" would 404.
        url = (base_url or "").strip().rstrip("/")
        return re.sub(r"/(?:v1|api)(?:/chat)?$", "", url)

    async def context_window(self, model: str | None = None) -> int:
        if self.cfg.num_ctx:
            return self.cfg.num_ctx
        model = model or self.model
        declared = int((await self.capabilities(model)).get("context_length") or 0)
        if not declared:
            return self.DEFAULT_CTX
        return min(declared, self.AUTO_CTX_CAP_REMOTE if runs_remotely(model) else self.AUTO_CTX_CAP)

    async def capabilities(self, model: str | None = None) -> dict[str, Any]:
        """Asked of the server (`/api/show`), never guessed from the name. Cached per model;
        a failure is not cached, so a server that was down is asked again next time."""
        model = model or self.model
        if model in self._caps:
            return self._caps[model]
        try:
            resp = await self._send("POST", "/api/show", body={"model": model}, timeout_s=20, retry=False)
        except LLMError:
            return _unknown_caps()
        if resp.status_code >= 400:
            return _unknown_caps()
        body = self._body(resp, f"{self.base_url}/api/show")
        caps = _caps_from(body.get("capabilities"), body.get("model_info"), body.get("thinking"))
        self._caps[model] = caps
        return caps

    async def _complete(self, model, messages, *, temperature, json_mode, json_schema, tools, max_tokens,
                        timeout_s) -> LLMReply:
        caps = await self.capabilities(model)
        options: dict[str, Any] = {"temperature": temperature, "num_ctx": await self.context_window(model)}
        if max_tokens:
            options["num_predict"] = max_tokens
        payload: dict[str, Any] = {"model": model, "messages": _ollama_messages(messages),
                                   "stream": False, "options": options}
        if tools:
            payload["tools"] = tools
        if json_schema is not None:
            payload["format"] = json_schema
        elif json_mode:
            payload["format"] = "json"
        if caps["thinking"]:
            # Sent only to a model that declares thinking: Ollama rejects the field on the
            # others. Structured output never reasons — a thinking model given `format`
            # can put the whole answer in `thinking` and return empty content. A model
            # whose reasoning comes in levels (gpt-oss: low/medium/high) cannot turn it
            # off: it gets its middle level when reasoning is wanted, nothing otherwise.
            think = bool(self.cfg.think) and not json_mode
            levels = caps["think_levels"]
            if not levels:
                payload["think"] = think
            elif think:
                payload["think"] = levels[len(levels) // 2]
        started = time.monotonic()
        resp = await self._send("POST", "/api/chat", body=payload, timeout_s=timeout_s)
        if resp.status_code >= 400:
            raise LLMError(self._ollama_error(resp, model))
        body = self._body(resp, f"{self.base_url}/api/chat")
        if body.get("error"):
            raise LLMError(f"Ollama reported an error for '{model}': {truncate(str(body['error']), 300)}")
        message = body.get("message") or {}
        return LLMReply(content=message.get("content") or "", tool_calls=_parse_calls(message.get("tool_calls")),
                        tokens_in=int(body.get("prompt_eval_count") or 0),
                        tokens_out=int(body.get("eval_count") or 0),
                        latency_ms=int((time.monotonic() - started) * 1000), model=model,
                        finish_reason=body.get("done_reason") or "stop", thinking=message.get("thinking") or "")

    def _ollama_error(self, resp: httpx.Response, model: str) -> str:
        detail = _error_detail(resp)
        if resp.status_code == 404 and "not found" in detail.lower():
            return (f"Model '{model}' is not available on the Ollama server at {self.base_url} — run "
                    f"`ollama pull {model}` or pick another model in Settings › AI Model.")
        return self._http_error(resp)

    def _unreachable(self, exc: Exception | None) -> str:
        return (f"Cannot reach Ollama at {self.base_url} ({type(exc).__name__}). Start it with `ollama serve`, "
                f"or fix the base URL in Settings › AI Model.")

    async def _window_hint(self, model: str, reply: LLMReply) -> str:
        window = await self.context_window(model)
        return (f"The prompt ({reply.tokens_in} tokens) and the answer did not fit the context window of {window} "
                f"tokens: raise Settings › AI Model › Context window (0 = auto from the model) or shorten the "
                f"prompt (Settings › Engine › Context chars).")

    async def list_models(self) -> list[dict[str, Any]]:
        if not self.base_url:
            raise LLMNotConfigured()
        resp = await self._send("GET", "/api/tags", timeout_s=20, retry=False)
        if resp.status_code >= 400:
            raise LLMError(f"HTTP {resp.status_code} from {self.base_url}/api/tags — something is listening there, "
                           f"but it is not an Ollama server (the Ollama provider takes the base URL without /v1).")
        entries = self._body(resp, f"{self.base_url}/api/tags").get("models") or []
        # Recent Ollama versions list capabilities in /api/tags; older ones need /api/show,
        # which only reads the manifest (no model load), so asking it is cheap — bounded anyway.
        missing = [e.get("name") for e in entries if e.get("name") and e.get("capabilities") is None][:40]
        gate = asyncio.Semaphore(4)

        async def show(name: str) -> dict[str, Any]:
            async with gate:
                return await self.capabilities(name)

        shown = dict(zip(missing, await asyncio.gather(*(show(n) for n in missing))))
        models = []
        for entry in entries:
            name = str(entry.get("name") or "")
            if not name:
                continue
            caps = shown.get(name) or _caps_from(entry.get("capabilities"), None, None)
            declared = caps["declared"]
            if declared and "completion" not in declared:
                continue   # embedding-only models answer no chat
            details = entry.get("details") or {}
            context = caps["context_length"] or details.get("context_length") or None
            models.append({"name": name, "size": int(entry.get("size") or 0),
                           "local": not runs_remotely(name) and _local_host(self.base_url),
                           "tools": caps["tools"], "thinking": caps["thinking"] if declared else None,
                           "vision": caps["vision"] if declared else None, "context": context,
                           "family": details.get("family") or "", "parameters": details.get("parameter_size") or ""})
        models.sort(key=lambda m: (not m["local"], m["name"]))
        return models


def _caps_from(declared: Any, model_info: Any, thinking: Any) -> dict[str, Any]:
    if not isinstance(declared, list):
        return _unknown_caps()
    context = 0
    for key, value in (model_info or {}).items():
        if key.endswith("context_length") and isinstance(value, int):
            context = max(context, value)
    return {"tools": "tools" in declared, "thinking": "thinking" in declared,
            # Ollama lists the accepted `think` values: [false, true] is an on/off switch
            # (qwen3.5), ["low", "medium", "high"] are levels with no "off" (gpt-oss).
            "think_levels": [v for v in (thinking.get("values") or []) if isinstance(v, str)]
            if isinstance(thinking, dict) else [],
            "vision": "vision" in declared, "context_length": context, "declared": declared}


def _ollama_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Messages as Ollama takes them: tool-call arguments as objects, results by tool name."""
    out = []
    for message in messages:
        role = message.get("role") or "user"
        entry: dict[str, Any] = {"role": role, "content": message.get("content") or ""}
        if message.get("images"):
            entry["images"] = message["images"]
        if role == "assistant" and message.get("tool_calls"):
            entry["tool_calls"] = []
            for call in message["tool_calls"]:
                call_id, name, args = _call_parts(call)
                entry["tool_calls"].append({**({"id": call_id} if call_id else {}),
                                            "function": {"name": name, "arguments": _arguments(args)}})
        if role == "tool":
            entry["tool_name"] = message.get("tool_name") or message.get("name") or ""
            if message.get("tool_call_id"):
                entry["tool_call_id"] = message["tool_call_id"]
        out.append(entry)
    return out


class OpenAIClient(LLMClient):
    """Any server speaking the OpenAI chat-completions API: vLLM, LM Studio, llama.cpp,
    LocalAI, TGI. Optional fields a server refuses (structured output, tool_choice) are
    dropped once and remembered, so a server that does not know them still answers."""

    provider = "openai"

    def __init__(self, cfg: LLMSettings, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(cfg, transport=transport)
        self._dropped: set[str] = set()
        self._listing: list[dict[str, Any]] | None = None

    @staticmethod
    def _normalise(base_url: str) -> str:
        # The base must include /v1; a pasted endpoint URL is trimmed back to it.
        url = (base_url or "").strip().rstrip("/")
        return re.sub(r"/(?:chat/completions|completions|models)$", "", url)

    async def _models(self) -> list[dict[str, Any]]:
        if self._listing is not None:
            return self._listing
        if not self.base_url:
            raise LLMNotConfigured()
        resp = await self._send("GET", "/models", timeout_s=20, retry=False)
        if resp.status_code in (401, 403):
            raise LLMError(f"HTTP {resp.status_code} from {self.base_url}/models — the API key is missing "
                           f"or refused.")
        if resp.status_code >= 400:
            raise LLMError(f"HTTP {resp.status_code} from {self.base_url}/models — is this the OpenAI-compatible "
                           f"base URL? It usually ends in /v1.")
        try:
            body = resp.json()
        except ValueError as exc:
            raise LLMError(f"{self.base_url}/models did not return JSON.") from exc
        entries = body.get("data") if isinstance(body, dict) else body
        self._listing = [e for e in entries or [] if isinstance(e, dict) and e.get("id")]
        return self._listing

    @staticmethod
    def _context_of(entry: dict[str, Any]) -> int:
        for key in ("max_model_len", "context_length", "context_window", "max_context_length", "n_ctx"):
            if isinstance(entry.get(key), int) and entry[key] > 0:
                return entry[key]
        meta = entry.get("meta") or {}
        for key in ("n_ctx_train", "n_ctx", "context_length"):
            if isinstance(meta.get(key), int) and meta[key] > 0:
                return meta[key]
        return 0

    async def capabilities(self, model: str | None = None) -> dict[str, Any]:
        """This API declares little — the context window at best. Tool calling is assumed
        for chat models (Settings › AI Model › Test and Tool mode settle the rest)."""
        model = model or self.model
        if model in self._caps:
            return self._caps[model]
        try:
            entries = await self._models()
        except LLMError:
            return _unknown_caps()
        entry = next((e for e in entries if e.get("id") == model), {})
        caps = {**_unknown_caps(), "tools": not _EMBEDDING_NAME.search(model or ""),
                "context_length": self._context_of(entry)}
        self._caps[model] = caps
        return caps

    async def context_window(self, model: str | None = None) -> int:
        # The window is a server flag here (num_ctx cannot be sent); report what it declares.
        return int((await self.capabilities(model)).get("context_length") or 0) or self.cfg.num_ctx

    async def _complete(self, model, messages, *, temperature, json_mode, json_schema, tools, max_tokens,
                        timeout_s) -> LLMReply:
        payload: dict[str, Any] = {"model": model, "messages": _openai_messages(messages),
                                   "temperature": temperature, "stream": False}
        if max_tokens:
            payload["max_tokens"] = max_tokens
        if tools:
            payload["tools"] = tools
            if "tool_choice" not in self._dropped:
                payload["tool_choice"] = "auto"
        if json_mode and "response_format" not in self._dropped:
            payload["response_format"] = (
                {"type": "json_schema", "json_schema": {"name": "response", "schema": json_schema}}
                if json_schema is not None else {"type": "json_object"})
        started = time.monotonic()
        resp = await self._send("POST", "/chat/completions", body=payload, timeout_s=timeout_s)
        optional = [key for key in ("response_format", "tool_choice") if key in payload]
        if resp.status_code in (400, 422) and optional:
            # A field this server does not know: ask again without it, and remember.
            for key in optional:
                payload.pop(key)
                self._dropped.add(key)
            resp = await self._send("POST", "/chat/completions", body=payload, timeout_s=timeout_s)
        if resp.status_code >= 400:
            raise LLMError(self._http_error(resp))
        body = self._body(resp, f"{self.base_url}/chat/completions")
        if body.get("error"):
            raise LLMError(f"The model server reported an error: {_error_detail(resp)}")
        choice = (body.get("choices") or [{}])[0] or {}
        message = choice.get("message") or {}
        content = message.get("content") or ""
        if isinstance(content, list):   # content parts
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
        usage = body.get("usage") or {}
        return LLMReply(content=content, tool_calls=_parse_calls(message.get("tool_calls")),
                        tokens_in=int(usage.get("prompt_tokens") or 0),
                        tokens_out=int(usage.get("completion_tokens") or 0),
                        latency_ms=int((time.monotonic() - started) * 1000), model=model,
                        finish_reason=choice.get("finish_reason") or "stop",
                        thinking=message.get("reasoning_content") or message.get("reasoning") or "")

    async def list_models(self) -> list[dict[str, Any]]:
        self._listing = None   # an explicit listing is always fresh
        models = [{"name": str(e["id"]), "size": None, "local": not self.is_remote(str(e["id"])),
                   "tools": None, "context": self._context_of(e) or None}
                  for e in await self._models() if not _EMBEDDING_NAME.search(str(e["id"]))]
        models.sort(key=lambda m: m["name"])
        return models


def _openai_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Messages as chat-completions takes them: every tool call gets an id, results are
    threaded to it with `tool_call_id`, arguments become JSON strings. A result whose call
    was recovered from text (no native call to answer) is handed over as a user message."""
    out: list[dict[str, Any]] = []
    pending: list[str] = []
    counter = 0
    for message in messages:
        role = message.get("role")
        if role == "assistant" and message.get("tool_calls"):
            calls = []
            for call in message["tool_calls"]:
                call_id, name, args = _call_parts(call)
                counter += 1
                call_id = call_id or f"call_{counter}"
                calls.append({"id": call_id, "type": "function",
                              "function": {"name": name, "arguments": args if isinstance(args, str)
                                           else json.dumps(args or {}, ensure_ascii=False)}})
                pending.append(call_id)
            out.append({"role": "assistant", "content": message.get("content") or None, "tool_calls": calls})
            continue
        if role == "tool":
            if pending:
                call_id = str(message.get("tool_call_id") or "")
                if call_id in pending:
                    pending.remove(call_id)
                else:
                    call_id = pending.pop(0)
                out.append({"role": "tool", "tool_call_id": call_id, "content": str(message.get("content") or "")})
            else:
                name = message.get("tool_name") or message.get("name") or "a tool"
                out.append({"role": "user", "content": f"[Result of {name}]\n{message.get('content') or ''}"})
            continue
        out.append({"role": role if role in ("user", "assistant", "system") else "user",
                    "content": message.get("content") or ""})
    return out


class UnconfiguredLLM(LLMClient):
    """No server set yet. The app boots and every screen loads; anything that genuinely
    needs the model fails with the message that names the fix — never a made-up answer."""

    def __init__(self, cfg: LLMSettings | None = None) -> None:
        super().__init__(cfg or LLMSettings())
        self.provider = self.cfg.provider

    @property
    def configured(self) -> bool:
        return False

    def is_remote(self, model: str | None = None) -> bool:
        return False

    async def chat(self, messages: list[dict[str, Any]], **kwargs: Any) -> LLMReply:
        raise LLMNotConfigured()

    async def capabilities(self, model: str | None = None) -> dict[str, Any]:
        return _unknown_caps()

    async def list_models(self) -> list[dict[str, Any]]:
        raise LLMNotConfigured()


def make_llm(cfg: LLMSettings | dict[str, Any], *, transport: httpx.AsyncBaseTransport | None = None) -> LLMClient:
    """The client for these settings: UnconfiguredLLM when no base URL is set."""
    settings = cfg if isinstance(cfg, LLMSettings) else LLMSettings.model_validate(cfg or {})
    if not settings.base_url.strip():
        return UnconfiguredLLM(settings)
    if settings.provider == "openai":
        return OpenAIClient(settings, transport=transport)
    return OllamaClient(settings, transport=transport)
