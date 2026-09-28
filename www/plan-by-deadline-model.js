// plan-by-deadline-model.js
//
// Pure, authoritative "Plan-by deadline" contract. Foundation layer only — no
// storage access, no DOM, no Firebase, no Date.now() hidden inside any
// derivation (every function accepts its reference instant/timezone
// explicitly), mirroring personal-day-boundary-model.js's discipline.
//
// A Plan-by deadline is NOT an operational-day boundary. It does not define
// what "today" is and does not group timeline entries. It answers exactly one
// question: by what wall-clock instant, on a given calendar date, must today's
// planning obligation (a prepared plan or an intentional off-day) have been
// satisfied for the planning streak to count that date as maintained?
//
// ── revision-owned timezone (FIX FIRST correction) ─────────────────────────
//
// An earlier version of this module resolved every deadline instant against
// whatever the ACCOUNT'S CURRENT timezone happened to be at read time. That is
// a real historical-truth bug: a later timezone change (a move, a device
// misconfiguration corrected) could silently change what an ALREADY-DECIDED
// past day's maintained/missed result was, purely because "now" reads
// differently. A revision's own timezone is captured once, at propose() time,
// and never re-resolved against a later "current" value — exactly the same
// discipline personal-day-boundary-model.js already uses for BoundaryRevision.
// A timezone change is only ever prospective: it takes effect via a NEW
// revision (propose() again), never by mutating history.

/** The revision governing a real-world instant is decided purely from
 *  ABSOLUTE instants (effectiveFromInstant, already UTC ms) — never by mixing
 *  civil-time math across two different revisions' timezones. A per-date
 *  deadline instant is found by a small forward simulation
 *  (deadlineInstantForCalendarDate below), not by picking "the" timezone for a
 *  date up front — there may be none if timezones genuinely differ across a
 *  transition, and instant-space comparison never needs one. */
//
// Unlike a boundary revision history, a deadline revision history has NO
// anchor/default revision. Absence of any revision — or an instant before
// the first-ever configured revision — means "unconfigured": streak
// evaluation is paused for that instant, never silently defaulted to some
// guessed clock time (product decision: no existing user should lose a
// streak because software invented 08:00 or 11:00 on their behalf).
//
// Activation is always prospective, reusing personal-day-boundary-model.js's
// `nextBoundaryInstant` primitive: a newly proposed deadline takes effect at
// the next occurrence of ITS OWN clock time at/after "now" — today if that
// time hasn't passed yet, tomorrow otherwise. Nothing before that instant is
// ever reinterpreted; no prior streak history is rewritten by a deadline
// change (input order never decides truth).
//
// DST-safe civil-time resolution, IANA-timezone validation, and revision-id
// conflict resolution are NOT reimplemented here — they are imported from
// personal-day-boundary-model.js, the one authoritative source for that math
// in this codebase, to avoid a second, competing implementation drifting
// from the first.

import {
  validBoundaryTime as validDeadlineTime,
  validOperationalDayTimezone as validDeadlineTimezone,
  canonicalizeOperationalDayTimezone,
  resolveCivilBoundary,
  nextBoundaryInstant,
  pickCanonicalRevisionId,
} from './personal-day-boundary-model.js';

export { validDeadlineTime, validDeadlineTimezone, canonicalizeOperationalDayTimezone, pickCanonicalRevisionId };

function validRevisionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes(':');
}

// ── validation ──────────────────────────────────────────────────────────

/** @param {*} revision @returns {boolean} true for a structurally valid DeadlineRevision.
 *  A deadline revision is never an anchor — `effectiveFromInstant` is always a
 *  real, finite instant (never null): every deadline revision, including the
 *  very first one an account ever configures, is a genuine, timestamped user
 *  decision, not a default. `timezone` is required and immutable once created
 *  (see the module header) — the account's CURRENT timezone is never
 *  substituted for it, at creation or at any later read. */
export function validateDeadlineRevision(revision) {
  return !!revision && typeof revision === 'object'
    && validRevisionId(revision.id)
    && validDeadlineTime(revision.deadlineTime)
    && validDeadlineTimezone(revision.timezone)
    && Number.isFinite(revision.effectiveFromInstant) && revision.effectiveFromInstant >= 0;
}

/** Two revisions are semantic duplicates (for concurrent-proposal dedup, a
 *  persistence-layer concern) when they name the same deadline time, in the
 *  same timezone, activating at the same instant, regardless of `id`. Same
 *  clock reading + same instant but a DIFFERENT timezone is a genuine
 *  difference in what was actually configured, never a duplicate.
 *  @param {object} a @param {object} b @returns {boolean} */
export function revisionsAreSemanticDuplicates(a, b) {
  return a.deadlineTime === b.deadlineTime && a.timezone === b.timezone && a.effectiveFromInstant === b.effectiveFromInstant;
}

/** Two revisions are an EQUAL-AUTHORITY CONTRADICTION (FIX FIRST §14): they
 *  share an effectiveFromInstant (so neither is "more current" than the
 *  other) but disagree on what the rule actually is. Never resolved by id, by
 *  arrival order, or by which device wrote first — see
 *  findEqualAuthorityConflicts / plan-by-deadline-repository.js's
 *  deadlineConflict().
 *  @param {object} a @param {object} b @returns {boolean} */
export function revisionsContradict(a, b) {
  return a.effectiveFromInstant === b.effectiveFromInstant && !revisionsAreSemanticDuplicates(a, b);
}

/** Scans a raw (possibly not yet deduplicated/merged) set of individually-valid
 *  DeadlineRevisions for equal-authority contradictions — two different ids
 *  sharing an effectiveFromInstant with different facts. Returns the groups of
 *  contradicting revisions (each group sharing one effectiveFromInstant), or
 *  [] if the set is internally consistent. Never throws, never picks a
 *  winner: detection only, so a caller can preserve every conflicting fact and
 *  present an explicit conflict state instead of guessing (§14/§15).
 *  @param {object[]} revisions @returns {object[][]} */
export function findEqualAuthorityConflicts(revisions) {
  const byInstant = new Map();
  for (const r of revisions) {
    if (!validateDeadlineRevision(r)) continue;
    if (!byInstant.has(r.effectiveFromInstant)) byInstant.set(r.effectiveFromInstant, []);
    byInstant.get(r.effectiveFromInstant).push(r);
  }
  const conflicts = [];
  for (const group of byInstant.values()) {
    if (group.length < 2) continue;
    const allSame = group.every(r => revisionsAreSemanticDuplicates(r, group[0]));
    if (!allSame) conflicts.push(group);
  }
  return conflicts;
}

/** Validates and sorts a deadline revision history ascending by effective
 *  instant. An empty array is valid and means "never configured." Throws on
 *  any structural violation — these are caller bugs, not runtime states to
 *  degrade through silently.
 *  @param {object[]} revisions @returns {object[]} */
export function normalizeDeadlineRevisionHistory(revisions) {
  if (!Array.isArray(revisions)) throw new Error('A deadline revision history array is required (empty is valid).');
  if (!revisions.every(validateDeadlineRevision)) throw new Error('Every deadline revision must be valid.');
  if (new Set(revisions.map(r => r.id)).size !== revisions.length) throw new Error('Deadline revision ids must be unique.');
  if (new Set(revisions.map(r => r.effectiveFromInstant)).size !== revisions.length) throw new Error('Deadline revision effective instants must be unique.');
  return [...revisions].sort((a, b) => a.effectiveFromInstant - b.effectiveFromInstant);
}

/** The revision governing a given instant — the latest revision whose
 *  effectiveFromInstant is at or before `instantMs`, or `null` if none (the
 *  instant predates the first-ever configured deadline, or none exists yet).
 *  Resolved strictly from the instant itself, never from "the latest
 *  revision," so past instants never silently regroup under a later change.
 *  @param {object[]} revisions @param {number} instantMs @returns {object|null} */
export function activeDeadlineRevision(revisions, instantMs) {
  const normalized = normalizeDeadlineRevisionHistory(revisions);
  let active = null;
  for (const rev of normalized) {
    if (rev.effectiveFromInstant <= instantMs) active = rev;
    else break;
  }
  return active;
}

/** Builds a new DeadlineRevision that activates prospectively — at the next
 *  occurrence of its own deadline clock time from `nowMs` — and appends it to
 *  the history. This is the one rule for §9 activation semantics: if today's
 *  occurrence of the new time hasn't happened yet, the new rule begins today;
 *  if it already has, the new rule begins tomorrow. Never retroactive.
 *  `candidate.timezone` is canonicalized and stored ON the revision — the
 *  account's current timezone AT PROPOSAL TIME becomes an immutable historical
 *  fact; a later account timezone change never touches this revision (see
 *  module header).
 *  @param {object[]} revisions @param {{id:string,deadlineTime:string,timezone:string}} candidate
 *  @param {number} nowMs @returns {{revision:object, revisions:object[]}} */
export function proposeDeadlineRevision(revisions, candidate, nowMs) {
  if (!validRevisionId(candidate?.id) || !validDeadlineTime(candidate?.deadlineTime) || !validDeadlineTimezone(candidate?.timezone)) {
    throw new Error('A valid candidate revision (id, deadlineTime, timezone) is required.');
  }
  if (!Number.isFinite(nowMs)) throw new Error('A valid reference instant (nowMs) is required.');
  const timezone = canonicalizeOperationalDayTimezone(candidate.timezone);
  const revision = {
    id: candidate.id,
    deadlineTime: candidate.deadlineTime,
    timezone,
    effectiveFromInstant: nextBoundaryInstant(nowMs, { boundaryTime: candidate.deadlineTime, timezone }),
  };
  return { revision, revisions: normalizeDeadlineRevisionHistory([...revisions, revision]) };
}

/** The deadline instant for one specific calendar date, or `null` if the
 *  deadline was unconfigured for that date. A pure forward simulation over
 *  absolute instants — no external "current timezone" parameter at all (FIX
 *  FIRST §8/§9): each revision's OWN stored timezone resolves its OWN
 *  candidate instant for `dateStr`; a revision is a valid answer only if (a)
 *  it already existed by the time of its own candidate (effectiveFromInstant
 *  <= candidate — it can't govern a moment before it existed) and (b) no
 *  later revision took over before that candidate fired (the NEXT revision's
 *  effectiveFromInstant, if any, must be AFTER this candidate). Revisions are
 *  walked earliest-first, so the first one satisfying both conditions is the
 *  earliest valid candidate — the only sound answer, since once any revision's
 *  deadline genuinely fires for a date, that IS the date's deadline instant.
 *  This generalizes correctly across a timezone change with no special case:
 *  every comparison here is instant-vs-instant, never civil-time-vs-civil-time
 *  across two different revisions' timezones.
 *  @param {string} dateStr YYYY-MM-DD @param {object[]} revisions
 *  @returns {number|null} UTC ms, or null if unconfigured for this date */
export function deadlineInstantForCalendarDate(dateStr, revisions) {
  const normalized = normalizeDeadlineRevisionHistory(revisions);
  for (let i = 0; i < normalized.length; i++) {
    const r = normalized[i];
    const next = normalized[i + 1];
    const candidate = resolveCivilBoundary(dateStr, r.deadlineTime, r.timezone);
    if (r.effectiveFromInstant > candidate) continue; // r did not exist yet at its own candidate moment for this date
    if (next && next.effectiveFromInstant <= candidate) continue; // superseded before its own candidate fired
    return candidate;
  }
  return null;
}

/** The conflict groups that are still ACTIVE — i.e. not already superseded by
 *  a later, non-contradicting revision (FIX FIRST §14: "permit the user to
 *  resolve by explicitly saving a new prospective revision"). Once the user
 *  proposes any new, clean revision whose effectiveFromInstant is later than a
 *  conflict's shared instant, that conflict stops blocking current/future
 *  evaluation — it remains in storage as historical provenance (never
 *  deleted), but is no longer reported as an open conflict.
 *  @param {object[]} revisions raw, possibly-contradictory, possibly-unmerged
 *  @returns {object[][]} the still-active conflict groups, [] if none */
export function activeEqualAuthorityConflicts(revisions) {
  const conflicts = findEqualAuthorityConflicts(revisions);
  if (!conflicts.length) return [];
  const conflictInstants = new Set(conflicts.map(group => group[0].effectiveFromInstant));
  const cleanInstants = revisions
    .filter(r => validateDeadlineRevision(r) && !conflictInstants.has(r.effectiveFromInstant))
    .map(r => r.effectiveFromInstant);
  const latestCleanInstant = cleanInstants.length ? Math.max(...cleanInstants) : -Infinity;
  return conflicts.filter(group => group[0].effectiveFromInstant > latestCleanInstant);
}

// ── streak qualification (§10, §12) ────────────────────────────────────────

/** Whether today's planning obligation was satisfied by the configured
 *  deadline, from persisted facts alone — never requiring an in-memory timer
 *  to have fired at the deadline instant. `planPreparedAtMs` and
 *  `offDayDeclaredAtMs` are persisted provenance timestamps (or null/undefined
 *  if that fact never happened); either qualifies independently.
 *  @param {number|null} deadlineInstantMs from deadlineInstantForCalendarDate; null means unconfigured for this date
 *  @param {number|null|undefined} planPreparedAtMs when the qualifying plan was created/prepared, or null
 *  @param {number|null|undefined} offDayDeclaredAtMs when an intentional off-day was declared for this date, or null
 *  @returns {{status:'unenforced'|'maintained'|'missed'}} */
export function evaluatePlanningDeadlineQualification(deadlineInstantMs, planPreparedAtMs, offDayDeclaredAtMs) {
  if (deadlineInstantMs === null || deadlineInstantMs === undefined) return { status: 'unenforced' };
  const planQualifies = Number.isFinite(planPreparedAtMs) && planPreparedAtMs < deadlineInstantMs;
  const offDayQualifies = Number.isFinite(offDayDeclaredAtMs) && offDayDeclaredAtMs < deadlineInstantMs;
  return { status: (planQualifies || offDayQualifies) ? 'maintained' : 'missed' };
}

// ── intentional off-day (§11) ───────────────────────────────────────────────

/** @param {*} record @returns {boolean} true for a structurally valid IntentionalOffDayRecord. */
export function validateIntentionalOffDayRecord(record) {
  return !!record && typeof record === 'object'
    && typeof record.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.dateKey)
    && Number.isFinite(record.declaredAtMs) && record.declaredAtMs >= 0
    // >= , not strictly >: a revoke made in the same instant as the declare (a fast
    // double-action, or a frozen/mocked clock) is a real, valid case — there is no
    // principled reason a revoke must be strictly LATER than its own declare.
    && (record.revokedAtMs === null || record.revokedAtMs === undefined || (Number.isFinite(record.revokedAtMs) && record.revokedAtMs >= record.declaredAtMs));
}

/** The provenance timestamp to use for streak qualification: the record's
 *  declaration instant, unless it was revoked before the deadline (then it
 *  never qualifies), matching §11's "reversible before the deadline" rule.
 *  @param {object|null|undefined} record IntentionalOffDayRecord @param {number} deadlineInstantMs
 *  @returns {number|null} */
export function offDayDeclaredAtForDeadline(record, deadlineInstantMs) {
  if (!record) return null;
  if (Number.isFinite(record.revokedAtMs) && record.revokedAtMs < deadlineInstantMs) return null;
  return record.declaredAtMs;
}
