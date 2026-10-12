// The typed client: every SPEC §9 endpoint maps to the right method + path + body, user_id travels
// with mutations, and backend errors surface as readable ApiError messages.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { api, ApiError, errorMessage, setActingUser } from '../src/api';

interface Call { method: string; url: string; body: unknown }
let calls: Call[] = [];
let reply: () => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  reply = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return reply();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const last = () => calls[calls.length - 1];

describe('endpoint mapping', () => {
  const U = 'usr_1';
  const cases: Array<[string, () => Promise<unknown>, string, string, Record<string, unknown>?]> = [
    ['health', () => api.health(), 'GET', '/api/health'],
    ['health with inbox', () => api.health(U), 'GET', '/api/health?user_id=usr_1'],
    ['bootstrap', () => api.bootstrap(), 'GET', '/api/bootstrap'],
    ['settings.update', () => api.settings.update({ llm: { model: 'm' } }), 'PUT', '/api/settings', { llm: { model: 'm' } }],
    ['llm.test', () => api.llm.test({ base_url: 'http://x' }), 'POST', '/api/llm/test', { base_url: 'http://x' }],
    ['llm.models', () => api.llm.models('ollama', 'http://h:1'), 'GET', '/api/llm/models?provider=ollama&base_url=http%3A%2F%2Fh%3A1'],
    ['llm.modelsDraft', () => api.llm.modelsDraft({ base_url: 'http://x', api_key: 'sk' }), 'POST', '/api/llm/models', { base_url: 'http://x', api_key: 'sk' }],
    ['users.remove', () => api.users.remove('usr 2'), 'DELETE', '/api/users/usr%202'],
    ['roles.update', () => api.roles.update([]), 'PUT', '/api/roles'],
    ['connectors.call', () => api.connectors.call('con_1', 'jira_search', { jql: 'x' }), 'POST', '/api/connectors/con_1/call', { tool: 'jira_search', args: { jql: 'x' } }],
    ['operations.run', () => api.operations.run('op_1', { a: 1 }), 'POST', '/api/operations/op_1/run', { input: { a: 1 } }],
    ['operations.suggest', () => api.operations.suggest('con_1', 'list'), 'POST', '/api/operations/suggest', { connector_id: 'con_1', intent: 'list' }],
    ['blueprints.duplicate', () => api.blueprints.duplicate('bp_1'), 'POST', '/api/blueprints/bp_1/duplicate'],
    ['blueprints.generate', () => api.blueprints.generate('desc'), 'POST', '/api/blueprints/generate', { description: 'desc' }],
    ['projects.list', () => api.projects.list({ status: 'active', q: '', user_id: U }), 'GET', '/api/projects?status=active&user_id=usr_1'],
    ['projects.update', () => api.projects.update('prj_1', U, { title: 'T' }), 'PATCH', '/api/projects/prj_1', { title: 'T', user_id: U }],
    ['projects.cancel', () => api.projects.cancel('prj_1', U, 'why'), 'POST', '/api/projects/prj_1/cancel', { user_id: U, reason: 'why' }],
    ['projects.comment', () => api.projects.comment('prj_1', U, 'hi'), 'POST', '/api/projects/prj_1/comments', { user_id: U, text: 'hi' }],
    ['projects.updateArtifact', () => api.projects.updateArtifact('prj_1', 'art_1', U, 'c'), 'PUT', '/api/projects/prj_1/artifacts/art_1', { user_id: U, content: 'c' }],
    ['projects.dossier', () => api.projects.dossier('prj_1'), 'GET', '/api/projects/prj_1/dossier'],
    ['projects.report', () => api.projects.report('prj_1', 'executive'), 'POST', '/api/projects/prj_1/report', { audience: 'executive' }],
    ['projects.addLink', () => api.projects.addLink('prj_1', U, { kind: 'jira', label: 'MCPF-1' }), 'POST', '/api/projects/prj_1/links', { kind: 'jira', label: 'MCPF-1', user_id: U }],
    ['projects.explainRisk', () => api.projects.explainRisk('prj_1'), 'POST', '/api/projects/prj_1/explain-risk'],
    ['steps.aiDraft', () => api.steps.aiDraft('prj_1', 'spec', U, 'shorter'), 'POST', '/api/projects/prj_1/steps/spec/ai-draft', { user_id: U, instructions: 'shorter' }],
    ['steps.decide', () => api.steps.decide('prj_1', 'ok', U, 'approved', 'lgtm'), 'POST', '/api/projects/prj_1/steps/ok/decide', { user_id: U, decision: 'approved', comment: 'lgtm' }],
    ['steps.gate', () => api.steps.gate('prj_1', 'qg', U, 'override', { comment: 'c', rule_ids: ['r1'] }), 'POST', '/api/projects/prj_1/steps/qg/gate', { user_id: U, action: 'override', comment: 'c', rule_ids: ['r1'] }],
    ['steps.reassign', () => api.steps.reassign('prj_1', 's', U, ['usr_2']), 'POST', '/api/projects/prj_1/steps/s/reassign', { user_id: U, user_ids: ['usr_2'] }],
    ['inbox.counts', () => api.inbox.counts(U), 'GET', '/api/inbox/counts?user_id=usr_1'],
    ['intake.accept', () => api.intake.accept('int_1', U, { priority: 'high' }), 'POST', '/api/intake/int_1/accept', { user_id: U, priority: 'high' }],
    ['intake.dismiss', () => api.intake.dismiss('int_1', U, 'dup'), 'POST', '/api/intake/int_1/dismiss', { user_id: U, reason: 'dup' }],
    ['watchers.reset', () => api.watchers.reset('wat_1'), 'POST', '/api/watchers/wat_1/reset'],
    ['prompts.reset', () => api.prompts.reset('writer'), 'POST', '/api/prompts/writer/reset'],
    ['notifications.list', () => api.notifications.list(U, true), 'GET', '/api/notifications?user_id=usr_1&unread=true'],
    ['notifications.markRead', () => api.notifications.markRead(U, { all: true }), 'POST', '/api/notifications/read', { user_id: U, all: true }],
    ['events.list', () => api.events.list({ limit: 50, kind: 'step.failed' }), 'GET', '/api/events?limit=50&kind=step.failed'],
    ['events.verify', () => api.events.verify(), 'GET', '/api/events/verify'],
    ['kpis', () => api.kpis(7), 'GET', '/api/kpis?days=7'],
    ['ai.rewrite', () => api.ai.rewrite('t', 'jira'), 'POST', '/api/ai/rewrite', { text: 't', style: 'jira' }],
    ['briefing', () => api.briefing(U), 'GET', '/api/briefing?user_id=usr_1'],
    ['copilot.send', () => api.copilot.send({ user_id: U, message: 'm' }), 'POST', '/api/copilot', { user_id: U, message: 'm' }],
    ['copilot.get', () => api.copilot.get('chat_1'), 'GET', '/api/copilot/chat_1'],
    ['admin.installDemo', () => api.admin.installDemo(), 'POST', '/api/admin/demo/install'],
    ['admin.simulateUseCase', () => api.admin.simulateUseCase('fintech'), 'POST', '/api/admin/demo/simulate-use-case', { hint: 'fintech' }],
    ['admin.import', () => api.admin.import({ users: [] }), 'POST', '/api/admin/import', { users: [] }],
    ['admin.llmCalls', () => api.admin.llmCalls(30), 'GET', '/api/admin/llm-calls?days=30'],
  ];
  for (const [name, call, method, url, body] of cases) {
    test(name, async () => {
      await call();
      assert.equal(last().method, method);
      assert.equal(last().url, url);
      if (body) assert.deepEqual(last().body, body);
    });
  }
});

describe('errors', () => {
  test('backend {detail} string becomes the message', async () => {
    reply = () => new Response(JSON.stringify({ detail: 'No LLM configured — open Settings › AI Model' }), { status: 503 });
    await assert.rejects(api.health(), (err: unknown) => err instanceof ApiError && err.status === 503 && err.message.startsWith('No LLM configured'));
  });

  test('FastAPI validation arrays are flattened', async () => {
    reply = () => new Response(JSON.stringify({ detail: [{ loc: ['body', 'title'], msg: 'Field required' }] }), { status: 422 });
    await assert.rejects(api.projects.create({ blueprint_id: 'b', title: '', created_by: 'u' }), /title: Field required/);
  });

  test('structured detail keeps its code', async () => {
    reply = () => new Response(JSON.stringify({ detail: { error: 'version_conflict', message: 'Edited elsewhere' } }), { status: 409 });
    await assert.rejects(api.health(), (err: unknown) => err instanceof ApiError && err.code === 'version_conflict' && err.message === 'Edited elsewhere');
  });

  test('network failure explains what to check', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    await assert.rejects(api.health(), /Cannot reach the Factory API/);
    assert.equal(errorMessage('plain'), 'plain');
  });

  test('204 and empty bodies resolve to undefined', async () => {
    reply = () => new Response(null, { status: 204 });
    assert.equal(await api.projects.remove('prj_1'), undefined);
  });
});

describe('acting persona', () => {
  afterEach(() => setActingUser(''));

  test('mutations without a user_id in the SPEC body are attributed through the query string', async () => {
    setActingUser('usr_admin');
    await api.rules.remove('rule_1');
    assert.equal(last().url, '/api/rules/rule_1?user_id=usr_admin');
    await api.settings.update({ engine: { autonomy: 'full' } });
    assert.equal(last().url, '/api/settings?user_id=usr_admin');
    await api.llm.models('ollama');
    assert.equal(last().url, '/api/llm/models?provider=ollama', 'reads are never tagged');
  });

  test('a request never carries two identities: an explicit user_id wins', async () => {
    setActingUser('usr_admin');
    await api.steps.decide('prj_1', 'ok', 'usr_sponsor', 'approved');
    assert.equal(last().url, '/api/projects/prj_1/steps/ok/decide');
    assert.equal((last().body as { user_id: string }).user_id, 'usr_sponsor');
    await api.projects.list({ user_id: 'usr_dev' });
    assert.equal(last().url, '/api/projects?user_id=usr_dev');
  });

  test('ids are URL-encoded and no persona means no tag', async () => {
    setActingUser('usr a&b');
    await api.blueprints.duplicate('bp_1');
    assert.equal(last().url, '/api/blueprints/bp_1/duplicate?user_id=usr%20a%26b');
    setActingUser('');
    await api.blueprints.duplicate('bp_1');
    assert.equal(last().url, '/api/blueprints/bp_1/duplicate');
  });
});
