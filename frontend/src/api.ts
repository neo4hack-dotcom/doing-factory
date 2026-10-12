// The ONE typed client for the Factory API (docs/SPEC.md §9). No component calls fetch directly:
// every endpoint has exactly one call site here, so a shape change is a compile error everywhere.
//
// Every mutation carries `user_id`, the "acting as" persona (SPEC §12): explicitly in the body where
// the SPEC names it (projects, steps, intake, notifications…), and as a query parameter on all the
// others (settings, people, library, connectors…), where the backend uses it to attribute the audit
// event. The backend enforces permissions with it and answers 403 with a readable message.
import type {
  AppSettings, Approval, Artifact, Backup, Blueprint, Bootstrap, Briefing, ChainVerification, Chat,
  Connector, CopilotReply, DemoInstallResult, Estimate, Event, Health, InboxCounts, InboxItem,
  IntakeItem, Kpis, LLMCall, LLMSettings, LinkKind, LlmModelInfo, LlmPreset, LlmTestResult,
  Notification, Operation, OperationResult, Priority, Project, ProjectStatus, ProjectSummary,
  ProjectDossier, PromptDef, ReportAudience, RewriteStyle, RoleDef, Rule, Team, ToolCallResult, User,
  ValidationReport, Watcher, WatcherRunResult,
} from './types';

/** HTTP error with the backend's `{detail}` message (already human-readable English). */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Extracts a readable message from any thrown value (for toasts). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Unexpected error';
}

let actingUserId = '';

/** The store calls this whenever the persona changes; every later mutation is attributed to it. */
export function setActingUser(id: string): void {
  actingUserId = id;
}

/**
 * A mutation's URL, tagged `?user_id=<persona>` — unless the body or the URL already names the
 * acting user, so a request never carries two identities.
 */
function attributed(path: string, body?: unknown): string {
  const named = !!body && typeof body === 'object' && 'user_id' in body;
  if (named || !actingUserId || /[?&]user_id=/.test(path)) return path;
  return `${path}${path.includes('?') ? '&' : '?'}user_id=${encodeURIComponent(actingUserId)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      // Headers last: spreading `init` after would drop the default Content-Type whenever a caller
      // passes its own headers.
      headers: {
        ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the Factory API — is the backend running on port 3071?');
  }
  if (!res.ok) {
    const text = await res.text();
    let detail: unknown = text;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      detail = parsed.detail ?? parsed;
    } catch {
      /* plain-text error body */
    }
    let message: string;
    let code: string | undefined;
    if (typeof detail === 'string') message = detail;
    else if (Array.isArray(detail)) {
      // FastAPI validation errors: [{loc, msg}] → "field: message"
      message = detail
        .map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).slice(1).join('.') || 'body'}: ${d.msg ?? ''}`)
        .join(' · ');
    } else if (detail && typeof detail === 'object') {
      const obj = detail as { message?: string; error?: string };
      code = obj.error;
      message = obj.message ?? obj.error ?? JSON.stringify(detail);
    } else message = res.statusText;
    throw new ApiError(res.status, (message || `HTTP ${res.status}`).slice(0, 600), code);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(attributed(path, body), { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T>(path: string, body: unknown) =>
  request<T>(attributed(path, body), { method: 'PUT', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(attributed(path, body), { method: 'PATCH', body: JSON.stringify(body) });
const del = <T = OkResponse>(path: string) => request<T>(attributed(path), { method: 'DELETE' });

/** Builds "?a=1&b=2", skipping empty / undefined values. */
function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)]);
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
}

const enc = encodeURIComponent;

/** Generic acknowledgement returned by deletes and fire-and-forget actions. */
export interface OkResponse {
  ok?: boolean;
  [key: string]: unknown;
}

// ---- Request bodies ---------------------------------------------------------------------------

export interface ProjectFilters {
  status?: ProjectStatus | '';
  blueprint_id?: string;
  q?: string;
  parent_id?: string;
  user_id?: string;
}

export interface NewProjectBody {
  blueprint_id: string;
  title: string;
  description?: string;
  inputs?: Record<string, unknown>;
  priority?: Priority;
  sponsor_id?: string;
  owner_id?: string;
  team_id?: string;
  tags?: string[];
  due_date?: string | null;
  created_by: string;
}

export interface ProjectPatch {
  title?: string;
  description?: string;
  priority?: Priority;
  sponsor_id?: string;
  owner_id?: string;
  team_id?: string;
  tags?: string[];
  due_date?: string | null;
  stakeholder_ids?: string[];
}

export interface NewLinkBody {
  kind: LinkKind;
  label: string;
  url?: string;
  external_id?: string;
}

export type GateAction = 'override' | 'rerun' | 'send_back';

export interface IntakeAcceptBody {
  blueprint_id?: string;
  title?: string;
  priority?: Priority;
  sponsor_id?: string;
  team_id?: string;
  owner_id?: string;
}

export interface EventFilters {
  limit?: number;
  kind?: string;
  project_id?: string;
  before?: string;
}

export interface CopilotBody {
  user_id: string;
  message: string;
  chat_id?: string;
  project_id?: string;
}

/** Partial deep patch of AppSettings (PUT /settings deep-merges; api_key '' keeps the stored one). */
export type SettingsPatch = {
  [K in keyof Omit<AppSettings, 'has_api_key'>]?: Partial<AppSettings[K]>;
};

// ---- Client -----------------------------------------------------------------------------------

export const api = {
  // System
  /** Configuration, not reachability (never calls the LLM). `counts.inbox` only when `user_id` is given. */
  health: (user_id?: string) => get<Health>(`/health${qs({ user_id })}`),
  bootstrap: () => get<Bootstrap>('/bootstrap'),

  // Settings & LLM
  settings: {
    get: () => get<AppSettings>('/settings'),
    update: (patchBody: SettingsPatch) => put<AppSettings>('/settings', patchBody),
  },
  llm: {
    presets: () => get<LlmPreset[]>('/llm/presets'),
    /** Tests the stored config, or a draft (partial LLMSettings) before saving it. */
    test: (draft?: Partial<LLMSettings>) => post<LlmTestResult>('/llm/test', draft ?? {}),
    /** Models of the saved server, or of another one named before saving. `error` set = unreachable. */
    models: (provider?: string, base_url?: string) =>
      get<{ models: LlmModelInfo[]; error: string }>(`/llm/models${qs({ provider, base_url })}`),
    /** Same for a draft that carries a new API key: a secret never travels in a URL. */
    modelsDraft: (draft: Partial<LLMSettings>) =>
      post<{ models: LlmModelInfo[]; error: string }>('/llm/models', draft),
  },

  // People
  users: {
    list: () => get<User[]>('/users'),
    create: (user: Partial<User>) => post<User>('/users', user),
    update: (id: string, user: Partial<User>) => put<User>(`/users/${enc(id)}`, user),
    remove: (id: string) => del(`/users/${enc(id)}`),
  },
  teams: {
    list: () => get<Team[]>('/teams'),
    create: (team: Partial<Team>) => post<Team>('/teams', team),
    update: (id: string, team: Partial<Team>) => put<Team>(`/teams/${enc(id)}`, team),
    remove: (id: string) => del(`/teams/${enc(id)}`),
  },
  roles: {
    list: () => get<RoleDef[]>('/roles'),
    /** Replaces the full role list. */
    update: (roles: RoleDef[]) => put<RoleDef[]>('/roles', roles),
  },

  // Connectors (MCP servers)
  connectors: {
    list: () => get<Connector[]>('/connectors'),
    get: (id: string) => get<Connector>(`/connectors/${enc(id)}`),
    create: (c: Partial<Connector>) => post<Connector>('/connectors', c),
    update: (id: string, c: Partial<Connector>) => put<Connector>(`/connectors/${enc(id)}`, c),
    remove: (id: string) => del(`/connectors/${enc(id)}`),
    /** Reconnects, lists tools and persists status + tools; returns the updated connector. */
    test: (id: string) => post<Connector>(`/connectors/${enc(id)}/test`),
    call: (id: string, tool: string, args: Record<string, unknown>) =>
      post<ToolCallResult>(`/connectors/${enc(id)}/call`, { tool, args }),
  },

  // Operations (MCP bindings)
  operations: {
    list: () => get<Operation[]>('/operations'),
    create: (op: Partial<Operation>) => post<Operation>('/operations', op),
    update: (id: string, op: Partial<Operation>) => put<Operation>(`/operations/${enc(id)}`, op),
    remove: (id: string) => del(`/operations/${enc(id)}`),
    run: (id: string, input: Record<string, unknown>) => post<OperationResult>(`/operations/${enc(id)}/run`, { input }),
    /** LLM drafts an operation for a connector from an intent (unsaved). */
    suggest: (connector_id: string, intent: string) => post<Operation>('/operations/suggest', { connector_id, intent }),
  },

  // Blueprints (workflow templates)
  blueprints: {
    list: () => get<Blueprint[]>('/blueprints'),
    get: (id: string) => get<Blueprint>(`/blueprints/${enc(id)}`),
    create: (bp: Partial<Blueprint>) => post<Blueprint>('/blueprints', bp),
    update: (id: string, bp: Partial<Blueprint>) => put<Blueprint>(`/blueprints/${enc(id)}`, bp),
    remove: (id: string) => del(`/blueprints/${enc(id)}`),
    duplicate: (id: string) => post<Blueprint>(`/blueprints/${enc(id)}/duplicate`),
    validate: (bp: Partial<Blueprint>) => post<ValidationReport>('/blueprints/validate', bp),
    /** LLM generates a draft blueprint from a plain-language description (unsaved). */
    generate: (description: string) => post<Blueprint>('/blueprints/generate', { description }),
  },

  // Projects (workflow instances)
  projects: {
    list: (filters: ProjectFilters = {}) => get<ProjectSummary[]>(`/projects${qs({ ...filters })}`),
    create: (body: NewProjectBody) => post<Project>('/projects', body),
    get: (id: string) => get<Project>(`/projects/${enc(id)}`),
    update: (id: string, user_id: string, changes: ProjectPatch) =>
      patch<Project>(`/projects/${enc(id)}`, { ...changes, user_id }),
    cancel: (id: string, user_id: string, reason: string) =>
      post<Project>(`/projects/${enc(id)}/cancel`, { user_id, reason }),
    remove: (id: string) => del(`/projects/${enc(id)}`),
    events: (id: string) => get<Event[]>(`/projects/${enc(id)}/events`),
    comment: (id: string, user_id: string, text: string) =>
      post<Event>(`/projects/${enc(id)}/comments`, { user_id, text }),
    updateArtifact: (id: string, artifactId: string, user_id: string, content: string) =>
      put<Artifact>(`/projects/${enc(id)}/artifacts/${enc(artifactId)}`, { user_id, content }),
    addLink: (id: string, user_id: string, link: NewLinkBody) =>
      post<Project>(`/projects/${enc(id)}/links`, { ...link, user_id }),
    /** Deterministic Markdown audit pack (no LLM): header, step log, artifacts, approvals, gates, audit chain. */
    dossier: (id: string) => get<ProjectDossier>(`/projects/${enc(id)}/dossier`),
    report: (id: string, audience: ReportAudience) =>
      post<{ markdown: string }>(`/projects/${enc(id)}/report`, { audience }),
    explainRisk: (id: string) => post<{ markdown: string }>(`/projects/${enc(id)}/explain-risk`),
    summarize: (id: string) => post<{ summary: string }>(`/projects/${enc(id)}/summarize`),
  },

  // Step actions — every call returns the updated Project.
  steps: {
    start: (pid: string, sid: string, user_id: string) => stepAction(pid, sid, 'start', { user_id }),
    save: (pid: string, sid: string, user_id: string, form: Record<string, unknown>) =>
      stepAction(pid, sid, 'save', { user_id, form }),
    complete: (pid: string, sid: string, user_id: string, body: { form?: Record<string, unknown>; output?: unknown } = {}) =>
      stepAction(pid, sid, 'complete', { user_id, ...body }),
    /** Background AI draft; returns `{accepted: true}` — the result arrives via `project.updated`. */
    aiDraft: (pid: string, sid: string, user_id: string, instructions = '') =>
      post<{ accepted: boolean }>(`/projects/${enc(pid)}/steps/${enc(sid)}/ai-draft`, { user_id, instructions }),
    decide: (pid: string, sid: string, user_id: string, decision: Approval['decision'], comment = '') =>
      stepAction(pid, sid, 'decide', { user_id, decision, comment }),
    estimate: (pid: string, sid: string, user_id: string, estimate: Partial<Estimate>) =>
      stepAction(pid, sid, 'estimate', { user_id, estimate }),
    /** confirm_operation / agent_tool_call / ai_review: approve (optionally with an edited payload) or decline. */
    confirm: (pid: string, sid: string, user_id: string, approve: boolean, payload?: Record<string, unknown>) =>
      stepAction(pid, sid, 'confirm', { user_id, approve, payload }),
    gate: (pid: string, sid: string, user_id: string, action: GateAction,
      opts: { comment?: string; rule_ids?: string[]; goto_step?: string } = {}) =>
      stepAction(pid, sid, 'gate', { user_id, action, comment: opts.comment ?? '', rule_ids: opts.rule_ids, goto_step: opts.goto_step }),
    retry: (pid: string, sid: string, user_id: string) => stepAction(pid, sid, 'retry', { user_id }),
    skip: (pid: string, sid: string, user_id: string, reason: string) => stepAction(pid, sid, 'skip', { user_id, reason }),
    reopen: (pid: string, sid: string, user_id: string, reason: string) => stepAction(pid, sid, 'reopen', { user_id, reason }),
    reassign: (pid: string, sid: string, user_id: string, user_ids: string[]) =>
      stepAction(pid, sid, 'reassign', { user_id, user_ids }),
  },

  // Inbox
  inbox: {
    list: (user_id: string) => get<InboxItem[]>(`/inbox${qs({ user_id })}`),
    counts: (user_id: string) => get<InboxCounts>(`/inbox/counts${qs({ user_id })}`),
  },

  // Intake (detected items waiting for triage)
  intake: {
    list: (status?: IntakeItem['status']) => get<IntakeItem[]>(`/intake${qs({ status })}`),
    accept: (id: string, user_id: string, overrides: IntakeAcceptBody = {}) =>
      post<Project>(`/intake/${enc(id)}/accept`, { user_id, ...overrides }),
    dismiss: (id: string, user_id: string, reason: string) =>
      post<IntakeItem>(`/intake/${enc(id)}/dismiss`, { user_id, reason }),
    analyze: (id: string) => post<IntakeItem>(`/intake/${enc(id)}/analyze`),
  },

  // Watchers (scheduled polling of MCP operations)
  watchers: {
    list: () => get<Watcher[]>('/watchers'),
    create: (w: Partial<Watcher>) => post<Watcher>('/watchers', w),
    update: (id: string, w: Partial<Watcher>) => put<Watcher>(`/watchers/${enc(id)}`, w),
    remove: (id: string) => del(`/watchers/${enc(id)}`),
    run: (id: string) => post<WatcherRunResult>(`/watchers/${enc(id)}/run`),
    /** Forgets seen keys so the next run re-detects everything. */
    reset: (id: string) => post<Watcher>(`/watchers/${enc(id)}/reset`),
  },

  // Library: prompts & compliance rules
  prompts: {
    list: () => get<PromptDef[]>('/prompts'),
    update: (key: string, content: string) => put<PromptDef>(`/prompts/${enc(key)}`, { content }),
    reset: (key: string) => post<PromptDef>(`/prompts/${enc(key)}/reset`),
  },
  rules: {
    list: () => get<Rule[]>('/rules'),
    create: (rule: Partial<Rule>) => post<Rule>('/rules', rule),
    update: (id: string, rule: Partial<Rule>) => put<Rule>(`/rules/${enc(id)}`, rule),
    remove: (id: string) => del(`/rules/${enc(id)}`),
  },

  // Notifications
  notifications: {
    list: (user_id: string, unread?: boolean) =>
      get<Notification[]>(`/notifications${qs({ user_id, unread: unread ? 'true' : undefined })}`),
    markRead: (user_id: string, opts: { ids?: string[]; all?: boolean }) =>
      post<OkResponse>('/notifications/read', { user_id, ...opts }),
  },

  // Activity (tamper-evident audit chain) & KPIs
  events: {
    list: (filters: EventFilters = {}) => get<Event[]>(`/events${qs({ ...filters })}`),
    verify: () => get<ChainVerification>('/events/verify'),
  },
  kpis: (days = 30) => get<Kpis>(`/kpis${qs({ days })}`),

  // AI utilities
  ai: {
    rewrite: (text: string, style: RewriteStyle, instructions?: string) =>
      post<{ text: string }>('/ai/rewrite', { text, style, instructions }),
  },
  /** "What needs you today" for a persona; `ai:false` = deterministic summary (no LLM). Cached 10 min. */
  briefing: (user_id: string, refresh = false) =>
    get<Briefing>(`/briefing${qs({ user_id, refresh: refresh ? 'true' : undefined })}`),
  copilot: {
    send: (body: CopilotBody) => post<CopilotReply>('/copilot', body),
    get: (chatId: string) => get<Chat>(`/copilot/${enc(chatId)}`),
  },

  // Admin
  admin: {
    /** Idempotent: installs the Sandbox users, teams, connectors, operations and watcher. */
    installDemo: () => post<DemoInstallResult>('/admin/demo/install'),
    /** The LLM invents a realistic use case and creates it through the sandbox DOINg.AI MCP. */
    simulateUseCase: (hint?: string) => post<{ use_case: Record<string, unknown> }>('/admin/demo/simulate-use-case', { hint }),
    export: () => get<Backup>('/admin/export'),
    import: (backup: Backup) => post<OkResponse>('/admin/import', backup),
    llmCalls: (days?: number) => get<LLMCall[]>(`/admin/llm-calls${qs({ days })}`),
  },
};

function stepAction(pid: string, sid: string, action: string, body: Record<string, unknown>): Promise<Project> {
  return post<Project>(`/projects/${enc(pid)}/steps/${enc(sid)}/${action}`, body);
}

/** URL of the Factory's own MCP endpoint (streamable HTTP, SPEC §9), derived from the page origin. */
export function factoryMcpUrl(): string {
  return `${location.origin}/mcp`;
}
