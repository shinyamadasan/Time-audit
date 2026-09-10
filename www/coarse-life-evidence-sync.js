// ChronaSense Coarse Life Evidence — Durability V1.
//
// Adds an account-scoped DURABLE remote copy of coarse life evidence on top of the Phase 6H
// local-only store. Local storage stays the fast/offline cache and immediate source of truth;
// this module keeps a remote copy converged with it using the SAME record-level,
// updatedAt-last-write-wins + tombstone pattern storage.js already uses live for `entries` and
// `reviews` (see storage.js's `resolveEntrySync`, `syncEntries()`, `saveReview()`) — not a new
// sync architecture, no collection-replace, no manual export/import, no new daily user action.
//
// Coarse records get their own keyed path, `rooms/<roomCode>/coarseLifeEvidence/<id>`,
// independent of `entries`/`reviews`/`plans` — per the evidence contract, a coarse record is
// never merged into `entries`, and this sync layer must not change that.
//
// Dependency-injected (`createCoarseEvidenceSyncBridge`) so the full attach/push/merge
// lifecycle is unit-testable against an in-memory fake Firebase room ref — no real network,
// no real Firebase project, required. The bottom of this file wires one real instance to
// storage.js's live `fbRoomRef` via a tiny accessor storage.js exposes on `globalThis`
// (`getChronaSenseRoomRef`), the same globalThis-bridge pattern this app already uses in the
// other direction (e.g. `globalThis.PlanTomorrowModel`).

import { createCoarseEvidenceRepository } from './coarse-life-evidence-repository.js';
import { COARSE_LIFE_EVIDENCE_REMOTE_PATH } from './coarse-life-evidence-model.js';

export { COARSE_LIFE_EVIDENCE_REMOTE_PATH };

export function createCoarseEvidenceSyncBridge(deps = {}) {
  const repository = deps.repository || createCoarseEvidenceRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  let listenerRef = null;
  // Guards the one-time-per-attach full local push that migrates any pre-durability local
  // records (Phase 6H installs) onto the remote copy automatically, with no user action —
  // see handleRemoteSnapshot(). Reset on detach() so the next sign-in re-checks.
  let bootstrapped = false;
  // The most recent remote snapshot this bridge has seen, keyed by id. pushAllLocal() diffs
  // against this so it only pushes records that are actually missing or stale on the remote
  // side, instead of rewriting every record on every call (see pushAllLocal()).
  let lastRemoteSnapshot = {};

  // Best-effort, fire-and-forget: local storage is already the durable-enough source of
  // truth for this device, so a push failure (offline, permission, etc.) must never surface
  // as an error to the caller — it will simply be retried by whatever next touches this
  // record (or the next attach()'s bootstrap pass). Mirrors storage.js's saveReview()/
  // syncEntries() error handling, which is the same "log locally, don't block the UI" shape.
  function pushRecord(record) {
    const roomRef = getRoomRef();
    if (!roomRef || !record || !record.id) return Promise.resolve(false);
    return roomRef.update({ [`${COARSE_LIFE_EVIDENCE_REMOTE_PATH}/${record.id}`]: record })
      .then(() => true)
      .catch(() => false);
  }

  // Pushes locally known records (tombstones included, so a delete made before sync was ever
  // wired replicates too) that are actually missing or out of date on the remote copy — not
  // the full local set unconditionally, so a re-attach/reconnect doesn't rewrite records the
  // remote already has correctly (which would also re-broadcast a locally-kept-stale value
  // and briefly clobber a newer remote one). Diffs against the last remote snapshot this
  // bridge observed (via handleRemoteSnapshot), or an explicitly passed one.
  function pushAllLocal(remoteSnapshot = lastRemoteSnapshot) {
    const roomRef = getRoomRef();
    if (!roomRef) return Promise.resolve(false);
    const remote = remoteSnapshot || {};
    const all = repository.listAllRaw();
    const updates = {};
    all.forEach(record => {
      const remoteRecord = remote[record.id];
      if (remoteRecord && JSON.stringify(remoteRecord) === JSON.stringify(record)) return;
      updates[`${COARSE_LIFE_EVIDENCE_REMOTE_PATH}/${record.id}`] = record;
    });
    if (!Object.keys(updates).length) return Promise.resolve(false);
    return roomRef.update(updates).then(() => true).catch(() => false);
  }

  // Called with the full current remote snapshot (Firebase's `.on('value')` semantics: fires
  // once immediately with current data, then again on every subsequent change or reconnect).
  // Record-level merge only — never a collection replace — so a record known only locally
  // and absent from `val` is left untouched here (pushAllLocal() below is what makes it
  // durable, not this merge).
  function handleRemoteSnapshot(val) {
    lastRemoteSnapshot = val || {};
    const result = repository.mergeRemoteSnapshot(lastRemoteSnapshot, now());
    if (result.changed) onRemoteChange(result);
    if (!bootstrapped) {
      // First snapshot this attach(): migrate any local records the remote copy doesn't
      // know about yet (new install pre-dating durability, or an offline-created record).
      // Runs after the merge above so we never push in ignorance of a genuinely newer
      // remote value we just adopted locally.
      bootstrapped = true;
      pushAllLocal(lastRemoteSnapshot);
    }
  }

  function attach() {
    if (listenerRef) return; // already attached for this sign-in session
    const roomRef = getRoomRef();
    if (!roomRef) return;
    listenerRef = roomRef.child(COARSE_LIFE_EVIDENCE_REMOTE_PATH);
    listenerRef.on('value', snap => handleRemoteSnapshot(snap.val()));
  }

  function detach() {
    if (listenerRef) listenerRef.off();
    listenerRef = null;
    bootstrapped = false;
    lastRemoteSnapshot = {};
  }

  return { attach, detach, pushRecord, pushAllLocal, handleRemoteSnapshot, repository };
}

// A ready-to-use singleton for the real app (index.html) only — constructing it touches
// localStorage (via the default repository), which does not exist under plain `node --test`.
// Test files use createCoarseEvidenceSyncBridge(fakeDeps) directly instead — see
// coarse-life-evidence-sync.test.js.
if (typeof window !== 'undefined') {
  window.CoarseLifeEvidenceSync = createCoarseEvidenceSyncBridge({
    getRoomRef: () => (typeof globalThis.getChronaSenseRoomRef === 'function' ? globalThis.getChronaSenseRoomRef() : null),
    onRemoteChange: () => {
      if (typeof window.refreshCoarseEvidenceListIfMounted === 'function') {
        window.refreshCoarseEvidenceListIfMounted();
      }
    }
  });
}
