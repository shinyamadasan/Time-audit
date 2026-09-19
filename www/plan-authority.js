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
  findMoveDestination,
} from './stale-plan-recovery-model.js';
import {
  validateOperationalPlanItemRange,
  buildOperationalPreparation,
  normalizeOperationalPreparation,
} from './operational-plan-model.js';
import {
  addCalendarDays,
  computeReadyNow,
  localPlanDate,
  normalizePreparation,
  planningConsistency,
  planningStreak,
  validPlanDate,
  validPlanItemRange,
  validPlanItemDuration,
  carriedItemId,
  classifyOneOffActual,
  activePriorityPlanItems,
  planItemKind,
  withPlanItemKind,
} from './plan-tomorrow-model.js';
// Side-effect import: personal-day-boundary-live.js owns the
// `window.PersonalDayBoundaryLive` singleton this module's own singleton composes,
// so importing it here makes that construction order a module-graph guarantee
// rather than a dependency on <script> tag order. Inert under `node --test`.
import './personal-day-boundary-live.js';

/** Carry-forward ids for operational days. Deliberately NOT the legacy
 *  `carry:<date>:<itemId>` shape (plan-tomorrow-model.js's carriedItemId, which
 *  only accepts a bare calendar date and must keep doing exactly that): an
 *  operationalDayId is not a date and must never be coerced into one. Built from
 *  immutable identities only — source day, source item, destination day — so two
 *  devices carrying the same item to the same day independently mint the SAME id
 *  and the existing per-item merge collapses them into one. '|' is the separator
 *  because an operationalDayId itself contains ':'; a minted plan item id
 *  ('p' + base36) can never contain either. */
export const OPERATIONAL_CARRY_ID_PREFIX = 'ocarry1';

export function operationalCarriedItemId(sourceDayId, sourceItemId, destinationOperationalDayId) {
  // The SOURCE is whatever that day's own authoritative identity is — an
  // operationalDayId, or a calendar dateKey on the transition day, when an item
  // is carried from the last legacy-governed day into the first personal one.
  // Neither is coerced into the other; each is used verbatim.
  const validSource = !!parseOperationalDayId(sourceDayId) || validPlanDate(sourceDayId);
  if (!validSource || !parseOperationalDayId(destinationOperationalDayId)) {
    throw new Error('A valid source day identity and destination operationalDayId are required.');
  }
  if (typeof sourceItemId !== 'string' || !sourceItemId || sourceItemId.includes('|')) throw new Error('A valid source item id is required.');
  return `${OPERATIONAL_CARRY_ID_PREFIX}|${sourceDayId}|${sourceItemId}|${destinationOperationalDayId}`;
}

/** The carry id for any source/destination pair. Legacy -> legacy keeps the
 *  exact existing id, so nothing already stored changes meaning; anything
 *  landing in a personal day gets the operational format, keyed by both days'
 *  immutable identities and the source item. */
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
  return operationalCarriedItemId(sourceTarget.id, sourceItemId, destinationTarget.id);
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

  /** Every write path and every inbound remote merge calls this; derived values
   *  (currently the Planning Streak walk) are recomputed on the next read. */
  function invalidate() {
    cacheToken++;
    streakCache = null;
  }

  function enabled() {
    return live.enabled();
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

  /** The authoritative day for RIGHT NOW. For an account that never enabled the
   *  feature this is exactly the existing calendar "today" (same helper, same
   *  account timezone) — no boundary math, no operational store, no listener. */
  function current(nowMs = now()) {
    if (!enabled()) return legacyTarget(localPlanDate(nowMs, accountTimezone()));
    return fromDay(live.planningDays(nowMs).current);
  }

  /** The authoritative day the owner prepares in advance. Legacy: tomorrow's
   *  calendar date, exactly as planTomorrowTargetDate() computes it. */
  function upcoming(nowMs = now()) {
    if (!enabled()) return legacyTarget(addCalendarDays(localPlanDate(nowMs, accountTimezone()), 1));
    return fromDay(live.planningDays(nowMs).upcoming);
  }

  /** The authoritative day containing a factual instant (an entry, a routine
   *  anchor, a completion). Never a date string — an instant is unambiguous. */
  function containing(instantMs) {
    if (!Number.isFinite(instantMs)) throw new Error('A valid instant is required.');
    if (!enabled()) return legacyTarget(localPlanDate(instantMs, accountTimezone()));
    return fromDay(live.dayContaining(instantMs));
  }

  function next(target) {
    if (target.store === 'legacy' && !enabled()) return legacyTarget(addCalendarDays(target.dateKey, 1));
    const history = live.revisions();
    return fromDay(live.describeDay(nextOperationalDay(target.ref || operationalDayContaining(target.startMs, history), history), history));
  }

  /** The authoritative day immediately before `target`. Personal-day ids are
   *  never treated as calendar dates; the preceding half-open interval is the
   *  one containing the instant immediately before this day starts. */
  function previous(target) {
    if (target.store === 'legacy' && !enabled()) return legacyTarget(addCalendarDays(target.dateKey, -1));
    if (!Number.isFinite(target.startMs)) throw new Error(`Cannot find the day before ${target.id}.`);
    return containing(target.startMs - 1);
  }

  /** Decision B. Every authoritative day overlapping calendar date D's own
   *  interval, in order. One entry for a legacy/never-enabled account (the date
   *  itself); commonly two once a non-midnight boundary is active. */
  function daysOverlappingCalendarDate(dateKey) {
    if (!enabled()) return [legacyTarget(dateKey)];
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

  /** Planning Continuity V1 (G4) — the authoritative day `steps` personal days
   *  after the current one. `upcoming()` is exactly dayAhead(1); this is the general
   *  case the future-day browser walks.
   *
   *  Deliberately implemented by CHAINING next(), not by adding days to a date: a
   *  personal day's length is not fixed (a revision taking effect mid-day truncates
   *  it), so only the real interval chain gives the right answer across a boundary
   *  change. No new store, no new identity — every step returns an ordinary target.
   *
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

  /** The authoritative day containing a future calendar date's own noon anchor.
   *  A convenience for "which personal day is Sep 30 mostly about?", used to seed
   *  the browser from a date picker — NOT an identity. When a calendar date overlaps
   *  two personal days, callers must use daysOverlappingCalendarDate() and show
   *  both; this only picks a starting point. Reuses the same noon anchor Decision A
   *  already defines. */
  function dayForCalendarDate(dateKey) {
    if (!validPlanDate(dateKey)) throw new Error(`A valid calendar date is required, got: ${dateKey}`);
    if (!enabled()) return legacyTarget(dateKey);
    const anchor = noonAnchorInstant(dateKey, accountTimezone());
    if (!anchor.ok) throw new Error(`Calendar date ${dateKey} has no unambiguous local noon.`);
    return containing(anchor.instantMs);
  }

  /** Item-centric scheduling. Untimed tasks use the approved noon ownership
   *  rule; timed tasks use the exact civil timestamp the owner entered. */
  function dayForScheduledDate(dateKey, when = '') {
    if (!validPlanDate(dateKey)) return { ok: false, reason: 'invalid-date' };
    if (!when) return { ok: true, anchor: 'noon', target: dayForCalendarDate(dateKey) };
    const instant = resolvePlannedInstant(dateKey, when, accountTimezone());
    if (!instant.ok) return instant;
    return { ok: true, anchor: 'time', instantMs: instant.instantMs, target: containing(instant.instantMs) };
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
    return target.store === 'legacy' ? legacy.record(target.dateKey) : live.readRecord(target);
  }

  /** Raw items INCLUDING tombstones — the shape every editor mutates. */
  function rawItems(target) {
    return target.store === 'legacy' ? legacy.rawItems(target.dateKey) : (Array.isArray(record(target)?.items) ? record(target).items : []);
  }

  function items(target) {
    return rawItems(target).filter(item => !item.deleted);
  }

  function saveItems(target, nextItems) {
    if (target.store === 'legacy') {
      legacy.saveItems(target.dateKey, nextItems);
      invalidate();
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
    return target.store === 'legacy' ? normalizePreparation(value, target.dateKey) : normalizeOperationalPreparation(value, target.id);
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
    if (target.store === 'legacy') return planningConsistency(value, target.dateKey);
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
    if (target.store === 'legacy') return computeReadyNow({ plan, targetDate: target.dateKey, routines, localSaveSucceeded });
    const prepared = normalizeOperationalPreparation(plan?.preparation, target.id);
    if (!prepared || !localSaveSucceeded) return false;
    const oneOffIds = new Set(prepared.oneOffItemIds);
    // Same current-kind rule as computeReadyNow: a prepared priority later demoted to a
    // task no longer keeps the day ready.
    const actionableOneOff = rawItems(target).some(item => oneOffIds.has(item.id) && planItemKind(item) === 'priority' && !item.deleted && !item.done);
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
    if (target.store === 'legacy') {
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
  function itemStartInstant(target, hhmm) {
    if (typeof hhmm !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null;
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
    if (target.store === 'legacy') {
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
    if (target.store === 'operational') return { startMs: target.startMs, endMs: target.endMs };
    return calendarDayBounds(target.dateKey);
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
    if (target.store === 'legacy') return { rows: instances.filter(instance => instance.date === target.dateKey), unplaceable: [] };
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
    if (target.store === 'legacy') return entriesByDate(target.dateKey);
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
    if (!enabled()) return planningStreak(legacy.allPlans(), nowMs, accountTimezone());
    const key = `${cacheToken}:${nowMs - (nowMs % 60000)}`;
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
      const activeItems = (Array.isArray(plan?.items) ? plan.items : []).filter(item => item && !item.deleted);
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
    if (enabled()) {
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
    return out;
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
    return collectStaleUnfinished({ nowMs, days, dayRecords: allDayRecords() });
  }

  /** Where a stale item was moved to, or null — so a surface can render
   *  "Moved to ..." instead of offering a second move. */
  function staleMoveDestination(sourceItemId, sourceDayId) {
    return findMoveDestination(sourceItemId, sourceDayId, allDayRecords());
  }

  /** Resolves a stored day id (either store) back to a target. */
  function targetById(dayId) {
    if (validPlanDate(dayId)) {
      try {
        const bounds = calendarDayBounds(dayId);
        return { ...legacyTarget(dayId), startMs: bounds.startMs, endMs: bounds.endMs };
      } catch { return legacyTarget(dayId); }
    }
    const ref = parseOperationalDayId(dayId);
    if (!ref || !enabled()) return null;
    try { return fromDay(live.describeDay(ref, live.revisions())); } catch { return null; }
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
    if (Number.isFinite(sourceTarget.endMs) && sourceTarget.endMs > nowMs) {
      // Moving out of a day that is still running would leave TWO simultaneously
      // active copies. That case is the existing carry-forward flow, not this one.
      throw new Error('That day has not ended yet.');
    }
    const existing = staleMoveDestination(itemId, sourceTarget.id);
    if (existing) {
      if (existing.dayId === destination.id) return { moved: false, alreadyAt: existing };
      throw new Error('That task has already been moved. Change where it is scheduled instead.');
    }
    const carryId = carryItemIdFor(sourceTarget, itemId, destination);
    const destinationItems = rawItems(destination);
    let moved = buildMovedItem({ carryId, sourceItem, sourceDayId: sourceTarget.id, stamp });
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
    const items = rawItems(target);
    const current = items.find(candidate => candidate.id === itemId);
    if (!current) throw new Error('That item is no longer in this plan.');
    if (current.deleted) throw new Error('That item was removed.');
    if (planItemKind(current) === kind) return { changed: false, item: current };
    if (kind === 'priority') {
      const others = activePriorityPlanItems(items.filter(candidate => candidate.id !== itemId));
      if (others.length >= priorityMax) {
        throw new Error(`Your Top ${priorityMax} is already full. Finish, remove or demote one first.`);
      }
    }
    const next = stamp(withPlanItemKind(current, kind));
    saveItems(target, items.map(candidate => (candidate.id === itemId ? next : candidate)));
    return { changed: true, item: next };
  }

  /** Edits one canonical plan item and optionally moves it to another
   *  authoritative day. The id is preserved. A cross-day move writes the live
   *  item at the destination and a tombstone at the source so sync cannot
   *  resurrect a second active copy. */
  function updateItem({ sourceTarget, itemId, destination = sourceTarget, changes = {}, stamp }) {
    if (!sourceTarget || !destination) throw new Error('A source and destination day are required.');
    if (typeof stamp !== 'function') throw new Error('An item stamping function is required.');
    const sourceItems = rawItems(sourceTarget);
    const current = sourceItems.find(item => item.id === itemId && !item.deleted);
    if (!current) throw new Error('That planned task no longer exists.');

    const title = Object.prototype.hasOwnProperty.call(changes, 'task') ? String(changes.task || '').trim() : current.task;
    if (!title) throw new Error('Name the task first.');
    const kind = Object.prototype.hasOwnProperty.call(changes, 'kind') ? changes.kind : planItemKind(current);
    if (kind !== 'priority' && kind !== 'task') throw new Error(`Unknown plan item kind: ${kind}`);
    let nextItem = withPlanItemKind({ ...current, ...changes, id: current.id, task: title, deleted: false }, kind);

    const destinationItems = sourceTarget.id === destination.id ? sourceItems : rawItems(destination);
    if (kind === 'priority') {
      const otherPriorities = destinationItems.filter(item => item.id !== itemId && !item.deleted && planItemKind(item) === 'priority');
      if (otherPriorities.length >= priorityMax) throw new Error(`Your Top ${priorityMax} is already full. Finish, remove or demote one first.`);
    }
    const validation = validateItem(destination, nextItem);
    if (!validation.ok) throw new Error(validation.reason === 'outside-operational-day' ? 'That time is outside this personal day.' : 'That time is not valid for this day.');
    nextItem = stamp(nextItem);

    if (sourceTarget.id === destination.id) {
      saveItems(sourceTarget, sourceItems.map(item => item.id === itemId ? nextItem : item));
      return { moved: false, item: nextItem, destination };
    }

    const destinationNext = destinationItems.some(item => item.id === itemId)
      ? destinationItems.map(item => item.id === itemId ? nextItem : item)
      : [...destinationItems, nextItem];
    saveItems(destination, destinationNext);
    const tombstone = stamp({ ...current, deleted: true, movedToDayId: destination.id });
    saveItems(sourceTarget, sourceItems.map(item => item.id === itemId ? tombstone : item));
    return { moved: true, item: nextItem, destination };
  }

  /** Re-targets an already-moved task: tombstones the copy on the old destination,
   *  then writes one on the new. Never leaves two active copies. A hard removal is
   *  not used because it would be resurrected by the per-item merge. */
  function rescheduleStaleItem({ sourceTarget, itemId, destination, stamp, nowMs = now() }) {
    const existing = staleMoveDestination(itemId, sourceTarget.id);
    if (!existing) return moveStaleItem({ sourceTarget, itemId, destination, stamp, nowMs });
    if (existing.dayId === destination.id) return { moved: false, alreadyAt: existing };
    const oldTarget = targetById(existing.dayId);
    if (!oldTarget) throw new Error('The day this task was moved to cannot be resolved right now.');
    saveItems(oldTarget, rawItems(oldTarget).map(candidate => (
      candidate.id === existing.itemId ? stamp({ ...candidate, deleted: true }) : candidate
    )));
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
    )));
    return { dismissed: true };
  }

  function undismissStaleItem({ sourceTarget, itemId, stamp }) {
    const items = rawItems(sourceTarget);
    const sourceItem = items.find(candidate => candidate.id === itemId);
    if (!sourceItem) throw new Error('That task is no longer on its original day.');
    saveItems(sourceTarget, items.map(candidate => (
      candidate.id === itemId ? buildUndismissedItem(sourceItem, { stamp }) : candidate
    )));
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
    current, upcoming, containing, next, previous, daysOverlappingCalendarDate,
    dayAhead, dayForCalendarDate, dayForScheduledDate, upcomingDays,
    record, rawItems, items, saveItems,
    preparation, consistency, readyNow, preparedState, confirmPreparation,
    validateItem, itemStartInstant, evidenceWindow, classifyItemActual,
    routineTarget, routinesForTarget, templatesForTarget,
    habitEarned, streak,
    preparedPlans, boundaryChangeImpact,
    setItemKind, updateItem,
    staleUnfinished, staleMoveDestination, moveStaleItem, rescheduleStaleItem,
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
      saveItems: (dateKey, items) => authorityAppContext().saveItems(dateKey, items),
      confirm: input => authorityAppContext().confirm(input),
      allPlans: () => authorityAppContext().allPlans(),
      earliestPlanDate: () => authorityAppContext().earliestPlanDate(),
    },
    priorityMax: (() => { try { return authorityAppContext().maxItems; } catch { return 3; } })(),
    accountTimezone: () => authorityAppContext().timezone,
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
  // The My Day timeline also reads the authoritative interval, and its first render
  // happened before this module existed (it fell back to the calendar day). Only an
  // account with an ACTIVE boundary needs that rebuild: without one, the calendar
  // timeline the first render already produced is correct, so a second full renderToday()
  // would be pure startup cost on the most common path.
  try { if (window.PlanAuthority.enabled()) globalThis.renderToday?.(); } catch { /* boundary state unreadable — the next ordinary render covers it */ }
}
