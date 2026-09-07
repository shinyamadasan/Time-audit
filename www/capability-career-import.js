import {
  addCareerTarget,
  addEvidence,
  addKnowledgeArea,
  addPortfolioArtifact,
  addProject,
  addSkill,
  addTool,
  createEmptyCapabilityProfile
} from './capability-career-model.js';

const ROOT_KEYS = new Set(['skills', 'knowledgeAreas', 'tools', 'careerTargets', 'projects', 'artifacts', 'evidence']);
const DIMENSIONS = new Set(['knowledge', 'practice', 'execution', 'shipping', 'portfolio']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cleanText(value, path, errors, required = false) {
  if (value == null) {
    if (required) errors.push(`${path} is required`);
    return '';
  }
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string`);
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed && required) errors.push(`${path} is required`);
  return trimmed;
}

function optionalArray(value, path, errors) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  return value.map((item, index) => cleanText(item, `${path}[${index}]`, errors, true)).filter(Boolean);
}

function readArray(root, key, errors) {
  if (root[key] == null) return [];
  if (!Array.isArray(root[key])) {
    errors.push(`${key} must be an array`);
    return [];
  }
  return root[key];
}

function normalizeNamedItems(items, path, errors, fields = []) {
  const seen = new Set();
  return items.map((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`${path}[${index}] must be an object`);
      return null;
    }
    if ('id' in item) errors.push(`${path}[${index}].id is not accepted in import; IDs are generated when saved`);
    const name = cleanText(item.name, `${path}[${index}].name`, errors, true);
    const key = name.toLowerCase();
    if (key && seen.has(key)) errors.push(`${path}[${index}].name duplicates ${name}`);
    seen.add(key);
    const out = { name };
    fields.forEach(field => {
      if (field.array) out[field.key] = optionalArray(item[field.key], `${path}[${index}].${field.key}`, errors);
      else {
        const value = cleanText(item[field.key], `${path}[${index}].${field.key}`, errors, false);
        if (value) out[field.key] = value;
      }
    });
    if (item.status) out.status = cleanText(item.status, `${path}[${index}].status`, errors, false);
    return out;
  }).filter(Boolean);
}

function normalizeCareerTargets(items, errors) {
  const seen = new Set();
  return items.map((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`careerTargets[${index}] must be an object`);
      return null;
    }
    if ('id' in item) errors.push(`careerTargets[${index}].id is not accepted in import; IDs are generated when saved`);
    const title = cleanText(item.title, `careerTargets[${index}].title`, errors, true);
    const key = title.toLowerCase();
    if (key && seen.has(key)) errors.push(`careerTargets[${index}].title duplicates ${title}`);
    seen.add(key);
    return {
      title,
      objective: cleanText(item.objective, `careerTargets[${index}].objective`, errors, false),
      skillNames: optionalArray(item.skills || item.skillNames, `careerTargets[${index}].skills`, errors),
      priority: cleanText(item.priority, `careerTargets[${index}].priority`, errors, false) || 'primary',
      notes: cleanText(item.notes, `careerTargets[${index}].notes`, errors, false),
      status: cleanText(item.status, `careerTargets[${index}].status`, errors, false) || 'active'
    };
  }).filter(Boolean);
}

function normalizeProjects(items, errors) {
  const seen = new Set();
  return items.map((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`projects[${index}] must be an object`);
      return null;
    }
    if ('id' in item) errors.push(`projects[${index}].id is not accepted in import; IDs are generated when saved`);
    const title = cleanText(item.title, `projects[${index}].title`, errors, true);
    const key = title.toLowerCase();
    if (key && seen.has(key)) errors.push(`projects[${index}].title duplicates ${title}`);
    seen.add(key);
    return {
      title,
      summary: cleanText(item.summary, `projects[${index}].summary`, errors, false),
      status: cleanText(item.status, `projects[${index}].status`, errors, false) || 'active',
      skillNames: optionalArray(item.skills || item.skillNames, `projects[${index}].skills`, errors),
      toolNames: optionalArray(item.tools || item.toolNames, `projects[${index}].tools`, errors),
      careerTargetTitles: optionalArray(item.careerTargets || item.careerTargetTitles, `projects[${index}].careerTargets`, errors),
      portfolioStatus: cleanText(item.portfolioStatus, `projects[${index}].portfolioStatus`, errors, false) || 'none'
    };
  }).filter(Boolean);
}

function normalizeArtifacts(items, errors) {
  return items.map((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`artifacts[${index}] must be an object`);
      return null;
    }
    if ('id' in item) errors.push(`artifacts[${index}].id is not accepted in import; IDs are generated when saved`);
    return {
      projectTitle: cleanText(item.project || item.projectTitle, `artifacts[${index}].project`, errors, true),
      type: cleanText(item.type, `artifacts[${index}].type`, errors, false) || 'link',
      label: cleanText(item.label, `artifacts[${index}].label`, errors, true),
      reference: cleanText(item.reference, `artifacts[${index}].reference`, errors, true),
      notes: cleanText(item.notes, `artifacts[${index}].notes`, errors, false)
    };
  }).filter(Boolean);
}

function normalizeEvidence(items, errors) {
  return items.map((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`evidence[${index}] must be an object`);
      return null;
    }
    if ('id' in item) errors.push(`evidence[${index}].id is not accepted in import; IDs are generated when saved`);
    const dimension = cleanText(item.dimension, `evidence[${index}].dimension`, errors, true);
    if (dimension && !DIMENSIONS.has(dimension)) errors.push(`evidence[${index}].dimension must be one of: ${Array.from(DIMENSIONS).join(', ')}`);
    return {
      skillName: cleanText(item.skill || item.skillName, `evidence[${index}].skill`, errors, true),
      dimension,
      source: cleanText(item.source, `evidence[${index}].source`, errors, false) || 'manual',
      summary: cleanText(item.summary, `evidence[${index}].summary`, errors, true),
      notes: cleanText(item.notes, `evidence[${index}].notes`, errors, false),
      observedAt: cleanText(item.observedAt, `evidence[${index}].observedAt`, errors, false),
      lifeLedgerEventId: cleanText(item.lifeLedgerEventId, `evidence[${index}].lifeLedgerEventId`, errors, false),
      lifeLedgerKey: cleanText(item.lifeLedgerKey, `evidence[${index}].lifeLedgerKey`, errors, false),
      projectTitle: cleanText(item.project || item.projectTitle, `evidence[${index}].project`, errors, false)
    };
  }).filter(Boolean);
}

function byName(items, label, errors) {
  const map = new Map();
  items.forEach(item => {
    const key = item.name.toLowerCase();
    if (map.has(key)) errors.push(`${label} ${item.name} is duplicated`);
    map.set(key, item);
  });
  return map;
}

function byTitle(items, label, errors) {
  const map = new Map();
  items.forEach(item => {
    const key = item.title.toLowerCase();
    if (map.has(key)) errors.push(`${label} ${item.title} is duplicated`);
    map.set(key, item);
  });
  return map;
}

function idsForNames(names, map, path, errors) {
  return names.map(name => {
    const item = map.get(name.toLowerCase());
    if (!item) errors.push(`${path} references missing item ${name}`);
    return item?.id || '';
  }).filter(Boolean);
}

export function parseCapabilityCareerImportJson(raw) {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(String(raw || ''));
  } catch (err) {
    return { ok: false, errors: [`Import JSON is malformed: ${err.message}`] };
  }
  if (!isPlainObject(parsed)) return { ok: false, errors: ['Import root must be an object'] };
  Object.keys(parsed).forEach(key => {
    if (!ROOT_KEYS.has(key)) errors.push(`${key} is not supported in Capability/Career import`);
  });

  const draft = {
    skills: normalizeNamedItems(readArray(parsed, 'skills', errors), 'skills', errors, [
      { key: 'category' },
      { key: 'description' },
      { key: 'currentLevel' },
      { key: 'targetLevel' }
    ]),
    knowledgeAreas: normalizeNamedItems(readArray(parsed, 'knowledgeAreas', errors), 'knowledgeAreas', errors, [
      { key: 'category' },
      { key: 'description' }
    ]),
    tools: normalizeNamedItems(readArray(parsed, 'tools', errors), 'tools', errors, [
      { key: 'category' },
      { key: 'description' },
      { key: 'skills', array: true },
      { key: 'projects', array: true }
    ]),
    careerTargets: normalizeCareerTargets(readArray(parsed, 'careerTargets', errors), errors),
    projects: normalizeProjects(readArray(parsed, 'projects', errors), errors),
    artifacts: normalizeArtifacts(readArray(parsed, 'artifacts', errors), errors),
    evidence: normalizeEvidence(readArray(parsed, 'evidence', errors), errors)
  };

  const skillNames = new Set(draft.skills.map(item => item.name.toLowerCase()));
  const toolNames = new Set(draft.tools.map(item => item.name.toLowerCase()));
  const targetTitles = new Set(draft.careerTargets.map(item => item.title.toLowerCase()));
  const projectTitles = new Set(draft.projects.map(item => item.title.toLowerCase()));

  draft.careerTargets.forEach((target, index) => target.skillNames.forEach(name => {
    if (!skillNames.has(name.toLowerCase())) errors.push(`careerTargets[${index}].skills references missing skill ${name}`);
  }));
  draft.projects.forEach((project, index) => {
    project.skillNames.forEach(name => { if (!skillNames.has(name.toLowerCase())) errors.push(`projects[${index}].skills references missing skill ${name}`); });
    project.toolNames.forEach(name => { if (!toolNames.has(name.toLowerCase())) errors.push(`projects[${index}].tools references missing tool ${name}`); });
    project.careerTargetTitles.forEach(title => { if (!targetTitles.has(title.toLowerCase())) errors.push(`projects[${index}].careerTargets references missing career target ${title}`); });
  });
  draft.tools.forEach((tool, index) => {
    (tool.skills || []).forEach(name => { if (!skillNames.has(name.toLowerCase())) errors.push(`tools[${index}].skills references missing skill ${name}`); });
    (tool.projects || []).forEach(title => { if (!projectTitles.has(title.toLowerCase())) errors.push(`tools[${index}].projects references missing project ${title}`); });
  });
  draft.artifacts.forEach((artifact, index) => {
    if (!projectTitles.has(artifact.projectTitle.toLowerCase())) errors.push(`artifacts[${index}].project references missing project ${artifact.projectTitle}`);
  });
  draft.evidence.forEach((evidence, index) => {
    if (!skillNames.has(evidence.skillName.toLowerCase())) errors.push(`evidence[${index}].skill references missing skill ${evidence.skillName}`);
    if (evidence.projectTitle && !projectTitles.has(evidence.projectTitle.toLowerCase())) errors.push(`evidence[${index}].project references missing project ${evidence.projectTitle}`);
    if (evidence.source === 'life-ledger' && !evidence.lifeLedgerEventId) errors.push(`evidence[${index}].lifeLedgerEventId is required for life-ledger evidence`);
  });

  return {
    ok: errors.length === 0,
    errors,
    draft,
    counts: {
      skills: draft.skills.length,
      knowledgeAreas: draft.knowledgeAreas.length,
      tools: draft.tools.length,
      careerTargets: draft.careerTargets.length,
      projects: draft.projects.length,
      artifacts: draft.artifacts.length,
      evidence: draft.evidence.length
    }
  };
}

export function buildCapabilityProfileFromImportDraft(draft, options = {}) {
  let profile = createEmptyCapabilityProfile(options);
  draft.skills.forEach(skill => { profile = addSkill(profile, skill, options); });
  draft.knowledgeAreas.forEach(area => { profile = addKnowledgeArea(profile, area, options); });

  const skillMap = byName(profile.skills, 'skill', []);
  draft.careerTargets.forEach(target => {
    profile = addCareerTarget(profile, {
      title: target.title,
      objective: target.objective,
      skillIds: idsForNames(target.skillNames, skillMap, `career target ${target.title}`, []),
      priority: target.priority,
      notes: target.notes,
      status: target.status
    }, options);
  });

  const targetMap = byTitle(profile.careerTargets, 'career target', []);
  draft.tools.forEach(tool => {
    profile = addTool(profile, {
      name: tool.name,
      category: tool.category,
      description: tool.description,
      skillIds: idsForNames(tool.skills || [], skillMap, `tool ${tool.name}`, []),
      projectIds: [],
      status: tool.status || 'active'
    }, options);
  });

  const toolMap = byName(profile.tools, 'tool', []);
  draft.projects.forEach(project => {
    profile = addProject(profile, {
      title: project.title,
      summary: project.summary,
      status: project.status,
      skillIds: idsForNames(project.skillNames, skillMap, `project ${project.title}`, []),
      toolIds: idsForNames(project.toolNames, toolMap, `project ${project.title}`, []),
      careerTargetIds: idsForNames(project.careerTargetTitles, targetMap, `project ${project.title}`, []),
      portfolioStatus: project.portfolioStatus
    }, options);
  });

  const projectMap = byTitle(profile.projects, 'project', []);
  draft.artifacts.forEach(artifact => {
    profile = addPortfolioArtifact(profile, {
      projectId: projectMap.get(artifact.projectTitle.toLowerCase()).id,
      type: artifact.type,
      label: artifact.label,
      reference: artifact.reference,
      notes: artifact.notes
    }, options);
  });

  draft.evidence.forEach(evidence => {
    const project = evidence.projectTitle ? projectMap.get(evidence.projectTitle.toLowerCase()) : null;
    profile = addEvidence(profile, {
      skillId: skillMap.get(evidence.skillName.toLowerCase()).id,
      dimension: evidence.dimension,
      source: evidence.source,
      summary: evidence.summary,
      notes: evidence.notes,
      observedAt: evidence.observedAt || undefined,
      lifeLedgerEventId: evidence.lifeLedgerEventId || undefined,
      lifeLedgerKey: evidence.lifeLedgerKey || undefined,
      projectId: project?.id
    }, options);
  });

  return profile;
}

export function importPreviewSummary(result) {
  if (!result?.ok) return 'Import has validation errors.';
  const c = result.counts;
  return `${c.skills} skills, ${c.knowledgeAreas} knowledge areas, ${c.tools} tools, ${c.careerTargets} targets, ${c.projects} projects, ${c.artifacts} artifacts, ${c.evidence} evidence records`;
}
