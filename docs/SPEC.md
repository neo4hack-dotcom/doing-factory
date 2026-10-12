# DOINg.AI Factory — Product & Technical Specification (contract)

> Single source of truth for every contributor. If code and this spec disagree, fix one of them
> in the same change. UI is **100 % English**.

DOINg.AI Factory is an end-to-end **delivery factory**. It polls external systems (first of all the
**DOINg.AI** portfolio MCP server) on a configurable schedule, detects new projects / use cases, and
runs **configurable, multi-stage workflows ("Blueprints")** that coordinate sponsors, business users,
PMs, developers, IT, security and compliance — using a **local LLM** (Ollama or any OpenAI-compatible
server) for orchestration, drafting, rewording, Jira writing, estimation hints, test design, compliance
QA and agentic steps over MCP tools.

Reference example (must work end to end with the bundled sandbox):
1. A sponsor creates a use case in DOINg.AI → a **Watcher** polling the DOINg.AI MCP detects it.
2. The Factory creates a **Project** from the "Use Case Onboarding" blueprint.
3. An agent analyses dependencies, finds the use case needs 5 MCP servers, checks the DOINg.AI MCP
   catalog: 3 exist, 2 are missing.
4. A **fan-out** step starts one child project per missing MCP from the "MCP Delivery" blueprint:
   specification (PM/user fills, AI drafts) → Jira epic find-or-create in the right team (Jira MCP)
   → spec sign-off → dev estimation → Jira stories → test sets → IT-compliance quality gate →
   production release ticket → multi-party approval (IT, sponsor, security) → registration in the
   DOINg.AI catalog → stakeholder notification.
5. When every child is delivered, the parent proceeds to go-live readiness and closure.

---

## 0. Conventions

| Item | Value |
|---|---|
| Folder | `/Users/mathieumasson/CLAUDE/doing-factory` (`backend/`, `frontend/`, `docs/`) |
| Ports | web **3070**, API **3071** (3000/3001…3061 are used by the user's other apps) |
| Env prefix | `FACTORY_` (`backend/.env`, never committed) |
| Python | 3.12, venv at `backend/.venv` |
| Backend deps | `fastapi`, `uvicorn[standard]`, `pydantic>=2.9`, `pydantic-settings`, `httpx`, `jinja2`, `pytest` (dev). **No MCP SDK**: the MCP client is the hand-written JSON-RPC 2.0 client ported from the user's AGENT project (`agent/backend/app/mcp/protocol.py` + `registry.py`, protocol `2025-06-18`, stdio + streamable HTTP + SSE), the bundled MCP servers use the stdlib helper ported from `agent/mcp_servers/_mcp_stdio.py`, and the Factory's own `/mcp` endpoint is a small JSON-RPC handler. |
| Frontend | React 19 + TypeScript (strict) + Vite 6 + Tailwind 3.4 (class dark mode) + `lucide-react`. No router lib (tiny hash router in `lib/router.ts`), no state lib (React Context). No chart lib (hand-rolled SVG). No markdown lib (ported safe renderer). |
| Persistence | SQLite document store `backend/data/factory.db` (WAL) — see §2 |
| Philosophy | **Starts clean, degrades honestly.** App boots with nothing configured. Anything that needs the LLM or an MCP connector fails *at use time* with an actionable message (e.g. "No LLM configured — open Settings › AI Model"). Never fabricate an LLM answer or a tool result. Sandbox connectors exist but are clearly labelled **Sandbox** and only installed on explicit request. |
| IDs | `uuid4().hex[:12]` prefixed: `usr_`, `team_`, `con_`, `op_`, `bp_`, `prj_`, `wat_`, `int_`, `ntf_`, `evt_`, `rule_`, `art_`, `lnk_`, `chat_` |
| Timestamps | ISO-8601 UTC strings (`2026-10-11T14:03:00Z`) everywhere in JSON |
| Field naming | snake_case in Python **and** TypeScript (types.ts mirrors models.py verbatim) |

---

## 1. Backend layout

```
backend/
  app/
    main.py            FastAPI app, lifespan (store init, seed defaults, engine recovery, scheduler start/stop), routers, /mcp mount, SPA serving
    config.py          Settings(BaseSettings, env_prefix="FACTORY_")
    deps.py            Container: settings, store, bus, llm, ai, mcp, ops, engine, notifier, scheduler, watchers
    models.py          ALL pydantic models (this spec §3) — the contract
    errors.py          FactoryError hierarchy (written) → mapped to HTTP status in main.py
    util.py            new_id(prefix), now_iso(), parse_iso(), parse_json(text), truncate(), slugify(), mask_secret()
    store.py           SQLite document store (§2)
    events.py          EventBus (in-process pub/sub → WebSocket fan-out)
    llm/client.py      LLMClient (Ollama native + OpenAI-compatible), presets, list_models, test
    llm/runtime.py     AIRuntime: ask()/ask_json()/ask_tools() + prompt registry + metrics (LLMCall)
    llm/prompts.py     DEFAULT_PROMPTS (editable copies stored in `prompts` collection)
    mcp/protocol.py    JSON-RPC transports (stdio/http/sse) + McpClient (port of AGENT protocol.py with its 4 documented fixes)
    mcp/manager.py     MCPManager: persistent connections per connector, tool index, call_tool (never raises), test
    mcp/operations.py  OperationExecutor: run an Operation in direct | llm | agent mode
    mcp/agent.py       Bounded tool-calling agent over MCP tools (+ resumable state), LoopGuard
    engine/templating.py  Jinja2 SandboxedEnvironment: render(), render_obj(), evaluate(), condition()
    engine/guard.py    LoopGuard + critic()
    engine/blueprint.py   validate_blueprint(), instantiate stages/steps, resolve assignees
    engine/context.py  StepCtx / StepOutcome contract (written, do not change without updating §12)
    engine/executors_flow.py  human_form, approval, estimation, fan_out, notify, wait_for activation/completion
    engine/executors_ai.py    ai_task, mcp_operation, agent_task, quality_gate + AI helpers (drafts, briefs, critic)
    engine/engine.py   WorkflowEngine (create/advance/complete/decide/confirm/retry/skip/reopen/cancel, recovery)
    scheduler.py       periodic loop: watchers, wait_for polling, SLA checks, risk recompute, intake enrichment, daily digest
    watchers.py        WatcherService.run(watcher) → intake items / auto-started projects
    notify.py          Notifier: in-app notifications + optional external channel Operation
    digest.py          daily digest notification per user (deterministic, from the inbox + risk)
    dossier.py         project dossier: deterministic Markdown audit pack (GET /projects/{id}/dossier)
    risk.py            deterministic risk score + reasons
    kpis.py            KPI computation
    inbox.py           derive inbox items for a user from projects + intake
    copilot.py         "Ask the Factory" chat with internal read-only tools
    factory_mcp.py     the Factory exposed as an MCP server (streamable HTTP at /mcp)
    seed/defaults.py   default roles, prompts, compliance rules, blueprints (templates, always seeded if missing)
    seed/demo.py       demo installer: users, teams, sandbox connectors, operations, watchers
    api/routes_*.py    one router per concern (system, settings, people, connectors, operations, blueprints, projects, inbox, intake, watchers, library, ai, admin)
    api/ws.py          WebSocket /api/ws
  mcp_servers/
    _mcp_stdio.py      stdlib MCP stdio server helper (ported from agent/mcp_servers/_mcp_stdio.py)
    doing_ai_mcp.py    "DOINg.AI Portfolio" MCP server — mode `sandbox` (local JSON state, seeded) or `bridge` (env DOING_AI_URL → reads the real DOINg.AI `GET /api/data`, read-only)
    jira_mcp.py        "Jira (Sandbox)" MCP server — tool names mirror sooperset/mcp-atlassian
  data/                runtime (gitignored): factory.db, sandbox/*.json
  tests/               pytest
  requirements.txt
```

---

## 2. Store (SQLite document store)

`store.py` — one table per concern is overkill; use a generic document table plus two append-only tables.

```sql
CREATE TABLE docs (coll TEXT, id TEXT, data TEXT, version INTEGER, updated_at TEXT, PRIMARY KEY (coll, id));
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, ts TEXT, kind TEXT, project_id TEXT, actor TEXT, data TEXT, hash TEXT);  -- hash = sha256(prev_hash + '\n' + canonical JSON of the event): tamper-evident audit chain
CREATE TABLE llm_calls (id TEXT PRIMARY KEY, ts TEXT, role TEXT, model TEXT, ok INTEGER, latency_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER, project_id TEXT, step_id TEXT, error TEXT);
CREATE INDEX ... on events(project_id, ts), events(ts), llm_calls(ts)
```

API (sync, cheap, called from async code; guarded by a `threading.RLock`; WAL mode):
```python
class Store:
    def get(self, coll: str, id: str) -> dict | None
    def list(self, coll: str) -> list[dict]                 # all docs of a collection
    def put(self, coll: str, doc: dict) -> dict             # upsert by doc["id"], bumps version, sets updated_at
    def delete(self, coll: str, id: str) -> bool
    def get_singleton(self, coll: str, default: dict) -> dict   # id = "singleton"
    def put_singleton(self, coll: str, doc: dict) -> dict
    def add_event(self, ev: dict) -> dict                   # computes the chained hash
    def verify_events(self) -> dict                         # {ok, count, broken_at: event id | None}
    def llm_stats(self, project_id: str) -> dict            # {calls, tokens_in, tokens_out}
    def list_events(self, *, project_id=None, kinds=None, limit=200, before=None) -> list[dict]
    def add_llm_call(self, call: dict) -> None
    def list_llm_calls(self, *, since: str | None = None) -> list[dict]
    def next_seq(self, name: str) -> int                    # monotonic counters (project keys)
```
Collections: `users, teams, roles(singleton), settings(singleton), connectors, operations, blueprints, projects, watchers, intake, notifications, prompts, rules, chats`.

**Concurrency**: the engine is the only writer of `projects` state transitions and it serialises
work per project with an `asyncio.Lock` per project id. API mutations on projects go through the
engine. Other collections are last-write-wins.

---

## 3. Data model (`app/models.py` ⇄ `frontend/src/types.ts`)

All models are pydantic `BaseModel` with defaults so a partial dict validates. Literal unions below
are exhaustive — do not add values without updating this spec and `types.ts`.

> **`backend/app/models.py` is authoritative** for the exact field list (it is already written; it has a few fields this outline omits, e.g. Connector.slug, ToolInfo.read_only, StepRun.next_poll_at). The
> outline below is the readable summary; typed step configs (`AiTaskConfig`, `HumanFormConfig`, …,
> `STEP_CONFIG_MODELS`) live there too.

### 3.1 Settings (singleton `settings`)
```
LLMSettings:  provider: 'ollama'|'openai' = 'ollama'      # 'openai' = any OpenAI-compatible server
              base_url: str = ''        # '' = NOT configured (UnconfiguredLLM)
              api_key: str = ''         # never returned in clear: GET returns '' + has_api_key=true
              model: str = ''           # main model (orchestration, drafting, agents)
              fast_model: str = ''      # optional cheaper model for reword/classify/critic ('' = model)
              temperature: float = 0.2
              num_ctx: int = 0          # 0 = auto: Ollama window = min(model max, 16384 local / 65536 remote '-cloud' models)
              max_tokens: int = 0       # 0 = provider default
              timeout_s: int = 240
              tool_mode: 'auto'|'native'|'json' = 'auto'   # agent tool-calling strategy
              think: bool = False       # reasoning for thinking models (qwen3.5, gemma4…); sent only when the model declares 'thinking' — keep False for speed
EngineSettings: autonomy: 'supervised'|'approve_writes'|'full' = 'approve_writes'
              max_retries: int = 2; max_agent_actions: int = 8; agent_timeout_s: int = 600
              critic_enabled: bool = True; parallel_steps: int = 3; context_chars: int = 6000
SchedulerSettings: enabled: bool = True; tick_s: int = 20; sla_check_minutes: int = 15
              business_hours_start: int = 9; business_hours_end: int = 18; timezone: str = 'Europe/Paris'
NotificationSettings: in_app: bool = True; channel_operation_key: str = ''   # Operation used to send external messages (email/Teams MCP); '' = in-app only
              digest_enabled: bool = False
GeneralSettings: app_name: str = 'DOINg.AI Factory'; company: str = ''
              hours_saved: dict[str, float] = {ai_task: 3, mcp_operation: 0.5, agent_task: 4, quality_gate: 6, notify: 0.5, fan_out: 1, wait_for: 0.5, human_form_ai_draft: 2, estimation_ai: 2, approval_brief: 0.5}
AppSettings:  llm, engine, scheduler, notifications, general   (+ has_api_key: bool on read)
```

### 3.2 People
```
RoleDef:  key: str, label: str, description: str = '', color: str = 'zinc'
          defaults: sponsor, product_manager, business_user, developer, dev_lead, it_ops, security, compliance, admin
User:     id, name, email, title='', roles: list[str]=[], team_ids: list[str]=[], active=True, avatar_color='', created_at
Team:     id, name, description='', jira_project_key='', jira_component='', skills: list[str]=[], lead_user_id='', member_ids: list[str]=[], created_at
```

### 3.3 Connectors & Operations
```
ToolInfo: name, description='', input_schema: dict = {}, sensitive: bool = False
ConnectorStatus: ok: bool|None = None, checked_at: str|None, error: str = '', latency_ms: int = 0, server_name: str = '', server_version: str = '', tool_count: int = 0
Connector: id, name, kind: 'portfolio'|'jira'|'notification'|'git'|'docs'|'other' = 'other', description='',
           transport: 'stdio'|'http'|'sse' = 'http',
           command='', args: list[str]=[], env: dict[str,str]={}, cwd='',      # stdio
           url='', headers: dict[str,str]={},                                   # http/sse (header values masked on read)
           enabled=True, timeout_s=60, sandbox=False,
           status: ConnectorStatus, tools: list[ToolInfo]=[], created_at, updated_at
FieldDef: key, label, type: 'text'|'textarea'|'markdown'|'number'|'select'|'multiselect'|'date'|'user'|'users'|'team'|'checkbox'|'list'|'url' = 'text',
          required=False, options: list[str]=[], help='', placeholder='', default: Any = None
OperationOutput: extract: str = ''        # Jinja expression over `result` (parsed tool output). '' = whole result. ex: "result.projects"
                 json_schema: dict|None    # optional JSON schema: llm/agent mode final structured output
Operation: id, key (unique slug, e.g. "portfolio.list_new_use_cases"), name, description='',
           connector_id, mode: 'direct'|'llm'|'agent' = 'direct',
           tool='',                       # direct & llm: target tool
           args_template: dict = {}       # direct: JSON whose string values are Jinja templates; ctx = {input, project, vars, ...}
           prompt='',                     # llm: how to build the args from input; agent: goal template
           allowed_tools: list[str]=[],   # agent: allowed tool names ([] = all tools of the connector)
           output: OperationOutput, sensitive=False, inputs: list[FieldDef]=[], test_input: dict = {},
           created_at, updated_at
OperationResult: ok: bool, output: Any = None, raw: Any = None, summary='', error='', latency_ms=0,
                 tool='', args: dict = {}, trace: list[TraceEntry] = []
```

### 3.4 Blueprints (workflow templates)
```
StepType = 'ai_task'|'human_form'|'approval'|'estimation'|'mcp_operation'|'agent_task'|'quality_gate'|'fan_out'|'notify'|'wait_for'
Assignee: roles: list[str]=[], user_ids: list[str]=[], project_role: ''|'sponsor'|'owner'|'team_lead'|'team' = ''
StepDef:  id (slug unique in blueprint), name, type: StepType, description='',
          assignee: Assignee, sla_hours: float|None = None,
          when='',          # Jinja condition; falsy → step skipped
          store_as='',      # output stored in project.vars[store_as]
          auto_start=True,  # False → waits for a human to press "Start"
          config: dict = {} # type-specific, see §5
StageDef: id, name, description='', color='indigo', parallel=False, steps: list[StepDef]
Blueprint: id, key, name, description='', kind='custom', icon='Workflow', color='indigo',
           key_prefix='PRJ', version=1, status: 'active'|'draft'|'archived' = 'active',
           autonomy: ''|'supervised'|'approve_writes'|'full' = ''   # '' = global setting
           inputs: list[FieldDef]=[], stages: list[StageDef]=[], builtin=False, created_at, updated_at
```

### 3.5 Projects (workflow instances)
```
ProjectStatus = 'active'|'waiting'|'blocked'|'done'|'cancelled'|'failed'
StepStatus = 'pending'|'running'|'waiting_human'|'waiting_approval'|'waiting_children'|'waiting_external'|'done'|'skipped'|'failed'|'rejected'
TraceEntry: ts, kind: 'info'|'thought'|'tool'|'result'|'error'|'human'|'ai' = 'info', agent='', text, data: Any = None
Approval:   user_id, role, decision: 'approved'|'rejected', comment='', at
CheckResult: rule_id, code='', title, severity: 'low'|'medium'|'high'|'critical', status: 'pass'|'fail'|'warn'|'na'|'pending',
             evidence='', recommendation='', overridden_by='', override_comment=''
Estimate:   value: float|None, unit: 'days'|'points' = 'days', confidence: 'low'|'medium'|'high' = 'medium',
            breakdown: list[{item: str, value: float}] = [], rationale='', submitted_by='', ai_suggestion: dict|None
PendingAction: kind: 'confirm_operation'|'agent_tool_call'|'gate_review'|'ai_review', title, description='',
               payload: dict = {}, created_at
StepRun:    id, name, type, description='', config: dict, assignee: Assignee,
            assignee_user_ids: list[str] = [],   # resolved at activation
            status: StepStatus='pending', when='', store_as='', sla_hours, due_at: str|None, sla_breached=False,
            auto_start=True, started_at, completed_at, completed_by='', attempts=0, error='', heal_hint='',
            output: Any = None, output_summary='', form: dict = {}, ai_draft: dict|None = None, ai_busy=False,
            approvals: list[Approval]=[], brief='',            # brief = AI decision memo for approvers
            checks: list[CheckResult]=[], estimate: Estimate|None, pending_action: PendingAction|None,
            child_ids: list[str]=[], agent_state: dict|None = None,   # resumable agent transcript
            feedback='',                                       # reviewer feedback when re-opened
            trace: list[TraceEntry]=[]                          # capped at 300 entries
StageRun:   id, name, description='', color, parallel, status: 'pending'|'active'|'done'|'skipped' = 'pending',
            started_at, completed_at, steps: list[StepRun]
Artifact:   id, step_id='', title, kind: 'markdown'|'json' = 'markdown', content='', data: Any = None,
            version=1, history: list[{version, content, updated_by, updated_at}] = [] (last 10),
            created_at, updated_at, updated_by=''
Link:       id, kind: 'jira'|'mcp'|'url'|'doc' = 'url', label, url='', external_id='', status='', step_id='', created_at
Risk:       score: int = 0 (0-100), level: 'low'|'medium'|'high' = 'low', reasons: list[str]=[], computed_at
ProjectMetrics: llm_calls=0, tokens_in=0, tokens_out=0, ai_steps=0, human_steps=0, hours_saved=0.0
ProjectSource: type: 'manual'|'watcher'|'fan_out'|'copilot'|'api' = 'manual', watcher_id='', intake_id='', connector_id='', external_id='', url='', raw: dict = {}
Project:    id, key ('UC-0007'), title, description='', blueprint_id, blueprint_name, blueprint_version, kind,
            status: ProjectStatus='active', priority: 'low'|'medium'|'high'|'critical' = 'medium',
            sponsor_id='', owner_id='', team_id='', stakeholder_ids: list[str]=[], tags: list[str]=[], due_date: str|None,
            inputs: dict = {}, vars: dict = {}, source: ProjectSource,
            parent_id='', parent_step_id='', child_ids: list[str]=[],
            stages: list[StageRun], current_stage_id='', artifacts: list[Artifact]=[], links: list[Link]=[],
            risk: Risk, ai_summary='', metrics: ProjectMetrics, autonomy='' (copied from blueprint),
            created_by='', created_at, updated_at, started_at, completed_at: str|None
ProjectSummary (list view): id, key, title, kind, blueprint_id, blueprint_name, status, priority, sponsor_id, owner_id, team_id,
            current_stage_id, current_stage_name, progress (0-1 = done+skipped steps / total), open_step_names: list[str],
            risk: Risk, parent_id, child_count, children_done, due_date, created_at, updated_at, completed_at, tags
```

### 3.6 Watchers, intake, notifications, events
```
WatcherSchedule: every_minutes: int = 15, active_hours_start: int|None, active_hours_end: int|None, days: list[int] = []  # ISO weekday 1-7, [] = every day
WatcherState: last_run_at, next_run_at, last_status: ''|'ok'|'error' = '', last_error='', last_count=0, last_new=0, runs=0, new_total=0, seen_keys: list[str] = [] (cap 5000)
Watcher: id, name, description='', enabled=True, operation_key, input: dict = {}, schedule: WatcherSchedule,
         items_expr='result',     # Jinja expression over `result` → list
         key_field='id', title_field='title', filter='',   # Jinja condition with `item`
         action: 'intake'|'auto_start' = 'intake', blueprint_id='',
         mapping: dict[str, str] = {}   # project field or input key → Jinja template with `item` (keys: title, description, priority, sponsor_email, tags, inputs.<key>)
         baseline_on_first_run=False, state: WatcherState, created_at, updated_at
IntakeSuggestion: blueprint_id='', priority='', team_id='', sponsor_id='', rationale='', summary='', required_capabilities: list[str]=[]
IntakeItem: id, watcher_id, watcher_name, external_id, title, raw: dict, status: 'new'|'accepted'|'dismissed' = 'new',
            suggestion: IntakeSuggestion|None, ai_busy=False, project_id='', detected_at, decided_by='', decided_at, dismiss_reason=''
Notification: id, user_id, kind: 'task'|'approval'|'info'|'warning'|'success'|'mention' = 'info', title, body='',
              project_id='', step_id='', read=False, created_at
Event (activity/audit): id, ts, kind (dot.case, see §8), actor ('usr_…' | 'ai' | 'system' | 'scheduler'), project_id='', step_id='', message, data: dict = {}
LLMCall: id, ts, role, model, ok, latency_ms, tokens_in, tokens_out, project_id='', step_id='', error=''
PromptDef: key, name, description='', content, default_content, updated_at
Rule: id, code, title, description='', category: 'Security'|'Data'|'Operations'|'Architecture'|'Legal'|'Quality' = 'Quality',
      severity: 'low'|'medium'|'high'|'critical' = 'medium', tags: list[str]=[], check: 'ai'|'manual' = 'ai', guidance='', enabled=True
InboxItem: id ("{project_id}:{step_id}" or "intake:{id}"), kind: 'form'|'approval'|'estimate'|'review'|'confirm'|'gate'|'failure'|'start'|'external'|'intake',
           project_id='', project_key='', project_title='', step_id='', step_name='', title, subtitle='',
           priority, due_at: str|None, overdue=False, created_at, risk_level=''
ChatMessage: role: 'user'|'assistant', content, tool_calls: list[{name, args, summary}] = [], links: list[{label, project_id}] = [], ts
```

---

## 4. Templating & context (engine/templating.py)

Jinja2 `SandboxedEnvironment(undefined=ChainableUndefined, autoescape=False)` with filters `tojson`,
`bullets` (list → "- a\n- b"), `truncate_chars(n)`, `slug`. Functions:
- `render(template: str, ctx) -> str`
- `render_obj(obj, ctx)` — recursively renders strings in dicts/lists. A string that is *exactly* one
  expression `{{ expr }}` returns the native value (list/dict/number), not its string.
- `evaluate(expr: str, ctx) -> Any` (compile_expression) and `condition(expr, ctx) -> bool` ('' → True).
Render errors raise `TemplateError` with the template excerpt (never silently produce '').

Step context (`engine.build_context(project, step)`):
```
project: {id,key,title,description,priority,status,tags,due_date,kind}, inputs, vars,
sponsor / owner / team (dicts or None), parent ({id,key,title,inputs,vars} or None),
teams: [{id,name,description,skills,jira_project_key,jira_component}] (all teams — lets prompts route work),
step: {id,name,type}, feedback (reviewer feedback for this step or ''), now (ISO), item (fan_out only)
```
For every LLM step the engine also appends a compact **project brief** (title, description, inputs,
latest artifacts truncated to `engine.context_chars`) unless `config.include_context == false`.

---

## 5. Step types (closed vocabulary) — config & behaviour

| type | config keys | activation → completion |
|---|---|---|
| `ai_task` | `prompt` (Jinja), `system_prompt` (prompt key, default `writer`), `output`: 'markdown'\|'json', `json_schema`, `artifact_title`, `review` (bool) | running → LLM → artifact + vars → `done`; if `review` (or autonomy `supervised`) → `waiting_human` with `pending_action.kind='ai_review'` (edit / regenerate with instructions / approve) |
| `human_form` | `fields: FieldDef[]`, `instructions`, `ai_prefill` (Jinja prompt, '' = none), `artifact_title` | `waiting_human`; if `ai_prefill` and LLM configured → background draft fills `ai_draft` (+ `form` empty fields). Complete → validation of required fields → vars + markdown artifact |
| `approval` | `approvers: [{role, label}]`, `policy`: 'all'\|'any'\|'quorum', `quorum`, `on_reject`: {`action`: 'reopen'\|'fail', `goto_step`: step id ('' = previous step)}, `brief_prompt`, `show_vars: [names]` | `waiting_approval`; AI writes `brief` in background. `all` = every listed role must approve (one approval per role, any user holding the role or explicitly assigned); `any` = first approval; `quorum` = n approvals. Any rejection → `on_reject` |
| `estimation` | `unit`, `ai_suggest` (bool), `prompt`, `require_breakdown` | `waiting_human` (assignee: dev lead/team); AI suggestion stored in `estimate.ai_suggestion`; submit → `estimate` + vars |
| `mcp_operation` | `operation_key`, `input` (dict, Jinja), `create_link`: {kind, label (Jinja), url (Jinja over `output`), external_id (Jinja)} optional | running → OperationExecutor. If operation `sensitive` and autonomy ≠ `full` → build args first, then `waiting_human` with `pending_action.kind='confirm_operation'` (payload `{tool, args, operation_key}` editable) → confirm executes |
| `agent_task` | `goal` (Jinja), `connector_ids` ([] = all enabled), `allowed_tools`, `max_actions`, `output_schema`, `artifact_title` | running → bounded agent loop (§6). Sensitive tool call under `approve_writes` → persists `agent_state`, `waiting_human` with `pending_action.kind='agent_tool_call'`; confirm → executes the call, resumes loop |
| `quality_gate` | `rule_tags` ([] = all enabled), `rule_ids`, `evidence` ([var names], [] = all vars + artifacts), `block_on`: 'critical'\|'high'\|'medium'\|'any' (default 'high'), `override_roles` | running → AI evaluates rules in batches of 4 → `checks`. Manual rules → `pending`. If any blocking fail or pending manual → `waiting_human` (`pending_action.kind='gate_review'`): override (role-gated, comment required), send back (reopen step), re-run. Else `done` |
| `fan_out` | `items` (Jinja expr → list), `blueprint_key`, `title` (Jinja with `item`), `inputs` (dict Jinja with `item`), `wait`: 'all'\|'none', `inherit`: [sponsor, owner, team, priority] | creates child projects (source.type='fan_out'), `child_ids`; `wait=all` → `waiting_children` until all children `done`/`cancelled` (any child `failed` → stays waiting, flagged). Empty list → `done` "No items" |
| `notify` | `audience`: [{role}\|{project_role}\|{user_id}], `subject` (Jinja), `prompt` (Jinja; LLM writes body) or `body` (Jinja, no LLM), `channel`: 'in_app'\|'external'\|'both' | resolves users → in-app notifications (+ external via settings.notifications.channel_operation_key) → `done` |
| `wait_for` | `operation_key`, `input`, `until` (Jinja condition over `output`), `poll_minutes`, `timeout_hours`, `manual_complete` (bool) | `waiting_external`; scheduler polls; condition true → `done`; timeout → `failed`. Manual complete allowed if flag |

Common rules:
- `when` false → `skipped` (trace says why).
- `store_as` → `project.vars[store_as] = output`. Missing `store_as` → `vars[step.id]`.
- `sla_hours` → `due_at` set at activation; scheduler flags `sla_breached` and notifies once.
- Stage `parallel=true` → all its eligible steps activate together (bounded by `engine.parallel_steps`); otherwise sequential.
- Stage done when all steps are `done`/`skipped`. Project done when all stages done → `completed_at`, notify sponsor+owner, kick parent.
- Automated failure → retry up to `engine.max_retries` with critic advice (`heal_hint`) unless LoopGuard says stagnant → `failed`, project `blocked`, inbox `failure` item for owner/admins (actions: retry, skip, complete manually with output, edit config & retry).
- Rejection reopen: the target step and every later step up to the approval are reset to `pending` (approvals cleared, trace kept, `feedback` set on the target step), `current_stage_id` moves back, project `active`.
- Every transition → `Event` + bus `project.updated`.
- Engine restart recovery: `ai_busy=false` everywhere; steps `running` of side-effect-free types (`ai_task`, `quality_gate`) → `pending` and re-run; steps `running` of other types (`mcp_operation`, `agent_task`, `notify`, `fan_out`) → `failed` with "Interrupted by a server restart — press Retry" (a write may or may not have happened; a human decides). Waiting states are persisted and survive restarts.

---

## 6. LLM layer

`LLMClient` (llm/client.py), built from `AppSettings.llm`, hot-swapped on save:
```python
@dataclass class LLMReply: content: str; tool_calls: list[dict]; tokens_in: int; tokens_out: int; latency_ms: int; model: str; finish_reason: str
class LLMClient:
    configured: bool
    async def chat(self, messages, *, model=None, temperature=None, json_mode=False, schema=None, tools=None, max_tokens=None) -> LLMReply
    async def list_models(self) -> list[dict]          # {name, size, local: bool, tools: bool|None, context: int|None}
    async def test(self) -> dict                       # {ok, latency_ms, model, reply, error}
```
- `provider='ollama'`: native `POST {base}/api/chat` with `options.num_ctx` (auto = min(model ctx from `/api/show`, 16384 local / 65536 for `-cloud`/`:cloud` tags), `options.temperature`, `options.num_predict`), `format: "json"` or JSON schema, `tools`. `base_url` given without `/v1`. Check `done_reason == "length"` → raise `LLMError("context window too small …")`.
- `provider='openai'`: `POST {base}/chat/completions` (base includes `/v1`), `response_format` json_object (retry without on 400), `tools`.
- Retries: 2 on connect errors / 5xx / 429 with backoff. Timeout `timeout_s`.
- Unconfigured → every call raises `LLMNotConfigured("No LLM configured — open Settings › AI Model")`.

`AIRuntime` (llm/runtime.py): `ask(role, prompt_key|system, user, *, json=False, schema=None, fast=False, project_id='', step_id='', temperature=None) -> str|dict` — loads the system prompt from the `prompts` collection (fallback DEFAULT_PROMPTS), records an `LLMCall`, updates project metrics, emits bus `llm.call`. JSON: tolerant `parse_json` + one repair round-trip ("Return ONLY valid JSON matching …") then `LLMError`. `ask_tools(...)` for agent loops.

Default prompt keys: `orchestrator, writer, rewriter, critic, spec_writer, jira_writer, test_designer, estimator, compliance_auditor, dependency_analyst, intake_analyst, notifier, approval_brief, status_reporter, risk_explainer, copilot, op_args_builder, agent, blueprint_designer, briefing`.

Agent loop (mcp/agent.py): native tool calling when the model supports tools (`tool_mode`), else JSON
decide-act (`{"thought","action":"tool"|"finish","tool","args","final"}`). Tools are namespaced
`<connector_slug>__<tool>`. Budget injected into the prompt; LoopGuard (structural signature
tool+args-keys) stops repeats; max actions; timeout; tool results truncated to 4 000 chars in the
transcript; anti-ellipsis: reject args containing "..." placeholders for data fields. Sensitive tool =
name/description matches `create|update|delete|remove|send|post|write|insert|transition|publish|register|approve` or
MCP annotation `destructiveHint`. State `{messages, actions_used, history}` is JSON-serialisable and
stored in `step.agent_state` so the loop resumes after a confirmation or a restart.

---

## 7. MCP layer

`MCPManager` (mcp/manager.py): `test(connector) -> ConnectorStatus + tools`, `list_tools(connector, refresh=False)`,
`call_tool(connector, tool, args, timeout_s=None) -> {ok, content_text, data (parsed JSON if possible), is_error, latency_ms}`.
Persistent connection per connector (lazy connect, per-connector lock, rebuilt when it died or its launch config
changed; a request that never reached the server is resent once, a delivered one never). Stdio servers are
long-lived child processes (`sys.executable` for bundled servers). Transports: stdio, streamable HTTP, SSE (URL
ending with `/sse` or transport='sse'). Errors flattened into readable messages incl. the server's stderr tail.
`call_tool` returns `{ok, tool, text, data, is_error, latency_ms, error, truncated?}`; the HTTP route
`POST /connectors/{id}/call` exposes `text` as `content_text`. Sensitivity = MCP `destructiveHint`, or not
`readOnlyHint` and a write verb among the tool name's tokens (not its description).
Secrets: env/header values masked as `••••` on read; a masked value sent back on update keeps the stored one.

`OperationExecutor.run(op, input, *, ctx_extra=None, project_id='', step_id='', confirm_args=None, prepare_only=False) -> OperationResult`
- `direct`: args = render_obj(args_template, {input, ...ctx}) → call tool → output = evaluate(extract, {result}).
- `llm`: LLM (`op_args_builder` prompt) receives op.prompt + tool JSON schema + input → args JSON → call → extract; if `schema` given, a second LLM pass maps the result to the schema.
- `agent`: run agent with goal = render(op.prompt), tools = allowed_tools of the connector.
- `prepare_only=True` → return the args that *would* be sent (used for the confirmation preview).

---

## 8. Events (bus → WebSocket `/api/ws`) and activity kinds

WS message = `{"type": str, ...payload}`:
- `hello` {version}
- `project.updated` {project_id, summary: ProjectSummary}
- `project.deleted` {project_id}
- `step.trace` {project_id, step_id, entry: TraceEntry}
- `activity` {event: Event}
- `notification` {notification: Notification}
- `intake.updated` {item: IntakeItem}
- `watcher.updated` {watcher: Watcher}
- `llm.call` {call: LLMCall}
- `copilot.progress` {chat_id, text}
- `settings.updated` {}
- `reference.updated` {collection: 'users'|'teams'|'roles'|'connectors'|'operations'|'blueprints'|'watchers'} — emitted by every mutation of reference data; the frontend store reloads bootstrap

Activity `Event.kind`: `project.created, project.completed, project.cancelled, project.blocked, project.updated, stage.started, stage.completed, step.started, step.completed, step.skipped, step.failed, step.retried, step.reopened, step.assigned, approval.approved, approval.rejected, form.submitted, estimate.submitted, operation.executed, agent.tool_call, gate.passed, gate.failed, gate.overridden, artifact.updated, comment.added, link.added, watcher.run, intake.detected, intake.accepted, intake.dismissed, notification.sent, settings.updated, connector.tested, blueprint.saved, demo.installed`.

---

## 9. REST API (all under `/api`; JSON; errors = HTTPException `{detail}`)

System: `GET /health` → `{ok, version, llm: {configured, model, provider}, scheduler_running, counts:{projects_active, inbox?}}` ·
`GET /bootstrap` → `{settings, roles, users, teams, blueprints (full), connectors, operations, onboarding: {llm_configured, has_connectors, has_users, demo_installed}}`

Settings: `GET /settings` · `PUT /settings` (deep-merge partial; `api_key` '' or masked keeps stored) · `GET /llm/presets` → `[{id,label,provider,base_url}]` · `POST /llm/test` body optional partial LLMSettings → `{ok, latency_ms, model, reply, error}` · `GET /llm/models?provider=&base_url=` → `{models: [...], error}`

People: `GET|POST /users`, `PUT|DELETE /users/{id}` · `GET|POST /teams`, `PUT|DELETE /teams/{id}` · `GET /roles`, `PUT /roles` (full list)

Connectors: `GET|POST /connectors`, `GET|PUT|DELETE /connectors/{id}` · `POST /connectors/{id}/test` → Connector · `POST /connectors/{id}/call` {tool, args} → `{ok, data, content_text, is_error, latency_ms, error}`

Operations: `GET|POST /operations`, `PUT|DELETE /operations/{id}` · `POST /operations/{id}/run` {input} → OperationResult · `POST /operations/suggest` {connector_id, intent} → Operation (draft, unsaved)

Blueprints: `GET|POST /blueprints`, `GET|PUT|DELETE /blueprints/{id}` · `POST /blueprints/{id}/duplicate` · `POST /blueprints/validate` (Blueprint) → `{ok, errors: [str], warnings: [str]}` · `POST /blueprints/generate` {description} → Blueprint (draft, unsaved)

Projects: `GET /projects?status=&blueprint_id=&q=&parent_id=&user_id=` → ProjectSummary[] · `POST /projects` {blueprint_id, title, description, inputs, priority, sponsor_id, owner_id, team_id, tags, due_date, created_by} → Project · `GET /projects/{id}` → Project · `PATCH /projects/{id}` {title?, description?, priority?, sponsor_id?, owner_id?, team_id?, tags?, due_date?, stakeholder_ids?, user_id} · `POST /projects/{id}/cancel` {user_id, reason} · `DELETE /projects/{id}` · `GET /projects/{id}/events` → Event[] · `POST /projects/{id}/comments` {user_id, text} → Event · `PUT /projects/{id}/artifacts/{artifact_id}` {user_id, content} → Artifact · `POST /projects/{id}/links` {kind,label,url,external_id} · `GET /projects/{id}/dossier` → `{filename, markdown}` (deterministic audit pack, no LLM) · `POST /projects/{id}/report` {audience: 'sponsor'|'team'|'executive'} → `{markdown}` · `POST /projects/{id}/explain-risk` → `{markdown}` · `POST /projects/{id}/summarize` → `{summary}`

Steps (`/projects/{id}/steps/{step_id}/…`, body always includes `user_id`): `start` · `save` {form} · `complete` {form?, output?} · `ai-draft` {instructions} (async; returns `{accepted:true}`; result via WS) · `decide` {decision, comment} · `estimate` {estimate} · `confirm` {approve, payload?} · `gate` {action:'override'|'rerun'|'send_back', comment, rule_ids?, goto_step?} · `retry` · `skip` {reason} · `reopen` {reason} · `reassign` {user_ids}. All return the updated Project.

Inbox: `GET /inbox?user_id=` → InboxItem[] (sorted: overdue, priority, due, created) · `GET /inbox/counts?user_id=` → `{total, approvals, forms, reviews, failures, intake}`

Intake: `GET /intake?status=` · `POST /intake/{id}/accept` {user_id, blueprint_id?, title?, priority?, sponsor_id?, team_id?, owner_id?} → Project · `POST /intake/{id}/dismiss` {user_id, reason} · `POST /intake/{id}/analyze` → IntakeItem (an AI failure — no LLM configured, model error — is recorded on the item as `ai_error` and returned with 200; 404 unknown id, 409 not new / already analysing)

Watchers: `GET|POST /watchers`, `PUT|DELETE /watchers/{id}` · `POST /watchers/{id}/run` → `{ok, total, new, error, items_preview}` · `POST /watchers/{id}/reset`

Library: `GET /prompts`, `PUT /prompts/{key}` {content}, `POST /prompts/{key}/reset` · `GET|POST /rules`, `PUT|DELETE /rules/{id}`

Notifications: `GET /notifications?user_id=&unread=` · `POST /notifications/read` {user_id, ids?: [], all?: bool}

Activity & KPIs: `GET /events?limit=&kind=&project_id=&before=` → Event[] · `GET /events/verify` → `{ok, count, broken_at}` · `GET /kpis?days=30` → Kpis (§10)

AI utilities: `POST /ai/rewrite` {text, style: 'professional'|'concise'|'executive'|'technical'|'friendly'|'fix'|'expand'|'bullets'|'jira', instructions?} → `{text}` · `GET /briefing?user_id=` → `{markdown, generated_at, ai: bool}` (cached 10 min per user; without LLM returns a deterministic summary with `ai:false`) · `POST /copilot` {user_id, chat_id?, message, project_id?} → `{chat_id, messages: ChatMessage[]}` · `GET /copilot/{chat_id}`

Admin: `POST /admin/demo/install` → `{created: {users, teams, connectors, operations, watchers}}` (idempotent) · `POST /admin/demo/simulate-use-case` {hint?} → `{use_case}` (LLM invents a realistic use case, created through the sandbox DOINg.AI MCP `create_use_case` tool) · `GET /admin/export` → full JSON backup · `POST /admin/import` (backup JSON, replaces collections) · `GET /admin/llm-calls?days=`

MCP: `/mcp` (streamable HTTP) — tools `factory_list_projects(status?)`, `factory_get_project(key_or_id)`, `factory_pending_approvals()`, `factory_kpis()`.

---

## 10. KPIs (`GET /kpis?days=N`)
```
Kpis: generated_at, days,
  totals: {active, waiting, blocked, done_period, cancelled, at_risk, intake_new, open_tasks, pending_approvals, children_in_flight}
  lead_time: {avg_days, median_days, p90_days, by_blueprint: [{blueprint, avg_days, count}]}
  throughput: [{week: 'YYYY-Www', created, completed}]   (12 weeks)
  stages: [{blueprint, stage, avg_hours, avg_wait_hours, count}]   → bottleneck heatmap
  sla: {on_time_pct, breached_open, breached_total}
  approvals: {avg_hours, rejection_rate, by_role: [{role, avg_hours, count, rejected}]}
  automation: {ai_steps, human_steps, ai_share, hours_saved, by_type: [{type, count, ai}]}
  quality: {gates_run, first_pass_rate, top_failing_rules: [{code, title, fails}]}
  jira: {issues_created}
  llm: {calls, tokens_in, tokens_out, avg_latency_ms, error_rate, by_role: [{role, calls, avg_latency_ms}], by_day: [{day, calls, tokens}]}
  funnel: {detected, accepted, active, done}
  workload: [{user_id, open_tasks, overdue}]
```

---

## 11. Frontend

```
frontend/src/
  main.tsx  App.tsx  api.ts (ONE typed client)  types.ts (mirror of models.py)  ws.ts (reconnecting WS)
  lib/  cls.ts  format.ts (dates, relative time, durations)  router.ts (hash router: useRoute(), navigate())  store.tsx (AppProvider: bootstrap data, current user/persona, theme, live event subscription)
  components/ ui.tsx (Button, IconButton, Card, Badge, StatusBadge, Avatar, Input, Textarea, Select, Toggle, Tabs, Modal, Drawer, EmptyState, Spinner, Skeleton, Tooltip, Kbd, ProgressBar, Stat, SectionHeader, ToastProvider/useToast, ConfirmProvider/useConfirm)
              Markdown.tsx  Charts.tsx (Line, Bar, StackedBar, Donut, Heatmap, Sparkline, Funnel, Gauge)  FormRenderer.tsx  AiRewrite.tsx (✨ menu for any textarea)
              CommandPalette.tsx (⌘K)  NotificationBell.tsx  PersonaSwitcher.tsx  CopilotPanel.tsx  Onboarding.tsx  Sidebar.tsx  Header.tsx
              StepIcon.tsx (icon+color per StepType/StepStatus)  PipelineStrip.tsx (compact stage progress)  DependencyGraph.tsx (SVG)
  views/ Home.tsx  Inbox.tsx  TaskPanel.tsx  Projects.tsx  ProjectDetail.tsx  NewProject.tsx  Floor.tsx  Intake.tsx  Kpis.tsx
         studio/Blueprints.tsx  studio/BlueprintDesigner.tsx  studio/Operations.tsx  studio/Prompts.tsx  studio/Rules.tsx
         settings/Settings.tsx (tabbed: AI Model, Connectors, Watchers, People & Teams, Notifications, Engine, General, Audit Log, Backup)
```

Routes (hash): `#/` Home · `#/inbox` · `#/inbox/:itemId` · `#/projects` · `#/projects/new` (NewProject) · `#/projects/:id` · `#/projects/:id/:stepId` · `#/floor` · `#/intake` · `#/kpis` · `#/studio/blueprints` · `#/studio/blueprints/:id` · `#/studio/operations` · `#/studio/prompts` · `#/studio/rules` · `#/settings/:tab`

Navigation (sidebar, collapsible): **Home**, **Inbox** (badge count), **Projects**, **Factory Floor** (live), **Intake** (badge), **KPIs** — section *Studio*: Blueprints, Operations, Prompts, Compliance Rules — bottom: **Settings**.
Header: ⌘K search, "Ask Factory" (copilot drawer), live WS dot, LLM badge (model, local vs cloud icon), notification bell, persona switcher ("Acting as"), theme toggle.

UX rules: ≤ 2 clicks from Home to any pending action (Inbox item → inline TaskPanel with primary action).
Every pending item exposes its primary action directly (Approve / Submit / Confirm / Retry). Every long
text field has ✨ AI (reword styles). Optimistic toasts. Skeletons while loading. Keyboard: ⌘K palette,
`g h/i/p/f/k` go-to, `j/k` move in lists, `a` approve, `r` reject (Inbox). Live updates via WS.

Design language — **DOINg family** (same brand as DOINg.AI and DOINg.Catalogue/DataLoom): brand **Pantone 340 C green**
`#009464` = RGB (0, 148, 100) (scale 50→950), dark "ink" neutrals (`#050505 … #3A3A45`) + Tailwind `zinc` for light mode,
**Inter self-hosted** (copy the woff2 files from `agent/frontend/public/fonts`, `@font-face` in index.css, system stack fallback; no CDN — offline/air-gap friendly), wordmark `DOINg<span class=text-brand>.AI</span>`
+ "FACTORY" micro-label. Clean, professional structure: `rounded-lg`/`rounded-xl` cards with 1px borders,
uppercase micro-labels (`label-xs`: 10px bold tracking-[0.16em]), bold tight headings, tabular numbers,
subtle brand grid background on hero areas, green→teal gradient reserved for AI/wow accents (AI buttons,
running steps, Floor tokens), status colours: emerald done, sky running, amber waiting, rose failed/blocked,
violet AI. Light + dark mode (class strategy, persisted). Motion: CSS only (fade/slide/pulse/shimmer, flowing
dashed edges on the Floor).

### "Wow" features (must ship)
1. **Factory Floor** — live animated board: stage lanes per blueprint, project tokens moving between
   stages, pulsing running steps, live AI-worker ticker (LLM calls, tool calls, agent thoughts via WS).
2. **Morning briefing** on Home — AI-written "what needs you today" for the current persona.
3. **Copilot ("Ask the Factory")** — chat drawer over the whole portfolio with internal tools; answers cite projects as clickable chips.
4. **AI everywhere, one click** — AI draft for every form, ✨ reword menu, AI decision brief for approvers, AI status report per project (copy / print).
5. **Blueprint Designer** — visual stage/step editor + "Generate blueprint from a description" (LLM).
6. **Dependency graph** — project → required MCP servers (existing ✓ vs in delivery → child project) as an SVG graph.
7. **Persona switcher** — act as Sponsor / Dev / Security and see their inbox instantly (demo & testing).
8. **Sandbox demo environment** — one click installs sandbox DOINg.AI + Jira MCP servers, team, operations, watcher; "Simulate a sponsor creating a use case" invents a realistic use case with the LLM.
9. **Risk radar** — deterministic risk score with AI explanation and mitigation.
10. **Factory as an MCP server** — other agents can query the Factory.

---

## 5b. Step output shapes (what lands in `project.vars[store_as]`)

| type | output |
|---|---|
| `ai_task` | markdown → `{"markdown": str}` · json → the parsed object (validated against `json_schema` when given) |
| `human_form` | `{field_key: value, …}` |
| `approval` | `{"decision": "approved", "approvals": [Approval…]}` |
| `estimation` | `Estimate` dict |
| `mcp_operation` | `OperationResult.output` (after `output.extract`) |
| `agent_task` | object matching `output_schema`, else `{"final": str}` |
| `quality_gate` | `{"passed": bool, "checks": [CheckResult…], "failed": [codes], "overridden": bool}` |
| `fan_out` | `{"children": [{"id","key","title","status"}…]}` |
| `notify` | `{"subject": str, "recipients": [user ids]}` |
| `wait_for` | last operation output |

Jinja rule reminder: a template string that is exactly one expression (`"{{ vars.jira_stories.issues }}"`)
renders to the native value (list/dict), so step inputs can pass structured data between steps.

---

## 12. Internal interfaces (Python) — every backend module codes against these

```python
# app/deps.py
class Container:
    settings: Settings            # env (config.py)
    store: Store; bus: EventBus
    llm: LLMClient                # rebuilt by rebuild_llm() when settings change
    ai: AIRuntime; mcp: MCPManager; ops: OperationExecutor
    engine: WorkflowEngine; notifier: Notifier; watchers: WatcherService; scheduler: Scheduler
    def app_settings(self) -> AppSettings                     # stored singleton merged over defaults (api_key in clear — internal use)
    def save_app_settings(self, patch: dict) -> AppSettings    # deep-merge, persist, rebuild_llm(), bus "settings.updated"
    def rebuild_llm(self) -> None
    def users(self) -> list[dict]; def get_user(self, id) -> dict | None; def user_by_email(self, email) -> dict | None
    def teams(self) -> list[dict]; def get_team(self, id) -> dict | None
    def roles(self) -> list[dict]
    def get_operation_by_key(self, key) -> dict | None
    def get_blueprint(self, id) -> dict | None; def get_blueprint_by_key(self, key) -> dict | None
    def record_event(self, kind, message, *, actor="system", project_id="", step_id="", data=None) -> dict   # store + bus "activity"
container = Container()          # module-level; subsystems constructed in dependency order

# app/events.py
class EventBus:
    def subscribe(self) -> asyncio.Queue; def unsubscribe(self, q) -> None
    def emit(self, type: str, **payload) -> None     # never blocks; drops oldest for a slow subscriber (maxsize 500)

# app/llm/client.py
@dataclass class LLMReply: content: str; tool_calls: list[dict]  # [{"id","name","arguments": dict}]
                           tokens_in: int; tokens_out: int; latency_ms: int; model: str; finish_reason: str
class LLMClient:
    configured: bool; provider: str; model: str; fast_model: str
    def is_remote(self, model: str | None = None) -> bool      # "-cloud"/":cloud" tags or non-local host
    async def chat(self, messages, *, model=None, temperature=None, json_mode=False, json_schema=None,
                   tools=None, max_tokens=None, timeout_s=None) -> LLMReply      # raises LLMError / LLMNotConfigured
    async def supports_tools(self, model=None) -> bool
    async def list_models(self) -> list[dict]     # {name, size, local, tools, context}
    async def test(self) -> dict                  # {ok, latency_ms, model, reply, error}
def make_llm(cfg: LLMSettings) -> LLMClient       # UnconfiguredLLM when base_url == ""
LLM_PRESETS: list[dict]                           # Ollama http://localhost:11434 · LM Studio :1234/v1 · vLLM :8000/v1 · llama.cpp :8080/v1 · OpenAI-compatible custom

# app/llm/runtime.py
class AIRuntime:
    configured: bool (property)
    def prompt(self, key: str) -> str             # library override or DEFAULT_PROMPTS[key]
    async def ask(self, role: str, user: str, *, prompt_key: str | None = None, system: str | None = None,
                  json: bool = False, json_schema: dict | None = None, fast: bool = False, temperature: float | None = None,
                  max_tokens: int | None = None, project_id: str = "", step_id: str = "") -> str | dict | list
    async def chat(self, role: str, messages: list[dict], *, tools=None, fast=False, temperature=None,
                   project_id="", step_id="") -> LLMReply
    # every call → store.add_llm_call(LLMCall) + bus "llm.call". JSON: parse_json + one repair round-trip, else LLMError.
    # Project LLM metrics are NOT written into project docs (avoid racing the engine): GET /projects/{id}
    # fills metrics.llm_calls/tokens_* from store.llm_stats(project_id).

# app/mcp/manager.py
class MCPManager:
    async def test(self, connector_id: str) -> dict          # reconnect, list tools, persist status+tools on the connector, return connector
    async def list_tools(self, connector_id: str, refresh: bool = False) -> list[dict]   # ToolInfo dicts
    async def call_tool(self, connector_id: str, tool: str, args: dict, timeout_s: float | None = None) -> dict
        # NEVER raises: {"ok", "tool", "text", "data" (structuredContent or JSON-parsed text or None), "is_error", "latency_ms", "error"}
    def tool_index(self, connector_ids: list[str] | None = None) -> list[dict]
        # [{"qualified": "<slug>__<tool>", "connector_id", "connector_name", "name", "description", "input_schema", "sensitive", "read_only"}]
    def resolve(self, qualified: str) -> tuple[str, str] | None   # (connector_id, tool); ambiguous bare names → None
    async def disconnect(self, connector_id: str) -> None; async def close_all(self) -> None

# app/mcp/operations.py
class OperationExecutor:
    async def run(self, op: dict | str, input: dict, *, ctx: dict | None = None, project_id: str = "", step_id: str = "",
                  args_override: dict | None = None, prepare_only: bool = False,
                  agent_state: dict | None = None, autonomy: str = "full", trace=None) -> OperationResult
        # prepare_only → returns ok=True with .args filled and nothing executed (confirmation preview)
        # agent mode under approve_writes may return ok=False, summary="needs_confirmation" with raw={"pending": {...}, "agent_state": {...}}

# app/mcp/agent.py
@dataclass class AgentOutcome: status: "done"|"needs_confirmation"|"failed"; final: str; data: Any; state: dict; pending: dict | None; actions: list[dict]
async def run_agent(container, *, goal: str, connector_ids: list[str], allowed_tools: list[str], max_actions: int, timeout_s: int,
                    output_schema: dict | None, autonomy: str, context: str = "", state: dict | None = None,
                    confirmed: dict | None = None,   # {"approve": bool, "args": dict|None, "approve_all": bool} when resuming after a confirmation
                    project_id: str = "", step_id: str = "", trace=None) -> AgentOutcome

# app/engine/templating.py
def render(template: str, ctx: dict) -> str; def render_obj(obj, ctx); def evaluate(expr: str, ctx: dict); def condition(expr: str, ctx: dict) -> bool
# raise errors.TemplateError with the offending excerpt

# app/engine/context.py  (WRITTEN) StepCtx, StepOutcome, ok(), fail()

# app/engine/executors_ai.py  (each takes StepCtx)
async def exec_ai_task(sc) -> StepOutcome; async def exec_mcp_operation(sc) -> StepOutcome
async def exec_agent_task(sc) -> StepOutcome; async def exec_quality_gate(sc) -> StepOutcome
async def resolve_confirmation(sc, approve: bool, payload: dict | None) -> StepOutcome   # confirm_operation / agent_tool_call
async def regenerate_ai_task(sc, instructions: str) -> StepOutcome                      # ai_review "regenerate"
async def rerun_gate(sc, rule_ids: list[str] | None) -> StepOutcome
async def draft_form(sc, instructions: str = "") -> dict          # field values for human_form ai_prefill
async def suggest_estimate(sc) -> dict                              # Estimate-shaped dict
async def approval_brief(sc) -> str                                 # markdown decision memo
async def critic_advice(sc, error: str) -> str                      # "" when critic disabled/LLM unavailable
async def compose_notification(sc, cfg: dict) -> tuple[str, str]   # (subject, body)

# app/engine/engine.py
class WorkflowEngine:
    async def recover(self) -> None
    async def create_project(self, blueprint_id: str, *, title: str, description: str = "", inputs: dict | None = None,
                             priority: str = "medium", sponsor_id: str = "", owner_id: str = "", team_id: str = "",
                             tags: list[str] | None = None, due_date: str | None = None, source: dict | None = None,
                             parent_id: str = "", parent_step_id: str = "", created_by: str = "") -> dict
    def kick(self, project_id: str) -> None                       # schedule advance() (non-blocking, coalesced)
    async def advance(self, project_id: str) -> None
    def get(self, project_id: str) -> dict                        # raises NotFound
    def summary(self, project: dict) -> dict                      # ProjectSummary
    def list_summaries(self, *, status=None, blueprint_id=None, q=None, parent_id=None, user_id=None) -> list[dict]
    # human actions — all return the updated Project dict, raise EngineError/Forbidden/NotFound
    async def start_step(self, pid, sid, user_id); async def save_form(self, pid, sid, user_id, form)
    async def complete_step(self, pid, sid, user_id, form=None, output=None)
    async def request_ai_draft(self, pid, sid, user_id, instructions="")   # background; returns project with ai_busy=True
    async def decide(self, pid, sid, user_id, decision, comment="")
    async def submit_estimate(self, pid, sid, user_id, estimate: dict)
    async def confirm(self, pid, sid, user_id, approve: bool, payload: dict | None = None)
    async def gate_action(self, pid, sid, user_id, action, comment="", rule_ids=None, goto_step="")
    async def retry_step(self, pid, sid, user_id); async def skip_step(self, pid, sid, user_id, reason)
    async def reopen_step(self, pid, sid, user_id, reason); async def reassign_step(self, pid, sid, user_id, user_ids)
    async def cancel_project(self, pid, user_id, reason); async def update_project(self, pid, user_id, patch: dict)
    async def update_artifact(self, pid, artifact_id, user_id, content); async def add_comment(self, pid, user_id, text) -> dict
    async def add_link(self, pid, user_id, link: dict); async def delete_project(self, pid) -> None
    async def poll_wait_step(self, pid, sid) -> None              # scheduler
    async def flag_sla(self, pid, sid) -> None                    # scheduler: sets sla_breached, notifies once
    async def refresh_risk(self, pid) -> None                     # scheduler/engine: recompute project.risk via risk.compute_risk
    def can_act(self, project: dict, step: dict, user_id: str) -> bool   # assignee/role/sponsor/admin check (shared with inbox)

# app/notify.py
class Notifier:
    async def notify(self, user_ids: list[str], kind: str, title: str, body: str = "", *, project_id: str = "", step_id: str = "", external: bool = False) -> list[dict]
    def list(self, user_id: str, unread_only: bool = False, limit: int = 100) -> list[dict]
    def mark_read(self, user_id: str, ids: list[str] | None = None, all: bool = False) -> int

# app/watchers.py
class WatcherService:
    async def run(self, watcher_id: str) -> dict          # {ok, total, new, error, items_preview}
    async def analyze_intake(self, intake_id: str, *, raise_on_failure: bool = True) -> dict   # failure → ai_error persisted
    def release_llm_waits(self) -> int    # clears "no LLM configured" ai_errors once an LLM is configured
    async def accept_intake(self, intake_id: str, user_id: str, overrides: dict) -> dict   # → Project
    async def dismiss_intake(self, intake_id: str, user_id: str, reason: str) -> dict
    def due(self, now) -> list[dict]

# app/scheduler.py
class Scheduler: def start(self) -> None; async def stop(self) -> None; running: bool; last_tick_at: str | None

# app/risk.py      def compute_risk(project: dict, now: datetime) -> dict   (Risk)
# app/kpis.py      def compute_kpis(container, days: int = 30) -> dict    (Kpis)
# app/inbox.py     def inbox_for(container, user_id: str) -> list[dict]; def inbox_counts(container, user_id: str) -> dict
# app/ai_utils.py  (all take `container` first) rewrite(text, style, instructions) · briefing(user_id) · project_report(pid, audience) · explain_risk(pid)
#                  summarize_project(pid) · generate_blueprint(description) · suggest_operation(connector_id, intent) · simulate_use_case(hint)
# app/copilot.py   async def chat(container, user_id, message, chat_id=None, project_id="") -> dict (Chat)
# app/factory_mcp.py  router mounted at /mcp (JSON-RPC over HTTP POST: initialize, tools/list, tools/call, ping)
```

Permission model (no sign-in by default): every mutating request carries `user_id` ("acting as" persona).
`can_act`: user is in `assignee_user_ids`, or holds one of the step's assignee roles, or — for approvals —
holds a pending approver role (role `sponsor` is restricted to the project's sponsor when one is set), or is
`admin`. Violations → 403 with a clear message.

---

## 13. Bundled MCP servers & demo environment

**`mcp_servers/doing_ai_mcp.py`** (mode via env `DOING_AI_MODE=sandbox|bridge`, state `backend/data/sandbox/doing_ai.json` seeded on first run; bridge reads `DOING_AI_URL` + `/api/data`, strips password fields, write tools return an error "read-only bridge"). Shapes follow DOINg.AI `types.ts` (camelCase):
- `list_projects(status="", updated_since="", include_archived=false)` → `{"projects": [Project + "sponsor": {id,name,email}|null, "manager": {…}|null, "businessUnit": str], "count"}`
- `get_project(project_id)` · `list_users()` · `list_wishes(category="", status="")`
- `list_mcp_servers(query="", deploy_status="")` → `{"mcp_servers": [McpServer…]}` · `search_mcp_servers(capability, limit=5)` → `{"matches": [{score, server}]}`
- sandbox writes: `create_project(name, description, context="", sponsor_email="", business_unit="", deadline="", tags=[])`, `update_project_status(project_id, status="", dev_status="", note="")`, `register_mcp_server(name, description, tools=[], category="", tags=[], team_it="", deploy_status="dev", use_case="")`
- Seed: ~8 users (sponsors/PMs), 6 projects (2 in status `Planning` = new use cases with rich `context` describing data needs; others Active/Done), 10 MCP servers (production/uat/dev) incl. tools, 3 wishes.

**`mcp_servers/jira_mcp.py`** (state `backend/data/sandbox/jira.json`): `jira_list_projects()`, `jira_search(jql, limit=20)` (JQL subset: `project =`, `issuetype =`, `status =`, `labels =`, `summary ~ "x"`, `parent =`, `AND`), `jira_get_issue(issue_key)`, `jira_create_issue(project_key, summary, issue_type="Task", description="", priority="Medium", labels=[], parent_key="", assignee="", story_points=null, components=[])`, `jira_batch_create_issues(issues: list)`, `jira_update_issue(issue_key, fields)`, `jira_transition_issue(issue_key, status)`, `jira_add_comment(issue_key, comment)`. Every issue has `key`, `url` = `https://jira.sandbox.local/browse/<KEY>`, `status` (To Do / In Progress / Done). Seed projects: `MCPF` (MCP Factory Squad), `DATA` (Data Platform), `PAY` (Payments), `SEC` (Security Engineering), `OPS` (IT Operations — change requests, issue type `Change`).

**Demo installer** (`POST /api/admin/demo/install`, idempotent, labels everything Sandbox): users (Alice Martin – Sponsor, Paul Durand – Product Manager, Sofia Rossi – Dev Lead, Karim Benali – Developer, Emma Leroy – IT Ops, Lucas Moreau – Security, Chloé Bernard – Compliance, Admin), teams mapped to Jira projects with skills, 2 stdio connectors (`sys.executable mcp_servers/…py`), operations (`portfolio.list_projects`, `portfolio.get_project`, `portfolio.search_mcp`, `portfolio.list_mcp_servers`, `portfolio.register_mcp`*, `portfolio.update_status`*, `jira.search`, `jira.get_issue`, `jira.ensure_epic`* (agent mode: search then create in the right team project), `jira.create_issue`*, `jira.create_stories`* (`jira_batch_create_issues`), `jira.create_change`*; * = sensitive), and the watcher "New DOINg.AI use cases" (every 15 min, `portfolio.list_projects` with status `Planning`, action `intake`, blueprint `use_case_onboarding`).

**Builtin blueprints** (seeded at boot when missing, `builtin=true`, editable/duplicable):
- `use_case_onboarding` (prefix `UC`): Intake & Qualification (qualify ai_task json · sponsor kickoff notify) → Dependency Analysis (agent_task over the portfolio connector: required capabilities vs catalog → `{required:[…], missing:[…]}` · PM approval of the analysis, reject reopens the agent with feedback) → MCP Delivery (fan_out over `vars.dependencies.missing` → `mcp_delivery`, wait all; skipped when nothing missing) → Go-live (readiness ai_task w/ review · approval sponsor+IT · portfolio.update_status · closure notify).
- `mcp_delivery` (prefix `MCP`): Specification (human_form w/ AI prefill · team routing ai_task json · Jira epic via `jira.ensure_epic` w/ link · spec sign-off approval sponsor+dev_lead, reject → spec) → Planning (estimation w/ AI suggestion · Jira backlog ai_task json review · `jira.create_stories`) → Build & Test [parallel] (test plan ai_task · development wait_for epic Done, manual complete allowed) → Quality & Compliance (quality_gate tags `mcp` · test report human_form) → Release (release notes ai_task · `jira.create_change` w/ link · release approval IT+sponsor+security · `portfolio.register_mcp` · delivered notify).
- `change_request` (prefix `CR`): small 2-stage example (impact analysis ai_task → approval → notify).

**Default compliance rules** (tags `mcp`, `security`, `data`, …) ~15: authentication required, least-privilege service account, secrets never in code, PII classification & masking, input validation / parameterised queries, tool annotations (readOnly/destructive) declared, rate limits & timeouts, audit logging of tool calls, error messages don't leak internals, documented tools & parameters, test set ≥ critical paths, monitoring & health endpoint, versioning & changelog, data residency/GDPR basis, owner & support contact defined.


---

## 14. Clarifications for the features phase

- Templating: `fan_out.items`, `watcher.items_expr`, `when`, `wait_for.until` accept either a bare Jinja expression (`vars.dependencies.missing`) or a single `{{ … }}` expression — strip the braces before `evaluate`.
- Agent `allowed_tools` may contain bare tool names (`jira_search`) or qualified ones (`jira__jira_search`); resolve bare names within the step's connectors.
- `mcp_delivery.team_routing` output (`{team_id, team_name, jira_project_key, rationale}`): when a step's output is a dict containing a valid `team_id` and the project has no `team_id` yet, the engine sets `project.team_id` (records `project.updated`). This is the only implicit project mutation from step outputs.
- Sandbox simulation calls the DOINg.AI tool `create_project` (not `create_use_case`).
- Connector secrets: env/header values whose KEY looks secret (token|key|secret|password|auth|cookie|session|credential) are masked on read (`util.public_connector`); other values stay readable.
- `engine/executors_flow.py` and `engine/guard.py` signatures are chosen by the engine / AI-executor builders; they must add them to `tests/test_contracts.py`.
- `backend/tests/test_contracts.py` pins every §12 interface — keep it green.
