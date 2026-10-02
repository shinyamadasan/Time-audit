// brain-dump-repository.js
//
// Durable local storage for Brain Dump captures. Mirrors commitments-repository.js's
// shape and invariants deliberately — same envelope-with-schemaVersion, same
// validate-before-write, same mergeRemote seam, same per-room cache scoping — so
// there is one storage idiom in this codebase rather than one more that drifts.
//
// Storage key: 'ta3-brain-dump-v1'
// Envelope:    { schemaVersion: 1, captures: { <captureId>: CaptureRecord } }
//
// Keyed by capture id only. There is no day index, no status bucket — status is a
// field on the record, and every list view (untriaged/triaged/disposed) is a pure
// filter over the same map (brain-dump-model.js's selectors).
//
// ── account scoping (same discipline as Cross-Store Account Isolation V1) ───
//
// The cache is a copy of ONE account's captures (rooms/<room>/brainDump), stored
// per room exactly like commitments: the slot for the joined room `uid_A` is
// `ta3-brain-dump-v1:uid_A`. The owner comes from the same canonical source every
// other account-scoped store uses (personal-day-boundary-repository.js's
// appRoomOwner) — not a second identity system. With no room joined there is NO
// active cache: reads are empty and writes are refused ({ok:false, reason:'no-account'}).
//
// A repository built without `getOwner` over an INJECTED storage is "plain": one
// unowned slot at `key`, for tests of the capture semantics themselves. One built
// over the real localStorage is always scoped to the app's joined room.

import {
  BRAIN_DUMP_SCHEMA_VERSION,
  buildCapture,
  triageCapture,
  promoteCapture,
  archiveCapture,
  delegateCapture,
  mergeCaptureRecords,
  validBrainDumpId,
} from './brain-dump-model.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';

export const BRAIN_DUMP_STORAGE_KEY = 'ta3-brain-dump-v1';

/** The storage slot holding ONE room's cache: `<key>:<roomId>`. */
export function brainDumpCacheKeyForRoom(roomId, key = BRAIN_DUMP_STORAGE_KEY) {
  return `${key}:${roomId}`;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultStorage() {
  if (globalThis.localStorage) return globalThis.localStorage;
  throw new Error('Brain Dump storage is unavailable.');
}

function readEnvelope(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return { schemaVersion: BRAIN_DUMP_SCHEMA_VERSION, captures: {} };
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`Brain Dump storage key ${key} contains malformed JSON.`);
  }
  if (!isPlainObject(envelope) || envelope.schemaVersion !== BRAIN_DUMP_SCHEMA_VERSION || !isPlainObject(envelope.captures)) {
    throw new Error('Brain Dump storage has an unsupported format or schema version.');
  }
  Object.keys(envelope.captures).forEach(id => {
    if (!validBrainDumpId(id)) throw new Error(`Brain Dump storage has an invalid capture id key: ${id}`);
  });
  return envelope;
}

function writeEnvelope(storage, key, captures) {
  storage.setItem(key, JSON.stringify({ schemaVersion: BRAIN_DUMP_SCHEMA_VERSION, captures }));
}

/** Default id minter: 'b' + base36 time + base36 randomness. Opaque, immutable,
 *  Firebase-key-safe, and never derived from the text — identical idiom to
 *  commitments-repository.js's defaultIdGenerator. Concurrent identical captures
 *  (same text, same millisecond) still mint distinct ids because of the random
 *  suffix. */
function defaultIdGenerator(now) {
  return `b${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createBrainDumpRepository(deps = {}) {
  const storage = deps.storage || defaultStorage();
  const baseKey = deps.key || BRAIN_DUMP_STORAGE_KEY;
  const getOwner = typeof deps.getOwner === 'function' ? deps.getOwner : (deps.storage ? null : appRoomOwner);
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const deviceId = typeof deps.deviceId === 'function' ? deps.deviceId : () => 'unknown-device';
  const idGenerator = typeof deps.idGenerator === 'function' ? deps.idGenerator : defaultIdGenerator;

  /** Whose cache is active right now, or null (plain repository, or no room joined). */
  function ownerRoomId() {
    if (!getOwner) return null;
    const owner = getOwner();
    return typeof owner === 'string' && owner ? owner : null;
  }

  /** The active storage slot, or null when there is NO active cache. */
  function activeKey() {
    if (!getOwner) return baseKey;
    const owner = ownerRoomId();
    return owner ? brainDumpCacheKeyForRoom(owner, baseKey) : null;
  }

  // `key` is resolved ONCE by the caller, so a read-modify-write never spans two slots.
  function persist(key, record) {
    const envelope = readEnvelope(storage, key);
    writeEnvelope(storage, key, { ...envelope.captures, [record.id]: record });
    return record;
  }

  function readIn(key, id) {
    return readEnvelope(storage, key).captures[id] || null;
  }

  const NO_ACCOUNT = Object.freeze({ ok: false, reason: 'no-account' });

  return {
    key: baseKey,

    /** The room whose cache is active, or null. The sync bridge refuses to push or
     *  merge unless this equals the room it is talking to. */
    ownerRoomId,

    /** Unknown id -> null. No implicit fallback, no implicit migration. */
    read(id) {
      if (!validBrainDumpId(id)) throw new Error('A valid capture id is required.');
      const key = activeKey();
      if (key === null) return null;
      return readIn(key, id);
    },

    /** Every locally known capture, any status — the shape sync and every list
     *  selector (untriaged/triaged/disposed) both read. */
    listAllRaw() {
      const key = activeKey();
      if (key === null) return {};
      return { ...readEnvelope(storage, key).captures };
    },

    /** Mints an id and writes a new untriaged capture. Capture is deliberately
     *  minimal — see brain-dump-model.js's buildCapture.
     *  @returns {{ok:true, record:object} | {ok:false, reason:string, ...}} */
    create(input = {}) {
      const key = activeKey();
      if (key === null) return NO_ACCOUNT;
      const at = Number.isFinite(input.now) ? input.now : now();
      const built = buildCapture({
        ...input,
        id: input.id || idGenerator(at),
        now: at,
        updatedBy: input.updatedBy || deviceId(),
      });
      if (!built.ok) return built;
      return { ok: true, record: persist(key, built.record) };
    },

    /** Records the Eisenhower classification. Never promotes, never archives —
     *  see brain-dump-model.js's triageCapture for the exact status rule. */
    triage(id, patch = {}) {
      if (!validBrainDumpId(id)) return { ok: false, reason: 'invalid-input', field: 'id' };
      const key = activeKey();
      if (key === null) return NO_ACCOUNT;
      const current = readIn(key, id);
      if (!current) return { ok: false, reason: 'not-found' };
      const result = triageCapture(current, {
        ...patch,
        now: Number.isFinite(patch.now) ? patch.now : now(),
        updatedBy: patch.updatedBy || deviceId(),
      });
      if (!result.ok) return result;
      return { ok: true, record: persist(key, result.record) };
    },

    /** Idempotent: a capture already promoted/archived/delegated is returned as
     *  `{ok:false, reason:'already-disposed', record}` rather than erroring or
     *  double-disposing — callers (the UI promotion flow) use that to recognize a
     *  retried action and avoid writing a second plan item. */
    promote(id, { promotion, now: at, updatedBy } = {}) {
      if (!validBrainDumpId(id)) return { ok: false, reason: 'invalid-input', field: 'id' };
      const key = activeKey();
      if (key === null) return NO_ACCOUNT;
      const current = readIn(key, id);
      if (!current) return { ok: false, reason: 'not-found' };
      const result = promoteCapture(current, { promotion, now: Number.isFinite(at) ? at : now(), updatedBy: updatedBy || deviceId() });
      if (!result.ok) return result;
      return { ok: true, record: persist(key, result.record) };
    },

    archive(id, { now: at, updatedBy } = {}) {
      if (!validBrainDumpId(id)) return { ok: false, reason: 'invalid-input', field: 'id' };
      const key = activeKey();
      if (key === null) return NO_ACCOUNT;
      const current = readIn(key, id);
      if (!current) return { ok: false, reason: 'not-found' };
      const result = archiveCapture(current, { now: Number.isFinite(at) ? at : now(), updatedBy: updatedBy || deviceId() });
      if (!result.ok) return result;
      return { ok: true, record: persist(key, result.record) };
    },

    delegate(id, { delegatedTo, now: at, updatedBy } = {}) {
      if (!validBrainDumpId(id)) return { ok: false, reason: 'invalid-input', field: 'id' };
      const key = activeKey();
      if (key === null) return NO_ACCOUNT;
      const current = readIn(key, id);
      if (!current) return { ok: false, reason: 'not-found' };
      const result = delegateCapture(current, { delegatedTo, now: Number.isFinite(at) ? at : now(), updatedBy: updatedBy || deviceId() });
      if (!result.ok) return result;
      return { ok: true, record: persist(key, result.record) };
    },

    /** Sync-only: merges ONE inbound remote record via mergeCaptureRecords
     *  (per-record LWW with a canonical tie-break), never a store-wide replace.
     *  A remote payload that does not normalize is ignored rather than stored —
     *  a malformed peer must not be able to corrupt local truth. */
    mergeRemote(id, remoteRecord) {
      if (!validBrainDumpId(id)) throw new Error('A valid capture id is required.');
      const key = activeKey();
      if (key === null) return { changed: false, record: null };
      const envelope = readEnvelope(storage, key);
      const local = envelope.captures[id] || null;
      const merged = mergeCaptureRecords(local, remoteRecord);
      if (!merged || merged.id !== id) return { changed: false, record: local };
      const changed = JSON.stringify(local) !== JSON.stringify(merged);
      if (changed) writeEnvelope(storage, key, { ...envelope.captures, [id]: merged });
      return { changed, record: merged };
    },
  };
}

// A ready-to-use singleton for the real app only — constructing it touches
// localStorage, which does not exist under plain `node --test`. Same guard as
// commitments-repository.js's consumers; tests build their own repository with an
// in-memory storage object.
if (typeof window !== 'undefined') {
  window.BrainDumpRepository = createBrainDumpRepository({
    deviceId: () => globalThis.syncedDeviceId || 'unknown-device',
  });
}
