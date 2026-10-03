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
import { wireCopy } from './brain-dump-test-support.js';

import { createBrainDumpRepository } from './brain-dump-repository.js';
import { createBrainDumpSyncBridge, BRAIN_DUMP_REMOTE_PATH } from './brain-dump-sync.js';
import {
  brainDumpPlanItemId, buildCapture, triageCapture, archiveCapture, delegateCapture, reopenCapture,
  claimPromotion, finalizePromotion, promotedTo, mergeCaptureRecords, normalizeCapture,
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
  const events = []; // 'listener:<snapshot>' / 'resolved:<id>', in the order they happened
  const clone = wireCopy; // RTDB wire form: null keys pruned (see brain-dump-test-support.js)
  function notify() { events.push({ kind: 'listener', value: clone(store) }); listeners.forEach(fn => fn({ val: () => clone(store) })); }
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
        const settle = result => { events.push({ kind: 'resolved', id: segments[1] }); return result; };
        if (queue) return new Promise(resolve => queue.push(() => resolve(run(segments, updateFn)))).then(settle);
        return Promise.resolve(run(segments, updateFn)).then(settle);
      },
    };
  }
  return {
    ref: makeRef(),
    events,
    raw: () => clone(store) || {}, // test inspector: wire form, empty store as {}
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
  assert.equal(again.ok, false, 'a different intent is never reported as success');
  assert.equal(again.reason, 'already-disposed');
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
  assert.equal(room.raw()[id].delegatedTo ?? null, null); // absent on the wire = not delegated
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

// ═══════════════════════════════════════════════════════════════════════════
// FIX FIRST F3: "already promoted with my intent" must mean the EXACT intent
// ═══════════════════════════════════════════════════════════════════════════

/** Device A promotes first and its claim is authoritative remotely. Device B,
 *  stale (it still sees "triaged"), then promotes the SAME capture into the
 *  SAME day with a different intent. Both share store, targetId and the
 *  deterministic planItemId, so only the full intent can tell them apart. */
async function sameDayRace(first, second) {
  const room = makeRoom();
  const clock = { now: T0 };
  const pa = makeFakePlanAuthority();
  const a = makeProductionDevice({ room, planAuthority: pa, clock, deviceId: 'device-a', live: false });
  const b = makeProductionDevice({ room, planAuthority: pa, clock, deviceId: 'device-b', live: false });
  const id = await a.capture('Same day, two intents');
  b.repository.mergeRemote(id, room.raw()[id]);
  clock.now += 1000;
  const ra = await a.promote(id, first);
  clock.now += 1000;
  const rb = await b.promote(id, second);
  return { pa, id, ra, rb, a, b };
}

test('F3. Do Today vs a same-day Schedule 15:00: the loser is NOT reported success, one untimed plan item', async () => {
  const { pa, id, ra, rb, b } = await sameDayRace({ type: 'do-today' }, { type: 'schedule', dateKey: '2026-10-01', when: '15:00' });
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, false, `the Schedule caller must not see success (got ${JSON.stringify({ ok: rb.ok, reason: rb.reason })})`);
  assert.ok(['already-claimed', 'already-disposed'].includes(rb.reason));
  assert.equal(pa.items.filter(i => i.id === brainDumpPlanItemId(id)).length, 1);
  assert.equal(pa.items[0].when, '', 'the plan item is the untimed Do Today one');
  assert.equal(b.repository.read(id).promotion?.type ?? b.repository.read(id).promotionClaim?.type, 'do-today');
});

test('F3. Schedule 14:00 vs Schedule 15:00 on the same day: the loser is NOT reported equivalent success', async () => {
  const { pa, ra, rb } = await sameDayRace({ type: 'schedule', dateKey: '2026-10-10', when: '14:00' }, { type: 'schedule', dateKey: '2026-10-10', when: '15:00' });
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, false, `got ${JSON.stringify({ ok: rb.ok, reason: rb.reason })}`);
  assert.equal(pa.items.length, 1);
  assert.equal(pa.items[0].when, '14:00');
});

test('F3. differing durations are different intents too', async () => {
  const { pa, rb } = await sameDayRace({ type: 'schedule', dateKey: '2026-10-10', when: '14:00', durationMinutes: 30 }, { type: 'schedule', dateKey: '2026-10-10', when: '14:00', durationMinutes: 60 });
  assert.equal(rb.ok, false);
  assert.equal(pa.items.length, 1);
  assert.equal(pa.items[0].durationMinutes, 30);
});

test('F3. an identical Schedule (date, time, duration) retried from another device is an idempotent success, no duplicate', async () => {
  const intent = { type: 'schedule', dateKey: '2026-10-10', when: '14:00', durationMinutes: 30 };
  const { pa, ra, rb } = await sameDayRace(intent, intent);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true, `got ${rb.reason}`);
  assert.equal(pa.items.length, 1);
});

test('F3. exact retries on the same device: same Do Today and same Schedule are idempotent successes; a different one after it is not', async () => {
  const room = makeRoom();
  const pa = makeFakePlanAuthority();
  const device = makeProductionDevice({ room, planAuthority: pa });
  const today = await device.capture('Do it today');
  await device.promote(today, { type: 'do-today' });
  const retryToday = await device.promote(today, { type: 'do-today' });
  assert.equal(retryToday.ok, true); assert.equal(retryToday.alreadyDisposed, true);

  const later = await device.capture('Schedule it');
  const first = await device.promote(later, { type: 'schedule', dateKey: '2026-10-10', when: '14:00' });
  assert.equal(first.ok, true); assert.notEqual(first.alreadyDisposed, true);
  const retry = await device.promote(later, { type: 'schedule', dateKey: '2026-10-10', when: '14:00' });
  assert.equal(retry.ok, true); assert.equal(retry.alreadyDisposed, true);
  const moved = await device.promote(later, { type: 'schedule', dateKey: '2026-10-10', when: '15:00' });
  assert.equal(moved.ok, false); assert.equal(moved.reason, 'already-disposed');
  assert.equal(pa.items.length, 2);
});

test('F3. the listener-first self-reconciliation of a TIMED Schedule is still the caller\'s own success, and the finalized promotion records the exact intent', async () => {
  const room = makeRoom();
  const pa = makeFakePlanAuthority();
  const device = makeProductionDevice({ room, planAuthority: pa });
  const id = await device.capture('Timed');
  const result = await device.promote(id, { type: 'schedule', dateKey: '2026-10-10', when: '15:00', durationMinutes: 45 });
  assert.ok(device.reconciles.some(r => r.id === id && r.outcome.ok), 'the reconciler finished it first');
  assert.equal(result.ok, true, result.reason); assert.notEqual(result.alreadyDisposed, true);
  const promotion = device.repository.read(id).promotion;
  assert.equal(promotion.when, '15:00');
  assert.equal(promotion.durationMinutes, 45);
  assert.equal(pa.items.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX FIRST #2 F5: the EXACT production path, over the real (null-pruned) wire
// ═══════════════════════════════════════════════════════════════════════════

/** The listener's delivery of `id` around the claim commit, as the room recorded it. */
function claimDelivery(room, id) {
  const index = room.events.findIndex(e => e.kind === 'listener' && e.value?.[id]?.promotionClaim);
  return { index, record: index >= 0 ? room.events[index].value[id] : null, resolvedAt: room.events.findIndex((e, i) => i > index && e.kind === 'resolved' && e.id === id) };
}

for (const [label, intent, expected] of [
  ['Schedule 14:30, 30 minutes', { type: 'schedule', dateKey: '2026-10-10', when: '14:30', durationMinutes: 30 }, { when: '14:30', durationMinutes: 30 }],
  ['Do Today', { type: 'do-today' }, { when: '', durationMinutes: undefined }],
]) {
  test(`F5 production path (${label}): pruned listener snapshot BEFORE resolve -> normalizes -> reconciler finishes -> foreground SUCCESS, one plan item`, async () => {
    const room = makeRoom();
    const pa = makeFakePlanAuthority();
    const device = makeProductionDevice({ room, planAuthority: pa });
    const id = await device.capture(`Production ${label}`);
    const result = await device.promote(id, intent);

    // The wire really was pruned, and really did arrive before the transaction settled.
    const delivered = claimDelivery(room, id);
    assert.ok(delivered.record, 'the listener delivered the committed claim');
    for (const key of ['disposedAt', 'delegatedTo', 'promotion']) assert.equal(key in delivered.record, false, `${key} pruned on the wire`);
    assert.ok(delivered.resolvedAt > delivered.index, 'listener first, transaction resolved after');
    // ... and the reconciler (not the foreground call) is what finished it, from that pruned snapshot.
    assert.ok(device.reconciles.some(r => r.id === id && r.outcome.ok), 'maybeReconcile ran off the pruned snapshot');

    assert.equal(result.ok, true, `UI would show: ${result.reason}`);
    assert.notEqual(result.alreadyDisposed, true, 'a plain success, not "already handled" and never "elsewhere"');
    assert.equal(pa.items.length, 1);
    assert.equal(pa.items[0].when, expected.when);
    assert.equal(pa.items[0].durationMinutes, expected.durationMinutes);
    const local = device.repository.read(id);
    assert.equal(local.status, 'promoted');
    assert.equal(local.promotionClaim, null, 'claim finalized');
    await flush();
    const remote = normalizeCapture(room.raw()[id]);
    assert.equal(remote.status, 'promoted');
    assert.equal(remote.promotionClaim, null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// F5: captures already stuck in production (authoritative claim, no plan item)
// ═══════════════════════════════════════════════════════════════════════════

/** Exactly what cf43080 left behind: its claim transaction committed, but neither
 *  the listener nor finishClaimAttempt could normalize the pruned record, so no
 *  plan item was ever created and the remote holds a bare claim. */
function stuckClaimRecord(id, claim) {
  const base = triageCapture(buildCapture({ id, text: 'Stuck in production', now: T0, updatedBy: 'old-phone' }).record, { important: true, urgent: false, now: T0 + 1, updatedBy: 'old-phone' }).record;
  const claimed = claimPromotion(base, { promotion: { planItemId: brainDumpPlanItemId(id), store: 'calendar', ...claim }, now: T0 + 2, updatedBy: 'old-phone' }).record;
  delete claimed.reopenCount; // cf43080 never wrote it
  return claimed;
}

test('F5 already-stuck claim (current/future day): a fresh NEW client loading it self-recovers, exactly one destination, promoted', async () => {
  const room = makeRoom();
  const pa = makeFakePlanAuthority();
  const id = 'bstuckfuture';
  room.put(id, stuckClaimRecord(id, { type: 'schedule', targetId: 'calplan:2026-10-10', when: '14:30', durationMinutes: 30 }));
  assert.equal('disposedAt' in room.raw()[id], false, 'stored in its pruned wire shape');
  assert.equal(pa.items.length, 0, 'stuck: no plan item');

  const device = makeProductionDevice({ room, planAuthority: pa }); // attach() replays the subtree
  await flush();
  assert.equal(pa.items.length, 1);
  assert.equal(pa.items[0].when, '14:30');
  assert.equal(device.repository.read(id).status, 'promoted');
  assert.equal(normalizeCapture(room.raw()[id]).status, 'promoted', 'the recovery is pushed back');

  const second = makeProductionDevice({ room, planAuthority: pa, deviceId: 'device-2' });
  await flush();
  assert.equal(pa.items.length, 1, 'a second device loading afterwards never duplicates');
  assert.equal(second.repository.read(id).status, 'promoted');
});

test('F5 already-stuck claim on a day that has ENDED: not recoverable by the existing contract; it stays claimed with no plan item (reported residual)', async () => {
  const room = makeRoom();
  const pa = makeFakePlanAuthority();
  // Real Plan Authority refuses a past target (assertDirectSchedulingTarget).
  pa.addItem = () => { throw new Error('Past My Days are history. Reschedule unfinished work from Unfinished instead.'); };
  const id = 'bstuckpast';
  room.put(id, stuckClaimRecord(id, { type: 'do-today', targetId: 'calplan:2026-09-01', when: '' }));
  const device = makeProductionDevice({ room, planAuthority: pa });
  await flush();
  const local = device.repository.read(id);
  assert.equal(local.status, 'triaged', 'still visible, now normalized');
  assert.ok(local.promotionClaim, 'the claim is still authoritative');
  assert.equal(pa.items.length, 0, 'no plan item can be created on an ended day');
  assert.equal(device.repository.archive(id).reason, 'promotion-claimed', 'and the claim still blocks archive/delegate');
});

// ═══════════════════════════════════════════════════════════════════════════
// F6: legacy promotions with unknown provenance are never PROVABLY equivalent
// ═══════════════════════════════════════════════════════════════════════════

/** A promoted record as cf43080 finalized it: no intentRecorded, no when/durationMinutes. */
function legacyPromotedRepository({ type, targetId }) {
  const repository = createBrainDumpRepository({ storage: memory(), getOwner: () => 'uid_a', now: () => T0, deviceId: () => 'device-1' });
  const id = 'blegacy1';
  const base = triageCapture(buildCapture({ id, text: 'Legacy promotion', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const legacy = { ...base, status: 'promoted', disposedAt: T0 + 2, promotion: { type, store: 'calendar', targetId, planItemId: brainDumpPlanItemId(id), promotedAt: T0 + 2 } };
  delete legacy.reopenCount;
  repository.mergeRemote(id, wireCopy(legacy));
  return { repository, id };
}

const claimNever = () => { throw new Error('a legacy promoted capture must never be claimed again'); };

test('F6 A. legacy promoted Do Today -> exact Do Today retry: provably equivalent (Do Today is untimed by construction), idempotent success', async () => {
  const pa = makeFakePlanAuthority();
  const { repository, id } = legacyPromotedRepository({ type: 'do-today', targetId: 'calplan:2026-10-01' });
  assert.equal(repository.read(id).promotion.intentRecorded, false);
  const result = await promoteCaptureToPlan({ repository, planAuthority: pa, claimPromotionRemote: claimNever, id, type: 'do-today', now: T0 + 10, deviceId: 'device-1' });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyDisposed, true);
  assert.equal(pa.items.length, 0, 'never a second plan item');
});

test('F6 B. legacy promoted Do Today -> a same-day Schedule: non-success', async () => {
  const pa = makeFakePlanAuthority();
  const { repository, id } = legacyPromotedRepository({ type: 'do-today', targetId: 'calplan:2026-10-01' });
  const result = await promoteCaptureToPlan({ repository, planAuthority: pa, claimPromotionRemote: claimNever, id, type: 'schedule', dateKey: '2026-10-01', now: T0 + 10, deviceId: 'device-1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'already-disposed');
});

test('F6 C. legacy promoted Schedule with no recorded time/duration -> neither an untimed nor a timed Schedule is reported equivalent', async () => {
  const pa = makeFakePlanAuthority();
  const { repository, id } = legacyPromotedRepository({ type: 'schedule', targetId: 'calplan:2026-10-10' });
  const promotion = repository.read(id).promotion;
  assert.equal(promotion.when, null, 'unknown, never invented as untimed');
  assert.equal(promotion.durationMinutes, null);
  for (const retry of [{ when: '' }, { when: '14:00' }, { when: '14:00', durationMinutes: 30 }]) {
    const result = await promoteCaptureToPlan({ repository, planAuthority: pa, claimPromotionRemote: claimNever, id, type: 'schedule', dateKey: '2026-10-10', now: T0 + 10, deviceId: 'device-1', ...retry });
    assert.equal(result.ok, false, `retry ${JSON.stringify(retry)} must not be reported equivalent`);
    assert.equal(result.reason, 'already-disposed');
  }
  assert.equal(pa.items.length, 0);
});

test('F6 D. a legacy promoted record stays promoted, keeps its unknown provenance through a wire round trip, and is never re-promoted', async () => {
  const pa = makeFakePlanAuthority();
  const { repository, id } = legacyPromotedRepository({ type: 'schedule', targetId: 'calplan:2026-10-10' });
  const roundTripped = normalizeCapture(wireCopy(repository.read(id)));
  assert.equal(roundTripped.status, 'promoted');
  assert.equal(roundTripped.promotion.intentRecorded, false, 'still unknown after the wire');
  assert.equal(roundTripped.promotion.when, null);
  await promoteCaptureToPlan({ repository, planAuthority: pa, claimPromotionRemote: claimNever, id, type: 'do-today', now: T0 + 10, deviceId: 'device-1' });
  assert.equal(repository.read(id).status, 'promoted');
  assert.equal(pa.items.length, 0);
  // Renders through the destination helper with no invented time.
  const { promotionDestination } = await import('./brain-dump-promotion.js');
  const destination = promotionDestination(pa, repository.read(id));
  assert.equal(destination.dateKey, '2026-10-10');
  assert.equal(destination.when, '', 'no plan item found and no recorded time: shows no time rather than a guess');
});

test('F6: a NEW finalized promotion records its intent, so an explicit untimed Schedule survives the wire as provably untimed', () => {
  const base = triageCapture(buildCapture({ id: 'bnewprom', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: false, now: T0 + 1, updatedBy: 'd' }).record;
  const claim = claimPromotion(base, { promotion: { type: 'schedule', store: 'calendar', targetId: 'calplan:2026-10-10', planItemId: brainDumpPlanItemId('bnewprom'), when: '' }, now: T0 + 2, updatedBy: 'd' }).record;
  const promoted = normalizeCapture(wireCopy(finalizePromotion(claim, { now: T0 + 3, updatedBy: 'd' }).record));
  assert.equal(promoted.promotion.intentRecorded, true);
  assert.equal(promoted.promotion.when, '');
  assert.equal(promoted.promotion.durationMinutes, null, 'pruned on the wire, still KNOWN none');
  assert.equal(promotedTo(promoted, { type: 'schedule', store: 'calendar', targetId: 'calplan:2026-10-10', planItemId: brainDumpPlanItemId('bnewprom'), when: '' }), true);
});

test('authority order holds over the wire: promoted and claim both beat any reopen, independent of arrival order', () => {
  const base = triageCapture(buildCapture({ id: 'bauth1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const reopened = { ...reopenCapture(delegateCapture(base, { delegatedTo: 'A', now: T0 + 2, updatedBy: 'd' }).record, { now: T0 + 3, updatedBy: 'd' }).record, reopenCount: 7, updatedAt: T0 + 99 };
  const claim = claimPromotion(base, { promotion: { type: 'do-today', store: 'calendar', targetId: 't', planItemId: 'p' }, now: T0 + 2, updatedBy: 'd' }).record;
  const promoted = finalizePromotion(claim, { now: T0 + 4, updatedBy: 'd' }).record;
  for (const [winner, label] of [[claim, 'claim'], [promoted, 'promoted']]) {
    const a = mergeCaptureRecords(wireCopy(winner), wireCopy(reopened));
    const b = mergeCaptureRecords(wireCopy(reopened), wireCopy(winner));
    assert.deepEqual(a, b, `${label}: arrival order never decides`);
    assert.equal(a.status, winner.status, `${label} beats the reopen`);
    assert.equal(a.schemaVersion, 2, 'and the generation is still carried');
  }
});
