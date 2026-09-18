// stale-plan-recovery-model.js
//
// Pure. "Unfinished from previous days" — the projection that makes an unfinished
// planned task from yesterday, three days ago or weeks ago discoverable and
// actionable again.
//
// ── the failure this fixes ──────────────────────────────────────────────────
// Before this, an unfinished task whose day had ended was effectively lost. Five
// independent mechanisms each closed one door, and reconnaissance confirmed all
// five in source:
//   1. every mutation path opens with `if (!isViewingToday()) return;`
//      (addPlanItem / removePlanItem / togglePlanDone in index.html)
//   2. renderTodayPlan sets `readOnly = !isViewingToday()` and drops the Edit
//      button entirely, so history renders as "Planned that day"
//   3. the ONLY reschedule affordance — "Carry to tomorrow" — is built from
//      `authority.current()`, so nothing older is ever offered
//   4. Prepared Plans covers the OPERATIONAL store only, is gated on
//      `enabled()`, and has no actions
//   5. date navigation refuses future dates and the picker shows 14 days back
// Item identity was never the problem: the records are intact and readable. What
// was missing was a surface that asks the question across BOTH stores.
//
// ── no new truth store ─────────────────────────────────────────────────────
// This is a projection over records that already exist, exactly like
// plan-authority's preparedPlans(). Nothing is copied, indexed or relocated to
// make a task discoverable. Moving a task reuses the EXISTING deterministic carry
// semantics (carryItemIdFor), so two devices that move the same task to the same
// day independently mint the same destination id and the existing per-item merge
// collapses them into one.
//
// ── what "stale" means, precisely ──────────────────────────────────────────
// An item is stale when ALL of these hold:
//   - its owning day has ENDED (endMs <= now). A day still in progress is not
//     "previous"; its items belong to the ordinary Today surface.
//   - it is not deleted (a tombstone is gone)
//   - it is not done (completed history stays historical)
//   - it is not dismissed (the owner said "not doing this")
//   - it has not already been moved somewhere
// There is deliberately NO lookback limit on DISCOVERY: a task from six weeks ago
// is still discoverable. Only what a surface RENDERS is bounded, by the caller.

import { planItemKind } from './plan-tomorrow-model.js';

/** Additive, optional field written on the ORIGINAL item when the owner says
 *  "not doing this". It records abandonment; it does NOT claim completion, which
 *  is why there is no "Mark done" action on this surface — stamping doneAt=now on
 *  a three-day-old item would make that historical day read as done when it was
 *  not. Move it, then complete it where doneAt is honest. */
export const DISMISSED_FIELD = 'dismissedAt';

/** Additive, optional field written on the DESTINATION copy alongside the
 *  existing `carriedFromId`, naming the source DAY as well as the source item.
 *  carriedFromId alone identifies the item, but not which day's record it came
 *  from — and provenance has to survive even if two days ever held items with the
 *  same id. */
export const CARRIED_FROM_DAY_FIELD = 'carriedFromDayId';

function isFiniteMs(value) {
  return Number.isFinite(value);
}

/** Is this item eligible to be surfaced as stale, ignoring the day question? */
export function itemIsRecoverable(item) {
  if (!item || typeof item !== 'object' || !item.id) return false;
  if (item.deleted === true) return false;
  if (item.done === true) return false;
  if (isFiniteMs(item[DISMISSED_FIELD])) return false;
  return true;
}

/** Has this item already been moved? Answered by scanning destination records for
 *  a copy whose provenance points back at it.
 *
 *  A bounded reverse scan is deliberate. Writing a move uses the DETERMINISTIC
 *  carry id (so two devices converge), but detecting "moved anywhere at all"
 *  cannot use that id, because it would require already knowing the destination.
 *  The scan reads the same full record set preparedPlans() and historyFloorMs()
 *  already walk, so it introduces no new cost class. */
export function findMoveDestination(sourceItemId, sourceDayId, dayRecords) {
  for (const [dayId, record] of Object.entries(dayRecords || {})) {
    if (dayId === sourceDayId) continue;
    const items = Array.isArray(record?.items) ? record.items : [];
    for (const item of items) {
      if (item?.deleted) continue;
      if (item?.carriedFromId !== sourceItemId) continue;
      // When the destination records the source DAY too, require it to match, so
      // two same-id items in different days can never be confused. Older copies
      // (written before that field existed) match on item id alone.
      const recordedDay = item[CARRIED_FROM_DAY_FIELD];
      if (recordedDay !== undefined && recordedDay !== sourceDayId) continue;
      return { dayId, itemId: item.id, item };
    }
  }
  return null;
}

/**
 * The "Unfinished from previous days" projection, across BOTH plan stores.
 *
 * Covering both is required, not optional: days that began before the boundary
 * revision took effect are legacy-governed and hold their items in
 * plans[dateKey]. An operational-only surface would leave every pre-boundary
 * stale task permanently unreachable — the exact bug being fixed.
 *
 * @param {object} input
 * @param {number} input.nowMs
 * @param {Array<{target:object, record:object}>} input.days
 *        Every candidate day the caller can speak for, each with its resolved
 *        target (carrying store, id and interval) and its stored record. The
 *        caller resolves these because only it knows the revision history; this
 *        module stays pure and makes no assumption about what "now" is.
 * @param {object} [input.dayRecords]
 *        id -> record, for already-moved detection. Defaults to `days`.
 * @returns {{items:Array, unresolvable:Array}}
 */
export function collectStaleUnfinished({ nowMs, days = [], dayRecords = null } = {}) {
  if (!isFiniteMs(nowMs)) throw new Error('A valid current instant is required.');
  const lookup = dayRecords || Object.fromEntries(
    days.filter(entry => entry?.target?.id).map(entry => [entry.target.id, entry.record]),
  );
  const out = [];
  const unresolvable = [];

  for (const entry of days) {
    const target = entry?.target;
    if (!target || !target.id) continue;
    // A day whose interval could not be resolved is REPORTED, never dropped —
    // "no planned information becomes unreachable because it is old" has to hold
    // even when a revision cannot be found.
    if (!isFiniteMs(target.endMs)) {
      const items = (Array.isArray(entry.record?.items) ? entry.record.items : []).filter(itemIsRecoverable);
      if (items.length) unresolvable.push({ target, items });
      continue;
    }
    if (target.endMs > nowMs) continue; // still in progress, or in the future

    const items = Array.isArray(entry.record?.items) ? entry.record.items : [];
    for (const item of items) {
      if (!itemIsRecoverable(item)) continue;
      const moved = findMoveDestination(item.id, target.id, lookup);
      if (moved) continue; // already recovered once — never offered twice
      out.push({
        item,
        target,
        sourceDayId: target.id,
        store: target.store,
        kind: planItemKind(item),
        endedMs: target.endMs,
        ageMs: nowMs - target.endMs,
      });
    }
  }

  // Most recently ended first: the task that slipped yesterday is the one most
  // likely to be acted on, and a six-week-old one should not head the list.
  out.sort((a, b) => b.endedMs - a.endedMs || String(a.item.id).localeCompare(String(b.item.id)));
  unresolvable.sort((a, b) => String(a.target.id).localeCompare(String(b.target.id)));
  return { items: out, unresolvable };
}

/** The destination item for a move. Built from the caller's deterministic carry id
 *  (plan-authority's carryItemIdFor), so two devices moving the same task to the
 *  same day mint the SAME id and the existing per-item merge collapses them into
 *  one active copy.
 *
 *  The moved copy is always a PRIORITY-or-task carrying over the source's own kind:
 *  a secondary task that slipped should not silently become a Top Priority, and a
 *  priority should not be demoted without the owner saying so. */
export function buildMovedItem({ carryId, sourceItem, sourceDayId, stamp }) {
  if (typeof carryId !== 'string' || !carryId) throw new Error('A deterministic carry id is required.');
  if (!sourceItem || !sourceItem.id) throw new Error('A source item is required.');
  if (typeof stamp !== 'function') throw new Error('An item stamping function is required.');
  const moved = {
    id: carryId,
    task: sourceItem.task,
    when: '',
    done: false,
    doneAt: null,
    carriedFromId: sourceItem.id,
    [CARRIED_FROM_DAY_FIELD]: sourceDayId,
  };
  // Carry the kind across verbatim. Absent means priority, so a legacy item with
  // no kind stays a priority exactly as it always was.
  if (planItemKind(sourceItem) === 'task') moved.kind = 'task';
  return stamp(moved);
}

/** Marks the ORIGINAL item dismissed. The only mutation this surface makes to a
 *  historical day, and deliberately the smallest one possible: it adds a
 *  timestamp and changes nothing else. The task still reads as planned-and-not-done
 *  on its own day, because that is what actually happened. */
export function buildDismissedItem(sourceItem, { nowMs, stamp }) {
  if (!sourceItem || !sourceItem.id) throw new Error('A source item is required.');
  if (!isFiniteMs(nowMs)) throw new Error('A valid current instant is required.');
  if (typeof stamp !== 'function') throw new Error('An item stamping function is required.');
  return stamp({ ...sourceItem, [DISMISSED_FIELD]: nowMs });
}

/** Undoes a dismissal by removing the field entirely, so the item returns to its
 *  exact previous stored shape rather than carrying a `dismissedAt: null`. */
export function buildUndismissedItem(sourceItem, { stamp }) {
  if (!sourceItem || !sourceItem.id) throw new Error('A source item is required.');
  if (typeof stamp !== 'function') throw new Error('An item stamping function is required.');
  const next = { ...sourceItem };
  delete next[DISMISSED_FIELD];
  return stamp(next);
}

/** A short human age, for the recovery list. Display only. */
export function describeStaleAge(ageMs) {
  const days = Math.floor(ageMs / 86400000);
  if (days <= 0) return 'earlier today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return 'last week';
  if (days < 60) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

const api = {
  DISMISSED_FIELD, CARRIED_FROM_DAY_FIELD,
  itemIsRecoverable, findMoveDestination, collectStaleUnfinished,
  buildMovedItem, buildDismissedItem, buildUndismissedItem, describeStaleAge,
};
globalThis.StalePlanRecoveryModel = api;
export default api;
