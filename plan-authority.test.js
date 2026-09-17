// plan-authority.test.js
//
// Single Plan Authority V1 — the access layer every planning consumer routes
// through. Everything runs against in-memory storage and an in-memory fake
// Firebase room ref: no real project, no network, no production data.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlanAuthority, operationalCarriedItemId, carryItemIdFor, routineAnchorInstant, noonAnchorInstant } from './plan-authority.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { createOperationalPlanSyncBridge } from './operational-plan-sync.js';
import { planningStreak, carriedItemId } from './plan-tomorrow-model.js';

const MANILA = 'Asia/Manila';   // UTC+8, no DST
const NEW_YORK = 'America/New_York'; // DST, for anomaly coverage

const at = (dateStr, hhmm, zoneOffset = '+08:00') => Date.parse(`${dateStr}T${hhmm}:00${zoneOffset}`);
const manila = (dateStr, hhmm) => at(dateStr, hhmm, '+08:00');

const D_PREV = '2026-09-15';
const D = '2026-09-16';
const D_NEXT = '2026-09-17';

const memory = (seed = null) => {
  const map = new Map();
  if (seed) Object.entries(seed).forEach(([k, v]) => map.set(k, v));
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

/** index.html's plans[dateKey] store, reached only through the same accessors
 *  the production wiring injects. */
function legacyStore(seed = {}) {
  const plans = JSON.parse(JSON.stringify(seed));
  return {
    plans,
    confirmations: [],
    record: dateKey => plans[dateKey] || null,
    rawItems: dateKey => (plans[dateKey]?.items || []).map(item => ({ ...item })),
    saveItems(dateKey, items) {
      plans[dateKey] = { ...(plans[dateKey] || {}), items, updatedAt: 1000, updatedBy: 'legacy-device' };
    },
    confirm(input) {
      this.confirmations.push(input);
      const preparation = {
        schemaVersion: 1, targetDate: input.targetDate, timezone: MANILA,
        firstPreparedAt: input.now || 1000, firstPreparedBy: 'legacy-device', firstPreparedMode: input.mode,
        lastPreparedAt: input.now || 1000, lastPreparedMode: input.mode, updatedBy: 'legacy-device',
        intentionalBlank: input.intentionalBlank === true,
        routineInstanceIds: input.routineInstanceIds, oneOffItemIds: input.items.filter(i => !i.deleted).map(i => i.id),
      };
      plans[input.targetDate] = { ...(plans[input.targetDate] || {}), items: input.items, preparation, updatedAt: input.now || 1000 };
      return { localSaved: true, syncPromise: Promise.resolve(false) };
    },
    allPlans: () => plans,
    earliestPlanDate() {
      const keys = Object.keys(plans).sort();
      return keys.length ? keys[0] : null;
    },
  };
}

function fakeRoomRef(initial = {}) {
  const root = { value: initial };
  const listeners = new Map();
  const get = path => path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  function set(path, value) {
    const segs = path.split('/').filter(Boolean);
    let node = root.value;
    for (let i = 0; i < segs.length - 1; i++) {
      if (typeof node[segs[i]] !== 'object' || node[segs[i]] === null) node[segs[i]] = {};
      node = node[segs[i]];
    }
    node[segs[segs.length - 1]] = value;
    for (let i = segs.length; i >= 0; i--) (listeners.get(segs.slice(0, i).join('/')) || []).forEach(fn => fn({ val: () => get(segs.slice(0, i).join('/')) ?? null }));
  }
  function makeRef(path) {
    return {
      path,
      child(seg) { return makeRef(path ? `${path}/${seg}` : seg); },
      on(_event, fn) {
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(fn);
        fn({ val: () => get(path) ?? null });
      },
      off() { listeners.delete(path); },
      val: () => get(path) ?? null,
      transaction(updateFn) {
        const current = get(path) ?? null;
        const nextValue = updateFn(current);
        if (nextValue === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => current } });
        set(path, nextValue);
        return Promise.resolve({ committed: true, snapshot: { val: () => nextValue } });
      },
    };
  }
  return makeRef('');
}

let seq = 0;

/** One device: boundary + operational repositories, a legacy store, an injected
 *  clock, and the authority layer on top — the same composition index.html
 *  builds in the browser. */
function makeApp({ clock = manila(D, '08:00'), legacy = legacyStore(), storage = memory(), planStorage = memory(), roomRef = null, accountTimezone = MANILA, deviceId = 'device-a' } = {}) {
  const nowRef = { value: clock };
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage, idGenerator: () => `rev-${++seq}` });
  const planRepository = createOperationalPlanRepository({ storage: planStorage });
  const planSync = roomRef ? createOperationalPlanSyncBridge({ repository: planRepository, getRoomRef: () => roomRef }) : null;
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository, planSync,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => nowRef.value,
    deviceId: () => deviceId,
    fallbackTimezone: () => accountTimezone,
  });
  const authority = createPlanAuthority({
    live, legacy,
    now: () => nowRef.value,
    accountTimezone: () => accountTimezone,
  });
  return { authority, live, legacy, planRepository, boundaryRepository, setNow: v => { nowRef.value = v; }, now: () => nowRef.value };
}

const item = (id, task, extra = {}) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'device-a', ...extra });

const routineInstance = (id, date, routine, timezone = MANILA) => ({ id: JSON.stringify([id, date]), routineId: id, date, timezone, routine: { id, mode: 'anytime', enabled: true, ...routine } });

// ═══════════════════════════════════════════════════════════════════════════
// 1. Legacy account — byte-for-byte the existing behavior (HARD REQUIREMENT)
// ═══════════════════════════════════════════════════════════════════════════

test('a never-enabled account resolves plain calendar days and touches no operational storage', () => {
  const planStorage = memory();
  const app = makeApp({ planStorage });
  const current = app.authority.current();
  const upcoming = app.authority.upcoming();

  assert.deepEqual([current.store, current.id], ['legacy', D]);
  assert.deepEqual([upcoming.store, upcoming.id], ['legacy', D_NEXT]);
  assert.equal(current.legacy, true);
  app.authority.saveItems(current, [item('p1', 'Write')]);
  assert.deepEqual(app.legacy.rawItems(D).map(i => i.task), ['Write']);
  assert.equal(planStorage.getItem('ta3-operational-plans-v1'), null, 'no operational record is created by using the app');
  assert.equal(app.boundaryRepository.status().status, 'absent', 'no boundary revision is created either');
});

test('a never-enabled account gets the existing planningStreak function, not a reimplementation', () => {
  const plans = {
    '2026-09-14': { items: [item('a', 'A')], preparation: { schemaVersion: 1, targetDate: '2026-09-14', timezone: MANILA, firstPreparedAt: manila('2026-09-13', '20:00'), firstPreparedMode: 'normal', lastPreparedAt: manila('2026-09-13', '20:00'), lastPreparedMode: 'normal', updatedBy: 'd', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['a'] } },
    '2026-09-15': { items: [item('b', 'B')], preparation: { schemaVersion: 1, targetDate: '2026-09-15', timezone: MANILA, firstPreparedAt: manila('2026-09-14', '20:00'), firstPreparedMode: 'normal', lastPreparedAt: manila('2026-09-14', '20:00'), lastPreparedMode: 'normal', updatedBy: 'd', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['b'] } },
  };
  const app = makeApp({ legacy: legacyStore(plans) });
  assert.deepEqual(app.authority.streak(), planningStreak(plans, manila(D, '08:00'), MANILA));
});

test('a never-enabled account sees exactly one authoritative day for a calendar date', () => {
  const app = makeApp();
  const days = app.authority.daysOverlappingCalendarDate(D);
  assert.equal(days.length, 1);
  assert.deepEqual([days[0].store, days[0].id], ['legacy', D]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Authority routing — never by store contents
// ═══════════════════════════════════════════════════════════════════════════

function graveyardApp(options = {}) {
  const app = makeApp({ clock: manila(D, '08:00'), ...options });
  app.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  return app;
}

test('at 08:00 with an 18:00 boundary: current is the legacy-governed day, upcoming is the 18:00 personal day', () => {
  const app = graveyardApp();
  const current = app.authority.current();
  const upcoming = app.authority.upcoming();
  assert.equal(current.store, 'legacy', 'the day already in progress is not retroactively regrouped');
  assert.equal(current.dateKey, D);
  assert.equal(upcoming.store, 'operational');
  assert.equal(upcoming.startMs, manila(D, '18:00'));
  assert.equal(upcoming.endMs, manila(D_NEXT, '18:00'));
});

test('authority ignores which store holds data — an empty operational day still owns the day', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const current = app.authority.current();
  assert.equal(current.store, 'operational');
  assert.deepEqual(app.authority.items(current), [], 'empty, and still authoritative');
  // Even with a populated legacy record for the same calendar date, authority does not move.
  app.legacy.saveItems(D, [item('legacy-1', 'Legacy leftover')]);
  assert.equal(app.authority.current().store, 'operational');
  assert.deepEqual(app.authority.items(app.authority.current()), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Graveyard acceptance — one plan, no copy, across the rollover
// ═══════════════════════════════════════════════════════════════════════════

test('graveyard: prepare the upcoming 18:00 day at 08:00; it becomes current at 18:00 and survives midnight', () => {
  const app = graveyardApp();
  const upcoming = app.authority.upcoming();
  const items = [item('n1', 'Night shift block', { when: '22:00' }), item('n2', 'Post-midnight review', { when: '01:00' })];
  app.authority.saveItems(upcoming, items);
  const result = app.authority.confirmPreparation(upcoming, { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  assert.equal(result.localSaved, true);

  const prepared = app.authority.preparedState(upcoming);
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.consistency, 'ahead', 'prepared before the personal day began');
  assert.equal(prepared.readyNow, true);
  assert.equal(app.legacy.record(D_NEXT), null, 'nothing was written to the legacy store');

  // 18:00 — the SAME record is now current. No migration, no copy.
  app.setNow(manila(D, '18:00'));
  const current = app.authority.current();
  assert.equal(current.id, upcoming.id, 'same identity, not a new day');
  assert.deepEqual(app.authority.items(current).map(i => i.task), ['Night shift block', 'Post-midnight review']);
  assert.equal(app.authority.upcoming().id !== current.id, true);
  assert.deepEqual(app.authority.items(app.authority.upcoming()), [], 'the next personal day starts genuinely empty');

  // 00:30 — midnight must not rotate anything.
  app.setNow(manila(D_NEXT, '00:30'));
  assert.equal(app.authority.current().id, current.id);
  assert.deepEqual(app.authority.items(app.authority.current()).map(i => i.task), ['Night shift block', 'Post-midnight review']);

  // 18:00 D+1 — the next personal day begins.
  app.setNow(manila(D_NEXT, '18:00'));
  assert.notEqual(app.authority.current().id, current.id);
  assert.equal(app.authority.current().startMs, manila(D_NEXT, '18:00'));
});

test('a 01:00 item is valid on an 18:00 personal day but rejected by the legacy calendar validator', () => {
  const app = graveyardApp();
  const upcoming = app.authority.upcoming();
  assert.equal(app.authority.validateItem(upcoming, { when: '23:00', durationMinutes: 120 }).ok, true, 'cross-midnight range is ordinary here');
  assert.equal(app.authority.validateItem(app.authority.legacyTarget(D), { when: '23:00', durationMinutes: 120 }).ok, false, 'legacy days keep the midnight clamp exactly');
  assert.equal(app.authority.validateItem(upcoming, { when: '01:00' }).ok, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Planning Streak on authority
// ═══════════════════════════════════════════════════════════════════════════

test('planning streak credits the personal day prepared before it began, and never counts both stores', () => {
  const app = graveyardApp();
  const upcoming = app.authority.upcoming();
  const items = [item('n1', 'Night shift')];
  app.authority.saveItems(upcoming, items);
  app.authority.confirmPreparation(upcoming, { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });

  const streak = app.authority.streak();
  assert.equal(streak.todayEarned, true, 'today earned its habit by preparing the upcoming personal day');
  assert.equal(streak.current, 1);

  // A stale legacy plan for the same calendar date must not add a second credit.
  app.legacy.confirm({ targetDate: D_NEXT, items: [item('legacy', 'Legacy')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [], now: manila(D, '08:00') });
  app.authority.invalidate();
  assert.equal(app.authority.streak().current, 1, 'still one day — credit is per authoritative day, not per store');
});

test('an unprepared upcoming personal day earns nothing, and a late preparation is not "ahead"', () => {
  const app = graveyardApp();
  assert.equal(app.authority.streak().current, 0);
  app.setNow(manila(D, '19:00')); // already inside the personal day
  const current = app.authority.current();
  const items = [item('late', 'Late plan')];
  app.authority.saveItems(current, items);
  app.authority.confirmPreparation(current, { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  assert.equal(app.authority.consistency(current), 'late');
  assert.equal(app.authority.habitEarned(app.authority.containing(manila(D, '10:00'))), false, 'a late plan never earns the previous day its habit');
});

test('a streak carries across the legacy -> operational transition instead of resetting', () => {
  // Legacy days: 09-14 and 09-15 both prepared ahead.
  const preparation = (date, preparedAt) => ({ schemaVersion: 1, targetDate: date, timezone: MANILA, firstPreparedAt: preparedAt, firstPreparedMode: 'normal', lastPreparedAt: preparedAt, lastPreparedMode: 'normal', updatedBy: 'd', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: [`i-${date}`] });
  const plans = {
    '2026-09-15': { items: [item('i-2026-09-15', 'B')], preparation: preparation('2026-09-15', manila('2026-09-14', '20:00')) },
    '2026-09-16': { items: [item('i-2026-09-16', 'C')], preparation: preparation('2026-09-16', manila('2026-09-15', '20:00')) },
  };
  const app = makeApp({ clock: manila(D, '08:00'), legacy: legacyStore(plans) });
  app.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  const upcoming = app.authority.upcoming();
  const items = [item('n1', 'Night shift')];
  app.authority.saveItems(upcoming, items);
  app.authority.confirmPreparation(upcoming, { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });

  const streak = app.authority.streak();
  assert.equal(streak.todayEarned, true);
  assert.equal(streak.current, 3, '09-14 (legacy) + 09-15 (legacy) + today across the transition');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Decision A — routine ownership
// ═══════════════════════════════════════════════════════════════════════════

test('a timed routine is owned by the personal day containing its own start instant', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const current = app.authority.current(); // 18:00 D -> 18:00 D+1
  const morning = routineInstance('r-gym', D_NEXT, { mode: 'exact', time: '07:00' });
  const evening = routineInstance('r-read', D_NEXT, { mode: 'exact', time: '19:00' });
  assert.equal(app.authority.routineTarget(morning).target.id, current.id, '07:00 the next calendar morning is inside this personal day');
  assert.notEqual(app.authority.routineTarget(evening).target.id, current.id, '19:00 D+1 is already the next personal day');
  const { rows } = app.authority.routinesForTarget(current, [morning, evening]);
  assert.deepEqual(rows.map(r => r.routineId), ['r-gym']);
});

test('a windowed routine is owned by the day containing its window START', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const current = app.authority.current();
  const straddling = routineInstance('r-win', D_NEXT, { mode: 'window', time: '17:00', endTime: '19:00' });
  assert.equal(app.authority.routineTarget(straddling).target.id, current.id, '17:00 start belongs to the day in progress');
});

test('an untimed routine is owned via the 12:00 noon anchor on its own calendar date', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const current = app.authority.current(); // 18:00 D -> 18:00 D+1
  const anytime = routineInstance('r-any', D_NEXT, { mode: 'anytime' });
  const cue = routineInstance('r-cue', D_NEXT, { mode: 'cue', cue: 'after coffee' });
  const anchor = routineAnchorInstant(anytime);
  assert.equal(anchor.anchor, 'noon');
  assert.equal(anchor.instantMs, manila(D_NEXT, '12:00'));
  assert.equal(app.authority.routineTarget(anytime).target.id, current.id, 'noon D+1 falls inside the 18:00 D personal day');
  assert.equal(app.authority.routineTarget(cue).target.id, current.id);
  // The SAME untimed routine on the previous calendar date belongs to the previous personal day.
  assert.notEqual(app.authority.routineTarget(routineInstance('r-any', D, { mode: 'anytime' })).target.id, current.id);
});

for (const [boundary, date, expectedStart] of [
  ['06:00', D_NEXT, manila(D_NEXT, '06:00')],
  ['18:00', D_NEXT, manila(D, '18:00')],
  ['23:30', D_NEXT, manila(D_NEXT, '23:30') - 24 * 3600000],
]) {
  test(`noon anchor under a ${boundary} boundary puts ${date}'s untimed routine in the day starting ${new Date(expectedStart).toISOString()}`, () => {
    const app = makeApp({ clock: manila(D_PREV, '02:00') });
    app.live.proposeBoundary({ boundaryTime: boundary, timezone: MANILA });
    app.setNow(manila(D_NEXT, '12:00'));
    const resolved = app.authority.routineTarget(routineInstance('r-any', date, { mode: 'anytime' }));
    assert.equal(resolved.ok, true);
    assert.equal(resolved.target.startMs, expectedStart);
    assert.ok(resolved.instantMs >= resolved.target.startMs && resolved.instantMs < resolved.target.endMs, 'the anchor really is inside the day it was assigned to');
  });
}

test('noon-boundary tie: a 12:00 anchor belongs to the personal day that STARTS at 12:00, no special case', () => {
  const app = makeApp({ clock: manila(D_PREV, '02:00') });
  app.live.proposeBoundary({ boundaryTime: '12:00', timezone: MANILA });
  app.setNow(manila(D_NEXT, '13:00'));
  const resolved = app.authority.routineTarget(routineInstance('r-any', D_NEXT, { mode: 'anytime' }));
  assert.equal(resolved.instantMs, manila(D_NEXT, '12:00'));
  assert.equal(resolved.target.startMs, manila(D_NEXT, '12:00'), 'start-inclusive, end-exclusive — the day beginning at the anchor owns it');
});

test('the routine subsystem timezone owns the date, even when the boundary runs in another zone', () => {
  // Boundary in Manila; routines still generated in New York (the account/work timezone).
  const app = makeApp({ clock: manila(D_PREV, '02:00'), accountTimezone: NEW_YORK });
  app.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  app.setNow(manila(D_NEXT, '02:00'));
  const instance = routineInstance('r-any', D, { mode: 'anytime' }, NEW_YORK);
  const anchor = routineAnchorInstant(instance);
  assert.equal(anchor.instantMs, at(D, '12:00', '-04:00'), 'noon NEW YORK, not noon Manila');
  const resolved = app.authority.routineTarget(instance);
  assert.ok(resolved.ok);
  assert.ok(resolved.instantMs >= resolved.target.startMs && resolved.instantMs < resolved.target.endMs);
});

test('a civil-time anomaly is reported, never guessed', () => {
  // 2026-03-08 02:30 America/New_York does not exist (spring forward).
  const nonexistent = routineAnchorInstant(routineInstance('r-x', '2026-03-08', { mode: 'exact', time: '02:30' }, NEW_YORK));
  assert.equal(nonexistent.ok, false);
  assert.equal(nonexistent.reason, 'nonexistent');
  // 2026-11-01 01:30 America/New_York happens twice (fall back).
  const ambiguous = routineAnchorInstant(routineInstance('r-y', '2026-11-01', { mode: 'exact', time: '01:30' }, NEW_YORK));
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'ambiguous');
  // Noon is unaffected on both dates, so untimed routines still place cleanly.
  assert.equal(noonAnchorInstant('2026-03-08', NEW_YORK).ok, true);
  assert.equal(noonAnchorInstant('2026-11-01', NEW_YORK).ok, true);
});

test('an unplaceable routine is surfaced separately, never silently dropped into a day', () => {
  const app = makeApp({ clock: Date.parse('2026-03-08T20:00:00Z'), accountTimezone: NEW_YORK });
  app.live.proposeBoundary({ boundaryTime: '18:00', timezone: NEW_YORK });
  app.setNow(Date.parse('2026-03-09T00:00:00Z'));
  const broken = routineInstance('r-x', '2026-03-08', { mode: 'exact', time: '02:30' }, NEW_YORK);
  const { rows, unplaceable } = app.authority.routinesForTarget(app.authority.current(), [broken]);
  assert.deepEqual(rows, []);
  assert.equal(unplaceable.length, 1);
  assert.equal(unplaceable[0].reason, 'nonexistent');
});

test('a legacy-governed day keeps the plain calendar routine rule', () => {
  const app = graveyardApp(); // 08:00, current day still legacy
  const current = app.authority.current();
  const today = routineInstance('r-any', D, { mode: 'anytime' });
  const tomorrow = routineInstance('r-any', D_NEXT, { mode: 'anytime' });
  const { rows } = app.authority.routinesForTarget(current, [today, tomorrow]);
  assert.deepEqual(rows.map(r => r.date), [D]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Decision B — calendar-date overlap projection
// ═══════════════════════════════════════════════════════════════════════════

test('a calendar date covered by an 18:00 boundary projects to the TWO personal days overlapping it', () => {
  const app = graveyardApp();
  app.setNow(manila(D_NEXT, '20:00'));
  const days = app.authority.daysOverlappingCalendarDate(D_NEXT);
  assert.equal(days.length, 2);
  assert.deepEqual(days.map(d => d.startMs), [manila(D, '18:00'), manila(D_NEXT, '18:00')]);
  assert.ok(days.every(d => d.store === 'operational'));
  assert.equal(new Set(days.map(d => d.id)).size, 2, 'two distinct identities — never merged into one plan for the date');
});

test('the transition calendar date projects to the legacy day AND the first personal day', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '20:00'));
  const days = app.authority.daysOverlappingCalendarDate(D);
  assert.equal(days.length, 2);
  assert.deepEqual(days.map(d => d.store), ['legacy', 'operational']);
  assert.equal(days[0].dateKey, D);
  assert.equal(days[1].startMs, manila(D, '18:00'));
});

test('a 00:00 custom boundary still projects to exactly one day per calendar date (and stays operational)', () => {
  const app = makeApp({ clock: manila(D_PREV, '08:00') });
  app.live.proposeBoundary({ boundaryTime: '00:00', timezone: MANILA });
  app.setNow(manila(D_NEXT, '10:00'));
  const days = app.authority.daysOverlappingCalendarDate(D_NEXT);
  assert.equal(days.length, 1);
  assert.equal(days[0].store, 'operational', 'a custom 00:00 revision is operational, not a return to legacy');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Prepared Plans + boundary-change warning
// ═══════════════════════════════════════════════════════════════════════════

test('a prepared future day pushed out of reach by a boundary change stays discoverable under Prepared Plans', () => {
  const app = graveyardApp();
  const upcoming = app.authority.upcoming();
  const items = [item('n1', 'Night shift')];
  app.authority.saveItems(upcoming, items);
  app.authority.confirmPreparation(upcoming, { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  assert.deepEqual(app.authority.preparedPlans().map(p => p.id), [], 'while reachable it is NOT listed as a stray');

  // Warn BEFORE saving a change that would orphan it.
  const impact = app.authority.boundaryChangeImpact({ boundaryTime: '10:00', timezone: MANILA });
  assert.equal(impact.ok, true);
  assert.deepEqual(impact.orphaned.map(t => t.id), [upcoming.id], 'the affected prepared day is named');

  app.live.proposeBoundary({ boundaryTime: '10:00', timezone: MANILA });
  const stray = app.authority.preparedPlans();
  assert.equal(stray.length, 1);
  assert.equal(stray[0].id, upcoming.id);
  assert.deepEqual(stray[0].items.map(i => i.task), ['Night shift'], 'the plan is intact, byte for byte');
  assert.equal(stray[0].startMs, manila(D, '18:00'));
  assert.equal(stray[0].timezone, MANILA);
  assert.ok(stray[0].preparation, 'its preparation survives too');
  assert.notEqual(app.authority.upcoming().id, upcoming.id, 'and it was NOT moved into the replacement day');
  assert.deepEqual(app.authority.items(app.authority.upcoming()), [], 'nothing was copied forward');
});

test('a boundary change that keeps the prepared day reachable warns about nothing', () => {
  const app = graveyardApp();
  const upcoming = app.authority.upcoming();
  app.authority.saveItems(upcoming, [item('n1', 'Night shift')]);
  assert.deepEqual(app.authority.boundaryChangeImpact({ boundaryTime: '18:00', timezone: MANILA }).orphaned, []);
});

test('an empty future day is never reported as an orphaned prepared plan', () => {
  const app = graveyardApp();
  assert.deepEqual(app.authority.boundaryChangeImpact({ boundaryTime: '10:00', timezone: MANILA }).orphaned, []);
  app.live.proposeBoundary({ boundaryTime: '10:00', timezone: MANILA });
  assert.deepEqual(app.authority.preparedPlans(), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Carry-forward identity
// ═══════════════════════════════════════════════════════════════════════════

test('operational carry ids are deterministic, distinct from legacy ones, and never a coerced date', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const source = app.authority.current();
  const destination = app.authority.upcoming();
  const id = carryItemIdFor(source, 'p-abc', destination);
  assert.equal(id, operationalCarriedItemId(source.id, 'p-abc', destination.id));
  assert.equal(id, carryItemIdFor(source, 'p-abc', destination), 'stable across calls — and therefore across devices');
  assert.ok(id.startsWith('ocarry1|'));
  assert.notEqual(id, carriedItemId(D, 'p-abc'));
  assert.notEqual(carryItemIdFor(source, 'p-other', destination), id);
  assert.match(id, /odv1:/, 'built from operational identities, not a date');
});

test('on the transition day an item carries from the legacy day into the first personal day', () => {
  const app = graveyardApp(); // 08:00: current is legacy-governed, upcoming is operational
  const source = app.authority.current();
  const destination = app.authority.upcoming();
  assert.equal(source.store, 'legacy');
  const id = carryItemIdFor(source, 'p-abc', destination);
  assert.ok(id.startsWith('ocarry1|2026-09-16|p-abc|odv1:'), id);
  assert.equal(id, carryItemIdFor(source, 'p-abc', destination), 'deterministic across devices');
  assert.notEqual(id, carriedItemId(D, 'p-abc'), 'never mistaken for a legacy carry id');
});

test('carrying from a personal day into a calendar day is refused, not fudged', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const operational = app.authority.current();
  assert.equal(operational.store, 'operational');
  assert.throws(() => carryItemIdFor(operational, 'p-abc', app.authority.legacyTarget(D_NEXT)), /not supported/);
});

test('legacy carry ids are untouched for legacy days', () => {
  const app = makeApp();
  const source = app.authority.current();
  const destination = app.authority.upcoming();
  assert.equal(carryItemIdFor(source, 'p-abc', destination), carriedItemId(D, 'p-abc'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Authority-consistency matrix — every consumer question, one answer
// ═══════════════════════════════════════════════════════════════════════════

test('every consumer-facing question resolves to the SAME authoritative plan identity', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:30'));
  const current = app.authority.current();
  const items = [item('n1', 'Night shift', { when: '22:00' })];
  app.authority.saveItems(current, items);
  app.authority.confirmPreparation(current, { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });

  const answers = {
    editor: app.authority.current().id,
    byInstant: app.authority.containing(manila(D, '19:30')).id,
    afterMidnight: app.authority.containing(manila(D_NEXT, '00:30')).id,
    reconciliation: app.authority.containing(manila(D_NEXT, '02:00')).id,
    routineOwner: app.authority.routineTarget(routineInstance('r-any', D_NEXT, { mode: 'anytime' })).target.id,
    historyProjection: app.authority.daysOverlappingCalendarDate(D_NEXT)[0].id,
    preparedState: app.authority.preparedState(current).target.id,
  };
  const distinct = new Set(Object.values(answers));
  assert.equal(distinct.size, 1, `consumers disagreed: ${JSON.stringify(answers)}`);
  assert.equal([...distinct][0], current.id);
  // ...and the plan they each reach is the same record, read once from one store.
  assert.deepEqual(app.authority.items(app.authority.containing(manila(D_NEXT, '02:00'))).map(i => i.task), ['Night shift']);
  assert.equal(app.authority.record(current).preparation.targetOperationalDayId, current.id);
});

test('load order never changes authority: a cold read resolves what a warm one did', () => {
  const storage = memory();
  const planStorage = memory();
  const legacy = legacyStore();
  const warm = makeApp({ storage, planStorage, legacy });
  warm.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  warm.setNow(manila(D, '19:00'));
  const items = [item('n1', 'Night shift')];
  warm.authority.saveItems(warm.authority.current(), items);
  const warmId = warm.authority.current().id;

  const cold = makeApp({ storage, planStorage, legacy, clock: manila(D, '19:00') });
  assert.equal(cold.authority.current().id, warmId);
  assert.deepEqual(cold.authority.items(cold.authority.current()).map(i => i.task), ['Night shift']);
});
