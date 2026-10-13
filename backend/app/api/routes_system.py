"""System endpoints: health (cheap, polled by the header) and bootstrap (everything the UI
needs to render its first screen, in one round-trip) — SPEC §9."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.api import public_settings, shape, shape_all
from app.config import VERSION
from app.deps import container as c
from app.inbox import inbox_counts
from app.models import Blueprint, Connector, Operation, RoleDef, Team, User
from app.seed.standard_ops import SUPPORTED_KINDS, operations_for
from app.util import public_connector

router = APIRouter(prefix="/api")

# Projects still in flight: everything that is neither finished nor abandoned.
IN_FLIGHT = ["active", "waiting", "blocked"]


@router.get("/health")
async def health(user_id: str = "") -> dict[str, Any]:
    """Never calls the LLM or an MCP server: it reports configuration, not reachability (a
    down model must not make every header refresh wait for a timeout). `inbox` is counted
    only when the caller says whose inbox it is."""
    llm = c.app_settings().llm
    counts: dict[str, int] = {"projects_active": c.store.count("projects", field="status", values=IN_FLIGHT)}
    if user_id:
        counts["inbox"] = int(inbox_counts(c, user_id).get("total", 0))
    return {
        "ok": True,
        "version": VERSION,
        "llm": {"configured": bool(c.llm.configured), "model": llm.model, "provider": llm.provider},
        "scheduler_running": bool(c.scheduler.running),
        "counts": counts,
    }


@router.get("/bootstrap")
async def bootstrap() -> dict[str, Any]:
    users = shape_all(User, c.users())
    connectors = [public_connector(shape(Connector, doc)) for doc in c.store.list("connectors")]
    kinds = {conn.get("kind") for conn in connectors}
    standard = sorted(kinds & set(SUPPORTED_KINDS))
    return {
        "settings": public_settings(c.app_settings()),
        "roles": shape_all(RoleDef, c.roles()),
        "users": users,
        "teams": shape_all(Team, c.teams()),
        "blueprints": shape_all(Blueprint, c.store.list("blueprints")),
        "connectors": connectors,
        "operations": shape_all(Operation, c.store.list("operations")),
        "onboarding": {
            "llm_configured": bool(c.llm.configured),
            "has_connectors": bool(connectors),
            "has_users": bool(users),
            "has_portfolio": "portfolio" in kinds,
            "has_jira": "jira" in kinds,
            # For every DOINg.AI / Jira connector kind present, the operations the builtin
            # blueprints call exist (its standard setup was run, or they were made by hand).
            "has_standard_operations": bool(standard) and all(c.get_operation_by_key(op["key"]) is not None
                                                              for kind in standard for op in operations_for(kind)),
        },
    }
