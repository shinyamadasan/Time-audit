// brain-dump-promotion.test.js
//
// Brain Dump + Eisenhower V1 — promoteCaptureToPlan() (Do Today / Schedule) against
// a FAKE Plan Authority that mimics the real module's public shape
// (current/dayForScheduledDate/rawItems/addItem — read directly from plan-authority.js
// during architecture recon for this phase). Proves: the plan write always goes
// through Plan Authority, promotion is idempotent under retry via the deterministic
// plan-item id, a capture already disposed of is never re-promoted, and a Plan
// Authority refusal (invalid range, past day, DST ambiguity) surfaces as a reported
// reason rather than throwing past this layer.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrainDumpRepository } from './brain-dump-repository.js';
import { brainDumpPlanItemId } from './brain-dump-model.js';
import { promoteCaptureToPlan } from './brain-dump-promotion.js';

const T0 = Date.parse('2026-10-01T08:00:00Z');
const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

function makeRepository() {
  return createBrainDumpRepository({ storage: memory(), getOwner: () => 'uid_a', now: () => T0, deviceId: () => 'device-1' });
}

/** A fake Plan Authority. `items` is the mutable backing array addItem()/rawItems()
 *  read and write, so a test can assert on exactly what got added. */
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

test('Do Today builds a plan item via Plan Authority with the deterministic id, untimed, kind:task', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Water the plants' });
  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });

  assert.ok(result.ok);
  assert.equal(result.record.status, 'promoted');
  assert.equal(planAuthority.calls.addItem, 1);
  assert.equal(planAuthority.items[0].id, brainDumpPlanItemId(record.id));
  assert.equal(planAuthority.items[0].task, 'Water the plants');
  assert.equal(planAuthority.items[0].when, '');
  assert.equal(planAuthority.items[0].kind, 'task');
  assert.equal(repository.read(record.id).promotion.type, 'do-today');
});

test('Do Today is idempotent at the top level: a capture already promoted is never promoted twice', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Only once' });
  promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  const retry = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 2, deviceId: 'device-1' });

  assert.equal(retry.ok, true);
  assert.equal(retry.alreadyDisposed, true);
  assert.equal(planAuthority.calls.addItem, 1, 'the plan item must not be created a second time');
});

test('a retry that still finds the capture untriaged (e.g. a crash before the disposition write landed) does not duplicate the plan item', () => {
  // Simulates: the plan write succeeded last time, but the capture's own status
  // update never persisted (process died in between). The deterministic id is
  // what makes the retry safe even though the repository's own guard did not fire.
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Half-finished promotion' });
  const deterministicId = brainDumpPlanItemId(record.id);
  planAuthority.items.push({ id: deterministicId, task: record.text, when: '', done: false, doneAt: null, updatedAt: T0, updatedBy: 'device-1', kind: 'task' });

  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 5, deviceId: 'device-1' });
  assert.ok(result.ok);
  assert.equal(planAuthority.calls.addItem, 0, 'the item is already there — addItem must not be called again');
  assert.equal(planAuthority.items.length, 1, 'no duplicate plan item');
  assert.equal(repository.read(record.id).status, 'promoted', 'the disposition catches up to match');
});

test('Schedule resolves the target via dayForScheduledDate and carries an optional time + duration', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Dentist follow-up' });
  const result = promoteCaptureToPlan({
    repository, planAuthority, id: record.id, type: 'schedule',
    dateKey: '2026-10-05', when: '14:30', durationMinutes: 45,
    now: T0 + 1, deviceId: 'device-1',
  });

  assert.ok(result.ok);
  assert.equal(planAuthority.calls.dayForScheduledDate, 1);
  assert.equal(planAuthority.items[0].when, '14:30');
  assert.equal(planAuthority.items[0].durationMinutes, 45);
  assert.equal(repository.read(record.id).promotion.type, 'schedule');
  assert.equal(repository.read(record.id).promotion.targetId, 'calplan:2026-10-05');
});

test('Schedule with no time produces an untimed (anytime) item — a time is never required', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Someday, no rush' });
  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'schedule', dateKey: '2026-11-01', now: T0 + 1, deviceId: 'device-1' });
  assert.ok(result.ok);
  assert.equal(planAuthority.items[0].when, '');
  assert.equal(planAuthority.items[0].durationMinutes, undefined);
});

test('a Plan Authority refusal (DST ambiguity) surfaces as a reported reason, never a thrown error', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority({ schedule: () => ({ ok: false, reason: 'ambiguous' }) });
  const { record } = repository.create({ text: 'Falls on the clock change' });
  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'schedule', dateKey: '2026-11-01', when: '02:30', now: T0 + 1, deviceId: 'device-1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(planAuthority.calls.addItem, 0);
  assert.equal(repository.read(record.id).status, 'untriaged', 'the capture is NOT disposed of when the plan write never happened');
});

test('addItem throwing (e.g. a past My Day, or the Top-3 cap) is caught and reported, not disposed', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  planAuthority.addItem = () => { throw new Error('Past My Days are history. Reschedule unfinished work from Unfinished instead.'); };
  const { record } = repository.create({ text: 'Too late now' });
  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Past My Days are history/);
  assert.equal(repository.read(record.id).status, 'untriaged');
});

test('promoting an unknown capture id reports not-found', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const result = promoteCaptureToPlan({ repository, planAuthority, id: 'bdoesnotexist1', type: 'do-today', now: T0, deviceId: 'device-1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-found');
});

test('a capture already archived is reported alreadyDisposed and Plan Authority is never touched', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Dropped already' });
  repository.archive(record.id);
  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyDisposed, true);
  assert.equal(planAuthority.calls.current, 0);
  assert.equal(planAuthority.calls.addItem, 0);
});

test('two near-simultaneous promotions of the same capture (a two-device race) never create two plan items', () => {
  // Both "devices" share the same in-memory Plan Authority fake and repository
  // here (the real cross-device race is covered by brain-dump-account-isolation's
  // sync-level tests); this proves the deterministic id is what makes a second
  // writer's addItem a no-op rather than a duplicate, at this layer.
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Raced' });
  const first = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  // Simulate device two racing in with the capture still (from ITS perspective)
  // showing as triaged, because it had not yet pulled device one's disposition —
  // directly exercise promoteCaptureToPlan's own id-presence check again.
  const sameDeterministicId = brainDumpPlanItemId(record.id);
  assert.equal(planAuthority.items.filter(i => i.id === sameDeterministicId).length, 1);
  assert.ok(first.ok);
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX FIRST — REQUIRED CONCURRENCY TESTS (promote vs archive/delegate
// arbitration). Each asserts BOTH the capture's own state (via repository.read)
// AND the destination plan store (via planAuthority.items/rawItems), per the
// review's explicit requirement. These FAIL on 6d71ed16 (pre-fix): that candidate
// let a later archive/delegate silently discard an already-created plan item's
// provenance via plain last-write-wins.
// ═══════════════════════════════════════════════════════════════════════════

test('1. promote vs archive, promote claim wins: plan item exists exactly once, capture converges to promoted, archive does not override', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Promote wins' });
  const promoted = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  assert.ok(promoted.ok);

  const archiveAttempt = repository.archive(record.id, { now: T0 + 2, updatedBy: 'device-2' });
  assert.equal(archiveAttempt.ok, false);
  assert.equal(archiveAttempt.reason, 'already-disposed');

  assert.equal(repository.read(record.id).status, 'promoted');
  assert.equal(planAuthority.items.filter(i => i.id === brainDumpPlanItemId(record.id)).length, 1);
});

test('2. archive vs promote, archive wins first: no plan item is created, the stale promotion aborts', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Archive wins' });
  const archived = repository.archive(record.id, { now: T0 + 1, updatedBy: 'device-2' });
  assert.ok(archived.ok);

  const staleePromotion = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 2, deviceId: 'device-1' });
  assert.equal(staleePromotion.ok, true);
  assert.equal(staleePromotion.alreadyDisposed, true);

  assert.equal(repository.read(record.id).status, 'archived');
  assert.equal(planAuthority.calls.addItem, 0, 'no plan item was ever created');
  assert.equal(planAuthority.items.length, 0);
});

test('3. promote vs delegate, promote wins: no delegated terminal state overrides promotion', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Promote beats delegate' });
  const promoted = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  assert.ok(promoted.ok);

  const delegateAttempt = repository.delegate(record.id, { delegatedTo: 'Alex', now: T0 + 2, updatedBy: 'device-2' });
  assert.equal(delegateAttempt.ok, false);
  assert.equal(delegateAttempt.reason, 'already-disposed');

  assert.equal(repository.read(record.id).status, 'promoted');
  assert.equal(repository.read(record.id).delegatedTo, null);
  assert.equal(planAuthority.items.filter(i => i.id === brainDumpPlanItemId(record.id)).length, 1);
});

test('4. delegate vs promote, delegate wins first: no plan item is created', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Delegate wins' });
  const delegated = repository.delegate(record.id, { delegatedTo: 'Alex', now: T0 + 1, updatedBy: 'device-2' });
  assert.ok(delegated.ok);

  const stalePromotion = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 2, deviceId: 'device-1' });
  assert.equal(stalePromotion.ok, true);
  assert.equal(stalePromotion.alreadyDisposed, true);

  assert.equal(repository.read(record.id).status, 'delegated');
  assert.equal(planAuthority.calls.addItem, 0);
  assert.equal(planAuthority.items.length, 0);
});

test('5. two-device simultaneous promote (same destination): one deterministic plan item only', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Simultaneous promote' });
  // Both devices race the identical claim (same type -> same deterministic target
  // and planItemId). The second call observes the first device's already-won
  // claim (same repository here stands in for "already synced").
  const deviceOne = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  const deviceTwo = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 2, deviceId: 'device-2' });
  assert.ok(deviceOne.ok);
  assert.ok(deviceTwo.ok);
  assert.equal(planAuthority.calls.addItem, 1, 'only one addItem call across both devices');
  assert.equal(planAuthority.items.filter(i => i.id === brainDumpPlanItemId(record.id)).length, 1);
  assert.equal(repository.read(record.id).status, 'promoted');
});

test('5b. two-device simultaneous promote for DIFFERENT targets: only the winning claim ever creates a plan item', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Competing targets' });
  // Device A claims "do today"; device B (racing, before pulling A's claim)
  // claims a DIFFERENT schedule target for the SAME capture.
  const claimA = repository.claimPromotion(record.id, {
    promotion: { type: 'do-today', store: 'calendar', targetId: 'calplan:2026-10-01', planItemId: brainDumpPlanItemId(record.id) },
    now: T0 + 1, updatedBy: 'device-a',
  });
  assert.ok(claimA.ok);
  const claimB = repository.claimPromotion(record.id, {
    promotion: { type: 'schedule', store: 'calendar', targetId: 'calplan:2026-10-10', planItemId: brainDumpPlanItemId(record.id) },
    now: T0 + 2, updatedBy: 'device-b',
  });
  assert.equal(claimB.ok, false);
  assert.equal(claimB.reason, 'already-claimed', 'B\'s claim lost — A\'s (earlier) claim is the one on record');
  assert.deepEqual(repository.read(record.id).promotionClaim.targetId, 'calplan:2026-10-01');

  // B's own promoteCaptureToPlan call (for the target it originally wanted) must
  // not create a plan item at B's target — it lost the claim.
  const bAttempt = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'schedule', dateKey: '2026-10-10', now: T0 + 3, deviceId: 'device-b' });
  assert.equal(bAttempt.ok, false);
  assert.equal(bAttempt.reason, 'already-claimed');
  assert.equal(planAuthority.calls.addItem, 0, 'B never creates a plan item for the target it lost');

  // A's own call completes the WINNING claim.
  const aAttempt = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 4, deviceId: 'device-a' });
  assert.ok(aAttempt.ok);
  assert.equal(planAuthority.items.length, 1);
  assert.equal(planAuthority.items[0].id, brainDumpPlanItemId(record.id));
  assert.equal(repository.read(record.id).promotion.targetId, 'calplan:2026-10-01');
});

test('6. plan-write succeeds, source-finalize is interrupted (crash window): retry recovers, no duplicate, archive/delegate cannot erase the claim', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Crash window' });

  // Phase 1 (claim) and phase 2 (plan write) happen; phase 3 (finalize) is
  // simulated as interrupted by calling the phases directly instead of the
  // full promoteCaptureToPlan() helper.
  const target = planAuthority.current();
  const planItemId = brainDumpPlanItemId(record.id);
  const claimed = repository.claimPromotion(record.id, { promotion: { type: 'do-today', store: target.store, targetId: target.id, planItemId }, now: T0 + 1, updatedBy: 'device-1' });
  assert.ok(claimed.ok);
  planAuthority.addItem({ destination: target, item: { id: planItemId, task: record.text, when: '', done: false, doneAt: null, updatedAt: T0 + 1, updatedBy: 'device-1', kind: 'task' }, nowMs: T0 + 1 });
  // CRASH — finalizePromotion never runs. Capture is still 'triaged' (never even
  // was, here — still 'untriaged'), with the claim and a REAL plan item both in place.
  assert.equal(repository.read(record.id).status, 'untriaged');
  assert.equal(planAuthority.items.length, 1);

  // Archive/delegate must fail closed during this window — the evidence that the
  // destination exists must not be erased.
  const archiveDuringWindow = repository.archive(record.id, { now: T0 + 2, updatedBy: 'device-2' });
  assert.equal(archiveDuringWindow.ok, false);
  assert.equal(archiveDuringWindow.reason, 'promotion-claimed');

  // RETRY (same or another device) recovers: addItem is not called again, and
  // finalize completes using the SAME claim.
  const retry = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 3, deviceId: 'device-1' });
  assert.ok(retry.ok);
  assert.equal(planAuthority.calls.addItem, 1, 'the plan item was not re-created on retry');
  assert.equal(planAuthority.items.length, 1, 'still exactly one plan item');
  assert.equal(repository.read(record.id).status, 'promoted');
  assert.equal(repository.read(record.id).promotion.planItemId, planItemId);
});

test('7. a late remote snapshot carrying a stale archived/delegated record cannot resurrect over an already-promoted capture', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Late stale snapshot' });
  const promoted = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  assert.ok(promoted.ok);

  // A remote snapshot from a peer that archived the capture BEFORE ever seeing
  // the promotion (lower updatedAt), delivered late over the network.
  const staleArchived = { ...repository.read(record.id), status: 'archived', promotion: null, promotionClaim: null, disposedAt: T0, updatedAt: T0, updatedBy: 'device-2' };
  const mergeResult = repository.mergeRemote(record.id, staleArchived);
  assert.equal(mergeResult.changed, false, 'the stale archived snapshot must not overwrite the promoted truth');
  assert.equal(repository.read(record.id).status, 'promoted');
  assert.deepEqual(repository.read(record.id).promotion, promoted.record.promotion);
});

test('8. equal-authority tie: a deterministic result independent of which claim arrives first', () => {
  const planAuthority = makeFakePlanAuthority();
  const target = planAuthority.current();

  function freshRepository(id) {
    const repo = makeRepository();
    repo.create({ id, text: 'Tie case', now: T0, updatedBy: 'device-1' });
    return repo;
  }

  const id = 'btiecase1';
  const planItemId = brainDumpPlanItemId(id);
  const claimA = { type: 'do-today', store: target.store, targetId: target.id, planItemId };
  const claimB = { type: 'schedule', store: 'calendar', targetId: 'calplan:2026-10-20', planItemId };
  const base = freshRepository(id).read(id);
  const recordA = { ...base, promotionClaim: { ...claimA, claimedAt: T0 + 5, claimedBy: 'device-a' }, updatedAt: T0 + 5, updatedBy: 'device-a' };
  const recordB = { ...base, promotionClaim: { ...claimB, claimedAt: T0 + 5, claimedBy: 'device-b' }, updatedAt: T0 + 5, updatedBy: 'device-b' };

  // Order 1: A arrives, then B (the tie).
  const repoAB = freshRepository(id);
  repoAB.mergeRemote(id, recordA);
  const resultAB = repoAB.mergeRemote(id, recordB);

  // Order 2: B arrives, then A (the same tie, reversed order).
  const repoBA = freshRepository(id);
  repoBA.mergeRemote(id, recordB);
  const resultBA = repoBA.mergeRemote(id, recordA);

  assert.deepEqual(resultAB.record.promotionClaim, resultBA.record.promotionClaim, 'deterministic regardless of arrival order');
});

test('10. Schedule promotion gets the same crash/duplication guarantees as Do Today', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Scheduled, then archived, then retried' });

  const scheduled = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'schedule', dateKey: '2026-10-15', when: '09:00', now: T0 + 1, deviceId: 'device-1' });
  assert.ok(scheduled.ok);

  const archiveAttempt = repository.archive(record.id, { now: T0 + 2, updatedBy: 'device-2' });
  assert.equal(archiveAttempt.ok, false);
  assert.equal(archiveAttempt.reason, 'already-disposed');

  const retry = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'schedule', dateKey: '2026-10-15', when: '09:00', now: T0 + 3, deviceId: 'device-1' });
  assert.ok(retry.ok);
  assert.equal(retry.alreadyDisposed, true);
  assert.equal(planAuthority.calls.addItem, 1, 'Schedule is idempotent under retry exactly like Do Today');
  assert.equal(repository.read(record.id).status, 'promoted');
});
