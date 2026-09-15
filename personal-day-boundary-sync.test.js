import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalDayBoundarySyncBridge, DAY_BOUNDARY_REVISIONS_REMOTE_PATH } from './personal-day-boundary-sync.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { LEGACY_CALENDAR_DAY_REVISION_ID } from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };
let seq = 0;
const seqIds = () => `id-${++seq}`;

// ── minimal fake Firebase Realtime Database room ref ────────────────────────
// Enough of the real SDK's shape to exercise attach/child/on/transaction: a
// shared value tree, path-scoped child refs, and a transaction() that mirrors
// the real semantics this module depends on — returning `undefined` from the
// update function aborts without committing.
function fakeRoomRef(initial = {}) {
  const root = { value: initial };
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
      transaction(updateFn) {
        const current = get(path) ?? null;
        const next = updateFn(current);
        if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => current } });
        set(path, next);
        return Promise.resolve({ committed: true, snapshot: { val: () => next } });
      },
      update(patch) {
        Object.entries(patch).forEach(([p, v]) => set(p, v));
        return Promise.resolve();
      }
    };
  }
  return makeRef('');
}

function makeBridge({ roomRef = fakeRoomRef(), storage = memory(), onRemoteChange, onConflict } = {}) {
  const repository = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds });
  const bridge = createPersonalDayBoundarySyncBridge({ repository, getRoomRef: () => roomRef, onRemoteChange, onConflict });
  return { bridge, repository, roomRef };
}

const anchor = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: null };

test('pushRevision writes a new revision to its own child key', async () => {
  const { bridge, roomRef } = makeBridge();
  const revision = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: 1000000 };
  const ok = await bridge.pushRevision(revision);
  assert.equal(ok, true);
  assert.deepEqual(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).child('r1').val(), revision);
});

test('pushRevision is a no-op success-false when disconnected', async () => {
  const { bridge } = makeBridge({ roomRef: null });
  assert.equal(await bridge.pushRevision({ id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: 1 }), false);
});

test('pushRevision transaction guard: a second device writing a DIFFERENT fact to the SAME id is aborted, not overwritten', async () => {
  const roomRef = fakeRoomRef();
  const revision = { id: 'shared-id', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: 1000000 };
  const conflicting = { ...revision, boundaryTime: '16:00' };
  const bridgeA = makeBridge({ roomRef }).bridge;
  const bridgeB = makeBridge({ roomRef }).bridge;
  assert.equal(await bridgeA.pushRevision(revision), true);
  const secondResult = await bridgeB.pushRevision(conflicting);
  assert.equal(secondResult, false); // aborted — never overwrote device A's fact
  assert.deepEqual(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).child('shared-id').val(), revision);
});

test('pushRevision transaction guard: re-pushing the SAME fact to the same id commits (idempotent)', async () => {
  const roomRef = fakeRoomRef();
  const revision = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: 1000000 };
  const bridge = makeBridge({ roomRef }).bridge;
  assert.equal(await bridge.pushRevision(revision), true);
  assert.equal(await bridge.pushRevision(revision), true); // same content -> commits again, harmlessly
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
  const remote = roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val() || {};
  assert.equal(Object.keys(remote).length, 2); // anchor + the 18:00 revision
});

test('two devices proposing different revisions offline both survive once both attach (order-independent merge)', () => {
  const roomRef = fakeRoomRef();
  const deviceA = makeBridge({ roomRef, storage: memory() });
  const deviceB = makeBridge({ roomRef: fakeRoomRef(), storage: memory() }); // separate room ref simulates "not yet synced"
  deviceA.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, Date.parse('2026-09-14T00:30:00Z'));
  deviceB.repository.propose({ boundaryTime: '16:00', timezone: MANILA }, Date.parse('2026-09-20T00:30:00Z'));
  // Both come online against the SAME real room ref.
  const sharedRoomRef = roomRef;
  const bridgeA = createPersonalDayBoundarySyncBridge({ repository: deviceA.repository, getRoomRef: () => sharedRoomRef });
  const bridgeB = createPersonalDayBoundarySyncBridge({ repository: deviceB.repository, getRoomRef: () => sharedRoomRef });
  bridgeA.attach(); // pushes device A's 2 revisions to the (previously empty) shared remote
  bridgeB.attach(); // sees A's revisions, merges them in; then bootstrap pushes B's own revision up
  // Re-attach A's bridge to a manual snapshot fetch to converge (mirrors a reconnect):
  bridgeA.handleRemoteSnapshot(sharedRoomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val());
  assert.equal(deviceA.repository.status().revisions.length, 3); // anchor + A's + B's
  assert.equal(deviceB.repository.status().revisions.length, 3);
});

test('onConflict fires when a remote revision conflicts with a local one, and local truth is untouched', () => {
  const roomRef = fakeRoomRef();
  const { bridge, repository } = makeBridge({ roomRef });
  const { revision: local } = repository.propose({ boundaryTime: '18:00', timezone: MANILA }, Date.parse('2026-09-14T00:30:00Z'));
  const conflicts = [];
  const bridgeWithHandler = createPersonalDayBoundarySyncBridge({ repository, getRoomRef: () => roomRef, onConflict: r => conflicts.push(r) });
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
  // After detach, pushing new remote data does not reach this bridge (no listener).
  roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).update({ ghost: { id: 'ghost', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: 999 } });
  assert.equal(repository.status().revisions.length, 1); // unchanged — no listener was firing
});
