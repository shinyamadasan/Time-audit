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
import { wireCopy } from './brain-dump-test-support.js';

import { createBrainDumpRepository } from './brain-dump-repository.js';
import { createBrainDumpSyncBridge, BRAIN_DUMP_REMOTE_PATH } from './brain-dump-sync.js';
import { normalizeCapture } from './brain-dump-model.js';

const T0 = Date.parse('2026-10-01T08:00:00Z');
const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

/** A minimal in-memory room: one subtree, transaction() + on('value')/off(). */
function makeRoom() {
  const store = {}; // id -> record, under BRAIN_DUMP_REMOTE_PATH
  const listeners = new Set();
  let offline = false;
  const clone = wireCopy; // RTDB wire form: null keys pruned (see brain-dump-test-support.js)
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
    raw: () => clone(store) || {}, // test inspector: wire form, empty store as {}
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
  // Compared semantically: the wire omits the null durationMinutes (RTDB prunes nulls).
  assert.deepEqual(normalizeCapture(room.raw().bcapture1).promotionClaim, { ...PROMO_DO_TODAY, when: '', durationMinutes: null, claimedAt: T0, claimedBy: 'device-1', planWriteStarted: true });
  assert.deepEqual(repository.read('bcapture1').promotionClaim, { ...PROMO_DO_TODAY, when: '', durationMinutes: null, claimedAt: T0, claimedBy: 'device-1', planWriteStarted: true });
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
  assert.equal(room.raw().bcapture1.promotionClaim ?? null, null); // absent on the wire = no claim
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

test('claimPromotionRemote resolves to a bounded "pending" (never "offline"/"failed") when the transaction genuinely never settles — outcome stays UNKNOWN, not false failure', async () => {
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
  assert.equal(result.reason, 'pending', 'UNKNOWN outcome, never a false definitive failure');
  assert.equal(repository.read('bcapture1').promotionClaim, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX FIRST round 3 — the transaction is NEVER abandoned merely because the
// foreground caller timed out. A delayable (not merely never-settling) room:
// the transaction genuinely commits/aborts LATER, after this call already
// returned 'pending', and that late settlement must still be processed.
// ═══════════════════════════════════════════════════════════════════════════

/** A room whose transaction() only settles when the test explicitly releases
 *  it — unlike the never-settling Promise above, this one DOES eventually
 *  resolve, modeling a genuinely slow (not permanently dead) round trip. */
/** Unlike a single `release` slot, this QUEUES every in-flight transaction()
 *  call, so a second transaction (e.g. an ordinary archive push) started while
 *  the first (the original claim) is still unresolved never orphans it by
 *  overwriting its resolver. releaseOldest()/releaseNewest() pick which queued
 *  one settles now, by FIFO/LIFO order — tests pick whichever matches the
 *  real-world ordering they are modeling. */
function makeDelayableRoom() {
  const store = {};
  const listeners = new Set();
  const queue = []; // { run }
  const clone = wireCopy; // RTDB wire form: null keys pruned (see brain-dump-test-support.js)
  function notify() { listeners.forEach(fn => fn({ val: () => clone(store) })); }
  function makeRef(segments = []) {
    return {
      child(seg) { return makeRef([...segments, seg]); },
      on(_event, fn) { listeners.add(fn); fn({ val: () => clone(store) }); },
      off() { listeners.clear(); },
      transaction(updateFn) {
        return new Promise(resolve => {
          queue.push({
            run: () => {
              if (segments.length !== 2 || segments[0] !== BRAIN_DUMP_REMOTE_PATH) { resolve({ committed: false }); return; }
              const id = segments[1];
              const next = updateFn(clone(store[id]));
              if (next === undefined) { resolve({ committed: false, snapshot: { val: () => clone(store[id]) } }); return; }
              store[id] = clone(next);
              notify();
              resolve({ committed: true, snapshot: { val: () => clone(store[id]) } });
            },
          });
        });
      },
    };
  }
  function releaseAt(index) {
    if (index < 0 || index >= queue.length) return false;
    const [entry] = queue.splice(index, 1);
    entry.run();
    return true;
  }
  return {
    ref: makeRef(),
    raw: () => clone(store) || {}, // test inspector: wire form, empty store as {}
    seed(id, record) { store[id] = clone(record); },
    release() { return releaseAt(0); }, // FIFO default — the ORIGINAL (oldest) transaction
    releaseOldest() { return releaseAt(0); },
    releaseNewest() { return releaseAt(queue.length - 1); },
  };
}

test('A. timeout -> late COMMIT: no Plan Authority before commit; once the late claim lands, onRemoteChange fires with the authoritative claim', async () => {
  const room = makeDelayableRoom();
  const { repository, bridge } = makeHarness({ roomRef: room.ref, claimTimeoutMs: 20 });
  repository.create({ id: 'bcapture1', text: 'Late commit' });

  const pending = await bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.equal(pending.ok, false);
  assert.equal(pending.reason, 'pending');
  assert.equal(repository.read('bcapture1').promotionClaim, null, 'nothing local yet — no fake claim');

  room.release(); // the "server" finally answers
  await settle();
  assert.ok(repository.read('bcapture1').promotionClaim, 'the late-settled authoritative claim is now reflected locally');
  assert.deepEqual(repository.read('bcapture1').promotionClaim.targetId, PROMO_DO_TODAY.targetId);
});

test('B. timeout -> Archive wins before the late transaction runs: transaction aborts, zero plan item, capture ends up archived', async () => {
  const room = makeDelayableRoom();
  const { repository, bridge } = makeHarness({ roomRef: room.ref, claimTimeoutMs: 20 });
  repository.create({ id: 'bcapture1', text: 'Archived before late settlement' });

  const pending = await bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.equal(pending.reason, 'pending');

  // While the ORIGINAL transaction is still unresolved, a DIFFERENT push
  // (archive, via the ordinary pushCapture path) reaches the authoritative
  // remote FIRST — its own transaction is released immediately, leaving the
  // ORIGINAL claim's transaction still queued, untouched.
  repository.archive('bcapture1');
  const archivePush = bridge.syncCapture('bcapture1');
  room.releaseNewest();
  await archivePush;
  assert.equal(room.raw().bcapture1.status, 'archived');

  // NOW the original (still-pending) transaction finally runs its update
  // function against the archived remote — arbitratePromotionClaim refuses.
  room.releaseOldest();
  await settle();
  assert.equal(repository.read('bcapture1').status, 'archived', 'the late-settling claim attempt never overrides the authoritative archive');
  assert.equal(repository.read('bcapture1').promotionClaim, null);
});

test('C. timeout -> Delegate wins before the late transaction runs: delegatedTo preserved, zero plan item', async () => {
  const room = makeDelayableRoom();
  const { repository, bridge } = makeHarness({ roomRef: room.ref, claimTimeoutMs: 20 });
  repository.create({ id: 'bcapture1', text: 'Delegated before late settlement' });

  const pending = await bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.equal(pending.reason, 'pending');

  repository.delegate('bcapture1', { delegatedTo: 'Alex' });
  const delegatePush = bridge.syncCapture('bcapture1');
  room.releaseNewest();
  await delegatePush;

  room.releaseOldest();
  await settle();
  assert.equal(repository.read('bcapture1').status, 'delegated');
  assert.equal(repository.read('bcapture1').delegatedTo, 'Alex');
  assert.equal(repository.read('bcapture1').promotionClaim, null);
});

test('E. timeout -> late claim settles AFTER the account has switched away: never merged into the (now-wrong) active cache', async () => {
  const room = makeDelayableRoom();
  const storage = memory();
  const env = { owner: 'uid_a' };
  const repository = createBrainDumpRepository({ storage, getOwner: () => env.owner, now: () => T0, deviceId: () => 'device-1' });
  const bridge = createBrainDumpSyncBridge({ repository, getRoomRef: () => room.ref, getRoomId: () => env.owner, now: () => T0, deviceId: () => 'device-1', claimTimeoutMs: 20 });
  repository.create({ id: 'bcapture1', text: 'Account switches mid-flight' });

  const pending = await bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.equal(pending.reason, 'pending');

  env.owner = 'uid_b'; // direct switch, no sign-out — the historical bug shape
  room.release();
  await settle();

  assert.equal(repository.read('bcapture1'), null, 'B\'s now-active cache never receives A\'s claim');
});

test('H. a late transaction that definitively aborts (not because of a race, but a structural refusal) still clears the local pending view once observed', async () => {
  const room = makeDelayableRoom();
  const { repository, bridge } = makeHarness({ roomRef: room.ref, claimTimeoutMs: 20 });
  repository.create({ id: 'bcapture1', text: 'Structural refusal' });
  room.seed('bcapture1', {
    schemaVersion: 1, id: 'bcapture1', text: 'Structural refusal', createdAt: T0, updatedAt: T0, updatedBy: 'device-2',
    status: 'promoted', important: true, urgent: true, triagedAt: T0, disposedAt: T0,
    promotionClaim: null, promotion: { type: 'do-today', store: 'legacy', targetId: '2026-09-30', planItemId: 'bdp1|other', promotedAt: T0 }, delegatedTo: null,
  });

  const pending = await bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  assert.equal(pending.reason, 'pending');
  room.release();
  await settle();
  assert.equal(repository.read('bcapture1').status, 'promoted', 'authoritative state adopted once observed');
});

test('G. a Do Today claim still pending (unknown) does not let a concurrent Schedule attempt for the SAME capture create an incompatible second destination', async () => {
  const room = makeDelayableRoom();
  const { repository, bridge } = makeHarness({ roomRef: room.ref, claimTimeoutMs: 20 });
  repository.create({ id: 'bcapture1', text: 'Pending Do Today, then Schedule attempted' });

  const doTodayPending = bridge.claimPromotionRemote('bcapture1', PROMO_DO_TODAY);
  const doToday = await doTodayPending; // times out to 'pending' — outcome still unknown
  assert.equal(doToday.reason, 'pending');

  // The user, seeing no definitive outcome yet, tries Schedule instead — its
  // OWN transaction starts immediately (never blocked from starting), but it
  // must not win while the Do Today claim's eventual authority is undecided.
  const schedulePromo = { type: 'schedule', store: 'calendar', targetId: 'calplan:2026-10-20', planItemId: PROMO_DO_TODAY.planItemId };
  const schedulePending = await bridge.claimPromotionRemote('bcapture1', schedulePromo);
  assert.equal(schedulePending.reason, 'pending', 'Schedule\'s own transaction is ALSO still queued, unsettled');

  // Now both late transactions settle, in arrival order: Do Today was queued
  // first, so it is evaluated against remote first.
  room.releaseOldest(); // Do Today's transaction
  await settle();
  room.releaseOldest(); // Schedule's transaction, now queued alone
  await settle();

  const final = repository.read('bcapture1');
  assert.ok(final.promotionClaim, 'exactly one claim survives');
  assert.equal(final.promotionClaim.targetId, PROMO_DO_TODAY.targetId, 'Do Today — queued first — is the one authoritative claim');
  assert.notEqual(final.promotionClaim.targetId, schedulePromo.targetId, 'Schedule never wins a competing, incompatible destination');
});
