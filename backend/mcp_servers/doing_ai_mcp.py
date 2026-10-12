"""DOINg.AI Portfolio — an MCP server over the DOINg.AI project portfolio (docs/SPEC.md §13).

    DOING_AI_MODE=sandbox|bridge  python doing_ai_mcp.py

- `sandbox` (default): a local JSON world (env DOING_AI_STATE, default
  backend/data/sandbox/doing_ai.json), seeded on first run with a coherent corporate &
  investment bank portfolio: 8 people, 6 projects (2 new use cases in status Planning whose
  context implies MCP servers that do not exist yet), a catalog of 10 MCP servers, 3 wishes.
  Every tool works, writes included.
- `bridge`: reads the real DOINg.AI (env DOING_AI_URL, e.g. http://localhost:3001) through its
  `GET /api/data`, read-only. That endpoint returns the whole application state, password
  hashes and MCP tokens included, so secret fields are stripped before anything leaves this
  process; write tools refuse with a clear message.

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
from typing import Any
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _mcp_stdio import JsonState, McpServer, ToolError  # noqa: E402

VERSION = "1.0.0"
DEFAULT_STATE = Path(__file__).resolve().parents[1] / "data" / "sandbox" / "doing_ai.json"

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


# ---------------------------------------------------------------------------
# Data access: sandbox file or read-only bridge
# ---------------------------------------------------------------------------

class Portfolio:
    def __init__(self) -> None:
        self.mode = (os.environ.get("DOING_AI_MODE") or "sandbox").strip().lower()
        if self.mode not in ("sandbox", "bridge"):
            raise SystemExit(f"DOING_AI_MODE must be 'sandbox' or 'bridge', got {self.mode!r}")
        self.state = JsonState(os.environ.get("DOING_AI_STATE") or DEFAULT_STATE, seed_state)
        self.url = (os.environ.get("DOING_AI_URL") or "").strip().rstrip("/")
        self.token = (os.environ.get("DOING_AI_TOKEN") or "").strip()
        self.timeout = float(os.environ.get("DOING_AI_TIMEOUT") or 15)

    def snapshot(self) -> dict[str, list[dict]]:
        raw = self.state.read() if self.mode == "sandbox" else self._fetch()
        return {name: [r for r in (raw.get(name) or []) if isinstance(r, dict)] for name in COLLECTIONS}

    def writable(self, tool: str):
        if self.mode != "sandbox":
            raise ToolError(f"read-only bridge: {tool} is not available while this server reads the live "
                            "DOINg.AI. Make the change in DOINg.AI itself, or run the connector in sandbox "
                            "mode (DOING_AI_MODE=sandbox).")
        return self.state.write()

    def _fetch(self) -> dict:
        if not self.url:
            raise ToolError("Bridge mode needs DOING_AI_URL (e.g. http://localhost:3001) in the connector's environment.")
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(f"{self.url}/api/data", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise ToolError(f"DOINg.AI answered HTTP {exc.code} on GET {self.url}/api/data. "
                            "Check DOING_AI_URL and, if the instance is protected, DOING_AI_TOKEN.") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise ToolError(f"Cannot reach DOINg.AI at {self.url} ({reason}). Is it running? Check DOING_AI_URL.") from None
        except ValueError:
            raise ToolError(f"{self.url}/api/data did not return JSON — is DOING_AI_URL the DOINg.AI backend "
                            "(port 3001 by default), not its web UI?") from None
        if not isinstance(body, dict):
            raise ToolError(f"{self.url}/api/data returned {type(body).__name__}, expected the DOINg.AI state object.")
        state = body.get("state") if isinstance(body.get("state"), dict) else body
        return strip_secrets({name: state.get(name) or [] for name in COLLECTIONS})


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


PORTFOLIO: Portfolio | None = None


def _portfolio() -> Portfolio:
    global PORTFOLIO
    if PORTFOLIO is None:
        PORTFOLIO = Portfolio()
    return PORTFOLIO


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    "doing-ai-portfolio", VERSION, "DOINg.AI Portfolio",
    instructions="The DOINg.AI portfolio of AI use cases (projects), the people behind them, the catalog of "
                 "MCP servers and the wish list. New use cases are projects in status 'Planning'. Use "
                 "search_mcp_servers to check whether a capability already exists in the catalog.",
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
    data = _portfolio().snapshot()
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
    data = _portfolio().snapshot()
    return _project_view(_find_project(data, project_id), data, full=True)


@server.tool("list_users", "People in DOINg.AI (sponsors, project managers, contributors) — never any credential.",
             {"type": "object", "properties": {}}, read_only=True)
def list_users() -> dict:
    users = [_public_user(u) for u in _portfolio().snapshot()["users"]]
    return {"users": users, "count": len(users)}


@server.tool("list_wishes", """
    The DOINg.AI wish list: requests for new projects, MCP servers, agents or data feeds, with
    requester and sponsor resolved.
    """, {"type": "object", "properties": {
        "category": {"type": "string", "description": "project | mcp | agent | datafeed | feature | integration | other ('' = all)"},
        "status": {"type": "string", "description": "submitted | under_review | accepted | in_progress | done | rejected | on_hold ('' = all)"}}},
    read_only=True)
def list_wishes(category: str = "", status: str = "") -> dict:
    data = _portfolio().snapshot()
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
    data = _portfolio().snapshot()
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
    data = _portfolio().snapshot()
    scored = []
    for s in data["mcpServers"]:
        score, matched = score_server(query, s)
        if score > 0:
            scored.append({"score": score, "matched_terms": matched, "server": _server_view(s)})
    scored.sort(key=lambda m: (-m["score"], m["server"].get("deployStatus") != "production"))
    matches = scored[:max(1, min(int(limit or 5), 20))]
    return {"capability": capability, "matches": matches, "count": len(matches),
            "note": "score ≥ 0.6: most words match; < 0.4: only incidental words match — likely not this capability."}


@server.tool("create_project", """
    Create a new use case in DOINg.AI, in status 'Planning' (sandbox only). The sponsor is found
    by e-mail and the business unit by name; unknown ones are reported in `warnings`.
    """, {"type": "object", "properties": {
        "name": _STRING, "description": _STRING,
        "context": {"type": "string", "description": "Business context, data needs, constraints"},
        "sponsor_email": _STRING,
        "business_unit": {"type": "string", "description": "Business unit name (or id)"},
        "deadline": {"type": "string", "description": "Target date, YYYY-MM-DD"},
        "tags": {"type": "array", "items": _STRING}},
        "required": ["name", "description"]})
def create_project(name: str, description: str, context: str = "", sponsor_email: str = "",
                   business_unit: str = "", deadline: str = "", tags: list[str] | None = None) -> dict:
    name, description = (name or "").strip(), (description or "").strip()
    if not name or not description:
        raise ToolError("name and description are required and cannot be empty.")
    if deadline.strip():
        try:
            deadline = datetime.fromisoformat(deadline.strip()[:10]).date().isoformat()
        except ValueError:
            raise ToolError(f"deadline '{deadline}' is not a date (YYYY-MM-DD).") from None
    with _portfolio().writable("create_project") as data:
        existing = next((p for p in data["projects"] if (p.get("name") or "").strip().lower() == name.lower()), None)
        if existing:
            raise ToolError(f"A project named '{name}' already exists.", project_id=existing.get("id"),
                            status=existing.get("status"))
        warnings = []
        sponsor = None
        if sponsor_email.strip():
            sponsor = next((u for u in data["users"] if (u.get("email") or "").lower() == sponsor_email.strip().lower()), None)
            if sponsor is None:
                warnings.append(f"No DOINg.AI user with e-mail {sponsor_email}: the project has no sponsor.")
        unit = None
        if business_unit.strip():
            wanted = business_unit.strip().lower()
            unit = next((b for b in data["businessUnits"]
                         if wanted in ((b.get("name") or "").lower(), (b.get("id") or "").lower())), None)
            if unit is None:
                warnings.append(f"Unknown business unit '{business_unit}'. Known: "
                                + ", ".join(b.get("name", "") for b in data["businessUnits"]))
        now = _now()
        project = {
            "id": f"prj-{uuid4().hex[:8]}", "name": name, "description": description, "context": context.strip(),
            "notes": "", "status": "Planning", "devStatus": "to_start",
            "managerId": "", "sponsorId": sponsor["id"] if sponsor else "",
            "businessUnitId": unit["id"] if unit else "",
            "startDate": now[:10], "deadline": deadline.strip(), "isImportant": False, "isArchived": False,
            "confidentiality": "internal", "members": [], "tasks": [], "milestones": [], "technologyIds": [],
            "repoIds": [], "mcpServerIds": [], "agentIds": [], "dataFeedIds": [],
            "tags": [t.strip() for t in tags or [] if str(t).strip()],
            "auditLog": [_audit("Created", "Use case created through the DOINg.AI MCP server", sponsor)],
            "createdAt": now, "updatedAt": now,
        }
        data["projects"].append(project)
        view = _project_view(project, data, full=True)
    return {"ok": True, "project": view, "warnings": warnings}


@server.tool("update_project_status", """
    Move a DOINg.AI project forward (sandbox only): status Planning | Active | Paused | Done and/or
    dev status to_start | dev | uat | prod. `note` is appended to the project notes and audit log.
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
    with _portfolio().writable("update_project_status") as data:
        project = _find_project(data, project_id)
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
        project.setdefault("auditLog", []).append(_audit("Status updated", "; ".join(changes) or note.strip(), None))
        project["updatedAt"] = now
        view = _project_view(project, data, full=True)
    return {"ok": True, "project": view, "changes": changes}


@server.tool("register_mcp_server", """
    Register an MCP server in the DOINg.AI catalog (sandbox only), e.g. once the Factory delivered
    it. Registering a name that already exists updates that entry (created=false) — safe to retry.
    `tools` items are {name, description} objects or "name — description" strings.
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
    with _portfolio().writable("register_mcp_server") as data:
        now = _now()
        entry = next((s for s in data["mcpServers"] if (s.get("name") or "").strip().lower() == name.lower()), None)
        created = entry is None
        if created:
            entry = {"id": f"mcp-{uuid4().hex[:8]}", "name": name, "source": "declarative", "isActive": True,
                     "scope": "Internal", "createdAt": now}
            data["mcpServers"].append(entry)
        entry.update({"description": description.strip(), "deployStatus": deploy, "updatedAt": now})
        for key, value in (("tools", tool_list), ("category", category.strip()), ("teamIT", team_it.strip()),
                           ("useCase", use_case.strip()), ("dataSourceUsed", data_source.strip()),
                           ("tags", [str(t).strip() for t in tags or [] if str(t).strip()])):
            if value or created:
                entry[key] = value
        view = _server_view(entry)
    return {"ok": True, "created": created, "server": view}


def _tool_entry(item: Any) -> dict:
    if isinstance(item, dict):
        return {"name": str(item.get("name") or "").strip(), "description": str(item.get("description") or "").strip()}
    parts = re.split(r"\s+[—–-]\s+|:\s+", str(item).strip(), maxsplit=1)
    name, desc = parts[0], parts[1] if len(parts) > 1 else ""
    return {"name": name.strip().strip("`"), "description": desc.strip()}


def _audit(action: str, details: str, user: dict | None) -> dict:
    return {"id": f"aud-{uuid4().hex[:8]}", "date": _now(), "userId": (user or {}).get("id", ""),
            "userName": _full_name(user) if user else "DOINg.AI Factory", "action": action, "details": details}


# ---------------------------------------------------------------------------
# Seed: a coherent corporate & investment bank portfolio
# ---------------------------------------------------------------------------

def _user(uid: str, first: str, last: str, team: str, title: str, role: str, color: str, created: str) -> dict:
    handle = _ascii(f"{first}.{last}".lower())   # accents folded, as in the bank's directory
    return {"id": f"u-{uid}", "uid": handle, "firstName": first, "lastName": last, "email": f"{handle}@doing.ai",
            "team": team, "functionTitle": title, "role": role, "avatarColor": color, "createdAt": created}


def _server(sid: str, name: str, description: str, tools: list[tuple[str, str]], *, category: str, tags: list[str],
            team: str, deploy: str, use_case: str, source: str, data_scope: str, user_teams: list[str],
            created: str, active: bool = True) -> dict:
    return {"id": f"mcp-{sid}", "name": name, "description": description, "source": "declarative",
            "tools": [{"name": n, "description": d} for n, d in tools], "category": category, "tags": tags,
            "isActive": active, "scope": "Internal", "originData": "Internal system", "dataScope": data_scope,
            "dataSourceUsed": source, "useCase": use_case, "teamIT": team, "userTeams": user_teams,
            "deployStatus": deploy, "createdAt": created, "updatedAt": created}


def _project(pid: str, name: str, description: str, context: str, *, status: str, dev: str, bu: str, sponsor: str,
             manager: str, servers: list[str], tags: list[str], start: str, deadline: str, created: str,
             updated: str, notes: str = "", important: bool = False, members: list[tuple[str, str]] = ()) -> dict:
    return {"id": pid, "name": name, "description": description, "context": context, "notes": notes,
            "status": status, "devStatus": dev, "managerId": manager, "sponsorId": sponsor, "businessUnitId": bu,
            "startDate": start, "deadline": deadline, "isImportant": important, "isArchived": False,
            "confidentiality": "internal", "members": [{"userId": u, "role": r} for u, r in members],
            "tasks": [], "milestones": [], "technologyIds": [], "repoIds": [], "mcpServerIds": servers,
            "agentIds": [], "dataFeedIds": [], "tags": tags, "auditLog": [], "dependsOnProjectIds": [],
            "createdAt": created, "updatedAt": updated}


def seed_state() -> dict:
    """The sandbox world on first run.

    Built so the Factory's reference flow has something real to find: the two 'Planning' use
    cases describe 6 and 5 data capabilities; the catalog covers some (Payments Hub, Market
    Data, Client 360, Teams Notifier, Credit Risk Limits, Document Vault) and lacks others
    (nostro balances, treasury liquidity history, Loan IQ covenants, financial spreading).
    """
    units = [
        {"id": "bu-gm", "name": "Global Markets", "description": "Sales, trading and research across FX, rates, credit and equities.", "color": "#FF3E00", "createdAt": "2025-01-06T09:00:00Z"},
        {"id": "bu-gb", "name": "Global Banking", "description": "Corporate lending, coverage and advisory.", "color": "#0EA5E9", "createdAt": "2025-01-06T09:00:00Z"},
        {"id": "bu-tb", "name": "Transaction Banking", "description": "Payments, cash management, treasury services and trade finance.", "color": "#10B981", "createdAt": "2025-01-06T09:00:00Z"},
        {"id": "bu-rc", "name": "Risk & Compliance", "description": "Market, credit and liquidity risk; KYC, AML and surveillance.", "color": "#8B5CF6", "createdAt": "2025-01-06T09:00:00Z"},
        {"id": "bu-ot", "name": "Operations & Technology", "description": "Middle and back office, IT and data platforms.", "color": "#F59E0B", "createdAt": "2025-01-06T09:00:00Z"},
    ]
    users = [
        _user("alice", "Alice", "Martin", "Global Banking — Corporate Lending", "Managing Director, Corporate Lending", "manager", "#FF3E00", "2025-02-03T09:00:00Z"),
        _user("paul", "Paul", "Durand", "AI Delivery Office", "AI Product Manager", "manager", "#0EA5E9", "2025-02-03T09:00:00Z"),
        _user("henri", "Henri", "Dubois", "Transaction Banking — Treasury Services", "Head of Liquidity Management", "manager", "#10B981", "2025-03-10T09:00:00Z"),
        _user("julia", "Julia", "Weber", "Risk — Market Risk", "Head of Market Risk Analytics", "manager", "#8B5CF6", "2025-03-10T09:00:00Z"),
        _user("marc", "Marc", "Lefèvre", "Global Markets — Equity Derivatives", "Head of Equity Derivatives Trading", "contributor", "#F43F5E", "2025-04-14T09:00:00Z"),
        _user("nadia", "Nadia", "Haddad", "Operations — Markets Middle Office", "COO, Global Markets Operations", "manager", "#F59E0B", "2025-04-14T09:00:00Z"),
        _user("thomas", "Thomas", "Klein", "AI Delivery Office", "Product Manager, Data & AI", "contributor", "#14B8A6", "2025-05-05T09:00:00Z"),
        _user("ines", "Inès", "Garcia", "Compliance — KYC", "KYC Transformation Lead", "contributor", "#EC4899", "2025-05-05T09:00:00Z"),
    ]
    servers = [
        _server("market-data", "Market Data MCP",
                "Market data for pricing and risk: FX spot and forward rates, interest-rate curves, equity and bond prices, with historical fixings.",
                [("get_fx_rate", "Latest FX spot rate for a currency pair (e.g. EURUSD) with timestamp and source."),
                 ("get_fx_history", "Daily FX fixings for a currency pair over a date range."),
                 ("get_yield_curve", "Interest-rate curve (OIS, government) for a currency and date."),
                 ("get_price", "Latest price of an equity, bond or index by ISIN or ticker.")],
                category="Market Data", tags=["fx", "rates", "prices", "market data", "bloomberg"],
                team="Market Data Engineering", deploy="production",
                use_case="Pricing, risk and treasury agents that need reference market prices.",
                source="Bloomberg B-PIPE, Refinitiv RDP", data_scope="Global",
                user_teams=["Global Markets", "Market Risk", "Treasury"], created="2025-06-02T08:00:00Z"),
        _server("client-360", "Client 360 MCP",
                "Golden record of corporate and institutional clients: legal entity data (LEI), group hierarchy, segment, coverage team and KYC status summary.",
                [("search_clients", "Find clients by name, LEI or internal id."),
                 ("get_client_profile", "Legal entity profile: LEI, country, segment, rating summary, KYC status."),
                 ("get_group_hierarchy", "Parent and subsidiaries of a client group."),
                 ("get_coverage_team", "Relationship manager and coverage bankers of a client.")],
                category="Client Data", tags=["client", "counterparty", "static data", "lei", "golden record", "crm"],
                team="Client Data Platform", deploy="production",
                use_case="Any agent that needs to identify a client and its group.",
                source="Salesforce Financial Services Cloud, MDM golden record", data_scope="Global",
                user_teams=["Global Banking", "Compliance", "Operations"], created="2025-05-12T08:00:00Z"),
        _server("payments-hub", "Payments Hub MCP",
                "Payments processed by the payments hub: individual payment search, status tracking and aggregated intraday flows per currency, account and settlement system (TARGET2, CHAPS, Fedwire).",
                [("search_payments", "Search payments by reference, amount, counterparty or date."),
                 ("get_payment_status", "Status and processing history of one payment (pacs.002)."),
                 ("get_intraday_flows", "Incoming and outgoing payment flows aggregated per currency and settlement system over a time window.")],
                category="Payments", tags=["payments", "swift", "iso 20022", "cash", "settlement"],
                team="Payments IT", deploy="production",
                use_case="Payment investigations and cash-flow monitoring.",
                source="Payments Hub (ISO 20022), SWIFT Alliance Access", data_scope="EMEA, Americas",
                user_teams=["Transaction Banking", "Operations"], created="2025-07-21T08:00:00Z"),
        _server("credit-risk", "Credit Risk Limits MCP",
                "Counterparty credit risk: internal ratings, approved limits, current exposure and limit utilisation per client.",
                [("get_internal_rating", "Internal rating and probability of default of a client, with rating date."),
                 ("get_limits", "Approved credit limits of a client by product and tenor."),
                 ("get_exposure", "Current exposure and limit utilisation of a client."),
                 ("list_limit_breaches", "Open limit breaches, optionally for one client.")],
                category="Risk", tags=["credit", "risk", "limits", "rating", "exposure"],
                team="Risk IT", deploy="production",
                use_case="Credit analysts and lending agents checking headroom before a deal.",
                source="Credit risk engine, internal rating system", data_scope="Global",
                user_teams=["Global Banking", "Credit Risk"], created="2025-08-04T08:00:00Z"),
        _server("doc-vault", "Document Vault MCP",
                "Search and read documents stored in the enterprise content management system: facility agreements, ISDA/CSA, KYC documents and policies, with clause extraction.",
                [("search_documents", "Full-text and metadata search across stored documents."),
                 ("get_document", "Text and metadata of one document."),
                 ("extract_clauses", "Extract named clauses (e.g. governing law, termination events, guarantees) from a document as text.")],
                category="Documents", tags=["documents", "contracts", "ecm", "clauses", "ocr"],
                team="Enterprise Content IT", deploy="production",
                use_case="Agents that need to quote contractual documents.",
                source="OpenText Documentum", data_scope="Global",
                user_teams=["Global Banking", "Legal", "Compliance"], created="2025-06-16T08:00:00Z"),
        _server("kyc-registry", "KYC Registry MCP",
                "Client due-diligence files from the client lifecycle management platform: KYC status, risk rating, ultimate beneficial owners and periodic review due dates.",
                [("get_kyc_file", "KYC file of a client: status, risk rating, documents on file."),
                 ("list_reviews_due", "Clients whose periodic KYC review is due in a period."),
                 ("get_ubo_structure", "Ultimate beneficial owners and ownership chain of a client.")],
                category="Compliance", tags=["kyc", "aml", "ubo", "due diligence", "compliance"],
                team="Compliance IT", deploy="uat",
                use_case="KYC periodic review and onboarding agents.",
                source="Fenergo CLM", data_scope="EMEA", user_teams=["Compliance"], created="2026-02-09T08:00:00Z"),
        _server("sanctions", "Sanctions Screening MCP",
                "Screen names and entities against sanctions and PEP lists (OFAC, EU, UN, HMT) and retrieve screening alerts.",
                [("screen_entity", "Screen a person or company name against sanctions and PEP lists."),
                 ("get_alert", "Details and disposition of one screening alert."),
                 ("list_open_alerts", "Open screening alerts, optionally for one client.")],
                category="Compliance", tags=["sanctions", "pep", "aml", "screening", "compliance"],
                team="Compliance IT", deploy="production",
                use_case="Onboarding, payments and KYC agents.",
                source="Dow Jones Risk & Compliance lists, internal screening engine", data_scope="Global",
                user_teams=["Compliance", "Transaction Banking"], created="2025-09-15T08:00:00Z"),
        _server("trade-repository", "Trade Repository MCP",
                "Booked trades of Global Markets (FX, rates, credit, equity derivatives): trade details, lifecycle events and confirmation status.",
                [("search_trades", "Search trades by counterparty, product, trade date or book."),
                 ("get_trade", "Economic details and lifecycle events of one trade."),
                 ("get_confirmation_status", "Confirmation matching status of a trade.")],
                category="Trading", tags=["trades", "post-trade", "confirmations", "murex"],
                team="Markets IT", deploy="production",
                use_case="Post-trade, risk and client-service agents.",
                source="Murex MX.3 trade store", data_scope="Global",
                user_teams=["Global Markets", "Operations"], created="2025-04-28T08:00:00Z"),
        _server("teams-notifier", "Teams Notifier MCP",
                "Post messages and alerts to Microsoft Teams channels and chats, with adaptive cards and mentions.",
                [("post_channel_message", "Post a message or adaptive card to a Teams channel."),
                 ("send_chat_message", "Send a direct message to a user."),
                 ("list_channels", "Channels of a team the server may post to.")],
                category="Productivity", tags=["teams", "notification", "alerts", "collaboration"],
                team="Workplace IT", deploy="production",
                use_case="Any agent that must alert a desk or a person.",
                source="Microsoft Graph API", data_scope="Global",
                user_teams=["All"], created="2025-03-31T08:00:00Z"),
        _server("research-library", "Research Library MCP",
                "Search the published equity and credit research: reports, analyst recommendations and target prices.",
                [("search_research", "Search published research by issuer, sector or keyword."),
                 ("get_report", "Summary and full text of a research report.")],
                category="Knowledge", tags=["research", "equity", "credit research", "reports"],
                team="Markets IT", deploy="dev",
                use_case="Sales assistants answering client questions on published research.",
                source="Research portal (BlueMatrix)", data_scope="Global",
                user_teams=["Global Markets"], created="2026-08-24T08:00:00Z"),
    ]
    projects = [
        _project("prj-1001", "Trade Confirmation Matching Assistant",
                 "Reads incoming FX and money-market confirmations (SWIFT MT300/MT320 and broker PDFs), matches them against booked trades and drafts the exception e-mail for unmatched fields.",
                 "Middle office matched ~4,000 confirmations a day by hand. The assistant reads confirmations from the document vault, compares economics with the trade repository and posts exceptions to the operations Teams channel.",
                 status="Done", dev="prod", bu="bu-ot", sponsor="u-nadia", manager="u-thomas",
                 servers=["mcp-trade-repository", "mcp-doc-vault", "mcp-teams-notifier"],
                 tags=["operations", "post-trade", "genai"], start="2025-10-06", deadline="2026-03-31",
                 created="2025-10-02T10:12:00Z", updated="2026-04-02T16:40:00Z",
                 notes="Live since March 2026: 72% of confirmations auto-matched, 3 FTE redeployed to exception handling.",
                 members=[("u-thomas", "Owner"), ("u-nadia", "Contributor")]),
        _project("prj-1002", "KYC Periodic Review Copilot",
                 "Prepares the periodic KYC review file of a corporate client: refreshes ownership, screens the group again and drafts the analyst's review note.",
                 "1,200 periodic reviews are overdue in EMEA. The copilot gathers the KYC file, UBO chain, screening alerts and stored documents, then drafts the review for the analyst to validate.",
                 status="Active", dev="uat", bu="bu-rc", sponsor="u-ines", manager="u-thomas",
                 servers=["mcp-kyc-registry", "mcp-sanctions", "mcp-doc-vault", "mcp-client-360"],
                 tags=["kyc", "aml", "compliance", "copilot"], start="2026-02-02", deadline="2026-12-15",
                 created="2026-01-19T09:30:00Z", updated="2026-09-29T14:05:00Z", important=True,
                 notes="UAT with 6 analysts since September; target 40% shorter review time.",
                 members=[("u-thomas", "Owner"), ("u-ines", "Lead")]),
        _project("prj-1003", "Credit Memo Drafting Assistant",
                 "Drafts the first version of the credit memo for a new facility: client profile, group structure, rating and limits, market context.",
                 "Bankers spend two days per memo collecting data from five systems. The assistant assembles client data, internal rating, limits and exposure and recent market data, then drafts the memo sections.",
                 status="Active", dev="dev", bu="bu-gb", sponsor="u-alice", manager="u-paul",
                 servers=["mcp-credit-risk", "mcp-client-360", "mcp-doc-vault", "mcp-market-data"],
                 tags=["lending", "credit", "genai"], start="2026-05-04", deadline="2027-01-29",
                 created="2026-04-21T11:00:00Z", updated="2026-10-02T09:15:00Z",
                 members=[("u-paul", "Owner"), ("u-alice", "Contributor")]),
        _project("prj-1004", "Market Risk Limit Breach Explainer",
                 "Explains overnight market-risk limit breaches in plain English for the desk heads: positions driving the breach, market moves, suggested hedges.",
                 "Each morning risk managers write 10-20 breach explanations. The explainer reads trades and market moves and posts a draft to the risk Teams channel.",
                 status="Done", dev="prod", bu="bu-rc", sponsor="u-julia", manager="u-paul",
                 servers=["mcp-market-data", "mcp-trade-repository", "mcp-teams-notifier"],
                 tags=["market risk", "limits", "genai"], start="2025-09-01", deadline="2026-02-27",
                 created="2025-08-25T08:45:00Z", updated="2026-03-06T17:20:00Z",
                 notes="In production since February 2026; explanations reviewed in 5 minutes instead of 40.",
                 members=[("u-paul", "Owner"), ("u-julia", "Contributor")]),
        _project("prj-1005", "Intraday Liquidity Forecasting Agent",
                 "An agent that forecasts the bank's intraday liquidity position per currency every 15 minutes and alerts the Treasury desk before the liquidity buffer is breached.",
                 "Treasury Services monitors EUR, USD and GBP intraday liquidity by hand today, from four screens and a spreadsheet. The agent must:\n"
                 "- read real-time incoming and outgoing payment flows per currency and settlement system (TARGET2, CHAPS, Fedwire) from the Payments Hub;\n"
                 "- read the current balances of our nostro accounts at correspondent banks — today only available as end-of-day MT940/MT950 statements and a Treasury spreadsheet, with no API;\n"
                 "- convert positions to EUR with live FX spot rates;\n"
                 "- learn intraday patterns from 24 months of historical liquidity positions kept in the Treasury data warehouse (Oracle) — no service exposes them yet;\n"
                 "- identify the counterparties driving the largest outflows from client static data;\n"
                 "- alert the Treasury desk channel in Microsoft Teams when the forecast buffer drops below the internal threshold.\n"
                 "Regulatory driver: BCBS 248 intraday liquidity monitoring; the supervisor expects an improvement plan by Q1 2027.",
                 status="Planning", dev="to_start", bu="bu-tb", sponsor="u-henri", manager="u-paul",
                 servers=[], tags=["treasury", "liquidity", "agent", "regulatory"], start="2026-11-02",
                 deadline="2027-03-31", created="2026-10-08T07:55:00Z", updated="2026-10-08T07:55:00Z",
                 important=True,
                 notes="Expected benefits: 2 FTE of manual monitoring saved; buffer breaches anticipated 60 minutes ahead; evidence for the BCBS 248 remediation plan.",
                 members=[("u-paul", "Owner"), ("u-henri", "Contributor")]),
        _project("prj-1006", "Corporate Loan Covenant Monitoring",
                 "Monitors the financial covenants of the corporate loan book every quarter and drafts a waiver or early-warning memo for the relationship manager when a covenant is at risk.",
                 "About 1,800 bilateral and syndicated facilities carry financial covenants (leverage, interest cover, minimum liquidity). Credit officers check them by hand when borrowers send their quarterly accounts, often weeks late. The agent must:\n"
                 "- retrieve the facility agreements and covenant clauses from the Document Vault (Documentum);\n"
                 "- read the covenant definitions, thresholds and test dates of each facility from Loan IQ, our loan servicing system — no API is exposed to agents yet;\n"
                 "- get the borrower's spread financial statements (EBITDA, net debt, interest expense) from the credit spreading tool, Moody's CreditLens — no MCP server or service is available today;\n"
                 "- check the internal rating, limits and current exposure from the credit risk engine;\n"
                 "- use the client golden record (group structure, relationship manager) from Client 360.\n"
                 "It then computes covenant headroom and drafts the memo. Pilot on the EMEA mid-cap portfolio.",
                 status="Planning", dev="to_start", bu="bu-gb", sponsor="u-alice", manager="u-thomas",
                 servers=[], tags=["lending", "covenants", "agent", "credit"], start="2026-11-16",
                 deadline="2027-04-30", created="2026-10-09T14:20:00Z", updated="2026-10-09T14:20:00Z",
                 notes="Expected benefits: breaches detected at the reporting date instead of 6-8 weeks later; about 1,500 analyst hours saved per year.",
                 members=[("u-thomas", "Owner"), ("u-alice", "Contributor")]),
    ]
    wishes = [
        {"id": "wish-01", "title": "MCP server for Loan IQ facility and covenant data",
         "description": "Credit officers and agents need read access to facility terms, covenant definitions, thresholds and test dates held in Loan IQ.",
         "category": "mcp", "businessJustification": "Covenant data is locked in Loan IQ screens; every credit agent use case needs it.",
         "expectedImpact": "Unblocks covenant monitoring and credit memo automation.",
         "requesterId": "u-thomas", "sponsorId": "u-alice", "relatedProjectId": "prj-1006",
         "status": "under_review", "priority": "high", "wishedDate": "2027-01-31", "comments": [],
         "tags": ["lending", "loan iq", "mcp"], "createdAt": "2026-09-22T10:00:00Z", "updatedAt": "2026-10-01T08:30:00Z"},
        {"id": "wish-02", "title": "Earnings call summariser for equity sales",
         "description": "Summarise earnings calls of covered issuers within an hour of the call, with the questions analysts asked.",
         "category": "agent", "businessJustification": "Sales want faster client follow-ups after results.",
         "expectedImpact": "Same-day client notes on 300 issuers.", "requesterId": "u-marc", "sponsorName": "Equity Sales",
         "status": "submitted", "priority": "medium", "comments": [], "tags": ["equity", "research", "agent"],
         "createdAt": "2026-09-30T15:10:00Z", "updatedAt": "2026-09-30T15:10:00Z"},
        {"id": "wish-03", "title": "Intraday nostro balances feed for Treasury",
         "description": "A feed of nostro account balances at correspondent banks, refreshed during the day, for liquidity monitoring.",
         "category": "datafeed", "businessJustification": "Treasury only sees end-of-day MT950 statements today.",
         "expectedImpact": "Intraday view of cash at correspondents.", "requesterId": "u-henri", "sponsorId": "u-henri",
         "relatedProjectId": "prj-1005", "status": "accepted", "priority": "high", "comments": [],
         "tags": ["treasury", "nostro", "liquidity"], "createdAt": "2026-08-18T09:40:00Z", "updatedAt": "2026-09-12T11:00:00Z"},
    ]
    return {"businessUnits": units, "users": users, "projects": projects, "mcpServers": servers, "wishes": wishes,
            "lastUpdated": _now()}


def main() -> None:
    _portfolio()   # fail fast on a bad DOING_AI_MODE, before the client's initialize
    server.run()


if __name__ == "__main__":
    main()
