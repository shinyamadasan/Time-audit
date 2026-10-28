// TASK-012 plan item mutations through the Worker: plan_set_completion, plan_edit, plan_move, plan_delete. OAuth
// step-up to chronasense:plan.write, strict typed arguments (stable itemId + exact calendar target + the revision a
// read returned; no path/UID/index/raw field), one signed command carrying expectedRevision, STALE_REVISION as a
// definite answer that names the current revision, and the typed unknown outcome that only allows the SAME action
// (same expectedRevision) to retry. The end-to-end case runs the real Action API pipeline (functions/src).
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { handleMcpRequest, ISSUER, PLAN_WRITE_SCOPE, READ_SCOPE, RESOURCE, WRITE_SCOPE } from '../src/mcp.js';
import { actionActorRef } from '../../../functions/src/envelope.js';
import { revision } from '../../../functions/src/plan-read.js';
import { addCalendarDays, localPlanDate } from '../../../functions/shared/plan-tomorrow-model.js';
import { harness, KEY, NOW_MS, OWNER } from '../../../functions/test/support.js';

const subject = OWNER.ownerSubject;
const env = { CHRONASENSE_OWNER_SUBJECT: subject, CHRONASENSE_ACTION_API_URL: 'https://example.test/v1/query',
  CHRONASENSE_WORKER_HMAC_KEY_ID: 'test-key-1', CHRONASENSE_WORKER_HMAC_KEY_HEX: KEY.toString('hex') };
const nowSeconds = Math.floor(NOW_MS / 1000);
const ZONE = 'Asia/Manila';
const TOMORROW = addCalendarDays(localPlanDate(NOW_MS, ZONE), 1);
const PLAN = `cal1:${TOMORROW}`;
const ACTION = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const CAPTURED = '2026-10-12T12:00:00.000Z';
const REV = `rev1:${'A'.repeat(43)}`;
const BASE = { actionId: ACTION, capturedAt: CAPTURED, expectedRevision: REV, target: { store: 'calendar', id: PLAN }, itemId: 'pgym1' };
const TOOLS = {
  plan_set_completion: { ...BASE, completed: true },
  plan_edit: { ...BASE, time: { when: '19:00', whenTz: ZONE }, durationMinutes: 90 },
  plan_move: { ...BASE, destination: { store: 'calendar', id: `cal1:${addCalendarDays(TOMORROW, 1)}` } },
  plan_delete: BASE,
};

const ctx = scope => ({
  auth: { token: 'fixture-token', audience: RESOURCE, expiresAt: nowSeconds + 300, scope, userId: subject },
  props: { ownerSubject: subject, resource: RESOURCE, issuer: ISSUER, notBefore: nowSeconds - 1 },
});
const call = (name, args) => new Request('https://localhost/mcp', { method: 'POST',
  headers: { Host: 'localhost', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
const list = () => new Request('https://localhost/mcp', { method: 'POST',
  headers: { Host: 'localhost', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
async function message(response) {
  const body = await response.text();
  const line = body.split(/\r?\n/).find(value => value.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : body);
}
const backendError = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) });

test('every plan mutation tool needs read + plan.write; read-only and Brain-Dump grants are challenged before the backend', async () => {
  let calls = 0;
  const deps = { nowSeconds, cryptoImpl: webcrypto, commandActionApi: async () => { calls++; throw new Error('must not be called'); } };
  for (const [name, args] of Object.entries(TOOLS)) {
    for (const scope of [[READ_SCOPE], [READ_SCOPE, WRITE_SCOPE], [PLAN_WRITE_SCOPE]]) {
      const answer = await message(await handleMcpRequest(call(name, args), env, deps, ctx(scope)));
      assert.equal(answer.result.isError, true, `${name} ${scope}`);
      assert.match(JSON.stringify(answer), /insufficient_scope/);
      assert.match(JSON.stringify(answer), /chronasense:read chronasense:plan\.write/);
    }
  }
  assert.equal(calls, 0);
});

test('tools/list: four semantic tools, plan.write scheme, only plan_delete is destructive', async () => {
  const answer = await message(await handleMcpRequest(list(), env, { nowSeconds }, ctx([READ_SCOPE])));
  const byName = Object.fromEntries(answer.result.tools.map(tool => [tool.name, tool]));
  for (const name of Object.keys(TOOLS)) {
    assert.deepEqual(byName[name].securitySchemes, [{ type: 'oauth2', scopes: [READ_SCOPE, PLAN_WRITE_SCOPE] }], name);
    assert.equal(byName[name].annotations.readOnlyHint, false);
    assert.equal(byName[name].annotations.destructiveHint, name === 'plan_delete', name);
    assert.match(byName[name].description, /expectedRevision/);
    assert.ok(byName[name].inputSchema.required.includes('expectedRevision'), `${name} requires the revision`);
  }
});

test('each tool sends ONE command: its kind, the caller\'s expectedRevision, only plan scope, verified actor, no transport fields', async () => {
  for (const [name, args] of Object.entries(TOOLS)) {
    const calls = [];
    const deps = { nowSeconds, cryptoImpl: webcrypto, commandActionApi: async (_env, input) => { calls.push(input); throw backendError('STALE_REVISION', 'changed'); } };
    await handleMcpRequest(call(name, args), env, deps, ctx([READ_SCOPE, WRITE_SCOPE, PLAN_WRITE_SCOPE]));
    assert.equal(calls.length, 1, name);
    assert.deepEqual(calls[0].scopes, [PLAN_WRITE_SCOPE]);
    const { command } = calls[0];
    assert.equal(command.kind, name);
    assert.equal(command.expectedRevision, REV);
    assert.equal(command.actionProvenance.actorRef, actionActorRef(subject));
    const { actionId: _a, capturedAt: _c, expectedRevision: _r, ...parameters } = args;
    assert.deepEqual(command.parameters, parameters, `${name}: exactly the semantic parameters`);
  }
});

test('forged or untyped mutation arguments never reach the backend', async () => {
  let calls = 0;
  const deps = { nowSeconds, cryptoImpl: webcrypto, commandActionApi: async () => { calls++; return {}; } };
  const forged = [
    ['plan_edit', { ...BASE, title: 'x', path: 'rooms/uid_victim/calendarPlans' }],
    ['plan_edit', { ...BASE, title: 'x', uid: 'victim' }],
    ['plan_edit', { ...BASE, title: 'x', creationActionId: ACTION }],
    ['plan_edit', { ...BASE, title: 'x', index: 0 }],
    ['plan_edit', { ...BASE, title: 'x', changes: { task: 'x' } }],
    ['plan_edit', { ...BASE, clearSchedule: false }],
    ['plan_edit', { ...BASE, time: { when: '7pm', whenTz: ZONE } }],
    ['plan_edit', { ...BASE, time: { when: '19:00', whenTz: ZONE, extra: 1 } }],
    ['plan_set_completion', { ...BASE, completed: 'yes' }],
    ['plan_set_completion', { ...BASE, completed: true, expectedRevision: 'etag-123' }],
    ['plan_set_completion', { ...BASE, completed: true, expectedRevision: undefined }],
    // TASK-036: completion alone takes an exact legacy target; never a malformed one, never on another mutation.
    ['plan_set_completion', { ...BASE, completed: true, target: { store: 'legacy', id: PLAN } }],
    ['plan_set_completion', { ...BASE, completed: true, target: { store: 'legacy', id: 'today' } }],
    ['plan_set_completion', { ...BASE, completed: true, target: { store: 'legacy', id: TOMORROW, roomId: 'uid_victim' } }],
    ['plan_set_completion', { ...BASE, completed: true, target: { store: 'operational', id: `odv1:rev:${ZONE}:${TOMORROW}` } }],
    ['plan_edit', { ...BASE, title: 'x', target: { store: 'legacy', id: TOMORROW } }],
    // TASK-038: plan_move takes exact legacy ends too (a mixed pair is the backend's typed refusal), never malformed ones.
    ['plan_move', { ...TOOLS.plan_move, target: { store: 'legacy', id: 'today' } }],
    ['plan_move', { ...BASE, target: { store: 'legacy', id: TOMORROW }, destination: { store: 'legacy', id: 'tomorrow' } }],
    ['plan_move', { ...BASE, target: { store: 'legacy', id: TOMORROW }, destination: { store: 'legacy', id: TOMORROW, roomId: 'uid_victim' } }],
    ['plan_move', { ...BASE, destination: { store: 'operational', id: `odv1:rev:${ZONE}:${TOMORROW}` } }],
    ['plan_delete', { ...BASE, target: { store: 'legacy', id: TOMORROW } }],
    ['plan_set_completion', { ...BASE, completed: true, target: { store: 'calendar', id: PLAN, roomId: 'uid_victim' } }],
    ['plan_set_completion', { ...BASE, completed: true, itemId: '' }],
    ['plan_move', { ...BASE, destination: { store: 'calendar', id: 'friday' } }],
    ['plan_delete', { ...BASE, actionId: 'act1_not-a-uuid' }],
    ['plan_delete', { ...BASE, capturedAt: 'yesterday' }],
  ];
  for (const [name, args] of forged) {
    const answer = await message(await handleMcpRequest(call(name, args), env, deps, ctx([READ_SCOPE, PLAN_WRITE_SCOPE])));
    assert.ok(answer.error || answer.result?.isError, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(calls, 0);
});

test('STALE_REVISION and other definite refusals stay definite (no unknown, no retry hint) and name the current revision', async () => {
  const current = `rev1:${'B'.repeat(43)}`;
  for (const [code, details] of [['STALE_REVISION', { currentRevision: current }], ['PAST_TARGET_IMMUTABLE'], ['DOMAIN_LIMIT'], ['NOT_FOUND'], ['IDEMPOTENCY_CONFLICT']]) {
    const deps = { nowSeconds, cryptoImpl: webcrypto, commandActionApi: async () => { throw backendError(code, 'refused', details); } };
    const answer = (await message(await handleMcpRequest(call('plan_set_completion', TOOLS.plan_set_completion), env, deps, ctx([READ_SCOPE, PLAN_WRITE_SCOPE])))).result;
    assert.equal(answer.isError, true);
    assert.equal(answer.structuredContent, undefined, `${code} is not an unknown outcome`);
    assert.match(answer.content[0].text, new RegExp(`^${code}: refused`));
    if (details) assert.ok(answer.content[0].text.includes(current), 'the caller learns which revision to read');
  }
});

test('unknown outcome: a typed unknown that keeps actionId, capturedAt AND expectedRevision; never a new action ID', async () => {
  const deps = { nowSeconds, cryptoImpl: webcrypto, commandActionApi: async () => { throw backendError('PENDING_UNKNOWN', 'reconciling'); } };
  const answer = (await message(await handleMcpRequest(call('plan_move', TOOLS.plan_move), env, deps, ctx([READ_SCOPE, PLAN_WRITE_SCOPE])))).result;
  const { actionId: _a, capturedAt: _c, expectedRevision: _r, ...parameters } = TOOLS.plan_move;
  assert.deepEqual(answer.structuredContent, { outcome: 'unknown', code: 'PENDING_UNKNOWN', mayHaveCommitted: true,
    retry: { actionId: ACTION, capturedAt: CAPTURED, expectedRevision: REV, parameters, newActionIdAllowed: false } });
  assert.match(answer.content[0].text, /may already be applied/);
  assert.doesNotMatch(JSON.stringify(answer), /(?:use|try|mint|create) a new actionId/i);
});

test('end to end through the real Action API: get the revision, complete, lose the response, retry the SAME action -> one effect', async () => {
  const room = { settings: { timezone: ZONE }, calendarPlanAuthority: { f1: { schemaVersion: 1, id: 'f1', activatedAtMs: NOW_MS - 864e6, timezone: ZONE,
    activationDate: localPlanDate(NOW_MS - 864e6, ZONE), deviceId: 'phone' } },
  calendarPlans: { [PLAN]: { createdAt: 1, timezone: ZONE, updatedAt: 1, updatedBy: 'phone',
    items: [{ id: 'pgym1', task: 'Gym', when: '18:00', whenTz: ZONE, durationMinutes: 60, done: false, updatedAt: 1, updatedBy: 'phone' }] } } };
  let writes = 0;
  const h = harness({ domain: {
    async readRoomCollection(_identity, collection) { return structuredClone(room[collection] ?? null); },
    async readCalendarPlanWithEtag(_identity, planId) { const value = room.calendarPlans[planId] ?? null; return { value: structuredClone(value), etag: JSON.stringify(value) }; },
    async putCalendarPlanIfMatch(_identity, planId, record, etag) {
      if (etag !== JSON.stringify(room.calendarPlans[planId] ?? null)) return 'changed';
      room.calendarPlans[planId] = JSON.parse(JSON.stringify(record));
      writes++;
      return 'written';
    },
  } });
  const fetchVia = async (url, init) => {
    const result = await h.handle({ method: init.method, path: new URL(url).pathname, rawHeaders: Object.entries(init.headers).flat(), rawBody: new TextEncoder().encode(init.body) });
    return new Response(result.payload, { status: result.status });
  };
  const expectedRevision = revision({ v: 1, store: 'calendar', targetKey: PLAN, item: room.calendarPlans[PLAN].items[0] });
  let attempts = 0;
  const deps = { nowSeconds, cryptoImpl: webcrypto, now: () => NOW_MS, fetchImpl: async (url, init) => {
    const response = await fetchVia(url, init);
    if (++attempts === 1) throw new DOMException('timed out after commit', 'TimeoutError');
    return response;
  } };
  const args = { ...TOOLS.plan_set_completion, expectedRevision };
  const first = (await message(await handleMcpRequest(call('plan_set_completion', args), env, deps, ctx([READ_SCOPE, PLAN_WRITE_SCOPE])))).result;
  assert.equal(first.structuredContent.outcome, 'unknown');
  const { retry } = first.structuredContent;
  const again = (await message(await handleMcpRequest(call('plan_set_completion', { actionId: retry.actionId, capturedAt: retry.capturedAt,
    expectedRevision: retry.expectedRevision, ...retry.parameters }), env, deps, ctx([READ_SCOPE, PLAN_WRITE_SCOPE])))).result;
  assert.equal(again.isError, undefined, JSON.stringify(again));
  assert.equal(again.structuredContent.result.idempotentReplay, true);
  assert.equal(again.structuredContent.result.item.completed, true);
  assert.equal(writes, 1, 'one effect');
  assert.equal(room.calendarPlans[PLAN].items[0].done, true);
});

test('TASK-036 end to end: a legacy account completes two of its three tasks; the third and the plan stay exactly as stored', async () => {
  const TODAY = localPlanDate(NOW_MS, ZONE);
  const task = (id, title, extra = {}) => ({ id, task: title, when: '', done: false, kind: 'task', updatedAt: 1, updatedBy: 'phone', ...extra });
  const preparation = { targetDate: TODAY, firstPreparedAt: 1, timezone: ZONE };
  // No calendarPlanAuthority: the account never cut over, so get_today routes to the legacy plan.
  const room = { settings: { timezone: ZONE },
    plans: { [TODAY]: { updatedAt: 1, updatedBy: 'phone', preparation,
      items: [task('p1', 'Post remaining products'), task('p2', 'Make price menu', { durationMinutes: 60 }), task('p3', 'Pay apartment kuryente')] } } };
  const third = structuredClone(room.plans[TODAY].items[2]);
  const h = harness({ domain: {
    async readRoomCollection(_identity, collection) { return structuredClone(room[collection] ?? null); },
    async readLegacyPlanWithEtag(_identity, dateKey) { const value = room.plans[dateKey] ?? null; return { value: structuredClone(value), etag: JSON.stringify(value) }; },
    async putLegacyPlanIfMatch(_identity, dateKey, record, etag) {
      if (etag !== JSON.stringify(room.plans[dateKey] ?? null)) return 'changed';
      room.plans[dateKey] = JSON.parse(JSON.stringify(record));
      return 'written';
    },
  } });
  const deps = { nowSeconds, cryptoImpl: webcrypto, now: () => NOW_MS, fetchImpl: async (url, init) => {
    const result = await h.handle({ method: init.method, path: new URL(url).pathname, rawHeaders: Object.entries(init.headers).flat(), rawBody: new TextEncoder().encode(init.body) });
    return new Response(result.payload, { status: result.status });
  } };
  const today = (await message(await handleMcpRequest(call('get_today', {}), env, deps, ctx([READ_SCOPE])))).result.structuredContent.result;
  assert.deepEqual({ store: today.plan.target.store, id: today.plan.target.id }, { store: 'legacy', id: TODAY });
  for (const [itemId, n] of [['p1', 1], ['p2', 2]]) {
    const item = today.plan.items.find(candidate => candidate.itemId === itemId);
    const args = { actionId: ACTION.replace('0b8f1c2e', `0b8f1c2${n}`), capturedAt: CAPTURED, expectedRevision: item.revision,
      target: { store: 'legacy', id: TODAY }, itemId, completed: true };
    const done = (await message(await handleMcpRequest(call('plan_set_completion', args), env, deps, ctx([READ_SCOPE, PLAN_WRITE_SCOPE])))).result;
    assert.equal(done.isError, undefined, JSON.stringify(done));
    assert.deepEqual(done.structuredContent.result.target, { store: 'legacy', id: TODAY, date: TODAY });
    assert.equal(done.structuredContent.result.item.completed, true);
  }
  const stored = room.plans[TODAY];
  assert.deepEqual(stored.items.map(item => [item.id, item.done]), [['p1', true], ['p2', true], ['p3', false]], 'same ids, same order');
  assert.deepEqual(stored.items[2], third, 'the remaining task is byte-identical');
  assert.deepEqual(stored.preparation, preparation, 'the plan preparation is kept as stored');
  assert.equal(stored.items[1].durationMinutes, 60);
});

test('TASK-038 end to end: a legacy account moves two of its three unfinished tasks to tomorrow, verifies, and undoes one', async () => {
  const TODAY = localPlanDate(NOW_MS, ZONE);
  const task = (id, title, extra = {}) => ({ id, task: title, when: '', done: false, kind: 'task', updatedAt: 1, updatedBy: 'phone', ...extra });
  const room = { settings: { timezone: ZONE },
    plans: { [TODAY]: { updatedAt: 1, updatedBy: 'phone', preparation: { targetDate: TODAY, firstPreparedAt: 1, timezone: ZONE },
      items: [task('p1', 'Post remaining products'), task('p2', 'Make price menu', { when: '14:00', durationMinutes: 60 }), task('p3', 'Pay apartment kuryente')] } } };
  const third = structuredClone(room.plans[TODAY].items[2]);
  let writes = 0;
  const h = harness({ domain: {
    async readRoomCollection(_identity, collection) { return structuredClone(room[collection] ?? null); },
    async readLegacyPlanWithEtag(_identity, dateKey) { const value = room.plans[dateKey] ?? null; return { value: structuredClone(value), etag: JSON.stringify(value) }; },
    async readLegacyPlansWithEtag() { return { value: structuredClone(room.plans), etag: JSON.stringify(room.plans) }; },
    async putLegacyPlansIfMatch(_identity, plans, etag) {
      if (etag !== JSON.stringify(room.plans)) return 'changed';
      room.plans = JSON.parse(JSON.stringify(plans));
      writes++;
      return 'written';
    },
  } });
  const deps = { nowSeconds, cryptoImpl: webcrypto, now: () => NOW_MS, fetchImpl: async (url, init) => {
    const result = await h.handle({ method: init.method, path: new URL(url).pathname, rawHeaders: Object.entries(init.headers).flat(), rawBody: new TextEncoder().encode(init.body) });
    return new Response(result.payload, { status: result.status });
  } };
  const tool = async (name, args, scope = [READ_SCOPE, PLAN_WRITE_SCOPE]) => (await message(await handleMcpRequest(call(name, args), env, deps, ctx(scope)))).result;
  const planOn = async date => (await tool('get_plan', { target: { store: 'legacy', id: date } }, [READ_SCOPE])).structuredContent.result.plan;
  const today = (await tool('get_today', {}, [READ_SCOPE])).structuredContent.result;
  const unfinished = today.plan.items.filter(item => !item.done);
  assert.deepEqual(unfinished.map(item => item.itemId), ['p1', 'p2', 'p3']);
  const TOMORROW_DAY = addCalendarDays(TODAY, 1);
  const moveArgs = (item, n, from, to) => ({ actionId: ACTION.replace('0b8f1c2e', `0b8f1c2${n}`), capturedAt: CAPTURED, expectedRevision: item.revision,
    target: { store: 'legacy', id: from }, itemId: item.itemId, destination: { store: 'legacy', id: to } });
  // The user approved exactly p1 and p2.
  for (const [n, itemId] of [[1, 'p1'], [2, 'p2']]) {
    const moved = await tool('plan_move', moveArgs(unfinished.find(item => item.itemId === itemId), n, TODAY, TOMORROW_DAY));
    assert.equal(moved.isError, undefined, JSON.stringify(moved));
    assert.deepEqual(moved.structuredContent.result.destination, { store: 'legacy', id: TOMORROW_DAY, date: TOMORROW_DAY });
  }
  assert.equal(writes, 2);
  assert.deepEqual((await planOn(TODAY)).items.map(item => item.itemId), ['p3'], 'verified: only the unselected task remains today');
  const tomorrow = await planOn(TOMORROW_DAY);
  assert.deepEqual(tomorrow.items.map(item => [item.itemId, item.task, item.when, item.durationMinutes]),
    [['p1', 'Post remaining products', null, null], ['p2', 'Make price menu', '14:00', 60]], 'verified: same tasks, metadata kept, no duplicates');
  assert.deepEqual(room.plans[TODAY].items[2], third, 'the unselected task is byte-identical');
  // A mixed pair and a legacy retime are definite refusals, not unknown outcomes; nothing is written.
  const p3 = (await planOn(TODAY)).items[0];
  for (const extra of [{ destination: { store: 'calendar', id: `cal1:${TOMORROW_DAY}` } }, { time: { when: '09:00', whenTz: ZONE } }]) {
    const refused = await tool('plan_move', { ...moveArgs(p3, 3, TODAY, TOMORROW_DAY), ...extra });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent, undefined, 'never a typed unknown');
    assert.match(refused.content[0].text, /^DOMAIN_LIMIT/);
  }
  assert.equal(writes, 2);
  // Undo one: move p2 back.
  const p2 = tomorrow.items.find(item => item.itemId === 'p2');
  const undone = await tool('plan_move', moveArgs(p2, 4, TOMORROW_DAY, TODAY));
  assert.equal(undone.isError, undefined, JSON.stringify(undone));
  assert.deepEqual((await planOn(TODAY)).items.map(item => item.itemId), ['p2', 'p3']);
  assert.deepEqual((await planOn(TOMORROW_DAY)).items.map(item => item.itemId), ['p1']);
});
