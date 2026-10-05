// calendar-plan-sync.js
//
// Durable cross-device copy of the calendar-native plan store and of the account's
// calendar-authority activation facts, on top of calendar-plan-repository.js.
// Modeled directly on operational-plan-sync.js (plans: a real Firebase
// `.transaction()` per record with the SAME per-item merge the other plan stores
// get) and plan-by-deadline-sync.js (activation facts: a grow-only set, each fact
// its own child key, one collection listener).
//
// Remote paths (room-scoped children; the existing owner-only `rooms/$roomId` rule
// already covers them — no rules change):
//   rooms/<roomCode>/calendarPlans/<calendarPlanId>        e.g. "cal1:2026-09-27"
//   rooms/<roomCode>/calendarPlanAuthority/<activationId>
// `:` is a legal Realtime Database key character, so the plaintext plan id stays the
// one identity on the wire too (no encoding layer, unlike odv1 ids, which embed "/").
//
// ── account scope (same discipline as operational-plan-sync.js) ──────────────
//   - PUSH is refused ('owner-mismatch', zero writes) unless the joined room equals
//     the repository's active cache owner — re-checked inside the transaction, so an
//     account switch mid-retry aborts with zero writes, and again before the committed
//     result is merged back locally.
//   - PULL: a snapshot is merged only if it came from the room that is joined RIGHT NOW
//     and whose cache is active. Every listener carries the room it was attached for
//     and a token; a detached/superseded or old-room callback is dropped — never merged,
//     never announced.
//   - ATTACH: listeners are bound to one room; attaching while listeners from another
//     room exist (a direct switch, no sign-out between) drops them all first.
//   - HYDRATE: one read of the joined room's calendarPlans, merged record by record
//     under the same room/owner check.

import { createCalendarPlanRepository } from './calendar-plan-repository.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';
import { mergeCalendarPlanRecords, parseCalendarPlanId, validateActivationFact } from './calendar-plan-model.js';

export const CALENDAR_PLANS_REMOTE_PATH = 'calendarPlans';
export const CALENDAR_AUTHORITY_REMOTE_PATH = 'calendarPlanAuthority';

export function createCalendarPlanSyncBridge(deps = {}) {
  const repository = deps.repository || createCalendarPlanRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  const getRoomId = typeof deps.getRoomId === 'function' ? deps.getRoomId : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};

  // Internal subscribers (the live wiring re-derives its listeners when a cutover is heard)
  // run BEFORE the app-level onRemoteChange, so a re-render never sees stale listeners.
  const remoteHandlers = new Set();
  function announce(kind, id, payload) {
    remoteHandlers.forEach(handler => { try { handler(kind, id, payload); } catch { /* one subscriber never blocks the rest */ } });
    onRemoteChange(kind, id, payload);
  }
  /** @param {(kind:'plan'|'activation', id:string|null, payload:*)=>void} handler @returns {()=>void} unsubscribe */
  function onRemote(handler) {
    remoteHandlers.add(handler);
    return () => remoteHandlers.delete(handler);
  }

  const planListeners = new Map(); // planId -> { ref, roomId, token }
  let authorityListener = null; // { ref, roomId, token }
  let authorityHydratedRoomId = null;
  let authorityRemoteRoomId = null;
  let authorityRemoteFacts = null;
  let listenerToken = 0;
  let hydratedRoomId = null;

  function activeRoomId() {
    const roomId = getRoomId();
    return typeof roomId === 'string' && roomId ? roomId : null;
  }

  function cacheOwner() {
    return typeof repository.ownerRoomId === 'function' ? repository.ownerRoomId() : null;
  }

  /** True iff `roomId` is the joined room AND its cache is the active one. Absence of an
   *  owner is never a match: a plain repository cannot prove whose data it holds. */
  function roomOwnsCache(roomId) {
    return !!roomId && roomId === activeRoomId() && cacheOwner() === roomId;
  }

  /** Any listener (plan OR authority) bound to a room other than `roomId` is from a previous
   *  account (a direct switch, no sign-out between): all of them are dropped together. */
  function dropForeignListeners(roomId) {
    const foreign = [...planListeners.values()].some(entry => entry.roomId !== roomId)
      || (authorityListener && authorityListener.roomId !== roomId);
    if (foreign) detachAll();
  }

  // ── plans ───────────────────────────────────────────────────────────────

  /** 'committed' | 'skipped' | 'owner-mismatch' | 'aborted' | 'transport-failure'. */
  function pushPlan(planId) {
    if (!parseCalendarPlanId(planId)) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const roomRef = getRoomRef();
    if (!roomRef) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const roomId = activeRoomId();
    if (!roomOwnsCache(roomId)) return Promise.resolve({ committed: false, outcome: 'owner-mismatch' });
    const local = repository.read(parseCalendarPlanId(planId));
    if (!local) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const candidate = JSON.parse(JSON.stringify(local));
    let planRef;
    try {
      planRef = roomRef.child(CALENDAR_PLANS_REMOTE_PATH).child(planId);
      if (typeof planRef.transaction !== 'function') throw new Error('Firebase plan transactions are unavailable.');
    } catch {
      return Promise.resolve({ committed: false, outcome: 'transport-failure' });
    }
    let ownerLost = false;
    return planRef.transaction(remote => {
      // Firebase may re-run this later against fresh server data. If the account changed in
      // between, abort with zero writes rather than finish a push the cache no longer backs.
      ownerLost = !roomOwnsCache(roomId);
      if (ownerLost) return undefined;
      return mergeCalendarPlanRecords(remote, candidate, planId);
    }, undefined, false)
      .then(result => {
        if (ownerLost) return { committed: false, outcome: 'owner-mismatch' };
        if (!result?.committed || !result.snapshot) return { committed: false, outcome: 'aborted' };
        if (roomOwnsCache(roomId)) {
          const committed = mergeCalendarPlanRecords(null, result.snapshot.val(), planId);
          const { changed, record } = repository.mergeRemote(planId, committed);
          if (changed) announce('plan', planId, record);
        }
        return { committed: true, outcome: 'committed' };
      })
      .catch(() => ({ committed: false, outcome: 'transport-failure' }));
  }

  function syncPlan(planId) {
    return pushPlan(planId).then(result => result.committed);
  }

  /** Merges one inbound snapshot for a single plan. `roomId` is the room the snapshot CAME
   *  FROM; it is applied only if that room is joined now and its cache is active. */
  function handleRemotePlanSnapshot(planId, val, roomId = activeRoomId()) {
    if (!roomOwnsCache(roomId)) return false;
    if (!val) return true;
    const { changed, record } = repository.mergeRemote(planId, val);
    if (changed) announce('plan', planId, record);
    return true;
  }

  function hydrateAll() {
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    if (!roomRef || !roomOwnsCache(roomId) || hydratedRoomId === roomId) return Promise.resolve(false);
    let collectionRef;
    try {
      collectionRef = roomRef.child(CALENDAR_PLANS_REMOTE_PATH);
      if (typeof collectionRef.once !== 'function') return Promise.resolve(false);
    } catch {
      return Promise.resolve(false);
    }
    hydratedRoomId = roomId;
    return Promise.resolve(collectionRef.once('value'))
      .then(snap => {
        const all = snap && typeof snap.val === 'function' ? snap.val() : null;
        if (!all || typeof all !== 'object') return true;
        Object.entries(all).forEach(([id, val]) => {
          if (!parseCalendarPlanId(id) || !val) return;
          try { handleRemotePlanSnapshot(id, val, roomId); } catch { /* one bad record never blocks the rest */ }
        });
        return true;
      })
      .catch(() => { if (hydratedRoomId === roomId) hydratedRoomId = null; return false; });
  }

  function attachPlan(planId) {
    if (!parseCalendarPlanId(planId)) return;
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    if (!roomRef || !roomId) return; // with the room's identity unknown nothing is subscribed
    dropForeignListeners(roomId);
    if (planListeners.has(planId)) return;
    const token = ++listenerToken;
    const ref = roomRef.child(CALENDAR_PLANS_REMOTE_PATH).child(planId);
    planListeners.set(planId, { ref, roomId, token });
    ref.on('value', snap => {
      if (planListeners.get(planId)?.token !== token) return; // detached or superseded
      handleRemotePlanSnapshot(planId, snap.val(), roomId);
    });
  }

  function detachPlan(planId) {
    const entry = planListeners.get(planId);
    if (entry) entry.ref.off();
    planListeners.delete(planId);
  }

  function detachPlans() {
    for (const id of [...planListeners.keys()]) detachPlan(id);
    hydratedRoomId = null; // the next binding hydrates again
  }

  // ── authority activation facts ──────────────────────────────────────────

  function sameActivationFact(a, b) {
    return !!a && !!b
      && a.schemaVersion === b.schemaVersion
      && a.id === b.id
      && a.activatedAtMs === b.activatedAtMs
      && a.timezone === b.timezone
      && a.activationDate === b.activationDate
      && a.deviceId === b.deviceId;
  }

  /** Hydrated set-difference sync for immutable activation facts. Existing remote
   *  children are never submitted again. Each missing fact uses its own create-if-absent
   *  transaction, so one existing/conflicting fact cannot reject an unrelated new fact. */
  function pushActivations() {
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    if (!roomRef) return Promise.resolve({ committed: false, outcome: 'skipped' });
    if (!roomOwnsCache(roomId)) return Promise.resolve({ committed: false, outcome: 'owner-mismatch' });
    if (authorityHydratedRoomId !== roomId || authorityRemoteRoomId !== roomId || !authorityRemoteFacts) {
      return Promise.resolve({ committed: false, outcome: 'hydrating' });
    }
    const local = repository.listAllActivationsRaw();
    if (!local.length) return Promise.resolve({ committed: false, outcome: 'skipped' });
    let collectionRef;
    try {
      collectionRef = roomRef.child(CALENDAR_AUTHORITY_REMOTE_PATH);
      if (typeof collectionRef.child !== 'function') throw new Error('unavailable');
    } catch {
      return Promise.resolve({ committed: false, outcome: 'transport-failure' });
    }
    const conflictIds = [];
    const missing = [];
    local.forEach(fact => {
      const remote = authorityRemoteFacts[fact.id];
      if (remote === undefined) missing.push(fact);
      else if (!sameActivationFact(remote, fact)) conflictIds.push(fact.id);
    });
    if (!missing.length) {
      return Promise.resolve({ committed: false, outcome: conflictIds.length ? 'conflict' : 'skipped', createdIds: [], conflictIds });
    }
    const writes = missing.map(fact => {
      let transactionOutcome = 'committed';
      let factRef;
      try {
        factRef = collectionRef.child(fact.id);
        if (typeof factRef.transaction !== 'function') throw new Error('unavailable');
      } catch {
        return Promise.resolve({ id: fact.id, outcome: 'transport-failure' });
      }
      return Promise.resolve(factRef.transaction(remote => {
        transactionOutcome = 'committed';
        if (!roomOwnsCache(roomId)) { transactionOutcome = 'owner-mismatch'; return undefined; }
        if (remote === null || remote === undefined) return fact;
        transactionOutcome = sameActivationFact(remote, fact) ? 'idempotent' : 'conflict';
        return undefined;
      }, undefined, false))
        .then(result => ({
          id: fact.id,
          outcome: result?.committed ? 'committed' : transactionOutcome,
        }))
        .catch(() => ({ id: fact.id, outcome: 'transport-failure' }));
    });
    return Promise.all(writes).then(results => {
      const createdIds = results.filter(result => result.outcome === 'committed').map(result => result.id);
      results.filter(result => result.outcome === 'conflict').forEach(result => conflictIds.push(result.id));
      const ownerMismatch = results.some(result => result.outcome === 'owner-mismatch');
      const transportFailure = results.some(result => result.outcome === 'transport-failure');
      const outcome = ownerMismatch ? 'owner-mismatch'
        : conflictIds.length ? 'conflict'
          : transportFailure ? 'transport-failure'
            : createdIds.length ? 'committed' : 'skipped';
      return { committed: createdIds.length > 0, outcome, createdIds, conflictIds: [...new Set(conflictIds)].sort() };
    });
  }

  function handleRemoteActivationSnapshot(val, roomId = activeRoomId()) {
    if (!roomOwnsCache(roomId)) return false;
    const empty = val === null || val === undefined;
    if (!empty && (typeof val !== 'object' || Array.isArray(val))) return false;
    const remote = empty ? {} : val;
    const entries = Object.entries(remote);
    const validCount = entries.filter(([id, fact]) => fact?.id === id && validateActivationFact(fact)).length;
    const invalidCount = entries.length - validCount;
    const result = repository.mergeRemoteActivations(remote);
    // Empty is a trustworthy negative. Any valid fact is a trustworthy positive.
    // An invalid-only snapshot proves neither and must stay fail-closed.
    const hydrated = entries.length === 0 || validCount > 0;
    const readinessChanged = hydrated && authorityHydratedRoomId !== roomId;
    if (hydrated) {
      authorityHydratedRoomId = roomId;
      authorityRemoteRoomId = roomId;
      authorityRemoteFacts = { ...remote };
    } else if (authorityHydratedRoomId === roomId || authorityRemoteRoomId === roomId) {
      authorityHydratedRoomId = null;
      authorityRemoteRoomId = null;
      authorityRemoteFacts = null;
    }
    if (result.changed || readinessChanged) announce('activation', null, { ...result, hydrated, invalidCount });
    if (hydrated) {
      Promise.resolve().then(() => pushActivations()).then(syncResult => {
        if (syncResult.createdIds?.length || syncResult.conflictIds?.length) {
          announce('activation', null, { hydrated: true, immutableSync: syncResult });
        }
      });
    }
    return true;
  }

  function authorityHydrationState() {
    const roomId = activeRoomId();
    return roomOwnsCache(roomId) && authorityHydratedRoomId === roomId ? 'hydrated' : 'unknown';
  }

  function attachAuthority() {
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    if (!roomRef || !roomId) return;
    dropForeignListeners(roomId);
    if (authorityListener) return;
    let ref;
    try {
      ref = roomRef.child(CALENDAR_AUTHORITY_REMOTE_PATH);
      if (typeof ref.on !== 'function') return;
    } catch { return; }
    const token = ++listenerToken;
    authorityListener = { ref, roomId, token };
    ref.on('value', snap => {
      if (authorityListener?.token !== token) return; // detached or superseded
      handleRemoteActivationSnapshot(typeof snap.val === 'function' ? snap.val() : null, roomId);
    });
  }

  function detachAuthority() {
    if (authorityListener) authorityListener.ref.off();
    authorityListener = null;
    authorityHydratedRoomId = null;
    authorityRemoteRoomId = null;
    authorityRemoteFacts = null;
  }

  function detachAll() {
    detachPlans();
    detachAuthority();
  }

  return {
    pushPlan, syncPlan, handleRemotePlanSnapshot, hydrateAll, attachPlan, detachPlan, detachPlans,
    pushActivations, handleRemoteActivationSnapshot, attachAuthority, detachAuthority, authorityHydrationState,
    detachAll, onRemote, repository,
  };
}

// A ready-to-use singleton for the real app only — constructing it touches localStorage
// (via the default repository), which does not exist under plain `node --test`. Tests
// build their own bridge with fake deps. The repository's timezone comes from the same
// app context every other plan surface reads, so a reading is always made in the
// account's own zone.
if (typeof window !== 'undefined') {
  const repository = createCalendarPlanRepository({
    getTimezone: () => {
      const context = typeof globalThis.getOperationalPlanAppContext === 'function' ? globalThis.getOperationalPlanAppContext() : null;
      return context?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    },
  });
  window.CalendarPlanSync = createCalendarPlanSyncBridge({
    repository,
    getRoomRef: () => (typeof globalThis.getChronaSenseRoomRef === 'function' ? globalThis.getChronaSenseRoomRef() : null),
    getRoomId: appRoomOwner,
    onRemoteChange: kind => {
      // An inbound remote plan or cutover is an authoritative change like any other: drop the
      // authority layer's derived caches, then re-render every surface that reads it.
      if (window.PlanAuthority) window.PlanAuthority.invalidate();
      if (typeof globalThis.refreshAuthoritativePlanSurfaces === 'function') globalThis.refreshAuthoritativePlanSurfaces();
      if (typeof globalThis.renderCalendarPlanSettings === 'function') globalThis.renderCalendarPlanSettings();
      // An empty first snapshot may be the moment LEGACY becomes trustworthy.
      // Drain preserved legacy offline work only then; CALENDAR/UNKNOWN remain read-only.
      if (kind === 'activation' && window.PlanAuthority?.authorityState?.() === 'legacy') {
        window.PersonalDayBoundaryLive?.pushAllLocal?.();
      }
    },
  });
}
