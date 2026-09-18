// personal-day-boundary-ui.js
//
// Live Wiring V1 — the Personal Day Boundary section of the existing Settings
// page. Mounts into `#personal-day-boundary-settings` (index.html), mirroring
// coarse-life-evidence-ui.js's shape: a module that renders into one container
// and exposes a `window.render...` entry point the classic script's
// renderSettings() calls.
//
// ── what this file must never do ────────────────────────────────────────────
//  - No operational-day arithmetic. Activation instants come from
//    PersonalDayBoundaryLive.previewProposal(), which delegates to the model's
//    own proposeBoundaryRevision/nextBoundaryInstant.
//  - No writes through saveSettings()/settings.timezone. The Personal Day
//    Boundary is its own append-only revisioned store, not a field on the
//    legacy settings object, and the two are never kept in sync afterwards.
//  - No disable / reset-to-legacy / "use calendar day" control, at all. Under
//    the existing contract a 00:00 revision is still a CUSTOM operational
//    boundary, so such a control would promise something the system cannot do
//    (V1 product decision: ENABLE + CHANGE only).
//  - Nothing is persisted by rendering. The OFF state is a pure UI state until
//    the user presses the explicit save button.

import { describeActivationInstant } from './personal-day-boundary-live.js';

const CONTAINER_ID = 'personal-day-boundary-settings';

// The same zone list the existing "Work day timezone" control offers, so the
// two settings look like siblings even though they are stored independently.
const TIMEZONES = [
  ['America/New_York', 'US Eastern'],
  ['America/Chicago', 'US Central'],
  ['America/Denver', 'US Mountain'],
  ['America/Los_Angeles', 'US Pacific'],
  ['Asia/Manila', 'Philippines'],
  ['Asia/Singapore', 'Singapore'],
  ['Asia/Tokyo', 'Japan'],
  ['Asia/Dubai', 'Dubai'],
  ['Europe/London', 'London'],
  ['Europe/Paris', 'Europe Central'],
  ['Australia/Sydney', 'Sydney'],
];

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const CONTROL_STYLE = 'background:var(--bg3);border:1px solid var(--border2);color:var(--text);font-family:var(--mono);font-size:11px;padding:5px 7px;border-radius:6px;outline:none;width:auto';

/** Purely local UI state — never persisted, never a second source of truth.
 *  Seeded from the live boundary state on every render where the user has not
 *  started editing, so the controls always begin from the ACTUAL active/pending
 *  boundary rather than an unrelated UI preference. */
let draft = null;

/** The ONE live wiring instance. Deliberately never falls back to constructing a
 *  second one: a second repository instance would be a second write path that
 *  the sync bridge does not know about — exactly the competing-truth failure
 *  this whole feature exists to avoid. No singleton means render nothing. */
function live() {
  return typeof window !== 'undefined' ? window.PersonalDayBoundaryLive : null;
}

function container() {
  return typeof document !== 'undefined' ? document.getElementById(CONTAINER_ID) : null;
}

function defaultTimezone() {
  try {
    const context = typeof globalThis.getOperationalPlanAppContext === 'function' ? globalThis.getOperationalPlanAppContext() : null;
    if (context?.timezone) return context.timezone;
  } catch { /* fall through to the device zone */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
}

/** Resets the editing draft to whatever the persisted truth currently says. */
function seedDraft(state) {
  const source = state.pending || state.active;
  draft = {
    // For a first enable the Work day timezone is preselected for convenience
    // ONLY — from the moment a revision exists, the revision's own stored
    // timezone is what is shown, and the two settings are never resynchronized.
    boundaryTime: source ? source.boundaryTime : '18:00',
    timezone: source ? source.timezone : defaultTimezone(),
    dirty: false,
    message: '',
    error: '',
  };
  return draft;
}

/** "00:00" / "12:00" read as "midnight" / "noon" everywhere this settings
 *  panel states a boundary's current or scheduled clock time; every other
 *  time is shown exactly as stored (the same 24-hour reading the time input
 *  itself uses — never a second, inconsistent format). */
function formatBoundaryClock(boundaryTime) {
  if (boundaryTime === '00:00') return 'midnight';
  if (boundaryTime === '12:00') return 'noon';
  return boundaryTime;
}

function timezoneOptions(selected) {
  const known = TIMEZONES.some(([value]) => value === selected);
  const extra = known || !selected ? '' : `<option value="${escape(selected)}" selected>${escape(selected)}</option>`;
  return extra + TIMEZONES.map(([value, label]) =>
    `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(label)}</option>`).join('');
}

function statusHtml(state, nowMs) {
  if (state.status === 'invalid') {
    return `<div class="setting-sub" role="alert" style="color:var(--waste)">Your personal day boundary history could not be read, so it is not being applied. Nothing was changed or deleted. (${escape(state.error || 'unknown error')})</div>`;
  }
  if (state.status !== 'custom') {
    return '<div class="setting-sub">Off. Your day currently starts at midnight, exactly as it always has.</div>';
  }
  const currentLine = `Current: <strong>${escape(formatBoundaryClock(state.active.boundaryTime))}</strong> (${escape(state.active.timezone)}).`;
  if (!state.pending) return `<div class="setting-sub" role="status">${currentLine}</div>`;
  const activationLabel = liveDescribeActivation(state.pending, nowMs);
  return `<div class="setting-sub" role="status">${currentLine}<br>Scheduled: <strong>${escape(formatBoundaryClock(state.pending.boundaryTime))}</strong> (${escape(state.pending.timezone)}) starting ${escape(activationLabel)}.</div>`;
}

/** Formats an ALREADY-COMPUTED effectiveFromInstant. The instant itself always
 *  came from the model — this only decides how to say it. */
function liveDescribeActivation(revision, nowMs) {
  return describeActivationInstant(revision.effectiveFromInstant, revision.boundaryTime, revision.timezone, nowMs);
}

function previewHtml(state) {
  const preview = live().previewProposal({ boundaryTime: draft.boundaryTime, timezone: draft.timezone });
  if (!preview.ok) {
    const why = preview.reason === 'invalid-time' ? 'Choose a valid start time.'
      : preview.reason === 'invalid-timezone' ? 'Choose a valid timezone.'
        : `This change cannot be applied right now (${escape(preview.error || preview.reason)}).`;
    return `<div class="setting-sub" role="alert" style="color:var(--waste)">${why}</div>`;
  }
  if (preview.unchanged) {
    return '<div class="setting-sub" role="status">This is already your personal day start. Choose a different time or timezone to change it.</div>';
  }
  if (preview.alreadyPending) {
    return `<div class="setting-sub" role="status">Change scheduled. This already starts at <strong>${escape(preview.pendingActivationLabel)}</strong>.</div>`;
  }
  // Boundary changes are prospective and can shorten the transition day — say
  // so plainly rather than letting the user discover it afterwards.
  return `<div class="setting-sub" role="status">This takes effect at <strong>${escape(preview.activationLabel)}</strong>. Your current personal day runs until then, and may be shorter than usual because of it. Nothing already recorded is regrouped.</div>${orphanWarningHtml()}`;
}

/** The reachability warning. "Nothing is regrouped" is true of the DATA but is
 *  not the whole truth about the PRODUCT: a change can move an already-prepared
 *  future personal day out of current/upcoming, which is where the one planning
 *  workflow can reach. When that would happen, name the affected day here,
 *  before saving. The plan is never moved, copied, merged or deleted — it stays
 *  exactly as prepared, and stays reachable under Prepared Plans. */
function orphanWarningHtml() {
  const authority = typeof window !== 'undefined' ? window.PlanAuthority : null;
  if (!authority) return '';
  let impact;
  try {
    impact = authority.boundaryChangeImpact({ boundaryTime: draft.boundaryTime, timezone: draft.timezone });
  } catch {
    return '';
  }
  if (!impact.ok || !impact.orphaned.length) return '';
  const named = impact.orphaned.map(target => {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: target.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    return `${fmt.format(new Date(target.startMs)).replace(',', '')} → ${fmt.format(new Date(target.endMs)).replace(',', '')}`;
  });
  return `<div class="setting-sub" role="alert" data-pdb-orphan-warning style="color:var(--waste)">
    You have already prepared the personal day ${escape(named.join(' and '))}. After this change it is no longer your current or next personal day, so it leaves the Today / Prepare tomorrow workflow. It is not deleted, moved or merged — it stays exactly as you prepared it, under <strong>Prepared plans</strong> on Today.
  </div>`;
}

function saveButtonHtml(state) {
  const label = state.status === 'custom' ? 'Save personal day start' : 'Turn on personal day boundary';
  const preview = live().previewProposal({ boundaryTime: draft.boundaryTime, timezone: draft.timezone });
  const disabled = !preview.ok || preview.unchanged || preview.alreadyPending ? ' disabled' : '';
  return `<div class="setting-row" style="border-bottom:none"><button type="button" class="btn sm" data-pdb-action="save"${disabled}>${escape(label)}</button></div>`;
}

export function renderPersonalDayBoundarySettings() {
  const root = container();
  if (!root) return;
  const wiring = live();
  if (!wiring) { root.innerHTML = '<div class="setting-sub" role="alert">Personal day boundary settings are unavailable right now.</div>'; return; }
  let state;
  try {
    state = wiring.boundaryState();
  } catch (err) {
    root.innerHTML = `<div class="setting-sub" role="alert">Personal day boundary settings are unavailable right now. (${escape(err.message)})</div>`;
    return;
  }
  if (!draft || !draft.dirty) seedDraft(state);

  const nowMs = Date.now();
  const activated = state.status === 'custom';
  // OFF is only offered to an account that has never activated a custom
  // revision. Once one exists, the feature is described as active and
  // adjustable — there is deliberately no control that claims to undo it.
  // Either way the time/timezone editor below is always visible: there is no
  // separate "enable" checkbox gating it, only the explicit save/activation
  // button — one decision, not two.
  const enableRow = activated
    ? `<div class="setting-row">
        <div><div class="setting-label">Personal day boundary</div><div class="setting-sub">Active and adjustable. Your day starts at the time you choose instead of midnight.</div></div>
        <div class="setting-control"><span class="setting-sub" data-pdb-state="active">On</span></div>
      </div>`
    : `<div class="setting-row">
        <div><div class="setting-label">Personal day boundary</div><div class="setting-sub">Start your day at a time you choose (e.g. 18:00 for a graveyard shift) instead of midnight.</div></div>
      </div>`;

  const editorRows = `
    <div class="setting-row">
      <div><div class="setting-label">Personal day starts</div><div class="setting-sub">The clock time each personal day begins. Changing it later is always allowed.</div></div>
      <div class="setting-control"><input type="time" data-pdb-input="time" value="${escape(draft.boundaryTime)}" style="${CONTROL_STYLE}" aria-label="Personal day start time"></div>
    </div>
    <div class="setting-row">
      <div><div class="setting-label">Personal day timezone</div><div class="setting-sub">Stored on the boundary itself. Separate from Work day timezone — changing one never changes the other.</div></div>
      <div class="setting-control"><select data-pdb-input="timezone" style="${CONTROL_STYLE}">${timezoneOptions(draft.timezone)}</select></div>
    </div>`;

  root.innerHTML = `
    ${enableRow}
    <div class="setting-row"><div style="flex:1">${statusHtml(state, nowMs)}</div></div>
    ${editorRows}
    <div class="setting-row"><div style="flex:1">${previewHtml(state)}</div></div>
    ${saveButtonHtml(state)}
    ${draft.message ? `<div class="setting-row" style="border-bottom:none"><div class="setting-sub" role="status">${escape(draft.message)}</div></div>` : ''}
    ${draft.error ? `<div class="setting-row" style="border-bottom:none"><div class="setting-sub" role="alert" style="color:var(--waste)">${escape(draft.error)}</div></div>` : ''}
  `;
}

function onInput(event) {
  const control = event.target.closest('[data-pdb-input]');
  if (!control) return;
  const kind = control.dataset.pdbInput;
  if (!draft) return;
  draft.dirty = true;
  draft.message = '';
  draft.error = '';
  if (kind === 'time' && control.value) draft.boundaryTime = control.value;
  if (kind === 'timezone') draft.timezone = control.value;
  renderPersonalDayBoundarySettings();
}

function onClick(event) {
  const control = event.target.closest('[data-pdb-action="save"]');
  if (!control || !draft || !live()) return;
  try {
    const result = live().proposeBoundary({ boundaryTime: draft.boundaryTime, timezone: draft.timezone });
    draft.dirty = false;
    draft.message = `Saved. Your personal day starts at ${result.revision.boundaryTime} (${result.revision.timezone}) from the next occurrence of that time.`;
    draft.error = '';
  } catch (err) {
    draft.dirty = true;
    // The UI already refuses to submit an exact duplicate of a pending
    // revision (see previewProposal's alreadyPending / saveButtonHtml's
    // disabled state) — this is a defensive fallback for the model's raw
    // uniqueness rejection, never the primary guard, so it never needs to
    // parse or rely on the model's internal wording beyond this one match.
    draft.error = err.message === 'Boundary revision effective instants must be unique.'
      ? 'Change scheduled. This exact change is already pending.'
      : err.message;
  }
  // Re-seed from persisted truth on the next render (dirty is false on success).
  renderPersonalDayBoundarySettings();
  if (typeof window.refreshOperationalPlanSurfaceIfMounted === 'function') window.refreshOperationalPlanSurfaceIfMounted();
}

if (typeof window !== 'undefined') {
  const root = container();
  if (root) {
    root.addEventListener('change', onInput);
    root.addEventListener('click', onClick);
  }
  window.renderPersonalDayBoundarySettings = renderPersonalDayBoundarySettings;
  window.reportPersonalDayBoundaryConflict = result => {
    // A remote contradiction or rejected revision is a fact worth surfacing, not
    // hiding. The Settings panel is the only place that can explain it.
    if (!draft) return;
    draft.error = result?.conflict
      ? `A conflicting boundary history was received from another device and was not applied: ${result.conflict}`
      : 'A boundary revision from another device conflicted with this device\'s history and was not applied.';
    renderPersonalDayBoundarySettings();
  };
}
