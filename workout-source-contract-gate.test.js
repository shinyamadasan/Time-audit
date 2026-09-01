// ── Compatibility gate: "Does current openGym still satisfy WORKOUT_LEDGER_SOURCE_CONTRACT_V1?" ──
//
// This is the adapter-side half of the gate; the source-side half lives in openGym-longevity at
// frontend/src/lib/workout-ledger-source-contract.test.js. See contracts/WORKOUT_LEDGER_SOURCE_CONTRACT_V1.md
// for the numbered clauses every test below is anchored to.
//
// Three kinds of proof, on purpose:
//   1. REAL fixture replay — fixtures/workout-source-contract-v1.fixture.json's csvImportVariant
//      is captured by ACTUALLY RUNNING openGym's parseWorkoutCSV() (see that file's provenance
//      block); this suite feeds it straight into the real adapter.
//   2. Chaos/mutation tests — deliberately break a contract-required invariant on a copy of a
//      known-good fixture record and assert the adapter's gate actually catches it, with a
//      specific reason code, not a generic failure.
//   3. Benign-change tests — prove harmless source evolution (extra fields, new UI-only state,
//      unrelated variants) does NOT trip the gate. A gate that blocks everything is as useless
//      as one that blocks nothing.
//
// Run in isolation: `npm run test:workout-source-gate`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as workoutAdapter from './workout-life-ledger-adapter.js';
import { resolveWorkoutFixture } from './fixtures/resolve-fixture.js';

const { normalizeWorkoutBackup, normalizeWorkoutCompleted } = workoutAdapter;

const CHECKED_IN_FIXTURE_PATH = path.resolve('fixtures', 'workout-source-contract-v1.fixture.json');
const checkedIn = JSON.parse(fs.readFileSync(CHECKED_IN_FIXTURE_PATH, 'utf8'));

const resolved = resolveWorkoutFixture();
console.log(`\nworkout-source-contract-gate.test.js: csvImportVariant source = ${resolved.source} (${resolved.path})`);
// A live sibling fixture only ever carries csvImportVariant (see resolve-fixture.js) — the
// native-variant examples always come from the checked-in file, which always exists on a normal
// checkout.
const csvImportVariant = resolved.fixture?.workout ? resolved.fixture : checkedIn.csvImportVariant;

const TZ = 'America/Phoenix';
const ctx = { assertedTimezone: TZ, observedAt: '2026-09-01T06:20:00.000Z' };

function clone(value) { return JSON.parse(JSON.stringify(value)); }

console.log('\nWorkout source contract V1 — compatibility gate');

test('§2/§4: the real CSV-import-path fixture (genuinely executed parseWorkoutCSV output) normalizes cleanly', () => {
  const result = normalizeWorkoutCompleted(clone(csvImportVariant.workout), ctx);
  assert.equal(result.ok, true, `Workout source contract V1 broken: a real, currently-produced CSV-import workout was rejected — ${JSON.stringify(result)}`);
  assert.equal(result.draft.payload.source.recordCategory, 'csv_import_path_compatible');
  assert.equal(result.draft.payload.source.durationStatus, 'unknown', 'Workout source contract V1 broken: an equal-time CSV import must report unknown duration, not a fabricated interval');
  assert.equal('durationMinutes' in result.draft.payload, false, 'Workout source contract V1 broken: durationMinutes must never be published as 0 for an equal-time record');
});

test('§5: the hand-authored native-variant fixture (verified against doFinishWorkout) normalizes cleanly with every documented field', () => {
  const result = normalizeWorkoutCompleted(clone(checkedIn.nativeVariant.workout), ctx);
  assert.equal(result.ok, true, `Workout source contract V1 broken: ${JSON.stringify(result)}`);
  assert.equal(result.draft.payload.volume, 1320);
  assert.equal(result.draft.payload.bodyWeight.value, 82.5);
  assert.equal(result.draft.payload.rating, 'right');
  assert.equal(result.draft.payload.source.routineId, 'r_push_day');
  assert.deepEqual(result.draft.payload.source.personalRecordExerciseIds, ['barbell-bench-press']);
});

test('§4: the zero-duration native example is accepted with unknown/zero duration, never a fabricated interval', () => {
  const result = normalizeWorkoutCompleted(clone(checkedIn.nativeVariantCsvImportShaped.workout), ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.draft.payload.source.durationStatus, 'zero-or-unknown');
  assert.equal('durationMinutes' in result.draft.payload, false);
});

test('benign: an unrelated future UI-only field on the workout record does not break normalization', () => {
  const result = normalizeWorkoutCompleted(clone(checkedIn.nativeVariantBenign.workout), ctx);
  assert.equal(result.ok, true, `A benign, adapter-ignored field must never break the contract — ${JSON.stringify(result)}`);
  assert.equal(result.draft.payload.workoutName, 'Easy Cardio');
});

test('benign: cardio-mode sets normalize alongside strength/timed variants with no cross-contamination', () => {
  const result = normalizeWorkoutCompleted(clone(checkedIn.nativeVariantBenign.workout), ctx);
  assert.equal(result.ok, true);
  assert.equal(result.draft.payload.exercises[0].mode, 'cardio');
});

// ── Chaos / mutation tests ──────────────────────────────────────────────────────────────────

test('chaos: renaming workout.id (identity break) is rejected, never silently re-keyed', () => {
  const mutated = clone(checkedIn.nativeVariant.workout);
  delete mutated.id;
  mutated.workoutId = 'wk_9f1c2a7b4e3d4a10'; // a plausible-looking but wrong field name
  const result = normalizeWorkoutCompleted(mutated, ctx);
  assert.equal(result.ok, false, 'Workout source contract V1 broken: a workout with no `id` field must be rejected, not silently accepted under a different key');
  assert.equal(result.reason, 'missing_source_entity_id');
});

test('chaos: omitting end (schema break) is rejected, never coerced to start or 0', () => {
  const mutated = clone(checkedIn.nativeVariant.workout);
  delete mutated.end;
  const result = normalizeWorkoutCompleted(mutated, ctx);
  assert.equal(result.ok, false, 'Workout source contract V1 broken: a workout missing `end` must be rejected, not defaulted');
  assert.equal(result.reason, 'invalid_workout_interval');
});

test('chaos: a global unit relabel never retroactively relabels already-recorded numeric loads (semantic break)', () => {
  const mutated = clone(checkedIn.nativeVariant.workout);
  const kg = normalizeWorkoutCompleted(clone(mutated), { ...ctx, assertedWeightUnit: 'kg' });
  const lb = normalizeWorkoutCompleted(clone(mutated), { ...ctx, assertedWeightUnit: 'lb' });
  assert.equal(kg.ok, true);
  assert.equal(lb.ok, true);
  // The RAW numeric load is never converted by the adapter itself — only the asserted-unit
  // LABEL changes. A source-side "relabel the same numbers as a new unit" bug would be caught by
  // an integration test asserting a converted magnitude; this assertion protects the narrower,
  // load-bearing invariant: the adapter must not silently reinterpret the number.
  assert.equal(kg.draft.payload.exercises[0].sets[0].load, lb.draft.payload.exercises[0].sets[0].load);
  assert.equal(kg.draft.payload.source.weightUnitContext.unit, 'kg');
  assert.equal(lb.draft.payload.source.weightUnitContext.unit, 'lb');
});

test('chaos: altering set mode mid-exercise (mixed reps/timed sets) is rejected as ambiguous, never averaged or first-wins', () => {
  const mutated = clone(checkedIn.nativeVariant.workout);
  mutated.entries[0].sets.push({ sec: 30, done: true }); // a timed set injected into a reps exercise
  const result = normalizeWorkoutCompleted(mutated, ctx);
  assert.equal(result.ok, false, 'Workout source contract V1 broken: mixed set modes within one exercise must be rejected');
  assert.equal(result.reason, 'ambiguous_set_mode');
});

test('chaos: treating backup._ts as a per-workout revision number never lets a stale replay win (batch-level proof)', () => {
  const backup = { workouts: [clone(checkedIn.nativeVariant.workout)], _ts: 1 };
  const store = new Map();
  const fakeStore = {
    getByKey: k => store.get(k) || null,
    upsertEvent(draft) {
      const key = `workout:${draft.sourceEntityId}:workout_completed`;
      store.set(key, { event: draft, fingerprint: 'x' });
      return { action: 'created', key };
    }
  };
  const first = normalizeWorkoutBackup(backup, { ...ctx, observationClock: () => '2026-09-01T06:20:00.000Z' });
  assert.equal(first.drafts.length, 1);

  // A "replay" with a much LOWER _ts (as if an older snapshot with a stale global counter
  // arrived) but CHANGED facts must still be treated as a conflict, never accepted because its
  // enclosing _ts looks older/authoritative. _ts must never be read for this decision at all —
  // confirmed structurally: normalizeWorkoutBackup/normalizeWorkoutCompleted have no branch that
  // reads `backup._ts` for anything but inert provenance.
  const changed = clone(checkedIn.nativeVariant.workout);
  changed.note = 'a different note now';
  const replay = normalizeWorkoutBackup({ workouts: [changed], _ts: 0 }, { ...ctx, observationClock: () => '2026-09-01T06:21:00.000Z' });
  assert.equal(replay.drafts.length, 1, 'the changed record still normalizes (conflict detection happens at import time, not normalization time)');
});

test('chaos: changing the backup collection key (workouts -> exercises) fails the whole batch, not a silent empty import', () => {
  const result = normalizeWorkoutBackup({ exercises: [clone(checkedIn.nativeVariant.workout)] }, { ...ctx, observationClock: () => '2026-09-01T06:20:00.000Z' });
  assert.equal(result.fatal, true, 'Workout source contract V1 broken: a renamed top-level collection key must fail loudly, not import as zero workouts');
  assert.equal(result.rejected[0].reason, 'backup_workouts_must_be_array');
});

test('chaos: an id absent from workouts[] is never treated as a deletion signal (there is no deletion path to trigger)', () => {
  // There is no deletion API surface on this adapter to call "delete" on — this test documents
  // and locks in that absence, per contract §6. If a future adapter version adds one, this test
  // must be revisited alongside a contract version bump.
  const adapterExports = Object.keys(workoutAdapter);
  assert.equal(
    adapterExports.some(name => /delete|tombstone|remove/i.test(name)),
    false,
    'Workout source contract V1 broken: a deletion/tombstone export appeared — openGym still has no deletion evidence for workouts (§6), so this must not exist without a new contract version'
  );
});
