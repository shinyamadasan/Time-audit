import {
  CAPABILITY_PROFILE_SCHEMA_VERSION,
  createEmptyCapabilityProfile,
  hydrateCapabilityProfile
} from './capability-career-model.js';

export const CAPABILITY_CAREER_REPOSITORY_KEY = 'ta3-capability-career-v1';
export const CAPABILITY_CAREER_REPOSITORY_SCHEMA_VERSION = 1;

const ENVELOPE_KEYS = new Set(['schemaVersion', 'profile']);

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
  throw new CapabilityCareerRepositoryError('storage_unavailable', 'Capability/Career storage is unavailable');
}

export class CapabilityCareerRepositoryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'CapabilityCareerRepositoryError';
    this.code = code;
    if (options.errors) this.errors = options.errors.slice();
  }
}

function assertStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new CapabilityCareerRepositoryError('storage_unavailable', 'Capability/Career storage must implement getItem and setItem');
  }
}

function assertKey(key) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new CapabilityCareerRepositoryError('invalid_key', 'Capability/Career storage key must be a non-empty string');
  }
}

function readRaw(storage, key) {
  try {
    return storage.getItem(key);
  } catch (err) {
    throw new CapabilityCareerRepositoryError('storage_read_failed', `Unable to read Capability/Career storage key ${key}`, { cause: err });
  }
}

function parseEnvelope(raw, key) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CapabilityCareerRepositoryError('invalid_json', `Capability/Career storage key ${key} contains malformed JSON`, { cause: err });
  }
}

function validateEnvelope(envelope) {
  if (!isPlainObject(envelope)) {
    throw new CapabilityCareerRepositoryError('invalid_envelope', 'Capability/Career repository envelope must be an object');
  }
  Object.keys(envelope).forEach(key => {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new CapabilityCareerRepositoryError('invalid_envelope', `Capability/Career repository envelope field ${key} is not allowed`);
    }
  });
  if (envelope.schemaVersion !== CAPABILITY_CAREER_REPOSITORY_SCHEMA_VERSION) {
    throw new CapabilityCareerRepositoryError(
      'unsupported_schema_version',
      `Unsupported Capability/Career repository schemaVersion ${envelope.schemaVersion}`
    );
  }
  if (!hasOwn(envelope, 'profile')) {
    throw new CapabilityCareerRepositoryError('invalid_envelope', 'Capability/Career repository envelope profile is required');
  }
}

function readEnvelope(storage, key, options = {}) {
  const raw = readRaw(storage, key);
  if (raw === null) {
    return {
      schemaVersion: CAPABILITY_CAREER_REPOSITORY_SCHEMA_VERSION,
      profile: createEmptyCapabilityProfile(options)
    };
  }
  if (typeof raw !== 'string') {
    throw new CapabilityCareerRepositoryError('invalid_storage_value', `Capability/Career storage key ${key} must contain a string envelope or null`);
  }
  const envelope = parseEnvelope(raw, key);
  validateEnvelope(envelope);
  try {
    return {
      schemaVersion: CAPABILITY_CAREER_REPOSITORY_SCHEMA_VERSION,
      profile: hydrateCapabilityProfile(envelope.profile)
    };
  } catch (err) {
    throw new CapabilityCareerRepositoryError('invalid_profile', `Invalid Capability/Career profile: ${err.message}`, { cause: err });
  }
}

function writeEnvelope(storage, key, profile) {
  const hydrated = hydrateCapabilityProfile(profile);
  const envelope = {
    schemaVersion: CAPABILITY_CAREER_REPOSITORY_SCHEMA_VERSION,
    profile: hydrated
  };
  let serialized;
  try {
    serialized = JSON.stringify(envelope);
  } catch (err) {
    throw new CapabilityCareerRepositoryError('serialization_failed', 'Unable to serialize Capability/Career repository state', { cause: err });
  }
  try {
    storage.setItem(key, serialized);
  } catch (err) {
    throw new CapabilityCareerRepositoryError('storage_write_failed', `Unable to write Capability/Career storage key ${key}`, { cause: err });
  }
  return cloneJson(envelope);
}

export function createCapabilityCareerRepository(options = {}) {
  const storage = hasOwn(options, 'storage') ? options.storage : defaultStorage();
  const key = hasOwn(options, 'key') ? options.key : CAPABILITY_CAREER_REPOSITORY_KEY;
  assertStorage(storage);
  assertKey(key);

  return {
    key,
    loadProfile() {
      return readEnvelope(storage, key, options).profile;
    },
    saveProfile(profile) {
      return writeEnvelope(storage, key, profile).profile;
    }
  };
}

export const CAPABILITY_CAREER_REPOSITORY_V1 = Object.freeze({
  schemaVersion: CAPABILITY_CAREER_REPOSITORY_SCHEMA_VERSION,
  profileSchemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
  key: CAPABILITY_CAREER_REPOSITORY_KEY
});
