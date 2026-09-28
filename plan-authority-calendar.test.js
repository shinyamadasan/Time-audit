// plan-authority-calendar.test.js
//
// Calendar-Native Plan Identity V1 — PlanAuthority over the calendar-native store, with
// PRODUCTION-EQUIVALENT modules: the real Personal Day boundary repository + live wiring,
// the real operational-plan repository, the real calendar-plan repository/sync/live wiring
// and the real Plan-by-deadline repository. Only Firebase (an in-memory database) and the
// clock are fake.
//
// The definitive scenario (§9): Asia/Manila, a LEGACY Personal Day boundary of 18:00, the
// clock at Sunday 2026-09-27 11:00. No waiting until 18:00.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanAuthority } from './plan-authority.js';
import { createPlanByDeadlineRepository } from './plan-by-deadline-repository.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { createOperationalPlanSyncBridge } from './operational-plan-sync.js';
import { createPersonalDayBoundarySyncBridge } from './personal-day-boundary-sync.js';
import { createCalendarPlanRepository } from './calendar-plan-repository.js';
import { createCalendarPlanSyncBridge } from './calendar-plan-sync.js';
import { createCalendarPlanLiveWiring } from './calendar-plan-live.js';
import { fakeDatabase, memoryStorage } from './calendar-plan-test-support.js';

const MANILA = 'Asia/Manila';
const LA = 'America/Los_Angeles';
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const SUN = '2026-09-27';
const MON = '2026-09-28';
const TUE = '2026-09-29';
const SUN_ID = `cal1:${SUN}`;
const MON_ID = `cal1:${MON}`;

function legacyStore(seed = {}, tzRef = { tz: MANILA }) {
  const plans = JSON.parse(JSON.stringify(seed));
  return {
    plans,
    record: dateKey => plans[dateKey] || null,
    rawItems: dateKey => (plans[dateKey]?.items || []).map(i => ({ ...i })),
    saveItems(dateKey, items) { plans[dateKey] = { ...(plans[dateKey] || {}), items }; },
    confirm(input) {
      const preparation = {
        schemaVersion: 1, targetDate: input.targetDate, timezone: tzRef.tz,
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

let seq = 0;
/** One device of one account. `db` is shared between devices of the same account; `owner.room`
 *  is what the app has joined (every repository is scoped to it). */
function makeApp({ nowMs, boundary = '18:00', db = fakeDatabase(), owner = { room: 'uid_A' }, tz = { tz: MANILA }, deviceId = 'phone', legacySeed = {}, online = true } = {}) {
  const clock = { now: nowMs };
  const state = { online };
  const room = () => owner.room;
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage: memoryStorage(), idGenerator: () => `rev-${++seq}`, getOwner: room });
  if (boundary) boundaryRepository.propose({ boundaryTime: boundary, timezone: MANILA }, at('2026-01-01', '00:00'));
  const planRepository = createOperationalPlanRepository({ storage: memoryStorage(), getOwner: room });
  const planSync = createOperationalPlanSyncBridge({ repository: planRepository, getRoomRef: () => null, getRoomId: room });
  const boundarySync = createPersonalDayBoundarySyncBridge({ repository: boundaryRepository, getRoomRef: () => null, getRoomId: room });
  const legacy = legacyStore(legacySeed, tz);
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository, planSync, boundarySync,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => clock.now, deviceId: () => deviceId, fallbackTimezone: () => tz.tz,
  });
  const calendarRepository = createCalendarPlanRepository({ storage: memoryStorage(), getOwner: room, getTimezone: () => tz.tz, idGenerator: () => `ca1-${deviceId}-${++seq}` });
  const calendarSync = createCalendarPlanSyncBridge({
    repository: calendarRepository,
    getRoomRef: () => (state.online && owner.room ? db.ref(`rooms/${owner.room}`) : null),
    getRoomId: room,
  });
  const calendar = createCalendarPlanLiveWiring({ repository: calendarRepository, sync: calendarSync, now: () => clock.now, deviceId: () => deviceId, timezone: () => tz.tz });
  calendar.attachLive();
  const planByDeadline = createPlanByDeadlineRepository({ storage: memoryStorage(), idGenerator: () => `pbd-${++seq}`, getOwner: room });
  const authority = createPlanAuthority({ live, legacy, calendar, now: () => clock.now, accountTimezone: () => tz.tz, planByDeadline });
  return { authority, calendar, live, legacy, planByDeadline, calendarRepository, planRepository, boundaryRepository, db, owner, tz, clock, state, setNow: v => { clock.now = v; } };
}

const raw = app => JSON.stringify({ ops: app.planRepository.listAllRaw(), legacy: app.legacy.plans });
const stampFrom = app => item => ({ ...item, updatedAt: app.clock.now, updatedBy: 'test' });
const item = (id, when = '', extra = {}) => ({ id, task: `task ${id}`, when, done: false, doneAt: null, updatedAt: 1, updatedBy: 'test', ...extra });
const prepareAs = (app, target, items) => app.authority.confirmPreparation(target, { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });

// ═══════════════════════════════════════════════════════════════════════════
// §9 — the literal Sunday-11:00 / 18:00-legacy-boundary acceptance test
// ═══════════════════════════════════════════════════════════════════════════

test('BEFORE the cutover nothing changed: at Sunday 11:00 an 18:00 boundary still names Saturday\'s personal day', () => {
  const app = makeApp({ nowMs: at(SUN, '11:00') });
  const current = app.authority.current();
  assert.equal(current.store, 'operational');
  assert.equal(current.ref.boundaryStartDate, '2026-09-26'); // the very defect being completed
  assert.equal(app.authority.calendarActive(), false);
  assert.equal(app.authority.enabled(), true);
});

test('delayed authority hydration fails closed on the real legacy write path, then switches to CALENDAR', () => {
  const db = fakeDatabase();
  const fact = {
    schemaVersion: 1, id: 'ca1-remote', activatedAtMs: at(SUN, '09:00'), timezone: MANILA,
    activationDate: SUN, deviceId: 'device-a',
  };
  const base = db.ref('rooms/uid_A');
  let deliver = null;
  const delayedRoomRef = {
    child(name) {
      const child = base.child(name);
      if (name !== 'calendarPlanAuthority') return child;
      return {
        ...child,
        on(event, callback) { deliver = () => callback({ val: () => ({ [fact.id]: fact }) }); return callback; },
      };
    },
  };
  const owner = { room: 'uid_A' };
  const legacy = legacyStore();
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage: memoryStorage(), idGenerator: () => `rev-${++seq}`, getOwner: () => owner.room });
  boundaryRepository.propose({ boundaryTime: '18:00', timezone: MANILA }, at('2026-01-01', '00:00'));
  const planRepository = createOperationalPlanRepository({ storage: memoryStorage(), getOwner: () => owner.room });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository,
    legacyPlans: { readItems: key => legacy.rawItems(key), saveItems: (key, items) => legacy.saveItems(key, items) },
    now: () => at(SUN, '11:00'), fallbackTimezone: () => MANILA,
  });
  const calendarRepository = createCalendarPlanRepository({ storage: memoryStorage(), getOwner: () => owner.room, getTimezone: () => MANILA, idGenerator: () => 'local-fact' });
  const calendarSync = createCalendarPlanSyncBridge({ repository: calendarRepository, getRoomRef: () => delayedRoomRef, getRoomId: () => owner.room });
  const calendar = createCalendarPlanLiveWiring({ repository: calendarRepository, sync: calendarSync, now: () => at(SUN, '11:00'), deviceId: () => 'device-b', timezone: () => MANILA });
  const authority = createPlanAuthority({ live, legacy, calendar, now: () => at(SUN, '11:00'), accountTimezone: () => MANILA });

  calendar.attachLive();
  assert.equal(authority.authorityState(), 'unknown');
  assert.equal(authority.current(), null);
  assert.throws(() => authority.saveItems(authority.legacyTarget(SUN), [item('must-not-write')]), /authority.*sync/i);
  assert.deepEqual(legacy.plans, {}, 'ZERO authoritative legacy write before the snapshot');

  deliver();
  assert.equal(authority.authorityState(), 'calendar');
  assert.equal(authority.current().id, SUN_ID);
  authority.saveItems(authority.current(), [item('calendar-write')]);
  assert.equal(calendarRepository.read(SUN).items[0].id, 'calendar-write');
});

test('Sunday 11:00 @ 18:00: after the owner activates, the current plan IS Sunday\'s, the next IS Monday\'s', () => {
  const app = makeApp({ nowMs: at(SUN, '11:00') });
  app.authority.activateCalendar();
  assert.equal(app.authority.calendarActive(), true);
  const today = app.authority.current();
  const tomorrow = app.authority.upcoming();
  assert.deepEqual([today.store, today.id, today.dateKey], ['calendar', SUN_ID, SUN]);
  assert.deepEqual([tomorrow.store, tomorrow.id, tomorrow.dateKey], ['calendar', MON_ID, MON]);
  assert.equal(today.startMs, at(SUN, '00:00'));
  assert.equal(today.endMs, at(MON, '00:00'));
  assert.equal(app.authority.enabled(), false, 'operational personal-day mode is no longer in force');
  assert.equal(app.authority.boundaryEnabled(), true, 'the legacy boundary history is still there, untouched');
});

test('Sunday 11:00: preparing writes SUNDAY\'s calendar plan, the first item is Sunday 11:00, and the legacy Saturday plan receives ZERO writes', () => {
  const app = makeApp({ nowMs: at(SUN, '11:00') });
  // A legacy Saturday-window plan exists before the cutover (the user's real situation).
  const saturday = app.authority.current();
  app.authority.saveItems(saturday, [item('sat-legacy', '10:00')]);
  const before = raw(app);
  app.authority.activateCalendar();

  const today = app.authority.current();
  prepareAs(app, today, [item('first', '11:00'), item('second', '18:00')]);

  assert.equal(raw(app), before, 'no operational or legacy record was written by any of it');
  const record = app.calendarRepository.read(SUN);
  assert.deepEqual(record.items.map(i => [i.id, i.when, i.whenTz]), [['first', '11:00', MANILA], ['second', '18:00', MANILA]]);
  assert.equal(app.authority.itemStartInstant(today, '11:00', record.items[0]), at(SUN, '11:00'));
  assert.equal(app.authority.preparation(today).targetDate, SUN);
  assert.equal(app.authority.items(today).length, 2);
  assert.equal(app.authority.items(saturday).length, 1, 'and the Saturday plan still holds exactly what it held');
});

test('Sunday 11:00: the Plan-by deadline evaluates THIS SAME Sunday plan (no operational-day indirection, no waiting until 18:00)', () => {
  const app = makeApp({ nowMs: at(SUN, '11:00') });
  app.authority.activateCalendar();
  app.planByDeadline.proposeDeadline({ deadlineTime: '12:00', timezone: MANILA }, at('2026-01-01', '00:00'));
  prepareAs(app, app.authority.current(), [item('first', '11:30')]);
  const streak = app.authority.planningDeadlineStreak();
  assert.equal(streak.status, 'configured');
  assert.equal(streak.today.status, 'maintained');
  assert.equal(streak.today.deadlineInstantMs, at(SUN, '12:00'));
  assert.equal(streak.current, 1);
  // The deadline for Sunday belongs to Sunday: 08:00 under an 18:00 boundary is not bumped to Monday.
  assert.equal(app.authority.deadlineDateKeyForTarget(app.authority.current()), SUN);
});

test('an early Plan-by deadline (08:00) under the 18:00 legacy boundary still belongs to the plan\'s own date', () => {
  const app = makeApp({ nowMs: at(SUN, '07:00') });
  app.authority.activateCalendar();
  app.planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, at('2026-01-01', '00:00'));
  assert.equal(app.authority.planningDeadlineStreak().today.status, 'pending');
  prepareAs(app, app.authority.current(), [item('early', '09:00')]);
  const result = app.authority.planningDeadlineStreak();
  assert.equal(result.today.status, 'maintained');
  assert.equal(result.today.deadlineInstantMs, at(SUN, '08:00'));
});

test('past the deadline with nothing prepared: missed on the calendar date, and the off-day toggle keys under that same date', () => {
  const app = makeApp({ nowMs: at(SUN, '13:00') });
  app.authority.activateCalendar();
  app.planByDeadline.proposeDeadline({ deadlineTime: '12:00', timezone: MANILA }, at('2026-01-01', '00:00'));
  assert.equal(app.authority.planningDeadlineStreak().today.status, 'missed');
  app.planByDeadline.declareOffDay(app.authority.deadlineDateKeyForTarget(app.authority.current()), at(SUN, '09:00'));
  assert.equal(app.authority.planningDeadlineStreak().today.status, 'maintained');
});

// ═══════════════════════════════════════════════════════════════════════════
// §10 — Plan Tomorrow is a calendar identity, not a boundary one
// ═══════════════════════════════════════════════════════════════════════════

test('Plan Tomorrow: 11:00 -> Sunday/Monday, 23:00 -> Sunday/Monday, Monday 02:00 -> Monday/Tuesday (never derived from 18:00)', () => {
  const app = makeApp({ nowMs: at(SUN, '11:00') });
  app.authority.activateCalendar();
  const ids = () => [app.authority.current().dateKey, app.authority.upcoming().dateKey];
  assert.deepEqual(ids(), [SUN, MON]);
  app.setNow(at(SUN, '17:59')); assert.deepEqual(ids(), [SUN, MON]);
  app.setNow(at(SUN, '18:00')); assert.deepEqual(ids(), [SUN, MON], 'the old boundary instant changes nothing');
  app.setNow(at(SUN, '23:00')); assert.deepEqual(ids(), [SUN, MON]);
  app.setNow(at(MON, '02:00')); assert.deepEqual(ids(), [MON, TUE]);
  assert.equal(app.authority.dayAhead(2).dateKey, '2026-09-30');
  assert.deepEqual(app.authority.upcomingDays(3).map(t => t.dateKey), [MON, TUE, '2026-09-30']);
});

test('routing helpers name a date\'s own plan: containing(instant), dayForCalendarDate, dayForScheduledDate, targetById, daysOverlapping', () => {
  const app = makeApp({ nowMs: at(SUN, '11:00') });
  app.authority.activateCalendar();
  assert.equal(app.authority.containing(at(SUN, '05:00')).id, SUN_ID, 'Sunday 05:00 is Sunday\'s, not the old Saturday window\'s');
  assert.equal(app.authority.containing(at(SUN, '23:59')).id, SUN_ID);
  assert.equal(app.authority.containing(at(MON, '00:00')).id, MON_ID);
  assert.equal(app.authority.dayForCalendarDate(MON).id, MON_ID);
  assert.equal(app.authority.dayForScheduledDate(MON, '09:00').target.id, MON_ID);
  assert.equal(app.authority.targetById(SUN_ID).dateKey, SUN);
  assert.deepEqual(app.authority.daysOverlappingCalendarDate(SUN).map(t => t.id), [SUN_ID]);
  assert.equal(app.authority.scheduledDateForTarget(app.authority.targetById(MON_ID)), MON);
});

test('history before the cutover date is still legacy-routed (the cutover is not retroactive)', () => {
  const app = makeApp({ nowMs: at(SUN, '11:00') });
  app.authority.activateCalendar();
  assert.equal(app.authority.isCalendarAuthoritative('2026-09-26'), false);
  assert.equal(app.authority.isCalendarAuthoritative(SUN), true);
  assert.equal(app.authority.containing(at('2026-09-26', '12:00')).store, 'operational');
  assert.equal(app.authority.previous(app.authority.current()).store, 'operational', 'the chain hands over to the legacy day in force just before Sunday began');
  assert.equal(app.authority.previous(app.authority.current()).ref.boundaryStartDate, '2026-09-26', 'Saturday 23:59 belongs to the personal day that began Saturday 18:00');
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 / §11 / §12 — cross-midnight representation, carryover, completion
// ═══════════════════════════════════════════════════════════════════════════

function sundayWithOvernight() {
  const app = makeApp({ nowMs: at(SUN, '11:00') });
  app.authority.activateCalendar();
  const sunday = app.authority.current();
  prepareAs(app, sunday, [
    item('a', '11:00'), item('b', '18:00', { kind: 'task' }), item('c', '23:00', { kind: 'task' }),
    item('d', '01:00', { whenDayOffset: 1, kind: 'task' }), item('e', '04:00', { whenDayOffset: 1, kind: 'task' }), item('f', '09:00', { whenDayOffset: 1, kind: 'task' }),
  ]);
  return { app, sunday };
}

test('ONE Sunday plan represents Sunday 11:00/18:00/23:00 and Monday 01:00/04:00/09:00 — each with its true instant, none cloned', () => {
  const { app, sunday } = sundayWithOvernight();
  const instants = Object.fromEntries(app.authority.items(sunday).map(i => [i.id, app.authority.itemInstants(sunday, i).startMs]));
  assert.deepEqual(instants, {
    a: at(SUN, '11:00'), b: at(SUN, '18:00'), c: at(SUN, '23:00'),
    d: at(MON, '01:00'), e: at(MON, '04:00'), f: at(MON, '09:00'),
  });
  assert.equal(app.calendarRepository.read(MON), null, 'no Monday plan exists');
  assert.deepEqual(Object.keys(app.calendarRepository.listAllRaw()), [SUN_ID]);
  assert.equal(app.authority.items(app.authority.upcoming()).length, 0);
});

test('Monday 02:00 while still working through Sunday\'s plan: today is Monday, and Sunday\'s Monday-dated items are its carryover', () => {
  const { app } = sundayWithOvernight();
  app.setNow(at(MON, '02:00'));
  assert.equal(app.authority.current().id, MON_ID);
  assert.equal(app.authority.upcoming().id, `cal1:${TUE}`);
  const carryover = app.authority.calendarCarryoverFor(MON);
  assert.equal(carryover.target.id, SUN_ID, 'the carryover items remain owned by Sunday\'s calendar plan');
  assert.deepEqual(carryover.items.map(i => i.id).sort(), ['d', 'e', 'f']);
  assert.equal(app.authority.calendarCarryoverFor(TUE).items.length, 0);
  assert.equal(app.authority.calendarCarryoverFor('2026-09-26'), null, 'no calendar carryover source before the cutover date');
});

test('completing a carryover item updates SUNDAY\'s plan only — no Monday clone — and undo uses the same authority', () => {
  const { app } = sundayWithOvernight();
  app.setNow(at(MON, '02:00'));
  const sunday = app.authority.targetById(SUN_ID);
  const done = app.authority.completeCarryoverItem({ target: sunday, itemId: 'd', stamp: stampFrom(app) });
  assert.equal(done.item.done, true);
  assert.equal(done.item.doneAt, at(MON, '02:00'));
  assert.equal(app.calendarRepository.read(SUN).items.find(i => i.id === 'd').done, true);
  assert.equal(app.calendarRepository.read(MON), null, 'nothing was written under Monday');
  assert.equal(Object.keys(app.calendarRepository.listAllRaw()).length, 1);
  app.setNow(at(MON, '02:01')); // a later instant: two writes at one identical updatedAt would (correctly) tie-break, not toggle
  const undone = app.authority.completeCarryoverItem({ target: sunday, itemId: 'd', stamp: stampFrom(app) });
  assert.equal(undone.item.done, false);
  assert.equal(app.calendarRepository.read(SUN).items.find(i => i.id === 'd').done, false);
});

test('only an item that really lands today is completable from history; every other historical edit stays refused', () => {
  const { app } = sundayWithOvernight();
  app.setNow(at(MON, '02:00'));
  const sunday = app.authority.targetById(SUN_ID);
  assert.equal(app.authority.completeCarryoverItem({ target: sunday, itemId: 'a', stamp: stampFrom(app) }), null, 'Sunday 11:00 is not live on Monday');
  assert.equal(app.authority.completeCarryoverItem({ target: sunday, itemId: 'missing', stamp: stampFrom(app) }), null);
  assert.throws(() => app.authority.updateItem({ sourceTarget: sunday, itemId: 'a', changes: { task: 'rewritten' }, stamp: stampFrom(app) }), /history/);
  assert.throws(() => app.authority.addItem({ destination: sunday, item: item('late', '09:00') }), /history/);
  assert.equal(app.calendarRepository.read(SUN).items.find(i => i.id === 'a').task, 'task a');
});

test('after-midnight completion in the same minute the plan\'s own date ends is still Sunday\'s record', () => {
  const { app } = sundayWithOvernight();
  app.setNow(at(MON, '00:00'));
  const result = app.authority.completeCarryoverItem({ target: app.authority.targetById(SUN_ID), itemId: 'e', stamp: stampFrom(app) });
  assert.equal(result.item.id, 'e');
  assert.equal(app.calendarRepository.read(SUN).items.find(i => i.id === 'e').done, true);
});

test('a Sunday-plan item at Monday 09:00 is NOT "unfinished from a previous day" at Monday 02:00 — only once its own span is over', () => {
  const { app } = sundayWithOvernight();
  app.setNow(at(MON, '02:00'));
  const staleIds = () => app.authority.staleUnfinished().items.filter(row => row.target.id === SUN_ID).map(row => row.item.id).sort();
  assert.deepEqual(staleIds(), ['a', 'b', 'c', 'd'], 'a/b/c and the 01:00 item are over; 04:00 and 09:00 are still ahead');
  app.setNow(at(MON, '10:00'));
  assert.deepEqual(staleIds(), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('an invalid time is refused by the authority: a range may not run past the end of the plan\'s second date', () => {
  const { app, sunday } = sundayWithOvernight();
  assert.equal(app.authority.validateItem(sunday, item('x', '23:00', { whenDayOffset: 1, durationMinutes: 120 })).reason, 'outside-plan-extent');
  assert.equal(app.authority.validateItem(sunday, item('x', '23:00', { durationMinutes: 120 })).ok, true, 'a Sunday 23:00 -> Monday 01:00 range is fine');
  assert.throws(() => app.authority.addItem({ destination: sunday, item: item('x', '23:00', { whenDayOffset: 1, durationMinutes: 120 }) }), /not valid/);
});

// ═══════════════════════════════════════════════════════════════════════════
// §16 / §22 — historical timezone truth; the old boundary decides nothing new
// ═══════════════════════════════════════════════════════════════════════════

test('changing the account timezone later does not move a scheduled Sunday instant', () => {
  const { app, sunday } = sundayWithOvernight();
  const snapshot = () => Object.fromEntries(app.authority.items(sunday).map(i => [i.id, app.authority.itemInstants(sunday, i).startMs]));
  const before = snapshot();
  app.tz.tz = LA; // the account moves
  app.authority.saveItems(sunday, app.authority.rawItems(sunday).map(i => (i.id === 'a' ? { ...i, done: true } : i))); // an unrelated later edit
  assert.deepEqual(snapshot(), before);
  assert.equal(app.calendarRepository.read(SUN).items.find(i => i.id === 'a').whenTz, MANILA);
  assert.equal(app.authority.targetById(SUN_ID).timezone, MANILA, 'the plan keeps the zone it was created in');
  assert.equal(app.authority.targetById(SUN_ID).startMs, at(SUN, '00:00'));
});

test('changing the legacy Personal Day boundary after a calendar plan exists changes nothing about it', () => {
  const { app } = sundayWithOvernight();
  const before = JSON.stringify(app.calendarRepository.read(SUN));
  app.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA }, at(SUN, '11:30'));
  app.setNow(at(SUN, '21:00'));
  assert.equal(app.authority.current().id, SUN_ID);
  assert.equal(app.authority.upcoming().id, MON_ID);
  assert.equal(JSON.stringify(app.calendarRepository.read(SUN)), before);
  assert.equal(app.authority.boundaryChangeImpact({ boundaryTime: '06:00', timezone: MANILA }).orphaned.length, 0, 'a boundary change can strand nothing');
});

// ═══════════════════════════════════════════════════════════════════════════
// §7 / §18 — legacy compatibility, cutover, stale legacy writes
// ═══════════════════════════════════════════════════════════════════════════

test('legacy data does not disappear: the pre-cutover personal day stays readable and its unfinished work moves into Sunday\'s plan through the ordinary flow', () => {
  const app = makeApp({ nowMs: at(SUN, '11:00') });
  const saturday = app.authority.current();
  prepareAs(app, saturday, [item('legacy-1', '10:00'), item('legacy-2', '14:00'), item('legacy-3', '', { done: true, doneAt: at(SUN, '09:00') })]);
  const legacyBefore = raw(app);
  app.authority.activateCalendar();

  const superseded = app.authority.supersededPlans();
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].store, 'operational');
  assert.deepEqual(superseded[0].items.map(i => i.id).sort(), ['legacy-1', 'legacy-2', 'legacy-3']);
  assert.ok(superseded[0].preparation, 'its preparation is still there');

  // The superseded day is "ended" as of the cutover: read-only, and its unfinished tasks are recoverable.
  const sourceTarget = app.authority.targetById(saturday.id);
  assert.throws(() => app.authority.assertDirectSchedulingTarget(sourceTarget), /history/);
  assert.deepEqual(app.authority.staleUnfinished().items.map(row => row.item.id).sort(), ['legacy-1', 'legacy-2']);

  const today = app.authority.current();
  const moved = app.authority.moveStaleItem({ sourceTarget, itemId: 'legacy-1', destination: today, stamp: stampFrom(app) });
  assert.equal(moved.moved, true);
  assert.equal(moved.destination.id, SUN_ID);
  assert.equal(app.authority.items(today).length, 1);
  assert.equal(app.authority.items(today)[0].carriedFromId, 'legacy-1');
  assert.equal(raw(app), legacyBefore, 'the legacy records were not rewritten by any of it');
  // The older plan says where the task went, so it does not read as still open there.
  assert.equal(app.authority.supersededPlans()[0].items.find(i => i.id === 'legacy-1').movedTo, SUN_ID);
  assert.equal(app.authority.supersededPlans()[0].items.find(i => i.id === 'legacy-2').movedTo, null);
  // Idempotent: the same task is never offered or moved twice.
  assert.equal(app.authority.moveStaleItem({ sourceTarget, itemId: 'legacy-1', destination: today, stamp: stampFrom(app) }).moved, false);
  assert.deepEqual(app.authority.staleUnfinished().items.map(row => row.item.id), ['legacy-2']);
});

test('concurrent same-source recovery to different dates converges to one authoritative live item in either delivery order', async () => {
  for (const reverse of [false, true]) {
    const db = fakeDatabase();
    const legacySeed = { '2026-09-26': { items: [item('source', '')], updatedAt: 1 } };
    const a = makeApp({ nowMs: at(SUN, '11:00'), boundary: null, db, deviceId: 'a', legacySeed, online: false });
    const b = makeApp({ nowMs: at(SUN, '11:00'), boundary: null, db, deviceId: 'b', legacySeed, online: false });
    a.authority.activateCalendar(); b.authority.activateCalendar();
    const claimA = a.authority.moveStaleItem({ sourceTarget: a.authority.targetById('2026-09-26'), itemId: 'source', destination: a.authority.current(), stamp: value => ({ ...value, updatedAt: 10, updatedBy: 'a' }) });
    const claimB = b.authority.moveStaleItem({ sourceTarget: b.authority.targetById('2026-09-26'), itemId: 'source', destination: b.authority.upcoming(), stamp: value => ({ ...value, updatedAt: 11, updatedBy: 'b' }) });
    assert.equal(claimA.carryId, claimB.carryId, 'identity is source-owned, not destination-owned');
    assert.deepEqual(claimA.item.relocationRevision, {
      schemaVersion: 1, sequence: 1, fromDayId: '2026-09-26', toDayId: `cal1:${SUN}`, updatedAt: 10, updatedBy: 'a',
    }, 'the materialized item carries its account-owned destination claim');
    assert.equal(claimB.item.relocationRevision.toDayId, `cal1:${MON}`);

    for (const device of reverse ? [b, a] : [a, b]) {
      device.state.online = true;
      device.calendar.attachLive();
      device.calendar.pushAllLocal();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    for (const device of [a, b]) {
      device.calendar.attachLive();
      await new Promise(resolve => setTimeout(resolve, 0));
      device.authority.invalidate();
      const liveRecovered = [device.authority.current(), device.authority.upcoming()]
        .flatMap(target => device.authority.items(target))
        .filter(candidate => candidate.carriedFromId === 'source');
      assert.equal(liveRecovered.length, 1, `reverse=${reverse}: never two authoritative recovered copies`);
      assert.equal(device.authority.staleUnfinished().items.some(row => row.item.id === 'source'), false);
    }
  }
});

test('concurrent same-source recovery to the same date is one idempotent item', async () => {
  const db = fakeDatabase();
  const legacySeed = { '2026-09-26': { items: [item('source', '')], updatedAt: 1 } };
  const a = makeApp({ nowMs: at(SUN, '11:00'), boundary: null, db, deviceId: 'a', legacySeed, online: false });
  const b = makeApp({ nowMs: at(SUN, '11:00'), boundary: null, db, deviceId: 'b', legacySeed, online: false });
  a.authority.activateCalendar(); b.authority.activateCalendar();
  for (const device of [a, b]) device.authority.moveStaleItem({ sourceTarget: device.authority.targetById('2026-09-26'), itemId: 'source', destination: device.authority.current(), stamp: stampFrom(device) });
  for (const device of [a, b]) {
    device.state.online = true;
    device.calendar.attachLive();
    device.calendar.pushAllLocal();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(a.authority.items(a.authority.current()).filter(candidate => candidate.carriedFromId === 'source').length, 1);
  assert.equal(b.authority.items(b.authority.current()).filter(candidate => candidate.carriedFromId === 'source').length, 1);
  assert.equal(a.authority.moveStaleItem({ sourceTarget: a.authority.targetById('2026-09-26'), itemId: 'source', destination: a.authority.current(), stamp: stampFrom(a) }).moved, false);
});

test('a legacy plans[dateKey] plan for a date on/after the cutover is never the calendar plan\'s twin: calendar wins deterministically, legacy stays discoverable', () => {
  const legacySeed = { [MON]: { items: [{ id: 'old-mon', task: 'Prepared before the cutover', when: '', done: false, updatedAt: 5, updatedBy: 'old' }], updatedAt: 5 } };
  const app = makeApp({ nowMs: at(SUN, '11:00'), boundary: null, legacySeed });
  app.authority.activateCalendar();
  const tomorrow = app.authority.upcoming();
  assert.equal(tomorrow.store, 'calendar');
  assert.equal(app.authority.items(tomorrow).length, 0, 'the calendar plan does not silently inherit the legacy one');
  assert.deepEqual(app.authority.supersededPlans().map(p => [p.store, p.dateKey, p.items[0].id]), [['legacy', MON, 'old-mon']]);
  assert.equal(app.legacy.plans[MON].items.length, 1);
  // Adopting is an explicit, non-destructive move.
  const target = app.authority.targetById(MON);
  const moved = app.authority.moveStaleItem({ sourceTarget: target, itemId: 'old-mon', destination: tomorrow, stamp: stampFrom(app) });
  assert.equal(moved.moved, true);
  assert.equal(app.authority.items(tomorrow)[0].task, 'Prepared before the cutover');
});

test('a never-enabled account (no Personal Day at all) cuts over the same way: today and tomorrow become calendar plans', () => {
  const app = makeApp({ nowMs: at(SUN, '11:00'), boundary: null });
  assert.equal(app.authority.current().store, 'legacy');
  app.authority.activateCalendar();
  assert.deepEqual([app.authority.current().id, app.authority.upcoming().id], [SUN_ID, MON_ID]);
});

test('an account that never activates is untouched by any of this', () => {
  const app = makeApp({ nowMs: at(SUN, '11:00'), boundary: null });
  const today = app.authority.current();
  app.authority.saveItems(today, [item('legacy', '09:00')]);
  assert.equal(app.authority.current().store, 'legacy');
  assert.equal(app.calendarRepository.listAllActivationsRaw().length, 0);
  assert.deepEqual(app.calendarRepository.listAllRaw(), {});
  assert.equal(app.legacy.plans[SUN].items[0].id, 'legacy');
});

test('writing to a calendar plan before the account has activated is refused by construction (no split-brain writer)', () => {
  const app = makeApp({ nowMs: at(SUN, '11:00') });
  assert.throws(() => app.authority.saveItems(app.authority.calendarTarget(SUN), [item('x')]), /not active/);
  assert.equal(app.calendarRepository.read(SUN), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// §17 — account isolation
// ═══════════════════════════════════════════════════════════════════════════

test('a direct A -> B switch: no A plan, deadline, cutover or carryover reaches B, and B -> A restores A', () => {
  const { app } = sundayWithOvernight();
  app.planByDeadline.proposeDeadline({ deadlineTime: '12:00', timezone: MANILA }, at('2026-01-01', '00:00'));
  app.setNow(at(MON, '02:00'));
  assert.equal(app.authority.calendarCarryoverFor(MON).items.length, 3);

  app.owner.room = 'uid_B';
  app.authority.invalidate();
  assert.equal(app.authority.authorityState(), 'unknown', 'B is not inferred legacy from A state or absent cache');
  assert.equal(app.authority.calendarActive(), false, 'B has its own (absent) cutover');
  assert.equal(app.authority.current(), null, 'writes fail closed while B hydrates');
  app.calendar.attachLive();
  assert.equal(app.authority.authorityState(), 'legacy', 'B becomes legacy only after B\'s snapshot');
  assert.equal(app.authority.current().store, 'legacy', 'B has no Personal Day of its own: plain legacy routing');
  assert.equal(app.authority.calendarCarryoverFor(MON), null);
  assert.deepEqual(app.authority.supersededPlans(), []);
  assert.deepEqual(app.calendarRepository.listAllRaw(), {});
  assert.deepEqual(app.planByDeadline.readDeadlines(), []);
  assert.equal(app.authority.planningDeadlineStreak().status, 'unenforced');
  assert.throws(() => app.calendar.writePlanItems(SUN, [item('leak')]), /not active/);

  app.owner.room = 'uid_A';
  app.authority.invalidate();
  assert.equal(app.authority.authorityState(), 'calendar', 'A cached cutover restores A independently');
  assert.equal(app.authority.calendarActive(), true);
  assert.equal(app.authority.calendarCarryoverFor(MON).items.length, 3);
  assert.equal(app.calendarRepository.read(SUN).items.length, 6);
});

test('sign-out empties the calendar state: no active cutover, no plans, no writes', () => {
  const { app } = sundayWithOvernight();
  app.owner.room = null;
  app.authority.invalidate();
  assert.equal(app.authority.calendarActive(), false);
  assert.deepEqual(app.calendarRepository.listAllRaw(), {});
  assert.throws(() => app.calendar.activate(), /No account is active/);
});

test('the same item id in two accounts never collides', () => {
  const dbA = fakeDatabase();
  const a = makeApp({ nowMs: at(SUN, '11:00'), db: dbA, owner: { room: 'uid_A' } });
  const b = makeApp({ nowMs: at(SUN, '11:00'), db: dbA, owner: { room: 'uid_B' } });
  a.authority.activateCalendar(); b.authority.activateCalendar();
  a.authority.saveItems(a.authority.current(), [item('same', '10:00')]);
  b.authority.saveItems(b.authority.current(), [item('same', '15:00')]);
  assert.equal(a.calendarRepository.read(SUN).items[0].when, '10:00');
  assert.equal(b.calendarRepository.read(SUN).items[0].when, '15:00');
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 / §18 — cross-device cutover, offline, stale devices
// ═══════════════════════════════════════════════════════════════════════════

test('device A adopts calendar authority and prepares Sunday; stale device B (offline on the old model) reconnects and follows — it never writes a competing legacy Sunday plan', async () => {
  const db = fakeDatabase();
  const phone = makeApp({ nowMs: at(SUN, '11:00'), db, deviceId: 'phone' });
  const mac = makeApp({ nowMs: at(SUN, '11:00'), db, deviceId: 'mac', online: false });
  // Work written by the already-installed old version before this new startup remains recoverable.
  const oldMacDay = mac.live.planningDays().current;
  mac.live.writePlanItems(oldMacDay, [item('mac-offline-legacy', '13:00')], mac.live.revisions());

  phone.calendar.attachLive();
  phone.authority.activateCalendar();
  prepareAs(phone, phone.authority.current(), [item('from-phone', '11:00')]);
  await new Promise(resolve => setTimeout(resolve, 0));

  // The Mac has not heard: absence of a cache is UNKNOWN, not permission to create new legacy truth.
  assert.equal(mac.authority.authorityState(), 'unknown');
  assert.equal(mac.authority.current(), null);
  assert.throws(() => mac.authority.saveItems(mac.authority.legacyTarget(SUN), [item('must-not-write')]), /authority.*sync/i);

  // Reconnect: it learns the cutover from the account.
  mac.state.online = true;
  mac.calendar.attachLive();
  mac.calendar.pushAllLocal();
  await new Promise(resolve => setTimeout(resolve, 0));
  mac.authority.invalidate();

  assert.equal(mac.authority.calendarActive(), true);
  assert.equal(mac.authority.calendarActivation().deviceId, 'phone');
  const macToday = mac.authority.current();
  assert.equal(macToday.store, 'calendar');
  assert.deepEqual(mac.authority.items(macToday).map(i => i.id), ['from-phone'], 'the Mac reads the phone\'s Sunday plan');
  // The phone prepared with NO routines (an empty array the database drops): the Mac still reads it as prepared.
  assert.ok(mac.authority.preparation(macToday), 'preparation survived the cloud round trip');
  assert.equal(mac.authority.readyNow(macToday), true);

  // Its offline legacy work was NOT discarded and did NOT become a second current plan: it is surfaced.
  assert.deepEqual(mac.authority.supersededPlans().map(p => p.items.map(i => i.id)), [['mac-offline-legacy']]);
  const moved = mac.authority.moveStaleItem({ sourceTarget: mac.authority.targetById(mac.authority.supersededPlans()[0].id), itemId: 'mac-offline-legacy', destination: macToday, stamp: stampFrom(mac) });
  assert.equal(moved.moved, true);
  assert.deepEqual(mac.authority.items(macToday).map(i => i.id).sort(), [moved.carryId, 'from-phone'].sort());
});

test('two devices that each activated while offline converge on the SAME (earliest) cutover, in either delivery order', async () => {
  for (const flip of [false, true]) {
    const db = fakeDatabase();
    const phone = makeApp({ nowMs: at(SUN, '11:00'), db, deviceId: 'phone', online: false });
    const mac = makeApp({ nowMs: at(SUN, '15:00'), db, deviceId: 'mac', online: false });
    phone.authority.activateCalendar();
    mac.authority.activateCalendar();
    const order = flip ? [mac, phone] : [phone, mac];
    for (const device of order) { device.state.online = true; device.calendar.attachLive(); device.calendar.pushAllLocal(); await new Promise(resolve => setTimeout(resolve, 0)); }
    for (const device of [phone, mac]) device.calendar.attachLive();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const device of [phone, mac]) {
      device.authority.invalidate();
      assert.equal(device.authority.calendarActivation().deviceId, 'phone', `flip=${flip}: the earliest activation wins on ${device === phone ? 'phone' : 'mac'}`);
      assert.equal(device.authority.calendarActivation().activationDate, SUN);
    }
  }
});

test('two devices\' offline edits to the same calendar plan merge per item; neither overwrites the other', async () => {
  const db = fakeDatabase();
  const phone = makeApp({ nowMs: at(SUN, '11:00'), db, deviceId: 'phone' });
  const mac = makeApp({ nowMs: at(SUN, '11:00'), db, deviceId: 'mac' });
  phone.calendar.attachLive(); mac.calendar.attachLive();
  phone.authority.activateCalendar();
  await new Promise(resolve => setTimeout(resolve, 0));
  mac.authority.invalidate();
  phone.state.online = false; mac.state.online = false;
  phone.authority.saveItems(phone.authority.current(), [item('from-phone', '11:00')]);
  mac.authority.saveItems(mac.authority.current(), [item('from-mac', '12:00')]);
  phone.state.online = true; mac.state.online = true;
  phone.calendar.pushAllLocal(); mac.calendar.pushAllLocal();
  await new Promise(resolve => setTimeout(resolve, 0));
  phone.calendar.attachLive(); mac.calendar.attachLive();
  for (const device of [phone, mac]) assert.deepEqual(device.calendarRepository.read(SUN).items.map(i => i.id).sort(), ['from-mac', 'from-phone']);
});

// ═══════════════════════════════════════════════════════════════════════════
// §1 — streaks across the cutover
// ═══════════════════════════════════════════════════════════════════════════

test('the planning streak carries across the cutover: legacy days keep their credit, calendar days extend it', () => {
  const prepared = (dateKey, firstPreparedAt) => ({ items: [{ id: `p-${dateKey}`, task: 'x', when: '', done: false }], updatedAt: 1, preparation: { schemaVersion: 1, targetDate: dateKey, timezone: MANILA, firstPreparedAt, firstPreparedBy: 'd', firstPreparedMode: 'normal', lastPreparedAt: firstPreparedAt, lastPreparedMode: 'normal', updatedBy: 'd', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: [`p-${dateKey}`] } });
  const legacySeed = {
    '2026-09-25': prepared('2026-09-25', at('2026-09-24', '20:00')),
    '2026-09-26': prepared('2026-09-26', at('2026-09-25', '20:00')),
    [SUN]: prepared(SUN, at('2026-09-26', '20:00')),
  };
  const app = makeApp({ nowMs: at(SUN, '11:00'), boundary: null, legacySeed });
  const before = app.authority.streak();
  app.authority.activateCalendar();
  const tomorrow = app.authority.upcoming();
  prepareAs(app, tomorrow, [item('mon-priority')]);
  const after = app.authority.streak();
  assert.equal(after.todayEarned, true, 'Monday\'s calendar plan was prepared before Monday began');
  assert.ok(after.current >= before.current, 'the cutover did not reset the streak');
  assert.ok(after.current >= 3, `streak ${after.current} should count the two legacy days + Saturday (judged by its legacy successor) + today`);
});

test('the Plan-by streak counts calendar days back to the cutover date and stops there (no invented history)', () => {
  const app = makeApp({ nowMs: at(SUN, '09:00'), boundary: null });
  app.authority.activateCalendar();
  app.planByDeadline.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, at(SUN, '08:30'));
  prepareAs(app, app.authority.current(), [item('sun-priority', '10:00')]);
  const streak = app.authority.planningDeadlineStreak(at(SUN, '09:00'));
  assert.equal(streak.status, 'configured');
  assert.equal(streak.current, 0, 'the deadline only took effect after 08:00 Sunday: today is not yet enforced-and-met');
  app.setNow(at(TUE, '07:00'));
  assert.equal(app.authority.planningDeadlineStreak().status, 'configured');
});

// ═══════════════════════════════════════════════════════════════════════════
// §20 — Review compatibility
// ═══════════════════════════════════════════════════════════════════════════

test('Review: Sunday\'s plan context includes its Monday 02:00 item and the actual keeps its factual Monday timestamp (no duplication)', () => {
  const { app, sunday } = sundayWithOvernight();
  app.setNow(at(MON, '12:00'));
  const window = app.authority.evidenceWindow(sunday);
  assert.equal(window.startMs, at(SUN, '00:00'));
  assert.equal(window.endMs, at(MON, '00:00'), 'the home window is the calendar date; nothing about the plan is copied into Monday');
  const overnight = app.authority.items(sunday).find(i => i.id === 'd');
  assert.equal(app.authority.itemInstants(sunday, overnight).startMs, at(MON, '01:00'));
  assert.equal(app.authority.classifyItemActual(sunday, { ...overnight, done: true, doneAt: at(MON, '01:30') }, {}), 'done');
  assert.equal(app.authority.classifyItemActual(sunday, { ...overnight, done: true, doneAt: at(SUN, '20:00') }, {}), 'done', 'done during the plan\'s own date is not "early"');
  assert.equal(app.authority.classifyItemActual(sunday, { ...overnight, done: true, doneAt: at('2026-09-26', '20:00') }, {}), 'done-early');
});

test('Review extent is frozen to the calendar plan home timezone and item-owned instants after the account timezone changes', () => {
  const { app, sunday } = sundayWithOvernight();
  const overnight = app.authority.items(sunday).find(candidate => candidate.id === 'd');
  const itemBefore = app.authority.itemInstants(sunday, overnight);
  const before = app.authority.reviewEvidenceWindow(sunday);
  app.tz.tz = LA;
  const historical = app.authority.calendarTarget(SUN);
  const itemAfter = app.authority.itemInstants(historical, app.authority.items(historical).find(candidate => candidate.id === 'd'));
  assert.deepEqual(app.authority.reviewEvidenceWindow(historical), before);
  assert.deepEqual(itemAfter, itemBefore);
});
