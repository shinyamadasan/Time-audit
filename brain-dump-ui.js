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
import { untriagedCaptures, triagedCaptures, disposedCaptures, quadrantOf, normalizeCapture } from './brain-dump-model.js';
import { promoteCaptureToPlan, settleOutstandingClaim, promotionDestination } from './brain-dump-promotion.js';
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
// A foreground request can still be awaiting its result when a synchronous
// listener clears UNKNOWN state. Keep that shorter lifetime separately.
const inFlightPromotionIds = new Set();
const promotionPending = id => pendingPromotionIds.has(id) || inFlightPromotionIds.has(id);

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
      ${expiredClaimNote(item)}
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
    const pending = promotionPending(item.id);
    return `
    <div class="bd-item" style="padding:10px 0;border-bottom:1px solid var(--border,#2a2a2a)">
      <div>${escapeHtml(item.text)}</div>
      ${expiredClaimNote(item)}
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

/** A Personal Day has no calendar date of its own: describe it by when it
 *  starts, in its own zone, never by a guessed date. */
function formatPersonalDayStart(startMs, timezone) {
  if (!Number.isFinite(startMs)) return '';
  try {
    return new Date(startMs).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone || undefined });
  } catch {
    return '';
  }
}

function destinationOf(item) {
  return promotionDestination(window.PlanAuthority, item);
}

function dispositionLabel(item) {
  if (item.status === 'promoted') {
    const destination = destinationOf(item);
    let label = item.promotion?.type === 'do-today' ? 'Added to plan' : 'Scheduled';
    if (destination.kind === 'date') {
      const day = formatDateKey(destination.dateKey);
      if (day) label += ` · ${day}`;
    } else if (destination.kind === 'personal-day') {
      const start = formatPersonalDayStart(destination.startMs, destination.timezone);
      label += start ? ` · Personal day from ${start}` : ' · Personal day';
    }
    if (destination.when) label += ` at ${escapeHtml(destination.when)}`;
    // No "Open in plan" when navigation cannot prove it lands on this day.
    if (destination.kind === 'personal-day') label += ' (open it from My Day)';
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
    const { openDateKey } = destinationOf(item);
    if (!openDateKey || typeof globalThis.jumpTimelineToDate !== 'function') return '';
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
  // Every Brain Dump state change already ends in render(); refreshing the My Day
  // tray here keeps both surfaces showing the same pending/promoted truth.
  renderTray();
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
  if (result.reason === 'already-disposed') {
    // A promotion that already happened with DIFFERENT details (Do Today vs a
    // time, or another time) did not honor this request: never say it did.
    notify(result.record?.status === 'promoted'
      ? 'This item was already added to your plan with different details. Open it in your plan to change it.'
      : alreadyHandledMessage(result.record));
    render();
    return;
  }
  const messages = {
    'no-authoritative-day': 'Plans are still syncing — try again in a moment.',
    ambiguous: 'That local time happens twice (clock change) — pick a different time.',
    nonexistent: 'That local time does not exist (clock change) — pick a different time.',
    'invalid-date': 'Pick a valid date.',
    // Only reached for a genuinely different claim (another device or tab chose
    // a different destination first). Our own claim, even if the reconciler
    // finished it, is reported as success instead.
    'already-claimed': 'This item is already being added to your plan.',
    'source-changed': 'This capture changed or still has edits syncing. Review it, then try again.',
    offline: 'Could not confirm with the server — check your connection and try again.',
  };
  notify(messages[result.reason] || result.reason || 'Could not promote that item.');
  render();
}

async function promoteFromUi(id, options) {
  inFlightPromotionIds.add(id);
  try {
    render();
    return await promoteCaptureToPlan({ repository: repository(), planAuthority: window.PlanAuthority,
      claimPromotionRemote, id, now: Date.now(), deviceId: deviceId(), ...options });
  } finally {
    inFlightPromotionIds.delete(id);
    render();
  }
}

async function doToday(id) {
  if (promotionPending(id)) return;
  const result = await promoteFromUi(id, { type: 'do-today' });
  reportPromotionOutcome(result, 'Added to today\'s plan.', id);
}

function toggleSchedule(id) {
  if (promotionPending(id)) return;
  openScheduleId = openScheduleId === id ? null : id;
  render();
}

async function confirmSchedule(id) {
  if (promotionPending(id)) return;
  const dateInput = document.getElementById(`bd-sched-date-${id}`);
  const timeInput = document.getElementById(`bd-sched-time-${id}`);
  const durationInput = document.getElementById(`bd-sched-duration-${id}`);
  const dateKey = dateInput ? dateInput.value : '';
  if (!dateKey) { notify('Pick a date first.'); return; }
  const when = timeInput && timeInput.value ? timeInput.value : '';
  const durationMinutes = durationInput && durationInput.value ? Number(durationInput.value) : undefined;
  const result = await scheduleTo(id, { dateKey, when, durationMinutes });
  if (result.ok) openScheduleId = null;
  reportPromotionOutcome(result, 'Added to your plan.', id);
}

/** The Schedule promotion without any DOM: shared by the Brain Dump view's
 *  Schedule form and the My Day tray's Tomorrow button, so both surfaces go
 *  through one claim/create/finalize path. The caller reports the outcome. */
function scheduleTo(id, { dateKey, when = '', durationMinutes } = {}) {
  return promoteFromUi(id, {
    type: 'schedule',
    dateKey,
    when,
    durationMinutes,
  });
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
function maybeReconcile(id, record, { fromSweep = false } = {}) {
  if (!id || !record) return;
  if (!fromSweep) pendingPromotionIds.delete(id); // fresh authoritative info has arrived either way
  if ((record.status !== 'untriaged' && record.status !== 'triaged') || !record.promotionClaim) return;
  if (reconciling.has(id)) return;
  reconciling.add(id);
  // settleOutstandingClaim runs its synchronous part FIRST, so a claim whose day
  // is still open finishes inside this very listener callback. Only an ended
  // claim (revoke, then an authoritative destination read) waits on the remote.
  const sync = window.BrainDumpSync;
  settleOutstandingClaim({
    repository: repository(), planAuthority: window.PlanAuthority, id, now: Date.now(), deviceId: deviceId(),
    revokeClaim: sync ? sync.revokeClaimRemote : undefined,
    resolveExpiredClaim: sync ? sync.resolveExpiredClaimRemote : undefined,
  })
    .then(outcome => {
      if (outcome?.record && sync) sync.syncCapture(outcome.record.id);
      if (outcome?.recovered) announceRecovery(id, outcome.expiredClaim);
    })
    .catch(() => { /* left exactly as it was; a later change or load retries */ })
    .finally(() => { reconciling.delete(id); });
  // The caller (refreshBrainDumpSurfaces) re-renders the Brain Dump view itself
  // if it is the active one; reconciliation still runs here regardless of
  // which view is on screen.
}

/** A claim that expired since this device last looked would never produce a
 *  merge "change" on its own, so a (re)bind also sweeps every local capture that
 *  still holds a claim. Same idempotent path as a listener update. */
function settleAllOutstandingClaims() {
  let all;
  try { all = repository().listAllRaw(); } catch { return; }
  for (const [id, raw] of Object.entries(all)) {
    const record = normalizeCapture(raw);
    if (record?.promotionClaim) maybeReconcile(id, record, { fromSweep: true });
  }
}

/** The day an expired claim had aimed at, in plain words ('' when unknown). */
function expiredClaimDay(expiredClaim) {
  const destination = promotionDestination(window.PlanAuthority, { promotion: expiredClaim });
  if (destination.kind === 'date') return formatDateKey(destination.dateKey);
  if (destination.kind === 'personal-day') return formatPersonalDayStart(destination.startMs, destination.timezone);
  return '';
}

// Recoveries already announced in this tab: one toast per capture, never per render.
const announcedRecoveries = new Set();

function announceRecovery(id, expiredClaim) {
  if (announcedRecoveries.has(id)) return;
  announcedRecoveries.add(id);
  const day = expiredClaim ? expiredClaimDay(expiredClaim) : '';
  notify(day
    ? `Couldn't add this to ${day} because that day had already ended. It's back in Brain Dump.`
    : 'Couldn\'t add this to your plan because that day had already ended. It\'s back in Brain Dump.');
}

/** The quiet in-row note for a capture that came back from an expired claim,
 *  shown until the owner does anything with it (any change moves updatedAt). */
function expiredClaimNote(item) {
  const e = item.expiredClaim;
  if (!e || item.updatedAt !== e.expiredAt) return '';
  const day = expiredClaimDay(e);
  return `<div style="font-size:12px;opacity:.7;margin-top:2px">${day ? `Couldn't be added to ${escapeHtml(day)}: that day had ended.` : 'Couldn\'t be added: that day had ended.'}</div>`;
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
  if (after?.status === 'promoted') notify('This item was already added to your plan.');
  else if (after?.promotionClaim) notify('This item is already being added to your plan.');
  else notify('Moved back to triage.');
  render();
}

function openInPlan(id) {
  const item = repository().read(id);
  const { openDateKey } = item ? destinationOf(item) : { openDateKey: '' };
  if (!openDateKey || typeof globalThis.jumpTimelineToDate !== 'function' || typeof globalThis.showView !== 'function') return;
  globalThis.showView('today');
  globalThis.jumpTimelineToDate(openDateKey);
}

// ── My Day planning tray (TASK-015) ─────────────────────────────────────────
// Places triaged captures on Today or Tomorrow without leaving My Day. It lives
// in this module (not its own) so it shares pendingPromotionIds, the reconciler
// and the one promotion path with the Brain Dump view. Deliberately narrow: no
// triage, archive, delegate, timed scheduling or capture here.

const TRAY_ORDER = ['do-first', 'schedule', 'delegate-candidate', 'archive-candidate'];
const TRAY_CHIP = { 'do-first': 'Do first', schedule: 'Schedule', 'delegate-candidate': 'Delegate?', 'archive-candidate': 'Archive?' };
const TRAY_ROWS = 5;
const TRAY_PREVIEW = 3;
const TRAY_OPEN_KEY = 'ta3-bd-tray-open'; // per device, not per account: it is a view preference

let trayExpanded = null; // read lazily; an unavailable localStorage just means "collapsed"
let trayShowAll = false;

function isTrayExpanded() {
  if (trayExpanded === null) {
    try { trayExpanded = localStorage.getItem(TRAY_OPEN_KEY) === '1'; } catch { trayExpanded = false; }
  }
  return trayExpanded;
}

function toggleTray() {
  trayExpanded = !isTrayExpanded();
  if (!trayExpanded) trayShowAll = false;
  try { localStorage.setItem(TRAY_OPEN_KEY, trayExpanded ? '1' : '0'); } catch { /* remembered for this page only */ }
  renderTray();
}

function showAllTray() {
  trayShowAll = true;
  renderTray();
}

/** The calendar date a target is labelled with — the same derivation as
 *  planning-continuity-ui.js's taskDateHint (its scheduled date, else its start
 *  date in its own zone, else its dateKey). */
function trayDateHint(target) {
  let scheduled = null;
  try { scheduled = window.PlanAuthority.scheduledDateForTarget(target, ''); } catch { scheduled = null; }
  if (scheduled) return scheduled;
  return Number.isFinite(target.startMs)
    ? localPlanDate(target.startMs, target.timezone || resolveAccountingTimezone())
    : target.dateKey || '';
}

/** Today and Tomorrow as the tray offers them. Tomorrow is offered ONLY when
 *  scheduling its labelled date provably lands on next(current()) — otherwise the
 *  label could promise a day the Schedule path would not write to. */
function trayDays() {
  const authority = window.PlanAuthority;
  let today = null;
  try { today = authority ? authority.current() : null; } catch { today = null; }
  if (!today?.id) return { today: null, tomorrow: null };
  let tomorrow = null;
  try {
    const next = authority.next(today);
    const date = trayDateHint(next);
    const resolved = date ? authority.dayForScheduledDate(date, '') : null;
    if (next?.id && resolved?.ok && resolved.target?.id === next.id) tomorrow = { target: next, date };
  } catch { tomorrow = null; }
  return { today: { target: today, date: trayDateHint(today) }, tomorrow };
}

function trayButtonHtml(kind, item, days, day) {
  const label = kind === 'today' ? 'Today' : 'Tomorrow';
  const date = formatDateKey(day.date);
  return `<button type="button" class="btn sm bdt-btn" data-bdt-id="${escapeHtml(item.id)}" data-bdt-today="${escapeHtml(days.today.target.id)}" data-bdt-target="${escapeHtml(day.target.id)}" data-bdt-date="${escapeHtml(day.date)}" onclick="window.BrainDumpUI.trayPlace(this,'${kind}')">${label}${date ? ` · ${escapeHtml(date)}` : ''}</button>`;
}

function trayRowHtml(item, days) {
  const quadrant = quadrantOf(item);
  // Same rule as the Brain Dump view: never offer a second promotion while the
  // first one's outcome is unknown.
  const actions = promotionPending(item.id)
    ? '<span class="bdt-pending">Still confirming…</span>'
    : `${days.today ? trayButtonHtml('today', item, days, days.today) : ''}${days.tomorrow ? trayButtonHtml('tomorrow', item, days, days.tomorrow) : ''}`;
  return `
    <li class="bdt-row" data-bdt-row="${escapeHtml(item.id)}">
      <div class="bdt-text">${escapeHtml(item.text)}</div>
      <div class="bdt-meta"><span class="bdt-chip">${escapeHtml(TRAY_CHIP[quadrant] || '')}</span>${actions}</div>
    </li>`;
}

function trayOrder(triaged) {
  // Array#sort is stable, so the model's canonical createdAt order holds within a quadrant.
  const rank = item => { const i = TRAY_ORDER.indexOf(quadrantOf(item)); return i < 0 ? TRAY_ORDER.length : i; };
  return triaged.slice().sort((a, b) => rank(a) - rank(b));
}

export function renderTray() {
  const section = typeof document !== 'undefined' ? document.getElementById('bd-plan-tray') : null;
  if (!section) return;
  let all = {};
  try { all = repository().listAllRaw(); } catch { all = {}; }
  const untriaged = untriagedCaptures(all);
  const triaged = triagedCaptures(all);
  if (!untriaged.length && !triaged.length) {
    section.hidden = true;
    section.innerHTML = '';
    return;
  }
  const expanded = isTrayExpanded();
  const toTriage = untriaged.length ? ` · ${untriaged.length} to triage` : '';
  let body = '';
  if (expanded) {
    const days = trayDays();
    const ordered = trayOrder(triaged);
    const shown = trayShowAll ? ordered : ordered.slice(0, TRAY_ROWS);
    const more = ordered.length > shown.length
      ? `<button type="button" class="btn sm ghost bdt-more" onclick="window.BrainDumpUI.showAllTray()">Show all (${ordered.length})</button>` : '';
    const preview = untriaged.length ? `
      <div class="bdt-untriaged">
        <ul class="bdt-preview">${untriaged.slice(0, TRAY_PREVIEW).map(item => `<li>${escapeHtml(item.text)}</li>`).join('')}</ul>
        <button type="button" class="btn sm ghost bdt-more" onclick="showView('braindump')">${untriaged.length} to triage</button>
      </div>` : '';
    body = `
      <div class="bdt-body">
        ${shown.length ? `<ul class="bdt-list">${shown.map(item => trayRowHtml(item, days)).join('')}</ul>` : ''}
        ${more}${preview}
      </div>`;
  }
  section.hidden = false;
  section.innerHTML = `
    <button type="button" class="bdt-head" aria-expanded="${expanded}" onclick="window.BrainDumpUI.toggleTray()">
      <span>Brain Dump · ${triaged.length} to plan${toTriage}</span><span class="bdt-caret" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
    </button>${body}`;
}

/** Today / Tomorrow from the tray. Midnight guard: the button carries the day it
 *  was rendered for; if that is no longer the day the tap would write to, nothing
 *  is written and the tray is redrawn with the real days. */
async function trayPlace(button, kind) {
  const { bdtId: id, bdtToday: renderedToday, bdtTarget: renderedTarget, bdtDate: renderedDate } = button?.dataset || {};
  if (!id || promotionPending(id)) return;
  const days = trayDays();
  const day = kind === 'today' ? days.today : days.tomorrow;
  if (days.today?.target.id !== renderedToday || day?.target.id !== renderedTarget || day?.date !== renderedDate) {
    notify('The day just changed — check where this goes.');
    renderTray();
    return;
  }
  // No await between the guard and these calls: the promotion resolves its
  // target synchronously, in the same tick the guard checked.
  if (kind === 'today') { await doToday(id); return; }
  const result = await scheduleTo(id, { dateKey: renderedDate });
  reportPromotionOutcome(result, 'Added to tomorrow\'s plan.', id);
}

if (typeof window !== 'undefined') {
  window.BrainDumpUI = { render, setTriageAnswer, saveTriage, doToday, toggleSchedule, confirmSchedule, archive, delegate, toggleHandledEdit, saveHandledEdit, reopen, openInPlan, renderTray, toggleTray, showAllTray, trayPlace };
  // My Day's plan surfaces refresh on every authoritative plan change; the tray's
  // day labels and Tomorrow availability depend on that same state.
  globalThis.refreshBrainDumpTray = renderTray;
  // A different account's cache becoming active (sign-in/out, a direct switch) must
  // re-render so nothing drawn from the previous account's captures lingers — the
  // same reasoning commitments-sync.js documents for refreshCommitmentSurfaces.
  // `id`/`record`, when present, are brain-dump-sync.js's onRemoteChange payload
  // (a merge actually changed something for that capture) — the trigger for
  // reconcilePromotionClaim (FIX FIRST round 3). Absent on a plain re-render
  // call (e.g. onRebind, which has no single capture in mind).
  globalThis.refreshBrainDumpSurfaces = (id, record) => {
    if (id) maybeReconcile(id, record);
    else settleAllOutstandingClaims(); // a (re)bind: the account's cache just became active
    if (document.getElementById('view-braindump')?.classList.contains('active')) render();
    else renderTray(); // the tray is on My Day: a remote change or account switch must reach it too
  };
  window.addEventListener('online', () => globalThis.refreshBrainDumpSurfaces());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') globalThis.refreshBrainDumpSurfaces();
  });
  // A bind/hydration may already have happened before this module evaluated.
  globalThis.refreshBrainDumpSurfaces();
}
