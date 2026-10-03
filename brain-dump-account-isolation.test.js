// brain-dump-account-isolation.test.js
//
// Brain Dump + Eisenhower V1 must follow the same account-isolation discipline
// Cross-Store Account Isolation V1 already proved for commitments and coarse life
// evidence (cross-store-account-isolation.test.js): a direct account switch (no
// sign-out, no reload) must never push one account's captures into another
// account's room, never merge a stale room's callback into the active cache, and
// never drain one owner's offline queue into another's room.
//
// One physical device (one shared storage), two accounts, ONE instrumented
// in-memory database holding every room. No real Firebase, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { wireCopy } from './brain-dump-test-support.js';

import { createBrainDumpRepository, brainDumpCacheKeyForRoom } from './brain-dump-repository.js';
import { createBrainDumpSyncBridge, BRAIN_DUMP_REMOTE_PATH } from './brain-dump-sync.js';

const T0 = Date.parse('2026-10-01T08:00:00Z');
const ROOM = uid => `uid_${uid}`;

const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

// ═══════════════════════════════════════════════════════════════════════════
// an instrumented in-memory database holding every room (mirrors
// cross-store-account-isolation.test.js's makeDatabase() exactly, trimmed to one
// remote path)
// ═══════════════════════════════════════════════════════════════════════════

function makeDatabase() {
  const root = { value: {} };
  const listeners = new Map();
  const stats = { writes: [], offline: false };
  const get = path => path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  const clone = wireCopy; // RTDB wire form: null keys pruned (see brain-dump-test-support.js)
  function deliver(path) {
    if (stats.offline) return;
    (listeners.get(path) || []).forEach(fn => fn({ val: () => clone(get(path)) }));
  }
  function set(path, value) {
    const segs = path.split('/').filter(Boolean);
    let node = root.value;
    for (let i = 0; i < segs.length - 1; i++) {
      if (typeof node[segs[i]] !== 'object' || node[segs[i]] === null) node[segs[i]] = {};
      node = node[segs[i]];
    }
    node[segs[segs.length - 1]] = clone(value);
    for (let i = segs.length; i >= 0; i--) deliver(segs.slice(0, i).join('/'));
  }
  function runTransaction(path, updateFn) {
    const next = updateFn(clone(get(path)));
    if (next === undefined) return { committed: false, snapshot: { val: () => clone(get(path)) } };
    stats.writes.push({ path, value: clone(next) });
    set(path, next);
    return { committed: true, snapshot: { val: () => clone(next) } };
  }
  function makeRef(path) {
    return {
      path,
      child(seg) { return makeRef(`${path}/${seg}`); },
      on(_event, fn) {
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(fn);
        if (!stats.offline) fn({ val: () => clone(get(path)) });
      },
      off() { listeners.delete(path); },
      transaction(updateFn) {
        if (stats.offline) return Promise.reject(new Error('client is offline'));
        return Promise.resolve(runTransaction(path, updateFn));
      },
    };
  }
  return {
    stats, get, ref: makeRef,
    writesInto(room) { return stats.writes.filter(w => w.path.startsWith(`rooms/${room}/`)); },
    goOffline() { stats.offline = true; },
    goOnline() { stats.offline = false; [...listeners.keys()].forEach(deliver); },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// one physical device, wired exactly as storage.js wires it
// ═══════════════════════════════════════════════════════════════════════════

function makeDevice(db, { storage = memory(), deviceId = 'device-1' } = {}) {
  const env = { roomCode: '', fbRoomRef: null };
  const owner = () => env.roomCode || null;
  const rebinds = [];
  const repository = createBrainDumpRepository({ storage, getOwner: owner, now: () => T0, deviceId: () => deviceId });
  const bridge = createBrainDumpSyncBridge({
    repository,
    getRoomRef: () => env.fbRoomRef,
    getRoomId: owner,
    onRebind: room => rebinds.push(room),
  });

  return {
    repository, bridge, rebinds,
    /** storage.js's real order for a direct switch: roomCode changes, THEN
     *  startSync() -> attach(), THEN the reconnect hook -> pushAllLocal(). No
     *  teardown in between — that absence is exactly the historical bug class. */
    switchTo(uid) {
      env.roomCode = ROOM(uid);
      env.fbRoomRef = db.ref(`rooms/${ROOM(uid)}`);
      bridge.attach();
      return bridge.pushAllLocal();
    },
    /** storage.js's real sign-out order: detach while the room is still set, THEN clear it. */
    signOut() {
      bridge.detach();
      env.roomCode = '';
      env.fbRoomRef = null;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// tests
// ═══════════════════════════════════════════════════════════════════════════

test('a direct account switch (A -> B, no sign-out) never pushes A\'s capture into B\'s room', async () => {
  const db = makeDatabase();
  const device = makeDevice(db);

  await device.switchTo('account-a');
  const { record } = device.repository.create({ text: 'A\'s private thought' });
  await device.bridge.syncCapture(record.id);
  await settle();
  assert.ok(db.get(`rooms/${ROOM('account-a')}/${BRAIN_DUMP_REMOTE_PATH}/${record.id}`), 'A\'s own room got the write');

  // Direct switch: no teardown, exactly the historical bug's reproduction shape.
  await device.switchTo('account-b');
  await settle();

  assert.equal(db.get(`rooms/${ROOM('account-b')}/${BRAIN_DUMP_REMOTE_PATH}/${record.id}`), undefined, 'A\'s capture must never appear in B\'s room');
  assert.deepEqual(device.repository.listAllRaw(), {}, 'B\'s active cache must not see A\'s capture');
});

test('B never reads A\'s capture from B\'s own list after the switch, and A is untouched when the device returns', async () => {
  const db = makeDatabase();
  const device = makeDevice(db);

  await device.switchTo('account-a');
  device.repository.create({ text: 'A only' });
  await settle();

  await device.switchTo('account-b');
  assert.equal(Object.keys(device.repository.listAllRaw()).length, 0, 'B starts with an empty Brain Dump list');
  device.repository.create({ text: 'B only' });

  await device.switchTo('account-a');
  const aList = Object.values(device.repository.listAllRaw());
  assert.equal(aList.length, 1);
  assert.equal(aList[0].text, 'A only', 'A\'s cache slot was untouched by B\'s session');
});

test('sign-out then sign-in as a different account never resurrects the previous account\'s pending queue into the new room', async () => {
  const db = makeDatabase();
  const device = makeDevice(db);
  db.goOffline();
  await device.switchTo('account-a');
  const { record } = device.repository.create({ text: 'Queued while offline' });
  await device.bridge.pushCapture(record.id); // queued — db is offline
  assert.deepEqual(device.bridge.pendingPushIds(ROOM('account-a')), [record.id]);

  device.signOut();
  db.goOnline();
  await device.switchTo('account-b');
  await settle();

  assert.equal(db.get(`rooms/${ROOM('account-b')}/${BRAIN_DUMP_REMOTE_PATH}/${record.id}`), undefined, 'the queued write must never drain into the new room');
  assert.equal(Object.keys(device.repository.listAllRaw()).length, 0);
});

test('a stale remote callback from a room this device has since left is dropped, never merged', async () => {
  const db = makeDatabase();
  const device = makeDevice(db);
  await device.switchTo('account-a');
  await device.switchTo('account-b');
  // Simulate A's room firing a late snapshot (e.g. another of A's own devices
  // writing just as this device switched away) directly at the bridge, bypassing
  // the listener plumbing — this is exactly what handleRemoteSnapshot must refuse.
  device.bridge.handleRemoteSnapshot({
    stalecap1: { schemaVersion: 1, id: 'stalecap1', text: 'Should never land under B', createdAt: T0, updatedAt: T0, updatedBy: 'device-9', status: 'untriaged', important: null, urgent: null, triagedAt: null, disposedAt: null, promotion: null, delegatedTo: null },
  }, ROOM('account-a'));
  assert.equal(device.repository.read('stalecap1'), null);
});

test('two devices on the SAME account converge a concurrent triage write deterministically', async () => {
  const db = makeDatabase();
  const deviceOne = makeDevice(db, { deviceId: 'device-1' });
  const deviceTwo = makeDevice(db, { storage: memory(), deviceId: 'device-2' });
  await deviceOne.switchTo('account-a');
  const { record } = deviceOne.repository.create({ text: 'Shared thought' });
  await deviceOne.bridge.syncCapture(record.id);
  await settle();

  await deviceTwo.switchTo('account-a');
  await settle(); // device two's listener pulls the record device one just pushed
  assert.equal(deviceTwo.repository.read(record.id)?.text, 'Shared thought');

  // Both devices triage "at the same time" (same updatedAt) with different answers.
  deviceOne.repository.triage(record.id, { important: true, urgent: true, now: T0 + 500 });
  deviceTwo.repository.triage(record.id, { important: false, urgent: false, now: T0 + 500 });
  await deviceOne.bridge.syncCapture(record.id);
  await deviceTwo.bridge.syncCapture(record.id);
  await settle();

  const oneFinal = deviceOne.repository.read(record.id);
  const twoFinal = deviceTwo.repository.read(record.id);
  assert.equal(oneFinal.important, twoFinal.important, 'both devices must converge on the SAME winner');
  assert.equal(oneFinal.urgent, twoFinal.urgent);
});

test('account switch mid-capture: a capture created right before a switch still ends up ONLY in its own account\'s room', async () => {
  const db = makeDatabase();
  const device = makeDevice(db);
  await device.switchTo('account-a');
  const { record } = device.repository.create({ text: 'Created right before switching' });
  // No explicit push yet — simulate the switch happening before this device's own
  // reconnect hook got a chance to push it (push races a client-side switch).
  await device.switchTo('account-b');
  await settle();
  assert.equal(db.get(`rooms/${ROOM('account-b')}/${BRAIN_DUMP_REMOTE_PATH}/${record.id}`), undefined);
  // The write is still durable in A's own cache slot, ready to push next time A is active.
  await device.switchTo('account-a');
  assert.equal(device.repository.read(record.id)?.text, 'Created right before switching');
});

test('9. account switch during a claimed promotion: a stale callback cannot write/promote under another room', async () => {
  // FIX FIRST — promote-vs-archive/delegate arbitration. A promotion claim made
  // under account A, followed by a direct switch to B (no sign-out), must never
  // let a late-arriving callback from A's room finalize/promote anything into B's
  // active cache — the same roomOwnsCache() discipline every write already uses,
  // now exercised against claimPromotion/finalizePromotion specifically.
  const db = makeDatabase();
  const device = makeDevice(db);
  await device.switchTo('account-a');
  const { record } = device.repository.create({ text: 'Claimed under A' });
  const claimed = device.repository.claimPromotion(record.id, {
    promotion: { type: 'do-today', store: 'legacy', targetId: '2026-10-01', planItemId: `bdp1|${record.id}` },
  });
  assert.ok(claimed.ok);
  await device.bridge.syncCapture(record.id);
  await settle();

  // Direct switch, no teardown — the historical bug's exact reproduction shape.
  await device.switchTo('account-b');
  await settle();
  assert.equal(Object.keys(device.repository.listAllRaw()).length, 0, 'B\'s active cache starts empty');

  // A stale callback from A's room (e.g. another of A's own devices finalizing
  // the SAME claim) must be dropped, never merged into B's now-active cache.
  device.bridge.handleRemoteSnapshot({
    [record.id]: { ...claimed.record, status: 'promoted', promotion: { type: 'do-today', store: 'legacy', targetId: '2026-10-01', planItemId: `bdp1|${record.id}`, promotedAt: T0 + 50 }, promotionClaim: null, disposedAt: T0 + 50, updatedAt: T0 + 50 },
  }, ROOM('account-a'));
  assert.equal(device.repository.read(record.id), null, 'B never sees A\'s capture at all, claimed or finalized');

  // And B's own finalizePromotion/claimPromotion calls for A's id must refuse —
  // there is nothing to act on under B's active (empty) cache.
  const stillUnderB = device.repository.finalizePromotion(record.id);
  assert.equal(stillUnderB.ok, false);
  assert.equal(stillUnderB.reason, 'not-found');
});

test('the pre-scoping (unsuffixed) storage key is never touched by a scoped repository', async () => {
  const storage = memory();
  storage.setItem('ta3-brain-dump-v1', JSON.stringify({ schemaVersion: 1, captures: { legacycap1: { id: 'legacycap1' } } }));
  const db = makeDatabase();
  const device = makeDevice(db, { storage });
  await device.switchTo('account-a');
  device.repository.create({ text: 'New, scoped' });
  // The quarantined unsuffixed key must be byte-for-byte untouched.
  assert.equal(storage.getItem('ta3-brain-dump-v1'), JSON.stringify({ schemaVersion: 1, captures: { legacycap1: { id: 'legacycap1' } } }));
  assert.ok(storage.getItem(brainDumpCacheKeyForRoom(ROOM('account-a'))));
});

test('11. account switch DURING an in-flight remote claim: the resolved transaction must not be adopted under the new room, and nothing is written for B', async () => {
  // FIX FIRST round 2. A genuinely in-flight scenario: the claim's Firebase
  // transaction is still awaiting its network round trip when the account
  // switches — unlike a synchronously-resolving fake, this one is only released
  // once the test explicitly says the "server" has answered, AFTER the switch
  // already happened. roomOwnsCache() is re-checked both inside the
  // transaction's own update function and again once it settles, so either
  // check alone closes this window.
  let release = null;
  const delayableRoomA = {
    child() { return this; },
    transaction(updateFn) {
      return new Promise(resolve => {
        release = () => {
          const result = updateFn(null); // nothing authoritative existed yet for this capture
          resolve(result === undefined ? { committed: false, snapshot: { val: () => null } } : { committed: true, snapshot: { val: () => result } });
        };
      });
    },
    on() {}, off() {},
  };
  const roomB = { child() { return this; }, transaction() { return Promise.resolve({ committed: false }); }, on() {}, off() {} };

  const env = { roomCode: ROOM('account-a'), fbRoomRef: delayableRoomA };
  const repository = createBrainDumpRepository({ storage: memory(), getOwner: () => env.roomCode, now: () => T0, deviceId: () => 'device-1' });
  const bridge = createBrainDumpSyncBridge({ repository, getRoomRef: () => env.fbRoomRef, getRoomId: () => env.roomCode, now: () => T0, deviceId: () => 'device-1' });

  const { record } = repository.create({ text: 'Switched mid-claim' });
  const claimPromise = bridge.claimPromotionRemote(record.id, { type: 'do-today', store: 'legacy', targetId: '2026-10-01', planItemId: `bdp1|${record.id}` });

  // The switch happens WHILE the transaction above is still pending — no
  // sign-out, the historical bug's exact reproduction shape.
  env.roomCode = ROOM('account-b');
  env.fbRoomRef = roomB;

  release(); // the "server" finally answers, now that B is the active room
  const result = await claimPromise;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'offline', 'the stale in-flight claim is refused, never silently adopted under B');
  assert.equal(repository.read(record.id), null, 'B\'s active cache never receives A\'s capture or claim');
});
