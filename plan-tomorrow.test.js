import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarDays, buildPreparation, carriedItemId, classifyOneOffActual, classifyRoutineActual,
  clearPlanItemRange, computeReadyNow, durationBetween, formatPlanItemSchedule, formatPlanItemTime,
  localPlanDate, mergeDatePlans, mergePreparations, normalizePreparation, planItemEndTime,
  planItemScheduleLabel, planningConsistency, planTomorrowTargetDate, reconciliationBucket,
  summarizeActual, validPlanItemDuration, validPlanItemRange, validPlanItemTime
} from './plan-tomorrow-model.js';

const targetDate = '2026-09-09';
const timezone = 'America/Phoenix';
const preparedAt = Date.parse('2026-09-09T02:00:00Z'); // Sep 8, 19:00 in Phoenix
const prep = (overrides = {}) => ({
  schemaVersion: 1, targetDate, timezone, firstPreparedAt: preparedAt,
  firstPreparedMode: 'normal', lastPreparedAt: preparedAt,
  lastPreparedMode: 'normal', updatedBy: 'device-a', intentionalBlank: false,
  routineInstanceIds: ['["routine-1","2026-09-09"]'], oneOffItemIds: ['one-1'],
  ...overrides
});
const item = (overrides = {}) => ({ id: 'one-1', task: 'Write report', done: false, doneAt: null, updatedAt: preparedAt, ...overrides });

test('target date uses the next zoned calendar date without adding 24 hours', () => {
  assert.equal(planTomorrowTargetDate('2026-03-08T04:30:00Z', 'America/New_York'), '2026-03-08');
  assert.equal(planTomorrowTargetDate('2026-03-08T06:30:00Z', 'America/New_York'), '2026-03-09');
  assert.equal(addCalendarDays('2026-03-08', 1), '2026-03-09');
  assert.equal(localPlanDate('2026-11-01T05:30:00Z', 'America/New_York'), '2026-11-01');
  assert.equal(localPlanDate('2026-11-01T06:30:00Z', 'America/New_York'), '2026-11-01');
});

test('normal and rescue confirmation preserve factual first preparation', () => {
  const first = buildPreparation(null, { targetDate, timezone, now: preparedAt, mode: 'rescue', updatedBy: 'device-a', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['one-1'] });
  const last = buildPreparation(first, { targetDate, timezone: 'America/New_York', now: preparedAt + 60000, mode: 'normal', updatedBy: 'device-b', intentionalBlank: false, routineInstanceIds: ['routine'], oneOffItemIds: [] });
  assert.equal(last.firstPreparedAt, preparedAt);
  assert.equal(last.firstPreparedBy, 'device-a');
  assert.equal(last.firstPreparedMode, 'rescue');
  assert.equal(last.timezone, timezone);
  assert.equal(last.lastPreparedMode, 'normal');
  assert.equal(last.updatedBy, 'device-b');
  const skewed = buildPreparation(last, { targetDate, timezone: 'Asia/Tokyo', now: preparedAt - 60000, mode: 'rescue', updatedBy: 'device-c', intentionalBlank: true, routineInstanceIds: [], oneOffItemIds: [] });
  assert.equal(skewed.firstPreparedAt, preparedAt - 60000);
  assert.equal(skewed.firstPreparedBy, 'device-c');
  assert.equal(skewed.timezone, 'Asia/Tokyo');
  assert.equal(skewed.lastPreparedAt, preparedAt + 60000);
  assert.equal(skewed.lastPreparedMode, 'normal');
});

test('ahead, after-midnight late, legacy not-prepared, and corrupt unknown are distinct', () => {
  assert.equal(planningConsistency(prep(), targetDate), 'ahead');
  assert.equal(planningConsistency(prep({ firstPreparedAt: Date.parse('2026-09-09T08:00:00Z'), lastPreparedAt: Date.parse('2026-09-09T08:00:00Z') }), targetDate), 'late');
  assert.equal(planningConsistency(undefined, targetDate), 'not-prepared');
  assert.equal(planningConsistency({ schemaVersion: 1, targetDate, timezone: 'bad' }, targetDate), 'unknown');
});

test('corrupt preparation is ignored without touching legacy items', () => {
  const legacy = { items: [item()], updatedAt: 1 };
  const merged = mergeDatePlans(legacy, { items: [], preparation: { schemaVersion: 1, targetDate, timezone: 'bad' }, updatedAt: 2 }, targetDate);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.preparation, undefined);
  assert.equal(normalizePreparation({ ...prep(), firstPreparedAt: 'yesterday' }, targetDate), null);
});

test('two-device merge keeps earliest first state and latest last state', () => {
  const local = prep({ firstPreparedAt: 100, lastPreparedAt: 300, timezone: 'America/Phoenix', firstPreparedMode: 'rescue', lastPreparedMode: 'normal', updatedBy: 'device-a', routineInstanceIds: ['old'] });
  const remote = prep({ firstPreparedAt: 200, lastPreparedAt: 400, timezone: 'Asia/Tokyo', firstPreparedMode: 'normal', lastPreparedMode: 'rescue', updatedBy: 'device-b', routineInstanceIds: ['new'], intentionalBlank: true });
  const merged = mergePreparations(local, remote, targetDate);
  assert.equal(merged.firstPreparedAt, 100);
  assert.equal(merged.firstPreparedMode, 'rescue');
  assert.equal(merged.timezone, 'America/Phoenix');
  assert.equal(merged.lastPreparedAt, 400);
  assert.equal(merged.lastPreparedMode, 'rescue');
  assert.deepEqual(merged.routineInstanceIds, ['new']);
  assert.equal(merged.intentionalBlank, true);
});

test('equal latest timestamps resolve deterministically by writer identity', () => {
  const a = prep({ updatedBy: 'device-a', intentionalBlank: false, routineInstanceIds: ['a'] });
  const z = prep({ updatedBy: 'device-z', intentionalBlank: true, routineInstanceIds: ['z'] });
  assert.deepEqual(mergePreparations(a, z, targetDate), mergePreparations(z, a, targetDate));
  assert.equal(mergePreparations(a, z, targetDate).updatedBy, 'device-z');
  assert.equal(mergePreparations(a, z, targetDate).intentionalBlank, true);
});

test('per-item merge preserves concurrent over-cap data and tombstones', () => {
  const local = { items: [item({ id: '1' }), item({ id: '2' }), item({ id: '3' })], updatedAt: 10, updatedBy: 'a' };
  const remote = { items: [item({ id: '4' }), item({ id: '2', deleted: true, updatedAt: preparedAt + 1 })], updatedAt: 11, updatedBy: 'b' };
  const merged = mergeDatePlans(local, remote, targetDate);
  assert.equal(merged.items.length, 4);
  assert.equal(merged.items.find(value => value.id === '2').deleted, true);
});

test('equal item timestamps converge independent of merge direction', () => {
  const a = { items: [item({ task: 'A' })], updatedAt: 10, updatedBy: 'a' };
  const b = { items: [item({ task: 'B' })], updatedAt: 10, updatedBy: 'b' };
  assert.deepEqual(mergeDatePlans(a, b, targetDate), mergeDatePlans(b, a, targetDate));
  assert.equal(mergeDatePlans(a, b, targetDate).items[0].task, 'B');
});

test('readiness requires persisted valid metadata and live actionable content or intentional blank', () => {
  const plan = { items: [item()], preparation: prep() };
  const routine = { id: prep().routineInstanceIds[0], occurs: true, skipped: false, actionable: true };
  assert.equal(computeReadyNow({ plan, targetDate, routines: [routine] }), true);
  assert.equal(computeReadyNow({ plan, targetDate, routines: [routine], localSaveSucceeded: false }), false);
  assert.equal(computeReadyNow({ plan: { ...plan, items: [item({ done: true })] }, targetDate, routines: [{ ...routine, skipped: true }] }), false);
  assert.equal(computeReadyNow({ plan: { items: [], preparation: prep({ intentionalBlank: true, routineInstanceIds: [], oneOffItemIds: [] }) }, targetDate }), true);
});

test('morning routine edits are live: disabled, cadence-removed, skipped, and Learning-without-step are not actionable', () => {
  const plan = { items: [], preparation: prep({ oneOffItemIds: [] }) };
  const id = prep().routineInstanceIds[0];
  for (const routine of [{ id, occurs: false }, { id, occurs: true, skipped: true }, { id, occurs: true, actionable: false }]) {
    assert.equal(computeReadyNow({ plan, targetDate, routines: [routine] }), false);
  }
  assert.equal(computeReadyNow({ plan, targetDate, routines: [{ id, occurs: true, actionable: true }] }), true);
});

test('one-off actual statuses distinguish early/done/worked/not done/removed', () => {
  assert.equal(classifyOneOffActual(item({ done: true, doneAt: Date.parse('2026-09-08T18:00:00Z') }), { targetDate, timezone, preparedAt }), 'done-early');
  assert.equal(classifyOneOffActual(item({ done: true, doneAt: Date.parse('2026-09-09T18:00:00Z') }), { targetDate, timezone, preparedAt }), 'done');
  assert.equal(classifyOneOffActual(item(), { targetDate, timezone, trackedMinutes: 5, preparedAt }), 'worked-on');
  assert.equal(classifyOneOffActual(item(), { targetDate, timezone, preparedAt }), 'not-done');
  assert.equal(classifyOneOffActual(item({ deleted: true, updatedAt: preparedAt + 1 }), { targetDate, timezone, preparedAt }), 'removed');
});

test('routine actual statuses and denominator stay neutral', () => {
  const rows = [
    { status: classifyRoutineActual({ completion: { level: 'target' } }) },
    { status: classifyRoutineActual({ completion: { level: 'incomplete', duration: 4 } }) },
    { status: classifyRoutineActual({}) },
    { status: classifyRoutineActual({ occurs: false }) }
  ];
  assert.deepEqual(rows.map(row => row.status), ['target', 'worked-on', 'not-done', 'removed']);
  assert.deepEqual(summarizeActual(rows), { planned: 4, active: 3, completed: 2, removed: 1 });
});

test('reconciliation bucketing splits statuses into completed/unfinished/excluded', () => {
  assert.equal(reconciliationBucket('done'), 'completed');
  assert.equal(reconciliationBucket('done-early'), 'completed');
  assert.equal(reconciliationBucket('not-done'), 'unfinished');
  assert.equal(reconciliationBucket('worked-on'), 'unfinished');
  assert.equal(reconciliationBucket('removed'), 'excluded');
});

test('carriedItemId is deterministic, date-scoped, and cannot collide with a createPlanItem id', () => {
  assert.equal(carriedItemId('2026-09-08', 'one-1'), carriedItemId('2026-09-08', 'one-1'));
  assert.notEqual(carriedItemId('2026-09-08', 'one-1'), carriedItemId('2026-09-09', 'one-1'));
  assert.notEqual(carriedItemId('2026-09-08', 'one-1'), carriedItemId('2026-09-08', 'one-2'));
  // createPlanItem ids are 'p' + base36 timestamp + random chars — never contain ':'.
  assert.match(carriedItemId('2026-09-08', 'one-1'), /^carry:2026-09-08:one-1$/);
  assert.throws(() => carriedItemId('not-a-date', 'one-1'));
  assert.throws(() => carriedItemId('2026-09-08', ''));
});

test('app update accepts an already prepared plan unchanged', () => {
  const value = prep({ routineInstanceIds: ['b', 'a', 'a'], oneOffItemIds: [] });
  assert.deepEqual(normalizePreparation(value, targetDate).routineInstanceIds, ['a', 'b']);
});

function permutations(values) {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, atIndex) => atIndex !== index)).map(rest => [value, ...rest]));
}

function assertPairConverges(a, b) {
  assert.deepEqual(mergeDatePlans(a, b, targetDate), mergeDatePlans(b, a, targetDate));
}

function assertTripleConverges(states) {
  const results = permutations(states).flatMap(([a, b, c]) => [
    mergeDatePlans(mergeDatePlans(a, b, targetDate), c, targetDate),
    mergeDatePlans(a, mergeDatePlans(b, c, targetDate), targetDate)
  ]);
  results.slice(1).forEach(result => assert.deepEqual(result, results[0]));
  return results[0];
}

test('merge algebra: disjoint items converge in canonical ID order', () => {
  const a = { items: [item({ id: 'z', updatedBy: 'device-a' })], updatedAt: preparedAt, updatedBy: 'device-a' };
  const b = { items: [item({ id: 'a', updatedBy: 'device-b' })], updatedAt: preparedAt, updatedBy: 'device-b' };
  const c = { items: [item({ id: 'm', updatedBy: 'device-c' })], updatedAt: preparedAt, updatedBy: 'device-c' };
  assertPairConverges(a, b);
  assert.deepEqual(assertTripleConverges([a, b, c]).items.map(value => value.id), ['a', 'm', 'z']);
});

test('merge algebra: same-ID equal timestamps ignore mutable plan writer', () => {
  const a = { items: [item({ task: 'A', updatedBy: 'device-a' })], updatedAt: preparedAt, updatedBy: 'device-z' };
  const b = { items: [item({ task: 'B', updatedBy: 'device-b' })], updatedAt: preparedAt, updatedBy: 'device-a' };
  const c = { items: [item({ id: 'other', updatedBy: 'device-c' })], updatedAt: preparedAt, updatedBy: 'device-c' };
  assertPairConverges(a, b);
  const merged = assertTripleConverges([a, b, c]);
  assert.equal(merged.items.find(value => value.id === 'one-1').task, 'B');
  assert.equal(merged.items.find(value => value.id === 'one-1').updatedBy, 'device-b');
});

test('merge algebra: tombstone and live equal timestamps converge', () => {
  const live = { items: [item({ task: 'Edited', updatedBy: 'device-a' })], updatedAt: preparedAt, updatedBy: 'device-z' };
  const tombstone = { items: [item({ deleted: true, updatedBy: 'device-z' })], updatedAt: preparedAt, updatedBy: 'device-a' };
  const unrelated = { items: [item({ id: 'other', updatedBy: 'device-m' })], updatedAt: preparedAt, updatedBy: 'device-m' };
  assertPairConverges(live, tombstone);
  assert.equal(assertTripleConverges([live, tombstone, unrelated]).items.find(value => value.id === 'one-1').deleted, true);
});

test('merge algebra: four-plus active items survive every grouping', () => {
  const merged = assertTripleConverges([
    { items: [item({ id: '1', updatedBy: 'a' }), item({ id: '2', updatedBy: 'a' })], updatedAt: preparedAt, updatedBy: 'a' },
    { items: [item({ id: '3', updatedBy: 'b' })], updatedAt: preparedAt, updatedBy: 'b' },
    { items: [item({ id: '4', updatedBy: 'c' }), item({ id: '5', updatedBy: 'c' })], updatedAt: preparedAt, updatedBy: 'c' }
  ]);
  assert.deepEqual(merged.items.map(value => value.id), ['1', '2', '3', '4', '5']);
});

test('merge algebra: equal first timestamps keep immutable origin fields together', () => {
  const a = { items: [], preparation: prep({ firstPreparedBy: 'device-a', firstPreparedMode: 'normal', timezone: 'America/Phoenix' }), updatedAt: preparedAt, updatedBy: 'device-a' };
  const z = { items: [], preparation: prep({ firstPreparedBy: 'device-z', firstPreparedMode: 'rescue', timezone: 'Asia/Tokyo' }), updatedAt: preparedAt, updatedBy: 'device-z' };
  const later = { items: [], preparation: prep({ firstPreparedAt: preparedAt + 1, firstPreparedBy: 'device-m', lastPreparedAt: preparedAt + 2, updatedBy: 'device-m' }), updatedAt: preparedAt + 2, updatedBy: 'device-m' };
  assertPairConverges(a, z);
  const merged = assertTripleConverges([a, z, later]).preparation;
  assert.equal(merged.firstPreparedBy, 'device-z');
  assert.equal(merged.firstPreparedMode, 'rescue');
  assert.equal(merged.timezone, 'Asia/Tokyo');
});

test('merge algebra: equal latest timestamps use writer then canonical content', () => {
  const a = { items: [], preparation: prep({ firstPreparedBy: 'device-a', updatedBy: 'device-a', intentionalBlank: false }), updatedAt: preparedAt, updatedBy: 'device-a' };
  const z = { items: [], preparation: prep({ firstPreparedBy: 'device-a', updatedBy: 'device-z', intentionalBlank: true, lastPreparedMode: 'rescue' }), updatedAt: preparedAt, updatedBy: 'device-z' };
  const older = { items: [], preparation: prep({ firstPreparedBy: 'device-a', lastPreparedAt: preparedAt - 1, updatedBy: 'device-y' }), updatedAt: preparedAt - 1, updatedBy: 'device-y' };
  assertPairConverges(a, z);
  const merged = assertTripleConverges([a, z, older]).preparation;
  assert.equal(merged.updatedBy, 'device-z');
  assert.equal(merged.intentionalBlank, true);
  assert.equal(merged.lastPreparedMode, 'rescue');
});

test('merge algebra: same writer and timestamp with different content converges', () => {
  const a = { items: [item({ task: 'Alpha', updatedBy: 'device-a' })], preparation: prep({ firstPreparedBy: 'device-a', intentionalBlank: false }), updatedAt: preparedAt, updatedBy: 'device-a' };
  const b = { items: [item({ task: 'Zulu', updatedBy: 'device-a' })], preparation: prep({ firstPreparedBy: 'device-a', intentionalBlank: true, lastPreparedMode: 'rescue' }), updatedAt: preparedAt, updatedBy: 'device-a' };
  const c = { items: [item({ id: 'other', updatedBy: 'device-c' })], updatedAt: preparedAt, updatedBy: 'device-c' };
  assertPairConverges(a, b);
  const merged = assertTripleConverges([a, b, c]);
  assert.equal(merged.items.find(value => value.id === 'one-1').task, 'Zulu');
  assert.equal(merged.preparation.intentionalBlank, true);
});

test('merge algebra: legacy values without new provenance converge without migration', () => {
  const prepA = prep({ firstPreparedMode: 'normal', timezone: 'America/Phoenix' });
  const prepB = prep({ firstPreparedMode: 'rescue', timezone: 'Asia/Tokyo' });
  const aItem = item({ task: 'Legacy A' });
  const bItem = item({ task: 'Legacy B' });
  delete prepA.firstPreparedBy;
  delete prepB.firstPreparedBy;
  delete aItem.updatedBy;
  delete bItem.updatedBy;
  const a = { items: [aItem], preparation: prepA, updatedAt: preparedAt, updatedBy: 'device-a' };
  const b = { items: [bItem], preparation: prepB, updatedAt: preparedAt, updatedBy: 'device-b' };
  const c = { items: [item({ id: 'other' })], updatedAt: preparedAt, updatedBy: 'device-c' };
  assertPairConverges(a, b);
  const merged = assertTripleConverges([a, b, c]);
  assert.equal(merged.items.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(merged.preparation, 'firstPreparedBy'), false);
});

test('deterministic carry: two devices independently carrying the same source item converge to one active item', () => {
  const sourceItemId = 'today-1';
  const carryId = carriedItemId('2026-09-08', sourceItemId);
  const deviceA = { items: [item({ id: carryId, task: 'Write follow-up', when: '', carriedFromId: sourceItemId, updatedAt: preparedAt, updatedBy: 'device-a' })], updatedAt: preparedAt, updatedBy: 'device-a' };
  const deviceB = { items: [item({ id: carryId, task: 'Write follow-up', when: '', carriedFromId: sourceItemId, updatedAt: preparedAt + 5, updatedBy: 'device-b' })], updatedAt: preparedAt + 5, updatedBy: 'device-b' };
  assertPairConverges(deviceA, deviceB);
  const merged = mergeDatePlans(deviceA, deviceB, targetDate);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].id, carryId);
  assert.equal(merged.items[0].carriedFromId, sourceItemId);
  assert.equal(merged.items[0].deleted ?? false, false);
  assert.equal(merged.items[0].updatedBy, 'device-b');
});

test('deterministic carry: a newer re-carry supersedes an older tombstone regardless of merge orientation', () => {
  const sourceItemId = 'today-1';
  const carryId = carriedItemId('2026-09-08', sourceItemId);
  const tombstoned = { items: [item({ id: carryId, task: 'Write follow-up', deleted: true, carriedFromId: sourceItemId, updatedAt: preparedAt, updatedBy: 'device-a' })], updatedAt: preparedAt, updatedBy: 'device-a' };
  const recarried = { items: [item({ id: carryId, task: 'Write follow-up', deleted: false, carriedFromId: sourceItemId, updatedAt: preparedAt + 1000, updatedBy: 'device-b' })], updatedAt: preparedAt + 1000, updatedBy: 'device-b' };
  assertPairConverges(tombstoned, recarried);
  const merged = mergeDatePlans(tombstoned, recarried, targetDate);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].deleted ?? false, false);
});

test('deterministic carry: distinct source items on the same day never collide even with the same task title', () => {
  const idA = carriedItemId('2026-09-08', 'today-a');
  const idB = carriedItemId('2026-09-08', 'today-b');
  assert.notEqual(idA, idB);
  const a = { items: [item({ id: idA, task: 'Write follow-up', carriedFromId: 'today-a', updatedBy: 'device-a' })], updatedAt: preparedAt, updatedBy: 'device-a' };
  const b = { items: [item({ id: idB, task: 'Write follow-up', carriedFromId: 'today-b', updatedBy: 'device-a' })], updatedAt: preparedAt, updatedBy: 'device-a' };
  assertPairConverges(a, b);
  const merged = mergeDatePlans(a, b, targetDate);
  assert.equal(merged.items.length, 2);
});

test('deterministic carry: a manually created tomorrow item with the same title stays independent of a carried item', () => {
  const carryId = carriedItemId('2026-09-08', 'today-1');
  const manual = { items: [item({ id: 'manual-1', task: 'Write follow-up', carriedFromId: undefined, updatedBy: 'device-a' })], updatedAt: preparedAt, updatedBy: 'device-a' };
  const carried = { items: [item({ id: carryId, task: 'Write follow-up', carriedFromId: 'today-1', updatedBy: 'device-a' })], updatedAt: preparedAt, updatedBy: 'device-a' };
  const merged = mergeDatePlans(manual, carried, targetDate);
  assert.equal(merged.items.length, 2);
  assert.equal(merged.items.find(value => value.id === 'manual-1').carriedFromId, undefined);
});

test('validPlanItemTime only accepts zero-padded 24h HH:MM, never free text or partial values', () => {
  assert.equal(validPlanItemTime('09:00'), true);
  assert.equal(validPlanItemTime('23:59'), true);
  assert.equal(validPlanItemTime('00:00'), true);
  assert.equal(validPlanItemTime(''), false);
  assert.equal(validPlanItemTime('after lunch'), false);
  assert.equal(validPlanItemTime('9:00'), false);
  assert.equal(validPlanItemTime('24:00'), false);
  assert.equal(validPlanItemTime('12:60'), false);
  assert.equal(validPlanItemTime(null), false);
  assert.equal(validPlanItemTime(undefined), false);
});

test('formatPlanItemTime renders canonical 24h storage as 12h display without mutating storage', () => {
  assert.equal(formatPlanItemTime('09:00'), '9:00 AM');
  assert.equal(formatPlanItemTime('00:00'), '12:00 AM');
  assert.equal(formatPlanItemTime('12:00'), '12:00 PM');
  assert.equal(formatPlanItemTime('13:30'), '1:30 PM');
  assert.equal(formatPlanItemTime('23:05'), '11:05 PM');
  assert.equal(formatPlanItemTime('after lunch'), null);
  assert.equal(formatPlanItemTime(''), null);
});

test('validPlanItemDuration only accepts a positive integer minute count within a reasonable block size', () => {
  assert.equal(validPlanItemDuration(90), true);
  assert.equal(validPlanItemDuration(1), true);
  assert.equal(validPlanItemDuration(720), true);
  assert.equal(validPlanItemDuration(0), false); // zero-length duration is meaningless — same as "end equal to start"
  assert.equal(validPlanItemDuration(-30), false); // negative — same as "end before start" in a start+duration model
  assert.equal(validPlanItemDuration(721), false); // past the reasonable single-block maximum
  assert.equal(validPlanItemDuration(100000), false); // absurd maximum (e.g. a stray timestamp)
  assert.equal(validPlanItemDuration(90.5), false); // non-integer
  assert.equal(validPlanItemDuration('90'), false); // malformed type
  assert.equal(validPlanItemDuration(null), false);
  assert.equal(validPlanItemDuration(undefined), false); // missing — a start-only item, not an error
  assert.equal(validPlanItemDuration(NaN), false);
});

test('planItemEndTime derives the end clock time from start + duration, and rejects cross-midnight in V1', () => {
  assert.equal(planItemEndTime('09:00', 90), '10:30');
  assert.equal(planItemEndTime('23:30', 29), '23:59');
  assert.equal(planItemEndTime('23:30', 30), null); // would land exactly on next-day midnight
  assert.equal(planItemEndTime('23:00', 120), null); // 11 PM + 2h would cross into the next day
  assert.equal(planItemEndTime('09:00', 0), null); // invalid duration
  assert.equal(planItemEndTime('09:00', undefined), null); // start-only — no range, not an error
  assert.equal(planItemEndTime('after lunch', 90), null); // malformed/legacy when
  assert.equal(planItemEndTime('', 90), null);
});

test('validPlanItemRange is the single write-time authority every scheduling mutation composes — FIX FIRST regression coverage', () => {
  // Blocker 3 boundary: exactly 720 accepted, 721 rejected.
  assert.equal(validPlanItemRange('06:00', 720), true);
  assert.equal(validPlanItemRange('06:00', 721), false);
  assert.equal(validPlanItemRange('06:00', 780), false); // 06:00 -> 19:00, the exact reported defect
  // Blocker 1: a structurally valid quick-duration value (30-120) still fails once it crosses midnight.
  assert.equal(validPlanItemRange('23:00', 120), false);
  assert.equal(validPlanItemRange('23:00', 30), true);
  assert.equal(validPlanItemRange('23:30', 30), false); // lands exactly on next-day midnight
  // Malformed/missing halves never validate.
  assert.equal(validPlanItemRange('09:00', 0), false);
  assert.equal(validPlanItemRange('09:00', -5), false);
  assert.equal(validPlanItemRange('09:00', undefined), false);
  assert.equal(validPlanItemRange('after lunch', 90), false);
});

test('durationBetween derives a length from an exact custom start+end pair, never fabricating next-day semantics', () => {
  assert.equal(durationBetween('09:00', '10:30'), 90);
  assert.equal(durationBetween('09:00', '09:00'), null); // end equal to start
  assert.equal(durationBetween('10:30', '09:00'), null); // end before start
  assert.equal(durationBetween('23:00', '01:00'), null); // would only work as a next-day wrap — rejected, not inferred
  assert.equal(durationBetween('after lunch', '10:00'), null);
  assert.equal(durationBetween('09:00', 'nonsense'), null);
});

test('formatPlanItemSchedule covers untimed, start-only, ranged, and every formatting edge case', () => {
  assert.equal(formatPlanItemSchedule({ when: '' }), null); // untimed
  assert.equal(formatPlanItemSchedule({}), null);
  assert.equal(formatPlanItemSchedule({ when: '09:00' }), '9:00 AM'); // start only
  assert.equal(formatPlanItemSchedule({ when: '09:00', durationMinutes: 90 }), '9:00–10:30 AM'); // morning range, compact
  assert.equal(formatPlanItemSchedule({ when: '12:00' }), '12:00 PM'); // noon
  assert.equal(formatPlanItemSchedule({ when: '00:00' }), '12:00 AM'); // midnight
  assert.equal(formatPlanItemSchedule({ when: '14:00', durationMinutes: 30 }), '2:00–2:30 PM'); // afternoon range
  assert.equal(formatPlanItemSchedule({ when: '11:30', durationMinutes: 90 }), '11:30 AM–1:00 PM'); // AM->PM keeps both periods
  assert.equal(formatPlanItemSchedule({ when: '23:00', durationMinutes: 120 }), '11:00 PM'); // cross-midnight falls back to start-only
  assert.equal(formatPlanItemSchedule({ when: 'after lunch', durationMinutes: 90 }), null); // legacy free-text when
  assert.equal(formatPlanItemSchedule({ when: '09:00', durationMinutes: -5 }), '9:00 AM'); // malformed duration falls back safely
  assert.equal(formatPlanItemSchedule({ when: '09:00', durationMinutes: '90' }), '9:00 AM'); // malformed type falls back safely
  assert.doesNotThrow(() => formatPlanItemSchedule(null));
  assert.doesNotThrow(() => formatPlanItemSchedule(undefined));
});

test('planItemScheduleLabel falls back to verbatim legacy free text, and is null only when there is truly nothing', () => {
  assert.equal(planItemScheduleLabel({ when: '09:00', durationMinutes: 90 }), '9:00–10:30 AM');
  assert.equal(planItemScheduleLabel({ when: 'after lunch' }), 'after lunch');
  assert.equal(planItemScheduleLabel({ when: '' }), null);
  assert.equal(planItemScheduleLabel({}), null);
});

test('clearPlanItemRange drops duration and explicit-end metadata, leaving when and unrelated fields untouched', () => {
  const item = { id: 'p1', task: 'Write report', when: '09:00', durationMinutes: 90, endClock: '10:30', done: false };
  const cleared = clearPlanItemRange(item);
  assert.deepEqual(cleared, { id: 'p1', task: 'Write report', when: '09:00', done: false });
  assert.equal('durationMinutes' in cleared, false);
  assert.equal('endClock' in cleared, false);
  assert.equal(item.durationMinutes, 90); // original object is untouched
});

test('a relocation tombstone defeats a later-timestamp ordinary stale edit in either legacy merge order', () => {
  const relocationRevision = { schemaVersion: 1, sequence: 1, fromDayId: targetDate, toDayId: '2026-09-20', updatedBy: 'device-a', updatedAt: 100 };
  const moved = { items: [item({ deleted: true, movedToDayId: '2026-09-20', relocationRevision, updatedAt: 100, updatedBy: 'device-a' })], updatedAt: 100, updatedBy: 'device-a' };
  const stale = { items: [item({ task: 'offline stale edit', updatedAt: 999, updatedBy: 'device-z' })], updatedAt: 999, updatedBy: 'device-z' };
  const forward = mergeDatePlans(moved, stale, targetDate);
  const reverse = mergeDatePlans(stale, moved, targetDate);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.items[0].deleted, true);
  assert.deepEqual(forward.items[0].relocationRevision, relocationRevision);
});

test('equal-sequence contradictory legacy relocations resolve by deterministic authority, not time or arrival order', () => {
  const moveA = { items: [item({ deleted: true, relocationRevision: { schemaVersion: 1, sequence: 2, fromDayId: targetDate, toDayId: '2026-09-20', updatedBy: 'device-a', updatedAt: 900 }, updatedAt: 900, updatedBy: 'device-a' })] };
  const moveZ = { items: [item({ deleted: true, relocationRevision: { schemaVersion: 1, sequence: 2, fromDayId: targetDate, toDayId: '2026-09-21', updatedBy: 'device-z', updatedAt: 100 }, updatedAt: 100, updatedBy: 'device-z' })] };
  const forward = mergeDatePlans(moveA, moveZ, targetDate);
  const reverse = mergeDatePlans(moveZ, moveA, targetDate);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.items[0].relocationRevision.toDayId, '2026-09-21');
});

// Plan Time Range V1 adds durationMinutes as an ordinary field on the same whole-item object that
// chooseItem()/mergeDatePlans() already merge as a unit — no second merge engine, no field-level
// merging. These races are exactly the ones named in the Time Range spec, run through the exact
// same convergence helpers the pre-existing merge algebra tests above already use.
test('merge race 1: device A changes start, device B changes range — later updatedAt wins the whole item, deterministically', () => {
  const a = { items: [item({ when: '09:00', updatedAt: preparedAt + 5, updatedBy: 'device-a' })], updatedAt: preparedAt + 5, updatedBy: 'device-a' };
  const b = { items: [item({ when: '', durationMinutes: 90, updatedAt: preparedAt + 10, updatedBy: 'device-b' })], updatedAt: preparedAt + 10, updatedBy: 'device-b' };
  assertPairConverges(a, b);
  const merged = mergeDatePlans(a, b, targetDate).items[0];
  assert.equal(merged.updatedBy, 'device-b'); // later write wins entirely, including B's own `when`
  assert.equal(merged.durationMinutes, 90);
  assert.equal(merged.when, '');
});

test('merge race 2: device A removes range, device B renames the item — same whole-item LWW, no special case for either field', () => {
  const a = { items: [item({ task: 'Write report', when: '09:00', durationMinutes: 90, updatedAt: preparedAt + 5, updatedBy: 'device-a' })], updatedAt: preparedAt + 5, updatedBy: 'device-a' };
  const b = { items: [item({ task: 'Write final report', when: '09:00', updatedAt: preparedAt + 10, updatedBy: 'device-b' })], updatedAt: preparedAt + 10, updatedBy: 'device-b' };
  assertPairConverges(a, b);
  const merged = mergeDatePlans(a, b, targetDate).items[0];
  assert.equal(merged.task, 'Write final report');
  assert.equal('durationMinutes' in merged, false); // B's write (the later one) never had a range
});

test('merge race 3: device A removes all timing, device B edits range from a stale copy — later write still wins as a whole, no fabricated hybrid', () => {
  const a = { items: [item({ when: '', updatedAt: preparedAt + 10, updatedBy: 'device-a' })], updatedAt: preparedAt + 10, updatedBy: 'device-a' };
  const b = { items: [item({ when: '09:00', durationMinutes: 60, updatedAt: preparedAt + 5, updatedBy: 'device-b' })], updatedAt: preparedAt + 5, updatedBy: 'device-b' };
  assertPairConverges(a, b);
  const merged = mergeDatePlans(a, b, targetDate).items[0];
  assert.equal(merged.updatedBy, 'device-a'); // A is later — its cleared state wins outright
  assert.equal(merged.when, '');
  assert.equal('durationMinutes' in merged, false);
});

test('merge race 4: equal-timestamp tie break stays deterministic and order-independent with a range field present', () => {
  const a = { items: [item({ when: '09:00', durationMinutes: 90, updatedBy: 'device-a' })], updatedAt: preparedAt, updatedBy: 'device-a' };
  const b = { items: [item({ when: '10:00', durationMinutes: 30, updatedBy: 'device-b' })], updatedAt: preparedAt, updatedBy: 'device-b' };
  assertPairConverges(a, b);
  const forward = mergeDatePlans(a, b, targetDate).items[0];
  const reverse = mergeDatePlans(b, a, targetDate).items[0];
  assert.deepEqual(forward, reverse); // reverse merge orientation picks the identical winner
});

test('a carried-forward item never inherits source-item range metadata — carry-forward only ever sets task/id/provenance', () => {
  const sourceDate = '2026-09-09';
  const carryId = carriedItemId(sourceDate, 'today-1');
  // Mirrors exactly what plan-tomorrow-ui.js's toggleCarry() builds: a fresh object listing only
  // id/task/when/done/doneAt/carriedFromId — never a spread of the source item — so stale
  // duration/end metadata has no path onto the carried tomorrow item in the first place.
  const carried = { id: carryId, task: 'Write follow-up', when: '', done: false, doneAt: null, carriedFromId: 'today-1' };
  assert.equal('durationMinutes' in carried, false);
  assert.equal(formatPlanItemSchedule(carried), null);
});
