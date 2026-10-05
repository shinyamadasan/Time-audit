// brain-dump-promotion-fence.test.js
//
// Brain Dump Production UX Correction V1, architecture fix #5: the server-side
// promotion fence + client queue guard, attacked at every crash point.
//
// Every device here has its OWN real Plan Authority and local caches, and every
// write goes through ONE database that enforces the REAL firebase.rules.json and
// behaves like the RTDB wire (brain-dump-fence-harness.js). Plan writes are
// local-first, exactly as in production, so "written on this device, never
// pushed" and "the process died here" are real states, not simulated outcomes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, flush, at, calId, ROOM, remoteItemsFor, remoteCapture } from './brain-dump-fence-harness.js';
import { brainDumpPlanItemId } from './brain-dump-model.js';
import { promoteCaptureToPlan } from './brain-dump-promotion.js';
import { physicalTargetKey, setBrainDumpCaptureLookup } from './plan-item-origin.js';
import * as oldModel from './fixtures/brain-dump-pre-reopen/brain-dump-model.js';
import { wireCopy } from './brain-dump-test-support.js';

const TODAY = '2026-10-03';
const NEXT = '2026-10-04';
const FUTURE = '2026-10-08';
const NOW = at(TODAY, '09:00');
const AFTER_END = at(NEXT, '09:00');

test.afterEach(() => setBrainDumpCaptureLookup(null));

/** A NEW-client claim for today that commits remotely while its device dies before
 *  writing anything: no reconciler runs on it (crash point C2). */
async function claimThenCrash(world, text = 'Crashed after claim') {
  const writer = world.makeDevice({ name: 'writer', listen: false });
  writer.activate();
  await flush();
  const id = await writer.capture(text);
  const today = writer.planAuthority.current();
  const pending = writer.bridge.claimPromotionRemote(id, { type: 'do-today', store: today.store, targetId: today.id, targetKey: physicalTargetKey(today.store, today.id), planItemId: brainDumpPlanItemId(id), when: '' });
  writer.state.crashed = true; // the process dies the instant the claim is in flight
  const claim = await pending;
  assert.equal(claim.ok, true, 'the claim committed');
  writer.bridge.detach();
  return { writer, id, targetId: today.id };
}

/** Crash point C5 (local half): the item IS written on the writer, but neither the
 *  plan push nor the Brain Dump finalize ever reaches the server. */
async function writeLocallyThenCrash(world) {
  const { writer, id } = await claimThenCrash(world, 'Written locally, never pushed');
  writer.state.crashed = false;
  writer.state.plansOnline = false;
  writer.state.brainDumpOnline = false;
  await writer.settle(id); // the reconciler resumes: writes the item locally, finalizes locally
  await flush();
  assert.equal(writer.repository.read(id).status, 'promoted', 'locally promoted');
  assert.equal(writer.planAuthority.rawItems(writer.planAuthority.targetById(calId(TODAY))).filter(i => i.id === brainDumpPlanItemId(id)).length, 1, 'item on the writer only');
  writer.crash();
  return { writer, id };
}

function freshDevice(world, name) {
  const device = world.makeDevice({ name });
  device.useGuard();
  return device;
}

async function endTheDayAndHeal(world, name = 'healer') {
  world.clock.now = AFTER_END;
  const healer = freshDevice(world, name);
  await flush();
  await healer.sweep();
  await flush();
  return healer;
}

// ═══════════════════════════════════════════════════════════════════════════
// A-E: crash points
// ═══════════════════════════════════════════════════════════════════════════

test('A (C2/C10). claim commits, crash before any item, the day ends: recovered to triage; the old item can never appear', async () => {
  const world = makeWorld({ now: NOW });
  const { writer, id } = await claimThenCrash(world);
  const healer = await endTheDayAndHeal(world);
  assert.deepEqual(healer.recovered(), [id], 'no permanent claim');
  const capture = remoteCapture(world.db, id);
  assert.equal(capture.status, 'triaged');
  assert.equal(capture.promotionClaim, null);
  assert.equal(capture.claimEpoch, 1);
  // The crashed writer restarts after the recovery: it can no longer write anything for the old claim.
  await writer.restart();
  assert.equal(remoteItemsFor(world.db, TODAY, id).length, 0);
  assert.equal(writer.repository.read(id).promotionClaim, null, 'the writer converges to the recovery');
});

for (const order of ['plan push first', 'Brain Dump first']) {
  test(`B (C5/C8, ${order}). item written locally, crash before any sync, another device recovers: the stale reconnect push is refused (server) or withheld (guard), never lands`, async () => {
    const world = makeWorld({ now: NOW });
    const { writer, id } = await writeLocallyThenCrash(world);
    const healer = await endTheDayAndHeal(world);
    assert.deepEqual(healer.recovered(), [id]);
    // The writer comes back.
    writer.state.crashed = false;
    writer.useGuard();
    if (order === 'plan push first') {
      writer.state.plansOnline = true;
      await writer.calendar.pushAllLocal();
      await flush();
      assert.ok(world.db.denials.some(d => d.path.includes('calendarPlanFences')), 'the server refused the old item');
      writer.state.brainDumpOnline = true;
      writer.bridge.attach();
      await flush();
      await writer.calendar.pushAllLocal(); // retried once the writer knows: now withheld
      await flush();
    } else {
      writer.state.brainDumpOnline = true;
      writer.bridge.attach();
      await flush();
      const denialsBefore = world.db.denials.length;
      writer.state.plansOnline = true;
      await writer.calendar.pushAllLocal();
      await flush();
      assert.equal(world.db.denials.length, denialsBefore, 'the guard withheld it: not even one denied write');
    }
    assert.equal(remoteItemsFor(world.db, TODAY, id).length, 0, 'the old item never landed');
    const capture = remoteCapture(world.db, id);
    assert.equal(capture.status, 'triaged', 'the remote capture stays recovered');
    assert.equal(capture.claimEpoch, 1);
    assert.equal(writer.repository.read(id).status, 'triaged', 'the writer\'s stale local "promoted" lost to the recovery');
    const local = writer.planAuthority.rawItems(writer.planAuthority.targetById(calId(TODAY)));
    assert.equal(local.filter(i => i.id === brainDumpPlanItemId(id)).length, 0, 'the stale ghost is purged from the writer');
  });
}

for (const when of ['day still open', 'day ended']) {
  test(`C (C5, ${when}). the item reached the server, crash before the Brain Dump finalize: a fresh device finalizes promoted, never recovers, no duplicate`, async () => {
    const world = makeWorld({ now: NOW });
    const { writer, id } = await claimThenCrash(world, 'Pushed, not finalized');
    writer.state.crashed = false;
    writer.state.brainDumpOnline = false; // its finalize never leaves the device
    await writer.settle(id);
    await flush();
    assert.equal(remoteItemsFor(world.db, TODAY, id).length, 1, 'the item is on the server');
    assert.ok(remoteCapture(world.db, id).promotionClaim, 'the server still shows only the claim');
    writer.crash();
    if (when === 'day ended') world.clock.now = AFTER_END;
    const fresh = freshDevice(world, 'fresh');
    await flush();
    await fresh.sweep();
    await flush();
    assert.equal(remoteCapture(world.db, id).status, 'promoted');
    assert.deepEqual(fresh.recovered(), []);
    assert.equal(remoteItemsFor(world.db, TODAY, id).length, 1);
  });
}

test('D (C6). the destination write fails definitively before any commit: retried while the day is open; recovered once it ends', async () => {
  // Open day: one failed attempt, then the next observer succeeds.
  {
    const world = makeWorld({ now: NOW });
    const { id } = await claimThenCrash(world);
    // Listener attached only AFTER the failure is injected, so its very first settle sees it.
    const device = world.makeDevice({ name: 'retrier', listen: false });
    device.useGuard();
    const addItem = device.planAuthority.addItem;
    let failing = true;
    device.planAuthority.addItem = input => { if (failing) throw new Error('storage quota exceeded'); return addItem(input); };
    device.bridge.attach();
    await flush(); // the listener's own settle attempt fails
    await device.sweep(); // and so does the sweep's
    await flush();
    assert.ok(remoteCapture(world.db, id).promotionClaim, 'the failed attempts left the claim for a retry, not released');
    assert.equal(remoteItemsFor(world.db, TODAY, id).length, 0);
    failing = false;
    await device.sweep();
    await flush();
    assert.equal(remoteCapture(world.db, id).status, 'promoted');
    assert.equal(remoteItemsFor(world.db, TODAY, id).length, 1);
  }
  // It never succeeded before the day ended: recovered.
  {
    const world = makeWorld({ now: NOW });
    const { id } = await claimThenCrash(world);
    const device = world.makeDevice({ name: 'failer', listen: false });
    device.planAuthority.addItem = () => { throw new Error('storage quota exceeded'); };
    device.bridge.attach();
    await flush();
    await device.sweep();
    await flush();
    assert.ok(remoteCapture(world.db, id).promotionClaim);
    const healer = await endTheDayAndHeal(world);
    // Whichever live device got there first (the still-listening failer may), exactly one recovery.
    assert.equal(healer.recovered().length + device.recovered().length, 1);
    const capture = remoteCapture(world.db, id);
    assert.equal(capture.status, 'triaged');
    assert.equal(capture.promotionClaim, null);
    assert.equal(capture.claimEpoch, 1);
  }
});

test('E (C7/C4). the destination outcome is UNKNOWN (no authoritative read): never released; resolved as soon as a read succeeds', async () => {
  const world = makeWorld({ now: NOW });
  const { id } = await claimThenCrash(world);
  world.clock.now = AFTER_END;
  const healer = freshDevice(world, 'healer');
  healer.state.plansOnline = false; // its destination read cannot reach the server
  await flush();
  await healer.sweep();
  await flush();
  assert.deepEqual(healer.recovered(), [], 'not released on uncertainty');
  const pending = remoteCapture(world.db, id);
  assert.ok(pending.promotionClaim?.revokedAt, 'frozen (revoked), waiting for a read');
  assert.equal(pending.status, 'triaged');
  // Not permanent: the next observer that can read resolves it.
  healer.state.plansOnline = true;
  await healer.sweep();
  await flush();
  assert.deepEqual(healer.recovered(), [id]);
  assert.equal(remoteCapture(world.db, id).claimEpoch, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// F-H: late writes and the owner's next choice
// ═══════════════════════════════════════════════════════════════════════════

for (const [label, intent, dateKey] of [
  ['G. a new Do Today', { type: 'do-today' }, NEXT],
  ['H. a new future Schedule', { type: 'schedule', dateKey: FUTURE, when: '15:00' }, FUTURE],
]) {
  for (const order of ['old push first', 'new push first']) {
    test(`${label} after recovery while the old attempt settles (${order}): old refused, new accepted, exactly one destination`, async () => {
      const world = makeWorld({ now: NOW });
      const { writer, id } = await writeLocallyThenCrash(world);
      const owner = await endTheDayAndHeal(world, 'owner');
      const pushOld = async () => {
        writer.state.crashed = false;
        writer.state.plansOnline = true; // reconnects its plans BEFORE learning about the recovery
        await writer.calendar.pushAllLocal();
        await flush();
      };
      const promoteNew = async () => {
        const target = intent.type === 'do-today' ? owner.planAuthority.current() : owner.planAuthority.dayForScheduledDate(intent.dateKey, intent.when).target;
        const result = await promoteCaptureToPlan({ repository: owner.repository, planAuthority: owner.planAuthority, claimPromotionRemote: owner.bridge.claimPromotionRemote, id, now: world.clock.now, deviceId: 'owner', ...intent });
        assert.equal(result.ok, true, result.reason);
        assert.notEqual(result.alreadyDisposed, true);
        assert.equal(target.dateKey, dateKey);
        await owner.bridge.syncCapture(id);
        await flush();
      };
      if (order === 'old push first') { await pushOld(); await promoteNew(); } else { await promoteNew(); await pushOld(); }
      assert.equal(remoteItemsFor(world.db, TODAY, id).length, 0, 'the old destination never lands');
      assert.equal(remoteItemsFor(world.db, dateKey, id).length, 1, 'the new destination exists');
      assert.equal(remoteItemsFor(world.db, dateKey, id)[0].brainDumpOrigin.claimEpoch, 1, 'under the new generation');
      const capture = remoteCapture(world.db, id);
      assert.equal(capture.status, 'promoted');
      assert.equal(capture.promotion.targetId, calId(dateKey), 'the new intent, never silently replaced by the old');
      // The writer finally hears about it, and converges.
      writer.state.brainDumpOnline = true;
      writer.bridge.attach();
      await flush();
      assert.equal(writer.repository.read(id).promotion?.targetId, calId(dateKey));
    });
  }
}

test('I. two devices retry the same outstanding claim on an open day: exactly one destination', async () => {
  const world = makeWorld({ now: NOW });
  const { id } = await claimThenCrash(world);
  const a = freshDevice(world, 'a');
  const b = freshDevice(world, 'b');
  await flush();
  await Promise.all([a.sweep(), b.sweep()]);
  await flush();
  await Promise.all([a.calendar.pushAllLocal(), b.calendar.pushAllLocal()]);
  await flush();
  assert.equal(remoteItemsFor(world.db, TODAY, id).length, 1);
  assert.equal(remoteCapture(world.db, id).status, 'promoted');
  assert.equal(world.db.denials.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// J-K: production data and the reviewed cases
// ═══════════════════════════════════════════════════════════════════════════

test('J. the real cf43080 stuck shape (generation 1, unrevoked, pruned) on an ended day still self-heals', async () => {
  const world = makeWorld({ now: AFTER_END });
  const T = at('2026-10-02', '20:00');
  const built = oldModel.buildCapture({ id: 'bstuckj1', text: 'Old production claim', now: T, updatedBy: 'old-phone' }).record;
  const triaged = oldModel.triageCapture(built, { important: true, urgent: false, now: T + 1, updatedBy: 'old-phone' }).record;
  const stuck = oldModel.claimPromotion(triaged, { promotion: { type: 'do-today', store: 'calendar', targetId: calId(TODAY), planItemId: brainDumpPlanItemId('bstuckj1'), when: '' }, now: T + 2, updatedBy: 'old-phone' }).record;
  world.db.seed(`rooms/${ROOM}/brainDump/bstuckj1`, wireCopy(stuck));
  const healer = freshDevice(world, 'healer');
  healer.activate();
  await flush();
  await healer.sweep();
  await flush();
  assert.deepEqual(healer.recovered(), ['bstuckj1']);
  const capture = remoteCapture(world.db, 'bstuckj1');
  assert.equal(capture.status, 'triaged');
  assert.equal(capture.important, true);
  assert.equal(capture.schemaVersion, 2);
});

test('K. a past claim whose deterministic item already exists on the server is finalized promoted, never recovered', async () => {
  const world = makeWorld({ now: NOW });
  const { writer, id } = await claimThenCrash(world, 'Item landed');
  writer.state.crashed = false;
  writer.state.brainDumpOnline = false;
  await writer.settle(id); // pushes the item (plans online), its finalize stays local
  await flush();
  writer.crash();
  assert.equal(remoteItemsFor(world.db, TODAY, id).length, 1);
  const healer = await endTheDayAndHeal(world);
  assert.deepEqual(healer.recovered(), []);
  assert.equal(remoteCapture(world.db, id).status, 'promoted');
  assert.equal(remoteItemsFor(world.db, TODAY, id).length, 1, 'no duplicate');
});

test('a normal fresh promotion is untouched by the fence: one item, carrying its origin, accepted by the server', async () => {
  const world = makeWorld({ now: NOW });
  const device = freshDevice(world, 'owner');
  device.activate();
  await flush();
  const id = await device.capture('Plain Do Today');
  const result = await promoteCaptureToPlan({ repository: device.repository, planAuthority: device.planAuthority, claimPromotionRemote: device.bridge.claimPromotionRemote, id, type: 'do-today', now: world.clock.now, deviceId: 'owner' });
  assert.equal(result.ok, true, result.reason);
  await device.bridge.syncCapture(id);
  await flush();
  const items = remoteItemsFor(world.db, TODAY, id);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].brainDumpOrigin, { v: 2, claimEpoch: 0, type: 'do-today', store: 'calendar', targetKey: calId(TODAY) });
  assert.equal(world.db.read(`rooms/${ROOM}/calendarPlanFences/${calId(TODAY)}/bdp1|${id}`).id, `bdp1|${id}`, 'at its stable keyed child');
  assert.ok(!(world.db.read(`rooms/${ROOM}/calendarPlans/${calId(TODAY)}`)?.items || []).some(item => item.id === `bdp1|${id}`), 'and never inside the plan record array');
  assert.equal(world.db.denials.length, 0);
});
