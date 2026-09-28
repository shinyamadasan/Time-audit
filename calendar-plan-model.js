// calendar-plan-model.js
//
// Calendar-Native Plan Identity V1 — pure. The ONE model of a NEW plan: a plan
// belongs to the CALENDAR DATE it was originally made for, never to a Personal
// Day boundary window.
//
//   calendar date -> calendar-plan identity -> persisted CalendarPlan
//                 -> pure cross-midnight projection -> My Day / Plan Tomorrow / Review
//
// ── identity ────────────────────────────────────────────────────────────────
// `cal1:<YYYY-MM-DD>`. "cal1" is the identity-scheme version. The account is not
// spelled in the id (the repo convention — operationalDayId does not either): an
// account owns its plans through the room-scoped local cache and the room-scoped
// remote path, both guarded by an owner check (calendar-plan-repository.js /
// calendar-plan-sync.js). The id is deterministic and immutable: Sunday's plan is
// `cal1:2026-09-27` no matter what time it is, which device wrote it, what the
// Personal Day boundary is, or what timezone the account is in later.
//
// ── plan item time truth ────────────────────────────────────────────────────
// A timed item persists a CIVIL reading plus the timezone that reading was made in:
//
//     when:          'HH:MM'            (the existing field — unchanged meaning)
//     whenDayOffset: 0 | 1              (civil days after the plan's own date; absent = 0)
//     whenTz:        IANA zone          (owned BY THE ITEM, frozen when the reading is set)
//
// The instant is a PURE function of those three and the plan's date
// (calendarItemInstants). It never consults the account's current timezone, the
// Personal Day boundary or "today", so:
//   - Sunday 11:00 stays the same instant forever (the account moving to another
//     zone later cannot reinterpret it — stampCalendarItemTimes only restamps an
//     item whose own reading changed);
//   - a Sunday-origin item at Monday 01:00 is {when:'01:00', whenDayOffset:1} and
//     stays in Sunday's plan — no clone, no Monday-owned duplicate, and the Monday
//     timestamp is never rewritten to Sunday.
// A plan spans at most TWO calendar dates (its own + the next): an item must both
// start and END before the start of date+2. That bound is what lets "carryover" be
// answered by looking at exactly one previous plan.
//
// Ambiguous local readings (a clock hour repeated by a fall-back) resolve to the
// EARLIER occurrence, deterministically; a reading that does not exist (spring-
// forward gap) is refused at write time, never guessed.
//
// ── preparation ─────────────────────────────────────────────────────────────
// Reuses the legacy date-keyed contract verbatim (plan-tomorrow-model.js's
// normalizePreparation/buildPreparation/mergePreparations/planningConsistency,
// targetDate = the plan's date, timezone frozen in the preparation). A calendar
// plan IS a calendar-date plan; only where it is stored and how an item's instant
// is represented is new. No second preparation framework.
//
// ── authority cutover ───────────────────────────────────────────────────────
// Which store is authoritative for a date is decided ONLY by the account's
// activation facts (never by which store holds data, never by load order):
// a grow-only set of immutable facts; the effective activation is the one with the
// smallest (activatedAtMs, id). Dates on/after its activationDate are
// calendar-authoritative; earlier dates stay legacy-authoritative and read-only in
// spirit (they remain viewable and their unfinished work recoverable).

import {
  addCalendarDays,
  localPlanDate,
  mergePreparations,
  validPlanDate as legacyValidPlanDate,
  validPlanItemDuration,
  validPlanItemTime,
} from './plan-tomorrow-model.js';
import { comparePlanItemRelocations } from './plan-item-relocation.js';
import { canonicalizeOperationalDayTimezone, resolveLocalWallClock, validOperationalDayTimezone } from './personal-day-boundary-model.js';

// plan-tomorrow-model.js's validPlanDate throws (RangeError) for an impossible date such as
// 2026-13-40 instead of answering false. An id/fact read from storage or a remote must be
// answered, never thrown on, so this model asks through a guard. (The shared module is
// deliberately left as it is.)
function validPlanDate(value) {
  try { return legacyValidPlanDate(value); } catch { return false; }
}

export const CALENDAR_PLAN_SCHEMA_VERSION = 1;
export const CALENDAR_PLAN_ID_PREFIX = 'cal1';
export const CALENDAR_AUTHORITY_SCHEMA_VERSION = 1;
/** A plan spans its own date and, at most, the next one. */
export const MAX_PLAN_DAY_OFFSET = 1;

// ── identity ────────────────────────────────────────────────────────────────

/** @param {string} dateKey YYYY-MM-DD @returns {string} */
export function calendarPlanId(dateKey) {
  if (!validPlanDate(dateKey)) throw new Error(`A valid calendar date is required, got: ${dateKey}`);
  return `${CALENDAR_PLAN_ID_PREFIX}:${dateKey}`;
}

/** @param {*} id @returns {string|null} the plan's date, or null when `id` is not a calendar-plan id */
export function parseCalendarPlanId(id) {
  if (typeof id !== 'string' || !id.startsWith(`${CALENDAR_PLAN_ID_PREFIX}:`)) return null;
  const dateKey = id.slice(CALENDAR_PLAN_ID_PREFIX.length + 1);
  return validPlanDate(dateKey) ? dateKey : null;
}

// ── item time truth ─────────────────────────────────────────────────────────

/** 0 | 1 for a valid offset (absent means 0), null for anything else. */
export function itemDayOffset(item) {
  const raw = item?.whenDayOffset;
  if (raw === undefined) return 0;
  return Number.isInteger(raw) && raw >= 0 && raw <= MAX_PLAN_DAY_OFFSET ? raw : null;
}

function dayStart(dateKey, timezone) {
  const resolved = resolveLocalWallClock(dateKey, '00:00', timezone);
  if (resolved.kind === 'unique') return resolved.instantMs;
  if (resolved.kind === 'ambiguous') return resolved.earlierMs;
  return resolved.instantAfterGapMs; // a zone whose midnight does not exist: the first real instant of that date
}

/** The plan's HOME interval: [00:00 of its date, 00:00 of the next date) in `timezone`. */
export function calendarPlanInterval(dateKey, timezone) {
  return { startMs: dayStart(dateKey, timezone), endMs: dayStart(addCalendarDays(dateKey, 1), timezone) };
}

/** The furthest instant (exclusive) any item of this plan may reach: the start of date+2. */
function extentEndMs(dateKey, timezone) {
  return dayStart(addCalendarDays(dateKey, MAX_PLAN_DAY_OFFSET + 1), timezone);
}

/** The factual instant(s) of one item — a pure function of (plan date, item). Untimed
 *  items (no structured `when`) have none. @returns
 *  {{ok:true, timed:false} | {ok:true, timed:true, startMs:number, endMs:number|null} | {ok:false, reason:string}} */
export function calendarItemInstants(dateKey, item) {
  if (!validPlanDate(dateKey)) return { ok: false, reason: 'invalid-plan-date' };
  if (!item || typeof item !== 'object') return { ok: false, reason: 'invalid-item' };
  const timed = validPlanItemTime(item.when);
  if (!timed) {
    // Free text ("after lunch") or blank: not a structured time. A range with no start is meaningless.
    if (item.durationMinutes !== undefined) return { ok: false, reason: 'invalid-range' };
    return { ok: true, timed: false };
  }
  const offset = itemDayOffset(item);
  if (offset === null) return { ok: false, reason: 'invalid-offset' };
  if (typeof item.whenTz !== 'string' || !item.whenTz) return { ok: false, reason: 'missing-timezone' };
  if (!validOperationalDayTimezone(item.whenTz)) return { ok: false, reason: 'invalid-timezone' };
  if (item.durationMinutes !== undefined && !validPlanItemDuration(item.durationMinutes)) return { ok: false, reason: 'invalid-range' };
  const resolved = resolveLocalWallClock(addCalendarDays(dateKey, offset), item.when, item.whenTz);
  if (resolved.kind === 'nonexistent') return { ok: false, reason: 'nonexistent-time' };
  const startMs = resolved.kind === 'unique' ? resolved.instantMs : resolved.earlierMs;
  const endMs = item.durationMinutes === undefined ? null : startMs + item.durationMinutes * 60000;
  return { ok: true, timed: true, startMs, endMs };
}

/** Write-time validation of one item against its plan. The item must already carry
 *  its `whenTz` (see stampCalendarItemTimes). @returns {{ok:true}|{ok:false, reason:string}} */
export function validateCalendarPlanItem(dateKey, item) {
  const instants = calendarItemInstants(dateKey, item);
  if (!instants.ok) return instants;
  if (instants.timed) {
    const limit = extentEndMs(dateKey, item.whenTz);
    if ((instants.endMs ?? instants.startMs) > limit) return { ok: false, reason: 'outside-plan-extent' };
  }
  return { ok: true };
}

/** The ONLY place `whenTz`/`whenDayOffset` are decided. For each timed item: keep the
 *  previously stored zone when the item's own reading (when + offset) is unchanged —
 *  this is what makes a historical instant immune to the account's zone changing
 *  later — otherwise freeze the zone the reading is being made in NOW. An item with no
 *  structured time carries neither field. Pure; never mutates its input.
 *  @param {object[]} previousItems @param {object[]} nextItems @param {string} accountTimezone */
export function stampCalendarItemTimes(previousItems, nextItems, accountTimezone) {
  const previousById = new Map((Array.isArray(previousItems) ? previousItems : []).filter(item => item?.id).map(item => [item.id, item]));
  return nextItems.map(item => {
    if (!validPlanItemTime(item?.when)) {
      if (item && (item.whenTz !== undefined || item.whenDayOffset !== undefined)) {
        const rest = { ...item };
        delete rest.whenTz;
        delete rest.whenDayOffset;
        return rest;
      }
      return item;
    }
    const previous = previousById.get(item.id);
    const unchanged = previous && previous.when === item.when && (itemDayOffset(previous) ?? 0) === (itemDayOffset(item) ?? 0)
      && typeof previous.whenTz === 'string' && previous.whenTz;
    const whenTz = unchanged ? previous.whenTz : canonicalizeOperationalDayTimezone(accountTimezone);
    const next = { ...item, whenTz };
    if (next.whenDayOffset === 0) delete next.whenDayOffset; // absent === 0: one representation
    return next;
  });
}

// ── plan record merge ───────────────────────────────────────────────────────

function mergeTimestamp(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}
function writerName(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200 ? value : null;
}
function compareStrings(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function itemMutationKey(value) {
  return `${writerName(value?.updatedBy) || ''} ${canonical(value)}`;
}
function chooseItem(local, remote) {
  const relocationOrder = comparePlanItemRelocations(local, remote);
  if (relocationOrder !== 0) return relocationOrder > 0 ? local : remote;
  const localAt = mergeTimestamp(local?.updatedAt);
  const remoteAt = mergeTimestamp(remote?.updatedAt);
  if (localAt !== remoteAt) return remoteAt > localAt ? remote : local;
  return compareStrings(itemMutationKey(local), itemMutationKey(remote)) >= 0 ? local : remote;
}
function planItems(value) {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
  if (value && typeof value === 'object') return Object.values(value).filter(item => item && typeof item === 'object');
  return [];
}

/** Firebase Realtime Database persists no empty array or object: a node with zero children is
 *  pruned on write and reads back as ABSENT, not as []. A plan with no items, or a preparation with
 *  no routines (the common case), would therefore come back from the cloud missing fields the
 *  preparation contract requires — and a second device would read a genuinely prepared plan as
 *  "unknown". Every record is passed through here before it is merged, so the wire format is
 *  restored to what was written. Only fields that are legitimately empty are defaulted; nothing
 *  else about a malformed record is repaired. */
export function restorePrunedPlanRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const out = { ...record };
  if (out.items === undefined) out.items = [];
  if (out.preparation && typeof out.preparation === 'object' && !Array.isArray(out.preparation)) {
    const preparation = { ...out.preparation };
    if (preparation.routineInstanceIds === undefined) preparation.routineInstanceIds = [];
    if (preparation.oneOffItemIds === undefined) preparation.oneOffItemIds = [];
    out.preparation = preparation;
  }
  return out;
}

/** The plan's home zone is frozen by whichever device wrote it FIRST (smallest
 *  createdAt; ties by zone name) — order-independent, so every device converges. */
function earlierOrigin(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? a : b;
  return compareStrings(a.timezone || '', b.timezone || '') <= 0 ? a : b;
}

/** Per-item last-writer-wins by id (identical to the legacy/operational item merge —
 *  the same concurrency safety, not a weaker one), preparation merged by the legacy
 *  contract, home zone/creation instant fixed by the earliest writer. Order-independent.
 *  @param {object|null} localValue @param {object|null} remoteValue @param {string} planId */
export function mergeCalendarPlanRecords(localValue, remoteValue, planId) {
  const dateKey = parseCalendarPlanId(planId);
  if (!dateKey) throw new Error('A valid calendar plan id is required.');
  const local = restorePrunedPlanRecord(localValue && typeof localValue === 'object' ? localValue : {});
  const remote = restorePrunedPlanRecord(remoteValue && typeof remoteValue === 'object' ? remoteValue : {});
  const byId = new Map();
  for (const item of planItems(local.items)) if (item.id) byId.set(item.id, item);
  for (const item of planItems(remote.items)) {
    if (!item.id) continue;
    byId.set(item.id, byId.has(item.id) ? chooseItem(byId.get(item.id), item) : item);
  }
  const localAt = mergeTimestamp(local.updatedAt);
  const remoteAt = mergeTimestamp(remote.updatedAt);
  const latest = localAt === remoteAt
    ? (compareStrings(writerName(remote.updatedBy) || '', writerName(local.updatedBy) || '') >= 0 ? remote : local)
    : (remoteAt > localAt ? remote : local);
  const merged = {
    items: [...byId.values()].sort((a, b) => compareStrings(String(a.id), String(b.id))),
    updatedAt: Math.max(localAt, remoteAt),
  };
  const writer = writerName(latest.updatedBy);
  if (writer) merged.updatedBy = writer;
  const origin = earlierOrigin(
    mergeTimestamp(local.createdAt) && typeof local.timezone === 'string' ? { createdAt: mergeTimestamp(local.createdAt), timezone: local.timezone } : null,
    mergeTimestamp(remote.createdAt) && typeof remote.timezone === 'string' ? { createdAt: mergeTimestamp(remote.createdAt), timezone: remote.timezone } : null,
  );
  if (origin) { merged.createdAt = origin.createdAt; merged.timezone = origin.timezone; }
  const preparation = mergePreparations(local.preparation, remote.preparation, dateKey);
  if (preparation) merged.preparation = preparation;
  return merged;
}

// ── authority cutover: activation facts ─────────────────────────────────────

function factId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[./#$[\]]/.test(value);
}

/** @param {*} fact @returns {boolean} */
export function validateActivationFact(fact) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return false;
  if (fact.schemaVersion !== CALENDAR_AUTHORITY_SCHEMA_VERSION || !factId(fact.id)) return false;
  if (!Number.isFinite(fact.activatedAtMs) || fact.activatedAtMs <= 0) return false;
  if (typeof fact.deviceId !== 'string' || !fact.deviceId || fact.deviceId.length > 200) return false;
  if (!validOperationalDayTimezone(fact.timezone) || !validPlanDate(fact.activationDate)) return false;
  // The stored date must be the date the instant really was in the stored zone — a fact
  // whose three fields disagree is rejected, never repaired.
  return localPlanDate(fact.activatedAtMs, fact.timezone) === fact.activationDate;
}

/** @param {{id:string, nowMs:number, timezone:string, deviceId:string}} input @returns {object} */
export function buildActivationFact({ id, nowMs, timezone, deviceId }) {
  const canonicalTz = canonicalizeOperationalDayTimezone(timezone);
  const fact = {
    schemaVersion: CALENDAR_AUTHORITY_SCHEMA_VERSION,
    id,
    activatedAtMs: nowMs,
    timezone: canonicalTz,
    activationDate: localPlanDate(nowMs, canonicalTz),
    deviceId,
  };
  if (!validateActivationFact(fact)) throw new Error('Invalid calendar authority activation.');
  return fact;
}

/** The effective activation of a set of facts: the EARLIEST (activatedAtMs, then id).
 *  A grow-only set with a total order — every device that holds the same facts picks
 *  the same one, whatever order they arrived in. @param {object[]} facts @returns {object|null} */
export function effectiveActivation(facts) {
  const valid = (Array.isArray(facts) ? facts : []).filter(validateActivationFact);
  if (!valid.length) return null;
  return valid.reduce((best, fact) => (
    fact.activatedAtMs < best.activatedAtMs || (fact.activatedAtMs === best.activatedAtMs && compareStrings(fact.id, best.id) < 0) ? fact : best
  ));
}

/** Which store is authoritative for `dateKey`: 'calendar' on/after the effective
 *  activation's date, otherwise 'legacy' (Personal Day / operational / plans[dateKey]).
 *  With no activation everything is legacy. */
export function calendarAuthorityForDate(dateKey, activation) {
  if (!activation || !validPlanDate(dateKey)) return 'legacy';
  return dateKey >= activation.activationDate ? 'calendar' : 'legacy';
}
