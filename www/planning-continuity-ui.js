// planning-continuity-ui.js
//
// Planning Continuity V1 — the three read/act surfaces that make future planning and
// stale-task recovery reachable:
//
//   1. Upcoming                      scheduled commitments ahead of now
//   2. Plan another day              browse + prepare arbitrary future personal days
//   3. Unfinished from previous days  discover and recover stale planned tasks
//
// Plus the commitment form (title / date / optional time / timezone / optional
// duration / optional note).
//
// ── what this file deliberately is NOT ──────────────────────────────────────
// Not a calendar clone. No month grid, no recurrence engine, no reminders, no
// external calendar sync. A commitment is entered by real date and time; a whole day
// is prepared by selecting a personal-day interval from a labelled list.
//
// ── no temporal derivation here ─────────────────────────────────────────────
// Every "which day owns this?", "is this time valid?" and "what is stale?" question
// is answered by a pure model (commitments-model.js, stale-plan-recovery-model.js)
// through Plan Authority. This file formats and dispatches; it never computes a
// boundary, a projection or an instant of its own. That is what keeps the contract
// reviewable in one place instead of spread through render code.

import './plan-authority.js';
import './task-completion-sync.js';
import {
  activeCommitments, upcomingCommitments, commitmentsForTarget,
  formatCommitmentTime, normalizeCommitment,
} from './commitments-model.js';
import { addCalendarDays, durationBetween, planItemEndTime } from './plan-tomorrow-model.js';
import { fencedMoveRefusal, isFencedItem } from './plan-item-origin.js';
import { sameOnWire } from './plan-fence-sync.js';

const SECTION_ID = 'planning-continuity-section';
/** How many rows each list renders before "Show all". A DISPLAY bound only — the
 *  projections behind these lists are deliberately unbounded, so nothing becomes
 *  undiscoverable just because it is old or far ahead. */
const PREVIEW_ROWS = 5;
/** How many future personal days the browser offers at once. */
const BROWSE_DAYS = 14;

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const state = {
  expanded: { upcoming: false, stale: false, completed: false },
  staleOffset: 0,
  completedLimit: PREVIEW_ROWS,  // O1: how many resolved tasks the durable Undo list shows
  staleOwner: null,
  staleUndo: null,     // session-only receipt for ONE exact dismissal, never a task store
  staleStatus: '',
  detail: null,
  itemForm: null,      // task: { type, dayId?, anchorDayId, itemId?, dateTouched }
  browseOpen: false,
  browseFrom: 0,
  formOpen: false,
  formError: '',
  formPending: null,   // a DST-ambiguous submission awaiting an explicit choice
  selectedDayId: null,
  notice: null,        // { text, tone } — the recovery actions' one status line
};

function authority() {
  return typeof window !== 'undefined' ? window.PlanAuthority : null;
}

function repository() {
  return typeof window !== 'undefined' ? window.CommitmentsRepository : null;
}

/** The real device id, for commitment provenance. Same source every other sync layer
 *  uses; falls back only when the app context has not loaded yet. */
function deviceId() {
  return appContext()?.deviceId || 'unknown-device';
}

function sync() {
  return typeof window !== 'undefined' ? window.CommitmentsSync : null;
}

function section() {
  return typeof document !== 'undefined' ? document.getElementById(SECTION_ID) : null;
}

function staleSection() {
  return typeof document !== 'undefined' ? document.getElementById('unfinished-recovery-section') : null;
}

/** index.html's own app context — the SAME accessor plan-authority.js composes. Used
 *  rather than reaching for globals because index.html declares its state with
 *  top-level let bindings (settings, syncedDeviceId), which are deliberately NOT on
 *  window; reading globalThis.settings would silently fall back to the machine zone. */
function appContext() {
  return typeof globalThis.getOperationalPlanAppContext === 'function'
    ? globalThis.getOperationalPlanAppContext()
    : null;
}

function accountTimezone() {
  return appContext()?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function allCommitments() {
  const repo = repository();
  if (!repo) return [];
  try { return Object.values(repo.listAllRaw()); } catch { return []; }
}

// ── labels ──────────────────────────────────────────────────────────────────

/** A personal day's real interval, in its own zone — the SAME shape
 *  operational-plan-ui.js uses, so the two never name a day differently. */
function dayWindowLabel(target) {
  if (!target) return '';
  if (target.store !== 'operational') return formatCalendarDate(target.dateKey);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: target.timezone, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  const label = ms => fmt.format(new Date(ms)).replace(/^([A-Za-z]{3}), /, '$1 ');
  return `${label(target.startMs)} → ${label(target.endMs)}`;
}

function formatCalendarDate(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  if (!year || !month || !day) return String(dateKey);
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/** A commitment's date + time for display. A date-only commitment shows its DATE
 *  ONLY: formatCommitmentTime returns null for it, because the noon ownership anchor
 *  is machinery and must never surface as an appointment time. */
function commitmentLabel(record) {
  const time = formatCommitmentTime(record);
  const date = formatCalendarDate(record.date);
  return time ? `${date} · ${time}` : `${date} · no time set`;
}

// ── Upcoming ────────────────────────────────────────────────────────────────

function upcomingHtml(nowMs) {
  const all = upcomingCommitments(allCommitments(), nowMs);
  const shown = state.expanded.upcoming ? all : all.slice(0, PREVIEW_ROWS);
  const rows = shown.map(record => {
    const zoneNote = record.timezone !== accountTimezone() ? `<span class="pc-zone">${escape(record.timezone)}</span>` : '';
    const note = record.note ? `<div class="pc-note">${escape(record.note)}</div>` : '';
    return `<div class="pc-row" data-pc-commitment="${escape(record.id)}">
      <div class="pc-row-main">
        <div class="pc-row-title">${escape(record.title)}</div>
        <div class="pc-row-meta">${escape(commitmentLabel(record))}${zoneNote}</div>
        ${note}
      </div>
      <button type="button" class="pc-icon" data-pc-action="edit-commitment" data-id="${escape(record.id)}" aria-label="Edit ${escape(record.title)}">Edit</button>
      <button type="button" class="pc-icon danger" data-pc-action="delete-commitment" data-id="${escape(record.id)}" aria-label="Delete ${escape(record.title)}">✕</button>
    </div>`;
  }).join('');
  const more = all.length > shown.length
    ? `<button type="button" class="pc-more" data-pc-action="expand-upcoming">Show all ${all.length}</button>`
    : (state.expanded.upcoming && all.length > PREVIEW_ROWS
      ? '<button type="button" class="pc-more" data-pc-action="collapse-upcoming">Show fewer</button>' : '');
  return `<section class="pc-block">
    <div class="pc-head">
      <h3>Upcoming</h3>
      <button type="button" class="btn sm" data-pc-action="open-form">Add commitment</button>
    </div>
    ${rows || '<p class="pc-muted">No scheduled commitments ahead.</p>'}
    ${more}
  </section>`;
}

// ── commitment form ─────────────────────────────────────────────────────────

function commitmentFormHtml() {
  const editing = state.formOpen !== true ? normalizeCommitment(repository()?.read(state.formOpen)) : null;
  const zone = editing?.timezone || accountTimezone();
  const pending = state.formPending;
  // An AMBIGUOUS local time (the repeated hour when clocks go back) is never
  // resolved for the owner — they choose which of the two real instants they meant.
  const dstChoice = pending
    ? `<div class="pc-dst" role="alert">
        <p>That clock time happens twice on ${escape(formatCalendarDate(pending.date))} in ${escape(pending.timezone)}. Which one?</p>
        <button type="button" class="btn sm" data-pc-action="dst-earlier">First (earlier)</button>
        <button type="button" class="btn sm" data-pc-action="dst-later">Second (later)</button>
      </div>`
    : '';
  return `<form class="pc-form" id="pc-commitment-form">
    <input name="title" maxlength="200" placeholder="what is it?" value="${escape(editing?.title || '')}" required>
    <div class="pc-form-row">
      <input name="date" type="date" value="${escape(editing?.date || localDateKey())}" required aria-label="date">
      <input name="time" type="time" value="${escape(editing?.time || '')}" aria-label="time (optional)">
    </div>
    <div class="pc-form-row">
      <input name="timezone" maxlength="64" value="${escape(zone)}" aria-label="timezone">
      <input name="durationMinutes" type="number" min="5" max="720" step="5" placeholder="mins (optional)" value="${escape(editing?.durationMinutes ?? '')}" aria-label="duration in minutes (optional)">
    </div>
    <input name="note" maxlength="240" placeholder="note (optional)" value="${escape(editing?.note || '')}">
    <p class="pc-muted pc-hint">Leave the time blank for a date-only commitment.</p>
    ${dstChoice}
    ${state.formError ? `<p class="pc-error" role="alert">${escape(state.formError)}</p>` : ''}
    <div class="pc-form-actions">
      <button type="submit" class="btn sm">${editing ? 'Save' : 'Add'}</button>
      <button type="button" class="btn sm ghost" data-pc-action="close-form">Cancel</button>
    </div>
  </form>`;
}

function localDateKey(instantMs = Date.now(), timezone = accountTimezone()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(instantMs)).reduce((out, part) => (out[part.type] = part.value, out), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function taskDateHint(target, when = '') {
  const layer = authority();
  if (!target) return localDateKey();
  const scheduled = layer?.scheduledDateForTarget(target, when);
  // A truncated My Day may have no date-only/noon inverse. Its start date is a
  // presentation hint only; the untouched form remains anchored to the target.
  return scheduled || (Number.isFinite(target.startMs)
    ? localDateKey(target.startMs, target.timezone || accountTimezone())
    : target.dateKey || localDateKey());
}

function quickTaskTargets() {
  const layer = authority();
  const today = layer?.current();
  const tomorrow = today ? layer.next(today) : null;
  return {
    today: { target: today, date: taskDateHint(today) },
    tomorrow: { target: tomorrow, date: taskDateHint(tomorrow) },
  };
}

function taskFormValue() {
  const layer = authority();
  const quick = quickTaskTargets();
  const sourceTarget = state.itemForm?.itemId && layer ? layer.targetById(state.itemForm.dayId) : null;
  const item = sourceTarget ? layer.items(sourceTarget).find(candidate => candidate.id === state.itemForm.itemId) : null;
  const anchorTarget = (state.itemForm?.anchorDayId && layer?.targetById(state.itemForm.anchorDayId))
    || sourceTarget || quick.today.target;
  const date = item && anchorTarget?.id === sourceTarget?.id
    ? sourceTarget?.store === 'calendar' && item.whenDayOffset === 1
      ? addCalendarDays(sourceTarget.dateKey, 1)
      : taskDateHint(sourceTarget, item.when || '')
    : taskDateHint(anchorTarget);
  const endTime = item ? planItemEndTime(item.when, item.durationMinutes, sourceTarget?.store === 'calendar') || '' : '';
  return { sourceTarget, anchorTarget, item, date, endTime, quick };
}

function taskFormHtml() {
  const { item, date, endTime, quick } = taskFormValue();
  const kind = item?.kind === 'task' ? 'task' : 'priority';
  // A Brain Dump or ChatGPT-added task stays on the day it was created in (plan-item-origin.js): its date is shown, not offered.
  const pinned = isFencedItem(item);
  return `<form class="pc-form pc-item-form" id="pc-task-form">
    <div class="pc-head"><h3>${item ? 'Edit planned task' : 'Add to My Day'}</h3><button type="button" class="pc-icon" data-pc-action="close-item-form" aria-label="Close add task">✕</button></div>
    ${item ? '' : `<div class="pc-entry-types" role="group" aria-label="What to add"><button type="button" class="btn sm primary" aria-pressed="true">Task</button><button type="button" class="btn sm ghost" data-pc-action="add-commitment" aria-pressed="false">Commitment</button></div>`}
    <label>What do you want to do?<input name="title" maxlength="200" value="${escape(item?.task || '')}" required autofocus></label>
    <fieldset class="pc-when"><legend>When?</legend>${pinned ? '' : `<div class="pc-quick-dates">
      <button type="button" class="btn sm ghost" data-pc-action="set-date" data-day="${escape(quick.today.target?.id || '')}" data-date="${escape(quick.today.date)}">Today</button>
      <button type="button" class="btn sm ghost" data-pc-action="set-date" data-day="${escape(quick.tomorrow.target?.id || '')}" data-date="${escape(quick.tomorrow.date)}">Tomorrow</button>
    </div>`}<input name="date" type="date" value="${escape(date)}" required aria-label="Task date"${pinned ? ' readonly' : ''}>${pinned ? `<p class="pc-muted pc-hint">${escape(fencedMoveRefusal(item))}</p>` : ''}</fieldset>
    <div class="pc-form-row"><label>Start <input name="time" type="time" value="${escape(item?.when || '')}" aria-label="Task start time, optional"></label><label>End <input name="endTime" type="time" value="${escape(endTime)}" aria-label="Task end time, optional"></label></div>
    <p class="pc-muted pc-hint">Leave Start blank for Anytime. End is optional; an earlier End continues after midnight.</p>
    <label>Type <select name="kind"><option value="priority"${kind === 'priority' ? ' selected' : ''}>Top Priority</option><option value="task"${kind === 'task' ? ' selected' : ''}>Other task</option></select></label>
    ${state.formError ? `<p class="pc-error" role="alert">${escape(state.formError)}</p>` : ''}
    <div class="pc-form-actions"><button type="submit" class="btn sm primary">${item ? 'Save' : 'Add'}</button><button type="button" class="btn sm ghost" data-pc-action="close-item-form">Cancel</button></div>
  </form>`;
}

/** Task-form failures re-render from canonical item/anchor state, so the
 *  scheduling mode must reset with the visible date hint. Keeping
 *  dateTouched=true here would make the hint act like an explicit reschedule. */
function refuseTaskForm(message) {
  state.formError = message;
  if (state.itemForm?.type === 'task') state.itemForm.dateTouched = false;
}

function submitTaskForm(form) {
  const layer = authority();
  const context = appContext();
  if (!layer || !context) { refuseTaskForm('Your plan is still loading.'); return; }
  const data = new FormData(form);
  const title = String(data.get('title') || '').trim();
  const date = String(data.get('date') || '');
  const time = String(data.get('time') || '');
  const endTime = String(data.get('endTime') || '');
  const kind = data.get('kind') === 'task' ? 'task' : 'priority';
  if (!title) { refuseTaskForm('Name the task first.'); return; }
  const editing = taskFormValue();
  // Untouched dates preserve the selected authoritative My Day. A typed time is
  // interpreted inside that target; only a user-edited civil date uses the
  // date/noon scheduling contract and may relocate the item.
  const resolved = state.itemForm?.dateTouched
    ? layer.dayForScheduledDate(date, time)
    : time ? layer.civilDateForTimeInTarget(editing.anchorTarget, time)
      : { ok: true, anchor: 'target', target: editing.anchorTarget };
  if (!resolved.ok) {
    refuseTaskForm(resolved.reason === 'ambiguous' ? 'That time happens twice on this date. Choose a different time.'
      : resolved.reason === 'nonexistent' ? 'That time does not exist on this date. Choose a different time.'
        : resolved.reason === 'outside-target' ? 'That time is outside this My Day. Pick a date to schedule it on another day.'
          : 'Choose a valid date.');
    return;
  }
  // A location-bound task never changes plan. Refused before anything is written, so no source or destination copy can exist.
  if (editing.item && isFencedItem(editing.item) && editing.sourceTarget
    && (resolved.target.store !== editing.sourceTarget.store || resolved.target.id !== editing.sourceTarget.id)) { refuseTaskForm(fencedMoveRefusal(editing.item)); return; }
  if (endTime && !time) { refuseTaskForm('Choose a Start before setting an End.'); return; }
  const durationMinutes = endTime ? durationBetween(time, endTime, resolved.target.store === 'calendar') : null;
  if (endTime && !durationMinutes) { refuseTaskForm('End must be later than Start or continue into the next calendar date.'); return; }
  if (durationMinutes > 720) { refuseTaskForm('End must be within 12 hours of Start.'); return; }
  const changes = { task: title, when: time, durationMinutes, kind };
  if (time && resolved.target.store === 'calendar') {
    const nextDate = addCalendarDays(resolved.target.dateKey, 1);
    if (date === resolved.target.dateKey) changes.whenDayOffset = 0;
    else if (date === nextDate) changes.whenDayOffset = 1;
    else { refuseTaskForm('That time is outside this calendar plan. Choose Today or Tomorrow again.'); return; }
  }
  try {
    if (state.itemForm?.itemId) {
      layer.updateItem({ sourceTarget: editing.sourceTarget, itemId: state.itemForm.itemId, destination: resolved.target, changes, stamp: stamp });
    } else {
      const item = { ...context.createItem(title, time, kind), ...(durationMinutes ? { durationMinutes } : {}) };
      layer.addItem({ destination: resolved.target, item });
    }
    state.itemForm = null;
    state.formError = '';
    globalThis.refreshAuthoritativePlanSurfaces?.();
  } catch (err) { refuseTaskForm(err.message); }
}

function readForm(form) {
  const data = new FormData(form);
  const raw = key => String(data.get(key) || '').trim();
  const duration = raw('durationMinutes');
  const time = raw('time');
  return {
    title: raw('title'),
    date: raw('date'),
    time: time || null,
    precision: time ? 'timed' : 'date',
    timezone: raw('timezone') || accountTimezone(),
    updatedBy: deviceId(),
    // null means CLEAR, which is distinct from undefined (leave unchanged) in
    // updateCommitment. The form always shows every field, so a blank field is an
    // explicit clear; sending undefined here silently kept the old duration/note.
    durationMinutes: duration ? Number(duration) : null,
    note: raw('note') || null,
  };
}

/** Turns a model refusal into something a person can act on. The DST cases are not
 *  errors to be papered over — `nonexistent` means the owner named a clock time that
 *  does not exist, and only they can say what they actually meant. */
function describeRefusal(result) {
  if (result.reason === 'nonexistent') {
    return `That clock time does not exist on that date in that timezone — the clocks jump forward ${result.gapMinutes} minutes. Choose another time.`;
  }
  if (result.reason === 'ambiguous') return 'That clock time happens twice that day. Choose which one you meant.';
  if (result.reason === 'invalid-input') {
    const field = result.field === 'now' || result.field === 'updatedBy' ? 'app state' : result.field;
    return `Check the ${field}.`;
  }
  if (result.reason === 'not-found') return 'That commitment no longer exists.';
  return 'That commitment could not be saved.';
}

function submitCommitmentForm(form) {
  const repo = repository();
  if (!repo) { state.formError = 'Commitments are still loading.'; return; }
  const input = readForm(form);
  if (!input.title) { state.formError = 'Name the commitment first.'; return; }
  if (!input.date) { state.formError = 'Choose a date.'; return; }
  const editingId = state.formOpen !== true ? state.formOpen : null;
  const result = editingId ? repo.update(editingId, input) : repo.create(input);
  if (!result.ok) {
    if (result.reason === 'ambiguous') state.formPending = { ...input, editingId };
    state.formError = describeRefusal(result);
    return;
  }
  afterCommitmentWrite(result.record.id);
}

/** Re-submits a previously ambiguous commitment with the owner's explicit choice. */
function resolveAmbiguous(choice) {
  const repo = repository();
  const pending = state.formPending;
  if (!repo || !pending) return;
  const input = { ...pending, disambiguate: choice };
  delete input.editingId;
  const result = pending.editingId ? repo.update(pending.editingId, input) : repo.create(input);
  if (!result.ok) { state.formError = describeRefusal(result); return; }
  afterCommitmentWrite(result.record.id);
}

function afterCommitmentWrite(id) {
  state.formOpen = false;
  state.itemForm = null;
  state.formError = '';
  state.formPending = null;
  try { sync()?.syncCommitment(id); } catch { /* offline — pushAllLocal retries on reconnect */ }
  globalThis.refreshAuthoritativePlanSurfaces?.();
  render();
}

function deleteCommitment(id) {
  const repo = repository();
  if (!repo) return;
  const result = repo.remove(id);
  if (!result.ok) { state.formError = describeRefusal(result); render(); return; }
  afterCommitmentWrite(id);
}

// ── future personal-day browser ─────────────────────────────────────────────

function browseHtml(nowMs) {
  const layer = authority();
  if (!layer) return '';
  let days;
  try {
    days = layer.upcomingDays(state.browseFrom + BROWSE_DAYS, nowMs).slice(state.browseFrom);
  } catch (err) {
    return `<section class="pc-block"><h3>Browse future My Days</h3><p class="pc-muted" role="alert">${escape(err.message)}</p></section>`;
  }
  const commitments = allCommitments();
  const rows = days.map((target, index) => {
    const offset = state.browseFrom + index;
    const prepared = layer.preparedState(target);
    const items = layer.items(target);
    const dayCommitments = commitmentsForTarget(commitments, target);
    const statusBits = [];
    if (prepared.prepared) statusBits.push(prepared.intentionalBlank ? 'Open day' : 'Prepared');
    if (items.length) statusBits.push(`${items.length} planned`);
    if (dayCommitments.length) statusBits.push(`${dayCommitments.length} commitment${dayCommitments.length === 1 ? '' : 's'}`);
    const status = statusBits.length ? statusBits.join(' · ') : 'Nothing planned';
    const selected = state.selectedDayId === target.id;
    return `<div class="pc-day${selected ? ' selected' : ''}" data-pc-day="${escape(target.id)}">
      <div class="pc-row-main">
        <div class="pc-row-title">${escape(offset === 0 ? 'Today' : offset === 1 ? 'Next' : dayWindowLabel(target))}</div>
        <div class="pc-row-meta">${offset <= 1 ? `${escape(dayWindowLabel(target))} · ` : ''}${escape(status)}</div>
        ${dayCommitments.length ? `<div class="pc-day-commitments">${dayCommitments.map(c => `<span class="pc-chip">${escape(c.title)}${formatCommitmentTime(c) ? ` · ${escape(formatCommitmentTime(c))}` : ''}</span>`).join('')}</div>` : ''}
      </div>
      <button type="button" class="btn sm ghost" data-pc-action="prepare-day" data-id="${escape(target.id)}">Prepare</button>
    </div>`;
  }).join('');
  const pager = `<div class="pc-pager">
    ${state.browseFrom > 0 ? '<button type="button" class="pc-more" data-pc-action="browse-back">Earlier</button>' : ''}
    <button type="button" class="pc-more" data-pc-action="browse-forward">Later</button>
  </div>`;
  return `<section class="pc-block">
    <div class="pc-head">
      <h3>Browse future My Days</h3>
      <button type="button" class="btn sm ghost" data-pc-action="close-browse">Hide</button>
    </div>
    <p class="pc-muted">Each row is one personal day, labelled by the hours it actually covers.</p>
    ${rows}
    ${pager}
  </section>`;
}

/** Opens the existing Prepare-Tomorrow workflow against an arbitrary future day.
 *  Reuses the ONE preparation surface rather than adding a second editor — the
 *  defect Single Plan Authority V1 exists to prevent. */
function prepareDay(dayId) {
  const layer = authority();
  if (!layer) return;
  const target = layer.targetById(dayId);
  if (!target) { state.formError = 'That day cannot be resolved right now.'; render(); return; }
  state.selectedDayId = dayId;
  if (typeof globalThis.openPlanTomorrow === 'function') {
    globalThis.openPlanTomorrow({ target });
    return;
  }
  render();
}

// ── Unfinished from previous days ───────────────────────────────────────────

let completionPopover = null, completionAnchor = null, completionDialog = null, completionNoticeTimer = null;
let completionQuery = '', completionLimit = 50, completionOwnerGeneration = 0;
const completions = () => globalThis.TaskCompletions;
// Done earlier's date picker uses the ACCOUNT's authoritative zone when known (device zone only as a display fallback);
// the zone actually sent is chosen by TaskCompletions.complete() after its own refresh, never pre-captured here.
function completionZone() { return completions()?.accountTimezone?.() || null; }
function completionToday() { return localDateKey(Date.now(), completionZone() || accountTimezone()); }
function completionEntry(id, day) { return authority()?.rawStaleUnfinished().items.find(entry => entry.item.id === id && entry.sourceDayId === day); }
function completionPlannedDate(entry) {
  return entry.target.dateKey || localDateKey(entry.target.startMs, entry.target.timezone || accountTimezone());
}
function completionRowHtml(entry) {
  const { item, sourceDayId } = entry, view = completions()?.view(entry);
  let pending = null;
  try { pending = completions()?.pending(entry); } catch { /* receipt storage failure is surfaced on action */ }
  const busy = completions()?.busy(entry), conflict = view?.state === 'needs-review';
  const data = `data-id="${escape(item.id)}" data-day="${escape(sourceDayId)}"`;
  const planned = completionPlannedDate(entry);
  const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${planned}T12:00:00Z`));
  return `<div class="pc-row pc-stale-row pc-completion-row" data-pc-stale="${escape(item.id)}" data-pc-day="${escape(sourceDayId)}"${busy ? ' aria-busy="true"' : ''}>
    <label class="pc-complete-target"><input type="checkbox" data-pc-action="complete-today" ${data} aria-label="Complete today: ${escape(item.task)}"${busy || pending || conflict ? ' disabled' : ''}></label>
    <div class="pc-complete-copy"><button type="button" class="pc-complete-title" data-pc-action="reveal-stale-title" ${data} aria-expanded="false"><span class="pc-complete-task">${escape(item.task)}</span>
    <span class="pc-complete-date">Planned ${escape(date)}${busy ? ' · Saving…' : ''}</span></button>
    ${pending && !busy ? `<button type="button" class="pc-completion-retry" data-pc-action="retry-completion" ${data}>Still checking · Retry</button>` : ''}
    ${conflict ? '<span class="pc-completion-warning">Changed or ambiguous · refresh before resolving</span>' : ''}</div>
    <button type="button" class="pc-complete-more" data-pc-action="completion-menu" ${data} aria-haspopup="menu" aria-expanded="false" aria-label="More actions: ${escape(item.task)}">···</button>
  </div>`;
}
function closeCompletionPopover(restore = false) {
  completionPopover?.remove(); completionPopover = null;
  const anchor = completionAnchor; completionAnchor = null;
  anchor?.setAttribute('aria-expanded', 'false');
  if (restore && anchor?.isConnected) anchor.focus();
}
function positionCompletionPopover() {
  if (!completionPopover) return;
  if (!completionAnchor?.isConnected) {
    const selector = completionDialog?.open ? completionDialog : staleSection();
    completionAnchor = [...(selector?.querySelectorAll('.pc-complete-more') || [])].find(button => button.dataset.id === completionPopover.dataset.id && button.dataset.day === completionPopover.dataset.day);
  }
  if (!completionAnchor) { closeCompletionPopover(); return; }
  completionAnchor.setAttribute('aria-expanded', 'true');
  const rect = completionAnchor.getBoundingClientRect(), box = completionPopover.getBoundingClientRect();
  completionPopover.style.left = `${Math.max(12, Math.min(globalThis.innerWidth - box.width - 12, rect.right - box.width))}px`;
  completionPopover.style.top = `${Math.max(12, Math.min(globalThis.innerHeight - box.height - 12, rect.bottom + 4 + box.height > globalThis.innerHeight ? rect.top - box.height - 4 : rect.bottom + 4))}px`;
}
function openCompletionPopover(control, dateForm = false) {
  const entry = completionEntry(control.dataset.id, control.dataset.day);
  if (!entry) return;
  closeCompletionPopover(); completionAnchor = control;
  control.setAttribute('aria-expanded', 'true');
  const pop = document.createElement(dateForm ? 'form' : 'div');
  pop.className = 'pc-completion-popover'; pop.dataset.id = entry.item.id; pop.dataset.day = entry.sourceDayId;
  pop.dataset.owner = state.staleOwner || '';
  pop.setAttribute('role', dateForm ? 'dialog' : 'menu'); pop.setAttribute('aria-label', dateForm ? 'Done earlier' : 'Task actions');
  const data = `data-id="${escape(entry.item.id)}" data-day="${escape(entry.sourceDayId)}"`;
  const today = completionToday();
  let unresolved = null;
  try { unresolved = completions()?.pending(entry); } catch { unresolved = true; }
  if (unresolved || completions()?.busy(entry)) {
    pop.innerHTML = `<p>A completion change is still being checked. Resolve it before changing this task.</p><button type="button" data-pc-action="recover-completion" ${data}>Check status</button>`;
  } else if (dateForm) {
    pop.innerHTML = `<h3>Done earlier</h3><p class="pc-muted">Originally planned ${escape(completionPlannedDate(entry))}</p><label>Actual completion date<input name="completion-date" aria-label="Actual completion date" type="date" max="${today}" value="${today}" required></label>
      <div class="pc-completion-date-actions"><button type="button" data-pc-action="completion-yesterday">Yesterday</button><button type="button" data-pc-action="close-completion-popover">Cancel</button><button type="submit">Save completion</button></div>`;
    pop.addEventListener('submit', event => { event.preventDefault(); if (pop.dataset.owner === state.staleOwner) void completeHistorical(entry, pop.querySelector('input').value); });
  } else {
    pop.innerHTML = `<button role="menuitem" data-pc-action="completion-date" ${data}>Done earlier…</button><hr>
      <button role="menuitem" data-pc-action="move-today" ${data}>Move to today</button><button role="menuitem" data-pc-action="move-edit" ${data}>Move &amp; edit</button>
      <button role="menuitem" data-pc-action="reschedule" ${data}>Reschedule…</button><button role="menuitem" data-pc-action="dismiss" ${data}>Not doing this</button>
      <p class="pc-muted">Not doing removes it from the backlog and keeps its history.</p>`;
  }
  pop.addEventListener('click', event => { event.stopPropagation(); if (pop.dataset.owner === state.staleOwner) onClick(event); });
  completionPopover = pop;
  (completionDialog?.open ? completionDialog : document.body).append(pop);
  positionCompletionPopover(); pop.querySelector(dateForm ? 'input' : 'button')?.focus();
}
function closeCompletionBacklog() {
  if (completionDialog?.contains(completionPopover)) closeCompletionPopover();
  const toast = completionDialog?.querySelector('.pc-completion-toast');
  if (toast) staleSection()?.append(toast);
  completionDialog?.close(); completionDialog?.remove(); completionDialog = null; completionQuery = '';
}
function renderCompletionBacklog() {
  if (!completionDialog?.open) return;
  const items = authority().staleUnfinished().items;
  const focused = completionDialog.querySelector('.pc-backlog-rows')?.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
  const filtered = items.filter(entry => entry.item.task.toLocaleLowerCase().includes(completionQuery.toLocaleLowerCase()));
  completionDialog.querySelector('.pc-backlog-count').textContent = `${items.length} tasks`;
  completionDialog.querySelector('.pc-backlog-rows').innerHTML = filtered.slice(0, completionLimit).map(completionRowHtml).join('') || '<p class="pc-muted">No matching tasks</p>';
  completionDialog.querySelector('.pc-backlog-footer').innerHTML = `${Math.min(filtered.length, completionLimit)} of ${filtered.length} matching tasks${filtered.length > completionLimit ? '<button type="button" data-pc-action="more-backlog">Show 50 more</button>' : ''}`;
  const toast = staleSection()?.querySelector('.pc-completion-toast');
  if (toast) { completionDialog.querySelector('.pc-completion-toast')?.remove(); completionDialog.append(toast); }
  if (focused) {
    const controls = [...completionDialog.querySelectorAll('[data-pc-action]')];
    (controls.find(button => button.dataset.id === focused.id && button.dataset.day === focused.day && button.dataset.pcAction === focused.pcAction && !button.disabled)
      || completionDialog.querySelector('.pc-complete-more'))?.focus({ preventScroll: true });
  }
}
function openCompletionBacklog() {
  closeCompletionPopover(); closeCompletionBacklog(); completionLimit = 50;
  const dialog = document.createElement('dialog'); dialog.className = 'pc-completion-backlog'; dialog.dataset.owner = state.staleOwner || '';
  dialog.setAttribute('aria-label', 'All unfinished tasks');
  dialog.innerHTML = '<div class="pc-backlog-header"><h3>Unfinished</h3><span class="pc-backlog-count pc-muted"></span><button type="button" data-pc-action="close-completion-backlog" aria-label="Close backlog">✕</button></div><input class="pc-backlog-search" type="search" aria-label="Search unfinished tasks" placeholder="Search all tasks…"><div class="pc-backlog-rows"></div><div class="pc-backlog-footer pc-muted"></div>';
  dialog.addEventListener('click', event => { if (dialog.dataset.owner === state.staleOwner) onClick(event); });
  dialog.addEventListener('input', event => { if (event.target.matches('.pc-backlog-search')) { completionQuery = event.target.value; completionLimit = 50; renderCompletionBacklog(); } });
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (completionPopover) closeCompletionPopover(true); else closeCompletionBacklog(); });
  document.body.append(dialog); completionDialog = dialog; dialog.showModal(); renderCompletionBacklog(); dialog.querySelector('input').focus();
}
function completionNoticeHtml() {
  let pending = [];
  try { pending = completions()?.pendingAll() || []; } catch { /* action reports storage refusal */ }
  if (!state.completionNotice && !pending.length) return '';
  return `<div class="pc-completion-toast" role="status"><span>${escape(state.completionNotice || 'A completion change is still being checked.')}</span>
    ${state.completionReceipt ? '<button type="button" data-pc-action="undo-completion">Undo</button>' : pending.length ? '<button type="button" data-pc-action="recover-completion">Check status</button>' : ''}</div>`;
}
function showCompletionNotice(text, receipt = null, persistent = false) {
  clearTimeout(completionNoticeTimer); state.completionNotice = text; state.completionReceipt = receipt;
  function expire() {
    if (document.querySelector('.pc-completion-toast:hover,.pc-completion-toast:focus-within')) { completionNoticeTimer = setTimeout(expire, 1000); return; }
    state.completionNotice = ''; state.completionReceipt = null; render();
  }
  if (!persistent) completionNoticeTimer = setTimeout(expire, 8000);
  render();
}
async function completeHistorical(entry, date) {
  const owner = state.staleOwner, generation = completionOwnerGeneration;
  closeCompletionPopover();
  const result = await completions().complete(entry, date); // zone (and 'today' when date is null) chosen after its own refresh
  if (state.staleOwner !== owner || completionOwnerGeneration !== generation) return;
  if (result.outcome === 'CONFIRMED') {
    const current = completions().view(entry);
    const active = current?.state === 'completed' && current.record?.revision === result.record.revision
      && current.record?.completionOpId === result.request.operationId && result.record.completionOpId === result.request.operationId;
    showCompletionNotice(active ? 'Completion saved' : 'Saved · status refreshed', active ? { uid: globalThis.getTaskCompletionAppContext?.()?.uid, record: result.record } : null);
  } else showCompletionNotice(result.outcome === 'UNKNOWN' ? 'Still checking completion' : `Not saved · ${result.reason || 'Please retry'}`, null, result.outcome === 'UNKNOWN');
}
/** One undo path for both the temporary notice and the durable Completed list, so the two
 *  cannot drift: same receipt shape, same backend call, same handling of UNKNOWN. */
function runCompletionUndo(receipt) {
  const owner = state.staleOwner, generation = completionOwnerGeneration;
  const key = `${receipt.record.identity.targetId}\u0000${receipt.record.identity.itemId}`;
  if (undoInFlight.has(key)) return;
  const api = completions(), entry = completionEntry(receipt.record.identity.itemId, receipt.record.identity.targetId);
  let pending = null;
  try { pending = entry && api.pending(entry); }
  catch { showCompletionNotice('Undo unavailable · receipt storage needs recovery', null, true); return; }
  undoInFlight.add(key);
  void (pending ? api.resume(pending) : api.undo(receipt)).finally(() => { undoInFlight.delete(key); }).then(result => {
    if (state.staleOwner !== owner || completionOwnerGeneration !== generation) return;
    const entry = completionEntry(receipt.record.identity.itemId, receipt.record.identity.targetId), current = entry && completions().view(entry);
    const open = result.record?.state === 'open' && current?.state === 'unfinished' && current.record?.revision === result.record.revision;
    showCompletionNotice(result.outcome === 'CONFIRMED' ? open ? 'Completion undone' : 'Undo recorded · status refreshed'
      : result.outcome === 'UNKNOWN' ? 'Undo still checking' : 'Undo refused · task changed', null, result.outcome === 'UNKNOWN');
  });
}
function handleCompletionAction(action, control) {
  const id = control.dataset.id, day = control.dataset.day;
  switch (action) {
    case 'complete-today': case 'retry-completion': { const entry = completionEntry(id, day); if (entry) void completeHistorical(entry, null); return true; }
    case 'reveal-stale-title': control.setAttribute('aria-expanded', String(control.getAttribute('aria-expanded') !== 'true')); return true;
    case 'completion-menu': openCompletionPopover(control); return true;
    case 'completion-date': openCompletionPopover(completionAnchor, true); return true;
    case 'completion-yesterday': completionPopover.querySelector('input').value = addCalendarDays(completionToday(), -1); return true;
    case 'close-completion-popover': closeCompletionPopover(true); return true;
    case 'view-all-stale': openCompletionBacklog(); return true;
    case 'close-completion-backlog': closeCompletionBacklog(); staleSection()?.querySelector('[data-pc-action="view-all-stale"]')?.focus(); return true;
    case 'more-backlog': completionLimit += 50; renderCompletionBacklog(); return true;
    case 'undo-completion': {
      const receipt = state.completionReceipt;
      if (!receipt) return true;
      state.completionReceipt = null;
      runCompletionUndo(receipt);
      render(); return true;
    }
    // O1: the same undo, reached from the durable Completed list instead of the expiring notice.
    case 'undo-completed': {
      const entry = completionEntry(id, day);
      const view = entry && completions()?.view(entry);
      const uid = globalThis.getTaskCompletionAppContext?.()?.uid;
      if (!entry || view?.state !== 'completed' || !view.record || !uid) {
        showCompletionNotice('Undo unavailable · refresh and retry'); return true;
      }
      runCompletionUndo({ uid, record: view.record });
      render(); return true;
    }
    case 'expand-completed': state.expanded.completed = true; state.completedLimit = PREVIEW_ROWS; render(); return true;
    case 'collapse-completed': state.expanded.completed = false; render(); return true;
    case 'more-completed': state.completedLimit += PREVIEW_ROWS; render(); return true;
    case 'recover-completion': {
      const entry = id && completionEntry(id, day);
      const pending = entry ? completions().pending(entry) : completions().pendingAll()[0], owner = state.staleOwner, generation = completionOwnerGeneration;
      if (pending) void completions().resume(pending).then(result => { if (state.staleOwner === owner && completionOwnerGeneration === generation) showCompletionNotice(result.outcome === 'CONFIRMED' ? 'Completion status recovered' : 'Still checking · retry when connected', null, result.outcome !== 'CONFIRMED'); });
      return true;
    }
    case 'move-today': case 'move-edit': case 'reschedule': case 'dismiss': closeCompletionPopover(); return false;
    default: return false;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', event => { if (completionPopover && !completionPopover.contains(event.target) && !event.target.closest('.pc-complete-more')) closeCompletionPopover(); });
  document.addEventListener('keydown', event => {
    if (!completionPopover) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCompletionPopover(true); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && completionPopover.getAttribute('role') === 'menu') {
      event.preventDefault(); const buttons = [...completionPopover.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement), step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length].focus();
    }
  });
  document.addEventListener('scroll', positionCompletionPopover, true);
  // O2: retry a failed inspection after reconnect when the watch is still intact and the
  // candidate signature is unchanged. Cancelled permission listeners stay fail-closed until rebind.
  // Independent try blocks: a render fault must never swallow the re-inspection.
  globalThis.addEventListener?.('online', () => {
    try { void completions()?.refresh(); } catch { /* reported on the next action */ }
    try { render(); } catch { /* surface stays as it is */ }
  });
}

// ---- O1: durable Undo -------------------------------------------------------
// A completion is reversible only while its temporary notice is on screen unless the
// resolved task stays reachable. These read the SAME resolution records the notice uses
// (TaskCompletions.view) - no second source of truth, and no extra backend call.
const completionReceiptOf = record => record?.operations?.[record.completionOpId] || null;
// Undo is not covered by TaskCompletions.busy() (that tracks complete()), so a double tap would
// send a second undo that the revision CAS refuses - harmless, but it reads as a failure.
const undoInFlight = new Set();
function completedEntries(nowMs) {
  const layer = authority(), api = completions();
  if (!layer || !api || typeof layer.rawStaleUnfinished !== 'function') return [];
  let items = [];
  try { items = layer.rawStaleUnfinished(nowMs).items || []; } catch { return []; }
  const out = [];
  for (const entry of items) {
    let view = null;
    try { view = api.view(entry); } catch { view = null; }
    const receipt = view?.state === 'completed' ? completionReceiptOf(view.record) : null;
    if (receipt) out.push({ entry, record: view.record, receipt });
  }
  // Newest resolution first, by the server's own assertion instant.
  return out.sort((a, b) => (b.receipt.recordedAt || 0) - (a.receipt.recordedAt || 0));
}
function completedRowHtml({ entry, receipt }) {
  const { item, sourceDayId } = entry;
  const data = `data-id="${escape(item.id)}" data-day="${escape(sourceDayId)}"`;
  const busy = completions()?.busy(entry) || undoInFlight.has(`${sourceDayId}\u0000${item.id}`);
  let pending = null;
  try { pending = completions()?.pending(entry); } catch { /* receipt storage failure is surfaced on action */ }
  const when = receipt.date
    ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${receipt.date}T12:00:00Z`))
    : '';
  return `<div class="pc-row pc-completed-row" data-pc-completed="${escape(item.id)}" data-pc-day="${escape(sourceDayId)}"${busy ? ' aria-busy="true"' : ''}>
    <span class="pc-completed-mark" aria-hidden="true">✓</span>
    <div class="pc-complete-copy"><button type="button" class="pc-complete-title" data-pc-action="reveal-stale-title" ${data} aria-expanded="false"><span class="pc-complete-task">${escape(item.task)}</span>
    <span class="pc-complete-date">Completed ${escape(when)}${busy ? ' · Saving…' : pending ? ' · Still checking…' : ''}</span></button></div>
    <button type="button" class="pc-completed-undo" data-pc-action="undo-completed" ${data}${busy ? ' disabled' : ''} aria-label="${pending ? 'Check status' : 'Undo completion'}: ${escape(item.task)}">${pending ? 'Check status' : 'Undo'}</button>
  </div>`;
}
function completedHtml(nowMs) {
  const all = completedEntries(nowMs);
  if (!all.length) return '';
  if (!state.expanded.completed) {
    return `<section class="pc-block pc-completed-compact"><button type="button" class="pc-stale-trigger" data-pc-action="expand-completed" aria-expanded="false"><span>Completed · ${all.length}</span><span aria-hidden="true">›</span></button></section>`;
  }
  const shown = all.slice(0, state.completedLimit);
  const more = all.length > shown.length
    ? `<div class="pc-preview-footer"><span>Showing ${shown.length} of ${all.length}</span><button type="button" data-pc-action="more-completed">Show more</button></div>` : '';
  return `<section class="pc-block">
    <div class="pc-head"><h3>Completed</h3><span class="pc-muted">${all.length} tasks</span><button type="button" class="btn sm ghost" data-pc-action="collapse-completed" aria-label="Collapse Completed">⌄</button></div>
    <p class="pc-muted">Resolved from earlier days. Undo restores the task; the original completion receipt is kept.</p>
    ${shown.map(completedRowHtml).join('')}
    ${more}
  </section>`;
}

function staleHtml(nowMs) {
  const layer = authority();
  if (!layer) return '';
  let projection;
  try {
    projection = layer.staleUnfinished(nowMs);
  } catch (err) {
    return `<section class="pc-block"><h3>Unfinished from previous days</h3><p class="pc-muted" role="alert">${escape(err.message)}</p></section>`;
  }
  const { items, unresolvable } = projection;
  const conflicts = layer.recoveryConflicts?.() || [];
  if (!items.length && !unresolvable.length && !conflicts.length) return '';
  const shown = items.slice(0, PREVIEW_ROWS);
  const rows = shown.map(completionRowHtml).join('');
  const more = items.length > PREVIEW_ROWS
    ? `<div class="pc-preview-footer"><span>Showing ${shown.length} of ${items.length}</span><button type="button" data-pc-action="view-all-stale">View all <span aria-hidden="true">›</span></button></div>` : '';
  // A day whose interval cannot be resolved is still SHOWN. "No planned information
  // becomes unreachable because it is old" has to hold even when a revision is gone.
  const stranded = unresolvable.length
    ? `<p class="pc-muted">${unresolvable.reduce((n, day) => n + day.items.length, 0)} task(s) belong to a personal day whose interval can’t be resolved right now. They are kept exactly as they are.</p>`
    : '';
  const conflictRows = conflicts.map(conflict => {
    const candidates = conflict.candidates.map(candidate => {
      const target = layer.targetById(candidate.dayId);
      const where = target ? dayWindowLabel(target) : candidate.dayId;
      const when = candidate.item.when ? ` · ${candidate.item.when}` : '';
      const actor = candidate.relocation?.updatedBy ? ` · ${candidate.relocation.updatedBy}` : '';
      return `<div class="pc-row" data-pc-recovery-candidate="${escape(candidate.dayId)}">
        <div class="pc-row-main"><div class="pc-row-title">${escape(candidate.item.task)}</div><div class="pc-row-meta">${escape(where + when + actor)}</div></div>
        <button type="button" class="btn sm" data-pc-action="resolve-recovery" data-id="${escape(conflict.sourceItemId)}" data-day="${escape(conflict.sourceDayId)}" data-candidate-day="${escape(candidate.dayId)}">Keep this version</button>
      </div>`;
    }).join('');
    return `<div class="pc-block" data-pc-recovery-conflict="${escape(conflict.sourceItemId)}"><div class="pc-head"><h3>Recovery conflict</h3></div><p class="pc-muted">Two devices edited this recovered task differently. Choose the version to keep; both candidates remain preserved in history.</p>${candidates}</div>`;
  }).join('');
  return `<section class="pc-block">
    <div class="pc-head"><h3>Unfinished</h3><span class="pc-muted">${items.length} tasks</span><button type="button" class="btn sm ghost" data-pc-action="collapse-stale" aria-label="Collapse Unfinished">⌄</button></div>
    ${conflictRows}
    ${rows}
    ${more}
    ${stranded}
  </section>`;
}

function staleCompactHtml(nowMs) {
  const layer = authority();
  if (!layer) return '';
  const projection = layer.staleUnfinished(nowMs);
  const count = projection.items.length + projection.unresolvable.reduce((sum, day) => sum + day.items.length, 0) + (layer.recoveryConflicts?.().length || 0);
  if (!count) return '';
  if (state.expanded.stale) return staleHtml(nowMs);
  return `<section class="pc-block pc-stale-compact"><button type="button" class="pc-stale-trigger" data-pc-action="expand-stale" aria-expanded="false"><span>Unfinished · ${count}</span><span aria-hidden="true">›</span></button></section>`;
}

/** The app's own item stamping (updatedAt + updatedBy), through the app context, so a
 *  recovered task is stamped exactly like every other plan mutation. */
function stamp(value) {
  const ctx = appContext();
  return ctx && typeof ctx.stampItem === 'function' ? ctx.stampItem(value) : { ...value, updatedAt: Date.now() };
}

/** The copy shown when a recovered PRIORITY had to land as an Other planned task. */
export const MOVED_AS_TASK_NOTICE = 'Moved to Other planned tasks because your Top 3 is already full.';

/** One section-level status line for the recovery actions. (Previously their errors
 *  went to state.formError, which only renders inside the commitment form, so they
 *  were invisible whenever the form was closed.) */
function setNotice(text, tone = 'info') {
  state.notice = text ? { text, tone } : null;
}

function noticeFor(result) {
  return result && result.demoted ? MOVED_AS_TASK_NOTICE : '';
}

/** Both directions must beat the source revision, including same-tick repeated actions. */
function stampStaleMutation(value) {
  const next = stamp(value);
  return { ...next, updatedAt: Math.max(next.updatedAt, (Number(value.updatedAt) || 0) + 1) };
}

function staleAction(action, itemId, dayId) {
  const layer = authority();
  if (!layer) return;
  const sourceTarget = layer.targetById(dayId);
  if (!sourceTarget) { setNotice('That day cannot be resolved right now.', 'error'); render(); return; }
  try {
    if (!layer.staleUnfinished().items.some(entry => entry.item.id === itemId && entry.sourceDayId === dayId)) {
      throw new Error('This task has changed or is no longer unfinished. Check the refreshed list.');
    }
    if (action === 'dismiss') {
      layer.dismissStaleItem({ sourceTarget, itemId, stamp: stampStaleMutation });
      const dismissed = layer.rawItems(sourceTarget).find(item => item.id === itemId);
      state.staleUndo = state.staleOwner && dismissed?.dismissedAt
        ? { owner: state.staleOwner, dayId, itemId, task: dismissed.task, snapshot: JSON.parse(JSON.stringify(dismissed)) } : null;
      state.staleStatus = 'Removed from the active backlog. Original plan and history kept.';
      setNotice('');
    } else if (action === 'reschedule') {
      // Reschedule means "choose a day": open the browser and let the owner pick,
      // rather than guessing a destination for them.
      state.browseOpen = true;
      state.detail = 'browse';
      state.pendingMove = { itemId, dayId };
      setNotice('');
      render();
      return;
    } else {
      const destination = layer.current();
      const result = layer.moveStaleItem({ sourceTarget, itemId, destination, stamp });
      setNotice(noticeFor(result));
      if (action === 'move-edit') state.itemForm = { type: 'task', dayId: destination.id, anchorDayId: destination.id, itemId: result.item.id, dateTouched: false };
    }
  } catch (err) {
    setNotice(err.message, 'error');
  }
  globalThis.refreshAuthoritativePlanSurfaces?.();
  render();
}

function undoStaleDismissal() {
  const receipt = state.staleUndo;
  state.staleUndo = null; // one-shot, including duplicate clicks and refused attempts
  if (!receipt || receipt.owner !== repository()?.ownerRoomId?.()) return;
  const layer = authority();
  try {
    const sourceTarget = layer.targetById(receipt.dayId);
    const current = sourceTarget && layer.rawItems(sourceTarget).find(item => item.id === receipt.itemId);
    if (!current || !sameOnWire(current, receipt.snapshot) || current.done || current.deleted
      || layer.staleMoveDestination(receipt.itemId, receipt.dayId)) {
      throw new Error('This task changed since dismissal. Undo was not applied.');
    }
    layer.undismissStaleItem({ sourceTarget, itemId: receipt.itemId, stamp: stampStaleMutation });
    state.staleStatus = 'Task restored to Unfinished.';
  } catch (err) {
    state.staleStatus = err.message;
  }
  globalThis.refreshAuthoritativePlanSurfaces?.();
  render();
}

function resolveRecoveryConflict(control) {
  const layer = authority();
  if (!layer) return;
  try {
    const result = layer.resolveRecoveryConflict({
      sourceItemId: control.dataset.id,
      sourceDayId: control.dataset.day,
      candidateDayId: control.dataset.candidateDay,
      stamp,
    });
    setNotice(result.resolved ? 'Recovery conflict resolved.' : 'That version is already the retained one.');
  } catch (err) {
    setNotice(err.message, 'error');
  }
  globalThis.refreshAuthoritativePlanSurfaces?.();
  render();
}

/** Completes a pending "Reschedule…" once the owner picks a day in the browser. */
function completePendingMove(dayId) {
  const layer = authority();
  const pending = state.pendingMove;
  if (!layer || !pending) return false;
  const sourceTarget = layer.targetById(pending.dayId);
  const destination = layer.targetById(dayId);
  if (!sourceTarget || !destination) { setNotice('That day cannot be resolved right now.', 'error'); render(); return true; }
  try {
    const result = layer.rescheduleStaleItem({ sourceTarget, itemId: pending.itemId, destination, stamp });
    setNotice(noticeFor(result));
    state.pendingMove = null;
  } catch (err) {
    setNotice(err.message, 'error');
  }
  globalThis.refreshAuthoritativePlanSurfaces?.();
  render();
  return true;
}

// ── render / events ─────────────────────────────────────────────────────────

export function render() {
  const root = section();
  if (!root) return;
  const recovery = staleSection();
  const focused = recovery?.contains(document.activeElement) ? document.activeElement : null;
  const focusedOwner = recovery?.dataset.pcOwner;
  const focusedMenu = focused?.matches('summary') ? focused.closest('details')?.dataset : null;
  const layer = authority();
  if (!layer) { root.hidden = true; root.innerHTML = ''; return; }
  const owner = repository()?.ownerRoomId?.() || null;
  if (owner !== state.staleOwner) {
    completionOwnerGeneration++;
    state.staleOwner = owner;
    state.staleUndo = null;
    state.staleStatus = '';
    state.staleOffset = 0;
    closeCompletionPopover(); closeCompletionBacklog(); clearTimeout(completionNoticeTimer);
    state.completionNotice = null; state.completionReceipt = null;
    state.expanded.stale = false;
    state.expanded.completed = false;
    state.completedLimit = PREVIEW_ROWS;
    state.pendingMove = null;
  }
  const nowMs = Date.now();
  globalThis.TaskCompletions?.ensure((layer.rawStaleUnfinished?.(nowMs) || layer.staleUnfinished(nowMs)).items);
  let html = '';
  try {
    const notice = state.notice
      ? `<p class="pc-notice${state.notice.tone === 'error' ? ' pc-error' : ''}" role="status">${escape(state.notice.text)}</p>`
      : '';
    const editor = state.itemForm
      ? (state.itemForm.type === 'commitment' ? commitmentFormHtml() : taskFormHtml())
      : '';
    const detail = state.detail === 'browse' ? browseHtml(nowMs)
      : state.detail === 'commitments' ? upcomingHtml(nowMs) : '';
    html = notice
      + '<div class="pc-command-row"><button type="button" class="btn primary" data-pc-action="open-item-form">＋ Add</button></div>'
      + editor + detail;
  } catch (err) {
    html = `<section class="pc-block"><p class="pc-muted" role="alert">Planning surfaces are unavailable right now. (${escape(err.message)})</p></section>`;
  }
  root.hidden = false;
  root.innerHTML = html;
  if (recovery) {
    const feedback = state.staleStatus ? `<div class="pc-notice pc-stale-feedback" role="status"><span>${escape(state.staleStatus)}</span>
      ${state.staleUndo ? `<span class="pc-stale-full-title">${escape(state.staleUndo.task)}</span><button type="button" class="btn sm ghost" data-pc-action="undo-dismiss">Undo</button>` : ''}
      <button type="button" class="pc-icon" data-pc-action="close-stale-status" aria-label="Dismiss unfinished notice">Close</button></div>` : '';
    const recoveryHtml = feedback + completionNoticeHtml() + staleCompactHtml(nowMs) + completedHtml(nowMs);
    recovery.hidden = !recoveryHtml;
    recovery.dataset.pcOwner = owner || '';
    recovery.innerHTML = recoveryHtml;
    renderCompletionBacklog();
    positionCompletionPopover();
    if (focused && focusedOwner === (owner || '')) {
      const controls = [...recovery.querySelectorAll('[data-pc-action]')];
      const replacement = focusedMenu
        ? [...recovery.querySelectorAll('details')].find(menu => menu.dataset.id === focusedMenu.id && menu.dataset.day === focusedMenu.day)?.querySelector('summary')
        : controls.find(button => button.dataset.pcAction === focused.dataset.pcAction
          && button.dataset.id === focused.dataset.id && button.dataset.day === focused.dataset.day && !button.disabled);
      (replacement || controls.find(button => !button.disabled))?.focus({ preventScroll: true });
    }
  }
}

function onClick(event) {
  const control = event.target.closest('[data-pc-action]');
  if (!control) return;
  const action = control.dataset.pcAction;
  const id = control.dataset.id;
  event.preventDefault();
  if (control.closest('#unfinished-recovery-section') && staleSection().dataset.pcOwner !== (repository()?.ownerRoomId?.() || '')) {
    render();
    return;
  }
  if (handleCompletionAction(action, control)) return;
  switch (action) {
    case 'open-item-form': {
      const current = authority()?.current();
      state.itemForm = { type: 'task', anchorDayId: current?.id, dateTouched: false };
      state.formOpen = false; state.formError = ''; render(); break;
    }
    case 'add-commitment': state.itemForm = { type: 'commitment' }; state.formOpen = true; state.formError = ''; state.formPending = null; render(); break;
    case 'close-item-form': case 'close-form': state.itemForm = null; state.formOpen = false; state.formError = ''; state.formPending = null; render(); break;
    case 'open-form': state.itemForm = { type: 'commitment' }; state.formOpen = true; state.formError = ''; state.formPending = null; render(); break;
    case 'edit-commitment': state.itemForm = { type: 'commitment' }; state.formOpen = id; state.formError = ''; state.formPending = null; render(); break;
    case 'delete-commitment': deleteCommitment(id); break;
    case 'dst-earlier': resolveAmbiguous('earlier'); break;
    case 'dst-later': resolveAmbiguous('later'); break;
    case 'expand-upcoming': state.expanded.upcoming = true; render(); break;
    case 'collapse-upcoming': state.expanded.upcoming = false; render(); break;
    case 'expand-stale': state.expanded.stale = true; state.staleOffset = 0; render(); break;
    case 'collapse-stale': state.expanded.stale = false; render(); break;
    case 'stale-next': state.staleOffset += PREVIEW_ROWS; render(); break;
    case 'stale-previous': state.staleOffset = Math.max(0, state.staleOffset - PREVIEW_ROWS); render(); break;
    case 'undo-dismiss': undoStaleDismissal(); break;
    case 'close-stale-status': state.staleUndo = null; state.staleStatus = ''; render(); break;
    case 'set-date': {
      const input = section()?.querySelector('#pc-task-form [name="date"]');
      if (input) input.value = control.dataset.date;
      if (state.itemForm?.type === 'task') {
        state.itemForm.anchorDayId = control.dataset.day;
        state.itemForm.dateTouched = false;
      }
      break;
    }
    case 'open-browse': state.detail = 'browse'; render(); break;
    case 'close-browse': state.detail = null; state.browseOpen = false; state.pendingMove = null; render(); break;
    case 'browse-forward': state.browseFrom += BROWSE_DAYS; render(); break;
    case 'browse-back': state.browseFrom = Math.max(0, state.browseFrom - BROWSE_DAYS); render(); break;
    case 'prepare-day':
      // A pending "Reschedule…" claims the click first: the owner is choosing a
      // destination, not opening a preparation workflow.
      if (!completePendingMove(id)) prepareDay(id);
      break;
    case 'move-today': case 'move-edit': case 'reschedule': case 'dismiss':
      staleAction(action, id, control.dataset.day);
      break;
    case 'resolve-recovery': resolveRecoveryConflict(control); break;
    default: break;
  }
}

function onSubmit(event) {
  const taskForm = event.target.closest('#pc-task-form');
  if (taskForm) {
    event.preventDefault();
    submitTaskForm(taskForm);
    render();
    return;
  }
  const form = event.target.closest('#pc-commitment-form');
  if (!form) return;
  event.preventDefault();
  submitCommitmentForm(form);
  render();
}

function onInput(event) {
  const input = event.target;
  if (!state.itemForm || state.itemForm.type !== 'task' || !input.closest?.('#pc-task-form')) return;
  if (input.name === 'date') {
    state.itemForm.dateTouched = true;
    return;
  }
  if (input.name !== 'time' || state.itemForm.dateTouched) return;
  const editing = taskFormValue();
  const dateInput = section()?.querySelector('#pc-task-form [name="date"]');
  if (!dateInput) return;
  if (!input.value) {
    const endInput = section()?.querySelector('#pc-task-form [name="endTime"]');
    if (endInput) endInput.value = '';
    dateInput.value = taskDateHint(editing.anchorTarget);
    return;
  }
  if (editing.anchorTarget?.store === 'calendar' && editing.item?.whenDayOffset === 1) {
    dateInput.value = addCalendarDays(editing.anchorTarget.dateKey, 1);
    return;
  }
  const resolved = authority()?.civilDateForTimeInTarget(editing.anchorTarget, input.value);
  if (resolved?.ok) dateInput.value = resolved.dateKey;
}

/** Called after any inbound remote commitment merge, and by index.html's own
 *  plan-surface refresh, so these lists never drift from stored truth. */
export function refreshPlanningContinuityIfMounted() {
  if (!section()) return;
  render();
}

if (typeof window !== 'undefined') {
  window.PlanningContinuityUI = {
    render,
    refresh: refreshPlanningContinuityIfMounted,
    commitmentsForTarget: target => commitmentsForTarget(allCommitments(), target),
    editTask(dayId, itemId) {
      state.itemForm = { type: 'task', dayId, anchorDayId: dayId, itemId, dateTouched: false };
      state.formOpen = false;
      state.formError = '';
      render();
      section()?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    editCommitment(id) {
      state.itemForm = { type: 'commitment' };
      state.formOpen = id;
      state.formError = '';
      render();
      section()?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    openDetails(detail) { state.detail = detail; render(); section()?.scrollIntoView({ block: 'start', behavior: 'smooth' }); },
  };
  window.refreshCommitmentSurfaces = refreshPlanningContinuityIfMounted;
  window.openPlanningDetails = detail => window.PlanningContinuityUI.openDetails(detail);
  const root = section();
  if (root) {
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('submit', onSubmit);
  }
  staleSection()?.addEventListener('click', onClick);
  render();
  globalThis.refreshMyDayTimeline?.();
}

// Exported for tests that exercise the pure label/selection helpers without a DOM.
export const __internals = { dayWindowLabel, commitmentLabel, describeRefusal, activeCommitments };
