// brain-dump-rollout-compat.test.js
//
// Brain Dump Production UX Correction V1, FIX FIRST: a rolling deployment.
// An OLD client (the real pre-reopen modules deployed at cf43080, vendored in
// fixtures/brain-dump-pre-reopen/) stays open while a NEW client reopens a
// capture. The old model has no reopenCount: it normalizes it away and ranks
// archived/delegated above an active record, so on its own it would push the
// stale disposition straight back over the reopen.
//
// The fake room below enforces the REAL firebase.rules.json (via targaryen) on
// every transaction commit, exactly as the server would: a denied write rejects
// the transaction, like the SDK's permission_denied. Nothing here touches real
// Firebase.

import test from 'node:test';
import assert from 'node:assert/strict';
import { wireCopy } from './brain-dump-test-support.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import targaryen from 'targaryen';

import { createBrainDumpRepository as createNewRepository } from './brain-dump-repository.js';
import { createBrainDumpSyncBridge as createNewBridge } from './brain-dump-sync.js';
import { promoteCaptureToPlan, settleOutstandingClaim } from './brain-dump-promotion.js';
import { brainDumpPlanItemId } from './brain-dump-model.js';
import { createBrainDumpRepository as createOldRepository } from './fixtures/brain-dump-pre-reopen/brain-dump-repository.js';
import { createBrainDumpSyncBridge as createOldBridge } from './fixtures/brain-dump-pre-reopen/brain-dump-sync.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = JSON.parse(readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8'));
const T0 = Date.parse('2026-10-03T08:00:00Z');
const UID = 'alice_uid';
const ROOM = `uid_${UID}`;

const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const clone = wireCopy; // RTDB wire form: null keys pruned (see brain-dump-test-support.js)

/** All rooms in one database. Every committed write is checked against the
 *  real rules first; a denial rejects the transaction with no write. */
function makeDatabase() {
  const rooms = {};
  const listeners = new Map(); // room -> Set
  const denials = [];
  const subtree = room => (rooms[room] = rooms[room] || {});
  function notify(room) { (listeners.get(room) || new Set()).forEach(fn => fn({ val: () => clone(subtree(room)) })); }
  function roomRef(room, uid) {
    const capture = id => ({
      transaction(updateFn) {
        const current = clone(subtree(room)[id]);
        const next = updateFn(current);
        if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => clone(subtree(room)[id]) } });
        const at = `/rooms/${room}/brainDump/${id}`;
        const state = { rooms: Object.fromEntries(Object.entries(rooms).map(([r, captures]) => [r, { brainDump: clone(captures) }])) };
        const verdict = targaryen.database(RULES, state).as({ uid }).write(at, clone(next));
        if (!verdict.allowed) {
          denials.push({ room, id, attempted: clone(next) });
          return Promise.reject(Object.assign(new Error('permission_denied'), { code: 'PERMISSION_DENIED' }));
        }
        subtree(room)[id] = clone(next);
        notify(room);
        return Promise.resolve({ committed: true, snapshot: { val: () => clone(subtree(room)[id]) } });
      },
    });
    const brainDump = {
      child: id => capture(id),
      on(_event, fn) { if (!listeners.has(room)) listeners.set(room, new Set()); listeners.get(room).add(fn); fn({ val: () => clone(subtree(room)) }); },
      off() { listeners.delete(room); },
    };
    return { child: seg => (seg === 'brainDump' ? brainDump : null) };
  }
  return { rooms, denials, roomRef, raw: (room = ROOM) => clone(subtree(room)) || {} };
}

function makePlanAuthority() {
  const items = [];
  const today = { store: 'calendar', id: 'cal1:2026-10-03', dateKey: '2026-10-03' };
  return {
    items,
    current: () => today,
    dayForScheduledDate: dateKey => ({ ok: true, anchor: 'noon', target: { store: 'calendar', id: `cal1:${dateKey}`, dateKey } }),
    rawItems: () => items,
    addItem({ item }) { items.push(item); return { item }; },
    // One shared array stands in for the plan store's server copy in these tests.
    remoteItemPresence: (_target, itemId) => Promise.resolve(items.some(i => i.id === itemId) ? 'present' : 'absent'),
    targetById(id) { const m = /^cal1:(.+)$/.exec(id); return m ? { store: 'calendar', id, dateKey: m[1] } : null; },
  };
}

/** `kind` 'new' = this candidate's modules; 'old' = the deployed cf43080 modules.
 *  Both are wired like production: onRemoteChange runs the UI's reconcile trigger. */
function makeDevice({ kind, db, planAuthority, deviceId, clock, uid = UID, live = true }) {
  const room = `uid_${uid}`;
  const createRepository = kind === 'new' ? createNewRepository : createOldRepository;
  const createBridge = kind === 'new' ? createNewBridge : createOldBridge;
  const repository = createRepository({ storage: memory(), getOwner: () => room, now: () => clock.now, deviceId: () => deviceId });
  let bridge = null;
  bridge = createBridge({
    repository, getRoomRef: () => db.roomRef(room, uid), getRoomId: () => room, now: () => clock.now, deviceId: () => deviceId,
    onRemoteChange: (id, record) => {
      if (kind !== 'new' || !record || !record.promotionClaim || (record.status !== 'untriaged' && record.status !== 'triaged')) return;
      // Exactly what brain-dump-ui.js's maybeReconcile runs.
      settleOutstandingClaim({ repository, planAuthority, id, now: clock.now, deviceId, revokeClaim: bridge.revokeClaimRemote, resolveExpiredClaim: bridge.resolveExpiredClaimRemote })
        .then(outcome => { if (outcome?.record) bridge.syncCapture(id); });
    },
  });
  if (live) bridge.attach();
  return {
    kind, repository, bridge,
    async push(id) { return bridge.pushCapture(id); },
  };
}

function setup() {
  const db = makeDatabase();
  const pa = makePlanAuthority();
  const clock = { now: T0 };
  const fresh = makeDevice({ kind: 'new', db, planAuthority: pa, deviceId: 'new-device', clock });
  const old = makeDevice({ kind: 'old', db, planAuthority: pa, deviceId: 'old-device', clock });
  return { db, pa, clock, fresh, old };
}

async function triagedCapture({ fresh, clock }, text) {
  const id = fresh.repository.create({ text }).record.id;
  await fresh.bridge.syncCapture(id);
  clock.now += 1000;
  fresh.repository.triage(id, { important: true, urgent: false });
  await fresh.bridge.syncCapture(id);
  return id;
}

// ═══════════════════════════════════════════════════════════════════════════
// A-D: an old client can never downgrade a reopened record
// ═══════════════════════════════════════════════════════════════════════════

for (const disposition of ['delegate', 'archive']) {
  const label = disposition === 'delegate' ? 'A. Delegated' : 'B. Archived';
  test(`${label} -> NEW Reopen -> OLD stale push: remote stays reopened, the old write is refused`, async () => {
    const env = setup();
    const { db, clock, fresh, old } = env;
    const id = await triagedCapture(env, `${disposition} me`);
    clock.now += 1000;
    if (disposition === 'delegate') fresh.repository.delegate(id, { delegatedTo: 'Alex' }); else fresh.repository.archive(id);
    await fresh.bridge.syncCapture(id);
    await flush();
    assert.equal(old.repository.read(id).status, disposition === 'delegate' ? 'delegated' : 'archived', 'the old client saw the disposition');

    clock.now += 1000;
    assert.equal(fresh.repository.reopen(id).ok, true);
    await fresh.bridge.syncCapture(id);
    await flush();
    assert.equal(db.raw()[id].status, 'triaged');

    // The stale old client reconnects and re-pushes everything it holds.
    clock.now += 60_000;
    await old.bridge.pushAllLocal({ all: true });
    await flush();
    const remote = db.raw()[id];
    assert.equal(remote.status, 'triaged', `remote must stay reopened, got ${remote.status}`);
    assert.equal(remote.reopenCount, 1);
    assert.equal(remote.delegatedTo ?? null, null);
    assert.ok(db.denials.some(d => d.id === id), 'the old downgrade was refused by the rules');
    assert.equal(fresh.repository.read(id).status, 'triaged', 'the new client keeps the reopened truth');
  });
}

test('C. NEW Reopen -> Schedule -> OLD stale push: the promotion wins, exactly one destination', async () => {
  const env = setup();
  const { db, pa, clock, fresh, old } = env;
  const id = await triagedCapture(env, 'Reopen then schedule');
  clock.now += 1000;
  fresh.repository.delegate(id, { delegatedTo: 'Alex' });
  await fresh.bridge.syncCapture(id);
  await flush();
  clock.now += 1000;
  fresh.repository.reopen(id);
  await fresh.bridge.syncCapture(id);
  clock.now += 1000;
  const promoted = await promoteCaptureToPlan({ repository: fresh.repository, planAuthority: pa, claimPromotionRemote: fresh.bridge.claimPromotionRemote, id, type: 'schedule', dateKey: '2026-10-09', when: '15:00', now: clock.now, deviceId: 'new-device' });
  assert.equal(promoted.ok, true, promoted.reason);
  await flush();
  clock.now += 60_000;
  await old.bridge.pushAllLocal({ all: true });
  await flush();
  assert.equal(db.raw()[id].status, 'promoted');
  assert.equal(pa.items.filter(i => i.id === brainDumpPlanItemId(id)).length, 1);
});

test('D. OLD client holding a stale active copy cannot archive, delegate or claim over a NEW-generation record; it fails safe', async () => {
  const env = setup();
  const { db, pa, clock, fresh } = env;
  const id = await triagedCapture(env, 'Old client tries');
  // The old client goes stale here (still holds "triaged", generation 1).
  const staleOld = makeDevice({ kind: 'old', db, planAuthority: pa, deviceId: 'old-stale', clock, live: false });
  // Seeded with the LOCAL logical record (what that old device's own localStorage would hold): the
  // cf43080 model cannot even normalize a pruned non-terminal record straight off the wire.
  const localV1 = fresh.repository.read(id);
  staleOld.repository.mergeRemote(id, localV1);
  assert.equal(staleOld.repository.read(id).status, 'triaged', 'the old client really holds a stale copy');
  clock.now += 1000;
  fresh.repository.archive(id);
  await fresh.bridge.syncCapture(id);
  clock.now += 1000;
  fresh.repository.reopen(id);
  await fresh.bridge.syncCapture(id);
  const before = db.raw()[id];

  clock.now += 1000;
  assert.equal(staleOld.repository.archive(id).ok, true, 'the old client only changes its own stale copy');
  assert.equal((await staleOld.push(id)).committed, false);
  assert.deepEqual(db.raw()[id], before, 'remote truth is untouched');

  const oldPromotion = await import('./fixtures/brain-dump-pre-reopen/brain-dump-promotion.js');
  const stale2 = makeDevice({ kind: 'old', db, planAuthority: pa, deviceId: 'old-stale-2', clock, live: false });
  const legacyCopy = { ...localV1 };
  delete legacyCopy.reopenCount;
  stale2.repository.mergeRemote(id, legacyCopy);
  assert.equal(stale2.repository.read(id).status, 'triaged', 'the second old client also holds a real stale copy');
  const claim = await oldPromotion.promoteCaptureToPlan({ repository: stale2.repository, planAuthority: pa, claimPromotionRemote: stale2.bridge.claimPromotionRemote, id, type: 'do-today', now: clock.now, deviceId: 'old-stale-2' });
  assert.equal(claim.ok, false, 'an old client cannot claim a new-generation record');
  assert.notEqual(claim.reason, 'not-found', 'refused by the server, not for lack of a local copy');
  assert.equal(pa.items.length, 0, 'no plan item');
  assert.deepEqual(db.raw()[id], before);

  // A live old client receiving the new-generation record does not crash and does not adopt it.
  const liveOld = makeDevice({ kind: 'old', db, planAuthority: pa, deviceId: 'old-live', clock });
  assert.equal(liveOld.repository.read(id), null, 'the old client ignores a record it cannot represent');
});

// ═══════════════════════════════════════════════════════════════════════════
// E-G: legacy records stay fully usable; new clients converge; rooms isolated
// ═══════════════════════════════════════════════════════════════════════════

test('E. NEW client reads and mutates legacy records without upgrading them, and OLD clients keep writing them', async () => {
  const env = setup();
  const { db, pa, clock, fresh, old } = env;
  // Written by the OLD client: a genuine legacy record.
  const id = old.repository.create({ text: 'Legacy capture' }).record.id;
  await old.bridge.syncCapture(id);
  await flush();
  assert.equal(fresh.repository.read(id).text, 'Legacy capture');
  clock.now += 1000;
  assert.equal(fresh.repository.triage(id, { important: false, urgent: true }).ok, true);
  await fresh.bridge.syncCapture(id);
  clock.now += 1000;
  assert.equal(fresh.repository.delegate(id, { delegatedTo: 'Alex' }).ok, true);
  await fresh.bridge.syncCapture(id);
  clock.now += 1000;
  assert.equal(fresh.repository.editHandled(id, { delegatedTo: 'Sam' }).ok, true);
  await fresh.bridge.syncCapture(id);
  assert.equal(db.raw()[id].schemaVersion, 1, 'ordinary mutations never upgrade the generation');
  await flush();
  assert.equal(old.repository.read(id).delegatedTo, 'Sam', 'the old client still reads it');

  const other = old.repository.create({ text: 'Legacy, promoted by new' }).record.id;
  await old.bridge.syncCapture(other);
  await flush();
  fresh.repository.triage(other, { important: true, urgent: true });
  await fresh.bridge.syncCapture(other);
  const result = await promoteCaptureToPlan({ repository: fresh.repository, planAuthority: pa, claimPromotionRemote: fresh.bridge.claimPromotionRemote, id: other, type: 'do-today', now: clock.now, deviceId: 'new-device' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(db.raw()[other].status, 'promoted');
  assert.equal(db.denials.length, 0, 'nothing was refused');
});

test('F. two NEW clients reopening concurrently converge deterministically on generation 2', async () => {
  for (const order of [['x', 'y'], ['y', 'x']]) {
    const db = makeDatabase();
    const pa = makePlanAuthority();
    const clock = { now: T0 };
    const devices = {
      x: makeDevice({ kind: 'new', db, planAuthority: pa, deviceId: 'x', clock, live: false }),
      y: makeDevice({ kind: 'new', db, planAuthority: pa, deviceId: 'y', clock, live: false }),
    };
    const id = devices.x.repository.create({ text: 'Both reopen' }).record.id;
    devices.x.repository.archive(id);
    await devices.x.bridge.syncCapture(id);
    devices.y.repository.mergeRemote(id, db.raw()[id]);
    clock.now = T0 + 1000; devices.x.repository.reopen(id);
    clock.now = T0 + 2000; devices.y.repository.reopen(id);
    for (const name of order) await devices[name].bridge.syncCapture(id);
    for (const name of order) await devices[name].bridge.syncCapture(id);
    const remote = db.raw()[id];
    assert.equal(remote.updatedBy, 'y', `order ${order}`);
    assert.equal(remote.reopenCount, 1);
    assert.equal(remote.schemaVersion, 2);
    assert.deepEqual(devices.x.repository.read(id), devices.y.repository.read(id));
  }
});

test('G. account isolation: an upgrade in one room never affects another room, and no account can write a foreign room', async () => {
  const db = makeDatabase();
  const pa = makePlanAuthority();
  const clock = { now: T0 };
  const alice = makeDevice({ kind: 'new', db, planAuthority: pa, deviceId: 'a', clock, uid: 'alice_uid' });
  const bobOld = makeDevice({ kind: 'old', db, planAuthority: pa, deviceId: 'b', clock, uid: 'bob_uid' });
  const a = alice.repository.create({ text: 'Alice' }).record.id;
  alice.repository.archive(a);
  await alice.bridge.syncCapture(a);
  clock.now += 1000;
  alice.repository.reopen(a);
  await alice.bridge.syncCapture(a);
  const b = bobOld.repository.create({ text: 'Bob' }).record.id;
  bobOld.repository.archive(b);
  assert.equal((await bobOld.push(b)).committed, true, 'Bob\'s old client keeps writing his own legacy record');
  assert.equal(db.raw('uid_bob_uid')[a], undefined, 'Alice\'s capture never reaches Bob\'s room');
  // Bob's credentials writing into Alice's room are refused by the rules.
  const intruder = db.roomRef('uid_alice_uid', 'bob_uid');
  await assert.rejects(intruder.child('brainDump').child(a).transaction(() => ({ ...db.raw()[a], text: 'hijack' })));
  assert.equal(db.raw()[a].text, 'Alice');
});

test('H. the generation is carried, never lowered: a NEW client whose stale generation-1 claim wins the merge still writes generation 2', async () => {
  const env = setup();
  const { db, pa, clock, fresh } = env;
  const id = await triagedCapture(env, 'Stale claimant');
  // A second NEW client last saw "triaged" (generation 1) and stays stale.
  const stale = makeDevice({ kind: 'new', db, planAuthority: pa, deviceId: 'new-stale', clock, live: false });
  stale.repository.mergeRemote(id, db.raw()[id]);
  clock.now += 1000;
  fresh.repository.archive(id);
  await fresh.bridge.syncCapture(id);
  clock.now += 1000;
  fresh.repository.reopen(id);
  await fresh.bridge.syncCapture(id);
  assert.equal(db.raw()[id].schemaVersion, 2);
  clock.now += 1000;
  // Its claim (rank 2) out-ranks the remote reopened record (rank 0), so its generation-1 copy wins the
  // merge. Only the monotonic generation keeps that write from being refused as a downgrade.
  const result = await promoteCaptureToPlan({ repository: stale.repository, planAuthority: pa, claimPromotionRemote: stale.bridge.claimPromotionRemote, id, type: 'do-today', now: clock.now, deviceId: 'new-stale' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(db.raw()[id].schemaVersion, 2);
  assert.equal(db.denials.length, 0, 'a new client is never refused');
  assert.equal(pa.items.length, 1);
});

test('I. reopened v2 over the PRUNED wire: a fresh NEW device sees it exactly, and an OLD stale push is still refused', async () => {
  const env = setup();
  const { db, pa, clock, fresh } = env;
  const id = await triagedCapture(env, 'Reopen across devices');
  // An old device that created/held this record locally while it was delegated (generation 1).
  clock.now += 1000;
  fresh.repository.delegate(id, { delegatedTo: 'Alex' });
  await fresh.bridge.syncCapture(id);
  const old = makeDevice({ kind: 'old', db, planAuthority: pa, deviceId: 'old-holder', clock, live: false });
  old.repository.mergeRemote(id, fresh.repository.read(id));
  assert.equal(old.repository.read(id).status, 'delegated');

  clock.now += 1000;
  fresh.repository.reopen(id);
  await fresh.bridge.syncCapture(id);
  const wire = db.raw()[id];
  for (const key of ['disposedAt', 'delegatedTo', 'promotionClaim', 'promotion']) assert.equal(key in wire, false, `${key} is pruned on the wire`);

  // Device B: a FRESH new client loading the room from scratch.
  const deviceB = makeDevice({ kind: 'new', db, planAuthority: pa, deviceId: 'device-b', clock });
  await flush();
  const seen = deviceB.repository.read(id);
  assert.ok(seen, 'device B sees the reopened capture');
  assert.equal(seen.status, 'triaged');
  assert.equal(seen.schemaVersion, 2);
  assert.equal(seen.reopenCount, 1);
  assert.equal(seen.important, true);
  assert.equal(seen.urgent, false);
  assert.equal(seen.disposedAt, null);
  assert.equal(seen.delegatedTo, null);

  // The F2 barrier still holds: the old holder re-pushes its stale delegated copy.
  clock.now += 60_000;
  await old.bridge.pushAllLocal({ all: true });
  await flush();
  assert.ok(db.denials.some(d => d.id === id && d.attempted.status === 'delegated'), 'the stale downgrade was refused');
  assert.equal(db.raw()[id].status, 'triaged');
  assert.equal(db.raw()[id].schemaVersion, 2);
  assert.equal(deviceB.repository.read(id).status, 'triaged', 'device B keeps the reopened truth');
});
