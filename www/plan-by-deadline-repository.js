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
  validDeadlineTimezone,
  pickCanonicalRevisionId,
  proposeDeadlineRevision,
  normalizeDeadlineRevisionHistory,
  revisionsAreSemanticDuplicates,
  validateDeadlineRevision,
  validateIntentionalOffDayRecord,
  findEqualAuthorityConflicts,
  activeEqualAuthorityConflicts,
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

/** Reads the raw envelope and checks per-revision structural validity only —
 *  it does NOT require the set to be a globally consistent, contradiction-free
 *  history (unlike the old design). An equal-authority contradiction (FIX
 *  FIRST §14) between two INDIVIDUALLY valid revisions is a real, storable
 *  state, not corruption — see deadlineConflict()/readDeadlines() below, which
 *  filter it out of ACTIVE computation while this function preserves it in
 *  storage untouched. Only genuine structural corruption (malformed JSON, an
 *  id/key mismatch, an individually-invalid revision) still throws here. */
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
    if (!validateDeadlineRevision(revision)) throw new Error(`Plan-by-deadline storage holds a structurally invalid revision: ${id}.`);
  });
  if (new Set(Object.keys(envelope.revisions)).size !== Object.keys(envelope.revisions).length) {
    throw new Error('Plan-by-deadline storage has duplicate revision ids.'); // structurally impossible via a Map key, defense in depth
  }
  return envelope;
}

/** The revisions usable for ACTIVE computation: every stored revision minus
 *  any that belongs to an equal-authority conflict group (active or already
 *  historically superseded — either way, that specific revision can never be
 *  trusted alone; see plan-by-deadline-model.js's deadlineInstantForCalendarDate,
 *  which would otherwise have two contradicting candidates for the same
 *  instant). Nothing is deleted from STORAGE by this filtering — it only
 *  affects what this accessor hands to a computation. */
function usableRevisions(envelope) {
  if (!envelope) return [];
  const all = Object.values(envelope.revisions);
  const conflicts = findEqualAuthorityConflicts(all);
  const conflictingIds = new Set(conflicts.flat().map(r => r.id));
  return all.filter(r => !conflictingIds.has(r.id));
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

    /** {status:'unconfigured'|'configured'|'conflict'|'invalid', revisions?, conflicts?, error?}
     *  'conflict' — an equal-authority contradiction (§14) is still ACTIVE (not
     *  yet superseded by a later clean revision). Both contradicting facts
     *  remain in storage (see usableRevisions); this is reported explicitly
     *  rather than picking a winner or reporting 'invalid'. */
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
      const conflicts = activeEqualAuthorityConflicts(Object.values(envelope.revisions));
      if (conflicts.length) return { status: 'conflict', conflicts };
      const usable = usableRevisions(envelope);
      if (!usable.length) return { status: 'unconfigured' }; // only historically-superseded conflict entries remain
      return { status: 'configured', revisions: normalizeDeadlineRevisionHistory(usable) };
    },

    /** The USABLE deadline revision history (equal-authority conflicts
     *  excluded — see usableRevisions), or an empty array for an unconfigured
     *  account. Never synthesizes a guessed default (unlike the boundary
     *  repository's legacy anchor) — absence stays absence. Never throws for a
     *  conflict specifically (§14/§15: a conflict must never crash evaluation
     *  or manufacture a false 'missed') — check deadlineConflict() to detect
     *  and surface it explicitly. Still throws for genuine structural
     *  corruption (see readDeadlineEnvelope).
     *  @returns {object[]} DeadlineRevision[] */
    readDeadlines() {
      const key = activeKeyFor(deadlineBaseKey);
      const envelope = key === null ? null : readDeadlineEnvelope(storage, key);
      const usable = usableRevisions(envelope);
      return usable.length ? normalizeDeadlineRevisionHistory(usable) : [];
    },

    /** The still-ACTIVE equal-authority conflict groups (§14), or [] if none.
     *  A caller (Settings UI, PlanAuthority) checks this BEFORE treating an
     *  empty readDeadlines() as "never configured" — a conflict and a genuine
     *  absence are different facts and must be shown differently.
     *  @returns {object[][]} */
    deadlineConflict() {
      const key = activeKeyFor(deadlineBaseKey);
      if (key === null) return [];
      const envelope = readDeadlineEnvelope(storage, key);
      return envelope ? activeEqualAuthorityConflicts(Object.values(envelope.revisions)) : [];
    },

    /** Appends a new prospective deadline revision (§9), built from only the
     *  USABLE (conflict-free) existing history — so a genuine equal-authority
     *  conflict can never make a new, clean proposal impossible, and this IS
     *  how the owner resolves a conflict (§14: "permit the user to resolve by
     *  explicitly saving a new prospective revision"). The write is additive:
     *  any previously-stored conflicting revisions are preserved untouched in
     *  the envelope (never deleted) as historical provenance, alongside the
     *  new one.
     *  @param {{deadlineTime:string, timezone:string}} candidate @param {number} nowMs
     *  @returns {{revision:object, revisions:object[]}} usable revisions only */
    proposeDeadline(candidate, nowMs) {
      if (!candidate || !validDeadlineTime(candidate.deadlineTime) || !validDeadlineTimezone(candidate.timezone)) {
        throw new Error('A candidate deadline revision (deadlineTime, timezone) is required.');
      }
      const key = activeKeyFor(deadlineBaseKey);
      if (key === null) throw new Error('No account is active, so there is no plan-by-deadline cache to change.');
      const envelope = readDeadlineEnvelope(storage, key);
      const existingUsable = usableRevisions(envelope);
      const { revision, revisions } = proposeDeadlineRevision(existingUsable, { id: idGenerator(), deadlineTime: candidate.deadlineTime, timezone: candidate.timezone }, nowMs);
      const nextRevisions = { ...(envelope ? envelope.revisions : {}) }; // preserves any old conflicting entries untouched
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

    /** Sync-only: merges a remote deadline-revision snapshot. Union-by-id,
     *  semantic-dedup-by-canonical-id (see personal-day-boundary-repository.js's
     *  mergeRemoteRevisions for the full identity-convergence rationale, which
     *  applies unchanged here). FIX FIRST §14 correction: an equal-authority
     *  CONTRADICTION (same effectiveFromInstant, different facts, different
     *  ids) is no longer a write-refusing gate — both sides are WRITTEN and
     *  preserved (never picking a winner by id or arrival order), and become
     *  detectable via deadlineConflict()/readDeadlines() filtering them out of
     *  active computation. Reversed delivery order converges on the identical
     *  stored state either way, since the write is a pure set-union.
     *  @returns {{changed:boolean, changedIds:string[], rejectedIds:string[], droppedIds:string[], conflict:string[][]|null}} */
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
          if (JSON.stringify(local) !== JSON.stringify(remote)) rejectedIds.push(id); // same id, different facts — genuinely impossible (ids are randomly generated), fail safe rather than overwrite
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
        // A different id, not a semantic duplicate: adopted as-is, even if it
        // shares an effectiveFromInstant with something already in
        // candidateById (a genuine equal-authority contradiction) — both are
        // preserved; normalizeDeadlineRevisionHistory is deliberately never
        // called as a write gate here (see module header / §14).
        candidateById[id] = remote;
        changedIds.push(id);
      });
      if (!changedIds.length) return { changed: false, changedIds, rejectedIds, droppedIds: [], conflict: null };
      writeDeadlineEnvelope(storage, key, { schemaVersion: PLAN_BY_DEADLINE_SCHEMA_VERSION, revisions: candidateById });
      const conflicts = findEqualAuthorityConflicts(Object.values(candidateById));
      return { changed: true, changedIds, rejectedIds, droppedIds, conflict: conflicts.length ? conflicts : null };
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
