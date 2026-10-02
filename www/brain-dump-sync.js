// brain-dump-sync.js
//
// Durable cross-device copy of the canonical Brain Dump store, on top of
// brain-dump-repository.js. Mirrors commitments-sync.js exactly — a real Firebase
// RTDB `.transaction()` per record, with the model's own merge as the transaction's
// update function, ONE whole-subtree listener (the capture set is small and not
// bounded to "near today" the way a per-day listener would need to be) — because
// Brain Dump needs exactly the same concurrency safety commitments already have.
//
// Remote path: `rooms/<roomCode>/brainDump/<captureId>`
//
// No key encoding: a capture id is minted from base36 + [A-Za-z0-9_-] only
// (validBrainDumpId), so it is already a legal Firebase key and is used verbatim.
//
// Rules: `rooms/$roomId` is already owner-only read+write in firebase.rules.json
// (auth.uid must match the room id), so this new child under it needs NO rules
// change and broadens access to nobody.
//
// ── account scope (same discipline as Cross-Store Account Isolation V1) ─────
//
// The local cache belongs to ONE account (brain-dump-repository.js keeps a slot per
// room). This bridge is the only thing that moves captures between the cache and a
// room, and it enforces the pairing itself, exactly like commitments-sync.js:
//   - PUSH: refused ('owner-mismatch', zero writes) unless the joined room
//     (`getRoomId()`) equals the repository's active cache owner. Re-checked
//     inside the transaction, so a switch mid-retry aborts with zero writes, and
//     again before the committed result is merged back locally.
//   - PULL: a snapshot is merged only if it came from the room that is joined
//     RIGHT NOW and whose cache is active. The listener carries the room it was
//     attached for and a token; a detached/superseded or old-room callback is
//     dropped, never merged, never announced.
//   - ATTACH: the listener is bound to one room. attach() while bound to another
//     room (a direct switch) drops that listener first and rebinds.
//   - QUEUE: offline intents are remembered per owner room, so a switch neither
//     drains A's queue into B nor forgets it for A's return.

import { createBrainDumpRepository } from './brain-dump-repository.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';
import { validBrainDumpId, mergeCaptureRecords } from './brain-dump-model.js';

export const BRAIN_DUMP_REMOTE_PATH = 'brainDump';

export function createBrainDumpSyncBridge(deps = {}) {
  const repository = deps.repository || createBrainDumpRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  const getRoomId = typeof deps.getRoomId === 'function' ? deps.getRoomId : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};
  const onRebind = typeof deps.onRebind === 'function' ? deps.onRebind : () => {};

  let listener = null; // { ref, roomId, token } for the one whole-subtree listener
  let listenerToken = 0;
  /** Capture ids this device has written locally but not yet confirmed as pushed,
   *  per owner room. Keyed by owner so one account's queue is never drained into
   *  another's room. */
  const pendingByOwner = new Map();

  function activeRoomId() {
    const roomId = getRoomId();
    return typeof roomId === 'string' && roomId ? roomId : null;
  }

  function cacheOwner() {
    return typeof repository.ownerRoomId === 'function' ? repository.ownerRoomId() : null;
  }

  /** True iff `roomId` is the joined room AND its cache is the active one. Absence
   *  of an owner is never a match: a plain repository cannot prove whose data it holds. */
  function roomOwnsCache(roomId) {
    return !!roomId && roomId === activeRoomId() && cacheOwner() === roomId;
  }

  function pendingFor(owner) {
    if (!pendingByOwner.has(owner)) pendingByOwner.set(owner, new Set());
    return pendingByOwner.get(owner);
  }

  function queue(owner, id) {
    if (owner) pendingFor(owner).add(id);
  }

  function captureRef(id) {
    const roomRef = getRoomRef();
    if (!roomRef) return null;
    try {
      const ref = roomRef.child(BRAIN_DUMP_REMOTE_PATH).child(id);
      if (typeof ref.transaction !== 'function') return null;
      return ref;
    } catch {
      return null;
    }
  }

  /** Pushes ONE capture and reports what happened:
   *  'committed' | 'skipped' (invalid id / nothing local / no account) |
   *  'queued' (no room ref — offline; pushed on reconnect) |
   *  'owner-mismatch' (cache not the joined room's — zero writes) |
   *  'aborted' (transaction not committed) | 'transport-failure'. */
  function pushCapture(id) {
    if (!validBrainDumpId(id)) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const owner = cacheOwner();
    const local = repository.read(id);
    if (!local) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const ref = captureRef(id);
    if (!ref) {
      // Offline (or Firebase not ready). Remember the intent for THIS cache's owner
      // and return — the local write already happened and is durable in localStorage.
      queue(owner, id);
      return Promise.resolve({ committed: false, outcome: 'queued' });
    }
    const roomId = activeRoomId();
    if (!roomOwnsCache(roomId)) {
      queue(owner, id);
      return Promise.resolve({ committed: false, outcome: 'owner-mismatch' });
    }
    const candidate = JSON.parse(JSON.stringify(local));
    let ownerLost = false;
    return ref.transaction(remote => {
      ownerLost = !roomOwnsCache(roomId);
      if (ownerLost) return undefined;
      return mergeCaptureRecords(remote, candidate) || undefined;
    }, undefined, false)
      .then(result => {
        if (ownerLost) {
          queue(roomId, id);
          return { committed: false, outcome: 'owner-mismatch' };
        }
        if (!result?.committed || !result.snapshot) {
          queue(roomId, id);
          return { committed: false, outcome: 'aborted' };
        }
        pendingFor(roomId).delete(id);
        if (roomOwnsCache(roomId)) {
          const { changed, record } = repository.mergeRemote(id, result.snapshot.val());
          if (changed) onRemoteChange(id, record);
        }
        return { committed: true, outcome: 'committed' };
      })
      .catch(() => {
        queue(roomId, id);
        return { committed: false, outcome: 'transport-failure' };
      });
  }

  /** @param {string} id @returns {Promise<boolean>} true iff committed. */
  function syncCapture(id) {
    return pushCapture(id).then(result => result.committed);
  }

  /** Merges one inbound remote record. Record-level only — a peer's snapshot can
   *  never remove a capture it simply does not mention. `roomId` is the room the
   *  record CAME FROM; applied only if that room is joined now and its cache is active. */
  function handleRemoteRecord(id, value, roomId = activeRoomId()) {
    if (!validBrainDumpId(id) || !value || !roomOwnsCache(roomId)) return;
    const { changed, record } = repository.mergeRemote(id, value);
    if (changed) onRemoteChange(id, record);
  }

  function handleRemoteSnapshot(value, roomId = activeRoomId()) {
    if (!value || typeof value !== 'object' || !roomOwnsCache(roomId)) return;
    Object.entries(value).forEach(([id, record]) => handleRemoteRecord(id, record, roomId));
  }

  /** Attaches the single whole-subtree listener, bound to the joined room.
   *  Idempotent for the same room; bound to a different room (a direct account
   *  switch), it drops that listener first and rebinds. */
  function attach() {
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    if (!roomRef || !roomId) return;
    if (listener && listener.roomId === roomId) return;
    if (listener) detach();
    const token = ++listenerToken;
    try {
      const ref = roomRef.child(BRAIN_DUMP_REMOTE_PATH);
      listener = { ref, roomId, token };
      onRebind(roomId);
      ref.on('value', snap => {
        if (listener?.token !== token) return; // detached or superseded
        handleRemoteSnapshot(snap.val(), roomId);
      });
    } catch {
      listener = null;
    }
  }

  function detach() {
    listenerToken++; // any callback still in flight from the old binding is now stale
    if (!listener) return;
    try { listener.ref.off(); } catch { /* already gone */ }
    listener = null;
    onRebind(null);
  }

  /** Reconnect hook. Re-pushes every record this device knows may be missing
   *  remotely: everything queued while offline, plus every locally stored record
   *  when the queue is empty but a room ref has just appeared. Keyed on the
   *  RECORD SET, never on a date horizon, so nothing stays unsynced forever.
   *  @returns {Promise<number>} how many records pushed successfully */
  function pushAllLocal({ all = false } = {}) {
    const roomId = activeRoomId();
    if (!getRoomRef() || !roomOwnsCache(roomId)) return Promise.resolve(0);
    const pending = pendingFor(roomId);
    const ids = all || pending.size === 0
      ? Object.keys(repository.listAllRaw())
      : [...pending];
    return Promise.all(ids.map(id => syncCapture(id))).then(results => results.filter(Boolean).length);
  }

  function pendingPushIds(owner = cacheOwner()) {
    return [...(pendingByOwner.get(owner) || [])];
  }

  return {
    syncCapture, pushCapture, attach, detach, pushAllLocal, pendingPushIds,
    handleRemoteRecord, handleRemoteSnapshot, repository,
    BRAIN_DUMP_REMOTE_PATH,
  };
}

// A ready-to-use singleton for the real app (index.html) only — constructing the
// default repository touches localStorage, which does not exist under plain
// `node --test`. Same guard and same room-ref accessor as commitments-sync.js.
// Tests build their own bridge with fake deps.
if (typeof window !== 'undefined') {
  const bridge = createBrainDumpSyncBridge({
    repository: window.BrainDumpRepository,
    getRoomRef: () => (typeof globalThis.getChronaSenseRoomRef === 'function' ? globalThis.getChronaSenseRoomRef() : null),
    getRoomId: appRoomOwner,
    onRemoteChange: () => globalThis.refreshBrainDumpSurfaces?.(),
    // A new binding (or none) means a different account's cache is now the active
    // one: re-render so nothing drawn from the previous account's captures lingers.
    // Deferred to a microtask so it runs after storage.js has finished changing the
    // room (sign-out detaches first and clears the room after, in the same
    // synchronous handler).
    onRebind: () => Promise.resolve().then(() => {
      try { globalThis.refreshBrainDumpSurfaces?.(); } catch { /* UI not mounted yet */ }
    }),
  });
  window.BrainDumpSync = bridge;
  // storage.js attaches this bridge when the room is joined. This module is
  // deferred, so if the room was ALREADY joined before it finished loading, that
  // call found no bridge — attach and drain now instead. Both calls are idempotent.
  if (typeof globalThis.getChronaSenseRoomRef === 'function' && globalThis.getChronaSenseRoomRef()) {
    bridge.attach();
    bridge.pushAllLocal();
  }
}
