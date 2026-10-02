// brain-dump-ui.js
//
// Browser capture/triage/promotion UI for Brain Dump + Eisenhower V1. Mounted into
// the "Brain Dump" nav view (index.html's `#bd-root`, wired by showView('braindump')).
//
// Capture first, triage later: the add form collects text ONLY (no time, date,
// duration, category, priority or Eisenhower answers) — see brain-dump-model.js's
// file banner for why. Triage asks exactly two yes/no questions. Promotion always
// goes through Plan Authority (brain-dump-promotion.js), never around it.
//
// Side-effect import: guarantees window.PlanAuthority exists before this module's
// own top-level code runs, independent of <script> tag order — the same reasoning
// planning-continuity-ui.js already documents for its own import of this file.
import './plan-authority.js';
import { createBrainDumpRepository } from './brain-dump-repository.js';
import { untriagedCaptures, triagedCaptures, disposedCaptures, quadrantOf } from './brain-dump-model.js';
import { promoteCaptureToPlan } from './brain-dump-promotion.js';
import { localPlanDate } from './plan-tomorrow-model.js';

function repository() {
  return window.BrainDumpRepository || (window.BrainDumpRepository = createBrainDumpRepository());
}

function deviceId() {
  return globalThis.syncedDeviceId || 'unknown-device';
}

function notify(msg) {
  if (typeof window.showToast === 'function') window.showToast(msg);
}

function resolveAccountingTimezone() {
  const hint = (window.settings && window.settings.timezone) ||
    (globalThis.localStorage && globalThis.localStorage.getItem('ta3-tz')) || '';
  if (hint) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: hint }); return hint; } catch { /* fall through */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const QUADRANT_LABEL = {
  'do-first': 'Do first — important & urgent',
  schedule: 'Schedule — important, not urgent',
  'delegate-candidate': 'Delegate candidate — urgent, not important',
  'archive-candidate': 'Archive candidate — neither',
};

// In-memory only (per browser tab): which Important/Urgent buttons are currently
// pressed for an untriaged item THIS SESSION, before "Save classification" commits
// them. Keyed by capture id, so it survives a re-render (e.g. a remote sync update
// arriving mid-triage) without losing the owner's in-progress answer.
const pendingTriage = new Map();

// Which triaged item currently has its inline Schedule form expanded. At most one
// at a time, to keep the list readable — not a product requirement, purely a
// rendering simplification.
let openScheduleId = null;

function pendingFor(id) {
  if (!pendingTriage.has(id)) pendingTriage.set(id, { important: null, urgent: null });
  return pendingTriage.get(id);
}

function captureFormHtml() {
  return `
    <div class="page-header">
      <div class="page-title">Brain Dump</div>
    </div>
    <form id="bd-capture-form" class="bd-capture-form" style="display:flex;gap:8px;margin-bottom:18px">
      <input type="text" id="bd-capture-text" placeholder="What do I need to remember/do?" maxlength="1000" autocomplete="off" style="flex:1" />
      <button type="submit" class="btn primary">Add</button>
    </form>`;
}

function triageControlsHtml(id) {
  const pending = pendingFor(id);
  const btn = (field, value, label) => {
    const active = pending[field] === value;
    return `<button type="button" class="btn sm ${active ? 'primary' : 'ghost'}" onclick="window.BrainDumpUI.setTriageAnswer('${id}','${field}',${value})">${label}</button>`;
  };
  const ready = pending.important !== null && pending.urgent !== null;
  return `
    <div class="bd-triage-row" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px">
      <span style="font-size:12px;opacity:.7">Important?</span>
      ${btn('important', true, 'Yes')}${btn('important', false, 'No')}
      <span style="font-size:12px;opacity:.7;margin-left:10px">Urgent?</span>
      ${btn('urgent', true, 'Yes')}${btn('urgent', false, 'No')}
      <button type="button" class="btn sm ${ready ? 'primary' : 'ghost'}" ${ready ? '' : 'disabled'} style="margin-left:10px" onclick="window.BrainDumpUI.saveTriage('${id}')">Save classification</button>
    </div>`;
}

function untriagedSectionHtml(items) {
  if (!items.length) return '';
  const rows = items.map(item => `
    <div class="bd-item" style="padding:10px 0;border-bottom:1px solid var(--border,#2a2a2a)">
      <div>${escapeHtml(item.text)}</div>
      ${triageControlsHtml(item.id)}
    </div>`).join('');
  return `
    <div class="page-header" style="margin-top:8px"><div class="page-title">To triage (${items.length})</div></div>
    <div class="bd-list">${rows}</div>`;
}

function scheduleFormHtml(id) {
  const tz = resolveAccountingTimezone();
  const today = localPlanDate(Date.now(), tz);
  return `
    <div class="bd-schedule-form" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px">
      <input type="date" id="bd-sched-date-${id}" value="${today}" min="${today}" />
      <input type="time" id="bd-sched-time-${id}" placeholder="Optional time" />
      <input type="number" id="bd-sched-duration-${id}" placeholder="Minutes" min="1" max="720" style="width:90px" />
      <button type="button" class="btn sm primary" onclick="window.BrainDumpUI.confirmSchedule('${id}')">Confirm</button>
      <button type="button" class="btn sm ghost" onclick="window.BrainDumpUI.toggleSchedule('${id}')">Cancel</button>
    </div>`;
}

function triagedSectionHtml(items) {
  if (!items.length) return '';
  const rows = items.map(item => {
    const quadrant = quadrantOf(item);
    return `
    <div class="bd-item" style="padding:10px 0;border-bottom:1px solid var(--border,#2a2a2a)">
      <div>${escapeHtml(item.text)}</div>
      <div style="font-size:12px;opacity:.7;margin-top:2px">${QUADRANT_LABEL[quadrant] || ''}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
        <button type="button" class="btn sm" onclick="window.BrainDumpUI.doToday('${item.id}')">Do today</button>
        <button type="button" class="btn sm" onclick="window.BrainDumpUI.toggleSchedule('${item.id}')">Schedule</button>
        <button type="button" class="btn sm ghost" onclick="window.BrainDumpUI.archive('${item.id}')">Archive</button>
        <button type="button" class="btn sm ghost" onclick="window.BrainDumpUI.delegate('${item.id}')">Delegate</button>
      </div>
      ${openScheduleId === item.id ? scheduleFormHtml(item.id) : ''}
    </div>`;
  }).join('');
  return `
    <div class="page-header" style="margin-top:8px"><div class="page-title">Triaged (${items.length})</div></div>
    <div class="bd-list">${rows}</div>`;
}

function dispositionLabel(item) {
  if (item.status === 'promoted') return item.promotion?.type === 'do-today' ? 'Done today' : 'Scheduled';
  if (item.status === 'archived') return 'Archived';
  if (item.status === 'delegated') return item.delegatedTo ? `Delegated — ${escapeHtml(item.delegatedTo)}` : 'Delegated';
  return '';
}

function disposedSectionHtml(items) {
  if (!items.length) return '';
  const recent = items.slice(0, 20);
  const rows = recent.map(item => `
    <div class="bd-item" style="padding:8px 0;border-bottom:1px solid var(--border,#2a2a2a);opacity:.7">
      <div>${escapeHtml(item.text)}</div>
      <div style="font-size:12px">${dispositionLabel(item)}</div>
    </div>`).join('');
  return `
    <div class="page-header" style="margin-top:8px"><div class="page-title">Recently handled</div></div>
    <div class="bd-list">${rows}</div>`;
}

export function render() {
  const root = document.getElementById('bd-root');
  if (!root) return;
  const all = repository().listAllRaw();
  const untriaged = untriagedCaptures(all);
  const triaged = triagedCaptures(all);
  // Most-recently-disposed first for the "Recently handled" strip — createdAt
  // order is the canonical order everywhere else; this one view alone reverses it
  // for display, over an already-deterministic list.
  const disposed = disposedCaptures(all).slice().reverse();
  root.innerHTML = captureFormHtml() + untriagedSectionHtml(untriaged) + triagedSectionHtml(triaged) + disposedSectionHtml(disposed);
  const form = document.getElementById('bd-capture-form');
  if (form) form.addEventListener('submit', e => { e.preventDefault(); submitCapture(); });
}

function submitCapture() {
  const input = document.getElementById('bd-capture-text');
  const text = input ? input.value : '';
  const result = repository().create({ text, now: Date.now(), updatedBy: deviceId() });
  if (!result.ok) {
    if (input) input.focus();
    return;
  }
  if (window.BrainDumpSync) window.BrainDumpSync.syncCapture(result.record.id);
  render();
  const freshInput = document.getElementById('bd-capture-text');
  if (freshInput) freshInput.focus();
}

function setTriageAnswer(id, field, value) {
  const pending = pendingFor(id);
  pending[field] = value;
  render();
  // Re-focus nothing in particular: triage is button-driven, not keyboard-driven.
}

function saveTriage(id) {
  const pending = pendingFor(id);
  if (pending.important === null || pending.urgent === null) return;
  const result = repository().triage(id, { important: pending.important, urgent: pending.urgent, now: Date.now(), updatedBy: deviceId() });
  if (!result.ok) { notify('Could not save that classification.'); return; }
  pendingTriage.delete(id);
  if (window.BrainDumpSync) window.BrainDumpSync.syncCapture(id);
  render();
}

/** Thin wrapper so brain-dump-promotion.js never needs to know about `window` —
 *  it only ever sees a function. If the sync bridge has not loaded yet (or
 *  never will — module load order edge case), report 'offline' rather than
 *  throwing: no fake success, fully retryable once it has. */
function claimPromotionRemote(id, promotion) {
  if (!window.BrainDumpSync) return Promise.resolve({ ok: false, reason: 'offline' });
  return window.BrainDumpSync.claimPromotionRemote(id, promotion);
}

function reportPromotionOutcome(result, successLabel) {
  // Phase 3 (finalize) is local-first — push it so other devices see the
  // completed promotion as soon as possible. The claim itself (phase 1) is
  // already authoritative-remote by the time this runs; this is a no-op merge
  // when nothing local has changed since.
  if (result.record && window.BrainDumpSync) window.BrainDumpSync.syncCapture(result.record.id);
  if (result.ok) {
    notify(result.alreadyDisposed ? 'Already handled.' : successLabel);
    render();
    return;
  }
  const messages = {
    'no-authoritative-day': 'Plans are still syncing — try again in a moment.',
    ambiguous: 'That local time happens twice (clock change) — pick a different time.',
    nonexistent: 'That local time does not exist (clock change) — pick a different time.',
    'invalid-date': 'Pick a valid date.',
    'already-claimed': 'Already being promoted elsewhere — try again in a moment.',
    'already-disposed': 'Already handled.',
    offline: 'Could not confirm with the server — check your connection and try again.',
  };
  notify(messages[result.reason] || result.reason || 'Could not promote that item.');
  render();
}

async function doToday(id) {
  const result = await promoteCaptureToPlan({
    repository: repository(),
    planAuthority: window.PlanAuthority,
    claimPromotionRemote,
    id,
    type: 'do-today',
    now: Date.now(),
    deviceId: deviceId(),
  });
  reportPromotionOutcome(result, 'Added to today.');
}

function toggleSchedule(id) {
  openScheduleId = openScheduleId === id ? null : id;
  render();
}

async function confirmSchedule(id) {
  const dateInput = document.getElementById(`bd-sched-date-${id}`);
  const timeInput = document.getElementById(`bd-sched-time-${id}`);
  const durationInput = document.getElementById(`bd-sched-duration-${id}`);
  const dateKey = dateInput ? dateInput.value : '';
  if (!dateKey) { notify('Pick a date first.'); return; }
  const when = timeInput && timeInput.value ? timeInput.value : '';
  const durationMinutes = durationInput && durationInput.value ? Number(durationInput.value) : undefined;
  const result = await promoteCaptureToPlan({
    repository: repository(),
    planAuthority: window.PlanAuthority,
    claimPromotionRemote,
    id,
    type: 'schedule',
    dateKey,
    when,
    durationMinutes,
    now: Date.now(),
    deviceId: deviceId(),
  });
  if (result.ok) openScheduleId = null;
  reportPromotionOutcome(result, 'Scheduled.');
}

function archive(id) {
  const result = repository().archive(id, { now: Date.now(), updatedBy: deviceId() });
  if (!result.ok && result.reason === 'promotion-claimed') { notify('Already being promoted — cannot archive.'); render(); return; }
  if (!result.ok && result.reason !== 'already-disposed') { notify('Could not archive that item.'); return; }
  if (window.BrainDumpSync) window.BrainDumpSync.syncCapture(id);
  render();
}

function delegate(id) {
  const delegatedTo = typeof window.prompt === 'function' ? window.prompt('Delegated to (optional):', '') : null;
  const result = repository().delegate(id, { delegatedTo, now: Date.now(), updatedBy: deviceId() });
  if (!result.ok && result.reason === 'promotion-claimed') { notify('Already being promoted — cannot delegate.'); render(); return; }
  if (!result.ok && result.reason !== 'already-disposed') { notify('Could not delegate that item.'); return; }
  if (window.BrainDumpSync) window.BrainDumpSync.syncCapture(id);
  render();
}

if (typeof window !== 'undefined') {
  window.BrainDumpUI = { render, setTriageAnswer, saveTriage, doToday, toggleSchedule, confirmSchedule, archive, delegate };
  // A different account's cache becoming active (sign-in/out, a direct switch) must
  // re-render so nothing drawn from the previous account's captures lingers — the
  // same reasoning commitments-sync.js documents for refreshCommitmentSurfaces.
  globalThis.refreshBrainDumpSurfaces = () => {
    if (document.getElementById('view-braindump')?.classList.contains('active')) render();
  };
}
