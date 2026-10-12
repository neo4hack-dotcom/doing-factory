"""The Factory exposed as an MCP server (SPEC §9, wow #10): JSON-RPC 2.0 over HTTP POST at
`/mcp` (and `/mcp/`), MCP protocol 2025-06-18, so other agents can ask the Factory what is in
flight, what one project looks like, what waits for approval, and how delivery performs.

Deliberately small and stateless: one POST = one JSON-RPC request = one JSON response (no
SSE stream, no session id — the streamable-HTTP transport allows a plain JSON answer), and a
notification is acknowledged with 202. Every tool is read-only and says so
(`readOnlyHint: true`), so a client may call them without asking its human. The answers come
from the same read model as the copilot (app.copilot), so both describe the portfolio
identically. The endpoint shares the API's network exposure (127.0.0.1 by default).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from app.config import VERSION
from app.copilot import find_project, kpi_digest, pending_approvals, project_digest, search_projects
from app.deps import container as c
from app.errors import FactoryError

log = logging.getLogger("factory.mcp_server")
router = APIRouter()

PROTOCOL_VERSION = "2025-06-18"
SUPPORTED_VERSIONS = (PROTOCOL_VERSION, "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "doing-factory", "title": "DOINg.AI Factory", "version": VERSION}
INSTRUCTIONS = ("Read-only access to the DOINg.AI Factory delivery portfolio: projects (use cases, MCP deliveries, "
                "change requests) moving through staged workflows, pending approvals and delivery KPIs. Start with "
                "factory_list_projects, then factory_get_project with a key such as UC-0001.")

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR = -32700, -32600, -32601, -32602, -32603
_STATUSES = ["", "active", "waiting", "blocked", "done", "cancelled", "failed"]


def _read_only(title: str) -> dict[str, Any]:
    return {"title": title, "readOnlyHint": True, "destructiveHint": False, "idempotentHint": True,
            "openWorldHint": False}


TOOLS: list[dict[str, Any]] = [
    {"name": "factory_list_projects", "title": "List projects",
     "description": "Projects of the delivery portfolio with key, title, status, blueprint, current stage, progress, "
                    "open steps, risk and due date. Filter by status and/or free text.",
     "inputSchema": {"type": "object", "properties": {
         "status": {"type": "string", "enum": _STATUSES, "description": "'' = every status"},
         "query": {"type": "string", "description": "Free text over key, title and description"}}},
     "annotations": _read_only("List projects")},
    {"name": "factory_get_project", "title": "Get a project",
     "description": "One project in detail — people, every stage and step with status and result, approvals, risk "
                    "reasons, Jira links, child projects — by key (e.g. UC-0001) or id.",
     "inputSchema": {"type": "object", "properties": {"key_or_id": {"type": "string"}}, "required": ["key_or_id"]},
     "annotations": _read_only("Get a project")},
    {"name": "factory_pending_approvals", "title": "Pending approvals",
     "description": "Every approval waiting for a decision: project, step, approvers still needed, since when, due "
                    "date and whether it is overdue.",
     "inputSchema": {"type": "object", "properties": {}},
     "annotations": _read_only("Pending approvals")},
    {"name": "factory_kpis", "title": "Delivery KPIs",
     "description": "Delivery KPIs over the last N days (default 30): totals, lead time, SLA, approvals, automation "
                    "share and hours saved, quality gates, intake funnel, LLM usage.",
     "inputSchema": {"type": "object", "properties": {"days": {"type": "integer", "minimum": 1, "maximum": 365}}},
     "annotations": _read_only("Delivery KPIs")},
]


class ToolFailure(Exception):
    """A tool could not answer; reported as an `isError` result the caller can read."""


def _list_projects(args: dict) -> dict:
    status = str(args.get("status") or "")
    if status not in _STATUSES:
        raise ToolFailure(f"Unknown status '{status}'. Use one of: {', '.join(s for s in _STATUSES if s)}.")
    return search_projects(c, str(args.get("query") or ""), status, limit=100)


def _get_project(args: dict) -> dict:
    key = str(args.get("key_or_id") or "").strip()
    if not key:
        raise ToolFailure("key_or_id is required (a project key such as UC-0001, or an id).")
    project = find_project(c, key)
    if project is None:
        raise ToolFailure(f"No project matches '{key}'. Call factory_list_projects to find its key.")
    return project_digest(c, project)


def _kpis(args: dict) -> dict:
    days = args.get("days", 30)
    if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 365:
        raise ToolFailure("days must be an integer between 1 and 365.")
    return kpi_digest(c, days)


HANDLERS: dict[str, Callable[[dict], dict]] = {
    "factory_list_projects": _list_projects,
    "factory_get_project": _get_project,
    "factory_pending_approvals": lambda args: pending_approvals(c),
    "factory_kpis": _kpis,
}


def _result(payload: dict, *, is_error: bool = False) -> dict:
    text = json.dumps(payload, ensure_ascii=False, default=str)
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": is_error}
    if not is_error:
        out["structuredContent"] = payload
    return out


async def _call_tool(params: dict) -> dict:
    name = params.get("name")
    handler = HANDLERS.get(name) if isinstance(name, str) else None
    if handler is None:
        raise _RpcError(INVALID_PARAMS, f"Unknown tool '{name}'. Available: {', '.join(HANDLERS)}.")
    args = params.get("arguments") or {}
    if not isinstance(args, dict):
        return _result({"error": "arguments must be a JSON object."}, is_error=True)
    try:
        # Reads are synchronous store/engine calls; KPIs can take a moment on a big portfolio.
        return _result(await asyncio.to_thread(handler, args))
    except ToolFailure as exc:
        return _result({"error": str(exc)}, is_error=True)
    except FactoryError as exc:
        return _result({"error": exc.message}, is_error=True)
    except Exception as exc:  # noqa: BLE001 — a tool bug is reported to the caller, logged here
        log.exception("Factory MCP tool %s failed", name)
        return _result({"error": f"{name} failed: {type(exc).__name__}: {exc}"}, is_error=True)


class _RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


def _initialize(params: dict) -> dict:
    requested = params.get("protocolVersion")
    return {"protocolVersion": requested if requested in SUPPORTED_VERSIONS else PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO, "instructions": INSTRUCTIONS}


async def handle(message: Any) -> dict | None:
    """Answer one JSON-RPC message; None for a notification or a stray response."""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return _error(None, INVALID_REQUEST, "Invalid request: expected one JSON-RPC 2.0 object "
                                             "(batches are not supported).")
    msg_id, method = message.get("id"), message.get("method")
    if "id" not in message or msg_id is None:
        return None
    if not isinstance(method, str):
        return _error(msg_id, INVALID_REQUEST, "Invalid request: 'method' is missing.")
    params = message.get("params") or {}
    if not isinstance(params, dict):
        return _error(msg_id, INVALID_PARAMS, "params must be an object.")
    try:
        if method == "initialize":
            result = _initialize(params)
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            result = await _call_tool(params)
        else:
            return _error(msg_id, METHOD_NOT_FOUND, f"Method not found: {method}")
    except _RpcError as exc:
        return _error(msg_id, exc.code, exc.message)
    except Exception as exc:  # noqa: BLE001
        log.exception("Factory MCP %s failed", method)
        return _error(msg_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _error(msg_id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


@router.post("/mcp", include_in_schema=False)
@router.post("/mcp/", include_in_schema=False)
async def mcp_endpoint(request: Request) -> Response:
    try:
        message = json.loads(await request.body() or b"null")
    except ValueError as exc:
        return JSONResponse(_error(None, PARSE_ERROR, f"Parse error: {exc}"), status_code=400)
    if message is None:
        return JSONResponse(_error(None, INVALID_REQUEST, "Empty request body."), status_code=400)
    reply = await handle(message)
    if reply is None:
        return Response(status_code=202)
    status = 400 if reply.get("error", {}).get("code") in (PARSE_ERROR, INVALID_REQUEST) else 200
    return JSONResponse(reply, status_code=status)


@router.api_route("/mcp", methods=["GET", "DELETE"], include_in_schema=False)
@router.api_route("/mcp/", methods=["GET", "DELETE"], include_in_schema=False)
async def mcp_not_allowed() -> JSONResponse:
    """No server-initiated stream and no sessions to end: POST is the only verb."""
    return JSONResponse({"detail": "The DOINg.AI Factory MCP endpoint is stateless: send JSON-RPC requests with "
                                   "POST (streamable HTTP, protocol 2025-06-18). No SSE stream is offered."},
                        status_code=405, headers={"Allow": "POST"})
