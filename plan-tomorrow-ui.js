import { classifyOneOffActual, classifyRoutineActual, computeReadyNow, formatPlanItemTime, normalizePreparation, planningConsistency, planTomorrowTargetDate, reconciliationBucket, validPlanItemTime } from './plan-tomorrow-model.js';
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

function routinePlan(targetDate, timezone) {
  const state = routineRepository.read(timezone);
  if (state.timezone !== timezone) return { state, mismatch: true, rows: [] };
  const learningPlans = createLearningPlanRepository().listPlans();
  const rows = generateInstances(state.routines, targetDate, state.timezone).map(instance => {
    const learningPlan = instance.routine.source === 'learning' ? learningPlans.find(plan => plan.id === instance.routine.planId) : null;
    const likelyNext = learningPlan ? findNextLearningPlanStep(learningPlan) : null;
    return { ...instance, skipped: !!state.skips[instance.id], actionable: instance.routine.source !== 'learning' || !!likelyNext, likelyNext };
  });
  return { state, mismatch: false, rows };
}

function activeItems() {
  return draft.items.filter(item => !item.deleted);
}

function activeRoutines() {
  return draft.routines.rows.filter(row => !row.skipped && row.actionable);
}

/** Today's one-off priorities relevant to Daily Reconciliation: classified via the same
 *  classifyOneOffActual authority the Review "Plan vs Actual" widget already uses, then bucketed
 *  into completed/unfinished. Deleted-after-prep items ('removed') are excluded — nothing to
 *  reconcile once an item is gone. Routines are out of scope: they already recur/skip on their
 *  own cadence, and "carry forward" has no analog for them. */
function buildReconciliation(app) {
  const todayKey = app.todayKey;
  // Reconciliation is supplementary context for the Plan Tomorrow flow, never a precondition for
  // it — a classification failure here degrades to an empty section instead of blocking planning.
  try {
    const preparation = normalizePreparation(app.plan(todayKey)?.preparation, todayKey);
    const rows = app.rawItems(todayKey)
      .filter(item => !item.deleted)
      .map(item => {
        const trackedMinutes = app.trackedMinutes(item.task, todayKey, item.id);
        const status = classifyOneOffActual(item, { targetDate: todayKey, timezone: app.timezone, trackedMinutes, preparedAt: preparation?.firstPreparedAt || 0 });
        return { item, status, bucket: reconciliationBucket(status) };
      })
      .filter(row => row.bucket !== 'excluded');
    return { todayKey, rows };
  } catch {
    return { todayKey, rows: [] };
  }
}

/** The tomorrow-draft item (if any) already carrying this today item forward, keyed by the
 *  carriedFromId provenance field — lets the control reflect "already carried" and prevents
 *  clicking Carry twice from creating duplicate tomorrow items. */
function carriedItemFor(todayItemId) {
  return draft.items.find(item => item.carriedFromId === todayItemId && !item.deleted) || null;
}

function toggleCarry(todayItemId) {
  const row = draft.reconciliation?.rows.find(r => r.item.id === todayItemId);
  if (!row) return;
  const existing = carriedItemFor(todayItemId);
  if (existing) {
    draft.items = draft.items.map(item => item.id === existing.id ? context().stampItem({ ...item, deleted: true }) : item);
    return;
  }
  if (activeItems().length >= context().maxItems) throw new Error(`Reduce tomorrow's plan to ${context().maxItems} priorities before carrying this forward.`);
  draft.items.push({ ...context().createItem(row.item.task, ''), carriedFromId: todayItemId });
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
  const todayKey = draft.reconciliation.todayKey;
  const updated = context().rawItems(todayKey).map(item =>
    item.id === todayItemId ? context().stampItem(withReconciliationReason(item, reason)) : item);
  context().saveItems(todayKey, updated);
  draft.reconciliation.rows = draft.reconciliation.rows.map(row =>
    row.item.id === todayItemId ? { ...row, item: withReconciliationReason(row.item, reason) } : row);
}

function formatTargetDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function refreshRoutines() {
  draft.routines = routinePlan(draft.targetDate, draft.timezone);
}

function suggestionRows() {
  const selected = new Set(activeItems().map(item => context().normalizeTask(item.task)));
  const suggestions = context().suggestions(draft.targetDate).slice();
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
  if (!draft.routines.rows.length) return '<p class="pt-muted">No routines occur on this date.</p>';
  return draft.routines.rows.map(row => {
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

function timeControlHtml(item) {
  const timed = validPlanItemTime(item.when);
  if (draft.editingWhenId === item.id) {
    return `<input type="time" class="pt-time-input" data-pt-time="${escape(item.id)}" aria-label="Set time for ${escape(item.task)}" value="${timed ? escape(item.when) : ''}">`;
  }
  if (timed) {
    return `<span class="pt-time-value">${escape(formatPlanItemTime(item.when))}</span>
      <button type="button" class="pt-time-link" data-pt-action="edit-time" data-id="${escape(item.id)}" aria-label="Change time for ${escape(item.task)}">Change</button>
      <span aria-hidden="true"> · </span>
      <button type="button" class="pt-time-link" data-pt-action="remove-time" data-id="${escape(item.id)}" aria-label="Remove time for ${escape(item.task)}">Remove time</button>`;
  }
  return `<button type="button" class="pt-time-link add" data-pt-action="edit-time" data-id="${escape(item.id)}" aria-label="Set time for ${escape(item.task)}">+ Add time</button>`;
}

function itemHtml() {
  const items = activeItems();
  const overCap = items.length > context().maxItems;
  const rows = items.map(item => {
    const timed = validPlanItemTime(item.when);
    const legacyWhen = !timed && item.when ? `<span class="plan-when">${escape(item.when)} →</span> ` : '';
    return `<div class="pt-oneoff" data-pt-item="${escape(item.id)}">
      <div class="pt-oneoff-main">
        <div class="pt-oneoff-task">${legacyWhen}${escape(item.task)}</div>
        <div class="pt-oneoff-time">${timeControlHtml(item)}</div>
      </div>
      <button type="button" class="plan-remove" data-pt-action="remove" data-id="${escape(item.id)}" title="Remove">✕</button>
    </div>`;
  }).join('');
  const add = items.length < context().maxItems ? `<form id="plan-tomorrow-add" class="pt-add"><input name="when" maxlength="40" placeholder="when (optional)"><input name="task" maxlength="80" placeholder="one priority"><button class="btn sm" type="submit">Add</button></form>` : '';
  const warning = overCap ? `<div class="pt-warning">${items.length} priorities arrived from synced devices. Nothing was deleted; reduce to ${context().maxItems} before confirming.</div>` : '';
  const suggestions = items.length < context().maxItems ? suggestionRows() : [];
  const chips = suggestions.length ? `<div class="pt-chips">${suggestions.map(item => `<button type="button" class="rv-plan-chip ${escape(item.tag)}" data-pt-action="suggest" data-task="${escape(item.task)}">${escape(item.task)}<span class="rv-chip-tag">${escape(item.tag)}</span></button>`).join('')}</div>` : '';
  return warning + (rows || '<p class="pt-muted">No one-off priorities yet.</p>') + add + chips;
}

function reconciliationHtml() {
  const reconciliation = draft.reconciliation;
  if (!reconciliation || !reconciliation.rows.length) return '';
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
  const actionable = activeRoutines().length + activeItems().filter(item => !item.done).length;
  return `<section><h3>Routines already included</h3>${routineHtml()}</section>
    <section><h3>One-off priorities <span>${activeItems().length}/${context().maxItems}</span></h3>${itemHtml()}</section>
    ${actionable ? '' : `<button type="button" class="btn ghost pt-open-day${draft.intentionalBlank ? ' selected' : ''}" data-pt-action="blank">${draft.intentionalBlank ? '✓ ' : ''}Open day / no commitments</button>`}`;
}

function renderRescue() {
  const routines = activeRoutines().length;
  const priorities = activeItems().filter(item => !item.done).length;
  if (routines + priorities) return `<div class="pt-rescue"><h3>${routines || 'No'} routine${routines === 1 ? '' : 's'} · ${priorities || 'no'} priorit${priorities === 1 ? 'y' : 'ies'}</h3><p>Use this plan as it is. No additional scheduling decisions needed.</p>${draft.routines.mismatch ? routineHtml() : ''}</div>`;
  return `<div class="pt-rescue"><h3>Keep it minimal</h3><form id="plan-tomorrow-rescue-add" class="pt-add"><input name="task" maxlength="80" placeholder="one anytime priority"><button class="btn sm" type="submit">Add</button></form><span class="pt-or">or</span><button type="button" class="btn ghost pt-open-day${draft.intentionalBlank ? ' selected' : ''}" data-pt-action="blank">${draft.intentionalBlank ? '✓ ' : ''}Open day / no commitments</button></div>`;
}

function render() {
  if (!draft || !body) return;
  document.getElementById('plan-tomorrow-date').textContent = formatTargetDate(draft.targetDate);
  document.getElementById('plan-tomorrow-timezone').textContent = draft.timezone;
  const storedPlan = context().plan(draft.targetDate);
  const readyNow = computeReadyNow({ plan: storedPlan, targetDate: draft.targetDate, routines: draft.routines.rows });
  const consistency = planningConsistency(storedPlan?.preparation, draft.targetDate);
  const readiness = document.getElementById('plan-tomorrow-readiness');
  readiness.textContent = `${readyNow ? 'Ready now' : 'Not ready'} · ${consistency === 'ahead' ? 'prepared ahead' : consistency === 'late' ? 'prepared late' : consistency === 'unknown' ? 'preparation unknown' : 'not prepared'}`;
  readiness.dataset.ready = String(readyNow);
  document.querySelectorAll('[data-pt-mode]').forEach(button => button.classList.toggle('selected', button.dataset.ptMode === draft.mode));
  body.innerHTML = reconciliationHtml() + (draft.mode === 'rescue' ? renderRescue() : renderNormal());
  document.getElementById('plan-tomorrow-confirm').textContent = draft.mode === 'rescue' ? 'Use this plan' : 'Tomorrow is ready';
  error.textContent = '';
  if (draft.editingWhenId) [...body.querySelectorAll('.pt-time-input')].find(input => input.dataset.ptTime === draft.editingWhenId)?.focus();
}

export function openPlanTomorrow({ returnToReview = false } = {}) {
  try {
    const app = context();
    const targetDate = planTomorrowTargetDate(Date.now(), app.timezone);
    const plan = app.plan(targetDate);
    const preparation = normalizePreparation(plan?.preparation, targetDate);
    draft = {
      targetDate,
      returnToReview,
      timezone: app.timezone,
      items: app.rawItems(targetDate).map(item => ({ ...item })),
      routines: routinePlan(targetDate, app.timezone),
      mode: 'normal',
      intentionalBlank: preparation?.intentionalBlank || false,
      editingWhenId: null,
      reconciliation: buildReconciliation(app)
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

function addItem(task, when = '') {
  if (activeItems().length >= context().maxItems) throw new Error(`Reduce the plan to ${context().maxItems} priorities first.`);
  draft.items.push(context().createItem(task, when));
  draft.intentionalBlank = false;
}

async function confirmDraft() {
  const unfinishedItems = activeItems().filter(item => !item.done);
  const routines = activeRoutines();
  if (activeItems().length > context().maxItems) throw new Error(`Reduce the plan to ${context().maxItems} priorities before confirming.`);
  const intentionalBlank = routines.length + unfinishedItems.length === 0 && draft.intentionalBlank;
  if (!routines.length && !unfinishedItems.length && !intentionalBlank) throw new Error('Add one priority, keep a routine, or choose Open day.');
  const result = context().confirm({
    targetDate: draft.targetDate,
    items: draft.items.map(item => ({ ...item })),
    mode: draft.mode,
    intentionalBlank,
    routineInstanceIds: draft.routines.rows.filter(row => row.actionable).map(row => row.id),
    actionableRoutineInstanceIds: routines.map(row => row.id)
  });
  const savedPlan = context().plan(draft.targetDate);
  if (!result.localSaved || !computeReadyNow({ plan: savedPlan, targetDate: draft.targetDate, routines })) throw new Error('Tomorrow could not be marked ready. Your draft is still open.');
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
    if (action === 'remove') draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem({ ...item, deleted: true }) : item);
    if (action === 'edit-time') draft.editingWhenId = control.dataset.id;
    if (action === 'remove-time') {
      draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem({ ...item, when: '' }) : item);
      draft.editingWhenId = null;
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
  draft.items = draft.items.map(item => item.id === id ? context().stampItem({ ...item, when: input.value }) : item);
  draft.editingWhenId = null;
  render();
});

root?.addEventListener('change', event => {
  const textarea = event.target.closest('.pt-reconcile-reason');
  if (!textarea || !draft?.reconciliation) return;
  try { saveReconciliationReason(textarea.dataset.ptReason, textarea.value); }
  catch (err) { error.textContent = err.message; }
});

root?.addEventListener('focusout', event => {
  const input = event.target.closest('.pt-time-input');
  if (!input || !draft || draft.editingWhenId !== input.dataset.ptTime) return;
  draft.editingWhenId = null;
  render();
});

root?.addEventListener('submit', event => {
  if (!event.target.matches('#plan-tomorrow-add, #plan-tomorrow-rescue-add')) return;
  event.preventDefault();
  try {
    const data = new FormData(event.target);
    const task = String(data.get('task') || '').trim();
    if (!task) throw new Error('Name the priority first.');
    addItem(task, String(data.get('when') || '').trim());
    render();
  } catch (err) { error.textContent = err.message; }
});

export function getPlanTomorrowRoutineSummary(targetDate, timezone = context().timezone) {
  return routinePlan(targetDate, timezone);
}

export function getPlanTomorrowRoutineActual(targetDate, preparation) {
  const timezone = preparation.timezone;
  const state = routineRepository.read(timezone);
  const entries = context().entries;
  const events = createLocalLifeLedgerStore().listEvents();
  const ids = new Set(preparation.routineInstanceIds);
  return preparation.routineInstanceIds.map(id => {
    let routineId;
    try { [routineId] = JSON.parse(id); } catch { return { id, title: 'Unknown routine', status: 'removed' }; }
    const routine = state.routines.find(item => item.id === routineId);
    const occurs = !!routine && state.timezone === timezone && routine.enabled && occursOn(routine, targetDate);
    if (!occurs) return { id, title: routine?.title || 'Removed routine', status: 'removed' };
    const instance = generateInstances([routine], targetDate, state.timezone)[0];
    const completion = matchCompletion(instance, { ...state, events, entries }, Date.now());
    return { id, title: routine.title, taskLabel: state.links[id]?.stepTitle || routine.title, status: classifyRoutineActual({ occurs, skipped: !!state.skips[id], completion }) };
  }).filter(row => ids.has(row.id));
}

globalThis.openPlanTomorrow = openPlanTomorrow;
globalThis.getPlanTomorrowRoutineSummary = getPlanTomorrowRoutineSummary;
globalThis.getPlanTomorrowRoutineActual = getPlanTomorrowRoutineActual;
