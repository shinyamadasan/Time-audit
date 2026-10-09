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
    async createCustomToken(uid) { calls.push(['createCustomToken', uid]); if (createError) throw createError; return `custom-token-for-${uid}`; },
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
