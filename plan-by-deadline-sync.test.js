import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanByDeadlineSyncBridge, PLAN_BY_DEADLINE_REVISIONS_REMOTE_PATH, INTENTIONAL_OFF_DAYS_REMOTE_PATH } from './plan-by-deadline-sync.js';
import { createPlanByDeadlineRepository } from './plan-by-deadline-repository.js';

const MANILA = 'Asia/Manila';
const TEST_ROOM = 'uid_test-room';
const OTHER_ROOM = 'uid_other-room';
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };
let seq = 0;
const seqIds = () => `id-${++seq}`;

// ── minimal fake room ref supporting update()/on()/off(), same style as the
// other sync test suites (operational-plan-sync.test.js / personal-day-
// boundary-sync.test.js), extended with update() since this bridge merges
// fields rather than replacing a whole path.
function fakeRoomRef(initial = {}) {
  const root = { value: initial };
  const listeners = new Map();
  function get(path) {
    return path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  }
  function setAt(path, value) {
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
      update(patch) {
        const current = get(path) || {};
        setAt(path, { ...current, ...patch });
        return Promise.resolve();
      },
    };
  }
  return makeRef('');
}

function repoFor(room) {
  return createPlanByDeadlineRepository({ storage: memory(), idGenerator: seqIds, getOwner: () => room });
}

// ── deadline push ──────────────────────────────────────────────────────────

test('pushAllDeadlines is a no-op when there is nothing locally to push', async () => {
  const roomRef = fakeRoomRef();
  const repository = repoFor(TEST_ROOM);
  const bridge = createPlanByDeadlineSyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  const result = await bridge.pushAllDeadlines();
  assert.equal(result.outcome, 'skipped');
});

test('pushAllDeadlines writes each local revision as its own child key', async () => {
  const roomRef = fakeRoomRef();
  const repository = repoFor(TEST_ROOM);
  repository.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, Date.parse('2026-01-01T00:00:00Z'));
  const bridge = createPlanByDeadlineSyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  const result = await bridge.pushAllDeadlines();
  assert.equal(result.outcome, 'committed');
  const remote = roomRef.child(PLAN_BY_DEADLINE_REVISIONS_REMOTE_PATH).val();
  const [localRevision] = repository.readDeadlines();
  assert.deepEqual(remote[localRevision.id], localRevision);
});

test('pushAllDeadlines refuses with owner-mismatch when the joined room is not the cache owner', async () => {
  const roomRef = fakeRoomRef();
  const repository = repoFor(TEST_ROOM);
  repository.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, Date.parse('2026-01-01T00:00:00Z'));
  const bridge = createPlanByDeadlineSyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => OTHER_ROOM });
  const result = await bridge.pushAllDeadlines();
  assert.equal(result.outcome, 'owner-mismatch');
  assert.equal(roomRef.child(PLAN_BY_DEADLINE_REVISIONS_REMOTE_PATH).val(), null);
});

// ── deadline pull / attach ──────────────────────────────────────────────────

test('attachDeadlines merges an inbound remote snapshot into the room-owning cache', () => {
  const remoteRevision = { id: 'remote-1', deadlineTime: '08:00', effectiveFromInstant: 1000 };
  const roomRef = fakeRoomRef({ [PLAN_BY_DEADLINE_REVISIONS_REMOTE_PATH]: { 'remote-1': remoteRevision } });
  const repository = repoFor(TEST_ROOM);
  const bridge = createPlanByDeadlineSyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  bridge.attachDeadlines();
  assert.deepEqual(repository.readDeadlines(), [remoteRevision]);
});

test('a snapshot from a room that is no longer joined/owning is never merged', () => {
  const remoteRevision = { id: 'remote-1', deadlineTime: '08:00', effectiveFromInstant: 1000 };
  const roomRef = fakeRoomRef({ [PLAN_BY_DEADLINE_REVISIONS_REMOTE_PATH]: { 'remote-1': remoteRevision } });
  const repository = repoFor(TEST_ROOM);
  const bridge = createPlanByDeadlineSyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => OTHER_ROOM }); // never owns TEST_ROOM's cache
  bridge.attachDeadlines();
  assert.deepEqual(repository.readDeadlines(), []);
});

test('attachDeadlines for a different room drops the previous room\'s listener first (account switch)', () => {
  let currentRoom = TEST_ROOM;
  const roomRefA = fakeRoomRef();
  const roomRefB = fakeRoomRef({ [PLAN_BY_DEADLINE_REVISIONS_REMOTE_PATH]: { 'remote-1': { id: 'remote-1', deadlineTime: '09:00', effectiveFromInstant: 2000 } } });
  const repository = createPlanByDeadlineRepository({ storage: memory(), idGenerator: seqIds, getOwner: () => currentRoom });
  const bridge = createPlanByDeadlineSyncBridge({ repository, getRoomRef: () => (currentRoom === TEST_ROOM ? roomRefA : roomRefB), getRoomId: () => currentRoom });
  bridge.attachDeadlines();
  currentRoom = OTHER_ROOM;
  bridge.attachDeadlines();
  assert.deepEqual(repository.readDeadlines(), [{ id: 'remote-1', deadlineTime: '09:00', effectiveFromInstant: 2000 }]);
});

// ── off-day push/pull ────────────────────────────────────────────────────

test('pushAllOffDays writes each local off-day record keyed by dateKey', async () => {
  const roomRef = fakeRoomRef();
  const repository = repoFor(TEST_ROOM);
  repository.declareOffDay('2026-09-27', 1000);
  const bridge = createPlanByDeadlineSyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  const result = await bridge.pushAllOffDays();
  assert.equal(result.outcome, 'committed');
  const remote = roomRef.child(INTENTIONAL_OFF_DAYS_REMOTE_PATH).val();
  assert.deepEqual(remote['2026-09-27'], repository.readOffDay('2026-09-27'));
});

test('attachOffDays merges an inbound remote off-day snapshot (earliest declaredAtMs wins, revoke sticks)', () => {
  const roomRef = fakeRoomRef({ [INTENTIONAL_OFF_DAYS_REMOTE_PATH]: { '2026-09-27': { dateKey: '2026-09-27', declaredAtMs: 500, revokedAtMs: null } } });
  const repository = repoFor(TEST_ROOM);
  repository.declareOffDay('2026-09-27', 1000); // local declared later
  const bridge = createPlanByDeadlineSyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  bridge.attachOffDays();
  assert.equal(repository.readOffDay('2026-09-27').declaredAtMs, 500); // remote's earlier timestamp wins
});

test('pushAllOffDays refuses with owner-mismatch when the joined room is not the cache owner', async () => {
  const roomRef = fakeRoomRef();
  const repository = repoFor(TEST_ROOM);
  repository.declareOffDay('2026-09-27', 1000);
  const bridge = createPlanByDeadlineSyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => OTHER_ROOM });
  const result = await bridge.pushAllOffDays();
  assert.equal(result.outcome, 'owner-mismatch');
});

// ── detach ──────────────────────────────────────────────────────────────

test('detachAll stops both listeners from applying further remote changes', () => {
  const roomRef = fakeRoomRef();
  const repository = repoFor(TEST_ROOM);
  const bridge = createPlanByDeadlineSyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM });
  bridge.attachAll();
  bridge.detachAll();
  roomRef.child(PLAN_BY_DEADLINE_REVISIONS_REMOTE_PATH).update({ 'remote-1': { id: 'remote-1', deadlineTime: '08:00', effectiveFromInstant: 1000 } });
  assert.deepEqual(repository.readDeadlines(), []); // detached — never merged
});
