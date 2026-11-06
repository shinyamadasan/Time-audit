// Performance Recovery V1 regressions: the indexed physical-key resolver must be exactly equivalent to the
// original scan, and settled bootstrap history must keep its payloads and replay protection intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './time-ack.js';
import './browser-extension/entry-physical-keys.js';
import './accounting-command.js';

const EPK = globalThis.EntryPhysicalKeys;
const { clone, createCoordinator, BASE } = globalThis.AccountingCommand;
const { same, stamp } = globalThis.TimeAckCore;

// The pre-index project() verbatim, as the reference for equivalence.
function referenceProject(raw) {
  const ids = [...new Map(Object.values(raw || {}).filter(record => record && record.id != null).map(record => [String(record.id), record.id])).values()];
  const entries = [], conflicts = [];
  for (const id of ids) {
    const basis = EPK.resolve(raw, id);
    if (basis.status === 'found') entries.push(basis.record);
    else conflicts.push(basis);
  }
  const malformed = Object.entries(raw || {}).filter(([, record]) => !record || record.id == null);
  if (malformed.length) conflicts.push({ status: 'unknown', reason: 'malformed-physical-record', physical: EPK.copy(malformed) });
  return { entries, conflicts };
}

function seeded(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

function randomRaw(rand) {
  const raw = {}, n = Math.floor(rand() * 40);
  const meta = r => r < 0.1 ? { v: 1, revision: 'bad' } : r < 0.5 ? undefined
    : { v: 1, protocol: 'staged-command-v1', revision: 2, baseRevision: 1, baseExists: true, operationId: 'op_12345678' };
  for (let i = 0; i < n; i++) {
    const id = 1 + Math.floor(rand() * 12), r = rand();
    const record = { id: r < 0.15 ? String(id) : id, activity: rand() < 0.5 ? 'A' : 'B', ts: id * 10 };
    const m = meta(rand()); if (m) record._csWrite = m;
    const k = rand();
    const key = k < 0.45 ? `e_${id}` : k < 0.8 ? String(id) : k < 0.9 ? `e_${1 + Math.floor(rand() * 12)}` : `x_${i}`;
    raw[key] = k > 0.97 ? null : rand() < 0.03 ? { activity: 'no id' } : record;
  }
  return raw;
}

test('indexed resolver returns exactly what resolve() returns, for every id, preference and tree shape', () => {
  const rand = seeded(20261105);
  for (let round = 0; round < 3000; round++) {
    const raw = randomRaw(rand);
    const lookup = EPK.resolver(raw);
    const probes = [...Array(14).keys()].flatMap(i => [i, String(i)]).concat([0, -1, 1.5, 'e_1', '', 'a.b', NaN]);
    for (const id of probes) {
      for (const prefer of ['app', 'extension']) {
        assert.deepEqual(lookup(id, prefer), EPK.resolve(raw, id, prefer), `round ${round} id ${String(id)} ${prefer}`);
      }
    }
    assert.deepEqual(EPK.project(raw), referenceProject(raw), `project round ${round}`);
  }
});

test('resolver results are independent copies: mutating one never changes the indexed tree', () => {
  const raw = { e_1: { id: 1, ts: 1 }, 1: { id: 1, ts: 1 } };
  const lookup = EPK.resolver(raw);
  const first = lookup(1);
  first.record.ts = 99; first.before['entries/e_1'].ts = 99;
  assert.deepEqual(lookup(1), EPK.resolve(raw, 1));
  assert.equal(raw.e_1.ts, 1);
});

function fixture() {
  const values = new Map();
  const storage = { get length() { return values.size; }, key: i => [...values.keys()][i],
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const context = { owner: 'uid_alice', uid: 'alice', device: 'a', generation: 1 };
  const raw = { entries: {} };
  let sends = 0, count = 0, tail = Promise.resolve();
  const lock = (owner, fn) => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
  const transport = {
    enforcesAccounting: true,
    async inspect() { return clone(raw); },
    async patch(owner, patch) {
      sends++;
      for (const [path, record] of Object.entries(patch)) {
        const parts = path.split('/'), child = parts.pop();
        let parent = raw; for (const part of parts) parent = parent[part] ||= {};
        parent[child] = clone(record);
      }
      return { status: 200, body: clone(patch) };
    },
  };
  const deps = { storage, lock, transport, identity: () => context, randomId: () => `command_${++count}`, same,
    prepare(op, original) {
      const before = Object.fromEntries(Object.keys(op.input.records).map(path => [path,
        path.split('/').reduce((node, part) => node?.[part], original) ?? null]));
      return { before, patch: Object.fromEntries(Object.entries(op.input.records).map(([path, value]) => [path, stamp(before[path], value, op.id)])),
        local: { cursor: op.input.cursor } };
    },
    project(current, op) { return { raw: current, ...op.proposal.local }; },
    apply() {},
  };
  const envelope = () => JSON.parse(values.get(`${BASE}:uid_alice`));
  return { values, create: () => createCoordinator(deps), envelope, get sends() { return sends; } };
}
const bootstrap = () => ({ name: 'hydrate-accounting', confirmedOnly: false,
  frame: { entries: [...Array(50).keys()].map(id => ({ id, ts: id })) }, sourceCaches: { 'ta3-entries': '[1,2,3]' },
  records: { 'entries/e_1': { id: 1, ts: 1 } }, cursor: 1 });
const later = () => ({ name: 'quick-save', records: { 'entries/e_2': { id: 2, ts: 2 } }, cursor: 2 });

test('the committed bootstrap read retains its full input', async () => {
  const f = fixture(), c = f.create();
  await c.submit(bootstrap());
  const [op] = f.envelope().history;
  assert.equal(op.compactedInput, undefined);
  assert.equal(op.input.frame.entries.length, 50);
});

test('a superseded settled bootstrap read retains every historical field and payload', async () => {
  const f = fixture(), c = f.create();
  await c.submit(bootstrap());
  const before = f.envelope().history[0];
  await c.submit(later());
  const state = f.envelope(), [op] = state.history;
  assert.deepEqual(op, before, 'all historical identity, payload and receipt fields remain unchanged');
  assert.equal(state.history.length, 2);
  assert.deepEqual(op.input, bootstrap());
  assert.deepEqual(state.history[1].input, later());
});

test('a replayed intake of a superseded read is recognised: not re-queued, not re-sent, no identity error', async () => {
  const f = fixture(), c = f.create();
  const original = c.capture(bootstrap());
  await c.drain();
  await c.submit(later());
  assert.deepEqual(f.envelope().history[0].input, original.input);
  const sends = f.sends;
  f.values.set(`ta3-accounting-capture-v1:uid_alice:${original.id}`, JSON.stringify(original));
  const result = await c.drain();
  assert.equal(result.status, 'drained');
  assert.equal(f.sends, sends);
  assert.equal(f.envelope().queue.length, 0);
  assert.equal(f.envelope().history.filter(op => op.id === original.id).length, 1);
});

test('a replayed intake whose retained facts changed is still refused', async () => {
  const f = fixture(), c = f.create();
  const original = c.capture(bootstrap());
  await c.drain();
  await c.submit(later());
  const forged = { ...original, input: { ...original.input, records: { 'entries/e_1': { id: 1, ts: 999 } } } };
  f.values.set(`ta3-accounting-capture-v1:uid_alice:${original.id}`, JSON.stringify(forged));
  await assert.rejects(c.drain(), /Accounting capture identity changed/);
});

test('snapshot() returns an independent object each call', async () => {
  const f = fixture(), c = f.create();
  await c.submit(bootstrap());
  const a = c.snapshot();
  a.history.length = 0; a.queue.push({ fake: true });
  assert.equal(c.snapshot().history.length, 1);
  assert.equal(c.snapshot().queue.length, 0);
});

test('a replayed intake cannot change historical bootstrap frames or source caches', async () => {
  const f = fixture(), c = f.create();
  const original = c.capture(bootstrap());
  await c.drain();
  await c.submit(later());
  const before = f.envelope();
  for (const field of ['frame', 'sourceCaches']) {
    const forged = { ...original, input: { ...original.input, [field]: null } };
    f.values.set(`ta3-accounting-capture-v1:uid_alice:${original.id}`, JSON.stringify(forged));
    await assert.rejects(c.drain(), /Accounting capture identity changed/);
    assert.deepEqual(f.envelope(), before, 'failed replay never modifies historical evidence');
  }
});
