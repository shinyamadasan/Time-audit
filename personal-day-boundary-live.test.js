// personal-day-boundary-live.test.js
//
// Live Wiring V1 acceptance + chaos coverage. Everything runs against in-memory
// storage and an in-memory fake Firebase room ref — no real Firebase project,
// no network, no production data, ever.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createPersonalDayBoundaryLiveWiring, describeActivationInstant } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createPersonalDayBoundarySyncBridge, DAY_BOUNDARY_REVISIONS_REMOTE_PATH } from './personal-day-boundary-sync.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { createOperationalPlanSyncBridge, OPERATIONAL_PLANS_REMOTE_PATH, toFirebaseSafeKey } from './operational-plan-sync.js';
import { LEGACY_CALENDAR_DAY_REVISION_ID, isLegacyOperationalDay, operationalDayId } from './personal-day-boundary-model.js';
import { resolvePlanAuthority } from './operational-plan-model.js';

const MANILA = 'Asia/Manila'; // UTC+8, no DST — the owner's real zone

/** An exact UTC instant for a wall-clock reading in Manila. */
const manila = (dateStr, hhmm) => Date.parse(`${dateStr}T${hhmm}:00+08:00`);

const D = '2026-09-16';
const D_NEXT = '2026-09-17';
const D_PREV = '2026-09-15';

const memory = (seed = null) => {
  const map = new Map();
  if (seed) Object.entries(seed).forEach(([k, v]) => map.set(k, v));
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), _map: map };
};

// ── minimal in-memory Firebase room ref ─────────────────────────────────────
// Same shape/semantics as personal-day-boundary-sync.test.js's fake: a shared
// value tree, path-scoped child refs, `.on('value')` that fires immediately and
// on every later write, and a `.transaction()` whose update function returning
// `undefined` aborts with zero writes.
function fakeRoomRef(initial = {}) {
  const root = { value: initial };
  const listeners = new Map();
  const get = path => path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  function set(path, value) {
    const segs = path.split('/').filter(Boolean);
    if (!segs.length) { root.value = value; fire(''); return; }
    let node = root.value;
    for (let i = 0; i < segs.length - 1; i++) {
      if (typeof node[segs[i]] !== 'object' || node[segs[i]] === null) node[segs[i]] = {};
      node = node[segs[i]];
    }
    node[segs[segs.length - 1]] = value;
    // Fire this path and every ancestor — real RTDB value listeners higher in
    // the tree also see a descendant write.
    for (let i = segs.length; i >= 0; i--) fire(segs.slice(0, i).join('/'));
  }
  const fire = path => (listeners.get(path) || []).forEach(fn => fn({ val: () => get(path) ?? null }));
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
      listenerCount: () => (listeners.get(path) || new Set()).size,
      transaction(updateFn) {
        const current = get(path) ?? null;
        const next = updateFn(current);
        if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => current } });
        set(path, next);
        return Promise.resolve({ committed: true, snapshot: { val: () => next } });
      }
    };
  }
  return makeRef('');
}

/** A stand-in for index.html's `plans[dateKey]` store, reached only through the
 *  same two functions the live wiring is given in production
 *  (getPlanItemsRaw / savePlanItems). */
function legacyPlanStore(seed = {}) {
  const plans = { ...seed };
  return {
    plans,
    writes: [],
    readItems(dateKey) { return (plans[dateKey]?.items || []).map(item => ({ ...item })); },
    saveItems(dateKey, items) {
      this.writes.push(dateKey);
      plans[dateKey] = { ...(plans[dateKey] || {}), items, updatedAt: 1000, updatedBy: 'legacy-device' };
    }
  };
}

let seq = 0;
const seqIds = prefix => () => `${prefix}-${++seq}`;

/** One device: its own local storage, its own repositories/bridges, its own
 *  injected clock. `roomRef` is shared between devices in multi-device tests;
 *  pass `null` to model a device that is offline / not in a room. */
function makeDevice({ roomRef = null, storage = memory(), planStorage = memory(), idPrefix = 'rev', clock, legacy = legacyPlanStore(), deviceId = 'device-a' } = {}) {
  const getRoomRef = () => roomRef;
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds(idPrefix) });
  const planRepository = createOperationalPlanRepository({ storage: planStorage });
  const boundarySync = createPersonalDayBoundarySyncBridge({ repository: boundaryRepository, getRoomRef });
  const planSync = createOperationalPlanSyncBridge({ repository: planRepository, getRoomRef });
  const nowRef = { value: clock ?? manila(D, '08:00') };
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository, boundarySync, planSync,
    legacyPlans: { readItems: k => legacy.readItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => nowRef.value,
    deviceId: () => deviceId,
    fallbackTimezone: () => MANILA,
  });
  return { live, boundaryRepository, planRepository, boundarySync, planSync, legacy, storage, planStorage, nowRef, setNow: v => { nowRef.value = v; } };
}

const remoteRevisions = roomRef => roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val() || {};
const remotePlan = (roomRef, id) => roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(id)).val();

// ═══════════════════════════════════════════════════════════════════════════
// 1. Legacy compatibility (HARD REQUIREMENT, spec §9)
// ═══════════════════════════════════════════════════════════════════════════

test('legacy user opens the upgraded app: nothing is persisted, nothing is attached, no operational authority appears', () => {
  const roomRef = fakeRoomRef();
  const device = makeDevice({ roomRef });

  // Opening the app exercises every read path the live wiring offers.
  assert.equal(device.live.status().status, 'absent');
  assert.equal(device.live.enabled(), false);
  const state = device.live.boundaryState();
  assert.deepEqual({ status: state.status, active: state.active, pending: state.pending }, { status: 'absent', active: null, pending: null });
  const days = device.live.planningDays();
  device.live.previewProposal({ boundaryTime: '18:00', timezone: MANILA });
  device.live.attachLiveDays();

  // Not one byte written to the boundary store.
  assert.equal(device.storage.getItem('ta3-day-boundary-revisions-v1'), null, 'merely opening the app must never persist a revision');
  assert.equal(device.planStorage.getItem('ta3-operational-plans-v1'), null, 'no operational plan store is created either');

  // Both days are legacy-governed and route to plans[dateKey].
  assert.equal(days.current.authority.store, 'legacy');
  assert.equal(days.upcoming.authority.store, 'legacy');
  assert.equal(days.current.authority.dateKey, D);
  assert.equal(days.upcoming.authority.dateKey, D_NEXT);
  assert.ok(isLegacyOperationalDay(days.current.ref, days.revisions));
  assert.ok(isLegacyOperationalDay(days.upcoming.ref, days.revisions));

  // No operational-plan listener anywhere, and no remote boundary data.
  assert.deepEqual(device.live.liveDayIds(), []);
  assert.deepEqual(device.live.attachedDayIds(), []);
  assert.deepEqual(remoteRevisions(roomRef), {});
});

test('legacy plan behavior is unchanged: reads and writes for a never-enabled account go straight to plans[dateKey]', () => {
  const legacy = legacyPlanStore({ [D_NEXT]: { items: [{ id: 'p1', task: 'existing', when: '' }] } });
  const device = makeDevice({ legacy });
  const days = device.live.planningDays();

  assert.deepEqual(device.live.readPlanItems(days.upcoming).map(i => i.id), ['p1']);
  device.live.writePlanItems(days.upcoming, [{ id: 'p1', task: 'existing', when: '' }, { id: 'p2', task: 'added', when: '09:00' }], days.revisions);

  assert.deepEqual(legacy.writes, [D_NEXT], 'exactly one legacy write, at the legacy calendar dateKey');
  assert.deepEqual(legacy.plans[D_NEXT].items.map(i => i.id), ['p1', 'p2']);
  assert.equal(device.planStorage.getItem('ta3-operational-plans-v1'), null, 'the operational store is never touched for a legacy day');
  assert.equal(device.storage.getItem('ta3-day-boundary-revisions-v1'), null, 'planning never creates a boundary revision');
});

test('an invalid persisted boundary history fails closed — never silently reinterpreted as legacy', () => {
  const storage = memory({ 'ta3-day-boundary-revisions-v1': '{"schemaVersion":1,"revisions":{"x":{"id":"x","boundaryTime":"99:99","timezone":"Asia/Manila","effectiveFromInstant":null}}}' });
  const device = makeDevice({ storage });
  assert.equal(device.live.status().status, 'invalid');
  assert.equal(device.live.enabled(), false, 'invalid is not "custom"');
  assert.equal(device.live.boundaryState().status, 'invalid');
  assert.throws(() => device.live.planningDays(), /revision/i, 'planning must refuse rather than guess');
  assert.deepEqual(device.live.liveDayIds(), [], 'no listener is attached against a broken history');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. First enable — prospective activation (spec §11)
// ═══════════════════════════════════════════════════════════════════════════

const firstEnableCases = [
  { label: 'at 08:00 for 18:00 activates at 18:00 the same calendar day', at: manila(D, '08:00'), time: '18:00', expect: manila(D, '18:00'), copy: '18:00 today' },
  { label: 'at 17:59 for 18:00 activates one minute later, the same day', at: manila(D, '17:59'), time: '18:00', expect: manila(D, '18:00'), copy: '18:00 today' },
  { label: 'at 18:01 for 18:00 activates at 18:00 the NEXT calendar day', at: manila(D, '18:01'), time: '18:00', expect: manila(D_NEXT, '18:00'), copy: '18:00 tomorrow' },
  { label: 'at exactly 18:00 for 18:00 activates immediately (this instant IS an occurrence)', at: manila(D, '18:00'), time: '18:00', expect: manila(D, '18:00'), copy: '18:00 today' },
];

for (const testCase of firstEnableCases) {
  test(`first enable ${testCase.label}`, () => {
    const device = makeDevice({ clock: testCase.at });
    const preview = device.live.previewProposal({ boundaryTime: testCase.time, timezone: MANILA });
    assert.equal(preview.ok, true);
    assert.equal(preview.effectiveFromInstant, testCase.expect);
    assert.equal(preview.activationLabel, testCase.copy);
    assert.equal(device.storage.getItem('ta3-day-boundary-revisions-v1'), null, 'a preview never persists anything');

    const { revision } = device.live.proposeBoundary({ boundaryTime: testCase.time, timezone: MANILA });
    assert.equal(revision.effectiveFromInstant, testCase.expect, 'the committed revision matches the preview exactly');
    assert.equal(revision.boundaryTime, testCase.time);
    assert.equal(revision.timezone, MANILA);

    // The anchor and the candidate were created as one atomic history.
    const status = device.live.status();
    assert.equal(status.status, 'custom');
    assert.equal(status.revisions.length, 2);
    assert.equal(status.revisions[0].id, LEGACY_CALENDAR_DAY_REVISION_ID);
    assert.equal(status.revisions[0].effectiveFromInstant, null);
  });
}

test('explicit opt-in is the ONLY thing that creates a custom revision', () => {
  const device = makeDevice();
  for (let i = 0; i < 5; i++) {
    device.live.status();
    device.live.boundaryState();
    device.live.planningDays();
    device.live.previewProposal({ boundaryTime: '18:00', timezone: MANILA });
    device.live.refreshLiveDays();
  }
  assert.equal(device.storage.getItem('ta3-day-boundary-revisions-v1'), null);
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  assert.equal(device.live.status().status, 'custom');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Boundary adjustment (spec §8)
// ═══════════════════════════════════════════════════════════════════════════

test('18:00 -> 20:00 proposed at 08:00 activates the SAME calendar day at 20:00', () => {
  const device = makeDevice({ clock: manila(D_PREV, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  const historyBefore = JSON.stringify(device.live.status().revisions);

  device.setNow(manila(D, '08:00'));
  const preview = device.live.previewProposal({ boundaryTime: '20:00', timezone: MANILA });
  assert.equal(preview.effectiveFromInstant, manila(D, '20:00'));
  assert.equal(preview.activationLabel, '20:00 today');

  const { revision } = device.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA });
  assert.equal(revision.effectiveFromInstant, manila(D, '20:00'));

  // Previous revisions are untouched — append-only history.
  const after = device.live.status().revisions;
  assert.equal(after.length, 3);
  assert.ok(JSON.parse(historyBefore).every(before => after.some(r => JSON.stringify(r) === JSON.stringify(before))), 'every earlier revision survives byte-identical');
});

test('18:00 -> 20:00 proposed at 21:00 (after 20:00 has passed) activates the NEXT calendar day at 20:00', () => {
  const device = makeDevice({ clock: manila(D_PREV, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  device.setNow(manila(D, '21:00'));

  const preview = device.live.previewProposal({ boundaryTime: '20:00', timezone: MANILA });
  assert.equal(preview.effectiveFromInstant, manila(D_NEXT, '20:00'));
  assert.equal(preview.activationLabel, '20:00 tomorrow');
  assert.equal(device.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA }).revision.effectiveFromInstant, manila(D_NEXT, '20:00'));
});

test('a pending boundary change is reported as pending, and only becomes active at its own effective instant', () => {
  const device = makeDevice({ clock: manila(D_PREV, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  device.setNow(manila(D, '08:00'));
  device.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA });

  const before = device.live.boundaryState(manila(D, '19:59'));
  assert.equal(before.active.boundaryTime, '18:00');
  assert.equal(before.pending.boundaryTime, '20:00');
  assert.equal(before.pending.effectiveFromInstant, manila(D, '20:00'));

  const after = device.live.boundaryState(manila(D, '20:00'));
  assert.equal(after.active.boundaryTime, '20:00');
  assert.equal(after.pending, null);
});

test('17:59 -> 18:00 -> 18:01 chain: three immutable revisions, each aligned to its own boundary time', () => {
  const device = makeDevice({ clock: manila(D, '12:00') });
  const a = device.live.proposeBoundary({ boundaryTime: '17:59', timezone: MANILA }).revision;
  assert.equal(a.effectiveFromInstant, manila(D, '17:59'));

  device.setNow(manila(D, '17:58'));
  const b = device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }).revision;
  assert.equal(b.effectiveFromInstant, manila(D, '18:00'));

  device.setNow(manila(D, '17:58'));
  const c = device.live.proposeBoundary({ boundaryTime: '18:01', timezone: MANILA }).revision;
  assert.equal(c.effectiveFromInstant, manila(D, '18:01'));

  const history = device.live.status().revisions;
  assert.equal(history.length, 4, 'anchor + three revisions');
  // The transition day 17:59->18:00 is one minute long. That is the documented,
  // intended consequence of prospective activation, not a bug.
  assert.equal(device.live.boundaryState(manila(D, '17:59')).active.boundaryTime, '17:59');
  assert.equal(device.live.boundaryState(manila(D, '18:00')).active.boundaryTime, '18:00');
  assert.equal(device.live.boundaryState(manila(D, '18:01')).active.boundaryTime, '18:01');
});

test('23:59 -> 00:00 -> 00:01 under an 18:00 boundary: a custom 00:00 stays OPERATIONAL, never legacy', () => {
  const device = makeDevice({ clock: manila(D_PREV, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });

  device.setNow(manila(D, '20:00'));
  assert.equal(device.live.proposeBoundary({ boundaryTime: '23:59', timezone: MANILA }).revision.effectiveFromInstant, manila(D, '23:59'));
  device.setNow(manila(D, '23:58'));
  assert.equal(device.live.proposeBoundary({ boundaryTime: '00:00', timezone: MANILA }).revision.effectiveFromInstant, manila(D_NEXT, '00:00'));
  device.setNow(manila(D_NEXT, '00:00'));
  assert.equal(device.live.proposeBoundary({ boundaryTime: '00:01', timezone: MANILA }).revision.effectiveFromInstant, manila(D_NEXT, '00:01'));

  // The critical assertion: while the custom 00:00 revision governs, plan
  // authority is still OPERATIONAL. 00:00 does not mean "back to legacy".
  const at0000 = device.live.planningDays(manila(D_NEXT, '00:00') + 30000);
  assert.equal(at0000.current.authority.store, 'operational');
  assert.equal(isLegacyOperationalDay(at0000.current.ref, at0000.revisions), false);
  assert.notEqual(at0000.current.ref.boundaryRevisionId, LEGACY_CALENDAR_DAY_REVISION_ID);
});

test('a custom 00:00 boundary set on its own (no other revision) is still operational, not legacy', () => {
  const device = makeDevice({ clock: manila(D, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '00:00', timezone: MANILA });
  const days = device.live.planningDays(manila(D_NEXT, '09:00'));
  assert.equal(days.current.authority.store, 'operational');
  assert.ok(days.current.authority.operationalDayId.startsWith('odv1:'));
  assert.notEqual(days.current.authority.operationalDayId, D_NEXT, 'an operationalDayId can never be a bare dateKey');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Timezone behavior (spec §2, §8)
// ═══════════════════════════════════════════════════════════════════════════

test('the boundary timezone lives on the revision and changing it is a NEW revision — old history keeps its own zone', () => {
  const device = makeDevice({ clock: manila(D_PREV, '08:00') });
  const first = device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }).revision;

  device.setNow(manila(D, '08:00'));
  const second = device.live.proposeBoundary({ boundaryTime: '18:00', timezone: 'Asia/Tokyo' }).revision;

  assert.equal(second.timezone, 'Asia/Tokyo');
  assert.equal(second.effectiveFromInstant, Date.parse(`${D}T18:00:00+09:00`), 'the new zone\'s own 18:00 is what activates');
  const history = device.live.status().revisions;
  assert.equal(history.find(r => r.id === first.id).timezone, MANILA, 'the earlier revision keeps its original timezone');

  // Old history is not reinterpreted: an instant before the Tokyo revision is
  // still grouped by the Manila revision that actually governed it.
  const beforeSwitch = device.live.planningDays(manila(D, '12:00'));
  assert.equal(beforeSwitch.current.ref.timezone, MANILA);
  const afterSwitch = device.live.planningDays(Date.parse(`${D}T20:00:00+09:00`));
  assert.equal(afterSwitch.current.ref.timezone, 'Asia/Tokyo');
  assert.notEqual(operationalDayId(beforeSwitch.current.ref), operationalDayId(afterSwitch.current.ref));
});

test('the boundary timezone is independent of the legacy settings timezone (no continuous link)', () => {
  // fallbackTimezone models settings.timezone. Once a revision exists, it is
  // the revision's own stored zone that governs — changing the fallback later
  // must not move the boundary.
  const storage = memory();
  const planStorage = memory();
  const tz = { value: MANILA };
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds('tzrev') });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository,
    planRepository: createOperationalPlanRepository({ storage: planStorage }),
    now: () => manila(D, '08:00'),
    fallbackTimezone: () => tz.value,
    legacyPlans: legacyPlanStore(),
  });
  live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  tz.value = 'America/New_York'; // the user changes Work day timezone afterwards
  assert.equal(live.boundaryState().active.timezone, MANILA, 'the boundary revision keeps its own persisted timezone');
  assert.equal(live.planningDays().current.ref.timezone, MANILA);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The owner's graveyard workflow (spec §7) — the required V1 path
// ═══════════════════════════════════════════════════════════════════════════

test('graveyard workflow: plan at 08:00 for the upcoming 18:00 day, reload, it becomes current at 18:00, survives midnight, rolls at the next 18:00', () => {
  const roomRef = fakeRoomRef();
  const legacy = legacyPlanStore();
  const storage = memory();
  const planStorage = memory();
  const device = makeDevice({ roomRef, storage, planStorage, legacy, clock: manila(D, '08:00') });

  // ── Enable at 08:00 on D for an 18:00 personal day ──
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  device.live.attachLiveDays();

  // ── 08:00 on D ──
  // The CURRENT day at 08:00 is still legacy-governed (the custom revision is
  // not effective until 18:00 — no retroactive reinterpretation), and the
  // UPCOMING day is the operational one beginning 18:00 on D.
  const morning = device.live.planningDays();
  assert.equal(morning.current.authority.store, 'legacy', 'the day already in progress at 08:00 was never under the new boundary');
  assert.equal(morning.current.authority.dateKey, D);
  assert.equal(morning.upcoming.authority.store, 'operational');
  assert.equal(morning.upcoming.startMs, manila(D, '18:00'));
  assert.equal(morning.upcoming.endMs, manila(D_NEXT, '18:00'));
  const upcomingId = morning.upcoming.authority.operationalDayId;

  // Prepare the upcoming personal day's plan through the live write path.
  device.live.writePlanItems(morning.upcoming, [
    { id: 'op1', task: 'Night shift block', when: '22:00', durationMinutes: 120, done: false, updatedAt: 1, updatedBy: 'device-a' },
    { id: 'op2', task: 'Post-midnight review', when: '01:00', done: false, updatedAt: 1, updatedBy: 'device-a' },
  ], morning.revisions);

  // It landed in the OPERATIONAL store, keyed by operationalDayId — never in plans[dateKey].
  assert.deepEqual(legacy.writes, [], 'preparing an operational day never writes a legacy plan');
  assert.deepEqual(device.planRepository.read(upcomingId).items.map(i => i.id), ['op1', 'op2']);
  // 01:00 is a perfectly ordinary time INSIDE an 18:00-boundary day — the
  // legacy midnight-clamped validator would have rejected it.
  assert.ok(remotePlan(roomRef, upcomingId), 'the plan was pushed to the durable remote copy');
  assert.deepEqual(device.live.attachedDayIds(), [upcomingId], 'only the operational day in live use is listened to');

  // ── close / reload (a brand-new wiring instance over the same storage) ──
  const reloaded = makeDevice({ roomRef, storage, planStorage, legacy, clock: manila(D, '08:30') });
  assert.equal(reloaded.live.status().status, 'custom');
  assert.deepEqual(reloaded.live.readPlanItems(reloaded.live.planningDays().upcoming).map(i => i.id), ['op1', 'op2']);

  // ── 18:00 on D: the prepared plan becomes the CURRENT plan ──
  reloaded.setNow(manila(D, '18:00'));
  const evening = reloaded.live.planningDays();
  assert.equal(evening.current.authority.store, 'operational');
  assert.equal(evening.current.authority.operationalDayId, upcomingId, 'exactly the day that was prepared at 08:00');
  assert.deepEqual(reloaded.live.readPlanItems(evening.current).map(i => i.task), ['Night shift block', 'Post-midnight review']);

  // ── 00:30 on D+1: calendar midnight must NOT rotate the personal day ──
  reloaded.setNow(manila(D_NEXT, '00:30'));
  const pastMidnight = reloaded.live.planningDays();
  assert.equal(pastMidnight.current.authority.operationalDayId, upcomingId, 'calendar midnight does not rotate an 18:00 day');
  assert.deepEqual(reloaded.live.readPlanItems(pastMidnight.current).map(i => i.id), ['op1', 'op2']);

  // ── 18:00 on D+1: the following personal day begins ──
  reloaded.setNow(manila(D_NEXT, '18:00'));
  const nextDay = reloaded.live.planningDays();
  assert.notEqual(nextDay.current.authority.operationalDayId, upcomingId);
  assert.equal(nextDay.current.startMs, manila(D_NEXT, '18:00'));
  assert.deepEqual(reloaded.live.readPlanItems(nextDay.current), [], 'a fresh personal day starts with no plan — nothing was migrated in');
  // The previous day's plan is still intact and untouched.
  assert.deepEqual(reloaded.planRepository.read(upcomingId).items.map(i => i.id), ['op1', 'op2']);
});

test('changing the boundary time never loses an already-written plan for a day whose identity does not change', () => {
  const device = makeDevice({ clock: manila(D_PREV, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });

  device.setNow(manila(D, '19:00')); // inside the 18:00 day that started on D
  const before = device.live.planningDays();
  const currentId = before.current.authority.operationalDayId;
  device.live.writePlanItems(before.current, [{ id: 'keep', task: 'still here', when: '', done: false, updatedAt: 1, updatedBy: 'device-a' }], before.revisions);

  // Change the boundary to 20:00. That takes effect at 20:00 TODAY, which
  // truncates the in-progress day — but its identity (and therefore its stored
  // plan) is unchanged.
  device.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA });
  const after = device.live.planningDays();
  assert.equal(after.current.authority.operationalDayId, currentId, 'the in-progress day keeps its identity');
  assert.deepEqual(device.live.readPlanItems(after.current).map(i => i.id), ['keep']);
  assert.equal(after.current.endMs, manila(D, '20:00'), 'the transition day is shortened, exactly as the contract documents');

  // And the record itself is still readable after the change.
  assert.deepEqual(device.planRepository.read(currentId).items.map(i => i.id), ['keep']);
});

test('a plan prepared for an upcoming day is RETAINED, not deleted, when a later boundary change makes that day never occur', () => {
  // At 08:00 on D the user enables an 18:00 boundary and prepares the upcoming
  // personal day (which would start 18:00 on D).
  const device = makeDevice({ clock: manila(D, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  const morning = device.live.planningDays();
  const preparedId = morning.upcoming.authority.operationalDayId;
  device.live.writePlanItems(morning.upcoming, [{ id: 'prep', task: 'prepared ahead', when: '', done: false, updatedAt: 1, updatedBy: 'device-a' }], morning.revisions);

  // At 09:00 the same day they change their mind to a 12:00 boundary, which
  // activates at 12:00 TODAY — before the 18:00 day would ever have begun.
  device.setNow(manila(D, '09:00'));
  device.live.proposeBoundary({ boundaryTime: '12:00', timezone: MANILA });

  const after = device.live.planningDays();
  assert.equal(after.upcoming.startMs, manila(D, '12:00'), 'the upcoming day now begins at the new boundary');
  assert.notEqual(after.upcoming.authority.operationalDayId, preparedId, 'the 18:00 day the user prepared will now never occur');

  // HONEST LIMITATION, asserted rather than hidden: that prepared plan is not
  // deleted — the record is still in the store, byte-intact — but it is no
  // longer reachable through the Now/Next panes, because the personal day it
  // belonged to no longer happens. Nothing is silently destroyed; nothing is
  // silently resurrected into a different day either.
  assert.deepEqual(device.planRepository.read(preparedId).items.map(i => i.id), ['prep'], 'the prepared record is retained, not deleted');
  assert.deepEqual(device.live.readPlanItems(after.upcoming), [], 'and it is never silently carried into the new upcoming day');
});

test('every live plan read and write routes through resolvePlanAuthority — including a legacy-governed day belonging to a CUSTOM user', () => {
  const legacy = legacyPlanStore();
  const device = makeDevice({ legacy, clock: manila(D, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  const days = device.live.planningDays();

  // Independently recompute authority from the pure router and require the
  // live wiring to agree with it for both days.
  for (const day of [days.current, days.upcoming]) {
    assert.deepEqual(day.authority, resolvePlanAuthority(day.ref, days.revisions));
  }

  // The current (pre-effective) day is legacy: its write must land in plans[dateKey].
  device.live.writePlanItems(days.current, [{ id: 'l1', task: 'legacy day item', when: '' }], days.revisions);
  assert.deepEqual(legacy.writes, [D]);
  assert.equal(device.planStorage.getItem('ta3-operational-plans-v1'), null, 'a legacy-governed day never reaches the operational store');

  // The upcoming (post-effective) day is operational: its write must NOT.
  device.live.writePlanItems(days.upcoming, [{ id: 'o1', task: 'operational day item', when: '', done: false, updatedAt: 1, updatedBy: 'device-a' }], days.revisions);
  assert.deepEqual(legacy.writes, [D], 'still exactly one legacy write');
  assert.ok(device.planRepository.read(days.upcoming.authority.operationalDayId));
});

test('an out-of-range timed item is rejected before anything is persisted', () => {
  const device = makeDevice({ clock: manila(D, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  const days = device.live.planningDays();
  // 17:00 resolves to 17:00 on the day AFTER boundaryStartDate (it is before
  // the 18:00 boundary) with a 120-minute length -> 19:00, past the day's end.
  assert.throws(
    () => device.live.writePlanItems(days.upcoming, [{ id: 'bad', task: 'too long', when: '17:00', durationMinutes: 120, done: false, updatedAt: 1, updatedBy: 'device-a' }], days.revisions),
    /invalid range/i
  );
  assert.equal(device.planRepository.read(days.upcoming.authority.operationalDayId), null, 'nothing was written');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Sync: offline, reconnect, fresh device, multi-device (spec §5)
// ═══════════════════════════════════════════════════════════════════════════

test('offline enable and change: everything works locally, then converges on reconnect', async () => {
  const storage = memory();
  const planStorage = memory();
  const legacy = legacyPlanStore();

  // Offline: no room ref at all.
  const offline = makeDevice({ roomRef: null, storage, planStorage, legacy, clock: manila(D, '08:00') });
  offline.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  const offlineDays = offline.live.planningDays();
  offline.live.writePlanItems(offlineDays.upcoming, [{ id: 'off1', task: 'written offline', when: '', done: false, updatedAt: 1, updatedBy: 'device-a' }], offlineDays.revisions);
  assert.equal(offline.live.status().status, 'custom', 'local truth is complete while offline');
  offline.live.attachLiveDays(); // no-op with no room ref
  assert.deepEqual(offline.live.attachedDayIds(), [offlineDays.upcoming.authority.operationalDayId]);

  // Reconnect: the same local storage, now with a room.
  const roomRef = fakeRoomRef();
  const online = makeDevice({ roomRef, storage, planStorage, legacy, clock: manila(D, '08:05') });
  online.live.attachLiveDays();
  online.live.pushAllLocal();
  await Promise.resolve();

  const remote = remoteRevisions(roomRef);
  assert.equal(Object.keys(remote).length, 2, 'anchor + the offline revision both reached remote');
  assert.ok(remotePlan(roomRef, offlineDays.upcoming.authority.operationalDayId), 'the offline plan reached remote too');
});

test('fresh device reconstructs the full boundary history and the live plan from remote alone', async () => {
  const roomRef = fakeRoomRef();
  const author = makeDevice({ roomRef, idPrefix: 'author', clock: manila(D, '08:00') });
  author.live.attachLiveDays();
  author.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  const days = author.live.planningDays();
  author.live.writePlanItems(days.upcoming, [{ id: 'shared', task: 'from device A', when: '', done: false, updatedAt: 5, updatedBy: 'device-a' }], days.revisions);
  await Promise.resolve();

  // A brand-new device: empty local storage, same room.
  const fresh = makeDevice({ roomRef, idPrefix: 'fresh', deviceId: 'device-b', clock: manila(D, '09:00') });
  assert.equal(fresh.live.status().status, 'absent', 'before attaching it knows nothing');
  fresh.live.attachLiveDays();

  const freshStatus = fresh.live.status();
  assert.equal(freshStatus.status, 'custom');
  assert.deepEqual(freshStatus.revisions.map(r => r.boundaryTime).sort(), ['00:00', '18:00']);
  const freshDays = fresh.live.planningDays();
  assert.equal(freshDays.upcoming.authority.operationalDayId, days.upcoming.authority.operationalDayId, 'both devices derive the same operational day identity');
  assert.deepEqual(fresh.live.readPlanItems(freshDays.upcoming).map(i => i.id), ['shared'], 'the plan arrived through the per-day listener');
});

test('two devices proposing the EQUIVALENT boundary converge on one canonical revision', async () => {
  const roomRef = fakeRoomRef();
  const at = manila(D, '08:00');
  const deviceA = makeDevice({ roomRef, idPrefix: 'aaa', clock: at });
  const deviceB = makeDevice({ roomRef, idPrefix: 'zzz', deviceId: 'device-b', clock: at });

  // Both propose offline-ish (each pushes on its own), same facts, different ids.
  deviceA.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  deviceB.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  await Promise.resolve();
  deviceA.live.attachLiveDays();
  deviceB.live.attachLiveDays();
  await Promise.resolve();

  const remote = Object.values(remoteRevisions(roomRef));
  assert.equal(remote.length, 2, 'anchor + exactly ONE custom revision survives');
  const custom = remote.filter(r => r.effectiveFromInstant !== null);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].boundaryTime, '18:00');

  // Both devices end up on the same operational day identity.
  assert.equal(
    deviceA.live.planningDays().upcoming.authority.operationalDayId,
    deviceB.live.planningDays().upcoming.authority.operationalDayId,
    'no split brain: one identity on both devices'
  );
});

test('two devices proposing CONTRADICTORY facts at the same instant fail closed — remote never holds both', async () => {
  const roomRef = fakeRoomRef();
  const deviceA = makeDevice({ roomRef, idPrefix: 'aaa', clock: manila(D, '08:00') });
  deviceA.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  await Promise.resolve();

  // Device B's revision names the SAME absolute instant with genuinely
  // different facts (America/New_York 06:00 == Asia/Manila 18:00 here).
  const deviceB = makeDevice({ roomRef, idPrefix: 'bbb', deviceId: 'device-b', clock: manila(D, '08:00') });
  const contradiction = { id: 'bbb-contradiction', boundaryTime: '06:00', timezone: 'America/New_York', effectiveFromInstant: manila(D, '18:00') };
  const result = await deviceB.boundarySync.pushRevision(contradiction);

  assert.deepEqual(result, { committed: false, outcome: 'conflict' });
  const remote = remoteRevisions(roomRef);
  assert.equal(Object.keys(remote).length, 2, 'remote still holds only the anchor + device A\'s revision');
  assert.ok(!remote['bbb-contradiction']);
});

test('two devices editing the same operational day converge per-item rather than clobbering', async () => {
  const roomRef = fakeRoomRef();
  const deviceA = makeDevice({ roomRef, idPrefix: 'aaa', clock: manila(D, '08:00') });
  deviceA.live.attachLiveDays();
  deviceA.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  const idsA = deviceA.live.planningDays();
  const dayId = idsA.upcoming.authority.operationalDayId;
  deviceA.live.writePlanItems(idsA.upcoming, [{ id: 'a-item', task: 'from A', when: '', done: false, updatedAt: 10, updatedBy: 'device-a' }], idsA.revisions);
  await Promise.resolve();

  const deviceB = makeDevice({ roomRef, idPrefix: 'bbb', deviceId: 'device-b', clock: manila(D, '08:10') });
  deviceB.live.attachLiveDays();
  const idsB = deviceB.live.planningDays();
  assert.equal(idsB.upcoming.authority.operationalDayId, dayId);
  deviceB.live.writePlanItems(idsB.upcoming, [
    ...deviceB.live.readPlanItems(idsB.upcoming),
    { id: 'b-item', task: 'from B', when: '', done: false, updatedAt: 20, updatedBy: 'device-b' },
  ], idsB.revisions);
  await Promise.resolve();

  const merged = remotePlan(roomRef, dayId);
  assert.deepEqual(merged.items.map(i => i.id).sort(), ['a-item', 'b-item'], 'neither device\'s item was lost');
  assert.deepEqual(deviceA.planRepository.read(dayId).items.map(i => i.id).sort(), ['a-item', 'b-item'], 'device A saw B\'s item through its listener');
});

test('malformed remote boundary history stays fail-closed: nothing is overwritten and local truth is untouched', async () => {
  // Genuinely malformed: the record's own `id` disagrees with the key it is
  // stored under, so the whole remote map fails structural decoding. (A remote
  // entry that is merely MISSING an anchor is NOT malformed — it set-unions
  // cleanly with a local history that has one, which is the designed
  // record-level merge, so it would be the wrong fixture for this test.)
  const roomRef = fakeRoomRef({
    [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { broken: { id: 'not-broken', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: manila(D, '18:00') } }
  });
  const device = makeDevice({ roomRef, clock: manila(D, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  const localBefore = JSON.stringify(device.live.status().revisions);
  device.live.attachLiveDays();
  await Promise.resolve();

  assert.equal(JSON.stringify(device.live.status().revisions), localBefore, 'a malformed remote never corrupts a valid local history');
  assert.ok(remoteRevisions(roomRef).broken, 'the malformed remote entry is left exactly as found, not overwritten');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Listener lifecycle
// ═══════════════════════════════════════════════════════════════════════════

test('only the current + upcoming operational days are ever listened to, and a rollover swaps them cleanly', () => {
  const roomRef = fakeRoomRef();
  const device = makeDevice({ roomRef, clock: manila(D_PREV, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });

  device.setNow(manila(D, '19:00'));
  device.live.attachLiveDays();
  const attachedEvening = device.live.attachedDayIds();
  assert.equal(attachedEvening.length, 2, 'current + upcoming, never more');

  // Roll forward a full personal day: the old "current" must be detached.
  device.setNow(manila(D_NEXT, '19:00'));
  const attachedNextDay = device.live.refreshLiveDays();
  assert.equal(attachedNextDay.length, 2);
  assert.equal(attachedNextDay[0], attachedEvening[1], 'yesterday\'s upcoming is today\'s current');
  assert.ok(!attachedNextDay.includes(attachedEvening[0]), 'the day that rolled off is no longer listened to');
  assert.equal(roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(attachedEvening[0])).listenerCount(), 0);

  device.live.detach();
  assert.deepEqual(device.live.attachedDayIds(), []);
  assert.equal(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).listenerCount(), 0);
});

// A long-lived session only ever receives time via tick() (index.html's 60s
// interval). These tests never call refreshLiveDays() directly, so they fail if
// the time-driven path stops refreshing subscriptions.

test('long-lived session: tick() across 17:59:59 -> 18:00:00 -> 18:00:01 swaps listeners without reload, write or reconnect', () => {
  const roomRef = fakeRoomRef();
  const device = makeDevice({ roomRef, clock: manila(D_PREV, '08:00') });
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });

  device.setNow(manila(D, '17:59') + 59000);
  device.live.attachLiveDays();
  const before = device.live.attachedDayIds();

  device.live.tick();
  assert.deepEqual(device.live.attachedDayIds(), before, '17:59:59 is still the old day — nothing moves early');

  device.setNow(manila(D, '18:00'));
  device.live.tick();
  const after = device.live.attachedDayIds();
  assert.equal(after.length, 2);
  assert.equal(after[0], before[1], 'the prepared upcoming day is now current — same identity, no copy');
  assert.ok(!after.includes(before[0]), 'the day that just ended is detached');
  const dayRef = id => roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(id));
  assert.equal(dayRef(before[0]).listenerCount(), 0);
  assert.equal(dayRef(after[1]).listenerCount(), 1, 'the newly relevant upcoming day is attached');

  device.setNow(manila(D, '18:00') + 1000);
  device.live.tick();
  assert.deepEqual(device.live.attachedDayIds(), after, '18:00:01 is idempotent — no re-attach churn');
  assert.equal(dayRef(after[1]).listenerCount(), 1);
});

test('long-lived session: after a tick-only rollover, another device\'s plan for the NEW upcoming day arrives live', async () => {
  const roomRef = fakeRoomRef();
  const a = makeDevice({ roomRef, clock: manila(D_PREV, '08:00'), deviceId: 'device-a', idPrefix: 'a' });
  a.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  a.setNow(manila(D, '17:30'));
  a.live.attachLiveDays();

  // 18:00 passes while device A just sits there; only the interval ticks.
  a.setNow(manila(D, '18:30'));
  a.live.tick();

  // Device B shares the boundary history and prepares the day starting 18:00 D+1.
  const b = makeDevice({ roomRef, storage: a.storage, clock: manila(D, '18:30'), deviceId: 'device-b', idPrefix: 'b' });
  const days = b.live.planningDays();
  const upcomingId = days.upcoming.authority.operationalDayId;
  assert.equal(a.planRepository.read(upcomingId), null, 'nothing local on A yet');
  b.live.writePlanItems(days.upcoming, [{ id: 'p-remote', task: 'Prepared on B', when: '22:00', done: false, doneAt: null, updatedAt: manila(D, '18:30'), updatedBy: 'device-b' }], days.revisions);
  for (let i = 0; i < 5; i++) await Promise.resolve();

  const onA = a.planRepository.read(upcomingId);
  assert.ok(onA, 'device A received the new upcoming day without reload/local write/reconnect');
  assert.equal(onA.items[0].task, 'Prepared on B');
});

test('tick() refreshes listeners before onTick, and never throws on an invalid history', () => {
  const calls = [];
  const storage = memory({ 'ta3-day-boundary-revisions-v1': '{not json' });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository: createPersonalDayBoundaryRepository({ storage }),
    planRepository: createOperationalPlanRepository({ storage: memory() }),
    planSync: { attachDay: () => calls.push('attach'), detachDay: () => calls.push('detach'), syncDay: () => {} },
    now: () => manila(D, '18:00'),
    fallbackTimezone: () => MANILA,
    onTick: () => calls.push('onTick'),
  });
  assert.doesNotThrow(() => live.tick());
  assert.deepEqual(calls, ['onTick'], 'invalid history attaches nothing, and the re-render still runs');
});

test('index.html\'s 60s interval drives the live tick (rollover is not left to render-only code)', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const start = html.search(/setInterval\(\(\) => \{\r?\n\s*if \(!running && !breakActive\) renderTodayOnDateChange\(\);/);
  assert.ok(start >= 0, 'found the 60s Today interval');
  const body = html.slice(start, html.indexOf('}, 60000);', start));
  assert.match(body, /PersonalDayBoundaryLive\.tick\(\)/);
});

test('a legacy account attaches no operational-plan listeners at all', () => {
  const roomRef = fakeRoomRef();
  const device = makeDevice({ roomRef, clock: manila(D, '08:00') });
  device.live.attachLiveDays();
  assert.deepEqual(device.live.attachedDayIds(), []);
  assert.equal(roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).listenerCount(), 0);
  // The boundary listener itself is harmless and required for a legacy device
  // to LEARN about a boundary another device enabled.
  assert.equal(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).listenerCount(), 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Activation copy + the "no disable" product guarantee
// ═══════════════════════════════════════════════════════════════════════════

test('activation copy names today / tomorrow / a further date honestly', () => {
  const nowMs = manila(D, '08:00');
  assert.equal(describeActivationInstant(manila(D, '20:00'), '20:00', MANILA, nowMs), '20:00 today');
  assert.equal(describeActivationInstant(manila(D_NEXT, '06:00'), '06:00', MANILA, nowMs), '06:00 tomorrow');
  assert.equal(describeActivationInstant(manila('2026-09-18', '06:00'), '06:00', MANILA, nowMs), '06:00 on Friday, September 18');
});

test('no disable / reset-to-legacy operation exists anywhere on the live surface or in the Settings UI', () => {
  const device = makeDevice();
  const forbiddenApi = ['disable', 'reset', 'clear', 'remove', 'delete', 'turnOff', 'revertToLegacy'];
  const surface = Object.keys(device.live);
  for (const name of forbiddenApi) {
    assert.ok(!surface.some(key => key.toLowerCase().includes(name.toLowerCase())), `live wiring must not expose a "${name}" operation, found in: ${surface.join(', ')}`);
  }
  // And the shipped Settings UI must not offer one either. Raw text here on
  // purpose: a forbidden phrase must not appear even in a comment that could be
  // mistaken for copy.
  const ui = readFileSync(new URL('./personal-day-boundary-ui.js', import.meta.url), 'utf8');
  for (const phrase of ['Disable Personal Day Boundary', 'Return to legacy', 'Use calendar day', 'Reset to legacy', 'Turn off personal day']) {
    assert.ok(!ui.includes(phrase), `Settings UI must not contain "${phrase}"`);
  }
  // The repository itself has no deletion path — history is append-only.
  assert.ok(!Object.keys(device.boundaryRepository).some(key => /delete|remove|clear|reset/i.test(key)));
});

test('the boundary repository has no write path other than propose()', () => {
  const device = makeDevice();
  assert.deepEqual(
    Object.keys(device.boundaryRepository).sort(),
    ['key', 'listAllRaw', 'mergeRemoteRevisions', 'propose', 'read', 'status'],
    'an unexpected method on the boundary repository is a contract change that needs review'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Source-level guards on the two new UI modules
//
// These modules render DOM, and this project's test convention is to unit-test
// pure functions rather than stand up a DOM (no jsdom dependency). What CAN be
// asserted here without a browser are the structural promises the milestone
// makes about them — and those are exactly the promises worth pinning.
// ═══════════════════════════════════════════════════════════════════════════

/** Reads a module's CODE with comments stripped. These guards assert what the
 *  modules actually do, and every one of these files explains in prose exactly
 *  which symbols it is forbidden to call — scanning raw text would match those
 *  explanations and make the guards meaningless. Same stripping approach
 *  scripts/runtime-mirror.mjs already uses to parse module deps. */
const readSource = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('neither new UI module reimplements operational-day or boundary arithmetic', () => {
  const forbidden = [
    'operationalDayContaining', 'currentOperationalDay', 'nextOperationalDay', 'previousOperationalDay',
    'operationalDayInterval', 'nextBoundaryInstant', 'proposeBoundaryRevision', 'activeBoundaryRevision',
    'resolveCivilBoundary', 'resolveLocalWallClock', 'normalizeBoundaryRevisionHistory',
  ];
  for (const name of ['personal-day-boundary-ui.js', 'operational-plan-ui.js']) {
    const source = readSource(name);
    for (const symbol of forbidden) {
      assert.ok(!source.includes(symbol), `${name} must not call ${symbol} directly — it goes through PersonalDayBoundaryLive`);
    }
  }
});

test('neither new UI module writes through the legacy settings object', () => {
  for (const name of ['personal-day-boundary-ui.js', 'operational-plan-ui.js']) {
    const source = readSource(name);
    assert.ok(!source.includes('saveSettings('), `${name} must never push the boundary through the legacy whole-object settings sync`);
    assert.ok(!/\bsettings\.timezone\b/.test(source), `${name} must not read or write settings.timezone directly`);
  }
});

test('the operational planning surface never touches a deferred legacy plan consumer', () => {
  const source = readSource('operational-plan-ui.js');
  for (const symbol of ['plan-tomorrow-model', 'daily-routines-model', 'daily-routines-repository', 'planTomorrowTargetDate', 'normalizePreparation', 'planningConsistency', 'confirmPreparedDatePlan', 'getPlanTomorrowAppContext']) {
    assert.ok(!source.includes(symbol), `operational-plan-ui.js must not reach into ${symbol} — Planning Streak / Daily Reconciliation / routines are explicitly deferred`);
  }
});

test('the operational planning surface tombstones removals rather than splicing them', () => {
  const source = readSource('operational-plan-ui.js');
  assert.ok(source.includes('deleted: true'), 'a hard delete would be resurrected by the per-item remote merge');
  assert.ok(!/\.splice\(/.test(source) && !/\.filter\(item => item\.id !== /.test(source));
});

test('the live wiring never reaches into plans[dateKey] itself — only through injected callbacks', () => {
  const source = readSource('personal-day-boundary-live.js');
  assert.ok(!/\bplans\[/.test(source));
  assert.ok(!source.includes('ta3-plans'), 'the legacy plan storage key must never appear in the live wiring');
});
