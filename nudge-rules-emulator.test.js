import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startEmulator, token } from './rtdb-emulator-support.js';
import { connectSdk } from './rtdb-sdk-support.js';
import { nudgeHarness } from './nudge-test-support.js';

const rules = JSON.parse(readFileSync(new URL('./firebase.rules.json', import.meta.url), 'utf8'));
const inbox = 'uid_alice/nudges';
const item = { from: 'Bob', ts: 100_000 };
const ALICE = token('alice'), BOB = token('bob'), CAROL = token('carol');
let emulator;
const connections = [];
test.before(async () => { emulator = await startEmulator(); });
test.after(async () => { await Promise.all(connections.map(c => c.close())); emulator?.stop(); });
async function world(document = rules) {
  const db = await emulator.fresh(document);
  await db.seed('uid_alice', { partnerUid: 'bob', nudges: { n1: item, n2: item } });
  await db.seed('uid_bob', { partnerUid: 'alice' });
  await db.seed('uid_carol', { partnerUid: 'alice' }); // attacker self-claim grants nothing
  return db;
}
function connect(db) {
  const c = connectSdk(emulator, db);
  connections.push(c);
  return c;
}
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function legacyRules() {
  const legacy = structuredClone(rules);
  legacy.rules.$userNode.nudges = {
    '.read': rules.rules.$userNode.nudges['.read'],
    '.write': rules.rules.$userNode.nudges['.write'].replace("$userNode !== ('uid_' + auth.uid) && ", ''),
  };
  return legacy;
}

test('real SDK: original recipient remove is denied and repeatedly restores child_added', async () => {
  const db = await world(legacyRules());
  const ref = connect(db).ref(`${inbox}/n1`).parent;
  let added = 0;
  const denials = [];
  // Original behavior, bounded after three deliveries to avoid leaving the known runaway listener live.
  ref.on('child_added', snap => {
    if (snap.key !== 'n1') return;
    added++;
    if (added >= 3) { ref.off(); return; }
    denials.push(snap.ref.remove().then(() => false, err => /permission/i.test(err.code)));
  });
  await until(() => added === 3, 'three restored deliveries');
  assert.deepEqual(await Promise.all(denials), [true, true]);
  assert.deepEqual(await db.read(`${inbox}/n1`), item, 'failed deletes never removed server truth');
});

test('real SDK: fixed listener stays idle after rejection and reattach, and delivers a new ID', async () => {
  const db = await world(legacyRules());
  const c = connect(db);
  const writes = [], warnings = [], toasts = [];
  const guarded = nudgeHarness({ warn: (...args) => warnings.push(args) });
  const ref = c.ref(inbox);
  let deliveries = 0;
  const counted = { off: () => ref.off(), on: (event, callback) => ref.on(event, snap => {
    deliveries++;
    callback({ key: snap.key, val: () => snap.val(), ref: { remove: () => {
      writes.push(snap.key); return snap.ref.remove();
    } } });
  }) };
  let detach = guarded.attach('alice', counted, text => toasts.push(text));
  await until(() => warnings.length === 2 && deliveries >= 4, 'one failed attempt and rollback per initial child');
  assert.equal(writes.length, 2); assert.equal(toasts.length, 2);
  detach();
  detach = guarded.attach('alice', counted, text => toasts.push(text));
  await until(() => deliveries >= 6, 'reattached initial children');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(writes.length, 2); assert.equal(toasts.length, 2);
  assert.equal(await db.write(`${inbox}/n3`, item, BOB), true);
  await until(() => warnings.length === 3, 'new ID attempt');
  assert.equal(writes.length, 3); assert.equal(toasts.length, 3);
  detach();
});

test('real SDK: candidate rules allow recipient cleanup with no replay or lost new delivery', async () => {
  const db = await world(), c = connect(db), toasts = [], warnings = [];
  const ref = c.ref(inbox);
  const detach = nudgeHarness({ warn: (...args) => warnings.push(args) }).attach('alice', ref, text => toasts.push(text));
  await until(() => toasts.length === 2, 'initial delivery');
  // Read with the same SDK connection: queued removals settle before its server read completes.
  await ref.once('value');
  for (let i = 0; i < 100 && await db.read(inbox); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await db.read(inbox), null);
  assert.equal(warnings.length, 0);
  assert.equal(await db.write(`${inbox}/n3`, item, BOB), true);
  await until(() => toasts.length === 3, 'new partner nudge');
  detach();
});

test('recipient deletes individual children only; creation, replacement, edits and parent/root writes denied', async () => {
  const db = await world();
  for (const [at, value] of [
    [`${inbox}/new`, item], [`${inbox}/n1`, { ...item, from: 'forged' }],
    [`${inbox}/n1/from`, 'forged'], [`${inbox}/n1/from`, null],
    [inbox, null], [inbox, { n1: item }], ['uid_alice', null], ['', null],
  ]) assert.equal(await db.write(at, value, ALICE), false, `recipient denied: ${at}`);
  assert.equal(await db.write(`${inbox}/n1`, null, ALICE), true);
  assert.deepEqual(await db.read(`${inbox}/n2`), item, 'sibling preserved');
  assert.equal(await db.write(`${inbox}/n1`, item, ALICE), false, 'cannot recreate deleted child');
});

test('partner delivery preserved; strangers, former partners, unauthenticated and scoped action tokens denied', async () => {
  const db = await world();
  assert.equal(await db.write(`${inbox}/new`, item, BOB), true);
  for (const auth of [CAROL, token('alice', { chronasenseActionId: 'act1_test' }),
    token('bob', { chronasenseActionId: 'act1_test' })]) {
    for (const value of [null, item]) assert.equal(await db.write(`${inbox}/n1`, value, auth), false);
  }
  assert.equal(await db.write('uid_bob/nudges/n1', null, CAROL), false);
  const anonymous = await fetch(`${emulator.base}/${inbox}/n1.json?ns=${db.name}`, { method: 'PUT', body: 'null' });
  assert.equal(anonymous.status, 401);
  await db.seed('uid_alice/partnerUid', 'carol');
  assert.equal(await db.write(`${inbox}/new`, item, BOB), false, 'unlinked sender revoked');
  await db.seed('uid_alice/partnerUid', 'alice');
  assert.equal(await db.write(`${inbox}/self`, item, ALICE), false, 'self-link cannot bypass delete-only');
  assert.equal(await db.write(`${inbox}/n1/from`, 'forged', ALICE), false);
  assert.equal(await db.write(`${inbox}/n1`, null, ALICE), true, 'cleanup does not depend on partner remaining linked');
});

test('multipath cleanup is child-scoped and atomic: mixed foreign/create/edit/log writes fail', async () => {
  const db = await world();
  await db.seed('rooms/uid_alice/entries/e1', { id: 'e1', activity: 'preserve' });
  await db.seed('rooms/uid_alice/calendarPlans/p1', { id: 'p1', items: [{ id: 't1', text: 'preserve' }] });
  const before = await db.read('');
  for (const patch of [
    { [`${inbox}/n1`]: null, 'uid_dave/nudges/n1': null },
    { [`${inbox}/n1`]: null, [`${inbox}/new`]: item },
    { [`${inbox}/n1`]: null, [`${inbox}/n2/from`]: 'forged' },
    { [`${inbox}/n1`]: null, 'rooms/uid_bob/entries/e1': null },
  ]) {
    assert.equal(await db.patch('', patch, ALICE), false, JSON.stringify(patch));
    assert.deepEqual(await db.read(''), before, 'denied patch preserved complete fixture');
  }
  assert.equal(await db.patch('', { [`${inbox}/n1`]: null, [`${inbox}/n2`]: null }, ALICE), true,
    'root PATCH targeting authorized individual children is allowed; root PUT is not');
  assert.deepEqual(await db.read('rooms'), before.rooms, 'logs and planning untouched');
});
