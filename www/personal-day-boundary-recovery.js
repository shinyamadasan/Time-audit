// personal-day-boundary-recovery.js
//
// Legacy Recovery V2 — provenance-aware. A device may hold a STRUCTURALLY COMPATIBLE Personal Day
// history in the old, pre-account-scoping unowned local cache while the signed-in account's synced
// history is missing part of it (the real production scenario: an anchor round-tripped through
// Firebase's null-pruning and lost its paired custom revision — see
// personal-day-boundary-wire-encoding.test.js).
//
// ── the core correction this version makes ──────────────────────────────────
//
// The FIRST version of this module reasoned "remote's facts are a subset of legacy's, the union
// validates, therefore this is provably safe to recover." That is a STRUCTURAL/COMPATIBILITY
// argument, not a PROVENANCE argument — the unowned cache never recorded which account created it
// (nothing this app persists proves ownership), so content compatibility can never be treated as
// ownership proof. A same-timezone Account B, or an authoritatively empty Account B, can be
// "compatible" with A's old cache purely by coincidence or by genuinely being a different device the
// SAME owner also used — the software cannot tell the difference, and must never claim to.
//
// So this version separates the two questions cleanly:
//   - analyzeRecoveryCompatibility() answers ONLY "is appending {missing} to the account's current
//     cloud history structurally safe" (deterministic, append-only, no contradiction). It returns
//     `compatible`, never `recoverable`/`provenSafe`/`safe` — a label that could be read as a
//     provenance claim.
//   - The human owner's EXPLICIT ATTESTATION — a session-local, opt-in, never-persisted UI state,
//     re-validated against the CURRENT room and the CURRENT compatibility analysis every time it
//     matters — is the only provenance gate. recover() refuses outright, zero writes, whenever
//     attestation is missing or stale (a different room since it was given, or a changed
//     compatibility analysis since it was given).
//
// Never adopts the unowned cache automatically, never deletes or rewrites anything already in the
// cloud, and never constructs its own write path — recover() only ever appends via the existing
// sync bridge's own tested, transactional, idempotent pushRevision().

import {
  activeBoundaryRevision,
  normalizeBoundaryRevisionHistory,
  revisionsAreSemanticDuplicates,
  validateBoundaryRevision,
} from './personal-day-boundary-model.js';
import {
  createPersonalDayBoundaryRepository,
  PERSONAL_DAY_BOUNDARY_STORAGE_KEY,
} from './personal-day-boundary-repository.js';
import { DAY_BOUNDARY_REVISIONS_REMOTE_PATH, decodeWireMap } from './personal-day-boundary-sync.js';

/** Categorizes one revision collection (never mutates, never writes). Counts and a category label
 *  only — safe for both the confirmation UI (which may also show real boundary times, exactly as
 *  Settings already does) and the read-only diagnostics screen (which must not).
 *  `reason` is one of: 'none' (empty), 'malformed' (a structurally invalid entry, or duplicate ids),
 *  'missing-anchor', 'duplicate-anchor', 'contradiction' (two entries share an effective instant
 *  under different facts), 'valid'. Always independently re-verified against the model's own
 *  normalizeBoundaryRevisionHistory before `valid` is ever reported true.
 *  @param {object[]} revisions @returns {{totalCount:number, anchorCount:number, boundaryCount:number, valid:boolean, reason:string}} */
export function classifyRevisions(revisions) {
  const list = Array.isArray(revisions) ? revisions : [];
  if (!list.length) return { totalCount: 0, anchorCount: 0, boundaryCount: 0, valid: false, reason: 'none' };
  const structurallyValid = list.filter(r => validateBoundaryRevision(r));
  if (structurallyValid.length !== list.length) {
    return { totalCount: list.length, anchorCount: 0, boundaryCount: 0, valid: false, reason: 'malformed' };
  }
  const ids = structurallyValid.map(r => r.id);
  if (new Set(ids).size !== ids.length) {
    return { totalCount: list.length, anchorCount: 0, boundaryCount: 0, valid: false, reason: 'malformed' };
  }
  const anchors = structurallyValid.filter(r => r.effectiveFromInstant === null);
  const timed = structurallyValid.filter(r => r.effectiveFromInstant !== null);
  const anchorCount = anchors.length;
  const boundaryCount = timed.length;
  if (anchorCount === 0) return { totalCount: list.length, anchorCount, boundaryCount, valid: false, reason: 'missing-anchor' };
  if (anchorCount > 1) return { totalCount: list.length, anchorCount, boundaryCount, valid: false, reason: 'duplicate-anchor' };
  const instants = timed.map(r => r.effectiveFromInstant);
  if (new Set(instants).size !== instants.length) {
    return { totalCount: list.length, anchorCount, boundaryCount, valid: false, reason: 'contradiction' };
  }
  try {
    normalizeBoundaryRevisionHistory(structurallyValid); // final authority — e.g. misaligned activation
    return { totalCount: list.length, anchorCount, boundaryCount, valid: true, reason: 'valid' };
  } catch {
    return { totalCount: list.length, anchorCount, boundaryCount, valid: false, reason: 'malformed' };
  }
}

/** Whether `needle` is already represented in `haystack` — either the exact same id with identical
 *  facts, or the same fact (boundaryTime/timezone/effectiveFromInstant) under a different id. This
 *  is a STRUCTURAL/COMPATIBILITY test only — it decides whether two histories could be merged
 *  without contradiction. It is deliberately never used, and must never be read, as an ownership or
 *  identity proof: two accounts can share a semantically-identical fact (the reserved anchor id is
 *  shared by every account by construction, and two independent owners could each choose the same
 *  clock time) without that meaning anything about who made either record. */
function representedIn(needle, haystack) {
  const exact = haystack.find(r => r.id === needle.id);
  // Field-by-field, order-independent — a real Firebase round-trip can decode an object whose key
  // order differs from a same-content object read out of localStorage (RTDB reconstructs `.val()`
  // in its own child-key order, never necessarily the order the fields were originally written in),
  // so a byte-level JSON.stringify comparison here would misjudge two identical revisions as
  // different. revisionsAreSemanticDuplicates already ignores key order and doesn't need `id`
  // repeated in the comparison, since `exact` was found by matching `id` already.
  if (exact) return revisionsAreSemanticDuplicates(exact, needle);
  return haystack.some(r => revisionsAreSemanticDuplicates(r, needle));
}

/** Pure. Decides whether appending some subset of `legacyRevisions` to the account's current cloud
 *  history (`remoteRevisions`) is a STRUCTURALLY COMPATIBLE, deterministic, append-only completion.
 *  `compatible: true` is a compatibility fact, never a provenance claim — the caller (the live
 *  wiring below) is responsible for gating any actual mutation behind an explicit owner attestation.
 *  @param {{remoteRevisions:object[], legacyRevisions:object[], scopedHasApplicableHistory:boolean}} input
 *  @returns {{remote:object, legacy:object, compatible:boolean, reason:string|null, missing:object[]}} */
export function analyzeRecoveryCompatibility({ remoteRevisions = [], legacyRevisions = [], scopedHasApplicableHistory = false } = {}) {
  const remote = classifyRevisions(remoteRevisions);
  const legacy = classifyRevisions(legacyRevisions);
  const base = { remote, legacy, missing: [] };

  if (scopedHasApplicableHistory) return { ...base, compatible: false, reason: 'account-already-configured' };
  if (legacy.totalCount === 0) return { ...base, compatible: false, reason: 'no-legacy-data' };
  if (!legacy.valid) return { ...base, compatible: false, reason: 'legacy-invalid' };
  // A per-entry structural defect (not "the collection as a whole is missing its anchor" — that is
  // exactly what legacy may safely complete, and is handled generically by the union check below,
  // never by silently dropping the bad entry) is never safe to reason about at all.
  if (remoteRevisions.some(r => !validateBoundaryRevision(r))) return { ...base, compatible: false, reason: 'remote-malformed' };

  const legacyValid = legacyRevisions.filter(r => validateBoundaryRevision(r));
  const remoteValid = remoteRevisions.filter(r => validateBoundaryRevision(r));

  // §E-equivalent: every fact the cloud already holds must be represented in the legacy history —
  // a cloud revision legacy does not have at all (exact id+facts, or the same fact under another
  // id) is a real structural difference between the two histories, not something to reconcile
  // silently. This is a compatibility check, not a provenance one.
  const unmatchedRemote = remoteValid.filter(r => !representedIn(r, legacyValid));
  if (unmatchedRemote.length) return { ...base, compatible: false, reason: 'remote-not-compatible-with-legacy' };

  // The legacy revisions genuinely missing from the cloud — never one already represented there
  // (exactly, or as a semantic duplicate under a different id, which recovery must never re-push
  // under a competing identity — that would be an identity rewrite, never a pure append).
  const missing = legacyValid.filter(r => !representedIn(r, remoteValid));
  if (!missing.length) return { ...base, compatible: false, reason: 'nothing-missing' };

  // Union validity: the cloud's own valid revisions plus exactly the missing legacy ones must
  // themselves form a structurally valid history before this is ever offered as a candidate.
  const unionById = {};
  remoteValid.forEach(r => { unionById[r.id] = r; });
  missing.forEach(r => { unionById[r.id] = r; }); // never collides with an existing cloud id — see representedIn above
  let unionValid = false;
  try { normalizeBoundaryRevisionHistory(Object.values(unionById)); unionValid = true; } catch { unionValid = false; }
  if (!unionValid) return { ...base, compatible: false, reason: 'union-invalid' };

  return { ...base, compatible: true, reason: null, missing };
}

/** A pure, order-independent fingerprint of "what would be appended, to which account" — used only
 *  to detect that an attestation has gone stale (the account changed, or the compatible set changed)
 *  since it was given. Never persisted; recomputed fresh every time attestation is checked. */
function compatibilityFingerprint(roomId, missing) {
  return JSON.stringify({ roomId, missing: [...missing].sort((a, b) => (a.id < b.id ? -1 : 1)) });
}

/** Live wiring: reads the account's current cloud snapshot from the existing sync bridge (never a
 *  new subscription) and the device's legacy unowned cache, and — only on explicit, current, valid
 *  owner attestation — appends the missing revisions via the bridge's own pushRevision(), then reads
 *  back to confirm.
 *  @param {object} deps
 *  @param {object} deps.live the PersonalDayBoundaryLive wiring (for the account-scoped status)
 *  @param {object} deps.boundarySync the PersonalDayBoundarySync bridge (for the cloud snapshot + push)
 *  @param {function():string|null} [deps.getRoomId] the currently joined room's identity — the same
 *    identity pushRevision() itself checks; attestation is scoped to this, not to a display label
 *  @param {object} [deps.legacyRepository] an UNSCOPED boundary repository over the legacy key;
 *    defaults to one over real localStorage, guarded the same way every other browser singleton is
 *  @param {function():object|null} [deps.getRoomRef] for the post-recovery read-back only
 */
export function createPersonalDayBoundaryRecovery(deps = {}) {
  const live = deps.live;
  const boundarySync = deps.boundarySync;
  const getRoomId = typeof deps.getRoomId === 'function' ? deps.getRoomId : () => null;
  const legacyRepository = deps.legacyRepository
    || createPersonalDayBoundaryRepository({ storage: globalThis.localStorage, key: PERSONAL_DAY_BOUNDARY_STORAGE_KEY });
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;

  // ── owner attestation (session-local UI state; NEVER persisted as account data) ────────────────
  // false by default; set only by an explicit attest() call (the UI's checkbox), never inferred from
  // a button click or any other action. Recorded against the exact room + compatible-set fingerprint
  // it was given for, so a later re-check (isAttested()) can detect it going stale on its own —
  // no event wiring required, and nothing here needs to "remember" to reset it: a reload starts this
  // module fresh (attested defaults to false again), an account switch changes the room id the
  // fingerprint is compared against, and a remote change alters the `missing` set the fingerprint
  // covers. All three collapse to the same check.
  let attestation = { attested: false, roomId: null, fingerprint: null };

  /** Never throws. `null` gate reasons ('no-sync' / 'sync-not-ready') mean "too early to know" —
   *  distinct from every `analyzeRecoveryCompatibility` reason, which means "known, and not safe." */
  function status() {
    if (!live || !boundarySync || typeof boundarySync.syncState !== 'function') {
      return { compatible: false, reason: 'no-sync', remote: null, legacy: null, missing: [], attestationRequired: false, attested: false };
    }
    // Reasoning about compatibility before the account has actually answered would compare the
    // legacy cache against a snapshot that might still change — refuse until synced, exactly like
    // proposeBoundary()'s own accountAnswerBlock() gate.
    if (boundarySync.syncState() !== 'synced') {
      return { compatible: false, reason: 'sync-not-ready', remote: null, legacy: null, missing: [], attestationRequired: false, attested: false };
    }
    let scopedStatus;
    try { scopedStatus = live.status(); } catch { scopedStatus = { status: 'invalid' }; }
    const scopedHasApplicableHistory = scopedStatus.status === 'custom';
    // legacyRepository.status() distinguishes "nothing stored at all" (absent) from "something is
    // stored and it does not validate" (invalid) — a caller-facing distinction analyzeRecoveryCompatibility
    // itself also makes ('no-legacy-data' vs 'legacy-invalid'), so it is read through status() rather
    // than listAllRaw() (which would silently collapse both into an empty array).
    const legacyStatus = legacyRepository.status();
    if (legacyStatus.status === 'invalid') {
      return { remote: null, legacy: { totalCount: 0, anchorCount: 0, boundaryCount: 0, valid: false, reason: 'malformed' }, missing: [], compatible: false, reason: 'legacy-invalid', attestationRequired: false, attested: false };
    }
    const legacyRevisions = legacyStatus.status === 'custom' ? legacyStatus.revisions : [];
    const remoteRevisions = typeof boundarySync.remoteRevisionsSnapshot === 'function'
      ? Object.values(boundarySync.remoteRevisionsSnapshot())
      : [];
    const analysis = analyzeRecoveryCompatibility({ remoteRevisions, legacyRevisions, scopedHasApplicableHistory });
    if (!analysis.compatible) {
      return { ...analysis, attestationRequired: false, attested: false };
    }
    // Display-only, for the confirmation UI (which already shows real boundary times elsewhere in
    // Settings — this is not the content-free diagnostics view): the boundary the account would
    // resolve to right now if this candidate were appended. The legacy history's own facts are used
    // directly — the compatibility check above already established every cloud fact is represented
    // in it, so this reads the same effective boundary the union would produce.
    const legacyValid = legacyRevisions.filter(r => validateBoundaryRevision(r));
    let previewActive = null;
    try { previewActive = activeBoundaryRevision(legacyValid, Date.now()); } catch { previewActive = null; }
    return { ...analysis, attestationRequired: true, attested: isAttested(analysis), previewActive };
  }

  /** True only if an attestation was explicitly given, for the CURRENT room, covering EXACTLY the
   *  CURRENT compatible set. Any mismatch (a different room since attestation, or the compatible set
   *  having changed since — remote arrived, or the account's own scoped state changed) reads as not
   *  attested, with no separate "invalidated" event needed: this is recomputed fresh every call. */
  function isAttested(analysis) {
    if (!attestation.attested) return false;
    const roomId = getRoomId();
    if (!roomId || roomId !== attestation.roomId) return false;
    return compatibilityFingerprint(roomId, analysis.missing) === attestation.fingerprint;
  }

  /** The explicit owner action: "I confirm this setting is mine and belongs to the account I am
   *  currently signed in to." Recorded against the CURRENT room + CURRENT compatible set only — a
   *  later change to either silently invalidates it (see isAttested); this function does not need to
   *  be called again on every keystroke, only when the checkbox is (re)checked.
   *  @returns {boolean} whether the attestation was actually recorded (false if there is nothing
   *    eligible to attest to right now — a defensive no-op, never a UI error). */
  function attest() {
    const analysis = status();
    if (!analysis.compatible) return false;
    const roomId = getRoomId();
    if (!roomId) return false;
    attestation = { attested: true, roomId, fingerprint: compatibilityFingerprint(roomId, analysis.missing) };
    return true;
  }

  /** Explicit withdrawal (the checkbox unchecked). Also called defensively by recover() itself after
   *  every attempt, success or failure — an attestation is single-use in spirit: the UI must ask
   *  again for a second recovery action rather than silently reusing an old confirmation. */
  function clearAttestation() {
    attestation = { attested: false, roomId: null, fingerprint: null };
  }

  /** Appends exactly the missing revisions this analysis found, via the bridge's own pushRevision()
   *  (validated, idempotent, transactional — never a bespoke write path), then reads back to
   *  confirm. Refuses outright, zero writes, unless a CURRENT, CURRENT-room-scoped attestation is
   *  present — re-checked here (not just trusted from whatever the UI last rendered), so a stale
   *  render can never smuggle a mutation through. Never blind-retries: one attempt, one honest
   *  outcome, and the attestation is cleared afterward either way.
   *  @returns {Promise<{outcome:'not-eligible'|'not-attested'|'recovered'|'uncertain'|'failed', reason?:string, pushResults?:object[]}>} */
  function recover() {
    const analysis = status();
    if (!analysis.compatible) return Promise.resolve({ outcome: 'not-eligible', reason: analysis.reason });
    // Re-verify against the room the attestation was actually given for — "before each mutation,
    // verify active room still matches the room for which the attestation was given."
    if (!isAttested(analysis)) return Promise.resolve({ outcome: 'not-attested' });
    const attestedRoomId = attestation.roomId;
    const missing = analysis.missing;
    return Promise.all(missing.map(r => boundarySync.pushRevision(r))).then(pushResults => {
      clearAttestation(); // single-use — a further recovery action requires asking the owner again
      // A room switch mid-flight is also caught by pushRevision's own owner-mismatch re-check inside
      // its transaction (personal-day-boundary-sync.js), but confirm it here too before trusting the
      // read-back against what this call believed the room to be.
      if (getRoomId() !== attestedRoomId) return { outcome: 'uncertain', pushResults };
      const roomRef = getRoomRef();
      if (!roomRef) return { outcome: 'uncertain', pushResults };
      let ref;
      try {
        ref = roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH);
        if (typeof ref.once !== 'function') return { outcome: 'uncertain', pushResults };
      } catch {
        return { outcome: 'uncertain', pushResults };
      }
      return ref.once('value').then(snap => {
        const raw = typeof snap?.val === 'function' ? snap.val() : null;
        const decoded = decodeWireMap(raw || {});
        // Same order-independence requirement as representedIn() above, and the same reason: this
        // compares a freshly-decoded post-push Firebase read-back against a locally-held revision.
        const stillMissing = missing.filter(r => !(decoded[r.id] && revisionsAreSemanticDuplicates(decoded[r.id], r)));
        // Idempotent — applies the (now more complete) history to the scoped cache and fires the
        // same recompute chain any ordinary remote arrival does. Never a bespoke merge path.
        boundarySync.handleRemoteSnapshot(raw || {});
        if (!stillMissing.length) return { outcome: 'recovered', pushResults };
        if (stillMissing.length === missing.length) return { outcome: 'failed', pushResults };
        return { outcome: 'uncertain', pushResults, stillMissing: stillMissing.map(r => r.id) };
      }).catch(() => ({ outcome: 'uncertain', pushResults }));
    });
  }

  return { status, attest, clearAttestation, isAttested: () => isAttested(status()), recover };
}

// A ready-to-use singleton for the real app (index.html) only — constructing the default legacy
// repository touches localStorage, which does not exist under plain `node --test`. Tests always
// build their own wiring with createPersonalDayBoundaryRecovery(fakeDeps).
if (typeof window !== 'undefined') {
  window.PersonalDayBoundaryRecovery = createPersonalDayBoundaryRecovery({
    live: window.PersonalDayBoundaryLive,
    boundarySync: window.PersonalDayBoundarySync,
    getRoomId: () => (typeof globalThis.getChronaSenseRoomCode === 'function' ? globalThis.getChronaSenseRoomCode() : null),
    getRoomRef: () => (typeof globalThis.getChronaSenseRoomRef === 'function' ? globalThis.getChronaSenseRoomRef() : null),
  });
}
