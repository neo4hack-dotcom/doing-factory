"""A self-contained MCP client: JSON-RPC 2.0 over stdio, streamable HTTP or legacy
HTTP+SSE, protocol 2025-06-18 (SPEC §7).

Ported from the AGENT project (agent/backend/app/mcp/protocol.py) and written against the
protocol rather than wrapped around the SDK: one code path for every transport, and a
failure that shows the server's own stderr instead of an opaque SDK error.

Fixed while porting (see the AGENT reader report, §2.2):
1. A server-initiated request (it carries both `method` and `id`) is answered — `ping`,
   an empty `roots/list`, -32601 otherwise — and never mistaken for the reply to a
   pending client request whose id happens to collide.
2. Streamable HTTP sends `MCP-Protocol-Version` after initialize, DELETEs its session on
   close, and re-initializes once when the server has forgotten the session (404).
3. `ping()` reports a dead server, and `alive` says whether the transport can still carry
   a request (exited process, closed stream) so the manager knows when to reconnect.
4. SSE replies are read incrementally and the first matching response returns, so a
   server that keeps the stream open does not stall the call until its timeout.

Error classes tell the manager what is safe: McpUnreachable means the request never left
(reconnect and resend); McpTimeout and any other failure mean it may have run (a write
must not be sent twice).
"""
from __future__ import annotations

import ast
import asyncio
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import deque
from typing import Any, AsyncIterator
from urllib.parse import urljoin

import httpx

from app.errors import MCPError

PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "doing-factory", "title": "DOINg.AI Factory", "version": "1.0.0"}
# No client capabilities: the Factory exposes no roots, sampling or elicitation, and
# declaring one invites server requests nothing here would answer meaningfully.
CLIENT_CAPABILITIES: dict[str, Any] = {}
STDIO_LINE_LIMIT = 64 * 1024 * 1024
_MAX_TOOL_PAGES = 50

# Inherited variables a server process never gets: the Factory's own settings and
# anything named like a credential. A server that needs one is given it in its connector
# configuration, where it is masked on read and scoped to that server.
_WITHHELD = re.compile(r"^FACTORY_|PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL", re.IGNORECASE)
_INSTALL_HINTS = {"npx": "install Node.js (npx ships with npm)", "uvx": "install uv (uvx ships with it)",
                  "docker": "install Docker Desktop or the Docker engine"}


class McpRpcError(MCPError):
    """The server answered with a JSON-RPC error: it is alive and refused this request."""

    def __init__(self, message: str, code: Any = None) -> None:
        super().__init__(message)
        self.code = code


class McpTimeout(MCPError):
    """No reply in time. The request may still be running on the server."""


class McpUnreachable(MCPError):
    """The request never reached the server (dead process, refused connection): safe to
    resend after reconnecting."""


class McpSessionExpired(MCPError):
    """Streamable HTTP: the server no longer knows our session (404) — re-initialize."""


def inherited_env() -> dict[str, str]:
    """This process's environment minus what a server process has no business seeing."""
    return {k: v for k, v in os.environ.items() if not _WITHHELD.search(k)}


def server_request_reply(msg: dict[str, Any]) -> dict[str, Any]:
    """The JSON-RPC response to a server-initiated request."""
    method = msg.get("method")
    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg.get("id"), "result": {}}
    if method == "roots/list":
        return {"jsonrpc": "2.0", "id": msg.get("id"), "result": {"roots": []}}
    return {"jsonrpc": "2.0", "id": msg.get("id"),
            "error": {"code": -32601, "message": f"Method not supported by this client: {method}"}}


def _rpc_error(error: Any) -> McpRpcError:
    err = error if isinstance(error, dict) else {"message": str(error)}
    return McpRpcError(f"{err.get('message') or 'MCP error'} (code {err.get('code')})", err.get("code"))


async def iter_sse(lines: AsyncIterator[str]) -> AsyncIterator[tuple[str, str]]:
    """(event, data) pairs from an SSE line stream; multi-line data joined with newlines."""
    event, data = "", []
    async for raw in lines:
        line = raw.rstrip("\r")
        if not line:
            if data:
                yield event or "message", "\n".join(data)
            event, data = "", []
            continue
        if line.startswith(":"):
            continue   # comment / keep-alive
        name, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if name == "event":
            event = value
        elif name == "data":
            data.append(value)
    if data:
        yield event or "message", "\n".join(data)


def _http_problem(status: int, body: str, url: str) -> str:
    if status in (401, 403):
        return (f"HTTP {status} from {url} — authentication refused: check the connector's headers "
                f"(e.g. Authorization: Bearer …).")
    if status == 404:
        return f"HTTP 404 from {url} — no MCP endpoint at this URL (check the path, often /mcp)."
    if status in (405, 406):
        return (f"HTTP {status} from {url} — the server refused a streamable-HTTP request here. If it is a "
                f"legacy SSE server, set the connector's transport to SSE (URL usually ending in /sse).")
    return f"HTTP {status} from {url} — {body.strip()[:200] or '(empty body)'}"


# ---------------------------------------------------------------------------
# Transports
# ---------------------------------------------------------------------------

class Transport:
    """Send a request and get its result, or fire a notification."""

    protocol_version = ""   # negotiated version, set by McpClient after initialize

    async def start(self, timeout: float) -> None:
        raise NotImplementedError

    async def request(self, method: str, params: dict[str, Any] | None, timeout: float) -> dict[str, Any]:
        raise NotImplementedError

    async def notify(self, method: str, params: dict[str, Any] | None) -> None:
        raise NotImplementedError

    async def close(self) -> None:
        raise NotImplementedError

    def reset_session(self) -> None:
        """Forget server-side session state before a re-initialize (HTTP only)."""

    @property
    def alive(self) -> bool:
        return True

    @property
    def diagnostics(self) -> list[str]:
        return []


class _Multiplexed(Transport):
    """A channel where replies arrive asynchronously (stdio pipe, SSE stream) and are
    matched to waiting requests by id."""

    def __init__(self) -> None:
        self._pending: dict[int, asyncio.Future] = {}
        self._next_id = 0
        self._background: set[asyncio.Task] = set()

    async def _send(self, payload: dict[str, Any]) -> None:
        raise NotImplementedError

    def _dead_reason(self) -> str:
        return "The MCP connection is closed"

    def _dispatch(self, msg: Any) -> None:
        if not isinstance(msg, dict):
            return
        if "method" in msg:
            if msg.get("id") is not None:   # a server request: answer it, never touch our pending calls
                task = asyncio.create_task(self._answer(msg))
                self._background.add(task)
                task.add_done_callback(self._background.discard)
            return   # notifications (progress, logging, list_changed): nothing depends on them
        fut = self._pending.pop(msg.get("id"), None)
        if fut is None or fut.done():
            return
        if "error" in msg:
            fut.set_exception(_rpc_error(msg["error"]))
        else:
            fut.set_result(msg.get("result") or {})

    async def _answer(self, msg: dict[str, Any]) -> None:
        with contextlib.suppress(MCPError):
            await self._send(server_request_reply(msg))

    def _fail_pending(self, reason: str) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(MCPError(reason))
        self._pending.clear()

    async def request(self, method: str, params: dict[str, Any] | None, timeout: float) -> dict[str, Any]:
        if not self.alive:
            raise McpUnreachable(self._dead_reason())
        self._next_id += 1
        msg_id = self._next_id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        try:
            await self._send({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}})
        except BaseException:
            self._pending.pop(msg_id, None)
            raise
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            with contextlib.suppress(MCPError):   # tell the server to stop; best effort
                await self._send({"jsonrpc": "2.0", "method": "notifications/cancelled",
                                  "params": {"requestId": msg_id, "reason": "timeout"}})
            raise McpTimeout(f"'{method}' timed out after {timeout:g}s") from None

    async def notify(self, method: str, params: dict[str, Any] | None) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})


class StdioTransport(_Multiplexed):
    """Spawns the server as a child process and exchanges newline-delimited JSON-RPC.

    The child's stderr is drained into a ring buffer instead of being discarded: when a
    server fails to start or dies, its own error output is the only thing that explains
    why, and it is what the connector card shows.
    """

    def __init__(self, command: str, args: list[str] | None = None, env: dict[str, str] | None = None,
                 cwd: str | None = None) -> None:
        super().__init__()
        self.command = command
        self.args = [str(a) for a in args or []]
        self.env = env or {}
        self.cwd = cwd or None
        self._proc: asyncio.subprocess.Process | None = None
        self._stderr: deque[str] = deque(maxlen=100)
        self._readers: list[asyncio.Task] = []
        self._write_lock = asyncio.Lock()
        self._eof = False
        self._closed = False

    async def start(self, timeout: float) -> None:
        # The real environment (minus secrets) so `npx`/`uvx` resolve the way they do in
        # the user's shell; the connector's own variables win. UTF-8 for every child: a
        # Python server on Windows otherwise speaks cp1252 on its pipes.
        env = {"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", **inherited_env(),
               **{k: str(v) for k, v in self.env.items() if v != ""}}
        if self.cwd and not os.path.isdir(self.cwd):
            raise MCPError(f"The working directory '{self.cwd}' does not exist.")
        command, options = self.command, {}
        if sys.platform == "win32":
            # CreateProcess finds `.exe` alone: npx/uvx are `.cmd` launchers. No console window.
            command = shutil.which(self.command, path=env.get("PATH")) or self.command
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            self._proc = await asyncio.create_subprocess_exec(
                command, *self.args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, env=env, cwd=self.cwd,
                # One JSON-RPC message is one line and a result can be megabytes: the default
                # 64 KiB limit killed the reader on the first large result.
                limit=STDIO_LINE_LIMIT, **options)
        except NotImplementedError as exc:
            raise MCPError("This event loop cannot start local MCP servers. On Windows, start the API "
                           "without --reload.") from exc
        except FileNotFoundError as exc:
            hint = _INSTALL_HINTS.get(os.path.basename(self.command))
            remedy = f" Install it: {hint}." if hint else " Install it, or point the connector at another executable."
            raise MCPError(f"'{self.command}' is not on this machine's PATH.{remedy}") from exc
        except OSError as exc:
            raise MCPError(f"Could not start '{self.command}': {exc}") from exc
        stderr_reader = asyncio.create_task(self._read_stderr(self._proc))
        self._readers = [asyncio.create_task(self._read_stdout(self._proc, stderr_reader)), stderr_reader]

    @property
    def alive(self) -> bool:
        return (self._proc is not None and self._proc.returncode is None
                and not self._eof and not self._closed)

    async def _read_stdout(self, proc: asyncio.subprocess.Process, stderr_reader: asyncio.Task) -> None:
        assert proc.stdout
        while True:
            try:
                line = await proc.stdout.readline()
            except (ValueError, asyncio.LimitOverrunError):
                # A message longer than even the raised limit: fail whoever waits for it,
                # loudly, and keep reading — never leave a call hanging.
                self._fail_pending(f"The server sent a reply larger than {STDIO_LINE_LIMIT // 1_000_000} MB. "
                                   f"Ask for less: filter, aggregate or page the request.")
                continue
            if not line:
                break
            try:
                msg = json.loads(line.decode("utf-8", errors="replace"))
            except ValueError:
                continue   # banners and logs printed on stdout are not protocol
            self._dispatch(msg)
        # The process closed its stdout — it is exiting. Let stderr drain and the exit code
        # land so the failure names the cause, then fail everything still waiting.
        self._eof = True
        await asyncio.wait({stderr_reader}, timeout=1.0)
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        self._fail_pending(self._dead_reason())

    async def _read_stderr(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr
        while True:
            try:
                line = await proc.stderr.readline()
            except (ValueError, asyncio.LimitOverrunError):
                continue
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                self._stderr.append(text)

    def _dead_reason(self) -> str:
        code = self._proc.returncode if self._proc else None
        tail = " | ".join(list(self._stderr)[-4:])
        base = f"MCP server exited (code {code})" if code is not None else "MCP server closed its output stream"
        return f"{base}{': ' + tail if tail else ''}"

    async def _send(self, payload: dict[str, Any]) -> None:
        if not self.alive or not self._proc or not self._proc.stdin:
            raise McpUnreachable(self._dead_reason())
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        try:
            async with self._write_lock:
                self._proc.stdin.write(data)
                await self._proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as exc:
            raise McpUnreachable(self._dead_reason()) from exc

    async def close(self) -> None:
        self._closed = True
        for task in self._readers:
            task.cancel()
        self._readers = []
        self._fail_pending("The MCP connection was closed")
        proc = self._proc
        if proc is None or proc.returncode is not None:
            return
        with contextlib.suppress(Exception):
            if proc.stdin:
                proc.stdin.close()
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5)
        except (asyncio.TimeoutError, ProcessLookupError):
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
                await proc.wait()

    @property
    def diagnostics(self) -> list[str]:
        return list(self._stderr)


class HttpTransport(Transport):
    """Streamable HTTP: every JSON-RPC message is a POST; the reply is plain JSON or an SSE
    stream that is read only until the matching response arrives."""

    def __init__(self, url: str, headers: dict[str, str] | None = None, *,
                 http_transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.url = url
        self.headers = {k: str(v) for k, v in (headers or {}).items() if v not in ("", None)}
        self.session_id: str | None = None
        self._client: httpx.AsyncClient | None = None
        self._http_transport = http_transport
        self._next_id = 0
        self._log: deque[str] = deque(maxlen=50)
        self._background: set[asyncio.Task] = set()

    async def start(self, timeout: float) -> None:
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0), follow_redirects=True,
                                         transport=self._http_transport)

    @property
    def alive(self) -> bool:
        return self._client is not None

    def reset_session(self) -> None:
        self.session_id = None

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   **self.headers}
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        if self.protocol_version:
            headers["MCP-Protocol-Version"] = self.protocol_version
        return headers

    async def request(self, method: str, params: dict[str, Any] | None, timeout: float) -> dict[str, Any]:
        self._next_id += 1
        payload = {"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params or {}}
        try:
            msg = await asyncio.wait_for(self._post(payload, timeout), timeout=timeout)
        except asyncio.TimeoutError:
            raise McpTimeout(f"'{method}' timed out after {timeout:g}s") from None
        if msg is None:
            raise MCPError(f"'{method}' got no response from {self.url}")
        if "error" in msg:
            raise _rpc_error(msg["error"])
        return msg.get("result") or {}

    async def notify(self, method: str, params: dict[str, Any] | None) -> None:
        payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        try:
            await asyncio.wait_for(self._post(payload, 30.0), timeout=30.0)
        except asyncio.TimeoutError:
            raise McpTimeout(f"'{method}' notification timed out") from None

    async def _post(self, payload: dict[str, Any], timeout: float) -> dict[str, Any] | None:
        if self._client is None:
            raise McpUnreachable(f"The HTTP connection to {self.url} is closed")
        msg_id = payload.get("id")
        try:
            async with self._client.stream("POST", self.url, json=payload, headers=self._headers(),
                                           timeout=httpx.Timeout(timeout, connect=10.0)) as resp:
                session = resp.headers.get("mcp-session-id")
                if session:
                    self.session_id = session
                if resp.status_code == 202:
                    return None   # accepted notification / response
                if resp.status_code == 404 and self.session_id and payload.get("method") != "initialize":
                    raise McpSessionExpired(f"The server at {self.url} no longer knows this session")
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode("utf-8", errors="replace")
                    self._log.append(f"HTTP {resp.status_code}: {body[:200]}")
                    raise MCPError(_http_problem(resp.status_code, body, self.url))
                if resp.headers.get("content-type", "").startswith("text/event-stream"):
                    async for _event, data in iter_sse(resp.aiter_lines()):
                        found = self._take(_loads(data), msg_id)
                        if found is not None:
                            return found
                    return None
                body = (await resp.aread()).decode("utf-8", errors="replace")
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise McpUnreachable(f"Cannot reach the MCP server at {self.url}: {exc}") from exc
        except httpx.HTTPError as exc:
            raise MCPError(f"HTTP transport error talking to {self.url}: {type(exc).__name__}: {exc}") from exc
        if not body.strip():
            return None
        parsed = _loads(body)
        for msg in parsed if isinstance(parsed, list) else [parsed]:
            found = self._take(msg, msg_id)
            if found is not None:
                return found
        return None

    def _take(self, msg: Any, msg_id: Any) -> dict[str, Any] | None:
        """`msg` when it is the response we wait for; answers a server request on the side."""
        if not isinstance(msg, dict):
            return None
        if "method" in msg:
            if msg.get("id") is not None:
                task = asyncio.create_task(self._answer(msg))
                self._background.add(task)
                task.add_done_callback(self._background.discard)
            return None
        if msg_id is not None and msg.get("id") == msg_id and ("result" in msg or "error" in msg):
            return msg
        return None

    async def _answer(self, msg: dict[str, Any]) -> None:
        with contextlib.suppress(MCPError, asyncio.TimeoutError):
            await asyncio.wait_for(self._post(server_request_reply(msg), 30.0), timeout=30.0)

    async def close(self) -> None:
        client, self._client = self._client, None
        if client is None:
            return
        if self.session_id:   # let the server free the session; best effort
            with contextlib.suppress(httpx.HTTPError, asyncio.TimeoutError):
                await asyncio.wait_for(client.delete(self.url, headers=self._headers()), timeout=5)
        await client.aclose()

    @property
    def diagnostics(self) -> list[str]:
        return list(self._log)


class SseTransport(_Multiplexed):
    """Legacy HTTP+SSE (protocol 2024-11-05): one long-lived GET stream carries every
    server message; its first `endpoint` event names the URL requests are POSTed to."""

    def __init__(self, url: str, headers: dict[str, str] | None = None, *,
                 http_transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__()
        self.url = url
        self.headers = {k: str(v) for k, v in (headers or {}).items() if v not in ("", None)}
        self._http_transport = http_transport
        self._client: httpx.AsyncClient | None = None
        self._reader: asyncio.Task | None = None
        self._endpoint = ""
        self._ready = asyncio.Event()
        self._open = False
        self._closed_reason = ""
        self._log: deque[str] = deque(maxlen=50)

    async def start(self, timeout: float) -> None:
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0, read=None),
                                         follow_redirects=True, transport=self._http_transport)
        self._open = True
        self._reader = asyncio.create_task(self._read_stream())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            raise MCPError(f"No 'endpoint' event from {self.url} within {timeout:g}s — is this a legacy SSE "
                           f"MCP endpoint? A streamable-HTTP server needs the HTTP transport.") from None
        if not self._endpoint:
            raise MCPError(self._closed_reason or f"The SSE stream from {self.url} closed before it was ready")

    async def _read_stream(self) -> None:
        assert self._client is not None
        try:
            async with self._client.stream("GET", self.url, headers={"Accept": "text/event-stream",
                                                                     **self.headers}) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode("utf-8", errors="replace")
                    self._closed_reason = _http_problem(resp.status_code, body, self.url)
                    return
                async for event, data in iter_sse(resp.aiter_lines()):
                    if event == "endpoint":
                        self._endpoint = urljoin(self.url, data.strip())
                        self._ready.set()
                    elif event == "message":
                        self._dispatch(_loads(data))
            self._closed_reason = f"The SSE stream from {self.url} closed"
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            self._closed_reason = f"Cannot reach the MCP server at {self.url}: {exc}"
        except httpx.HTTPError as exc:
            self._closed_reason = f"The SSE stream from {self.url} failed: {type(exc).__name__}: {exc}"
        finally:
            self._open = False
            self._log.append(self._closed_reason or "SSE stream closed")
            self._ready.set()
            self._fail_pending(self._dead_reason())

    @property
    def alive(self) -> bool:
        return self._open and bool(self._endpoint)

    def _dead_reason(self) -> str:
        return self._closed_reason or f"The SSE connection to {self.url} is closed"

    async def _send(self, payload: dict[str, Any]) -> None:
        if not self.alive or self._client is None:
            raise McpUnreachable(self._dead_reason())
        try:
            resp = await self._client.post(self._endpoint, json=payload,
                                           headers={"Content-Type": "application/json", **self.headers})
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise McpUnreachable(f"Cannot reach the MCP server at {self._endpoint}: {exc}") from exc
        except httpx.HTTPError as exc:
            raise MCPError(f"HTTP transport error talking to {self._endpoint}: {type(exc).__name__}: {exc}") from exc
        if resp.status_code >= 400:
            self._log.append(f"HTTP {resp.status_code}: {resp.text[:200]}")
            raise MCPError(_http_problem(resp.status_code, resp.text, self._endpoint))

    async def close(self) -> None:
        if self._reader is not None:
            self._reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader
            self._reader = None
        self._open = False
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def diagnostics(self) -> list[str]:
        return list(self._log)


def _loads(text: str) -> Any:
    try:
        return json.loads(text)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class McpClient:
    """One live connection to one MCP server."""

    def __init__(self, transport: Transport, *, startup_timeout_s: float = 30.0, call_timeout_s: float = 60.0,
                 protocol_version: str = PROTOCOL_VERSION) -> None:
        self.transport = transport
        self.startup_timeout_s = startup_timeout_s
        self.call_timeout_s = call_timeout_s
        self.protocol_version = protocol_version
        self.server_info: dict[str, Any] = {}
        self.capabilities: dict[str, Any] = {}
        self.negotiated_version = ""
        self.connected_at = 0.0

    @property
    def alive(self) -> bool:
        return self.transport.alive

    @property
    def diagnostics(self) -> list[str]:
        return self.transport.diagnostics

    async def connect(self) -> dict[str, Any]:
        await self.transport.start(self.startup_timeout_s)
        return await self._handshake()

    async def _handshake(self) -> dict[str, Any]:
        result = await self.transport.request(
            "initialize", {"protocolVersion": self.protocol_version, "capabilities": CLIENT_CAPABILITIES,
                           "clientInfo": CLIENT_INFO}, self.startup_timeout_s)
        self.server_info = result.get("serverInfo") or {}
        self.capabilities = result.get("capabilities") or {}
        self.negotiated_version = result.get("protocolVersion") or self.protocol_version
        self.transport.protocol_version = self.negotiated_version
        await self.transport.notify("notifications/initialized", {})
        self.connected_at = time.time()
        return result

    async def request(self, method: str, params: dict[str, Any] | None, timeout: float) -> dict[str, Any]:
        """A request, re-initializing once if an HTTP server dropped our session."""
        try:
            return await self.transport.request(method, params, timeout)
        except McpSessionExpired:
            self.transport.reset_session()
            await self._handshake()
            return await self.transport.request(method, params, timeout)

    async def list_tools(self) -> list[dict[str, Any]]:
        """Every tool, following `nextCursor`. A server that does not declare tools and
        refuses the method has none; one that declares them must answer."""
        tools: list[dict[str, Any]] = []
        cursor: str | None = None
        seen: set[str] = set()
        for _ in range(_MAX_TOOL_PAGES):
            try:
                result = await self.request("tools/list", {"cursor": cursor} if cursor else {},
                                            self.startup_timeout_s)
            except McpRpcError:
                if "tools" in self.capabilities:
                    raise
                return []
            tools.extend(t for t in result.get("tools") or [] if isinstance(t, dict))
            cursor = result.get("nextCursor")
            if not cursor or cursor in seen:
                break
            seen.add(cursor)
        return tools

    async def call_tool(self, name: str, arguments: dict[str, Any] | None,
                        timeout: float | None = None) -> dict[str, Any]:
        return await self.request("tools/call", {"name": name, "arguments": arguments or {}},
                                  timeout or self.call_timeout_s)

    async def ping(self) -> bool:
        """True when the server answers. `ping` is optional in the spec: a server that
        refuses the method is still alive — only a transport failure counts as down."""
        try:
            await self.request("ping", {}, 10.0)
            return True
        except McpRpcError:
            return True
        except MCPError:
            return False

    async def close(self) -> None:
        await self.transport.close()


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

def flatten_tool_result(result: dict[str, Any]) -> tuple[str, Any]:
    """An MCP tool result as (readable text, structuredContent). Nothing is invented: a
    result that is only an image or a resource link says exactly that."""
    structured = result.get("structuredContent")
    chunks: list[str] = []
    for block in result.get("content") or []:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text":
            chunks.append(block.get("text") or "")
        elif kind == "resource":
            resource = block.get("resource") or {}
            chunks.append(resource.get("text") or f"[resource {resource.get('uri', 'unknown')}]")
        elif kind == "resource_link":
            chunks.append(f"[resource link {block.get('uri', 'unknown')}]")
        elif kind in ("image", "audio"):
            chunks.append(f"[{kind} {block.get('mimeType', 'unknown type')}]")
        else:
            chunks.append(f"[{kind or 'unknown'} content]")
    text = "\n".join(c for c in chunks if c).strip()
    if structured is not None and not text:
        text = json.dumps(structured, ensure_ascii=False)
    return _as_json(text), structured


def _as_json(text: str) -> str:
    """Re-encode a Python repr as JSON, leaving everything else untouched. Plenty of
    servers reply with `str(rows)` — `[{'id': 1, 'paid': None}]` — which nothing
    downstream can parse; `literal_eval` reads literals only, never code."""
    stripped = text.strip()
    if not (stripped[:1] in ("[", "{") and len(stripped) < 200_000):
        return text
    try:
        json.loads(stripped)
        return text   # already JSON
    except ValueError:
        pass
    try:
        value = ast.literal_eval(stripped)
    except (ValueError, SyntaxError, MemoryError, RecursionError):
        return text
    if not isinstance(value, (list, dict)):
        return text
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return text
