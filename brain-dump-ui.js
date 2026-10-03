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
import { promoteCaptureToPlan, reconcilePromotionClaim } from './brain-dump-promotion.js';
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

// FIX FIRST round 3. A capture id lands here while a promotion attempt's
// outcome is genuinely UNKNOWN (claimPromotionRemote returned 'pending') —
// never while it merely failed. While present: the triaged row shows a neutral
// "Still confirming…" state instead of Do Today/Schedule/Archive/Delegate, so
// the owner cannot launch a second, INCOMPATIBLE promotion attempt from the
// same local UI state before the first's authority is known (see
// brain-dump-sync.js's file banner). Cleared the instant fresh authoritative
// info arrives for that id (success, a different terminal state, or a
// definitive failure) — never by a timer, never by guessing.
const pendingPromotionIds = new Set();

// In-flight guard so a burst of remote-change notifications for the same
// capture (the claim's own late settlement AND the whole-subtree listener
// AND a reconnect replay can all fire close together) never runs
// reconcilePromotionClaim more than once concurrently for one id. Persisted
// truth stays the claim itself — this is purely a local dedupe, never
// authoritative.
const reconciling = new Set();

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
    // A promotion attempt with a genuinely UNKNOWN outcome: Do Today/Schedule
    // are withheld here — never launch a SECOND, possibly-incompatible
    // promotion attempt before the first's authority is known (requirement
    // 5). Archive/Delegate stay available on purpose: the authoritative
    // remote ordering (never which local toast appeared first) is what
    // decides that race, and a user is allowed to try (see
    // brain-dump-sync.js's file banner, "Archive wins before the late
        // transaction runs").
    const pending = pendingPromotionIds.has(item.id);
    return `
    <div class="bd-item" style="padding:10px 0;border-bottom:1px solid var(--border,#2a2a2a)">
      <div>${escapeHtml(item.text)}</div>
      <div style="font-size:12px;opacity:.7;margin-top:2px">${pending ? 'Still confirming a previous action…' : (QUADRANT_LABEL[quadrant] || '')}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
        ${pending ? '' : `
        <button type="button" class="btn sm" onclick="window.BrainDumpUI.doToday('${item.id}')">Do today</button>
        <button type="button" class="btn sm" onclick="window.BrainDumpUI.toggleSchedule('${item.id}')">Schedule</button>`}
        <button type="button" class="btn sm ghost" onclick="window.BrainDumpUI.archive('${item.id}')">Archive</button>
        <button type="button" class="btn sm ghost" onclick="window.BrainDumpUI.delegate('${item.id}')">Delegate</button>
      </div>
      ${!pending && openScheduleId === item.id ? scheduleFormHtml(item.id) : ''}
    </div>`;
  }).join('');
  return `
    <div class="page-header" style="margin-top:8px"><div class="page-title">Triaged (${items.length})</div></div>
    <div class="bd-list">${rows}</div>`;
}

function formatDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || '')) return '';
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Where a promoted capture landed, read back from Plan Authority (the plan
 *  item is the authority, not this capture): its day and, if timed, its time.
 *  Read-only; any failure just means less detail is shown. */
function promotionDestination(item) {
  const pa = window.PlanAuthority;
  if (!item.promotion || !pa || typeof pa.targetById !== 'function') return { dateKey: '', when: '' };
  try {
    const target = pa.targetById(item.promotion.targetId);
    if (!target) return { dateKey: '', when: '' };
    const planItem = typeof pa.rawItems === 'function' ? pa.rawItems(target).find(i => i.id === item.promotion.planItemId) : null;
    return { dateKey: target.dateKey || '', when: planItem?.when || '' };
  } catch {
    return { dateKey: '', when: '' };
  }
}

function dispositionLabel(item) {
  if (item.status === 'promoted') {
    const { dateKey, when } = promotionDestination(item);
    const day = formatDateKey(dateKey);
    let label = item.promotion?.type === 'do-today' ? 'Added to plan' : 'Scheduled';
    if (day) label += ` · ${day}`;
    if (when) label += ` at ${escapeHtml(when)}`;
    return label;
  }
  if (item.status === 'archived') return 'Archived';
  if (item.status === 'delegated') return item.delegatedTo ? `Delegated — ${escapeHtml(item.delegatedTo)}` : 'Delegated';
  return '';
}

// Which handled (archived/delegated) item currently has its inline edit form
// open. At most one at a time, same simplification as openScheduleId.
let editingHandledId = null;

function handledEditFormHtml(item) {
  const delegated = item.status === 'delegated';
  return `
    <div class="bd-edit-form" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px">
      <input type="text" id="bd-edit-text-${item.id}" value="${escapeHtml(item.text)}" maxlength="1000" style="flex:1;min-width:160px" />
      ${delegated ? `<input type="text" id="bd-edit-delegated-${item.id}" value="${escapeHtml(item.delegatedTo || '')}" placeholder="Delegated to" maxlength="200" style="width:140px" />` : ''}
      <button type="button" class="btn sm primary" onclick="window.BrainDumpUI.saveHandledEdit('${item.id}')">Save</button>
      <button type="button" class="btn sm ghost" onclick="window.BrainDumpUI.toggleHandledEdit('${item.id}')">Cancel</button>
    </div>`;
}

function handledActionsHtml(item) {
  if (item.status === 'promoted') {
    // No Reopen/Edit here: the plan item is live and is the thing to edit.
    const { dateKey } = promotionDestination(item);
    if (!dateKey || typeof globalThis.jumpTimelineToDate !== 'function') return '';
    return `<button type="button" class="btn sm ghost" onclick="window.BrainDumpUI.openInPlan('${item.id}')">Open in plan</button>`;
  }
  if (editingHandledId === item.id) return '';
  return `
    <button type="button" class="btn sm ghost" onclick="window.BrainDumpUI.toggleHandledEdit('${item.id}')">Edit</button>
    <button type="button" class="btn sm ghost" onclick="window.BrainDumpUI.reopen('${item.id}')">Reopen</button>`;
}

function disposedSectionHtml(items) {
  if (!items.length) return '';
  const recent = items.slice(0, 20);
  const rows = recent.map(item => `
    <div class="bd-item" data-bd-handled="${item.id}" style="padding:8px 0;border-bottom:1px solid var(--border,#2a2a2a)">
      <div style="opacity:.8">${escapeHtml(item.text)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:2px">
        <span style="font-size:12px;opacity:.7">${dispositionLabel(item)}</span>
        ${handledActionsHtml(item)}
      </div>
      ${editingHandledId === item.id && item.status !== 'promoted' ? handledEditFormHtml(item) : ''}
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

function alreadyHandledMessage(record) {
  if (record?.status === 'promoted') return 'Already added to your plan.';
  if (record?.status === 'archived') return 'This item was already archived.';
  if (record?.status === 'delegated') return 'This item was already delegated.';
  return 'Already handled.';
}

function reportPromotionOutcome(result, successLabel, id) {
  if (result.reason === 'pending') {
    // Outcome genuinely UNKNOWN — never shown as success or failure. Nothing
    // local changed (brain-dump-sync.js wrote nothing for a pending attempt),
    // so there is nothing to push here; the eventual late settlement pushes
    // and merges itself, and that merge's own onRemoteChange is what clears
    // this and resolves the UI — see maybeReconcile.
    pendingPromotionIds.add(id);
    notify('Still confirming…');
    render();
    return;
  }
  pendingPromotionIds.delete(id);
  // Phase 3 (finalize) is local-first — push it so other devices see the
  // completed promotion as soon as possible. The claim itself (phase 1) is
  // already authoritative-remote by the time this runs; this is a no-op merge
  // when nothing local has changed since.
  if (result.record && window.BrainDumpSync) window.BrainDumpSync.syncCapture(result.record.id);
  if (result.ok) {
    notify(result.alreadyDisposed ? alreadyHandledMessage(result.record) : successLabel);
    render();
    return;
  }
  if (result.reason === 'already-disposed') { notify(alreadyHandledMessage(result.record)); render(); return; }
  const messages = {
    'no-authoritative-day': 'Plans are still syncing — try again in a moment.',
    ambiguous: 'That local time happens twice (clock change) — pick a different time.',
    nonexistent: 'That local time does not exist (clock change) — pick a different time.',
    'invalid-date': 'Pick a valid date.',
    // Only reached for a genuinely different claim (another device or tab chose
    // a different destination first). Our own claim, even if the reconciler
    // finished it, is reported as success instead.
    'already-claimed': 'This item is already being added to your plan on another device.',
    offline: 'Could not confirm with the server — check your connection and try again.',
  };
  notify(messages[result.reason] || result.reason || 'Could not promote that item.');
  render();
}

async function doToday(id) {
  if (pendingPromotionIds.has(id)) return; // avoid a second, possibly-incompatible attempt while the first's outcome is unknown
  const result = await promoteCaptureToPlan({
    repository: repository(),
    planAuthority: window.PlanAuthority,
    claimPromotionRemote,
    id,
    type: 'do-today',
    now: Date.now(),
    deviceId: deviceId(),
  });
  reportPromotionOutcome(result, 'Added to today\'s plan.', id);
}

function toggleSchedule(id) {
  openScheduleId = openScheduleId === id ? null : id;
  render();
}

async function confirmSchedule(id) {
  if (pendingPromotionIds.has(id)) return;
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
  reportPromotionOutcome(result, 'Added to your plan.', id);
}

/** FIX FIRST round 3 — the abandoned-claim fix's UI-side trigger. Called from
 *  globalThis.refreshBrainDumpSurfaces (itself the sync bridge's onRemoteChange
 *  hook — see brain-dump-sync.js), so this runs whenever ANY merge changes this
 *  capture's local record: the claim's own late settlement, the ordinary
 *  whole-subtree listener, a reconnect replay, or a fresh hydration on load —
 *  all four of round 3's required triggers, through the one existing hook.
 *  Idempotent and safe to call redundantly — reconcilePromotionClaim's own
 *  guards (status/claim checks, the deterministic plan-item id) make a
 *  redundant call a no-op; `reconciling` only prevents two concurrent calls
 *  for the same id from racing each other pointlessly. */
function maybeReconcile(id, record) {
  if (!id || !record) return;
  pendingPromotionIds.delete(id); // fresh authoritative info has arrived either way
  if ((record.status !== 'untriaged' && record.status !== 'triaged') || !record.promotionClaim) return;
  if (reconciling.has(id)) return;
  reconciling.add(id);
  try {
    const outcome = reconcilePromotionClaim({ repository: repository(), planAuthority: window.PlanAuthority, id, now: Date.now(), deviceId: deviceId() });
    if (outcome?.record && window.BrainDumpSync) window.BrainDumpSync.syncCapture(outcome.record.id);
  } finally {
    reconciling.delete(id);
  }
  // The caller (refreshBrainDumpSurfaces) re-renders the Brain Dump view itself
  // if it is the active one; reconciliation still runs here regardless of
  // which view is on screen.
}

function archive(id) {
  const result = repository().archive(id, { now: Date.now(), updatedBy: deviceId() });
  if (!result.ok && result.reason === 'promotion-claimed') { notify('This item is being added to your plan, so it can\'t be archived.'); render(); return; }
  if (!result.ok && result.reason !== 'already-disposed') { notify('Could not archive that item.'); return; }
  if (window.BrainDumpSync) window.BrainDumpSync.syncCapture(id);
  render();
}

function delegate(id) {
  const delegatedTo = typeof window.prompt === 'function' ? window.prompt('Delegated to (optional):', '') : null;
  const result = repository().delegate(id, { delegatedTo, now: Date.now(), updatedBy: deviceId() });
  if (!result.ok && result.reason === 'promotion-claimed') { notify('This item is being added to your plan, so it can\'t be delegated.'); render(); return; }
  if (!result.ok && result.reason !== 'already-disposed') { notify('Could not delegate that item.'); return; }
  if (window.BrainDumpSync) window.BrainDumpSync.syncCapture(id);
  render();
}

function toggleHandledEdit(id) {
  editingHandledId = editingHandledId === id ? null : id;
  render();
}

function saveHandledEdit(id) {
  const textInput = document.getElementById(`bd-edit-text-${id}`);
  const delegatedInput = document.getElementById(`bd-edit-delegated-${id}`);
  const patch = { text: textInput ? textInput.value : undefined, now: Date.now(), updatedBy: deviceId() };
  if (delegatedInput) patch.delegatedTo = delegatedInput.value;
  const result = repository().editHandled(id, patch);
  if (!result.ok) {
    notify(result.field === 'text' ? 'The text can\'t be empty.' : result.reason === 'promoted' ? 'Edit this item in your plan instead.' : 'Could not save that change.');
    render();
    return;
  }
  editingHandledId = null;
  if (!result.unchanged && window.BrainDumpSync) window.BrainDumpSync.syncCapture(id);
  if (!result.unchanged) notify('Saved.');
  render();
}

async function reopen(id) {
  const result = repository().reopen(id, { now: Date.now(), updatedBy: deviceId() });
  if (!result.ok) {
    notify(result.reason === 'promoted' ? 'Already added to your plan.' : 'Could not reopen that item.');
    render();
    return;
  }
  if (editingHandledId === id) editingHandledId = null;
  render();
  // Optimistic like every other non-promotion write. If the remote record
  // already holds a promotion claim (or is promoted), that truth wins the merge
  // and the push brings it back here. Say so instead of claiming the reopen
  // stuck.
  if (window.BrainDumpSync) await window.BrainDumpSync.syncCapture(id);
  const after = repository().read(id);
  if (after && (after.status === 'promoted' || after.promotionClaim)) notify('This item was already added to your plan on another device.');
  else notify('Moved back to triage.');
  render();
}

function openInPlan(id) {
  const item = repository().read(id);
  const { dateKey } = item ? promotionDestination(item) : { dateKey: '' };
  if (!dateKey || typeof globalThis.jumpTimelineToDate !== 'function' || typeof globalThis.showView !== 'function') return;
  globalThis.showView('today');
  globalThis.jumpTimelineToDate(dateKey);
}

if (typeof window !== 'undefined') {
  window.BrainDumpUI = { render, setTriageAnswer, saveTriage, doToday, toggleSchedule, confirmSchedule, archive, delegate, toggleHandledEdit, saveHandledEdit, reopen, openInPlan };
  // A different account's cache becoming active (sign-in/out, a direct switch) must
  // re-render so nothing drawn from the previous account's captures lingers — the
  // same reasoning commitments-sync.js documents for refreshCommitmentSurfaces.
  // `id`/`record`, when present, are brain-dump-sync.js's onRemoteChange payload
  // (a merge actually changed something for that capture) — the trigger for
  // reconcilePromotionClaim (FIX FIRST round 3). Absent on a plain re-render
  // call (e.g. onRebind, which has no single capture in mind).
  globalThis.refreshBrainDumpSurfaces = (id, record) => {
    if (id) maybeReconcile(id, record);
    if (document.getElementById('view-braindump')?.classList.contains('active')) render();
  };
}
