// commitments-model.js
//
// Pure. The canonical model for a SCHEDULED COMMITMENT — a one-off real-world
// appointment ("Dentist — Sep 30, 2026 — 9:30 AM").
//
// ── why this is a new store and not a plan item (the whole point) ───────────
// Every existing plan store is DAY-SCOPED: plans[dateKey] is keyed by a calendar
// date, and the operational plan store is keyed by an operationalDayId. An item
// in either one expresses its time as a day-relative "HH:MM" clock reading, which
// is only meaningful together with the day that holds it.
//
// A real appointment cannot be stored that way. Its truth is an INSTANT:
//
//     Dentist, 2026-09-30 09:30, Asia/Manila
//
// If that were persisted as (operationalDayId, "09:30") then changing the
// personal-day boundary — which mints a NEW boundary revision, and therefore new
// operationalDayIds — would leave the record filed under a day identity nothing
// resolves to any more. The appointment would have to be migrated to keep its
// meaning, and any migration that got the arithmetic wrong would MOVE a real
// appointment. That is the one thing this phase must never do.
//
// So a commitment owns its instant, and the personal day that contains it is
// DERIVED on read (see projectCommitment). A single instant falls inside exactly
// one half-open personal-day interval, so:
//   - the stored timestamp never moves, whatever the boundary does;
//   - the projection can change, deterministically, when a revision makes a
//     different day contain that instant;
//   - a commitment can never appear in two days at once, because nothing is
//     copied into a day record in the first place;
//   - and it can never become unreachable, because it is reachable by its own id
//     without consulting any boundary history at all.
//
// ── timezone provenance ────────────────────────────────────────────────────
// The authored timezone is captured ONCE, at creation, and stored on the record.
// It is never re-read from account settings and never borrowed from the Personal
// Day Boundary's timezone. Changing either one moves nothing. This mirrors the
// one existing precedent in this codebase for "a civil rule plus its resolved
// instant": BoundaryRevision { boundaryTime, timezone, effectiveFromInstant }.
//
// ── date-only commitments ──────────────────────────────────────────────────
// "Dentist, Sep 30, time unknown" must not silently become midnight. It uses the
// NOON ANCHOR, which is not invented here: Plan Authority's Decision A already
// fixes 12:00 local as the ownership anchor for a date-only recurring thing
// (untimed anytime/cue routines). A date-only commitment reuses that exact rule,
// for DAY OWNERSHIP ONLY — `precision: 'date'` records that no time was ever
// authored, and no caller may render the anchor as an appointment time.
//
// ── DST ────────────────────────────────────────────────────────────────────
// An authored wall-clock reading that does not exist (spring forward) or happens
// twice (fall back) is REFUSED, never guessed. The caller must offer the explicit
// choice, and the choice is recorded in `dstChoice` so the resolution stays
// auditable rather than implicit.

import { resolveLocalWallClock, canonicalizeOperationalDayTimezone, validOperationalDayTimezone } from './personal-day-boundary-model.js';

export const COMMITMENT_SCHEMA_VERSION = 1;

/** The ownership anchor for a date-only commitment. Deliberately the SAME 12:00
 *  local anchor Plan Authority's Decision A already uses for untimed routines —
 *  reused, not re-decided, so the product has one rule for "a date-only thing
 *  belongs to which personal day?". Never displayed as a time. */
export const DATE_ONLY_ANCHOR_TIME = '12:00';

export const COMMITMENT_PRECISIONS = new Set(['timed', 'date']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_TITLE = 200;
const MAX_NOTE = 240;
/** Same 12h ceiling a plan item's range uses (plan-tomorrow-model.js's
 *  validPlanItemDuration) — a commitment is a single continuous block, not an
 *  itinerary. Kept identical so the two never disagree about what "too long" is. */
const MAX_DURATION_MINUTES = 720;

export function validCommitmentDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  // The round-trip catches non-dates the regex cannot (2026-02-30). It is guarded
  // because an out-of-RANGE month (2026-13-01) yields an Invalid Date, whose
  // toISOString() throws — a validator must return false, never throw, since it
  // is called on unvalidated remote payloads.
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

export function validCommitmentTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

export function validCommitmentDuration(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_DURATION_MINUTES;
}

export function validCommitmentId(value) {
  // Base36-ish, and deliberately free of every character Firebase forbids in a
  // key ('.', '#', '$', '[', ']', '/') so the id can be used as the remote key
  // verbatim — unlike operationalDayId, which embeds a '/' from its IANA zone and
  // has to be base64url-encoded on the wire.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(value);
}

function cleanTitle(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TITLE) : '';
}

function cleanNote(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_NOTE) : null;
}

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function writer(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200 ? value : null;
}

/** The civil wall-clock reading a commitment's instant is authored from: its own
 *  time for a timed one, the noon anchor for a date-only one. */
export function commitmentAnchorTime(precision, time) {
  return precision === 'date' ? DATE_ONLY_ANCHOR_TIME : time;
}

/** Resolves an authored (date, time, timezone) to a real instant, or reports
 *  exactly why it cannot be resolved. Never guesses across a DST anomaly.
 *
 *  `disambiguate` is the caller's EXPLICIT choice for a repeated local reading
 *  ('earlier' | 'later'). Absent, an ambiguous reading is refused — that refusal
 *  is the product requirement, not a limitation.
 *  @returns {{ok:true, startMs:number, dstChoice?:'earlier'|'later'}
 *          | {ok:false, reason:'invalid-input'|'ambiguous'|'nonexistent', ...}} */
export function resolveCommitmentInstant({ date, time, timezone, precision = 'timed', disambiguate = null } = {}) {
  if (!validCommitmentDate(date)) return { ok: false, reason: 'invalid-input', field: 'date' };
  if (!COMMITMENT_PRECISIONS.has(precision)) return { ok: false, reason: 'invalid-input', field: 'precision' };
  if (precision === 'timed' && !validCommitmentTime(time)) return { ok: false, reason: 'invalid-input', field: 'time' };
  // A date-only commitment must not carry a time at all — that would be two
  // competing answers to "when is this?" on one record.
  if (precision === 'date' && time !== null && time !== undefined && time !== '') return { ok: false, reason: 'invalid-input', field: 'time' };
  if (!validOperationalDayTimezone(timezone)) return { ok: false, reason: 'invalid-input', field: 'timezone' };
  if (disambiguate !== null && disambiguate !== 'earlier' && disambiguate !== 'later') return { ok: false, reason: 'invalid-input', field: 'disambiguate' };

  const anchor = commitmentAnchorTime(precision, time);
  const resolved = resolveLocalWallClock(date, anchor, timezone);
  if (resolved.kind === 'unique') return { ok: true, startMs: resolved.instantMs };
  if (resolved.kind === 'ambiguous') {
    // Repeated local reading (fall back). Refused unless the caller already made
    // the choice, and the choice is then recorded on the record.
    if (disambiguate === 'earlier') return { ok: true, startMs: resolved.earlierMs, dstChoice: 'earlier' };
    if (disambiguate === 'later') return { ok: true, startMs: resolved.laterMs, dstChoice: 'later' };
    return { ok: false, reason: 'ambiguous', earlierMs: resolved.earlierMs, laterMs: resolved.laterMs };
  }
  // Nonexistent local reading (spring forward). There is no honest instant to
  // pick — shifting it silently would move a real appointment — so this is always
  // refused and the caller must re-author the time.
  return { ok: false, reason: 'nonexistent', gapMinutes: resolved.gapMinutes, instantAfterGapMs: resolved.instantAfterGapMs };
}

/** Builds a NEW commitment record. `id` is minted by the caller (repository) and
 *  is immutable for the life of the commitment: title, date, time and timezone
 *  are all editable, so none of them may ever be part of identity.
 *  @returns {{ok:true, record:object} | {ok:false, reason:string, ...}} */
export function buildCommitment(input = {}) {
  const { id, title, date, time = null, timezone, precision = 'timed', durationMinutes, note, now, updatedBy, disambiguate = null } = input;
  if (!validCommitmentId(id)) return { ok: false, reason: 'invalid-input', field: 'id' };
  const cleanedTitle = cleanTitle(title);
  if (!cleanedTitle) return { ok: false, reason: 'invalid-input', field: 'title' };
  const createdAt = timestamp(now);
  if (!createdAt) return { ok: false, reason: 'invalid-input', field: 'now' };
  const by = writer(updatedBy);
  if (!by) return { ok: false, reason: 'invalid-input', field: 'updatedBy' };
  if (durationMinutes !== undefined && durationMinutes !== null && !validCommitmentDuration(durationMinutes)) {
    return { ok: false, reason: 'invalid-input', field: 'durationMinutes' };
  }
  // A date-only commitment may not also carry a time — that would be two
  // competing answers to "when is this?" on one record. Checked HERE because the
  // resolver is deliberately handed a nulled time for the date-only case.
  if (precision === 'date' && time !== null && time !== undefined && time !== '') {
    return { ok: false, reason: 'invalid-input', field: 'time' };
  }
  // Validated before canonicalizing: canonicalizeOperationalDayTimezone THROWS on
  // an unresolvable zone, and this function's contract is to report a refusal.
  if (!validOperationalDayTimezone(timezone)) return { ok: false, reason: 'invalid-input', field: 'timezone' };
  const zone = canonicalizeOperationalDayTimezone(timezone);
  const resolved = resolveCommitmentInstant({ date, time: precision === 'date' ? null : time, timezone: zone, precision, disambiguate });
  if (!resolved.ok) return resolved;

  const record = {
    schemaVersion: COMMITMENT_SCHEMA_VERSION,
    id,
    title: cleanedTitle,
    precision,
    date,
    time: precision === 'date' ? null : time,
    timezone: zone,
    startMs: resolved.startMs,
    createdAt,
    updatedAt: createdAt,
    updatedBy: by,
  };
  if (durationMinutes !== undefined && durationMinutes !== null) record.durationMinutes = durationMinutes;
  const cleanedNote = cleanNote(note);
  if (cleanedNote) record.note = cleanedNote;
  if (resolved.dstChoice) record.dstChoice = resolved.dstChoice;
  return { ok: true, record };
}

/** Applies an edit to an existing record. The id, createdAt and schemaVersion are
 *  never touched; everything else may change, and startMs is RE-RESOLVED from
 *  whatever civil fields result — so editing the date/time/zone of an appointment
 *  is an ordinary authored change, while a boundary change (which touches none of
 *  these) can never reach startMs at all.
 *
 *  Patch contract for optional fields (durationMinutes, note): a key that is
 *  UNDEFINED or absent means "leave unchanged"; an explicit NULL means "clear it".
 *  Never decided by truthiness, so 0 or an empty string can never be mistaken for
 *  either.
 *  @returns {{ok:true, record:object} | {ok:false, reason:string, ...}} */
export function updateCommitment(current, patch = {}) {
  const base = normalizeCommitment(current);
  if (!base) return { ok: false, reason: 'invalid-input', field: 'record' };
  const now = timestamp(patch.now);
  if (!now) return { ok: false, reason: 'invalid-input', field: 'now' };
  const by = writer(patch.updatedBy);
  if (!by) return { ok: false, reason: 'invalid-input', field: 'updatedBy' };

  const precision = patch.precision !== undefined ? patch.precision : base.precision;
  if (!COMMITMENT_PRECISIONS.has(precision)) return { ok: false, reason: 'invalid-input', field: 'precision' };
  // Promoting date-only -> timed requires a time; demoting timed -> date-only
  // drops it. Neither is inferred from the other.
  let time;
  if (precision === 'date') time = null;
  else if (patch.time !== undefined) time = patch.time;
  else time = base.time;

  const built = buildCommitment({
    id: base.id,
    title: patch.title !== undefined ? patch.title : base.title,
    date: patch.date !== undefined ? patch.date : base.date,
    time,
    timezone: patch.timezone !== undefined ? patch.timezone : base.timezone,
    precision,
    durationMinutes: patch.durationMinutes !== undefined ? patch.durationMinutes : base.durationMinutes,
    note: patch.note !== undefined ? patch.note : base.note,
    now,
    updatedBy: by,
    disambiguate: patch.disambiguate !== undefined ? patch.disambiguate : null,
  });
  if (!built.ok) return built;
  // createdAt is history, not a mutable field.
  return { ok: true, record: { ...built.record, createdAt: base.createdAt, updatedAt: now } };
}

/** Tombstone. A hard delete is resurrected by the per-record merge on the next
 *  inbound snapshot — the same reason plan items are tombstoned rather than
 *  spliced. The civil fields are retained so a deleted commitment can still be
 *  described (and undeleted) rather than becoming an opaque marker. */
export function deleteCommitment(current, { now, updatedBy } = {}) {
  const base = normalizeCommitment(current);
  if (!base) return { ok: false, reason: 'invalid-input', field: 'record' };
  const at = timestamp(now);
  const by = writer(updatedBy);
  if (!at) return { ok: false, reason: 'invalid-input', field: 'now' };
  if (!by) return { ok: false, reason: 'invalid-input', field: 'updatedBy' };
  return { ok: true, record: { ...base, deleted: true, updatedAt: at, updatedBy: by } };
}

/** Validates and canonicalizes a stored/remote record. Returns null for anything
 *  that is not a well-formed commitment — a malformed remote payload must never
 *  become a half-valid appointment.
 *
 *  `startMs` is RE-DERIVED from the civil fields rather than trusted, so a record
 *  whose stored instant disagrees with its own (date, time, timezone) is rejected
 *  instead of silently displaying one time while sorting by another. The single
 *  exception is a recorded `dstChoice`, which is exactly the case where the civil
 *  reading alone genuinely does not determine the instant. */
export function normalizeCommitment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion !== COMMITMENT_SCHEMA_VERSION) return null;
  if (!validCommitmentId(value.id)) return null;
  const title = cleanTitle(value.title);
  if (!title) return null;
  if (!COMMITMENT_PRECISIONS.has(value.precision)) return null;
  if (!validCommitmentDate(value.date)) return null;
  if (value.precision === 'timed' ? !validCommitmentTime(value.time) : value.time !== null) return null;
  if (!validOperationalDayTimezone(value.timezone)) return null;
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const updatedBy = writer(value.updatedBy);
  if (!createdAt || !updatedAt || updatedAt < createdAt || !updatedBy) return null;
  if (value.durationMinutes !== undefined && !validCommitmentDuration(value.durationMinutes)) return null;
  if (value.dstChoice !== undefined && value.dstChoice !== 'earlier' && value.dstChoice !== 'later') return null;
  if (value.deleted !== undefined && value.deleted !== true) return null;

  const resolved = resolveCommitmentInstant({
    date: value.date, time: value.precision === 'date' ? null : value.time,
    timezone: value.timezone, precision: value.precision,
    disambiguate: value.dstChoice || null,
  });
  if (!resolved.ok) return null;
  if (resolved.startMs !== value.startMs) return null;

  const record = {
    schemaVersion: COMMITMENT_SCHEMA_VERSION,
    id: value.id,
    title,
    precision: value.precision,
    date: value.date,
    time: value.precision === 'date' ? null : value.time,
    timezone: value.timezone,
    startMs: value.startMs,
    createdAt,
    updatedAt,
    updatedBy,
  };
  if (value.durationMinutes !== undefined) record.durationMinutes = value.durationMinutes;
  const note = cleanNote(value.note);
  if (note) record.note = note;
  if (value.dstChoice) record.dstChoice = value.dstChoice;
  if (value.deleted === true) record.deleted = true;
  return record;
}

/** The commitment's [startMs, endMs) window. An undurated commitment is a point
 *  in time, so endMs === startMs — callers render it as a moment, not a
 *  zero-length block. */
export function commitmentWindow(record) {
  const startMs = record.startMs;
  return { startMs, endMs: startMs + (record.durationMinutes ? record.durationMinutes * 60000 : 0) };
}

function compareStrings(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Per-record convergence. Deliberately the SAME algorithm plan items already
 *  use (plan-tomorrow-model.js's chooseItem): highest updatedAt wins, and an
 *  exact tie is broken by a canonical form of the record, so two devices that
 *  write different edits in the same millisecond still agree on which one won
 *  — on both devices, with no coordination and no "last writer to call set()".
 *
 *  A tombstone is an ordinary later write, so deletion converges by the same
 *  rule as any other edit and can never be silently undone by a stale peer. */
export function mergeCommitmentRecords(localValue, remoteValue) {
  const local = normalizeCommitment(localValue);
  const remote = normalizeCommitment(remoteValue);
  if (!local) return remote;
  if (!remote) return local;
  if (local.updatedAt !== remote.updatedAt) return remote.updatedAt > local.updatedAt ? remote : local;
  return compareStrings(canonical(local), canonical(remote)) >= 0 ? local : remote;
}

/** Merges two whole commitment maps, record by record. Never a store-wide
 *  replace: a peer that has never seen a commitment must not be able to delete
 *  it by simply not mentioning it (absence is not deletion — only a tombstone
 *  is). */
export function mergeCommitmentMaps(localMap, remoteMap) {
  const out = {};
  const ids = new Set([...Object.keys(localMap || {}), ...Object.keys(remoteMap || {})]);
  for (const id of ids) {
    const merged = mergeCommitmentRecords((localMap || {})[id], (remoteMap || {})[id]);
    if (merged && merged.id === id) out[id] = merged;
  }
  return out;
}

/** THE projection. Which authoritative personal day contains this commitment —
 *  derived, never stored.
 *
 *  `dayContaining` is injected (Plan Authority's `containing(instantMs)` in
 *  production) so this module never needs to know about boundary revisions,
 *  legacy-vs-operational authority, or which store holds a plan. That is also
 *  what makes the boundary-change invariant testable in isolation: pass a
 *  different revision history and only the projection moves.
 *  @returns {{ok:true, target:object, startMs:number, endMs:number}
 *          | {ok:false, reason:string}} */
export function projectCommitment(record, dayContaining) {
  const normalized = normalizeCommitment(record);
  if (!normalized) return { ok: false, reason: 'invalid-record' };
  if (typeof dayContaining !== 'function') return { ok: false, reason: 'no-resolver' };
  const { startMs, endMs } = commitmentWindow(normalized);
  let target;
  try {
    target = dayContaining(startMs);
  } catch (err) {
    // An unresolvable revision history must not make the commitment vanish — the
    // caller still lists it, by id, with its real authored time.
    return { ok: false, reason: 'unresolvable-day', message: err.message };
  }
  return { ok: true, target, startMs, endMs, record: normalized };
}

/** Every active commitment whose instant falls inside `target`'s own interval.
 *  Pure selection over records the caller already holds — nothing is copied into
 *  the day, so a commitment cannot be duplicated into two days by construction.
 *
 *  Containment is tested against the TARGET's half-open [startMs, endMs)
 *  interval, which is the same rule operationalDayContaining applies, so a
 *  commitment at exactly the boundary instant belongs to the day that STARTS
 *  there. It is deliberately the commitment's START that decides ownership: a
 *  durated commitment that runs past the end of its day still belongs to the day
 *  it begins in, exactly as a timed plan item does. */
export function commitmentsForTarget(records, target) {
  if (!target || !Number.isFinite(target.startMs) || !Number.isFinite(target.endMs)) return [];
  return activeCommitments(records)
    .filter(record => record.startMs >= target.startMs && record.startMs < target.endMs)
    .sort((a, b) => a.startMs - b.startMs || compareStrings(a.id, b.id));
}

/** Active (non-tombstoned) commitments, normalized, in chronological order. */
export function activeCommitments(records) {
  const list = Array.isArray(records) ? records : Object.values(records || {});
  return list
    .map(normalizeCommitment)
    .filter(record => record && !record.deleted)
    .sort((a, b) => a.startMs - b.startMs || compareStrings(a.id, b.id));
}

/** The Upcoming list: active commitments at or after `fromMs`, soonest first.
 *  `limit` bounds what a caller renders, never what is discoverable — an
 *  unbounded call returns everything. */
export function upcomingCommitments(records, fromMs, limit = Infinity) {
  const out = activeCommitments(records).filter(record => commitmentWindow(record).endMs >= fromMs);
  return Number.isFinite(limit) ? out.slice(0, limit) : out;
}

/** Display label. A date-only commitment renders its DATE ONLY — the noon anchor
 *  is ownership machinery and must never surface as an appointment time. This is
 *  the single formatter every surface uses, so no caller can accidentally print
 *  "12:00 PM" for something the owner never gave a time to. */
export function formatCommitmentTime(record) {
  const normalized = normalizeCommitment(record);
  if (!normalized) return null;
  if (normalized.precision === 'date') return null;
  const [hour, minute] = normalized.time.split(':').map(Number);
  const period = hour < 12 ? 'AM' : 'PM';
  const start = `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${period}`;
  if (!normalized.durationMinutes) return start;
  const endTotal = hour * 60 + minute + normalized.durationMinutes;
  const endHour = Math.floor(endTotal / 60) % 24;
  const endMinute = endTotal % 60;
  const endPeriod = endHour < 12 ? 'AM' : 'PM';
  const end = `${endHour % 12 || 12}:${String(endMinute).padStart(2, '0')} ${endPeriod}`;
  return period === endPeriod && endTotal < 24 * 60
    ? `${hour % 12 || 12}:${String(minute).padStart(2, '0')}–${end}`
    : `${start}–${end}`;
}

const api = {
  COMMITMENT_SCHEMA_VERSION, DATE_ONLY_ANCHOR_TIME, COMMITMENT_PRECISIONS,
  validCommitmentDate, validCommitmentTime, validCommitmentDuration, validCommitmentId,
  commitmentAnchorTime, resolveCommitmentInstant, buildCommitment, updateCommitment,
  deleteCommitment, normalizeCommitment, commitmentWindow, mergeCommitmentRecords,
  mergeCommitmentMaps, projectCommitment, commitmentsForTarget, activeCommitments,
  upcomingCommitments, formatCommitmentTime,
};
globalThis.CommitmentsModel = api;
export default api;
