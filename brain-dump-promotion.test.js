// brain-dump-promotion.test.js
//
// Brain Dump + Eisenhower V1 — promoteCaptureToPlan() (Do Today / Schedule)
// against a FAKE Plan Authority (current/dayForScheduledDate/rawItems/addItem —
// read directly from plan-authority.js) and a REAL claimPromotionRemote: every
// test here goes through brain-dump-sync.js's actual Firebase-transaction-based
// remote claim gate (against a small fake room, never a wrapper that fakes
// immediate local success) — so these tests fail the same way the reviewed
// candidate 708c84a1 genuinely failed: a stale device's local-only claim could
// out-rank an already-authoritative remote archive/delegate.
//
// FIX FIRST round 2 correction: the PREVIOUS version of this file shared one
// repository/cache between simulated "devices", which could not actually
// reproduce a stale client (every "device" saw the same local state instantly).
// Every two-device test below uses makeDevice() — its own repository AND its
// own sync bridge, both pointed at one SHARED fake room — so staleness is real:
// a device only learns of another device's write when it actually syncs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrainDumpRepository } from './brain-dump-repository.js';
import { createBrainDumpSyncBridge, BRAIN_DUMP_REMOTE_PATH } from './brain-dump-sync.js';
import { brainDumpPlanItemId } from './brain-dump-model.js';
import { promoteCaptureToPlan } from './brain-dump-promotion.js';

const T0 = Date.parse('2026-10-01T08:00:00Z');
const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

/** Same fake room brain-dump-sync.test.js uses: one subtree, transaction() +
 *  on('value')/off(). Real Firebase transaction semantics: the update function
 *  is called with the CURRENT remote value; returning undefined aborts with
 *  zero writes; `committed`/`snapshot` are reported honestly either way. */
function makeRoom() {
  const store = {};
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
      on(_event, fn) { listeners.add(fn); if (!offline) fn({ val: () => clone(store) }); },
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
  return { ref: makeRef(), raw: () => clone(store), goOffline() { offline = true; }, goOnline() { offline = false; notify(); } };
}

/** A fake Plan Authority. `items` is the mutable backing array addItem()/rawItems()
 *  read and write, so a test can assert on exactly what got added. Shared between
 *  two "devices" in a test — it represents the one real plan store both
 *  eventually converge against, exactly as Plan Authority itself is single and
 *  account-wide regardless of which device writes to it. */
function makeFakePlanAuthority({ todayTarget = { store: 'calendar', id: 'calplan:2026-10-01', dateKey: '2026-10-01' }, schedule = null } = {}) {
  const items = [];
  const calls = { current: 0, addItem: 0, dayForScheduledDate: 0 };
  return {
    items,
    calls,
    current() { calls.current++; return todayTarget; },
    dayForScheduledDate(dateKey, when) {
      calls.dayForScheduledDate++;
      if (schedule) return schedule(dateKey, when);
      return { ok: true, anchor: when ? 'time' : 'noon', target: { store: 'calendar', id: `calplan:${dateKey}`, dateKey } };
    },
    rawItems() { return items; },
    addItem({ item }) {
      calls.addItem++;
      items.push(item);
      return { item };
    },
  };
}

/** One device: its OWN repository and its OWN sync bridge, optionally sharing a
 *  room with other devices for a true multi-device test. staleness is real: a
 *  device only learns of another device's remote write by actually syncing
 *  (attach()+the initial on('value') replay, or an explicit pull). */
function makeDevice({ room = makeRoom(), deviceId = 'device-1', now = T0, owner = 'uid_a' } = {}) {
  const storage = memory();
  const repository = createBrainDumpRepository({ storage, getOwner: () => owner, now: () => now, deviceId: () => deviceId });
  const bridge = createBrainDumpSyncBridge({ repository, getRoomRef: () => room.ref, getRoomId: () => owner, now: () => now, deviceId: () => deviceId });
  return {
    room, repository, bridge,
    claimPromotionRemote: bridge.claimPromotionRemote,
    /** Archives (or delegates) locally, then pushes to the shared room — the
     *  ordinary optimistic-local-first write every non-promotion action uses. */
    async archiveAndPush(id) {
      const result = repository.archive(id);
      if (result.ok) await bridge.syncCapture(id);
      return result;
    },
    async delegateAndPush(id, delegatedTo) {
      const result = repository.delegate(id, { delegatedTo });
      if (result.ok) await bridge.syncCapture(id);
      return result;
    },
    /** Pulls the CURRENT authoritative remote state into this device's own
     *  cache — simulates "reconnect" / the listener's replay. */
    async pull(id) {
      const latest = room.raw()[id];
      if (latest) repository.mergeRemote(id, latest);
      return repository.read(id);
    },
  };
}

function makeRepositoryOnly() {
  return createBrainDumpRepository({ storage: memory(), getOwner: () => 'uid_a', now: () => T0, deviceId: () => 'device-1' });
}

// ═══════════════════════════════════════════════════════════════════════════
// single-device: basic shape, validation, idempotency (still through the REAL
// remote claim gate — a fake room that always commits immediately — never a
// fake "instant success" wrapper)
// ═══════════════════════════════════════════════════════════════════════════

test('Do Today builds a plan item via Plan Authority with the deterministic id, untimed, kind:task, only after the remote claim is confirmed', async () => {
  const device = makeDevice();
  const planAuthority = makeFakePlanAuthority();
  const { record } = device.repository.create({ text: 'Water the plants' });
  const result = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });

  assert.ok(result.ok);
  assert.equal(result.record.status, 'promoted');
  assert.equal(planAuthority.calls.addItem, 1);
  assert.equal(planAuthority.items[0].id, brainDumpPlanItemId(record.id));
  assert.equal(planAuthority.items[0].task, 'Water the plants');
  assert.equal(planAuthority.items[0].when, '');
  assert.equal(planAuthority.items[0].kind, 'task');
  assert.equal(device.repository.read(record.id).promotion.type, 'do-today');
  // Phase 3 (finalize) is local-first by design — the caller (brain-dump-ui.js
  // in production) pushes it explicitly, exactly like every other write.
  await device.bridge.syncCapture(record.id);
  assert.deepEqual(device.room.raw()[record.id].promotion, result.record.promotion, 'the REMOTE record is authoritative too, once pushed');
});

test('Do Today is idempotent at the top level: a capture already promoted is never promoted twice', async () => {
  const device = makeDevice();
  const planAuthority = makeFakePlanAuthority();
  const { record } = device.repository.create({ text: 'Only once' });
  await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  const retry = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 2, deviceId: 'device-1' });

  assert.equal(retry.ok, true);
  assert.equal(retry.alreadyDisposed, true);
  assert.equal(planAuthority.calls.addItem, 1, 'the plan item must not be created a second time');
});

test('Schedule resolves the target via dayForScheduledDate and carries an optional time + duration', async () => {
  const device = makeDevice();
  const planAuthority = makeFakePlanAuthority();
  const { record } = device.repository.create({ text: 'Dentist follow-up' });
  const result = await promoteCaptureToPlan({
    repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'schedule',
    dateKey: '2026-10-05', when: '14:30', durationMinutes: 45, now: T0 + 1, deviceId: 'device-1',
  });

  assert.ok(result.ok);
  assert.equal(planAuthority.calls.dayForScheduledDate, 1);
  assert.equal(planAuthority.items[0].when, '14:30');
  assert.equal(planAuthority.items[0].durationMinutes, 45);
  assert.equal(device.repository.read(record.id).promotion.type, 'schedule');
  assert.equal(device.repository.read(record.id).promotion.targetId, 'calplan:2026-10-05');
});

test('Schedule with no time produces an untimed (anytime) item — a time is never required', async () => {
  const device = makeDevice();
  const planAuthority = makeFakePlanAuthority();
  const { record } = device.repository.create({ text: 'Someday, no rush' });
  const result = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'schedule', dateKey: '2026-11-01', now: T0 + 1, deviceId: 'device-1' });
  assert.ok(result.ok);
  assert.equal(planAuthority.items[0].when, '');
  assert.equal(planAuthority.items[0].durationMinutes, undefined);
});

test('a Plan Authority refusal (DST ambiguity) surfaces as a reported reason, never a thrown error, and the remote claim is never even attempted', async () => {
  const device = makeDevice();
  const planAuthority = makeFakePlanAuthority({ schedule: () => ({ ok: false, reason: 'ambiguous' }) });
  const { record } = device.repository.create({ text: 'Falls on the clock change' });
  const result = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'schedule', dateKey: '2026-11-01', when: '02:30', now: T0 + 1, deviceId: 'device-1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(planAuthority.calls.addItem, 0);
  assert.equal(device.repository.read(record.id).status, 'untriaged', 'the capture is NOT disposed of when the plan write never happened');
  assert.equal(device.room.raw()[record.id], undefined, 'nothing was ever pushed remotely either');
});

test('addItem throwing (e.g. a past My Day, or the Top-3 cap) is caught and reported — the claim is already authoritative, not erased', async () => {
  const device = makeDevice();
  const planAuthority = makeFakePlanAuthority();
  planAuthority.addItem = () => { throw new Error('Past My Days are history. Reschedule unfinished work from Unfinished instead.'); };
  const { record } = device.repository.create({ text: 'Too late now' });
  const result = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Past My Days are history/);
  assert.equal(device.repository.read(record.id).status, 'untriaged');
  assert.ok(device.room.raw()[record.id].promotionClaim, 'the claim stays authoritative remotely so a retry can recover');
});

test('promoting an unknown capture id reports not-found', async () => {
  const device = makeDevice();
  const planAuthority = makeFakePlanAuthority();
  const result = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: 'bdoesnotexist1', type: 'do-today', now: T0, deviceId: 'device-1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-found');
});

test('a capture already archived is reported alreadyDisposed and Plan Authority is never touched', async () => {
  const device = makeDevice();
  const planAuthority = makeFakePlanAuthority();
  const { record } = device.repository.create({ text: 'Dropped already' });
  await device.archiveAndPush(record.id);
  const result = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyDisposed, true);
  assert.equal(planAuthority.calls.current, 0);
  assert.equal(planAuthority.calls.addItem, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX FIRST round 2 — REQUIRED REAL TWO-DEVICE TESTS. Each uses two independent
// makeDevice()s sharing one room: staleness is real (a device's local cache
// only changes when it actually syncs). Assertions inspect the remote capture
// state, BOTH device caches, and the actual Plan Authority destination store.
// ═══════════════════════════════════════════════════════════════════════════

test('1. ARCHIVE FIRST, STALE PROMOTE SECOND: remote stays archived, no plan item, A is refused, reconnect converges A to archived', async () => {
  const room = makeRoom();
  const a = makeDevice({ room, deviceId: 'device-a' });
  const b = makeDevice({ room, deviceId: 'device-b', now: T0 + 50 });
  const planAuthority = makeFakePlanAuthority();

  const { record } = a.repository.create({ text: 'Shared capture' });
  await a.bridge.syncCapture(record.id); // A establishes the capture on the shared room
  await b.pull(record.id); // B learns of it

  const archived = await b.archiveAndPush(record.id); // B archives and pushes — remote now authoritative
  assert.ok(archived.ok);
  assert.equal(room.raw()[record.id].status, 'archived');

  // A never pulled B's archive — A's own local cache still shows the capture
  // untriaged/triaged (the genuine stale-client reproduction).
  assert.equal(a.repository.read(record.id).status, 'untriaged');

  const staleAttempt = await promoteCaptureToPlan({ repository: a.repository, planAuthority, claimPromotionRemote: a.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 100, deviceId: 'device-a' });
  assert.equal(staleAttempt.ok, false);
  assert.equal(staleAttempt.reason, 'already-disposed', 'A receives an explicit, non-success refusal');
  assert.equal(planAuthority.calls.addItem, 0, 'no plan item is ever created');
  assert.equal(room.raw()[record.id].status, 'archived', 'remote remains archived');
  assert.equal(a.repository.read(record.id).status, 'archived', 'A converges to the authoritative truth as a side effect of the refused claim attempt');
});

test('2. DELEGATE FIRST, STALE PROMOTE SECOND: remote stays delegated, delegatedTo preserved, no plan item, A converges to delegated', async () => {
  const room = makeRoom();
  const a = makeDevice({ room, deviceId: 'device-a' });
  const b = makeDevice({ room, deviceId: 'device-b', now: T0 + 50 });
  const planAuthority = makeFakePlanAuthority();

  const { record } = a.repository.create({ text: 'Hand this off' });
  await a.bridge.syncCapture(record.id);
  await b.pull(record.id);

  const delegated = await b.delegateAndPush(record.id, 'Alex');
  assert.ok(delegated.ok);

  assert.equal(a.repository.read(record.id).status, 'untriaged', 'A is still stale');

  const staleAttempt = await promoteCaptureToPlan({ repository: a.repository, planAuthority, claimPromotionRemote: a.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 100, deviceId: 'device-a' });
  assert.equal(staleAttempt.ok, false);
  assert.equal(staleAttempt.reason, 'already-disposed');
  assert.equal(planAuthority.calls.addItem, 0);
  assert.equal(room.raw()[record.id].status, 'delegated');
  assert.equal(room.raw()[record.id].delegatedTo, 'Alex', 'provenance preserved on the authoritative remote record');
  assert.equal(a.repository.read(record.id).status, 'delegated');
  assert.equal(a.repository.read(record.id).delegatedTo, 'Alex', 'A converges with the provenance intact');
});

test('3. PROMOTION CLAIM FIRST, ARCHIVE SECOND: archive is refused/loses, plan item created exactly once, final capture promoted', async () => {
  const room = makeRoom();
  const a = makeDevice({ room, deviceId: 'device-a' });
  const b = makeDevice({ room, deviceId: 'device-b', now: T0 + 50 });
  const planAuthority = makeFakePlanAuthority();

  const { record } = a.repository.create({ text: 'Promote first' });
  await a.bridge.syncCapture(record.id);
  await b.pull(record.id);

  const promoted = await promoteCaptureToPlan({ repository: a.repository, planAuthority, claimPromotionRemote: a.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 10, deviceId: 'device-a' });
  assert.ok(promoted.ok);
  assert.equal(planAuthority.items.length, 1);
  await a.bridge.syncCapture(record.id); // push the finalize (local-first by design)

  // B never pulled A's promotion — B's local cache is still stale.
  assert.equal(b.repository.read(record.id).status, 'untriaged');
  const bArchive = await b.archiveAndPush(record.id);
  // The LOCAL archive write succeeds against B's stale cache (archive is still
  // local-first, unchanged) — but its PUSH loses the authority-rank merge
  // against the already-promoted remote (round 1's fix, still in force).
  assert.ok(bArchive.ok, 'the local write itself is not refused (archive stays local-first)');
  assert.equal(room.raw()[record.id].status, 'promoted', 'the push does not override the authoritative promotion');
  assert.equal(planAuthority.items.length, 1, 'still exactly one plan item');
  await b.pull(record.id);
  assert.equal(b.repository.read(record.id).status, 'promoted', 'B converges to the winning promotion, not its own archive');
});

test('4. PROMOTION CLAIM FIRST, DELEGATE SECOND: same guarantee as archive', async () => {
  const room = makeRoom();
  const a = makeDevice({ room, deviceId: 'device-a' });
  const b = makeDevice({ room, deviceId: 'device-b', now: T0 + 50 });
  const planAuthority = makeFakePlanAuthority();

  const { record } = a.repository.create({ text: 'Promote beats delegate' });
  await a.bridge.syncCapture(record.id);
  await b.pull(record.id);

  const promoted = await promoteCaptureToPlan({ repository: a.repository, planAuthority, claimPromotionRemote: a.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 10, deviceId: 'device-a' });
  assert.ok(promoted.ok);
  await a.bridge.syncCapture(record.id); // push the finalize (local-first by design)

  const bDelegate = await b.delegateAndPush(record.id, 'Alex');
  assert.ok(bDelegate.ok, 'the local write is not refused');
  assert.equal(room.raw()[record.id].status, 'promoted');
  assert.equal(room.raw()[record.id].delegatedTo, null, 'delegate never wins, never records provenance remotely');
  assert.equal(planAuthority.items.length, 1);
});

test('5. STALE SCHEDULE PROMOTION AFTER ARCHIVE is blocked exactly like Do Today', async () => {
  const room = makeRoom();
  const a = makeDevice({ room, deviceId: 'device-a' });
  const b = makeDevice({ room, deviceId: 'device-b', now: T0 + 50 });
  const planAuthority = makeFakePlanAuthority();

  const { record } = a.repository.create({ text: 'Scheduled, but archived first' });
  await a.bridge.syncCapture(record.id);
  await b.pull(record.id);
  await b.archiveAndPush(record.id);

  assert.equal(a.repository.read(record.id).status, 'untriaged');
  const staleSchedule = await promoteCaptureToPlan({ repository: a.repository, planAuthority, claimPromotionRemote: a.claimPromotionRemote, id: record.id, type: 'schedule', dateKey: '2026-10-15', now: T0 + 100, deviceId: 'device-a' });
  assert.equal(staleSchedule.ok, false);
  assert.equal(staleSchedule.reason, 'already-disposed');
  assert.equal(planAuthority.calls.addItem, 0);
  assert.equal(room.raw()[record.id].status, 'archived');
});

test('6. TWO DIFFERENT PROMOTION TARGETS (Do Today vs Schedule): one authoritative claim only, one destination only', async () => {
  const room = makeRoom();
  const a = makeDevice({ room, deviceId: 'device-a' });
  const b = makeDevice({ room, deviceId: 'device-b', now: T0 + 50 }); // later clock, so A's claim is EARLIER
  const planAuthority = makeFakePlanAuthority();

  const { record } = a.repository.create({ text: 'Competing targets' });
  await a.bridge.syncCapture(record.id);
  await b.pull(record.id);

  // Both devices attempt to claim CONCURRENTLY (neither has seen the other's
  // claim yet): A claims Do Today, B claims a different Schedule date.
  const [aResult, bResult] = await Promise.all([
    promoteCaptureToPlan({ repository: a.repository, planAuthority, claimPromotionRemote: a.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 10, deviceId: 'device-a' }),
    promoteCaptureToPlan({ repository: b.repository, planAuthority, claimPromotionRemote: b.claimPromotionRemote, id: record.id, type: 'schedule', dateKey: '2026-10-20', now: T0 + 60, deviceId: 'device-b' }),
  ]);

  const outcomes = [aResult, bResult];
  const winners = outcomes.filter(r => r.ok && !r.alreadyDisposed);
  const losers = outcomes.filter(r => !r.ok);
  assert.equal(winners.length, 1, 'exactly one side actually promotes');
  assert.equal(losers.length, 1, 'the other is refused, never silently succeeds');
  assert.equal(losers[0].reason, 'already-claimed');
  assert.equal(planAuthority.items.length, 1, 'only the winning destination is ever created');
  assert.equal(planAuthority.items[0].id, brainDumpPlanItemId(record.id));
});

test('7. OFFLINE PROMOTION ATTEMPT: no plan item side effect, capture remains retryable, reconnect then resolves against fresh truth', async () => {
  const room = makeRoom();
  const device = makeDevice({ room });
  const planAuthority = makeFakePlanAuthority();
  const { record } = device.repository.create({ text: 'Offline attempt' });

  room.goOffline();
  const offlineAttempt = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  assert.equal(offlineAttempt.ok, false);
  assert.equal(offlineAttempt.reason, 'offline');
  assert.equal(planAuthority.calls.addItem, 0, 'no plan item side effect while offline');
  assert.equal(device.repository.read(record.id).status, 'untriaged', 'fully retryable — no fake local claim');
  assert.equal(device.repository.read(record.id).promotionClaim, null);

  room.goOnline();
  const retry = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 2, deviceId: 'device-1' });
  assert.ok(retry.ok);
  assert.equal(planAuthority.calls.addItem, 1);
});

test('8. CLAIM WINS, THEN CRASH BEFORE PLAN WRITE: retry recovers and creates exactly one destination', async () => {
  const room = makeRoom();
  const device = makeDevice({ room });
  const planAuthority = makeFakePlanAuthority();
  const { record } = device.repository.create({ text: 'Crash before plan write' });

  // Phase 1 only — simulate the crash by calling claimPromotionRemote directly
  // and never proceeding to Plan Authority.
  const target = planAuthority.current();
  const planItemId = brainDumpPlanItemId(record.id);
  const claim = await device.claimPromotionRemote(record.id, { type: 'do-today', store: target.store, targetId: target.id, planItemId });
  assert.ok(claim.ok);
  assert.equal(planAuthority.items.length, 0, 'CRASH — nothing created yet');
  assert.equal(device.repository.read(record.id).status, 'untriaged');

  // Archive must fail closed during this window.
  const archiveDuringWindow = device.repository.archive(record.id);
  assert.equal(archiveDuringWindow.ok, false);
  assert.equal(archiveDuringWindow.reason, 'promotion-claimed');

  // RETRY recovers via the full flow (re-claims the SAME target — idempotent —
  // then creates and finalizes).
  const retry = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 5, deviceId: 'device-1' });
  assert.ok(retry.ok);
  assert.equal(planAuthority.calls.addItem, 1);
  assert.equal(planAuthority.items.length, 1);
  assert.equal(device.repository.read(record.id).status, 'promoted');
});

test('9. PLAN WRITE SUCCEEDS, THEN FINALIZE FAILS: retry finalizes, no duplicate destination', async () => {
  const room = makeRoom();
  const device = makeDevice({ room });
  const planAuthority = makeFakePlanAuthority();
  const { record } = device.repository.create({ text: 'Finalize interrupted' });

  const target = planAuthority.current();
  const planItemId = brainDumpPlanItemId(record.id);
  const claim = await device.claimPromotionRemote(record.id, { type: 'do-today', store: target.store, targetId: target.id, planItemId });
  assert.ok(claim.ok);
  planAuthority.addItem({ destination: target, item: { id: planItemId, task: record.text, when: '', done: false, doneAt: null, updatedAt: T0 + 1, updatedBy: 'device-1', kind: 'task' }, nowMs: T0 + 1 });
  // CRASH — finalizePromotion never runs.
  assert.equal(device.repository.read(record.id).status, 'untriaged');
  assert.equal(planAuthority.items.length, 1);

  const retry = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 10, deviceId: 'device-1' });
  assert.ok(retry.ok);
  assert.equal(planAuthority.calls.addItem, 1, 'the plan item was not re-created on retry');
  assert.equal(planAuthority.items.length, 1);
  assert.equal(device.repository.read(record.id).status, 'promoted');
});

test('10. STALE SNAPSHOT AFTER SUCCESS cannot revert authoritative promoted/archived/delegated truth', async () => {
  const room = makeRoom();
  const device = makeDevice({ room });
  const planAuthority = makeFakePlanAuthority();
  const { record } = device.repository.create({ text: 'Settled truth' });
  const promoted = await promoteCaptureToPlan({ repository: device.repository, planAuthority, claimPromotionRemote: device.claimPromotionRemote, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  assert.ok(promoted.ok);

  // A stale snapshot from BEFORE the promotion (lower updatedAt), arriving late
  // over the network, showing the capture as archived from a peer that never
  // saw the promotion.
  const staleArchived = { ...device.repository.read(record.id), status: 'archived', promotion: null, promotionClaim: null, disposedAt: T0, updatedAt: T0, updatedBy: 'device-2' };
  device.bridge.handleRemoteRecord(record.id, staleArchived, 'uid_a');
  assert.equal(device.repository.read(record.id).status, 'promoted', 'the stale snapshot cannot resurrect over the promoted truth');
  assert.deepEqual(device.repository.read(record.id).promotion, promoted.record.promotion);
});

test('10b. a stale remote snapshot cannot resurrect over an already-ARCHIVED authoritative truth either', async () => {
  const room = makeRoom();
  const device = makeDevice({ room });
  const { record } = device.repository.create({ text: 'Archived truth' });
  await device.archiveAndPush(record.id);
  const staleClaim = { ...device.repository.read(record.id), status: 'triaged', disposedAt: null, promotionClaim: { type: 'do-today', store: 'legacy', targetId: '2026-10-01', planItemId: brainDumpPlanItemId(record.id), claimedAt: T0 - 1000, claimedBy: 'device-2' }, updatedAt: T0 - 1000, updatedBy: 'device-2' };
  device.bridge.handleRemoteRecord(record.id, staleClaim, 'uid_a');
  assert.equal(device.repository.read(record.id).status, 'archived', 'a stale claim-in-progress snapshot cannot override an already-settled archive either');
});

// test #11 (account switch during a claimed/claiming promotion) lives in
// brain-dump-account-isolation.test.js, which already owns the full
// storage.js-style switchTo()/signOut() harness this needs.
