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
import { createPersonalDayBoundarySyncBridge, DAY_BOUNDARY_REVISIONS_REMOTE_PATH } from './personal-day-boundary-sync.js';
import { planningStreak, carriedItemId, localPlanDate, mergeDatePlans } from './plan-tomorrow-model.js';
import { mergeOperationalPlanRecords } from './operational-plan-model.js';

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
        // Mirrors index.html's confirmPreparedDatePlan: preparation carries the TOP
        // PRIORITIES only (Planning Continuity V1). Identical for kind-less items.
        routineInstanceIds: input.routineInstanceIds, oneOffItemIds: input.items.filter(i => !i.deleted && i.kind !== 'task').map(i => i.id),
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
function makeApp({ clock = manila(D, '08:00'), legacy = legacyStore(), storage = memory(), planStorage = memory(), roomRef = null, accountTimezone = MANILA, deviceId = 'device-a', idPrefix = 'rev' } = {}) {
  const nowRef = { value: clock };
  const roomRefRef = { value: roomRef };
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage, idGenerator: () => `${idPrefix}-${++seq}` });
  const planRepository = createOperationalPlanRepository({ storage: planStorage });
  const planSync = createOperationalPlanSyncBridge({ repository: planRepository, getRoomRef: () => roomRefRef.value });
  const boundarySync = createPersonalDayBoundarySyncBridge({ repository: boundaryRepository, getRoomRef: () => roomRefRef.value });
  // A device that is in a room has heard the account's answer before its owner acts (the app
  // attaches on room join). Acting on a joined-but-unheard device is refused by design — it could
  // mint a legacy anchor that competes with the account's real one — so model the join: the
  // device heard whatever the account held at that moment.
  if (roomRef) boundarySync.handleRemoteSnapshot(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val());
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository, planSync, boundarySync,
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
  return {
    authority, live, legacy, planRepository, boundaryRepository, planSync, boundarySync,
    setNow: v => { nowRef.value = v; },
    now: () => nowRef.value,
    // Offline / reconnect are modeled exactly as the app experiences them: the
    // room ref is simply absent while offline, and appears on reconnect.
    goOffline: () => { roomRefRef.value = null; },
    goOnline: ref => { roomRefRef.value = ref; },
  };
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

test('item-centric date scheduling uses noon for untimed tasks and the exact entered time for timed tasks', () => {
  const app = graveyardApp();
  const untimed = app.authority.dayForScheduledDate('2026-09-23', '');
  const timed = app.authority.dayForScheduledDate('2026-09-23', '21:00');
  assert.equal(untimed.ok, true);
  assert.equal(timed.ok, true);
  assert.equal(untimed.anchor, 'noon');
  assert.equal(timed.anchor, 'time');
  assert.equal(untimed.target.startMs, manila('2026-09-22', '18:00'));
  assert.equal(timed.target.startMs, manila('2026-09-23', '18:00'));
  assert.equal(timed.instantMs, manila('2026-09-23', '21:00'));
});

for (const boundaryTime of ['00:00', '04:00', '12:00', '17:00', '18:00']) {
  test(`${boundaryTime} scheduling dates are the exact inverse for Today, Tomorrow, defaults, untimed edits, and timed items`, () => {
    const app = boundaryApp(boundaryTime);
    const current = app.authority.current();
    const next = app.authority.next(current);
    const boundaryHour = Number(boundaryTime.slice(0, 2));
    const after = `${String((boundaryHour + 1) % 24).padStart(2, '0')}:00`;
    const before = `${String((boundaryHour + 23) % 24).padStart(2, '0')}:00`;

    for (const target of [current, next]) {
      const dateOnly = app.authority.scheduledDateForTarget(target);
      assert.equal(app.authority.dayForScheduledDate(dateOnly).target.id, target.id, 'date-only inverse returns the same target');
      const expectedDate = boundaryHour <= 12
        ? localPlanDate(target.startMs, MANILA)
        : localPlanDate(target.endMs - 1, MANILA);
      assert.equal(dateOnly, expectedDate, 'Today/Tomorrow and an untimed edit use the noon-owned civil date');
      for (const when of [after, before]) {
        const date = app.authority.scheduledDateForTarget(target, when);
        const resolved = app.authority.dayForScheduledDate(date, when);
        assert.equal(resolved.ok, true);
        assert.equal(resolved.target.id, target.id, `${when} resolves back to the same My Day`);
      }
    }

    assert.notEqual(app.authority.scheduledDateForTarget(current), app.authority.scheduledDateForTarget(next), 'Tomorrow advances exactly one scheduling date');
  });
}

for (const boundaryTime of ['04:00', '18:00']) {
  test(`${boundaryTime} target-preserving clock entry searches the civil dates overlapping one My Day`, () => {
    const app = boundaryApp(boundaryTime);
    const target = app.authority.current();
    for (const [when, dateKey] of [['21:00', D], ['02:00', D_NEXT]]) {
      const resolved = app.authority.civilDateForTimeInTarget(target, when);
      assert.equal(resolved.ok, true);
      assert.equal(resolved.target.id, target.id);
      assert.equal(resolved.dateKey, dateKey);
      assert.equal(resolved.instantMs, manila(dateKey, when));
    }
    assert.equal(app.authority.civilDateForTimeInTarget(target, boundaryTime).instantMs, target.startMs, 'start is included');
  });
}

test('a truncated My Day remains editable when it has no date-only noon inverse', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  app.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA });
  const target = app.authority.current();
  assert.deepEqual([target.startMs, target.endMs], [manila(D, '18:00'), manila(D, '20:00')]);
  assert.equal(app.authority.scheduledDateForTarget(target), null);
  assert.equal(app.authority.civilDateForTimeInTarget(target, '18:00').instantMs, target.startMs, 'start is included');
  assert.equal(app.authority.civilDateForTimeInTarget(target, '19:00').dateKey, D);
  assert.equal(app.authority.civilDateForTimeInTarget(target, '20:00').reason, 'outside-target', 'end is excluded');
  assert.equal(app.authority.civilDateForTimeInTarget(target, '09:00').reason, 'outside-target');

  app.authority.addItem({ destination: target, item: item('truncated-id', 'Untimed') });
  const stamp = value => ({ ...value, updatedAt: (value.updatedAt || 0) + 1, updatedBy: 'device-a' });
  app.authority.updateItem({ sourceTarget: target, itemId: 'truncated-id', changes: { task: 'Renamed', kind: 'task' }, stamp });
  app.authority.updateItem({ sourceTarget: target, itemId: 'truncated-id', changes: { when: '19:00' }, stamp });
  assert.equal(app.authority.items(target)[0].when, '19:00');
  assert.throws(() => app.authority.updateItem({ sourceTarget: target, itemId: 'truncated-id', changes: { when: '09:00' }, stamp }), /outside this personal day/);
  app.authority.updateItem({ sourceTarget: target, itemId: 'truncated-id', changes: { when: '' }, stamp });
  assert.deepEqual({ task: app.authority.items(target)[0].task, kind: app.authority.items(target)[0].kind, when: app.authority.items(target)[0].when }, { task: 'Renamed', kind: 'task', when: '' });
});

test('target-local clock resolution refuses a repeated DST instant instead of guessing', () => {
  const app = makeApp({ accountTimezone: NEW_YORK });
  const target = {
    id: 'fall-back-day', store: 'operational', timezone: NEW_YORK,
    startMs: Date.parse('2026-11-01T00:00:00-04:00'),
    endMs: Date.parse('2026-11-02T00:00:00-05:00'),
  };
  const resolved = app.authority.civilDateForTimeInTarget(target, '01:30');
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'ambiguous');
  assert.equal(resolved.matches.length, 2);
});

test('ordinary Add refuses yesterday and weeks ago by authoritative interval end', () => {
  const app = makeApp({ clock: manila(D, '08:00') });
  const yesterday = app.authority.legacyTarget(D_PREV);
  const weeksAgo = app.authority.legacyTarget('2026-08-20');
  assert.throws(() => app.authority.addItem({ destination: yesterday, item: item('past-1', 'Yesterday') }), /Past My Days are history/);
  assert.throws(() => app.authority.addItem({ destination: weeksAgo, item: item('past-2', 'Weeks ago') }), /Past My Days are history/);
  assert.equal(app.legacy.record(D_PREV), null);
  assert.equal(app.legacy.record('2026-08-20'), null);
});

test('editing a current or future item into an ended day is refused without changing its source', () => {
  const app = makeApp({ clock: manila(D, '08:00') });
  const current = app.authority.current();
  const future = app.authority.next(current);
  const past = app.authority.legacyTarget(D_PREV);
  app.authority.saveItems(current, [item('current-id', 'Current')]);
  app.authority.saveItems(future, [item('future-id', 'Future')]);
  const stamp = value => ({ ...value, updatedAt: 2000, updatedBy: 'device-a' });
  assert.throws(() => app.authority.updateItem({ sourceTarget: current, itemId: 'current-id', destination: past, changes: { task: 'Moved' }, stamp }), /Past My Days are history/);
  assert.throws(() => app.authority.updateItem({ sourceTarget: future, itemId: 'future-id', destination: past, changes: { task: 'Moved' }, stamp }), /Past My Days are history/);
  assert.deepEqual(app.authority.items(current).map(value => value.task), ['Current']);
  assert.deepEqual(app.authority.items(future).map(value => value.task), ['Future']);
  assert.equal(app.legacy.record(D_PREV), null);
});

test('clearing time clears all range-only metadata in legacy and operational stores without changing id', () => {
  const legacyApp = makeApp({ clock: manila(D, '08:00') });
  const legacyTarget = legacyApp.authority.current();
  legacyApp.authority.saveItems(legacyTarget, [item('legacy-range', 'Legacy range', { when: '09:00', durationMinutes: 60, endClock: '10:00' })]);
  legacyApp.authority.updateItem({ sourceTarget: legacyTarget, itemId: 'legacy-range', changes: { when: '' }, stamp: value => ({ ...value, updatedAt: 2000, updatedBy: 'device-a' }) });
  const legacyItem = legacyApp.authority.items(legacyTarget)[0];
  assert.equal(legacyItem.id, 'legacy-range');
  assert.equal(legacyItem.when, '');
  assert.equal('durationMinutes' in legacyItem, false);
  assert.equal('endClock' in legacyItem, false);

  const operationalApp = graveyardApp();
  operationalApp.setNow(manila(D, '19:00'));
  const operationalTarget = operationalApp.authority.current();
  operationalApp.authority.saveItems(operationalTarget, [item('operational-range', 'Operational range', { when: '23:00', durationMinutes: 120, endClock: '01:00' })]);
  operationalApp.authority.updateItem({ sourceTarget: operationalTarget, itemId: 'operational-range', changes: { when: '' }, stamp: value => ({ ...value, updatedAt: 2000, updatedBy: 'device-a' }) });
  const operationalItem = operationalApp.authority.items(operationalTarget)[0];
  assert.equal(operationalItem.id, 'operational-range');
  assert.equal(operationalItem.when, '');
  assert.equal('durationMinutes' in operationalItem, false);
  assert.equal('endClock' in operationalItem, false);
});

test('previous and next move one authoritative My Day across the 18:00 boundary', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const current = app.authority.current();
  const previous = app.authority.previous(current);
  const next = app.authority.next(current);
  assert.equal(previous.endMs, current.startMs);
  assert.equal(next.startMs, current.endMs);
});

test('editing date/time/kind preserves the same item id and leaves one active copy', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const source = app.authority.current();
  const destination = app.authority.dayForScheduledDate('2026-09-23', '21:00').target;
  app.authority.saveItems(source, [item('stable-id', 'Draft proposal')]);
  const result = app.authority.updateItem({
    sourceTarget: source,
    itemId: 'stable-id',
    destination,
    changes: { task: 'Send proposal', when: '21:00', kind: 'task' },
    stamp: value => ({ ...value, updatedAt: 2000, updatedBy: 'device-a' }),
  });
  assert.equal(result.moved, true);
  assert.equal(result.item.id, 'stable-id');
  assert.deepEqual(app.authority.items(source), []);
  assert.deepEqual(app.authority.items(destination).map(value => [value.id, value.task, value.when, value.kind]), [
    ['stable-id', 'Send proposal', '21:00', 'task'],
  ]);
  assert.equal(app.authority.rawItems(source).find(value => value.id === 'stable-id').deleted, true);
});

for (const moveKind of ['legacy -> legacy', 'legacy -> operational', 'operational -> operational', 'operational -> legacy']) {
  test(`${moveKind} direct relocation keeps the immutable id in exactly one active location`, () => {
    let app;
    let source;
    let destination;
    if (moveKind === 'legacy -> legacy') {
      app = makeApp({ clock: manila(D, '08:00') });
      source = app.authority.current();
      destination = app.authority.next(source);
    } else {
      app = graveyardApp();
      if (moveKind === 'legacy -> operational') {
        source = app.authority.current();
        destination = app.authority.upcoming();
      } else if (moveKind === 'operational -> legacy') {
        source = app.authority.upcoming();
        destination = app.authority.current();
      } else {
        app.setNow(manila(D, '19:00'));
        source = app.authority.current();
        destination = app.authority.next(source);
      }
    }
    app.authority.saveItems(source, [item('same-id', 'Move me')]);
    app.authority.updateItem({
      sourceTarget: source,
      itemId: 'same-id',
      destination,
      changes: { task: 'Moved once' },
      stamp: value => ({ ...value, updatedAt: 2000, updatedBy: 'device-a' }),
    });
    assert.equal(app.authority.items(source).filter(value => value.id === 'same-id').length, 0);
    assert.deepEqual(app.authority.items(destination).filter(value => value.id === 'same-id').map(value => value.task), ['Moved once']);
  });
}

for (const moveKind of ['legacy -> operational', 'operational -> operational', 'operational -> legacy']) {
  test(`${moveKind} relocation defeats a later-timestamp stale source edit in both merge orders`, () => {
    const app = graveyardApp();
    let source;
    let destination;
    if (moveKind === 'legacy -> operational') {
      source = app.authority.current();
      destination = app.authority.upcoming();
    } else if (moveKind === 'operational -> legacy') {
      source = app.authority.upcoming();
      destination = app.authority.current();
    } else {
      app.setNow(manila(D, '19:00'));
      source = app.authority.current();
      destination = app.authority.next(source);
    }
    const original = item('race-id', 'Original');
    app.authority.saveItems(source, [original]);
    app.authority.updateItem({
      sourceTarget: source,
      itemId: original.id,
      destination,
      changes: { task: 'Canonical destination' },
      stamp: value => ({ ...value, updatedAt: 2000, updatedBy: 'device-a' }),
    });
    const tombstone = app.authority.rawItems(source).find(value => value.id === original.id);
    const staleEdit = { ...original, task: 'Offline stale edit', updatedAt: 999999, updatedBy: 'device-offline' };
    const movedRecord = { items: [tombstone], updatedAt: 2000, updatedBy: 'device-a' };
    const staleRecord = { items: [staleEdit], updatedAt: 999999, updatedBy: 'device-offline' };
    const merge = source.store === 'legacy'
      ? (a, b) => mergeDatePlans(a, b, source.dateKey)
      : (a, b) => mergeOperationalPlanRecords(a, b, source.id);
    const forward = merge(movedRecord, staleRecord);
    const reverse = merge(staleRecord, movedRecord);
    assert.deepEqual(forward, reverse);
    assert.equal(forward.items[0].deleted, true);
    assert.equal(forward.items[0].relocationRevision.toDayId, destination.id);
    app.authority.saveItems(source, forward.items);
    assert.equal(app.authority.items(source).length, 0);
    assert.deepEqual(app.authority.items(destination).map(value => value.task), ['Canonical destination']);
  });
}

test('concurrent explicit relocations choose one canonical destination, and a later explicit move supersedes both', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const source = app.authority.current();
  const destinationA = app.authority.next(source);
  const destinationB = app.authority.next(destinationA);
  const original = item('concurrent-id', 'Concurrent move');
  const revisionA = { schemaVersion: 1, sequence: 1, fromDayId: source.id, toDayId: destinationA.id, updatedBy: 'device-a', updatedAt: 2000 };
  const revisionB = { schemaVersion: 1, sequence: 1, fromDayId: source.id, toDayId: destinationB.id, updatedBy: 'device-z', updatedAt: 1500 };
  const candidateA = { ...original, task: 'Destination A', updatedAt: 2000, updatedBy: 'device-a', relocationRevision: revisionA };
  const candidateB = { ...original, task: 'Destination B', updatedAt: 1500, updatedBy: 'device-z', relocationRevision: revisionB };
  app.authority.saveItems(destinationA, [candidateA]);
  app.authority.saveItems(destinationB, [candidateB]);
  app.authority.saveItems(source, [{ ...original, deleted: true, movedToDayId: destinationB.id, updatedAt: 1500, updatedBy: 'device-z', relocationRevision: revisionB }]);

  assert.equal(app.authority.items(destinationA).length, 0, 'the deterministic equal-sequence loser is not active');
  assert.deepEqual(app.authority.items(destinationB).map(value => value.task), ['Destination B']);

  app.authority.updateItem({
    sourceTarget: destinationB,
    itemId: original.id,
    destination: source,
    changes: { task: 'Explicitly moved back' },
    stamp: value => ({ ...value, updatedAt: 3000, updatedBy: 'device-z' }),
  });
  assert.deepEqual(app.authority.items(source).map(value => value.task), ['Explicitly moved back']);
  assert.equal(app.authority.items(destinationA).length, 0);
  assert.equal(app.authority.items(destinationB).length, 0);
  assert.equal(app.authority.items(source)[0].relocationRevision.sequence, 2);
});

test('editing an Other Task into a fourth priority is refused without changing it', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const target = app.authority.current();
  app.authority.saveItems(target, [item('p1', 'One'), item('p2', 'Two'), item('p3', 'Three'), item('task-4', 'Four', { kind: 'task' })]);
  assert.throws(() => app.authority.updateItem({
    sourceTarget: target,
    itemId: 'task-4',
    changes: { kind: 'priority' },
    stamp: value => ({ ...value, updatedAt: 2000, updatedBy: 'device-a' }),
  }), /Top 3 is already full/);
  assert.equal(app.authority.items(target).find(value => value.id === 'task-4').kind, 'task');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Authority routing — never by store contents
// ═══════════════════════════════════════════════════════════════════════════

function graveyardApp(options = {}) {
  const app = makeApp({ clock: manila(D, '08:00'), ...options });
  app.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  return app;
}

function boundaryApp(boundaryTime) {
  const app = makeApp({ clock: manila(D_PREV, '01:00') });
  app.live.proposeBoundary({ boundaryTime, timezone: MANILA });
  const hour = Number(boundaryTime.slice(0, 2));
  app.setNow(manila(D, `${String((hour + 1) % 24).padStart(2, '0')}:00`));
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

test('carrying forward across personal days converges on ONE item across devices', () => {
  const roomRef = fakeRoomRef();
  const a = graveyardApp({ roomRef, deviceId: 'device-a', idPrefix: 'a' });
  a.setNow(manila(D, '19:00'));
  const source = a.authority.current();
  const destination = a.authority.upcoming();
  const unfinished = item('p-unfinished', 'Unfinished work');
  a.authority.saveItems(source, [unfinished]);

  // Two devices independently carry the same unfinished item forward.
  const carryId = carryItemIdFor(source, unfinished.id, destination);
  const carriedOnA = { ...item(carryId, 'Unfinished work', { carriedFromId: unfinished.id }), updatedAt: manila(D, '19:05'), updatedBy: 'device-a' };
  const carriedOnB = { ...item(carryId, 'Unfinished work', { carriedFromId: unfinished.id }), updatedAt: manila(D, '19:06'), updatedBy: 'device-b' };
  a.authority.saveItems(destination, [carriedOnA]);
  const merged = mergeOperationalPlanRecords(
    { items: [carriedOnA], updatedAt: manila(D, '19:05') },
    { items: [carriedOnB], updatedAt: manila(D, '19:06') },
    destination.id,
  );
  assert.equal(merged.items.length, 1, 'the deterministic id collapses both carries into one item');
  assert.equal(merged.items[0].id, carryId);
  assert.equal(a.authority.items(source).length, 1, 'and the source day keeps its own item, unmoved');
});

test('legacy carry ids are untouched for legacy days', () => {
  const app = makeApp();
  const source = app.authority.current();
  const destination = app.authority.upcoming();
  assert.equal(carryItemIdFor(source, 'p-abc', destination), carriedItemId(D, 'p-abc'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Boundary-adjustment chaos
// ═══════════════════════════════════════════════════════════════════════════

test('18:00 -> 20:00 changed BEFORE the new boundary: today is truncated, the plan stays where it was prepared', () => {
  const app = graveyardApp();
  const upcoming = app.authority.upcoming();
  app.authority.saveItems(upcoming, [item('n1', 'Night shift')]);

  app.setNow(manila(D, '19:00')); // inside the 18:00 day, before 20:00
  app.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA });
  const current = app.authority.current();
  assert.equal(current.id, upcoming.id, 'the day in progress keeps its identity');
  assert.equal(current.endMs, manila(D, '20:00'), 'and is truncated at the new boundary, not extended');
  assert.deepEqual(app.authority.items(current).map(i => i.task), ['Night shift'], 'its plan is untouched');
  assert.equal(app.authority.upcoming().startMs, manila(D, '20:00'));
});

test('18:00 -> 20:00 changed AFTER the new boundary passes activates the next day, and nothing is orphaned', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '21:00'));
  const before = app.authority.current();
  app.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA });
  assert.equal(app.authority.current().id, before.id, 'the day in progress is not re-cut retroactively');
  // 20:00 has already passed today, so the new rule activates at 20:00 TOMORROW.
  // The day starting 18:00 tomorrow is therefore still governed by the 18:00
  // revision and is simply truncated when the new one takes over.
  const upcoming = app.authority.upcoming();
  assert.equal(upcoming.startMs, manila(D_NEXT, '18:00'));
  assert.equal(upcoming.endMs, manila(D_NEXT, '20:00'));
  assert.equal(app.authority.next(upcoming).startMs, manila(D_NEXT, '20:00'), 'and the 20:00 rule owns everything after that');
  assert.deepEqual(app.authority.preparedPlans(), []);
});

test('a timezone change appends a revision and never reinterprets earlier days', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const before = app.authority.current();
  const beforeInterval = [before.startMs, before.endMs];
  app.live.proposeBoundary({ boundaryTime: '18:00', timezone: NEW_YORK });
  const after = app.authority.current();
  assert.equal(after.id, before.id);
  assert.deepEqual([after.startMs, after.endMs], [beforeInterval[0], after.endMs], 'the day it started in is unchanged');
  assert.equal(after.timezone, MANILA, 'a past day keeps its own historical timezone');
  assert.equal(app.authority.upcoming().timezone, NEW_YORK, 'only the upcoming day moves to the new zone');
});

test('time AND timezone changed together is a single new revision with both facts', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  app.live.proposeBoundary({ boundaryTime: '06:00', timezone: NEW_YORK });
  const upcoming = app.authority.upcoming();
  assert.equal(upcoming.boundaryTime, '06:00');
  assert.equal(upcoming.timezone, NEW_YORK);
  assert.equal(app.boundaryRepository.status().revisions.length, 3, 'anchor + 18:00 + the combined change');
});

test('custom 00:00 is operational, never a return to legacy authority', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  app.live.proposeBoundary({ boundaryTime: '00:00', timezone: MANILA });
  app.setNow(manila(D_NEXT, '02:00'));
  const current = app.authority.current();
  assert.equal(current.store, 'operational');
  assert.equal(current.startMs, manila(D_NEXT, '00:00'));
});

test('a historical personal day is reconciled under the revision that governed IT, not the current one', () => {
  const app = graveyardApp();
  app.setNow(manila(D, '19:00'));
  const historical = app.authority.current();               // 18:00 D -> 18:00 D+1
  const items = [
    item('h1', 'Historical work', { done: true, doneAt: manila(D, '20:00') }),
    item('h2', 'Still open'), // a plan of only-completed items is not confirmable
  ];
  app.authority.saveItems(historical, items);
  app.authority.confirmPreparation(historical, { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });

  // Days later the owner moves their boundary to 06:00.
  app.setNow(manila(D_NEXT, '19:00'));
  app.live.proposeBoundary({ boundaryTime: '06:00', timezone: MANILA });
  app.setNow(Date.parse('2026-09-20T12:00:00+08:00'));

  // Re-resolving that past instant still yields the SAME day, with the same
  // interval and the same plan — history is not re-cut under the new rule.
  const reresolved = app.authority.containing(manila(D, '20:00'));
  assert.equal(reresolved.id, historical.id);
  assert.deepEqual([reresolved.startMs, reresolved.endMs], [historical.startMs, historical.endMs]);
  assert.equal(reresolved.boundaryTime, '18:00');
  assert.deepEqual(app.authority.items(reresolved).map(i => i.task), ['Historical work', 'Still open']);
  // And its reconciliation verdict is judged against ITS OWN start instant.
  assert.equal(app.authority.classifyItemActual(reresolved, app.authority.rawItems(reresolved)[0], { trackedMinutes: 0, preparedAt: 0 }), 'done');
  assert.equal(app.authority.classifyItemActual(reresolved, { ...items[0], doneAt: historical.startMs - 60000 }, { trackedMinutes: 0, preparedAt: 0 }), 'done-early');
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Offline, reconnect, multi-device, fresh device
// ═══════════════════════════════════════════════════════════════════════════

test('offline through a rollover: the plan is written locally and pushed on reconnect', async () => {
  const roomRef = fakeRoomRef();
  const app = graveyardApp({ roomRef });
  app.goOffline();
  const upcoming = app.authority.upcoming();
  const items = [item('n1', 'Night shift')];
  app.authority.saveItems(upcoming, items);
  app.authority.confirmPreparation(upcoming, { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  assert.deepEqual(app.authority.items(upcoming).map(i => i.task), ['Night shift'], 'local write succeeds offline');

  // The boundary rolls over while still offline.
  app.setNow(manila(D, '18:30'));
  app.live.tick();
  assert.equal(app.authority.current().id, upcoming.id);

  app.goOnline(roomRef);
  app.live.pushAllLocal();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const remote = roomRef.child('operationalPlans').val();
  assert.ok(remote && Object.keys(remote).length === 1, 'reconnect pushed the plan');
});

test('multi-device: two devices editing the same personal day converge per item', async () => {
  const roomRef = fakeRoomRef();
  const a = graveyardApp({ roomRef, deviceId: 'device-a', idPrefix: 'a' });
  a.setNow(manila(D, '19:00'));
  a.live.attachLiveDays();
  const shared = a.authority.current();

  // Device B starts empty and learns the boundary from the room, like a real
  // second device would.
  const b = makeApp({ roomRef, clock: manila(D, '19:00'), deviceId: 'device-b', idPrefix: 'b' });
  b.live.attachLiveDays();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(b.authority.enabled(), true, 'B learned the boundary from remote');

  a.authority.saveItems(shared, [item('p-a', 'From A', { updatedAt: manila(D, '19:01'), updatedBy: 'device-a' })]);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const onB = b.authority.items(b.authority.current());
  assert.deepEqual(onB.map(i => i.task), ['From A'], 'B sees A\'s item live');

  b.authority.saveItems(b.authority.current(), [...onB, item('p-b', 'From B', { updatedAt: manila(D, '19:02'), updatedBy: 'device-b' })]);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(a.authority.items(shared).map(i => i.task).sort(), ['From A', 'From B'], 'and both survive on A — per-item merge, no clobber');
});

test('a fresh device reconstructs the same authority from remote alone', async () => {
  const roomRef = fakeRoomRef();
  const a = graveyardApp({ roomRef });
  a.setNow(manila(D, '19:00'));
  a.live.attachLiveDays();
  const items = [item('n1', 'Night shift')];
  a.authority.saveItems(a.authority.current(), items);
  a.authority.confirmPreparation(a.authority.current(), { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Nothing local at all — a brand new device joining the same room.
  const fresh = makeApp({ roomRef, clock: manila(D, '19:30'), deviceId: 'device-fresh', idPrefix: 'f' });
  fresh.live.attachLiveDays();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(fresh.authority.enabled(), true, 'it learns the boundary from remote');
  assert.equal(fresh.authority.current().id, a.authority.current().id);
  assert.deepEqual(fresh.authority.items(fresh.authority.current()).map(i => i.task), ['Night shift']);
  assert.equal(fresh.authority.preparedState(fresh.authority.current()).prepared, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Long histories — `best` is exact over available history, never capped
// ═══════════════════════════════════════════════════════════════════════════
//
// A real account's visible historical truth must not depend on how far back a
// traversal happens to be willing to walk. These build genuine multi-hundred-day
// histories in the same stores the app uses and assert exact numbers.

const REV_ID = 'r-1800';
const addDays = (dateStr, amount) => new Date(Date.parse(`${dateStr}T12:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
const opDayId = dateStr => `odv1:${REV_ID}:${MANILA}:${dateStr}`;

/** An 18:00 Manila boundary that became effective at 18:00 on `startDate`. */
function boundaryHistoryStore(startDate) {
  return JSON.stringify({ schemaVersion: 1, revisions: {
    'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: null },
    [REV_ID]: { id: REV_ID, boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: manila(startDate, '18:00') },
  } });
}

/** A prepared operational day: one real priority, confirmed an hour before that
 *  personal day began (so it is 'ahead'). */
function preparedOperationalRecord(dateStr) {
  const startMs = manila(dateStr, '18:00');
  const preparedAt = startMs - 3600000;
  return {
    items: [item(`i-${dateStr}`, `Priority ${dateStr}`, { updatedAt: preparedAt })],
    updatedAt: preparedAt,
    preparation: {
      schemaVersion: 1, targetOperationalDayId: opDayId(dateStr),
      firstPreparedAt: preparedAt, firstPreparedBy: 'device-a', firstPreparedMode: 'normal',
      lastPreparedAt: preparedAt, lastPreparedMode: 'normal', updatedBy: 'device-a',
      intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: [`i-${dateStr}`],
    },
  };
}

/** A prepared legacy calendar plan, confirmed the evening before its date. */
function preparedLegacyPlan(dateStr) {
  const preparedAt = manila(addDays(dateStr, -1), '20:00');
  return {
    items: [item(`L-${dateStr}`, `Legacy ${dateStr}`, { updatedAt: preparedAt })],
    updatedAt: preparedAt,
    preparation: {
      schemaVersion: 1, targetDate: dateStr, timezone: MANILA,
      firstPreparedAt: preparedAt, firstPreparedBy: 'device-a', firstPreparedMode: 'normal',
      lastPreparedAt: preparedAt, lastPreparedMode: 'normal', updatedBy: 'device-a',
      intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: [`L-${dateStr}`],
    },
  };
}

/** Seeds an account whose 18:00 boundary started on `startDate`, with prepared
 *  operational days for the given day offsets and prepared legacy plans for the
 *  given calendar dates. Returns the app positioned at `nowMs`. */
function makeLongHistoryApp({ startDate, preparedOffsets = [], legacyDates = [], nowMs }) {
  const plans = {};
  legacyDates.forEach(dateStr => { plans[dateStr] = preparedLegacyPlan(dateStr); });
  const records = {};
  preparedOffsets.forEach(offset => {
    const dateStr = addDays(startDate, offset);
    records[opDayId(dateStr)] = preparedOperationalRecord(dateStr);
  });
  return makeApp({
    clock: nowMs,
    legacy: legacyStore(plans),
    storage: memory({ 'ta3-day-boundary-revisions-v1': boundaryHistoryStore(startDate) }),
    planStorage: memory({ 'ta3-operational-plans-v1': JSON.stringify({ schemaVersion: 1, plans: records }) }),
  });
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('a 450-day best streak deep in history is reported exactly, not truncated by a traversal cap', () => {
  const startDate = '2025-01-01';
  // Personal days 1..450 prepared => habit days 0..449 earned: a genuine 450-day
  // run. Day 451 onwards is unprepared, so the run ended long before "today".
  const app = makeLongHistoryApp({
    startDate,
    preparedOffsets: range(1, 450),
    nowMs: manila(addDays(startDate, 500), '19:00'),
  });

  const streak = app.authority.streak();
  assert.equal(streak.best, 450, 'best must be the real historical run, whatever its distance from today');
  assert.equal(streak.current, 0, 'the run ended 50 days ago — nothing is current');
  assert.equal(streak.todayEarned, false);
});

test('a long history does not inflate the current streak', () => {
  const startDate = '2025-01-01';
  const todayOffset = 500;
  // The same 450-day historical run, plus TODAY's own habit earned (the upcoming
  // personal day is prepared). Yesterday is still unprepared, so current is 1.
  const app = makeLongHistoryApp({
    startDate,
    preparedOffsets: [...range(1, 450), todayOffset + 1],
    nowMs: manila(addDays(startDate, todayOffset), '19:00'),
  });

  const streak = app.authority.streak();
  assert.equal(streak.current, 1, 'only today earned — the ancient run must not leak into `current`');
  assert.equal(streak.todayEarned, true);
  assert.equal(streak.best, 450);
});

test('`best` does not depend on how far today is from the run — no fixed-day horizon', () => {
  const startDate = '2025-01-01';
  const answers = [250, 500, 900].map(todayOffset => makeLongHistoryApp({
    startDate,
    preparedOffsets: range(1, 200),
    nowMs: manila(addDays(startDate, todayOffset), '19:00'),
  }).authority.streak().best);
  // A 200-day run seen from 50, 300 and 700 days later is still a 200-day run.
  assert.deepEqual(answers, [200, 200, 200]);
});

test('a run spanning the legacy -> operational transition stays exact and is counted once per day', () => {
  const transitionDate = '2025-06-10';
  // 60 prepared legacy calendar days ending ON the transition date, then 360
  // prepared personal days starting at 18:00 that same date.
  //   - legacy habit days (transitionDate-60 .. transitionDate-1): 60
  //   - the transition day itself (00:00 -> 18:00, legacy-governed), judged by
  //     the first personal day: 1
  //   - operational habit days (personal days 0 .. 358): 359
  // => one continuous 420-day run, with every day credited exactly once.
  const legacyDates = range(0, 59).map(offset => addDays(transitionDate, -59 + offset));
  const app = makeLongHistoryApp({
    startDate: transitionDate,
    legacyDates,
    preparedOffsets: range(0, 359),
    nowMs: manila(addDays(transitionDate, 400), '19:00'),
  });

  const streak = app.authority.streak();
  assert.equal(streak.best, 420, 'the run is continuous across the transition — not truncated, not double-counted');
  assert.equal(streak.current, 0, 'preparation stopped 40 days ago');
});

test('days with no record are never treated as earned, and an empty history terminates immediately', () => {
  const startDate = '2025-01-01';
  const none = makeLongHistoryApp({ startDate, preparedOffsets: [], nowMs: manila(addDays(startDate, 300), '19:00') });
  assert.deepEqual(none.authority.streak(), { current: 0, best: 0, todayEarned: false, todayStillOpen: true });

  // A single prepared day in the distant past is worth exactly one habit day —
  // the hundreds of empty days around it are not filled in as earned.
  const one = makeLongHistoryApp({ startDate, preparedOffsets: [10], nowMs: manila(addDays(startDate, 300), '19:00') });
  assert.equal(one.authority.streak().best, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Authority-consistency matrix — every consumer question, one answer
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
