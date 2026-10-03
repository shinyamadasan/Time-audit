// brain-dump-destination.test.js
//
// Brain Dump Production UX Correction V1, FIX FIRST F4: where a promoted capture
// landed, and whether "Open in plan" may be offered. Runs against the REAL Plan
// Authority (legacy, Personal Day boundary, and calendar-native routing), so a
// target's own identity, never "now", decides the date. "Open in plan" must
// never land on a different factual day than the promotion's own target.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanAuthority } from './plan-authority.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { createOperationalPlanSyncBridge } from './operational-plan-sync.js';
import { createPersonalDayBoundarySyncBridge } from './personal-day-boundary-sync.js';
import { createCalendarPlanRepository } from './calendar-plan-repository.js';
import { createCalendarPlanSyncBridge } from './calendar-plan-sync.js';
import { createCalendarPlanLiveWiring } from './calendar-plan-live.js';
import { fakeDatabase, memoryStorage } from './calendar-plan-test-support.js';
import { promotionDestination } from './brain-dump-promotion.js';
import { brainDumpPlanItemId } from './brain-dump-model.js';

const MANILA = 'Asia/Manila';
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
let seq = 0;

function legacyStore() {
  const plans = {};
  return {
    plans,
    record: dateKey => plans[dateKey] || null,
    rawItems: dateKey => (plans[dateKey]?.items || []).map(i => ({ ...i })),
    saveItems(dateKey, items) { plans[dateKey] = { ...(plans[dateKey] || {}), items }; },
    confirm() { return { localSaved: true, syncPromise: Promise.resolve(false) }; },
    allPlans: () => plans,
    earliestPlanDate() { const keys = Object.keys(plans).sort(); return keys.length ? keys[0] : null; },
  };
}

/** Same shape as plan-authority-calendar.test.js's makeApp: one device, all real modules. */
function makeAuthority({ nowMs, boundary = null }) {
  const clock = { now: nowMs };
  const room = () => 'uid_A';
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage: memoryStorage(), idGenerator: () => `rev-${++seq}`, getOwner: room });
  if (boundary) boundaryRepository.propose({ boundaryTime: boundary, timezone: MANILA }, at('2026-01-01', '00:00'));
  const planRepository = createOperationalPlanRepository({ storage: memoryStorage(), getOwner: room });
  const planSync = createOperationalPlanSyncBridge({ repository: planRepository, getRoomRef: () => null, getRoomId: room });
  const boundarySync = createPersonalDayBoundarySyncBridge({ repository: boundaryRepository, getRoomRef: () => null, getRoomId: room });
  const legacy = legacyStore();
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository, planSync, boundarySync,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => clock.now, deviceId: () => 'phone', fallbackTimezone: () => MANILA,
  });
  const db = fakeDatabase();
  const calendarRepository = createCalendarPlanRepository({ storage: memoryStorage(), getOwner: room, getTimezone: () => MANILA, idGenerator: () => `ca1-${++seq}` });
  const calendarSync = createCalendarPlanSyncBridge({ repository: calendarRepository, getRoomRef: () => db.ref('rooms/uid_A'), getRoomId: room });
  const calendar = createCalendarPlanLiveWiring({ repository: calendarRepository, sync: calendarSync, now: () => clock.now, deviceId: () => 'phone', timezone: () => MANILA });
  calendar.attachLive();
  const authority = createPlanAuthority({ live, legacy, calendar, now: () => clock.now, accountTimezone: () => MANILA });
  return { authority, clock };
}

/** Promotes a capture into `target` the way createAndFinalize does: one plan item, then a promoted record. */
function promoted(authority, target, { type = 'do-today', when = '', id = `bdest${++seq}` } = {}) {
  const planItemId = brainDumpPlanItemId(id);
  authority.addItem({ destination: target, item: { id: planItemId, task: 'x', when, done: false, doneAt: null, updatedAt: 1, updatedBy: 't', kind: 'task' } });
  return { id, status: 'promoted', promotion: { type, store: target.store, targetId: target.id, planItemId, when, durationMinutes: null, promotedAt: 1 } };
}

/** The invariant for every case: an offered date must open THIS promotion's own target. */
function assertNeverWrongDay(authority, record, destination) {
  if (!destination.openDateKey) return;
  assert.equal(authority.dayForCalendarDate(destination.openDateKey).id, record.promotion.targetId, 'Open in plan lands on the promotion\'s own day');
}

test('legacy account (no boundary): Do Today names its date and opens it', () => {
  const { authority } = makeAuthority({ nowMs: at('2026-10-01', '09:00') });
  const record = promoted(authority, authority.current());
  const destination = promotionDestination(authority, record);
  assert.equal(destination.kind, 'date');
  assert.equal(destination.dateKey, '2026-10-01');
  assert.equal(destination.openDateKey, '2026-10-01');
  assertNeverWrongDay(authority, record, destination);
});

test('Personal Day (operational) target: no invented calendar date, no Open in plan, described by its start', () => {
  // 11:00 Sunday with an 18:00 boundary is still SATURDAY's personal day.
  const { authority } = makeAuthority({ nowMs: at('2026-09-27', '11:00'), boundary: '18:00' });
  const target = authority.current();
  assert.equal(target.store, 'operational');
  const record = promoted(authority, target);
  const destination = promotionDestination(authority, record);
  assert.equal(destination.kind, 'personal-day');
  assert.equal(destination.dateKey, '');
  assert.equal(destination.openDateKey, '', 'never a guessed date');
  assert.equal(destination.startMs, at('2026-09-26', '18:00'));
  assert.equal(destination.timezone, MANILA);
});

test('calendar-native Do Today: names today and opens exactly that calendar plan', () => {
  const { authority } = makeAuthority({ nowMs: at('2026-09-27', '11:00'), boundary: '18:00' });
  authority.activateCalendar();
  const target = authority.current();
  assert.equal(target.store, 'calendar');
  const record = promoted(authority, target);
  const destination = promotionDestination(authority, record);
  assert.equal(destination.kind, 'date');
  assert.equal(destination.dateKey, '2026-09-27');
  assert.equal(destination.openDateKey, '2026-09-27');
  assertNeverWrongDay(authority, record, destination);
});

test('calendar-native after midnight: the promotion\'s own date is shown and opened, never the evening before or "now"', () => {
  const app = makeAuthority({ nowMs: at('2026-09-27', '11:00'), boundary: '18:00' });
  app.authority.activateCalendar();
  app.clock.now = at('2026-09-28', '00:30');
  const target = app.authority.current();
  assert.equal(target.dateKey, '2026-09-28', 'after midnight is the new factual date');
  const record = promoted(app.authority, target);
  app.clock.now = at('2026-09-28', '23:00');
  const destination = promotionDestination(app.authority, record);
  assert.equal(destination.dateKey, '2026-09-28');
  assert.equal(destination.openDateKey, '2026-09-28');
  assertNeverWrongDay(app.authority, record, destination);
});

test('calendar-native future Schedule with a time: names that date and time, opens that date', () => {
  const { authority } = makeAuthority({ nowMs: at('2026-09-27', '11:00'), boundary: '18:00' });
  authority.activateCalendar();
  const resolved = authority.dayForScheduledDate('2026-10-05', '15:00');
  assert.equal(resolved.ok, true);
  const record = promoted(authority, resolved.target, { type: 'schedule', when: '15:00' });
  const destination = promotionDestination(authority, record);
  assert.equal(destination.dateKey, '2026-10-05');
  assert.equal(destination.when, '15:00');
  assert.equal(destination.openDateKey, '2026-10-05');
  assertNeverWrongDay(authority, record, destination);
});

test('a date that would open a DIFFERENT day than the promotion\'s own target offers no Open in plan', () => {
  // A legacy-dated promotion read on an account whose date navigation now resolves to another day.
  const fakeAuthority = {
    enabled: () => true,
    targetById: id => ({ store: 'legacy', id, dateKey: id }),
    rawItems: () => [],
    dayForCalendarDate: dateKey => ({ store: 'operational', id: `op:${dateKey}` }),
  };
  const record = { status: 'promoted', promotion: { type: 'do-today', store: 'legacy', targetId: '2026-10-01', planItemId: 'bdp1|x', when: '', durationMinutes: null, promotedAt: 1 } };
  const destination = promotionDestination(fakeAuthority, record);
  assert.equal(destination.dateKey, '2026-10-01');
  assert.equal(destination.openDateKey, '');
});

test('an unresolvable target or a record without a promotion yields no destination at all', () => {
  const { authority } = makeAuthority({ nowMs: at('2026-10-01', '09:00') });
  assert.equal(promotionDestination(authority, { status: 'archived', promotion: null }).kind, 'unknown');
  const ghost = { status: 'promoted', promotion: { type: 'do-today', store: 'operational', targetId: 'op1|nope', planItemId: 'bdp1|x', when: '', durationMinutes: null, promotedAt: 1 } };
  const destination = promotionDestination(authority, ghost);
  assert.equal(destination.kind, 'unknown');
  assert.equal(destination.openDateKey, '');
});
