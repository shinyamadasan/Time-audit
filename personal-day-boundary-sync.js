// personal-day-boundary-sync.js
//
// Durable cross-device copy of the Personal Day Boundary revision history, on
// top of the local-only personal-day-boundary-repository.js. Same split and
// same record-level append/merge shape as coarse-life-evidence-sync.js (this
// app's established pattern for a durable remote copy that must NOT use
// storage.js's whole-object `settings` last-write-wins push — see that file's
// syncSettings()/applyRemoteSettings(), which this module deliberately does not
// call or extend).
//
// Remote path: `rooms/<roomCode>/dayBoundaryRevisions/<revisionId>` — a NEW
// room-scoped child, already covered by the existing wide-open
// `rooms/$roomId` read/write rule in firebase.rules.json (no rules change
// needed; see PERSONAL_DAY_BOUNDARY_PLAN_AUTHORITY notes).
//
// Dependency-injected, exactly like createCoarseEvidenceSyncBridge, so the
// full attach/push/merge lifecycle is unit-testable against an in-memory fake
// room ref — no real network, no real Firebase project required.
//
// Each revision is immutable once created (repository.propose() never edits
// one), so pushRevision() writes to that revision's OWN child key. Two
// devices creating two DIFFERENT revisions never conflict at the Firebase
// level (`update()` at distinct paths). The one residual risk — two devices
// somehow minting the SAME revision id with different facts — is guarded by a
// transaction on that exact child path that only commits if the existing
// remote value is absent or already deep-equal to the candidate; the second
// writer's transaction aborts rather than corrupting the first writer's fact
// (contract §6). This module does not wire itself into the live app
// (`window.PersonalDayBoundarySync` is not created here) — that is a future
// integration phase's job, matching how personal-day-boundary-model.js itself
// shipped fully tested but unwired.

import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';

export const DAY_BOUNDARY_REVISIONS_REMOTE_PATH = 'dayBoundaryRevisions';

export function createPersonalDayBoundarySyncBridge(deps = {}) {
  const repository = deps.repository || createPersonalDayBoundaryRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};
  const onConflict = typeof deps.onConflict === 'function' ? deps.onConflict : () => {};

  let listenerRef = null;
  let bootstrapped = false;
  let lastRemoteSnapshot = {};

  // Best-effort, fire-and-forget — local storage is already durable enough for
  // this device; a push failure is retried by the next attach()'s bootstrap
  // pass or the next propose(). Same error-handling shape as
  // coarse-life-evidence-sync.js's pushRecord().
  //
  // The transaction guard makes this safe even in the (vanishingly unlikely)
  // case of two devices minting the same revision id: it commits only if the
  // remote child is empty or already holds the exact same revision; any other
  // existing value aborts the write rather than overwriting a different fact.
  function pushRevision(revision) {
    const roomRef = getRoomRef();
    if (!roomRef || !revision || !revision.id) return Promise.resolve(false);
    let childRef;
    try {
      childRef = roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).child(revision.id);
      if (typeof childRef.transaction !== 'function') throw new Error('Firebase transactions are unavailable.');
    } catch {
      return Promise.resolve(false);
    }
    return childRef.transaction(remote => {
      if (remote == null) return revision;
      return JSON.stringify(remote) === JSON.stringify(revision) ? remote : undefined; // undefined aborts the transaction
    }, undefined, false)
      .then(result => !!result?.committed)
      .catch(() => false);
  }

  // Pushes every locally known revision missing or absent from the remote
  // snapshot. Diffs against the last observed remote snapshot so a
  // reconnect/re-attach doesn't rewrite revisions the remote already has.
  function pushAllLocal(remoteSnapshot = lastRemoteSnapshot) {
    const roomRef = getRoomRef();
    if (!roomRef) return Promise.resolve(false);
    const remote = remoteSnapshot || {};
    const missing = repository.listAllRaw().filter(revision => {
      const remoteRevision = remote[revision.id];
      return !remoteRevision || JSON.stringify(remoteRevision) !== JSON.stringify(revision);
    });
    if (!missing.length) return Promise.resolve(false);
    return Promise.all(missing.map(pushRevision)).then(results => results.some(Boolean));
  }

  // Firebase `.on('value')` semantics: fires once immediately with current
  // data, then again on every subsequent change/reconnect. Record-level merge
  // only via repository.mergeRemoteRevisions — never a collection replace.
  function handleRemoteSnapshot(val) {
    lastRemoteSnapshot = val || {};
    const result = repository.mergeRemoteRevisions(lastRemoteSnapshot);
    if (result.changed) onRemoteChange(result);
    if (result.conflict || result.rejectedIds.length) onConflict(result);
    if (!bootstrapped) {
      bootstrapped = true;
      pushAllLocal(lastRemoteSnapshot);
    }
  }

  function attach() {
    if (listenerRef) return;
    const roomRef = getRoomRef();
    if (!roomRef) return;
    listenerRef = roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH);
    listenerRef.on('value', snap => handleRemoteSnapshot(snap.val()));
  }

  function detach() {
    if (listenerRef) listenerRef.off();
    listenerRef = null;
    bootstrapped = false;
    lastRemoteSnapshot = {};
  }

  return { attach, detach, pushRevision, pushAllLocal, handleRemoteSnapshot, repository };
}
