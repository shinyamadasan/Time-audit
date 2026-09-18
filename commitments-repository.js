// commitments-repository.js
//
// Durable local storage for canonical scheduled commitments. Mirrors
// operational-plan-repository.js's shape and invariants deliberately — same
// envelope-with-schemaVersion, same "no implicit migration", same
// validate-before-write, same mergeRemote seam — so there is one storage idiom in
// this codebase rather than two that drift.
//
// Storage key: 'ta3-commitments-v1'
// Envelope:    { schemaVersion: 1, commitments: { <commitmentId>: CommitmentRecord } }
//
// Keyed by commitment id and NOTHING else. There is deliberately no day index, no
// date bucket and no per-day subtree: any such key would be a second answer to
// "when is this?" that a boundary change could invalidate. The personal day a
// commitment belongs to is always derived on read (commitments-model.js's
// projectCommitment), never persisted.

import {
  COMMITMENT_SCHEMA_VERSION,
  buildCommitment,
  updateCommitment,
  deleteCommitment,
  normalizeCommitment,
  mergeCommitmentRecords,
  validCommitmentId,
} from './commitments-model.js';

export const COMMITMENTS_STORAGE_KEY = 'ta3-commitments-v1';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultStorage() {
  if (globalThis.localStorage) return globalThis.localStorage;
  throw new Error('Commitment storage is unavailable.');
}

function readEnvelope(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return { schemaVersion: COMMITMENT_SCHEMA_VERSION, commitments: {} };
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`Commitment storage key ${key} contains malformed JSON.`);
  }
  if (!isPlainObject(envelope) || envelope.schemaVersion !== COMMITMENT_SCHEMA_VERSION || !isPlainObject(envelope.commitments)) {
    throw new Error('Commitment storage has an unsupported format or schema version.');
  }
  Object.keys(envelope.commitments).forEach(id => {
    if (!validCommitmentId(id)) throw new Error(`Commitment storage has an invalid commitment id key: ${id}`);
  });
  return envelope;
}

function writeEnvelope(storage, key, commitments) {
  storage.setItem(key, JSON.stringify({ schemaVersion: COMMITMENT_SCHEMA_VERSION, commitments }));
}

/** Default id minter: 'c' + base36 time + base36 randomness. Opaque, immutable,
 *  and free of every Firebase-forbidden key character, so the same string is the
 *  local key AND the remote key with no encoding step. Never derived from the
 *  title or the date — both are editable, and identity must survive an edit. */
function defaultIdGenerator(now) {
  return `c${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createCommitmentsRepository(deps = {}) {
  const storage = deps.storage || defaultStorage();
  const key = deps.key || COMMITMENTS_STORAGE_KEY;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const deviceId = typeof deps.deviceId === 'function' ? deps.deviceId : () => 'unknown-device';
  const idGenerator = typeof deps.idGenerator === 'function' ? deps.idGenerator : defaultIdGenerator;

  function persist(record) {
    const envelope = readEnvelope(storage, key);
    writeEnvelope(storage, key, { ...envelope.commitments, [record.id]: record });
    return record;
  }

  return {
    key,

    /** Unknown id -> null. No implicit fallback, no implicit migration. */
    read(id) {
      if (!validCommitmentId(id)) throw new Error('A valid commitment id is required.');
      const envelope = readEnvelope(storage, key);
      return envelope.commitments[id] || null;
    },

    /** Every locally known commitment, tombstones included — the shape sync and
     *  the recovery/Upcoming projections both read. */
    listAllRaw() {
      return { ...readEnvelope(storage, key).commitments };
    },

    /** Mints an id and writes a new commitment. Returns the model's own
     *  {ok:false, reason} verbatim on refusal — notably `ambiguous` and
     *  `nonexistent` for DST anomalies, which the caller must resolve with an
     *  explicit choice rather than have resolved for it. Nothing is persisted
     *  unless the record is fully valid.
     *  @returns {{ok:true, record:object} | {ok:false, reason:string, ...}} */
    create(input = {}) {
      const at = Number.isFinite(input.now) ? input.now : now();
      const built = buildCommitment({
        ...input,
        id: input.id || idGenerator(at),
        now: at,
        updatedBy: input.updatedBy || deviceId(),
      });
      if (!built.ok) return built;
      return { ok: true, record: persist(built.record) };
    },

    /** Edits in place on the same id. startMs is re-resolved from the resulting
     *  civil fields, so an authored change moves the appointment and nothing else
     *  can. */
    update(id, patch = {}) {
      if (!validCommitmentId(id)) return { ok: false, reason: 'invalid-input', field: 'id' };
      const current = this.read(id);
      if (!current) return { ok: false, reason: 'not-found' };
      const result = updateCommitment(current, {
        ...patch,
        now: Number.isFinite(patch.now) ? patch.now : now(),
        updatedBy: patch.updatedBy || deviceId(),
      });
      if (!result.ok) return result;
      return { ok: true, record: persist(result.record) };
    },

    /** Tombstones. Never removes the key: a hard delete would be resurrected by
     *  the next inbound merge from any device that still has the record. */
    remove(id, options = {}) {
      if (!validCommitmentId(id)) return { ok: false, reason: 'invalid-input', field: 'id' };
      const current = this.read(id);
      if (!current) return { ok: false, reason: 'not-found' };
      const result = deleteCommitment(current, {
        now: Number.isFinite(options.now) ? options.now : now(),
        updatedBy: options.updatedBy || deviceId(),
      });
      if (!result.ok) return result;
      return { ok: true, record: persist(result.record) };
    },

    /** Restores a tombstoned commitment by clearing the tombstone through the
     *  ordinary update path, so it converges like any other later edit. */
    restore(id, options = {}) {
      if (!validCommitmentId(id)) return { ok: false, reason: 'invalid-input', field: 'id' };
      const current = this.read(id);
      if (!current) return { ok: false, reason: 'not-found' };
      const at = Number.isFinite(options.now) ? options.now : now();
      const normalized = normalizeCommitment(current);
      if (!normalized) return { ok: false, reason: 'invalid-input', field: 'record' };
      const { deleted, ...rest } = normalized;
      void deleted;
      return { ok: true, record: persist({ ...rest, updatedAt: at, updatedBy: options.updatedBy || deviceId() }) };
    },

    /** Sync-only: merges ONE inbound remote record via mergeCommitmentRecords
     *  (per-record LWW with a canonical tie-break), never a store-wide replace.
     *  A remote payload that does not normalize is ignored rather than stored —
     *  a malformed peer must not be able to corrupt local truth. */
    mergeRemote(id, remoteRecord) {
      if (!validCommitmentId(id)) throw new Error('A valid commitment id is required.');
      const envelope = readEnvelope(storage, key);
      const local = envelope.commitments[id] || null;
      const merged = mergeCommitmentRecords(local, remoteRecord);
      if (!merged || merged.id !== id) return { changed: false, record: local };
      const changed = JSON.stringify(local) !== JSON.stringify(merged);
      if (changed) writeEnvelope(storage, key, { ...envelope.commitments, [id]: merged });
      return { changed, record: merged };
    },
  };
}

// A ready-to-use singleton for the real app only — constructing it touches
// localStorage, which does not exist under plain `node --test`. Same guard as
// operational-plan-repository.js's consumers; tests build their own repository
// with an in-memory storage object.
if (typeof window !== 'undefined') {
  window.CommitmentsRepository = createCommitmentsRepository({
    deviceId: () => globalThis.syncedDeviceId || 'unknown-device',
  });
}
