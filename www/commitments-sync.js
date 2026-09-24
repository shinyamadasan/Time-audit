// commitments-sync.js
//
// Durable cross-device copy of the canonical commitment store, on top of
// commitments-repository.js. Mirrors operational-plan-sync.js as closely as the
// difference in shape allows — a real Firebase RTDB `.transaction()` per record,
// with the model's own merge as the transaction's update function — because
// commitments need exactly the same concurrency safety plan items already get.
//
// Remote path: `rooms/<roomCode>/commitments/<commitmentId>`
//
// Two deliberate differences from the operational-plan bridge:
//
//   1. NO KEY ENCODING. An operationalDayId embeds an IANA zone and therefore a
//      '/', so it has to be base64url-encoded to survive `.child()`. A commitment
//      id is minted from base36 + [A-Za-z0-9_-] only (validCommitmentId), so it is
//      already a legal Firebase key and is used verbatim. One less transform, one
//      less place the identity could be mangled.
//
//   2. ONE WHOLE-SUBTREE LISTENER, not a listener per record. The operational-plan
//      bridge is per-day because the set of operational days is unbounded and grows
//      forever, so a firehose there would attach to every day that ever existed.
//      The commitment set is different in kind: it is exactly what the owner typed,
//      it is small, and — critically — it is NOT bounded to "near today". A
//      commitment eight months out has to converge as reliably as one tomorrow.
//      A per-record listener would need a horizon to decide what to attach, and any
//      horizon is precisely the bug this phase exists to avoid. So this bridge
//      listens to the whole `commitments` subtree, exactly as storage.js already
//      does for the legacy `plans` subtree, and inbound records are merged
//      individually via repository.mergeRemote — never a store-wide replace.
//
// Rules: `rooms/$roomId` is already owner-only read+write in firebase.rules.json
// (auth.uid must match the room id), so a new child under it needs NO rules change
// and broadens access to nobody.
//
// ── account scope (Cross-Store Account Isolation V1) ────────────────────────
//
// The local cache belongs to ONE account (commitments-repository.js keeps a slot
// per room). Previously this bridge pushed whatever the single unscoped cache held
// into whatever room was joined: after a direct A -> B switch (no sign-out, no
// reload) storage.js's reconnect hook ran pushAllLocal() and A's commitments were
// transacted into rooms/uid_B/commitments, while the subtree listener stayed bound
// to A's room. This bridge is the only thing that moves commitments between the
// cache and a room, so it enforces the pairing itself, the same way
// operational-plan-sync.js does:
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

import { createCommitmentsRepository } from './commitments-repository.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';
import { validCommitmentId, mergeCommitmentRecords } from './commitments-model.js';

export const COMMITMENTS_REMOTE_PATH = 'commitments';

export function createCommitmentsSyncBridge(deps = {}) {
  const repository = deps.repository || createCommitmentsRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  // The joined room's identity, independent of whether its ref is reachable right now.
  const getRoomId = typeof deps.getRoomId === 'function' ? deps.getRoomId : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};
  // Called when the active binding changes (bound to another room, or detached), so
  // surfaces drop whatever they rendered from the previous account's cache.
  const onRebind = typeof deps.onRebind === 'function' ? deps.onRebind : () => {};

  let listener = null; // { ref, roomId, token } for the one whole-subtree listener
  let listenerToken = 0;
  /** Commitment ids this device has written locally but not yet confirmed as
   *  pushed, per owner room. This is what makes an OFFLINE write durable:
   *  syncCommitment() records the intent even when there is no room ref, and
   *  pushAllLocal() drains it on reconnect. Without it an offline edit would sit in
   *  localStorage forever, because nothing else would ever think to push that
   *  particular record again. Keyed by owner so one account's queue is never
   *  drained into another's room. */
  const pendingByOwner = new Map();

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

  function pendingFor(owner) {
    if (!pendingByOwner.has(owner)) pendingByOwner.set(owner, new Set());
    return pendingByOwner.get(owner);
  }

  function queue(owner, id) {
    if (owner) pendingFor(owner).add(id);
  }

  function commitmentRef(id) {
    const roomRef = getRoomRef();
    if (!roomRef) return null;
    try {
      // The id is already Firebase-key-safe — see the header.
      const ref = roomRef.child(COMMITMENTS_REMOTE_PATH).child(id);
      if (typeof ref.transaction !== 'function') return null;
      return ref;
    } catch {
      return null;
    }
  }

  /** Pushes ONE commitment and reports what happened:
   *  'committed' | 'skipped' (invalid id / nothing local / no account) |
   *  'queued' (no room ref — offline; pushed on reconnect) |
   *  'owner-mismatch' (cache not the joined room's — zero writes) |
   *  'aborted' (transaction not committed) | 'transport-failure'. */
  function pushCommitment(id) {
    if (!validCommitmentId(id)) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const owner = cacheOwner();
    const local = repository.read(id);
    if (!local) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const ref = commitmentRef(id);
    if (!ref) {
      // Offline (or Firebase not ready). Remember the intent for THIS cache's owner
      // and return — the local write already happened and is durable in localStorage.
      queue(owner, id);
      return Promise.resolve({ committed: false, outcome: 'queued' });
    }
    const roomId = activeRoomId();
    if (!roomOwnsCache(roomId)) {
      // The joined room is not this cache's owner: never write. The intent stays queued
      // for its owner, to be pushed when that account's room is joined again.
      queue(owner, id);
      return Promise.resolve({ committed: false, outcome: 'owner-mismatch' });
    }
    const candidate = JSON.parse(JSON.stringify(local));
    let ownerLost = false;
    return ref.transaction(remote => {
      // Firebase may re-run this later against fresh server data. If the account changed in
      // between, abort with zero writes rather than finish a push the cache no longer backs.
      ownerLost = !roomOwnsCache(roomId);
      if (ownerLost) return undefined;
      // The model's own pure merge IS the transaction's update function, so both
      // devices resolve a concurrent write by the same rule. Returning undefined
      // aborts, which can only happen if neither side normalizes — in which case
      // there is nothing safe to write.
      return mergeCommitmentRecords(remote, candidate) || undefined;
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
        // The committed room value is merged back only into THAT room's cache, and only while it is active.
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

  /** Pushes ONE commitment via a real transaction whose update function is the
   *  model's own merge, so two devices writing concurrently converge by the same
   *  rule on both sides rather than by whichever `set()` landed last. Resolves
   *  true iff committed; see pushCommitment for the outcome (including the
   *  owner-mismatch refusal).
   *  @param {string} id @returns {Promise<boolean>} */
  function syncCommitment(id) {
    return pushCommitment(id).then(result => result.committed);
  }

  /** Merges one inbound remote record. Record-level only — a peer's snapshot can
   *  never delete a commitment it simply does not mention (absence is not
   *  deletion; only a tombstone is). `roomId` is the room the record CAME FROM; it
   *  is applied only if that room is joined now and its cache is active. */
  function handleRemoteRecord(id, value, roomId = activeRoomId()) {
    if (!validCommitmentId(id) || !value || !roomOwnsCache(roomId)) return;
    const { changed, record } = repository.mergeRemote(id, value);
    if (changed) onRemoteChange(id, record);
  }

  /** Handles a whole-subtree snapshot by merging each record individually. */
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
    // With the room's identity unknown nothing is subscribed: whose cache a snapshot
    // would populate could not be said.
    if (!roomRef || !roomId) return;
    if (listener && listener.roomId === roomId) return;
    if (listener) detach();
    const token = ++listenerToken;
    try {
      const ref = roomRef.child(COMMITMENTS_REMOTE_PATH);
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
   *  remotely: everything queued while offline, plus — as a belt — every locally
   *  stored record when the queue is empty but a room ref has just appeared, since
   *  a device that wrote while Firebase was never initialised has no queue at all.
   *  This is the guarantee that no future-dated offline write stays unsynced
   *  forever: it is keyed on the RECORD SET, never on a date horizon.
   *  @returns {Promise<number>} how many records pushed successfully */
  function pushAllLocal({ all = false } = {}) {
    // Only ever drains the joined room's OWN cache into that room — never another
    // account's queue or slot, and nothing at all when the pairing is not proven.
    const roomId = activeRoomId();
    if (!getRoomRef() || !roomOwnsCache(roomId)) return Promise.resolve(0);
    const pending = pendingFor(roomId);
    const ids = all || pending.size === 0
      ? Object.keys(repository.listAllRaw())
      : [...pending];
    return Promise.all(ids.map(id => syncCommitment(id))).then(results => results.filter(Boolean).length);
  }

  /** Test/diagnostic seam: what is still waiting to be pushed for the active owner
   *  (or for `owner`, when given). */
  function pendingPushIds(owner = cacheOwner()) {
    return [...(pendingByOwner.get(owner) || [])];
  }

  return {
    syncCommitment, pushCommitment, attach, detach, pushAllLocal, pendingPushIds,
    handleRemoteRecord, handleRemoteSnapshot, repository,
    COMMITMENTS_REMOTE_PATH,
  };
}

// A ready-to-use singleton for the real app (index.html) only — constructing the
// default repository touches localStorage, which does not exist under plain
// `node --test`. Same guard and same room-ref accessor as
// operational-plan-sync.js. Tests build their own bridge with fake deps.
//
// The room ref comes from storage.js's getChronaSenseRoomRef() accessor, exactly as
// every sibling bridge gets it. It must NOT be read as globalThis.fbRoomRef: index.html
// declares fbRoomRef with a top-level `let`, which is never a window property, so that
// read is always undefined and the bridge would silently never sync.
if (typeof window !== 'undefined') {
  const bridge = createCommitmentsSyncBridge({
    repository: window.CommitmentsRepository,
    getRoomRef: () => (typeof globalThis.getChronaSenseRoomRef === 'function' ? globalThis.getChronaSenseRoomRef() : null),
    getRoomId: appRoomOwner,
    onRemoteChange: () => globalThis.refreshCommitmentSurfaces?.(),
    // A new binding (or none) means a different account's cache is now the active one:
    // re-render so nothing drawn from the previous account's commitments lingers (the
    // Upcoming list AND the My Day rows derived from it). Deferred to a microtask (Promise.resolve().then) so it
    // runs after storage.js has finished changing the room (sign-out detaches first and
    // clears the room after, in the same synchronous handler).
    onRebind: () => Promise.resolve().then(() => {
      try {
        if (typeof globalThis.refreshAuthoritativePlanSurfaces === 'function') globalThis.refreshAuthoritativePlanSurfaces();
        else globalThis.refreshCommitmentSurfaces?.();
      } catch { /* UI not mounted yet */ }
    }),
  });
  window.CommitmentsSync = bridge;
  // storage.js attaches this bridge when the room is joined. This module is deferred,
  // so if the room was ALREADY joined before it finished loading, that call found no
  // bridge — attach and drain now instead. Both calls are idempotent.
  if (typeof globalThis.getChronaSenseRoomRef === 'function' && globalThis.getChronaSenseRoomRef()) {
    bridge.attach();
    bridge.pushAllLocal();
  }
}
