// functions/src/plan-create-action.js
//
// plan_create (TASK-011; docs/CHRONASENSE_ACTION_API_V1.md §6 table; DECISIONS #37). One user-intended create,
// one deterministic item `api1_<uuid>` at ONE keyed calendar fence child:
//
//     rooms/<room>/calendarPlanFences/<cal1:YYYY-MM-DD>/api1_<uuid>
//
// The item never enters the plan record's re-sorted `items` array, so array order can never decide identity. The
// only plan-record write is the canonical ORIGIN (createdAt + home timezone), established once, through the existing
// mergeCalendarPlanRecords contract under an ETag compare-and-set, so the plan's home zone is frozen by its first
// item and no concurrent owner edit can be lost (R011-02). The private receipt serializes attempts; the user-scoped RTDB
// conditional create (`if-match: null_etag`, with a token whose claims name exactly this action, kind and plan)
// allows at most one absent -> created transition, even across lease expiry, crash or a lost response.
//
// Order is load-bearing:
//   1. claim/replay the receipt (an applied or rejected action answers from it, never re-executes)
//   2. read the EXACT child: an item carrying this action's marker proves this action created it
//   3. only if it is absent: resolve the target through Plan Authority (calendar activation, frozen home zone,
//      past-day immutability), freeze the plan's canonical origin, and create-if-absent
//   4. read the exact child back: applied ONLY when the attributed item is proven present
// REJECTED is written only by the FIRST attempt of an action (a fresh receipt claim): no earlier attempt exists that
// could still commit. A takeover never rejects: an earlier attempt's create may still land whatever time has passed
// (a request timeout is not a writer fence), so its outcome stays PENDING_UNKNOWN until the exact child proves it
// (R011-01). Only the same action may retry.

import { calendarItemInstants, mergeCalendarPlanRecords, parseCalendarPlanId } from '../shared/calendar-plan-model.js';
import { actionPlanItemIdFor, isActionPlanItem } from '../shared/plan-item-origin.js';
import { planItemTime } from './envelope.js';
import { ApiError, ERROR_CODES } from './errors.js';
import { createPlanRead, revision } from './plan-read.js';
import { canonicalRequestHash, classifyExistingReceipt } from './receipts.js';

const LEASE_MS = 30_000;
/** Compare-and-set rounds for establishing the plan origin against concurrent writers before reporting unknown. */
const ORIGIN_CAS_ATTEMPTS = 3;
/** Refusals that are facts about the account's authoritative state (not transport uncertainty). */
const DEFINITIVE_REFUSALS = new Set(['NOT_FOUND', 'CONFLICT', 'PAST_TARGET_IMMUTABLE', 'FORBIDDEN', 'DOMAIN_LIMIT']);

const pending = () => new ApiError('PENDING_UNKNOWN', 'The plan create outcome is being reconciled. Retry with the same action ID and parameters and a new request ID.',
  { reason: 'plan-create-outcome-unknown' });
const conflict = reason => new ApiError('CONFLICT', 'The action ID is occupied by an incompatible plan item.', { reason });

/** The stored child as THIS action's item, null when absent; anything else at that key is a conflict. Only the
 *  immutable creation facts decide (path-bound id, marker); title/time/done/deleted are the owner's to edit. */
function ownedItem(raw, actionId, itemId) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.id !== itemId || raw.creationActionId !== actionId
    || !isActionPlanItem(raw) || raw.brainDumpOrigin !== undefined) throw conflict('plan-item-attribution-mismatch');
  return raw;
}

/** An ordinary planned task (kind 'task', so the Top 3 cap is never at stake) with action provenance. */
function buildItem({ actionId, parameters, actionProvenance }, itemId, createdAt) {
  return { id: itemId, task: parameters.title, ...planItemTime(parameters), done: false,
    updatedAt: createdAt, updatedBy: actionProvenance.actorRef, kind: 'task', creationActionId: actionId };
}

/** Bounded, title-free projection: the receipt never copies the task text. */
function resultFor({ actionId, itemId, planId, date, parameters, item, createdAt }) {
  let schedule = null;
  if (parameters.when) {
    const instants = calendarItemInstants(date, planItemTime(parameters));
    schedule = { when: parameters.when, whenDayOffset: parameters.whenDayOffset, whenTz: parameters.whenTz,
      durationMinutes: parameters.durationMinutes ?? null, startAt: new Date(instants.startMs).toISOString(),
      endAt: instants.endMs === null ? null : new Date(instants.endMs).toISOString() };
  }
  return { actionId, itemId, target: { store: 'calendar', id: planId, date }, schedule,
    // get_plan's own item revision, so a create's revision matches a later read of the item.
    createdAt: new Date(createdAt).toISOString(), revision: revision({ v: 1, store: 'calendar', targetKey: planId, item }) };
}

/** Plan Authority's own rules for an ordinary direct Add, server-side: the date must be calendar-authoritative
 *  (never activated by this call), its plan must not have ended in its frozen home zone, and the deterministic id
 *  must not already be in use anywhere in that plan. @returns {string} the home zone the plan was judged in */
async function assertWritableTarget(identity, { domain, nowMs, planId, itemId }) {
  const reader = await createPlanRead(identity, { domain, nowMs });
  const target = { store: 'calendar', id: planId };
  const plan = await reader.read(target);
  if (plan.target.endMs <= nowMs) {
    throw new ApiError('PAST_TARGET_IMMUTABLE', 'That plan day has ended. Past plans are history and cannot be added to.', { reason: 'plan-target-past' });
  }
  if (plan.items.some(item => item.itemId === itemId) || await reader.inactiveItem(target, itemId)) throw conflict('plan-item-id-occupied');
  return plan.target.timezone;
}

/** The plan record already carries its canonical origin (the same test mergeCalendarPlanRecords applies). */
const hasOrigin = record => !!record && Number.isFinite(Number(record.createdAt)) && Number(record.createdAt) > 0 && typeof record.timezone === 'string';

/** R011-02: freeze the plan's home timezone before its first action item exists, exactly as a client's first plan
 *  write does (createdAt + timezone, merged by mergeCalendarPlanRecords: earliest origin wins, items and preparation
 *  preserved). A record that already has an origin is never rewritten. Whole-record compare-and-set with the ordinary
 *  owner token (never the action token): a concurrent owner/device write changes the ETag and is re-merged, never lost.
 *  @returns {Promise<string>} the plan's frozen home zone */
async function ensurePlanOrigin(identity, { domain, planId, homeZone, createdAt }) {
  for (let round = 0; round < ORIGIN_CAS_ATTEMPTS; round++) {
    const { value, etag } = await domain.readCalendarPlanWithEtag(identity, planId);
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new ApiError('CONFLICT', 'The plan record contains incompatible data.', { reason: 'malformed-plan-record' });
    if (hasOrigin(value)) return value.timezone;
    const merged = mergeCalendarPlanRecords(value, { items: [], createdAt, timezone: homeZone }, planId);
    if ((await domain.putCalendarPlanIfMatch(identity, planId, merged, etag)) === 'written') return homeZone;
  }
  throw new ApiError('RETRYABLE_TRANSPORT', 'The plan record kept changing.', { reason: 'plan-origin-contended' });
}

async function settle(receipts, identity, actionId, snapshot, update) {
  const receipt = { ...snapshot.value, ...update, updatedAt: update.updatedAt };
  if ((await receipts.compareAndSet(identity.firebaseUid, actionId, receipt, snapshot.etag)) === 'written') return receipt;
  throw pending();
}

export async function createPlanAction(identity, { command, domain, receipts, attemptId, nowMs }) {
  const { actionId, actionProvenance, parameters } = command;
  const itemId = actionPlanItemIdFor(actionId);
  const planId = parameters.target.id;
  const date = parseCalendarPlanId(planId);
  const requestHash = canonicalRequestHash(command);
  const claim = await receipts.claim({ firebaseUid: identity.firebaseUid, actionId, requestHash,
    kind: command.kind, attemptId, nowMs, leaseMs: LEASE_MS, plannedRecordId: itemId, plannedTarget: { store: 'calendar', id: planId },
    authorizationContext: { actorRef: actionProvenance.actorRef, requiredScope: 'chronasense:plan.write',
      grantedScopes: identity.scopes, serviceIdentity: 'chronasense-plugin-worker-v1' },
    actionProvenanceRefs: { sourceKind: actionProvenance.sourceKind, capturedAt: actionProvenance.capturedAt } });
  let snapshot = await receipts.readWithEtag(identity.firebaseUid, actionId);
  if (!snapshot.value) throw pending();
  const existing = snapshot.value;
  if (existing.requestHash !== requestHash || existing.kind !== command.kind) {
    throw new ApiError('IDEMPOTENCY_CONFLICT', 'This action ID was used for a different command.', { reason: 'action-id-reuse' });
  }
  if (existing.plannedRecordId !== itemId || existing.plannedTarget?.store !== 'calendar' || existing.plannedTarget?.id !== planId) {
    throw conflict('receipt-record-id-mismatch');
  }
  if (existing.state === 'applied') {
    return { result: { ...existing.result, idempotentReplay: true }, authority: existing.authority };
  }
  if (existing.state === 'rejected') {
    // The same definite answer as the first time: nothing was written, so a NEW action ID may be used.
    if (!Object.hasOwn(ERROR_CODES, existing.resultCode) || !DEFINITIVE_REFUSALS.has(existing.resultCode) || typeof existing.resultMessage !== 'string') {
      throw conflict('terminal-receipt');
    }
    throw new ApiError(existing.resultCode, existing.resultMessage, { reason: 'terminal-rejection' });
  }
  if (['conflict', 'needs_user_decision'].includes(existing.state)) throw conflict('terminal-receipt');
  if (!['started', 'pending_unknown'].includes(existing.state)) throw conflict('malformed-receipt-state');
  if (!claim.claimed) {
    if (classifyExistingReceipt(existing, { requestHash, nowMs }) === 'lease_active') throw pending();
    const takeover = { ...existing, attemptId, leaseAcquiredAt: nowMs, leaseExpiresAt: nowMs + LEASE_MS, updatedAt: nowMs };
    if ((await receipts.compareAndSet(identity.firebaseUid, actionId, takeover, snapshot.etag)) !== 'written') throw pending();
    snapshot = await receipts.readWithEtag(identity.firebaseUid, actionId);
  }
  if (snapshot.value?.attemptId !== attemptId || snapshot.value.requestHash !== requestHash) throw pending();
  const createdAt = snapshot.value.createdAt;

  const unknown = async () => {
    await settle(receipts, identity, actionId, snapshot, { state: 'pending_unknown', leaseExpiresAt: nowMs, updatedAt: nowMs });
    throw pending();
  };
  const refuse = async error => {
    // Terminal only on this action's FIRST attempt, which has itself written nothing. After a takeover an earlier
    // attempt may still commit, so the refusal is not proof of absence: stay unknown (same-action retry only).
    if (!claim.claimed) return unknown();
    await settle(receipts, identity, actionId, snapshot, { state: 'rejected', resultCode: error.code, resultMessage: error.message,
      retryability: 'not_retryable', updatedAt: nowMs });
    throw error;
  };
  const readOwned = async () => {
    try { return ownedItem(await domain.readPlanItem(identity, planId, itemId), actionId, itemId); }
    catch (error) {
      if (error?.code === 'CONFLICT') {
        await settle(receipts, identity, actionId, snapshot, { state: 'conflict', resultCode: 'CONFLICT', retryability: 'not_retryable', updatedAt: nowMs });
        throw error;
      }
      return unknown();
    }
  };

  let item = await readOwned();
  if (!item) {
    try {
      const homeZone = await assertWritableTarget(identity, { domain, nowMs, planId, itemId });
      const frozenZone = await ensurePlanOrigin(identity, { domain, planId, homeZone, createdAt });
      // Another device froze the origin first, in another zone: judge the target again in the zone that won.
      if (frozenZone !== homeZone && await assertWritableTarget(identity, { domain, nowMs, planId, itemId }) !== frozenZone) throw new ApiError('RETRYABLE_TRANSPORT', 'The plan origin changed.', { reason: 'plan-origin-moved' });
    } catch (error) {
      if (error instanceof ApiError && DEFINITIVE_REFUSALS.has(error.code)) return refuse(error);
      return unknown();
    }
    let refused = null;
    try { await domain.createPlanItemIfAbsent(identity, planId, itemId, actionId, buildItem(command, itemId, createdAt)); }
    catch (error) {
      if (error?.code === 'FORBIDDEN') refused = error;
      else if (error?.code !== 'RETRYABLE_TRANSPORT') throw error;
    }
    // Whatever the create said (created, exists, refused, timed out), only the exact child decides.
    item = await readOwned();
    if (!item) return refused ? refuse(refused) : unknown();
  }
  const result = resultFor({ actionId, itemId, planId, date, parameters, item, createdAt });
  const authority = { authority: 'plan_authority', store: 'calendar', access: 'user_scoped', targetId: planId,
    recordIds: [itemId], readAt: new Date(nowMs).toISOString() };
  const receipt = await settle(receipts, identity, actionId, snapshot, { state: 'applied', recordIds: [itemId],
    effectiveTarget: { store: 'calendar', id: planId, date }, authority, result, resultingRevision: result.revision,
    appliedAt: nowMs, updatedAt: nowMs, resultCode: 'APPLIED', retryability: 'not_retryable' });
  return { result: { ...receipt.result, idempotentReplay: !claim.claimed }, authority: receipt.authority };
}
