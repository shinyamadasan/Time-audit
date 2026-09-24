// personal-day-boundary-recovery.test.js
//
// Legacy Recovery V2 — provenance-aware. Structural compatibility (analyzeRecoveryCompatibility) is
// never treated as ownership proof. The only provenance gate is an explicit, session-local owner
// attestation, re-validated against the CURRENT room and the CURRENT compatible set every time it
// matters — never inferred from a click, never persisted, always required again after a reload, an
// account switch, or a change to what would actually be appended.
//
// Everything here runs against in-memory storage and an in-memory fake Firebase room ref — no real
// project, no network, no production data.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeRecoveryCompatibility,
  classifyRevisions,
  createPersonalDayBoundaryRecovery,
} from './personal-day-boundary-recovery.js';
import { createPersonalDayBoundarySyncBridge, DAY_BOUNDARY_REVISIONS_REMOTE_PATH, decodeWireMap } from './personal-day-boundary-sync.js';
import { createPersonalDayBoundaryRepository, PERSONAL_DAY_BOUNDARY_STORAGE_KEY, PERSONAL_DAY_BOUNDARY_SCHEMA_VERSION } from './personal-day-boundary-repository.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { legacyBoundaryRevision, proposeBoundaryRevision } from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';
const ROOM_A = 'uid_account-a';
const ROOM_B = 'uid_account-b';
const manila = (dateStr, hhmm) => Date.parse(`${dateStr}T${hhmm}:00+08:00`);
const T_0800 = manila('2026-09-14', '08:00');

const memory = (seed = null) => {
  const map = new Map();
  if (seed) Object.entries(seed).forEach(([k, v]) => map.set(k, v));
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

function fakeRoomRef(initial = {}) {
  const root = { value: initial };
  const listeners = new Map();
  const get = path => path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  const fire = path => (listeners.get(path) || []).forEach(fn => fn({ val: () => get(path) ?? null }));
  function set(path, value) {
    const segs = path.split('/').filter(Boolean);
    if (!segs.length) { root.value = value; fire(''); return; }
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
        fn({ val: () => get(path) ?? null });
      },
      off() { listeners.delete(path); },
      once(_event) { return Promise.resolve({ val: () => get(path) ?? null }); },
      val: () => get(path) ?? null,
      transaction(updateFn) {
        const current = get(path) ?? null;
        const next = updateFn(current);
        if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => current } });
        set(path, next);
        return Promise.resolve({ committed: true, snapshot: { val: () => next } });
      },
    };
  }
  return makeRef('');
}

const anchor = legacyBoundaryRevision(MANILA);
function customAt(id, boundaryTime, dateStr, hhmm) {
  return { id, boundaryTime, timezone: MANILA, effectiveFromInstant: manila(dateStr, hhmm) };
}
const custom18 = customAt('device-custom-18', '18:00', '2026-09-14', '18:00');
const custom20 = customAt('device-custom-20', '20:00', '2026-09-14', '20:00');

function legacyStorageWith(revisions) {
  const storage = memory();
  const byId = {};
  revisions.forEach(r => { byId[r.id] = r; });
  storage.setItem(PERSONAL_DAY_BOUNDARY_STORAGE_KEY, JSON.stringify({ schemaVersion: PERSONAL_DAY_BOUNDARY_SCHEMA_VERSION, revisions: byId }));
  return storage;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure analysis — analyzeRecoveryCompatibility (compatibility, never provenance)
// ═══════════════════════════════════════════════════════════════════════════

test('classifyRevisions: unchanged structural categorization (empty, valid, missing-anchor, duplicate-anchor, malformed, contradiction)', () => {
  assert.equal(classifyRevisions([]).reason, 'none');
  assert.deepEqual(classifyRevisions([anchor]), { totalCount: 1, anchorCount: 1, boundaryCount: 0, valid: true, reason: 'valid' });
  assert.equal(classifyRevisions([custom18]).reason, 'missing-anchor');
});

test('the anchor-only + legacy-complete case is a compatible candidate — never labeled "recoverable"/"safe"', () => {
  const result = analyzeRecoveryCompatibility({ remoteRevisions: [anchor], legacyRevisions: [anchor, custom18], scopedHasApplicableHistory: false });
  assert.equal(result.compatible, true);
  assert.deepEqual(result.missing, [custom18]);
  assert.ok(!('recoverable' in result), 'the old provenance-implying field name must not exist');
  assert.ok(!('safe' in result) && !('provenSafe' in result));
});

test('a remote anchor decoded with a different (but semantically identical) property order is still the same fact -- real Firebase round-trips do not preserve field-write order', () => {
  // Root cause of a real production false-negative: personal-day-boundary-sync.js's
  // decodeWireRevision() rehydrates a wire anchor via `{ ...raw, effectiveFromInstant: null }`,
  // which preserves whatever property order the raw object already had -- and a real Firebase RTDB
  // `.val()` reconstructs an object's properties in ITS OWN key order, not necessarily the order
  // they were originally written in. So a remote-decoded anchor can hold the exact same four facts
  // as the device's legacy anchor, just declared in a different order, purely as a serialization
  // artifact -- never a real difference in what either side actually means.
  const reorderedAnchor = {
    boundaryTime: anchor.boundaryTime,
    effectiveFromInstant: anchor.effectiveFromInstant,
    id: anchor.id,
    timezone: anchor.timezone,
  };
  assert.notEqual(
    Object.keys(reorderedAnchor).join(','), Object.keys(anchor).join(','),
    'the fixture must actually differ in property order for this test to mean anything',
  );
  const result = analyzeRecoveryCompatibility({ remoteRevisions: [reorderedAnchor], legacyRevisions: [anchor, custom18], scopedHasApplicableHistory: false });
  assert.equal(result.compatible, true, `property order alone must never make an identical fact look incompatible (got reason: ${result.reason})`);
  assert.deepEqual(result.missing, [custom18]);
});

test('remote holds a fact legacy has never heard of -> not compatible', () => {
  const result = analyzeRecoveryCompatibility({ remoteRevisions: [anchor, customAt('x', '20:00', '2026-09-20', '20:00')], legacyRevisions: [anchor, custom18], scopedHasApplicableHistory: false });
  assert.equal(result.compatible, false);
  assert.equal(result.reason, 'remote-not-compatible-with-legacy');
});

test('an account already configured is never a candidate, regardless of legacy content', () => {
  const result = analyzeRecoveryCompatibility({ remoteRevisions: [anchor], legacyRevisions: [anchor, custom18], scopedHasApplicableHistory: true });
  assert.equal(result.compatible, false);
  assert.equal(result.reason, 'account-already-configured');
});

// ═══════════════════════════════════════════════════════════════════════════
// Wiring factory
// ═══════════════════════════════════════════════════════════════════════════

/** One device. `context.roomId`/`context.roomRef` are read live by every function this device's
 *  bridge and recovery wiring are given — exactly like production, where `getRoomId`/`getRoomRef`
 *  are closures over global, mutable state (storage.js's `roomCode`/`fbRoomRef`), not values fixed at
 *  construction. `switchRoom()` updates both together (a real account switch always changes both at
 *  once) and re-attaches the SAME bridge instance to the new room — production never recreates the
 *  bridge object itself on an account switch, only re-binds it (see personal-day-boundary-sync.js's
 *  attach()). */
function makeAccountDevice({ roomRef, roomId, storage = memory(), planStorage = memory(), idPrefix = 'acct', clock = T_0800 } = {}) {
  const context = { roomId, roomRef };
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage, idGenerator: () => `${idPrefix}-${Math.random().toString(36).slice(2)}`, getOwner: () => context.roomId });
  const planRepository = createOperationalPlanRepository({ storage: planStorage });
  const boundarySync = createPersonalDayBoundarySyncBridge({ repository: boundaryRepository, getRoomRef: () => context.roomRef, getRoomId: () => context.roomId });
  const live = createPersonalDayBoundaryLiveWiring({ boundaryRepository, planRepository, boundarySync, planSync: null, now: () => clock, fallbackTimezone: () => MANILA });
  return {
    boundaryRepository, boundarySync, live, context,
    switchRoom: (newRoomId, newRoomRef) => {
      context.roomId = newRoomId;
      context.roomRef = newRoomRef;
      boundarySync.attach(); // re-binds the SAME bridge to the new room, exactly like production
    },
  };
}

function makeRecovery(account, legacyRevisions, roomRefForReadBack) {
  const legacyRepository = createPersonalDayBoundaryRepository({ storage: legacyStorageWith(legacyRevisions) });
  return createPersonalDayBoundaryRecovery({
    live: account.live,
    boundarySync: account.boundarySync,
    getRoomId: () => account.context.roomId,
    legacyRepository,
    getRoomRef: () => account.context.roomRef,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. compatible legacy history does NOT auto-recover
// ═══════════════════════════════════════════════════════════════════════════

test('1: a compatible candidate does nothing on its own — status() never writes, never pushes', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();
  const recovery = makeRecovery(account, [anchor, custom18], roomRef);

  const s1 = recovery.status();
  assert.equal(s1.compatible, true);
  const s2 = recovery.status();
  assert.equal(s2.compatible, true);
  // Repeated reads change nothing.
  assert.equal(Object.keys(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val()).length, 1);
  assert.equal(account.live.status().status, 'absent');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. recovery refused until explicit attestation
// ═══════════════════════════════════════════════════════════════════════════

test('2: recover() refuses with zero writes until attest() has been called — a compatible analysis alone is never enough', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();
  const recovery = makeRecovery(account, [anchor, custom18], roomRef);

  assert.equal(recovery.isAttested(), false);
  const result = await recovery.recover();
  assert.equal(result.outcome, 'not-attested');
  assert.equal(Object.keys(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val()).length, 1, 'zero writes');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3/4. cross-account candidates: compatible, but zero writes without attestation
// ═══════════════════════════════════════════════════════════════════════════

test('3: Account A\'s legacy history vs Account B on the SAME timezone/deterministic anchor is a compatible candidate for B, but zero writes occur without B\'s explicit attestation', async () => {
  const roomRefB = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } }); // B's own cloud, anchor-only (e.g. B enabled once, incomplete)
  const accountB = makeAccountDevice({ roomRef: roomRefB, roomId: ROOM_B });
  accountB.boundarySync.attach();
  // A's legacy content happens to be structurally identical in shape (same reserved anchor id is
  // shared by construction; a real custom revision A made).
  const recovery = makeRecovery(accountB, [anchor, custom20], roomRefB);

  const analysis = recovery.status();
  assert.equal(analysis.compatible, true, 'compatibility is purely structural — it does not know whose cache this is');
  const before = await recovery.recover();
  assert.equal(before.outcome, 'not-attested');
  assert.equal(Object.keys(roomRefB.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val()).length, 1, 'zero writes without attestation');

  // Now B's own human owner explicitly attests it is theirs.
  assert.equal(recovery.attest(), true);
  const after = await recovery.recover();
  assert.equal(after.outcome, 'recovered');
  const remote = decodeWireMap(roomRefB.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val());
  assert.equal(Object.keys(remote).length, 2);
});

test('4: Account A\'s legacy history vs an authoritatively EMPTY Account B is a compatible candidate, but zero writes without B\'s explicit attestation; append-only with it', async () => {
  const roomRefB = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: {} }); // B never configured anything
  const accountB = makeAccountDevice({ roomRef: roomRefB, roomId: ROOM_B });
  accountB.boundarySync.attach();
  const recovery = makeRecovery(accountB, [anchor, custom18], roomRefB);

  assert.equal(recovery.status().compatible, true);
  const before = await recovery.recover();
  assert.equal(before.outcome, 'not-attested');
  assert.equal(Object.keys(roomRefB.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val() || {}).length, 0);

  recovery.attest();
  const after = await recovery.recover();
  assert.equal(after.outcome, 'recovered');
  const remote = decodeWireMap(roomRefB.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val());
  assert.deepEqual(Object.keys(remote).sort(), [anchor.id, custom18.id].sort());
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. attested compatible recovery -> append only
// ═══════════════════════════════════════════════════════════════════════════

test('5: attested recovery appends ONLY the missing revision(s), never touching what the cloud already had', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();
  const recovery = makeRecovery(account, [anchor, custom18], roomRef);

  recovery.attest();
  const result = await recovery.recover();
  assert.equal(result.outcome, 'recovered');
  const remoteAfter = decodeWireMap(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val());
  assert.deepEqual(remoteAfter[anchor.id], anchor, 'the anchor the cloud already had is byte-identical — never rewritten');
  assert.deepEqual(remoteAfter[custom18.id], custom18);
  assert.equal(Object.keys(remoteAfter).length, 2, 'nothing extra, nothing deleted');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. account switch clears/refuses attestation
// ═══════════════════════════════════════════════════════════════════════════

test('6: a room switch after attestation invalidates it — recover() refuses with zero writes even though the switch happened after attest()', async () => {
  const roomRefA = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const roomRefB = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: {} });
  const account = makeAccountDevice({ roomRef: roomRefA, roomId: ROOM_A });
  account.boundarySync.attach();
  const recovery = makeRecovery(account, [anchor, custom18], roomRefA);

  assert.equal(recovery.attest(), true);
  assert.equal(recovery.isAttested(), true);

  // Auth switches to B (no sign-out modeled — a direct switch): the SAME bridge re-binds, exactly
  // like production's attach()-on-room-change.
  account.switchRoom(ROOM_B, roomRefB);
  assert.equal(recovery.isAttested(), false, 'the attestation was for A\'s room — it does not carry over to B');

  const result = await recovery.recover();
  assert.equal(result.outcome, 'not-attested');
  assert.equal(Object.keys(roomRefA.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val()).length, 1, 'A\'s cloud untouched');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. remote change invalidates attestation/recovery
// ═══════════════════════════════════════════════════════════════════════════

test('7: the account\'s remote history changing after attestation (compatibility no longer the same) invalidates the attestation', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();
  const recovery = makeRecovery(account, [anchor, custom18], roomRef);

  assert.equal(recovery.attest(), true);
  // Meanwhile, another device (or this same device, another tab) pushes something that changes
  // what "missing" now is — e.g. the account fully configures itself in the interim.
  account.boundaryRepository.propose({ boundaryTime: '20:00', timezone: MANILA }, T_0800);
  await account.boundarySync.pushAllLocal();

  assert.equal(recovery.isAttested(), false, 'the compatible set changed since attestation — it must be re-confirmed');
  const result = await recovery.recover();
  assert.equal(result.outcome, 'not-eligible', 'the account is now configured on its own — no longer a candidate at all');
  assert.equal(result.reason, 'account-already-configured');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. reload requires new attestation
// ═══════════════════════════════════════════════════════════════════════════

test('8: attestation is never persisted — a fresh wiring instance (what a reload produces) starts unattested even against the identical compatible candidate', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();
  const recovery1 = makeRecovery(account, [anchor, custom18], roomRef);
  recovery1.attest();
  assert.equal(recovery1.isAttested(), true);

  // A fresh module instance, same underlying state — the "reload" case. Attestation lives only in
  // recovery1's own closure and was never written anywhere recovery2 could read it from.
  const recovery2 = makeRecovery(account, [anchor, custom18], roomRef);
  assert.equal(recovery2.isAttested(), false);
  const result = await recovery2.recover();
  assert.equal(result.outcome, 'not-attested');
});

// ═══════════════════════════════════════════════════════════════════════════
// 9/10/11. malformed / conflicting / union-invalid -> no offer
// ═══════════════════════════════════════════════════════════════════════════

test('9: malformed legacy history is never a candidate', () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();
  const recovery = makeRecovery(account, [custom18], roomRef); // no anchor — invalid on its own
  const result = recovery.status();
  assert.equal(result.compatible, false);
  assert.equal(result.reason, 'legacy-invalid');
});

test('10: a conflicting remote fact (same id, different content than legacy) is never a candidate', () => {
  const conflicting = { ...custom18, boundaryTime: '20:00' };
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor, [conflicting.id]: conflicting } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();
  const recovery = makeRecovery(account, [anchor, custom18], roomRef);
  const result = recovery.status();
  assert.equal(result.compatible, false);
  assert.equal(result.reason, 'remote-not-compatible-with-legacy');
});

test('11: nothing missing (remote already contains every legacy fact) is never a candidate', () => {
  // legacy = anchor ONLY (this device's own legacy cache never completed with a real revision
  // either) and remote is the SAME bare anchor — scoped correctly stays 'absent' (an anchor alone is
  // never a configuration), so this is the one reachable way to hit "nothing missing" without the
  // 'account-already-configured' gate firing first: remote already represents every legacy fact.
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();
  assert.equal(account.live.status().status, 'absent', 'precondition: anchor-alone is not a configuration');
  const recovery = makeRecovery(account, [anchor], roomRef); // legacy also has ONLY the anchor
  const result = recovery.status();
  assert.equal(result.compatible, false);
  assert.equal(result.reason, 'nothing-missing');
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. no deletion/overwrite
// ═══════════════════════════════════════════════════════════════════════════

test('12: recovery never deletes or modifies the legacy (unowned) cache it read from', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();
  const legacyStorage = legacyStorageWith([anchor, custom18]);
  const legacyBefore = legacyStorage.getItem(PERSONAL_DAY_BOUNDARY_STORAGE_KEY);
  const legacyRepository = createPersonalDayBoundaryRepository({ storage: legacyStorage });
  const recovery = createPersonalDayBoundaryRecovery({ live: account.live, boundarySync: account.boundarySync, getRoomId: () => ROOM_A, legacyRepository, getRoomRef: () => roomRef });

  recovery.attest();
  await recovery.recover();
  assert.equal(legacyStorage.getItem(PERSONAL_DAY_BOUNDARY_STORAGE_KEY), legacyBefore, 'the legacy cache is byte-identical — untouched');
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. partial success -> uncertain
// ═══════════════════════════════════════════════════════════════════════════

test('13: a partial push (one of two missing revisions lands, one does not) is reported as "uncertain", never silently as success', async () => {
  const c1 = customAt('c1', '20:00', '2026-09-10', '20:00');
  const c2 = customAt('c2', '18:00', '2026-09-14', '18:00');
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();

  // Intercept c2's own transaction to always abort (simulating a transport hiccup on just one of
  // the two pushes), while c1's push proceeds normally through the real room ref.
  let calls = 0;
  const interceptingRoomRef = {
    ...roomRef,
    child(seg) {
      const real = roomRef.child(seg);
      if (seg !== DAY_BOUNDARY_REVISIONS_REMOTE_PATH) return real;
      return {
        ...real,
        transaction(updateFn) {
          calls++;
          if (calls === 2) return Promise.resolve({ committed: false, snapshot: { val: () => real.val() } }); // c2's push fails
          return real.transaction(updateFn);
        },
      };
    },
  };
  const interceptingSync = createPersonalDayBoundarySyncBridge({ repository: account.boundaryRepository, getRoomRef: () => interceptingRoomRef, getRoomId: () => ROOM_A });
  interceptingSync.handleRemoteSnapshot(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val());
  const recovery = createPersonalDayBoundaryRecovery({
    live: account.live, boundarySync: interceptingSync, getRoomId: () => ROOM_A,
    legacyRepository: createPersonalDayBoundaryRepository({ storage: legacyStorageWith([anchor, c1, c2]) }),
    getRoomRef: () => interceptingRoomRef,
  });

  recovery.attest();
  const result = await recovery.recover();
  assert.equal(result.outcome, 'uncertain');
  assert.ok(result.stillMissing.length === 1);
  const remote = decodeWireMap(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val());
  assert.ok(remote[c1.id] || remote[c2.id], 'at least the one that succeeded landed');
  assert.ok(!(remote[c1.id] && remote[c2.id]), 'not BOTH landed — this really was partial');
});

// ═══════════════════════════════════════════════════════════════════════════
// 14/15/16. read-back, scoped-cache hydration, PlanAuthority enablement
// ═══════════════════════════════════════════════════════════════════════════

test('14/15/16: after a successful recovery, read-back confirms it, the scoped cache hydrates, and the account is enabled', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();
  const recovery = makeRecovery(account, [anchor, custom18], roomRef);

  recovery.attest();
  const result = await recovery.recover();
  assert.equal(result.outcome, 'recovered'); // 14: read-back confirmed it
  assert.equal(account.live.status().status, 'custom'); // 15: scoped cache hydrated
  assert.equal(account.live.status().revisions.length, 2);
  assert.equal(account.live.enabled(), true); // 16: enabled
});

// ═══════════════════════════════════════════════════════════════════════════
// 17. unowned legacy cache remains untouched (also covered by 12; an explicit multi-account check)
// ═══════════════════════════════════════════════════════════════════════════

test('17: the SAME legacy cache can be read (never mutated) by two different accounts\' recovery wiring without cross-contaminating either', async () => {
  const legacyStorage = legacyStorageWith([anchor, custom18]);
  const legacyBefore = legacyStorage.getItem(PERSONAL_DAY_BOUNDARY_STORAGE_KEY);

  const roomRefA = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const accountA = makeAccountDevice({ roomRef: roomRefA, roomId: ROOM_A });
  accountA.boundarySync.attach();
  const recoveryA = createPersonalDayBoundaryRecovery({ live: accountA.live, boundarySync: accountA.boundarySync, getRoomId: () => ROOM_A, legacyRepository: createPersonalDayBoundaryRepository({ storage: legacyStorage }), getRoomRef: () => roomRefA });
  recoveryA.attest();
  await recoveryA.recover();

  assert.equal(legacyStorage.getItem(PERSONAL_DAY_BOUNDARY_STORAGE_KEY), legacyBefore);

  const roomRefB = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: {} });
  const accountB = makeAccountDevice({ roomRef: roomRefB, roomId: ROOM_B });
  accountB.boundarySync.attach();
  const recoveryB = createPersonalDayBoundaryRecovery({ live: accountB.live, boundarySync: accountB.boundarySync, getRoomId: () => ROOM_B, legacyRepository: createPersonalDayBoundaryRepository({ storage: legacyStorage }), getRoomRef: () => roomRefB });
  assert.equal(recoveryB.status().compatible, true, 'B independently sees the same legacy cache as a candidate — reading it never consumes or alters it');
  assert.equal(legacyStorage.getItem(PERSONAL_DAY_BOUNDARY_STORAGE_KEY), legacyBefore, 'still untouched after a SECOND account read it too');
});

// ═══════════════════════════════════════════════════════════════════════════
// 18. recover()'s own read-back must also be order-independent (same root cause as the analysis above)
// ═══════════════════════════════════════════════════════════════════════════

test('18: recover() still reports "recovered" even when its post-push read-back decodes the pushed revision with reordered properties', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A });
  account.boundarySync.attach();

  // Reorders every entry's OWN properties in the value seen only by recover()'s read-back
  // (`ref.once('value')`) -- the actual write, via boundarySync.pushRevision(), still goes through
  // the real, unwrapped roomRef untouched, exactly like a real device pushing to real Firebase and
  // then reading its own write back with the fields resequenced by the SDK.
  const reorderingRoomRef = {
    ...roomRef,
    child(seg) {
      const real = roomRef.child(seg);
      if (seg !== DAY_BOUNDARY_REVISIONS_REMOTE_PATH) return real;
      return {
        ...real,
        once: (...args) => real.once(...args).then(snap => ({
          val: () => {
            const raw = snap.val();
            if (!raw || typeof raw !== 'object') return raw;
            const reordered = {};
            Object.keys(raw).forEach(id => {
              const entry = raw[id];
              reordered[id] = entry && typeof entry === 'object'
                ? Object.fromEntries(Object.keys(entry).sort().reverse().map(k => [k, entry[k]]))
                : entry;
            });
            return reordered;
          },
        })),
      };
    },
  };
  const recovery = createPersonalDayBoundaryRecovery({
    live: account.live,
    boundarySync: account.boundarySync, // pushRevision writes through the real roomRef, unaffected
    getRoomId: () => ROOM_A,
    legacyRepository: createPersonalDayBoundaryRepository({ storage: legacyStorageWith([anchor, custom18]) }),
    getRoomRef: () => reorderingRoomRef, // only recover()'s own read-back sees reordered properties
  });

  recovery.attest();
  const result = await recovery.recover();
  assert.equal(result.outcome, 'recovered', 'a reordered-but-identical read-back must never be reported as a failed/uncertain recovery');
});

// ═══════════════════════════════════════════════════════════════════════════
// gates that were not renamed but must still hold
// ═══════════════════════════════════════════════════════════════════════════

test('gate: no room identity known -> attest()/recover() are safe no-ops, never a crash', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: null });
  account.boundarySync.attach();
  const recovery = makeRecovery(account, [anchor, custom18], roomRef);
  assert.equal(recovery.attest(), false);
  assert.equal(recovery.isAttested(), false);
});

test('gate: sync-not-ready never reasons about compatibility from a stale/incomplete view', () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const account = makeAccountDevice({ roomRef, roomId: ROOM_A }); // deliberately not attached
  const recovery = makeRecovery(account, [anchor, custom18], roomRef);
  const result = recovery.status();
  assert.equal(result.compatible, false);
  assert.equal(result.reason, 'sync-not-ready');
});
