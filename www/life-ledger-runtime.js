import {
  createLifeLedgerMemoryStore,
  deriveLifeLedgerKey,
  fingerprintLifeLedgerEvent,
  upsertLifeLedgerEvent,
  validateLifeLedgerEvent
} from './life-ledger-core.js';

export const LIFE_LEDGER_RUNTIME_SCHEMA_VERSION = 1;
export const LIFE_LEDGER_RUNTIME_KEY = 'ta3-life-ledger-v1';
export const LIFE_LEDGER_RUNTIME_ADAPTER_VERSION = 'chronasense-runtime-v1';

const ENVELOPE_KEYS = new Set(['schemaVersion', 'records']);
const VALID_SOURCE_OPERATIONS = new Set(['create', 'delete', 'restore']);

export class LifeLedgerRuntimeStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'LifeLedgerRuntimeStoreError';
    this.code = code;
    if (options.errors) this.errors = options.errors.slice();
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultStorage() {
  if (globalThis.localStorage) return globalThis.localStorage;
  throw new LifeLedgerRuntimeStoreError('storage_unavailable', 'Life Ledger storage is unavailable');
}

function assertStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new LifeLedgerRuntimeStoreError('storage_unavailable', 'Life Ledger storage must implement getItem and setItem');
  }
}

function readRaw(storage, key) {
  try {
    return storage.getItem(key);
  } catch (err) {
    throw new LifeLedgerRuntimeStoreError('storage_read_failed', `Unable to read Life Ledger storage key ${key}`, { cause: err });
  }
}

function parseEnvelope(raw, key) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new LifeLedgerRuntimeStoreError('invalid_json', `Life Ledger storage key ${key} contains malformed JSON`, { cause: err });
  }
}

function validateEnvelope(envelope) {
  if (!isPlainObject(envelope)) {
    throw new LifeLedgerRuntimeStoreError('invalid_envelope', 'Life Ledger runtime envelope must be an object');
  }
  Object.keys(envelope).forEach(key => {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new LifeLedgerRuntimeStoreError('invalid_envelope', `Life Ledger runtime envelope field ${key} is not allowed`);
    }
  });
  if (envelope.schemaVersion !== LIFE_LEDGER_RUNTIME_SCHEMA_VERSION) {
    throw new LifeLedgerRuntimeStoreError(
      'unsupported_schema_version',
      `Unsupported Life Ledger runtime schemaVersion ${envelope.schemaVersion}`
    );
  }
  if (!Array.isArray(envelope.records)) {
    throw new LifeLedgerRuntimeStoreError('invalid_envelope', 'Life Ledger runtime records must be an array');
  }
}

function validateStoredRecord(record, index) {
  if (!isPlainObject(record)) {
    throw new LifeLedgerRuntimeStoreError('invalid_record', `Life Ledger record ${index} must be an object`);
  }
  if (typeof record.key !== 'string' || !record.key.trim()) {
    throw new LifeLedgerRuntimeStoreError('invalid_record', `Life Ledger record ${index} key must be a non-empty string`);
  }
  if (typeof record.fingerprint !== 'string' || !record.fingerprint.trim()) {
    throw new LifeLedgerRuntimeStoreError('invalid_record', `Life Ledger record ${index} fingerprint must be a non-empty string`);
  }
  const validation = validateLifeLedgerEvent(record.event);
  if (!validation.ok) {
    throw new LifeLedgerRuntimeStoreError(
      'invalid_record',
      `Life Ledger record ${index} contains an invalid event`,
      { errors: validation.errors }
    );
  }
  const expectedKey = deriveLifeLedgerKey(record.event);
  if (record.key !== expectedKey) {
    throw new LifeLedgerRuntimeStoreError('invalid_record', `Life Ledger record ${index} key does not match event identity`);
  }
  const expectedFingerprint = fingerprintLifeLedgerEvent(record.event);
  if (record.fingerprint !== expectedFingerprint) {
    throw new LifeLedgerRuntimeStoreError('invalid_record', `Life Ledger record ${index} fingerprint does not match event facts`);
  }
  return {
    key: record.key,
    event: cloneJson(record.event),
    fingerprint: record.fingerprint
  };
}

function readEnvelope(storage, key) {
  const raw = readRaw(storage, key);
  if (raw === null) return { schemaVersion: LIFE_LEDGER_RUNTIME_SCHEMA_VERSION, records: [] };
  if (typeof raw !== 'string') {
    throw new LifeLedgerRuntimeStoreError('invalid_storage_value', `Life Ledger storage key ${key} must contain a string envelope or null`);
  }
  const envelope = parseEnvelope(raw, key);
  validateEnvelope(envelope);
  return {
    schemaVersion: LIFE_LEDGER_RUNTIME_SCHEMA_VERSION,
    records: envelope.records.map(validateStoredRecord)
  };
}

function writeEnvelope(storage, key, records) {
  const envelope = {
    schemaVersion: LIFE_LEDGER_RUNTIME_SCHEMA_VERSION,
    records: records.map(validateStoredRecord)
  };
  let serialized;
  try {
    serialized = JSON.stringify(envelope);
  } catch (err) {
    throw new LifeLedgerRuntimeStoreError('serialization_failed', 'Unable to serialize Life Ledger runtime state', { cause: err });
  }
  try {
    storage.setItem(key, serialized);
  } catch (err) {
    throw new LifeLedgerRuntimeStoreError('storage_write_failed', `Unable to write Life Ledger storage key ${key}`, { cause: err });
  }
  return envelope;
}

export function createLocalLifeLedgerStore(options = {}) {
  const storage = hasOwn(options, 'storage') ? options.storage : defaultStorage();
  const key = hasOwn(options, 'key') ? options.key : LIFE_LEDGER_RUNTIME_KEY;
  assertStorage(storage);
  if (typeof key !== 'string' || !key.trim()) {
    throw new LifeLedgerRuntimeStoreError('invalid_key', 'Life Ledger storage key must be a non-empty string');
  }

  function memoryStore() {
    return createLifeLedgerMemoryStore(readEnvelope(storage, key).records);
  }

  return {
    key,
    listRecords() {
      return memoryStore().listRecords();
    },
    listEvents() {
      return memoryStore().listEvents();
    },
    getByKey(logicalKey) {
      if (typeof logicalKey !== 'string' || !logicalKey.trim()) {
        throw new LifeLedgerRuntimeStoreError('invalid_key', 'Life Ledger logical key must be a non-empty string');
      }
      return memoryStore().getByKey(logicalKey);
    },
    upsertEvent(draft, upsertOptions = {}) {
      const store = memoryStore();
      const result = upsertLifeLedgerEvent(store, draft, upsertOptions);
      if (result.action === 'rejected') {
        throw new LifeLedgerRuntimeStoreError(
          'upsert_rejected',
          `Life Ledger event was rejected: ${result.reason}`,
          { errors: result.errors || [] }
        );
      }
      if (result.action !== 'unchanged') writeEnvelope(storage, key, store.listRecords());
      return result;
    }
  };
}

function defaultRuntimeStore() {
  return createLocalLifeLedgerStore();
}

function normalizeIsoInstant(value) {
  const date = value instanceof Date ? value : new Date(value);
  const ts = date.getTime();
  if (!Number.isFinite(ts)) throw new LifeLedgerRuntimeStoreError('invalid_timestamp', 'Life Ledger timestamp must be a valid instant');
  return new Date(ts).toISOString();
}

function resolveSourceTimezone(explicitTimezone) {
  const candidates = [
    explicitTimezone,
    globalThis.settings?.timezone,
    globalThis.localStorage?.getItem?.('ta3-tz'),
    globalThis.Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone
  ];
  for (const candidate of candidates) {
    const timezone = String(candidate || '').trim();
    if (!timezone) continue;
    const normalized = timezone === 'UTC' ? 'Etc/UTC' : timezone;
    if (!normalized.includes('/')) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date(0));
      return normalized;
    } catch {
      // Try the next available source of timezone context.
    }
  }
  throw new LifeLedgerRuntimeStoreError('missing_source_timezone', 'Life Ledger source timezone is unavailable');
}

function dateKeyForIso(isoInstant, sourceTimezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: sourceTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(isoInstant));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function inactiveTombstone() {
  return { active: false, deletedAt: null, reason: null, provenance: null };
}

function observedAt(options = {}) {
  return normalizeIsoInstant(typeof options.clock === 'function' ? options.clock() : new Date());
}

function compactSource(source) {
  return Object.keys(source).reduce((out, key) => {
    const value = source[key];
    if (value != null && value !== '') out[key] = value;
    return out;
  }, {});
}

function findStepContext(plan, stepId) {
  for (const phase of plan?.phases || []) {
    for (const lesson of phase?.lessons || []) {
      const step = lesson?.steps?.find(item => item.id === stepId);
      if (step) return { plan, phase, lesson, step };
    }
  }
  return null;
}

export function learningPlanStepSourceEntityId(planId, stepId) {
  const normalizedPlanId = String(planId || '').trim();
  const normalizedStepId = String(stepId || '').trim();
  if (!normalizedPlanId) throw new LifeLedgerRuntimeStoreError('missing_plan_id', 'Learning Plan id is required');
  if (!normalizedStepId) throw new LifeLedgerRuntimeStoreError('missing_step_id', 'Learning Plan step id is required');
  return JSON.stringify([normalizedPlanId, normalizedStepId]);
}

function basePlanStepDraft(context, options = {}) {
  const sourceTimezone = resolveSourceTimezone(options.sourceTimezone);
  const completedAt = normalizeIsoInstant(context.step.completedAt);
  const sourceOperation = options.sourceOperation || 'create';
  if (!VALID_SOURCE_OPERATIONS.has(sourceOperation)) {
    throw new LifeLedgerRuntimeStoreError('invalid_source_operation', `Unsupported Life Ledger source operation ${sourceOperation}`);
  }
  return {
    schemaVersion: 1,
    sourceApp: 'chronasense',
    sourceEntityId: learningPlanStepSourceEntityId(context.plan.id, context.step.id),
    type: 'plan_step_completed',
    occurredAt: completedAt,
    sourceTimezone,
    payload: {
      planDate: dateKeyForIso(completedAt, sourceTimezone),
      stepLabel: context.step.title,
      completedAt,
      ...(options.trackedMinutes ? { trackedMinutes: options.trackedMinutes } : {}),
      source: compactSource({
        planId: context.plan.id,
        phaseId: context.phase.id,
        lessonId: context.lesson.id,
        stepId: context.step.id,
        planTitle: context.plan.title,
        phaseTitle: context.phase.title,
        lessonTitle: context.lesson.title,
        focusEntryId: options.focusOutcome?.focusEntryId,
        focusOutcomeId: options.focusOutcome?.outcomeId
      })
    },
    provenance: {
      source: 'chronasense',
      sourceRecordKind: 'chronasense.plan_step',
      adapterVersion: LIFE_LEDGER_RUNTIME_ADAPTER_VERSION,
      observedAt: observedAt(options),
      captureMethod: options.captureMethod || 'plan_toggle',
      sourceOperation,
      evidence: [
        `chronasense.learningPlan:${context.plan.id}`,
        `chronasense.plan_step:${context.step.id}`
      ]
    },
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: inactiveTombstone()
  };
}

function tombstonePlanStepDraft(context, options = {}) {
  const draft = basePlanStepDraft(context, {
    ...options,
    sourceOperation: 'delete',
    captureMethod: options.captureMethod || 'plan_toggle'
  });
  const deletedAt = observedAt(options);
  return {
    ...draft,
    tombstone: {
      active: true,
      deletedAt,
      reason: 'user_delete',
      provenance: {
        sourceOperation: 'delete',
        sourceRecordKind: 'chronasense.plan_step',
        evidence: [`chronasense.plan_step:${context.step.id}:reopened`]
      }
    }
  };
}

export function buildLearningPlanStepCompletedDraft(plan, stepId, options = {}) {
  const context = findStepContext(plan, stepId);
  if (!context) throw new LifeLedgerRuntimeStoreError('missing_step', `Learning Plan step ${stepId} was not found`);
  if (context.step.completed !== true || !context.step.completedAt) {
    throw new LifeLedgerRuntimeStoreError('step_not_completed', 'Learning Plan step must be completed before recording Life Ledger completion');
  }
  return basePlanStepDraft(context, options);
}

export function buildLearningPlanStepReopenedDraft(planBeforeReopen, stepId, options = {}) {
  const context = findStepContext(planBeforeReopen, stepId);
  if (!context) throw new LifeLedgerRuntimeStoreError('missing_step', `Learning Plan step ${stepId} was not found`);
  if (context.step.completed !== true || !context.step.completedAt) {
    throw new LifeLedgerRuntimeStoreError('step_not_completed', 'Learning Plan step must have a prior completion before Life Ledger reopen');
  }
  return tombstonePlanStepDraft(context, options);
}

export function buildLearningPlanFocusSessionCompletedDraft(outcome, options = {}) {
  const startedAt = normalizeIsoInstant(Number(outcome?.focusStartedAt || 0));
  const endedAt = normalizeIsoInstant(Number(outcome?.focusEndedAt || 0));
  const durationMinutes = Number(outcome?.focusDurationMin || 0);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new LifeLedgerRuntimeStoreError('invalid_duration', 'Focus duration must be a positive number');
  }
  const sourceEntityId = String(outcome?.focusEntryId || '').trim();
  if (!sourceEntityId) throw new LifeLedgerRuntimeStoreError('missing_source_id', 'Focus entry id is required');
  const sourceTimezone = resolveSourceTimezone(options.sourceTimezone);
  const activity = String(outcome.focusActivity || outcome.stepTitle || '').trim() || 'Focus session';
  return {
    schemaVersion: 1,
    sourceApp: 'chronasense',
    sourceEntityId,
    type: 'focus_session_completed',
    occurredAt: endedAt,
    sourceTimezone,
    payload: {
      activity,
      startedAt,
      endedAt,
      durationMinutes,
      onPlan: true,
      additiveForTimeTotals: false,
      source: compactSource({
        planId: outcome.planId,
        phaseId: outcome.phaseId,
        lessonId: outcome.lessonId,
        stepId: outcome.stepId,
        focusEntryId: outcome.focusEntryId
      })
    },
    provenance: {
      source: 'chronasense',
      sourceRecordKind: 'chronasense.focus_outcome',
      adapterVersion: LIFE_LEDGER_RUNTIME_ADAPTER_VERSION,
      observedAt: observedAt(options),
      captureMethod: 'pomodoro',
      sourceOperation: 'create',
      evidence: [
        ...(outcome.outcomeId ? [`chronasense.focus_outcome:${outcome.outcomeId}`] : []),
        `chronasense.entry:${outcome.focusEntryId}`,
        `chronasense.plan_step:${outcome.stepId}`
      ]
    },
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: inactiveTombstone()
  };
}

export function recordLearningPlanFocusSessionCompleted(outcome, options = {}) {
  const store = options.store || defaultRuntimeStore();
  return store.upsertEvent(buildLearningPlanFocusSessionCompletedDraft(outcome, options), options);
}

export function recordLearningPlanStepCompleted(plan, stepId, options = {}) {
  const store = options.store || defaultRuntimeStore();
  const baseDraft = buildLearningPlanStepCompletedDraft(plan, stepId, options);
  const existing = store.getByKey(deriveLifeLedgerKey(baseDraft));
  const draft = existing?.event?.tombstone?.active
    ? { ...baseDraft, provenance: { ...baseDraft.provenance, sourceOperation: 'restore' } }
    : baseDraft;
  return store.upsertEvent(draft, options);
}

export function recordLearningPlanStepReopened(planBeforeReopen, stepId, options = {}) {
  const store = options.store || defaultRuntimeStore();
  return store.upsertEvent(buildLearningPlanStepReopenedDraft(planBeforeReopen, stepId, options), options);
}
