// functions/src/config.js
//
// Validates the backend's named configuration. Values come from Firebase params/Secret Manager at runtime
// (see functions/README.md); none are ever committed. Every check fails closed: a malformed value means the
// API refuses all calls rather than guessing.

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_KEY = /^(?:[0-9a-f]{2}){32,128}$/;
const DATABASE_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)$/;

export class ConfigError extends Error {}

/** `{"<keyId>":"<lowercase hex, 32-128 random bytes>", ...}` — more than one entry only during a rotation. */
export function parseHmacKeys(secretJson) {
  let parsed;
  try { parsed = JSON.parse(secretJson); } catch { throw new ConfigError('CHRONASENSE_WORKER_HMAC_KEYS is not JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError('CHRONASENSE_WORKER_HMAC_KEYS must be an object');
  const keys = new Map();
  for (const [keyId, hex] of Object.entries(parsed)) {
    if (!KEY_ID.test(keyId) || typeof hex !== 'string' || !HEX_KEY.test(hex)) throw new ConfigError('CHRONASENSE_WORKER_HMAC_KEYS has a malformed entry');
    keys.set(keyId, Buffer.from(hex, 'hex'));
  }
  if (!keys.size) throw new ConfigError('CHRONASENSE_WORKER_HMAC_KEYS is empty');
  return keys;
}

export function parseDatabaseUrl(value) {
  if (typeof value !== 'string' || !DATABASE_URL.test(value)) throw new ConfigError('CHRONASENSE_RTDB_URL must be the https origin of the Realtime Database');
  return value;
}

export function requireValue(name, value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new ConfigError(`${name} is not configured`);
  return value;
}
