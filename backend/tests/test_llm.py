"""LLM layer: both providers against httpx.MockTransport, the runtime's JSON repair and
metrics, the prompt library — plus one live smoke test against a local Ollama
(FACTORY_LIVE_LLM=1 to enable)."""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Callable

import httpx
import pytest

from app.errors import LLMError, LLMNotConfigured, NotFound
from app.events import EventBus
from app.llm import client as llm_client
from app.llm.client import (LLM_PRESETS, LLMReply, OllamaClient, OpenAIClient, UnconfiguredLLM, assistant_message,
                            make_llm, recover_tool_calls, repair_call, tool_message)
from app.llm.prompts import DEFAULT_PROMPTS
from app.llm.runtime import AIRuntime, schema_problem
from app.models import LLMSettings
from app.store import Store

LIVE_MODEL = "qwen3.5:4b"


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(llm_client.LLMClient, "RETRY_DELAYS", (0.0, 0.0))


def run(coro):
    return asyncio.run(coro)


class Recorder:
    """A MockTransport handler: routes by path, records every request body."""

    def __init__(self, routes: dict[str, Callable[[dict], httpx.Response]]) -> None:
        self.routes = routes
        self.calls: list[tuple[str, dict, httpx.Request]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        self.calls.append((request.url.path, body, request))
        return self.routes[request.url.path](body)

    def bodies(self, path: str) -> list[dict]:
        return [body for p, body, _ in self.calls if p == path]


def ollama(handler: Recorder, **cfg: Any) -> OllamaClient:
    settings = LLMSettings(**{"provider": "ollama", "base_url": "http://127.0.0.1:11434", "model": "qwen3.5:4b",
                              **cfg})
    client = make_llm(settings, transport=httpx.MockTransport(handler))
    assert isinstance(client, OllamaClient)
    return client


def openai(handler: Recorder, **cfg: Any) -> OpenAIClient:
    settings = LLMSettings(**{"provider": "openai", "base_url": "http://127.0.0.1:8000/v1/", "model": "local-model",
                              **cfg})
    client = make_llm(settings, transport=httpx.MockTransport(handler))
    assert isinstance(client, OpenAIClient)
    return client


def show(capabilities: list[str], context: int = 262144, thinking: Any = None) -> Callable[[dict], httpx.Response]:
    body = {"capabilities": capabilities, "model_info": {"qwen35.context_length": context}}
    if thinking:
        body["thinking"] = thinking
    return lambda _b: httpx.Response(200, json=body)


def ollama_reply(content: str = "", *, tool_calls: list | None = None, done_reason: str = "stop") -> httpx.Response:
    return httpx.Response(200, json={"model": "m", "message": {"role": "assistant", "content": content,
                                                               **({"tool_calls": tool_calls} if tool_calls else {})},
                                     "done": True, "done_reason": done_reason, "prompt_eval_count": 12,
                                     "eval_count": 3})


def openai_reply(content: str | None = "", *, tool_calls: list | None = None, finish: str = "stop") -> httpx.Response:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return httpx.Response(200, json={"choices": [{"message": message, "finish_reason": finish}],
                                     "usage": {"prompt_tokens": 20, "completion_tokens": 4}})


# ---------------------------------------------------------------------------
# Ollama
# ---------------------------------------------------------------------------

def test_ollama_json_mode_num_ctx_and_think() -> None:
    rec = Recorder({"/api/show": show(["completion", "tools", "thinking"]),
                    "/api/chat": lambda b: ollama_reply('{"ok": true}')})
    client = ollama(rec, base_url="http://127.0.0.1:11434/v1/", think=True)   # a pasted /v1 is trimmed
    reply = run(client.chat([{"role": "user", "content": "hi"}], json_mode=True, max_tokens=50))
    assert reply.content == '{"ok": true}' and reply.tokens_in == 12 and reply.tokens_out == 3
    body = rec.bodies("/api/chat")[0]
    assert rec.calls[-1][2].url == "http://127.0.0.1:11434/api/chat"
    assert body["format"] == "json" and body["stream"] is False
    assert body["options"] == {"temperature": 0.2, "num_ctx": 16384, "num_predict": 50}   # min(262144, 16k)
    assert body["think"] is False          # structured output never reasons, even with think on

    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    run(client.chat([{"role": "user", "content": "hi"}], json_schema=schema))
    run(client.chat([{"role": "user", "content": "hi"}]))
    second, third = rec.bodies("/api/chat")[1:]
    assert second["format"] == schema
    assert "format" not in third and third["think"] is True
    assert len(rec.bodies("/api/show")) == 1   # capabilities cached


def test_ollama_context_window_rules() -> None:
    rec = Recorder({"/api/show": show(["completion"], context=0), "/api/chat": lambda b: ollama_reply("x")})
    run(ollama(rec).chat([{"role": "user", "content": "hi"}]))
    assert rec.bodies("/api/chat")[0]["options"]["num_ctx"] == 8192        # nothing declared
    assert "think" not in rec.bodies("/api/chat")[0]                       # model does not declare thinking

    levels = {"values": ["low", "medium", "high"], "default": "medium"}
    rec = Recorder({"/api/show": show(["completion", "thinking"], context=131072, thinking=levels),
                    "/api/chat": lambda b: ollama_reply("x")})
    run(ollama(rec, model="gpt-oss:120b-cloud").chat([{"role": "user", "content": "hi"}]))
    run(ollama(rec, model="gpt-oss:120b-cloud", think=True).chat([{"role": "user", "content": "hi"}]))
    off, on = rec.bodies("/api/chat")
    assert off["options"]["num_ctx"] == 65536 and "think" not in off       # cloud cap; levels have no "off"
    assert on["think"] == "medium"

    # Current Ollama lists qwen3.5's switch as values [false, true]: it must still be turned off.
    rec = Recorder({"/api/show": show(["completion", "thinking"], thinking={"values": [False, True], "default": True}),
                    "/api/chat": lambda b: ollama_reply("x")})
    run(ollama(rec).chat([{"role": "user", "content": "hi"}]))
    assert rec.bodies("/api/chat")[0]["think"] is False

    rec = Recorder({"/api/show": show(["completion"]), "/api/chat": lambda b: ollama_reply("x")})
    run(ollama(rec, num_ctx=8192).chat([{"role": "user", "content": "hi"}]))
    assert rec.bodies("/api/chat")[0]["options"]["num_ctx"] == 8192        # explicit setting wins


def test_ollama_tool_calls_dict_arguments_and_repair() -> None:
    calls = [{"function": {"name": "jira__search", "arguments": {"jql": "project = MCPF"}}},
             {"function": {"name": 'get_var({"date": "2026-04-30"})</parameter', "arguments": {}}}]
    rec = Recorder({"/api/show": show(["completion", "tools"]),
                    "/api/chat": lambda b: ollama_reply("", tool_calls=calls)})
    tools = [{"type": "function", "function": {"name": "jira__search", "parameters": {"type": "object"}}}]
    reply = run(ollama(rec).chat([{"role": "user", "content": "find"}], tools=tools))
    assert reply.tool_calls == [{"id": "call_0", "name": "jira__search", "arguments": {"jql": "project = MCPF"}},
                                {"id": "call_1", "name": "get_var", "arguments": {"date": "2026-04-30"}}]
    assert rec.bodies("/api/chat")[0]["tools"] == tools

    # The conversation helpers round-trip through the Ollama message format.
    history = [{"role": "user", "content": "find"}, assistant_message(reply),
               tool_message(reply.tool_calls[0], '{"issues": []}')]
    run(ollama(rec).chat(history, tools=tools))
    sent = rec.bodies("/api/chat")[-1]["messages"]
    assert sent[1]["tool_calls"][0]["function"] == {"name": "jira__search", "arguments": {"jql": "project = MCPF"}}
    assert sent[2] == {"role": "tool", "content": '{"issues": []}', "tool_name": "jira__search",
                       "tool_call_id": "call_0"}


def test_tool_call_recovered_from_text() -> None:
    text = 'I will search.\n<tool_call>{"name": "jira__search", "arguments": {"jql": "x"}}</tool_call>'
    rec = Recorder({"/api/show": show(["completion", "tools"]), "/api/chat": lambda b: ollama_reply(text)})
    tools = [{"type": "function", "function": {"name": "jira__search", "parameters": {}}}]
    reply = run(ollama(rec).chat([{"role": "user", "content": "go"}], tools=tools))
    assert reply.native_tools is False and reply.content == "I will search."
    assert reply.tool_calls == [{"id": "rec_0", "name": "jira__search", "arguments": {"jql": "x"}}]
    # Only offered tools are recovered: an answer containing JSON stays an answer.
    assert recover_tool_calls('{"name": "other", "arguments": {}}', {"jira__search"}) == \
        ([], '{"name": "other", "arguments": {}}')
    assert repair_call("<function=create_issue", {}) == ("create_issue", {})


def test_think_block_is_split_from_content() -> None:
    rec = Recorder({"/api/show": show(["completion"]), "/api/chat": lambda b: ollama_reply("<think>hmm</think>\nOK")})
    reply = run(ollama(rec).chat([{"role": "user", "content": "x"}]))
    assert reply.content == "OK" and reply.thinking == "hmm"


def test_length_finish_is_an_error_naming_the_limit() -> None:
    rec = Recorder({"/api/show": show(["completion"], context=4096),
                    "/api/chat": lambda b: ollama_reply("partial", done_reason="length")})
    with pytest.raises(LLMError) as caught:
        run(ollama(rec).chat([{"role": "user", "content": "x"}]))
    assert "context window of 4096 tokens" in caught.value.message

    rec = Recorder({"/v1/chat/completions": lambda b: openai_reply("partial", finish="length"),
                    "/v1/models": lambda b: httpx.Response(200, json={"data": []})})
    with pytest.raises(LLMError) as caught:
        run(openai(rec).chat([{"role": "user", "content": "x"}], max_tokens=4))
    assert "output cap of 4" in caught.value.message


def test_retries_on_5xx_429_and_connect_errors() -> None:
    attempts = {"n": 0}

    def flaky(_body: dict) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(503 if attempts["n"] == 1 else 429, json={"error": "busy"}) if attempts["n"] < 3 \
            else ollama_reply("finally")

    rec = Recorder({"/api/show": show(["completion"]), "/api/chat": flaky})
    assert run(ollama(rec).chat([{"role": "user", "content": "x"}])).content == "finally"
    assert attempts["n"] == 3

    always = Recorder({"/api/show": show(["completion"]),
                       "/api/chat": lambda b: httpx.Response(429, json={"error": "Free usage limit"})})
    with pytest.raises(LLMError) as caught:
        run(ollama(always).chat([{"role": "user", "content": "x"}]))
    assert "HTTP 429" in caught.value.message and "Free usage limit" in caught.value.message
    assert len(always.bodies("/api/chat")) == 3     # 1 + 2 retries

    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    client = make_llm(LLMSettings(base_url="http://127.0.0.1:9", model="m"), transport=httpx.MockTransport(refused))
    with pytest.raises(LLMError) as caught:
        run(client.chat([{"role": "user", "content": "x"}]))
    assert "Cannot reach Ollama" in caught.value.message


def test_model_not_found_is_not_retried() -> None:
    rec = Recorder({"/api/show": lambda b: httpx.Response(404, json={"error": "not found"}),
                    "/api/chat": lambda b: httpx.Response(404, json={"error": "model 'nope' not found"})})
    with pytest.raises(LLMError) as caught:
        run(ollama(rec, model="nope").chat([{"role": "user", "content": "x"}]))
    assert "ollama pull nope" in caught.value.message and len(rec.bodies("/api/chat")) == 1


def test_ollama_list_models_uses_tags_capabilities_and_show_fallback() -> None:
    tags = {"models": [
        {"name": "qwen3.5:4b", "size": 3389983735, "capabilities": ["completion", "tools", "thinking"],
         "details": {"family": "qwen35", "parameter_size": "4.7B", "context_length": 262144}},
        {"name": "embeddinggemma:latest", "size": 621875917, "capabilities": ["embedding"], "details": {}},
        {"name": "gpt-oss:120b-cloud", "size": 384, "details": {}},        # older Ollama: no capabilities
    ]}
    rec = Recorder({"/api/tags": lambda b: httpx.Response(200, json=tags),
                    "/api/show": show(["completion", "tools", "thinking"], context=131072)})
    models = run(ollama(rec).list_models())
    assert [m["name"] for m in models] == ["qwen3.5:4b", "gpt-oss:120b-cloud"]     # embedding dropped, local first
    assert models[0] == {"name": "qwen3.5:4b", "size": 3389983735, "local": True, "tools": True, "thinking": True,
                         "vision": False, "context": 262144, "family": "qwen35", "parameters": "4.7B"}
    assert models[1]["local"] is False and models[1]["context"] == 131072
    assert [b["model"] for b in rec.bodies("/api/show")] == ["gpt-oss:120b-cloud"]


# ---------------------------------------------------------------------------
# OpenAI-compatible
# ---------------------------------------------------------------------------

def test_openai_json_object_dropped_on_400_and_remembered() -> None:
    def completions(body: dict) -> httpx.Response:
        if "response_format" in body:
            return httpx.Response(400, json={"error": {"message": "response_format not supported"}})
        return openai_reply('{"a": 1}')

    rec = Recorder({"/v1/chat/completions": completions})
    client = openai(rec, api_key="sk-test")
    reply = run(client.chat([{"role": "user", "content": "x"}], json_mode=True))
    assert reply.content == '{"a": 1}' and reply.tokens_in == 20 and reply.tokens_out == 4
    first, second = rec.bodies("/v1/chat/completions")
    assert first["response_format"] == {"type": "json_object"} and "response_format" not in second
    assert rec.calls[0][2].headers["authorization"] == "Bearer sk-test"
    run(client.chat([{"role": "user", "content": "x"}], json_mode=True))
    assert "response_format" not in rec.bodies("/v1/chat/completions")[2]    # not offered again


def test_openai_tool_calls_string_arguments_and_message_conversion() -> None:
    calls = [{"id": "c1", "type": "function", "function": {"name": "jira__create_issue",
                                                            "arguments": '{"summary": "Do it",}'}}]
    rec = Recorder({"/v1/chat/completions": lambda b: openai_reply(None, tool_calls=calls, finish="tool_calls")})
    tools = [{"type": "function", "function": {"name": "jira__create_issue", "parameters": {}}}]
    client = openai(rec, base_url="http://127.0.0.1:8000/v1/chat/completions")    # pasted endpoint trimmed
    reply = run(client.chat([{"role": "user", "content": "x"}], tools=tools))
    assert reply.tool_calls == [{"id": "c1", "name": "jira__create_issue", "arguments": {"summary": "Do it"}}]
    assert rec.bodies("/v1/chat/completions")[0]["tool_choice"] == "auto"

    history = [{"role": "system", "content": "s"}, assistant_message(reply), tool_message(reply.tool_calls[0], "done"),
               {"role": "tool", "tool_name": "orphan", "content": "text-recovered result"}]
    run(client.chat(history, tools=tools))
    sent = rec.bodies("/v1/chat/completions")[-1]["messages"]
    assert sent[1]["tool_calls"][0]["function"]["arguments"] == '{"summary": "Do it"}'
    assert sent[2] == {"role": "tool", "tool_call_id": "c1", "content": "done"}
    assert sent[3] == {"role": "user", "content": "[Result of orphan]\ntext-recovered result"}


def test_openai_list_models_and_warning_for_ollama_shim() -> None:
    rec = Recorder({"/v1/models": lambda b: httpx.Response(200, json={"data": [
        {"id": "qwen3.5:4b", "max_model_len": 32768}, {"id": "nomic-embed-text"}]}),
        "/v1/chat/completions": lambda b: openai_reply("OK")})
    client = openai(rec, base_url="http://127.0.0.1:11434/v1", model="qwen3.5:4b")
    assert run(client.list_models()) == [{"name": "qwen3.5:4b", "size": None, "local": True, "tools": None,
                                          "context": 32768}]
    report = run(client.test())
    assert report["ok"] is True and report["reply"] == "OK" and report["context"] == 32768
    assert any("4096 tokens" in w for w in report["warnings"])


# ---------------------------------------------------------------------------
# Unconfigured, presets, test()
# ---------------------------------------------------------------------------

def test_unconfigured_llm_fails_with_actionable_message() -> None:
    client = make_llm({"base_url": "", "model": "x"})
    assert isinstance(client, UnconfiguredLLM) and client.configured is False
    with pytest.raises(LLMNotConfigured) as caught:
        run(client.chat([{"role": "user", "content": "x"}]))
    assert "Settings › AI Model" in caught.value.message
    with pytest.raises(LLMNotConfigured):
        run(client.list_models())
    report = run(client.test())
    assert report["ok"] is False and "Settings › AI Model" in report["error"]
    assert run(client.supports_tools()) is False

    no_model = make_llm(LLMSettings(base_url="http://127.0.0.1:11434"), transport=httpx.MockTransport(
        lambda r: httpx.Response(200, json={"models": [{"name": "qwen3.5:4b", "capabilities": ["completion"]}]})))
    assert no_model.configured is False
    with pytest.raises(LLMNotConfigured) as caught:
        run(no_model.chat([{"role": "user", "content": "x"}]))
    assert "No model selected" in caught.value.message
    report = run(no_model.test())
    assert report["ok"] is False and "qwen3.5:4b" in report["error"]


def test_test_never_raises_and_reports_remote_models() -> None:
    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    client = make_llm(LLMSettings(base_url="http://127.0.0.1:9", model="glm-5.3-flash:cloud"),
                      transport=httpx.MockTransport(refused))
    report = run(client.test())
    assert report["ok"] is False and "Cannot reach Ollama" in report["error"]
    assert report["local"] is False and any("cloud" in w for w in report["warnings"])
    assert client.is_remote() and not make_llm(LLMSettings(base_url="http://127.0.0.1:1", model="m")).is_remote()


def test_supports_tools_follows_tool_mode() -> None:
    rec = Recorder({"/api/show": show(["completion"])})
    assert run(ollama(rec).supports_tools()) is False
    assert run(ollama(rec, tool_mode="native").supports_tools()) is True
    rec = Recorder({"/api/show": show(["completion", "tools"])})
    assert run(ollama(rec).supports_tools()) is True
    assert run(ollama(rec, tool_mode="json").supports_tools()) is False


def test_presets() -> None:
    assert {p["id"] for p in LLM_PRESETS} == {"ollama", "lmstudio", "vllm", "llamacpp", "custom"}
    assert all(set(p) >= {"id", "label", "provider", "base_url"} for p in LLM_PRESETS)
    assert all(p["base_url"].endswith("/v1") for p in LLM_PRESETS if p["provider"] == "openai" and p["base_url"])


# ---------------------------------------------------------------------------
# AIRuntime
# ---------------------------------------------------------------------------

class ScriptedLLM:
    """Stands in for LLMClient: returns queued replies (or raises queued errors)."""

    configured = True
    base_url = "http://fake"
    model = "main-model"
    fast_model = "fast-model"

    def __init__(self, *replies: str | Exception) -> None:
        self.replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    async def chat(self, messages, **kwargs) -> LLMReply:
        self.calls.append({"messages": messages, **kwargs})
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        return LLMReply(content=item, tokens_in=10, tokens_out=5, latency_ms=7, model=kwargs.get("model") or "")


class RuntimeContainer:
    def __init__(self, store: Store, llm: Any) -> None:
        self.store, self.llm, self.bus = store, llm, EventBus()


def test_ask_json_parses_tolerantly_and_records_the_call(store: Store) -> None:
    llm = ScriptedLLM('Sure!\n```json\n{"status": "ok", "reason": "fine",}\n```')
    ai = AIRuntime(RuntimeContainer(store, llm))
    value = run(ai.ask("critic", "judge this", json=True, fast=True, project_id="prj_1", step_id="s1"))
    assert value == {"status": "ok", "reason": "fine"}
    call = llm.calls[0]
    assert call["model"] == "fast-model" and call["json_mode"] is True and call["temperature"] == 0.0
    assert call["messages"][0] == {"role": "system", "content": DEFAULT_PROMPTS["critic"]["content"]}
    rows = store.list_llm_calls()
    assert len(rows) == 1 and rows[0]["role"] == "critic" and rows[0]["ok"] is True
    assert rows[0]["project_id"] == "prj_1" and rows[0]["tokens_in"] == 10
    assert store.llm_stats("prj_1") == {"calls": 1, "tokens_in": 10, "tokens_out": 5}


def test_ask_json_one_repair_round_trip(store: Store) -> None:
    schema = {"type": "object", "required": ["status"],
              "properties": {"status": {"type": "string", "enum": ["ok", "retry", "give_up"]}}}
    llm = ScriptedLLM('{"status": "maybe"}', '{"status": "retry"}')
    ai = AIRuntime(RuntimeContainer(store, llm))
    assert run(ai.ask("critic", "x", json_schema=schema)) == {"status": "retry"}
    assert llm.calls[0]["json_schema"] == schema
    assert "Return ONLY JSON matching" in llm.calls[0]["messages"][-1]["content"]
    repair = llm.calls[1]["messages"]
    assert repair[-2] == {"role": "assistant", "content": '{"status": "maybe"}'}
    assert "$.status must be one of" in repair[-1]["content"]
    assert len(store.list_llm_calls()) == 2

    llm = ScriptedLLM("no json here", "still none")
    with pytest.raises(LLMError) as caught:
        run(AIRuntime(RuntimeContainer(store, llm)).ask("estimator", "x", json=True))
    assert "after one repair attempt" in caught.value.message and len(llm.calls) == 2


def test_ask_text_prompt_override_and_errors_recorded(store: Store) -> None:
    store.put("prompts", {"id": "writer", "key": "writer", "content": "  Custom writer prompt.  "})
    llm = ScriptedLLM("  # Draft  ", LLMError("server down"), "")
    container = RuntimeContainer(store, llm)
    queue_events: list[dict] = []
    container.bus.emit = lambda type, **payload: queue_events.append({"type": type, **payload})
    ai = AIRuntime(container)
    assert run(ai.ask("ai_task", "write", prompt_key="writer")) == "# Draft"
    assert llm.calls[0]["messages"][0]["content"] == "Custom writer prompt."
    assert llm.calls[0]["model"] == "main-model" and llm.calls[0]["temperature"] is None
    with pytest.raises(LLMError):
        run(ai.ask("writer", "again"))
    with pytest.raises(LLMError) as caught:
        run(ai.ask("writer", "empty"))
    assert "empty answer" in caught.value.message
    rows = store.list_llm_calls()
    assert [r["ok"] for r in rows] == [True, False, True] and rows[1]["error"] == "server down"
    assert [e["type"] for e in queue_events] == ["llm.call"] * 3 and queue_events[1]["call"]["ok"] is False


def test_not_configured_is_raised_and_not_recorded(store: Store) -> None:
    ai = AIRuntime(RuntimeContainer(store, UnconfiguredLLM()))
    assert ai.configured is False
    with pytest.raises(LLMNotConfigured):
        run(ai.ask("writer", "x"))
    assert store.list_llm_calls() == []


def test_prompt_registry(store: Store) -> None:
    ai = AIRuntime(RuntimeContainer(store, ScriptedLLM()))
    assert ai.prompt("critic") == DEFAULT_PROMPTS["critic"]["content"]
    store.put("prompts", {"id": "prm_x", "key": "critic", "content": "Edited critic."})
    assert ai.prompt("critic") == "Edited critic."
    store.put("prompts", {"id": "prm_x", "key": "critic", "content": "   "})   # emptied → default again
    assert ai.prompt("critic") == DEFAULT_PROMPTS["critic"]["content"]
    with pytest.raises(NotFound):
        ai.prompt("no_such_prompt")


def test_runtime_chat_records_tool_turns(store: Store) -> None:
    llm = ScriptedLLM("thinking out loud")
    ai = AIRuntime(RuntimeContainer(store, llm))
    tools = [{"type": "function", "function": {"name": "t", "parameters": {}}}]
    reply = run(ai.chat("agent", [{"role": "user", "content": "go"}], tools=tools, step_id="s9"))
    assert reply.content == "thinking out loud" and llm.calls[0]["tools"] == tools
    assert store.list_llm_calls()[0]["step_id"] == "s9"


def test_default_prompt_keys_and_shape() -> None:
    assert list(DEFAULT_PROMPTS) == ["orchestrator", "writer", "rewriter", "critic", "spec_writer", "jira_writer",
                                     "test_designer", "estimator", "compliance_auditor", "dependency_analyst",
                                     "intake_analyst", "notifier", "approval_brief", "status_reporter",
                                     "risk_explainer", "copilot", "op_args_builder", "agent", "blueprint_designer",
                                     "briefing"]
    for key, prompt in DEFAULT_PROMPTS.items():
        assert set(prompt) == {"name", "description", "content"} and prompt["content"].strip(), key
        assert "{" not in prompt["content"] or "}" in prompt["content"], key
    rewriter = DEFAULT_PROMPTS["rewriter"]["content"]
    for style in ("professional", "concise", "executive", "technical", "friendly", "fix", "expand", "bullets", "jira"):
        assert f"- {style}:" in rewriter
    assert '"status": "ok" | "retry" | "give_up"' in DEFAULT_PROMPTS["critic"]["content"]
    for step_type in ("ai_task", "human_form", "approval", "estimation", "mcp_operation", "agent_task",
                      "quality_gate", "fan_out", "notify", "wait_for"):
        assert f"- {step_type}:" in DEFAULT_PROMPTS["blueprint_designer"]["content"]


def test_schema_problem() -> None:
    schema = {"type": "object", "required": ["checks"], "properties": {"checks": {"type": "array", "items": {
        "type": "object", "required": ["rule_id", "status"],
        "properties": {"status": {"enum": ["pass", "fail", "warn", "na"]}, "rule_id": {"type": "string"}}}}}}
    assert schema_problem({"checks": [{"rule_id": "r1", "status": "pass"}]}, schema) is None
    assert schema_problem({"checks": [{"rule_id": "r1", "status": "maybe"}]}, schema).startswith("$.checks[0].status")
    assert "missing the required key(s) checks" in schema_problem({}, schema)
    assert "must be of type object" in schema_problem([], schema)
    assert schema_problem(True, {"type": "integer"}) == "$ must be of type integer"


# ---------------------------------------------------------------------------
# Live smoke test (opt-in)
# ---------------------------------------------------------------------------

def _ollama_has(model: str) -> bool:
    try:
        tags = httpx.get("http://127.0.0.1:11434/api/tags", timeout=3).json().get("models") or []
    except (httpx.HTTPError, ValueError):
        return False
    return any(m.get("name") == model for m in tags)


@pytest.mark.skipif(os.environ.get("FACTORY_LIVE_LLM") != "1", reason="set FACTORY_LIVE_LLM=1 to call a real Ollama")
def test_live_ollama_smoke(store: Store) -> None:
    if not _ollama_has(LIVE_MODEL):
        pytest.skip(f"Ollama at 127.0.0.1:11434 is unreachable or lacks {LIVE_MODEL}")
    client = make_llm(LLMSettings(base_url="http://127.0.0.1:11434", model=LIVE_MODEL, num_ctx=8192,
                                  timeout_s=180, think=False))
    report = run(client.test())
    assert report["ok"] is True, report
    assert report["tools"] is True and report["context"] == 8192 and report["local"] is True

    ai = AIRuntime(RuntimeContainer(store, client))
    verdict = run(ai.ask("critic", "Step goal: create a Jira epic. Error: HTTP 401 Unauthorized from Jira. "
                                   "The service account token was revoked.", json=True, max_tokens=200))
    assert isinstance(verdict, dict) and verdict.get("status") in ("ok", "retry", "give_up"), verdict

    tools = [{"type": "function", "function": {
        "name": "get_time", "description": "Current time in a time zone.",
        "parameters": {"type": "object", "properties": {"timezone": {"type": "string"}}, "required": ["timezone"]}}}]
    reply = run(client.chat([{"role": "user", "content": "What time is it in Europe/Paris? Use the tool."}],
                            tools=tools, temperature=0.0, max_tokens=200))
    assert reply.tool_calls and reply.tool_calls[0]["name"] == "get_time", reply
    assert isinstance(reply.tool_calls[0]["arguments"], dict)
    assert len(store.list_llm_calls()) >= 1
