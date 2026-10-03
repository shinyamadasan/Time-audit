// brain-dump-production-ux.test.js
//
// Brain Dump Production UX Correction V1 — the owner's exact production usage.
//
// The earlier suites never wired the sync bridge's onRemoteChange hook to the
// reconciler, but production does (brain-dump-sync.js's window singleton ->
// globalThis.refreshBrainDumpSurfaces -> brain-dump-ui.js's maybeReconcile ->
// reconcilePromotionClaim). Real Firebase also raises the whole-subtree 'value'
// event for a committed transaction BEFORE the transaction's own Promise
// resolves. Together those mean the reconciler always finishes a fresh
// foreground promotion first, and the foreground call then has to recognize
// that its own claim already landed. makeProductionDevice() below reproduces
// both facts: the fake room notifies listeners before resolving, and
// onRemoteChange runs the same reconcile trigger the UI runs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrainDumpRepository } from './brain-dump-repository.js';
import { createBrainDumpSyncBridge, BRAIN_DUMP_REMOTE_PATH } from './brain-dump-sync.js';
import {
  brainDumpPlanItemId, buildCapture, triageCapture, archiveCapture, delegateCapture, reopenCapture,
  claimPromotion, mergeCaptureRecords, normalizeCapture,
} from './brain-dump-model.js';
import { promoteCaptureToPlan, reconcilePromotionClaim } from './brain-dump-promotion.js';

const T0 = Date.parse('2026-10-01T08:00:00Z');
const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

/** Fake room with real Firebase event ordering: a committed transaction raises
 *  the 'value' event for every listener, THEN resolves. `hold(id)` makes that
 *  capture's transactions wait until `release(id)` (a slow network for one
 *  record only), so a test can observe a pending claim. */
function makeRoom() {
  const store = {};
  const listeners = new Set();
  const held = new Map();
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  function notify() { listeners.forEach(fn => fn({ val: () => clone(store) })); }
  function run(segments, updateFn) {
    if (segments.length !== 2 || segments[0] !== BRAIN_DUMP_REMOTE_PATH) return { committed: false };
    const id = segments[1];
    const next = updateFn(clone(store[id]));
    if (next === undefined) return { committed: false, snapshot: { val: () => clone(store[id]) } };
    store[id] = clone(next);
    notify();
    return { committed: true, snapshot: { val: () => clone(store[id]) } };
  }
  function makeRef(segments = []) {
    return {
      child(seg) { return makeRef([...segments, seg]); },
      on(_event, fn) { listeners.add(fn); fn({ val: () => clone(store) }); },
      off() { listeners.clear(); },
      transaction(updateFn) {
        const queue = held.get(segments[1]);
        if (queue) return new Promise(resolve => queue.push(() => resolve(run(segments, updateFn))));
        return Promise.resolve(run(segments, updateFn));
      },
    };
  }
  return {
    ref: makeRef(),
    raw: () => clone(store),
    /** Writes a record straight into the room, as another device's push would. */
    put(id, value) { store[id] = clone(value); notify(); },
    hold(id) { held.set(id, []); },
    release(id) { const q = held.get(id) || []; held.delete(id); q.forEach(fn => fn()); },
  };
}

function makeFakePlanAuthority() {
  const items = [];
  const today = { store: 'calendar', id: 'calplan:2026-10-01', dateKey: '2026-10-01' };
  return {
    items,
    current: () => today,
    dayForScheduledDate: (dateKey) => ({ ok: true, anchor: 'noon', target: { store: 'calendar', id: `calplan:${dateKey}`, dateKey } }),
    rawItems: () => items,
    addItem({ item }) { items.push(item); return { item }; },
    targetById(id) { const m = /^calplan:(.+)$/.exec(id); return m ? { store: 'calendar', id, dateKey: m[1] } : null; },
  };
}

/** One device wired EXACTLY like production: onRemoteChange runs the UI's
 *  reconcile trigger (maybeReconcile's logic) for every changed capture. */
/** `live:false` leaves the listener detached, so the device only learns of
 *  other devices' writes when it pushes (a genuinely stale device).
 *  `clock` is a mutable { now } so a test can advance time between steps. */
function makeProductionDevice({ room, planAuthority, deviceId = 'device-1', owner = 'uid_a', clock = { now: T0 }, live = true, claimTimeoutMs, storage = memory(), getOwner, getRoomRef } = {}) {
  const ownerOf = getOwner || (() => owner);
  const repository = createBrainDumpRepository({ storage, getOwner: ownerOf, now: () => clock.now, deviceId: () => deviceId });
  const reconciles = [];
  let bridge = null;
  bridge = createBrainDumpSyncBridge({
    repository, getRoomRef: getRoomRef || (() => room.ref), getRoomId: ownerOf, now: () => clock.now, deviceId: () => deviceId, claimTimeoutMs,
    onRemoteChange: (id, record) => {
      if (!record || (record.status !== 'untriaged' && record.status !== 'triaged') || !record.promotionClaim) return;
      const outcome = reconcilePromotionClaim({ repository, planAuthority, id, now: clock.now, deviceId });
      reconciles.push({ id, outcome });
      if (outcome?.record) bridge.syncCapture(id);
    },
  });
  if (live) bridge.attach();
  return {
    repository, bridge, reconciles, clock,
    async archive(id) { const r = repository.archive(id); if (r.ok) await bridge.syncCapture(id); return r; },
    async delegate(id, delegatedTo) { const r = repository.delegate(id, { delegatedTo }); if (r.ok) await bridge.syncCapture(id); return r; },
    async edit(id, patch) { const r = repository.editHandled(id, patch); if (r.ok) await bridge.syncCapture(id); return r; },
    async reopen(id) { const r = repository.reopen(id); if (r.ok) await bridge.syncCapture(id); return r; },
    async capture(text) {
      const created = repository.create({ text });
      await bridge.syncCapture(created.record.id);
      repository.triage(created.record.id, { important: true, urgent: false });
      await bridge.syncCapture(created.record.id);
      return created.record.id;
    },
    promote(id, extra) {
      return promoteCaptureToPlan({ repository, planAuthority, claimPromotionRemote: bridge.claimPromotionRemote, id, now: clock.now, deviceId, ...extra });
    },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

// ═══════════════════════════════════════════════════════════════════════════
// A-D: the owner's exact flow — fresh captures, foreground + reconciler
// ═══════════════════════════════════════════════════════════════════════════

test('A. fresh capture -> triage -> Schedule succeeds once, as a plain success (no false conflict)', async () => {
  const room = makeRoom();
  const pa = makeFakePlanAuthority();
  const device = makeProductionDevice({ room, planAuthority: pa });
  const a = await device.capture('Renew passport');
  const result = await device.promote(a, { type: 'schedule', dateKey: '2026-10-10', when: '14:30', durationMinutes: 30 });
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result.reason)}`);
  assert.notEqual(result.alreadyDisposed, true, 'the foreground call\'s own success is not "already handled"');
  assert.equal(result.record.status, 'promoted');
  assert.equal(pa.items.filter(i => i.id === brainDumpPlanItemId(a)).length, 1);
  await flush();
  assert.equal(room.raw()[a].status, 'promoted');
});

test('B. a second fresh capture right after A succeeds independently; A does not contaminate B', async () => {
  const room = makeRoom();
  const pa = makeFakePlanAuthority();
  const device = makeProductionDevice({ room, planAuthority: pa });
  const a = await device.capture('Capture A');
  const ra = await device.promote(a, { type: 'schedule', dateKey: '2026-10-10' });
  const b = await device.capture('Capture B');
  const rb = await device.promote(b, { type: 'schedule', dateKey: '2026-10-11' });
  assert.equal(ra.ok, true); assert.notEqual(ra.alreadyDisposed, true);
  assert.equal(rb.ok, true, `B: ${rb.reason}`); assert.notEqual(rb.alreadyDisposed, true);
  assert.equal(pa.items.length, 2);
  assert.equal(pa.items.find(i => i.id === brainDumpPlanItemId(b)).task, 'Capture B');
  assert.equal(device.repository.read(a).promotion.targetId, 'calplan:2026-10-10');
  assert.equal(device.repository.read(b).promotion.targetId, 'calplan:2026-10-11');
});

test('C. fresh capture -> Do Today: one plan item, plain success', async () => {
  const room = makeRoom();
  const pa = makeFakePlanAuthority();
  const device = makeProductionDevice({ room, planAuthority: pa });
  const id = await device.capture('Ship it');
  const result = await device.promote(id, { type: 'do-today' });
  assert.equal(result.ok, true, `got ${result.reason}`);
  assert.notEqual(result.alreadyDisposed, true);
  assert.equal(result.record.promotion.type, 'do-today');
  assert.equal(pa.items.length, 1);
});

test('D. the listener observes the SAME foreground claim and finishes it first: the foreground call reports its own success, one destination, final promoted', async () => {
  const room = makeRoom();
  const pa = makeFakePlanAuthority();
  const device = makeProductionDevice({ room, planAuthority: pa });
  const id = await device.capture('Same claim twice observed');
  const result = await device.promote(id, { type: 'do-today' });
  // Proves the race really happened: the reconciler ran for this id and did the work.
  assert.ok(device.reconciles.some(r => r.id === id && r.outcome.ok), 'reconciler ran for the foreground claim');
  assert.equal(result.ok, true, `got ${result.reason}`);
  assert.notEqual(result.alreadyDisposed, true);
  assert.equal(pa.items.length, 1);
  assert.equal(device.repository.read(id).status, 'promoted');
  await flush();
  assert.equal(room.raw()[id].status, 'promoted');
});

// ═══════════════════════════════════════════════════════════════════════════
// E-F: genuine competition stays deterministic; one pending capture never
// blocks another
// ═══════════════════════════════════════════════════════════════════════════

test('E. real two-device competing targets (A Do Today, B Schedule): one destination, one winner, the loser reports a non-success', async () => {
  const room = makeRoom();
  const pa = makeFakePlanAuthority();
  const a = makeProductionDevice({ room, planAuthority: pa, deviceId: 'device-a' });
  const b = makeProductionDevice({ room, planAuthority: pa, deviceId: 'device-b' });
  const id = await a.capture('Contested');
  await flush();
  assert.equal(b.repository.read(id).status, 'triaged', 'B sees the triaged capture');
  room.hold(id);
  const pA = a.promote(id, { type: 'do-today' });
  const pB = b.promote(id, { type: 'schedule', dateKey: '2026-10-10' });
  room.release(id);
  const [ra, rb] = await Promise.all([pA, pB]);
  await flush();
  const winners = [ra, rb].filter(r => r.ok && !r.alreadyDisposed);
  const losers = [ra, rb].filter(r => !r.ok);
  assert.equal(winners.length, 1, `exactly one success: ${JSON.stringify([ra.reason, rb.reason])}`);
  assert.equal(losers.length, 1);
  assert.ok(['already-claimed', 'already-disposed'].includes(losers[0].reason));
  assert.equal(pa.items.length, 1, 'one destination only');
  const remote = room.raw()[id];
  assert.equal(remote.status, 'promoted');
  assert.equal(a.repository.read(id).promotion.targetId, remote.promotion.targetId);
  assert.equal(b.repository.read(id).promotion.targetId, remote.promotion.targetId);
});

test('F. capture A pending (unknown outcome) does not block fresh capture B; A still settles to exactly one destination', async () => {
  const room = makeRoom();
  const pa = makeFakePlanAuthority();
  const device = makeProductionDevice({ room, planAuthority: pa, claimTimeoutMs: 10 });
  const a = await device.capture('Slow one');
  const b = await device.capture('Fast one');
  room.hold(a);
  const ra = await device.promote(a, { type: 'schedule', dateKey: '2026-10-10' });
  assert.equal(ra.ok, false); assert.equal(ra.reason, 'pending');
  assert.equal(pa.items.length, 0, 'pending never touches Plan Authority');
  const rb = await device.promote(b, { type: 'schedule', dateKey: '2026-10-11' });
  assert.equal(rb.ok, true, `B: ${rb.reason}`); assert.notEqual(rb.alreadyDisposed, true);
  room.release(a);
  await flush(); await flush();
  assert.equal(device.repository.read(a).status, 'promoted', 'late settlement reconciled A');
  assert.equal(pa.items.filter(i => i.id === brainDumpPlanItemId(a)).length, 1);
  assert.equal(pa.items.filter(i => i.id === brainDumpPlanItemId(b)).length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// G-N: edit and reopen handled items
// ═══════════════════════════════════════════════════════════════════════════

test('G+H. delegated: editing text and delegatedTo keeps it delegated, locally and remotely', async () => {
  const room = makeRoom();
  const clock = { now: T0 };
  const device = makeProductionDevice({ room, planAuthority: makeFakePlanAuthority(), clock });
  const id = await device.capture('Call contractor');
  await device.delegate(id, 'Alex');
  clock.now += 1000;
  assert.equal((await device.edit(id, { text: 'Call roofing contractor' })).ok, true);
  clock.now += 1000;
  assert.equal((await device.edit(id, { delegatedTo: 'Sam' })).ok, true);
  for (const record of [device.repository.read(id), room.raw()[id]]) {
    assert.equal(record.status, 'delegated');
    assert.equal(record.text, 'Call roofing contractor');
    assert.equal(record.delegatedTo, 'Sam');
    assert.equal(record.id, id);
  }
});

test('I. delegated -> Reopen returns to active triage with the same id, Important/Urgent kept, delegatedTo cleared', async () => {
  const room = makeRoom();
  const clock = { now: T0 };
  const device = makeProductionDevice({ room, planAuthority: makeFakePlanAuthority(), clock });
  const id = await device.capture('Tara ai community 1hr daily');
  await device.delegate(id, 'Tara');
  clock.now += 1000;
  assert.equal((await device.reopen(id)).ok, true);
  const local = device.repository.read(id);
  assert.equal(local.status, 'triaged');
  assert.equal(local.important, true); assert.equal(local.urgent, false);
  assert.equal(local.delegatedTo, null); assert.equal(local.disposedAt, null);
  assert.equal(local.reopenCount, 1);
  assert.deepEqual(Object.keys(device.repository.listAllRaw()), [id], 'no duplicate / new capture id');
  assert.equal(room.raw()[id].status, 'triaged');
  assert.equal(device.repository.reopen(id).reason, 'not-handled', 'a second click never bumps the generation twice');
});

test('J+K. archived: edit keeps it archived; Reopen returns it to triage', async () => {
  const room = makeRoom();
  const clock = { now: T0 };
  const device = makeProductionDevice({ room, planAuthority: makeFakePlanAuthority(), clock });
  const id = await device.capture('Old idea');
  await device.archive(id);
  clock.now += 1000;
  assert.equal((await device.edit(id, { text: 'Old idea, reworded' })).ok, true);
  assert.equal(device.repository.read(id).status, 'archived');
  assert.equal(room.raw()[id].text, 'Old idea, reworded');
  assert.equal(device.repository.editHandled(id, { delegatedTo: 'x' }).ok, false, 'delegatedTo only applies to delegated items');
  assert.equal(device.repository.editHandled(id, { text: '   ' }).field, 'text', 'empty text refused');
  clock.now += 1000;
  assert.equal((await device.reopen(id)).ok, true);
  assert.equal(device.repository.read(id).status, 'triaged');
  assert.equal(room.raw()[id].status, 'triaged');
});

test('L + reopened -> archive again: a reopened capture schedules to exactly one destination; another can be archived again', async () => {
  const room = makeRoom();
  const clock = { now: T0 };
  const pa = makeFakePlanAuthority();
  const device = makeProductionDevice({ room, planAuthority: pa, clock });
  const id = await device.capture('Second chance');
  await device.archive(id);
  clock.now += 1000;
  await device.reopen(id);
  const result = await device.promote(id, { type: 'schedule', dateKey: '2026-10-12', when: '09:00' });
  assert.equal(result.ok, true, result.reason); assert.notEqual(result.alreadyDisposed, true);
  assert.equal(pa.items.length, 1);
  assert.equal(room.raw()[id].status, 'promoted');

  const other = await device.capture('Archive me twice');
  await device.archive(other);
  clock.now += 1000;
  await device.reopen(other);
  clock.now += 1000;
  assert.equal((await device.archive(other)).ok, true);
  assert.equal(room.raw()[other].status, 'archived');
  assert.equal(room.raw()[other].reopenCount, 1);
});

test('M. a promoted capture cannot be reopened or edited into an independently promotable item', async () => {
  const room = makeRoom();
  const pa = makeFakePlanAuthority();
  const device = makeProductionDevice({ room, planAuthority: pa });
  const id = await device.capture('Already in plan');
  await device.promote(id, { type: 'do-today' });
  assert.equal(device.repository.reopen(id).reason, 'promoted');
  assert.equal(device.repository.editHandled(id, { text: 'changed' }).reason, 'promoted');
  const again = await device.promote(id, { type: 'schedule', dateKey: '2026-10-10' });
  assert.equal(again.alreadyDisposed, true);
  assert.equal(pa.items.length, 1);
  assert.equal(device.repository.read(id).text, 'Already in plan');
});

test('N. editing one handled capture never affects another', async () => {
  const room = makeRoom();
  const clock = { now: T0 };
  const device = makeProductionDevice({ room, planAuthority: makeFakePlanAuthority(), clock });
  const x = await device.capture('X');
  const y = await device.capture('Y');
  await device.delegate(x, 'Alex');
  await device.delegate(y, 'Alex');
  const yBefore = JSON.stringify(device.repository.read(y));
  clock.now += 1000;
  await device.edit(x, { text: 'X edited', delegatedTo: 'Sam' });
  await device.reopen(x);
  assert.equal(JSON.stringify(device.repository.read(y)), yBefore);
  assert.equal(room.raw()[y].delegatedTo, 'Alex');
});

// ═══════════════════════════════════════════════════════════════════════════
// O: account isolation
// ═══════════════════════════════════════════════════════════════════════════

test('O. handled-item edit/reopen never crosses rooms: a switched account cannot see, edit, reopen or receive another room\'s capture', async () => {
  const rooms = { uid_a: makeRoom(), uid_b: makeRoom() };
  const who = { owner: 'uid_a' };
  const device = makeProductionDevice({
    room: rooms.uid_a, planAuthority: makeFakePlanAuthority(), live: false,
    getOwner: () => who.owner, getRoomRef: () => rooms[who.owner].ref,
  });
  const id = await device.capture('Account A only');
  await device.delegate(id, 'Alex');
  who.owner = 'uid_b';
  assert.equal(device.repository.read(id), null, 'B cannot see A\'s capture');
  assert.equal(device.repository.editHandled(id, { text: 'hijack' }).reason, 'not-found');
  assert.equal(device.repository.reopen(id).reason, 'not-found');
  assert.equal((await device.bridge.pushCapture(id)).outcome, 'skipped', 'nothing of A\'s is pushed into B');
  assert.deepEqual(rooms.uid_b.raw(), {});
  who.owner = 'uid_a';
  assert.equal((await device.reopen(id)).ok, true);
  assert.equal(rooms.uid_a.raw()[id].status, 'triaged');
  assert.deepEqual(rooms.uid_b.raw(), {});
});

// ═══════════════════════════════════════════════════════════════════════════
// P: stale-device races converge deterministically
// ═══════════════════════════════════════════════════════════════════════════

test('P1. a stale delegated snapshot pushed after a reopen never re-delegates the reopened truth (even with a later updatedAt)', async () => {
  const room = makeRoom();
  const clock = { now: T0 };
  const pa = makeFakePlanAuthority();
  const x = makeProductionDevice({ room, planAuthority: pa, clock, deviceId: 'device-x' });
  const stale = makeProductionDevice({ room, planAuthority: pa, clock, deviceId: 'device-s', live: false });
  const id = await x.capture('Reopen me');
  await x.delegate(id, 'Alex');
  stale.repository.mergeRemote(id, room.raw()[id]); // the stale device last saw "delegated"
  clock.now += 1000;
  await x.reopen(id);
  clock.now += 5000; // the stale write is LATER by clock, but made from before the reopen
  assert.equal(stale.repository.editHandled(id, { delegatedTo: 'Sam' }).ok, true);
  await stale.bridge.syncCapture(id);
  assert.equal(room.raw()[id].status, 'triaged', 'remote stays reopened');
  assert.equal(room.raw()[id].delegatedTo, null);
  assert.equal(stale.repository.read(id).status, 'triaged', 'stale device converges to the reopened truth');
});

test('P2. archive -> reopen with a stale remote archive replayed later: the reopened truth wins', async () => {
  const room = makeRoom();
  const clock = { now: T0 };
  const x = makeProductionDevice({ room, planAuthority: makeFakePlanAuthority(), clock, deviceId: 'device-x' });
  const id = await x.capture('Archived once');
  await x.archive(id);
  const staleArchive = room.raw()[id];
  clock.now += 1000;
  await x.reopen(id);
  room.put(id, { ...staleArchive, updatedAt: clock.now + 9999 }); // a stale archive replay arriving late
  await flush();
  assert.equal(x.repository.read(id).status, 'triaged', 'the listener merge keeps the reopen');
  await x.bridge.syncCapture(id);
  assert.equal(room.raw()[id].status, 'triaged', 'the next push restores the reopened truth remotely');
});

test('P3. Reopen while another device already holds an authoritative promotion claim: the claim wins, exactly one destination', async () => {
  const room = makeRoom();
  const clock = { now: T0 };
  const pa = makeFakePlanAuthority();
  const x = makeProductionDevice({ room, planAuthority: pa, clock, deviceId: 'device-x', live: false });
  const id = await x.capture('Raced');
  // X archives locally while offline; that never reaches the room.
  assert.equal(x.repository.archive(id).ok, true);
  // Meanwhile another device's claim became authoritative remotely (its plan write not yet done).
  const claimed = {
    ...room.raw()[id],
    promotionClaim: { type: 'do-today', store: 'calendar', targetId: 'calplan:2026-10-01', planItemId: brainDumpPlanItemId(id), when: '', durationMinutes: null, claimedAt: clock.now + 10, claimedBy: 'device-y' },
    updatedAt: clock.now + 10, updatedBy: 'device-y',
  };
  room.put(id, claimed);
  clock.now += 1000;
  assert.equal(x.repository.reopen(id).ok, true, 'the local reopen is optimistic');
  await x.bridge.syncCapture(id);
  await flush();
  const remote = room.raw()[id];
  assert.ok(remote.promotionClaim || remote.status === 'promoted', 'the reopen never erased the authoritative claim');
  const local = x.repository.read(id);
  assert.ok(local.status === 'promoted' || local.promotionClaim, 'X converges to the promotion truth');
  assert.equal(pa.items.filter(i => i.id === brainDumpPlanItemId(id)).length, 1, 'exactly one destination (X reconciled the claim)');
  const again = await x.promote(id, { type: 'schedule', dateKey: '2026-10-10' });
  assert.ok(!again.ok || again.alreadyDisposed, 'no second promotion');
  assert.equal(pa.items.length, 1);
});

test('P4. two devices editing the same handled item converge by LWW regardless of push order', async () => {
  for (const order of [['x', 'y'], ['y', 'x']]) {
    const room = makeRoom();
    const clock = { now: T0 };
    const pa = makeFakePlanAuthority();
    const devices = {
      x: makeProductionDevice({ room, planAuthority: pa, clock, deviceId: 'device-x', live: false }),
      y: makeProductionDevice({ room, planAuthority: pa, clock, deviceId: 'device-y', live: false }),
    };
    const id = await devices.x.capture('Shared');
    await devices.x.delegate(id, 'Alex');
    devices.y.repository.mergeRemote(id, room.raw()[id]);
    clock.now = T0 + 1000; devices.x.repository.editHandled(id, { text: 'from x' });
    clock.now = T0 + 2000; devices.y.repository.editHandled(id, { text: 'from y' });
    for (const name of order) await devices[name].bridge.syncCapture(id);
    for (const name of order) await devices[name].bridge.syncCapture(id);
    assert.equal(room.raw()[id].text, 'from y', `order ${order}`);
    assert.equal(devices.x.repository.read(id).text, 'from y');
    assert.equal(devices.y.repository.read(id).status, 'delegated');
  }
});

test('P5. merge is order-independent for reopen-vs-stale pairs, and claim/promoted always beat a higher reopenCount', () => {
  const base = triageCapture(buildCapture({ id: 'bcap1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const delegated = delegateCapture(base, { delegatedTo: 'A', now: T0 + 2, updatedBy: 'd' }).record;
  const reopened = reopenCapture(delegated, { now: T0 + 3, updatedBy: 'd' }).record;
  const staleLater = { ...delegated, updatedAt: T0 + 99 };
  assert.deepEqual(mergeCaptureRecords(reopened, staleLater), mergeCaptureRecords(staleLater, reopened));
  assert.equal(mergeCaptureRecords(reopened, staleLater).status, 'triaged');
  const claim = claimPromotion(base, { promotion: { type: 'do-today', store: 'calendar', targetId: 't', planItemId: 'p' }, now: T0 + 2, updatedBy: 'd' }).record;
  const reopenedAgain = { ...reopened, reopenCount: 5, updatedAt: T0 + 50 };
  assert.ok(mergeCaptureRecords(claim, reopenedAgain).promotionClaim, 'a claim beats any reopen');
  assert.ok(mergeCaptureRecords(reopenedAgain, claim).promotionClaim);
});

test('records written before reopen existed normalize to reopenCount 0; a malformed reopenCount is rejected', () => {
  const legacy = { ...buildCapture({ id: 'bcap2', text: 'x', now: T0, updatedBy: 'd' }).record };
  delete legacy.reopenCount;
  assert.equal(normalizeCapture(legacy).reopenCount, 0);
  assert.equal(normalizeCapture({ ...legacy, reopenCount: -1 }), null);
  assert.equal(normalizeCapture({ ...legacy, reopenCount: 1.5 }), null);
  // An archive of a never-classified capture reopens to untriaged, not triaged.
  const archived = archiveCapture(legacy, { now: T0 + 1, updatedBy: 'd' }).record;
  assert.equal(reopenCapture(archived, { now: T0 + 2, updatedBy: 'd' }).record.status, 'untriaged');
});
