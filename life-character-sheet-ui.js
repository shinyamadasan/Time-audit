// Life Character Sheet — UI (Phase 7 V1).
//
// Renders the read-only "where am I right now?" snapshot into #life-character-sheet-root.
// It reads three local stores (Life Ledger runtime, Learning Plan repository, Capability
// profile) ONCE per render, hands them to the pure buildLifeCharacterSheet() projection, and
// paints the result. It never writes to any of them, never queries Meal or Workout, and
// never revises/tombstones a ledger event.
//
// No coaching, no scores, no red/yellow/green judgment — facts and honest coverage only.

import { createLocalLifeLedgerStore } from './life-ledger-runtime.js';
import { createLearningPlanRepository } from './learning-plan-repository.js';
import { createCapabilityCareerRepository } from './capability-career-repository.js';
import { buildLifeCharacterSheet } from './life-character-sheet-model.js';

let initialized = false;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mount() {
  return document.getElementById('life-character-sheet-root');
}

// Resolve the same reference zone the Life Feed uses, so both surfaces bucket "today" the
// same way for the same events. Honours an explicit 'UTC' choice (mapped to 'Etc/UTC', which
// buildLifeFeed accepts) instead of silently falling back to the browser zone.
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

// Read every source defensively — a single unreadable store must not blank the whole sheet.
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

// ── small render helpers ─────────────────────────────────────────────────────────────────
function minutesLabel(mins) {
  const n = Math.round(mins || 0);
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function countLabel(n, one, many) {
  return `${n} ${n === 1 ? one : (many || `${one}s`)}`;
}

function dayKeyLabel(dayKey, todayKey) {
  if (!dayKey) return '';
  if (dayKey === todayKey) return 'today';
  const [y, mo, d] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  const sameYear = todayKey.slice(0, 4) === dayKey.slice(0, 4);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Etc/UTC', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' })
  }).format(date);
}

function statLine(label, value) {
  return `<div class="lcs-stat"><span class="lcs-stat-label">${escapeHtml(label)}</span>`
    + `<span class="lcs-stat-value">${escapeHtml(value)}</span></div>`;
}

function noteLine(text) {
  return `<p class="lcs-note">${escapeHtml(text)}</p>`;
}

const COVERAGE_TEXT = {
  active: 'Connected · updating live',
  'no-events-yet': 'Connected · no events yet',
  'loaded-not-live': 'Loaded from an import · not updating automatically',
  'not-connected': 'Not connected to the Life Ledger yet',
  unreadable: 'Stored data could not be read'
};

function coverageLine(cov) {
  const text = COVERAGE_TEXT[cov.state] || 'Status unknown';
  const stamp = cov.lastEventDayKey ? ` · last event ${escapeHtml(cov.lastEventDayKey)}` : '';
  return `<p class="lcs-coverage" data-state="${escapeHtml(cov.state)}">${escapeHtml(text)}${stamp}</p>`;
}

function section(title, innerHtml, coverage) {
  return `<section class="lcs-section">`
    + `<h3 class="lcs-section-title">${escapeHtml(title)}</h3>`
    + innerHtml
    + (coverage ? coverageLine(coverage) : '')
    + `</section>`;
}

// ── per-domain blocks ────────────────────────────────────────────────────────────────────
function focusBlock(sheet) {
  const f = sheet.focus;
  if (f.status !== 'data') {
    return section('Time & Focus', noteLine('No focus sessions logged yet.'), sheet.coverage.focus);
  }
  const parts = [
    statLine('Focus today', `${countLabel(f.today.sessions, 'session')} · ${minutesLabel(f.today.minutes)}`),
    statLine('Last 7 days', `${countLabel(f.last7Days.sessions, 'session')} · ${minutesLabel(f.last7Days.minutes)}`)
  ];
  if (f.latest) {
    const when = dayKeyLabel(f.latest.dayKey, sheet.todayKey);
    const mins = f.latest.minutes != null ? ` · ${minutesLabel(f.latest.minutes)}` : '';
    parts.push(statLine('Most recent', `${escapeHtml(f.latest.title)}${mins} (${when})`));
  }
  return section('Time & Focus', parts.join(''), sheet.coverage.focus);
}

function timeBlock(sheet) {
  const t = sheet.time;
  if (t.status !== 'data') return ''; // activity_logged is not live — folded into coverage footer only
  const parts = [
    statLine('Logged today', `${countLabel(t.today.sessions, 'entry', 'entries')} · ${minutesLabel(t.today.minutes)}`),
    statLine('Last 7 days', `${countLabel(t.last7Days.sessions, 'entry', 'entries')} · ${minutesLabel(t.last7Days.minutes)}`)
  ];
  return section('Logged Activity', parts.join(''), sheet.coverage.time);
}

function learningBlock(sheet) {
  const l = sheet.learning;
  const parts = [];
  if (l.status === 'no-plans') {
    parts.push(noteLine('No learning plan yet.'));
  } else if (l.activePlan) {
    const p = l.activePlan;
    parts.push(statLine('Current plan', p.title));
    if (p.hasSteps) {
      parts.push(
        `<div class="lcs-progress-row">`
        + `<progress class="lcs-progress" value="${p.completedSteps}" max="${p.totalSteps}"></progress>`
        + `<span class="lcs-progress-label">${p.completedSteps} / ${p.totalSteps} steps</span>`
        + `</div>`
      );
      if (p.isComplete) {
        parts.push(noteLine('All steps in this plan are complete.'));
      } else if (p.nextStep) {
        const context = [p.nextStep.lessonTitle, p.nextStep.phaseTitle].filter(Boolean).map(escapeHtml).join(' · ');
        parts.push(statLine('Next unfinished step', p.nextStep.stepTitle + (context ? ` (${context})` : '')));
      }
    } else {
      parts.push(noteLine('This plan has no steps yet.'));
    }
    if (l.planCount > 1) parts.push(noteLine(`${l.planCount - 1} other ${l.planCount - 1 === 1 ? 'plan' : 'plans'} not shown.`));
  }
  if (l.latestCompletedStep && l.latestCompletedStep.stepLabel) {
    const when = dayKeyLabel(l.latestCompletedStep.dayKey, sheet.todayKey);
    const plan = l.latestCompletedStep.planTitle ? ` · ${escapeHtml(l.latestCompletedStep.planTitle)}` : '';
    parts.push(statLine('Last step completed', `${escapeHtml(l.latestCompletedStep.stepLabel)}${plan} (${when})`));
  }
  parts.push(statLine('Steps completed in last 7 days', String(l.recentCompletions7d)));
  return section('Learning', parts.join(''), sheet.coverage.learning);
}

const CAPABILITY_FOOTNOTE = '<p class="lcs-coverage" data-state="active">Entered in Career — not derived from activity.</p>';

function capabilityBlock(sheet) {
  const c = sheet.capability;
  if (c.status === 'no-data') {
    return section('Capability & Career', noteLine('No capability or career data entered yet.'));
  }
  if (c.status === 'unreadable') {
    return section('Capability & Career', noteLine('Capability profile could not be read.'));
  }
  const parts = [];
  parts.push(statLine('Career target', c.careerTarget ? c.careerTarget.title
    : (c.activeCareerTargetCount ? `${c.activeCareerTargetCount} active` : 'None set')));
  parts.push(statLine('Tracked capabilities', String(c.trackedSkillCount)));
  const d = c.dimensionEvidence;
  parts.push(
    `<div class="lcs-dims">`
    + ['knowledge', 'practice', 'execution', 'shipping', 'portfolio'].map(dim =>
      `<span class="lcs-dim"><span class="lcs-dim-label">${dim[0].toUpperCase()}${dim.slice(1)}</span>`
      + `<span class="lcs-dim-count">${d[dim] || 0}</span></span>`).join('')
    + `</div>`
  );
  parts.push(statLine('Evidence records', String(c.totalEvidence)));
  parts.push(statLine('Active projects', String(c.trackedProjectCount)));
  parts.push(statLine('Portfolio artifacts', String(c.portfolioArtifactCount)));
  parts.push(CAPABILITY_FOOTNOTE);
  return section('Capability & Career', parts.join(''));
}

function workoutBlock(sheet) {
  const w = sheet.workout;
  if (w.status !== 'data') {
    return section('Workout', noteLine('No Workout data in the Life Ledger yet.'), sheet.coverage.workout);
  }
  const parts = [
    statLine('Last 7 days', countLabel(w.last7Days.count, 'workout')),
    statLine('Total recorded', countLabel(w.allTime.count, 'workout'))
  ];
  if (w.latest) {
    parts.push(statLine('Most recent', `${escapeHtml(w.latest.workoutName)} (${dayKeyLabel(w.latest.dayKey, sheet.todayKey)})`));
  }
  if (w.duration.workoutsWithKnownDuration > 0) {
    const scope = w.duration.workoutsWithKnownDuration === w.duration.workoutsTotal
      ? ''
      : ` (${w.duration.workoutsWithKnownDuration} of ${w.duration.workoutsTotal} with known duration)`;
    parts.push(statLine('Known duration total', `${minutesLabel(w.duration.knownDurationMinutes)}${scope}`));
  }
  return section('Workout', parts.join(''), sheet.coverage.workout);
}

function mealBlock(sheet) {
  const m = sheet.meal;
  if (m.status !== 'data') {
    return section('Meals', noteLine('No Meal data in the Life Ledger yet.'), sheet.coverage.meal);
  }
  const parts = [
    statLine('Prepared (last 7 days)', countLabel(m.last7Days.prepared, 'meal')),
    statLine('Portions eaten (last 7 days)', `${m.last7Days.consumed} logged · ${m.last7Days.portionsConsumed} ${m.last7Days.portionsConsumed === 1 ? 'portion' : 'portions'}`)
  ];
  if (m.latestPrepared) {
    parts.push(statLine('Last prepared', `${escapeHtml(m.latestPrepared.mealName)} (${escapeHtml(m.latestPrepared.preparedDate)})`));
  }
  if (m.latestConsumed) {
    parts.push(statLine('Last eaten', `${escapeHtml(m.latestConsumed.mealName)} (${dayKeyLabel(m.latestConsumed.dayKey, sheet.todayKey)})`));
  }
  return section('Meals', parts.join(''), sheet.coverage.meal);
}

function render() {
  const root = mount();
  if (!root) return;

  const { ledgerEvents, learningPlans, capabilityProfile, notes } = loadInputs();
  let sheet;
  try {
    sheet = buildLifeCharacterSheet({
      ledgerEvents,
      learningPlans,
      capabilityProfile,
      now: new Date(),
      referenceTimeZone: referenceTimeZone()
    });
  } catch (err) {
    root.innerHTML = `<p class="lcs-error" role="alert">Could not build the character sheet: ${escapeHtml(err && err.message ? err.message : 'unknown error')}</p>`;
    return;
  }

  const parts = [
    `<p class="lcs-generated">Current state · ${escapeHtml(sheet.todayKey)} · ${escapeHtml(sheet.referenceTimeZone)}</p>`,
    notes.map(noteLine).join(''),
    focusBlock(sheet),
    timeBlock(sheet),
    learningBlock(sheet),
    capabilityBlock(sheet),
    workoutBlock(sheet),
    mealBlock(sheet)
  ];
  if (sheet.skippedLedgerEvents) {
    parts.push(`<p class="lcs-note">${sheet.skippedLedgerEvents} Ledger `
      + `${sheet.skippedLedgerEvents === 1 ? 'event' : 'events'} could not be read for this snapshot.</p>`);
  }
  root.innerHTML = parts.filter(Boolean).join('');
}

// ── Life view sub-navigation (Character Sheet ↔ Timeline) ─────────────────────────────────
function showLifeSubview(view) {
  const wantSheet = view !== 'timeline';
  const sheetRoot = document.getElementById('life-character-sheet-root');
  const feedRoot = document.getElementById('life-feed-root');
  const sheetBtn = document.getElementById('life-subnav-sheet');
  const timelineBtn = document.getElementById('life-subnav-timeline');
  const subtitle = document.getElementById('life-view-subtitle');
  if (sheetRoot) sheetRoot.hidden = !wantSheet;
  if (feedRoot) feedRoot.hidden = wantSheet;
  if (sheetBtn) {
    sheetBtn.classList.toggle('active', wantSheet);
    sheetBtn.setAttribute('aria-pressed', String(wantSheet));
  }
  if (timelineBtn) {
    timelineBtn.classList.toggle('active', !wantSheet);
    timelineBtn.setAttribute('aria-pressed', String(!wantSheet));
  }
  if (subtitle) {
    subtitle.textContent = wantSheet
      ? 'A factual snapshot of where things stand right now. Facts only — no scores or advice.'
      : 'Your timeline from the Life Ledger. Learning steps and focus sessions appear now; time, workouts and meals join as their integrations are connected.';
  }
  try {
    globalThis.localStorage?.setItem('ta3-life-subview', wantSheet ? 'sheet' : 'timeline');
  } catch {
    // preference persistence is best-effort only
  }
  if (wantSheet) {
    render();
  } else if (typeof window.renderLifeFeed === 'function') {
    window.renderLifeFeed();
  }
}

function initialSubview() {
  try {
    return globalThis.localStorage?.getItem('ta3-life-subview') === 'timeline' ? 'timeline' : 'sheet';
  } catch {
    return 'sheet';
  }
}

function onSubnavClick(event) {
  const btn = event.target.closest('[data-life-view]');
  if (!btn) return;
  showLifeSubview(btn.getAttribute('data-life-view'));
}

function init() {
  if (initialized) return;
  initialized = true;
  const subnav = document.querySelector('#view-life .life-subnav');
  if (subnav) subnav.addEventListener('click', onSubnavClick);
}

// Entry point called by showView('life').
export function renderLifeView() {
  init();
  showLifeSubview(initialSubview());
}

if (typeof window !== 'undefined') {
  window.renderLifeView = renderLifeView;
  window.renderLifeCharacterSheet = render;
  init();
}
