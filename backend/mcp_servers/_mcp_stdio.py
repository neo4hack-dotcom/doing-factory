"""A small MCP server over stdio, standard library only.

Ported from the AGENT project (`agent/mcp_servers/_mcp_stdio.py`); the two bundled sandbox
servers (DOINg.AI Portfolio, Jira) sit on top of it. Hand-rolled rather than taken from an
SDK: the protocol surface a tool server needs is small, a cold start costs ~10 ms instead of
~0.5 s for an SDK import (the Factory spawns a stdio server per operation), and one readable
file is an attack surface you can actually review.

Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout, MCP 2025-06-18. Anything written to
stdout that is not a protocol message corrupts the stream, so diagnostics go to stderr — the
Factory keeps its tail and shows it on the connector card.

Also here: `JsonState`, the on-disk JSON "world" both sandboxes keep their data in.
"""
from __future__ import annotations

import inspect
import json
import os
import re
import sys
import traceback
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

try:   # POSIX
    import fcntl
except ImportError:   # pragma: no cover - Windows
    fcntl = None   # type: ignore[assignment]
try:   # Windows
    import msvcrt
except ImportError:
    msvcrt = None   # type: ignore[assignment]

PROTOCOL_VERSION = "2025-06-18"
# Older revisions a client may still ask for. The tool surface used here is identical in
# all of them, so echoing the client's version is honest.
SUPPORTED_VERSIONS = (PROTOCOL_VERSION, "2025-03-26", "2024-11-05")


def log(message: str) -> None:
    """Diagnostics go to stderr. stdout is the protocol channel and nothing else."""
    print(message, file=sys.stderr, flush=True)


class ToolError(Exception):
    """Raise from a tool to report a failure the caller can act on.

    It becomes an `isError` result whose text is `{"error": message, **details}` — details
    carry the hint that makes the next attempt right (allowed values, known ids…).
    """

    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message)
        self.payload = {"error": message, **details}


class McpServer:
    def __init__(self, name: str, version: str, title: str = "", instructions: str = "") -> None:
        self.name = name
        self.version = version
        self.title = title or name
        self.instructions = instructions
        self._tools: dict[str, dict] = {}
        self._handlers: dict[str, Callable[..., Any]] = {}

    def tool(self, name: str, description: str, schema: dict, *, read_only: bool = False,
             destructive: bool = False) -> Callable:
        """Register one tool.

        `read_only` publishes readOnlyHint. It is not decoration: a caller may only reuse an
        earlier result, or run a call without asking a human, for a tool that says calling it
        changes nothing. Default false, because a tool that has not thought about it is not
        read-only. `destructive` (destructiveHint) is only meaningful for a write tool: false
        says the write is additive or reversible (create, comment, transition).
        """
        annotations: dict[str, Any] = {"title": name.replace("_", " ").title(), "readOnlyHint": read_only}
        if not read_only:
            annotations["destructiveHint"] = destructive
            annotations["idempotentHint"] = False

        def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
            self._tools[name] = {"name": name, "title": annotations["title"],
                                 "description": inspect.cleandoc(description),
                                 "inputSchema": schema, "annotations": annotations}
            self._handlers[name] = fn
            return fn
        return decorate

    # ------------------------------------------------------------------ protocol
    def _initialize(self, params: dict) -> dict:
        requested = params.get("protocolVersion")
        result = {
            "protocolVersion": requested if requested in SUPPORTED_VERSIONS else PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": self.name, "title": self.title, "version": self.version},
        }
        if self.instructions:
            result["instructions"] = self.instructions
        return result

    def _list_tools(self, _params: dict) -> dict:
        return {"tools": list(self._tools.values())}

    def _call_tool(self, params: dict) -> dict:
        name = params.get("name")
        handler = self._handlers.get(name)
        if handler is None:
            # A tool-level failure is a result, not a JSON-RPC error: the caller's critic
            # needs something to judge, not an exception.
            return _error({"error": f"Unknown tool '{name}'.", "available_tools": sorted(self._handlers)})
        raw = params.get("arguments") or {}
        if not isinstance(raw, dict):
            return _error({"error": f"Arguments for '{name}' must be a JSON object, got {type(raw).__name__}."})
        schema = self._tools[name]["inputSchema"]
        args = coerce_args(raw, schema)
        try:
            inspect.signature(handler).bind(**args)
        except TypeError as exc:
            # Say what would have worked: "unexpected keyword argument 'limit'" tells a
            # caller what was wrong and nothing about what is right, so it guesses again.
            accepted = ", ".join(schema.get("properties") or {}) or "no arguments"
            required = ", ".join(schema.get("required") or []) or "none"
            return _error({"error": f"Bad arguments for '{name}': {exc}. Accepted: {accepted}. Required: {required}."})
        try:
            result = handler(**args)
        except ToolError as exc:
            return _error(exc.payload)
        except Exception as exc:   # a bug in the tool, not the caller's fault
            log(traceback.format_exc())
            return _error({"error": f"{name} failed: {type(exc).__name__}: {exc}"})
        if isinstance(result, dict) and "content" in result:
            return result
        # A handler that returns {"error": ...} is reporting a failure. Sending it back as a
        # successful result made callers treat the failure as data and carry on.
        if isinstance(result, dict) and result.get("error") and not result.get("ok"):
            return _error(result)
        text = result if isinstance(result, str) else _dumps(result)
        out: dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": False}
        if isinstance(result, dict):
            out["structuredContent"] = result
        return out

    def handle(self, message: Any) -> dict | None:
        """Answer one JSON-RPC message; None for notifications and stray responses."""
        if not isinstance(message, dict):
            return {"jsonrpc": "2.0", "id": None,
                    "error": {"code": -32600, "message": "Invalid request: batches are not supported"}}
        msg_id, method = message.get("id"), message.get("method")
        if method is None or msg_id is None:
            return None   # a notification (initialized, cancelled…) or a response: nothing to answer
        routes = {"initialize": self._initialize, "tools/list": self._list_tools,
                  "tools/call": self._call_tool, "ping": lambda _p: {}}
        route = routes.get(method)
        if route is None:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}
        try:
            result = route(message.get("params") or {})
        except Exception as exc:
            log(traceback.format_exc())
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": f"{type(exc).__name__}: {exc}"}}
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    def run(self) -> None:
        # UTF-8 on the protocol channel whatever launched us: piped stdio is cp1252 on
        # Windows, which breaks every accent in both directions; and "\n", not "\r\n".
        for stream, newline in ((sys.stdin, None), (sys.stdout, "\n"), (sys.stderr, None)):
            try:
                stream.reconfigure(encoding="utf-8", **({"newline": newline} if newline else {}))
            except (AttributeError, ValueError):
                pass
        log(f"{self.title} {self.version} ready on stdio")
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError as exc:
                    _send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {exc}"}})
                    continue
                reply = self.handle(message)
                if reply is not None:
                    _send(reply)
        except (BrokenPipeError, KeyboardInterrupt):   # the client went away: exit quietly
            pass


def _error(payload: dict) -> dict:
    return {"content": [{"type": "text", "text": _dumps(payload)}], "isError": True}


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _send(payload: dict) -> None:
    sys.stdout.write(_dumps(payload) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Argument coercion
# ---------------------------------------------------------------------------

_INT = re.compile(r"^\s*-?\d+\s*$")
_TRUE, _FALSE = {"true", "yes", "1", "on"}, {"false", "no", "0", "off", ""}


def coerce_args(args: dict, schema: dict) -> dict:
    """Arguments reshaped to the JSON schema's top-level types, where that is unambiguous.

    Callers are often LLMs or templates: a limit arrives as "5", a list as a JSON string or a
    comma-separated line, an unset optional as "" or null. Coercing those is kinder than an
    error and changes no meaning; anything else is passed through for the tool to judge. An
    empty or null optional scalar is dropped so the tool's own default applies.
    """
    props = schema.get("properties") or {}
    out: dict[str, Any] = {}
    for key, value in args.items():
        spec = props.get(key)
        if spec is None:
            out[key] = value   # unknown: binding reports it with the accepted names
            continue
        kind = spec.get("type")
        if isinstance(kind, list):
            kind = next((k for k in kind if k != "null"), None)
        if value is None or (value == "" and kind in ("integer", "number", "boolean", "object")):
            continue
        out[key] = _coerce(value, kind, spec)
    return out


def _coerce(value: Any, kind: str | None, spec: dict) -> Any:
    if kind == "integer":
        if isinstance(value, str) and _INT.match(value):
            return int(value)
        if isinstance(value, float) and value.is_integer():
            return int(value)
    elif kind == "number" and isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return value
    elif kind == "boolean" and isinstance(value, str) and value.strip().lower() in _TRUE | _FALSE:
        return value.strip().lower() in _TRUE
    elif kind == "string" and isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    elif kind == "object" and isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return value
        return parsed if isinstance(parsed, dict) else value
    elif kind == "array":
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return []
            if text.startswith("["):
                try:
                    parsed = json.loads(text)
                    if isinstance(parsed, list):
                        value = parsed
                except ValueError:
                    pass
            if isinstance(value, str):
                sep = "\n" if "\n" in text else ","
                value = [part.strip() for part in text.split(sep) if part.strip()]
        if isinstance(value, list):
            item = spec.get("items") or {}
            item_kind = item.get("type") if isinstance(item.get("type"), str) else None
            return [_coerce(v, item_kind, item) for v in value]
    return value


# ---------------------------------------------------------------------------
# On-disk JSON state
# ---------------------------------------------------------------------------

class JsonState:
    """A JSON document on disk: the whole world of a sandbox server.

    The file, not the process, is the state. The Factory spawns a fresh server per operation
    and may run two at once (parallel stages), so every read reloads the file and every write
    is a read-modify-write under an exclusive lock file, committed with tmp + os.replace — a
    crash never leaves half a file and two writers never lose each other's changes.
    """

    def __init__(self, path: str | Path, seed: Callable[[], dict]) -> None:
        self.path = Path(path).expanduser().resolve()
        self._seed = seed

    def read(self) -> dict:
        if not self.path.exists():
            with self.write():   # first run: seed under the lock (another process may race us)
                pass
        return self._load()

    @contextmanager
    def write(self) -> Iterator[dict]:
        """Yield the current state; whatever the block leaves in it is saved atomically.
        An exception inside the block saves nothing."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with _locked(self.path.with_name(self.path.name + ".lock")):
            data = self._load() if self.path.exists() else self._seed()
            yield data
            tmp = self.path.with_name(f"{self.path.name}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, self.path)

    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            # Never re-seed over a damaged file silently: that would wipe the user's data.
            raise ToolError(f"Sandbox state {self.path} is unreadable ({exc}). Fix it, or delete it "
                            "to start again from the seed data.") from None
        if not isinstance(data, dict):
            raise ToolError(f"Sandbox state {self.path} is not a JSON object. Delete it to re-seed.")
        return data


@contextmanager
def _locked(lock_path: Path) -> Iterator[None]:
    with open(lock_path, "a+b") as fh:
        if fcntl is not None:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        elif msvcrt is not None:   # pragma: no cover - Windows
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            elif msvcrt is not None:   # pragma: no cover - Windows
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
