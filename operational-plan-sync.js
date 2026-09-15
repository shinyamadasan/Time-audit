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
// Not wired into the live app (no `window.OperationalPlanSync` singleton here)
// — a future integration phase's job, same as personal-day-boundary-sync.js.

import { createOperationalPlanRepository } from './operational-plan-repository.js';
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

/** Inverse of toFirebaseSafeKey — exported for a future whole-subtree listener
 *  that needs to map an unknown remote key back to its operationalDayId; this
 *  bridge's own per-day methods never need it, since callers always supply
 *  the id they already know. */
export function fromFirebaseSafeKey(key) {
  const padded = key.replace(/-/g, '+').replace(/_/g, '/').padEnd(key.length + ((4 - (key.length % 4)) % 4), '=');
  return atob(padded);
}

export function createOperationalPlanSyncBridge(deps = {}) {
  const repository = deps.repository || createOperationalPlanRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};

  const listeners = new Map(); // operationalDayId -> ref, for attachDay/detachDay

  /** Pushes local changes for ONE operational day via a real Firebase
   *  transaction, exactly like storage.js's syncPlans(dateKey) does for the
   *  legacy store: the transaction's update function merges the server's
   *  current value with the local candidate via mergeOperationalPlanRecords,
   *  so two devices writing concurrently to the same operational day converge
   *  by per-item merge, never by whichever `update()` call happened to land
   *  last (contract §5/§21 — operational plans get the SAME safety legacy
   *  plans already have, not a weaker one).
   *  @param {string} operationalDayIdValue */
  function syncDay(operationalDayIdValue) {
    if (!parseOperationalDayId(operationalDayIdValue)) return Promise.resolve(false);
    const roomRef = getRoomRef();
    const local = repository.read(operationalDayIdValue);
    if (!roomRef || !local) return Promise.resolve(false);
    const candidate = JSON.parse(JSON.stringify(local));
    let dayRef;
    try {
      dayRef = roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(operationalDayIdValue));
      if (typeof dayRef.transaction !== 'function') throw new Error('Firebase plan transactions are unavailable.');
    } catch {
      return Promise.resolve(false);
    }
    return dayRef.transaction(remote => mergeOperationalPlanRecords(remote, candidate, operationalDayIdValue), undefined, false)
      .then(result => {
        if (!result?.committed || !result.snapshot) return false;
        const committed = mergeOperationalPlanRecords(null, result.snapshot.val(), operationalDayIdValue);
        const { changed, record } = repository.mergeRemote(operationalDayIdValue, committed);
        if (changed) onRemoteChange(operationalDayIdValue, record);
        return true;
      })
      .catch(() => false);
  }

  /** Merges one inbound remote snapshot for a single operational day — the
   *  listener-side counterpart to syncDay's push side. Record-level merge only
   *  via repository.mergeRemote, never a store-wide replace. */
  function handleRemoteDaySnapshot(operationalDayIdValue, val) {
    if (!val) return;
    const { changed, record } = repository.mergeRemote(operationalDayIdValue, val);
    if (changed) onRemoteChange(operationalDayIdValue, record);
  }

  /** Attaches a live listener for ONE operational day. Unlike the legacy store
   *  (which listens to the whole `plans/` subtree at once because the set of
   *  live dates is small and bounded to "recent"), operational days are opened
   *  individually by whatever UI phase eventually adopts this store — so this
   *  bridge is deliberately per-day, not a firehose over every operational day
   *  that has ever existed. */
  function attachDay(operationalDayIdValue) {
    if (!parseOperationalDayId(operationalDayIdValue) || listeners.has(operationalDayIdValue)) return;
    const roomRef = getRoomRef();
    if (!roomRef) return;
    const ref = roomRef.child(OPERATIONAL_PLANS_REMOTE_PATH).child(toFirebaseSafeKey(operationalDayIdValue));
    ref.on('value', snap => handleRemoteDaySnapshot(operationalDayIdValue, snap.val()));
    listeners.set(operationalDayIdValue, ref);
  }

  function detachDay(operationalDayIdValue) {
    const ref = listeners.get(operationalDayIdValue);
    if (ref) ref.off();
    listeners.delete(operationalDayIdValue);
  }

  function detachAll() {
    for (const id of [...listeners.keys()]) detachDay(id);
  }

  return { syncDay, attachDay, detachDay, detachAll, handleRemoteDaySnapshot, repository };
}
