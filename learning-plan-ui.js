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
import { parseLearningPlanOutline } from './learning-plan-import.js';
import { createLearningPlanRepository } from './learning-plan-repository.js';
import { findNextLearningPlanStep } from './learning-plan-next-action.js';
import {
  learningPlanStepSourceEntityId,
  recordLearningPlanFocusSessionCompleted,
  recordLearningPlanStepCompleted,
  recordLearningPlanStepReopened
} from './life-ledger-runtime.js';

let repository = null;
let learningPlans = [];
let selectedPlanId = null;
let initialized = false;
let busy = false;
let learningPlansAvailable = true;
let importPreview = null;
let importPreviewFingerprint = '';
let openCreationPanel = null;
let learningGuideOpen = false;
let expansionPlanId = null;
let activeAddEditor = null;
let activeRenameEditor = null;
let pendingFocusOutcome = null;
let focusOutcomeBusy = false;
let pendingLedgerRetries = new Map();
const expandedPhaseIds = new Set();
const expandedLessonIds = new Set();

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

function applyCreationPanelVisibility() {
  const actions = document.querySelector('.learning-plan-entry-actions');
  const create = document.querySelector('.learning-plan-create');
  const importSection = document.querySelector('.learning-plan-import');
  const showControls = learningPlansAvailable;
  if (actions) actions.hidden = !showControls;
  if (create) create.hidden = !showControls || openCreationPanel !== 'manual';
  if (importSection) importSection.hidden = !showControls || openCreationPanel !== 'import';
  document.querySelector('[data-lp-action="show-import"]')?.setAttribute('aria-expanded', openCreationPanel === 'import' ? 'true' : 'false');
  document.querySelector('[data-lp-action="show-create"]')?.setAttribute('aria-expanded', openCreationPanel === 'manual' ? 'true' : 'false');
}

function applyLearningGuideVisibility() {
  const button = document.querySelector('[data-lp-action="toggle-guide"]');
  const guide = document.getElementById('learning-plan-guide');
  if (button) button.setAttribute('aria-expanded', learningGuideOpen ? 'true' : 'false');
  if (guide) guide.hidden = !learningGuideOpen;
}

function setLearningPlanControlsAvailable(available) {
  learningPlansAvailable = available;
  if (!available) openCreationPanel = null;
  applyCreationPanelVisibility();
}

function renderLearningPlansUnavailable(message) {
  setLearningPlanControlsAvailable(false);
  const list = document.getElementById('learning-plan-list');
  const main = document.getElementById('learning-plan-main');
  if (list) list.innerHTML = '';
  if (main) {
    main.innerHTML = `
      ${renderLearningPlanFocusOutcome()}
      ${renderLearningPlanLedgerRetry()}
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

function importInputValues() {
  const title = String(document.getElementById('learning-plan-import-title-input')?.value || '').trim();
  const outline = String(document.getElementById('learning-plan-import-outline')?.value || '');
  return { title, outline };
}

function importInputFingerprint(values = importInputValues()) {
  return JSON.stringify([values.title, values.outline]);
}

function formatImportCounts(counts) {
  return `${counts.phases} ${counts.phases === 1 ? 'phase' : 'phases'} - ${counts.lessons} ${counts.lessons === 1 ? 'lesson' : 'lessons'} - ${counts.steps} ${counts.steps === 1 ? 'step' : 'steps'}`;
}

function clearImportPreview() {
  importPreview = null;
  importPreviewFingerprint = '';
  renderImportPreview();
}

function resetImportTransient() {
  document.getElementById('learning-plan-import-form')?.reset();
  clearImportPreview();
}

function setImportBusy(nextBusy) {
  const form = document.getElementById('learning-plan-import-form');
  if (!form) return;
  form.querySelectorAll('button').forEach(button => {
    if (button.dataset.lpImportAction === 'import') button.disabled = nextBusy || !importPreview || importInputFingerprint() !== importPreviewFingerprint;
    else button.disabled = nextBusy;
  });
}

function renderImportPreview() {
  const preview = document.getElementById('learning-plan-import-preview');
  const importButton = document.querySelector('[data-lp-import-action="import"]');
  if (importButton) importButton.disabled = !importPreview || importInputFingerprint() !== importPreviewFingerprint;
  if (!preview) return;
  preview.replaceChildren();
  if (!importPreview) {
    preview.hidden = true;
    return;
  }

  preview.hidden = false;
  const title = document.createElement('div');
  title.className = 'learning-plan-import-preview-title';
  title.textContent = importPreview.title;
  preview.append(title);

  const counts = document.createElement('div');
  counts.className = 'learning-plan-import-counts';
  counts.textContent = formatImportCounts(importPreview.parsed.counts);
  preview.append(counts);

  const list = document.createElement('ol');
  list.className = 'learning-plan-import-phases';
  importPreview.parsed.phases.forEach(phaseDraft => {
    const phase = document.createElement('li');
    const phaseTitle = document.createElement('span');
    phaseTitle.className = 'learning-plan-import-phase-title';
    phaseTitle.textContent = phaseDraft.title;
    phase.append(phaseTitle);

    const lessons = document.createElement('ol');
    lessons.className = 'learning-plan-import-lessons';
    phaseDraft.lessons.forEach(lessonDraft => {
      const lesson = document.createElement('li');
      const lessonTitle = document.createElement('span');
      lessonTitle.className = 'learning-plan-import-lesson-title';
      lessonTitle.textContent = lessonDraft.title;
      lesson.append(lessonTitle);

      const steps = document.createElement('ul');
      steps.className = 'learning-plan-import-steps';
      lessonDraft.steps.forEach(stepDraft => {
        const step = document.createElement('li');
        step.textContent = stepDraft.title;
        steps.append(step);
      });
      lesson.append(steps);
      lessons.append(lesson);
    });
    phase.append(lessons);
    list.append(phase);
  });
  preview.append(list);
}

function buildImportedLearningPlan(title, parsed) {
  let plan = createLearningPlan({ title });
  parsed.phases.forEach(phaseDraft => {
    const phaseIndex = plan.phases.length;
    plan = addPhase(plan, { title: phaseDraft.title });
    const phaseId = plan.phases[phaseIndex].id;
    phaseDraft.lessons.forEach(lessonDraft => {
      const lessonIndex = plan.phases[phaseIndex].lessons.length;
      plan = addLesson(plan, phaseId, { title: lessonDraft.title });
      const lessonId = plan.phases[phaseIndex].lessons[lessonIndex].id;
      lessonDraft.steps.forEach(stepDraft => {
        plan = addStep(plan, lessonId, { title: stepDraft.title });
      });
    });
  });
  return plan;
}

function showImportParseErrors(errors) {
  showLearningPlanError(errors.map(item => {
    const found = String(item.content || '').trim();
    const suffix = [
      found ? `Found: ${found}.` : '',
      item.expected ? `Expected: ${item.expected}.` : ''
    ].filter(Boolean).join(' ');
    return suffix ? `${item.message} ${suffix}` : item.message;
  }).join(' '));
}

function saveLearningPlan(plan, failureMessage = 'Could not save Learning Plan changes. Nothing was changed.', options = {}) {
  const renderOnSuccess = options.renderOnSuccess !== false;
  const renderOnFailure = options.renderOnFailure !== false;
  try {
    const saved = ensureRepository().savePlan(plan);
    replaceLocalPlan(saved);
    showLearningPlanError('');
    if (renderOnSuccess) renderLearningPlanState();
    return saved;
  } catch (err) {
    showLearningPlanError(`${failureMessage} ${err.message}`);
    if (renderOnFailure) renderLearningPlanState();
    return null;
  }
}

function planStepLedgerRetryKey(planId, stepId) {
  return `chronasense:${learningPlanStepSourceEntityId(planId, stepId)}:plan_step_completed`;
}

function focusLedgerRetryKey(outcome) {
  const focusEntryId = String(outcome?.focusEntryId || '').trim();
  return focusEntryId ? `chronasense:${focusEntryId}:focus_session_completed` : '';
}

function clearPendingLedgerRetry(retryKey) {
  if (!retryKey) return;
  pendingLedgerRetries.delete(retryKey);
}

function rememberPendingLedgerRetry(retryKey, message, retry) {
  if (!retryKey) return;
  pendingLedgerRetries.set(retryKey, { message, retry, baseMessage: message });
}

function lifeLedgerFailureMessage(err) {
  return err?.message || String(err || 'Life Ledger write failed');
}

function renderLearningPlanLedgerRetry() {
  const retries = Array.from(pendingLedgerRetries.entries());
  if (retries.length === 0) return '';
  const countLabel = retries.length === 1 ? '1 pending write' : `${retries.length} pending writes`;
  return `
    <section class="learning-plan-ledger-retry" aria-label="Life Ledger retry" aria-live="polite">
      <div class="learning-plan-ledger-retry-body">
        <div class="learning-plan-ledger-retry-text">Life Ledger history has ${escapeHtml(countLabel)}.</div>
        <div class="learning-plan-ledger-retry-list">
          ${retries.map(([retryKey, retry]) => `
            <div class="learning-plan-ledger-retry-item" data-ledger-retry-key="${escapeHtml(retryKey)}">${escapeHtml(retry.message)}</div>
          `).join('')}
        </div>
      </div>
      <button type="button" class="btn sm" data-lp-action="retry-ledger">Retry history</button>
    </section>
  `;
}

function retryPendingLedgerWrite() {
  if (pendingLedgerRetries.size === 0) return;
  let failed = 0;
  for (const [retryKey, pending] of Array.from(pendingLedgerRetries.entries())) {
    try {
      pending.retry();
      clearPendingLedgerRetry(retryKey);
    } catch (err) {
      failed++;
      const baseMessage = pending.baseMessage || pending.message;
      pendingLedgerRetries.set(retryKey, {
        ...pending,
        message: `${baseMessage} ${lifeLedgerFailureMessage(err)}`,
        baseMessage
      });
    }
  }
  showLearningPlanError(failed > 0
    ? `Life Ledger history is still pending. ${failed} write${failed === 1 ? '' : 's'} could not be retried.`
    : '');
  renderLearningPlanState();
}

function recordManualCompletionLedger(savedPlan, stepId) {
  const retryKey = planStepLedgerRetryKey(savedPlan.id, stepId);
  try {
    recordLearningPlanStepCompleted(savedPlan, stepId);
    clearPendingLedgerRetry(retryKey);
    showLearningPlanError('');
    return true;
  } catch (err) {
    const message = `Learning Plan step was saved, but Life Ledger history is pending. ${lifeLedgerFailureMessage(err)}`;
    rememberPendingLedgerRetry(retryKey, message, () => recordLearningPlanStepCompleted(savedPlan, stepId));
    showLearningPlanError(message);
    return false;
  }
}

function recordManualReopenLedger(previousPlan, stepId) {
  const retryKey = planStepLedgerRetryKey(previousPlan.id, stepId);
  try {
    recordLearningPlanStepReopened(previousPlan, stepId);
    clearPendingLedgerRetry(retryKey);
    showLearningPlanError('');
    return true;
  } catch (err) {
    const message = `Learning Plan step was reopened, but Life Ledger history is pending. ${lifeLedgerFailureMessage(err)}`;
    rememberPendingLedgerRetry(retryKey, message, () => recordLearningPlanStepReopened(previousPlan, stepId));
    showLearningPlanError(message);
    return false;
  }
}

function removeLearningPlan(planId) {
  try {
    const result = ensureRepository().removePlan(planId);
    if (result.removed) {
      learningPlans = learningPlans.filter(plan => plan.id !== planId);
      setSelectedPlan(selectedPlanId === planId ? null : selectedPlanId);
      expansionPlanId = null;
      activeAddEditor = null;
      activeRenameEditor = null;
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

function sectionKey(kind, id) {
  return `${kind}:${id}`;
}

function lessonProgress(lesson) {
  const total = lesson.steps.length;
  const completed = lesson.steps.filter(step => step.completed).length;
  return { completed, total };
}

function phaseProgress(phase) {
  return phase.lessons.reduce((sum, lesson) => {
    const next = lessonProgress(lesson);
    return {
      completed: sum.completed + next.completed,
      total: sum.total + next.total
    };
  }, { completed: 0, total: 0 });
}

function shortProgressLabel(progress) {
  return `${progress.completed} / ${progress.total}`;
}

function resetExpansionForPlan(plan) {
  expandedPhaseIds.clear();
  expandedLessonIds.clear();
  activeAddEditor = null;
  activeRenameEditor = null;
  expansionPlanId = plan?.id || null;
  if (!plan) return;
  const nextAction = findNextLearningPlanStep(plan);
  if (!nextAction) return;
  expandedPhaseIds.add(nextAction.phaseId);
  expandedLessonIds.add(nextAction.lessonId);
}

function ensureExpansionForPlan(plan) {
  if (!plan) {
    resetExpansionForPlan(null);
    return;
  }
  if (expansionPlanId !== plan.id) resetExpansionForPlan(plan);
}

function findPhaseForLesson(plan, lessonId) {
  return plan.phases.find(phase => phase.lessons.some(lesson => lesson.id === lessonId)) || null;
}

function expandAroundLesson(plan, lessonId) {
  const phase = findPhaseForLesson(plan, lessonId);
  if (phase) expandedPhaseIds.add(phase.id);
  expandedLessonIds.add(lessonId);
}

function findRenderedStep(stepId) {
  return Array.from(document.querySelectorAll('[data-lp-step-target]'))
    .find(item => item.dataset.lpStepTarget === stepId) || null;
}

function focusRenderedStep(stepId) {
  window.requestAnimationFrame(() => {
    const target = findRenderedStep(stepId);
    if (!target) return;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.focus({ preventScroll: true });
  });
}

function openNextLearningPlanStep(nextAction) {
  expandedPhaseIds.add(nextAction.phaseId);
  expandedLessonIds.add(nextAction.lessonId);
  activeAddEditor = null;
  activeRenameEditor = null;
  renderLearningPlanState();
  focusRenderedStep(nextAction.stepId);
}

function nextActionMatchesTarget(nextAction, target) {
  return !!nextAction
    && nextAction.phaseId === target.dataset.phaseId
    && nextAction.lessonId === target.dataset.lessonId
    && nextAction.stepId === target.dataset.stepId;
}

function currentNextActionForControl(target) {
  if (target.dataset.planId !== selectedPlanId) {
    throw new Error('The selected Learning Plan changed. Nothing was started.');
  }
  const plan = selectedPlan();
  if (!plan || plan.id !== target.dataset.planId) {
    throw new Error('The selected Learning Plan no longer exists. Nothing was started.');
  }
  const nextAction = findNextLearningPlanStep(plan);
  if (!nextActionMatchesTarget(nextAction, target)) {
    throw new Error('The Next Action changed. Nothing was started.');
  }
  return { plan, nextAction };
}

function learningPlanFocusMetadata(plan, nextAction) {
  return {
    planId: plan.id,
    phaseId: nextAction.phaseId,
    lessonId: nextAction.lessonId,
    stepId: nextAction.stepId,
    planTitle: plan.title,
    phaseTitle: nextAction.phaseTitle,
    lessonTitle: nextAction.lessonTitle,
    stepTitle: nextAction.stepTitle
  };
}

function learningPlanFocusContext(metadata) {
  return [metadata.planTitle, metadata.phaseTitle, metadata.lessonTitle]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' · ');
}

function resetLearningPlanFocusStartControl(target) {
  target.disabled = false;
  delete target.dataset.lpFocusStarting;
}

function cloneLearningPlanFocusOutcome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const required = ['planId', 'phaseId', 'lessonId', 'stepId'];
  if (required.some(key => typeof value[key] !== 'string' || !value[key].trim())) return null;
  const focusEntryId = String(value.focusEntryId || '').trim();
  if (!focusEntryId) return null;
  return {
    outcomeId: `${focusEntryId}:${value.planId}:${value.phaseId}:${value.lessonId}:${value.stepId}`,
    planId: value.planId,
    phaseId: value.phaseId,
    lessonId: value.lessonId,
    stepId: value.stepId,
    planTitle: String(value.planTitle || ''),
    phaseTitle: String(value.phaseTitle || ''),
    lessonTitle: String(value.lessonTitle || ''),
    stepTitle: String(value.stepTitle || ''),
    focusEntryId,
    focusActivity: String(value.focusActivity || ''),
    focusStartedAt: Number(value.focusStartedAt || 0),
    focusEndedAt: Number(value.focusEndedAt || 0),
    focusDurationMin: Number(value.focusDurationMin || 0)
  };
}

function recordFocusOutcomeLedger(outcome) {
  const retryKey = focusLedgerRetryKey(outcome);
  if (outcome.focusLedgerRecorded === true) {
    clearPendingLedgerRetry(retryKey);
    return true;
  }
  try {
    recordLearningPlanFocusSessionCompleted(outcome);
    outcome.focusLedgerRecorded = true;
    outcome.focusLedgerError = '';
    clearPendingLedgerRetry(retryKey);
    return true;
  } catch (err) {
    outcome.focusLedgerRecorded = false;
    outcome.focusLedgerError = lifeLedgerFailureMessage(err);
    rememberPendingLedgerRetry(retryKey, `Focus session was saved, but Life Ledger history is pending. ${outcome.focusLedgerError}`, () => {
      recordLearningPlanFocusSessionCompleted(outcome);
      outcome.focusLedgerRecorded = true;
      outcome.focusLedgerError = '';
    });
    return false;
  }
}

function recordFocusOutcomeStepLedger(plan, outcome) {
  const retryKey = planStepLedgerRetryKey(plan.id, outcome.stepId);
  if (outcome.planStepLedgerRecorded === true) {
    clearPendingLedgerRetry(retryKey);
    return true;
  }
  try {
    recordLearningPlanStepCompleted(plan, outcome.stepId, {
      focusOutcome: outcome,
      trackedMinutes: outcome.focusDurationMin,
      captureMethod: 'pomodoro'
    });
    outcome.planStepLedgerRecorded = true;
    outcome.planStepLedgerError = '';
    clearPendingLedgerRetry(retryKey);
    return true;
  } catch (err) {
    outcome.planStepLedgerRecorded = false;
    outcome.planStepLedgerError = lifeLedgerFailureMessage(err);
    rememberPendingLedgerRetry(retryKey, `Learning Plan step was saved, but Life Ledger history is pending. ${outcome.planStepLedgerError}`, () => {
      recordLearningPlanStepCompleted(plan, outcome.stepId, {
        focusOutcome: outcome,
        trackedMinutes: outcome.focusDurationMin,
        captureMethod: 'pomodoro'
      });
      outcome.planStepLedgerRecorded = true;
      outcome.planStepLedgerError = '';
    });
    return false;
  }
}

function focusOutcomeLedgerStatus() {
  if (!pendingFocusOutcome) return '';
  const messages = [];
  if (pendingFocusOutcome.focusLedgerError) {
    messages.push(`Focus history pending: ${pendingFocusOutcome.focusLedgerError}`);
  }
  if (pendingFocusOutcome.planStepLedgerError) {
    messages.push(`Step completion history pending: ${pendingFocusOutcome.planStepLedgerError}`);
  }
  return messages.join(' ');
}

function renderLearningPlanFocusOutcome() {
  if (!pendingFocusOutcome) return '';
  const ledgerStatus = focusOutcomeLedgerStatus();
  return `
    <section class="learning-plan-focus-outcome" aria-label="Focus outcome" aria-live="polite">
      <div class="learning-plan-focus-outcome-kicker">Focus complete</div>
      <div class="learning-plan-focus-outcome-question">Did you finish this step?</div>
      <div class="learning-plan-focus-outcome-step">${escapeHtml(pendingFocusOutcome.stepTitle)}</div>
      <div class="learning-plan-focus-outcome-context">${escapeHtml(learningPlanFocusContext(pendingFocusOutcome))}</div>
      ${ledgerStatus ? `<div class="learning-plan-focus-outcome-warning">${escapeHtml(ledgerStatus)}</div>` : ''}
      <div class="learning-plan-focus-outcome-actions">
        <button type="button" class="btn primary sm" data-lp-action="focus-outcome-done"
          data-outcome-id="${escapeHtml(pendingFocusOutcome.outcomeId)}">Done</button>
        <button type="button" class="btn sm" data-lp-action="focus-outcome-continue"
          data-outcome-id="${escapeHtml(pendingFocusOutcome.outcomeId)}">Continue</button>
      </div>
    </section>
  `;
}

function showLearningPlansForFocusOutcome() {
  if (typeof window.showView === 'function') {
    window.showView('learning');
    return;
  }
  renderLearningPlans();
}

function findLearningPlanFocusTarget(plan, outcome) {
  const phase = plan?.phases?.find(item => item.id === outcome.phaseId);
  const lesson = phase?.lessons?.find(item => item.id === outcome.lessonId);
  const step = lesson?.steps?.find(item => item.id === outcome.stepId);
  if (!plan || !phase || !lesson || !step) return null;
  return { plan, phase, lesson, step };
}

function loadLearningPlansForFocusOutcome(outcome) {
  try {
    const plans = ensureRepository().listPlans();
    learningPlans = plans;
    learningPlansAvailable = true;
    selectedPlanId = outcome.planId;
    setSelectedPlan(selectedPlanId);
    return plans;
  } catch (err) {
    learningPlansAvailable = false;
    showLearningPlanError(`Could not load Learning Plan outcome. Nothing was changed. ${err.message}`);
    renderLearningPlanState();
    return null;
  }
}

function clearLearningPlanFocusOutcome() {
  pendingFocusOutcome = null;
  focusOutcomeBusy = false;
}

function completePendingFocusOutcome(target) {
  if (!pendingFocusOutcome || target.dataset.outcomeId !== pendingFocusOutcome.outcomeId || focusOutcomeBusy) return;
  focusOutcomeBusy = true;
  target.disabled = true;
  const outcome = pendingFocusOutcome;
  const focusLedgerRecorded = recordFocusOutcomeLedger(outcome);
  const plans = loadLearningPlansForFocusOutcome(outcome);
  if (!plans) {
    focusOutcomeBusy = false;
    return;
  }
  const plan = plans.find(item => item.id === outcome.planId) || null;
  const located = findLearningPlanFocusTarget(plan, outcome);
  if (!located) {
    showLearningPlanError('The Learning Plan step from this Focus session no longer exists. Nothing was completed.');
    focusOutcomeBusy = false;
    renderLearningPlanState();
    return;
  }
  if (located.step.completed === true) {
    const stepLedgerRecorded = outcome.planStepLedgerRecorded === false
      ? recordFocusOutcomeStepLedger(located.plan, outcome)
      : true;
    if (!focusLedgerRecorded || !stepLedgerRecorded) {
      focusOutcomeBusy = false;
      renderLearningPlanState();
      showLearningPlanError('Learning Plan step is saved, but Life Ledger history is still pending. Retry Done to finish recording history.');
      return;
    }
    clearLearningPlanFocusOutcome();
    resetExpansionForPlan(located.plan);
    expandAroundLesson(located.plan, outcome.lessonId);
    showLearningPlanError('');
    renderLearningPlanState();
    return;
  }

  const nextPlan = completeStep(located.plan, outcome.stepId);
  const saved = saveLearningPlan(nextPlan, 'Could not complete Learning Plan step. Nothing was changed.', {
    renderOnSuccess: false,
    renderOnFailure: false
  });
  if (!saved) {
    focusOutcomeBusy = false;
    renderLearningPlanState();
    return;
  }
  const stepLedgerRecorded = recordFocusOutcomeStepLedger(saved, outcome);
  if (!focusLedgerRecorded || !stepLedgerRecorded) {
    focusOutcomeBusy = false;
    resetExpansionForPlan(saved);
    expandAroundLesson(saved, outcome.lessonId);
    renderLearningPlanState();
    showLearningPlanError('Learning Plan step was saved, but Life Ledger history is still pending. Retry Done to finish recording history.');
    return;
  }
  clearLearningPlanFocusOutcome();
  resetExpansionForPlan(saved);
  expandAroundLesson(saved, outcome.lessonId);
  renderLearningPlanState();
}

function continuePendingFocusOutcome(target) {
  if (!pendingFocusOutcome || target.dataset.outcomeId !== pendingFocusOutcome.outcomeId || focusOutcomeBusy) return;
  focusOutcomeBusy = true;
  target.disabled = true;
  const outcome = pendingFocusOutcome;
  if (!recordFocusOutcomeLedger(outcome)) {
    focusOutcomeBusy = false;
    renderLearningPlanState();
    showLearningPlanError('Focus session was saved, but Life Ledger history is still pending. Retry Continue to finish recording history.');
    return;
  }
  clearLearningPlanFocusOutcome();
  const plans = loadLearningPlansForFocusOutcome(outcome);
  if (plans) {
    const plan = plans.find(item => item.id === outcome.planId) || selectedPlan();
    if (plan) {
      resetExpansionForPlan(plan);
      if (findLearningPlanFocusTarget(plan, outcome)) expandAroundLesson(plan, outcome.lessonId);
    }
    showLearningPlanError('');
  }
  renderLearningPlanState();
}

function receiveLearningPlanFocusOutcome(value) {
  const outcome = cloneLearningPlanFocusOutcome(value);
  if (!outcome) return false;
  if (pendingFocusOutcome?.outcomeId === outcome.outcomeId) return true;
  pendingFocusOutcome = outcome;
  focusOutcomeBusy = false;
  selectedPlanId = outcome.planId;
  showLearningPlansForFocusOutcome();
  if (!recordFocusOutcomeLedger(pendingFocusOutcome)) {
    renderLearningPlanState();
    showLearningPlanError('Focus session was saved, but Life Ledger history is pending. Use Done or Continue to retry recording history.');
  }
  return true;
}

function startNextLearningPlanFocus(target) {
  if (target.dataset.lpFocusStarting === '1') return;
  target.dataset.lpFocusStarting = '1';
  target.disabled = true;
  try {
    if (typeof window.enterFocusMode !== 'function') {
      throw new Error('Focus mode is unavailable. Nothing was started.');
    }
    const { plan, nextAction } = currentNextActionForControl(target);
    const metadata = learningPlanFocusMetadata(plan, nextAction);
    const started = window.enterFocusMode({
      task: metadata.stepTitle,
      context: learningPlanFocusContext(metadata),
      learningPlan: metadata,
      autoStart: true
    });
    if (started === false) {
      showLearningPlanError('Focus is already running. Nothing new was started.');
      resetLearningPlanFocusStartControl(target);
      return;
    }
    showLearningPlanError('');
    resetLearningPlanFocusStartControl(target);
  } catch (err) {
    showLearningPlanError(err.message || 'Could not start Focus. Nothing was changed.');
    resetLearningPlanFocusStartControl(target);
    renderLearningPlanState();
  }
}

function renderNextActionCard(plan, progress) {
  const nextAction = findNextLearningPlanStep(plan);
  if (!nextAction) {
    if (progress.totalSteps === 0) {
      return `
        <section class="learning-plan-next-card empty" aria-label="Learning Plan next action" aria-live="polite">
          <div class="learning-plan-next-label">NEXT ACTION</div>
          <div class="learning-plan-next-title">No steps yet</div>
          <div class="learning-plan-next-context">Add a step to begin.</div>
        </section>
      `;
    }
    return `
      <section class="learning-plan-next-card complete" aria-label="Learning Plan complete" aria-live="polite">
        <div class="learning-plan-next-label">PLAN COMPLETE</div>
        <div class="learning-plan-next-title">Plan complete</div>
        <div class="learning-plan-next-context">All ${progress.totalSteps} steps finished.</div>
      </section>
    `;
  }

  return `
    <section class="learning-plan-next-card" aria-labelledby="learning-plan-next-title">
      <div class="learning-plan-next-label">NEXT ACTION</div>
      <div class="learning-plan-next-title" id="learning-plan-next-title">${escapeHtml(nextAction.stepTitle)}</div>
      <div class="learning-plan-next-context">${escapeHtml(nextAction.phaseTitle)} - ${escapeHtml(nextAction.lessonTitle)}</div>
      <div class="learning-plan-next-actions">
        <button type="button" class="btn primary sm learning-plan-next-focus" data-lp-action="start-next-focus"
          data-plan-id="${escapeHtml(plan.id)}" data-phase-id="${escapeHtml(nextAction.phaseId)}"
          data-lesson-id="${escapeHtml(nextAction.lessonId)}" data-step-id="${escapeHtml(nextAction.stepId)}"
          aria-label="Start Focus: ${escapeHtml(nextAction.stepTitle)}">Start Focus</button>
        <button type="button" class="btn sm learning-plan-next-open" data-lp-action="open-next-step"
          data-plan-id="${escapeHtml(plan.id)}" data-phase-id="${escapeHtml(nextAction.phaseId)}"
          data-lesson-id="${escapeHtml(nextAction.lessonId)}" data-step-id="${escapeHtml(nextAction.stepId)}"
          aria-label="Open next step: ${escapeHtml(nextAction.stepTitle)}">Open step</button>
      </div>
    </section>
  `;
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
  applyCreationPanelVisibility();
  renderPlanList();
  const main = document.getElementById('learning-plan-main');
  if (!main) return;
  const plan = selectedPlan();
  ensureExpansionForPlan(plan);
  if (!plan) {
    main.innerHTML = `${renderLearningPlanFocusOutcome()}${renderLearningPlanLedgerRetry()}<div class="empty learning-plan-empty">Import a plan or create one manually to start a checklist.</div>`;
    return;
  }
  const progress = getLearningPlanProgress(plan);
  main.innerHTML = `
    ${renderLearningPlanFocusOutcome()}
    ${renderLearningPlanLedgerRetry()}
    <div class="learning-plan-detail">
      <div class="learning-plan-detail-head">
        <div class="learning-plan-title-block">
          ${renderTitleDisplay('plan', plan, plan.title)}
        </div>
        <button type="button" class="btn sm danger" data-lp-action="remove-plan" data-plan-id="${escapeHtml(plan.id)}">Delete</button>
      </div>
      <div class="learning-plan-progress" aria-live="polite">
        <span>${progress.completedSteps} / ${progress.totalSteps} steps</span>
        <strong>${progress.completionPercent}%</strong>
      </div>
      ${renderNextActionCard(plan, progress)}
      <div class="learning-plan-phases">
        ${plan.phases.length ? plan.phases.map(phase => renderPhase(plan, phase)).join('') : '<div class="learning-plan-muted">No phases yet.</div>'}
      </div>
      ${renderAddControl('phase', plan.id, { planId: plan.id })}
    </div>
  `;
}

function renderTitleDisplay(kind, plan, title, ids = {}) {
  const id = ids.stepId || ids.lessonId || ids.phaseId || plan.id;
  const key = sectionKey(kind, id);
  const dataset = [
    `data-plan-id="${escapeHtml(plan.id)}"`,
    ids.phaseId ? `data-phase-id="${escapeHtml(ids.phaseId)}"` : '',
    ids.lessonId ? `data-lesson-id="${escapeHtml(ids.lessonId)}"` : '',
    ids.stepId ? `data-step-id="${escapeHtml(ids.stepId)}"` : ''
  ].filter(Boolean).join(' ');
  if (activeRenameEditor === key) {
    return `
      <form class="learning-plan-rename-row" data-lp-action="rename-${kind}" ${dataset}>
        <label class="sr-only" for="learning-plan-rename-${escapeHtml(id)}">${kind} title</label>
        <input id="learning-plan-rename-${escapeHtml(id)}" type="text" name="title" maxlength="${kind === 'step' ? '140' : '120'}" value="${escapeHtml(title)}">
        <button type="submit" class="btn sm">Save</button>
        <button type="button" class="btn sm" data-lp-action="cancel-rename">Cancel</button>
      </form>
    `;
  }
  return `
    <div class="learning-plan-title-display learning-plan-${escapeHtml(kind)}-title-display">
      <span class="learning-plan-title-text">${escapeHtml(title)}</span>
      <button type="button" class="btn sm subtle" data-lp-action="open-rename" data-rename-key="${escapeHtml(key)}" ${dataset}>Edit</button>
    </div>
  `;
}

function renderPhase(plan, phase) {
  const expanded = expandedPhaseIds.has(phase.id);
  const progress = phaseProgress(phase);
  const contentId = `learning-plan-phase-content-${escapeHtml(phase.id)}`;
  return `
    <section class="learning-plan-phase" aria-labelledby="learning-plan-phase-title-${escapeHtml(phase.id)}">
      <div class="learning-plan-section-summary learning-plan-phase-summary">
        <button type="button" class="learning-plan-toggle" data-lp-action="toggle-phase"
          data-plan-id="${escapeHtml(plan.id)}" data-phase-id="${escapeHtml(phase.id)}"
          aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${contentId}"
          aria-label="${expanded ? 'Collapse' : 'Expand'} phase ${escapeHtml(phase.title)}">
          <span class="learning-plan-toggle-mark" aria-hidden="true">${expanded ? 'v' : '>'}</span>
          <span class="learning-plan-section-title" id="learning-plan-phase-title-${escapeHtml(phase.id)}">${escapeHtml(phase.title)}</span>
          <span class="learning-plan-section-progress">${shortProgressLabel(progress)}</span>
        </button>
        <button type="button" class="btn sm subtle" data-lp-action="open-rename"
          data-rename-key="${escapeHtml(sectionKey('phase', phase.id))}" data-plan-id="${escapeHtml(plan.id)}"
          data-phase-id="${escapeHtml(phase.id)}">Edit</button>
      </div>
      ${activeRenameEditor === sectionKey('phase', phase.id) ? renderTitleDisplay('phase', plan, phase.title, { phaseId: phase.id }) : ''}
      <div id="${contentId}" class="learning-plan-section-content learning-plan-phase-content" ${expanded ? '' : 'hidden'}>
        ${expanded ? `
          <div class="learning-plan-lessons">
            ${phase.lessons.length ? phase.lessons.map(lesson => renderLesson(plan, phase, lesson)).join('') : '<div class="learning-plan-muted">No lessons yet.</div>'}
          </div>
          ${renderAddControl('lesson', phase.id, { planId: plan.id, phaseId: phase.id })}
        ` : ''}
      </div>
    </section>
  `;
}

function renderLesson(plan, phase, lesson) {
  const expanded = expandedLessonIds.has(lesson.id);
  const progress = lessonProgress(lesson);
  const contentId = `learning-plan-lesson-content-${escapeHtml(lesson.id)}`;
  return `
    <section class="learning-plan-lesson" aria-labelledby="learning-plan-lesson-title-${escapeHtml(lesson.id)}">
      <div class="learning-plan-section-summary learning-plan-lesson-summary">
        <button type="button" class="learning-plan-toggle" data-lp-action="toggle-lesson"
          data-plan-id="${escapeHtml(plan.id)}" data-phase-id="${escapeHtml(phase.id)}"
          data-lesson-id="${escapeHtml(lesson.id)}" aria-expanded="${expanded ? 'true' : 'false'}"
          aria-controls="${contentId}" aria-label="${expanded ? 'Collapse' : 'Expand'} lesson ${escapeHtml(lesson.title)}">
          <span class="learning-plan-toggle-mark" aria-hidden="true">${expanded ? 'v' : '>'}</span>
          <span class="learning-plan-section-title" id="learning-plan-lesson-title-${escapeHtml(lesson.id)}">${escapeHtml(lesson.title)}</span>
          <span class="learning-plan-section-progress">${shortProgressLabel(progress)}</span>
        </button>
        <button type="button" class="btn sm subtle" data-lp-action="open-rename"
          data-rename-key="${escapeHtml(sectionKey('lesson', lesson.id))}" data-plan-id="${escapeHtml(plan.id)}"
          data-phase-id="${escapeHtml(phase.id)}" data-lesson-id="${escapeHtml(lesson.id)}">Edit</button>
      </div>
      ${activeRenameEditor === sectionKey('lesson', lesson.id) ? renderTitleDisplay('lesson', plan, lesson.title, { phaseId: phase.id, lessonId: lesson.id }) : ''}
      <div id="${contentId}" class="learning-plan-section-content learning-plan-lesson-content" ${expanded ? '' : 'hidden'}>
        ${expanded ? `
          <div class="learning-plan-steps">
            ${lesson.steps.length ? lesson.steps.map(step => renderStep(plan, lesson, step)).join('') : '<div class="learning-plan-muted">No steps yet.</div>'}
          </div>
          ${renderAddControl('step', lesson.id, { planId: plan.id, phaseId: phase.id, lessonId: lesson.id })}
        ` : ''}
      </div>
    </section>
  `;
}

function renderStep(plan, lesson, step) {
  return `
    <div class="learning-plan-step${step.completed ? ' done' : ''}" data-step-id="${escapeHtml(step.id)}"
      data-lp-step-target="${escapeHtml(step.id)}" tabindex="-1">
      <input type="checkbox" ${step.completed ? 'checked' : ''}
        data-lp-action="toggle-step" data-plan-id="${escapeHtml(plan.id)}"
        data-lesson-id="${escapeHtml(lesson.id)}" data-step-id="${escapeHtml(step.id)}"
        aria-label="${escapeHtml(step.completed ? 'Reopen step' : 'Complete step')}: ${escapeHtml(step.title)}">
      <div class="learning-plan-step-body">
        ${renderTitleDisplay('step', plan, step.title, { lessonId: lesson.id, stepId: step.id })}
      </div>
      <span class="learning-plan-step-state">${step.completed ? 'Complete' : 'Open'}</span>
    </div>
  `;
}

function renderAddControl(kind, ownerId, ids) {
  const key = sectionKey(kind, ownerId);
  const label = kind === 'phase' ? 'phase' : kind === 'lesson' ? 'lesson' : 'step';
  const maxLength = kind === 'step' ? '140' : '120';
  const dataset = [
    `data-plan-id="${escapeHtml(ids.planId)}"`,
    ids.phaseId ? `data-phase-id="${escapeHtml(ids.phaseId)}"` : '',
    ids.lessonId ? `data-lesson-id="${escapeHtml(ids.lessonId)}"` : ''
  ].filter(Boolean).join(' ');
  if (activeAddEditor !== key) {
    return `
      <button type="button" class="btn sm learning-plan-add-trigger" data-lp-action="open-add"
        data-add-key="${escapeHtml(key)}" data-add-kind="${escapeHtml(kind)}" ${dataset}>+ Add ${label}</button>
    `;
  }
  return `
    <form class="learning-plan-add-row${kind === 'phase' ? '' : ' learning-plan-add-nested'}" data-lp-action="add-${kind}" ${dataset}>
      <label class="sr-only" for="learning-plan-new-${escapeHtml(label)}-${escapeHtml(ownerId)}">${label} title</label>
      <input id="learning-plan-new-${escapeHtml(label)}-${escapeHtml(ownerId)}" type="text" name="title" maxlength="${maxLength}" placeholder="New ${escapeHtml(label)}">
      <button type="submit" class="btn sm">Add ${label}</button>
      <button type="button" class="btn sm" data-lp-action="cancel-add">Cancel</button>
    </form>
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

function updateExpansionAfterAdd(plan, form, nextPlan) {
  if (form.dataset.lpAction === 'add-phase') {
    const phase = nextPlan.phases[nextPlan.phases.length - 1];
    if (phase) expandedPhaseIds.add(phase.id);
    return;
  }
  if (form.dataset.lpAction === 'add-lesson') {
    expandedPhaseIds.add(form.dataset.phaseId);
    const phase = nextPlan.phases.find(item => item.id === form.dataset.phaseId);
    const lesson = phase?.lessons[phase.lessons.length - 1];
    if (lesson) expandedLessonIds.add(lesson.id);
    return;
  }
  if (form.dataset.lpAction === 'add-step') {
    expandAroundLesson(plan, form.dataset.lessonId);
  }
}

function handleAddSubmit(form) {
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
    const saved = saveLearningPlan(nextPlan, undefined, {
      renderOnSuccess: false,
      renderOnFailure: false
    });
    if (saved) {
      updateExpansionAfterAdd(plan, form, nextPlan);
      activeAddEditor = null;
      renderLearningPlanState();
    }
  } catch (err) {
    showLearningPlanError(`Could not update Learning Plan. Nothing was changed. ${err.message}`);
  }
}

function handleRenameSubmit(form) {
  try {
    const title = trimmedTitleFromForm(form);
    if (!title) {
      showLearningPlanError('Titles cannot be blank.');
      return;
    }
    const plan = currentPlanFromDataset(form);
    const action = form.dataset.lpAction;
    let nextPlan = plan;
    if (action === 'rename-plan') nextPlan = renamePlan(plan, title);
    if (action === 'rename-phase') nextPlan = renamePhase(plan, form.dataset.phaseId, title);
    if (action === 'rename-lesson') nextPlan = renameLesson(plan, form.dataset.lessonId, title);
    if (action === 'rename-step') nextPlan = renameStep(plan, form.dataset.stepId, title);
    const saved = saveLearningPlan(nextPlan, undefined, {
      renderOnSuccess: false,
      renderOnFailure: false
    });
    if (saved) {
      activeRenameEditor = null;
      renderLearningPlanState();
    }
  } catch (err) {
    showLearningPlanError(`Could not update Learning Plan. Nothing was changed. ${err.message}`);
  }
}

function handleImportPreview() {
  runExclusive(() => {
    if (!learningPlansAvailable) {
      showLearningPlanError("Learning Plans are unavailable. Your stored data was left unchanged.");
      return;
    }
    const values = importInputValues();
    if (!values.title) {
      showLearningPlanError('Enter a Learning Plan title before previewing it.');
      clearImportPreview();
      return;
    }
    const parsed = parseLearningPlanOutline(values.outline);
    if (!parsed.ok) {
      showImportParseErrors(parsed.errors);
      clearImportPreview();
      return;
    }
    importPreview = { title: values.title, parsed };
    importPreviewFingerprint = importInputFingerprint(values);
    showLearningPlanError('');
    renderImportPreview();
  });
}

function handleImportSubmit(event) {
  event.preventDefault();
  runExclusive(() => {
    if (!learningPlansAvailable) {
      showLearningPlanError("Learning Plans are unavailable. Your stored data was left unchanged.");
      return;
    }
    const values = importInputValues();
    if (!values.title) {
      showLearningPlanError('Enter a Learning Plan title before importing it.');
      clearImportPreview();
      return;
    }
    if (!importPreview || importInputFingerprint(values) !== importPreviewFingerprint) {
      showLearningPlanError('Preview the current title and outline before importing.');
      clearImportPreview();
      return;
    }
    setImportBusy(true);
    try {
      const parsed = parseLearningPlanOutline(values.outline);
      if (!parsed.ok) {
        showImportParseErrors(parsed.errors);
        clearImportPreview();
        return;
      }
      const plan = buildImportedLearningPlan(values.title, parsed);
      const saved = saveLearningPlan(plan, 'Could not import Learning Plan. Nothing was saved.', {
        renderOnSuccess: false,
        renderOnFailure: false
      });
      if (saved) {
        resetImportTransient();
        openCreationPanel = null;
        resetExpansionForPlan(saved);
        renderLearningPlanState();
      }
    } catch (err) {
      showLearningPlanError(`Could not import Learning Plan. Nothing was saved. ${err.message}`);
    } finally {
      setImportBusy(false);
      applyCreationPanelVisibility();
    }
  });
}

function handleImportInput() {
  if (importPreview && importInputFingerprint() !== importPreviewFingerprint) clearImportPreview();
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
    const saved = saveLearningPlan(plan, 'Could not create Learning Plan. Nothing was saved.', {
      renderOnSuccess: false,
      renderOnFailure: false
    });
    if (saved) {
      input.value = '';
      openCreationPanel = null;
      resetExpansionForPlan(saved);
      renderLearningPlanState();
    }
  });
}

function handleSubmit(event) {
  const form = event.target.closest('form[data-lp-action]');
  if (!form) return;
  event.preventDefault();
  runExclusive(() => {
    if (form.dataset.lpAction.startsWith('rename-')) handleRenameSubmit(form);
    else handleAddSubmit(form);
  });
}

function toggleSet(set, id) {
  if (set.has(id)) set.delete(id);
  else set.add(id);
}

function handleClick(event) {
  const target = event.target.closest('[data-lp-action]');
  if (!target) return;
  const action = target.dataset.lpAction;
  if (action === 'toggle-guide') {
    learningGuideOpen = !learningGuideOpen;
    applyLearningGuideVisibility();
    return;
  }
  if (action === 'show-import' || action === 'show-create') {
    openCreationPanel = action === 'show-import' ? 'import' : 'manual';
    applyCreationPanelVisibility();
    return;
  }
  if (action === 'cancel-creation') {
    openCreationPanel = null;
    applyCreationPanelVisibility();
    return;
  }
  if (action === 'select-plan') {
    setSelectedPlan(target.dataset.planId);
    resetExpansionForPlan(selectedPlan());
    renderLearningPlanState();
    return;
  }
  if (action === 'remove-plan') {
    const plan = currentPlanFromDataset(target);
    if (window.confirm(`Delete Learning Plan "${plan.title}"?`)) removeLearningPlan(plan.id);
    return;
  }
  if (action === 'open-next-step') {
    try {
      const { nextAction } = currentNextActionForControl(target);
      openNextLearningPlanStep(nextAction);
    } catch (err) {
      showLearningPlanError(err.message || 'The Next Action changed. Nothing was opened.');
      renderLearningPlanState();
    }
    return;
  }
  if (action === 'start-next-focus') {
    startNextLearningPlanFocus(target);
    return;
  }
  if (action === 'focus-outcome-done') {
    completePendingFocusOutcome(target);
    return;
  }
  if (action === 'focus-outcome-continue') {
    continuePendingFocusOutcome(target);
    return;
  }
  if (action === 'retry-ledger') {
    retryPendingLedgerWrite();
    return;
  }
  if (action === 'toggle-phase') {
    toggleSet(expandedPhaseIds, target.dataset.phaseId);
    activeAddEditor = null;
    activeRenameEditor = null;
    renderLearningPlanState();
    return;
  }
  if (action === 'toggle-lesson') {
    toggleSet(expandedLessonIds, target.dataset.lessonId);
    activeAddEditor = null;
    activeRenameEditor = null;
    renderLearningPlanState();
    return;
  }
  if (action === 'open-add') {
    activeAddEditor = target.dataset.addKey;
    activeRenameEditor = null;
    if (target.dataset.phaseId) expandedPhaseIds.add(target.dataset.phaseId);
    if (target.dataset.lessonId) expandAroundLesson(currentPlanFromDataset(target), target.dataset.lessonId);
    renderLearningPlanState();
    return;
  }
  if (action === 'cancel-add') {
    activeAddEditor = null;
    renderLearningPlanState();
    return;
  }
  if (action === 'open-rename') {
    activeRenameEditor = target.dataset.renameKey;
    activeAddEditor = null;
    renderLearningPlanState();
    return;
  }
  if (action === 'cancel-rename') {
    activeRenameEditor = null;
    renderLearningPlanState();
  }
}

function handleChange(event) {
  const target = event.target.closest('[data-lp-action]');
  if (!target) return;
  const action = target.dataset.lpAction;
  if (action !== 'toggle-step') return;
  runExclusive(() => {
    try {
      const plan = currentPlanFromDataset(target);
      const nextPlan = target.checked
        ? completeStep(plan, target.dataset.stepId)
        : reopenStep(plan, target.dataset.stepId);
      const saved = saveLearningPlan(nextPlan, undefined, {
        renderOnSuccess: false,
        renderOnFailure: false
      });
      if (!saved) {
        renderLearningPlanState();
        return;
      }
      if (target.checked) recordManualCompletionLedger(saved, target.dataset.stepId);
      else recordManualReopenLedger(plan, target.dataset.stepId);
      renderLearningPlanState();
    } catch (err) {
      showLearningPlanError(`Could not update Learning Plan. Nothing was changed. ${err.message}`);
      renderLearningPlanState();
    }
  });
}

function initLearningPlans() {
  if (initialized) return;
  initialized = true;
  const view = document.getElementById('view-learning');
  const createForm = document.getElementById('learning-plan-create-form');
  const importForm = document.getElementById('learning-plan-import-form');
  const main = document.getElementById('learning-plan-main');
  if (createForm) createForm.addEventListener('submit', handleCreatePlan);
  if (importForm) {
    importForm.addEventListener('submit', handleImportSubmit);
    importForm.addEventListener('input', handleImportInput);
    importForm.querySelector('[data-lp-import-action="preview"]')?.addEventListener('click', handleImportPreview);
  }
  if (main) {
    main.addEventListener('submit', handleSubmit);
    main.addEventListener('change', handleChange);
  }
  if (view) view.addEventListener('click', handleClick);
}

export function renderLearningPlans() {
  initLearningPlans();
  applyLearningGuideVisibility();
  const load = loadLearningPlans();
  if (!load.ok) {
    renderLearningPlansUnavailable("We couldn't load your saved Learning Plans. Your stored data was left unchanged.");
    return;
  }
  setLearningPlanControlsAvailable(true);
  renderLearningPlanState();
}

window.renderLearningPlans = renderLearningPlans;
window.onLearningPlanFocusSessionEnded = receiveLearningPlanFocusOutcome;
initLearningPlans();
