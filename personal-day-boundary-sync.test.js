import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalDayBoundarySyncBridge, DAY_BOUNDARY_REVISIONS_REMOTE_PATH } from './personal-day-boundary-sync.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { LEGACY_CALENDAR_DAY_REVISION_ID, normalizeBoundaryRevisionHistory } from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';
const T_1800_MANILA = Date.parse('2026-09-14T10:00:00Z'); // an actual occurrence of 18:00 Asia/Manila — must be alignment-valid
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };
let seq = 0;
const seqIds = () => `id-${++seq}`;

// ── minimal fake Firebase Realtime Database room ref ────────────────────────
// Enough of the real SDK's shape to exercise attach/child/on/transaction: a
// shared value tree, path-scoped child refs, and a transaction() that mirrors
// the real semantics this module depends on — returning `undefined` from the
// update function aborts without committing. Deliberately synchronous
// internally (no microtask gap inside transaction()), matching how real
// Firebase serializes concurrent transactions on one path: whichever caller's
// transaction() call is invoked first, in this single-threaded fake, always
// sees a value BEFORE the other's write, and completes before the other's
// update function runs — there is no lost-update race in the fake, exactly
// as there should be none against the real server for one path.
function fakeRoomRef(initial = {}) {
  const root = { value: initial, pendingConcurrentWrites: {} }; // path -> mutator, consumed once
  const listeners = new Map(); // path -> Set<fn>
  function get(path) {
    return path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  }
  function set(path, value) {
    const segs = path.split('/').filter(Boolean);
    if (!segs.length) { root.value = value; fire(''); return; }
    let node = root.value;
    for (let i = 0; i < segs.length - 1; i++) {
      if (typeof node[segs[i]] !== 'object' || node[segs[i]] === null) node[segs[i]] = {};
      node = node[segs[i]];
    }
    node[segs[segs.length - 1]] = value;
    fire(path);
  }
  function fire(path) {
    (listeners.get(path) || []).forEach(fn => fn({ val: () => get(path) ?? null }));
  }
  function makeRef(path) {
    return {
      child(seg) { return makeRef(path ? `${path}/${seg}` : seg); },
      on(_event, fn) {
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(fn);
        fn({ val: () => get(path) ?? null }); // immediate fire, matching real .on('value')
      },
      off() { listeners.delete(path); },
      val: () => get(path) ?? null,
      // Test-only hook modeling Firebase RTDB's documented transaction retry
      // contract: "the update function may be called multiple times, and
      // must be prepared to handle abandoned values." Schedules a REAL write
      // (from another writer) to land at this path the moment this
      // transaction has produced a first candidate result but before it
      // commits — the fake then re-invokes the SAME updateFn against the now-
      // current server value, exactly as production Firebase would, and
      // commits only that retry's result. Consumed exactly once.
      _scheduleConcurrentWriteBeforeCommit(mutateFn) {
        root.pendingConcurrentWrites[path] = mutateFn;
      },
      transaction(updateFn) {
        let current = get(path) ?? null;
        let invocations = 0;
        for (;;) {
          invocations++;
          const next = updateFn(current);
          const pending = root.pendingConcurrentWrites[path];
          if (pending) {
            delete root.pendingConcurrentWrites[path];
            set(path, pending(current)); // another writer's own real, committed write
            current = get(path) ?? null; // the value this transaction must now be re-run against
            continue; // Firebase re-invokes the SAME update function with the fresh value
          }
          if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => current }, invocations });
          set(path, next);
          return Promise.resolve({ committed: true, snapshot: { val: () => next }, invocations });
        }
      },
      update(patch) {
        Object.entries(patch).forEach(([p, v]) => set(p, v));
        return Promise.resolve();
      }
    };
  }
  return makeRef('');
}

// Every device here belongs to the same account: its cache slot is that room's, and it pushes to that room.
const TEST_ROOM = 'uid_test-room';

function makeBridge({ roomRef = fakeRoomRef(), storage = memory(), idGenerator = seqIds, onRemoteChange, onConflict } = {}) {
  const repository = createPersonalDayBoundaryRepository({ storage, idGenerator, getOwner: () => TEST_ROOM });
  const bridge = createPersonalDayBoundarySyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM, onRemoteChange, onConflict });
  return { bridge, repository, roomRef };
}

function remoteMap(roomRef) {
  return roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val() || {};
}

/** §23: the central acceptance check after every concurrency scenario — the
 *  REMOTE store itself, not just local clients, must be a valid history. */
function assertRemoteValid(roomRef, message) {
  const remote = remoteMap(roomRef);
  assert.doesNotThrow(() => normalizeBoundaryRevisionHistory(Object.values(remote)), message);
  return normalizeBoundaryRevisionHistory(Object.values(remote));
}

/** §24: a brand-new device, empty local storage, attaching to whatever the
 *  remote currently holds. For a valid remote, this must always succeed. */
function bootstrapFreshDevice(roomRef) {
  const fresh = makeBridge({ roomRef, storage: memory(), idGenerator: seqIds });
  fresh.bridge.attach();
  return fresh.repository.status();
}

/** Test-only: wraps a room ref so every `.transaction(updateFn)` call made
 *  against `path` is intercepted purely to COUNT how many times the
 *  production `updateFn` itself gets invoked — the counting wrapper adds no
 *  behavior of its own; it delegates every call straight to the real fake's
 *  `.transaction()` (which is what actually implements the retry loop) and
 *  only taps the update function passed through. This proves genuine
 *  multiple invocations of the SAME production callback pushRevision hands
 *  to Firebase, without changing personal-day-boundary-sync.js at all. */
function withInvocationCounter(baseRoomRef, path, counter) {
  return {
    ...baseRoomRef,
    child(seg) {
      const childRef = baseRoomRef.child(seg);
      if (seg !== path) return childRef;
      return { ...childRef, transaction: updateFn => childRef.transaction(value => { counter.count++; return updateFn(value); }) };
    },
  };
}

const anchor = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: null };

// ── single-child push behavior (updated for the collection-level transaction) ─

test('pushRevision writes a new revision into the shared collection map', async () => {
  // Seeded with the anchor already present — matching the real path, where
  // propose() always creates the anchor and a device's first custom revision
  // together; a "genuinely new" push is validated against the FULL resulting
  // history (§1), so a bare custom revision with no anchor anywhere is
  // correctly rejected (see the malformed/incomplete-history tests below).
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const { bridge } = makeBridge({ roomRef });
  const revision = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  const result = await bridge.pushRevision(revision);
  assert.deepEqual(result, { committed: true, outcome: 'committed' });
  assert.deepEqual(remoteMap(roomRef), { [anchor.id]: anchor, r1: revision });
});

test('pushing a custom revision with no anchor anywhere (remote or local) is rejected — an anchor-less history is never valid', async () => {
  const { bridge } = makeBridge(); // empty remote, empty local storage/idGenerator context
  const revision = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  const result = await bridge.pushRevision(revision);
  assert.equal(result.committed, false);
  assert.equal(result.outcome, 'conflict');
});

test('pushRevision is a no-op skip when disconnected', async () => {
  const { bridge } = makeBridge({ roomRef: null });
  assert.deepEqual(await bridge.pushRevision({ id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: 1 }), { committed: false, outcome: 'skipped' });
});

test('same id, conflicting facts: second write is rejected, remote unchanged, third device still bootstraps', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const revision = { id: 'shared-id', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  const conflicting = { ...revision, boundaryTime: '16:00' };
  const bridgeA = makeBridge({ roomRef }).bridge;
  const bridgeB = makeBridge({ roomRef }).bridge;
  assert.deepEqual(await bridgeA.pushRevision(revision), { committed: true, outcome: 'committed' });
  assert.deepEqual(await bridgeB.pushRevision(conflicting), { committed: false, outcome: 'conflict' });
  assert.deepEqual(remoteMap(roomRef), { [anchor.id]: anchor, 'shared-id': revision }); // never overwritten
  assertRemoteValid(roomRef);
  assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 2);
});

test('same id, same facts, pushed twice: idempotent', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const revision = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  const bridge = makeBridge({ roomRef }).bridge;
  assert.deepEqual(await bridge.pushRevision(revision), { committed: true, outcome: 'committed' });
  assert.deepEqual(await bridge.pushRevision(revision), { committed: true, outcome: 'idempotent' });
});

test('attach() merges an existing remote history into local storage on first snapshot', () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor, r1: { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: Date.parse('2026-09-14T10:00:00Z') } } });
  const changes = [];
  const { bridge, repository } = makeBridge({ roomRef, onRemoteChange: r => changes.push(r) });
  bridge.attach();
  assert.equal(changes.length, 1);
  assert.equal(repository.status().status, 'custom');
  assert.equal(repository.status().revisions.length, 2);
});

test('attach() then local propose(): pushAllLocal bootstrap replicates a locally-created revision to a fresh remote', () => {
  const roomRef = fakeRoomRef(); // empty remote
  const { bridge, repository } = makeBridge({ roomRef });
  repository.propose({ boundaryTime: '18:00', timezone: MANILA }, Date.parse('2026-09-14T00:30:00Z'));
  bridge.attach(); // first snapshot is empty -> bootstrap pushes local revisions up
  assert.equal(Object.keys(remoteMap(roomRef)).length, 2); // anchor + the 18:00 revision
  assertRemoteValid(roomRef);
});

test('two devices proposing different revisions offline both survive once both attach (order-independent merge)', () => {
  const roomRef = fakeRoomRef();
  const deviceA = makeBridge({ roomRef, storage: memory() });
  const deviceB = makeBridge({ roomRef: fakeRoomRef(), storage: memory() }); // separate room ref simulates "not yet synced"
  deviceA.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, Date.parse('2026-09-14T00:30:00Z'));
  deviceB.repository.propose({ boundaryTime: '16:00', timezone: MANILA }, Date.parse('2026-09-20T00:30:00Z'));
  const sharedRoomRef = roomRef;
  const bridgeA = createPersonalDayBoundarySyncBridge({ repository: deviceA.repository, getRoomRef: () => sharedRoomRef, getRoomId: () => TEST_ROOM });
  const bridgeB = createPersonalDayBoundarySyncBridge({ repository: deviceB.repository, getRoomRef: () => sharedRoomRef, getRoomId: () => TEST_ROOM });
  bridgeA.attach();
  bridgeB.attach();
  bridgeA.handleRemoteSnapshot(sharedRoomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val());
  assert.equal(deviceA.repository.status().revisions.length, 3); // anchor + A's + B's
  assert.equal(deviceB.repository.status().revisions.length, 3);
  assertRemoteValid(sharedRoomRef);
  assert.equal(bootstrapFreshDevice(sharedRoomRef).revisions.length, 3);
});

test('onConflict fires when a remote revision conflicts with a local one, and local truth is untouched', () => {
  const roomRef = fakeRoomRef();
  const { bridge, repository } = makeBridge({ roomRef });
  const { revision: local } = repository.propose({ boundaryTime: '18:00', timezone: MANILA }, Date.parse('2026-09-14T00:30:00Z'));
  const conflicts = [];
  const bridgeWithHandler = createPersonalDayBoundarySyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM, onConflict: r => conflicts.push(r) });
  bridgeWithHandler.handleRemoteSnapshot({ [local.id]: { ...local, boundaryTime: '17:00' } });
  assert.equal(conflicts.length, 1);
  assert.equal(repository.status().revisions.find(r => r.id === local.id).boundaryTime, '18:00');
});

test('detach() stops listening and resets bootstrap/snapshot state', () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const { bridge, repository } = makeBridge({ roomRef });
  bridge.attach();
  assert.equal(repository.status().status, 'custom');
  bridge.detach();
  roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).update({ ghost: { id: 'ghost', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: 999 } });
  assert.equal(repository.status().revisions.length, 1); // unchanged — no listener was firing
});

// ── THE former blocker, reproduced and fixed (§9, §21) ─────────────────────
// Two fresh devices independently propose the SAME 18:00 Manila boundary at
// the SAME reference instant. Their locally-generated ids differ (that is
// the whole point — nobody coordinates id generation). Before this fix, two
// independent per-child Firebase transactions both saw "my key is free" and
// both committed, leaving two ids sharing one effectiveFromInstant in the
// shared remote map — an invalid history no client, including a brand new
// one, could ever bootstrap from again.

function proposeIdenticalOnTwoFreshDevices() {
  const roomRef = fakeRoomRef();
  const now = Date.parse('2026-09-14T00:30:00Z'); // Monday 08:30 Manila
  const deviceA = makeBridge({ roomRef, storage: memory(), idGenerator: () => 'device-a-generated-id' });
  const deviceB = makeBridge({ roomRef, storage: memory(), idGenerator: () => 'device-b-generated-id' });
  deviceA.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, now);
  deviceB.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, now);
  return { roomRef, deviceA, deviceB, now };
}

test('same proposal, same instant, two fresh devices, A pushes first: converges to ONE canonical revision', async () => {
  const { roomRef, deviceA, deviceB } = proposeIdenticalOnTwoFreshDevices();
  const bridgeA = createPersonalDayBoundarySyncBridge({ repository: deviceA.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  const bridgeB = createPersonalDayBoundarySyncBridge({ repository: deviceB.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });

  await bridgeA.pushAllLocal({}); // A's anchor + A's 18:00 revision land first
  await bridgeB.pushAllLocal(remoteMap(roomRef)); // B observes A's state, then attempts its own

  const remote = assertRemoteValid(roomRef);
  const custom = remote.filter(r => r.effectiveFromInstant !== null);
  assert.equal(custom.length, 1); // exactly one surviving custom revision, never two
  assert.equal(custom[0].id, 'device-a-generated-id'); // deterministic winner: lexicographically smaller id

  bridgeB.handleRemoteSnapshot(remoteMap(roomRef)); // B reconciles its own local identity
  assert.equal(deviceA.repository.status().revisions.length, 2);
  assert.equal(deviceB.repository.status().revisions.length, 2);
  assert.equal(deviceA.repository.status().revisions.find(r => r.effectiveFromInstant !== null).id, 'device-a-generated-id');
  assert.equal(deviceB.repository.status().revisions.find(r => r.effectiveFromInstant !== null).id, 'device-a-generated-id');
  assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 2);
});

test('same proposal, same instant, two fresh devices, B pushes first (REVERSED order): same canonical winner', async () => {
  const { roomRef, deviceA, deviceB } = proposeIdenticalOnTwoFreshDevices();
  const bridgeA = createPersonalDayBoundarySyncBridge({ repository: deviceA.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  const bridgeB = createPersonalDayBoundarySyncBridge({ repository: deviceB.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });

  await bridgeB.pushAllLocal({}); // B commits first this time
  await bridgeA.pushAllLocal(remoteMap(roomRef)); // A's push must WIN and re-canonicalize to its own (smaller) id

  const remote = assertRemoteValid(roomRef);
  const custom = remote.filter(r => r.effectiveFromInstant !== null);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].id, 'device-a-generated-id'); // same winner as the non-reversed case — order-independent

  bridgeA.handleRemoteSnapshot(remoteMap(roomRef));
  bridgeB.handleRemoteSnapshot(remoteMap(roomRef));
  assert.equal(deviceA.repository.status().revisions.find(r => r.effectiveFromInstant !== null).id, 'device-a-generated-id');
  assert.equal(deviceB.repository.status().revisions.find(r => r.effectiveFromInstant !== null).id, 'device-a-generated-id');
  assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 2);
});

test('same proposal, same instant, TRULY interleaved concurrent pushRevision calls (Promise.all): still converges', async () => {
  const { roomRef, deviceA, deviceB } = proposeIdenticalOnTwoFreshDevices();
  const bridgeA = createPersonalDayBoundarySyncBridge({ repository: deviceA.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  const bridgeB = createPersonalDayBoundarySyncBridge({ repository: deviceB.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  const [customA] = deviceA.repository.listAllRaw().filter(r => r.effectiveFromInstant !== null);
  const [customB] = deviceB.repository.listAllRaw().filter(r => r.effectiveFromInstant !== null);

  // Both devices race their custom-revision push directly (anchors pushed
  // via a prior settled call, isolating the exact race the reviewer found).
  await Promise.all([bridgeA.pushRevision(deviceA.repository.listAllRaw().find(r => r.effectiveFromInstant === null)), bridgeB.pushRevision(deviceB.repository.listAllRaw().find(r => r.effectiveFromInstant === null))]);
  const [resultA, resultB] = await Promise.all([bridgeA.pushRevision(customA), bridgeB.pushRevision(customB)]);
  assert.ok([resultA.committed, resultB.committed].some(Boolean)); // at least one side made progress
  const remote = assertRemoteValid(roomRef);
  assert.equal(remote.filter(r => r.effectiveFromInstant !== null).length, 1); // never two
  assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 2);
});

// ── conflicting proposal, same effective instant, DIFFERENT facts (§6, §9) ──

// Note: repository.propose() computes effectiveFromInstant as "the next
// occurrence of the CANDIDATE'S OWN boundary time from now" (the foundation
// model's nextBoundaryInstant) — so two propose() calls with genuinely
// different boundaryTime values naturally land on DIFFERENT instants, not
// the same one. The "different facts, same effective instant" attack can
// only be constructed directly (hand-built revision objects sharing one
// instant), exactly like personal-day-boundary-repository.test.js's own
// "writes nothing when the union would collide" test already does.

// Both revisions below must independently pass the "effectiveFromInstant
// aligns to this revision's own boundaryTime" invariant (introduced in the
// prior bounded fix) to even be individually valid — so two DIFFERENT
// boundaryTime values in the SAME timezone can never legitimately share one
// instant. The realizable "different facts, same effective instant"
// contradiction is two revisions with different (boundaryTime, timezone)
// pairs that each independently read as valid local times at the SAME
// absolute instant — e.g. 2026-09-14T10:00:00Z reads as 18:00 in
// Asia/Manila AND 06:00 in America/New_York.
const NY = 'America/New_York';

test('conflicting facts at the same effective instant: rejected, remote unchanged, third device still bootstraps', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const revisionA = { id: 'device-a', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  const revisionB = { id: 'device-b', boundaryTime: '06:00', timezone: NY, effectiveFromInstant: T_1800_MANILA }; // different fact, same T
  const bridgeA = makeBridge({ roomRef }).bridge;
  const bridgeB = makeBridge({ roomRef }).bridge;

  assert.deepEqual(await bridgeA.pushRevision(revisionA), { committed: true, outcome: 'committed' });
  const before = { ...remoteMap(roomRef) };
  assert.deepEqual(await bridgeB.pushRevision(revisionB), { committed: false, outcome: 'conflict' });
  assert.deepEqual(remoteMap(roomRef), before); // byte-for-byte unchanged — no poisoned remote, no partial write
  assertRemoteValid(roomRef);
  assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 2); // A's history intact and bootstrappable
});

test('reversed order: conflicting facts at the same effective instant still reject symmetrically', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const revisionA = { id: 'device-a', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  const revisionB = { id: 'device-b', boundaryTime: '06:00', timezone: NY, effectiveFromInstant: T_1800_MANILA };
  const bridgeA = makeBridge({ roomRef }).bridge;
  const bridgeB = makeBridge({ roomRef }).bridge;

  assert.deepEqual(await bridgeB.pushRevision(revisionB), { committed: true, outcome: 'committed' }); // B commits first this time
  const before = { ...remoteMap(roomRef) };
  assert.deepEqual(await bridgeA.pushRevision(revisionA), { committed: false, outcome: 'conflict' });
  assert.deepEqual(remoteMap(roomRef), before);
  assertRemoteValid(roomRef);
  assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 2); // B's history intact
});

// ── anchor concurrency (§7) ──────────────────────────────────────────────

test('two fresh devices both initialize an identical anchor: idempotent, exactly one anchor survives', async () => {
  const roomRef = fakeRoomRef();
  const deviceA = makeBridge({ roomRef, storage: memory() });
  const deviceB = makeBridge({ roomRef, storage: memory() });
  const anchorA = deviceA.repository.read(MANILA)[0]; // ephemeral synthesis, not yet persisted
  const anchorB = deviceB.repository.read(MANILA)[0];
  const bridgeA = createPersonalDayBoundarySyncBridge({ repository: deviceA.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  const bridgeB = createPersonalDayBoundarySyncBridge({ repository: deviceB.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  assert.deepEqual(await bridgeA.pushRevision(anchorA), { committed: true, outcome: 'committed' });
  assert.deepEqual(await bridgeB.pushRevision(anchorB), { committed: true, outcome: 'idempotent' });
  const remote = assertRemoteValid(roomRef);
  assert.equal(remote.filter(r => r.effectiveFromInstant === null).length, 1);
});

test('a malformed/conflicting anchor at the reserved id fails safely without corrupting an existing valid anchor', async () => {
  const roomRef = fakeRoomRef();
  const bridgeA = makeBridge({ roomRef }).bridge;
  assert.deepEqual(await bridgeA.pushRevision(anchor), { committed: true, outcome: 'committed' });
  const conflictingAnchor = { ...anchor, timezone: 'America/New_York' }; // same reserved id, different fact
  const bridgeB = makeBridge({ roomRef }).bridge;
  assert.deepEqual(await bridgeB.pushRevision(conflictingAnchor), { committed: false, outcome: 'conflict' });
  assert.deepEqual(remoteMap(roomRef), { [anchor.id]: anchor });
  assertRemoteValid(roomRef);
  assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 1);
});

// ── whole-history transaction behavior matrix (§8) ─────────────────────────

test('empty remote: pushing local anchor + revision produces a valid history', async () => {
  const roomRef = fakeRoomRef();
  const { bridge } = makeBridge({ roomRef });
  bridge.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, Date.parse('2026-09-14T00:30:00Z'));
  await bridge.pushAllLocal({});
  assert.equal(assertRemoteValid(roomRef).length, 2);
});

test('remote has anchor only: pushing the first custom revision produces anchor + revision', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const { bridge, repository } = makeBridge({ roomRef });
  bridge.attach();
  repository.propose({ boundaryTime: '18:00', timezone: MANILA }, Date.parse('2026-09-14T00:30:00Z'));
  await bridge.pushAllLocal(remoteMap(roomRef));
  assert.equal(assertRemoteValid(roomRef).length, 2);
});

test('remote has older revisions: pushing a valid new later revision produces the union', async () => {
  const r1 = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: Date.parse('2026-09-14T10:00:00Z') };
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor, r1 } });
  const { bridge } = makeBridge({ roomRef });
  const r2 = { id: 'r2', boundaryTime: '16:00', timezone: MANILA, effectiveFromInstant: Date.parse('2026-09-21T08:00:00Z') };
  const result = await bridge.pushRevision(r2);
  assert.equal(result.outcome, 'committed');
  assert.equal(assertRemoteValid(roomRef).length, 3);
});

test('duplicate local push: no-op idempotent success', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const { bridge } = makeBridge({ roomRef });
  const r1 = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  await bridge.pushRevision(r1);
  const second = await bridge.pushRevision(r1);
  assert.equal(second.outcome, 'idempotent');
  assert.equal(assertRemoteValid(roomRef).length, 2);
});

// same id / same facts and same id / different facts are covered above
// ('duplicate local push', 'same id, conflicting facts...').
// different id / same effective instant / same facts (dedup) and
// different id / same effective instant / different facts (conflict) are
// covered above by the former-blocker and conflicting-facts test blocks.

// ── never poison remote on conflict (§9) — malformed remote ────────────────

test('a malformed remote history is neither overwritten nor treated as empty', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { bad1: { id: 'bad1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null }, bad2: { id: 'bad2', boundaryTime: '16:00', timezone: MANILA, effectiveFromInstant: null } } }); // two anchors — already invalid
  const { bridge } = makeBridge({ roomRef });
  const before = { ...remoteMap(roomRef) };
  const result = await bridge.pushRevision({ id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA });
  assert.equal(result.outcome, 'malformed-remote');
  assert.deepEqual(remoteMap(roomRef), before); // untouched — never blindly overwritten, never treated as empty
});

// ── offline/stale reconnect (§12) ───────────────────────────────────────────

test('stale reconnect: device B (anchor+R1 only) proposing R3 preserves A\'s R1 and R2', async () => {
  const roomRef = fakeRoomRef();
  let idCounter = 0;
  const deviceA = makeBridge({ roomRef, storage: memory(), idGenerator: () => `r${++idCounter}` });
  deviceA.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, Date.parse('2026-09-14T00:30:00Z')); // -> r1
  const bridgeA = createPersonalDayBoundarySyncBridge({ repository: deviceA.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  await bridgeA.pushAllLocal({});
  const { revision: r2 } = deviceA.repository.propose({ boundaryTime: '16:00', timezone: MANILA }, Date.parse('2026-09-21T00:30:00Z')); // -> r2
  await bridgeA.pushRevision(r2);
  assert.equal(assertRemoteValid(roomRef).length, 3); // anchor + R1 + R2

  // Device B was offline with only anchor + R1 (simulate by attaching before R2 existed).
  const deviceB = makeBridge({ roomRef: fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor, r1: deviceA.repository.listAllRaw().find(r => r.id === 'r1') } }), storage: memory(), idGenerator: () => 'r3' });
  deviceB.bridge.attach();
  assert.equal(deviceB.repository.status().revisions.length, 2); // anchor + R1 only, offline view

  // B reconnects to the REAL shared remote (which now also has R2) and proposes R3.
  const bridgeBOnline = createPersonalDayBoundarySyncBridge({ repository: deviceB.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  bridgeBOnline.handleRemoteSnapshot(remoteMap(roomRef)); // reconnect merges in R2 first
  assert.equal(deviceB.repository.status().revisions.length, 3);
  const { revision: r3 } = deviceB.repository.propose({ boundaryTime: '20:00', timezone: MANILA }, Date.parse('2026-10-01T00:30:00Z'));
  const pushResult = await bridgeBOnline.pushRevision(r3);
  assert.equal(pushResult.outcome, 'committed');

  const remote = assertRemoteValid(roomRef);
  assert.equal(remote.length, 4); // anchor + R1 + R2 + R3, no stale overwrite
  bridgeA.handleRemoteSnapshot(remoteMap(roomRef));
  assert.equal(deviceA.repository.status().revisions.length, 4); // A adopts the complete canonical history
  assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 4);
});

// ── timezone alias cross-runtime interaction (§13) — deferred, not solved ──

test('same effective instant + same boundary time but a DIFFERENT persisted timezone string: rejected as a conflict, never a false dedup', async () => {
  // Simulates two runtimes canonicalizing the same alias differently — this
  // module does not (and must not) guess cross-runtime timezone equivalence
  // (§13). A genuinely different persisted `timezone` string, even with an
  // identical boundaryTime and effectiveFromInstant, must never be treated
  // as a semantic duplicate — that would be silent identity/fact rewriting.
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const t = Date.parse('2026-09-14T10:00:00Z');
  const revisionManila = { id: 'device-a', boundaryTime: '18:00', timezone: 'Asia/Manila', effectiveFromInstant: t };
  const revisionDifferentZone = { id: 'device-b', boundaryTime: '18:00', timezone: 'Pacific/Guam', effectiveFromInstant: t };
  const bridgeA = makeBridge({ roomRef }).bridge;
  const bridgeB = makeBridge({ roomRef }).bridge;
  assert.deepEqual(await bridgeA.pushRevision(revisionManila), { committed: true, outcome: 'committed' });
  assert.deepEqual(await bridgeB.pushRevision(revisionDifferentZone), { committed: false, outcome: 'conflict' });
  assert.deepEqual(remoteMap(roomRef), { [anchor.id]: anchor, 'device-a': revisionManila }); // safer failure mode: reject, never guess equivalence
  assertRemoteValid(roomRef);
});

// ── stress: repeated randomized-order concurrency (§22) ────────────────────

test('stress: repeated same-proposal races under varied call order always converge to the same canonical id', async () => {
  for (let trial = 0; trial < 8; trial++) {
    const roomRef = fakeRoomRef();
    const now = Date.parse('2026-09-14T00:30:00Z');
    const idA = `trial-${trial}-a`, idB = `trial-${trial}-b`;
    const deviceA = makeBridge({ roomRef, storage: memory(), idGenerator: () => idA });
    const deviceB = makeBridge({ roomRef, storage: memory(), idGenerator: () => idB });
    deviceA.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, now);
    deviceB.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, now);
    const bridgeA = createPersonalDayBoundarySyncBridge({ repository: deviceA.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
    const bridgeB = createPersonalDayBoundarySyncBridge({ repository: deviceB.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
    const order = trial % 2 === 0
      ? [() => bridgeA.pushAllLocal({}), () => bridgeB.pushAllLocal(remoteMap(roomRef))]
      : [() => bridgeB.pushAllLocal({}), () => bridgeA.pushAllLocal(remoteMap(roomRef))];
    // eslint-disable-next-line no-await-in-loop
    await order[0]();
    // eslint-disable-next-line no-await-in-loop
    await order[1]();
    const remote = assertRemoteValid(roomRef, `trial ${trial}`);
    const custom = remote.filter(r => r.effectiveFromInstant !== null);
    assert.equal(custom.length, 1, `trial ${trial}: exactly one custom revision`);
    assert.equal(custom[0].id, idA < idB ? idA : idB, `trial ${trial}: deterministic winner`);
    assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 2, `trial ${trial}: fresh device bootstraps`);
  }
});

// ── FIX-FIRST gap 1: genuine transaction retry fidelity ────────────────────
// Firebase RTDB's documented contract: "the update function may be called
// multiple times, and must be prepared to handle abandoned values." The
// previous version of this suite only ever invoked pushRevision's update
// callback once per push — never proving correctness holds when the SAME
// callback is re-run against a value that changed underneath it. These
// tests use `_scheduleConcurrentWriteBeforeCommit` (a minimal, explicit
// addition to the test-only fake room ref above) to force a real second
// invocation of the exact production callback personal-day-boundary-sync.js
// hands to `.transaction()`, and assert against the SECOND invocation's
// decision, never the first's.

test('retry fidelity: a concurrent unrelated revision landing mid-transaction is preserved, and the candidate still merges', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const invocationCounter = { count: 0 };
  const countingRoomRef = withInvocationCounter(roomRef, DAY_BOUNDARY_REVISIONS_REMOTE_PATH, invocationCounter);
  const { bridge } = makeBridge({ roomRef: countingRoomRef });

  const candidate = { id: 'my-revision', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  const concurrentlyAddedByAnotherDevice = { id: 'concurrent-writer', boundaryTime: '20:00', timezone: MANILA, effectiveFromInstant: Date.parse('2026-09-20T12:00:00Z') }; // aligned to 20:00 Manila

  // Invocation 1 sees ONLY the anchor (stale). Before this transaction
  // commits, another device's own real write lands — invocation 2 must see
  // that write and decide against it, not against the stale invocation-1 view.
  roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH)
    ._scheduleConcurrentWriteBeforeCommit(staleValue => ({ ...staleValue, [concurrentlyAddedByAnotherDevice.id]: concurrentlyAddedByAnotherDevice }));

  const result = await bridge.pushRevision(candidate);

  assert.equal(invocationCounter.count, 2, 'the production update callback must genuinely run twice');
  assert.deepEqual(result, { committed: true, outcome: 'committed' });
  const remote = assertRemoteValid(roomRef);
  assert.equal(remote.length, 3, 'anchor + the concurrent revision + the candidate — nothing lost');
  assert.ok(remote.some(r => r.id === concurrentlyAddedByAnotherDevice.id), 'the concurrent revision from invocation 2\'s fresh read is preserved');
  assert.ok(remote.some(r => r.id === candidate.id), 'the candidate itself is still merged in');
  assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 3);
});

test('retry fidelity, adversarial: a fresh retry value introducing a semantic duplicate flips the decision from committed to deduplicated', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const invocationCounter = { count: 0 };
  const countingRoomRef = withInvocationCounter(roomRef, DAY_BOUNDARY_REVISIONS_REMOTE_PATH, invocationCounter);
  const { bridge } = makeBridge({ roomRef: countingRoomRef });

  // Against the STALE (anchor-only) view, this candidate looks like a
  // brand-new, uncontested fact — invocation 1 would decide 'committed'.
  const candidate = { id: 'zzz-my-id', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  // The fresh retry value contains ANOTHER device's semantically-identical
  // revision under a lexicographically SMALLER id — already canonical.
  const canonical = { id: 'aaa-already-canonical', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH)
    ._scheduleConcurrentWriteBeforeCommit(staleValue => ({ ...staleValue, [canonical.id]: canonical }));

  const result = await bridge.pushRevision(candidate);

  assert.equal(invocationCounter.count, 2);
  // The COMMITTED result reflects invocation 2's decision (deduplicated),
  // never invocation 1's stale 'committed' guess.
  assert.deepEqual(result, { committed: true, outcome: 'deduplicated' });
  const remote = assertRemoteValid(roomRef);
  assert.deepEqual(remote.map(r => r.id).sort(), [anchor.id, canonical.id].sort());
  assert.ok(!remote.some(r => r.id === candidate.id), 'the stale invocation\'s own id was never written');
  assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 2);
});

test('retry fidelity, adversarial: a fresh retry value introducing a contradiction flips the decision from committed to conflict, never poisoning remote', async () => {
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor } });
  const invocationCounter = { count: 0 };
  const countingRoomRef = withInvocationCounter(roomRef, DAY_BOUNDARY_REVISIONS_REMOTE_PATH, invocationCounter);
  const { bridge } = makeBridge({ roomRef: countingRoomRef });

  const candidate = { id: 'device-a', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  // Same absolute instant, genuinely different facts (America/New_York 06:00
  // == Asia/Manila 18:00 at this exact instant) — a real contradiction.
  const contradicting = { id: 'device-b', boundaryTime: '06:00', timezone: 'America/New_York', effectiveFromInstant: T_1800_MANILA };
  roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH)
    ._scheduleConcurrentWriteBeforeCommit(staleValue => ({ ...staleValue, [contradicting.id]: contradicting }));

  const result = await bridge.pushRevision(candidate);

  assert.equal(invocationCounter.count, 2);
  assert.deepEqual(result, { committed: false, outcome: 'conflict' });
  // Remote reflects exactly what the concurrent write (invocation 2's fresh
  // read) committed — the rejected candidate never got written, and the
  // stale invocation-1 "this looks committable" guess never took effect.
  assert.deepEqual(remoteMap(roomRef), { [anchor.id]: anchor, [contradicting.id]: contradicting });
  assertRemoteValid(roomRef);
  assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 2);
});

// ── FIX-FIRST gap 2: reconciliation through the real attach()/.on('value') listener ─
// Proves the deduplication -> local-identity-reconciliation path works end to
// end through the SAME registered listener a live app would use, never via a
// manual handleRemoteSnapshot() call standing in for it.

test('listener-driven reconciliation: attach()\'s own registered .on(\'value\') listener reconciles a losing local id after a later canonicalizing write', () => {
  const roomRef = fakeRoomRef();
  const now = T_1800_MANILA;

  // Device B creates its own local proposal OFFLINE (no attach yet, so its
  // propose() has no knowledge of any other device) and attaches FIRST,
  // while remote is still empty — its own bootstrap push succeeds outright.
  const deviceB = makeBridge({ roomRef, storage: memory(), idGenerator: () => 'zzz-losing' });
  deviceB.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, now);
  const bridgeB = createPersonalDayBoundarySyncBridge({ repository: deviceB.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  const remoteChangesSeenByB = [];
  const listeningBridgeB = createPersonalDayBoundarySyncBridge({ repository: deviceB.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM, onRemoteChange: r => remoteChangesSeenByB.push(r) });
  listeningBridgeB.attach(); // registers the REAL .on('value') listener and bootstrap-pushes B's own {anchor, zzz-losing}
  assert.deepEqual(remoteMap(roomRef)[LEGACY_CALENDAR_DAY_REVISION_ID] ? Object.keys(remoteMap(roomRef)).sort() : [], [LEGACY_CALENDAR_DAY_REVISION_ID, 'zzz-losing'].sort());

  // Device A independently proposes the identical fact under a
  // lexicographically SMALLER id and pushes directly — its own transaction
  // sees B's zzz-losing already remote, recognizes the semantic duplicate,
  // and since A's id wins, CANONICALIZES: deletes zzz-losing, adds aaa-canonical.
  const deviceA = makeBridge({ roomRef, storage: memory(), idGenerator: () => 'aaa-canonical' });
  deviceA.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, now);
  const bridgeA = createPersonalDayBoundarySyncBridge({ repository: deviceA.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  return bridgeA.pushRevision(deviceA.repository.listAllRaw().find(r => r.effectiveFromInstant !== null)).then(async result => {
    assert.equal(result.outcome, 'canonicalized');
    assert.deepEqual(Object.keys(remoteMap(roomRef)).sort(), [LEGACY_CALENDAR_DAY_REVISION_ID, 'aaa-canonical'].sort());

    // The assertion that matters: B never called handleRemoteSnapshot()
    // itself here — A's canonicalizing write's own fire() reached B's
    // listener (registered by attach() above) automatically, and THAT is
    // what must have already reconciled B's local repository by this point.
    assert.ok(remoteChangesSeenByB.length >= 1, 'B\'s registered listener observed the change');
    const bStatus = deviceB.repository.status();
    assert.equal(bStatus.revisions.length, 2);
    assert.ok(bStatus.revisions.some(r => r.id === 'aaa-canonical'), 'B adopted the canonical id via its own live listener');
    assert.ok(!bStatus.revisions.some(r => r.id === 'zzz-losing'), 'B\'s losing id is gone — no split brain');

    // Additionally, B independently re-attempting to push its now-stale
    // losing-id revision object gets the literal 'deduplicated' outcome
    // string (the explicit result a caller — not just the listener path —
    // would see for this exact situation).
    const staleZzz = { id: 'zzz-losing', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: now };
    const staleReplayResult = await bridgeB.pushRevision(staleZzz);
    assert.deepEqual(staleReplayResult, { committed: true, outcome: 'deduplicated' });

    assertRemoteValid(roomRef);
    assert.equal(bootstrapFreshDevice(roomRef).revisions.length, 2);

    // Explicit detach()/re-attach() + a repeated identical listener firing:
    // reconciliation must not oscillate. Once dropped, 'zzz-losing' is not a
    // key remote holds anymore, so nothing a listener re-observes can bring
    // it back — proven directly, not just inferred from the merge algorithm.
    listeningBridgeB.detach();
    listeningBridgeB.attach(); // immediate re-fire on attach(), same remote state
    let bStatusAfterReattach = deviceB.repository.status();
    assert.equal(bStatusAfterReattach.revisions.length, 2);
    assert.ok(!bStatusAfterReattach.revisions.some(r => r.id === 'zzz-losing'), 'reattach does not resurrect the losing id');
    assert.ok(bStatusAfterReattach.revisions.some(r => r.id === 'aaa-canonical'));

    // Firing the SAME snapshot again (simulating a redundant reconnect
    // notification) repeatedly must also be a stable no-op, never an
    // oscillation back to the losing id.
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      listeningBridgeB.handleRemoteSnapshot(remoteMap(roomRef));
    }
    bStatusAfterReattach = deviceB.repository.status();
    assert.equal(bStatusAfterReattach.revisions.length, 2);
    assert.ok(bStatusAfterReattach.revisions.some(r => r.id === 'aaa-canonical'));
    assert.ok(!bStatusAfterReattach.revisions.some(r => r.id === 'zzz-losing'));
  });
});

// ── Live Wiring V1, item 1: transaction-outcome hardening ────────────────────
//
// The three "retry fidelity" tests above all move from a STALE invocation that
// would have decided 'committed' to a FRESH invocation that decides something
// else — and those passed even before this fix, because every non-committed
// branch assigns `outcome` explicitly. The un-covered direction is the mirror
// image: an earlier, ABANDONED invocation assigns a label ('idempotent',
// 'deduplicated', 'canonicalized'), and a later invocation reaches the
// "genuinely new fact" branch, which used to rely on the OUTER
// `let outcome = 'committed'` initial value still being untouched. Because the
// variable lived in the shared closure rather than being re-initialized per
// invocation, the stale label leaked out to the caller as the outcome of a
// write that was actually a plain new commit.

test('outcome hardening: a stale "deduplicated" invocation never leaks its label onto a later invocation that genuinely commits', async () => {
  const semanticTwin = { id: 'aaa-remote-twin', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor, [semanticTwin.id]: semanticTwin } });
  const invocationCounter = { count: 0 };
  const countingRoomRef = withInvocationCounter(roomRef, DAY_BOUNDARY_REVISIONS_REMOTE_PATH, invocationCounter);
  const { bridge } = makeBridge({ roomRef: countingRoomRef });

  // Invocation 1 sees the remote twin (same facts, lexicographically smaller
  // id, therefore already canonical) and decides 'deduplicated'.
  const candidate = { id: 'zzz-mine', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };

  // Before that no-op commit lands, another client writes a repaired/restored
  // history at this path that no longer contains the twin at all (RTDB allows
  // any room client to write the path; a restore-from-backup is the concrete
  // case). Firebase re-invokes the SAME update function against that fresh
  // value, where the candidate is now a genuinely new, uncontested fact.
  roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH)
    ._scheduleConcurrentWriteBeforeCommit(() => ({ [anchor.id]: anchor }));

  const result = await bridge.pushRevision(candidate);

  assert.equal(invocationCounter.count, 2, 'the production update callback must genuinely run twice');
  // The LAST invocation's actual branch is "genuinely new fact, committed".
  // Reporting 'deduplicated' here would tell the caller nothing was written
  // while a real new revision had in fact just been committed.
  assert.deepEqual(result, { committed: true, outcome: 'committed' });
  const remote = assertRemoteValid(roomRef);
  assert.deepEqual(remote.map(r => r.id).sort(), [anchor.id, candidate.id].sort());
});

test('outcome hardening: a stale "idempotent" invocation never leaks its label onto a later invocation that genuinely commits', async () => {
  const candidate = { id: 'my-revision', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor, [candidate.id]: candidate } });
  const invocationCounter = { count: 0 };
  const countingRoomRef = withInvocationCounter(roomRef, DAY_BOUNDARY_REVISIONS_REMOTE_PATH, invocationCounter);
  const { bridge } = makeBridge({ roomRef: countingRoomRef });

  // Invocation 1: remote already holds this exact id+facts -> 'idempotent'.
  // Then another client replaces the path with a history that lost it.
  roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH)
    ._scheduleConcurrentWriteBeforeCommit(() => ({ [anchor.id]: anchor }));

  const result = await bridge.pushRevision(candidate);

  assert.equal(invocationCounter.count, 2);
  assert.deepEqual(result, { committed: true, outcome: 'committed' });
  assert.deepEqual(assertRemoteValid(roomRef).map(r => r.id).sort(), [anchor.id, candidate.id].sort());
});

test('outcome hardening: a stale "canonicalized" invocation never leaks its label onto a later invocation that genuinely commits', async () => {
  const losingTwin = { id: 'zzz-remote-loser', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  const roomRef = fakeRoomRef({ [DAY_BOUNDARY_REVISIONS_REMOTE_PATH]: { [anchor.id]: anchor, [losingTwin.id]: losingTwin } });
  const invocationCounter = { count: 0 };
  const countingRoomRef = withInvocationCounter(roomRef, DAY_BOUNDARY_REVISIONS_REMOTE_PATH, invocationCounter);
  const { bridge } = makeBridge({ roomRef: countingRoomRef });

  // Invocation 1: semantic twin under a LARGER id -> this candidate wins ->
  // 'canonicalized' (an identity swap). Then the twin disappears from remote
  // entirely, so invocation 2 is a plain new-fact commit.
  const candidate = { id: 'aaa-mine', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: T_1800_MANILA };
  roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH)
    ._scheduleConcurrentWriteBeforeCommit(() => ({ [anchor.id]: anchor }));

  const result = await bridge.pushRevision(candidate);

  assert.equal(invocationCounter.count, 2);
  assert.deepEqual(result, { committed: true, outcome: 'committed' });
  assert.deepEqual(assertRemoteValid(roomRef).map(r => r.id).sort(), [anchor.id, candidate.id].sort());
});
