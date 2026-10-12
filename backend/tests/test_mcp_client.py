"""MCP client layer: the stdio fixture server driven through MCPManager, plus the HTTP and
legacy SSE transports against in-process fakes (httpx.MockTransport)."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.errors import NotFound
from app.events import EventBus
from app.mcp.manager import MCPManager, is_sensitive, tool_tokens
from app.mcp.protocol import (HttpTransport, McpClient, SseTransport, StdioTransport, flatten_tool_result,
                              inherited_env, iter_sse)
from app.store import Store

SERVER = Path(__file__).parent / "fixtures" / "echo_mcp_server.py"


class FakeContainer:
    """The slice of app.deps.Container the manager uses."""

    def __init__(self, store: Store) -> None:
        self.store = store
        self.bus = EventBus()

    def record_event(self, kind: str, message: str, *, actor: str = "system", project_id: str = "",
                     step_id: str = "", data: dict | None = None) -> dict:
        return self.store.add_event({"kind": kind, "message": message, "actor": actor, "project_id": project_id,
                                     "step_id": step_id, "data": data or {}})


def add_connector(store: Store, cid: str = "con_echo", **overrides: Any) -> dict:
    doc = {"id": cid, "name": "Echo Test", "transport": "stdio", "command": sys.executable,
           "args": [str(SERVER)], "env": {}, "enabled": True, "timeout_s": 20, "tools": [], "status": {}}
    doc.update(overrides)
    return store.put("connectors", doc)


def run_with(store: Store, scenario) -> Any:
    """Run `scenario(manager)` on a fresh manager and always close its connections."""
    async def main() -> Any:
        manager = MCPManager(FakeContainer(store))
        try:
            return await scenario(manager)
        finally:
            await manager.close_all()
    return asyncio.run(main())


# ---------------------------------------------------------------------------
# stdio through the manager
# ---------------------------------------------------------------------------

def test_test_discovers_paginated_tools_and_persists_them(store: Store) -> None:
    add_connector(store)
    saved = run_with(store, lambda m: m.test("con_echo"))
    assert saved["status"]["ok"] is True, saved["status"]
    assert saved["status"]["server_name"] == "Echo test server"
    assert saved["status"]["server_version"] == "0.1.0"
    names = [t["name"] for t in saved["tools"]]
    assert len(names) == 11 and names[0] == "echo" and names[-1] == "update_mirror"   # 3 pages of 4
    assert saved["slug"] == "echo_test"
    stored = store.get("connectors", "con_echo")
    assert stored["status"]["tool_count"] == 11 and len(stored["tools"]) == 11
    flags = {t["name"]: (t["sensitive"], t["read_only"]) for t in stored["tools"]}
    assert flags["echo"] == (False, True)
    assert flags["createItem"] == (True, False)        # camelCase write verb
    assert flags["flush_cache"] == (True, False)       # destructiveHint only
    assert flags["update_mirror"] == (False, True)     # write verb but declared read-only
    events = store.list_events(kinds=["connector.tested"])
    assert len(events) == 1 and events[0]["data"]["ok"] is True


def test_call_tool_text_structured_and_json_data(store: Store) -> None:
    add_connector(store)

    async def scenario(m: MCPManager):
        return (await m.call_tool("con_echo", "echo", {"text": "héllo"}),
                await m.call_tool("con_echo", "add", {"a": 2, "b": 3}),
                await m.call_tool("con_echo", "createItem", {}))

    echo, add, created = run_with(store, scenario)
    assert echo["ok"] and echo["text"] == "héllo" and echo["data"] is None and not echo["is_error"]
    assert set(echo) >= {"ok", "tool", "text", "data", "is_error", "latency_ms", "error"}
    assert add["data"] == {"sum": 5} and add["text"] == "2 + 3 = 5"
    assert created["data"] == {"ok": True, "tool": "createItem"}     # JSON text parsed


def test_tool_error_is_reported_not_raised(store: Store) -> None:
    add_connector(store)
    result = run_with(store, lambda m: m.call_tool("con_echo", "fail", {"message": "Project XYZ not found"}))
    assert result["ok"] is False and result["is_error"] is True
    assert result["error"] == "Project XYZ not found"


def test_slow_tool_times_out_then_next_call_works(store: Store) -> None:
    add_connector(store)

    async def scenario(m: MCPManager):
        slow = await m.call_tool("con_echo", "slow", {"seconds": 5}, timeout_s=0.5)
        after = await m.call_tool("con_echo", "echo", {"text": "still here"})
        return slow, after

    slow, after = run_with(store, scenario)
    assert slow["ok"] is False and "did not answer within 0.5s" in slow["error"]
    assert slow["latency_ms"] < 4000
    assert after["ok"] and after["text"] == "still here"    # fresh process, not stuck behind the sleeper


def test_crash_gives_readable_error_and_reconnects(store: Store) -> None:
    add_connector(store)

    async def scenario(m: MCPManager):
        crashed = await m.call_tool("con_echo", "crash", {"code": 3})
        after = await m.call_tool("con_echo", "echo", {"text": "back"})
        return crashed, after

    crashed, after = run_with(store, scenario)
    assert crashed["ok"] is False
    assert "exited (code 3)" in crashed["error"] and "boom: simulated crash" in crashed["error"]
    assert "Echo Test" in crashed["error"]
    assert after["ok"] and after["text"] == "back"


def test_dead_process_between_calls_is_resent_once(store: Store) -> None:
    add_connector(store)

    async def scenario(m: MCPManager):
        await m.call_tool("con_echo", "echo", {"text": "warm"})
        live = m._live["con_echo"]
        live.client.transport._proc.kill()          # the server dies while idle
        await live.client.transport._proc.wait()
        return await m.call_tool("con_echo", "echo", {"text": "again"})

    result = run_with(store, scenario)
    assert result["ok"] and result["text"] == "again"


def test_server_dying_at_startup_shows_its_stderr(store: Store) -> None:
    script = "import sys; sys.stderr.write('ModuleNotFoundError: no module named foo\\n'); sys.exit(2)"
    add_connector(store, args=["-c", script])
    saved = run_with(store, lambda m: m.test("con_echo"))
    assert saved["status"]["ok"] is False
    assert "exited (code 2)" in saved["status"]["error"] and "no module named foo" in saved["status"]["error"]


def test_ping_reports_a_dead_server() -> None:
    async def scenario():
        client = McpClient(StdioTransport(sys.executable, [str(SERVER)]), startup_timeout_s=10)
        await client.connect()
        try:
            before = await client.ping()
            client.transport._proc.kill()
            await client.transport._proc.wait()
            await asyncio.sleep(0.1)
            return before, await client.ping(), client.alive
        finally:
            await client.close()

    assert asyncio.run(scenario()) == (True, False, False)


def test_large_single_line_result(store: Store) -> None:
    add_connector(store)
    result = run_with(store, lambda m: m.call_tool("con_echo", "big", {"n": 300_000}))
    assert result["ok"] and len(result["text"]) == 200_000 and result.get("truncated") is True


def test_server_request_with_colliding_id_is_answered(store: Store) -> None:
    add_connector(store)
    result = run_with(store, lambda m: m.call_tool("con_echo", "ask_roots", {}))
    assert result["ok"], result
    assert result["data"] == {"client_answered": {"roots": []}}


def test_env_is_scrubbed_of_factory_settings_and_secrets(store: Store, monkeypatch) -> None:
    monkeypatch.setenv("FACTORY_SOMETHING", "app-setting")
    monkeypatch.setenv("MY_API_KEY", "secret")
    monkeypatch.setenv("HARMLESS_VAR", "visible")
    add_connector(store, env={"CONNECTOR_TOKEN": "given-explicitly"})
    names = ["FACTORY_SOMETHING", "MY_API_KEY", "HARMLESS_VAR", "CONNECTOR_TOKEN"]
    result = run_with(store, lambda m: m.call_tool("con_echo", "get_env", {"names": names}))
    assert result["data"] == {"FACTORY_SOMETHING": None, "MY_API_KEY": None, "HARMLESS_VAR": "visible",
                              "CONNECTOR_TOKEN": "given-explicitly"}
    assert "MY_API_KEY" not in inherited_env()


def test_unknown_disabled_and_misconfigured_connectors(store: Store) -> None:
    add_connector(store, "con_off", name="Off", enabled=False)
    add_connector(store, "con_bad", name="Bad", command="definitely-not-a-command-xyz")

    async def scenario(m: MCPManager):
        return (await m.call_tool("con_nope", "echo", {}), await m.call_tool("con_off", "echo", {}),
                await m.call_tool("con_bad", "echo", {}), await m.call_tool("con_off", "echo", "not a dict"),
                await m.test("con_bad"))

    unknown, disabled, bad, _, tested = run_with(store, scenario)
    assert unknown["ok"] is False and "Unknown connector 'con_nope'" in unknown["error"]
    assert disabled["ok"] is False and "disabled" in disabled["error"]
    assert bad["ok"] is False and "not on this machine's PATH" in bad["error"]
    assert tested["status"]["ok"] is False and "not on this machine's PATH" in tested["status"]["error"]
    with pytest.raises(NotFound):
        run_with(store, lambda m: m.test("con_nope"))


def test_config_change_reconnects(store: Store) -> None:
    add_connector(store)

    async def scenario(m: MCPManager):
        await m.call_tool("con_echo", "echo", {"text": "a"})
        first = m._live["con_echo"].client
        doc = store.get("connectors", "con_echo")
        store.put("connectors", {**doc, "env": {"HARMLESS_VAR": "changed"}})
        result = await m.call_tool("con_echo", "get_env", {"names": ["HARMLESS_VAR"]})
        return first, m._live["con_echo"].client, result

    first, second, result = run_with(store, scenario)
    assert first is not second and result["data"] == {"HARMLESS_VAR": "changed"}


def test_tool_index_and_resolve(store: Store) -> None:
    add_connector(store)
    run_with(store, lambda m: m.test("con_echo"))
    add_connector(store, "con_twin", name="Twin", tools=[{"name": "echo", "description": "Other echo"},
                                                         {"name": "only_here"}])
    add_connector(store, "con_same", name="Echo Test", tools=[{"name": "ping_it"}])   # same slug as con_echo
    manager = MCPManager(FakeContainer(store))
    index = manager.tool_index()
    qualified = {t["qualified"] for t in index}
    assert {"echo_test__echo", "twin__echo", "twin__only_here", "echo_test_same__ping_it"} <= qualified
    assert {t["connector_id"] for t in manager.tool_index(["con_twin"])} == {"con_twin"}
    assert manager.resolve("echo_test__add") == ("con_echo", "add")
    assert manager.resolve("twin.echo") == ("con_twin", "echo")
    assert manager.resolve("only_here") == ("con_twin", "only_here")
    assert manager.resolve("echo") is None                     # ambiguous: never guess
    assert manager.resolve("nope__missing") is None


def test_list_tools_uses_stored_then_refreshes(store: Store) -> None:
    add_connector(store, tools=[{"name": "stale_tool"}])

    async def scenario(m: MCPManager):
        return await m.list_tools("con_echo"), await m.list_tools("con_echo", refresh=True)

    stored, fresh = run_with(store, scenario)
    assert [t["name"] for t in stored] == ["stale_tool"]
    assert len(fresh) == 11 and store.get("connectors", "con_echo")["status"]["tool_count"] == 11


def test_sensitivity_tokens() -> None:
    assert tool_tokens("jira_batchCreateIssues") == ["jira", "batch", "create", "issues"]
    assert tool_tokens("getHTTPResponse") == ["get", "http", "response"]
    assert is_sensitive("jira_add_comment") and is_sensitive("register_mcp_server")
    assert not is_sensitive("validate_input")          # "put" is a token match, not a substring
    assert not is_sensitive("search_mcp_servers")
    assert not is_sensitive("delete_cache", {"readOnlyHint": True})
    assert is_sensitive("weather", {"destructiveHint": True})


def test_flatten_tool_result_converts_python_repr() -> None:
    text, structured = flatten_tool_result({"content": [{"type": "text", "text": "[{'id': 1, 'paid': None}]"}]})
    assert json.loads(text) == [{"id": 1, "paid": None}] and structured is None
    text, structured = flatten_tool_result({"content": [], "structuredContent": {"n": 1}})
    assert text == '{"n": 1}' and structured == {"n": 1}
    text, _ = flatten_tool_result({"content": [{"type": "image", "mimeType": "image/png"}]})
    assert text == "[image image/png]"


# ---------------------------------------------------------------------------
# Streamable HTTP (fake server)
# ---------------------------------------------------------------------------

class FakeHttpServer:
    """A streamable-HTTP MCP server: replies as SSE, expires its session once, and counts
    what it was sent so the client's headers and re-initialization can be checked."""

    def __init__(self) -> None:
        self.sessions: set[str] = set()
        self.seen: list[dict[str, Any]] = []
        self.deleted: list[str] = []
        self.expire_next = False
        self.counter = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        session = request.headers.get("mcp-session-id", "")
        if request.method == "DELETE":
            self.deleted.append(session)
            return httpx.Response(200)
        msg = json.loads(request.content)
        self.seen.append({"method": msg.get("method"), "session": session,
                          "version": request.headers.get("mcp-protocol-version", "")})
        if msg.get("method") == "initialize":
            self.counter += 1
            sid = f"s{self.counter}"
            self.sessions.add(sid)
            return httpx.Response(200, headers={"mcp-session-id": sid}, json={
                "jsonrpc": "2.0", "id": msg["id"],
                "result": {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                           "serverInfo": {"name": "fake-http", "version": "9"}}})
        if session not in self.sessions:
            return httpx.Response(404, text="unknown session")
        if "id" not in msg or "method" not in msg:
            return httpx.Response(202)
        if self.expire_next:
            self.expire_next = False
            self.sessions.discard(session)
            return httpx.Response(404, text="session expired")
        if msg["method"] == "tools/list":
            result = {"tools": [{"name": "hello", "inputSchema": {"type": "object"}}]}
        elif msg["method"] == "ping":
            result = {}
        else:
            result = {"content": [{"type": "text", "text": f"hi {msg['params']['arguments'].get('who')}"}]}
        body = (": keep-alive\n\n"
                'event: message\ndata: {"jsonrpc": "2.0", "method": "notifications/progress", "params": {}}\n\n'
                f"event: message\ndata: {json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': result})}\n\n")
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=body)


def test_http_transport_headers_sse_replies_and_session_reinit() -> None:
    server = FakeHttpServer()

    async def scenario():
        client = McpClient(HttpTransport("http://mcp.test/mcp", {"Authorization": "Bearer t", "X-Empty": ""},
                                         http_transport=httpx.MockTransport(server.handle)),
                           startup_timeout_s=5, call_timeout_s=5)
        await client.connect()
        tools = await client.list_tools()
        server.expire_next = True
        result = await client.call_tool("hello", {"who": "factory"})
        alive = await client.ping()
        await client.close()
        return client, tools, result, alive

    client, tools, result, alive = asyncio.run(scenario())
    assert client.server_info["name"] == "fake-http" and [t["name"] for t in tools] == ["hello"]
    assert flatten_tool_result(result)[0] == "hi factory"
    assert alive is True
    initialized = [s for s in server.seen if s["method"] == "notifications/initialized"]
    assert initialized and initialized[0]["version"] == "2025-06-18" and initialized[0]["session"] == "s1"
    assert [s["method"] for s in server.seen].count("initialize") == 2       # re-initialized after the 404
    call = [s for s in server.seen if s["method"] == "tools/call"]
    assert call[-1]["session"] == "s2"
    assert server.deleted == ["s2"]


def test_http_transport_error_messages() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="no")

    async def scenario():
        client = McpClient(HttpTransport("http://mcp.test/mcp", http_transport=httpx.MockTransport(refuse)),
                           startup_timeout_s=5)
        try:
            await client.connect()
        finally:
            await client.close()

    with pytest.raises(Exception) as caught:
        asyncio.run(scenario())
    assert "authentication refused" in str(caught.value)


# ---------------------------------------------------------------------------
# Legacy HTTP+SSE (fake server)
# ---------------------------------------------------------------------------

def test_sse_transport_endpoint_event_and_server_request() -> None:
    async def scenario():
        outbox: asyncio.Queue[str] = asyncio.Queue()
        answers: list[dict] = []

        async def stream():
            yield b"event: endpoint\ndata: /messages?session=abc\n\n"
            while True:
                chunk = await outbox.get()
                yield chunk.encode()

        def emit(message: dict) -> None:
            outbox.put_nowait(f"event: message\ndata: {json.dumps(message)}\n\n")

        async def handle(request: httpx.Request) -> httpx.Response:
            if request.method == "GET":
                return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=stream())
            assert request.url.path == "/messages" and request.url.params["session"] == "abc"
            msg = json.loads(request.content)
            if "method" not in msg:
                answers.append(msg)       # the client answering our server request
            elif msg["method"] == "initialize":
                emit({"jsonrpc": "2.0", "id": msg["id"], "result": {
                    "protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                    "serverInfo": {"name": "fake-sse"}}})
            elif msg["method"] == "tools/call":
                emit({"jsonrpc": "2.0", "id": msg["id"], "method": "ping"})   # colliding id, server request
                emit({"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [{"type": "text", "text": "pong"}]}})
            return httpx.Response(202)

        client = McpClient(SseTransport("http://mcp.test/sse", http_transport=httpx.MockTransport(handle)),
                           startup_timeout_s=5, call_timeout_s=5)
        try:
            await client.connect()
            result = await client.call_tool("anything", {})
            await asyncio.sleep(0.05)
            return client.server_info, client.negotiated_version, result, answers
        finally:
            await client.close()

    info, version, result, answers = asyncio.run(scenario())
    assert info["name"] == "fake-sse" and version == "2024-11-05"
    assert flatten_tool_result(result)[0] == "pong"
    assert answers and answers[0]["result"] == {}


def test_iter_sse_parsing() -> None:
    async def collect():
        async def lines():
            for line in ["event: endpoint", "data: /m", "", ": comment", "data: {\"a\":", "data: 1}", ""]:
                yield line
        return [pair async for pair in iter_sse(lines())]

    assert asyncio.run(collect()) == [("endpoint", "/m"), ("message", '{"a":\n1}')]
