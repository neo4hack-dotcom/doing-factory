// DOINg.AI Factory — data contract, hand-mirrored from backend/app/models.py.
//
// Field for field, snake_case kept verbatim: a mapping layer would buy nothing and drift.
// Rules: a Python field with a non-None default is always serialised, so it is required here;
// a field whose default is None is optional and nullable (`x?: T | null`); `Any` is `unknown`.
// Change models.py and this file in the same commit (frontend/tests/test_types_mirror.py checks both).

// ---------------------------------------------------------------------------
// Literal unions (closed vocabularies)
// ---------------------------------------------------------------------------

export type LLMProviderKind = 'ollama' | 'openai';
export type ToolMode = 'auto' | 'native' | 'json';
export type Autonomy = 'supervised' | 'approve_writes' | 'full';
export type AutonomyOverride = '' | 'supervised' | 'approve_writes' | 'full';
export type ConnectorKind = 'portfolio' | 'jira' | 'notification' | 'git' | 'docs' | 'other';
export type Transport = 'stdio' | 'http' | 'sse';
export type FieldType =
  | 'text' | 'textarea' | 'markdown' | 'number' | 'select' | 'multiselect' | 'date'
  | 'user' | 'users' | 'team' | 'checkbox' | 'list' | 'url';
export type OperationMode = 'direct' | 'llm' | 'agent';
export type StepType =
  | 'ai_task' | 'human_form' | 'approval' | 'estimation' | 'mcp_operation'
  | 'agent_task' | 'quality_gate' | 'fan_out' | 'notify' | 'wait_for';
export type ProjectRole = '' | 'sponsor' | 'owner' | 'team_lead' | 'team';
export type BlueprintStatus = 'active' | 'draft' | 'archived';
export type ProjectStatus = 'active' | 'waiting' | 'blocked' | 'done' | 'cancelled' | 'failed';
export type StepStatus =
  | 'pending' | 'running' | 'waiting_human' | 'waiting_approval' | 'waiting_children'
  | 'waiting_external' | 'done' | 'skipped' | 'failed' | 'rejected';
export type StageStatus = 'pending' | 'active' | 'done' | 'skipped';
export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'na' | 'pending';
export type TraceKind = 'info' | 'thought' | 'tool' | 'result' | 'error' | 'human' | 'ai';
export type PendingKind = 'confirm_operation' | 'agent_tool_call' | 'gate_review' | 'ai_review';
export type ArtifactKind = 'markdown' | 'json';
export type LinkKind = 'jira' | 'mcp' | 'url' | 'doc';
export type RiskLevel = 'low' | 'medium' | 'high';
export type SourceType = 'manual' | 'watcher' | 'fan_out' | 'copilot' | 'api';
export type WatcherAction = 'intake' | 'auto_start';
export type IntakeStatus = 'new' | 'accepted' | 'dismissed';
export type NotificationKind = 'task' | 'approval' | 'info' | 'warning' | 'success' | 'mention';
export type RuleCategory = 'Security' | 'Data' | 'Operations' | 'Architecture' | 'Legal' | 'Quality';
export type RuleCheck = 'ai' | 'manual';
export type InboxKind =
  | 'form' | 'approval' | 'estimate' | 'review' | 'confirm' | 'gate' | 'failure' | 'start' | 'external' | 'intake';
export type RewriteStyle =
  | 'professional' | 'concise' | 'executive' | 'technical' | 'friendly' | 'fix' | 'expand' | 'bullets' | 'jira';
export type ReportAudience = 'sponsor' | 'team' | 'executive';

// ---------------------------------------------------------------------------
// Settings (singleton document)
// ---------------------------------------------------------------------------

export interface LLMSettings {
  provider: LLMProviderKind;
  base_url: string;      // '' = not configured → every LLM call fails with an actionable message
  api_key: string;       // never returned in clear (GET returns '' and AppSettings.has_api_key)
  model: string;
  fast_model: string;    // '' = use `model`
  temperature: number;
  num_ctx: number;       // 0 = auto
  max_tokens: number;    // 0 = provider default
  timeout_s: number;
  tool_mode: ToolMode;
  think: boolean;
}

export interface EngineSettings {
  autonomy: Autonomy;
  max_retries: number;
  max_agent_actions: number;
  agent_timeout_s: number;
  critic_enabled: boolean;
  parallel_steps: number;
  context_chars: number;
}

export interface SchedulerSettings {
  enabled: boolean;
  tick_s: number;
  sla_check_minutes: number;
  business_hours_start: number;
  business_hours_end: number;
  timezone: string;
}

export interface NotificationSettings {
  in_app: boolean;
  channel_operation_key: string;   // Operation used for external messages; '' = in-app only
  digest_enabled: boolean;
}

export const DEFAULT_HOURS_SAVED: Record<string, number> = {
  ai_task: 3.0,
  mcp_operation: 0.5,
  agent_task: 4.0,
  quality_gate: 6.0,
  notify: 0.5,
  fan_out: 1.0,
  wait_for: 0.5,
  human_form_ai_draft: 2.0,
  estimation_ai: 2.0,
  approval_brief: 0.5,
};

export interface GeneralSettings {
  app_name: string;
  company: string;
  hours_saved: Record<string, number>;
}

export interface AppSettings {
  llm: LLMSettings;
  engine: EngineSettings;
  scheduler: SchedulerSettings;
  notifications: NotificationSettings;
  general: GeneralSettings;
  has_api_key: boolean;   // read-only, computed on GET
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface RoleDef {
  key: string;
  label: string;
  description: string;
  color: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  title: string;
  roles: string[];
  team_ids: string[];
  active: boolean;
  avatar_color: string;
  created_at: string;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  jira_project_key: string;
  jira_component: string;
  skills: string[];
  lead_user_id: string;
  member_ids: string[];
  created_at: string;
}

// ---------------------------------------------------------------------------
// Connectors (MCP servers) & Operations (MCP bindings)
// ---------------------------------------------------------------------------

export interface ToolInfo {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  sensitive: boolean;
  read_only: boolean;
}

export interface ConnectorStatus {
  ok?: boolean | null;
  checked_at?: string | null;
  error: string;
  latency_ms: number;
  server_name: string;
  server_version: string;
  tool_count: number;
}

export interface Connector {
  id: string;
  name: string;
  slug: string;               // namespaces tools ("jira__create_issue")
  kind: ConnectorKind;
  description: string;
  transport: Transport;
  command: string;            // stdio
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;                // http / sse
  headers: Record<string, string>;
  enabled: boolean;
  timeout_s: number;
  sandbox: boolean;
  status: ConnectorStatus;
  tools: ToolInfo[];
  created_at: string;
  updated_at: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
  help: string;
  placeholder: string;
  default?: unknown;
}

export interface OperationOutput {
  extract: string;                                 // Jinja expression over `result`; '' = whole result
  json_schema?: Record<string, unknown> | null;    // llm/agent: structured output schema
}

export interface Operation {
  id: string;
  key: string;              // unique slug, e.g. "portfolio.list_new_use_cases"
  name: string;
  description: string;
  connector_id: string;
  mode: OperationMode;
  tool: string;
  args_template: Record<string, unknown>;
  prompt: string;
  allowed_tools: string[];
  output: OperationOutput;
  sensitive: boolean;
  inputs: FieldDef[];
  test_input: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TraceEntry {
  ts: string;
  kind: TraceKind;
  agent: string;
  text: string;
  data?: unknown;
}

export interface OperationResult {
  ok: boolean;
  output?: unknown;
  raw?: unknown;
  summary: string;
  error: string;
  latency_ms: number;
  tool: string;
  args: Record<string, unknown>;
  trace: TraceEntry[];
}

// ---------------------------------------------------------------------------
// Blueprints (workflow templates) and typed step configs
// ---------------------------------------------------------------------------

export interface Assignee {
  roles: string[];
  user_ids: string[];
  project_role: ProjectRole;
}

export interface StepDef {
  id: string;
  name: string;
  type: StepType;
  description: string;
  assignee: Assignee;
  sla_hours?: number | null;
  when: string;
  store_as: string;
  auto_start: boolean;
  config: Record<string, unknown>;
}

export interface StageDef {
  id: string;
  name: string;
  description: string;
  color: string;
  parallel: boolean;
  steps: StepDef[];
}

export interface Blueprint {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: string;
  icon: string;
  color: string;
  key_prefix: string;
  version: number;
  status: BlueprintStatus;
  autonomy: AutonomyOverride;
  inputs: FieldDef[];
  stages: StageDef[];
  builtin: boolean;
  created_at: string;
  updated_at: string;
}

// Typed views over StepDef.config (validated by engine/blueprint.py and the executors).

export interface AiTaskConfig {
  prompt: string;
  system_prompt: string;     // prompt key in the library
  output: 'markdown' | 'json';
  json_schema?: Record<string, unknown> | null;
  artifact_title: string;
  review: boolean;
  include_context: boolean;
}

export interface HumanFormConfig {
  fields: FieldDef[];
  instructions: string;
  ai_prefill: string;        // Jinja prompt; '' = no AI draft
  artifact_title: string;
  include_context: boolean;
}

export interface ApproverDef {
  role: string;
  label: string;
}

export interface OnReject {
  action: 'reopen' | 'fail';
  goto_step: string;         // '' = previous step
}

export interface ApprovalConfig {
  approvers: ApproverDef[];
  policy: 'all' | 'any' | 'quorum';
  quorum: number;
  on_reject: OnReject;
  brief_prompt: string;
  show_vars: string[];
}

export interface EstimationConfig {
  unit: 'days' | 'points';
  ai_suggest: boolean;
  prompt: string;
  require_breakdown: boolean;
}

export interface LinkSpec {
  kind: LinkKind;
  label: string;             // Jinja over {output, ...ctx}
  url: string;               // Jinja
  external_id: string;       // Jinja
}

export interface McpOperationConfig {
  operation_key: string;
  input: Record<string, unknown>;
  create_link?: LinkSpec | null;
}

export interface AgentTaskConfig {
  goal: string;
  connector_ids: string[];   // [] = all enabled connectors
  allowed_tools: string[];   // qualified names; [] = all
  max_actions: number;       // 0 = engine.max_agent_actions
  output_schema?: Record<string, unknown> | null;
  artifact_title: string;
  include_context: boolean;
}

export interface QualityGateConfig {
  rule_tags: string[];
  rule_ids: string[];
  evidence: string[];        // var names; [] = all vars + artifacts
  block_on: 'critical' | 'high' | 'medium' | 'any';
  override_roles: string[];
}

export interface FanOutConfig {
  items: string;             // Jinja expression → list
  blueprint_key: string;
  title: string;             // Jinja with `item`
  inputs: Record<string, unknown>;
  wait: 'all' | 'none';
  inherit: string[];
}

export interface AudienceDef {
  role: string;
  project_role: ProjectRole;
  user_id: string;
}

export interface NotifyConfig {
  audience: AudienceDef[];
  subject: string;
  prompt: string;            // LLM writes the body
  body: string;              // static Jinja body (no LLM) when prompt is ''
  channel: 'in_app' | 'external' | 'both';
}

export interface WaitForConfig {
  operation_key: string;
  input: Record<string, unknown>;
  until: string;             // Jinja condition over `output`
  poll_minutes: number;
  timeout_hours: number;     // 0 = no timeout
  manual_complete: boolean;
}

/** StepType → its typed config (mirror of STEP_CONFIG_MODELS). */
export interface StepConfigMap {
  ai_task: AiTaskConfig;
  human_form: HumanFormConfig;
  approval: ApprovalConfig;
  estimation: EstimationConfig;
  mcp_operation: McpOperationConfig;
  agent_task: AgentTaskConfig;
  quality_gate: QualityGateConfig;
  fan_out: FanOutConfig;
  notify: NotifyConfig;
  wait_for: WaitForConfig;
}

// ---------------------------------------------------------------------------
// Projects (workflow instances)
// ---------------------------------------------------------------------------

export interface Approval {
  user_id: string;
  role: string;
  decision: 'approved' | 'rejected';
  comment: string;
  at: string;
}

export interface CheckResult {
  rule_id: string;
  code: string;
  title: string;
  severity: Severity;
  status: CheckStatus;
  evidence: string;
  recommendation: string;
  overridden_by: string;
  override_comment: string;
}

export interface EstimateLine {
  item: string;
  value: number;
}

export interface Estimate {
  value?: number | null;
  unit: 'days' | 'points';
  confidence: 'low' | 'medium' | 'high';
  breakdown: EstimateLine[];
  rationale: string;
  submitted_by: string;
  ai_suggestion?: Record<string, unknown> | null;   // same shape as Estimate (minus ai_suggestion)
}

export interface PendingAction {
  kind: PendingKind;
  title: string;
  description: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface StepRun {
  id: string;
  name: string;
  type: StepType;
  description: string;
  config: Record<string, unknown>;
  assignee: Assignee;
  assignee_user_ids: string[];
  status: StepStatus;
  when: string;
  store_as: string;
  sla_hours?: number | null;
  due_at?: string | null;
  sla_breached: boolean;
  auto_start: boolean;
  started_at?: string | null;
  completed_at?: string | null;
  completed_by: string;
  attempts: number;
  error: string;
  heal_hint: string;
  output?: unknown;
  output_summary: string;
  form: Record<string, unknown>;
  ai_draft?: Record<string, unknown> | null;
  ai_busy: boolean;
  approvals: Approval[];
  brief: string;
  checks: CheckResult[];
  estimate?: Estimate | null;
  pending_action?: PendingAction | null;
  child_ids: string[];
  agent_state?: Record<string, unknown> | null;
  feedback: string;
  next_poll_at?: string | null;    // wait_for scheduling
  trace: TraceEntry[];
}

export interface StageRun {
  id: string;
  name: string;
  description: string;
  color: string;
  parallel: boolean;
  status: StageStatus;
  started_at?: string | null;
  completed_at?: string | null;
  steps: StepRun[];
}

export interface ArtifactVersion {
  version: number;
  content: string;
  updated_by: string;
  updated_at: string;
}

export interface Artifact {
  id: string;
  step_id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  data?: unknown;
  version: number;
  history: ArtifactVersion[];
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export interface Link {
  id: string;
  kind: LinkKind;
  label: string;
  url: string;
  external_id: string;
  status: string;
  step_id: string;
  created_at: string;
}

export interface Risk {
  score: number;
  level: RiskLevel;
  reasons: string[];
  computed_at?: string | null;
}

export interface ProjectMetrics {
  llm_calls: number;
  tokens_in: number;
  tokens_out: number;
  ai_steps: number;
  human_steps: number;
  hours_saved: number;
}

export interface ProjectSource {
  type: SourceType;
  watcher_id: string;
  intake_id: string;
  connector_id: string;
  external_id: string;
  url: string;
  raw: Record<string, unknown>;
}

export interface Project {
  id: string;
  key: string;
  title: string;
  description: string;
  blueprint_id: string;
  blueprint_name: string;
  blueprint_version: number;
  kind: string;
  status: ProjectStatus;
  priority: Priority;
  sponsor_id: string;
  owner_id: string;
  team_id: string;
  stakeholder_ids: string[];
  tags: string[];
  due_date?: string | null;
  inputs: Record<string, unknown>;
  vars: Record<string, unknown>;
  source: ProjectSource;
  parent_id: string;
  parent_step_id: string;
  child_ids: string[];
  stages: StageRun[];
  current_stage_id: string;
  artifacts: Artifact[];
  links: Link[];
  risk: Risk;
  ai_summary: string;
  metrics: ProjectMetrics;
  autonomy: AutonomyOverride;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface ProjectSummary {
  id: string;
  key: string;
  title: string;
  kind: string;
  blueprint_id: string;
  blueprint_name: string;
  status: ProjectStatus;
  priority: Priority;
  sponsor_id: string;
  owner_id: string;
  team_id: string;
  current_stage_id: string;
  current_stage_name: string;
  progress: number;                 // 0-1 = done+skipped steps / total
  open_step_names: string[];
  open_step_statuses: StepStatus[];
  risk: Risk;
  parent_id: string;
  child_count: number;
  children_done: number;
  due_date?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Watchers, intake, notifications, activity, metrics, library
// ---------------------------------------------------------------------------

export interface WatcherSchedule {
  every_minutes: number;
  active_hours_start?: number | null;
  active_hours_end?: number | null;
  days: number[];                   // ISO weekday 1-7; [] = every day
}

export interface WatcherState {
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_status: '' | 'ok' | 'error';
  last_error: string;
  last_count: number;
  last_new: number;
  runs: number;
  new_total: number;
  seen_keys: string[];
}

export interface Watcher {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  operation_key: string;
  input: Record<string, unknown>;
  schedule: WatcherSchedule;
  items_expr: string;
  key_field: string;
  title_field: string;
  filter: string;
  action: WatcherAction;
  blueprint_id: string;
  mapping: Record<string, string>;
  baseline_on_first_run: boolean;
  state: WatcherState;
  created_at: string;
  updated_at: string;
}

export interface IntakeSuggestion {
  blueprint_id: string;
  priority: string;
  team_id: string;
  sponsor_id: string;
  owner_id: string;
  rationale: string;
  summary: string;
  required_capabilities: string[];
  confidence: '' | 'low' | 'medium' | 'high';
}

export interface IntakeItem {
  id: string;
  watcher_id: string;
  watcher_name: string;
  external_id: string;
  title: string;
  raw: Record<string, unknown>;
  status: IntakeStatus;
  suggestion?: IntakeSuggestion | null;
  ai_busy: boolean;
  ai_error: string;
  project_id: string;
  detected_at: string;
  decided_by: string;
  decided_at?: string | null;
  dismiss_reason: string;
}

export interface Notification {
  id: string;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  project_id: string;
  step_id: string;
  read: boolean;
  created_at: string;
}

export interface Event {
  id: string;
  ts: string;
  kind: string;
  actor: string;      // 'usr_…' | 'ai' | 'system' | 'scheduler'
  project_id: string;
  step_id: string;
  message: string;
  data: Record<string, unknown>;
  hash: string;       // tamper-evident audit chain
}

export interface LLMCall {
  id: string;
  ts: string;
  role: string;
  model: string;
  ok: boolean;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  project_id: string;
  step_id: string;
  error: string;
}

export interface PromptDef {
  key: string;
  name: string;
  description: string;
  content: string;
  default_content: string;
  updated_at: string;
}

export interface Rule {
  id: string;
  code: string;
  title: string;
  description: string;
  category: RuleCategory;
  severity: Severity;
  tags: string[];
  check: RuleCheck;
  guidance: string;
  enabled: boolean;
}

export interface InboxItem {
  id: string;           // "{project_id}:{step_id}" or "intake:{id}"
  kind: InboxKind;
  project_id: string;
  project_key: string;
  project_title: string;
  step_id: string;
  step_name: string;
  title: string;
  subtitle: string;
  priority: Priority;
  due_at?: string | null;
  overdue: boolean;
  created_at: string;
  risk_level: '' | 'low' | 'medium' | 'high';
}

export interface InboxCounts {
  total: number;
  approvals: number;
  forms: number;
  reviews: number;
  failures: number;
  intake: number;
}

export interface ChatToolCall {
  name: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface ChatLink {
  label: string;
  project_id: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  tool_calls: ChatToolCall[];
  links: ChatLink[];
  ts: string;
}

export interface Chat {
  id: string;
  user_id: string;
  project_id: string;
  title: string;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

export interface KpiTotals {
  active: number;
  waiting: number;
  blocked: number;
  done_period: number;
  cancelled: number;
  at_risk: number;
  intake_new: number;
  open_tasks: number;
  pending_approvals: number;
  children_in_flight: number;
}

export interface KpiLeadTimeByBlueprint {
  blueprint: string;
  avg_days: number;
  count: number;
}

export interface KpiLeadTime {
  avg_days?: number | null;
  median_days?: number | null;
  p90_days?: number | null;
  by_blueprint: KpiLeadTimeByBlueprint[];
}

export interface KpiWeek {
  week: string;       // 'YYYY-Www'
  created: number;
  completed: number;
}

export interface KpiStage {
  blueprint: string;
  stage: string;
  avg_hours: number;
  avg_wait_hours: number;
  count: number;
}

export interface KpiSla {
  on_time_pct?: number | null;
  breached_open: number;
  breached_total: number;
}

export interface KpiApprovalRole {
  role: string;
  avg_hours: number;
  count: number;
  rejected: number;
}

export interface KpiApprovals {
  avg_hours?: number | null;
  rejection_rate?: number | null;
  by_role: KpiApprovalRole[];
}

export interface KpiTypeCount {
  type: string;
  count: number;
  ai: number;
}

export interface KpiAutomation {
  ai_steps: number;
  human_steps: number;
  ai_share?: number | null;
  hours_saved: number;
  by_type: KpiTypeCount[];
}

export interface KpiRuleFail {
  code: string;
  title: string;
  fails: number;
}

export interface KpiQuality {
  gates_run: number;
  first_pass_rate?: number | null;
  top_failing_rules: KpiRuleFail[];
}

export interface KpiJira {
  issues_created: number;
}

export interface KpiLlmRole {
  role: string;
  calls: number;
  avg_latency_ms: number;
}

export interface KpiLlmDay {
  day: string;
  calls: number;
  tokens: number;
}

export interface KpiLlm {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  avg_latency_ms?: number | null;
  error_rate?: number | null;
  by_role: KpiLlmRole[];
  by_day: KpiLlmDay[];
}

export interface KpiFunnel {
  detected: number;
  accepted: number;
  active: number;
  done: number;
}

export interface KpiWorkload {
  user_id: string;
  open_tasks: number;
  overdue: number;
}

export interface Kpis {
  generated_at: string;
  days: number;
  totals: KpiTotals;
  lead_time: KpiLeadTime;
  throughput: KpiWeek[];
  stages: KpiStage[];
  sla: KpiSla;
  approvals: KpiApprovals;
  automation: KpiAutomation;
  quality: KpiQuality;
  jira: KpiJira;
  llm: KpiLlm;
  funnel: KpiFunnel;
  workload: KpiWorkload[];
}

// ---------------------------------------------------------------------------
// API payloads that are not persisted models (shapes from docs/SPEC.md §9)
// ---------------------------------------------------------------------------

export interface Onboarding {
  llm_configured: boolean;
  has_connectors: boolean;
  has_users: boolean;
  demo_installed: boolean;
}

export interface Bootstrap {
  settings: AppSettings;
  roles: RoleDef[];
  users: User[];
  teams: Team[];
  blueprints: Blueprint[];
  connectors: Connector[];
  operations: Operation[];
  onboarding: Onboarding;
}

export interface Health {
  ok: boolean;
  version: string;
  llm: { configured: boolean; model: string; provider: string };
  scheduler_running: boolean;
  counts: { projects_active: number; inbox?: number };
}

export interface LlmPreset {
  id: string;
  label: string;
  provider: LLMProviderKind;
  base_url: string;
  hint: string;              // one-line setup advice shown under the preset
}

export interface LlmModelInfo {
  name: string;
  size?: number | null;
  local: boolean;
  tools?: boolean | null;    // null = the server does not say (OpenAI-compatible listings)
  context?: number | null;
  // Ollama only:
  thinking?: boolean | null;
  vision?: boolean | null;
  family?: string;
  parameters?: string;       // e.g. "4.7B"
}

export interface LlmTestResult {
  ok: boolean;
  latency_ms: number;
  model: string;
  reply: string;
  error: string;
  provider: LLMProviderKind;
  base_url: string;
  local: boolean;            // false = prompts leave the machine (cloud model or remote host)
  tools: boolean | null;     // native tool calling declared by the model
  context: number | null;    // context window the client will request
  warnings: string[];        // setup advice (Ollama /v1 endpoint, cloud model, no tools, reasoning on)
}

export interface ToolCallResult {
  ok: boolean;
  data?: unknown;
  content_text: string;
  is_error: boolean;
  latency_ms: number;
  error: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface WatcherRunResult {
  ok: boolean;
  total: number;
  new: number;
  error: string;
  items_preview: Record<string, unknown>[];
}

export interface ChainVerification {
  ok: boolean;
  count: number;
  broken_at?: string | null;
}

export interface Briefing {
  markdown: string;
  generated_at: string;
  ai: boolean;   // false = deterministic summary (no LLM configured or it failed)
}

export interface CopilotReply {
  chat_id: string;
  messages: ChatMessage[];
}

export interface DemoInstallResult {
  created: { users: number; teams: number; connectors: number; operations: number; watchers: number };
  /** Live test of each sandbox connector right after the install. */
  connectors?: { id: string; name: string; ok: boolean; tool_count: number; error: string }[];
}

/** Full JSON backup (GET /admin/export) — collection name → documents. Opaque to the UI. */
export type Backup = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Step-type metadata for the UI (icons are lucide-react names, resolved in StepIcon.tsx)
// ---------------------------------------------------------------------------

/** Palette keys shared by step types, stages and badges (mapped to static Tailwind classes in ui.tsx). */
export type Tone =
  | 'zinc' | 'brand' | 'emerald' | 'sky' | 'amber' | 'rose' | 'violet'
  | 'indigo' | 'cyan' | 'fuchsia' | 'pink' | 'orange' | 'teal';

export interface StepTypeMeta {
  label: string;
  description: string;
  icon: string;
  color: Tone;
  /** true = the engine runs it (counts as AI/automation); false = a human acts. */
  automated: boolean;
}

export const STEP_TYPES: Record<StepType, StepTypeMeta> = {
  ai_task: {
    label: 'AI task',
    description: 'The local LLM drafts a document or structured JSON (spec, analysis, backlog, release notes).',
    icon: 'Sparkles', color: 'violet', automated: true,
  },
  human_form: {
    label: 'Human form',
    description: 'A person fills in a form, optionally pre-drafted by the AI.',
    icon: 'ClipboardPen', color: 'sky', automated: false,
  },
  approval: {
    label: 'Approval',
    description: 'Sign-off by one or several roles (all / any / quorum) with an AI decision brief.',
    icon: 'Stamp', color: 'amber', automated: false,
  },
  estimation: {
    label: 'Estimation',
    description: 'A team sizes the work in days or points, with an AI suggestion to start from.',
    icon: 'Calculator', color: 'cyan', automated: false,
  },
  mcp_operation: {
    label: 'MCP operation',
    description: 'Calls a configured MCP operation (e.g. create a Jira epic). Sensitive writes ask for confirmation.',
    icon: 'Plug', color: 'brand', automated: true,
  },
  agent_task: {
    label: 'Agent task',
    description: 'A bounded tool-calling agent pursues a goal over MCP tools; writes can require approval.',
    icon: 'Bot', color: 'fuchsia', automated: true,
  },
  quality_gate: {
    label: 'Quality gate',
    description: 'The AI checks compliance rules against the evidence; blocking findings need a decision.',
    icon: 'ShieldCheck', color: 'emerald', automated: true,
  },
  fan_out: {
    label: 'Fan-out',
    description: 'Starts one child project per item (e.g. per missing MCP) and waits for them.',
    icon: 'GitFork', color: 'indigo', automated: true,
  },
  notify: {
    label: 'Notify',
    description: 'Tells the right people, in-app and/or through an external channel operation.',
    icon: 'Megaphone', color: 'pink', automated: true,
  },
  wait_for: {
    label: 'Wait for',
    description: 'Polls an external system until a condition is true (e.g. Jira epic Done).',
    icon: 'Hourglass', color: 'teal', automated: true,
  },
};

export const STEP_TYPE_ORDER: StepType[] = [
  'ai_task', 'human_form', 'approval', 'estimation', 'mcp_operation',
  'agent_task', 'quality_gate', 'fan_out', 'notify', 'wait_for',
];

/** Statuses in which a step is waiting for a person (drives inbox-like highlights). */
export const HUMAN_WAIT_STATUSES: StepStatus[] = ['waiting_human', 'waiting_approval'];
/** Terminal statuses: the step will not move again unless reopened. */
export const STEP_TERMINAL_STATUSES: StepStatus[] = ['done', 'skipped', 'failed', 'rejected'];
