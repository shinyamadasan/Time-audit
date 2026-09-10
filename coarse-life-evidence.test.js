import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validDate,
  normalizeLabel,
  coarseEvidenceId,
  validateCoarseEvidenceRecord,
  createCoarseEvidenceRecord,
  getCoarseEvidenceForDate,
  resolveCoarseEvidenceSync,
  COARSE_LIFE_EVIDENCE_RESOLUTION,
  COARSE_LIFE_EVIDENCE_MEASUREMENT,
  COARSE_LIFE_EVIDENCE_PROVENANCE,
  COARSE_LIFE_EVIDENCE_KEY,
  COARSE_LIFE_EVIDENCE_REMOTE_PATH
} from './coarse-life-evidence-model.js';
import { createCoarseEvidenceRepository } from './coarse-life-evidence-repository.js';

const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };
const tz = 'America/Phoenix';

// ── Model ────────────────────────────────────────────────────────────────

test('createCoarseEvidenceRecord produces a duration-without-placement record with no placement fields', () => {
  const record = createCoarseEvidenceRecord({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 80, now: 1000 });
  assert.equal(record.resolution, COARSE_LIFE_EVIDENCE_RESOLUTION);
  assert.equal(record.measurement, COARSE_LIFE_EVIDENCE_MEASUREMENT);
  assert.equal(record.provenance, COARSE_LIFE_EVIDENCE_PROVENANCE);
  assert.equal(record.estimatedMinutes, 80);
  assert.equal(record.date, '2026-09-09');
  assert.ok(!('tsStart' in record) && !('tsEnd' in record) && !('start' in record) && !('end' in record));
  assert.equal(record.id, coarseEvidenceId('2026-09-09', 'Cooking / eating'));
});

test('identity is deterministic by (date, normalized label) — case/whitespace insensitive', () => {
  assert.equal(coarseEvidenceId('2026-09-09', 'Household'), coarseEvidenceId('2026-09-09', '  household  '));
  assert.equal(coarseEvidenceId('2026-09-09', 'Household'), coarseEvidenceId('2026-09-09', 'HOUSEHOLD'));
  assert.notEqual(coarseEvidenceId('2026-09-09', 'Household'), coarseEvidenceId('2026-09-10', 'Household'));
  assert.notEqual(coarseEvidenceId('2026-09-09', 'Household'), coarseEvidenceId('2026-09-09', 'Errands'));
});

test('normalizeLabel collapses whitespace, trims, and caps length', () => {
  assert.equal(normalizeLabel('  Cooking   / eating  '), 'Cooking / eating');
  assert.equal(normalizeLabel('a'.repeat(200)).length, 60);
});

test('validDate rejects malformed and impossible calendar dates', () => {
  assert.ok(validDate('2026-09-09'));
  assert.equal(validDate('2026-13-01'), false);
  assert.equal(validDate('09-09-2026'), false);
  assert.equal(validDate(''), false);
  assert.equal(validDate(null), false);
});

test('validateCoarseEvidenceRecord rejects malformed duration, label, date, semantics', () => {
  const base = () => ({ id: coarseEvidenceId('2026-09-09', 'X'), date: '2026-09-09', timezone: tz, label: 'X', estimatedMinutes: 30, resolution: COARSE_LIFE_EVIDENCE_RESOLUTION, measurement: COARSE_LIFE_EVIDENCE_MEASUREMENT, provenance: COARSE_LIFE_EVIDENCE_PROVENANCE, createdAt: 1, updatedAt: 1 });
  assert.doesNotThrow(() => validateCoarseEvidenceRecord(base()));
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), estimatedMinutes: 0 })); // zero
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), estimatedMinutes: -5 })); // negative
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), estimatedMinutes: 1441 })); // > 24h
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), estimatedMinutes: 12.5 })); // non-integer
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), estimatedMinutes: NaN }));
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), label: '' })); // empty label
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), date: 'not-a-date' }));
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), resolution: 'interval' }));
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), measurement: 'measured' }));
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), provenance: 'device_observation' }));
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), tsStart: 1000 })); // no placement fields allowed
  assert.throws(() => validateCoarseEvidenceRecord({ ...base(), id: 'wrong-id' }));
});

test('getCoarseEvidenceForDate: filters by date and sums an honest total, never combined with anything else', () => {
  const records = [
    createCoarseEvidenceRecord({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 80, now: 1 }),
    createCoarseEvidenceRecord({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 45, now: 1 }),
    createCoarseEvidenceRecord({ date: '2026-09-08', timezone: tz, label: 'Errands', estimatedMinutes: 60, now: 1 })
  ];
  const result = getCoarseEvidenceForDate(records, '2026-09-09');
  assert.equal(result.records.length, 2);
  assert.equal(result.totalEstimatedMinutes, 125);
  assert.deepEqual(result.records.map(r => r.label), ['Cooking / eating', 'Household']);
  assert.equal(getCoarseEvidenceForDate(records, '2026-09-10').records.length, 0);
  assert.equal(getCoarseEvidenceForDate(records, '2026-09-10').totalEstimatedMinutes, 0);
});

// ── Repository (storage) ────────────────────────────────────────────────

test('repository: create, list, reload persistence', () => {
  const storage = memory();
  const repo = createCoarseEvidenceRepository(storage);
  assert.deepEqual(repo.list(), []);
  const saved = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 80, now: 1000 });
  assert.equal(saved.estimatedMinutes, 80);
  const reopened = createCoarseEvidenceRepository(storage); // simulates reload
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.get(saved.id).estimatedMinutes, 80);
});

test('editing replaces, never adds: 60 -> 90 stays 90, not 150', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const first = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 60, now: 1 });
  const second = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 90, now: 2, previousId: first.id });
  assert.equal(second.id, first.id);
  assert.equal(second.estimatedMinutes, 90);
  assert.equal(second.createdAt, first.createdAt); // identity preserved, not a new record
  const day = repo.listForDate('2026-09-09');
  assert.equal(day.records.length, 1);
  assert.equal(day.totalEstimatedMinutes, 90);
});

test('repeated save of the same identity, unchanged, does not duplicate', () => {
  const repo = createCoarseEvidenceRepository(memory());
  repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 80, now: 1 });
  repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 80, now: 2 });
  repo.save({ date: '2026-09-09', timezone: tz, label: 'cooking / eating', estimatedMinutes: 80, now: 3 }); // same identity, different case
  const day = repo.listForDate('2026-09-09');
  assert.equal(day.records.length, 1);
  assert.equal(day.totalEstimatedMinutes, 80);
});

test('different label on the same date is an independent record (no forced merge)', () => {
  const repo = createCoarseEvidenceRepository(memory());
  repo.save({ date: '2026-09-09', timezone: tz, label: 'Breakfast', estimatedMinutes: 20, now: 1 });
  repo.save({ date: '2026-09-09', timezone: tz, label: 'Dinner', estimatedMinutes: 60, now: 2 });
  const day = repo.listForDate('2026-09-09');
  assert.equal(day.records.length, 2);
  assert.equal(day.totalEstimatedMinutes, 80);
});

test('same label on a different date is an independent record; date ownership never moves (e.g. after-midnight edit to yesterday)', () => {
  const repo = createCoarseEvidenceRepository(memory());
  repo.save({ date: '2026-09-08', timezone: tz, label: 'Household', estimatedMinutes: 45, now: 1 });
  repo.save({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 30, now: 2 });
  assert.equal(repo.listForDate('2026-09-08').totalEstimatedMinutes, 45);
  assert.equal(repo.listForDate('2026-09-09').totalEstimatedMinutes, 30);
});

test('editing the label merges into the new identity and removes the stale row under the old label (identity was free)', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const first = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  const renamed = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 60, now: 2, previousId: first.id });
  assert.notEqual(renamed.id, first.id);
  assert.equal(repo.get(first.id), null);
  assert.equal(repo.listForDate('2026-09-09').records.length, 1);
});

// ── Rename/date-edit collision guard (independent-review Finding I) ────────

test('A: renaming a record onto an existing independent label/date is rejected, not silently merged', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const household = repo.save({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 45, now: 1 });
  const errands = repo.save({ date: '2026-09-09', timezone: tz, label: 'Errands', estimatedMinutes: 60, now: 2 });
  assert.throws(
    () => repo.save({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 60, now: 3, previousId: errands.id }),
    /already exists/
  );
  // Neither record was touched by the rejected save.
  assert.deepEqual(repo.get(household.id), household);
  assert.deepEqual(repo.get(errands.id), errands);
  assert.equal(repo.listForDate('2026-09-09').records.length, 2);
});

test('B: editing a record\'s date onto an already-occupied identity is rejected, not silently merged', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const yesterday = repo.save({ date: '2026-09-08', timezone: tz, label: 'Cooking', estimatedMinutes: 30, now: 1 });
  const today = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 90, now: 2 });
  assert.throws(
    () => repo.save({ date: '2026-09-08', timezone: tz, label: 'Cooking', estimatedMinutes: 90, now: 3, previousId: today.id }),
    /already exists/
  );
  assert.deepEqual(repo.get(yesterday.id), yesterday);
  assert.deepEqual(repo.get(today.id), today);
});

test('C: renaming to a free identity still succeeds (not a false collision)', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const first = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  const renamed = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 60, now: 2, previousId: first.id });
  assert.notEqual(renamed.id, first.id);
  assert.equal(repo.get(first.id), null);
  assert.equal(renamed.estimatedMinutes, 60);
});

test('D: moving a record to a free date still succeeds (not a false collision)', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const first = repo.save({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 45, now: 1 });
  const moved = repo.save({ date: '2026-09-08', timezone: tz, label: 'Household', estimatedMinutes: 45, now: 2, previousId: first.id });
  assert.notEqual(moved.id, first.id);
  assert.equal(repo.get(first.id), null);
  assert.equal(repo.listForDate('2026-09-08').records.length, 1);
  assert.equal(repo.listForDate('2026-09-09').records.length, 0);
});

test('E: a case/whitespace-only label edit on the SAME record is not a false collision', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const first = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 60, now: 1 });
  // Re-typed with different case/whitespace but normalizes to the same identity as `first` —
  // previousId === nextId here, so this must update in place, not be rejected as a collision.
  const edited = repo.save({ date: '2026-09-09', timezone: tz, label: '  cooking / eating  ', estimatedMinutes: 75, now: 2, previousId: first.id });
  assert.equal(edited.id, first.id);
  assert.equal(edited.estimatedMinutes, 75);
  assert.equal(repo.listForDate('2026-09-09').records.length, 1);
});

test('normal update semantics are preserved alongside the collision guard: same-id edits, unused-identity moves, repeated saves', () => {
  const repo = createCoarseEvidenceRepository(memory());
  // same id, duration edit -> update in place
  const a = repo.save({ date: '2026-09-09', timezone: tz, label: 'Travel', estimatedMinutes: 30, now: 1 });
  const a2 = repo.save({ date: '2026-09-09', timezone: tz, label: 'Travel', estimatedMinutes: 45, now: 2, previousId: a.id });
  assert.equal(a2.id, a.id);
  assert.equal(a2.estimatedMinutes, 45);
  // repeated unchanged save -> no duplicate
  repo.save({ date: '2026-09-09', timezone: tz, label: 'Travel', estimatedMinutes: 45, now: 3, previousId: a2.id });
  assert.equal(repo.listForDate('2026-09-09').records.filter(r => r.label === 'Travel').length, 1);
});

test('delete removes only the targeted record', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const a = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  const b = repo.save({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 30, now: 2 });
  assert.equal(repo.remove(a.id), true);
  assert.equal(repo.remove(a.id), false); // already gone
  const day = repo.listForDate('2026-09-09');
  assert.equal(day.records.length, 1);
  assert.equal(day.records[0].id, b.id);
});

test('malformed duration is rejected at the model boundary the repository enforces', () => {
  const repo = createCoarseEvidenceRepository(memory());
  assert.throws(() => repo.save({ date: '2026-09-09', timezone: tz, label: 'X', estimatedMinutes: 0, now: 1 }));
  assert.throws(() => repo.save({ date: '2026-09-09', timezone: tz, label: 'X', estimatedMinutes: -10, now: 1 }));
  assert.throws(() => repo.save({ date: '2026-09-09', timezone: tz, label: 'X', estimatedMinutes: NaN, now: 1 }));
  assert.throws(() => repo.save({ date: '2026-09-09', timezone: tz, label: 'X', estimatedMinutes: 1441, now: 1 })); // extreme value
  assert.throws(() => repo.save({ date: '2026-09-09', timezone: tz, label: '   ', estimatedMinutes: 30, now: 1 })); // empty label
  assert.throws(() => repo.save({ date: 'nonsense', timezone: tz, label: 'X', estimatedMinutes: 30, now: 1 }));
});

test('storage envelope with an unsupported format throws rather than silently discarding data', () => {
  const storage = memory();
  storage.setItem(COARSE_LIFE_EVIDENCE_KEY, JSON.stringify({ schemaVersion: 99, records: {} }));
  assert.throws(() => createCoarseEvidenceRepository(storage).list());
});

// ── Durability V1: resolveCoarseEvidenceSync (pure conflict rule) ──────────

test('resolveCoarseEvidenceSync: no local + non-deleted remote -> add', () => {
  const remote = createCoarseEvidenceRecord({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 100 });
  const result = resolveCoarseEvidenceSync(null, remote, 200);
  assert.equal(result.action, 'add');
  assert.equal(result.record.id, remote.id);
});

test('resolveCoarseEvidenceSync: no local + a deleted remote tombstone -> skip (never resurrects into a fresh local record)', () => {
  const remote = { id: 'x', deleted: true, updatedAt: 100 };
  assert.equal(resolveCoarseEvidenceSync(null, remote, 200).action, 'skip');
});

test('resolveCoarseEvidenceSync: remote strictly newer -> replace; remote older/equal -> keep-local', () => {
  const local = createCoarseEvidenceRecord({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 100 });
  const newerRemote = { ...local, estimatedMinutes: 90, updatedAt: 200 };
  const olderRemote = { ...local, estimatedMinutes: 30, updatedAt: 50 };
  const equalRemote = { ...local, estimatedMinutes: 30, updatedAt: 100 };
  assert.equal(resolveCoarseEvidenceSync(local, newerRemote).action, 'replace');
  assert.equal(resolveCoarseEvidenceSync(local, olderRemote).action, 'keep-local');
  assert.equal(resolveCoarseEvidenceSync(local, equalRemote).action, 'keep-local');
});

test('resolveCoarseEvidenceSync: a local tombstone cannot be resurrected by a merely-newer non-deleted remote (stale-device-echo protection)', () => {
  const local = { id: 'x', date: '2026-09-09', label: 'Cooking', deleted: true, updatedAt: 500 };
  const staleDeviceEcho = { id: 'x', date: '2026-09-09', label: 'Cooking', estimatedMinutes: 60, updatedAt: 9999 }; // newer, but no undoRestoredAt
  assert.equal(resolveCoarseEvidenceSync(local, staleDeviceEcho).action, 'keep-local');
});

test('resolveCoarseEvidenceSync: an explicit undoRestoredAt newer than the tombstone IS allowed to restore', () => {
  const local = { id: 'x', date: '2026-09-09', label: 'Cooking', deleted: true, updatedAt: 500 };
  const explicitUndo = { id: 'x', date: '2026-09-09', label: 'Cooking', estimatedMinutes: 60, updatedAt: 600, undoRestoredAt: 600 };
  const result = resolveCoarseEvidenceSync(local, explicitUndo);
  assert.equal(result.action, 'replace');
  assert.equal(result.record.deleted, undefined);
});

test('resolveCoarseEvidenceSync: an undoRestoredAt that is not actually newer than the tombstone is still rejected', () => {
  const local = { id: 'x', date: '2026-09-09', label: 'Cooking', deleted: true, updatedAt: 500 };
  const oldUndo = { id: 'x', date: '2026-09-09', label: 'Cooking', estimatedMinutes: 60, updatedAt: 400, undoRestoredAt: 400 };
  assert.equal(resolveCoarseEvidenceSync(local, oldUndo).action, 'keep-local');
});

test('resolveCoarseEvidenceSync: both sides deleted -> ordinary LWW applies (no special-casing)', () => {
  const local = { id: 'x', deleted: true, updatedAt: 100 };
  const remote = { id: 'x', deleted: true, updatedAt: 200 };
  assert.equal(resolveCoarseEvidenceSync(local, remote).action, 'replace');
});

// ── Durability V1: repository tombstone semantics ───────────────────────────

test('remove() tombstones rather than erasing: gone from list()/get(), still present via getRaw()', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const a = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  assert.equal(repo.remove(a.id, { now: 2 }), true);
  assert.equal(repo.remove(a.id, { now: 3 }), false); // already gone, same observable contract as before
  assert.equal(repo.get(a.id), null);
  assert.equal(repo.listForDate('2026-09-09').records.length, 0);
  const raw = repo.getRaw(a.id);
  assert.equal(raw.deleted, true);
  assert.equal(raw.updatedAt, 2);
  assert.equal(repo.listAllRaw().length, 1); // tombstone is retained locally, not erased
});

test('a tombstoned identity is free: a plain Add resurrects it, and a rename can land on it', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const a = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  repo.remove(a.id, { now: 2 });
  // Plain Add (no previousId) onto the now-tombstoned identity succeeds and un-deletes it.
  const resurrected = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 45, now: 3 });
  assert.equal(resurrected.id, a.id);
  assert.equal(resurrected.deleted, undefined);
  assert.equal(repo.listForDate('2026-09-09').records.length, 1);
  // Resurrection is stamped with undoRestoredAt so a device that already holds the
  // tombstone can distinguish this from a stale pre-delete echo (resolveCoarseEvidenceSync).
  assert.equal(resurrected.undoRestoredAt, 3);

  // A rename onto a different, tombstoned identity also succeeds (not a false collision).
  const other = repo.save({ date: '2026-09-09', timezone: tz, label: 'Errands', estimatedMinutes: 20, now: 4 });
  repo.remove(other.id, { now: 5 });
  const renamedOnto = repo.save({ date: '2026-09-09', timezone: tz, label: 'Errands', estimatedMinutes: 30, now: 6, previousId: resurrected.id });
  assert.equal(renamedOnto.id, other.id);
  assert.equal(renamedOnto.deleted, undefined);
  assert.equal(renamedOnto.undoRestoredAt, 6); // rename landing on a tombstoned identity is also a resurrection
});

test('a plain edit of an already-live record (no tombstone involved) never gets a stray undoRestoredAt', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const a = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  const edited = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 90, now: 2 });
  assert.equal(edited.id, a.id);
  assert.equal(edited.undoRestoredAt, undefined);
});

test('renaming/moving a record tombstones its old identity instead of erasing it (so a durable remote copy learns the rename)', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const first = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  const renamed = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking / eating', estimatedMinutes: 60, now: 2, previousId: first.id });
  assert.notEqual(renamed.id, first.id);
  assert.equal(repo.get(first.id), null); // ordinary reads still see it as gone
  const oldRaw = repo.getRaw(first.id);
  assert.equal(oldRaw.deleted, true); // but it is a tombstone, not erased
  assert.equal(oldRaw.updatedAt, 2);
  assert.equal(repo.listForDate('2026-09-09').records.length, 1);
});

test('rename collision guard still rejects landing on a genuinely live (non-deleted) existing identity', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const household = repo.save({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 45, now: 1 });
  const errands = repo.save({ date: '2026-09-09', timezone: tz, label: 'Errands', estimatedMinutes: 60, now: 2 });
  assert.throws(
    () => repo.save({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 60, now: 3, previousId: errands.id }),
    /already exists/
  );
  assert.deepEqual(repo.get(household.id), household);
});

// ── Durability V1: mergeRemoteSnapshot (bootstrap / union / idempotence / malformed) ──

test('mergeRemoteSnapshot: local + empty remote -> merge itself makes no local change (pushAllLocal, not merge, is what durabilizes local-only data)', () => {
  const repo = createCoarseEvidenceRepository(memory());
  repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  const result = repo.mergeRemoteSnapshot({}, 2);
  assert.equal(result.changed, false);
  assert.equal(repo.list().length, 1);
});

test('mergeRemoteSnapshot: empty local + remote present -> remote records become locally available', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const remote = createCoarseEvidenceRecord({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 45, now: 1 });
  const result = repo.mergeRemoteSnapshot({ [remote.id]: remote }, 2);
  assert.equal(result.changed, true);
  assert.deepEqual(result.changedIds, [remote.id]);
  assert.equal(repo.get(remote.id).estimatedMinutes, 45);
});

test('mergeRemoteSnapshot: different local/remote records -> union survives, neither side dropped', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const local = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  const remote = createCoarseEvidenceRecord({ date: '2026-09-09', timezone: tz, label: 'Household', estimatedMinutes: 45, now: 1 });
  repo.mergeRemoteSnapshot({ [remote.id]: remote }, 2);
  const day = repo.listForDate('2026-09-09');
  assert.equal(day.records.length, 2);
  assert.ok(day.records.some(r => r.id === local.id));
  assert.ok(day.records.some(r => r.id === remote.id));
});

test('mergeRemoteSnapshot: same id/same content on both sides converges idempotently, no duplicate, no churn', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const local = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  const first = repo.mergeRemoteSnapshot({ [local.id]: local }, 2);
  assert.equal(first.changed, false); // identical updatedAt -> keep-local, no write
  const second = repo.mergeRemoteSnapshot({ [local.id]: local }, 3);
  assert.equal(second.changed, false);
  assert.equal(repo.list().length, 1);
});

test('mergeRemoteSnapshot: repeated sync of the same divergent state does not loop or re-apply after converging', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const local = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  const newerRemote = { ...local, estimatedMinutes: 90, updatedAt: 5 };
  const first = repo.mergeRemoteSnapshot({ [local.id]: newerRemote }, 6);
  assert.equal(first.changed, true);
  assert.equal(repo.get(local.id).estimatedMinutes, 90);
  // Re-delivering the exact same remote snapshot again (Firebase re-fires on reconnect) must not re-apply or duplicate.
  const second = repo.mergeRemoteSnapshot({ [local.id]: newerRemote }, 7);
  assert.equal(second.changed, false);
  assert.equal(repo.list().length, 1);
});

test('mergeRemoteSnapshot: a same-id divergent edit resolves deterministically by updatedAt (documented LWW, not silent collection loss)', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const local = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 10 });
  const olderRemote = { ...local, estimatedMinutes: 999, updatedAt: 5 };
  repo.mergeRemoteSnapshot({ [local.id]: olderRemote }, 11);
  assert.equal(repo.get(local.id).estimatedMinutes, 60); // local (newer) wins deterministically
});

test('mergeRemoteSnapshot: a deleted-locally record does not resurrect from a stale non-deleted remote copy (device offline during the delete)', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const a = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  repo.remove(a.id, { now: 2 });
  const staleRemoteEcho = { ...a, updatedAt: 9999 }; // another device pushing its stale pre-delete copy
  const result = repo.mergeRemoteSnapshot({ [a.id]: staleRemoteEcho }, 10000);
  assert.equal(result.changed, false);
  assert.equal(repo.get(a.id), null); // still gone
});

test('mergeRemoteSnapshot: malformed remote entries are rejected without crashing and without touching valid local data', () => {
  const repo = createCoarseEvidenceRepository(memory());
  const local = repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  const result = repo.mergeRemoteSnapshot({
    'bad-1': { estimatedMinutes: -5 },                 // fails model validation
    'bad-2': { id: 'mismatched-id', date: '2026-09-09', timezone: tz, label: 'X', estimatedMinutes: 10, resolution: COARSE_LIFE_EVIDENCE_RESOLUTION, measurement: COARSE_LIFE_EVIDENCE_MEASUREMENT, provenance: COARSE_LIFE_EVIDENCE_PROVENANCE, createdAt: 1, updatedAt: 1 }, // key/id mismatch
    'bad-3': 'not-an-object',
    'bad-4': null
  }, 2);
  assert.equal(result.changed, false);
  assert.equal(repo.list().length, 1);
  assert.equal(repo.get(local.id).estimatedMinutes, 60);
});

test('mergeRemoteSnapshot: a non-object snapshot (e.g. remote path briefly null) is a safe no-op, never a collection wipe', () => {
  const repo = createCoarseEvidenceRepository(memory());
  repo.save({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 60, now: 1 });
  assert.equal(repo.mergeRemoteSnapshot(null, 2).changed, false);
  assert.equal(repo.mergeRemoteSnapshot(undefined, 2).changed, false);
  assert.equal(repo.list().length, 1);
});

test('COARSE_LIFE_EVIDENCE_REMOTE_PATH is a stable, independent path segment (not entries/reviews/plans)', () => {
  assert.equal(COARSE_LIFE_EVIDENCE_REMOTE_PATH, 'coarseLifeEvidence');
});

test('a positive control interval-shaped object is unaffected by this model (no cross-contamination)', () => {
  // Sanity: this module never touches or reinterprets ordinary interval entries.
  const record = createCoarseEvidenceRecord({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 30, now: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'tsStart'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'energy'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'onPlan'), false);
});
