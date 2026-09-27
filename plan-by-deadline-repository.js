// plan-by-deadline-repository.js
//
// Persistence for the Plan-by-deadline revision history (plan-by-deadline-model.js)
// and the account's Intentional Off-Day records. Local-only in this file —
// cross-device durability is plan-by-deadline-sync.js (same split as
// personal-day-boundary-repository.js / -sync.js, the established precedent).
//
// Storage shape mirrors personal-day-boundary-repository.js exactly:
//   deadline envelope: { schemaVersion: 1, revisions: { [id]: DeadlineRevision } }
//   off-day envelope:  { schemaVersion: 1, days: { [dateKey]: IntentionalOffDayRecord } }
// Both keyed by id/dateKey, never a bare array, for the same reason (§5/§10 of
// the boundary contract: array position must never be mistaken for authority,
// and a Map lets two devices append/update concurrently without clobbering).
//
// A DEADLINE revision, once created, is immutable (no update/delete path) —
// changing the deadline time is a NEW revision (propose()). An OFF-DAY record
// IS mutable in exactly one way: `revokedAtMs` may be set once, because §11
// requires the declaration to be reversible before the deadline — see
// revokeOffDay() below. Nothing else about either record ever changes shape.
//
// Unlike the Personal Day Boundary, an absent deadline history is NOT
// synthesized into an ephemeral default on read() — an unconfigured account
// gets an empty array, meaning "streak evaluation paused," never a guessed
// clock time (product decision, plan-by-deadline-model.js header).

import {
  validDeadlineTime,
  pickCanonicalRevisionId,
  proposeDeadlineRevision,
  normalizeDeadlineRevisionHistory,
  revisionsAreSemanticDuplicates,
  validateDeadlineRevision,
  validateIntentionalOffDayRecord,
} from './plan-by-deadline-model.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';

export const PLAN_BY_DEADLINE_STORAGE_KEY = 'ta3-plan-by-deadline-revisions-v1';
export const INTENTIONAL_OFF_DAY_STORAGE_KEY = 'ta3-intentional-off-days-v1';
export const PLAN_BY_DEADLINE_SCHEMA_VERSION = 1;

export { appRoomOwner };

/** The storage slot holding ONE room's cache: `<key>:<roomId>` — the same
 *  scoping shape used everywhere else in this app (storage.js, the boundary
 *  repository, operational-plan-repository.js). */
export function scopedCacheKeyForRoom(roomId, key) {
  return `${key}:${roomId}`;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultStorage() {
  if (globalThis.localStorage) return globalThis.localStorage;
  throw new Error('Plan-by-deadline storage is unavailable.');
}

function defaultIdGenerator() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  throw new Error('No UUID generator available; inject idGenerator for this runtime');
}

function readDeadlineEnvelope(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`Plan-by-deadline storage key ${key} contains malformed JSON.`);
  }
  if (!isPlainObject(envelope) || envelope.schemaVersion !== PLAN_BY_DEADLINE_SCHEMA_VERSION || !isPlainObject(envelope.revisions)) {
    throw new Error('Plan-by-deadline storage has an unsupported format or schema version.');
  }
  Object.entries(envelope.revisions).forEach(([id, revision]) => {
    if (!revision || revision.id !== id) throw new Error('Plan-by-deadline storage key/identity mismatch.');
  });
  normalizeDeadlineRevisionHistory(Object.values(envelope.revisions)); // throws loudly on malformed history (never silently reinterpreted, mirrors §18)
  return envelope;
}

function writeDeadlineEnvelope(storage, key, envelope) {
  storage.setItem(key, JSON.stringify(envelope));
}

function readOffDayEnvelope(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`Intentional off-day storage key ${key} contains malformed JSON.`);
  }
  if (!isPlainObject(envelope) || envelope.schemaVersion !== PLAN_BY_DEADLINE_SCHEMA_VERSION || !isPlainObject(envelope.days)) {
    throw new Error('Intentional off-day storage has an unsupported format or schema version.');
  }
  Object.entries(envelope.days).forEach(([dateKey, record]) => {
    if (!record || record.dateKey !== dateKey || !validateIntentionalOffDayRecord(record)) {
      throw new Error('Intentional off-day storage has an invalid or key-mismatched record.');
    }
  });
  return envelope;
}

function writeOffDayEnvelope(storage, key, envelope) {
  storage.setItem(key, JSON.stringify(envelope));
}

export function createPlanByDeadlineRepository(deps = {}) {
  const storage = deps.storage || defaultStorage();
  const deadlineBaseKey = deps.key || PLAN_BY_DEADLINE_STORAGE_KEY;
  const offDayBaseKey = deps.offDayKey || INTENTIONAL_OFF_DAY_STORAGE_KEY;
  const idGenerator = deps.idGenerator || defaultIdGenerator;
  const getOwner = typeof deps.getOwner === 'function' ? deps.getOwner : (deps.storage ? null : appRoomOwner);

  function ownerRoomId() {
    if (!getOwner) return null;
    const owner = getOwner();
    return typeof owner === 'string' && owner ? owner : null;
  }

  function activeKeyFor(baseKey) {
    if (!getOwner) return baseKey;
    const owner = ownerRoomId();
    return owner ? scopedCacheKeyForRoom(owner, baseKey) : null;
  }

  return {
    key: deadlineBaseKey,
    offDayKey: offDayBaseKey,
    ownerRoomId,

    // ── deadline revisions ──────────────────────────────────────────────

    /** {status:'unconfigured'|'configured'|'invalid', revisions?, error?} */
    deadlineStatus() {
      const key = activeKeyFor(deadlineBaseKey);
      if (key === null) return { status: 'unconfigured' };
      let envelope;
      try {
        envelope = readDeadlineEnvelope(storage, key);
      } catch (err) {
        return { status: 'invalid', error: err.message };
      }
      if (!envelope || !Object.keys(envelope.revisions).length) return { status: 'unconfigured' };
      return { status: 'configured', revisions: normalizeDeadlineRevisionHistory(Object.values(envelope.revisions)) };
    },

    /** The deadline revision history, or an empty array for an unconfigured
     *  account. Never synthesizes a guessed default (unlike the boundary
     *  repository's legacy anchor) — absence stays absence. Throws for a
     *  genuinely invalid persisted history rather than degrading silently.
     *  @returns {object[]} DeadlineRevision[] */
    readDeadlines() {
      const key = activeKeyFor(deadlineBaseKey);
      const envelope = key === null ? null : readDeadlineEnvelope(storage, key);
      return envelope ? normalizeDeadlineRevisionHistory(Object.values(envelope.revisions)) : [];
    },

    /** Appends a new prospective deadline revision (§9). `candidate.timezone`
     *  is the account's current authoritative timezone, passed through only to
     *  compute the activation instant — it is never itself persisted on the
     *  revision (plan-by-deadline-model.js: no second timezone source).
     *  @param {{deadlineTime:string, timezone:string}} candidate @param {number} nowMs
     *  @returns {{revision:object, revisions:object[]}} */
    proposeDeadline(candidate, nowMs) {
      if (!candidate || !validDeadlineTime(candidate.deadlineTime) || typeof candidate.timezone !== 'string') {
        throw new Error('A candidate deadline revision (deadlineTime, timezone) is required.');
      }
      const key = activeKeyFor(deadlineBaseKey);
      if (key === null) throw new Error('No account is active, so there is no plan-by-deadline cache to change.');
      const envelope = readDeadlineEnvelope(storage, key);
      const existing = envelope ? Object.values(envelope.revisions) : [];
      const { revision, revisions } = proposeDeadlineRevision(existing, { id: idGenerator(), deadlineTime: candidate.deadlineTime, timezone: candidate.timezone }, nowMs);
      const nextRevisions = {};
      revisions.forEach(r => { nextRevisions[r.id] = r; });
      writeDeadlineEnvelope(storage, key, { schemaVersion: PLAN_BY_DEADLINE_SCHEMA_VERSION, revisions: nextRevisions });
      return { revision, revisions };
    },

    /** Sync-only: every locally known deadline revision. */
    listAllDeadlinesRaw() {
      const key = activeKeyFor(deadlineBaseKey);
      if (key === null) return [];
      const envelope = readDeadlineEnvelope(storage, key);
      return envelope ? Object.values(envelope.revisions) : [];
    },

    /** Sync-only: merges a remote deadline-revision snapshot. Same union-by-id,
     *  semantic-dedup-by-canonical-id, hard-conflict-on-contradiction rules as
     *  personal-day-boundary-repository.js's mergeRemoteRevisions — see that
     *  file's extensive contract comment for the full rationale; it applies
     *  unchanged here (deadline revisions are just as immutable-once-created).
     *  The one difference: there is no anchor-only incompleteness case, since
     *  deadline histories have no anchor concept at all.
     *  @returns {{changed:boolean, changedIds:string[], rejectedIds:string[], droppedIds:string[], conflict:string|null}} */
    mergeRemoteDeadlines(remoteRecordsById) {
      const key = activeKeyFor(deadlineBaseKey);
      if (key === null || !isPlainObject(remoteRecordsById)) return { changed: false, changedIds: [], rejectedIds: [], droppedIds: [], conflict: null };
      const envelope = readDeadlineEnvelope(storage, key);
      const localById = envelope ? { ...envelope.revisions } : {};
      const changedIds = [];
      const rejectedIds = [];
      const droppedIds = [];
      const candidateById = { ...localById };
      Object.entries(remoteRecordsById).forEach(([id, remote]) => {
        if (!remote || typeof remote !== 'object' || remote.id !== id || !validateDeadlineRevision(remote)) { rejectedIds.push(id); return; }
        const local = localById[id];
        if (local) {
          if (JSON.stringify(local) !== JSON.stringify(remote)) rejectedIds.push(id);
          return;
        }
        const semanticMatchId = Object.keys(candidateById).find(existingId => existingId !== id && revisionsAreSemanticDuplicates(candidateById[existingId], remote));
        if (semanticMatchId) {
          if (pickCanonicalRevisionId(semanticMatchId, id) === id) {
            delete candidateById[semanticMatchId];
            candidateById[id] = remote;
            droppedIds.push(semanticMatchId);
            changedIds.push(id);
          }
          return;
        }
        candidateById[id] = remote;
        changedIds.push(id);
      });
      if (!changedIds.length) return { changed: false, changedIds, rejectedIds, droppedIds: [], conflict: null };
      let normalized;
      try {
        normalized = normalizeDeadlineRevisionHistory(Object.values(candidateById));
      } catch (err) {
        return { changed: false, changedIds: [], rejectedIds, droppedIds: [], conflict: err.message };
      }
      const nextRevisions = {};
      normalized.forEach(r => { nextRevisions[r.id] = r; });
      writeDeadlineEnvelope(storage, key, { schemaVersion: PLAN_BY_DEADLINE_SCHEMA_VERSION, revisions: nextRevisions });
      return { changed: true, changedIds, rejectedIds, droppedIds, conflict: null };
    },

    // ── intentional off-days ────────────────────────────────────────────

    /** @returns {object|null} the IntentionalOffDayRecord for dateKey, or null. */
    readOffDay(dateKey) {
      const key = activeKeyFor(offDayBaseKey);
      const envelope = key === null ? null : readOffDayEnvelope(storage, key);
      return envelope?.days?.[dateKey] || null;
    },

    /** Declares dateKey an intentional off-day, timestamped `nowMs`. Declaring
     *  the same date again before it is revoked is a no-op idempotent write
     *  (returns the existing record) — declaration is a one-time fact, not a
     *  running counter.
     *  @param {string} dateKey @param {number} nowMs @returns {object} the record */
    declareOffDay(dateKey, nowMs) {
      if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('A valid YYYY-MM-DD dateKey is required.');
      if (!Number.isFinite(nowMs)) throw new Error('A valid reference instant (nowMs) is required.');
      const key = activeKeyFor(offDayBaseKey);
      if (key === null) throw new Error('No account is active, so there is no off-day cache to change.');
      const envelope = readOffDayEnvelope(storage, key);
      const days = envelope ? { ...envelope.days } : {};
      if (days[dateKey] && !Number.isFinite(days[dateKey].revokedAtMs)) return days[dateKey]; // already declared and still active
      const record = { dateKey, declaredAtMs: nowMs, revokedAtMs: null };
      days[dateKey] = record;
      writeOffDayEnvelope(storage, key, { schemaVersion: PLAN_BY_DEADLINE_SCHEMA_VERSION, days });
      return record;
    },

    /** Revokes a previously declared off-day (§11: "reversible before the
     *  deadline if existing UX allows"). Whether the revoke actually still
     *  matters for streak purposes is plan-by-deadline-model.js's
     *  offDayDeclaredAtForDeadline's job, not this repository's — persistence
     *  always records the true revoke instant, never refuses the write based
     *  on whether a deadline has already passed.
     *  @param {string} dateKey @param {number} nowMs @returns {object|null} the updated record, or null if none was declared */
    revokeOffDay(dateKey, nowMs) {
      const key = activeKeyFor(offDayBaseKey);
      if (key === null) throw new Error('No account is active, so there is no off-day cache to change.');
      const envelope = readOffDayEnvelope(storage, key);
      const existing = envelope?.days?.[dateKey];
      if (!existing || Number.isFinite(existing.revokedAtMs)) return existing || null; // nothing declared, or already revoked
      const days = { ...envelope.days, [dateKey]: { ...existing, revokedAtMs: nowMs } };
      writeOffDayEnvelope(storage, key, { schemaVersion: PLAN_BY_DEADLINE_SCHEMA_VERSION, days });
      return days[dateKey];
    },

    /** Sync-only: every locally known off-day record. */
    listAllOffDaysRaw() {
      const key = activeKeyFor(offDayBaseKey);
      if (key === null) return [];
      const envelope = readOffDayEnvelope(storage, key);
      return envelope ? Object.values(envelope.days) : [];
    },

    /** Sync-only: merges a remote off-day snapshot. A record is field-merged by
     *  dateKey, never whole-object last-write-wins (§21/§26 discipline used
     *  throughout this subsystem): `declaredAtMs` never changes once set (the
     *  earliest declaration across devices wins, deterministic and
     *  order-independent), and `revokedAtMs` is adopted from whichever side has
     *  it set (a revoke made on either device must stick — a revoke can never
     *  be "un-merged" back to null). Field-level, not whole-record LWW, so two
     *  devices independently declaring the same date never race.
     *  @returns {{changed:boolean, changedDateKeys:string[], rejectedDateKeys:string[]}} */
    mergeRemoteOffDays(remoteRecordsByDateKey) {
      const key = activeKeyFor(offDayBaseKey);
      if (key === null || !isPlainObject(remoteRecordsByDateKey)) return { changed: false, changedDateKeys: [], rejectedDateKeys: [] };
      const envelope = readOffDayEnvelope(storage, key);
      const days = envelope ? { ...envelope.days } : {};
      const changedDateKeys = [];
      const rejectedDateKeys = [];
      Object.entries(remoteRecordsByDateKey).forEach(([dateKey, remote]) => {
        if (!remote || remote.dateKey !== dateKey || !validateIntentionalOffDayRecord(remote)) { rejectedDateKeys.push(dateKey); return; }
        const local = days[dateKey];
        if (!local) { days[dateKey] = remote; changedDateKeys.push(dateKey); return; }
        const declaredAtMs = Math.min(local.declaredAtMs, remote.declaredAtMs);
        const revokedAtMs = Number.isFinite(local.revokedAtMs) ? local.revokedAtMs
          : Number.isFinite(remote.revokedAtMs) ? remote.revokedAtMs : null;
        const merged = { dateKey, declaredAtMs, revokedAtMs };
        if (JSON.stringify(merged) !== JSON.stringify(local)) { days[dateKey] = merged; changedDateKeys.push(dateKey); }
      });
      if (!changedDateKeys.length) return { changed: false, changedDateKeys, rejectedDateKeys };
      writeOffDayEnvelope(storage, key, { schemaVersion: PLAN_BY_DEADLINE_SCHEMA_VERSION, days });
      return { changed: true, changedDateKeys, rejectedDateKeys };
    },
  };
}
