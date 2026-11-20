// Storage fix F2 (coordinator, always on): a quota failure on one intake slot never blocks the others, never deletes,
// never loops, and is reported as storage-full instead of throwing. Synthetic data, real coordinator, Chromium-like quota.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.window = globalThis;
require('./time-ack.js');
require('./accounting-command.js');
const { AccountingCommand: AC, TimeAckCore } = globalThis;
const OWNER = 'uid_u1', CTX = { owner: OWNER, uid: 'u1', device: 'dev1', generation: 1 };
const QUOTA = 5_242_858; // measured in Chromium: chars of key + value, any character

function quotaStorage() {
  const map = new Map(); let used = 0, failures = 0;
  const size = (k, v) => k.length + v.length;
  return { map, get failures() { return failures; }, get used() { return used; }, get length() { return map.size; },
    key: i => [...map.keys()][i] ?? null, getItem: k => map.has(k) ? map.get(k) : null,
    setItem(k, v) { v = String(v); const next = used - (map.has(k) ? size(k, map.get(k)) : 0) + size(k, v);
      if (next > QUOTA) { failures++; const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      map.set(k, v); used = next; },
    removeItem(k) { if (map.has(k)) { used -= size(k, map.get(k)); map.delete(k); } } };
}
const ENTRY = i => ({ id: 1000 + i, activity: `act ${i} ${'s'.repeat(560)}`, ts: 1_700_000_000_000 + i, tsStart: 1_700_000_000_000 + i - 1800000 });
const ENTRIES = Array.from({ length: 2489 }, (_, i) => ENTRY(i));

function seed(storage) {
  const legacy = { v: 1, ...CTX, id: 'legacy-000001', at: 1, eventKey: null, dependsOn: null, phase: 'local-applied', appliedGeneration: 1,
    authority: 'legacy-caches-on-server', input: { name: 'legacy-accounting-caches', attribution: 'unproven', source: { 'ta3-entries': JSON.stringify(ENTRIES.slice(0, 1100)) } } };
  storage.setItem(`${AC.BASE}:${OWNER}`, JSON.stringify({ v: 1, owner: OWNER, generation: 1, queue: [], history: [legacy],
    committed: { generation: 1, operationId: 'legacy-000001', effectName: null, effectFacts: null, value: { entries: ENTRIES, focusRedemptions: [] } } }));
}
function slot(storage, id, input, at) {
  storage.setItem(`${AC.INTAKE}:${OWNER}:${id}`, JSON.stringify({ v: 1, ...CTX, id, at, eventKey: null, dependsOn: null, input, local: null, phase: 'captured' }));
}
function fill(storage, target) { storage.setItem('zz-filler', 'f'.repeat(Math.max(0, target - storage.used - 9))); }
function coordinator(storage) {
  return AC.createCoordinator({ storage, lock: (_, fn) => fn(), identity: () => ({ ...CTX }), randomId: () => 'r' + Math.random().toString(36).slice(2, 12),
    same: TimeAckCore.same, transport: { enforcesAccounting: true, inspect: async () => ({}) },
    prepare: async () => ({ localOnly: true, projection: { entries: ENTRIES, focusRedemptions: [] }, settledWrites: {} }),
    project: () => null, reconcile: null, apply: () => {} });
}
const env = storage => JSON.parse(storage.getItem(`${AC.BASE}:${OWNER}`));
const bigLegacy = () => ({ name: 'legacy-accounting-caches', attribution: 'unproven', source: { runtime: { name: 'x', requested: null, frame: { entries: ENTRIES, running: false } } } });
const SLOT = `${AC.INTAKE}:${OWNER}:big-0000000001`;
// ~320K: fails while the store is nearly full, fits once the filler is freed. (An owner-sized 1.7M capture never fits
// beside the envelope at all; under Option B it stays stuck, untouched, which the first test covers.)
const mediumLegacy = () => ({ name: 'legacy-accounting-caches', attribution: 'unproven', source: { runtime: { name: 'm', requested: null, frame: { entries: ENTRIES.slice(0, 500), running: false } } } });

test('owner shape: one oversize slot no longer stalls the drain; nothing deleted; no loop', async () => {
  const storage = quotaStorage(); seed(storage);
  slot(storage, 'big-0000000001', bigLegacy(), 10);
  slot(storage, 'small-000000001', { name: 'hydrate-accounting', confirmedOnly: true }, 11);
  slot(storage, 'small-000000002', { name: 'hydrate-accounting', confirmedOnly: true }, 12);
  fill(storage, 4_810_387);
  const bigBefore = storage.getItem(SLOT);
  const c = coordinator(storage);
  const result = await c.drain();
  assert.equal(result.status, 'storage-full', JSON.stringify(result).slice(0, 200));
  assert.equal(storage.getItem(SLOT), bigBefore, 'stuck slot left byte-identical (nothing deleted)');
  const s = env(storage);
  assert.ok(['small-000000001', 'small-000000002'].every(id => s.history.some(h => h.id === id)), 'ordinary ops behind the stuck slot still settled');
  assert.deepEqual(c.stuckCaptures().map(x => x.id), ['big-0000000001']);
  const failuresBefore = storage.failures;
  const again = await c.drain();
  assert.equal(again.status, 'storage-full');
  assert.ok(storage.failures - failuresBefore <= 1, `quota failures per drain: ${storage.failures - failuresBefore}`);
});

test('once space is freed the stuck capture imports in full and its slot is retired', async () => {
  const storage = quotaStorage(); seed(storage);
  const input = mediumLegacy();
  slot(storage, 'big-0000000001', input, 10);
  fill(storage, 5_000_000);
  const c = coordinator(storage);
  assert.equal((await c.drain()).status, 'storage-full');
  storage.removeItem('zz-filler');
  assert.equal((await c.drain()).status, 'drained');
  assert.equal(storage.getItem(SLOT), null);
  const rec = env(storage).history.find(h => h.id === 'big-0000000001');
  assert.ok(rec && TimeAckCore.same(rec.input, input), 'imported verbatim (no slim form exists in this build)');
  assert.deepEqual(c.stuckCaptures(), []);
});

test('two tabs: a slot another tab imported is no longer reported stuck here (QA-C)', async () => {
  const storage = quotaStorage(); seed(storage);
  slot(storage, 'big-0000000001', mediumLegacy(), 10);
  fill(storage, 5_000_000);
  const tab2 = coordinator(storage);
  assert.equal((await tab2.drain()).status, 'storage-full');
  assert.deepEqual(tab2.stuckCaptures().map(x => x.id), ['big-0000000001']);
  storage.removeItem('zz-filler'); // space freed; tab 1 imports
  const tab1 = coordinator(storage);
  assert.equal((await tab1.drain()).status, 'drained');
  assert.equal(storage.getItem(SLOT), null, 'tab 1 imported and removed the slot');
  assert.deepEqual(tab2.stuckCaptures(), [], 'tab 2 forgets the stale stuck entry without a reload');
  assert.equal((await tab2.drain()).status, 'drained');
});

test('pruning stuck entries keeps them when storage reads throw (Priya nit)', async () => {
  const storage = quotaStorage(); seed(storage);
  slot(storage, 'big-0000000001', bigLegacy(), 10);
  fill(storage, 4_810_387);
  const c = coordinator(storage);
  assert.equal((await c.drain()).status, 'storage-full');
  const getItem = storage.getItem;
  storage.getItem = k => { if (k.startsWith(AC.INTAKE)) throw Object.assign(Error('read failed'), { name: 'SecurityError' }); return getItem(k); };
  try { assert.deepEqual(c.stuckCaptures().map(x => x.id), ['big-0000000001'], 'kept, no throw'); }
  finally { storage.getItem = getItem; }
});

test('non-quota errors still surface (fail closed), no silent swallowing', async () => {
  const storage = quotaStorage(); seed(storage);
  storage.setItem(`${AC.INTAKE}:${OWNER}:bad-0000000001`, JSON.stringify({ v: 1, ...CTX, id: 'bad-0000000001', at: 5, input: { name: 'x' }, phase: 'captured', source: 'nonsense' }));
  await assert.rejects(() => coordinator(storage).drain());
});

// Combined with bounded history (release N), digest equality (inputDigest/sameInput) is expected; F1 (slim legacy
// captures) stays out: the owner paused it until F2 ships and real measurements exist.
test('isolation: this build carries no F1 code (no slim legacy form)', () => {
  const fs = require('node:fs'), path = require('node:path');
  for (const f of ['accounting-command.js', 'index.html']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const marker of ['$slim', 'fullDigest', '$entriesRef', 'slimCapture', 'accountingSlimLegacy', 'ta3-accounting-flag-slim-legacy'])
      assert.ok(!src.includes(marker), `${f} must not contain ${marker}`);
  }
  assert.equal(typeof AC.isQuotaError, 'function');
});
