// fence-scenarios.js
//
// Test-only (never loaded by index.html). Small, self-contained scenarios over the REAL calendar-native
// Plan Authority stack, written as functions of the modules under test so the SAME scenario can be run
// against the shipped modules (it must hold) and against deliberately broken copies of them
// (fence-source-mutation.test.js: it must fail). A scenario returns facts, never assertions.

import { brainDumpOrigin, partitionOutboundItemsWith } from './plan-item-origin.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { createOperationalPlanSyncBridge } from './operational-plan-sync.js';
import { createPersonalDayBoundarySyncBridge } from './personal-day-boundary-sync.js';
import { createCalendarPlanRepository } from './calendar-plan-repository.js';
import { createCalendarPlanSyncBridge as createShippedCalendarSyncBridge } from './calendar-plan-sync.js';
import { createCalendarPlanLiveWiring } from './calendar-plan-live.js';
import { memoryStorage } from './calendar-plan-test-support.js';

export const MANILA = 'Asia/Manila';
export const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
export const SUN = '2026-09-27';
export const MON = '2026-09-28';
export const SUN_ID = `cal1:${SUN}`;
export const MON_ID = `cal1:${MON}`;
export const FENCED_ID = 'bdp1|bfence1';

let seq = 0;

/** One device with the real boundary/operational/calendar stack, Plan Authority built by `createPlanAuthority`
 *  and the calendar sync bridge built by `createCalendarPlanSyncBridge` (both injectable, to run a mutant). */
export function makeFenceApp({ createPlanAuthority, createCalendarPlanSyncBridge = createShippedCalendarSyncBridge, db, nowMs = at(SUN, '11:00'), room = 'uid_A', lookup = null, online = true, deviceId = 'phone' }) {
  const clock = { now: nowMs };
  const state = { online };
  const owner = () => room;
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage: memoryStorage(), idGenerator: () => `rev-${++seq}`, getOwner: owner });
  const planRepository = createOperationalPlanRepository({ storage: memoryStorage(), getOwner: owner });
  const planSync = createOperationalPlanSyncBridge({ repository: planRepository, getRoomRef: () => null, getRoomId: owner });
  const boundarySync = createPersonalDayBoundarySyncBridge({ repository: boundaryRepository, getRoomRef: () => null, getRoomId: owner });
  const plans = {};
  const legacy = {
    plans, record: k => plans[k] || null, rawItems: k => (plans[k]?.items || []).map(i => ({ ...i })),
    saveItems(k, items) { plans[k] = { ...(plans[k] || {}), items }; },
    confirm: () => ({ localSaved: true, syncPromise: Promise.resolve(false) }), allPlans: () => plans, earliestPlanDate: () => null,
  };
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository, planSync, boundarySync,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => clock.now, deviceId: () => deviceId, fallbackTimezone: () => MANILA,
  });
  const calendarRepository = createCalendarPlanRepository({ storage: memoryStorage(), getOwner: owner, getTimezone: () => MANILA, idGenerator: () => `ca1-${deviceId}-${++seq}` });
  const calendarSync = createCalendarPlanSyncBridge({
    repository: calendarRepository, getRoomRef: () => (state.online && db ? db.ref(`rooms/${room}`) : null), getRoomId: owner,
    partitionOutboundItems: items => partitionOutboundItemsWith(items, lookup),
  });
  const calendar = createCalendarPlanLiveWiring({ repository: calendarRepository, sync: calendarSync, now: () => clock.now, deviceId: () => deviceId, timezone: () => MANILA });
  calendar.attachLive();
  const authority = createPlanAuthority({ live, legacy, calendar, now: () => clock.now, accountTimezone: () => MANILA });
  authority.activateCalendar();
  return { authority, calendar, calendarRepository, calendarSync, clock, state, stamp: item => ({ ...item, updatedAt: clock.now, updatedBy: deviceId }) };
}

const fencedFor = (target, extra = {}) => ({
  id: FENCED_ID, task: 'Brain Dump task', when: '', done: false, doneAt: null, updatedAt: 1, updatedBy: 't', kind: 'task',
  brainDumpOrigin: brainDumpOrigin({ claimEpoch: 0, type: 'do-today', store: 'calendar', targetKey: target.id }), ...extra,
});
export { fencedFor };

/** An editor move of a fenced item from today's plan to tomorrow's. */
export function crossTargetMoveScenario(options) {
  const app = makeFenceApp(options);
  const today = app.authority.current();
  const tomorrow = app.authority.upcoming();
  app.authority.addItem({ destination: today, item: fencedFor(today) });
  const before = JSON.stringify(app.calendarRepository.listAllRaw());
  let threw = null;
  try { app.authority.updateItem({ sourceTarget: today, itemId: FENCED_ID, destination: tomorrow, changes: { task: 'moved' }, stamp: app.stamp }); } catch (err) { threw = err.message; }
  const after = app.calendarRepository.listAllRaw();
  return {
    threw,
    changed: JSON.stringify(after) !== before,
    destinationHasIt: !!after[MON_ID]?.items?.some(i => i.id === FENCED_ID),
    sourceTombstoned: !!after[SUN_ID]?.items?.some(i => i.id === FENCED_ID && i.deleted === true),
  };
}

/** The refusal is for fenced items only: an ordinary item still moves across plans. */
export function ordinaryMoveScenario(options) {
  const app = makeFenceApp(options);
  const today = app.authority.current();
  const tomorrow = app.authority.upcoming();
  app.authority.addItem({ destination: today, item: { id: 'pordinary1', task: 'ordinary', when: '', done: false, doneAt: null, updatedAt: 1, updatedBy: 't', kind: 'task' } });
  const result = app.authority.updateItem({ sourceTarget: today, itemId: 'pordinary1', destination: tomorrow, changes: {}, stamp: app.stamp });
  return { moved: result.moved, destinationHasIt: !!app.calendarRepository.read(MON)?.items?.some(i => i.id === 'pordinary1' && !i.deleted) };
}

/** A fenced item written (by any caller) at a plan other than the one its origin names. */
export function wrongTargetWriteScenario(options) {
  const app = makeFenceApp(options);
  const today = app.authority.current();
  const tomorrow = app.authority.upcoming();
  let threw = null;
  try { app.authority.addItem({ destination: tomorrow, item: fencedFor(today) }); } catch (err) { threw = err.message; }
  return { threw, written: !!app.calendarRepository.read(MON)?.items?.some(i => i.id === FENCED_ID) };
}

/** Same-target edits of a fenced item, including a cross-midnight reading, then the SAME plan identity. */
export function sameTargetEditScenario(options) {
  const app = makeFenceApp(options);
  const today = app.authority.current();
  app.authority.addItem({ destination: today, item: fencedFor(today) });
  const edit = changes => app.authority.updateItem({ sourceTarget: today, itemId: FENCED_ID, changes, stamp: app.stamp });
  edit({ task: 'renamed' });
  edit({ when: '22:00', durationMinutes: 600 }); // ends 08:00 the next calendar date: still owned by today's plan
  edit({ done: true, doneAt: app.clock.now });
  edit({ when: '01:00', whenDayOffset: 1, durationMinutes: 30, done: false, doneAt: null });
  const stored = app.calendarRepository.read(SUN).items.find(i => i.id === FENCED_ID);
  return { stored, planIds: Object.keys(app.calendarRepository.listAllRaw()) };
}

/** Does Plan Authority's destination read come from the SERVER child, whatever this device's cache holds? */
export async function presenceScenario({ remoteHasIt, localHasIt, ...options }) {
  const app = makeFenceApp(options);
  const today = app.authority.current();
  if (localHasIt) app.authority.addItem({ destination: today, item: fencedFor(today) });
  if (remoteHasIt) options.db.setAt(`rooms/uid_A/calendarPlanFences/${SUN_ID}/${FENCED_ID}`, fencedFor(today));
  return app.authority.remoteItemPresence(today, FENCED_ID, { timeoutMs: 100, expected: { claimEpoch: 0, type: 'do-today', store: 'calendar', targetKey: SUN_ID } });
}

/** A device holding a queued, provably superseded fenced item reconnects. Counts what the SERVER saw. */
export async function ghostPushScenario({ db, createCalendarPlanSyncBridge, createPlanAuthority, recoveredCapture }) {
  const app = makeFenceApp({ db, createPlanAuthority, createCalendarPlanSyncBridge, lookup: id => (id === 'bfence1' ? recoveredCapture : null) });
  const today = app.authority.current();
  app.state.online = false;
  app.authority.addItem({ destination: today, item: fencedFor(today) });
  app.state.online = true;
  const result = await app.calendarSync.pushPlan(SUN_ID);
  return {
    outcome: result.outcome,
    denied: db.denials.length,
    onServer: !!db.read(`rooms/uid_A/calendarPlanFences/${SUN_ID}/${FENCED_ID}`),
    stillLocal: !!app.calendarRepository.read(SUN)?.items?.some(i => i.id === FENCED_ID),
  };
}
