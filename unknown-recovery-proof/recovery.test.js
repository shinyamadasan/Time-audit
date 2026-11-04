import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { CANCEL, cancellationRules, createRecoveryProof, reconcileCandidate } from './recovery.js';
await import('./baseline-time-ack.js'); // preserved 9b0671b counterexamples, not the repaired lifecycle
const core = globalThis.TimeAckCore;
const canonical = readFileSync(new URL('../firebase.rules.json', import.meta.url), 'utf8');
let emulator, sequence = 0;
before(async () => { emulator = await startEmulator(); });
after(() => emulator?.stop());
const memory = () => { const data = new Map(); return {
  getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
}; };
function mutex() {
  let tail = Promise.resolve();
  return (_owner, fn) => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
}

async function setup(uid, rules = cancellationRules()) {
  const w = await emulator.fresh(rules), owner = `uid_${uid}`, storage = memory(), lock = mutex();
  const timer = { ownerRoom: owner, ownerDeviceId: 'device-a', running: true, taskStartTime: 1800000,
    blockStartTime: 1800000, trackingStartedAt: 1200000, updatedAt: 1800000 };
  const entry = { id: 1, tsStart: 1200000, ts: 1800000, blockIntervalMin: 10, updatedAt: 1800000,
    activity: 'Work', energy: 'deep', custom: { note: '資料 😀', tags: ['retain'] } };
  const history = { id: 2, tsStart: 1, ts: 600001, blockIntervalMin: 10, updatedAt: 600001, activity: 'History' };
  const redemption = { id: 3, activity: 'Reward', updatedAt: 1800000 };
  await w.seed(`rooms/${owner}`, { timer, entries: { e_1: entry, e_2: history }, focusRedemptions: { r_3: redemption } });
  const call = async (method, path, value, as = uid) => fetch(`${emulator.base}/rooms/${owner}${path ? '/' + path : ''}.json?ns=${w.name}&auth=${token(as)}`, {
    method, body: value === undefined ? undefined : JSON.stringify(value), cache: 'no-store',
  });
  const original = core.createRestTransport({ databaseURL: `${emulator.base}?ns=${w.name}`,
    getIdToken: async () => token(uid), fetchImpl: (url, init) => {
      if (init.method === 'PATCH') throw new Error('original request delayed before delivery');
      return fetch(url, init);
    } });
  const engine = core.createTimeAck({ storage, lock, transport: original, randomId: () => `op_recovery_${++sequence}` });
  const records = { 'entries/e_1': { ...entry, deleted: true, updatedAt: 2000000 },
    timer: { ...timer, taskStartTime: 1200000, blockStartTime: 1200000, updatedAt: 2000000 },
    'focusRedemptions/r_3': { ...redemption, deleted: true, updatedAt: 2000000 } };
  const operation = (await engine.begin({ owner, uid, device: 'device-a', session: 1200000,
    label: 'log', actionCreatedAt: 1800000, records, agrees: () => true,
    local: { records: { 'entries/e_1': entry, 'focusRedemptions/r_3': redemption } }, proposedLocal: {} })).operation;
  assert.equal(operation.phase, 'unknown');
  const transport = {
    async cancel(room, id) {
      assert.equal(room, owner);
      const response = await call('PUT', `${CANCEL}/${id}`, true);
      if (response.status !== 200) throw new Error('cancel refused');
    },
    async readAccount(room) {
      assert.equal(room, owner);
      const response = await call('GET', '');
      if (response.status !== 200) throw new Error('read refused');
      return response.json();
    },
  };
  const options = { storage, lock, transport, attached: op => op.owner === owner && op.device === 'device-a' };
  return { w, owner, storage, lock, call, engine, operation, transport, options, timer, entry, history, redemption,
    keep: createRecoveryProof(options),
    deliver: () => call('PATCH', '', operation.patch),
    local: { timer, entries: [entry, history], focusRedemptions: [redemption] },
  };
}
const candidate = (env, proof, local = env.local) => reconcileCandidate({ proof, operation: env.operation, local, same: core.same });

for (const uid of ['alice', 'bob']) {
  test(`${uid}: permanent fence rejects original and duplicate after >120s; intent remains byte-identical`, async () => {
    const env = await setup(uid), original = JSON.stringify(env.operation);
    const proof = await env.keep(env.owner, env.operation);
    assert.equal(proof.status, 'fenced');
    // Logical clock advances by one day; no real sleep, timeout, lease or marker expiry.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 86400000;
      for (let duplicate = 0; duplicate < 3; duplicate++) assert.equal((await env.deliver()).status, 401);
    } finally { Date.now = realNow; }
    const server = await env.transport.readAccount(env.owner);
    assert.deepEqual(server.timer, env.timer);
    assert.deepEqual(server.entries.e_1, env.entry);
    assert.deepEqual(server.focusRedemptions.r_3, env.redemption);
    assert.equal(JSON.stringify(env.operation), original);
    assert.equal(JSON.stringify(env.engine.openOperation(env.owner)), original, 'original UNKNOWN is never silently retired');
    assert.deepEqual(candidate(env, proof).cursor, { taskStartTime: 1800000, blockStartTime: 1800000,
      trackingStartedAt: 1200000, timerOwnerDeviceId: 'device-a' });
  });

  test(`${uid}: exact original wins before cancellation; keep reconciles committed server version, never original local cursor`, async () => {
    const env = await setup(uid);
    assert.equal((await env.deliver()).status, 200);
    const proof = await env.keep(env.owner, env.operation), reconciled = candidate(env, proof);
    assert.equal(reconciled.status, 'candidate');
    assert.equal(reconciled.entries.find(e => e.id === 1).deleted, true);
    assert.equal(reconciled.cursor.taskStartTime, 1200000);
    assert.deepEqual(reconciled.entries.find(e => e.id === 2), env.history);
    assert.equal((await env.deliver()).status, 401);
  });

  test(`${uid}: never-landed + concurrent edit has an exit candidate; all server fields and other device cursor retained`, async () => {
    const env = await setup(uid);
    const edited = { ...env.entry, note: 'Concurrent edit', updatedAt: 3000000 };
    const timer = { ...env.timer, ownerDeviceId: 'device-b', taskStartTime: 3000000, updatedAt: 3000000 };
    assert.equal((await env.call('PATCH', '', { 'entries/e_1': edited, timer })).status, 200);
    const proof = await env.keep(env.owner, env.operation), reconciled = candidate(env, proof);
    assert.equal(reconciled.status, 'candidate');
    assert.deepEqual(reconciled.entries.find(e => e.id === 1), edited);
    assert.equal(reconciled.cursor.timerOwnerDeviceId, 'device-b');
    assert.equal(reconciled.cursor.taskStartTime, 3000000);
    assert.equal((await env.deliver()).status, 401);
  });

  test(`${uid}: lost cancellation reply, reload, two tabs and offline read retain intent then recover the same fence`, async () => {
    const env = await setup(uid);
    const lost = createRecoveryProof({ ...env.options, transport: { ...env.transport,
      cancel: async (...args) => { await env.transport.cancel(...args); throw new Error('reply lost'); } } });
    assert.equal((await lost(env.owner, env.operation)).status, 'unknown');
    assert.equal((await env.deliver()).status, 401, 'fence landed despite lost reply');
    const offline = createRecoveryProof({ ...env.options, transport: { ...env.transport,
      readAccount: async () => { throw new Error('offline'); } } });
    assert.equal((await offline(env.owner, env.operation)).status, 'unknown');
    assert.equal(env.engine.openOperation(env.owner).id, env.operation.id);
    const reload = createRecoveryProof(env.options), secondTab = createRecoveryProof(env.options);
    const results = await Promise.all([reload(env.owner, env.operation), secondTab(env.owner, env.operation)]);
    assert.deepEqual(results.map(result => result.status), ['fenced', 'fenced']);
    assert.equal((await env.deliver()).status, 401);
  });

  test(`${uid}: cancellation cannot be deleted/replaced or removed atomically with a replay`, async () => {
    const env = await setup(uid);
    await env.keep(env.owner, env.operation);
    for (const value of [null, false, { cancelled: true }]) {
      assert.equal((await env.call('PUT', `${CANCEL}/${env.operation.id}`, value)).status, 401);
    }
    assert.equal((await env.call('PUT', CANCEL, null)).status, 401);
    assert.equal((await env.call('PUT', '', {})).status, 401);
    assert.equal((await env.call('PATCH', '', { ...env.operation.patch, [`${CANCEL}/${env.operation.id}`]: null })).status, 401);
    assert.equal((await env.call('PUT', 'entries/e_1', env.operation.patch['entries/e_1'])).status, 401);
    assert.equal((await env.call('PUT', 'timer', env.operation.patch.timer)).status, 401);
    assert.equal((await env.call('PUT', 'focusRedemptions/r_3', env.operation.patch['focusRedemptions/r_3'])).status, 401);
  });

  test(`${uid}: other account cannot cancel/read; attachment change during read blocks application`, async () => {
    const env = await setup(uid), other = uid === 'alice' ? 'bob' : 'alice';
    assert.equal((await env.call('PUT', `${CANCEL}/${env.operation.id}`, true, other)).status, 401);
    assert.equal((await env.call('GET', '', undefined, other)).status, 401);
    let attached = true;
    const keep = createRecoveryProof({ ...env.options, attached: () => attached, transport: { ...env.transport,
      readAccount: async room => { const snapshot = await env.transport.readAccount(room); attached = false; return snapshot; } } });
    assert.deepEqual(await keep(env.owner, env.operation), { status: 'blocked', reason: 'account-device-context' });
  });

  test(`${uid}: concurrent post-fence edit survives; cancellation adds no revision or domain rewrite`, async () => {
    const env = await setup(uid);
    const edited = { ...env.entry, activity: 'Edited after fence', updatedAt: 4000000 };
    const keep = createRecoveryProof({ ...env.options, transport: { ...env.transport,
      cancel: async (...args) => { await env.transport.cancel(...args); assert.equal((await env.call('PUT', 'entries/e_1', edited)).status, 200); } } });
    const reconciled = candidate(env, await keep(env.owner, env.operation));
    assert.deepEqual(reconciled.entries.find(e => e.id === 1), edited);
    assert.equal((await env.deliver()).status, 401);
    assert.deepEqual((await env.transport.readAccount(env.owner)).entries.e_1, edited);
  });

  test(`${uid}: local-only automatic logs are blocked, never erased by authoritative replacement`, async () => {
    const env = await setup(uid), proof = await env.keep(env.owner, env.operation);
    const local = { ...env.local, entries: [...env.local.entries, { id: 10, tsStart: 1800000, ts: 2400000, activity: 'Break' }] };
    assert.deepEqual(candidate(env, proof, local), { status: 'blocked', reason: 'unreconciled-local-accounting' });
    assert.equal(local.entries.length, 3);
    assert.equal(env.engine.openOperation(env.owner).phase, 'unknown');
  });

  test(`${uid}: canonical rules fail closed; no local-only marker can release UNKNOWN`, async () => {
    const env = await setup(uid, canonical);
    assert.equal((await env.keep(env.owner, env.operation)).status, 'unknown');
    assert.equal(env.engine.openOperation(env.owner).phase, 'unknown');
    assert.equal((await env.deliver()).status, 200, 'negative control: original remains possible without server fence');
  });

  test(`${uid}: legacy 120s abandon can retire UNKNOWN and still allow its delayed original to apply`, async () => {
    const env = await setup(uid, canonical);
    await env.engine.recover(env.owner);
    const key = `${core.STORAGE_BASE}:${env.owner}`, envelope = JSON.parse(env.storage.getItem(key));
    envelope.operation.lastAttemptAt -= 180000;
    env.storage.setItem(key, JSON.stringify(envelope));
    assert.equal((await env.engine.abandon(env.owner)).abandoned, true);
    assert.equal(env.engine.openOperation(env.owner), null);
    assert.equal((await env.deliver()).status, 200, 'request held for >120s can still commit after local retirement');
    assert.equal((await env.transport.readAccount(env.owner)).entries.e_1.deleted, true);
  });

  test(`${uid}: local stopped/moved timer cannot be discarded during server reconciliation`, async () => {
    const env = await setup(uid), proof = await env.keep(env.owner, env.operation);
    const local = { ...env.local, timer: { ...env.timer, running: false, taskStartTime: 2400000 } };
    assert.deepEqual(candidate(env, proof, local), { status: 'blocked', reason: 'unreconciled-local-timer' });
    assert.equal(env.engine.openOperation(env.owner).phase, 'unknown');
  });

  test(`${uid}: commit with lost response then replacement of every stamp still yields the current account snapshot`, async () => {
    const env = await setup(uid);
    assert.equal((await env.deliver()).status, 200);
    const timer = { ...env.timer, taskStartTime: 5000000, blockStartTime: 5000000, updatedAt: 5000000 };
    const entry = { ...env.entry, deleted: true, note: 'After uncertain commit', updatedAt: 5000000 };
    const redemption = { ...env.redemption, deleted: true, updatedAt: 5000000 };
    assert.equal((await env.call('PATCH', '', { timer, 'entries/e_1': entry, 'focusRedemptions/r_3': redemption })).status, 200);
    assert.equal((await env.engine.recover(env.owner)).phase, 'unknown', 'no surviving original stamp or before-image');
    const reconciled = candidate(env, await env.keep(env.owner, env.operation));
    assert.equal(reconciled.status, 'candidate');
    assert.deepEqual(reconciled.timer, timer);
    assert.deepEqual(reconciled.entries.find(e => e.id === 1), entry);
    assert.equal((await env.deliver()).status, 401);
  });

  test(`${uid}: original delivery racing the fence is all-or-nothing and cannot apply again`, async () => {
    const env = await setup(uid);
    const [response, proof] = await Promise.all([env.deliver(), env.keep(env.owner, env.operation)]);
    assert.ok([200, 401].includes(response.status));
    assert.equal(proof.status, 'fenced');
    const snapshot = proof.snapshot;
    assert.equal(!!snapshot.entries.e_1.deleted, response.status === 200);
    assert.equal(snapshot.timer.taskStartTime, response.status === 200 ? 1200000 : 1800000);
    assert.equal(!!snapshot.focusRedemptions.r_3.deleted, response.status === 200);
    assert.equal((await env.deliver()).status, 401);
  });
}

test('predicate mutation: removing the cancellation check lets the exact delayed original land', async () => {
  const rules = cancellationRules();
  const canonicalRoom = JSON.parse(canonical).rules.rooms.$roomId;
  rules.rules.rooms.$roomId.timer = canonicalRoom.timer;
  rules.rules.rooms.$roomId.entries = canonicalRoom.entries;
  rules.rules.rooms.$roomId.focusRedemptions = canonicalRoom.focusRedemptions;
  const env = await setup('alice', rules);
  assert.equal((await env.keep(env.owner, env.operation)).status, 'fenced');
  assert.equal((await env.deliver()).status, 200, 'readback alone is not proof of enforcement');
});

test('resolution survives changed observation metadata; changed original payload is refused before any send', async () => {
  const env = await setup('alice');
  assert.equal((await env.keep(env.owner, env.operation)).status, 'fenced');
  const observed = { ...env.operation, attempts: 2, evidence: { authority: 'server-read', match: 'other' } };
  assert.equal((await env.keep(env.owner, observed)).status, 'fenced');
  const changed = structuredClone(observed); changed.patch.timer.taskStartTime++;
  await assert.rejects(env.keep(env.owner, changed), /Original intent changed/);
});

test('wall-clock >120s: queued original bytes for both accounts remain denied after permanent cancellation', { timeout: 150000 }, async () => {
  const envs = await Promise.all(['alice', 'bob'].map(uid => setup(uid)));
  const started = performance.now();
  const proofs = await Promise.all(envs.map(env => env.keep(env.owner, env.operation)));
  assert.deepEqual(proofs.map(proof => proof.status), ['fenced', 'fenced']);
  // This is deliberately real elapsed time, in addition to the deterministic one-day age tests.
  // Hold the original bytes outside the server, as a delayed network request can be held.
  await new Promise(resolve => setTimeout(resolve, 125000));
  assert.ok(performance.now() - started > 120000);
  for (const env of envs) {
    assert.equal((await env.deliver()).status, 401);
    assert.equal((await env.deliver()).status, 401, 'duplicate still denied');
    assert.deepEqual((await env.transport.readAccount(env.owner)).timer, env.timer);
  }
});
