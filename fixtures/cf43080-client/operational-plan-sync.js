// operational-plan-sync.js
//
// Durable cross-device copy of the operational-day-keyed plan store, on top of
// operational-plan-repository.js. Mirrors storage.js's existing `syncPlans()`
// for the legacy `plans[dateKey]` store as closely as possible — a real
// Firebase RTDB `.transaction()` per record, with `mergeOperationalPlanRecords`
// (the operational-day-aware sibling of PlanTomorrowModel.mergeDatePlans) as
// the transaction's update function — because operational plan items need the
// exact same concurrency-safe per-item merge legacy plan items already get,
// not a weaker one just because the store is new.
//
// Remote path: `rooms/<roomCode>/operationalPlans/<operationalDayId>` — a NEW
// room-scoped child, already covered by the existing wide-open `rooms/$roomId`
// rule in firebase.rules.json (no rules change needed).
//
// Live Wiring V1 creates a `window.OperationalPlanSync` singleton at the bottom
// of this file, guarded for the browser only — see that block.
//
// ── account scope (Operational Plan Cross-Account Isolation V1) ─────────────
//
// The local cache belongs to ONE account (operational-plan-repository.js keeps a
// slot per room). Previously this bridge pushed whatever the single unscoped
// cache held into whatever room was joined, so after a direct A -> B account
// switch, A's plans were transacted into B's room. This bridge is the only thing
// that moves plans between the cache and a room, so it enforces the pairing
// itself, the same way personal-day-boundary-sync.js does:
//   - PUSH: refused ('owner-mismatch', zero writes) unless the joined room
//     (`getRoomId()`) equals the repository's active cache owner. Re-checked
//     inside the transaction, so a switch mid-retry aborts with zero writes, and
//     again before the committed result is merged back locally.
//   - PULL: a snapshot is merged only if it came from the room that is joined
//     RIGHT NOW and whose cache is active. Each listener carries the room it was
//     attached for and a token; a detached/superseded or old-room callback is
//     dropped, never merged, never announced.
//   - ATTACH: listeners are bound to one room. Attaching while listeners from a
//     different room exist (a direct switch, no sign-out between) drops them all
//     first; attachDay for an id already attached for another room rebinds it.
//   - HYDRATE: hydrateAll() reads the joined room's own operationalPlans once and
//     merges it into that room's scoped slot (so history not covered by a per-day
//     listener — past days, far-future prepared days — is not lost locally when
//     the slot is new). Same room/owner guard as PULL.

import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';
import { mergeOperationalPlanRecords } from './operational-plan-model.js';
import { parseOperationalDayId } from './personal-day-boundary-model.js';

export const OPERATIONAL_PLANS_REMOTE_PATH = 'operationalPlans';

// Firebase Realtime Database keys may not contain '.', '#', '$', '[', ']', or
// '/' — and a bare operationalDayId ALWAYS contains at least one '/', because
// it embeds a canonical IANA timezone name (e.g. "Asia/Manila",
// "America/New_York"). Passing operationalDayId to `.child()` unencoded would
// silently be treated as a multi-segment path by the SDK, not one atomic key
// — the exact "competing truth by accident" this whole phase exists to avoid.
// base64url is a lossless, deterministic, reversible encoding using only
// Firebase-safe characters, so the plaintext operationalDayId stays the one
// authoritative identity everywhere else (repository keys, ref comparisons,
// this bridge's own public API) and only the wire-level Firebase key differs.
export function toFirebaseSafeKey(operationalDayIdValue) {
  return btoa(operationalDayIdValue).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of toFirebaseSafeKey — maps an unknown remote key back to its
 *  operationalDayId (used by hydrateAll's one-time subtree read); the per-day
 *  methods never need it, since callers always supply the id they already know. */
export function fromFirebaseSafeKey(key) {
  const padded = key.replace(/-/g, '+').replace(/_/g, '/').padEnd(key.length + ((4 - (key.length % 4)) % 4), '=');
  return atob(padded);
}

export function createOperationalPlanSyncBridge(deps = {}) {
  const repository = deps.repository || createOperationalPlanRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  // The joined room's identity, independent of whether its ref is reachable right now.
  const getRoomId = typeof deps.getRoomId === 'function' ? deps.getRoomId : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};

  const listeners = new Map(); // operationalDayId -> { ref, roomId, token }, for attachDay/detachDay
  let listenerToken = 0;
  let hydratedRoomId = null;

  function activeRoomId() {
    const roomId = getRoomId();
    return typeof roomId === 'string' && roomId ? roomId : null;
  }

  /** Whose cache is active in the repository (null for a plain/unscoped repository). */
  function cacheOwner() {
    return typeof repository.ownerRoomId === 'function' ? repository.ownerRoomId() : null;
  }

  /** True iff `roomId` is the joined room AND its cache is the active one. Absence of
   *  an owner is never a match: a plain repository cannot prove whose data it holds. */
  function roomOwnsCache(roomId) {
    return !!roomId && roomId === activeRoomId() && cacheOwner() === roomId;
  }

  /** Pushes one operational day and reports what happened:
   *  'committed' | 'skipped' (nothing local / no room ref / invalid id) |
   *  'owner-mismatch' (cache not the joined room's — zero writes) |
   *  'aborted' (transaction not committed) | 'transport-failure'. */
  function pushDay(operationalDayIdValue) {
    if (!parseOperationalDayId(operationalDayIdValue)) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const roomRef = getRoomRef();
    if (!roomRef) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const roomId = activeRoomId();
    if (!roomOwnsCache(roomId)) return Promise.resolve({ committed: false, outcome: 'owner-mismatch' });
    const local = repository.read(operationalDayIdValue);
    if (!local) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const candidate = JSON.parse(JSON.stringify(local));
    let dayRef;
    try {
      dayRef = roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(operationalDayIdValue));
      if (typeof dayRef.transaction !== 'function') throw new Error('Firebase plan transactions are unavailable.');
    } catch {
      return Promise.resolve({ committed: false, outcome: 'transport-failure' });
    }
    let ownerLost = false;
    return dayRef.transaction(remote => {
      // Firebase may re-run this later against fresh server data. If the account changed in
      // between, abort with zero writes rather than finish a push the cache no longer backs.
      ownerLost = !roomOwnsCache(roomId);
      if (ownerLost) return undefined;
      return mergeOperationalPlanRecords(remote, candidate, operationalDayIdValue);
    }, undefined, false)
      .then(result => {
        if (ownerLost) return { committed: false, outcome: 'owner-mismatch' };
        if (!result?.committed || !result.snapshot) return { committed: false, outcome: 'aborted' };
        // The committed room value is merged back only into THAT room's cache, and only while it is active.
        if (roomOwnsCache(roomId)) {
          const committed = mergeOperationalPlanRecords(null, result.snapshot.val(), operationalDayIdValue);
          const { changed, record } = repository.mergeRemote(operationalDayIdValue, committed);
          if (changed) onRemoteChange(operationalDayIdValue, record);
        }
        return { committed: true, outcome: 'committed' };
      })
      .catch(() => ({ committed: false, outcome: 'transport-failure' }));
  }

  /** Pushes local changes for ONE operational day via a real Firebase
   *  transaction, exactly like storage.js's syncPlans(dateKey) does for the
   *  legacy store: the transaction's update function merges the server's
   *  current value with the local candidate via mergeOperationalPlanRecords,
   *  so two devices writing concurrently to the same operational day converge
   *  by per-item merge, never by whichever `update()` call happened to land
   *  last (contract §5/§21 — operational plans get the SAME safety legacy
   *  plans already have, not a weaker one). Resolves true iff committed; see
   *  pushDay for the outcome (including the owner-mismatch refusal).
   *  @param {string} operationalDayIdValue */
  function syncDay(operationalDayIdValue) {
    return pushDay(operationalDayIdValue).then(result => result.committed);
  }

  /** Merges one inbound remote snapshot for a single operational day — the
   *  listener-side counterpart to syncDay's push side. Record-level merge only
   *  via repository.mergeRemote, never a store-wide replace. `roomId` is the room
   *  the snapshot CAME FROM; it is applied only if that room is joined now and
   *  its cache is active. Returns whether it was applied. */
  function handleRemoteDaySnapshot(operationalDayIdValue, val, roomId = activeRoomId()) {
    if (!roomOwnsCache(roomId)) return false;
    if (!val) return true;
    const { changed, record } = repository.mergeRemote(operationalDayIdValue, val);
    if (changed) onRemoteChange(operationalDayIdValue, record);
    return true;
  }

  /** One read of the joined room's whole operationalPlans subtree, merged record by
   *  record into that room's scoped cache. Once per room binding; a no-op when the
   *  SDK ref has no once() or the room/owner does not match. Never pushes. */
  function hydrateAll() {
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    if (!roomRef || !roomOwnsCache(roomId) || hydratedRoomId === roomId) return Promise.resolve(false);
    let collectionRef;
    try {
      collectionRef = roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH);
      if (typeof collectionRef.once !== 'function') return Promise.resolve(false);
    } catch {
      return Promise.resolve(false);
    }
    hydratedRoomId = roomId;
    return Promise.resolve(collectionRef.once('value'))
      .then(snap => {
        // Each record goes through handleRemoteDaySnapshot's own room/owner check, so a read that
        // resolves after a switch or sign-out merges nothing.
        const all = snap && typeof snap.val === 'function' ? snap.val() : null;
        if (!all || typeof all !== 'object') return true;
        Object.entries(all).forEach(([key, val]) => {
          let id;
          try { id = fromFirebaseSafeKey(key); } catch { return; }
          if (!parseOperationalDayId(id) || !val) return;
          try { handleRemoteDaySnapshot(id, val, roomId); } catch { /* one bad record never blocks the rest */ }
        });
        return true;
      })
      .catch(() => { if (hydratedRoomId === roomId) hydratedRoomId = null; return false; });
  }

  /** Attaches a live listener for ONE operational day. Unlike the legacy store
   *  (which listens to the whole `plans/` subtree at once because the set of
   *  live dates is small and bounded to "recent"), operational days are opened
   *  individually by whatever UI phase eventually adopts this store — so this
   *  bridge is deliberately per-day, not a firehose over every operational day
   *  that has ever existed. */
  function attachDay(operationalDayIdValue) {
    if (!parseOperationalDayId(operationalDayIdValue)) return;
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    // With the room's identity unknown nothing is subscribed: whose cache a snapshot
    // would populate could not be said.
    if (!roomRef || !roomId) return;
    // Listeners from another room (a direct account switch) are all dropped first.
    if ([...listeners.values()].some(entry => entry.roomId !== roomId)) detachAll();
    if (listeners.has(operationalDayIdValue)) return;
    const token = ++listenerToken;
    const ref = roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(operationalDayIdValue));
    listeners.set(operationalDayIdValue, { ref, roomId, token });
    ref.on('value', snap => {
      if (listeners.get(operationalDayIdValue)?.token !== token) return; // detached or superseded
      handleRemoteDaySnapshot(operationalDayIdValue, snap.val(), roomId);
    });
  }

  function detachDay(operationalDayIdValue) {
    const entry = listeners.get(operationalDayIdValue);
    if (entry) entry.ref.off();
    listeners.delete(operationalDayIdValue);
  }

  function detachAll() {
    for (const id of [...listeners.keys()]) detachDay(id);
    hydratedRoomId = null; // the next binding hydrates again
  }

  return { syncDay, pushDay, attachDay, detachDay, detachAll, hydrateAll, handleRemoteDaySnapshot, repository };
}

// A ready-to-use singleton for the real app (index.html) only — constructing it touches
// localStorage (via the default repository), which does not exist under plain `node --test`.
// Same guard and same room-ref accessor as personal-day-boundary-sync.js /
// coarse-life-evidence-sync.js. Tests build their own bridge with fake deps instead.
if (typeof window !== 'undefined') {
  window.OperationalPlanSync = createOperationalPlanSyncBridge({
    getRoomRef: () => (typeof globalThis.getChronaSenseRoomRef === 'function' ? globalThis.getChronaSenseRoomRef() : null),
    getRoomId: appRoomOwner,
    onRemoteChange: () => {
      // An inbound remote plan is an authoritative change like any other: drop
      // the authority layer's derived caches, then re-render every surface that
      // reads it (the plan strip, Up Next, Tomorrow, Partner View, this section).
      if (window.PlanAuthority) window.PlanAuthority.invalidate();
      if (typeof globalThis.refreshAuthoritativePlanSurfaces === 'function') globalThis.refreshAuthoritativePlanSurfaces();
      else if (typeof window.refreshOperationalPlanSurfaceIfMounted === 'function') window.refreshOperationalPlanSurfaceIfMounted();
    }
  });
}
