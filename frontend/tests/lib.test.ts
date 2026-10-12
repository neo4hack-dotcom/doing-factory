// Pure helpers: formatting, routing, shortcuts, WS backoff, status vocabulary, LLM locality, charts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { niceTicks, safeColor, seriesColor } from '../src/components/Charts';
import {
  dueLabel, formatCompact, formatDate, formatDuration, formatHours, formatPercent, humanize, initials, plural, timeAgo,
} from '../src/lib/format';
import { comboOf, SequenceMatcher } from '../src/lib/hotkeys';
import { isCloudModel, llmLocality } from '../src/lib/llm';
import { NAV_ITEMS, ROUTE_TITLES, SETTINGS_NAV } from '../src/lib/nav';
import {
  confirmNavigation, isActivePath, navigate, parseRoute, paths, registerNavigationGuard, SETTINGS_TABS,
} from '../src/lib/router';
import { PRIORITY, STEP_STATUS, statusMeta } from '../src/lib/status';
import { STEP_TYPE_ORDER, STEP_TYPES } from '../src/types';
import { backoffDelay, wsUrl } from '../src/ws';

const NOW = Date.parse('2026-10-11T12:00:00Z');

describe('format', () => {
  test('timeAgo uses English units and switches to a date after four weeks', () => {
    assert.equal(timeAgo('2026-10-11T11:59:30Z', NOW), 'just now');
    assert.equal(timeAgo('2026-10-11T11:55:00Z', NOW), '5m ago');
    assert.equal(timeAgo('2026-10-11T09:00:00Z', NOW), '3h ago');
    assert.equal(timeAgo('2026-10-09T12:00:00Z', NOW), '2d ago');
    assert.equal(timeAgo('2026-10-11T16:00:00Z', NOW), 'in 4h');
    assert.equal(timeAgo('2026-08-01T12:00:00Z', NOW), '1 Aug 2026');
    assert.equal(timeAgo(null, NOW), '—');
    assert.equal(timeAgo('not a date', NOW), '—');
  });

  test('durations keep the two most significant units', () => {
    assert.equal(formatDuration((2 * 24 + 4) * 3600_000), '2d 4h');
    assert.equal(formatDuration((3 * 60 + 12) * 60_000), '3h 12m');
    assert.equal(formatDuration(45 * 60_000), '45m');
    assert.equal(formatDuration(12_000), '12s');
    assert.equal(formatHours(52), '2d 4h');
    assert.equal(formatHours(null), '—');
  });

  test('numbers, percents and labels', () => {
    assert.equal(formatCompact(1284), '1,284');
    assert.equal(formatCompact(12_900), '12.9K');
    assert.equal(formatCompact(4_200_000), '4.2M');
    assert.equal(formatPercent(0.423), '42%');
    assert.equal(formatPercent(42.3, false, 1), '42.3%');
    assert.equal(formatPercent(undefined), '—');
    assert.equal(initials('Alice Martin'), 'AM');
    assert.equal(initials('Admin'), 'AD');
    assert.equal(plural(1, 'project'), '1 project');
    assert.equal(plural(3, 'project'), '3 projects');
    assert.equal(humanize('waiting_approval'), 'Waiting approval');
    assert.equal(formatDate('2026-10-11T12:00:00Z'), '11 Oct 2026');
  });

  test('dueLabel flags overdue and soon', () => {
    assert.deepEqual(dueLabel('2026-10-11T10:00:00Z', NOW), { label: 'overdue 2h', overdue: true, soon: false });
    assert.deepEqual(dueLabel('2026-10-11T18:00:00Z', NOW), { label: 'due in 6h', overdue: false, soon: true });
    assert.equal(dueLabel(null, NOW).label, '');
  });
});

describe('router', () => {
  test('every SPEC §11 route parses to its view with params', () => {
    const cases: Array<[string, string, Record<string, string>]> = [
      ['#/', 'home', {}],
      ['', 'home', {}],
      ['#/inbox', 'inbox', {}],
      ['#/inbox/prj_1%3Aspec', 'inbox', { itemId: 'prj_1:spec' }],
      ['#/projects', 'projects', {}],
      ['#/projects/new', 'project-new', {}],
      ['#/projects/prj_abc', 'project', { id: 'prj_abc' }],
      ['#/projects/prj_abc/spec', 'project', { id: 'prj_abc', stepId: 'spec' }],
      ['#/floor', 'floor', {}],
      ['#/intake', 'intake', {}],
      ['#/kpis', 'kpis', {}],
      ['#/studio/blueprints', 'blueprints', {}],
      ['#/studio/blueprints/bp_1', 'blueprint', { id: 'bp_1' }],
      ['#/studio/operations', 'operations', {}],
      ['#/studio/prompts', 'prompts', {}],
      ['#/studio/rules', 'rules', {}],
      ['#/settings/connectors', 'settings', { tab: 'connectors' }],
    ];
    for (const [hash, name, params] of cases) {
      const r = parseRoute(hash);
      assert.equal(r.name, name, hash);
      assert.deepEqual(r.params, params, hash);
    }
    assert.equal(parseRoute('#/nope/what').name, 'not-found');
  });

  test('query strings and trailing slashes', () => {
    const r = parseRoute('#/projects/?status=active&q=pay%20ments');
    assert.equal(r.name, 'projects');
    assert.equal(r.path, '/projects');
    assert.deepEqual(r.query, { status: 'active', q: 'pay ments' });
    assert.equal(parseRoute('#/projects/new?blueprint=bp_9').query.blueprint, 'bp_9');
  });

  test('path builders round-trip ids that need encoding', () => {
    const r = parseRoute(`#${paths.project('prj/1 x', 'step:a')}`);
    assert.deepEqual(r.params, { id: 'prj/1 x', stepId: 'step:a' });
    assert.equal(paths.newProject('bp_1'), '/projects/new?blueprint=bp_1');
    assert.equal(paths.settings(), '/settings/ai');
    assert.ok(isActivePath('/projects/prj_1', '/projects'));
    assert.ok(!isActivePath('/projects', '/'));
    assert.ok(isActivePath('/', '/'));
  });

  test('navigation guards can cancel programmatic navigate() calls', () => {
    const g = globalThis as unknown as { location?: { hash: string } };
    const saved = g.location;
    g.location = { hash: '#/' };
    try {
      navigate('/projects');
      assert.equal(g.location.hash, '#/projects');

      const asked: string[] = [];
      let allow = false;
      const unregister = registerNavigationGuard((to) => { asked.push(to); return allow; });
      navigate(paths.inbox());
      assert.equal(g.location.hash, '#/projects', 'a refusing guard keeps the user on the page');
      assert.deepEqual(asked, ['/inbox']);

      navigate('/projects');                       // same place: nothing to leave, nobody asked
      assert.deepEqual(asked, ['/inbox']);

      navigate('/kpis', { force: true });           // the caller already confirmed (or just saved)
      assert.equal(g.location.hash, '#/kpis');
      assert.equal(asked.length, 1);

      allow = true;
      navigate('floor');
      assert.equal(g.location.hash, '#/floor');
      assert.deepEqual(asked, ['/inbox', '/floor']);

      // Newest guard first; the first refusal stops the chain.
      const order: string[] = [];
      const second = registerNavigationGuard(() => { order.push('second'); return false; });
      assert.equal(confirmNavigation('/intake'), false);
      assert.deepEqual(order, ['second']);
      assert.equal(asked.length, 2, 'older guards are not asked once a newer one refused');
      second();
      assert.equal(confirmNavigation('/intake'), true);

      unregister();
      assert.equal(confirmNavigation('/intake'), true);
      navigate('/intake');
      assert.equal(g.location.hash, '#/intake');
      assert.equal(asked.length, 3, 'an unregistered guard is never consulted again');
    } finally {
      g.location = saved;
    }
  });

  test('navigation vocabulary covers every route and settings tab', () => {
    for (const name of Object.keys(ROUTE_TITLES)) assert.ok(ROUTE_TITLES[name as keyof typeof ROUTE_TITLES]);
    assert.deepEqual(SETTINGS_NAV.map((s) => s.key), SETTINGS_TABS.map((t) => t.key));
    for (const item of NAV_ITEMS) assert.notEqual(parseRoute(`#${item.path}`).name, 'not-found', item.path);
    const shortcuts = NAV_ITEMS.map((n) => n.shortcut).filter(Boolean);
    assert.deepEqual([...shortcuts].sort(), ['f', 'h', 'i', 'k', 'p', 's', 'u']);
  });
});

describe('hotkeys', () => {
  const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
    comboOf({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

  test('combo normalisation', () => {
    assert.equal(key('k', { metaKey: true }), 'mod+k');
    assert.equal(key('K', { ctrlKey: true }), 'mod+k');
    assert.equal(key('?', { shiftKey: true }), '?');
    assert.equal(key('ArrowUp', { shiftKey: true }), 'shift+arrowup');
  });

  test('two-key sequences fire within the timeout only', () => {
    const bindings = ['g h', 'g i', 'j', 'mod+k'];
    const m = new SequenceMatcher(1000);
    assert.equal(m.press('g', bindings, 0), 'pending');
    assert.equal(m.press('h', bindings, 500), 'g h');
    assert.equal(m.press('g', bindings, 2000), 'pending');
    assert.equal(m.press('i', bindings, 3500), null, 'expired prefix');
    assert.equal(m.press('g', bindings, 4000), 'pending');
    assert.equal(m.press('j', bindings, 4100), 'j', 'unknown sequence falls through to the single key');
    assert.equal(m.press('mod+k', bindings, 5000), 'mod+k');
  });
});

describe('ws', () => {
  test('capped exponential backoff', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 10].map(backoffDelay), [1000, 2000, 4000, 8000, 8000, 8000]);
  });
  test('same-origin URL, wss on https', () => {
    assert.equal(wsUrl({ protocol: 'http:', host: '127.0.0.1:3070' }), 'ws://127.0.0.1:3070/api/ws');
    assert.equal(wsUrl({ protocol: 'https:', host: 'factory.example' }), 'wss://factory.example/api/ws');
  });
});

describe('status & step metadata', () => {
  test('every step type has UI metadata, in the declared order', () => {
    assert.deepEqual(Object.keys(STEP_TYPES).sort(), [...STEP_TYPE_ORDER].sort());
    for (const meta of Object.values(STEP_TYPES)) assert.ok(meta.label && meta.icon && meta.color);
  });
  test('waiting-for-people statuses and unknown values', () => {
    const waiting = Object.entries(STEP_STATUS).filter(([, m]) => m.waiting).map(([k]) => k).sort();
    assert.deepEqual(waiting, ['failed', 'waiting_approval', 'waiting_human']);
    assert.deepEqual(statusMeta('priority', 'critical'), PRIORITY.critical);
    assert.deepEqual(statusMeta('step', 'teleporting'), { label: 'teleporting', tone: 'zinc' });
  });
});

describe('llm locality', () => {
  test('cloud tags and hosts', () => {
    assert.ok(isCloudModel('gpt-oss:120b-cloud'));
    assert.ok(isCloudModel('qwen3.5:cloud'));
    assert.equal(llmLocality({ base_url: '', model: 'x' }), 'none');
    assert.equal(llmLocality({ base_url: 'http://localhost:11434', model: 'qwen3.5:4b' }), 'local');
    assert.equal(llmLocality({ base_url: 'http://127.0.0.1:1234/v1', model: 'x' }), 'local');
    assert.equal(llmLocality({ base_url: 'http://192.168.1.20:8000/v1', model: 'x' }), 'local');
    assert.equal(llmLocality({ base_url: 'http://localhost:11434', model: 'deepseek-v3.1:671b-cloud' }), 'remote');
    assert.equal(llmLocality({ base_url: 'https://api.example.com/v1', model: 'x' }), 'remote');
    assert.equal(llmLocality({ base_url: 'garbage', model: 'x' }), 'remote');
  });
});

describe('chart helpers', () => {
  test('nice ticks', () => {
    assert.deepEqual(niceTicks(0, 17, 4), [0, 5, 10, 15, 20]);
    assert.deepEqual(niceTicks(0, 3, 4, true), [0, 1, 2, 3]);
    assert.deepEqual(niceTicks(0, 0, 4, true), [0, 1]);
    assert.deepEqual(niceTicks(0, 0.9, 4), [0, 0.25, 0.5, 0.75, 1]);
  });
  test('colours from data are whitelisted', () => {
    assert.equal(safeColor('#FF3E00', 'x'), '#FF3E00');
    assert.equal(safeColor('var(--series-2)', 'x'), 'var(--series-2)');
    assert.equal(safeColor('url(https://evil/x.svg#a)', 'fallback'), 'fallback');
    assert.equal(safeColor('red;background:url(x)', 'fallback'), 'fallback');
    assert.equal(seriesColor(0), 'var(--series-1)');
    assert.equal(seriesColor(20), 'var(--series-8)');
  });
});
