// cross-store-account-isolation.test.js
//
// Cross-Store Account Isolation V1. Commitments (`ta3-commitments-v1`) and coarse life evidence
// (`ta3-coarse-life-evidence-v1`) were each ONE unscoped localStorage key. After a direct account
// switch (A -> B, no sign-out, no reload) storage.js's onAuthStateChanged set roomCode = uid_B and
// called startSync() WITHOUT tearing anything down, so:
//   - both bridges' attach() early-returned, still bound to A's room (A's other devices kept merging
//     into the one shared cache while B was signed in);
//   - the `.info/connected` hook ran pushAllLocal() into B's room. Reproduced before the fix:
//       commitments   first wrong write: transaction rooms/uid_B/commitments/<A's id>
//                     <- commitments-sync.js syncCommitment <- pushAllLocal <- reconnect hook
//       coarse        first wrong write: update rooms/uid_B/coarseLifeEvidence/<A's id>
//                     <- coarse-life-evidence-sync.js pushAllLocal (diffing against A's stale
//                        snapshot, so any A record A's remote lacked went to B);
//   - A's records read as B's current state, and editing one under B wrote it into B's room.
//
// The invariant under test, for BOTH stores: no local fact is pushed into a room unless the cache it
// came from is provably that room's (activeRoom == cacheOwner == pushRoom); a callback from a room the
// device has left never touches the active cache; an unowned (pre-scoping) key is never read, adopted,
// uploaded, modified or deleted; and every current/derived view reads only the active account's slot.
//
// One physical device (one shared storage), several accounts, ONE instrumented in-memory database
// holding every room. No real Firebase, no network, no production data. The account helpers follow
// storage.js's real order:
//   signIn / direct switch: roomCode = uid_X; fbRoomRef = rooms/uid_X; startSync() -> attach() on
//                           both bridges (no teardown on a direct switch), then `.info/connected` ->
//                           pushAllLocal() on both.
//   signOut:                both bridges detach() while the room is still set, THEN roomCode = ''.
//   offline:                fbRoomRef stays set (as in the app); the database stops delivering
//                           listener events and fails writes until it reconnects, which re-delivers
//                           every live listener and runs the `.info/connected` hook again.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommitmentsRepository, commitmentsCacheKeyForRoom, COMMITMENTS_STORAGE_KEY } from './commitments-repository.js';
import { createCommitmentsSyncBridge, COMMITMENTS_REMOTE_PATH } from './commitments-sync.js';
import { buildCommitment, activeCommitments, upcomingCommitments, commitmentsForTarget } from './commitments-model.js';
import { createCoarseEvidenceRepository, coarseEvidenceCacheKeyForRoom } from './coarse-life-evidence-repository.js';
import { createCoarseEvidenceSyncBridge } from './coarse-life-evidence-sync.js';
import { COARSE_LIFE_EVIDENCE_KEY, COARSE_LIFE_EVIDENCE_REMOTE_PATH, createCoarseEvidenceRecord, getCoarseEvidenceForDate } from './coarse-life-evidence-model.js';

const MANILA = 'Asia/Manila';
const T0 = Date.parse('2026-09-24T08:00:00+08:00');
const EVIDENCE_DATE = '2026-09-23';
const COMMITMENT_DATE = '2026-09-30';
const ROOM = uid => `uid_${uid}`;

const memory = (seed = null) => {
  const map = new Map();
  if (seed) Object.entries(seed).forEach(([k, v]) => map.set(k, v));
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), _map: map };
};
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

// ═══════════════════════════════════════════════════════════════════════════
// an instrumented in-memory database holding every room
// ═══════════════════════════════════════════════════════════════════════════

function makeDatabase() {
  const root = { value: {} };
  const listeners = new Map(); // path -> Set(fn)
  const stats = { writes: [], callbacks: [], deferred: null, deferredResults: null, offline: false, holding: false };
  const get = path => path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
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
  function runTransaction(path, updateFn, { beforeRetry } = {}) {
    let next = updateFn(clone(get(path)));
    if (beforeRetry) { beforeRetry(); next = updateFn(clone(get(path))); } // Firebase re-runs against fresh data
    if (next === undefined) return { committed: false, snapshot: { val: () => clone(get(path)) } };
    stats.writes.push({ kind: 'transaction', path, value: clone(next) });
    set(path, next);
    return { committed: true, snapshot: { val: () => clone(next) } };
  }
  function runUpdate(path, updates) {
    Object.entries(updates).forEach(([rel, value]) => {
      stats.writes.push({ kind: 'update', path: `${path}/${rel}`, value: clone(value) });
      set(`${path}/${rel}`, value);
    });
  }
  function makeRef(path) {
    return {
      path,
      child(seg) { return makeRef(`${path}/${seg}`); },
      on(_event, fn) {
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(fn);
        stats.callbacks.push({ path, fn });
        if (!stats.offline && !stats.holding) fn({ val: () => clone(get(path)) });
      },
      off() { listeners.delete(path); },
      transaction(updateFn) {
        if (stats.offline) return Promise.reject(new Error('client is offline'));
        if (stats.deferred) return new Promise(resolve => stats.deferred.push(opts => resolve(runTransaction(path, updateFn, opts))));
        if (stats.deferredResults) {
          // Commits NOW, but the client hears about it later.
          const result = runTransaction(path, updateFn);
          return new Promise(resolve => stats.deferredResults.push(() => resolve(result)));
        }
        return Promise.resolve(runTransaction(path, updateFn));
      },
      update(updates) {
        if (stats.offline) return Promise.reject(new Error('client is offline'));
        if (stats.deferred) return new Promise(resolve => stats.deferred.push(() => { runUpdate(path, updates); resolve(); }));
        runUpdate(path, updates);
        return Promise.resolve();
      },
    };
  }
  return {
    stats, get,
    ref: makeRef,
    seed(path, value) { set(path, value); },
    /** Every write that landed anywhere under rooms/<room>. */
    writesInto(room) { return stats.writes.filter(w => w.path.startsWith(`rooms/${room}/`)); },
    defer() { stats.deferred = []; },
    deferResults() { stats.deferredResults = []; },
    releaseResults() { const waiting = stats.deferredResults.splice(0); stats.deferredResults = null; waiting.forEach(run => run()); },
    flush(opts) { const waiting = stats.deferred.splice(0); stats.deferred = null; waiting.forEach(run => run(opts)); },
    /** A listener's first answer arrives later than the `.info/connected` hook (real Firebase is async). */
    holdDeliveries() { stats.holding = true; },
    releaseDeliveries() { stats.holding = false; [...listeners.keys()].forEach(deliver); },
    goOffline() { stats.offline = true; },
    goOnline() { stats.offline = false; [...listeners.keys()].forEach(deliver); },
    /** Fire every retained callback for a path — a LATE delivery from a listener the app detached. */
    fireLate(path) { stats.callbacks.filter(c => c.path === path).forEach(c => c.fn({ val: () => clone(get(path)) })); },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// one physical device: both stores wired exactly as index.html/storage.js wire them
// ═══════════════════════════════════════════════════════════════════════════

function makeDevice(db, { storage = memory() } = {}) {
  const env = { roomCode: '', fbRoomRef: null };
  const owner = () => env.roomCode || null; // appRoomOwner(): storage.js's roomCode, '' = none
  const rebinds = [];
  const changes = { commitments: 0, evidence: 0 };
  const commitmentsRepo = createCommitmentsRepository({ storage, getOwner: owner, now: () => T0, deviceId: () => 'device-1' });
  const commitmentsSync = createCommitmentsSyncBridge({
    repository: commitmentsRepo,
    getRoomRef: () => env.fbRoomRef,
    getRoomId: owner,
    onRemoteChange: () => { changes.commitments++; },
    onRebind: room => rebinds.push({ store: 'commitments', room }),
  });
  const evidenceRepo = createCoarseEvidenceRepository(storage, undefined, { getOwner: owner });
  const evidenceSync = createCoarseEvidenceSyncBridge({
    repository: evidenceRepo,
    getRoomRef: () => env.fbRoomRef,
    getRoomId: owner,
    now: () => T0,
    onRemoteChange: () => { changes.evidence++; },
    onRebind: room => rebinds.push({ store: 'evidence', room }),
  });
  function connected() { // storage.js `.info/connected` -> true
    if (db.stats.offline) return;
    evidenceSync.pushAllLocal();
    commitmentsSync.pushAllLocal();
  }
  return {
    storage, env, rebinds, changes, commitmentsRepo, commitmentsSync, evidenceRepo, evidenceSync,
    /** onAuthStateChanged(user) -> startSync(). Also a DIRECT switch: nothing is torn down first. */
    signIn(uid) {
      env.roomCode = ROOM(uid);
      env.fbRoomRef = db.ref(`rooms/${env.roomCode}`);
      evidenceSync.attach();
      commitmentsSync.attach();
      connected();
    },
    /** onAuthStateChanged(null): detach while the room is still set, THEN clear it. */
    signOut() {
      evidenceSync.detach();
      commitmentsSync.detach();
      env.fbRoomRef = null;
      env.roomCode = '';
    },
    reconnect() { db.goOnline(); connected(); },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// the two stores behind one adapter, so every scenario runs against both
// ═══════════════════════════════════════════════════════════════════════════

const COMMITMENTS = {
  name: 'commitments',
  remotePath: COMMITMENTS_REMOTE_PATH,
  unscopedKey: COMMITMENTS_STORAGE_KEY,
  slotFor: room => commitmentsCacheKeyForRoom(room),
  /** The UI path: repository.create, then afterCommitmentWrite's syncCommitment. */
  async create(device, title) {
    const result = device.commitmentsRepo.create({ title, date: COMMITMENT_DATE, time: '09:30', timezone: MANILA });
    assert.equal(result.ok, true, JSON.stringify(result));
    await device.commitmentsSync.syncCommitment(result.record.id);
    return result.record;
  },
  /** Current state as every commitment surface reads it (planning-continuity-ui allCommitments). */
  visible: device => activeCommitments(device.commitmentsRepo.listAllRaw()).map(r => r.title).sort(),
  /** Derived views: Upcoming and the My Day rows (commitmentsForTarget) for the commitment's day. */
  derived(device) {
    const records = device.commitmentsRepo.listAllRaw();
    const dayStart = Date.parse(`${COMMITMENT_DATE}T00:00:00+08:00`);
    return [
      ...upcomingCommitments(records, T0).map(r => r.title),
      ...commitmentsForTarget(records, { startMs: dayStart, endMs: dayStart + 86400000 }).map(r => r.title),
    ];
  },
  remote: (db, room) => Object.values(db.get(`rooms/${room}/${COMMITMENTS_REMOTE_PATH}`) || {}).map(r => r.title).sort(),
  factOf: value => value?.title,
  record(title, id = `c${title.replace(/[^A-Za-z0-9]/g, '')}`) {
    const built = buildCommitment({ id, title, date: COMMITMENT_DATE, time: '10:00', timezone: MANILA, now: T0 - 1000, updatedBy: 'other-device' });
    assert.equal(built.ok, true);
    return built.record;
  },
  seedRemote(db, room, title) {
    const record = this.record(title);
    db.seed(`rooms/${room}/${COMMITMENTS_REMOTE_PATH}/${record.id}`, record);
    return record;
  },
  envelope: records => JSON.stringify({ schemaVersion: 1, commitments: Object.fromEntries(records.map(r => [r.id, r])) }),
};

const EVIDENCE = {
  name: 'coarse life evidence',
  remotePath: COARSE_LIFE_EVIDENCE_REMOTE_PATH,
  unscopedKey: COARSE_LIFE_EVIDENCE_KEY,
  slotFor: room => coarseEvidenceCacheKeyForRoom(room),
  /** The UI path: saveCoarseEvidenceEditor -> repository.save, then pushToDurableSync's pushRecord. */
  async create(device, label) {
    const saved = device.evidenceRepo.save({ date: EVIDENCE_DATE, timezone: MANILA, label, estimatedMinutes: 30, now: T0 });
    await device.evidenceSync.pushRecord(saved);
    return saved;
  },
  visible: device => device.evidenceRepo.list().map(r => r.label).sort(),
  /** Derived views: the Review list for the day (listForDate) and its total. */
  derived(device) {
    const { records, totalEstimatedMinutes } = device.evidenceRepo.listForDate(EVIDENCE_DATE);
    return [...records.map(r => r.label), ...(totalEstimatedMinutes ? [`total:${totalEstimatedMinutes}`] : [])];
  },
  remote: (db, room) => Object.values(db.get(`rooms/${room}/${COARSE_LIFE_EVIDENCE_REMOTE_PATH}`) || {}).filter(r => !r.deleted).map(r => r.label).sort(),
  factOf: value => value?.label,
  record: label => createCoarseEvidenceRecord({ date: EVIDENCE_DATE, timezone: MANILA, label, estimatedMinutes: 20, now: T0 - 1000 }),
  seedRemote(db, room, label) {
    const record = this.record(label);
    db.seed(`rooms/${room}/${COARSE_LIFE_EVIDENCE_REMOTE_PATH}/${record.id}`, record);
    return record;
  },
  envelope: records => JSON.stringify({ schemaVersion: 1, records: Object.fromEntries(records.map(r => [r.id, r])) }),
};

const STORES = [COMMITMENTS, EVIDENCE];

/** Every write into `room` carried only facts whose label starts with `prefix`. */
function onlyOwnFacts(db, store, room, prefix) {
  return db.writesInto(room)
    .filter(w => w.path.includes(`/${store.remotePath}/`))
    .every(w => String(store.factOf(w.value) || '').startsWith(prefix));
}

/** Account A signed in on the device with one synced record and one record that never reached A's
 *  remote (created while the transport was failing) — the case that leaked coarse evidence. */
async function deviceWithAccountA(db, store, options) {
  const device = makeDevice(db, options);
  device.signIn('A');
  await store.create(device, 'A-synced');
  db.goOffline();
  await store.create(device, 'A-unsynced');
  db.goOnline();
  await settle();
  return device;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1-3. account switching: A -> empty B, A -> B's own history, A -> B -> A
// ═══════════════════════════════════════════════════════════════════════════

for (const store of STORES) {
  test(`${store.name}: direct A -> EMPTY B writes zero A facts into B, shows none as B, and keeps A's slot intact`, async () => {
    const db = makeDatabase();
    const device = await deviceWithAccountA(db, store);
    const slotA = device.storage.getItem(store.slotFor(ROOM('A')));
    assert.ok(slotA, 'A has a scoped slot');

    device.signIn('B'); // direct switch — no sign-out, no reload
    await settle();

    assert.deepEqual(db.writesInto(ROOM('B')), [], 'nothing at all was written into B');
    assert.deepEqual(store.remote(db, ROOM('B')), []);
    assert.deepEqual(store.visible(device), [], 'no A fact is B\'s current state');
    assert.deepEqual(store.derived(device), [], 'no A fact in any derived view');
    assert.equal(device.storage.getItem(store.slotFor(ROOM('A'))), slotA, 'A\'s scoped cache is preserved byte-for-byte');
    assert.equal(device.storage.getItem(store.slotFor(ROOM('B'))), null, 'B has no cache until B has data');
  });

  test(`${store.name}: direct A -> B with B's OWN history hydrates B only; B's room stays B-authoritative`, async () => {
    const db = makeDatabase();
    store.seedRemote(db, ROOM('B'), 'B-own');
    const device = await deviceWithAccountA(db, store);
    const remoteABefore = store.remote(db, ROOM('A'));

    device.signIn('B');
    await settle();

    assert.deepEqual(store.visible(device), ['B-own']);
    assert.ok(store.derived(device).every(fact => !fact.startsWith('A-')));
    assert.deepEqual(store.remote(db, ROOM('B')), ['B-own'], 'no A fact merged into B');
    assert.ok(onlyOwnFacts(db, store, ROOM('B'), 'B-'));
    assert.deepEqual(store.remote(db, ROOM('A')), remoteABefore, 'B never overwrote A');
  });

  test(`${store.name}: A -> B -> A returns A to exactly A's data; B unchanged; no duplication, loss or cross-room merge`, async () => {
    const db = makeDatabase();
    store.seedRemote(db, ROOM('B'), 'B-own');
    const device = await deviceWithAccountA(db, store);

    device.signIn('B');
    await settle();
    await store.create(device, 'B-new');
    const remoteB = store.remote(db, ROOM('B'));

    device.signIn('A');
    await settle();

    assert.deepEqual(store.visible(device), ['A-synced', 'A-unsynced']);
    // Same-account convergence on return: A's own unsynced record reached A's room, and only A's.
    assert.deepEqual(store.remote(db, ROOM('A')), ['A-synced', 'A-unsynced']);
    assert.ok(onlyOwnFacts(db, store, ROOM('A'), 'A-'));
    assert.deepEqual(store.remote(db, ROOM('B')), remoteB);
    assert.deepEqual(remoteB, ['B-new', 'B-own']);
    assert.ok(onlyOwnFacts(db, store, ROOM('B'), 'B-'));

    device.signIn('B');
    await settle();
    assert.deepEqual(store.visible(device), ['B-new', 'B-own'], 'B\'s slot still holds exactly B');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. wrong-room pushes are refused with zero writes
// ═══════════════════════════════════════════════════════════════════════════

test('commitments: a push whose cache owner is not the joined room is refused (owner-mismatch), zero writes, still queued for its owner', async () => {
  const db = makeDatabase();
  const storage = memory();
  const auth = { cacheOwner: ROOM('A'), joined: ROOM('B') };
  const repository = createCommitmentsRepository({ storage, getOwner: () => auth.cacheOwner, now: () => T0 });
  const bridge = createCommitmentsSyncBridge({ repository, getRoomRef: () => db.ref(`rooms/${auth.joined}`), getRoomId: () => auth.joined });
  const record = repository.create({ title: 'A-private', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }).record;

  assert.deepEqual(await bridge.pushCommitment(record.id), { committed: false, outcome: 'owner-mismatch' });
  assert.equal(await bridge.pushAllLocal(), 0);
  assert.equal(await bridge.pushAllLocal({ all: true }), 0);
  assert.deepEqual(db.stats.writes, []);
  assert.deepEqual(bridge.pendingPushIds(ROOM('A')), [record.id], 'the intent is kept for A, not dropped');
  assert.deepEqual(bridge.pendingPushIds(ROOM('B')), []);

  // A plain (unowned) repository can never prove whose data it holds: nothing is pushed from it.
  const plain = createCommitmentsRepository({ storage: memory(), now: () => T0 });
  const plainBridge = createCommitmentsSyncBridge({ repository: plain, getRoomRef: () => db.ref('rooms/uid_B'), getRoomId: () => ROOM('B') });
  const orphan = plain.create({ title: 'nobody', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }).record;
  assert.equal((await plainBridge.pushCommitment(orphan.id)).outcome, 'owner-mismatch');
  assert.deepEqual(db.stats.writes, []);
});

test('coarse life evidence: a push is refused unless joined room == cache owner AND the record is what that cache holds now', async () => {
  const db = makeDatabase();
  const device = await deviceWithAccountA(db, EVIDENCE);
  const aRecord = device.evidenceRepo.getRaw(EVIDENCE.record('A-synced').id);
  assert.ok(aRecord);

  device.signIn('B');
  await settle();
  // A record OBJECT read from A's slot (e.g. held by an open editor) can never be written under B.
  assert.equal(await device.evidenceSync.pushRecord(aRecord), false);
  // A full diff-push against an empty snapshot finds nothing of A's to write under B.
  assert.equal(await device.evidenceSync.pushAllLocal({}), false);
  assert.deepEqual(db.writesInto(ROOM('B')), []);

  // Cache owner != joined room, injected directly.
  const auth = { cacheOwner: ROOM('A'), joined: ROOM('B') };
  const repository = createCoarseEvidenceRepository(memory(), undefined, { getOwner: () => auth.cacheOwner });
  const bridge = createCoarseEvidenceSyncBridge({ repository, getRoomRef: () => db.ref(`rooms/${auth.joined}`), getRoomId: () => auth.joined });
  const saved = repository.save({ date: EVIDENCE_DATE, timezone: MANILA, label: 'A-private', estimatedMinutes: 10, now: T0 });
  assert.equal(await bridge.pushRecord(saved), false);
  assert.equal(await bridge.pushAllLocal({}), false);
  bridge.handleRemoteSnapshot({ [saved.id]: { ...saved, estimatedMinutes: 99, updatedAt: T0 + 1 } }, ROOM('B'));
  assert.equal(repository.get(saved.id).estimatedMinutes, 10, 'a snapshot from a room that does not own the cache is never merged');
  assert.deepEqual(db.writesInto(ROOM('B')), []);

  // A plain (unowned) repository can never prove whose data it holds: nothing is pushed from it.
  const plain = createCoarseEvidenceRepository(memory());
  const plainBridge = createCoarseEvidenceSyncBridge({ repository: plain, getRoomRef: () => db.ref('rooms/uid_B'), getRoomId: () => ROOM('B') });
  const orphan = plain.save({ date: EVIDENCE_DATE, timezone: MANILA, label: 'nobody', estimatedMinutes: 10, now: T0 });
  assert.equal(await plainBridge.pushRecord(orphan), false);
  assert.deepEqual(db.writesInto(ROOM('B')), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. an account switch while a write is in flight fails closed
// ═══════════════════════════════════════════════════════════════════════════

test('commitments: a switch while a transaction is in flight aborts it with zero writes, merges nothing into B, and A re-pushes on return', async () => {
  const db = makeDatabase();
  const device = makeDevice(db);
  device.signIn('A');
  await settle();

  db.defer();
  const created = device.commitmentsRepo.create({ title: 'A-inflight', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }).record;
  const pushing = device.commitmentsSync.pushCommitment(created.id);
  device.signIn('B'); // switch before Firebase runs the update function
  db.flush();

  assert.deepEqual(await pushing, { committed: false, outcome: 'owner-mismatch' });
  assert.deepEqual(db.stats.writes, [], 'the in-flight push wrote nothing anywhere');
  assert.deepEqual(COMMITMENTS.visible(device), []);
  assert.deepEqual(device.commitmentsSync.pendingPushIds(ROOM('A')), [created.id]);

  device.signIn('A');
  await settle();
  assert.deepEqual(COMMITMENTS.remote(db, ROOM('A')), ['A-inflight'], 'the aborted push converges when A returns');
  assert.deepEqual(db.writesInto(ROOM('B')), []);
});

test('commitments: a switch between the first run and a Firebase RETRY of the update function aborts the retry', async () => {
  const db = makeDatabase();
  const device = makeDevice(db);
  device.signIn('A');
  await settle();

  db.defer();
  const created = device.commitmentsRepo.create({ title: 'A-retry', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }).record;
  const pushing = device.commitmentsSync.pushCommitment(created.id);
  db.flush({ beforeRetry: () => device.signIn('B') });

  assert.equal((await pushing).outcome, 'owner-mismatch');
  assert.deepEqual(db.stats.writes, []);
});

test('commitments: a transaction that COMMITTED to A but resolves after the switch is never merged back into B\'s cache', async () => {
  const db = makeDatabase();
  const device = makeDevice(db);
  device.signIn('A');
  await settle();

  db.deferResults();
  const created = device.commitmentsRepo.create({ title: 'A-late-result', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }).record;
  const pushing = device.commitmentsSync.pushCommitment(created.id);
  const before = device.changes.commitments;
  // Firebase ran the update function while A was joined (a legitimate commit of A's record into A's
  // room); the client hears the result only after the switch.
  assert.deepEqual(COMMITMENTS.remote(db, ROOM('A')), ['A-late-result']);
  device.signIn('B');
  db.releaseResults();
  await settle();

  assert.equal((await pushing).committed, true);
  assert.deepEqual(COMMITMENTS.visible(device), [], 'the committed A record was not merged into B\'s cache');
  assert.equal(device.changes.commitments, before);
  assert.equal(device.storage.getItem(COMMITMENTS.slotFor(ROOM('B'))), null);
});

test('coarse life evidence: an update in flight across a switch merges nothing back and leaves B untouched; the next write is refused', async () => {
  const db = makeDatabase();
  const device = makeDevice(db);
  device.signIn('A');
  await settle();

  db.defer();
  const saved = device.evidenceRepo.save({ date: EVIDENCE_DATE, timezone: MANILA, label: 'A-inflight', estimatedMinutes: 15, now: T0 });
  const pushing = device.evidenceSync.pushRecord(saved); // owner verified BEFORE the single update() call
  device.signIn('B');
  db.flush();
  await pushing;
  await settle();

  // The one update() was addressed to A's room when A owned the cache: it lands in A, nowhere else.
  assert.deepEqual(EVIDENCE.remote(db, ROOM('A')), ['A-inflight']);
  assert.deepEqual(db.writesInto(ROOM('B')), []);
  assert.deepEqual(EVIDENCE.visible(device), []);
  assert.equal(device.storage.getItem(EVIDENCE.slotFor(ROOM('B'))), null);
  // Anything started after the switch from the A record object is refused.
  assert.equal(await device.evidenceSync.pushRecord(saved), false);
  assert.deepEqual(db.writesInto(ROOM('B')), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6-7. stale callbacks after a switch or sign-out are inert
// ═══════════════════════════════════════════════════════════════════════════

for (const store of STORES) {
  test(`${store.name}: a LATE callback from A's detached listener under B never touches B's cache or re-renders`, async () => {
    const db = makeDatabase();
    const device = await deviceWithAccountA(db, store);
    device.signIn('B');
    await settle();
    // A's other device keeps writing; the old listener's callback is delivered late.
    store.seedRemote(db, ROOM('A'), 'A-from-other-device');
    const changesBefore = { ...device.changes };
    db.fireLate(`rooms/${ROOM('A')}/${store.remotePath}`);
    await settle();

    assert.deepEqual(store.visible(device), []);
    assert.deepEqual(device.changes, changesBefore, 'no change announced');
    assert.equal(device.storage.getItem(store.slotFor(ROOM('B'))), null);
    assert.deepEqual(db.writesInto(ROOM('B')), []);
  });

  test(`${store.name}: the same-path listener is REBOUND on a direct switch (old room off, new room on) and surfaces are told`, async () => {
    const db = makeDatabase();
    const device = makeDevice(db);
    device.signIn('A');
    device.signIn('B');
    const paths = db.stats.callbacks.map(c => c.path).filter(p => p.endsWith(`/${store.remotePath}`));
    assert.deepEqual(paths, [`rooms/${ROOM('A')}/${store.remotePath}`, `rooms/${ROOM('B')}/${store.remotePath}`]);
    const key = store === COMMITMENTS ? 'commitments' : 'evidence';
    assert.deepEqual(device.rebinds.filter(r => r.store === key).map(r => r.room), [ROOM('A'), null, ROOM('B')]);
    // Re-attaching to the same room is idempotent.
    device.signIn('B');
    assert.equal(db.stats.callbacks.filter(c => c.path.endsWith(`/${store.remotePath}`)).length, 2);
  });

  test(`${store.name}: sign-out leaves no active cache and no live callback/write; account slots and the unowned key stay stored`, async () => {
    const db = makeDatabase();
    const legacy = store.envelope([store.record('LEGACY-unowned')]);
    const device = await deviceWithAccountA(db, store, { storage: memory({ [store.unscopedKey]: legacy }) });
    const slotA = device.storage.getItem(store.slotFor(ROOM('A')));
    const writesBefore = db.stats.writes.length;

    device.signOut();
    store.seedRemote(db, ROOM('A'), 'A-after-signout');
    db.fireLate(`rooms/${ROOM('A')}/${store.remotePath}`); // delayed callback after sign-out
    await settle();

    assert.deepEqual(store.visible(device), [], 'no prior-account current state');
    assert.deepEqual(store.derived(device), []);
    if (store === COMMITMENTS) {
      assert.deepEqual(device.commitmentsRepo.create({ title: 'x', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }), { ok: false, reason: 'no-account' });
      assert.equal(await device.commitmentsSync.pushAllLocal({ all: true }), 0);
    } else {
      assert.throws(() => device.evidenceRepo.save({ date: EVIDENCE_DATE, timezone: MANILA, label: 'x', estimatedMinutes: 5, now: T0 }), /no account is active/);
      assert.equal(device.evidenceRepo.remove(EVIDENCE.record('A-synced').id), false);
      assert.equal(await device.evidenceSync.pushAllLocal(), false);
    }
    assert.equal(db.stats.writes.length, writesBefore, 'the device wrote nothing after sign-out');
    assert.equal(device.storage.getItem(store.slotFor(ROOM('A'))), slotA, 'A\'s slot is left stored, unchanged');
    assert.equal(device.storage.getItem(store.unscopedKey), legacy, 'the unowned key is untouched');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 8-10. offline switching and same-account reconnect
// ═══════════════════════════════════════════════════════════════════════════

for (const store of STORES) {
  test(`${store.name}: OFFLINE A -> B with no B cache shows nothing (never A); on reconnect only B converges with B's room; A intact after`, async () => {
    const db = makeDatabase();
    store.seedRemote(db, ROOM('B'), 'B-own');
    const device = await deviceWithAccountA(db, store);
    const slotA = device.storage.getItem(store.slotFor(ROOM('A')));

    db.goOffline();
    device.signIn('B');
    await settle();
    assert.deepEqual(store.visible(device), [], 'B unknown locally — empty, never A');
    assert.deepEqual(store.derived(device), []);

    device.reconnect();
    await settle();
    assert.deepEqual(store.visible(device), ['B-own']);
    assert.deepEqual(store.remote(db, ROOM('B')), ['B-own']);
    assert.ok(onlyOwnFacts(db, store, ROOM('B'), 'B-'));

    device.signIn('A');
    await settle();
    assert.deepEqual(store.visible(device), ['A-synced', 'A-unsynced']);
    assert.equal(JSON.parse(device.storage.getItem(store.slotFor(ROOM('A')))) !== null, true);
    assert.ok(slotA);
  });

  test(`${store.name}: OFFLINE A -> B WITH a B cache shows B's cache only; B's offline write reaches only B on reconnect`, async () => {
    const db = makeDatabase();
    // B used this device before: its slot is a cache of B's own cloud copy.
    const bCached = store.seedRemote(db, ROOM('B'), 'B-cached');
    const device = await deviceWithAccountA(db, store, { storage: memory({ [store.slotFor(ROOM('B'))]: store.envelope([bCached]) }) });

    db.goOffline();
    device.signIn('B');
    await settle();
    assert.deepEqual(store.visible(device), ['B-cached']);
    await store.create(device, 'B-offline-write');
    assert.deepEqual(store.visible(device), ['B-cached', 'B-offline-write']);

    device.reconnect();
    await settle();
    assert.deepEqual(store.remote(db, ROOM('B')), ['B-cached', 'B-offline-write']);
    assert.ok(onlyOwnFacts(db, store, ROOM('B'), 'B-'));
    assert.ok(!store.remote(db, ROOM('A')).some(fact => fact.startsWith('B-')));

    device.signIn('A');
    await settle();
    assert.deepEqual(store.visible(device), ['A-synced', 'A-unsynced'], 'A state intact after the round trip');
  });

  test(`${store.name}: SAME-account reconnect still converges an offline write into A (and only A)`, async () => {
    const db = makeDatabase();
    const device = makeDevice(db);
    device.signIn('A');
    await settle();

    db.goOffline();
    await store.create(device, 'A-offline');
    assert.deepEqual(store.remote(db, ROOM('A')), []);
    device.reconnect();
    await settle();

    assert.deepEqual(store.remote(db, ROOM('A')), ['A-offline']);
    assert.deepEqual(store.visible(device), ['A-offline']);
    assert.deepEqual(db.stats.writes.filter(w => !w.path.startsWith(`rooms/${ROOM('A')}/`)), []);
  });
}

test('commitments: an offline write made while Firebase was never reachable (no room ref) is queued for its owner and drained only into that owner\'s room', async () => {
  const db = makeDatabase();
  const device = makeDevice(db);
  device.signIn('A');
  await settle();
  device.env.fbRoomRef = null; // Firebase not ready
  const created = device.commitmentsRepo.create({ title: 'A-queued', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }).record;
  assert.deepEqual(await device.commitmentsSync.pushCommitment(created.id), { committed: false, outcome: 'queued' });
  assert.deepEqual(device.commitmentsSync.pendingPushIds(ROOM('A')), [created.id]);

  device.signIn('B'); // B's reconnect drain must not touch A's queue
  await settle();
  assert.deepEqual(db.writesInto(ROOM('B')), []);
  assert.deepEqual(device.commitmentsSync.pendingPushIds(ROOM('A')), [created.id]);

  device.signIn('A');
  await settle();
  assert.deepEqual(COMMITMENTS.remote(db, ROOM('A')), ['A-queued']);
  assert.deepEqual(device.commitmentsSync.pendingPushIds(ROOM('A')), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 11-12. the unowned legacy key: quarantined, never uploaded, adopted, changed or deleted
// ═══════════════════════════════════════════════════════════════════════════

for (const store of STORES) {
  test(`${store.name}: the unscoped legacy key is never uploaded — not on sign-in, reconnect, a switch, or pushAllLocal({all})`, async () => {
    const db = makeDatabase();
    const legacy = store.envelope([store.record('LEGACY-unowned')]);
    const device = makeDevice(db, { storage: memory({ [store.unscopedKey]: legacy }) });

    device.signIn('A');
    await settle();
    device.reconnect();
    device.signIn('B');
    await settle();
    if (store === COMMITMENTS) await device.commitmentsSync.pushAllLocal({ all: true });
    else await device.evidenceSync.pushAllLocal({});
    await settle();

    const leaked = db.stats.writes.filter(w => String(store.factOf(w.value) || '').startsWith('LEGACY'));
    assert.deepEqual(leaked, []);
    assert.equal(device.storage.getItem(store.unscopedKey), legacy);
  });

  test(`${store.name}: the unscoped legacy key is never adopted — never current, never derived, never merged into, never deleted`, async () => {
    const db = makeDatabase();
    const legacyRecord = store.record('LEGACY-unowned');
    const legacy = store.envelope([legacyRecord]);
    store.seedRemote(db, ROOM('A'), 'A-remote');
    const device = makeDevice(db, { storage: memory({ [store.unscopedKey]: legacy }) });

    assert.deepEqual(store.visible(device), [], 'signed out: not current');
    device.signIn('A');
    await settle();
    await store.create(device, 'A-new');

    assert.deepEqual(store.visible(device), ['A-new', 'A-remote']);
    assert.ok(store.derived(device).every(fact => !fact.startsWith('LEGACY')));
    assert.equal(device.storage.getItem(store.unscopedKey), legacy, 'byte-identical: not merged into, not migrated, not deleted');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 13. current and derived views never expose A under B; production wiring is scoped
// ═══════════════════════════════════════════════════════════════════════════

for (const store of STORES) {
  test(`${store.name}: current and derived views read only the active account's slot at every step of A -> B -> sign-out -> B`, async () => {
    const db = makeDatabase();
    store.seedRemote(db, ROOM('B'), 'B-own');
    const device = await deviceWithAccountA(db, store);
    const noA = () => [...store.visible(device), ...store.derived(device)].every(fact => !fact.startsWith('A-'));

    assert.ok(store.visible(device).length === 2);
    device.signIn('B');
    await settle();
    assert.ok(noA());
    assert.deepEqual(store.visible(device), ['B-own']);
    device.signOut();
    assert.deepEqual([...store.visible(device), ...store.derived(device)], []);
    device.signIn('B');
    await settle();
    assert.ok(noA());
    assert.deepEqual(store.visible(device), ['B-own']);
  });
}

test('production default wiring: repositories built over the real localStorage are scoped to storage.js\'s roomCode (appRoomOwner)', () => {
  const saved = { localStorage: globalThis.localStorage, code: globalThis.getChronaSenseRoomCode };
  const storage = memory({ [COMMITMENTS_STORAGE_KEY]: COMMITMENTS.envelope([COMMITMENTS.record('LEGACY', 'clegacy')]), [COARSE_LIFE_EVIDENCE_KEY]: EVIDENCE.envelope([EVIDENCE.record('LEGACY')]) });
  let roomCode = '';
  globalThis.localStorage = storage;
  globalThis.getChronaSenseRoomCode = () => roomCode;
  try {
    const commitments = createCommitmentsRepository({ now: () => T0 });
    const evidence = createCoarseEvidenceRepository();
    assert.equal(commitments.ownerRoomId(), null);
    assert.equal(evidence.ownerRoomId(), null);
    assert.deepEqual(commitments.listAllRaw(), {});
    assert.deepEqual(evidence.list(), []);
    assert.equal(commitments.create({ title: 'x', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }).reason, 'no-account');

    roomCode = ROOM('A');
    assert.equal(commitments.create({ title: 'A-one', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }).ok, true);
    evidence.save({ date: EVIDENCE_DATE, timezone: MANILA, label: 'A-one', estimatedMinutes: 5, now: T0 });
    assert.ok(storage.getItem(commitmentsCacheKeyForRoom(ROOM('A'))));
    assert.ok(storage.getItem(coarseEvidenceCacheKeyForRoom(ROOM('A'))));

    roomCode = ROOM('B');
    assert.deepEqual(commitments.listAllRaw(), {});
    assert.deepEqual(evidence.list(), []);
    assert.deepEqual(getCoarseEvidenceForDate(evidence.list(), EVIDENCE_DATE).records, []);
  } finally {
    globalThis.localStorage = saved.localStorage;
    globalThis.getChronaSenseRoomCode = saved.code;
  }
});

test('a record id or key cannot smuggle a write into another account\'s slot: every read-modify-write resolves ONE slot', () => {
  const storage = memory();
  const auth = { owner: ROOM('A') };
  const commitments = createCommitmentsRepository({ storage, getOwner: () => auth.owner, now: () => T0 });
  const created = commitments.create({ title: 'A-one', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }).record;
  auth.owner = ROOM('B');
  assert.deepEqual(commitments.update(created.id, { title: 'hijack' }), { ok: false, reason: 'not-found' });
  assert.deepEqual(commitments.remove(created.id), { ok: false, reason: 'not-found' });
  assert.deepEqual(commitments.mergeRemote(created.id, { ...created, title: 'B-remote', updatedAt: T0 + 5 }).record?.title, 'B-remote');
  auth.owner = ROOM('A');
  assert.equal(commitments.read(created.id).title, 'A-one', 'A\'s record was never touched from B');
});

// ═══════════════════════════════════════════════════════════════════════════
// defence in depth: each remaining guard pinned by the behaviour it protects
// ═══════════════════════════════════════════════════════════════════════════

test('commitments: pushAllLocal under an owner mismatch is a pure no-op — no attempt, nothing re-queued', async () => {
  const db = makeDatabase();
  const auth = { cacheOwner: ROOM('A'), joined: ROOM('A') };
  const repository = createCommitmentsRepository({ storage: memory(), getOwner: () => auth.cacheOwner, now: () => T0 });
  const bridge = createCommitmentsSyncBridge({ repository, getRoomRef: () => db.ref(`rooms/${auth.joined}`), getRoomId: () => auth.joined });
  const record = repository.create({ title: 'A-one', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }).record;
  assert.equal(await bridge.syncCommitment(record.id), true);
  assert.deepEqual(bridge.pendingPushIds(ROOM('A')), []);
  const writes = db.stats.writes.length;

  auth.joined = ROOM('B');
  assert.equal(await bridge.pushAllLocal({ all: true }), 0);
  assert.deepEqual(bridge.pendingPushIds(ROOM('A')), [], 'nothing was even attempted');
  assert.equal(db.stats.writes.length, writes);
});

test('commitments: A’s offline queue never stops B’s own reconnect from pushing EVERY unsynced B record (per-owner queues)', async () => {
  const db = makeDatabase();
  // B used this device before and has a record that never reached B’s room.
  const bUnsynced = COMMITMENTS.record('B-never-pushed');
  const device = makeDevice(db, { storage: memory({ [COMMITMENTS.slotFor(ROOM('B'))]: COMMITMENTS.envelope([bUnsynced]) }) });
  device.signIn('A');
  await settle();
  device.env.fbRoomRef = null; // Firebase not reachable: A’s write is queued for A
  const queued = device.commitmentsRepo.create({ title: 'A-queued', date: COMMITMENT_DATE, time: '09:30', timezone: MANILA }).record;
  await device.commitmentsSync.syncCommitment(queued.id);
  assert.deepEqual(device.commitmentsSync.pendingPushIds(ROOM('A')), [queued.id]);

  device.signIn('B');
  await settle();
  assert.deepEqual(COMMITMENTS.remote(db, ROOM('B')), ['B-never-pushed'], 'B’s empty queue means B pushes all of B’s own records');
  assert.ok(onlyOwnFacts(db, COMMITMENTS, ROOM('B'), 'B-'));
  assert.deepEqual(device.commitmentsSync.pendingPushIds(ROOM('A')), [queued.id], 'A’s intent is still kept for A');
});

test('coarse life evidence: a reconnect push BEFORE the room’s first snapshot writes nothing; the bootstrap then converges without clobbering a newer remote value', async () => {
  const db = makeDatabase();
  const stale = EVIDENCE.record('B-edited');
  const newer = { ...stale, estimatedMinutes: 50, updatedAt: stale.updatedAt + 500 };
  db.seed(`rooms/${ROOM('B')}/${COARSE_LIFE_EVIDENCE_REMOTE_PATH}/${stale.id}`, newer);
  const device = makeDevice(db, { storage: memory({ [EVIDENCE.slotFor(ROOM('B'))]: EVIDENCE.envelope([stale]) }) });

  db.holdDeliveries();
  device.signIn('B'); // `.info/connected` fires before the listener has answered
  await settle();
  assert.deepEqual(db.writesInto(ROOM('B')), [], 'no diff against a snapshot this room never sent');

  db.releaseDeliveries();
  await settle();
  assert.equal(db.get(`rooms/${ROOM('B')}/${COARSE_LIFE_EVIDENCE_REMOTE_PATH}/${stale.id}`).estimatedMinutes, 50, 'the newer remote edit survived');
  assert.equal(device.evidenceRepo.get(stale.id).estimatedMinutes, 50, 'and was adopted locally');
});
