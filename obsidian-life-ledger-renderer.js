export const OBSIDIAN_LIFE_LEDGER_SENTINEL = '<!-- life-ledger:generated:v1 -->';
export const OBSIDIAN_LIFE_LEDGER_DAILY_DIR = 'Life Ledger/Daily';
export const OBSIDIAN_LIFE_LEDGER_SYSTEM_README = 'Life Ledger/System/README.md';

const SUPPORTED_EVENT_TYPES = new Set([
  'activity_logged', 'focus_session_completed', 'plan_step_completed', 'workout_completed',
  'meal_prepared', 'meal_consumed'
]);
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidTimezone(value) {
  if (typeof value !== 'string' || !value.trim() || !value.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function timezoneFor(event) {
  const timezone = String(event?.sourceTimezone || '').trim();
  if (!isValidTimezone(timezone)) throw new Error('Life Ledger export event has an invalid sourceTimezone');
  return timezone;
}

function dateKeyFor(isoInstant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(isoInstant));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function timeFor(isoInstant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(isoInstant));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.hour === '24' ? '00' : byType.hour}:${byType.minute}`;
}

function text(value, fallback = '') {
  const normalized = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n+/g, ' / ')
    .trim();
  const escaped = normalized
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/#/g, '\\#')
    .replace(/\|/g, '\\|');
  return escaped || fallback;
}

function minutes(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function isTombstoned(event) {
  return event?.tombstone?.active === true;
}

function eventMarker(event) {
  return `<!-- life-ledger:event:${text(event.eventId, 'missing-event-id')} -->`;
}

// Mirrors the type-scoped `workout_completed` payload shape checks in life-ledger-core.js field for
// field, allowlist for allowlist, so the renderer never accepts a payload the shared core rejects.
// Kept as an independent, self-contained copy (rather than an import) so this renderer stays
// dependency-free and still fails closed on a malformed workout_completed event handed to it
// directly, without relying on the caller having already run it through life-ledger-core.js
// validation. See test.js's `WORKOUT_PARITY_FIXTURES` for the shared accept/reject matrix that
// keeps this copy and life-ledger-core.js's validator from drifting apart.
const WORKOUT_TEXT_MAX_LENGTH = 200;
const WORKOUT_NOTE_MAX_LENGTH = 300;
const WORKOUT_ID_MAX_LENGTH = 200;
const WORKOUT_SET_MODES = new Set(['reps', 'time', 'cardio']);
const WORKOUT_RATINGS = new Set(['easy', 'right', 'hard']);
const WORKOUT_RECORD_CATEGORIES = new Set(['workouts_collection_record', 'csv_import_path_compatible']);
const WORKOUT_DURATION_STATUSES = new Set(['unknown', 'zero-or-unknown', 'recorded-interval']);
const WORKOUT_WEIGHT_UNITS = new Set(['kg', 'lb']);
const WORKOUT_RECORD_ORIGINS = new Set(['indeterminate_from_backup']);
const WORKOUT_COMPLETION_BASES = new Set(['validated-workouts-collection-membership', 'source-import-path-shape-compatible']);
const WORKOUT_PAYLOAD_ALLOWED_KEYS = new Set([
  'workoutName', 'startedAt', 'endedAt', 'durationMinutes', 'exercises', 'volume', 'bodyWeight', 'rating', 'note', 'source'
]);
const WORKOUT_SET_ALLOWED_KEYS = Object.freeze({
  reps: new Set(['load', 'repetitions', 'rir', 'rpe']),
  time: new Set(['seconds', 'load', 'rir', 'rpe']),
  cardio: new Set(['minutes', 'speedKph', 'rir', 'rpe'])
});
const WORKOUT_PRESCRIPTION_NUMBER_KEYS = [
  'plannedSets', 'plannedRepetitions', 'plannedLoad', 'plannedSeconds', 'plannedMinutes',
  'plannedSpeedKph', 'progressionIncrement', 'progressionMinimumRepetitions'
];
const WORKOUT_PRESCRIPTION_ALLOWED_KEYS = new Set(['mode', ...WORKOUT_PRESCRIPTION_NUMBER_KEYS, 'progressionRule']);
const WORKOUT_EXERCISE_ALLOWED_KEYS = new Set([
  'exerciseId', 'mode', 'sets', 'exerciseName', 'topWeight', 'personalRecord', 'prescription'
]);
const WORKOUT_SOURCE_ALLOWED_KEYS = new Set([
  'workoutId', 'localDate', 'recordCategory', 'recordOrigin', 'completionBasis', 'durationStatus',
  'timezoneContext', 'weightUnitContext', 'routineId', 'personalRecordExerciseIds'
]);
const WORKOUT_TIMEZONE_CONTEXT_ALLOWED_KEYS = new Set(['authority', 'timeZone']);
const WORKOUT_UNKNOWN_UNIT_CONTEXT_ALLOWED_KEYS = new Set(['authority']);
const WORKOUT_ASSERTED_UNIT_CONTEXT_ALLOWED_KEYS = new Set(['authority', 'unit']);

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isIsoInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalizeIsoInstant(value);
}

function normalizeIsoInstant(value) {
  return new Date(Date.parse(value)).toISOString();
}

// Mirrors life-ledger-core.js's isValidCalendarDate() exactly: rejects an impossible date
// (2026-02-30) via a Date.UTC() round-trip, not just YYYY-MM-DD shape.
function isValidCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_KEY_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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

function isBoundedWorkoutId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= WORKOUT_ID_MAX_LENGTH
    && !hasUnsafeControlChars(value, false);
}

function isBoundedWorkoutText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    && !hasUnsafeControlChars(value, true);
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function assertNoUnknownKeys(obj, allowedKeys, label, path) {
  Object.keys(obj).forEach(key => {
    if (!allowedKeys.has(key)) throw new Error(`${label}: ${path}.${key} is not allowed`);
  });
}

function assertValidWorkoutSet(set, mode, label, path) {
  if (!isPlainObject(set)) throw new Error(`${label}: ${path} must be an object`);
  if (mode === 'reps') {
    if (!isFiniteNonNegative(set.load)) throw new Error(`${label}: ${path}.load must be a non-negative number`);
    if (!Number.isInteger(set.repetitions) || set.repetitions < 0) throw new Error(`${label}: ${path}.repetitions must be a non-negative integer`);
  } else if (mode === 'time') {
    if (typeof set.seconds !== 'number' || !Number.isFinite(set.seconds) || set.seconds <= 0) throw new Error(`${label}: ${path}.seconds must be a positive number`);
    if (hasOwn(set, 'load') && set.load != null && !isFiniteNonNegative(set.load)) throw new Error(`${label}: ${path}.load must be a non-negative number`);
  } else if (mode === 'cardio') {
    if (typeof set.minutes !== 'number' || !Number.isFinite(set.minutes) || set.minutes <= 0) throw new Error(`${label}: ${path}.minutes must be a positive number`);
    if (hasOwn(set, 'speedKph') && set.speedKph != null && !isFiniteNonNegative(set.speedKph)) throw new Error(`${label}: ${path}.speedKph must be a non-negative number`);
  }
  ['rir', 'rpe'].forEach(key => {
    if (hasOwn(set, key) && set[key] != null) {
      if (typeof set[key] !== 'number' || !Number.isFinite(set[key]) || set[key] < 0 || set[key] > 10) {
        throw new Error(`${label}: ${path}.${key} must be between 0 and 10`);
      }
    }
  });
  assertNoUnknownKeys(set, WORKOUT_SET_ALLOWED_KEYS[mode], label, path);
}

function assertValidWorkoutPrescription(prescription, mode, label, path) {
  if (!isPlainObject(prescription)) throw new Error(`${label}: ${path} must be an object`);
  if (hasOwn(prescription, 'mode') && prescription.mode != null && prescription.mode !== mode) {
    throw new Error(`${label}: ${path}.mode must match the exercise mode`);
  }
  WORKOUT_PRESCRIPTION_NUMBER_KEYS.forEach(key => {
    if (hasOwn(prescription, key) && prescription[key] != null && !isFiniteNonNegative(prescription[key])) {
      throw new Error(`${label}: ${path}.${key} must be a non-negative number`);
    }
  });
  if (hasOwn(prescription, 'progressionRule') && prescription.progressionRule != null
    && !isBoundedWorkoutText(prescription.progressionRule, WORKOUT_TEXT_MAX_LENGTH)) {
    throw new Error(`${label}: ${path}.progressionRule must be bounded text`);
  }
  assertNoUnknownKeys(prescription, WORKOUT_PRESCRIPTION_ALLOWED_KEYS, label, path);
}

function assertValidWorkoutExercise(exercise, label, path) {
  if (!isPlainObject(exercise)) throw new Error(`${label}: ${path} must be an object`);
  if (!isBoundedWorkoutId(exercise.exerciseId)) throw new Error(`${label}: ${path}.exerciseId must be a bounded identifier`);
  const mode = WORKOUT_SET_MODES.has(exercise.mode) ? exercise.mode : null;
  if (!mode) throw new Error(`${label}: ${path}.mode must be reps, time, or cardio`);
  if (!Array.isArray(exercise.sets) || exercise.sets.length === 0) throw new Error(`${label}: ${path}.sets must be a non-empty array`);
  exercise.sets.forEach((set, setIndex) => assertValidWorkoutSet(set, mode, label, `${path}.sets[${setIndex}]`));
  if (hasOwn(exercise, 'exerciseName') && exercise.exerciseName != null
    && !isBoundedWorkoutText(exercise.exerciseName, WORKOUT_TEXT_MAX_LENGTH)) {
    throw new Error(`${label}: ${path}.exerciseName must be bounded text`);
  }
  if (hasOwn(exercise, 'topWeight') && exercise.topWeight != null && !isFiniteNonNegative(exercise.topWeight)) {
    throw new Error(`${label}: ${path}.topWeight must be a non-negative number`);
  }
  if (hasOwn(exercise, 'personalRecord') && exercise.personalRecord != null && typeof exercise.personalRecord !== 'boolean') {
    throw new Error(`${label}: ${path}.personalRecord must be boolean`);
  }
  if (hasOwn(exercise, 'prescription') && exercise.prescription != null) {
    assertValidWorkoutPrescription(exercise.prescription, mode, label, `${path}.prescription`);
  }
  assertNoUnknownKeys(exercise, WORKOUT_EXERCISE_ALLOWED_KEYS, label, path);
}

function assertValidWorkoutTimezoneContext(timezoneContext, label, path) {
  if (!isPlainObject(timezoneContext)) throw new Error(`${label}: ${path} must be an object`);
  if (timezoneContext.authority !== 'import_assertion' || !isValidTimezone(timezoneContext.timeZone)) {
    throw new Error(`${label}: ${path} must assert a valid IANA timezone`);
  }
  assertNoUnknownKeys(timezoneContext, WORKOUT_TIMEZONE_CONTEXT_ALLOWED_KEYS, label, path);
}

function assertValidWorkoutWeightUnitContext(weightUnitContext, label, path) {
  if (!isPlainObject(weightUnitContext)) throw new Error(`${label}: ${path} must be an object`);
  if (weightUnitContext.authority === 'unknown') {
    assertNoUnknownKeys(weightUnitContext, WORKOUT_UNKNOWN_UNIT_CONTEXT_ALLOWED_KEYS, label, path);
  } else if (weightUnitContext.authority === 'import_assertion') {
    if (!WORKOUT_WEIGHT_UNITS.has(weightUnitContext.unit)) throw new Error(`${label}: ${path}.unit must be kg or lb`);
    assertNoUnknownKeys(weightUnitContext, WORKOUT_ASSERTED_UNIT_CONTEXT_ALLOWED_KEYS, label, path);
  } else {
    throw new Error(`${label}: ${path}.authority must be 'unknown' or 'import_assertion'`);
  }
}

function assertValidWorkoutSource(source, event, label, path) {
  if (!isPlainObject(source)) throw new Error(`${label}: ${path} must be an object`);
  if (hasOwn(source, 'workoutId') && source.workoutId != null
    && (!isBoundedWorkoutId(source.workoutId) || source.workoutId !== event.sourceEntityId)) {
    throw new Error(`${label}: ${path}.workoutId must match sourceEntityId`);
  }
  if (hasOwn(source, 'localDate') && source.localDate != null
    && (typeof source.localDate !== 'string' || !DATE_KEY_RE.test(source.localDate))) {
    throw new Error(`${label}: ${path}.localDate must be YYYY-MM-DD`);
  }
  if (hasOwn(source, 'recordCategory') && source.recordCategory != null && !WORKOUT_RECORD_CATEGORIES.has(source.recordCategory)) {
    throw new Error(`${label}: ${path}.recordCategory is not recognized`);
  }
  if (hasOwn(source, 'recordOrigin') && source.recordOrigin != null && !WORKOUT_RECORD_ORIGINS.has(source.recordOrigin)) {
    throw new Error(`${label}: ${path}.recordOrigin is not recognized`);
  }
  if (hasOwn(source, 'completionBasis') && source.completionBasis != null && !WORKOUT_COMPLETION_BASES.has(source.completionBasis)) {
    throw new Error(`${label}: ${path}.completionBasis is not recognized`);
  }
  if (hasOwn(source, 'durationStatus') && source.durationStatus != null && !WORKOUT_DURATION_STATUSES.has(source.durationStatus)) {
    throw new Error(`${label}: ${path}.durationStatus is not recognized`);
  }
  if (hasOwn(source, 'timezoneContext') && source.timezoneContext != null) {
    assertValidWorkoutTimezoneContext(source.timezoneContext, label, `${path}.timezoneContext`);
  }
  if (hasOwn(source, 'weightUnitContext') && source.weightUnitContext != null) {
    assertValidWorkoutWeightUnitContext(source.weightUnitContext, label, `${path}.weightUnitContext`);
  }
  if (hasOwn(source, 'routineId') && source.routineId != null && !isBoundedWorkoutId(source.routineId)) {
    throw new Error(`${label}: ${path}.routineId must be a bounded identifier`);
  }
  if (hasOwn(source, 'personalRecordExerciseIds') && source.personalRecordExerciseIds != null) {
    const idsOk = Array.isArray(source.personalRecordExerciseIds) && source.personalRecordExerciseIds.every(isBoundedWorkoutId);
    if (!idsOk) throw new Error(`${label}: ${path}.personalRecordExerciseIds must be an array of bounded identifiers`);
  }
  assertNoUnknownKeys(source, WORKOUT_SOURCE_ALLOWED_KEYS, label, path);
}

// Mirrors life-ledger-core.js's PAYLOAD_RULES.workout_completed time/duration contract
// (`duration: 'optional'`) exactly: startedAt/endedAt are required valid ISO instants;
// durationMinutes, when present, must be a positive number (zero is rejected); the start/end
// interval must never be negative; when durationMinutes is present the interval must be strictly
// positive, and when it is omitted the interval must be exactly zero (the approved unknown-duration
// case); and top-level occurredAt must equal payload.endedAt.
function assertValidWorkoutCompletedTimeFacts(event, label) {
  const payload = event.payload;
  if (!hasOwn(payload, 'startedAt') || payload.startedAt == null || payload.startedAt === '') {
    throw new Error(`${label}: startedAt is required`);
  }
  if (!hasOwn(payload, 'endedAt') || payload.endedAt == null || payload.endedAt === '') {
    throw new Error(`${label}: endedAt is required`);
  }
  if (!isIsoInstant(payload.startedAt)) throw new Error(`${label}: startedAt must be a UTC ISO instant`);
  if (!isIsoInstant(payload.endedAt)) throw new Error(`${label}: endedAt must be a UTC ISO instant`);

  const hasDuration = hasOwn(payload, 'durationMinutes') && payload.durationMinutes != null;
  if (hasDuration && (typeof payload.durationMinutes !== 'number' || !Number.isFinite(payload.durationMinutes) || payload.durationMinutes <= 0)) {
    throw new Error(`${label}: durationMinutes must be a positive number`);
  }

  const interval = Date.parse(payload.endedAt) - Date.parse(payload.startedAt);
  if (interval < 0) throw new Error(`${label}: endedAt must not be before startedAt`);
  if (hasDuration) {
    if (interval <= 0) throw new Error(`${label}: endedAt must be after startedAt when durationMinutes is present`);
  } else if (interval !== 0) {
    throw new Error(`${label}: durationMinutes is required when endedAt is after startedAt`);
  }

  if (isIsoInstant(event.occurredAt) && normalizeIsoInstant(event.occurredAt) !== normalizeIsoInstant(payload.endedAt)) {
    throw new Error(`${label}: occurredAt must match payload.endedAt`);
  }
}

function assertValidWorkoutCompletedPayload(event, index) {
  const payload = event?.payload;
  const label = `Malformed workout_completed payload for Obsidian export at index ${index}`;
  if (!isPlainObject(payload)) throw new Error(`${label}: payload must be an object`);
  assertNoUnknownKeys(payload, WORKOUT_PAYLOAD_ALLOWED_KEYS, label, 'payload');
  assertValidWorkoutCompletedTimeFacts(event, label);
  if (!isBoundedWorkoutText(payload.workoutName, WORKOUT_TEXT_MAX_LENGTH)) {
    throw new Error(`${label}: workoutName must be bounded text`);
  }
  if (hasOwn(payload, 'exercises') && payload.exercises != null) {
    if (!Array.isArray(payload.exercises)) throw new Error(`${label}: exercises must be an array`);
    payload.exercises.forEach((exercise, exerciseIndex) => (
      assertValidWorkoutExercise(exercise, label, `payload.exercises[${exerciseIndex}]`)
    ));
  }
  if (hasOwn(payload, 'volume') && payload.volume != null && !isFiniteNonNegative(payload.volume)) {
    throw new Error(`${label}: volume must be a non-negative number`);
  }
  if (hasOwn(payload, 'bodyWeight') && payload.bodyWeight != null) {
    const bodyWeight = payload.bodyWeight;
    const bodyWeightOk = isPlainObject(bodyWeight)
      && Object.keys(bodyWeight).every(key => key === 'value')
      && typeof bodyWeight.value === 'number' && Number.isFinite(bodyWeight.value) && bodyWeight.value > 0;
    if (!bodyWeightOk) throw new Error(`${label}: bodyWeight must be { value: positive number }`);
  }
  if (hasOwn(payload, 'rating') && payload.rating != null && !WORKOUT_RATINGS.has(payload.rating)) {
    throw new Error(`${label}: rating is not recognized`);
  }
  if (hasOwn(payload, 'note') && payload.note != null && !isBoundedWorkoutText(payload.note, WORKOUT_NOTE_MAX_LENGTH)) {
    throw new Error(`${label}: note must be bounded text`);
  }
  if (hasOwn(payload, 'source') && payload.source != null) {
    assertValidWorkoutSource(payload.source, event, label, 'payload.source');
  }
}

// Mirrors life-ledger-core.js's meal_prepared/meal_consumed deep payload shape checks
// field for field, allowlist for allowlist — an independent, self-contained copy (not
// an import) so this renderer stays dependency-free and still fails closed on a
// malformed meal event handed to it directly, without relying on the caller having
// already run it through life-ledger-core.js validation.
const MEAL_TEXT_MAX_LENGTH = 200;
const MEAL_ID_MAX_LENGTH = 200;
const MEAL_PORTION_MAX = 99;
const MEAL_PREPARATION_KINDS = new Set(['recipe', 'leftovers', 'takeout']);
const MEAL_PREPARED_DATE_BASES = new Set(['source-local-date']);
const MEAL_PREPARED_PAYLOAD_ALLOWED_KEYS = new Set([
  'mealName', 'preparedDate', 'portionsPrepared', 'source'
]);
const MEAL_CONSUMED_PAYLOAD_ALLOWED_KEYS = new Set([
  'mealName', 'consumedAt', 'portionCount', 'cookedMealId', 'source'
]);
// `storage` is deliberately NOT allowlisted: it is Meal's current, mutable location for the
// batch, not a preparation-time fact (see life-ledger-core.js).
const MEAL_PREPARED_SOURCE_ALLOWED_KEYS = new Set([
  'cookedMealId', 'localDate', 'preparedDateBasis', 'recipeId', 'preparationKind'
]);
const MEAL_CONSUMED_SOURCE_ALLOWED_KEYS = new Set(['consumptionId', 'recipeId']);

function isBoundedMealId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MEAL_ID_MAX_LENGTH
    && !hasUnsafeControlChars(value, false);
}

function isBoundedMealText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    && !hasUnsafeControlChars(value, true);
}

function isBoundedPortionCount(value, min) {
  return Number.isInteger(value) && value >= min && value <= MEAL_PORTION_MAX;
}

function assertValidMealPreparedSource(source, event, label, path) {
  if (!isPlainObject(source)) throw new Error(`${label}: ${path} must be an object`);
  if (!isBoundedMealId(source.cookedMealId) || source.cookedMealId !== event.sourceEntityId) {
    throw new Error(`${label}: ${path}.cookedMealId must match sourceEntityId`);
  }
  if (!isValidCalendarDate(source.localDate)) {
    throw new Error(`${label}: ${path}.localDate must be a valid calendar date (YYYY-MM-DD)`);
  }
  if (!MEAL_PREPARED_DATE_BASES.has(source.preparedDateBasis)) {
    throw new Error(`${label}: ${path}.preparedDateBasis is not recognized`);
  }
  if (hasOwn(source, 'recipeId') && source.recipeId != null && !isBoundedMealId(source.recipeId)) {
    throw new Error(`${label}: ${path}.recipeId must be a bounded identifier`);
  }
  if (hasOwn(source, 'preparationKind') && source.preparationKind != null && !MEAL_PREPARATION_KINDS.has(source.preparationKind)) {
    throw new Error(`${label}: ${path}.preparationKind is not recognized`);
  }
  assertNoUnknownKeys(source, MEAL_PREPARED_SOURCE_ALLOWED_KEYS, label, path);
}

function assertValidMealConsumedSource(source, event, label, path) {
  if (!isPlainObject(source)) throw new Error(`${label}: ${path} must be an object`);
  if (!isBoundedMealId(source.consumptionId) || source.consumptionId !== event.sourceEntityId) {
    throw new Error(`${label}: ${path}.consumptionId must match sourceEntityId`);
  }
  if (hasOwn(source, 'recipeId') && source.recipeId != null && !isBoundedMealId(source.recipeId)) {
    throw new Error(`${label}: ${path}.recipeId must be a bounded identifier`);
  }
  assertNoUnknownKeys(source, MEAL_CONSUMED_SOURCE_ALLOWED_KEYS, label, path);
}

// meal_prepared is date-precision (see life-ledger-core.js's temporal-precision invariant):
// occurredAt must be ABSENT and occurredDate must equal payload.preparedDate exactly — the
// renderer never falls back to a substitute time, and never fabricates a time-of-day for a
// date-only fact.
function assertValidMealPreparedPayload(event, index) {
  const payload = event?.payload;
  const label = `Malformed meal_prepared payload for Obsidian export at index ${index}`;
  if (!isPlainObject(payload)) throw new Error(`${label}: payload must be an object`);
  if (!isValidCalendarDate(event.occurredDate)) throw new Error(`${label}: occurredDate must be a valid calendar date`);
  assertNoUnknownKeys(payload, MEAL_PREPARED_PAYLOAD_ALLOWED_KEYS, label, 'payload');
  if (!isBoundedMealText(payload.mealName, MEAL_TEXT_MAX_LENGTH)) throw new Error(`${label}: mealName must be bounded text`);
  if (!isValidCalendarDate(payload.preparedDate)) throw new Error(`${label}: preparedDate must be a valid calendar date`);
  if (event.occurredDate !== payload.preparedDate) throw new Error(`${label}: occurredDate must match payload.preparedDate`);
  if (hasOwn(payload, 'portionsPrepared') && payload.portionsPrepared != null && !isBoundedPortionCount(payload.portionsPrepared, 1)) {
    throw new Error(`${label}: portionsPrepared must be an integer between 1 and 99`);
  }
  if (hasOwn(payload, 'source') && payload.source != null) {
    assertValidMealPreparedSource(payload.source, event, label, 'payload.source');
  }
}

function assertValidMealConsumedPayload(event, index) {
  const payload = event?.payload;
  const label = `Malformed meal_consumed payload for Obsidian export at index ${index}`;
  if (!isPlainObject(payload)) throw new Error(`${label}: payload must be an object`);
  assertNoUnknownKeys(payload, MEAL_CONSUMED_PAYLOAD_ALLOWED_KEYS, label, 'payload');
  if (!isBoundedMealText(payload.mealName, MEAL_TEXT_MAX_LENGTH)) throw new Error(`${label}: mealName must be bounded text`);
  if (!isIsoInstant(payload.consumedAt)) throw new Error(`${label}: consumedAt must be a UTC ISO instant`);
  if (isIsoInstant(event.occurredAt) && normalizeIsoInstant(event.occurredAt) !== normalizeIsoInstant(payload.consumedAt)) {
    throw new Error(`${label}: occurredAt must match payload.consumedAt`);
  }
  if (!Number.isInteger(payload.portionCount) || payload.portionCount < 1 || payload.portionCount > MEAL_PORTION_MAX) {
    throw new Error(`${label}: portionCount must be an integer between 1 and 99`);
  }
  // Required: every real mealConsumption record durably captures cookedMealId (see
  // meal-life-ledger-adapter.js) — there is no trustworthy legacy exception.
  if (!isBoundedMealId(payload.cookedMealId)) {
    throw new Error(`${label}: cookedMealId must be a bounded identifier`);
  }
  if (hasOwn(payload, 'source') && payload.source != null) {
    assertValidMealConsumedSource(payload.source, event, label, 'payload.source');
  }
}

function supportedEventOrThrow(event, index, policy, skipped) {
  if (SUPPORTED_EVENT_TYPES.has(event?.type)) return true;
  const type = String(event?.type || 'missing');
  const message = `Unsupported Life Ledger event type for Obsidian export at index ${index}: ${type}`;
  if (policy === 'skip') {
    skipped.push({ index, type, reason: message });
    return false;
  }
  throw new Error(message);
}

function isDatePrecisionEvent(event) {
  return event?.type === 'meal_prepared';
}

// Mirrors life-ledger-core.js's temporal envelope rule independently, without importing the
// shared validator: supported event types have a fixed precision, valid IANA timezone, and
// exactly one factual occurrence field. Keep this deliberately narrow; payload validation stays
// in the type-specific guards below and the renderer does not become a second global envelope
// validator.
function assertValidTemporalEnvelope(event, index) {
  const label = `Malformed Life Ledger temporal envelope for Obsidian export at index ${index}`;
  if (!isValidTimezone(event.sourceTimezone)) throw new Error(`${label}: sourceTimezone must be a valid IANA timezone`);

  const requiredPrecision = isDatePrecisionEvent(event) ? 'date' : 'instant';
  if (hasOwn(event, 'temporalPrecision') && event.temporalPrecision != null) {
    if (!['instant', 'date'].includes(event.temporalPrecision)) {
      throw new Error(`${label}: temporalPrecision must be instant or date`);
    }
    if (event.temporalPrecision !== requiredPrecision) {
      throw new Error(`${label}: temporalPrecision must be ${requiredPrecision} for ${event.type}`);
    }
  }

  if (requiredPrecision === 'date') {
    if (hasOwn(event, 'occurredAt')) throw new Error(`${label}: occurredAt must be absent for a date-precision event`);
    if (!isValidCalendarDate(event.occurredDate)) throw new Error(`${label}: occurredDate must be a valid calendar date`);
    return;
  }

  if (hasOwn(event, 'occurredDate')) throw new Error(`${label}: occurredDate must be absent for an instant-precision event`);
  if (!isIsoInstant(event.occurredAt)) throw new Error(`${label}: occurredAt must be a UTC ISO instant`);
}

// A date-precision event has no occurredAt to sort by — its factual chronological anchor is
// occurredDate alone (see the temporal-precision invariant). A bare YYYY-MM-DD string is a
// lexicographic PREFIX of any same-day YYYY-MM-DDTHH:mm:ssZ instant string, so it naturally
// sorts just before that day's timed events without needing special-casing.
function sortKeyFor(event) {
  return isDatePrecisionEvent(event) ? String(event.occurredDate) : String(event.occurredAt);
}

function sortEvents(a, b) {
  const keyCompare = sortKeyFor(a).localeCompare(sortKeyFor(b));
  if (keyCompare !== 0) return keyCompare;
  // A technical, clearly non-factual tiebreaker — never a fabricated time-of-day — used ONLY
  // when at least one side is date-precision and the primary key above ties (e.g. two
  // meal_prepared events on the same calendar day with no time-of-day to order them by).
  if (isDatePrecisionEvent(a) || isDatePrecisionEvent(b)) {
    const recordedCompare = String(a.recordedAt || '').localeCompare(String(b.recordedAt || ''));
    if (recordedCompare !== 0) return recordedCompare;
  }
  return String(a.type).localeCompare(String(b.type))
    || String(a.eventId).localeCompare(String(b.eventId));
}

function activityLine(event) {
  const timezone = timezoneFor(event);
  const startedAt = event.payload?.startedAt || event.occurredAt;
  const endedAt = event.payload?.endedAt || event.occurredAt;
  const duration = minutes(event.payload?.durationMinutes);
  const durationText = duration == null ? '' : ` · ${duration} min`;
  return `- ${timeFor(startedAt, timezone)}-${timeFor(endedAt, timezone)} - **${text(event.payload?.activity, 'Activity')}**${durationText}\n  ${eventMarker(event)}`;
}

function focusLine(event) {
  const timezone = timezoneFor(event);
  const startedAt = event.payload?.startedAt || event.occurredAt;
  const endedAt = event.payload?.endedAt || event.occurredAt;
  const duration = minutes(event.payload?.durationMinutes);
  const durationText = duration == null ? '' : ` · ${duration} min`;
  return `- ${timeFor(startedAt, timezone)}-${timeFor(endedAt, timezone)} - **${text(event.payload?.activity, 'Focus session')}**${durationText}\n  ${eventMarker(event)}`;
}

function learningContext(source = {}) {
  const parts = [source.planTitle, source.phaseTitle, source.lessonTitle]
    .map(item => text(item))
    .filter(Boolean);
  return parts.join(' / ');
}

function learningLine(event) {
  const timezone = timezoneFor(event);
  const context = learningContext(event.payload?.source);
  return [
    `- ${timeFor(event.payload?.completedAt || event.occurredAt, timezone)} - Completed **${text(event.payload?.stepLabel, 'Learning step')}**`,
    context ? `  - ${context}` : '',
    `  ${eventMarker(event)}`
  ].filter(Boolean).join('\n');
}

function workoutLine(event) {
  // startedAt/endedAt are required and validated by assertValidWorkoutCompletedTimeFacts() before
  // any workout_completed event reaches this renderer — no `|| event.occurredAt` fallback here,
  // so a missing/invalid timestamp fails closed at validation rather than silently rendering a
  // fabricated time.
  const timezone = timezoneFor(event);
  const startedAt = event.payload.startedAt;
  const endedAt = event.payload.endedAt;
  const duration = minutes(event.payload?.durationMinutes);
  const exercises = Array.isArray(event.payload?.exercises) ? event.payload.exercises : [];
  const setCount = exercises.reduce((total, exercise) => (
    total + (Array.isArray(exercise?.sets) ? exercise.sets.length : 0)
  ), 0);
  const time = startedAt === endedAt
    ? timeFor(endedAt, timezone)
    : `${timeFor(startedAt, timezone)}-${timeFor(endedAt, timezone)}`;
  const facts = [
    duration == null ? 'duration unknown' : `${duration} min`,
    `${exercises.length} ${exercises.length === 1 ? 'exercise' : 'exercises'}`,
    `${setCount} ${setCount === 1 ? 'set' : 'sets'}`
  ];
  return `- ${time} - Workout **${text(event.payload?.workoutName, 'Workout')}** · ${facts.join(' · ')}\n  ${eventMarker(event)}`;
}

// meal_prepared is date-precision: preparedDate is a factual calendar day with NO time-of-day
// evidence, validated by assertValidMealPreparedPayload() before any meal_prepared event
// reaches this renderer. This line therefore never renders a clock time (never "00:00") —
// only the date itself, worded as a date-level fact ("Prepared — YYYY-MM-DD").
function mealPreparedLine(event) {
  const portions = event.payload?.portionsPrepared;
  const portionsText = portions == null ? '' : ` · ${portions} ${portions === 1 ? 'portion' : 'portions'}`;
  return `- Prepared **${text(event.payload?.mealName, 'Meal')}**${portionsText} — ${event.payload.preparedDate}\n  ${eventMarker(event)}`;
}

// consumedAt is required and validated by assertValidMealConsumedPayload() before any
// meal_consumed event reaches this renderer — no `|| event.occurredAt` fallback here.
function mealConsumedLine(event) {
  const timezone = timezoneFor(event);
  const portions = event.payload?.portionCount;
  const portionsText = portions == null ? '' : ` · ${portions} ${portions === 1 ? 'portion' : 'portions'}`;
  return `- ${timeFor(event.payload.consumedAt, timezone)} - Ate **${text(event.payload?.mealName, 'Meal')}**${portionsText}\n  ${eventMarker(event)}`;
}

function renderDaily(dateKey, events) {
  const activityEvents = events.filter(event => event.type === 'activity_logged');
  const focusEvents = events.filter(event => event.type === 'focus_session_completed');
  const learningEvents = events.filter(event => event.type === 'plan_step_completed');
  const workoutEvents = events.filter(event => event.type === 'workout_completed');
  // Already in the day's overall chronological order (buildObsidianLifeLedgerExport
  // sorts `active` once before grouping into byDay), so this filter does not re-sort.
  const mealEvents = events.filter(event => event.type === 'meal_prepared' || event.type === 'meal_consumed');
  const lines = [
    OBSIDIAN_LIFE_LEDGER_SENTINEL,
    '',
    `# Life Ledger - ${dateKey}`,
    ''
  ];
  if (activityEvents.length) {
    lines.push('## Activity', '', ...activityEvents.map(activityLine), '');
  }
  if (focusEvents.length) {
    lines.push('## Focus', '', ...focusEvents.map(focusLine), '');
  }
  if (learningEvents.length) {
    lines.push('## Learning', '', ...learningEvents.map(learningLine), '');
  }
  if (workoutEvents.length) {
    lines.push('## Workouts', '', ...workoutEvents.map(workoutLine), '');
  }
  if (mealEvents.length) {
    const mealLines = mealEvents.map(event => (
      event.type === 'meal_prepared' ? mealPreparedLine(event) : mealConsumedLine(event)
    ));
    lines.push('## Meals', '', ...mealLines, '');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function renderSystemReadme() {
  return `${[
    OBSIDIAN_LIFE_LEDGER_SENTINEL,
    '',
    '# Life Ledger',
    '',
    'This subtree is generated from validated Life Ledger events.',
    '',
    'Generated Daily notes are current-state projections. Tombstoned events are omitted, and generated stale Daily files may be removed during a full rebuild.',
    '',
    'Do not manually edit generated files inside this subtree; write personal notes elsewhere in the vault.'
  ].join('\n')}\n`;
}

function normalizeEvents(events, unsupportedEventPolicy) {
  if (!Array.isArray(events)) throw new Error('Life Ledger export events must be an array');
  const skipped = [];
  const active = events.filter((event, index) => {
    if (!isPlainObject(event)) throw new Error(`Life Ledger export event at index ${index} must be an object`);
    if (!supportedEventOrThrow(event, index, unsupportedEventPolicy, skipped)) return false;
    assertValidTemporalEnvelope(event, index);
    if (isTombstoned(event)) return false;
    if (event.type === 'workout_completed') assertValidWorkoutCompletedPayload(event, index);
    if (event.type === 'meal_prepared') assertValidMealPreparedPayload(event, index);
    if (event.type === 'meal_consumed') assertValidMealConsumedPayload(event, index);
    return true;
  });
  return { active, skipped };
}

export function buildObsidianLifeLedgerExport(events, options = {}) {
  const unsupportedEventPolicy = options.unsupportedEventPolicy || 'throw';
  if (!['throw', 'skip'].includes(unsupportedEventPolicy)) {
    throw new Error('unsupportedEventPolicy must be throw or skip');
  }
  const { active, skipped } = normalizeEvents(events, unsupportedEventPolicy);
  const byDay = new Map();
  active.slice().sort(sortEvents).forEach(event => {
    // A date-precision event's Daily file is its own asserted factual date directly — never
    // derived via timezone conversion of a nonexistent instant (see the temporal-precision
    // invariant).
    const day = isDatePrecisionEvent(event) ? event.occurredDate : dateKeyFor(event.occurredAt, timezoneFor(event));
    if (!DATE_KEY_RE.test(day)) throw new Error(`Unable to derive Life Ledger export date for event ${event.eventId}`);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(event);
  });
  const files = [
    {
      relativePath: OBSIDIAN_LIFE_LEDGER_SYSTEM_README,
      content: renderSystemReadme()
    },
    ...Array.from(byDay.keys()).sort().map(day => ({
      relativePath: `${OBSIDIAN_LIFE_LEDGER_DAILY_DIR}/${day}.md`,
      content: renderDaily(day, byDay.get(day))
    }))
  ];
  return { files, skipped };
}
