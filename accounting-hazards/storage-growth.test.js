// Accounting storage growth, release N + flagged A1/B (docs: storage-growth design 4-v5).
// Release N: compacted-input comparison (digest over same()'s canonical bytes) at every history compare
// site; an unknown digest version is never equal and is retained, never thrown on.
// A1 (compaction.stripFirstHydrate): a committed first hydrate keeps a digest instead of frame/sourceCaches.
// B (compaction.elideNoopHydrate): a hydrate that changes nothing settles without history or generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import '../time-ack.js';
import '../accounting-command.js';

const AC = globalThis.AccountingCommand;
const { clone, createCoordinator, BASE, INTAKE } = AC;
const { same } = globalThis.TimeAckCore;
const OWNER = 'uid_alice';

function fixture(compaction = {}) {
  const values = new Map(), removed = new Map(), saves = [];
  const storage = { get length() { return values.size; }, key: i => [...values.keys()][i],
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { if (key === `${BASE}:${OWNER}`) saves.push(value); values.set(key, value); },
    removeItem: key => { if (values.has(key)) removed.set(key, values.get(key)); values.delete(key); } };
  const context = { owner: OWNER, uid: 'alice', device: 'a', generation: 1 };
  let raw = { entries: {}, timer: { ownerRoom: OWNER, cursor: 0 } }, count = 0, tail = Promise.resolve();
  const applied = [], during = [];
  const deps = { storage, identity: () => context, randomId: () => `command_${++count}`, same, compaction,
    lock: (owner, fn) => { const next = tail.then(fn); tail = next.catch(() => {}); return next; },
    transport: { enforcesAccounting: true, async inspect() { return clone(raw); }, async patch() { return { status: 200 }; } },
    // Hydrates are read-only: the projection is the server read. Other commands are held for the test.
    prepare(operation, current) {
      for (const hook of during.splice(0)) hook(operation);
      if (operation.input.name !== 'hydrate-accounting') return { status: 'wait', reason: 'held-for-test' };
      return { localOnly: true, projection: { cursor: current.timer.cursor }, settledWrites: { timer: current.timer } };
    },
    apply(value, committed) { applied.push({ value, generation: committed?.generation }); } };
  return { values, removed, saves, deps, applied, during, create: () => createCoordinator(deps),
    get raw() { return raw; }, set raw(value) { raw = value; } };
}
const firstHydrate = () => ({ name: 'hydrate-accounting', confirmedOnly: false,
  frame: { entries: [{ id: 'e1', activity: 'x'.repeat(200) }], cursor: 0 },
  sourceCaches: { 'ta3-entries': JSON.stringify([{ id: 'e1', activity: 'x'.repeat(200) }]), 'ta3-timer': null } });
const envelope = f => JSON.parse(f.values.get(`${BASE}:${OWNER}`));

test('sha256Hex matches node:crypto across block boundaries and non-ASCII text', () => {
  for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'Zeitkonto ✓ 時間 🙂']) {
    assert.equal(AC.sha256Hex(text), createHash('sha256').update(text, 'utf8').digest('hex'));
  }
});

test('inputDigest agrees with same(): key order and stored-null differences give one digest', () => {
  const a = { name: 'x', b: 1, a: { d: null, c: [1, 2] } }, b = { a: { c: [1, 2] }, name: 'x', b: 1 };
  assert.ok(same(a, b));
  assert.equal(AC.inputDigest(a), AC.inputDigest(b));
  assert.notEqual(AC.inputDigest(a), AC.inputDigest({ ...a, b: 2 }));
});

test('sameInput: full vs compacted compares by digest; an unknown digest version is never equal (test 12)', () => {
  const full = firstHydrate();
  const compacted = { name: full.name, compacted: 1, digestV: AC.DIGEST_V, digest: AC.inputDigest(full) };
  assert.ok(AC.sameInput(full, compacted));
  assert.ok(AC.sameInput(compacted, full));
  assert.ok(!AC.sameInput({ ...full, confirmedOnly: true }, compacted));
  const future = { ...compacted, digestV: AC.DIGEST_V + 1 };
  assert.ok(!AC.sameInput(full, future));
  assert.ok(!AC.sameInput(future, future), 'unknown versions are not even equal to themselves');
  assert.equal(AC.unknownDigest(future), true);
});

test('flags default OFF: a first hydrate keeps its frame and source caches in history', async () => {
  const f = fixture();
  const c = f.create();
  await c.submit(firstHydrate());
  const record = envelope(f).history[0];
  assert.equal(record.input.compacted, undefined);
  assert.ok(record.input.frame && record.input.sourceCaches);
});

test('A1: the committed first hydrate is compacted in the SAME save that commits it', async () => {
  const f = fixture({ stripFirstHydrate: true });
  const c = f.create();
  const original = firstHydrate();
  await c.submit(original);
  const committingSave = f.saves.map(raw => JSON.parse(raw)).find(state => state.committed);
  const record = committingSave.history.find(item => item.id === committingSave.committed.operationId);
  assert.equal(record.input.compacted, 1);
  assert.equal(record.input.frame, undefined);
  assert.equal(record.input.sourceCaches, undefined);
  assert.equal(record.input.digest, AC.inputDigest(original));
  assert.ok(record.input.bytes.frame > 200 && record.input.bytes.sourceCaches['ta3-entries'] > 200);
  assert.ok(f.values.get(`${BASE}:${OWNER}`).length < JSON.stringify(original).length + 1200, 'the large bodies are gone');
});

test('A1: a compacted envelope reloads through load() and drains again (test 5)', async () => {
  const f = fixture({ stripFirstHydrate: true });
  await f.create().submit(firstHydrate());
  const reloaded = f.create();
  assert.equal(reloaded.snapshot().history[0].input.compacted, 1);
  const result = await reloaded.drain();
  assert.equal(result.status, 'drained');
});

test('A1: a hydrate something depends on is NOT stripped (legacy-bootstrap capture made during prepare)', async () => {
  const f = fixture({ stripFirstHydrate: true });
  const c = f.create();
  f.during.push(operation => c.capture({ name: 'legacy-accounting-caches', attribution: 'unproven', source: { probe: 1 } },
    { eventKey: `legacy-bootstrap:${operation.id}`, dependsOn: operation.id, at: operation.at }));
  await c.submit(firstHydrate());
  const record = envelope(f).history.find(item => item.input.name === 'hydrate-accounting');
  assert.equal(record.input.compacted, undefined);
  assert.ok(record.input.frame);
});

test('A1: an intake replay of a compacted hydrate (crash between save and removeItem) does not throw (test 3)', async () => {
  const f = fixture({ stripFirstHydrate: true });
  const c = f.create();
  await c.submit(firstHydrate());
  const [slot, captured] = [...f.removed].find(([key]) => key.startsWith(`${INTAKE}:${OWNER}:`));
  f.values.set(slot, captured); // the crash left the intake slot behind
  const before = envelope(f);
  const result = await f.create().drain();
  assert.equal(result.status, 'drained');
  assert.equal(f.values.has(slot), false, 'the replay is recognised by digest and its slot retired');
  assert.deepEqual(envelope(f).history, before.history);
});

test('release N: a replay against a compacted record of an UNKNOWN digest version is retained, never thrown (test 12b)', async () => {
  const f = fixture({ stripFirstHydrate: true });
  await f.create().submit(firstHydrate());
  const [slot, captured] = [...f.removed].find(([key]) => key.startsWith(`${INTAKE}:${OWNER}:`));
  const state = envelope(f);
  state.history[0].input.digestV = AC.DIGEST_V + 1;
  f.values.set(`${BASE}:${OWNER}`, JSON.stringify(state));
  f.values.set(slot, captured);
  const result = await f.create().drain();
  assert.equal(result.status, 'drained');
  assert.equal(f.values.get(slot), captured, 'the replay stays in intake as evidence');
});

test('B: 100 echo hydrates add no history and no generation; apply() still runs (test 17)', async () => {
  const f = fixture({ elideNoopHydrate: true });
  const c = f.create();
  await c.submit({ name: 'hydrate-accounting', confirmedOnly: false });
  const { history, generation } = envelope(f);
  const appliedBefore = f.applied.length;
  for (let i = 0; i < 100; i++) {
    const outcome = await c.submit({ name: 'hydrate-accounting', confirmedOnly: false });
    assert.equal(outcome.status, 'drained');
    assert.equal(outcome.ownSettled, true);
    assert.equal(outcome.ownApplied, false);
  }
  assert.equal(envelope(f).history.length, history.length);
  assert.equal(envelope(f).generation, generation);
  assert.equal(envelope(f).queue.length, 0);
  assert.ok(f.applied.length >= appliedBefore + 100, 'the view is still applied for every elided hydrate');
});

test('B: a hydrate that changes the projection or a settled write is committed, not elided', async () => {
  const f = fixture({ elideNoopHydrate: true });
  const c = f.create();
  await c.submit({ name: 'hydrate-accounting', confirmedOnly: false });
  const before = envelope(f);
  f.raw = { ...f.raw, timer: { ownerRoom: OWNER, cursor: 7 } };
  const outcome = await c.submit({ name: 'hydrate-accounting', confirmedOnly: false });
  assert.equal(outcome.ownApplied, true);
  assert.equal(envelope(f).generation, before.generation + 1);
  assert.equal(envelope(f).history.length, before.history.length + 1);
});

test('B: flag OFF keeps every echo hydrate as a history record', async () => {
  const f = fixture();
  const c = f.create();
  for (let i = 0; i < 3; i++) await c.submit({ name: 'hydrate-accounting', confirmedOnly: false });
  assert.equal(envelope(f).history.length, 3);
});

test('B: an echo hydrate while a command is held is settled (no "retained" outcome) and the command stays queued (test 17b)', async () => {
  const f = fixture({ elideNoopHydrate: true });
  const c = f.create();
  await c.submit({ name: 'hydrate-accounting', confirmedOnly: false });
  const held = await c.submit({ name: 'start-timer', records: {} });
  assert.notEqual(held.status, 'drained', 'the command is held by the test prepare');
  assert.equal(c.snapshot().queue.length, 1);
  const appliedBefore = f.applied.length;
  const outcome = await c.submit({ name: 'hydrate-accounting', confirmedOnly: true });
  assert.notEqual(outcome.status, 'drained', 'the held command still blocks the drain');
  assert.equal(outcome.ownSettled, true, 'index.html shows no "Accounting retained" toast for it');
  assert.deepEqual(c.snapshot().queue.map(item => item.input.name), ['start-timer']);
  assert.ok(f.applied.length > appliedBefore);
});
