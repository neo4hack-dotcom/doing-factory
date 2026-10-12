// Pure helpers behind the Projects portfolio and the project page: URL query ⇄ filters, grouping
// (board columns, fan-out tree), sorting, "can this persona act on this step", merged traces.
// No React and no fetch here, so every rule the views rely on is unit-tested (tests/projects.test.ts).
import { PRIORITY } from '../../lib/status';
import { HUMAN_WAIT_STATUSES, STEP_TERMINAL_STATUSES } from '../../types';
import type {
  ApprovalConfig, Blueprint, Project, ProjectStatus, ProjectSummary, StageRun, StepRun, StepStatus, TraceEntry, User,
} from '../../types';

// =============================================================================================
// Portfolio query (#/projects?view=&group=&status=&blueprint=&priority=&risk=&mine=&q=&sort=&dir=)
// =============================================================================================

export type PortfolioView = 'table' | 'board' | 'tree';
export type StatusGroup = 'active' | 'people' | 'blocked' | 'done';
export type SortKey = 'updated' | 'created' | 'priority' | 'risk' | 'due' | 'progress' | 'key' | 'title';
export type SortDir = 'asc' | 'desc';
/** `open` = not finished; `at_risk` = medium or high. */
export type StatusFilter = '' | 'open' | ProjectStatus;
export type RiskFilter = '' | 'low' | 'medium' | 'high' | 'at_risk';

export interface PortfolioQuery {
  view: PortfolioView;
  group: '' | StatusGroup;
  status: StatusFilter;
  blueprint: string;
  priority: string;
  risk: RiskFilter;
  mine: boolean;
  q: string;
  sort: SortKey;
  dir: SortDir;
}

const VIEWS: PortfolioView[] = ['table', 'board', 'tree'];
const GROUPS: StatusGroup[] = ['active', 'people', 'blocked', 'done'];
const STATUSES: StatusFilter[] = ['open', 'active', 'waiting', 'blocked', 'done', 'cancelled', 'failed'];
const RISKS: RiskFilter[] = ['low', 'medium', 'high', 'at_risk'];
export const SORT_KEYS: SortKey[] = ['updated', 'created', 'priority', 'risk', 'due', 'progress', 'key', 'title'];

/** The direction a column sorts in when first clicked: "most relevant first". */
export const NATURAL_DIR: Record<SortKey, SortDir> = {
  updated: 'desc', created: 'desc', priority: 'desc', risk: 'desc', due: 'asc', progress: 'desc', key: 'asc', title: 'asc',
};

export const DEFAULT_QUERY: PortfolioQuery = {
  view: 'table', group: '', status: '', blueprint: '', priority: '', risk: '', mine: false, q: '', sort: 'updated', dir: 'desc',
};

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** URL query → typed filters. Unknown values fall back to defaults; `blueprint_id` is accepted as an alias. */
export function parsePortfolioQuery(query: Record<string, string>, fallbackView: PortfolioView = 'table'): PortfolioQuery {
  const sort = oneOf<SortKey>(query.sort, SORT_KEYS, 'updated');
  return {
    view: oneOf(query.view, VIEWS, fallbackView),
    group: oneOf<'' | StatusGroup>(query.group, GROUPS, ''),
    status: oneOf<StatusFilter>(query.status, STATUSES, ''),
    blueprint: query.blueprint ?? query.blueprint_id ?? '',
    priority: oneOf(query.priority, Object.keys(PRIORITY), ''),
    risk: oneOf<RiskFilter>(query.risk, RISKS, ''),
    mine: query.mine === '1' || query.mine === 'true',
    q: query.q ?? '',
    sort,
    dir: oneOf<SortDir>(query.dir, ['asc', 'desc'], NATURAL_DIR[sort]),
  };
}

/** Typed filters → the minimal URL query (defaults omitted, so shared links stay short). */
export function portfolioQueryToParams(q: PortfolioQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (q.view !== DEFAULT_QUERY.view) out.view = q.view;
  if (q.group) out.group = q.group;
  if (q.status) out.status = q.status;
  if (q.blueprint) out.blueprint = q.blueprint;
  if (q.priority) out.priority = q.priority;
  if (q.risk) out.risk = q.risk;
  if (q.mine) out.mine = '1';
  if (q.q.trim()) out.q = q.q.trim();
  if (q.sort !== DEFAULT_QUERY.sort) out.sort = q.sort;
  if (q.dir !== NATURAL_DIR[q.sort]) out.dir = q.dir;
  return out;
}

/** Number of narrowing filters in use (search and view excluded) — drives the "Clear filters" link. */
export function activeFilterCount(q: PortfolioQuery): number {
  return [q.group, q.status, q.blueprint, q.priority, q.risk].filter(Boolean).length + (q.mine ? 1 : 0);
}

// =============================================================================================
// Status groups (board columns, quick filters)
// =============================================================================================

export const GROUP_META: Record<StatusGroup, { label: string; hint: string; tone: 'sky' | 'amber' | 'rose' | 'emerald' }> = {
  active: { label: 'Active', hint: 'Work in flight: AI steps, MCP calls, children, external systems', tone: 'sky' },
  people: { label: 'Waiting on people', hint: 'A form, a review or an approval is pending', tone: 'amber' },
  blocked: { label: 'Blocked', hint: 'A step failed and needs a decision', tone: 'rose' },
  done: { label: 'Done', hint: 'Delivered or cancelled', tone: 'emerald' },
};
export const GROUP_ORDER: StatusGroup[] = ['active', 'people', 'blocked', 'done'];

const FINISHED: ProjectStatus[] = ['done', 'cancelled'];

/** Board column of a project: failure first, then "a person must act", else in flight. */
export function statusGroup(s: Pick<ProjectSummary, 'status' | 'open_step_statuses'>): StatusGroup {
  if (FINISHED.includes(s.status)) return 'done';
  const open = s.open_step_statuses ?? [];
  if (s.status === 'blocked' || s.status === 'failed' || open.includes('failed')) return 'blocked';
  if (open.some((st) => HUMAN_WAIT_STATUSES.includes(st))) return 'people';
  return 'active';
}

// =============================================================================================
// Filtering & sorting
// =============================================================================================

/**
 * Client-side filters. The list is fetched with the server-side ones (blueprint, search, mine);
 * this re-applies every filter so a live-patched row that no longer matches drops out.
 */
export function matchesPortfolio(s: ProjectSummary, q: PortfolioQuery): boolean {
  if (q.group && statusGroup(s) !== q.group) return false;
  if (q.status === 'open') {
    if (FINISHED.includes(s.status)) return false;
  } else if (q.status && s.status !== q.status) return false;
  if (q.blueprint && s.blueprint_id !== q.blueprint) return false;
  if (q.priority && s.priority !== q.priority) return false;
  if (q.risk === 'at_risk') {
    if (s.risk.level === 'low') return false;
  } else if (q.risk && s.risk.level !== q.risk) return false;
  const text = q.q.trim().toLowerCase();
  if (text) {
    const hay = [s.key, s.title, s.blueprint_name, s.current_stage_name, ...(s.tags ?? [])].join(' ').toLowerCase();
    if (!text.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** Stable sort; missing values (no due date…) always go last whatever the direction. */
export function sortSummaries(list: ProjectSummary[], sort: SortKey, dir: SortDir): ProjectSummary[] {
  const value = (s: ProjectSummary): number | string | null => {
    switch (sort) {
      case 'updated': return ms(s.updated_at);
      case 'created': return ms(s.created_at);
      case 'priority': return PRIORITY[s.priority]?.rank ?? 0;
      case 'risk': return s.risk?.score ?? 0;
      case 'due': return ms(s.due_date);
      case 'progress': return s.progress ?? 0;
      case 'key': return s.key;
      case 'title': return s.title.toLowerCase();
    }
  };
  const sign = dir === 'asc' ? 1 : -1;
  return list
    .map((s, i) => ({ s, i, v: value(s) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      let c: number;
      if (typeof a.v === 'string' && typeof b.v === 'string') {
        c = a.v.localeCompare(b.v, 'en', { numeric: true });
      } else c = (a.v as number) - (b.v as number);
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.s);
}

/** Replaces (or inserts) one summary from a `project.updated` event, keeping the list order. */
export function upsertSummary(list: ProjectSummary[], summary: ProjectSummary): ProjectSummary[] {
  const i = list.findIndex((s) => s.id === summary.id);
  if (i < 0) return [summary, ...list];
  const next = list.slice();
  next[i] = summary;
  return next;
}

// =============================================================================================
// Board columns & fan-out tree
// =============================================================================================

export interface BoardColumn {
  id: string;
  label: string;
  hint: string;
  tone: 'sky' | 'amber' | 'rose' | 'emerald' | 'zinc' | string;
  items: ProjectSummary[];
}

/**
 * Status-group columns, or — when one blueprint is selected — its stages (by current stage) plus a
 * closing column for finished projects. A project whose stage is unknown lands in the first stage.
 */
export function boardColumns(list: ProjectSummary[], blueprint?: Blueprint | null): BoardColumn[] {
  if (!blueprint || blueprint.stages.length === 0) {
    return GROUP_ORDER.map((g) => ({
      id: g, label: GROUP_META[g].label, hint: GROUP_META[g].hint, tone: GROUP_META[g].tone,
      items: list.filter((s) => statusGroup(s) === g),
    }));
  }
  const columns: BoardColumn[] = blueprint.stages.map((st) => ({
    id: st.id, label: st.name, hint: st.description || `${st.steps.length} steps`, tone: st.color || 'zinc', items: [],
  }));
  const closed: BoardColumn = { id: '__closed', label: 'Closed', hint: 'Delivered or cancelled', tone: 'emerald', items: [] };
  for (const s of list) {
    if (FINISHED.includes(s.status)) {
      closed.items.push(s);
      continue;
    }
    (columns.find((c) => c.id === s.current_stage_id) ?? columns[0]).items.push(s);
  }
  return [...columns, closed];
}

export interface TreeNode {
  summary: ProjectSummary;
  children: TreeNode[];
  /** True when the parent exists but is filtered out of the list (shown as a root with a hint). */
  orphan: boolean;
}

/** Fan-out hierarchy: parents with their children (any depth); children of absent parents become roots. */
export function buildTree(list: ProjectSummary[]): TreeNode[] {
  const ids = new Set(list.map((s) => s.id));
  const byParent = new Map<string, ProjectSummary[]>();
  for (const s of list) {
    if (s.parent_id && ids.has(s.parent_id)) {
      const arr = byParent.get(s.parent_id) ?? [];
      arr.push(s);
      byParent.set(s.parent_id, arr);
    }
  }
  const seen = new Set<string>();
  const build = (s: ProjectSummary, orphan: boolean): TreeNode => {
    seen.add(s.id);
    const kids = (byParent.get(s.id) ?? []).filter((k) => !seen.has(k.id));   // cycles never loop
    return { summary: s, orphan, children: kids.map((k) => build(k, false)) };
  };
  return list.filter((s) => !s.parent_id || !ids.has(s.parent_id)).map((s) => build(s, !!s.parent_id));
}

// =============================================================================================
// Project page: steps, permissions, traces
// =============================================================================================

export interface StepRef {
  stage: StageRun;
  step: StepRun;
  /** 0-based stage index (for "Stage 2 of 5"). */
  stageIndex: number;
}

export function allSteps(project: Pick<Project, 'stages'>): StepRef[] {
  return project.stages.flatMap((stage, stageIndex) => stage.steps.map((step) => ({ stage, step, stageIndex })));
}

export function findStep(project: Pick<Project, 'stages'>, stepId: string | undefined): StepRef | undefined {
  if (!stepId) return undefined;
  return allSteps(project).find((r) => r.step.id === stepId);
}

/** Done + skipped over total steps. */
export function projectProgress(project: Pick<Project, 'stages'>): { done: number; total: number; ratio: number } {
  const steps = allSteps(project).map((r) => r.step);
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return { done, total: steps.length, ratio: steps.length ? done / steps.length : 0 };
}

/**
 * True when the step is in a state a person can act on: a form/review/approval, a failure to
 * handle, a manual start, or a wait that may be completed by hand.
 */
export function isActionableStatus(step: StepRun, stage?: Pick<StageRun, 'status'>): boolean {
  if (HUMAN_WAIT_STATUSES.includes(step.status) || step.status === 'failed') return true;
  if (step.status === 'pending') return !step.auto_start && (!stage || stage.status === 'active');
  if (step.status === 'waiting_external') return step.config?.manual_complete === true;
  return false;
}

/** Approver roles that still have to decide (policy `all`: one approval per listed role). */
export function pendingApproverRoles(step: StepRun): string[] {
  if (step.type !== 'approval') return [];
  const cfg = step.config as Partial<ApprovalConfig>;
  const decided = new Set(step.approvals.map((a) => a.role));
  return (cfg.approvers ?? []).map((a) => a.role).filter((r) => r && !decided.has(r));
}

/**
 * Mirror of the backend `can_act` (SPEC §12) for the UI: may this persona act on this step now?
 * The backend stays the authority (403 with a readable message); this only decides whether the
 * step drawer opens on the task panel or on the read-only details.
 */
export function canActOnStep(project: Pick<Project, 'sponsor_id' | 'owner_id'>, ref: Pick<StepRef, 'step' | 'stage'>, user: User | null): boolean {
  const { step, stage } = ref;
  if (!user || !isActionableStatus(step, stage)) return false;
  if (user.roles.includes('admin')) return true;
  if (step.assignee_user_ids.includes(user.id)) return true;
  if (step.status === 'failed' && project.owner_id === user.id) return true;
  const roles = new Set(user.roles);
  if (step.assignee.roles.some((r) => roles.has(r))) return true;
  if (step.type === 'approval') {
    return pendingApproverRoles(step).some((r) =>
      roles.has(r) && (r !== 'sponsor' || !project.sponsor_id || project.sponsor_id === user.id));
  }
  return false;
}

/** Elapsed time of a step: started → completed, or → now while it is still open. */
export function stepDurationMs(step: Pick<StepRun, 'started_at' | 'completed_at'>, now: number = Date.now()): number | null {
  const start = ms(step.started_at);
  if (start === null) return null;
  const end = ms(step.completed_at) ?? now;
  return Math.max(0, end - start);
}

/** The AI contributed to this step (draft, brief, estimate suggestion, or an AI step type). */
export function hasAiContribution(step: StepRun): boolean {
  return !!step.ai_draft || !!step.brief || !!step.estimate?.ai_suggestion || step.ai_busy
    || ((step.type === 'ai_task' || step.type === 'agent_task' || step.type === 'quality_gate') && step.status === 'done');
}

export function isTerminal(status: StepStatus): boolean {
  return STEP_TERMINAL_STATUSES.includes(status);
}

/** The step whose output landed in `vars[key]` (store_as, else the step id). */
export function varSourceStep(project: Pick<Project, 'stages'>, key: string): StepRef | undefined {
  return allSteps(project).find((r) => (r.step.store_as || r.step.id) === key);
}

export interface MergedTraceEntry extends TraceEntry {
  step_id: string;
  step_name: string;
  /** Stable React key (same entry from REST and from the WebSocket dedupes). */
  key: string;
}

export function traceKey(stepId: string, e: Pick<TraceEntry, 'ts' | 'kind' | 'text'>): string {
  return `${stepId}|${e.ts}|${e.kind}|${e.text.slice(0, 80)}`;
}

/**
 * Every step trace of the project in chronological order, plus live entries received over the
 * WebSocket since the last fetch (deduplicated: a refetch includes them too).
 */
export function mergedTrace(project: Pick<Project, 'stages'>, live: Record<string, TraceEntry[]> = {}): MergedTraceEntry[] {
  const out: MergedTraceEntry[] = [];
  const seen = new Set<string>();
  const names = new Map<string, string>();
  const push = (stepId: string, e: TraceEntry) => {
    const key = traceKey(stepId, e);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...e, step_id: stepId, step_name: names.get(stepId) ?? stepId, key });
  };
  for (const { step } of allSteps(project)) {
    names.set(step.id, step.name);
    for (const e of step.trace) push(step.id, e);
  }
  for (const [stepId, entries] of Object.entries(live)) for (const e of entries) push(stepId, e);
  return out
    .map((e, i) => ({ e, i, t: ms(e.ts) ?? 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.e);
}
