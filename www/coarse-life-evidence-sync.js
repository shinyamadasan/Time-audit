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
//
// ── account scope (Cross-Store Account Isolation V1) ────────────────────────
//
// The local cache belongs to ONE account (the repository keeps a slot per room).
// Previously, after a direct A -> B switch (no sign-out, no reload), attach() stayed
// bound to A's room and storage.js's reconnect hook ran pushAllLocal() into B's room,
// diffing A's cache against A's snapshot: every A record A's remote lacked was
// written to rooms/uid_B/coarseLifeEvidence. This bridge now enforces the pairing:
//   - PUSH (pushRecord / pushAllLocal): refused, zero writes, unless the joined room
//     (`getRoomId()`) equals the repository's active cache owner. pushRecord also
//     requires the record to be exactly what that cache holds now, so a record object
//     read from another account's slot can never be written. pushAllLocal only diffs
//     against a snapshot that came from that same room; with none yet it waits for the
//     binding's bootstrap. Pushes are single update() calls — no transaction/retry
//     callback exists, and nothing is merged back from a push.
//   - PULL: a snapshot is merged only if it came from the room joined RIGHT NOW whose
//     cache is active. The listener carries its room + a token; a detached/superseded
//     or old-room callback is dropped.
//   - ATTACH: bound to one room; attach() while bound to another room drops that
//     listener (and its snapshot and bootstrap state) first and rebinds.

import { createCoarseEvidenceRepository } from './coarse-life-evidence-repository.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';
import { COARSE_LIFE_EVIDENCE_REMOTE_PATH } from './coarse-life-evidence-model.js';

export { COARSE_LIFE_EVIDENCE_REMOTE_PATH };

export function createCoarseEvidenceSyncBridge(deps = {}) {
  const repository = deps.repository || createCoarseEvidenceRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  // The joined room's identity, independent of whether its ref is reachable right now.
  const getRoomId = typeof deps.getRoomId === 'function' ? deps.getRoomId : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};
  // Called when the active binding changes (another room, or none), so a mounted list
  // drops whatever it rendered from the previous account's cache.
  const onRebind = typeof deps.onRebind === 'function' ? deps.onRebind : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  let listener = null; // { ref, roomId, token }
  let listenerToken = 0;
  // Guards the one-time-per-attach full local push that migrates any pre-durability local
  // records (Phase 6H installs) onto the remote copy automatically, with no user action —
  // see handleRemoteSnapshot(). Reset on detach() so the next sign-in re-checks.
  let bootstrapped = false;
  // The most recent remote snapshot this bridge has seen, keyed by id, and the room it came
  // from. pushAllLocal() diffs against this so it only pushes records that are actually
  // missing or stale on the remote side, instead of rewriting every record on every call
  // (see pushAllLocal()) — and never against another room's snapshot.
  let lastRemoteSnapshot = {};
  let lastRemoteSnapshotRoomId = null;

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

  // Best-effort, fire-and-forget: local storage is already the durable-enough source of
  // truth for this device, so a push failure (offline, permission, etc.) must never surface
  // as an error to the caller — it will simply be retried by whatever next touches this
  // record (or the next attach()'s bootstrap pass). Mirrors storage.js's saveReview()/
  // syncEntries() error handling, which is the same "log locally, don't block the UI" shape.
  function pushRecord(record) {
    const roomRef = getRoomRef();
    if (!roomRef || !record || !record.id) return Promise.resolve(false);
    // Only the joined room's own cache, and only the record exactly as that cache holds it.
    if (!roomOwnsCache(activeRoomId())) return Promise.resolve(false);
    const current = repository.getRaw(record.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(record)) return Promise.resolve(false);
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
  function pushAllLocal(remoteSnapshot) {
    const roomRef = getRoomRef();
    if (!roomRef) return Promise.resolve(false);
    const roomId = activeRoomId();
    if (!roomOwnsCache(roomId)) return Promise.resolve(false);
    // Diff only against what THIS room is known to hold. With no snapshot from it yet,
    // wait: the binding's first snapshot runs the bootstrap push with a known remote.
    if (remoteSnapshot === undefined) {
      if (lastRemoteSnapshotRoomId !== roomId) return Promise.resolve(false);
      remoteSnapshot = lastRemoteSnapshot;
    }
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
  function handleRemoteSnapshot(val, roomId = activeRoomId()) {
    // `roomId` is the room the snapshot CAME FROM; it is applied only if that room is
    // joined now and its cache is active.
    if (!roomOwnsCache(roomId)) return;
    lastRemoteSnapshot = val || {};
    lastRemoteSnapshotRoomId = roomId;
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
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    // With the room's identity unknown nothing is subscribed: whose cache a snapshot
    // would populate could not be said.
    if (!roomRef || !roomId) return;
    if (listener && listener.roomId === roomId) return; // already attached for this room
    if (listener) detach(); // a direct account switch: drop the previous room's binding first
    const token = ++listenerToken;
    const ref = roomRef.child(COARSE_LIFE_EVIDENCE_REMOTE_PATH);
    listener = { ref, roomId, token };
    onRebind(roomId);
    ref.on('value', snap => {
      if (listener?.token !== token) return; // detached or superseded
      handleRemoteSnapshot(snap.val(), roomId);
    });
  }

  function detach() {
    listenerToken++; // any callback still in flight from the old binding is now stale
    const wasBound = !!listener;
    if (listener) listener.ref.off();
    listener = null;
    bootstrapped = false;
    lastRemoteSnapshot = {};
    lastRemoteSnapshotRoomId = null;
    if (wasBound) onRebind(null);
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
    getRoomId: appRoomOwner,
    onRemoteChange: () => {
      if (typeof window.refreshCoarseEvidenceListIfMounted === 'function') {
        window.refreshCoarseEvidenceListIfMounted();
      }
    },
    // A different account's cache is now the active one (or none): close an open editor (it may
    // hold the previous account's record, pre-filled — saving it would copy that record into the
    // new account) and repaint a mounted list so nothing drawn from the previous account lingers.
    // Deferred to a microtask (Promise.resolve().then) so it runs after storage.js has finished changing the room.
    onRebind: () => Promise.resolve().then(() => {
      if (typeof window.closeCoarseEvidenceEditor === 'function') {
        try { window.closeCoarseEvidenceEditor(); } catch { /* not mounted */ }
      }
      if (typeof window.refreshCoarseEvidenceListIfMounted === 'function') {
        try { window.refreshCoarseEvidenceListIfMounted(); } catch { /* not mounted */ }
      }
    })
  });
  // storage.js attaches this bridge when the room is joined. This module is deferred, so if the
  // room was ALREADY joined before it finished loading (auth resolving first on a cold load), that
  // call found no bridge and is never repeated. The scoped cache is filled from the joined room's
  // own copy by this listener (the unscoped pre-scoping key is quarantined, never read), so attach
  // now. Idempotent for the same room; the listener's first snapshot runs the bootstrap push, so no
  // separate drain is needed. Same fix commitments-sync.js and personal-day-boundary-live.js carry.
  if (typeof globalThis.getChronaSenseRoomRef === 'function' && globalThis.getChronaSenseRoomRef()) {
    window.CoarseLifeEvidenceSync.attach();
  }
}
