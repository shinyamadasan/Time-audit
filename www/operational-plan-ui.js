// operational-plan-ui.js
//
// Live Wiring V1 — the smallest real, user-facing planning surface for personal
// days, mounted into `#operational-plan-section` on the Today page.
//
// It shows exactly two panes:
//   - NOW  — the personal day containing this instant. This is the authoritative
//            current plan once a boundary is active (the "Today equivalent").
//   - NEXT — the personal day that begins at the next boundary. This is what the
//            owner prepares in advance at, say, 08:00 for a personal day that
//            starts at 18:00 (the "Tomorrow equivalent").
//
// ── why this is a separate surface, not the Plan Tomorrow overlay ───────────
// plan-tomorrow-ui.js is structurally bound to a bare calendar `targetDate`:
// it feeds that value to daily-routines' generateInstances(), to
// plan-tomorrow-model.js's normalizePreparation()/planningConsistency()
// (Planning-Streak semantics, which hard-require a YYYY-MM-DD), to Daily
// Reconciliation's classifyOneOffActual(), and to index.html's week-key
// arithmetic. An operationalDayId is deliberately NOT a bare date, so feeding
// one through that overlay would require changing Planning Streak, Daily
// Reconciliation and Daily Routines — all explicitly deferred by this
// milestone. This pane is therefore additive: it never modifies, hides or
// competes for those consumers' data, and a legacy account never sees it at
// all.
//
// ── invariants ──────────────────────────────────────────────────────────────
//  - Rendering is a pure read. Nothing here ever creates a boundary revision.
//  - An account that has not explicitly enabled the feature renders NOTHING and
//    the section stays `hidden` (legacy compatibility, spec §9).
//  - Every read and write goes through PersonalDayBoundaryLive, which routes on
//    resolvePlanAuthority() — so a personal day that is still legacy-governed
//    (one occurring before the custom revision's effective instant) correctly
//    reads and writes plans[dateKey], not the operational store.
//  - Removals are tombstones (`deleted: true`), never splices: both stores merge
//    per item id across devices, so a hard delete would be resurrected by the
//    next inbound remote snapshot.

import './personal-day-boundary-live.js';

const SECTION_ID = 'operational-plan-section';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function live() {
  return typeof window !== 'undefined' ? window.PersonalDayBoundaryLive : null;
}

function appContext() {
  if (typeof globalThis.getOperationalPlanAppContext !== 'function') throw new Error('Operational plan app context is not available yet.');
  return globalThis.getOperationalPlanAppContext();
}

function section() {
  return typeof document !== 'undefined' ? document.getElementById(SECTION_ID) : null;
}

/** Display-only: "Wed, Sep 16 · 18:00" for an instant, in the day's own zone. */
function formatBoundaryInstant(instantMs, timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(instantMs)).replace(',', '');
}

function activeItems(items) {
  return items.filter(item => !item.deleted);
}

function itemRowHtml(pane, item) {
  const time = TIME_RE.test(item.when || '') ? item.when : '';
  return `<div class="op-row" data-op-item="${escape(item.id)}">
    <span class="op-row-time">${time ? escape(time) : '—'}</span>
    <span class="op-row-task">${escape(item.task)}</span>
    <label class="op-row-when"><span class="sr-only">Time for ${escape(item.task)}</span>
      <input type="time" data-op-action="set-time" data-op-pane="${escape(pane)}" data-op-id="${escape(item.id)}" value="${escape(time)}" aria-label="Time for ${escape(item.task)}"></label>
    <button type="button" class="plan-remove" data-op-action="remove" data-op-pane="${escape(pane)}" data-op-id="${escape(item.id)}" title="Remove" aria-label="Remove ${escape(item.task)}">✕</button>
  </div>`;
}

function paneHtml(pane, kicker, day, items, maxItems) {
  const active = activeItems(items);
  const window_ = `${formatBoundaryInstant(day.startMs, day.timezone)} → ${formatBoundaryInstant(day.endMs, day.timezone)}`;
  const storeNote = day.authority.store === 'legacy'
    ? '<div class="op-note">This day began before your personal day boundary took effect, so it still uses your existing calendar-day plan. Nothing was regrouped.</div>'
    : '';
  const rows = active.length
    ? active.map(item => itemRowHtml(pane, item)).join('')
    : '<p class="op-muted">Nothing planned yet.</p>';
  const addForm = active.length < maxItems
    ? `<form class="op-add" data-op-form="${escape(pane)}">
        <input type="time" name="when" aria-label="Optional start time">
        <input type="text" name="task" maxlength="80" placeholder="one priority" aria-label="Priority">
        <button class="btn sm" type="submit">Add</button>
      </form>`
    : `<p class="op-muted">${active.length}/${maxItems} priorities. Remove one to add another.</p>`;
  return `<section class="op-pane" data-op-pane-root="${escape(pane)}">
    <div class="op-head"><div class="op-kicker">${escape(kicker)}</div><div class="op-window">${escape(window_)}</div></div>
    ${storeNote}
    ${rows}
    ${addForm}
  </section>`;
}

let lastError = '';

export function renderOperationalPlanSurface() {
  const root = section();
  if (!root) return;
  const wiring = live();
  // The hard legacy gate: an account that never explicitly enabled the feature
  // renders nothing at all and the section stays out of the layout, the tab
  // order and the accessibility tree.
  if (!wiring || !wiring.enabled()) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  let days;
  let context;
  try {
    days = wiring.planningDays();
    context = appContext();
  } catch (err) {
    root.hidden = false;
    root.innerHTML = `<p class="op-muted" role="alert">Your personal day plan can’t be shown right now. (${escape(err.message)})</p>`;
    return;
  }
  let currentItems = [];
  let upcomingItems = [];
  try {
    currentItems = wiring.readPlanItems(days.current);
    upcomingItems = wiring.readPlanItems(days.upcoming);
  } catch (err) {
    root.hidden = false;
    root.innerHTML = `<p class="op-muted" role="alert">Your personal day plan can’t be read right now. (${escape(err.message)})</p>`;
    return;
  }
  root.hidden = false;
  // The current day's own boundary is the honest label for the day in progress —
  // but on a transition day (the boundary was enabled or changed after this day
  // began) it is NOT the boundary the user just chose, which would look like the
  // setting had not applied. Name the upcoming day's boundary too whenever the
  // two differ, so the difference reads as prospective activation rather than a bug.
  const boundaryLabel = days.current.boundaryTime === days.upcoming.boundaryTime
    ? `Starts ${days.current.boundaryTime} · ${days.current.timezone}`
    : `Starts ${days.current.boundaryTime} today · ${days.upcoming.boundaryTime} from the next personal day · ${days.upcoming.timezone}`;
  root.innerHTML = `
    <div class="op-section-head"><h2>Personal day</h2><span class="op-muted">${escape(boundaryLabel)}</span></div>
    ${paneHtml('current', 'Now', days.current, currentItems, context.maxItems)}
    ${paneHtml('upcoming', 'Next', days.upcoming, upcomingItems, context.maxItems)}
    ${lastError ? `<p class="op-error" role="alert">${escape(lastError)}</p>` : ''}
    <p class="op-muted op-footnote">The Today / Tomorrow tabs below still show calendar-day planning, which the rest of the app (Planning Streak, Daily Reconciliation, templates) continues to use.</p>
  `;
}

/** Re-resolves the day this pane names and applies `mutate` to its raw items
 *  (tombstones included), then writes through the authority router. */
function mutatePane(pane, mutate) {
  const wiring = live();
  const days = wiring.planningDays();
  const day = pane === 'current' ? days.current : days.upcoming;
  const items = wiring.readPlanItems(day);
  const next = mutate(items, day);
  wiring.writePlanItems(day, next, days.revisions);
  // Push/attach state may need to follow a rollover that happened while the
  // pane was open.
  wiring.refreshLiveDays();
}

function handleClick(event) {
  const control = event.target.closest('[data-op-action="remove"]');
  if (!control) return;
  const { opPane: pane, opId: id } = control.dataset;
  try {
    lastError = '';
    mutatePane(pane, (items) => items.map(item => (item.id === id ? appContext().stampItem({ ...item, deleted: true }) : item)));
  } catch (err) { lastError = err.message; }
  renderOperationalPlanSurface();
}

function handleChange(event) {
  const control = event.target.closest('[data-op-action="set-time"]');
  if (!control) return;
  const { opPane: pane, opId: id } = control.dataset;
  const when = control.value || '';
  try {
    lastError = '';
    mutatePane(pane, (items) => items.map(item => (item.id === id ? appContext().stampItem({ ...item, when }) : item)));
  } catch (err) { lastError = err.message; }
  renderOperationalPlanSurface();
}

function handleSubmit(event) {
  const form = event.target.closest('[data-op-form]');
  if (!form) return;
  event.preventDefault();
  const pane = form.dataset.opForm;
  const data = new FormData(form);
  const task = String(data.get('task') || '').trim();
  const when = String(data.get('when') || '').trim();
  try {
    lastError = '';
    if (!task) throw new Error('Name the priority first.');
    mutatePane(pane, (items) => {
      const context = appContext();
      if (activeItems(items).length >= context.maxItems) throw new Error(`Reduce this personal day to ${context.maxItems} priorities first.`);
      return [...items, context.createItem(task, TIME_RE.test(when) ? when : '')];
    });
  } catch (err) { lastError = err.message; }
  renderOperationalPlanSurface();
}

/** Called by operational-plan-sync.js after a remote merge, by the Settings
 *  panel after a boundary change, and by index.html's existing 60s Today tick
 *  (so a boundary crossing rotates the panes without any user action). */
export function refreshOperationalPlanSurfaceIfMounted() {
  if (!section()) return;
  renderOperationalPlanSurface();
}

if (typeof window !== 'undefined') {
  const root = section();
  if (root) {
    root.addEventListener('click', handleClick);
    root.addEventListener('change', handleChange);
    root.addEventListener('submit', handleSubmit);
  }
  window.renderOperationalPlanSurface = renderOperationalPlanSurface;
  window.refreshOperationalPlanSurfaceIfMounted = refreshOperationalPlanSurfaceIfMounted;
  renderOperationalPlanSurface();
}
