// Storage-growth C (bounded history): node unit tests against the REAL coordinator with synthetic data only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.window = globalThis;
require('./time-ack.js');
require('./accounting-command.js');
const { AccountingCommand: AC, TimeAckCore } = globalThis;
const same = TimeAckCore.same;
const OWNER = 'uid_u1', CTX = { owner: OWNER, uid: 'u1', device: 'dev1', generation: 1 };

function memoryStorage() {
  const map = new Map();
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: k => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}
const pad = n => String(n).padStart(6, '0');
const op = (n, extra = {}) => ({ v: 1, owner: OWNER, uid: 'u1', device: 'dev1', generation: 1, id: `op-${pad(n)}`, at: 1_000_000 + n,
  eventKey: null, dependsOn: n > 1 ? `op-${pad(n - 1)}` : null, phase: 'local-applied', appliedGeneration: n,
  input: { name: 'start-timer', n }, proposal: { local: { before: { blob: 'b'.repeat(2400) }, after: { blob: 'a'.repeat(2400) } } }, settledWrites: { timer: { n, _csWrite: { v: 1 } }, [`entries/e${n}`]: { id: `e${n}`, n } }, ...extra });

/** n settled ops in one causal chain; op 1 is legacy evidence, op 5 is an alias, every 3rd has an eventKey. */
function seed(storage, n, mutate = () => {}) {
  const history = [];
  for (let i = 1; i <= n; i++) {
    const record = op(i);
    if (i === 1) record.input = { name: 'legacy-accounting-caches', source: { raw: 'x' } };
    if (i % 3 === 0) record.eventKey = `auto-log:${i}`;
    if (i === 5) Object.assign(record, { phase: 'coalesced', aliasOf: 'op-000004' });
    history.push(record);
  }
  mutate(history);
  const state = { v: 1, owner: OWNER, generation: n, queue: [], history,
    committed: { generation: n, operationId: `op-${pad(n)}`, effectName: null, effectFacts: null, value: { entries: [], focusRedemptions: [] } } };
  storage.setItem(`${AC.BASE}:${OWNER}`, JSON.stringify(state));
}

function coordinator(storage, { cut = true, archived = 'all', keepOps = 50, batch = 10 } = {}) {
  let counter = 0;
  const archive = new Set();
  const historyCut = { enabled: cut, keepOps, batch,
    archived: () => archived === 'none' ? null : archived === 'all' ? archive : archived,
    onCandidates: (owner, records) => { if (archived === 'all') records.forEach(r => archive.add(r.id)); } };
  return AC.createCoordinator({ storage, lock: (_, fn) => fn(), identity: () => ({ ...CTX }), randomId: () => `new-${pad(++counter)}`,
    same, transport: { enforcesAccounting: true, inspect: async () => ({}) },
    prepare: async () => ({ localOnly: true, projection: { entries: [], focusRedemptions: [] }, settledWrites: {} }),
    project: () => null, reconcile: null, apply: () => {}, compaction: { historyCut } });
}
const hydrate = c => c.submit({ name: 'hydrate-accounting', confirmedOnly: true });
const envelope = storage => JSON.parse(storage.getItem(`${AC.BASE}:${OWNER}`));

/** prepareAccountingObservation's walk (index.html), with map resolution and digest-aware merge. */
function walk(state, start) {
  const ancestry = {}, chain = new Set();
  let id = start;
  while (id) {
    id = AC.resolveDropped(state, id);
    if (chain.has(id)) throw Error('cyclic');
    chain.add(id);
    const parent = state.history.find(item => item.id === id);
    if (!parent) return { wait: true };
    if (parent.aliasOf) { id = parent.aliasOf; continue; }
    for (const [path, value] of Object.entries(parent.settledWrites || parent.proposal?.patch || {})) if (!Object.hasOwn(ancestry, path)) ancestry[path] = value;
    id = parent.dependsOn;
  }
  return ancestry;
}

test('cut drops old settled records, keeps the newest window, pins evidence, and the envelope still loads', async () => {
  const storage = memoryStorage(); seed(storage, 300);
  const c = coordinator(storage);
  const before = storage.getItem(`${AC.BASE}:${OWNER}`).length;
  await hydrate(c); // first commit: candidates are archived (verified) for the next cut
  await hydrate(c); // second commit: cut runs inside the same save
  const state = envelope(storage), after = storage.getItem(`${AC.BASE}:${OWNER}`).length;
  assert.ok(Object.keys(state.droppedIds).length >= 200, `dropped ${Object.keys(state.droppedIds).length}`);
  assert.ok(after < before / 4, `envelope ${before} -> ${after} chars`);
  assert.ok(state.history.some(r => r.id === 'op-000001'), 'legacy evidence is never dropped');
  assert.ok(state.history.some(r => r.id === state.committed.operationId), 'committed op pinned');
  assert.equal(state.history.filter(r => r.input.name !== 'checkpoint').slice(-50).length, 50, 'newest window kept');
  assert.doesNotThrow(() => c.snapshot(OWNER), 'load() accepts the cut envelope (C5 validation)');
  assert.ok(Object.values(state.droppedEventKeys).every(d => /^[0-9a-f]{64}$/.test(d)));
});

test('observation ancestry from the frontier is identical before and after the cut (by digest)', async () => {
  const storage = memoryStorage(); seed(storage, 300);
  const full = walk(envelope(storage), 'op-000300');
  const c = coordinator(storage);
  await hydrate(c); await hydrate(c);
  const state = envelope(storage);
  // the frontier is a kept record; its walk now crosses into a checkpoint
  const cut = walk(state, 'op-000300');
  assert.deepEqual(Object.keys(cut).sort(), Object.keys(full).sort(), 'same set of paths');
  for (const [path, value] of Object.entries(full)) assert.ok(AC.ancestorSame(cut[path], value), `path ${path}`);
  // a server value someone else wrote is still rejected
  assert.equal(AC.ancestorSame(cut['entries/e10'], { id: 'e10', n: 'foreign' }), false);
});

test('a page-held/replayed op naming a dropped id passes the dependency gate (no endless wait)', async () => {
  const storage = memoryStorage(); seed(storage, 300);
  const c = coordinator(storage);
  await hydrate(c); await hydrate(c);
  const droppedId = Object.keys(envelope(storage).droppedIds)[100];
  // another tab's late capture depending on a dropped op
  const late = { v: 1, ...CTX, id: 'late-000001', at: 2_000_000, eventKey: null, dependsOn: droppedId, input: { name: 'hydrate-accounting', confirmedOnly: true }, local: null, phase: 'captured' };
  storage.setItem(`${AC.INTAKE}:${OWNER}:late-000001`, JSON.stringify(late));
  const result = await c.drain();
  assert.equal(result.status, 'drained', JSON.stringify(result));
  assert.ok(envelope(storage).history.some(r => r.id === 'late-000001' && r.phase === 'local-applied'));
});

test('replay of a dropped id is retired; a re-fired dropped eventKey is settled, or a conflict if its facts differ', async () => {
  const storage = memoryStorage(); seed(storage, 300);
  const c = coordinator(storage);
  await hydrate(c); await hydrate(c);
  const state = envelope(storage);
  const replayId = Object.keys(state.droppedIds).find(id => id !== 'op-000005');
  const original = op(Number(replayId.slice(3)));
  storage.setItem(`${AC.INTAKE}:${OWNER}:${replayId}`, JSON.stringify({ ...original, phase: 'captured', local: null }));
  const key = Object.keys(state.droppedEventKeys)[0], n = Number(key.split(':')[1]);
  const refire = id => ({ v: 1, ...CTX, id, at: 3_000_000, eventKey: key, dependsOn: null, local: null, phase: 'captured', input: { name: 'start-timer', n } });
  storage.setItem(`${AC.INTAKE}:${OWNER}:same-000001`, JSON.stringify(refire('same-000001')));
  await c.drain();
  let now = envelope(storage);
  assert.equal(storage.getItem(`${AC.INTAKE}:${OWNER}:${replayId}`), null, 'replay slot retired');
  assert.equal(storage.getItem(`${AC.INTAKE}:${OWNER}:same-000001`), null, 'identical re-fire retired');
  assert.ok(![...now.queue, ...now.history].some(r => r.id === replayId || r.id === 'same-000001'), 'nothing re-executed');
  storage.setItem(`${AC.INTAKE}:${OWNER}:diff-000001`, JSON.stringify({ ...refire('diff-000001'), input: { name: 'start-timer', n: 'changed' } }));
  await c.drain();
  now = envelope(storage);
  assert.ok(now.queue.some(r => r.id === 'diff-000001' && r.phase === 'conflict' && r.reason === 'occurrence-changed'), 'different facts are evidence');
});

test('no verified archive -> nothing is dropped; partial archive -> only verified ids are dropped', async () => {
  for (const archived of ['none', new Set(['op-000010', 'op-000011'])]) {
    const storage = memoryStorage(); seed(storage, 300);
    const c = coordinator(storage, { archived, batch: 1 });
    await hydrate(c); await hydrate(c);
    const dropped = Object.keys(envelope(storage).droppedIds || {});
    if (archived === 'none') assert.equal(dropped.length, 0);
    else assert.deepEqual(dropped.sort(), ['op-000010', 'op-000011']);
  }
});

// Priya R1 (d041dba): an archived id is not proof. After a reload the page loads archived copies; a copy that failed
// readback, or a live record that changed after archiving, must never let the original leave history.
test('archived copies are checked by CONTENT at cut time: a wrong or stale copy never drops the original', async () => {
  const storage = memoryStorage(); seed(storage, 300);
  const live = new Map(envelope(storage).history.map(record => [record.id, record]));
  const copies = new Map();
  for (let i = 10; i <= 20; i++) copies.set(`op-${pad(i)}`, JSON.parse(JSON.stringify(live.get(`op-${pad(i)}`))));
  copies.get('op-000012').input = { ...copies.get('op-000012').input, n: 999 }; // copy differs from the original (failed readback)
  const state = envelope(storage); // the live record changes after it was archived (late mutation)
  state.history.find(record => record.id === 'op-000013').settledWrites.timer.n = 4242;
  storage.setItem(`${AC.BASE}:${OWNER}`, JSON.stringify(state));
  const offered = [];
  let counter = 0;
  const c = AC.createCoordinator({ storage, lock: (_, fn) => fn(), identity: () => ({ ...CTX }), randomId: () => `new-${pad(++counter)}`,
    same, transport: { enforcesAccounting: true, inspect: async () => ({}) },
    prepare: async () => ({ localOnly: true, projection: { entries: [], focusRedemptions: [] }, settledWrites: {} }),
    project: () => null, reconcile: null, apply: () => {},
    compaction: { historyCut: { enabled: true, keepOps: 50, batch: 1, archived: () => copies,
      onCandidates: (owner, records) => records.forEach(record => offered.push(record.id)) } } });
  await hydrate(c);
  const after = envelope(storage), dropped = Object.keys(after.droppedIds || {}).sort();
  const expected = [10, 11, 14, 15, 16, 17, 18, 19, 20].map(i => `op-${pad(i)}`);
  assert.deepEqual(dropped, expected);
  for (const id of ['op-000012', 'op-000013']) {
    assert.ok(after.history.some(record => record.id === id), `${id} stays in live history`);
    assert.ok(offered.includes(id), `${id} is offered for re-archiving`);
  }
  assert.equal(after.history.find(record => record.id === 'op-000013').settledWrites.timer.n, 4242);
});

test('flag off -> history grows exactly as before', async () => {
  const storage = memoryStorage(); seed(storage, 300);
  const c = coordinator(storage, { cut: false });
  await hydrate(c); await hydrate(c);
  const state = envelope(storage);
  assert.equal(state.history.length, 302);
  assert.equal(state.droppedIds, undefined);
});

test('a later cut folds the previous checkpoint in: checkpoints do not accumulate, walks stay identical', async () => {
  const storage = memoryStorage(); seed(storage, 300);
  const full = walk(envelope(storage), 'op-000300');
  const c = coordinator(storage, { keepOps: 50, batch: 10 });
  await hydrate(c); await hydrate(c);
  for (let i = 0; i < 70; i++) await hydrate(c); // new commits push old kept records out of the window
  const state = envelope(storage);
  const checkpoints = state.history.filter(r => r.input.name === 'checkpoint');
  assert.ok(checkpoints.length <= 2, `checkpoints: ${checkpoints.length}`);
  assert.doesNotThrow(() => c.snapshot(OWNER));
  // op-000300 is now dropped and no kept record names it (later commits are independent hydrates), so it maps to
  // the shared sink. A late item depending on it gets a walk that never waits and never vouches for a wrong
  // value: every path present is correct; missing paths make the observation conflict (replannable), fail closed.
  const cut = walk(state, 'op-000300');
  assert.notEqual(cut.wait, true, 'resolves, no endless wait');
  for (const [path, value] of Object.entries(cut)) assert.ok(AC.ancestorSame(value, full[path]), `path ${path}`);
});

test('load() rejects a corrupted map (fail closed)', () => {
  const storage = memoryStorage(); seed(storage, 60);
  const state = envelope(storage); state.droppedIds = { 'op-999999': 'ckpt-missing-0' };
  storage.setItem(`${AC.BASE}:${OWNER}`, JSON.stringify(state));
  assert.throws(() => coordinator(storage).snapshot(OWNER), /Unreadable accounting envelope/);
});
