import test from 'node:test';
import assert from 'node:assert/strict';
import './time-ack.js';
import './accounting-command.js';

const { AccountingCommand, TimeAckCore } = globalThis;
const OWNER = 'uid_alice';
const ENVELOPE = `${AccountingCommand.BASE}:${OWNER}`;

function fixture() {
  const values = new Map(), writes = [];
  let locked = false, sequence = 0, tail = Promise.resolve();
  const storage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes.push({ key, locked }); values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
  };
  const options = {
    storage, identity: () => ({ owner: OWNER, uid: 'alice', device: 'device-a', generation: 0 }),
    randomId: () => `orphan_test_${String(++sequence).padStart(4, '0')}`,
    same: TimeAckCore.same, transport: {},
    lock: (owner, action) => {
      assert.equal(owner, OWNER);
      const next = tail.then(async () => { locked = true; try { return await action(); } finally { locked = false; } });
      tail = next.catch(() => {});
      return next;
    },
    prepare: () => ({ status: 'wait', reason: 'qualification-held' }),
    project: () => null, reconcile: () => null, apply: () => {},
  };
  const coordinator = AccountingCommand.createCoordinator(options);
  const start = coordinator.capture({ name: 'ordinary-start', ordinary: { v: 1, kind: 'start' }, original: 'retained Start' }, { at: 1000 });
  const startSlot = `${AccountingCommand.INTAKE}:${OWNER}:${start.id}`;
  const startRaw = values.get(startSlot);
  const raw = JSON.stringify({ v: 1, owner: OWNER, generation: 0, committed: null,
    queue: [], history: [], provisionalObserved: { [start.id]: 2000 } });
  values.set(ENVELOPE, raw);
  writes.length = 0;
  return { values, writes, storage, options, coordinator, start, startSlot, startRaw, raw };
}

test('a retained historical orphan observation recovers under the owner lock without changing its original facts', async () => {
  const state = fixture();
  await state.coordinator.drain();
  const recovered = state.coordinator.snapshot();
  assert.equal(recovered.provisionalObserved[state.start.id], 2000);
  const retained = recovered.queue.find(operation => operation.id === state.start.id);
  assert.ok(retained);
  for (const [field, value] of Object.entries(state.start)) assert.deepEqual(retained[field], value);
  assert.deepEqual(recovered.history, []);
  assert.equal(recovered.generation, 0);
  assert.equal(recovered.committed, null);
  assert.ok(state.writes.filter(write => write.key === ENVELOPE).every(write => write.locked));
  const before = state.values.get(ENVELOPE);
  await AccountingCommand.createCoordinator(state.options).drain();
  assert.equal(state.values.get(ENVELOPE), before);
});

test('an orphan marker without its original Start remains unreadable and byte-identical', async () => {
  const state = fixture();
  state.values.delete(state.startSlot);
  await assert.rejects(state.coordinator.drain(), /Unreadable accounting envelope/);
  assert.equal(state.values.get(ENVELOPE), state.raw);
  assert.deepEqual(state.writes, []);
});

test('an observation earlier than its retained Start remains unreadable and preserves the Start', async () => {
  const state = fixture();
  const envelope = JSON.parse(state.raw);
  envelope.provisionalObserved[state.start.id] = 999;
  const raw = JSON.stringify(envelope);
  state.values.set(ENVELOPE, raw);
  await assert.rejects(state.coordinator.drain(), /Unreadable accounting envelope/);
  assert.equal(state.values.get(ENVELOPE), raw);
  assert.equal(state.values.get(state.startSlot), state.startRaw);
  assert.deepEqual(state.writes, []);
});
