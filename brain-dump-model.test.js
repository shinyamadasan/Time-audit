// brain-dump-model.test.js
//
// Brain Dump + Eisenhower V1. Pure model (brain-dump-model.js) and the local
// repository built on top of it (brain-dump-repository.js). No Firebase, no
// network — account-isolation and cross-device concurrency are covered
// separately in brain-dump-account-isolation.test.js and brain-dump-sync.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validBrainDumpId, brainDumpPlanItemId, buildCapture, triageCapture, promoteCapture,
  archiveCapture, delegateCapture, normalizeCapture, mergeCaptureRecords, mergeCaptureMaps,
  allCaptures, untriagedCaptures, triagedCaptures, disposedCaptures, quadrantOf,
  TERMINAL_STATUSES,
} from './brain-dump-model.js';
import { createBrainDumpRepository, brainDumpCacheKeyForRoom } from './brain-dump-repository.js';

const T0 = Date.parse('2026-10-01T08:00:00Z');
const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), _map: map };
};

// ═══════════════════════════════════════════════════════════════════════════
// capture: minimal at creation
// ═══════════════════════════════════════════════════════════════════════════

test('buildCapture requires only text — no time, date, duration, category, priority or triage', () => {
  const built = buildCapture({ id: 'bidone1', text: 'Call the vet', now: T0, updatedBy: 'device-1' });
  assert.ok(built.ok);
  assert.equal(built.record.text, 'Call the vet');
  assert.equal(built.record.status, 'untriaged');
  assert.equal(built.record.important, null);
  assert.equal(built.record.urgent, null);
  assert.equal(built.record.promotion, null);
  assert.equal(built.record.delegatedTo, null);
});

test('buildCapture refuses empty/whitespace-only text', () => {
  assert.equal(buildCapture({ id: 'bidone1', text: '   ', now: T0, updatedBy: 'd' }).ok, false);
  assert.equal(buildCapture({ id: 'bidone1', text: '', now: T0, updatedBy: 'd' }).ok, false);
});

test('identical text at the same instant still mints distinct ids via the repository', () => {
  const repo = createBrainDumpRepository({ storage: memory(), now: () => T0, deviceId: () => 'device-1' });
  const a = repo.create({ text: 'Buy milk' });
  const b = repo.create({ text: 'Buy milk' });
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.record.id, b.record.id);
});

// ═══════════════════════════════════════════════════════════════════════════
// triage: atomic, advisory, never touches disposition
// ═══════════════════════════════════════════════════════════════════════════

test('triageCapture requires both important and urgent together', () => {
  const built = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  assert.equal(triageCapture(built, { important: true, now: T0 + 1, updatedBy: 'd' }).ok, false);
  assert.equal(triageCapture(built, { urgent: true, now: T0 + 1, updatedBy: 'd' }).ok, false);
  const result = triageCapture(built, { important: true, urgent: false, now: T0 + 1, updatedBy: 'd' });
  assert.ok(result.ok);
  assert.equal(result.record.status, 'triaged');
});

test('all four Eisenhower combinations classify and label correctly', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  const cases = [
    [true, true, 'do-first'],
    [true, false, 'schedule'],
    [false, true, 'delegate-candidate'],
    [false, false, 'archive-candidate'],
  ];
  for (const [important, urgent, quadrant] of cases) {
    const triaged = triageCapture(base, { important, urgent, now: T0 + 1, updatedBy: 'd' }).record;
    assert.equal(quadrantOf(triaged), quadrant, `${important}/${urgent}`);
  }
});

test('quadrantOf is null until triaged — never guessed', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  assert.equal(quadrantOf(base), null);
});

test('re-triaging a terminal capture updates the classification but never reverts its disposition', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  const triaged = triageCapture(base, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const archived = archiveCapture(triaged, { now: T0 + 2, updatedBy: 'd' }).record;
  assert.equal(archived.status, 'archived');
  const retriaged = triageCapture(archived, { important: false, urgent: false, now: T0 + 3, updatedBy: 'd' }).record;
  assert.equal(retriaged.status, 'archived', 'classification must not change plan truth / disposition');
  assert.equal(retriaged.important, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// disposition: idempotent terminal transitions
// ═══════════════════════════════════════════════════════════════════════════

test('promote/archive/delegate are each idempotent: a capture already disposed of stays exactly as it is', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  const archived = archiveCapture(base, { now: T0 + 1, updatedBy: 'd' }).record;
  assert.equal(archived.status, 'archived');

  const second = archiveCapture(archived, { now: T0 + 2, updatedBy: 'd' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-disposed');
  assert.deepEqual(second.record, archived);

  const delegateAttempt = delegateCapture(archived, { now: T0 + 3, updatedBy: 'd' });
  assert.equal(delegateAttempt.ok, false);
  assert.equal(delegateAttempt.reason, 'already-disposed');

  const promoteAttempt = promoteCapture(archived, {
    promotion: { type: 'do-today', store: 'calendar', targetId: 'calplan:2026-10-01', planItemId: 'bdp1|b1' },
    now: T0 + 4, updatedBy: 'd',
  });
  assert.equal(promoteAttempt.ok, false);
  assert.equal(promoteAttempt.reason, 'already-disposed');
});

test('promoteCapture records provenance (store, targetId, planItemId) and nothing else', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  const result = promoteCapture(base, {
    promotion: { type: 'schedule', store: 'calendar', targetId: 'calplan:2026-10-05', planItemId: brainDumpPlanItemId('bidone1') },
    now: T0 + 1, updatedBy: 'd',
  });
  assert.ok(result.ok);
  assert.equal(result.record.status, 'promoted');
  assert.equal(result.record.promotion.type, 'schedule');
  assert.equal(result.record.promotion.planItemId, 'bdp1|bidone1');
  assert.equal(result.record.disposedAt, T0 + 1);
});

test('delegateCapture stores an optional free-text note, trimmed and capped, with no tracked destination', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  const withNote = delegateCapture(base, { delegatedTo: '  Alex  ', now: T0 + 1, updatedBy: 'd' });
  assert.ok(withNote.ok);
  assert.equal(withNote.record.delegatedTo, 'Alex');
  const noNote = delegateCapture(base, { now: T0 + 1, updatedBy: 'd' });
  assert.equal(noNote.record.delegatedTo, null);
});

test('brainDumpPlanItemId is deterministic and derived only from the capture id', () => {
  assert.equal(brainDumpPlanItemId('abc123'), 'bdp1|abc123');
  assert.equal(brainDumpPlanItemId('abc123'), brainDumpPlanItemId('abc123'));
  assert.throws(() => brainDumpPlanItemId('bad id with spaces'));
});

// ═══════════════════════════════════════════════════════════════════════════
// normalize: refuses malformed remote payloads
// ═══════════════════════════════════════════════════════════════════════════

test('normalizeCapture refuses a record with one triage field set and not the other', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  assert.equal(normalizeCapture({ ...base, important: true }), null);
});

test('normalizeCapture refuses a promoted record missing its promotion payload', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  assert.equal(normalizeCapture({ ...base, status: 'promoted', disposedAt: T0 + 1 }), null);
});

test('normalizeCapture refuses an untriaged record carrying triage answers', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  assert.equal(normalizeCapture({ ...base, important: true, urgent: true, triagedAt: T0 }), null);
});

test('normalizeCapture refuses a schema-version mismatch and a malformed id', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  assert.equal(normalizeCapture({ ...base, schemaVersion: 2 }), null);
  assert.equal(normalizeCapture({ ...base, id: 'bad id' }), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// merge: per-record LWW with a canonical tie-break, same algorithm as everywhere else
// ═══════════════════════════════════════════════════════════════════════════

test('mergeCaptureRecords picks the higher updatedAt', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  const older = { ...base, updatedAt: T0 };
  const newer = triageCapture(base, { important: true, urgent: true, now: T0 + 100, updatedBy: 'd2' }).record;
  assert.deepEqual(mergeCaptureRecords(older, newer), newer);
  assert.deepEqual(mergeCaptureRecords(newer, older), newer);
});

test('mergeCaptureRecords ties break deterministically (same result on both devices)', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  const a = { ...base, text: 'Variant A', updatedAt: T0 + 1 };
  const b = { ...base, text: 'Variant B', updatedAt: T0 + 1 };
  const resultAB = mergeCaptureRecords(a, b);
  const resultBA = mergeCaptureRecords(b, a);
  assert.deepEqual(resultAB, resultBA, 'order of arguments must not change the winner');
});

test('a tombstone-free disposition is an ordinary later write: it converges and is never silently undone by absence', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  const archived = archiveCapture(base, { now: T0 + 5, updatedBy: 'd' }).record;
  // A remote map that simply never mentions this capture (a peer with older
  // knowledge) must never erase the locally-known archived record.
  assert.deepEqual(mergeCaptureMaps({ bidone1: archived }, {}), { bidone1: archived });
  assert.deepEqual(mergeCaptureMaps({}, { bidone1: archived }), { bidone1: archived });
});

// ═══════════════════════════════════════════════════════════════════════════
// ordering: deterministic, id tie-break
// ═══════════════════════════════════════════════════════════════════════════

test('untriagedCaptures/triagedCaptures/disposedCaptures sort by creation time with id as a stable tie-breaker', () => {
  const a = buildCapture({ id: 'bzz9', text: 'a', now: T0, updatedBy: 'd' }).record;
  const b = buildCapture({ id: 'baa1', text: 'b', now: T0, updatedBy: 'd' }).record; // same createdAt as a
  const c = buildCapture({ id: 'bmm5', text: 'c', now: T0 + 1, updatedBy: 'd' }).record;
  const ordered = untriagedCaptures({ a, b, c });
  assert.deepEqual(ordered.map(r => r.id), ['baa1', 'bzz9', 'bmm5']);
});

test('allCaptures/triagedCaptures/disposedCaptures each filter by status', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  const triaged = triageCapture(base, { important: true, urgent: false, now: T0 + 1, updatedBy: 'd' }).record;
  const promoted = promoteCapture(triaged, {
    promotion: { type: 'do-today', store: 'legacy', targetId: '2026-10-01', planItemId: 'bdp1|b1' },
    now: T0 + 2, updatedBy: 'd',
  }).record;
  const records = { b1: promoted };
  assert.equal(allCaptures(records).length, 1);
  assert.equal(untriagedCaptures(records).length, 0);
  assert.equal(triagedCaptures(records).length, 0);
  assert.equal(disposedCaptures(records).length, 1);
  assert.ok(TERMINAL_STATUSES.has(disposedCaptures(records)[0].status));
});

// ═══════════════════════════════════════════════════════════════════════════
// repository: durable, validate-before-write, account-scoped slot
// ═══════════════════════════════════════════════════════════════════════════

test('repository.create persists; listAllRaw reflects it; an unknown id reads null', () => {
  const repo = createBrainDumpRepository({ storage: memory(), now: () => T0, deviceId: () => 'device-1' });
  const created = repo.create({ text: 'Renew passport' });
  assert.ok(created.ok);
  assert.equal(repo.read(created.record.id).text, 'Renew passport');
  assert.equal(repo.read('bdoesnotexist1'), null);
  assert.equal(Object.keys(repo.listAllRaw()).length, 1);
});

test('repository.triage/promote/archive/delegate round-trip through persist()', () => {
  const repo = createBrainDumpRepository({ storage: memory(), now: () => T0, deviceId: () => 'device-1' });
  const { record } = repo.create({ text: 'Dentist follow-up' });
  const triaged = repo.triage(record.id, { important: true, urgent: true });
  assert.ok(triaged.ok);
  assert.equal(repo.read(record.id).status, 'triaged');

  const archived = repo.archive(record.id);
  assert.ok(archived.ok);
  assert.equal(repo.read(record.id).status, 'archived');

  // Idempotent: a second archive call on an already-archived capture is a safe no-op.
  const second = repo.archive(record.id);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-disposed');
});

test('repository.promote is idempotent at the storage layer too', () => {
  const repo = createBrainDumpRepository({ storage: memory(), now: () => T0, deviceId: () => 'device-1' });
  const { record } = repo.create({ text: 'Ping the landlord' });
  const promotion = { type: 'do-today', store: 'calendar', targetId: 'calplan:2026-10-01', planItemId: brainDumpPlanItemId(record.id) };
  const first = repo.promote(record.id, { promotion });
  assert.ok(first.ok);
  const retry = repo.promote(record.id, { promotion });
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, 'already-disposed');
  assert.equal(retry.record.promotion.planItemId, promotion.planItemId);
});

test('an unscoped repository with no joined room refuses writes rather than guessing an owner', () => {
  const repo = createBrainDumpRepository({ storage: memory(), getOwner: () => null, now: () => T0, deviceId: () => 'device-1' });
  const result = repo.create({ text: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-account');
  assert.deepEqual(repo.listAllRaw(), {});
});

test('two accounts sharing one physical device get separate cache slots', () => {
  const storage = memory();
  let owner = 'uid_a';
  const repo = createBrainDumpRepository({ storage, getOwner: () => owner, now: () => T0, deviceId: () => 'device-1' });
  repo.create({ text: 'A only' });
  assert.equal(Object.keys(repo.listAllRaw()).length, 1);
  owner = 'uid_b';
  assert.deepEqual(repo.listAllRaw(), {}, 'switching the owner must not see the previous account\'s captures');
  assert.ok(storage.getItem(brainDumpCacheKeyForRoom('uid_a')), 'A\'s cache slot is untouched, just not active');
});

test('a malformed inbound remote record is ignored by mergeRemote rather than corrupting local truth', () => {
  const repo = createBrainDumpRepository({ storage: memory(), now: () => T0, deviceId: () => 'device-1' });
  const { record } = repo.create({ text: 'Keep me' });
  const result = repo.mergeRemote(record.id, { garbage: true });
  assert.equal(result.changed, false);
  assert.equal(repo.read(record.id).text, 'Keep me');
});

test('validBrainDumpId matches the same Firebase-key-safe shape every other store uses', () => {
  assert.ok(validBrainDumpId('b1a2b3c4'));
  assert.equal(validBrainDumpId('has.dot'), false);
  assert.equal(validBrainDumpId('has/slash'), false);
  assert.equal(validBrainDumpId('ab'), false); // too short
});
