import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationalPlanSyncBridge, OPERATIONAL_PLANS_REMOTE_PATH, toFirebaseSafeKey, fromFirebaseSafeKey } from './operational-plan-sync.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import {
  legacyBoundaryRevision, proposeBoundaryRevision, operationalDayContaining, operationalDayId,
} from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };

function mondayOperationalDay() {
  const legacy = legacyBoundaryRevision(MANILA);
  const nowMs = Date.parse('2026-09-14T00:30:00Z');
  const revisions = proposeBoundaryRevision([legacy], { id: 'r-1800', boundaryTime: '18:00', timezone: MANILA }, nowMs).revisions;
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions);
  return { ref, revisions, id: operationalDayId(ref) };
}

// ── same minimal fake room ref shape as personal-day-boundary-sync.test.js ──
function fakeRoomRef(initial = {}) {
  const root = { value: initial };
  const listeners = new Map();
  function get(path) {
    return path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  }
  function set(path, value) {
    const segs = path.split('/').filter(Boolean);
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
        fn({ val: () => get(path) ?? null });
      },
      off() { listeners.delete(path); },
      val: () => get(path) ?? null,
      transaction(updateFn) {
        const current = get(path) ?? null;
        const next = updateFn(current);
        if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => current } });
        set(path, next);
        return Promise.resolve({ committed: true, snapshot: { val: () => next } });
      }
    };
  }
  return makeRef('');
}

// ── syncDay push (§5, §21 — same transaction-merge safety as legacy plans) ──

test('syncDay is a no-op when there is nothing locally to push', async () => {
  const roomRef = fakeRoomRef();
  const repository = createOperationalPlanRepository({ storage: memory() });
  const bridge = createOperationalPlanSyncBridge({ repository, getRoomRef: () => roomRef });
  const { id } = mondayOperationalDay();
  assert.equal(await bridge.syncDay(id), false);
});

test('syncDay pushes a local record to the remote transaction path', async () => {
  const roomRef = fakeRoomRef();
  const repository = createOperationalPlanRepository({ storage: memory() });
  const { ref, revisions, id } = mondayOperationalDay();
  repository.write(id, [{ id: 'p1', task: 'x', updatedAt: 1, updatedBy: 'a' }], { updatedBy: 'a', ref, revisions });
  const bridge = createOperationalPlanSyncBridge({ repository, getRoomRef: () => roomRef });
  assert.equal(await bridge.syncDay(id), true);
  const remote = roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(id)).val();
  assert.equal(remote.items[0].id, 'p1');
});

test('toFirebaseSafeKey/fromFirebaseSafeKey round-trip an operationalDayId losslessly despite its embedded "/"', () => {
  const { id } = mondayOperationalDay();
  assert.ok(id.includes('/')); // the whole reason this encoding exists
  const key = toFirebaseSafeKey(id);
  assert.equal(/[.#$[\]/]/.test(key), false); // no Firebase-illegal characters
  assert.equal(fromFirebaseSafeKey(key), id);
});

test('two devices syncDay-ing the SAME operational day concurrently converge by per-item merge, not overwrite', async () => {
  const roomRef = fakeRoomRef();
  const { ref, revisions, id } = mondayOperationalDay();

  const repoA = createOperationalPlanRepository({ storage: memory() });
  repoA.write(id, [{ id: 'p1', task: 'from A', updatedAt: 100, updatedBy: 'device-a' }], { updatedBy: 'device-a', ref, revisions });
  const bridgeA = createOperationalPlanSyncBridge({ repository: repoA, getRoomRef: () => roomRef });

  const repoB = createOperationalPlanRepository({ storage: memory() });
  repoB.write(id, [{ id: 'p2', task: 'from B', updatedAt: 100, updatedBy: 'device-b' }], { updatedBy: 'device-b', ref, revisions });
  const bridgeB = createOperationalPlanSyncBridge({ repository: repoB, getRoomRef: () => roomRef });

  await bridgeA.syncDay(id); // remote now has {p1}
  await bridgeB.syncDay(id); // transaction merges {p1} (remote) + {p2} (B's local) -> {p1, p2}

  const remote = roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(id)).val();
  assert.equal(remote.items.length, 2); // BOTH items survive — never an overwrite
  assert.deepEqual(remote.items.map(i => i.id).sort(), ['p1', 'p2']);

  // B's local repository absorbs the merged (committed) result back down.
  assert.equal(repoB.read(id).items.length, 2);
});

test('sync convergence rejects a stale source resurrection regardless of push order', async () => {
  for (const order of ['stale-first', 'move-first']) {
    const roomRef = fakeRoomRef();
    const { ref, revisions, id } = mondayOperationalDay();
    const destination = id.replace('2026-09-14', '2026-09-15');
    const relocationRevision = { schemaVersion: 1, sequence: 1, fromDayId: id, toDayId: destination, updatedBy: 'device-a', updatedAt: 100 };
    const movedRepo = createOperationalPlanRepository({ storage: memory() });
    movedRepo.write(id, [{ id: 'p1', task: 'moved', deleted: true, movedToDayId: destination, relocationRevision, updatedAt: 100, updatedBy: 'device-a' }], { updatedBy: 'device-a', ref, revisions });
    const staleRepo = createOperationalPlanRepository({ storage: memory() });
    staleRepo.write(id, [{ id: 'p1', task: 'offline stale edit', updatedAt: 999, updatedBy: 'device-z' }], { updatedBy: 'device-z', ref, revisions });
    const movedBridge = createOperationalPlanSyncBridge({ repository: movedRepo, getRoomRef: () => roomRef });
    const staleBridge = createOperationalPlanSyncBridge({ repository: staleRepo, getRoomRef: () => roomRef });
    for (const bridge of order === 'stale-first' ? [staleBridge, movedBridge] : [movedBridge, staleBridge]) await bridge.syncDay(id);
    const remote = roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(id)).val();
    assert.equal(remote.items[0].deleted, true, order);
    assert.deepEqual(remote.items[0].relocationRevision, relocationRevision, order);
  }
});

// ── attachDay / detachDay (per-day listeners) ─────────────────────────────

test('attachDay merges an existing remote record into local storage on first snapshot', () => {
  const { id } = mondayOperationalDay();
  const remoteRecord = { items: [{ id: 'p1', task: 'remote', updatedAt: 1, updatedBy: 'a' }], updatedAt: 1, updatedBy: 'a' };
  const roomRef = fakeRoomRef({ [OPERATIONAL_PLANS_REMOTE_PATH]: { [toFirebaseSafeKey(id)]: remoteRecord } });
  const repository = createOperationalPlanRepository({ storage: memory() });
  const changes = [];
  const bridge = createOperationalPlanSyncBridge({ repository, getRoomRef: () => roomRef, onRemoteChange: (dayId, record) => changes.push({ dayId, record }) });
  bridge.attachDay(id);
  assert.equal(changes.length, 1);
  assert.equal(repository.read(id).items[0].task, 'remote');
});

test('attachDay is per-day: a snapshot for a DIFFERENT operational day never reaches an unattached listener', () => {
  const { id } = mondayOperationalDay();
  const otherRevisions = proposeBoundaryRevision([legacyBoundaryRevision(MANILA)], { id: 'r2', boundaryTime: '16:00', timezone: MANILA }, Date.parse('2026-09-20T00:30:00Z')).revisions;
  const otherRef = operationalDayContaining(Date.parse('2026-09-20T09:00:00Z'), otherRevisions);
  const otherId = operationalDayId(otherRef);
  const roomRef = fakeRoomRef({ [OPERATIONAL_PLANS_REMOTE_PATH]: { [toFirebaseSafeKey(otherId)]: { items: [], updatedAt: 1 } } });
  const repository = createOperationalPlanRepository({ storage: memory() });
  const bridge = createOperationalPlanSyncBridge({ repository, getRoomRef: () => roomRef });
  bridge.attachDay(id); // attach only the Monday day, not otherId
  assert.equal(repository.read(otherId), null); // untouched — no listener was ever attached for it
});

test('detachDay stops the listener; a later remote update is not absorbed', () => {
  const { id } = mondayOperationalDay();
  const roomRef = fakeRoomRef({ [OPERATIONAL_PLANS_REMOTE_PATH]: { [toFirebaseSafeKey(id)]: { items: [], updatedAt: 1 } } });
  const repository = createOperationalPlanRepository({ storage: memory() });
  const bridge = createOperationalPlanSyncBridge({ repository, getRoomRef: () => roomRef });
  bridge.attachDay(id);
  bridge.detachDay(id);
  roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(id)).transaction(() => ({ items: [{ id: 'ghost', task: 'x', updatedAt: 2, updatedBy: 'a' }], updatedAt: 2 }));
  assert.equal(repository.read(id).items.length, 0); // never absorbed — listener was detached
});

test('detachAll stops every attached listener', () => {
  const { id, ref, revisions } = mondayOperationalDay();
  const otherRevisions = proposeBoundaryRevision([legacyBoundaryRevision(MANILA)], { id: 'r2', boundaryTime: '16:00', timezone: MANILA }, Date.parse('2026-09-20T00:30:00Z')).revisions;
  const otherRef = operationalDayContaining(Date.parse('2026-09-20T09:00:00Z'), otherRevisions);
  const otherId = operationalDayId(otherRef);
  const roomRef = fakeRoomRef();
  const repository = createOperationalPlanRepository({ storage: memory() });
  const bridge = createOperationalPlanSyncBridge({ repository, getRoomRef: () => roomRef });
  bridge.attachDay(id);
  bridge.attachDay(otherId);
  bridge.detachAll();
  roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(id)).transaction(() => ({ items: [{ id: 'ghost', task: 'x', updatedAt: 2, updatedBy: 'a' }], updatedAt: 2 }));
  assert.equal(repository.read(id), null);
});
