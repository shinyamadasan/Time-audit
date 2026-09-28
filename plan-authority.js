// plan-authority.js
//
// The ONE access layer every user-facing planning consumer goes through, so no
// screen ever chooses a plan store for itself (Single Plan Authority V1).
//
//    consumer -> Plan Authority -> authoritative store
//
// Storage stays dual for backward compatibility; user-visible authority does not.
// Authority is decided ONLY by the governing boundary revision, via
// resolvePlanAuthority() — never by which store happens to hold data, never by
// "whichever is non-empty", never by record content. A legacy-governed day is
// plans[dateKey]; an operational-governed day is the operational-plan store.
//
// ── what a "target" is ──────────────────────────────────────────────────────
// Every function here speaks in plan TARGETS, never bare calendar dates:
//
//   { store: 'legacy'|'operational', id, dateKey?, operationalDayId?, ref,
//     startMs, endMs, timezone, boundaryTime, legacy }
//
// `id` is the authoritative identity (a dateKey for legacy, an operationalDayId
// for operational). Consumers pass targets around; they never reconstruct one
// from a date string, because a bare date does not identify a plan once a
// personal day boundary is active (Decision B).
//
// ── Decision A: routine ownership ───────────────────────────────────────────
// Routine instance identity stays [routineId, calendarDate] — never migrated,
// never given an operationalDayId. A routine is mapped to a personal day by an
// INSTANT:
//   - exact/window routines: their own start clock time on their own date;
//   - anytime/cue routines:  12:00 local on their own date (the noon anchor).
// Both are resolved in the timezone the ROUTINE SUBSYSTEM owns for that date
// (daily-routines' state.timezone, carried on every generated instance), not in
// the boundary revision's timezone — the source subsystem keeps its own date
// semantics. The anchor instant then goes through the ordinary boundary
// machinery, so a noon anchor landing exactly on a 12:00 boundary belongs to the
// day that STARTS there (the existing half-open rule, no special case).
// Civil-time anomalies are not guessed: an ambiguous or nonexistent local
// reading fails explicitly and the routine is reported unplaceable.
//
// ── Decision B: a calendar date is a lookup key, not a plan identity ────────
// For history screens, `daysOverlappingCalendarDate()` returns EVERY
// authoritative day overlapping that calendar date's own interval. Callers
// render them as separate, labeled, read-only cards. Nothing merges them into a
// synthetic "plan for D", and nothing copies between stores.

import {
  operationalDayContaining,
  nextOperationalDay,
  resolveLocalWallClock,
  proposeBoundaryRevision,
  parseOperationalDayId,
} from './personal-day-boundary-model.js';
import {
  collectStaleUnfinished,
  buildMovedItem,
  buildDismissedItem,
  buildUndismissedItem,
  collectRecoveryConflicts,
  findMoveDestination,
} from './stale-plan-recovery-model.js';
import {
  validateOperationalPlanItemRange,
  buildOperationalPreparation,
  normalizeOperationalPreparation,
} from './operational-plan-model.js';
import {
  addCalendarDays,
  buildPreparation,
  computeReadyNow,
  localPlanDate,
  normalizePreparation,
  planningConsistency,
  planningStreak,
  validPlanDate,
  validPlanItemRange,
  validPlanItemDuration,
  clearPlanItemRange,
  carriedItemId,
  classifyOneOffActual,
  activePriorityPlanItems,
  planItemKind,
  withPlanItemKind,
} from './plan-tomorrow-model.js';
import {
  canonicalPlanItemRelocations,
  nextPlanItemRelocation,
  planItemIsActiveInDay,
} from './plan-item-relocation.js';
import {
  deadlineInstantForCalendarDate,
  evaluatePlanningDeadlineQualification,
  offDayDeclaredAtForDeadline,
} from './plan-by-deadline-model.js';
import {
  calendarAuthorityForDate,
  calendarItemInstants,
  calendarPlanId,
  calendarPlanInterval,
  parseCalendarPlanId,
  stampCalendarItemTimes,
  validateCalendarPlanItem,
} from './calendar-plan-model.js';
// Side-effect import: personal-day-boundary-live.js owns the
// `window.PersonalDayBoundaryLive` singleton this module's own singleton composes,
// so importing it here makes that construction order a module-graph guarantee
// rather than a dependency on <script> tag order. Inert under `node --test`.
import './personal-day-boundary-live.js';
// Same reasoning: plan-by-deadline-sync.js owns `window.PlanByDeadlineSync`,
// whose `.repository` this module's singleton reads for planningDeadlineStreak().
import './plan-by-deadline-sync.js';
// Same reasoning: calendar-plan-live.js owns `window.CalendarPlanLive`, the calendar-native
// plan store this module's singleton routes calendar-authoritative days to.
import './calendar-plan-live.js';

/** Carry-forward ids for non-legacy destinations. Deliberately NOT the legacy
 *  `carry:<date>:<itemId>` shape (plan-tomorrow-model.js's carriedItemId, which
 *  only accepts a bare calendar date and must keep doing exactly that): an
 *  operationalDayId is not a date and must never be coerced into one. Built from
 *  immutable SOURCE identities only — source day + source item — so concurrent
 *  recoveries to different days still name one logical recovered item. Its
 *  relocationRevision is the destination claim. '|' is the separator
 *  because an operationalDayId itself contains ':'; a minted plan item id
 *  ('p' + base36) can never contain either. */
export const OPERATIONAL_CARRY_ID_PREFIX = 'ocarry1';

export function operationalCarriedItemId(sourceDayId, sourceItemId) {
  // The SOURCE is whatever that day's own authoritative identity is — an
  // operationalDayId, or a calendar dateKey on the transition day, when an item
  // is carried from the last legacy-governed day into the first personal one.
  // Neither is coerced into the other; each is used verbatim.
  const validSource = !!parseOperationalDayId(sourceDayId) || !!parseCalendarPlanId(sourceDayId) || validPlanDate(sourceDayId);
  if (!validSource) throw new Error('A valid source day identity is required.');
  if (typeof sourceItemId !== 'string' || !sourceItemId || sourceItemId.includes('|')) throw new Error('A valid source item id is required.');
  return `${OPERATIONAL_CARRY_ID_PREFIX}|${sourceDayId}|${sourceItemId}`;
}

/** The carry id for a source recovery. Legacy -> legacy keeps the exact
 *  existing id, so nothing already stored changes meaning; anything landing
 *  in a personal/calendar day gets the source-owned operational format. */
export function carryItemIdFor(sourceTarget, sourceItemId, destinationTarget) {
  if (destinationTarget.store === 'legacy') {
    if (sourceTarget.store !== 'legacy') {
      // Would require naming a personal day inside a calendar-day id. Cannot
      // happen in the product (no disable path means no operational -> legacy
      // succession), and is refused rather than fudged if it ever does.
      throw new Error('Carrying from a personal day into a calendar day is not supported.');
    }
    return carriedItemId(sourceTarget.dateKey, sourceItemId);
  }
  return operationalCarriedItemId(sourceTarget.id, sourceItemId);
}

/** 12:00 local on a calendar date, in that date's OWN subsystem timezone. */
export function noonAnchorInstant(dateStr, timezone) {
  return resolvePlannedInstant(dateStr, '12:00', timezone);
}

function resolvePlannedInstant(dateStr, hhmm, timezone) {
  const resolved = resolveLocalWallClock(dateStr, hhmm, timezone);
  if (resolved.kind === 'unique') return { ok: true, instantMs: resolved.instantMs };
  // Never guessed. A repeated or skipped local reading is reported so the caller
  // can say so instead of silently filing the routine under the wrong day.
  if (resolved.kind === 'ambiguous') return { ok: false, reason: 'ambiguous', earlierMs: resolved.earlierMs, laterMs: resolved.laterMs };
  return { ok: false, reason: 'nonexistent', gapMinutes: resolved.gapMinutes };
}

/** Decision A, as a pure function of a generated routine instance. `instance` is
 *  daily-routines-model.js's own generateInstances() output: { date, timezone,
 *  routine }. Returns the instant that decides which personal day owns it. */
export function routineAnchorInstant(instance) {
  const routine = instance?.routine;
  if (!routine || !validPlanDate(instance.date) || typeof instance.timezone !== 'string') return { ok: false, reason: 'invalid-instance' };
  const timed = (routine.mode === 'exact' || routine.mode === 'window') && typeof routine.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(routine.time);
  return timed
    ? { ...resolvePlannedInstant(instance.date, routine.time, instance.timezone), anchor: 'start' }
    : { ...noonAnchorInstant(instance.date, instance.timezone), anchor: 'noon' };
}

const OVERLAP_GUARD = 400;

/** How far ahead the future-day browser may address, in personal days (~2 years).
 *  A structural safety bound on iteration, NOT a product horizon on what can be
 *  planned or discovered: a day already prepared beyond it is still stored, still
 *  synced and still listed by preparedPlans(). It exists so a malformed revision
 *  history cannot make a walk run away. */
const DAY_AHEAD_GUARD = 730;

export function createPlanAuthority(deps = {}) {
  const live = deps.live;
  const legacy = deps.legacy;
  if (!live || !legacy) throw new Error('Plan authority needs the boundary live wiring and the legacy plan store.');
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const accountTimezone = typeof deps.accountTimezone === 'function' ? deps.accountTimezone : () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Optional: the Plan-by-deadline repository (readDeadlines(), readOffDay(dateKey)).
  // Absent for any caller that hasn't wired it up yet (including every existing
  // test) — planningDeadlineStreak() reports 'unenforced' rather than throwing,
  // exactly like an account that has never configured a deadline.
  const planByDeadline = deps.planByDeadline || null;
  // Optional: the calendar-native plan store's live wiring (calendar-plan-live.js). Absent
  // for every caller that has not wired it up (including every pre-existing test) — the
  // account is then simply never calendar-active and every behavior below is exactly the
  // legacy/operational behavior it always was.
  const calendar = deps.calendar || null;
  // The calendar-date interval a HISTORY SCREEN owns (index.html's own
  // tzParseTime-based day bounds in production), injected rather than
  // re-derived, so the projection can never disagree with the screen's own
  // entry-window arithmetic (Decision B step 1).
  const calendarDayBounds = typeof deps.calendarDayBounds === 'function'
    ? deps.calendarDayBounds
    : dateKey => {
      const timezone = accountTimezone();
      const start = resolvePlannedInstant(dateKey, '00:00', timezone);
      const end = resolvePlannedInstant(addCalendarDays(dateKey, 1), '00:00', timezone);
      if (!start.ok || !end.ok) throw new Error(`Calendar day ${dateKey} has no unambiguous local interval.`);
      return { startMs: start.instantMs, endMs: end.instantMs };
    };

  // Called after an OPERATIONAL write (the legacy store runs its own equivalent
  // from inside writeDatePlanLocal), so the app re-renders the surfaces that just
  // changed instead of each caller remembering to.
  // The Top Priority cap. A PRODUCT policy, not temporal truth — injected so
  // index.html's PLAN_MAX stays the single place the number is declared, and
  // enforced HERE as well as in the UI so no future planning surface can bypass
  // it by calling the authority directly.
  const priorityMax = Number.isInteger(deps.priorityMax) && deps.priorityMax > 0 ? deps.priorityMax : 3;

  const onWrite = typeof deps.onWrite === 'function' ? deps.onWrite : () => {};

  let cacheToken = 0;
  let streakCache = null;
  let relocationCache = null;

  /** Every write path and every inbound remote merge calls this; derived values
   *  (currently the Planning Streak walk) are recomputed on the next read. */
  function invalidate() {
    cacheToken++;
    streakCache = null;
    relocationCache = null;
  }

  /** Derived caches belong to the account whose operational cache they were built
   *  from: a switch changes this key, so nothing derived for A is ever served under B. */
  function cacheKey() {
    let owner = '';
    try { owner = live.planRepository?.ownerRoomId?.() || ''; } catch { owner = ''; }
    return `${cacheToken}|${owner}`;
  }

  /** The account's effective calendar-native activation, or null. Non-writing. */
  function calendarActivation() {
    try { return calendar?.activation?.() ?? null; } catch { return null; }
  }

  /** UNKNOWN is a real authority state, never an alias for LEGACY. */
  function authorityState() {
    if (!calendar) return 'legacy';
    if (typeof calendar.authorityState === 'function') return calendar.authorityState();
    return calendarActivation() ? 'calendar' : 'legacy';
  }

  /** True once the account has cut over to calendar-native plans (the owner's explicit,
   *  account-owned, one-way activation). */
  function calendarActive() {
    return authorityState() === 'calendar';
  }

  /** A Personal Day boundary history exists. This alone says nothing about which store
   *  is authoritative for a NEW plan once the account has cut over — it only describes
   *  the LEGACY routing that still governs every day before the cutover. */
  function boundaryEnabled() {
    return live.enabled();
  }

  /** Operational personal-day mode is in force: a boundary is configured AND the account
   *  has not cut over. Every consumer that asks "is this account on a personal day?"
   *  (My Day window, day navigation, the personal-day status strip) gets the truth for
   *  NEW planning: after the cutover the answer is no, whatever the boundary says. */
  function enabled() {
    return boundaryEnabled() && authorityState() === 'legacy';
  }

  /** Which store is authoritative for a calendar date: 'calendar' on/after the effective
   *  activation date, otherwise 'legacy'. Decided by the account's own activation fact —
   *  never by which store holds data. */
  function isCalendarAuthoritative(dateKey) {
    if (authorityState() === 'unknown') return null;
    return calendarAuthorityForDate(dateKey, calendarActivation()) === 'calendar';
  }

  // ── targets ───────────────────────────────────────────────────────────────

  function legacyTarget(dateKey) {
    if (!validPlanDate(dateKey)) throw new Error(`A valid calendar date is required, got: ${dateKey}`);
    return { store: 'legacy', id: dateKey, dateKey, ref: null, startMs: null, endMs: null, timezone: accountTimezone(), boundaryTime: '00:00', legacy: true };
  }

  function fromDay(day) {
    return day.authority.store === 'legacy'
      ? { ...legacyTarget(day.authority.dateKey), ref: day.ref, startMs: day.startMs, endMs: day.endMs, timezone: day.timezone, boundaryTime: day.boundaryTime }
      : { store: 'operational', id: day.authority.operationalDayId, operationalDayId: day.authority.operationalDayId, ref: day.ref, startMs: day.startMs, endMs: day.endMs, timezone: day.timezone, boundaryTime: day.boundaryTime, legacy: false };
  }

  /** The calendar-native target for one date. Its HOME interval is that calendar date in
   *  the plan's own frozen zone (the zone of whoever wrote it first) — the account's
   *  current zone only until the first write freezes one. `boundaryTime` is '00:00' by
   *  definition: a calendar plan has no boundary. */
  function calendarTarget(dateKey, knownRecord) {
    const planId = calendarPlanId(dateKey);
    // A caller that already holds the record passes it, so listing N plans never re-reads storage N times.
    const stored = knownRecord !== undefined ? knownRecord : calendar?.readRecord?.(dateKey);
    const timezone = stored?.timezone || accountTimezone();
    const { startMs, endMs } = calendarPlanInterval(dateKey, timezone);
    return { store: 'calendar', id: planId, calendarPlanId: planId, dateKey, ref: null, startMs, endMs, timezone, boundaryTime: '00:00', legacy: false, calendar: true };
  }

  // The legacy-routed navigation below is the pre-cutover behavior VERBATIM (it is what
  // still answers for every date before an activation, and for every account that has
  // not activated). It reads boundaryEnabled(), never the composite enabled().

  function legacyCurrent(nowMs = now()) {
    if (!boundaryEnabled()) return legacyTarget(localPlanDate(nowMs, accountTimezone()));
    return fromDay(live.planningDays(nowMs).current);
  }

  function legacyUpcoming(nowMs = now()) {
    if (!boundaryEnabled()) return legacyTarget(addCalendarDays(localPlanDate(nowMs, accountTimezone()), 1));
    return fromDay(live.planningDays(nowMs).upcoming);
  }

  function legacyContaining(instantMs) {
    if (!boundaryEnabled()) return legacyTarget(localPlanDate(instantMs, accountTimezone()));
    return fromDay(live.dayContaining(instantMs));
  }

  function legacyNext(target) {
    if (target.store === 'legacy' && !boundaryEnabled()) return legacyTarget(addCalendarDays(target.dateKey, 1));
    const history = live.revisions();
    return fromDay(live.describeDay(nextOperationalDay(target.ref || operationalDayContaining(target.startMs, history), history), history));
  }

  function legacyPrevious(target) {
    if (target.store === 'legacy' && !boundaryEnabled()) return legacyTarget(addCalendarDays(target.dateKey, -1));
    if (!Number.isFinite(target.startMs)) throw new Error(`Cannot find the day before ${target.id}.`);
    return legacyContaining(target.startMs - 1);
  }

  function legacyDaysOverlappingCalendarDate(dateKey) {
    if (!boundaryEnabled()) return [legacyTarget(dateKey)];
    const { startMs, endMs } = calendarDayBounds(dateKey);
    const history = live.revisions();
    const out = [];
    let ref = operationalDayContaining(startMs, history);
    for (let guard = 0; guard <= OVERLAP_GUARD; guard++) {
      const day = live.describeDay(ref, history);
      if (day.startMs >= endMs) break;
      out.push(fromDay(day));
      if (day.endMs >= endMs) break;
      ref = nextOperationalDay(ref, history);
    }
    if (!out.length) throw new Error(`No authoritative day overlaps ${dateKey}.`);
    return out;
  }

  // ── the public chain: calendar-authoritative dates first, legacy otherwise ─

  /** The authoritative day for RIGHT NOW. Once the account has cut over this is the
   *  plan of today's CALENDAR DATE, whatever a Personal Day boundary says. Otherwise it is
   *  exactly what it always was: for an account that never enabled a boundary the existing
   *  calendar "today" (same helper, same account timezone — no boundary math, no
   *  operational store, no listener), and the operational day for one that did. */
  function current(nowMs = now()) {
    if (authorityState() === 'unknown') return null;
    const today = localPlanDate(nowMs, accountTimezone());
    if (isCalendarAuthoritative(today)) return calendarTarget(today);
    return legacyCurrent(nowMs);
  }

  /** The authoritative day the owner prepares in advance: tomorrow's calendar plan once
   *  cut over; otherwise the legacy/operational upcoming day. */
  function upcoming(nowMs = now()) {
    if (authorityState() === 'unknown') return null;
    const tomorrow = addCalendarDays(localPlanDate(nowMs, accountTimezone()), 1);
    if (isCalendarAuthoritative(tomorrow)) return calendarTarget(tomorrow);
    return legacyUpcoming(nowMs);
  }

  /** The authoritative day containing a factual instant (an entry, a routine
   *  anchor, a completion). Never a date string — an instant is unambiguous. */
  function containing(instantMs) {
    if (!Number.isFinite(instantMs)) throw new Error('A valid instant is required.');
    if (authorityState() === 'unknown') return null;
    const dateKey = localPlanDate(instantMs, accountTimezone());
    if (isCalendarAuthoritative(dateKey)) return calendarTarget(dateKey);
    return legacyContaining(instantMs);
  }

  function next(target) {
    if (target.store === 'calendar') return calendarTarget(addCalendarDays(target.dateKey, 1));
    return legacyNext(target);
  }

  /** The authoritative day immediately before `target`. Personal-day ids are never treated
   *  as calendar dates; a calendar plan's predecessor is the previous calendar date's plan
   *  — until the cutover date, where the chain hands over to the legacy day that was in
   *  force the instant before the calendar date began. */
  function previous(target) {
    if (target.store === 'calendar') {
      const before = addCalendarDays(target.dateKey, -1);
      if (isCalendarAuthoritative(before)) return calendarTarget(before);
      return legacyContaining(target.startMs - 1);
    }
    return legacyPrevious(target);
  }

  /** Decision B. Every authoritative day overlapping calendar date D's own interval, in
   *  order. A calendar-authoritative date has EXACTLY ONE plan — its own (the previous
   *  date's plan reaching into it is a separate projection: calendarCarryoverFor). One
   *  entry for a legacy/never-enabled account; commonly two once a non-midnight boundary
   *  is active and the account has not cut over. */
  function daysOverlappingCalendarDate(dateKey) {
    if (authorityState() === 'unknown') return [];
    if (isCalendarAuthoritative(dateKey)) return [calendarTarget(dateKey)];
    return legacyDaysOverlappingCalendarDate(dateKey);
  }

  /** Planning Continuity V1 (G4) — the authoritative day `steps` days after the current
   *  one. Deliberately implemented by CHAINING next(), not by adding days to a date, for
   *  the legacy chain (a personal day's length is not fixed); a calendar plan chains by
   *  calendar date. No new store, no new identity — every step returns an ordinary target.
   *  Bounded by DAY_AHEAD_GUARD so a malformed revision history cannot spin. */
  function dayAhead(steps, nowMs = now()) {
    if (!Number.isInteger(steps) || steps < 0) throw new Error('A non-negative whole number of days ahead is required.');
    if (steps > DAY_AHEAD_GUARD) throw new Error(`Cannot address more than ${DAY_AHEAD_GUARD} personal days ahead.`);
    let target = current(nowMs);
    for (let i = 0; i < steps; i++) {
      const step = next(target);
      // A step that fails to move strictly forwards means a malformed history;
      // stop rather than loop or silently return the same day twice.
      if (target.store === 'operational' && step.store === 'operational' && !(step.startMs > target.startMs)) {
        throw new Error('The boundary revision history does not move forwards.');
      }
      target = step;
    }
    return target;
  }

  /** The authoritative day containing a future calendar date's own noon anchor. For a
   *  calendar-authoritative date that is simply the date's own plan (a calendar date IS a
   *  plan identity there). For legacy days it is a convenience for "which personal day is
   *  Sep 30 mostly about?" — NOT an identity. */
  function dayForCalendarDate(dateKey) {
    if (!validPlanDate(dateKey)) throw new Error(`A valid calendar date is required, got: ${dateKey}`);
    if (isCalendarAuthoritative(dateKey)) return calendarTarget(dateKey);
    if (!boundaryEnabled()) return legacyTarget(dateKey);
    const anchor = noonAnchorInstant(dateKey, accountTimezone());
    if (!anchor.ok) throw new Error(`Calendar date ${dateKey} has no unambiguous local noon.`);
    return legacyContaining(anchor.instantMs);
  }

  /** Item-centric scheduling. Untimed tasks use the approved noon ownership
   *  rule; timed tasks use the exact civil timestamp the owner entered. A calendar date's
   *  tasks belong to that date's plan — the plan is chosen by the date the owner named. */
  function dayForScheduledDate(dateKey, when = '') {
    if (!validPlanDate(dateKey)) return { ok: false, reason: 'invalid-date' };
    if (isCalendarAuthoritative(dateKey)) {
      const target = calendarTarget(dateKey);
      if (!when) return { ok: true, anchor: 'noon', target };
      const instant = resolvePlannedInstant(dateKey, when, accountTimezone());
      return instant.ok ? { ok: true, anchor: 'time', instantMs: instant.instantMs, target } : instant;
    }
    if (!when) return { ok: true, anchor: 'noon', target: dayForCalendarDate(dateKey) };
    const instant = resolvePlannedInstant(dateKey, when, accountTimezone());
    if (!instant.ok) return instant;
    return { ok: true, anchor: 'time', instantMs: instant.instantMs, target: legacyContaining(instant.instantMs) };
  }

  /** Finds the civil date which pairs `hhmm` with an instant inside `target`.
   *  The target is primary: search its overlapping local dates and accept
   *  exactly one instant in the half-open interval. A calendar plan's own date is the
   *  answer by definition (a next-day reading is expressed by the item's offset). */
  function civilDateForTimeInTarget(target, hhmm) {
    if (!target?.id) return { ok: false, reason: 'invalid-target' };
    if (typeof hhmm !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return { ok: false, reason: 'invalid-time' };
    if (target.store === 'calendar') {
      const resolved = resolvePlannedInstant(target.dateKey, hhmm, target.timezone || accountTimezone());
      return resolved.ok ? { ok: true, anchor: 'target-time', dateKey: target.dateKey, instantMs: resolved.instantMs, target } : resolved;
    }
    const { startMs, endMs } = targetInterval(target);
    const timezone = target.timezone || accountTimezone();
    const first = localPlanDate(startMs, timezone);
    const last = localPlanDate(endMs - 1, timezone);
    const dates = [];
    for (let dateKey = first; dateKey <= last; dateKey = addCalendarDays(dateKey, 1)) dates.push(dateKey);
    const matches = [];
    let nonexistent = null;
    for (const dateKey of dates) {
      const resolved = resolvePlannedInstant(dateKey, hhmm, timezone);
      if (resolved.ok) {
        if (resolved.instantMs >= startMs && resolved.instantMs < endMs) matches.push({ dateKey, instantMs: resolved.instantMs });
      } else if (resolved.reason === 'ambiguous') {
        for (const instantMs of [resolved.earlierMs, resolved.laterMs]) {
          if (instantMs >= startMs && instantMs < endMs) matches.push({ dateKey, instantMs });
        }
      } else if (resolved.reason === 'nonexistent') nonexistent = resolved;
    }
    const unique = [...new Map(matches.map(match => [match.instantMs, match])).values()]
      .sort((a, b) => a.instantMs - b.instantMs || a.dateKey.localeCompare(b.dateKey));
    if (unique.length === 1) return { ok: true, anchor: 'target-time', ...unique[0], target };
    if (unique.length > 1) return { ok: false, reason: 'ambiguous', matches: unique };
    if (nonexistent) return nonexistent;
    return { ok: false, reason: 'outside-target' };
  }

  /** Optional inverse of dayForScheduledDate(). Some truncated My Days contain
   *  no local noon, so no date-only civil date can represent them. `null` is an
   *  explicit presentation result; the authoritative target remains usable. A calendar
   *  plan is named by its own date. */
  function scheduledDateForTarget(target, when = '') {
    if (!target?.id) throw new Error('An authoritative target is required.');
    if (target.store === 'calendar') return target.dateKey;
    if (target.store === 'legacy' && !boundaryEnabled()) return target.dateKey;
    if (when) {
      const resolved = civilDateForTimeInTarget(target, when);
      return resolved.ok ? resolved.dateKey : null;
    }
    const bounds = targetInterval(target);
    const first = localPlanDate(bounds.startMs, accountTimezone());
    const last = localPlanDate(bounds.endMs - 1, accountTimezone());
    const candidates = new Set();
    for (const seed of [first, last]) {
      for (let offset = -1; offset <= 1; offset++) candidates.add(addCalendarDays(seed, offset));
    }
    const matches = [...candidates].filter(dateKey => {
      const resolved = dayForScheduledDate(dateKey, '');
      return resolved.ok && resolved.target.id === target.id;
    }).sort();
    return matches.length === 1 ? matches[0] : null;
  }

  /** A window of consecutive authoritative days starting at the current one —
   *  what the future-day browser lists. Pure projection over next(); creates
   *  nothing and writes nothing. */
  function upcomingDays(count, nowMs = now()) {
    if (!Number.isInteger(count) || count < 1) throw new Error('A positive whole number of days is required.');
    if (count > DAY_AHEAD_GUARD) throw new Error(`Cannot list more than ${DAY_AHEAD_GUARD} personal days.`);
    const out = [current(nowMs)];
    while (out.length < count) {
      const previous = out[out.length - 1];
      const step = next(previous);
      if (previous.store === 'operational' && step.store === 'operational' && !(step.startMs > previous.startMs)) break;
      out.push(step);
    }
    return out;
  }

  // ── authoritative plan access ─────────────────────────────────────────────

  function record(target) {
    if (target.store === 'calendar') return calendar ? calendar.readRecord(target.dateKey) : null;
    return target.store === 'legacy' ? legacy.record(target.dateKey) : live.readRecord(target);
  }

  /** Raw items INCLUDING tombstones — the shape every editor mutates. */
  function rawItems(target) {
    if (target.store === 'legacy') return legacy.rawItems(target.dateKey);
    return Array.isArray(record(target)?.items) ? record(target).items : [];
  }

  function relocationIndex() {
    const token = cacheKey();
    if (relocationCache?.token === token) return relocationCache.value;
    const value = canonicalPlanItemRelocations(allDayRecords());
    relocationCache = { token, value };
    return value;
  }

  function items(target) {
    const canonical = relocationIndex();
    return rawItems(target).filter(item => planItemIsActiveInDay(item, target.id, canonical));
  }

  function targetInterval(target) {
    if (Number.isFinite(target?.startMs) && Number.isFinite(target?.endMs)) return { startMs: target.startMs, endMs: target.endMs };
    if (target?.store === 'legacy' && validPlanDate(target.dateKey)) return calendarDayBounds(target.dateKey);
    throw new Error('That My Day interval cannot be resolved.');
  }

  /** The instant a day stopped being live: its own end — or, for a LEGACY day the account's
   *  cutover superseded, the cutover instant if that came first. After the cutover nothing
   *  may be written to a legacy day again; its unfinished work is recovered through the
   *  ordinary Unfinished flow, which is what treating it as "ended" buys us. */
  function effectiveEndMs(target) {
    const { endMs } = targetInterval(target);
    const activation = calendarActivation();
    return activation && target.store !== 'calendar' ? Math.min(endMs, activation.activatedAtMs) : endMs;
  }

  function assertDirectSchedulingTarget(target, nowMs = now()) {
    if (effectiveEndMs(target) <= nowMs) throw new Error('Past My Days are history. Reschedule unfinished work from Unfinished instead.');
    return target;
  }

  function assertLegacyWriteAuthority(target, allowRecovery = false) {
    if (target.store === 'calendar' || !calendar) return;
    const state = authorityState();
    if (state === 'unknown') throw new Error('Plan authority is still syncing. No legacy planning change was saved.');
    if (state === 'calendar' && !allowRecovery) throw new Error('Legacy plans are read-only after calendar-day activation.');
  }

  function saveItems(target, nextItems, { allowLegacyRecovery = false } = {}) {
    assertLegacyWriteAuthority(target, allowLegacyRecovery);
    if (target.store === 'legacy') {
      legacy.saveItems(target.dateKey, nextItems, { allowLegacyRecovery });
      invalidate();
      return target;
    }
    if (target.store === 'calendar') {
      if (!calendar) throw new Error('Calendar-day plans are not available yet.');
      calendar.writePlanItems(target.dateKey, nextItems);
      invalidate();
      onWrite();
      return target;
    }
    live.writePlanItems(target, nextItems, live.revisions());
    invalidate();
    onWrite();
    return target;
  }

  // ── preparation / prepared state ──────────────────────────────────────────

  /** The normalized preparation for an ALREADY-READ stored value. Split out so a
   *  caller that already holds the record (the streak walk, which snapshots both
   *  stores once) never re-reads storage — without either path being able to
   *  imply a different rule than the other. */
  function preparationFrom(target, value) {
    // A calendar plan's preparation IS the legacy date-keyed contract (targetDate = its date).
    return target.store !== 'operational' ? normalizePreparation(value, target.dateKey) : normalizeOperationalPreparation(value, target.id);
  }

  function preparation(target) {
    return preparationFrom(target, record(target)?.preparation);
  }

  /** 'ahead' | 'late' | 'unknown' | 'not-prepared'. The legacy branch is the
   *  existing planningConsistency() verbatim. The operational rule is the same
   *  statement expressed against the day's own start instant: prepared BEFORE
   *  this personal day began. (For a legacy day those are the same sentence —
   *  a calendar date's start is midnight.) */
  function consistencyFrom(target, value) {
    if (target.store !== 'operational') return planningConsistency(value, target.dateKey);
    if (value === undefined || value === null) return 'not-prepared';
    const prepared = normalizeOperationalPreparation(value, target.id);
    if (!prepared) return 'unknown';
    return prepared.firstPreparedAt < target.startMs ? 'ahead' : 'late';
  }

  function consistency(target) {
    return consistencyFrom(target, record(target)?.preparation);
  }

  /** The same "is there anything actionable here" question computeReadyNow()
   *  answers for a legacy day, asked of whichever store is authoritative. */
  function readyNow(target, routines = [], localSaveSucceeded = true) {
    const plan = record(target);
    if (target.store !== 'operational') return computeReadyNow({ plan: plan ? { ...plan, items: items(target) } : plan, targetDate: target.dateKey, routines, localSaveSucceeded });
    const prepared = normalizeOperationalPreparation(plan?.preparation, target.id);
    if (!prepared || !localSaveSucceeded) return false;
    const oneOffIds = new Set(prepared.oneOffItemIds);
    // Same current-kind rule as computeReadyNow: a prepared priority later demoted to a
    // task no longer keeps the day ready.
    const actionableOneOff = items(target).some(item => oneOffIds.has(item.id) && planItemKind(item) === 'priority' && !item.done);
    const plannedRoutines = new Set(prepared.routineInstanceIds);
    const actionableRoutine = routines.some(row => plannedRoutines.has(row.id) && row.occurs !== false && !row.skipped && row.actionable !== false);
    return actionableOneOff || actionableRoutine || prepared.intentionalBlank;
  }

  function preparedState(target, routines = []) {
    const prepared = preparation(target);
    return {
      target,
      preparation: prepared,
      prepared: !!prepared,
      consistency: consistency(target),
      intentionalBlank: prepared?.intentionalBlank === true,
      readyNow: readyNow(target, routines),
    };
  }

  /** The one confirmation path. Legacy days go through index.html's existing
   *  confirmPreparedDatePlan() untouched (same validation, same streak
   *  semantics, same sync). Operational days build the parallel
   *  operationalDayId-keyed preparation and persist it beside the same items. */
  function confirmPreparation(target, input) {
    const { items: nextItems, mode, intentionalBlank, routineInstanceIds, actionableRoutineInstanceIds = routineInstanceIds } = input;
    if (target.store === 'calendar') {
      if (!calendar) throw new Error('Calendar-day plans are not available yet.');
      if (!Array.isArray(routineInstanceIds) || !Array.isArray(actionableRoutineInstanceIds)) throw new Error('Routine preparation references are invalid.');
      // The same rules the legacy and operational confirmations apply: the cap and readiness are
      // measured on TOP PRIORITIES only; a plan needs one priority, a kept routine, or Open day.
      const priorities = activePriorityPlanItems(nextItems);
      if (priorities.length > priorityMax) throw new Error(`Reduce the plan to ${priorityMax} priorities before confirming.`);
      const acts = priorities.some(item => !item.done) || actionableRoutineInstanceIds.length > 0;
      if (!acts && intentionalBlank !== true) throw new Error('Add one priority, keep a routine, or choose Open day.');
      const built = buildPreparation(record(target)?.preparation, {
        targetDate: target.dateKey,
        timezone: accountTimezone(),
        now: now(),
        mode,
        updatedBy: calendar.deviceId(),
        intentionalBlank: !acts && intentionalBlank === true,
        routineInstanceIds,
        oneOffItemIds: priorities.map(item => item.id),
      });
      const syncPromise = calendar.writePlanWithPreparation(target.dateKey, nextItems, built);
      invalidate();
      onWrite();
      return { localSaved: true, syncPromise };
    }
    if (target.store === 'legacy') {
      assertLegacyWriteAuthority(target);
      const result = legacy.confirm({ targetDate: target.dateKey, items: nextItems, mode, intentionalBlank, routineInstanceIds, actionableRoutineInstanceIds });
      invalidate();
      return result;
    }
    if (!Array.isArray(routineInstanceIds) || !Array.isArray(actionableRoutineInstanceIds)) throw new Error('Routine preparation references are invalid.');
    // Planning Continuity V1: readiness is measured on TOP PRIORITIES only.
    // Secondary planned tasks (kind:'task') and scheduled commitments are real
    // plan capacity but they are not statements of intent, so neither may make a
    // day count as prepared. Narrowing what feeds oneOffItemIds here is what
    // narrows readyNow() and the Planning Streak too — both read the STORED
    // preparation, so neither needs its own rule and the two cannot drift apart.
    // For every item already persisted this is identical: all of them are
    // priorities, because the old 3-cap counted every item.
    const activePriorities = activePriorityPlanItems(nextItems);
    if (activePriorities.length > priorityMax) throw new Error(`Reduce the plan to ${priorityMax} priorities before confirming.`);
    const hasAction = activePriorities.some(item => !item.done) || actionableRoutineInstanceIds.length > 0;
    if (!hasAction && intentionalBlank !== true) throw new Error('Add one priority, keep a routine, or choose Open day.');
    const nowMs = now();
    const built = buildOperationalPreparation(record(target)?.preparation, {
      targetOperationalDayId: target.id,
      now: nowMs,
      mode,
      updatedBy: live.deviceId(),
      intentionalBlank: !hasAction && intentionalBlank === true,
      routineInstanceIds,
      oneOffItemIds: activePriorities.map(item => item.id),
    });
    const syncPromise = live.writePlanWithPreparation(target, nextItems, built, live.revisions());
    invalidate();
    onWrite();
    return { localSaved: true, syncPromise };
  }

  // ── item validation routing (an operational day is not midnight-clamped) ──

  /** Legacy days keep the existing midnight-clamped rule EXACTLY; an operational
   *  day is validated against its own real interval, so a 01:00 block on an
   *  18:00 personal day is valid while 21:00 on a day truncated at 20:00 is not. */
  function validateItem(target, item) {
    if (target.store === 'calendar') {
      if (item?.durationMinutes !== undefined && !validPlanItemDuration(item.durationMinutes)) return { ok: false, reason: 'invalid-range' };
      // Judged exactly as the store will judge it: with the zone the reading would be stamped in.
      let probe;
      try { [probe] = stampCalendarItemTimes(rawItems(target), [item], accountTimezone()); } catch { return { ok: false, reason: 'invalid-timezone' }; }
      return validateCalendarPlanItem(target.dateKey, probe);
    }
    if (target.store === 'legacy') {
      if (item?.durationMinutes === undefined) return { ok: true };
      return validPlanItemRange(item.when, item.durationMinutes) ? { ok: true } : { ok: false, reason: 'invalid-range' };
    }
    // The 720-minute Plan Time Range cap is a PRODUCT policy, not temporal
    // truth, which is why the foundation's resolver deliberately leaves it to
    // callers (see resolvePlannedRangeInOperationalDay). It applies to a
    // personal day exactly as it applies to a calendar day.
    if (item?.durationMinutes !== undefined && !validPlanItemDuration(item.durationMinutes)) return { ok: false, reason: 'invalid-range' };
    return validateOperationalPlanItemRange(target.ref, item, live.revisions());
  }

  /** The real instant a planned "HH:MM" names inside this target — what "is it
   *  due yet?" and "where does this sit on a timeline?" actually need. Legacy
   *  days go through the app's own existing wall-clock resolver (injected), so
   *  due-time behavior for a never-enabled account is unchanged; operational
   *  days go through the foundation's operational-day resolver, which is what
   *  makes 01:00 on an 18:00 day resolve to the following calendar date.
   *  Returns null when the reading is not a canonical HH:MM or cannot be
   *  resolved (a DST gap) — callers already fall back to stable order. */
  function itemStartInstant(target, hhmm, item = null) {
    if (typeof hhmm !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null;
    if (target.store === 'calendar') {
      // A calendar item's instant is a pure function of ITS OWN reading (when + day offset +
      // the zone it was made in) — never of the account's current zone or the Personal Day
      // boundary. Given only a clock reading (no item) the answer is that reading on the
      // plan's own date.
      if (item && item.when === hhmm) {
        const instants = calendarItemInstants(target.dateKey, item.whenTz ? item : { ...item, whenTz: accountTimezone() });
        return instants.ok && instants.timed ? instants.startMs : null;
      }
      const resolved = resolvePlannedInstant(target.dateKey, hhmm, target.timezone || accountTimezone());
      return resolved.ok ? resolved.instantMs : null;
    }
    if (target.store === 'legacy') {
      if (typeof deps.legacyClockInstant !== 'function') return null;
      const resolved = deps.legacyClockInstant(target.dateKey, hhmm);
      return Number.isFinite(resolved) ? resolved : null;
    }
    const resolved = live.resolveClockTime(target, hhmm);
    return resolved.ok ? resolved.instantMs : null;
  }

  /** Daily Reconciliation's per-item verdict, against the day that was
   *  authoritative for it. Legacy days call the existing classifyOneOffActual()
   *  unchanged. An operational day asks the same questions by INSTANT: "done
   *  early" means completed before this personal day began, which is the same
   *  sentence the calendar version expresses with dates. Historical days resolve
   *  through their own governing revision (the target carries it), never through
   *  whatever boundary happens to be active now. */
  function classifyItemActual(target, item, { trackedMinutes = 0, preparedAt = 0, timezone } = {}) {
    if (target.store !== 'operational') {
      return classifyOneOffActual(item, { targetDate: target.dateKey, timezone: timezone || accountTimezone(), trackedMinutes, preparedAt });
    }
    if (item?.deleted && Number(item.updatedAt || 0) >= Number(preparedAt || 0)) return 'removed';
    if (item?.done) {
      return Number.isFinite(item.doneAt) && item.doneAt < target.startMs ? 'done-early' : 'done';
    }
    return trackedMinutes > 0 ? 'worked-on' : 'not-done';
  }

  /** The factual [start, end) window this plan is judged against. Legacy days
   *  keep the calendar-day window the app already computes for entries; an
   *  operational day is its own interval. */
  function evidenceWindow(target) {
    if (target.store !== 'legacy') return { startMs: target.startMs, endMs: target.endMs };
    return calendarDayBounds(target.dateKey);
  }

  /** Review's extended calendar-plan boundary is historical plan truth: date+2
   *  in the plan's frozen home zone, extended only by item-owned factual instants. */
  function reviewEvidenceWindow(target) {
    if (target.store !== 'calendar') return evidenceWindow(target);
    const homeZone = target.timezone || record(target)?.timezone;
    const homeExtent = calendarPlanInterval(addCalendarDays(target.dateKey, 1), homeZone).endMs;
    const itemExtent = items(target).reduce((latest, item) => {
      const instants = itemInstants(target, item);
      return instants ? Math.max(latest, instants.endMs ?? instants.startMs) : latest;
    }, target.endMs);
    return { startMs: target.startMs, endMs: Math.max(homeExtent, itemExtent) };
  }

  // ── Decision A mapping, as targets ────────────────────────────────────────

  /** Which personal day owns this routine instance. `{ ok:false }` when its own
   *  local clock reading is ambiguous/nonexistent — never guessed. */
  function routineTarget(instance) {
    const anchor = routineAnchorInstant(instance);
    if (!anchor.ok) return anchor;
    return { ok: true, anchor: anchor.anchor, instantMs: anchor.instantMs, target: containing(anchor.instantMs) };
  }

  /** The routine instances (from the caller's own generateInstances output) that
   *  belong to `target`. Legacy days keep the existing calendar rule: an
   *  instance belongs to its own date, full stop. */
  function routinesForTarget(target, instances) {
    if (target.store !== 'operational') return { rows: instances.filter(instance => instance.date === target.dateKey), unplaceable: [] };
    const rows = [];
    const unplaceable = [];
    instances.forEach(instance => {
      const resolved = routineTarget(instance);
      if (!resolved.ok) { unplaceable.push({ instance, reason: resolved.reason }); return; }
      if (resolved.target.id === target.id) rows.push(instance);
    });
    return { rows, unplaceable };
  }

  /** Template occurrences (index.html's own generateTemplateEntries output, which
   *  carries real tsStart/ts instants) that fall inside this target. Template
   *  identity stays calendar-based — only the selection is by instant. */
  function templatesForTarget(target, entriesByDate) {
    if (target.store !== 'operational') return entriesByDate(target.dateKey);
    const dates = new Set();
    [target.startMs, target.endMs - 1].forEach(instant => dates.add(localPlanDate(instant, target.timezone)));
    const seen = new Set();
    const out = [];
    [...dates].sort().forEach(date => entriesByDate(date).forEach(entry => {
      const key = `${entry.templateId}:${entry.tsStart}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (entry.tsStart >= target.startMs && entry.tsStart < target.endMs) out.push(entry);
    }));
    return out;
  }

  // ── Planning Streak on authoritative access ───────────────────────────────

  /** Did habit day `target` earn credit? The rule is unchanged in meaning: the
   *  day AFTER it was genuinely prepared (real content or an explicit Open Day)
   *  before that next day began. Only the plan lookup moved. */
  function habitEarned(target, lookup = record) {
    let following;
    try { following = next(target); } catch { return false; }
    return earnsItsPredecessorCredit(following, lookup);
  }

  /** The same rule from the other side: does THIS day, by being prepared ahead
   *  with real content, earn its predecessor a habit day? The streak walk always
   *  already holds the following day, so asking it this way avoids re-deriving
   *  that day once per day of history. */
  function earnsItsPredecessorCredit(following, lookup = record) {
    const value = lookup(following)?.preparation;
    if (consistencyFrom(following, value) !== 'ahead') return false;
    const prepared = preparationFrom(following, value);
    return !!prepared && (prepared.intentionalBlank === true || prepared.routineInstanceIds.length > 0 || prepared.oneOffItemIds.length > 0);
  }

  function longestTrueRun(flags) {
    let longest = 0;
    let run = 0;
    for (const flag of flags) {
      run = flag ? run + 1 : 0;
      if (run > longest) longest = run;
    }
    return longest;
  }

  /** The oldest instant either store can still speak for: the start of the
   *  earliest stored legacy plan's day, or of the earliest stored operational
   *  day, whichever is earlier. This is the streak walk's natural termination —
   *  a day older than every record cannot be judged by anything, so walking past
   *  it can only append `false` flags forever. `null` means no record exists at
   *  all, so there is no finalized history to walk.
   *
   *  A habit day P is judged by P+1's plan, so the walk legitimately reaches ONE
   *  day behind the earliest record — exactly the earliestHabitDate the legacy
   *  planningStreak() derives — which falls out of comparing the day being READ
   *  (the cursor), not the habit day being scored. */
  function historyFloorMs(history) {
    const candidates = [];
    const earliestPlanDate = legacy.earliestPlanDate();
    if (earliestPlanDate) {
      try { candidates.push(calendarDayBounds(earliestPlanDate).startMs); } catch { /* unresolvable civil date — ignored */ }
    }
    const stored = typeof live.planRepository?.listAllRaw === 'function' ? live.planRepository.listAllRaw() : {};
    for (const id of Object.keys(stored)) {
      const ref = parseOperationalDayId(id);
      if (!ref) continue;
      try { candidates.push(live.describeDay(ref, history).startMs); } catch { /* revision unknown — ignored */ }
    }
    for (const [id, calendarRecord] of Object.entries(calendar ? calendar.listAllRaw() : {})) {
      const dateKey = parseCalendarPlanId(id);
      if (dateKey) { try { candidates.push(calendarTarget(dateKey, calendarRecord).startMs); } catch { /* unresolvable civil date — ignored */ } }
    }
    return candidates.length ? Math.min(...candidates) : null;
  }

  /** For a never-enabled account this is the existing calendar streak, called
   *  with the existing arguments — the same function, not a reimplementation.
   *
   *  Once a boundary is active the streak walks AUTHORITATIVE days backwards
   *  from the current personal day. Days before the boundary took effect are
   *  still legacy-governed and are still judged by the legacy plan, so a streak
   *  carries across the transition instead of resetting. Each day is counted
   *  once, from one store — never both.
   *
   *  The walk is EXACT over available history: it ends when it runs out of
   *  records to read (historyFloorMs), not at a fixed number of days. An
   *  arbitrary cap here would silently shorten a real `best` streak — visible
   *  historical truth must not depend on a safety constant. The only other exit
   *  is a structural one: a step that fails to move strictly backwards (a
   *  malformed revision history) stops the walk instead of spinning, so the loop
   *  is bounded by the data even though it has no day limit.
   *
   *  Both stores are snapshotted once and read through `lookup`, so a long
   *  history costs one read per store rather than one per day. */
  function streak(nowMs = now()) {
    if (calendarActive()) return calendarStreak(nowMs);
    if (!enabled()) return planningStreak(legacy.allPlans(), nowMs, accountTimezone());
    const key = `${cacheKey()}:${nowMs - (nowMs % 60000)}`;
    if (streakCache && streakCache.key === key) return streakCache.value;

    const history = live.revisions();
    const operationalRecords = typeof live.planRepository?.listAllRaw === 'function' ? live.planRepository.listAllRaw() : {};
    const lookup = target => (target.store === 'legacy' ? legacy.record(target.dateKey) : operationalRecords[target.id] || null);

    const today = current(nowMs);
    const todayEarned = habitEarned(today, lookup);
    const finalizedFlags = [];
    const floorMs = historyFloorMs(history);
    let cursor = today;
    while (floorMs !== null && Number.isFinite(cursor.startMs) && cursor.startMs >= floorMs) {
      let previous;
      try { previous = fromDay(live.previousDay(cursor.ref, history)); } catch { break; }
      if (!Number.isFinite(previous.startMs) || previous.startMs >= cursor.startMs) break; // no progress: malformed history
      // `cursor` is exactly the day that decides `previous`'s habit credit.
      finalizedFlags.unshift(earnsItsPredecessorCredit(cursor, lookup));
      cursor = previous;
    }

    let backward = 0;
    while (backward < finalizedFlags.length && finalizedFlags[finalizedFlags.length - 1 - backward]) backward++;
    const value = {
      current: backward + (todayEarned ? 1 : 0),
      best: Math.max(longestTrueRun(finalizedFlags), backward + (todayEarned ? 1 : 0)),
      todayEarned,
      todayStillOpen: !todayEarned,
    };
    streakCache = { key, value };
    return value;
  }

  /** The same rule as the boundary streak — habit day P earns credit when the day AFTER it
   *  was genuinely prepared before that day began — walked over CALENDAR plans from today,
   *  handing over to the legacy chain at the cutover date. Days before the cutover are
   *  still judged by the legacy plan of THEIR OWN successor (so history is never re-judged
   *  by a store that did not exist yet); the one day straddling the cutover is therefore
   *  credited only if its legacy successor was prepared ahead, which is honest rather than
   *  generous. Both stores are snapshotted once and read through `lookup`. */
  function calendarStreak(nowMs) {
    const key = `${cacheKey()}:${nowMs - (nowMs % 60000)}`;
    if (streakCache && streakCache.key === key) return streakCache.value;
    const history = live.revisions();
    const operationalRecords = typeof live.planRepository?.listAllRaw === 'function' ? live.planRepository.listAllRaw() : {};
    const calendarRecords = calendar ? calendar.listAllRaw() : {};
    const lookup = target => (target.store === 'calendar' ? calendarRecords[target.id] || null
      : target.store === 'legacy' ? legacy.record(target.dateKey) : operationalRecords[target.id] || null);
    const bounded = target => (Number.isFinite(target.startMs) ? target : { ...target, ...targetInterval(target) });

    const today = current(nowMs);
    const todayEarned = habitEarned(today, lookup);
    const finalizedFlags = [];
    const floorMs = historyFloorMs(history);
    let cursor = today;
    while (floorMs !== null && Number.isFinite(cursor.startMs) && cursor.startMs >= floorMs) {
      let previousDay;
      try { previousDay = bounded(previous(cursor)); } catch { break; }
      if (!Number.isFinite(previousDay.startMs) || previousDay.startMs >= cursor.startMs) break; // no progress: malformed history
      const decider = cursor.store === 'calendar' && previousDay.store !== 'calendar' ? bounded(legacyNext(previousDay)) : cursor;
      finalizedFlags.unshift(earnsItsPredecessorCredit(decider, lookup));
      cursor = previousDay;
    }

    let backward = 0;
    while (backward < finalizedFlags.length && finalizedFlags[finalizedFlags.length - 1 - backward]) backward++;
    const value = {
      current: backward + (todayEarned ? 1 : 0),
      best: Math.max(longestTrueRun(finalizedFlags), backward + (todayEarned ? 1 : 0)),
      todayEarned,
      todayStillOpen: !todayEarned,
    };
    streakCache = { key, value };
    return value;
  }

  // ── Calendar Day + Extended My Day V1: Plan-by-deadline streak ────────────
  //
  // Independent of streak()/habitEarned() above (the Personal Day boundary
  // model — "was the FOLLOWING day prepared before it began"). This model
  // asks a different question: "by the configured deadline, was the plan the
  // owner is ACTUALLY EDITING prepared (or the day explicitly marked an
  // intentional off-day)?" It does not replace streak() — an account with no
  // deadline configured keeps its historical boundary-based streak display
  // untouched; this is a separate, additive evaluation that becomes the new
  // streak authority only once a deadline exists.
  //
  // FIX FIRST §2/§9 correction (no split-brain): an earlier version of this
  // walk resolved each date's qualification against
  // `planTargetOriginatingOnCalendarDate(dateKey)` — the operational day whose
  // OWN boundaryStartDate equals the calendar date being asked about. Under an
  // ACTIVE non-midnight boundary that is a DIFFERENT target than current()/
  // previous() (the ones every planning surface actually reads and writes):
  // at Sunday 11:00 under an 18:00 boundary, current() is still Saturday's
  // operational day (Sat 18:00 -> Sun 18:00), but that lookup asked for
  // Sunday's OWN day (boundaryStartDate = Sunday, which only starts at Sunday
  // 18:00) — an empty target the user never wrote to. Proven with a live
  // authority + real operational repository in review; see
  // plan-authority-deadline-streak.test.js's "current()/previous() chain"
  // tests. The fix: the streak walks the SAME current()/previous() target
  // chain the planning UI uses, and asks each target's OWN origin date (never
  // an independently-derived one) for its deadline. This makes reads and
  // writes structurally the same target — never a split-brain — but it is NOT
  // full calendar-date primacy for a boundary-ENABLED account: such an
  // account's "day" for planning/streak purposes remains the boundary-defined
  // operational day (exactly as it already was for every other planning
  // surface), just consistently so. True calendar-date primacy under an
  // active non-midnight boundary would require the operational-plan model
  // itself to gain a calendar-midnight-native identity — out of bounded scope
  // here (see the FIX FIRST's own representability finding). A never-enabled
  // account is unaffected: its "operational day" already IS the calendar day.

  /** The provenance timestamp that qualifies as "genuinely prepared" — same
   *  definition earnsItsPredecessorCredit already uses for the boundary
   *  streak (real content or an explicit intentional-blank/Open Day), so the
   *  two streak models never disagree about what counts as a real plan. */
  function qualifyingPreparedAtMs(target) {
    const prepared = preparationFrom(target, record(target)?.preparation);
    if (!prepared) return null;
    const hasContent = prepared.intentionalBlank === true || (prepared.routineInstanceIds?.length > 0) || (prepared.oneOffItemIds?.length > 0);
    return hasContent ? prepared.firstPreparedAt : null;
  }

  /** The target's own origin calendar date. @param {object} target */
  function originDateKeyForTarget(target) {
    // A calendar (or legacy) plan IS its date. Only an operational day has an origin date
    // that differs from where it started.
    return target.store === 'operational' ? target.ref.boundaryStartDate : target.dateKey;
  }

  /** The ONE calendar date a Plan-by deadline / intentional off-day
   *  declaration for `target` is keyed under — used identically by the streak
   *  walk and by the Settings off-day toggle (plan-by-deadline-ui.js calls
   *  this via PlanAuthority), so the two can never disagree about which date
   *  they mean.
   *
   *  Normally this is just the target's own origin date. But a Personal Day
   *  boundary time and a Plan-by deadline time are two fully independent
   *  settings (by design — no second timezone/boundary source) and their
   *  clock times can be in EITHER order: a very plausible combination is an
   *  early deadline (e.g. 08:00, "have tomorrow planned before I get up")
   *  under a late evening boundary (e.g. 18:00). The NAIVE origin-date
   *  deadline instant would then fall BEFORE this operational day even
   *  starts — an obligation the owner could structurally never have met for
   *  THIS target, since it did not exist yet. In that case the deadline that
   *  actually governs this target is the occurrence on the FOLLOWING calendar
   *  date, which does fall inside the target's own [startMs, endMs) — still
   *  one governing instant, just resolved against the target's real interval
   *  rather than blindly against its origin date. A legacy target (always
   *  midnight-aligned) or one with no deadline configured yet never needs the
   *  adjustment. */
  function effectiveDeadlineDateKey(target, revisions) {
    const originDate = originDateKeyForTarget(target);
    // Calendar-native plans have NO compatibility adjustment: the deadline for Sunday belongs to Sunday.
    if (target.store !== 'operational' || !Number.isFinite(target.startMs) || !revisions?.length) return originDate;
    const naive = deadlineInstantForCalendarDate(originDate, revisions);
    if (naive === null || naive >= target.startMs) return originDate;
    return addCalendarDays(originDate, 1);
  }

  /** Qualification for ONE authoritative target (never an independently
   *  looked-up one) — the target IS the plan the owner actually reads/writes,
   *  from current()/previous(). @param {object} target @param {object[]} revisions */
  function deadlineQualificationForTarget(target, revisions) {
    const dateKey = effectiveDeadlineDateKey(target, revisions);
    const deadlineInstantMs = deadlineInstantForCalendarDate(dateKey, revisions);
    if (deadlineInstantMs === null) return { deadlineInstantMs: null, status: 'unenforced' };
    const planPreparedAtMs = qualifyingPreparedAtMs(target);
    const offDayRecord = planByDeadline?.readOffDay ? planByDeadline.readOffDay(dateKey) : null;
    const offDayDeclaredAtMs = offDayDeclaredAtForDeadline(offDayRecord, deadlineInstantMs);
    return { deadlineInstantMs, ...evaluatePlanningDeadlineQualification(deadlineInstantMs, planPreparedAtMs, offDayDeclaredAtMs) };
  }

  /** Public: the calendar date the Settings "mark today an intentional
   *  off-day" toggle must key its declaration under for the CURRENT target —
   *  see effectiveDeadlineDateKey. Reads the deadline history itself so
   *  callers (the Settings UI) never re-derive or duplicate this logic. */
  function deadlineDateKeyForTarget(target) {
    const revisions = planByDeadline?.readDeadlines ? planByDeadline.readDeadlines() : [];
    return effectiveDeadlineDateKey(target, revisions);
  }

  /** Deterministic from persisted facts alone (§12) — never depends on this
   *  function having been called at the exact deadline instant. Walks the
   *  AUTHORITATIVE target chain backwards from current() (never an
   *  independently-derived per-calendar-date target — see the correction
   *  above), stopping the instant a target's own origin date predates the
   *  very first configured deadline revision (§8: no retroactive enforcement
   *  invented for history that came before the feature existed). Bounded by
   *  DAY_AHEAD_GUARD for the same malformed-data-safety reason streak()'s walk
   *  is bounded by historyFloorMs.
   *
   *  FIX FIRST §14/§15: an ACTIVE equal-authority conflict is checked and
   *  reported FIRST, before any streak math — a conflict never falls through
   *  to compute a false 'missed' from a filtered-down revision set; it is its
   *  own explicit status, resolved only by the owner saving a new revision
   *  (repository.proposeDeadline draws from the conflict-free set already).
   *  @param {number} nowMs
   *  @returns {{status:'unenforced'}|{status:'conflict',conflicts:object[][]}|{status:'configured', today:{status:string,deadlineInstantMs:number|null}, current:number, best:number}} */
  function planningDeadlineStreak(nowMs = now()) {
    if (!planByDeadline?.readDeadlines) return { status: 'unenforced' };
    const conflicts = typeof planByDeadline.deadlineConflict === 'function' ? planByDeadline.deadlineConflict() : [];
    if (conflicts.length) return { status: 'conflict', conflicts };
    const revisions = planByDeadline.readDeadlines();
    if (!revisions.length) return { status: 'unenforced' };

    const todayTarget = current(nowMs);
    const todayQualification = deadlineQualificationForTarget(todayTarget, revisions);
    const todayStatus = todayQualification.status === 'unenforced' ? 'unenforced'
      : todayQualification.status === 'maintained' ? 'maintained' // already satisfied — never demoted back to "pending" just because the deadline hasn't technically arrived yet
      : (todayQualification.deadlineInstantMs !== null && nowMs < todayQualification.deadlineInstantMs) ? 'pending'
      : 'missed';

    const flags = [];
    let cursor = todayTarget;
    for (let guard = 0; guard < DAY_AHEAD_GUARD; guard++) {
      let prev;
      try { prev = previous(cursor); } catch { break; }
      if (!Number.isFinite(prev.startMs) && prev.store !== 'legacy') break; // malformed history — stop, don't spin
      const qualification = deadlineQualificationForTarget(prev, revisions);
      if (qualification.status === 'unenforced') break; // predates the first configured deadline — stop, don't invent history
      flags.unshift(qualification.status === 'maintained');
      cursor = prev;
    }

    let backward = 0;
    while (backward < flags.length && flags[flags.length - 1 - backward]) backward++;
    const todayCounts = todayStatus === 'maintained' ? 1 : 0;
    return {
      status: 'configured',
      today: { status: todayStatus, deadlineInstantMs: todayQualification.deadlineInstantMs },
      current: backward + todayCounts,
      best: Math.max(longestTrueRun(flags), backward + todayCounts),
    };
  }

  // ── Prepared Plans (recovery/discoverability, never a second editor) ──────

  /** Operational plan records that hold real preparation but are not reachable
   *  through the one planning workflow right now — typically a future day a
   *  later boundary change moved out of current/upcoming. A projection over the
   *  records that already exist: no new store, no copying, no relocation. */
  function preparedPlans(nowMs = now()) {
    if (!enabled()) return [];
    const reachable = new Set([current(nowMs).id, upcoming(nowMs).id]);
    const history = live.revisions();
    const all = live.planRepository.listAllRaw();
    const out = [];
    Object.entries(all).forEach(([id, plan]) => {
      if (reachable.has(id)) return;
      const activeItems = (Array.isArray(plan?.items) ? plan.items : []).filter(item => planItemIsActiveInDay(item, id, relocationIndex()));
      const prepared = normalizeOperationalPreparation(plan?.preparation, id);
      if (!activeItems.length && !prepared) return;
      const ref = parseOperationalDayId(id);
      let interval = null;
      try { interval = ref ? live.describeDay(ref, history) : null; } catch { interval = null; }
      out.push({
        id,
        items: activeItems,
        preparation: prepared,
        resolvable: !!interval,
        startMs: interval?.startMs ?? null,
        endMs: interval?.endMs ?? null,
        timezone: ref?.timezone ?? null,
        boundaryTime: interval?.boundaryTime ?? null,
        past: interval ? interval.endMs <= nowMs : null,
      });
    });
    return out.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  }

  // ── Unfinished from previous days (recovery, both stores) ─────────────────

  /** Every day this device can still speak for, as {target, record} pairs — the
   *  input the recovery projection needs. BOTH stores, because days that began
   *  before the boundary revision took effect are legacy-governed and hold their
   *  items in plans[dateKey]; an operational-only scan would leave every
   *  pre-boundary stale task permanently unreachable.
   *
   *  Walks stored RECORDS, not a date range, so there is no lookback limit on what
   *  is discoverable. Same full-store walk preparedPlans()/historyFloorMs() already
   *  perform, so this is no new cost class. */
  function recoverableDays() {
    const out = [];
    const legacyPlans = legacy.allPlans() || {};
    for (const dateKey of Object.keys(legacyPlans)) {
      if (!validPlanDate(dateKey)) continue;
      let target;
      try {
        const bounds = calendarDayBounds(dateKey);
        target = { ...legacyTarget(dateKey), startMs: bounds.startMs, endMs: bounds.endMs };
      } catch {
        // An unresolvable civil date is still REPORTED by the projection rather
        // than silently dropped.
        target = legacyTarget(dateKey);
      }
      out.push({ target, record: legacyPlans[dateKey] });
    }
    if (boundaryEnabled()) {
      const history = live.revisions();
      const stored = typeof live.planRepository?.listAllRaw === 'function' ? live.planRepository.listAllRaw() : {};
      for (const id of Object.keys(stored)) {
        const ref = parseOperationalDayId(id);
        if (!ref) continue;
        let target;
        try {
          target = fromDay(live.describeDay(ref, history));
        } catch {
          // Unknown revision: kept, with no interval, so it is reported as
          // unresolvable instead of disappearing.
          target = { store: 'operational', id, operationalDayId: id, ref, startMs: null, endMs: null, timezone: ref.timezone, boundaryTime: null, legacy: false };
        }
        out.push({ target, record: stored[id] });
      }
    }
    const activation = calendarActivation();
    if (activation) {
      // Every LEGACY day is superseded by the cutover: it stopped being live at that instant,
      // so its unfinished work is recoverable (the ordinary Unfinished flow) exactly like a
      // day that ended. Nothing is copied or rewritten by saying so.
      out.forEach(entry => { entry.target = { ...entry.target, supersededAtMs: activation.activatedAtMs }; });
    }
    for (const [id, calendarRecord] of Object.entries(calendar ? calendar.listAllRaw() : {})) {
      const dateKey = parseCalendarPlanId(id);
      if (!dateKey) continue;
      try { out.push({ target: calendarTarget(dateKey, calendarRecord), record: calendarRecord }); } catch { /* unresolvable civil date — the record itself is untouched */ }
    }
    return out;
  }

  /** The end of one item's own scheduled span inside a calendar plan (its end instant, or
   *  its start when it has no length), or null when it has no structured time. */
  function calendarItemEndMs(target, item) {
    const instants = calendarItemInstants(target.dateKey, item?.whenTz ? item : { ...item, whenTz: accountTimezone() });
    return instants.ok && instants.timed ? (instants.endMs ?? instants.startMs) : null;
  }

  /** When an item stopped being "now": a calendar plan's item is stale once its plan's own
   *  date is over AND the item's own scheduled span is over (a Sunday-plan item at Monday
   *  09:00 is not "unfinished from a previous day" at Monday 02:00). */
  function staleSourceEndMs(target, item) {
    const dayEnd = effectiveEndMs(target);
    if (target.store !== 'calendar') return dayEnd;
    const own = calendarItemEndMs(target, item);
    return own === null ? dayEnd : Math.max(dayEnd, own);
  }

  /** id -> record across BOTH stores, for already-moved detection. Keyed exactly as
   *  targets are (a dateKey for legacy, an operationalDayId for operational), which
   *  is what carriedFromDayId records. */
  function allDayRecords() {
    const map = {};
    recoverableDays().forEach(({ target, record }) => { map[target.id] = record; });
    return map;
  }

  /** Unfinished from previous days: unfinished, undeleted, undismissed, not already
   *  moved, on a day that has ENDED. No lookback cap on discovery. */
  function staleUnfinished(nowMs = now()) {
    const days = recoverableDays();
    const canonical = relocationIndex();
    const visibleDays = days.map(entry => ({
      ...entry,
      record: {
        ...(entry.record || {}),
        items: (Array.isArray(entry.record?.items) ? entry.record.items : []).filter(item => item.deleted || planItemIsActiveInDay(item, entry.target.id, canonical)),
      },
    }));
    return collectStaleUnfinished({
      nowMs,
      days: visibleDays,
      dayRecords: Object.fromEntries(visibleDays.map(entry => [entry.target.id, entry.record])),
      itemEndMs: (target, item) => (target.store === 'calendar' ? calendarItemEndMs(target, item) : null),
    });
  }

  /** Where a stale item was moved to, or null — so a surface can render
   *  "Moved to ..." instead of offering a second move. */
  function staleMoveDestination(sourceItemId, sourceDayId) {
    return findMoveDestination(sourceItemId, sourceDayId, allDayRecords());
  }

  /** Divergent equal-authority recovery edits. Pure projection over raw account-owned
   *  day records: no second store, no arrival-order state and no hidden candidate. */
  function recoveryConflicts() {
    return collectRecoveryConflicts(allDayRecords());
  }

  /** Explicitly chooses one candidate without deleting the other candidate's audit
   *  provenance. A higher relocation sequence makes exactly one item authoritative;
   *  replaying the same resolution is idempotent. */
  function resolveRecoveryConflict({ sourceItemId, sourceDayId, candidateDayId, stamp }) {
    if (typeof stamp !== 'function') throw new Error('An item stamping function is required.');
    const conflict = recoveryConflicts().find(entry => (
      entry.sourceItemId === sourceItemId && entry.sourceDayId === sourceDayId
    ));
    if (!conflict) {
      const existing = staleMoveDestination(sourceItemId, sourceDayId);
      if (existing?.dayId === candidateDayId) return { resolved: false, alreadyAt: existing };
      throw new Error('That recovery conflict is no longer active.');
    }
    const chosen = conflict.candidates.find(candidate => candidate.dayId === candidateDayId);
    if (!chosen) throw new Error('That recovery candidate is no longer available.');
    const target = targetById(chosen.dayId);
    if (!target) throw new Error('That candidate day cannot be resolved right now.');
    const stamped = stamp({ ...chosen.item, deleted: false });
    delete stamped.movedToDayId;
    const resolved = {
      ...stamped,
      relocationRevision: nextPlanItemRelocation(chosen.item, {
        fromDayId: sourceDayId,
        toDayId: chosen.dayId,
        updatedAt: stamped.updatedAt,
        updatedBy: stamped.updatedBy,
      }),
    };
    const check = validateItem(target, resolved);
    if (!check.ok) throw new Error('That recovery candidate is not valid on its destination day.');
    const stored = rawItems(target);
    saveItems(target, stored.map(item => item.id === chosen.itemId ? resolved : item), { allowLegacyRecovery: true });
    return { resolved: true, destination: target, item: resolved };
  }

  /** Resolves a stored day id (either store) back to a target. */
  function targetById(dayId) {
    const calendarDate = parseCalendarPlanId(dayId);
    if (calendarDate) return calendar ? calendarTarget(calendarDate) : null;
    const activation = calendarActivation();
    const superseded = target => (activation ? { ...target, supersededAtMs: activation.activatedAtMs } : target);
    if (validPlanDate(dayId)) {
      try {
        const bounds = calendarDayBounds(dayId);
        return superseded({ ...legacyTarget(dayId), startMs: bounds.startMs, endMs: bounds.endMs });
      } catch { return superseded(legacyTarget(dayId)); }
    }
    const ref = parseOperationalDayId(dayId);
    if (!ref || !boundaryEnabled()) return null;
    try { return superseded(fromDay(live.describeDay(ref, live.revisions()))); } catch { return null; }
  }

  /** Moves an unfinished task from an ENDED day onto `destination`.
   *
   *  The original is left exactly as it is: still planned, still not done, on its own
   *  day. That is not an oversight — it is the historical truth, and it is the
   *  provenance the destination copy points back at via carriedFromId /
   *  carriedFromDayId. Nothing about the historical day is rewritten.
   *
   *  Exactly one destination copy can exist, because its id is the DETERMINISTIC
   *  carry id: two devices moving the same task to the same day mint the same id and
   *  the existing per-item merge collapses them into one. Re-moving to the same day
   *  is therefore idempotent, and moving at all is refused once a destination exists. */
  function moveStaleItem({ sourceTarget, itemId, destination, stamp, nowMs = now() }) {
    if (typeof stamp !== 'function') throw new Error('An item stamping function is required.');
    if (!sourceTarget || !destination) throw new Error('A source day and a destination day are required.');
    const sourceItem = rawItems(sourceTarget).find(candidate => candidate.id === itemId);
    if (!sourceItem) throw new Error('That task is no longer on its original day.');
    if (sourceItem.deleted) throw new Error('That task was removed.');
    if (sourceItem.done) throw new Error('That task is already done.');
    if (Number.isFinite(sourceTarget.endMs) && staleSourceEndMs(sourceTarget, sourceItem) > nowMs) {
      // Moving out of a day that is still running would leave TWO simultaneously
      // active copies. That case is the existing carry-forward flow, not this one.
      throw new Error('That day has not ended yet.');
    }
    assertDirectSchedulingTarget(destination, nowMs);
    const existing = staleMoveDestination(itemId, sourceTarget.id);
    if (existing) {
      if (existing.dayId === destination.id) return { moved: false, alreadyAt: existing };
      throw new Error('That task has already been moved. Change where it is scheduled instead.');
    }
    const carryId = carryItemIdFor(sourceTarget, itemId, destination);
    const destinationItems = rawItems(destination);
    let moved = buildMovedItem({ carryId, sourceItem, sourceDayId: sourceTarget.id, stamp });
    // This relocation revision is the recovery claim. The source-owned id and
    // provenance identify WHAT was recovered; the claim names the chosen day.
    // Concurrent claims resolve by the existing stable relocation ordering.
    moved = {
      ...moved,
      relocationRevision: nextPlanItemRelocation(moved, {
        fromDayId: sourceTarget.id,
        toDayId: destination.id,
        updatedAt: moved.updatedAt,
        updatedBy: moved.updatedBy,
      }),
    };
    // The Top 3 holds on the destination too. A stale PRIORITY moved into a day whose
    // Top 3 is already full lands as an Other planned task instead: recovery is never
    // blocked by the cap, and the cap is never exceeded by recovery. A stale task stays
    // a task. The item being replaced (a tombstoned earlier copy with this same carry
    // id) does not count toward the cap.
    const destinationPriorities = activePriorityPlanItems(destinationItems.filter(candidate => candidate.id !== carryId));
    const demoted = planItemKind(moved) === 'priority' && destinationPriorities.length >= priorityMax;
    if (demoted) moved = withPlanItemKind(moved, 'task');
    const check = validateItem(destination, moved);
    if (!check.ok) throw new Error('That task cannot be scheduled on that day.');
    const already = destinationItems.find(candidate => candidate.id === carryId);
    saveItems(destination, already
      ? destinationItems.map(candidate => (candidate.id === carryId ? moved : candidate))
      : [...destinationItems, moved]);
    return { moved: true, destination, item: moved, carryId, demoted };
  }

  /** Reclassifies ONE item between Top Priority and Other planned task — "Make task" /
   *  "Make priority". Goes through the ordinary saveItems() path with the caller's own
   *  stamp, so it syncs, merges and invalidates exactly like any other edit.
   *
   *  Only `kind` changes. The id, task text, when/end/duration, done state and every
   *  linkage field (carriedFromId, planItemId links from tracked entries, which point at
   *  this same id) are preserved, because withPlanItemKind copies the item verbatim.
   *
   *  Promotion is refused — never silently swapped or reordered — when the Top 3 is
   *  already full. A tombstoned item cannot be reclassified. Preparation is not
   *  rewritten: it is a confirmation made at a moment in time; readyNow() reads each
   *  prepared item's CURRENT kind, so a demoted priority simply stops counting. */
  function setItemKind({ target, itemId, kind, stamp }) {
    if (typeof stamp !== 'function') throw new Error('An item stamping function is required.');
    if (kind !== 'priority' && kind !== 'task') throw new Error(`Unknown plan item kind: ${kind}`);
    assertDirectSchedulingTarget(target);
    const storedItems = rawItems(target);
    const stored = storedItems.find(candidate => candidate.id === itemId);
    if (!stored) throw new Error('That item is no longer in this plan.');
    if (stored.deleted) throw new Error('That item was removed.');
    const current = items(target).find(candidate => candidate.id === itemId);
    if (!current) throw new Error('That item is no longer active in this plan.');
    if (planItemKind(current) === kind) return { changed: false, item: current };
    if (kind === 'priority') {
      const others = activePriorityPlanItems(items(target).filter(candidate => candidate.id !== itemId));
      if (others.length >= priorityMax) {
        throw new Error(`Your Top ${priorityMax} is already full. Finish, remove or demote one first.`);
      }
    }
    const next = stamp(withPlanItemKind(current, kind));
    saveItems(target, storedItems.map(candidate => (candidate.id === itemId ? next : candidate)));
    return { changed: true, item: next };
  }

  /** Ordinary direct Add: current/future only. Historical recovery has its own
   *  provenance-preserving API and therefore does not route through this method. */
  function addItem({ destination, item, nowMs = now() }) {
    assertDirectSchedulingTarget(destination, nowMs);
    const currentItems = rawItems(destination);
    if (planItemKind(item) === 'priority' && activePriorityPlanItems(items(destination)).length >= priorityMax) {
      throw new Error(`Your Top ${priorityMax} is already full. Add it as another task instead.`);
    }
    const validation = validateItem(destination, item);
    if (!validation.ok) throw new Error(validation.reason === 'outside-operational-day' ? 'That time is outside this personal day.' : 'That time is not valid for this day.');
    saveItems(destination, [...currentItems, item]);
    return { item, destination };
  }

  /** Edits one canonical plan item and optionally moves it to another
   *  authoritative day. The id is preserved. A cross-day move writes the live
   *  item at the destination and a tombstone at the source so sync cannot
   *  resurrect a second active copy. */
  function updateItem({ sourceTarget, itemId, destination = sourceTarget, changes = {}, stamp, nowMs = now() }) {
    if (!sourceTarget || !destination) throw new Error('A source and destination day are required.');
    if (typeof stamp !== 'function') throw new Error('An item stamping function is required.');
    assertDirectSchedulingTarget(sourceTarget, nowMs);
    assertDirectSchedulingTarget(destination, nowMs);
    const sourceItems = rawItems(sourceTarget);
    const current = items(sourceTarget).find(item => item.id === itemId);
    if (!current) throw new Error('That planned task no longer exists.');

    const title = Object.prototype.hasOwnProperty.call(changes, 'task') ? String(changes.task || '').trim() : current.task;
    if (!title) throw new Error('Name the task first.');
    const kind = Object.prototype.hasOwnProperty.call(changes, 'kind') ? changes.kind : planItemKind(current);
    if (kind !== 'priority' && kind !== 'task') throw new Error(`Unknown plan item kind: ${kind}`);
    let draft = { ...current, ...changes, id: current.id, task: title, deleted: false };
    if (Object.prototype.hasOwnProperty.call(changes, 'when') && !changes.when) draft = clearPlanItemRange(draft);
    // A NEW clock reading is made against the day the owner chose, so it starts on that day: a stale
    // next-day offset from the previous reading must not silently ride along. (An unchanged reading —
    // a rename, a done toggle — keeps its offset, which is what keeps Monday 01:00 Monday.)
    if (Object.prototype.hasOwnProperty.call(changes, 'when') && changes.when !== current.when && !Object.prototype.hasOwnProperty.call(changes, 'whenDayOffset')) delete draft.whenDayOffset;
    let nextItem = withPlanItemKind(draft, kind);

    const destinationItems = sourceTarget.id === destination.id ? sourceItems : rawItems(destination);
    if (kind === 'priority') {
      const otherPriorities = items(destination).filter(item => item.id !== itemId && planItemKind(item) === 'priority');
      if (otherPriorities.length >= priorityMax) throw new Error(`Your Top ${priorityMax} is already full. Finish, remove or demote one first.`);
    }
    const validation = validateItem(destination, nextItem);
    if (!validation.ok) throw new Error(validation.reason === 'outside-operational-day' ? 'That time is outside this personal day.' : 'That time is not valid for this day.');
    nextItem = stamp(nextItem);

    if (sourceTarget.id === destination.id) {
      saveItems(sourceTarget, sourceItems.map(item => item.id === itemId ? nextItem : item));
      return { moved: false, item: nextItem, destination };
    }

    const relocationRevision = nextPlanItemRelocation(current, {
      fromDayId: sourceTarget.id,
      toDayId: destination.id,
      updatedAt: nextItem.updatedAt,
      updatedBy: nextItem.updatedBy,
    });
    nextItem = { ...nextItem, relocationRevision };
    delete nextItem.movedToDayId;
    const destinationNext = destinationItems.some(item => item.id === itemId)
      ? destinationItems.map(item => item.id === itemId ? nextItem : item)
      : [...destinationItems, nextItem];
    saveItems(destination, destinationNext);
    const tombstone = {
      ...current,
      deleted: true,
      movedToDayId: destination.id,
      relocationRevision,
      updatedAt: nextItem.updatedAt,
      updatedBy: nextItem.updatedBy,
    };
    saveItems(sourceTarget, sourceItems.map(item => item.id === itemId ? tombstone : item));
    return { moved: true, item: nextItem, destination };
  }

  /** Toggles ONE item's done state on `target`, bypassing updateItem's general
   *  assertDirectSchedulingTarget "past My Day" refusal — the Calendar Day +
   *  Extended My Day V1 carryover-completion exception (§10/§11). The SOURCE
   *  day may have fully ended (that is exactly what makes it "carryover"), but
   *  one item whose own REAL resolved instant still lands on today's calendar
   *  date remains a live obligation. This function re-verifies that fact
   *  itself, from the item's own `when` — never trusting the caller — so it
   *  can never be used to edit an arbitrary historical day: any other item
   *  refuses (returns null, no write) exactly like updateItem would. Writes
   *  through saveItems (no editability guard) to the SAME target/itemId —
   *  never a clone, never a different target.
   *  @param {object} target @param {string} itemId @param {(item:object)=>object} stamp
   *  @param {number} [nowMs] @returns {{item:object}|null} */
  function completeCarryoverItem({ target, itemId, stamp, nowMs = now() }) {
    if (!target || typeof stamp !== 'function') return null;
    const current = items(target).find(candidate => candidate.id === itemId);
    if (!current) return null;
    const startInstant = itemStartInstant(target, current.when, current);
    const todayKey = localPlanDate(nowMs, accountTimezone());
    if (startInstant === null || localPlanDate(startInstant, accountTimezone()) !== todayKey) return null; // not live today — refused
    const done = !current.done;
    const nextItem = stamp({ ...current, done, doneAt: done ? nowMs : null });
    saveItems(target, rawItems(target).map(raw => raw.id === itemId ? nextItem : raw));
    return { item: nextItem };
  }

  /** The previous calendar date's plan items that are scheduled to land on `dateKey`
   *  (Sunday's plan reaching Monday 01:00 / 04:00). A read-only projection over the ONE
   *  record they live in: nothing is copied, cloned or re-owned — completing one writes
   *  Sunday's plan (completeCarryoverItem). `null` when either date is not
   *  calendar-authoritative (the legacy carryover mechanics then apply). */
  function calendarCarryoverFor(dateKey) {
    if (!validPlanDate(dateKey) || !isCalendarAuthoritative(dateKey)) return null;
    const sourceDate = addCalendarDays(dateKey, -1);
    if (!isCalendarAuthoritative(sourceDate)) return null;
    const target = calendarTarget(sourceDate);
    const landing = items(target).filter(item => {
      const instants = calendarItemInstants(sourceDate, item?.whenTz ? item : { ...item, whenTz: accountTimezone() });
      return instants.ok && instants.timed && localPlanDate(instants.startMs, item.whenTz || accountTimezone()) === dateKey;
    });
    return { target, items: landing };
  }

  /** Legacy plans (Personal Day / operational days, and plans[dateKey]) that hold real
   *  content and were still live when the account cut over — kept exactly as they were,
   *  read-only, and discoverable so nothing prepared before the cutover silently vanishes.
   *  Their unfinished tasks move into a calendar plan through the ordinary Unfinished flow
   *  (deterministic ids, provenance, never twice). A projection over records that already
   *  exist: no new store, no copying. */
  function supersededPlans(nowMs = now()) {
    const activation = calendarActivation();
    if (!activation) return [];
    const canonical = relocationIndex();
    const dayRecords = allDayRecords();
    const out = [];
    for (const { target, record: stored } of recoverableDays()) {
      if (target.store === 'calendar') continue;
      const endMs = Number.isFinite(target.endMs) ? target.endMs : null;
      if (endMs !== null && endMs <= activation.activatedAtMs) continue; // finalized before the cutover: ordinary history
      // `movedTo` names where an item already went (the ordinary recovery flow's own answer), so an
      // older plan never reads as if a task that now lives in a calendar plan were still open here.
      const activeItems = (Array.isArray(stored?.items) ? stored.items : [])
        .filter(item => item && !item.deleted && planItemIsActiveInDay(item, target.id, canonical))
        .map(item => ({ ...item, movedTo: findMoveDestination(item.id, target.id, dayRecords)?.dayId || null }));
      const prepared = preparationFrom(target, stored?.preparation);
      if (!activeItems.length && !prepared) continue;
      out.push({
        id: target.id,
        store: target.store,
        dateKey: target.store === 'legacy' ? target.dateKey : null,
        items: activeItems,
        preparation: prepared,
        resolvable: endMs !== null,
        startMs: Number.isFinite(target.startMs) ? target.startMs : null,
        endMs,
        timezone: target.timezone ?? null,
        boundaryTime: target.boundaryTime ?? null,
        past: endMs !== null ? endMs <= nowMs : null,
      });
    }
    return out.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0) || String(a.id).localeCompare(String(b.id)));
  }

  /** The ONE explicit cutover action (owner-triggered, account-owned, one-way). */
  function activateCalendar(nowMs = now()) {
    if (!calendar) throw new Error('Calendar-day plans are not available yet.');
    const result = calendar.activate(nowMs);
    invalidate();
    return result;
  }

  /** The factual instants of one item ({startMs, endMs|null}) inside its target, or null when
   *  it has no structured time. Calendar items are a pure function of their own reading. */
  function itemInstants(target, item) {
    if (target.store === 'calendar') {
      const instants = calendarItemInstants(target.dateKey, item?.whenTz ? item : { ...item, whenTz: accountTimezone() });
      return instants.ok && instants.timed ? { startMs: instants.startMs, endMs: instants.endMs } : null;
    }
    const startMs = itemStartInstant(target, item?.when);
    return Number.isFinite(startMs) ? { startMs, endMs: Number.isFinite(item?.durationMinutes) ? startMs + item.durationMinutes * 60000 : null } : null;
  }

  /** Re-targets an already-moved task: tombstones the copy on the old destination,
   *  then writes one on the new. Never leaves two active copies. A hard removal is
   *  not used because it would be resurrected by the per-item merge. */
  function rescheduleStaleItem({ sourceTarget, itemId, destination, stamp, nowMs = now() }) {
    assertDirectSchedulingTarget(destination, nowMs);
    const existing = staleMoveDestination(itemId, sourceTarget.id);
    if (!existing) return moveStaleItem({ sourceTarget, itemId, destination, stamp, nowMs });
    if (existing.dayId === destination.id) return { moved: false, alreadyAt: existing };
    const oldTarget = targetById(existing.dayId);
    if (!oldTarget) throw new Error('The day this task was moved to cannot be resolved right now.');
    saveItems(oldTarget, rawItems(oldTarget).map(candidate => (
      candidate.id === existing.itemId ? stamp({ ...candidate, deleted: true }) : candidate
    )), { allowLegacyRecovery: true });
    return moveStaleItem({ sourceTarget, itemId, destination, stamp, nowMs });
  }

  /** Not doing this. Records abandonment on the ORIGINAL item without claiming
   *  completion — which is why this surface has no Mark-done action: stamping
   *  doneAt=now on a three-day-old item would make that historical day read as done
   *  when it was not. */
  function dismissStaleItem({ sourceTarget, itemId, stamp, nowMs = now() }) {
    const items = rawItems(sourceTarget);
    const sourceItem = items.find(candidate => candidate.id === itemId);
    if (!sourceItem) throw new Error('That task is no longer on its original day.');
    saveItems(sourceTarget, items.map(candidate => (
      candidate.id === itemId ? buildDismissedItem(sourceItem, { nowMs, stamp }) : candidate
    )), { allowLegacyRecovery: true });
    return { dismissed: true };
  }

  function undismissStaleItem({ sourceTarget, itemId, stamp }) {
    const items = rawItems(sourceTarget);
    const sourceItem = items.find(candidate => candidate.id === itemId);
    if (!sourceItem) throw new Error('That task is no longer on its original day.');
    saveItems(sourceTarget, items.map(candidate => (
      candidate.id === itemId ? buildUndismissedItem(sourceItem, { stamp }) : candidate
    )), { allowLegacyRecovery: true });
    return { dismissed: false };
  }

  /** What a boundary proposal would do to an ALREADY PREPARED day that is
   *  reachable right now. Pure dry run: proposes against a copy of the history
   *  through the model's own proposeBoundaryRevision and compares the reachable
   *  set before and after. Nothing is persisted, moved, merged or deleted. */
  function boundaryChangeImpact(candidate, nowMs = now()) {
    if (!enabled()) return { ok: true, orphaned: [] };
    let history;
    let simulated;
    try {
      history = live.revisions();
      simulated = proposeBoundaryRevision(history, { id: 'preview-impact', boundaryTime: candidate.boundaryTime, timezone: candidate.timezone }, nowMs).revisions;
    } catch (err) {
      return { ok: false, reason: err.message, orphaned: [] };
    }
    const describe = (ref, revisions) => fromDay(live.describeDay(ref, revisions));

    // Planning Continuity V1 (G3). This used to compare only [current, upcoming].
    // That was complete while those two were the whole reachable horizon — but once
    // a day three weeks out can be prepared, a boundary change could silently strand
    // it with no warning at all. The "before" set is now every operational day this
    // device holds a record for whose interval has not yet ended, unioned with
    // current/upcoming, so anything the change would strand is named BY NAME first.
    //
    // Bounded by stored records, not by a date range. Still a pure dry run: nothing
    // is persisted, moved, merged or deleted.
    const beforeById = new Map();
    [current(nowMs), upcoming(nowMs)].forEach(target => beforeById.set(target.id, target));
    const stored = typeof live.planRepository?.listAllRaw === 'function' ? live.planRepository.listAllRaw() : {};
    for (const id of Object.keys(stored)) {
      if (beforeById.has(id)) continue;
      const ref = parseOperationalDayId(id);
      if (!ref) continue;
      let target;
      try { target = fromDay(live.describeDay(ref, history)); } catch { continue; }
      if (target.endMs <= nowMs) continue; // already finalized history — not strandable
      beforeById.set(id, target);
    }

    // The set still reachable through the ONE planning workflow after the change.
    const afterCurrentRef = operationalDayContaining(nowMs, simulated);
    const after = new Set([
      describe(afterCurrentRef, simulated).id,
      describe(nextOperationalDay(afterCurrentRef, simulated), simulated).id,
    ]);
    const orphaned = [...beforeById.values()]
      .filter(target => target.store === 'operational' && !after.has(target.id) && target.endMs > nowMs)
      .filter(target => {
        const plan = record(target);
        const activeItems = (Array.isArray(plan?.items) ? plan.items : []).filter(item => item && !item.deleted);
        return activeItems.length > 0 || !!preparation(target);
      })
      .sort((a, b) => a.startMs - b.startMs);
    return { ok: true, orphaned };
  }

  return {
    enabled, invalidate,
    authorityState, calendarActive, calendarActivation, boundaryEnabled, isCalendarAuthoritative, activateCalendar,
    calendarCarryoverFor, supersededPlans, itemInstants, calendarTarget,
    current, upcoming, containing, next, previous, daysOverlappingCalendarDate,
    dayAhead, dayForCalendarDate, dayForScheduledDate, scheduledDateForTarget, civilDateForTimeInTarget, upcomingDays,
    record, rawItems, items, saveItems, addItem, assertDirectSchedulingTarget,
    preparation, consistency, readyNow, preparedState, confirmPreparation,
    validateItem, itemStartInstant, evidenceWindow, reviewEvidenceWindow, classifyItemActual,
    routineTarget, routinesForTarget, templatesForTarget,
    habitEarned, streak,
    planningDeadlineStreak, deadlineDateKeyForTarget,
    preparedPlans, boundaryChangeImpact,
    setItemKind, updateItem, completeCarryoverItem,
    staleUnfinished, staleMoveDestination, recoveryConflicts, resolveRecoveryConflict, moveStaleItem, rescheduleStaleItem,
    dismissStaleItem, undismissStaleItem, targetById, recoverableDays,
    legacyTarget,
    priorityMax: () => priorityMax,
  };
}

// ── live singleton (browser only) ───────────────────────────────────────────
//
// Same guard and same accessor style as personal-day-boundary-live.js: building
// the default repositories touches localStorage, which does not exist under
// plain `node --test`, and tests always build their own authority with
// createPlanAuthority(fakeDeps).
//
// Every legacy function below is index.html's own existing plans[dateKey] path,
// handed over rather than reimplemented — that is what keeps a never-enabled
// account on exactly the code that already ships.

function authorityAppContext() {
  if (typeof globalThis.getOperationalPlanAppContext !== 'function') throw new Error('Plan authority app context is not available yet.');
  return globalThis.getOperationalPlanAppContext();
}

if (typeof window !== 'undefined') {
  window.PlanAuthority = createPlanAuthority({
    live: window.PersonalDayBoundaryLive,
    legacy: {
      record: dateKey => authorityAppContext().plan(dateKey),
      rawItems: dateKey => authorityAppContext().rawItems(dateKey),
      saveItems: (dateKey, items, options) => authorityAppContext().saveItems(dateKey, items, options),
      confirm: input => authorityAppContext().confirm(input),
      allPlans: () => authorityAppContext().allPlans(),
      earliestPlanDate: () => authorityAppContext().earliestPlanDate(),
    },
    priorityMax: (() => { try { return authorityAppContext().maxItems; } catch { return 3; } })(),
    accountTimezone: () => authorityAppContext().timezone,
    planByDeadline: window.PlanByDeadlineSync?.repository,
    calendar: window.CalendarPlanLive,
    calendarDayBounds: dateKey => authorityAppContext().calendarDayBounds(dateKey),
    legacyClockInstant: (dateKey, hhmm) => authorityAppContext().clockInstant(dateKey, hhmm),
    onWrite: () => globalThis.refreshAuthoritativePlanSurfaces?.(),
  });

  // The plan strip, Up Next and the commitments pane all render once,
  // synchronously, before this deferred module finishes loading. An account with
  // a boundary configured deliberately renders a neutral placeholder until now
  // (index.html's currentPlanTarget returns null) rather than guessing at the
  // calendar plan — so re-rendering here is what turns that into a brief gap
  // instead of a stuck one.
  globalThis.renderTodayPlan?.();
  globalThis.refreshTomorrowView?.();
  // The static "Tomorrow" / "Next personal day" labels were painted before this module existed; for an
  // account that has already switched to calendar-day plans they must read "Tomorrow" from the start.
  globalThis.refreshPlanningTerminologyLabels?.();
  // The My Day timeline also reads the authoritative interval, and its first render
  // happened before this module existed (it fell back to the calendar day). Only an
  // account with an ACTIVE boundary needs that rebuild: without one, the calendar
  // timeline the first render already produced is correct, so a second full renderToday()
  // would be pure startup cost on the most common path.
  try { if (window.PlanAuthority.enabled()) globalThis.renderToday?.(); } catch { /* boundary state unreadable — the next ordinary render covers it */ }
}
