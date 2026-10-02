// daily-view-window.test.js
//
// Configurable 24–48 Hour Daily View V1. PlanAuthority over the REAL calendar-native store
// (repository + sync bridge + live wiring); only Firebase (in-memory) and the clock are fake.
//
// The owner's acceptance case: Asia/Manila, Saturday 2026-10-03 selected.
//   Saturday's plan: "Ticktick list" 22:00 for 600 min  -> derived end Sunday 08:00
//   Sunday's plan:   "★ sad"        01:43 for 121 min  -> derived end Sunday 03:44
// A 36h Saturday view is [Sat 00:00, Sun 12:00): both are visible, each still owned by its
// own plan; Sunday's view shows "★ sad" and Saturday's Ticktick carrying in until 08:00.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanAuthority } from './plan-authority.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { createCalendarPlanRepository } from './calendar-plan-repository.js';
import { createCalendarPlanSyncBridge } from './calendar-plan-sync.js';
import { createCalendarPlanLiveWiring } from './calendar-plan-live.js';
import { fakeDatabase, memoryStorage } from './calendar-plan-test-support.js';
import { buildCommitment } from './commitments-model.js';
import {
  DAILY_VIEW_DEFAULT_HOURS,
  normalizeDailyViewHours,
  dailyViewWindow,
  intersectsDailyViewWindow,
  deriveDailyViewPlannedRows,
} from './daily-view-window.js';

const MANILA = 'Asia/Manila';
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const FRI = '2026-10-02';
const SAT = '2026-10-03';
const SUN = '2026-10-04';
const MON = '2026-10-05';
const SAT_ID = `cal1:${SAT}`;
const SUN_ID = `cal1:${SUN}`;

let seq = 0;
function makeApp({ nowMs = at(SAT, '09:00'), owner = { room: 'uid_A' }, activate = true } = {}) {
  const clock = { now: nowMs };
  const db = fakeDatabase();
  const room = () => owner.room;
  const legacyPlans = {};
  const legacy = {
    record: k => legacyPlans[k] || null,
    rawItems: k => (legacyPlans[k]?.items || []).map(i => ({ ...i })),
    saveItems(k, items) { legacyPlans[k] = { ...(legacyPlans[k] || {}), items }; },
    confirm: () => ({ localSaved: true, syncPromise: Promise.resolve(false) }),
    allPlans: () => legacyPlans,
    earliestPlanDate: () => null,
  };
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage: memoryStorage(), idGenerator: () => `rev-${++seq}`, getOwner: room });
  const planRepository = createOperationalPlanRepository({ storage: memoryStorage(), getOwner: room });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => clock.now, deviceId: () => 'phone', fallbackTimezone: () => MANILA,
  });
  const calendarStorage = memoryStorage();
  const calendarRepository = createCalendarPlanRepository({ storage: calendarStorage, getOwner: room, getTimezone: () => MANILA, idGenerator: () => `ca1-phone-${++seq}` });
  const calendarSync = createCalendarPlanSyncBridge({ repository: calendarRepository, getRoomRef: () => (owner.room ? db.ref(`rooms/${owner.room}`) : null), getRoomId: room });
  const calendar = createCalendarPlanLiveWiring({ repository: calendarRepository, sync: calendarSync, now: () => clock.now, deviceId: () => 'phone', timezone: () => MANILA });
  calendar.attachLive();
  const authority = createPlanAuthority({ live, legacy, calendar, now: () => clock.now, accountTimezone: () => MANILA });
  if (activate) authority.activateCalendar();
  const persisted = () => JSON.stringify({ local: [...calendarStorage.data.entries()].sort(), remote: db.tree });
  return { authority, calendarRepository, db, owner, clock, persisted };
}

const item = (id, task, when, durationMinutes, extra = {}) => ({
  id, task, when, ...(durationMinutes ? { durationMinutes } : {}), whenTz: MANILA, done: false, updatedAt: 1000, updatedBy: 'phone', ...extra,
});
const TICKTICK = item('ticktick', 'Ticktick list', '22:00', 600, { kind: 'task' });
const SAD = item('sad', 'sad', '01:43', 121);

/** The owner's real data: one record per plan, written through PlanAuthority. */
function acceptanceApp(options) {
  const app = makeApp(options);
  app.authority.saveItems(app.authority.calendarTarget(SAT), [TICKTICK]);
  app.authority.saveItems(app.authority.calendarTarget(SUN), [SAD]);
  return app;
}

const view = (app, dateKey, hours, extra = {}) => deriveDailyViewPlannedRows({ dateKey, hours, authority: app.authority, ...extra });
const ids = result => result.positioned.map(row => row.id);
const rowOf = (result, itemId) => result.positioned.find(row => row.itemId === itemId);

// ═══════════════════════════════════════════════════════════════════════
// 1. the preference
// ═══════════════════════════════════════════════════════════════════════

test('Daily View Length: every whole hour 24–48 is kept; missing, malformed or out-of-range is the 36h default', () => {
  assert.equal(DAILY_VIEW_DEFAULT_HOURS, 36);
  for (let h = 24; h <= 48; h++) {
    assert.equal(normalizeDailyViewHours(h), h);
    assert.equal(normalizeDailyViewHours(String(h)), h, 'the stored string form reads back');
  }
  assert.equal(normalizeDailyViewHours(' 42 '), 42);
  for (const bad of [undefined, null, '', 'abc', '36h', 23, 49, 0, -36, 36.5, '36.5', NaN, Infinity, '1e2', {}, [], true, '0036x', 100, '999']) {
    assert.equal(normalizeDailyViewHours(bad), 36, `${JSON.stringify(bad)} must read as 36`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 2. the window: selected date 00:00 + N civil hours, half-open
// ═══════════════════════════════════════════════════════════════════════

test('window: Saturday 00:00 → the exact configured civil hour (24/25/30/36/37/42/47/48)', () => {
  const cases = [[24, SUN, '00:00'], [25, SUN, '01:00'], [30, SUN, '06:00'], [36, SUN, '12:00'], [37, SUN, '13:00'], [42, SUN, '18:00'], [47, SUN, '23:00'], [48, MON, '00:00']];
  for (const [hours, endDate, endClock] of cases) {
    const win = dailyViewWindow(SAT, hours, MANILA);
    assert.equal(win.startMs, at(SAT, '00:00'), `${hours}h starts at Saturday 00:00`);
    assert.equal(win.endMs, at(endDate, endClock), `${hours}h ends ${endDate} ${endClock}`);
    assert.equal(win.hours, hours);
  }
  assert.equal(dailyViewWindow(SAT, 'garbage', MANILA).endMs, at(SUN, '12:00'), 'a malformed length is the 36h default');
});

test('window: factual date segments and the bounded set of source plans', () => {
  const w24 = dailyViewWindow(SAT, 24, MANILA);
  assert.deepEqual(w24.factualDateSegments, [{ dateKey: SAT, startMs: at(SAT, '00:00'), endMs: at(SUN, '00:00') }]);
  assert.deepEqual(w24.sourceDateKeys, [FRI, SAT], '24h: Friday may carry in; no Sunday-owned item can start before Sunday 00:00');
  const w36 = dailyViewWindow(SAT, 36, MANILA);
  assert.deepEqual(w36.factualDateSegments, [
    { dateKey: SAT, startMs: at(SAT, '00:00'), endMs: at(SUN, '00:00') },
    { dateKey: SUN, startMs: at(SUN, '00:00'), endMs: at(SUN, '12:00') },
  ]);
  assert.deepEqual(w36.sourceDateKeys, [FRI, SAT, SUN]);
  assert.deepEqual(dailyViewWindow(SAT, 48, MANILA).sourceDateKeys, [FRI, SAT, SUN], 'even at 48h, never Monday or later: a plan reaches at most its next date');
});

test('window: civil hours in the plan\'s own zone across DST (fall back, and a skipped reading)', () => {
  const LA = 'America/Los_Angeles';
  // 2026-11-01: 01:00–02:00 repeats. 36h from Nov 1 00:00 PDT is Nov 2 12:00 PST — 37 real hours.
  const fallBack = dailyViewWindow('2026-11-01', 36, LA);
  assert.equal(fallBack.startMs, Date.parse('2026-11-01T00:00:00-07:00'));
  assert.equal(fallBack.endMs, Date.parse('2026-11-02T12:00:00-08:00'));
  // 2027-03-14 02:00 does not exist in Los Angeles: a 26h window from Mar 13 ends at the first real instant after the gap.
  const skipped = dailyViewWindow('2027-03-13', 26, LA);
  assert.equal(skipped.endMs, Date.parse('2027-03-14T03:00:00-07:00'));
});

test('intersection is half-open: an item starting exactly at windowEnd is out; one ending exactly at windowStart is out', () => {
  const win = dailyViewWindow(SAT, 36, MANILA);
  assert.equal(intersectsDailyViewWindow(win, at(SUN, '12:00'), at(SUN, '13:00')), false, 'ranged start at windowEnd');
  assert.equal(intersectsDailyViewWindow(win, at(SUN, '12:00'), null), false, 'point at windowEnd');
  assert.equal(intersectsDailyViewWindow(win, at(SUN, '11:59'), null), true);
  assert.equal(intersectsDailyViewWindow(win, at(FRI, '22:00'), at(SAT, '00:00')), false, 'ends exactly at windowStart');
  assert.equal(intersectsDailyViewWindow(win, at(FRI, '22:00'), at(SAT, '00:01')), true, 'carries in by one minute');
  assert.equal(intersectsDailyViewWindow(win, at(FRI, '23:00'), null), false, 'a point before the window is not shown');
  assert.equal(intersectsDailyViewWindow(win, NaN, null), false);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. the owner's acceptance case
// ═══════════════════════════════════════════════════════════════════════

test('ACCEPTANCE — Saturday 36h: Sat 00:00 → Sun 12:00 shows Ticktick (Saturday-owned) and ★ sad at Sun 01:43–03:44 (Sunday-owned)', () => {
  const app = acceptanceApp();
  const sat = view(app, SAT, 36);
  assert.equal(sat.window.startMs, at(SAT, '00:00'));
  assert.equal(sat.window.endMs, at(SUN, '12:00'));
  assert.deepEqual(sat.window.factualDateSegments.map(s => s.dateKey), [SAT, SUN], 'the Sunday boundary is inside the window');

  const ticktick = rowOf(sat, 'ticktick');
  assert.equal(ticktick.dayId, SAT_ID);
  assert.equal(ticktick.startMs, at(SAT, '22:00'));
  assert.equal(ticktick.endMs, at(SUN, '08:00'), 'derived end from start + duration');
  assert.equal(ticktick.ownedBySelected, true);
  assert.equal(ticktick.carryIn, false);

  const sad = rowOf(sat, 'sad');
  assert.equal(sad.dayId, SUN_ID, '★ sad keeps its Sunday factual identity');
  assert.equal(sad.ownerDateKey, SUN);
  assert.equal(sad.ownedBySelected, false);
  assert.equal(sad.planKind, 'priority');
  assert.equal(sad.startMs, at(SUN, '01:43'));
  assert.equal(sad.endMs, at(SUN, '03:44'));
  assert.equal(sad.durationMinutes, 121);
  assert.deepEqual(ids(sat), [`plan:${SAT_ID}:ticktick`, `plan:${SUN_ID}:sad`], 'ordered by real start');

  // No duplicate record: each plan holds its one item, and nothing was copied into the other.
  assert.deepEqual(app.calendarRepository.read(SAT).items.map(i => i.id), ['ticktick']);
  assert.deepEqual(app.calendarRepository.read(SUN).items.map(i => i.id), ['sad']);
});

test('ACCEPTANCE — Sunday 36h: ★ sad as Sunday\'s own, and Saturday\'s Ticktick carrying in until 08:00 — the same stable ids', () => {
  const app = acceptanceApp();
  const sat = view(app, SAT, 36);
  const sun = view(app, SUN, 36);
  assert.equal(sun.window.startMs, at(SUN, '00:00'));
  assert.equal(sun.window.endMs, at(MON, '12:00'));

  const sad = rowOf(sun, 'sad');
  assert.equal(sad.ownedBySelected, true);
  assert.equal(sad.carryIn, false);

  const ticktick = rowOf(sun, 'ticktick');
  assert.equal(ticktick.dayId, SAT_ID, 'still Saturday-owned');
  assert.equal(ticktick.ownerDateKey, SAT);
  assert.equal(ticktick.carryIn, true);
  assert.equal(ticktick.displayStartMs, at(SUN, '00:00'), 'placed at the window start');
  assert.equal(ticktick.startMs, at(SAT, '22:00'), 'its real start is untouched');
  assert.equal(ticktick.endMs, at(SUN, '08:00'));
  assert.deepEqual(ids(sun), [`plan:${SAT_ID}:ticktick`, `plan:${SUN_ID}:sad`]);

  assert.deepEqual(new Set(ids(sun)), new Set(ids(sat)), 'both views refer to the same two records');
});

test('viewing never writes: deriving any view leaves local and remote persistence byte-identical', () => {
  const app = acceptanceApp();
  const before = app.persisted();
  for (let h = 24; h <= 48; h++) { view(app, SAT, h); view(app, SUN, h); view(app, MON, h); }
  assert.equal(app.persisted(), before);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. customization
// ═══════════════════════════════════════════════════════════════════════

test('24h: Sunday 01:43 is excluded from Saturday; Saturday\'s own crossing item still shows; and it carries into Sunday\'s 24h view', () => {
  const app = acceptanceApp();
  const sat = view(app, SAT, 24);
  assert.deepEqual(ids(sat), [`plan:${SAT_ID}:ticktick`]);
  const sun = view(app, SUN, 24);
  assert.deepEqual(ids(sun), [`plan:${SAT_ID}:ticktick`, `plan:${SUN_ID}:sad`]);
  assert.equal(rowOf(sun, 'ticktick').carryIn, true);
});

/** Sunday's plan with a point item at each boundary minute. */
function boundaryApp() {
  const app = makeApp();
  app.authority.saveItems(app.authority.calendarTarget(SUN), [
    item('s0559', 'Before 6', '05:59'), item('s0600', 'At 6', '06:00'),
    item('s1159', 'Before noon', '11:59'), item('s1200', 'At noon', '12:00'),
    item('s1759', 'Before 18', '17:59'), item('s1800', 'At 18', '18:00'),
    item('s2359', 'Last minute', '23:59'),
    item('mon0000', 'Monday midnight', '00:00', undefined, { whenDayOffset: 1 }),
  ]);
  return app;
}
const sundayItemsIn = (app, hours) => view(app, SAT, hours).positioned.map(row => row.itemId).sort();

test('30h / 36h / 42h / 48h: Sunday content up to the configured hour, never at or after it; Monday 00:00 excluded at 48h', () => {
  const app = boundaryApp();
  assert.deepEqual(sundayItemsIn(app, 30), ['s0559']);
  assert.deepEqual(sundayItemsIn(app, 36), ['s0559', 's0600', 's1159']);
  assert.deepEqual(sundayItemsIn(app, 42), ['s0559', 's0600', 's1159', 's1200', 's1759']);
  assert.deepEqual(sundayItemsIn(app, 48), ['s0559', 's0600', 's1159', 's1200', 's1759', 's1800', 's2359']);
  assert.ok(!sundayItemsIn(app, 48).includes('mon0000'), 'Monday 00:00 (even Sunday-owned) is the 48h windowEnd');
});

test('custom 25h / 37h / 47h follow the exact hour', () => {
  const app = makeApp();
  app.authority.saveItems(app.authority.calendarTarget(SUN), [
    item('a0059', 'a', '00:59'), item('a0100', 'b', '01:00'),
    item('a1259', 'c', '12:59'), item('a1300', 'd', '13:00'),
    item('a2259', 'e', '22:59'), item('a2300', 'f', '23:00'),
  ]);
  assert.deepEqual(sundayItemsIn(app, 25), ['a0059']);
  assert.deepEqual(sundayItemsIn(app, 37), ['a0059', 'a0100', 'a1259']);
  assert.deepEqual(sundayItemsIn(app, 47), ['a0059', 'a0100', 'a1259', 'a1300', 'a2259']);
});

test('a malformed preference renders exactly the 36h view', () => {
  const app = acceptanceApp();
  assert.deepEqual(view(app, SAT, '1000').positioned, view(app, SAT, 36).positioned);
  assert.equal(view(app, SAT, undefined).window.hours, 36);
});

// ═══════════════════════════════════════════════════════════════════════
// 5. action routing: the view date never substitutes for ownership
// ═══════════════════════════════════════════════════════════════════════

const stamp = app => value => ({ ...value, updatedAt: app.clock.now, updatedBy: 'test' });

test('editing ★ sad from Saturday\'s view writes SUNDAY\'s record (and only it); the same row in Sunday\'s view shows the change', () => {
  const app = acceptanceApp();
  const row = rowOf(view(app, SAT, 36), 'sad');
  const owner = app.authority.targetById(row.dayId);
  assert.equal(owner.id, SUN_ID);
  const saturdayBefore = JSON.stringify(app.calendarRepository.read(SAT).items);

  app.authority.updateItem({ sourceTarget: owner, itemId: row.itemId, changes: { done: true, doneAt: app.clock.now }, stamp: stamp(app) });
  app.authority.updateItem({ sourceTarget: owner, itemId: row.itemId, changes: { when: '02:00', durationMinutes: 60 }, stamp: stamp(app) });

  const sunday = app.calendarRepository.read(SUN).items;
  assert.deepEqual(sunday.map(i => [i.id, i.done, i.when, i.durationMinutes]), [['sad', true, '02:00', 60]]);
  assert.equal(JSON.stringify(app.calendarRepository.read(SAT).items), saturdayBefore, 'Saturday untouched');
  const again = rowOf(view(app, SUN, 36), 'sad');
  assert.deepEqual([again.id, again.done, again.startMs, again.endMs], [row.id, true, at(SUN, '02:00'), at(SUN, '03:00')]);
});

test('editing the carry-in Ticktick from Sunday\'s view writes SATURDAY\'s record, never a Sunday copy', () => {
  const app = acceptanceApp();
  const row = rowOf(view(app, SUN, 36), 'ticktick');
  const owner = app.authority.targetById(row.dayId);
  assert.equal(owner.id, SAT_ID);
  app.authority.updateItem({ sourceTarget: owner, itemId: row.itemId, changes: { task: 'Ticktick list (renamed)', durationMinutes: 480 }, stamp: stamp(app) });
  assert.deepEqual(app.calendarRepository.read(SAT).items.map(i => [i.id, i.task, i.durationMinutes]), [['ticktick', 'Ticktick list (renamed)', 480]]);
  assert.deepEqual(app.calendarRepository.read(SUN).items.map(i => i.id), ['sad'], 'no Sunday-owned duplicate');
  const satRow = rowOf(view(app, SAT, 36), 'ticktick');
  assert.equal(satRow.title, 'Ticktick list (renamed)');
  assert.equal(satRow.endMs, at(SUN, '06:00'));
});

test('an ended owner keeps its own guard: a carry-in from a past plan cannot be edited through the view', () => {
  // Sunday 09:00: Saturday's plan is over. Its Ticktick row still projects into Sunday's
  // view (it intersects 00:00–08:00), but the owner's own "past days are history" rule holds.
  const app = acceptanceApp();
  app.clock.now = at(SUN, '09:00');
  const row = rowOf(view(app, SUN, 36), 'ticktick');
  assert.equal(row.dayId, SAT_ID);
  assert.throws(() => app.authority.updateItem({ sourceTarget: app.authority.targetById(row.dayId), itemId: row.itemId, changes: { done: true }, stamp: stamp(app) }), /history/i);
  // The existing live-today completion exception is refused too: it started on Saturday.
  assert.equal(app.authority.completeCarryoverItem({ target: app.authority.targetById(row.dayId), itemId: row.itemId, stamp: stamp(app) }), null);
  assert.equal(app.calendarRepository.read(SAT).items[0].done, false);
});

// ═══════════════════════════════════════════════════════════════════════
// 6. overlap, ordering, isolation, scope
// ═══════════════════════════════════════════════════════════════════════

test('one record visible in neighbouring views is still exactly one record with one stable id', () => {
  const app = acceptanceApp();
  const appearances = [SAT, SUN].flatMap(date => view(app, date, 48).positioned.filter(row => row.itemId === 'ticktick'));
  assert.equal(appearances.length, 2, 'seen in Saturday\'s and Sunday\'s views');
  assert.equal(new Set(appearances.map(row => row.id)).size, 1);
  const stored = [SAT, SUN].flatMap(date => app.calendarRepository.read(date)?.items || []).filter(i => i.id === 'ticktick');
  assert.equal(stored.length, 1);
});

test('ordering is independent of input order (and of plan read order)', () => {
  const app = acceptanceApp();
  app.authority.saveItems(app.authority.calendarTarget(SAT), [TICKTICK, item('same-a', 'A', '09:00'), item('same-b', 'B', '09:00'), item('early', 'Early', '07:00')]);
  const forward = view(app, SAT, 36).positioned;
  const reversed = new Proxy(app.authority, { get: (target, key) => (key === 'items' ? t => [...target.items(t)].reverse() : target[key]) });
  const backward = deriveDailyViewPlannedRows({ dateKey: SAT, hours: 36, authority: reversed }).positioned;
  assert.deepEqual(backward, forward);
  assert.deepEqual(forward.map(row => row.itemId), ['early', 'same-a', 'same-b', 'ticktick', 'sad']);
});

test('only the bounded neighbouring plans are read — never history or the far future', () => {
  const app = acceptanceApp();
  const read = [];
  const spy = new Proxy(app.authority, { get: (target, key) => (key === 'calendarTarget' ? date => { read.push(date); return target.calendarTarget(date); } : target[key]) });
  deriveDailyViewPlannedRows({ dateKey: SAT, hours: 48, authority: spy });
  assert.deepEqual([...new Set(read)].sort(), [SAT, SUN], 'Friday is before the activation date, so it is not calendar-authoritative and never read');
  read.length = 0;
  deriveDailyViewPlannedRows({ dateKey: SUN, hours: 24, authority: spy });
  assert.deepEqual([...new Set(read)].sort(), [SAT, SUN]);
});

test('a date that is not calendar-authoritative has no Daily View window (legacy / Personal Day views keep their own)', () => {
  const app = makeApp({ activate: false });
  assert.equal(view(app, SAT, 36), null);
  const activated = acceptanceApp();
  assert.equal(view(activated, FRI, 36), null, 'the day before the activation date stays legacy');
});

test('account isolation: another account in the same browser projects none of account A\'s plans', () => {
  const app = acceptanceApp();
  assert.equal(view(app, SAT, 36).positioned.length, 2);
  app.owner.room = 'uid_B';
  app.authority.invalidate();
  const other = view(app, SAT, 36);
  assert.ok(other === null || other.positioned.every(row => !['ticktick', 'sad'].includes(row.itemId)), 'nothing of A leaks into B');
});

test('Anytime rows come from the selected plan only; neighbouring untimed items have no position in the window', () => {
  const app = acceptanceApp();
  app.authority.saveItems(app.authority.calendarTarget(SUN), [SAD, { id: 'sun-untimed', task: 'Untimed Sunday', when: '', done: false, updatedAt: 1, updatedBy: 'phone' }]);
  app.authority.saveItems(app.authority.calendarTarget(SAT), [TICKTICK, { id: 'sat-untimed', task: 'Untimed Saturday', when: '', done: false, updatedAt: 1, updatedBy: 'phone' }]);
  const sat = view(app, SAT, 48);
  assert.deepEqual(sat.anytime.map(row => row.itemId), ['sat-untimed']);
  assert.ok(!sat.positioned.some(row => row.itemId === 'sun-untimed'));
});

test('timed commitments are positioned records too: kept when they intersect the window, by the same half-open rule', () => {
  const app = acceptanceApp();
  const commitment = (id, date, time, durationMinutes) => buildCommitment({ id, title: id, date, time, timezone: MANILA, durationMinutes, now: at(FRI, '09:00'), updatedBy: 'phone' }).record;
  const all = [
    commitment('fri-late', FRI, '23:00', 120),   // Fri 23:00 → Sat 01:00: carries in
    commitment('sun-early', SUN, '07:00', 30),   // inside 36h
    commitment('sun-noon', SUN, '12:00', 30),    // exactly windowEnd: out
  ];
  const between = (startMs, endMs) => all.filter(r => r.startMs >= startMs && r.startMs < endMs);
  const sat = view(app, SAT, 36, { commitmentsBetween: between });
  assert.deepEqual(sat.positioned.filter(row => row.sourceType === 'commitment').map(row => row.commitmentId), ['fri-late', 'sun-early']);
  assert.equal(sat.positioned.find(row => row.commitmentId === 'fri-late').carryIn, true);
});
