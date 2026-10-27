// functions/test/user-scoped-rtdb.test.js — domain reads use ONLY the owner's exchanged ID token; no fallback.

import test from 'node:test';
import assert from 'node:assert/strict';

import { AuthorityBoundaryViolation } from '../src/errors.js';
import { createIdTokenProvider, createUserScopedRtdb, MAX_SOURCE_BODY_BYTES } from '../src/user-scoped-rtdb.js';

const UID = 'ownerUid123';
const IDENTITY = Object.freeze({ firebaseUid: UID, roomId: `uid_${UID}` });
const jwt = claims => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

function authAdmin({ user = { uid: UID }, getUserError, createError } = {}) {
  const calls = [];
  return {
    calls,
    async getUser(uid) { calls.push(['getUser', uid]); if (getUserError) throw getUserError; return user; },
    async createCustomToken(uid, claims) { calls.push(claims === undefined ? ['createCustomToken', uid] : ['createCustomToken', uid, claims]); if (createError) throw createError; return `custom-token-for-${uid}`; },
  };
}

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url: String(url), init }); return respond(String(url), init); };
  fn.calls = calls;
  return fn;
}
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('token exchange: validates the configured UID, mints its custom token, returns an ID token naming exactly that UID', async () => {
  const admin = authAdmin();
  const fetch = recordingFetch(() => json(200, { idToken: jwt({ user_id: UID, sub: UID }), refreshToken: 'REFRESH-SHOULD-BE-DROPPED', expiresIn: '3600' }));
  const provider = createIdTokenProvider({ authAdmin: admin, webApiKey: 'web-key', fetch });
  const token = await provider.getIdToken(UID);
  assert.equal(token, jwt({ user_id: UID, sub: UID }));
  assert.deepEqual(admin.calls, [['getUser', UID], ['createCustomToken', UID]]);
  assert.match(fetch.calls[0].url, /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:signInWithCustomToken\?key=web-key$/);
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { token: `custom-token-for-${UID}`, returnSecureToken: true });
  assert.ok(!JSON.stringify(provider).includes('REFRESH'), 'the refresh token is not retained');
});

test('token exchange fails closed: missing/disabled account, an ID token for another UID, a rejected exchange', async () => {
  const ok = () => json(200, { idToken: jwt({ user_id: UID }) });
  const cases = [
    [{ getUserError: Object.assign(new Error('x'), { code: 'auth/user-not-found' }) }, ok, 'FORBIDDEN'],
    [{ user: { uid: UID, disabled: true } }, ok, 'FORBIDDEN'],
    [{}, () => json(200, { idToken: jwt({ user_id: 'someoneElse' }) }), 'FORBIDDEN'],
    [{}, () => json(200, { idToken: 'not-a-jwt' }), 'FORBIDDEN'],
    [{}, () => json(400, { error: { message: 'INVALID_CUSTOM_TOKEN' } }), 'FORBIDDEN'],
    [{ getUserError: new Error('network') }, ok, 'RETRYABLE_TRANSPORT'],
    [{ createError: new Error('iam') }, ok, 'RETRYABLE_TRANSPORT'],
    [{}, () => json(503, {}), 'RETRYABLE_TRANSPORT'],
    [{}, () => { throw new Error('timeout'); }, 'RETRYABLE_TRANSPORT'],
  ];
  for (const [adminOptions, respond, code] of cases) {
    const provider = createIdTokenProvider({ authAdmin: authAdmin(adminOptions), webApiKey: 'k', fetch: recordingFetch(respond) });
    await assert.rejects(provider.getIdToken(UID), error => error.code === code, JSON.stringify(adminOptions));
  }
  await assert.rejects(createIdTokenProvider({ authAdmin: authAdmin(), webApiKey: 'k' }).getIdToken('../x'), error => error.code === 'FORBIDDEN');
});

test('create token binds the exact action claim; an exchanged token missing that claim is refused', async () => {
  const actionId = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const admin = authAdmin();
  const provider = createIdTokenProvider({ authAdmin: admin, webApiKey: 'k',
    fetch: recordingFetch(() => json(200, { idToken: jwt({ user_id: UID, chronasenseActionId: actionId }) })) });
  await provider.getIdToken(UID, actionId);
  assert.deepEqual(admin.calls[1], ['createCustomToken', UID, { chronasenseActionId: actionId }]);
  const missing = createIdTokenProvider({ authAdmin: admin, webApiKey: 'k',
    fetch: recordingFetch(() => json(200, { idToken: jwt({ user_id: UID }) })) });
  await assert.rejects(missing.getIdToken(UID, actionId), error => error.code === 'FORBIDDEN');
  await assert.rejects(provider.getIdToken(UID, 'act1_bad'), error => error.code === 'FORBIDDEN');
});

test('plan create token (TASK-011) binds action, kind AND target; an exchanged token missing or altering any claim is refused', async () => {
  const actionId = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const target = 'cal1:2026-10-13';
  const claims = { chronasenseActionId: actionId, chronasenseActionKind: 'plan_create', chronasenseActionTarget: target };
  const admin = authAdmin();
  const provider = createIdTokenProvider({ authAdmin: admin, webApiKey: 'k', fetch: recordingFetch(() => json(200, { idToken: jwt({ user_id: UID, ...claims }) })) });
  await provider.getIdToken(UID, actionId, { target });
  assert.deepEqual(admin.calls[1], ['createCustomToken', UID, claims]);
  for (const echoed of [{ chronasenseActionId: actionId }, { ...claims, chronasenseActionTarget: 'cal1:2026-10-14' }, { ...claims, chronasenseActionKind: 'brain_dump_add' }]) {
    const wrong = createIdTokenProvider({ authAdmin: authAdmin(), webApiKey: 'k', fetch: recordingFetch(() => json(200, { idToken: jwt({ user_id: UID, ...echoed }) })) });
    await assert.rejects(wrong.getIdToken(UID, actionId, { target }), error => error.code === 'FORBIDDEN', JSON.stringify(echoed));
  }
  for (const [badAction, badPlan] of [[undefined, { target }], [actionId, { target: '2026-10-13' }], [actionId, { target: 'cal1:2026-10-13/../x' }], [actionId, null]]) {
    await assert.rejects(provider.getIdToken(UID, badAction, badPlan), error => error.code === 'FORBIDDEN');
  }
  // TASK-010's Brain Dump token is byte-for-byte what it was: one claim, no kind, no target.
  const bd = authAdmin();
  await createIdTokenProvider({ authAdmin: bd, webApiKey: 'k', fetch: recordingFetch(() => json(200, { idToken: jwt({ user_id: UID, chronasenseActionId: actionId }) })) }).getIdToken(UID, actionId);
  assert.deepEqual(bd.calls[1], ['createCustomToken', UID, { chronasenseActionId: actionId }]);
});

test('plan item create/read are pinned to rooms/uid_<uid>/calendarPlanFences/<cal1 plan>/<api1 item> and nothing else', async () => {
  const actionId = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const itemId = `api1_${actionId.slice(5)}`;
  const planId = 'cal1:2026-10-13';
  const record = { id: itemId, task: 'Gym', creationActionId: actionId };
  const calls = [];
  const tokenCalls = [];
  const fetch = recordingFetch((url, init) => { calls.push([url, init]); return json(200, init.method === 'PUT' ? {} : record); });
  const rtdb = createUserScopedRtdb({ databaseUrl: 'https://x.firebaseio.com', fetch,
    idTokens: { getIdToken: async (...args) => { tokenCalls.push(args); return 'scoped-token'; } } });
  assert.equal(await rtdb.createPlanItemIfAbsent(IDENTITY, planId, itemId, actionId, record), 'created');
  assert.equal(new URL(calls[0][0]).pathname, `/rooms/uid_${UID}/calendarPlanFences/${planId}/${itemId}.json`);
  assert.equal(calls[0][1].method, 'PUT');
  assert.equal(calls[0][1].headers['if-match'], 'null_etag');
  assert.deepEqual(tokenCalls[0], [UID, actionId, { target: planId }], 'the create token names this action and this plan');
  assert.deepEqual(await rtdb.readPlanItem(IDENTITY, planId, itemId), record);
  assert.deepEqual(tokenCalls[1], [UID], 'the read uses the ordinary owner token');
  const violations = [
    [IDENTITY, planId, `api1_${'0'.repeat(36)}`, actionId, record],
    [IDENTITY, planId, itemId, 'act1_1c9a2d3e-4f5a-4b6c-9d7e-8f9012a3b4c5', record],
    [IDENTITY, planId, itemId, actionId, { ...record, creationActionId: undefined }],
    [IDENTITY, planId, itemId, actionId, { ...record, id: 'other' }],
    [IDENTITY, '2026-10-13', itemId, actionId, record],
    [IDENTITY, 'cal1:2026-10-13/../../settings', itemId, actionId, record],
    [{ firebaseUid: UID, roomId: 'uid_someoneElse' }, planId, itemId, actionId, record],
  ];
  for (const args of violations) await assert.rejects(rtdb.createPlanItemIfAbsent(...args), AuthorityBoundaryViolation, JSON.stringify(args.slice(1, 3)));
  await assert.rejects(rtdb.readPlanItem(IDENTITY, planId, '../x'), AuthorityBoundaryViolation);
  const statuses = [[412, 'exists'], [403, 'FORBIDDEN'], [401, 'FORBIDDEN'], [500, 'RETRYABLE_TRANSPORT']];
  for (const [status, expected] of statuses) {
    const answer = createUserScopedRtdb({ databaseUrl: 'https://x.firebaseio.com', fetch: async () => json(status, {}), idTokens: { getIdToken: async () => 't' } });
    const outcome = await answer.createPlanItemIfAbsent(IDENTITY, planId, itemId, actionId, record).catch(error => error.code);
    assert.equal(outcome, expected, String(status));
  }
});

test('capture create is a user-scoped conditional PUT at one deterministic Brain Dump child', async () => {
  const actionId = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const captureId = `bdc1_${actionId.slice(5)}`;
  const calls = [];
  const fetch = recordingFetch((url, init) => { calls.push([url, init]); return json(init.method === 'PUT' ? 200 : 200,
    init.method === 'PUT' ? {} : { id: captureId, creationActionId: actionId }); });
  const rtdb = createUserScopedRtdb({ databaseUrl: 'https://x.firebaseio.com', fetch,
    idTokens: { getIdToken: async (uid, claimedActionId) => {
      assert.equal(uid, UID);
      if (claimedActionId) assert.equal(claimedActionId, actionId);
      return 'user-id-token';
    } } });
  assert.equal(await rtdb.createCaptureIfAbsent(IDENTITY, captureId, actionId, { id: captureId, creationActionId: actionId }), 'created');
  assert.equal(calls[0][1].headers['if-match'], 'null_etag');
  assert.equal(new URL(calls[0][0]).searchParams.get('auth'), 'user-id-token');
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.equal((await rtdb.readCapture(IDENTITY, captureId)).creationActionId, actionId);
  await assert.rejects(rtdb.createCaptureIfAbsent(IDENTITY, '../other', actionId, { id: '../other', creationActionId: actionId }), AuthorityBoundaryViolation);
});

test('domain read: rooms/uid_<uid>/brainDump with ?auth=<ID token>; never an Authorization header; refresh token never used', async () => {
  const fetch = recordingFetch(() => json(200, { a: 1 }));
  const rtdb = createUserScopedRtdb({ databaseUrl: 'https://demo-default-rtdb.asia-southeast1.firebasedatabase.app', fetch, idTokens: { getIdToken: async uid => `idtoken-${uid}` } });
  assert.deepEqual(await rtdb.readRoomCollection(IDENTITY, 'brainDump'), { a: 1 });
  const url = new URL(fetch.calls[0].url);
  assert.equal(url.pathname, `/rooms/uid_${UID}/brainDump.json`);
  assert.equal(url.searchParams.get('auth'), `idtoken-${UID}`);
  assert.equal(fetch.calls[0].init.method, 'GET');
  assert.equal(fetch.calls[0].init.headers, undefined, 'no Authorization (Admin) header on a domain read');
});

test('cross-account access is denied: rules refusing the token -> FORBIDDEN; the room comes only from the bound UID', async () => {
  const denied = createUserScopedRtdb({ databaseUrl: 'https://x.firebaseio.com', fetch: recordingFetch(() => json(401, { error: 'Permission denied' })), idTokens: { getIdToken: async () => 't' } });
  await assert.rejects(denied.readRoomCollection(IDENTITY, 'brainDump'), error => error.code === 'FORBIDDEN');
  const rtdb = createUserScopedRtdb({ databaseUrl: 'https://x.firebaseio.com', fetch: recordingFetch(() => json(200, null)), idTokens: { getIdToken: async () => 't' } });
  for (const forged of [{ firebaseUid: UID, roomId: 'uid_victim' }, { firebaseUid: 'victim/../x', roomId: 'uid_victim/../x' }, { firebaseUid: UID }, null]) {
    await assert.rejects(rtdb.readRoomCollection(forged, 'brainDump'), AuthorityBoundaryViolation, JSON.stringify(forged));
  }
  for (const collection of ['users', 'rooms', '', '../uid_victim/brainDump', 'brainDump/x']) {
    await assert.rejects(rtdb.readRoomCollection(IDENTITY, collection), AuthorityBoundaryViolation, collection);
  }
});

test('no silent Admin fallback: when the ID token cannot be obtained the read fails and nothing else is called', async () => {
  const fetch = recordingFetch(() => json(200, { leaked: true }));
  const rtdb = createUserScopedRtdb({ databaseUrl: 'https://x.firebaseio.com', fetch, idTokens: { getIdToken: async () => { throw Object.assign(new Error('no token'), { code: 'FORBIDDEN' }); } } });
  await assert.rejects(rtdb.readRoomCollection(IDENTITY, 'brainDump'));
  assert.equal(fetch.calls.length, 0, 'no unauthenticated or privileged request was attempted');
  assert.throws(() => createUserScopedRtdb({ databaseUrl: 'https://x.firebaseio.com', fetch }), /ID-token provider/);
});

test('unknown outcomes are RETRYABLE_TRANSPORT, never absent: network failure, 5xx, unreadable body', async () => {
  for (const respond of [() => { throw new Error('reset'); }, () => json(500, {}), () => new Response('not json{', { status: 200 })]) {
    const rtdb = createUserScopedRtdb({ databaseUrl: 'https://x.firebaseio.com', fetch: recordingFetch(respond), idTokens: { getIdToken: async () => 't' } });
    await assert.rejects(rtdb.readRoomCollection(IDENTITY, 'brainDump'), error => error.code === 'RETRYABLE_TRANSPORT');
  }
});

test('domain source bytes have an inclusive bound independent of the serialized output limit', async () => {
  const read = (body, headers = {}) => createUserScopedRtdb({ databaseUrl: 'https://x.firebaseio.com',
    fetch: recordingFetch(() => new Response(body, { status: 200, headers })),
    idTokens: { getIdToken: async () => 't' } }).readRoomCollection(IDENTITY, 'brainDump');
  const exact = JSON.stringify({ value: 'x'.repeat(MAX_SOURCE_BODY_BYTES - 12) });
  assert.equal(Buffer.byteLength(exact), MAX_SOURCE_BODY_BYTES);
  assert.equal((await read(exact)).value.length, MAX_SOURCE_BODY_BYTES - 12);
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    await assert.rejects(read(exact + ' ', headers), error => error.code === 'DOMAIN_LIMIT'
      && error.reason === 'source-too-large' && error.details.limitBytes === MAX_SOURCE_BODY_BYTES);
  }
  const unicode = JSON.stringify({ value: '😀'.repeat(Math.floor((MAX_SOURCE_BODY_BYTES - 12) / 4)) });
  assert.ok(unicode.length < MAX_SOURCE_BODY_BYTES);
  await assert.rejects(read(unicode + ' '.repeat(MAX_SOURCE_BODY_BYTES - Buffer.byteLength(unicode) + 1)),
    error => error.code === 'DOMAIN_LIMIT');
  assert.deepEqual(await read(JSON.stringify({ value: '😀' })), { value: '😀' });
});

// ── N2 (TASK-011 follow-up) + TASK-012: every owner-token plan primitive is pinned to the bound UID, an exact plan /
// item / collection key and an ETag, and uses the ORDINARY owner token (never an action claim). ──────────────────
function ownerPrimitives({ status = 200, body = {}, etag = '"e1"' } = {}) {
  const calls = [];
  const tokenCalls = [];
  const fetch = async (url, init) => { calls.push([String(url), init]); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(etag ? { ETag: etag } : {}) } }); };
  const rtdb = createUserScopedRtdb({ databaseUrl: 'https://x.firebaseio.com', fetch, idTokens: { getIdToken: async (...args) => { tokenCalls.push(args); return 'owner-token'; } } });
  return { rtdb, calls, tokenCalls };
}

test('N2: plan record read/CAS is pinned to rooms/uid_<uid>/calendarPlans/<cal1 plan>, needs an ETag, and uses the owner token', async () => {
  const planId = 'cal1:2026-10-13';
  const { rtdb, calls, tokenCalls } = ownerPrimitives({ body: { items: [] } });
  assert.deepEqual(await rtdb.readCalendarPlanWithEtag(IDENTITY, planId), { value: { items: [] }, etag: '"e1"' });
  assert.equal(new URL(calls[0][0]).pathname, `/rooms/uid_${UID}/calendarPlans/${planId}.json`);
  assert.equal(calls[0][1].headers['X-Firebase-ETag'], 'true');
  assert.equal(await rtdb.putCalendarPlanIfMatch(IDENTITY, planId, { items: [] }, '"e1"'), 'written');
  assert.equal(calls[1][1].method, 'PUT');
  assert.equal(calls[1][1].headers['if-match'], '"e1"');
  assert.deepEqual(tokenCalls, [[UID], [UID]], 'never an action-claimed token for a plan record');
  for (const bad of ['2026-10-13', 'cal1:2026-13-01', 'cal1:2026-10-13/items', '../settings', 'cal1:2026-10-13 ']) {
    await assert.rejects(rtdb.readCalendarPlanWithEtag(IDENTITY, bad), AuthorityBoundaryViolation, bad);
    await assert.rejects(rtdb.putCalendarPlanIfMatch(IDENTITY, bad, { items: [] }, '"e1"'), AuthorityBoundaryViolation, bad);
  }
  for (const identity of [{ firebaseUid: UID, roomId: 'uid_other' }, { firebaseUid: '../x', roomId: 'uid_../x' }]) {
    await assert.rejects(rtdb.readCalendarPlanWithEtag(identity, planId), AuthorityBoundaryViolation);
  }
  for (const [record, tag] of [[{ items: [] }, undefined], [{ items: [] }, ''], [null, '"e1"'], [[], '"e1"']]) {
    await assert.rejects(rtdb.putCalendarPlanIfMatch(IDENTITY, planId, record, tag), AuthorityBoundaryViolation);
  }
  const missingEtag = ownerPrimitives({ etag: null });
  await assert.rejects(missingEtag.rtdb.readCalendarPlanWithEtag(IDENTITY, planId), error => error.code === 'RETRYABLE_TRANSPORT', 'no ETag, no CAS');
  for (const [status, expected] of [[412, 'changed'], [403, 'FORBIDDEN'], [503, 'RETRYABLE_TRANSPORT']]) {
    const outcome = await ownerPrimitives({ status }).rtdb.putCalendarPlanIfMatch(IDENTITY, planId, { items: [] }, '"e1"').catch(error => error.code);
    assert.equal(outcome, expected, String(status));
  }
});

test('TASK-012: fence-item CAS is pinned to an EXISTING api1_/bdp1| child of one calendar plan; never a create, never another key', async () => {
  const planId = 'cal1:2026-10-13';
  const apiId = 'api1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const bdId = 'bdp1|cap_01';
  const { rtdb, calls, tokenCalls } = ownerPrimitives({ body: { id: apiId } });
  await rtdb.readPlanFenceItemWithEtag(IDENTITY, planId, apiId);
  assert.equal(new URL(calls[0][0]).pathname, `/rooms/uid_${UID}/calendarPlanFences/${planId}/${apiId}.json`);
  await rtdb.readPlanFenceItemWithEtag(IDENTITY, planId, bdId);
  assert.equal(new URL(calls[1][0]).pathname, `/rooms/uid_${UID}/calendarPlanFences/${planId}/bdp1%7Ccap_01.json`, 'the | is encoded, never a path separator');
  assert.equal(await rtdb.putPlanFenceItemIfMatch(IDENTITY, planId, apiId, { id: apiId, task: 'x' }, '"e1"'), 'written');
  assert.equal(calls[2][1].headers['if-match'], '"e1"');
  assert.deepEqual(tokenCalls, [[UID], [UID], [UID]], 'the ordinary owner token');
  for (const bad of ['pgym1', 'api1_bad', 'bdp1|', 'bdp1|a/b', '../x', `${apiId}/task`]) {
    await assert.rejects(rtdb.readPlanFenceItemWithEtag(IDENTITY, planId, bad), AuthorityBoundaryViolation, bad);
  }
  await assert.rejects(rtdb.readPlanFenceItemWithEtag(IDENTITY, '2026-10-13', apiId), AuthorityBoundaryViolation);
  for (const [record, tag] of [[{ id: apiId }, 'null_etag'], [{ id: apiId }, undefined], [{ id: 'other' }, '"e1"'], [null, '"e1"']]) {
    await assert.rejects(rtdb.putPlanFenceItemIfMatch(IDENTITY, planId, apiId, record, tag), AuthorityBoundaryViolation, JSON.stringify([record, tag]));
  }
});

test('TASK-012: the move collection CAS is pinned to rooms/uid_<uid>/calendarPlans, calendar keys only, existing collection only', async () => {
  const { rtdb, calls, tokenCalls } = ownerPrimitives({ body: {} });
  await rtdb.readCalendarPlansWithEtag(IDENTITY);
  assert.equal(new URL(calls[0][0]).pathname, `/rooms/uid_${UID}/calendarPlans.json`);
  assert.equal(await rtdb.putCalendarPlansIfMatch(IDENTITY, { 'cal1:2026-10-13': { items: [] } }, '"e1"'), 'written');
  assert.equal(calls[1][1].headers['if-match'], '"e1"');
  assert.deepEqual(tokenCalls, [[UID], [UID]]);
  for (const [plans, tag] of [[{ 'cal1:2026-10-13': {} }, 'null_etag'], [{ 'cal1:2026-10-13': {} }, ''], [{ settings: {} }, '"e1"'],
    [{ '2026-10-13': {} }, '"e1"'], [[], '"e1"'], [null, '"e1"']]) {
    await assert.rejects(rtdb.putCalendarPlansIfMatch(IDENTITY, plans, tag), AuthorityBoundaryViolation, JSON.stringify(plans));
  }
  await assert.rejects(rtdb.readCalendarPlansWithEtag({ firebaseUid: UID, roomId: 'uid_x' }), AuthorityBoundaryViolation);
});

test('TASK-012 api1_ move: ONE PATCH of exactly the two item paths under calendarPlanFences, with a token binding every move claim', async () => {
  const actionId = 'act1_2d0b3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const creator = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const itemId = `api1_${creator.slice(5)}`;
  const reloc = { schemaVersion: 1, sequence: 1, fromDayId: 'cal1:2026-10-21', toDayId: 'cal1:2026-10-23', updatedBy: actionId, updatedAt: 5 };
  const tombstone = { id: itemId, task: 'Gym', creationActionId: creator, deleted: true, movedToDayId: 'cal1:2026-10-23', relocationRevision: reloc };
  const moved = { id: itemId, task: 'Gym', creationActionId: creator, relocationRevision: reloc };
  const move = { actionId, sourcePlanId: 'cal1:2026-10-21', destinationPlanId: 'cal1:2026-10-23', itemId, tombstone, moved };
  const { rtdb, calls, tokenCalls } = ownerPrimitives();
  assert.equal(await rtdb.relocateActionPlanItem(IDENTITY, move), 'written');
  assert.equal(new URL(calls[0][0]).pathname, `/rooms/uid_${UID}/calendarPlanFences.json`);
  assert.equal(calls[0][1].method, 'PATCH');
  assert.deepEqual(Object.keys(JSON.parse(calls[0][1].body)).sort(), [`cal1:2026-10-21/${itemId}`, `cal1:2026-10-23/${itemId}`]);
  assert.deepEqual(tokenCalls[0], [UID, actionId, { kind: 'plan_move', target: 'cal1:2026-10-23', source: 'cal1:2026-10-21', item: itemId }]);
  const bad = [
    { ...move, itemId: 'pgym1' }, { ...move, destinationPlanId: move.sourcePlanId }, { ...move, sourcePlanId: '2026-10-21' },
    { ...move, moved: { ...moved, creationActionId: actionId } }, { ...move, tombstone: { ...tombstone, deleted: false } },
    { ...move, moved: { ...moved, deleted: true } }, { ...move, moved: { ...moved, moveLock: {} } }, { ...move, actionId: 'act1_x' },
  ];
  for (const args of bad) await assert.rejects(rtdb.relocateActionPlanItem(IDENTITY, args), AuthorityBoundaryViolation, JSON.stringify(Object.keys(args)));
  await assert.rejects(rtdb.relocateActionPlanItem({ firebaseUid: UID, roomId: 'uid_other' }, move), AuthorityBoundaryViolation);
  for (const [status, expected] of [[401, 'FORBIDDEN'], [403, 'FORBIDDEN'], [503, 'RETRYABLE_TRANSPORT']]) {
    assert.equal(await ownerPrimitives({ status }).rtdb.relocateActionPlanItem(IDENTITY, move).catch(error => error.code), expected, String(status));
  }
});

test('TASK-012 plan_move token: the exchanged ID token must carry every move claim exactly, or it is refused', async () => {
  const actionId = 'act1_2d0b3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const plan = { kind: 'plan_move', target: 'cal1:2026-10-23', source: 'cal1:2026-10-21', item: 'api1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4' };
  const claims = { chronasenseActionId: actionId, chronasenseActionKind: 'plan_move', chronasenseActionTarget: plan.target, chronasenseActionSource: plan.source,
    chronasenseActionItem: plan.item };
  const admin = authAdmin();
  const ok = createIdTokenProvider({ authAdmin: admin, webApiKey: 'k', fetch: recordingFetch(() => json(200, { idToken: jwt({ user_id: UID, ...claims }) })) });
  await ok.getIdToken(UID, actionId, plan);
  assert.deepEqual(admin.calls[1], ['createCustomToken', UID, claims]);
  for (const name of Object.keys(claims)) {
    const altered = createIdTokenProvider({ authAdmin: authAdmin(), webApiKey: 'k', fetch: recordingFetch(() => json(200, { idToken: jwt({ user_id: UID, ...claims, [name]: 'x' }) })) });
    await assert.rejects(altered.getIdToken(UID, actionId, plan), error => error.code === 'FORBIDDEN', name);
  }
  for (const broken of [{ ...plan, source: plan.target }, { ...plan, item: 'pgym1' }, { ...plan, extra: 1 }, { ...plan, kind: 'plan_patch' }]) {
    await assert.rejects(ok.getIdToken(UID, actionId, broken), error => error.code === 'FORBIDDEN', JSON.stringify(broken));
  }
});

test('TASK-036: legacy record and fence CAS are pinned to rooms/uid_<uid>/plans|planFences/<valid date>; owner token, existing ETag only', async () => {
  const dateKey = '2026-10-27';
  const bdId = 'bdp1|cap_01';
  const { rtdb, calls, tokenCalls } = ownerPrimitives({ body: { items: [] } });
  assert.deepEqual(await rtdb.readLegacyPlanWithEtag(IDENTITY, dateKey), { value: { items: [] }, etag: '"e1"' });
  assert.equal(new URL(calls[0][0]).pathname, `/rooms/uid_${UID}/plans/${dateKey}.json`);
  assert.equal(calls[0][1].headers['X-Firebase-ETag'], 'true');
  assert.equal(await rtdb.putLegacyPlanIfMatch(IDENTITY, dateKey, { items: [] }, '"e1"'), 'written');
  assert.equal(calls[1][1].method, 'PUT');
  assert.equal(calls[1][1].headers['if-match'], '"e1"');
  await rtdb.readLegacyPlanFenceItemWithEtag(IDENTITY, dateKey, bdId);
  assert.equal(new URL(calls[2][0]).pathname, `/rooms/uid_${UID}/planFences/${dateKey}/bdp1%7Ccap_01.json`);
  assert.equal(await rtdb.putLegacyPlanFenceItemIfMatch(IDENTITY, dateKey, bdId, { id: bdId, task: 'x' }, '"e1"'), 'written');
  assert.deepEqual(tokenCalls, [[UID], [UID], [UID], [UID]], 'never an action-claimed token');
  for (const bad of ['cal1:2026-10-27', '2026-02-30', '2026-10-27/items', '../settings', '2026-10-27 ', 'odv1:x']) {
    await assert.rejects(rtdb.readLegacyPlanWithEtag(IDENTITY, bad), AuthorityBoundaryViolation, bad);
    await assert.rejects(rtdb.putLegacyPlanIfMatch(IDENTITY, bad, { items: [] }, '"e1"'), AuthorityBoundaryViolation, bad);
    await assert.rejects(rtdb.readLegacyPlanFenceItemWithEtag(IDENTITY, bad, bdId), AuthorityBoundaryViolation, bad);
  }
  for (const bad of ['p1', 'api1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4', 'bdp1|', 'bdp1|a/b', '../x']) {
    await assert.rejects(rtdb.readLegacyPlanFenceItemWithEtag(IDENTITY, dateKey, bad), AuthorityBoundaryViolation, bad);
  }
  for (const identity of [{ firebaseUid: UID, roomId: 'uid_other' }, { firebaseUid: '../x', roomId: 'uid_../x' }]) {
    await assert.rejects(rtdb.readLegacyPlanWithEtag(identity, dateKey), AuthorityBoundaryViolation);
  }
  for (const [record, tag] of [[{ items: [] }, 'null_etag'], [{ items: [] }, undefined], [null, '"e1"'], [[], '"e1"']]) {
    await assert.rejects(rtdb.putLegacyPlanIfMatch(IDENTITY, dateKey, record, tag), AuthorityBoundaryViolation, JSON.stringify([record, tag]));
  }
  for (const [record, tag] of [[{ id: bdId }, 'null_etag'], [{ id: 'other' }, '"e1"'], [null, '"e1"']]) {
    await assert.rejects(rtdb.putLegacyPlanFenceItemIfMatch(IDENTITY, dateKey, bdId, record, tag), AuthorityBoundaryViolation, JSON.stringify([record, tag]));
  }
  for (const [status, expected] of [[412, 'changed'], [403, 'FORBIDDEN'], [503, 'RETRYABLE_TRANSPORT']]) {
    const outcome = await ownerPrimitives({ status }).rtdb.putLegacyPlanIfMatch(IDENTITY, dateKey, { items: [] }, '"e1"').catch(error => error.code);
    assert.equal(outcome, expected, String(status));
  }
});
