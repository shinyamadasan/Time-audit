// TASK-050 (Decision 47): the verified history cut for every settled kind. Node unit tests against the REAL coordinator,
// synthetic data only. Page-side protections (index.html accountingArchiveProtected) are covered in
// tests/accounting-storage-durability.spec.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.window = globalThis;
require('./time-ack.js');
require('./accounting-command.js');
const { AccountingCommand: AC, TimeAckCore } = globalThis;
const same = TimeAckCore.same;
const OWNER = 'uid_u1', CTX = { owner: OWNER, uid: 'u1', device: 'dev1', generation: 1 };
const KEY = `${AC.BASE}:${OWNER}`;

/** localStorage stand-in with a character quota over keys plus values, like Chromium's. */
function quotaStorage(limit = Infinity) {
  const map = new Map();
  const used = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const storage = { map, limit, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: k => map.has(k) ? map.get(k) : null, removeItem: k => map.delete(k), used,
    setItem(k, v) {
      v = String(v);
      const next = used() - (map.has(k) ? k.length + map.get(k).length : 0) + k.length + v.length;
      if (next > storage.limit) { const error = Error('Injected quota'); error.name = 'QuotaExceededError'; throw error; }
      map.set(k, v);
    } };
  return storage;
}
const pad = n => String(n).padStart(6, '0');
const id = n => `op-${pad(n)}`;
const record = (n, extra = {}) => ({ v: 1, owner: OWNER, uid: 'u1', device: 'dev1', generation: 1, id: id(n), at: 1_000_000 + n,
  eventKey: null, dependsOn: null, phase: 'local-applied', appliedGeneration: n, input: { name: 'ping', n },
  proposal: { local: { before: { blob: 'b'.repeat(2400) }, after: { blob: 'a'.repeat(2400) } } },
  settledWrites: { timer: { n, _csWrite: { v: 1 } } }, ...extra });

function seed(storage, n, mutate = () => {}) {
  const history = Array.from({ length: n }, (_, i) => record(i + 1));
  const state = { v: 1, owner: OWNER, generation: n, queue: [], history,
    committed: { generation: n, operationId: id(n), effectName: null, effectFacts: null, value: { entries: [], focusRedemptions: [] } } };
  mutate(state);
  storage.setItem(KEY, JSON.stringify(state));
}

/** archive: 'all' verifies every offered record at once; a Set is a fixed verified set; null means no archive. */
function coordinator(storage, { archive = 'all', keepOps = 50, batch = 25, protect, enabled = true } = {}) {
  let counter = 0;
  const verified = archive === 'all' ? new Set() : archive;
  const offered = [];
  const historyCut = { enabled, keepOps, batch, archived: () => verified,
    onCandidates: (owner, records) => { offered.push(...records.map(r => r.id)); if (archive === 'all') records.forEach(r => verified.add(r.id)); },
    ...(protect ? { protect } : {}) };
  const c = AC.createCoordinator({ storage, lock: (_, fn) => fn(), identity: () => ({ ...CTX }), randomId: () => `new-${pad(++counter)}`,
    same, transport: { enforcesAccounting: true, inspect: async () => ({}) },
    prepare: async () => ({ localOnly: true, projection: { entries: [], focusRedemptions: [] }, settledWrites: {} }),
    project: () => null, reconcile: null, apply: () => {}, compaction: { historyCut } });
  return Object.assign(c, { offered, verified });
}
const envelope = storage => JSON.parse(storage.getItem(KEY));
const hydrate = (c, extra = {}) => c.submit({ name: 'hydrate-accounting', confirmedOnly: true, ...extra });
/** A capture that cannot be written at the wall stays page-held (the original TASK-045 path). */
function pageHeld(c, storage, chars = 20_000) {
  storage.limit = storage.used() + 200;
  assert.throws(() => c.capture({ name: 'hydrate-accounting', confirmedOnly: true, pad: 'p'.repeat(chars) }), /quota/i);
  assert.equal(c.failedCaptureCount(OWNER), 1);
}

test('at the wall, a page-held capture becomes durable: the verified cut runs on its own and the drain retries once', async () => {
  // 74 records: the commit cut (keep 50 + batch 25) never runs, so before TASK-050 nothing could free room.
  const storage = quotaStorage(); seed(storage, 74);
  const c = coordinator(storage);
  const before = envelope(storage);
  pageHeld(c, storage);
  const result = await c.drain();
  assert.equal(result.status, 'drained', JSON.stringify(result));
  assert.equal(c.failedCaptureCount(OWNER), 0, 'the original capture left the page');
  const after = envelope(storage), dropped = Object.keys(after.droppedIds || {});
  assert.equal(dropped.length, 24, 'every verified record beyond the newest 50');
  assert.ok(after.history.some(op => op.input.pad && op.phase === 'local-applied'), 'the captured fact was applied');
  for (const op of before.history) {
    assert.ok(after.history.some(kept => same(kept, op)) || c.verified.has(op.id), `${op.id} is live or verified-archived`);
  }
  assert.doesNotThrow(() => c.snapshot(OWNER));
});

test('at the wall, nothing verified means nothing is dropped and the capture stays page-held and visible', async () => {
  const storage = quotaStorage(); seed(storage, 74);
  const c = coordinator(storage, { archive: null });
  const raw = storage.getItem(KEY);
  pageHeld(c, storage);
  const result = await c.drain();
  assert.equal(result.status, 'storage-full');
  assert.equal(c.failedCaptureCount(OWNER), 1);
  assert.equal(storage.getItem(KEY), raw, 'envelope bytes unchanged');
  assert.equal(c.offered.length, 24, 'candidates were still offered for archiving');
});

test('a non-quota failure never triggers the quota cut', async () => {
  const storage = quotaStorage(); seed(storage, 74);
  const c = coordinator(storage);
  const raw = storage.getItem(KEY);
  const write = storage.setItem;
  storage.setItem = (k, v) => { if (k.startsWith(AC.INTAKE)) throw Error('disk error'); return write(k, v); };
  assert.throws(() => c.capture({ name: 'hydrate-accounting', confirmedOnly: true }), /disk error/);
  await assert.rejects(c.drain(), /disk error/);
  storage.setItem = write;
  assert.equal(storage.getItem(KEY), raw);
});

test('the page protect hook keeps what it names; a failing or malformed hook keeps everything', async () => {
  for (const [label, protect] of [
    ['named', () => new Set([id(2), id(3)])],
    ['throws', () => { throw Error('reader walk failed'); }],
    ['not a set', () => [id(2)]]]) {
    const storage = quotaStorage(); seed(storage, 100);
    const seen = [];
    const c = coordinator(storage, { protect: (state, candidates, pending) => { seen.push([state.owner, candidates.length, pending.length]); return protect(); } });
    await hydrate(c); await hydrate(c);
    const state = envelope(storage), dropped = Object.keys(state.droppedIds || {});
    if (label === 'named') {
      assert.equal(dropped.length, 51 - 2, `${label}: ${dropped.length}`); // first commit: 101 records, 51 beyond the newest 50, less 2
      assert.ok(state.history.some(op => op.id === id(2)) && state.history.some(op => op.id === id(3)));
    } else assert.equal(dropped.length, 0, label);
    assert.ok(seen.every(([owner]) => owner === OWNER));
  }
});

test('a quota cut at the same generation as a commit cut gets new checkpoint ids; the envelope stays readable', async () => {
  // Two kept legacy records name two different old records, so each cut makes its own checkpoint and neither folds.
  const storage = quotaStorage();
  seed(storage, 300, state => {
    Object.assign(state.history[149], { input: { name: 'legacy-accounting-caches', source: { raw: 'x' } }, dependsOn: id(20) });
    Object.assign(state.history[150], { input: { name: 'legacy-accounting-caches', source: { raw: 'y' } }, dependsOn: id(30) });
  });
  const verified = new Set(Array.from({ length: 24 }, (_, i) => id(i + 2))); // 2..25: the commit cut drops these
  const c = coordinator(storage, { archive: verified, batch: 10 });
  await hydrate(c);
  const first = envelope(storage);
  assert.ok(first.droppedIds[id(20)], 'commit cut dropped op 20');
  const generation = first.generation;
  for (let n = 26; n <= 200; n++) verified.add(id(n));
  pageHeld(c, storage, 4_000);
  const result = await c.drain();
  assert.notEqual(result.status, 'storage-full', JSON.stringify(result));
  const after = envelope(storage), ids = after.history.map(op => op.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.ok(after.droppedIds[id(30)], 'quota cut dropped op 30');
  assert.notEqual(after.droppedIds[id(20)], after.droppedIds[id(30)], 'two checkpoints');
  assert.ok(after.history.filter(op => op.input.name === 'checkpoint').every(op => op.id.startsWith(`ckpt-${generation}-`)));
  assert.doesNotThrow(() => c.snapshot(OWNER), 'load() accepts the envelope');
});

test('a sink that a new walk passes through is folded and never receives new ids (envelope stays readable)', async () => {
  const storage = quotaStorage();
  seed(storage, 300, state => {
    state.history.unshift({ v: 1, id: 'ckpt-1-sink', owner: OWNER, uid: 'u1', device: 'checkpoint', at: 1, phase: 'fenced-reconciled',
      input: { name: 'checkpoint', compacted: 1, digestV: AC.DIGEST_V, covers: 0 }, settledWrites: {}, dependsOn: null });
    state.droppedIds = { 'op-dropped-d': 'ckpt-1-sink' };
    state.history.find(op => op.id === id(100)).dependsOn = 'op-dropped-d'; // a later record named an already dropped one
    state.history.find(op => op.id === id(290)).dependsOn = id(100);        // and a kept record names it
  });
  const c = coordinator(storage);
  await hydrate(c);
  assert.doesNotThrow(() => c.snapshot(OWNER), 'load() accepts the envelope');
  const after = envelope(storage), live = new Set(after.history.map(op => op.id));
  assert.ok(after.droppedIds[id(100)]);
  assert.ok(Object.values(after.droppedIds).every(target => live.has(target)), 'every dropped id names a live checkpoint');
  assert.equal(after.history.filter(op => op.id.endsWith('-sink')).length, 1, 'one sink');
});
