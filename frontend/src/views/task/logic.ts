// Pure logic behind the Home, Inbox and TaskPanel views — no React, no DOM, so it is unit-tested
// (tests/task.test.ts). Permission helpers MIRROR the backend's `WorkflowEngine.can_act` (SPEC §12):
// the UI only uses them to explain why a button is disabled; the backend stays the authority and
// answers 403 with its own message when the two ever disagree.
import type {
  Approval, ApprovalConfig, Artifact, Blueprint, InboxItem, InboxKind, Project, ProjectSummary,
  StageRun, StepConfigMap, StepRun, StepType, TraceEntry, User,
} from '../../types';

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

export interface StepLocation {
  stage: StageRun;
  step: StepRun;
  /** Position of the step in the whole project (stages flattened in order). */
  flatIndex: number;
}

/** Every step of a project in execution order, with its stage. */
export function flatSteps(project: Project): Array<{ stage: StageRun; step: StepRun }> {
  return project.stages.flatMap((stage) => stage.steps.map((step) => ({ stage, step })));
}

export function findStep(project: Project, stepId: string): StepLocation | null {
  const all = flatSteps(project);
  const flatIndex = all.findIndex((x) => x.step.id === stepId);
  return flatIndex < 0 ? null : { ...all[flatIndex], flatIndex };
}

/** Steps a quality gate can send work back to: every step before it, in order. */
export function earlierSteps(project: Project, stepId: string): StepRun[] {
  const all = flatSteps(project);
  const at = all.findIndex((x) => x.step.id === stepId);
  return at <= 0 ? [] : all.slice(0, at).map((x) => x.step);
}

/** The step's config viewed through its typed shape (every key optional: configs are partial dicts). */
export function stepConfig<T extends StepType>(step: StepRun, _type: T): Partial<StepConfigMap[T]> {
  return (step.config ?? {}) as Partial<StepConfigMap[T]>;
}

/** Variable name a step's output lands in (`store_as`, else the step id — SPEC §5). */
export function outputVar(step: Pick<StepRun, 'id' | 'store_as'>): string {
  return step.store_as || step.id;
}

/** Artifacts produced by a step, newest first. */
export function stepArtifacts(project: Pick<Project, 'artifacts'>, stepId: string): Artifact[] {
  return project.artifacts
    .filter((a) => a.step_id === stepId)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

export interface VarEvidence {
  name: string;
  /** Step that produced the variable, when known. */
  step: StepRun | null;
  artifacts: Artifact[];
  /** The raw value from project.vars (undefined when the variable was never set). */
  value: unknown;
}

/** What an approver should read for `show_vars`: each variable with the artifacts of its step. */
export function evidenceForVars(project: Project, names: string[]): VarEvidence[] {
  const steps = flatSteps(project).map((x) => x.step);
  return names.map((name) => {
    const step = steps.find((s) => outputVar(s) === name) ?? null;
    return { name, step, artifacts: step ? stepArtifacts(project, step.id) : [], value: project.vars?.[name] };
  });
}

// ---------------------------------------------------------------------------------------------
// Permissions (mirror of the backend's can_act)
// ---------------------------------------------------------------------------------------------

/** True when the blueprint named nobody for the step (no roles, no users, no project role). */
export function hasAssignee(step: StepRun): boolean {
  const a = step.assignee;
  return !!a && (a.roles.length > 0 || a.user_ids.length > 0 || !!a.project_role || step.assignee_user_ids.length > 0);
}

/**
 * Whether `user` holds `role` *for this project*. The `sponsor` role is project-scoped: when the
 * project names a sponsor, only that person counts as its sponsor (and the named sponsor counts
 * even without the global role).
 */
export function holdsRole(project: Pick<Project, 'sponsor_id'>, user: User, role: string): boolean {
  if (role === 'sponsor' && project.sponsor_id) return project.sponsor_id === user.id;
  return user.roles.includes(role);
}

/** Can the acting persona act on this step at all (non-approval steps)? */
export function canActOnStep(project: Project, step: StepRun, user: User | null, isAdmin: boolean): boolean {
  if (!user) return false;
  if (isAdmin) return true;
  if (step.type === 'approval') return approvalState(project, step, user, isAdmin).canAct;
  if (step.assignee_user_ids.includes(user.id)) return true;
  if (step.assignee.roles.some((r) => holdsRole(project, user, r))) return true;
  return !hasAssignee(step);
}

/** Who may override a blocking quality gate: `override_roles` holders (or the step's actors when none). */
export function canOverrideGate(project: Project, step: StepRun, user: User | null, isAdmin: boolean): boolean {
  if (!user) return false;
  if (isAdmin) return true;
  const roles = stepConfig(step, 'quality_gate').override_roles ?? [];
  if (roles.length === 0) return canActOnStep(project, step, user, isAdmin);
  return roles.some((r) => holdsRole(project, user, r));
}

/** Human-readable list of who is expected to act on a step (for "Waiting for: …"). */
export function assigneeLabel(step: StepRun, users: User[], roleLabel: (key: string) => string): string {
  const names = step.assignee_user_ids
    .map((id) => users.find((u) => u.id === id)?.name)
    .filter((n): n is string => !!n);
  if (names.length) return names.join(', ');
  const roles = step.assignee.roles.map(roleLabel);
  if (step.assignee.project_role) roles.push(`project ${step.assignee.project_role.replace('_', ' ')}`);
  return roles.join(', ') || 'anyone';
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

export interface ApproverRow {
  role: string;
  label: string;
  status: 'approved' | 'rejected' | 'pending';
  approval?: Approval;
}

export interface ApprovalState {
  policy: 'all' | 'any' | 'quorum';
  /** Approvals needed for the step to pass. */
  required: number;
  approvedCount: number;
  rows: ApproverRow[];
  /** Approver labels still missing, joined ("Security, IT operations"). */
  waitingFor: string;
  /** Pending approver roles the persona can sign for. */
  eligibleRoles: string[];
  /** The persona's own decision on this step, if any. */
  myDecision?: Approval;
  canAct: boolean;
}

/** Latest decision per role (a reopened step clears approvals, so normally one per role). */
function latestByRole(approvals: Approval[]): Map<string, Approval> {
  const out = new Map<string, Approval>();
  for (const a of approvals) {
    const prev = out.get(a.role);
    if (!prev || (a.at || '') >= (prev.at || '')) out.set(a.role, a);
  }
  return out;
}

export function approvalState(project: Project, step: StepRun, user: User | null, isAdmin: boolean): ApprovalState {
  const cfg = step.config as Partial<ApprovalConfig>;
  const policy = cfg.policy ?? 'all';
  const approvers = (cfg.approvers ?? []).filter((a) => a && a.role);
  const byRole = latestByRole(step.approvals ?? []);

  const rows: ApproverRow[] = approvers.map((a) => {
    const approval = byRole.get(a.role);
    return { role: a.role, label: a.label || a.role, status: approval ? approval.decision : 'pending', approval };
  });
  // Decisions recorded under a role the config does not list (an admin signing on behalf…).
  for (const [role, approval] of byRole) {
    if (!rows.some((r) => r.role === role)) rows.push({ role, label: role || 'Approver', status: approval.decision, approval });
  }

  const approvedCount = rows.filter((r) => r.status === 'approved').length;
  const required = policy === 'any' ? 1 : policy === 'quorum' ? Math.max(1, cfg.quorum ?? 1) : Math.max(1, approvers.length);
  const pending = rows.filter((r) => r.status === 'pending');
  const waitingFor = pending.map((r) => r.label).join(', ');

  const eligibleRoles = user ? pending.filter((r) => holdsRole(project, user, r.role)).map((r) => r.role) : [];
  const myDecision = user ? (step.approvals ?? []).filter((a) => a.user_id === user.id).at(-1) : undefined;

  let canAct = false;
  if (user) {
    if (isAdmin) canAct = true;
    else if (myDecision && eligibleRoles.length === 0) canAct = false;
    else if (eligibleRoles.length > 0 || step.assignee_user_ids.includes(user.id)) canAct = true;
    else canAct = approvers.length === 0 && !hasAssignee(step);
  }
  return { policy, required, approvedCount, rows, waitingFor, eligibleRoles, myDecision, canAct };
}

// ---------------------------------------------------------------------------------------------
// Tool-call argument editor
// ---------------------------------------------------------------------------------------------

export interface ArgRow {
  id: string;
  key: string;
  /** `text` = a plain string value (textarea); `json` = any other JSON value. */
  mode: 'text' | 'json';
  text: string;
}

let rowSeq = 0;
export const newRowId = () => `arg-${++rowSeq}`;

/** Args object → editable rows: strings stay strings, everything else is pretty JSON. */
export function argsToRows(args: Record<string, unknown> | null | undefined): ArgRow[] {
  return Object.entries(args ?? {}).map(([key, v]) => (typeof v === 'string'
    ? { id: newRowId(), key, mode: 'text', text: v }
    : { id: newRowId(), key, mode: 'json', text: JSON.stringify(v ?? null, null, 2) }));
}

/** Rows → args object, with an error per row id (empty/duplicate key, invalid JSON). */
export function rowsToArgs(rows: ArgRow[]): { args: Record<string, unknown>; errors: Record<string, string> } {
  const args: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) {
      if (row.text.trim()) errors[row.id] = 'Give this value a name';
      continue;
    }
    if (seen.has(key)) {
      errors[row.id] = `“${key}” is set twice`;
      continue;
    }
    seen.add(key);
    if (row.mode === 'text') {
      args[key] = row.text;
      continue;
    }
    try {
      args[key] = row.text.trim() ? JSON.parse(row.text) : null;
    } catch {
      errors[row.id] = 'Not valid JSON — quote strings, use [ ] for lists and { } for objects';
    }
  }
  return { args, errors };
}

// ---------------------------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------------------------

export type InboxGroupKey = 'overdue' | 'approvals' | 'forms' | 'confirmations' | 'failures' | 'starts' | 'intake';

export const INBOX_GROUPS: Array<{ key: InboxGroupKey; label: string }> = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'forms', label: 'Forms & reviews' },
  { key: 'confirmations', label: 'Confirmations' },
  { key: 'failures', label: 'Failures' },
  { key: 'starts', label: 'Starts & external' },
  { key: 'intake', label: 'Intake' },
];

const KIND_GROUP: Record<InboxKind, InboxGroupKey> = {
  approval: 'approvals',
  form: 'forms',
  estimate: 'forms',
  review: 'forms',
  gate: 'forms',
  confirm: 'confirmations',
  failure: 'failures',
  start: 'starts',
  external: 'starts',
  intake: 'intake',
};

/** Overdue wins over the kind: late work is what the persona must see first. */
export function inboxGroupOf(item: InboxItem): InboxGroupKey {
  return item.overdue ? 'overdue' : KIND_GROUP[item.kind] ?? 'forms';
}

export interface InboxGroup {
  key: InboxGroupKey;
  label: string;
  items: InboxItem[];
}

/** Non-empty groups in display order; items keep the backend's order (overdue, priority, due). */
export function groupInbox(items: InboxItem[]): InboxGroup[] {
  return INBOX_GROUPS
    .map((g) => ({ ...g, items: items.filter((i) => inboxGroupOf(i) === g.key) }))
    .filter((g) => g.items.length > 0);
}

/** Kind chip + free-text search over title, project, step and subtitle. */
export function filterInbox(items: InboxItem[], kind: InboxKind | 'all', query: string): InboxItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((i) => {
    if (kind !== 'all' && i.kind !== kind) return false;
    if (!q) return true;
    return [i.title, i.subtitle, i.project_key, i.project_title, i.step_name].join(' ').toLowerCase().includes(q);
  });
}

/** Item to select after the current one disappeared (acted on): same position, else the last. */
export function nextSelection(previousIds: string[], currentIds: string[], removedId: string): string {
  if (currentIds.length === 0) return '';
  if (currentIds.includes(removedId)) return removedId;
  const at = previousIds.indexOf(removedId);
  // Walk forward from the old position to the first survivor, then backwards.
  for (let i = at + 1; at >= 0 && i < previousIds.length; i++) if (currentIds.includes(previousIds[i])) return previousIds[i];
  for (let i = at - 1; i >= 0; i--) if (currentIds.includes(previousIds[i])) return previousIds[i];
  return currentIds[0];
}

/** Splits an inbox id into its parts ("{project_id}:{step_id}" or "intake:{id}"). */
export function parseInboxId(id: string): { intakeId: string } | { projectId: string; stepId: string } | null {
  const at = id.indexOf(':');
  if (at <= 0) return null;
  const head = id.slice(0, at);
  const tail = id.slice(at + 1);
  if (!tail) return null;
  return head === 'intake' ? { intakeId: tail } : { projectId: head, stepId: tail };
}

// ---------------------------------------------------------------------------------------------
// Live trace
// ---------------------------------------------------------------------------------------------

const traceKey = (e: TraceEntry) => `${e.ts}|${e.kind}|${e.agent}|${e.text.slice(0, 120)}`;

/** Persisted trace + live entries not persisted yet, deduplicated, capped like the backend (300). */
export function mergeTrace(persisted: TraceEntry[], live: TraceEntry[], cap = 300): TraceEntry[] {
  const keys = new Set(persisted.map(traceKey));
  const extra = live.filter((e) => !keys.has(traceKey(e)));
  const merged = extra.length ? [...persisted, ...extra] : persisted;
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

// ---------------------------------------------------------------------------------------------
// Home: mini factory flow
// ---------------------------------------------------------------------------------------------

export interface FlowStage {
  id: string;
  name: string;
  count: number;
  /** Projects in this stage waiting on a person. */
  attention: number;
  /** Projects in this stage blocked or failing. */
  blocked: number;
}

export interface FlowRow {
  blueprintId: string;
  name: string;
  icon: string;
  color: string;
  total: number;
  stages: FlowStage[];
}

const IN_FLIGHT = new Set(['active', 'waiting', 'blocked']);

/**
 * Projects in flight per blueprint, counted per current stage (stages in blueprint order). A
 * blueprint that was deleted still shows, with the stage names its projects report.
 */
export function factoryFlow(summaries: ProjectSummary[], blueprints: Blueprint[]): FlowRow[] {
  const rows = new Map<string, FlowRow>();
  for (const p of summaries) {
    if (!IN_FLIGHT.has(p.status)) continue;
    let row = rows.get(p.blueprint_id);
    if (!row) {
      const bp = blueprints.find((b) => b.id === p.blueprint_id);
      row = {
        blueprintId: p.blueprint_id,
        name: bp?.name ?? p.blueprint_name ?? 'Unknown blueprint',
        icon: bp?.icon ?? 'Workflow',
        color: bp?.color ?? 'indigo',
        total: 0,
        stages: (bp?.stages ?? []).map((s) => ({ id: s.id, name: s.name, count: 0, attention: 0, blocked: 0 })),
      };
      rows.set(p.blueprint_id, row);
    }
    row.total += 1;
    let stage = row.stages.find((s) => s.id === p.current_stage_id);
    if (!stage) {
      stage = { id: p.current_stage_id || '_', name: p.current_stage_name || 'Not started', count: 0, attention: 0, blocked: 0 };
      row.stages.push(stage);
    }
    stage.count += 1;
    const statuses = p.open_step_statuses ?? [];
    if (p.status === 'blocked' || statuses.some((s) => s === 'failed' || s === 'rejected')) stage.blocked += 1;
    else if (statuses.some((s) => s === 'waiting_human' || s === 'waiting_approval')) stage.attention += 1;
  }
  return [...rows.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** "Good morning" / "Good afternoon" / "Good evening" for the viewer's local hour. */
export function greeting(date: Date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Pretty JSON for previews, cut to `max` characters (huge tool results stay readable). */
export function previewJson(value: unknown, max = 4000): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}
