import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoarseEvidenceRepository } from './coarse-life-evidence-repository.js';
import { createCoarseEvidenceSyncBridge } from './coarse-life-evidence-sync.js';
import { COARSE_LIFE_EVIDENCE_REMOTE_PATH } from './coarse-life-evidence-model.js';

const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };
const tz = 'America/Phoenix';

// A minimal in-memory fake of the Firebase compat RTDB surface this bridge actually uses:
// roomRef.child(path).on('value', cb) / .off(), and roomRef.update(pathMap) -> Promise.
// `.on('value', cb)` fires cb immediately with current data (real Firebase semantics), and
// again on every subsequent write anywhere in this backend (real Firebase notifies all
// listeners on a path after any write under it) — which is exactly what lets two independent
// "devices" sharing one backend simulate real cross-device sync in these tests.
function createFakeRoomBackend() {
  const store = {}; // id -> record, flat under COARSE_LIFE_EVIDENCE_REMOTE_PATH
  const listeners = new Set();
  const snapshot = () => JSON.parse(JSON.stringify(store));
  const notify = () => { const snap = { val: () => snapshot() }; listeners.forEach(cb => cb(snap)); };
  return {
    store,
    createRoomRef() {
      return {
        child(path) {
          assert.equal(path, COARSE_LIFE_EVIDENCE_REMOTE_PATH);
          let myCb = null;
          return {
            on(event, cb) { myCb = cb; listeners.add(cb); cb({ val: () => snapshot() }); },
            off() { if (myCb) listeners.delete(myCb); myCb = null; }
          };
        },
        update(updates) {
          Object.entries(updates).forEach(([fullPath, value]) => {
            const id = fullPath.slice((COARSE_LIFE_EVIDENCE_REMOTE_PATH + '/').length);
            store[id] = value;
          });
          notify();
          return Promise.resolve(true);
        }
      };
    }
  };
}

function makeClient({ backend, clockStart = 1 }) {
  const repository = createCoarseEvidenceRepository(memory());
  const roomRef = backend.createRoomRef();
  let clock = clockStart;
  const tick = () => ++clock;
  let changeCount = 0;
  const bridge = createCoarseEvidenceSyncBridge({
    repository,
    getRoomRef: () => roomRef,
    now: () => clock,
    onRemoteChange: () => { changeCount++; }
  });
  return { repository, bridge, tick, getChangeCount: () => changeCount };
}

// ── Offline / unconfigured safety (§19, §22: never throw, never block) ─────

test('attach()/pushRecord()/pushAllLocal() are safe no-ops when there is no room (offline / signed out)', async () => {
  const repository = createCoarseEvidenceRepository(memory());
  const bridge = createCoarseEvidenceSyncBridge({ repository, getRoomRef: () => null });
  assert.doesNotThrow(() => bridge.attach());
  const record = repository.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  assert.equal(await bridge.pushRecord(record), false);
  assert.equal(await bridge.pushAllLocal(), false);
  assert.doesNotThrow(() => bridge.detach());
});

test('a rejected update() (network failure) resolves false instead of throwing (best-effort push)', async () => {
  const repository = createCoarseEvidenceRepository(memory());
  const roomRef = { child: () => ({ on() {}, off() {} }), update: () => Promise.reject(new Error('offline')) };
  const bridge = createCoarseEvidenceSyncBridge({ repository, getRoomRef: () => roomRef });
  const record = repository.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  assert.equal(await bridge.pushRecord(record), false);
});

// ── Single-client attach lifecycle ──────────────────────────────────────────

test('attach() merges the current remote snapshot immediately, then bootstrap-pushes any local-only records', async () => {
  const backend = createFakeRoomBackend();
  const { repository, bridge } = makeClient({ backend });
  // Pre-durability local record (simulates an existing Phase 6H install upgrading).
  const preexisting = repository.save({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 45, now: 1 });
  bridge.attach();
  await Promise.resolve(); // let the fire-and-forget bootstrap push's microtask settle
  await Promise.resolve();
  assert.deepEqual(Object.keys(backend.store), [preexisting.id]);
  assert.equal(backend.store[preexisting.id].estimatedMinutes, 45);
});

test('handleRemoteSnapshot only reports a change when a record actually changed (idempotent re-delivery)', () => {
  const { repository, bridge, getChangeCount } = makeClient({ backend: createFakeRoomBackend() });
  const record = repository.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  bridge.handleRemoteSnapshot({ [record.id]: record });
  assert.equal(getChangeCount(), 0); // identical to local already -> no change
  const newer = { ...record, estimatedMinutes: 90, updatedAt: 5 };
  bridge.handleRemoteSnapshot({ [record.id]: newer });
  assert.equal(getChangeCount(), 1);
  bridge.handleRemoteSnapshot({ [record.id]: newer }); // re-delivered, e.g. on reconnect
  assert.equal(getChangeCount(), 1); // no further churn
});

test('a malformed remote snapshot never throws out of handleRemoteSnapshot', () => {
  const { bridge } = makeClient({ backend: createFakeRoomBackend() });
  assert.doesNotThrow(() => bridge.handleRemoteSnapshot(null));
  assert.doesNotThrow(() => bridge.handleRemoteSnapshot({ garbage: 'not-a-record' }));
  assert.doesNotThrow(() => bridge.handleRemoteSnapshot({ garbage: 42 }));
});

// ── Two-client chaos simulation (§31, §16) ──────────────────────────────────

test('two clients converge: create, concurrent edits, delete, and a reconnecting stale client never resurrects the deletion', async () => {
  const backend = createFakeRoomBackend();
  const a = makeClient({ backend, clockStart: 100 });
  const b = makeClient({ backend, clockStart: 200 });

  a.bridge.attach();
  b.bridge.attach();

  // A creates Cooking, B creates Household — both should end up on both sides.
  const cooking = a.repository.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: a.tick() });
  await a.bridge.pushRecord(cooking);
  const household = b.repository.save({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 45, now: b.tick() });
  await b.bridge.pushRecord(household);

  assert.equal(a.repository.listForDate('2026-09-09').records.length, 2);
  assert.equal(b.repository.listForDate('2026-09-09').records.length, 2);

  // Concurrent edits: A edits Cooking, B edits Household.
  const cookingEdited = a.repository.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 90, now: a.tick(), previousId: cooking.id });
  await a.bridge.pushRecord(cookingEdited);
  const householdEdited = b.repository.save({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 60, now: b.tick(), previousId: household.id });
  await b.bridge.pushRecord(householdEdited);

  assert.equal(a.repository.get(cooking.id).estimatedMinutes, 90);
  assert.equal(a.repository.get(household.id).estimatedMinutes, 60);
  assert.equal(b.repository.get(cooking.id).estimatedMinutes, 90);
  assert.equal(b.repository.get(household.id).estimatedMinutes, 60);

  // B goes offline (detach) before A deletes Cooking.
  b.bridge.detach();
  a.repository.remove(cooking.id, { now: a.tick() });
  const tombstone = a.repository.getRaw(cooking.id);
  await a.bridge.pushRecord(tombstone);
  assert.equal(a.repository.get(cooking.id), null);
  // B, still detached, is unaffected yet and still holds the pre-delete copy.
  assert.equal(b.repository.get(cooking.id).estimatedMinutes, 90);

  // B reconnects: attach() merges the current remote state (the tombstone) BEFORE its own
  // bootstrap push runs, so B's stale local copy is corrected first and cannot resurrect it.
  b.bridge.attach();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(b.repository.get(cooking.id), null); // Cooking stays deleted on B too
  assert.equal(a.repository.get(cooking.id), null); // and A's own view is unaffected by B's reconnect
  assert.equal(a.repository.listForDate('2026-09-09').records.length, 1);
  assert.equal(b.repository.listForDate('2026-09-09').records.length, 1);
});

test('a resurrection (delete then re-add) on one device propagates to a device that already holds the tombstone', async () => {
  const backend = createFakeRoomBackend();
  const a = makeClient({ backend, clockStart: 100 });
  const b = makeClient({ backend, clockStart: 200 });
  a.bridge.attach();
  b.bridge.attach();

  const cooking = a.repository.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: a.tick() });
  await a.bridge.pushRecord(cooking);
  b.bridge.detach();
  b.bridge.attach();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(b.repository.get(cooking.id).estimatedMinutes, 60);

  // B goes offline, A deletes then re-adds ("Cooking" resurrected) while B is unaware.
  b.bridge.detach();
  a.repository.remove(cooking.id, { now: a.tick() });
  await a.bridge.pushRecord(a.repository.getRaw(cooking.id));
  const resurrected = a.repository.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 45, now: a.tick() });
  await a.bridge.pushRecord(resurrected);
  assert.ok(resurrected.undoRestoredAt); // stamped by the repository — required for B to accept this

  // B reconnects and must adopt the resurrection, not stay stuck on its stale tombstone.
  b.bridge.attach();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(b.repository.get(cooking.id)?.estimatedMinutes, 45);
  assert.equal(b.repository.listForDate('2026-09-09').records.length, 1);
});

test('pushAllLocal() does not re-push records the remote copy already has (no redundant rewrite on every attach/reconnect)', async () => {
  const backend = createFakeRoomBackend();
  let updateCalls = 0;
  const originalCreateRoomRef = backend.createRoomRef.bind(backend);
  backend.createRoomRef = () => {
    const ref = originalCreateRoomRef();
    const originalUpdate = ref.update.bind(ref);
    ref.update = updates => { updateCalls++; return originalUpdate(updates); };
    return ref;
  };
  const { repository, bridge } = makeClient({ backend });
  repository.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });

  bridge.attach();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(updateCalls, 1); // one bootstrap push for the local-only record

  // Reconnect with no local changes since — the remote copy already matches, so this must
  // not issue another write (previously pushAllLocal() rewrote every record unconditionally
  // on every attach, generating redundant Firebase writes on every page load).
  bridge.detach();
  bridge.attach();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(updateCalls, 1); // unchanged — no redundant push
});

test('a rename replicates as an add-at-new-identity plus a tombstone-at-old-identity, so the old id cannot resurrect on another device', async () => {
  const backend = createFakeRoomBackend();
  const a = makeClient({ backend, clockStart: 1 });
  const b = makeClient({ backend, clockStart: 1 });
  a.bridge.attach();
  b.bridge.attach();

  const first = a.repository.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: a.tick() });
  await a.bridge.pushRecord(first);

  const renamed = a.repository.save({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 60, now: a.tick(), previousId: first.id });
  await a.bridge.pushRecord(renamed);
  const oldTombstone = a.repository.getRaw(first.id);
  await a.bridge.pushRecord(oldTombstone); // the UI layer pushes both after a rename — see coarse-life-evidence-ui.js

  // Force B to re-read the now-current remote state (simulates its next reconnect).
  b.bridge.detach();
  b.bridge.attach();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(b.repository.get(first.id), null); // old identity gone on B too
  assert.equal(b.repository.get(renamed.id).label, 'Cooking / eating');
  assert.equal(b.repository.listForDate('2026-09-09').records.length, 1); // never both at once
});
