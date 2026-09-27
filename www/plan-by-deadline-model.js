// plan-by-deadline-model.js
//
// Pure, authoritative "Plan-by deadline" contract. Foundation layer only — no
// storage access, no DOM, no Firebase, no Date.now() hidden inside any
// derivation (every function accepts its reference instant/timezone
// explicitly), mirroring personal-day-boundary-model.js's discipline.
//
// A Plan-by deadline is NOT an operational-day boundary. It does not define
// what "today" is, does not group timeline entries, and does not carry its
// own timezone — it reuses whatever the account's single authoritative
// timezone currently is (callers pass it in explicitly; see project decision
// against a second timezone source). It answers exactly one question: by
// what wall-clock instant, on a given calendar date, must today's planning
// obligation (a prepared plan or an intentional off-day) have been satisfied
// for the planning streak to count that date as maintained?
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
 *  decision, not a default. */
export function validateDeadlineRevision(revision) {
  return !!revision && typeof revision === 'object'
    && validRevisionId(revision.id)
    && validDeadlineTime(revision.deadlineTime)
    && Number.isFinite(revision.effectiveFromInstant) && revision.effectiveFromInstant >= 0;
}

/** Two revisions are semantic duplicates (for concurrent-proposal dedup, a
 *  persistence-layer concern) when they name the same deadline time
 *  activating at the same instant, regardless of `id`.
 *  @param {object} a @param {object} b @returns {boolean} */
export function revisionsAreSemanticDuplicates(a, b) {
  return a.deadlineTime === b.deadlineTime && a.effectiveFromInstant === b.effectiveFromInstant;
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
 *  @param {object[]} revisions @param {{id:string,deadlineTime:string}} candidate
 *  @param {number} nowMs @returns {{revision:object, revisions:object[]}} */
export function proposeDeadlineRevision(revisions, candidate, nowMs) {
  if (!validRevisionId(candidate?.id) || !validDeadlineTime(candidate?.deadlineTime)) {
    throw new Error('A valid candidate revision (id, deadlineTime) is required.');
  }
  if (!Number.isFinite(nowMs)) throw new Error('A valid reference instant (nowMs) is required.');
  const revision = {
    id: candidate.id,
    deadlineTime: candidate.deadlineTime,
    // nextBoundaryInstant only reads rule.boundaryTime/rule.timezone; timezone
    // must be supplied by the caller (the account's current authoritative
    // timezone) since a deadline revision itself carries none.
    effectiveFromInstant: nextBoundaryInstant(nowMs, { boundaryTime: candidate.deadlineTime, timezone: candidate.timezone }),
  };
  return { revision, revisions: normalizeDeadlineRevisionHistory([...revisions, revision]) };
}

/** The deadline instant for one specific calendar date, or `null` if the
 *  deadline was unconfigured for that date (no revision had taken effect by
 *  the end of that date). Accounts for a revision change taking over partway
 *  through the date: since a revision's effectiveFromInstant is always an
 *  occurrence of ITS OWN deadline time (by construction of
 *  proposeDeadlineRevision), a revision that takes effect on this date before
 *  the previously-active revision's own deadline time would have fired
 *  supersedes it outright — its effectiveFromInstant *is* that date's
 *  deadline instant.
 *  @param {string} dateStr YYYY-MM-DD @param {string} timezone @param {object[]} revisions
 *  @returns {number|null} UTC ms, or null if unconfigured for this date */
export function deadlineInstantForCalendarDate(dateStr, timezone, revisions) {
  const normalized = normalizeDeadlineRevisionHistory(revisions);
  if (!normalized.length) return null;
  const startOfDateMs = resolveCivilBoundary(dateStr, '00:00', timezone);
  const nextDateStr = new Date(`${dateStr}T12:00:00Z`);
  nextDateStr.setUTCDate(nextDateStr.getUTCDate() + 1);
  const endOfDateMs = resolveCivilBoundary(nextDateStr.toISOString().slice(0, 10), '00:00', timezone);

  const active = activeDeadlineRevision(normalized, startOfDateMs);
  let naiveInstant = null;
  if (active) naiveInstant = resolveCivilBoundary(dateStr, active.deadlineTime, timezone);

  // Any revision whose effectiveFromInstant falls within this date, at or
  // before the naive candidate's own instant (or anywhere in the date if
  // there was no active candidate at all — a first-ever mid-date
  // configuration), takes over: its effectiveFromInstant *is* the correct
  // deadline instant for this date.
  const upperBound = naiveInstant !== null ? naiveInstant : endOfDateMs;
  const preempting = normalized
    .filter(r => r.effectiveFromInstant > startOfDateMs && r.effectiveFromInstant < endOfDateMs && r.effectiveFromInstant <= upperBound)
    .reduce((earliest, r) => (earliest === null || r.effectiveFromInstant < earliest.effectiveFromInstant ? r : earliest), null);

  if (preempting) return preempting.effectiveFromInstant;
  return naiveInstant;
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
