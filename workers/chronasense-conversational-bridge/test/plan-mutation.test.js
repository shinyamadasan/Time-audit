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
    ['plan_set_completion', { ...BASE, completed: true, target: { store: 'legacy', id: TOMORROW } }],
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
