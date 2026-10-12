// Pure logic behind Home, Inbox and the TaskPanel (src/views/task/logic.ts) and the project page /
// portfolio (src/views/project/model.ts): inbox grouping and "next item", permission mirrors,
// factory flow counts, portfolio URL round-trip and the merged trace.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { InboxItem, Project, ProjectSummary, StepRun, User } from '../src/types';
import {
  canActOnStep as canActTask, factoryFlow, filterInbox, groupInbox, holdsRole, mergeTrace, nextSelection, parseInboxId, rowsToArgs, argsToRows,
} from '../src/views/task/logic';
import {
  canActOnStep as canActProject, isActionableStatus, mergedTrace, parsePortfolioQuery, portfolioQueryToParams, statusGroup,
} from '../src/views/project/model';

const user = (id: string, roles: string[]): User => ({
  id, name: id, email: '', title: '', roles, team_ids: [], active: true, avatar_color: '', created_at: '',
});

const step = (over: Partial<StepRun>): StepRun => ({
  id: 's1', name: 'Step', type: 'human_form', description: '', config: {},
  assignee: { roles: [], user_ids: [], project_role: '' }, assignee_user_ids: [], status: 'waiting_human', when: '',
  store_as: '', sla_breached: false, auto_start: true, completed_by: '', attempts: 1, error: '', heal_hint: '',
  output_summary: '', form: {}, ai_busy: false, approvals: [], brief: '', checks: [], child_ids: [], feedback: '', trace: [],
  ...over,
});

const project = (steps: StepRun[], over: Partial<Project> = {}): Project => ({
  id: 'p1', key: 'UC-1', title: 'T', description: '', blueprint_id: 'bp', blueprint_name: 'BP', blueprint_version: 1, kind: '',
  status: 'active', priority: 'medium', sponsor_id: '', owner_id: '', team_id: '', stakeholder_ids: [], tags: [], inputs: {}, vars: {},
  source: { type: 'manual', watcher_id: '', intake_id: '', connector_id: '', external_id: '', url: '', raw: {} },
  parent_id: '', parent_step_id: '', child_ids: [],
  stages: [{ id: 'st1', name: 'Stage', description: '', color: 'sky', parallel: false, status: 'active', steps }],
  current_stage_id: 'st1', artifacts: [], links: [], risk: { score: 0, level: 'low', reasons: [] }, ai_summary: '',
  metrics: { llm_calls: 0, tokens_in: 0, tokens_out: 0, ai_steps: 0, human_steps: 0, hours_saved: 0 },
  autonomy: '', created_by: '', created_at: '', updated_at: '', ...over,
});

const item = (id: string, kind: InboxItem['kind'], over: Partial<InboxItem> = {}): InboxItem => ({
  id, kind, project_id: 'p1', project_key: 'UC-1', project_title: 'Payments', step_id: id, step_name: 'Review', title: `Item ${id}`,
  subtitle: '', priority: 'medium', overdue: false, created_at: '', risk_level: '', ...over,
});

const summary = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: 'p', key: 'K', title: 't', kind: '', blueprint_id: 'bp', blueprint_name: 'BP', status: 'active', priority: 'medium',
  sponsor_id: '', owner_id: '', team_id: '', current_stage_id: 'a', current_stage_name: 'A', progress: 0, open_step_names: [],
  open_step_statuses: [], risk: { score: 0, level: 'low', reasons: [] }, parent_id: '', child_count: 0, children_done: 0,
  created_at: '', updated_at: '', tags: [], ...over,
});

describe('inbox', () => {
  test('overdue items group first whatever their kind; empty groups are dropped', () => {
    const groups = groupInbox([item('a', 'form'), item('b', 'approval', { overdue: true }), item('c', 'approval')]);
    assert.deepEqual(groups.map((g) => [g.key, g.items.map((i) => i.id)]), [['overdue', ['b']], ['approvals', ['c']], ['forms', ['a']]]);
  });

  test('filter by kind and free text', () => {
    const items = [item('a', 'form'), item('b', 'approval', { title: 'Approve the security review' })];
    assert.deepEqual(filterInbox(items, 'approval', '').map((i) => i.id), ['b']);
    assert.deepEqual(filterInbox(items, 'all', 'SECURITY').map((i) => i.id), ['b']);
    assert.deepEqual(filterInbox(items, 'all', 'payments').map((i) => i.id), ['a', 'b']);
  });

  test('the next selection is the item that took the removed one’s place', () => {
    assert.equal(nextSelection(['a', 'b', 'c'], ['a', 'c'], 'b'), 'c');
    assert.equal(nextSelection(['a', 'b', 'c'], ['a', 'b'], 'c'), 'b');
    assert.equal(nextSelection(['a'], [], 'a'), '');
    assert.equal(nextSelection(['a', 'b'], ['a', 'b'], 'b'), 'b');
  });

  test('inbox ids split into project/step or intake', () => {
    assert.deepEqual(parseInboxId('prj_1:review'), { projectId: 'prj_1', stepId: 'review' });
    assert.deepEqual(parseInboxId('intake:int_9'), { intakeId: 'int_9' });
    assert.equal(parseInboxId('nonsense'), null);
    assert.equal(parseInboxId('prj_1:'), null);
  });
});

describe('permissions mirror', () => {
  const approval = step({
    type: 'approval', status: 'waiting_approval',
    config: { approvers: [{ role: 'sponsor', label: 'Sponsor' }, { role: 'security', label: 'Security' }], policy: 'all' },
  });

  test('sponsor role is project-scoped', () => {
    const p = project([approval], { sponsor_id: 'alice' });
    assert.equal(holdsRole(p, user('alice', []), 'sponsor'), true);
    assert.equal(holdsRole(p, user('bob', ['sponsor']), 'sponsor'), false);
    assert.equal(canActProject(p, { stage: p.stages[0], step: approval }, user('bob', ['sponsor'])), false);
    assert.equal(canActProject(p, { stage: p.stages[0], step: approval }, user('carol', ['security'])), true);
  });

  test('assignees and role holders act; others do not; admins always', () => {
    const s = step({ assignee: { roles: ['dev'], user_ids: [], project_role: '' }, assignee_user_ids: ['dana'] });
    const p = project([s]);
    assert.equal(canActTask(p, s, user('dana', []), false), true);
    assert.equal(canActTask(p, s, user('eve', ['dev']), false), true);
    assert.equal(canActTask(p, s, user('finn', ['pm']), false), false);
    assert.equal(canActTask(p, s, user('root', ['admin']), true), true);
    assert.equal(canActTask(p, s, null, false), false);
  });

  test('a running step is not actionable; a manual start is once its stage is active', () => {
    assert.equal(isActionableStatus(step({ status: 'running' })), false);
    assert.equal(isActionableStatus(step({ status: 'pending', auto_start: false }), { status: 'active' }), true);
    assert.equal(isActionableStatus(step({ status: 'pending', auto_start: false }), { status: 'pending' }), false);
  });
});

describe('args editor', () => {
  test('rows round-trip strings, numbers, booleans and JSON', () => {
    const args = { summary: 'Hello', points: 3, urgent: true, labels: ['a', 'b'] };
    const { args: back, errors } = rowsToArgs(argsToRows(args));
    assert.deepEqual(errors, {});
    assert.deepEqual(back, args);
  });
});

describe('factory flow', () => {
  test('counts in-flight projects per blueprint stage, flags attention and blocks', () => {
    const bp = {
      id: 'bp', name: 'Use case', icon: 'Workflow', color: 'sky',
      stages: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    } as unknown as Parameters<typeof factoryFlow>[1][number];
    const rows = factoryFlow([
      summary({ id: '1', current_stage_id: 'a', open_step_statuses: ['waiting_approval'] }),
      summary({ id: '2', current_stage_id: 'b', status: 'blocked' }),
      summary({ id: '3', current_stage_id: 'b', status: 'done' }),
    ], [bp]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total, 2);
    assert.deepEqual(rows[0].stages.map((s) => [s.id, s.count, s.attention, s.blocked]), [['a', 1, 1, 0], ['b', 1, 0, 1]]);
  });
});

describe('portfolio & trace', () => {
  test('the URL query round-trips and omits defaults', () => {
    const q = parsePortfolioQuery({ view: 'board', status: 'open', risk: 'at_risk', mine: '1', blueprint_id: 'bp' });
    assert.deepEqual(portfolioQueryToParams(q), { view: 'board', status: 'open', blueprint: 'bp', risk: 'at_risk', mine: '1' });
    assert.deepEqual(portfolioQueryToParams(parsePortfolioQuery({ view: 'nope', sort: 'updated', dir: 'desc' })), {});
  });

  test('status groups', () => {
    assert.equal(statusGroup(summary({ status: 'done' })), 'done');
    assert.equal(statusGroup(summary({ status: 'blocked' })), 'blocked');
    assert.equal(statusGroup(summary({ open_step_statuses: ['waiting_human'] })), 'people');
  });

  test('merged trace is chronological and dedupes live entries already persisted', () => {
    const e1 = { ts: '2026-10-11T10:00:00Z', kind: 'info' as const, agent: 'engine', text: 'one' };
    const e2 = { ts: '2026-10-11T10:01:00Z', kind: 'thought' as const, agent: 'ai', text: 'two' };
    const p = project([step({ id: 'x', trace: [e2] }), step({ id: 'y', trace: [e1] })]);
    const merged = mergedTrace(p, { x: [e2, { ...e2, ts: '2026-10-11T10:02:00Z', text: 'three' }] });
    assert.deepEqual(merged.map((e) => `${e.step_id}:${e.text}`), ['y:one', 'x:two', 'x:three']);
    assert.equal(mergeTrace([e1], [e1, e2]).length, 2);
  });
});
