"""A tiny stdio MCP server for the MCP client tests — stdlib only, self-contained.

Its tools cover what the client must survive: plain and structured results, a tool-level
error (isError), a slow call, a crash mid-call, a result far larger than 64 KiB on one
line, a server-initiated request whose id collides with the pending call's, and a
paginated tools/list. It prints a banner on stdout first, which a client must ignore.
"""
from __future__ import annotations

import json
import os
import sys
import time

PAGE_SIZE = 4


def _tool(name: str, description: str, properties: dict | None = None, required: list | None = None,
          **annotations: bool) -> dict:
    schema = {"type": "object", "properties": properties or {}, "required": required or []}
    return {"name": name, "description": description, "inputSchema": schema, "annotations": annotations}


TOOLS = [
    _tool("echo", "Echo the text back.", {"text": {"type": "string"}}, ["text"], readOnlyHint=True),
    _tool("add", "Add two numbers (structured result).", {"a": {"type": "number"}, "b": {"type": "number"}},
          ["a", "b"], readOnlyHint=True),
    _tool("fail", "Always fails with the given message.", {"message": {"type": "string"}}, readOnlyHint=True),
    _tool("slow", "Sleep, then answer.", {"seconds": {"type": "number"}}, readOnlyHint=True),
    _tool("crash", "Exit the process mid-call.", {"code": {"type": "integer"}}),
    _tool("big", "Return n characters on one line.", {"n": {"type": "integer"}}, readOnlyHint=True),
    _tool("ask_roots", "Ask the client for its roots, reusing this call's id, and report the answer.",
          readOnlyHint=True),
    _tool("get_env", "Values of the named environment variables.", {"names": {"type": "array"}},
          readOnlyHint=True),
    _tool("createItem", "Create an item (camelCase write verb, no annotation)."),
    _tool("flush_cache", "Flush the cache (destructive by annotation only).", destructiveHint=True),
    _tool("update_mirror", "Refresh a read-only mirror (write verb, but declared read-only).", readOnlyHint=True),
]


def send(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def text(value: str, is_error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": value}], "isError": is_error}


def call(request_id, name: str, args: dict) -> dict:
    if name == "echo":
        return text(args.get("text", ""))
    if name == "add":
        total = args["a"] + args["b"]
        return {"content": [{"type": "text", "text": f"{args['a']} + {args['b']} = {total}"}],
                "structuredContent": {"sum": total}}
    if name == "fail":
        return text(args.get("message") or "failed on purpose", is_error=True)
    if name == "slow":
        time.sleep(float(args.get("seconds", 1)))
        return text("done")
    if name == "crash":
        sys.stderr.write("boom: simulated crash\n")
        sys.stderr.flush()
        os._exit(int(args.get("code", 3)))
    if name == "big":
        return text("x" * int(args.get("n", 100_000)))
    if name == "ask_roots":
        send({"jsonrpc": "2.0", "id": request_id, "method": "roots/list"})
        while True:
            line = sys.stdin.readline()
            if not line:
                os._exit(0)
            reply = json.loads(line)
            if reply.get("id") == request_id and "method" not in reply:
                return text(json.dumps({"client_answered": reply.get("result", reply.get("error"))}))
    if name == "get_env":
        return text(json.dumps({key: os.environ.get(key) for key in args.get("names") or []}))
    if name in ("createItem", "flush_cache", "update_mirror"):
        return text(json.dumps({"ok": True, "tool": name}))
    return text(f"Unknown tool '{name}'", is_error=True)


def main() -> None:
    print("echo-mcp test server: this banner is not JSON-RPC", flush=True)
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("id") is None or "method" not in message:
            continue   # notifications and stray responses
        method, params = message["method"], message.get("params") or {}
        if method == "initialize":
            result = {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                      "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": {"name": "echo-test", "title": "Echo test server", "version": "0.1.0"}}
        elif method == "tools/list":
            start = int(params.get("cursor") or 0)
            result = {"tools": TOOLS[start:start + PAGE_SIZE]}
            if start + PAGE_SIZE < len(TOOLS):
                result["nextCursor"] = str(start + PAGE_SIZE)
        elif method == "tools/call":
            result = call(message["id"], params.get("name", ""), params.get("arguments") or {})
        elif method == "ping":
            result = {}
        else:
            send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": f"No method {method}"}})
            continue
        send({"jsonrpc": "2.0", "id": message["id"], "result": result})


if __name__ == "__main__":
    main()
