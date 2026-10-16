// TASK-018 automated staging acceptance for the completion endpoint. Synthetic rooms, dedicated test users only.
// Scenario logic is transport-agnostic: `cloudTransport` talks to the guarded staging project; the self-test
// (staging.test.js) drives the same scenarios against the real handler in memory before any cloud run.
//   node staging/task-018/harness.mjs --config <staging-config.json> --report <out.json>
// Secrets come ONLY from env: STAGING_USER_A_EMAIL/_PASSWORD, STAGING_USER_B_EMAIL/_PASSWORD,
// STAGING_SEED_ACCESS_TOKEN (operator `gcloud auth print-access-token` for the STAGING project, short-lived).
// Optional: STAGING_FOREIGN_ID_TOKEN (valid token from another project), STAGING_REVOKED_ID_TOKEN.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyBoundaryRevision, proposeBoundaryRevision } from '../../personal-day-boundary-model.js';
import { encodeRevisionForWire } from '../../personal-day-boundary-wire.js';
import { physicalTargetKey } from '../../plan-item-origin.js';
import { assertStagingConfig, guardedFetch } from './guard.mjs';

export const THRESHOLDS = JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8'));
const DAY = 86400000, RESOLUTIONS = 'taskCompletionResolutions';
const utcDate = ms => new Date(ms).toISOString().slice(0, 10);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const percentile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0; };
const withoutResolutions = room => { const { [RESOLUTIONS]: _r, ...rest } = room || {}; return rest; };

/** Synthetic room: N unambiguous tasks on an ended calendar date, optionally padded with synthetic entries. */
export function syntheticRoom({ nowMs, tasks, padBytes = 0, label }) {
  const zone = 'Etc/UTC', date = utcDate(nowMs - 3 * DAY), targetId = `cal1:${date}`;
  const history = proposeBoundaryRevision([legacyBoundaryRevision(zone)],
    { id: `boundary-${label}`, boundaryTime: '18:00', timezone: zone }, nowMs - 45 * DAY).revisions;
  const fact = { schemaVersion: 1, id: `ca1-${label}`, activatedAtMs: nowMs - 14 * DAY, activationDate: utcDate(nowMs - 14 * DAY), timezone: zone, deviceId: 'staging-harness' };
  const items = Array.from({ length: tasks }, (_, i) => ({ id: `stg-${label}-${i}`, task: `Synthetic staging task ${i}`, done: false, when: '', updatedAt: 100, updatedBy: 'staging-harness' }));
  const room = { settings: { timezone: zone }, calendarPlanAuthority: { [fact.id]: fact },
    dayBoundaryRevisions: Object.fromEntries(history.map(revision => [revision.id, encodeRevisionForWire(revision)])),
    calendarPlans: { [physicalTargetKey('calendar', targetId)]: { createdAt: 1, timezone: zone, updatedAt: 100, items } },
    entries: {}, timer: { running: false } };
  // Grow by measured per-entry size (linear), not by re-serializing the whole room each time.
  for (let i = 0, size = Buffer.byteLength(JSON.stringify(room)); size < padBytes; i++) {
    const key = `stg${i}`, entry = { id: i + 1, task: `Synthetic entry ${i} ${'x'.repeat(400)}`, duration: 15, start: nowMs - DAY, end: nowMs - DAY + 900000, track: 'synthetic' };
    room.entries[key] = entry;
    size += Buffer.byteLength(JSON.stringify({ [key]: entry })) - 1; // ≈ one `,"key":{...}` member
  }
  const identities = items.map(item => ({ store: 'calendar', targetId, itemId: item.id, representation: 'array', origin: 'unmarked' }));
  return { room, identities, zone };
}

function client(transport, token) {
  const call = async body => transport.call(token, body);
  return {
    call,
    async inspect(identities) { return call({ kind: 'inspect', identities }); },
    async request(identity, kind, extra = {}) {
      const { body } = await call({ kind: 'inspect', identities: [identity] });
      const view = body?.views?.[0];
      if (!view?.sourceRevision) return { identity, operationId: randomUUID(), expectedRevision: 0, expectedSourceRevision: 'x'.repeat(43), kind: 'complete', ...extra };
      const base = { identity, operationId: randomUUID(), expectedRevision: view.record?.revision || 0, expectedSourceRevision: view.sourceRevision };
      return kind === 'undo' ? { ...base, kind, undoOf: view.record?.completionOpId, ...extra } : { ...base, kind, ...extra };
    },
    mutate(request, uncertain = false) { return call({ kind: 'mutate', request, uncertain }); },
    status(request) { return call({ kind: 'status', request }); },
  };
}

/** Runs every scenario; returns a report whose `go` is true only if every threshold passes. */
export async function runScenarios(transport, { nowMs = Date.now(), sizes = THRESHOLDS.sizes, label = randomUUID().slice(0, 8), optional = {} } = {}) {
  const t = THRESHOLDS, results = [], latencies = { single: [], sizes: {} };
  const check = (name, pass, details = {}) => { results.push({ name, pass: Boolean(pass), ...details }); return pass; };
  const A = await transport.signIn('A'), B = await transport.signIn('B');
  const a = client(transport, A.idToken), b = client(transport, B.idToken), today = utcDate(nowMs);
  const seed = async (tasks, padBytes = 0) => {
    const world = syntheticRoom({ nowMs, tasks, padBytes, label: `${label}${results.length}` });
    await transport.seed(A.uid, world.room);
    return world;
  };

  // AUTH: refusals happen before any privileged access (server event reads=0 is verified in the log scan).
  const bad = [['missing', null], ['malformed', 'Bearer'], ['garbage', 'Bearer not.a.jwt'],
    ...(optional.foreignToken ? [['wrong-project', `Bearer ${optional.foreignToken}`]] : []),
    ...(optional.revokedToken ? [['revoked', `Bearer ${optional.revokedToken}`]] : [])];
  for (const [kind, header] of bad) {
    const r = await transport.raw(header, { kind: 'inspect', identities: [] });
    check(`auth:${kind}`, r.status === 401 && r.body?.reason === 'UNAUTHENTICATED', { status: r.status });
  }

  // SINGLE: latency, replay, lost acknowledgement recovery, competing intents.
  let w = await seed(t.single.tasks);
  for (const identity of w.identities.slice(0, t.single.samples)) {
    const r = await a.mutate(await a.request(identity, 'complete', { date: today, timezone: w.zone }));
    latencies.single.push(r.ms);
    if (!check('single:complete', r.body?.outcome === 'CONFIRMED', { reason: r.body?.reason })) break;
  }
  const [first, second, third] = w.identities.slice(t.single.samples);
  const req = await a.request(first, 'complete', { date: today, timezone: w.zone });
  const r1 = await a.mutate(req), r2 = await a.mutate(req);
  check('replay:same-operation', r1.body?.outcome === 'CONFIRMED' && r2.body?.outcome === 'CONFIRMED' && hash(r1.body.receipt) === hash(r2.body.receipt));
  const lost = await a.request(second, 'complete', { date: today, timezone: w.zone });
  await a.mutate(lost); // response deliberately discarded: client recovers with the SAME operation
  const st = await a.status(lost), again = await a.mutate(lost, true);
  check('unknown:recover-same-uuid', st.body?.outcome === 'CONFIRMED' && again.body?.outcome === 'CONFIRMED');
  const base = await a.request(third, 'complete', { date: today, timezone: w.zone });
  const competing = await Promise.all([a.mutate(base), a.mutate({ ...base, operationId: randomUUID(), date: utcDate(nowMs - DAY) })]);
  const outcomes = competing.map(r => r.body?.outcome).sort();
  check('compete:one-head', outcomes.join() === 'CONFIRMED,REJECTED', { outcomes, reasons: competing.map(r => r.body?.reason) });

  // UNDO: exact revision succeeds; a newer source refuses Undo without overwrite.
  const undoOk = await a.mutate(await a.request(first, 'undo'));
  check('undo:exact-revision', undoOk.body?.outcome === 'CONFIRMED' && undoOk.body.record.state === 'open');
  const before = await transport.readRoom(A.uid), undoReq = await a.request(second, 'undo');
  const edited = structuredClone(before), plan = Object.values(edited.calendarPlans)[0];
  plan.items.find(item => item.id === second.itemId).task += ' (edited elsewhere)';
  await transport.seed(A.uid, edited);
  const undoStale = await a.mutate(undoReq), afterUndo = await transport.readRoom(A.uid);
  check('undo:newer-source-refused', undoStale.body?.outcome === 'REJECTED'
    && hash(afterUndo[RESOLUTIONS]) === hash(edited[RESOLUTIONS]), { reason: undoStale.body?.reason });

  // ISOLATION: B cannot touch A; direct client writes to resolutions are denied by rules.
  const aBefore = hash(await transport.readRoom(A.uid));
  const cross = await b.mutate(await a.request(w.identities.at(-1), 'complete', { date: today, timezone: w.zone }));
  check('isolation:cross-account', cross.body?.outcome === 'REJECTED' && hash(await transport.readRoom(A.uid)) === aBefore, { reason: cross.body?.reason });
  check('isolation:direct-write-denied', !(await transport.ownerWrite(A.idToken, A.uid, `${RESOLUTIONS}/r1_${'x'.repeat(43)}`, { state: 'completed' })));

  // CONCURRENCY: K simultaneous completions on distinct tasks; no UNKNOWN, siblings intact, all resolvable.
  w = await seed(t.concurrency.tasks);
  const pre = withoutResolutions(await transport.readRoom(A.uid));
  let pending = w.identities.slice(0, t.concurrency.parallel), rounds = 0, unknown = 0;
  while (pending.length && rounds++ < t.concurrency.maxRounds) {
    const batch = await Promise.all(pending.map(async identity => [identity, await a.mutate(await a.request(identity, 'complete', { date: today, timezone: w.zone }))]));
    unknown += batch.filter(([, r]) => r.body?.outcome === 'UNKNOWN').length;
    pending = batch.filter(([, r]) => r.body?.outcome !== 'CONFIRMED').map(([identity]) => identity);
  }
  const post = await transport.readRoom(A.uid);
  check('concurrency:all-resolved', pending.length === 0 && unknown === 0 && hash(withoutResolutions(post)) === hash(pre), { rounds, unknown });

  // HEARTBEAT: owner sibling writes during completions; contention is explicit, never silent loss.
  w = await seed(t.heartbeat.tasks);
  let beats = 0, beating = true;
  const heart = (async () => { while (beating) { await transport.ownerWrite(A.idToken, A.uid, 'timer', { running: false, beat: ++beats }); await transport.sleep(t.heartbeat.intervalMs); } })();
  const hb = [];
  for (const identity of w.identities) hb.push((await a.mutate(await a.request(identity, 'complete', { date: today, timezone: w.zone }))).body);
  beating = false; await heart;
  const finalRoom = await transport.readRoom(A.uid), confirmed = hb.filter(x => x?.outcome === 'CONFIRMED').length;
  check('heartbeat:explicit-contention', hb.every(x => x?.outcome !== 'UNKNOWN') && finalRoom.timer?.beat === beats
    && confirmed / hb.length >= t.heartbeat.minConfirmedRatio, { confirmed, total: hb.length, contended: hb.filter(x => x?.reason === 'CONTENDED').length });

  // SIZES: representative accounts, plus refusal just above the 16 MiB bound (never relaxed).
  for (const { name, tasks, bytes, samples, p95Ms } of sizes) {
    w = await seed(tasks, bytes);
    const ms = [];
    for (const identity of w.identities.slice(0, samples)) {
      const r = await a.mutate(await a.request(identity, 'complete', { date: today, timezone: w.zone }));
      ms.push(r.ms); check(`size:${name}:complete`, r.body?.outcome === 'CONFIRMED', { reason: r.body?.reason });
    }
    latencies.sizes[name] = ms;
    check(`size:${name}:p95`, percentile(ms, 0.95) <= p95Ms, { p95: percentile(ms, 0.95), limit: p95Ms });
  }
  w = await seed(2, t.oversize.bytes);
  const big = await a.call({ kind: 'mutate', request: { identity: w.identities[0], operationId: randomUUID(), expectedRevision: 0,
    expectedSourceRevision: 'x'.repeat(43), kind: 'complete', date: today, timezone: w.zone }, uncertain: false });
  check('size:oversize-refused', big.body?.outcome === 'REJECTED' && big.body?.reason === 'ROOM_TOO_LARGE'
    && (await transport.readRoom(A.uid))[RESOLUTIONS] === undefined, { reason: big.body?.reason });

  const s = latencies.single;
  check('latency:single', percentile(s, 0.5) <= t.single.p50Ms && percentile(s, 0.95) <= t.single.p95Ms && Math.max(...s) <= t.single.maxMs,
    { p50: percentile(s, 0.5), p95: percentile(s, 0.95), max: Math.max(...s) });
  const all = [...s, ...Object.values(latencies.sizes).flat()];
  check('latency:no-near-timeout', all.every(ms => ms < t.clientTimeoutGuardMs), { max: Math.max(...all) });
  return { label, go: results.every(r => r.pass), results, latencies };
}

/** Real staging transport. Every request passes the production guard; no secret is ever written to the report. */
export function cloudTransport(config, env = process.env, fetchImpl = fetch) {
  const { endpoint } = assertStagingConfig(config), gfetch = guardedFetch(config, fetchImpl);
  const db = config.databaseURL.replace(/\/$/, '');
  const need = name => env[name] || (() => { throw new Error(`${name} is required`); })();
  const timed = async (url, options) => {
    const started = performance.now(), response = await gfetch(url, options), text = await response.text();
    let body = null; try { body = JSON.parse(text); } catch { /* non-JSON is part of the evidence */ }
    return { status: response.status, body, ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(text) };
  };
  const raw = (authorization, body) => timed(endpoint, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) });
  const admin = { authorization: `Bearer ${need('STAGING_SEED_ACCESS_TOKEN')}` };
  return {
    raw,
    call: (token, body) => raw(`Bearer ${token}`, body),
    async signIn(user) {
      const r = await timed(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`,
        { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: need(`STAGING_USER_${user}_EMAIL`), password: need(`STAGING_USER_${user}_PASSWORD`), returnSecureToken: true }) });
      if (r.status !== 200) throw new Error(`staging sign-in failed for user ${user} (${r.status})`);
      return { uid: r.body.localId, idToken: r.body.idToken };
    },
    async seed(uid, room) {
      const r = await timed(`${db}/rooms/uid_${uid}.json`, { method: 'PUT', headers: admin, body: JSON.stringify(room) });
      if (r.status !== 200) throw new Error(`staging seed failed (${r.status})`);
    },
    async readRoom(uid) { return (await timed(`${db}/rooms/uid_${uid}.json`, { headers: admin })).body; },
    async ownerWrite(idToken, uid, path, value) {
      return (await timed(`${db}/rooms/uid_${uid}/${path}.json?auth=${encodeURIComponent(idToken)}`, { method: 'PUT', body: JSON.stringify(value) })).status === 200;
    },
    sleep: ms => new Promise(done => setTimeout(done, ms)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  const config = JSON.parse(readFileSync(arg('--config'), 'utf8'));
  const report = await runScenarios(cloudTransport(config), { optional: {
    foreignToken: process.env.STAGING_FOREIGN_ID_TOKEN, revokedToken: process.env.STAGING_REVOKED_ID_TOKEN } });
  writeFileSync(arg('--report'), JSON.stringify({ projectId: config.projectId, at: new Date().toISOString(), thresholds: THRESHOLDS, ...report }, null, 2));
  console.log(`${report.go ? 'GO' : 'NO-GO'}: ${report.results.filter(r => r.pass).length}/${report.results.length} checks passed`);
  process.exitCode = report.go ? 0 : 1;
}
