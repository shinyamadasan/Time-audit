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
// Side-effect import: personal-day-boundary-recovery.js owns the `window.PersonalDayBoundaryRecovery`
// singleton this file reads. Importing it here (after personal-day-boundary-live.js above, which
// itself side-effect-imports personal-day-boundary-sync.js) makes the whole chain a module-graph
// guarantee — window.PersonalDayBoundaryLive and window.PersonalDayBoundarySync already exist by
// the time recovery.js's own singleton block constructs itself.
import './personal-day-boundary-recovery.js';

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
    // An empty local cache is only "off" once the account has answered. Until then the
    // true state is unknown, and saying "Off" would be a guess that can be wrong.
    if (state.sync === 'pending') {
      return '<div class="setting-sub" role="status" data-pdb-state="checking">Checking your synced personal day setting…</div>';
    }
    // Neither is "off": the account's setting is unknown here. Say so instead of guessing.
    if (state.sync === 'error') {
      return '<div class="setting-sub" role="alert" data-pdb-state="load-failed" style="color:var(--waste)">Could not load your synced personal day setting. Your day starts at midnight on this device until it loads. Nothing was changed.</div>';
    }
    if (state.remote && state.remote.unapplied) {
      return '<div class="setting-sub" role="alert" data-pdb-state="unapplied" style="color:var(--waste)">Your synced personal day setting was received but could not be applied on this device (its history is conflicting or invalid). Your day starts at midnight here until that is resolved. Nothing was changed or deleted.</div>';
    }
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
  if (!preview.ok && preview.reason === 'sync-pending') {
    return '<div class="setting-sub" role="status">This can be changed once your synced setting has loaded.</div>';
  }
  if (!preview.ok && (preview.reason === 'sync-error' || preview.reason === 'sync-unapplied')) {
    return '<div class="setting-sub" role="status">This can be changed once your synced setting can be loaded and applied.</div>';
  }
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
    You have already prepared the personal day ${escape(named.join(' and '))}. After this change it is no longer your current or next personal day, so it leaves the Today / Prepare next personal day workflow. It is not deleted, moved or merged — it stays exactly as you prepared it, under <strong>Prepared plans</strong> on Today.
  </div>`;
}

/** The ONE recovery wiring instance, mirroring live()'s own singleton discipline. */
function recovery() {
  return typeof window !== 'undefined' ? window.PersonalDayBoundaryRecovery : null;
}

/** Purely local UI state for the recovery card — never persisted. `checked` mirrors the checkbox's
 *  own DOM state so a re-render doesn't uncheck it out from under the owner mid-decision, but the
 *  ACTUAL attestation gate is always recovery.isAttested() (re-validated against the live room and
 *  compatible set every render) — this local flag alone never authorizes anything. */
let recoveryUiState = { checked: false, busy: false, message: '', error: '' };

/** The Legacy Recovery V2 confirmation card — shown only when recovery.status() itself has already
 *  determined the candidate is a technically COMPATIBLE one (every structural condition in
 *  personal-day-boundary-recovery.js's header), never offered speculatively. Compatibility is never
 *  described as proof of ownership: the copy states plainly that this device's old cache does not
 *  record who created it, and the action stays disabled until the owner explicitly attests it is
 *  theirs. Nothing here is persisted by rendering; the append only happens on the explicit,
 *  attested button click below. */
function recoveryHtml() {
  const module = recovery();
  if (!module) return '';
  let analysis;
  try { analysis = module.status(); } catch { analysis = { compatible: false }; }
  // A completed recovery makes `compatible` false on THIS very render (the missing revision just
  // landed) — the result message must still show even though the "offer" card itself is gone now.
  const resultRows = `
    ${recoveryUiState.message ? `<div class="setting-row" style="border-bottom:none"><div class="setting-sub" role="status">${escape(recoveryUiState.message)}</div></div>` : ''}
    ${recoveryUiState.error ? `<div class="setting-row" style="border-bottom:none"><div class="setting-sub" role="alert" style="color:var(--waste)">${escape(recoveryUiState.error)}</div></div>` : ''}`;
  if (!analysis.compatible) return resultRows;
  const active = analysis.previewActive;
  const boundaryLine = active
    ? `<div class="setting-sub">Boundary: <strong>${escape(formatBoundaryClock(active.boundaryTime))}</strong><br>Timezone: <strong>${escape(active.timezone)}</strong></div>`
    : '';
  const attested = module.isAttested();
  const checkboxLabel = active
    ? `I confirm this ${escape(formatBoundaryClock(active.boundaryTime))} personal day setting is mine and should be attached to the account I'm currently signed in to.`
    : `I confirm this personal day setting is mine and should be attached to the account I'm currently signed in to.`;
  return `<div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px" role="status" data-pdb-recovery="offer">
    <div class="setting-label">Old personal day setting found on this device</div>
    ${boundaryLine}
    <div class="setting-sub" role="alert" style="color:var(--waste)">This setting comes from an older local cache that did not record which account owned it. ChronaSense cannot verify that it belongs to the account you are currently signed in to.</div>
    <label class="setting-sub" style="display:flex;align-items:flex-start;gap:6px;cursor:pointer">
      <input type="checkbox" data-pdb-attest${recoveryUiState.checked ? ' checked' : ''}${recoveryUiState.busy ? ' disabled' : ''} style="margin-top:2px">
      <span>${escape(checkboxLabel)}</span>
    </label>
    <div><button type="button" class="btn sm" data-pdb-action="recover"${(!attested || recoveryUiState.busy) ? ' disabled' : ''}>${recoveryUiState.busy ? 'Recovering…' : 'Recover this setting'}</button></div>
    <div class="setting-sub">This will append the missing historical Personal Day revision(s) to the current account. Existing cloud history will not be deleted or rewritten.</div>
  </div>${resultRows}`;
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
    ${recoveryHtml()}
    ${editorRows}
    <div class="setting-row"><div style="flex:1">${previewHtml(state)}</div></div>
    ${saveButtonHtml(state)}
    ${draft.message ? `<div class="setting-row" style="border-bottom:none"><div class="setting-sub" role="status">${escape(draft.message)}</div></div>` : ''}
    ${draft.error ? `<div class="setting-row" style="border-bottom:none"><div class="setting-sub" role="alert" style="color:var(--waste)">${escape(draft.error)}</div></div>` : ''}
  `;
}

function onInput(event) {
  const attestBox = event.target.closest('[data-pdb-attest]');
  if (attestBox) {
    const module = recovery();
    recoveryUiState = { ...recoveryUiState, checked: attestBox.checked, message: '', error: '' };
    if (module) {
      // The explicit owner action — never inferred from the Recover button click itself. Unchecking
      // withdraws it immediately; re-checking re-attests fresh against whatever is CURRENTLY
      // compatible (never a stale prior attestation silently reinstated).
      if (attestBox.checked) module.attest(); else module.clearAttestation();
    }
    renderPersonalDayBoundarySettings();
    return;
  }
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

function onSaveClick() {
  if (!draft || !live()) return;
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

/** Requires recovery.isAttested() to already be true — re-checked live by the module itself inside
 *  recover(), never trusted from whatever this UI last rendered. The checkbox click is the owner's
 *  explicit provenance attestation; THIS click is only the action, gated on that attestation still
 *  holding at the moment of the click (the button is disabled otherwise, but recover() re-verifies
 *  regardless, since a stale render could theoretically still be on screen). */
function onRecoverClick() {
  const module = recovery();
  if (!module || recoveryUiState.busy) return;
  recoveryUiState = { ...recoveryUiState, busy: true, message: '', error: '' };
  renderPersonalDayBoundarySettings();
  module.recover().then(result => {
    if (result.outcome === 'recovered') {
      recoveryUiState = { checked: false, busy: false, message: 'Recovered. The historical personal day revision(s) have been added to your account.', error: '' };
    } else if (result.outcome === 'not-attested') {
      // The room or the compatible set changed between rendering and clicking — never silently
      // retried; the owner must attest again against whatever is true now.
      recoveryUiState = { checked: false, busy: false, message: '', error: 'This could not be confirmed for your current account. Please review and confirm again if it still applies.' };
    } else if (result.outcome === 'not-eligible') {
      recoveryUiState = { checked: false, busy: false, message: '', error: '' };
    } else {
      recoveryUiState = { checked: false, busy: false, message: '', error: 'Recovery could not be confirmed. Nothing was changed — you can try again.' };
    }
    renderPersonalDayBoundarySettings();
    if (typeof window.refreshOperationalPlanSurfaceIfMounted === 'function') window.refreshOperationalPlanSurfaceIfMounted();
  });
}

function onClick(event) {
  if (event.target.closest('[data-pdb-action="save"]')) { onSaveClick(); return; }
  if (event.target.closest('[data-pdb-action="recover"]')) { onRecoverClick(); }
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
