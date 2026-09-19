// operational-plan-ui.js
//
// Single Plan Authority V1 — the personal-day STATUS strip and the Prepared
// Plans recovery list, mounted into `#operational-plan-section` on Today.
//
// ── what this is NOT any more ───────────────────────────────────────────────
// Live Wiring V1 shipped a second editable planning surface here (the Now/Next
// panes). That was the defect this milestone exists to remove: a boundary
// account could edit a personal-day plan here while the Today strip and Prepare
// Tomorrow edited a calendar plan, and the rest of the product (Planning Streak,
// tomorrow-ready, reconciliation) followed the other one. There is now exactly
// ONE editable planning workflow — Today's own priorities strip for the current
// personal day, and Prepare Tomorrow for the upcoming one. This file no longer
// writes anything at all.
//
// What it still does, both read-only:
//   1. Names the personal day the Today strip is editing, so "Priorities" is
//      never silently about a different window than the user assumes.
//   2. Prepared Plans — every operational plan record holding real preparation
//      that is NOT reachable through current/upcoming right now, typically
//      because a boundary change moved it out of the horizon. Nothing is copied,
//      moved, merged or deleted; this is a projection over records that already
//      exist, so a prepared plan can never silently vanish from the product.
//
// A legacy account renders nothing and the section stays `hidden`, out of the
// layout, the tab order and the accessibility tree.

import './personal-day-boundary-live.js';
import './plan-authority.js';

const SECTION_ID = 'operational-plan-section';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function authority() {
  return typeof window !== 'undefined' ? window.PlanAuthority : null;
}

function section() {
  return typeof document !== 'undefined' ? document.getElementById(SECTION_ID) : null;
}

/** Display-only instant label for a My Day window. */
function formatBoundaryInstant(instantMs, timezone) {
  // "Fri Sep 18, 6:00 PM" — the owner-facing My Day format, in the day's own zone.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(instantMs)).replace(/^(\w{3}), /, '$1 ');
}

function windowLabel(startMs, endMs, timezone) {
  return `${formatBoundaryInstant(startMs, timezone)} → ${formatBoundaryInstant(endMs, timezone)}`;
}

function statusHtml(current, upcoming) {
  const legacyNote = current.store === 'legacy'
    ? '<div class="op-note">This day began before your personal day boundary took effect, so it is still your existing calendar day. Nothing was regrouped.</div>'
    : '';
  const currentLabel = current.store === 'legacy'
    ? 'today’s calendar day'
    : windowLabel(current.startMs, current.endMs, current.timezone);
  const upcomingLabel = upcoming.store === 'legacy'
    ? 'tomorrow’s calendar day'
    : windowLabel(upcoming.startMs, upcoming.endMs, upcoming.timezone);
  return `<div class="op-section-head"><h2>My Day</h2><span class="op-muted">Starts ${escape(upcoming.boundaryTime)} · ${escape(upcoming.timezone)}</span></div>
    ${legacyNote}
    <div class="op-status-row"><span class="op-kicker">Now</span><span class="op-window">${escape(currentLabel)}</span></div>
    <div class="op-status-row"><span class="op-kicker">Next</span><span class="op-window">${escape(upcomingLabel)}</span></div>
    <p class="op-muted op-footnote">Your priorities below are this personal day. “Prepare tomorrow” plans the next one.</p>`;
}

function preparedPlanHtml(plan) {
  const when = plan.resolvable ? windowLabel(plan.startMs, plan.endMs, plan.timezone) : 'Interval unavailable';
  const items = plan.items.length
    ? plan.items.map(item => `<div class="op-row"><span class="op-row-time">${escape(item.when || '—')}</span><span class="op-row-task">${escape(item.task)}</span></div>`).join('')
    : '<p class="op-muted">Open day — no priorities.</p>';
  const state = plan.past ? 'Already past' : 'Still ahead';
  return `<article class="op-prepared" data-op-prepared="${escape(plan.id)}">
    <div class="op-head"><div class="op-kicker">${escape(state)}</div><div class="op-window">${escape(when)}${plan.timezone ? ` · ${escape(plan.timezone)}` : ''}</div></div>
    ${items}
  </article>`;
}

function preparedPlansHtml(plans) {
  if (!plans.length) return '';
  return `<section class="op-prepared-list" aria-label="Prepared plans">
    <h3>Prepared plans</h3>
    <p class="op-muted">Plans you prepared for personal days that are not your current or next day any more — usually because you changed your boundary. They are kept exactly as you left them.</p>
    ${plans.map(preparedPlanHtml).join('')}
  </section>`;
}

export function renderOperationalPlanSurface() {
  const root = section();
  if (!root) return;
  const layer = authority();
  // The hard legacy gate: an account that never explicitly enabled the feature
  // renders nothing at all.
  if (!layer || !layer.enabled()) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  let current;
  let upcoming;
  let prepared = [];
  try {
    current = layer.current();
    upcoming = layer.upcoming();
    prepared = layer.preparedPlans();
  } catch (err) {
    root.hidden = false;
    root.innerHTML = `<p class="op-muted" role="alert">Your personal day can’t be shown right now. (${escape(err.message)})</p>`;
    return;
  }
  root.hidden = false;
  root.innerHTML = statusHtml(current, upcoming) + preparedPlansHtml(prepared);
}

/** Called by operational-plan-sync.js after a remote merge, by the Settings
 *  panel after a boundary change, and by index.html's 60s tick through
 *  PersonalDayBoundaryLive.tick(). Read-only in every case. */
export function refreshOperationalPlanSurfaceIfMounted() {
  if (!section()) return;
  renderOperationalPlanSurface();
}

if (typeof window !== 'undefined') {
  window.renderOperationalPlanSurface = renderOperationalPlanSurface;
  window.refreshOperationalPlanSurfaceIfMounted = refreshOperationalPlanSurfaceIfMounted;
  renderOperationalPlanSurface();
}
