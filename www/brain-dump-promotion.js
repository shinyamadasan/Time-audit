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
//    (bounded by a timeout — see brain-dump-sync.js) before proceeding. A
//    `reason:'pending'` result means the OUTCOME IS UNKNOWN (FIX FIRST round 3
//    — see reconcilePromotionClaim below): Plan Authority must NOT be touched.
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
// ── foreground + reconciler cooperate (Production UX Correction V1) ─────────
// In production the reconciler (reconcilePromotionClaim, driven by the sync
// listener) usually finishes a fresh foreground claim BEFORE claimPromotion-
// Remote even resolves, because Firebase raises the listener event first. The
// foreground call must not suppress that reconciler: if it did, and then timed
// out ('pending'), nobody would be left to finish the claim. So the reconciler
// stays free to run, and the foreground call treats "already promoted with
// exactly my intent" (promotedTo) as its own success, never as a conflict.
// "Exactly" means samePromotionIntent: type, store, targetId, planItemId, when
// and durationMinutes all match. The deterministic planItemId alone is shared
// by every promotion of one capture into one day, so it cannot tell a Do Today
// from a same-day Schedule, or 14:00 from 15:00.
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
//
// ── reconcilePromotionClaim: the abandoned-claim fix (FIX FIRST round 3) ─────
// A `pending` result from claimPromotionRemote means phase 1's transaction is
// still in flight somewhere — brain-dump-sync.js never abandons it (see its own
// file banner), and it will eventually settle and merge into local cache via
// the ordinary onRemoteChange hook. If it turns out WE won, nobody has yet run
// phases 2/3 for it: the original promoteCaptureToPlan() call already returned
// to its caller with 'pending' and is gone. reconcilePromotionClaim() is phases
// 2+3 alone, driven SOLELY by the capture's own persisted promotionClaim — never
// by a freshly-built target or a fresh UI action — so it can finish the
// promotion from ANY session that later observes the authoritative claim: the
// SAME device after the foreground call gave up, a DIFFERENT device, or a
// completely fresh app load whose repository just hydrated it from remote. The
// claim's `targetId` is resolved back into a real Plan Authority target via
// targetById() (never by re-deriving "today" or re-resolving a schedule date
// fresh — the ORIGINAL target is exactly what was claimed, however much time has
// passed), and `when`/`durationMinutes` — carried on the claim precisely so this
// is possible — rebuild the exact intended item. Idempotent and safe to call
// redundantly from multiple observers (a listener update, a reconnect, a reload,
// or two devices both noticing the same outstanding claim) — the deterministic
// plan-item id and finalizePromotion's own idempotent guard are what make that
// safe, exactly as they already do for promoteCaptureToPlan's own retries.

import { brainDumpPlanItemId, promotedTo, samePromotionIntent, normalizeCapture } from './brain-dump-model.js';

function buildPlanItem(claim, text, now, deviceId) {
  const item = { id: claim.planItemId, task: text, when: claim.when || '', done: false, doneAt: null, updatedAt: now, updatedBy: deviceId, kind: 'task' };
  if (Number.isFinite(claim.durationMinutes)) item.durationMinutes = claim.durationMinutes;
  return item;
}

/** Shared phase 2+3: create the destination (idempotent) and finalize (reads
 *  the claim already on the record). Used by both promoteCaptureToPlan (right
 *  after ITS OWN claim just won) and reconcilePromotionClaim (for a claim this
 *  call never made itself). */
function createAndFinalize({ repository, planAuthority, id, target, claim, text, now, deviceId }) {
  const alreadyCreated = planAuthority.rawItems(target).some(item => item.id === claim.planItemId);
  if (!alreadyCreated) {
    try {
      planAuthority.addItem({ destination: target, item: buildPlanItem(claim, text, now, deviceId), nowMs: now });
    } catch (err) {
      // The claim stays recorded (authoritatively, remotely); a retry (this
      // device or another) recovers from the SAME claim rather than losing
      // track of the attempt, and archive/delegate stay refused in the meantime.
      return { ok: false, reason: err.message };
    }
  }
  const finalized = repository.finalizePromotion(id, { now, updatedBy: deviceId });
  // Already finalized into THIS claim's destination (a cooperating reconciler
  // got there first): the same promotion, not a different earlier disposition.
  if (!finalized.ok && promotedTo(finalized.record, claim)) return { ok: true, record: finalized.record };
  // Anything else already settled is NOT this claim's success.
  if (!finalized.ok) return finalized;
  return { ok: true, record: finalized.record };
}

/** @param {{repository:object, planAuthority:object, claimPromotionRemote:function, id:string,
 *           type:'do-today'|'schedule', dateKey?:string, when?:string, durationMinutes?:number,
 *           now:number, deviceId:string}} input
 *  @returns {Promise<{ok:true, record:object, alreadyDisposed?:boolean} | {ok:false, reason:string, record?:object}>} */
export async function promoteCaptureToPlan(input = {}) {
  const { repository, planAuthority, claimPromotionRemote, id, type, dateKey, when = '', durationMinutes, now, deviceId } = input;
  if (!repository || !planAuthority || typeof claimPromotionRemote !== 'function') return { ok: false, reason: 'invalid-input' };
  const current = repository.read(id);
  if (!current) return { ok: false, reason: 'not-found' };
  if (current.status === 'archived' || current.status === 'delegated') {
    // Already handled without a plan item — never re-promote, and never touch
    // Plan Authority to find that out.
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
  // Everything that shapes the resulting plan item — see samePromotionIntent.
  const intent = { type, store: target.store, targetId: target.id, planItemId, when, durationMinutes };

  if (current.status === 'promoted') {
    // Never re-promote. An exact retry of the SAME intent is an idempotent
    // success; a different intent (Do Today vs a same-day Schedule, or another
    // time) was NOT honored, so it is never reported as success.
    return promotedTo(current, intent)
      ? { ok: true, record: current, alreadyDisposed: true }
      : { ok: false, reason: 'already-disposed', record: current };
  }

  // Phase 1: REMOTE CLAIM GATE — authoritative, before Plan Authority is
  // touched. Never fakes success: offline/already-claimed/already-disposed all
  // come back here as ok:false with no local or remote write for THIS attempt.
  // 'pending' means the outcome is UNKNOWN — see reconcilePromotionClaim.
  const claim = await claimPromotionRemote(id, intent);
  if (!claim.ok) return claim;
  // The listener-driven reconciler observed our claim first and already
  // finished it (see brain-dump-sync.js's finishClaimAttempt). This is our own
  // promotion succeeding, so report it as a plain success.
  if (promotedTo(claim.record, intent)) return { ok: true, record: claim.record };
  const winningClaim = claim.record?.promotionClaim;
  if (!samePromotionIntent(winningClaim, intent)) {
    // Our claim did not win the merge (a concurrent claim with a different
    // intent was earlier/authoritative). Never create a second, competing plan item.
    return { ok: false, reason: 'already-claimed', record: claim.record };
  }

  return createAndFinalize({ repository, planAuthority, id, target, claim: winningClaim, text: claim.record.text, now, deviceId });
}

/** Where a promoted capture landed, read back from Plan Authority (the plan
 *  item is the authority, not the capture). Pure over the injected Plan
 *  Authority; any failure just yields less detail.
 *
 *  `openDateKey` is the date My Day's existing date navigation
 *  (jumpTimelineToDate) can open, and is set ONLY when opening that date
 *  provably lands on this promotion's own target: legacy routing must show that
 *  same legacy date, and Plan Authority routing must resolve the date back to
 *  this exact targetId. A Personal Day (operational) target has no calendar
 *  date of its own, so it never gets one, and is described by its start
 *  instant instead. Never a guessed date.
 *  @returns {{kind:'date'|'personal-day'|'unknown', dateKey:string, startMs:number|null,
 *            timezone:string, when:string, openDateKey:string}} */
export function promotionDestination(planAuthority, record) {
  const none = { kind: 'unknown', dateKey: '', startMs: null, timezone: '', when: '', openDateKey: '' };
  const promotion = record?.promotion;
  if (!promotion || !planAuthority || typeof planAuthority.targetById !== 'function') return none;
  try {
    const target = planAuthority.targetById(promotion.targetId);
    if (!target) return { ...none, when: promotion.when || '' };
    const planItem = typeof planAuthority.rawItems === 'function' ? planAuthority.rawItems(target).find(i => i.id === promotion.planItemId) : null;
    const when = planItem ? (planItem.when || '') : (promotion.when || '');
    if (!target.dateKey) {
      return { kind: 'personal-day', dateKey: '', startMs: Number.isFinite(target.startMs) ? target.startMs : null, timezone: target.timezone || '', when, openDateKey: '' };
    }
    // Mirrors index.html's jumpTimelineToDate: with Plan Authority routing it
    // opens dayForCalendarDate(date); otherwise it opens the plain date view,
    // which shows that date's legacy or calendar plan. Either way the date must
    // resolve back to THIS target, or the button would open the wrong day.
    const routed = typeof planAuthority.enabled === 'function' && planAuthority.enabled();
    const resolved = typeof planAuthority.dayForCalendarDate === 'function' ? planAuthority.dayForCalendarDate(target.dateKey) : null;
    const opens = resolved?.id === target.id && (routed || target.store === 'legacy' || target.store === 'calendar');
    return { kind: 'date', dateKey: target.dateKey, startMs: null, timezone: target.timezone || '', when, openDateKey: opens ? target.dateKey : '' };
  } catch {
    return none;
  }
}

/** Resumes an authoritative promotion claim that is ALREADY WON — i.e. the
 *  capture's own promotionClaim is already the remote-confirmed truth. Never
 *  re-attempts the claim itself (see promoteCaptureToPlan/claimPromotionRemote
 *  for that) — this is phases 2+3 alone, driven solely by persisted provenance.
 *  See the file banner's "abandoned-claim fix" section for why this exists and
 *  why it is safe to call redundantly from any observer.
 *  @param {{repository:object, planAuthority:object, id:string, now:number, deviceId:string}} input
 *  @returns {{ok:true, record:object, alreadyDisposed?:boolean} | {ok:false, reason:string, record?:object}} */
export function reconcilePromotionClaim({ repository, planAuthority, id, now, deviceId }) {
  if (!repository || !planAuthority) return { ok: false, reason: 'invalid-input' };
  const current = repository.read(id);
  if (!current) return { ok: false, reason: 'not-found' };
  if (current.status !== 'untriaged' && current.status !== 'triaged') {
    return { ok: true, record: current, alreadyDisposed: true };
  }
  const claim = current.promotionClaim;
  if (!claim) return { ok: false, reason: 'no-claim' };

  // The ORIGINAL target, reconstructed from the claim's own persisted id — NOT
  // re-derived (never "today" resolved fresh, never a schedule date re-resolved):
  // targetById() rebuilds exactly the day that was claimed, however much time
  // has passed since.
  const target = typeof planAuthority.targetById === 'function' ? planAuthority.targetById(claim.targetId) : null;
  if (!target) return { ok: false, reason: 'invalid-input', record: current };

  // Case A (FIX FIRST #3): the deterministic item already exists, so the
  // promotion's side effect provably happened. Finalize, never release, however
  // old the day is.
  let items;
  try { items = planAuthority.rawItems(target); } catch { return { ok: false, reason: 'destination-unreadable', record: current }; }
  if (!Array.isArray(items)) return { ok: false, reason: 'destination-unreadable', record: current };
  if (items.some(item => item.id === claim.planItemId)) {
    return createAndFinalize({ repository, planAuthority, id, target, claim, text: current.text, now, deviceId });
  }

  const marked = normalizeCapture(current)?.promotionClaim?.planWriteStarted === true;
  if (targetHasEnded(planAuthority, target, now) === true) {
    // Case B: proven-ended target and no item. Releasable only if no client can
    // ever have written that item (the claim was never marked); a marked claim's
    // absence here might just be a plan cache that has not caught up.
    return marked
      ? { ok: false, reason: 'expired-write-may-have-started', record: current }
      : { ok: false, reason: 'expired', claim, target, record: current };
  }
  // A claim this device did not mint, never yet marked: the mark must be
  // authoritative remotely BEFORE this device writes anything for it.
  if (!marked) return { ok: false, reason: 'needs-write-mark', claim, record: current };
  return createAndFinalize({ repository, planAuthority, id, target, claim, text: current.text, now, deviceId });
}

/** true = Plan Authority PROVABLY refuses this target because its day has ended;
 *  false = it is still writable; null = cannot tell. Uses Plan Authority's own
 *  normal-contract gate (assertDirectSchedulingTarget), never a local clock rule:
 *  refused at `now` but accepted at the beginning of time proves the refusal is
 *  the time-based "Past My Days are history" one, not some other failure. */
function targetHasEnded(planAuthority, target, now) {
  if (typeof planAuthority.assertDirectSchedulingTarget !== 'function') return null;
  try { planAuthority.assertDirectSchedulingTarget(target, now); return false; } catch { /* refused now */ }
  try { planAuthority.assertDirectSchedulingTarget(target, 0); return true; } catch { return null; }
}

/** Drives one outstanding claim to its settled state (FIX FIRST #3). Runs
 *  reconcilePromotionClaim synchronously FIRST, so a claim that can be finished
 *  right away (this device's own, already marked) still finishes inside the same
 *  listener callback, before any await. Then, only if needed:
 *  - 'needs-write-mark': marks the claim authoritatively, then reconciles again;
 *  - 'expired': resolves the claim as expired authoritatively (the capture goes
 *    back to the active list). Committed only if the remote still holds that
 *    exact, unmarked claim, so a concurrent mark, promotion or other recovery
 *    wins instead.
 *  Never releases on uncertainty: an unreadable destination, an unresolvable
 *  target, an unknown end state or an offline remote all leave the claim as is.
 *  @returns {Promise<object>} the final outcome; `recovered: true` when THIS call
 *  returned the capture to the active list. */
export async function settleOutstandingClaim({ repository, planAuthority, id, now, deviceId, markClaimWrite, resolveExpiredClaim }) {
  const outcome = reconcilePromotionClaim({ repository, planAuthority, id, now, deviceId });
  if (outcome.reason === 'needs-write-mark' && typeof markClaimWrite === 'function') {
    const marked = await markClaimWrite(id, outcome.claim);
    if (!marked.ok) return { ok: false, reason: marked.reason, record: marked.record };
    return reconcilePromotionClaim({ repository, planAuthority, id, now, deviceId });
  }
  if (outcome.reason === 'expired' && typeof resolveExpiredClaim === 'function') {
    const resolved = await resolveExpiredClaim(id, outcome.claim);
    if (!resolved.ok) return { ok: false, reason: resolved.reason, record: resolved.record };
    return { ok: true, record: resolved.record, recovered: true, expiredClaim: outcome.claim, target: outcome.target };
  }
  return outcome;
}
