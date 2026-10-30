// plan_create through the Worker (TASK-011): OAuth step-up to chronasense:plan.write, scope isolation from the
// read and Brain Dump grants, strict typed arguments (no path/UID/item id), one signed command with verified actor
// provenance, the typed unknown outcome that only allows the SAME action to retry, and definite refusals that stay
// definite. The backend is the real Action API pipeline (functions/src) over an in-memory owner room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, exportJWK, SignJWT } from 'jose';

import { handleMcpRequest, ISSUER, PLAN_WRITE_SCOPE, READ_SCOPE, RESOURCE, WRITE_SCOPE } from '../src/mcp.js';
import { handleDefaultRequest } from '../src/index.js';
import { actionActorRef } from '../../../functions/src/envelope.js';
import { addCalendarDays, localPlanDate } from '../../../functions/shared/plan-tomorrow-model.js';
import { harness, KEY, NOW_MS, OWNER } from '../../../functions/test/support.js';

const subject = OWNER.ownerSubject;
const env = { CHRONASENSE_OWNER_SUBJECT: subject, CHRONASENSE_ACTION_API_URL: 'https://example.test/v1/query',
  CHRONASENSE_WORKER_HMAC_KEY_ID: 'test-key-1', CHRONASENSE_WORKER_HMAC_KEY_HEX: KEY.toString('hex') };
const nowSeconds = Math.floor(NOW_MS / 1000);
const ZONE = 'Asia/Manila';
const TOMORROW = addCalendarDays(localPlanDate(NOW_MS, ZONE), 1);
const ACTION = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const ITEM_ID = `api1_${ACTION.slice(5)}`;
const ARGS = { actionId: ACTION, capturedAt: '2026-10-12T12:00:00.000Z', target: { store: 'calendar', id: `cal1:${TOMORROW}` },
  title: 'Gym', when: '18:00', whenTz: ZONE, durationMinutes: 60 };

const ctx = scope => ({
  auth: { token: 'fixture-token', audience: RESOURCE, expiresAt: nowSeconds + 300, scope, userId: subject },
  props: { ownerSubject: subject, resource: RESOURCE, issuer: ISSUER, notBefore: nowSeconds - 1 },
});
const call = (args = ARGS, name = 'plan_create') => new Request('https://localhost/mcp', { method: 'POST',
  headers: { Host: 'localhost', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
async function message(response) {
  const body = await response.text();
  const line = body.split(/\r?\n/).find(value => value.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : body);
}

/** The real backend over one owner room (calendar-activated in Manila). */
function backend() {
  const activatedAtMs = NOW_MS - 10 * 86_400_000;
  const room = { settings: { timezone: ZONE }, calendarPlanAuthority: { f1: { schemaVersion: 1, id: 'f1', activatedAtMs, timezone: ZONE,
    activationDate: localPlanDate(activatedAtMs, ZONE), deviceId: 'phone' } }, calendarPlanFences: {} };
  const writes = [];
  const h = harness({ domain: {
    async readRoomCollection(_identity, collection) { return structuredClone(room[collection] ?? null); },
    async readPlanItem(_identity, planId, itemId) { return structuredClone(room.calendarPlanFences[planId]?.[itemId] ?? null); },
    async readCalendarPlanWithEtag(_identity, planId) {
      const value = room.calendarPlans?.[planId] ?? null;
      return { value: structuredClone(value), etag: value ? JSON.stringify(value) : 'null_etag' };
    },
    async putCalendarPlanIfMatch(_identity, planId, record, etag) {
      const value = room.calendarPlans?.[planId] ?? null;
      if (etag !== (value ? JSON.stringify(value) : 'null_etag')) return 'changed';
      room.calendarPlans = { ...room.calendarPlans, [planId]: structuredClone(record) };
      return 'written';
    },
    async createPlanItemIfAbsent(_identity, planId, itemId, _actionId, record) {
      writes.push(itemId);
      room.calendarPlanFences[planId] ??= {};
      if (room.calendarPlanFences[planId][itemId]) return 'exists';
      room.calendarPlanFences[planId][itemId] = structuredClone(record);
      return 'created';
    },
  } });
  const fetchVia = async (url, init) => {
    const result = await h.handle({ method: init.method, path: new URL(url).pathname,
      rawHeaders: Object.entries(init.headers).flat(), rawBody: new TextEncoder().encode(init.body) });
    return new Response(result.payload, { status: result.status });
  };
  return { room, writes, fetchVia };
}

test('plan_create needs read + plan.write; read-only and Brain-Dump-only grants are challenged before the backend', async () => {
  let calls = 0;
  const deps = { nowSeconds, cryptoImpl: webcrypto, commandActionApi: async () => { calls++; throw new Error('must not be called'); } };
  for (const scope of [[READ_SCOPE], [READ_SCOPE, WRITE_SCOPE], [PLAN_WRITE_SCOPE], [READ_SCOPE, PLAN_WRITE_SCOPE, 'chronasense:admin'], [READ_SCOPE, PLAN_WRITE_SCOPE, PLAN_WRITE_SCOPE]]) {
    const answer = await message(await handleMcpRequest(call(), env, deps, ctx(scope)));
    assert.equal(answer.result.isError, true, JSON.stringify(scope));
    assert.match(JSON.stringify(answer), /insufficient_scope/);
    assert.match(JSON.stringify(answer), /chronasense:read chronasense:plan\.write/, 'the challenge asks for exactly the plan step-up');
  }
  // A plan-only grant does not unlock Brain Dump either.
  const bd = await message(await handleMcpRequest(call({ actionId: ACTION, capturedAt: ARGS.capturedAt, text: 'x' }, 'brain_dump_add'), env, deps, ctx([READ_SCOPE, PLAN_WRITE_SCOPE])));
  assert.match(JSON.stringify(bd), /insufficient_scope/);
  assert.equal(calls, 0);
});

test('plan_create sends ONE structured command: only the plan scope, verified actor provenance, no transport fields in parameters', async () => {
  const calls = [];
  const deps = { nowSeconds, cryptoImpl: webcrypto, commandActionApi: async (_env, input) => {
    calls.push(input);
    return { contractVersion: 1, requestId: 'fixture', kind: 'plan_create',
      result: { actionId: ACTION, itemId: ITEM_ID, target: { store: 'calendar', id: ARGS.target.id, date: TOMORROW },
        schedule: { when: '18:00', whenDayOffset: 0, whenTz: ZONE, durationMinutes: 60, startAt: 'x', endAt: 'y' },
        createdAt: 'z', revision: 'rev1:x', idempotentReplay: false },
      authority: { authority: 'plan_authority', access: 'user_scoped', readAt: 'z' } };
  } };
  const answer = await message(await handleMcpRequest(call(), env, deps, ctx([READ_SCOPE, WRITE_SCOPE, PLAN_WRITE_SCOPE])));
  assert.equal(answer.result.isError, undefined, JSON.stringify(answer));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].scopes, [PLAN_WRITE_SCOPE], 'never forwards the broader grant');
  const { command } = calls[0];
  assert.equal(command.kind, 'plan_create');
  assert.equal(command.actionId, ACTION);
  assert.deepEqual(command.parameters, { target: ARGS.target, title: 'Gym', when: '18:00', whenTz: ZONE, durationMinutes: 60 });
  assert.equal(command.actionProvenance.actorRef, actionActorRef(subject));
  assert.equal(command.actionProvenance.capturedAt, ARGS.capturedAt);
});

test('forged or untyped plan_create arguments never reach the backend', async () => {
  let calls = 0;
  const deps = { nowSeconds, cryptoImpl: webcrypto, commandActionApi: async () => { calls++; return {}; } };
  const forged = [
    { ...ARGS, path: 'rooms/uid_victim/calendarPlans' }, { ...ARGS, uid: 'victim' }, { ...ARGS, itemId: 'api1_x' }, { ...ARGS, creationActionId: ACTION },
    { ...ARGS, target: { ...ARGS.target, roomId: 'uid_victim' } }, { ...ARGS, actionId: 'act1_not-a-uuid' }, { ...ARGS, title: '' }, { ...ARGS, title: 'x'.repeat(201) },
    { ...ARGS, when: '6pm' }, { ...ARGS, whenDayOffset: 2 }, { ...ARGS, durationMinutes: 0 }, { ...ARGS, capturedAt: 'yesterday' },
  ];
  for (const args of forged) {
    const answer = await message(await handleMcpRequest(call(args), env, deps, ctx([READ_SCOPE, PLAN_WRITE_SCOPE])));
    assert.ok(answer.error || answer.result?.isError, JSON.stringify(args));
  }
  assert.equal(calls, 0);
});

test('timeout after commit is a typed unknown naming the SAME action and parameters; that retry replays one item', async () => {
  const { room, writes, fetchVia } = backend();
  let attempts = 0;
  const deps = { nowSeconds, cryptoImpl: webcrypto, now: () => NOW_MS, fetchImpl: async (url, init) => {
    const response = await fetchVia(url, init);
    if (++attempts === 1) throw new DOMException('timed out after commit', 'TimeoutError');
    return response;
  } };
  const context = ctx([READ_SCOPE, PLAN_WRITE_SCOPE]);
  const first = (await message(await handleMcpRequest(call(), env, deps, context))).result;
  assert.equal(first.isError, true);
  assert.deepEqual(first.structuredContent, { outcome: 'unknown', code: 'PENDING_UNKNOWN', mayHaveCommitted: true,
    retry: { actionId: ACTION, capturedAt: ARGS.capturedAt, parameters: { target: ARGS.target, title: 'Gym', when: '18:00', whenTz: ZONE, durationMinutes: 60 }, newActionIdAllowed: false } });
  assert.match(first.content[0].text, /plan task may already exist/);
  assert.doesNotMatch(JSON.stringify(first), /(?:use|try|mint|create) a new actionId/i);
  const retry = (await message(await handleMcpRequest(call(), env, deps, context))).result;
  assert.equal(retry.isError, undefined, JSON.stringify(retry));
  assert.equal(retry.structuredContent.result.idempotentReplay, true);
  assert.equal(retry.structuredContent.result.itemId, ITEM_ID);
  assert.equal(writes.length, 1);
  assert.equal(Object.keys(room.calendarPlanFences[ARGS.target.id]).length, 1);
});

test('definite backend refusals stay definite (no unknown, no retry hint); a changed payload is IDEMPOTENCY_CONFLICT', async () => {
  const { writes, fetchVia } = backend();
  const deps = { nowSeconds, cryptoImpl: webcrypto, now: () => NOW_MS, fetchImpl: fetchVia };
  const context = ctx([READ_SCOPE, PLAN_WRITE_SCOPE]);
  const refusals = [
    [{ ...ARGS, target: { store: 'calendar', id: `cal1:${addCalendarDays(TOMORROW, -2)}` } }, 'PAST_TARGET_IMMUTABLE'],
    [{ ...ARGS, actionId: 'act1_1c9a2d3e-4f5a-4b6c-9d7e-8f9012a3b4c5', target: { store: 'calendar', id: 'cal1:2026-03-08' }, when: '02:30', whenTz: 'America/New_York' }, 'NONEXISTENT_TIME'],
    [{ ...ARGS, actionId: 'act1_2d0b3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', target: { store: 'legacy', id: TOMORROW } }, 'DOMAIN_LIMIT'],
  ];
  for (const [args, code] of refusals) {
    const result = (await message(await handleMcpRequest(call(args), env, deps, context))).result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined, code);
    assert.match(result.content[0].text, new RegExp(`^${code}:`));
  }
  const first = (await message(await handleMcpRequest(call({ ...ARGS, actionId: 'act1_3e1c4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60' }), env, deps, context))).result;
  assert.equal(first.isError, undefined, JSON.stringify(first));
  const changed = (await message(await handleMcpRequest(call({ ...ARGS, actionId: 'act1_3e1c4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60', when: '07:00' }), env, deps, context))).result;
  assert.match(changed.content[0].text, /^IDEMPOTENCY_CONFLICT:/);
  assert.equal(writes.length, 1);
});

test('OAuth consent names the plan scope and grants exactly what was requested', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256' };
  const NOW = 1_800_000_000;
  const accessEnv = { ACCESS_TEAM_DOMAIN: 'https://fixture.cloudflareaccess.com', ACCESS_POLICY_AUD: 'aud', CHRONASENSE_OWNER_SUBJECT: 'owner-sub' };
  const assertion = await new SignJWT({ type: 'app', sub: 'owner-sub', iss: accessEnv.ACCESS_TEAM_DOMAIN, aud: ['aud'], nbf: NOW - 5, exp: NOW + 300 })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' }).sign(privateKey);
  const deps = { jwks: createLocalJWKSet({ keys: [jwk] }), currentDate: new Date(NOW * 1000) };
  for (const [scopes, heading] of [[[READ_SCOPE, PLAN_WRITE_SCOPE], /Allow adding and changing tasks in your ChronaSense plan\?/],
    [[READ_SCOPE, WRITE_SCOPE, PLAN_WRITE_SCOPE], /Allow Brain Dump capture and plan task changes\?/]]) {
    let completed;
    const oauth = {
      parseAuthRequest: async () => ({ scope: scopes, resource: RESOURCE }),
      describeConsent: async () => ({ clientName: 'Fixture', redirectHost: 'chatgpt.com' }),
      beginConsent: async () => ({ handle: 'opaque', headers: new Headers() }),
      approveConsent: async () => ({ request: { scope: scopes, resource: RESOURCE }, headers: new Headers() }),
      listUserGrants: async () => ({ items: [] }),
      completeAuthorization: async value => { completed = value; return { redirectTo: 'https://client.test/cb' }; },
    };
    const headers = { 'Cf-Access-Jwt-Assertion': assertion };
    const page = await handleDefaultRequest(new Request(`${ISSUER}/authorize?resource=${encodeURIComponent(RESOURCE)}`, { headers }), { ...accessEnv, OAUTH_PROVIDER: oauth }, deps);
    const html = await page.text();
    assert.match(html, heading);
    assert.match(html, /one existing task named by its id and the revision last read\. It cannot touch Brain Dump, settings, timers or time entries/);
    const approved = await handleDefaultRequest(new Request(`${ISSUER}/authorize`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'handle=opaque&decision=approve' }), { ...accessEnv, OAUTH_PROVIDER: oauth }, deps);
    assert.equal(approved.status, 302);
    assert.deepEqual(completed.scope, [...scopes].sort());
  }
});
