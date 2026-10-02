// brain-dump-promotion.js
//
// Promotes a Brain Dump capture into the existing authoritative planning path —
// Plan Authority — never around it. This is the ONLY place a capture becomes a
// plan item, for both "Do Today" and "Schedule" (they differ only in which target
// Plan Authority resolves).
//
// ── ordering, and why it is safe to retry ────────────────────────────────────
// The plan item is written FIRST, the capture's disposition SECOND. Both steps use
// a DETERMINISTIC plan-item id derived only from the capture's own immutable id
// (brain-dump-model.js's brainDumpPlanItemId) — never minted fresh — so:
//
//   - a crash/reload between the two steps leaves the capture untriaged/triaged
//     with the plan item already sitting in the plan; a retried promotion sees
//     that item already present (step 2 below) and writes nothing a second time,
//     it just catches the capture's disposition up to match;
//   - two devices racing the same promotion each try to write the SAME id, so
//     whichever plan-item write lands first makes the second a no-op rather than
//     a duplicate;
//   - a capture already disposed of (by this device or another) is reported via
//     `alreadyDisposed`, never re-promoted, never double-written.
//
// This is deliberately simpler than a distributed "claim" transaction: Plan
// Authority's own saveItems()/addItem() already persists locally before any
// network round trip (same durability-first contract as every other store in this
// codebase), and the deterministic id is what makes a retry idempotent rather than
// a lock.
//
// ── known, accepted limitation (documented, not solved) ─────────────────────
// If device A promotes a capture while device B archives the SAME capture in the
// same window, each acts locally before syncing. The capture's own record
// converges deterministically via the ordinary LWW merge (brain-dump-model.js's
// mergeCaptureRecords) — whichever write has the later updatedAt wins, with a
// canonical tie-break — so the capture's final status is always deterministic.
// If promote's write "loses" that merge, its plan item still exists (harmless: an
// ordinary extra plan item, not tied to a now-archived capture) — Brain Dump does
// not invent a cross-store transaction to prevent that, exactly as the product
// brief asks it not to over-build V1.

import { brainDumpPlanItemId } from './brain-dump-model.js';

/** @param {{repository:object, planAuthority:object, id:string, type:'do-today'|'schedule',
 *           dateKey?:string, when?:string, durationMinutes?:number, now:number, deviceId:string}} input
 *  @returns {{ok:true, record:object, alreadyDisposed?:boolean} | {ok:false, reason:string}} */
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
  const alreadyCreated = planAuthority.rawItems(target).some(item => item.id === planItemId);
  if (!alreadyCreated) {
    const item = {
      id: planItemId,
      task: current.text,
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
      return { ok: false, reason: err.message };
    }
  }

  const result = repository.promote(id, {
    promotion: { type, store: target.store, targetId: target.id, planItemId },
    now,
    updatedBy: deviceId,
  });
  if (!result.ok && result.reason === 'already-disposed') {
    // Lost a race to another disposition (promote-vs-archive/delegate, or a second
    // device's own promote). The plan item above is already safely in place either
    // way — see the file banner's accepted limitation for the archive-race case.
    return { ok: true, record: result.record, alreadyDisposed: true };
  }
  if (!result.ok) return result;
  return { ok: true, record: result.record };
}
