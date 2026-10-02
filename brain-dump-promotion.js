// brain-dump-promotion.js
//
// Promotes a Brain Dump capture into the existing authoritative planning path —
// Plan Authority — never around it. This is the ONLY place a capture becomes a
// plan item, for both "Do Today" and "Schedule" (they differ only in which target
// Plan Authority resolves).
//
// ── three phases, and why ─────────────────────────────────────────────────────
// 1. CLAIM (repository.claimPromotion): records the intended (store, targetId,
//    planItemId) on the capture BEFORE Plan Authority is ever touched. This is the
//    arbitration point — see brain-dump-model.js's file banner for the full
//    promote-vs-archive/delegate race fix. Once this lands, archiveCapture()/
//    delegateCapture() refuse outright (fail closed) for this capture, and
//    mergeCaptureRecords ranks a claim above an archived/delegated status, so a
//    concurrent archive/delegate can never strand this promotion without
//    provenance, regardless of updatedAt ordering.
// 2. CREATE (planAuthority.addItem): idempotent — checks rawItems() for the
//    DETERMINISTIC plan-item id (brainDumpPlanItemId, a pure function of the
//    capture's own immutable id, never minted fresh) before writing, so a retry
//    after a crash, or a second device racing the identical claim, never
//    duplicates the plan item.
// 3. FINALIZE (repository.finalizePromotion): reads the destination back OFF THE
//    CAPTURE'S OWN CLAIM (never a freshly-built object), sets status:'promoted'
//    and clears the claim.
//
// ── crash-window recovery ─────────────────────────────────────────────────────
// A crash/reload between any two phases is safe to retry, from this device or
// another: phase 1 is itself idempotent for the SAME claim (a different
// outstanding claim refuses instead of competing), phase 2 is idempotent via the
// deterministic id, and phase 3 only ever reads the claim already on the record —
// it cannot diverge from what phase 2 actually created. Archive/delegate cannot
// erase this evidence: they refuse the instant a claim exists, and the claim
// itself is sticky until finalized (see brain-dump-model.js for the authority-rank
// merge that holds even across a late-arriving stale snapshot).
//
// ── if our own claim lost ─────────────────────────────────────────────────────
// Two devices can each try to claim a DIFFERENT promotion (e.g. Do Today on one,
// Schedule-to-another-date on the other) for the same capture before either has
// seen the other's attempt. Only one claim survives the repository's own
// LWW+tie-break (brain-dump-model.js: earliest claimedAt wins). If the record
// read back after claiming does not match what THIS call asked for, this call's
// claim lost — it reports 'already-claimed' and creates nothing; the winning
// device's own call (or its retry) is the one that creates the plan item and
// finalizes.

import { brainDumpPlanItemId } from './brain-dump-model.js';

/** @param {{repository:object, planAuthority:object, id:string, type:'do-today'|'schedule',
 *           dateKey?:string, when?:string, durationMinutes?:number, now:number, deviceId:string}} input
 *  @returns {{ok:true, record:object, alreadyDisposed?:boolean} | {ok:false, reason:string, record?:object}} */
export function promoteCaptureToPlan(input = {}) {
  const { repository, planAuthority, id, type, dateKey, when = '', durationMinutes, now, deviceId } = input;
  if (!repository || !planAuthority) return { ok: false, reason: 'invalid-input' };
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

  // Phase 1: CLAIM — decide the winner before Plan Authority is touched.
  const claim = repository.claimPromotion(id, {
    promotion: { type, store: target.store, targetId: target.id, planItemId },
    now, updatedBy: deviceId,
  });
  if (!claim.ok) {
    if (claim.reason === 'already-disposed') return { ok: true, record: claim.record, alreadyDisposed: true };
    // 'already-claimed': a different claim already won. Create nothing here.
    return { ok: false, reason: claim.reason, record: claim.record };
  }
  const winningClaim = claim.record.promotionClaim;
  if (!winningClaim || winningClaim.store !== target.store || winningClaim.targetId !== target.id || winningClaim.planItemId !== planItemId) {
    // Our claim did not win the merge (a concurrent claim for a different target
    // was earlier). Never create a second, competing plan item for this capture.
    return { ok: false, reason: 'already-claimed', record: claim.record };
  }

  // Phase 2: CREATE — idempotent via the deterministic id.
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
      // The claim stays recorded; a retry (this device or another) recovers from
      // the SAME claim rather than losing track of the attempt, and archive/
      // delegate stay refused in the meantime.
      return { ok: false, reason: err.message, record: claim.record };
    }
  }

  // Phase 3: FINALIZE — reads the destination off the claim already on the record.
  const finalized = repository.finalizePromotion(id, { now, updatedBy: deviceId });
  if (!finalized.ok && finalized.reason === 'already-disposed') {
    return { ok: true, record: finalized.record, alreadyDisposed: true };
  }
  if (!finalized.ok) return finalized;
  return { ok: true, record: finalized.record };
}
