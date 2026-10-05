// brain-dump-fence-sdk.test.js
//
// The final rules + the final stable-key representation, exercised with REAL Firebase JS SDK
// connections (10.12.2, the same compat build index.html loads) against the REAL Realtime Database
// emulator. No REST shortcuts, no interpreter, no fake database:
//
//   1. THE RTDB TWO-CONNECTION ORDERING PROOF. Two independent SDK connections (two devices) race a
//      stale G1 writer against the revoke. Both serialization orders are FORCED, then repeated as real
//      races: a revoke that has been acknowledged can never be followed by an absent read and then an
//      old item appearing.
//   2. THE FINAL NEW STACK (calendar sync + Brain Dump sync + settleOutstandingClaim) on the real SDK:
//      the crash/recovery protocol resolves to promoted-when-present and recovered-when-absent.
//   3. THE REAL cf43080 CLIENT (byte-identical modules in fixtures/cf43080-client) operating on the
//      same database after fenced data exists and under the NEW rules: ordinary plan operations,
//      whole-plan transactions, Brain Dump v1 records, its own Do Today promotion, archive/delegate,
//      and a stuck old claim that the new client recovers.
//
// Needs Java + the cached emulator jar (see rtdb-emulator-support.js). It FAILS, never skips, without
// them. Run: npm run test:fence-sdk

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startEmulator } from './rtdb-emulator-support.js';
import { connectSdk } from './rtdb-sdk-support.js';
import { CAPTURE, ITEM_ID, STORES, T, capture, captureAt, claim, fencedItem, ordinary, planRecord, promotedCapture } from './fence-rules-fixtures.js';

import { createCalendarPlanRepository } from './calendar-plan-repository.js';
import { createCalendarPlanSyncBridge } from './calendar-plan-sync.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { createOperationalPlanSyncBridge } from './operational-plan-sync.js';
import { createBrainDumpRepository } from './brain-dump-repository.js';
import { createBrainDumpSyncBridge } from './brain-dump-sync.js';
import { brainDumpPlanItemId, normalizeCapture } from './brain-dump-model.js';
import { promoteCaptureToPlan, settleOutstandingClaim } from './brain-dump-promotion.js';
import { fencedPresence, partitionOutboundItemsWith, physicalTargetKey } from './plan-item-origin.js';
import { memoryStorage } from './calendar-plan-test-support.js';

import { createCalendarPlanRepository as createOldCalendarRepository } from './fixtures/cf43080-client/calendar-plan-repository.js';
import { createCalendarPlanSyncBridge as createOldCalendarBridge } from './fixtures/cf43080-client/calendar-plan-sync.js';
import { createOperationalPlanRepository as createOldOperationalRepository } from './fixtures/cf43080-client/operational-plan-repository.js';
import { createOperationalPlanSyncBridge as createOldOperationalBridge } from './fixtures/cf43080-client/operational-plan-sync.js';
import { mergeDatePlans as oldMergeDatePlans } from './fixtures/cf43080-client/plan-tomorrow-model.js';
import { createBrainDumpRepository as createOldBrainDumpRepository } from './fixtures/cf43080-client/brain-dump-repository.js';
import { createBrainDumpSyncBridge as createOldBrainDumpBridge } from './fixtures/cf43080-client/brain-dump-sync.js';
import { promoteCaptureToPlan as oldPromoteCaptureToPlan } from './fixtures/cf43080-client/brain-dump-promotion.js';
import { brainDumpPlanItemId as oldBrainDumpPlanItemId } from './fixtures/cf43080-client/brain-dump-model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8');
const ROOM = 'uid_alice';
const MANILA = 'Asia/Manila';
const CAL = STORES.calendar;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Waits (bounded) for a condition the SDK's listeners will make true, e.g. a capture arriving in a device's cache. */
async function until(condition, what, timeoutMs = 4000) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${what}`);
    await pause(10);
  }
}
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);

let emulator;
const connections = [];
test.before(async () => { emulator = await startEmulator(); });
test.after(async () => { await Promise.all(connections.map(c => c.close().catch(() => {}))); emulator?.stop(); });

async function world() {
  const db = await emulator.fresh(RULES);
  const connect = options => { const connection = connectSdk(emulator, db, options); connections.push(connection); return connection; };
  return { db, connect };
}

/** A transaction's first run uses the connection's LOCAL cache, and only a location with an active listener
 *  has one. The production Brain Dump bridge attaches its whole-subtree listener at startup (attach()), so the
 *  capture helpers below hold a listener on the capture the same way before they transact. */
const primed = async ref => { await new Promise(resolve => { ref.on('value', () => resolve()); }); return ref; };

/** One create-or-merge transaction at the fenced child, exactly the shape the client sends. */
const createFenced = (connection, def, item = fencedItem(def)) => connection.roomRef().child(def.fence).child(def.key).child(item.id)
  .transaction(current => (current === null || current === undefined ? item : undefined), undefined, false)
  .then(result => ({ committed: result.committed }), error => ({ denied: /permission/i.test(`${error?.code} ${error?.message}`) }));

/** One revoke transaction on the capture, exactly the shape brain-dump-sync.js's revokeClaimRemote sends. */
const revokeClaim = async (connection, def, id = CAPTURE) => (await primed(connection.roomRef().child('brainDump').child(id)))
  .transaction(current => (current && current.promotionClaim && !current.promotionClaim.revokedAt ? { ...current, promotionClaim: { ...current.promotionClaim, revokedAt: T + 5 } } : undefined), undefined, false)
  .then(result => ({ committed: result.committed }), error => ({ denied: /permission/i.test(`${error?.code} ${error?.message}`) }));

const readFenced = (connection, def, id = ITEM_ID) => connection.roomRef().child(def.fence).child(def.key).child(id).once('value').then(snapshot => snapshot.val());

// ═══════════════════════════════════════════════════════════════════════════
// 1. the two-connection ordering proof (final rules, final stable keys)
// ═══════════════════════════════════════════════════════════════════════════

for (const def of Object.values(STORES)) {
  test(`${def.store}: ordering A — the stale writer's create is accepted FIRST, then the revoke commits: the exact-child read sees the destination`, async () => {
    const { db, connect } = await world();
    await db.seed(captureAt(), capture({ promotionClaim: claim(def) }));
    const writer = connect();
    const reviver = connect();
    assert.deepEqual(await createFenced(writer, def), { committed: true });
    assert.deepEqual(await revokeClaim(reviver, def), { committed: true });
    const seen = await readFenced(reviver, def);
    assert.equal(fencedPresence(seen, { itemId: ITEM_ID, claimEpoch: 0, type: 'do-today', store: def.store, targetKey: def.key }), 'present');
    // The destination exists, so the server refuses to recover and accepts the finalize.
    assert.equal(await db.read(captureAt()).then(r => r.promotionClaim.revokedAt > 0), true);
  });

  test(`${def.store}: ordering B — the revoke commits FIRST: the late stale writer is denied and the read is a provable absence`, async () => {
    const { db, connect } = await world();
    await db.seed(captureAt(), capture({ promotionClaim: claim(def) }));
    const writer = connect();
    const reviver = connect();
    assert.deepEqual(await revokeClaim(reviver, def), { committed: true });
    assert.deepEqual(await readFenced(reviver, def), null, 'absent, read AFTER the revoke was acknowledged');
    assert.deepEqual(await createFenced(writer, def), { denied: true }, 'the writer that lost the ordering can never land it');
    assert.deepEqual(await readFenced(reviver, def), null, 'and it never appears later');
    assert.deepEqual(await db.read(def.itemAt), null);
  });
}

for (const withListener of [false, true]) {
  test(`70 real cross-connection races (${withListener ? 'reader holds a live listener on the child' : 'one-shot reads'}): an acknowledged revoke followed by an absent read can never be followed by the item appearing`, async () => {
    const { db, connect } = await world();
    const writer = connect();
    const reviver = connect();
    let sawWriteFirst = 0;
    let sawRevokeFirst = 0;
    for (let race = 0; race < 70; race++) {
      const id = `brace${String(race).padStart(3, '0')}`;
      const item = fencedItem(CAL, { id: `bdp1|${id}` });
      await db.seed(captureAt(id), capture({ id, promotionClaim: claim(CAL, { planItemId: `bdp1|${id}` }) }));
      const child = reviver.roomRef().child(CAL.fence).child(CAL.key).child(item.id);
      let detach = () => {};
      if (withListener) { const handler = () => {}; child.on('value', handler); detach = () => child.off('value', handler); await pause(5); }
      // A real race: both are in flight on two websockets; a tiny jitter varies which one the server orders first.
      const jitter = race % 4;
      const [created, revoked] = await Promise.all([
        createFenced(writer, CAL, item),
        (async () => { await pause(jitter); return revokeClaim(reviver, CAL, id); })(),
      ]);
      assert.equal(revoked.committed, true, `race ${race}: the revoke always commits`);
      // The reviver's read, taken AFTER its own revoke was acknowledged.
      const afterAck = await child.once('value').then(s => s.val());
      await pause(15); // let any straggling packet settle
      const final = await db.read(CAL.fenceAt(CAL.key).replace(ITEM_ID, item.id));
      if (afterAck === null) {
        // Absent after the acknowledged revoke: the old item must never appear.
        assert.equal(final, null, `race ${race}: revoke acknowledged -> absent read -> old item later appeared (the bug the fence exists to prevent)`);
        assert.equal(created.denied, true, `race ${race}: the writer was refused`);
        sawRevokeFirst++;
      } else {
        assert.equal(created.committed, true, `race ${race}: a read that sees the destination means the create won the ordering`);
        assert.equal(final.id, item.id);
        sawWriteFirst++;
      }
      detach();
    }
    assert.equal(sawWriteFirst + sawRevokeFirst, 70);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. the final new stack on the real SDK
// ═══════════════════════════════════════════════════════════════════════════

/** A Plan Authority just large enough for the calendar-native promotion flow, over the REAL calendar bridge. */
function newStack(connection, { name, clock }) {
  const owner = () => ROOM;
  const calendarRepository = createCalendarPlanRepository({ storage: memoryStorage(), getOwner: owner, getTimezone: () => MANILA, idGenerator: () => `ca1-${name}` });
  let captureCache = null;
  const calendarBridge = createCalendarPlanSyncBridge({
    repository: calendarRepository, getRoomRef: () => connection.roomRef(), getRoomId: owner,
    partitionOutboundItems: items => partitionOutboundItemsWith(items, captureCache ? (id => captureCache.read(id)) : null),
  });
  const dateOf = target => target.dateKey;
  const targetFor = dateKey => ({ store: 'calendar', id: `cal1:${dateKey}`, dateKey });
  const planAuthority = {
    current: () => targetFor('2026-10-03'),
    dayForScheduledDate: dateKey => ({ ok: true, anchor: 'noon', target: targetFor(dateKey) }),
    targetById: id => { const m = /^cal1:(\d{4}-\d{2}-\d{2})$/.exec(id); return m ? targetFor(m[1]) : null; },
    rawItems: target => calendarRepository.read(dateOf(target))?.items || [],
    addItem({ destination, item }) { calendarRepository.write(dateOf(destination), [...(calendarRepository.read(dateOf(destination))?.items || []), item], { updatedBy: name, now: clock.now }); calendarBridge.pushPlan(destination.id); return { item }; },
    // Plan Authority's own "past My Days are history" gate: the day ends at the next Manila midnight.
    assertDirectSchedulingTarget(target, nowMs) { const end = at(`${new Date(Date.parse(`${target.dateKey}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)}`, '00:00'); if (end <= nowMs) throw new Error('Past My Days are history.'); },
    remoteItemPresence: (target, itemId, { expected = null } = {}) => (expected
      ? calendarBridge.readRemoteFencedItem(target.id, itemId, { timeoutMs: 3000 }).then(r => (r.ok ? fencedPresence(r.value, { itemId, ...expected }) : 'unknown'))
      : calendarBridge.readRemotePlan(target.id, { timeoutMs: 3000 }).then(r => (r.ok ? ((r.record?.items ? Object.values(r.record.items) : []).some(i => i.id === itemId) ? 'present' : 'absent') : 'unknown'))),
  };
  const repository = createBrainDumpRepository({ storage: memoryStorage(), getOwner: owner, now: () => clock.now, deviceId: () => name });
  captureCache = repository;
  const bridge = createBrainDumpSyncBridge({ repository, getRoomRef: () => connection.roomRef(), getRoomId: owner, now: () => clock.now, deviceId: () => name });
  bridge.attach(); // production attaches its whole-subtree listener at startup: it is what primes every capture transaction
  return {
    name, calendarRepository, calendarBridge, planAuthority, repository, bridge,
    async capture(text) { const id = repository.create({ text }).record.id; repository.triage(id, { important: true, urgent: false }); await bridge.syncCapture(id); return id; },
    settle: id => settleOutstandingClaim({ repository, planAuthority, id, now: clock.now, deviceId: name, revokeClaim: bridge.revokeClaimRemote, resolveExpiredClaim: bridge.resolveExpiredClaimRemote }),
    promote: id => promoteCaptureToPlan({ repository, planAuthority, claimPromotionRemote: bridge.claimPromotionRemote, id, type: 'do-today', now: clock.now, deviceId: name }),
  };
}

test('new stack: a normal Do Today lands at the stable keyed child, the capture finalizes promoted, and nothing sits in the array', async () => {
  const { db, connect } = await world();
  const clock = { now: at('2026-10-03', '09:00') };
  const a = newStack(connect(), { name: 'a', clock });
  const id = await a.capture('Plain Do Today');
  const result = await a.promote(id);
  assert.equal(result.ok, true, result.reason);
  await a.bridge.syncCapture(id);
  await a.calendarBridge.pushPlan('cal1:2026-10-03');
  await flush();
  const fenced = await db.read(`${ROOM.replace(/^/, 'rooms/')}/calendarPlanFences/cal1:2026-10-03/bdp1|${id}`);
  assert.deepEqual(fenced.brainDumpOrigin, { v: 2, claimEpoch: 0, type: 'do-today', store: 'calendar', targetKey: 'cal1:2026-10-03' });
  const record = await db.read('rooms/uid_alice/calendarPlans/cal1:2026-10-03');
  assert.ok(!(record?.items ? Object.values(record.items) : []).some(i => i.id === `bdp1|${id}`), 'never inside the plan record array');
  assert.equal((await db.read(captureAt(id))).status, 'promoted');
  assert.equal((await db.read(captureAt(id))).promotion.targetKey, 'cal1:2026-10-03');
});

test('new stack: claim, crash before any item, the day ends -> revoke, read the exact child: ABSENT -> recovered at epoch + 1; the stale writer is then refused', async () => {
  const { db, connect } = await world();
  const clock = { now: at('2026-10-03', '09:00') };
  const writer = newStack(connect(), { name: 'writer', clock });
  const id = await writer.capture('Crash after claim');
  // The claim commits remotely; the process then dies (no item, no finalize).
  const claimed = await writer.bridge.claimPromotionRemote(id, { type: 'do-today', store: 'calendar', targetId: 'cal1:2026-10-03', targetKey: 'cal1:2026-10-03', planItemId: brainDumpPlanItemId(id), when: '' });
  assert.equal(claimed.ok, true);
  // Another device, the next day.
  clock.now = at('2026-10-04', '09:00');
  const healer = newStack(connect(), { name: 'healer', clock });
  await until(() => healer.repository.read(id)?.promotionClaim, 'the healer to receive the claim');
  const outcome = await healer.settle(id);
  assert.equal(outcome.recovered, true, JSON.stringify(outcome));
  const recovered = await db.read(captureAt(id));
  assert.equal(recovered.claimEpoch, 1);
  assert.equal(recovered.status, 'triaged');
  // The crashed writer's queued item, pushed late: the server refuses it.
  const late = fencedItem(CAL, { id: `bdp1|${id}` });
  const rejected = await createFenced(connect(), CAL, late);
  assert.deepEqual(rejected, { denied: true });
  assert.deepEqual(await db.read(CAL.fenceAt(CAL.key).replace(ITEM_ID, `bdp1|${id}`)), null);
});

test('new stack: the item reached the server, the writer died before the finalize -> a fresh device reads the exact child: PRESENT -> finalizes promoted, never recovers', async () => {
  const { db, connect } = await world();
  const clock = { now: at('2026-10-03', '09:00') };
  const writer = newStack(connect(), { name: 'writer', clock });
  const id = await writer.capture('Item landed, finalize lost');
  await writer.bridge.claimPromotionRemote(id, { type: 'do-today', store: 'calendar', targetId: 'cal1:2026-10-03', targetKey: 'cal1:2026-10-03', planItemId: brainDumpPlanItemId(id), when: '' });
  // The item lands (authorized: the claim is live), then the writer dies.
  assert.deepEqual(await createFenced(connect(), CAL, fencedItem(CAL, { id: `bdp1|${id}`, updatedBy: 'writer' })), { committed: true });
  clock.now = at('2026-10-04', '09:00');
  const healer = newStack(connect(), { name: 'healer', clock });
  await until(() => healer.repository.read(id)?.promotionClaim, 'the healer to receive the claim');
  const outcome = await healer.settle(id);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.notEqual(outcome.recovered, true);
  assert.equal(await healer.bridge.syncCapture(id), true, 'the finalize is pushed like brain-dump-ui.js does after every settle (the server accepts it: the destination is present)');
  const final = await db.read(captureAt(id));
  assert.equal(final.status, 'promoted');
  assert.equal(final.claimEpoch ?? 0, 0, 'no new generation: there was a destination');
});

test('new clients on cold caches: a stale live edit with a LATER clock cannot resurrect a tombstone on the real server; the merge converges and nothing is denied', async () => {
  const { db, connect } = await world();
  await db.seed(captureAt(), promotedCapture(CAL));
  const device = name => {
    const repository = createCalendarPlanRepository({ storage: memoryStorage(), getOwner: () => ROOM, getTimezone: () => MANILA, idGenerator: () => `ca1-${name}` });
    const connection = connect();
    const bridge = createCalendarPlanSyncBridge({ repository, getRoomRef: () => connection.roomRef(), getRoomId: () => ROOM });
    return { repository, bridge };
  };
  const a = device('a');
  const b = device('b'); // never attaches a listener: its transactions start from an EMPTY local cache and are retried by the SDK with the server value
  a.repository.write('2026-10-03', [fencedItem(CAL, { updatedBy: 'a', updatedAt: T + 5 })], { updatedBy: 'a', now: T + 5 });
  assert.equal((await a.bridge.pushPlan(CAL.targetId)).committed, true);
  // B edits the live item (its clock is far ahead) and pushes: a merge on the real server, through a cold-cache retry.
  b.repository.write('2026-10-03', [fencedItem(CAL, { updatedBy: 'b', updatedAt: T + 400, task: 'edited by b' })], { updatedBy: 'b', now: T + 400 });
  assert.equal((await b.bridge.pushPlan(CAL.targetId)).committed, true);
  assert.equal((await db.read(CAL.itemAt)).task, 'edited by b', 'the later edit won the ordinary merge');
  // A deletes it (earlier clock than B's edit): the tombstone must still win everywhere.
  a.repository.write('2026-10-03', [fencedItem(CAL, { updatedBy: 'a', updatedAt: T + 10, deleted: true })], { updatedBy: 'a', now: T + 10 });
  assert.equal((await a.bridge.pushPlan(CAL.targetId)).committed, true);
  assert.equal((await db.read(CAL.itemAt)).deleted, true, 'a tombstone beats a live edit with a later updatedAt');
  // B, still holding its live copy with the later clock, pushes again: nothing to say, nothing denied, B converges.
  assert.equal((await b.bridge.pushPlan(CAL.targetId)).committed, true);
  assert.equal((await db.read(CAL.itemAt)).deleted, true);
  assert.equal(b.repository.read('2026-10-03').items.find(i => i.id === ITEM_ID).deleted, true, 'B converged to the tombstone locally');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. the REAL cf43080 client, after fenced data exists, under the NEW rules
// ═══════════════════════════════════════════════════════════════════════════

test('fixture integrity: fixtures/cf43080-client is byte-identical to the cf43080 source (line endings normalized)', () => {
  const manifest = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'cf43080-client', 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.commit, 'cf43080ad51428cb78442e6cabadbf3d48edc827');
  for (const [file, hash] of Object.entries(manifest.files)) {
    const text = readFileSync(path.join(HERE, 'fixtures', 'cf43080-client', file), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(text).digest('hex'), hash, file);
  }
  assert.ok(Object.keys(manifest.files).length >= 10);
});

function oldCalendarDevice(connection, name) {
  const repository = createOldCalendarRepository({ storage: memoryStorage(), getOwner: () => ROOM, getTimezone: () => MANILA, idGenerator: () => `ca1-${name}` });
  const bridge = createOldCalendarBridge({ repository, getRoomRef: () => connection.roomRef(), getRoomId: () => ROOM });
  return { repository, bridge };
}

test('cf43080 client + calendar store: after the NEW client created a fenced item, the old client edits, toggles and re-pushes its whole plan; the fenced item survives byte-for-byte', async () => {
  const { db, connect } = await world();
  await db.seed(captureAt(), promotedCapture(CAL));
  // The NEW client writes an ordinary item and a fenced one.
  const fresh = createCalendarPlanRepository({ storage: memoryStorage(), getOwner: () => ROOM, getTimezone: () => MANILA, idGenerator: () => 'ca1-new' });
  const newBridge = createCalendarPlanSyncBridge({ repository: fresh, getRoomRef: () => connect().roomRef(), getRoomId: () => ROOM });
  fresh.write('2026-10-03', [{ ...ordinary, id: 'pone0001', task: 'one' }, { ...ordinary, id: 'ptwo0001', task: 'two' }, fencedItem(CAL, { updatedBy: 'new', updatedAt: T + 4 })], { updatedBy: 'new', now: T + 4 });
  assert.equal((await newBridge.pushPlan(CAL.targetId)).committed, true);
  const fencedBefore = JSON.stringify(await db.read(CAL.itemAt));
  assert.ok(fencedBefore.includes('"targetKey"'));
  // The OLD client loads the plan (it only knows the record), edits one item, toggles another, and pushes.
  const old = oldCalendarDevice(connect(), 'old');
  await old.bridge.hydrateAll();
  const loaded = old.repository.read('2026-10-03');
  assert.deepEqual(loaded.items.map(i => i.id).sort(), ['pone0001', 'ptwo0001'], 'the old client never sees the fenced item (it does not read the fence collection)');
  old.repository.write('2026-10-03', loaded.items.map(i => (i.id === 'pone0001' ? { ...i, task: 'edited by the old client', updatedAt: T + 9, updatedBy: 'old' } : i.id === 'ptwo0001' ? { ...i, done: true, doneAt: T + 9, updatedAt: T + 9, updatedBy: 'old' } : i)), { updatedBy: 'old', now: T + 9 });
  const pushed = await old.bridge.pushPlan(CAL.targetId);
  assert.equal(pushed.committed, true, 'an unrelated old-client operation stays possible: the record it rewrites does not contain the fenced item');
  assert.equal(JSON.stringify(await db.read(CAL.itemAt)), fencedBefore, 'the fenced item is byte-for-byte unchanged');
  const record = await db.read(CAL.planAt);
  assert.equal(Object.values(record.items).find(i => i.id === 'pone0001').task, 'edited by the old client');
  // The old client's reconnect (re-push everything) and a second round are equally harmless.
  assert.equal((await old.bridge.pushPlan(CAL.targetId)).committed, true);
  assert.equal(JSON.stringify(await db.read(CAL.itemAt)), fencedBefore);
  // And the NEW client still converges: it merges the old client's edit and keeps its own fenced item.
  await newBridge.hydrateAll();
  assert.equal(fresh.read('2026-10-03').items.find(i => i.id === 'pone0001').task, 'edited by the old client');
  assert.ok(fresh.read('2026-10-03').items.some(i => i.id === ITEM_ID), 'the fenced item is still in the new client\'s one array');
});

test('cf43080 client + operational store: the same, through toFirebaseSafeKey', async () => {
  const { db, connect } = await world();
  const op = STORES.operational;
  await db.seed(captureAt(), promotedCapture(op));
  const dayId = op.targetId;
  const fresh = createOperationalPlanRepository({ storage: memoryStorage(), getOwner: () => ROOM });
  const newBridge = createOperationalPlanSyncBridge({ repository: fresh, getRoomRef: () => connect().roomRef(), getRoomId: () => ROOM });
  fresh.mergeRemote(dayId, { items: [{ ...ordinary, id: 'pone0001' }, fencedItem(op, { updatedBy: 'new', updatedAt: T + 4 })], updatedAt: T + 4, updatedBy: 'new', createdAt: T });
  assert.equal((await newBridge.pushDay(dayId)).committed, true);
  const fencedBefore = JSON.stringify(await db.read(op.itemAt));
  const oldRepo = createOldOperationalRepository({ storage: memoryStorage(), getOwner: () => ROOM });
  const oldBridge = createOldOperationalBridge({ repository: oldRepo, getRoomRef: () => connect().roomRef(), getRoomId: () => ROOM });
  await oldBridge.hydrateAll();
  assert.deepEqual(oldRepo.read(dayId).items.map(i => i.id), ['pone0001']);
  oldRepo.mergeRemote(dayId, { items: [{ ...ordinary, id: 'pone0001', task: 'edited by old', updatedAt: T + 9, updatedBy: 'old' }, { ...ordinary, id: 'pnew00001', task: 'added by old', updatedAt: T + 9, updatedBy: 'old' }], updatedAt: T + 9, updatedBy: 'old' });
  assert.equal((await oldBridge.pushDay(dayId)).committed, true);
  assert.equal(JSON.stringify(await db.read(op.itemAt)), fencedBefore);
});

test('cf43080 client + legacy store: the old whole-date transaction (verbatim shape of storage.js syncPlans at cf43080) leaves the fenced child alone', async () => {
  const { db, connect } = await world();
  const legacy = STORES.legacy;
  await db.seed(captureAt(), promotedCapture(legacy));
  await db.seed(legacy.itemAt, fencedItem(legacy, { updatedBy: 'new', updatedAt: T + 4 }));
  const fencedBefore = JSON.stringify(await db.read(legacy.itemAt));
  const connection = connect();
  // storage.js@cf43080 syncPlans: ref.child('plans').child(dateKey).transaction(remote => model.mergeDatePlans(remote, candidate, dateKey)).
  const candidate = { items: [{ ...ordinary, id: 'pone0001', task: 'legacy edit', updatedAt: T + 9, updatedBy: 'old' }], updatedAt: T + 9, updatedBy: 'old' };
  const result = await connection.roomRef().child('plans').child('2026-10-03').transaction(remote => oldMergeDatePlans(remote, candidate, '2026-10-03'), undefined, false);
  assert.equal(result.committed, true);
  assert.equal(JSON.stringify(await db.read(legacy.itemAt)), fencedBefore);
});

test('cf43080 Brain Dump on the NEW rules: v1 records, archive/delegate and its Do Today claim keep working, and a pre-fence unfenced item stays writable', async () => {
  const { db, connect } = await world();
  const clock = { now: at('2026-10-03', '09:00') };
  const connection = connect();
  const oldRepo = createOldBrainDumpRepository({ storage: memoryStorage(), getOwner: () => ROOM, now: () => clock.now, deviceId: () => 'old-phone' });
  const oldBd = createOldBrainDumpBridge({ repository: oldRepo, getRoomRef: () => connection.roomRef(), getRoomId: () => ROOM, now: () => clock.now, deviceId: () => 'old-phone' });
  oldBd.attach();
  const oldCal = oldCalendarDevice(connection, 'old-phone');
  // v1 records: create + triage + archive + delegate.
  const mk = async text => { const id = oldRepo.create({ text }).record.id; oldRepo.triage(id, { important: true, urgent: false }); assert.equal(await oldBd.syncCapture(id), true, `push ${text}`); return id; };
  const toArchive = await mk('archive me');
  const toDelegate = await mk('delegate me');
  assert.equal(oldRepo.archive(toArchive).ok, true);
  assert.equal(await oldBd.syncCapture(toArchive), true, 'archive');
  assert.equal(oldRepo.delegate(toDelegate, { delegatedTo: 'Sam' }).ok, true);
  assert.equal(await oldBd.syncCapture(toDelegate), true, 'delegate');
  assert.equal((await db.read(captureAt(toArchive))).status, 'archived');
  // Its own Do Today claim: the NEW rules accept it (cf43080 then cannot read the null-pruned record back and
  // never writes the plan item — the production bug behind every stuck claim — so no item ever follows).
  const id = await mk('old Do Today');
  await oldBd.claimPromotionRemote(id, { type: 'do-today', store: 'calendar', targetId: 'cal1:2026-10-03', planItemId: oldBrainDumpPlanItemId(id), when: '' });
  assert.equal((await db.read(captureAt(id))).promotionClaim.planItemId, oldBrainDumpPlanItemId(id), 'claim accepted');
  // Should a pre-fence client EVER complete a promotion (a build that reads the wire correctly), its unfenced
  // array item is authorized by capture state alone: simulated with the real cf43080 plan bridge and the state
  // such a client leaves behind. It is an ordinary item with no fabricated origin.
  const item = { id: oldBrainDumpPlanItemId(id), task: 'old Do Today', when: '', done: false, doneAt: null, updatedAt: clock.now, updatedBy: 'old-phone', kind: 'task' };
  oldCal.repository.write('2026-10-03', [item], { updatedBy: 'old-phone', now: clock.now });
  assert.equal((await oldCal.bridge.pushPlan('cal1:2026-10-03')).committed, true, 'a pre-fence unfenced bdp1 item under its own live claim is accepted');
  await db.seed(captureAt(id), { ...(await db.read(captureAt(id))), status: 'promoted', disposedAt: clock.now, promotionClaim: null, promotion: { type: 'do-today', store: 'calendar', targetId: 'cal1:2026-10-03', planItemId: oldBrainDumpPlanItemId(id), promotedAt: clock.now } });
  oldCal.repository.write('2026-10-03', [{ ...item, done: true, doneAt: clock.now + 1, updatedAt: clock.now + 1 }], { updatedBy: 'old-phone', now: clock.now + 1 });
  assert.equal((await oldCal.bridge.pushPlan('cal1:2026-10-03')).committed, true, 'and it stays editable once its capture is promoted');
  const record = await db.read(CAL.planAt);
  assert.ok(Object.values(record.items).some(i => i.id === oldBrainDumpPlanItemId(id) && !i.brainDumpOrigin && i.done === true), 'the item is an ordinary array item with no fabricated origin');
  assert.equal((await db.read(captureAt(id))).promotion.targetKey, undefined, 'a pre-fence promotion carries no fabricated location');
});

test('cf43080 stuck claim: the OLD client claimed (no targetKey) and died; the new client recovers it on the real server (revoke, array read, recovery all accepted)', async () => {
  const { db, connect } = await world();
  const clock = { now: at('2026-10-03', '09:00') };
  const oldConnection = connect();
  const oldRepo = createOldBrainDumpRepository({ storage: memoryStorage(), getOwner: () => ROOM, now: () => clock.now, deviceId: () => 'old-phone' });
  const oldBd = createOldBrainDumpBridge({ repository: oldRepo, getRoomRef: () => oldConnection.roomRef(), getRoomId: () => ROOM, now: () => clock.now, deviceId: () => 'old-phone' });
  oldBd.attach();
  const id = oldRepo.create({ text: 'stuck on the old phone' }).record.id;
  oldRepo.triage(id, { important: true, urgent: false });
  await oldBd.syncCapture(id);
  // cf43080 cannot read its own null-pruned wire records back (the production bug DECISIONS #31 fixed), so its
  // call reports "already-claimed" even though the claim COMMITTED: exactly how its claims got stuck. What matters
  // here is that the NEW rules accept that claim, and that the new client can then resolve it.
  await oldBd.claimPromotionRemote(id, { type: 'do-today', store: 'calendar', targetId: 'cal1:2026-10-03', planItemId: oldBrainDumpPlanItemId(id), when: '' });
  const stuck = await db.read(captureAt(id));
  assert.equal(stuck.promotionClaim.planItemId, oldBrainDumpPlanItemId(id), 'the cf43080 claim was accepted by the new rules');
  assert.equal(stuck.promotionClaim.targetKey, undefined, 'a cf43080 claim names no physical key');
  clock.now = at('2026-10-04', '09:00');
  const healer = newStack(connect(), { name: 'healer', clock });
  await until(() => healer.repository.read(id)?.promotionClaim, 'the healer to receive the stuck claim');
  const outcome = await healer.settle(id);
  assert.equal(outcome.recovered, true, JSON.stringify(outcome));
  const final = await db.read(captureAt(id));
  assert.equal(final.claimEpoch, 1);
  assert.equal(final.status, 'triaged');
  assert.equal(final.schemaVersion, 2);
});

test('rules-first: the new rules accept every cf43080 operation tried above BEFORE any new client exists (no fenced data, no fence collections)', async () => {
  const { db, connect } = await world();
  const connection = connect();
  const old = oldCalendarDevice(connection, 'old');
  old.repository.write('2026-10-03', [{ ...ordinary, id: 'pone0001' }], { updatedBy: 'old', now: T });
  assert.equal((await old.bridge.pushPlan(CAL.targetId)).committed, true, 'plain old-client plan push');
  assert.equal(await db.read(`rooms/${ROOM}/calendarPlanFences`), null, 'no fence collection is ever created for plain data');
});
