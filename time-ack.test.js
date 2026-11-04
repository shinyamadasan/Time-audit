// time-ack.test.js — TASK-039 acknowledged Undo lifecycle against the REAL RTDB emulator.
// Historical time-ack.js engine + REST transport, frozen73739e9 canonical rules and the
// test-only gated entry+timer variant, both accounts, and the unchanged Undo/timer functions
// extracted from index.html/storage.js. Needs Java + the cached emulator jar (fails, never skips).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { startEmulator, token } from './rtdb-emulator-support.js';
import { accountingRules } from './time-ack-proof/lifecycle.js';

await import('./time-ack.js'); // classic script: attaches TimeAckCore to globalThis
if (process.env.CHRONASENSE_TIME_ACK_FIXTURE) {
  const fixture = new URL(process.env.CHRONASENSE_TIME_ACK_FIXTURE, import.meta.url);
  assert.ok(fixture.href.startsWith(new URL('./test-results/', import.meta.url).href), 'fixture stays in local test-results');
  vm.runInThisContext(fs.readFileSync(fixture, 'utf8'), { filename: fixture.pathname });
}
const core = globalThis.TimeAckCore;
const canonicalRules = fs.readFileSync(new URL('./firebase.rules.json', import.meta.url), 'utf8');
// The old engine is quarantined by the app. Its historical lifecycle remains a regression fixture;
// separate tests below prove its original unstaged bytes are refused by the current strict rules.
const historicalRules = fs.readFileSync(new URL('./accounting-hazards/legacy-rules-73739e9.json', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const storageSource = fs.readFileSync(new URL('./storage.js', import.meta.url), 'utf8');
const extract = (source, name) => {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `actual ${name} required`);
  return match[0];
};
const engineSource = ['cloneUndoValue', 'sameUndoId', 'tombstoneUndoEntries', 'restoreUndoEntries',
  'tombstoneUndoRedemptions', 'undoCursorTarget'].map(name => extract(indexSource, name)).join('\n')
  + '\n' + extract(storageSource, 'buildTimerPublication');

const start = 1793203200000, saved = start + 600000, now = saved + 120000;
const counter = revision => ({ v: 1, baseExists: revision !== 1, baseRevision: revision - 1, revision, operationId: 'prior_writer' });
let emulator;
before(async () => { emulator = await startEmulator(); });
after(() => emulator?.stop());

function memoryStorage() {
  const map = new Map();
  return { map, failNext: 0, failReadback: false,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) {
      if (this.failNext > 0 && --this.failNext === 0) throw new Error('QuotaExceededError (fixture)');
      map.set(key, this.failReadback ? value.slice(0, -1) : value);
    } };
}
function mutex() {
  const tails = new Map();
  return (owner, task) => {
    const previous = tails.get(owner) || Promise.resolve();
    let release; const gate = new Promise(resolve => { release = resolve; });
    tails.set(owner, previous.then(() => gate));
    return previous.then(async () => { try { return await task(); } finally { release(); } });
  };
}
let sequence = 0;
const ids = () => `op_test_${String(++sequence).padStart(6, '0')}`;

function frameFor(uid, { versioned = false } = {}) {
  const owner = `uid_${uid}`;
  const timer = { running: true, stopped: false, ownerRoom: owner, ownerDeviceId: 'device-a', intervalSecs: 1800,
    taskStartTime: saved, blockStartTime: saved, trackingStartedAt: start, startedAt: saved, lastTask: 'Work',
    takeover: false, updatedAt: saved, updatedBy: 'device-a', deviceName: 'PC' };
  const created = { id: 1213, tsStart: start, ts: saved, blockIntervalMin: 10, date: '2026-10-28', activity: 'Work',
    energy: 'deep', updatedAt: saved, note: 'Original full note', metadata: { source: 'historical fixture', text: '資料 😀', tags: ['keep'] } };
  const historical = { id: 1200, tsStart: start - 7200000, ts: start - 3600000, blockIntervalMin: 60, date: '2026-10-28',
    activity: 'Historical time', energy: 'deep', updatedAt: start - 3600000, custom: { original: true } };
  const tombstone = { id: 1201, tsStart: start - 3600000, ts: start - 1800000, deleted: true, updatedAt: start - 1800000 };
  if (versioned) { created._csWrite = counter(1); timer._csWrite = counter(1); }
  return { owner, timer, entries: [created, historical, tombstone],
    undo: { type: 'created', label: 'log', entryIds: [1213], createdAt: saved,
      timerCursor: { ownerRoom: owner, deviceId: 'device-a', savedThrough: saved, taskStart: start, blockStart: start, task: 'Work', trackingStart: start } } };
}

/** Runs the unchanged extracted Undo/timer functions on copies, exactly as requestAcknowledgedUndo does. */
function propose(frame, action = frame.undo, at = now) {
  const context = { Date: class extends Date { static now() { return at; } }, structuredClone, JSON,
    navigator: { userAgent: 'Synthetic Desktop' }, entries: structuredClone(frame.entries), focusRedemptions: [],
    running: frame.timer.running, taskStartTime: frame.timer.taskStartTime, blockStartTime: frame.timer.blockStartTime,
    trackingStartedAt: frame.timer.trackingStartedAt, currentTask: frame.timer.lastTask, timerOwnerDeviceId: frame.timer.ownerDeviceId,
    syncedDeviceId: 'device-a', totalSecs: 1800, remaining: 1680, timerStartedAt: saved, lastTaskForRepeat: 'Work',
    timerStateOwnedByCurrentAccount: () => true, timerStateOwnerRoom: () => frame.owner, action, now: at };
  vm.createContext(context);
  vm.runInContext(`${engineSource}
    var proposedEntries = cloneUndoValue(entries);
    if (action.type === 'created') tombstoneUndoEntries(action.entryIds, now, proposedEntries);
    else if (action.type === 'restore-entries') restoreUndoEntries(action.entries, now, proposedEntries);
    var target = undoCursorTarget(action.timerCursor);
    var timer = target ? buildTimerPublication({ taskStartTime: target.taskStart, blockStartTime: target.blockStart }, '${frame.owner}') : null;`, context);
  const records = {}, local = {};
  const byId = new Map(frame.entries.map(entry => [String(entry.id), entry]));
  for (const entry of context.proposedEntries) {
    const original = byId.get(String(entry.id)) || null;
    if (original && core.same(original, entry)) continue;
    records[`entries/e_${entry.id}`] = entry; local[`entries/e_${entry.id}`] = original;
  }
  if (context.timer) records.timer = context.timer;
  return JSON.parse(JSON.stringify({ records, local, target: context.target })); // leave the VM realm
}

async function world(uid, { rules = historicalRules, versioned = false } = {}) {
  const frame = frameFor(uid, { versioned });
  const w = await emulator.fresh(rules);
  await w.seed(`rooms/${frame.owner}`, { timer: frame.timer, entries: Object.fromEntries(frame.entries.map(e => [`e_${e.id}`, e])) });
  return { frame, w, path: `rooms/${frame.owner}` };
}

/** One tab: engine + REST transport authenticated as `as`, with fetch hooks for fault injection. */
function tab(env, { storage = memoryStorage(), lock = mutex(), as = env.frame.owner.slice(4) } = {}) {
  const hooks = { patches: 0, beforePatch: null, dropRequest: false, loseReply: false, holdPatch: null, uid: as, patchAs: null };
  const fetchImpl = async (url, init) => {
    if (init.method === 'PATCH') {
      hooks.patches++;
      if (hooks.beforePatch) await hooks.beforePatch();
      if (hooks.holdPatch) await hooks.holdPatch;
      if (hooks.dropRequest) throw new TypeError('Failed to fetch (request never left)');
      if (hooks.patchAs) { const u = new URL(url); u.searchParams.set('auth', token(hooks.patchAs)); url = u.toString(); }
      const response = await fetch(url, init);
      if (hooks.loseReply) { await response.text(); throw new TypeError('Failed to fetch (reply lost)'); }
      return response;
    }
    return fetch(url, init);
  };
  const transport = core.createRestTransport({ databaseURL: `${emulator.base}?ns=${env.w.name}`,
    getIdToken: async () => token(hooks.uid), fetchImpl });
  const engine = core.createTimeAck({ storage, lock, transport, randomId: ids, sleep: () => Promise.resolve() });
  return { engine, storage, lock, hooks };
}

function spec(env, proposal, extra = {}) {
  return { owner: env.frame.owner, uid: env.frame.owner.slice(4), device: 'device-a', session: start, label: 'log',
    actionCreatedAt: env.frame.undo.createdAt, records: proposal.records,
    agrees: actual => Object.entries(proposal.local).every(([path, value]) => core.same(actual[path], value))
      && (!proposal.records.timer || (actual.timer && actual.timer.taskStartTime === saved && actual.timer.blockStartTime === saved)),
    local: { records: proposal.local }, proposedLocal: { cursor: proposal.target }, ...extra };
}
/** Simulates elapsed time since the last attempt by ageing the stored record (no clock mocking). */
function age(storage, owner, ms) {
  const key = `${core.STORAGE_BASE}:${owner}`, envelope = JSON.parse(storage.getItem(key));
  envelope.operation.lastAttemptAt -= ms;
  storage.setItem(key, JSON.stringify(envelope));
}
const applier = () => { const calls = []; return { calls, attached: () => true, apply: op => { calls.push(op.id); return 'applied'; } }; };

for (const uid of ['alice', 'bob']) {
  test(`${uid}: current strict rules refuse the original legacy engine bytes without changing any path`, async () => {
    const env = await world(uid, { rules: canonicalRules }), t = tab(env);
    const before = await env.w.read(env.path);
    const begun = await t.engine.begin(spec(env, propose(env.frame)));
    assert.equal(begun.operation.phase, 'refused');
    assert.deepEqual(await env.w.read(env.path), before);
  });

  test(`${uid}: accepted Undo — one atomic PATCH, unchanged arithmetic, applied exactly once`, async () => {
    const env = await world(uid), t = tab(env), proposal = propose(env.frame);
    assert.deepEqual(proposal.target, { taskStart: start, blockStart: start }, 'unchanged cursor guard rewinds to the saved span start');
    assert.equal(proposal.records['entries/e_1213'].deleted, true);
    assert.equal(proposal.records['entries/e_1213'].tsStart, start, 'original timestamps frozen');
    assert.equal(Object.keys(proposal.records).length, 2, 'historical records and tombstones are not touched');
    const begun = await t.engine.begin(spec(env, proposal));
    assert.equal(begun.operation.phase, 'accepted');
    assert.equal(begun.operation.evidence.authority, 'server-ack');
    assert.equal(t.hooks.patches, 1);
    const server = await env.w.read(env.path);
    assert.deepEqual(server.entries.e_1213, begun.operation.patch['entries/e_1213']);
    assert.equal(server.entries.e_1213._csWrite.operationId, begun.operation.id);
    assert.equal(server.entries.e_1213.metadata.text, '資料 😀');
    assert.equal(server.timer.taskStartTime, start); assert.equal(server.timer.blockStartTime, start);
    assert.deepEqual(server.entries.e_1200, env.frame.entries[1]); assert.deepEqual(server.entries.e_1201, env.frame.entries[2]);
    const a = applier();
    assert.equal((await t.engine.finalize(env.frame.owner, a)).outcome, 'applied');
    assert.equal((await t.engine.finalize(env.frame.owner, a)).outcome, null);
    const reloaded = tab(env, { storage: t.storage });
    assert.equal((await reloaded.engine.finalize(env.frame.owner, a)).outcome, null, 'rehydrated record never applies twice');
    assert.equal(a.calls.length, 1);
    assert.equal(t.engine.openOperation(env.frame.owner), null, 'barrier lifted');
    assert.equal(t.engine.lastFinalized(env.frame.owner).outcome, 'applied');
  });

  test(`${uid}: gated rules — a concurrent entry edit refuses the whole batch; cursor/Undo stay original`, async () => {
    const env = await world(uid, { rules: accountingRules({ baseRules: JSON.parse(historicalRules) }), versioned: true }), t = tab(env), proposal = propose(env.frame);
    const concurrent = { ...env.frame.entries[0], note: 'Later valid correction', updatedAt: saved + 1, _csWrite: counter(2) };
    t.hooks.beforePatch = () => env.w.seed(`${env.path}/entries/e_1213`, concurrent);
    const begun = await t.engine.begin(spec(env, proposal));
    assert.equal(begun.operation.phase, 'refused');
    assert.equal(begun.operation.evidence.authority, 'server-refusal');
    const a = applier();
    assert.equal((await t.engine.finalize(env.frame.owner, a)).outcome, 'refused');
    assert.equal(a.calls.length, 0, 'refusal never applies local consequences');
    assert.deepEqual(await env.w.read(`${env.path}/entries/e_1213`), concurrent);
    assert.deepEqual(await env.w.read(`${env.path}/timer`), env.frame.timer, 'timer rewind is never published alone');
    assert.equal(t.engine.openOperation(env.frame.owner), null);
  });

  test(`${uid}: gated rules accept the integrated revision stamps for entry and timer`, async () => {
    const env = await world(uid, { rules: accountingRules({ baseRules: JSON.parse(historicalRules) }), versioned: true }), t = tab(env);
    const begun = await t.engine.begin(spec(env, propose(env.frame)));
    assert.equal(begun.operation.phase, 'accepted');
    const server = await env.w.read(env.path);
    assert.deepEqual(server.entries.e_1213._csWrite, { v: 1, baseExists: true, baseRevision: 1, revision: 2, operationId: begun.operation.id });
    assert.deepEqual(server.timer._csWrite, { v: 1, baseExists: true, baseRevision: 1, revision: 2, operationId: begun.operation.id });
  });

  test(`${uid}: lost reply — UNKNOWN survives reload and reconciles from the post-image, applied once`, async () => {
    const env = await world(uid), t = tab(env);
    t.hooks.loseReply = true;
    const begun = await t.engine.begin(spec(env, propose(env.frame)));
    assert.equal(begun.operation.phase, 'unknown');
    assert.equal(t.engine.openOperation(env.frame.owner).phase, 'unknown', 'barrier holds while unconfirmed');
    const a = applier();
    assert.equal((await t.engine.finalize(env.frame.owner, a)).outcome, null, 'no success claimed without confirmation');
    const reloaded = tab(env, { storage: t.storage });
    assert.equal((await reloaded.engine.recover(env.frame.owner)).phase, 'accepted');
    assert.equal((await reloaded.engine.finalize(env.frame.owner, a)).outcome, 'applied');
    assert.equal(a.calls.length, 1);
    assert.equal(reloaded.engine.lastFinalized(env.frame.owner).evidence.authority, 'server-post-image');
  });

  test(`${uid}: lost request — before-state allows only the identical retry`, async () => {
    const env = await world(uid), t = tab(env);
    t.hooks.dropRequest = true;
    const first = (await t.engine.begin(spec(env, propose(env.frame)))).operation;
    assert.equal(first.phase, 'unknown');
    const recovered = await t.engine.recover(env.frame.owner);
    assert.equal(recovered.retrySafe, true);
    t.hooks.dropRequest = false;
    const retried = await t.engine.retry(env.frame.owner);
    assert.equal(retried.phase, 'accepted');
    assert.deepEqual(retried.patch, first.patch, 'same id, timestamps, bases and payload');
    assert.equal(retried.attempts, 2);
  });

  test(`${uid}: elapsed time cannot abandon UNKNOWN or change its immutable intent`, async () => {
    const env = await world(uid), t = tab(env);
    t.hooks.dropRequest = true;
    await t.engine.begin(spec(env, propose(env.frame)));
    await t.engine.recover(env.frame.owner);
    const early = await t.engine.abandon(env.frame.owner);
    assert.equal(early.abandoned, false, 'a just-cut-off request could still be in flight');
    assert.equal(early.reason, 'requires-enforceable-cancellation');
    age(t.storage, env.frame.owner, 86400000);
    const result = await t.engine.abandon(env.frame.owner);
    assert.equal(result.abandoned, false);
    assert.equal(t.engine.openOperation(env.frame.owner).phase, 'unknown');
    assert.equal(t.engine.lastFinalized(env.frame.owner), null);
    assert.deepEqual(await env.w.read(`${env.path}/timer`), env.frame.timer);
    assert.deepEqual(await env.w.read(`${env.path}/entries/e_1213`), env.frame.entries[0]);
  });

  test(`${uid}: one path rewritten after lost reply — a surviving stamp cannot acknowledge the whole legacy command`, async () => {
    const env = await world(uid), t = tab(env);
    t.hooks.loseReply = true;
    const { operation: original } = await t.engine.begin(spec(env, propose(env.frame)));
    // Model a postimage retained from the old deployment; current strict gates reject new legacy sends.
    await env.w.seed(`${env.path}/timer`, original.patch.timer);
    await env.w.seed(`${env.path}/entries/e_1213`, { ...env.frame.entries[0], note: 'edited elsewhere', updatedAt: now + 5 });
    const recovered = await t.engine.recover(env.frame.owner);
    assert.equal(recovered.phase, 'unknown');
    assert.equal(recovered.retrySafe, false);
    const outcome = await t.engine.finalize(env.frame.owner, { attached: () => true, apply: () => { throw Error('must not apply partial evidence'); } });
    assert.equal(outcome.outcome, null);
    assert.equal(t.engine.openOperation(env.frame.owner).id, recovered.id);
  });

  test(`${uid}: never-landed, then a path changed elsewhere — stays UNKNOWN (residual owner decision); no write`, async () => {
    const env = await world(uid), t = tab(env);
    t.hooks.dropRequest = true;
    await t.engine.begin(spec(env, propose(env.frame)));
    await env.w.seed(`${env.path}/entries/e_1213`, { ...env.frame.entries[0], note: 'edited elsewhere', updatedAt: saved + 5 });
    const recovered = await t.engine.recover(env.frame.owner);
    assert.equal(recovered.phase, 'unknown'); assert.equal(recovered.retrySafe, false);
    t.hooks.dropRequest = false;
    age(t.storage, env.frame.owner, 86400000);
    assert.equal((await t.engine.retry(env.frame.owner)).phase, 'unknown');
    assert.equal((await t.engine.abandon(env.frame.owner)).abandoned, false);
    assert.equal(t.hooks.patches, 1, 'no further write from an ambiguous state');
    assert.equal(t.engine.openOperation(env.frame.owner).phase, 'unknown', 'never discarded');
  });

  test(`${uid}: a refusal after an uncertain attempt cannot prove the first never landed`, async () => {
    const env = await world(uid), t = tab(env);
    t.hooks.dropRequest = true;
    await t.engine.begin(spec(env, propose(env.frame)));
    await t.engine.recover(env.frame.owner);
    t.hooks.dropRequest = false;
    t.hooks.patchAs = uid === 'alice' ? 'mallory' : 'eve'; // authority lost between read and write
    const retried = await t.engine.retry(env.frame.owner);
    assert.equal(retried.phase, 'unknown');
    assert.equal(retried.evidence.status === 401 || retried.evidence.status === 403, true);
  });

  test(`${uid}: historical canonical rules — one refused record refuses the whole batch atomically`, async () => {
    const env = await world(uid), t = tab(env);
    // A restore that would resurrect the stored tombstone without the Undo restore stamp is denied
    // by the existing tombstone rule; the timer rewind in the same PATCH must not land either.
    const proposal = propose(env.frame);
    proposal.records['entries/e_1201'] = { ...env.frame.entries[2], deleted: null, updatedAt: now };
    proposal.local['entries/e_1201'] = env.frame.entries[2];
    const begun = await t.engine.begin(spec(env, proposal));
    assert.equal(begun.operation.phase, 'refused');
    assert.deepEqual(await env.w.read(`${env.path}/timer`), env.frame.timer);
    assert.deepEqual(await env.w.read(`${env.path}/entries/e_1213`), env.frame.entries[0]);
  });
}

test('restore Undo of a Save extension recovers the original 10-minute interval', async () => {
  const env = await world('alice'), t = tab(env);
  const extended = { ...env.frame.entries[0], ts: now, blockIntervalMin: 12, updatedAt: now };
  const frame = { ...env.frame, entries: [extended, ...env.frame.entries.slice(1)],
    timer: { ...env.frame.timer, taskStartTime: now, blockStartTime: now },
    undo: { type: 'restore-entries', label: 'log extension', createdAt: now, entries: [env.frame.entries[0]],
      timerCursor: { ...env.frame.undo.timerCursor, savedThrough: now, taskStart: saved, blockStart: saved } } };
  await env.w.seed(env.path, { timer: frame.timer, entries: Object.fromEntries(frame.entries.map(e => [`e_${e.id}`, e])) });
  const proposal = propose(frame, frame.undo, now + 60000);
  const restored = proposal.records['entries/e_1213'];
  assert.equal(restored.ts - restored.tsStart, 600000);
  assert.equal(restored.blockIntervalMin, 10);
  assert.equal(restored.undoRestoredAt, restored.updatedAt);
  assert.deepEqual(proposal.target, { taskStart: saved, blockStart: saved });
  const s = spec({ ...env, frame }, proposal);
  s.agrees = actual => core.same(actual['entries/e_1213'], extended) && actual.timer.taskStartTime === now;
  assert.equal((await t.engine.begin(s)).operation.phase, 'accepted');
  assert.equal((await env.w.read(`${env.path}/timer`)).taskStartTime, saved);
});

test('cross-tab: the barrier refuses a second operation and two tabs apply exactly once', async () => {
  const env = await world('alice'), storage = memoryStorage(), lock = mutex();
  const a = tab(env, { storage, lock }), b = tab(env, { storage, lock });
  let release; a.hooks.holdPatch = new Promise(resolve => { release = resolve; });
  const first = a.engine.begin(spec(env, propose(env.frame)));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(a.engine.openOperation(env.frame.owner).phase, 'pending', 'attempt recorded before it is answered');
  const second = b.engine.begin(spec(env, propose(env.frame)));
  release();
  assert.equal((await first).operation.phase, 'accepted');
  assert.equal((await second).refused, 'barrier');
  const apply = applier();
  const outcomes = await Promise.all([a.engine.finalize(env.frame.owner, apply), b.engine.finalize(env.frame.owner, apply)]);
  assert.deepEqual(outcomes.map(o => o.outcome).sort(), ['applied', null]);
  assert.equal(apply.calls.length, 1);
  assert.equal(b.hooks.patches, 0);
});

test('storage failure or failed readback before staging sends nothing and changes nothing', async () => {
  for (const fault of ['quota', 'readback']) {
    const env = await world('alice'), storage = memoryStorage(), t = tab(env, { storage });
    if (fault === 'quota') storage.failNext = 1; else storage.failReadback = true;
    await assert.rejects(t.engine.begin(spec(env, propose(env.frame))));
    assert.equal(t.hooks.patches, 0, `${fault}: no domain write`);
    assert.deepEqual(await env.w.read(`${env.path}/timer`), env.frame.timer);
  }
});

test('interrupted after staging, before the attempt is recorded: retired as refused, nothing sent', async () => {
  const env = await world('alice'), storage = memoryStorage(), t = tab(env, { storage });
  storage.failNext = 3; // shared preparation and immutable staging succeed; recording the attempt fails
  await assert.rejects(t.engine.begin(spec(env, propose(env.frame))));
  assert.equal(t.hooks.patches, 0);
  assert.equal(t.engine.openOperation(env.frame.owner).phase, 'intent', 'staged intent is retained, not discarded');
  assert.equal((await t.engine.recover(env.frame.owner)).phase, 'refused');
  const apply = applier();
  assert.equal((await t.engine.finalize(env.frame.owner, apply)).outcome, 'refused');
  assert.equal(apply.calls.length, 0);
  assert.equal(t.engine.lastFinalized(env.frame.owner).evidence.reason, 'interrupted-before-send');
});

test('a local frame that disagrees with the server is refused before any write', async () => {
  const env = await world('alice'), t = tab(env), proposal = propose(env.frame);
  await env.w.seed(`${env.path}/timer`, { ...env.frame.timer, taskStartTime: now, blockStartTime: now, updatedAt: now });
  assert.equal((await t.engine.begin(spec(env, proposal))).refused, 'server-differs');
  assert.equal(t.hooks.patches, 0);
  assert.equal(t.engine.openOperation(env.frame.owner), null);
});

test('accounts are isolated: records, barriers and server authority', async () => {
  const alice = await world('alice'), storage = memoryStorage(), lock = mutex();
  const ta = tab(alice, { storage, lock });
  ta.hooks.dropRequest = true;
  await ta.engine.begin(spec(alice, propose(alice.frame)));
  const bob = await world('bob'), tb = tab(bob, { storage, lock });
  assert.equal(tb.engine.openOperation(bob.frame.owner), null, "alice's barrier is not bob's");
  assert.equal((await tb.engine.begin(spec(bob, propose(bob.frame)))).operation.phase, 'accepted');
  assert.equal(ta.engine.openOperation(alice.frame.owner).phase, 'unknown', "alice's record untouched");
  const foreign = tab(alice, { as: 'bob' });
  assert.equal((await foreign.engine.begin(spec(alice, propose(alice.frame)))).refused, 'unreachable', 'foreign token cannot read');
  const dormant = await ta.engine.finalize(alice.frame.owner, { attached: () => false, apply: () => assert.fail('dormant') });
  assert.equal(dormant.outcome, null);
});

test('accepted but superseded locally: retired with both frames, never re-applied', async () => {
  const env = await world('alice'), t = tab(env);
  await t.engine.begin(spec(env, propose(env.frame)));
  const outcome = await t.engine.finalize(env.frame.owner, { attached: () => true, apply: () => 'superseded' });
  assert.equal(outcome.outcome, 'superseded');
  const record = t.engine.lastFinalized(env.frame.owner);
  assert.ok(record.local && record.patch, 'original and accepted frames retained for review');
  assert.equal(t.engine.openOperation(env.frame.owner), null);
});

test('an unreadable record pauses Undo only and is never overwritten', async () => {
  const storage = memoryStorage();
  storage.setItem(`${core.STORAGE_BASE}:uid_alice`, '{broken');
  const engine = core.createTimeAck({ storage, lock: mutex(), transport: null, randomId: ids });
  assert.deepEqual(engine.openOperation('uid_alice'), { phase: 'unreadable' });
  await assert.rejects(engine.begin({ owner: 'uid_alice', records: { timer: {} } }));
  assert.equal(storage.getItem(`${core.STORAGE_BASE}:uid_alice`), '{broken');
});
