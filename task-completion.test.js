import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fixture, command, memory, NOW } from './task-completion-test-support.js';
import { propose, execute, projection, operationStatus, resolutionKey, sourceRevision, RESOLUTIONS } from './functions/src/completion-api.js';
import { mergeCalendarPlanRecords as oldCalendar } from './fixtures/cf43080-client/calendar-plan-model.js';
import { mergeOperationalPlanRecords as oldOperational } from './fixtures/cf43080-client/operational-plan-model.js';
import { mergeDatePlans as oldLegacy } from './fixtures/cf43080-client/plan-tomorrow-model.js';
import { classifyOneOffActual, summarizeActual } from './plan-tomorrow-model.js';

test('one released client: all 14 pinned files verified (LF canonical)', () => {
  const root = new URL('./fixtures/cf43080-client/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('MANIFEST.json', root), 'utf8'));
  assert.equal(manifest.commit, 'cf43080ad51428cb78442e6cabadbf3d48edc827');
  assert.equal(Object.keys(manifest.files).length, 14);
  for (const [file, digest] of Object.entries(manifest.files)) assert.equal(
    createHash('sha256').update(readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), digest, file);
});
for (const store of ['calendar', 'legacy', 'operational']) for (const representation of ['array', 'fence']) {
  test(`${store}/${representation}: completes today, unchanged history; reload and second reader reconstruct`, async () => {
    const f = fixture(store, representation), db = memory(f.room), request = await command(f.room, f.identity);
    const result = await execute(db, 'alice', request, NOW);
    assert.equal(result.outcome, 'CONFIRMED', JSON.stringify(result));
    const { [RESOLUTIONS]: _new, ...siblings } = db.value();
    assert.deepEqual(siblings, f.room);
    const reloaded = JSON.parse(JSON.stringify(db.value()));
    assert.equal(await projection(reloaded, 'alice', f.identity, NOW, { remotelyConfirmed: true }), 'completed');
    assert.equal(await projection(reloaded, 'alice', f.identity, NOW), 'unfinished', 'unconfirmed cache cannot hide');
    assert.equal(result.receipt.date, '2026-10-15');
    assert.equal(result.receipt.recordedAt, NOW);
    assert.equal(classifyOneOffActual(f.item, { targetDate: '2026-10-11', timezone: 'Etc/UTC' }), 'not-done');
    assert.deepEqual(summarizeActual([{ status: 'not-done' }]), { planned: 1, active: 1, completed: 0, removed: 0 });
    assert.equal(JSON.stringify(db.value()[RESOLUTIONS]).includes(f.item.task), false, 'facts do not duplicate the task');
  });
}
test('Action API fenced identity binds creationActionId without changing existing action', async () => {
  const f = fixture('calendar', 'fence', 'action'), db = memory(f.room);
  assert.equal((await execute(db, 'alice', await command(f.room, f.identity), NOW)).outcome, 'CONFIRMED');
  assert.deepEqual(db.value()[f.fences], f.room[f.fences]);
});
for (const store of ['calendar', 'legacy', 'operational']) test(`cf43080 ${store} merge replay cannot erase sibling resolution`, async () => {
  const f = fixture(store), db = memory(f.room), request = await command(f.room, f.identity);
  assert.equal((await execute(db, 'alice', request, NOW)).outcome, 'CONFIRMED');
  const resolution = structuredClone(db.value()[RESOLUTIONS]);
  const stale = { ...f.room[f.plans][f.targetKey], items: [{ ...f.item, task: 'Offline edit', updatedAt: 1000 }] };
  const merge = { calendar: oldCalendar, legacy: oldLegacy, operational: oldOperational }[store];
  db.change(room => ({ ...room, [f.plans]: { [f.targetKey]: merge(room[f.plans][f.targetKey], stale, f.identity.targetId) } }));
  assert.deepEqual(db.value()[RESOLUTIONS], resolution);
  assert.equal(await projection(db.value(), 'alice', f.identity, NOW, { remotelyConfirmed: true }), 'needs-review');
});
test('actual earlier date is separate from assertion instant and original plan date', async () => {
  const f = fixture(), db = memory(f.room);
  const result = await execute(db, 'alice', await command(f.room, f.identity, { date: '2026-10-12' }), NOW);
  assert.equal(result.receipt.date, '2026-10-12'); assert.equal(result.receipt.recordedAt, NOW);
  assert.equal(result.record.identity.targetId, 'cal1:2026-10-11');
});
test('duplicate operation is idempotent, changed intent with same ID is refused', async () => {
  const f = fixture(), db = memory(f.room), req = await command(f.room, f.identity);
  await execute(db, 'alice', req, NOW);
  const before = db.fingerprint();
  assert.equal((await execute(db, 'alice', req, NOW)).outcome, 'CONFIRMED');
  assert.equal(db.fingerprint(), before);
  assert.equal((await execute(db, 'alice', { ...req, date: '2026-10-13' }, NOW)).reason, 'OPERATION_ID_REUSE');
});
test('concurrent different dates: one confirmed, other explicitly stale; never LWW', async () => {
  const f = fixture(), db = memory(f.room), a = await command(f.room, f.identity), b = { ...a, operationId: randomUUID(), date: '2026-10-14' };
  const outcomes = await Promise.all([execute(db, 'alice', a, NOW), execute(db, 'alice', b, NOW)]);
  assert.deepEqual(outcomes.map(v => v.outcome).sort(), ['CONFIRMED', 'REJECTED']);
  assert.equal(Object.values(db.value()[RESOLUTIONS])[0].revision, 1);
});
test('source edit between read and CAS is not overwritten, stale source refused', async () => {
  const f = fixture(), db = memory(f.room), req = await command(f.room, f.identity), cas = db.cas;
  let once = true;
  db.cas = async (...args) => { if (once) { once = false; db.change(room => { room[f.plans][f.targetKey].items[0].task = 'New edit'; return room; }); } return cas(...args); };
  const result = await execute(db, 'alice', req, NOW);
  assert.equal(result.reason, 'STALE_SOURCE'); assert.equal(result.outcome, 'REJECTED');
  assert.equal(db.value()[f.plans][f.targetKey].items[0].task, 'New edit'); assert.equal(db.value()[RESOLUTIONS], undefined);
});
test('unrelated room write forces CAS retry and is preserved', async () => {
  const f = fixture(), db = memory(f.room), req = await command(f.room, f.identity), cas = db.cas;
  let once = true;
  db.cas = async (...args) => { if (once) { once = false; db.change(room => ({ ...room, timer: { running: true } })); } return cas(...args); };
  assert.equal((await execute(db, 'alice', req, NOW)).outcome, 'CONFIRMED');
  assert.equal(db.value().timer.running, true);
});
test('contention is bounded and never looks confirmed', async () => {
  const f = fixture(), db = memory(f.room); let attempts = 0;
  db.cas = async () => { attempts++; return 'changed'; };
  assert.equal((await execute(db, 'alice', await command(f.room, f.identity), NOW)).reason, 'CONTENDED'); assert.equal(attempts, 3);
});
test('conditional Undo retains receipts; delayed old completion replay cannot re-complete', async () => {
  const f = fixture(), db = memory(f.room), complete = await command(f.room, f.identity);
  await execute(db, 'alice', complete, NOW);
  const undo = { identity: f.identity, operationId: randomUUID(), kind: 'undo', expectedRevision: 1,
    expectedSourceRevision: complete.expectedSourceRevision, undoOf: complete.operationId };
  assert.equal((await execute(db, 'alice', undo, NOW)).outcome, 'CONFIRMED');
  const replay = await execute(db, 'alice', complete, NOW);
  assert.equal(replay.outcome, 'CONFIRMED'); assert.equal(replay.receipt.revision, 1); assert.equal(replay.record.state, 'open');
  assert.equal(await projection(db.value(), 'alice', f.identity, NOW, { remotelyConfirmed: true }), 'unfinished');
  const again = await command(db.value(), f.identity, { expectedRevision: 2, date: '2026-10-14' });
  assert.equal((await execute(db, 'alice', again, NOW)).outcome, 'CONFIRMED');
  assert.equal((await execute(db, 'alice', { ...undo, operationId: randomUUID() }, NOW)).reason, 'STALE_RESOLUTION');
  assert.equal(Object.values(db.value()[RESOLUTIONS])[0].operations[complete.operationId].date, '2026-10-15');
});
test('Undo refuses unseen source edits', async () => {
  const f = fixture(), db = memory(f.room), complete = await command(f.room, f.identity);
  await execute(db, 'alice', complete, NOW);
  db.change(room => { room[f.plans][f.targetKey].items[0].task = 'Changed remotely'; return room; });
  const undo = { identity: f.identity, operationId: randomUUID(), kind: 'undo', expectedRevision: 1,
    expectedSourceRevision: complete.expectedSourceRevision, undoOf: complete.operationId };
  assert.equal((await execute(db, 'alice', undo, NOW)).reason, 'STALE_SOURCE');
});
test('known refusal, lost response after commit, lost request before commit and same-ID retry', async () => {
  const f = fixture(), db = memory(f.room), req = await command(f.room, f.identity), cas = db.cas;
  db.cas = async () => 'denied';
  assert.equal((await execute(db, 'alice', req, NOW)).outcome, 'REJECTED');
  db.cas = async (...args) => { await cas(...args); throw Error('lost response'); };
  assert.equal((await execute(db, 'alice', req, NOW)).outcome, 'UNKNOWN');
  assert.equal((await execute(db, 'alice', req, NOW, { uncertain: true })).outcome, 'CONFIRMED');
  const other = fixture(), pending = memory(other.room), retry = await command(other.room, other.identity), put = pending.cas;
  pending.cas = async () => { throw Error('lost request'); };
  assert.equal((await execute(pending, 'alice', retry, NOW)).outcome, 'UNKNOWN');
  assert.equal(await projection(pending.value(), 'alice', other.identity, NOW, { remotelyConfirmed: true }), 'unfinished');
  pending.cas = put;
  assert.equal((await execute(pending, 'alice', retry, NOW, { uncertain: true })).outcome, 'CONFIRMED');
});
test('prior unknown is never reclassified rejected on later conflict or denial', async () => {
  const f = fixture(), db = memory(f.room), req = await command(f.room, f.identity);
  db.change(room => { room[f.plans][f.targetKey].items[0].updatedAt++; return room; });
  assert.equal((await execute(db, 'alice', req, NOW, { uncertain: true })).outcome, 'UNKNOWN');
});
test('account identity is part of key/revision; no auth or forged account body causes no write', async () => {
  const f = fixture(), db = memory(f.room), req = await command(f.room, f.identity), before = db.fingerprint();
  assert.notEqual(resolutionKey('alice', f.identity), resolutionKey('bob', f.identity));
  assert.equal((await execute(db, null, req, NOW)).reason, 'UNAUTHENTICATED');
  assert.equal((await execute(db, 'bob', req, NOW)).reason, 'STALE_SOURCE');
  assert.equal((await execute(db, 'alice', { ...req, ownerUid: 'bob' }, NOW)).reason, 'MALFORMED');
  assert.equal(db.fingerprint(), before);
});
for (const patch of [{ date: '2026-02-30' }, { date: '2026-10-16' }, { timezone: 'Moon/Base' }, { operationId: '../path' }, { expectedRevision: -1 }, { trackedMinutes: 30 }]) {
  test(`malformed/unauthorized field rejected: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(), db = memory(f.room), req = await command(f.room, f.identity);
    assert.equal((await execute(db, 'alice', { ...req, ...patch }, NOW)).outcome, 'REJECTED'); assert.equal(db.value()[RESOLUTIONS], undefined);
  });
}
test('reorder is not identity; duplicate IDs, moves, recycled generation and boundary edits fail closed', async () => {
  const f = fixture(), original = await sourceRevision(f.room, 'alice', f.identity, NOW);
  f.room[f.plans][f.targetKey].items.unshift({ ...f.item, id: 'other' });
  assert.equal(await sourceRevision(f.room, 'alice', f.identity, NOW), original);
  f.room[f.plans][f.targetKey].items.push(f.item);
  await assert.rejects(sourceRevision(f.room, 'alice', f.identity, NOW), /DUPLICATE_ID/);
  const moved = fixture(); moved.item.carriedFromId = 'prior';
  await assert.rejects(sourceRevision(moved.room, 'alice', moved.identity, NOW), /MOVED_OR_LOCKED/);
  const duplicate = fixture(); duplicate.room.plans = { '2026-10-10': { items: [duplicate.item] } };
  await assert.rejects(sourceRevision(duplicate.room, 'alice', duplicate.identity, NOW), /DUPLICATE_ID/);
  const fenced = fixture('calendar', 'fence'), oldIdentity = structuredClone(fenced.identity);
  fenced.item.brainDumpOrigin.claimEpoch++;
  await assert.rejects(sourceRevision(fenced.room, 'alice', oldIdentity, NOW), /ORIGIN_CONFLICT/);
  const op = fixture('operational'), db = memory(op.room), request = await command(op.room, op.identity);
  delete op.room.dayBoundaryRevisions;
  assert.equal((await execute(memory(op.room), 'alice', request, NOW)).outcome, 'REJECTED');
  assert.equal(db.value()[RESOLUTIONS], undefined);
});
test('priority metadata and oversized room are refused, never rewritten', async () => {
  const f = fixture(), req = await command(f.room, f.identity);
  f.room.futureUnknownSibling['.priority'] = 7;
  assert.equal((await execute(memory(f.room), 'alice', req, NOW)).reason, 'PRIORITY_UNSUPPORTED');
  delete f.room.futureUnknownSibling['.priority']; f.room.large = 'x'.repeat(16 * 1024 * 1024);
  assert.equal((await execute(memory(f.room), 'alice', req, NOW)).reason, 'ROOM_TOO_LARGE');
});

test('account-zone today is frozen explicitly; server UTC date is not completion today', async () => {
  const f = fixture(); f.room.settings.timezone = 'America/Los_Angeles';
  const instant = Date.parse('2026-10-15T00:10:00Z'); // account's date is still October 14
  const req = { ...await command(f.room, f.identity), timezone: 'America/Los_Angeles', date: '2026-10-14' };
  assert.equal((await execute(memory(f.room), 'alice', req, instant)).outcome, 'CONFIRMED');
  assert.equal((await execute(memory(f.room), 'alice', { ...req, date: '2026-10-15' }, instant)).reason, 'INVALID_DATE_OR_ZONE');
  const g = fixture();
  assert.equal((await execute(memory(g.room), 'alice', await command(g.room, g.identity, { timezone: 'America/Los_Angeles' }), NOW)).reason, 'ACCOUNT_ZONE_CHANGED');
});

test('failed readback after write remains unknown until same operation receipt is recovered', async () => {
  const f = fixture(), db = memory(f.room), req = await command(f.room, f.identity), read = db.read;
  let reads = 0;
  db.read = async (...args) => { if (++reads === 2) throw Error('lost acknowledgement read'); return read(...args); };
  assert.equal((await execute(db, 'alice', req, NOW)).outcome, 'UNKNOWN');
  db.read = read;
  assert.equal((await execute(db, 'alice', req, NOW, { uncertain: true })).outcome, 'CONFIRMED');
});

test('memory multi-account dispatcher never sends Alice command into Bob room', async () => {
  const f = fixture(), g = fixture(), alice = memory(f.room), bob = memory(g.room), rooms = { alice, bob };
  const transport = { read: uid => rooms[uid].read(), cas: (uid, etag, next) => rooms[uid].cas(uid, etag, next) };
  const req = await command(f.room, f.identity), before = alice.fingerprint();
  assert.equal((await execute(transport, 'bob', req, NOW)).outcome, 'REJECTED');
  assert.equal(alice.fingerprint(), before); assert.equal(bob.value()[RESOLUTIONS], undefined);
  assert.equal((await execute(transport, 'alice', req, NOW)).outcome, 'CONFIRMED');
  assert.equal(bob.value()[RESOLUTIONS], undefined);
});

test('malformed or future-version resolution cannot be overwritten by replay', async () => {
  const f = fixture(), db = memory(f.room), req = await command(f.room, f.identity);
  await execute(db, 'alice', req, NOW);
  db.change(room => { Object.values(room[RESOLUTIONS])[0].v = 2; return room; });
  const before = db.fingerprint();
  assert.equal((await execute(db, 'alice', req, NOW)).reason, 'RECORD_CONFLICT');
  assert.equal(db.fingerprint(), before);
  assert.equal(await projection(db.value(), 'alice', f.identity, NOW, { remotelyConfirmed: true }), 'needs-review');
});

test('exact receipt read recovers prior unknown even when room mutations later become unsupported', async () => {
  const f = fixture(), db = memory(f.room), req = await command(f.room, f.identity);
  await execute(db, 'alice', req, NOW);
  db.change(room => ({ ...room, futurePrioritized: { '.priority': 9, child: 'untouched' } }));
  assert.equal((await execute(db, 'alice', req, NOW, { uncertain: true })).outcome, 'UNKNOWN');
  const record = db.value()[RESOLUTIONS][resolutionKey('alice', f.identity)];
  assert.equal(operationStatus(record, 'alice', req).outcome, 'CONFIRMED');
  assert.equal(operationStatus(record, 'bob', req).outcome, 'UNKNOWN');
  assert.equal(operationStatus(null, 'alice', req).outcome, 'UNKNOWN');
  assert.equal(await projection(db.value(), 'alice', f.identity, NOW, { remotelyConfirmed: true }), 'needs-review');
});

test('oversized receipt ledger refuses before CAS rather than commit an unreturnable acknowledgement', async () => {
  const f = fixture(), initial = await command(f.room, f.identity), p = await propose(f.room, 'alice', initial, NOW);
  const record = p.record;
  let completeId = initial.operationId;
  for (let revision = 2; revision <= 2200; revision++) {
    const id = randomUUID(), kind = revision % 2 === 0 ? 'undo' : 'complete';
    record.operations[id] = { intentHash: 'x'.repeat(43), kind, revision, recordedAt: NOW, actorUid: 'alice', sourceRevision: initial.expectedSourceRevision,
      ...(kind === 'complete' ? { date: '2026-10-15', timezone: 'Etc/UTC' } : { undoOf: completeId }) };
    if (kind === 'complete') completeId = id;
  }
  record.revision = 2200; record.state = 'open'; record.completionOpId = completeId;
  f.room[RESOLUTIONS] = { [p.key]: record };
  const db = memory(f.room), before = db.fingerprint(); let writes = 0;
  db.cas = async () => { writes++; throw new Error('must refuse first'); };
  const result = await execute(db, 'alice', { ...initial, operationId: randomUUID(), expectedRevision: 2200 }, NOW);
  assert.equal(result.reason, 'RESOLUTION_TOO_LARGE'); assert.equal(result.outcome, 'REJECTED'); assert.equal(writes, 0); assert.equal(db.fingerprint(), before);
});
for (const tombstone of [false, true]) test(`source ${tombstone ? 'tombstone' : 'deletion'} racing CAS refuses without resurrecting history`, async () => {
  const f = fixture(), request = await command(f.room, f.identity), db = memory(f.room), cas = db.cas;
  let attempts = 0;
  db.cas = async (...args) => {
    if (++attempts === 1) db.change(room => {
      room.calendarPlans[f.targetKey].items = tombstone ? [{ ...f.item, deleted: true, updatedAt: NOW }] : [];
      return room;
    });
    return cas(...args);
  };
  assert.equal((await execute(db, 'alice', request, NOW)).outcome, 'REJECTED');
  assert.equal(db.value()[RESOLUTIONS], undefined); assert.deepEqual(db.value().entries, f.room.entries);
  assert.deepEqual(db.value().calendarPlans[f.targetKey].items, tombstone ? [{ ...f.item, deleted: true, updatedAt: NOW }] : []);
});
