"""Test double of sooperset/mcp-atlassian (Jira tools only): a small Jira behind the same MCP
tool names, argument shapes and result shapes, over stdio.

    FAKE_JIRA_STATE=/path/jira.json  python fake_jira_mcp.py

Mirrors what the Factory's standard Jira operations rely on:
- `jira_search(jql, fields, limit, start_at)` → {total, start_at, max_results, issues: [issue]}
- `jira_get_issue(issue_key, fields, …)` → issue
- `jira_create_issue(project_key, summary, issue_type, assignee, description, components,
  additional_fields)` → {message, issue}; `components` is a comma-separated string and
  `additional_fields` a JSON object string (`parent`, `labels`, `priority`, fields by display
  name such as "Epic Link" or "Story Points", `customfield_*`).
- `jira_batch_create_issues(issues, validate_only)` → {message, issues}; `issues` is a JSON
  array string. As in mcp-atlassian, `parent` is ignored by the batch tool: link a batch to its
  epic with the "Epic Link" field.
- `jira_transition_issue(issue_key, transition_id, fields, comment)`, `jira_get_transitions`,
  `jira_add_comment(issue_key, body)`, `jira_get_all_projects()`.
An issue reads as mcp-atlassian's simplified issue: `url` is the REST self link and
`browse_url` the page a person opens; `status` is {name, category}.

State: one JSON file (env FAKE_JIRA_STATE), seeded on first run with five team projects —
MCPF, DATA, PAY, SEC, OPS (change requests) — and a few issues, among them an open epic for
a server that was requested but never started, so a find-or-create step has something to find.
"""
from __future__ import annotations

import json
import os
import re
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mcp_servers"))
from _mcp_stdio import McpServer, ToolError  # noqa: E402

try:   # POSIX
    import fcntl
except ImportError:   # pragma: no cover - Windows
    fcntl = None   # type: ignore[assignment]
try:   # Windows
    import msvcrt
except ImportError:
    msvcrt = None   # type: ignore[assignment]

VERSION = "0.11.0-fake"
BASE_URL = "https://jira.example.test"

STATUSES = ("To Do", "In Progress", "Done")
CATEGORIES = {"To Do": "To Do", "In Progress": "In Progress", "Done": "Done"}
TRANSITIONS = [{"id": "11", "name": "To Do"}, {"id": "21", "name": "In Progress"}, {"id": "31", "name": "Done"}]
PRIORITIES = ("Highest", "High", "Medium", "Low", "Lowest")
DELIVERY_TYPES = ["Epic", "Story", "Task", "Bug"]
OPS_TYPES = ["Change", "Task", "Bug"]
MAX_SUMMARY = 255
# Fields the name map resolves (lower-cased display names, as mcp-atlassian matches them).
NAMED_FIELDS = {"labels": "labels", "priority": "priority", "epic link": "parent_key", "story points": "story_points",
                "customfield_10014": "parent_key", "customfield_10016": "story_points"}


# ---------------------------------------------------------------------------
# On-disk JSON state (one file shared by every process the Factory spawns)
# ---------------------------------------------------------------------------

class JsonState:
    """Every read reloads the file; every write is a read-modify-write under an exclusive lock
    file, committed with tmp + os.replace, so parallel processes never lose a write."""

    def __init__(self, path: str | Path, seed: Callable[[], dict]) -> None:
        self.path = Path(path).expanduser().resolve()
        self._seed = seed

    def read(self) -> dict:
        if not self.path.exists():
            with self.write():
                pass
        return json.loads(self.path.read_text(encoding="utf-8"))

    @contextmanager
    def write(self) -> Iterator[dict]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with _locked(self.path.with_name(self.path.name + ".lock")):
            data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else self._seed()
            yield data
            tmp = self.path.with_name(f"{self.path.name}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, self.path)


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


STATE = JsonState(os.environ.get("FAKE_JIRA_STATE") or "fake-jira.json", lambda: seed_state())


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000+0000")


def _canonical(value: Any, allowed: tuple[str, ...] | list[str], label: str) -> str:
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
    raise ToolError(f"Issue '{key}' not found.")


def simplified(issue: dict, *, full: bool = False) -> dict:
    """mcp-atlassian's JiraIssue.to_simplified_dict() (the fields the Factory reads)."""
    out: dict[str, Any] = {
        "id": issue["id"], "key": issue["key"], "summary": issue["summary"],
        "url": f"{BASE_URL}/rest/api/2/issue/{issue['id']}", "browse_url": f"{BASE_URL}/browse/{issue['key']}",
        "status": {"name": issue["status"], "category": CATEGORIES.get(issue["status"], "To Do")},
        "issue_type": {"name": issue["issue_type"]}, "priority": {"name": issue.get("priority") or "Medium"},
        "project": {"key": issue["project_key"]},
        "assignee": {"display_name": issue["assignee"]} if issue.get("assignee") else {"display_name": "Unassigned"},
        "created": issue["created"], "updated": issue["updated"],
    }
    if issue.get("labels"):
        out["labels"] = list(issue["labels"])
    if issue.get("components"):
        out["components"] = list(issue["components"])
    if issue.get("parent_key"):
        out["parent"] = {"key": issue["parent_key"]}
        out["epic_key"] = issue["parent_key"]
    if issue.get("story_points") is not None:
        out["customfield_10016"] = {"value": issue["story_points"], "name": "Story Points"}
    if issue.get("description"):
        out["description"] = issue["description"] if full else issue["description"][:200]
    if full and issue.get("comments"):
        out["comments"] = issue["comments"]
    return out


def _str_list(value: Any) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list):
        raise ToolError("expected a list of names or a comma-separated string.")
    return [str(v).strip() for v in value if str(v).strip()]


def _points(value: Any) -> float | int | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ToolError(f"Story Points must be a number, got '{value}'.") from None
    return int(number) if number.is_integer() else number


def _json_arg(value: Any, label: str, kind: type) -> Any:
    """mcp-atlassian takes JSON-in-a-string for objects and arrays."""
    if value in (None, ""):
        return kind()
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as exc:
            raise ToolError(f"{label} must be a valid JSON {kind.__name__} string: {exc}") from None
    if not isinstance(value, kind):
        raise ToolError(f"{label} must be a JSON {kind.__name__}.")
    return value


def _apply_fields(draft: dict, extra: dict, *, allow_parent: bool) -> None:
    """additional_fields / leftover batch keys → the issue (unknown names are ignored, as the
    real server logs and skips them)."""
    for key, value in extra.items():
        if key == "parent":
            if allow_parent:
                draft["parent_key"] = str(value.get("key") if isinstance(value, dict) else value or "").strip().upper()
            continue
        name = NAMED_FIELDS.get(str(key).strip().lower())
        if name == "labels":
            draft["labels"] = [re.sub(r"\s+", "-", label) for label in _str_list(value)]
        elif name == "priority":
            draft["priority"] = _canonical(value.get("name") if isinstance(value, dict) else value, PRIORITIES, "priority")
        elif name == "parent_key":
            draft["parent_key"] = str(value or "").strip().upper()
        elif name == "story_points":
            draft["story_points"] = _points(value)


def _prepare(state: dict, project_key: Any, summary: Any, issue_type: Any, description: Any = None,
             assignee: Any = None, components: Any = None, extra: dict | None = None, *,
             allow_parent: bool = True) -> dict:
    project = _project(state, project_key)
    summary = str(summary or "").strip()
    if not summary:
        raise ToolError("summary is required.")
    if len(summary) > MAX_SUMMARY:
        raise ToolError(f"summary is {len(summary)} characters; Jira allows {MAX_SUMMARY}.")
    if not str(issue_type or "").strip():
        raise ToolError("issue_type is required.")
    draft = {"project_key": project["key"],
             "issue_type": _canonical(issue_type, project["issue_types"], f"issue type for {project['key']}"),
             "summary": summary, "description": str(description or "").strip(), "priority": "Medium",
             "labels": [], "components": _str_list(components), "parent_key": "",
             "assignee": str(assignee or "").strip(), "story_points": None}
    _apply_fields(draft, extra or {}, allow_parent=allow_parent)
    if draft["parent_key"]:
        if draft["issue_type"] == "Epic":
            raise ToolError("An Epic cannot have a parent.")
        parent = _issue(state, draft["parent_key"])
        if parent["issue_type"] != "Epic":
            raise ToolError(f"{draft['parent_key']} is a {parent['issue_type']}; the parent must be an Epic.")
    return draft


def _insert(state: dict, draft: dict) -> dict:
    project_key = draft["project_key"]
    number = state["counters"].get(project_key, 0) + 1
    state["counters"][project_key] = number
    state["next_id"] = state.get("next_id", 10000) + 1
    now = _now()
    issue = {"key": f"{project_key}-{number}", "id": str(state["next_id"]), **draft, "status": "To Do",
             "reporter": "factory-service-account", "comments": [], "created": now, "updated": now}
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
            raise _jql_error("OR is not supported by this test double: run one search per alternative, or use IN (…)")
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
# Tools (names and arguments of mcp-atlassian)
# ---------------------------------------------------------------------------

server = McpServer("mcp-atlassian", VERSION, "Atlassian MCP (test double)",
                   instructions="Jira tools: jira_search (JQL), jira_get_issue, jira_create_issue, "
                                "jira_batch_create_issues, jira_transition_issue, jira_add_comment.")

_STR = {"type": "string"}


@server.tool("jira_get_all_projects", "All Jira projects the user can see.", {"type": "object", "properties": {}},
             read_only=True)
def jira_get_all_projects() -> list:
    return [{"key": p["key"], "name": p["name"], "issue_types": p["issue_types"]} for p in STATE.read()["projects"]]


@server.tool("jira_search", f"Search Jira issues using JQL. Supported subset: {JQL_HELP}", {
    "type": "object", "properties": {
        "jql": _STR, "fields": {"type": "string", "description": "Comma-separated fields to return"},
        "limit": {"type": "integer", "description": "Maximum results (1-50, default 10)"},
        "start_at": {"type": "integer"}},
    "required": ["jql"]}, read_only=True)
def jira_search(jql: str, fields: str = "", limit: int = 10, start_at: int = 0) -> dict:
    if not (jql or "").strip():
        raise _jql_error("the query is empty")
    clauses, order = parse_jql(jql)
    clauses = [(f, op, _validate_values(f, vals) if op in ("=", "!=", "in", "notin") else vals) for f, op, vals in clauses]
    state = STATE.read()
    found = [i for i in state["issues"] if all(_matches(i, f, op, vals) for f, op, vals in clauses)]
    found.sort(key=_sort_key("key"), reverse=True)
    for field, desc in reversed(order or [("updated", True)]):
        found.sort(key=_sort_key(field), reverse=desc)
    limit = max(1, min(int(limit or 10), 50))
    start = max(0, int(start_at or 0))
    return {"total": len(found), "start_at": start, "max_results": limit,
            "issues": [simplified(i) for i in found[start:start + limit]]}


@server.tool("jira_get_issue", "Get details of a specific Jira issue.", {
    "type": "object", "properties": {"issue_key": _STR, "fields": _STR, "expand": _STR,
                                     "comment_limit": {"type": "integer"}},
    "required": ["issue_key"]}, read_only=True)
def jira_get_issue(issue_key: str, fields: str = "", expand: str = "", comment_limit: int = 10) -> dict:
    return simplified(_issue(STATE.read(), issue_key), full=True)


@server.tool("jira_create_issue", "Create a new Jira issue.", {
    "type": "object", "properties": {
        "project_key": _STR, "summary": _STR, "issue_type": _STR, "assignee": _STR, "description": _STR,
        "components": {"type": "string", "description": "Comma-separated component names"},
        "additional_fields": {"type": "string", "description": "JSON object string of other fields"}},
    "required": ["project_key", "summary", "issue_type"]})
def jira_create_issue(project_key: str, summary: str, issue_type: str, assignee: str = "", description: str = "",
                      components: str = "", additional_fields: str = "") -> dict:
    extra = _json_arg(additional_fields, "additional_fields", dict)
    with STATE.write() as state:
        issue = _insert(state, _prepare(state, project_key, summary, issue_type, description, assignee, components,
                                        extra))
    return {"message": "Issue created successfully", "issue": simplified(issue, full=True)}


@server.tool("jira_batch_create_issues", "Create multiple Jira issues in a batch.", {
    "type": "object", "properties": {
        "issues": {"type": "string", "description": "JSON array of issue objects (project_key, summary, issue_type, "
                                                    "description, assignee, components, other fields by name)"},
        "validate_only": {"type": "boolean"}},
    "required": ["issues"]})
def jira_batch_create_issues(issues: str, validate_only: bool = False) -> dict:
    items = _json_arg(issues, "issues", list)
    if not items:
        raise ToolError("issues must be a non-empty JSON array.")
    with STATE.write() as state:
        drafts = []
        for index, raw in enumerate(items):
            if not isinstance(raw, dict):
                raise ToolError(f"issues[{index}] must be an object.")
            rest = {k: v for k, v in raw.items()
                    if k not in ("project_key", "summary", "issue_type", "description", "assignee", "components")}
            try:
                drafts.append(_prepare(state, raw.get("project_key"), raw.get("summary"), raw.get("issue_type"),
                                       raw.get("description"), raw.get("assignee"), raw.get("components"), rest,
                                       allow_parent=False))
            except ToolError as exc:
                raise ToolError(f"issues[{index}]: {exc.payload['error']}",
                                **{k: v for k, v in exc.payload.items() if k != "error"}) from None
        if validate_only:
            return {"message": "Issues validated successfully", "issues": []}
        created = [_insert(state, d) for d in drafts]
    return {"message": "Issues created successfully", "issues": [simplified(i) for i in created]}


@server.tool("jira_get_transitions", "Get available status transitions for a Jira issue.",
             {"type": "object", "properties": {"issue_key": _STR}, "required": ["issue_key"]}, read_only=True)
def jira_get_transitions(issue_key: str) -> list:
    _issue(STATE.read(), issue_key)
    return [dict(t) for t in TRANSITIONS]


@server.tool("jira_transition_issue", "Transition a Jira issue to a new status.", {
    "type": "object", "properties": {"issue_key": _STR, "transition_id": {"type": "string", "description": "ID or name"},
                                     "fields": _STR, "comment": _STR},
    "required": ["issue_key", "transition_id"]})
def jira_transition_issue(issue_key: str, transition_id: str, fields: str = "", comment: str = "") -> dict:
    wanted = str(transition_id or "").strip().lower()
    target = next((t["name"] for t in TRANSITIONS if wanted in (t["id"], t["name"].lower())), None)
    if target is None:
        raise ToolError(f"Transition '{transition_id}' is not available.", available=TRANSITIONS)
    with STATE.write() as state:
        issue = _issue(state, issue_key)
        issue["status"] = target
        issue["updated"] = _now()
        if (comment or "").strip():
            issue.setdefault("comments", []).append({"id": str(len(issue["comments"]) + 1), "body": comment.strip(),
                                                     "author": "factory-service-account", "created": _now()})
        result = simplified(issue, full=True)
    return {"message": f"Issue {result['key']} transitioned successfully", "issue": result}


@server.tool("jira_add_comment", "Add a comment to a Jira issue.", {
    "type": "object", "properties": {"issue_key": _STR, "body": _STR}, "required": ["issue_key", "body"]})
def jira_add_comment(issue_key: str, body: str) -> dict:
    if not (body or "").strip():
        raise ToolError("body cannot be empty.")
    with STATE.write() as state:
        issue = _issue(state, issue_key)
        entry = {"id": str(len(issue.setdefault("comments", [])) + 1), "body": body.strip(),
                 "author": "factory-service-account", "created": _now()}
        issue["comments"].append(entry)
        issue["updated"] = entry["created"]
    return entry


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------

def _seed_issue(key: str, issue_type: str, summary: str, status: str, created: str, updated: str, *,
                description: str = "", parent: str = "", labels: tuple[str, ...] = (), points: float | None = None,
                priority: str = "Medium", assignee: str = "") -> dict:
    return {"key": key, "id": "", "project_key": key.split("-")[0], "issue_type": issue_type,
            "summary": summary, "description": description, "priority": priority, "labels": list(labels),
            "components": [], "parent_key": parent, "assignee": assignee, "story_points": points,
            "status": status, "reporter": "jira-admin", "comments": [], "created": created, "updated": updated}


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
