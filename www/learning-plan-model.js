const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function structuredCloneCompat(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function defaultClock() {
  return new Date().toISOString();
}

function defaultIdGenerator() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  throw new Error('No UUID generator available; inject idGenerator for this runtime');
}

function normalizeTitle(value, fieldName = 'title') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeDescription(value) {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new Error('description must be a string when present');
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function createContext(options = {}) {
  const idGenerator = options.idGenerator || options.createId || defaultIdGenerator;
  const clock = options.clock || defaultClock;
  if (typeof idGenerator !== 'function') throw new Error('idGenerator must be a function');
  if (typeof clock !== 'function') throw new Error('clock must be a function');
  return { idGenerator, clock };
}

function makeId(ctx) {
  const id = ctx.idGenerator();
  if (typeof id !== 'string' || !id.trim()) throw new Error('idGenerator must return a non-empty string');
  return id;
}

function makeTimestamp(ctx) {
  const timestamp = ctx.clock();
  if (!isValidIsoInstant(timestamp)) throw new Error('clock must return a UTC ISO timestamp');
  return normalizeIsoInstant(timestamp);
}

function isValidIsoInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalizeIsoInstant(value);
}

function normalizeIsoInstant(value) {
  return new Date(Date.parse(value)).toISOString();
}

function touchPlan(plan, ctx) {
  return { ...plan, updatedAt: makeTimestamp(ctx) };
}

function clonePlan(plan) {
  return structuredCloneCompat(plan);
}

function validationResult(errors) {
  return { ok: errors.length === 0, errors };
}

function pushIf(errors, condition, message) {
  if (condition) errors.push(message);
}

function validateJsonSafeValue(value, path, errors, seen = new Set()) {
  if (value === null) return;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') return;
  if (valueType === 'number') {
    if (!Number.isFinite(value)) errors.push(`${path} must be a finite number`);
    return;
  }
  if (valueType === 'undefined' || valueType === 'function' || valueType === 'symbol' || valueType === 'bigint') {
    errors.push(`${path} contains unsupported ${valueType}`);
    return;
  }
  if (seen.has(value)) {
    errors.push(`${path} contains a circular reference`);
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!hasOwn(value, index)) {
        errors.push(`${path}[${index}] is a sparse array hole`);
        continue;
      }
      validateJsonSafeValue(value[index], `${path}[${index}]`, errors, seen);
    }
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) {
    errors.push(`${path} must be JSON-safe plain data`);
    seen.delete(value);
    return;
  }
  Reflect.ownKeys(value).forEach(key => {
    if (typeof key === 'symbol') {
      errors.push(`${path} contains unsupported symbol key`);
      return;
    }
    validateJsonSafeValue(value[key], `${path}.${key}`, errors, seen);
  });
  seen.delete(value);
}

function validateId(entity, path, seenIds, errors) {
  if (typeof entity.id !== 'string' || !entity.id.trim()) {
    errors.push(`${path}.id must be a non-empty string`);
    return;
  }
  if (seenIds.has(entity.id)) {
    errors.push(`${path}.id duplicates another entity id`);
    return;
  }
  seenIds.add(entity.id);
}

function validateTitle(entity, path, errors) {
  pushIf(errors, typeof entity.title !== 'string' || !entity.title.trim(), `${path}.title must be a non-empty string`);
}

function validateExactKeys(entity, path, allowedKeys, errors) {
  Object.keys(entity).forEach(key => {
    if (!allowedKeys.has(key)) errors.push(`${path}.${key} is not allowed`);
  });
}

function validateTimestamp(value, path, errors) {
  pushIf(errors, !isValidIsoInstant(value), `${path} must be a UTC ISO timestamp`);
}

function validateArrayItems(items, path, errors, validateItem) {
  if (!Array.isArray(items)) return;
  for (let index = 0; index < items.length; index++) {
    if (!hasOwn(items, index)) {
      errors.push(`${path}[${index}] is a sparse array hole`);
      continue;
    }
    validateItem(items[index], `${path}[${index}]`);
  }
}

function validateStep(step, path, seenIds, errors) {
  if (!isPlainObject(step)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactKeys(step, path, new Set(['id', 'title', 'completed', 'completedAt']), errors);
  validateId(step, path, seenIds, errors);
  validateTitle(step, path, errors);
  pushIf(errors, typeof step.completed !== 'boolean', `${path}.completed must be boolean`);
  if (step.completed === true) {
    validateTimestamp(step.completedAt, `${path}.completedAt`, errors);
  } else if (step.completed === false) {
    pushIf(errors, hasOwn(step, 'completedAt') && step.completedAt != null, `${path}.completedAt must be null or absent when incomplete`);
  }
}

function validateLesson(lesson, path, seenIds, errors) {
  if (!isPlainObject(lesson)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactKeys(lesson, path, new Set(['id', 'title', 'steps']), errors);
  validateId(lesson, path, seenIds, errors);
  validateTitle(lesson, path, errors);
  pushIf(errors, !Array.isArray(lesson.steps), `${path}.steps must be an array`);
  validateArrayItems(lesson.steps, `${path}.steps`, errors, (step, stepPath) => validateStep(step, stepPath, seenIds, errors));
}

function validatePhase(phase, path, seenIds, errors) {
  if (!isPlainObject(phase)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactKeys(phase, path, new Set(['id', 'title', 'lessons']), errors);
  validateId(phase, path, seenIds, errors);
  validateTitle(phase, path, errors);
  pushIf(errors, !Array.isArray(phase.lessons), `${path}.lessons must be an array`);
  validateArrayItems(phase.lessons, `${path}.lessons`, errors, (lesson, lessonPath) => validateLesson(lesson, lessonPath, seenIds, errors));
}

export function validateLearningPlan(plan) {
  const errors = [];
  const seenIds = new Set();
  validateJsonSafeValue(plan, 'plan', errors);
  if (!isPlainObject(plan)) {
    errors.push('plan must be an object');
    return validationResult(errors);
  }
  validateExactKeys(plan, 'plan', new Set(['id', 'title', 'description', 'phases', 'createdAt', 'updatedAt']), errors);
  validateId(plan, 'plan', seenIds, errors);
  validateTitle(plan, 'plan', errors);
  if (hasOwn(plan, 'description') && typeof plan.description !== 'string') {
    errors.push('plan.description must be a string when present');
  }
  pushIf(errors, !Array.isArray(plan.phases), 'plan.phases must be an array');
  validateTimestamp(plan.createdAt, 'plan.createdAt', errors);
  validateTimestamp(plan.updatedAt, 'plan.updatedAt', errors);
  validateArrayItems(plan.phases, 'plan.phases', errors, (phase, phasePath) => validatePhase(phase, phasePath, seenIds, errors));
  return validationResult(errors);
}

export function hydrateLearningPlan(value) {
  const validation = validateLearningPlan(value);
  if (!validation.ok) throw new Error(`Invalid learning plan: ${validation.errors.join('; ')}`);
  return clonePlan(value);
}

export function serializeLearningPlan(plan) {
  const hydrated = hydrateLearningPlan(plan);
  return JSON.stringify(hydrated);
}

export function createLearningPlan(input, options = {}) {
  const ctx = createContext(options);
  const now = makeTimestamp(ctx);
  const description = normalizeDescription(input && input.description);
  return {
    id: makeId(ctx),
    title: normalizeTitle(input && input.title),
    ...(description ? { description } : {}),
    phases: [],
    createdAt: now,
    updatedAt: now
  };
}

export function createPhase(input, options = {}) {
  const ctx = createContext(options);
  return {
    id: makeId(ctx),
    title: normalizeTitle(input && input.title),
    lessons: []
  };
}

export function createLesson(input, options = {}) {
  const ctx = createContext(options);
  return {
    id: makeId(ctx),
    title: normalizeTitle(input && input.title),
    steps: []
  };
}

export function createStep(input, options = {}) {
  const ctx = createContext(options);
  return {
    id: makeId(ctx),
    title: normalizeTitle(input && input.title),
    completed: false,
    completedAt: null
  };
}

function withValidatedPlan(plan, fn) {
  const base = hydrateLearningPlan(plan);
  const result = fn(base);
  const validation = validateLearningPlan(result);
  if (!validation.ok) throw new Error(`Invalid learning plan: ${validation.errors.join('; ')}`);
  return result;
}

export function renamePlan(plan, title, options = {}) {
  return withValidatedPlan(plan, current => {
    const ctx = createContext(options);
    return touchPlan({ ...current, title: normalizeTitle(title) }, ctx);
  });
}

export function renamePhase(plan, phaseId, title, options = {}) {
  return updatePhase(plan, phaseId, phase => ({ ...phase, title: normalizeTitle(title) }), options);
}

export function renameLesson(plan, lessonId, title, options = {}) {
  return updateLesson(plan, lessonId, lesson => ({ ...lesson, title: normalizeTitle(title) }), options);
}

export function renameStep(plan, stepId, title, options = {}) {
  return updateStep(plan, stepId, step => ({ ...step, title: normalizeTitle(title) }), options);
}

export function addPhase(plan, input, options = {}) {
  return withValidatedPlan(plan, current => {
    const ctx = createContext(options);
    return touchPlan({
      ...current,
      phases: [...current.phases, createPhase(input, options)]
    }, ctx);
  });
}

export function addLesson(plan, phaseId, input, options = {}) {
  return updatePhase(plan, phaseId, phase => ({
    ...phase,
    lessons: [...phase.lessons, createLesson(input, options)]
  }), options);
}

export function addStep(plan, lessonId, input, options = {}) {
  return updateLesson(plan, lessonId, lesson => ({
    ...lesson,
    steps: [...lesson.steps, createStep(input, options)]
  }), options);
}

export function reorderPhases(plan, orderedIds, options = {}) {
  return withValidatedPlan(plan, current => {
    const ctx = createContext(options);
    return touchPlan({ ...current, phases: reorderByIds(current.phases, orderedIds, 'phases') }, ctx);
  });
}

export function reorderLessons(plan, phaseId, orderedIds, options = {}) {
  return updatePhase(plan, phaseId, phase => ({
    ...phase,
    lessons: reorderByIds(phase.lessons, orderedIds, 'lessons')
  }), options);
}

export function reorderSteps(plan, lessonId, orderedIds, options = {}) {
  return updateLesson(plan, lessonId, lesson => ({
    ...lesson,
    steps: reorderByIds(lesson.steps, orderedIds, 'steps')
  }), options);
}

export function completeStep(plan, stepId, options = {}) {
  return withValidatedPlan(plan, current => {
    const ctx = createContext(options);
    let changed = false;
    const phases = current.phases.map(phase => ({
      ...phase,
      lessons: phase.lessons.map(lesson => ({
        ...lesson,
        steps: lesson.steps.map(step => {
          if (step.id !== stepId) return step;
          if (step.completed === true) return step;
          changed = true;
          return { ...step, completed: true, completedAt: makeTimestamp(ctx) };
        })
      }))
    }));
    assertFound(changed || containsStepId(current, stepId), `step ${stepId} not found`);
    return changed ? touchPlan({ ...current, phases }, ctx) : current;
  });
}

export function reopenStep(plan, stepId, options = {}) {
  return withValidatedPlan(plan, current => {
    const ctx = createContext(options);
    let changed = false;
    const phases = current.phases.map(phase => ({
      ...phase,
      lessons: phase.lessons.map(lesson => ({
        ...lesson,
        steps: lesson.steps.map(step => {
          if (step.id !== stepId) return step;
          if (step.completed === false && step.completedAt == null) return step;
          changed = true;
          return { ...step, completed: false, completedAt: null };
        })
      }))
    }));
    assertFound(changed || containsStepId(current, stepId), `step ${stepId} not found`);
    return changed ? touchPlan({ ...current, phases }, ctx) : current;
  });
}

function assertFound(found, message) {
  if (!found) throw new Error(message);
}

function containsStepId(plan, stepId) {
  return plan.phases.some(phase => phase.lessons.some(lesson => lesson.steps.some(step => step.id === stepId)));
}

function updatePhase(plan, phaseId, updater, options) {
  return withValidatedPlan(plan, current => {
    const ctx = createContext(options);
    let found = false;
    const phases = current.phases.map(phase => {
      if (phase.id !== phaseId) return phase;
      found = true;
      return updater(phase);
    });
    assertFound(found, `phase ${phaseId} not found`);
    return touchPlan({ ...current, phases }, ctx);
  });
}

function updateLesson(plan, lessonId, updater, options) {
  return withValidatedPlan(plan, current => {
    const ctx = createContext(options);
    let found = false;
    const phases = current.phases.map(phase => ({
      ...phase,
      lessons: phase.lessons.map(lesson => {
        if (lesson.id !== lessonId) return lesson;
        found = true;
        return updater(lesson);
      })
    }));
    assertFound(found, `lesson ${lessonId} not found`);
    return touchPlan({ ...current, phases }, ctx);
  });
}

function updateStep(plan, stepId, updater, options) {
  return withValidatedPlan(plan, current => {
    const ctx = createContext(options);
    let found = false;
    const phases = current.phases.map(phase => ({
      ...phase,
      lessons: phase.lessons.map(lesson => ({
        ...lesson,
        steps: lesson.steps.map(step => {
          if (step.id !== stepId) return step;
          found = true;
          return updater(step);
        })
      }))
    }));
    assertFound(found, `step ${stepId} not found`);
    return touchPlan({ ...current, phases }, ctx);
  });
}

function reorderByIds(items, orderedIds, label) {
  if (!Array.isArray(orderedIds)) throw new Error(`${label} order must be an array`);
  if (orderedIds.length !== items.length) throw new Error(`${label} order must include every existing id exactly once`);
  const byId = new Map(items.map(item => [item.id, item]));
  const seen = new Set();
  return orderedIds.map(id => {
    if (seen.has(id)) throw new Error(`${label} order contains duplicate id ${id}`);
    seen.add(id);
    const item = byId.get(id);
    if (!item) throw new Error(`${label} order contains unknown id ${id}`);
    return item;
  });
}

export function getLearningPlanProgress(plan) {
  const current = hydrateLearningPlan(plan);
  let totalSteps = 0;
  let completedSteps = 0;
  current.phases.forEach(phase => {
    phase.lessons.forEach(lesson => {
      lesson.steps.forEach(step => {
        totalSteps++;
        if (step.completed) completedSteps++;
      });
    });
  });
  const completionRatio = totalSteps ? completedSteps / totalSteps : 0;
  return {
    totalSteps,
    completedSteps,
    completionRatio,
    completionPercent: Math.round(completionRatio * 100)
  };
}

export const LEARNING_PLAN_MODEL_V1 = Object.freeze({
  hierarchy: Object.freeze(['LearningPlan', 'Phase', 'Lesson', 'Step']),
  ordering: 'array-order'
});
