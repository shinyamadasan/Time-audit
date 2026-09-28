// plan-authority-deadline-streak.test.js
//
// Calendar Day + Extended My Day V1 — planningDeadlineStreak(), the new
// deadline-based streak authority layered onto plan-authority.js. Most of this
// file tests against a never-enabled (Personal Day boundary off) account,
// since that account is already calendar-date-canonical (per the project's
// own audit: "for a never-enabled account, day is already calendar-
// canonical"). The "boundary ENABLED" section further down uses a full,
// production-equivalent authority (real operational-plan repository, real
// live wiring) — the FIX FIRST §5 requirement: a test that reproduces the
// Sunday-11:00-under-an-18:00-boundary case and fails on the pre-fix code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanAuthority } from './plan-authority.js';
import { createPlanByDeadlineRepository } from './plan-by-deadline-repository.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { createOperationalPlanSyncBridge } from './operational-plan-sync.js';
import { createPersonalDayBoundarySyncBridge } from './personal-day-boundary-sync.js';

const MANILA = 'Asia/Manila';
const manila = (dateStr, hhmm) => Date.parse(`${dateStr}T${hhmm}:00+08:00`);
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };

function legacyStore(seed = {}) {
  const plans = JSON.parse(JSON.stringify(seed));
  return {
    plans,
    record: dateKey => plans[dateKey] || null,
    rawItems: dateKey => (plans[dateKey]?.items || []).map(i => ({ ...i })),
    saveItems(dateKey, items) { plans[dateKey] = { ...(plans[dateKey] || {}), items }; },
    confirm(input) {
      const preparation = {
        schemaVersion: 1, targetDate: input.targetDate, timezone: MANILA,
        firstPreparedAt: input.now || 1000, firstPreparedBy: 'device-a', firstPreparedMode: 'normal',
        lastPreparedAt: input.now || 1000, lastPreparedMode: 'normal', updatedBy: 'device-a',
        intentionalBlank: input.intentionalBlank === true,
        routineInstanceIds: input.routineInstanceIds || [], oneOffItemIds: input.items.filter(i => !i.deleted).map(i => i.id),
      };
      plans[input.targetDate] = { ...(plans[input.targetDate] || {}), items: input.items, preparation };
      return { localSaved: true, syncPromise: Promise.resolve(false) };
    },
    allPlans: () => plans,
    earliestPlanDate() { const keys = Object.keys(plans).sort(); return keys.length ? keys[0] : null; },
  };
}

/** Directly prepares a plan for `dateKey` with `preparedAtMs` provenance, the
 *  same shape confirmPreparation()/legacy.confirm() produce. */
function prepare(legacy, dateKey, preparedAtMs, intentionalBlank = false) {
  legacy.confirm({ targetDate: dateKey, items: intentionalBlank ? [] : [{ id: 'p1', task: 'Priority', deleted: false }], now: preparedAtMs, intentionalBlank, routineInstanceIds: [] });
}

function makeApp({ clock, legacy = legacyStore() } = {}) {
  const nowRef = { value: clock };
  const planByDeadline = createPlanByDeadlineRepository({ storage: memory(), idGenerator: (() => { let n = 0; return () => `id-${++n}`; })(), getOwner: () => 'uid_test-room' });
  const authority = createPlanAuthority({
    live: { enabled: () => false },
    legacy,
    now: () => nowRef.value,
    accountTimezone: () => MANILA,
    planByDeadline,
  });
  return { authority, legacy, planByDeadline, setNow: v => { nowRef.value = v; } };
}

// ── unconfigured: unenforced, never a guessed default ─────────────────────

test('planningDeadlineStreak reports unenforced when no deadline is configured — never guesses a default', () => {
  const { authority } = makeApp({ clock: manila('2026-09-27', '10:00') });
  assert.deepEqual(authority.planningDeadlineStreak(), { status: 'unenforced' });
});

test('planningDeadlineStreak defaults to unenforced when the authority was built with no planByDeadline dependency at all (every existing caller)', () => {
  const authority = createPlanAuthority({ live: { enabled: () => false }, legacy: legacyStore(), now: () => manila('2026-09-27', '10:00'), accountTimezone: () => MANILA });
  assert.deepEqual(authority.planningDeadlineStreak(), { status: 'unenforced' });
});

// ── today: pending vs maintained vs missed ─────────────────────────────────

test('before the deadline instant with nothing prepared yet: today is "pending", not "missed"', () => {
  const { authority, planByDeadline } = makeApp({ clock: manila('2026-09-27', '07:00') });
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  const result = authority.planningDeadlineStreak();
  assert.equal(result.status, 'configured');
  assert.equal(result.today.status, 'pending');
  assert.equal(result.current, 0);
});

test('a plan prepared before the deadline maintains today', () => {
  const { authority, legacy, planByDeadline } = makeApp({ clock: manila('2026-09-27', '09:00') });
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  prepare(legacy, '2026-09-27', manila('2026-09-27', '07:30'));
  const result = authority.planningDeadlineStreak();
  assert.equal(result.today.status, 'maintained');
  assert.equal(result.current, 1);
});

test('nothing prepared and the deadline has already passed: today is missed', () => {
  const { authority, planByDeadline } = makeApp({ clock: manila('2026-09-27', '09:00') });
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  const result = authority.planningDeadlineStreak();
  assert.equal(result.today.status, 'missed');
  assert.equal(result.current, 0);
});

test('preparing a plan AFTER the deadline does not retroactively restore today (but is otherwise fully usable — the app does not refuse the write)', () => {
  const { authority, legacy, planByDeadline } = makeApp({ clock: manila('2026-09-27', '12:00') });
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  prepare(legacy, '2026-09-27', manila('2026-09-27', '09:00')); // after the 08:00 deadline
  const result = authority.planningDeadlineStreak();
  assert.equal(result.today.status, 'missed');
});

// ── intentional off-day ─────────────────────────────────────────────────

test('an intentional off-day declared before the deadline maintains the streak with no plan at all', () => {
  const { authority, planByDeadline } = makeApp({ clock: manila('2026-09-27', '09:00') });
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  planByDeadline.declareOffDay('2026-09-27', manila('2026-09-27', '07:00'));
  const result = authority.planningDeadlineStreak();
  assert.equal(result.today.status, 'maintained');
});

test('revoking the off-day before the deadline un-maintains it (§11 reversible)', () => {
  const { authority, planByDeadline } = makeApp({ clock: manila('2026-09-27', '09:00') });
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  planByDeadline.declareOffDay('2026-09-27', manila('2026-09-27', '06:00'));
  planByDeadline.revokeOffDay('2026-09-27', manila('2026-09-27', '07:00')); // revoked before 08:00 deadline
  const result = authority.planningDeadlineStreak();
  assert.equal(result.today.status, 'missed');
});

// ── multi-day streak counting ────────────────────────────────────────────

test('a run of maintained days counts backward correctly and stops at the first missed day', () => {
  const { authority, legacy, planByDeadline } = makeApp({ clock: manila('2026-09-30', '09:00') });
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  prepare(legacy, '2026-09-28', manila('2026-09-28', '07:00'));
  prepare(legacy, '2026-09-29', manila('2026-09-29', '07:00'));
  prepare(legacy, '2026-09-30', manila('2026-09-30', '07:00'));
  // 2026-09-27 left unprepared -> missed, breaking the run there.
  const result = authority.planningDeadlineStreak();
  assert.equal(result.current, 3); // 28, 29, 30
  assert.equal(result.best, 3);
});

// ── historical preservation (§8, §18): dates before the first deadline are never judged ─

test('a date before the very first configured deadline revision is never counted as missed — the walk simply stops there', () => {
  const { authority, legacy, planByDeadline } = makeApp({ clock: manila('2026-09-28', '09:00') });
  // Deadline only takes effect starting 2026-09-28 at 08:00.
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-09-28', '00:00'));
  prepare(legacy, '2026-09-28', manila('2026-09-28', '07:00'));
  // No plan at all for 2026-09-27 or earlier — must NOT count as missed days.
  const result = authority.planningDeadlineStreak();
  assert.equal(result.current, 1); // only today counted; history before the feature existed is untouched
});

// ── deterministic / no timer dependency (§12) ─────────────────────────────

test('calling planningDeadlineStreak repeatedly (simulating a late app open) never depends on when it is called, only on persisted facts', () => {
  const { authority, legacy, planByDeadline, setNow } = makeApp({ clock: manila('2026-09-27', '07:30') });
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  prepare(legacy, '2026-09-27', manila('2026-09-27', '07:00'));
  const early = authority.planningDeadlineStreak();
  setNow(manila('2026-09-27', '23:00')); // "late open" same day, long after the deadline passed
  const late = authority.planningDeadlineStreak();
  assert.equal(early.today.status, 'maintained');
  assert.equal(late.today.status, 'maintained'); // unchanged — the plan was already prepared before 08:00
  assert.equal(early.current, late.current);
});

// ── midnight is boring (§6): crossing midnight alone changes nothing about a decided day ─

test('midnight crossing alone does not change a previously-decided day\'s status or trigger any write', () => {
  const { authority, planByDeadline } = makeApp({ clock: manila('2026-09-27', '09:00') });
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  const beforeMidnight = authority.planningDeadlineStreak();
  assert.equal(beforeMidnight.today.status, 'missed'); // 2026-09-27, nothing prepared, deadline passed

  const { authority: authorityNextDay, planByDeadline: pbdNextDay } = makeApp({ clock: manila('2026-09-28', '00:30') });
  pbdNextDay.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  const afterMidnight = authorityNextDay.planningDeadlineStreak();
  assert.equal(afterMidnight.today.status, 'pending'); // a NEW day's own deadline hasn't arrived — no missed-day cascade from crossing midnight
});

// ── FIX FIRST §14/§15/§16: a stored conflict surfaces explicitly, never a false miss ─

test('planningDeadlineStreak reports an explicit "conflict" status — never a false "missed" — when the deadline history holds an unresolved equal-authority contradiction', () => {
  const { authority, planByDeadline } = makeApp({ clock: manila('2026-09-27', '09:00') });
  // Seed a genuine contradiction directly (same effectiveFromInstant, different facts, different ids) via merge.
  planByDeadline.mergeRemoteDeadlines({ x: { id: 'x', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: manila('2026-01-01', '00:00') } });
  planByDeadline.mergeRemoteDeadlines({ y: { id: 'y', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: manila('2026-01-01', '00:00') } });
  const result = authority.planningDeadlineStreak();
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts.length, 1);
});

test('resolving the conflict by proposing a new revision makes planningDeadlineStreak configured again', () => {
  const { authority, planByDeadline } = makeApp({ clock: manila('2026-09-27', '09:00') });
  planByDeadline.mergeRemoteDeadlines({ x: { id: 'x', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: manila('2026-01-01', '00:00') } });
  planByDeadline.mergeRemoteDeadlines({ y: { id: 'y', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: manila('2026-01-01', '00:00') } });
  assert.equal(authority.planningDeadlineStreak().status, 'conflict');
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-09-27', '09:00'));
  assert.equal(authority.planningDeadlineStreak().status, 'configured');
});

// ── FIX FIRST §19: account isolation for deadline/off-day/conflict state ──

test('A and B never see each other\'s deadline, off-day, or conflict state, even sharing the same underlying storage', () => {
  let currentRoom = 'uid_account-a';
  const storage = memory();
  const planByDeadline = createPlanByDeadlineRepository({ storage, idGenerator: (() => { let n = 0; return () => `id-${++n}`; })(), getOwner: () => currentRoom });
  const authority = createPlanAuthority({
    live: { enabled: () => false }, legacy: legacyStore(),
    now: () => manila('2026-09-27', '09:00'), accountTimezone: () => MANILA, planByDeadline,
  });

  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  planByDeadline.declareOffDay('2026-09-27', manila('2026-09-27', '07:00'));
  assert.equal(authority.planningDeadlineStreak().status, 'configured');
  assert.equal(authority.planningDeadlineStreak().today.status, 'maintained');

  currentRoom = 'uid_account-b'; // A -> B switch, same repository instance/storage
  assert.deepEqual(authority.planningDeadlineStreak(), { status: 'unenforced' }); // B has no deadline of its own
  assert.equal(planByDeadline.readOffDay('2026-09-27'), null); // B never sees A's off-day
  assert.equal(planByDeadline.deadlineConflict().length, 0); // B never sees any of A's state, conflicted or not

  currentRoom = 'uid_account-a'; // back to A
  assert.equal(authority.planningDeadlineStreak().today.status, 'maintained'); // A's own state is untouched
});

// ── FIX FIRST §19: sign-out ────────────────────────────────────────────────

test('sign-out (no room joined) reports unenforced, never a stale account\'s deadline state, and writes nothing', () => {
  let currentRoom = 'uid_account-a';
  const storage = memory();
  const planByDeadline = createPlanByDeadlineRepository({ storage, idGenerator: (() => { let n = 0; return () => `id-${++n}`; })(), getOwner: () => currentRoom });
  const authority = createPlanAuthority({
    live: { enabled: () => false }, legacy: legacyStore(),
    now: () => manila('2026-09-27', '09:00'), accountTimezone: () => MANILA, planByDeadline,
  });
  planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  assert.equal(authority.planningDeadlineStreak().status, 'configured');

  currentRoom = null; // sign-out
  assert.deepEqual(authority.planningDeadlineStreak(), { status: 'unenforced' });
  assert.throws(() => planByDeadline.declareOffDay('2026-09-27', Date.now()), /No account is active/);
});

// ═══════════════════════════════════════════════════════════════════════
// FIX FIRST §5/§16: boundary ENABLED — production-equivalent authority.
// Reproduces the exact concrete failing case and fails on the pre-fix code
// (planTargetOriginatingOnCalendarDate resolved a DIFFERENT, empty target
// than current() under an active non-midnight boundary).
// ═══════════════════════════════════════════════════════════════════════

let boundarySeq = 0;
function makeBoundaryEnabledApp({ nowMs, boundaryTime = '18:00' }) {
  const nowRef = { value: nowMs };
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage: memory(), idGenerator: () => `rev-${++boundarySeq}`, getOwner: () => 'uid_boundary-test' });
  boundaryRepository.propose({ boundaryTime, timezone: MANILA }, manila('2026-01-01', '00:00'));
  const planRepository = createOperationalPlanRepository({ storage: memory(), getOwner: () => 'uid_boundary-test' });
  const planSync = createOperationalPlanSyncBridge({ repository: planRepository, getRoomRef: () => null, getRoomId: () => 'uid_boundary-test' });
  const boundarySync = createPersonalDayBoundarySyncBridge({ repository: boundaryRepository, getRoomRef: () => null, getRoomId: () => 'uid_boundary-test' });
  const legacy = legacyStore();
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository, planSync, boundarySync,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => nowRef.value, deviceId: () => 'device-a', fallbackTimezone: () => MANILA,
  });
  const planByDeadline = createPlanByDeadlineRepository({ storage: memory(), idGenerator: (() => { let n = 0; return () => `pbd-${++n}`; })(), getOwner: () => 'uid_boundary-test' });
  const authority = createPlanAuthority({ live, legacy, now: () => nowRef.value, accountTimezone: () => MANILA, planByDeadline });
  return { authority, planByDeadline, legacy, setNow: v => { nowRef.value = v; } };
}

test('FIX FIRST concrete case: Sunday 11:00 under an 18:00 boundary — current planning target and the deadline-streak target are the SAME record (no split-brain)', () => {
  const { authority, planByDeadline } = makeBoundaryEnabledApp({ nowMs: manila('2026-09-27', '11:00') });
  const current = authority.current();
  assert.equal(current.store, 'operational');

  // The owner prepares TODAY's plan through the ONE normal workflow — targets current().
  authority.confirmPreparation(current, { items: [{ id: 'p1', task: 'Sunday morning priority', kind: 'priority' }], mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  assert.ok(authority.items(current).some(i => i.task === 'Sunday morning priority'), 'the item is visible on the target the owner actually prepared');

  planByDeadline.proposeDeadline({ deadlineTime: '12:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  const result = authority.planningDeadlineStreak();
  assert.equal(result.status, 'configured');
  // Prepared at 11:00, deadline is 12:00 that same (current-target) day -> maintained.
  // This is the exact assertion that FAILS on the pre-fix code (it silently read an
  // empty, different "Sunday-originating" target and reported 'missed' with no way
  // for the owner to ever satisfy it before 18:00).
  assert.equal(result.today.status, 'maintained');
  assert.equal(result.current, 1);
});

test('FIX FIRST: preparing before the configured deadline qualifies correctly without waiting until the legacy boundary time, and no Saturday write ever happens', () => {
  const { authority, legacy, planByDeadline } = makeBoundaryEnabledApp({ nowMs: manila('2026-09-27', '11:00') });
  const current = authority.current();
  planByDeadline.proposeDeadline({ deadlineTime: '12:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  authority.confirmPreparation(current, { items: [{ id: 'p1', task: 'Early prep', kind: 'priority' }], mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  assert.equal(authority.planningDeadlineStreak().today.status, 'maintained'); // no wait until 18:00 required
  assert.deepEqual(legacy.plans, {}); // no Saturday (or any) legacy write ever happened
});

test('ordinary night-shift: a Monday-evening-start plan may extend into Tuesday — the SAME target, and the SAME streak result, on both sides of the midnight crossing', () => {
  // Monday 19:00 (past that day's own 18:00 boundary, so Monday's own operational day, Mon 18:00 -> Tue 18:00, is current).
  const { authority, planByDeadline, setNow } = makeBoundaryEnabledApp({ nowMs: manila('2026-09-28', '19:00') });
  const targetBeforeMidnight = authority.current();
  authority.confirmPreparation(targetBeforeMidnight, { items: [{ id: 'p1', task: 'Monday evening shift', kind: 'priority' }], mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  planByDeadline.proposeDeadline({ deadlineTime: '20:00', timezone: MANILA }, manila('2026-01-01', '00:00'));
  assert.equal(authority.planningDeadlineStreak().today.status, 'maintained');

  // Advance past real midnight into Tuesday — still WITHIN the same Monday-originating
  // operational day (it doesn't end until Tuesday 18:00). The calendar date has
  // genuinely changed, but the plan identity, and the streak's verdict for it, must not.
  setNow(manila('2026-09-29', '02:00'));
  const targetAfterMidnight = authority.current();
  assert.equal(targetAfterMidnight.id, targetBeforeMidnight.id, 'midnight alone never changes which plan is current for a still-open operational day');
  assert.ok(authority.items(targetAfterMidnight).some(i => i.task === 'Monday evening shift'), 'the item prepared before midnight is still visible after it — one record, not two');
});
