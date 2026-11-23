// Storage wall (Jomar, 2026-11-22): a provisional Start that could not enter the full envelope stays in its intake
// slot. A later small heartbeat must never write a provisionalObserved marker for it into the envelope, or load()
// rejects the envelope ("Unreadable accounting envelope") on every load and logging stays paused permanently.
import test from 'node:test';
import assert from 'node:assert/strict';
import './accounting-command.js';

const { AccountingCommand } = globalThis;
const OWNER = 'uid_alice', ENVELOPE = `ta3-accounting-state-v1:${OWNER}`;

function fullStorage(envelopeLimit) {
  const data = new Map();
  const quota = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
  return { data,
    get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
    getItem: k => data.has(k) ? data.get(k) : null, removeItem: k => { data.delete(k); },
    setItem(k, v) { if (k === ENVELOPE && String(v).length > envelopeLimit) throw quota(); data.set(k, String(v)); } };
}

test('a heartbeat for a Start held in intake never writes an orphan provisionalObserved marker', async () => {
  const storage = fullStorage(400); let n = 0;
  const coordinator = AccountingCommand.createCoordinator({ storage, lock: (owner, fn) => fn(), transport: {},
    identity: () => ({ owner: OWNER, uid: 'alice', device: 'device-a', generation: 0 }),
    randomId: () => `op_test_${String(++n).padStart(4, '0')}`, same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    prepare: () => ({ status: 'wait', reason: 'test' }), project: () => null, reconcile: () => null, apply: () => {} });
  // The ~5K Start op: captured in its own slot, but too large for the envelope.
  const start = coordinator.capture({ name: 'ordinary-start', ordinary: { v: 1, kind: 'start' }, pad: 'x'.repeat(5000) }, { at: 1000 });
  // The small heartbeat for it: the envelope could grow by this much.
  await coordinator.observeProvisional(start.id, 2000);
  const raw = storage.getItem(ENVELOPE);
  if (raw != null) {
    const state = JSON.parse(raw);
    for (const id of Object.keys(state.provisionalObserved || {}))
      assert.ok([...state.queue, ...state.history].some(op => op.id === id), `envelope references ${id}, which it does not hold`);
  }
  assert.doesNotThrow(() => coordinator.snapshot(OWNER), 'the envelope must stay loadable');
  // Nothing is lost: the Start and its observation stay held in intake until the envelope has room.
  assert.ok(storage.getItem(`ta3-accounting-capture-v1:${OWNER}:${start.id}`), 'the Start stays in intake');
  assert.equal([...storage.data.keys()].filter(k => k.startsWith(`ta3-accounting-capture-v1:${OWNER}:`)).length, 2, 'the observation stays in intake too');
});
