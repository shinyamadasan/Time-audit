// Loopback RTDB emulator ONLY. 'Bearer owner' is an emulator test capability, NOT production authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startEmulator, ALICE, MALLORY } from './rtdb-emulator-support.js';
import { connectSdk } from './rtdb-sdk-support.js';
import { memoryStorage } from './calendar-plan-test-support.js';
import { createCalendarPlanRepository as oldRepository } from './fixtures/cf43080-client/calendar-plan-repository.js';
import { createCalendarPlanSyncBridge as oldBridge } from './fixtures/cf43080-client/calendar-plan-sync.js';
import { fixture, command, NOW } from './task-completion-test-support.js';
import { execute, propose, projection, RESOLUTIONS } from './functions/src/completion-api.js';

import { createCompletionDomain } from './functions/src/completion-domain.js';
const rules = JSON.parse(readFileSync(new URL('./firebase.rules.json', import.meta.url), 'utf8'));

let emulator;
const connections = [];
test.before(async () => { emulator = await startEmulator(); });
test.after(async () => { await Promise.all(connections.map(connection => connection.close())); emulator?.stop(); });
function transport(db) {
  assert.equal(new URL(emulator.base).hostname, '127.0.0.1');
  return createCompletionDomain({ databaseUrl: 'https://contract-test.firebaseio.com', getAccessToken: async () => 'owner',
    fetchImpl: (input, options) => {
      const original = new URL(input);
      assert.equal(original.origin, 'https://contract-test.firebaseio.com');
      const local = new URL(original.pathname + original.search, emulator.base);
      local.searchParams.set('ns', db.name);
      return fetch(local, options);
    } });
}
async function world(store, representation) {
  const f = fixture(store, representation), db = await emulator.fresh(rules);
  await db.seed('rooms/uid_alice', f.room);
  const io = transport(db), snapshot = await io.read('alice');
  return { ...f, db, io, before: snapshot.value };
}
for (const store of ['calendar', 'operational', 'legacy']) for (const representation of ['array', 'fence']) {
  test(`real emulator ${store}/${representation}: conditional room CAS preserves frozen history`, async () => {
    const w = await world(store, representation), req = await command(w.before, w.identity);
    const result = await execute(w.io, 'alice', req, NOW);
    assert.equal(result.outcome, 'CONFIRMED', JSON.stringify(result));
    const { [RESOLUTIONS]: _resolution, ...rest } = (await w.io.read('alice')).value;
    assert.deepEqual(rest, w.before, 'all source/history/unknown siblings preserved in Firebase wire form');
    if (store !== 'calendar') assert.equal(await w.db.write(`rooms/uid_alice/${w.plans}/${w.targetKey}`, { items: [w.item] }), false,
      'ordinary owner cutover guard still denies historical writes');
    assert.equal(await projection((await w.io.read('alice')).value, 'alice', w.identity, NOW, { remotelyConfirmed: true }), 'completed');
  });
}
test('real server rejects direct forged/malformed/delete/parent writes and cross-account reads', async () => {
  const w = await world('calendar', 'array'), req = await command(w.before, w.identity);
  const done = await execute(w.io, 'alice', req, NOW), at = `rooms/uid_alice/${RESOLUTIONS}/${done.key}`;
  assert.equal(await w.db.write(at, { state: 'completed', date: 'junk' }, ALICE), false);
  assert.equal(await w.db.write(at, null, ALICE), false);
  assert.equal(await w.db.write(`rooms/uid_alice/${RESOLUTIONS}`, {}, ALICE), false);
  assert.equal(await w.db.write(at, done.record, MALLORY), false);
  assert.equal(await w.db.patch('rooms/uid_alice', { [`${RESOLUTIONS}/${done.key}`]: null, 'timer/forged': true }), false);
  assert.equal((await w.db.read('rooms/uid_alice/timer')).forged, undefined, 'multi-path refusal is atomic');
  const read = await fetch(`${emulator.base}/${at}.json?ns=${w.db.name}&auth=${MALLORY}`);
  assert.ok([401, 403].includes(read.status));
  const empty = { ...w.before }; delete empty[RESOLUTIONS];
  assert.equal(await w.db.write('rooms/uid_alice', empty), false, 'room overwrite cannot erase protected facts');
  assert.ok(await w.db.read(at));
});
test('two real SDK readers + cf43080 calendar push + reload preserve confirmed record', async () => {
  const w = await world('calendar', 'array');
  const connect = uid => { const connection = connectSdk(emulator, w.db, { uid }); connections.push(connection); return connection; };
  const a = connect('alice'), b = connect('alice');
  const repository = oldRepository({ storage: memoryStorage(), getOwner: () => 'uid_alice', getTimezone: () => 'Etc/UTC' });
  const bridge = oldBridge({ repository, getRoomRef: () => a.roomRef(), getRoomId: () => 'uid_alice' });
  await bridge.hydrateAll();
  const before = repository.read('2026-10-11');
  const request = await command(w.before, w.identity);
  const resolutionRef = b.roomRef().child(RESOLUTIONS);
  let listener;
  const received = new Promise((resolve, reject) => {
    listener = resolutionRef.on('value', snapshot => { if (snapshot.exists()) resolve(snapshot.val()); }, reject);
  });
  const done = await execute(w.io, 'alice', request, NOW);
  assert.equal(done.outcome, 'CONFIRMED');
  const recordBefore = await w.db.read(`rooms/uid_alice/${RESOLUTIONS}`);
  assert.deepEqual(await received, recordBefore, 'already-running second SDK listener receives completion');
  resolutionRef.off('value', listener);
  assert.deepEqual((await a.roomRef().child(RESOLUTIONS).once('value')).val(), recordBefore);
  assert.deepEqual((await b.roomRef().child(RESOLUTIONS).once('value')).val(), recordBefore);
  repository.write('2026-10-11', before.items.map(item => ({ ...item, updatedAt: NOW, updatedBy: 'released', task: 'Real old-client offline edit' })), { updatedBy: 'released', now: NOW });
  assert.equal((await bridge.pushPlan(w.identity.targetId)).committed, true);
  assert.equal((await bridge.pushPlan(w.identity.targetId)).committed, true, 'reconnect replay');
  assert.deepEqual(await w.db.read(`rooms/uid_alice/${RESOLUTIONS}`), recordBefore);
  const reload = connect('alice');
  assert.deepEqual((await reload.roomRef().child(RESOLUTIONS).once('value')).val(), recordBefore);
  const other = connect('mallory');
  await assert.rejects(other.ref(`rooms/uid_alice/${RESOLUTIONS}`).once('value'));
  const reqBob = await command(w.before, w.identity, {}, 'bob');
  assert.equal((await execute(w.io, 'bob', reqBob, NOW)).outcome, 'REJECTED', 'backend path is derived from authenticated UID');
  assert.deepEqual(await w.db.read(`rooms/uid_alice/${RESOLUTIONS}`), recordBefore);
});
test('real conditional writes: conflicting dates and stale Undo cannot overwrite head', async () => {
  const w = await world('calendar', 'array'), request = await command(w.before, w.identity);
  const second = { ...request, operationId: randomUUID(), date: '2026-10-14' };
  const outcomes = await Promise.all([execute(w.io, 'alice', request, NOW), execute(w.io, 'alice', second, NOW)]);
  assert.deepEqual(outcomes.map(result => result.outcome).sort(), ['CONFIRMED', 'REJECTED']);
  const applied = outcomes.find(result => result.outcome === 'CONFIRMED');
  const winningId = Object.keys(applied.record.operations)[0];
  const undo = { identity: w.identity, operationId: randomUUID(), kind: 'undo', expectedRevision: 1,
    expectedSourceRevision: request.expectedSourceRevision, undoOf: winningId };
  const undone = await execute(w.io, 'alice', undo, NOW);
  assert.equal(undone.outcome, 'CONFIRMED', JSON.stringify(undone));
  const next = await command((await w.io.read('alice')).value, w.identity, { expectedRevision: 2 });
  assert.equal((await execute(w.io, 'alice', next, NOW)).outcome, 'CONFIRMED');
  assert.equal((await execute(w.io, 'alice', { ...undo, operationId: randomUUID() }, NOW)).reason, 'STALE_RESOLUTION');
});
test('real ETag protects source edits between observation and write', async () => {
  const w = await world('calendar', 'array'), req = await command(w.before, w.identity);
  const snapshot = await w.io.read('alice'), proposal = await propose(snapshot.value, 'alice', req, NOW);
  await w.db.write(`rooms/uid_alice/${w.plans}/${w.targetKey}/items/0/task`, 'Racing owner edit');
  assert.equal(await w.io.cas('alice', snapshot.etag, proposal.next, snapshot.value), 'changed');
  assert.equal((await execute(w.io, 'alice', req, NOW)).reason, 'STALE_SOURCE');
  assert.equal(await w.db.read(`rooms/uid_alice/${RESOLUTIONS}`), null);
});
test('real export detects priorities and refuses without removing them', async () => {
  const w = await world('calendar', 'array'), req = await command(w.before, w.identity);
  await w.db.seed('rooms/uid_alice/futureUnknownSibling', { '.priority': 7, preserve: true });
  assert.equal((await execute(w.io, 'alice', req, NOW)).reason, 'PRIORITY_UNSUPPORTED');
  assert.equal((await w.io.read('alice')).value.futureUnknownSibling['.priority'], 7);
});

test('real sibling heartbeat between root GET and PUT forces retry and remains intact', async () => {
  const w = await world('calendar', 'array'), req = await command(w.before, w.identity), cas = w.io.cas;
  let attempts = 0;
  w.io.cas = async (...args) => {
    if (++attempts === 1) await w.db.seed('rooms/uid_alice/timer', { running: true, unrelatedHeartbeat: 99 });
    return cas(...args);
  };
  assert.equal((await execute(w.io, 'alice', req, NOW)).outcome, 'CONFIRMED');
  assert.equal(attempts, 2);
  assert.deepEqual(await w.db.read('rooms/uid_alice/timer'), { running: true, unrelatedHeartbeat: 99 });
  assert.deepEqual(await w.db.read('rooms/uid_alice/entries'), w.before.entries);
});
test('priority introduced after observation changes ETag and then refuses without erasure', async () => {
  const w = await world('calendar', 'array'), req = await command(w.before, w.identity), cas = w.io.cas;
  w.io.cas = async (...args) => {
    await w.db.seed('rooms/uid_alice/futureUnknownSibling', { '.priority': 12, preserve: true });
    return cas(...args);
  };
  const result = await execute(w.io, 'alice', req, NOW);
  assert.equal(result.outcome, 'REJECTED'); assert.equal(result.reason, 'PRIORITY_UNSUPPORTED');
  assert.equal((await w.io.read('alice')).value.futureUnknownSibling['.priority'], 12);
  assert.equal(await w.db.read('rooms/uid_alice/taskCompletionResolutions'), null);
});
test('lost real PUT response is unknown and exact receipt retry does not duplicate completion', async () => {
  const w = await world('calendar', 'array'), req = await command(w.before, w.identity), cas = w.io.cas;
  w.io.cas = async (...args) => { await cas(...args); throw new Error('lost response'); };
  assert.equal((await execute(w.io, 'alice', req, NOW)).outcome, 'UNKNOWN');
  w.io.cas = cas;
  const recovered = await execute(w.io, 'alice', req, NOW, { uncertain: true });
  assert.equal(recovered.outcome, 'CONFIRMED'); assert.equal(recovered.record.revision, 1);
  assert.deepEqual(await w.db.read(`rooms/uid_alice/${w.plans}`), w.before[w.plans]);
});
