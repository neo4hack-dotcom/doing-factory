"""DOINg.AI Factory — data contract.

Every persisted document and every API payload is described here. `frontend/src/types.ts`
mirrors this file by hand, field for field (snake_case kept verbatim). Change both together,
and update docs/SPEC.md §3 when a Literal union changes.

All fields have defaults so that a partial dict (old document, LLM output, UI draft) still
validates; required-ness of user input is enforced in the API/engine layer, not here.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Model(BaseModel):
    # extra="ignore": tolerate fields written by a newer version / an LLM, never crash on them.
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


# ---------------------------------------------------------------------------
# Literal unions (closed vocabularies)
# ---------------------------------------------------------------------------

LLMProviderKind = Literal["ollama", "openai"]
ToolMode = Literal["auto", "native", "json"]
Autonomy = Literal["supervised", "approve_writes", "full"]
AutonomyOverride = Literal["", "supervised", "approve_writes", "full"]
ConnectorKind = Literal["portfolio", "jira", "notification", "git", "docs", "other"]
Transport = Literal["stdio", "http", "sse"]
FieldType = Literal[
    "text", "textarea", "markdown", "number", "select", "multiselect", "date",
    "user", "users", "team", "checkbox", "list", "url",
]
OperationMode = Literal["direct", "llm", "agent"]
StepType = Literal[
    "ai_task", "human_form", "approval", "estimation", "mcp_operation",
    "agent_task", "quality_gate", "fan_out", "notify", "wait_for",
]
ProjectRole = Literal["", "sponsor", "owner", "team_lead", "team"]
BlueprintStatus = Literal["active", "draft", "archived"]
ProjectStatus = Literal["active", "waiting", "blocked", "done", "cancelled", "failed"]
StepStatus = Literal[
    "pending", "running", "waiting_human", "waiting_approval", "waiting_children",
    "waiting_external", "done", "skipped", "failed", "rejected",
]
StageStatus = Literal["pending", "active", "done", "skipped"]
Priority = Literal["low", "medium", "high", "critical"]
Severity = Literal["low", "medium", "high", "critical"]
CheckStatus = Literal["pass", "fail", "warn", "na", "pending"]
TraceKind = Literal["info", "thought", "tool", "result", "error", "human", "ai"]
PendingKind = Literal["confirm_operation", "agent_tool_call", "gate_review", "ai_review"]
ArtifactKind = Literal["markdown", "json"]
LinkKind = Literal["jira", "mcp", "url", "doc"]
RiskLevel = Literal["low", "medium", "high"]
SourceType = Literal["manual", "watcher", "fan_out", "copilot", "api"]
WatcherAction = Literal["intake", "auto_start"]
IntakeStatus = Literal["new", "accepted", "dismissed"]
NotificationKind = Literal["task", "approval", "info", "warning", "success", "mention"]
RuleCategory = Literal["Security", "Data", "Operations", "Architecture", "Legal", "Quality"]
RuleCheck = Literal["ai", "manual"]
InboxKind = Literal[
    "form", "approval", "estimate", "review", "confirm", "gate", "failure", "start", "external", "intake",
]
RewriteStyle = Literal[
    "professional", "concise", "executive", "technical", "friendly", "fix", "expand", "bullets", "jira",
]
ReportAudience = Literal["sponsor", "team", "executive"]


# ---------------------------------------------------------------------------
# Settings (singleton document)
# ---------------------------------------------------------------------------

class LLMSettings(Model):
    provider: LLMProviderKind = "ollama"
    base_url: str = ""          # "" = not configured → every LLM call fails with an actionable message
    api_key: str = ""           # never returned in clear (GET returns "" and AppSettings.has_api_key)
    model: str = ""
    fast_model: str = ""        # "" = use `model`
    temperature: float = 0.2
    num_ctx: int = 0            # 0 = auto: min(model max, 16384 local / 65536 for -cloud models)
    max_tokens: int = 0         # 0 = provider default
    timeout_s: int = 240
    tool_mode: ToolMode = "auto"
    think: bool = False         # reasoning for "thinking" models (sent only to models declaring it; slower)


class EngineSettings(Model):
    autonomy: Autonomy = "approve_writes"
    max_retries: int = 2
    max_agent_actions: int = 8
    agent_timeout_s: int = 600
    critic_enabled: bool = True
    parallel_steps: int = 3
    context_chars: int = 6000


class SchedulerSettings(Model):
    enabled: bool = True
    tick_s: int = 20
    sla_check_minutes: int = 15
    business_hours_start: int = 9
    business_hours_end: int = 18
    timezone: str = "Europe/Paris"


class NotificationSettings(Model):
    in_app: bool = True
    channel_operation_key: str = ""   # Operation used for external messages; "" = in-app only
    digest_enabled: bool = False


DEFAULT_HOURS_SAVED: dict[str, float] = {
    "ai_task": 3.0,
    "mcp_operation": 0.5,
    "agent_task": 4.0,
    "quality_gate": 6.0,
    "notify": 0.5,
    "fan_out": 1.0,
    "wait_for": 0.5,
    "human_form_ai_draft": 2.0,
    "estimation_ai": 2.0,
    "approval_brief": 0.5,
}


class GeneralSettings(Model):
    app_name: str = "DOINg.AI Factory"
    company: str = ""
    hours_saved: dict[str, float] = Field(default_factory=lambda: dict(DEFAULT_HOURS_SAVED))


class AppSettings(Model):
    llm: LLMSettings = Field(default_factory=LLMSettings)
    engine: EngineSettings = Field(default_factory=EngineSettings)
    scheduler: SchedulerSettings = Field(default_factory=SchedulerSettings)
    notifications: NotificationSettings = Field(default_factory=NotificationSettings)
    general: GeneralSettings = Field(default_factory=GeneralSettings)
    has_api_key: bool = False   # read-only, computed on GET


# ---------------------------------------------------------------------------
# People
# ---------------------------------------------------------------------------

class RoleDef(Model):
    key: str
    label: str
    description: str = ""
    color: str = "zinc"


class User(Model):
    id: str = ""
    name: str = ""
    email: str = ""
    title: str = ""
    roles: list[str] = Field(default_factory=list)
    team_ids: list[str] = Field(default_factory=list)
    active: bool = True
    avatar_color: str = ""
    created_at: str = ""


class Team(Model):
    id: str = ""
    name: str = ""
    description: str = ""
    jira_project_key: str = ""
    jira_component: str = ""
    skills: list[str] = Field(default_factory=list)
    lead_user_id: str = ""
    member_ids: list[str] = Field(default_factory=list)
    created_at: str = ""


# ---------------------------------------------------------------------------
# Connectors (MCP servers) & Operations (MCP bindings)
# ---------------------------------------------------------------------------

class ToolInfo(Model):
    name: str
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)
    sensitive: bool = False
    read_only: bool = False


class ConnectorStatus(Model):
    ok: bool | None = None
    checked_at: str | None = None
    error: str = ""
    latency_ms: int = 0
    server_name: str = ""
    server_version: str = ""
    tool_count: int = 0


class Connector(Model):
    id: str = ""
    name: str = ""
    slug: str = ""              # derived from name; used to namespace tools ("jira__create_issue")
    kind: ConnectorKind = "other"
    description: str = ""
    transport: Transport = "http"
    command: str = ""           # stdio
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    cwd: str = ""
    url: str = ""               # http / sse
    headers: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    timeout_s: int = 60
    status: ConnectorStatus = Field(default_factory=ConnectorStatus)
    tools: list[ToolInfo] = Field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""


class FieldDef(Model):
    key: str
    label: str = ""
    type: FieldType = "text"
    required: bool = False
    options: list[str] = Field(default_factory=list)
    help: str = ""
    placeholder: str = ""
    default: Any = None


class OperationOutput(Model):
    extract: str = ""                       # Jinja expression over `result`; "" = whole parsed result
    json_schema: dict[str, Any] | None = None   # llm/agent: structured output schema


class Operation(Model):
    id: str = ""
    key: str = ""               # unique slug, e.g. "portfolio.list_new_use_cases"
    name: str = ""
    description: str = ""
    connector_id: str = ""
    mode: OperationMode = "direct"
    tool: str = ""
    args_template: dict[str, Any] = Field(default_factory=dict)
    prompt: str = ""
    allowed_tools: list[str] = Field(default_factory=list)
    output: OperationOutput = Field(default_factory=OperationOutput)
    sensitive: bool = False
    inputs: list[FieldDef] = Field(default_factory=list)
    test_input: dict[str, Any] = Field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""


class TraceEntry(Model):
    ts: str = ""
    kind: TraceKind = "info"
    agent: str = ""
    text: str = ""
    data: Any = None


class OperationResult(Model):
    ok: bool = False
    output: Any = None
    raw: Any = None
    summary: str = ""
    error: str = ""
    latency_ms: int = 0
    tool: str = ""
    args: dict[str, Any] = Field(default_factory=dict)
    trace: list[TraceEntry] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Blueprints (workflow templates) and typed step configs
# ---------------------------------------------------------------------------

class Assignee(Model):
    roles: list[str] = Field(default_factory=list)
    user_ids: list[str] = Field(default_factory=list)
    project_role: ProjectRole = ""


class StepDef(Model):
    id: str
    name: str = ""
    type: StepType = "ai_task"
    description: str = ""
    assignee: Assignee = Field(default_factory=Assignee)
    sla_hours: float | None = None
    when: str = ""
    store_as: str = ""
    auto_start: bool = True
    config: dict[str, Any] = Field(default_factory=dict)


class StageDef(Model):
    id: str
    name: str = ""
    description: str = ""
    color: str = "indigo"
    parallel: bool = False
    steps: list[StepDef] = Field(default_factory=list)


class Blueprint(Model):
    id: str = ""
    key: str = ""
    name: str = ""
    description: str = ""
    kind: str = "custom"
    icon: str = "Workflow"
    color: str = "indigo"
    key_prefix: str = "PRJ"
    version: int = 1
    status: BlueprintStatus = "active"
    autonomy: AutonomyOverride = ""
    inputs: list[FieldDef] = Field(default_factory=list)
    stages: list[StageDef] = Field(default_factory=list)
    builtin: bool = False
    created_at: str = ""
    updated_at: str = ""


# Typed views over StepDef.config (validated by engine/blueprint.py and the executors).

class AiTaskConfig(Model):
    prompt: str = ""
    system_prompt: str = "writer"      # prompt key in the library
    output: Literal["markdown", "json"] = "markdown"
    json_schema: dict[str, Any] | None = None
    artifact_title: str = ""
    review: bool = False
    include_context: bool = True


class HumanFormConfig(Model):
    fields: list[FieldDef] = Field(default_factory=list)
    instructions: str = ""
    ai_prefill: str = ""               # Jinja prompt; "" = no AI draft
    artifact_title: str = ""
    include_context: bool = True


class ApproverDef(Model):
    role: str
    label: str = ""


class OnReject(Model):
    action: Literal["reopen", "fail"] = "reopen"
    goto_step: str = ""                # "" = previous step


class ApprovalConfig(Model):
    approvers: list[ApproverDef] = Field(default_factory=list)
    policy: Literal["all", "any", "quorum"] = "all"
    quorum: int = 1
    on_reject: OnReject = Field(default_factory=OnReject)
    brief_prompt: str = ""
    show_vars: list[str] = Field(default_factory=list)


class EstimationConfig(Model):
    unit: Literal["days", "points"] = "days"
    ai_suggest: bool = True
    prompt: str = ""
    require_breakdown: bool = False


class LinkSpec(Model):
    kind: LinkKind = "url"
    label: str = ""          # Jinja over {output, ...ctx}
    url: str = ""            # Jinja
    external_id: str = ""    # Jinja


class McpOperationConfig(Model):
    operation_key: str = ""
    input: dict[str, Any] = Field(default_factory=dict)
    create_link: LinkSpec | None = None


class AgentTaskConfig(Model):
    goal: str = ""
    connector_ids: list[str] = Field(default_factory=list)   # [] = all enabled connectors
    allowed_tools: list[str] = Field(default_factory=list)   # qualified names; [] = all
    max_actions: int = 0                                     # 0 = engine.max_agent_actions
    output_schema: dict[str, Any] | None = None
    artifact_title: str = ""
    include_context: bool = True


class QualityGateConfig(Model):
    rule_tags: list[str] = Field(default_factory=list)
    rule_ids: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)        # var names; [] = all vars + artifacts
    block_on: Literal["critical", "high", "medium", "any"] = "high"
    override_roles: list[str] = Field(default_factory=lambda: ["compliance", "security", "admin"])


class FanOutConfig(Model):
    items: str = ""                  # Jinja expression → list
    blueprint_key: str = ""
    title: str = ""                  # Jinja with `item`
    inputs: dict[str, Any] = Field(default_factory=dict)
    wait: Literal["all", "none"] = "all"
    inherit: list[str] = Field(default_factory=lambda: ["sponsor", "owner", "team", "priority"])


class AudienceDef(Model):
    role: str = ""
    project_role: ProjectRole = ""
    user_id: str = ""


class NotifyConfig(Model):
    audience: list[AudienceDef] = Field(default_factory=list)
    subject: str = ""
    prompt: str = ""                 # LLM writes the body
    body: str = ""                   # static Jinja body (no LLM) when prompt is ""
    channel: Literal["in_app", "external", "both"] = "in_app"


class WaitForConfig(Model):
    operation_key: str = ""
    input: dict[str, Any] = Field(default_factory=dict)
    until: str = ""                  # Jinja condition over `output`
    poll_minutes: int = 15
    timeout_hours: float = 0         # 0 = no timeout
    manual_complete: bool = True


STEP_CONFIG_MODELS: dict[str, type[Model]] = {
    "ai_task": AiTaskConfig,
    "human_form": HumanFormConfig,
    "approval": ApprovalConfig,
    "estimation": EstimationConfig,
    "mcp_operation": McpOperationConfig,
    "agent_task": AgentTaskConfig,
    "quality_gate": QualityGateConfig,
    "fan_out": FanOutConfig,
    "notify": NotifyConfig,
    "wait_for": WaitForConfig,
}


# ---------------------------------------------------------------------------
# Projects (workflow instances)
# ---------------------------------------------------------------------------

class Approval(Model):
    user_id: str
    role: str = ""
    decision: Literal["approved", "rejected"]
    comment: str = ""
    at: str = ""


class CheckResult(Model):
    rule_id: str
    code: str = ""
    title: str = ""
    severity: Severity = "medium"
    status: CheckStatus = "pending"
    evidence: str = ""
    recommendation: str = ""
    overridden_by: str = ""
    override_comment: str = ""


class EstimateLine(Model):
    item: str
    value: float = 0


class Estimate(Model):
    value: float | None = None
    unit: Literal["days", "points"] = "days"
    confidence: Literal["low", "medium", "high"] = "medium"
    breakdown: list[EstimateLine] = Field(default_factory=list)
    rationale: str = ""
    submitted_by: str = ""
    ai_suggestion: dict[str, Any] | None = None   # same shape as Estimate (minus ai_suggestion)


class PendingAction(Model):
    kind: PendingKind
    title: str = ""
    description: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: str = ""


class StepRun(Model):
    id: str
    name: str = ""
    type: StepType = "ai_task"
    description: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    assignee: Assignee = Field(default_factory=Assignee)
    assignee_user_ids: list[str] = Field(default_factory=list)
    status: StepStatus = "pending"
    when: str = ""
    store_as: str = ""
    sla_hours: float | None = None
    due_at: str | None = None
    sla_breached: bool = False
    auto_start: bool = True
    started_at: str | None = None
    completed_at: str | None = None
    completed_by: str = ""
    attempts: int = 0
    error: str = ""
    heal_hint: str = ""
    output: Any = None
    output_summary: str = ""
    form: dict[str, Any] = Field(default_factory=dict)
    ai_draft: dict[str, Any] | None = None
    ai_busy: bool = False
    approvals: list[Approval] = Field(default_factory=list)
    brief: str = ""
    checks: list[CheckResult] = Field(default_factory=list)
    estimate: Estimate | None = None
    pending_action: PendingAction | None = None
    child_ids: list[str] = Field(default_factory=list)
    agent_state: dict[str, Any] | None = None
    feedback: str = ""
    next_poll_at: str | None = None     # wait_for scheduling
    trace: list[TraceEntry] = Field(default_factory=list)


class StageRun(Model):
    id: str
    name: str = ""
    description: str = ""
    color: str = "indigo"
    parallel: bool = False
    status: StageStatus = "pending"
    started_at: str | None = None
    completed_at: str | None = None
    steps: list[StepRun] = Field(default_factory=list)


class ArtifactVersion(Model):
    version: int
    content: str = ""
    updated_by: str = ""
    updated_at: str = ""


class Artifact(Model):
    id: str = ""
    step_id: str = ""
    title: str = ""
    kind: ArtifactKind = "markdown"
    content: str = ""
    data: Any = None
    version: int = 1
    history: list[ArtifactVersion] = Field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    updated_by: str = ""


class Link(Model):
    id: str = ""
    kind: LinkKind = "url"
    label: str = ""
    url: str = ""
    external_id: str = ""
    status: str = ""
    step_id: str = ""
    created_at: str = ""


class Risk(Model):
    score: int = 0
    level: RiskLevel = "low"
    reasons: list[str] = Field(default_factory=list)
    computed_at: str | None = None


class ProjectMetrics(Model):
    llm_calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    ai_steps: int = 0
    human_steps: int = 0
    hours_saved: float = 0.0


class ProjectSource(Model):
    type: SourceType = "manual"
    watcher_id: str = ""
    intake_id: str = ""
    connector_id: str = ""
    external_id: str = ""
    url: str = ""
    raw: dict[str, Any] = Field(default_factory=dict)


class Project(Model):
    id: str = ""
    key: str = ""
    title: str = ""
    description: str = ""
    blueprint_id: str = ""
    blueprint_name: str = ""
    blueprint_version: int = 1
    kind: str = "custom"
    status: ProjectStatus = "active"
    priority: Priority = "medium"
    sponsor_id: str = ""
    owner_id: str = ""
    team_id: str = ""
    stakeholder_ids: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    due_date: str | None = None
    inputs: dict[str, Any] = Field(default_factory=dict)
    vars: dict[str, Any] = Field(default_factory=dict)
    source: ProjectSource = Field(default_factory=ProjectSource)
    parent_id: str = ""
    parent_step_id: str = ""
    child_ids: list[str] = Field(default_factory=list)
    stages: list[StageRun] = Field(default_factory=list)
    current_stage_id: str = ""
    artifacts: list[Artifact] = Field(default_factory=list)
    links: list[Link] = Field(default_factory=list)
    risk: Risk = Field(default_factory=Risk)
    ai_summary: str = ""
    metrics: ProjectMetrics = Field(default_factory=ProjectMetrics)
    autonomy: AutonomyOverride = ""
    created_by: str = ""
    created_at: str = ""
    updated_at: str = ""
    started_at: str | None = None
    completed_at: str | None = None


class ProjectSummary(Model):
    id: str
    key: str = ""
    title: str = ""
    kind: str = ""
    blueprint_id: str = ""
    blueprint_name: str = ""
    status: ProjectStatus = "active"
    priority: Priority = "medium"
    sponsor_id: str = ""
    owner_id: str = ""
    team_id: str = ""
    current_stage_id: str = ""
    current_stage_name: str = ""
    progress: float = 0.0
    open_step_names: list[str] = Field(default_factory=list)
    open_step_statuses: list[StepStatus] = Field(default_factory=list)
    risk: Risk = Field(default_factory=Risk)
    parent_id: str = ""
    child_count: int = 0
    children_done: int = 0
    due_date: str | None = None
    created_at: str = ""
    updated_at: str = ""
    completed_at: str | None = None
    tags: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Watchers, intake, notifications, activity, metrics, library
# ---------------------------------------------------------------------------

class WatcherSchedule(Model):
    every_minutes: int = 15
    active_hours_start: int | None = None
    active_hours_end: int | None = None
    days: list[int] = Field(default_factory=list)   # ISO weekday 1-7; [] = every day


class WatcherState(Model):
    last_run_at: str | None = None
    next_run_at: str | None = None
    last_status: Literal["", "ok", "error"] = ""
    last_error: str = ""
    last_count: int = 0
    last_new: int = 0
    runs: int = 0
    new_total: int = 0
    seen_keys: list[str] = Field(default_factory=list)


class Watcher(Model):
    id: str = ""
    name: str = ""
    description: str = ""
    enabled: bool = True
    operation_key: str = ""
    input: dict[str, Any] = Field(default_factory=dict)
    schedule: WatcherSchedule = Field(default_factory=WatcherSchedule)
    items_expr: str = "result"
    key_field: str = "id"
    title_field: str = "title"
    filter: str = ""
    action: WatcherAction = "intake"
    blueprint_id: str = ""
    mapping: dict[str, str] = Field(default_factory=dict)
    baseline_on_first_run: bool = False
    state: WatcherState = Field(default_factory=WatcherState)
    created_at: str = ""
    updated_at: str = ""


class IntakeSuggestion(Model):
    blueprint_id: str = ""
    priority: str = ""
    team_id: str = ""
    sponsor_id: str = ""
    owner_id: str = ""
    rationale: str = ""
    summary: str = ""
    required_capabilities: list[str] = Field(default_factory=list)
    confidence: Literal["", "low", "medium", "high"] = ""


class IntakeItem(Model):
    id: str = ""
    watcher_id: str = ""
    watcher_name: str = ""
    external_id: str = ""
    title: str = ""
    raw: dict[str, Any] = Field(default_factory=dict)
    status: IntakeStatus = "new"
    suggestion: IntakeSuggestion | None = None
    ai_busy: bool = False
    ai_error: str = ""
    project_id: str = ""
    detected_at: str = ""
    decided_by: str = ""
    decided_at: str | None = None
    dismiss_reason: str = ""


class Notification(Model):
    id: str = ""
    user_id: str = ""
    kind: NotificationKind = "info"
    title: str = ""
    body: str = ""
    project_id: str = ""
    step_id: str = ""
    read: bool = False
    created_at: str = ""


class Event(Model):
    id: str = ""
    ts: str = ""
    kind: str = ""
    actor: str = "system"
    project_id: str = ""
    step_id: str = ""
    message: str = ""
    data: dict[str, Any] = Field(default_factory=dict)
    hash: str = ""          # sha256(prev_hash + canonical event) — tamper-evident audit chain


class LLMCall(Model):
    id: str = ""
    ts: str = ""
    role: str = ""
    model: str = ""
    ok: bool = True
    latency_ms: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    project_id: str = ""
    step_id: str = ""
    error: str = ""


class PromptDef(Model):
    key: str
    name: str = ""
    description: str = ""
    content: str = ""
    default_content: str = ""
    updated_at: str = ""


class Rule(Model):
    id: str = ""
    code: str = ""
    title: str = ""
    description: str = ""
    category: RuleCategory = "Quality"
    severity: Severity = "medium"
    tags: list[str] = Field(default_factory=list)
    check: RuleCheck = "ai"
    guidance: str = ""
    enabled: bool = True


class InboxItem(Model):
    id: str
    kind: InboxKind
    project_id: str = ""
    project_key: str = ""
    project_title: str = ""
    step_id: str = ""
    step_name: str = ""
    title: str = ""
    subtitle: str = ""
    priority: Priority = "medium"
    due_at: str | None = None
    overdue: bool = False
    created_at: str = ""
    risk_level: Literal["", "low", "medium", "high"] = ""


class InboxCounts(Model):
    total: int = 0
    approvals: int = 0
    forms: int = 0
    reviews: int = 0
    failures: int = 0
    intake: int = 0


class ChatToolCall(Model):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)
    summary: str = ""


class ChatLink(Model):
    label: str
    project_id: str


class ChatMessage(Model):
    role: Literal["user", "assistant"]
    content: str = ""
    tool_calls: list[ChatToolCall] = Field(default_factory=list)
    links: list[ChatLink] = Field(default_factory=list)
    ts: str = ""


class Chat(Model):
    id: str = ""
    user_id: str = ""
    project_id: str = ""
    title: str = ""
    messages: list[ChatMessage] = Field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""


# ---------------------------------------------------------------------------
# KPIs
# ---------------------------------------------------------------------------

class KpiTotals(Model):
    active: int = 0
    waiting: int = 0
    blocked: int = 0
    done_period: int = 0
    cancelled: int = 0
    at_risk: int = 0
    intake_new: int = 0
    open_tasks: int = 0
    pending_approvals: int = 0
    children_in_flight: int = 0


class KpiLeadTimeByBlueprint(Model):
    blueprint: str
    avg_days: float = 0
    count: int = 0


class KpiLeadTime(Model):
    avg_days: float | None = None
    median_days: float | None = None
    p90_days: float | None = None
    by_blueprint: list[KpiLeadTimeByBlueprint] = Field(default_factory=list)


class KpiWeek(Model):
    week: str
    created: int = 0
    completed: int = 0


class KpiStage(Model):
    blueprint: str
    stage: str
    avg_hours: float = 0
    avg_wait_hours: float = 0
    count: int = 0


class KpiSla(Model):
    on_time_pct: float | None = None
    breached_open: int = 0
    breached_total: int = 0


class KpiApprovalRole(Model):
    role: str
    avg_hours: float = 0
    count: int = 0
    rejected: int = 0


class KpiApprovals(Model):
    avg_hours: float | None = None
    rejection_rate: float | None = None
    by_role: list[KpiApprovalRole] = Field(default_factory=list)


class KpiTypeCount(Model):
    type: str
    count: int = 0
    ai: int = 0


class KpiAutomation(Model):
    ai_steps: int = 0
    human_steps: int = 0
    ai_share: float | None = None
    hours_saved: float = 0
    by_type: list[KpiTypeCount] = Field(default_factory=list)


class KpiRuleFail(Model):
    code: str
    title: str = ""
    fails: int = 0


class KpiQuality(Model):
    gates_run: int = 0
    first_pass_rate: float | None = None
    top_failing_rules: list[KpiRuleFail] = Field(default_factory=list)


class KpiJira(Model):
    issues_created: int = 0


class KpiLlmRole(Model):
    role: str
    calls: int = 0
    avg_latency_ms: float = 0


class KpiLlmDay(Model):
    day: str
    calls: int = 0
    tokens: int = 0


class KpiLlm(Model):
    calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    avg_latency_ms: float | None = None
    error_rate: float | None = None
    by_role: list[KpiLlmRole] = Field(default_factory=list)
    by_day: list[KpiLlmDay] = Field(default_factory=list)


class KpiFunnel(Model):
    detected: int = 0
    accepted: int = 0
    active: int = 0
    done: int = 0


class KpiWorkload(Model):
    user_id: str
    open_tasks: int = 0
    overdue: int = 0


class Kpis(Model):
    generated_at: str = ""
    days: int = 30
    totals: KpiTotals = Field(default_factory=KpiTotals)
    lead_time: KpiLeadTime = Field(default_factory=KpiLeadTime)
    throughput: list[KpiWeek] = Field(default_factory=list)
    stages: list[KpiStage] = Field(default_factory=list)
    sla: KpiSla = Field(default_factory=KpiSla)
    approvals: KpiApprovals = Field(default_factory=KpiApprovals)
    automation: KpiAutomation = Field(default_factory=KpiAutomation)
    quality: KpiQuality = Field(default_factory=KpiQuality)
    jira: KpiJira = Field(default_factory=KpiJira)
    llm: KpiLlm = Field(default_factory=KpiLlm)
    funnel: KpiFunnel = Field(default_factory=KpiFunnel)
    workload: list[KpiWorkload] = Field(default_factory=list)
