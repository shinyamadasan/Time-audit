// plan-by-deadline-sync.js
//
// Durable cross-device copy of the Plan-by-deadline revision history and the
// Intentional Off-Day records, on top of the local-only
// plan-by-deadline-repository.js. Mirrors operational-plan-sync.js's shape
// (per-child `update()` writes + a collection-level `on('value')` listener,
// merged locally via the repository's own deterministic merge functions) —
// not personal-day-boundary-sync.js's whole-collection Firebase `.transaction()`,
// because that machinery exists specifically to close a race between two
// devices independently proposing a revision with the SAME effective instant
// under DIFFERENT ids, observed as a real historical bug for that subsystem.
// A deadline/off-day change is a rare, single-user action; each device writes
// its own randomly-generated id/dateKey as its own child key, so two devices
// can never contend for the same Firebase write, and the repository's merge
// functions (already deterministic and order-independent — see
// plan-by-deadline-model.test.js / plan-by-deadline-repository.test.js) give
// the same converged outcome without needing a stricter transaction boundary.
//
// Remote paths (both room-scoped children, already covered by the existing
// wide-open `rooms/$roomId` rule in firebase.rules.json — no rules change):
//   rooms/<roomCode>/planByDeadlineRevisions/<revisionId>
//   rooms/<roomCode>/intentionalOffDays/<dateKey>
// (dateKey is already Firebase-key-safe: YYYY-MM-DD contains no illegal chars.)
//
// ── account scope ────────────────────────────────────────────────────────
// Same discipline as operational-plan-sync.js / personal-day-boundary-sync.js:
//   - PUSH refuses ('owner-mismatch', zero writes) unless the joined room
//     equals the repository's active cache owner.
//   - PULL/listener snapshots are merged only while that room is still joined
//     and its cache is still active; a late callback from a superseded room
//     is dropped.
//   - Attaching while listeners from a different room exist (a direct account
//     switch) drops them all first.

import { createPlanByDeadlineRepository } from './plan-by-deadline-repository.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';

export const PLAN_BY_DEADLINE_REVISIONS_REMOTE_PATH = 'planByDeadlineRevisions';
export const INTENTIONAL_OFF_DAYS_REMOTE_PATH = 'intentionalOffDays';

export function createPlanByDeadlineSyncBridge(deps = {}) {
  const repository = deps.repository || createPlanByDeadlineRepository();
  const getRoomRef = typeof deps.getRoomRef === 'function' ? deps.getRoomRef : () => null;
  const getRoomId = typeof deps.getRoomId === 'function' ? deps.getRoomId : () => null;
  const onRemoteChange = typeof deps.onRemoteChange === 'function' ? deps.onRemoteChange : () => {};

  let deadlineListener = null; // { ref, roomId, token }
  let offDayListener = null;
  let listenerToken = 0;

  function activeRoomId() {
    const roomId = getRoomId();
    return typeof roomId === 'string' && roomId ? roomId : null;
  }

  function cacheOwner() {
    return typeof repository.ownerRoomId === 'function' ? repository.ownerRoomId() : null;
  }

  function roomOwnsCache(roomId) {
    return !!roomId && roomId === activeRoomId() && cacheOwner() === roomId;
  }

  function collectionRefFor(roomRef, path) {
    try {
      const ref = roomRef.child(path);
      return typeof ref.update === 'function' ? ref : null;
    } catch {
      return null;
    }
  }

  // ── deadline revisions ──────────────────────────────────────────────────

  /** Pushes every locally known deadline revision, each as its own child key
   *  (an id never collides across devices — crypto.randomUUID), so concurrent
   *  pushes from different devices never contend for the same Firebase write.
   *  @returns {Promise<{committed:boolean, outcome:string}>} */
  function pushAllDeadlines() {
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    if (!roomRef) return Promise.resolve({ committed: false, outcome: 'skipped' });
    if (!roomOwnsCache(roomId)) return Promise.resolve({ committed: false, outcome: 'owner-mismatch' });
    const local = repository.listAllDeadlinesRaw();
    if (!local.length) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const ref = collectionRefFor(roomRef, PLAN_BY_DEADLINE_REVISIONS_REMOTE_PATH);
    if (!ref) return Promise.resolve({ committed: false, outcome: 'transport-failure' });
    const updates = {};
    local.forEach(rev => { updates[rev.id] = rev; });
    return Promise.resolve(ref.update(updates))
      .then(() => ({ committed: true, outcome: 'committed' }))
      .catch(() => ({ committed: false, outcome: 'transport-failure' }));
  }

  /** Merges one inbound whole-collection snapshot for deadline revisions. Applied
   *  only while `roomId` is still the joined, cache-owning room. */
  function handleRemoteDeadlineSnapshot(val, roomId = activeRoomId()) {
    if (!roomOwnsCache(roomId)) return false;
    if (!val || typeof val !== 'object') return true;
    const result = repository.mergeRemoteDeadlines(val);
    if (result.changed) onRemoteChange('deadlines', result);
    return true;
  }

  function attachDeadlines() {
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    if (!roomRef || !roomId) return;
    if (deadlineListener && deadlineListener.roomId !== roomId) detachDeadlines();
    if (deadlineListener) return;
    const ref = collectionRefFor(roomRef, PLAN_BY_DEADLINE_REVISIONS_REMOTE_PATH);
    if (!ref || typeof ref.on !== 'function') return;
    const token = ++listenerToken;
    deadlineListener = { ref, roomId, token };
    ref.on('value', snap => {
      if (deadlineListener?.token !== token) return; // detached or superseded
      handleRemoteDeadlineSnapshot(typeof snap.val === 'function' ? snap.val() : null, roomId);
    });
  }

  function detachDeadlines() {
    if (deadlineListener) deadlineListener.ref.off();
    deadlineListener = null;
  }

  // ── intentional off-days ─────────────────────────────────────────────────

  /** @returns {Promise<{committed:boolean, outcome:string}>} */
  function pushAllOffDays() {
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    if (!roomRef) return Promise.resolve({ committed: false, outcome: 'skipped' });
    if (!roomOwnsCache(roomId)) return Promise.resolve({ committed: false, outcome: 'owner-mismatch' });
    const local = repository.listAllOffDaysRaw();
    if (!local.length) return Promise.resolve({ committed: false, outcome: 'skipped' });
    const ref = collectionRefFor(roomRef, INTENTIONAL_OFF_DAYS_REMOTE_PATH);
    if (!ref) return Promise.resolve({ committed: false, outcome: 'transport-failure' });
    const updates = {};
    local.forEach(rec => { updates[rec.dateKey] = rec; });
    return Promise.resolve(ref.update(updates))
      .then(() => ({ committed: true, outcome: 'committed' }))
      .catch(() => ({ committed: false, outcome: 'transport-failure' }));
  }

  function handleRemoteOffDaySnapshot(val, roomId = activeRoomId()) {
    if (!roomOwnsCache(roomId)) return false;
    if (!val || typeof val !== 'object') return true;
    const result = repository.mergeRemoteOffDays(val);
    if (result.changed) onRemoteChange('offDays', result);
    return true;
  }

  function attachOffDays() {
    const roomRef = getRoomRef();
    const roomId = activeRoomId();
    if (!roomRef || !roomId) return;
    if (offDayListener && offDayListener.roomId !== roomId) detachOffDays();
    if (offDayListener) return;
    const ref = collectionRefFor(roomRef, INTENTIONAL_OFF_DAYS_REMOTE_PATH);
    if (!ref || typeof ref.on !== 'function') return;
    const token = ++listenerToken;
    offDayListener = { ref, roomId, token };
    ref.on('value', snap => {
      if (offDayListener?.token !== token) return;
      handleRemoteOffDaySnapshot(typeof snap.val === 'function' ? snap.val() : null, roomId);
    });
  }

  function detachOffDays() {
    if (offDayListener) offDayListener.ref.off();
    offDayListener = null;
  }

  function attachAll() { attachDeadlines(); attachOffDays(); }
  function detachAll() { detachDeadlines(); detachOffDays(); }

  return {
    pushAllDeadlines, handleRemoteDeadlineSnapshot, attachDeadlines, detachDeadlines,
    pushAllOffDays, handleRemoteOffDaySnapshot, attachOffDays, detachOffDays,
    attachAll, detachAll, repository,
  };
}

// A ready-to-use singleton for the real app (index.html) only — constructing it
// touches localStorage (via the default repository), which does not exist under
// plain `node --test`. Same guard as operational-plan-sync.js.
if (typeof window !== 'undefined') {
  window.PlanByDeadlineSync = createPlanByDeadlineSyncBridge({
    getRoomRef: () => (typeof globalThis.getChronaSenseRoomRef === 'function' ? globalThis.getChronaSenseRoomRef() : null),
    getRoomId: appRoomOwner,
    onRemoteChange: () => {
      if (window.PlanAuthority) window.PlanAuthority.invalidate();
      if (typeof globalThis.refreshAuthoritativePlanSurfaces === 'function') globalThis.refreshAuthoritativePlanSurfaces();
    },
  });
}
