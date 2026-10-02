// daily-view-window.js
//
// Configurable 24–48 Hour Daily View V1 — pure. The ONE visual-extent rule for a
// calendar-native Daily View (it replaces Extended My Day's content-driven extension):
//
//   selected factual date + Daily View Length (hours) -> [windowStart, windowEnd)
//
// windowStart is 00:00 of the selected date and windowEnd is the CIVIL reading that many
// hours later (36h on Saturday ends Sunday 12:00), both in the selected plan's own home
// zone, resolved with the same rule calendar-plan-model.js uses for a plan's own midnight
// (an ambiguous reading takes the earlier instant, a skipped one the first instant after
// the gap). The window is half-open.
//
// Visual projection is not factual ownership. A positioned planned row is visible when its
// own interval intersects the window; it keeps the target id and item id of the plan that
// owns it, so every action on it still writes that plan's one record. Nothing here reads
// or writes storage: the caller passes PlanAuthority in, and this module only calls its
// read methods.
//
// Only plans that can reach the window are read. A calendar plan spans its own date plus
// at most MAX_PLAN_DAY_OFFSET more (calendar-plan-model.js), so a window starting at D 00:00
// and ending at most at D+2 00:00 can only intersect the plans of D-1, D and D+1.

import { addCalendarDays } from './plan-tomorrow-model.js';
import { resolveLocalWallClock } from './personal-day-boundary-model.js';
import { MAX_PLAN_DAY_OFFSET } from './calendar-plan-model.js';
import { deriveMyDayPlannedRows } from './tomorrow-timeline-model.js';

export const DAILY_VIEW_MIN_HOURS = 24;
export const DAILY_VIEW_MAX_HOURS = 48;
export const DAILY_VIEW_DEFAULT_HOURS = 36;

/** Every whole hour from 24 to 48 is valid. Anything else — missing, malformed, fractional,
 *  out of range — is the default 36, never clamped to a guess and never inferred from content. */
export function normalizeDailyViewHours(value) {
  let hours = NaN;
  if (typeof value === 'number') hours = value;
  else if (typeof value === 'string' && /^\d{1,3}$/.test(value.trim())) hours = Number(value.trim());
  return Number.isInteger(hours) && hours >= DAILY_VIEW_MIN_HOURS && hours <= DAILY_VIEW_MAX_HOURS ? hours : DAILY_VIEW_DEFAULT_HOURS;
}

function civilInstant(dateKey, hhmm, timezone) {
  const resolved = resolveLocalWallClock(dateKey, hhmm, timezone);
  if (resolved.kind === 'unique') return resolved.instantMs;
  if (resolved.kind === 'ambiguous') return resolved.earlierMs;
  return resolved.instantAfterGapMs;
}

/** @param {string} dateKey the selected factual date (YYYY-MM-DD)
 *  @param {*} hours Daily View Length; normalized here
 *  @param {string} timezone the selected plan's home zone
 *  @returns {{dateKey:string, hours:number, timezone:string, startMs:number, endMs:number,
 *    factualDateSegments:{dateKey:string, startMs:number, endMs:number}[], sourceDateKeys:string[]}} */
export function dailyViewWindow(dateKey, hours, timezone) {
  const normalized = normalizeDailyViewHours(hours);
  const startMs = civilInstant(dateKey, '00:00', timezone);
  const endDateKey = addCalendarDays(dateKey, Math.floor(normalized / 24));
  const endMs = civilInstant(endDateKey, `${String(normalized % 24).padStart(2, '0')}:00`, timezone);
  const factualDateSegments = [];
  for (let offset = 0; offset <= 2; offset++) {
    const segmentDate = addCalendarDays(dateKey, offset);
    const segmentStart = civilInstant(segmentDate, '00:00', timezone);
    if (segmentStart >= endMs) break;
    const segmentEnd = Math.min(civilInstant(addCalendarDays(segmentDate, 1), '00:00', timezone), endMs);
    factualDateSegments.push({ dateKey: segmentDate, startMs: Math.max(segmentStart, startMs), endMs: segmentEnd });
  }
  // Plans whose own extent [P 00:00, P+1+MAX_PLAN_DAY_OFFSET 00:00) can intersect the window.
  const sourceDateKeys = [];
  for (let offset = -MAX_PLAN_DAY_OFFSET; offset <= 2; offset++) {
    const planDate = addCalendarDays(dateKey, offset);
    if (civilInstant(planDate, '00:00', timezone) >= endMs) break;
    sourceDateKeys.push(planDate);
  }
  return { dateKey, hours: normalized, timezone, startMs, endMs, factualDateSegments, sourceDateKeys };
}

/** Half-open intersection. A ranged interval is visible when start < windowEnd and
 *  end > windowStart; a start-only (point) row keeps the existing rule — it is placed by
 *  its start, so it is visible when windowStart <= start < windowEnd. */
export function intersectsDailyViewWindow(viewWindow, startMs, endMs) {
  if (!viewWindow || !Number.isFinite(startMs)) return false;
  if (Number.isFinite(endMs) && endMs > startMs) return startMs < viewWindow.endMs && endMs > viewWindow.startMs;
  return startMs >= viewWindow.startMs && startMs < viewWindow.endMs;
}

function compareStrings(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

const SOURCE_ORDER = { 'planned-task': 0, commitment: 1 };
/** A timed commitment lasts at most 720 minutes (commitments-model.js), so one still running
 *  at windowStart started less than a day before it. */
const COMMITMENT_LOOKBACK_MS = 24 * 3600000;

/** The Daily View's planned rows for one selected calendar-authoritative date.
 *  `authority` is PlanAuthority (only isCalendarAuthoritative / calendarTarget / items /
 *  itemInstants / itemStartInstant are called). `commitments` are the selected date's own
 *  (their date-only ones are Anytime rows); `commitmentsBetween(startMs, endMs)` returns the
 *  commitments STARTING in a range — it is asked for a range reaching back far enough to
 *  catch any timed commitment still running at windowStart, and only those intersecting
 *  the window are kept. Untimed ("Anytime") plan
 *  rows come from the selected plan alone — a neighboring plan's untimed item has no
 *  position in this window. Returns null when the selected date is not
 *  calendar-authoritative (the legacy and Personal Day views keep their own windows). */
export function deriveDailyViewPlannedRows({ dateKey, hours, authority, commitments = [], commitmentsBetween = null } = {}) {
  if (!authority || authority.isCalendarAuthoritative(dateKey) !== true) return null;
  const selected = authority.calendarTarget(dateKey);
  const viewWindow = dailyViewWindow(dateKey, hours, selected.timezone);
  const itemInstants = (target, item) => authority.itemInstants(target, item);
  const itemStartInstant = (target, when, item) => authority.itemStartInstant(target, when, item);
  const sourceTargets = {};
  const candidates = [];
  let anytime = [];
  for (const sourceDate of viewWindow.sourceDateKeys) {
    const target = sourceDate === dateKey ? selected : (authority.isCalendarAuthoritative(sourceDate) === true ? authority.calendarTarget(sourceDate) : null);
    if (!target) continue;
    sourceTargets[target.id] = target;
    const derived = deriveMyDayPlannedRows({ target, planItems: authority.items(target), itemInstants, itemStartInstant });
    candidates.push(...derived.positioned);
    if (target.id === selected.id) anytime = derived.anytime;
  }
  // Date-only commitments stay the selected date's own (exactly as before); timed ones are
  // positioned records like any other and are kept when they intersect the window.
  anytime = [...anytime, ...deriveMyDayPlannedRows({ target: selected, commitments, itemInstants, itemStartInstant }).anytime];
  const windowCommitments = typeof commitmentsBetween === 'function'
    ? commitmentsBetween(viewWindow.startMs - COMMITMENT_LOOKBACK_MS, viewWindow.endMs) || []
    : commitments;
  candidates.push(...deriveMyDayPlannedRows({ target: selected, commitments: windowCommitments, itemInstants, itemStartInstant }).positioned);

  const seen = new Set();
  const positioned = candidates
    .filter(row => intersectsDailyViewWindow(viewWindow, row.startMs, row.endMs))
    .filter(row => (seen.has(row.id) ? false : (seen.add(row.id), true)))
    .map(row => ({
      ...row,
      displayStartMs: Math.max(row.startMs, viewWindow.startMs),
      carryIn: row.startMs < viewWindow.startMs,
      ownerDateKey: row.sourceType === 'planned-task' ? sourceTargets[row.dayId]?.dateKey ?? null : null,
      ownedBySelected: row.sourceType !== 'planned-task' || row.dayId === selected.id,
    }))
    .sort((a, b) => (a.displayStartMs - b.displayStartMs) || (SOURCE_ORDER[a.sourceType] - SOURCE_ORDER[b.sourceType]) || compareStrings(a.id, b.id));
  return { window: viewWindow, selected, sourceTargets, positioned, anytime };
}

const api = {
  DAILY_VIEW_MIN_HOURS, DAILY_VIEW_MAX_HOURS, DAILY_VIEW_DEFAULT_HOURS,
  normalizeDailyViewHours, dailyViewWindow, intersectsDailyViewWindow, deriveDailyViewPlannedRows,
};
globalThis.DailyViewWindow = api;
// index.html can render before this deferred module runs; once the rule exists, the Today
// timeline and the Settings control re-render from it (no-ops outside the browser).
globalThis.renderDailyViewHoursSetting?.();
globalThis.scheduleRenderToday?.();
