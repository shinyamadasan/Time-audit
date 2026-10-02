// brain-dump-promotion.js
//
// Promotes a Brain Dump capture into the existing authoritative planning path —
// Plan Authority — never around it. This is the ONLY place a capture becomes a
// plan item, for both "Do Today" and "Schedule" (they differ only in which target
// Plan Authority resolves).
//
// ── three phases, and why (FIX FIRST round 2: phase 1 is now REMOTE-FIRST) ──
// 1. CLAIM (claimPromotionRemote, injected — brain-dump-sync.js owns it):
//    establishes the claim against the AUTHORITATIVE REMOTE capture record via
//    a real Firebase transaction, BEFORE Plan Authority is ever touched — see
//    brain-dump-sync.js's and brain-dump-model.js's file banners. "Claim
//    succeeded" means the server accepted it against current remote truth, not
//    merely that a local object was mutated: a client that still sees TRIAGED
//    locally because it is stale or offline can never mint a winning claim over
//    a remote that has ALREADY moved to archived/delegated/promoted. This
//    function is therefore async — it genuinely waits on a network round trip
//    (bounded by a timeout — see brain-dump-sync.js) before proceeding.
// 2. CREATE (planAuthority.addItem): idempotent — checks rawItems() for the
//    DETERMINISTIC plan-item id (brainDumpPlanItemId, a pure function of the
//    capture's own immutable id, never minted fresh) before writing, so a retry
//    after a crash, or a second device racing the identical claim, never
//    duplicates the plan item. Only ever reached AFTER phase 1 has confirmed
//    the claim against authoritative remote state.
// 3. FINALIZE (repository.finalizePromotion): local-first — by this point the
//    claim is already authoritative and the plan item already exists, so there
//    is no new side effect left to protect; finalizing locally and letting the
//    ordinary sync bridge push it (same as every other write in this codebase)
//    is safe and avoids a second remote round trip. Reads the destination back
//    OFF THE CAPTURE'S OWN CLAIM (never a freshly-built object).
//
// ── crash-window recovery ─────────────────────────────────────────────────────
// A crash/reload between any two phases is safe to retry, from this device or
// another: phase 1 is itself idempotent for the SAME claim (a different
// outstanding claim refuses instead of competing — and the remote gate means
// this is now checked authoritatively, not just locally), phase 2 is idempotent
// via the deterministic id, and phase 3 only ever reads the claim already on
// the record — it cannot diverge from what phase 2 actually created. Archive/
// delegate cannot erase this evidence: they refuse the instant a claim exists
// locally, and the claim itself is sticky until finalized.
//
// ── offline / claim refused ───────────────────────────────────────────────────
// If phase 1 cannot establish the claim (offline, timed out, or genuinely lost
// to an already-authoritative terminal state or a competing claim), this
// function returns {ok:false, ...} WITHOUT ever touching Plan Authority. No
// plan item is created, the capture is left exactly as it was (fully
// retryable), and the caller surfaces an explicit non-success result rather
// than a fake success.

import { brainDumpPlanItemId } from './brain-dump-model.js';

/** @param {{repository:object, planAuthority:object, claimPromotionRemote:function, id:string,
 *           type:'do-today'|'schedule', dateKey?:string, when?:string, durationMinutes?:number,
 *           now:number, deviceId:string}} input
 *  @returns {Promise<{ok:true, record:object, alreadyDisposed?:boolean} | {ok:false, reason:string, record?:object}>} */
export async function promoteCaptureToPlan(input = {}) {
  const { repository, planAuthority, claimPromotionRemote, id, type, dateKey, when = '', durationMinutes, now, deviceId } = input;
  if (!repository || !planAuthority || typeof claimPromotionRemote !== 'function') return { ok: false, reason: 'invalid-input' };
  const current = repository.read(id);
  if (!current) return { ok: false, reason: 'not-found' };
  if (current.status !== 'untriaged' && current.status !== 'triaged') {
    // Already promoted/archived/delegated — never re-promote. The caller reads the
    // existing record (including `promotion`, if it was promoted) off this result.
    return { ok: true, record: current, alreadyDisposed: true };
  }

  let target;
  try {
    if (type === 'do-today') {
      target = planAuthority.current();
      if (!target) return { ok: false, reason: 'no-authoritative-day' };
    } else if (type === 'schedule') {
      const resolved = planAuthority.dayForScheduledDate(dateKey, when || '');
      if (!resolved.ok) return { ok: false, reason: resolved.reason || 'invalid-schedule' };
      target = resolved.target;
    } else {
      return { ok: false, reason: 'invalid-input', field: 'type' };
    }
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const planItemId = brainDumpPlanItemId(id);

  // Phase 1: REMOTE CLAIM GATE — authoritative, before Plan Authority is
  // touched. Never fakes success: offline/timeout/refusal all come back here
  // as ok:false with no local or remote write having happened for THIS attempt.
  const claim = await claimPromotionRemote(id, { type, store: target.store, targetId: target.id, planItemId });
  if (!claim.ok) {
    // 'offline' | 'already-disposed' | 'already-claimed' | 'not-found' |
    // 'invalid-input' — none of them ever reach Plan Authority.
    return claim;
  }
  const winningClaim = claim.record?.promotionClaim;
  if (!winningClaim || winningClaim.store !== target.store || winningClaim.targetId !== target.id || winningClaim.planItemId !== planItemId) {
    // Our claim did not win the merge (a concurrent claim for a different target
    // was earlier/authoritative). Never create a second, competing plan item.
    return { ok: false, reason: 'already-claimed', record: claim.record };
  }

  // Phase 2: CREATE — idempotent via the deterministic id. Only reached after
  // the claim is confirmed authoritative.
  const alreadyCreated = planAuthority.rawItems(target).some(item => item.id === planItemId);
  if (!alreadyCreated) {
    const item = {
      id: planItemId,
      task: claim.record.text,
      when: when || '',
      done: false,
      doneAt: null,
      updatedAt: now,
      updatedBy: deviceId,
      kind: 'task',
    };
    if (Number.isFinite(durationMinutes)) item.durationMinutes = durationMinutes;
    try {
      planAuthority.addItem({ destination: target, item, nowMs: now });
    } catch (err) {
      // The claim stays recorded (authoritatively, remotely); a retry (this
      // device or another) recovers from the SAME claim rather than losing
      // track of the attempt, and archive/delegate stay refused in the meantime.
      return { ok: false, reason: err.message, record: claim.record };
    }
  }

  // Phase 3: FINALIZE — local-first (safe: the claim is already authoritative
  // and the plan item already exists); reads the destination off the claim
  // already on the record.
  const finalized = repository.finalizePromotion(id, { now, updatedBy: deviceId });
  if (!finalized.ok && finalized.reason === 'already-disposed') {
    return { ok: true, record: finalized.record, alreadyDisposed: true };
  }
  if (!finalized.ok) return finalized;
  return { ok: true, record: finalized.record };
}
