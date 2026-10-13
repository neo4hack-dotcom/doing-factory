"""Standard setup of a connector: the operations the builtin blueprints call, bound to it
(docs/SPEC.md §13).

`standard_setup(container, connector_id)` reads the connector's kind:
- "portfolio" (the DOINg.AI MCP server, `mcp_servers/doing_ai_mcp.py`) → the `portfolio.*`
  operations and the watcher "New DOINg.AI use cases" (every 15 minutes, projects in status
  Planning → Intake, blueprint Use Case Onboarding);
- "jira" (sooperset/mcp-atlassian) → the `jira.*` operations, written against its real tool
  names and argument shapes: objects and arrays travel as JSON strings (`additional_fields`,
  `issues`), components as a comma-separated string, and an issue's page is `browse_url`
  (`url` is the REST link).

Idempotent and conservative: an operation is matched on its key and a watcher on its name;
what exists is never touched (it may be bound to another connector or edited by an admin),
so running the setup again only fills gaps. Nothing here invents data: every operation
reads or writes the system the connector points at.
"""
from __future__ import annotations

from typing import Any

from app.errors import FactoryError, NotFound
from app.models import Operation, Watcher
from app.seed.defaults import field_def, seed_defaults
from app.util import new_id, now_iso

WATCHER_NAME = "New DOINg.AI use cases"
SUPPORTED_KINDS = ("portfolio", "jira")

ENSURE_EPIC_GOAL = """\
Make sure Jira project {{ input.project_key }} has one open epic for "{{ input.summary }}": reuse it when it exists, create it otherwise. Never create a duplicate.
{% if not input.project_key %}
No Jira project key was given: do not call any tool; answer that the delivery team has no Jira project.
{% endif %}
1. Call jira_search with jql: project = {{ input.project_key }} AND issuetype = Epic AND summary ~ "{{ input.search_text or input.summary }}"
2. If nothing comes back, search once more with only the one or two most distinctive words of that name (not "MCP").
3. An epic whose status category is not Done and whose summary names the same server is a match: reuse it and create nothing. An epic in status Done is finished work, not a match. If several match, take the most recently updated.
4. Only when nothing matches, call jira_create_issue with project_key "{{ input.project_key }}", issue_type "Epic", summary "{{ input.summary }}", additional_fields '{{ {"labels": input.labels or []} | tojson }}' and this description, copied exactly:
{{ input.description or input.summary }}

Finish with ONLY this JSON, copying key from the tool result and url from its browse_url (its url field when there is no browse_url):
{"key": "...", "url": "...", "created": true or false, "project_key": "{{ input.project_key }}"}"""

EPIC_SCHEMA = {"type": "object", "required": ["key", "url", "created", "project_key"],
               "properties": {"key": {"type": "string"}, "url": {"type": "string"},
                              "created": {"type": "boolean"}, "project_key": {"type": "string"}}}

# One story of the backlog (defaults.BACKLOG_SCHEMA) → one mcp-atlassian batch item. The batch
# tool ignores `parent`, so the epic goes in "Epic Link" and the estimate in "Story Points" —
# the field names of Jira Server/Data Center, resolved by display name; a field the instance
# does not have is skipped by the server, never an error.
STORIES_ARG = (
    "{% if input.issues is string %}{{ input.issues }}{% else %}["
    "{% for i in input.issues %}"
    "{{ {'project_key': i.project_key, 'summary': i.summary, 'issue_type': i.issue_type or 'Story', "
    "'description': i.description, 'labels': i.labels, 'Epic Link': i.parent_key, "
    "'Story Points': i.story_points} | compact | tojson }}{% if not loop.last %}, {% endif %}"
    "{% endfor %}]{% endif %}")

ISSUE_FIELDS_ARG = ("{{ {'labels': input.labels, 'priority': ({'name': input.priority} if input.priority else none), "
                    "'parent': input.parent_key, 'Story Points': input.story_points} | compact | tojson }}")

_STATUSES = ["Planning", "Active", "Paused", "Done"]
_PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"]


def _op(key: str, name: str, description: str, *, tool: str = "", args: dict | None = None, extract: str = "",
        inputs: list[dict] | None = None, test_input: dict | None = None, mode: str = "direct", prompt: str = "",
        allowed_tools: list[str] | None = None, json_schema: dict | None = None,
        sensitive: bool = False) -> dict[str, Any]:
    return {"key": key, "name": name, "description": description, "mode": mode, "tool": tool,
            "args_template": args or {}, "prompt": prompt, "allowed_tools": allowed_tools or [],
            "output": {"extract": extract, "json_schema": json_schema}, "sensitive": sensitive,
            "inputs": inputs or [], "test_input": test_input or {}}


def portfolio_operations() -> list[dict[str, Any]]:
    """Over the DOINg.AI MCP server. Optional arguments fall back to an empty value (`or ''`)."""
    return [
        _op("portfolio.list_projects", "List DOINg.AI projects",
            "Projects of the DOINg.AI portfolio, optionally by status; new use cases are in 'Planning'.",
            tool="list_projects", extract="result.projects",
            args={"status": "{{ input.status or '' }}", "updated_since": "{{ input.updated_since or '' }}"},
            inputs=[field_def("status", "Status", "select", options=_STATUSES),
                    field_def("updated_since", "Updated since", "date")],
            test_input={"status": "Planning"}),
        _op("portfolio.get_project", "Get a DOINg.AI project",
            "One project in full: context, members, MCP servers it relies on.",
            tool="get_project", args={"project_id": "{{ input.project_id }}"},
            inputs=[field_def("project_id", "DOINg.AI project id", required=True)]),
        _op("portfolio.search_mcp", "Search the MCP catalog",
            "Best catalog matches for a capability, with a 0-1 score and the words that matched.",
            tool="search_mcp_servers", extract="result.matches",
            args={"capability": "{{ input.capability }}", "limit": "{{ input.limit or 5 }}"},
            inputs=[field_def("capability", "Capability", required=True, placeholder="e.g. FX spot rates"),
                    field_def("limit", "Max matches", "number", default=5)],
            test_input={"capability": "FX spot rates"}),
        _op("portfolio.list_mcp_servers", "List catalog MCP servers",
            "The DOINg.AI catalog of MCP servers, optionally filtered by words or deploy status.",
            tool="list_mcp_servers", extract="result.mcp_servers",
            args={"query": "{{ input.query or '' }}", "deploy_status": "{{ input.deploy_status or '' }}"},
            inputs=[field_def("query", "Words"),
                    field_def("deploy_status", "Deploy status", "select", options=["dev", "uat", "production"])],
            test_input={"deploy_status": "production"}),
        _op("portfolio.register_mcp", "Register an MCP server in DOINg.AI",
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
                    field_def("use_case", "Use case", "textarea"), field_def("data_source", "Source system")]),
        _op("portfolio.update_status", "Update a DOINg.AI project status",
            "Sets status / dev status of a DOINg.AI project and appends a note to it.",
            tool="update_project_status", sensitive=True,
            args={"project_id": "{{ input.project_id }}", "status": "{{ input.status or '' }}",
                  "dev_status": "{{ input.dev_status or '' }}", "note": "{{ input.note or '' }}"},
            inputs=[field_def("project_id", "DOINg.AI project id", required=True),
                    field_def("status", "Status", "select", options=_STATUSES),
                    field_def("dev_status", "Dev status", "select", options=["to_start", "dev", "uat", "prod"]),
                    field_def("note", "Note", "textarea")]),
    ]


def jira_operations() -> list[dict[str, Any]]:
    """Over sooperset/mcp-atlassian."""
    return [
        _op("jira.search", "Search Jira", "Issues matching a JQL query.",
            tool="jira_search", extract="result.issues",
            args={"jql": "{{ input.jql }}", "limit": "{{ input.limit or 20 }}"},
            inputs=[field_def("jql", "JQL", required=True, placeholder="project = MCPF AND issuetype = Epic"),
                    field_def("limit", "Max results", "number", default=20, help="mcp-atlassian returns at most 50.")],
            test_input={"jql": "ORDER BY updated DESC", "limit": 5}),
        _op("jira.get_issue", "Get a Jira issue", "One issue with its status ({name, category}).",
            tool="jira_get_issue", args={"issue_key": "{{ input.issue_key }}"},
            inputs=[field_def("issue_key", "Issue key", required=True, placeholder="MCPF-12")]),
        _op("jira.ensure_epic", "Find or create a Jira epic",
            "Agent: searches the team's Jira project for an open epic of the same name and reuses it; "
            "creates the epic only when none exists.",
            mode="agent", prompt=ENSURE_EPIC_GOAL, allowed_tools=["jira_search", "jira_create_issue"],
            json_schema=EPIC_SCHEMA, sensitive=True,
            inputs=[field_def("project_key", "Jira project key", required=True, placeholder="MCPF"),
                    field_def("summary", "Epic summary", required=True),
                    field_def("search_text", "Words to look for", help="Defaults to the summary."),
                    field_def("description", "Description", "markdown"), field_def("labels", "Labels", "list")]),
        _op("jira.create_issue", "Create a Jira issue", "Creates one issue.",
            tool="jira_create_issue", extract="result.issue", sensitive=True,
            args={"project_key": "{{ input.project_key }}", "summary": "{{ input.summary }}",
                  "issue_type": "{{ input.issue_type or 'Task' }}", "description": "{{ input.description or '' }}",
                  "assignee": "{{ input.assignee or '' }}",
                  "components": "{{ (input.components or []) | join(',') }}",
                  "additional_fields": ISSUE_FIELDS_ARG},
            inputs=[field_def("project_key", "Jira project key", required=True),
                    field_def("summary", "Summary", required=True),
                    field_def("issue_type", "Issue type", "select", options=["Epic", "Story", "Task", "Bug"], default="Task"),
                    field_def("description", "Description", "markdown"),
                    field_def("priority", "Priority", "select", options=_PRIORITIES),
                    field_def("labels", "Labels", "list"), field_def("parent_key", "Parent (epic) key"),
                    field_def("assignee", "Assignee", help="E-mail, display name or account id."),
                    field_def("story_points", "Story points", "number"),
                    field_def("components", "Components", "list")]),
        _op("jira.create_stories", "Create Jira stories (batch)",
            "Creates the backlog's stories in one call, linked to their epic (Epic Link) with their story points.",
            tool="jira_batch_create_issues", extract="result.issues", sensitive=True, args={"issues": STORIES_ARG},
            inputs=[field_def("issues", "Issues", "textarea", required=True,
                              help='A list of {project_key, summary, description, issue_type, parent_key, '
                                   'story_points, labels}, or the JSON array mcp-atlassian takes.')]),
        _op("jira.create_change", "Create a change request",
            "Raises the production change of a release in the given Jira project.",
            tool="jira_create_issue", extract="result.issue", sensitive=True,
            args={"project_key": "{{ input.project_key }}", "summary": "{{ input.summary }}",
                  "issue_type": "{{ input.issue_type or 'Change' }}", "description": "{{ input.description or '' }}",
                  "additional_fields": ("{{ {'labels': input.labels, 'priority': ({'name': input.priority} "
                                        "if input.priority else none)} | compact | tojson }}")},
            inputs=[field_def("project_key", "Jira project key", required=True,
                              help="The project change requests are raised in."),
                    field_def("summary", "Summary", required=True), field_def("description", "Description", "markdown"),
                    field_def("issue_type", "Issue type", default="Change",
                              help="The issue type your Jira uses for changes (e.g. Change, Task)."),
                    field_def("priority", "Priority", "select", options=_PRIORITIES),
                    field_def("labels", "Labels", "list")]),
    ]


def new_use_cases_watcher(blueprint_id: str) -> dict[str, Any]:
    """New DOINg.AI use cases → Intake. Field names are DOINg.AI's (camelCase)."""
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


def operations_for(kind: str) -> list[dict[str, Any]]:
    return portfolio_operations() if kind == "portfolio" else jira_operations() if kind == "jira" else []


def standard_setup(container: Any, connector_id: str) -> dict[str, Any]:
    """→ {operations_created: [keys], operations_existing: [keys], watcher_created, notes: [str]}."""
    store = container.store
    connector = store.get("connectors", connector_id)
    if connector is None:
        raise NotFound(f"Connector '{connector_id}' not found.")
    kind = connector.get("kind") or "other"
    if kind not in SUPPORTED_KINDS:
        raise FactoryError(f"The standard setup exists for DOINg.AI (kind 'portfolio') and Jira (kind 'jira') "
                           f"connectors; '{connector.get('name')}' is of kind '{kind}'. Create its operations in "
                           "Studio › Operations.", 422)
    names = {d["id"]: d.get("name") or d["id"] for d in store.list("connectors")}
    stamp = now_iso()
    created: list[str] = []
    existing: list[str] = []
    notes: list[str] = []
    by_key = {op.get("key"): op for op in store.list("operations")}
    for spec in operations_for(kind):
        current = by_key.get(spec["key"])
        if current is not None:
            existing.append(spec["key"])
            if current.get("connector_id") != connector_id:
                other = names.get(current.get("connector_id") or "", "a connector that no longer exists")
                notes.append(f"Operation {spec['key']} already exists and uses '{other}': left unchanged "
                             f"(re-point it in Studio › Operations to use '{connector.get('name')}').")
            continue
        doc = Operation.model_validate({**spec, "id": new_id("op"), "connector_id": connector_id,
                                        "created_at": stamp, "updated_at": stamp}).model_dump()
        store.put("operations", doc)
        created.append(spec["key"])

    watcher_created = False
    if kind == "portfolio":
        if any(w.get("name") == WATCHER_NAME for w in store.list("watchers")):
            notes.append(f"The watcher '{WATCHER_NAME}' already exists: left unchanged.")
        else:
            blueprint = container.get_blueprint_by_key("use_case_onboarding")
            if blueprint is None:
                seed_defaults(container)
                blueprint = container.get_blueprint_by_key("use_case_onboarding")
            doc = Watcher.model_validate({**new_use_cases_watcher(blueprint["id"] if blueprint else ""),
                                          "id": new_id("wat"), "created_at": stamp, "updated_at": stamp}).model_dump()
            store.put("watchers", doc)
            watcher_created = True
            notes.append(f"Watcher '{WATCHER_NAME}' created: every 15 minutes, DOINg.AI projects in status Planning "
                         "become Intake items (including those already waiting today).")
    else:
        notes.append("Stories are linked to their epic through the 'Epic Link' field and sized through 'Story Points' "
                     "(Jira Server/Data Center field names); on Jira Cloud, adapt jira.create_stories in "
                     "Studio › Operations.")
        notes.append("Production changes are raised in the Jira project of the MCP Delivery input 'Change Jira "
                     "project' (default: the delivery team's project), with issue type 'Change' — set both to "
                     "your Jira's in Studio.")

    container.record_event(
        "settings.updated",
        f"Standard setup of connector '{connector.get('name')}': {len(created)} operation(s) created"
        + (", watcher created" if watcher_created else "") + ".",
        data={"section": "connectors", "action": "connector.standard_setup", "connector_id": connector_id,
              "operations_created": created, "watcher_created": watcher_created})
    return {"operations_created": created, "operations_existing": existing, "watcher_created": watcher_created,
            "notes": notes}
