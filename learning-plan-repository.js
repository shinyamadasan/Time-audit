import { hydrateLearningPlan } from './learning-plan-model.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';

export const LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION = 1;
export const LEARNING_PLAN_REPOSITORY_KEY = 'ta3-learning-plans-v1';

const ENVELOPE_KEYS = new Set(['schemaVersion', 'plans']);

/** The storage slot holding ONE room's Learning Plans: `<key>:<roomId>` (Device-Local Account
 *  Isolation V1). The pre-scoping bare key carries no owner and is quarantined: never read. */
export function learningPlanKeyForRoom(roomId, key = LEARNING_PLAN_REPOSITORY_KEY) {
  return `${key}:${roomId}`;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export class LearningPlanRepositoryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'LearningPlanRepositoryError';
    this.code = code;
    if (options.errors) this.errors = options.errors.slice();
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function defaultStorage() {
  if (globalThis.localStorage) return globalThis.localStorage;
  throw new LearningPlanRepositoryError('storage_unavailable', 'Learning Plan storage is unavailable');
}

function assertStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new LearningPlanRepositoryError('storage_unavailable', 'Learning Plan storage must implement getItem and setItem');
  }
}

function assertPlanId(planId) {
  if (typeof planId !== 'string' || !planId.trim()) {
    throw new LearningPlanRepositoryError('invalid_plan_id', 'Learning Plan id must be a non-empty string');
  }
}

function readRaw(storage, key) {
  try {
    return storage.getItem(key);
  } catch (err) {
    throw new LearningPlanRepositoryError('storage_read_failed', `Unable to read Learning Plan storage key ${key}`, { cause: err });
  }
}

function parseEnvelope(raw, key) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new LearningPlanRepositoryError('invalid_json', `Learning Plan storage key ${key} contains malformed JSON`, { cause: err });
  }
}

function validateEnvelopeShape(envelope) {
  if (!isPlainObject(envelope)) {
    throw new LearningPlanRepositoryError('invalid_envelope', 'Learning Plan repository envelope must be an object');
  }
  Object.keys(envelope).forEach(key => {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new LearningPlanRepositoryError('invalid_envelope', `Learning Plan repository envelope field ${key} is not allowed`);
    }
  });
  if (envelope.schemaVersion !== LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION) {
    throw new LearningPlanRepositoryError(
      'unsupported_schema_version',
      `Unsupported Learning Plan repository schemaVersion ${envelope.schemaVersion}`
    );
  }
  if (!Array.isArray(envelope.plans)) {
    throw new LearningPlanRepositoryError('invalid_envelope', 'Learning Plan repository envelope plans must be an array');
  }
}

function hydratePlans(plans) {
  const seenPlanIds = new Set();
  return plans.map((plan, index) => {
    let hydrated;
    try {
      hydrated = hydrateLearningPlan(plan);
    } catch (err) {
      throw new LearningPlanRepositoryError('invalid_plan', `Invalid Learning Plan at plans[${index}]: ${err.message}`, { cause: err });
    }
    if (seenPlanIds.has(hydrated.id)) {
      throw new LearningPlanRepositoryError('duplicate_plan_id', `Duplicate Learning Plan id ${hydrated.id}`);
    }
    seenPlanIds.add(hydrated.id);
    return hydrated;
  });
}

function readEnvelope(storage, key) {
  const raw = readRaw(storage, key);
  if (raw === null) {
    return { schemaVersion: LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION, plans: [] };
  }
  if (typeof raw !== 'string') {
    throw new LearningPlanRepositoryError(
      'invalid_storage_value',
      `Learning Plan storage key ${key} must contain a string envelope or null`
    );
  }
  const envelope = parseEnvelope(raw, key);
  validateEnvelopeShape(envelope);
  return {
    schemaVersion: LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION,
    plans: hydratePlans(envelope.plans)
  };
}

function writeEnvelope(storage, key, plans) {
  const envelope = {
    schemaVersion: LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION,
    plans: hydratePlans(plans)
  };
  let serialized;
  try {
    serialized = JSON.stringify(envelope);
  } catch (err) {
    throw new LearningPlanRepositoryError('serialization_failed', 'Unable to serialize Learning Plan repository state', { cause: err });
  }
  try {
    storage.setItem(key, serialized);
  } catch (err) {
    throw new LearningPlanRepositoryError('storage_write_failed', `Unable to write Learning Plan storage key ${key}`, { cause: err });
  }
  return envelope;
}

export function createLearningPlanRepository(options = {}) {
  const storage = hasOwn(options, 'storage') ? options.storage : defaultStorage();
  const baseKey = hasOwn(options, 'key') ? options.key : LEARNING_PLAN_REPOSITORY_KEY;
  assertStorage(storage);
  assertPlanId(baseKey);
  // Scoped when told who the owner is, or when running over the real localStorage (same rule as
  // the coarse-evidence repository): the owner is the joined room, re-resolved on EVERY call.
  const getOwner = typeof options.getOwner === 'function' ? options.getOwner : (hasOwn(options, 'storage') ? null : appRoomOwner);

  /** The room whose Learning Plans are active, or null (plain repository, or no room joined). */
  function ownerRoomId() {
    if (!getOwner) return null;
    const owner = getOwner();
    return typeof owner === 'string' && owner ? owner : null;
  }

  /** The active slot, or null when no account owns local state (signed out / auth pending). */
  function activeKey() {
    if (!getOwner) return baseKey;
    const owner = ownerRoomId();
    return owner ? learningPlanKeyForRoom(owner, baseKey) : null;
  }

  function readActive() {
    const key = activeKey();
    return key === null ? { schemaVersion: LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION, plans: [] } : readEnvelope(storage, key);
  }

  function requireActiveKey() {
    const key = activeKey();
    if (key === null) throw new LearningPlanRepositoryError('no_account', 'No signed-in account owns Learning Plans on this device. Nothing was saved.');
    return key;
  }

  return {
    ownerRoomId,

    listPlans() {
      return readActive().plans;
    },

    getPlan(planId) {
      assertPlanId(planId);
      return readActive().plans.find(plan => plan.id === planId) || null;
    },

    savePlan(plan) {
      let hydrated;
      try {
        hydrated = hydrateLearningPlan(plan);
      } catch (err) {
        throw new LearningPlanRepositoryError('invalid_plan', `Invalid Learning Plan: ${err.message}`, { cause: err });
      }

      const key = requireActiveKey();
      const current = readEnvelope(storage, key).plans;
      const existingIndex = current.findIndex(existing => existing.id === hydrated.id);
      const next = existingIndex === -1
        ? [...current, hydrated]
        : current.map((existing, index) => index === existingIndex ? hydrated : existing);
      writeEnvelope(storage, key, next);
      return hydrateLearningPlan(hydrated);
    },

    removePlan(planId) {
      assertPlanId(planId);
      const key = requireActiveKey();
      const current = readEnvelope(storage, key).plans;
      const next = current.filter(plan => plan.id !== planId);
      const removed = next.length !== current.length;
      if (removed) writeEnvelope(storage, key, next);
      return { removed, planId };
    }
  };
}
