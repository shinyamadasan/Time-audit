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

import { createCommitmentsRepository } from './commitments-repository.js';
import { validCommitmentId, mergeCommitmentRecords } from './commitments-model.js';

export const COMMITMENTS_REMOTE_PATH = 'commitments';

export function createCommitmentsSyncBridge(deps = {}) {
  const repository = deps.repository || createCommitmentsRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};

  let subtreeRef = null;
  /** Commitment ids this device has written locally but not yet confirmed as
   *  pushed. This is what makes an OFFLINE write durable: syncCommitment() records
   *  the intent even when there is no room ref, and pushAllLocal() drains it on
   *  reconnect. Without it an offline edit would sit in localStorage forever,
   *  because nothing else would ever think to push that particular record again. */
  const pendingPush = new Set();

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

  /** Pushes ONE commitment via a real transaction whose update function is the
   *  model's own merge, so two devices writing concurrently converge by the same
   *  rule on both sides rather than by whichever `set()` landed last.
   *  @param {string} id @returns {Promise<boolean>} */
  function syncCommitment(id) {
    if (!validCommitmentId(id)) return Promise.resolve(false);
    const local = repository.read(id);
    if (!local) return Promise.resolve(false);
    const ref = commitmentRef(id);
    if (!ref) {
      // Offline (or Firebase not ready). Remember the intent and return — the
      // local write already happened and is durable in localStorage.
      pendingPush.add(id);
      return Promise.resolve(false);
    }
    const candidate = JSON.parse(JSON.stringify(local));
    return ref.transaction(remote => {
      // The model's own pure merge IS the transaction's update function, so both
      // devices resolve a concurrent write by the same rule. Returning undefined
      // aborts, which can only happen if neither side normalizes — in which case
      // there is nothing safe to write.
      return mergeCommitmentRecords(remote, candidate) || undefined;
    }, undefined, false)
      .then(result => {
        if (!result?.committed || !result.snapshot) {
          pendingPush.add(id);
          return false;
        }
        const committed = result.snapshot.val();
        const { changed, record } = repository.mergeRemote(id, committed);
        pendingPush.delete(id);
        if (changed) onRemoteChange(id, record);
        return true;
      })
      .catch(() => {
        pendingPush.add(id);
        return false;
      });
  }

  /** Merges one inbound remote record. Record-level only — a peer's snapshot can
   *  never delete a commitment it simply does not mention (absence is not
   *  deletion; only a tombstone is). */
  function handleRemoteRecord(id, value) {
    if (!validCommitmentId(id) || !value) return;
    const { changed, record } = repository.mergeRemote(id, value);
    if (changed) onRemoteChange(id, record);
  }

  /** Handles a whole-subtree snapshot by merging each record individually. */
  function handleRemoteSnapshot(value) {
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([id, record]) => handleRemoteRecord(id, record));
  }

  /** Attaches the single whole-subtree listener. Idempotent. */
  function attach() {
    if (subtreeRef) return;
    const roomRef = getRoomRef();
    if (!roomRef) return;
    try {
      subtreeRef = roomRef.child(COMMITMENTS_REMOTE_PATH);
      subtreeRef.on('value', snap => handleRemoteSnapshot(snap.val()));
    } catch {
      subtreeRef = null;
    }
  }

  function detach() {
    if (!subtreeRef) return;
    try { subtreeRef.off(); } catch { /* already gone */ }
    subtreeRef = null;
  }

  /** Reconnect hook. Re-pushes every record this device knows may be missing
   *  remotely: everything queued while offline, plus — as a belt — every locally
   *  stored record when the queue is empty but a room ref has just appeared, since
   *  a device that wrote while Firebase was never initialised has no queue at all.
   *  This is the guarantee that no future-dated offline write stays unsynced
   *  forever: it is keyed on the RECORD SET, never on a date horizon.
   *  @returns {Promise<number>} how many records pushed successfully */
  function pushAllLocal({ all = false } = {}) {
    const ids = all || pendingPush.size === 0
      ? Object.keys(repository.listAllRaw())
      : [...pendingPush];
    return Promise.all(ids.map(id => syncCommitment(id))).then(results => results.filter(Boolean).length);
  }

  /** Test/diagnostic seam: what is still waiting to be pushed. */
  function pendingPushIds() {
    return [...pendingPush];
  }

  return {
    syncCommitment, attach, detach, pushAllLocal, pendingPushIds,
    handleRemoteRecord, handleRemoteSnapshot, repository,
    COMMITMENTS_REMOTE_PATH,
  };
}

// A ready-to-use singleton for the real app (index.html) only — constructing the
// default repository touches localStorage, which does not exist under plain
// `node --test`. Same guard and same room-ref accessor as
// operational-plan-sync.js. Tests build their own bridge with fake deps.
if (typeof window !== 'undefined') {
  window.CommitmentsSync = createCommitmentsSyncBridge({
    repository: window.CommitmentsRepository,
    getRoomRef: () => (typeof globalThis.fbRoomRef !== 'undefined' ? globalThis.fbRoomRef : null),
    onRemoteChange: () => globalThis.refreshCommitmentSurfaces?.(),
  });
}
