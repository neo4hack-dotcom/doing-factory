"""DOINg.AI MCP server — the DOINg.AI project portfolio over MCP (docs/SPEC.md §13).

    DOING_AI_URL=http://localhost:3001  python doing_ai_mcp.py

Talks to a running DOINg.AI backend (its `server.py`) and nothing else: there is no local
data and no fallback. Without DOING_AI_URL, or when `GET /api/version` does not answer, the
process refuses to start and says why on stderr (shown on the connector card).

- Reads: `GET /api/data` returns the whole application state, password hashes, MCP tokens and
  API-fed telemetry headers included, so secret fields are stripped (and credentials in URLs
  masked) before anything leaves this process.
- Writes (`update_project_status`, `register_mcp_server`): DOINg.AI stores one JSON document,
  so a write is read-modify-write of the *whole* document: `GET /api/data` → change one entity
  in place (its `updatedAt` refreshed) → `POST /api/data` with the full document and header
  `X-Base-Version: <lastUpdated it was read at>`. Nothing else in the document is touched:
  secrets, `deletedIds` tombstones and every other collection go back exactly as read. When
  another client wrote in between, DOINg.AI merges by id (the most recently updated version of
  each entity wins, nested `{id}` arrays such as `auditLog` are unioned) and answers
  `merged: true`; a 409 (stale version refused) is retried once on a fresh read, then reported.
  A document without `lastUpdated` is not DOINg.AI's state and is never written back.
- DOING_AI_TOKEN (optional): sent as `Authorization: Bearer …`, for an instance behind an
  authenticating reverse proxy. DOING_AI_TIMEOUT: seconds per HTTP call (default 15).

Shapes follow DOINg.AI's `src/types.ts` (camelCase: Project, McpServer, WishItem, User,
BusinessUnit). Responses add resolved convenience objects (`sponsor`, `manager` as
{id, name, email}, `businessUnit` as a name) so a caller never needs a second lookup.
"""
from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _mcp_stdio import McpServer, ToolError  # noqa: E402

VERSION = "2.0.0"

PROJECT_STATUSES = ("Planning", "Active", "Paused", "Done")
DEV_STATUSES = ("to_start", "dev", "uat", "prod")
DEPLOY_STATUSES = ("dev", "uat", "production")
WISH_CATEGORIES = ("project", "mcp", "agent", "datafeed", "feature", "integration", "other")
WISH_STATUSES = ("submitted", "under_review", "accepted", "in_progress", "done", "rejected", "on_hold")
COLLECTIONS = ("users", "projects", "mcpServers", "wishes", "businessUnits")

# Bulky or sensitive-by-nature fields that list views leave out (get_project keeps the tasks).
_LIST_DROP = {"auditLog", "telemetry", "presentations", "roiModel", "tasks", "codeAnalysis"}
# Secrets DOINg.AI's /api/data exposes: users' password hashes, MCP server tokens, and the
# request headers/body of API-fed project telemetry (an Authorization header as a JSON string).
_SECRET_KEY = re.compile(r"^(password|passwordhash|passwordsalt|token|apikey|api_key|secret|clientsecret|"
                         r"accesstoken|refreshtoken|privatekey|apiheaders|apibody|headers|authorization|"
                         r"cookie|credentials?)$", re.IGNORECASE)
_URL_CREDENTIALS = re.compile(r"(://[^/@\s:]+:)[^/@\s]+@")
_URL_SECRET_PARAM = re.compile(r"([?&](?:api[_-]?key|key|token|access_token|secret|password|sig|signature)=)[^&#\s]+",
                               re.IGNORECASE)
ACTOR = "DOINg.AI Factory"


# ---------------------------------------------------------------------------
# DOINg.AI over HTTP
# ---------------------------------------------------------------------------

class Conflict(Exception):
    """DOINg.AI refused a write made on a stale version (HTTP 409)."""


class DoingAI:
    def __init__(self, url: str, token: str = "", timeout: float = 15) -> None:
        self.url = url.strip().rstrip("/")
        self.token = token.strip()
        self.timeout = timeout

    @classmethod
    def from_env(cls) -> "DoingAI":
        url = (os.environ.get("DOING_AI_URL") or "").strip()
        if not url:
            raise SystemExit("DOING_AI_URL is not set: give the address of the DOINg.AI backend, e.g. "
                             "http://localhost:3001 (its server.py), in the connector's environment.")
        if not url.startswith(("http://", "https://")):
            raise SystemExit(f"DOING_AI_URL must start with http:// or https:// (got {url!r}).")
        try:
            timeout = float(os.environ.get("DOING_AI_TIMEOUT") or 15)
        except ValueError:
            raise SystemExit("DOING_AI_TIMEOUT must be a number of seconds.") from None
        return cls(url, os.environ.get("DOING_AI_TOKEN") or "", timeout)

    def _call(self, method: str, path: str, body: dict | None = None, headers: dict | None = None) -> Any:
        sent = {"Accept": "application/json", **(headers or {})}
        if self.token:
            sent["Authorization"] = f"Bearer {self.token}"
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            sent["Content-Type"] = "application/json"
        request = urllib.request.Request(f"{self.url}{path}", data=data, headers=sent, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            if exc.code == 409:
                raise Conflict() from None
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            raise ToolError(f"DOINg.AI answered HTTP {exc.code} on {method} {self.url}{path}"
                            + (f": {detail}" if detail else "")
                            + ". Check DOING_AI_URL and, if the instance is protected, DOING_AI_TOKEN.") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise ToolError(f"Cannot reach DOINg.AI at {self.url} ({reason}). Is it running? Check DOING_AI_URL.") from None
        try:
            return json.loads(raw)
        except ValueError:
            raise ToolError(f"{self.url}{path} did not return JSON — is DOING_AI_URL the DOINg.AI backend "
                            "(port 3001 by default), not its web UI?") from None

    def document(self) -> dict:
        """The whole DOINg.AI state as stored, secrets included (only ever sent back to DOINg.AI)."""
        body = self._call("GET", "/api/data")
        if not isinstance(body, dict):
            raise ToolError(f"{self.url}/api/data returned {type(body).__name__}, expected the DOINg.AI state object.")
        return body

    def snapshot(self) -> dict[str, list[dict]]:
        """The collections the tools read, secrets stripped."""
        doc = self.document()
        return strip_secrets({name: [r for r in (doc.get(name) or []) if isinstance(r, dict)] for name in COLLECTIONS})

    def write(self, tool: str, change: Callable[[dict], Any]) -> tuple[Any, bool]:
        """Read the document, apply `change` to it in place (it returns the tool's answer, or
        raises ToolError and nothing is written), send it back under optimistic concurrency.
        → (answer, merged). A stale-version refusal (409) is retried once on a fresh read."""
        for attempt in (1, 2):
            doc = self.document()
            if not isinstance(doc.get("lastUpdated"), (int, float)) or isinstance(doc.get("lastUpdated"), bool):
                raise ToolError(f"{self.url}/api/data has no 'lastUpdated' version: this is not the DOINg.AI "
                                f"state document, so {tool} refuses to write to it (it would overwrite the "
                                "whole store). Check DOING_AI_URL.")
            base = str(doc["lastUpdated"])
            answer = change(doc)
            try:
                reply = self._call("POST", "/api/data", doc, {"X-Base-Version": base})
            except Conflict:
                if attempt == 1:
                    continue
                raise ToolError(f"DOINg.AI refused the write twice: the data changed while {tool} was saving. "
                                "Nothing was changed; run it again.") from None
            if not isinstance(reply, dict) or reply.get("ok") is not True:
                raise ToolError(f"DOINg.AI did not confirm the write of {tool}: {str(reply)[:300]}")
            return answer, bool(reply.get("merged"))
        raise AssertionError("unreachable")   # pragma: no cover


def strip_secrets(value: Any) -> Any:
    """Drop secret-named fields at any depth, and mask credentials embedded in URLs
    (`https://user:pass@host`, `?api_key=…`)."""
    if isinstance(value, dict):
        return {k: strip_secrets(v) for k, v in value.items() if not _SECRET_KEY.match(str(k))}
    if isinstance(value, list):
        return [strip_secrets(v) for v in value]
    if isinstance(value, str) and "://" in value:
        return _URL_SECRET_PARAM.sub(r"\1••••", _URL_CREDENTIALS.sub(r"\1••••@", value))
    return value


CLIENT: DoingAI | None = None


def _doing_ai() -> DoingAI:
    global CLIENT
    if CLIENT is None:
        CLIENT = DoingAI.from_env()
    return CLIENT


def _lists(doc: dict) -> dict[str, list[dict]]:
    """The collections of a raw document; the entities are the document's own objects, so a
    change to one is a change to the document. Absent collections read as empty (not created)."""
    return {name: [r for r in (doc.get(name) or []) if isinstance(r, dict)] for name in COLLECTIONS}


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

def _now() -> str:
    """An ISO instant as DOINg.AI writes them (JavaScript's toISOString)."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _ascii(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()


def _full_name(user: dict) -> str:
    return " ".join(p for p in (user.get("firstName"), user.get("lastName")) if p).strip() or user.get("name") or user.get("uid") or user.get("id", "")


def _user_ref(users: dict[str, dict], user_id: str | None) -> dict | None:
    user = users.get(user_id or "")
    return {"id": user["id"], "name": _full_name(user), "email": user.get("email", "")} if user else None


def _public_user(user: dict) -> dict:
    keep = ("id", "uid", "firstName", "lastName", "email", "team", "squadTeam", "functionTitle", "role",
            "isIT", "avatarColor", "createdAt")
    return {"id": user.get("id"), "name": _full_name(user), **{k: user[k] for k in keep if k in user and k != "id"}}


def _project_view(project: dict, data: dict, *, full: bool = False) -> dict:
    users = {u.get("id"): u for u in data["users"]}
    units = {b.get("id"): b for b in data["businessUnits"]}
    out = dict(project) if full else {k: v for k, v in project.items() if k not in _LIST_DROP}
    if not full:
        tasks = project.get("tasks") or []
        out["taskStats"] = {"total": len(tasks), "done": sum(1 for t in tasks if t.get("status") == "Done")}
    out["sponsor"] = _user_ref(users, project.get("sponsorId"))
    out["manager"] = _user_ref(users, project.get("managerId"))
    out["businessUnit"] = (units.get(project.get("businessUnitId") or "") or {}).get("name", "")
    if full:
        servers = {s.get("id"): s for s in data["mcpServers"]}
        out["mcpServers"] = [{"id": sid, "name": servers[sid].get("name"), "deployStatus": servers[sid].get("deployStatus")}
                             for sid in project.get("mcpServerIds") or [] if sid in servers]
        out["members"] = [{**m, "name": (_user_ref(users, m.get("userId")) or {}).get("name", "")}
                          for m in project.get("members") or []]
    return out


def _server_view(server: dict) -> dict:
    return {k: v for k, v in server.items() if k not in _LIST_DROP}


def _wish_view(wish: dict, data: dict) -> dict:
    users = {u.get("id"): u for u in data["users"]}
    return {**wish, "requester": _user_ref(users, wish.get("requesterId")),
            "sponsor": _user_ref(users, wish.get("sponsorId"))}


def _pick(value: str, allowed: tuple[str, ...], label: str) -> str:
    """The canonical spelling of an enum value (case-insensitive), or a ToolError listing the options."""
    def norm(text: str) -> str:
        return re.sub(r"[\s-]+", "_", (text or "").strip().lower())

    for option in allowed:
        if norm(option) == norm(value):
            return option
    raise ToolError(f"Unknown {label} '{value}'.", **{f"allowed_{label}_values": list(allowed)})


def _parse_since(value: str) -> datetime:
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        raise ToolError(f"updated_since '{value}' is not an ISO date (e.g. 2026-10-01 or 2026-10-01T08:00:00Z).") from None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def _find_project(data: dict, project_id: str) -> dict:
    wanted = (project_id or "").strip()
    for p in data["projects"]:
        if p.get("id") == wanted:
            return p
    for p in data["projects"]:   # a caller (or an LLM) often only knows the name
        if (p.get("name") or "").strip().lower() == wanted.lower():
            return p
    raise ToolError(f"Project '{project_id}' not found.", hint="Call list_projects to get project ids.",
                    known_projects=[{"id": p.get("id"), "name": p.get("name")} for p in data["projects"][:25]])


# ---------------------------------------------------------------------------
# Catalog search: weighted token overlap (no embeddings — explainable, offline, deterministic)
# ---------------------------------------------------------------------------

_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "by", "for", "from", "in", "into", "is", "it", "its", "of", "on", "or",
    "per", "the", "to", "via", "with", "our", "their", "all", "each", "any", "e", "g", "eg", "etc", "s",
    # generic in an MCP catalog of a bank: they match everything and so discriminate nothing
    "mcp", "server", "servers", "tool", "tools", "api", "data", "information", "access", "get", "list", "read",
    "service", "system", "bank", "banking", "real", "time", "realtime", "live", "current", "latest", "date",
}
_SYNONYMS = {
    "fx": ("currency", "foreign", "exchange"), "currency": ("fx",), "exchange": ("fx",),
    "client": ("customer", "counterparty"), "customer": ("client",), "counterparty": ("client",),
    "document": ("contract", "agreement"), "contract": ("document", "agreement"), "agreement": ("contract", "document"),
    "price": ("rate", "quote"), "rate": ("price",), "quote": ("price",),
    "payment": ("settlement", "transfer"), "settlement": ("payment",), "transfer": ("payment",),
    "notification": ("alert", "message"), "alert": ("notification", "message"), "message": ("notification",),
    "trade": ("deal", "transaction"), "deal": ("trade",),
    "kyc": ("diligence", "onboarding"), "diligence": ("kyc",), "aml": ("kyc", "sanction"),
    "rating": ("credit",), "exposure": ("limit",), "limit": ("exposure",),
}
_WEIGHTS = (("name", 1.0), ("tags", 0.9), ("tools", 0.8), ("description", 0.7), ("useCase", 0.6),
            ("dataSourceUsed", 0.6), ("enrichedDescription", 0.5), ("category", 0.5))
_SYNONYM_FACTOR = 0.7


def _stem(token: str) -> str:
    if len(token) > 4 and token.endswith("ies"):
        return token[:-3] + "y"
    if len(token) > 4 and token.endswith(("ches", "shes", "sses", "xes", "zes")):
        return token[:-2]
    if len(token) > 3 and token.endswith("s") and not token.endswith(("ss", "us", "is")):
        return token[:-1]
    return token


def tokens(text: Any) -> list[str]:
    folded = _ascii(str(text or "")).lower()
    seen: dict[str, None] = {}
    for raw in re.findall(r"[a-z0-9]+", folded):
        if raw in _STOPWORDS:
            continue
        stem = _stem(raw)
        if stem not in _STOPWORDS:
            seen.setdefault(stem, None)
    return list(seen)


def _server_fields(server: dict) -> dict[str, set[str]]:
    tool_text = " ".join(f"{t.get('name', '').replace('_', ' ')} {t.get('description', '')}"
                         for t in server.get("tools") or [] if isinstance(t, dict))
    fields = {name: set(tokens(server.get(name))) for name, _ in _WEIGHTS if name not in ("tags", "tools")}
    fields["tags"] = set(tokens(" ".join(server.get("tags") or [])))
    fields["tools"] = set(tokens(tool_text))
    return fields


def score_server(query: list[str], server: dict) -> tuple[float, list[str]]:
    """Mean over query tokens of the best field weight containing the token (a synonym counts
    70 %). 1.0 = every word of the capability is in the server's name."""
    if not query:
        return 0.0, []
    fields = _server_fields(server)

    def best(token: str) -> float:
        return max((w for f, w in _WEIGHTS if token in fields[f]), default=0.0)

    total, matched = 0.0, []
    for token in query:
        weight = best(token) or _SYNONYM_FACTOR * max((best(s) for s in _SYNONYMS.get(token, ())), default=0.0)
        if weight:
            matched.append(token)
        total += weight
    return round(total / len(query), 2), matched


# ---------------------------------------------------------------------------
# Server and tools
# ---------------------------------------------------------------------------

server = McpServer(
    "doing-ai", VERSION, "DOINg.AI",
    instructions="The DOINg.AI portfolio of AI use cases (projects), the people behind them, the catalog of "
                 "MCP servers and the wish list. New use cases are projects in status 'Planning'. Use "
                 "search_mcp_servers to check whether a capability already exists in the catalog. "
                 "update_project_status and register_mcp_server write to the live DOINg.AI.",
)

_STRING = {"type": "string"}


@server.tool("list_projects", """
    List DOINg.AI projects (AI use cases), newest first. New use cases waiting to start are in
    status 'Planning'. Each project carries its sponsor and manager ({id, name, email}) and its
    business unit name. Tasks and audit log are summarised; call get_project for the full record.
    """, {"type": "object", "properties": {
        "status": {"type": "string", "description": "Planning | Active | Paused | Done ('' = all)"},
        "updated_since": {"type": "string", "description": "ISO date/time: only projects updated at or after it"},
        "include_archived": {"type": "boolean", "description": "Include archived projects (default false)"}}},
    read_only=True)
def list_projects(status: str = "", updated_since: str = "", include_archived: bool = False) -> dict:
    data = _doing_ai().snapshot()
    wanted = _pick(status, PROJECT_STATUSES, "status") if status.strip() else ""
    since = _parse_since(updated_since) if updated_since.strip() else None
    rows = []
    for p in data["projects"]:
        if wanted and p.get("status") != wanted:
            continue
        if p.get("isArchived") and not include_archived:
            continue
        if since is not None:
            stamp = p.get("updatedAt") or p.get("createdAt") or ""
            try:
                if _parse_since(stamp) < since:
                    continue
            except ToolError:
                continue
        rows.append(p)
    rows.sort(key=lambda p: p.get("createdAt") or "", reverse=True)
    return {"projects": [_project_view(p, data) for p in rows], "count": len(rows)}


@server.tool("get_project", """
    One DOINg.AI project in full: description, context, notes, tasks, milestones, members, and
    the MCP servers it relies on (resolved to name and deploy status). Accepts the project id
    (or its exact name).
    """, {"type": "object", "properties": {"project_id": {"type": "string"}}, "required": ["project_id"]},
    read_only=True)
def get_project(project_id: str) -> dict:
    data = _doing_ai().snapshot()
    return _project_view(_find_project(data, project_id), data, full=True)


@server.tool("list_users", "People in DOINg.AI (sponsors, project managers, contributors) — never any credential.",
             {"type": "object", "properties": {}}, read_only=True)
def list_users() -> dict:
    users = [_public_user(u) for u in _doing_ai().snapshot()["users"]]
    return {"users": users, "count": len(users)}


@server.tool("list_wishes", """
    The DOINg.AI wish list: requests for new projects, MCP servers, agents or data feeds, with
    requester and sponsor resolved.
    """, {"type": "object", "properties": {
        "category": {"type": "string", "description": "project | mcp | agent | datafeed | feature | integration | other ('' = all)"},
        "status": {"type": "string", "description": "submitted | under_review | accepted | in_progress | done | rejected | on_hold ('' = all)"}}},
    read_only=True)
def list_wishes(category: str = "", status: str = "") -> dict:
    data = _doing_ai().snapshot()
    cat = _pick(category, WISH_CATEGORIES, "category") if category.strip() else ""
    st = _pick(status, WISH_STATUSES, "wish_status") if status.strip() else ""
    rows = [w for w in data["wishes"] if (not cat or w.get("category") == cat) and (not st or w.get("status") == st)]
    return {"wishes": [_wish_view(w, data) for w in rows], "count": len(rows)}


@server.tool("list_mcp_servers", """
    The DOINg.AI catalog of MCP servers with their tools, owning IT team, data source and deploy
    status (dev | uat | production). `query` keeps the servers sharing words with it, best first.
    """, {"type": "object", "properties": {
        "query": {"type": "string", "description": "Words to look for ('' = all servers)"},
        "deploy_status": {"type": "string", "description": "dev | uat | production ('' = all)"}}},
    read_only=True)
def list_mcp_servers(query: str = "", deploy_status: str = "") -> dict:
    data = _doing_ai().snapshot()
    deploy = _pick(deploy_status, DEPLOY_STATUSES, "deploy_status") if deploy_status.strip() else ""
    rows = [s for s in data["mcpServers"] if not deploy or s.get("deployStatus") == deploy]
    if query.strip():
        q = tokens(query)
        scored = [(score_server(q, s)[0], s) for s in rows]
        rows = [s for score, s in sorted(scored, key=lambda x: -x[0]) if score > 0]
    else:
        rows.sort(key=lambda s: (s.get("name") or "").lower())
    return {"mcp_servers": [_server_view(s) for s in rows], "count": len(rows)}


@server.tool("search_mcp_servers", """
    Check whether the catalog already has an MCP server for a capability. Give a short phrase
    naming the data or action (e.g. "FX spot rates", "nostro account balances"). Returns the best
    matches with a score from 0 to 1 and the words that matched. The score is word overlap, not
    understanding: read the server's tools before treating a match as covering the capability.
    """, {"type": "object", "properties": {
        "capability": {"type": "string", "description": "Short phrase naming the data or action needed"},
        "limit": {"type": "integer", "description": "Maximum matches (default 5, max 20)"}},
        "required": ["capability"]},
    read_only=True)
def search_mcp_servers(capability: str, limit: int = 5) -> dict:
    query = tokens(capability)
    if not query:
        raise ToolError(f"'{capability}' has no distinctive word to search for. Name the data or system, "
                        "e.g. 'intraday payment flows' or 'loan covenant definitions'.")
    data = _doing_ai().snapshot()
    scored = []
    for s in data["mcpServers"]:
        score, matched = score_server(query, s)
        if score > 0:
            scored.append({"score": score, "matched_terms": matched, "server": _server_view(s)})
    scored.sort(key=lambda m: (-m["score"], m["server"].get("deployStatus") != "production"))
    matches = scored[:max(1, min(int(limit or 5), 20))]
    return {"capability": capability, "matches": matches, "count": len(matches),
            "note": "score ≥ 0.6: most words match; < 0.4: only incidental words match — likely not this capability."}


@server.tool("update_project_status", """
    Move a DOINg.AI project forward: status Planning | Active | Paused | Done and/or dev status
    to_start | dev | uat | prod. `note` is appended to the project notes. Every call adds an
    entry to the project's audit log. Writes to the live DOINg.AI.
    """, {"type": "object", "properties": {
        "project_id": _STRING,
        "status": {"type": "string", "description": "Planning | Active | Paused | Done ('' = unchanged)"},
        "dev_status": {"type": "string", "description": "to_start | dev | uat | prod ('' = unchanged)"},
        "note": _STRING},
        "required": ["project_id"]})
def update_project_status(project_id: str, status: str = "", dev_status: str = "", note: str = "") -> dict:
    new_status = _pick(status, PROJECT_STATUSES, "status") if status.strip() else ""
    new_dev = _pick(dev_status, DEV_STATUSES, "dev_status") if dev_status.strip() else ""
    if not (new_status or new_dev or note.strip()):
        raise ToolError("Nothing to update: give status, dev_status or note.")

    def change(doc: dict) -> dict:
        project = _find_project(_lists(doc), project_id)
        changes = []
        if new_status and new_status != project.get("status"):
            changes.append(f"status {project.get('status')} → {new_status}")
            project["status"] = new_status
        if new_dev and new_dev != project.get("devStatus"):
            changes.append(f"dev status {project.get('devStatus') or '—'} → {new_dev}")
            project["devStatus"] = new_dev
        now = _now()
        if note.strip():
            project["notes"] = (f"{project.get('notes', '').rstrip()}\n\n" if project.get("notes") else "") + f"[{now[:10]}] {note.strip()}"
        details = "; ".join(changes)
        if note.strip():
            details = f"{details} — {note.strip()}" if details else note.strip()
        if not isinstance(project.get("auditLog"), list):
            project["auditLog"] = []
        project["auditLog"].append(_audit("Status updated" if changes else "Note added", details))
        project["updatedAt"] = now
        return {"project": _project_view(strip_secrets(project), strip_secrets(_lists(doc)), full=True),
                "changes": changes}

    answer, merged = _doing_ai().write("update_project_status", change)
    return {"ok": True, **answer, "merged": merged}


@server.tool("register_mcp_server", """
    Register an MCP server in the DOINg.AI catalog, e.g. once the Factory delivered it.
    Registering a name that already exists updates that entry (created=false) — safe to retry.
    `tools` items are {name, description} objects or "name — description" strings. Writes to
    the live DOINg.AI.
    """, {"type": "object", "properties": {
        "name": _STRING, "description": _STRING,
        "tools": {"type": "array", "items": {}},
        "category": _STRING, "tags": {"type": "array", "items": _STRING},
        "team_it": {"type": "string", "description": "IT team that owns and runs it"},
        "deploy_status": {"type": "string", "description": "dev | uat | production (default dev)"},
        "use_case": _STRING,
        "data_source": {"type": "string", "description": "Source system the server wraps"}},
        "required": ["name", "description"]})
def register_mcp_server(name: str, description: str, tools: list | None = None, category: str = "",
                        tags: list[str] | None = None, team_it: str = "", deploy_status: str = "dev",
                        use_case: str = "", data_source: str = "") -> dict:
    name = (name or "").strip()
    if not name or not (description or "").strip():
        raise ToolError("name and description are required and cannot be empty.")
    deploy = _pick(deploy_status or "dev", DEPLOY_STATUSES, "deploy_status")
    tool_list = [_tool_entry(t) for t in tools or []]
    tool_list = [t for t in tool_list if t["name"]]

    def change(doc: dict) -> dict:
        servers = _lists(doc)["mcpServers"]
        now = _now()
        entry = next((s for s in servers if (s.get("name") or "").strip().lower() == name.lower()), None)
        created = entry is None
        if created:
            entry = {"id": str(uuid4()), "name": name, "source": "declarative", "isActive": True,
                     "scope": "Internal", "createdAt": now}
            if not isinstance(doc.get("mcpServers"), list):
                doc["mcpServers"] = []
            doc["mcpServers"].append(entry)
        entry.update({"description": description.strip(), "deployStatus": deploy, "updatedAt": now})
        for key, value in (("tools", tool_list), ("category", category.strip()), ("teamIT", team_it.strip()),
                           ("useCase", use_case.strip()), ("dataSourceUsed", data_source.strip()),
                           ("tags", [str(t).strip() for t in tags or [] if str(t).strip()])):
            if value or created:
                entry[key] = value
        return {"created": created, "server": _server_view(strip_secrets(entry))}

    answer, merged = _doing_ai().write("register_mcp_server", change)
    return {"ok": True, **answer, "merged": merged}


def _tool_entry(item: Any) -> dict:
    if isinstance(item, dict):
        return {"name": str(item.get("name") or "").strip(), "description": str(item.get("description") or "").strip()}
    parts = re.split(r"\s+[—–-]\s+|:\s+", str(item).strip(), maxsplit=1)
    name, desc = parts[0], parts[1] if len(parts) > 1 else ""
    return {"name": name.strip().strip("`"), "description": desc.strip()}


def _audit(action: str, details: str) -> dict:
    return {"id": str(uuid4()), "date": _now(), "userId": "", "userName": ACTOR, "action": action, "details": details}


def main() -> None:
    """Refuse to start without a DOINg.AI to talk to — before the client's initialize, so a
    connector test says why instead of listing tools that cannot work."""
    try:
        client = _doing_ai()
        version = client._call("GET", "/api/version")
        if not isinstance(version, dict) or "lastUpdated" not in version:
            raise ToolError(f"{client.url}/api/version did not answer like DOINg.AI ({str(version)[:120]}). "
                            "Is DOING_AI_URL the DOINg.AI backend (port 3001 by default)?")
    except SystemExit as exc:
        print(f"DOINg.AI MCP server not started: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(2) from None
    except ToolError as exc:
        print(f"DOINg.AI MCP server not started: {exc.payload['error']}", file=sys.stderr, flush=True)
        raise SystemExit(2) from None
    server.run()


if __name__ == "__main__":
    main()
