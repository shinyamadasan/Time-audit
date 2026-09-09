import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarDays, buildPreparation, classifyOneOffActual, classifyRoutineActual,
  computeReadyNow, localPlanDate, mergeDatePlans, mergePreparations,
  normalizePreparation, planningConsistency, planTomorrowTargetDate, summarizeActual
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
