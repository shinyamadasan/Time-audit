// personal-day-boundary-sync.js
//
// Durable cross-device copy of the Personal Day Boundary revision history, on
// top of the local-only personal-day-boundary-repository.js. Same split and
// same record-level append/merge shape as coarse-life-evidence-sync.js (this
// app's established pattern for a durable remote copy that must NOT use
// storage.js's whole-object `settings` last-write-wins push — see that file's
// syncSettings()/applyRemoteSettings(), which this module deliberately does not
// call or extend).
//
// Remote path: `rooms/<roomCode>/dayBoundaryRevisions/<revisionId>` — a
// room-scoped child, already covered by the existing wide-open
// `rooms/$roomId` read/write rule in firebase.rules.json (no rules change
// needed).
//
// Dependency-injected, exactly like createCoarseEvidenceSyncBridge, so the
// full attach/push/merge lifecycle is unit-testable against an in-memory fake
// room ref — no real network, no real Firebase project required.
//
// ── atomicity model (post-review correction) ───────────────────────────────
//
// A revision is immutable once it exists, but the INVARIANTS that make a
// boundary-revision HISTORY valid are properties of the whole collection, not
// of any single revision in isolation: exactly one anchor, unique ids, unique
// effective instants, and every non-anchor revision aligned to its own
// boundary time (personal-day-boundary-model.js's
// normalizeBoundaryRevisionHistory). A transaction scoped to one revision's
// own child key (`dayBoundaryRevisions/<id>`) can only ever see that one key
// — it is structurally blind to a sibling key, so it cannot detect "another
// device just committed a DIFFERENT id with the SAME effectiveFromInstant."
// Two such transactions can each independently see "my key is free" and both
// commit, leaving a remote history that is invalid the moment you look at it
// as a whole — exactly the defect an independent review reproduced against
// this module's previous per-child-transaction design.
//
// The fix moves the transaction boundary up to the WHOLE collection
// (`dayBoundaryRevisions`, not `dayBoundaryRevisions/<id>`). Every push is a
// single Firebase transaction on that parent path; its update function
// receives the server's current complete revision map, decides the outcome
// against ALL of it, and only ever returns a map that has already passed
// `normalizeBoundaryRevisionHistory` — or returns `undefined` to abort with
// zero writes. Firebase serializes concurrent transactions on one path
// (retrying the loser against the winner's just-committed value), so the
// second of two concurrent proposals always sees the first one's result
// before deciding anything, closing the exact race the per-child design
// could not.
//
// Inside that transaction, a candidate revision resolves to exactly one of:
//   - 'idempotent'    — remote already has this exact id+facts. No-op commit.
//   - 'conflict'      — remote has this id with DIFFERENT facts, OR shares
//                        this candidate's effectiveFromInstant with different
//                        facts under another id (a genuine contradiction —
//                        never resolved by arrival order, id, or which
//                        boundary time is "higher"). Aborted, zero writes.
//   - 'deduplicated'  — a semantically-identical revision already exists
//                        remotely under a different id, and that id is
//                        already the deterministic canonical winner
//                        (personal-day-boundary-model.js's
//                        pickCanonicalRevisionId — plain lexicographic
//                        minimum, so the outcome never depends on which
//                        device's write or retry happened to land first).
//                        No-op commit; this device's own losing-id revision
//                        gets dropped from ITS local history the next time it
//                        observes this remote state (see
//                        personal-day-boundary-repository.js's
//                        mergeRemoteRevisions, which now performs that
//                        identity reconciliation) — never left as a
//                        permanent split-brain identity (§4).
//   - 'canonicalized' — a semantically-identical revision exists remotely
//                        under a different id, but THIS candidate's id is the
//                        deterministic winner: the transaction actively
//                        swaps remote's entry to this candidate's identity
//                        (delete the losing key, add the winning one). Only
//                        the arbitrary identity token changes; the facts
//                        (boundaryTime/timezone/effectiveFromInstant) are
//                        identical by definition of "semantic duplicate."
//   - 'malformed-remote' — the transaction observed an already-invalid
//                        remote map (fails normalizeBoundaryRevisionHistory
//                        on its own). Aborted with zero writes rather than
//                        either overwriting it or silently treating it as
//                        empty — an invalid remote is a fact to surface, not
//                        paper over (§11 of the atomicity contract).
//   - 'committed'     — a genuinely new, non-conflicting fact. Validated
//                        against remote-plus-candidate AND merged with this
//                        device's own full local history (so a device
//                        pushing its own anchor and custom revision as two
//                        separate transactions, in either order, is never
//                        rejected just because remote doesn't have the other
//                        one yet — see pushRevision below) before committing.
//   - 'transport-failure' / 'skipped' — no room ref, or the SDK doesn't
//                        support transactions. No writes attempted.
//
// This module does not wire itself into the live app
// (`window.PersonalDayBoundarySync` is not created here) — that is a future
// integration phase's job, matching how personal-day-boundary-model.js itself
// shipped fully tested but unwired.
//
// ── deferred, documented, not addressed here ────────────────────────────────
// Cross-runtime timezone-alias convergence: canonicalizeOperationalDayTimezone
// resolves aliases deterministically WITHIN one JS runtime's ICU/tzdata, but
// two devices on different runtimes could in principle canonicalize the same
// alias to different strings. This module does not attempt to guess
// cross-runtime timezone equivalence — if two revisions share an
// effectiveFromInstant but their persisted `timezone` strings differ, that is
// treated as a genuine conflict (never a false semantic-duplicate merge),
// which is the safe failure mode. Resolving this for real requires either a
// shared canonical timezone table or a settings-integration decision, neither
// of which this bounded fix introduces.

import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import {
  normalizeBoundaryRevisionHistory,
  pickCanonicalRevisionId,
  revisionsAreSemanticDuplicates,
  validateBoundaryRevision,
} from './personal-day-boundary-model.js';

export const DAY_BOUNDARY_REVISIONS_REMOTE_PATH = 'dayBoundaryRevisions';

/** Decodes a raw remote `dayBoundaryRevisions` value (as read inside a
 *  transaction) into `{valid, revisions}`. An absent/empty map is valid-empty
 *  (a fresh room). A non-empty map that fails structural or normalization
 *  validation is `valid: false` — this is the "malformed remote" case, never
 *  silently treated as empty and never blindly trusted. */
function decodeRemoteHistory(remoteMap) {
  if (remoteMap == null) return { valid: true, revisions: [] };
  if (typeof remoteMap !== 'object' || Array.isArray(remoteMap)) return { valid: false, revisions: [] };
  const entries = Object.entries(remoteMap);
  if (!entries.length) return { valid: true, revisions: [] };
  if (entries.some(([id, r]) => !r || typeof r !== 'object' || r.id !== id || !validateBoundaryRevision(r))) return { valid: false, revisions: [] };
  try {
    return { valid: true, revisions: normalizeBoundaryRevisionHistory(entries.map(([, r]) => r)) };
  } catch {
    return { valid: false, revisions: [] };
  }
}

export function createPersonalDayBoundarySyncBridge(deps = {}) {
  const repository = deps.repository || createPersonalDayBoundaryRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};
  const onConflict = typeof deps.onConflict === 'function' ? deps.onConflict : () => {};

  let listenerRef = null;
  let bootstrapped = false;
  let lastRemoteSnapshot = {};

  // One revision, one atomic transaction on the WHOLE collection (never the
  // per-id child) — see the module header for the full outcome taxonomy.
  // @returns {Promise<{committed:boolean, outcome:string}>}
  function pushRevision(revision) {
    if (!revision || !revision.id) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const roomRef = getRoomRef();
    if (!roomRef) return Promise.resolve({ committed: false, outcome: 'skipped' });
    let collectionRef;
    try {
      collectionRef = roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH);
      if (typeof collectionRef.transaction !== 'function') throw new Error('Firebase transactions are unavailable.');
    } catch {
      return Promise.resolve({ committed: false, outcome: 'transport-failure' });
    }

    let outcome = 'committed';
    return collectionRef.transaction(remoteMap => {
      const decoded = decodeRemoteHistory(remoteMap);
      if (!decoded.valid) { outcome = 'malformed-remote'; return undefined; }
      const remoteById = remoteMap || {};

      const existingSameId = remoteById[revision.id];
      if (existingSameId) {
        if (JSON.stringify(existingSameId) === JSON.stringify(revision)) { outcome = 'idempotent'; return remoteMap; }
        outcome = 'conflict';
        return undefined;
      }

      const semanticMatch = decoded.revisions.find(r => r.id !== revision.id && revisionsAreSemanticDuplicates(r, revision));
      if (semanticMatch) {
        if (pickCanonicalRevisionId(semanticMatch.id, revision.id) === semanticMatch.id) {
          outcome = 'deduplicated'; // remote's existing id is already canonical — nothing to write
          return remoteMap;
        }
        // This candidate's id is the deterministic winner: swap identity.
        const swapped = { ...remoteById };
        delete swapped[semanticMatch.id];
        swapped[revision.id] = revision;
        try {
          normalizeBoundaryRevisionHistory(Object.values(swapped));
        } catch {
          outcome = 'conflict';
          return undefined;
        }
        outcome = 'canonicalized';
        return swapped;
      }

      const contradiction = decoded.revisions.find(r => r.effectiveFromInstant === revision.effectiveFromInstant);
      if (contradiction) { outcome = 'conflict'; return undefined; } // shares an instant, NOT a semantic duplicate

      // Genuinely new fact. Validate remote+candidate merged with this
      // device's own full local history — a device pushing its own anchor
      // and custom revision as two separate transactions, in either order,
      // must not have the earlier one rejected merely because remote does
      // not yet have the other one.
      const withCandidate = { ...remoteById, [revision.id]: revision };
      const localContext = repository.listAllRaw().reduce((acc, r) => { acc[r.id] = r; return acc; }, {});
      try {
        normalizeBoundaryRevisionHistory(Object.values({ ...localContext, ...withCandidate }));
      } catch {
        outcome = 'conflict';
        return undefined;
      }
      return withCandidate;
    }, undefined, false)
      .then(result => ({ committed: !!result?.committed, outcome }))
      .catch(() => ({ committed: false, outcome: 'transport-failure' }));
  }

  // Pushes every locally known revision missing or diverged from the last
  // observed remote snapshot. Anchor-first ordering (effectiveFromInstant
  // ascending, null first) minimizes the window in which remote holds a
  // custom revision without its anchor when both are pushed together for
  // the first time — not required for correctness (each push is validated
  // against this device's full local context regardless of order), but
  // reduces transient inconsistency for any concurrent observer.
  function pushAllLocal(remoteSnapshot = lastRemoteSnapshot) {
    const roomRef = getRoomRef();
    if (!roomRef) return Promise.resolve({ committed: false, results: [] });
    const remote = remoteSnapshot || {};
    const missing = repository.listAllRaw()
      .filter(revision => {
        const remoteRevision = remote[revision.id];
        return !remoteRevision || JSON.stringify(remoteRevision) !== JSON.stringify(revision);
      })
      .sort((a, b) => (a.effectiveFromInstant === null ? -Infinity : a.effectiveFromInstant) - (b.effectiveFromInstant === null ? -Infinity : b.effectiveFromInstant));
    if (!missing.length) return Promise.resolve({ committed: false, results: [] });
    return Promise.all(missing.map(pushRevision)).then(results => ({ committed: results.some(r => r.committed), results }));
  }

  // Firebase `.on('value')` semantics: fires once immediately with current
  // data, then again on every subsequent change/reconnect (including this
  // device's own committed/canonicalized pushes on the same path). Record-
  // level merge only via repository.mergeRemoteRevisions — never a
  // collection replace. mergeRemoteRevisions now also performs identity
  // reconciliation (droppedIds) when a remote canonical id supersedes this
  // device's own losing-id proposal.
  function handleRemoteSnapshot(val) {
    lastRemoteSnapshot = val || {};
    const result = repository.mergeRemoteRevisions(lastRemoteSnapshot);
    if (result.changed) onRemoteChange(result);
    if (result.conflict || result.rejectedIds.length) onConflict(result);
    if (!bootstrapped) {
      bootstrapped = true;
      pushAllLocal(lastRemoteSnapshot);
    }
  }

  function attach() {
    if (listenerRef) return;
    const roomRef = getRoomRef();
    if (!roomRef) return;
    listenerRef = roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH);
    listenerRef.on('value', snap => handleRemoteSnapshot(snap.val()));
  }

  function detach() {
    if (listenerRef) listenerRef.off();
    listenerRef = null;
    bootstrapped = false;
    lastRemoteSnapshot = {};
  }

  return { attach, detach, pushRevision, pushAllLocal, handleRemoteSnapshot, repository };
}
