// plan-item-origin.js
//
// Pure. The plan-item side of the Brain Dump promotion fence (Brain Dump
// Production UX Correction V1, architecture fix #5). Shared by every plan store's
// sync bridge, Plan Authority's callers and Brain Dump itself, so all of them read
// one definition.
//
// ── why a fence ──────────────────────────────────────────────────────────────
// Plan writes are local-first: addItem lands in the writing device's localStorage
// and reaches Firebase whenever that device next reconnects, possibly much later.
// A Brain Dump promotion whose claim has since been superseded (its day ended and
// the capture went back to triage, or it was promoted again under a newer
// generation) must never be able to land its old plan item after the fact. So
// every plan item a Brain Dump promotion creates (id `bdp1|<captureId>`) carries
// `brainDumpOrigin`, and firebase.rules.json refuses any write of such an item
// unless rooms/<room>/brainDump/<captureId> CURRENTLY authorizes exactly that
// origin. The server rule is the correctness authority. The client-side guard
// below only stops a device from re-pushing (and showing) an item it already
// KNOWS is superseded, so it does not hammer Firebase with denied writes.
//
// ── brainDumpOrigin (version 1), immutable for the life of the item ─────────
//   { v: 1, claimEpoch, type, targetId }
//   claimEpoch: the capture's claimEpoch when the promotion was claimed (its generation)
//   type:       'do-today' | 'schedule'
//   targetId:   the ORIGINAL destination target id (the item may later be moved
//               by ordinary Plan Authority edits; the origin never changes)
// The capture id is the item id itself (`bdp1|<captureId>`), so it is never
// duplicated. when/durationMinutes stay ordinary editable plan fields: only one
// claim can exist per generation, so they never decide authorization.
//
// ── what authorizes an origin (mirrors firebase.rules.json exactly) ─────────
// The capture's claimEpoch (absent = 0) equals origin.claimEpoch, AND either
//   - its promotionClaim is outstanding, NOT revoked, with the same targetId
//     and type; or
//   - it is promoted, with the same promotion targetId and type.
// A revoked claim authorizes nothing: revoking is how an expired claim's
// destination is frozen before anyone reads it (see brain-dump-promotion.js).

export const BRAIN_DUMP_PLAN_ITEM_PREFIX = 'bdp1|';
export const BRAIN_DUMP_ORIGIN_VERSION = 1;

export function isBrainDumpPlanItemId(id) {
  return typeof id === 'string' && id.startsWith(BRAIN_DUMP_PLAN_ITEM_PREFIX);
}

/** The capture id a Brain Dump plan item belongs to, or null. */
export function captureIdOfPlanItem(id) {
  return isBrainDumpPlanItemId(id) ? id.slice(BRAIN_DUMP_PLAN_ITEM_PREFIX.length) : null;
}

/** Builds the origin for a promotion claimed at `claimEpoch`. */
export function brainDumpOrigin({ claimEpoch, type, targetId }) {
  return { v: BRAIN_DUMP_ORIGIN_VERSION, claimEpoch: Number.isInteger(claimEpoch) && claimEpoch >= 0 ? claimEpoch : 0, type, targetId };
}

/** A well-formed version-1 origin, or null. */
export function originOf(item) {
  const o = item?.brainDumpOrigin;
  if (!o || typeof o !== 'object' || o.v !== BRAIN_DUMP_ORIGIN_VERSION) return null;
  if (!Number.isInteger(o.claimEpoch) || o.claimEpoch < 0) return null;
  if (typeof o.type !== 'string' || typeof o.targetId !== 'string') return null;
  return { v: o.v, claimEpoch: o.claimEpoch, type: o.type, targetId: o.targetId };
}

/** Whether `capture` (a Brain Dump record, raw or normalized; null if unknown)
 *  currently authorizes the Brain Dump plan item `item`:
 *  'authorized' | 'superseded' (provably never again) | 'unknown'.
 *  'unknown' is never a reason to drop anything: the server decides. */
export function originAuthorization(item, capture) {
  const origin = originOf(item);
  if (!origin) return 'superseded'; // the rules refuse an un-fenced Brain Dump item outright
  if (!capture || typeof capture !== 'object') return 'unknown';
  const epoch = Number.isInteger(capture.claimEpoch) ? capture.claimEpoch : 0;
  // A capture's generation only ever moves forward. A newer one means this
  // origin's promotion was resolved (recovered) and can never be authorized again.
  if (epoch > origin.claimEpoch) return 'superseded';
  if (epoch < origin.claimEpoch) return 'unknown'; // this device's capture copy is behind
  const claim = capture.promotionClaim;
  if (claim && typeof claim === 'object') {
    if (claim.targetId !== origin.targetId || claim.type !== origin.type) return 'superseded';
    // Revoked: frozen while its outcome is resolved; it becomes promoted
    // (authorized again) or recovered (superseded).
    return claim.revokedAt ? 'unknown' : 'authorized';
  }
  if (capture.status === 'promoted' && capture.promotion) {
    return capture.promotion.targetId === origin.targetId && capture.promotion.type === origin.type ? 'authorized' : 'superseded';
  }
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
globalThis.PlanItemOrigin = { BRAIN_DUMP_PLAN_ITEM_PREFIX, BRAIN_DUMP_ORIGIN_VERSION, isBrainDumpPlanItemId, captureIdOfPlanItem, brainDumpOrigin, originOf, originAuthorization, setBrainDumpCaptureLookup, partitionOutboundItems };
