const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const CAPABILITY_PROFILE_SCHEMA_VERSION = 1;
export const CAPABILITY_EVIDENCE_DIMENSIONS = Object.freeze(['knowledge', 'practice', 'execution', 'shipping', 'portfolio']);
export const CAPABILITY_SKILL_STATUSES = Object.freeze(['active', 'maintaining', 'paused', 'archived']);
export const CAPABILITY_PROJECT_STATUSES = Object.freeze(['idea', 'active', 'paused', 'shipped', 'archived']);
export const CAPABILITY_PORTFOLIO_STATUSES = Object.freeze(['none', 'candidate', 'ready', 'published']);
export const CAPABILITY_TARGET_STATUSES = Object.freeze(['active', 'paused', 'archived']);
export const CAPABILITY_ARTIFACT_TYPES = Object.freeze(['link', 'repository', 'deployment', 'screenshot', 'document', 'case-study', 'note']);
export const CAPABILITY_EVIDENCE_SOURCES = Object.freeze(['manual', 'life-ledger', 'project']);

const PROFILE_KEYS = new Set([
  'schemaVersion',
  'skills',
  'knowledgeAreas',
  'tools',
  'careerTargets',
  'projects',
  'artifacts',
  'evidence',
  'createdAt',
  'updatedAt'
]);
const SKILL_KEYS = new Set(['id', 'name', 'category', 'description', 'currentLevel', 'targetLevel', 'status', 'createdAt', 'updatedAt']);
const KNOWLEDGE_KEYS = new Set(['id', 'name', 'category', 'description', 'status', 'createdAt', 'updatedAt']);
const TOOL_KEYS = new Set(['id', 'name', 'category', 'description', 'skillIds', 'projectIds', 'status', 'createdAt', 'updatedAt']);
const TARGET_KEYS = new Set(['id', 'title', 'objective', 'skillIds', 'priority', 'notes', 'status', 'createdAt', 'updatedAt']);
const PROJECT_KEYS = new Set(['id', 'title', 'summary', 'status', 'skillIds', 'toolIds', 'careerTargetIds', 'portfolioStatus', 'artifactIds', 'createdAt', 'updatedAt']);
const ARTIFACT_KEYS = new Set(['id', 'projectId', 'type', 'label', 'reference', 'notes', 'createdAt', 'updatedAt']);
const EVIDENCE_KEYS = new Set(['id', 'skillId', 'dimension', 'source', 'summary', 'notes', 'observedAt', 'lifeLedgerEventId', 'lifeLedgerKey', 'projectId', 'artifactId', 'createdAt', 'updatedAt']);
const STRING_LIMITS = Object.freeze({
  name: 160,
  title: 160,
  category: 120,
  description: 1000,
  currentLevel: 120,
  targetLevel: 120,
  objective: 1000,
  notes: 1000,
  summary: 1000,
  evidenceSummary: 240,
  projectId: 160,
  artifactId: 160,
  skillId: 160,
  lifeLedgerEventId: 160,
  lifeLedgerKey: 500,
  label: 160,
  reference: 1000
});

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneJson(value) {
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

function createContext(options = {}) {
  const idGenerator = options.idGenerator || defaultIdGenerator;
  const clock = options.clock || defaultClock;
  if (typeof idGenerator !== 'function') throw new Error('idGenerator must be a function');
  if (typeof clock !== 'function') throw new Error('clock must be a function');
  return { idGenerator, clock };
}

function makeId(ctx) {
  const id = ctx.idGenerator();
  if (typeof id !== 'string' || !id.trim()) throw new Error('idGenerator must return a non-empty string');
  return id.trim();
}

function normalizeIsoInstant(value) {
  return new Date(Date.parse(value)).toISOString();
}

export function isValidCapabilityInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalizeIsoInstant(value);
}

function makeTimestamp(ctx) {
  const timestamp = ctx.clock();
  if (!isValidCapabilityInstant(timestamp)) throw new Error('clock must return a UTC ISO timestamp');
  return normalizeIsoInstant(timestamp);
}

function cleanText(value, field, { required = false, max = 1000 } = {}) {
  if (value == null) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (trimmed.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return trimmed;
}

function cleanEnum(value, allowed, fallback, field) {
  const normalized = String(value || fallback || '').trim();
  if (!allowed.includes(normalized)) throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  return normalized;
}

function cleanIdArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const out = [];
  const seen = new Set();
  value.forEach((id, index) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error(`${field}[${index}] must be a non-empty string`);
    const normalized = id.trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  });
  return out;
}

function baseEntity(input, ctx, nameField = 'name') {
  const now = makeTimestamp(ctx);
  return {
    id: makeId(ctx),
    [nameField]: cleanText(input?.[nameField], nameField, { required: true, max: 160 }),
    createdAt: now,
    updatedAt: now
  };
}

function touch(entity, ctx) {
  return { ...entity, updatedAt: makeTimestamp(ctx) };
}

export function createEmptyCapabilityProfile(options = {}) {
  const ctx = createContext(options);
  const now = makeTimestamp(ctx);
  return {
    schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
    skills: [],
    knowledgeAreas: [],
    tools: [],
    careerTargets: [],
    projects: [],
    artifacts: [],
    evidence: [],
    createdAt: now,
    updatedAt: now
  };
}

export function createCapabilitySkill(input, options = {}) {
  const ctx = createContext(options);
  const skill = baseEntity(input, ctx, 'name');
  return {
    ...skill,
    ...(cleanText(input?.category, 'category', { max: 120 }) ? { category: cleanText(input.category, 'category', { max: 120 }) } : {}),
    ...(cleanText(input?.description, 'description', { max: 1000 }) ? { description: cleanText(input.description, 'description', { max: 1000 }) } : {}),
    ...(cleanText(input?.currentLevel, 'currentLevel', { max: 120 }) ? { currentLevel: cleanText(input.currentLevel, 'currentLevel', { max: 120 }) } : {}),
    ...(cleanText(input?.targetLevel, 'targetLevel', { max: 120 }) ? { targetLevel: cleanText(input.targetLevel, 'targetLevel', { max: 120 }) } : {}),
    status: cleanEnum(input?.status, CAPABILITY_SKILL_STATUSES, 'active', 'status')
  };
}

export function createCapabilityKnowledgeArea(input, options = {}) {
  const ctx = createContext(options);
  return {
    ...baseEntity(input, ctx, 'name'),
    ...(cleanText(input?.category, 'category', { max: 120 }) ? { category: cleanText(input.category, 'category', { max: 120 }) } : {}),
    ...(cleanText(input?.description, 'description', { max: 1000 }) ? { description: cleanText(input.description, 'description', { max: 1000 }) } : {}),
    status: cleanEnum(input?.status, CAPABILITY_SKILL_STATUSES, 'active', 'status')
  };
}

export function createCapabilityTool(input, options = {}) {
  const ctx = createContext(options);
  return {
    ...baseEntity(input, ctx, 'name'),
    ...(cleanText(input?.category, 'category', { max: 120 }) ? { category: cleanText(input.category, 'category', { max: 120 }) } : {}),
    ...(cleanText(input?.description, 'description', { max: 1000 }) ? { description: cleanText(input.description, 'description', { max: 1000 }) } : {}),
    skillIds: cleanIdArray(input?.skillIds, 'skillIds'),
    projectIds: cleanIdArray(input?.projectIds, 'projectIds'),
    status: cleanEnum(input?.status, CAPABILITY_SKILL_STATUSES, 'active', 'status')
  };
}

export function createCareerTarget(input, options = {}) {
  const ctx = createContext(options);
  const target = baseEntity(input, ctx, 'title');
  return {
    ...target,
    objective: cleanText(input?.objective, 'objective', { max: 1000 }) || '',
    skillIds: cleanIdArray(input?.skillIds, 'skillIds'),
    priority: cleanEnum(input?.priority, ['primary', 'secondary', 'later'], 'primary', 'priority'),
    ...(cleanText(input?.notes, 'notes', { max: 1000 }) ? { notes: cleanText(input.notes, 'notes', { max: 1000 }) } : {}),
    status: cleanEnum(input?.status, CAPABILITY_TARGET_STATUSES, 'active', 'status')
  };
}

export function createCapabilityProject(input, options = {}) {
  const ctx = createContext(options);
  const project = baseEntity(input, ctx, 'title');
  return {
    ...project,
    summary: cleanText(input?.summary, 'summary', { max: 1000 }) || '',
    status: cleanEnum(input?.status, CAPABILITY_PROJECT_STATUSES, 'active', 'status'),
    skillIds: cleanIdArray(input?.skillIds, 'skillIds'),
    toolIds: cleanIdArray(input?.toolIds, 'toolIds'),
    careerTargetIds: cleanIdArray(input?.careerTargetIds, 'careerTargetIds'),
    portfolioStatus: cleanEnum(input?.portfolioStatus, CAPABILITY_PORTFOLIO_STATUSES, 'none', 'portfolioStatus'),
    artifactIds: cleanIdArray(input?.artifactIds, 'artifactIds')
  };
}

export function createPortfolioArtifact(input, options = {}) {
  const ctx = createContext(options);
  const now = makeTimestamp(ctx);
  return {
    id: makeId(ctx),
    projectId: cleanText(input?.projectId, 'projectId', { required: true, max: 160 }),
    type: cleanEnum(input?.type, CAPABILITY_ARTIFACT_TYPES, 'link', 'type'),
    label: cleanText(input?.label, 'label', { required: true, max: 160 }),
    reference: cleanText(input?.reference, 'reference', { required: true, max: 1000 }),
    ...(cleanText(input?.notes, 'notes', { max: 1000 }) ? { notes: cleanText(input.notes, 'notes', { max: 1000 }) } : {}),
    createdAt: now,
    updatedAt: now
  };
}

export function createCapabilityEvidence(input, options = {}) {
  const ctx = createContext(options);
  const now = makeTimestamp(ctx);
  const source = cleanEnum(input?.source, CAPABILITY_EVIDENCE_SOURCES, 'manual', 'source');
  const evidence = {
    id: makeId(ctx),
    skillId: cleanText(input?.skillId, 'skillId', { required: true, max: 160 }),
    dimension: cleanEnum(input?.dimension, CAPABILITY_EVIDENCE_DIMENSIONS, 'knowledge', 'dimension'),
    source,
    summary: cleanText(input?.summary, 'summary', { required: true, max: 240 }),
    ...(cleanText(input?.notes, 'notes', { max: 1000 }) ? { notes: cleanText(input.notes, 'notes', { max: 1000 }) } : {}),
    observedAt: input?.observedAt ? normalizeObservedAt(input.observedAt) : now,
    createdAt: now,
    updatedAt: now
  };
  if (source === 'life-ledger') {
    evidence.lifeLedgerEventId = cleanText(input?.lifeLedgerEventId, 'lifeLedgerEventId', { required: true, max: 160 });
    if (input?.lifeLedgerKey) evidence.lifeLedgerKey = cleanText(input.lifeLedgerKey, 'lifeLedgerKey', { max: 500 });
  }
  if (input?.projectId || source === 'project') {
    evidence.projectId = cleanText(input?.projectId, 'projectId', { required: source === 'project', max: 160 });
    if (input?.artifactId) evidence.artifactId = cleanText(input.artifactId, 'artifactId', { max: 160 });
  }
  return evidence;
}

function normalizeObservedAt(value) {
  if (!isValidCapabilityInstant(value)) throw new Error('observedAt must be a UTC ISO timestamp');
  return normalizeIsoInstant(value);
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
  Object.keys(value).forEach(key => validateJsonSafeValue(value[key], `${path}.${key}`, errors, seen));
  seen.delete(value);
}

function validateExactKeys(entity, path, allowedKeys, errors) {
  Object.keys(entity).forEach(key => {
    if (!allowedKeys.has(key)) errors.push(`${path}.${key} is not allowed`);
  });
}

function validateId(entity, path, seenIds, errors) {
  if (typeof entity.id !== 'string' || !entity.id.trim()) {
    errors.push(`${path}.id must be a non-empty string`);
    return;
  }
  if (seenIds.has(entity.id)) errors.push(`${path}.id duplicates another entity id`);
  seenIds.add(entity.id);
}

function validateTimestamp(value, path, errors) {
  pushIf(errors, !isValidCapabilityInstant(value), `${path} must be a UTC ISO timestamp`);
}

function validateStringField(entity, key, path, errors, required = false, max = 1000) {
  if (!hasOwn(entity, key) || entity[key] == null) {
    if (required) errors.push(`${path}.${key} is required`);
    return;
  }
  if (typeof entity[key] !== 'string' || (required && !entity[key].trim())) {
    errors.push(`${path}.${key} must be a ${required ? 'non-empty ' : ''}string`);
    return;
  }
  pushIf(errors, entity[key].length > max, `${path}.${key} must be ${max} characters or fewer`);
}

function validateEnumField(entity, key, allowed, path, errors) {
  pushIf(errors, !allowed.includes(entity[key]), `${path}.${key} must be one of: ${allowed.join(', ')}`);
}

function validateIdArrayField(entity, key, path, errors) {
  if (!Array.isArray(entity[key])) {
    errors.push(`${path}.${key} must be an array`);
    return;
  }
  const seen = new Set();
  entity[key].forEach((id, index) => {
    if (typeof id !== 'string' || !id.trim()) errors.push(`${path}.${key}[${index}] must be a non-empty string`);
    if (seen.has(id)) errors.push(`${path}.${key}[${index}] duplicates ${id}`);
    seen.add(id);
  });
}

function validateBaseEntity(entity, path, seenIds, errors, nameKey) {
  if (!isPlainObject(entity)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  validateId(entity, path, seenIds, errors);
  validateStringField(entity, nameKey, path, errors, true, STRING_LIMITS[nameKey]);
  validateTimestamp(entity.createdAt, `${path}.createdAt`, errors);
  validateTimestamp(entity.updatedAt, `${path}.updatedAt`, errors);
  return true;
}

function validateCollection(items, path, errors, validateItem) {
  if (!Array.isArray(items)) {
    errors.push(`${path} must be an array`);
    return;
  }
  items.forEach((item, index) => validateItem(item, `${path}[${index}]`));
}

function validateSkill(skill, path, seenIds, errors) {
  if (!validateBaseEntity(skill, path, seenIds, errors, 'name')) return;
  validateExactKeys(skill, path, SKILL_KEYS, errors);
  ['category', 'description', 'currentLevel', 'targetLevel'].forEach(key => validateStringField(skill, key, path, errors, false, STRING_LIMITS[key]));
  validateEnumField(skill, 'status', CAPABILITY_SKILL_STATUSES, path, errors);
}

function validateKnowledgeArea(area, path, seenIds, errors) {
  if (!validateBaseEntity(area, path, seenIds, errors, 'name')) return;
  validateExactKeys(area, path, KNOWLEDGE_KEYS, errors);
  ['category', 'description'].forEach(key => validateStringField(area, key, path, errors, false, STRING_LIMITS[key]));
  validateEnumField(area, 'status', CAPABILITY_SKILL_STATUSES, path, errors);
}

function validateTool(tool, path, seenIds, errors) {
  if (!validateBaseEntity(tool, path, seenIds, errors, 'name')) return;
  validateExactKeys(tool, path, TOOL_KEYS, errors);
  ['category', 'description'].forEach(key => validateStringField(tool, key, path, errors, false, STRING_LIMITS[key]));
  validateIdArrayField(tool, 'skillIds', path, errors);
  validateIdArrayField(tool, 'projectIds', path, errors);
  validateEnumField(tool, 'status', CAPABILITY_SKILL_STATUSES, path, errors);
}

function validateCareerTarget(target, path, seenIds, errors) {
  if (!validateBaseEntity(target, path, seenIds, errors, 'title')) return;
  validateExactKeys(target, path, TARGET_KEYS, errors);
  validateStringField(target, 'objective', path, errors, false, STRING_LIMITS.objective);
  validateStringField(target, 'notes', path, errors, false, STRING_LIMITS.notes);
  validateIdArrayField(target, 'skillIds', path, errors);
  validateEnumField(target, 'priority', ['primary', 'secondary', 'later'], path, errors);
  validateEnumField(target, 'status', CAPABILITY_TARGET_STATUSES, path, errors);
}

function validateProject(project, path, seenIds, errors) {
  if (!validateBaseEntity(project, path, seenIds, errors, 'title')) return;
  validateExactKeys(project, path, PROJECT_KEYS, errors);
  validateStringField(project, 'summary', path, errors, false, STRING_LIMITS.summary);
  validateIdArrayField(project, 'skillIds', path, errors);
  validateIdArrayField(project, 'toolIds', path, errors);
  validateIdArrayField(project, 'careerTargetIds', path, errors);
  validateIdArrayField(project, 'artifactIds', path, errors);
  validateEnumField(project, 'status', CAPABILITY_PROJECT_STATUSES, path, errors);
  validateEnumField(project, 'portfolioStatus', CAPABILITY_PORTFOLIO_STATUSES, path, errors);
}

function validateArtifact(artifact, path, seenIds, errors) {
  if (!isPlainObject(artifact)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactKeys(artifact, path, ARTIFACT_KEYS, errors);
  validateId(artifact, path, seenIds, errors);
  ['projectId', 'label', 'reference'].forEach(key => validateStringField(artifact, key, path, errors, true, STRING_LIMITS[key]));
  validateStringField(artifact, 'notes', path, errors, false, STRING_LIMITS.notes);
  validateEnumField(artifact, 'type', CAPABILITY_ARTIFACT_TYPES, path, errors);
  validateTimestamp(artifact.createdAt, `${path}.createdAt`, errors);
  validateTimestamp(artifact.updatedAt, `${path}.updatedAt`, errors);
}

function validateEvidence(evidence, path, seenIds, errors) {
  if (!isPlainObject(evidence)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactKeys(evidence, path, EVIDENCE_KEYS, errors);
  validateId(evidence, path, seenIds, errors);
  validateStringField(evidence, 'skillId', path, errors, true, STRING_LIMITS.skillId);
  validateStringField(evidence, 'summary', path, errors, true, STRING_LIMITS.evidenceSummary);
  validateStringField(evidence, 'notes', path, errors, false, STRING_LIMITS.notes);
  validateEnumField(evidence, 'dimension', CAPABILITY_EVIDENCE_DIMENSIONS, path, errors);
  validateEnumField(evidence, 'source', CAPABILITY_EVIDENCE_SOURCES, path, errors);
  validateTimestamp(evidence.observedAt, `${path}.observedAt`, errors);
  validateTimestamp(evidence.createdAt, `${path}.createdAt`, errors);
  validateTimestamp(evidence.updatedAt, `${path}.updatedAt`, errors);
  if (evidence.source === 'life-ledger') validateStringField(evidence, 'lifeLedgerEventId', path, errors, true, STRING_LIMITS.lifeLedgerEventId);
  validateStringField(evidence, 'lifeLedgerKey', path, errors, false, STRING_LIMITS.lifeLedgerKey);
  if (evidence.source === 'project') validateStringField(evidence, 'projectId', path, errors, true, STRING_LIMITS.projectId);
  else validateStringField(evidence, 'projectId', path, errors, false, STRING_LIMITS.projectId);
  validateStringField(evidence, 'artifactId', path, errors, false, STRING_LIMITS.artifactId);
}

function validateReferences(profile, errors) {
  const skillIds = new Set(profile.skills.map(item => item.id));
  const toolIds = new Set(profile.tools.map(item => item.id));
  const targetIds = new Set(profile.careerTargets.map(item => item.id));
  const projectIds = new Set(profile.projects.map(item => item.id));
  const artifactIds = new Set(profile.artifacts.map(item => item.id));

  profile.tools.forEach(tool => {
    tool.skillIds.forEach(id => { if (!skillIds.has(id)) errors.push(`tool ${tool.id} references missing skill ${id}`); });
    tool.projectIds.forEach(id => { if (!projectIds.has(id)) errors.push(`tool ${tool.id} references missing project ${id}`); });
  });
  profile.careerTargets.forEach(target => {
    target.skillIds.forEach(id => { if (!skillIds.has(id)) errors.push(`career target ${target.id} references missing skill ${id}`); });
  });
  profile.projects.forEach(project => {
    project.skillIds.forEach(id => { if (!skillIds.has(id)) errors.push(`project ${project.id} references missing skill ${id}`); });
    project.toolIds.forEach(id => { if (!toolIds.has(id)) errors.push(`project ${project.id} references missing tool ${id}`); });
    project.careerTargetIds.forEach(id => { if (!targetIds.has(id)) errors.push(`project ${project.id} references missing career target ${id}`); });
    project.artifactIds.forEach(id => { if (!artifactIds.has(id)) errors.push(`project ${project.id} references missing artifact ${id}`); });
  });
  profile.artifacts.forEach(artifact => {
    if (!projectIds.has(artifact.projectId)) errors.push(`artifact ${artifact.id} references missing project ${artifact.projectId}`);
  });
  profile.evidence.forEach(evidence => {
    if (!skillIds.has(evidence.skillId)) errors.push(`evidence ${evidence.id} references missing skill ${evidence.skillId}`);
    if (evidence.projectId && !projectIds.has(evidence.projectId)) errors.push(`evidence ${evidence.id} references missing project ${evidence.projectId}`);
    if (evidence.artifactId && !artifactIds.has(evidence.artifactId)) errors.push(`evidence ${evidence.id} references missing artifact ${evidence.artifactId}`);
  });
}

function validateEvidenceUniqueness(profile, errors) {
  const seen = new Set();
  profile.evidence.forEach(evidence => {
    if (evidence.source !== 'life-ledger') return;
    const key = [evidence.skillId, evidence.dimension, evidence.lifeLedgerEventId].join('|');
    if (seen.has(key)) errors.push(`life-ledger evidence duplicates ${evidence.lifeLedgerEventId} for skill ${evidence.skillId} and dimension ${evidence.dimension}`);
    seen.add(key);
  });
}

export function validateCapabilityProfile(profile) {
  const errors = [];
  validateJsonSafeValue(profile, 'profile', errors);
  if (!isPlainObject(profile)) {
    errors.push('profile must be an object');
    return validationResult(errors);
  }
  validateExactKeys(profile, 'profile', PROFILE_KEYS, errors);
  pushIf(errors, profile.schemaVersion !== CAPABILITY_PROFILE_SCHEMA_VERSION, 'profile.schemaVersion must be 1');
  validateTimestamp(profile.createdAt, 'profile.createdAt', errors);
  validateTimestamp(profile.updatedAt, 'profile.updatedAt', errors);
  const seenIds = new Set();
  validateCollection(profile.skills, 'profile.skills', errors, (item, path) => validateSkill(item, path, seenIds, errors));
  validateCollection(profile.knowledgeAreas, 'profile.knowledgeAreas', errors, (item, path) => validateKnowledgeArea(item, path, seenIds, errors));
  validateCollection(profile.tools, 'profile.tools', errors, (item, path) => validateTool(item, path, seenIds, errors));
  validateCollection(profile.careerTargets, 'profile.careerTargets', errors, (item, path) => validateCareerTarget(item, path, seenIds, errors));
  validateCollection(profile.projects, 'profile.projects', errors, (item, path) => validateProject(item, path, seenIds, errors));
  validateCollection(profile.artifacts, 'profile.artifacts', errors, (item, path) => validateArtifact(item, path, seenIds, errors));
  validateCollection(profile.evidence, 'profile.evidence', errors, (item, path) => validateEvidence(item, path, seenIds, errors));
  if (errors.length === 0) {
    validateReferences(profile, errors);
    validateEvidenceUniqueness(profile, errors);
  }
  return validationResult(errors);
}

export function hydrateCapabilityProfile(profile) {
  const validation = validateCapabilityProfile(profile);
  if (!validation.ok) throw new Error(`Invalid Capability Profile: ${validation.errors.join('; ')}`);
  return cloneJson(profile);
}

function withProfile(profile, updater, options = {}) {
  const ctx = createContext(options);
  const current = hydrateCapabilityProfile(profile);
  const next = touch(updater(current, ctx), ctx);
  const validation = validateCapabilityProfile(next);
  if (!validation.ok) throw new Error(`Invalid Capability Profile: ${validation.errors.join('; ')}`);
  return next;
}

export function addSkill(profile, input, options = {}) {
  return withProfile(profile, (current) => ({ ...current, skills: [...current.skills, createCapabilitySkill(input, options)] }), options);
}

export function addKnowledgeArea(profile, input, options = {}) {
  return withProfile(profile, (current) => ({ ...current, knowledgeAreas: [...current.knowledgeAreas, createCapabilityKnowledgeArea(input, options)] }), options);
}

export function addTool(profile, input, options = {}) {
  return withProfile(profile, (current) => ({ ...current, tools: [...current.tools, createCapabilityTool(input, options)] }), options);
}

export function addCareerTarget(profile, input, options = {}) {
  return withProfile(profile, (current) => ({ ...current, careerTargets: [...current.careerTargets, createCareerTarget(input, options)] }), options);
}

export function addProject(profile, input, options = {}) {
  return withProfile(profile, (current) => ({ ...current, projects: [...current.projects, createCapabilityProject(input, options)] }), options);
}

export function addPortfolioArtifact(profile, input, options = {}) {
  return withProfile(profile, (current) => {
    const artifact = createPortfolioArtifact(input, options);
    return {
      ...current,
      projects: current.projects.map(project => project.id === artifact.projectId
        ? { ...project, artifactIds: [...project.artifactIds, artifact.id], updatedAt: artifact.updatedAt }
        : project),
      artifacts: [...current.artifacts, artifact]
    };
  }, options);
}

export function addEvidence(profile, input, options = {}) {
  return withProfile(profile, (current) => ({ ...current, evidence: [...current.evidence, createCapabilityEvidence(input, options)] }), options);
}

export function archiveSkill(profile, skillId, options = {}) {
  return withProfile(profile, (current, ctx) => ({
    ...current,
    skills: current.skills.map(skill => skill.id === skillId ? touch({ ...skill, status: 'archived' }, ctx) : skill)
  }), options);
}

export function updateProjectPortfolioStatus(profile, projectId, portfolioStatus, options = {}) {
  return withProfile(profile, (current, ctx) => ({
    ...current,
    projects: current.projects.map(project => project.id === projectId
      ? touch({ ...project, portfolioStatus: cleanEnum(portfolioStatus, CAPABILITY_PORTFOLIO_STATUSES, 'none', 'portfolioStatus') }, ctx)
      : project)
  }), options);
}
