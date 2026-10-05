// operational-plan-model.js
//
// Pure. The ONE authoritative router deciding, for a given operational day,
// which plan store is authoritative — `resolvePlanAuthority` (contract §9-§13)
// — plus the operational-day-native item range validation (§16/§17) and
// operational-day-native preparation truth (§14) that the legacy plan model
// (plan-tomorrow-model.js) cannot supply, because it is deliberately scoped to
// bare calendar dates. Nothing in this file changes plan-tomorrow-model.js's
// contract — Planning Streak, Daily Reconciliation, and every existing legacy
// plan feature keep reading exactly what they already read (§8 of the persistence
// phase: "no live UI adoption yet"; this module is not wired into index.html).
//
// ── the hard invariant (§10, §11) ───────────────────────────────────────────
// For any operational day there is exactly one authoritative active plan
// source. This module never reads both stores, never merges them, never
// prefers "whichever is non-empty," and never infers authority from record
// content (timestamp, item count, prepared-state). Authority is decided
// PURELY from the day's own governing boundary revision — isLegacyOperationalDay
// — before any plan record is even looked at.
//
// ── why item-range validation is NOT plan-tomorrow-model.js's validPlanItemRange ──
// That legacy validator (and planItemEndTime) is deliberately midnight-clamped:
// an end time past midnight is treated as "no range at all," because a legacy
// calendar-day plan cannot represent a cross-midnight block. An operational day
// under a non-midnight boundary MUST be able to represent one (e.g. 23:00 ->
// 01:00 under an 18:00 boundary is an ordinary, valid, well-inside-the-day
// block — §16). So operational-plan item ranges are validated exclusively
// through the foundation's own resolvePlannedRangeInOperationalDay, which
// already gets this right without reimplementing the math here (§16, §17).
//
// ── why operational preparation is its OWN normalizer, not plan-tomorrow-model.js's ──
// normalizePreparation()/buildPreparation() there hard-require `targetDate` to
// be a bare calendar YYYY-MM-DD (validPlanDate). An operational day's identity
// is an operationalDayId string, not a calendar date — forcing it through that
// validator would either fail every time or require weakening an already-
// reviewed, Planning-Streak-load-bearing contract. This file's
// normalizeOperationalPreparation/buildOperationalPreparation mirror the same
// shape (schemaVersion, first/last prepared, updatedBy, intentionalBlank,
// routineInstanceIds, oneOffItemIds) but keyed by `targetOperationalDayId` —
// structurally parallel, never confusable with the legacy field (§14).

import { comparePlanItemRelocations } from './plan-item-relocation.js';
import {
  isLegacyOperationalDay,
  operationalDayId,
  operationalDayInterval,
  resolveClockTimeInOperationalDay,
  resolvePlannedRangeInOperationalDay,
  validBoundaryTime,
} from './personal-day-boundary-model.js';

export const OPERATIONAL_PLAN_SCHEMA_VERSION = 1;

const MODES = new Set(['normal', 'rescue']);

// ── the one authority router (§9-§13) ───────────────────────────────────────

/** @param {object} ref OperationalDayRef @param {object[]} revisions
 *  @returns {{store:'legacy', dateKey:string} | {store:'operational', operationalDayId:string}} */
export function resolvePlanAuthority(ref, revisions) {
  if (isLegacyOperationalDay(ref, revisions)) {
    // The foundation guarantees a legacy (anchor-governed, 00:00-boundary) day's
    // boundaryStartDate IS the existing calendar dateKey — no separate lookup,
    // no translation, this literally is plans[dateKey]'s own key today.
    return { store: 'legacy', dateKey: ref.boundaryStartDate };
  }
  return { store: 'operational', operationalDayId: operationalDayId(ref) };
}

// ── operational-day-native item range validation (§16, §17) ────────────────

/** A plan item's `durationMinutes`/`endClock` are BOTH optional (see the legacy
 *  contract: plan-tomorrow-model.js's validPlanItemTime is independent of
 *  validPlanItemRange, and formatPlanItemSchedule renders a start-only item
 *  perfectly well — "+ Add time" with no length is the ordinary case). A
 *  start-only timed item therefore has no RANGE to validate, only a start that
 *  must resolve to a real instant inside this operational day. Forwarding it to
 *  resolvePlannedRangeInOperationalDay, which requires exactly one of
 *  duration/endClock, rejected it as 'invalid-input' — so the operational store
 *  could not hold the single most common timed-item shape the legacy store
 *  already holds. Handled explicitly here instead; the ranged case is unchanged
 *  and still goes through the foundation's one resolver.
 *  @param {object} ref @param {{when?:string, durationMinutes?:number, endClock?:string}} item
 *  @param {object[]} revisions @param {{disambiguate?:'earlier'|'later'}} [options]
 *  @returns {{ok:true,startMs?:number,endMs?:number} | {ok:false, reason:string, [key:string]:*}} */
export function validateOperationalPlanItemRange(ref, item, revisions, options = {}) {
  if (!item || typeof item.when !== 'string' || !item.when) return { ok: true }; // untimed item — nothing to validate
  // Start-only means both range fields are genuinely ABSENT. A present-but-malformed
  // value (0, negative, fractional, "30", null, "", "25:00") is not "no range" — it is
  // an invalid range, and falls through to the ranged resolver below, which rejects it
  // exactly as it did before start-only support existed.
  if (item.durationMinutes === undefined && item.endClock === undefined) {
    if (!validBoundaryTime(item.when)) return { ok: false, reason: 'invalid-input' };
    const startResolved = resolveClockTimeInOperationalDay(ref, item.when, revisions, options);
    if (!startResolved.ok) return { ok: false, at: 'start', ...startResolved };
    // resolveClockTimeInOperationalDay only picks the calendar date; it does not know the
    // day may be revision-truncated (e.g. 18:00 -> 20:00 on a transition day). Apply the
    // same half-open containment a ranged item gets, so 21:00 or 01:00 on that day is
    // rejected rather than stored against a day it is not in.
    const { startMs: dayStartMs, endMs: dayEndMs } = operationalDayInterval(ref, revisions);
    if (startResolved.instantMs < dayStartMs || startResolved.instantMs >= dayEndMs) return { ok: false, reason: 'outside-operational-day' };
    return { ok: true, startMs: startResolved.instantMs };
  }
  return resolvePlannedRangeInOperationalDay(ref, { startClock: item.when, durationMinutes: item.durationMinutes, endClock: item.endClock }, revisions, options);
}

// ── operational-day-native preparation truth (§14) ──────────────────────────

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}
function writer(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200 ? value : null;
}
function ids(value) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id || id.length > 500)) return null;
  return [...new Set(value)].sort();
}
function compareStrings(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** @param {*} value @param {string} [expectedOperationalDayId] @returns {object|null} */
export function normalizeOperationalPreparation(value, expectedOperationalDayId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== OPERATIONAL_PLAN_SCHEMA_VERSION) return null;
  if (typeof value.targetOperationalDayId !== 'string' || !value.targetOperationalDayId) return null;
  if (expectedOperationalDayId && value.targetOperationalDayId !== expectedOperationalDayId) return null;
  if (!MODES.has(value.firstPreparedMode) || !MODES.has(value.lastPreparedMode)) return null;
  const firstPreparedAt = timestamp(value.firstPreparedAt);
  const lastPreparedAt = timestamp(value.lastPreparedAt);
  const updatedBy = writer(value.updatedBy);
  const routineInstanceIds = ids(value.routineInstanceIds);
  const oneOffItemIds = ids(value.oneOffItemIds);
  if (!firstPreparedAt || !lastPreparedAt || lastPreparedAt < firstPreparedAt || !updatedBy || !routineInstanceIds || !oneOffItemIds || typeof value.intentionalBlank !== 'boolean') return null;
  const normalized = {
    schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION,
    targetOperationalDayId: value.targetOperationalDayId,
    firstPreparedAt, firstPreparedMode: value.firstPreparedMode,
    lastPreparedAt, lastPreparedMode: value.lastPreparedMode,
    updatedBy, intentionalBlank: value.intentionalBlank,
    routineInstanceIds, oneOffItemIds
  };
  const firstPreparedBy = writer(value.firstPreparedBy);
  if (firstPreparedBy) normalized.firstPreparedBy = firstPreparedBy;
  return normalized;
}

function firstPreparationKey(value) {
  return `${writer(value.firstPreparedBy) || ''} ${canonical({ firstPreparedMode: value.firstPreparedMode })}`;
}
function latestPreparationKey(value) {
  return `${value.updatedBy} ${canonical({ intentionalBlank: value.intentionalBlank, lastPreparedMode: value.lastPreparedMode, oneOffItemIds: value.oneOffItemIds, routineInstanceIds: value.routineInstanceIds })}`;
}
function earlierPreparation(a, b) {
  if (a.firstPreparedAt !== b.firstPreparedAt) return a.firstPreparedAt < b.firstPreparedAt ? a : b;
  return compareStrings(firstPreparationKey(a), firstPreparationKey(b)) >= 0 ? a : b;
}
function laterPreparation(a, b) {
  if (a.lastPreparedAt !== b.lastPreparedAt) return a.lastPreparedAt > b.lastPreparedAt ? a : b;
  return compareStrings(latestPreparationKey(a), latestPreparationKey(b)) >= 0 ? a : b;
}

/** @param {object|null} current @param {object} input @returns {object} */
export function buildOperationalPreparation(current, input) {
  const targetOperationalDayId = input?.targetOperationalDayId;
  const now = timestamp(input?.now);
  const mode = input?.mode;
  const updatedBy = writer(input?.updatedBy);
  const routineInstanceIds = ids(input?.routineInstanceIds);
  const oneOffItemIds = ids(input?.oneOffItemIds);
  if (typeof targetOperationalDayId !== 'string' || !targetOperationalDayId || !now || !MODES.has(mode) || !updatedBy || !routineInstanceIds || !oneOffItemIds || typeof input.intentionalBlank !== 'boolean') {
    throw new Error('Invalid operational preparation confirmation.');
  }
  const previous = normalizeOperationalPreparation(current, targetOperationalDayId);
  const confirmation = {
    schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION, targetOperationalDayId,
    firstPreparedAt: now, firstPreparedBy: updatedBy, firstPreparedMode: mode,
    lastPreparedAt: now, lastPreparedMode: mode, updatedBy,
    intentionalBlank: input.intentionalBlank, routineInstanceIds, oneOffItemIds
  };
  return previous ? mergeOperationalPreparations(previous, confirmation, targetOperationalDayId) : confirmation;
}

/** @param {object|null} localValue @param {object|null} remoteValue @param {string} targetOperationalDayId @returns {object|null} */
export function mergeOperationalPreparations(localValue, remoteValue, targetOperationalDayId) {
  const local = normalizeOperationalPreparation(localValue, targetOperationalDayId);
  const remote = normalizeOperationalPreparation(remoteValue, targetOperationalDayId);
  if (!local) return remote;
  if (!remote) return local;
  const first = earlierPreparation(local, remote);
  const last = laterPreparation(local, remote);
  const merged = {
    schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION,
    targetOperationalDayId: first.targetOperationalDayId,
    firstPreparedAt: first.firstPreparedAt, firstPreparedMode: first.firstPreparedMode,
    lastPreparedAt: last.lastPreparedAt, lastPreparedMode: last.lastPreparedMode,
    updatedBy: last.updatedBy, intentionalBlank: last.intentionalBlank,
    routineInstanceIds: last.routineInstanceIds.slice(), oneOffItemIds: last.oneOffItemIds.slice()
  };
  if (first.firstPreparedBy) merged.firstPreparedBy = first.firstPreparedBy;
  return merged;
}

// ── operational plan record merge (§15, mirrors plan-tomorrow-model.js's ──
// mergeDatePlans item-merge algorithm exactly, duplicated rather than imported
// so this file never depends on — and can never accidentally alter the
// contract of — the already-reviewed, Planning-Streak-load-bearing
// plan-tomorrow-model.js. Only the preparation half differs (operational- vs
// calendar-day-keyed); the item-merge half is identical LWW-by-id.) ─────────

function mergeTimestamp(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}
function itemMutationKey(value) {
  return `${writer(value?.updatedBy) || ''} ${canonical(value)}`;
}
function chooseItem(local, remote) {
  const relocationOrder = comparePlanItemRelocations(local, remote);
  if (relocationOrder !== 0) return relocationOrder > 0 ? local : remote;
  const localAt = mergeTimestamp(local?.updatedAt);
  const remoteAt = mergeTimestamp(remote?.updatedAt);
  if (localAt !== remoteAt) return remoteAt > localAt ? remote : local;
  return compareStrings(itemMutationKey(local), itemMutationKey(remote)) >= 0 ? local : remote;
}
function planItems(value) {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
  if (value && typeof value === 'object') return Object.values(value).filter(item => item && typeof item === 'object');
  return [];
}

/** @param {object|null} localValue @param {object|null} remoteValue @param {string} operationalDayIdValue @returns {object} */
export function mergeOperationalPlanRecords(localValue, remoteValue, operationalDayIdValue) {
  const local = localValue && typeof localValue === 'object' ? localValue : {};
  const remote = remoteValue && typeof remoteValue === 'object' ? remoteValue : {};
  const byId = new Map();
  for (const item of planItems(local.items)) if (item.id) byId.set(item.id, item);
  for (const item of planItems(remote.items)) {
    if (!item.id) continue;
    byId.set(item.id, byId.has(item.id) ? chooseItem(byId.get(item.id), item) : item);
  }
  const localAt = mergeTimestamp(local.updatedAt);
  const remoteAt = mergeTimestamp(remote.updatedAt);
  const latestPlan = localAt === remoteAt
    ? (compareStrings(writer(remote.updatedBy) || '', writer(local.updatedBy) || '') >= 0 ? remote : local)
    : (remoteAt > localAt ? remote : local);
  const merged = {
    items: [...byId.values()].sort((a, b) => compareStrings(String(a.id), String(b.id))),
    updatedAt: Math.max(localAt, remoteAt)
  };
  const latestWriter = writer(latestPlan.updatedBy);
  if (latestWriter) merged.updatedBy = latestWriter;
  const preparation = mergeOperationalPreparations(local.preparation, remote.preparation, operationalDayIdValue);
  if (preparation) merged.preparation = preparation;
  return merged;
}
