// brain-dump-expired-claim.test.js
//
// Brain Dump Production UX Correction V1, FIX FIRST #3: an EXPIRED stuck claim.
//
// The pre-fix production client (cf43080, the only Brain Dump build ever deployed)
// committed promotion claims remotely but could never normalize them back off the
// null-pruned wire, so it never wrote a plan item for ANY claim. Captures whose
// claimed day has since ended were left permanently claimed: no plan item, archive
// and delegate refused. Product decision: such a capture returns to the active
// list (same id, text, classification) so the owner can decide again.
//
// Everything here runs against the REAL Plan Authority (calendar-native routing,
// so its own assertDirectSchedulingTarget / rawItems decide "ended" and "absent"),
// a Firebase-faithful room (null keys pruned, listener before resolve, the REAL
// firebase.rules.json enforced via targaryen), and the REAL cf43080 client modules.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import targaryen from 'targaryen';
import { wireCopy } from './brain-dump-test-support.js';

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

import { createBrainDumpRepository } from './brain-dump-repository.js';
import { createBrainDumpSyncBridge } from './brain-dump-sync.js';
import { brainDumpPlanItemId, normalizeCapture, mergeCaptureRecords, finalizePromotion } from './brain-dump-model.js';
import { promoteCaptureToPlan, settleOutstandingClaim } from './brain-dump-promotion.js';
import * as oldModel from './fixtures/brain-dump-pre-reopen/brain-dump-model.js';
import { createBrainDumpRepository as createOldRepository } from './fixtures/brain-dump-pre-reopen/brain-dump-repository.js';
import { createBrainDumpSyncBridge as createOldBridge } from './fixtures/brain-dump-pre-reopen/brain-dump-sync.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = JSON.parse(readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8'));
const MANILA = 'Asia/Manila';
const UID = 'alice_uid';
const ROOM = `uid_${UID}`;
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const NOW = at('2026-10-03', '09:00');
const PAST = '2026-10-01';
const FUTURE = '2026-10-10';
const calId = dateKey => `cal1:${dateKey}`;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
let seq = 0;

/** The real Plan Authority, calendar-native from 2026-09-28 on (so PAST and FUTURE
 *  are calendar plans and the target identity is the date itself). */
function makePlanAuthority(clock) {
  const room = () => ROOM;
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage: memoryStorage(), idGenerator: () => `rev-${++seq}`, getOwner: room });
  const planRepository = createOperationalPlanRepository({ storage: memoryStorage(), getOwner: room });
  const planSync = createOperationalPlanSyncBridge({ repository: planRepository, getRoomRef: () => null, getRoomId: room });
  const boundarySync = createPersonalDayBoundarySyncBridge({ repository: boundaryRepository, getRoomRef: () => null, getRoomId: room });
  const legacyPlans = {};
  const legacy = {
    record: k => legacyPlans[k] || null, rawItems: k => (legacyPlans[k]?.items || []).map(i => ({ ...i })),
    saveItems(k, items) { legacyPlans[k] = { ...(legacyPlans[k] || {}), items }; },
    confirm() { return { localSaved: true, syncPromise: Promise.resolve(false) }; },
    allPlans: () => legacyPlans, earliestPlanDate: () => null,
  };
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository, planSync, boundarySync,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => clock.now, deviceId: () => 'phone', fallbackTimezone: () => MANILA,
  });
  const db = fakeDatabase();
  const calendarRepository = createCalendarPlanRepository({ storage: memoryStorage(), getOwner: room, getTimezone: () => MANILA, idGenerator: () => `ca1-${++seq}` });
  const calendarSync = createCalendarPlanSyncBridge({ repository: calendarRepository, getRoomRef: () => db.ref(`rooms/${ROOM}`), getRoomId: room });
  const calendar = createCalendarPlanLiveWiring({ repository: calendarRepository, sync: calendarSync, now: () => clock.now, deviceId: () => 'phone', timezone: () => MANILA });
  calendar.attachLive();
  const authority = createPlanAuthority({ live, legacy, calendar, now: () => clock.now, accountTimezone: () => MANILA });
  const activatedAt = clock.now;
  clock.now = at('2026-09-28', '08:00');
  authority.activateCalendar();
  clock.now = activatedAt;
  return authority;
}

/** One Firebase-faithful room: records stored and delivered only in RTDB's pruned
 *  wire form, listener before resolve, real rules enforced on every commit. */
function makeRoom() {
  let store = {};
  const listeners = new Set();
  const denials = [];
  const snapshot = () => wireCopy(store) || {};
  function notify() { listeners.forEach(fn => fn({ val: snapshot })); }
  const capture = id => ({
    transaction(updateFn) {
      const next = updateFn(wireCopy(store[id]));
      if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => wireCopy(store[id]) } });
      const verdict = targaryen.database(RULES, { rooms: { [ROOM]: { brainDump: wireCopy(store) || {} } } }).as({ uid: UID }).write(`/rooms/${ROOM}/brainDump/${id}`, wireCopy(next));
      if (!verdict.allowed) { denials.push({ id, attempted: wireCopy(next) }); return Promise.reject(Object.assign(new Error('permission_denied'), { code: 'PERMISSION_DENIED' })); }
      store = { ...store, [id]: wireCopy(next) };
      notify();
      return Promise.resolve({ committed: true, snapshot: { val: () => wireCopy(store[id]) } });
    },
  });
  const brainDump = {
    child: id => capture(id),
    on(_event, fn) { listeners.add(fn); fn({ val: snapshot }); },
    off() { listeners.clear(); },
  };
  return {
    ref: { child: seg => (seg === 'brainDump' ? brainDump : null) },
    denials,
    raw: () => snapshot(),
    put(id, value) { store = { ...store, [id]: wireCopy(value) }; notify(); },
  };
}

/** A NEW device wired exactly like brain-dump-ui.js: every changed record goes
 *  through settleOutstandingClaim, plus the bind-time sweep. */
function makeDevice({ room, planAuthority, clock, deviceId = 'new-device', live = true, online = () => true }) {
  const repository = createBrainDumpRepository({ storage: memoryStorage(), getOwner: () => ROOM, now: () => clock.now, deviceId: () => deviceId });
  const settling = new Set();
  const outcomes = [];
  let bridge = null;
  const settle = id => {
    if (settling.has(id)) return Promise.resolve(null);
    settling.add(id);
    return settleOutstandingClaim({ repository, planAuthority, id, now: clock.now, deviceId, markClaimWrite: bridge.markClaimWriteRemote, resolveExpiredClaim: bridge.resolveExpiredClaimRemote })
      .then(outcome => { outcomes.push({ id, outcome }); if (outcome?.record) bridge.syncCapture(id); return outcome; })
      .finally(() => settling.delete(id));
  };
  bridge = createBrainDumpSyncBridge({
    repository, getRoomRef: () => (online() ? room.ref : null), getRoomId: () => ROOM, now: () => clock.now, deviceId: () => deviceId,
    onRemoteChange: (id, record) => {
      const normalized = normalizeCapture(record);
      if (normalized?.promotionClaim && (normalized.status === 'triaged' || normalized.status === 'untriaged')) settle(id);
    },
  });
  if (live) bridge.attach();
  return {
    repository, bridge, outcomes, settle,
    /** brain-dump-ui.js's settleAllOutstandingClaims (run on every bind). */
    sweep() { return Promise.all(Object.keys(repository.listAllRaw()).filter(id => normalizeCapture(repository.read(id))?.promotionClaim).map(settle)); },
    recovered: () => outcomes.filter(o => o.outcome?.recovered).map(o => o.id),
  };
}

/** The EXACT shape cf43080 left in production: built by the real cf43080 model
 *  (generation 1, no reopenCount, an UNMARKED claim), stored null-pruned. */
function productionStuckClaim(id, { dateKey = PAST, type = 'schedule', when = '14:30', durationMinutes = 30 } = {}) {
  const T = at('2026-09-30', '20:00');
  const built = oldModel.buildCapture({ id, text: `Stuck ${id}`, now: T, updatedBy: 'old-phone' }).record;
  const triaged = oldModel.triageCapture(built, { important: true, urgent: false, now: T + 1, updatedBy: 'old-phone' }).record;
  const promotion = { type, store: 'calendar', targetId: calId(dateKey), planItemId: brainDumpPlanItemId(id), when: type === 'do-today' ? '' : when };
  if (type !== 'do-today' && durationMinutes) promotion.durationMinutes = durationMinutes;
  return oldModel.claimPromotion(triaged, { promotion, now: T + 2, updatedBy: 'old-phone' }).record;
}

function setup() {
  const clock = { now: NOW };
  const planAuthority = makePlanAuthority(clock);
  const room = makeRoom();
  return { clock, planAuthority, room };
}

const itemsFor = (pa, dateKey, id) => pa.rawItems(pa.targetById(calId(dateKey))).filter(i => i.id === brainDumpPlanItemId(id));

// ═══════════════════════════════════════════════════════════════════════════
// the four proof cases
// ═══════════════════════════════════════════════════════════════════════════

test('A. past target + the deterministic item ALREADY exists: finalized as promoted, never released, no duplicate', async () => {
  const { clock, planAuthority, room } = setup();
  const id = 'bexpa1';
  // The item was written while that day was still open.
  clock.now = at(PAST, '10:00');
  planAuthority.addItem({ destination: planAuthority.targetById(calId(PAST)), item: { id: brainDumpPlanItemId(id), task: 'x', when: '14:30', done: false, doneAt: null, updatedAt: clock.now, updatedBy: 'b', kind: 'task' } });
  clock.now = NOW;
  room.put(id, productionStuckClaim(id));
  const device = makeDevice({ room, planAuthority, clock });
  await flush();
  assert.equal(device.repository.read(id).status, 'promoted');
  assert.equal(itemsFor(planAuthority, PAST, id).length, 1);
  assert.deepEqual(device.recovered(), []);
  assert.equal(normalizeCapture(room.raw()[id]).status, 'promoted');
});

test('B + M + N. the real cf43080 stuck shape (pruned wire, unmarked claim, ended day, no item): a fresh client self-heals it back to triage', async () => {
  const { clock, planAuthority, room } = setup();
  const id = 'bexpb1';
  room.put(id, productionStuckClaim(id));
  const wire = room.raw()[id];
  for (const key of ['disposedAt', 'delegatedTo', 'promotion', 'reopenCount']) assert.equal(key in wire, false, `${key} absent on the wire`);
  assert.equal(wire.schemaVersion, 1);
  assert.equal('planWriteStarted' in wire.promotionClaim, false, 'cf43080 never marked a claim');

  const device = makeDevice({ room, planAuthority, clock });
  await flush();
  const local = device.repository.read(id);
  assert.equal(local.id, id, 'same capture id');
  assert.equal(local.status, 'triaged', 'back in the active list');
  assert.equal(local.text, `Stuck ${id}`);
  assert.equal(local.important, true);
  assert.equal(local.urgent, false);
  assert.equal(local.promotionClaim, null, 'the claim no longer controls current truth');
  assert.equal(local.claimEpoch, 1);
  assert.equal(local.schemaVersion, 2);
  // compact provenance: there WAS an attempt, what it was, and when it expired
  assert.equal(local.expiredClaim.targetId, calId(PAST));
  assert.equal(local.expiredClaim.when, '14:30');
  assert.equal(local.expiredClaim.durationMinutes, 30);
  assert.equal(local.expiredClaim.claimedBy, 'old-phone');
  assert.equal(local.expiredClaim.expiredAt, NOW);
  assert.deepEqual(device.recovered(), [id]);
  assert.equal(itemsFor(planAuthority, PAST, id).length, 0, 'no past-day item through any bypass');
  const remote = normalizeCapture(room.raw()[id]);
  assert.equal(remote.status, 'triaged');
  assert.equal(remote.claimEpoch, 1);
  assert.equal('promotionClaim' in room.raw()[id], false, 'remote claim cleared (pruned)');
});

test('M. a client that ALREADY held the stuck claim locally (no merge change on load) recovers it through the bind-time sweep', async () => {
  const { clock, planAuthority, room } = setup();
  const id = 'bexpm1';
  room.put(id, productionStuckClaim(id));
  const device = makeDevice({ room, planAuthority, clock, live: false });
  device.repository.mergeRemote(id, room.raw()[id]); // held from an earlier session
  device.bridge.attach(); // same record: no change, so no listener-driven settle
  await flush();
  assert.equal(device.repository.read(id).status, 'triaged');
  assert.ok(device.repository.read(id).promotionClaim, 'nothing happened yet');
  await device.sweep();
  await flush();
  assert.equal(device.repository.read(id).promotionClaim, null);
  assert.equal(device.repository.read(id).claimEpoch, 1);
});

for (const [label, dateKey] of [['C. current (today)', '2026-10-03'], ['D. future', FUTURE]]) {
  test(`${label} target + no item: normal reconciliation (mark, then exactly one item), never an expiry recovery`, async () => {
    const { clock, planAuthority, room } = setup();
    const id = `bexp${dateKey.slice(-2)}c`;
    room.put(id, productionStuckClaim(id, { dateKey }));
    const device = makeDevice({ room, planAuthority, clock });
    await flush();
    assert.deepEqual(device.recovered(), [], 'never released');
    assert.equal(device.repository.read(id).status, 'promoted');
    assert.equal(itemsFor(planAuthority, dateKey, id).length, 1);
    assert.equal(normalizeCapture(room.raw()[id]).status, 'promoted');
  });
}

test('E. uncertainty is never proof: an unreadable destination, an unresolvable target, an unprovable end, or an offline remote all leave the claim exactly as it is', async () => {
  const cases = [
    ['destination read fails', pa => ({ ...pa, rawItems: () => { throw new Error('plan cache unavailable'); } })],
    ['target unresolvable', pa => ({ ...pa, targetById: () => null })],
    ['end not provable (refused even at the beginning of time)', pa => ({ ...pa, assertDirectSchedulingTarget: () => { throw new Error('unrelated failure'); }, addItem: () => { throw new Error('unrelated failure'); } })],
  ];
  for (const [label, wrap] of cases) {
    const { clock, planAuthority, room } = setup();
    const id = `bexpe${cases.findIndex(c => c[0] === label)}`;
    room.put(id, productionStuckClaim(id));
    const device = makeDevice({ room, planAuthority: wrap(planAuthority), clock });
    await flush();
    assert.deepEqual(device.recovered(), [], `${label}: not released`);
    assert.ok(normalizeCapture(room.raw()[id]).promotionClaim, `${label}: the remote claim stands`);
    assert.equal(itemsFor(planAuthority, PAST, id).length, 0);
  }
  // Offline: everything else proves expiry, but the authoritative resolution cannot run.
  const { clock, planAuthority, room } = setup();
  const id = 'bexpeoff';
  room.put(id, productionStuckClaim(id));
  let online = true;
  const device = makeDevice({ room, planAuthority, clock, live: false, online: () => online });
  device.repository.mergeRemote(id, room.raw()[id]);
  online = false;
  await device.sweep();
  await flush();
  assert.deepEqual(device.recovered(), []);
  assert.ok(device.repository.read(id).promotionClaim, 'still claimed locally');
  assert.ok(normalizeCapture(room.raw()[id]).promotionClaim, 'and remotely');
});

// ═══════════════════════════════════════════════════════════════════════════
// concurrency
// ═══════════════════════════════════════════════════════════════════════════

test('F. two NEW devices detect the same expired claim: one logical recovery, claimEpoch 1 (no inflation), both converge', async () => {
  const { clock, planAuthority, room } = setup();
  const id = 'bexpf1';
  room.put(id, productionStuckClaim(id));
  const a = makeDevice({ room, planAuthority, clock, deviceId: 'device-a', live: false });
  const b = makeDevice({ room, planAuthority, clock, deviceId: 'device-b', live: false });
  a.repository.mergeRemote(id, room.raw()[id]);
  b.repository.mergeRemote(id, room.raw()[id]);
  await Promise.all([a.sweep(), b.sweep()]);
  await flush();
  const remote = normalizeCapture(room.raw()[id]);
  assert.equal(remote.claimEpoch, 1);
  assert.equal(remote.promotionClaim, null);
  assert.equal(a.recovered().length + b.recovered().length, 1, 'exactly one device performed the recovery');
  await a.bridge.syncCapture(id);
  await b.bridge.syncCapture(id);
  assert.deepEqual(a.repository.read(id), b.repository.read(id));
  assert.equal(normalizeCapture(room.raw()[id]).claimEpoch, 1);
});

test('G + O. after recovery, neither a stale NEW device nor the real OLD cf43080 client can resurrect the expired claim', async () => {
  const { clock, planAuthority, room } = setup();
  const id = 'bexpg1';
  const stuck = productionStuckClaim(id);
  room.put(id, stuck);
  const staleNew = makeDevice({ room, planAuthority, clock, deviceId: 'stale-new', live: false });
  staleNew.repository.mergeRemote(id, room.raw()[id]);
  const old = createOldRepository({ storage: memoryStorage(), getOwner: () => ROOM, now: () => clock.now, deviceId: () => 'old-phone' });
  const oldBridge = createOldBridge({ repository: old, getRoomRef: () => room.ref, getRoomId: () => ROOM, now: () => clock.now, deviceId: () => 'old-phone' });
  old.mergeRemote(id, stuck); // the old phone's own local copy (localStorage keeps nulls)
  assert.ok(old.read(id).promotionClaim);

  const healer = makeDevice({ room, planAuthority, clock, deviceId: 'healer' });
  await flush();
  assert.equal(normalizeCapture(room.raw()[id]).claimEpoch, 1);

  clock.now += 60_000;
  await staleNew.bridge.syncCapture(id); // pushes its stale claimed copy
  await oldBridge.pushAllLocal({ all: true }); // the old client reconnects
  await flush();
  const remote = normalizeCapture(room.raw()[id]);
  assert.equal(remote.promotionClaim, null, 'the expired claim never comes back');
  assert.equal(remote.claimEpoch, 1);
  assert.equal(remote.status, 'triaged');
  assert.ok(room.denials.some(d => d.id === id), 'the old client\'s write was refused by the rules');
  assert.equal(staleNew.repository.read(id).promotionClaim, null, 'the stale new device converges to the recovery');
  assert.equal(healer.repository.read(id).promotionClaim, null);
});

test('H. recovery vs an authoritative PROMOTED result: promoted wins, in either arrival order', () => {
  const stuck = normalizeCapture(wireCopy(productionStuckClaim('bexph1')));
  const promoted = finalizePromotion({ ...stuck, promotionClaim: { ...stuck.promotionClaim, planWriteStarted: true } }, { now: NOW, updatedBy: 'b' }).record;
  const recovered = { ...stuck, schemaVersion: 2, promotionClaim: null, claimEpoch: 1, expiredClaim: { ...stuck.promotionClaim, expiredAt: NOW + 5, expiredBy: 'a' }, updatedAt: NOW + 5, updatedBy: 'a' };
  delete recovered.expiredClaim.planWriteStarted;
  const ab = mergeCaptureRecords(wireCopy(recovered), wireCopy(promoted));
  const ba = mergeCaptureRecords(wireCopy(promoted), wireCopy(recovered));
  assert.equal(ab.status, 'promoted');
  assert.deepEqual(ab, ba, 'arrival order never decides');
});

test('race 3. a device that MARKED the claim (it may be writing the item) blocks recovery; a recovery that committed first blocks the mark: never active triage beside a possible item', async () => {
  // Order 1: mark first.
  {
    const { clock, planAuthority, room } = setup();
    const id = 'bexpr1';
    room.put(id, productionStuckClaim(id));
    const writer = makeDevice({ room, planAuthority, clock, deviceId: 'writer', live: false });
    writer.repository.mergeRemote(id, room.raw()[id]);
    const claim = normalizeCapture(room.raw()[id]).promotionClaim;
    assert.equal((await writer.bridge.markClaimWriteRemote(id, claim)).ok, true);
    const healer = makeDevice({ room, planAuthority, clock, deviceId: 'healer' });
    await flush();
    assert.deepEqual(healer.recovered(), []);
    const remote = normalizeCapture(room.raw()[id]);
    assert.ok(remote.promotionClaim?.planWriteStarted, 'the marked claim stands');
    assert.equal(remote.claimEpoch, 0);
  }
  // Order 2: recovery first.
  {
    const { clock, planAuthority, room } = setup();
    const id = 'bexpr2';
    room.put(id, productionStuckClaim(id));
    const writer = makeDevice({ room, planAuthority, clock, deviceId: 'writer', live: false });
    writer.repository.mergeRemote(id, room.raw()[id]);
    const claim = normalizeCapture(room.raw()[id]).promotionClaim;
    makeDevice({ room, planAuthority, clock, deviceId: 'healer' });
    await flush();
    const mark = await writer.bridge.markClaimWriteRemote(id, claim);
    assert.equal(mark.ok, false, 'the claim is gone, so nothing may be written for it');
    assert.equal(itemsFor(planAuthority, PAST, id).length, 0);
    assert.equal(normalizeCapture(room.raw()[id]).promotionClaim, null);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// I-L: the owner decides again
// ═══════════════════════════════════════════════════════════════════════════

async function recoveredCapture(id) {
  const env = setup();
  env.room.put(id, productionStuckClaim(id));
  const device = makeDevice({ ...env, deviceId: 'owner' });
  await flush();
  assert.equal(device.repository.read(id).claimEpoch, 1);
  return { ...env, device };
}

const promote = (env, id, intent) => promoteCaptureToPlan({ repository: env.device.repository, planAuthority: env.planAuthority, claimPromotionRemote: env.device.bridge.claimPromotionRemote, id, now: env.clock.now, deviceId: 'owner', ...intent });

test('I. recovered -> Do Today: exactly one item, today, under the NEW intent', async () => {
  const env = await recoveredCapture('bexpi1');
  const result = await promote(env, 'bexpi1', { type: 'do-today' });
  assert.equal(result.ok, true, result.reason);
  assert.notEqual(result.alreadyDisposed, true);
  assert.equal(itemsFor(env.planAuthority, '2026-10-03', 'bexpi1').length, 1);
  assert.equal(itemsFor(env.planAuthority, PAST, 'bexpi1').length, 0);
  const record = env.device.repository.read('bexpi1');
  assert.equal(record.status, 'promoted');
  assert.equal(record.promotion.type, 'do-today');
  assert.equal(record.expiredClaim.targetId, calId(PAST), 'the failed attempt stays on record');
  await flush();
  assert.equal(normalizeCapture(env.room.raw()['bexpi1']).status, 'promoted');
});

test('J. recovered -> Schedule a future day: exactly one item', async () => {
  const env = await recoveredCapture('bexpj1');
  const result = await promote(env, 'bexpj1', { type: 'schedule', dateKey: FUTURE, when: '15:00' });
  assert.equal(result.ok, true, result.reason);
  const items = itemsFor(env.planAuthority, FUTURE, 'bexpj1');
  assert.equal(items.length, 1);
  assert.equal(items[0].when, '15:00');
});

for (const action of ['archive', 'delegate']) {
  test(`${action === 'archive' ? 'K' : 'L'}. recovered -> ${action === 'archive' ? 'Archive' : 'Delegate'}: the ordinary handled behavior`, async () => {
    const env = await recoveredCapture(`bexp${action}`);
    const id = `bexp${action}`;
    env.clock.now += 1000;
    const result = action === 'archive' ? env.device.repository.archive(id) : env.device.repository.delegate(id, { delegatedTo: 'Sam' });
    assert.equal(result.ok, true, result.reason);
    await env.device.bridge.syncCapture(id);
    const remote = normalizeCapture(env.room.raw()[id]);
    assert.equal(remote.status, action === 'archive' ? 'archived' : 'delegated');
    assert.equal(remote.claimEpoch, 1);
    if (action === 'delegate') assert.equal(remote.delegatedTo, 'Sam');
  });
}

test('a stale local copy from BEFORE the recovery can still promote the recovered capture: the claim is rebased onto the newer epoch, not lost', async () => {
  const env = await recoveredCapture('bexpst1');
  const stale = makeDevice({ room: env.room, planAuthority: env.planAuthority, clock: env.clock, deviceId: 'stale', live: false });
  // Its cache predates the recovery: triaged, generation 1, no claim at all.
  const before = normalizeCapture(wireCopy(productionStuckClaim('bexpst1')));
  stale.repository.mergeRemote('bexpst1', { ...before, promotionClaim: null });
  const result = await promoteCaptureToPlan({ repository: stale.repository, planAuthority: env.planAuthority, claimPromotionRemote: stale.bridge.claimPromotionRemote, id: 'bexpst1', type: 'do-today', now: env.clock.now, deviceId: 'stale' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(itemsFor(env.planAuthority, '2026-10-03', 'bexpst1').length, 1);
  assert.equal(normalizeCapture(env.room.raw()['bexpst1']).claimEpoch, 1, 'still the recovered epoch');
});
