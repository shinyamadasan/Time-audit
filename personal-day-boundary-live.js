// personal-day-boundary-live.js
//
// Live Wiring V1 — the one seam between the already-reviewed, pure Personal Day
// Boundary / Operational Plan contracts and the running app.
//
// Everything here is dependency-injected and side-effect-free until called, so
// the whole live path (enable, change, route a plan read/write, attach the
// right remote listeners) is unit-testable against an in-memory storage and an
// in-memory fake room ref — no real Firebase project, ever.
//
// ── what this module is NOT allowed to do ───────────────────────────────────
//
//  - It never reimplements operational-day math. Every instant -> day, day ->
//    interval, next/previous day, and prospective-activation computation comes
//    from personal-day-boundary-model.js. The only local date handling in this
//    file is *display formatting* of an instant the model already produced
//    (relativeDay/clock labels for the "activates at ..." copy required by the
//    milestone spec) — never a second derivation of when a boundary takes
//    effect.
//  - It never infers plan authority from which store happens to hold data.
//    resolvePlanAuthority() decides, always, before a record is read (§10/§11
//    of the operational-plan contract).
//  - It never creates a boundary revision as a side effect of reading. status()
//    and read() are both non-writing; only proposeBoundary() (an explicit user
//    action) ever persists anything (§3/§4).
//  - It never reads, writes, or migrates plans[dateKey] itself. Legacy plan
//    access goes through injected callbacks that are index.html's own existing
//    authoritative functions, so the legacy path is byte-for-byte the code that
//    already ships (§9 legacy compatibility).
//
// ── V1 product decision, enforced here ──────────────────────────────────────
// ENABLE + CHANGE only. There is deliberately no disable/reset-to-legacy
// operation on this module's surface: "turning it off" would be a new revision
// with boundaryTime '00:00', which under the existing contract is still a
// CUSTOM operational boundary, not a return to legacy authority. Offering it
// would be a lie about what the system does, so it is not offered at all.

import {
  activeBoundaryRevision,
  currentOperationalDay,
  isLegacyOperationalDay,
  nextOperationalDay,
  operationalDayInterval,
  proposeBoundaryRevision,
  canonicalizeOperationalDayTimezone,
  validBoundaryTime,
  validOperationalDayTimezone,
} from './personal-day-boundary-model.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { resolvePlanAuthority } from './operational-plan-model.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
// Side-effect imports: these two modules own the `window.PersonalDayBoundarySync`
// / `window.OperationalPlanSync` singletons this file's own singleton composes.
// Importing them here makes that ordering a module-graph guarantee rather than a
// fragile dependency on <script> tag order in index.html. Under `node --test`
// both singleton blocks are inert (they are `typeof window !== 'undefined'`
// guarded), so this costs test runs nothing.
import './personal-day-boundary-sync.js';
import './operational-plan-sync.js';

const PREVIEW_REVISION_ID = 'preview-candidate';

/** Display-only: the calendar date (YYYY-MM-DD) an instant falls on in a zone. */
function calendarDate(instantMs, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(instantMs));
}

/** Display-only: the next calendar date after a YYYY-MM-DD string. Used purely
 *  to decide whether the model's own effectiveFromInstant reads as "today" or
 *  "tomorrow" to the user — never to compute the instant itself. */
function nextCalendarDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Display-only: a human "Wednesday, September 16" for a YYYY-MM-DD. Formatted
 *  at noon UTC so the weekday can never slip a day at a DST edge — the same
 *  idiom plan-tomorrow-ui.js and tomorrow-view-ui.js already use. */
export function formatCalendarDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/** "20:00 today" / "20:00 tomorrow" / "20:00 on Friday, September 18" for an
 *  instant the MODEL produced. `boundaryTime` is the revision's own stored
 *  clock time, so this never re-derives a wall-clock reading either. */
export function describeActivationInstant(effectiveFromInstant, boundaryTime, timezone, nowMs) {
  const nowDate = calendarDate(nowMs, timezone);
  const effectiveDate = calendarDate(effectiveFromInstant, timezone);
  if (effectiveDate === nowDate) return `${boundaryTime} today`;
  if (effectiveDate === nextCalendarDate(nowDate)) return `${boundaryTime} tomorrow`;
  return `${boundaryTime} on ${formatCalendarDate(effectiveDate)}`;
}

export function createPersonalDayBoundaryLiveWiring(deps = {}) {
  const boundaryRepository = deps.boundaryRepository || createPersonalDayBoundaryRepository();
  const planRepository = deps.planRepository || createOperationalPlanRepository();
  const boundarySync = deps.boundarySync || null;
  const planSync = deps.planSync || null;
  const legacyPlans = deps.legacyPlans || null;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const deviceId = typeof deps.deviceId === 'function' ? deps.deviceId : () => 'unknown-device';
  const fallbackTimezone = typeof deps.fallbackTimezone === 'function'
    ? deps.fallbackTimezone
    : () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
  const onChange = typeof deps.onChange === 'function' ? deps.onChange : () => {};

  // Operational days this device currently has a live remote listener on. Only
  // the current + upcoming day are ever attached — never a firehose over every
  // operational day that has ever existed (see operational-plan-sync.js).
  let attachedDayIds = [];

  /** Never throws. 'absent' = pure legacy user (the hard gate for §9);
   *  'custom' = a persisted history exists; 'invalid' = something is persisted
   *  and is broken — fail closed, never silently reinterpreted as legacy. */
  function status() {
    return boundaryRepository.status();
  }

  function enabled() {
    return status().status === 'custom';
  }

  /** The revision history to hand the pure model. For an absent user this is a
   *  single ephemeral legacy anchor that is NEVER written back. */
  function revisions() {
    return boundaryRepository.read(fallbackTimezone());
  }

  /** What the Settings UI needs to state the truth: the revision governing
   *  `nowMs` right now, plus any already-created revision that has not taken
   *  effect yet (a pending change the user must not be surprised by). */
  function boundaryState(nowMs = now()) {
    const current = status();
    if (current.status !== 'custom') return { status: current.status, active: null, pending: null, error: current.error || null };
    const history = current.revisions;
    const active = activeBoundaryRevision(history, nowMs);
    const pending = history.filter(r => r.effectiveFromInstant !== null && r.effectiveFromInstant > nowMs)
      .sort((a, b) => a.effectiveFromInstant - b.effectiveFromInstant)[0] || null;
    return { status: 'custom', active, pending, error: null };
  }

  /** Dry-run of proposeBoundary: computes the SAME effectiveFromInstant the
   *  real proposal would (via the model's own proposeBoundaryRevision /
   *  nextBoundaryInstant) without persisting or pushing anything, so the UI can
   *  show "activates at 20:00 today" before the user commits. */
  function previewProposal(candidate, nowMs = now()) {
    if (!candidate || !validBoundaryTime(candidate.boundaryTime)) return { ok: false, reason: 'invalid-time' };
    if (!validOperationalDayTimezone(candidate.timezone)) return { ok: false, reason: 'invalid-timezone' };
    let timezone;
    try {
      timezone = canonicalizeOperationalDayTimezone(candidate.timezone);
    } catch {
      return { ok: false, reason: 'invalid-timezone' };
    }
    let history;
    try {
      history = revisions();
    } catch (err) {
      return { ok: false, reason: 'invalid-history', error: err.message };
    }
    let proposed;
    try {
      proposed = proposeBoundaryRevision(history, { id: PREVIEW_REVISION_ID, boundaryTime: candidate.boundaryTime, timezone }, nowMs);
    } catch (err) {
      return { ok: false, reason: 'rejected', error: err.message };
    }
    const active = activeBoundaryRevision(history, nowMs);
    const pending = history.filter(r => r.effectiveFromInstant !== null && r.effectiveFromInstant > nowMs).length > 0;
    const effectiveFromInstant = proposed.revision.effectiveFromInstant;
    return {
      ok: true,
      boundaryTime: candidate.boundaryTime,
      timezone,
      effectiveFromInstant,
      activationLabel: describeActivationInstant(effectiveFromInstant, candidate.boundaryTime, timezone, nowMs),
      // "Nothing would change" is a UI convenience only — the repository stays
      // free of this policy, and a user who insists is never blocked by it.
      unchanged: !pending && status().status === 'custom'
        && active.boundaryTime === candidate.boundaryTime && active.timezone === timezone
    };
  }

  /** The ONE explicit opt-in / change action. On a first-ever call the
   *  repository creates the legacy anchor and this candidate as one atomic
   *  write; on every later call it appends one more immutable revision. The
   *  durable remote copy is pushed through the existing sync bridge (a no-op
   *  offline — pushAllLocal retries on reconnect). */
  function proposeBoundary(candidate, nowMs = now()) {
    if (!candidate || !validBoundaryTime(candidate.boundaryTime)) throw new Error('Choose a valid personal day start time (HH:MM).');
    if (!validOperationalDayTimezone(candidate.timezone)) throw new Error('Choose a valid personal day timezone.');
    const result = boundaryRepository.propose({ boundaryTime: candidate.boundaryTime, timezone: candidate.timezone }, nowMs);
    if (boundarySync) {
      try { boundarySync.pushAllLocal(); } catch { /* offline / no room — pushAllLocal retries on reconnect */ }
    }
    refreshLiveDays(nowMs);
    onChange();
    return result;
  }

  // ── plan authority routing ────────────────────────────────────────────────

  function describeDay(ref, history) {
    const authority = resolvePlanAuthority(ref, history);
    const interval = operationalDayInterval(ref, history);
    return {
      ref,
      authority,
      legacy: authority.store === 'legacy',
      startMs: interval.startMs,
      endMs: interval.endMs,
      boundaryTime: activeBoundaryRevision(history, interval.startMs).boundaryTime,
      timezone: ref.timezone,
    };
  }

  /** The current personal day (the one containing `nowMs` — the "Today
   *  equivalent") and the upcoming one that begins at the next boundary (the
   *  "Tomorrow equivalent" the owner prepares in advance).
   *
   *  Both are re-resolved from instants against the FULL history, so a day that
   *  occurs before a custom revision's effectiveFromInstant is still correctly
   *  legacy-governed even for a user who has already enabled the feature — the
   *  no-retroactive-reinterpretation rule. That is exactly why each day's
   *  authority is resolved individually rather than once per user. */
  function planningDays(nowMs = now()) {
    const history = revisions();
    const currentRef = currentOperationalDay(nowMs, history);
    const upcomingRef = nextOperationalDay(currentRef, history);
    return {
      revisions: history,
      current: describeDay(currentRef, history),
      upcoming: describeDay(upcomingRef, history),
    };
  }

  /** True iff this day is governed by the null-effectiveFromInstant anchor —
   *  the contract's definition of legacy, exposed for assertions/tests. */
  function dayIsLegacy(ref, history) {
    return isLegacyOperationalDay(ref, history);
  }

  function readPlanItems(day) {
    if (day.authority.store === 'legacy') {
      if (!legacyPlans) throw new Error('Legacy plan access is not wired.');
      return legacyPlans.readItems(day.authority.dateKey);
    }
    const record = planRepository.read(day.authority.operationalDayId);
    return Array.isArray(record?.items) ? record.items : [];
  }

  /** Writes through whichever store resolvePlanAuthority named for THIS day —
   *  never both, never "whichever already has data". The operational path hands
   *  the repository the day's own ref + governing revisions so every timed item
   *  is range-validated against that operational day's real interval before
   *  anything is persisted. */
  function writePlanItems(day, items, history) {
    if (day.authority.store === 'legacy') {
      if (!legacyPlans) throw new Error('Legacy plan access is not wired.');
      legacyPlans.saveItems(day.authority.dateKey, items);
      return { store: 'legacy', dateKey: day.authority.dateKey };
    }
    const id = day.authority.operationalDayId;
    planRepository.write(id, items, { updatedBy: deviceId(), now: now(), ref: day.ref, revisions: history });
    if (planSync) {
      try { planSync.syncDay(id); } catch { /* offline — reconnect re-pushes via syncLiveDays() */ }
    }
    return { store: 'operational', operationalDayId: id };
  }

  // ── remote listener lifecycle (room join / reconnect / teardown) ───────────

  /** The operational day ids that should have a live listener right now: the
   *  current and upcoming days, and only when each is operational-governed.
   *  Returns [] for a legacy/absent user, so nothing is ever attached for an
   *  account that never enabled the feature. */
  function liveDayIds(nowMs = now()) {
    if (!enabled()) return [];
    let days;
    try { days = planningDays(nowMs); } catch { return []; }
    return [days.current, days.upcoming]
      .filter(day => day.authority.store === 'operational')
      .map(day => day.authority.operationalDayId);
  }

  function attachLiveDays(nowMs = now()) {
    if (boundarySync) { try { boundarySync.attach(); } catch { /* no room ref yet */ } }
    refreshLiveDays(nowMs);
  }

  /** Attaches listeners for the days that should be live now and detaches any
   *  that no longer should be (e.g. after a boundary rollover or a boundary
   *  change moved the upcoming day's identity). Idempotent. */
  function refreshLiveDays(nowMs = now()) {
    if (!planSync) { attachedDayIds = []; return []; }
    const wanted = liveDayIds(nowMs);
    attachedDayIds.filter(id => !wanted.includes(id)).forEach(id => {
      try { planSync.detachDay(id); } catch { /* already gone */ }
    });
    wanted.filter(id => !attachedDayIds.includes(id)).forEach(id => {
      try { planSync.attachDay(id); } catch { /* no room ref yet */ }
    });
    attachedDayIds = wanted;
    return wanted;
  }

  /** Reconnect hook: re-push anything this device holds that remote may be
   *  missing. Boundary revisions push as a set; plans push per live day. */
  function pushAllLocal(nowMs = now()) {
    if (boundarySync) { try { boundarySync.pushAllLocal(); } catch { /* offline */ } }
    if (planSync) {
      liveDayIds(nowMs).forEach(id => {
        try { planSync.syncDay(id); } catch { /* offline */ }
      });
    }
  }

  function detach() {
    if (planSync) {
      attachedDayIds.forEach(id => {
        try { planSync.detachDay(id); } catch { /* already gone */ }
      });
    }
    attachedDayIds = [];
    if (boundarySync) { try { boundarySync.detach(); } catch { /* nothing attached */ } }
  }

  return {
    status,
    enabled,
    revisions,
    boundaryState,
    previewProposal,
    proposeBoundary,
    planningDays,
    dayIsLegacy,
    readPlanItems,
    writePlanItems,
    liveDayIds,
    attachLiveDays,
    refreshLiveDays,
    pushAllLocal,
    detach,
    attachedDayIds: () => [...attachedDayIds],
    boundaryRepository,
    planRepository,
  };
}

// ── live singleton (browser only) ───────────────────────────────────────────
//
// Guarded exactly like coarse-life-evidence-sync.js's: constructing the default
// repositories touches localStorage, which does not exist under plain
// `node --test`. Tests always build their own wiring with
// createPersonalDayBoundaryLiveWiring(fakeDeps).
//
// `getOperationalPlanAppContext` is a NEW, separate accessor defined by
// index.html. It deliberately does not extend the existing
// getPlanTomorrowAppContext, so nothing this milestone adds can change what the
// already-shipping legacy Plan Tomorrow / Tomorrow View consumers read.

function liveAppContext() {
  if (typeof globalThis.getOperationalPlanAppContext !== 'function') throw new Error('Operational plan app context is not available yet.');
  return globalThis.getOperationalPlanAppContext();
}

if (typeof window !== 'undefined') {
  window.PersonalDayBoundaryLive = createPersonalDayBoundaryLiveWiring({
    boundarySync: window.PersonalDayBoundarySync || null,
    planSync: window.OperationalPlanSync || null,
    deviceId: () => liveAppContext().deviceId,
    fallbackTimezone: () => liveAppContext().timezone,
    legacyPlans: {
      readItems: dateKey => liveAppContext().rawItems(dateKey),
      saveItems: (dateKey, items) => liveAppContext().saveItems(dateKey, items),
    },
    onChange: () => {
      if (typeof window.renderPersonalDayBoundarySettings === 'function') window.renderPersonalDayBoundarySettings();
      if (typeof window.refreshOperationalPlanSurfaceIfMounted === 'function') window.refreshOperationalPlanSurfaceIfMounted();
    },
  });

  // Called by personal-day-boundary-sync.js when a REMOTE revision change lands:
  // the set of operational days in live use may have moved with it.
  window.refreshPersonalDayBoundaryLive = () => {
    try { window.PersonalDayBoundaryLive.refreshLiveDays(); } catch { /* invalid history — surfaced by the Settings panel */ }
    if (typeof window.renderPersonalDayBoundarySettings === 'function') window.renderPersonalDayBoundarySettings();
    if (typeof window.refreshOperationalPlanSurfaceIfMounted === 'function') window.refreshOperationalPlanSurfaceIfMounted();
  };
}
