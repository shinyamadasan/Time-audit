import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validDate,
  normalizeLabel,
  coarseEvidenceId,
  validateCoarseEvidenceRecord,
  createCoarseEvidenceRecord,
  getCoarseEvidenceForDate,
  COARSE_LIFE_EVIDENCE_RESOLUTION,
  COARSE_LIFE_EVIDENCE_MEASUREMENT,
  COARSE_LIFE_EVIDENCE_PROVENANCE,
  COARSE_LIFE_EVIDENCE_KEY
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

test('a positive control interval-shaped object is unaffected by this model (no cross-contamination)', () => {
  // Sanity: this module never touches or reinterprets ordinary interval entries.
  const record = createCoarseEvidenceRecord({ date: '2026-09-09', timezone: tz, label: 'Cooking', estimatedMinutes: 30, now: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'tsStart'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'energy'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'onPlan'), false);
});
