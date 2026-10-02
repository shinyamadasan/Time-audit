// brain-dump-sync.test.js
//
// Brain Dump + Eisenhower V1 sync bridge: push/pull mechanics, the offline queue,
// and owner-mismatch refusal — mirroring commitments-sync.js's own test shape.
// Cross-account leakage across a direct switch is covered separately in
// brain-dump-account-isolation.test.js (it needs two full devices sharing one
// instrumented database to reproduce that bug class faithfully).
//
// No real Firebase, no network: a small in-memory room exactly like the one the
// sibling Personal Day / commitments test suites already use.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrainDumpRepository } from './brain-dump-repository.js';
import { createBrainDumpSyncBridge, BRAIN_DUMP_REMOTE_PATH } from './brain-dump-sync.js';

const T0 = Date.parse('2026-10-01T08:00:00Z');
const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

/** A minimal in-memory room: one subtree, transaction() + on('value')/off(). */
function makeRoom() {
  const store = {}; // id -> record, under BRAIN_DUMP_REMOTE_PATH
  const listeners = new Set();
  let offline = false;
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  function notify() {
    if (offline) return;
    listeners.forEach(fn => fn({ val: () => clone(store) }));
  }
  function makeRef(segments = []) {
    return {
      child(seg) { return makeRef([...segments, seg]); },
      on(_event, fn) {
        listeners.add(fn);
        if (!offline) fn({ val: () => clone(store) });
      },
      off() { listeners.clear(); },
      transaction(updateFn) {
        if (offline) return Promise.reject(new Error('offline'));
        if (segments.length !== 2 || segments[0] !== BRAIN_DUMP_REMOTE_PATH) return Promise.resolve({ committed: false });
        const id = segments[1];
        const next = updateFn(clone(store[id]));
        if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => clone(store[id]) } });
        store[id] = clone(next);
        notify();
        return Promise.resolve({ committed: true, snapshot: { val: () => clone(store[id]) } });
      },
    };
  }
  return {
    ref: makeRef(),
    raw: () => clone(store),
    seed(id, record) { store[id] = clone(record); },
    goOffline() { offline = true; },
    goOnline() { offline = false; notify(); },
  };
}

function makeHarness({ owner = 'uid_a', roomRef = null, deviceId = 'device-1', claimTimeoutMs, now: nowMs = T0 } = {}) {
  const storage = memory();
  const repository = createBrainDumpRepository({ storage, getOwner: () => owner, now: () => nowMs, deviceId: () => deviceId });
  const remoteChanges = [];
  const bridge = createBrainDumpSyncBridge({
    repository,
    getRoomRef: () => roomRef,
    getRoomId: () => owner,
    now: () => nowMs,
    deviceId: () => deviceId,
    claimTimeoutMs,
    onRemoteChange: (id, record) => remoteChanges.push({ id, record }),
  });
  return { repository, bridge, remoteChanges, setRoomRef(ref) { roomRef = ref; } };
}

test('syncCapture pushes a local record into rooms/<room>/brainDump/<id> via a transaction', async () => {
  const room = makeRoom();
  const { repository, bridge } = makeHarness({ roomRef: room.ref });
  const { record } = repository.create({ text: 'Call the accountant' });
  const committed = await bridge.syncCapture(record.id);
  assert.equal(committed, true);
  assert.equal(room.raw()[record.id].text, 'Call the accountant');
});

test('pushCapture skips an id with nothing stored locally', async () => {
  const room = makeRoom();
  const { bridge } = makeHarness({ roomRef: room.ref });
  const result = await bridge.pushCapture('bdoesnotexist1');
  assert.equal(result.outcome, 'skipped');
  assert.deepEqual(room.raw(), {});
});

test('offline (no room ref): the write is durable locally and queued, then drained once a room ref appears', async () => {
  const { repository, bridge, setRoomRef } = makeHarness({ roomRef: null });
  const { record } = repository.create({ text: 'Offline capture' });
  const result = await bridge.pushCapture(record.id);
  assert.equal(result.outcome, 'queued');
  assert.deepEqual(bridge.pendingPushIds('uid_a'), [record.id]);

  const room = makeRoom();
  setRoomRef(room.ref);
  const pushed = await bridge.pushAllLocal();
  assert.equal(pushed, 1);
  assert.equal(room.raw()[record.id].text, 'Offline capture');
  assert.deepEqual(bridge.pendingPushIds('uid_a'), []);
});

test('pushAllLocal never drains an owner whose cache is not the active one', async () => {
  const room = makeRoom();
  const { bridge } = makeHarness({ owner: 'uid_a', roomRef: room.ref });
  // No local writes happened for uid_a (repository is empty); pushAllLocal must be a no-op, not throw.
  const pushed = await bridge.pushAllLocal();
  assert.equal(pushed, 0);
});

test('a push is refused with zero writes when the joined room is not the cache owner', async () => {
  const room = makeRoom();
  const storage = memory();
  // Repository is scoped to uid_a, but the bridge is told the joined room is uid_b.
  const repository = createBrainDumpRepository({ storage, getOwner: () => 'uid_a', now: () => T0, deviceId: () => 'device-1' });
  const { record } = repository.create({ text: 'Mismatched owner' });
  const bridge = createBrainDumpSyncBridge({ repository, getRoomRef: () => room.ref, getRoomId: () => 'uid_b' });
  const result = await bridge.pushCapture(record.id);
  assert.equal(result.outcome, 'owner-mismatch');
  assert.deepEqual(room.raw(), {});
});

test('handleRemoteSnapshot merges each inbound record individually into the active cache', () => {
  const { repository, bridge } = makeHarness();
  bridge.handleRemoteSnapshot({
    ridone1: { schemaVersion: 1, id: 'ridone1', text: 'From another device', createdAt: T0, updatedAt: T0, updatedBy: 'device-2', status: 'untriaged', important: null, urgent: null, triagedAt: null, disposedAt: null, promotion: null, delegatedTo: null },
  }, 'uid_a');
  assert.equal(repository.read('ridone1').text, 'From another device');
});

test('handleRemoteSnapshot drops a snapshot from a room that is not the active cache owner', () => {
  const { repository, bridge } = makeHarness({ owner: 'uid_a' });
  bridge.handleRemoteSnapshot({
    ridone1: { schemaVersion: 1, id: 'ridone1', text: 'Should not land', createdAt: T0, updatedAt: T0, updatedBy: 'device-2', status: 'untriaged', important: null, urgent: null, triagedAt: null, disposedAt: null, promotion: null, delegatedTo: null },
  }, 'uid_b');
  assert.equal(repository.read('ridone1'), null);
});

test('attach() binds a whole-subtree listener; a callback fired after detach() is ignored (stale token)', async () => {
  const room = makeRoom();
  const { repository, bridge } = makeHarness({ roomRef: room.ref });
  bridge.attach();
  room.seed('ridone1', { schemaVersion: 1, id: 'ridone1', text: 'Live', createdAt: T0, updatedAt: T0, updatedBy: 'device-2', status: 'untriaged', important: null, urgent: null, triagedAt: null, disposedAt: null, promotion: null, delegatedTo: null });
  room.goOnline(); // re-deliver the current snapshot through the bound listener
  assert.equal(repository.read('ridone1').text, 'Live');

  bridge.detach();
  room.seed('ridone2', { schemaVersion: 1, id: 'ridone2', text: 'After detach', createdAt: T0, updatedAt: T0, updatedBy: 'device-2', status: 'untriaged', important: null, urgent: null, triagedAt: null, disposedAt: null, promotion: null, delegatedTo: null });
  room.goOnline(); // the room's own listener set was cleared by off(); nothing should land
  assert.equal(repository.read('ridone2'), null);
});

test('attach() is idempotent for the same room and rebinds (dropping the old listener) for a different one', () => {
  const roomA = makeRoom();
  const { bridge } = makeHarness({ owner: 'uid_a', roomRef: roomA.ref });
  bridge.attach();
  bridge.attach(); // same room: no-op, must not throw or double-bind
  assert.ok(true, 'idempotent attach did not throw');
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX FIRST round 2 — claimPromotionRemote(): the promotion claim must be
// established against the AUTHORITATIVE REMOTE record via a real transaction,
// never merely against local cache.
// ═══════════════════════════════════════════════════════════════════════════

const PROMO_DO_TODAY = { type: 'do-today', store: 'legacy', targetId: '2026-10-01', planItemId: 'bdp1|bcapture1' };

test('claimPromotionRemote establishes the claim via a real transaction and merges the committed result locally', async () => {
  const room = makeRoom();
  const { repository, bridge } = makeHarness({ roomRef: room.ref });
  repository.create({ id: 'bcapture1', text: 'Water the plants' });
  const result = await bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.ok(result.ok);
  assert.deepEqual(room.raw().bcapture1.promotionClaim, { ...PROMO_DO_TODAY, claimedAt: T0, claimedBy: 'device-1' });
  assert.deepEqual(repository.read('bcapture1').promotionClaim, { ...PROMO_DO_TODAY, claimedAt: T0, claimedBy: 'device-1' });
});

test('claimPromotionRemote is REFUSED — reason "already-disposed" — when the AUTHORITATIVE remote is already archived, even though this device\'s local cache still says triaged', async () => {
  const room = makeRoom();
  const { repository, bridge } = makeHarness({ roomRef: room.ref });
  // The local repository still thinks the capture is untriaged/triaged — it has
  // never pulled the remote archive (the exact "stale client" reproduction).
  repository.create({ id: 'bcapture1', text: 'Stale device' });
  // The room (authoritative remote) was archived by a DIFFERENT device, never
  // pulled down to this one.
  room.seed('bcapture1', {
    schemaVersion: 1, id: 'bcapture1', text: 'Stale device', createdAt: T0, updatedAt: T0 + 50, updatedBy: 'device-2',
    status: 'archived', important: null, urgent: null, triagedAt: null, disposedAt: T0 + 50, promotionClaim: null, promotion: null, delegatedTo: null,
  });

  const result = await bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'already-disposed');
  // No claim was written anywhere — remote is untouched, archived.
  assert.equal(room.raw().bcapture1.status, 'archived');
  assert.equal(room.raw().bcapture1.promotionClaim, null);
  // The device's own local cache converges to the authoritative truth.
  assert.equal(repository.read('bcapture1').status, 'archived');
});

test('claimPromotionRemote is REFUSED — reason "already-disposed" — against an already-delegated remote, and delegatedTo provenance is preserved', async () => {
  const room = makeRoom();
  const { repository, bridge } = makeHarness({ roomRef: room.ref });
  repository.create({ id: 'bcapture1', text: 'Stale device' });
  room.seed('bcapture1', {
    schemaVersion: 1, id: 'bcapture1', text: 'Stale device', createdAt: T0, updatedAt: T0 + 50, updatedBy: 'device-2',
    status: 'delegated', important: null, urgent: null, triagedAt: null, disposedAt: T0 + 50, promotionClaim: null, promotion: null, delegatedTo: 'Alex',
  });
  const result = await bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'already-disposed');
  assert.equal(repository.read('bcapture1').status, 'delegated');
  assert.equal(repository.read('bcapture1').delegatedTo, 'Alex', 'delegate provenance is never erased by the refused claim attempt');
});

test('claimPromotionRemote never writes anything, local or remote, while offline (no room ref)', async () => {
  const { repository, bridge } = makeHarness({ roomRef: null });
  repository.create({ id: 'bcapture1', text: 'Offline attempt' });
  const result = await bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'offline');
  assert.equal(repository.read('bcapture1').status, 'untriaged');
  assert.equal(repository.read('bcapture1').promotionClaim, null, 'capture remains fully retryable — no fake local claim');
});

test('claimPromotionRemote refuses (as offline) when the local cache is not the joined room\'s — never claims under the wrong room', async () => {
  const room = makeRoom();
  const storage = memory();
  const repository = createBrainDumpRepository({ storage, getOwner: () => 'uid_a', now: () => T0, deviceId: () => 'device-1' });
  repository.create({ id: 'bcapture1', text: 'Mismatched owner' });
  const bridge = createBrainDumpSyncBridge({ repository, getRoomRef: () => room.ref, getRoomId: () => 'uid_b', now: () => T0, deviceId: () => 'device-1' });
  const result = await bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'offline');
  assert.deepEqual(room.raw(), {}, 'zero writes under the wrong room');
});

test('two devices racing claimPromotionRemote for the SAME capture: only the first commit wins, the second gets "already-claimed"', async () => {
  const room = makeRoom();
  const deviceOne = makeHarness({ roomRef: room.ref, deviceId: 'device-1' });
  const deviceTwo = makeHarness({ roomRef: room.ref, deviceId: 'device-2', now: T0 + 100 });
  deviceOne.repository.create({ id: 'bcapture1', text: 'Raced' });
  deviceTwo.repository.create({ id: 'bcapture1', text: 'Raced' });

  const first = await deviceOne.bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.ok(first.ok);
  const second = await deviceTwo.bridge.claimPromotionRemote('bcapture1', { ...PROMO_DO_TODAY, type: 'schedule', targetId: '2026-10-10' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-claimed');
  assert.equal(deviceTwo.repository.read('bcapture1').promotionClaim.targetId, '2026-10-01', 'device two converges to the WINNING claim, not its own');
});

test('claimPromotionRemote resolves to a bounded "offline" refusal, never hangs forever, when the transaction genuinely never settles', async () => {
  const hangingRoom = {
    ref: {
      child() { return this; },
      transaction() { return new Promise(() => { /* never settles — simulates a real offline SDK */ }); },
      on() {}, off() {},
    },
  };
  const { repository, bridge } = makeHarness({ roomRef: hangingRoom.ref, claimTimeoutMs: 50 });
  repository.create({ id: 'bcapture1', text: 'Hangs forever' });
  const result = await bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'offline');
  assert.equal(repository.read('bcapture1').promotionClaim, null);
});
