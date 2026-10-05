// plan-fence-sync.test.js
//
// The client boundary of the location-bound Brain Dump fence (plan-fence-sync.js wired into the
// calendar and operational sync bridges): a FENCED item leaves the device as one transaction at its
// stable keyed child and comes back through a keyed listener / hydrate, while the plan record only ever
// carries ordinary items. Everything runs against ONE database that enforces the REAL
// firebase.rules.json (targaryen; the real emulator agrees on these cases in
// firebase-rules-emulator.test.js), shared by several devices with their own caches.
//
// The legacy store's glue lives in storage.js and is covered by legacy-fence-sync.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import targaryen from 'targaryen';

import { createCalendarPlanRepository } from './calendar-plan-repository.js';
import { createCalendarPlanSyncBridge } from './calendar-plan-sync.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { createOperationalPlanSyncBridge } from './operational-plan-sync.js';
import { memoryStorage } from './calendar-plan-test-support.js';
import { rulesEnforcingDatabase } from './brain-dump-test-support.js';
import { partitionOutboundItemsWith } from './plan-item-origin.js';
import { STORES, T, capture, claim, expired, fencedItem, ordinary, promotedCapture } from './fence-rules-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = JSON.parse(readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8'));
const UID = 'alice_uid';
const ROOM = `uid_${UID}`;
const ITEM = 'bdp1|bfence1';
const at = rest => `rooms/${ROOM}/${rest}`;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const newDb = () => rulesEnforcingDatabase({ targaryen, rules: RULES, uid: UID });

/** One device for a store: its own cache + the real bridge, online or offline, with an optional queue guard. */
function device(db, def, { online = true, lookup = null, owner = ROOM, name = 'dev' } = {}) {
  // `owner` is the room the app has joined; the repository's cache stays this account's own (ROOM), so moving
  // `owner` models a device whose joined room no longer matches the cache it holds.
  const state = { online, owner };
  const getRoomRef = () => (state.online ? db.ref(`rooms/${ROOM}`) : null);
  const guard = items => partitionOutboundItemsWith(items, lookup ? (id => lookup()(id)) : null);
  if (def.store === 'calendar') {
    const repository = createCalendarPlanRepository({ storage: memoryStorage(), getOwner: () => ROOM, getTimezone: () => 'Asia/Manila', idGenerator: () => `ca1-${name}` });
    const bridge = createCalendarPlanSyncBridge({ repository, getRoomRef, getRoomId: () => state.owner, partitionOutboundItems: guard });
    const planId = def.targetId;
    return {
      state, repository, bridge, planId,
      write: items => repository.write('2026-10-03', items, { updatedBy: name, now: T + 5 }),
      read: () => repository.read('2026-10-03'),
      push: () => bridge.pushPlan(planId),
      hydrate: () => bridge.hydrateAll(),
      attach: () => bridge.attachPlan(planId),
      readFenced: (itemId = ITEM) => bridge.readRemoteFencedItem(planId, itemId, { timeoutMs: 50 }),
      detach: () => bridge.detachAll(),
    };
  }
  const repository = createOperationalPlanRepository({ storage: memoryStorage(), getOwner: () => ROOM });
  const bridge = createOperationalPlanSyncBridge({ repository, getRoomRef, getRoomId: () => state.owner, partitionOutboundItems: guard });
  const planId = def.targetId;
  return {
    state, repository, bridge, planId,
    // The sync layer is under test, not range validation: items enter the cache as an inbound record would.
    write: items => { const current = repository.read(planId); repository.mergeRemote(planId, { items: [...(current?.items || []).filter(i => !items.some(n => n.id === i.id)), ...items], updatedAt: T + 5, updatedBy: name, createdAt: T }); },
    read: () => repository.read(planId),
    push: () => bridge.pushDay(planId),
    hydrate: () => bridge.hydrateAll(),
    attach: () => bridge.attachDay(planId),
    readFenced: (itemId = ITEM) => bridge.readRemoteFencedItem(planId, itemId, { timeoutMs: 50 }),
    detach: () => bridge.detachAll(),
  };
}

const fenceAt = (def, itemId = ITEM) => at(`${def.fence}/${def.key}/${itemId}`);
const recordAt = def => at(`${def.plans}/${def.key}`);
const itemsOf = record => (Array.isArray(record?.items) ? record.items : Object.values(record?.items || {}));
const authorize = (db, def, extra = {}) => db.seed(at('brainDump/bfence1'), capture({ promotionClaim: claim(def), ...extra }));

for (const def of [STORES.calendar, STORES.operational]) {
  const { store } = def;

  test(`${store}: a fenced item is pushed to its stable keyed child; the plan record carries ordinary items only`, async () => {
    const db = newDb();
    authorize(db, def);
    const a = device(db, def);
    a.write([ordinary, fencedItem(def, { updatedBy: 'dev', updatedAt: T + 5 })]);
    const result = await a.push();
    assert.equal(result.committed, true, result.outcome);
    assert.deepEqual(itemsOf(db.read(recordAt(def))).map(i => i.id), ['pnormal1'], 'never inside the array');
    const stored = db.read(fenceAt(def));
    assert.equal(stored.id, ITEM);
    assert.deepEqual(stored.brainDumpOrigin, { v: 2, claimEpoch: 0, type: 'do-today', store, targetKey: def.key });
    assert.equal(db.denials.length, 0);
    assert.deepEqual(a.read().items.map(i => i.id).sort(), ['bdp1|bfence1', 'pnormal1'], 'the local array still exposes both');
    // Idempotent: a second push says nothing (no write to the fenced child).
    const before = JSON.stringify(db.read(fenceAt(def)));
    assert.equal((await a.push()).committed, true);
    assert.equal(JSON.stringify(db.read(fenceAt(def))), before);
  });

  test(`${store}: an unauthorized fenced item is refused by the server and does NOT block the ordinary plan`, async () => {
    const db = newDb();
    db.seed(at('brainDump/bfence1'), capture({ promotionClaim: claim(def, { revokedAt: T + 5 }) }));
    const a = device(db, def);
    a.write([ordinary, fencedItem(def, { updatedBy: 'dev', updatedAt: T + 5 })]);
    const result = await a.push();
    assert.equal(result.committed, false);
    assert.equal(result.outcome, 'fence-denied');
    assert.equal(db.read(fenceAt(def)), null, 'the refused item never landed');
    assert.deepEqual(itemsOf(db.read(recordAt(def))).map(i => i.id), ['pnormal1'], 'the ordinary item still synced (previously one unauthorized item blocked its whole day)');
  });

  test(`${store}: an old client's whole-record rewrite and this client's fenced push coexist; neither disturbs the other`, async () => {
    const db = newDb();
    db.seed(at('brainDump/bfence1'), promotedCapture(def));
    const a = device(db, def);
    a.write([ordinary, fencedItem(def, { updatedBy: 'dev', updatedAt: T + 5 })]);
    assert.equal((await a.push()).committed, true);
    // The old client (no fence collection) rewrites the whole record: reordered, edited, other items.
    db.seed(recordAt(def), { items: [{ ...ordinary, id: 'pnormal2', task: 'second', updatedAt: T + 7 }, { ...ordinary, task: 'edited by old client', updatedAt: T + 8 }], updatedAt: T + 8, updatedBy: 'old' });
    assert.equal(db.read(fenceAt(def)).id, ITEM, 'the fenced child is not part of the record the old client rewrote');
    a.write([{ ...ordinary, task: 'edited here', updatedAt: T + 9 }, fencedItem(def, { updatedBy: 'dev', updatedAt: T + 9, done: true, doneAt: T + 9 })]);
    assert.equal((await a.push()).committed, true);
    assert.equal(db.read(fenceAt(def)).done, true, 'the fenced item took this client\'s edit');
    assert.ok(itemsOf(db.read(recordAt(def))).some(i => i.id === 'pnormal2'), 'the old client\'s item survived the merge');
    assert.equal(db.denials.length, 0);
  });

  test(`${store}: tombstone is monotonic across devices — a stale live edit with a LATER clock cannot resurrect it, locally or remotely`, async () => {
    const db = newDb();
    db.seed(at('brainDump/bfence1'), promotedCapture(def));
    const a = device(db, def, { name: 'a' });
    const b = device(db, def, { name: 'b' });
    a.write([fencedItem(def, { updatedBy: 'a', updatedAt: T + 5 })]);
    assert.equal((await a.push()).committed, true);
    // B learns the live item, then goes stale while A deletes it.
    await b.hydrate();
    assert.equal(b.read().items.find(i => i.id === ITEM).deleted, undefined);
    a.write([fencedItem(def, { updatedBy: 'a', updatedAt: T + 10, deleted: true })]);
    assert.equal((await a.push()).committed, true);
    // B (stale, later clock) edits the live copy and pushes.
    b.write([fencedItem(def, { updatedBy: 'b', updatedAt: T + 500, task: 'edited after the delete' })]);
    const denialsBefore = db.denials.length;
    const result = await b.push();
    assert.equal(result.committed, true, 'nothing to say is not a failure');
    assert.equal(db.denials.length, denialsBefore, 'no denied write: the merge itself kept the tombstone');
    assert.equal(db.read(fenceAt(def)).deleted, true, 'the server still holds the tombstone');
    assert.equal(b.read().items.find(i => i.id === ITEM).deleted, true, 'and B converged to it locally');
  });

  test(`${store}: a fresh device hydrates and listens: the fenced item folds into its one local array`, async () => {
    const db = newDb();
    db.seed(at('brainDump/bfence1'), promotedCapture(def));
    const a = device(db, def, { name: 'a' });
    a.write([ordinary, fencedItem(def, { updatedBy: 'a', updatedAt: T + 5 })]);
    assert.equal((await a.push()).committed, true);
    const b = device(db, def, { name: 'b' });
    assert.equal(await b.hydrate(), true);
    await flush();
    assert.deepEqual(b.read().items.map(i => i.id).sort(), ['bdp1|bfence1', 'pnormal1']);
    // A live edit on A reaches an attached B through the keyed child's own listener.
    const c = device(db, def, { name: 'c' });
    c.attach();
    await flush();
    assert.ok(c.read().items.some(i => i.id === ITEM), 'attach delivers the current value');
    a.write([ordinary, fencedItem(def, { updatedBy: 'a', updatedAt: T + 20, task: 'renamed live' })]);
    assert.equal((await a.push()).committed, true);
    await flush();
    assert.equal(c.read().items.find(i => i.id === ITEM).task, 'renamed live');
    c.detach();
    assert.equal(db.denials.length, 0);
  });

  test(`${store}: the exact-child read: present, absent, a conflicting child is not either, and offline/foreign is unknown`, async () => {
    const db = newDb();
    const a = device(db, def, { name: 'a' });
    assert.deepEqual(await a.readFenced(), { ok: true, value: null }, 'a missing child is a provable absence');
    db.seed(fenceAt(def), fencedItem(def));
    const present = await a.readFenced();
    assert.equal(present.ok, true);
    assert.equal(present.value.id, ITEM);
    // The array is never consulted: an un-fenced copy of the same id in the record is NOT what answers.
    db.seed(fenceAt(def), null);
    db.seed(recordAt(def), { items: [{ id: ITEM, task: 'array copy' }], updatedAt: T });
    assert.deepEqual(await a.readFenced(), { ok: true, value: null }, 'absence is read at the exact child, never inferred from the array');
    a.state.online = false;
    assert.equal((await a.readFenced()).ok, false, 'no room ref: unknown, never absent');
    a.state.online = true;
    a.state.owner = 'uid_someone_else';
    assert.equal((await a.readFenced()).ok, false, 'a foreign cache: unknown, never absent');
  });

  test(`${store}: queue guard — a provably superseded ghost is purged from THIS cache only: no remote write, no tombstone, no deletion`, async () => {
    const db = newDb();
    // The capture was recovered (epoch 1) while this device sat on a queued epoch-0 item.
    db.seed(at('brainDump/bfence1'), capture({ claimEpoch: 1, expiredClaim: expired(def) }));
    const a = device(db, def, { lookup: () => id => (id === 'bfence1' ? capture({ claimEpoch: 1 }) : null) });
    a.write([ordinary, fencedItem(def, { updatedBy: 'dev', updatedAt: T + 5 })]);
    const result = await a.push();
    assert.equal(result.committed, true, result.outcome);
    assert.equal(db.denials.length, 0, 'withheld: not even one denied write');
    assert.equal(db.read(fenceAt(def)), null, 'nothing was written at the fenced child — not even a tombstone');
    assert.deepEqual(a.read().items.map(i => i.id), ['pnormal1'], 'cache cleanup only: the ghost is gone from this device');
  });

  test(`${store}: with the queue guard DISABLED the server alone keeps the ghost out (the guard is an optimisation, never the authority)`, async () => {
    const db = newDb();
    db.seed(at('brainDump/bfence1'), capture({ claimEpoch: 1, expiredClaim: expired(def) }));
    const a = device(db, def); // no lookup registered
    a.write([ordinary, fencedItem(def, { updatedBy: 'dev', updatedAt: T + 5 })]);
    const result = await a.push();
    assert.equal(result.outcome, 'fence-denied');
    assert.equal(db.denials.filter(d => d.path.includes(def.fence)).length, 1, 'the server refused it');
    assert.equal(db.read(fenceAt(def)), null, 'it never landed');
    assert.deepEqual(itemsOf(db.read(recordAt(def))).map(i => i.id), ['pnormal1'], 'and the ordinary plan was not blocked');
  });

  test(`${store}: an account switch mid-push writes nothing for the fenced item`, async () => {
    const db = newDb();
    authorize(db, def);
    const a = device(db, def);
    a.write([fencedItem(def, { updatedBy: 'dev', updatedAt: T + 5 })]);
    const pending = a.push();
    a.state.owner = 'uid_other_account'; // the account changed before Firebase ran the transaction
    const result = await pending;
    assert.equal(result.committed, false);
    assert.equal(db.read(fenceAt(def)), null, 'zero writes');
  });
}

test('a fenced item and the plan record are independent writes: only fenced items travel to the fence collection', async () => {
  const db = newDb();
  const def = STORES.calendar;
  const a = device(db, def);
  a.write([ordinary]);
  assert.equal((await a.push()).committed, true);
  assert.equal(db.read(at(`${def.fence}`)), null, 'no fence collection is created for a plan with no fenced item');
});
