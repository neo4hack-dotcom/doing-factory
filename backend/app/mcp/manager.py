"""MCPManager: one live connection per connector, a flat tool index, and tool calls that
never raise (SPEC §7, §12).

Connections are persistent and lazy: the first call to a connector spawns or opens it,
later calls reuse it. A stdio server costs a process start and a handshake per
connection, and the Factory talks to the same few servers all day (watchers, operations,
agents), so per-call sessions would be paid for over and over. A connection is rebuilt
when it died, when the connector's launch settings changed, or once when a request could
not even be delivered. A request that was delivered and then failed is never resent:
it may have created a Jira issue already.

Everything above this layer sees tools as `<connector_slug>__<tool>` with a JSON-Schema
input and a `sensitive` flag, and gets the same result shape from every call.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import re
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from app.errors import FactoryError, MCPError, NotFound
from app.mcp.protocol import (HttpTransport, McpClient, McpTimeout, McpUnreachable, SseTransport, StdioTransport,
                              Transport, flatten_tool_result)
from app.util import now_iso, slugify, truncate

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

MAX_TEXT_CHARS = 200_000   # a ceiling against a runaway tool, not a context-window trim
DEFAULT_TIMEOUT_S = 60.0

# A tool whose name contains one of these verbs has a real-world effect unless the server
# declares it read-only. Matched on name tokens, never substrings: "put" must not match
# "input", nor "post" "compost". The task list, plus unambiguous write verbs (add a Jira
# comment, set a status…) whose absence would let a write through unconfirmed.
WRITE_VERBS = frozenset({
    "create", "update", "delete", "remove", "send", "post", "write", "insert", "drop", "notify", "publish",
    "escalate", "merge", "push", "commit", "upload", "transition", "register", "approve", "assign", "batch",
    "add", "set", "edit", "patch", "put", "upsert", "modify", "cancel", "archive", "rename", "move", "execute",
    "deploy", "grant", "revoke", "invite", "submit", "purge", "truncate", "kill", "restart", "install", "block",
    "reject",
})
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def tool_tokens(name: str) -> list[str]:
    """`jira_batchCreateIssues` → ["jira", "batch", "create", "issues"]."""
    return [t.lower() for t in re.split(r"[^A-Za-z0-9]+", _CAMEL.sub(" ", name or "")) if t]


def is_sensitive(name: str, annotations: dict[str, Any] | None = None) -> bool:
    """Needs a human confirmation under `approve_writes`: the server says it is
    destructive, or it does not say it is read-only and its name says it writes."""
    notes = annotations or {}
    if notes.get("destructiveHint"):
        return True
    return not notes.get("readOnlyHint") and bool(WRITE_VERBS.intersection(tool_tokens(name)))


def tool_info(raw: dict[str, Any]) -> dict[str, Any]:
    """A ToolInfo dict from one `tools/list` entry."""
    name = str(raw.get("name") or "")
    notes = raw.get("annotations") if isinstance(raw.get("annotations"), dict) else {}
    schema = raw.get("inputSchema") if isinstance(raw.get("inputSchema"), dict) else {}
    return {"name": name, "description": (raw.get("description") or notes.get("title") or "").strip(),
            "input_schema": schema or {"type": "object", "properties": {}},
            "sensitive": is_sensitive(name, notes), "read_only": bool(notes.get("readOnlyHint"))}


def _fingerprint(doc: dict[str, Any]) -> str:
    """What a live connection was built from: a change here means reconnect."""
    keys = ("transport", "command", "args", "env", "cwd", "url", "headers")
    return hashlib.sha256(json.dumps({k: doc.get(k) for k in keys}, sort_keys=True, default=str).encode()).hexdigest()


def _message(exc: BaseException) -> str:
    return exc.message if isinstance(exc, FactoryError) else f"{type(exc).__name__}: {exc}"


def _json_or_none(text: str) -> Any:
    stripped = text.strip()
    if stripped[:1] not in ("{", "["):
        return None
    try:
        return json.loads(stripped)
    except ValueError:
        return None


@dataclass
class _Live:
    client: McpClient
    fingerprint: str
    tools: list[dict[str, Any]]


class MCPManager:
    def __init__(self, container: "Container") -> None:
        self.c = container
        self._live: dict[str, _Live] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    # ------------------------------------------------------------------ connectors
    def _connector(self, connector_id: str) -> dict[str, Any]:
        doc = self.c.store.get("connectors", connector_id) if connector_id else None
        if doc is None:
            raise NotFound(f"Unknown connector '{connector_id}' — it may have been deleted.")
        return doc

    def _lock(self, connector_id: str) -> asyncio.Lock:
        return self._locks.setdefault(connector_id, asyncio.Lock())

    @staticmethod
    def _transport(doc: dict[str, Any]) -> Transport:
        name = doc.get("name") or doc.get("id")
        if (doc.get("transport") or "http") == "stdio":
            command = (doc.get("command") or "").strip()
            if not command:
                raise MCPError(f"Connector '{name}' has no command configured — open Settings › Connectors.")
            return StdioTransport(command, doc.get("args") or [], doc.get("env") or {}, doc.get("cwd") or None)
        url = (doc.get("url") or "").strip()
        if not url:
            raise MCPError(f"Connector '{name}' has no URL configured — open Settings › Connectors.")
        if not url.startswith(("http://", "https://")):
            raise MCPError(f"Connector '{name}': the URL must start with http:// or https://.")
        headers = doc.get("headers") or {}
        if doc.get("transport") == "sse" or urlsplit(url).path.rstrip("/").endswith("/sse"):
            return SseTransport(url, headers)
        return HttpTransport(url, headers)

    async def _ensure(self, doc: dict[str, Any]) -> _Live:
        """The live connection for this connector, (re)connecting when needed."""
        cid = doc["id"]
        async with self._lock(cid):
            live = self._live.get(cid)
            fingerprint = _fingerprint(doc)
            if live is not None and live.client.alive and live.fingerprint == fingerprint:
                return live
            if live is not None:
                self._live.pop(cid, None)
                await _close_quietly(live.client)
            timeout = float(doc.get("timeout_s") or DEFAULT_TIMEOUT_S)
            client = McpClient(self._transport(doc), startup_timeout_s=timeout, call_timeout_s=timeout)
            try:
                await client.connect()
                tools = [tool_info(t) for t in await client.list_tools() if t.get("name")]
            except BaseException as exc:
                await _close_quietly(client)
                if isinstance(exc, Exception):
                    raise MCPError(f"Could not connect to '{doc.get('name') or cid}': {_message(exc)}") from exc
                raise
            live = _Live(client, fingerprint, tools)
            self._live[cid] = live
            return live

    async def _drop(self, connector_id: str, live: _Live | None = None) -> None:
        """Close the connection — only `live` if given, so a fresh one is never torn down
        by a caller still holding the old one."""
        async with self._lock(connector_id):
            current = self._live.get(connector_id)
            if current is None or (live is not None and current is not live):
                return
            self._live.pop(connector_id, None)
        await _close_quietly(current.client)

    async def disconnect(self, connector_id: str) -> None:
        await self._drop(connector_id)

    async def close_all(self) -> None:
        await asyncio.gather(*(self._drop(cid) for cid in list(self._live)), return_exceptions=True)

    # ------------------------------------------------------------------ test & tools
    async def test(self, connector_id: str) -> dict[str, Any]:
        """Reconnect from scratch, list the tools, persist status + tools on the connector
        and record a `connector.tested` event. Returns the stored connector (secrets in
        clear — the API masks them). On failure the last discovered tools are kept, and
        the status says the connector is down."""
        doc = self._connector(connector_id)
        await self._drop(connector_id)
        started = time.monotonic()
        status: dict[str, Any] = {"ok": False, "checked_at": now_iso(), "error": "", "latency_ms": 0,
                                  "server_name": "", "server_version": "", "tool_count": 0}
        tools: list[dict[str, Any]] | None = None
        try:
            live = await self._ensure(doc)
            info = live.client.server_info
            tools = live.tools
            status.update(ok=True, server_name=str(info.get("title") or info.get("name") or ""),
                          server_version=str(info.get("version") or ""), tool_count=len(tools))
        except Exception as exc:  # noqa: BLE001 — a test reports
            status["error"] = _message(exc)
        status["latency_ms"] = int((time.monotonic() - started) * 1000)
        if not doc.get("enabled", True):
            await self._drop(connector_id)   # testing a disabled connector must not leave it running
        saved = self._persist(connector_id, status=status, tools=tools)
        name = saved.get("name") or connector_id
        message = (f"Connector '{name}' tested: OK, {status['tool_count']} tools in {status['latency_ms']} ms"
                   if status["ok"] else f"Connector '{name}' test failed: {truncate(status['error'], 300)}")
        self.c.record_event("connector.tested", message,
                            data={"connector_id": connector_id, "ok": status["ok"], "tool_count": status["tool_count"],
                                  "latency_ms": status["latency_ms"], "error": status["error"]})
        return saved

    def _persist(self, connector_id: str, *, status: dict[str, Any] | None = None,
                 tools: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        doc = self._connector(connector_id)   # fresh copy: never clobber an edit made meanwhile
        if status is not None:
            doc["status"] = status
        if tools is not None:
            doc["tools"] = tools
        if not doc.get("slug"):
            doc["slug"] = slugify(doc.get("name")) or connector_id
        return self.c.store.put("connectors", doc)

    async def list_tools(self, connector_id: str, refresh: bool = False) -> list[dict[str, Any]]:
        """ToolInfo dicts. Without `refresh`: the live connection's tools, else those
        stored by the last test (no connection needed), else a lazy connect. With
        `refresh`: reconnect, re-list and persist. Raises MCPError when it cannot connect."""
        doc = self._connector(connector_id)
        live = self._live.get(connector_id)
        if not refresh:
            if live is not None and live.fingerprint == _fingerprint(doc):
                return list(live.tools)
            if doc.get("tools"):
                return list(doc["tools"])
        if not doc.get("enabled", True):
            raise MCPError(f"Connector '{doc.get('name') or connector_id}' is disabled — enable it in "
                           f"Settings › Connectors.")
        if refresh:
            await self._drop(connector_id)
        live = await self._ensure(doc)
        status = {**(doc.get("status") or {}), "ok": True, "error": "", "checked_at": now_iso(),
                  "tool_count": len(live.tools)}
        self._persist(connector_id, status=status, tools=live.tools)
        return list(live.tools)

    def tool_index(self, connector_ids: list[str] | None = None) -> list[dict[str, Any]]:
        """Every tool of every enabled connector (or of `connector_ids`), qualified as
        `<slug>__<tool>`. Uses live tool lists when connected, else the ones stored by the
        last test, so it never blocks on a connection. Two connectors with the same slug
        are told apart by a suffix rather than shadowing each other."""
        wanted = set(connector_ids) if connector_ids else None
        index: list[dict[str, Any]] = []
        used: set[str] = set()
        for doc in self.c.store.list("connectors"):
            cid = doc.get("id") or ""
            if not doc.get("enabled", True) or (wanted is not None and cid not in wanted):
                continue
            slug = doc.get("slug") or slugify(doc.get("name")) or cid
            if slug in used:
                slug = f"{slug}_{cid[-4:]}"
            used.add(slug)
            live = self._live.get(cid)
            tools = live.tools if live is not None and live.fingerprint == _fingerprint(doc) else doc.get("tools") or []
            for tool in tools:
                name = tool.get("name") or ""
                if not name:
                    continue
                index.append({"qualified": f"{slug}__{name}", "connector_id": cid,
                              "connector_name": doc.get("name") or cid, "name": name,
                              "description": tool.get("description") or "",
                              "input_schema": tool.get("input_schema") or {"type": "object", "properties": {}},
                              "sensitive": bool(tool.get("sensitive")), "read_only": bool(tool.get("read_only"))})
        return index

    def resolve(self, qualified: str) -> tuple[str, str] | None:
        """(connector_id, tool) for `slug__tool`, `slug.tool` or an unambiguous bare tool
        name. Ambiguous → None: guessing which of two same-named tools was meant is how a
        write lands in the wrong system."""
        needle = (qualified or "").strip()
        if not needle:
            return None
        index = self.tool_index()
        for candidate in (needle, needle.replace(".", "__", 1)):
            hit = [t for t in index if t["qualified"] == candidate]
            if len(hit) == 1:
                return hit[0]["connector_id"], hit[0]["name"]
        bare = needle.split("__")[-1]
        for same in (lambda t: t["name"] == bare, lambda t: t["name"].lower() == bare.lower()):
            hit = [t for t in index if same(t)]
            if len(hit) == 1:
                return hit[0]["connector_id"], hit[0]["name"]
            if hit:
                return None
        return None

    # ------------------------------------------------------------------ calls
    async def call_tool(self, connector_id: str, tool: str, args: dict[str, Any] | None,
                        timeout_s: float | None = None) -> dict[str, Any]:
        """Call one tool. NEVER raises: callers (operations, agents, the tool bench) need a
        result to show and reason about. `data` is the structured content, else the text
        parsed as JSON, else None; a tool-level failure is `is_error` with the server's text."""
        started = time.monotonic()
        out: dict[str, Any] = {"ok": False, "tool": tool, "text": "", "data": None, "is_error": False,
                               "latency_ms": 0, "error": ""}
        try:
            raw = await self._call(connector_id, tool, args, timeout_s)
        except Exception as exc:  # noqa: BLE001 — the contract is a result, not an exception
            out["error"] = _message(exc)
        else:
            text, structured = flatten_tool_result(raw)
            is_error = bool(raw.get("isError"))
            out.update(ok=not is_error, is_error=is_error, text=text[:MAX_TEXT_CHARS],
                       data=structured if structured is not None else _json_or_none(text))
            if len(text) > MAX_TEXT_CHARS:
                out["truncated"] = True
            if is_error:
                out["error"] = truncate(text, 2000) or "The tool reported an error without a message."
        out["latency_ms"] = int((time.monotonic() - started) * 1000)
        return out

    async def _call(self, connector_id: str, tool: str, args: Any, timeout_s: float | None) -> dict[str, Any]:
        doc = self.c.store.get("connectors", connector_id) if connector_id else None
        if doc is None:
            await self._drop(connector_id)
            raise MCPError(f"Unknown connector '{connector_id}' — it may have been deleted.")
        name = doc.get("name") or connector_id
        if not doc.get("enabled", True):
            raise MCPError(f"Connector '{name}' is disabled — enable it in Settings › Connectors.")
        if not tool:
            raise MCPError(f"No tool name given for connector '{name}'.")
        if args is not None and not isinstance(args, dict):
            raise MCPError(f"Arguments for '{tool}' must be a JSON object, not {type(args).__name__}.")
        timeout = float(timeout_s or doc.get("timeout_s") or DEFAULT_TIMEOUT_S)
        live = await self._ensure(doc)
        try:
            return await self._call_once(doc, live, tool, args or {}, timeout)
        except McpUnreachable:
            # Never delivered (the server died or restarted since the last call):
            # reconnect and send it once more.
            await self._drop(connector_id, live)
        live = await self._ensure(doc)
        try:
            return await self._call_once(doc, live, tool, args or {}, timeout)
        except McpUnreachable as exc:
            await self._drop(connector_id, live)
            raise MCPError(f"Connector '{name}' is unreachable: {exc.message}") from exc

    async def _call_once(self, doc: dict[str, Any], live: _Live, tool: str, args: dict[str, Any],
                         timeout: float) -> dict[str, Any]:
        name = doc.get("name") or doc["id"]
        try:
            return await live.client.call_tool(tool, args, timeout=timeout)
        except McpUnreachable:
            raise
        except McpTimeout as exc:
            if (doc.get("transport") or "http") == "stdio":
                # A stdio server works through requests one at a time and is still busy
                # with this one: the next call starts on a fresh process.
                await self._drop(doc["id"], live)
            raise MCPError(f"Tool '{tool}' on '{name}' did not answer within {timeout:g}s — raise the "
                           f"connector's timeout in Settings › Connectors if it is legitimately slow.") from exc
        except MCPError as exc:
            if not live.client.alive:
                await self._drop(doc["id"], live)
                raise MCPError(f"Connector '{name}' stopped during '{tool}': {exc.message}") from exc
            raise


async def _close_quietly(client: McpClient) -> None:
    with contextlib.suppress(Exception):
        await client.close()
