import {
  addLesson,
  addPhase,
  addStep,
  completeStep,
  createLearningPlan,
  getLearningPlanProgress,
  renameLesson,
  renamePhase,
  renamePlan,
  renameStep,
  reopenStep
} from './learning-plan-model.js';
import { createLearningPlanRepository } from './learning-plan-repository.js';

let repository = null;
let learningPlans = [];
let selectedPlanId = null;
let initialized = false;
let busy = false;
let learningPlansAvailable = true;

function ensureRepository() {
  if (!repository) repository = createLearningPlanRepository();
  return repository;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showLearningPlanError(message) {
  const el = document.getElementById('learning-plan-error');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function selectedPlan() {
  return learningPlans.find(plan => plan.id === selectedPlanId) || null;
}

function setSelectedPlan(nextId) {
  selectedPlanId = learningPlans.some(plan => plan.id === nextId)
    ? nextId
    : (learningPlans[0]?.id || null);
}

function loadLearningPlans() {
  try {
    const plans = ensureRepository().listPlans();
    learningPlans = plans;
    learningPlansAvailable = true;
    setSelectedPlan(selectedPlanId);
    showLearningPlanError('');
    return { ok: true, plans };
  } catch (err) {
    learningPlansAvailable = false;
    const message = `Learning Plan storage could not be loaded: ${err.message}`;
    showLearningPlanError(message);
    return { ok: false, error: err, message };
  }
}

function setLearningPlanControlsAvailable(available) {
  const create = document.querySelector('.learning-plan-create');
  if (create) create.hidden = !available;
}

function renderLearningPlansUnavailable(message) {
  setLearningPlanControlsAvailable(false);
  const list = document.getElementById('learning-plan-list');
  const main = document.getElementById('learning-plan-main');
  if (list) list.innerHTML = '';
  if (main) {
    main.innerHTML = `
      <div class="learning-plan-unavailable">
        <div class="learning-plan-unavailable-title">Learning Plans unavailable</div>
        <div class="learning-plan-muted">${escapeHtml(message || "We couldn't load your saved Learning Plans. Your stored data was left unchanged.")}</div>
      </div>
    `;
  }
}

function replaceLocalPlan(plan) {
  const existingIndex = learningPlans.findIndex(existing => existing.id === plan.id);
  learningPlans = existingIndex === -1
    ? [...learningPlans, plan]
    : learningPlans.map(existing => existing.id === plan.id ? plan : existing);
  setSelectedPlan(plan.id);
}

function saveLearningPlan(plan, failureMessage = 'Could not save Learning Plan changes. Nothing was changed.') {
  try {
    const saved = ensureRepository().savePlan(plan);
    replaceLocalPlan(saved);
    showLearningPlanError('');
    renderLearningPlanState();
    return true;
  } catch (err) {
    showLearningPlanError(`${failureMessage} ${err.message}`);
    renderLearningPlanState();
    return false;
  }
}

function removeLearningPlan(planId) {
  try {
    const result = ensureRepository().removePlan(planId);
    if (result.removed) {
      learningPlans = learningPlans.filter(plan => plan.id !== planId);
      setSelectedPlan(selectedPlanId === planId ? null : selectedPlanId);
    }
    showLearningPlanError('');
    renderLearningPlanState();
  } catch (err) {
    showLearningPlanError(`Could not remove Learning Plan. Nothing was changed. ${err.message}`);
    renderLearningPlanState();
  }
}

function progressLabel(plan) {
  const progress = getLearningPlanProgress(plan);
  return `${progress.completedSteps} / ${progress.totalSteps} steps - ${progress.completionPercent}%`;
}

function renderPlanList() {
  const list = document.getElementById('learning-plan-list');
  if (!list) return;
  if (!learningPlans.length) {
    list.innerHTML = '<div class="empty learning-plan-empty">No Learning Plans yet.</div>';
    return;
  }
  list.innerHTML = learningPlans.map(plan => `
    <button type="button" class="learning-plan-list-item${plan.id === selectedPlanId ? ' active' : ''}"
      data-lp-action="select-plan" data-plan-id="${escapeHtml(plan.id)}" aria-pressed="${plan.id === selectedPlanId ? 'true' : 'false'}">
      <span class="learning-plan-list-title">${escapeHtml(plan.title)}</span>
      <span class="learning-plan-list-progress">${escapeHtml(progressLabel(plan))}</span>
    </button>
  `).join('');
}

function renderLearningPlanState() {
  renderPlanList();
  const main = document.getElementById('learning-plan-main');
  if (!main) return;
  const plan = selectedPlan();
  if (!plan) {
    main.innerHTML = '<div class="empty learning-plan-empty">Create a Learning Plan to start a checklist.</div>';
    return;
  }
  const progress = getLearningPlanProgress(plan);
  main.innerHTML = `
    <div class="learning-plan-detail">
      <div class="learning-plan-detail-head">
        <div class="field learning-plan-title-field">
          <label for="learning-plan-title-${escapeHtml(plan.id)}">Plan title</label>
          <textarea id="learning-plan-title-${escapeHtml(plan.id)}" rows="2"
            data-lp-action="rename-plan" data-plan-id="${escapeHtml(plan.id)}" maxlength="120">${escapeHtml(plan.title)}</textarea>
        </div>
        <button type="button" class="btn sm danger" data-lp-action="remove-plan" data-plan-id="${escapeHtml(plan.id)}">Delete</button>
      </div>
      <div class="learning-plan-progress" aria-live="polite">
        <span>${progress.completedSteps} / ${progress.totalSteps} steps</span>
        <strong>${progress.completionPercent}%</strong>
      </div>
      <form class="learning-plan-add-row" data-lp-action="add-phase" data-plan-id="${escapeHtml(plan.id)}">
        <label class="sr-only" for="learning-plan-new-phase-${escapeHtml(plan.id)}">Phase title</label>
        <input id="learning-plan-new-phase-${escapeHtml(plan.id)}" type="text" name="title" maxlength="120" placeholder="New phase">
        <button type="submit" class="btn sm">Add phase</button>
      </form>
      <div class="learning-plan-phases">
        ${plan.phases.length ? plan.phases.map(phase => renderPhase(plan, phase)).join('') : '<div class="learning-plan-muted">No phases yet.</div>'}
      </div>
    </div>
  `;
}

function renderPhase(plan, phase) {
  return `
    <section class="learning-plan-phase" aria-labelledby="learning-plan-phase-title-${escapeHtml(phase.id)}">
      <div class="learning-plan-row learning-plan-phase-row">
        <label class="sr-only" for="learning-plan-phase-title-${escapeHtml(phase.id)}">Phase title</label>
        <textarea id="learning-plan-phase-title-${escapeHtml(phase.id)}" class="learning-plan-inline-title" rows="1"
          data-lp-action="rename-phase" data-plan-id="${escapeHtml(plan.id)}"
          data-phase-id="${escapeHtml(phase.id)}" maxlength="120">${escapeHtml(phase.title)}</textarea>
      </div>
      <div class="learning-plan-lessons">
        ${phase.lessons.length ? phase.lessons.map(lesson => renderLesson(plan, phase, lesson)).join('') : '<div class="learning-plan-muted">No lessons yet.</div>'}
      </div>
      <form class="learning-plan-add-row learning-plan-add-nested" data-lp-action="add-lesson" data-plan-id="${escapeHtml(plan.id)}" data-phase-id="${escapeHtml(phase.id)}">
        <label class="sr-only" for="learning-plan-new-lesson-${escapeHtml(phase.id)}">Lesson title</label>
        <input id="learning-plan-new-lesson-${escapeHtml(phase.id)}" type="text" name="title" maxlength="120" placeholder="New lesson">
        <button type="submit" class="btn sm">Add lesson</button>
      </form>
    </section>
  `;
}

function renderLesson(plan, phase, lesson) {
  return `
    <section class="learning-plan-lesson" aria-labelledby="learning-plan-lesson-title-${escapeHtml(lesson.id)}">
      <div class="learning-plan-row learning-plan-lesson-row">
        <label class="sr-only" for="learning-plan-lesson-title-${escapeHtml(lesson.id)}">Lesson title</label>
        <textarea id="learning-plan-lesson-title-${escapeHtml(lesson.id)}" class="learning-plan-inline-title" rows="1"
          data-lp-action="rename-lesson" data-plan-id="${escapeHtml(plan.id)}"
          data-phase-id="${escapeHtml(phase.id)}" data-lesson-id="${escapeHtml(lesson.id)}" maxlength="120">${escapeHtml(lesson.title)}</textarea>
      </div>
      <div class="learning-plan-steps">
        ${lesson.steps.length ? lesson.steps.map(step => renderStep(plan, lesson, step)).join('') : '<div class="learning-plan-muted">No steps yet.</div>'}
      </div>
      <form class="learning-plan-add-row learning-plan-add-nested" data-lp-action="add-step" data-plan-id="${escapeHtml(plan.id)}" data-lesson-id="${escapeHtml(lesson.id)}">
        <label class="sr-only" for="learning-plan-new-step-${escapeHtml(lesson.id)}">Step title</label>
        <input id="learning-plan-new-step-${escapeHtml(lesson.id)}" type="text" name="title" maxlength="140" placeholder="New step">
        <button type="submit" class="btn sm">Add step</button>
      </form>
    </section>
  `;
}

function renderStep(plan, lesson, step) {
  return `
    <div class="learning-plan-step${step.completed ? ' done' : ''}">
      <input type="checkbox" ${step.completed ? 'checked' : ''}
        data-lp-action="toggle-step" data-plan-id="${escapeHtml(plan.id)}"
        data-lesson-id="${escapeHtml(lesson.id)}" data-step-id="${escapeHtml(step.id)}"
        aria-label="${escapeHtml(step.completed ? 'Reopen step' : 'Complete step')}: ${escapeHtml(step.title)}">
      <textarea class="learning-plan-step-title" rows="1"
        data-lp-action="rename-step" data-plan-id="${escapeHtml(plan.id)}"
        data-lesson-id="${escapeHtml(lesson.id)}" data-step-id="${escapeHtml(step.id)}" maxlength="140"
        aria-label="Step title">${escapeHtml(step.title)}</textarea>
      <span class="learning-plan-step-state">${step.completed ? 'Complete' : 'Open'}</span>
    </div>
  `;
}

function currentPlanFromDataset(target) {
  const plan = learningPlans.find(item => item.id === target.dataset.planId);
  if (!plan) throw new Error('The selected Learning Plan no longer exists');
  return plan;
}

function trimmedTitleFromForm(form) {
  const input = form.elements.title;
  return String(input?.value || '').trim();
}

function runExclusive(fn) {
  if (busy) return;
  busy = true;
  try {
    fn();
  } finally {
    busy = false;
  }
}

function handleCreatePlan(event) {
  event.preventDefault();
  runExclusive(() => {
    if (!learningPlansAvailable) {
      showLearningPlanError("Learning Plans are unavailable. Your stored data was left unchanged.");
      return;
    }
    const input = document.getElementById('learning-plan-title-input');
    const title = String(input?.value || '').trim();
    if (!title) {
      showLearningPlanError('Enter a Learning Plan title before creating it.');
      return;
    }
    const plan = createLearningPlan({ title });
    if (saveLearningPlan(plan, 'Could not create Learning Plan. Nothing was saved.')) {
      input.value = '';
    }
  });
}

function handleSubmit(event) {
  const form = event.target.closest('form[data-lp-action]');
  if (!form) return;
  event.preventDefault();
  runExclusive(() => {
    try {
      const title = trimmedTitleFromForm(form);
      if (!title) {
        showLearningPlanError('Enter a title before adding it.');
        return;
      }
      const plan = currentPlanFromDataset(form);
      let nextPlan = plan;
      if (form.dataset.lpAction === 'add-phase') {
        nextPlan = addPhase(plan, { title });
      } else if (form.dataset.lpAction === 'add-lesson') {
        nextPlan = addLesson(plan, form.dataset.phaseId, { title });
      } else if (form.dataset.lpAction === 'add-step') {
        nextPlan = addStep(plan, form.dataset.lessonId, { title });
      }
      if (saveLearningPlan(nextPlan)) form.reset();
    } catch (err) {
      showLearningPlanError(`Could not update Learning Plan. Nothing was changed. ${err.message}`);
      renderLearningPlanState();
    }
  });
}

function handleClick(event) {
  const target = event.target.closest('[data-lp-action]');
  if (!target) return;
  if (target.dataset.lpAction === 'select-plan') {
    setSelectedPlan(target.dataset.planId);
    renderLearningPlanState();
    return;
  }
  if (target.dataset.lpAction === 'remove-plan') {
    const plan = currentPlanFromDataset(target);
    if (window.confirm(`Delete Learning Plan "${plan.title}"?`)) removeLearningPlan(plan.id);
  }
}

function handleChange(event) {
  const target = event.target.closest('[data-lp-action]');
  if (!target) return;
  const action = target.dataset.lpAction;
  if (!action.startsWith('rename-') && action !== 'toggle-step') return;
  runExclusive(() => {
    try {
      const plan = currentPlanFromDataset(target);
      let nextPlan = plan;
      if (action === 'toggle-step') {
        nextPlan = target.checked
          ? completeStep(plan, target.dataset.stepId)
          : reopenStep(plan, target.dataset.stepId);
      } else {
        const title = String(target.value || '').trim();
        if (!title) {
          showLearningPlanError('Titles cannot be blank.');
          renderLearningPlanState();
          return;
        }
        if (action === 'rename-plan') nextPlan = renamePlan(plan, title);
        if (action === 'rename-phase') nextPlan = renamePhase(plan, target.dataset.phaseId, title);
        if (action === 'rename-lesson') nextPlan = renameLesson(plan, target.dataset.lessonId, title);
        if (action === 'rename-step') nextPlan = renameStep(plan, target.dataset.stepId, title);
      }
      saveLearningPlan(nextPlan);
    } catch (err) {
      showLearningPlanError(`Could not update Learning Plan. Nothing was changed. ${err.message}`);
      renderLearningPlanState();
    }
  });
}

function initLearningPlans() {
  if (initialized) return;
  initialized = true;
  const createForm = document.getElementById('learning-plan-create-form');
  const main = document.getElementById('learning-plan-main');
  const list = document.getElementById('learning-plan-list');
  if (createForm) createForm.addEventListener('submit', handleCreatePlan);
  if (main) {
    main.addEventListener('submit', handleSubmit);
    main.addEventListener('click', handleClick);
    main.addEventListener('change', handleChange);
  }
  if (list) list.addEventListener('click', handleClick);
}

export function renderLearningPlans() {
  initLearningPlans();
  const load = loadLearningPlans();
  if (!load.ok) {
    renderLearningPlansUnavailable("We couldn't load your saved Learning Plans. Your stored data was left unchanged.");
    return;
  }
  setLearningPlanControlsAvailable(true);
  renderLearningPlanState();
}

window.renderLearningPlans = renderLearningPlans;
initLearningPlans();
