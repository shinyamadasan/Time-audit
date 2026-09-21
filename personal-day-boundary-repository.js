// personal-day-boundary-repository.js
//
// Persistence for the Personal Day Boundary revision history defined by
// personal-day-boundary-model.js (the foundation). Local-only in this file —
// cross-device durability is a separate concern, see personal-day-boundary-sync.js
// (same split as coarse-life-evidence-repository.js / -sync.js, the established
// precedent in this app for "a small record-keyed store that also needs a durable
// remote copy without whole-object last-write-wins").
//
// Storage shape (envelope): { schemaVersion: 1, revisions: { [id]: BoundaryRevision } }.
// Revisions are keyed by id, never stored as a bare array — array position must
// never be mistaken for authority (contract §5/§10), and a Map-by-id is exactly
// what lets two devices append distinct revisions concurrently without either one
// clobbering the other (Firebase RTDB `update()` at distinct child paths never
// conflicts — see personal-day-boundary-sync.js).
//
// A revision, once created, is immutable — there is no update/rename/delete path
// here. "Turn off my custom boundary" is a NEW revision with boundaryTime '00:00'
// (see propose()); this repository never deletes or rewrites history (contract §22).
//
// ── absent vs. legacy vs. custom vs. invalid (contract §3, §18) ────────────
//
// ── account scoping (Cross-Device Sync V1, account-scope correction) ───────
//
// The cache is a copy of ONE account's authoritative history
// (rooms/<room>/dayBoundaryRevisions), so it is stored per room: the slot for the
// joined room `uid_A` is `ta3-day-boundary-revisions-v1:uid_A`. Ownership is
// therefore structural — there is no way to read, merge into, or push "the cache"
// without naming whose it is, and account A's slot is never visible while account
// B is joined. Signing out leaves A's slot in place (offline use on A's next launch)
// but it stops being the ACTIVE cache the moment no room, or a different room, is
// joined.
//
// The pre-scoping key, `ta3-day-boundary-revisions-v1` (no suffix), carries no owner.
// Nothing this app persists proves whose it is (a uid room code is never stored),
// so it is never adopted: a scoped repository does not read it, merge into it, or
// push it. It is left untouched in place, and an account's scoped cache is
// populated from that account's authoritative snapshot.
//
// A repository built without `getOwner` over an INJECTED storage is "plain": one
// unowned slot at `key`, for tests of the revision semantics themselves. One built
// over the real localStorage is always scoped to the app's joined room.
//
// A user who has never touched this feature has NOTHING in storage — read()
// synthesizes an ephemeral legacyBoundaryRevision() purely in memory so callers
// always get a valid, non-empty history to hand the foundation model, but that
// synthesis is never written back (§3: no automatic production write for legacy
// users). status() distinguishes this ('absent') from a history that is present
// but has been corrupted in some way ('invalid') — absence must never be
// misreported as malformed custom configuration, and a genuinely malformed
// history must never be silently reinterpreted as if the user had none (§18).

import {
  canonicalizeOperationalDayTimezone,
  legacyBoundaryRevision,
  normalizeBoundaryRevisionHistory,
  pickCanonicalRevisionId,
  proposeBoundaryRevision,
  revisionsAreSemanticDuplicates,
  validateBoundaryRevision,
} from './personal-day-boundary-model.js';

export const PERSONAL_DAY_BOUNDARY_STORAGE_KEY = 'ta3-day-boundary-revisions-v1';
export const PERSONAL_DAY_BOUNDARY_SCHEMA_VERSION = 1;

/** The storage slot holding ONE room's cache: `<key>:<roomId>`. */
export function boundaryCacheKeyForRoom(roomId, key = PERSONAL_DAY_BOUNDARY_STORAGE_KEY) {
  return `${key}:${roomId}`;
}

/** The room the app has joined (storage.js's roomCode), or null when none is joined —
 *  signed out, or auth has not answered yet. Never throws: storage.js is a classic
 *  script and may still be parsing when a module asks. */
export function appRoomOwner() {
  try {
    const roomId = typeof globalThis.getChronaSenseRoomCode === 'function' ? globalThis.getChronaSenseRoomCode() : null;
    return typeof roomId === 'string' && roomId ? roomId : null;
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultStorage() {
  if (globalThis.localStorage) return globalThis.localStorage;
  throw new Error('Personal day boundary storage is unavailable.');
}

function defaultIdGenerator() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  throw new Error('No UUID generator available; inject idGenerator for this runtime');
}

/** Reads the raw envelope. Returns null for "nothing has ever been written"
 *  (absent) — distinct from throwing, which means "something is there and it's
 *  broken." Never synthesizes the legacy anchor itself; that is read()'s job. */
function readEnvelope(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`Personal day boundary storage key ${key} contains malformed JSON.`);
  }
  if (!isPlainObject(envelope) || envelope.schemaVersion !== PERSONAL_DAY_BOUNDARY_SCHEMA_VERSION || !isPlainObject(envelope.revisions)) {
    throw new Error('Personal day boundary storage has an unsupported format or schema version.');
  }
  Object.entries(envelope.revisions).forEach(([id, revision]) => {
    if (!revision || revision.id !== id) throw new Error('Personal day boundary storage key/identity mismatch.');
  });
  // normalizeBoundaryRevisionHistory throws on any structural violation (missing/duplicate
  // anchor, duplicate ids, duplicate effective instants, misaligned activation, invalid
  // shape) — exactly the "malformed / conflicting / missing anchor" cases §18 requires this
  // repository to fail loudly on rather than silently reinterpret as legacy.
  normalizeBoundaryRevisionHistory(Object.values(envelope.revisions));
  return envelope;
}

function writeEnvelope(storage, key, envelope) {
  storage.setItem(key, JSON.stringify(envelope));
}

export function createPersonalDayBoundaryRepository(deps = {}) {
  const storage = deps.storage || defaultStorage();
  const baseKey = deps.key || PERSONAL_DAY_BOUNDARY_STORAGE_KEY;
  const idGenerator = deps.idGenerator || defaultIdGenerator;
  // Scoped when told who the owner is, or when running over the real localStorage.
  const getOwner = typeof deps.getOwner === 'function' ? deps.getOwner : (deps.storage ? null : appRoomOwner);

  /** Whose cache is active right now, or null (plain repository, or no room joined). */
  function ownerRoomId() {
    if (!getOwner) return null;
    const owner = getOwner();
    return typeof owner === 'string' && owner ? owner : null;
  }

  /** The active storage slot, or null when there is NO active cache: a scoped
   *  repository with no room joined has no account to hold a cache for. */
  function activeKey() {
    if (!getOwner) return baseKey;
    const owner = ownerRoomId();
    return owner ? boundaryCacheKeyForRoom(owner, baseKey) : null;
  }

  return {
    key: baseKey,

    /** The room whose cache is active, or null. The sync bridge refuses to push unless
     *  this equals the room it is pushing to. */
    ownerRoomId,

    /** {status: 'absent'|'custom'|'invalid', revisions?, error?}
     *  'absent'  — nothing persisted; pure legacy user (§3).
     *  'custom'  — a valid, persisted history exists (its anchor plus >=1 real
     *              revision — propose() never persists an anchor alone, see below).
     *  'invalid' — something is persisted but fails validation; never silently
     *              treated as absent or as legacy (§18). */
    status() {
      const key = activeKey();
      if (key === null) return { status: 'absent' };
      let envelope;
      try {
        envelope = readEnvelope(storage, key);
      } catch (err) {
        return { status: 'invalid', error: err.message };
      }
      if (!envelope) return { status: 'absent' };
      return { status: 'custom', revisions: normalizeBoundaryRevisionHistory(Object.values(envelope.revisions)) };
    },

    /** The revision history to hand the foundation model for any read (e.g.
     *  operationalDayContaining). For an absent user this is a single ephemeral
     *  legacy anchor in `timezone` — never written to storage (§3). Throws for
     *  an invalid persisted history rather than silently degrading (§18) — a
     *  caller that wants a non-throwing status check should use status() first.
     *  @param {string} timezone used only to seed the ephemeral anchor when absent
     *  @returns {object[]} BoundaryRevision[] */
    read(timezone) {
      const key = activeKey();
      const envelope = key === null ? null : readEnvelope(storage, key);
      if (!envelope) return [legacyBoundaryRevision(canonicalizeOperationalDayTimezone(timezone))];
      return normalizeBoundaryRevisionHistory(Object.values(envelope.revisions));
    },

    /** Appends a new prospective boundary revision (contract §4/§8). When no
     *  history is persisted yet, this is the one moment a legacy user's absence
     *  becomes a real persisted anchor — created together with the candidate as
     *  ONE atomic write, never as a separate step (§4: "conceptually create the
     *  required legacy anchor and the new prospective revision as one
     *  authoritative history"). `candidate.timezone` is canonicalized (§7) before
     *  it ever reaches the foundation model or storage.
     *  @param {{boundaryTime:string, timezone:string}} candidate
     *  @param {number} nowMs
     *  @returns {{revision:object, revisions:object[]}} */
    propose(candidate, nowMs) {
      if (!candidate || typeof candidate.boundaryTime !== 'string' || typeof candidate.timezone !== 'string') {
        throw new Error('A candidate boundary revision (boundaryTime, timezone) is required.');
      }
      const key = activeKey();
      if (key === null) throw new Error('No account is active, so there is no personal day cache to change.');
      const canonicalTimezone = canonicalizeOperationalDayTimezone(candidate.timezone);
      const envelope = readEnvelope(storage, key);
      const existing = envelope ? Object.values(envelope.revisions) : [legacyBoundaryRevision(canonicalTimezone)];
      const { revision, revisions } = proposeBoundaryRevision(existing, { id: idGenerator(), boundaryTime: candidate.boundaryTime, timezone: canonicalTimezone }, nowMs);
      const nextRevisions = {};
      revisions.forEach(r => { nextRevisions[r.id] = r; });
      writeEnvelope(storage, key, { schemaVersion: PERSONAL_DAY_BOUNDARY_SCHEMA_VERSION, revisions: nextRevisions });
      return { revision, revisions };
    },

    /** Sync-only: every locally known revision, for pushing a durable remote copy. */
    listAllRaw() {
      const key = activeKey();
      if (key === null) return [];
      const envelope = readEnvelope(storage, key);
      return envelope ? Object.values(envelope.revisions) : [];
    },

    /** Sync-only: merges a remote snapshot (object keyed by id, as read from
     *  `rooms/<roomCode>/dayBoundaryRevisions`) into local storage. Revisions are
     *  immutable once created, so this is a set-union by id, never a
     *  timestamp-LWW overwrite — order of arrival across devices cannot change
     *  the resulting history (contract §5/§21). A remote id local doesn't have is
     *  simply added; a remote id local already has is verified byte-identical
     *  (after validation) — a genuine mismatch (§6: "duplicate IDs with different
     *  facts must fail safely") is reported as a conflict and that one id is
     *  rejected rather than either copy silently winning. A malformed remote
     *  revision is skipped, never thrown, and never allowed to corrupt a valid
     *  local history (§18) — but if the resulting UNION would itself fail
     *  normalizeBoundaryRevisionHistory (e.g. two independently-created, equally
     *  authoritative revisions that happen to share an effectiveFromInstant),
     *  nothing is written and that is reported too, rather than one silently
     *  discarding the other.
     *  A remote id that ISN'T locally present under that exact id may still be
     *  a SEMANTIC duplicate of a local revision this device already has under
     *  a different (independently-generated) id — two devices proposing the
     *  same boundary/timezone at the same effective instant. That is
     *  concurrent-proposal convergence (§3/§4/§5), not a conflict: the
     *  deterministic canonical id (pickCanonicalRevisionId) decides which
     *  identity survives. If remote's id wins, this device drops its own
     *  losing-id revision (`droppedIds`) and adopts remote's — identity
     *  reconciliation, so every device converges on the SAME id rather than
     *  a permanent split brain. If this device's own local id already IS the
     *  canonical one, the remote entry is ignored here; a future push
     *  corrects remote to match (see personal-day-boundary-sync.js).
     *  Two revisions that share an effectiveFromInstant WITHOUT being
     *  semantic duplicates (different boundaryTime/timezone) remain a hard
     *  conflict exactly as before — contradiction is never deduplication.
     *  @param {object} remoteRecordsById @param {number} [nowTs] unused, kept for
     *    call-shape symmetry with the coarse-life-evidence sync bridge.
     *  @returns {{changed:boolean, changedIds:string[], rejectedIds:string[], droppedIds:string[], conflict:string|null}} */
    mergeRemoteRevisions(remoteRecordsById) {
      const key = activeKey();
      if (key === null || !isPlainObject(remoteRecordsById)) return { changed: false, changedIds: [], rejectedIds: [], droppedIds: [], conflict: null };
      const envelope = readEnvelope(storage, key);
      const localById = envelope ? { ...envelope.revisions } : {};
      const changedIds = [];
      const rejectedIds = [];
      const droppedIds = [];
      const candidateById = { ...localById };
      Object.entries(remoteRecordsById).forEach(([id, remote]) => {
        if (!remote || typeof remote !== 'object' || remote.id !== id || !validateBoundaryRevision(remote)) { rejectedIds.push(id); return; }
        const local = localById[id];
        if (local) {
          if (JSON.stringify(local) !== JSON.stringify(remote)) rejectedIds.push(id); // §6: conflicting duplicate id — never silently pick one
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
          // else: our existing local id is already canonical — ignore remote's losing id.
          return;
        }
        candidateById[id] = remote;
        changedIds.push(id);
      });
      if (!changedIds.length) return { changed: false, changedIds, rejectedIds, droppedIds: [], conflict: null };
      let normalized;
      try {
        normalized = normalizeBoundaryRevisionHistory(Object.values(candidateById));
      } catch (err) {
        // The union itself is structurally inconsistent (e.g. a same-instant collision
        // between two independently-proposed revisions) — write nothing rather than
        // silently drop one side's fact.
        return { changed: false, changedIds: [], rejectedIds, droppedIds: [], conflict: err.message };
      }
      const nextRevisions = {};
      normalized.forEach(r => { nextRevisions[r.id] = r; });
      writeEnvelope(storage, key, { schemaVersion: PERSONAL_DAY_BOUNDARY_SCHEMA_VERSION, revisions: nextRevisions });
      return { changed: true, changedIds, rejectedIds, droppedIds, conflict: null };
    }
  };
}
