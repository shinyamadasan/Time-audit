// plan-item-origin.js
//
// Pure. The plan-item side of the Brain Dump promotion fence (Location-Bound Brain
// Dump Promotion Fence V1, DECISIONS #33; supersedes the array-indexed fence of
// #32). Shared by every plan store's sync bridge, Plan Authority and Brain Dump
// itself, so all of them read ONE definition.
//
// ── what a fence is ──────────────────────────────────────────────────────────
// A Brain Dump promotion creates exactly one plan item, id `bdp1|<captureId>`,
// and that item is bound to ONE physical location for its whole life:
//
//     store  : 'calendar' | 'operational' | 'legacy'
//     target : the plan record that owns it (the Firebase child key of that record)
//
// Plan writes are local-first and can reach Firebase arbitrarily late, so a stale
// device must never be able to land an item after its promotion was superseded.
// Realtime Database can only authorise a child it can ADDRESS, and a plan record's
// `items` array is re-sorted by id on every write (its numeric child positions are
// not stable), so the server cannot name "this exact item" inside it. A fenced
// item therefore lives at a stable key OUTSIDE the plan record:
//
//     rooms/<room>/calendarPlanFences/<planId>/bdp1|<captureId>
//     rooms/<room>/operationalPlanFences/<base64url(operationalDayId)>/bdp1|<captureId>
//     rooms/<room>/planFences/<dateKey>/bdp1|<captureId>
//
// That path IS the authorization identity (store + target + item id). The record
// holds the whole plan item — one authoritative copy, never mirrored into the
// plan's `items` array. The local app keeps exposing one array: the sync
// boundary folds the keyed children into it on read and splits them out on
// write (plan-fence-sync.js). An old client never sees the fence collections, so
// its whole-record transactions can neither erase nor reorder a fenced item.
//
// ── brainDumpOrigin (version 2), immutable for the life of the item ─────────
//   { v: 2, claimEpoch, type, store, targetKey }
//   claimEpoch: the capture's generation when the promotion was claimed
//   type:       'do-today' | 'schedule' (immutable provenance)
//   store, targetKey: the physical location. The server requires them to equal
//               the path the item is written to, so they are provenance that the
//               rules verify, never trust.
// The capture id is the item id's suffix, so it is never duplicated. The
// ordinary fields (task, when, whenDayOffset, durationMinutes, done, kind, ...)
// stay freely editable; they never decide authorization.
//
// ── what authorizes a fenced item (mirrors firebase.rules.json exactly) ──────
// The capture's claimEpoch (absent = 0) equals origin.claimEpoch, AND either
//   - its promotionClaim is outstanding, NOT revoked, with the same
//     (planItemId, store, targetKey, type); or
//   - it is promoted, with the same promotion (planItemId, store, targetKey, type).
// A revoked claim authorizes nothing: revoking is how an ended claim's
// destination is frozen before anyone reads it (see brain-dump-promotion.js).
//
// ── legacy (pre-fence) Brain Dump items ──────────────────────────────────────
// A claim/promotion WITHOUT a targetKey was made by a client that predates the
// fence. Its item is an ordinary array item with no origin, and it is NOT
// location-bound (it may legitimately have been moved by an ordinary edit):
// the rules authorize it by capture state alone. It is never fabricated into a
// fenced item.

export const BRAIN_DUMP_PLAN_ITEM_PREFIX = 'bdp1|';
/** A Brain Dump task is bound to the one plan it was promoted into: its authorization identity is a physical
 *  location, so V1 refuses every cross-target move (Plan Authority's API, the task editor and the server all say
 *  no) instead of weakening the fence. Timing may still cross midnight inside the same plan (a later End,
 *  whenDayOffset), which is not a move. */
export const BRAIN_DUMP_MOVE_REFUSED = "Brain Dump tasks can't be moved to another day yet.";
export const BRAIN_DUMP_ORIGIN_VERSION = 2;
export const FENCE_STORES = Object.freeze(['calendar', 'operational', 'legacy']);
/** Where each store's fenced items live, next to (never inside) the plan records. */
export const FENCE_REMOTE_PATHS = Object.freeze({ calendar: 'calendarPlanFences', operational: 'operationalPlanFences', legacy: 'planFences' });

const CAPTURE_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const CALENDAR_TARGET_RE = /^cal1:\d{4}-\d{2}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_KEY_RE = /^[A-Za-z0-9_-]+$/;

export function isBrainDumpPlanItemId(id) {
  return typeof id === 'string' && id.startsWith(BRAIN_DUMP_PLAN_ITEM_PREFIX);
}

/** The capture id a Brain Dump plan item belongs to, or null (also null for a malformed suffix). */
export function captureIdOfPlanItem(id) {
  if (!isBrainDumpPlanItemId(id)) return null;
  const suffix = id.slice(BRAIN_DUMP_PLAN_ITEM_PREFIX.length);
  return CAPTURE_ID_RE.test(suffix) ? suffix : null;
}

function base64url(text) {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The physical Firebase child key of a plan target, from PlanAuthority's own target
 *  identity (target.store, target.id) — never guessed from a display date. Calendar and
 *  legacy keys are the id itself; an operational day id embeds '/' (an IANA zone), so its
 *  key is base64url (identical to operational-plan-sync.js's toFirebaseSafeKey).
 *  @returns {string|null} null for a store/id this contract cannot key */
export function physicalTargetKey(store, targetId) {
  if (typeof targetId !== 'string' || !targetId) return null;
  if (store === 'calendar') return CALENDAR_TARGET_RE.test(targetId) ? targetId : null;
  if (store === 'legacy') return DATE_RE.test(targetId) ? targetId : null;
  if (store === 'operational') {
    try { const key = base64url(targetId); return SAFE_KEY_RE.test(key) ? key : null; } catch { return null; }
  }
  return null;
}

/** Builds the origin for a promotion claimed at `claimEpoch` for the given physical location. */
export function brainDumpOrigin({ claimEpoch, type, store, targetKey }) {
  return { v: BRAIN_DUMP_ORIGIN_VERSION, claimEpoch: Number.isInteger(claimEpoch) && claimEpoch >= 0 ? claimEpoch : 0, type, store, targetKey };
}

/** A well-formed version-2 origin, or null. */
export function originOf(item) {
  const o = item?.brainDumpOrigin;
  if (!o || typeof o !== 'object' || o.v !== BRAIN_DUMP_ORIGIN_VERSION) return null;
  if (!Number.isInteger(o.claimEpoch) || o.claimEpoch < 0) return null;
  if (typeof o.type !== 'string' || !FENCE_STORES.includes(o.store) || typeof o.targetKey !== 'string' || !o.targetKey) return null;
  return { v: o.v, claimEpoch: o.claimEpoch, type: o.type, store: o.store, targetKey: o.targetKey };
}

/** True for a Brain Dump item carrying a valid origin: it belongs in a fence collection,
 *  never in a plan record's `items` array. */
export function isFencedItem(item) {
  return !!item && captureIdOfPlanItem(item.id) !== null && originOf(item) !== null;
}

/** True when two items have the same immutable origin (both well-formed). */
export function sameOrigin(a, b) {
  const x = originOf(a);
  const y = originOf(b);
  return !!x && !!y && x.claimEpoch === y.claimEpoch && x.type === y.type && x.store === y.store && x.targetKey === y.targetKey;
}

/** Splits a plan's items for the wire: ordinary items go into the plan record, fenced
 *  items each to their own stable child. A bdp1 item without a valid origin is ordinary
 *  (a legacy item); the server decides it by capture state. */
export function splitFencedItems(items) {
  const ordinary = [];
  const fenced = [];
  for (const item of Array.isArray(items) ? items : []) (isFencedItem(item) ? fenced : ordinary).push(item);
  return { ordinary, fenced };
}

// ── fenced-item merge (the ONLY merge a fenced item ever gets) ───────────────
// The store-wide per-item merge is last-writer-wins by updatedAt. A fenced item needs three stricter
// laws, mirroring the server's rules, or a stale device could win locally what the server will refuse:
//   1. a newer generation (claimEpoch) supersedes an older one outright;
//   2. `deleted: true` is monotonic: a tombstone beats any live copy, whatever its updatedAt;
//   3. a fenced item beats an un-fenced array item of the same id (the fence is the authority for it).
// Everything else (same generation, both live or both tombstoned) is the store's own per-item choice,
// passed in as `choose`.

function originRank(item) {
  const origin = originOf(item);
  return origin ? JSON.stringify([origin.claimEpoch, origin.type, origin.store, origin.targetKey]) : '';
}

/** @param {object|null} a @param {object|null} b @param {(a:object,b:object)=>object} choose the store's per-item choice @returns {object|null} */
export function mergeFencedItem(a, b, choose) {
  if (!a) return b || null;
  if (!b) return a;
  const left = originOf(a);
  const right = originOf(b);
  if (!!left !== !!right) return left ? a : b;
  if (left && right && left.claimEpoch !== right.claimEpoch) return left.claimEpoch > right.claimEpoch ? a : b;
  if (left && right && !sameOrigin(a, b)) return originRank(a) >= originRank(b) ? a : b; // one claim per generation: not reachable on a healthy server
  if ((a.deleted === true) !== (b.deleted === true)) return a.deleted === true ? a : b;
  return choose(a, b);
}

/** Folds remote fenced items into a local item list with mergeFencedItem. Never removes a local item.
 *  @returns {{items:object[], changed:boolean}} */
export function foldFencedItems(localItems, remoteItems, choose) {
  const byId = new Map((Array.isArray(localItems) ? localItems : []).filter(item => item && item.id).map(item => [item.id, item]));
  let changed = false;
  for (const remote of Array.isArray(remoteItems) ? remoteItems : []) {
    if (!remote || !remote.id) continue;
    const local = byId.get(remote.id);
    const next = local ? mergeFencedItem(local, remote, choose) : remote;
    if (!local || JSON.stringify(next) !== JSON.stringify(local)) { byId.set(remote.id, next); changed = true; }
  }
  return { items: [...byId.values()].sort((x, y) => (x.id === y.id ? 0 : x.id < y.id ? -1 : 1)), changed };
}

/** The fenced items of a fence child's snapshot value ({ [itemId]: item }), ignoring anything that is not
 *  a well-formed fenced item whose key matches its id. */
export function fencedItemsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).filter(([key, item]) => item && typeof item === 'object' && item.id === key && isFencedItem(item)).map(([, item]) => item);
}

/** Exact remote presence of ONE fenced item, from the value of its exact server child.
 *  'absent' only for a genuinely missing child; a child that exists but is not exactly
 *  the expected item (wrong id, origin epoch/store/target/type) is 'unknown' — a conflict
 *  is never "present" and never "absent". A tombstone is present: it was written.
 *  @param {*} value  snapshot.val() of rooms/<room>/<fence collection>/<targetKey>/<itemId>
 *  @param {{itemId:string, claimEpoch:number, type:string, store:string, targetKey:string}} expected
 *  @returns {'present'|'absent'|'unknown'} */
export function fencedPresence(value, expected) {
  if (value === null || value === undefined) return 'absent';
  if (typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  if (value.id !== expected.itemId) return 'unknown';
  const origin = originOf(value);
  if (!origin) return 'unknown';
  return origin.claimEpoch === expected.claimEpoch && origin.type === expected.type && origin.store === expected.store && origin.targetKey === expected.targetKey
    ? 'present' : 'unknown';
}

/** Whether `capture` (a Brain Dump record, raw or normalized; null if unknown)
 *  currently authorizes the Brain Dump plan item `item`:
 *  'authorized' | 'superseded' (provably never again) | 'unknown'.
 *  Only a queue-guard optimisation: 'unknown' is never a reason to drop anything,
 *  the server decides. */
export function originAuthorization(item, capture) {
  const origin = originOf(item);
  if (!capture || typeof capture !== 'object') return 'unknown';
  const epoch = Number.isInteger(capture.claimEpoch) ? capture.claimEpoch : 0;
  if (!origin) {
    // An un-fenced Brain Dump item: an ordinary array item the rules authorize by capture state alone, and
    // only for a PRE-fence claim or promotion (one with no targetKey) naming this very item.
    const state = capture.promotionClaim || (capture.status === 'promoted' ? capture.promotion : null);
    if (state && typeof state === 'object') {
      if (state.targetKey || state.planItemId !== item.id) return 'superseded'; // a fenced capture, or another item's claim
      return capture.promotionClaim && capture.promotionClaim.revokedAt ? 'unknown' : 'authorized';
    }
    // Neither claimed nor promoted. A capture that has been RECOVERED (epoch > 0) can never authorize the
    // item of its old claim again; at epoch 0 this device's copy may simply be behind.
    return epoch > 0 ? 'superseded' : 'unknown';
  }
  // A capture's generation only ever moves forward. A newer one means this
  // origin's promotion was resolved (recovered) and can never be authorized again.
  if (epoch > origin.claimEpoch) return 'superseded';
  if (epoch < origin.claimEpoch) return 'unknown'; // this device's capture copy is behind
  const matches = state => !!state && typeof state === 'object' && state.planItemId === item.id && state.store === origin.store
    && state.targetKey === origin.targetKey && state.type === origin.type;
  const claim = capture.promotionClaim;
  if (claim && typeof claim === 'object') {
    if (!matches(claim)) return 'superseded';
    // Revoked: frozen while its outcome is resolved; it becomes promoted
    // (authorized again) or recovered (superseded).
    return claim.revokedAt ? 'unknown' : 'authorized';
  }
  if (capture.status === 'promoted' && capture.promotion) return matches(capture.promotion) ? 'authorized' : 'superseded';
  // Same generation, no claim, not promoted: the claim this item came from never
  // won (or this copy predates it). Only the server can tell.
  return 'unknown';
}

// ── client-side queue guard ─────────────────────────────────────────────────
// Brain Dump registers how to look up a capture on this device. Each plan sync
// bridge calls partitionOutboundItems() on what it is about to push. A plan
// store never imports Brain Dump: the dependency points one way only.

let captureLookup = null;

/** @param {(captureId:string) => object|null} lookup  null to unregister. */
export function setBrainDumpCaptureLookup(lookup) {
  captureLookup = typeof lookup === 'function' ? lookup : null;
}

/** Splits a plan's items into those to push and the Brain Dump items this device
 *  KNOWS are superseded (to purge from its own cache instead of pushing). With
 *  no lookup registered, or for any non-Brain-Dump item, nothing is withheld.
 *  @returns {{kept:object[], superseded:string[]}} */
export function partitionOutboundItems(items) {
  return partitionOutboundItemsWith(items, captureLookup);
}

/** partitionOutboundItems with an explicit capture lookup (one device's own Brain
 *  Dump cache), for a sync bridge that is given its own. */
export function partitionOutboundItemsWith(items, lookup) {
  const list = Array.isArray(items) ? items : [];
  if (typeof lookup !== 'function') return { kept: list, superseded: [] };
  const captureLookup = lookup;
  const kept = [];
  const superseded = [];
  for (const item of list) {
    const captureId = item ? captureIdOfPlanItem(item.id) : null;
    if (!captureId) { kept.push(item); continue; }
    let capture = null;
    try { capture = captureLookup(captureId); } catch { capture = null; }
    if (originAuthorization(item, capture) === 'superseded') superseded.push(item.id);
    else kept.push(item);
  }
  return { kept, superseded };
}

// storage.js (the legacy plan store's sync) is a classic script and cannot import
// this module; it reads the same functions from here.
globalThis.PlanItemOrigin = {
  BRAIN_DUMP_PLAN_ITEM_PREFIX, BRAIN_DUMP_MOVE_REFUSED, BRAIN_DUMP_ORIGIN_VERSION, FENCE_STORES, FENCE_REMOTE_PATHS, isBrainDumpPlanItemId, captureIdOfPlanItem, physicalTargetKey,
  brainDumpOrigin, originOf, isFencedItem, sameOrigin, splitFencedItems, mergeFencedItem, foldFencedItems, fencedItemsOf, fencedPresence, originAuthorization, setBrainDumpCaptureLookup, partitionOutboundItems,
};
