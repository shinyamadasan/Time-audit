import {
  addCareerTarget,
  addEvidence,
  addPortfolioArtifact,
  addProject,
  addSkill,
  addTool,
  updateProjectPortfolioStatus
} from './capability-career-model.js';
import { createCapabilityCareerRepository } from './capability-career-repository.js';
import {
  buildCapabilityProfileFromImportDraft,
  importPreviewSummary,
  parseCapabilityCareerImportJson
} from './capability-career-import.js';
import { analyzeCapabilityCareer } from './capability-career-analytics.js';
import { createLocalLifeLedgerStore } from './life-ledger-runtime.js';

let repository = null;
let profile = null;
let available = true;
let initialized = false;
let busy = false;
let openPanel = '';
let selectedSkillId = '';
let selectedProjectId = '';
let selectedLedgerEventId = '';
let importPreview = null;
let importPreviewFingerprint = '';

function ensureRepository() {
  if (!repository) repository = createCapabilityCareerRepository();
  return repository;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setError(message) {
  const el = document.getElementById('cap-career-error');
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || '';
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

function loadProfile() {
  try {
    profile = ensureRepository().loadProfile();
    available = true;
    setError('');
    return true;
  } catch (err) {
    available = false;
    setError(`Capability/Career storage could not be loaded: ${err.message}`);
    profile = null;
    return false;
  }
}

function saveProfile(nextProfile, failure = 'Could not save Capability/Career changes. Nothing was changed.') {
  try {
    profile = ensureRepository().saveProfile(nextProfile);
    available = true;
    setError('');
    renderCapabilityCareerState();
    return true;
  } catch (err) {
    setError(`${failure} ${err.message}`);
    renderCapabilityCareerState();
    return false;
  }
}

function isEmptyProfile(current) {
  return current
    && current.skills.length === 0
    && current.knowledgeAreas.length === 0
    && current.tools.length === 0
    && current.careerTargets.length === 0
    && current.projects.length === 0
    && current.artifacts.length === 0
    && current.evidence.length === 0;
}

function formValue(form, name) {
  return String(form.elements[name]?.value || '').trim();
}

function checkedValues(form, name) {
  return Array.from(form.querySelectorAll(`input[name="${name}"]:checked`)).map(input => input.value);
}

function activeSkills() {
  return (profile?.skills || []).filter(skill => skill.status !== 'archived' && skill.status !== 'paused');
}

function projectOptions() {
  return (profile?.projects || []).filter(project => project.status !== 'archived');
}

function findSkill(id) {
  return activeSkills().find(skill => skill.id === id) || activeSkills()[0] || null;
}

function findProject(id) {
  return projectOptions().find(project => project.id === id) || projectOptions()[0] || null;
}

function skillName(id) {
  return profile?.skills.find(skill => skill.id === id)?.name || 'Unknown skill';
}

function toolName(id) {
  return profile?.tools.find(tool => tool.id === id)?.name || 'Unknown tool';
}

function formatDate(iso) {
  if (!iso) return 'No date';
  try {
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

// A date-precision Life Ledger event (see life-ledger-core.js's temporal-precision
// invariant, e.g. meal_prepared) has no occurredAt — occurredDate is its factual anchor
// instead. formatDate() only ever renders the calendar date (no time-of-day), so passing
// either through is safe; this just picks the one that actually exists for the event.
function ledgerEventDate(event) {
  return event && event.temporalPrecision === 'date' ? event.occurredDate : event && event.occurredAt;
}

function toIsoFromDateInput(value) {
  if (!value) return undefined;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function readLedgerEvents(options = {}) {
  try {
    const events = createLocalLifeLedgerStore().listEvents()
      .sort((a, b) => String(ledgerEventDate(b)).localeCompare(String(ledgerEventDate(a))));
    if (options.includeUnavailable) return events;
    return events.filter(event => !event.tombstone?.active).slice(0, 40);
  } catch {
    return [];
  }
}

function ledgerEventLabel(event) {
  const payload = event?.payload || {};
  return payload.activity || payload.stepLabel || event.type || 'Life Ledger event';
}

function ledgerEventContext(event) {
  const payload = event?.payload || {};
  const bits = [event.type, payload.source?.planTitle, payload.source?.lessonTitle].filter(Boolean);
  if (event.tombstone?.active) bits.push('tombstoned');
  return bits.join(' / ');
}

function importInput() {
  return String(document.getElementById('cap-career-import-text')?.value || '');
}

function importFingerprint(value = importInput()) {
  return value;
}

function clearImportPreview() {
  importPreview = null;
  importPreviewFingerprint = '';
  renderImportPreview();
}

function renderImportPreview() {
  const mount = document.getElementById('cap-career-import-preview');
  const button = document.querySelector('[data-cc-import-action="save"]');
  if (button) button.disabled = !importPreview || importFingerprint() !== importPreviewFingerprint;
  if (!mount) return;
  mount.replaceChildren();
  if (!importPreview) {
    mount.hidden = true;
    return;
  }
  mount.hidden = false;
  const title = document.createElement('div');
  title.className = 'cap-career-preview-title';
  title.textContent = importPreviewSummary(importPreview);
  mount.append(title);
  const list = document.createElement('div');
  list.className = 'cap-career-preview-list';
  [
    ['Skills', importPreview.draft.skills.map(item => item.name)],
    ['Targets', importPreview.draft.careerTargets.map(item => item.title)],
    ['Projects', importPreview.draft.projects.map(item => item.title)]
  ].forEach(([label, items]) => {
    const row = document.createElement('div');
    row.textContent = `${label}: ${items.length ? items.join(', ') : 'none'}`;
    list.append(row);
  });
  mount.append(list);
}

function renderUnavailable() {
  const dashboard = document.getElementById('cap-career-dashboard');
  const setup = document.getElementById('cap-career-setup');
  if (setup) setup.hidden = true;
  if (dashboard) {
    dashboard.innerHTML = `
      <section class="cap-career-empty">
        <div class="cap-career-empty-title">Capability/Career unavailable</div>
        <div class="cap-career-muted">Your stored data was left unchanged.</div>
      </section>
    `;
  }
}

function renderDimensionStrip(totals) {
  const labels = {
    knowledge: 'Knowledge',
    practice: 'Practice',
    execution: 'Execution',
    shipping: 'Shipping',
    portfolio: 'Portfolio'
  };
  return `
    <div class="cap-career-dimensions">
      ${Object.keys(labels).map(key => `
        <div class="cap-career-dimension">
          <span>${labels[key]}</span>
          <strong>${totals[key] || 0}</strong>
        </div>
      `).join('')}
    </div>
  `;
}

function renderTargetCard(analysis) {
  const target = analysis.target;
  if (!target) {
    return `
      <section class="cap-career-hero">
        <div class="cap-career-kicker">Career target</div>
        <h2>No active target yet</h2>
        <p>Set the role or direction you are aiming at before interpreting evidence.</p>
        <button class="btn primary" type="button" data-cc-action="open-panel" data-panel="target">Add target</button>
      </section>
    `;
  }
  return `
    <section class="cap-career-hero">
      <div class="cap-career-kicker">Career target</div>
      <h2>${escapeHtml(target.title)}</h2>
      <p>${escapeHtml(target.objective || 'No objective notes yet.')}</p>
      <div class="cap-career-linked-line">${target.skillIds.length ? target.skillIds.map(skillName).map(escapeHtml).join(' / ') : 'No linked target skills yet'}</div>
    </section>
  `;
}

function renderNextAction(action) {
  return `
    <section class="cap-career-next">
      <div>
        <div class="cap-career-kicker">Primary next action</div>
        <h3>${escapeHtml(action.title)}</h3>
        <p>${escapeHtml(action.reason)}</p>
      </div>
      <span class="cap-career-confidence">${escapeHtml(action.confidence)} confidence</span>
    </section>
  `;
}

function renderExcludedEvidenceNotice(analysis) {
  if (!analysis.excludedEvidence?.length) return '';
  const ledgerCount = analysis.excludedEvidence.filter(item => item.reason.startsWith('life-ledger')).length;
  const futureCount = analysis.excludedEvidence.filter(item => item.reason === 'future').length;
  const parts = [];
  if (ledgerCount) parts.push(`${ledgerCount} Life Ledger evidence link${ledgerCount === 1 ? '' : 's'} unavailable or tombstoned`);
  if (futureCount) parts.push(`${futureCount} future evidence record${futureCount === 1 ? '' : 's'}`);
  return `
    <section class="cap-career-section cap-career-subtle">
      <div class="settings-title">Historical evidence held aside</div>
      <div class="cap-career-muted">${escapeHtml(parts.join('; '))}. These records stay stored, but they are not counted as current proof.</div>
    </section>
  `;
}

function renderStalls(stalls) {
  if (!stalls.length) {
    return `
      <section class="cap-career-section">
        <div class="settings-title">Signals</div>
        <div class="cap-career-muted">No conservative stall signal yet.</div>
      </section>
    `;
  }
  return `
    <section class="cap-career-section">
      <div class="settings-title">Signals</div>
      <div class="cap-career-signal-list">
        ${stalls.slice(0, 6).map(stall => `
          <div class="cap-career-signal">
            <strong>${escapeHtml(stall.message)}</strong>
            <span>${escapeHtml(stall.reason)}</span>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function renderSkills(signals) {
  if (!profile.skills.length) {
    return `<div class="cap-career-muted">No skills yet. Add target skills or import a starter profile.</div>`;
  }
  const byId = new Map(signals.map(signal => [signal.skillId, signal]));
  return `
    <div class="cap-career-card-grid">
      ${profile.skills.filter(skill => skill.status !== 'archived').map(skill => {
        const signal = byId.get(skill.id);
        const counts = signal?.counts || {};
        return `
          <article class="cap-career-card">
            <div class="cap-career-card-top">
              <div>
                <div class="cap-career-card-title">${escapeHtml(skill.name)}</div>
                <div class="cap-career-muted">${escapeHtml(skill.category || skill.status)}</div>
              </div>
              <span class="cap-career-pill">${escapeHtml(signal?.momentum || 'no-evidence')}</span>
            </div>
            <div class="cap-career-card-note">${escapeHtml(signal?.momentumReason || 'No evidence yet.')}</div>
            <div class="cap-career-mini-dims">
              ${['knowledge', 'practice', 'execution', 'shipping', 'portfolio'].map(key => `<span>${key.slice(0, 1).toUpperCase()}${counts[key] || 0}</span>`).join('')}
            </div>
            <button class="btn sm" type="button" data-cc-action="open-evidence" data-skill-id="${escapeHtml(skill.id)}">Add evidence</button>
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function renderProjects(projects) {
  if (!profile.projects.length) return `<div class="cap-career-muted">No projects yet.</div>`;
  const byId = new Map(projects.map(project => [project.projectId, project]));
  return `
    <div class="cap-career-card-grid">
      ${profile.projects.filter(project => project.status !== 'archived').map(project => {
        const signal = byId.get(project.id);
        return `
          <article class="cap-career-card">
            <div class="cap-career-card-top">
              <div>
                <div class="cap-career-card-title">${escapeHtml(project.title)}</div>
                <div class="cap-career-muted">${escapeHtml(project.status)} / portfolio: ${escapeHtml(project.portfolioStatus)}</div>
              </div>
              <span class="cap-career-pill">${signal?.artifactCount || 0} artifacts</span>
            </div>
            <div class="cap-career-card-note">${escapeHtml(project.summary || 'No summary yet.')}</div>
            <div class="cap-career-linked-line">${project.skillIds.map(skillName).map(escapeHtml).join(' / ') || 'No linked skills'}</div>
            <div class="cap-career-linked-line">${project.toolIds.map(toolName).map(escapeHtml).join(' / ') || 'No linked tools'}</div>
            <div class="cap-career-card-actions">
              <button class="btn sm" type="button" data-cc-action="open-artifact" data-project-id="${escapeHtml(project.id)}">Add artifact</button>
              ${signal?.actionable && ['none', 'candidate'].includes(project.portfolioStatus)
                ? `<button class="btn sm" type="button" data-cc-action="mark-portfolio-ready" data-project-id="${escapeHtml(project.id)}">Mark portfolio ready</button>`
                : ''}
            </div>
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function renderDashboard() {
  const dashboard = document.getElementById('cap-career-dashboard');
  if (!dashboard || !profile) return;
  const analysis = analyzeCapabilityCareer(profile, { now: new Date().toISOString(), lifeLedgerEvents: readLedgerEvents({ includeUnavailable: true }) });
  dashboard.innerHTML = `
    ${renderTargetCard(analysis)}
    ${renderNextAction(analysis.nextAction)}
    ${renderExcludedEvidenceNotice(analysis)}
    <section class="cap-career-section">
      <div class="settings-title">Evidence shape</div>
      ${renderDimensionStrip(analysis.dimensionTotals)}
    </section>
    ${renderStalls(analysis.stalls)}
    <section class="cap-career-section">
      <div class="cap-career-section-head">
        <div class="settings-title">Important skills</div>
        <button class="btn sm" type="button" data-cc-action="open-panel" data-panel="skill">Add skill</button>
      </div>
      ${renderSkills(analysis.skills)}
    </section>
    <section class="cap-career-section">
      <div class="cap-career-section-head">
        <div class="settings-title">Projects and proof</div>
        <button class="btn sm" type="button" data-cc-action="open-panel" data-panel="project">Add project</button>
      </div>
      ${renderProjects(analysis.projects)}
    </section>
  `;
}

function renderChoiceList(items, name, labelFn) {
  if (!items.length) return `<div class="cap-career-muted">No choices yet.</div>`;
  return `
    <div class="cap-career-checks">
      ${items.map(item => `
        <label><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(item.id)}"> ${escapeHtml(labelFn(item))}</label>
      `).join('')}
    </div>
  `;
}

function renderSetupPanels() {
  const setup = document.getElementById('cap-career-setup');
  if (!setup || !profile) return;
  setup.hidden = false;
  const currentSkill = findSkill(selectedSkillId);
  const currentProject = findProject(selectedProjectId);
  setup.innerHTML = `
    <div class="cap-career-actions">
      <button class="btn primary" type="button" data-cc-action="open-panel" data-panel="import" aria-expanded="${openPanel === 'import'}">Import starter profile</button>
      <button class="btn" type="button" data-cc-action="open-panel" data-panel="target" aria-expanded="${openPanel === 'target'}">Target</button>
      <button class="btn" type="button" data-cc-action="open-panel" data-panel="skill" aria-expanded="${openPanel === 'skill'}">Skill</button>
      <button class="btn" type="button" data-cc-action="open-panel" data-panel="tool" aria-expanded="${openPanel === 'tool'}">Tool</button>
      <button class="btn" type="button" data-cc-action="open-panel" data-panel="project" aria-expanded="${openPanel === 'project'}">Project</button>
      <button class="btn" type="button" data-cc-action="open-panel" data-panel="evidence" aria-expanded="${openPanel === 'evidence'}">Evidence</button>
    </div>
    <section id="cap-career-import-panel" class="settings-section cap-career-panel" ${openPanel === 'import' ? '' : 'hidden'}>
      <div class="settings-title">Import starter profile</div>
      <form data-cc-form="import">
        <div class="field">
          <label for="cap-career-import-text">Paste JSON</label>
          <textarea id="cap-career-import-text" rows="10" spellcheck="false" placeholder='{"skills":[{"name":"JavaScript"}],"careerTargets":[{"title":"Automation developer","skills":["JavaScript"]}]}'></textarea>
        </div>
        <div class="cap-career-form-actions">
          <button class="btn" type="button" data-cc-import-action="preview">Preview</button>
          <button class="btn primary" type="submit" data-cc-import-action="save" disabled>Save import</button>
          <button class="btn ghost" type="button" data-cc-action="close-panel">Cancel</button>
        </div>
        <div id="cap-career-import-preview" class="cap-career-preview" role="region" aria-label="Capability import preview" hidden></div>
      </form>
    </section>
    <section class="settings-section cap-career-panel" ${openPanel === 'target' ? '' : 'hidden'}>
      <div class="settings-title">Career target</div>
      <form data-cc-form="target">
        <div class="field"><label>Target role or direction</label><input name="title" maxlength="160" autocomplete="off"></div>
        <div class="field"><label>Objective</label><input name="objective" maxlength="500" autocomplete="off"></div>
        <div class="field"><label>Target capabilities</label>${renderChoiceList(activeSkills(), 'skillIds', item => item.name)}</div>
        <button class="btn primary" type="submit">Save target</button>
      </form>
    </section>
    <section class="settings-section cap-career-panel" ${openPanel === 'skill' ? '' : 'hidden'}>
      <div class="settings-title">Skill</div>
      <form data-cc-form="skill">
        <div class="field"><label>Name</label><input name="name" maxlength="160" autocomplete="off"></div>
        <div class="field-row">
          <div class="field"><label>Category</label><input name="category" maxlength="120" autocomplete="off"></div>
          <div class="field"><label>Current state</label><input name="currentLevel" maxlength="120" autocomplete="off"></div>
        </div>
        <div class="field"><label>Target state</label><input name="targetLevel" maxlength="120" autocomplete="off"></div>
        <button class="btn primary" type="submit">Add skill</button>
      </form>
    </section>
    <section class="settings-section cap-career-panel" ${openPanel === 'tool' ? '' : 'hidden'}>
      <div class="settings-title">Tool</div>
      <form data-cc-form="tool">
        <div class="field"><label>Name</label><input name="name" maxlength="160" autocomplete="off"></div>
        <div class="field"><label>Category</label><input name="category" maxlength="120" autocomplete="off"></div>
        <div class="field"><label>Related skills</label>${renderChoiceList(activeSkills(), 'skillIds', item => item.name)}</div>
        <button class="btn primary" type="submit">Add tool</button>
      </form>
    </section>
    <section class="settings-section cap-career-panel" ${openPanel === 'project' ? '' : 'hidden'}>
      <div class="settings-title">Project</div>
      <form data-cc-form="project">
        <div class="field"><label>Title</label><input name="title" maxlength="160" autocomplete="off"></div>
        <div class="field"><label>Summary</label><input name="summary" maxlength="500" autocomplete="off"></div>
        <div class="field-row">
          <div class="field"><label>Status</label><select name="status"><option value="active">Active</option><option value="idea">Idea</option><option value="paused">Paused</option><option value="shipped">Shipped</option></select></div>
          <div class="field"><label>Portfolio status</label><select name="portfolioStatus"><option value="none">Not portfolio material</option><option value="candidate">Candidate</option><option value="ready">Ready</option><option value="published">Published</option></select></div>
        </div>
        <div class="field"><label>Skills demonstrated</label>${renderChoiceList(activeSkills(), 'skillIds', item => item.name)}</div>
        <div class="field"><label>Tools used</label>${renderChoiceList(profile.tools, 'toolIds', item => item.name)}</div>
        <div class="field"><label>Career targets</label>${renderChoiceList(profile.careerTargets, 'careerTargetIds', item => item.title)}</div>
        <button class="btn primary" type="submit">Add project</button>
      </form>
    </section>
    <section class="settings-section cap-career-panel" ${openPanel === 'artifact' ? '' : 'hidden'}>
      <div class="settings-title">Portfolio artifact</div>
      <form data-cc-form="artifact">
        <input type="hidden" name="projectId" value="${escapeHtml(currentProject?.id || '')}">
        <div class="cap-career-muted">Project: ${escapeHtml(currentProject?.title || 'Add a project first')}</div>
        <div class="field-row">
          <div class="field"><label>Type</label><select name="type"><option value="link">Link</option><option value="repository">Repository</option><option value="deployment">Deployment</option><option value="screenshot">Screenshot</option><option value="document">Document</option><option value="case-study">Case study</option><option value="note">Note</option></select></div>
          <div class="field"><label>Label</label><input name="label" maxlength="160" autocomplete="off"></div>
        </div>
        <div class="field"><label>Reference</label><input name="reference" maxlength="1000" autocomplete="off"></div>
        <button class="btn primary" type="submit" ${currentProject ? '' : 'disabled'}>Add artifact</button>
      </form>
    </section>
    <section class="settings-section cap-career-panel" ${openPanel === 'evidence' ? '' : 'hidden'}>
      <div class="settings-title">Evidence</div>
      <form data-cc-form="evidence">
        <div class="field"><label>Capability</label><select name="skillId">${activeSkills().map(skill => `<option value="${escapeHtml(skill.id)}" ${currentSkill?.id === skill.id ? 'selected' : ''}>${escapeHtml(skill.name)}</option>`).join('')}</select></div>
        <div class="field-row">
          <div class="field"><label>Dimension</label><select name="dimension"><option value="knowledge">Knowledge</option><option value="practice">Practice</option><option value="execution">Execution</option><option value="shipping">Shipping</option><option value="portfolio">Portfolio</option></select></div>
          <div class="field"><label>Source</label><select name="source" data-cc-action="change-evidence-source"><option value="manual">Manual</option><option value="life-ledger">Life Ledger event</option><option value="project">Project / artifact</option></select></div>
        </div>
        <div class="field"><label>Summary</label><input name="summary" maxlength="240" autocomplete="off"></div>
        <div class="field"><label>Observed date</label><input name="observedDate" type="date"></div>
        <div id="cap-career-evidence-source-extra">${renderEvidenceSourceExtra('manual')}</div>
        <button class="btn primary" type="submit" ${currentSkill ? '' : 'disabled'}>Save evidence</button>
      </form>
    </section>
  `;
  renderImportPreview();
}

function renderEvidenceSourceExtra(source) {
  if (source === 'life-ledger') {
    const events = readLedgerEvents();
    if (!events.length) return '<div class="cap-career-muted">No Life Ledger events available locally.</div>';
    return `
      <div class="cap-career-ledger-list" role="radiogroup" aria-label="Life Ledger events">
        ${events.map(event => `
          <label class="cap-career-ledger-item">
            <input type="radio" name="lifeLedgerEventId" value="${escapeHtml(event.eventId)}" data-ledger-key="${escapeHtml(`${event.sourceApp}:${event.sourceEntityId}:${event.type}`)}" ${selectedLedgerEventId === event.eventId ? 'checked' : ''}>
            <span>
              <strong>${escapeHtml(formatDate(ledgerEventDate(event)))} - ${escapeHtml(ledgerEventLabel(event))}</strong>
              <small>${escapeHtml(ledgerEventContext(event))}</small>
            </span>
          </label>
        `).join('')}
      </div>
    `;
  }
  if (source === 'project') {
    return `
      <div class="field"><label>Project</label><select name="projectId">${projectOptions().map(project => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.title)}</option>`).join('')}</select></div>
    `;
  }
  return '<div class="cap-career-muted">Manual evidence is your explicit note. It does not claim objective proof by itself.</div>';
}

function renderCapabilityCareerState() {
  if (!available || !profile) {
    renderUnavailable();
    return;
  }
  renderDashboard();
  renderSetupPanels();
}

function handleImportPreview() {
  const result = parseCapabilityCareerImportJson(importInput());
  if (!result.ok) {
    clearImportPreview();
    setError(result.errors.join(' '));
    return;
  }
  importPreview = result;
  importPreviewFingerprint = importFingerprint();
  setError('');
  renderImportPreview();
}

function handleImportSubmit() {
  if (!profile || !isEmptyProfile(profile)) {
    setError('Import is only available before manual Capability/Career data exists. Existing data was left unchanged.');
    return;
  }
  if (!importPreview || importFingerprint() !== importPreviewFingerprint) {
    setError('Preview the current import before saving it.');
    clearImportPreview();
    return;
  }
  const result = parseCapabilityCareerImportJson(importInput());
  if (!result.ok) {
    setError(result.errors.join(' '));
    clearImportPreview();
    return;
  }
  const next = buildCapabilityProfileFromImportDraft(result.draft);
  if (saveProfile(next, 'Could not import Capability/Career profile. Nothing was saved.')) {
    openPanel = '';
    clearImportPreview();
  }
}

function handleForm(form) {
  if (!profile) return;
  const kind = form.dataset.ccForm;
  if (kind === 'import') {
    handleImportSubmit();
    return;
  }
  let next = profile;
  if (kind === 'skill') {
    next = addSkill(profile, {
      name: formValue(form, 'name'),
      category: formValue(form, 'category'),
      currentLevel: formValue(form, 'currentLevel'),
      targetLevel: formValue(form, 'targetLevel')
    });
  }
  if (kind === 'tool') {
    next = addTool(profile, {
      name: formValue(form, 'name'),
      category: formValue(form, 'category'),
      skillIds: checkedValues(form, 'skillIds')
    });
  }
  if (kind === 'target') {
    next = addCareerTarget(profile, {
      title: formValue(form, 'title'),
      objective: formValue(form, 'objective'),
      skillIds: checkedValues(form, 'skillIds'),
      priority: 'primary',
      status: 'active'
    });
  }
  if (kind === 'project') {
    next = addProject(profile, {
      title: formValue(form, 'title'),
      summary: formValue(form, 'summary'),
      status: formValue(form, 'status'),
      portfolioStatus: formValue(form, 'portfolioStatus'),
      skillIds: checkedValues(form, 'skillIds'),
      toolIds: checkedValues(form, 'toolIds'),
      careerTargetIds: checkedValues(form, 'careerTargetIds')
    });
  }
  if (kind === 'artifact') {
    next = addPortfolioArtifact(profile, {
      projectId: formValue(form, 'projectId'),
      type: formValue(form, 'type'),
      label: formValue(form, 'label'),
      reference: formValue(form, 'reference')
    });
  }
  if (kind === 'evidence') {
    const source = formValue(form, 'source');
    const ledger = form.querySelector('input[name="lifeLedgerEventId"]:checked');
    next = addEvidence(profile, {
      skillId: formValue(form, 'skillId'),
      dimension: formValue(form, 'dimension'),
      source,
      summary: formValue(form, 'summary'),
      observedAt: toIsoFromDateInput(formValue(form, 'observedDate')),
      lifeLedgerEventId: ledger?.value || undefined,
      lifeLedgerKey: ledger?.dataset.ledgerKey || undefined,
      projectId: formValue(form, 'projectId') || undefined
    });
  }
  saveProfile(next);
}

function handleClick(event) {
  const target = event.target.closest('[data-cc-action], [data-cc-import-action]');
  if (!target) return;
  const importAction = target.dataset.ccImportAction;
  if (importAction === 'preview') {
    handleImportPreview();
    return;
  }
  const action = target.dataset.ccAction;
  if (action === 'open-panel') {
    openPanel = target.dataset.panel || '';
    renderCapabilityCareerState();
    return;
  }
  if (action === 'close-panel') {
    openPanel = '';
    renderCapabilityCareerState();
    return;
  }
  if (action === 'open-evidence') {
    selectedSkillId = target.dataset.skillId || '';
    openPanel = 'evidence';
    renderCapabilityCareerState();
    return;
  }
  if (action === 'open-artifact') {
    selectedProjectId = target.dataset.projectId || '';
    openPanel = 'artifact';
    renderCapabilityCareerState();
    return;
  }
  if (action === 'mark-portfolio-ready') {
    const projectId = target.dataset.projectId || '';
    if (projectId && profile) saveProfile(updateProjectPortfolioStatus(profile, projectId, 'ready'));
  }
}

function handleChange(event) {
  const target = event.target.closest('[data-cc-action], input[name="lifeLedgerEventId"]');
  if (!target) return;
  if (target.name === 'lifeLedgerEventId') selectedLedgerEventId = target.value;
  if (target.dataset.ccAction === 'change-evidence-source') {
    const mount = document.getElementById('cap-career-evidence-source-extra');
    if (mount) mount.innerHTML = renderEvidenceSourceExtra(target.value);
  }
}

function handleInput(event) {
  if (event.target?.id === 'cap-career-import-text' && importPreview && importFingerprint() !== importPreviewFingerprint) {
    clearImportPreview();
  }
}

function handleSubmit(event) {
  const form = event.target.closest('form[data-cc-form]');
  if (!form) return;
  event.preventDefault();
  runExclusive(() => {
    try {
      handleForm(form);
    } catch (err) {
      setError(err.message || 'Capability/Career update failed. Nothing was changed.');
    }
  });
}

function initCapabilityCareer() {
  if (initialized) return;
  initialized = true;
  const view = document.getElementById('view-career');
  if (!view) return;
  view.addEventListener('click', handleClick);
  view.addEventListener('change', handleChange);
  view.addEventListener('input', handleInput);
  view.addEventListener('submit', handleSubmit);
}

export function renderCapabilityCareer() {
  initCapabilityCareer();
  if (!loadProfile()) {
    renderUnavailable();
    return;
  }
  renderCapabilityCareerState();
}

window.renderCapabilityCareer = renderCapabilityCareer;
initCapabilityCareer();
