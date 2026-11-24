import test from 'node:test';
import assert from 'node:assert/strict';
import './time-ack.js';
import './accounting-command.js';

const { AccountingCommand, TimeAckCore } = globalThis;
const OWNER = 'uid_alice';
const ENVELOPE = `${AccountingCommand.BASE}:${OWNER}`;

function fixture() {
  const values = new Map(), writes = [], removals = [], faults = {};
  const context = { owner: OWNER, uid: 'alice', device: 'device-a', generation: 0 };
  let locked = false, sequence = 0, tail = Promise.resolve();
  const storage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => {
      const raw = values.get(key) ?? null;
      return faults.read ? faults.read(key, raw) : raw;
    },
    setItem: (key, value) => {
      writes.push({ key, locked });
      faults.beforeWrite?.(key, String(value));
      const used = [...values].reduce((total, [slot, raw]) => total + slot.length + raw.length, 0);
      const previous = values.has(key) ? key.length + values.get(key).length : 0;
      if (used - previous + key.length + String(value).length > (faults.capacity ?? Infinity)) throw quota();
      values.set(key, String(value));
      faults.afterWrite?.(key, String(value));
    },
    removeItem: key => { faults.beforeRemove?.(key); removals.push(key); values.delete(key); },
  };
  const options = {
    storage, identity: () => ({ ...context }),
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
  return { values, writes, removals, faults, context, storage, options, coordinator, start, startSlot, startRaw, raw };
}

const quota = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
const restart = state => AccountingCommand.createCoordinator(state.options);
const observationSlots = state => [...state.values].filter(([slot, raw]) => slot.startsWith(`${AccountingCommand.INTAKE}:${OWNER}:`)
  && JSON.parse(raw).phase === 'provisional-observation');
const assertOriginalStart = state => {
  const retained = state.coordinator.snapshot().queue.filter(operation => operation.id === state.start.id);
  assert.equal(retained.length, 1);
  for (const [field, value] of Object.entries(state.start)) assert.deepEqual(retained[0][field], value);
};

test('a retained historical orphan observation recovers under the owner lock without changing its original facts', async () => {
  const state = fixture();
  await state.coordinator.drain();
  const recovered = state.coordinator.snapshot();
  assert.equal(recovered.provisionalObserved[state.start.id], 2000);
  assertOriginalStart(state);
  assert.deepEqual(recovered.history, []);
  assert.equal(recovered.generation, 0);
  assert.equal(recovered.committed, null);
  assert.ok(state.writes.filter(write => write.key === ENVELOPE).every(write => write.locked));
  const before = state.values.get(ENVELOPE);
  await AccountingCommand.createCoordinator(state.options).drain();
  assert.equal(state.values.get(ENVELOPE), before);
});

test('snapshot and restore remain synchronous fail-closed readers and never start repair', () => {
  const state = fixture();
  assert.throws(() => state.coordinator.snapshot(), /Unreadable accounting envelope/);
  assert.throws(() => state.coordinator.restore(), /Unreadable accounting envelope/);
  assert.deepEqual(state.writes, []);
  assert.equal(state.values.get(ENVELOPE), state.raw);
});

for (const stage of ['observation', 'envelope']) {
  test(`quota before the ${stage} write preserves the corrupt envelope and original Start`, async () => {
    const state = fixture();
    state.faults.beforeWrite = slot => { if ((slot === ENVELOPE) === (stage === 'envelope')) throw quota(); };
    const result = await state.coordinator.drain();
    assert.equal(result.status, 'storage-full');
    assert.equal(state.values.get(ENVELOPE), state.raw);
    assert.equal(state.values.get(state.startSlot), state.startRaw);
    assert.deepEqual(state.removals, []);
    assert.equal(observationSlots(state).length, stage === 'envelope' ? 1 : 0);
    delete state.faults.beforeWrite;
    await restart(state).drain();
    assertOriginalStart(state);
    assert.equal(state.coordinator.snapshot().provisionalObserved[state.start.id], 2000);
  });
}

test('a crash after durable observation but before replacement reuses exactly one observation on restart', async () => {
  const state = fixture();
  state.faults.beforeWrite = slot => { if (slot === ENVELOPE) throw Error('simulated crash'); };
  await assert.rejects(state.coordinator.drain(), /simulated crash/);
  assert.equal(state.values.get(ENVELOPE), state.raw);
  const observations = observationSlots(state);
  assert.equal(observations.length, 1);
  assert.equal(JSON.parse(observations[0][1]).at, 2000);
  assert.equal(state.values.get(state.startSlot), state.startRaw);
  delete state.faults.beforeWrite;
  state.writes.length = 0;
  await restart(state).drain();
  assert.equal(state.writes.filter(write => write.key === observations[0][0]).length, 0);
  assertOriginalStart(state);
});

for (const fault of ['throw', 'mismatch', 'quota']) {
  test(`unconfirmed replacement readback (${fault}) stops without restoration and retains every fact`, async () => {
    const state = fixture();
    let replaced = false;
    state.faults.afterWrite = slot => { if (slot === ENVELOPE) replaced = true; };
    state.faults.read = (slot, raw) => {
      if (slot === ENVELOPE && replaced) {
        if (fault === 'quota') throw quota();
        if (fault === 'throw') throw Error('replacement read fault');
        return null;
      }
      return raw;
    };
    if (fault === 'quota') assert.equal((await state.coordinator.drain()).status, 'storage-full');
    else await assert.rejects(state.coordinator.drain(), /readback failed|replacement read fault/);
    assert.equal(state.writes.filter(write => write.key === ENVELOPE).length, 1);
    assert.notEqual(state.values.get(ENVELOPE), state.raw);
    assert.deepEqual(JSON.parse(state.values.get(ENVELOPE)).history, []);
    assert.equal(state.values.get(state.startSlot), state.startRaw);
    assert.equal(JSON.parse(observationSlots(state)[0][1]).at, 2000);
    assert.deepEqual(state.removals, []);
    delete state.faults.read;
    delete state.faults.afterWrite;
    await restart(state).drain();
    assertOriginalStart(state);
    assert.equal(state.coordinator.snapshot().provisionalObserved[state.start.id], 2000);
  });
}

test('crash immediately after replacement preserves intake and resumes through the unchanged loader', async () => {
  const state = fixture();
  state.faults.afterWrite = slot => { if (slot === ENVELOPE) throw Error('post-replacement crash'); };
  await assert.rejects(state.coordinator.drain(), /post-replacement crash/);
  assert.equal(state.values.get(state.startSlot), state.startRaw);
  assert.equal(observationSlots(state).length, 1);
  assert.doesNotThrow(() => restart(state).snapshot());
  delete state.faults.afterWrite;
  await restart(state).drain();
  assertOriginalStart(state);
  assert.equal(state.coordinator.snapshot().provisionalObserved[state.start.id], 2000);
});

for (const mode of ['throw', 'mismatch']) {
  test(`observation readback ${mode} leaves the envelope byte-identical and can retry`, async () => {
    const state = fixture();
    let observationSlot;
    state.faults.afterWrite = slot => { if (slot !== ENVELOPE) observationSlot = slot; };
    state.faults.read = (slot, raw) => {
      if (slot === observationSlot) {
        if (mode === 'throw') throw Error('observation read fault');
        return null;
      }
      return raw;
    };
    await assert.rejects(state.coordinator.drain(), /observation read fault|observation readback failed/);
    assert.equal(state.values.get(ENVELOPE), state.raw);
    assert.equal(state.values.get(state.startSlot), state.startRaw);
    assert.deepEqual(state.removals, []);
    delete state.faults.read;
    delete state.faults.afterWrite;
    await restart(state).drain();
    assertOriginalStart(state);
  });
}

test('full envelope after replacement keeps the Start and observation in intake until space frees', async () => {
  const state = fixture();
  state.faults.beforeWrite = (slot, raw) => {
    if (slot === ENVELOPE && JSON.parse(raw).queue.length) throw quota();
  };
  await state.coordinator.drain();
  assert.doesNotThrow(() => state.coordinator.snapshot());
  assert.equal(state.coordinator.snapshot().queue.length, 0);
  assert.equal(state.values.get(state.startSlot), state.startRaw);
  assert.equal(observationSlots(state).length, 1);
  delete state.faults.beforeWrite;
  await restart(state).drain();
  assertOriginalStart(state);
  assert.equal(state.coordinator.snapshot().provisionalObserved[state.start.id], 2000);
});

test('a crash after Start import but before intake retirement replays without duplication', async () => {
  const state = fixture();
  state.faults.beforeRemove = slot => { if (slot === state.startSlot) throw Error('retirement crash'); };
  await assert.rejects(state.coordinator.drain(), /retirement crash/);
  assert.equal(state.values.get(state.startSlot), state.startRaw);
  assertOriginalStart(state);
  delete state.faults.beforeRemove;
  await restart(state).drain();
  assertOriginalStart(state);
  assert.equal(state.coordinator.snapshot().provisionalObserved[state.start.id], 2000);
  assert.equal(observationSlots(state).length, 0);
});

test('two simultaneous tabs serialize one recovery and import the original device facts exactly once', async () => {
  const state = fixture();
  const peer = AccountingCommand.createCoordinator({ ...state.options,
    identity: () => ({ ...state.context, generation: 9 }) });
  await Promise.all([state.coordinator.drain(), peer.drain()]);
  assertOriginalStart(state);
  assert.equal(peer.snapshot().provisionalObserved[state.start.id], 2000);
  assert.equal(peer.snapshot().queue[0].device, 'device-a');
  assert.equal(state.writes.filter(write => write.key.startsWith(`${AccountingCommand.INTAKE}:${OWNER}:`)).length, 1);
  assert.equal(state.writes.filter(write => write.key === ENVELOPE).every(write => write.locked), true);
  const replacements = state.writes.filter(write => write.key === ENVELOPE);
  const before = state.values.get(ENVELOPE);
  await Promise.all([peer.drain(), state.coordinator.drain()]);
  assert.equal(state.values.get(ENVELOPE), before);
  assert.ok(replacements.length > 0);
  assert.equal(state.values.get(state.startSlot), undefined);
});

test('a repairing tab copies the original Start device and generation rather than its own', async () => {
  const state = fixture();
  const peer = AccountingCommand.createCoordinator({ ...state.options,
    identity: () => ({ ...state.context, device: 'device-b', generation: 9 }) });
  state.faults.afterWrite = slot => { if (slot === ENVELOPE) throw Error('inspect replacement'); };
  await assert.rejects(peer.drain(), /inspect replacement/);
  const observed = JSON.parse(observationSlots(state)[0][1]);
  assert.equal(observed.device, 'device-a');
  assert.equal(observed.generation, 0);
  assert.equal(observed.uid, 'alice');
  assert.equal(observed.at, 2000);
  assert.equal(state.values.get(state.startSlot), state.startRaw);
  delete state.faults.afterWrite;
  await state.coordinator.drain();
  assertOriginalStart(state);
  assert.equal(state.coordinator.snapshot().provisionalObserved[state.start.id], 2000);
});

test('quota consumed by an unlocked writer after replacement does not trigger unsafe rollback', async () => {
  const state = fixture();
  let replaced = false;
  state.faults.afterWrite = slot => {
    if (slot === ENVELOPE) {
      replaced = true;
      const used = [...state.values].reduce((total, [key, raw]) => total + key.length + raw.length, 0);
      state.storage.setItem('settings', 'x'.repeat(state.faults.capacity - used - 'settings'.length));
    } else {
      state.faults.capacity = [...state.values].reduce((total, [key, raw]) => total + key.length + raw.length, 0);
    }
  };
  state.faults.read = (slot, raw) => { if (slot === ENVELOPE && replaced) throw quota(); return raw; };
  assert.equal((await state.coordinator.drain()).status, 'storage-full');
  assert.equal(state.writes.filter(write => write.key === ENVELOPE).length, 1);
  assert.equal(state.values.get(state.startSlot), state.startRaw);
  assert.equal(JSON.parse(observationSlots(state)[0][1]).at, 2000);
  delete state.faults.read;
  delete state.faults.afterWrite;
  assert.throws(() => state.storage.setItem(ENVELOPE, state.raw), { name: 'QuotaExceededError' });
  assert.doesNotThrow(() => state.coordinator.snapshot());
  delete state.faults.capacity;
  await restart(state).drain();
  assertOriginalStart(state);
  assert.equal(state.coordinator.snapshot().provisionalObserved[state.start.id], 2000);
});

test('recovery preserves committed history, receipts, projection and unrelated envelope fields', async () => {
  const state = fixture();
  const history = [{ v: 1, owner: OWNER, uid: 'alice', device: 'device-a', generation: 0,
    id: 'settled_history_0001', at: 500, input: { name: 'historical-command' }, phase: 'local-applied', appliedGeneration: 7 }];
  const committed = { operationId: history[0].id, generation: 7, value: { loggedTime: 987654 } };
  const envelope = { ...JSON.parse(state.raw), history, committed, generation: 7,
    effectReceipts: {}, extraEvidence: { original: true } };
  state.values.set(ENVELOPE, JSON.stringify(envelope));
  await state.coordinator.drain();
  const recovered = state.coordinator.snapshot();
  assert.deepEqual(recovered.history, history);
  assert.deepEqual(recovered.committed, committed);
  assert.deepEqual(recovered.effectReceipts, {});
  assert.deepEqual(recovered.extraEvidence, { original: true });
  assert.equal(recovered.generation, 7);
  assert.equal(recovered.provisionalObserved[state.start.id], 2000);
  assertOriginalStart(state);
});

test('multiple orphan observations retain exact separate timestamps across a partially completed repair', async () => {
  const state = fixture();
  const other = state.coordinator.capture({ name: 'start-timer', ordinary: { v: 1, kind: 'start' } }, { at: 3000 });
  const envelope = JSON.parse(state.raw);
  envelope.provisionalObserved[other.id] = 4567;
  const raw = JSON.stringify(envelope);
  state.values.set(ENVELOPE, raw);
  let observationWrites = 0;
  state.faults.beforeWrite = slot => {
    if (slot !== ENVELOPE && ++observationWrites === 2) throw Error('second observation crash');
  };
  await assert.rejects(state.coordinator.drain(), /second observation crash/);
  assert.equal(state.values.get(ENVELOPE), raw);
  assert.equal(observationSlots(state).length, 1);
  delete state.faults.beforeWrite;
  await restart(state).drain();
  const recovered = state.coordinator.snapshot();
  assert.deepEqual(recovered.provisionalObserved, { [state.start.id]: 2000, [other.id]: 4567 });
  assert.equal(recovered.queue.filter(operation => operation.id === other.id).length, 1);
  assertOriginalStart(state);
});

test('an observation exactly at Start time is retained across tied intake ordering and the next drain', async () => {
  const state = fixture();
  const envelope = JSON.parse(state.raw);
  envelope.provisionalObserved[state.start.id] = 1000;
  state.values.set(ENVELOPE, JSON.stringify(envelope));
  await state.coordinator.drain();
  assertOriginalStart(state);
  const pending = observationSlots(state);
  if (pending.length) assert.equal(JSON.parse(pending[0][1]).at, 1000);
  else assert.equal(state.coordinator.snapshot().provisionalObserved[state.start.id], 1000);
  await restart(state).drain();
  assert.equal(state.coordinator.snapshot().provisionalObserved[state.start.id], 1000);
  assert.equal(observationSlots(state).length, 0);
  assertOriginalStart(state);
});

for (const at of [null, 0, -1, 1.5, '2000', Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid marker timestamp ${JSON.stringify(at)} remains rejected`, async () => {
    const state = fixture();
    const envelope = JSON.parse(state.raw);
    envelope.provisionalObserved[state.start.id] = at;
    const raw = JSON.stringify(envelope);
    state.values.set(ENVELOPE, raw);
    await assert.rejects(state.coordinator.drain(), /Unreadable accounting envelope/);
    assert.equal(state.values.get(ENVELOPE), raw);
    assert.deepEqual(state.writes, []);
  });
}

test('a mismatched deterministic recovery slot is never overwritten', async () => {
  const state = fixture();
  state.faults.beforeWrite = slot => { if (slot === ENVELOPE) throw Error('hold replacement'); };
  await assert.rejects(state.coordinator.drain(), /hold replacement/);
  const [slot, raw] = observationSlots(state)[0];
  const changed = JSON.parse(raw);
  changed.device = 'wrong-device';
  const changedRaw = JSON.stringify(changed);
  state.values.set(slot, changedRaw);
  delete state.faults.beforeWrite;
  await assert.rejects(restart(state).drain(), /observation identity changed/);
  assert.equal(state.values.get(slot), changedRaw);
  assert.equal(state.values.get(ENVELOPE), state.raw);
  assert.equal(state.values.get(state.startSlot), state.startRaw);
});

for (const [name, change] of [
  ['owner', start => { start.owner = 'uid_bob'; }],
  ['uid', start => { start.uid = 'bob'; }],
  ['id', start => { start.id = 'different_start_0001'; }],
  ['device', start => { start.device = null; }],
  ['generation', start => { start.generation = -1; }],
  ['timestamp', start => { start.at = null; }],
  ['phase', start => { start.phase = 'awaiting-source'; start.source = { outcomes: [] }; }],
  ['ordinary version', start => { start.input.ordinary.v = 2; }],
  ['ordinary kind', start => { start.input.ordinary.kind = 'stop'; }],
  ['compacted input', start => { start.input.compacted = 1; }],
]) {
  test(`mismatched ${name} on the original Start stays rejected with no recovery writes`, async () => {
    const state = fixture();
    const start = JSON.parse(state.startRaw);
    change(start);
    const raw = JSON.stringify(start);
    state.values.set(state.startSlot, raw);
    await assert.rejects(state.coordinator.drain(), /Unreadable accounting/);
    assert.equal(state.values.get(ENVELOPE), state.raw);
    assert.equal(state.values.get(state.startSlot), raw);
    assert.deepEqual(state.writes, []);
  });
}

test('unrelated envelope corruption alongside the orphan is rejected before any intake write', async () => {
  const state = fixture();
  const envelope = JSON.parse(state.raw);
  envelope.generation = 1;
  const raw = JSON.stringify(envelope);
  state.values.set(ENVELOPE, raw);
  await assert.rejects(state.coordinator.drain(), /Unreadable accounting envelope/);
  assert.equal(state.values.get(ENVELOPE), raw);
  assert.deepEqual(state.writes, []);
});

test('an orphan naming an operation already held in sources is not the historical pattern', async () => {
  const state = fixture();
  const envelope = JSON.parse(state.raw);
  envelope.sources = [state.start];
  const raw = JSON.stringify(envelope);
  state.values.set(ENVELOPE, raw);
  await assert.rejects(state.coordinator.drain(), /Unreadable accounting envelope/);
  assert.equal(state.values.get(ENVELOPE), raw);
  assert.deepEqual(state.writes, []);
});

test('an orphan Start with a colliding event key cannot be silently aliased to another operation', async () => {
  const state = fixture();
  const start = { ...state.start, eventKey: 'original-event-key' };
  state.values.set(state.startSlot, JSON.stringify(start));
  const envelope = JSON.parse(state.raw);
  envelope.queue.push({ ...start, id: 'different_event_op_0001' });
  const raw = JSON.stringify(envelope);
  state.values.set(ENVELOPE, raw);
  await assert.rejects(state.coordinator.drain(), /Unreadable accounting envelope/);
  assert.equal(state.values.get(ENVELOPE), raw);
  assert.deepEqual(state.writes, []);
});

for (const source of ['envelope', 'Start']) {
  test(`a ${source} changed during observation retention is not overwritten or imported`, async () => {
    const state = fixture();
    const slot = source === 'envelope' ? ENVELOPE : state.startSlot;
    const replacement = JSON.stringify({ ...JSON.parse(state.values.get(slot)), changedByOtherWriter: true });
    state.faults.afterWrite = observationSlot => {
      if (observationSlot !== ENVELOPE) state.values.set(slot, replacement);
    };
    await assert.rejects(state.coordinator.drain(), /Accounting recovery (envelope|Start) changed/);
    assert.equal(state.values.get(slot), replacement);
    assert.equal(state.writes.filter(write => write.key === ENVELOPE).length, 0);
    assert.deepEqual(state.removals, []);
    assert.equal(observationSlots(state).length, 1);
  });
}

test('a read failure before repair creates no new facts and leaves the original envelope untouched', async () => {
  const state = fixture();
  state.faults.read = slot => { if (slot === ENVELOPE) throw Error('initial read fault'); return state.values.get(slot) ?? null; };
  await assert.rejects(state.coordinator.drain(), /initial read fault/);
  assert.equal(state.values.get(ENVELOPE), state.raw);
  assert.equal(state.values.get(state.startSlot), state.startRaw);
  assert.deepEqual(state.writes, []);
});

test('a malformed intake beside the original Start prevents any recovery write', async () => {
  const state = fixture();
  state.values.set(`${AccountingCommand.INTAKE}:${OWNER}:bad_capture_0001`, '{');
  await assert.rejects(state.coordinator.drain(), SyntaxError);
  assert.equal(state.values.get(ENVELOPE), state.raw);
  assert.equal(state.values.get(state.startSlot), state.startRaw);
  assert.deepEqual(state.writes, []);
});

test('valid envelopes and detached lock acquisitions do not trigger recovery writes', async () => {
  const state = fixture();
  const held = state.coordinator.drain();
  state.context.generation++;
  assert.equal((await held).status, 'detached');
  assert.deepEqual(state.writes, []);
  const envelope = JSON.parse(state.raw);
  delete envelope.provisionalObserved;
  state.values.set(ENVELOPE, JSON.stringify(envelope));
  state.values.delete(state.startSlot);
  await restart(state).drain();
  assert.deepEqual(state.writes, []);
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
