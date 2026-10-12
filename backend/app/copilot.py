"""Copilot ("Ask the Factory"): portfolio chat with internal read-only tools (SPEC §9, §11).

The model never sees the database. It sees a handful of read-only tools — search projects,
open one, list my tasks, what is blocked or at risk, KPIs, intake, blueprints — and answers
from what they return. That is the whole defence against an invented project: the system
prompt says "answer from tool results only", the tools are the only source of facts, and the
project chips under an answer are built from keys that really exist in the store.

Tool calling uses the model's native tools when it declares them, otherwise a JSON
decide-act loop (`{"action": "tool"|"finish", ...}`), so a small local model without native
tools still works. At most MAX_TOOL_ROUNDS lookups per question, then the model must answer.
Progress is pushed live as bus `copilot.progress` {chat_id, text}.

The portfolio read model at the top of this file (find/digest/search/pending approvals/KPI
digest) is shared with the Factory's own MCP endpoint (factory_mcp.py): both answer the same
questions, so they read the portfolio the same way.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable

from app import inbox as inbox_mod
from app import kpis as kpis_mod
from app.errors import FactoryError, LLMError
from app.llm.client import assistant_message, tool_message
from app.models import Chat, ChatMessage
from app.util import new_id, now_iso, parse_iso, parse_json, truncate

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

log = logging.getLogger("factory.copilot")

MAX_TOOL_ROUNDS = 6
HISTORY_MESSAGES = 10          # earlier turns replayed to the model
STORED_MESSAGES = 200          # a chat keeps at most this many messages
TOOL_RESULT_CHARS = 4000       # what one tool result may cost in the prompt
IN_FLIGHT = ("active", "waiting", "blocked")
OPEN_STEP = ("running", "waiting_human", "waiting_approval", "waiting_children", "waiting_external", "failed")
_CHAT_ID = re.compile(r"^chat_[A-Za-z0-9]{6,32}$")
_KEY_PATTERN = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b")
_ID_PATTERN = re.compile(r"\bprj_[0-9a-f]{12}\b")


# =====================================================================================
# Portfolio read model (shared with factory_mcp)
# =====================================================================================

def _user_names(c: "Container") -> dict[str, str]:
    return {u["id"]: u.get("name") or u["id"] for u in c.users()}


def _team_names(c: "Container") -> dict[str, str]:
    return {t["id"]: t.get("name") or t["id"] for t in c.teams()}


def find_project(c: "Container", key_or_id: str) -> dict | None:
    """A project by id, by key (case-insensitive: "uc-0007" works) or, failing both, by a
    unique exact title. None when nothing — or more than one title — matches."""
    needle = (key_or_id or "").strip()
    if not needle:
        return None
    doc = c.store.get("projects", needle)
    if doc is not None:
        return doc
    projects = c.store.list("projects")
    wanted = needle.lower()
    by_key = [p for p in projects if (p.get("key") or "").lower() == wanted]
    if by_key:
        return by_key[0]
    by_title = [p for p in projects if (p.get("title") or "").strip().lower() == wanted]
    return by_title[0] if len(by_title) == 1 else None


def summary_digest(summary: dict) -> dict:
    """A ProjectSummary trimmed to what a model or an MCP client needs to reason about it."""
    risk = summary.get("risk") or {}
    out: dict[str, Any] = {
        "id": summary.get("id"), "key": summary.get("key"), "title": summary.get("title"),
        "status": summary.get("status"), "priority": summary.get("priority"),
        "blueprint": summary.get("blueprint_name"), "current_stage": summary.get("current_stage_name") or "",
        "progress_pct": round(float(summary.get("progress") or 0) * 100),
        "open_steps": summary.get("open_step_names") or [],
        "risk": {"level": risk.get("level") or "low", "score": risk.get("score") or 0},
        "due_date": summary.get("due_date"),
    }
    if summary.get("child_count"):
        out["children"] = f"{summary.get('children_done') or 0}/{summary['child_count']} done"
    if summary.get("parent_id"):
        out["parent_id"] = summary["parent_id"]
    return out


def project_digest(c: "Container", project: dict) -> dict:
    """One project as facts: people by name, stages with step statuses, open work, risk,
    links and children. Never the raw vars (they can be large and are not facts for a reader)."""
    names, teams = _user_names(c), _team_names(c)
    stages, open_steps, total, finished = [], [], 0, 0
    for stage in project.get("stages") or []:
        steps = []
        for step in stage.get("steps") or []:
            total += 1
            finished += step.get("status") in ("done", "skipped")
            entry = {"id": step.get("id"), "name": step.get("name"), "type": step.get("type"),
                     "status": step.get("status")}
            assignees = [names.get(u, u) for u in step.get("assignee_user_ids") or []]
            if assignees:
                entry["assignees"] = assignees
            if step.get("due_at"):
                entry["due_at"] = step["due_at"]
            if step.get("sla_breached"):
                entry["sla_breached"] = True
            if step.get("output_summary"):
                entry["result"] = truncate(step["output_summary"], 200)
            if step.get("error"):
                entry["error"] = truncate(step["error"], 200)
            if step.get("approvals"):
                entry["approvals"] = [{"by": names.get(a.get("user_id"), a.get("user_id")), "role": a.get("role"),
                                       "decision": a.get("decision")} for a in step["approvals"]]
            steps.append(entry)
            if step.get("status") in OPEN_STEP:
                open_steps.append({"stage": stage.get("name"), **entry})
        stages.append({"name": stage.get("name"), "status": stage.get("status"), "steps": steps})
    current = next((s for s in project.get("stages") or [] if s.get("id") == project.get("current_stage_id")), None)
    risk = project.get("risk") or {}
    children = []
    for child_id in project.get("child_ids") or []:
        child = c.store.get("projects", child_id)
        if child is not None:
            children.append({"key": child.get("key"), "title": child.get("title"), "status": child.get("status")})
    parent = c.store.get("projects", project["parent_id"]) if project.get("parent_id") else None
    out: dict[str, Any] = {
        "id": project.get("id"), "key": project.get("key"), "title": project.get("title"),
        "description": truncate(project.get("description"), 600),
        "status": project.get("status"), "priority": project.get("priority"),
        "blueprint": project.get("blueprint_name"),
        "sponsor": names.get(project.get("sponsor_id") or "", "") or None,
        "owner": names.get(project.get("owner_id") or "", "") or None,
        "team": teams.get(project.get("team_id") or "", "") or None,
        "due_date": project.get("due_date"), "created_at": project.get("created_at"),
        "completed_at": project.get("completed_at"),
        "current_stage": (current or {}).get("name") or "",
        "progress_pct": round(100 * finished / total) if total else 0,
        "risk": {"score": risk.get("score") or 0, "level": risk.get("level") or "low",
                 "reasons": risk.get("reasons") or []},
        "open_steps": open_steps, "stages": stages,
        "links": [{k: link.get(k) for k in ("kind", "label", "url", "external_id", "status") if link.get(k)}
                  for link in project.get("links") or []],
        "artifacts": [a.get("title") for a in project.get("artifacts") or [] if a.get("title")],
    }
    if project.get("ai_summary"):
        out["ai_summary"] = project["ai_summary"]
    if children:
        out["children"] = children
    if parent is not None:
        out["parent"] = {"key": parent.get("key"), "title": parent.get("title")}
    return out


def search_projects(c: "Container", query: str = "", status: str = "", blueprint: str = "",
                    limit: int = 25) -> dict:
    """Project summaries filtered by free text, status and blueprint (name, key or id)."""
    summaries = c.engine.list_summaries(status=status or None, q=query or None)
    if blueprint:
        wanted = blueprint.strip().lower()
        keys = {b["id"]: (b.get("key") or "").lower() for b in c.store.list("blueprints")}
        summaries = [s for s in summaries
                     if wanted in ((s.get("blueprint_name") or "").lower(), (s.get("blueprint_id") or "").lower(),
                                   keys.get(s.get("blueprint_id") or "", ""))]
    limit = max(1, min(int(limit or 25), 100))
    return {"count": len(summaries), "projects": [summary_digest(s) for s in summaries[:limit]],
            "truncated": len(summaries) > limit}


def pending_approvals(c: "Container") -> dict:
    """Every approval step waiting for a decision, with who still has to approve."""
    names = _user_names(c)
    now = datetime.now(timezone.utc)
    items = []
    for project in c.store.list("projects"):
        if project.get("status") not in IN_FLIGHT:
            continue
        for stage in project.get("stages") or []:
            for step in stage.get("steps") or []:
                if step.get("status") != "waiting_approval":
                    continue
                cfg = step.get("config") or {}
                approved_roles = {a.get("role") for a in step.get("approvals") or [] if a.get("decision") == "approved"}
                approvers = [a.get("label") or a.get("role") for a in cfg.get("approvers") or [] if isinstance(a, dict)]
                missing = [a.get("label") or a.get("role") for a in cfg.get("approvers") or []
                           if isinstance(a, dict) and a.get("role") not in approved_roles]
                due = parse_iso(step.get("due_at"))
                items.append({
                    "project_id": project.get("id"), "project_key": project.get("key"),
                    "project_title": project.get("title"), "step_id": step.get("id"), "step": step.get("name"),
                    "policy": cfg.get("policy") or "all", "approvers": approvers, "still_needed": missing,
                    "approvals": [{"by": names.get(a.get("user_id"), a.get("user_id")), "role": a.get("role"),
                                   "decision": a.get("decision")} for a in step.get("approvals") or []],
                    "waiting_on": [names.get(u, u) for u in step.get("assignee_user_ids") or []],
                    "since": step.get("started_at"), "due_at": step.get("due_at"),
                    "overdue": bool(due and due < now),
                    "brief": truncate(step.get("brief"), 300),
                })
    items.sort(key=lambda i: (not i["overdue"], i["due_at"] or "9999", i["since"] or ""))
    return {"count": len(items), "approvals": items}


def kpi_digest(c: "Container", days: int = 30) -> dict:
    """The headline KPIs (SPEC §10) without the long per-day/per-week series."""
    k = kpis_mod.compute_kpis(c, max(1, min(int(days or 30), 365)))
    return {key: k.get(key) for key in ("days", "totals", "lead_time", "sla", "approvals", "automation", "quality",
                                        "jira", "funnel")} | {
        "llm": {key: (k.get("llm") or {}).get(key) for key in ("calls", "tokens_in", "tokens_out",
                                                               "avg_latency_ms", "error_rate")}}


# =====================================================================================
# Copilot tools (read-only)
# =====================================================================================

def _tool_list_my_tasks(c: "Container", user_id: str, args: dict) -> dict:
    items = inbox_mod.inbox_for(c, user_id) if user_id else []
    rows = [{k: i.get(k) for k in ("kind", "project_key", "project_title", "step_name", "title", "priority",
                                   "due_at", "overdue") if i.get(k) not in (None, "")} for i in items]
    return {"count": len(rows), "tasks": rows[:40]}


def _tool_blocked_or_at_risk(c: "Container", user_id: str, args: dict) -> dict:
    out = []
    for s in c.engine.list_summaries():
        risk = s.get("risk") or {}
        if s.get("status") in ("blocked", "failed") or (s.get("status") in IN_FLIGHT and risk.get("level") in ("high", "medium")):
            out.append({**summary_digest(s), "risk_reasons": (risk.get("reasons") or [])[:4]})
    out.sort(key=lambda d: (d["status"] not in ("blocked", "failed"), -(d["risk"]["score"] or 0)))
    return {"count": len(out), "projects": out[:30]}


def _tool_list_intake(c: "Container", user_id: str, args: dict) -> dict:
    status = str(args.get("status") or "new")
    items = [i for i in c.store.list("intake") if status == "all" or i.get("status") == status]
    items.sort(key=lambda i: i.get("detected_at") or "", reverse=True)
    rows = []
    for item in items[:30]:
        row = {"id": item.get("id"), "title": item.get("title"), "status": item.get("status"),
               "watcher": item.get("watcher_name"), "detected_at": item.get("detected_at")}
        suggestion = item.get("suggestion") or {}
        if suggestion.get("summary"):
            row["ai_summary"] = truncate(suggestion["summary"], 300)
        if item.get("project_id"):
            row["project_id"] = item["project_id"]
        rows.append(row)
    return {"count": len(items), "items": rows}


def _tool_list_blueprints(c: "Container", user_id: str, args: dict) -> dict:
    rows = [{"key": b.get("key"), "name": b.get("name"), "status": b.get("status"),
             "description": truncate(b.get("description"), 200),
             "stages": [s.get("name") for s in b.get("stages") or []]}
            for b in c.store.list("blueprints") if b.get("status") != "archived"]
    return {"count": len(rows), "blueprints": rows}


def _tool_get_project(c: "Container", user_id: str, args: dict) -> dict:
    key = str(args.get("key_or_id") or args.get("key") or args.get("id") or "")
    project = find_project(c, key)
    if project is None:
        return {"error": f"No project matches '{key}'. Use search_projects to find its key."}
    return project_digest(c, project)


_STR = {"type": "string"}
TOOLS: dict[str, dict[str, Any]] = {
    "search_projects": {
        "description": "Search projects by free text (key, title, description), status and/or blueprint. "
                       "Returns key, title, status, current stage, progress, risk and open steps.",
        "parameters": {"type": "object", "properties": {
            "query": {**_STR, "description": "Free text; empty = all projects"},
            "status": {"type": "string", "enum": ["", "active", "waiting", "blocked", "done", "cancelled", "failed"]},
            "blueprint": {**_STR, "description": "Blueprint name or key"},
            "limit": {"type": "integer", "description": "Max results (default 25)"}}},
        "fn": lambda c, uid, a: search_projects(c, str(a.get("query") or ""), str(a.get("status") or ""),
                                               str(a.get("blueprint") or ""), int(a.get("limit") or 25)),
    },
    "get_project": {
        "description": "Full detail of one project by key (e.g. UC-0007) or id: people, stages and steps with "
                       "status, open steps, approvals, risk reasons, Jira links, children.",
        "parameters": {"type": "object", "properties": {"key_or_id": _STR}, "required": ["key_or_id"]},
        "fn": _tool_get_project,
    },
    "list_my_tasks": {
        "description": "The pending actions of the person asking (forms, approvals, estimates, reviews, failures, intake).",
        "parameters": {"type": "object", "properties": {}},
        "fn": _tool_list_my_tasks,
    },
    "list_blocked_or_at_risk": {
        "description": "Projects that are blocked or failed, or in flight with a medium/high risk score, with the risk reasons.",
        "parameters": {"type": "object", "properties": {}},
        "fn": _tool_blocked_or_at_risk,
    },
    "list_pending_approvals": {
        "description": "Every approval waiting for a decision, with the approvers still needed and due dates.",
        "parameters": {"type": "object", "properties": {}},
        "fn": lambda c, uid, a: pending_approvals(c),
    },
    "get_kpis": {
        "description": "Delivery KPIs over the last N days: totals, lead time, SLA, approvals, automation, quality, funnel.",
        "parameters": {"type": "object", "properties": {"days": {"type": "integer", "description": "Default 30"}}},
        "fn": lambda c, uid, a: kpi_digest(c, int(a.get("days") or 30)),
    },
    "list_intake": {
        "description": "Items detected by watchers (e.g. new DOINg.AI use cases) waiting for triage.",
        "parameters": {"type": "object", "properties": {
            "status": {"type": "string", "enum": ["new", "accepted", "dismissed", "all"]}}},
        "fn": _tool_list_intake,
    },
    "list_blueprints": {
        "description": "The workflow blueprints (delivery processes) available to start projects.",
        "parameters": {"type": "object", "properties": {}},
        "fn": _tool_list_blueprints,
    },
}


def _native_tools() -> list[dict[str, Any]]:
    return [{"type": "function", "function": {"name": name, "description": spec["description"],
                                              "parameters": spec["parameters"]}}
            for name, spec in TOOLS.items()]


def _tool_catalogue() -> str:
    lines = []
    for name, spec in TOOLS.items():
        props = spec["parameters"].get("properties") or {}
        params = ", ".join(f"{p}?" if p not in (spec["parameters"].get("required") or []) else p for p in props)
        lines.append(f"- {name}({params}): {spec['description']}")
    return "\n".join(lines)


def run_tool(c: "Container", user_id: str, name: str, args: dict | None) -> dict:
    """Execute one copilot tool. Never raises: a failure is a result the model can read."""
    spec = TOOLS.get(name)
    if spec is None:
        return {"error": f"Unknown tool '{name}'. Available: {', '.join(TOOLS)}."}
    try:
        return spec["fn"](c, user_id, args if isinstance(args, dict) else {})
    except FactoryError as exc:
        return {"error": exc.message}
    except Exception as exc:  # noqa: BLE001 — the model reads the failure and says it could not look it up
        log.exception("Copilot tool %s failed", name)
        return {"error": f"{name} failed: {type(exc).__name__}: {exc}"}


def _result_summary(name: str, result: dict) -> str:
    if result.get("error"):
        return f"error: {truncate(result['error'], 120)}"
    if name == "get_project":
        return f"{result.get('key')} — {result.get('title')} ({result.get('status')})"
    if name == "get_kpis":
        return f"KPIs over {result.get('days')} days"
    if "count" in result:
        noun = {"search_projects": "project", "list_blocked_or_at_risk": "project", "list_my_tasks": "task",
                "list_pending_approvals": "approval", "list_intake": "intake item",
                "list_blueprints": "blueprint"}.get(name, "item")
        return f"{result['count']} {noun}{'' if result['count'] == 1 else 's'}"
    return "done"


def _progress_text(name: str, args: dict) -> str:
    if name == "search_projects":
        bits = [f"'{args['query']}'" if args.get("query") else "", args.get("status") or "", args.get("blueprint") or ""]
        detail = " · ".join(b for b in bits if b)
        return f"Searching projects{': ' + detail if detail else ''}"
    if name == "get_project":
        return f"Opening project {args.get('key_or_id') or args.get('key') or ''}".strip()
    return {"list_my_tasks": "Reading your pending tasks", "list_blocked_or_at_risk": "Checking blocked and at-risk projects",
            "list_pending_approvals": "Listing pending approvals", "get_kpis": "Computing KPIs",
            "list_intake": "Reading the intake queue", "list_blueprints": "Listing blueprints"}.get(name, f"Running {name}")


# =====================================================================================
# Chat
# =====================================================================================

def _system_prompt(c: "Container", user: dict | None, project: dict | None, json_mode: bool) -> str:
    parts = [c.ai.prompt("copilot")]
    if user is not None:
        roles = ", ".join(user.get("roles") or []) or "no role"
        parts.append(f"You are talking to {user.get('name') or user['id']} (user id {user['id']}; roles: {roles}).")
    else:
        parts.append("The person asking has not picked a persona; 'my tasks' are unknown.")
    parts.append(f"Today is {now_iso()[:10]}.")
    if project is not None:
        current = next((s.get("name") for s in project.get("stages") or []
                        if s.get("id") == project.get("current_stage_id")), "")
        parts.append(f"The conversation is about project {project.get('key')} — {project.get('title')} "
                     f"(status {project.get('status')}, stage {current or 'n/a'}). Use get_project for its details.")
    if json_mode:
        parts.append(
            "You can call these read-only tools:\n" + _tool_catalogue() + "\n\n"
            "Reply with exactly ONE JSON object and nothing else:\n"
            '{"thought": "<short>", "action": "tool", "tool": "<tool name>", "args": {...}} to look something up, or\n'
            '{"thought": "<short>", "action": "finish", "final": "<your answer in Markdown>"} when you can answer.')
    return "\n\n".join(parts)


def _links(c: "Container", text: str) -> list[dict]:
    """Chips for the projects an answer names — only keys/ids that exist in the store."""
    projects = c.store.list("projects")
    by_key = {(p.get("key") or "").upper(): p for p in projects if p.get("key")}
    by_id = {p["id"]: p for p in projects}
    seen: dict[str, dict] = {}
    for match in _KEY_PATTERN.finditer(text or ""):
        project = by_key.get(match.group(0).upper())
        if project is not None:
            seen.setdefault(project["id"], project)
    for match in _ID_PATTERN.finditer(text or ""):
        project = by_id.get(match.group(0))
        if project is not None:
            seen.setdefault(project["id"], project)
    return [{"label": f"{p.get('key') or p['id']} — {truncate(p.get('title'), 60)}", "project_id": p["id"]}
            for p in list(seen.values())[:12]]


def _history(chat: dict) -> list[dict[str, str]]:
    return [{"role": m["role"], "content": m.get("content") or ""}
            for m in (chat.get("messages") or [])[-HISTORY_MESSAGES:] if m.get("content")]


async def chat(container: "Container", user_id: str, message: str, chat_id: str | None = None,
               project_id: str = "") -> dict:
    """Answer `message` in conversation `chat_id` (a new one when None or unknown) and return
    the stored Chat. A client may choose the id of a new chat (`chat_` + 6-32 letters/digits)
    so it can follow `copilot.progress` before the first answer arrives. Nothing is stored
    when the LLM fails: the caller keeps the question and can retry."""
    c = container
    text = (message or "").strip()
    if not text:
        raise FactoryError("Ask a question first.", 422)
    existing = c.store.get("chats", chat_id) if chat_id else None
    if chat_id and existing is None and not _CHAT_ID.match(chat_id):
        raise FactoryError(f"Conversation {chat_id} not found.", 404)
    stamp = now_iso()
    conversation = existing or Chat(id=chat_id or new_id("chat"), user_id=user_id, project_id=project_id,
                                    title=truncate(text, 60), created_at=stamp).model_dump()
    project_id = project_id or conversation.get("project_id") or ""
    project = find_project(c, project_id) if project_id else None
    user = c.get_user(user_id) if user_id else None
    cid = conversation["id"]

    def progress(msg: str) -> None:
        c.bus.emit("copilot.progress", chat_id=cid, text=msg)

    progress("Thinking…")
    native = await c.llm.supports_tools()
    messages = [{"role": "system", "content": _system_prompt(c, user, project, json_mode=not native)},
                *_history(conversation), {"role": "user", "content": text}]
    calls: list[dict] = []
    final = await (_native_loop if native else _json_loop)(c, user_id, messages, calls, progress, project_id)
    if not final.strip():
        raise LLMError("The model returned an empty answer — ask again, or pick a larger model in Settings › AI Model.")

    user_turn = ChatMessage(role="user", content=text, ts=stamp).model_dump()
    answer = ChatMessage(role="assistant", content=final.strip(), tool_calls=calls, links=_links(c, final),
                         ts=now_iso()).model_dump()
    conversation["messages"] = [*(conversation.get("messages") or []), user_turn, answer][-STORED_MESSAGES:]
    conversation["project_id"] = conversation.get("project_id") or project_id
    conversation["updated_at"] = now_iso()
    saved = c.store.put("chats", conversation)
    progress("Done")
    return Chat.model_validate(saved).model_dump()


def _record_call(calls: list[dict], name: str, args: dict, result: dict) -> None:
    calls.append({"name": name, "args": args, "summary": _result_summary(name, result)})


def _execute(c: "Container", user_id: str, name: str, args: dict, cache: dict[str, dict],
             progress: Callable[[str], None], calls: list[dict]) -> str:
    """Run a tool once per (name, args): a repeated identical call gets the cached result and
    a nudge, which is what stops a small model from looping on the same lookup."""
    signature = f"{name}:{json.dumps(args, sort_keys=True, default=str)}"
    if signature in cache:
        payload = {"note": "You already called this tool with these arguments; use the result you have.",
                   **cache[signature]}
    else:
        progress(_progress_text(name, args))
        payload = run_tool(c, user_id, name, args)
        cache[signature] = payload
        _record_call(calls, name, args, payload)
    return truncate(json.dumps(payload, ensure_ascii=False, default=str), TOOL_RESULT_CHARS)


async def _native_loop(c: "Container", user_id: str, messages: list[dict], calls: list[dict],
                       progress: Callable[[str], None], project_id: str) -> str:
    tools = _native_tools()
    cache: dict[str, dict] = {}
    for _ in range(MAX_TOOL_ROUNDS):
        reply = await c.ai.chat("copilot", messages, tools=tools, project_id=project_id)
        if not reply.tool_calls:
            return reply.content
        messages.append(assistant_message(reply))
        for call in reply.tool_calls:
            content = await asyncio.to_thread(_execute, c, user_id, call["name"], call.get("arguments") or {},
                                              cache, progress, calls)
            messages.append(tool_message(call, content))
    return await _final_answer(c, messages, project_id, progress)


async def _json_loop(c: "Container", user_id: str, messages: list[dict], calls: list[dict],
                     progress: Callable[[str], None], project_id: str) -> str:
    cache: dict[str, dict] = {}
    for _ in range(MAX_TOOL_ROUNDS):
        reply = await c.ai.chat("copilot", messages, json_mode=True, project_id=project_id)
        decision = parse_json(reply.content)
        if not isinstance(decision, dict):
            return reply.content                      # the model answered in prose: that is the answer
        action = str(decision.get("action") or "").lower()
        tool = str(decision.get("tool") or "")
        if action == "tool" or (tool and action != "finish"):
            args = decision.get("args") if isinstance(decision.get("args"), dict) else {}
            content = await asyncio.to_thread(_execute, c, user_id, tool, args, cache, progress, calls)
            messages.append({"role": "assistant", "content": reply.content})
            messages.append({"role": "user", "content": f"Result of {tool}:\n{content}\n\n"
                                                        "Reply with the next JSON object."})
            continue
        final = decision.get("final") or decision.get("answer")
        if isinstance(final, str) and final.strip():
            return final
        messages.append({"role": "assistant", "content": reply.content})
        messages.append({"role": "user", "content": 'Give your answer now: {"action": "finish", "final": "<Markdown>"}'})
    return await _final_answer(c, messages, project_id, progress, json_mode=True)


async def _final_answer(c: "Container", messages: list[dict], project_id: str, progress: Callable[[str], None],
                        json_mode: bool = False) -> str:
    """The lookup budget is spent: the model must answer from what it has."""
    progress("Writing the answer…")
    messages.append({"role": "user", "content": "You have used all your lookups. Answer the question now, in "
                                                "Markdown, using only the tool results above. Say what you "
                                                "could not find."})
    reply = await c.ai.chat("copilot", messages, project_id=project_id)
    content = reply.content
    if json_mode:
        decision = parse_json(content)
        if isinstance(decision, dict) and isinstance(decision.get("final"), str):
            content = decision["final"]
    return content
