import { classifyRoutineActual, computeReadyNow, normalizePreparation, planningConsistency, planTomorrowTargetDate } from './plan-tomorrow-model.js';
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
  const learningRepresented = draft.routines.rows.some(row => row.routine.source === 'learning');
  if (!learningRepresented) {
    const plans = createLearningPlanRepository().listPlans();
    const next = plans.map(plan => ({ plan, step: findNextLearningPlanStep(plan) })).find(value => value.step);
    if (next) suggestions.push({ task: next.step.stepTitle, tag: 'learning' });
  }
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

function itemHtml() {
  const items = activeItems();
  const overCap = items.length > context().maxItems;
  const rows = items.map(item => `<div class="pt-oneoff"><div>${item.when ? `<span class="plan-when">${escape(item.when)} →</span> ` : ''}${escape(item.task)}</div><button type="button" class="plan-remove" data-pt-action="remove" data-id="${escape(item.id)}" title="Remove">✕</button></div>`).join('');
  const add = items.length < context().maxItems ? `<form id="plan-tomorrow-add" class="pt-add"><input name="when" maxlength="40" placeholder="when (optional)"><input name="task" maxlength="80" placeholder="one priority"><button class="btn sm" type="submit">Add</button></form>` : '';
  const warning = overCap ? `<div class="pt-warning">${items.length} priorities arrived from synced devices. Nothing was deleted; reduce to ${context().maxItems} before confirming.</div>` : '';
  const suggestions = items.length < context().maxItems ? suggestionRows() : [];
  const chips = suggestions.length ? `<div class="pt-chips">${suggestions.map(item => `<button type="button" class="rv-plan-chip ${escape(item.tag)}" data-pt-action="suggest" data-task="${escape(item.task)}">${escape(item.task)}<span class="rv-chip-tag">${escape(item.tag)}</span></button>`).join('')}</div>` : '';
  return warning + (rows || '<p class="pt-muted">No one-off priorities yet.</p>') + add + chips;
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
  body.innerHTML = draft.mode === 'rescue' ? renderRescue() : renderNormal();
  document.getElementById('plan-tomorrow-confirm').textContent = draft.mode === 'rescue' ? 'Use this plan' : 'Tomorrow is ready';
  error.textContent = '';
}

export function openPlanTomorrow() {
  try {
    const app = context();
    const targetDate = planTomorrowTargetDate(Date.now(), app.timezone);
    const plan = app.plan(targetDate);
    const preparation = normalizePreparation(plan?.preparation, targetDate);
    draft = {
      targetDate,
      timezone: app.timezone,
      items: app.rawItems(targetDate).map(item => ({ ...item })),
      routines: routinePlan(targetDate, app.timezone),
      mode: 'normal',
      intentionalBlank: preparation?.intentionalBlank || false
    };
    root.classList.add('open');
    render();
  } catch (err) {
    globalThis.showToast(err.message);
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
  root.classList.remove('open');
  const cloudSynced = await Promise.resolve(result.syncPromise).catch(() => false);
  globalThis.showToast(cloudSynced ? 'Tomorrow is ready' : 'Ready on this device');
}

root?.addEventListener('click', async event => {
  if (event.target === root) { root.classList.remove('open'); return; }
  const control = event.target.closest('[data-pt-action], [data-pt-mode]');
  if (!control || !draft) return;
  try {
    if (control.dataset.ptMode) { draft.mode = control.dataset.ptMode; render(); return; }
    const action = control.dataset.ptAction;
    if (action === 'close') { root.classList.remove('open'); return; }
    if (action === 'blank') { draft.intentionalBlank = !draft.intentionalBlank; render(); return; }
    if (action === 'remove') draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem({ ...item, deleted: true }) : item);
    if (action === 'suggest') addItem(control.dataset.task);
    if (action === 'skip' || action === 'unskip') {
      routineRepository.setDateSkip(draft.routines.state.timezone, control.dataset.id, action === 'skip');
      refreshRoutines();
      if (action === 'unskip') draft.intentionalBlank = false;
    }
    if (action === 'confirm') { await confirmDraft(); return; }
    render();
  } catch (err) { error.textContent = err.message; }
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
    return { id, title: routine.title, status: classifyRoutineActual({ occurs, skipped: !!state.skips[id], completion }) };
  }).filter(row => ids.has(row.id));
}

globalThis.openPlanTomorrow = openPlanTomorrow;
globalThis.getPlanTomorrowRoutineSummary = getPlanTomorrowRoutineSummary;
globalThis.getPlanTomorrowRoutineActual = getPlanTomorrowRoutineActual;
