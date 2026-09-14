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

/** @param {string} value @returns {boolean} true for an IANA zone Intl can resolve */
export function validOperationalDayTimezone(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes(':')) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; } catch { return false; }
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

// ── self-contained date/time math (no ambient globals, no imports) ───────

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

/** Wall-clock "HH:MM" on `dateStr` in `timezone` -> UTC ms. Self-contained
 *  equivalent of storage.js's tzParseTime (iterative offset correction). */
function wallClockToInstant(dateStr, hhmm, timezone) {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = dateStr.split('-').map(Number);
  let ts = Date.UTC(y, mo - 1, d, h, m, 0);
  for (let i = 0; i < 3; i++) {
    const [oh, om] = formatHHMM(ts, timezone).split(':').map(Number);
    const diff = ((h * 60 + m) - (oh * 60 + om)) * 60000;
    if (diff === 0) break;
    ts += diff;
  }
  const landed = formatDateKey(ts, timezone);
  if (landed !== dateStr) ts += (landed < dateStr ? 1 : -1) * 86400000;
  return ts;
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
 *  clock time occurs. Used to schedule prospective activation (§8): pass the
 *  *candidate* new rule, not the currently active one — "my day starts at
 *  18:00" always means the next 18:00 from now, under the new rule's own
 *  clock, whether or not 18:00 has already passed today.
 *  @param {number} afterMs @param {{boundaryTime:string,timezone:string}} rule @returns {number} */
export function nextBoundaryInstant(afterMs, rule) {
  const calDate = formatDateKey(afterMs, rule.timezone);
  let boundaryInstant = wallClockToInstant(calDate, rule.boundaryTime, rule.timezone);
  if (boundaryInstant < afterMs) boundaryInstant = wallClockToInstant(addCalendarDate(calDate, 1), rule.boundaryTime, rule.timezone);
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
  const boundaryInstant = wallClockToInstant(calDate, revision.boundaryTime, revision.timezone);
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
 *  in range (§7, §11). @param {object} ref @param {object[]} revisions @returns {{startMs:number,endMs:number}} */
export function operationalDayInterval(ref, revisions) {
  const revision = findRevision(revisions, ref.boundaryRevisionId);
  const startMs = wallClockToInstant(ref.boundaryStartDate, revision.boundaryTime, ref.timezone);
  const naturalEndMs = wallClockToInstant(addCalendarDate(ref.boundaryStartDate, 1), revision.boundaryTime, ref.timezone);
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

/** Resolves a wall-clock "HH:MM" into the actual instant it names *within*
 *  a given operational day (§12): clock times at/after the boundary land on
 *  boundaryStartDate itself; clock times before the boundary land on the
 *  following calendar date. The boundary time itself always resolves to
 *  this day's own start instant — it structurally cannot also mean "the end
 *  of this day," which is the same instant under `nextOperationalDay(ref)`.
 *  @param {object} ref @param {string} hhmm @param {object[]} revisions @returns {number} UTC ms */
export function resolveClockTimeInOperationalDay(ref, hhmm, revisions) {
  if (!validBoundaryTime(hhmm)) throw new Error('A valid 24h "HH:MM" clock time is required.');
  const revision = findRevision(revisions, ref.boundaryRevisionId);
  const [ch, cm] = hhmm.split(':').map(Number);
  const [bh, bm] = revision.boundaryTime.split(':').map(Number);
  const clockDate = (ch * 60 + cm) >= (bh * 60 + bm) ? ref.boundaryStartDate : addCalendarDate(ref.boundaryStartDate, 1);
  return wallClockToInstant(clockDate, hhmm, ref.timezone);
}
