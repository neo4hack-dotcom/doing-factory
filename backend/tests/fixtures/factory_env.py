"""A configured Factory for tests: people, delivery teams, a DOINg.AI connector (the real
`mcp_servers/doing_ai_mcp.py`, pointed at a `FakeDoingAI` URL) and a Jira connector (the
mcp-atlassian test double), each given its standard setup exactly as an admin would.

Only tests use this: the app ships no people, teams or connectors of its own.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from app.models import Connector, Team, User
from app.seed.defaults import seed_defaults
from app.seed.standard_ops import standard_setup
from app.util import new_id, now_iso, slugify

FIXTURES = Path(__file__).resolve().parent
DOING_AI_SERVER = FIXTURES.parents[1] / "mcp_servers" / "doing_ai_mcp.py"
FAKE_JIRA_SERVER = FIXTURES / "fake_jira_mcp.py"
PORTFOLIO_CONNECTOR = "DOINg.AI"
JIRA_CONNECTOR = "Jira"

# Alice, Paul… also exist in the fake DOINg.AI under the same e-mail, which is how a use
# case's sponsor resolves to a Factory user.
TEST_USERS: list[dict[str, Any]] = [
    {"name": "Alice Martin", "email": "alice.martin@doing.ai", "title": "Managing Director, Corporate Lending",
     "roles": ["sponsor"]},
    {"name": "Henri Dubois", "email": "henri.dubois@doing.ai", "title": "Head of Liquidity Management",
     "roles": ["sponsor"]},
    {"name": "Paul Durand", "email": "paul.durand@doing.ai", "title": "AI Product Manager", "roles": ["product_manager"]},
    {"name": "Thomas Klein", "email": "thomas.klein@doing.ai", "title": "Product Manager, Data & AI",
     "roles": ["product_manager"]},
    {"name": "Sofia Rossi", "email": "sofia.rossi@doing.ai", "title": "Engineering Lead, MCP Factory",
     "roles": ["dev_lead", "developer"]},
    {"name": "Karim Benali", "email": "karim.benali@doing.ai", "title": "Senior Software Engineer", "roles": ["developer"]},
    {"name": "Emma Leroy", "email": "emma.leroy@doing.ai", "title": "Release & Change Manager", "roles": ["it_ops"]},
    {"name": "Lucas Moreau", "email": "lucas.moreau@doing.ai", "title": "Application Security Lead", "roles": ["security"]},
    {"name": "Chloé Bernard", "email": "chloe.bernard@doing.ai", "title": "IT Compliance Officer", "roles": ["compliance"]},
    {"name": "Factory Admin", "email": "admin@doing.ai", "title": "Platform Administrator", "roles": ["admin"]},
]

TEST_TEAMS: list[dict[str, Any]] = [
    {"name": "MCP Factory Squad", "jira_project_key": "MCPF", "lead": "sofia.rossi@doing.ai",
     "members": ["sofia.rossi@doing.ai", "karim.benali@doing.ai"],
     "description": "Builds and runs the bank's MCP servers and agent tooling; default team for generic integrations.",
     "skills": ["mcp", "python", "api integration", "agents", "document ai", "llm tooling"]},
    {"name": "Data Platform", "jira_project_key": "DATA", "lead": "karim.benali@doing.ai",
     "members": ["karim.benali@doing.ai"],
     "description": "Data warehouses, lakehouse and data services, including Treasury and lending data.",
     "skills": ["data warehouse", "oracle", "sql", "treasury data", "loan data", "loan iq",
                "financial statements", "reference data", "etl"]},
    {"name": "Payments", "jira_project_key": "PAY", "lead": "sofia.rossi@doing.ai", "members": ["sofia.rossi@doing.ai"],
     "description": "Payments hub, cash management and treasury services IT.",
     "skills": ["payments", "swift", "iso 20022", "cash management", "nostro", "liquidity", "correspondent banking"]},
    {"name": "Security Engineering", "jira_project_key": "SEC", "lead": "lucas.moreau@doing.ai",
     "members": ["lucas.moreau@doing.ai"],
     "description": "Application security, identity and access management, secrets.",
     "skills": ["application security", "iam", "secrets management", "pen testing", "threat modelling"]},
    {"name": "IT Operations", "jira_project_key": "OPS", "lead": "emma.leroy@doing.ai", "members": ["emma.leroy@doing.ai"],
     "description": "Production: change management, releases, monitoring and on-call.",
     "skills": ["release management", "change management", "monitoring", "on-call", "infrastructure"]},
]


def add_connector(container: Any, name: str, kind: str, script: Path, env: dict[str, str]) -> dict[str, Any]:
    stamp = now_iso()
    doc = Connector.model_validate({
        "id": new_id("con"), "name": name, "slug": slugify(name), "kind": kind, "transport": "stdio",
        "command": sys.executable, "args": [str(script)], "env": env, "enabled": True, "timeout_s": 60,
        "created_at": stamp, "updated_at": stamp}).model_dump()
    return container.store.put("connectors", doc)


def install_test_env(container: Any, *, doing_ai_url: str, jira_state: Path) -> dict[str, Any]:
    """→ {portfolio: connector, jira: connector, setup: {portfolio: result, jira: result}}."""
    store = container.store
    seed_defaults(container)
    stamp = now_iso()
    by_email: dict[str, dict] = {}
    for spec in TEST_USERS:
        by_email[spec["email"]] = store.put("users", User.model_validate(
            {**spec, "id": new_id("usr"), "created_at": stamp}).model_dump())
    for spec in TEST_TEAMS:
        members = [by_email[e]["id"] for e in spec["members"]]
        team = store.put("teams", Team.model_validate({
            "id": new_id("team"), "name": spec["name"], "description": spec["description"],
            "jira_project_key": spec["jira_project_key"], "skills": spec["skills"],
            "lead_user_id": by_email[spec["lead"]]["id"], "member_ids": members, "created_at": stamp}).model_dump())
        for user_id in members:
            user = store.get("users", user_id)
            store.put("users", {**user, "team_ids": [*user.get("team_ids", []), team["id"]]})
    portfolio = add_connector(container, PORTFOLIO_CONNECTOR, "portfolio", DOING_AI_SERVER, {"DOING_AI_URL": doing_ai_url})
    jira = add_connector(container, JIRA_CONNECTOR, "jira", FAKE_JIRA_SERVER, {"FAKE_JIRA_STATE": str(jira_state)})
    setup = {"portfolio": standard_setup(container, portfolio["id"]), "jira": standard_setup(container, jira["id"])}
    return {"portfolio": portfolio, "jira": jira, "setup": setup}
