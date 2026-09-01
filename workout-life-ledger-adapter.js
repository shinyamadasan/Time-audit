import {
  deriveLifeLedgerKey,
  fingerprintLifeLedgerEvent,
  serializeLifeLedgerFacts,
  upsertLifeLedgerEvent,
  validateLifeLedgerEventDraft
} from './life-ledger-core.js';

export const WORKOUT_LIFE_LEDGER_ADAPTER_VERSION = 'opengym-workout-v1';
export const WORKOUT_LIFE_LEDGER_RECORD_KIND = 'opengym.workout';
export const WORKOUT_LIFE_LEDGER_CAPABILITIES = Object.freeze({
  completion: 'validated-supplied-workouts-collection-record',
  correction: 'immutable-after-first-acceptance; changed-same-id-is-conflict',
  deletion: 'unsupported-without-explicit-source-evidence',
  restore: 'unsupported-without-explicit-source-evidence'
});

// openGym backup V1 has state-level `_ts` and `unit`, but neither belongs to an individual
// workout. `_ts` is retained only as non-causal snapshot metadata; `unit` is ignored unless the
// importer explicitly asserts a unit for every weight number in this backup.

const VALID_UNITS = new Set(['kg', 'lb']);
const VALID_MODES = new Set(['reps', 'time', 'cardio']);
const VALID_RATINGS = new Set(['easy', 'right', 'hard']);

// Structural bounds on free text and identifiers. These reject oversized strings and unsafe C0
// control characters without over-sanitizing legitimate Unicode/punctuation in user notes.
const MAX_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 200;
const MAX_NOTE_LENGTH = 300;
const MAX_PROGRESSION_TEXT_LENGTH = 200;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isUnsafeControlChar(code, allowWhitespace) {
  if (code === 0x7f) return true;
  if (code >= 0x20) return false;
  if (allowWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) return false;
  return true;
}

function hasUnsafeControlChars(value, allowWhitespace) {
  for (let i = 0; i < value.length; i++) {
    if (isUnsafeControlChar(value.charCodeAt(i), allowWhitespace)) return true;
  }
  return false;
}

function stableId(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.length > MAX_ID_LENGTH || hasUnsafeControlChars(value, false)) return null;
  return value;
}

// Returns null when `value` is acceptable bounded text, or a short reason string when not.
// `required` rejects null/empty; an absent optional value should be checked with hasOwn() by the
// caller before invoking this.
function textIssue(value, maxLength, allowWhitespace) {
  if (typeof value !== 'string') return 'must_be_string';
  if (!value.trim()) return 'required';
  if (value.length > maxLength) return 'too_long';
  if (hasUnsafeControlChars(value, allowWhitespace)) return 'unsafe_characters';
  return null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoInstant(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function validTimezone(value) {
  if (typeof value !== 'string' || !value.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function inactiveTombstone() {
  return { active: false, deletedAt: null, reason: null, provenance: null };
}

function rejection(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function normalizeEffort(set, out) {
  for (const key of ['rir', 'rpe']) {
    if (!hasOwn(set, key) || set[key] == null) continue;
    const value = finiteNumber(set[key]);
    if (value == null || value < 0 || value > 10) return `invalid_${key}`;
    out[key] = value;
  }
  return null;
}

function inferSetMode(set) {
  const cardio = hasOwn(set, 'min') || hasOwn(set, 'speed');
  const timed = hasOwn(set, 'sec');
  const reps = hasOwn(set, 'r');
  const count = Number(cardio) + Number(timed) + Number(reps);
  if (count !== 1) return null;
  return cardio ? 'cardio' : timed ? 'time' : 'reps';
}

function normalizeCompletedSet(set, expectedMode) {
  if (!isPlainObject(set) || set.done !== true) return rejection('invalid_completed_set');
  const mode = inferSetMode(set);
  if (!mode || (expectedMode && expectedMode !== mode)) return rejection('ambiguous_set_mode');

  if (mode === 'reps') {
    const load = finiteNumber(set.w);
    const repetitions = finiteNumber(set.r);
    if (load == null || load < 0 || !Number.isInteger(repetitions) || repetitions < 0) {
      return rejection('invalid_repetition_set');
    }
    const normalized = { load, repetitions };
    const effortError = normalizeEffort(set, normalized);
    return effortError ? rejection(effortError) : { ok: true, mode, set: normalized };
  }

  if (mode === 'time') {
    const seconds = finiteNumber(set.sec);
    if (seconds == null || seconds <= 0) return rejection('invalid_timed_set');
    const normalized = { seconds };
    if (hasOwn(set, 'w')) {
      const load = finiteNumber(set.w);
      if (load == null || load < 0) return rejection('invalid_timed_set_load');
      normalized.load = load;
    }
    return { ok: true, mode, set: normalized };
  }

  const minutes = finiteNumber(set.min);
  if (minutes == null || minutes <= 0) return rejection('invalid_cardio_set');
  const normalized = { minutes };
  if (hasOwn(set, 'speed')) {
    const speed = finiteNumber(set.speed);
    if (speed == null || speed < 0) return rejection('invalid_cardio_set_speed');
    normalized.speedKph = speed;
  }
  return { ok: true, mode, set: normalized };
}

function normalizePrescription(target, mode) {
  if (target == null) return { ok: true, prescription: null };
  if (!isPlainObject(target)) return rejection('invalid_prescription');

  const targetMode = target.mode == null ? null : String(target.mode);
  if (targetMode && (!VALID_MODES.has(targetMode) || targetMode !== mode)) {
    return rejection('prescription_mode_mismatch');
  }

  const prescription = { mode };
  const numberFields = [
    ['sets', 'plannedSets', true, false],
    ['reps', 'plannedRepetitions', true, true],
    ['weight', 'plannedLoad', false, true],
    ['sec', 'plannedSeconds', false, false],
    ['min', 'plannedMinutes', false, false],
    ['speed', 'plannedSpeedKph', false, true],
    ['inc', 'progressionIncrement', false, true],
    ['repsMin', 'progressionMinimumRepetitions', true, true]
  ];
  for (const [source, destination, integer, allowZero] of numberFields) {
    if (!hasOwn(target, source) || target[source] == null) continue;
    const value = finiteNumber(target[source]);
    if (value == null || value < 0 || (!allowZero && value === 0) || (integer && !Number.isInteger(value))) {
      return rejection('invalid_prescription_value', { field: source });
    }
    prescription[destination] = value;
  }
  if (target.prog != null) {
    if (textIssue(target.prog, MAX_PROGRESSION_TEXT_LENGTH, false)) return rejection('invalid_progression_rule');
    prescription.progressionRule = target.prog;
  }
  return { ok: true, prescription };
}

function normalizeExercise(entry, prIds) {
  if (!isPlainObject(entry)) return rejection('invalid_exercise');
  const exerciseId = stableId(entry.id);
  if (!exerciseId) return rejection('missing_exercise_id');
  if (!Array.isArray(entry.sets)) return rejection('exercise_sets_must_be_array');
  if (entry.sets.some(set => !isPlainObject(set) || typeof set.done !== 'boolean')) {
    return rejection('ambiguous_set_completion', { exerciseId });
  }

  const completed = entry.sets.filter(set => set.done === true);
  if (!completed.length) return rejection('exercise_has_no_completed_sets', { exerciseId });
  const targetMode = isPlainObject(entry.target) && VALID_MODES.has(entry.target.mode)
    ? entry.target.mode
    : null;
  const normalizedSets = [];
  let mode = targetMode;
  for (const set of completed) {
    const normalized = normalizeCompletedSet(set, mode);
    if (!normalized.ok) return { ...normalized, exerciseId };
    mode = normalized.mode;
    normalizedSets.push(normalized.set);
  }

  const prescribed = normalizePrescription(entry.target, mode);
  if (!prescribed.ok) return { ...prescribed, exerciseId };
  const exercise = {
    exerciseId,
    mode,
    sets: normalizedSets,
    personalRecord: prIds.has(exerciseId)
  };
  if (hasOwn(entry, 'n') && entry.n != null) {
    if (textIssue(entry.n, MAX_NAME_LENGTH, false)) return rejection('invalid_exercise_name', { exerciseId });
    exercise.exerciseName = entry.n.trim();
  }
  if (entry.topW != null) {
    const topWeight = finiteNumber(entry.topW);
    if (topWeight == null || topWeight < 0) return rejection('invalid_top_weight', { exerciseId });
    exercise.topWeight = topWeight;
  }
  if (prescribed.prescription) exercise.prescription = prescribed.prescription;
  return { ok: true, exercise };
}

function normalizePrIds(value) {
  if (value == null) return { ok: true, ids: [] };
  if (!Array.isArray(value)) return rejection('prs_must_be_array');
  const ids = [];
  for (const item of value) {
    const id = stableId(item);
    if (!id) return rejection('invalid_pr_id');
    ids.push(id);
  }
  return { ok: true, ids: [...new Set(ids)].sort() };
}

// The `iw` ID prefix only proves the record's shape/ID is compatible with openGym's CSV import
// path — arbitrary supplied JSON can imitate that prefix. This label MUST NOT claim it proves that
// origin; it only recognizes a compatible ID shape.
function sourceCategory(sourceEntityId) {
  return sourceEntityId.startsWith('iw') ? 'csv_import_path_compatible' : 'workouts_collection_record';
}

export function normalizeWorkoutCompleted(workout, context = {}) {
  if (!isPlainObject(workout)) return rejection('workout_must_be_object');
  const sourceEntityId = stableId(workout.id);
  if (!sourceEntityId) return rejection('missing_source_entity_id');
  const nameIssue = textIssue(workout.name, MAX_NAME_LENGTH, true);
  if (nameIssue) {
    return rejection(nameIssue === 'required' ? 'missing_workout_name' : 'invalid_workout_name', { sourceEntityId });
  }
  if (!validTimezone(context.assertedTimezone)) {
    return rejection('invalid_timezone_assertion', { sourceEntityId });
  }
  if (context.assertedWeightUnit != null && !VALID_UNITS.has(context.assertedWeightUnit)) {
    return rejection('invalid_weight_unit_assertion', { sourceEntityId });
  }

  const observedAt = isoInstant(context.observedAt);
  if (!observedAt) return rejection('invalid_observed_at', { sourceEntityId });
  const startedAtMs = finiteNumber(workout.start);
  const endedAtMs = finiteNumber(workout.end);
  if (startedAtMs == null || endedAtMs == null || startedAtMs < 0 || endedAtMs < startedAtMs) {
    return rejection('invalid_workout_interval', { sourceEntityId });
  }
  if (typeof workout.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(workout.d)) {
    return rejection('invalid_source_date', { sourceEntityId });
  }
  if (!Array.isArray(workout.entries)) return rejection('workout_entries_must_be_array', { sourceEntityId });

  const prResult = normalizePrIds(workout.prs);
  if (!prResult.ok) return { ...prResult, sourceEntityId };
  const prIds = new Set(prResult.ids);
  const exercises = [];
  for (const entry of workout.entries) {
    const result = normalizeExercise(entry, prIds);
    if (!result.ok) return { ...result, sourceEntityId };
    exercises.push(result.exercise);
  }
  const exerciseIds = new Set(exercises.map(exercise => exercise.exerciseId));
  if (prResult.ids.some(id => !exerciseIds.has(id))) {
    return rejection('pr_without_completed_exercise', { sourceEntityId });
  }

  const volume = workout.vol == null ? null : finiteNumber(workout.vol);
  if (workout.vol != null && (volume == null || volume < 0)) {
    return rejection('invalid_workout_volume', { sourceEntityId });
  }
  const bodyWeight = workout.bw == null ? null : finiteNumber(workout.bw);
  if (workout.bw != null && (bodyWeight == null || bodyWeight <= 0)) {
    return rejection('invalid_body_weight', { sourceEntityId });
  }
  if (workout.rating != null && !VALID_RATINGS.has(workout.rating)) {
    return rejection('invalid_workout_rating', { sourceEntityId });
  }
  if (workout.note != null && textIssue(workout.note, MAX_NOTE_LENGTH, true)) {
    return rejection('invalid_workout_note', { sourceEntityId });
  }

  const category = sourceCategory(sourceEntityId);
  const source = {
    workoutId: sourceEntityId,
    localDate: workout.d,
    recordCategory: category,
    recordOrigin: 'indeterminate_from_backup',
    completionBasis: category === 'csv_import_path_compatible'
      ? 'source-import-path-shape-compatible'
      : 'validated-workouts-collection-membership',
    durationStatus: endedAtMs === startedAtMs
      ? (category === 'csv_import_path_compatible' ? 'unknown' : 'zero-or-unknown')
      : 'recorded-interval',
    timezoneContext: { authority: 'import_assertion', timeZone: context.assertedTimezone },
    weightUnitContext: context.assertedWeightUnit
      ? { authority: 'import_assertion', unit: context.assertedWeightUnit }
      : { authority: 'unknown' }
  };
  if (workout.routineId != null) {
    const routineId = stableId(workout.routineId);
    if (!routineId) return rejection('invalid_routine_id', { sourceEntityId });
    source.routineId = routineId;
  }
  if (prResult.ids.length) source.personalRecordExerciseIds = prResult.ids;

  const startedAt = new Date(startedAtMs).toISOString();
  const endedAt = new Date(endedAtMs).toISOString();
  const payload = { workoutName: workout.name.trim(), startedAt, endedAt, exercises, source };
  if (endedAtMs > startedAtMs) {
    payload.durationMinutes = Math.round(((endedAtMs - startedAtMs) / 60000) * 1e6) / 1e6;
  }
  if (volume != null) payload.volume = volume;
  if (bodyWeight != null) payload.bodyWeight = { value: bodyWeight };
  if (workout.rating != null) payload.rating = workout.rating;
  if (workout.note != null) payload.note = workout.note.trim();

  const provenance = {
    source: 'workout',
    sourceRecordKind: WORKOUT_LIFE_LEDGER_RECORD_KIND,
    adapterVersion: WORKOUT_LIFE_LEDGER_ADAPTER_VERSION,
    observedAt,
    captureMethod: 'opengym_backup',
    evidence: [`opengym.backup:workouts/${sourceEntityId}`]
  };
  const sourceStateTimestamp = context.sourceStateTimestamp == null
    ? null
    : isoInstant(context.sourceStateTimestamp);
  if (sourceStateTimestamp) provenance.sourceStateTimestamp = sourceStateTimestamp;

  const draft = {
    schemaVersion: 1,
    sourceApp: 'workout',
    sourceEntityId,
    type: 'workout_completed',
    occurredAt: endedAt,
    sourceTimezone: context.assertedTimezone,
    payload,
    provenance,
    confidence: {
      score: category === 'csv_import_path_compatible' ? 0.85 : 0.9,
      // Same actual basis regardless of category: neither an `iw`-prefixed ID nor a plain ID
      // proves origin beyond the supplied backup itself. The score reflects the weaker structural
      // certainty of an ID-pattern match; the basis text does not overclaim provenance.
      basis: 'validated-supplied-backup-record'
    },
    tombstone: inactiveTombstone()
  };
  const validation = validateLifeLedgerEventDraft(draft);
  return validation.ok
    ? { ok: true, draft }
    : rejection('invalid_life_ledger_draft', { sourceEntityId, errors: validation.errors });
}

// `recordCount` is only known once `backup.workouts` is confirmed to be an array. Before that
// (backup isn't an object, or `.workouts` isn't an array), there is no coherent physical-record set
// to enumerate, so outcomes stays []. Once the physical record count IS known, a fatal batch/context
// error (missing clock, invalid timezone/unit assertion) still owes every physical record an
// explicit outcome per the contract — it must not silently imply per-payload validation occurred
// when the batch context itself blocked normalization from ever running.
function batchRejection(reason, recordCount = 0, details = {}) {
  return {
    drafts: [],
    rejected: [{ reason, ...details }],
    outcomes: Array.from({ length: recordCount }, (_, index) => ({ index, status: 'invalid', reason })),
    fatal: true
  };
}

export function normalizeWorkoutBackup(backup, context = {}) {
  if (!isPlainObject(backup)) return batchRejection('backup_must_be_object');
  if (!Array.isArray(backup.workouts)) return batchRejection('backup_workouts_must_be_array');
  const recordCount = backup.workouts.length;
  if (typeof context.observationClock !== 'function') return batchRejection('missing_observation_clock', recordCount);
  if (!validTimezone(context.assertedTimezone)) return batchRejection('invalid_timezone_assertion', recordCount);
  if (context.assertedWeightUnit != null && !VALID_UNITS.has(context.assertedWeightUnit)) {
    return batchRejection('invalid_weight_unit_assertion', recordCount);
  }

  let observedAt;
  try {
    observedAt = isoInstant(context.observationClock());
  } catch {
    observedAt = null;
  }
  if (!observedAt) return batchRejection('invalid_observation_clock', recordCount);
  const sourceStateTimestamp = finiteNumber(backup._ts);

  const groups = new Map();
  const rejected = [];
  // One classification per physical input record (index), so no duplicate/conflicting row is ever
  // silently dropped: 'invalid' (failed normalization), 'conflict' (same ID, differing facts,
  // within this batch), 'duplicate' (exact repeat of an already-accepted row), or 'accepted'
  // (the batch's canonical draft for its key). Store-level outcomes are layered on in
  // importWorkoutBackup().
  const outcomeByIndex = new Map();
  backup.workouts.forEach((workout, index) => {
    const result = normalizeWorkoutCompleted(workout, {
      assertedTimezone: context.assertedTimezone,
      assertedWeightUnit: context.assertedWeightUnit,
      observedAt,
      sourceStateTimestamp
    });
    if (!result.ok) {
      rejected.push({ index, ...result });
      outcomeByIndex.set(index, { index, status: 'invalid', reason: result.reason });
      return;
    }
    const key = deriveLifeLedgerKey(result.draft);
    // A 32-bit FNV-1a fingerprint can collide for genuinely different canonical facts (confirmed
    // reproducible through this adapter's own pipeline). Grouping on the canonical factual
    // serialization itself, not the fingerprint, means a collision can never cause two physically
    // different same-ID records in one batch to be mistaken for exact duplicates.
    const canonicalFacts = serializeLifeLedgerFacts(result.draft);
    const group = groups.get(key) || { key, canonicalFactsSeen: new Set(), drafts: [], indexes: [] };
    group.canonicalFactsSeen.add(canonicalFacts);
    group.drafts.push(result.draft);
    group.indexes.push(index);
    groups.set(key, group);
  });

  const drafts = [];
  [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).forEach(group => {
    if (group.canonicalFactsSeen.size > 1) {
      rejected.push({
        reason: 'conflicting_duplicate_workout_id',
        sourceEntityId: group.drafts[0].sourceEntityId,
        indexes: group.indexes
      });
      group.indexes.forEach(index => {
        outcomeByIndex.set(index, { index, status: 'conflict', reason: 'conflicting_duplicate_workout_id', key: group.key });
      });
      return;
    }
    drafts.push(group.drafts[0]);
    group.indexes.forEach((index, position) => {
      outcomeByIndex.set(index, position === 0
        ? { index, status: 'accepted', key: group.key }
        : { index, status: 'duplicate', key: group.key, duplicateOfIndex: group.indexes[0] });
    });
  });
  rejected.sort((a, b) => (a.index ?? a.indexes?.[0] ?? 0) - (b.index ?? b.indexes?.[0] ?? 0));
  const outcomes = backup.workouts.map((_, index) => outcomeByIndex.get(index));
  return { drafts, rejected, outcomes, fatal: false };
}

export function importWorkoutBackup(backup, options = {}) {
  const store = options.store;
  if (!store || typeof store.getByKey !== 'function') {
    throw new Error('A Life Ledger store with getByKey() is required');
  }
  const upsert = typeof store.upsertEvent === 'function'
    ? (draft => store.upsertEvent(draft, options.ledgerOptions || {}))
    : (typeof store.put === 'function'
      ? (draft => upsertLifeLedgerEvent(store, draft, options.ledgerOptions || {}))
      : null);
  if (!upsert) throw new Error('A Life Ledger store with upsertEvent() or put() is required');

  const normalized = normalizeWorkoutBackup(backup, options);
  if (normalized.fatal) {
    return { status: 'rejected', actions: [], rejected: normalized.rejected, conflicts: [], outcomes: normalized.outcomes };
  }

  // outcomes[] carries one entry per physical input record (see normalizeWorkoutBackup). Only the
  // 'accepted' entries are still pending a store-level resolution below; every other status is
  // already final.
  const outcomes = normalized.outcomes.map(outcome => ({ ...outcome }));
  const acceptedOutcomeByKey = new Map(
    outcomes.filter(outcome => outcome.status === 'accepted').map(outcome => [outcome.key, outcome])
  );

  const conflicts = [];
  const accepted = [];
  for (const draft of normalized.drafts) {
    const key = deriveLifeLedgerKey(draft);
    const existing = store.getByKey(key);
    if (existing) {
      // A 32-bit FNV-1a fingerprint can collide for genuinely different canonical facts (confirmed
      // reproducible through this adapter's own pipeline). Fingerprint equality is therefore only
      // ever a hint, never sufficient proof of factual sameness — the accepted record's actual
      // canonical factual serialization is always compared directly before an incoming draft is
      // ever treated as an unchanged retry rather than a changed-facts conflict.
      const sameFacts = serializeLifeLedgerFacts(existing.event) === serializeLifeLedgerFacts(draft);
      if (!sameFacts) {
        conflicts.push({
          reason: 'immutable_workout_conflict',
          key,
          sourceEntityId: draft.sourceEntityId,
          acceptedFingerprint: existing.fingerprint,
          incomingFingerprint: fingerprintLifeLedgerEvent(draft)
        });
        const outcome = acceptedOutcomeByKey.get(key);
        if (outcome) { outcome.status = 'conflict'; outcome.reason = 'immutable_workout_conflict'; }
        continue;
      }
    }
    accepted.push({ draft, key });
  }

  const actions = accepted.map(({ draft, key }) => {
    const action = upsert(draft);
    if (action.action === 'rejected') {
      const outcome = acceptedOutcomeByKey.get(key);
      if (outcome) { outcome.status = 'failed'; outcome.reason = action.reason; }
    }
    return action;
  });
  const upsertFailures = actions.filter(action => action.action === 'rejected');
  const hasIssues = normalized.rejected.length > 0 || conflicts.length > 0 || upsertFailures.length > 0;
  return {
    status: hasIssues ? 'partial' : 'ok',
    actions,
    rejected: normalized.rejected,
    conflicts,
    outcomes
  };
}
