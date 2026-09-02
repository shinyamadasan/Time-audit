// Cross-Domain Intelligence — UI (Phase 8 V1).
//
// Renders the read-only "what deserves attention next?" view into
// #cross-domain-intelligence-root. It reads three local stores (Life Ledger runtime, Learning
// Plan repository, Capability profile) ONCE per render, builds the pure Life Character Sheet
// projection, hands that to the pure buildCrossDomainIntelligence() engine, and paints the
// result. It never writes to any store, never revises/tombstones a ledger event, and never
// completes a plan step or starts a focus session. The only interactive control is a plain
// navigation link that calls the app's existing showView().
//
// Facts first (what's driving attention), then interpretations (signals), then at most one
// recommendation with a fully traceable "why". Domains without live coverage are listed as
// "not evaluated" — never healthy / unhealthy / inactive / behind.

import { createLocalLifeLedgerStore } from './life-ledger-runtime.js';
import { createLearningPlanRepository } from './learning-plan-repository.js';
import { createCapabilityCareerRepository } from './capability-career-repository.js';
import { buildLifeCharacterSheet } from './life-character-sheet-model.js';
import { buildCrossDomainIntelligence } from './cross-domain-intelligence-model.js';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mount() {
  return document.getElementById('cross-domain-intelligence-root');
}

// Same reference-zone resolution the Life Feed and Character Sheet use, so all three Life
// surfaces bucket "today" identically for the same events.
function referenceTimeZone() {
  let hint = '';
  try {
    hint = (window.settings && window.settings.timezone) || globalThis.localStorage?.getItem('ta3-tz') || '';
  } catch {
    hint = '';
  }
  const normalized = hint === 'UTC' ? 'Etc/UTC' : hint;
  try {
    if (normalized) {
      new Intl.DateTimeFormat('en-US', { timeZone: normalized });
      return normalized;
    }
  } catch {
    // not a usable IANA zone — fall through
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
  } catch {
    return 'Etc/UTC';
  }
}

// Read every source defensively — one unreadable store must not blank the whole view.
function loadInputs() {
  const notes = [];
  let ledgerEvents = [];
  try {
    ledgerEvents = createLocalLifeLedgerStore().listEvents();
  } catch (err) {
    notes.push(`Life Ledger could not be read (${err && err.message ? err.message : 'unknown error'}).`);
  }
  let learningPlans = [];
  try {
    learningPlans = createLearningPlanRepository().listPlans();
  } catch (err) {
    notes.push(`Learning plans could not be read (${err && err.message ? err.message : 'unknown error'}).`);
  }
  let capabilityProfile = null;
  try {
    capabilityProfile = createCapabilityCareerRepository().loadProfile();
  } catch (err) {
    notes.push(`Capability profile could not be read (${err && err.message ? err.message : 'unknown error'}).`);
  }
  return { ledgerEvents, learningPlans, capabilityProfile, notes };
}

const STRENGTH_TEXT = {
  HIGH: 'High confidence — explicit plan / analyzer output plus an explicit target link',
  MEDIUM: 'Medium confidence — an explicit plan or stall, with weak or no target link',
  LOW: 'Low confidence — limited supporting evidence',
  INSUFFICIENT: 'Insufficient evidence to recommend'
};

const HOME_VIEW_LABEL = {
  learning: 'Open in Learning Plans',
  career: 'Open in Career'
};

function noteLine(text) {
  return `<p class="cdi-note">${escapeHtml(text)}</p>`;
}

function evidenceList(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return '';
  return `<ul class="cdi-evidence">${evidence.map(ref =>
    `<li><span class="cdi-evidence-label">${escapeHtml(ref.label)}</span>`
    + `<span class="cdi-evidence-value">${escapeHtml(ref.value)}</span>`
    + (ref.source ? `<span class="cdi-evidence-source">${escapeHtml(ref.source)}</span>` : '')
    + `</li>`).join('')}</ul>`;
}

function reasonList(reasons) {
  const items = (Array.isArray(reasons) ? reasons : []).filter(Boolean);
  if (!items.length) return '';
  return `<ul class="cdi-why">${items.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`;
}

function recommendationBlock(intel) {
  const rec = intel.recommendedAction;
  if (!rec) {
    return `
      <section class="cdi-recommendation cdi-recommendation-none" aria-labelledby="cdi-next-heading">
        <div class="cdi-kicker">Next</div>
        <h3 id="cdi-next-heading" class="cdi-headline">No cross-domain recommendation yet</h3>
        <p class="cdi-abstain">${escapeHtml(intel.abstentionReason || 'Not enough explicit signal to recommend a single next action.')}</p>
      </section>`;
  }
  const context = Array.isArray(rec.context) && rec.context.length
    ? `<p class="cdi-context">${escapeHtml(rec.context.join(' · '))}</p>`
    : '';
  const homeBtn = rec.homeView && HOME_VIEW_LABEL[rec.homeView]
    ? `<button type="button" class="btn sm cdi-open" data-cdi-open="${escapeHtml(rec.homeView)}">${escapeHtml(HOME_VIEW_LABEL[rec.homeView])} &rarr;</button>`
    : '';
  return `
    <section class="cdi-recommendation" aria-labelledby="cdi-next-heading">
      <div class="cdi-kicker">Next</div>
      <h3 id="cdi-next-heading" class="cdi-headline">${escapeHtml(rec.action)}</h3>
      ${context}
      <p class="cdi-strength" data-strength="${escapeHtml(rec.evidenceStrength)}">
        <span class="cdi-strength-tag">${escapeHtml(rec.evidenceStrength)}</span>
        <span class="cdi-strength-text">${escapeHtml(STRENGTH_TEXT[rec.evidenceStrength] || '')}</span>
      </p>
      <h4 class="cdi-subhead">Why this</h4>
      ${reasonList(rec.why)}
      ${evidenceList(rec.evidence)}
      ${homeBtn}
    </section>`;
}

function alternativesBlock(intel) {
  const alts = Array.isArray(intel.alternatives) ? intel.alternatives : [];
  if (!alts.length) return '';
  return `
    <section class="cdi-section" aria-labelledby="cdi-alts-heading">
      <h3 id="cdi-alts-heading" class="cdi-section-title">Other valid options</h3>
      <ul class="cdi-alt-list">
        ${alts.map(alt => `
          <li class="cdi-alt">
            <div class="cdi-alt-action">${escapeHtml(alt.action)}</div>
            <div class="cdi-alt-meta">${escapeHtml(alt.evidenceStrength)} confidence${alt.outrankedBy ? ` · ${escapeHtml(alt.outrankedBy.reason)}` : ''}</div>
          </li>`).join('')}
      </ul>
    </section>`;
}

function signalsBlock(intel) {
  const signals = Array.isArray(intel.signals) ? intel.signals : [];
  if (!signals.length) return '';
  return `
    <section class="cdi-section" aria-labelledby="cdi-signals-heading">
      <h3 id="cdi-signals-heading" class="cdi-section-title">What's driving attention</h3>
      <ul class="cdi-signal-list">
        ${signals.map(signal => `
          <li class="cdi-signal" data-severity="${escapeHtml(signal.severity)}">
            <span class="cdi-signal-severity">${signal.severity === 'attention' ? 'Attention' : 'Context'}</span>
            <div class="cdi-signal-body">
              <div class="cdi-signal-summary">${escapeHtml(signal.summary)}</div>
              ${signal.detail ? `<div class="cdi-signal-detail">${escapeHtml(signal.detail)}</div>` : ''}
            </div>
          </li>`).join('')}
      </ul>
    </section>`;
}

function notEvaluatedBlock(intel) {
  const blocked = Array.isArray(intel.blockedDomains) ? intel.blockedDomains : [];
  if (!blocked.length) return '';
  return `
    <section class="cdi-section cdi-not-evaluated" aria-labelledby="cdi-blocked-heading">
      <h3 id="cdi-blocked-heading" class="cdi-section-title">Data not evaluated</h3>
      <p class="cdi-blocked-names">${blocked.map(d => escapeHtml(d.label)).join(' · ')}</p>
      <ul class="cdi-blocked-list">
        ${blocked.map(d => `<li>${escapeHtml(d.label)}: ${escapeHtml(d.note)}</li>`).join('')}
      </ul>
    </section>`;
}

function render() {
  const root = mount();
  if (!root) return;

  const { ledgerEvents, learningPlans, capabilityProfile, notes } = loadInputs();
  let intel;
  try {
    const characterSheet = buildLifeCharacterSheet({
      ledgerEvents,
      learningPlans,
      capabilityProfile,
      now: new Date(),
      referenceTimeZone: referenceTimeZone()
    });
    intel = buildCrossDomainIntelligence({
      characterSheet,
      ledgerEvents,
      learningPlans,
      capabilityProfile
    });
  } catch (err) {
    root.innerHTML = `<p class="cdi-error" role="alert">Could not build the attention view: ${escapeHtml(err && err.message ? err.message : 'unknown error')}</p>`;
    return;
  }

  const parts = [
    `<p class="cdi-generated">What deserves attention · ${escapeHtml(intel.todayKey || '')} · ${escapeHtml(intel.referenceTimeZone)}</p>`,
    notes.map(noteLine).join(''),
    recommendationBlock(intel),
    alternativesBlock(intel),
    signalsBlock(intel),
    notEvaluatedBlock(intel)
  ];
  root.innerHTML = parts.filter(Boolean).join('');
}

// The only interactive control: a plain navigation into an existing view. No writes, no
// plan-step completion, no focus start.
function onClick(event) {
  const openBtn = event.target.closest('[data-cdi-open]');
  if (!openBtn) return;
  const view = openBtn.getAttribute('data-cdi-open');
  if ((view === 'learning' || view === 'career') && typeof window.showView === 'function') {
    window.showView(view);
  }
}

let initialized = false;
function init() {
  if (initialized) return;
  initialized = true;
  const root = mount();
  if (root) root.addEventListener('click', onClick);
}

export function renderCrossDomainIntelligence() {
  init();
  render();
}

if (typeof window !== 'undefined') {
  window.renderCrossDomainIntelligence = renderCrossDomainIntelligence;
  init();
}
