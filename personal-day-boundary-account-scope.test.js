// personal-day-boundary-account-scope.test.js
//
// The Personal Day Boundary cache is a copy of ONE account's authoritative history. A device can be
// used by more than one account (sign out, sign in as someone else) and its localStorage survives
// both. An independent review of Cross-Device Sync V1 reproduced the resulting hole: account A's
// cached revision (20:00) survived sign-out and was uploaded into account B's room — into an empty
// room, and into a room that already held B's own 18:00 history (where it silently changed B's
// effective Personal Day).
//
// The invariant under test: a revision cached for room A must NEVER be read as B's cache, affect B's
// boundary, be merged into B's local repository, be pushed to B's room, or appear in B's UI. Account
// identity is part of cache provenance.
//
// One physical device (one shared localStorage), two accounts, an in-memory fake room per account,
// no real Firebase, no network, no production data. `signIn`/`signOut` reproduce storage.js's real
// order: sign-in sets the room then attaches; sign-out detaches FIRST and clears the room after.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { boundaryCacheKeyForRoom, createPersonalDayBoundaryRepository, PERSONAL_DAY_BOUNDARY_STORAGE_KEY } from './personal-day-boundary-repository.js';
import { createPersonalDayBoundarySyncBridge, DAY_BOUNDARY_REVISIONS_REMOTE_PATH, decodeWireMap } from './personal-day-boundary-sync.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { legacyBoundaryRevision, proposeBoundaryRevision } from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';
const TOKYO = 'Asia/Tokyo';
const manila = (dateStr, hhmm) => Date.parse(`${dateStr}T${hhmm}:00+08:00`);
const D = '2026-09-16';
const T_0800 = manila(D, '08:00'); // before either 18:00 (Manila) or 20:00 (Tokyo) boundary proposed "now" activates
const T_2100 = manila(D, '21:00'); // after both

const ROOM_A = 'uid_account-a';
const ROOM_B = 'uid_account-b';
const SLOT_A = boundaryCacheKeyForRoom(ROOM_A);
const SLOT_B = boundaryCacheKeyForRoom(ROOM_B);
const LEGACY_KEY = PERSONAL_DAY_BOUNDARY_STORAGE_KEY;

const memory = (seed = null) => {
  const map = new Map();
  if (seed) Object.entries(seed).forEach(([k, v]) => map.set(k, v));
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), _map: map };
};

let seq = 0;
const seqIds = prefix => () => `${prefix}-${++seq}`;
const settle = () => new Promise(resolve => setImmediate(resolve));

/** An in-memory fake room, instrumented so a test can prove what was — and was NOT — written:
 *  every transaction is counted, every `on` callback is kept (to fire a LATE one on purpose), and
 *  `hold` keeps the first snapshot pending until `release()` (the account has not answered yet). */
function makeRoom(initial = {}, { hold = false } = {}) {
  const root = { value: initial };
  const listeners = new Map();
  const stats = { transactions: 0, committed: 0, offCalls: 0, callbacks: [], pending: [], hold };
  const get = path => path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  const fire = path => (listeners.get(path) || []).forEach(fn => fn({ val: () => get(path) ?? null }));
  function set(path, value) {
    const segs = path.split('/').filter(Boolean);
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
        stats.callbacks.push(fn);
        if (stats.hold) stats.pending.push(fn); else fn({ val: () => get(path) ?? null });
      },
      off() { stats.offCalls++; listeners.delete(path); },
      val: () => get(path) ?? null,
      listenerCount: () => (listeners.get(path) || new Set()).size,
      transaction(updateFn) {
        stats.transactions++;
        const current = get(path) ?? null;
        const next = updateFn(current);
        if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => current } });
        stats.committed++;
        set(path, next);
        return Promise.resolve({ committed: true, snapshot: { val: () => next } });
      }
    };
  }
  const ref = makeRef('');
  return {
    ref, stats,
    cloud: () => ref.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val(),
    cloudJson: () => JSON.stringify(ref.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val()),
    release() { stats.hold = false; const waiting = stats.pending.splice(0); waiting.forEach(fn => fn({ val: () => ref.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val() })); },
  };
}

/** The account's authoritative history as one of ITS OWN devices would have pushed it. */
function accountHistory({ timezone, boundaryTime, idPrefix }) {
  const anchor = legacyBoundaryRevision(timezone);
  const { revision } = proposeBoundaryRevision([anchor], { id: `${idPrefix}-rev`, boundaryTime, timezone }, T_0800);
  return { [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor, [revision.id]: revision } };
}

const idsOf = json => Object.keys(json || {}).sort();

/** ONE physical device, shared localStorage, switchable account. */
function makeDevice({ rooms, storage = memory(), clock = T_0800, idPrefix = 'dev', online = true, timezone = MANILA } = {}) {
  const auth = { room: null };
  const state = { now: clock, online };
  const events = { contextChanges: 0, remoteChanges: [], hydrations: 0, conflicts: [] };
  const repository = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds(idPrefix), getOwner: () => auth.room });
  const boundarySync = createPersonalDayBoundarySyncBridge({
    repository,
    getRoomRef: () => (auth.room && state.online ? rooms[auth.room].ref : null),
    getRoomId: () => auth.room,
    onContextChange: () => { events.contextChanges++; },
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
    storage, repository, boundarySync, live, events, auth,
    // storage.js onAuthStateChanged(user): roomCode is set, then startSync() -> attachLiveDays().
    signIn(room) { auth.room = room; live.attachLiveDays(); },
    // storage.js sign-out: Live.detach() runs while the room is still set, THEN roomCode is cleared.
    signOut() { live.detach(); auth.room = null; },
    // A direct switch (Firebase fires onAuthStateChanged(userB) with no null in between).
    switchTo(room) { auth.room = room; live.attachLiveDays(); },
    setNow: v => { state.now = v; },
    goOffline: () => { state.online = false; },
    goOnline: () => { state.online = true; },
    days: t => { const d = live.planningDays(t); return { current: d.current.authority, upcoming: d.upcoming.authority, currentStart: d.current.startMs, currentBoundary: d.current.boundaryTime }; },
  };
}

/** Account A has 20:00 (Tokyo) in its cloud AND in this device's cache; account B has its own 18:00
 *  (Manila) history in its cloud (or nothing). Returns the pieces every scenario starts from. */
async function accountAOnDevice({ bHistory = true } = {}) {
  const rooms = {
    [ROOM_A]: makeRoom(),
    [ROOM_B]: makeRoom(bHistory ? accountHistory({ timezone: MANILA, boundaryTime: '18:00', idPrefix: 'b' }) : {}),
  };
  const device = makeDevice({ rooms, idPrefix: 'a', timezone: TOKYO });
  device.signIn(ROOM_A);
  device.live.proposeBoundary({ boundaryTime: '20:00', timezone: TOKYO }, T_0800);
  await settle();
  return { rooms, device };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. the reviewer's reproduction: empty B
// ═══════════════════════════════════════════════════════════════════════════

test('A cached 20:00 -> sign out -> empty B: nothing of A reaches B\'s room, B shows nothing of A, and B may then enable normally', async () => {
  const { rooms, device } = await accountAOnDevice({ bHistory: false });
  assert.equal(idsOf(rooms[ROOM_A].cloud()).length, 2, 'precondition: A pushed its anchor + 20:00 to ITS room');
  const aSlotBefore = device.storage.getItem(SLOT_A);
  const aCloudBefore = rooms[ROOM_A].cloudJson();
  const bCloudBefore = rooms[ROOM_B].cloudJson();

  device.signOut();
  assert.equal(device.live.status().status, 'absent', 'signed out: A is no longer the ACTIVE cache');
  assert.equal(device.live.boundaryState(T_2100).active, null);

  device.signIn(ROOM_B);
  device.live.pushAllLocal(); // the reconnect hook (.info/connected) — the other path that pushes
  await device.boundarySync.pushAllLocal();
  await settle();

  assert.equal(rooms[ROOM_B].stats.transactions, 0, 'not one transaction against B\'s room');
  assert.equal(rooms[ROOM_B].cloudJson(), bCloudBefore, 'B\'s cloud is byte-identical: A\'s revisions were never written');
  assert.equal(device.live.status().status, 'absent', 'B has no trusted cache of its own, so B\'s state is empty — not A\'s');
  assert.equal(device.live.boundaryState(T_2100).active, null, 'A\'s 20:00 does not appear as B\'s Personal Day');
  assert.equal(device.live.enabled(), false);
  assert.equal(device.storage.getItem(SLOT_B), null, 'B\'s slot was not populated from A\'s');
  // A's own copies are untouched.
  assert.equal(device.storage.getItem(SLOT_A), aSlotBefore, 'A\'s cache is preserved, byte for byte, in A\'s own slot');
  assert.equal(rooms[ROOM_A].cloudJson(), aCloudBefore);

  // After B's authoritative snapshot (empty), B is authoritatively off and may enable normally.
  assert.equal(device.boundarySync.syncState(), 'synced');
  device.setNow(T_2100);
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }, T_2100);
  await settle();
  const bCloud = rooms[ROOM_B].cloud();
  assert.equal(idsOf(bCloud).length, 2, 'B now holds its OWN anchor + 18:00');
  assert.ok(Object.values(bCloud).every(r => r.timezone === MANILA), 'nothing of A\'s Tokyo timezone reached B');
  assert.equal(rooms[ROOM_A].cloudJson(), aCloudBefore, 'A\'s cloud is untouched by B\'s action');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. the reviewer's reproduction: B already has its own history (the important one)
// ═══════════════════════════════════════════════════════════════════════════

test('A cached 20:00 -> B with its own 18:00 history: B stays 18:00, B\'s cloud gains zero A revisions, B\'s cache is B-only', async () => {
  const { rooms, device } = await accountAOnDevice();
  // The legacy anchor's id is deterministic and shared by every account, so it is not an A-owned
  // fact; A's custom revision is.
  // Decoded: the wire-safe anchor encoding means the RAW cloud value no longer reads a pushed
  // anchor's effectiveFromInstant as a literal `null`.
  const aCustomIds = Object.values(decodeWireMap(rooms[ROOM_A].cloud())).filter(r => r.effectiveFromInstant !== null).map(r => r.id);
  assert.equal(aCustomIds.length, 1);
  const bCloudBefore = rooms[ROOM_B].cloudJson();

  device.signOut();
  device.signIn(ROOM_B);
  device.live.pushAllLocal();
  await settle();

  assert.equal(rooms[ROOM_B].stats.transactions, 0, 'nothing was pushed to B — B already held everything its own cache would');
  assert.equal(rooms[ROOM_B].cloudJson(), bCloudBefore, 'B\'s cloud history gained zero A revisions');
  const state = device.live.boundaryState(T_2100);
  assert.equal(state.status, 'custom');
  assert.equal(state.active.boundaryTime, '18:00', 'B\'s effective Personal Day is unchanged by A\'s later-effective 20:00');
  assert.equal(state.active.timezone, MANILA);

  const bCache = JSON.parse(device.storage.getItem(SLOT_B));
  assert.deepEqual(Object.keys(bCache.revisions).sort(), idsOf(rooms[ROOM_B].cloud()), 'B\'s local cache is exactly B\'s history');
  assert.ok(aCustomIds.every(id => !(id in bCache.revisions)), 'A\'s custom revision is not in B\'s cache');
  assert.ok(Object.values(bCache.revisions).every(r => r.timezone === MANILA), 'A\'s timezone fact does not appear in B state');

  // The derived My Day is B's, identical to what a device that only ever knew B derives.
  const bOnly = makeDevice({ rooms, idPrefix: 'bonly' });
  bOnly.signIn(ROOM_B);
  assert.deepEqual(device.days(T_2100), bOnly.days(T_2100));
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. A -> B -> A
// ═══════════════════════════════════════════════════════════════════════════

test('A -> B -> A: A\'s preserved cache is usable again, B does not pollute A, no revision is minted, the two clouds stay separate', async () => {
  const { rooms, device } = await accountAOnDevice();
  const aSlot = device.storage.getItem(SLOT_A);
  const aCloud = rooms[ROOM_A].cloudJson();
  const bCloud = rooms[ROOM_B].cloudJson();

  device.signOut();
  device.signIn(ROOM_B);
  await settle();
  const bSlot = device.storage.getItem(SLOT_B);
  assert.equal(device.live.boundaryState(T_0800).active.boundaryTime, '00:00', 'at 08:00 B\'s scheduled 18:00 has not activated: B\'s own legacy anchor governs');
  assert.equal(device.live.boundaryState(T_0800).pending.boundaryTime, '18:00', 'B\'s OWN scheduled revision is what is pending — not A\'s 20:00');

  device.signOut();
  device.signIn(ROOM_A);
  await settle();

  const state = device.live.boundaryState(T_2100);
  assert.equal(state.status, 'custom');
  assert.equal(state.active.boundaryTime, '20:00', 'A is A again');
  assert.equal(state.active.timezone, TOKYO);
  assert.equal(device.storage.getItem(SLOT_A), aSlot, 'A\'s cache is unchanged: nothing minted, nothing polluted');
  assert.equal(device.storage.getItem(SLOT_B), bSlot, 'B\'s cache is unchanged by visiting A');
  assert.equal(rooms[ROOM_A].cloudJson(), aCloud, 'A\'s cloud: no unnecessary revision');
  assert.equal(rooms[ROOM_B].cloudJson(), bCloud, 'B\'s cloud: separate and untouched');
  assert.equal(rooms[ROOM_B].stats.transactions, 0);
  assert.equal(idsOf(rooms[ROOM_A].cloud()).length, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 + 5. account switch inside ONE session (no reload), and a late callback from the old room
// ═══════════════════════════════════════════════════════════════════════════

test('a DIRECT switch A -> B (no sign-out between) re-binds the listener: B subscribes and hydrates, A\'s listener is dropped, B stays uncontaminated', async () => {
  const { rooms, device } = await accountAOnDevice();
  const bCloudBefore = rooms[ROOM_B].cloudJson();
  const contextChangesBefore = device.events.contextChanges;

  // The window between roomCode changing and startSync() attaching: A's listener still exists.
  device.auth.room = ROOM_B;
  assert.equal(device.live.status().status, 'absent', 'B\'s empty slot is what is active — A\'s cache is not visible');
  assert.equal(device.boundarySync.syncState(), 'pending', 'A\'s hydration does not carry over to B');
  // B's cache is what a push in that window would read — and it is empty, so there is nothing to push.
  assert.deepEqual(await device.boundarySync.pushAllLocal(), { committed: false, results: [] });
  assert.equal(rooms[ROOM_B].stats.transactions, 0, 'nothing pushed in that window');

  device.live.attachLiveDays(); // startSync()

  assert.ok(rooms[ROOM_A].stats.offCalls >= 1, 'A\'s listener was removed');
  assert.equal(rooms[ROOM_B].ref.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).listenerCount(), 1, 'B is now subscribed (previously attach() was a no-op while any listener existed)');
  assert.equal(device.boundarySync.syncState(), 'synced', 'B hydrated from B\'s own snapshot');
  assert.ok(device.events.contextChanges > contextChangesBefore, 'derived Personal Day state is told the active cache changed hands (PlanAuthority invalidation hook)');
  assert.equal(device.live.boundaryState(T_2100).active.boundaryTime, '18:00', 'surfaces recompute from B only');
  assert.equal(rooms[ROOM_B].cloudJson(), bCloudBefore);
  assert.equal(rooms[ROOM_B].stats.transactions, 0);
});

test('binding a room only announces a context change when derived state can differ — accounts that never enabled the boundary are not made to repaint', async () => {
  const rooms = { [ROOM_A]: makeRoom(), [ROOM_B]: makeRoom(), 'uid_c': makeRoom(accountHistory({ timezone: MANILA, boundaryTime: '18:00', idPrefix: 'c' })) };
  const device = makeDevice({ rooms, idPrefix: 'ctx' });

  device.signIn(ROOM_A); // never enabled
  device.switchTo(ROOM_B); // never enabled, following another that never did
  assert.equal(device.events.contextChanges, 0, 'nothing derived from the boundary can have changed');

  device.switchTo('uid_c'); // an account with a boundary: a cache is now active
  assert.equal(device.events.contextChanges, 1);
  device.switchTo(ROOM_A); // back to one without: the surfaces still reflect the previous cache, so they must revert
  assert.equal(device.events.contextChanges, 2);
  device.switchTo(ROOM_B); // and now neither side had one
  assert.equal(device.events.contextChanges, 2);
});

test('a late callback from the old room (A) after the switch to B cannot mutate B', async () => {
  const { rooms, device } = await accountAOnDevice();
  const lateA = rooms[ROOM_A].stats.callbacks.at(-1);
  assert.equal(typeof lateA, 'function', 'precondition: A\'s live listener callback is available to fire late');

  device.switchTo(ROOM_B);
  await settle();
  const bSlot = device.storage.getItem(SLOT_B);
  const bCloud = rooms[ROOM_B].cloudJson();

  // An in-flight A event arrives now, carrying A's 20:00 plus a newer A revision from another A device.
  const aNow = rooms[ROOM_A].cloud();
  const aLater = accountHistory({ timezone: TOKYO, boundaryTime: '22:00', idPrefix: 'a-other' })[DAY_BOUNDARY_REVISIONS_REMOTE_PATH];
  lateA({ val: () => ({ ...aNow, ...aLater }) });
  await settle();

  assert.equal(device.storage.getItem(SLOT_B), bSlot, 'B\'s cache is unchanged');
  assert.equal(device.storage.getItem(SLOT_B) === null ? null : Object.keys(JSON.parse(device.storage.getItem(SLOT_B)).revisions).some(id => id.startsWith('a-')), false, 'no A id in B\'s cache');
  assert.equal(device.live.boundaryState(T_2100).active.boundaryTime, '18:00');
  assert.equal(rooms[ROOM_B].cloudJson(), bCloud);
  assert.equal(rooms[ROOM_B].stats.transactions, 0);
  // The lowest-level entry point drops it explicitly too.
  assert.equal(device.boundarySync.handleRemoteSnapshot({ ...aNow, ...aLater }, ROOM_A), false, 'a snapshot for a room that is not the joined one is refused');
  assert.equal(device.boundarySync.handleRemoteSnapshot({ ...aNow }, null), false);
});

test('a late callback after SIGN-OUT (no room at all) is dropped and nothing is cached for nobody', async () => {
  const { rooms, device } = await accountAOnDevice();
  const lateA = rooms[ROOM_A].stats.callbacks.at(-1);
  const aSlot = device.storage.getItem(SLOT_A);
  device.signOut();
  const keysBefore = [...device.storage._map.keys()].sort();

  lateA({ val: () => accountHistory({ timezone: TOKYO, boundaryTime: '22:00', idPrefix: 'a-late' })[DAY_BOUNDARY_REVISIONS_REMOTE_PATH] });

  assert.deepEqual([...device.storage._map.keys()].sort(), keysBefore, 'no new slot appeared');
  assert.equal(device.storage.getItem(SLOT_A), aSlot, 'not even A\'s own slot was changed by a callback that arrived after A left');
  assert.equal(device.live.status().status, 'absent');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. the push-side hard guard, at the lowest practical API
// ═══════════════════════════════════════════════════════════════════════════

test('WRONG ROOM: cache owner A + active remote room B -> pushRevision / pushAllLocal refuse, zero writes, no silent re-owning', async () => {
  const rooms = { [ROOM_A]: makeRoom(), [ROOM_B]: makeRoom() };
  const storage = memory();
  // Build A's cache honestly, in A's slot.
  const aRepo = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds('a'), getOwner: () => ROOM_A });
  const { revision } = aRepo.propose({ boundaryTime: '20:00', timezone: TOKYO }, T_0800);
  const aSlot = storage.getItem(SLOT_A);

  // The impossible-by-lifecycle situation, constructed deliberately: the cache is A's, the room is B's.
  const bridge = createPersonalDayBoundarySyncBridge({ repository: aRepo, getRoomRef: () => rooms[ROOM_B].ref, getRoomId: () => ROOM_B });

  assert.deepEqual(await bridge.pushRevision(revision), { committed: false, outcome: 'owner-mismatch' });
  const all = await bridge.pushAllLocal();
  assert.equal(all.committed, false);
  assert.equal(all.outcome, 'owner-mismatch');
  assert.deepEqual(all.results, []);

  assert.equal(rooms[ROOM_B].stats.transactions, 0, 'no transaction was even attempted against B');
  assert.equal(rooms[ROOM_B].cloud(), null, 'B\'s room holds nothing');
  assert.equal(aRepo.ownerRoomId(), ROOM_A, 'the cache was not re-attributed to B');
  assert.equal(storage.getItem(SLOT_A), aSlot);
  assert.equal(storage.getItem(SLOT_B), null, 'and no B slot was created to make the push "fit"');
});

test('WRONG ROOM: an unknown room identity, an unscoped (plain) repository, or a mismatched identity never push either', async () => {
  const room = makeRoom();
  const storage = memory();
  const scoped = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds('s'), getOwner: () => ROOM_A });
  const { revision } = scoped.propose({ boundaryTime: '20:00', timezone: TOKYO }, T_0800);

  const unknownIdentity = createPersonalDayBoundarySyncBridge({ repository: scoped, getRoomRef: () => room.ref, getRoomId: () => null });
  const plain = createPersonalDayBoundaryRepository({ storage: memory(), idGenerator: seqIds('p') });
  plain.propose({ boundaryTime: '20:00', timezone: TOKYO }, T_0800);
  const plainBridge = createPersonalDayBoundarySyncBridge({ repository: plain, getRoomRef: () => room.ref, getRoomId: () => ROOM_A });
  const noIdentityWiredAtAll = createPersonalDayBoundarySyncBridge({ repository: scoped, getRoomRef: () => room.ref });

  for (const bridge of [unknownIdentity, plainBridge, noIdentityWiredAtAll]) {
    assert.equal((await bridge.pushRevision(revision)).outcome, 'owner-mismatch');
    assert.equal((await bridge.pushAllLocal()).outcome, 'owner-mismatch');
  }
  assert.equal(room.stats.transactions, 0);
});

test('a room switch BETWEEN transaction attempts aborts the retry with zero writes (never validates or writes against the new account\'s cache)', async () => {
  const auth = { room: ROOM_A };
  const room = makeRoom();
  const storage = memory();
  const repo = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds('a'), getOwner: () => auth.room });
  const { revision } = repo.propose({ boundaryTime: '20:00', timezone: TOKYO }, T_0800);
  // A ref whose transaction is re-run against fresh data — after the account has changed.
  const flakyRef = {
    child() {
      return {
        transaction(updateFn) {
          updateFn(null);
          auth.room = ROOM_B; // the account changes before Firebase re-invokes the update function
          const next = updateFn(null);
          return Promise.resolve({ committed: next !== undefined });
        }
      };
    }
  };
  const bridge = createPersonalDayBoundarySyncBridge({ repository: repo, getRoomRef: () => flakyRef, getRoomId: () => auth.room });
  const result = await bridge.pushRevision(revision);
  assert.deepEqual(result, { committed: false, outcome: 'owner-mismatch' });
  assert.equal(room.stats.transactions, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. legacy, unowned cache
// ═══════════════════════════════════════════════════════════════════════════

/** A device that upgraded with the pre-scoping cache (`ta3-day-boundary-revisions-v1`, no owner). */
function legacyDevice({ rooms, timezone = TOKYO } = {}) {
  const storage = memory();
  const plain = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds('legacy') });
  plain.propose({ boundaryTime: '20:00', timezone }, T_0800);
  const payload = storage.getItem(LEGACY_KEY);
  assert.ok(payload, 'precondition: the unowned legacy cache exists');
  return { storage, payload, device: makeDevice({ rooms, storage, idPrefix: 'up', timezone }) };
}

test('an UNOWNED legacy cache is never uploaded to whichever account signs in — empty room', async () => {
  const rooms = { [ROOM_B]: makeRoom() };
  const { device, payload, storage } = legacyDevice({ rooms });

  device.signIn(ROOM_B);
  device.live.pushAllLocal();
  await device.boundarySync.pushAllLocal();
  await settle();

  assert.equal(rooms[ROOM_B].stats.transactions, 0, 'no transaction against B');
  assert.equal(rooms[ROOM_B].cloud(), null, 'B\'s room is still authoritatively empty');
  assert.equal(device.live.status().status, 'absent', 'the legacy payload is not treated as B\'s cache');
  assert.equal(device.live.boundaryState(T_2100).active, null);
  assert.equal(storage.getItem(LEGACY_KEY), payload, 'the legacy payload is preserved, untouched — quarantined, not deleted, not adopted');
  assert.equal(storage.getItem(SLOT_B), null);
});

test('an UNOWNED legacy cache + B\'s authoritative snapshot: B\'s own history becomes B\'s trusted cache; the legacy payload stays inert', async () => {
  const rooms = { [ROOM_B]: makeRoom(accountHistory({ timezone: MANILA, boundaryTime: '18:00', idPrefix: 'b' })) };
  const { device, payload, storage } = legacyDevice({ rooms });
  const bCloudBefore = rooms[ROOM_B].cloudJson();

  device.signIn(ROOM_B);
  await settle();

  assert.equal(rooms[ROOM_B].stats.transactions, 0);
  assert.equal(rooms[ROOM_B].cloudJson(), bCloudBefore);
  const cached = JSON.parse(storage.getItem(SLOT_B));
  assert.deepEqual(Object.keys(cached.revisions).sort(), idsOf(rooms[ROOM_B].cloud()), 'the account-scoped cache IS B\'s remote truth');
  assert.equal(device.live.boundaryState(T_2100).active.boundaryTime, '18:00');
  assert.equal(storage.getItem(LEGACY_KEY), payload, 'still untouched');
});

test('legacy ownership cannot be proven from app state, so it is NEVER adopted — even for the account that really made it (one-time re-hydration)', async () => {
  // Same account, upgraded device, legacy cache that happens to equal its own cloud history. The
  // app persists no uid for it (a `uid_<uid>` room is never stored), so there is nothing to prove
  // it with; the account's slot is populated by ITS snapshot instead.
  const history = accountHistory({ timezone: TOKYO, boundaryTime: '20:00', idPrefix: 'a' });
  const rooms = { [ROOM_A]: makeRoom(history) };
  const storage = memory({ [LEGACY_KEY]: JSON.stringify({ schemaVersion: 1, revisions: history[DAY_BOUNDARY_REVISIONS_REMOTE_PATH] }) });
  const device = makeDevice({ rooms, storage, timezone: TOKYO });

  device.goOffline();
  device.signIn(ROOM_A);
  assert.equal(device.live.status().status, 'absent', 'offline on the first launch after upgrade there is nothing trusted yet');
  device.goOnline();
  device.live.attachLiveDays();

  assert.equal(device.live.status().status, 'custom', 'once the snapshot arrives the account is fully configured');
  assert.equal(device.live.boundaryState(T_2100).active.boundaryTime, '20:00');
  assert.ok(storage.getItem(SLOT_A), 'the account-scoped cache exists now, from the snapshot');
  assert.equal(rooms[ROOM_A].stats.transactions, 0, 'and nothing was uploaded');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. same-account offline behavior survives
// ═══════════════════════════════════════════════════════════════════════════

test('same-account offline: A synced 18:00, launches offline later — once A\'s identity is known its OWN cache provides 18:00 (local-only)', async () => {
  const rooms = { [ROOM_A]: makeRoom() };
  const storage = memory();
  const first = makeDevice({ rooms, storage, idPrefix: 'a1' });
  first.signIn(ROOM_A);
  first.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }, T_0800);
  await settle();
  const cloud = rooms[ROOM_A].cloudJson();

  const relaunch = makeDevice({ rooms, storage, idPrefix: 'a2', clock: T_2100, online: false });
  // Before auth answers: no identity, so no cache is active and the state is neutral, not A's and not "Off".
  assert.equal(relaunch.live.status().status, 'absent');
  assert.equal(relaunch.live.boundaryState(T_2100).sync, 'pending');
  relaunch.signIn(ROOM_A); // identity restored offline; the room ref is unreachable
  assert.equal(relaunch.live.status().status, 'custom');
  assert.equal(relaunch.live.boundaryState(T_2100).active.boundaryTime, '18:00');
  assert.equal(relaunch.live.boundaryState(T_2100).sync, 'local-only', 'reported as not-synced, never as authoritative-empty');

  relaunch.goOnline();
  relaunch.live.attachLiveDays();
  await settle();
  assert.equal(relaunch.boundarySync.syncState(), 'synced');
  assert.equal(rooms[ROOM_A].cloudJson(), cloud, 'reconnecting minted nothing');
});

test('stale same-account cache still converges to the newer cloud truth, and a stale device still cannot overwrite a newer revision', async () => {
  const rooms = { [ROOM_A]: makeRoom() };
  const storage = memory();
  const stale = makeDevice({ rooms, storage, idPrefix: 'stale', online: false });
  stale.signIn(ROOM_A);
  stale.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }, T_0800); // cached only — offline
  const other = makeDevice({ rooms, idPrefix: 'pc' });
  other.signIn(ROOM_A);
  other.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA }, T_0800 + 60_000);
  await settle();

  stale.goOnline();
  stale.live.attachLiveDays();
  await settle();
  const remote = Object.values(rooms[ROOM_A].cloud());
  const staleRevs = stale.live.status().revisions;
  assert.ok(staleRevs.some(r => r.boundaryTime === '20:00'), 'the stale device converged on the newer cloud revision');
  assert.ok(remote.some(r => r.boundaryTime === '20:00'), 'and never overwrote it');
});

// ═══════════════════════════════════════════════════════════════════════════
// 10/11. custom 00:00, scheduled, and pending vs authoritatively-empty — under scoping
// ═══════════════════════════════════════════════════════════════════════════

test('custom 00:00 stays distinct from "never enabled" per account: A\'s 00:00 is A\'s, B (never enabled) is Off, and A is 00:00 again on return', async () => {
  const rooms = { [ROOM_A]: makeRoom(), [ROOM_B]: makeRoom() };
  const device = makeDevice({ rooms, idPrefix: 'z' });
  device.signIn(ROOM_A);
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }, T_0800);
  device.live.proposeBoundary({ boundaryTime: '00:00', timezone: MANILA }, T_2100);
  await settle();
  assert.equal(device.live.enabled(), true, 'a custom 00:00 history is enabled, not "absent"');
  assert.equal(device.live.status().status, 'custom');

  device.signOut();
  device.signIn(ROOM_B);
  assert.equal(device.live.enabled(), false, 'B never enabled: A\'s custom 00:00 does not make B "custom"');
  assert.equal(device.live.status().status, 'absent');

  device.signOut();
  device.signIn(ROOM_A);
  assert.equal(device.live.enabled(), true);
  assert.ok(device.live.status().revisions.some(r => r.boundaryTime === '00:00' && r.effectiveFromInstant !== null), 'the explicit 00:00 revision is still there');
});

test('B joined but not yet heard is PENDING (Save refused); after its authoritative empty snapshot it is "off" and Save is allowed', async () => {
  const rooms = { [ROOM_A]: makeRoom(), [ROOM_B]: makeRoom({}, { hold: true }) };
  const device = makeDevice({ rooms, idPrefix: 'p' });
  device.signIn(ROOM_B);

  assert.equal(device.boundarySync.syncState(), 'pending');
  assert.equal(device.live.boundaryState().sync, 'pending');
  assert.throws(() => device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }, T_0800), /still loading/);
  assert.equal(device.live.previewProposal({ boundaryTime: '18:00', timezone: MANILA }).reason, 'sync-pending');
  assert.equal(device.storage.getItem(SLOT_B), null, 'the refused save wrote nothing');

  rooms[ROOM_B].release(); // the account answers: empty
  assert.equal(device.boundarySync.syncState(), 'synced');
  assert.equal(device.events.hydrations, 1);
  device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }, T_0800);
  await settle();
  assert.equal(device.live.status().status, 'custom');
  assert.equal(idsOf(rooms[ROOM_B].cloud()).length, 2);
});

test('no room identity at all (signed out / auth not answered): the account is unknown — pending, no cache active, and no save', async () => {
  const rooms = { [ROOM_A]: makeRoom() };
  const device = makeDevice({ rooms, idPrefix: 'u' });
  assert.equal(device.boundarySync.syncState(), 'pending');
  assert.equal(device.live.status().status, 'absent');
  assert.throws(() => device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }, T_0800), /still loading/);
  assert.equal(device.storage._map.size, 0, 'nothing was written for nobody');
});

// ═══════════════════════════════════════════════════════════════════════════
// repository: the slots themselves
// ═══════════════════════════════════════════════════════════════════════════

test('repository: each account has its own slot, the active one follows the owner, and the unowned legacy key is never read or written', () => {
  const storage = memory({ [LEGACY_KEY]: JSON.stringify({ schemaVersion: 1, revisions: { 'legacy-x': { id: 'legacy-x' } } }) });
  const auth = { room: ROOM_A };
  const repo = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds('r'), getOwner: () => auth.room });

  assert.equal(repo.status().status, 'absent', 'a malformed/foreign legacy payload does not even register (never read)');
  repo.propose({ boundaryTime: '20:00', timezone: TOKYO }, T_0800);
  assert.ok(storage.getItem(SLOT_A));
  assert.equal(repo.ownerRoomId(), ROOM_A);

  auth.room = ROOM_B;
  assert.equal(repo.status().status, 'absent', 'B does not see A\'s cache');
  assert.deepEqual(repo.listAllRaw(), []);
  repo.propose({ boundaryTime: '18:00', timezone: MANILA }, T_0800);
  assert.ok(storage.getItem(SLOT_B));
  assert.notEqual(storage.getItem(SLOT_A), storage.getItem(SLOT_B));

  auth.room = null;
  assert.equal(repo.ownerRoomId(), null);
  assert.equal(repo.status().status, 'absent', 'no room joined: no active cache');
  assert.deepEqual(repo.listAllRaw(), []);
  assert.deepEqual(repo.mergeRemoteRevisions({ x: { id: 'x' } }), { changed: false, changedIds: [], rejectedIds: [], droppedIds: [], conflict: null });
  assert.throws(() => repo.propose({ boundaryTime: '18:00', timezone: MANILA }, T_0800), /No account is active/);
  assert.equal(repo.read(MANILA).length, 1, 'read() still hands the model an ephemeral legacy anchor — never persisted');

  assert.equal(storage.getItem(LEGACY_KEY), JSON.stringify({ schemaVersion: 1, revisions: { 'legacy-x': { id: 'legacy-x' } } }), 'the legacy key was never touched');
});

test('repository: a plain repository over an injected storage is unscoped (semantics tests), a real-storage default is scoped to the joined room', () => {
  const plainStorage = memory();
  const plain = createPersonalDayBoundaryRepository({ storage: plainStorage, idGenerator: seqIds('pl') });
  plain.propose({ boundaryTime: '18:00', timezone: MANILA }, T_0800);
  assert.ok(plainStorage.getItem(LEGACY_KEY), 'plain: one unowned slot at `key`');
  assert.equal(plain.ownerRoomId(), null);

  const saved = globalThis.localStorage;
  const fake = memory();
  globalThis.localStorage = fake;
  try {
    globalThis.getChronaSenseRoomCode = () => ROOM_A;
    const real = createPersonalDayBoundaryRepository({ idGenerator: seqIds('real') });
    assert.equal(real.ownerRoomId(), ROOM_A, 'the default over real storage follows storage.js\'s joined room');
    real.propose({ boundaryTime: '18:00', timezone: MANILA }, T_0800);
    assert.ok(fake.getItem(SLOT_A));
    assert.equal(fake.getItem(LEGACY_KEY), null);
    globalThis.getChronaSenseRoomCode = () => { throw new Error('storage.js still parsing'); };
    assert.equal(real.ownerRoomId(), null, 'an accessor that throws means "unknown", never a crash and never a guess');
  } finally {
    delete globalThis.getChronaSenseRoomCode;
    if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// wiring guards (source-level: index.html / storage.js are classic scripts, not importable)
// ═══════════════════════════════════════════════════════════════════════════

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');

test('wiring: storage.js exposes the room identity and recomputes derived state on sign-out', () => {
  const storage = source('./storage.js');
  assert.match(storage, /globalThis\.getChronaSenseRoomCode = \(\) => roomCode;/);
  const signedOut = storage.slice(storage.indexOf("currentUser = null;"), storage.indexOf("document.getElementById('signin-overlay').style.display = 'flex'"));
  assert.match(signedOut, /PersonalDayBoundaryLive\.detach\(\)/, 'A\'s listeners are detached');
  assert.ok(signedOut.indexOf("roomCode = ''") < signedOut.indexOf('refreshPersonalDayBoundaryLive'), 'derived state is recomputed AFTER the room is cleared, so it cannot still read A\'s cache');
});

test('wiring: the production bridge is given the room identity and recomputes when a room is bound', () => {
  const sync = source('./personal-day-boundary-sync.js');
  const singleton = sync.slice(sync.indexOf("if (typeof window !== 'undefined')"));
  assert.match(singleton, /getRoomId: appRoomOwner/);
  assert.match(singleton, /onContextChange: \(\) => \{[\s\S]*refreshPersonalDayBoundaryLive/);
});

test('wiring: the first-paint probe no longer trusts the unowned key — it reads only the joined room\'s slot, and stays neutral while the room is unknown', () => {
  const html = source('./index.html');
  const probe = html.slice(html.indexOf('function personalDayBoundaryConfigured()'), html.indexOf('function legacyPlanTarget'));
  assert.match(probe, /getChronaSenseRoomCode/);
  assert.match(probe, /localStorage\.getItem\(base \+ ':' \+ room\)/, 'with a room joined only ITS slot answers');
  assert.doesNotMatch(probe, /localStorage\.getItem\('ta3-day-boundary-revisions-v1'\)/, 'the old unscoped read is gone');
});
