// TASK-018 automated staging acceptance for the completion endpoint. Synthetic rooms, dedicated test users only.
// Scenario logic is transport-agnostic: `cloudTransport` talks to the guarded staging project; the self-test
// (staging.test.js) drives the same scenarios against the real handler in memory before any cloud run.
//   node staging/task-018/harness.mjs --config <staging-config.json> --report <out.json>
// Secrets come ONLY from env and are never written to the report:
//   STAGING_USER_A_EMAIL/_PASSWORD, STAGING_USER_B_EMAIL/_PASSWORD — dedicated synthetic staging users.
//   STAGING_SEED_ACCESS_TOKEN — the OPERATOR's short-lived Google OAuth token (`gcloud auth print-access-token`).
//     It is NOT project-bound (valid wherever the operator has access); the guard only ever sends it to the
//     staging RTDB host. Unset it immediately after the run.
//   Optional STAGING_FOREIGN_ID_TOKEN — a token from a NON-production, non-staging project. Never a production user's.
//   Optional STAGING_REVOKED_ID_TOKEN — from a THIRD user C whose sessions were revoked BEFORE the run.
// Every check stops the run on failure (integrity, isolation or threshold); the report is always written.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyBoundaryRevision, proposeBoundaryRevision } from '../../personal-day-boundary-model.js';
import { encodeRevisionForWire } from '../../personal-day-boundary-wire.js';
import { physicalTargetKey } from '../../plan-item-origin.js';
import { createTaskCompletionSync } from '../../task-completion-sync.js';
import { assertStagingConfig, guardedFetch } from './guard.mjs';

export const THRESHOLDS = JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8'));
// Hard traffic limits for one run (expected ≈ 120 endpoint requests, ≈ 27 MiB seeded).
export const LIMITS = Object.freeze({ maxEndpointRequests: 300, maxSeedBytes: 64 * 1024 * 1024, requestTimeoutMs: 20000 });
const DAY = 86400000, RESOLUTIONS = 'taskCompletionResolutions';
const utcDate = ms => new Date(ms).toISOString().slice(0, 10);
const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const percentile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const withoutResolutions = room => { const { [RESOLUTIONS]: _r, ...rest } = room || {}; return rest; };
export class StopRun extends Error {}

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
  return { room, identities, zone, date, targetId };
}

// Every endpoint call is counted, timed and status-checked; 429/5xx/non-JSON stops the run immediately.
function instrument(transport, limits) {
  const calls = [], traffic = { endpointRequests: 0, endpointBytesUp: 0, endpointBytesDown: 0, seedBytes: 0, adminReadBytes: 0 };
  const endpoint = async (authorization, body) => {
    if (traffic.endpointRequests >= limits.maxEndpointRequests) throw new StopRun('TRAFFIC_LIMIT: endpoint request cap reached');
    traffic.endpointRequests++;
    const r = await transport.raw(authorization, body);
    traffic.endpointBytesUp += r.bytesOut || 0; traffic.endpointBytesDown += r.bytes || 0;
    calls.push({ op: body?.kind, status: r.status, ms: r.ms, json: r.body !== null && typeof r.body === 'object' });
    if (r.status === 429 || r.status >= 500 || r.body === null || typeof r.body !== 'object') {
      throw new StopRun(`ENDPOINT_HTTP: status ${r.status}${r.body === null ? ' non-JSON' : ''} on ${body?.kind}`);
    }
    return r;
  };
  return { calls, traffic, raw: endpoint, call: (token, body) => endpoint(`Bearer ${token}`, body),
    async seed(uid, room) {
      const bytes = Buffer.byteLength(JSON.stringify(room));
      if (traffic.seedBytes + bytes > limits.maxSeedBytes) throw new StopRun('TRAFFIC_LIMIT: seed byte cap reached');
      traffic.seedBytes += bytes; return transport.seed(uid, room);
    },
    async readRoom(uid) { const room = await transport.readRoom(uid); traffic.adminReadBytes += Buffer.byteLength(JSON.stringify(room ?? null)); return room; } };
}

function client(io, token) {
  const call = body => io.call(token, body);
  return {
    call,
    async request(identity, kind, extra = {}) {
      const { body } = await call({ kind: 'inspect', identities: [identity] });
      const view = body?.views?.[0];
      if (!view?.sourceRevision) return { identity, operationId: randomUUID(), expectedRevision: 0, expectedSourceRevision: 'x'.repeat(43), kind: 'complete', ...extra };
      const base = { identity, operationId: randomUUID(), expectedRevision: view.record?.revision || 0, expectedSourceRevision: view.sourceRevision };
      return kind === 'undo' ? { ...base, kind, undoOf: view.record?.completionOpId, ...extra } : { ...base, kind, ...extra };
    },
    async view(identity) { return (await call({ kind: 'inspect', identities: [identity] })).body?.views?.[0]; },
    mutate(request, uncertain = false) { return call({ kind: 'mutate', request, uncertain }); },
    status(request) { return call({ kind: 'status', request }); },
  };
}

/** Runs every scenario, stopping at the first failed check. `apiGo` is true only if all ran and passed. */
export async function runScenarios(transport, { nowMs = Date.now(), sizes = THRESHOLDS.sizes, label = randomUUID().slice(0, 8), optional = {}, limits = LIMITS } = {}) {
  const t = THRESHOLDS, results = [], latencies = { single: [], sizes: {} }, io = instrument(transport, limits);
  const report = { label, apiGo: false, stoppedAt: null, results, latencies, traffic: io.traffic, limits,
    manualGatesPending: ['cold-start', 'RTDB downloaded bytes and amplification (Cloud Monitoring)', 'billing cost',
      'log scan: one event per request, zero forbidden strings', 'browser isolation route log'] };
  const check = (name, pass, details = {}) => {
    results.push({ name, pass: Boolean(pass), ...details });
    if (!pass) throw new StopRun(`CHECK_FAILED: ${name}`);
  };
  try {
    const A = await transport.signIn('A'), B = await transport.signIn('B');
    const a = client(io, A.idToken), b = client(io, B.idToken), today = utcDate(nowMs);
    let worlds = 0;
    const seed = async (tasks, padBytes = 0, mutate = room => room) => {
      const world = syntheticRoom({ nowMs, tasks, padBytes, label: `${label}w${worlds++}` });
      await io.seed(A.uid, mutate(world.room));
      return world;
    };
    const complete = async (identity, zone, date = today) => a.mutate(await a.request(identity, 'complete', { date, timezone: zone }));

    // AUTH: refusals happen before any privileged access (server event reads=0 is verified in the log scan).
    const bad = [['missing', null], ['malformed', 'Bearer'], ['garbage', 'Bearer not.a.jwt'],
      ...(optional.foreignToken ? [['wrong-project', `Bearer ${optional.foreignToken}`]] : []),
      ...(optional.revokedToken ? [['revoked', `Bearer ${optional.revokedToken}`]] : [])];
    for (const [kind, header] of bad) {
      const r = await io.raw(header, { kind: 'inspect', identities: [] });
      check(`auth:${kind}`, r.status === 401 && r.body?.reason === 'UNAUTHENTICATED', { status: r.status });
    }

    // SINGLE: latency + authoritative readback, earlier date, replay, lost acknowledgement, competing intents.
    let w = await seed(t.single.tasks);
    const planBefore = hash((await io.readRoom(A.uid)).calendarPlans);
    for (const identity of w.identities.slice(0, t.single.samples)) {
      const r = await complete(identity, w.zone);
      latencies.single.push(r.ms);
      check('single:complete-confirmed', r.body?.outcome === 'CONFIRMED' && r.body.receipt?.date === today, { reason: r.body?.reason });
    }
    const roomAfterSingle = await io.readRoom(A.uid), stored = Object.values(roomAfterSingle[RESOLUTIONS] || {});
    check('single:authoritative-readback', stored.length === t.single.samples && stored.every(rec => rec.state === 'completed'), { stored: stored.length });
    const [earlier, first, second, third] = w.identities.slice(t.single.samples);
    const earlierDate = utcDate(nowMs - 2 * DAY), e = await complete(earlier, w.zone, earlierDate);
    check('earlier-date:receipt', e.body?.outcome === 'CONFIRMED' && e.body.receipt?.date === earlierDate && e.body.receipt?.timezone === w.zone, { reason: e.body?.reason });
    check('earlier-date:original-plan-unchanged', hash((await io.readRoom(A.uid)).calendarPlans) === planBefore);
    const req = await a.request(first, 'complete', { date: today, timezone: w.zone });
    const r1 = await a.mutate(req), r2 = await a.mutate(req);
    check('replay:same-operation', r1.body?.outcome === 'CONFIRMED' && r2.body?.outcome === 'CONFIRMED' && hash(r1.body.receipt) === hash(r2.body.receipt));
    const lost = await a.request(second, 'complete', { date: today, timezone: w.zone });
    await a.mutate(lost); // response deliberately discarded: client recovers with the SAME operation
    const st = await a.status(lost), again = await a.mutate(lost, true);
    check('unknown:recover-same-uuid', st.body?.outcome === 'CONFIRMED' && again.body?.outcome === 'CONFIRMED'
      && Object.hasOwn(again.body.record.operations, lost.operationId));
    const base = await a.request(third, 'complete', { date: today, timezone: w.zone });
    const competing = await Promise.all([a.mutate(base), a.mutate({ ...base, operationId: randomUUID(), date: earlierDate })]);
    const outcomes = competing.map(r => r.body?.outcome).sort(), loser = competing.find(r => r.body?.outcome === 'REJECTED');
    check('compete:one-head', outcomes.join() === 'CONFIRMED,REJECTED' && loser?.body.reason === 'STALE_RESOLUTION', { outcomes, reason: loser?.body.reason });

    // UNDO: exact revision succeeds; a newer source refuses Undo without overwrite.
    const undoOk = await a.mutate(await a.request(first, 'undo'));
    check('undo:exact-revision', undoOk.body?.outcome === 'CONFIRMED' && undoOk.body.record.state === 'open');
    const beforeEdit = await io.readRoom(A.uid), undoReq = await a.request(second, 'undo');
    const edited = structuredClone(beforeEdit), plan = Object.values(edited.calendarPlans)[0];
    plan.items.find(item => item.id === second.itemId).task += ' (edited elsewhere)';
    await io.seed(A.uid, edited);
    const undoStale = await a.mutate(undoReq), afterUndo = await io.readRoom(A.uid);
    check('undo:newer-source-refused', undoStale.body?.outcome === 'REJECTED' && ['STALE_SOURCE', 'UNDO_CONFLICT'].includes(undoStale.body.reason)
      && hash(afterUndo[RESOLUTIONS]) === hash(edited[RESOLUTIONS]), { reason: undoStale.body?.reason });

    // ISOLATION: B cannot touch A; rules deny direct client writes to resolutions.
    const aBefore = hash(await io.readRoom(A.uid));
    const cross = await b.mutate(await a.request(w.identities.at(-1), 'complete', { date: today, timezone: w.zone }));
    check('isolation:cross-account', cross.body?.outcome === 'REJECTED' && ['MISSING_ROOM', 'SOURCE_MISSING', 'STALE_SOURCE'].includes(cross.body.reason)
      && hash(await io.readRoom(A.uid)) === aBefore, { reason: cross.body?.reason });
    const direct = await transport.ownerWrite(A.idToken, A.uid, `${RESOLUTIONS}/r1_${'x'.repeat(43)}`, { state: 'completed' });
    check('isolation:direct-write-denied', [401, 403].includes(direct), { status: direct });
    check('isolation:no-resolution-written', hash(await io.readRoom(A.uid)) === aBefore);

    // RELEASED CLIENT: cf43080 plan bridge hydrates and pushes an edit twice; the resolution record is retained.
    const resolutionsBefore = hash((await io.readRoom(A.uid))[RESOLUTIONS]), kept = w.identities[0];
    const replay = await transport.oldClientReplay({ uid: A.uid, date: w.date, targetId: w.targetId });
    const afterReplay = await io.readRoom(A.uid), editedItem = Object.values(afterReplay.calendarPlans)[0].items.find(item => item.id === kept.itemId);
    check('old-client:pushes-committed', replay.committed.length === 2 && replay.committed.every(Boolean) && /released-client edit/.test(editedItem?.task || ''), { kind: replay.kind });
    check('old-client:resolution-retained', hash(afterReplay[RESOLUTIONS]) === resolutionsBefore);
    const projected = await a.view(kept);
    check('old-client:honest-projection', ['completed', 'needs-review'].includes(projected?.state), { state: projected?.state });

    // BACKEND UNAVAILABLE: the real client module never fabricates completion and recovers with the same UUID.
    w = await seed(2);
    const room = await io.readRoom(A.uid), item = Object.values(room.calendarPlans)[0].items[0];
    const entry = { target: { store: 'calendar', id: w.targetId }, item };
    let down = null; // 'all' = backend unreachable; 'mutate' = only the write call fails (lost/errored response)
    const fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body), fail = down === 'all' || (down === 'mutate' && body.kind === 'mutate');
      const r = fail ? await transport.missing(options.headers.authorization, body) : await io.raw(options.headers.authorization, body);
      return { json: async () => { if (r.body === null || typeof r.body !== 'object') throw new SyntaxError('non-JSON'); return r.body; } };
    };
    const data = new Map(), storage = { get length() { return data.size; }, key: n => [...data.keys()][n], getItem: k => data.get(k) ?? null,
      setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
    const roomRef = { child: () => ({ on: () => {}, off: () => {} }) };
    const context = () => ({ uid: A.uid, roomRef, timezone: w.zone, endpoint: 'harness://completion', getIdToken: async () => A.idToken });
    const sync = createTaskCompletionSync({ context, storage, fetchImpl });
    sync.ensure([entry]); await sync.refresh();
    check('unavailable:client-ready', sync.view(entry)?.state === 'unfinished');
    const missing = await transport.missing(`Bearer ${A.idToken}`, { kind: 'inspect', identities: [] });
    check('unavailable:error-is-not-json-success', missing.status >= 400 && missing.body?.outcome !== 'CONFIRMED', { status: missing.status });
    down = 'all';
    const unreachable = await sync.complete(entry, today, w.zone);
    check('unavailable:down-no-fabricated-completion', unreachable.outcome !== 'CONFIRMED'
      && (await io.readRoom(A.uid))[RESOLUTIONS] === undefined, { outcome: unreachable.outcome, reason: unreachable.reason });
    down = 'mutate';
    const offline = await sync.complete(entry, today, w.zone);
    const staged = sync.pendingAll();
    check('unavailable:write-error-stays-unknown', offline.outcome === 'UNKNOWN' && staged.length === 1
      && (await io.readRoom(A.uid))[RESOLUTIONS] === undefined, { outcome: offline.outcome, reason: offline.reason });
    down = null;
    const recovered = await sync.resume(staged[0]);
    check('unavailable:recovers-same-uuid', recovered.outcome === 'CONFIRMED' && recovered.receipt && Object.hasOwn(recovered.record.operations, staged[0].operationId)
      && sync.pendingAll().length === 0, { outcome: recovered.outcome });

    // CONCURRENCY: K simultaneous completions on distinct tasks. Server is concurrency 1 / maxInstances 1, so
    // requests queue; this proves queuing without 429/UNKNOWN, while HEARTBEAT below is the real CAS contention.
    w = await seed(t.concurrency.tasks);
    const pre = withoutResolutions(await io.readRoom(A.uid));
    let pending = w.identities.slice(0, t.concurrency.parallel), rounds = 0;
    while (pending.length && rounds++ < t.concurrency.maxRounds) {
      const batch = await Promise.all(pending.map(async identity => [identity, await complete(identity, w.zone)]));
      check('concurrency:no-unknown', batch.every(([, r]) => ['CONFIRMED', 'REJECTED'].includes(r.body?.outcome)
        && (r.body.outcome === 'CONFIRMED' || ['CONTENDED', 'STALE_SOURCE', 'STALE_RESOLUTION'].includes(r.body.reason))), { round: rounds });
      pending = batch.filter(([, r]) => r.body?.outcome !== 'CONFIRMED').map(([identity]) => identity);
    }
    check('concurrency:all-resolved-siblings-intact', pending.length === 0 && hash(withoutResolutions(await io.readRoom(A.uid))) === hash(pre), { rounds });

    // HEARTBEAT: owner sibling writes during completions; contention is explicit, never silent loss.
    w = await seed(t.heartbeat.tasks);
    let beats = 0, beating = true, beatFailures = 0;
    const heart = (async () => {
      while (beating && beats < 200) {
        if (await transport.ownerWrite(A.idToken, A.uid, 'timer', { running: false, beat: beats + 1 }) === 200) beats++; else beatFailures++;
        if (beatFailures > 3) return;
        await transport.sleep(t.heartbeat.intervalMs);
      }
    })();
    const hb = [];
    try { for (const identity of w.identities) hb.push((await complete(identity, w.zone)).body); } finally { beating = false; await heart; }
    const finalRoom = await io.readRoom(A.uid), confirmed = hb.filter(x => x?.outcome === 'CONFIRMED').length;
    check('heartbeat:explicit-contention', beatFailures <= 3 && beats > 0 && hb.every(x => x?.outcome === 'CONFIRMED' || x?.reason === 'CONTENDED')
      && finalRoom.timer?.beat === beats && confirmed / hb.length >= t.heartbeat.minConfirmedRatio,
      { confirmed, total: hb.length, beats, contended: hb.filter(x => x?.reason === 'CONTENDED').length });

    // PRIORITY: unsupported export metadata is refused, nothing written.
    w = await seed(2, 0, r => ({ ...r, settings: { ...r.settings, '.priority': 1 } }));
    const pr = await a.call({ kind: 'mutate', request: { identity: w.identities[0], operationId: randomUUID(), expectedRevision: 0,
      expectedSourceRevision: 'x'.repeat(43), kind: 'complete', date: today, timezone: w.zone }, uncertain: false });
    check('priority:refused', pr.body?.outcome === 'REJECTED' && pr.body.reason === 'PRIORITY_UNSUPPORTED'
      && (await io.readRoom(A.uid))[RESOLUTIONS] === undefined, { reason: pr.body?.reason });

    // SIZES: representative accounts, plus refusal just above the 16 MiB bound (never relaxed).
    for (const { name, tasks, bytes, samples, p95Ms } of sizes) {
      w = await seed(tasks, bytes);
      const ms = [];
      for (const identity of w.identities.slice(0, samples)) {
        const r = await complete(identity, w.zone);
        ms.push(r.ms); check(`size:${name}:complete`, r.body?.outcome === 'CONFIRMED', { reason: r.body?.reason });
      }
      latencies.sizes[name] = ms;
      check(`size:${name}:p95`, ms.length === samples && percentile(ms, 0.95) <= p95Ms, { p95: percentile(ms, 0.95), limit: p95Ms });
    }
    w = await seed(2, t.oversize.bytes);
    const big = await a.call({ kind: 'mutate', request: { identity: w.identities[0], operationId: randomUUID(), expectedRevision: 0,
      expectedSourceRevision: 'x'.repeat(43), kind: 'complete', date: today, timezone: w.zone }, uncertain: false });
    check('size:oversize-refused', big.body?.outcome === 'REJECTED' && big.body?.reason === 'ROOM_TOO_LARGE'
      && (await io.readRoom(A.uid))[RESOLUTIONS] === undefined, { reason: big.body?.reason });

    const s = latencies.single;
    check('latency:single', s.length === t.single.samples && percentile(s, 0.5) <= t.single.p50Ms && percentile(s, 0.95) <= t.single.p95Ms && Math.max(...s) <= t.single.maxMs,
      { p50: percentile(s, 0.5), p95: percentile(s, 0.95), max: Math.max(...s) });
    const all = io.calls.map(c => c.ms);
    check('latency:every-call-below-guard', all.length > 0 && all.every(ms => ms < t.clientTimeoutGuardMs), { calls: all.length, max: Math.max(...all) });
    check('http:no-429-5xx-nonjson', io.calls.every(c => c.json && c.status !== 429 && c.status < 500), { calls: io.calls.length });
    report.apiGo = true;
  } catch (error) {
    report.stoppedAt = error instanceof StopRun ? error.message : `ERROR: ${String(error?.message || error).slice(0, 200)}`;
  }
  report.endpointLatency = summarize(io.calls.map(c => c.ms));
  return report;
}
function summarize(ms) { return ms.length ? { n: ms.length, p50: percentile(ms, 0.5), p95: percentile(ms, 0.95), max: Math.max(...ms) } : { n: 0 }; }

/** Real staging transport. Every request passes the production guard; no secret is ever written to the report. */
export function cloudTransport(config, env = process.env, fetchImpl = fetch) {
  const { endpoint } = assertStagingConfig(config), gfetch = guardedFetch(config, fetchImpl);
  const db = config.databaseURL.replace(/\/$/, '');
  const need = name => env[name] || (() => { throw new Error(`${name} is required`); })();
  const timed = async (url, options = {}) => {
    const started = performance.now();
    const response = await gfetch(url, { ...options, signal: AbortSignal.timeout(LIMITS.requestTimeoutMs) }), text = await response.text();
    let body = null; try { body = JSON.parse(text); } catch { /* non-JSON is part of the evidence */ }
    return { status: response.status, body, ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(text),
      bytesOut: typeof options.body === 'string' ? Buffer.byteLength(options.body) : 0 };
  };
  const post = url => (authorization, body) => timed(url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) });
  const admin = () => ({ authorization: `Bearer ${need('STAGING_SEED_ACCESS_TOKEN')}` });
  return {
    raw: post(endpoint),
    missing: post(`${endpoint}Unavailable`), // same staging host; no such function is deployed
    async signIn(user) {
      const r = await timed(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`,
        { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: need(`STAGING_USER_${user}_EMAIL`), password: need(`STAGING_USER_${user}_PASSWORD`), returnSecureToken: true }) });
      if (r.status !== 200) throw new Error(`staging sign-in failed for user ${user} (${r.status})`);
      return { uid: r.body.localId, idToken: r.body.idToken };
    },
    async seed(uid, room) {
      const r = await timed(`${db}/rooms/uid_${uid}.json`, { method: 'PUT', headers: admin(), body: JSON.stringify(room) });
      if (r.status !== 200) throw new Error(`staging seed failed (${r.status})`);
    },
    async readRoom(uid) {
      const r = await timed(`${db}/rooms/uid_${uid}.json?format=export`, { headers: admin() });
      if (r.status !== 200) throw new Error(`staging admin read failed (${r.status})`);
      return r.body;
    },
    async ownerWrite(idToken, uid, path, value) {
      return (await timed(`${db}/rooms/uid_${uid}/${path}.json?auth=${encodeURIComponent(idToken)}`, { method: 'PUT', body: JSON.stringify(value) })).status;
    },
    async oldClientReplay(args) {
      const { releasedClientReplay } = await import('./old-client.mjs');
      return releasedClientReplay(config, { ...args, email: need('STAGING_USER_A_EMAIL'), password: need('STAGING_USER_A_PASSWORD') });
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
  const passed = report.results.filter(r => r.pass).length;
  console.log(report.apiGo ? `API checks GO (${passed}/${report.results.length}); manual gates pending: ${report.manualGatesPending.join('; ')}`
    : `NO-GO: stopped at ${report.stoppedAt} after ${passed} passing checks`);
  process.exitCode = report.apiGo ? 0 : 1;
}
