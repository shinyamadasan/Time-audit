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
import {
  activeCommitments, upcomingCommitments, commitmentsForTarget,
  formatCommitmentTime, normalizeCommitment,
} from './commitments-model.js';
import { describeStaleAge } from './stale-plan-recovery-model.js';

const SECTION_ID = 'planning-continuity-section';
/** How many rows each list renders before "Show all". A DISPLAY bound only — the
 *  projections behind these lists are deliberately unbounded, so nothing becomes
 *  undiscoverable just because it is old or far ahead. */
const PREVIEW_ROWS = 5;
/** How many future personal days the browser offers at once. */
const BROWSE_DAYS = 14;

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const state = {
  expanded: { upcoming: false, stale: false },
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
  if (target.store === 'legacy') return formatCalendarDate(target.dateKey);
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
    ? taskDateHint(sourceTarget, item.when || '')
    : taskDateHint(anchorTarget);
  return { sourceTarget, anchorTarget, item, date, quick };
}

function taskFormHtml() {
  const { item, date, quick } = taskFormValue();
  const kind = item?.kind === 'task' ? 'task' : 'priority';
  return `<form class="pc-form pc-item-form" id="pc-task-form">
    <div class="pc-head"><h3>${item ? 'Edit planned task' : 'Add to My Day'}</h3><button type="button" class="pc-icon" data-pc-action="close-item-form" aria-label="Close add task">✕</button></div>
    ${item ? '' : `<div class="pc-entry-types" role="group" aria-label="What to add"><button type="button" class="btn sm primary" aria-pressed="true">Task</button><button type="button" class="btn sm ghost" data-pc-action="add-commitment" aria-pressed="false">Commitment</button></div>`}
    <label>What do you want to do?<input name="title" maxlength="200" value="${escape(item?.task || '')}" required autofocus></label>
    <fieldset class="pc-when"><legend>When?</legend><div class="pc-quick-dates">
      <button type="button" class="btn sm ghost" data-pc-action="set-date" data-day="${escape(quick.today.target?.id || '')}" data-date="${escape(quick.today.date)}">Today</button>
      <button type="button" class="btn sm ghost" data-pc-action="set-date" data-day="${escape(quick.tomorrow.target?.id || '')}" data-date="${escape(quick.tomorrow.date)}">Tomorrow</button>
    </div><input name="date" type="date" value="${escape(date)}" required aria-label="Task date"></fieldset>
    <label>Time <input name="time" type="time" value="${escape(item?.when || '')}" aria-label="Task time, optional"><span class="pc-muted">Leave blank for Anytime.</span></label>
    <label>Type <select name="kind"><option value="priority"${kind === 'priority' ? ' selected' : ''}>Top Priority</option><option value="task"${kind === 'task' ? ' selected' : ''}>Other task</option></select></label>
    ${state.formError ? `<p class="pc-error" role="alert">${escape(state.formError)}</p>` : ''}
    <div class="pc-form-actions"><button type="submit" class="btn sm primary">${item ? 'Save' : 'Add'}</button><button type="button" class="btn sm ghost" data-pc-action="close-item-form">Cancel</button></div>
  </form>`;
}

function submitTaskForm(form) {
  const layer = authority();
  const context = appContext();
  if (!layer || !context) { state.formError = 'Your plan is still loading.'; return; }
  const data = new FormData(form);
  const title = String(data.get('title') || '').trim();
  const date = String(data.get('date') || '');
  const time = String(data.get('time') || '');
  const kind = data.get('kind') === 'task' ? 'task' : 'priority';
  if (!title) { state.formError = 'Name the task first.'; return; }
  const editing = taskFormValue();
  // Untouched dates preserve the selected authoritative My Day. A typed time is
  // interpreted inside that target; only a user-edited civil date uses the
  // date/noon scheduling contract and may relocate the item.
  const resolved = state.itemForm?.dateTouched
    ? layer.dayForScheduledDate(date, time)
    : time ? layer.civilDateForTimeInTarget(editing.anchorTarget, time)
      : { ok: true, anchor: 'target', target: editing.anchorTarget };
  if (!resolved.ok) {
    state.formError = resolved.reason === 'ambiguous' ? 'That time happens twice on this date. Choose a different time.'
      : resolved.reason === 'nonexistent' ? 'That time does not exist on this date. Choose a different time.'
        : resolved.reason === 'outside-target' ? 'That time is outside this My Day. Pick a date to schedule it on another day.'
          : 'Choose a valid date.';
    return;
  }
  try {
    if (state.itemForm?.itemId) {
      layer.updateItem({ sourceTarget: editing.sourceTarget, itemId: state.itemForm.itemId, destination: resolved.target, changes: { task: title, when: time, kind }, stamp: stamp });
    } else {
      const item = context.createItem(title, time, kind);
      layer.addItem({ destination: resolved.target, item });
    }
    state.itemForm = null;
    state.formError = '';
    globalThis.refreshAuthoritativePlanSurfaces?.();
  } catch (err) { state.formError = err.message; }
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
  if (!items.length && !unresolvable.length) return '';
  const shown = state.expanded.stale ? items : items.slice(0, PREVIEW_ROWS);
  const rows = shown.map(entry => {
    const where = `${escape(describeStaleAge(entry.ageMs))} · ${escape(dayWindowLabel(entry.target))}`;
    const kindNote = entry.kind === 'task' ? '<span class="pc-zone">task</span>' : '';
    return `<div class="pc-row" data-pc-stale="${escape(entry.item.id)}" data-pc-day="${escape(entry.sourceDayId)}">
      <div class="pc-row-main">
        <div class="pc-row-title">${escape(entry.item.task)}${kindNote}</div>
        <div class="pc-row-meta">${where}</div>
      </div>
      <button type="button" class="btn sm" data-pc-action="move-today" data-id="${escape(entry.item.id)}" data-day="${escape(entry.sourceDayId)}">Move to today</button>
      <button type="button" class="btn sm ghost" data-pc-action="move-edit" data-id="${escape(entry.item.id)}" data-day="${escape(entry.sourceDayId)}">Move &amp; edit</button>
      <button type="button" class="btn sm ghost" data-pc-action="reschedule" data-id="${escape(entry.item.id)}" data-day="${escape(entry.sourceDayId)}">Reschedule…</button>
      <button type="button" class="pc-icon" data-pc-action="dismiss" data-id="${escape(entry.item.id)}" data-day="${escape(entry.sourceDayId)}">Not doing this</button>
    </div>`;
  }).join('');
  const more = items.length > shown.length
    ? `<button type="button" class="pc-more" data-pc-action="expand-stale">Show all ${items.length}</button>`
    : (state.expanded.stale && items.length > PREVIEW_ROWS
      ? '<button type="button" class="pc-more" data-pc-action="collapse-stale">Show fewer</button>' : '');
  // A day whose interval cannot be resolved is still SHOWN. "No planned information
  // becomes unreachable because it is old" has to hold even when a revision is gone.
  const stranded = unresolvable.length
    ? `<p class="pc-muted">${unresolvable.reduce((n, day) => n + day.items.length, 0)} task(s) belong to a personal day whose interval can’t be resolved right now. They are kept exactly as they are.</p>`
    : '';
  return `<section class="pc-block">
    <div class="pc-head"><h3>Unfinished · ${items.length + unresolvable.reduce((n, day) => n + day.items.length, 0)}</h3><button type="button" class="btn sm ghost" data-pc-action="collapse-stale">Close</button></div>
    ${rows}
    ${more}
    ${stranded}
  </section>`;
}

function staleCompactHtml(nowMs) {
  const layer = authority();
  if (!layer) return '';
  const projection = layer.staleUnfinished(nowMs);
  const count = projection.items.length + projection.unresolvable.reduce((sum, day) => sum + day.items.length, 0);
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

function staleAction(action, itemId, dayId) {
  const layer = authority();
  if (!layer) return;
  const sourceTarget = layer.targetById(dayId);
  if (!sourceTarget) { setNotice('That day cannot be resolved right now.', 'error'); render(); return; }
  try {
    if (action === 'dismiss') {
      layer.dismissStaleItem({ sourceTarget, itemId, stamp });
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
  const layer = authority();
  if (!layer) { root.hidden = true; root.innerHTML = ''; return; }
  const nowMs = Date.now();
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
  const recovery = staleSection();
  if (recovery) {
    const recoveryHtml = staleCompactHtml(nowMs);
    recovery.hidden = !recoveryHtml;
    recovery.innerHTML = recoveryHtml;
  }
}

function onClick(event) {
  const control = event.target.closest('[data-pc-action]');
  if (!control) return;
  const action = control.dataset.pcAction;
  const id = control.dataset.id;
  event.preventDefault();
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
    case 'expand-stale': state.expanded.stale = true; render(); break;
    case 'collapse-stale': state.expanded.stale = false; render(); break;
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
    dateInput.value = taskDateHint(editing.anchorTarget);
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
