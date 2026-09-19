import { classifyRoutineActual, clearPlanItemRange, durationBetween, formatPlanItemSchedule, isPriorityPlanItem, isSecondaryPlanItem, planItemEndTime, withPlanItemKind, reconciliationBucket, validPlanItemRange, validPlanItemTime } from './plan-tomorrow-model.js';
import { carryItemIdFor } from './plan-authority.js';
import { describeDayStart } from './personal-day-boundary-live.js';
import { generateInstances, matchCompletion, occursOn } from './daily-routines-model.js';
import { createDailyRoutineRepository } from './daily-routines-repository.js';
import { createLearningPlanRepository } from './learning-plan-repository.js';
import { findNextLearningPlanStep } from './learning-plan-next-action.js';
import { createLocalLifeLedgerStore } from './life-ledger-runtime.js';

const routineRepository = createDailyRoutineRepository();
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const root = document.getElementById('plan-tomorrow-overlay');
const body = document.getElementById('plan-tomorrow-body');
const error = document.getElementById('plan-tomorrow-error');
let draft = null;

function context() {
  if (typeof globalThis.getPlanTomorrowAppContext !== 'function') throw new Error('Plan Tomorrow is not available yet.');
  return globalThis.getPlanTomorrowAppContext();
}

function scheduleLabel(routine) {
  if (routine.mode === 'exact') return routine.time;
  if (routine.mode === 'window') return `${routine.time}–${routine.endTime}`;
  return routine.mode === 'cue' ? `Cue: ${routine.cue}` : 'Anytime';
}

/** The routine instances that belong to a PLAN TARGET (Decision A).
 *
 *  Instance identity stays [routineId, calendarDate] — nothing is migrated. For
 *  a legacy day this is exactly the old behavior: generate that date's
 *  instances, use them all. For a personal day, instances are generated for each
 *  calendar date the day touches and then filtered by ownership: a timed routine
 *  belongs to the day containing its own start, an untimed one to the day
 *  containing 12:00 on its date. A routine whose local clock reading is
 *  ambiguous or nonexistent (DST) is never guessed into a day — it is reported
 *  in `unplaceable` so the UI can say so. */
function routinePlan(target, timezone) {
  const state = routineRepository.read(timezone);
  if (state.timezone !== timezone) return { state, mismatch: true, rows: [], unplaceable: [] };
  const learningPlans = createLearningPlanRepository().listPlans();
  const decorate = instance => {
    const learningPlan = instance.routine.source === 'learning' ? learningPlans.find(plan => plan.id === instance.routine.planId) : null;
    const likelyNext = learningPlan ? findNextLearningPlanStep(learningPlan) : null;
    return { ...instance, skipped: !!state.skips[instance.id], actionable: instance.routine.source !== 'learning' || !!likelyNext, likelyNext };
  };
  if (target.store === 'legacy') {
    return { state, mismatch: false, rows: generateInstances(state.routines, target.dateKey, state.timezone).map(decorate), unplaceable: [] };
  }
  const authority = globalThis.PlanAuthority;
  const candidates = routineCandidateDates(target, state.timezone)
    .flatMap(date => generateInstances(state.routines, date, state.timezone));
  const { rows, unplaceable } = authority.routinesForTarget(target, candidates);
  return { state, mismatch: false, rows: rows.map(decorate), unplaceable };
}

/** The calendar dates whose instances could possibly belong to this personal
 *  day: the dates its interval touches, plus one either side, because an
 *  untimed routine is anchored at noon of its own date (which can sit inside a
 *  personal day that starts on the previous date) and a timed one can sit
 *  anywhere in the interval. Ownership is then decided per instance, never by
 *  this list. */
function routineCandidateDates(target, timezone) {
  const day = 86400000;
  const dates = new Set();
  for (let instant = target.startMs - day; instant <= target.endMs + day; instant += day) {
    dates.add(new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(instant)));
  }
  return [...dates].sort();
}

function activeItems() {
  return draft.items.filter(item => !item.deleted);
}

/** Planning Continuity V1 — the 3-cap, the Open-Day affordance and preparation
 *  are all measured on TOP PRIORITIES. Secondary planned tasks are uncapped and
 *  never earn preparation credit, so they are counted separately everywhere. */
function activePriorities() {
  return activeItems().filter(isPriorityPlanItem);
}

function activeSecondary() {
  return activeItems().filter(isSecondaryPlanItem);
}

function activeRoutines() {
  return draft.routines.rows.filter(row => !row.skipped && row.actionable);
}

/** Today's one-off priorities relevant to Daily Reconciliation: classified via the same
 *  classifyOneOffActual authority the Review "Plan vs Actual" widget already uses, then bucketed
 *  into completed/unfinished. Deleted-after-prep items ('removed') are excluded — nothing to
 *  reconcile once an item is gone. Routines are out of scope: they already recur/skip on their
 *  own cadence, and "carry forward" has no analog for them.
 *
 *  `failed: true` means classification could not be determined — kept distinct from a legitimate
 *  empty `rows` (nothing to reconcile) so the renderer never shows "0 unfinished" as if it were a
 *  fact when it's actually an abstention. Reconciliation is supplementary context for Plan
 *  Tomorrow, never a precondition for it: either way `openPlanTomorrow` still opens. */
function buildReconciliation() {
  const authority = globalThis.PlanAuthority;
  try {
    // Reconciles the CURRENT authoritative day — for a graveyard owner that is
    // their personal day in progress, not the calendar date on the wall.
    const current = authority.current();
    const preparation = authority.preparation(current);
    const rows = authority.rawItems(current)
      .filter(item => !item.deleted)
      .map(item => {
        const trackedMinutes = context().trackedMinutes(current, item.task, item.id);
        const status = authority.classifyItemActual(current, item, { trackedMinutes, preparedAt: preparation?.firstPreparedAt || 0, timezone: preparation?.timezone });
        return { item, status, bucket: reconciliationBucket(status) };
      })
      .filter(row => row.bucket !== 'excluded');
    return { source: current, rows, failed: false };
  } catch {
    return { source: null, rows: [], failed: true };
  }
}

/** The tomorrow-draft item (if any) already carrying this today item forward — looked up by the
 *  deterministic carriedItemId(todayKey, todayItemId), NOT by scanning for a matching
 *  carriedFromId. Determinism is what makes carrying converge across devices: two clients that
 *  independently carry the same source item before syncing both write to this exact same id, so
 *  the existing per-id mergeDatePlans/chooseItem merge (highest updatedAt wins) collapses them
 *  into one active item instead of two random-id survivors. */
function carriedItemFor(todayItemId) {
  const source = draft.reconciliation?.source;
  if (!source) return null;
  const id = carryItemIdFor(source, todayItemId, draft.target);
  const existing = draft.items.find(item => item.id === id);
  return existing && !existing.deleted ? existing : null;
}

function toggleCarry(todayItemId) {
  const row = draft.reconciliation?.rows.find(r => r.item.id === todayItemId);
  if (!row) return;
  const source = draft.reconciliation.source;
  const id = carryItemIdFor(source, todayItemId, draft.target);
  const existing = draft.items.find(item => item.id === id);
  if (existing && !existing.deleted) {
    draft.items = draft.items.map(item => item.id === id ? context().stampItem({ ...item, deleted: true }) : item);
    return;
  }
  if (activePriorities().length >= context().maxItems) throw new Error(`Reduce tomorrow's plan to ${context().maxItems} priorities before carrying this forward.`);
  // A fresh stamp (no updatedAt/updatedBy passed in) always gets the current Date.now(), which is
  // later than any prior tombstone on this same id — so re-carrying correctly supersedes an
  // earlier un-carry via the existing chooseItem "highest updatedAt wins" rule, no special case.
  const carried = context().stampItem({ id, task: row.item.task, when: '', done: false, doneAt: null, carriedFromId: todayItemId });
  draft.items = existing ? draft.items.map(item => item.id === id ? carried : item) : [...draft.items, carried];
  draft.intentionalBlank = false;
}

/** Reason-for-slipping is optional, free-text, and lives on TODAY's plan item — written straight
 *  through the same savePlanItems path Today's own UI already uses for done/delete, never through
 *  confirmPreparedDatePlan. That keeps it fully outside preparation/Planning-Streak semantics:
 *  recording or editing a reason can never make tomorrow look "prepared". */
function withReconciliationReason(item, reason) {
  const next = { ...item };
  if (reason) next.reconciliationReason = reason;
  else delete next.reconciliationReason;
  return next;
}

function saveReconciliationReason(todayItemId, reasonValue) {
  const reason = reasonValue.trim();
  const source = draft.reconciliation.source;
  const authority = globalThis.PlanAuthority;
  const updated = authority.rawItems(source).map(item =>
    item.id === todayItemId ? context().stampItem(withReconciliationReason(item, reason)) : item);
  authority.saveItems(source, updated);
  draft.reconciliation.rows = draft.reconciliation.rows.map(row =>
    row.item.id === todayItemId ? { ...row, item: withReconciliationReason(row.item, reason) } : row);
}

function formatTargetDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/** A legacy day is still named by its date. A personal day is named by the
 *  interval it actually is — "Wed Sep 16 18:00 → Thu Sep 17 18:00" — because
 *  calling it "Thursday" would be false for most of its hours. */
function targetHeading(target) {
  if (target.store === 'legacy') return formatTargetDate(target.dateKey);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: target.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fmt.format(new Date(target.startMs)).replace(',', '')} → ${fmt.format(new Date(target.endMs)).replace(',', '')}`;
}

/** Range validation for the day being edited: a legacy day keeps the existing
 *  midnight-clamped rule exactly; a personal day is checked against its own real
 *  interval, so 23:00 → 01:00 is ordinary there and 21:00 on a day truncated at
 *  20:00 is refused. */
function itemRangeValid(item) {
  const authority = globalThis.PlanAuthority;
  if (!authority || !draft) return validPlanItemRange(item.when, item.durationMinutes);
  return authority.validateItem(draft.target, item).ok;
}

function refreshRoutines() {
  draft.routines = routinePlan(draft.target, draft.timezone);
}

function suggestionRows() {
  const selected = new Set(activeItems().map(item => context().normalizeTask(item.task)));
  const suggestions = context().suggestions(draft.target).slice();
  const seen = new Set();
  return suggestions.filter(item => {
    const key = context().normalizeTask(item.task);
    if (!key || selected.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function routineHtml() {
  if (draft.routines.mismatch) return `<div class="pt-warning" role="status">Routines use ${escape(draft.routines.state.timezone)}; Today uses ${escape(draft.timezone)}. One-off planning is still available.</div>`;
  // A routine whose own clock reading is ambiguous or does not exist (a DST
  // change) is never filed into a day by guesswork — it is named here instead.
  const unplaceable = (draft.routines.unplaceable || []).length
    ? `<div class="pt-warning" role="status">${draft.routines.unplaceable.length} routine${draft.routines.unplaceable.length === 1 ? '' : 's'} can’t be placed in a personal day because of a clock change on ${escape(draft.routines.unplaceable.map(entry => entry.instance.date).join(', '))}. Plan them by hand.</div>`
    : '';
  if (!draft.routines.rows.length) return unplaceable + '<p class="pt-muted">No routines occur on this date.</p>';
  return unplaceable + draft.routines.rows.map(row => {
    const routine = row.routine;
    const detail = [`Target ${routine.targetMinutes} min`];
    if (routine.minimumMinutes) detail.push(`Minimum ${routine.minimumMinutes} min`);
    if (routine.fallback) detail.push(`Fallback: ${routine.fallback}`);
    return `<article class="pt-routine${row.skipped ? ' skipped' : ''}" data-pt-instance="${escape(row.id)}">
      <div><strong>${escape(routine.title)}</strong><div class="pt-muted">${escape(scheduleLabel(routine))} · ${escape(detail.join(' · '))}</div>
      ${routine.source === 'learning' ? `<div class="pt-learning">${row.likelyNext ? `Likely next: ${escape(row.likelyNext.stepTitle)}` : 'No unfinished Learning action'}</div>` : ''}</div>
      <button type="button" class="btn sm ghost" data-pt-action="${row.skipped ? 'unskip' : 'skip'}" data-id="${escape(row.id)}">${row.skipped ? 'Restore tomorrow' : 'Skip tomorrow'}</button>
    </article>`;
  }).join('');
}

// Faster Scheduling V1 — quick presets are UI convenience only; every choice (quick or custom)
// converges on the exact same stored fields (`when`, `durationMinutes`) via context().stampItem.
const QUICK_STARTS = [
  { label: '8 AM', value: '08:00' },
  { label: '9 AM', value: '09:00' },
  { label: '10 AM', value: '10:00' },
  { label: 'Noon', value: '12:00' },
  { label: '2 PM', value: '14:00' }
];
const QUICK_DURATIONS = [
  { label: '30m', value: 30 },
  { label: '1h', value: 60 },
  { label: '1.5h', value: 90 },
  { label: '2h', value: 120 }
];

/** Applies a new start to an item, dropping any existing duration the new start would make
 *  invalid (e.g. 09:00+2h -> 23:00 would run past midnight) in the SAME mutation — never leaves a
 *  hidden durationMinutes that could later resurrect a stale range. A duration that's still valid
 *  against the new start (e.g. 09:00+2h -> 10:00) is left untouched. */
function withNewStart(item, when) {
  const next = { ...item, when };
  return itemRangeValid(next) ? next : clearPlanItemRange(next);
}

function chipRowHtml({ id, labelId, options, current, action }) {
  const chips = options.map(opt => {
    const selected = current === opt.value;
    return `<button type="button" class="pt-chip${selected ? ' selected' : ''}" data-pt-action="${action}" data-id="${escape(id)}" data-value="${opt.value}" aria-pressed="${selected}">${escape(opt.label)}</button>`;
  }).join('');
  return `<div class="pt-chip-row" role="group" aria-labelledby="${labelId}">${chips}</div>`;
}

function schedulePanelHtml(item) {
  const timed = validPlanItemTime(item.when);
  const startLabelId = `pt-start-label-${escape(item.id)}`;
  const startRow = `<div class="pt-schedule-row">
    <span class="pt-schedule-label" id="${startLabelId}">Start</span>
    ${chipRowHtml({ id: item.id, labelId: startLabelId, options: QUICK_STARTS, current: item.when, action: 'quick-start' })}
    <label class="pt-schedule-custom">Custom <input type="time" class="pt-time-input" data-pt-time="${escape(item.id)}" aria-label="Custom start time for ${escape(item.task)}" value="${timed ? escape(item.when) : ''}"></label>
  </div>`;
  if (!timed) return `<div class="pt-schedule-panel" data-pt-schedule-panel="${escape(item.id)}">${startRow}</div>`;
  const lengthLabelId = `pt-length-label-${escape(item.id)}`;
  const endValue = planItemEndTime(item.when, item.durationMinutes) || '';
  const lengthRow = `<div class="pt-schedule-row">
    <span class="pt-schedule-label" id="${lengthLabelId}">Length</span>
    ${chipRowHtml({ id: item.id, labelId: lengthLabelId, options: QUICK_DURATIONS, current: item.durationMinutes, action: 'quick-duration' })}
    <label class="pt-schedule-custom">Custom end <input type="time" class="pt-end-input" data-pt-end="${escape(item.id)}" aria-label="Custom end time for ${escape(item.task)}" value="${escape(endValue)}"></label>
  </div>`;
  return `<div class="pt-schedule-panel" data-pt-schedule-panel="${escape(item.id)}">${startRow}${lengthRow}</div>`;
}

function scheduleControlHtml(item) {
  if (draft.schedulingId === item.id) return schedulePanelHtml(item);
  const timed = validPlanItemTime(item.when);
  if (!timed) {
    return `<button type="button" class="pt-time-link add" data-pt-action="edit-schedule" data-id="${escape(item.id)}" aria-label="Set time for ${escape(item.task)}">+ Add time</button>`;
  }
  const label = formatPlanItemSchedule(item);
  const ranged = !!planItemEndTime(item.when, item.durationMinutes);
  const rangeControl = ranged ? `<span aria-hidden="true"> · </span>
      <button type="button" class="pt-time-link" data-pt-action="remove-range" data-id="${escape(item.id)}" aria-label="Remove range for ${escape(item.task)}">Remove range</button>` : '';
  return `<span class="pt-time-value">${escape(label)}</span>
      <button type="button" class="pt-time-link" data-pt-action="edit-schedule" data-id="${escape(item.id)}" aria-label="Change time for ${escape(item.task)}">Change</button>
      ${rangeControl}
      <span aria-hidden="true"> · </span>
      <button type="button" class="pt-time-link" data-pt-action="remove-time" data-id="${escape(item.id)}" aria-label="Remove time for ${escape(item.task)}">Remove time</button>`;
}

function itemHtml() {
  const items = activePriorities();
  const overCap = items.length > context().maxItems;
  const rows = items.map(item => {
    const timed = validPlanItemTime(item.when);
    const legacyWhen = !timed && item.when ? `<span class="plan-when">${escape(item.when)} →</span> ` : '';
    return `<div class="pt-oneoff" data-pt-item="${escape(item.id)}">
      <div class="pt-oneoff-main">
        <div class="pt-oneoff-task">${legacyWhen}${escape(item.task)}</div>
        <div class="pt-oneoff-time">${scheduleControlHtml(item)}</div>
      </div>
      <button type="button" class="pt-kind" data-pt-action="kind" data-kind="task" data-id="${escape(item.id)}">Make task</button>
      <button type="button" class="plan-remove" data-pt-action="remove" data-id="${escape(item.id)}" title="Remove">✕</button>
    </div>`;
  }).join('');
  const add = items.length < context().maxItems ? `<form id="plan-tomorrow-add" class="pt-add"><input name="when" maxlength="40" placeholder="when (optional)"><input name="task" maxlength="80" placeholder="one priority"><button class="btn sm" type="submit">Add</button></form>` : '';
  const warning = overCap ? `<div class="pt-warning">${items.length} priorities arrived from synced devices. Nothing was deleted; reduce to ${context().maxItems} before confirming.</div>` : '';
  const suggestions = items.length < context().maxItems ? suggestionRows() : [];
  const chips = suggestions.length ? `<div class="pt-chips">${suggestions.map(item => `<button type="button" class="rv-plan-chip ${escape(item.tag)}" data-pt-action="suggest" data-task="${escape(item.task)}">${escape(item.task)}<span class="rv-chip-tag">${escape(item.tag)}</span></button>`).join('')}</div>` : '';
  return warning + (rows || '<p class="pt-muted">No one-off priorities yet.</p>') + add + chips;
}

/** Other planned tasks — real plan capacity with NO artificial cap. They never
 *  count against the Top 3 and never earn preparation/readiness credit, so this
 *  section has no counter against a maximum and no over-cap warning. */
function secondaryHtml() {
  const items = activeSecondary();
  const rows = items.map(item => {
    const timed = validPlanItemTime(item.when);
    const legacyWhen = !timed && item.when ? `<span class="plan-when">${escape(item.when)} →</span> ` : '';
    return `<div class="pt-oneoff pt-secondary" data-pt-item="${escape(item.id)}">
      <div class="pt-oneoff-main">
        <div class="pt-oneoff-task">${legacyWhen}${escape(item.task)}</div>
        <div class="pt-oneoff-time">${scheduleControlHtml(item)}</div>
      </div>
      <button type="button" class="pt-kind" data-pt-action="kind" data-kind="priority" data-id="${escape(item.id)}">Make priority</button>
      <button type="button" class="plan-remove" data-pt-action="remove" data-id="${escape(item.id)}" title="Remove">✕</button>
    </div>`;
  }).join('');
  const add = `<form id="plan-tomorrow-add-task" class="pt-add"><input name="when" maxlength="40" placeholder="when (optional)"><input name="task" maxlength="80" placeholder="another planned task"><button class="btn sm" type="submit">Add</button></form>`;
  return (rows || '<p class="pt-muted">Nothing else planned.</p>') + add;
}

function reconciliationHtml() {
  const reconciliation = draft.reconciliation;
  if (!reconciliation) return '';
  // Failed classification must never render as "nothing to reconcile" — that would silently claim
  // zero unfinished items when the truth is actually unknown. Show a neutral abstention instead,
  // with no rows, no reason boxes, and no carry controls (there is nothing safe to act on).
  if (reconciliation.failed) return '<section class="pt-reconcile"><p class="pt-muted" role="status">Today’s priorities couldn’t be reconciled right now. You can still plan tomorrow.</p></section>';
  if (!reconciliation.rows.length) return '';
  const unfinished = reconciliation.rows.filter(row => row.bucket === 'unfinished');
  const completed = reconciliation.rows.filter(row => row.bucket === 'completed');
  const unfinishedHtml = unfinished.map(row => {
    const carried = carriedItemFor(row.item.id);
    return `<div class="pt-reconcile-row pt-reconcile-unfinished" data-pt-reconcile-item="${escape(row.item.id)}">
      <div class="pt-reconcile-row-main">
        <div class="pt-reconcile-task">${escape(row.item.task)}</div>
        <textarea class="pt-reconcile-reason" data-pt-reason="${escape(row.item.id)}" maxlength="240" placeholder="Why did this slip? (optional)" aria-label="Why did &quot;${escape(row.item.task)}&quot; slip?">${escape(row.item.reconciliationReason || '')}</textarea>
      </div>
      <button type="button" class="btn sm ghost pt-reconcile-carry${carried ? ' selected' : ''}" data-pt-action="carry" data-id="${escape(row.item.id)}">${carried ? '✓ Carrying to tomorrow' : 'Carry to tomorrow'}</button>
    </div>`;
  }).join('');
  const completedHtml = completed.map(row => `<div class="pt-reconcile-row pt-reconcile-done">
      <div class="pt-reconcile-row-main"><div class="pt-reconcile-task"><span aria-hidden="true">✓ </span>${escape(row.item.task)}</div></div>
    </div>`).join('');
  return `<section class="pt-reconcile"><h3>Today <span>${unfinished.length} unfinished · ${completed.length} done</span></h3>${unfinishedHtml}${completedHtml}</section>`;
}

function renderNormal() {
  // Only priorities and routines make a day actionable — adding secondary tasks
  // must never remove the need to state an intention (or to choose Open day).
  const actionable = activeRoutines().length + activePriorities().filter(item => !item.done).length;
  return `<section><h3>Routines already included</h3>${routineHtml()}</section>
    <section><h3>Top priorities <span>${activePriorities().length}/${context().maxItems}</span></h3>${itemHtml()}</section>
    <section><h3>Other planned tasks${activeSecondary().length ? ` <span>${activeSecondary().length}</span>` : ''}</h3>${secondaryHtml()}</section>
    ${actionable ? '' : `<button type="button" class="btn ghost pt-open-day${draft.intentionalBlank ? ' selected' : ''}" data-pt-action="blank">${draft.intentionalBlank ? '✓ ' : ''}Open day / no commitments</button>`}`;
}

function renderRescue() {
  const routines = activeRoutines().length;
  const priorities = activePriorities().filter(item => !item.done).length;
  if (routines + priorities) return `<div class="pt-rescue"><h3>${routines || 'No'} routine${routines === 1 ? '' : 's'} · ${priorities || 'no'} priorit${priorities === 1 ? 'y' : 'ies'}</h3><p>Use this plan as it is. No additional scheduling decisions needed.</p>${draft.routines.mismatch ? routineHtml() : ''}</div>`;
  return `<div class="pt-rescue"><h3>Keep it minimal</h3><form id="plan-tomorrow-rescue-add" class="pt-add"><input name="task" maxlength="80" placeholder="one anytime priority"><button class="btn sm" type="submit">Add</button></form><span class="pt-or">or</span><button type="button" class="btn ghost pt-open-day${draft.intentionalBlank ? ' selected' : ''}" data-pt-action="blank">${draft.intentionalBlank ? '✓ ' : ''}Open day / no commitments</button></div>`;
}

// Set for the duration of body.innerHTML's own assignment below. Replacing markup that contains
// the currently-focused element (e.g. a just-clicked quick-pick chip) synchronously fires a
// focusout against that stale, about-to-be-removed node before the new markup is even inserted —
// indistinguishable, by target or relatedTarget alone, from a genuine "focus left the panel"
// click-away. The scheduling-panel focusout handler below checks this flag to ignore that
// self-inflicted event rather than misreading its own re-render as the user clicking away.
let rendering = false;

function render() {
  if (!draft || !body) return;
  rendering = true;
  try {
    // A legacy/never-enabled account keeps the existing "Tomorrow" wording
    // exactly; an account with an active personal day boundary is preparing
    // the next AUTHORITATIVE day, which is only sometimes calendar tomorrow —
    // "Plan next personal day" names what is actually being prepared.
    const usesPersonalDay = draft.target.store === 'operational';
    // Planning Continuity V1: when an ARBITRARY future day is being prepared, neither
    // 'tomorrow' nor 'next personal day' is true — name the day itself so the owner can
    // never be editing one day while the title claims another.
    document.getElementById('plan-tomorrow-title').textContent = draft.explicitDay
      ? `Plan ${draft.dayLabel}`
      : (usesPersonalDay ? 'Plan next personal day' : 'Plan tomorrow');
    document.getElementById('plan-tomorrow-date').textContent = targetHeading(draft.target);
    document.getElementById('plan-tomorrow-timezone').textContent = draft.target.store === 'operational' ? draft.target.timezone : draft.timezone;
    const startsEl = document.getElementById('plan-tomorrow-starts');
    if (startsEl) startsEl.textContent = usesPersonalDay ? describeDayStart(draft.target.startMs, draft.target.boundaryTime, draft.target.timezone, Date.now()) : '';
    const authority = globalThis.PlanAuthority;
    const readyNow = authority.readyNow(draft.target, draft.routines.rows);
    const consistency = authority.consistency(draft.target);
    const readiness = document.getElementById('plan-tomorrow-readiness');
    readiness.textContent = `${readyNow ? 'Ready now' : 'Not ready'} · ${consistency === 'ahead' ? 'prepared ahead' : consistency === 'late' ? 'prepared late' : consistency === 'unknown' ? 'preparation unknown' : 'not prepared'}`;
    readiness.dataset.ready = String(readyNow);
    document.querySelectorAll('[data-pt-mode]').forEach(button => button.classList.toggle('selected', button.dataset.ptMode === draft.mode));
    body.innerHTML = reconciliationHtml() + (draft.mode === 'rescue' ? renderRescue() : renderNormal());
    document.getElementById('plan-tomorrow-confirm').textContent = draft.mode === 'rescue' ? 'Use this plan' : (usesPersonalDay ? 'Next personal day is ready' : 'Tomorrow is ready');
    error.textContent = '';
    if (draft.schedulingId) body.querySelector(`[data-pt-schedule-panel="${draft.schedulingId}"] .pt-time-input`)?.focus();
  } finally {
    rendering = false;
  }
}

/** "Tomorrow" is the UPCOMING AUTHORITATIVE DAY. For a legacy account that is
 *  tomorrow's calendar date exactly as before; for a graveyard owner at 08:00
 *  with an 18:00 boundary it is the personal day that begins at 18:00 today —
 *  which is why this no longer computes a date of its own. */
/** Prepares a personal day. With no argument that is the UPCOMING day, exactly as
 *  before. Planning Continuity V1 adds an explicit `target`, so an arbitrary FUTURE
 *  personal day is prepared through this SAME workflow — deliberately reusing the one
 *  preparation surface rather than adding a second editor, which is the defect Single
 *  Plan Authority V1 exists to prevent. */
/** The day being prepared, named by its real interval (index.html's own
 *  planTargetLabel when available, which is what every other surface uses). */
function planTargetDayLabel(target) {
  if (typeof globalThis.planTargetLabel === 'function') return globalThis.planTargetLabel(target);
  return target.store === 'legacy' ? target.dateKey : new Date(target.startMs).toISOString().slice(0, 10);
}

export function openPlanTomorrow({ returnToReview = false, target: explicitTarget = null } = {}) {
  try {
    const app = context();
    const authority = globalThis.PlanAuthority;
    if (!authority) throw new Error('Planning is still loading.');
    const target = explicitTarget || authority.upcoming();
    const preparation = authority.preparation(target);
    draft = {
      target,
      explicitDay: !!explicitTarget,
      dayLabel: explicitTarget ? planTargetDayLabel(explicitTarget) : '',
      returnToReview,
      timezone: app.timezone,
      items: authority.rawItems(target).map(item => ({ ...item })),
      routines: routinePlan(target, app.timezone),
      mode: 'normal',
      intentionalBlank: preparation?.intentionalBlank || false,
      schedulingId: null,
      // Daily Reconciliation compares TODAY against the day being prepared next. For an
      // arbitrary future day there is no such relationship, so it is omitted rather
      // than shown against the wrong day.
      reconciliation: explicitTarget ? null : buildReconciliation()
    };
    root.classList.add('open');
    render();
  } catch (err) {
    globalThis.showToast(err.message);
  }
}

function closePreparation() {
  root.classList.remove('open');
  if (draft?.returnToReview) {
    globalThis.renderReviewTomorrowStatus();
    document.getElementById('review-overlay').classList.add('open');
  }
}

/** "Make task" / "Make priority" inside the preparation draft. Only kind changes; the
 *  id and every other field are kept. Promotion into a full Top 3 is refused, never a
 *  silent swap. */
function setDraftItemKind(itemId, kind) {
  const current = draft.items.find(item => item.id === itemId && !item.deleted);
  if (!current) throw new Error('That item is no longer in this plan.');
  if (kind === 'priority' && activePriorities().filter(item => item.id !== itemId).length >= context().maxItems) {
    throw new Error('Your Top ' + context().maxItems + ' is already full. Remove or demote one first.');
  }
  draft.items = draft.items.map(item => (item.id === itemId ? context().stampItem(withPlanItemKind(item, kind)) : item));
}

function addItem(task, when = '', kind = 'priority') {
  if (kind === 'priority' && activePriorities().length >= context().maxItems) {
    throw new Error(`${context().maxItems} priorities is the cap — add it under Other planned tasks instead.`);
  }
  draft.items.push(context().createItem(task, when, kind));
  // A secondary task is not an intention, so it must not silently clear an
  // explicit Open Day choice the way adding a priority does.
  if (kind === 'priority') draft.intentionalBlank = false;
}

async function confirmDraft() {
  const unfinishedItems = activePriorities().filter(item => !item.done);
  const routines = activeRoutines();
  if (activePriorities().length > context().maxItems) throw new Error(`Reduce the plan to ${context().maxItems} priorities before confirming.`);
  const intentionalBlank = routines.length + unfinishedItems.length === 0 && draft.intentionalBlank;
  if (!routines.length && !unfinishedItems.length && !intentionalBlank) throw new Error('Add one priority, keep a routine, or choose Open day.');
  const authority = globalThis.PlanAuthority;
  const result = authority.confirmPreparation(draft.target, {
    items: draft.items.map(item => ({ ...item })),
    mode: draft.mode,
    intentionalBlank,
    routineInstanceIds: draft.routines.rows.filter(row => row.actionable).map(row => row.id),
    actionableRoutineInstanceIds: routines.map(row => row.id)
  });
  if (!result.localSaved || !authority.readyNow(draft.target, routines)) throw new Error('Tomorrow could not be marked ready. Your draft is still open.');
  closePreparation();
  const cloudSynced = await Promise.resolve(result.syncPromise).catch(() => false);
  if (!cloudSynced) globalThis.showToast('Ready on this device');
}

root?.addEventListener('click', async event => {
  if (event.target === root) { closePreparation(); return; }
  const control = event.target.closest('[data-pt-action], [data-pt-mode]');
  if (!control || !draft) return;
  try {
    if (control.dataset.ptMode) { draft.mode = control.dataset.ptMode; render(); return; }
    const action = control.dataset.ptAction;
    if (action === 'close') { closePreparation(); return; }
    if (action === 'blank') { draft.intentionalBlank = !draft.intentionalBlank; render(); return; }
    if (action === 'kind') setDraftItemKind(control.dataset.id, control.dataset.kind);
    if (action === 'remove') draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem({ ...item, deleted: true }) : item);
    if (action === 'edit-schedule') draft.schedulingId = control.dataset.id;
    if (action === 'remove-time') {
      draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem(clearPlanItemRange({ ...item, when: '' })) : item);
      draft.schedulingId = null;
    }
    if (action === 'remove-range') {
      draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem(clearPlanItemRange(item)) : item);
    }
    if (action === 'quick-start') {
      draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem(withNewStart(item, control.dataset.value)) : item);
    }
    if (action === 'quick-duration') {
      // Validate BEFORE touching draft state: an invalid pick (e.g. 23:00 + 2h crossing midnight)
      // must never overwrite the last-known-good duration, even transiently — see Blocker 1.
      const value = Number(control.dataset.value);
      const target = draft.items.find(item => item.id === control.dataset.id);
      if (!target || !itemRangeValid({ ...target, durationMinutes: value })) {
        throw new Error(draft.target.store === 'operational'
          ? 'That length would run past the end of this personal day. Choose a shorter length.'
          : 'That length would run past midnight. Choose a shorter length.');
      }
      draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem({ ...item, durationMinutes: value }) : item);
      draft.schedulingId = null;
    }
    if (action === 'suggest') addItem(control.dataset.task);
    if (action === 'carry') toggleCarry(control.dataset.id);
    if (action === 'skip' || action === 'unskip') {
      routineRepository.setDateSkip(draft.routines.state.timezone, control.dataset.id, action === 'skip');
      refreshRoutines();
      if (action === 'unskip') draft.intentionalBlank = false;
    }
    if (action === 'confirm') { await confirmDraft(); return; }
    render();
  } catch (err) { error.textContent = err.message; }
});

root?.addEventListener('change', event => {
  const input = event.target.closest('.pt-time-input');
  if (!input || !draft) return;
  const id = input.dataset.ptTime;
  draft.items = draft.items.map(item => item.id === id ? context().stampItem(withNewStart(item, input.value)) : item);
  draft.schedulingId = null;
  render();
});

// Custom end time is picked as an exact clock time (a second native time input, never a raw
// minutes field) and converted to the stored durationMinutes here — the only place that
// conversion happens, so quick-duration chips and this custom path always converge on the same
// field. An empty value means "backed out without choosing" and is left alone, not an error.
root?.addEventListener('change', event => {
  const input = event.target.closest('.pt-end-input');
  if (!input || !draft || !input.value) return;
  const id = input.dataset.ptEnd;
  const item = draft.items.find(i => i.id === id);
  try {
    const duration = item ? durationBetween(item.when, input.value) : null;
    if (!duration) throw new Error('End time must be later than the start, on the same day.');
    if (!itemRangeValid({ ...item, durationMinutes: duration })) {
      throw new Error(draft.target.store === 'operational'
        ? 'End time must be within 12 hours of the start, inside this personal day.'
        : 'End time must be within 12 hours of the start.');
    }
    draft.items = draft.items.map(i => i.id === id ? context().stampItem({ ...i, durationMinutes: duration }) : i);
    draft.schedulingId = null;
    render();
  } catch (err) { error.textContent = err.message; }
});

root?.addEventListener('change', event => {
  const textarea = event.target.closest('.pt-reconcile-reason');
  if (!textarea || !draft?.reconciliation) return;
  try { saveReconciliationReason(textarea.dataset.ptReason, textarea.value); }
  catch (err) { error.textContent = err.message; }
});

// Focus moving to a sibling control inside the same scheduling panel (a quick-pick button, the
// other native input) must not collapse it out from under an in-progress click; only focus
// actually leaving the panel closes it, mirroring the prior single-input "click away" behavior.
root?.addEventListener('focusout', event => {
  if (rendering) return; // our own re-render detached the focused node — not a real click-away
  const panel = event.target.closest('[data-pt-schedule-panel]');
  if (!panel || !draft || draft.schedulingId !== panel.dataset.ptSchedulePanel) return;
  if (event.relatedTarget && panel.contains(event.relatedTarget)) return;
  draft.schedulingId = null;
  render();
});

root?.addEventListener('submit', event => {
  if (!event.target.matches('#plan-tomorrow-add, #plan-tomorrow-rescue-add, #plan-tomorrow-add-task')) return;
  event.preventDefault();
  const kind = event.target.id === 'plan-tomorrow-add-task' ? 'task' : 'priority';
  try {
    const data = new FormData(event.target);
    const task = String(data.get('task') || '').trim();
    if (!task) throw new Error(kind === 'task' ? 'Name the task first.' : 'Name the priority first.');
    addItem(task, String(data.get('when') || '').trim(), kind);
    render();
  } catch (err) { error.textContent = err.message; }
});

export function getPlanTomorrowRoutineSummary(target, timezone = context().timezone) {
  return routinePlan(target, timezone);
}

/** Each row's own calendar date comes from the instance id it was prepared
 *  under ([routineId, date]), not from a single date passed in — that is what
 *  lets a personal day's preparation, whose routines can span two calendar
 *  dates, reconcile each one against the date it actually occurs on. For a
 *  legacy preparation every id carries the same date, so this is identical to
 *  the previous behavior. */
export function getPlanTomorrowRoutineActual(preparation) {
  const state = routineRepository.read(context().timezone);
  const timezone = preparation.timezone || state.timezone;
  const entries = context().entries;
  const events = createLocalLifeLedgerStore().listEvents();
  const ids = new Set(preparation.routineInstanceIds);
  return preparation.routineInstanceIds.map(id => {
    let routineId;
    let instanceDate;
    try { [routineId, instanceDate] = JSON.parse(id); } catch { return { id, title: 'Unknown routine', status: 'removed' }; }
    const routine = state.routines.find(item => item.id === routineId);
    const occurs = !!routine && state.timezone === timezone && routine.enabled && occursOn(routine, instanceDate);
    if (!occurs) return { id, title: routine?.title || 'Removed routine', status: 'removed' };
    const instance = generateInstances([routine], instanceDate, state.timezone)[0];
    const completion = matchCompletion(instance, { ...state, events, entries }, Date.now());
    return { id, title: routine.title, taskLabel: state.links[id]?.stepTitle || routine.title, status: classifyRoutineActual({ occurs, skipped: !!state.skips[id], completion }) };
  }).filter(row => ids.has(row.id));
}

globalThis.openPlanTomorrow = openPlanTomorrow;
globalThis.getPlanTomorrowRoutineSummary = getPlanTomorrowRoutineSummary;
globalThis.getPlanTomorrowRoutineActual = getPlanTomorrowRoutineActual;
