"""Demo installer: a complete sandbox environment in one click (docs/SPEC.md §13).

`install_demo(container)` adds the people of the reference scenario, teams mapped to Jira
projects, the two bundled sandbox MCP servers as stdio connectors, the operations the builtin
blueprints call, and the watcher that turns new DOINg.AI use cases into intake items.

Idempotent: each record is matched on a natural key (e-mail, name, operation key) and an
existing one is never overwritten, so a second run only fills gaps and an admin's edits
survive. Connectors are flagged `sandbox` and named "(Sandbox)": nothing installed here talks
to a real system. The demo never configures the LLM — that stays an explicit admin choice.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from app.config import BACKEND_DIR
from app.models import Connector, Operation, Team, User, Watcher
from app.seed.defaults import field_def, seed_defaults
from app.util import new_id, now_iso, slugify

MCP_SERVERS_DIR = BACKEND_DIR / "mcp_servers"
PORTFOLIO_CONNECTOR = "DOINg.AI Portfolio (Sandbox)"
JIRA_CONNECTOR = "Jira (Sandbox)"
WATCHER_NAME = "New DOINg.AI use cases"

# The reference scenario's cast. Alice, Paul… also exist in the DOINg.AI sandbox under the same
# e-mail, which is how a use case's sponsor resolves to a Factory user.
DEMO_USERS: list[dict[str, Any]] = [
    {"name": "Alice Martin", "email": "alice.martin@doing.ai", "title": "Managing Director, Corporate Lending",
     "roles": ["sponsor"], "avatar_color": "brand"},
    {"name": "Henri Dubois", "email": "henri.dubois@doing.ai", "title": "Head of Liquidity Management",
     "roles": ["sponsor"], "avatar_color": "teal"},
    {"name": "Paul Durand", "email": "paul.durand@doing.ai", "title": "AI Product Manager",
     "roles": ["product_manager"], "avatar_color": "sky"},
    {"name": "Thomas Klein", "email": "thomas.klein@doing.ai", "title": "Product Manager, Data & AI",
     "roles": ["product_manager"], "avatar_color": "cyan"},
    {"name": "Sofia Rossi", "email": "sofia.rossi@doing.ai", "title": "Engineering Lead, MCP Factory",
     "roles": ["dev_lead", "developer"], "avatar_color": "indigo"},
    {"name": "Karim Benali", "email": "karim.benali@doing.ai", "title": "Senior Software Engineer",
     "roles": ["developer"], "avatar_color": "violet"},
    {"name": "Emma Leroy", "email": "emma.leroy@doing.ai", "title": "Release & Change Manager",
     "roles": ["it_ops"], "avatar_color": "amber"},
    {"name": "Lucas Moreau", "email": "lucas.moreau@doing.ai", "title": "Application Security Lead",
     "roles": ["security"], "avatar_color": "rose"},
    {"name": "Chloé Bernard", "email": "chloe.bernard@doing.ai", "title": "IT Compliance Officer",
     "roles": ["compliance"], "avatar_color": "emerald"},
    {"name": "Factory Admin", "email": "admin@doing.ai", "title": "Platform Administrator",
     "roles": ["admin"], "avatar_color": "zinc"},
]

# Skills are what team routing reads: they name the systems and domains each team owns.
DEMO_TEAMS: list[dict[str, Any]] = [
    {"name": "MCP Factory Squad", "jira_project_key": "MCPF", "lead": "sofia.rossi@doing.ai",
     "members": ["sofia.rossi@doing.ai", "karim.benali@doing.ai"],
     "description": "Builds and runs the bank's MCP servers and agent tooling; default team for generic integrations.",
     "skills": ["mcp", "python", "api integration", "agents", "document ai", "llm tooling"]},
    {"name": "Data Platform", "jira_project_key": "DATA", "lead": "karim.benali@doing.ai",
     "members": ["karim.benali@doing.ai"],
     "description": "Data warehouses, lakehouse and data services, including Treasury and lending data.",
     "skills": ["data warehouse", "oracle", "sql", "treasury data", "loan data", "loan iq",
                "financial statements", "reference data", "etl"]},
    {"name": "Payments", "jira_project_key": "PAY", "lead": "sofia.rossi@doing.ai",
     "members": ["sofia.rossi@doing.ai"],
     "description": "Payments hub, cash management and treasury services IT.",
     "skills": ["payments", "swift", "iso 20022", "cash management", "nostro", "liquidity", "correspondent banking"]},
    {"name": "Security Engineering", "jira_project_key": "SEC", "lead": "lucas.moreau@doing.ai",
     "members": ["lucas.moreau@doing.ai"],
     "description": "Application security, identity and access management, secrets.",
     "skills": ["application security", "iam", "secrets management", "pen testing", "threat modelling"]},
    {"name": "IT Operations", "jira_project_key": "OPS", "lead": "emma.leroy@doing.ai",
     "members": ["emma.leroy@doing.ai"],
     "description": "Production: change management, releases, monitoring and on-call.",
     "skills": ["release management", "change management", "monitoring", "on-call", "infrastructure"]},
]

ENSURE_EPIC_GOAL = """\
Make sure Jira project {{ input.project_key }} has one open epic for "{{ input.summary }}": reuse it when it exists, create it otherwise. Never create a duplicate.
{% if not input.project_key %}
No Jira project key was given: do not call any tool; answer that the delivery team has no Jira project.
{% endif %}
1. Call jira_search with jql: project = {{ input.project_key }} AND issuetype = Epic AND summary ~ "{{ input.search_text or input.summary }}"
2. If nothing comes back, search once more with only the one or two most distinctive words of that name (not "MCP").
3. An epic in status To Do or In Progress whose summary names the same server is a match: reuse it and create nothing. An epic in status Done is finished work, not a match. If several match, take the most recently updated.
4. Only when nothing matches, call jira_create_issue with project_key "{{ input.project_key }}", issue_type "Epic", summary "{{ input.summary }}", labels {{ (input.labels or []) | tojson }} and this description, copied exactly:
{{ input.description or input.summary }}

Finish with ONLY this JSON, copying key and url from the tool result:
{"key": "...", "url": "...", "created": true or false, "project_key": "{{ input.project_key }}"}"""

EPIC_SCHEMA = {"type": "object", "required": ["key", "url", "created", "project_key"],
               "properties": {"key": {"type": "string"}, "url": {"type": "string"},
                              "created": {"type": "boolean"}, "project_key": {"type": "string"}}}

_STATUSES = ["Planning", "Active", "Paused", "Done"]


def _op(key: str, name: str, connector: str, description: str, *, tool: str = "", args: dict | None = None,
        extract: str = "", inputs: list[dict] | None = None, test_input: dict | None = None, mode: str = "direct",
        prompt: str = "", allowed_tools: list[str] | None = None, json_schema: dict | None = None,
        sensitive: bool = False) -> dict[str, Any]:
    return {"key": key, "name": name, "connector": connector, "description": description, "mode": mode,
            "tool": tool, "args_template": args or {}, "prompt": prompt, "allowed_tools": allowed_tools or [],
            "output": {"extract": extract, "json_schema": json_schema}, "sensitive": sensitive,
            "inputs": inputs or [], "test_input": test_input or {}}


def demo_operations() -> list[dict[str, Any]]:
    """The operations the builtin blueprints and the watcher call, by key. `connector` is
    "portfolio" or "jira" and becomes the connector id at install time. Optional arguments are
    templated with a fallback (`or ''`, `or []`) so an absent input sends an empty value, not an
    undefined one."""
    return [
        # --- DOINg.AI portfolio -------------------------------------------------------------
        _op("portfolio.list_projects", "List DOINg.AI projects", "portfolio",
            "Projects of the DOINg.AI portfolio, optionally by status; new use cases are in 'Planning'.",
            tool="list_projects", extract="result.projects",
            args={"status": "{{ input.status or '' }}", "updated_since": "{{ input.updated_since or '' }}"},
            inputs=[field_def("status", "Status", "select", options=_STATUSES),
                    field_def("updated_since", "Updated since", "date")],
            test_input={"status": "Planning"}),
        _op("portfolio.get_project", "Get a DOINg.AI project", "portfolio",
            "One project in full: context, members, MCP servers it relies on.",
            tool="get_project", args={"project_id": "{{ input.project_id }}"},
            inputs=[field_def("project_id", "DOINg.AI project id", required=True)],
            test_input={"project_id": "prj-1006"}),
        _op("portfolio.search_mcp", "Search the MCP catalog", "portfolio",
            "Best catalog matches for a capability, with a 0-1 score and the words that matched.",
            tool="search_mcp_servers", extract="result.matches",
            args={"capability": "{{ input.capability }}", "limit": "{{ input.limit or 5 }}"},
            inputs=[field_def("capability", "Capability", required=True, placeholder="e.g. FX spot rates"),
                    field_def("limit", "Max matches", "number", default=5)],
            test_input={"capability": "FX spot rates"}),
        _op("portfolio.list_mcp_servers", "List catalog MCP servers", "portfolio",
            "The DOINg.AI catalog of MCP servers, optionally filtered by words or deploy status.",
            tool="list_mcp_servers", extract="result.mcp_servers",
            args={"query": "{{ input.query or '' }}", "deploy_status": "{{ input.deploy_status or '' }}"},
            inputs=[field_def("query", "Words"),
                    field_def("deploy_status", "Deploy status", "select", options=["dev", "uat", "production"])],
            test_input={"deploy_status": "production"}),
        _op("portfolio.register_mcp", "Register an MCP server in DOINg.AI", "portfolio",
            "Adds (or updates, by name) an MCP server in the DOINg.AI catalog.",
            tool="register_mcp_server", sensitive=True,
            args={"name": "{{ input.name }}", "description": "{{ input.description }}",
                  "tools": "{{ input.tools or [] }}", "category": "{{ input.category or '' }}",
                  "tags": "{{ input.tags or [] }}", "team_it": "{{ input.team_it or '' }}",
                  "deploy_status": "{{ input.deploy_status or 'dev' }}", "use_case": "{{ input.use_case or '' }}",
                  "data_source": "{{ input.data_source or '' }}"},
            inputs=[field_def("name", "Name", required=True), field_def("description", "Description", "textarea", required=True),
                    field_def("tools", "Tools", "list", help="One per line: tool_name — what it returns."),
                    field_def("category", "Category"), field_def("tags", "Tags", "list"), field_def("team_it", "IT team"),
                    field_def("deploy_status", "Deploy status", "select", options=["dev", "uat", "production"], default="dev"),
                    field_def("use_case", "Use case", "textarea"), field_def("data_source", "Source system")],
            test_input={"name": "Sandbox Test MCP", "description": "Registered by an operation test from the Factory.",
                        "tools": ["ping — answers pong"], "deploy_status": "dev"}),
        _op("portfolio.update_status", "Update a DOINg.AI project status", "portfolio",
            "Sets status / dev status of a DOINg.AI project and appends a note.",
            tool="update_project_status", sensitive=True,
            args={"project_id": "{{ input.project_id }}", "status": "{{ input.status or '' }}",
                  "dev_status": "{{ input.dev_status or '' }}", "note": "{{ input.note or '' }}"},
            inputs=[field_def("project_id", "DOINg.AI project id", required=True),
                    field_def("status", "Status", "select", options=_STATUSES),
                    field_def("dev_status", "Dev status", "select", options=["to_start", "dev", "uat", "prod"]),
                    field_def("note", "Note", "textarea")],
            test_input={"project_id": "prj-1003", "note": "Status check from the DOINg.AI Factory."}),
        # --- Jira ---------------------------------------------------------------------------
        _op("jira.search", "Search Jira", "jira", "Issues matching a JQL query (sandbox subset).",
            tool="jira_search", extract="result.issues",
            args={"jql": "{{ input.jql }}", "limit": "{{ input.limit or 20 }}"},
            inputs=[field_def("jql", "JQL", required=True, placeholder="project = MCPF AND issuetype = Epic"),
                    field_def("limit", "Max results", "number", default=20)],
            test_input={"jql": "project = MCPF AND issuetype = Epic"}),
        _op("jira.get_issue", "Get a Jira issue", "jira",
            "One issue with its status; for an epic, its stories and progress.",
            tool="jira_get_issue", args={"issue_key": "{{ input.issue_key }}"},
            inputs=[field_def("issue_key", "Issue key", required=True, placeholder="MCPF-12")],
            test_input={"issue_key": "PAY-31"}),
        _op("jira.ensure_epic", "Find or create a Jira epic", "jira",
            "Agent: searches the team's Jira project for an open epic of the same name and reuses it; "
            "creates the epic only when none exists.",
            mode="agent", prompt=ENSURE_EPIC_GOAL, allowed_tools=["jira_search", "jira_create_issue"],
            json_schema=EPIC_SCHEMA, sensitive=True,
            inputs=[field_def("project_key", "Jira project key", required=True, placeholder="MCPF"),
                    field_def("summary", "Epic summary", required=True),
                    field_def("search_text", "Words to look for", help="Defaults to the summary."),
                    field_def("description", "Description", "markdown"), field_def("labels", "Labels", "list")],
            test_input={"project_key": "PAY", "summary": "MCP — Nostro Balances MCP", "search_text": "Nostro Balances MCP",
                        "description": "Nostro account balances at correspondent banks for agents.", "labels": ["mcp"]}),
        _op("jira.create_issue", "Create a Jira issue", "jira", "Creates one issue.",
            tool="jira_create_issue", extract="result.issue", sensitive=True,
            args={"project_key": "{{ input.project_key }}", "summary": "{{ input.summary }}",
                  "issue_type": "{{ input.issue_type or 'Task' }}", "description": "{{ input.description or '' }}",
                  "priority": "{{ input.priority or 'Medium' }}", "labels": "{{ input.labels or [] }}",
                  "parent_key": "{{ input.parent_key or '' }}", "assignee": "{{ input.assignee or '' }}",
                  "story_points": "{{ input.story_points or none }}", "components": "{{ input.components or [] }}"},
            inputs=[field_def("project_key", "Jira project key", required=True),
                    field_def("summary", "Summary", required=True),
                    field_def("issue_type", "Issue type", "select", options=["Epic", "Story", "Task", "Bug", "Change"], default="Task"),
                    field_def("description", "Description", "markdown"),
                    field_def("priority", "Priority", "select", options=["Highest", "High", "Medium", "Low", "Lowest"], default="Medium"),
                    field_def("labels", "Labels", "list"), field_def("parent_key", "Epic key"),
                    field_def("assignee", "Assignee"), field_def("story_points", "Story points", "number"),
                    field_def("components", "Components", "list")],
            test_input={"project_key": "MCPF", "summary": "Sandbox test task from the Factory", "issue_type": "Task"}),
        _op("jira.create_stories", "Create Jira stories (batch)", "jira",
            "Creates a list of issues in one call; nothing is created if one of them is invalid.",
            tool="jira_batch_create_issues", sensitive=True, args={"issues": "{{ input.issues }}"},
            inputs=[field_def("issues", "Issues (JSON array)", "textarea", required=True,
                              help='[{"project_key", "summary", "description", "issue_type", "parent_key", "story_points", "labels"}]')],
            test_input={"issues": [{"project_key": "MCPF", "summary": "Sandbox test story", "issue_type": "Story",
                                    "parent_key": "MCPF-9", "story_points": 1, "labels": ["test"]}]}),
        _op("jira.create_change", "Create a change request", "jira",
            "Raises a Change issue in the IT Operations project (OPS unless another key is given).",
            tool="jira_create_issue", extract="result.issue", sensitive=True,
            args={"project_key": "{{ input.project_key or 'OPS' }}", "summary": "{{ input.summary }}",
                  "issue_type": "Change", "description": "{{ input.description or '' }}",
                  "priority": "{{ input.priority or 'Medium' }}", "labels": "{{ input.labels or [] }}"},
            inputs=[field_def("summary", "Summary", required=True), field_def("description", "Description", "markdown"),
                    field_def("priority", "Priority", "select", options=["Highest", "High", "Medium", "Low", "Lowest"], default="Medium"),
                    field_def("labels", "Labels", "list"), field_def("project_key", "Jira project key", default="OPS")],
            test_input={"summary": "Sandbox test change from the Factory", "description": "Operation test."}),
    ]


def demo_watcher(blueprint_id: str) -> dict[str, Any]:
    """The watcher of the reference flow. Field names are DOINg.AI's (camelCase)."""
    return {
        "name": WATCHER_NAME,
        "description": "Every 15 minutes, looks for DOINg.AI projects in status Planning and files each new one "
                       "in Intake, ready to start the Use Case Onboarding blueprint.",
        "enabled": True, "operation_key": "portfolio.list_projects", "input": {"status": "Planning"},
        "schedule": {"every_minutes": 15}, "items_expr": "result", "key_field": "id", "title_field": "name",
        "filter": "not item.isArchived", "action": "intake", "blueprint_id": blueprint_id,
        "mapping": {
            "title": "{{ item.name }}",
            "description": "{{ item.description }}",
            "priority": "{{ 'high' if item.isImportant else 'medium' }}",
            "sponsor_email": "{{ item.sponsor.email if item.sponsor else '' }}",
            "tags": "{{ item.tags or [] }}",
            "inputs.doing_ai_id": "{{ item.id }}",
            "inputs.context": "{{ item.context or item.description }}",
            "inputs.business_unit": "{{ item.businessUnit or '' }}",
            "inputs.target_date": "{{ item.deadline or '' }}",
            "inputs.expected_benefits": "{{ item.notes or '' }}",
        },
        "baseline_on_first_run": False,
    }


def _connectors(sandbox_dir: Path) -> list[dict[str, Any]]:
    python = sys.executable   # the Factory's own interpreter: the sandbox servers are stdlib-only
    return [
        {"name": PORTFOLIO_CONNECTOR, "kind": "portfolio",
         "description": "Bundled sandbox of the DOINg.AI portfolio (projects, people, MCP catalog, wishes). Set "
                        "DOING_AI_MODE=bridge and DOING_AI_URL to read the live DOINg.AI instead (read-only).",
         "args": [str(MCP_SERVERS_DIR / "doing_ai_mcp.py")],
         "env": {"DOING_AI_MODE": "sandbox", "DOING_AI_STATE": str(sandbox_dir / "doing_ai.json")},
         "command": python},
        {"name": JIRA_CONNECTOR, "kind": "jira",
         "description": "Bundled sandbox Jira with projects MCPF, DATA, PAY, SEC and OPS. Tool names mirror "
                        "the mcp-atlassian server, so a real Jira connector can replace it.",
         "args": [str(MCP_SERVERS_DIR / "jira_mcp.py")],
         "env": {"JIRA_SANDBOX_STATE": str(sandbox_dir / "jira.json")},
         "command": python},
    ]


def install_demo(container: Any) -> dict[str, Any]:
    """Install whatever part of the demo environment is missing; returns the counts added."""
    store = container.store
    seed_defaults(container)   # the watcher needs the builtin blueprints
    created = {"users": 0, "teams": 0, "connectors": 0, "operations": 0, "watchers": 0}
    stamp = now_iso()

    users_by_email = {(u.get("email") or "").lower(): u for u in store.list("users")}
    for spec in DEMO_USERS:
        if spec["email"] not in users_by_email:
            doc = User.model_validate({**spec, "id": new_id("usr"), "created_at": stamp}).model_dump()
            users_by_email[spec["email"]] = store.put("users", doc)
            created["users"] += 1

    team_names = {(t.get("name") or "").lower() for t in store.list("teams")}
    for spec in DEMO_TEAMS:
        if spec["name"].lower() in team_names:
            continue
        members = [users_by_email[e]["id"] for e in spec["members"] if e in users_by_email]
        lead = users_by_email.get(spec["lead"], {}).get("id", "")
        team = store.put("teams", Team.model_validate({
            "id": new_id("team"), "name": spec["name"], "description": spec["description"],
            "jira_project_key": spec["jira_project_key"], "skills": spec["skills"], "lead_user_id": lead,
            "member_ids": members, "created_at": stamp}).model_dump())
        created["teams"] += 1
        for user_id in members:   # membership is recorded on both sides
            user = store.get("users", user_id)
            if user is not None and team["id"] not in user.get("team_ids", []):
                store.put("users", {**user, "team_ids": [*user.get("team_ids", []), team["id"]]})

    sandbox_dir = container.settings.data_path / "sandbox"
    connectors_by_name = {(c.get("name") or "").lower(): c for c in store.list("connectors")}
    for spec in _connectors(sandbox_dir):
        if spec["name"].lower() in connectors_by_name:
            continue
        doc = Connector.model_validate({
            **spec, "id": new_id("con"), "slug": slugify(spec["name"]), "transport": "stdio", "cwd": "",
            "enabled": True, "timeout_s": 60, "sandbox": True, "created_at": stamp, "updated_at": stamp}).model_dump()
        connectors_by_name[spec["name"].lower()] = store.put("connectors", doc)
        created["connectors"] += 1
    connector_ids = {"portfolio": connectors_by_name[PORTFOLIO_CONNECTOR.lower()]["id"],
                     "jira": connectors_by_name[JIRA_CONNECTOR.lower()]["id"]}

    op_keys = {op.get("key") for op in store.list("operations")}
    for spec in demo_operations():
        if spec["key"] in op_keys:
            continue
        fields = {k: v for k, v in spec.items() if k != "connector"}
        doc = Operation.model_validate({**fields, "id": new_id("op"), "connector_id": connector_ids[spec["connector"]],
                                        "created_at": stamp, "updated_at": stamp}).model_dump()
        store.put("operations", doc)
        created["operations"] += 1

    if not any(w.get("name") == WATCHER_NAME for w in store.list("watchers")):
        blueprint = next(b for b in store.list("blueprints") if b.get("key") == "use_case_onboarding")
        doc = Watcher.model_validate({**demo_watcher(blueprint["id"]), "id": new_id("wat"),
                                      "created_at": stamp, "updated_at": stamp}).model_dump()
        store.put("watchers", doc)
        created["watchers"] += 1

    added = ", ".join(f"{n} {k}" for k, n in created.items() if n)
    container.record_event("demo.installed",
                           f"Sandbox demo environment installed: {added}." if added
                           else "Sandbox demo environment already complete: nothing to add.",
                           data={"created": created})
    return {"created": created}
