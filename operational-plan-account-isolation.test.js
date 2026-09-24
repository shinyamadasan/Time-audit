// operational-plan-account-isolation.test.js
//
// Operational Plan Cross-Account Isolation V1. The operational-plan cache used to be ONE unscoped
// localStorage key (`ta3-operational-plans-v1`). After a direct account switch (A -> B, no sign-out,
// no reload) storage.js's reconnect hook ran PersonalDayBoundaryLive.pushAllLocal(), which pushed
// every record in that key into whatever room was joined — B's. Reproduced before the fix: the first
// wrong write was a transaction at rooms/uid_B/operationalPlans/<A's day> carrying A's task.
//
// The invariant under test: no local operational-plan fact is pushed into a room unless the cache it
// came from is provably that room's (activeRoom == cacheOwner == pushRoom); a callback from a room the
// device has left never touches the active cache; an unowned (pre-scoping) cache is never uploaded or
// adopted; and PlanAuthority only ever resolves the active account's plans.
//
// One physical device (one shared storage), two accounts, an instrumented in-memory fake room per
// account. No real Firebase, no network, no production data. The account-switch helpers reproduce
// storage.js's real order:
//   signIn / directSwitch: onAuthStateChanged(user) sets roomCode, startSync() -> attachLiveDays(),
//                          then `.info/connected` -> pushAllLocal(). No teardown on a direct switch.
//   signOut:               PersonalDayBoundaryLive.detach() while the room is still set, THEN roomCode = ''.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlanAuthority } from './plan-authority.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createPersonalDayBoundarySyncBridge, DAY_BOUNDARY_REVISIONS_REMOTE_PATH } from './personal-day-boundary-sync.js';
import { createOperationalPlanRepository, operationalPlanCacheKeyForRoom, OPERATIONAL_PLAN_STORAGE_KEY } from './operational-plan-repository.js';
import { createOperationalPlanSyncBridge, OPERATIONAL_PLANS_REMOTE_PATH, toFirebaseSafeKey, fromFirebaseSafeKey } from './operational-plan-sync.js';
import { legacyBoundaryRevision, proposeBoundaryRevision, operationalDayContaining, nextOperationalDay, operationalDayId } from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';
const manila = (dateStr, hhmm) => Date.parse(`${dateStr}T${hhmm}:00+08:00`);
const D_PREV = '2026-09-15';
const D = '2026-09-16';
const NOW = manila(D, '08:00'); // inside the personal day that began at 18:00 on D_PREV

const ROOM_A = 'uid_account-a';
const ROOM_B = 'uid_account-b';
const SLOT_A = operationalPlanCacheKeyForRoom(ROOM_A);
const SLOT_B = operationalPlanCacheKeyForRoom(ROOM_B);
const UNSCOPED = OPERATIONAL_PLAN_STORAGE_KEY;

const memory = (seed = null) => {
  const map = new Map();
  if (seed) Object.entries(seed).forEach(([k, v]) => map.set(k, v));
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), _map: map };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

/** Each account's authoritative boundary history, as ITS OWN devices pushed it: an 18:00 Manila
 *  boundary effective since 18:00 on D_PREV. The revision id is the account's own. */
function boundaryHistory(revisionId) {
  const anchor = legacyBoundaryRevision(MANILA);
  const { revisions } = proposeBoundaryRevision([anchor], { id: revisionId, boundaryTime: '18:00', timezone: MANILA }, manila(D_PREV, '08:00'));
  return { revisions, map: Object.fromEntries(revisions.map(r => [r.id, r])) };
}
const HISTORY_A = boundaryHistory('a-rev');
const HISTORY_B = boundaryHistory('b-rev');

function dayIds(history, nowMs = NOW) {
  const current = operationalDayContaining(nowMs, history.revisions);
  const upcoming = nextOperationalDay(current, history.revisions);
  return { current: operationalDayId(current), upcoming: operationalDayId(upcoming) };
}
const DAYS_A = dayIds(HISTORY_A);
const DAYS_B = dayIds(HISTORY_B);

/** Every commit into `room` carried only that account's own facts (task prefix). Same-account
 *  re-pushes of an already-converged record are legitimate idempotent merges, so commits are not
 *  forbidden — foreign facts are. */
const onlyOwnFactsCommitted = (room, prefix) => room.stats.commitLog.every(c => c.tasks.every(t => t.startsWith(prefix)));

const item = (id, task, extra = {}) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'device-x', ...extra });
const planRecord = items => ({ items, updatedAt: 1000, updatedBy: 'other-device' });

/** An instrumented in-memory room. Counts every transaction on operationalPlans (and whether it
 *  committed), keeps every `on` callback with its path so a test can fire a LATE one on purpose,
 *  supports `once`, and can DEFER transactions so a test can switch accounts mid-flight. */
function makeRoom(name, initial = {}) {
  const root = { value: JSON.parse(JSON.stringify(initial)) };
  const listeners = new Map();
  const stats = { planTransactions: 0, planCommits: 0, commitLog: [], callbacks: [], deferred: null };
  const get = path => path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  function set(path, value) {
    const segs = path.split('/').filter(Boolean);
    let node = root.value;
    for (let i = 0; i < segs.length - 1; i++) {
      if (typeof node[segs[i]] !== 'object' || node[segs[i]] === null) node[segs[i]] = {};
      node = node[segs[i]];
    }
    node[segs[segs.length - 1]] = value;
    for (let i = segs.length; i >= 0; i--) {
      const p = segs.slice(0, i).join('/');
      (listeners.get(p) || []).forEach(fn => fn({ val: () => get(p) ?? null }));
    }
  }
  function runTransaction(path, updateFn, { beforeRetry } = {}) {
    let next = updateFn(get(path) ?? null);
    if (beforeRetry) { beforeRetry(); next = updateFn(get(path) ?? null); } // Firebase re-runs against fresh data
    if (next === undefined) return { committed: false, snapshot: { val: () => get(path) ?? null } };
    stats.planCommits++;
    stats.commitLog.push({ path, tasks: (next.items || []).map(i => i.task) });
    set(path, next);
    return { committed: true, snapshot: { val: () => next } };
  }
  function makeRef(path) {
    return {
      path,
      child(seg) { return makeRef(path ? `${path}/${seg}` : seg); },
      on(_event, fn) {
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(fn);
        stats.callbacks.push({ path, fn });
        fn({ val: () => get(path) ?? null });
      },
      off() { listeners.delete(path); },
      once() { return Promise.resolve({ val: () => get(path) ?? null }); },
      val: () => get(path) ?? null,
      transaction(updateFn) {
        if (path.startsWith(OPERATIONAL_PLANS_REMOTE_PATH)) stats.planTransactions++;
        if (stats.deferred) {
          return new Promise(resolve => stats.deferred.push(opts => resolve(runTransaction(path, updateFn, opts))));
        }
        return Promise.resolve(runTransaction(path, updateFn));
      },
    };
  }
  const ref = makeRef('');
  return {
    name, ref, stats,
    plans: () => ref.child(OPERATIONAL_PLANS_REMOTE_PATH).val() || {},
    planFor: id => ref.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(id)).val(),
    tasks: () => Object.values(ref.child(OPERATIONAL_PLANS_REMOTE_PATH).val() || {}).flatMap(r => (r.items || []).map(i => i.task)),
    seedPlan(id, record) { set(`${OPERATIONAL_PLANS_REMOTE_PATH}/${toFirebaseSafeKey(id)}`, record); },
    defer() { stats.deferred = []; },
    flush(opts) { const waiting = stats.deferred.splice(0); stats.deferred = null; waiting.forEach(run => run(opts)); },
    /** Fire every retained callback for a path — i.e. a LATE delivery from a listener the app detached. */
    fireLate(path) { stats.callbacks.filter(c => c.path === path).forEach(c => c.fn({ val: () => get(path) ?? null })); },
  };
}

function roomWithAccount(name, history, plans = {}) {
  const room = makeRoom(name, { [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: history.map });
  Object.entries(plans).forEach(([id, record]) => room.seedPlan(id, record));
  room.stats.planCommits = 0;
  return room;
}

/** ONE physical device: shared storage, switchable account, the real repositories/bridges/wiring and
 *  PlanAuthority composed exactly as the browser singletons are, scoped by the joined room. */
function makeDevice({ rooms, storage = memory(), online = true } = {}) {
  const auth = { room: null };
  const state = { online, remoteChanges: [] };
  const getRoomRef = () => (auth.room && state.online ? rooms[auth.room].ref : null);
  const getRoomId = () => auth.room;
  let seq = 0;
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage, idGenerator: () => `dev-${++seq}`, getOwner: getRoomId });
  const boundarySync = createPersonalDayBoundarySyncBridge({ repository: boundaryRepository, getRoomRef, getRoomId });
  const planRepository = createOperationalPlanRepository({ storage, getOwner: getRoomId });
  const planSync = createOperationalPlanSyncBridge({
    repository: planRepository, getRoomRef, getRoomId,
    onRemoteChange: (id, record) => state.remoteChanges.push({ room: auth.room, id, tasks: (record?.items || []).map(i => i.task) }),
  });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository, boundarySync, planSync,
    legacyPlans: { readItems: () => [], saveItems: () => {} },
    now: () => NOW, deviceId: () => 'device-x', fallbackTimezone: () => MANILA,
  });
  const authority = createPlanAuthority({
    live,
    legacy: { record: () => null, rawItems: () => [], saveItems: () => {}, confirm: () => ({ localSaved: true, syncPromise: Promise.resolve(false) }), allPlans: () => ({}), earliestPlanDate: () => null },
    now: () => NOW,
    accountTimezone: () => MANILA,
  });
  const reconnectHook = () => { if (getRoomRef()) live.pushAllLocal(); };
  return {
    storage, auth, state, live, authority, planRepository, planSync,
    signIn(room) { auth.room = room; live.attachLiveDays(); reconnectHook(); return settle(); },
    directSwitch(room) { auth.room = room; live.attachLiveDays(); reconnectHook(); return settle(); },
    signOut() { live.detach(); auth.room = null; return settle(); },
    goOffline() { state.online = false; },
    reconnect() { state.online = true; live.attachLiveDays(); reconnectHook(); return settle(); },
    visibleTasks() {
      const t = [authority.current(), authority.upcoming()];
      return t.flatMap(target => authority.items(target).map(i => i.task));
    },
    slot: key => (storage.getItem(key) === null ? null : JSON.parse(storage.getItem(key))),
    slotTasks(key) {
      const env = storage.getItem(key) === null ? null : JSON.parse(storage.getItem(key));
      return env ? Object.values(env.plans).flatMap(r => (r.items || []).map(i => i.task)) : [];
    },
  };
}

async function deviceWithAPlan({ roomsInit = {} } = {}) {
  const rooms = { [ROOM_A]: roomWithAccount('A', HISTORY_A, roomsInit.A), [ROOM_B]: roomWithAccount('B', HISTORY_B, roomsInit.B) };
  const device = makeDevice({ rooms });
  await device.signIn(ROOM_A);
  device.authority.saveItems(device.authority.upcoming(), [item('pA1', 'A-PRIVATE-TASK')]);
  await settle();
  assert.deepEqual(rooms[ROOM_A].tasks(), ['A-PRIVATE-TASK'], 'precondition: A legitimately syncs its own plan into its own room');
  rooms[ROOM_B].stats.planTransactions = 0;
  rooms[ROOM_B].stats.planCommits = 0;
  return { rooms, device };
}

// ── 1 / 9 (spec): A local plan -> empty B, direct switch ────────────────────

test('1. A local plan -> direct switch to an empty B: B stays empty, zero plan transactions into B', async () => {
  const rooms = { [ROOM_A]: roomWithAccount('A', HISTORY_A), [ROOM_B]: makeRoom('B') }; // B: never enabled anything
  const device = makeDevice({ rooms });
  await device.signIn(ROOM_A);
  device.authority.saveItems(device.authority.upcoming(), [item('pA1', 'A-PRIVATE-TASK')]);
  await settle();
  await device.directSwitch(ROOM_B);
  device.live.pushAllLocal(); // a second reconnect for good measure
  await settle();
  assert.equal(rooms[ROOM_B].stats.planTransactions, 0, 'not one transaction was even attempted against B');
  assert.deepEqual(rooms[ROOM_B].plans(), {});
  assert.deepEqual(device.visibleTasks(), [], 'A plan does not appear under B');
  assert.equal(device.slot(SLOT_B), null, 'B has no cache on this device, and none was minted from A');
  assert.deepEqual(device.slotTasks(SLOT_A), ['A-PRIVATE-TASK'], "A's slot is untouched");
});

// ── 2 / 10: A -> B where B has its own plan ─────────────────────────────────

test('2. A -> B with B\'s own plan: B hydrates B only, nothing of A is merged or written', async () => {
  const { rooms, device } = await deviceWithAPlan({ roomsInit: { B: { [DAYS_B.upcoming]: planRecord([item('pB1', 'B-OWN-TASK')]) } } });
  const bBefore = JSON.stringify(rooms[ROOM_B].plans());
  await device.directSwitch(ROOM_B);
  assert.ok(onlyOwnFactsCommitted(rooms[ROOM_B], 'B-'), 'nothing but B facts was ever committed into B');
  assert.equal(JSON.stringify(rooms[ROOM_B].plans()), bBefore, "B's cloud is byte-identical");
  assert.deepEqual(device.visibleTasks(), ['B-OWN-TASK'], 'PlanAuthority resolves B only');
  assert.deepEqual(device.slotTasks(SLOT_B), ['B-OWN-TASK']);
  assert.ok(!device.slotTasks(SLOT_B).includes('A-PRIVATE-TASK'));
});

// ── 3 / 11: A -> B -> A ─────────────────────────────────────────────────────

test('3. A -> B -> A: A restored from its own slot, B unchanged, no duplicate pushes, no loss', async () => {
  const { rooms, device } = await deviceWithAPlan({ roomsInit: { B: { [DAYS_B.upcoming]: planRecord([item('pB1', 'B-OWN-TASK')]) } } });
  await device.directSwitch(ROOM_B);
  const bCloud = JSON.stringify(rooms[ROOM_B].plans());
  const aCommitsBefore = rooms[ROOM_A].stats.planCommits;
  await device.directSwitch(ROOM_A);
  assert.deepEqual(device.visibleTasks(), ['A-PRIVATE-TASK']);
  assert.equal(JSON.stringify(rooms[ROOM_B].plans()), bCloud, 'B unchanged');
  assert.deepEqual(rooms[ROOM_A].tasks(), ['A-PRIVATE-TASK'], 'A not duplicated or lost');
  assert.equal(rooms[ROOM_A].planFor(DAYS_A.upcoming).items.length, 1);
  // Re-pushing a converged record is an idempotent merge; it never adds B facts to A.
  assert.ok(rooms[ROOM_A].stats.planCommits - aCommitsBefore <= 1);
  assert.ok(!rooms[ROOM_A].tasks().includes('B-OWN-TASK'));
  assert.deepEqual(device.slotTasks(SLOT_B), ['B-OWN-TASK'], "B's slot survives A's return untouched");
});

// ── 4: wrong-room direct push ───────────────────────────────────────────────

test('4. wrong-room direct push: a cache owned by A is refused for room B with zero writes', async () => {
  const room = makeRoom('B');
  const storage = memory();
  const ownerA = createOperationalPlanRepository({ storage, getOwner: () => ROOM_A });
  ownerA.write(DAYS_A.upcoming, [item('pA1', 'A-PRIVATE-TASK')], { updatedBy: 'x', ref: operationalDayContaining(manila(D, '20:00'), HISTORY_A.revisions), revisions: HISTORY_A.revisions });
  const bridge = createOperationalPlanSyncBridge({ repository: ownerA, getRoomRef: () => room.ref, getRoomId: () => ROOM_B });
  assert.deepEqual(await bridge.pushDay(DAYS_A.upcoming), { committed: false, outcome: 'owner-mismatch' });
  assert.equal(await bridge.syncDay(DAYS_A.upcoming), false);
  assert.equal(room.stats.planTransactions, 0);
});

test('4b. absence of an owner is not proof: a plain (unowned) cache is never pushed anywhere', async () => {
  const room = makeRoom('B');
  const plain = createOperationalPlanRepository({ storage: memory() });
  plain.write(DAYS_A.upcoming, [item('pX', 'UNOWNED')], { updatedBy: 'x', ref: operationalDayContaining(manila(D, '20:00'), HISTORY_A.revisions), revisions: HISTORY_A.revisions });
  for (const getRoomId of [() => ROOM_B, () => null, () => '']) {
    const bridge = createOperationalPlanSyncBridge({ repository: plain, getRoomRef: () => room.ref, getRoomId });
    assert.equal((await bridge.pushDay(DAYS_A.upcoming)).outcome, 'owner-mismatch');
  }
  assert.equal(room.stats.planTransactions, 0);
});

// ── 5: room switch during a transaction ─────────────────────────────────────

test('5a. account switch while A\'s push is in flight: the transaction aborts, nothing lands in either room', async () => {
  const rooms = { [ROOM_A]: roomWithAccount('A', HISTORY_A), [ROOM_B]: roomWithAccount('B', HISTORY_B) };
  const device = makeDevice({ rooms });
  await device.signIn(ROOM_A);
  rooms[ROOM_A].defer();
  device.authority.saveItems(device.authority.upcoming(), [item('pA1', 'A-PRIVATE-TASK')]);
  const pending = device.planSync.pushDay(DAYS_A.upcoming);
  await device.directSwitch(ROOM_B);
  rooms[ROOM_A].flush();
  const results = await pending;
  assert.deepEqual(results, { committed: false, outcome: 'owner-mismatch' });
  await settle();
  assert.equal(rooms[ROOM_A].stats.planCommits, 0);
  assert.equal(rooms[ROOM_B].stats.planTransactions, 0);
  assert.deepEqual(device.slotTasks(SLOT_B), [], 'the (aborted) result was never merged into B');
});

test('5b. switch between Firebase retries of ONE transaction: the re-run observes it and aborts', async () => {
  const rooms = { [ROOM_A]: roomWithAccount('A', HISTORY_A), [ROOM_B]: roomWithAccount('B', HISTORY_B) };
  const device = makeDevice({ rooms });
  await device.signIn(ROOM_A);
  rooms[ROOM_A].defer();
  device.authority.saveItems(device.authority.upcoming(), [item('pA1', 'A-PRIVATE-TASK')]);
  const pending = device.planSync.pushDay(DAYS_A.upcoming);
  // First run happens while A is active; a concurrent write forces a retry; the account switches before it.
  rooms[ROOM_A].flush({ beforeRetry: () => { device.auth.room = ROOM_B; } });
  assert.deepEqual(await pending, { committed: false, outcome: 'owner-mismatch' });
  assert.equal(rooms[ROOM_A].stats.planCommits, 0);
  assert.equal(rooms[ROOM_B].stats.planTransactions, 0);
});

test('5c. a push that COMMITTED to A but resolves after the switch is never merged into B\'s cache', async () => {
  const rooms = { [ROOM_A]: roomWithAccount('A', HISTORY_A, { [DAYS_A.upcoming]: planRecord([item('pA0', 'A-REMOTE-TASK')]) }), [ROOM_B]: roomWithAccount('B', HISTORY_B) };
  const device = makeDevice({ rooms });
  await device.signIn(ROOM_A);
  rooms[ROOM_A].defer();
  device.authority.saveItems(device.authority.upcoming(), [...device.authority.rawItems(device.authority.upcoming()), item('pA1', 'A-PRIVATE-TASK')]);
  const pending = device.planSync.pushDay(DAYS_A.upcoming);
  rooms[ROOM_A].flush(); // commits while A is still active...
  device.auth.room = ROOM_B; // ...and the switch lands before the promise resolves
  await pending;
  await settle();
  assert.equal(device.slot(SLOT_B), null, "the committed A value was not merged into B's slot");
  assert.equal(device.state.remoteChanges.filter(c => c.room === ROOM_B).length, 0);
});

// ── 6: stale A listener after B is active ───────────────────────────────────

test('6. a late A listener callback after the switch to B mutates nothing, announces nothing, pushes nothing', async () => {
  const { rooms, device } = await deviceWithAPlan({ roomsInit: { B: { [DAYS_B.upcoming]: planRecord([item('pB1', 'B-OWN-TASK')]) } } });
  await device.directSwitch(ROOM_B);
  const bSlotBefore = device.storage.getItem(SLOT_B);
  const aSlotBefore = device.storage.getItem(SLOT_A);
  const changesBefore = device.state.remoteChanges.length;
  const bTransactionsBefore = rooms[ROOM_B].stats.planTransactions;
  // A's day listener delivers late (as if the SDK had one queued), and A's cloud keeps changing.
  rooms[ROOM_A].seedPlan(DAYS_A.upcoming, planRecord([item('pA9', 'A-LATE-TASK')]));
  rooms[ROOM_A].fireLate(`${OPERATIONAL_PLANS_REMOTE_PATH}/${toFirebaseSafeKey(DAYS_A.upcoming)}`);
  await settle();
  assert.equal(device.storage.getItem(SLOT_B), bSlotBefore, "B's cache is byte-identical");
  assert.equal(device.storage.getItem(SLOT_A), aSlotBefore, "A's inactive cache is not mutated in the background either");
  assert.equal(device.state.remoteChanges.length, changesBefore, 'no repaint was announced');
  assert.deepEqual(device.visibleTasks(), ['B-OWN-TASK']);
  assert.equal(rooms[ROOM_B].stats.planTransactions, bTransactionsBefore, 'the late callback triggered no push');
  assert.ok(onlyOwnFactsCommitted(rooms[ROOM_B], 'B-'));
});

test('6b. both accounts sharing an operational day id: the switch rebinds the listener to B\'s room', async () => {
  // Same revision id on both accounts => identical operationalDayIds. Previously refreshLiveDays kept the
  // id "already attached" and B never subscribed; A's old listener stayed bound.
  const rooms = {
    [ROOM_A]: roomWithAccount('A', HISTORY_A, { [DAYS_A.upcoming]: planRecord([item('pA1', 'A-PRIVATE-TASK')]) }),
    [ROOM_B]: roomWithAccount('B', HISTORY_A, { [DAYS_A.upcoming]: planRecord([item('pB1', 'B-OWN-TASK')]) }),
  };
  const device = makeDevice({ rooms });
  await device.signIn(ROOM_A);
  assert.deepEqual(device.visibleTasks(), ['A-PRIVATE-TASK']);
  await device.directSwitch(ROOM_B);
  assert.deepEqual(device.visibleTasks(), ['B-OWN-TASK']);
  rooms[ROOM_B].seedPlan(DAYS_A.upcoming, planRecord([item('pB1', 'B-OWN-TASK'), item('pB2', 'B-LIVE-TASK', { updatedAt: 2000 })]));
  assert.deepEqual(device.visibleTasks().sort(), ['B-LIVE-TASK', 'B-OWN-TASK'], "B's own live update arrives");
  rooms[ROOM_A].fireLate(`${OPERATIONAL_PLANS_REMOTE_PATH}/${toFirebaseSafeKey(DAYS_A.upcoming)}`);
  assert.ok(!device.visibleTasks().includes('A-PRIVATE-TASK'));
  assert.ok(!rooms[ROOM_B].tasks().includes('A-PRIVATE-TASK'));
});

test('6c. the window before the rebind: room already B, the A listener still registered — its callback is dropped', async () => {
  // storage.js sets roomCode = B BEFORE startSync() rebinds anything, so a still-registered A listener
  // (token valid) can deliver into that window. The room check alone must refuse it.
  const { rooms, device } = await deviceWithAPlan();
  device.auth.room = ROOM_B; // onAuthStateChanged(B) has set roomCode; attachLiveDays() has not run yet
  const bSlot = device.storage.getItem(SLOT_B);
  const aSlot = device.storage.getItem(SLOT_A);
  rooms[ROOM_A].seedPlan(DAYS_A.upcoming, planRecord([item('pA9', 'A-LATE-TASK')])); // fires the live A listener
  await settle();
  assert.equal(device.storage.getItem(SLOT_B), bSlot, 'nothing merged into B');
  assert.equal(device.storage.getItem(SLOT_A), aSlot, 'nothing merged into the inactive A slot');
  assert.equal(device.state.remoteChanges.filter(c => c.room === ROOM_B).length, 0);
});

// ── 7: sign-out, then a stale callback ──────────────────────────────────────

test('7a. sign-out window: detach() runs while roomCode is still A — a late callback then is inert', async () => {
  const { rooms, device } = await deviceWithAPlan();
  device.live.detach(); // storage.js: PersonalDayBoundaryLive.detach() BEFORE roomCode = ''
  const aSlot = device.storage.getItem(SLOT_A);
  const changes = device.state.remoteChanges.length;
  rooms[ROOM_A].seedPlan(DAYS_A.upcoming, planRecord([item('pA9', 'A-LATE-TASK')]));
  rooms[ROOM_A].fireLate(`${OPERATIONAL_PLANS_REMOTE_PATH}/${toFirebaseSafeKey(DAYS_A.upcoming)}`);
  await settle();
  assert.equal(device.storage.getItem(SLOT_A), aSlot, 'a detached listener never writes, even for its own room');
  assert.equal(device.state.remoteChanges.length, changes);
});


test('7. sign-out: no active cache, listeners dropped, a later A callback writes nothing and nothing is anonymous', async () => {
  const { rooms, device } = await deviceWithAPlan();
  await device.signOut();
  assert.equal(device.planRepository.ownerRoomId(), null, 'no active cache owner');
  assert.deepEqual(device.planRepository.listAllRaw(), {}, 'no plan is readable as "current" while signed out');
  assert.deepEqual(device.visibleTasks(), []);
  assert.throws(() => device.planRepository.write(DAYS_A.upcoming, [], { updatedBy: 'x', ref: {}, revisions: [] }));
  const aSlot = device.storage.getItem(SLOT_A);
  rooms[ROOM_A].seedPlan(DAYS_A.upcoming, planRecord([item('pA9', 'A-LATE-TASK')]));
  rooms[ROOM_A].fireLate(`${OPERATIONAL_PLANS_REMOTE_PATH}/${toFirebaseSafeKey(DAYS_A.upcoming)}`);
  device.live.pushAllLocal();
  await settle();
  assert.equal(device.storage.getItem(SLOT_A), aSlot, "A's stored slot is kept for A's next sign-in, not erased or mutated");
  assert.equal(device.storage.getItem(UNSCOPED), null, 'nothing was written as an anonymous cache');
  assert.equal(device.live.attachedDayIds().length, 0);
});

// ── 8 / 9: offline switches ─────────────────────────────────────────────────

test('8. offline A -> B with no B cache: B is empty (not A), and reconnect keeps B isolated', async () => {
  const { rooms, device } = await deviceWithAPlan({ roomsInit: { B: { [DAYS_B.upcoming]: planRecord([item('pB1', 'B-OWN-TASK')]) } } });
  device.goOffline();
  await device.directSwitch(ROOM_B);
  assert.equal(device.planRepository.ownerRoomId(), ROOM_B);
  assert.deepEqual(device.planRepository.listAllRaw(), {}, 'B has no cache: empty, never A');
  assert.deepEqual(device.visibleTasks(), []);
  await device.reconnect();
  assert.deepEqual(device.visibleTasks(), ['B-OWN-TASK'], 'B converges on its own cloud');
  assert.ok(onlyOwnFactsCommitted(rooms[ROOM_B], 'B-'));
  assert.ok(!rooms[ROOM_B].tasks().includes('A-PRIVATE-TASK'));
});

test('9. offline A -> B with a B scoped cache: B uses its own cache, never A\'s', async () => {
  const rooms = { [ROOM_A]: roomWithAccount('A', HISTORY_A), [ROOM_B]: roomWithAccount('B', HISTORY_B, { [DAYS_B.upcoming]: planRecord([item('pB1', 'B-OWN-TASK')]) }) };
  const device = makeDevice({ rooms });
  await device.signIn(ROOM_B); // B used this device before: its slot exists
  await device.signOut();
  await device.signIn(ROOM_A);
  device.authority.saveItems(device.authority.upcoming(), [item('pA1', 'A-PRIVATE-TASK')]);
  await settle();
  device.goOffline();
  await device.directSwitch(ROOM_B);
  assert.deepEqual(device.visibleTasks(), ['B-OWN-TASK']);
  await device.reconnect();
  assert.deepEqual(device.visibleTasks(), ['B-OWN-TASK']);
  assert.deepEqual(rooms[ROOM_B].tasks(), ['B-OWN-TASK']);
});

// ── 10: same-account reconnect still works ──────────────────────────────────

test('10. same account: a plan written offline is pushed into the SAME room on reconnect', async () => {
  const { rooms, device } = await deviceWithAPlan();
  device.goOffline();
  device.authority.saveItems(device.authority.upcoming(), [...device.authority.rawItems(device.authority.upcoming()), item('pA2', 'A-OFFLINE-TASK', { updatedAt: 2000 })]);
  await settle();
  assert.ok(!rooms[ROOM_A].tasks().includes('A-OFFLINE-TASK'), 'nothing reached the room while offline');
  await device.reconnect();
  assert.deepEqual(rooms[ROOM_A].tasks().sort(), ['A-OFFLINE-TASK', 'A-PRIVATE-TASK']);
  assert.equal(rooms[ROOM_B].stats.planTransactions, 0);
});

// ── 11: returning account restores its own cache ────────────────────────────

test('11. returning to A (offline) restores A from A\'s own slot, not from the cloud', async () => {
  const { device } = await deviceWithAPlan({ roomsInit: { B: { [DAYS_B.upcoming]: planRecord([item('pB1', 'B-OWN-TASK')]) } } });
  await device.directSwitch(ROOM_B);
  device.goOffline();
  await device.directSwitch(ROOM_A);
  assert.deepEqual(device.visibleTasks(), ['A-PRIVATE-TASK']);
});

// ── 12 / 13: unowned legacy cache ───────────────────────────────────────────

function unscopedSeed() {
  return JSON.stringify({ schemaVersion: 1, plans: { [DAYS_A.upcoming]: planRecord([item('pU1', 'UNOWNED-LEGACY-TASK')]) } });
}

test('12. an unowned pre-scoping cache is never uploaded — to any account', async () => {
  const rooms = { [ROOM_A]: roomWithAccount('A', HISTORY_A), [ROOM_B]: roomWithAccount('B', HISTORY_B) };
  const device = makeDevice({ rooms, storage: memory({ [UNSCOPED]: unscopedSeed() }) });
  await device.signIn(ROOM_A);
  await device.directSwitch(ROOM_B);
  await device.reconnect();
  assert.equal(rooms[ROOM_A].stats.planTransactions, 0);
  assert.equal(rooms[ROOM_B].stats.planTransactions, 0);
  assert.ok(!rooms[ROOM_A].tasks().includes('UNOWNED-LEGACY-TASK'));
});

test('13. an unowned pre-scoping cache is never adopted, and is left in place untouched', async () => {
  const seed = unscopedSeed();
  const rooms = { [ROOM_A]: roomWithAccount('A', HISTORY_A) };
  const device = makeDevice({ rooms, storage: memory({ [UNSCOPED]: seed }) });
  await device.signIn(ROOM_A);
  assert.deepEqual(device.visibleTasks(), [], 'not visible under the signed-in account');
  assert.equal(device.slot(SLOT_A), null, 'not copied into the account slot');
  device.authority.saveItems(device.authority.upcoming(), [item('pA1', 'A-PRIVATE-TASK')]);
  await settle();
  assert.deepEqual(device.slotTasks(SLOT_A), ['A-PRIVATE-TASK'], 'a real write lands in the scoped slot only');
  assert.equal(device.storage.getItem(UNSCOPED), seed, 'the quarantined key is byte-identical — never merged into, never deleted');
});

// ── 14: PlanAuthority ───────────────────────────────────────────────────────

test('14. PlanAuthority never exposes A\'s plan under B — items, records, prepared plans, streak cache', async () => {
  const { device } = await deviceWithAPlan({ roomsInit: { B: { [DAYS_B.upcoming]: planRecord([item('pB1', 'B-OWN-TASK')]) } } });
  // Warm every derived cache under A first.
  const aStreak = device.authority.streak();
  device.authority.preparedPlans();
  assert.deepEqual(device.visibleTasks(), ['A-PRIVATE-TASK']);
  await device.directSwitch(ROOM_B); // no explicit invalidate() — the owner change alone must suffice
  assert.deepEqual(device.visibleTasks(), ['B-OWN-TASK']);
  assert.equal(device.authority.upcoming().id, DAYS_B.upcoming, 'authority identity is B\'s');
  assert.ok(!Object.keys(device.planRepository.listAllRaw()).includes(DAYS_A.upcoming));
  assert.ok(device.authority.preparedPlans().every(p => p.items.every(i => i.task !== 'A-PRIVATE-TASK')));
  assert.ok(device.authority.streak() !== aStreak, 'the streak cache built under A is not served under B');
  await device.directSwitch(ROOM_A);
  assert.deepEqual(device.visibleTasks(), ['A-PRIVATE-TASK'], 'deterministic in both directions');
});

// ── hydration of a fresh scoped slot ────────────────────────────────────────

test('hydration: a fresh slot is filled from the joined room\'s OWN cloud (incl. a past day), never another room', async () => {
  const pastId = operationalDayId(operationalDayContaining(manila(D_PREV, '20:00'), HISTORY_B.revisions));
  const rooms = {
    [ROOM_A]: roomWithAccount('A', HISTORY_A, { [DAYS_A.upcoming]: planRecord([item('pA1', 'A-PRIVATE-TASK')]) }),
    [ROOM_B]: roomWithAccount('B', HISTORY_B, { [pastId]: planRecord([item('pB0', 'B-PAST-TASK')]) }),
  };
  const device = makeDevice({ rooms });
  const bCloud = JSON.stringify(rooms[ROOM_B].plans());
  await device.signIn(ROOM_B);
  assert.ok(Object.keys(device.slot(SLOT_B).plans).includes(pastId), 'the past record (no live listener) is present locally');
  assert.deepEqual(device.slotTasks(SLOT_B), ['B-PAST-TASK']);
  assert.equal(JSON.stringify(rooms[ROOM_B].plans()), bCloud, "B's cloud is unchanged by hydration");
  assert.ok(onlyOwnFactsCommitted(rooms[ROOM_B], 'B-'));
  assert.ok(Object.keys(rooms[ROOM_B].plans()).map(fromFirebaseSafeKey).every(id => id !== DAYS_A.upcoming));
});

test('hydration: a hydration read still in flight when the account switches is discarded', async () => {
  const rooms = {
    [ROOM_A]: roomWithAccount('A', HISTORY_A, { [DAYS_A.current]: planRecord([item('pA1', 'A-PRIVATE-TASK')]) }),
    [ROOM_B]: roomWithAccount('B', HISTORY_B),
  };
  let releaseOnce;
  const slowOnce = new Promise(resolve => { releaseOnce = resolve; });
  const originalChild = rooms[ROOM_A].ref.child.bind(rooms[ROOM_A].ref);
  rooms[ROOM_A].ref.child = seg => {
    const ref = originalChild(seg);
    if (seg === OPERATIONAL_PLANS_REMOTE_PATH) ref.once = () => slowOnce.then(() => ({ val: () => rooms[ROOM_A].plans() }));
    return ref;
  };
  const device = makeDevice({ rooms });
  device.auth.room = ROOM_A;
  device.planSync.hydrateAll();
  await device.directSwitch(ROOM_B);
  releaseOnce();
  await settle();
  assert.equal(device.slot(SLOT_B), null, "A's subtree did not land in B's slot");
});
