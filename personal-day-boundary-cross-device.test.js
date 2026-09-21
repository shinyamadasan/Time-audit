// personal-day-boundary-cross-device.test.js
//
// Cross-device convergence of the Personal Day Boundary. One account = one room =
// one authoritative revision history at rooms/<room>/dayBoundaryRevisions; every
// device keeps only an offline CACHE of it (localStorage) and derives its
// effective boundary / current My Day from that history.
//
// Everything runs against in-memory storage and an in-memory fake Firebase room
// ref shared between "devices" — no real project, no network, no production data.
// Each device has its own storage, its own repository/bridge/wiring, its own
// clock, and an `online` switch that models "no room ref yet" (offline, or the
// pre-attach window at startup).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createPersonalDayBoundarySyncBridge, DAY_BOUNDARY_REVISIONS_REMOTE_PATH } from './personal-day-boundary-sync.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { normalizeBoundaryRevisionHistory } from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';
// The device's cache slot for the account under test (see personal-day-boundary-repository.js).
const SLOT = 'ta3-day-boundary-revisions-v1:uid_test-room';
const manila = (dateStr, hhmm) => Date.parse(`${dateStr}T${hhmm}:00+08:00`);
const D = '2026-09-16';
const T_0800 = manila(D, '08:00'); // before an 18:00 boundary proposed "now" activates
const T_1900 = manila(D, '19:00'); // after it

const memory = (seed = null) => {
  const map = new Map();
  if (seed) Object.entries(seed).forEach(([k, v]) => map.set(k, v));
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), _map: map };
};

function fakeRoomRef(initial = {}) {
  const root = { value: initial };
  const listeners = new Map();
  const get = path => path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  const fire = path => (listeners.get(path) || []).forEach(fn => fn({ val: () => get(path) ?? null }));
  function set(path, value) {
    const segs = path.split('/').filter(Boolean);
    if (!segs.length) { root.value = value; fire(''); return; }
    let node = root.value;
    for (let i = 0; i < segs.length - 1; i++) {
      if (typeof node[segs[i]] !== 'object' || node[segs[i]] === null) node[segs[i]] = {};
      node = node[segs[i]];
    }
    node[segs[segs.length - 1]] = value;
    for (let i = segs.length; i >= 0; i--) fire(segs.slice(0, i).join('/'));
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

// One account. Its cache slot is this room's; offline hides the room REF, never the account.
const ROOM = 'uid_test-room';

let seq = 0;
const seqIds = prefix => () => `${prefix}-${++seq}`;

/** One device. `online` toggles whether the sync layer can see a room ref at all,
 *  exactly the two situations the app has: signed-in with a room, or not (yet). */
function makeDevice({ roomRef, storage = memory(), idPrefix = 'dev', clock = T_0800, online = true, timezone = MANILA } = {}) {
  const state = { online, now: clock };
  const events = { remoteChanges: [], hydrations: 0, conflicts: [] };
  const repository = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds(idPrefix), getOwner: () => ROOM });
  const boundarySync = createPersonalDayBoundarySyncBridge({
    repository,
    getRoomRef: () => (state.online ? roomRef : null),
    getRoomId: () => ROOM,
    onRemoteChange: result => events.remoteChanges.push(result),
    onHydrated: () => { events.hydrations++; },
    onConflict: result => events.conflicts.push(result),
  });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository: repository,
    planRepository: createOperationalPlanRepository({ storage: memory() }),
    boundarySync,
    planSync: null,
    now: () => state.now,
    fallbackTimezone: () => timezone,
  });
  return {
    live, repository, boundarySync, storage, events,
    setNow: v => { state.now = v; },
    goOnline: () => { state.online = true; },
    goOffline: () => { state.online = false; },
    /** What this device believes "the current/upcoming personal day" is at `t`. */
    days: t => { const d = live.planningDays(t); return { current: d.current.authority, upcoming: d.upcoming.authority, currentStart: d.current.startMs, currentBoundary: d.current.boundaryTime }; },
  };
}

const remote = roomRef => roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val() || {};
const remoteCustom = roomRef => Object.values(remote(roomRef)).filter(r => r.effectiveFromInstant !== null);

/** The PC enables 18:00 at 08:00 and (online) pushes it. */
async function pcSaves(roomRef, boundaryTime = '18:00') {
  const pc = makeDevice({ roomRef, idPrefix: 'pc' });
  pc.boundarySync.attach(); // startup hydration — an empty remote
  pc.live.proposeBoundary({ boundaryTime, timezone: MANILA }, T_0800);
  await pc.boundarySync.pushAllLocal();
  return pc;
}

// ═══════════════════════════════════════════════════════════════════════════
// A. PC config -> fresh mobile
// ═══════════════════════════════════════════════════════════════════════════

test('A: PC saves 18:00; a fresh mobile with no local cache resolves 18:00 once it syncs', async () => {
  const roomRef = fakeRoomRef();
  const pc = await pcSaves(roomRef);
  assert.equal(remoteCustom(roomRef).length, 1, 'PC pushed its revision to the account room');

  const mobile = makeDevice({ roomRef, idPrefix: 'mobile', clock: T_1900 });
  assert.equal(mobile.live.status().status, 'absent', 'a fresh mobile starts with an empty cache');
  mobile.live.attachLiveDays();

  assert.equal(mobile.live.status().status, 'custom');
  const state = mobile.live.boundaryState(T_1900);
  assert.equal(state.active.boundaryTime, '18:00');
  assert.equal(state.active.timezone, MANILA);
  assert.equal(mobile.live.enabled(), true);
  assert.ok(mobile.events.remoteChanges.length >= 1, 'the UI is told a remote revision landed, so it can recompute');
  assert.deepEqual(mobile.days(T_1900), pc.days(T_1900), 'PC and mobile derive the identical current/upcoming My Day');
});

// ═══════════════════════════════════════════════════════════════════════════
// B. stale mobile cache
// ═══════════════════════════════════════════════════════════════════════════

test('B: cloud has 18:00; a mobile whose cache is legacy/default OR an older boundary converges to 18:00', async () => {
  const roomRef = fakeRoomRef();
  // The account first used 20:00 (both devices saw it), then the PC moved to 18:00.
  const first = makeDevice({ roomRef, idPrefix: 'first' });
  first.boundarySync.attach();
  first.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA }, manila('2026-09-10', '08:00'));
  await first.boundarySync.pushAllLocal();
  const staleStorage = memory({ [SLOT]: first.storage.getItem(SLOT) });

  first.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }, T_0800);
  await first.boundarySync.pushAllLocal();
  assert.equal(remoteCustom(roomRef).length, 2);

  // (i) stale cache = an OLDER boundary
  const staleOld = makeDevice({ roomRef, storage: staleStorage, idPrefix: 'stale', clock: T_1900 });
  assert.equal(staleOld.live.boundaryState(T_1900).active.boundaryTime, '20:00', 'before sync it believes the old boundary');
  staleOld.live.attachLiveDays();
  assert.equal(staleOld.live.boundaryState(T_1900).active.boundaryTime, '18:00', 'after sync the newer authoritative revision governs');

  // (ii) stale cache = legacy/default (nothing persisted)
  const staleDefault = makeDevice({ roomRef, idPrefix: 'blank', clock: T_1900 });
  assert.equal(staleDefault.live.status().status, 'absent');
  staleDefault.live.attachLiveDays();
  assert.equal(staleDefault.live.boundaryState(T_1900).active.boundaryTime, '18:00');
  assert.deepEqual(staleDefault.days(T_1900), staleOld.days(T_1900));
  assert.deepEqual(staleDefault.days(T_1900), first.days(T_1900));
});

// ═══════════════════════════════════════════════════════════════════════════
// C. offline launch
// ═══════════════════════════════════════════════════════════════════════════

test('C: a mobile that synced 18:00 and launches OFFLINE uses its cached 18:00, never legacy/default', async () => {
  const roomRef = fakeRoomRef();
  await pcSaves(roomRef);
  const mobile = makeDevice({ roomRef, idPrefix: 'mobile', clock: T_1900 });
  mobile.live.attachLiveDays(); // synced once, cache now holds 18:00
  const cached = mobile.storage.getItem(SLOT);
  assert.ok(cached, 'the synced revision was cached locally');

  // Relaunch with no network: same storage, no room ref.
  const relaunch = makeDevice({ roomRef, storage: memory({ [SLOT]: cached }), idPrefix: 'mobile2', clock: T_1900, online: false });
  relaunch.live.attachLiveDays();
  assert.equal(relaunch.live.status().status, 'custom');
  assert.equal(relaunch.live.boundaryState(T_1900).active.boundaryTime, '18:00');
  assert.equal(relaunch.live.boundaryState(T_1900).sync, 'local-only', 'offline is reported as not-synced, never as authoritative-empty');
  assert.deepEqual(relaunch.days(T_1900), mobile.days(T_1900));
});

// ═══════════════════════════════════════════════════════════════════════════
// D. reconnect
// ═══════════════════════════════════════════════════════════════════════════

test('D: mobile launches on a stale/default cache; when the network returns the authoritative revision replaces it and the UI is told to recompute', async () => {
  const roomRef = fakeRoomRef();
  const pc = await pcSaves(roomRef);
  const mobile = makeDevice({ roomRef, idPrefix: 'mobile', clock: T_1900, online: false });

  mobile.live.attachLiveDays(); // offline: nothing to attach to
  const before = mobile.days(T_1900);
  assert.equal(before.currentBoundary, '00:00', 'while offline it can only know the default');
  assert.equal(mobile.events.remoteChanges.length, 0);

  mobile.goOnline();
  mobile.live.attachLiveDays(); // what the room-join / reconnect path does
  assert.equal(mobile.events.remoteChanges.length, 1, 'exactly one recompute signal for the arrival');
  const after = mobile.days(T_1900);
  assert.equal(after.currentBoundary, '18:00');
  assert.notDeepEqual(after, before, 'the derived current My Day actually changed');
  assert.deepEqual(after, pc.days(T_1900));
});

// ═══════════════════════════════════════════════════════════════════════════
// E. a stale device cannot erase a newer revision
// ═══════════════════════════════════════════════════════════════════════════

test('E: a device reconnecting with an OLDER cache cannot overwrite the newer revision another device made', async () => {
  const roomRef = fakeRoomRef();
  const a = makeDevice({ roomRef, idPrefix: 'a' });
  a.boundarySync.attach();
  a.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA }, manila('2026-09-10', '08:00'));
  await a.boundarySync.pushAllLocal();

  // B caches A's state at this point, then goes offline.
  const b = makeDevice({ roomRef, storage: memory({ [SLOT]: a.storage.getItem(SLOT) }), idPrefix: 'b', clock: T_1900, online: false });

  // A moves to 18:00 while B is away.
  a.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }, T_0800);
  await a.boundarySync.pushAllLocal();
  const remoteBefore = JSON.stringify(remote(roomRef));
  assert.equal(remoteCustom(roomRef).length, 2);

  // B reconnects with its stale cache and pushes everything it has.
  b.goOnline();
  const results = await b.boundarySync.pushAllLocal();
  assert.equal(JSON.stringify(remote(roomRef)), remoteBefore, 'the stale push changed nothing remotely');
  assert.ok(results.results.every(r => r.outcome === 'idempotent'), 'every stale revision was already present — nothing new, nothing overwritten');

  b.live.attachLiveDays();
  assert.equal(b.live.boundaryState(T_1900).active.boundaryTime, '18:00', 'B converged UP to A\'s newer revision');
  assert.deepEqual(b.days(T_1900), a.days(T_1900));
  assert.doesNotThrow(() => normalizeBoundaryRevisionHistory(Object.values(remote(roomRef))));
});

test('E2: arrival order is never truth — every delivery order of the same revisions yields the same history and the same boundary', async () => {
  const roomRef = fakeRoomRef();
  const a = makeDevice({ roomRef, idPrefix: 'a' });
  a.boundarySync.attach();
  a.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA }, manila('2026-09-10', '08:00'));
  a.live.proposeBoundary({ boundaryTime: '06:00', timezone: MANILA }, manila('2026-09-12', '08:00'));
  a.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }, T_0800);
  await a.boundarySync.pushAllLocal();
  const all = Object.values(remote(roomRef));
  assert.equal(all.length, 4);

  const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]];
  const seen = new Set();
  for (const order of orders) {
    const device = makeDevice({ roomRef: fakeRoomRef(), idPrefix: 'p', clock: T_1900 });
    // Deliver the revisions one at a time in this order, as separate remote snapshots.
    const delivered = {};
    for (const i of order) {
      delivered[all[i].id] = all[i];
      device.boundarySync.handleRemoteSnapshot({ ...delivered });
    }
    seen.add(JSON.stringify(device.repository.status().revisions));
    assert.equal(device.live.boundaryState(T_1900).active.boundaryTime, '18:00');
  }
  assert.equal(seen.size, 1, 'one history, regardless of arrival order');
});

// ═══════════════════════════════════════════════════════════════════════════
// F. custom 00:00 stays distinct from legacy/default
// ═══════════════════════════════════════════════════════════════════════════

test('F: a custom 00:00 revision remains CUSTOM on both devices; a device that never enabled anything stays legacy', async () => {
  const roomRef = fakeRoomRef();
  const pc = await pcSaves(roomRef, '18:00');
  pc.live.proposeBoundary({ boundaryTime: '00:00', timezone: MANILA }, manila('2026-09-17', '08:00'));
  await pc.boundarySync.pushAllLocal();
  const t = manila('2026-09-18', '12:00');

  const mobile = makeDevice({ roomRef, idPrefix: 'mobile', clock: t });
  mobile.live.attachLiveDays();
  for (const device of [pc, mobile]) {
    assert.equal(device.live.status().status, 'custom');
    assert.equal(device.live.enabled(), true, 'a custom midnight is not "off"');
    const active = device.live.boundaryState(t).active;
    assert.equal(active.boundaryTime, '00:00');
    assert.notEqual(active.effectiveFromInstant, null, 'it is a real revision, not the legacy anchor');
    assert.equal(device.live.planningDays(t).current.authority.store, 'operational', 'custom 00:00 keeps operational authority');
  }
  assert.deepEqual(mobile.days(t), pc.days(t));

  // A brand-new account (nothing anywhere) is still legacy and still writes nothing.
  const untouched = makeDevice({ roomRef: fakeRoomRef(), idPrefix: 'never' });
  untouched.live.attachLiveDays();
  assert.equal(untouched.live.status().status, 'absent');
  assert.equal(untouched.live.planningDays(t).current.authority.store, 'legacy');
  assert.equal(untouched.storage.getItem(SLOT), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// G. prospective activation is identical across devices
// ═══════════════════════════════════════════════════════════════════════════

test('G: a scheduled (not-yet-active) boundary resolves to the same current-vs-scheduled split, and the same activation instant, on both devices', async () => {
  const roomRef = fakeRoomRef();
  const pc = await pcSaves(roomRef); // 18:00 proposed at 08:00 => activates 18:00 today
  const mobile = makeDevice({ roomRef, idPrefix: 'mobile', clock: T_0800 });
  mobile.live.attachLiveDays();

  const p = pc.live.boundaryState(T_0800);
  const m = mobile.live.boundaryState(T_0800);
  assert.equal(p.active.boundaryTime, '00:00', 'still the legacy anchor before 18:00');
  assert.equal(m.active.boundaryTime, '00:00');
  assert.equal(m.pending.boundaryTime, '18:00');
  assert.equal(m.pending.effectiveFromInstant, manila(D, '18:00'));
  assert.equal(m.pending.effectiveFromInstant, p.pending.effectiveFromInstant);
  assert.deepEqual(mobile.days(T_0800), pc.days(T_0800));

  // Once the instant passes, both flip together.
  assert.deepEqual(mobile.days(T_1900), pc.days(T_1900));
  assert.equal(mobile.live.boundaryState(T_1900).active.boundaryTime, '18:00');
  assert.equal(mobile.live.boundaryState(T_1900).pending, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// H. history is never rewritten
// ═══════════════════════════════════════════════════════════════════════════

test('H: converging a device on the synced revision does not reassign an earlier day — before the effective instant it is still legacy-governed', async () => {
  const roomRef = fakeRoomRef();
  await pcSaves(roomRef);
  const mobile = makeDevice({ roomRef, idPrefix: 'mobile', clock: T_1900 });
  mobile.live.attachLiveDays();

  const earlier = manila('2026-09-15', '12:00'); // a day that finished before the boundary took effect
  const day = mobile.live.dayContaining(earlier);
  assert.equal(day.legacy, true, 'a day before the revision\'s effective instant stays legacy (calendar) authority');
  assert.equal(day.authority.store, 'legacy');
});

// ═══════════════════════════════════════════════════════════════════════════
// I. hydration: unknown is not "off"
// ═══════════════════════════════════════════════════════════════════════════

test('I: sync state is honest — local-only with no room, pending until the first authoritative snapshot, synced after', () => {
  const roomRef = fakeRoomRef();
  const mobile = makeDevice({ roomRef, idPrefix: 'mobile', online: false });
  assert.equal(mobile.live.boundaryState().sync, 'local-only', 'no room => nothing to wait for');

  // A room appears (sign-in resolved) but nothing has been heard from it yet.
  mobile.goOnline();
  assert.equal(mobile.live.boundaryState().sync, 'pending', 'room present, first snapshot not received => the true state is UNKNOWN');
  assert.equal(mobile.live.boundaryState().status, 'absent');

  mobile.live.attachLiveDays();
  assert.equal(mobile.live.boundaryState().sync, 'synced');
  assert.equal(mobile.events.hydrations, 1, 'hydration is announced exactly once so the UI can leave its neutral state');
  assert.equal(mobile.live.boundaryState().status, 'absent', 'an authoritatively-empty account really is off');

  // Later snapshots do not re-announce hydration.
  mobile.boundarySync.handleRemoteSnapshot({});
  assert.equal(mobile.events.hydrations, 1);

  // Detach (sign-out / room switch) forgets hydration.
  mobile.live.detach();
  assert.equal(mobile.live.boundaryState().sync, 'pending');
});

test('I2: a device that cannot yet tell whether the account has a boundary refuses to create one (it would mint a competing anchor)', () => {
  const roomRef = fakeRoomRef();
  const mobile = makeDevice({ roomRef, idPrefix: 'mobile' }); // room present, not yet hydrated, cache empty
  assert.equal(mobile.live.boundaryState().sync, 'pending');

  const preview = mobile.live.previewProposal({ boundaryTime: '18:00', timezone: MANILA });
  assert.equal(preview.ok, false);
  assert.equal(preview.reason, 'sync-pending');
  assert.throws(() => mobile.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }), /still loading|syncing/i);
  assert.equal(mobile.storage.getItem(SLOT), null, 'nothing was written');

  // Once the account has been heard from, the same action is allowed.
  mobile.live.attachLiveDays();
  assert.equal(mobile.live.previewProposal({ boundaryTime: '18:00', timezone: MANILA }).ok, true);
});

test('I3: a device holding a cached revision may still change it while sync is pending (a fresh unique revision is safe)', () => {
  const roomRef = fakeRoomRef();
  const seeded = makeDevice({ roomRef: null, idPrefix: 'seed', online: false });
  seeded.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA }, manila('2026-09-10', '08:00'));
  const cache = seeded.storage.getItem(SLOT);

  const device = makeDevice({ roomRef, storage: memory({ [SLOT]: cache }), idPrefix: 'dev' });
  assert.equal(device.live.boundaryState().sync, 'pending');
  assert.equal(device.live.boundaryState().status, 'custom');
  assert.equal(device.live.previewProposal({ boundaryTime: '18:00', timezone: MANILA }).ok, true);
});

test('J: the recompute signal fires once per arrival that changed the history, and not for a snapshot that adds nothing', async () => {
  const roomRef = fakeRoomRef();
  await pcSaves(roomRef);
  const mobile = makeDevice({ roomRef, idPrefix: 'mobile', clock: T_1900 });
  mobile.live.attachLiveDays();
  assert.equal(mobile.events.remoteChanges.length, 1);
  mobile.boundarySync.handleRemoteSnapshot(remote(roomRef)); // identical re-delivery
  assert.equal(mobile.events.remoteChanges.length, 1, 'no churn on a no-op snapshot');
});
