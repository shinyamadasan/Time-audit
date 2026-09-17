// personal-day-boundary-model.js
//
// Pure, authoritative "operational day" contract. Foundation layer only — no
// storage access, no DOM, no Firebase, no Date.now() hidden inside any
// derivation (every function accepts its reference instant explicitly).
//
// Three distinct facts, never collapsed into each other:
//   - Occurrence time  — the original factual timestamp. Never rewritten here.
//   - Calendar date    — the civil-calendar date in a timezone (unchanged).
//   - Operational day  — a planning/grouping interval derived from a boundary
//                         clock time + timezone + boundary revision.
//
// An operational day is a half-open interval [start, nextStart): an instant
// exactly at the boundary belongs to the day that starts there, never the one
// that ends there.
//
// Boundary revisions are revisioned/effective truth, not one mutable current
// value (§7). Every revision history array must contain exactly one "anchor"
// revision with effectiveFromInstant: null — the revision in force since
// before any boundary decision was ever made. A record governed by the
// anchor revision is, by contract, under legacy calendar-day semantics (§9):
// absence of a later revision is what *means* legacy, not absence of some
// other field. Anchor revisions default to boundaryTime '00:00', which is
// exactly why operational-day math reduces to plain calendar-day math for
// every user who has never set a boundary (§4 default compatibility).
//
// Operational-day identity (§6) is the structured ref below, never a bare
// YYYY-MM-DD string and never an array index or display label — a bare
// date string is already spoken for as a legacy plan `dateKey`, and reusing
// it for operational-day identity would silently conflate the two contracts
// the first time a non-midnight boundary is introduced (§10). The versioned,
// namespaced `operationalDayId()` string can never collide with a legacy
// `dateKey` because it is not a bare date.
//
// This module does not decide when a boundary change takes effect for any
// particular user, does not read or write settings, and does not migrate any
// existing record. It only gives later phases the primitives to do that
// safely: `proposeBoundaryRevision` computes a prospective effective instant
// (§8) from an explicit "now" and an explicit currently-active rule; nothing
// here ever reinterprets a past instant under a revision that did not govern
// it yet (§11), because every read (`operationalDayContaining`,
// `activeBoundaryRevision`) resolves strictly from the instant being asked
// about, not from "whatever the latest revision is."
//
// ── Civil-time truth (post-review correction) ─────────────────────────────
//
// A local "date + HH:MM" is not always a clean bijection with UTC instants.
// Around a DST-style offset change, a wall-clock reading can occur twice
// (fall-back: the hour repeats — AMBIGUOUS) or not at all (spring-forward: the
// hour is skipped — NONEXISTENT). `resolveLocalWallClock` is the one
// authoritative low-level mechanism that tells the truth about which case
// applies; every other function in this module that needs a civil-time ->
// instant conversion goes through it. There is deliberately no second,
// competing wall-clock conversion anywhere in this file.
//
// Two different, deliberately DISTINCT policies sit on top of that one
// mechanism, because they answer different questions:
//
//   - Boundary recurrence (`resolveCivilBoundary`, used internally for every
//     day-boundary computation) needs a deterministic daily anchor no matter
//     what — a day must always have a start and an end. Its policy:
//     ambiguous -> earlier occurrence; nonexistent -> advance by the DST gap
//     to the first valid instant after it. This is "compatible" mode, the
//     same style most civil calendaring systems use for recurring events,
//     and it is now an explicit, tested contract rather than whatever an
//     iterative offset-correction loop happened to converge to.
//
//   - A user-planned clock time (`resolveClockTimeInOperationalDay`,
//     `resolvePlannedRangeInOperationalDay`) is a factual intention, not a
//     recurrence rule. It must never be silently moved to a different time
//     than the one requested. A nonexistent planned time fails explicitly.
//     An ambiguous planned time exposes the ambiguity and requires the
//     caller to supply an explicit `disambiguate: 'earlier' | 'later'` to
//     proceed — it is never guessed. Foundation V1 has no UI caller yet, so
//     failing safely is strictly preferable to guessing on its behalf.
//
// These two policies must stay distinct: collapsing them would either make
// day boundaries occasionally undefined (unacceptable — every instant must
// belong to exactly one operational day) or make planned times silently
// drift (exactly the bug this correction exists to fix).

export const OPERATIONAL_DAY_SCHEMA_VERSION = 1;
export const LEGACY_CALENDAR_DAY_REVISION_ID = 'legacy-calendar-day-v0';

const ID_PREFIX = 'odv1';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ── validation ──────────────────────────────────────────────────────────

/** @param {string} value @returns {boolean} true for a real, canonical YYYY-MM-DD calendar date */
export function validBoundaryStartDate(value) {
  return typeof value === 'string' && DATE_RE.test(value)
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

/** @param {string} value @returns {boolean} true for a zero-padded 24h "HH:MM" */
export function validBoundaryTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** @param {string} value @returns {boolean} true for an IANA zone Intl can resolve.
 *  Does not itself canonicalize aliases (e.g. "Asia/Calcutta" vs "Asia/Kolkata")
 *  — see `canonicalizeOperationalDayTimezone` below, which is the one
 *  authoritative rule a persistence phase must run any external timezone
 *  string through before it reaches a stored revision or an
 *  `operationalDayId()`. */
export function validOperationalDayTimezone(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes(':')) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; } catch { return false; }
}

/** The one authoritative timezone canonicalization rule (§7 of the persistence phase that
 *  first stores real timezone strings from settings/Firebase in this module's contract).
 *  Resolves an IANA zone name/alias to its runtime's canonical form via
 *  `Intl.DateTimeFormat`'s own `resolvedOptions().timeZone` (ECMA-402's CanonicalizeTimeZoneName
 *  — the same IANA alias table every supported runtime already ships to answer
 *  `validOperationalDayTimezone`, not a second hand-maintained table that would drift from it).
 *  Deterministic and reproducible *within one runtime's tzdata version* — the only reproducibility
 *  gap is IANA tzdata itself occasionally renaming a zone across years (e.g. Europe/Kiev ->
 *  Europe/Kyiv), which is a pre-existing risk this module's timezone validity already depends on,
 *  not one this function introduces. A persisted revision's `timezone` must always be the
 *  canonicalized string, never the raw alias a caller happened to pass in, so two callers naming
 *  the same civil rules by different alias strings converge on one `operationalDayId()` identity
 *  instead of silently forking it.
 *  @param {string} value @returns {string} canonical IANA zone name
 *  @throws {Error} if `value` is not a timezone Intl can resolve */
export function canonicalizeOperationalDayTimezone(value) {
  if (!validOperationalDayTimezone(value)) throw new Error(`Not a resolvable IANA timezone: ${value}`);
  return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
}

function validRevisionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes(':');
}

/** @param {*} revision @returns {boolean} */
export function validateBoundaryRevision(revision) {
  return !!revision && typeof revision === 'object'
    && validRevisionId(revision.id)
    && validBoundaryTime(revision.boundaryTime)
    && validOperationalDayTimezone(revision.timezone)
    && (revision.effectiveFromInstant === null
      || (Number.isFinite(revision.effectiveFromInstant) && revision.effectiveFromInstant >= 0));
}

/** Two revisions are semantically equivalent for concurrent-proposal
 *  deduplication (a persistence-layer concern; see personal-day-boundary-
 *  repository.js/-sync.js) when every immutable fact that determines their
 *  MEANING matches, regardless of `id` — a revision's id is an arbitrary,
 *  independently-generated identity token, never itself a semantic fact.
 *  A revision currently carries exactly three such facts: `boundaryTime`,
 *  `timezone` (already canonicalized — see canonicalizeOperationalDayTimezone;
 *  this function does not itself canonicalize, so two facts naming the same
 *  civil rule via different un-canonicalized alias strings are correctly
 *  treated as NOT equivalent here — that is a real difference in what was
 *  actually persisted, not a false negative), and `effectiveFromInstant`.
 *  Two revisions sharing an `effectiveFromInstant` but differing in
 *  `boundaryTime` or `timezone` are a genuine CONTRADICTION, not a duplicate
 *  — callers must reject that case, never merge or pick a favorite.
 *  @param {object} a @param {object} b @returns {boolean} */
export function revisionsAreSemanticDuplicates(a, b) {
  return a.boundaryTime === b.boundaryTime && a.timezone === b.timezone && a.effectiveFromInstant === b.effectiveFromInstant;
}

/** The one deterministic, input-order-independent rule for choosing which of
 *  two semantically-equivalent revisions' ids survives as canonical when two
 *  devices independently proposed the same fact with different randomly-
 *  generated ids (§5 of the persistence-atomicity contract). Plain
 *  lexicographic minimum: depends only on the two id strings themselves, so
 *  it produces the same winner regardless of which device's write reaches a
 *  shared store first, which device's transaction retries first, or the
 *  order either id was generated in. This is intentionally NOT "first
 *  writer wins," "most recently updated," or any other order-dependent rule
 *  — those would make the outcome depend on race timing, defeating the
 *  point of a deterministic convergence rule.
 *  @param {string} idA @param {string} idB @returns {string} idA or idB, whichever sorts first */
export function pickCanonicalRevisionId(idA, idB) {
  return idA <= idB ? idA : idB;
}

// ── self-contained date math (no ambient globals, no imports) ────────────

function addCalendarDate(dateStr, amount) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

function formatDateKey(instantMs, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(instantMs));
}

function formatHHMM(instantMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(instantMs));
  const h = (parts.find(p => p.type === 'hour')?.value || '00').replace(/^24$/, '00');
  const m = parts.find(p => p.type === 'minute')?.value || '00';
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

// ── the one authoritative civil-time <-> instant mechanism ────────────────

/** The timezone's offset from UTC, in minutes (east-of-Greenwich positive),
 *  in effect at a given real instant. Instant -> local is always a well-
 *  defined function (no ambiguity in this direction), so this alone is safe. */
function tzOffsetMinutes(instantMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = type => parseInt(parts.find(p => p.type === type).value, 10);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return (asUTC - instantMs) / 60000;
}

// Safely brackets any single real-world DST-style offset change: every IANA
// zone's transitions are separated by far more than 52 hours, so sampling
// the offset this far to either side of the naive guess reliably captures
// "the offset before" and "the offset after" whatever transition (if any)
// is near the requested civil date.
const PROBE_WINDOW_MS = 26 * 3600000;

/** The one authoritative mechanism for turning a civil (local) date + time in
 *  a timezone into UTC instant(s). Tells the truth about all three real
 *  cases instead of picking one silently:
 *    - unique:      the ordinary case — exactly one instant.
 *    - ambiguous:   the wall-clock reading occurs twice (fall-back repeat).
 *    - nonexistent: the wall-clock reading is skipped entirely (spring-
 *                   forward gap); `instantAfterGapMs` is the first real
 *                   instant whose local reading is at/after the requested
 *                   one, i.e. the same requested clock reading shifted
 *                   forward by exactly `gapMinutes`.
 *  @param {string} dateStr YYYY-MM-DD @param {string} hhmm HH:MM @param {string} timezone
 *  @returns {{kind:'unique',instantMs:number}
 *    | {kind:'ambiguous',earlierMs:number,laterMs:number}
 *    | {kind:'nonexistent',gapMinutes:number,instantAfterGapMs:number}} */
export function resolveLocalWallClock(dateStr, hhmm, timezone) {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = dateStr.split('-').map(Number);
  const naiveUTC = Date.UTC(y, mo - 1, d, h, m, 0);
  const offsetPrev = tzOffsetMinutes(naiveUTC - PROBE_WINDOW_MS, timezone);
  const offsetNext = tzOffsetMinutes(naiveUTC + PROBE_WINDOW_MS, timezone);

  if (offsetPrev === offsetNext) {
    return { kind: 'unique', instantMs: naiveUTC - offsetPrev * 60000 };
  }

  const instantA = naiveUTC - offsetPrev * 60000;
  const instantB = naiveUTC - offsetNext * 60000;
  const aVerifies = tzOffsetMinutes(instantA, timezone) === offsetPrev;
  const bVerifies = tzOffsetMinutes(instantB, timezone) === offsetNext;

  if (aVerifies && bVerifies) {
    return { kind: 'ambiguous', earlierMs: Math.min(instantA, instantB), laterMs: Math.max(instantA, instantB) };
  }
  if (aVerifies) return { kind: 'unique', instantMs: instantA };
  if (bVerifies) return { kind: 'unique', instantMs: instantB };

  const gapMinutes = offsetNext - offsetPrev;
  return { kind: 'nonexistent', gapMinutes, instantAfterGapMs: instantB + gapMinutes * 60000 };
}

/** The deterministic civil-time policy for RECURRING day boundaries (§7/§8):
 *  ambiguous -> earlier occurrence; nonexistent -> advance by the DST gap to
 *  the first valid instant after it. A day boundary must always exist, so
 *  this never fails — it is a recurrence rule, not a factual intention.
 *  @param {string} dateStr @param {string} hhmm @param {string} timezone @returns {number} UTC ms */
export function resolveCivilBoundary(dateStr, hhmm, timezone) {
  const resolved = resolveLocalWallClock(dateStr, hhmm, timezone);
  if (resolved.kind === 'unique') return resolved.instantMs;
  if (resolved.kind === 'ambiguous') return resolved.earlierMs;
  return resolved.instantAfterGapMs;
}

// ── boundary revision history ─────────────────────────────────────────────

/** The default/compatibility revision: 00:00 boundary, so operational-day
 *  math reduces to calendar-day math. Represents "no boundary decision has
 *  ever been made" (§9) — use this to seed a revision history for any user
 *  who has not configured a personal day boundary.
 *  @param {string} timezone @param {string} [id] @returns {object} BoundaryRevision */
export function legacyBoundaryRevision(timezone, id = LEGACY_CALENDAR_DAY_REVISION_ID) {
  return { id, boundaryTime: '00:00', timezone, effectiveFromInstant: null };
}

/** Validates and sorts a revision history ascending by effective instant
 *  (the null anchor sorts first). Throws on any structural violation —
 *  these are caller bugs (malformed history), not runtime states to degrade
 *  through silently.
 *  @param {object[]} revisions @returns {object[]} */
export function normalizeBoundaryRevisionHistory(revisions) {
  if (!Array.isArray(revisions) || !revisions.length) throw new Error('A non-empty boundary revision history is required.');
  if (!revisions.every(validateBoundaryRevision)) throw new Error('Every boundary revision must be valid.');
  const anchors = revisions.filter(r => r.effectiveFromInstant === null);
  if (anchors.length !== 1) throw new Error('Exactly one boundary revision must anchor the history with effectiveFromInstant: null.');
  if (new Set(revisions.map(r => r.id)).size !== revisions.length) throw new Error('Boundary revision ids must be unique.');
  const timed = revisions.filter(r => r.effectiveFromInstant !== null);
  if (new Set(timed.map(r => r.effectiveFromInstant)).size !== timed.length) throw new Error('Boundary revision effective instants must be unique.');
  // A revision must always activate exactly on an occurrence of its OWN
  // boundary time (guaranteed by proposeBoundaryRevision's use of
  // nextBoundaryInstant). This keeps operationalDayContaining's "walk back
  // to this revision's most recent boundary" arithmetic from ever landing
  // before the revision was actually in force.
  for (const r of timed) {
    if (formatHHMM(r.effectiveFromInstant, r.timezone) !== r.boundaryTime) {
      throw new Error(`Boundary revision "${r.id}" must become effective exactly on an occurrence of its own boundary time.`);
    }
  }
  return [...revisions].sort((a, b) => {
    const av = a.effectiveFromInstant === null ? -Infinity : a.effectiveFromInstant;
    const bv = b.effectiveFromInstant === null ? -Infinity : b.effectiveFromInstant;
    return av - bv;
  });
}

/** The revision that governs a given instant — always resolved from the
 *  instant itself, never from "the latest revision," so past instants never
 *  silently regroup under a later boundary change (§11).
 *  @param {object[]} revisions @param {number} instantMs @returns {object} BoundaryRevision */
export function activeBoundaryRevision(revisions, instantMs) {
  const normalized = normalizeBoundaryRevisionHistory(revisions);
  let active = normalized[0];
  for (const rev of normalized) {
    if (rev.effectiveFromInstant === null || rev.effectiveFromInstant <= instantMs) active = rev;
    else break;
  }
  return active;
}

/** The next instant, at or after `afterMs`, at which `rule`'s own boundary
 *  clock time occurs (recurrence policy — see resolveCivilBoundary). Used to
 *  schedule prospective activation (§8): pass the *candidate* new rule, not
 *  the currently active one — "my day starts at 18:00" always means the
 *  next 18:00 from now, under the new rule's own clock, whether or not
 *  18:00 has already passed today.
 *  @param {number} afterMs @param {{boundaryTime:string,timezone:string}} rule @returns {number} */
export function nextBoundaryInstant(afterMs, rule) {
  const calDate = formatDateKey(afterMs, rule.timezone);
  let boundaryInstant = resolveCivilBoundary(calDate, rule.boundaryTime, rule.timezone);
  if (boundaryInstant < afterMs) boundaryInstant = resolveCivilBoundary(addCalendarDate(calDate, 1), rule.boundaryTime, rule.timezone);
  return boundaryInstant;
}

/** Builds a new BoundaryRevision that activates prospectively — at the next
 *  occurrence of its own boundary time from `nowMs` — and appends it to the
 *  history. Never retroactive: the revision returned always has
 *  effectiveFromInstant > nowMs (or === nowMs in the boundary-instant edge
 *  case), so nothing before "now" is reinterpreted (§8, §11).
 *  @param {object[]} revisions @param {{id:string,boundaryTime:string,timezone:string}} candidate
 *  @param {number} nowMs @returns {{revision:object, revisions:object[]}} */
export function proposeBoundaryRevision(revisions, candidate, nowMs) {
  if (!validRevisionId(candidate?.id) || !validBoundaryTime(candidate?.boundaryTime) || !validOperationalDayTimezone(candidate?.timezone)) {
    throw new Error('A valid candidate revision (id, boundaryTime, timezone) is required.');
  }
  const revision = {
    id: candidate.id,
    boundaryTime: candidate.boundaryTime,
    timezone: candidate.timezone,
    effectiveFromInstant: nextBoundaryInstant(nowMs, candidate),
  };
  return { revision, revisions: normalizeBoundaryRevisionHistory([...revisions, revision]) };
}

function findRevision(revisions, id) {
  const found = (Array.isArray(revisions) ? revisions : []).find(r => r.id === id);
  if (!found) throw new Error(`Unknown boundary revision id: ${id}`);
  return found;
}

// ── operational-day identity ──────────────────────────────────────────────

function makeRef(revision, boundaryStartDate) {
  return { v: OPERATIONAL_DAY_SCHEMA_VERSION, boundaryRevisionId: revision.id, timezone: revision.timezone, boundaryStartDate };
}

/** Stable, versioned, namespaced identifier — deliberately never a bare
 *  YYYY-MM-DD, so it can never collide with a legacy plan `dateKey` (§6, §10).
 *  @param {object} ref OperationalDayRef @returns {string} */
export function operationalDayId(ref) {
  return `${ID_PREFIX}:${ref.boundaryRevisionId}:${ref.timezone}:${ref.boundaryStartDate}`;
}

/** Inverse of operationalDayId. @param {string} id @returns {object|null} OperationalDayRef or null if malformed */
export function parseOperationalDayId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  if (parts.length !== 4 || parts[0] !== ID_PREFIX) return null;
  const [, boundaryRevisionId, timezone, boundaryStartDate] = parts;
  if (!validRevisionId(boundaryRevisionId) || !validOperationalDayTimezone(timezone) || !validBoundaryStartDate(boundaryStartDate)) return null;
  return { v: OPERATIONAL_DAY_SCHEMA_VERSION, boundaryRevisionId, timezone, boundaryStartDate };
}

/** True when `ref` is governed by the history's anchor (null-effective)
 *  revision — the contract-defined meaning of "legacy calendar-day
 *  semantics" (§9). @param {object} ref @param {object[]} revisions @returns {boolean} */
export function isLegacyOperationalDay(ref, revisions) {
  return findRevision(revisions, ref.boundaryRevisionId).effectiveFromInstant === null;
}

/** Explicitly construct the ref for the operational day that starts on a
 *  given boundary-start calendar date, under a given (already-resolved)
 *  revision. @param {string} boundaryStartDate @param {object} revision @returns {object} OperationalDayRef */
export function operationalDayStartingOn(boundaryStartDate, revision) {
  if (!validBoundaryStartDate(boundaryStartDate)) throw new Error('A valid boundary-start calendar date is required.');
  if (!validateBoundaryRevision(revision)) throw new Error('A valid boundary revision is required.');
  return makeRef(revision, boundaryStartDate);
}

// ── core derivations ───────────────────────────────────────────────────────

/** The operational day containing a given instant, resolved against the
 *  revision that actually governed that instant (§11).
 *  @param {number} instantMs @param {object[]} revisions @returns {object} OperationalDayRef */
export function operationalDayContaining(instantMs, revisions) {
  if (!Number.isFinite(instantMs)) throw new Error('A valid instant (UTC ms) is required.');
  const revision = activeBoundaryRevision(revisions, instantMs);
  const calDate = formatDateKey(instantMs, revision.timezone);
  const boundaryInstant = resolveCivilBoundary(calDate, revision.boundaryTime, revision.timezone);
  const boundaryStartDate = instantMs >= boundaryInstant ? calDate : addCalendarDate(calDate, -1);
  return makeRef(revision, boundaryStartDate);
}

/** @param {number} nowMs @param {object[]} revisions @returns {object} OperationalDayRef */
export function currentOperationalDay(nowMs, revisions) {
  return operationalDayContaining(nowMs, revisions);
}

/** [start, end) in UTC ms for a given operational day. If a later revision
 *  takes over before this one's own next boundary would occur, the interval
 *  is truncated at that takeover instant — a revision's authority can never
 *  extend past the point a newer revision superseded it, so this always
 *  agrees with what operationalDayContaining would resolve for any instant
 *  in range (§7, §11).
 *
 *  By construction this can only ever SHORTEN the operational day that is
 *  interrupted by a new revision taking effect mid-day — it cannot lengthen
 *  any day beyond its own revision's natural boundary-to-boundary span,
 *  because proposeBoundaryRevision always activates a new revision exactly
 *  on an occurrence of that revision's own boundary time (see
 *  normalizeBoundaryRevisionHistory's alignment check), so the new revision's
 *  own first day always runs its full natural length. A shortened transition
 *  day is an explicit, tested, documented consequence of prospective
 *  activation (§8) — a settings UI that lets a user change their boundary
 *  mid-day must preview this, not hide it.
 *  @param {object} ref @param {object[]} revisions @returns {{startMs:number,endMs:number}} */
export function operationalDayInterval(ref, revisions) {
  const revision = findRevision(revisions, ref.boundaryRevisionId);
  const startMs = resolveCivilBoundary(ref.boundaryStartDate, revision.boundaryTime, ref.timezone);
  const naturalEndMs = resolveCivilBoundary(addCalendarDate(ref.boundaryStartDate, 1), revision.boundaryTime, ref.timezone);
  const endMs = normalizeBoundaryRevisionHistory(revisions)
    .filter(r => r.effectiveFromInstant !== null && r.effectiveFromInstant > startMs && r.effectiveFromInstant < naturalEndMs)
    .reduce((min, r) => Math.min(min, r.effectiveFromInstant), naturalEndMs);
  return { startMs, endMs };
}

/** @param {number} instantMs @param {object} ref @param {object[]} revisions @returns {boolean} */
export function instantInOperationalDay(instantMs, ref, revisions) {
  const { startMs, endMs } = operationalDayInterval(ref, revisions);
  return instantMs >= startMs && instantMs < endMs;
}

/** The next operational day after `ref`, re-resolved from the crossing
 *  instant against the full revision history — so a boundary revision that
 *  takes effect exactly at this crossing is honored (§7, §8), rather than
 *  naively adding one calendar day under `ref`'s own (possibly superseded)
 *  revision. @param {object} ref @param {object[]} revisions @returns {object} OperationalDayRef */
export function nextOperationalDay(ref, revisions) {
  return operationalDayContaining(operationalDayInterval(ref, revisions).endMs, revisions);
}

/** @param {object} ref @param {object[]} revisions @returns {object} OperationalDayRef */
export function previousOperationalDay(ref, revisions) {
  return operationalDayContaining(operationalDayInterval(ref, revisions).startMs - 1, revisions);
}

/** Calendar dates (in ref.timezone) overlapped by this operational day — one
 *  date for a 00:00 boundary, two for any other. @param {object} ref @param {object[]} revisions @returns {string[]} */
export function overlappingCalendarDates(ref, revisions) {
  const revision = findRevision(revisions, ref.boundaryRevisionId);
  return revision.boundaryTime === '00:00' ? [ref.boundaryStartDate] : [ref.boundaryStartDate, addCalendarDate(ref.boundaryStartDate, 1)];
}

// ── user-planned clock times: strict semantics, never silently moved ──────

/** Resolves a wall-clock "HH:MM" into the actual instant it names *within*
 *  a given operational day (§12): clock times at/after the boundary land on
 *  boundaryStartDate itself; clock times before the boundary land on the
 *  following calendar date. The boundary time itself always resolves to
 *  this day's own start instant — it structurally cannot also mean "the end
 *  of this day," which is the same instant under `nextOperationalDay(ref)`.
 *
 *  This is a PLANNED-time resolution: it never silently invents a different
 *  instant than the one requested. A nonexistent clock reading (spring-
 *  forward gap) fails explicitly rather than becoming some other time. An
 *  ambiguous clock reading (fall-back repeat) is exposed as ambiguous unless
 *  the caller passes an explicit `options.disambiguate` ('earlier' | 'later').
 *  @param {object} ref @param {string} hhmm @param {object[]} revisions
 *  @param {{disambiguate?:'earlier'|'later'}} [options]
 *  @returns {{ok:true,instantMs:number}
 *    | {ok:false,reason:'nonexistent',gapMinutes:number}
 *    | {ok:false,reason:'ambiguous',earlierMs:number,laterMs:number}} */
export function resolveClockTimeInOperationalDay(ref, hhmm, revisions, options = {}) {
  if (!validBoundaryTime(hhmm)) throw new Error('A valid 24h "HH:MM" clock time is required.');
  const revision = findRevision(revisions, ref.boundaryRevisionId);
  const [ch, cm] = hhmm.split(':').map(Number);
  const [bh, bm] = revision.boundaryTime.split(':').map(Number);
  const clockDate = (ch * 60 + cm) >= (bh * 60 + bm) ? ref.boundaryStartDate : addCalendarDate(ref.boundaryStartDate, 1);
  return resolvePlannedClock(clockDate, hhmm, ref.timezone, options);
}

/** Shared strict-resolution core for a single planned clock reading. */
function resolvePlannedClock(dateStr, hhmm, timezone, options = {}) {
  const resolved = resolveLocalWallClock(dateStr, hhmm, timezone);
  if (resolved.kind === 'unique') return { ok: true, instantMs: resolved.instantMs };
  if (resolved.kind === 'nonexistent') return { ok: false, reason: 'nonexistent', gapMinutes: resolved.gapMinutes };
  if (options.disambiguate === 'earlier') return { ok: true, instantMs: resolved.earlierMs };
  if (options.disambiguate === 'later') return { ok: true, instantMs: resolved.laterMs };
  return { ok: false, reason: 'ambiguous', earlierMs: resolved.earlierMs, laterMs: resolved.laterMs };
}

/** Resolves a planned occurrence range inside one operational day, so
 *  callers (e.g. a future Plan Time Range feature) never have to reimplement
 *  operational-day containment or civil-time resolution themselves.
 *
 *  Input is either `{ startClock, durationMinutes }` or
 *  `{ startClock, endClock }` (project convention: a Plan Time Range either
 *  gives a duration or an explicit end clock, never both). When an explicit
 *  `endClock` is given, it is resolved relative to the START's own calendar
 *  date using the same cross-midnight convention already used elsewhere in
 *  this app for start/end clock pairs (e.g. daily-routines-model.js's
 *  window-mode templates): an end reading earlier in the day than the start
 *  names a time on the following calendar date. This is deliberately NOT
 *  the operational-day boundary rule a second time — that rule only decides
 *  which calendar date the START belongs to.
 *
 *  This function decides temporal containment only. It deliberately does
 *  NOT enforce the product's separate 720-minute Plan Time Range duration
 *  cap — that remains a later caller's policy constraint, layered on top of
 *  (not inside) temporal truth.
 *  @param {object} ref @param {{startClock:string,durationMinutes?:number,endClock?:string}} input
 *  @param {object[]} revisions @param {{disambiguate?:'earlier'|'later'}} [options]
 *  @returns {{ok:true,startMs:number,endMs:number}
 *    | {ok:false,reason:'invalid-input'|'nonexistent'|'ambiguous'|'non-positive-duration'|'outside-operational-day', [key:string]:*}} */
export function resolvePlannedRangeInOperationalDay(ref, input, revisions, options = {}) {
  if (!input || typeof input !== 'object' || !validBoundaryTime(input.startClock)) return { ok: false, reason: 'invalid-input' };

  const startResolved = resolveClockTimeInOperationalDay(ref, input.startClock, revisions, options);
  if (!startResolved.ok) return { ok: false, at: 'start', ...startResolved };
  const startMs = startResolved.instantMs;

  let endMs;
  const hasDuration = Number.isInteger(input.durationMinutes) && input.durationMinutes > 0;
  const hasEndClock = validBoundaryTime(input.endClock);
  if (hasDuration) {
    endMs = startMs + input.durationMinutes * 60000;
  } else if (hasEndClock) {
    const startCalendarDate = formatDateKey(startMs, ref.timezone);
    const [sh, sm] = input.startClock.split(':').map(Number);
    const [eh, em] = input.endClock.split(':').map(Number);
    const endCalendarDate = (eh * 60 + em) < (sh * 60 + sm) ? addCalendarDate(startCalendarDate, 1) : startCalendarDate;
    const endResolved = resolvePlannedClock(endCalendarDate, input.endClock, ref.timezone, options);
    if (!endResolved.ok) return { ok: false, at: 'end', ...endResolved };
    endMs = endResolved.instantMs;
  } else {
    return { ok: false, reason: 'invalid-input' };
  }

  if (endMs <= startMs) return { ok: false, reason: 'non-positive-duration' };
  const { endMs: dayEndMs } = operationalDayInterval(ref, revisions);
  if (endMs > dayEndMs) return { ok: false, reason: 'outside-operational-day' };
  return { ok: true, startMs, endMs };
}

// ── factual interval overlap / slicing (projections only) ─────────────────

/** Overlap, in ms, between a factual [startMs, endMs) interval and one
 *  specific operational day's own (possibly revision-truncated) interval.
 *  0 for any disjoint, reversed, or zero-duration input — never throws on
 *  those, since factual data can legitimately include an instantaneous
 *  (zero-duration) event.
 *  @param {number} startMs @param {number} endMs @param {object} ref @param {object[]} revisions @returns {number} */
export function operationalDayOverlapMs(startMs, endMs, ref, revisions) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  const { startMs: dayStart, endMs: dayEnd } = operationalDayInterval(ref, revisions);
  return Math.max(0, Math.min(endMs, dayEnd) - Math.max(startMs, dayStart));
}

const SLICE_ITERATION_GUARD = 100000;

/** Slices a factual [startMs, endMs) interval across every operational day
 *  it intersects. The stored factual event is never mutated by this — these
 *  are projections only, derived on demand from one immutable source
 *  interval, so future Timeline/analytics code never has to duplicate
 *  operational-day intersection logic. Slices are returned in chronological
 *  order and their `overlapMs` values always sum to exactly `endMs - startMs`.
 *
 *  Progress is guaranteed structurally: `operationalDayContaining(cursor)`
 *  always returns a day whose own endMs is strictly greater than `cursor`
 *  (the half-open-interval invariant already required of it), so each
 *  iteration strictly advances the cursor. `SLICE_ITERATION_GUARD` is a
 *  defense-in-depth cap against a hypothetical future bug in a malformed
 *  revision history, not a limit expected to be reached in real use.
 *  @param {number} startMs @param {number} endMs @param {object[]} revisions
 *  @returns {{ref:object, overlapStartMs:number, overlapEndMs:number, overlapMs:number}[]} */
export function sliceIntervalAcrossOperationalDays(startMs, endMs, revisions) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const slices = [];
  let cursor = startMs;
  let guard = 0;
  while (cursor < endMs) {
    if (++guard > SLICE_ITERATION_GUARD) throw new Error('sliceIntervalAcrossOperationalDays exceeded its iteration guard — malformed revision history?');
    const ref = operationalDayContaining(cursor, revisions);
    const { endMs: dayEndMs } = operationalDayInterval(ref, revisions);
    const sliceEndMs = Math.min(dayEndMs, endMs);
    if (sliceEndMs <= cursor) throw new Error('sliceIntervalAcrossOperationalDays made no progress — malformed revision history?');
    slices.push({ ref, overlapStartMs: cursor, overlapEndMs: sliceEndMs, overlapMs: sliceEndMs - cursor });
    cursor = sliceEndMs;
  }
  return slices;
}
