// Offline proofs for the TASK-018 staging kit. No network, no cloud: guard, artifact isolation, deploy-env gate,
// log scan and the harness scenarios against the real completion handler over an in-memory store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStagingConfig, guardedFetch, PRODUCTION } from './guard.mjs';
import { buildStagingFrontend, verifyStagingFrontend } from './frontend.mjs';
import { LIMITS, runScenarios, syntheticRoom, THRESHOLDS } from './harness.mjs';
import { checkDeployEnv } from './check-deploy-env.mjs';
import { scanLogs } from './scan-logs.mjs';
import { createCompletionHandler, RESOLUTIONS } from '../../functions/src/completion-api.js';

const STAGING = { apiKey: 'AIzaStagingOnlyPublicKey000000000000000', authDomain: 'chronasense-staging.firebaseapp.com',
  databaseURL: 'https://chronasense-staging-default-rtdb.asia-southeast1.firebasedatabase.app/', projectId: 'chronasense-staging' };

test('guard refuses production, look-alike and incomplete configs; fetch allowlist fails closed, never follows redirects', async () => {
  const hosts = assertStagingConfig(STAGING);
  assert.equal(hosts.endpoint, 'https://asia-southeast1-chronasense-staging.cloudfunctions.net/chronasenseCompletionApi');
  const prod = { apiKey: PRODUCTION.apiKey, authDomain: `${PRODUCTION.projectId}.firebaseapp.com`,
    databaseURL: `https://${PRODUCTION.projectId}-default-rtdb.asia-southeast1.firebasedatabase.app/`, projectId: PRODUCTION.projectId };
  for (const bad of [prod, { ...STAGING, apiKey: PRODUCTION.apiKey }, { ...STAGING, databaseURL: prod.databaseURL },
    { ...STAGING, projectId: 'chronasense-prod2', authDomain: 'chronasense-prod2.firebaseapp.com' }, { ...STAGING, authDomain: prod.authDomain },
    { ...STAGING, databaseURL: 'https://other-staging-default-rtdb.firebaseio.com/' }, { ...STAGING, apiKey: '' }, null]) {
    assert.throws(() => assertStagingConfig(bad));
  }
  for (const db of ['https://chronasense-staging-default-rtdb.firebaseio.com/?ns=other', 'https://u:p@chronasense-staging-default-rtdb.firebaseio.com/',
    'https://chronasense-staging-default-rtdb.firebaseio.com:8443/']) {
    assert.throws(() => assertStagingConfig({ ...STAGING, databaseURL: db }), /bare/);
  }
  const seen = [];
  let options;
  const f = guardedFetch(STAGING, async (url, o) => { seen.push(url.hostname); options = o; return new Response('{}'); });
  await f(hosts.endpoint, { method: 'POST' }); await f('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=x');
  assert.equal(options.redirect, 'error');
  for (const url of [`https://${PRODUCTION.projectId}-default-rtdb.asia-southeast1.firebasedatabase.app/rooms.json`,
    `https://asia-southeast1-${PRODUCTION.projectId}.cloudfunctions.net/chronasenseCompletionApi`,
    `https://identitytoolkit.googleapis.com/v1/x?key=${PRODUCTION.apiKey}`, 'https://shinyamadasan.github.io/Time-audit/',
    'http://chronasense-staging-default-rtdb.asia-southeast1.firebasedatabase.app/', 'https://example.com/']) {
    assert.throws(() => f(url), /blocked/);
  }
  assert.equal(seen.length, 2);
});

test('disposable frontend: only public config changes, built outside the repo, tamper-evident, free of production data plane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chronasense-staging-')), out = join(dir, 'site');
  try {
    assert.throws(() => buildStagingFrontend({ config: STAGING, out: join(process.cwd(), 'staging-artifact') }), /OUTSIDE/);
    assert.throws(() => buildStagingFrontend({ config: STAGING, out: join(process.cwd(), '..cache') }), /OUTSIDE/);
    const report = buildStagingFrontend({ config: STAGING, out });
    assert.equal(report.ok, true); assert.equal(report.manifestOk, true); assert.deepEqual(report.dataPlaneHits, []);
    assert.ok(report.staticHostRefs.length > 0, 'production static-host references are reported for runtime blocking');
    const storage = readFileSync(join(out, 'storage.js'), 'utf8');
    assert.ok(storage.includes('"chronasense-staging"')); assert.equal(storage.includes(PRODUCTION.projectId), false);
    const before = readFileSync(join(process.cwd(), 'www', 'storage.js'), 'utf8').split('\n'), after = storage.split('\n');
    assert.equal(after.length, before.length);
    assert.equal(after.filter((line, i) => line !== before[i]).length, 4, 'exactly the four public config values differ');
    const original = readFileSync(join(process.cwd(), 'www', 'index.html'));
    assert.deepEqual(readFileSync(join(out, 'index.html')), original, 'every other file is byte-identical');
    writeFileSync(join(out, 'index.html'), Buffer.concat([original, Buffer.from('<!-- tampered -->')]));
    assert.throws(() => verifyStagingFrontend({ config: STAGING, out }), /NOT isolated/, 'manifest detects any modified file');
    writeFileSync(join(out, 'index.html'), original);
    assert.equal(verifyStagingFrontend({ config: STAGING, out }).ok, true);
    writeFileSync(join(out, 'sneaky.js'), `fetch("https://${PRODUCTION.projectId}.firebaseapp.com")`);
    assert.throws(() => verifyStagingFrontend({ config: STAGING, out }), /NOT isolated/);
    mkdirSync(join(dir, 'busy')); writeFileSync(join(dir, 'busy', 'x'), '');
    assert.throws(() => buildStagingFrontend({ config: STAGING, out: join(dir, 'busy') }), /empty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deploy env gate: only staging-bound values, outside any repo, no production marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chronasense-deploy-')), path = join(dir, `.env.${STAGING.projectId}`);
  const good = ['CHRONASENSE_OWNER_SUBJECT=staging-unused', 'CHRONASENSE_OWNER_FIREBASE_UID=staging-unused', `CHRONASENSE_FIREBASE_WEB_API_KEY=${STAGING.apiKey}`,
    'CHRONASENSE_RTDB_URL=https://chronasense-staging-default-rtdb.asia-southeast1.firebasedatabase.app',
    'CHRONASENSE_COMPLETION_SERVICE_ACCOUNT=chronasense-completion@chronasense-staging.iam.gserviceaccount.com'].join('\n');
  try {
    assert.deepEqual(checkDeployEnv(STAGING, good, path), { ok: true, keys: 5 });
    assert.throws(() => checkDeployEnv(STAGING, good.replace('chronasense-staging-default-rtdb', `${PRODUCTION.projectId}-default-rtdb`), path), /PRODUCTION/);
    assert.throws(() => checkDeployEnv(STAGING, good.replace('chronasense-completion@', 'other@'), path), /SERVICE_ACCOUNT/);
    assert.throws(() => checkDeployEnv(STAGING, `${good}\nEXTRA=1`, path), /unexpected/);
    assert.throws(() => checkDeployEnv(STAGING, good, join(process.cwd(), 'functions', `.env.${STAGING.projectId}`)), /outside any git/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// In-memory stand-in for staging: real handler + ETag CAS store + the one rule the harness relies on.
function offlineStaging() {
  const rooms = new Map(), etags = new Map(), users = { A: 'stagingUserA', B: 'stagingUserB' };
  const get = uid => structuredClone(rooms.get(uid) ?? null);
  const put = (uid, value) => { rooms.set(uid, structuredClone(value)); etags.set(uid, (etags.get(uid) || 0) + 1); };
  const domain = {
    read: async uid => ({ value: get(uid), etag: `e${etags.get(uid) || 0}` }),
    cas: async (uid, etag, next) => { if (etag !== `e${etags.get(uid) || 0}`) return 'changed'; put(uid, next); return 'written'; },
    readResolution: async (uid, key) => get(uid)?.[RESOLUTIONS]?.[key] ?? null,
  };
  const handler = createCompletionHandler({ verifyIdToken: async token => {
    const uid = Object.values(users).find(u => `tok-${u}` === token);
    if (!uid) throw new Error('invalid'); return { uid };
  }, domain });
  const raw = async (authorization, body) => {
    const started = performance.now();
    const r = await handler({ method: 'POST', authorization: authorization ?? undefined, rawBody: Buffer.from(JSON.stringify(body)) });
    return { status: r.status, body: structuredClone(r.body), ms: performance.now() - started,
      bytes: Buffer.byteLength(JSON.stringify(r.body)), bytesOut: Buffer.byteLength(JSON.stringify(body)) };
  };
  const ownerWrite = async (token, uid, path, value) => {
    if (token !== `tok-${uid}` || path.startsWith(RESOLUTIONS)) return 403; // generated rules deny direct resolution writes
    const room = get(uid) || {}, parts = path.split('/');
    let at = room;
    for (const part of parts.slice(0, -1)) at = at[part] ||= {};
    at[parts.at(-1)] = value; put(uid, room); return 200;
  };
  return {
    raw,
    missing: async () => ({ status: 404, body: null, ms: 1, bytes: 9 }),
    signIn: async user => ({ uid: users[user], idToken: `tok-${users[user]}` }),
    seed: async (uid, room) => put(uid, room),
    readRoom: async uid => get(uid),
    ownerWrite,
    // Offline stand-in for the cf43080 SDK replay: the same whole-plan owner write, twice. Cloud runs use old-client.mjs.
    oldClientReplay: async ({ uid }) => {
      const room = get(uid), [key, plan] = Object.entries(room.calendarPlans)[0];
      const items = plan.items.map(item => ({ ...item, updatedBy: 'released', task: `${item.task} (released-client edit)` }));
      const committed = [];
      for (let i = 0; i < 2; i++) committed.push(await ownerWrite(`tok-${uid}`, uid, `calendarPlans/${key}`, { ...plan, items, updatedAt: Date.now() }) === 200);
      return { kind: 'offline-simulation', committed };
    },
    sleep: ms => new Promise(done => setTimeout(done, Math.min(ms, 5))),
  };
}
const small = [{ name: 'tiny', tasks: 6, bytes: 65536, samples: 3, p95Ms: THRESHOLDS.sizes[0].p95Ms }];

test('synthetic rooms are unambiguous, currently unfinished and padded to the requested size', async () => {
  const { room, identities } = syntheticRoom({ nowMs: Date.now(), tasks: 4, padBytes: 300000, label: 'self' });
  assert.ok(Buffer.byteLength(JSON.stringify(room)) >= 300000);
  const s = offlineStaging(); await s.seed('stagingUserA', room);
  const { body } = await s.raw('Bearer tok-stagingUserA', { kind: 'inspect', identities });
  assert.deepEqual(body.views.map(v => v.state), ['unfinished', 'unfinished', 'unfinished', 'unfinished']);
});

test('harness: every scenario passes against the real handler; stops NO-GO on lost ack, 5xx and traffic cap', async () => {
  const report = await runScenarios(offlineStaging(), { sizes: small });
  assert.equal(report.apiGo, true, `${report.stoppedAt} ${JSON.stringify(report.results.filter(r => !r.pass))}`);
  assert.equal(report.stoppedAt, null);
  for (const name of ['auth:missing', 'single:authoritative-readback', 'earlier-date:receipt', 'earlier-date:original-plan-unchanged',
    'replay:same-operation', 'unknown:recover-same-uuid', 'compete:one-head', 'undo:exact-revision', 'undo:newer-source-refused',
    'isolation:cross-account', 'isolation:direct-write-denied', 'old-client:resolution-retained', 'old-client:honest-projection',
    'unavailable:down-no-fabricated-completion', 'unavailable:write-error-stays-unknown', 'unavailable:recovers-same-uuid',
    'concurrency:all-resolved-siblings-intact', 'heartbeat:explicit-contention', 'priority:refused', 'size:oversize-refused',
    'latency:single', 'latency:every-call-below-guard', 'http:no-429-5xx-nonjson']) {
    assert.ok(report.results.some(r => r.name === name && r.pass), name);
  }
  assert.ok(report.traffic.endpointRequests > 50 && report.traffic.endpointRequests <= LIMITS.maxEndpointRequests, String(report.traffic.endpointRequests));

  const broken = offlineStaging(), raw = broken.raw;
  broken.raw = async (header, body) => body.kind === 'status' ? { status: 200, body: { outcome: 'UNKNOWN' }, ms: 1 } : raw(header, body);
  const failed = await runScenarios(broken, { sizes: small });
  assert.equal(failed.apiGo, false); assert.equal(failed.stoppedAt, 'CHECK_FAILED: unknown:recover-same-uuid');

  const erroring = offlineStaging(), raw2 = erroring.raw;
  erroring.raw = async (header, body) => body.kind === 'mutate' ? { status: 503, body: null, ms: 1 } : raw2(header, body);
  const outage = await runScenarios(erroring, { sizes: small });
  assert.equal(outage.apiGo, false); assert.match(outage.stoppedAt, /ENDPOINT_HTTP: status 503 non-JSON on mutate/);

  const capped = await runScenarios(offlineStaging(), { sizes: small, limits: { ...LIMITS, maxEndpointRequests: 10 } });
  assert.equal(capped.apiGo, false); assert.match(capped.stoppedAt, /TRAFFIC_LIMIT/); assert.equal(capped.traffic.endpointRequests, 10);
});

test('log scan: full-text leak scan, one event per request, 401 reads nothing; never echoes a hit', () => {
  const event = extra => ({ jsonPayload: { component: 'chronasense-completion-api', event: 'completion-request', op: 'mutate', outcome: 'CONFIRMED', status: 200, ...extra } });
  const entries = [event(), event({ op: 'unparsed', outcome: 'REJECTED', status: 401, reason: 'UNAUTHENTICATED', reads: 0 })];
  const harness = { traffic: { endpointRequests: 2 } };
  assert.equal(scanLogs(entries, ['stagingUserA'], harness).ok, true);
  assert.equal(scanLogs(entries, [], { traffic: { endpointRequests: 3 } }).checks.oneEventPerRequest, false);
  assert.equal(scanLogs([...entries, { textPayload: 'stack at stagingUserA' }], ['stagingUserA'], harness).ok, false, 'textPayload scanned');
  const leaked = scanLogs([event({ reason: 'stagingUserA' })], ['stagingUserA']);
  assert.equal(leaked.ok, false); assert.equal(JSON.stringify(leaked).includes('stagingUserA'), false);
  assert.equal(scanLogs([event({ status: 401, reads: 1 })], []).checks.unauthenticatedReadNothing, false);
  assert.equal(scanLogs([], []).ok, false, 'no events is a failure, not a pass');
});
