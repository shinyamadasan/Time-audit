/** Tomorrow Timeline Preview is a pure projection over three already-authoritative sources —
 *  tomorrow's one-off plan items (plan-tomorrow-model.js), tomorrow's applicable Daily Routine
 *  instances (daily-routines-model.js, via getPlanTomorrowRoutineSummary), and tomorrow's
 *  applicable schedule Templates (index.html's generateTemplateEntries) — normalized into one
 *  read-only, orderable shape. It never re-derives recurrence, applicability, or schedule
 *  validity itself; every "does this occur" and "is this time valid" decision was already made
 *  by the source system before its row reaches here. This module only classifies precision and
 *  label, then orders. It creates nothing: no entry, no completion, no auto-log trigger.
 */
import { validPlanItemTime, planItemEndTime, formatPlanItemTime } from './plan-tomorrow-model.js';

const ROUTINE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return hour * 60 + minute;
}

function compareStrings(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Mirrors formatPlanItemSchedule's own AM/PM-compaction rule, but (unlike that function) accepts
 *  an explicit crossesMidnight flag instead of deriving validity from planItemEndTime — the one
 *  extension a cross-midnight Template range needs that a same-day plan-item range never can. */
function formatRangeLabel(startWhen, endWhen) {
  const startLabel = formatPlanItemTime(startWhen);
  const endLabel = formatPlanItemTime(endWhen);
  if (!startLabel || !endLabel) return startLabel || null;
  const [, startClock, startPeriod] = startLabel.match(/^(.*) (AM|PM)$/) || [];
  const [, endClock, endPeriod] = endLabel.match(/^(.*) (AM|PM)$/) || [];
  if (!startClock || !endClock) return `${startLabel}–${endLabel}`;
  return startPeriod === endPeriod ? `${startClock}–${endClock} ${endPeriod}` : `${startLabel}–${endLabel}`;
}

function baseRow(id, sourceType, title) {
  return { id, sourceType, title, precision: 'unknown', startMinutes: null, endMinutes: null, startWhen: null, endWhen: null, crossesMidnight: false, autoLog: false };
}

/** A tomorrow one-off priority (already filtered to active/non-deleted by the caller, exactly as
 *  Tomorrow View's own computeViewData() already does). `when`/`durationMinutes` are read through
 *  the same validPlanItemTime/planItemEndTime authority Plan Tomorrow and Tomorrow View use —
 *  never a second parse of the raw string. */
export function normalizePriorityRow(item) {
  if (!item || typeof item !== 'object' || !item.id || typeof item.task !== 'string') return null;
  const row = baseRow(`priority:${item.id}`, 'priority', item.task);
  const when = typeof item.when === 'string' ? item.when : '';
  if (!validPlanItemTime(when)) return { ...row, precision: 'untimed' };
  const endWhen = planItemEndTime(when, item.durationMinutes);
  row.startWhen = when;
  row.startMinutes = toMinutes(when);
  if (endWhen) {
    row.endWhen = endWhen;
    row.endMinutes = toMinutes(endWhen);
    row.precision = 'ranged';
  } else {
    row.precision = 'start-only';
  }
  return row;
}

/** A tomorrow Daily Routine instance row from getPlanTomorrowRoutineSummary(), already filtered
 *  by the caller to `!skipped && actionable` — the exact same filter Tomorrow View's own
 *  "applicable routines" list applies. Only 'exact' and 'window' modes carry a factual clock
 *  position; 'cue' and 'anytime' are genuinely untimed (never fabricate a start for them). A mode
 *  claiming a clock time with malformed time fields (shouldn't happen given validateRoutine, but
 *  never trusted blindly here) degrades to 'unknown' rather than throwing or guessing. */
export function normalizeRoutineRow(row) {
  const routine = row && row.routine;
  if (!routine || typeof routine.title !== 'string' || !row.id) return null;
  const out = baseRow(`routine:${row.id}`, 'routine', routine.title);
  if (routine.mode === 'exact') {
    if (typeof routine.time !== 'string' || !ROUTINE_TIME_RE.test(routine.time)) return { ...out, precision: 'unknown' };
    out.startWhen = routine.time;
    out.startMinutes = toMinutes(routine.time);
    out.precision = 'start-only';
    return out;
  }
  if (routine.mode === 'window') {
    const validTimes = typeof routine.time === 'string' && ROUTINE_TIME_RE.test(routine.time)
      && typeof routine.endTime === 'string' && ROUTINE_TIME_RE.test(routine.endTime) && routine.endTime > routine.time;
    if (!validTimes) return { ...out, precision: 'unknown' };
    out.startWhen = routine.time;
    out.endWhen = routine.endTime;
    out.startMinutes = toMinutes(routine.time);
    out.endMinutes = toMinutes(routine.endTime);
    out.precision = 'ranged';
    return out;
  }
  // 'cue' and 'anytime' have no factual clock placement — real commitments, honestly untimed.
  return { ...out, precision: 'untimed' };
}

/** A tomorrow schedule Template occurrence, pre-reduced by the caller (tomorrow-view-ui.js) from
 *  index.html's generateTemplateEntries()'s epoch-ms `tsStart`/`ts` into account-timezone "HH:MM"
 *  strings via the same tzHHMM() the rest of the app uses for display — this module never touches
 *  epoch time or Intl itself. `autoLog` is the template's own stored configuration flag
 *  (tpl.autoLog): the only fact that may ever justify the "Scheduled auto-log" label. Templates
 *  are the one source allowed to cross midnight (10:00 PM–8:00 AM is a valid occurrence), signaled
 *  explicitly by the caller rather than inferred from which value looks numerically smaller. */
export function normalizeTemplateRow(entry) {
  if (!entry || typeof entry.activity !== 'string' || !entry.templateId) return null;
  const id = `template:${entry.templateId}:${entry.date || ''}`;
  const out = baseRow(id, 'template', entry.activity);
  out.autoLog = !!entry.autoLog;
  if (typeof entry.startWhen !== 'string' || !ROUTINE_TIME_RE.test(entry.startWhen)
    || typeof entry.endWhen !== 'string' || !ROUTINE_TIME_RE.test(entry.endWhen)) {
    return { ...out, precision: 'unknown' };
  }
  const startMinutes = toMinutes(entry.startWhen);
  const rawEndMinutes = toMinutes(entry.endWhen);
  const crossesMidnight = rawEndMinutes <= startMinutes;
  out.startWhen = entry.startWhen;
  out.endWhen = entry.endWhen;
  out.startMinutes = startMinutes;
  out.endMinutes = crossesMidnight ? rawEndMinutes + 1440 : rawEndMinutes;
  out.crossesMidnight = crossesMidnight;
  out.precision = 'ranged';
  return out;
}

function statusLabel(row) {
  if (row.sourceType === 'priority') return 'Planned priority';
  if (row.sourceType === 'routine') return 'Planned routine';
  return row.autoLog ? 'Scheduled auto-log' : 'Template hint';
}

function scheduleLabel(row) {
  if (row.precision === 'ranged') return formatRangeLabel(row.startWhen, row.endWhen);
  if (row.precision === 'start-only') return formatPlanItemTime(row.startWhen);
  return null;
}

/** The single derivation Tomorrow Timeline Preview renders from. Positioned rows (ranged or
 *  start-only) are ordered by clock start, ties broken by stable source-prefixed id — never by
 *  title, and never dependent on input array order (see tests: reverse input order must not
 *  change output order). Untimed/malformed rows are never silently dropped; they surface in
 *  `unscheduled`, still honestly labeled, just with no clock position. */
export function deriveTomorrowTimelinePreview({ priorityItems = [], routineRows = [], templateEntries = [] } = {}) {
  const rows = [
    ...priorityItems.map(normalizePriorityRow).filter(Boolean),
    ...routineRows.map(normalizeRoutineRow).filter(Boolean),
    ...templateEntries.map(normalizeTemplateRow).filter(Boolean)
  ];
  const positioned = rows
    .filter(row => row.precision === 'ranged' || row.precision === 'start-only')
    .map(row => ({ ...row, statusLabel: statusLabel(row), scheduleLabel: scheduleLabel(row) }))
    .sort((a, b) => (a.startMinutes - b.startMinutes) || compareStrings(a.id, b.id));
  const unscheduled = rows
    .filter(row => row.precision === 'untimed' || row.precision === 'unknown')
    .map(row => ({ ...row, statusLabel: statusLabel(row) }))
    .sort((a, b) => compareStrings(a.id, b.id));
  return { positioned, unscheduled };
}

const api = { normalizePriorityRow, normalizeRoutineRow, normalizeTemplateRow, deriveTomorrowTimelinePreview };
globalThis.TomorrowTimelineModel = api;
