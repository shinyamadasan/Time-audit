// ChronaSense Coarse Life Evidence V1 (Phase 6H) — local repository.
//
// Local-only versioned storage, following the same pattern as
// daily-routines-repository.js / capability-career-repository.js (the established
// precedent for a small bounded feature store in this app — Learning Plans, Daily
// Routines and Capability/Career are all local-only, not Firebase-synced). See
// contracts/CHRONASENSE_EVIDENCE_CONTRACT_V1.md implementation-status for why this
// milestone does not add cross-device sync.
//
// Envelope shape: { schemaVersion, records: { [id]: CoarseEvidenceRecord } }.

import {
  COARSE_LIFE_EVIDENCE_KEY,
  COARSE_LIFE_EVIDENCE_SCHEMA_VERSION,
  COARSE_LIFE_EVIDENCE_RESOLUTION,
  COARSE_LIFE_EVIDENCE_MEASUREMENT,
  COARSE_LIFE_EVIDENCE_PROVENANCE,
  coarseEvidenceId,
  normalizeLabel,
  validateCoarseEvidenceRecord,
  getCoarseEvidenceForDate
} from './coarse-life-evidence-model.js';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function defaultStorage() {
  if (globalThis.localStorage) return globalThis.localStorage;
  throw new Error('Coarse life evidence storage is unavailable.');
}

function readEnvelope(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return { schemaVersion: COARSE_LIFE_EVIDENCE_SCHEMA_VERSION, records: {} };
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`Coarse life evidence storage key ${key} contains malformed JSON.`);
  }
  if (!isPlainObject(envelope) || envelope.schemaVersion !== COARSE_LIFE_EVIDENCE_SCHEMA_VERSION ||
      !isPlainObject(envelope.records)) {
    throw new Error('Coarse life evidence storage has an unsupported format.');
  }
  Object.entries(envelope.records).forEach(([id, record]) => {
    validateCoarseEvidenceRecord(record);
    if (record.id !== id) throw new Error('Coarse life evidence storage key/identity mismatch.');
  });
  return envelope;
}

function writeEnvelope(storage, key, envelope) {
  storage.setItem(key, JSON.stringify(envelope));
}

export function createCoarseEvidenceRepository(storage = defaultStorage(), key = COARSE_LIFE_EVIDENCE_KEY) {
  return {
    key,

    list() {
      return Object.values(readEnvelope(storage, key).records);
    },

    listForDate(date) {
      return getCoarseEvidenceForDate(this.list(), date);
    },

    get(id) {
      return readEnvelope(storage, key).records[id] || null;
    },

    // Deterministic replace-not-append upsert. Identity is (date, normalized label):
    // saving the same identity again — unchanged or with an edited duration — updates
    // that one record; it never creates an additive duplicate. `previousId` lets an
    // edit that changes the label or date merge cleanly into the new identity instead
    // of leaving a stale orphaned row under the old one.
    //
    // A rename/date-edit (previousId set and different from the computed identity)
    // must never silently absorb a genuinely different, already-existing record under
    // that identity — that would destroy an independent user assertion with no warning.
    // Only a plain "Add" (no previousId) is allowed to land on an existing identity;
    // that is the intended, documented same-identity replace behavior.
    save({ date, timezone, label, estimatedMinutes, previousId = null, now = Date.now() }) {
      const envelope = readEnvelope(storage, key);
      const cleanLabel = normalizeLabel(label);
      const nextId = coarseEvidenceId(date, cleanLabel);
      const existing = envelope.records[nextId];
      if (previousId && previousId !== nextId && existing) {
        throw new Error(`An activity named "${cleanLabel}" already exists for ${date}. Edit that activity instead, or choose a different label.`);
      }
      const createdAt = existing ? existing.createdAt : now;
      const record = validateCoarseEvidenceRecord({
        id: nextId,
        date,
        timezone,
        label: cleanLabel,
        estimatedMinutes,
        resolution: COARSE_LIFE_EVIDENCE_RESOLUTION,
        measurement: COARSE_LIFE_EVIDENCE_MEASUREMENT,
        provenance: COARSE_LIFE_EVIDENCE_PROVENANCE,
        createdAt,
        updatedAt: now
      });
      const nextRecords = { ...envelope.records, [nextId]: record };
      if (previousId && previousId !== nextId) delete nextRecords[previousId];
      writeEnvelope(storage, key, { schemaVersion: COARSE_LIFE_EVIDENCE_SCHEMA_VERSION, records: nextRecords });
      return record;
    },

    remove(id) {
      const envelope = readEnvelope(storage, key);
      if (!(id in envelope.records)) return false;
      const nextRecords = { ...envelope.records };
      delete nextRecords[id];
      writeEnvelope(storage, key, { schemaVersion: COARSE_LIFE_EVIDENCE_SCHEMA_VERSION, records: nextRecords });
      return true;
    }
  };
}

export const COARSE_LIFE_EVIDENCE_REPOSITORY_V1 = Object.freeze({
  schemaVersion: COARSE_LIFE_EVIDENCE_SCHEMA_VERSION,
  key: COARSE_LIFE_EVIDENCE_KEY
});
