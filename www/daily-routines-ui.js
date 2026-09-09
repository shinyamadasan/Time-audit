import { localContext, instanceId, generateInstances, matchCompletion, scheduleState, dailyScore, routineStreak, validateRoutine } from './daily-routines-model.js';
import { createDailyRoutineRepository } from './daily-routines-repository.js';
import { createLocalLifeLedgerStore } from './life-ledger-runtime.js';
import { createLearningPlanRepository } from './learning-plan-repository.js';
import { findNextLearningPlanStep } from './learning-plan-next-action.js';

const repository = createDailyRoutineRepository();
const root = document.getElementById('daily-routines');
const list = document.getElementById('daily-routines-list');
const error = document.getElementById('daily-routines-error');
const dialog = document.getElementById('daily-routine-dialog');
const form = document.getElementById('daily-routine-form');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let view = null;
let rendered = '';
let editingId = null;
const initialTimezone = () => globalThis.getDailyRoutineAppContext().timezone;
const message = err => { error.textContent = err?.message || String(err); };

function readView() {
  const context = globalThis.getDailyRoutineAppContext();
  let state = repository.read(context.timezone);
  const now = Date.now();
  const date = localContext(now, state.timezone).date;
  const plans = createLearningPlanRepository().listPlans();
  const events = createLocalLifeLedgerStore().listEvents();
  const allInstances = generateInstances(state.routines, date, state.timezone);
  const skipped = allInstances.filter(item => state.skips[item.id]);
  const instances = allInstances.filter(item => !state.skips[item.id]);
  const bindings = {};
  for (const item of instances.filter(i => i.routine.source === 'learning')) {
    const plan = plans.find(p => p.id === item.routine.planId);
    const current = state.links[item.id];
    if (!current) {
      const next = findNextLearningPlanStep(plan);
      if (next) bindings[item.id] = { ...next, planId: plan.id, planTitle: plan.title };
    }
  }
  if (Object.keys(bindings).length) state = repository.update(context.timezone, s => Object.assign(s.links, bindings));
  const input = { ...state, events, entries: context.entries };
  return { state, instances, skipped, plans, input, now, date, browsingHistory: context.browsingHistory };
}
function scheduleLabel(r) {
  if (r.mode === 'exact') return r.time;
  if (r.mode === 'window') return `${r.time}–${r.endTime}`;
  return r.mode === 'cue' ? r.cue : 'Anytime today';
}
function button(action, id, label) {
  return `<button type="button" class="btn sm" data-routine-action="${action}" data-routine-id="${escape(id)}">${label}</button>`;
}
function renderCard(item, completion, status) {
  const r = item.routine;
  const link = view.state.links[item.id];
  const complete = completion && completion.level !== 'incomplete';
  const streak = routineStreak(r, view.date, date => {
    const historical = { ...item, id: instanceId(r.id, date), date };
    const result = matchCompletion(historical, view.input, view.now);
    return !!result && result.level !== 'incomplete';
  });
  const hasStep = r.source !== 'learning' || (link && link.planId === r.planId && view.plans.some(p => p.id === link.planId && p.phases.some(ph => ph.lessons.some(l => l.steps.some(s => s.id === link.stepId)))));
  let actions = !complete ? button('skip', r.id, 'Skip today') : '';
  if (!complete && r.source === 'manual') {
    actions = button('done', r.id, 'Done') + (r.minimumMinutes ? button('minimum', r.id, 'Minimum done') : '') + actions;
  }
  if (view.state.manual[item.id]) actions += button('undo', r.id, 'Undo manual Done');
  if (!complete && ['learning', 'focus'].includes(r.source) && hasStep) actions = button('start', r.id, 'Start Focus') + actions;
  let note = '';
  if (r.source === 'workout' && !complete) note = 'Completion appears when a matching workout is imported.';
  if (r.source === 'learning' && !hasStep) note = 'No unfinished step available today.';
  if (completion?.source === 'ambiguous') note = 'Multiple facts or routines match this intention. Automatic completion is unavailable; inspect the source facts and routine configuration.';
  if (completion?.level === 'incomplete' && completion.duration) note = `${completion.duration} min recorded · below minimum/target.`;
  return `<article class="daily-routine-card" data-instance-id="${escape(item.id)}">
    <div><strong>${complete ? '✓ ' : ''}${escape(r.title)}</strong>
    ${r.source === 'learning' && hasStep ? `<div>${escape(link.stepTitle)}</div>` : ''}
    <div class="routine-meta">${escape(scheduleLabel(r))} · Target ${r.targetMinutes} min${r.minimumMinutes ? ` · Minimum ${r.minimumMinutes} min` : ''}</div>
    <div class="routine-meta">${escape(status.label)}${completion ? ` · ${completion.source === 'manual' ? 'Manual assertion' : 'Source completion'}` : ''}${streak ? ` · ${streak} consecutive calendar day${streak === 1 ? '' : 's'}` : ''}</div>
    ${note ? `<div class="routine-meta">${escape(note)}</div>` : ''}</div><div class="routine-actions">${actions}</div></article>`;
}
export function renderDailyRoutines() {
  if (!root || typeof globalThis.getDailyRoutineAppContext !== 'function') return;
  try {
    view = readView();
    root.hidden = view.browsingHistory;
    const rows = view.instances.map(item => {
      const completion = matchCompletion(item, view.input, view.now);
      return { item, completion, status: scheduleState(item, view.now, completion) };
    });
    const upcoming = rows.filter(row => row.status.group === 'Next').sort((a, b) => a.item.routine.time.localeCompare(b.item.routine.time) || a.item.routine.id.localeCompare(b.item.routine.id));
    upcoming.slice(1).forEach(row => { row.status.group = 'Later'; });
    const score = dailyScore(rows.map(row => row.completion));
    const ambiguous = rows.filter(row => row.completion?.source === 'ambiguous');
    document.getElementById('routine-needs-item').hidden = !ambiguous.length;
    document.getElementById('routine-needs-copy').textContent = ambiguous.length ? `${ambiguous.length} routine${ambiguous.length === 1 ? '' : 's'} with ambiguous evidence. Resolve the source match to clear this item.` : '';
    let html = '';
    const relevant = rows.filter(row => ['Now', 'Anytime'].includes(row.status.group));
    document.getElementById('routine-compact').innerHTML = relevant.slice(0, 2).map(row => `<div class="commitment-routine">${escape(row.item.routine.title)} <span>${escape(row.status.label)}</span></div>`).join('');
    document.getElementById('routine-summary').textContent = rows.length ? `${relevant.length} due · ${score.completed}/${score.planned} complete` : '';
    document.getElementById('routine-details').hidden = !rows.length && !view.skipped.length;
    html += `<p>${score.completed} / ${score.planned} planned routines completed${score.minimum ? ` · ${score.minimum} at minimum` : ''}</p>`;

    for (const group of ['Now', 'Next', 'Later', 'Anytime', 'Done']) {
      const members = rows.filter(row => row.status.group === group).sort((a, b) => (a.item.routine.time || '').localeCompare(b.item.routine.time || '') || a.item.routine.id.localeCompare(b.item.routine.id));
      if (members.length) html += `<section aria-label="${group}"><h3>${group}</h3>${members.map(row => renderCard(row.item, row.completion, row.status)).join('')}</section>`;
    }
    if (view.skipped.length) html += `<details class="routine-skipped"><summary>Skipped today (${view.skipped.length})</summary>${view.skipped.map(item => `<div class="routine-actions" data-instance-id="${escape(item.id)}">${escape(item.routine.title)} ${button('restore', item.routineId, 'Restore today')}</div>`).join('')}</details>`;
    if (html !== rendered) { list.innerHTML = html; rendered = html; }
    error.textContent = '';
    globalThis.renderTodayActionStrip?.();
  } catch (err) { view = null; message(err); }
}
function updateFields() {
  const mode = form.elements.mode.value;
  for (const el of form.querySelectorAll('[data-modes]')) el.hidden = !el.dataset.modes.split(' ').includes(mode);
  form.querySelector('[data-weekdays]').hidden = form.elements.cadence.value !== 'selected';
  form.querySelector('[data-learning]').hidden = form.elements.source.value !== 'learning';
  form.querySelector('[data-workout]').hidden = form.elements.source.value !== 'workout';
}
function openEditor(id) {
  view = readView();
  editingId = id || null;
  const r = view.state.routines.find(item => item.id === id) || { title: '', enabled: true, cadence: 'daily', mode: 'anytime', targetMinutes: 15, minimumMinutes: '', source: 'manual', days: [] };
  form.reset();
  form.elements.planId.innerHTML = '<option value="">Choose a Learning Plan</option>' + view.plans.map(p => `<option value="${escape(p.id)}">${escape(p.title)}</option>`).join('');
  for (const field of ['title', 'cadence', 'mode', 'time', 'endTime', 'cue', 'targetMinutes', 'minimumMinutes', 'fallback', 'source', 'planId', 'workoutRoutineId']) form.elements[field].value = r[field] ?? '';
  form.elements.enabled.checked = r.enabled;
  form.querySelectorAll('[name="days"]').forEach(el => { el.checked = r.days.includes(Number(el.value)); });
  form.querySelector('[data-form-error]').textContent = '';
  updateFields();
  dialog.showModal();
}
form.addEventListener('change', updateFields);
form.addEventListener('submit', event => {
  event.preventDefault();
  try {
    const data = new globalThis.FormData(form);
    repository.update(initialTimezone(), state => {
      const previous = state.routines.find(r => r.id === editingId);
      const routine = {
        id: previous?.id || globalThis.crypto.randomUUID(), createdDate: previous?.createdDate || localContext(Date.now(), state.timezone).date,
        title: data.get('title').trim(), enabled: data.has('enabled'), cadence: data.get('cadence'), days: data.getAll('days').map(Number),
        mode: data.get('mode'), time: data.get('time'), endTime: data.get('endTime'), cue: data.get('cue').trim(), targetMinutes: Number(data.get('targetMinutes')),
        minimumMinutes: data.get('minimumMinutes') ? Number(data.get('minimumMinutes')) : null, fallback: data.get('fallback').trim(), source: data.get('source'), planId: data.get('planId'), workoutRoutineId: data.get('workoutRoutineId').trim()
      };
      validateRoutine(routine);
      if (routine.enabled && ['workout', 'learning'].includes(routine.source) && state.routines.some(r => r.id !== routine.id && r.enabled && r.source === routine.source && (r.source === 'workout' ? (!r.workoutRoutineId || !routine.workoutRoutineId || r.workoutRoutineId === routine.workoutRoutineId) : r.planId === routine.planId))) throw new Error('Use one routine per completion source/link in V1 to avoid ambiguous completion.');
      const index = state.routines.findIndex(r => r.id === routine.id);
      if (index < 0) state.routines.push(routine); else state.routines[index] = routine;
      if (previous && (previous.source !== routine.source || previous.planId !== routine.planId)) delete state.links[instanceId(routine.id, localContext(Date.now(), state.timezone).date)];
    });
    dialog.close(); renderDailyRoutines();
  } catch (err) { form.querySelector('[data-form-error]').textContent = err.message; }
});
document.getElementById('daily-routine-cancel').addEventListener('click', () => dialog.close());
document.addEventListener('click', event => {
  const control = event.target.closest('[data-routine-action]');
  if (!control) return;
  try {
    const action = control.dataset.routineAction;
    const id = control.dataset.routineId;
    if (action === 'manage') {
      view = readView();
      document.getElementById('routine-manager-list').innerHTML = view.state.routines.map(r => `<p>${escape(r.title)} · ${r.enabled ? scheduleLabel(r) : 'Disabled'} ${button('edit', r.id, 'Edit')}</p>`).join('');
      document.getElementById('routine-manager').showModal();
      return;
    }
    if (action === 'edit' || action === 'add') { document.getElementById('routine-manager').close(); openEditor(id); return; }
    performRoutineAction(action, id, control.closest('[data-instance-id]')?.dataset.instanceId);
    renderDailyRoutines();
  } catch (err) { renderDailyRoutines(); message(err); }
});
function performRoutineAction(action, id, clickedId) {
  view = readView();
  const item = [...view.instances, ...view.skipped].find(i => i.routineId === id && i.id === clickedId);
  if (!item) throw new Error('The day or routine changed. Please use the refreshed Today card.');
  if (action === 'skip') repository.setDateSkip(view.state.timezone, item.id, true);
  if (action === 'restore') repository.setDateSkip(view.state.timezone, item.id, false);
  if (['done', 'minimum', 'undo'].includes(action)) repository.manualDone(view.state.timezone, item.id, action === 'undo' ? null : action === 'minimum' ? 'minimum' : 'complete');
  if (action === 'start') {
    const r = item.routine;
    let learningPlan = null;
    if (r.source === 'learning') {
      const plan = view.plans.find(p => p.id === r.planId);
      const next = findNextLearningPlanStep(plan);
      if (!next || next.stepId !== view.state.links[item.id]?.stepId) throw new Error('This step changed or is complete. Open Learning Plans to continue.');
      learningPlan = { ...next, planId: plan.id, planTitle: plan.title };
    }
    const started = globalThis.enterFocusMode({ task: learningPlan?.stepTitle || r.title, context: learningPlan?.planTitle || r.title, learningPlan, dailyRoutine: r.source === 'focus' ? { instanceId: item.id, timezone: item.timezone } : null, workMinutes: r.targetMinutes, autoStart: true });
    if (started === false) throw new Error('Focus is already running. Nothing new was started.');
  }
}
// Persist the source session identity before starting; a same-device takeover can reuse it.
globalThis.onDailyRoutineFocusStarted = (link, startedAt) => {
  // Let the Start action surface storage errors before the timer starts.
  repository.update(initialTimezone(), state => { state.focusLaunch = { ...link, startedAt }; });
  return true;
};
// Called only by the existing full work-session completion path, never partial exit.
globalThis.onDailyRoutineFocusCompleted = (entry, startedAt, endedAt) => {
  try {
    const link = repository.read(initialTimezone()).focusLaunch;
    if (!link || link.startedAt !== startedAt) return;
    repository.update(initialTimezone(), state => {
      if (!state.routines.some(r => instanceId(r.id, localContext(startedAt, link.timezone).date) === link.instanceId)) throw new Error('The routine linkage no longer exists.');
      state.focus[String(entry.id)] = { instanceId: link.instanceId, entryId: String(entry.id), startedAt, endedAt, duration: entry.blockIntervalMin };
      state.focusLaunch = null;
    });
    renderDailyRoutines();
  } catch (err) { message(err); globalThis.showToast(`Focus saved; routine completion could not be saved: ${err.message}`); }
};
globalThis.renderDailyRoutines = renderDailyRoutines;
window.addEventListener('storage', renderDailyRoutines);
window.addEventListener('focus', renderDailyRoutines);
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderDailyRoutines(); });
window.setInterval(() => { if (!document.hidden && root.closest('.view')?.classList.contains('active')) renderDailyRoutines(); }, 30000);
renderDailyRoutines();

function routineAction(group) {
  if (!view || view.browsingHistory) return null;
  const candidates = view.instances.filter(item => {
    const completion = matchCompletion(item, view.input, view.now);
    if (completion && completion.level !== 'incomplete') return false;
    if (scheduleState(item, view.now, completion).group !== group) return false;
    const r = item.routine;
    if (r.source === 'manual' || r.source === 'focus') return true;
    if (r.source !== 'learning') return false;
    const next = findNextLearningPlanStep(view.plans.find(p => p.id === r.planId));
    return !!next && next.stepId === view.state.links[item.id]?.stepId;
  }).sort((a, b) => (a.routine.time || '').localeCompare(b.routine.time || '') || a.routine.id.localeCompare(b.routine.id));
  const item = candidates[0];
  if (!item) return null;
  const focusLinked = item.routine.source !== 'manual';
  return { instanceId: item.id, routineId: item.routineId, title: view.state.links[item.id]?.stepTitle || item.routine.title, task: item.routine.title, focusLinked, sub: scheduleLabel(item.routine), button: focusLinked ? 'Start' : 'Done' };
}
globalThis.getTodayRoutineAction = routineAction;
globalThis.startTodayRoutineAction = () => {
  try {
    view = readView();
    const action = routineAction('Now') || routineAction('Anytime');
    if (!action) throw new Error('The routine changed. Please use the refreshed Up Next action.');
    performRoutineAction(action.focusLinked ? 'start' : 'done', action.routineId, action.instanceId);
    renderDailyRoutines();
  } catch (err) { renderDailyRoutines(); message(err); }
};
renderDailyRoutines();
