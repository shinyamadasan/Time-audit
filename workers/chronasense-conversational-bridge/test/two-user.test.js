// TASK-029: two allowlisted users (owner + one second subject). The same Access-verified subject is bound through
// /authorize, the grant (userId + props.ownerSubject) and every MCP tool call, and the Worker signs exactly that
// subject to the real backend pipeline, which resolves it to that user's own room only. Fixture identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { createLocalJWKSet, exportJWK, SignJWT } from 'jose';

import { handleDefaultRequest, requireAccessSubject } from '../src/index.js';
import { allowedSubjects, handleMcpRequest, ISSUER, READ_SCOPE, RESOURCE, WRITE_SCOPE } from '../src/mcp.js';
import { actionActorRef } from '../../../functions/src/envelope.js';
import { harness, KEY, NOW_MS, capture } from '../../../functions/test/support.js';

const A = Object.freeze({ subject: 'access-sub-owner-a', uid: 'uidOwnerA' });
const B = Object.freeze({ subject: 'access-sub-second-b', uid: 'uidSecondB' });
const nowSeconds = Math.floor(NOW_MS / 1000);
const ACCESS_ISSUER = 'https://fixture.cloudflareaccess.com';
const env = Object.freeze({ ACCESS_TEAM_DOMAIN: ACCESS_ISSUER, ACCESS_POLICY_AUD: 'fixture-audience',
  CHRONASENSE_OWNER_SUBJECT: A.subject, CHRONASENSE_SECOND_SUBJECT: B.subject,
  CHRONASENSE_ACTION_API_URL: 'https://example.test/v1/query', CHRONASENSE_WORKER_HMAC_KEY_ID: 'test-key-1',
  CHRONASENSE_WORKER_HMAC_KEY_HEX: KEY.toString('hex') });
const ownerOnly = Object.freeze({ ...env, CHRONASENSE_SECOND_SUBJECT: undefined });

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'fixture-key', alg: 'RS256' };
const accessDeps = { jwks: createLocalJWKSet({ keys: [publicJwk] }), currentDate: new Date(NOW_MS) };
const jwt = (sub, overrides = {}) => new SignJWT({ type: 'app', sub, email: 'irrelevant@example.test', iss: ACCESS_ISSUER,
  aud: ['fixture-audience'], nbf: nowSeconds - 5, exp: nowSeconds + 300, ...overrides })
  .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(privateKey);
const authorizeRequest = async (sub, overrides) => new Request(`${ISSUER}/authorize`, { headers: { 'Cf-Access-Jwt-Assertion': await jwt(sub, overrides) } });

/** A grant as workers-oauth-provider hands it to the API handler: userId and props both from /authorize. */
const ctx = (user, overrides = {}) => ({
  auth: { token: 'fixture-token', audience: RESOURCE, expiresAt: nowSeconds + 300, scope: [READ_SCOPE], userId: user.subject, ...overrides.auth },
  props: { ownerSubject: user.subject, resource: RESOURCE, issuer: ISSUER, notBefore: nowSeconds - 1, ...overrides.props },
});
const call = (name, args = {}) => new Request('https://localhost/mcp', { method: 'POST', headers: { Host: 'localhost',
  Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
async function message(response) {
  const body = await response.text();
  const line = body.split(/\r?\n/).find(value => value.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : body);
}

/** The real Worker signer wired to the real backend pipeline, configured with both allowlisted pairs. */
function endToEnd(owner = { ownerSubject: A.subject, ownerFirebaseUid: A.uid, secondSubject: B.subject, secondFirebaseUid: B.uid }) {
  const backend = harness({ owner, rooms: {
    [`uid_${A.uid}`]: { brainDump: { cap_a: capture('cap_a', { text: 'owner A private' }) } },
    [`uid_${B.uid}`]: { brainDump: { cap_b: capture('cap_b', { text: 'second B private' }) } },
  } });
  let backendCalls = 0;
  const deps = { nowSeconds, cryptoImpl: webcrypto, now: () => NOW_MS, fetchImpl: async (url, init) => {
    backendCalls++;
    const result = await backend.handle({ method: init.method, path: new URL(url).pathname,
      rawHeaders: Object.entries(init.headers).flat(), rawBody: new TextEncoder().encode(init.body) });
    return new Response(result.payload, { status: result.status });
  } };
  return { backend, deps, calls: () => backendCalls };
}

test('allowlist: owner only by default; the second subject only when set, well-formed and distinct', () => {
  assert.deepEqual(allowedSubjects(ownerOnly), [A.subject]);
  assert.deepEqual(allowedSubjects({ ...env, CHRONASENSE_SECOND_SUBJECT: '' }), [A.subject]);
  assert.deepEqual(allowedSubjects(env), [A.subject, B.subject]);
  for (const bad of [{ ...env, CHRONASENSE_OWNER_SUBJECT: '' }, { ...env, CHRONASENSE_OWNER_SUBJECT: undefined },
    { ...env, CHRONASENSE_SECOND_SUBJECT: A.subject }, { ...env, CHRONASENSE_SECOND_SUBJECT: 'a,b' },
    { ...env, CHRONASENSE_SECOND_SUBJECT: ' padded ' }, { ...env, CHRONASENSE_SECOND_SUBJECT: 7 }]) {
    assert.throws(() => allowedSubjects(bad), /owner-not-configured/);
  }
});

test('/authorize admits A and B by verified Access sub; unknown, removed, expired and forged assertions are refused', async () => {
  assert.equal(await requireAccessSubject(await authorizeRequest(A.subject), env, accessDeps), A.subject);
  assert.equal(await requireAccessSubject(await authorizeRequest(B.subject), env, accessDeps), B.subject);
  // Email never selects an identity: B's email claim with an unknown sub is refused.
  await assert.rejects(requireAccessSubject(await authorizeRequest('access-sub-unknown', { email: B.subject }), env, accessDeps), /not allowlisted/);
  await assert.rejects(requireAccessSubject(await authorizeRequest(B.subject), ownerOnly, accessDeps), /not allowlisted/);
  await assert.rejects(requireAccessSubject(await authorizeRequest(B.subject, { exp: nowSeconds - 1 }), env, accessDeps));
  await assert.rejects(requireAccessSubject(await authorizeRequest(B.subject, { aud: ['other-app'] }), env, accessDeps));
  await assert.rejects(requireAccessSubject(await authorizeRequest(B.subject, { iss: 'https://other.cloudflareaccess.com' }), env, accessDeps));
  const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forged = await new SignJWT({ type: 'app', sub: B.subject, iss: ACCESS_ISSUER, aud: ['fixture-audience'], nbf: nowSeconds - 5, exp: nowSeconds + 300 })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(otherKey);
  await assert.rejects(requireAccessSubject(new Request(`${ISSUER}/authorize`, { headers: { 'Cf-Access-Jwt-Assertion': forged } }), env, accessDeps));
  const page = await handleDefaultRequest(await authorizeRequest('access-sub-unknown'), env, accessDeps);
  assert.equal(page.status, 401);
  const misconfigured = await handleDefaultRequest(await authorizeRequest(B.subject), { ...env, CHRONASENSE_SECOND_SUBJECT: A.subject }, accessDeps);
  assert.equal(misconfigured.status, 503);
});

test('the grant B approves is bound to B: completeAuthorization userId and props.ownerSubject are both B', async () => {
  let completed;
  const oauth = {
    approveConsent: async () => ({ request: { scope: [READ_SCOPE], resource: RESOURCE }, headers: new Headers() }),
    completeAuthorization: async value => { completed = value; return { redirectTo: 'https://client.test/callback' }; },
  };
  const response = await handleDefaultRequest(new Request(`${ISSUER}/authorize`, { method: 'POST', headers: {
    'Cf-Access-Jwt-Assertion': await jwt(B.subject), 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'handle=opaque&decision=approve' }), { ...env, OAUTH_PROVIDER: oauth }, accessDeps);
  assert.equal(response.status, 302);
  assert.equal(completed.userId, B.subject);
  assert.equal(completed.props.ownerSubject, B.subject);
});

test('consent names the signed-in person (escaped, display only); the email label never chooses the account', async () => {
  const consent = {
    parseAuthRequest: async () => ({ scope: [READ_SCOPE], resource: RESOURCE }),
    describeConsent: async () => ({ clientName: 'Fixture client', redirectHost: 'chatgpt.com' }),
    beginConsent: async () => ({ handle: 'opaque', headers: new Headers() }),
  };
  const page = async (sub, email) => (await handleDefaultRequest(new Request(`${ISSUER}/authorize?resource=${encodeURIComponent(RESOURCE)}`, {
    headers: { 'Cf-Access-Jwt-Assertion': await jwt(sub, { email }) } }), { ...env, OAUTH_PROVIDER: consent }, accessDeps)).text();
  const html = await page(B.subject, 'b<script>@example.test');
  assert.match(html, /Signed in as <strong>b&#60;script&#62;@example\.test<\/strong>/);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes(B.subject));
  // B's token carrying A's email is still B: the label is shown, never used to pick an identity.
  const mislabeled = await page(B.subject, 'owner-a@example.test');
  assert.ok(mislabeled.includes(B.subject) && !mislabeled.includes(A.subject));
  assert.doesNotMatch(await page(A.subject, undefined), /Signed in as/);
});

test('A->A and B->B: each grant reads only its own room through the real signer and backend', async () => {
  for (const [user, mine, theirs] of [[A, 'cap_a', 'cap_b'], [B, 'cap_b', 'cap_a']]) {
    const { backend, deps } = endToEnd();
    const answer = await message(await handleMcpRequest(call('get_brain_dump'), env, deps, ctx(user)));
    assert.equal(answer.result.isError, undefined, JSON.stringify(answer));
    const ids = answer.result.structuredContent.result.captures.map(item => item.captureId);
    assert.deepEqual(ids, [mine]);
    assert.ok(!ids.includes(theirs));
    assert.deepEqual(backend.domain.reads, [{ roomId: `uid_${user.uid}`, collection: 'brainDump' }]);
  }
});

test('A->B and B->A: a grant whose userId and props subject disagree is refused before the backend', async () => {
  const { deps, calls } = endToEnd();
  for (const context of [ctx(A, { props: { ownerSubject: B.subject } }), ctx(B, { props: { ownerSubject: A.subject } }),
    ctx(A, { auth: { userId: B.subject } }), ctx(B, { auth: { userId: A.subject } })]) {
    const answer = await message(await handleMcpRequest(call('get_brain_dump'), env, deps, context));
    assert.equal(answer.result.isError, true);
    assert.match(JSON.stringify(answer), /invalid_token/);
  }
  assert.equal(calls(), 0);
});

test('unknown subject, removed second user, expired or not-yet-valid grant and invalid config never reach the backend', async () => {
  const { deps, calls } = endToEnd();
  const unknown = { subject: 'access-sub-unknown' };
  const cases = [[env, ctx(unknown)], [ownerOnly, ctx(B)], [env, ctx(B, { auth: { expiresAt: nowSeconds } })],
    [env, ctx(A, { auth: { expiresAt: nowSeconds - 60 } })], [env, ctx(B, { props: { notBefore: nowSeconds + 60 } })],
    [{ ...env, CHRONASENSE_SECOND_SUBJECT: A.subject }, ctx(A)], [{ ...env, CHRONASENSE_OWNER_SUBJECT: '' }, ctx(B)]];
  for (const [config, context] of cases) {
    const answer = await message(await handleMcpRequest(call('get_brain_dump'), config, deps, context));
    assert.equal(answer.result.isError, true);
  }
  assert.equal(calls(), 0);
});

test('the backend refuses a validly signed subject it does not map, even if the Worker allowlists it', async () => {
  const { backend, deps } = endToEnd({ ownerSubject: A.subject, ownerFirebaseUid: A.uid });
  const answer = await message(await handleMcpRequest(call('get_brain_dump'), env, deps, ctx(B)));
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /^FORBIDDEN/);
  assert.deepEqual(backend.domain.reads, []);
});

test('a B write signs B as subject, only the one write scope, and B actor provenance (never A)', async () => {
  const actionId = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const signed = [];
  const deps = { nowSeconds, cryptoImpl: webcrypto, commandActionApi: async (_env, input) => {
    signed.push(input);
    return { contractVersion: 1, requestId: 'fixture', kind: 'brain_dump_add',
      result: { actionId, captureId: `bdc1_${actionId.slice(5)}`, text: 'note', status: 'untriaged',
        createdAt: '2026-10-12T12:00:00.000Z', revision: 'rev1:x', idempotentReplay: false },
      authority: { authority: 'brain_dump_capture', access: 'user_scoped', readAt: '2026-10-12T12:00:00.000Z' } };
  } };
  const answer = await message(await handleMcpRequest(call('brain_dump_add', { actionId, capturedAt: '2026-10-12T12:00:00.000Z', text: 'note' }),
    env, deps, ctx(B, { auth: { scope: [READ_SCOPE, WRITE_SCOPE] } })));
  assert.equal(answer.result.isError, undefined, JSON.stringify(answer));
  assert.equal(signed.length, 1);
  assert.equal(signed[0].subject, B.subject);
  assert.deepEqual(signed[0].scopes, [WRITE_SCOPE]);
  assert.equal(signed[0].command.actionProvenance.actorRef, actionActorRef(B.subject));
  assert.notEqual(signed[0].command.actionProvenance.actorRef, actionActorRef(A.subject));
});
