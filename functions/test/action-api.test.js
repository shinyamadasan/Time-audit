// functions/test/action-api.test.js — the whole pipeline: auth -> envelope -> identity -> scope -> nonce -> read.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '../src/errors.js';
import { NONCE_ROOT, RETENTION_MS } from '../src/nonce-store.js';
import { SERVICE_IDENTITY } from '../src/service-auth.js';
import { NOW_MS, OWNER, capture, harness, signedRequest } from './support.js';

const OWNER_ROOM = `uid_${OWNER.ownerFirebaseUid}`;
const rooms = {
  [OWNER_ROOM]: { brainDump: { bdc_owner1: capture('bdc_owner1') } },
  uid_victim: { brainDump: { bdc_victim: capture('bdc_victim', { text: 'VICTIM SECRET' }) } },
};

/** Proves a rejected request did nothing: no domain read, no nonce claimed. */
function assertUntouched(h) {
  assert.deepEqual(h.domain.reads, [], 'no domain read');
  assert.deepEqual(h.infra.calls, [], 'no nonce / infrastructure access');
}

test('valid trusted request: get_brain_dump returns the owner\'s typed captures with contract metadata', async () => {
  const h = harness({ rooms });
  const request = signedRequest();
  const response = await h.handle(request);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.contractVersion, 1);
  assert.equal(response.body.requestId, request.requestId);
  assert.equal(response.body.kind, 'get_brain_dump');
  assert.deepEqual(response.body.result.captures.map(c => c.captureId), ['bdc_owner1']);
  assert.equal(response.body.authority.access, 'user_scoped');
  assert.deepEqual(h.domain.reads, [{ roomId: OWNER_ROOM, collection: 'brainDump' }]);
  assert.deepEqual(h.infra.calls[0], ['createIfAbsent', `${NONCE_ROOT}/${SERVICE_IDENTITY}/${request.requestId}`]);
  const text = JSON.stringify(response.body);
  for (const leak of [OWNER.ownerFirebaseUid, OWNER_ROOM, 'rooms/', OWNER.ownerSubject, 'device-a']) assert.ok(!text.includes(leak), `response must not expose ${leak}`);
});

test('bad HMAC / stale timestamp: rejected before any read or nonce claim; no requestId is echoed', async () => {
  for (const request of [signedRequest({ key: Buffer.alloc(32, 9) }), signedRequest({ signed: { timestamp: Math.floor(NOW_MS / 1000) - 301 } })]) {
    const h = harness({ rooms });
    const response = await h.handle(request);
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTH_REQUIRED');
    assert.equal(response.body.requestId, null, 'an unauthenticated requestId is never echoed');
    assertUntouched(h);
  }
});

test('wrong owner subject (validly signed) is FORBIDDEN and reads nothing', async () => {
  const h = harness({ rooms });
  const response = await h.handle(signedRequest({ signed: { subject: 'access-sub-intruder' } }));
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
  assertUntouched(h);
});

test('missing or misconfigured owner mapping fails closed', async () => {
  for (const owner of [{}, { ownerSubject: OWNER.ownerSubject }, { ownerSubject: OWNER.ownerSubject, ownerFirebaseUid: '../uid_victim' }, { ownerSubject: '', ownerFirebaseUid: 'x' }]) {
    const h = harness({ rooms, owner });
    const response = await h.handle(signedRequest());
    assert.equal(response.body.error.code, 'FORBIDDEN', JSON.stringify(owner));
    assertUntouched(h);
  }
});

test('missing required scope chronasense:read is FORBIDDEN, even with every write scope', async () => {
  for (const scopes of [[], ['chronasense:brain-dump.write', 'chronasense:plan.write']]) {
    const h = harness({ rooms });
    const response = await h.handle(signedRequest({ signed: { scopes } }));
    assert.equal(response.status, 403);
    assert.deepEqual(response.body.error.details, { requiredScope: 'chronasense:read' });
    assertUntouched(h);
  }
});

test('duplicate nonce: the exact same signed request replayed is refused and does not read again', async () => {
  const h = harness({ rooms });
  const request = signedRequest();
  assert.equal((await h.handle(request)).status, 200);
  const replay = await h.handle(request);
  assert.equal(replay.status, 401);
  assert.equal(replay.reason, 'replayed-request-id');
  assert.equal(h.domain.reads.length, 1, 'the replay never reached the domain');
});

test('concurrent replay: N simultaneous copies of one request -> exactly one is served', async () => {
  const h = harness({ rooms });
  const request = signedRequest();
  const responses = await Promise.all(Array.from({ length: 25 }, () => h.handle(request)));
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal(responses.filter(r => r.reason === 'replayed-request-id').length, 24);
  assert.equal(h.domain.reads.length, 1);
});

test('nonce retention: a claim is stored with a bounded expiry that outlives the replay window', async () => {
  const h = harness({ rooms });
  const request = signedRequest();
  await h.handle(request);
  const claim = h.infra.data.get(`${NONCE_ROOT}/${SERVICE_IDENTITY}/${request.requestId}`);
  assert.deepEqual(claim, { v: 1, claimedAt: NOW_MS, expiresAt: NOW_MS + RETENTION_MS });
});

test('caller-supplied UID / room / path / subject / account cannot redirect access: every carrier is refused', async () => {
  const id = '6f1e2d3c-4b5a-4968-8776-655443322110';
  const bodies = [
    { contractVersion: 1, requestId: id, kind: 'get_brain_dump', parameters: { uid: 'victim' } },
    { contractVersion: 1, requestId: id, kind: 'get_brain_dump', parameters: { roomId: 'uid_victim' } },
    { contractVersion: 1, requestId: id, kind: 'get_brain_dump', parameters: { path: 'rooms/uid_victim/brainDump' } },
    { contractVersion: 1, requestId: id, kind: 'get_brain_dump', parameters: { account: 'victim' } },
    { contractVersion: 1, requestId: id, kind: 'get_brain_dump', parameters: {}, uid: 'victim' },
    { contractVersion: 1, requestId: id, kind: 'get_brain_dump', parameters: {}, subject: 'access-sub-owner-1' },
    { contractVersion: 1, requestId: id, kind: 'get_brain_dump', parameters: {}, scopes: ['chronasense:read'] },
  ];
  for (const envelope of bodies) {
    const h = harness({ rooms });
    const response = await h.handle(signedRequest({ requestId: id, envelope }));
    assert.equal(response.body.error?.code, 'INVALID_INPUT', JSON.stringify(envelope));
    assertUntouched(h);
  }
  // Extra non-chronasense headers are simply never read: the owner's room is still the only one touched.
  const h = harness({ rooms });
  const response = await h.handle(signedRequest({ mutate: hdrs => [...hdrs, 'X-Firebase-Uid', 'victim', 'X-Room', 'uid_victim', 'X-Forwarded-User', 'victim'] }));
  assert.equal(response.status, 200);
  assert.deepEqual(h.domain.reads, [{ roomId: OWNER_ROOM, collection: 'brainDump' }]);
  assert.ok(!JSON.stringify(response.body).includes('VICTIM'));
});

test('envelope: requestId must equal the signed one; contractVersion 1; unknown kinds and every command are refused', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const envelopes = [
    ['request-id-mismatch', { contractVersion: 1, requestId: '6f1e2d3c-4b5a-4968-8776-655443322110', kind: 'get_brain_dump', parameters: {} }],
    ['contract-version', { contractVersion: 2, requestId: id, kind: 'get_brain_dump', parameters: {} }],
    ['contract-version', { contractVersion: '1', requestId: id, kind: 'get_brain_dump', parameters: {} }],
    ['envelope-fields', { contractVersion: 1, requestId: id, kind: 'get_brain_dump' }],
    ['parameters-type', { contractVersion: 1, requestId: id, kind: 'get_brain_dump', parameters: [] }],
    ['parameters-type', { contractVersion: 1, requestId: id, kind: 'get_brain_dump', parameters: null }],
    ...['get_today', 'get_plan', 'get_item', 'brain_dump_add', 'brain_dump_triage', 'brain_dump_promote', 'brain_dump_disposition', 'plan_create', 'plan_update_same_target', 'plan_complete', 'actual_log', 'chronasense:get_brain_dump', '__proto__', 'constructor', 'toString']
      .map(kind => ['unsupported-kind', { contractVersion: 1, requestId: id, kind, parameters: {} }]),
    ['envelope-fields', { contractVersion: 1, actionId: 'act1_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'brain_dump_add', parameters: { text: 'x' }, expectedRevision: null, requestId: id }],
  ];
  for (const [reason, envelope] of envelopes) {
    const h = harness({ rooms });
    const response = await h.handle(signedRequest({ requestId: id, envelope }));
    assert.equal(response.body.error?.code, 'INVALID_INPUT', `${reason}: ${JSON.stringify(envelope)}`);
    assert.equal(response.reason, reason);
    assertUntouched(h);
  }
  // A duplicated key in the signed body is refused (the body has exactly one meaning).
  const h = harness({ rooms });
  const raw = Buffer.from(`{"contractVersion":1,"requestId":"${id}","kind":"get_brain_dump","kind":"get_today","parameters":{}}`, 'utf8');
  const response = await h.handle(signedRequest({ requestId: id, rawBody: raw }));
  assert.equal(response.reason, 'malformed-json');
  assertUntouched(h);
});

test('a read creates no action receipt and touches no infrastructure path other than its own nonce', async () => {
  const h = harness({ rooms });
  await h.handle(signedRequest());
  await new Promise(resolve => setImmediate(resolve));
  for (const [, path] of h.infra.calls) assert.ok(path.startsWith(`${NONCE_ROOT}/${SERVICE_IDENTITY}`), `unexpected infrastructure access ${path}`);
  assert.ok(![...h.infra.data.keys()].some(path => path.startsWith('serverActionReceipts')), 'no receipt written');
});

test('nonce store unknown outcome fails closed: no read, RETRYABLE_TRANSPORT', async () => {
  const h = harness({ rooms });
  h.infra.createIfAbsent = async () => { throw new ApiError('RETRYABLE_TRANSPORT', 'x', { reason: 'infra-network' }); };
  const response = await h.handle(signedRequest());
  assert.equal(response.body.error.code, 'RETRYABLE_TRANSPORT');
  assert.deepEqual(h.domain.reads, []);
});

test('expired nonces are swept opportunistically and a live one is never removed', async () => {
  const h = harness({ rooms });
  const live = '11111111-2222-4333-8444-555555555555';
  const old = '99999999-2222-4333-8444-555555555555';
  h.infra.data.set(`${NONCE_ROOT}/${SERVICE_IDENTITY}/${old}`, { v: 1, claimedAt: 0, expiresAt: NOW_MS - 1 });
  h.infra.data.set(`${NONCE_ROOT}/${SERVICE_IDENTITY}/${live}`, { v: 1, claimedAt: NOW_MS, expiresAt: NOW_MS });
  await h.handle(signedRequest());
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!h.infra.data.has(`${NONCE_ROOT}/${SERVICE_IDENTITY}/${old}`), 'expired claim swept');
  assert.ok(h.infra.data.has(`${NONCE_ROOT}/${SERVICE_IDENTITY}/${live}`), 'a claim expiring exactly now is kept');
});
