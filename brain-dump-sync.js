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
//
// ── claimPromotionRemote (FIX FIRST round 2) ────────────────────────────────
//
// Every OTHER write in this bridge is optimistic-local-first: the local write is
// already durable before any network round trip, exactly like every other store
// in this codebase (see pushCapture's own comment). Promotion is the one
// exception, because it is about to trigger an IRREVERSIBLE cross-store side
// effect (a real Plan Authority item): "claim succeeded" must mean the Firebase
// transaction actually committed against the CURRENT authoritative remote
// record, not merely that a local object was mutated. So, unlike pushCapture:
//   - NOTHING is written to the local repository before the transaction settles.
//   - no room ref / not this cache's room -> {ok:false, reason:'offline'}
//     immediately, with ZERO local writes — never a queued "fake success".
//   - the transaction's update function is arbitratePromotionClaim(), not the
//     general mergeCaptureRecords() pushCapture uses — see brain-dump-model.js's
//     file banner: a BRAND NEW claim must be refused outright if the remote
//     record is already a settled terminal state (archived/delegated/promoted),
//     never merely out-ranked-and-overwritten.
//
// ── timeout vs pending, and why the transaction is never abandoned (FIX FIRST
// round 3) ───────────────────────────────────────────────────────────────────
//
// A bounded timeout guards the FOREGROUND caller against the real Firebase
// SDK's documented behavior of a transaction() Promise that does not settle at
// all while genuinely offline. Round 2 treated a timeout as `reason:'offline'`
// — but that is a LIE: the transaction may still be running, and may commit a
// real authoritative claim seconds or minutes later, with nobody ever told.
// That is a GHOST CLAIM: an authoritative promotionClaim sitting on the remote
// record forever, blocking archive/delegate, with no plan item and no caller
// left to finish it.
//
// So the transaction (`attempt`) and the FOREGROUND caller's bounded wait are
// now two SEPARATE things:
//   - `attempt` is NEVER dropped. Its `.then()/.catch()` (finishClaimAttempt)
//     always runs, whenever it actually settles, regardless of whether the
//     foreground caller is still waiting. It is what eventually: (a) merges
//     the authoritative result into local cache via the ordinary
//     repository.mergeRemote() — but ONLY if this account's room is STILL the
//     active one at settlement time, never into whatever cache happens to be
//     active by then (see "account switch" below); and (b) fires the SAME
//     onRemoteChange hook every other merge already fires, which is what lets
//     brain-dump-ui.js notice a newly-authoritative claim and reconcile it —
//     see reconcilePromotionClaim in brain-dump-promotion.js — whether that
//     happens before or long after the original caller gave up.
//   - the foreground caller only ever races a VIEW of `settlement`'s own
//     eventual value against the timeout. If the timeout wins, this call
//     resolves `{ok:false, reason:'pending'}` — explicitly UNKNOWN, never a
//     claim that nothing happened and never a claim that it failed. Plan
//     Authority must never be touched on a 'pending' result.
//   - a genuine pre-flight refusal (no room ref, wrong room — the transaction
//     never even started) is the ONLY case that still reports `'offline'`: a
//     real, definite, immediate fact, not a guess about an in-flight op.
//   - a transport-level rejection (the Promise rejects outright, not merely
//     slow) is also a definite `'offline'` — the SDK itself reported failure,
//     unlike a timeout, which is this module's own impatience, not the SDK's.

import { createBrainDumpRepository } from './brain-dump-repository.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';
import { validBrainDumpId, mergeCaptureRecords, claimPromotion, arbitratePromotionClaim, promotedTo, samePromotionIntent } from './brain-dump-model.js';

const DEFAULT_CLAIM_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('brain-dump promotion claim timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const BRAIN_DUMP_REMOTE_PATH = 'brainDump';

export function createBrainDumpSyncBridge(deps = {}) {
  const repository = deps.repository || createBrainDumpRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  const getRoomId = typeof deps.getRoomId === 'function' ? deps.getRoomId : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};
  const onRebind = typeof deps.onRebind === 'function' ? deps.onRebind : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const deviceId = typeof deps.deviceId === 'function' ? deps.deviceId : () => 'unknown-device';
  const claimTimeoutMs = Number.isFinite(deps.claimTimeoutMs) ? deps.claimTimeoutMs : DEFAULT_CLAIM_TIMEOUT_MS;

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

  /** Processes the transaction's REAL, eventual outcome — always runs exactly
   *  once per attempt, whenever `attempt` actually settles, independent of
   *  whether the foreground caller is still waiting. Re-checks room ownership
   *  AT SETTLEMENT TIME (not just at call time): if the account has since
   *  switched away, this never merges into the wrong cache and never fires
   *  Plan Authority work for the wrong account — the claim stays exactly as
   *  authoritative on the remote record as it already was, for whichever
   *  account owns it to reconcile whenever it is active again. */
  function finishClaimAttempt(id, promotion, roomId, ownerLostRef, result) {
    if (ownerLostRef.lost || !roomOwnsCache(roomId) || !result || !result.snapshot) {
      return { ok: false, reason: 'offline' };
    }
    const authoritative = result.snapshot.val();
    const { changed, record } = repository.mergeRemote(id, authoritative);
    // The SAME hook every other merge fires. This is what lets brain-dump-ui.js
    // notice — and reconcile — a newly-authoritative claim, whether this runs
    // before or long after the original caller's own bounded wait gave up.
    if (changed) onRemoteChange(id, record);
    // Read AFTER onRemoteChange, never the pre-hook `record`: the hook may have
    // just reconciled (and finalized) this very claim.
    const finalRecord = repository.read(id) || record;
    // Checked BEFORE the committed/aborted branch deliberately: an idempotent
    // retry of a claim THIS device already won can "abort" (no change needed)
    // while still correctly reporting success.
    // Exact intent, never merely the same deterministic plan item: another
    // device's same-day Do Today vs this Schedule (or 14:00 vs 15:00) shares
    // store, targetId and planItemId, and must NOT read as this caller's win.
    if (samePromotionIntent(finalRecord?.promotionClaim, promotion)) return { ok: true, record: finalRecord };
    // Production UX Correction V1 — the root cause of the false "already being
    // promoted elsewhere". Real Firebase raises the whole-subtree 'value' event
    // for a committed transaction BEFORE resolving the transaction itself. That
    // listener merges our new claim, and onRemoteChange -> the UI's reconciler
    // then finishes it (plan item + finalize) before this function runs. By now
    // the record is already PROMOTED with exactly our intent and the claim
    // cleared. That is our own win, finished cooperatively, not a competing actor.
    if (promotedTo(finalRecord, promotion)) return { ok: true, record: finalRecord };
    // Lost: either refused by arbitratePromotionClaim (remote already settled,
    // or a competing claim's tie-break beat ours), or something else finished
    // first with a different intent.
    const reason = finalRecord && finalRecord.status !== 'untriaged' && finalRecord.status !== 'triaged' ? 'already-disposed' : 'already-claimed';
    return { ok: false, reason, record: finalRecord };
  }

  /** Establishes a BRAND NEW promotion claim against the AUTHORITATIVE REMOTE
   *  record — see the file banner. Must be awaited; PlanAuthority may only be
   *  touched once this resolves `ok:true`. A `reason:'pending'` result means
   *  the OUTCOME IS UNKNOWN — never treat it as failure, never treat it as
   *  permission to touch Plan Authority; see the file banner's round-3 section.
   *  @param {string} id
   *  @param {{type:'do-today'|'schedule', store:string, targetId:string, planItemId:string,
   *           when?:string, durationMinutes?:number}} promotion
   *  @returns {Promise<{ok:true, record:object} | {ok:false, reason:'offline'|'pending'|'already-claimed'|'already-disposed'|'not-found'|'invalid-input', record?:object}>} */
  function claimPromotionRemote(id, promotion) {
    if (!validBrainDumpId(id)) return Promise.resolve({ ok: false, reason: 'invalid-input' });
    const local = repository.read(id);
    if (!local) return Promise.resolve({ ok: false, reason: 'not-found' });
    // The SAME local eligibility check claimPromotion() always applied — refuses
    // immediately, with no network round trip, for a capture this device already
    // knows is disposed of or differently claimed. Does NOT write anything yet:
    // only the real transaction below is allowed to make the claim authoritative.
    const localCheck = claimPromotion(local, { promotion, now: now(), updatedBy: deviceId() });
    if (!localCheck.ok) return Promise.resolve(localCheck);
    const candidate = localCheck.record;

    const roomId = activeRoomId();
    const ref = captureRef(id);
    if (!ref || !roomOwnsCache(roomId)) {
      // Never even started — a genuine, definite "cannot reach authority right
      // now", not a guess about an in-flight operation. Never fake a win: no
      // local write at all, fully retryable the instant authority can be
      // established.
      return Promise.resolve({ ok: false, reason: 'offline' });
    }

    const ownerLostRef = { lost: false };
    const attempt = ref.transaction(remote => {
      ownerLostRef.lost = !roomOwnsCache(roomId);
      if (ownerLostRef.lost) return undefined;
      return arbitratePromotionClaim(remote, candidate);
    }, undefined, false);

    // NEVER dropped: this runs to completion whenever the transaction actually
    // settles, independent of the foreground race below.
    const settlement = attempt
      .then(result => finishClaimAttempt(id, promotion, roomId, ownerLostRef, result))
      .catch(() => finishClaimAttempt(id, promotion, roomId, ownerLostRef, null));

    return withTimeout(settlement, claimTimeoutMs)
      // The timeout fired first: the REAL outcome above is still being awaited
      // by `settlement` itself and will be processed when it lands — this call
      // merely stops waiting for it. Explicitly UNKNOWN, never offline/failure.
      .catch(() => ({ ok: false, reason: 'pending', record: local }));
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
    syncCapture, pushCapture, claimPromotionRemote, attach, detach, pushAllLocal, pendingPushIds,
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
    deviceId: () => globalThis.syncedDeviceId || 'unknown-device',
    // (id, record) passed through — brain-dump-ui.js's reconcilePromotionClaim
    // trigger (FIX FIRST round 3) needs to know WHICH capture changed.
    onRemoteChange: (id, record) => globalThis.refreshBrainDumpSurfaces?.(id, record),
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
