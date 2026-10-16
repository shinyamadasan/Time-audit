// Offline proofs for the TASK-018 staging kit. No network, no cloud: guard, artifact isolation and the harness
// scenarios against the real completion handler over an in-memory store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStagingConfig, guardedFetch, PRODUCTION } from './guard.mjs';
import { buildStagingFrontend, verifyStagingFrontend } from './frontend.mjs';
import { runScenarios, syntheticRoom, THRESHOLDS } from './harness.mjs';
import { createCompletionHandler, RESOLUTIONS } from '../../functions/src/completion-api.js';

const STAGING = { apiKey: 'AIzaStagingOnlyPublicKey000000000000000', authDomain: 'chronasense-staging.firebaseapp.com',
  databaseURL: 'https://chronasense-staging-default-rtdb.asia-southeast1.firebasedatabase.app/', projectId: 'chronasense-staging' };

test('guard refuses production, look-alike and incomplete configs; fetch allowlist fails closed', async () => {
  const hosts = assertStagingConfig(STAGING);
  assert.equal(hosts.endpoint, 'https://asia-southeast1-chronasense-staging.cloudfunctions.net/chronasenseCompletionApi');
  const prod = { apiKey: PRODUCTION.apiKey, authDomain: `${PRODUCTION.projectId}.firebaseapp.com`,
    databaseURL: `https://${PRODUCTION.projectId}-default-rtdb.asia-southeast1.firebasedatabase.app/`, projectId: PRODUCTION.projectId };
  for (const bad of [prod, { ...STAGING, apiKey: PRODUCTION.apiKey }, { ...STAGING, databaseURL: prod.databaseURL },
    { ...STAGING, projectId: 'chronasense-prod2', authDomain: 'chronasense-prod2.firebaseapp.com' }, { ...STAGING, authDomain: prod.authDomain },
    { ...STAGING, databaseURL: 'https://other-staging-default-rtdb.firebaseio.com/' }, { ...STAGING, apiKey: '' }, null]) {
    assert.throws(() => assertStagingConfig(bad));
  }
  const seen = [], f = guardedFetch(STAGING, async url => { seen.push(url.hostname); return new Response('{}'); });
  await f(hosts.endpoint); await f('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=x');
  for (const url of [`https://${PRODUCTION.projectId}-default-rtdb.asia-southeast1.firebasedatabase.app/rooms.json`,
    `https://asia-southeast1-${PRODUCTION.projectId}.cloudfunctions.net/chronasenseCompletionApi`,
    `https://identitytoolkit.googleapis.com/v1/x?key=${PRODUCTION.apiKey}`, 'https://shinyamadasan.github.io/Time-audit/',
    'http://chronasense-staging-default-rtdb.asia-southeast1.firebasedatabase.app/', 'https://example.com/']) {
    assert.throws(() => f(url), /blocked/);
  }
  assert.equal(seen.length, 2);
});

test('disposable frontend: only public config changes, built outside the repo, statically free of production data plane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chronasense-staging-')), out = join(dir, 'site');
  try {
    assert.throws(() => buildStagingFrontend({ config: STAGING, out: join(process.cwd(), 'staging-artifact') }), /OUTSIDE/);
    const report = buildStagingFrontend({ config: STAGING, out });
    assert.equal(report.ok, true); assert.deepEqual(report.dataPlaneHits, []);
    assert.ok(report.staticHostRefs.length > 0, 'production static-host references are reported for runtime blocking');
    const storage = readFileSync(join(out, 'storage.js'), 'utf8');
    assert.ok(storage.includes('"chronasense-staging"')); assert.equal(storage.includes(PRODUCTION.projectId), false);
    const before = readFileSync(join(process.cwd(), 'www', 'storage.js'), 'utf8').split('\n'), after = storage.split('\n');
    assert.equal(after.length, before.length);
    assert.equal(after.filter((line, i) => line !== before[i]).length, 4, 'exactly the four public config values differ');
    const original = readFileSync(join(process.cwd(), 'www', 'index.html'));
    assert.deepEqual(readFileSync(join(out, 'index.html')), original, 'every other file is byte-identical');
    writeFileSync(join(out, 'sneaky.js'), `fetch("https://${PRODUCTION.projectId}.firebaseapp.com")`);
    assert.throws(() => verifyStagingFrontend({ config: STAGING, out }), /NOT isolated/);
    mkdirSync(join(dir, 'busy')); writeFileSync(join(dir, 'busy', 'x'), '');
    assert.throws(() => buildStagingFrontend({ config: STAGING, out: join(dir, 'busy') }), /empty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// In-memory stand-in for staging: real handler + ETag CAS store + the one rule the harness relies on.
function offlineStaging() {
  const rooms = new Map(), etags = new Map(), users = { A: 'stagingUserA', B: 'stagingUserB' };
  const get = uid => structuredClone(rooms.get(uid) ?? {});
  const put = (uid, value) => { rooms.set(uid, structuredClone(value)); etags.set(uid, (etags.get(uid) || 0) + 1); };
  const domain = {
    read: async uid => ({ value: get(uid), etag: `e${etags.get(uid) || 0}` }),
    cas: async (uid, etag, next) => { if (etag !== `e${etags.get(uid) || 0}`) return 'changed'; put(uid, next); return 'written'; },
    readResolution: async (uid, key) => get(uid)[RESOLUTIONS]?.[key] ?? null,
  };
  const handler = createCompletionHandler({ verifyIdToken: async token => {
    const uid = Object.values(users).find(u => `tok-${u}` === token);
    if (!uid) throw new Error('invalid'); return { uid };
  }, domain });
  const raw = async (authorization, body) => {
    const started = performance.now();
    const r = await handler({ method: 'POST', authorization: authorization ?? undefined, rawBody: Buffer.from(JSON.stringify(body)) });
    return { status: r.status, body: structuredClone(r.body), ms: performance.now() - started };
  };
  return {
    raw, call: (token, body) => raw(`Bearer ${token}`, body),
    signIn: async user => ({ uid: users[user], idToken: `tok-${users[user]}` }),
    seed: async (uid, room) => put(uid, room),
    readRoom: async uid => get(uid),
    ownerWrite: async (token, uid, path, value) => {
      if (token !== `tok-${uid}` || path.startsWith(RESOLUTIONS)) return false; // generated rules deny direct resolution writes
      const room = get(uid), parts = path.split('/'); let at = room;
      for (const part of parts.slice(0, -1)) at = at[part] ||= {};
      at[parts.at(-1)] = value; put(uid, room); return true;
    },
    sleep: ms => new Promise(done => setTimeout(done, Math.min(ms, 5))),
  };
}

test('synthetic rooms are unambiguous, currently unfinished and padded to the requested size', async () => {
  const { room, identities } = syntheticRoom({ nowMs: Date.now(), tasks: 4, padBytes: 300000, label: 'self' });
  assert.ok(Buffer.byteLength(JSON.stringify(room)) >= 300000);
  const s = offlineStaging(); await s.seed('stagingUserA', room);
  const { body } = await s.call('tok-stagingUserA', { kind: 'inspect', identities });
  assert.deepEqual(body.views.map(v => v.state), ['unfinished', 'unfinished', 'unfinished', 'unfinished']);
});

test('harness scenarios pass end to end against the real handler and fail loudly on a broken backend', async () => {
  const small = [{ name: 'tiny', tasks: 6, bytes: 65536, samples: 3, p95Ms: THRESHOLDS.sizes[0].p95Ms }];
  const report = await runScenarios(offlineStaging(), { sizes: small });
  assert.equal(report.go, true, JSON.stringify(report.results.filter(r => !r.pass)));
  for (const name of ['auth:missing', 'replay:same-operation', 'unknown:recover-same-uuid', 'compete:one-head', 'undo:exact-revision',
    'undo:newer-source-refused', 'isolation:cross-account', 'isolation:direct-write-denied', 'concurrency:all-resolved',
    'heartbeat:explicit-contention', 'size:oversize-refused', 'latency:single']) {
    assert.ok(report.results.some(r => r.name === name && r.pass), name);
  }
  // Negative control: a backend that loses acknowledgements must produce NO-GO, not a pass.
  const broken = offlineStaging(), call = broken.call;
  broken.call = async (token, body) => body.kind === 'status' ? { status: 200, body: { outcome: 'UNKNOWN' }, ms: 1 } : call(token, body);
  const failed = await runScenarios(broken, { sizes: small });
  assert.equal(failed.go, false);
  assert.ok(failed.results.some(r => r.name === 'unknown:recover-same-uuid' && !r.pass));
});

test('log scan counts outcomes and fails on any forbidden value without echoing it', async () => {
  const { scanLogs } = await import('./scan-logs.mjs');
  const entries = [{ jsonPayload: { component: 'chronasense-completion-api', event: 'completion-request', op: 'mutate', outcome: 'CONFIRMED' } },
    { jsonPayload: { component: 'other', note: 'stagingUserA' } }];
  assert.deepEqual(scanLogs(entries, ['stagingUserA']), { events: 1, forbiddenHits: 0, outcomes: { 'mutate:CONFIRMED': 1 }, ok: true });
  entries[0].jsonPayload.reason = 'stagingUserA';
  const leaked = scanLogs(entries, ['stagingUserA']);
  assert.equal(leaked.ok, false); assert.equal(JSON.stringify(leaked).includes('stagingUserA'), false);
  assert.equal(scanLogs([], []).ok, false, 'no events is a failure, not a pass');
});
