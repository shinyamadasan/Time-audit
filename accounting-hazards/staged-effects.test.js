import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../time-ack.js';
import '../accounting-command.js';

const { clone, createCoordinator, BASE } = globalThis.AccountingCommand;
const { same, stamp } = globalThis.TimeAckCore;
function fixture() {
  const values = new Map();
  const storage = { get length() { return values.size; }, key: i => [...values.keys()][i],
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let context = { owner: 'uid_alice', uid: 'alice', device: 'a', generation: 1 };
  let raw = { entries: {}, timer: { ownerRoom: 'uid_alice', cursor: 0 } }, sends = 0, prepares = 0, applied = null;
  let loseReply = false, offline = false, projectionUnavailable = false;
  let tail = Promise.resolve(), count = 0;
  const lock = (owner, fn) => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
  const transport = {
    enforcesAccounting: true,
    async inspect() { if (offline) throw Error('offline'); return clone(raw); },
    async patch(owner, patch) {
      sends++;
      for (const [path, record] of Object.entries(patch)) {
        if (raw.timeAckCancellations?.[record._csWrite.operationId] === true) return { status: 401 };
        const old = path.split('/').reduce((node, part) => node?.[part], raw);
        if ((old?._csWrite?.revision || 0) !== record._csWrite.baseRevision) return { status: 401 };
      }
      for (const [path, record] of Object.entries(patch)) {
        const parts = path.split('/'), child = parts.pop();
        let parent = raw; for (const part of parts) parent = parent[part] ||= {};
        parent[child] = clone(record);
      }
      if (loseReply) { loseReply = false; throw Error('lost reply'); }
      return { status: 200, body: clone(patch) };
    },
  };
  const deps = { storage, lock, transport, identity: () => context, randomId: () => `command_${++count}`, same,
    prepare(op, original) {
      prepares++;
      const before = Object.fromEntries(Object.keys(op.input.records).map(path => [path,
        path.split('/').reduce((node, part) => node?.[part], original) ?? null]));
      return { before, patch: Object.fromEntries(Object.entries(op.input.records).map(([path, value]) => [path, stamp(before[path], value, op.id)])),
        local: { cursor: op.input.cursor, undo: op.input.undo } };
    },
    project(current, op) { if (projectionUnavailable) return null; return { raw: current, ...op.proposal.local }; },
    apply(value) { applied = value; },
  };
  return { storage, values, transport, deps, create: () => createCoordinator(deps),
    get context() { return context; }, set context(value) { context = value; },
    get raw() { return raw; }, set raw(value) { raw = value; },
    get applied() { return applied; }, get sends() { return sends; }, get prepares() { return prepares; },
    set offline(value) { offline = value; }, set loseReply(value) { loseReply = value; },
    set projectionUnavailable(value) { projectionUnavailable = value; } };
}
const input = () => ({ records: { 'entries/e_1': { id: 1, tsStart: 0, ts: 10, duration: 10 }, timer: { ownerRoom: 'uid_alice', cursor: 10 } }, cursor: 10, undo: 'original undo' });

test('malformed original revision provenance cannot be normalized by a detached reducer or sealed proposal', async () => {
  const good = { v: 1, revision: 1, baseRevision: 0, baseExists: false, operationId: 'prior_writer' };
  for (const metadata of [{ ...good, baseExists: 'corrupt' }, { ...good, baseRevision: 'corrupt' },
    { ...good, operationId: null }, { v: 1, revision: 1 }]) {
    assert.throws(() => stamp({ _csWrite: metadata }, { cursor: 10 }, 'command_original'), /Invalid stored revision/);
    const f = fixture(); f.raw.timer._csWrite = metadata;
    f.deps.prepare = (op, raw) => ({ before: { timer: raw.timer },
      patch: { timer: { ...raw.timer, cursor: 10, _csWrite: { ...good, baseExists: true, baseRevision: 1, revision: 2, operationId: op.id } } },
      local: { cursor: 10, undo: 'original undo' } });
    const c = f.create(); await c.submit(input());
    assert.equal(f.sends, 0); assert.equal(c.snapshot().queue[0].phase, 'conflict');
    assert.deepEqual(f.raw.timer._csWrite, metadata);
  }
});

for (const fault of ['quota', 'readback']) {
test(`failed ${fault} capture retains the complete original identity and input until readback before callback or send`, async () => {
  const f = fixture(), c = f.create(), write = f.storage.setItem, read = f.storage.getItem;
  let fail = true, callbacks = 0, callbackOperation;
  f.storage.setItem = (key, raw) => { if (fail && fault === 'quota' && key.startsWith(AccountingCommand.INTAKE)) throw Error('quota'); return write(key, raw); };
  f.storage.getItem = key => { if (fail && fault === 'readback' && key.startsWith(AccountingCommand.INTAKE) && f.values.has(key)) throw Error('readback'); return read(key); };
  const original = input();
  assert.throws(() => c.submit(original, { at: 123, eventKey: 'original-event', onCaptured(op) { callbacks++; callbackOperation = op; } }));
  original.cursor = 999;
  const retained = c.failedCaptures('uid_alice');
  assert.equal(retained.length, 1); assert.equal(retained[0].input.cursor, 10);
  assert.equal(retained[0].at, 123); assert.equal(callbacks, 0); assert.equal(f.sends, 0);
  await assert.rejects(c.drain()); assert.equal(callbacks, 0); assert.equal(f.sends, 0);
  fail = false; await c.drain(); await c.drain();
  assert.equal(callbacks, 1); assert.equal(callbackOperation.id, retained[0].id);
  assert.deepEqual(callbackOperation.input, retained[0].input); assert.equal(f.sends, 1);
  assert.equal(c.failedCaptures('uid_alice').length, 0); assert.equal(c.snapshot().history[0].id, retained[0].id);
});
}

test('failed capture stays in its original owner partition and precedes its durable dependent after reattachment', async () => {
  const f = fixture(), c = f.create(), write = f.storage.setItem;
  f.storage.setItem = () => { throw Error('quota'); };
  assert.throws(() => c.capture(input(), { at: 123 }));
  const original = c.failedCaptures('uid_alice')[0];
  f.storage.setItem = write;
  f.context = { owner: 'uid_bob', uid: 'bob', device: 'b', generation: 2 };
  await c.drain(); assert.equal(c.failedCaptures('uid_alice').length, 1); assert.equal(f.sends, 0);
  f.context = { owner: 'uid_alice', uid: 'alice', device: 'a', generation: 3 };
  const child = c.capture({ ...input(), cursor: 20 }, { at: 124, dependsOn: original.id });
  await c.drain();
  assert.deepEqual(c.snapshot().history.map(op => op.id), [original.id, child.id]); assert.equal(f.sends, 2);
});

test('read-only recovery beside failed capture retires its intake and applies its receipt only once', async () => {
  const f = fixture(), prepare = f.deps.prepare;
  f.deps.prepare = (operation, raw) => operation.input.name === 'hydrate-accounting'
    ? { localOnly: true, projection: { cursor: 99 } } : prepare(operation, raw);
  const c = f.create(), write = f.storage.setItem;
  f.storage.setItem = (key, raw) => {
    if (key.startsWith(AccountingCommand.INTAKE) && JSON.parse(raw).input.name !== 'hydrate-accounting') throw Error('quota');
    return write(key, raw);
  };
  assert.throws(() => c.capture(input()));
  await c.submit({ name: 'hydrate-accounting', confirmedOnly: true });
  await assert.rejects(c.drain());
  assert.equal(c.snapshot().generation, 1); assert.equal(c.snapshot().history.length, 1);
  assert.equal(c.captures('uid_alice').length, 0); assert.equal(c.failedCaptures('uid_alice').length, 1); assert.equal(f.sends, 0);
});

test('native request is retained before handoff without blocking unrelated commands', async () => {
  const f = fixture(), c = f.create();
  const source = c.reserveSource({ ...input(), request: { startTime: 1, endTime: 10 } });
  assert.equal(c.captures('uid_alice')[0].captured.id, source.id);
  await c.submit(input());
  assert.equal(c.snapshot().sources[0].id, source.id);
  assert.equal(c.snapshot().history.length, 1);
  assert.equal(f.sends, 1);
});

test('confirmed-only hydration can refresh a retained head without changing its immutable proposal or retiring it', async () => {
  const f = fixture(), prepare = f.deps.prepare;
  f.deps.prepare = (operation, raw) => operation.input.name === 'hydrate-accounting'
    ? { localOnly: true, projection: { cursor: 99, undo: null }, settledWrites: { timer: raw.timer } } : prepare(operation, raw);
  const c = f.create(); f.loseReply = true; await c.submit(input());
  f.raw = { ...f.raw, timer: { cursor: 99, ownerRoom: 'uid_alice' } };
  const original = clone(c.snapshot().queue[0]);
  await c.submit({ name: 'hydrate-accounting', confirmedOnly: true });
  const state = c.snapshot();
  assert.equal(state.committed.value.cursor, 99); assert.equal(state.queue.length, 1);
  assert.deepEqual(state.queue[0].proposal, original.proposal); assert.deepEqual(state.queue[0].input, original.input);
  assert.equal(state.history.filter(item => item.input.name === 'hydrate-accounting').length, 1);
  assert.equal(f.sends, 1);
});

test('confirmed-only hydration cannot bypass the pending head to send a domain mutation', async () => {
  const f = fixture(), c = f.create(); f.loseReply = true; await c.submit(input());
  f.raw = { ...f.raw, timer: { cursor: 99, ownerRoom: 'uid_alice' } };
  await c.submit({ ...input(), name: 'hydrate-accounting', confirmedOnly: true });
  assert.equal(f.sends, 1); assert.equal(c.snapshot().queue.length, 2);
  assert.equal(c.snapshot().queue[1].reason, 'confirmed-refresh-must-be-read-only');
});

test('a stored mutating proposal cannot disguise itself as a captured confirmed-only refresh', async () => {
  const f = fixture(), c = f.create(); f.loseReply = true; await c.submit(input());
  f.raw = { ...f.raw, timer: { cursor: 99, ownerRoom: 'uid_alice' } };
  const state = c.snapshot(), read = c.capture({ name: 'hydrate-accounting', confirmedOnly: true });
  const proposal = f.deps.prepare({ ...read, input: input() }, f.raw);
  for (const record of Object.values(proposal.patch)) record._csWrite.protocol = 'staged-command-v1';
  f.storage.removeItem(c.captures('uid_alice')[0].slot);
  state.queue.push({ ...read, proposal }); f.storage.setItem(`${BASE}:uid_alice`, JSON.stringify(state));
  await c.drain(); assert.equal(f.sends, 1);
  assert.equal(c.snapshot().queue[1].reason, 'confirmed-refresh-must-be-read-only');
});

for (const corrupt of ['path', 'identity', 'revision', 'before-paths']) {
test(`stored sealed proposal rejects corrupted ${corrupt} before transport handoff`, async () => {
  const f = fixture(), c = f.create(); f.transport.enforcesAccounting = false; await c.submit(input());
  const state = c.snapshot(), operation = state.queue[0];
  operation.proposal = f.deps.prepare(operation, f.raw); operation.phase = 'sealed';
  for (const record of Object.values(operation.proposal.patch)) record._csWrite.protocol = 'staged-command-v1';
  if (corrupt === 'path') {
    operation.proposal.patch.settings = stamp(null, { unrelatedSetting: 'unauthorized scope' }, operation.id);
    operation.proposal.patch.settings._csWrite.protocol = 'staged-command-v1'; delete operation.proposal.patch.timer;
    operation.proposal.before.settings = null; delete operation.proposal.before.timer;
  } else if (corrupt === 'identity') operation.proposal.patch.timer._csWrite.operationId = 'different_operation';
  else if (corrupt === 'revision') operation.proposal.patch.timer._csWrite.revision = 900;
  else delete operation.proposal.before.timer;
  f.storage.setItem(`${BASE}:uid_alice`, JSON.stringify(state)); f.transport.enforcesAccounting = true;
  await c.drain(); assert.equal(f.sends, 0);
  assert.equal(c.snapshot().queue[0].reason, 'sealed-proposal-unreadable');
});
}

test('native result survives detach and restart with its original owner, request and identity', async () => {
  const f = fixture(), c = f.create(), source = c.reserveSource(input());
  f.context = { ...f.context, owner: 'uid_bob', uid: 'bob', generation: 2 };
  c.completeSource(source, { ok: true, events: [{ pkg: 'app', type: 1, ts: 1 }] });
  await c.drain(); assert.equal(f.sends, 0);
  f.context = { owner: 'uid_alice', uid: 'alice', device: 'a', generation: 3 };
  await f.create().drain();
  const accepted = c.snapshot().history[0];
  assert.equal(accepted.id, source.id); assert.deepEqual(accepted.input, source.input);
  assert.deepEqual(accepted.source.result.events, [{ pkg: 'app', type: 1, ts: 1 }]);
  assert.equal(f.sends, 1);
});

test('native query failures retain the exact request and are distinct from successful empty results', async () => {
  const f = fixture(), c = f.create(), source = c.reserveSource(input());
  c.completeSource(source, { ok: false, error: 'PERMISSION_DENIED' });
  await c.drain(); assert.equal(f.sends, 0);
  assert.equal(c.snapshot().sources[0].source.outcomes[0].result.error, 'PERMISSION_DENIED');
  c.completeSource(source, { ok: true, events: [] });
  await c.drain(); assert.equal(f.sends, 1);
  assert.equal(c.snapshot().history[0].source.outcomes.length, 2);
});

test('failed native result readback retains original bytes and imports once on restart', async () => {
  const f = fixture(), c = f.create(), source = c.reserveSource(input());
  const get = f.storage.getItem;
  f.storage.getItem = key => key.includes(':result:') && f.values.has(key) ? 'unconfirmed' : get(key);
  assert.throws(() => c.completeSource(source, { ok: true, events: [] }), /readback/);
  f.storage.getItem = get;
  await f.create().drain(); await f.create().drain();
  assert.equal(f.sends, 1); assert.equal(c.snapshot().history.length, 1);
});

function focusEffectFixture() {
  const f = fixture(), prepare = f.deps.prepare;
  f.deps.prepare = (operation, raw) => ({ ...prepare(operation, raw), effects: [{
    v: 1, id: `${operation.id}:focus-completed`, operationId: operation.id, owner: operation.owner, device: operation.device,
    kind: 'focus-completed', entry: { id: 1, tsStart: 0, ts: 10 },
  }] });
  return f;
}

test('causal Focus callbacks become durable only with their accepted local projection', async () => {
  const f = focusEffectFixture(), c = f.create(); f.loseReply = true;
  await c.submit(input()); assert.equal(c.snapshot().effects, undefined);
  await c.drain(); assert.equal(c.snapshot().effects.length, 1);
  const calls = [];
  await c.runEffects((effect, committed) => { calls.push(effect); assert.equal(committed.cursor, 10); return true; });
  assert.equal(c.snapshot().effects.length, 0); assert.equal(calls.length, 1);
  await f.create().runEffects(() => { throw Error('must not repeat a receipted effect'); });
  assert.equal(c.snapshot().effectReceipts[calls[0].id].operationId, calls[0].operationId);
});

test('interrupted Focus effect receipt retries the original idempotent callback after restart', async () => {
  const f = focusEffectFixture(), c = f.create(); await c.submit(input());
  const write = f.storage.setItem, domain = new Map();
  f.storage.setItem = (key, raw) => { if (JSON.parse(raw).effectReceipts) throw Error('interrupted effect receipt'); return write(key, raw); };
  const perform = effect => { domain.set(effect.entry.id, clone(effect.entry)); return true; };
  await assert.rejects(c.runEffects(perform), /interrupted effect receipt/);
  assert.equal(c.snapshot().effects.length, 1); assert.equal(domain.size, 1);
  f.storage.setItem = write; await f.create().runEffects(perform);
  assert.equal(c.snapshot().effects.length, 0); assert.equal(domain.size, 1);
});

test('unavailable or failed Focus callbacks retain their exact facts and order', async () => {
  const f = focusEffectFixture(), c = f.create(); await c.submit(input());
  const original = clone(c.snapshot().effects);
  assert.equal((await c.runEffects(() => false)).status, 'effects-retained');
  assert.deepEqual(c.snapshot().effects, original);
  assert.equal((await c.runEffects(() => { throw Error('callback unavailable'); })).status, 'effects-retained');
  assert.deepEqual(c.snapshot().effects, original);
});

test('Focus callback delivery cannot cross account/device attachment changes', async () => {
  const f = focusEffectFixture(), c = f.create(); await c.submit(input());
  f.context = { ...f.context, device: 'replacement-device', generation: 2 };
  let calls = 0;
  assert.equal((await c.runEffects(() => { calls++; })).reason, 'captured-owner-device');
  assert.equal(calls, 0);
  f.context = { ...f.context, device: 'a', generation: 3 };
  assert.equal((await c.runEffects(() => { f.context = { owner: 'uid_bob', uid: 'bob', device: 'a', generation: 4 }; return true; })).status, 'detached');
  assert.equal(c.snapshot('uid_alice').effects.length, 1);
});

test('fencing an unsubmitted command cannot dispatch its proposed Focus completion', async () => {
  const f = focusEffectFixture(); enableCancellation(f);
  f.transport.patch = async () => { throw Error('not delivered'); };
  const c = f.create(); await c.submit(input());
  await c.cancel(c.snapshot().queue[0].id);
  assert.equal(c.snapshot().effects, undefined);
});

test('unreadable effect state refuses inspection/send and preserves the original envelope', async () => {
  const f = fixture(), c = f.create();
  const raw = JSON.stringify({ v: 1, owner: 'uid_alice', generation: 0, committed: null, queue: [], history: [], effects: { unknown: 'original bytes' } });
  f.values.set(`${BASE}:uid_alice`, raw);
  await assert.rejects(c.drain(), /Unreadable accounting envelope/);
  assert.equal(f.values.get(`${BASE}:uid_alice`), raw); assert.equal(f.sends, 0);
});

test('producer continuation advances only after its exact original fact has durable readback', async () => {
  const f = fixture(), c = f.create();
  let continued = false;
  const pending = c.submit(input(), { onCaptured(operation) {
    assert.deepEqual(c.captures('uid_alice')[0].captured, operation);
    assert.equal(f.prepares, 0); assert.equal(f.sends, 0); continued = true;
  } });
  assert.equal(continued, true); await pending;
  const broken = fixture(), next = broken.create(); let advanced = false;
  broken.storage.setItem = () => { throw Error('failed original capture'); };
  assert.throws(() => next.submit(input(), { onCaptured() { advanced = true; } }), /failed original capture/);
  assert.equal(advanced, false); assert.equal(broken.sends, 0);
});

function enableCancellation(f) {
  f.transport.enforcesCancellation = true;
  f.transport.cancel = async (owner, id) => { (f.raw.timeAckCancellations ||= {})[id] = true; };
  f.deps.reconcile = raw => ({ raw, cursor: raw.timer.cursor, undo: null });
}

test('concurrent drains coalesce while preserving a trigger captured during an inspection', async () => {
  const f = fixture(), originalLock = f.deps.lock, inspect = f.transport.inspect;
  let locks = 0, release, entered;
  const observed = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.deps.lock = (owner, fn) => { locks++; return originalLock(owner, fn); };
  let first = true;
  f.transport.inspect = async owner => { if (first) { first = false; entered(); await held; } return inspect(owner); };
  const c = f.create(); c.capture(input());
  const draining = c.drain(); await observed;
  const calls = Array.from({ length: 100 }, () => c.drain());
  const child = input(); child.records = { 'entries/e_2': { id: 2, tsStart: 10, ts: 20 } }; child.cursor = 20;
  c.capture(child); calls.push(c.drain()); release();
  const results = await Promise.all([draining, ...calls]);
  assert.ok(results.every(result => result.status === 'drained'));
  assert.ok(locks <= 2, `Expected one active drain and at most one queued recheck, got ${locks}`);
  assert.equal(c.snapshot().history.length, 2); assert.equal(f.sends, 2); assert.equal(f.applied.cursor, 20);
});

test('a trigger in the drain completion window waits for its actual result', async () => {
  const f = fixture(), originalLock = f.deps.lock;
  let first = true, late, c;
  f.deps.lock = (owner, fn) => originalLock(owner, fn).then(result => {
    if (first) {
      first = false;
      queueMicrotask(() => queueMicrotask(() => { c.capture(input()); late = c.drain(); }));
    }
    return result;
  });
  c = f.create();
  const result = await c.drain(); await late;
  assert.equal(result.generation, 1);
  assert.equal(f.prepares, 1); assert.equal(f.sends, 1);
  assert.equal(c.captures('uid_alice').length, 0);
  assert.equal(c.snapshot().queue.length, 0);
});

test('authenticated hydration commits its projection and receipt together without publishing a remote write', async () => {
  const f = fixture();
  f.deps.prepare = (operation, raw) => ({ localOnly: true, projection: { raw, cursor: raw.timer.cursor }, settledWrites: { timer: raw.timer } });
  const c = f.create();
  assert.equal((await c.submit({ name: 'hydrate-accounting', frame: { cursor: 0 } })).status, 'drained');
  assert.equal(f.sends, 0); assert.equal(f.applied.cursor, 0);
  assert.equal(c.snapshot().history[0].authority, 'coherent-account-read');
  assert.equal(c.snapshot().committed.operationId, c.snapshot().history[0].id);
  assert.deepEqual(c.snapshot().history[0].settledWrites.timer, f.raw.timer);
});

test('failed hydration commit retains the original captured cache and can repeat a coherent read after restart', async () => {
  const f = fixture();
  f.deps.prepare = (operation, raw) => ({ localOnly: true, projection: { raw, cursor: raw.timer.cursor } });
  const c = f.create(), write = f.storage.setItem;
  f.storage.setItem = (key, value) => { if (key.startsWith(BASE) && JSON.parse(value).committed) throw Error('quota'); return write(key, value); };
  await assert.rejects(c.submit({ name: 'hydrate-accounting', frame: { original: 'cache facts' } }), /quota/);
  assert.equal(f.applied, null); assert.equal(f.sends, 0);
  assert.equal(c.snapshot().queue[0].input.frame.original, 'cache facts');
  f.storage.setItem = write;
  assert.equal((await f.create().drain()).status, 'drained');
  assert.equal(f.applied.cursor, 0);
});

test('a staged writer waits for its hydration parent even when its event clock sorts earlier', async () => {
  const f = fixture(), prepare = f.deps.prepare;
  f.deps.prepare = (operation, raw) => operation.input.name === 'hydrate-accounting'
    ? { localOnly: true, projection: { raw, cursor: 0 } } : prepare(operation, raw);
  const c = f.create(), parent = c.capture({ name: 'hydrate-accounting' }, { at: 10 });
  const child = c.capture(input(), { at: 5, dependsOn: parent.id });
  assert.equal((await c.drain()).status, 'drained');
  assert.deepEqual(c.snapshot().history.map(operation => operation.id), [parent.id, child.id]);
  assert.equal(f.sends, 1); assert.equal(f.applied.cursor, 10);
});

test('permanent cancellation survives a lost response and refuses the exact original late request', async () => {
  const f = fixture(); enableCancellation(f);
  const patch = f.transport.patch;
  f.transport.patch = async () => { throw Error('request in flight'); };
  const c = f.create(); await c.submit(input());
  const original = c.snapshot().queue[0];
  f.transport.cancel = async (owner, id) => { (f.raw.timeAckCancellations ||= {})[id] = true; throw Error('lost cancellation reply'); };
  assert.equal((await c.cancel(original.id)).status, 'fenced-reconciled');
  assert.equal(c.snapshot().queue.length, 0);
  assert.equal(c.snapshot().history[0].authority, 'permanent-operation-fence');
  assert.deepEqual(c.snapshot().history[0].proposal, original.proposal);
  assert.equal((await patch('uid_alice', original.proposal.patch)).status, 401);
  assert.equal(f.applied.cursor, 0);
});

test('unproven cancellation capability neither sends a marker nor resumes the original command', async () => {
  const f = fixture(), c = f.create();
  f.transport.patch = async () => { throw Error('in flight'); };
  await c.submit(input()); const original = c.snapshot().queue[0];
  f.transport.cancel = () => { throw Error('must not call'); };
  assert.equal((await c.cancel(original.id)).reason, 'cancellation-fence-unproven');
  assert.equal((await c.drain()).reason, 'cancellation-fence-unproven');
  assert.equal(c.snapshot().queue[0].phase, 'cancelling');
  assert.deepEqual(c.snapshot().queue[0].proposal, original.proposal);
});

test('resumed cancellation cannot bypass the captured device guard', async () => {
  const f = fixture(), c = f.create();
  f.transport.patch = async () => { throw Error('in flight'); };
  await c.submit(input()); const original = c.snapshot().queue[0];
  await c.cancel(original.id);
  enableCancellation(f); let markers = 0;
  f.transport.cancel = async () => { markers++; };
  f.context = { ...f.context, device: 'replacement-device', generation: 2 };
  assert.equal((await c.drain()).reason, 'captured-owner-device');
  assert.equal(markers, 0);
  assert.equal(c.snapshot().queue[0].phase, 'cancelling');
  assert.deepEqual(c.snapshot().queue[0].proposal, original.proposal);
});

test('a proven fence cannot retire unresolved facts when coherent reconciliation is unavailable', async () => {
  const f = fixture(); enableCancellation(f); f.deps.reconcile = () => null;
  f.transport.patch = async () => { throw Error('in flight'); };
  const c = f.create(); await c.submit(input()); const original = c.snapshot().queue[0];
  c.capture({ ...input(), originalFact: 'must remain' }, { dependsOn: original.id });
  assert.equal((await c.cancel(original.id)).reason, 'fenced-reconciliation-unconfirmed');
  assert.equal(c.snapshot().queue.length, 2);
  assert.equal(c.snapshot().history.length, 0);
  assert.deepEqual(c.snapshot().queue[0].input, original.input);
  assert.equal(c.snapshot().queue[1].input.originalFact, 'must remain');
  assert.equal(f.applied, null);
});

test('interrupted cancellation local commit is repaired at boot without resending original writes', async () => {
  const f = fixture(); enableCancellation(f);
  f.transport.patch = async () => { throw Error('in flight'); };
  const c = f.create(); await c.submit(input()); const original = c.snapshot().queue[0];
  const write = f.storage.setItem;
  f.storage.setItem = (key, raw) => { if (key.startsWith(BASE) && JSON.parse(raw).committed) throw Error('quota'); return write(key, raw); };
  await assert.rejects(c.cancel(original.id), /quota/);
  assert.equal(c.snapshot().queue[0].phase, 'cancelling'); assert.equal(f.applied, null);
  f.storage.setItem = write;
  assert.equal((await f.create().drain()).status, 'drained');
  assert.equal(f.applied.cursor, 0); assert.equal(f.sends, 0);
});

test('account detach during permanent fencing retains resolution for the original owner', async () => {
  const f = fixture(); enableCancellation(f);
  f.transport.patch = async () => { throw Error('in flight'); };
  const c = f.create(); await c.submit(input()); const original = c.snapshot().queue[0];
  f.transport.cancel = async (owner, id) => {
    (f.raw.timeAckCancellations ||= {})[id] = true;
    f.context = { ...f.context, owner: 'uid_bob', uid: 'bob', generation: 2 };
  };
  assert.equal((await c.cancel(original.id)).status, 'detached');
  assert.equal(c.snapshot('uid_alice').queue[0].phase, 'cancelling'); assert.equal(f.applied, null);
  f.context = { owner: 'uid_alice', uid: 'alice', device: 'a', generation: 3 };
  enableCancellation(f);
  assert.equal((await f.create().drain()).status, 'drained');
  assert.equal(f.applied.cursor, 0);
});

test('capture freezes original input durably before any asynchronous handoff; capability failure retains it', async () => {
  const f = fixture(), c = f.create(), value = input();
  f.transport.enforcesAccounting = false;
  const pending = c.submit(value, { at: 10 }); value.records.timer.cursor = 900;
  assert.equal(c.captures('uid_alice').length, 1);
  assert.equal(c.captures('uid_alice')[0].captured.input.records.timer.cursor, 10);
  assert.equal((await pending).reason, 'accounting-fence-unproven');
  assert.equal(f.sends, 0); assert.equal(f.applied, null);
  assert.equal(c.snapshot().queue.length, 1);
});
test('lost response/reload retries observations before sending; one immutable operation applies once', async () => {
  const f = fixture(), c = f.create(); f.loseReply = true;
  assert.equal((await c.submit(input())).status, 'unknown');
  const pending = c.snapshot().queue[0];
  assert.equal(f.applied, null); assert.equal(pending.attempts, 1);
  const restarted = f.create();
  assert.equal((await restarted.drain()).status, 'drained');
  assert.equal(f.sends, 1); assert.equal(f.prepares, 1);
  assert.equal(restarted.snapshot().history[0].id, pending.id);
  assert.equal(restarted.snapshot().committed.value.cursor, 10);
  assert.equal(restarted.snapshot().committed.value.undo, 'original undo');
  await restarted.drain();
  assert.equal(restarted.snapshot().history.length, 1);
});
test('unsent offline capture survives restart and original facts do not follow later caller edits', async () => {
  const f = fixture(), c = f.create(); f.offline = true;
  const value = input(); await c.submit(value); value.cursor = 55;
  assert.equal(c.snapshot().queue[0].phase, 'captured');
  f.offline = false; await f.create().drain();
  assert.equal(f.applied.cursor, 10); assert.equal(f.prepares, 1);
});
test('UNKNOWN with unchanged authoritative base retries exactly instead of silently remaining pending', async () => {
  const f = fixture(), c = f.create(), normal = f.transport.patch;
  let captured;
  f.transport.patch = async (owner, patch) => { captured = clone(patch); throw Error('not delivered'); };
  await c.submit(input());
  assert.equal(c.snapshot().queue[0].phase, 'unknown');
  f.transport.patch = async (owner, patch) => { assert.deepEqual(patch, captured); return normal(owner, patch); };
  assert.equal((await c.drain()).status, 'drained');
  assert.equal(f.prepares, 1); assert.equal(f.applied.cursor, 10);
});
test('one matching stamp cannot acknowledge a multi-path command or authorize stale rebase', async () => {
  const f = fixture(), c = f.create();
  f.transport.patch = async () => { throw Error('not delivered'); };
  await c.submit(input());
  const command = c.snapshot().queue[0], original = clone(command.proposal);
  f.raw.entries.e_1 = clone(command.proposal.patch['entries/e_1']);
  f.raw.timer = { ownerRoom: 'uid_alice', cursor: 99 };
  const outcome = await c.drain();
  assert.equal(outcome.status, 'unknown'); assert.equal(outcome.reason, 'original-source-changed');
  assert.deepEqual(c.snapshot().queue[0].proposal, original); assert.equal(f.applied, null);
  assert.equal(f.prepares, 1);
});
test('failed atomic local commit leaves accepted command recoverable and cursor/Undo unapplied', async () => {
  const f = fixture(), c = f.create(), write = f.storage.setItem;
  f.storage.setItem = (key, raw) => { if (key.startsWith(BASE) && JSON.parse(raw).committed) throw Error('quota'); return write(key, raw); };
  await assert.rejects(c.submit(input()), /quota/);
  assert.equal(c.snapshot().queue[0].phase, 'accepted'); assert.equal(f.applied, null);
  f.storage.setItem = write;
  await f.create().drain();
  assert.equal(f.sends, 1); assert.equal(f.applied.cursor, 10);
});
test('failed cache application after atomic receipt can be repaired without repeating remote/local commit', async () => {
  const f = fixture(), normal = f.deps.apply;
  f.deps.apply = () => { throw Error('interrupted cache'); };
  const c = f.create(); await assert.rejects(c.submit(input()), /interrupted cache/);
  assert.equal(c.snapshot().queue.length, 0); assert.equal(c.snapshot().history.length, 1);
  f.deps.apply = normal;
  const restarted = f.create(); assert.equal(restarted.restore(), true);
  await restarted.drain();
  assert.equal(f.sends, 1); assert.equal(restarted.snapshot().generation, 1);
});
test('account detach during request stores acceptance for original owner without applying to next account', async () => {
  const f = fixture(), c = f.create(), original = f.transport.patch;
  f.transport.patch = async (...args) => {
    const result = await original(...args);
    f.context = { owner: 'uid_bob', uid: 'bob', device: 'a', generation: 2 };
    return result;
  };
  assert.equal((await c.submit(input())).status, 'detached'); assert.equal(f.applied, null);
  assert.equal(c.snapshot('uid_alice').queue[0].phase, 'accepted'); assert.equal(c.snapshot('uid_bob').queue.length, 0);
  f.context = { owner: 'uid_alice', uid: 'alice', device: 'a', generation: 3 };
  await c.drain(); assert.equal(f.sends, 1);
});
test('duplicate occurrence drains once; different facts under same occurrence remain a conflict', async () => {
  const f = fixture(), c = f.create();
  await Promise.all([c.submit(input(), { eventKey: 'scheduled:one' }), c.submit(input(), { eventKey: 'scheduled:one' })]);
  assert.equal(f.sends, 1); assert.equal(c.snapshot().history.filter(op => op.phase === 'local-applied').length, 1);
  const changed = input(); changed.records['entries/e_1'].ts = 11;
  assert.equal((await c.submit(changed, { eventKey: 'scheduled:one' })).reason, 'occurrence-changed');
  assert.equal(c.snapshot().queue.length, 1); assert.equal(f.sends, 1);
});
test('unknown envelope/storage readback failure prevents any remote mutation', async () => {
  const f = fixture(), c = f.create();
  f.values.set(`${BASE}:uid_alice`, JSON.stringify({ v: 900, owner: 'uid_alice' }));
  await assert.rejects(c.submit(input()), /Unreadable accounting envelope/); assert.equal(f.sends, 0);
  assert.equal(c.captures('uid_alice').length, 1);
});

test('a child captured earlier on the event clock waits for its actual predecessor, including coalesced aliases', async () => {
  const f = fixture(), c = f.create();
  const first = c.capture(input(), { eventKey: 'first-event', at: 20 });
  const duplicate = c.capture(input(), { eventKey: 'first-event', at: 21, dependsOn: first.id });
  const next = input(); next.records = { 'entries/e_2': { id: 2, tsStart: 10, ts: 20 }, timer: { ownerRoom: 'uid_alice', cursor: 20 } }; next.cursor = 20;
  c.capture(next, { eventKey: 'next-event', at: 0, dependsOn: duplicate.id });
  assert.equal((await c.drain()).status, 'drained');
  assert.equal(f.sends, 2); assert.equal(f.prepares, 2); assert.equal(f.applied.cursor, 20);
  assert.equal(c.snapshot().history.find(op => op.id === duplicate.id).aliasOf, first.id);
});
test('cyclic/missing dependencies retain original operations rather than spinning or skipping them', async () => {
  const f = fixture(), c = f.create();
  const first = c.capture(input(), { dependsOn: 'command_2' });
  c.capture(input(), { dependsOn: first.id });
  assert.equal((await c.drain()).reason, 'cyclic-command-dependency');
  assert.equal(c.snapshot().queue.length, 2); assert.equal(f.sends, 0);
});
test('detachment while preparing preserves the original captured operation without sealing or sending it', async () => {
  const f = fixture(), original = f.deps.prepare;
  f.deps.prepare = async (...args) => {
    const proposal = original(...args);
    f.context = { owner: 'uid_bob', uid: 'bob', device: 'a', generation: 2 };
    return proposal;
  };
  const c = f.create(); assert.equal((await c.submit(input())).status, 'detached');
  assert.equal(c.snapshot('uid_alice').queue[0].phase, 'captured'); assert.equal(f.sends, 0);
});
test('O1 provisional observations are local durable metadata and never accounting predecessors or sends', async () => {
  const f = fixture(), c = f.create(); f.offline = true;
  const start = c.capture({ ...input(), name: 'start-timer', ordinary: { v: 1, kind: 'start' } }, { at: 100 });
  assert.equal(await c.observeProvisional(start.id, 200), true);
  assert.equal(c.snapshot().provisionalObserved[start.id], 200);
  assert.equal(c.snapshot().queue.length, 1); assert.equal(c.captures(f.context.owner).length, 0);
  assert.equal(f.applied, null); assert.equal(f.sends, 0);
  assert.equal(f.create().snapshot().provisionalObserved[start.id], 200);
});

test('O1 observation intake survives envelope quota and recovers its original observed timestamp', async () => {
  const f = fixture(), c = f.create(); f.offline = true;
  const start = c.capture({ ...input(), name: 'start-timer', ordinary: { v: 1, kind: 'start' } }, { at: 100 });
  const write = f.storage.setItem;
  f.storage.setItem = (key, value) => { if (key.startsWith(BASE)) throw Error('quota'); return write(key, value); };
  await assert.rejects(c.observeProvisional(start.id, 200), /quota/);
  assert.equal(c.captures(f.context.owner).length, 2); assert.equal(f.sends, 0);
  f.storage.setItem = write; const restarted = f.create(); await restarted.drain();
  assert.equal(restarted.snapshot().provisionalObserved[start.id], 200);
  assert.equal(restarted.snapshot().queue.length, 1);
});

test('O1 observations cannot borrow another device or an absent provisional source', async () => {
  for (const foreign of [false, true]) {
    const f = fixture(), c = f.create();
    const start = c.capture({ ...input(), name: 'start-timer', ordinary: { v: 1, kind: 'start' } }, { at: 100 });
    if (foreign) f.context = { ...f.context, device: 'other' };
    await assert.rejects(c.observeProvisional(foreign ? start.id : 'missing_source', 200), /Unreadable provisional/);
    assert.equal(f.sends, 0); assert.equal(f.applied, null);
    assert.ok(c.captures(f.context.owner).some(item => item.captured.input.name === 'ordinary-heartbeat'));
  }
});

test('O1 malformed retained observation metadata fails closed without publication', async () => {
  const f = fixture(), c = f.create();
  c.capture({ ...input(), name: 'start-timer', ordinary: { v: 1, kind: 'start' } }, { at: 100 });
  await c.observeProvisional('command_1', 200);
  const key = BASE + ':' + f.context.owner, saved = JSON.parse(f.storage.getItem(key));
  saved.provisionalObserved.command_1 = 'corrupt'; f.storage.setItem(key, JSON.stringify(saved));
  assert.throws(() => f.create().snapshot(), /Unreadable accounting envelope/); assert.equal(f.sends, 0);
});


test('ambiguous duplicate operation IDs retain both original inputs instead of retiring an unacknowledged fact',async()=>{
 const f=fixture(),c=f.create();f.offline=true;await c.submit(input());
 const second=input();second.records['entries/e_2']={...second.records['entries/e_1'],id:2};delete second.records['entries/e_1'];second.cursor=20;
 await c.submit(second);const state=c.snapshot();assert.equal(state.queue.length,2);state.queue[1].id=state.queue[0].id;
 const raw=JSON.stringify(state);f.storage.setItem(`${BASE}:uid_alice`,raw);f.offline=false;
 await assert.rejects(c.drain(),/Unreadable accounting envelope/);assert.equal(f.sends,0);assert.equal(f.storage.getItem(`${BASE}:uid_alice`),raw);
});
for(const corrupt of ['generation','operation']){
 test(`canonical ${corrupt} receipt mismatch cannot authorize restore without its matching applied history`,async()=>{
  const f=fixture(),c=f.create();await c.submit(input());const state=c.snapshot();
  if(corrupt==='generation')state.committed.generation++;else state.committed.operationId='unbound_receipt';
  const raw=JSON.stringify(state);f.storage.setItem(`${BASE}:uid_alice`,raw);let applies=0;f.deps.apply=()=>{applies++;};
  const restored=f.create();assert.throws(()=>restored.restore(),/Unreadable accounting envelope/);assert.equal(applies,0);assert.equal(f.storage.getItem(`${BASE}:uid_alice`),raw);
 });
}

test('duplicate durable effect IDs cannot dispatch a callback twice or retire ambiguous original evidence',async()=>{
 const f=focusEffectFixture(),c=f.create();await c.submit(input());const state=c.snapshot();state.effects.push(clone(state.effects[0]));
 const raw=JSON.stringify(state);f.storage.setItem(`${BASE}:uid_alice`,raw);let delivered=0;
 await assert.rejects(c.runEffects(()=>{delivered++;return true;}),/Unreadable accounting envelope/);assert.equal(delivered,0);assert.equal(f.storage.getItem(`${BASE}:uid_alice`),raw);
});

test('an already receipted effect restored into active state cannot be dispatched again',async()=>{
 const f=focusEffectFixture(),c=f.create();await c.submit(input());const effect=c.snapshot().effects[0];await c.runEffects(()=>true);
 const state=c.snapshot();state.effects=[effect];const raw=JSON.stringify(state);f.storage.setItem(`${BASE}:uid_alice`,raw);let delivered=0;
 await assert.rejects(c.runEffects(()=>{delivered++;return true;}),/Unreadable accounting envelope/);assert.equal(delivered,0);assert.equal(f.storage.getItem(`${BASE}:uid_alice`),raw);
});
