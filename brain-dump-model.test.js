// brain-dump-model.test.js
//
// Brain Dump + Eisenhower V1. Pure model (brain-dump-model.js) and the local
// repository built on top of it (brain-dump-repository.js). No Firebase, no
// network — account-isolation and cross-device concurrency are covered
// separately in brain-dump-account-isolation.test.js and brain-dump-sync.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validBrainDumpId, brainDumpPlanItemId, buildCapture, triageCapture, claimPromotion, finalizePromotion,
  archiveCapture, delegateCapture, normalizeCapture, mergeCaptureRecords, arbitratePromotionClaim,
  mergeCaptureMaps, allCaptures, untriagedCaptures, triagedCaptures, disposedCaptures, quadrantOf,
  TERMINAL_STATUSES,
} from './brain-dump-model.js';
import { createBrainDumpRepository, brainDumpCacheKeyForRoom } from './brain-dump-repository.js';

const T0 = Date.parse('2026-10-01T08:00:00Z');
const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), _map: map };
};

/** Pure-model convenience: both promotion phases, no Plan Authority involved
 *  (these tests are about the capture-side arbitration, not the plan write). */
function promoteFully(record, { promotion, now, updatedBy }) {
  const claimed = claimPromotion(record, { promotion, now, updatedBy });
  if (!claimed.ok) return claimed;
  return finalizePromotion(claimed.record, { now: now + 1, updatedBy });
}

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

  const claimAttempt = claimPromotion(archived, {
    promotion: { type: 'do-today', store: 'calendar', targetId: 'calplan:2026-10-01', planItemId: 'bdp1|bidone1' },
    now: T0 + 4, updatedBy: 'd',
  });
  assert.equal(claimAttempt.ok, false);
  assert.equal(claimAttempt.reason, 'already-disposed');
});

test('claimPromotion then finalizePromotion records provenance (store, targetId, planItemId) and nothing else', () => {
  const base = buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record;
  const result = promoteFully(base, {
    promotion: { type: 'schedule', store: 'calendar', targetId: 'calplan:2026-10-05', planItemId: brainDumpPlanItemId('bidone1') },
    now: T0 + 1, updatedBy: 'd',
  });
  assert.ok(result.ok);
  assert.equal(result.record.status, 'promoted');
  assert.equal(result.record.promotion.type, 'schedule');
  assert.equal(result.record.promotion.planItemId, 'bdp1|bidone1');
  assert.equal(result.record.promotionClaim, null);
  assert.equal(result.record.disposedAt, T0 + 2);
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
  // Generation 2 is the reopen-aware record generation (Production UX Correction V1); 3 is unknown.
  assert.equal(normalizeCapture({ ...base, schemaVersion: 3 }), null);
  assert.equal(normalizeCapture({ ...base, schemaVersion: 2 }).schemaVersion, 2);
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
  const promoted = promoteFully(triaged, {
    promotion: { type: 'do-today', store: 'legacy', targetId: '2026-10-01', planItemId: 'bdp1|bidone1' },
    now: T0 + 2, updatedBy: 'd',
  }).record;
  const records = { bidone1: promoted };
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

test('repository.claimPromotion + finalizePromotion round-trip and are each idempotent at the storage layer', () => {
  const repo = createBrainDumpRepository({ storage: memory(), now: () => T0, deviceId: () => 'device-1' });
  const { record } = repo.create({ text: 'Ping the landlord' });
  const promotion = { type: 'do-today', store: 'calendar', targetId: 'calplan:2026-10-01', planItemId: brainDumpPlanItemId(record.id) };

  const claimed = repo.claimPromotion(record.id, { promotion });
  assert.ok(claimed.ok);
  assert.equal(repo.read(record.id).status, 'untriaged'); // claiming never changes status by itself
  assert.deepEqual(repo.read(record.id).promotionClaim, { ...promotion, when: '', durationMinutes: null, claimedAt: T0, claimedBy: 'device-1', planWriteStarted: true });

  // Re-claiming the SAME target is a no-op success (a retry).
  const reclaim = repo.claimPromotion(record.id, { promotion });
  assert.ok(reclaim.ok);

  // Archive refuses outright while the claim is outstanding.
  const archiveAttempt = repo.archive(record.id);
  assert.equal(archiveAttempt.ok, false);
  assert.equal(archiveAttempt.reason, 'promotion-claimed');

  const finalized = repo.finalizePromotion(record.id);
  assert.ok(finalized.ok);
  assert.equal(finalized.record.status, 'promoted');
  assert.equal(finalized.record.promotionClaim, null);

  const retry = repo.finalizePromotion(record.id);
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

// ═══════════════════════════════════════════════════════════════════════════
// FIX FIRST: promote-vs-archive/delegate arbitration (brain-dump-model.js's
// captureAuthorityRank + claimPromotion/finalizePromotion). These are the
// pure-model-level proofs; brain-dump-promotion.test.js proves the same
// invariants at the orchestration layer (capture state AND the destination plan
// store), and brain-dump-account-isolation.test.js proves the account-switch case.
// ═══════════════════════════════════════════════════════════════════════════

const PROMO_A = { type: 'do-today', store: 'calendar', targetId: 'calplan:2026-10-01', planItemId: 'bdp1|bidone1' };
const PROMO_B = { type: 'schedule', store: 'calendar', targetId: 'calplan:2026-10-10', planItemId: 'bdp1|bidone1' };

test('claimPromotion refuses a DIFFERENT competing claim, but a re-claim of the SAME target is a no-op success', () => {
  const triaged = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const claimed = claimPromotion(triaged, { promotion: PROMO_A, now: T0 + 2, updatedBy: 'device-1' });
  assert.ok(claimed.ok);

  const competing = claimPromotion(claimed.record, { promotion: PROMO_B, now: T0 + 3, updatedBy: 'device-2' });
  assert.equal(competing.ok, false);
  assert.equal(competing.reason, 'already-claimed');
  assert.deepEqual(competing.record.promotionClaim, claimed.record.promotionClaim, 'the existing claim is untouched');

  const reclaim = claimPromotion(claimed.record, { promotion: PROMO_A, now: T0 + 4, updatedBy: 'device-1' });
  assert.ok(reclaim.ok, 're-claiming the SAME target is idempotent, not a conflict');
});

test('archiveCapture/delegateCapture fail closed — reason "promotion-claimed" — whenever a claim is outstanding', () => {
  const triaged = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: false, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const claimed = claimPromotion(triaged, { promotion: PROMO_A, now: T0 + 2, updatedBy: 'd' }).record;
  assert.equal(archiveCapture(claimed, { now: T0 + 3, updatedBy: 'd' }).ok, false);
  assert.equal(archiveCapture(claimed, { now: T0 + 3, updatedBy: 'd' }).reason, 'promotion-claimed');
  assert.equal(delegateCapture(claimed, { now: T0 + 3, updatedBy: 'd' }).ok, false);
  assert.equal(delegateCapture(claimed, { now: T0 + 3, updatedBy: 'd' }).reason, 'promotion-claimed');
});

test('finalizePromotion without a prior claim refuses with "no-claim"', () => {
  const triaged = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const result = finalizePromotion(triaged, { now: T0 + 2, updatedBy: 'd' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-claim');
});

test('merge authority rank: PROMOTED always beats ARCHIVED/DELEGATED, regardless of updatedAt or argument order', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const promoted = promoteFully(base, { promotion: PROMO_A, now: T0 + 2, updatedBy: 'device-a' }).record;
  // The archive happened LATER in wall-clock time than the promotion — naive LWW
  // would wrongly pick this one. It must still lose.
  const archived = archiveCapture(base, { now: T0 + 1000, updatedBy: 'device-b' }).record;

  const mergedPA = mergeCaptureRecords(promoted, archived);
  const mergedAP = mergeCaptureRecords(archived, promoted);
  assert.equal(mergedPA.status, 'promoted');
  assert.equal(mergedAP.status, 'promoted');
  assert.deepEqual(mergedPA.promotion, promoted.promotion, 'provenance survives the merge');
  assert.deepEqual(mergedAP.promotion, promoted.promotion);
});

test('merge authority rank: PROMOTED always beats DELEGATED too, regardless of updatedAt', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: false, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const promoted = promoteFully(base, { promotion: PROMO_A, now: T0 + 2, updatedBy: 'device-a' }).record;
  const delegated = delegateCapture(base, { delegatedTo: 'Alex', now: T0 + 1000, updatedBy: 'device-b' }).record;
  assert.equal(mergeCaptureRecords(promoted, delegated).status, 'promoted');
  assert.equal(mergeCaptureRecords(delegated, promoted).status, 'promoted');
});

test('merge authority rank: a CLAIM (promotion in progress, plan item may not exist yet) beats ARCHIVED/DELEGATED too', () => {
  // This is the crash-window case: the plan write has not necessarily happened
  // yet, but the claim alone must still outrank a concurrent archive/delegate —
  // see the file banner.
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: false, now: T0 + 1, updatedBy: 'd' }).record;
  const claimed = claimPromotion(base, { promotion: PROMO_A, now: T0 + 2, updatedBy: 'device-a' }).record;
  const archived = archiveCapture(base, { now: T0 + 1000, updatedBy: 'device-b' }).record;
  const merged = mergeCaptureRecords(claimed, archived);
  assert.ok(merged.promotionClaim, 'the claim survives the merge, not the later archive');
  assert.equal(merged.status, 'triaged');
});

test('merge authority rank: a LATE remote snapshot of a stale archived/delegated record cannot resurrect over an already-promoted truth', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const promoted = promoteFully(base, { promotion: PROMO_A, now: T0 + 2, updatedBy: 'device-a' }).record;
  // A stale snapshot from BEFORE the promotion (lower updatedAt), arriving LATE
  // over the network, showing the capture as archived from a device that never
  // saw the promotion.
  const staleArchived = archiveCapture(base, { now: T0 + 1, updatedBy: 'device-b' }).record;
  const merged = mergeCaptureRecords(promoted, staleArchived);
  assert.equal(merged.status, 'promoted');
  assert.deepEqual(merged.promotion, promoted.promotion);
});

test('merge: two outstanding claims for DIFFERENT targets converge on the EARLIEST claim, independent of argument order (tie case)', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const claimedA = claimPromotion(base, { promotion: PROMO_A, now: T0 + 10, updatedBy: 'device-a' }).record;
  const claimedB = claimPromotion(base, { promotion: PROMO_B, now: T0 + 20, updatedBy: 'device-b' }).record;
  const mergedAB = mergeCaptureRecords(claimedA, claimedB);
  const mergedBA = mergeCaptureRecords(claimedB, claimedA);
  assert.deepEqual(mergedAB.promotionClaim, claimedA.promotionClaim, 'earliest claimedAt wins');
  assert.deepEqual(mergedBA.promotionClaim, claimedA.promotionClaim, 'independent of argument order');
});

test('merge: an EXACT tie between two different claims (same claimedAt) is still deterministic both ways', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const claimedA = claimPromotion(base, { promotion: PROMO_A, now: T0 + 10, updatedBy: 'device-a' }).record;
  const claimedB = claimPromotion(base, { promotion: PROMO_B, now: T0 + 10, updatedBy: 'device-b' }).record;
  const mergedAB = mergeCaptureRecords(claimedA, claimedB);
  const mergedBA = mergeCaptureRecords(claimedB, claimedA);
  assert.deepEqual(mergedAB, mergedBA, 'deterministic regardless of which side is "local"');
});

test('normalizeCapture refuses a promotionClaim on a terminal record, and refuses a malformed claim shape', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const claimed = claimPromotion(base, { promotion: PROMO_A, now: T0 + 2, updatedBy: 'd' }).record;
  const archived = archiveCapture(base, { now: T0 + 3, updatedBy: 'd' }).record;
  assert.equal(normalizeCapture({ ...archived, promotionClaim: claimed.promotionClaim }), null, 'a terminal record may never carry a claim');
  assert.equal(normalizeCapture({ ...claimed, promotionClaim: { ...claimed.promotionClaim, claimedAt: undefined } }), null, 'a malformed claim is refused, not half-trusted');
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX FIRST round 2: arbitratePromotionClaim — the gate a BRAND NEW claim must
// pass against the AUTHORITATIVE REMOTE record (distinct from the ordinary
// mergeCaptureRecords rank rule, which protects an ALREADY-ESTABLISHED
// claim/promotion). This is the pure-model proof; brain-dump-sync.test.js and
// brain-dump-promotion.test.js prove it wired into a real Firebase transaction
// and the full orchestration layer.
// ═══════════════════════════════════════════════════════════════════════════

test('arbitratePromotionClaim: a brand-new claim is REFUSED outright against an already-authoritative ARCHIVED remote, even though claimed would outrank archived by the ordinary merge rule', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const archivedRemote = archiveCapture(base, { now: T0 + 2, updatedBy: 'device-b' }).record;
  const candidate = claimPromotion(base, { promotion: PROMO_A, now: T0 + 3, updatedBy: 'device-a' }).record;

  // The ordinary merge rule WOULD let the claim (rank 2) beat archived (rank 1)
  // — that is correct for protecting an ALREADY-ESTABLISHED claim, but wrong
  // for establishing a BRAND NEW one against settled remote truth.
  assert.equal(mergeCaptureRecords(archivedRemote, candidate).status, 'triaged', 'sanity: the ordinary rule alone would let the new claim win');

  const result = arbitratePromotionClaim(archivedRemote, candidate);
  assert.equal(result, undefined, 'the claim gate refuses outright — no write at all');
});

test('arbitratePromotionClaim: a brand-new claim is REFUSED outright against an already-authoritative DELEGATED remote', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: false, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const delegatedRemote = delegateCapture(base, { delegatedTo: 'Alex', now: T0 + 2, updatedBy: 'device-b' }).record;
  const candidate = claimPromotion(base, { promotion: PROMO_A, now: T0 + 3, updatedBy: 'device-a' }).record;
  assert.equal(arbitratePromotionClaim(delegatedRemote, candidate), undefined);
});

test('arbitratePromotionClaim: a brand-new claim is REFUSED against an already-authoritative PROMOTED remote (a different device already finished)', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const promotedRemote = promoteFully(base, { promotion: PROMO_A, now: T0 + 2, updatedBy: 'device-b' }).record;
  const candidate = claimPromotion(base, { promotion: PROMO_B, now: T0 + 3, updatedBy: 'device-a' }).record;
  assert.equal(arbitratePromotionClaim(promotedRemote, candidate), undefined);
});

test('arbitratePromotionClaim: establishes the claim cleanly when remote is untriaged/triaged with no outstanding claim', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const candidate = claimPromotion(base, { promotion: PROMO_A, now: T0 + 2, updatedBy: 'device-a' }).record;
  const result = arbitratePromotionClaim(base, candidate);
  assert.deepEqual(result, candidate);
});

test('arbitratePromotionClaim: two genuinely concurrent NEW claims against each other (neither remote is terminal yet) fall through to the ordinary earliest-wins tie-break', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const remoteClaim = claimPromotion(base, { promotion: PROMO_A, now: T0 + 10, updatedBy: 'device-a' }).record; // already on remote
  const candidate = claimPromotion(base, { promotion: PROMO_B, now: T0 + 20, updatedBy: 'device-b' }).record; // arriving later
  const result = arbitratePromotionClaim(remoteClaim, candidate);
  assert.deepEqual(result.promotionClaim, remoteClaim.promotionClaim, 'the earlier claim still wins — not a blanket refusal, since remote is not terminal');
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX FIRST round 3: the claim carries `when`/`durationMinutes` so a reconciler
// that never saw the original UI action (a different device, or the same
// device after a restart) can still build the EXACT intended item — see
// reconcilePromotionClaim in brain-dump-promotion.js.
// ═══════════════════════════════════════════════════════════════════════════

test('claimPromotion persists when/durationMinutes on the claim for a Schedule promotion, so a later reconciler needs no fresh UI input', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: false, now: T0 + 1, updatedBy: 'd' }).record;
  const claimed = claimPromotion(base, {
    promotion: { type: 'schedule', store: 'calendar', targetId: 'calplan:2026-10-10', planItemId: 'bdp1|bidone1', when: '14:30', durationMinutes: 45 },
    now: T0 + 2, updatedBy: 'device-a',
  });
  assert.ok(claimed.ok);
  assert.equal(claimed.record.promotionClaim.when, '14:30');
  assert.equal(claimed.record.promotionClaim.durationMinutes, 45);
});

test('claimPromotion defaults when to "" and durationMinutes to null when omitted (Do Today is always untimed)', () => {
  const base = triageCapture(buildCapture({ id: 'bidone1', text: 'x', now: T0, updatedBy: 'd' }).record, { important: true, urgent: true, now: T0 + 1, updatedBy: 'd' }).record;
  const claimed = claimPromotion(base, { promotion: PROMO_A, now: T0 + 2, updatedBy: 'device-a' });
  assert.ok(claimed.ok);
  assert.equal(claimed.record.promotionClaim.when, '');
  assert.equal(claimed.record.promotionClaim.durationMinutes, null);
});
