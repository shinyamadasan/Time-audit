// plan-authority-deadline-streak.test.js
//
// Calendar Day + Extended My Day V1 — planningDeadlineStreak(), the new
// deadline-based streak authority layered onto plan-authority.js, tested
// against a never-enabled (Personal Day boundary off) account, since that
// account is already calendar-date-canonical (per the project's own audit:
// "for a never-enabled account, day is already calendar-canonical").

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanAuthority } from './plan-authority.js';
import { createPlanByDeadlineRepository } from './plan-by-deadline-repository.js';

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
