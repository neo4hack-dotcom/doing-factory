"""Defaults seeded at every boot when missing: roles, compliance rules, builtin blueprints.

`seed_defaults()` only ever adds: a role list that already exists, a rule whose code exists and
a blueprint whose key exists are left exactly as the user edited them (a deleted builtin
blueprint comes back on the next boot — duplicate it to customise). Prompts are not seeded
here: the AI runtime falls back to `llm/prompts.py` until an admin edits one.

The builtin blueprints are the product demo (docs/SPEC.md §13). Data flows between steps
through `project.vars[store_as]`; each prompt names the vars it reads, so a step can be
understood (and edited) on its own. Jinja conventions (§4): `when`, `items` and `until` are
bare expressions; every other string is a template, and a template that is exactly one
`{{ expression }}` passes the native value (a list of Jira issues, not its text).

Each AI step's prompt carries the facts and the task; the *format* comes from the system
prompt it names (`writer`, `approval_brief`, `notifier`…). A user prompt that contradicted
its system prompt would leave a small local model choosing between two instructions.
"""
from __future__ import annotations

import textwrap
from typing import Any

from app.models import Blueprint, Rule
from app.util import new_id, now_iso

# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------

ROLES: list[dict[str, str]] = [
    {"key": "sponsor", "label": "Sponsor", "color": "brand",
     "description": "Business owner of a use case: funds it, signs off scope, release and go-live."},
    {"key": "product_manager", "label": "Product Manager", "color": "sky",
     "description": "Owns delivery: qualifies demand, writes specifications, reviews AI analyses."},
    {"key": "business_user", "label": "Business User", "color": "teal",
     "description": "Subject-matter expert who provides requirements and validates outputs."},
    {"key": "developer", "label": "Developer", "color": "violet",
     "description": "Builds and tests MCP servers and integrations."},
    {"key": "dev_lead", "label": "Dev Lead", "color": "indigo",
     "description": "Leads a delivery team: estimates, signs off the technical specification."},
    {"key": "it_ops", "label": "IT Operations", "color": "amber",
     "description": "Runs production: change management, release approval, monitoring."},
    {"key": "security", "label": "Security", "color": "rose",
     "description": "Application security: access, secrets and threats before a release."},
    {"key": "compliance", "label": "Compliance", "color": "emerald",
     "description": "IT compliance: owns the quality-gate rules and decides overrides."},
    {"key": "admin", "label": "Administrator", "color": "zinc",
     "description": "Configures the Factory and may act on any step."},
]

# ---------------------------------------------------------------------------
# Compliance rules (evaluated by quality_gate steps; tag "mcp" = applies to MCP servers)
# ---------------------------------------------------------------------------


def _rule(code: str, title: str, category: str, severity: str, tags: list[str], description: str,
          guidance: str, check: str = "ai") -> dict[str, Any]:
    return {"code": code, "title": title, "category": category, "severity": severity, "tags": tags,
            "description": description, "guidance": guidance, "check": check, "enabled": True}


RULES: list[dict[str, Any]] = [
    _rule("SEC-01", "Authentication required on every call", "Security", "critical", ["mcp", "security"],
          "Every caller is authenticated (service account, OAuth on behalf of the user, mutual TLS or an API key "
          "from the vault). Anonymous access is never acceptable, even on the internal network.",
          "Pass when the specification names an authentication model and the test plan has an "
          "'unauthenticated call is refused' case. Fail when no authentication model is defined."),
    _rule("SEC-02", "Least-privilege service account", "Security", "high", ["mcp", "security"],
          "The account that reaches the source system is read-only unless a write tool is justified, and is "
          "scoped to the data the tools expose.",
          "Pass when the specification states read-only access or justifies each write tool. Warn when the "
          "scope of the account is not stated."),
    _rule("SEC-03", "No secrets in code or configuration files", "Security", "critical", ["mcp", "security"],
          "Credentials are injected at run time from the secrets vault or the environment — never committed in "
          "code, container images or returned in tool output.",
          "Pass when the specification or test plan relies on the vault / environment for secrets. Warn when "
          "secret handling is not mentioned. Fail on any evidence of a hard-coded credential."),
    _rule("SEC-04", "Input validation and parameterised queries", "Security", "high", ["mcp", "security"],
          "Every tool argument is validated against its JSON schema; queries to the source use bind parameters — "
          "no SQL, shell command or URL built by string concatenation.",
          "Pass when the test plan covers invalid arguments and injection attempts in string arguments."),
    _rule("SEC-05", "Errors do not leak internals", "Security", "medium", ["mcp", "security"],
          "Failures are returned as MCP isError results with an actionable message — no stack trace, host name, "
          "SQL text or credential.",
          "Pass when error-handling tests check the content of error messages."),
    _rule("DATA-01", "Personal data classified and masked", "Data", "high", ["mcp", "data", "gdpr"],
          "The data classification is declared; personal data is identified and masked or minimised for callers "
          "who are not entitled to it.",
          "Fail when the classification is missing. When personal data is returned, require masking or an "
          "entitlement check in the specification or the tests."),
    _rule("DATA-02", "Data minimisation and result limits", "Data", "medium", ["mcp", "data"],
          "Tools return only the fields the consumers need, with result-size limits (pagination, maximum rows).",
          "Pass when tool descriptions or NFRs bound the result size. Warn when a tool can return an unbounded list."),
    _rule("ARCH-01", "Tool annotations declared", "Architecture", "high", ["mcp", "architecture"],
          "Every tool declares readOnlyHint / destructiveHint so agents and the Factory can gate write calls.",
          "Pass when the specification says which tools are read-only and which write, and the contract tests "
          "check the annotations. Fail when write tools are not identified."),
    _rule("ARCH-02", "Tools and parameters documented", "Architecture", "medium", ["mcp", "architecture"],
          "Each tool has a clear description and a typed JSON schema with required fields; names are snake_case "
          "and stable.",
          "Pass when every tool in the specification states what it returns. Warn on vague tool descriptions."),
    _rule("ARCH-03", "Versioning and changelog", "Architecture", "low", ["mcp", "architecture"],
          "The server reports its version in serverInfo; releases follow semantic versioning with a changelog.",
          "Pass when release notes or the specification mention the version. Otherwise warn."),
    _rule("OPS-01", "Timeouts and rate limits", "Operations", "medium", ["mcp", "operations"],
          "Calls to the source system have timeouts; the server limits the call rate per client to protect the source.",
          "Pass when NFRs or tests mention timeouts and rate limits. Warn when absent."),
    _rule("OPS-02", "Audit logging of tool calls", "Operations", "high", ["mcp", "operations", "security"],
          "Each call is logged with caller identity, tool, arguments (secrets redacted), outcome and latency, and "
          "shipped to the central SIEM.",
          "Pass when the specification or the backlog includes audit logging. Fail when it is explicitly excluded."),
    _rule("OPS-03", "Monitoring and health check", "Operations", "medium", ["mcp", "operations"],
          "A health check and metrics (calls, errors, latency) are monitored, with alerts to the owning team.",
          "Pass when the backlog or the test plan covers monitoring. Warn when absent."),
    _rule("OPS-04", "Owner and support model defined", "Operations", "medium", ["mcp", "operations"],
          "A named owning team, a support contact and an escalation path exist before production.",
          "Pass when an owning team is routed and named. Warn when the support model is not described."),
    _rule("QA-01", "Test set covers the critical paths", "Quality", "high", ["mcp", "quality"],
          "Every tool has nominal, edge and error test cases, and every acceptance criterion maps to at least one test.",
          "Pass when the test plan has a coverage section mapping each acceptance criterion. Fail when a tool has no test."),
    _rule("LEG-01", "GDPR legal basis and data residency", "Legal", "high", ["mcp", "legal", "gdpr", "data"],
          "When personal data is processed, the legal basis is recorded in the processing register with the DPO "
          "and data stays in approved locations.",
          "Manual check: compliance confirms the processing-register entry (or that no personal data is processed).",
          check="manual"),
]

# ---------------------------------------------------------------------------
# Blueprint building blocks
# ---------------------------------------------------------------------------

# A builtin blueprint cannot know which connector serves the portfolio tools (the sandbox, a
# bridge to the live DOINg.AI, any name), so the dependency agent is limited by bare tool names,
# plus the qualified names of the bundled sandbox connector ("DOINg.AI Portfolio (Sandbox)").
PORTFOLIO_SANDBOX_SLUG = "doing_ai_portfolio_sandbox"
_PORTFOLIO_READ_TOOLS = ["search_mcp_servers", "list_mcp_servers", "get_project"]
PORTFOLIO_AGENT_TOOLS = _PORTFOLIO_READ_TOOLS + [f"{PORTFOLIO_SANDBOX_SLUG}__{t}" for t in _PORTFOLIO_READ_TOOLS]

# Template fragments shared by several prompts, spliced in as [[NAME]] after dedenting (a
# multi-line fragment spliced before would defeat textwrap.dedent). List fragments start each
# item with a newline, so a placeholder written right after its label ("Tools:[[TOOLS]]")
# keeps the template's own line breaks around the list.
_FRAGMENTS: dict[str, str] = {
    # vars.spec.tools is a list (form field type "list"); a spec edited by hand or drafted by
    # the AI may hold a single string, which a bare `for` would walk character by character.
    "TOOLS": ('{% for t in ([vars.spec.tools] if vars.spec.tools is string else vars.spec.tools) %}\n- {{ t }}'
              '{% else %} (none specified){% endfor %}'),
    "TOOLS_INLINE": '{{ vars.spec.tools if vars.spec.tools is string else vars.spec.tools | join("; ") }}',
    "TEAM_SKILLS": ('{% for t in teams %}\n- {{ t.name }}: {{ t.skills | join(", ") }}'
                    '{% else %} (no delivery team configured){% endfor %}'),
    "TEAM_ROUTES": ('{% for t in teams %}\n- team_id: {{ t.id }} | name: {{ t.name }} | jira_project_key: '
                    '{{ t.jira_project_key or "(none)" }} | skills: {{ t.skills | join(", ") }}'
                    '{% else %} (no delivery team configured){% endfor %}'),
    "GATE": ('{% if vars.gate.passed %}passed{% else %}not passed{% endif %}'
             '{% if vars.gate.overridden %} (overridden by an authorised reviewer){% endif %}'
             '{% if vars.gate.failed %}; findings: {{ vars.gate.failed | join(", ") }}{% endif %}'),
    "TESTS": ('{{ vars.test_report.tests_passed if vars.test_report.tests_passed is number else "?" }}/'
              '{{ vars.test_report.tests_total if vars.test_report.tests_total is number else "?" }}'),
    "FEEDBACK": ('{% if feedback %}\n\nReviewer feedback on the previous version (address every point):\n'
                 '{{ feedback }}{% endif %}'),
}


def _t(text: str) -> str:
    """A template written indented in this file: dedented, outer blank lines removed, shared
    [[FRAGMENTS]] spliced in."""
    out = textwrap.dedent(text).strip("\n")
    for name, fragment in _FRAGMENTS.items():
        out = out.replace(f"[[{name}]]", fragment)
    return out


def _who(*roles: str, project_role: str = "") -> dict[str, Any]:
    return {"roles": list(roles), "user_ids": [], "project_role": project_role}


def field_def(key: str, label: str, type: str = "text", *, required: bool = False, options: list[str] | None = None,
              help: str = "", placeholder: str = "", default: Any = None) -> dict[str, Any]:
    """A FieldDef dict (blueprint inputs, form fields, operation inputs)."""
    return {"key": key, "label": label, "type": type, "required": required, "options": options or [],
            "help": help, "placeholder": placeholder, "default": default}


def _step(id: str, name: str, type: str, config: dict[str, Any], *, description: str = "",
          assignee: dict[str, Any] | None = None, sla_hours: float | None = None, when: str = "",
          store_as: str = "", auto_start: bool = True) -> dict[str, Any]:
    return {"id": id, "name": name, "type": type, "description": description, "assignee": assignee or _who(),
            "sla_hours": sla_hours, "when": when, "store_as": store_as, "auto_start": auto_start, "config": config}


def _stage(id: str, name: str, color: str, steps: list[dict[str, Any]], *, description: str = "",
           parallel: bool = False) -> dict[str, Any]:
    return {"id": id, "name": name, "description": description, "color": color, "parallel": parallel, "steps": steps}


def _obj(required: list[str], /, **props: Any) -> dict[str, Any]:
    """A JSON-schema object (positional-only `required`, so a property may be called "required")."""
    return {"type": "object", "required": required, "properties": props}


_S = {"type": "string"}
_STRS = {"type": "array", "items": {"type": "string"}}

# ---------------------------------------------------------------------------
# use_case_onboarding
# ---------------------------------------------------------------------------

QUALIFICATION_SCHEMA = _obj(
    ["summary", "business_value", "complexity", "priority", "required_capabilities", "risks", "open_questions",
     "recommended_team", "recommendation"],
    summary=_S, business_value=_S,
    complexity={"type": "string", "enum": ["low", "medium", "high"]},
    priority={"type": "string", "enum": ["low", "medium", "high", "critical"]},
    required_capabilities=_STRS, risks=_STRS, open_questions=_STRS, recommended_team=_S,
    recommendation={"type": "string", "enum": ["go", "clarify", "no_go"]},
)

DEPENDENCIES_SCHEMA = _obj(
    ["required", "missing"],
    required={"type": "array", "items": _obj(
        ["name", "capability", "exists"], name=_S, purpose=_S, capability=_S, exists={"type": "boolean"},
        matched_id=_S, matched_name=_S, deploy_status=_S)},
    missing={"type": "array", "items": _obj(
        ["name", "capability"], name=_S, purpose=_S, capability=_S, data_source=_S, suggested_team=_S)},
)

# system prompt: orchestrator (JSON with the keys the request names)
QUALIFY_PROMPT = _t("""
    Qualify a new AI use case submitted to the delivery factory of a corporate & investment bank.

    Use case: {{ project.title }}
    {% if inputs.business_unit %}Business unit: {{ inputs.business_unit }}
    {% endif %}{% if sponsor %}Sponsor: {{ sponsor.name }}{% if sponsor.title %}, {{ sponsor.title }}{% endif %}
    {% endif %}{% if inputs.target_date %}Target go-live: {{ inputs.target_date }}
    {% endif %}
    Description:
    {{ project.description or "(none)" }}

    Business context and data needs:
    {{ inputs.context or "(none provided)" }}
    {% if inputs.expected_benefits %}
    Expected benefits:
    {{ inputs.expected_benefits }}
    {% endif %}
    Delivery teams:[[TEAM_SKILLS]]

    Return ONLY a JSON object with these keys:
    - "summary": 2 to 3 sentences a sponsor would sign: the problem, what the solution does, for whom.
    - "business_value": the measurable benefit, quoting the figures given above. Never invent a number.
    - "complexity": "low" | "medium" | "high" (high = several source systems without an API, or regulatory exposure).
    - "priority": "low" | "medium" | "high" | "critical" (critical only for a regulatory deadline or a material risk).
    - "required_capabilities": 3 to 6 short phrases, one per data source or action the solution must call at run time (e.g. "intraday payment flows per currency", "FX spot rates"). No generic item such as "LLM", "user interface" or "database".
    - "risks": up to 5 delivery, data or regulatory risks.
    - "open_questions": what the sponsor must clarify before the build ([] when nothing).
    - "recommended_team": the name of the best-suited team above, or "".
    - "recommendation": "go" | "clarify" | "no_go".
""")

# system prompt: notifier (Markdown body, key facts, expected action)
KICKOFF_PROMPT = _t("""
    Write the notification that use case {{ project.key }} "{{ project.title }}" entered the DOINg.AI Factory.

    Facts:
    - What it is: {{ vars.qualification.summary or (project.description | truncate_chars(400)) }}
    - AI qualification: recommendation "{{ vars.qualification.recommendation or "n/a" }}", priority {{ vars.qualification.priority or project.priority }}, complexity {{ vars.qualification.complexity or "n/a" }}.
    {% if vars.qualification.open_questions %}- Open questions for the sponsor: {{ vars.qualification.open_questions | join("; ") }}
    {% endif -%}
    - Next: an agent checks which MCP servers the use case needs against the DOINg.AI catalog, then the product manager reviews that analysis.
    Expected action: {% if vars.qualification.open_questions %}the sponsor answers the open questions.{% else %}none.{% endif %}
""")

# agent goal (system prompt: agent); the output shape is enforced by DEPENDENCIES_SCHEMA
DEPENDENCY_GOAL = _t("""
    Find which MCP servers use case {{ project.key }} "{{ project.title }}" needs, and which of them already exist in the DOINg.AI catalog.

    What the use case must do:
    {{ inputs.context or project.description }}
    {% if vars.qualification.required_capabilities %}
    Capabilities noted at qualification (merge, split or complete them):
    {% for c in vars.qualification.required_capabilities %}- {{ c }}
    {% endfor %}{% endif %}{% if feedback %}
    The product manager sent the previous analysis back. Fix this first:
    {{ feedback }}
    {% endif %}
    Method:
    1. List the 4 to 6 capabilities the solution must call at run time: one per source system or data domain.
    2. For each capability, call search_mcp_servers once with a short phrase naming the data (limit 3).
    3. A capability exists only when a returned server clearly provides that data: its tools or description cover it, not just a shared word (a score under 0.4 is almost never a match). Prefer servers in production.
    4. Otherwise it is missing: name the MCP server to build (e.g. "Nostro Balances MCP"), the source system it should wrap, and the team best placed to build it, among:[[TEAM_SKILLS]]

    Finish with ONLY this JSON:
    {"required": [{"name": "...", "purpose": "...", "capability": "...", "exists": true, "matched_id": "...", "matched_name": "...", "deploy_status": "..."}],
     "missing": [{"name": "...", "purpose": "...", "capability": "...", "data_source": "...", "suggested_team": "..."}]}
    "required" lists every capability, existing or not: "name" is the MCP server (the catalog server, or the one to build), "purpose" why the use case needs it. "missing" repeats only the missing ones. For a missing capability set exists to false and matched_id, matched_name and deploy_status to "". Copy server ids and names from the search results; never invent one.
""")

# system prompt: approval_brief (fixed headings, recommendation)
ANALYSIS_BRIEF = _t("""
    Decision requested: the product manager approves the MCP dependency analysis of use case {{ project.key }} "{{ project.title }}". Approving starts one MCP Delivery project per missing server and the use case waits until all are delivered; sending it back re-runs the analysis with the feedback.

    Capabilities already covered by the catalog:
    {% for r in vars.dependencies.required if r.exists %}- {{ r.capability or r.name }} → {{ r.matched_name or r.name }} ({{ r.deploy_status or "deploy status unknown" }})
    {% else %}- none
    {% endfor %}Missing MCP servers to build:
    {% for m in vars.dependencies.missing %}- {{ m.name }}: {{ m.capability }}{% if m.data_source %}, from {{ m.data_source }}{% endif %}{% if m.suggested_team %}, suggested team {{ m.suggested_team }}{% endif %}
    {% else %}- none (the use case can go straight to go-live readiness)
    {% endfor %}
    What the use case must do (check that nothing is forgotten):
    {{ (inputs.context or project.description) | truncate_chars(1500) }}

    Scrutinise: matches on a server still in dev or uat, matches that share only generic words, needs of the use case that no capability covers, and a missing server that duplicates one already in the catalog.
""")

# system prompt: writer (Markdown document)
READINESS_PROMPT = _t("""
    Write the go-live readiness assessment of use case {{ project.key }} "{{ project.title }}", at most 400 words.

    Facts (use only these and the project brief):
    - Use case: {{ vars.qualification.summary or project.description }}
    - MCP servers already in the catalog:
    {% for r in vars.dependencies.required if r.exists %}  - {{ r.matched_name or r.name }} ({{ r.deploy_status or "deploy status unknown" }}) for {{ r.capability }}
    {% else %}  - none
    {% endfor %}- MCP servers delivered for this use case:
    {% for c in vars.mcp_children.children %}  - {{ c.key }} {{ c.title }}: {{ c.status }}
    {% else %}  - none (nothing was missing)
    {% endfor %}{% if vars.qualification.risks %}- Risks raised at qualification: {{ vars.qualification.risks | join("; ") }}
    {% endif %}
    Use these ### headings:
    ### Scope: what goes live, for whom.
    ### MCP dependencies: a table | Capability | MCP server | Status |.
    ### Readiness checklist: one line each for data access approved, security review, monitoring and alerting, support model, user training, rollback plan. Write "Ready" only when the facts prove it, otherwise "To confirm".
    ### Residual risks and mitigations
    ### Recommendation: "Ready for go-live" or "Not ready", with the blocking items.
    [[FEEDBACK]]
""")

# system prompt: approval_brief
GOLIVE_BRIEF = _t("""
    Decision requested: the business sponsor and IT operations approve the go-live of use case {{ project.key }} "{{ project.title }}".

    Readiness assessment, reviewed by the product manager:
    {{ (vars.readiness.markdown or "(no assessment)") | truncate_chars(2500) }}

    Scrutinise every checklist item still "To confirm" and the residual risks. Give the sponsor the business-readiness view and IT operations the support, monitoring and rollback view.
""")

# system prompt: notifier
CLOSURE_PROMPT = _t("""
    Write the announcement that use case {{ project.key }} "{{ project.title }}" is live.

    Facts:
    - What is live and for whom: {{ vars.qualification.summary or project.description }}
    {% if vars.mcp_children.children %}- MCP servers delivered for it: {% for c in vars.mcp_children.children %}{{ c.title }} ({{ c.key }}){% if not loop.last %}, {% endif %}{% endfor %}
    {% endif %}{% if vars.qualification.business_value %}- Benefits to track in DOINg.AI: {{ vars.qualification.business_value }}
    {% endif -%}
    - Next: two weeks of hypercare by the delivery team, then benefits tracking in DOINg.AI.
    Thank the teams involved in one short sentence. Expected action: none.
""")

USE_CASE_ONBOARDING = {
    "id": "bp_use_case_onboarding", "key": "use_case_onboarding", "name": "Use Case Onboarding",
    "description": "From a new DOINg.AI use case to go-live: AI qualification, dependency analysis against the MCP "
                   "catalog, one MCP Delivery project per missing server, go-live approval and portfolio update.",
    "kind": "use_case", "icon": "Lightbulb", "color": "brand", "key_prefix": "UC",
    "inputs": [
        field_def("doing_ai_id", "DOINg.AI project id",
                  help="Set by the DOINg.AI watcher; lets the go-live step update the portfolio."),
        field_def("context", "Business context & data needs", "markdown", required=True,
                  help="What the solution must read or do, system by system: the dependency analysis starts here."),
        field_def("business_unit", "Business unit"),
        field_def("target_date", "Target go-live", "date"),
        field_def("expected_benefits", "Expected benefits", "textarea"),
    ],
    "stages": [
        _stage("intake", "Intake & Qualification", "sky", [
            _step("qualify", "Qualify the use case", "ai_task", {
                "prompt": QUALIFY_PROMPT, "system_prompt": "orchestrator", "output": "json",
                "json_schema": QUALIFICATION_SCHEMA, "artifact_title": "Qualification", "include_context": False,
            }, store_as="qualification",
                description="AI reads the use case and returns value, complexity, priority, the capabilities it needs and open questions."),
            _step("kickoff", "Kick-off message", "notify", {
                "audience": [{"project_role": "sponsor"}, {"project_role": "owner"}, {"role": "product_manager"}],
                "subject": "{{ project.key }} · {{ project.title }} entered the Factory",
                "prompt": KICKOFF_PROMPT, "channel": "in_app",
            }, store_as="kickoff", description="Tells the sponsor and the product managers the use case is in flight."),
        ], description="Understand the request and tell the people who own it."),
        _stage("dependencies", "Dependency Analysis", "violet", [
            _step("dependency_analysis", "Analyse MCP dependencies", "agent_task", {
                "goal": DEPENDENCY_GOAL, "connector_ids": [], "allowed_tools": PORTFOLIO_AGENT_TOOLS,
                "max_actions": 10, "output_schema": DEPENDENCIES_SCHEMA, "artifact_title": "Dependency analysis",
                "include_context": False,
            }, store_as="dependencies",
                description="An agent maps the capabilities the use case needs and searches the DOINg.AI MCP catalog for each."),
            _step("analysis_review", "Review the dependency analysis", "approval", {
                "approvers": [{"role": "product_manager", "label": "Product manager"}], "policy": "any",
                "on_reject": {"action": "reopen", "goto_step": "dependency_analysis"},
                "brief_prompt": ANALYSIS_BRIEF, "show_vars": ["dependencies", "qualification"],
            }, assignee=_who("product_manager", project_role="owner"), sla_hours=24,
                description="The product manager confirms what exists and what must be built; a rejection re-runs the agent with the feedback."),
        ], description="What the use case needs, what the catalog already has."),
        _stage("delivery", "MCP Delivery", "brand", [
            _step("deliver_mcps", "Deliver the missing MCP servers", "fan_out", {
                "items": "vars.dependencies.missing", "blueprint_key": "mcp_delivery",
                "title": "{{ item.name or item.capability }}",
                "inputs": {"mcp_name": "{{ item.name or item.capability }}", "purpose": "{{ item.purpose or item.capability }}",
                           "capability": "{{ item.capability }}", "data_source": "{{ item.data_source or '' }}",
                           "suggested_team": "{{ item.suggested_team or '' }}",
                           "parent_use_case": "{{ project.key }} — {{ project.title }}"},
                "wait": "all", "inherit": ["sponsor", "owner", "priority"],
            }, when="vars.dependencies.missing | length > 0", store_as="mcp_children",
                assignee=_who(project_role="owner"),
                description="One MCP Delivery project per missing server; this project waits until all are delivered. Skipped when nothing is missing."),
        ], description="Build what the catalog lacks."),
        _stage("golive", "Go-live", "emerald", [
            _step("readiness", "Go-live readiness", "ai_task", {
                "prompt": READINESS_PROMPT, "system_prompt": "writer", "output": "markdown",
                "artifact_title": "Go-live readiness", "review": True,
            }, store_as="readiness", assignee=_who("product_manager", project_role="owner"), sla_hours=24,
                description="AI drafts the readiness assessment; the product manager reviews it."),
            _step("golive_approval", "Go-live approval", "approval", {
                "approvers": [{"role": "sponsor", "label": "Business sponsor"}, {"role": "it_ops", "label": "IT operations"}],
                "policy": "all", "on_reject": {"action": "reopen", "goto_step": "readiness"},
                "brief_prompt": GOLIVE_BRIEF, "show_vars": ["readiness", "mcp_children", "dependencies"],
            }, assignee=_who("sponsor", "it_ops"), sla_hours=48),
            _step("portfolio_update", "Mark live in DOINg.AI", "mcp_operation", {
                "operation_key": "portfolio.update_status",
                "input": {"project_id": "{{ inputs.doing_ai_id }}", "status": "Done", "dev_status": "prod",
                          "note": "Live in production: go-live approved in DOINg.AI Factory ({{ project.key }})."},
            }, when="inputs.doing_ai_id", store_as="portfolio_update",
                description="Sets the DOINg.AI use case to Done / prod, as for every delivered use case. Skipped when the project did not come from DOINg.AI."),
            _step("closure", "Go-live announcement", "notify", {
                "audience": [{"project_role": "sponsor"}, {"project_role": "owner"}, {"project_role": "team"},
                             {"role": "it_ops"}],
                "subject": "{{ project.key }} · {{ project.title }} is live",
                "prompt": CLOSURE_PROMPT, "channel": "in_app",
            }, store_as="closure"),
        ], description="Prove readiness, approve, go live."),
    ],
}

# ---------------------------------------------------------------------------
# mcp_delivery
# ---------------------------------------------------------------------------

ROUTING_SCHEMA = _obj(["team_id", "team_name", "jira_project_key", "rationale"],
                      team_id=_S, team_name=_S, jira_project_key=_S, rationale=_S)

BACKLOG_SCHEMA = _obj(["issues"], issues={"type": "array", "minItems": 1, "items": _obj(
    ["project_key", "summary", "description", "issue_type", "parent_key", "story_points", "labels"],
    project_key=_S, summary={"type": "string", "maxLength": 255}, description=_S,
    issue_type={"type": "string", "enum": ["Story", "Task"]}, parent_key=_S,
    story_points={"type": "number"}, labels=_STRS)})

# human_form AI draft: one value per form field
SPEC_PREFILL = _t("""
    Draft the specification form of a new MCP server for a corporate & investment bank.

    Server: {{ inputs.mcp_name }}
    Purpose: {{ inputs.purpose or "(not given)" }}
    {% if inputs.capability %}Capability to expose: {{ inputs.capability }}
    {% endif %}{% if inputs.data_source %}Source system: {{ inputs.data_source }}
    {% endif %}{% if inputs.parent_use_case %}Requested by use case: {{ inputs.parent_use_case }}
    {% endif %}{% if parent and parent.inputs.context %}Use case context:
    {{ parent.inputs.context | truncate_chars(1200) }}
    {% endif %}
    Field by field:
    - summary: purpose and scope in 3 to 5 sentences; end with what is out of scope.
    - tools: a list of 3 to 6 strings "tool_name — what it returns", snake_case names, read-only unless a write is essential.
    - data_source: the source system and how it is reached (REST API, database view, file drop).
    - data_classification: one of "Public", "Internal", "Confidential", "Strictly confidential".
    - contains_pii: true when any tool returns data about natural persons, else false.
    - auth_model: one of "Service account (read-only)", "On-behalf-of user (OAuth)", "API key from the vault", "Mutual TLS"; prefer the read-only service account.
    - consumers: the agents or applications of the use case that will call it.
    - nfr: expected volumes, latency, data freshness and availability.
    - acceptance_criteria: 4 to 6 testable criteria, one per line.
    - target_date: leave empty.
    Add "(assumption)" after every statement the facts above do not support, so the business user can check it.
    [[FEEDBACK]]
""")

# system prompt: orchestrator
ROUTING_PROMPT = _t("""
    Choose the team that will build MCP server "{{ inputs.mcp_name }}".

    Purpose: {{ (vars.spec.summary or inputs.purpose) | truncate_chars(600) }}
    Source system: {{ vars.spec.data_source or inputs.data_source or "unknown" }}
    Tools: [[TOOLS_INLINE]]
    {% if inputs.suggested_team %}Suggested by the dependency analysis: {{ inputs.suggested_team }}
    {% endif %}
    Teams (choose from this list only):[[TEAM_ROUTES]]

    The team that owns or knows the source system beats a generic integration team; follow the suggestion only when its skills fit. Copy team_id, name and jira_project_key exactly from the list. When no team is configured, return empty strings and say so in the rationale.
    Return ONLY JSON: {"team_id": "...", "team_name": "...", "jira_project_key": "...", "rationale": "one sentence"}
""")

# system prompt: approval_brief
SPEC_SIGNOFF_BRIEF = _t("""
    Decision requested: the business sponsor and the dev lead sign off the specification of MCP server "{{ inputs.mcp_name }}" ({{ project.key }}) before the build is planned.

    Specification:
    - Scope: {{ (vars.spec.summary or inputs.purpose) | truncate_chars(800) }}
    - Tools: [[TOOLS_INLINE]]
    - Source system: {{ vars.spec.data_source or "not set" }} · classification: {{ vars.spec.data_classification or "not set" }} · personal data: {{ "yes" if vars.spec.contains_pii else "no" }} · authentication: {{ vars.spec.auth_model or "not set" }}
    - Consumers: {{ vars.spec.consumers or "not set" }}
    - Non-functional requirements: {{ vars.spec.nfr or "not set" }}
    - Acceptance criteria: {{ (vars.spec.acceptance_criteria or "not set") | truncate_chars(800) }}
    - Delivery team: {{ vars.routing.team_name or "(not routed)" }}{% if vars.routing.rationale %} ({{ vars.routing.rationale }}){% endif %}
    - Jira epic: {{ vars.epic.key or "(none)" }}{% if vars.epic.created is sameas false %} (an existing epic was reused){% endif %}

    Scrutinise: write tools without a justification, missing non-functional requirements, acceptance criteria that cannot be tested, personal data without masking, a team that does not own the source system.
""")

# estimation AI suggestion (system prompt: estimator)
ESTIMATE_PROMPT = _t("""
    Estimate the build of MCP server "{{ inputs.mcp_name }}" in person-days for {{ vars.routing.team_name or "the delivery team" }}.

    Tools:[[TOOLS]]
    Source system: {{ vars.spec.data_source or inputs.data_source or "unknown" }} · authentication: {{ vars.spec.auth_model or "not set" }} · classification: {{ vars.spec.data_classification or "not set" }}
    Non-functional requirements: {{ vars.spec.nfr or "not specified" }}

    Break the work down into: source connectivity and authentication, each tool, automated tests, security hardening and compliance evidence, deployment and monitoring. Size each line from the work it implies (a read-only tool over an existing API is usually 1 to 2 days). Use confidence "low" while access to the source system is not established.
""")

# system prompt: jira_writer (the request gives the shape: project and epic on every story)
BACKLOG_PROMPT = _t("""
    {% set jira_project = vars.routing.jira_project_key or vars.epic.project_key -%}
    Write the Jira stories that build MCP server "{{ inputs.mcp_name }}" under epic {{ vars.epic.key }} in Jira project {{ jira_project }}.

    Scope: {{ (vars.spec.summary or inputs.purpose) | truncate_chars(1200) }}
    Tools:[[TOOLS]]
    Acceptance criteria:
    {{ (vars.spec.acceptance_criteria or "(none given)") | truncate_chars(800) }}
    {% if vars.estimate.value %}Estimate: {{ vars.estimate.value }} {{ vars.estimate.unit or "days" }}{% for line in vars.estimate.breakdown %}; {{ line.item }}: {{ line.value }}{% endfor %}
    {% endif %}
    Write 4 to 8 stories: one per tool, plus source connectivity and authentication, automated tests, and deployment with monitoring and audit logging.
    - summary: imperative, at most 80 characters, e.g. "Implement get_nostro_balances tool".
    - description: "### Context" with one sentence "As an agent developer, I want …, so that …", then "### Acceptance criteria" with 2 to 4 "- [ ] …" items.
    - story_points: 1, 2, 3, 5 or 8, in line with the estimate.
    - labels: ["mcp"] plus one functional label.
    Every story has project_key "{{ jira_project }}", issue_type "Story" and parent_key "{{ vars.epic.key }}". Return ONLY:
    {"issues": [{"project_key": "{{ jira_project }}", "summary": "...", "description": "...", "issue_type": "Story", "parent_key": "{{ vars.epic.key }}", "story_points": 3, "labels": ["mcp", "..."]}]}
    [[FEEDBACK]]
""")

# system prompt: test_designer (its headings: scope, test cases table, coverage, entry & exit criteria)
TEST_PLAN_PROMPT = _t("""
    Design the test set of MCP server "{{ inputs.mcp_name }}".

    Tools:[[TOOLS]]
    Acceptance criteria:
    {{ vars.spec.acceptance_criteria or "(none given: name it as a gap under Coverage)" }}
    Data: {{ vars.spec.data_classification or "classification not set" }}{% if vars.spec.contains_pii %}, returns personal data{% endif %} · authentication: {{ vars.spec.auth_model or "not set" }}
    Non-functional requirements: {{ vars.spec.nfr or "(not specified: name it as a gap)" }}

    The test cases must include:
    - functional: a nominal and an edge case for every tool;
    - negative: missing or invalid arguments, unknown ids, source system unavailable (the tool returns an isError result with an actionable message, never a stack trace);
    - security: unauthenticated call refused, least privilege of the service account, injection attempts in string arguments{% if vars.spec.contains_pii %}, personal data masked for callers not entitled to it{% endif %};
    - integration: tool names, JSON schemas and readOnly/destructive annotations match the specification;
    - performance: the latency and volume targets of the requirements.
    Under Coverage, map every acceptance criterion to the IDs of the tests that prove it.
""")

# human_form AI draft
TEST_REPORT_PREFILL = _t("""
    Prepare the skeleton of the test report of MCP server "{{ inputs.mcp_name }}" from its test plan, for the developer to complete.

    Test plan:
    {{ (vars.test_plan.markdown or "(no test plan)") | truncate_chars(3000) }}
    {% if vars.gate.failed %}Quality-gate findings to verify: {{ vars.gate.failed | join(", ") }}
    {% endif %}
    Fill only "report": one line per test section of the plan with "Result: TO FILL", then a "Defects: TO FILL" line. Leave tests_total, tests_passed, open_defects, evidence_url and ready_for_release empty: results come from the actual test run, never from the plan.
""")

# system prompt: writer
RELEASE_NOTES_PROMPT = _t("""
    Write the production release notes of MCP server "{{ inputs.mcp_name }}" v1.0, at most 300 words.

    Facts (use only these; write "TBD" for anything they do not give):
    - Purpose: {{ (vars.spec.summary or inputs.purpose) | truncate_chars(800) }}
    - Tools: [[TOOLS_INLINE]]
    - Source system: {{ vars.spec.data_source or "TBD" }} · classification: {{ vars.spec.data_classification or "TBD" }}{% if vars.spec.contains_pii %} (personal data){% endif %} · authentication: {{ vars.spec.auth_model or "TBD" }}
    - Owner team: {{ vars.routing.team_name or "TBD" }} · Jira epic: {{ vars.epic.key or "TBD" }} {{ vars.epic.url or "" }}
    - Quality gate: [[GATE]]
    - Tests: [[TESTS]] passed; open defects: {{ vars.test_report.open_defects or 0 }}
    {% if vars.test_report.evidence_url %}- Evidence: {{ vars.test_report.evidence_url }}
    {% endif %}
    Use these ### headings: Summary, Tools, Data & security, Quality, Operations (owner, support, monitoring, rollback), Links.
""")

# system prompt: approval_brief
RELEASE_BRIEF = _t("""
    Decision requested: IT operations, the business sponsor and security approve the production release of MCP server "{{ inputs.mcp_name }}" ({{ project.key }}). A rejection sends the server back to the quality stage.

    Facts:
    - Quality gate: [[GATE]]
    - Tests: [[TESTS]] passed, {{ vars.test_report.open_defects or 0 }} open defects{% if vars.test_report.ready_for_release %}; the team declares it ready for release{% else %}; the team has NOT declared it ready{% endif %}
    - Change: {{ vars.change.key or "(none)" }}
    - Data: {{ vars.spec.data_classification or "classification not set" }}{% if vars.spec.contains_pii %}, personal data{% endif %} · authentication: {{ vars.spec.auth_model or "not set" }}
    - Owner team: {{ vars.routing.team_name or "(not set)" }}
    Release notes:
    {{ (vars.release_notes.markdown or "(none)") | truncate_chars(1500) }}

    Give each approver what they need: IT operations the rollback, monitoring and support; the sponsor the business readiness; security the authentication, data exposure and gate findings.
""")

# system prompt: notifier
DELIVERED_PROMPT = _t("""
    Write the announcement that MCP server "{{ inputs.mcp_name }}" ({{ project.key }}) is in production.

    Facts:
    - What it gives access to: {{ (vars.spec.summary or inputs.purpose) | truncate_chars(300) }}
    - Tools: [[TOOLS_INLINE]]
    - Owner team: {{ vars.routing.team_name or "(not set)" }} · production change: {{ vars.change.key or "(none)" }}
    - Registered in the DOINg.AI MCP catalog{% if vars.registration.server.id %} as {{ vars.registration.server.id }}{% endif %}.
    {% if inputs.parent_use_case %}- Use case {{ inputs.parent_use_case }} can now rely on it; it moves on once all its missing servers are delivered.
    {% endif -%}
    Expected action: none.
""")

_JIRA_LINK = {"kind": "jira", "label": "{{ output.key }} · {{ output.summary or 'Jira' }}",
              "url": "{{ output.url }}", "external_id": "{{ output.key }}"}

MCP_DELIVERY = {
    "id": "bp_mcp_delivery", "key": "mcp_delivery", "name": "MCP Delivery",
    "description": "Delivers one MCP server end to end: specification, Jira epic and stories in the right team, "
                   "estimation, test design, IT-compliance quality gate, production change, multi-party release "
                   "approval and registration in the DOINg.AI catalog.",
    "kind": "mcp_delivery", "icon": "ServerCog", "color": "violet", "key_prefix": "MCP",
    "inputs": [
        field_def("mcp_name", "MCP server name", required=True, placeholder="e.g. Nostro Balances MCP"),
        field_def("purpose", "Purpose", "textarea", required=True, help="Why it is needed and by whom."),
        field_def("capability", "Capability to expose", placeholder="e.g. nostro account balances"),
        field_def("data_source", "Source system", placeholder="e.g. Treasury data warehouse (Oracle)"),
        field_def("suggested_team", "Suggested team"),
        field_def("parent_use_case", "Requested by (use case)"),
    ],
    "stages": [
        _stage("specification", "Specification", "sky", [
            _step("spec", "Specify the MCP server", "human_form", {
                "fields": [
                    field_def("summary", "Purpose & scope", "markdown", required=True,
                              help="What the server does, for which consumers, and what is out of scope."),
                    field_def("tools", "Tools to expose", "list", required=True,
                              help="One per line: tool_name — what it returns. Prefer read-only tools; justify any write."),
                    field_def("data_source", "Source system", required=True, placeholder="e.g. Loan IQ (Oracle), REST API v2"),
                    field_def("data_classification", "Data classification", "select", required=True,
                              options=["Public", "Internal", "Confidential", "Strictly confidential"]),
                    field_def("contains_pii", "Returns personal data (PII)", "checkbox", default=False),
                    field_def("auth_model", "Authentication", "select", required=True,
                              options=["Service account (read-only)", "On-behalf-of user (OAuth)",
                                       "API key from the vault", "Mutual TLS"]),
                    field_def("consumers", "Consumers", "textarea", help="Agents or applications that will call it."),
                    field_def("nfr", "Non-functional requirements", "textarea",
                              placeholder="Volumes, latency, data freshness, availability"),
                    field_def("acceptance_criteria", "Acceptance criteria", "textarea", required=True,
                              help="One testable criterion per line."),
                    field_def("target_date", "Target production date", "date"),
                ],
                "instructions": "Complete the specification with the business user. Start from the AI draft, correct it, "
                                "then submit: the sponsor and the dev lead sign off exactly this text.",
                "ai_prefill": SPEC_PREFILL, "artifact_title": "MCP specification",
            }, store_as="spec", assignee=_who("product_manager", project_role="owner"), sla_hours=48),
            _step("team_routing", "Route to a delivery team", "ai_task", {
                "prompt": ROUTING_PROMPT, "system_prompt": "orchestrator", "output": "json",
                "json_schema": ROUTING_SCHEMA, "artifact_title": "Team routing", "include_context": False,
            }, store_as="routing", description="AI picks the team (and so the Jira project) that owns the source system."),
            _step("jira_epic", "Find or create the Jira epic", "mcp_operation", {
                "operation_key": "jira.ensure_epic",
                "input": {"project_key": "{{ vars.routing.jira_project_key }}",
                          "summary": "MCP — {{ inputs.mcp_name }}", "search_text": "{{ inputs.mcp_name }}",
                          "description": "{{ (vars.spec.summary or inputs.purpose) }}\n\n"
                                         "Requested by: {{ inputs.parent_use_case or 'direct request' }}\n"
                                         "Factory project: {{ project.key }}",
                          "labels": ["mcp", "doing-factory"]},
                "create_link": {"kind": "jira", "label": "Epic {{ output.key }}", "url": "{{ output.url }}",
                                "external_id": "{{ output.key }}"},
            }, store_as="epic",
                description="Reuses an open epic for this server in the team's Jira project, or creates it."),
            _step("spec_signoff", "Specification sign-off", "approval", {
                "approvers": [{"role": "sponsor", "label": "Business sponsor"}, {"role": "dev_lead", "label": "Dev lead"}],
                "policy": "all", "on_reject": {"action": "reopen", "goto_step": "spec"},
                "brief_prompt": SPEC_SIGNOFF_BRIEF, "show_vars": ["spec", "routing", "epic"],
            }, assignee=_who("sponsor", "dev_lead"), sla_hours=48),
        ], description="Agree what to build and who builds it."),
        _stage("planning", "Planning", "amber", [
            _step("estimate", "Estimate the build", "estimation", {
                "unit": "days", "ai_suggest": True, "prompt": ESTIMATE_PROMPT, "require_breakdown": True,
            }, store_as="estimate", assignee=_who("dev_lead", project_role="team_lead"), sla_hours=24),
            _step("jira_backlog", "Write the Jira stories", "ai_task", {
                "prompt": BACKLOG_PROMPT, "system_prompt": "jira_writer", "output": "json",
                "json_schema": BACKLOG_SCHEMA, "artifact_title": "Jira backlog", "review": True,
                "include_context": False,
            }, store_as="jira_backlog", assignee=_who("dev_lead", project_role="team_lead"), sla_hours=24,
                description="AI writes the stories; the dev lead reviews them before anything reaches Jira."),
            _step("create_stories", "Create the stories in Jira", "mcp_operation", {
                "operation_key": "jira.create_stories", "input": {"issues": "{{ vars.jira_backlog.issues }}"},
            }, store_as="jira_stories"),
        ], description="Size the work and put it in the team's backlog."),
        _stage("build", "Build & Test", "violet", [
            _step("test_plan", "Design the test sets", "ai_task", {
                "prompt": TEST_PLAN_PROMPT, "system_prompt": "test_designer", "output": "markdown",
                "artifact_title": "Test plan", "include_context": False,
            }, store_as="test_plan"),
            _step("development", "Development", "wait_for", {
                "operation_key": "jira.get_issue", "input": {"issue_key": "{{ vars.epic.key }}"},
                "until": "output.status == 'Done'", "poll_minutes": 15, "timeout_hours": 0, "manual_complete": True,
            }, store_as="development", assignee=_who("developer", project_role="team"), sla_hours=240,
                description="The team builds in Jira. Completes when the epic is Done (checked every 15 minutes) or when a developer marks it complete."),
        ], description="Build in Jira while the tests are designed.", parallel=True),
        _stage("quality", "Quality & Compliance", "rose", [
            _step("compliance_gate", "IT-compliance quality gate", "quality_gate", {
                "rule_tags": ["mcp"], "rule_ids": [],
                "evidence": ["spec", "routing", "estimate", "jira_backlog", "test_plan"],
                "block_on": "high", "override_roles": ["compliance", "security", "admin"],
            }, store_as="gate", assignee=_who("compliance"), sla_hours=24,
                description="AI checks the evidence against every rule tagged 'mcp'; manual rules wait for compliance."),
            _step("test_report", "Test report", "human_form", {
                "fields": [
                    field_def("tests_total", "Tests executed", "number", required=True),
                    field_def("tests_passed", "Tests passed", "number", required=True),
                    field_def("open_defects", "Open defects", "number", default=0),
                    field_def("report", "Test summary", "markdown", required=True,
                              help="Results per section of the test plan; link failures to their Jira bugs."),
                    field_def("evidence_url", "Evidence link", "url", help="CI run, test report or recording."),
                    field_def("ready_for_release", "The team considers the server ready for release", "checkbox", default=False),
                ],
                "instructions": "Record the results of the test plan as executed. Numbers come from the test run, not from the plan.",
                "ai_prefill": TEST_REPORT_PREFILL, "artifact_title": "Test report",
            }, store_as="test_report", assignee=_who("developer", "dev_lead", project_role="team"), sla_hours=48),
        ], description="Prove it is compliant and tested."),
        _stage("release", "Release", "emerald", [
            _step("release_notes", "Release notes", "ai_task", {
                "prompt": RELEASE_NOTES_PROMPT, "system_prompt": "writer", "output": "markdown",
                "artifact_title": "Release notes", "include_context": False,
            }, store_as="release_notes"),
            _step("change_ticket", "Raise the production change", "mcp_operation", {
                "operation_key": "jira.create_change",
                "input": {"summary": "Production release — {{ inputs.mcp_name }} v1.0",
                          "description": "{{ vars.release_notes.markdown }}\n\nDelivery epic: {{ vars.epic.key }} · "
                                         "Factory project: {{ project.key }}",
                          "priority": "{{ 'High' if project.priority in ['high', 'critical'] else 'Medium' }}",
                          "labels": ["mcp", "release", "doing-factory"]},
                "create_link": _JIRA_LINK,
            }, store_as="change"),
            _step("release_approval", "Release approval", "approval", {
                "approvers": [{"role": "it_ops", "label": "IT operations"}, {"role": "sponsor", "label": "Business sponsor"},
                              {"role": "security", "label": "Security"}],
                "policy": "all", "on_reject": {"action": "reopen", "goto_step": "compliance_gate"},
                "brief_prompt": RELEASE_BRIEF, "show_vars": ["gate", "test_report", "change", "release_notes"],
            }, assignee=_who("it_ops", "sponsor", "security"), sla_hours=24,
                description="A rejection sends the server back to the quality stage: re-check, re-test, new change."),
            _step("register_mcp", "Register in the DOINg.AI catalog", "mcp_operation", {
                "operation_key": "portfolio.register_mcp",
                "input": {"name": "{{ inputs.mcp_name }}",
                          "description": "{{ (vars.spec.summary or inputs.purpose) | truncate_chars(600) }}",
                          "tools": "{{ vars.spec.tools }}", "tags": ["factory-delivered", "{{ project.key | lower }}"],
                          "team_it": "{{ vars.routing.team_name }}", "deploy_status": "production",
                          "use_case": "{{ inputs.parent_use_case or inputs.purpose }}",
                          "data_source": "{{ vars.spec.data_source or inputs.data_source }}"},
                "create_link": {"kind": "mcp", "label": "{{ output.server.name }} · DOINg.AI catalog", "url": "",
                                "external_id": "{{ output.server.id }}"},
            }, store_as="registration"),
            _step("delivered", "Delivery announcement", "notify", {
                "audience": [{"project_role": "sponsor"}, {"project_role": "owner"}, {"project_role": "team"},
                             {"role": "product_manager"}],
                "subject": "{{ inputs.mcp_name }} is in production ({{ project.key }})",
                "prompt": DELIVERED_PROMPT, "channel": "in_app",
            }, store_as="delivered"),
        ], description="Change, approve, register, announce."),
    ],
}

# ---------------------------------------------------------------------------
# change_request
# ---------------------------------------------------------------------------

IMPACT_SCHEMA = _obj(
    ["summary", "risk_level", "impacted_systems", "downtime_minutes", "rollback_plan", "test_strategy",
     "conditions", "recommendation"],
    summary=_S, risk_level={"type": "string", "enum": ["low", "medium", "high"]}, impacted_systems=_STRS,
    downtime_minutes={"type": "number"}, rollback_plan=_S, test_strategy=_S, conditions=_STRS,
    recommendation={"type": "string", "enum": ["approve", "approve_with_conditions", "reject"]},
)

# system prompt: orchestrator
IMPACT_PROMPT = _t("""
    Assess the impact of a change request in the IT estate of a bank.

    System: {{ inputs.system }} ({{ inputs.environment or "Production" }})
    Change: {{ inputs.change_summary or project.description }}
    {% if inputs.reason %}Reason: {{ inputs.reason }}
    {% endif %}{% if inputs.requested_date %}Requested date: {{ inputs.requested_date }}
    {% endif %}Downtime expected by the requester: {{ "yes" if inputs.downtime_expected else "no" }}

    Return ONLY a JSON object:
    - "summary": 2 sentences on what changes and why.
    - "risk_level": "low" | "medium" | "high" (high = production and customer-facing, or no tested rollback).
    - "impacted_systems": systems and interfaces affected, including downstream consumers.
    - "downtime_minutes": expected service interruption (0 when none).
    - "rollback_plan": how to revert and how long it takes.
    - "test_strategy": the tests to run before and after the change.
    - "conditions": conditions an approver should attach ([] when none).
    - "recommendation": "approve" | "approve_with_conditions" | "reject".
    Do not invent facts about the system: when something is unknown, say so and raise the risk level.
    [[FEEDBACK]]
""")

# system prompt: approval_brief
CAB_BRIEF = _t("""
    Decision requested: the change manager and the technical owner approve change {{ project.key }} "{{ project.title }}" on {{ inputs.system }} ({{ inputs.environment or "Production" }}){% if inputs.requested_date %}, planned for {{ inputs.requested_date }}{% endif %}.

    Impact analysis: risk {{ vars.impact.risk_level or "unknown" }}; downtime {{ vars.impact.downtime_minutes if vars.impact.downtime_minutes is number else "unknown" }} min; impacted: {{ vars.impact.impacted_systems | join(", ") if vars.impact.impacted_systems else "not assessed" }}; analyst recommendation: {{ vars.impact.recommendation or "none" }}.
    Rollback plan: {{ vars.impact.rollback_plan or "not given" }}
    Test strategy: {{ vars.impact.test_strategy or "not given" }}
    {% if vars.impact.conditions %}Suggested conditions: {{ vars.impact.conditions | join("; ") }}
    {% endif %}
    Judge whether the rollback plan and the test strategy match the risk, and list the conditions worth attaching.
""")

# static notification body (no LLM)
CR_BODY = _t("""
    The change "{{ project.title }}" on {{ inputs.system }} ({{ inputs.environment or "Production" }}) was approved by the change advisory board.
    Risk: {{ vars.impact.risk_level or "n/a" }} · expected downtime: {{ vars.impact.downtime_minutes if vars.impact.downtime_minutes is number else "n/a" }} min{% if inputs.requested_date %} · planned for {{ inputs.requested_date }}{% endif %}.
    {% if vars.impact.conditions %}Conditions:
    {% for c in vars.impact.conditions %}- {{ c }}
    {% endfor %}{% endif -%}
    Rollback: {{ vars.impact.rollback_plan or "see the impact analysis" }}
""")

CHANGE_REQUEST = {
    "id": "bp_change_request", "key": "change_request", "name": "Change Request",
    "description": "A change to a production system: AI impact analysis, change advisory approval, announcement.",
    "kind": "change", "icon": "GitPullRequestArrow", "color": "amber", "key_prefix": "CR",
    "inputs": [
        field_def("system", "System / application", required=True),
        field_def("change_summary", "What changes", "textarea", required=True),
        field_def("reason", "Business reason", "textarea"),
        field_def("environment", "Environment", "select", options=["Production", "UAT", "Development"], default="Production"),
        field_def("requested_date", "Requested date", "date"),
        field_def("downtime_expected", "Downtime expected", "checkbox", default=False),
    ],
    "stages": [
        _stage("assessment", "Impact Analysis", "sky", [
            _step("impact_analysis", "Analyse the impact", "ai_task", {
                "prompt": IMPACT_PROMPT, "system_prompt": "orchestrator", "output": "json",
                "json_schema": IMPACT_SCHEMA, "artifact_title": "Impact analysis", "include_context": False,
            }, store_as="impact"),
        ], description="Risk, downtime, rollback."),
        _stage("decision", "Approval & Communication", "emerald", [
            _step("cab_approval", "Change advisory approval", "approval", {
                "approvers": [{"role": "it_ops", "label": "Change manager"}, {"role": "dev_lead", "label": "Technical owner"}],
                "policy": "all", "on_reject": {"action": "reopen", "goto_step": "impact_analysis"},
                "brief_prompt": CAB_BRIEF, "show_vars": ["impact"],
            }, assignee=_who("it_ops", "dev_lead"), sla_hours=24),
            _step("announce", "Announce the change", "notify", {
                "audience": [{"project_role": "owner"}, {"project_role": "sponsor"}, {"role": "it_ops"}],
                "subject": "Change {{ project.key }} approved — {{ inputs.system }}", "body": CR_BODY,
                "channel": "in_app",
            }, store_as="announcement", description="A fixed message (no LLM)."),
        ], description="Decide and tell the people concerned."),
    ],
}

BUILTIN_BLUEPRINTS: list[dict[str, Any]] = [USE_CASE_ONBOARDING, MCP_DELIVERY, CHANGE_REQUEST]


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------

def seed_defaults(container: Any) -> dict[str, Any]:
    """Insert what is missing — roles (if no role list exists), rules (by code), builtin
    blueprints (by key) — and touch nothing else. Idempotent; returns what was added."""
    store = container.store
    added: dict[str, Any] = {"roles": False, "rules": 0, "blueprints": 0}
    if store.get("roles", "singleton") is None:
        store.put_singleton("roles", {"roles": [dict(r) for r in ROLES]})
        added["roles"] = True

    codes = {r.get("code") for r in store.list("rules")}
    for rule in RULES:
        if rule["code"] not in codes:
            store.put("rules", Rule.model_validate({**rule, "id": new_id("rule")}).model_dump())
            added["rules"] += 1

    keys = {b.get("key") for b in store.list("blueprints")}
    for blueprint in BUILTIN_BLUEPRINTS:
        if blueprint["key"] in keys:
            continue
        # The stable id may belong to the user's copy whose key they changed: never overwrite it.
        bid = blueprint["id"] if store.get("blueprints", blueprint["id"]) is None else new_id("bp")
        stamp = now_iso()
        doc = Blueprint.model_validate({**blueprint, "id": bid, "status": "active", "builtin": True,
                                        "created_at": stamp, "updated_at": stamp}).model_dump()
        store.put("blueprints", doc)
        added["blueprints"] += 1
    return added
