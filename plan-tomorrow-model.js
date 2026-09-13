const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = new Set(['normal', 'rescue']);

export function validPlanDate(value) {
  return typeof value === 'string' && DATE.test(value)
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

const PLAN_ITEM_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A one-off priority's optional `when` is only ever treated as a real, structured time when it
 *  is exactly zero-padded 24h "HH:MM" — the same bound index.html's own PLAN_TIME_RE enforces for
 *  due/order calculations. Anything else (blank, or historical free text like "after lunch") is
 *  left alone; callers fall back to the plain, unparsed display. */
export function validPlanItemTime(value) {
  return typeof value === 'string' && PLAN_ITEM_TIME_RE.test(value);
}

/** 24h "HH:MM" -> "9:00 AM" for display only; storage always stays the canonical 24h string. */
export function formatPlanItemTime(value) {
  if (!validPlanItemTime(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  const period = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

/** Plan Time Range V1: a one-off priority's optional length. `when` stays the sole canonical
 *  start time (see PLAN_ITEM_TIME_RE above) — this only ever measures forward from it, in whole
 *  minutes, bounded to something that still reads as a single continuous block (12h). Zero,
 *  negative, non-integers, and absurd values (e.g. a stray millisecond timestamp) are all invalid;
 *  there is no separate "end equal to start" or "end before start" case to guard because a length
 *  can't express either — both collapse into this same bounds check. */
export function validPlanItemDuration(value) {
  return Number.isInteger(value) && value > 0 && value <= 720;
}

function timeToMinutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function minutesToTime(totalMinutes) {
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

/** The canonical 24h end time for a start + duration, or null when either half is missing/invalid
 *  OR the block would run past midnight into the next calendar day. Cross-midnight ranges are
 *  explicitly unsupported in V1: rather than fabricating a next-day interpretation, an item whose
 *  computed end doesn't fit today is treated exactly like one with no range at all. */
export function planItemEndTime(when, durationMinutes) {
  if (!validPlanItemTime(when) || !validPlanItemDuration(durationMinutes)) return null;
  const end = timeToMinutes(when) + durationMinutes;
  return end < 24 * 60 ? minutesToTime(end) : null;
}

/** Derives the duration (minutes) implied by an exact custom start + end pair, for the "pick an
 *  end time" editing path. An end at or before its start — same value, earlier, or a wrap past
 *  midnight — is rejected outright (null), never reinterpreted as spanning into the next day. */
export function durationBetween(startWhen, endWhen) {
  if (!validPlanItemTime(startWhen) || !validPlanItemTime(endWhen)) return null;
  const diff = timeToMinutes(endWhen) - timeToMinutes(startWhen);
  return diff > 0 ? diff : null;
}

/** The single authoritative "is this a storable range" check — true only when durationMinutes is
 *  itself well-formed AND its end actually fits against `when` (same calendar day). Every write
 *  path (quick-duration, start changes, custom end) composes this instead of checking
 *  validPlanItemDuration/planItemEndTime separately, so there is exactly one place a scheduling
 *  mutation can be judged valid — never two authorities that could disagree. */
export function validPlanItemRange(when, durationMinutes) {
  return validPlanItemDuration(durationMinutes) && planItemEndTime(when, durationMinutes) !== null;
}

/** The one authoritative range label — "9:00 AM" or "9:00–10:30 AM" — built entirely on top of
 *  formatPlanItemTime so every caller (Today, Plan Tomorrow, Tomorrow View) renders schedules
 *  identically. Compact when both ends share a period; keeps each side's own AM/PM once they
 *  differ. Returns null for anything untimed or malformed — never throws. */
export function formatPlanItemSchedule(item) {
  const startLabel = formatPlanItemTime(item && item.when);
  if (!startLabel) return null;
  const endWhen = planItemEndTime(item && item.when, item && item.durationMinutes);
  if (!endWhen) return startLabel;
  const endLabel = formatPlanItemTime(endWhen);
  const [, startClock, startPeriod] = startLabel.match(/^(.*) (AM|PM)$/);
  const [, endClock, endPeriod] = endLabel.match(/^(.*) (AM|PM)$/);
  return startPeriod === endPeriod ? `${startClock}–${endClock} ${endPeriod}` : `${startLabel}–${endLabel}`;
}

/** Display label for any plan item, structured or legacy: a recognized start/range via
 *  formatPlanItemSchedule, falling back to historical free text verbatim (never parsed, never
 *  reformatted), or null when there's nothing to show. The single source read-only consumers
 *  (Today, Tomorrow View) use so neither reimplements the legacy-text fallback separately. */
export function planItemScheduleLabel(item) {
  return formatPlanItemSchedule(item) || (item && typeof item.when === 'string' && item.when.trim() ? item.when : null);
}

/** Drops duration/end metadata but leaves `when` untouched — "Remove range" (keep the start).
 *  "Remove time" (clear everything) composes this with also blanking `when` at the call site,
 *  the same way it already blanks `when` alone today. */
export function clearPlanItemRange(item) {
  const next = { ...item };
  delete next.durationMinutes;
  return next;
}

export function validPlanTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function localPlanDate(now, timezone) {
  if (!validPlanTimezone(timezone)) throw new Error('A valid planning timezone is required.');
  const value = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(value.getTime())) throw new Error('A valid planning time is required.');
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(value);
}

export function addCalendarDays(date, amount) {
  if (!validPlanDate(date) || !Number.isInteger(amount)) throw new Error('A valid calendar date and whole-day offset are required.');
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function planTomorrowTargetDate(now, timezone) {
  return addCalendarDays(localPlanDate(now, timezone), 1);
}

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function mergeTimestamp(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}

function writer(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200 ? value : null;
}

function compareStrings(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

function ids(value) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id || id.length > 500)) return null;
  return [...new Set(value)].sort();
}

export function normalizePreparation(value, expectedTargetDate) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return null;
  if (!validPlanDate(value.targetDate) || (expectedTargetDate && value.targetDate !== expectedTargetDate)) return null;
  if (!validPlanTimezone(value.timezone) || !MODES.has(value.firstPreparedMode) || !MODES.has(value.lastPreparedMode)) return null;
  const firstPreparedAt = timestamp(value.firstPreparedAt);
  const lastPreparedAt = timestamp(value.lastPreparedAt);
  const updatedBy = writer(value.updatedBy);
  const routineInstanceIds = ids(value.routineInstanceIds);
  const oneOffItemIds = ids(value.oneOffItemIds);
  if (!firstPreparedAt || !lastPreparedAt || lastPreparedAt < firstPreparedAt || !updatedBy || !routineInstanceIds || !oneOffItemIds || typeof value.intentionalBlank !== 'boolean') return null;
  const normalized = {
    schemaVersion: 1,
    targetDate: value.targetDate,
    timezone: value.timezone,
    firstPreparedAt,
    firstPreparedMode: value.firstPreparedMode,
    lastPreparedAt,
    lastPreparedMode: value.lastPreparedMode,
    updatedBy,
    intentionalBlank: value.intentionalBlank,
    routineInstanceIds,
    oneOffItemIds
  };
  const firstPreparedBy = writer(value.firstPreparedBy);
  if (firstPreparedBy) normalized.firstPreparedBy = firstPreparedBy;
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function firstPreparationKey(value) {
  return `${writer(value.firstPreparedBy) || ''}\u0000${canonical({
    firstPreparedMode: value.firstPreparedMode,
    timezone: value.timezone
  })}`;
}

function latestPreparationKey(value) {
  return `${value.updatedBy}\u0000${canonical({
    intentionalBlank: value.intentionalBlank,
    lastPreparedMode: value.lastPreparedMode,
    oneOffItemIds: value.oneOffItemIds,
    routineInstanceIds: value.routineInstanceIds
  })}`;
}

function earlierPreparation(a, b) {
  if (a.firstPreparedAt !== b.firstPreparedAt) return a.firstPreparedAt < b.firstPreparedAt ? a : b;
  return compareStrings(firstPreparationKey(a), firstPreparationKey(b)) >= 0 ? a : b;
}

function laterPreparation(a, b) {
  if (a.lastPreparedAt !== b.lastPreparedAt) return a.lastPreparedAt > b.lastPreparedAt ? a : b;
  return compareStrings(latestPreparationKey(a), latestPreparationKey(b)) >= 0 ? a : b;
}

export function buildPreparation(current, input) {
  const targetDate = input?.targetDate;
  const timezone = input?.timezone;
  const now = timestamp(input?.now);
  const mode = input?.mode;
  const updatedBy = writer(input?.updatedBy);
  const routineInstanceIds = ids(input?.routineInstanceIds);
  const oneOffItemIds = ids(input?.oneOffItemIds);
  if (!validPlanDate(targetDate) || !validPlanTimezone(timezone) || !now || !MODES.has(mode) || !updatedBy || !routineInstanceIds || !oneOffItemIds || typeof input.intentionalBlank !== 'boolean') throw new Error('Invalid preparation confirmation.');
  const previous = normalizePreparation(current, targetDate);
  const confirmation = {
    schemaVersion: 1,
    targetDate,
    timezone,
    firstPreparedAt: now,
    firstPreparedBy: updatedBy,
    firstPreparedMode: mode,
    lastPreparedAt: now,
    lastPreparedMode: mode,
    updatedBy,
    intentionalBlank: input.intentionalBlank,
    routineInstanceIds,
    oneOffItemIds
  };
  return previous ? mergePreparations(previous, confirmation, targetDate) : confirmation;
}

export function mergePreparations(localValue, remoteValue, targetDate) {
  const local = normalizePreparation(localValue, targetDate);
  const remote = normalizePreparation(remoteValue, targetDate);
  if (!local) return remote;
  if (!remote) return local;
  const first = earlierPreparation(local, remote);
  const last = laterPreparation(local, remote);
  const merged = {
    schemaVersion: 1,
    targetDate: first.targetDate,
    timezone: first.timezone,
    firstPreparedAt: first.firstPreparedAt,
    firstPreparedMode: first.firstPreparedMode,
    lastPreparedAt: last.lastPreparedAt,
    lastPreparedMode: last.lastPreparedMode,
    updatedBy: last.updatedBy,
    intentionalBlank: last.intentionalBlank,
    routineInstanceIds: last.routineInstanceIds.slice(),
    oneOffItemIds: last.oneOffItemIds.slice()
  };
  if (first.firstPreparedBy) merged.firstPreparedBy = first.firstPreparedBy;
  return merged;
}

function itemMutationKey(value) {
  return `${writer(value?.updatedBy) || ''}\u0000${canonical(value)}`;
}

function chooseItem(local, remote) {
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

export function mergeDatePlans(localValue, remoteValue, targetDate) {
  const local = localValue && typeof localValue === 'object' ? localValue : {};
  const remote = remoteValue && typeof remoteValue === 'object' ? remoteValue : {};
  const byId = new Map();
  for (const item of planItems(local.items)) if (item.id) byId.set(item.id, item);
  for (const item of planItems(remote.items)) {
    if (!item.id) continue;
    byId.set(item.id, byId.has(item.id) ? chooseItem(byId.get(item.id), item) : item);
  }
  const localAt = mergeTimestamp(local.updatedAt);
  const remoteAt = mergeTimestamp(remote.updatedAt);
  const latestPlan = localAt === remoteAt
    ? (compareStrings(writer(remote.updatedBy) || '', writer(local.updatedBy) || '') >= 0 ? remote : local)
    : (remoteAt > localAt ? remote : local);
  const merged = {
    items: [...byId.values()].sort((a, b) => compareStrings(String(a.id), String(b.id))),
    updatedAt: Math.max(localAt, remoteAt)
  };
  const latestWriter = writer(latestPlan.updatedBy);
  if (latestWriter) merged.updatedBy = latestWriter;
  const preparation = mergePreparations(local.preparation, remote.preparation, targetDate);
  if (preparation) merged.preparation = preparation;
  return merged;
}

export function planningConsistency(value, targetDate) {
  if (value === undefined || value === null) return 'not-prepared';
  const preparation = normalizePreparation(value, targetDate);
  if (!preparation) return 'unknown';
  return localPlanDate(preparation.firstPreparedAt, preparation.timezone) < preparation.targetDate ? 'ahead' : 'late';
}

function genuinePlanningHabit(preparationValue, targetDate) {
  if (planningConsistency(preparationValue, targetDate) !== 'ahead') return false;
  const preparation = normalizePreparation(preparationValue, targetDate);
  return preparation.intentionalBlank === true || preparation.routineInstanceIds.length > 0 || preparation.oneOffItemIds.length > 0;
}

function planningHabitEarned(plansByDate, habitDate) {
  const nextDate = addCalendarDays(habitDate, 1);
  const plan = plansByDate && typeof plansByDate === 'object' ? plansByDate[nextDate] : null;
  return genuinePlanningHabit(plan?.preparation, nextDate);
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

/**
 * Derives the Planning Streak entirely from plans[date].preparation — no stored counter.
 * A habit day P earns credit when the user confirmed P+1's plan (real or Open Day) ahead of
 * P+1 itself. Today's own habit day is evaluated but never treated as a miss while still open;
 * it either extends the streak (already prepared tomorrow) or is simply excluded from the count.
 */
export function planningStreak(plansByDate, nowMs, timezone) {
  const today = localPlanDate(nowMs, timezone);
  const todayEarned = planningHabitEarned(plansByDate, today);

  const keys = plansByDate && typeof plansByDate === 'object' ? Object.keys(plansByDate).filter(validPlanDate) : [];
  let earliestHabitDate = today;
  for (const key of keys) {
    const habitDate = addCalendarDays(key, -1);
    if (habitDate < earliestHabitDate) earliestHabitDate = habitDate;
  }

  const yesterday = addCalendarDays(today, -1);
  const finalizedFlags = [];
  for (let date = earliestHabitDate; date <= yesterday; date = addCalendarDays(date, 1)) {
    finalizedFlags.push(planningHabitEarned(plansByDate, date));
  }

  let backward = 0;
  while (backward < finalizedFlags.length && finalizedFlags[finalizedFlags.length - 1 - backward]) backward++;

  const current = backward + (todayEarned ? 1 : 0);
  const best = Math.max(longestTrueRun(finalizedFlags), current);

  return { current, best, todayEarned, todayStillOpen: !todayEarned };
}

export function computeReadyNow({ plan, targetDate, routines = [], localSaveSucceeded = true }) {
  const preparation = normalizePreparation(plan?.preparation, targetDate);
  if (!preparation || !localSaveSucceeded) return false;
  const oneOffIds = new Set(preparation.oneOffItemIds);
  const actionableOneOff = planItems(plan.items).some(item => oneOffIds.has(item.id) && !item.deleted && !item.done);
  const plannedRoutines = new Set(preparation.routineInstanceIds);
  const actionableRoutine = routines.some(item => plannedRoutines.has(item.id) && item.occurs !== false && !item.skipped && item.actionable !== false);
  return actionableOneOff || actionableRoutine || preparation.intentionalBlank;
}

export function classifyOneOffActual(item, { targetDate, timezone, trackedMinutes = 0, preparedAt = 0 } = {}) {
  if (item?.deleted && Number(item.updatedAt || 0) >= Number(preparedAt || 0)) return 'removed';
  if (item?.done) {
    const doneDate = Number.isFinite(item.doneAt) && validPlanTimezone(timezone) ? localPlanDate(item.doneAt, timezone) : targetDate;
    return doneDate < targetDate ? 'done-early' : 'done';
  }
  return trackedMinutes > 0 ? 'worked-on' : 'not-done';
}

export function classifyRoutineActual({ occurs = true, skipped = false, completion = null } = {}) {
  if (!occurs || skipped) return 'removed';
  if (completion && ['target', 'minimum', 'complete'].includes(completion.level)) return completion.level;
  if (completion && completion.level === 'incomplete' && Number(completion.duration || 0) > 0) return 'worked-on';
  return 'not-done';
}

export function summarizeActual(rows) {
  const active = rows.filter(row => row.status !== 'removed');
  const completed = active.filter(row => ['done-early', 'done', 'worked-on', 'target', 'minimum', 'complete'].includes(row.status)).length;
  return { planned: rows.length, active: active.length, completed, removed: rows.length - active.length };
}

/** Daily Reconciliation's completed/unfinished split over a classifyOneOffActual status.
 *  'removed' items are gone from the plan (deleted after prep) and are excluded entirely —
 *  there is nothing left to reconcile. Everything else is either fully resolved ('done'/
 *  'done-early') or still open ('not-done'/'worked-on': tracked time alone isn't completion). */
export function reconciliationBucket(oneOffStatus) {
  if (oneOffStatus === 'removed') return 'excluded';
  if (oneOffStatus === 'not-done' || oneOffStatus === 'worked-on') return 'unfinished';
  return 'completed';
}

/** Deterministic id for the tomorrow item that carries a given today item forward. Colon-joined
 *  so it can never collide with a `createPlanItem` id (those are `'p' + base36 timestamp + random
 *  chars` — no colon, ever) regardless of source-item-id uniqueness. Includes the source date
 *  (not just the source item id) because the same physical device/session could in principle be
 *  reconciling two different "today"s across a long-open tab; date-scoping the id removes any
 *  reliance on source ids being globally unique across dates. Deterministic across devices, so two
 *  clients carrying the same source item independently write to the SAME tomorrow item id, and the
 *  existing per-id mergeDatePlans/chooseItem convergence (highest updatedAt wins, ties broken
 *  canonically) resolves them into one — no second merge engine required. */
export function carriedItemId(sourceDate, sourceItemId) {
  if (!validPlanDate(sourceDate) || typeof sourceItemId !== 'string' || !sourceItemId) throw new Error('A valid source date and source item id are required.');
  return `carry:${sourceDate}:${sourceItemId}`;
}

const api = { validPlanDate, validPlanTimezone, validPlanItemTime, formatPlanItemTime, validPlanItemDuration, planItemEndTime, durationBetween, validPlanItemRange, formatPlanItemSchedule, planItemScheduleLabel, clearPlanItemRange, localPlanDate, addCalendarDays, planTomorrowTargetDate, normalizePreparation, buildPreparation, mergePreparations, mergeDatePlans, planningConsistency, planningStreak, computeReadyNow, classifyOneOffActual, classifyRoutineActual, summarizeActual, reconciliationBucket, carriedItemId };
globalThis.PlanTomorrowModel = api;
// Today's plan strip renders once, synchronously, before this module (deferred by type="module")
// finishes loading — its preparation/streak/schedule-label fields all read PlanTomorrowModel, so
// that very first render always runs without it. Re-rendering once, right here, is what makes that
// first pass a transient gap instead of a stuck one; a real inbound-remote replay (below) still
// re-renders again on top of this when it actually changes something.
globalThis.renderTodayPlan?.();
globalThis.replayPendingPlanRemotes?.();
