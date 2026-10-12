"""Jira (Sandbox) — an MCP server that behaves like a small Jira (docs/SPEC.md §13).

    JIRA_SANDBOX_STATE=/path/jira.json  python jira_mcp.py

Tool names and arguments mirror sooperset/mcp-atlassian (`jira_search`, `jira_create_issue`,
`jira_batch_create_issues`…), so an Operation built on the sandbox moves to a real Jira MCP
server by changing its connector, not the blueprints that use it.

State: one JSON file (env JIRA_SANDBOX_STATE, default backend/data/sandbox/jira.json), seeded
on first run with five team projects — MCPF (MCP Factory Squad), DATA (Data Platform), PAY
(Payments), SEC (Security Engineering), OPS (IT Operations, change requests) — and a few
existing issues, among them epics for MCP servers already delivered and one for a server that
was requested but never started, so a find-or-create step has something real to find.

Every issue has a `key` (MCPF-12), a `url` (https://jira.sandbox.local/browse/MCPF-12) and a
status: To Do, In Progress or Done. `jira_search` understands a JQL subset; anything outside it
is refused with the list of what is supported rather than silently matching nothing.
"""
from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _mcp_stdio import JsonState, McpServer, ToolError  # noqa: E402

VERSION = "1.0.0"
BASE_URL = "https://jira.sandbox.local"
DEFAULT_STATE = Path(__file__).resolve().parents[1] / "data" / "sandbox" / "jira.json"

STATUSES = ("To Do", "In Progress", "Done")
PRIORITIES = ("Highest", "High", "Medium", "Low", "Lowest")
DELIVERY_TYPES = ["Epic", "Story", "Task", "Bug"]
OPS_TYPES = ["Change", "Task", "Bug"]
MAX_SUMMARY = 255
UPDATABLE = ("summary", "description", "priority", "labels", "assignee", "story_points", "components", "parent_key")

STATE = JsonState(os.environ.get("JIRA_SANDBOX_STATE") or DEFAULT_STATE, lambda: seed_state())


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _url(key: str) -> str:
    return f"{BASE_URL}/browse/{key}"


def _canonical(value: Any, allowed: tuple[str, ...] | list[str], label: str) -> str:
    """The canonical spelling of a closed-list value ("in progress" → "In Progress"), or a ToolError
    listing the options: a typo must not silently match nothing."""
    wanted = re.sub(r"[\s_-]+", " ", str(value or "")).strip().lower()
    for option in allowed:
        if option.lower() == wanted:
            return option
    raise ToolError(f"Unknown {label} '{value}'.", allowed_values=list(allowed))


def _project(state: dict, key: str) -> dict:
    wanted = str(key or "").strip().upper()
    for p in state["projects"]:
        if p["key"] == wanted:
            return p
    raise ToolError(f"Jira project '{key}' not found.",
                    available_projects=[f"{p['key']} — {p['name']}" for p in state["projects"]])


def _issue(state: dict, key: str) -> dict:
    wanted = str(key or "").strip().upper()
    for i in state["issues"]:
        if i["key"] == wanted:
            return i
    raise ToolError(f"Issue '{key}' not found.",
                    hint="Use jira_search to find keys, e.g. jql: project = MCPF AND issuetype = Epic")


def _brief(issue: dict) -> dict:
    """Search-result view: everything but the long text, so 20 results stay readable."""
    out = {k: v for k, v in issue.items() if k not in ("description", "comments")}
    desc = issue.get("description") or ""
    out["description_excerpt"] = desc if len(desc) <= 200 else desc[:199].rstrip() + "…"
    out["comment_count"] = len(issue.get("comments") or [])
    return out


# ---------------------------------------------------------------------------
# Issue validation (shared by create and batch create)
# ---------------------------------------------------------------------------

# Field names an LLM or another Jira tool commonly uses for the same thing.
_ALIASES = {"project": "project_key", "projectkey": "project_key", "type": "issue_type", "issuetype": "issue_type",
            "parent": "parent_key", "parentkey": "parent_key", "epic_key": "parent_key", "epic": "parent_key",
            "points": "story_points", "storypoints": "story_points", "story_point": "story_points",
            "label": "labels", "component": "components"}
_CREATE_FIELDS = ("project_key", "summary", "issue_type", "description", "priority", "labels", "parent_key",
                  "assignee", "story_points", "components")


def _normalise_keys(raw: dict) -> tuple[dict, list[str]]:
    fields, ignored = {}, []
    for key, value in raw.items():
        low = str(key).strip().lower().replace(" ", "")
        name = _ALIASES.get(low, low)
        if name in _CREATE_FIELDS:
            fields[name] = value
        else:
            ignored.append(str(key))
    return fields, ignored


def _str_list(value: Any, label: str) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        value = [v for v in re.split(r"[,\n]", value)]
    if not isinstance(value, list):
        raise ToolError(f"{label} must be a list of strings.")
    return [str(v).strip() for v in value if str(v).strip()]


def _points(value: Any) -> float | int | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ToolError(f"story_points must be a number, got '{value}'.") from None
    if number < 0:
        raise ToolError("story_points cannot be negative.")
    return int(number) if number.is_integer() else number


def _prepare(state: dict, fields: dict) -> dict:
    """A validated issue draft (no key yet) from create arguments, or a ToolError saying why not."""
    project = _project(state, fields.get("project_key"))
    summary = str(fields.get("summary") or "").strip()
    if not summary:
        raise ToolError("summary is required.")
    if len(summary) > MAX_SUMMARY:
        raise ToolError(f"summary is {len(summary)} characters; Jira allows {MAX_SUMMARY}. Shorten it and move details to the description.")
    issue_type = _canonical(fields.get("issue_type") or "Task", project["issue_types"], f"issue type for {project['key']}")
    parent_key = str(fields.get("parent_key") or "").strip().upper()
    if parent_key:
        if issue_type == "Epic":
            raise ToolError("An Epic cannot have a parent. Leave parent_key empty for epics.")
        parent = _issue(state, parent_key)
        if parent["issue_type"] != "Epic":
            raise ToolError(f"parent_key {parent_key} is a {parent['issue_type']}; the parent must be an Epic.")
    return {
        "project_key": project["key"], "issue_type": issue_type, "summary": summary,
        "description": str(fields.get("description") or "").strip(),
        "priority": _canonical(fields.get("priority") or "Medium", PRIORITIES, "priority"),
        # Jira labels cannot contain spaces.
        "labels": [re.sub(r"\s+", "-", label) for label in _str_list(fields.get("labels"), "labels")],
        "components": _str_list(fields.get("components"), "components"),
        "parent_key": parent_key, "assignee": str(fields.get("assignee") or "").strip(),
        "story_points": _points(fields.get("story_points")),
    }


def _insert(state: dict, draft: dict) -> dict:
    project_key = draft["project_key"]
    number = state["counters"].get(project_key, 0) + 1
    state["counters"][project_key] = number
    state["next_id"] = state.get("next_id", 10000) + 1
    key, now = f"{project_key}-{number}", _now()
    issue = {"key": key, "id": str(state["next_id"]), "url": _url(key), **draft, "status": "To Do",
             "resolution": "", "reporter": "DOINg.AI Factory", "comments": [],
             "created": now, "updated": now, "resolved": ""}
    state["issues"].append(issue)
    return issue


# ---------------------------------------------------------------------------
# JQL subset
# ---------------------------------------------------------------------------

JQL_HELP = ('Supported: project, issuetype (type), status, labels, priority, assignee, parent, key with = != IN (…) '
            'NOT IN (…) IS EMPTY; summary, description, text with ~ (all words) or !~; clauses joined by AND; '
            'ORDER BY created|updated|key|priority|status [ASC|DESC]. '
            'Example: project = MCPF AND issuetype = Epic AND summary ~ "nostro balances" ORDER BY updated DESC')
_JQL_TOKEN = re.compile(r'\s*(?:(?P<str>"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\')|(?P<op>!=|!~|=|~|\(|\)|,)|(?P<word>[^\s=!~(),"\']+))')
_FIELDS = {"project": "project_key", "issuetype": "issue_type", "type": "issue_type", "status": "status",
           "labels": "labels", "label": "labels", "priority": "priority", "assignee": "assignee",
           "parent": "parent_key", "key": "key", "issuekey": "key",
           "summary": "summary", "description": "description", "text": "text"}
_TEXT_FIELDS = {"summary", "description", "text"}
_ORDER_FIELDS = {"created", "updated", "key", "priority", "status"}
_TEXT_STOP = {"a", "an", "and", "the", "of", "for", "to", "in", "on", "with", "by", "or", "is", "be"}


def _jql_error(message: str) -> ToolError:
    return ToolError(f"JQL: {message}", supported=JQL_HELP)


def _lex(jql: str) -> list[tuple[str, str]]:
    out, pos, text = [], 0, jql.strip()
    while pos < len(text):
        match = _JQL_TOKEN.match(text, pos)
        if not match or match.end() == pos:
            raise _jql_error(f"cannot read '{text[pos:pos + 20]}'")
        pos = match.end()
        if match.group("str") is not None:
            raw = match.group("str")
            out.append(("value", re.sub(r"\\(.)", r"\1", raw[1:-1])))
        elif match.group("op") is not None:
            out.append(("op", match.group("op")))
        elif match.group("word") is not None:
            out.append(("word", match.group("word")))
    return out


def parse_jql(jql: str) -> tuple[list[tuple[str, str, list[str]]], list[tuple[str, bool]]]:
    """(clauses [(field, op, values)], order [(field, descending)]). op ∈ = != ~ !~ in notin empty notempty."""
    toks = _lex(jql)
    clauses: list[tuple[str, str, list[str]]] = []
    order: list[tuple[str, bool]] = []
    i = 0

    def peek(offset: int = 0) -> tuple[str, str] | None:
        return toks[i + offset] if i + offset < len(toks) else None

    def is_word(tok: tuple[str, str] | None, *words: str) -> bool:
        return tok is not None and tok[0] == "word" and tok[1].upper() in words

    def value() -> str:
        nonlocal i
        tok = peek()
        if tok is None or tok[0] == "op":
            raise _jql_error("a value is missing")
        i += 1
        return tok[1]

    while i < len(toks):
        if is_word(peek(), "ORDER"):
            if not is_word(peek(1), "BY"):
                raise _jql_error("ORDER must be followed by BY")
            i += 2
            while i < len(toks):
                name = value().lower()
                if name not in _ORDER_FIELDS:
                    raise _jql_error(f"cannot order by '{name}'")
                desc = False
                if is_word(peek(), "ASC", "DESC"):
                    desc = toks[i][1].upper() == "DESC"
                    i += 1
                order.append((name, desc))
                if peek() == ("op", ","):
                    i += 1
                elif peek() is not None:
                    raise _jql_error("unexpected text after ORDER BY")
            break
        tok = peek()
        if tok is None or tok[0] != "word":
            raise _jql_error("expected a field name")
        field = _FIELDS.get(tok[1].lower())
        if field is None:
            raise _jql_error(f"unsupported field '{tok[1]}'")
        i += 1
        nxt = peek()
        if nxt is not None and nxt[0] == "op" and nxt[1] in ("=", "!=", "~", "!~"):
            op = nxt[1]
            i += 1
            values = [value()]
        elif is_word(nxt, "IN") or (is_word(nxt, "NOT") and is_word(peek(1), "IN")):
            op = "in" if is_word(nxt, "IN") else "notin"
            i += 1 if op == "in" else 2
            if peek() != ("op", "("):
                raise _jql_error("IN must be followed by a list in parentheses")
            i += 1
            values = [value()]
            while peek() == ("op", ","):
                i += 1
                values.append(value())
            if peek() != ("op", ")"):
                raise _jql_error("missing ')'")
            i += 1
        elif is_word(nxt, "IS"):
            negate = is_word(peek(1), "NOT")
            i += 2 if negate else 1
            if not is_word(peek(), "EMPTY", "NULL"):
                raise _jql_error("IS must be followed by EMPTY or NOT EMPTY")
            i += 1
            op, values = ("notempty" if negate else "empty"), []
        else:
            raise _jql_error(f"expected an operator after '{tok[1]}'")
        if field in _TEXT_FIELDS and op not in ("~", "!~", "=", "!=", "empty", "notempty"):
            raise _jql_error(f"{tok[1]} supports ~ and !~")
        if field not in _TEXT_FIELDS and op in ("~", "!~"):
            raise _jql_error(f"~ only applies to summary, description or text (not {tok[1]})")
        clauses.append((field, op, values))
        if is_word(peek(), "AND"):
            i += 1
            if peek() is None:
                raise _jql_error("AND at the end of the query")
        elif is_word(peek(), "OR"):
            raise _jql_error("OR is not supported in the sandbox: run one search per alternative, or use IN (…)")
        elif peek() is not None and not is_word(peek(), "ORDER"):
            raise _jql_error(f"expected AND or ORDER BY, found '{peek()[1]}'")
    return clauses, order


def _words(text: str) -> set[str]:
    out = set()
    for w in re.findall(r"[a-z0-9]+", (text or "").lower()):
        if w in _TEXT_STOP:
            continue
        if len(w) > 4 and w.endswith("ies"):
            w = w[:-3] + "y"
        elif len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is")):
            w = w[:-1]
        out.add(w)
    return out


def _validate_values(field: str, values: list[str]) -> list[str]:
    """Statuses, types and priorities are closed lists: a typo would silently match nothing."""
    if field == "status":
        return [_canonical(v, STATUSES, "status") for v in values]
    if field == "priority":
        return [_canonical(v, PRIORITIES, "priority") for v in values]
    if field == "issue_type":
        return [_canonical(v, DELIVERY_TYPES + ["Change"], "issue type") for v in values]
    return values


def _matches(issue: dict, field: str, op: str, values: list[str]) -> bool:
    if field in _TEXT_FIELDS:
        text = issue.get("summary", "") if field == "summary" else issue.get("description", "") if field == "description" \
            else f"{issue.get('summary', '')} {issue.get('description', '')}"
        if op in ("empty", "notempty"):
            return (not text.strip()) == (op == "empty")
        if op in ("=", "!="):
            return (text.strip().lower() == values[0].strip().lower()) == (op == "=")
        hay = _words(text)
        hit = all(w in hay for w in _words(values[0])) and bool(_words(values[0]))
        return hit if op == "~" else not hit
    actual = issue.get(field)
    if op in ("empty", "notempty"):
        return (not actual) == (op == "empty")
    have = {str(a).lower() for a in actual} if isinstance(actual, list) else {str(actual or "").lower()}
    hit = any(str(v).lower() in have for v in values)
    return hit if op in ("=", "in") else not hit


def _sort_key(field: str):
    if field == "key":
        return lambda i: (i["project_key"], int(i["key"].rsplit("-", 1)[1]))
    if field == "priority":
        return lambda i: -PRIORITIES.index(i.get("priority", "Medium")) if i.get("priority") in PRIORITIES else 0
    if field == "status":
        return lambda i: STATUSES.index(i["status"]) if i.get("status") in STATUSES else 0
    return lambda i: i.get(field) or ""


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

server = McpServer(
    "jira-sandbox", VERSION, "Jira (Sandbox)",
    instructions="A sandbox Jira with projects MCPF, DATA, PAY, SEC and OPS. Search with a JQL subset "
                 "(jira_search) before creating, to avoid duplicates. Statuses: To Do, In Progress, Done.",
)

_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": {"type": "string"}}
_ISSUE_PROPS = {
    "project_key": {"type": "string", "description": "Jira project key, e.g. MCPF"},
    "summary": {"type": "string", "description": f"One line, max {MAX_SUMMARY} characters"},
    "issue_type": {"type": "string", "description": "Epic | Story | Task | Bug (OPS: Change | Task | Bug)"},
    "description": {"type": "string", "description": "Markdown/plain text body"},
    "priority": {"type": "string", "description": "Highest | High | Medium | Low | Lowest"},
    "labels": {**_STR_LIST, "description": "Labels (spaces become dashes)"},
    "parent_key": {"type": "string", "description": "Epic key the issue belongs to, e.g. MCPF-12"},
    "assignee": {"type": "string", "description": "Assignee e-mail or name"},
    "story_points": {"type": ["number", "null"]},
    "components": _STR_LIST,
}


@server.tool("jira_list_projects", "Jira projects with their key, name, lead, issue types and issue count.",
             {"type": "object", "properties": {}}, read_only=True)
def jira_list_projects() -> dict:
    state = STATE.read()
    counts: dict[str, int] = {}
    for issue in state["issues"]:
        counts[issue["project_key"]] = counts.get(issue["project_key"], 0) + 1
    return {"projects": [{**p, "issue_count": counts.get(p["key"], 0), "url": f"{BASE_URL}/projects/{p['key']}"}
                         for p in state["projects"]]}


@server.tool("jira_search", f"""
    Search issues with JQL (sandbox subset). {JQL_HELP}
    Returns issues without their full description (see jira_get_issue), most recently updated first
    unless ORDER BY says otherwise.
    """, {"type": "object", "properties": {
        "jql": {"type": "string"}, "limit": {"type": "integer", "description": "Max results (default 20, max 100)"}},
        "required": ["jql"]}, read_only=True)
def jira_search(jql: str, limit: int = 20) -> dict:
    if not (jql or "").strip():
        raise _jql_error("the query is empty")
    clauses, order = parse_jql(jql)
    clauses = [(f, op, _validate_values(f, vals) if op in ("=", "!=", "in", "notin") else vals) for f, op, vals in clauses]
    state = STATE.read()
    found = [i for i in state["issues"] if all(_matches(i, f, op, vals) for f, op, vals in clauses)]
    found.sort(key=_sort_key("key"), reverse=True)
    for field, desc in reversed(order or [("updated", True)]):   # stable sorts: last key first
        found.sort(key=_sort_key(field), reverse=desc)
    limit = max(1, min(int(limit or 20), 100))
    return {"jql": jql, "total": len(found), "issues": [_brief(i) for i in found[:limit]]}


@server.tool("jira_get_issue", """
    One issue in full (description, comments). For an Epic, also its child issues and progress.
    """, {"type": "object", "properties": {"issue_key": {"type": "string", "description": "e.g. MCPF-12"}},
          "required": ["issue_key"]}, read_only=True)
def jira_get_issue(issue_key: str) -> dict:
    state = STATE.read()
    issue = dict(_issue(state, issue_key))
    if issue["issue_type"] == "Epic":
        children = [i for i in state["issues"] if i.get("parent_key") == issue["key"]]
        issue["children"] = [{"key": c["key"], "summary": c["summary"], "issue_type": c["issue_type"],
                              "status": c["status"], "story_points": c.get("story_points")} for c in children]
        issue["progress"] = {"done": sum(1 for c in children if c["status"] == "Done"), "total": len(children)}
    elif issue.get("parent_key"):
        parent = next((i for i in state["issues"] if i["key"] == issue["parent_key"]), None)
        if parent:
            issue["parent"] = {"key": parent["key"], "summary": parent["summary"], "status": parent["status"]}
    return issue


@server.tool("jira_create_issue", """
    Create one issue (status To Do). Epics have no parent; a Story/Task/Bug may name its Epic in
    parent_key. Search first (jira_search) when the issue may already exist.
    """, {"type": "object", "properties": _ISSUE_PROPS, "required": ["project_key", "summary"]})
def jira_create_issue(project_key: str, summary: str, issue_type: str = "Task", description: str = "",
                      priority: str = "Medium", labels: list[str] | None = None, parent_key: str = "",
                      assignee: str = "", story_points: float | None = None, components: list[str] | None = None) -> dict:
    fields = {"project_key": project_key, "summary": summary, "issue_type": issue_type, "description": description,
              "priority": priority, "labels": labels, "parent_key": parent_key, "assignee": assignee,
              "story_points": story_points, "components": components}
    with STATE.write() as state:
        issue = _insert(state, _prepare(state, fields))
    return {"ok": True, "issue": issue}


@server.tool("jira_batch_create_issues", """
    Create several issues at once, e.g. the stories of an epic. Each item takes the fields of
    jira_create_issue (project_key, summary, issue_type, description, priority, labels, parent_key,
    assignee, story_points, components). All items are validated first: if one is invalid, none is
    created and the error names it.
    """, {"type": "object", "properties": {
        "issues": {"type": "array", "items": {"type": "object", "properties": _ISSUE_PROPS}}},
        "required": ["issues"]})
def jira_batch_create_issues(issues: list) -> dict:
    if not isinstance(issues, list) or not issues:
        raise ToolError("issues must be a non-empty list of issue objects.")
    if len(issues) > 50:
        raise ToolError(f"{len(issues)} issues in one batch; the limit is 50.")
    with STATE.write() as state:
        drafts, ignored = [], set()
        for index, raw in enumerate(issues):
            if not isinstance(raw, dict):
                raise ToolError(f"issues[{index}] must be an object, got {type(raw).__name__}.")
            fields, extra = _normalise_keys(raw)
            ignored.update(extra)
            try:
                drafts.append(_prepare(state, fields))
            except ToolError as exc:
                raise ToolError(f"issues[{index}] ({str(raw.get('summary') or '')[:60]!r}): {exc.payload['error']}",
                                **{k: v for k, v in exc.payload.items() if k != "error"},
                                note="Nothing was created: fix this item and send the whole batch again.") from None
        created = [_insert(state, d) for d in drafts]
    result: dict[str, Any] = {"ok": True, "count": len(created), "keys": [i["key"] for i in created], "created": created}
    if ignored:
        result["ignored_fields"] = sorted(ignored)
    return result


@server.tool("jira_update_issue", f"""
    Update fields of an issue. `fields` is an object with any of: {", ".join(UPDATABLE)}.
    Use jira_transition_issue to change the status.
    """, {"type": "object", "properties": {"issue_key": _STR, "fields": {"type": "object"}},
          "required": ["issue_key", "fields"]})
def jira_update_issue(issue_key: str, fields: dict) -> dict:
    if not isinstance(fields, dict) or not fields:
        raise ToolError("fields must be a non-empty object.", updatable_fields=list(UPDATABLE))
    patch, extra = _normalise_keys(fields)
    if "status" in fields:
        raise ToolError("status cannot be set here: use jira_transition_issue.")
    unknown = sorted(set(extra) | {k for k in patch if k not in UPDATABLE})
    if unknown:
        raise ToolError(f"Cannot update {', '.join(unknown)}.", updatable_fields=list(UPDATABLE))
    with STATE.write() as state:
        issue = _issue(state, issue_key)
        merged = _prepare(state, {**{k: issue.get(k) for k in _CREATE_FIELDS}, **patch})
        for key in patch:
            issue[key] = merged[key]
        issue["updated"] = _now()
        result = dict(issue)
    return {"ok": True, "issue": result, "updated_fields": sorted(patch)}


@server.tool("jira_transition_issue", """
    Move an issue to another status: To Do, In Progress or Done.
    """, {"type": "object", "properties": {"issue_key": _STR,
                                          "status": {"type": "string", "description": "To Do | In Progress | Done"}},
          "required": ["issue_key", "status"]})
def jira_transition_issue(issue_key: str, status: str) -> dict:
    target = _canonical(status, STATUSES, "status")
    with STATE.write() as state:
        issue = _issue(state, issue_key)
        previous = issue["status"]
        now = _now()
        issue["status"] = target
        issue["resolution"] = "Done" if target == "Done" else ""
        issue["resolved"] = now if target == "Done" else ""
        issue["updated"] = now
        result = dict(issue)
    return {"ok": True, "issue": result, "from": previous, "to": target}


@server.tool("jira_add_comment", "Add a comment to an issue.",
             {"type": "object", "properties": {"issue_key": _STR, "comment": _STR}, "required": ["issue_key", "comment"]})
def jira_add_comment(issue_key: str, comment: str) -> dict:
    if not (comment or "").strip():
        raise ToolError("comment cannot be empty.")
    with STATE.write() as state:
        issue = _issue(state, issue_key)
        now = _now()
        state["next_id"] = state.get("next_id", 10000) + 1
        entry = {"id": str(state["next_id"]), "author": "DOINg.AI Factory", "body": comment.strip(), "created": now}
        issue.setdefault("comments", []).append(entry)
        issue["updated"] = now
    return {"ok": True, "issue_key": issue["key"], "comment": entry}


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------

def _seed_issue(key: str, issue_type: str, summary: str, status: str, created: str, updated: str, *,
                description: str = "", parent: str = "", labels: tuple[str, ...] = (), points: float | None = None,
                priority: str = "Medium", assignee: str = "") -> dict:
    return {"key": key, "id": "", "url": _url(key), "project_key": key.split("-")[0], "issue_type": issue_type,
            "summary": summary, "description": description, "priority": priority, "labels": list(labels),
            "components": [], "parent_key": parent, "assignee": assignee, "story_points": points,
            "status": status, "resolution": "Done" if status == "Done" else "", "reporter": "sandbox",
            "comments": [], "created": created, "updated": updated, "resolved": updated if status == "Done" else ""}


def seed_state() -> dict:
    projects = [
        {"key": "MCPF", "name": "MCP Factory Squad", "lead": "sofia.rossi@doing.ai", "issue_types": DELIVERY_TYPES,
         "description": "Builds and runs the bank's MCP servers and agent tooling."},
        {"key": "DATA", "name": "Data Platform", "lead": "karim.benali@doing.ai", "issue_types": DELIVERY_TYPES,
         "description": "Data warehouse, lakehouse and data services."},
        {"key": "PAY", "name": "Payments", "lead": "sofia.rossi@doing.ai", "issue_types": DELIVERY_TYPES,
         "description": "Payments hub, cash management and treasury services IT."},
        {"key": "SEC", "name": "Security Engineering", "lead": "lucas.moreau@doing.ai", "issue_types": DELIVERY_TYPES,
         "description": "Application security, IAM and secrets management."},
        {"key": "OPS", "name": "IT Operations", "lead": "emma.leroy@doing.ai", "issue_types": OPS_TYPES,
         "description": "Change management, releases and production monitoring."},
    ]
    issues = [
        _seed_issue("MCPF-3", "Epic", "MCP — Teams Notifier MCP", "Done", "2025-02-10T09:00:00Z", "2025-03-28T16:00:00Z",
                    description="Post alerts and messages to Microsoft Teams channels from agents.", labels=("mcp",)),
        _seed_issue("MCPF-4", "Story", "Implement post_channel_message tool", "Done", "2025-02-12T09:00:00Z",
                    "2025-03-20T11:00:00Z", parent="MCPF-3", labels=("mcp",), points=3, assignee="karim.benali@doing.ai"),
        _seed_issue("MCPF-9", "Epic", "MCP — Research Library MCP", "In Progress", "2026-08-03T09:00:00Z",
                    "2026-09-30T10:00:00Z", description="Search published equity and credit research from agents.",
                    labels=("mcp", "research")),
        _seed_issue("MCPF-10", "Story", "Implement search_research tool", "In Progress", "2026-08-05T09:00:00Z",
                    "2026-09-30T10:00:00Z", parent="MCPF-9", labels=("mcp",), points=5, assignee="karim.benali@doing.ai"),
        _seed_issue("MCPF-11", "Task", "Publish MCP server template v2 (stdio + streamable HTTP)", "To Do",
                    "2026-09-15T09:00:00Z", "2026-09-15T09:00:00Z", labels=("mcp", "template"), points=3),
        _seed_issue("DATA-7", "Epic", "MCP — Client 360 MCP", "Done", "2025-03-03T09:00:00Z", "2025-05-09T15:00:00Z",
                    description="Expose the client golden record (LEI, hierarchy, coverage) to agents.", labels=("mcp", "client-data")),
        _seed_issue("DATA-8", "Story", "Expose get_group_hierarchy from the MDM golden record", "Done",
                    "2025-03-05T09:00:00Z", "2025-04-18T12:00:00Z", parent="DATA-7", labels=("mcp",), points=5),
        _seed_issue("DATA-23", "Task", "Document the intraday position tables of the Treasury warehouse", "To Do",
                    "2026-09-01T09:00:00Z", "2026-09-01T09:00:00Z",
                    description="Tables LIQ_POSITION_INTRADAY and LIQ_BUFFER_HIST in the Oracle Treasury warehouse are undocumented.",
                    labels=("treasury", "documentation"), priority="Low"),
        _seed_issue("PAY-12", "Epic", "MCP — Payments Hub MCP", "Done", "2025-05-12T09:00:00Z", "2025-07-18T17:00:00Z",
                    description="Payment search, status and aggregated intraday flows for agents.", labels=("mcp", "payments")),
        _seed_issue("PAY-31", "Epic", "Nostro Balances MCP — real-time nostro positions", "To Do", "2026-08-20T09:00:00Z",
                    "2026-08-20T09:00:00Z",
                    description="Expose nostro account balances at correspondent banks (MT940/MT950, camt.053) to agents. "
                                "Requested by Treasury Services; not started.", labels=("mcp", "treasury"), priority="High"),
        _seed_issue("SEC-3", "Task", "Penetration test — Payments Hub MCP", "Done", "2025-06-02T09:00:00Z",
                    "2025-06-27T16:00:00Z", labels=("mcp", "pentest"), assignee="lucas.moreau@doing.ai"),
        _seed_issue("SEC-8", "Task", "Quarterly access recertification of MCP service accounts", "In Progress",
                    "2026-09-29T09:00:00Z", "2026-10-06T09:00:00Z", labels=("mcp", "iam"), assignee="lucas.moreau@doing.ai"),
        _seed_issue("SEC-9", "Bug", "Document Vault MCP returns stack traces on malformed document ids", "To Do",
                    "2026-10-03T09:00:00Z", "2026-10-03T09:00:00Z", labels=("mcp", "error-handling"), priority="High"),
        _seed_issue("OPS-40", "Change", "Production release — Client 360 MCP v1.2", "Done", "2026-06-08T09:00:00Z",
                    "2026-06-11T20:00:00Z", labels=("mcp", "release"), assignee="emma.leroy@doing.ai"),
        _seed_issue("OPS-41", "Change", "Patch Payments Hub MCP to v2.3.1", "In Progress", "2026-10-07T09:00:00Z",
                    "2026-10-09T08:00:00Z", labels=("mcp", "release"), assignee="emma.leroy@doing.ai"),
    ]
    for n, issue in enumerate(issues, start=1):
        issue["id"] = str(10000 + n)
    return {"projects": projects, "issues": issues,
            "counters": {"MCPF": 11, "DATA": 23, "PAY": 31, "SEC": 9, "OPS": 41},
            "next_id": 10000 + len(issues)}


if __name__ == "__main__":
    server.run()
