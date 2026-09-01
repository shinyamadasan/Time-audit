const SCHEMA_VERSION = 1;

const ALLOWED_SOURCE_APPS = Object.freeze(['chronasense', 'workout', 'meal']);
const ALLOWED_EVENT_TYPES = Object.freeze([
  'activity_logged',
  'focus_session_completed',
  'plan_step_completed',
  'workout_completed',
  'meal_prepared',
  'meal_consumed'
]);

const EVENT_SOURCE_APPS = Object.freeze({
  activity_logged: Object.freeze(['chronasense']),
  focus_session_completed: Object.freeze(['chronasense']),
  plan_step_completed: Object.freeze(['chronasense']),
  workout_completed: Object.freeze(['workout']),
  meal_prepared: Object.freeze(['meal']),
  meal_consumed: Object.freeze(['meal'])
});

const TOMBSTONE_REASONS = Object.freeze([
  'user_delete',
  'bulk_clear',
  'merge_replaced',
  'data_doctor_repair'
]);

const PAYLOAD_RULES = Object.freeze({
  activity_logged: Object.freeze({
    required: Object.freeze(['activity', 'category', 'startedAt', 'endedAt', 'durationMinutes']),
    optional: Object.freeze(['energy', 'onPlan', 'project', 'note', 'captureMethod', 'source']),
    instantFields: Object.freeze(['startedAt', 'endedAt']),
    occurredAtField: 'endedAt',
    duration: true
  }),
  focus_session_completed: Object.freeze({
    required: Object.freeze(['activity', 'startedAt', 'endedAt', 'durationMinutes']),
    optional: Object.freeze(['pomodoroCount', 'phase', 'onPlan', 'source', 'additiveForTimeTotals']),
    instantFields: Object.freeze(['startedAt', 'endedAt']),
    occurredAtField: 'endedAt',
    duration: true
  }),
  plan_step_completed: Object.freeze({
    required: Object.freeze(['planDate', 'stepLabel', 'completedAt']),
    optional: Object.freeze(['plannedWhen', 'trackedMinutes', 'source']),
    instantFields: Object.freeze(['completedAt']),
    dateFields: Object.freeze(['planDate']),
    occurredAtField: 'completedAt'
  }),
  workout_completed: Object.freeze({
    required: Object.freeze(['workoutName', 'startedAt', 'endedAt']),
    // `program` and a top-level `sets` field are not part of Workout V1 semantics (per-exercise set
    // data lives at exercises[].sets) and are intentionally NOT allowlisted here: an unrecognized
    // payload key is rejected by the generic "not allowed for workout_completed" check below.
    optional: Object.freeze(['durationMinutes', 'exercises', 'volume', 'bodyWeight', 'rating', 'note', 'source']),
    instantFields: Object.freeze(['startedAt', 'endedAt']),
    occurredAtField: 'endedAt',
    duration: 'optional'
  }),
  meal_prepared: Object.freeze({
    required: Object.freeze(['mealName', 'preparedAt']),
    optional: Object.freeze(['servingsPrepared', 'portionsRemaining', 'ingredients', 'source']),
    instantFields: Object.freeze(['preparedAt']),
    occurredAtField: 'preparedAt'
  }),
  meal_consumed: Object.freeze({
    required: Object.freeze(['mealName', 'consumedAt', 'portionCount']),
    optional: Object.freeze(['cookedMealId', 'source']),
    instantFields: Object.freeze(['consumedAt']),
    occurredAtField: 'consumedAt'
  })
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Deep `workout_completed` payload shape checks. Kept in a single type-scoped block (only reached
// when event.type === 'workout_completed') rather than generalized into PAYLOAD_RULES so no other
// event type's validation behavior changes. This exists because malformed workout payloads
// (object workoutName, string exercises, wrong-typed nested sets) can otherwise pass the generic
// required/instant/duration checks above and reach the Obsidian renderer as plausible-looking but
// fabricated Markdown. Only field TYPES are enforced here, not completeness, so hand-built partial
// fixtures with a subset of `payload.source` keys keep validating exactly as before.
const WORKOUT_TEXT_MAX_LENGTH = 200;
const WORKOUT_NOTE_MAX_LENGTH = 300;
const WORKOUT_ID_MAX_LENGTH = 200;
const WORKOUT_SET_MODES = new Set(['reps', 'time', 'cardio']);
const WORKOUT_RATINGS = new Set(['easy', 'right', 'hard']);
const WORKOUT_RECORD_CATEGORIES = new Set(['workouts_collection_record', 'csv_import_path_compatible']);
const WORKOUT_DURATION_STATUSES = new Set(['unknown', 'zero-or-unknown', 'recorded-interval']);
const WORKOUT_WEIGHT_UNITS = new Set(['kg', 'lb']);
// Every value the adapter actually produces. Not a general-purpose enum: an importer cannot assert
// a stronger origin/basis than these, so arbitrary overclaiming strings (e.g. "definitely_native",
// "cryptographically_verified") are rejected rather than accepted as free-form provenance text.
const WORKOUT_RECORD_ORIGINS = new Set(['indeterminate_from_backup']);
const WORKOUT_COMPLETION_BASES = new Set(['validated-workouts-collection-membership', 'source-import-path-shape-compatible']);

const WORKOUT_SET_ALLOWED_KEYS = Object.freeze({
  reps: Object.freeze(['load', 'repetitions', 'rir', 'rpe']),
  time: Object.freeze(['seconds', 'load', 'rir', 'rpe']),
  cardio: Object.freeze(['minutes', 'speedKph', 'rir', 'rpe'])
});
const WORKOUT_PRESCRIPTION_NUMBER_KEYS = Object.freeze([
  'plannedSets', 'plannedRepetitions', 'plannedLoad', 'plannedSeconds', 'plannedMinutes',
  'plannedSpeedKph', 'progressionIncrement', 'progressionMinimumRepetitions'
]);
const WORKOUT_PRESCRIPTION_ALLOWED_KEYS = Object.freeze(['mode', ...WORKOUT_PRESCRIPTION_NUMBER_KEYS, 'progressionRule']);
const WORKOUT_EXERCISE_ALLOWED_KEYS = Object.freeze([
  'exerciseId', 'mode', 'sets', 'exerciseName', 'topWeight', 'personalRecord', 'prescription'
]);
const WORKOUT_SOURCE_ALLOWED_KEYS = Object.freeze([
  'workoutId', 'localDate', 'recordCategory', 'recordOrigin', 'completionBasis', 'durationStatus',
  'timezoneContext', 'weightUnitContext', 'routineId', 'personalRecordExerciseIds'
]);
const WORKOUT_TIMEZONE_CONTEXT_ALLOWED_KEYS = Object.freeze(['authority', 'timeZone']);
const WORKOUT_UNKNOWN_UNIT_CONTEXT_ALLOWED_KEYS = Object.freeze(['authority']);
const WORKOUT_ASSERTED_UNIT_CONTEXT_ALLOWED_KEYS = Object.freeze(['authority', 'unit']);

// Rejects any key on `obj` not present in `allowedKeys`, so a bounded object cannot carry arbitrary
// extra nested fields that alter provenance/assertion meaning while still passing per-field checks.
function rejectUnknownKeys(obj, allowedKeys, errors, path) {
  const allowed = new Set(allowedKeys);
  Object.keys(obj).forEach(key => {
    if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
  });
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

function validateWorkoutCompletedSet(set, mode, errors, path) {
  if (!isPlainObject(set)) { errors.push(`${path} must be an object`); return; }
  if (mode === 'reps') {
    pushIf(errors, !isFiniteNonNegative(set.load), `${path}.load must be a non-negative number`);
    pushIf(errors, !Number.isInteger(set.repetitions) || set.repetitions < 0, `${path}.repetitions must be a non-negative integer`);
  } else if (mode === 'time') {
    pushIf(errors, typeof set.seconds !== 'number' || !Number.isFinite(set.seconds) || set.seconds <= 0, `${path}.seconds must be a positive number`);
    if (hasOwn(set, 'load') && set.load != null) pushIf(errors, !isFiniteNonNegative(set.load), `${path}.load must be a non-negative number`);
  } else if (mode === 'cardio') {
    pushIf(errors, typeof set.minutes !== 'number' || !Number.isFinite(set.minutes) || set.minutes <= 0, `${path}.minutes must be a positive number`);
    if (hasOwn(set, 'speedKph') && set.speedKph != null) pushIf(errors, !isFiniteNonNegative(set.speedKph), `${path}.speedKph must be a non-negative number`);
  }
  ['rir', 'rpe'].forEach(key => {
    if (hasOwn(set, key) && set[key] != null) {
      pushIf(errors, typeof set[key] !== 'number' || !Number.isFinite(set[key]) || set[key] < 0 || set[key] > 10, `${path}.${key} must be between 0 and 10`);
    }
  });
  rejectUnknownKeys(set, WORKOUT_SET_ALLOWED_KEYS[mode], errors, path);
}

function validateWorkoutCompletedPrescription(prescription, mode, errors, path) {
  if (!isPlainObject(prescription)) { errors.push(`${path} must be an object`); return; }
  if (hasOwn(prescription, 'mode') && prescription.mode != null) {
    pushIf(errors, prescription.mode !== mode, `${path}.mode must match the exercise mode`);
  }
  WORKOUT_PRESCRIPTION_NUMBER_KEYS.forEach(key => {
    if (hasOwn(prescription, key) && prescription[key] != null) {
      pushIf(errors, !isFiniteNonNegative(prescription[key]), `${path}.${key} must be a non-negative number`);
    }
  });
  if (hasOwn(prescription, 'progressionRule') && prescription.progressionRule != null) {
    pushIf(errors, !isBoundedWorkoutText(prescription.progressionRule, WORKOUT_TEXT_MAX_LENGTH), `${path}.progressionRule must be bounded text`);
  }
  rejectUnknownKeys(prescription, WORKOUT_PRESCRIPTION_ALLOWED_KEYS, errors, path);
}

function validateWorkoutCompletedExercise(exercise, errors, path) {
  if (!isPlainObject(exercise)) { errors.push(`${path} must be an object`); return; }
  pushIf(errors, !isBoundedWorkoutId(exercise.exerciseId), `${path}.exerciseId must be a bounded identifier`);
  const mode = WORKOUT_SET_MODES.has(exercise.mode) ? exercise.mode : null;
  pushIf(errors, !mode, `${path}.mode must be reps, time, or cardio`);
  if (!Array.isArray(exercise.sets) || exercise.sets.length === 0) {
    errors.push(`${path}.sets must be a non-empty array`);
  } else if (mode) {
    exercise.sets.forEach((set, index) => validateWorkoutCompletedSet(set, mode, errors, `${path}.sets[${index}]`));
  }
  if (hasOwn(exercise, 'exerciseName') && exercise.exerciseName != null) {
    pushIf(errors, !isBoundedWorkoutText(exercise.exerciseName, WORKOUT_TEXT_MAX_LENGTH), `${path}.exerciseName must be bounded text`);
  }
  if (hasOwn(exercise, 'topWeight') && exercise.topWeight != null) {
    pushIf(errors, !isFiniteNonNegative(exercise.topWeight), `${path}.topWeight must be a non-negative number`);
  }
  if (hasOwn(exercise, 'personalRecord') && exercise.personalRecord != null) {
    pushIf(errors, typeof exercise.personalRecord !== 'boolean', `${path}.personalRecord must be boolean`);
  }
  if (hasOwn(exercise, 'prescription') && exercise.prescription != null && mode) {
    validateWorkoutCompletedPrescription(exercise.prescription, mode, errors, `${path}.prescription`);
  }
  rejectUnknownKeys(exercise, WORKOUT_EXERCISE_ALLOWED_KEYS, errors, path);
}

function validateWorkoutCompletedTimezoneContext(timezoneContext, errors, path) {
  if (!isPlainObject(timezoneContext)) { errors.push(`${path} must be an object`); return; }
  const ok = timezoneContext.authority === 'import_assertion' && isIanaTimezone(timezoneContext.timeZone);
  pushIf(errors, !ok, `${path} must assert a valid IANA timezone`);
  rejectUnknownKeys(timezoneContext, WORKOUT_TIMEZONE_CONTEXT_ALLOWED_KEYS, errors, path);
}

function validateWorkoutCompletedWeightUnitContext(weightUnitContext, errors, path) {
  if (!isPlainObject(weightUnitContext)) { errors.push(`${path} must be an object`); return; }
  if (weightUnitContext.authority === 'unknown') {
    // An "unknown" authority asserts nothing about the unit; a `unit` key alongside it is a
    // contradictory/nonsensical combination and must be rejected, not silently accepted.
    rejectUnknownKeys(weightUnitContext, WORKOUT_UNKNOWN_UNIT_CONTEXT_ALLOWED_KEYS, errors, path);
  } else if (weightUnitContext.authority === 'import_assertion') {
    pushIf(errors, !WORKOUT_WEIGHT_UNITS.has(weightUnitContext.unit), `${path}.unit must be kg or lb`);
    rejectUnknownKeys(weightUnitContext, WORKOUT_ASSERTED_UNIT_CONTEXT_ALLOWED_KEYS, errors, path);
  } else {
    errors.push(`${path}.authority must be 'unknown' or 'import_assertion'`);
  }
}

function validateWorkoutCompletedSource(source, event, errors) {
  const path = 'payload.source';
  if (!isPlainObject(source)) { errors.push(`${path} must be an object`); return; }
  if (hasOwn(source, 'workoutId') && source.workoutId != null) {
    pushIf(errors, !isBoundedWorkoutId(source.workoutId) || source.workoutId !== event.sourceEntityId, `${path}.workoutId must match sourceEntityId`);
  }
  if (hasOwn(source, 'localDate') && source.localDate != null) {
    pushIf(errors, typeof source.localDate !== 'string' || !DATE_KEY_RE.test(source.localDate), `${path}.localDate must be YYYY-MM-DD`);
  }
  if (hasOwn(source, 'recordCategory') && source.recordCategory != null) {
    pushIf(errors, !WORKOUT_RECORD_CATEGORIES.has(source.recordCategory), `${path}.recordCategory is not recognized`);
  }
  if (hasOwn(source, 'recordOrigin') && source.recordOrigin != null) {
    pushIf(errors, !WORKOUT_RECORD_ORIGINS.has(source.recordOrigin), `${path}.recordOrigin is not recognized`);
  }
  if (hasOwn(source, 'completionBasis') && source.completionBasis != null) {
    pushIf(errors, !WORKOUT_COMPLETION_BASES.has(source.completionBasis), `${path}.completionBasis is not recognized`);
  }
  if (hasOwn(source, 'durationStatus') && source.durationStatus != null) {
    pushIf(errors, !WORKOUT_DURATION_STATUSES.has(source.durationStatus), `${path}.durationStatus is not recognized`);
  }
  if (hasOwn(source, 'timezoneContext') && source.timezoneContext != null) {
    validateWorkoutCompletedTimezoneContext(source.timezoneContext, errors, `${path}.timezoneContext`);
  }
  if (hasOwn(source, 'weightUnitContext') && source.weightUnitContext != null) {
    validateWorkoutCompletedWeightUnitContext(source.weightUnitContext, errors, `${path}.weightUnitContext`);
  }
  if (hasOwn(source, 'routineId') && source.routineId != null) {
    pushIf(errors, !isBoundedWorkoutId(source.routineId), `${path}.routineId must be a bounded identifier`);
  }
  if (hasOwn(source, 'personalRecordExerciseIds') && source.personalRecordExerciseIds != null) {
    const idsOk = Array.isArray(source.personalRecordExerciseIds) && source.personalRecordExerciseIds.every(isBoundedWorkoutId);
    pushIf(errors, !idsOk, `${path}.personalRecordExerciseIds must be an array of bounded identifiers`);
  }
  rejectUnknownKeys(source, WORKOUT_SOURCE_ALLOWED_KEYS, errors, path);
}

function validateWorkoutCompletedPayloadShape(event, errors) {
  const payload = event.payload;
  pushIf(errors, !isBoundedWorkoutText(payload.workoutName, WORKOUT_TEXT_MAX_LENGTH), 'payload.workoutName must be bounded text');
  if (hasOwn(payload, 'exercises') && payload.exercises != null) {
    if (!Array.isArray(payload.exercises)) {
      errors.push('payload.exercises must be an array');
    } else {
      payload.exercises.forEach((exercise, index) => validateWorkoutCompletedExercise(exercise, errors, `payload.exercises[${index}]`));
    }
  }
  if (hasOwn(payload, 'volume') && payload.volume != null) {
    pushIf(errors, !isFiniteNonNegative(payload.volume), 'payload.volume must be a non-negative number');
  }
  if (hasOwn(payload, 'bodyWeight') && payload.bodyWeight != null) {
    const bodyWeightOk = isPlainObject(payload.bodyWeight)
      && Object.keys(payload.bodyWeight).every(key => key === 'value')
      && typeof payload.bodyWeight.value === 'number' && Number.isFinite(payload.bodyWeight.value) && payload.bodyWeight.value > 0;
    pushIf(errors, !bodyWeightOk, 'payload.bodyWeight must be { value: positive number }');
  }
  if (hasOwn(payload, 'rating') && payload.rating != null) {
    pushIf(errors, !WORKOUT_RATINGS.has(payload.rating), 'payload.rating is not recognized');
  }
  if (hasOwn(payload, 'note') && payload.note != null) {
    pushIf(errors, !isBoundedWorkoutText(payload.note, WORKOUT_NOTE_MAX_LENGTH), 'payload.note must be bounded text');
  }
  if (hasOwn(payload, 'source') && payload.source != null) {
    validateWorkoutCompletedSource(payload.source, event, errors);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function validationResult(errors) {
  return { ok: errors.length === 0, errors };
}

function pushIf(errors, condition, message) {
  if (condition) errors.push(message);
}

export function validateJsonSafeValue(value, path = 'value', errors = [], seen = new Set()) {
  if (value === null) return validationResult(errors);
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') return validationResult(errors);
  if (valueType === 'number') {
    if (!Number.isFinite(value)) errors.push(`${path} must be a finite number`);
    return validationResult(errors);
  }
  if (valueType === 'undefined' || valueType === 'function' || valueType === 'symbol' || valueType === 'bigint') {
    errors.push(`${path} contains unsupported ${valueType}`);
    return validationResult(errors);
  }
  if (seen.has(value)) {
    errors.push(`${path} contains a circular reference`);
    return validationResult(errors);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!hasOwn(value, index)) {
        errors.push(`${path}[${index}] is a sparse array hole`);
        continue;
      }
      validateJsonSafeValue(value[index], `${path}[${index}]`, errors, seen);
    }
    seen.delete(value);
    return validationResult(errors);
  }
  if (!isPlainObject(value)) {
    errors.push(`${path} must be JSON-safe plain data`);
    seen.delete(value);
    return validationResult(errors);
  }
  Object.keys(value).forEach(key => validateJsonSafeValue(value[key], `${path}.${key}`, errors, seen));
  seen.delete(value);
  return validationResult(errors);
}

function isIsoInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalizeIsoInstant(value);
}

function normalizeIsoInstant(value) {
  return new Date(Date.parse(value)).toISOString();
}

function isIanaTimezone(value) {
  if (typeof value !== 'string' || !value.trim() || !value.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function validateBaseEventShape(event, errors) {
  if (!isPlainObject(event)) {
    errors.push('event must be an object');
    return;
  }

  pushIf(errors, event.schemaVersion !== SCHEMA_VERSION, 'schemaVersion must be 1');
  pushIf(errors, !ALLOWED_SOURCE_APPS.includes(event.sourceApp), 'sourceApp is not allowed for V1');
  pushIf(errors, typeof event.sourceEntityId !== 'string' || event.sourceEntityId.length === 0, 'sourceEntityId must be a non-empty string');
  pushIf(errors, !ALLOWED_EVENT_TYPES.includes(event.type), 'type is not allowed for V1');
  if (ALLOWED_EVENT_TYPES.includes(event.type)) {
    pushIf(errors, !EVENT_SOURCE_APPS[event.type].includes(event.sourceApp), `${event.type} is not allowed for sourceApp ${event.sourceApp}`);
  }
  pushIf(errors, !isIsoInstant(event.occurredAt), 'occurredAt must be a UTC ISO instant');
  pushIf(errors, !isIanaTimezone(event.sourceTimezone), 'sourceTimezone must be a valid IANA timezone');

  validatePayload(event, errors);
  validateProvenance(event, errors);
  validateConfidence(event, errors);
  validateTombstone(event, errors);
}

function validatePayload(event, errors) {
  const payload = event.payload;
  const rules = PAYLOAD_RULES[event.type];
  if (!rules) return;
  if (!isPlainObject(payload)) {
    errors.push('payload must be an object');
    return;
  }
  validateJsonSafeValue(payload, 'payload', errors);

  const allowed = new Set([...rules.required, ...rules.optional]);
  Object.keys(payload).forEach(key => {
    if (!allowed.has(key)) errors.push(`payload.${key} is not allowed for ${event.type}`);
  });
  rules.required.forEach(key => {
    if (!hasOwn(payload, key) || payload[key] == null || payload[key] === '') errors.push(`payload.${key} is required`);
  });
  (rules.instantFields || []).forEach(key => {
    if (hasOwn(payload, key) && !isIsoInstant(payload[key])) errors.push(`payload.${key} must be a UTC ISO instant`);
  });
  (rules.dateFields || []).forEach(key => {
    if (hasOwn(payload, key) && !DATE_KEY_RE.test(payload[key])) errors.push(`payload.${key} must be YYYY-MM-DD`);
  });
  if (rules.duration) {
    const hasDuration = hasOwn(payload, 'durationMinutes') && payload.durationMinutes != null;
    if (rules.duration === true || hasDuration) {
      pushIf(errors, typeof payload.durationMinutes !== 'number' || !Number.isFinite(payload.durationMinutes) || payload.durationMinutes <= 0, 'payload.durationMinutes must be a positive number');
    }
    if (isIsoInstant(payload.startedAt) && isIsoInstant(payload.endedAt)) {
      const interval = Date.parse(payload.endedAt) - Date.parse(payload.startedAt);
      pushIf(errors, interval < 0, 'payload.endedAt must not be before payload.startedAt');
      if (rules.duration === true || hasDuration) {
        pushIf(errors, interval <= 0, 'payload.endedAt must be after payload.startedAt when durationMinutes is present');
      } else if (rules.duration === 'optional') {
        pushIf(errors, interval !== 0, 'payload.durationMinutes is required when payload.endedAt is after payload.startedAt');
      }
    }
  }
  if (event.type === 'meal_consumed') {
    pushIf(errors, typeof payload.portionCount !== 'number' || !Number.isFinite(payload.portionCount) || payload.portionCount <= 0, 'payload.portionCount must be a positive number');
  }
  if (rules.occurredAtField && isIsoInstant(event.occurredAt) && isIsoInstant(payload[rules.occurredAtField])) {
    pushIf(errors, normalizeIsoInstant(event.occurredAt) !== normalizeIsoInstant(payload[rules.occurredAtField]), `occurredAt must match payload.${rules.occurredAtField}`);
  }
  if (event.type === 'workout_completed') {
    validateWorkoutCompletedPayloadShape(event, errors);
  }
}

function validateProvenance(event, errors) {
  const provenance = event.provenance;
  if (!isPlainObject(provenance)) {
    errors.push('provenance must be an object');
    return;
  }
  validateJsonSafeValue(provenance, 'provenance', errors);

  pushIf(errors, provenance.source !== event.sourceApp, 'provenance.source must match sourceApp');
  pushIf(errors, typeof provenance.sourceRecordKind !== 'string' || !provenance.sourceRecordKind.trim(), 'provenance.sourceRecordKind is required');
  pushIf(errors, typeof provenance.adapterVersion !== 'string' || !provenance.adapterVersion.trim(), 'provenance.adapterVersion is required');
  pushIf(errors, !isIsoInstant(provenance.observedAt), 'provenance.observedAt must be a UTC ISO instant');
  pushIf(errors, !Array.isArray(provenance.evidence) || provenance.evidence.length === 0, 'provenance.evidence must be a non-empty array');
  if (Array.isArray(provenance.evidence)) {
    provenance.evidence.forEach((item, index) => {
      if (typeof item !== 'string' || !item.trim()) errors.push(`provenance.evidence[${index}] must be a non-empty string`);
    });
  }
  ['captureMethod', 'sourceOperation'].forEach(key => {
    if (hasOwn(provenance, key) && (typeof provenance[key] !== 'string' || !provenance[key].trim())) {
      errors.push(`provenance.${key} must be a non-empty string when present`);
    }
  });
}

function validateConfidence(event, errors) {
  const confidence = event.confidence;
  if (!isPlainObject(confidence)) {
    errors.push('confidence must be an object');
    return;
  }
  validateJsonSafeValue(confidence, 'confidence', errors);

  pushIf(errors, typeof confidence.score !== 'number' || !Number.isFinite(confidence.score) || confidence.score < 0 || confidence.score > 1, 'confidence.score must be between 0 and 1');
  pushIf(errors, typeof confidence.basis !== 'string' || !confidence.basis.trim(), 'confidence.basis is required');
}

function validateTombstone(event, errors) {
  const tombstone = event.tombstone;
  if (!isPlainObject(tombstone)) {
    errors.push('tombstone must be an object');
    return;
  }
  validateJsonSafeValue(tombstone, 'tombstone', errors);

  pushIf(errors, typeof tombstone.active !== 'boolean', 'tombstone.active must be boolean');
  if (tombstone.active === true) {
    pushIf(errors, !isIsoInstant(tombstone.deletedAt), 'active tombstone.deletedAt must be a UTC ISO instant');
    pushIf(errors, !TOMBSTONE_REASONS.includes(tombstone.reason), 'active tombstone.reason is not contract-defined');
    if (!isPlainObject(tombstone.provenance)) {
      errors.push('active tombstone.provenance must be an object');
    } else {
      pushIf(errors, typeof tombstone.provenance.sourceOperation !== 'string' || !['delete', 'merge', 'repair'].includes(tombstone.provenance.sourceOperation), 'active tombstone.provenance.sourceOperation must be explicit deletion evidence');
      pushIf(errors, typeof tombstone.provenance.sourceRecordKind !== 'string' || !tombstone.provenance.sourceRecordKind.trim(), 'active tombstone.provenance.sourceRecordKind is required');
      pushIf(errors, !Array.isArray(tombstone.provenance.evidence) || tombstone.provenance.evidence.length === 0, 'active tombstone.provenance.evidence is required');
    }
  } else if (tombstone.active === false) {
    pushIf(errors, hasOwn(tombstone, 'deletedAt') && tombstone.deletedAt != null, 'inactive tombstone.deletedAt must be null or absent');
    pushIf(errors, hasOwn(tombstone, 'reason') && tombstone.reason != null, 'inactive tombstone.reason must be null or absent');
    pushIf(errors, hasOwn(tombstone, 'provenance') && tombstone.provenance != null, 'inactive tombstone.provenance must be null or absent');
  }
}

export function validateLifeLedgerEvent(event) {
  const errors = [];
  validateBaseEventShape(event, errors);
  if (!isPlainObject(event)) return validationResult(errors);

  pushIf(errors, typeof event.eventId !== 'string' || !UUID_RE.test(event.eventId), 'eventId must be a UUID');
  pushIf(errors, !isIsoInstant(event.recordedAt), 'recordedAt must be a UTC ISO instant');
  pushIf(errors, !Number.isInteger(event.revision) || event.revision < 1, 'revision must be a positive integer');
  if (event.revision === 1) {
    pushIf(errors, hasOwn(event, 'revisedAt') && event.revisedAt != null, 'revisedAt must be null or absent for revision 1');
  } else {
    pushIf(errors, !isIsoInstant(event.revisedAt), 'revisedAt must be a UTC ISO instant after revision 1');
  }
  return validationResult(errors);
}

export function validateLifeLedgerEventDraft(event) {
  const errors = [];
  validateBaseEventShape(event, errors);
  if (!isPlainObject(event)) return validationResult(errors);

  ['eventId', 'recordedAt', 'revision'].forEach(key => {
    if (hasOwn(event, key)) errors.push(`draft must not provide Life Ledger-owned ${key}`);
  });
  if (hasOwn(event, 'revisedAt') && event.revisedAt != null) errors.push('draft must not provide revisedAt');
  return validationResult(errors);
}

export function deriveLifeLedgerKey(event) {
  if (!event || event.sourceApp == null || event.sourceEntityId == null || event.type == null) {
    throw new Error('sourceApp, sourceEntityId, and type are required for Life Ledger identity');
  }
  return `${event.sourceApp}:${String(event.sourceEntityId)}:${event.type}`;
}

function orderedObject(value) {
  if (Array.isArray(value)) return value.map(orderedObject);
  if (!isPlainObject(value)) return value;
  return Object.keys(value).sort().reduce((out, key) => {
    const child = orderedObject(value[key]);
    if (child == null) return out;
    out[key] = child;
    return out;
  }, {});
}

function normalizeEvidence(evidence) {
  return [...new Set((evidence || []).map(item => String(item)))].sort();
}

function normalizePayload(type, payload) {
  const rules = PAYLOAD_RULES[type];
  const keys = [...rules.required, ...rules.optional].filter(key => hasOwn(payload, key) && payload[key] != null);
  return keys.sort().reduce((out, key) => {
    const value = payload[key];
    out[key] = (rules.instantFields || []).includes(key) ? normalizeIsoInstant(value) : orderedObject(value);
    return out;
  }, {});
}

function normalizeMeaningfulProvenance(provenance) {
  const out = {
    source: provenance.source,
    sourceRecordKind: provenance.sourceRecordKind,
    evidence: normalizeEvidence(provenance.evidence)
  };
  ['captureMethod', 'sourceOperation'].forEach(key => {
    if (hasOwn(provenance, key) && provenance[key] != null) out[key] = provenance[key];
  });
  return orderedObject(out);
}

function normalizeMeaningfulTombstone(tombstone) {
  if (!tombstone.active) return { active: false };
  const out = {
    active: true,
    deletedAt: normalizeIsoInstant(tombstone.deletedAt),
    reason: tombstone.reason
  };
  if (isPlainObject(tombstone.provenance)) {
    out.provenance = scrubOperationalMetadata({
      sourceOperation: tombstone.provenance.sourceOperation,
      sourceRecordKind: tombstone.provenance.sourceRecordKind,
      evidence: Array.isArray(tombstone.provenance.evidence) ? normalizeEvidence(tombstone.provenance.evidence) : undefined,
      marker: tombstone.provenance.marker,
      sourceMetadata: tombstone.provenance.sourceMetadata
    });
  }
  return orderedObject(out);
}

function scrubOperationalMetadata(value) {
  if (Array.isArray(value)) return value.map(scrubOperationalMetadata);
  if (!isPlainObject(value)) return value;
  const operationalKeys = new Set([
    'observedAt',
    'adapterVersion',
    'recordedAt',
    'revisedAt',
    'revision',
    'eventId',
    'updatedAt',
    'syncStamp',
    'downloadedAt'
  ]);
  return Object.keys(value).sort().reduce((out, key) => {
    if (operationalKeys.has(key)) return out;
    const child = scrubOperationalMetadata(value[key]);
    if (child == null) return out;
    out[key] = child;
    return out;
  }, {});
}

export function canonicalizeLifeLedgerFacts(event) {
  const errors = [];
  validateBaseEventShape(event, errors);
  if (errors.length) throw new Error(`Invalid Life Ledger event: ${errors.join('; ')}`);

  return orderedObject({
    schemaVersion: SCHEMA_VERSION,
    sourceApp: event.sourceApp,
    sourceEntityId: String(event.sourceEntityId),
    type: event.type,
    occurredAt: normalizeIsoInstant(event.occurredAt),
    sourceTimezone: event.sourceTimezone,
    payload: normalizePayload(event.type, event.payload),
    provenance: normalizeMeaningfulProvenance(event.provenance),
    confidence: orderedObject({
      score: event.confidence.score,
      basis: event.confidence.basis
    }),
    tombstone: normalizeMeaningfulTombstone(event.tombstone)
  });
}

export function serializeLifeLedgerFacts(event) {
  return JSON.stringify(canonicalizeLifeLedgerFacts(event));
}

export function hashCanonicalLifeLedgerFacts(serializedFacts) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < serializedFacts.length; i++) {
    hash ^= serializedFacts.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function fingerprintLifeLedgerEvent(event) {
  return hashCanonicalLifeLedgerFacts(serializeLifeLedgerFacts(event));
}

export function createLifeLedgerMemoryStore(initialRecords = []) {
  const records = new Map();
  initialRecords.forEach(record => {
    if (!record || !record.key || !record.event || !record.fingerprint) return;
    records.set(record.key, {
      key: record.key,
      event: structuredCloneCompat(record.event),
      fingerprint: record.fingerprint
    });
  });

  return {
    getByKey(key) {
      const record = records.get(key);
      return record ? structuredCloneCompat(record) : null;
    },
    put(record) {
      records.set(record.key, {
        key: record.key,
        event: structuredCloneCompat(record.event),
        fingerprint: record.fingerprint
      });
      return this.getByKey(record.key);
    },
    listRecords() {
      return Array.from(records.values()).map(structuredCloneCompat);
    },
    listEvents() {
      return Array.from(records.values()).map(record => structuredCloneCompat(record.event));
    }
  };
}

function structuredCloneCompat(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function defaultClock() {
  return new Date().toISOString();
}

function defaultUuid() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  throw new Error('No UUID generator available; inject createId for this runtime');
}

function hasExplicitRestoreEvidence(event) {
  return event.provenance && event.provenance.sourceOperation === 'restore';
}

function buildStoredEvent(draft, eventId, recordedAt, revisedAt, revision) {
  return {
    ...structuredCloneCompat(draft),
    eventId,
    sourceEntityId: String(draft.sourceEntityId),
    occurredAt: normalizeIsoInstant(draft.occurredAt),
    recordedAt,
    revisedAt,
    revision
  };
}

export function upsertLifeLedgerEvent(store, normalizedEvent, options = {}) {
  if (!store || typeof store.getByKey !== 'function' || typeof store.put !== 'function') {
    throw new Error('A Life Ledger store with getByKey() and put() is required');
  }

  const draftValidation = validateLifeLedgerEventDraft(normalizedEvent);
  if (!draftValidation.ok) {
    return { action: 'rejected', reason: 'invalid_event', errors: draftValidation.errors };
  }

  const key = deriveLifeLedgerKey(normalizedEvent);
  const fingerprint = fingerprintLifeLedgerEvent(normalizedEvent);
  const existing = store.getByKey(key);
  const now = (options.clock || defaultClock)();
  const isRestore = hasExplicitRestoreEvidence(normalizedEvent);

  if (!existing) {
    if (isRestore) {
      return { action: 'rejected', reason: 'restore_requires_existing_tombstone', key };
    }
    const event = buildStoredEvent(normalizedEvent, (options.createId || defaultUuid)(), now, null, 1);
    const validation = validateLifeLedgerEvent(event);
    if (!validation.ok) return { action: 'rejected', reason: 'invalid_created_event', errors: validation.errors };
    store.put({ key, event, fingerprint });
    return { action: 'created', key, event: structuredCloneCompat(event) };
  }

  if (existing.fingerprint === fingerprint) {
    return { action: 'unchanged', key, event: structuredCloneCompat(existing.event) };
  }

  const wasDeleted = existing.event.tombstone && existing.event.tombstone.active === true;
  const isDeleted = normalizedEvent.tombstone && normalizedEvent.tombstone.active === true;
  if (!wasDeleted && isRestore) {
    return {
      action: 'rejected',
      reason: 'restore_requires_existing_tombstone',
      key,
      event: structuredCloneCompat(existing.event)
    };
  }
  if (wasDeleted && !isDeleted && !hasExplicitRestoreEvidence(normalizedEvent)) {
    return {
      action: 'rejected',
      reason: 'restore_requires_explicit_evidence',
      key,
      event: structuredCloneCompat(existing.event)
    };
  }

  const event = buildStoredEvent(
    normalizedEvent,
    existing.event.eventId,
    existing.event.recordedAt,
    now,
    existing.event.revision + 1
  );
  const validation = validateLifeLedgerEvent(event);
  if (!validation.ok) return { action: 'rejected', reason: 'invalid_revised_event', errors: validation.errors };
  store.put({ key, event, fingerprint });

  const action = !wasDeleted && isDeleted ? 'tombstoned' : wasDeleted && !isDeleted ? 'restored' : 'revised';
  return { action, key, event: structuredCloneCompat(event) };
}

export function upsertManyLifeLedgerEvents(store, normalizedEvents, options = {}) {
  if (!Array.isArray(normalizedEvents)) {
    return { action: 'rejected', reason: 'events_must_be_array', results: [] };
  }

  const byKey = new Map();
  const results = [];
  for (const event of normalizedEvents) {
    const draftValidation = validateLifeLedgerEventDraft(event);
    if (!draftValidation.ok) {
      results.push({ action: 'rejected', reason: 'invalid_event', errors: draftValidation.errors });
      continue;
    }
    const key = deriveLifeLedgerKey(event);
    const fingerprint = fingerprintLifeLedgerEvent(event);
    const group = byKey.get(key) || { key, fingerprints: new Set(), events: [] };
    group.fingerprints.add(fingerprint);
    group.events.push(event);
    byKey.set(key, group);
  }

  const conflictKeys = new Set();
  byKey.forEach(group => {
    if (group.fingerprints.size > 1) {
      conflictKeys.add(group.key);
      results.push({
        action: 'rejected',
        reason: 'conflicting_duplicate_physical_input',
        key: group.key,
        count: group.events.length
      });
    }
  });

  byKey.forEach(group => {
    if (conflictKeys.has(group.key)) return;
    results.push(upsertLifeLedgerEvent(store, group.events[0], options));
  });

  return {
    action: results.some(result => result.action === 'rejected') ? 'partial' : 'ok',
    results
  };
}

export const LIFE_LEDGER_V1 = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  sourceApps: ALLOWED_SOURCE_APPS,
  eventTypes: ALLOWED_EVENT_TYPES,
  eventSourceApps: EVENT_SOURCE_APPS,
  tombstoneReasons: TOMBSTONE_REASONS
});
