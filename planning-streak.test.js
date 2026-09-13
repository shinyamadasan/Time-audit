import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDays, buildPreparation, mergePreparations, planningStreak } from './plan-tomorrow-model.js';

const tz = 'America/Phoenix';

function aheadPrep(targetDate, timezone, overrides = {}) {
  const previousDay = addCalendarDays(targetDate, -1);
  const firstPreparedAt = Date.parse(`${previousDay}T12:00:00Z`);
  return {
    schemaVersion: 1, targetDate, timezone,
    firstPreparedAt, firstPreparedMode: 'normal',
    lastPreparedAt: firstPreparedAt, lastPreparedMode: 'normal',
    updatedBy: 'device-a', intentionalBlank: false,
    routineInstanceIds: [], oneOffItemIds: ['one-1'],
    ...overrides
  };
}

function latePrep(targetDate, timezone, overrides = {}) {
  const firstPreparedAt = Date.parse(`${targetDate}T12:00:00Z`);
  return {
    schemaVersion: 1, targetDate, timezone,
    firstPreparedAt, firstPreparedMode: 'rescue',
    lastPreparedAt: firstPreparedAt, lastPreparedMode: 'rescue',
    updatedBy: 'device-a', intentionalBlank: false,
    routineInstanceIds: [], oneOffItemIds: ['one-1'],
    ...overrides
  };
}

function nowAt(dateKey) {
  // UTC noon safely falls within the same calendar date for every timezone used in these tests
  // (Phoenix UTC-7, Manila UTC+8, New York UTC-4/-5).
  return Date.parse(`${dateKey}T12:00:00Z`);
}

// Builds a run of N consecutive earned habit days ending the day before `today`,
// i.e. habit days [today-N .. today-1] each prepared their own next day ahead.
function chainOfDays(today, timezone, count) {
  const plansByDate = {};
  for (let i = 1; i <= count; i++) {
    const habitDate = addCalendarDays(today, -i);
    const target = addCalendarDays(habitDate, 1);
    plansByDate[target] = { items: [], preparation: aheadPrep(target, timezone) };
  }
  return plansByDate;
}

test('A: first qualifying preparation earns current 1', () => {
  const today = '2026-09-12';
  const tomorrow = addCalendarDays(today, 1);
  const plansByDate = { [tomorrow]: { items: [], preparation: aheadPrep(tomorrow, tz) } };
  const streak = planningStreak(plansByDate, nowAt(today), tz);
  assert.equal(streak.current, 1);
  assert.equal(streak.todayEarned, true);
});

test('B: N consecutive qualifying days produce current N', () => {
  const today = '2026-09-12';
  const plansByDate = chainOfDays(today, tz, 5); // habit days 09-07..09-11 prepared 09-08..09-12
  plansByDate[addCalendarDays(today, 1)] = { items: [], preparation: aheadPrep(addCalendarDays(today, 1), tz) };
  const streak = planningStreak(plansByDate, nowAt(today), tz);
  assert.equal(streak.current, 6);
});

test('C: a historical missing day breaks the streak at that point, not before', () => {
  const today = '2026-09-12';
  const plansByDate = chainOfDays(today, tz, 5);
  plansByDate[addCalendarDays(today, 1)] = { items: [], preparation: aheadPrep(addCalendarDays(today, 1), tz) };
  delete plansByDate['2026-09-11']; // remove the target for habit day 2026-09-10
  const streak = planningStreak(plansByDate, nowAt(today), tz);
  // Only 09-11 (habit day) -> target 09-12, and today -> target 09-13 survive as a trailing run.
  assert.equal(streak.current, 2);
});

test('D: Open Day (intentionalBlank) counts identically to a real plan', () => {
  const today = '2026-09-12';
  const tomorrow = addCalendarDays(today, 1);
  const plansByDate = { [tomorrow]: { items: [], preparation: aheadPrep(tomorrow, tz, { intentionalBlank: true, oneOffItemIds: [], routineInstanceIds: [] }) } };
  const streak = planningStreak(plansByDate, nowAt(today), tz);
  assert.equal(streak.current, 1);
  assert.equal(streak.todayEarned, true);
});

test('E: a late/rescue preparation does not retroactively earn credit', () => {
  const today = '2026-09-12';
  const tomorrow = addCalendarDays(today, 1);
  const plansByDate = { [tomorrow]: { items: [], preparation: latePrep(tomorrow, tz) } };
  const streak = planningStreak(plansByDate, nowAt(today), tz);
  assert.equal(streak.current, 0);
  assert.equal(streak.todayEarned, false);
});

test('F: rescuing today does not block credit for properly preparing tomorrow', () => {
  const today = '2026-09-12';
  const tomorrow = addCalendarDays(today, 1);
  const plansByDate = {
    [today]: { items: [], preparation: latePrep(today, tz) }, // today's own plan was a rescue
    [tomorrow]: { items: [], preparation: aheadPrep(tomorrow, tz) } // but tomorrow was prepared ahead
  };
  const streak = planningStreak(plansByDate, nowAt(today), tz);
  assert.equal(streak.todayEarned, true);
  assert.equal(streak.current, 1); // yesterday earns nothing for the rescued today, but today earns its own credit
});

test('G: editing priorities after confirmation does not alter credit', () => {
  const today = '2026-09-12';
  const tomorrow = addCalendarDays(today, 1);
  const preparation = aheadPrep(tomorrow, tz);
  const before = planningStreak({ [tomorrow]: { items: [{ id: 'one-1', task: 'Original', done: false }], preparation } }, nowAt(today), tz);
  const after = planningStreak({ [tomorrow]: { items: [{ id: 'one-1', task: 'Renamed', done: true }, { id: 'one-2', task: 'Added later', done: false }], preparation } }, nowAt(today), tz);
  assert.deepEqual(after, before);
});

test('H: deleting all items after confirmation does not alter credit', () => {
  const today = '2026-09-12';
  const tomorrow = addCalendarDays(today, 1);
  const preparation = aheadPrep(tomorrow, tz);
  const before = planningStreak({ [tomorrow]: { items: [{ id: 'one-1', task: 'Original', done: false }], preparation } }, nowAt(today), tz);
  const after = planningStreak({ [tomorrow]: { items: [{ id: 'one-1', task: 'Original', done: false, deleted: true }], preparation } }, nowAt(today), tz);
  assert.deepEqual(after, before);
  assert.equal(after.current, 1);
});

test('I: recurring templates alone (never confirmed) do not count', () => {
  const today = '2026-09-12';
  // No preparation object at all for tomorrow's key, even though a plan entry might exist for
  // unrelated reasons (e.g. routine metadata cached under the date) it carries no preparation.
  const streak = planningStreak({}, nowAt(today), tz);
  assert.equal(streak.current, 0);
  assert.equal(streak.todayEarned, false);
});

test('J: an abandoned draft (never confirmed) does not count', () => {
  const today = '2026-09-12';
  const tomorrow = addCalendarDays(today, 1);
  // No plans[tomorrow] entry at all -- draft was opened and closed without confirming.
  const streak = planningStreak({ [tomorrow]: undefined }, nowAt(today), tz);
  assert.equal(streak.current, 0);
});

test('K: repeated confirmations of the same date count once', () => {
  const today = '2026-09-12';
  const tomorrow = addCalendarDays(today, 1);
  const firstConfirm = buildPreparation(null, {
    targetDate: tomorrow, timezone: tz, now: Date.parse(`${today}T19:00:00Z`), mode: 'normal',
    updatedBy: 'device-a', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['one-1']
  });
  const reconfirm = buildPreparation(firstConfirm, {
    targetDate: tomorrow, timezone: tz, now: Date.parse(`${today}T21:00:00Z`), mode: 'normal',
    updatedBy: 'device-a', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['one-1', 'one-2']
  });
  const streak = planningStreak({ [tomorrow]: { items: [], preparation: reconfirm } }, nowAt(today), tz);
  assert.equal(streak.current, 1);
});

test('L: merge arrival order does not change the derived streak', () => {
  const today = '2026-09-12';
  const tomorrow = addCalendarDays(today, 1);
  const a = aheadPrep(tomorrow, tz, { updatedBy: 'device-a', firstPreparedAt: Date.parse(`${today}T18:00:00Z`), lastPreparedAt: Date.parse(`${today}T18:00:00Z`) });
  const b = aheadPrep(tomorrow, tz, { updatedBy: 'device-b', firstPreparedAt: Date.parse(`${today}T19:00:00Z`), lastPreparedAt: Date.parse(`${today}T19:00:00Z`) });
  const mergedAB = mergePreparations(a, b, tomorrow);
  const mergedBA = mergePreparations(b, a, tomorrow);
  const streakAB = planningStreak({ [tomorrow]: { items: [], preparation: mergedAB } }, nowAt(today), tz);
  const streakBA = planningStreak({ [tomorrow]: { items: [], preparation: mergedBA } }, nowAt(today), tz);
  assert.deepEqual(streakAB, streakBA);
  assert.equal(streakAB.current, 1);
});

test('M: corrupt or unknown preparation does not count', () => {
  const today = '2026-09-12';
  const tomorrow = addCalendarDays(today, 1);
  const streak = planningStreak({ [tomorrow]: { items: [], preparation: { schemaVersion: 1, targetDate: tomorrow, timezone: 'not-a-timezone' } } }, nowAt(today), tz);
  assert.equal(streak.current, 0);
});

test('21A: today not yet prepared does not reset an existing streak', () => {
  const today = '2026-09-12';
  const plansByDate = chainOfDays(today, tz, 5);
  const streak = planningStreak(plansByDate, nowAt(today), tz);
  assert.equal(streak.current, 5);
  assert.equal(streak.todayEarned, false);
});

test('21B: preparing tomorrow immediately increments the streak', () => {
  const today = '2026-09-12';
  const plansByDate = chainOfDays(today, tz, 5);
  plansByDate[addCalendarDays(today, 1)] = { items: [], preparation: aheadPrep(addCalendarDays(today, 1), tz) };
  const streak = planningStreak(plansByDate, nowAt(today), tz);
  assert.equal(streak.current, 6);
  assert.equal(streak.todayEarned, true);
});

test('21C: advancing a day with the prior day unprepared resets current to 0', () => {
  const today = '2026-09-12';
  const plansByDate = chainOfDays(today, tz, 5); // today (09-12) never prepares 09-13
  const nextDay = addCalendarDays(today, 1);
  const streak = planningStreak(plansByDate, nowAt(nextDay), tz);
  assert.equal(streak.current, 0);
});

test('22: timezone boundary just before vs just after local midnight (Asia/Manila)', () => {
  const manila = 'Asia/Manila';
  const targetDate = '2026-09-13';
  const justBefore = { schemaVersion: 1, targetDate, timezone: manila,
    firstPreparedAt: Date.parse('2026-09-12T15:59:00Z'), firstPreparedMode: 'normal', // 2026-09-12 23:59 in Manila (UTC+8)
    lastPreparedAt: Date.parse('2026-09-12T15:59:00Z'), lastPreparedMode: 'normal',
    updatedBy: 'device-a', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['one-1'] };
  const justAfter = { ...justBefore, firstPreparedAt: Date.parse('2026-09-12T16:01:00Z'), lastPreparedAt: Date.parse('2026-09-12T16:01:00Z') }; // 2026-09-13 00:01 in Manila
  const today = '2026-09-12';
  const beforeStreak = planningStreak({ [targetDate]: { items: [], preparation: justBefore } }, nowAt(today), manila);
  const afterStreak = planningStreak({ [targetDate]: { items: [], preparation: justAfter } }, nowAt(today), manila);
  assert.equal(beforeStreak.todayEarned, true);
  assert.equal(afterStreak.todayEarned, false);
});

test('22: America/Phoenix (no DST) consecutive run', () => {
  const today = '2026-09-12';
  const plansByDate = chainOfDays(today, 'America/Phoenix', 3);
  const streak = planningStreak(plansByDate, nowAt(today), 'America/Phoenix');
  assert.equal(streak.current, 3);
});

test('AG: DST transition (America/New_York) still produces a correct consecutive count', () => {
  const nyTz = 'America/New_York';
  const today = '2026-03-09'; // day after the US spring-forward transition (2026-03-08)
  const plansByDate = chainOfDays(today, nyTz, 3); // habit days 03-06,03-07,03-08 spanning the transition
  const streak = planningStreak(plansByDate, Date.parse(`${today}T18:00:00Z`), nyTz);
  assert.equal(streak.current, 3);
});

test('23: best streak is derived, survives current resetting to 0', () => {
  // Pattern across 14 finalized habit days, ending the day before "today": 3 earned, miss, 7 earned, miss, 2 earned.
  const today = '2026-02-01';
  const pattern = [true, true, true, false, true, true, true, true, true, true, true, false, true, true];
  const plansByDate = {};
  pattern.forEach((earned, index) => {
    const habitDate = addCalendarDays(today, -(pattern.length - index));
    if (!earned) return;
    const target = addCalendarDays(habitDate, 1);
    plansByDate[target] = { items: [], preparation: aheadPrep(target, tz) };
  });
  const streak = planningStreak(plansByDate, nowAt(today), tz);
  assert.equal(streak.current, 2);
  assert.equal(streak.best, 7);
});

test('23: best remains after current resets to 0', () => {
  const today = '2026-02-01';
  const pattern = [true, true, true, false, true, true, true, true, true, true, true, false, true, true];
  const plansByDate = {};
  pattern.forEach((earned, index) => {
    const habitDate = addCalendarDays(today, -(pattern.length - index));
    if (!earned) return;
    const target = addCalendarDays(habitDate, 1);
    plansByDate[target] = { items: [], preparation: aheadPrep(target, tz) };
  });
  const nextDay = addCalendarDays(today, 1); // advance a day; the trailing 2-day run also breaks
  const streak = planningStreak(plansByDate, nowAt(nextDay), tz);
  assert.equal(streak.current, 0);
  assert.equal(streak.best, 7);
});
