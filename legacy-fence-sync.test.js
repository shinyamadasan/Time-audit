// legacy-fence-sync.test.js
//
// The legacy store's half of the location-bound Brain Dump fence: plans[dateKey] is synced by
// storage.js, a classic script that cannot import the fence modules and reaches them through
// globalThis (PlanItemOrigin, PlanFenceSync, PlanTomorrowModel). This loads the REAL storage.js into a
// vm sandbox, joins it to a room on a database that enforces the REAL firebase.rules.json, and drives
// syncPlans / the planFences listener path / the exact-child read the way the app does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import targaryen from 'targaryen';

import './plan-tomorrow-model.js';
import './plan-fence-sync.js';
import { partitionOutboundItemsWith } from './plan-item-origin.js';
import { rulesEnforcingDatabase } from './brain-dump-test-support.js';
import { STORES, T, capture, claim, expired, fencedItem, ordinary, promotedCapture } from './fence-rules-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = JSON.parse(readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8'));
const storageSource = readFileSync(path.join(HERE, 'storage.js'), 'utf8');
const UID = 'alice_uid';
const ROOM = `uid_${UID}`;
const DEF = STORES.legacy;
const DATE = DEF.targetId; // '2026-10-03'
const ITEM = 'bdp1|bfence1';
const at = rest => `rooms/${ROOM}/${rest}`;

/** The real storage.js, joined to ROOM on `db`, with the app functions it calls stubbed. */
function load(db, { modules = true, lookup = null } = {}) {
  const store = new Map();
  const sandbox = {
    settings: { timezone: 'Asia/Manila' }, entries: [], plans: {}, fbDb: null, // `plans` and `fbDb` are declared by index.html's inline script in the real app
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear() },
    console: { warn() {}, log() {}, error() {} },
    renderToday() {}, renderTodayPlan() {}, syncCommitmentFromPlan() {}, publishSharedAccountability() {}, showToast() {},
    PlanAuthority: { authorityState: () => 'legacy', invalidate() {} },
    __ref: db.ref(`rooms/${ROOM}`),
  };
  if (modules) {
    sandbox.PlanTomorrowModel = globalThis.PlanTomorrowModel;
    sandbox.PlanFenceSync = globalThis.PlanFenceSync;
    sandbox.PlanItemOrigin = { ...globalThis.PlanItemOrigin, partitionOutboundItems: items => partitionOutboundItemsWith(items, lookup) };
  }
  vm.createContext(sandbox);
  vm.runInContext(storageSource, sandbox);
  vm.runInContext(`roomCode = ${JSON.stringify(ROOM)}; _localStateOwner = roomCode; _fbRoomRefRoom = roomCode; fbRoomRef = __ref;`, sandbox);
  const run = code => vm.runInContext(code, sandbox);
  return {
    sandbox, run,
    setPlan: (dateKey, plan) => { sandbox.plans[dateKey] = plan; },
    plan: dateKey => JSON.parse(JSON.stringify(sandbox.plans[dateKey] || null)),
    sync: dateKey => run(`syncPlans(${JSON.stringify(dateKey)})`),
    hydrateFences: value => { sandbox.__fences = value; return run('applyRemoteFencedLegacyItems(JSON.parse(JSON.stringify(__fences)))'); },
    readFenced: itemId => run(`readRemoteDateFencedItem(${JSON.stringify(DATE)}, ${JSON.stringify(itemId)}, { timeoutMs: 50 })`),
    offline: () => run('fbRoomRef = null'),
    modulesLoaded: () => { sandbox.PlanTomorrowModel = globalThis.PlanTomorrowModel; sandbox.PlanFenceSync = globalThis.PlanFenceSync; sandbox.PlanItemOrigin = { ...globalThis.PlanItemOrigin }; },
  };
}

const newDb = () => rulesEnforcingDatabase({ targaryen, rules: RULES, uid: UID });
const stamp = (item, at = T + 5) => ({ ...item, updatedAt: at, updatedBy: 'dev' });
const planWith = items => ({ items, updatedAt: T + 5, updatedBy: 'dev' });
const itemsOf = record => (Array.isArray(record?.items) ? record.items : Object.values(record?.items || {}));
const authorize = (db, extra = {}) => db.seed(at('brainDump/bfence1'), capture({ promotionClaim: claim(DEF), ...extra }));

test('legacy: syncPlans sends the fenced item to planFences/<dateKey>/<id>; the date record carries ordinary items only', async () => {
  const db = newDb();
  authorize(db);
  const app = load(db);
  app.setPlan(DATE, planWith([ordinary, stamp(fencedItem(DEF))]));
  assert.equal(await app.sync(DATE), true);
  assert.deepEqual(itemsOf(db.read(at(`plans/${DATE}`))).map(i => i.id), ['pnormal1'], 'never inside the array');
  const stored = db.read(at(`planFences/${DATE}/${ITEM}`));
  assert.deepEqual(stored.brainDumpOrigin, { v: 2, claimEpoch: 0, type: 'do-today', store: 'legacy', targetKey: DATE });
  assert.deepEqual(app.plan(DATE).items.map(i => i.id).sort(), [ITEM, 'pnormal1'], 'the local array still exposes both');
  assert.equal(db.denials.length, 0);
});

test('legacy: an unauthorized fenced item is refused by the server and does not block the ordinary plan', async () => {
  const db = newDb();
  db.seed(at('brainDump/bfence1'), capture({ promotionClaim: claim(DEF, { revokedAt: T + 5 }) }));
  const app = load(db);
  app.setPlan(DATE, planWith([ordinary, stamp(fencedItem(DEF))]));
  assert.equal(await app.sync(DATE), false, 'not fully synced');
  assert.equal(db.read(at(`planFences/${DATE}/${ITEM}`)), null, 'the refused item never landed');
  assert.deepEqual(itemsOf(db.read(at(`plans/${DATE}`))).map(i => i.id), ['pnormal1'], 'the ordinary item still synced');
});

test('legacy: a remote tombstone is monotonic locally — a stale live copy with a later clock cannot resurrect it', () => {
  const db = newDb();
  const app = load(db);
  app.setPlan(DATE, planWith([stamp(fencedItem(DEF), T + 500)]));
  const changed = app.hydrateFences({ [DATE]: { [ITEM]: stamp(fencedItem(DEF, { deleted: true }), T + 10) } });
  assert.equal(changed, true);
  assert.equal(app.plan(DATE).items.find(i => i.id === ITEM).deleted, true);
});

test('legacy: an old client\'s whole-record rewrite and this client\'s fenced push coexist', async () => {
  const db = newDb();
  db.seed(at('brainDump/bfence1'), promotedCapture(DEF));
  const app = load(db);
  app.setPlan(DATE, planWith([ordinary, stamp(fencedItem(DEF))]));
  assert.equal(await app.sync(DATE), true);
  db.seed(at(`plans/${DATE}`), { items: [{ ...ordinary, id: 'pnormal2', task: 'second', updatedAt: T + 7 }], updatedAt: T + 7, updatedBy: 'old' });
  assert.equal(db.read(at(`planFences/${DATE}/${ITEM}`)).id, ITEM, 'untouched by the old client');
  app.setPlan(DATE, planWith([ordinary, stamp(fencedItem(DEF, { done: true, doneAt: T + 9 }), T + 9)]));
  assert.equal(await app.sync(DATE), true);
  assert.equal(db.read(at(`planFences/${DATE}/${ITEM}`)).done, true);
  assert.ok(itemsOf(db.read(at(`plans/${DATE}`))).some(i => i.id === 'pnormal2'), 'the old client\'s item survived the merge');
});

test('legacy: fenced items that arrive before the fence modules load are deferred, then folded by replayPendingPlanRemotes', () => {
  const db = newDb();
  const app = load(db, { modules: false });
  assert.equal(app.hydrateFences({ [DATE]: { [ITEM]: stamp(fencedItem(DEF)) } }), false, 'nothing can fold yet');
  assert.equal(app.plan(DATE), null);
  app.modulesLoaded();
  const replay = app.run('replayPendingPlanRemotes()');
  assert.equal(replay.changed, true);
  assert.ok(app.plan(DATE).items.some(i => i.id === ITEM));
});

test('legacy: sync with the fence modules missing fails LOUD and writes nothing (never pushes a fenced item into the array)', async () => {
  const db = newDb();
  authorize(db);
  const app = load(db, { modules: false });
  app.sandbox.PlanTomorrowModel = globalThis.PlanTomorrowModel;
  app.setPlan(DATE, planWith([ordinary, stamp(fencedItem(DEF))]));
  assert.equal(await app.sync(DATE), false);
  assert.equal(db.read(at(`plans/${DATE}`)), null, 'zero writes');
  assert.equal(db.denials.length, 0);
});

test('legacy: the exact-child read: absent, present, and unknown when offline', async () => {
  const db = newDb();
  const app = load(db);
  assert.deepEqual(await app.readFenced(ITEM), { ok: true, value: null }, 'a missing child is a provable absence');
  db.seed(at(`planFences/${DATE}/${ITEM}`), fencedItem(DEF));
  const present = await app.readFenced(ITEM);
  assert.equal(present.ok, true);
  assert.equal(present.value.id, ITEM);
  db.seed(at(`planFences/${DATE}/${ITEM}`), null);
  db.seed(at(`plans/${DATE}`), { items: [{ id: ITEM, task: 'array copy' }], updatedAt: T });
  assert.deepEqual(await app.readFenced(ITEM), { ok: true, value: null }, 'never inferred from the array');
  app.offline();
  assert.equal((await app.readFenced(ITEM)).ok, false, 'offline: unknown, never absent');
});

test('legacy: queue guard — a provably superseded ghost is purged from this cache only: no remote write, no tombstone', async () => {
  const db = newDb();
  db.seed(at('brainDump/bfence1'), capture({ claimEpoch: 1, expiredClaim: expired(DEF) }));
  const app = load(db, { lookup: id => (id === 'bfence1' ? capture({ claimEpoch: 1 }) : null) });
  app.setPlan(DATE, planWith([ordinary, stamp(fencedItem(DEF))]));
  assert.equal(await app.sync(DATE), true);
  assert.equal(db.denials.length, 0, 'withheld: not even one denied write');
  assert.equal(db.read(at(`planFences/${DATE}/${ITEM}`)), null, 'nothing — not even a tombstone — was written');
  assert.deepEqual(app.plan(DATE).items.map(i => i.id), ['pnormal1']);
});
