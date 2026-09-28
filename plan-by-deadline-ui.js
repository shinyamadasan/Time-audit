// plan-by-deadline-ui.js
//
// Calendar Day + Extended My Day V1 — the Plan-by-deadline section of the
// existing Settings page. Mounts into `#plan-by-deadline-settings` (index.html),
// mirroring personal-day-boundary-ui.js's shape: a module that renders into one
// container and exposes a `window.render...` entry point renderSettings() calls.
//
// ── what this file must never do (mirrors personal-day-boundary-ui.js) ────
//  - No day/boundary arithmetic. Activation instants come from
//    PlanByDeadlineSync.repository.proposeDeadline(), which delegates to
//    plan-by-deadline-model.js's own proposeDeadlineRevision/nextBoundaryInstant.
//  - No second timezone source. The deadline always uses the account's existing
//    authoritative timezone; there is deliberately no timezone picker here.
//  - Nothing is persisted by rendering. A draft is pure UI state until the user
//    presses Save, or presses the off-day button.

const CONTAINER_ID = 'plan-by-deadline-settings';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const CONTROL_STYLE = 'background:var(--bg3);border:1px solid var(--border2);color:var(--text);font-family:var(--mono);font-size:11px;padding:5px 7px;border-radius:6px;outline:none;width:auto';

let message = '';

function sync() {
  return typeof window !== 'undefined' ? window.PlanByDeadlineSync : null;
}

function container() {
  return typeof document !== 'undefined' ? document.getElementById(CONTAINER_ID) : null;
}

function accountTimezone() {
  try {
    const context = typeof globalThis.getOperationalPlanAppContext === 'function' ? globalThis.getOperationalPlanAppContext() : null;
    if (context?.timezone) return context.timezone;
  } catch { /* fall through */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
}

/** The SAME origin date planningDeadlineStreak() uses for "today" — the
 *  current() target's own origin date, never an independently-derived
 *  calendar date (FIX FIRST §2: the off-day toggle must target the exact
 *  date the streak looks up, or "mark today off" could silently apply to a
 *  date the streak never even asks about under an active boundary). Falls
 *  back to a plain calendar date only if PlanAuthority is unavailable. */
function todayDateKey() {
  try {
    const target = window.PlanAuthority?.current?.();
    if (target && typeof window.PlanAuthority.deadlineDateKeyForTarget === 'function') {
      return window.PlanAuthority.deadlineDateKeyForTarget(target);
    }
  } catch { /* fall through */ }
  const tz = accountTimezone();
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

function saveDeadline() {
  const bridge = sync();
  const input = container()?.querySelector('#plan-by-deadline-time');
  const value = input?.value;
  if (!bridge || !value) return;
  try {
    bridge.repository.proposeDeadline({ deadlineTime: value, timezone: accountTimezone() }, Date.now());
    bridge.pushAllDeadlines();
    message = 'Saved.';
    if (window.PlanAuthority) window.PlanAuthority.invalidate();
  } catch (err) {
    message = err.message || 'Could not save that time.';
  }
  render();
  globalThis.renderToday?.();
}

function toggleOffDay() {
  const bridge = sync();
  if (!bridge) return;
  const dateKey = todayDateKey();
  const existing = bridge.repository.readOffDay(dateKey);
  const alreadyDeclared = existing && !Number.isFinite(existing.revokedAtMs);
  if (alreadyDeclared) bridge.repository.revokeOffDay(dateKey, Date.now());
  else bridge.repository.declareOffDay(dateKey, Date.now());
  bridge.pushAllOffDays();
  if (window.PlanAuthority) window.PlanAuthority.invalidate();
  render();
  globalThis.renderToday?.();
}

window.savePlanByDeadline = saveDeadline;
window.togglePlanByDeadlineOffDay = toggleOffDay;

function render() {
  const el = container();
  if (!el) return;
  const bridge = sync();
  if (!bridge) { el.innerHTML = ''; return; }

  const revisions = bridge.repository.readDeadlines();
  const configured = revisions.length > 0;
  const shownTime = (configured ? revisions[revisions.length - 1].deadlineTime : '') || '08:00';

  const dateKey = todayDateKey();
  const offDayRecord = bridge.repository.readOffDay(dateKey);
  const offDayActive = !!offDayRecord && !Number.isFinite(offDayRecord.revokedAtMs);

  // FIX FIRST §14/§15: two devices independently set conflicting settings at the
  // same activation instant — paused-safe (never a guessed winner), resolved only
  // by explicitly saving a new time below (Save always works: proposeDeadline
  // builds from the conflict-free set and never rejects because of it).
  const hasConflict = typeof bridge.repository.deadlineConflict === 'function' && bridge.repository.deadlineConflict().length > 0;
  const explain = hasConflict
    ? 'Two devices set conflicting planning deadlines at the same time. Planning streak tracking is paused until you save a time below to resolve it.'
    : configured
    ? 'Plan your day before this time to maintain your planning streak.'
    : 'Choose a planning deadline to enable planning streak tracking.';

  const streak = (() => {
    try { return window.PlanAuthority?.planningDeadlineStreak?.(); } catch { return null; }
  })();
  const streakLine = streak?.status === 'configured'
    ? `<div class="settings-hint" style="margin-top:6px">Today: ${escape(streak.today.status)} · Current streak ${streak.current} · Best ${streak.best}</div>`
    : streak?.status === 'conflict'
    ? `<div class="settings-hint" style="margin-top:6px">Streak tracking paused — conflicting deadline settings need resolving.</div>`
    : '';

  el.innerHTML = `
    <div class="settings-hint">${escape(explain)}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap">
      <label style="font-size:11px;color:var(--muted)">Plan-by deadline
        <input id="plan-by-deadline-time" type="time" value="${escape(shownTime)}" style="${CONTROL_STYLE};margin-left:6px">
      </label>
      <button class="btn sm" onclick="savePlanByDeadline()">Save</button>
    </div>
    ${message ? `<div class="settings-hint" style="margin-top:4px">${escape(message)}</div>` : ''}
    ${streakLine}
    <div style="margin-top:10px">
      <button class="btn sm ghost" onclick="togglePlanByDeadlineOffDay()">${offDayActive ? 'Undo intentional off-day for today' : 'Mark today as an intentional off-day'}</button>
    </div>
  `;
}

window.renderPlanByDeadlineSettings = render;
