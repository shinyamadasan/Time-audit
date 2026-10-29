// Grant coexistence: several ChatGPT credential holders (web, mobile, a reconnect) for one Access subject must not
// revoke each other, while refresh rotation, the 15-minute / 14-day lifetimes, explicit revocation, the per-subject
// grant cap and two-identity isolation keep working. Drives the real workers-oauth-provider end to end over an
// in-memory KV, with our /authorize handler and resource check in front of it. Fixture identities and keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';
import { createLocalJWKSet, exportJWK, SignJWT } from 'jose';
import { handleDefaultRequest, MAX_GRANTS_PER_CLIENT, OAUTH_PROVIDER_CONFIG, rejectInvalidTokenResource } from '../src/index.js';
import { ISSUER, PLAN_WRITE_SCOPE, READ_SCOPE, RESOURCE, requireReadContext } from '../src/mcp.js';

// The real provider imports WorkerEntrypoint from the Workers runtime; Node gets a plain class in its place.
registerHooks({ resolve: (specifier, context, next) => specifier === 'cloudflare:workers'
  ? { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true } : next(specifier, context) });
const { default: OAuthProvider } = await import('@cloudflare/workers-oauth-provider');

const CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const A = 'access-sub-owner-a';
const B = 'access-sub-second-b';
const ACCESS_ISSUER = 'https://fixture.cloudflareaccess.com';
const env0 = { ACCESS_TEAM_DOMAIN: ACCESS_ISSUER, ACCESS_POLICY_AUD: 'fixture-audience',
  CHRONASENSE_OWNER_SUBJECT: A, CHRONASENSE_SECOND_SUBJECT: B };

// One controllable clock for the library (Date.now), the in-memory KV expiry and Access JWT validation.
let clockMs = Date.UTC(2026, 9, 29, 22, 0, 0);
const realNow = Date.now;
Date.now = () => clockMs;
const nowS = () => Math.floor(clockMs / 1000);
const advance = seconds => { clockMs += seconds * 1000; };

globalThis.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url) !== CLIENT_ID) throw new Error('unexpected outbound fetch ' + url);
  return Response.json({ client_id: CLIENT_ID, client_name: 'ChatGPT', redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
};
test.after(() => { Date.now = realNow; globalThis.fetch = realFetch; delete globalThis.Cloudflare; });

/** KV semantics the provider relies on: absolute/relative expiry, key metadata, prefix list. */
class MemoryKV {
  constructor() { this.map = new Map(); }
  live(name) {
    const entry = this.map.get(name);
    if (entry && entry.expiration !== undefined && entry.expiration <= nowS()) { this.map.delete(name); return undefined; }
    return entry;
  }
  async get(name, options) {
    const entry = this.live(name);
    if (!entry) return null;
    const type = typeof options === 'string' ? options : options?.type;
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  }
  async put(name, value, options = {}) {
    const expiration = options.expiration ?? (options.expirationTtl ? nowS() + options.expirationTtl : undefined);
    this.map.set(name, { value: String(value), expiration, metadata: options.metadata });
  }
  async delete(name) { this.map.delete(name); }
  async list({ prefix = '' } = {}) {
    const keys = [...this.map.keys()].filter(name => name.startsWith(prefix) && this.live(name)).sort()
      .map(name => ({ name, expiration: this.map.get(name).expiration, metadata: this.map.get(name).metadata }));
    return { keys, list_complete: true, cursor: '' };
  }
  keys(prefix) { return [...this.map.keys()].filter(name => name.startsWith(prefix) && this.live(name)); }
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'fixture-key', alg: 'RS256' };
const jwks = createLocalJWKSet({ keys: [publicJwk] });
const accessJwt = sub => new SignJWT({ type: 'app', sub, email: 'irrelevant@example.test', iss: ACCESS_ISSUER,
  aud: ['fixture-audience'], nbf: nowS() - 5, exp: nowS() + 300 })
  .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(privateKey);
const b64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The production provider configuration with our real /authorize handler; the API handler reports the identity
 *  that the shipped MCP context check (requireReadContext) derives from the presented token. */
function bridge(env = env0, kv = new MemoryKV()) {
  const fullEnv = { ...env, OAUTH_KV: kv };
  let helpers;
  const provider = new OAuthProvider({ ...OAUTH_PROVIDER_CONFIG,
    apiHandler: { fetch: async (request, e, ctx) => {
      try { return Response.json({ subject: requireReadContext(e, ctx, nowS()).subject }); }
      catch (error) { return Response.json({ error: error.message }, { status: 403 }); }
    } },
    defaultHandler: { fetch: (request, e) => { helpers = e.OAUTH_PROVIDER;
      return handleDefaultRequest(request, e, { jwks, currentDate: new Date(clockMs) }); } } });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const send = async request => (await rejectInvalidTokenResource(request)) ?? provider.fetch(request, fullEnv, ctx);
  const form = fields => new Request(`${ISSUER}/oauth/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });

  /** One full ChatGPT connection: Access-gated consent, approval, PKCE code exchange. Returns a credential holder. */
  async function connect(sub, { scope = [READ_SCOPE, PLAN_WRITE_SCOPE], exchange = true } = {}) {
    const verifier = b64url(randomBytes(32));
    const url = new URL(`${ISSUER}/authorize`);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      scope: scope.join(' '), state: 'st', resource: RESOURCE, code_challenge_method: 'S256',
      code_challenge: b64url(createHash('sha256').update(verifier).digest()) })) url.searchParams.set(k, v);
    const access = { 'Cf-Access-Jwt-Assertion': await accessJwt(sub) };
    const page = await send(new Request(url, { headers: access }));
    assert.equal(page.status, 200);
    const handle = /name="handle" value="([^"]+)"/.exec(await page.text())[1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c));
    const cookie = page.headers.get('Set-Cookie').split(';')[0];
    const approved = await send(new Request(url, { method: 'POST', headers: { ...access, Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, decision: 'approve' }) }));
    assert.equal(approved.status, 302);
    const code = new URL(approved.headers.get('Location')).searchParams.get('code');
    const exchangeCode = async () => {
      const tokens = await (await send(form({ grant_type: 'authorization_code', code, code_verifier: verifier,
        client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, resource: RESOURCE }))).json();
      assert.ok(tokens.access_token && tokens.refresh_token, 'code exchange issued both tokens');
      assert.equal(tokens.expires_in, 15 * 60);
      return { sub, at: tokens.access_token, rt: tokens.refresh_token, grantId: tokens.refresh_token.split(':')[1] };
    };
    if (!exchange) return { sub, grantId: code.split(':')[1], exchange: exchangeCode };
    return exchangeCode();
  }
  async function refresh(holder, rt = holder.rt) {
    const response = await send(form({ grant_type: 'refresh_token', refresh_token: rt, client_id: CLIENT_ID, resource: RESOURCE }));
    const body = await response.json();
    if (response.ok) { holder.at = body.access_token; holder.rt = body.refresh_token; }
    return { status: response.status, error: body.error, expiresIn: body.expires_in };
  }
  async function mcp(holder) {
    const response = await send(new Request(`${ISSUER}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${holder.at}` } }));
    return { status: response.status, subject: response.status === 200 ? (await response.json()).subject : undefined };
  }
  const revoke = holder => send(form({ token: holder.rt, token_type_hint: 'refresh_token', client_id: CLIENT_ID }));
  const grants = sub => kv.keys(`grant:${sub}:`).map(name => name.split(':').pop());
  return { kv, connect, refresh, mcp, revoke, grants, helpers: () => helpers };
}

test('two independent holders for one subject both stay connected and refresh independently', async () => {
  const b = bridge();
  const web = await b.connect(A);
  const mobile = await b.connect(A);
  assert.notEqual(web.grantId, mobile.grantId);
  assert.deepEqual(await b.mcp(web), { status: 200, subject: A });
  assert.deepEqual(await b.mcp(mobile), { status: 200, subject: A });
  for (let i = 0; i < 3; i++) {
    advance(16 * 60);
    assert.equal((await b.mcp(web)).status, 401, 'access token expires after 15 minutes');
    assert.equal((await b.refresh(web)).status, 200);
    assert.equal((await b.refresh(mobile)).status, 200);
    assert.deepEqual(await b.mcp(web), { status: 200, subject: A });
    assert.deepEqual(await b.mcp(mobile), { status: 200, subject: A });
  }
});

test('reconnecting one holder leaves the other active holder connected', async () => {
  const b = bridge();
  const active = await b.connect(A);
  advance(16 * 60);
  assert.equal((await b.refresh(active)).status, 200);
  const reconnect1 = await b.connect(A);
  const reconnect2 = await b.connect(A);
  assert.deepEqual(await b.mcp(active), { status: 200, subject: A }, 'live access token survives other reconnects');
  advance(16 * 60);
  assert.equal((await b.refresh(active)).status, 200, 'refresh token survives other reconnects');
  assert.deepEqual(await b.mcp(active), { status: 200, subject: A });
  assert.equal((await b.refresh(reconnect1)).status, 200);
  assert.equal((await b.refresh(reconnect2)).status, 200);
  assert.equal(b.grants(A).length, 3);
});

test('refresh rotation, one-step grace, 15-minute access and fixed 14-day grant expiry are unchanged', async () => {
  const b = bridge();
  const holder = await b.connect(A);
  const created = nowS();
  const grantKey = `grant:${A}:${holder.grantId}`;
  assert.equal(b.kv.map.get(grantKey).expiration, created + 14 * 24 * 60 * 60);
  const rt0 = holder.rt;
  advance(60);
  const r1 = await b.refresh(holder);
  assert.equal(r1.status, 200);
  assert.equal(r1.expiresIn, 15 * 60);
  const rt1 = holder.rt;
  assert.notEqual(rt1, rt0, 'refresh token rotates');
  assert.equal((await b.refresh({ ...holder }, rt0)).status, 200, 'the immediately previous refresh token is still accepted');
  assert.equal((await b.refresh(holder)).status, 400, 'that grace rotated past rt1, which is now two generations old');
  assert.equal(b.kv.map.get(grantKey).expiration, created + 14 * 24 * 60 * 60, 'refresh never extends the 14-day expiry');
  // Expiry: a holder that keeps refreshing still ends at 14 days, and the grant is then gone.
  const late = await b.connect(A);
  advance(14 * 24 * 60 * 60 - 120);
  assert.equal((await b.refresh(late)).status, 200);
  advance(180);
  const expired = await b.refresh(late);
  assert.equal(expired.status, 400);
  assert.equal(expired.error, 'invalid_grant');
  assert.equal((await b.mcp(late)).status, 401);
});

test('explicit revocation of one holder revokes only that grant; operator revocation still works', async () => {
  const b = bridge();
  const web = await b.connect(A);
  const mobile = await b.connect(A);
  assert.equal((await b.revoke(web)).status, 200);
  assert.equal((await b.mcp(web)).status, 401);
  assert.equal((await b.refresh(web)).error, 'invalid_grant');
  assert.deepEqual(await b.mcp(mobile), { status: 200, subject: A });
  assert.equal((await b.refresh(mobile)).status, 200);
  assert.deepEqual(b.grants(A), [mobile.grantId]);
  // Operator kill switch: revoke every grant of the subject through the provider helpers.
  const helpers = b.helpers();
  const listed = [];
  for (const grant of (await helpers.listUserGrants(A)).items) { listed.push(grant.id); await helpers.revokeGrant(grant.id, A); }
  assert.deepEqual(listed, [mobile.grantId]);
  assert.equal((await b.mcp(mobile)).status, 401);
  assert.equal((await b.refresh(mobile)).error, 'invalid_grant');
});

test('two identities: grants coexist per subject only and never cross accounts', async () => {
  const b = bridge();
  await b.connect(A);
  const b1 = await b.connect(B);
  let a2;
  for (let i = 0; i < MAX_GRANTS_PER_CLIENT + 2; i++) a2 = await b.connect(A);
  assert.deepEqual(b.grants(B), [b1.grantId], "A's reconnects and grant cap never touch B");
  assert.deepEqual(await b.mcp(b1), { status: 200, subject: B });
  assert.equal((await b.refresh(b1)).status, 200);
  assert.deepEqual(await b.mcp(b1), { status: 200, subject: B });
  assert.ok(b.grants(A).every(id => id !== b1.grantId));
  // A token's subject comes from its own grant: forging B's userId prefix onto A's secret is not a B token.
  const [, grantId, secret] = a2.at.split(':');
  assert.equal((await b.mcp({ at: `${B}:${grantId}:${secret}` })).status, 401);
  // Removing B from the allowlist rejects B's still-stored tokens (same KV) without affecting A.
  const removed = bridge({ ...env0, CHRONASENSE_SECOND_SUBJECT: undefined }, b.kv);
  assert.equal((await removed.mcp(b1)).status, 403, 'de-allowlisted subject refused by the MCP context check');
  assert.deepEqual(await removed.mcp(a2), { status: 200, subject: A });
});

test('grant cap: past the limit the oldest live grant of that subject is revoked', async () => {
  const b = bridge();
  const holders = [];
  for (let i = 0; i < MAX_GRANTS_PER_CLIENT; i++) { holders.push(await b.connect(A)); advance(1); }
  assert.equal(b.grants(A).length, MAX_GRANTS_PER_CLIENT);
  const newest = await b.connect(A);
  const live = b.grants(A);
  assert.equal(live.length, MAX_GRANTS_PER_CLIENT, 'never more than the cap');
  assert.ok(!live.includes(holders[0].grantId), 'the oldest was revoked');
  assert.ok(live.includes(newest.grantId));
  assert.equal((await b.mcp(holders[0])).status, 401);
  assert.equal((await b.refresh(holders[0])).error, 'invalid_grant');
  for (const holder of [...holders.slice(1), newest]) assert.deepEqual(await b.mcp(holder), { status: 200, subject: A });
});

test('grant cap ignores pending (approved, never exchanged) grants, which expire on their own', async () => {
  const b = bridge();
  const holders = [];
  for (let i = 0; i < MAX_GRANTS_PER_CLIENT - 1; i++) { holders.push(await b.connect(A)); advance(1); }
  const pending = await b.connect(A, { exchange: false });
  advance(1);
  const last = await b.connect(A);
  assert.equal(b.grants(A).length, MAX_GRANTS_PER_CLIENT + 1, 'the pending grant was not counted, so nobody was evicted');
  for (const holder of [...holders, last]) assert.deepEqual(await b.mcp(holder), { status: 200, subject: A });
  advance(11 * 60);
  assert.ok(!b.grants(A).includes(pending.grantId), 'an abandoned authorization expires after 10 minutes');
  for (const holder of [...holders, last]) assert.equal((await b.refresh(holder)).status, 200);
});

test('concurrent authorizations may exceed the cap by the number in flight; the next authorization restores it', async () => {
  const b = bridge();
  for (let i = 0; i < MAX_GRANTS_PER_CLIENT; i++) { await b.connect(A); advance(1); }
  // Two approvals land before either code is exchanged: each sees the other as pending and does not count it.
  const x = await b.connect(A, { exchange: false });
  const y = await b.connect(A, { exchange: false });
  const holders = [await x.exchange(), await y.exchange()];
  assert.equal(b.grants(A).length, MAX_GRANTS_PER_CLIENT + 1, 'bounded overshoot: one extra per concurrent approval');
  for (const holder of holders) assert.deepEqual(await b.mcp(holder), { status: 200, subject: A });
  advance(1);
  const next = await b.connect(A);
  assert.equal(b.grants(A).length, MAX_GRANTS_PER_CLIENT);
  assert.deepEqual(await b.mcp(next), { status: 200, subject: A });
});

test('a stale KV listing (eventual consistency) can only mis-size the cap, never reach another subject', async () => {
  const b = bridge();
  const bHolder = await b.connect(B);
  const holders = [];
  for (let i = 0; i < MAX_GRANTS_PER_CLIENT; i++) { holders.push(await b.connect(A)); advance(1); }
  // Stale list 1: omits the newest live grant, so pruning under-counts and keeps one more than the cap.
  const list = b.kv.list.bind(b.kv);
  b.kv.list = async options => { const page = await list(options);
    return { ...page, keys: page.keys.filter(key => !key.name.endsWith(':' + holders.at(-1).grantId)) }; };
  await b.connect(A);
  assert.equal(b.grants(A).length, MAX_GRANTS_PER_CLIENT + 1);
  // Stale list 2: still shows a grant that is already gone; its record reads as missing and is skipped.
  b.kv.list = list;
  const gone = `grant:${A}:${holders[1].grantId}`;
  const ghost = b.kv.map.get(gone);
  await b.helpers().revokeGrant(holders[1].grantId, A);
  b.kv.list = async options => { const page = await list(options);
    return options.prefix === `grant:${A}:` ? { ...page, keys: [...page.keys, { name: gone, metadata: ghost.metadata }] } : page; };
  await b.connect(A);
  b.kv.list = list;
  assert.ok(b.grants(A).length <= MAX_GRANTS_PER_CLIENT + 1);
  assert.deepEqual(b.grants(B), [bHolder.grantId], 'B is never listed or revoked by A');
  assert.deepEqual(await b.mcp(bHolder), { status: 200, subject: B });
});

test('pruning runs only after the grant is created, and a pruning failure never blocks the approval', async () => {
  const subjectEnv = { ...env0 };
  const headers = { 'Cf-Access-Jwt-Assertion': await accessJwt(A), 'Content-Type': 'application/x-www-form-urlencoded' };
  const post = oauth => handleDefaultRequest(new Request(`${ISSUER}/authorize`, { method: 'POST', headers,
    body: 'handle=opaque&decision=approve' }), { ...subjectEnv, OAUTH_PROVIDER: oauth }, { jwks, currentDate: new Date(clockMs) });
  const approveConsent = async () => ({ request: { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, scope: [READ_SCOPE], resource: RESOURCE },
    headers: new Headers() });
  const old = { id: 'old', userId: A, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, resource: RESOURCE, createdAt: 1, expiresAt: nowS() + 99 };
  const full = Array.from({ length: MAX_GRANTS_PER_CLIENT }, (_, i) => ({ ...old, id: 'g' + i, createdAt: 10 + i }));
  const revoked = [];
  const failed = await post({ approveConsent, listUserGrants: async () => ({ items: full }),
    revokeGrant: async id => { revoked.push(id); }, completeAuthorization: async () => { throw new Error('boom'); } });
  assert.notEqual(failed.status, 302);
  assert.deepEqual(revoked, [], 'a failed authorization evicts nothing');
  const ok = await post({ approveConsent, listUserGrants: async () => ({ items: full }),
    revokeGrant: async id => { revoked.push(id); }, completeAuthorization: async () => ({ redirectTo: 'https://chatgpt.com/cb' }) });
  assert.equal(ok.status, 302);
  assert.deepEqual(revoked, ['g0'], 'only the oldest of the full set');
  const broken = await post({ approveConsent, listUserGrants: async () => { throw new Error('KV down'); },
    revokeGrant: async () => {}, completeAuthorization: async () => ({ redirectTo: 'https://chatgpt.com/cb' }) });
  assert.equal(broken.status, 302, 'the cap is hygiene: KV listing failure still completes the approval');
});
