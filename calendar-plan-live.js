// calendar-plan-live.js
//
// The one seam between the pure calendar-native plan contracts
// (calendar-plan-model.js / -repository.js / -sync.js) and the running app. Everything
// is dependency-injected and side-effect-free until called, so the whole live path
// (activate, route a plan write, attach the right remote listeners, retry after
// reconnect, tear down on sign-out) is unit-testable against in-memory storage and a
// fake room ref.
//
// ── what this module must never do ──────────────────────────────────────────
//  - Activate as a side effect of reading. status()/active()/readRecord() never write.
//    Only activate() — an explicit owner action — appends the cutover fact.
//  - Write to any legacy store. It has no method that touches plans[dateKey] or an
//    operational plan; PlanAuthority routes legacy days to their own stores and calendar
//    days here, never both, never "whichever already has data".
//  - Guess the account. Every cache and listener is bound to the joined room by the
//    repository/sync owner guards.

import { addCalendarDays, localPlanDate } from './plan-tomorrow-model.js';
import { calendarPlanId, parseCalendarPlanId } from './calendar-plan-model.js';
import { createCalendarPlanRepository } from './calendar-plan-repository.js';
// Side-effect import: calendar-plan-sync.js owns the `window.CalendarPlanSync` singleton
// this file's own singleton composes, so its construction order is a module-graph
// guarantee rather than a dependency on <script> order. Inert under `node --test`.
import './calendar-plan-sync.js';

export const CALENDAR_AUTHORITY_STATE = Object.freeze({ UNKNOWN: 'unknown', LEGACY: 'legacy', CALENDAR: 'calendar' });

export function createCalendarPlanLiveWiring(deps = {}) {
  const repository = deps.repository || createCalendarPlanRepository();
  const sync = deps.sync || null;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const deviceId = typeof deps.deviceId === 'function' ? deps.deviceId : () => 'unknown-device';
  const timezone = typeof deps.timezone === 'function' ? deps.timezone : () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
  const onChange = typeof deps.onChange === 'function' ? deps.onChange : () => {};

  let attachedPlanIds = [];

  // A cutover made on ANOTHER device arrives through the account's authority listener:
  // re-derive the plan listeners (and hydrate) at once, so this device starts using the
  // same calendar plans instead of waiting for a reload.
  if (sync && typeof sync.onRemote === 'function') {
    sync.onRemote(kind => { if (kind === 'activation') refreshLive(); });
  }

  // ── authority ─────────────────────────────────────────────────────────────

  function status() {
    return { ...repository.status(), authorityState: authorityState(), ready: authorityReady() };
  }

  /** The account's effective activation, or null. Non-writing. */
  function activation() {
    return repository.activation();
  }

  function active() {
    return authorityState() === CALENDAR_AUTHORITY_STATE.CALENDAR;
  }

  /** UNKNOWN is distinct from LEGACY: only a valid cached cutover or a completed,
   *  trustworthy account snapshot may decide routing. */
  function authorityState() {
    if (activation()) return CALENDAR_AUTHORITY_STATE.CALENDAR;
    const hydrated = sync && typeof sync.authorityHydrationState === 'function'
      ? sync.authorityHydrationState() === 'hydrated'
      : false;
    return hydrated ? CALENDAR_AUTHORITY_STATE.LEGACY : CALENDAR_AUTHORITY_STATE.UNKNOWN;
  }

  function authorityReady() {
    return authorityState() !== CALENDAR_AUTHORITY_STATE.UNKNOWN;
  }

  /** The ONE explicit cutover action. Idempotent for an already-activated account. The
   *  durable copy is pushed through the sync bridge (a no-op offline — pushAllLocal
   *  retries on reconnect). */
  function activate(nowMs = now()) {
    const result = repository.activate({ nowMs, deviceId: deviceId(), timezone: timezone() });
    if (sync) {
      try { sync.pushActivations(); } catch { /* offline — pushAllLocal retries on reconnect */ }
    }
    refreshLive(nowMs);
    onChange();
    return result;
  }

  // ── plan access ───────────────────────────────────────────────────────────

  function readRecord(dateKey) {
    return repository.read(dateKey);
  }

  function listAllRaw() {
    return repository.listAllRaw();
  }

  /** Items only, then pushed. The repository validates + stamps every timed item first;
   *  an invalid item throws and nothing is written. */
  function requireActive() {
    if (!active()) throw new Error('Calendar-day plans are not active for this account, so nothing may be written to them.');
  }

  function writePlanItems(dateKey, items) {
    requireActive();
    repository.write(dateKey, items, { updatedBy: deviceId(), now: now() });
    if (sync) {
      try { sync.syncPlan(calendarPlanId(dateKey)); } catch { /* offline — reconnect re-pushes via pushAllLocal() */ }
    }
  }

  /** Items + a preparation confirmation as ONE write, then pushed. @returns {Promise<boolean>} whether the cloud committed */
  function writePlanWithPreparation(dateKey, items, preparation) {
    requireActive();
    repository.writeWithPreparation(dateKey, items, preparation, { updatedBy: deviceId(), now: now() });
    if (sync) {
      try { return Promise.resolve(sync.syncPlan(calendarPlanId(dateKey))); } catch { /* offline */ }
    }
    return Promise.resolve(false);
  }

  // ── remote listener lifecycle (room join / reconnect / teardown) ──────────

  /** The plans that should have a live listener: today's and tomorrow's, plus every
   *  plan this device already holds for today or later. Bounded by records that exist,
   *  never by a date range (a plan prepared three weeks ahead converges as reliably as
   *  tomorrow's). Past plans are finalized history and need no live listener. Empty
   *  until the account has activated. */
  function liveDateKeys(nowMs = now()) {
    if (!active()) return [];
    const today = localPlanDate(nowMs, timezone());
    const dates = new Set([today, addCalendarDays(today, 1)]);
    for (const id of Object.keys(listAllRaw())) {
      const dateKey = parseCalendarPlanId(id);
      if (dateKey && dateKey >= today) dates.add(dateKey);
    }
    return [...dates].sort();
  }

  /** Attaches the authority listener (always — that is how a device learns a cutover made
   *  elsewhere) and, once activated, the plan listeners + a one-time hydrate. */
  function attachLive(nowMs = now()) {
    if (!sync) return;
    try { sync.attachAuthority(); } catch { /* no room ref yet */ }
    refreshLive(nowMs);
  }

  /** Attaches listeners for the plans that should be live now and detaches the rest
   *  (e.g. after midnight moved "today"). Idempotent. */
  function refreshLive(nowMs = now()) {
    if (!sync) { attachedPlanIds = []; return []; }
    const wanted = liveDateKeys(nowMs).map(calendarPlanId);
    attachedPlanIds.filter(id => !wanted.includes(id)).forEach(id => {
      try { sync.detachPlan(id); } catch { /* already gone */ }
    });
    // Every wanted id, not only newly wanted ones: attachPlan is idempotent for the same
    // room and drops a listener still bound to a previous account's room.
    wanted.forEach(id => {
      try { sync.attachPlan(id); } catch { /* no room ref yet */ }
    });
    attachedPlanIds = wanted;
    if (wanted.length) {
      try { sync.hydrateAll(); } catch { /* no room ref yet */ }
    }
    return wanted;
  }

  /** Time-driven hook for index.html's 60s tick: midnight moves "today" without any user
   *  action, remote write or reconnect, so listeners are re-derived. Never throws. */
  function tick(nowMs = now()) {
    try { refreshLive(nowMs); } catch { /* unreadable state is surfaced by Settings */ }
  }

  /** Reconnect hook: re-push everything remote may be missing — the activation facts and
   *  EVERY plan record held locally (not only today's/tomorrow's, so a plan written for a
   *  far-future date while offline can never remain unsynced forever). Each push is a
   *  transaction that merges against remote, so re-pushing a converged record is a no-op. */
  function pushAllLocal() {
    if (!sync) return;
    try { sync.pushActivations(); } catch { /* offline */ }
    for (const id of Object.keys(listAllRaw())) {
      try { sync.syncPlan(id); } catch { /* offline — retried on the next reconnect */ }
    }
  }

  /** Room switch / sign-out: every listener dropped, in-flight hydration invalidated. */
  function detach() {
    if (sync) { try { sync.detachAll(); } catch { /* nothing attached */ } }
    attachedPlanIds = [];
  }

  return {
    status, activation, active, authorityState, authorityReady, activate,
    readRecord, listAllRaw, writePlanItems, writePlanWithPreparation,
    liveDateKeys, attachLive, refreshLive, tick, pushAllLocal, detach,
    deviceId,
    attachedPlanIds: () => [...attachedPlanIds],
    repository,
  };
}

// ── live singleton (browser only) ───────────────────────────────────────────
//
// Same guard and accessor style as personal-day-boundary-live.js: constructing the
// default repository touches localStorage, which does not exist under plain
// `node --test`, and tests always build their own wiring with fake deps.

function liveAppContext() {
  if (typeof globalThis.getOperationalPlanAppContext !== 'function') throw new Error('Calendar plan app context is not available yet.');
  return globalThis.getOperationalPlanAppContext();
}

if (typeof window !== 'undefined') {
  const sync = window.CalendarPlanSync || null;
  window.CalendarPlanLive = createCalendarPlanLiveWiring({
    repository: sync ? sync.repository : undefined,
    sync,
    deviceId: () => liveAppContext().deviceId,
    timezone: () => liveAppContext().timezone,
    onChange: () => {
      window.PlanAuthority?.invalidate();
      if (typeof globalThis.refreshAuthoritativePlanSurfaces === 'function') globalThis.refreshAuthoritativePlanSurfaces();
      if (typeof globalThis.renderCalendarPlanSettings === 'function') globalThis.renderCalendarPlanSettings();
      if (typeof globalThis.renderPersonalDayBoundarySettings === 'function') globalThis.renderPersonalDayBoundarySettings();
      if (typeof globalThis.refreshPlanningTerminologyLabels === 'function') globalThis.refreshPlanningTerminologyLabels();
    },
  });

  // storage.js joins the account room from onAuthStateChanged and attaches this wiring then —
  // but only `if (globalThis.CalendarPlanLive)`. This module graph is deferred, so on a device
  // where auth resolves first that call found nothing and is never repeated. If the room is
  // ALREADY joined, attach and drain now; both calls are idempotent, so the other ordering
  // (module first, room second) is unaffected (the same fix commitments-sync.js carries).
  if (typeof globalThis.getChronaSenseRoomRef === 'function' && globalThis.getChronaSenseRoomRef()) {
    window.CalendarPlanLive.attachLive();
    window.CalendarPlanLive.pushAllLocal();
  }
}
