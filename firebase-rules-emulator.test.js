// firebase-rules-emulator.test.js
//
// The Brain Dump promotion fence (firebase.rules.json), proven against the REAL
// Firebase Realtime Database emulator, not an interpreter. Cross-path rules (a plan
// item's validity depends on rooms/<room>/brainDump/<captureId>) are exactly where a
// rules interpreter and the real server could disagree, so this file boots the
// emulator jar, loads the real firebase.rules.json, and drives it over REST with
// unsigned emulator auth tokens (`?auth=`), the emulator's own testing contract.
//
// Needs Java and the cached emulator jar (firebase-tools' cache, or
// FIREBASE_DATABASE_EMULATOR_JAR). Run: npm run test:rules-emulator
// It FAILS (never silently skips) when either is missing: a fence that was not
// exercised is not proven.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8');
const JAR = process.env.FIREBASE_DATABASE_EMULATOR_JAR
  || path.join(os.homedir(), '.cache', 'firebase', 'emulators', 'firebase-database-emulator-v4.11.2.jar');

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = uid => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: uid, user_id: uid, uid, iat: 1, exp: 9999999999, aud: 'demo', iss: 'https://securetoken.google.com/demo', auth_time: 1, firebase: { sign_in_provider: 'custom' } })}.`;
const ALICE = token('alice');
const MALLORY = token('mallory');
const ROOM = 'rooms/uid_alice';

let emulator = null;
let base = '';
let ns = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

test.before(async () => {
  assert.ok(existsSync(JAR), `the RTDB emulator jar is required (looked for ${JAR}); set FIREBASE_DATABASE_EMULATOR_JAR`);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  emulator = spawn('java', ['-jar', JAR, '--port', String(port)], { stdio: 'ignore' });
  emulator.on('error', err => { throw new Error(`java could not start the emulator: ${err.message}`); });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${base}/.json?ns=boot`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('the RTDB emulator did not come up');
});

test.after(() => { if (emulator) emulator.kill(); });

/** A fresh, isolated namespace per test, loaded with the REAL rules. */
async function freshDb() {
  const name = `fence${++ns}x${Date.now()}`;
  const r = await fetch(`${base}/.settings/rules.json?ns=${name}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: RULES });
  assert.equal(r.status, 200, `rules load: ${await r.text()}`);
  const call = (method, at, body, auth) => fetch(`${base}/${at}.json?ns=${name}${auth ? `&auth=${auth}` : ''}`, {
    method, headers: auth ? undefined : { Authorization: 'Bearer owner' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    /** As the room owner (or `as`): true iff the server ALLOWED the write. */
    async write(at, value, as = ALICE) { const r = await call('PUT', at, value, as); return r.status === 200; },
    /** Seeds data as an admin (bypassing rules), to set up the starting state. */
    async seed(at, value) { const r = await call('PUT', at, value, null); assert.equal(r.status, 200); },
    async read(at) { const r = await call('GET', at, undefined, null); return r.json(); },
  };
}

const T = 1790816400000;
const CAPTURE = 'bfence1';
const ITEM_ID = `bdp1|${CAPTURE}`;
const TARGET = 'cal1:2026-10-03';
const capture = (extra = {}) => ({ schemaVersion: 2, id: CAPTURE, text: 'x', createdAt: T, updatedAt: T, updatedBy: 'd', status: 'triaged', important: true, urgent: false, triagedAt: T, reopenCount: 0, ...extra });
const claim = (extra = {}) => ({ type: 'do-today', store: 'calendar', targetId: TARGET, planItemId: ITEM_ID, when: '', claimedAt: T + 1, claimedBy: 'd', ...extra });
const origin = (extra = {}) => ({ v: 1, claimEpoch: 0, type: 'do-today', targetId: TARGET, ...extra });
const bdItem = (extra = {}) => ({ id: ITEM_ID, task: 'x', when: '', done: false, updatedAt: T, updatedBy: 'd', kind: 'task', brainDumpOrigin: origin(), ...extra });
const normal = { id: 'pnormal1', task: 'ordinary', when: '', done: false, updatedAt: T, updatedBy: 'd' };

const STORES = [
  ['calendar', `${ROOM}/calendarPlans/${TARGET}`],
  ['legacy', `${ROOM}/plans/2026-10-03`],
  ['operational', `${ROOM}/operationalPlans/odv1~2026-10-03`],
];
const plan = items => ({ items, updatedAt: T, updatedBy: 'd' });

for (const [store, at] of STORES) {
  test(`${store}: ordinary owner items unchanged; strangers denied; a current claim's fenced item is accepted`, async () => {
    const db = await freshDb();
    assert.equal(await db.write(at, plan([normal])), true, 'ordinary owner item');
    assert.equal(await db.write(at, plan([{ ...normal, task: 'edited' }])), true, 'ordinary owner edit');
    assert.equal(await db.write(at, plan([normal]), MALLORY), false, 'stranger');
    await db.seed(`${ROOM}/brainDump/${CAPTURE}`, capture({ promotionClaim: claim() }));
    assert.equal(await db.write(at, plan([normal, bdItem()])), true, 'the current generation');
  });

  test(`${store}: the fence refuses every unauthorized Brain Dump item`, async () => {
    const db = await freshDb();
    await db.seed(`${ROOM}/brainDump/${CAPTURE}`, capture({ promotionClaim: claim() }));
    const refused = {
      'stale generation (origin epoch 0, capture now epoch 1)': async () => { await db.seed(`${ROOM}/brainDump/${CAPTURE}/claimEpoch`, 1); return bdItem(); },
      'wrong target': async () => bdItem({ brainDumpOrigin: origin({ targetId: 'cal1:2026-10-09' }) }),
      'wrong type': async () => bdItem({ brainDumpOrigin: origin({ type: 'schedule' }) }),
      'missing origin': async () => { const item = bdItem(); delete item.brainDumpOrigin; return item; },
      'unknown origin version': async () => bdItem({ brainDumpOrigin: origin({ v: 2 }) }),
      'wrong capture (no claim there)': async () => bdItem({ id: 'bdp1|bnobody', brainDumpOrigin: origin() }),
    };
    for (const [label, build] of Object.entries(refused)) {
      await db.seed(`${ROOM}/brainDump/${CAPTURE}`, capture({ promotionClaim: claim() }));
      const item = await build();
      assert.equal(await db.write(at, plan([normal, item])), false, label);
    }
    // A REVOKED claim authorizes nothing.
    await db.seed(`${ROOM}/brainDump/${CAPTURE}`, capture({ promotionClaim: claim({ revokedAt: T + 5 }) }));
    assert.equal(await db.write(at, plan([normal, bdItem()])), false, 'revoked claim');
    // A RECOVERED capture (claim resolved as expired, epoch moved on) authorizes nothing of the old generation.
    await db.seed(`${ROOM}/brainDump/${CAPTURE}`, capture({ claimEpoch: 1, expiredClaim: { ...claim(), expiredAt: T + 6, expiredBy: 'b' } }));
    assert.equal(await db.write(at, plan([normal, bdItem()])), false, 'recovered capture');
    assert.equal(await db.write(at, plan([normal])), true, 'the day itself stays writable once the stale item is gone');
  });

  test(`${store}: a finalized promotion keeps its item normally editable, but its origin cannot be changed to escape the fence`, async () => {
    const db = await freshDb();
    const promoted = capture({ status: 'promoted', disposedAt: T + 3, promotion: { type: 'do-today', store: 'calendar', targetId: TARGET, planItemId: ITEM_ID, intentRecorded: true, when: '', promotedAt: T + 3 } });
    await db.seed(`${ROOM}/brainDump/${CAPTURE}`, promoted);
    assert.equal(await db.write(at, plan([normal, bdItem()])), true, 'promoted item');
    assert.equal(await db.write(at, plan([normal, bdItem({ task: 'renamed', when: '15:00', durationMinutes: 45, updatedAt: T + 9 })])), true, 'rename / retime');
    assert.equal(await db.write(at, plan([normal, bdItem({ done: true, doneAt: T + 10, updatedAt: T + 10 })])), true, 'toggle done');
    assert.equal(await db.write(at, plan([normal, bdItem({ deleted: true, updatedAt: T + 11 })])), true, 'delete (tombstone)');
    for (const forged of [origin({ claimEpoch: 3 }), origin({ targetId: 'cal1:2026-10-09' }), origin({ type: 'schedule' })]) {
      assert.equal(await db.write(at, plan([normal, bdItem({ brainDumpOrigin: forged })])), false, `forged origin ${JSON.stringify(forged)}`);
    }
  });
}

test('late stale write after recovery: refused by the server; the plan stays without it, the capture stays recovered', async () => {
  const db = await freshDb();
  const at = `${ROOM}/calendarPlans/${TARGET}`;
  await db.seed(`${ROOM}/brainDump/${CAPTURE}`, capture({ promotionClaim: claim() }));
  await db.seed(at, plan([normal]));
  // Device B: revoke, read (absent), recover.
  assert.equal(await db.write(`${ROOM}/brainDump/${CAPTURE}`, capture({ promotionClaim: claim({ revokedAt: T + 5 }) })), true, 'revoke');
  assert.equal(await db.write(at, plan([normal, bdItem()])), false, 'a push between revoke and read is already refused');
  assert.equal(await db.write(`${ROOM}/brainDump/${CAPTURE}`, capture({ claimEpoch: 1, updatedAt: T + 6, expiredClaim: { ...claim(), expiredAt: T + 6, expiredBy: 'b' } })), true, 'recover');
  // Device A finally reconnects and pushes its OLD queued item.
  assert.equal(await db.write(at, plan([normal, bdItem()])), false, 'old item refused');
  const remote = await db.read(at);
  assert.deepEqual(remote.items.map(i => i.id), ['pnormal1'], 'no old item remotely');
  assert.equal((await db.read(`${ROOM}/brainDump/${CAPTURE}`)).claimEpoch, 1);
});

for (const order of ['old push first', 'new push first']) {
  test(`recovery then a NEW promotion (${order}): the old generation is refused, the new one accepted, exactly one destination`, async () => {
    const db = await freshDb();
    const oldAt = `${ROOM}/calendarPlans/${TARGET}`;
    const newTarget = 'cal1:2026-10-05';
    const newAt = `${ROOM}/calendarPlans/${newTarget}`;
    // Recovered (epoch 1), then the owner promoted again: a new claim at epoch 1 for a new day.
    await db.seed(`${ROOM}/brainDump/${CAPTURE}`, capture({ claimEpoch: 1, promotionClaim: claim({ targetId: newTarget, claimedAt: T + 20 }), expiredClaim: { ...claim(), expiredAt: T + 6, expiredBy: 'b' } }));
    const pushOld = () => db.write(oldAt, plan([bdItem()]));
    const pushNew = () => db.write(newAt, plan([bdItem({ brainDumpOrigin: origin({ claimEpoch: 1, targetId: newTarget }) })]));
    const results = order === 'old push first' ? [await pushOld(), await pushNew()] : [await pushNew(), await pushOld()].reverse();
    assert.deepEqual(results, [false, true], '[old, new]');
    assert.equal(await db.read(oldAt), null, 'no old destination');
    assert.equal((await db.read(newAt)).items.length, 1, 'exactly the new destination');
  });
}

test('the capture record itself: claimEpoch never moves backwards, a revoke is never undone, schemaVersion never drops', async () => {
  const db = await freshDb();
  const at = `${ROOM}/brainDump/${CAPTURE}`;
  await db.seed(at, capture({ claimEpoch: 2 }));
  assert.equal(await db.write(at, capture({ claimEpoch: 1 })), false, 'claimEpoch 2 -> 1');
  assert.equal(await db.write(at, capture({})), false, 'claimEpoch 2 -> absent (0)');
  assert.equal(await db.write(at, capture({ claimEpoch: 3 })), true, 'claimEpoch 2 -> 3');
  await db.seed(at, capture({ promotionClaim: claim({ revokedAt: T + 5 }) }));
  assert.equal(await db.write(at, capture({ promotionClaim: claim() })), false, 'un-revoke the same claim');
  assert.equal(await db.write(at, capture({ claimEpoch: 1, expiredClaim: { ...claim(), expiredAt: T + 6, expiredBy: 'b' } })), true, 'resolve it (recover)');
  assert.equal(await db.write(at, { ...capture({ claimEpoch: 1 }), schemaVersion: 1 }), false, 'schemaVersion 2 -> 1');
  // A legacy (generation 1, no epoch) capture keeps working for an old client.
  await db.seed(`${ROOM}/brainDump/blegacy1`, { schemaVersion: 1, id: 'blegacy1', text: 'old', createdAt: T, updatedAt: T, updatedBy: 'old', status: 'untriaged' });
  assert.equal(await db.write(`${ROOM}/brainDump/blegacy1`, { schemaVersion: 1, id: 'blegacy1', text: 'old', createdAt: T, updatedAt: T + 1, updatedBy: 'old', status: 'archived', disposedAt: T + 1 }), true, 'old client, legacy record');
});
