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
  getCoarseEvidenceForDate,
  resolveCoarseEvidenceSync
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

    // Ordinary reads never see a tombstoned (deleted) record — to the app, a removed
    // activity simply does not exist. The tombstone itself is kept locally (never physically
    // erased) purely so a stale remote/device echo of the pre-delete value cannot resurrect
    // it once durability sync is involved — see resolveCoarseEvidenceSync / mergeRemoteSnapshot.
    list() {
      return Object.values(readEnvelope(storage, key).records).filter(r => !r.deleted);
    },

    listForDate(date) {
      return getCoarseEvidenceForDate(this.list(), date);
    },

    get(id) {
      const record = readEnvelope(storage, key).records[id];
      return (record && !record.deleted) ? record : null;
    },

    // Sync-only: every locally known record, tombstones included. Used to push the full
    // local state (deletions included) to a durable remote copy.
    listAllRaw() {
      return Object.values(readEnvelope(storage, key).records);
    },

    // Sync-only: reads a record regardless of tombstone state, e.g. so a caller can push a
    // just-created tombstone to the remote copy after remove() returns.
    getRaw(id) {
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
      // A tombstoned identity is, from the user's perspective, free — renaming/moving onto
      // one (or a plain Add landing on one) resurrects that identity rather than colliding.
      const existingBlocksRename = existing && !existing.deleted;
      if (previousId && previousId !== nextId && existingBlocksRename) {
        throw new Error(`An activity named "${cleanLabel}" already exists for ${date}. Edit that activity instead, or choose a different label.`);
      }
      const createdAt = existing ? existing.createdAt : now;
      // Landing on a tombstoned identity (plain Add, or a rename/date-move onto a free
      // identity) is a genuine resurrection — stamp `undoRestoredAt` so this is
      // distinguishable, on another device, from a stale pre-delete echo. Without this, a
      // device that already holds the tombstone would never accept the resurrection back
      // (resolveCoarseEvidenceSync's guard requires it) — see the entries[] precedent,
      // `restoreUndoEntries()` in index.html.
      const resurrecting = Boolean(existing && existing.deleted);
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
        updatedAt: now,
        ...(resurrecting ? { undoRestoredAt: now } : {})
      });
      const nextRecords = { ...envelope.records, [nextId]: record };
      // A rename/date-move must not just vanish the old identity's row: a durable remote
      // copy of it may still exist elsewhere, and a plain local delete would let that stale
      // remote value get pulled back down later as an orphaned resurrection. Tombstone it
      // instead, exactly like remove() — the caller is responsible for pushing that
      // tombstone (via getRaw(previousId)) alongside the new record when sync is enabled.
      if (previousId && previousId !== nextId && envelope.records[previousId] && !envelope.records[previousId].deleted) {
        nextRecords[previousId] = validateCoarseEvidenceRecord({ ...envelope.records[previousId], deleted: true, updatedAt: now });
      }
      writeEnvelope(storage, key, { schemaVersion: COARSE_LIFE_EVIDENCE_SCHEMA_VERSION, records: nextRecords });
      return record;
    },

    // Tombstones (never physically erases) so a durable remote copy converges to "deleted"
    // instead of a stale device/remote echo resurrecting it later. Returns false if the id
    // is unknown or already tombstoned — "already gone" either way, matching prior behavior.
    remove(id, { now = Date.now() } = {}) {
      const envelope = readEnvelope(storage, key);
      const existing = envelope.records[id];
      if (!existing || existing.deleted) return false;
      const tombstone = validateCoarseEvidenceRecord({ ...existing, deleted: true, updatedAt: now });
      const nextRecords = { ...envelope.records, [id]: tombstone };
      writeEnvelope(storage, key, { schemaVersion: COARSE_LIFE_EVIDENCE_SCHEMA_VERSION, records: nextRecords });
      return true;
    },

    // Durability V1 — merges a remote snapshot (object keyed by id, as read from
    // `rooms/<roomCode>/coarseLifeEvidence`) into local storage, record by record. Never
    // replaces the local collection: only ids present in `remoteRecordsById` are touched,
    // and each is resolved independently via resolveCoarseEvidenceSync (updatedAt-LWW with
    // the tombstone-resurrection guard). A malformed remote entry is skipped, never thrown,
    // and never allowed to overwrite a valid local record. Returns which ids actually changed
    // so a caller can decide whether to re-render.
    mergeRemoteSnapshot(remoteRecordsById, nowTs = Date.now()) {
      if (!remoteRecordsById || typeof remoteRecordsById !== 'object' || Array.isArray(remoteRecordsById)) {
        return { changed: false, changedIds: [] };
      }
      const envelope = readEnvelope(storage, key);
      const nextRecords = { ...envelope.records };
      const changedIds = [];
      Object.entries(remoteRecordsById).forEach(([id, remote]) => {
        if (!remote || typeof remote !== 'object') return;
        let validRemote;
        try {
          validRemote = validateCoarseEvidenceRecord(remote);
        } catch {
          return; // malformed remote record — never let it become valid evidence (§17)
        }
        if (validRemote.id !== id) return; // key/identity mismatch — same guard readEnvelope applies locally
        const local = nextRecords[id] || null;
        const resolution = resolveCoarseEvidenceSync(local, validRemote, nowTs);
        if (resolution.action === 'add' || resolution.action === 'replace') {
          nextRecords[id] = resolution.record;
          changedIds.push(id);
        }
      });
      if (changedIds.length) {
        writeEnvelope(storage, key, { schemaVersion: COARSE_LIFE_EVIDENCE_SCHEMA_VERSION, records: nextRecords });
      }
      return { changed: changedIds.length > 0, changedIds };
    }
  };
}

export const COARSE_LIFE_EVIDENCE_REPOSITORY_V1 = Object.freeze({
  schemaVersion: COARSE_LIFE_EVIDENCE_SCHEMA_VERSION,
  key: COARSE_LIFE_EVIDENCE_KEY
});
