"""People & Teams: users, teams, the role catalogue, and the import of people from a DOINg.AI
connector (SPEC §3.2, §9).

Membership is stored on both sides (User.team_ids and Team.member_ids) because the engine
resolves assignees from either; every write here keeps the two in step so neither can drift.
Mutations are audited as `settings.updated` (People & Teams is a Settings tab) with the
concrete action in `data.action`.
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Body

from app.api import actor, editable, found, shape, shape_all, validate
from app.deps import container as c
from app.errors import Conflict, FactoryError, MCPError, NotConfigured
from app.models import RoleDef, Team, User
from app.util import new_id, now_iso, slugify

router = APIRouter(prefix="/api")

_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


def _audit(message: str, acting: str, **data: Any) -> None:
    c.record_event("settings.updated", message, actor=actor(acting), data={"section": "people", **data})
    # Open UIs reload their bootstrap (SPEC §8). Membership edits touch both sides; one reload covers them.
    c.bus.emit("reference.updated", collection="teams" if str(data.get("action", "")).startswith("team.") else "users")


def _dedupe(values: list[str]) -> list[str]:
    return list(dict.fromkeys(v.strip() for v in values if v and v.strip()))


# ---------------------------------------------------------------------------------- users

@router.get("/users")
async def list_users() -> list[dict[str, Any]]:
    return shape_all(User, c.users())


@router.post("/users")
async def create_user(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    user = _checked_user({"id": new_id("usr"), "created_at": now_iso(), **editable(User, body)})
    saved = c.store.put("users", user)
    _sync_user_teams(saved)
    _audit(f"User {saved['name']} added", body.get("user_id") or user_id, action="user.created", user_id=saved["id"])
    return shape(User, saved)


@router.put("/users/{id}")
async def update_user(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    current = found(c.get_user(id), "User", id)
    user = _checked_user({**current, **editable(User, body)})
    saved = c.store.put("users", user)
    _sync_user_teams(saved)
    _audit(f"User {saved['name']} updated", body.get("user_id") or user_id, action="user.updated", user_id=id)
    return shape(User, saved)


@router.delete("/users/{id}")
async def delete_user(id: str, user_id: str = "") -> dict[str, Any]:
    """Projects keep the id they reference (history stays truthful); teams drop the user."""
    user = found(c.get_user(id), "User", id)
    for team in c.teams():
        if id in team.get("member_ids", []) or team.get("lead_user_id") == id:
            team["member_ids"] = [m for m in team.get("member_ids", []) if m != id]
            if team.get("lead_user_id") == id:
                team["lead_user_id"] = ""
            c.store.put("teams", team)
    c.store.delete("users", id)
    _audit(f"User {user.get('name') or id} deleted", user_id, action="user.deleted", user_id=id)
    return {"ok": True, "id": id}


@router.post("/people/import-from-connector")
async def import_from_connector(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    """{connector_id} → {created, skipped, users}: the people of DOINg.AI (its `list_users` tool)
    become Factory users — name, email, title; the role `sponsor` for those who sponsor a
    DOINg.AI project, no other role (roles are a Factory decision). An e-mail already known
    (or missing) is skipped, so running it again only adds newcomers."""
    connector_id = str(body.get("connector_id") or "").strip()
    connector = found(c.store.get("connectors", connector_id), "Connector", connector_id)
    if connector.get("kind") != "portfolio":
        raise FactoryError(f"'{connector.get('name')}' is not a DOINg.AI connector (kind 'portfolio'): people are "
                           "imported from DOINg.AI.", 422)
    if not connector.get("enabled", True):
        raise NotConfigured(f"The connector '{connector.get('name')}' is disabled — enable it in Settings › Connectors.")
    people = await _tool_data(connector, "list_users", {})
    projects = await _tool_data(connector, "list_projects", {"include_archived": True})
    sponsor_ids = {p.get("sponsorId") for p in projects.get("projects") or [] if isinstance(p, dict) and p.get("sponsorId")}
    can_sponsor = "sponsor" in {r.get("key") for r in c.roles()}
    created: list[dict[str, Any]] = []
    skipped = 0
    seen: set[str] = set()
    for person in people.get("users") or []:
        if not isinstance(person, dict):
            skipped += 1
            continue
        email = str(person.get("email") or "").strip()
        name = str(person.get("name") or "").strip() or " ".join(
            str(person.get(k) or "").strip() for k in ("firstName", "lastName")).strip()
        if not email or not _EMAIL.fullmatch(email) or not name or email.lower() in seen or c.user_by_email(email):
            skipped += 1
            continue
        seen.add(email.lower())
        roles = ["sponsor"] if can_sponsor and person.get("id") in sponsor_ids else []
        user = validate(User, {"id": new_id("usr"), "name": name, "email": email,
                               "title": str(person.get("functionTitle") or "").strip(), "roles": roles,
                               "created_at": now_iso()}, "user").model_dump()
        created.append(c.store.put("users", user))
    if created:
        _audit(f"{len(created)} user(s) imported from '{connector.get('name')}'", body.get("user_id") or user_id,
               action="user.imported", connector_id=connector_id, count=len(created))
    return {"created": len(created), "skipped": skipped, "users": shape_all(User, created)}


async def _tool_data(connector: dict[str, Any], tool: str, args: dict[str, Any]) -> dict[str, Any]:
    result = await c.mcp.call_tool(connector["id"], tool, args)
    if not result.get("ok"):
        raise MCPError(f"'{connector.get('name')}' could not answer {tool}: {result.get('error') or 'unknown error'}")
    data = result.get("data")
    if not isinstance(data, dict):
        raise MCPError(f"'{connector.get('name')}' answered {tool} with something other than an object — is it the "
                       "DOINg.AI MCP server?")
    return data


def _checked_user(data: dict[str, Any]) -> dict[str, Any]:
    user = validate(User, data, "user").model_dump()
    user["name"] = user["name"].strip()
    user["email"] = user["email"].strip()
    if not user["name"]:
        raise FactoryError("A user needs a name.", 422)
    if user["email"]:
        if not _EMAIL.fullmatch(user["email"]):
            raise FactoryError(f"'{user['email']}' is not a valid email address.", 422)
        other = c.user_by_email(user["email"])
        if other is not None and other["id"] != user["id"]:
            raise Conflict(f"The email {user['email']} is already used by {other.get('name') or other['id']}.")
    user["roles"] = _dedupe(user["roles"])
    known_roles = {r.get("key") for r in c.roles()}
    unknown = [r for r in user["roles"] if r not in known_roles]
    if unknown:
        raise FactoryError(f"Unknown role(s): {', '.join(unknown)} — define them in Settings › People & Teams.", 422)
    user["team_ids"] = _dedupe(user["team_ids"])
    missing = [t for t in user["team_ids"] if c.get_team(t) is None]
    if missing:
        raise FactoryError(f"Unknown team(s): {', '.join(missing)}", 422)
    return user


def _sync_user_teams(user: dict[str, Any]) -> None:
    """Make every team's member_ids agree with this user's team_ids."""
    uid, wanted = user["id"], set(user.get("team_ids") or [])
    for team in c.teams():
        members = list(team.get("member_ids") or [])
        if (team["id"] in wanted) != (uid in members):
            team["member_ids"] = members + [uid] if team["id"] in wanted else [m for m in members if m != uid]
            c.store.put("teams", team)


# ---------------------------------------------------------------------------------- teams

@router.get("/teams")
async def list_teams() -> list[dict[str, Any]]:
    return shape_all(Team, c.teams())


@router.post("/teams")
async def create_team(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    team = _checked_team({"id": new_id("team"), "created_at": now_iso(), **editable(Team, body)})
    saved = c.store.put("teams", team)
    _sync_team_members(saved)
    _audit(f"Team {saved['name']} added", body.get("user_id") or user_id, action="team.created", team_id=saved["id"])
    return shape(Team, saved)


@router.put("/teams/{id}")
async def update_team(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    current = found(c.get_team(id), "Team", id)
    team = _checked_team({**current, **editable(Team, body)})
    saved = c.store.put("teams", team)
    _sync_team_members(saved)
    _audit(f"Team {saved['name']} updated", body.get("user_id") or user_id, action="team.updated", team_id=id)
    return shape(Team, saved)


@router.delete("/teams/{id}")
async def delete_team(id: str, user_id: str = "") -> dict[str, Any]:
    team = found(c.get_team(id), "Team", id)
    for user in c.users():
        if id in (user.get("team_ids") or []):
            user["team_ids"] = [t for t in user["team_ids"] if t != id]
            c.store.put("users", user)
    c.store.delete("teams", id)
    _audit(f"Team {team.get('name') or id} deleted", user_id, action="team.deleted", team_id=id)
    return {"ok": True, "id": id}


def _checked_team(data: dict[str, Any]) -> dict[str, Any]:
    team = validate(Team, data, "team").model_dump()
    team["name"] = team["name"].strip()
    if not team["name"]:
        raise FactoryError("A team needs a name.", 422)
    clash = next((t for t in c.teams() if t["id"] != team["id"]
                  and (t.get("name") or "").strip().lower() == team["name"].lower()), None)
    if clash is not None:
        raise Conflict(f"A team named {team['name']} already exists.")
    team["jira_project_key"] = team["jira_project_key"].strip().upper()
    team["skills"] = _dedupe(team["skills"])
    team["member_ids"] = _dedupe(team["member_ids"])
    if team["lead_user_id"] and team["lead_user_id"] not in team["member_ids"]:
        team["member_ids"].append(team["lead_user_id"])   # a lead is a member of their team
    missing = [u for u in team["member_ids"] if c.get_user(u) is None]
    if missing:
        raise FactoryError(f"Unknown user(s): {', '.join(missing)}", 422)
    return team


def _sync_team_members(team: dict[str, Any]) -> None:
    """Make every user's team_ids agree with this team's member_ids."""
    tid, wanted = team["id"], set(team.get("member_ids") or [])
    for user in c.users():
        team_ids = list(user.get("team_ids") or [])
        if (user["id"] in wanted) != (tid in team_ids):
            user["team_ids"] = team_ids + [tid] if user["id"] in wanted else [t for t in team_ids if t != tid]
            c.store.put("users", user)


# ---------------------------------------------------------------------------------- roles

@router.get("/roles")
async def list_roles() -> list[dict[str, Any]]:
    return shape_all(RoleDef, c.roles())


@router.put("/roles")
async def put_roles(body: Any = Body(...), user_id: str = "") -> list[dict[str, Any]]:
    """Replace the whole role catalogue (body: RoleDef[], or {"roles": [...], "user_id"}).
    Keys are slugs; a role still held by a user cannot be removed. Blueprint steps that name
    a removed role are reported by blueprint validation, not blocked here."""
    if isinstance(body, dict):
        user_id = body.get("user_id") or user_id
        body = body.get("roles")
    if not isinstance(body, list):
        raise FactoryError("Expected the full list of roles.", 422)
    roles: list[dict[str, Any]] = []
    for raw in body:
        if not isinstance(raw, dict):
            raise FactoryError("Each role must be an object with a key and a label.", 422)
        key = slugify(raw.get("key") or raw.get("label") or "")
        if not key:
            raise FactoryError("Each role needs a key or a label.", 422)
        role = validate(RoleDef, {**raw, "key": key, "label": (raw.get("label") or "").strip()
                                  or key.replace("_", " ").title()}, "role").model_dump()
        if any(r["key"] == key for r in roles):
            raise FactoryError(f"Duplicate role key '{key}'.", 422)
        roles.append(role)

    before = {r.get("key") for r in c.roles()}
    after = {r["key"] for r in roles}
    for key in sorted(before - after):
        holders = [u.get("name") or u["id"] for u in c.users() if key in (u.get("roles") or [])]
        if holders:
            raise Conflict(f"Role '{key}' is still held by {', '.join(holders[:5])}"
                           f"{' and others' if len(holders) > 5 else ''} — remove it from them first.")
    c.store.put_singleton("roles", {"roles": roles})
    c.record_event("settings.updated", "Roles updated", actor=actor(user_id),
                   data={"section": "roles", "action": "roles.updated",
                         "added": sorted(after - before), "removed": sorted(before - after)})
    c.bus.emit("reference.updated", collection="roles")
    return roles
