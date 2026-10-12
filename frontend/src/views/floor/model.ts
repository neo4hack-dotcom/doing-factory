// Factory Floor read model: pure functions that turn project summaries (+ the blueprints and the
// KPI stage timings) into swimlanes, token states and the top stats. Kept free of React so the
// grouping rules are easy to read and to reason about in one place.
import type { Blueprint, KpiStage, ProjectSummary, StepStatus } from '../../types';
import { PRIORITY } from '../../lib/status';

/** How a token looks on the floor — one visual state per project, most urgent wins. */
export type TokenState = 'blocked' | 'waiting' | 'running' | 'external' | 'idle' | 'done';

const IN_FLIGHT = new Set(['active', 'waiting', 'blocked', 'failed']);
/** Done projects stay visible in the "Shipped" column this long, so a completion is seen. */
export const SHIPPED_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

export function isInFlight(p: ProjectSummary): boolean {
  return IN_FLIGHT.has(p.status);
}

export function tokenState(p: ProjectSummary): TokenState {
  const s: StepStatus[] = p.open_step_statuses;
  if (p.status === 'done') return 'done';
  if (p.status === 'blocked' || p.status === 'failed' || s.some((x) => x === 'failed' || x === 'rejected')) return 'blocked';
  if (s.some((x) => x === 'waiting_human' || x === 'waiting_approval')) return 'waiting';
  if (s.includes('running')) return 'running';
  if (s.some((x) => x === 'waiting_external' || x === 'waiting_children')) return 'external';
  return 'idle';
}

export const TOKEN_STATE_LABEL: Record<TokenState, string> = {
  blocked: 'Blocked — needs attention',
  waiting: 'Waiting on a person',
  running: 'AI / automation running',
  external: 'Waiting on an external system or child projects',
  idle: 'Queued',
  done: 'Done',
};

const STATE_RANK: Record<TokenState, number> = { blocked: 0, waiting: 1, running: 2, external: 3, idle: 4, done: 5 };

/** Most urgent first, then priority, then most recently updated. */
export function compareTokens(a: ProjectSummary, b: ProjectSummary): number {
  return (STATE_RANK[tokenState(a)] - STATE_RANK[tokenState(b)])
    || ((PRIORITY[b.priority]?.rank ?? 0) - (PRIORITY[a.priority]?.rank ?? 0))
    || (b.updated_at || '').localeCompare(a.updated_at || '');
}

export interface LaneColumn {
  id: string;
  name: string;
  color: string;
  tokens: ProjectSummary[];
  /** Average hours a finished run of this stage took (KPIs, last 30 days); null = no data. */
  avgHours: number | null;
  /** Part of it spent waiting on people; null = no data. */
  waitHours: number | null;
}

export interface Lane {
  /** Blueprint id, or `name:<blueprint name>` for projects whose blueprint no longer exists. */
  key: string;
  blueprint: Blueprint | null;
  name: string;
  columns: LaneColumn[];
  shipped: ProjectSummary[];
  inFlight: number;
}

/**
 * One lane per blueprint, one column per stage. A project sits in its current stage (matched by
 * id, then by name: a project runs on the blueprint version it started with); a project not yet
 * in any stage goes to the first column.
 */
export function buildLanes(
  projects: ProjectSummary[],
  blueprints: Blueprint[],
  stageKpis: KpiStage[],
  now: number = Date.now(),
): Lane[] {
  const timing = new Map(stageKpis.map((s) => [`${s.blueprint}\u0000${s.stage}`, s]));
  const lanes = new Map<string, Lane>();

  const laneFor = (p: ProjectSummary): Lane => {
    const bp = blueprints.find((b) => b.id === p.blueprint_id) ?? null;
    const key = bp ? bp.id : `name:${p.blueprint_name || 'Unknown'}`;
    let lane = lanes.get(key);
    if (!lane) {
      const name = bp?.name || p.blueprint_name || 'Unknown blueprint';
      const columns: LaneColumn[] = (bp?.stages ?? []).map((st) => {
        const t = timing.get(`${name}\u0000${st.name}`);
        return { id: st.id, name: st.name, color: st.color, tokens: [], avgHours: t?.avg_hours ?? null, waitHours: t?.avg_wait_hours ?? null };
      });
      lane = { key, blueprint: bp, name, columns, shipped: [], inFlight: 0 };
      lanes.set(key, lane);
    }
    return lane;
  };

  for (const p of projects) {
    if (p.status === 'cancelled') continue;
    if (p.status === 'done') {
      const done = Date.parse(p.completed_at || p.updated_at || '');
      if (Number.isFinite(done) && now - done <= SHIPPED_WINDOW_DAYS * DAY_MS) laneFor(p).shipped.push(p);
      continue;
    }
    const lane = laneFor(p);
    let col = lane.columns.find((c) => c.id === p.current_stage_id)
      ?? lane.columns.find((c) => p.current_stage_name && c.name === p.current_stage_name);
    if (!col && p.current_stage_name && !lane.blueprint) {
      // Blueprint deleted: rebuild the columns from the stage names the projects report.
      col = { id: p.current_stage_id || p.current_stage_name, name: p.current_stage_name, color: '', tokens: [], avgHours: null, waitHours: null };
      lane.columns.push(col);
    }
    col = col ?? lane.columns[0];
    if (!col) {
      col = { id: '_', name: 'In progress', color: '', tokens: [], avgHours: null, waitHours: null };
      lane.columns.push(col);
    }
    col.tokens.push(p);
    lane.inFlight += 1;
  }

  for (const lane of lanes.values()) {
    lane.columns.forEach((c) => c.tokens.sort(compareTokens));
    lane.shipped.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
  }
  // Busiest lanes first; lanes of known blueprints before orphans.
  return [...lanes.values()].sort((a, b) =>
    (Number(!a.blueprint) - Number(!b.blueprint)) || (b.inFlight - a.inFlight) || a.name.localeCompare(b.name));
}

/** An empty lane for a selected blueprint that has no project yet (its stages still show). */
export function emptyLane(bp: Blueprint, stageKpis: KpiStage[]): Lane {
  return {
    key: bp.id, blueprint: bp, name: bp.name, shipped: [], inFlight: 0,
    columns: bp.stages.map((st) => {
      const t = stageKpis.find((s) => s.blueprint === bp.name && s.stage === st.name);
      return { id: st.id, name: st.name, color: st.color, tokens: [], avgHours: t?.avg_hours ?? null, waitHours: t?.avg_wait_hours ?? null };
    }),
  };
}

export interface FloorStats {
  inFlight: number;
  waitingHumans: number;
  runningSteps: number;
  blocked: number;
  completedToday: number;
}

export function floorStats(projects: ProjectSummary[], now: Date = new Date()): FloorStats {
  const today = now.toDateString();
  let inFlight = 0, waitingHumans = 0, runningSteps = 0, blocked = 0, completedToday = 0;
  for (const p of projects) {
    if (p.status === 'done') {
      if (p.completed_at && new Date(p.completed_at).toDateString() === today) completedToday += 1;
      continue;
    }
    if (!isInFlight(p)) continue;
    inFlight += 1;
    const state = tokenState(p);
    if (state === 'blocked') blocked += 1;
    if (p.open_step_statuses.some((s) => s === 'waiting_human' || s === 'waiting_approval')) waitingHumans += 1;
    runningSteps += p.open_step_statuses.filter((s) => s === 'running').length;
  }
  return { inFlight, waitingHumans, runningSteps, blocked, completedToday };
}

/** LLM calls per minute over the last `minutes` minutes (oldest first) from call timestamps (ms). */
export function callsPerMinute(times: number[], now: number, minutes = 30): number[] {
  const buckets = new Array<number>(minutes).fill(0);
  for (const t of times) {
    const age = Math.floor((now - t) / 60_000);
    if (age >= 0 && age < minutes) buckets[minutes - 1 - age] += 1;
  }
  return buckets;
}

/** Upserts a summary into a list by id (live `project.updated` patches). */
export function upsertSummary(list: ProjectSummary[], summary: ProjectSummary): ProjectSummary[] {
  const i = list.findIndex((p) => p.id === summary.id);
  if (i === -1) return [summary, ...list];
  const next = list.slice();
  next[i] = summary;
  return next;
}
