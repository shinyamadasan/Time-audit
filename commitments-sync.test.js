// commitments-sync.test.js
//
// Planning Continuity V1 — cross-device durability for canonical commitments.
//
// The specific risk this suite exists to close: a commitment eight months out must
// converge exactly as reliably as one tomorrow, and an OFFLINE write of a
// future-dated commitment must never sit unsynced forever. Both are tested with a
// real transaction-shaped fake room ref and an explicitly toggled connection.
//
// No real Firebase project, no network, no production data.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommitmentsSyncBridge, COMMITMENTS_REMOTE_PATH } from './commitments-sync.js';
import { createCommitmentsRepository } from './commitments-repository.js';
import { updateCommitment, deleteCommitment, normalizeCommitment } from './commitments-model.js';

const MANILA = 'Asia/Manila';
const manila = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const T0 = manila('2026-09-18', '10:00');

const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

/** A fake RTDB room ref with real transaction semantics: the update function sees
 *  the CURRENT server value and its return value is committed atomically, and
 *  listeners fire on any ancestor path — the same shape plan-authority.test.js
 *  uses, so both bridges are exercised against the same model of Firebase. */
function fakeRoomRef(initial = {}) {
  const root = { value: initial };
  const listeners = new Map();
  const get = path => path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  function set(path, value) {
    const segs = path.split('/').filter(Boolean);
    let node = root.value;
    for (let i = 0; i < segs.length - 1; i++) {
      if (typeof node[segs[i]] !== 'object' || node[segs[i]] === null) node[segs[i]] = {};
      node = node[segs[i]];
    }
    node[segs[segs.length - 1]] = value;
    for (let i = segs.length; i >= 0; i--) {
      const p = segs.slice(0, i).join('/');
      (listeners.get(p) || []).forEach(fn => fn({ val: () => get(p) ?? null }));
    }
  }
  function makeRef(path) {
    return {
      path,
      child(seg) { return makeRef(path ? `${path}/${seg}` : seg); },
      on(_event, fn) {
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(fn);
        fn({ val: () => get(path) ?? null });
      },
      off() { listeners.delete(path); },
      val: () => get(path) ?? null,
      transaction(updateFn) {
        const current = get(path) ?? null;
        const nextValue = updateFn(current);
        if (nextValue === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => current } });
        set(path, nextValue);
        return Promise.resolve({ committed: true, snapshot: { val: () => nextValue } });
      },
    };
  }
  return { ref: makeRef(''), raw: root, get };
}

/** One device: its own storage + repository + bridge, pointed at a shared room. */
function makeDevice({ room = null, deviceId = 'device-a', clock = T0, storage = memory() } = {}) {
  const roomRef = { value: room };
  const nowRef = { value: clock };
  const repository = createCommitmentsRepository({ storage, now: () => nowRef.value, deviceId: () => deviceId });
  const changes = [];
  const bridge = createCommitmentsSyncBridge({
    repository,
    getRoomRef: () => roomRef.value,
    onRemoteChange: (id, record) => changes.push({ id, record }),
  });
  return {
    repository, bridge, changes, storage,
    setNow: v => { nowRef.value = v; },
    goOffline: () => { bridge.detach(); roomRef.value = null; },
    goOnline: ref => { roomRef.value = ref; },
  };
}

const ok = r => { assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`); return r; };

const dentistInput = (overrides = {}) => ({
  id: 'cdentist', title: 'Dentist', date: '2026-09-30', time: '09:30', timezone: MANILA, ...overrides,
});

/** A commitment eight months out — the case a date-horizoned design would drop. */
const farFutureInput = (overrides = {}) => ({
  id: 'cfarfuture', title: 'Passport renewal', date: '2027-05-20', time: '11:00', timezone: MANILA, ...overrides,
});

// ═══════════════════════════════════════════════════════════════════════
// 1. remote path and rules posture
// ═══════════════════════════════════════════════════════════════════════

test('commitments live under the owner-only rooms/<room>/commitments path, with the id as the key verbatim', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: room.ref });
  ok(device.repository.create(dentistInput()));
  assert.equal(await device.bridge.syncCommitment('cdentist'), true);

  assert.equal(COMMITMENTS_REMOTE_PATH, 'commitments');
  const stored = room.get('commitments/cdentist');
  assert.ok(stored, 'the record is written under its own id, with no key encoding');
  assert.equal(stored.startMs, manila('2026-09-30', '09:30'));
  // Nothing was written anywhere else — in particular no day-keyed index.
  assert.deepEqual(Object.keys(room.raw.value), ['commitments']);
  assert.deepEqual(Object.keys(room.raw.value.commitments), ['cdentist']);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. reload / persistence
// ═══════════════════════════════════════════════════════════════════════

test('a reload re-reads commitments from local storage, including far-future ones', () => {
  const storage = memory();
  const first = makeDevice({ storage });
  ok(first.repository.create(dentistInput()));
  ok(first.repository.create(farFutureInput()));

  // A brand-new device object over the SAME storage is a reload.
  const reloaded = makeDevice({ storage });
  assert.deepEqual(Object.keys(reloaded.repository.listAllRaw()).sort(), ['cdentist', 'cfarfuture']);
  assert.equal(reloaded.repository.read('cfarfuture').startMs, manila('2027-05-20', '11:00'));
});

test('an inbound subtree snapshot lands in local storage and survives a reload', () => {
  const room = fakeRoomRef();
  const storage = memory();
  const device = makeDevice({ room: room.ref, storage });

  // Another device already wrote both records remotely.
  const seeder = makeDevice({ room: room.ref, deviceId: 'device-b' });
  ok(seeder.repository.create(dentistInput()));
  ok(seeder.repository.create(farFutureInput()));
  return Promise.all([seeder.bridge.syncCommitment('cdentist'), seeder.bridge.syncCommitment('cfarfuture')]).then(() => {
    device.bridge.attach(); // the initial value callback fires immediately
    assert.deepEqual(Object.keys(device.repository.listAllRaw()).sort(), ['cdentist', 'cfarfuture']);
    const reloaded = makeDevice({ storage });
    assert.equal(reloaded.repository.read('cdentist').title, 'Dentist');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. offline edit -> reconnect push (the durability guarantee)
// ═══════════════════════════════════════════════════════════════════════

test('an OFFLINE future-dated write is queued and pushed on reconnect', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: null }); // starts offline

  ok(device.repository.create(farFutureInput()));
  assert.equal(await device.bridge.syncCommitment('cfarfuture'), false, 'offline push cannot succeed');
  assert.deepEqual(device.bridge.pendingPushIds(), ['cfarfuture'], 'the intent is remembered');
  assert.equal(room.get('commitments/cfarfuture'), undefined);

  // Reconnect.
  device.goOnline(room.ref);
  const pushed = await device.bridge.pushAllLocal();
  assert.equal(pushed, 1);
  assert.deepEqual(device.bridge.pendingPushIds(), [], 'the queue drained');
  assert.equal(room.get('commitments/cfarfuture').startMs, manila('2027-05-20', '11:00'));
});

test('a device that was NEVER online still pushes everything on its first connection', async () => {
  const room = fakeRoomRef();
  // No sync attempt at all while offline: the queue is empty, so pushAllLocal must
  // fall back to the whole local record set rather than pushing nothing.
  const device = makeDevice({ room: null });
  ok(device.repository.create(dentistInput()));
  ok(device.repository.create(farFutureInput()));
  assert.deepEqual(device.bridge.pendingPushIds(), []);

  device.goOnline(room.ref);
  assert.equal(await device.bridge.pushAllLocal(), 2);
  assert.deepEqual(Object.keys(room.get('commitments')).sort(), ['cdentist', 'cfarfuture']);
});

test('an offline EDIT of an already-synced commitment is not lost', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: room.ref });
  ok(device.repository.create(dentistInput()));
  await device.bridge.syncCommitment('cdentist');
  assert.equal(room.get('commitments/cdentist').time, '09:30');

  device.goOffline();
  device.setNow(T0 + 60000);
  ok(device.repository.update('cdentist', { time: '14:00' }));
  assert.equal(await device.bridge.syncCommitment('cdentist'), false);
  assert.equal(room.get('commitments/cdentist').time, '09:30', 'remote still holds the old value while offline');

  device.goOnline(room.ref);
  await device.bridge.pushAllLocal();
  assert.equal(room.get('commitments/cdentist').time, '14:00');
  assert.equal(room.get('commitments/cdentist').startMs, manila('2026-09-30', '14:00'));
});

test('a push that fails mid-flight stays queued and succeeds on the next attempt', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: room.ref });
  ok(device.repository.create(dentistInput()));

  // A ref whose transaction rejects — a real network failure, not "offline".
  const flaky = {
    child: () => ({ child: () => ({ transaction: () => Promise.reject(new Error('network')) }) }),
  };
  device.goOnline(flaky);
  assert.equal(await device.bridge.syncCommitment('cdentist'), false);
  assert.deepEqual(device.bridge.pendingPushIds(), ['cdentist']);

  device.goOnline(room.ref);
  assert.equal(await device.bridge.pushAllLocal(), 1);
  assert.ok(room.get('commitments/cdentist'));
});

// ═══════════════════════════════════════════════════════════════════════
// 4. two-device convergence
// ═══════════════════════════════════════════════════════════════════════

test('two devices editing the same commitment converge on the later edit', async () => {
  const room = fakeRoomRef();
  const a = makeDevice({ room: room.ref, deviceId: 'device-a' });
  const b = makeDevice({ room: room.ref, deviceId: 'device-b' });

  ok(a.repository.create(dentistInput()));
  await a.bridge.syncCommitment('cdentist');
  b.bridge.attach();
  assert.ok(b.repository.read('cdentist'), 'device B received it');

  // B edits later than A.
  a.setNow(T0 + 1000);
  ok(a.repository.update('cdentist', { time: '10:00' }));
  b.setNow(T0 + 2000);
  ok(b.repository.update('cdentist', { time: '11:00' }));

  await a.bridge.syncCommitment('cdentist');
  await b.bridge.syncCommitment('cdentist');
  a.bridge.attach();

  assert.equal(room.get('commitments/cdentist').time, '11:00');
  assert.equal(a.repository.read('cdentist').time, '11:00', 'the earlier writer converges to the later edit');
  assert.equal(b.repository.read('cdentist').time, '11:00');
});

test('the SAME result is reached whichever device pushes first', async () => {
  const run = async pushBFirst => {
    const room = fakeRoomRef();
    const a = makeDevice({ room: room.ref, deviceId: 'device-a', clock: T0 + 1000 });
    const b = makeDevice({ room: room.ref, deviceId: 'device-b', clock: T0 + 2000 });
    ok(a.repository.create(dentistInput({ time: '10:00' })));
    ok(b.repository.create(dentistInput({ time: '11:00' })));
    if (pushBFirst) { await b.bridge.syncCommitment('cdentist'); await a.bridge.syncCommitment('cdentist'); }
    else { await a.bridge.syncCommitment('cdentist'); await b.bridge.syncCommitment('cdentist'); }
    return room.get('commitments/cdentist');
  };
  const aFirst = await run(false);
  const bFirst = await run(true);
  assert.equal(aFirst.time, '11:00');
  assert.deepEqual(aFirst, bFirst, 'arrival order cannot change the converged value');
});

test('a duplicate write of the identical record converges and is idempotent', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: room.ref });
  ok(device.repository.create(dentistInput()));
  assert.equal(await device.bridge.syncCommitment('cdentist'), true);
  const afterFirst = JSON.stringify(room.get('commitments/cdentist'));
  assert.equal(await device.bridge.syncCommitment('cdentist'), true);
  assert.equal(await device.bridge.syncCommitment('cdentist'), true);
  assert.equal(JSON.stringify(room.get('commitments/cdentist')), afterFirst, 'repeated pushes are a no-op');
  assert.equal(Object.keys(room.get('commitments')).length, 1, 'never a second copy');
});

test('two devices creating the SAME id concurrently end up with one record, not two', async () => {
  const room = fakeRoomRef();
  const a = makeDevice({ room: room.ref, deviceId: 'device-a', clock: T0 });
  const b = makeDevice({ room: room.ref, deviceId: 'device-b', clock: T0 });
  // Same id, same timestamp — the pathological tie.
  ok(a.repository.create(dentistInput({ time: '10:00' })));
  ok(b.repository.create(dentistInput({ time: '11:00' })));
  await a.bridge.syncCommitment('cdentist');
  await b.bridge.syncCommitment('cdentist');
  a.bridge.attach();
  b.bridge.attach();
  assert.equal(Object.keys(room.get('commitments')).length, 1);
  assert.equal(a.repository.read('cdentist').time, b.repository.read('cdentist').time,
    'both devices agree, with no coordination, on the canonical tie-break');
});

// ═══════════════════════════════════════════════════════════════════════
// 5. tombstones and absence
// ═══════════════════════════════════════════════════════════════════════

test('a deletion propagates as a tombstone and is not resurrected by a stale peer', async () => {
  const room = fakeRoomRef();
  const a = makeDevice({ room: room.ref, deviceId: 'device-a' });
  const b = makeDevice({ room: room.ref, deviceId: 'device-b' });
  ok(a.repository.create(dentistInput()));
  await a.bridge.syncCommitment('cdentist');
  b.bridge.attach();

  // A deletes at T0+5000; B had made an earlier edit it has not pushed yet.
  b.setNow(T0 + 1000);
  ok(b.repository.update('cdentist', { title: 'Dentist!' }));
  a.setNow(T0 + 5000);
  ok(a.repository.remove('cdentist'));
  await a.bridge.syncCommitment('cdentist');
  await b.bridge.syncCommitment('cdentist');

  assert.equal(room.get('commitments/cdentist').deleted, true, 'the stale edit does not undo the delete');
  b.bridge.attach();
  assert.equal(b.repository.read('cdentist').deleted, true);
  // The key is retained on both sides, which is what stops a resurrection.
  assert.ok('cdentist' in a.repository.listAllRaw());
});

test('a peer snapshot that omits a commitment never deletes it — absence is not deletion', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: room.ref });
  ok(device.repository.create(dentistInput()));
  ok(device.repository.create(farFutureInput()));
  await device.bridge.pushAllLocal({ all: true });

  // A snapshot mentioning only ONE record arrives (e.g. a partial write elsewhere).
  device.bridge.handleRemoteSnapshot({ cdentist: room.get('commitments/cdentist') });
  assert.ok(device.repository.read('cfarfuture'), 'the unmentioned commitment is untouched');
  assert.equal(device.repository.read('cfarfuture').deleted, undefined);
});

// ═══════════════════════════════════════════════════════════════════════
// 6. hostile input and listener lifecycle
// ═══════════════════════════════════════════════════════════════════════

test('a malformed remote payload is ignored rather than stored', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: room.ref });
  ok(device.repository.create(dentistInput()));
  await device.bridge.syncCommitment('cdentist');

  device.bridge.handleRemoteSnapshot({
    cdentist: { schemaVersion: 1, id: 'cdentist', title: '', date: 'nope' }, // invalid
    'bad/key': { anything: true },                                          // illegal id
    cjunkrecord: { not: 'a commitment' },                                   // unnormalizable
  });
  assert.equal(device.repository.read('cdentist').title, 'Dentist', 'valid local truth survives');
  assert.deepEqual(Object.keys(device.repository.listAllRaw()), ['cdentist'], 'junk never becomes a record');
});

test('a record whose stored instant disagrees with its civil fields is refused on the wire', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: room.ref });
  ok(device.repository.create(dentistInput()));
  await device.bridge.syncCommitment('cdentist');
  const tampered = { ...room.get('commitments/cdentist'), startMs: manila('2026-09-30', '09:30') + 3600000, updatedAt: T0 + 99999 };
  device.bridge.handleRemoteRecord('cdentist', tampered);
  assert.equal(device.repository.read('cdentist').startMs, manila('2026-09-30', '09:30'),
    'a tampered/corrupt instant cannot move the appointment');
});

test('attach is idempotent and detach stops inbound merges', async () => {
  const room = fakeRoomRef();
  const a = makeDevice({ room: room.ref, deviceId: 'device-a' });
  const b = makeDevice({ room: room.ref, deviceId: 'device-b' });
  b.bridge.attach();
  b.bridge.attach(); // must not double-subscribe

  ok(a.repository.create(dentistInput()));
  await a.bridge.syncCommitment('cdentist');
  assert.ok(b.repository.read('cdentist'));
  const changeCount = b.changes.length;

  b.bridge.detach();
  a.setNow(T0 + 1000);
  ok(a.repository.update('cdentist', { time: '16:00' }));
  await a.bridge.syncCommitment('cdentist');
  assert.equal(b.repository.read('cdentist').time, '09:30', 'a detached bridge receives nothing');
  assert.equal(b.changes.length, changeCount, 'and reports no changes');
});

test('attach and sync are safe no-ops with no room ref at all', async () => {
  const device = makeDevice({ room: null });
  device.bridge.attach();
  device.bridge.detach();
  assert.equal(await device.bridge.syncCommitment('cmissingrecord'), false);
  assert.equal(await device.bridge.syncCommitment('bad/id'), false);
  assert.equal(await device.bridge.pushAllLocal(), 0);
});

test('a fresh device reconstructs every commitment from remote alone', async () => {
  const room = fakeRoomRef();
  const seeder = makeDevice({ room: room.ref, deviceId: 'device-a' });
  ok(seeder.repository.create(dentistInput()));
  ok(seeder.repository.create(farFutureInput()));
  ok(seeder.repository.create({ id: 'cdateonly', title: 'Visa sometime', date: '2027-02-11', precision: 'date', timezone: MANILA }));
  await seeder.bridge.pushAllLocal({ all: true });

  const fresh = makeDevice({ room: room.ref, deviceId: 'device-z' });
  fresh.bridge.attach();
  const all = fresh.repository.listAllRaw();
  assert.deepEqual(Object.keys(all).sort(), ['cdateonly', 'cdentist', 'cfarfuture']);
  // Every reconstructed record is fully valid, including the date-only one.
  for (const record of Object.values(all)) assert.ok(normalizeCommitment(record));
  assert.equal(all.cdateonly.time, null);
  assert.equal(all.cdateonly.precision, 'date');
});

test('the bridge reports remote changes so surfaces can re-render', async () => {
  const room = fakeRoomRef();
  const a = makeDevice({ room: room.ref, deviceId: 'device-a' });
  const b = makeDevice({ room: room.ref, deviceId: 'device-b' });
  b.bridge.attach();
  ok(a.repository.create(dentistInput()));
  await a.bridge.syncCommitment('cdentist');
  assert.ok(b.changes.some(c => c.id === 'cdentist'), 'an inbound record notifies exactly once per change');
  const count = b.changes.length;
  // Re-delivering the identical snapshot must NOT re-notify.
  b.bridge.handleRemoteRecord('cdentist', room.get('commitments/cdentist'));
  assert.equal(b.changes.length, count);
});

// ═══════════════════════════════════════════════════════════════════════
// 7. no Partner View exposure in V1
// ═══════════════════════════════════════════════════════════════════════

test('commitments are written ONLY under the owner-only room, never to a shared node', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: room.ref });
  ok(device.repository.create(dentistInput({ note: 'private medical detail' })));
  ok(device.repository.create(farFutureInput()));
  await device.bridge.pushAllLocal({ all: true });

  // The bridge touches exactly one subtree, and nothing partner-facing.
  assert.deepEqual(Object.keys(room.raw.value), ['commitments']);
  const serialized = JSON.stringify(room.raw.value);
  assert.ok(serialized.includes('private medical detail'), 'sanity: the note really was stored');
  for (const partnerish of ['shared', 'public', 'partnerView', 'nudges']) {
    assert.ok(!Object.keys(room.raw.value).includes(partnerish), `commitments must not write a ${partnerish} node`);
  }
});

test('deleting then restoring a commitment converges to the restored record', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: room.ref });
  ok(device.repository.create(dentistInput()));
  await device.bridge.syncCommitment('cdentist');

  device.setNow(T0 + 1000);
  ok(device.repository.remove('cdentist'));
  await device.bridge.syncCommitment('cdentist');
  assert.equal(room.get('commitments/cdentist').deleted, true);

  device.setNow(T0 + 2000);
  ok(device.repository.restore('cdentist'));
  await device.bridge.syncCommitment('cdentist');
  assert.equal(room.get('commitments/cdentist').deleted, undefined);
  assert.equal(room.get('commitments/cdentist').startMs, manila('2026-09-30', '09:30'));
});

test('a tombstone created offline still propagates on reconnect', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: room.ref });
  ok(device.repository.create(dentistInput()));
  await device.bridge.syncCommitment('cdentist');

  device.goOffline();
  device.setNow(T0 + 5000);
  ok(device.repository.remove('cdentist'));
  await device.bridge.syncCommitment('cdentist');
  assert.deepEqual(device.bridge.pendingPushIds(), ['cdentist']);

  device.goOnline(room.ref);
  await device.bridge.pushAllLocal();
  assert.equal(room.get('commitments/cdentist').deleted, true);
});

test('an updated record keeps its id on the wire — identity never changes', async () => {
  const room = fakeRoomRef();
  const device = makeDevice({ room: room.ref });
  const created = ok(device.repository.create({ title: 'Dentist', date: '2026-09-30', time: '09:30', timezone: MANILA })).record;
  await device.bridge.syncCommitment(created.id);
  device.setNow(T0 + 1000);
  ok(device.repository.update(created.id, { title: 'Dentist (moved)', date: '2026-10-07', time: '14:00' }));
  await device.bridge.syncCommitment(created.id);

  assert.deepEqual(Object.keys(room.get('commitments')), [created.id], 'one key, before and after a full re-author');
  assert.equal(room.get(`commitments/${created.id}`).date, '2026-10-07');
  // Sanity: updateCommitment/deleteCommitment refuse to mint a different id.
  const rec = device.repository.read(created.id);
  assert.equal(ok(updateCommitment(rec, { title: 'x', now: T0 + 2000, updatedBy: 'd' })).record.id, created.id);
  assert.equal(ok(deleteCommitment(rec, { now: T0 + 3000, updatedBy: 'd' })).record.id, created.id);
});
