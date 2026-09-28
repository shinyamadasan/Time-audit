// calendar-plan-ui.js
//
// Calendar-Native Plan Identity V1 — the owner-facing side of the cutover:
//   1. Settings "Plan day": states which model this account plans on, and offers the
//      one explicit, one-way switch to calendar-day plans.
//   2. A compact Today card (`#calendar-plan-section`) that
//        - BEFORE the switch, shown only to an account that has a Personal Day boundary
//          (the only accounts whose "today" can disagree with the calendar), offers the
//          same switch where the confusion is felt;
//        - AFTER the switch, lists the older plans the switch left as they were
//          (read-only, never copied or rewritten) that still hold open work, so
//          nothing prepared before it silently vanishes. Their unfinished tasks
//          move through the ordinary "Unfinished from previous days" flow; once a
//          plan has nothing open left it is ordinary history and drops off Today.
//
// ── what this file must never do ────────────────────────────────────────────
//  - Activate by rendering. The switch is an explicit button press with a second
//    confirmation; rendering only reads.
//  - Move, copy, merge or delete any legacy plan. Older plans are a projection.
//  - Decide which store is authoritative. That is PlanAuthority's answer alone.

import './plan-authority.js';
import { formatCalendarDate } from './personal-day-boundary-live.js';

const SETTINGS_ID = 'calendar-plan-settings';
const CARD_ID = 'calendar-plan-section';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

let confirming = false;
let message = '';

function authority() {
  return typeof window !== 'undefined' ? window.PlanAuthority : null;
}

function el(id) {
  return typeof document !== 'undefined' ? document.getElementById(id) : null;
}

function formatInstant(instantMs, timezone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .format(new Date(instantMs)).replace(/^(\w{3}), /, '$1 ');
}

function confirmHtml() {
  return `<div class="cp-confirm" role="group" aria-label="Confirm switching to calendar-day plans">
    <p class="cp-body">From now on, <strong>today's plan is today's date</strong> — Sunday's plan is Sunday's, and it can run past midnight without becoming Monday's. This applies to all your devices and can't be switched back.</p>
    <p class="cp-body">Plans you already made under a Personal Day stay exactly as they are (read-only). You can move their unfinished tasks into today's plan.</p>
    <div class="cp-actions">
      <button type="button" class="btn sm" data-cp-action="confirm">Switch to calendar-day plans</button>
      <button type="button" class="btn sm ghost" data-cp-action="cancel">Not now</button>
    </div>
  </div>`;
}

function settingsHtml(layer) {
  const activation = layer.calendarActivation();
  if (activation) {
    const legacy = layer.boundaryEnabled()
      ? '<p class="cp-body cp-muted">The Personal day boundary below is legacy: it no longer decides which plan is current, what "tomorrow" is, or your planning streak. It only describes plans made before you switched.</p>'
      : '';
    return `<div class="settings-hint" data-cp-state="active">Plans follow calendar dates (since ${escape(formatCalendarDate(activation.activationDate))}). Sunday's plan is Sunday's and can continue past midnight.</div>${legacy}`;
  }
  const lead = layer.boundaryEnabled()
    ? 'Your plans currently follow a Personal Day window, so "today\'s plan" can be a different day than the calendar says.'
    : 'Your plans already follow the calendar date. Switching adds plans that can run past midnight.';
  return `<div class="settings-hint" data-cp-state="inactive">${escape(lead)}</div>
    ${confirming ? confirmHtml() : '<div style="margin-top:8px"><button type="button" class="btn sm" data-cp-action="ask">Use calendar-day plans</button></div>'}
    ${message ? `<div class="settings-hint" role="alert">${escape(message)}</div>` : ''}`;
}

function olderPlanHtml(plan) {
  const label = plan.store === 'operational' && plan.resolvable
    ? `${formatInstant(plan.startMs, plan.timezone)} → ${formatInstant(plan.endMs, plan.timezone)}`
    : plan.dateKey ? formatCalendarDate(plan.dateKey) : 'Older plan';
  const rows = plan.items.length
    ? plan.items.map(item => `<div class="op-row"><span class="op-row-time">${escape(item.when || '—')}</span><span class="op-row-task">${escape(item.task)}</span>${item.done ? '<span class="op-row-done"> ✓</span>' : ''}${item.movedTo ? '<span class="op-row-done"> → moved to a calendar plan</span>' : ''}</div>`).join('')
    : '<p class="op-muted">Open day — no priorities.</p>';
  return `<article class="op-prepared" data-cp-older="${escape(plan.id)}">
    <div class="op-head"><div class="op-kicker">Made before you switched</div><div class="op-window">${escape(label)}</div></div>
    ${rows}
  </article>`;
}

function cardHtml(layer) {
  if (!layer.calendarActive()) {
    if (!layer.boundaryEnabled()) return '';
    const lead = 'Your plans follow a Personal Day window. Switch to calendar-day plans so today\'s plan is today\'s date.';
    return `<div class="cp-card" data-cp-state="prompt"><p class="cp-body">${escape(lead)}</p>
      ${confirming ? confirmHtml() : '<button type="button" class="btn sm" data-cp-action="ask">Use calendar-day plans</button>'}
      ${message ? `<p class="cp-body" role="alert">${escape(message)}</p>` : ''}</div>`;
  }
  // Shown only while a legacy plan still holds open work that has not been moved: once every task
  // is done or has moved into a calendar plan, the plan is ordinary history (still stored, still
  // readable) and Today stops carrying it.
  const older = layer.supersededPlans().filter(plan => plan.items.some(item => !item.done && !item.movedTo));
  if (!older.length) return '';
  return `<section class="op-prepared-list" aria-label="Older plans">
    <h3>Older plans</h3>
    <p class="op-muted">Plans you made under your Personal Day before switching. They are kept exactly as you left them; move any unfinished task into today's plan from "Unfinished from previous days".</p>
    ${older.map(olderPlanHtml).join('')}
  </section>`;
}

export function renderCalendarPlanSettings() {
  const root = el(SETTINGS_ID);
  const layer = authority();
  if (!root || !layer) return;
  root.innerHTML = settingsHtml(layer);
}

export function renderCalendarPlanCard() {
  const root = el(CARD_ID);
  const layer = authority();
  if (!root || !layer) return;
  let html = '';
  try { html = cardHtml(layer); } catch (err) { html = `<p class="op-muted" role="alert">Your older plans can’t be shown right now. (${escape(err.message)})</p>`; }
  root.hidden = !html;
  root.innerHTML = html;
}

export function renderCalendarPlanSurfaces() {
  renderCalendarPlanSettings();
  renderCalendarPlanCard();
}

function onClick(event) {
  const control = event.target.closest('[data-cp-action]');
  const layer = authority();
  if (!control || !layer) return;
  const action = control.dataset.cpAction;
  if (action === 'ask') { confirming = true; message = ''; }
  else if (action === 'cancel') { confirming = false; message = ''; }
  else if (action === 'confirm') {
    try {
      layer.activateCalendar();
      confirming = false;
      message = '';
    } catch (err) {
      message = err.message || 'Could not switch right now.';
    }
    globalThis.refreshAuthoritativePlanSurfaces?.();
  }
  renderCalendarPlanSurfaces();
}

if (typeof window !== 'undefined') {
  window.renderCalendarPlanSettings = renderCalendarPlanSettings;
  window.renderCalendarPlanSurfaces = renderCalendarPlanSurfaces;
  for (const id of [SETTINGS_ID, CARD_ID]) el(id)?.addEventListener('click', onClick);
  renderCalendarPlanSurfaces();
}
