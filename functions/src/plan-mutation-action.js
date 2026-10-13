// functions/src/plan-mutation-action.js
//
// TASK-012 (DECISIONS #38; docs/CHRONASENSE_ACTION_API_V1.md §6/§10): conversational mutation of ONE EXISTING
// calendar plan item, through the same private receipt machinery as plan_create. Four semantic commands, each the
// server-side twin of the owner client's own Plan Authority operation (never a third model):
//
//   plan_set_completion  updateItem({done, doneAt}); on an ended plan only the carryover-completion exception
//                        (completeCarryoverItem: the item's own start lands on today's calendar date)
//   plan_edit            updateItem same target: title, explicit wall time, duration, or an explicit schedule clear
//   plan_move            updateItem cross-day: the SAME item id goes live at the destination with the next
//                        relocationRevision, and the source copy becomes a tombstone naming movedToDayId. Both
//                        records commit in ONE compare-and-set of the calendarPlans collection: a concurrent edit or
//                        delete of the source can never be silently undone by an already-landed destination copy,
//                        and no crash can leave half a move behind.
//   plan_delete          the in-place stamped tombstone (`deleted: true`), never a physical delete
//
// Location (decided by the item's own identity, never by the caller): an Action API item (`api1_`) or a fenced
// Brain Dump item (`bdp1|`) is its ONE keyed calendar fence child; any other item lives in the plan record's array.
// Every write is a user-scoped compare-and-set with the ORDINARY owner token, at a URL pinned by user-scoped-rtdb.js,
// through the unchanged rules (fence: marker pinned, tombstone monotonic, no relocation; array: no api1_/marker).
// A record write goes through mergeCalendarPlanRecords exactly as a client push does, so every other item,
// preparation and the plan origin survive, and an absent origin is frozen in the same write.
//
// Concurrency and recovery (the load-bearing part):
//   - expectedRevision is the item revision get_plan/get_item returned. It is compared against the item's
//     AUTHORITATIVE physical copy read with its ETag, and the write is conditional on that ETag, so a newer owner
//     edit is never overwritten: it changes the ETag (the CAS fails) and the revision (the action is stale).
//   - The post-state is deterministic AND action-specific: stamp = max(receipt.createdAt, pre.updatedAt + 1) and
//     updatedBy = the actionId (a writer name every merge already treats as an opaque tie-break string). Before
//     its FIRST domain write an attempt records that INTENT (stamp + planned resulting revisions) in the receipt by a
//     receipt compare-and-set. A takeover's receipt CAS therefore fences every earlier attempt that had not yet recorded
//     an intent: such an attempt can never write. If no intent exists, nothing this action did can ever land, and a
//     definite refusal is REJECTED, even after a takeover.
//   - Once an intent exists, an earlier attempt may still be in flight. Its write is conditional on the ETag it read,
//     which only matches while the item is still exactly the pre-state; it would then write the identical planned
//     post-state. So: item == planned post-state -> APPLIED; item == pre-state -> (re)apply the same post-state;
//     anything else -> PENDING_UNKNOWN (it may have applied and then been edited; that cannot be proven either way).
//   - APPLIED only after an authoritative re-read shows the planned revision(s).

import { calendarItemInstants, mergeCalendarPlanRecords, parseCalendarPlanId, validateCalendarPlanItem } from '../shared/calendar-plan-model.js';
import { captureIdOfPlanItem, fencedMoveRefusal, isActionPlanItemId, isFencedItem } from '../shared/plan-item-origin.js';
import { nextPlanItemRelocation } from '../shared/plan-item-relocation.js';
import { localPlanDate, planItemKind, validPlanItemTime } from '../shared/plan-tomorrow-model.js';
import { canonicalize } from './canonical-json.js';
import { ApiError, ERROR_CODES } from './errors.js';
import { createPlanRead, revision } from './plan-read.js';
import { ensurePlanOrigin, hasOrigin } from './plan-create-action.js';
import { canonicalRequestHash, classifyExistingReceipt } from './receipts.js';

const LEASE_MS = 30_000;
/** Observe -> decide -> conditional write rounds before the outcome is reported unknown. */
const ROUNDS = 4;
/** Plan Authority's default Top 3 (plan-authority.js priorityMax). */
const PRIORITY_MAX = 3;
/** Refusals that are facts about the account's authoritative state (not transport uncertainty). */
const DEFINITIVE_REFUSALS = new Set(['NOT_FOUND', 'CONFLICT', 'STALE_REVISION', 'PAST_TARGET_IMMUTABLE', 'FORBIDDEN', 'DOMAIN_LIMIT', 'NONEXISTENT_TIME']);
export const PLAN_MUTATION_KINDS = Object.freeze(['plan_set_completion', 'plan_edit', 'plan_move', 'plan_delete']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => canonicalize(a) === canonicalize(b);
const itemRevision = (planId, item) => revision({ v: 1, store: 'calendar', targetKey: planId, item });
/** Exactly what Realtime Database stores and reads back: a null (or undefined) value is no key at all. The planned
 *  post-state is compared against an authoritative re-read, so it is computed in this form. */
export function wireForm(value) {
  if (Array.isArray(value)) return value.map(wireForm);
  if (!object(value)) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null || child === undefined) continue;
    const next = wireForm(child);
    if (object(next) && !Object.keys(next).length) continue;
    out[key] = next;
  }
  return out;
}
const pending = (reason = 'plan-action-outcome-unknown', details) => new ApiError('PENDING_UNKNOWN',
  'The plan action outcome is being reconciled. Retry with the same action ID and parameters and a new request ID.', { reason, details });
const conflict = (message, reason, details) => new ApiError('CONFLICT', message, { reason, details });
const malformed = reason => conflict('The plan item authority contains incompatible data.', reason);
const pastTarget = () => new ApiError('PAST_TARGET_IMMUTABLE', 'That plan day has ended. Past plans are history and cannot be changed.', { reason: 'plan-target-past' });

/** Only an api1_/bdp1| id can name a fence child; every other id can only be an array item. */
const fenceCandidate = itemId => isActionPlanItemId(itemId) || captureIdOfPlanItem(itemId) !== null;

/** The item's ONE authoritative physical copy, with the ETag every write to it is conditional on. */
async function readPhysical(identity, domain, planId, itemId) {
  if (fenceCandidate(itemId)) {
    const child = await domain.readPlanFenceItemWithEtag(identity, planId, itemId);
    if (child.value !== null) {
      if (!object(child.value) || child.value.id !== itemId || !isFencedItem(child.value)) throw malformed('malformed-fence-item');
      return { where: 'fence', etag: child.etag, item: child.value };
    }
  }
  return readRecord(identity, domain, planId, itemId);
}

async function readRecord(identity, domain, planId, itemId) {
  const { value, etag } = await domain.readCalendarPlanWithEtag(identity, planId);
  if (value !== null && !object(value)) throw malformed('malformed-plan-record');
  const raw = value?.items ?? [];
  if (!Array.isArray(raw) && !object(raw)) throw malformed('malformed-plan-items');
  const matches = Object.values(raw).filter(item => object(item) && item.id === itemId);
  if (matches.length > 1) throw malformed('duplicate-plan-item');
  return { where: 'record', etag, record: value, item: matches[0] ?? null };
}

/** One conditional write of `next` to the copy `physical` was read from. A record write is the client's own push:
 *  mergeCalendarPlanRecords (per-item relocation order, then updatedAt), with the plan origin frozen if absent.
 *  @returns {Promise<'written'|'changed'>} */
async function writePhysical(identity, domain, planId, physical, next, { stampMs, writer, homeZone }) {
  if (physical.where === 'fence') return domain.putPlanFenceItemIfMatch(identity, planId, next.id, next, physical.etag);
  return domain.putCalendarPlanIfMatch(identity, planId, mergedRecord(physical.record, planId, next, { stampMs, writer, homeZone }), physical.etag);
}

/** `record` with `next` pushed into it exactly as a client push merges an item (relocation order, then updatedAt),
 *  its origin frozen if absent. */
function mergedRecord(record, planId, next, { stampMs, writer, homeZone }) {
  const candidate = { items: [next], updatedAt: stampMs, updatedBy: writer,
    ...(hasOrigin(record) ? {} : { createdAt: stampMs, timezone: homeZone }) };
  const merged = wireForm(mergeCalendarPlanRecords(record, candidate, planId));
  // The stored copy must not out-rank the action's item (a newer relocation elsewhere): never write a merge that drops it.
  if (!same(merged.items.find(item => item.id === next.id), next)) throw conflict('That plan item has a newer move or edit.', 'plan-item-outranked');
  return merged;
}

/** A move's view of the calendarPlans collection: the source copy, the destination copy, and the collection ETag. */
async function readMove(identity, domain, planId, destinationId, itemId) {
  const { value, etag } = await domain.readCalendarPlansWithEtag(identity);
  if (value !== null && !object(value)) throw malformed('malformed-plan-collection');
  const plans = value ?? {};
  const find = id => {
    const record = plans[id] ?? null;
    if (record !== null && !object(record)) throw malformed('malformed-plan-record');
    const raw = record?.items ?? [];
    if (!Array.isArray(raw) && !object(raw)) throw malformed('malformed-plan-items');
    const matches = Object.values(raw).filter(item => object(item) && item.id === itemId);
    if (matches.length > 1) throw malformed('duplicate-plan-item');
    return { record, item: matches[0] ?? null };
  };
  const source = find(planId);
  return { where: 'collection', etag, plans, record: source.record, item: source.item, destination: find(destinationId) };
}

function scheduleOf(date, item) {
  if (!validPlanItemTime(item.when)) return null;
  const instants = calendarItemInstants(date, item);
  if (!instants.ok || !instants.timed) return null;
  return { when: item.when, whenDayOffset: item.whenDayOffset || 0, whenTz: item.whenTz, durationMinutes: item.durationMinutes ?? null,
    startAt: new Date(instants.startMs).toISOString(), endAt: instants.endMs === null ? null : new Date(instants.endMs).toISOString() };
}

/** Wall-time/duration/clear changes, applied exactly as Plan Authority's editor applies them. */
function retimed(item, parameters) {
  const draft = { ...item };
  if (parameters.clearSchedule) {
    draft.when = '';
    for (const key of ['durationMinutes', 'endClock', 'whenTz', 'whenDayOffset']) delete draft[key];
  }
  if (parameters.time) {
    draft.when = parameters.time.when;
    draft.whenTz = parameters.time.whenTz;
    if (parameters.time.whenDayOffset) draft.whenDayOffset = 1; else delete draft.whenDayOffset; // absent === 0: one representation
  }
  if (Object.hasOwn(parameters, 'durationMinutes')) draft.durationMinutes = parameters.durationMinutes;
  return draft;
}

function assertValidOn(date, item) {
  const check = validateCalendarPlanItem(date, item);
  if (check.ok) return;
  if (check.reason === 'nonexistent-time') throw new ApiError('NONEXISTENT_TIME', 'That wall time does not exist on that date in that timezone (DST gap).', { reason: 'plan-nonexistent-time' });
  if (check.reason === 'outside-plan-extent') throw new ApiError('DOMAIN_LIMIT', 'A plan item must end before the start of the second day after its plan date.', { reason: 'plan-extent' });
  if (check.reason === 'invalid-range') throw new ApiError('DOMAIN_LIMIT', 'A duration needs a start time. Set a time first, or clear the schedule.', { reason: 'plan-duration-needs-time' });
  throw new ApiError('DOMAIN_LIMIT', 'That plan time is not valid for this item.', { reason: `plan-${check.reason}` });
}

/**
 * The planned post-state for the pre-state `pre` (already proven == expectedRevision and active in its plan), or a
 * no-op. Pure apart from the Plan Authority facts in `facts`. Throws a definitive ApiError for a domain refusal.
 * @returns {{noop:true} | {source:object, destination?:object}}
 */
export function planMutation(kind, parameters, pre, { stampMs, writer, date, ended, today, accountZone, destination }) {
  const stamped = item => wireForm({ ...item, updatedAt: stampMs, updatedBy: writer });
  if (kind === 'plan_set_completion') {
    if (ended) {
      // completeCarryoverItem: an ended plan's item is still live only when its own start lands on today's date.
      const instants = calendarItemInstants(date, pre);
      if (!(instants.ok && instants.timed && localPlanDate(instants.startMs, accountZone) === today)) throw pastTarget();
    }
    if ((pre.done === true) === parameters.completed) return { noop: true };
    return { source: stamped({ ...pre, done: parameters.completed, doneAt: parameters.completed ? stampMs : null }) };
  }
  if (ended) throw pastTarget();
  if (kind === 'plan_delete') return { source: stamped({ ...pre, deleted: true }) };
  if (kind === 'plan_edit') {
    const draft = retimed(Object.hasOwn(parameters, 'title') ? { ...pre, task: parameters.title } : pre, parameters);
    assertValidOn(date, draft);
    return same(wireForm(draft), pre) ? { noop: true } : { source: stamped(draft) };
  }
  // plan_move: Plan Authority refuses a location-bound item before anything is written (DECISIONS #33/#37), and a
  // stale-recovery copy is re-moved only through the Unfinished flow (its carry provenance names its source day).
  if (isFencedItem(pre)) throw new ApiError('DOMAIN_LIMIT', fencedMoveRefusal(pre), { reason: 'fenced-item-move-refused' });
  if (pre.carriedFromId !== undefined || pre.carriedFromDayId !== undefined) {
    throw new ApiError('DOMAIN_LIMIT', 'A task recovered from an earlier day is rescheduled from Unfinished, not moved.', { reason: 'carried-item-move-refused' });
  }
  if (destination.ended) throw pastTarget();
  const draft = retimed(pre, parameters);
  assertValidOn(destination.date, draft);
  if (planItemKind(pre) === 'priority' && destination.activePriorities >= PRIORITY_MAX) {
    throw new ApiError('DOMAIN_LIMIT', `That day's Top ${PRIORITY_MAX} is already full. Finish, remove or demote one first.`, { reason: 'priority-cap' });
  }
  const relocationRevision = nextPlanItemRelocation(pre, { fromDayId: destination.sourceId, toDayId: destination.id, updatedAt: stampMs, updatedBy: writer });
  const moved = stamped({ ...draft, relocationRevision, movedToDayId: null, ...(draft.deleted !== undefined ? { deleted: false } : {}) });
  return { source: stamped({ ...pre, deleted: true, movedToDayId: destination.id, relocationRevision }), destination: moved };
}

/** Bounded, title-free projection of where the item now is (the receipt never copies task text). */
function resultFor({ command, location, item, previousRevision, changed }) {
  const date = parseCalendarPlanId(location);
  return { actionId: command.actionId, itemId: command.parameters.itemId, operation: command.kind,
    target: { store: 'calendar', id: command.parameters.target.id, date: parseCalendarPlanId(command.parameters.target.id) },
    ...(command.kind === 'plan_move' ? { destination: { store: 'calendar', id: location, date } } : {}),
    item: { completed: item.done === true, deleted: item.deleted === true, schedule: item.deleted === true ? null : scheduleOf(date, item) },
    revision: itemRevision(location, item), previousRevision, changed };
}

async function settle(receipts, identity, actionId, snapshot, update) {
  const receipt = { ...snapshot.value, ...update };
  if ((await receipts.compareAndSet(identity.firebaseUid, actionId, receipt, snapshot.etag)) === 'written') return receipt;
  throw pending('receipt-contended');
}

const validIntent = intent => object(intent) && Number.isSafeInteger(intent.stampMs) && intent.stampMs > 0
  && typeof intent.sourceRevision === 'string' && (intent.destinationRevision === undefined || typeof intent.destinationRevision === 'string');

export async function mutatePlanAction(identity, { command, domain, receipts, attemptId, nowMs }) {
  const { actionId, actionProvenance, parameters, kind, expectedRevision } = command;
  if (!PLAN_MUTATION_KINDS.includes(kind)) throw new Error(`not a plan mutation: ${kind}`);
  const { itemId } = parameters;
  const planId = parameters.target.id;
  const date = parseCalendarPlanId(planId);
  const destinationId = kind === 'plan_move' ? parameters.destination.id : null;
  const actorRef = actionProvenance.actorRef;
  const requestHash = canonicalRequestHash(command);
  const claim = await receipts.claim({ firebaseUid: identity.firebaseUid, actionId, requestHash,
    kind, attemptId, nowMs, leaseMs: LEASE_MS, plannedRecordId: itemId, plannedTarget: { store: 'calendar', id: planId },
    authorizationContext: { actorRef, requiredScope: 'chronasense:plan.write',
      grantedScopes: identity.scopes, serviceIdentity: 'chronasense-plugin-worker-v1' },
    actionProvenanceRefs: { sourceKind: actionProvenance.sourceKind, capturedAt: actionProvenance.capturedAt } });
  let snapshot = await receipts.readWithEtag(identity.firebaseUid, actionId);
  if (!snapshot.value) throw pending();
  const existing = snapshot.value;
  if (existing.requestHash !== requestHash || existing.kind !== kind) {
    throw new ApiError('IDEMPOTENCY_CONFLICT', 'This action ID was used for a different command.', { reason: 'action-id-reuse' });
  }
  if (existing.plannedRecordId !== itemId || existing.plannedTarget?.store !== 'calendar' || existing.plannedTarget?.id !== planId) {
    throw conflict('The action receipt names a different item.', 'receipt-record-id-mismatch');
  }
  if (existing.state === 'applied') return { result: { ...existing.result, idempotentReplay: true }, authority: existing.authority };
  if (existing.state === 'rejected') {
    // The same definite answer as the first time: nothing was or ever can be written, so a NEW action ID may be used.
    if (!Object.hasOwn(ERROR_CODES, existing.resultCode) || !DEFINITIVE_REFUSALS.has(existing.resultCode) || typeof existing.resultMessage !== 'string') {
      throw conflict('The action receipt is terminal.', 'terminal-receipt');
    }
    throw new ApiError(existing.resultCode, existing.resultMessage, { reason: 'terminal-rejection', details: existing.resultDetails });
  }
  if (['conflict', 'needs_user_decision'].includes(existing.state)) throw conflict('The action receipt is terminal.', 'terminal-receipt');
  if (!['started', 'pending_unknown'].includes(existing.state)) throw conflict('The action receipt is malformed.', 'malformed-receipt-state');
  if (!claim.claimed) {
    if (classifyExistingReceipt(existing, { requestHash, nowMs }) === 'lease_active') throw pending('lease-active');
    const takeover = { ...existing, attemptId, leaseAcquiredAt: nowMs, leaseExpiresAt: nowMs + LEASE_MS, updatedAt: nowMs };
    if ((await receipts.compareAndSet(identity.firebaseUid, actionId, takeover, snapshot.etag)) !== 'written') throw pending('lease-contended');
    snapshot = await receipts.readWithEtag(identity.firebaseUid, actionId);
  }
  if (snapshot.value?.attemptId !== attemptId || snapshot.value.requestHash !== requestHash) throw pending('lease-contended');
  if (snapshot.value.intent !== undefined && !validIntent(snapshot.value.intent)) throw conflict('The action receipt is malformed.', 'malformed-receipt-intent');
  // Intent recorded by an EARLIER attempt: that attempt may still write. None: nothing earlier ever can.
  let intent = snapshot.value.intent ?? null;
  const earlierIntent = intent !== null;
  let ownWriteUnknown = false;
  let ownWriteLanded = false;

  const unknown = async (reason, details) => {
    await settle(receipts, identity, actionId, snapshot, { state: 'pending_unknown', leaseExpiresAt: nowMs, updatedAt: nowMs });
    throw pending(reason, details);
  };
  const refuse = async error => {
    // REJECTED only when no write of this action can ever land: no earlier attempt recorded an intent, and none of
    // this attempt's own writes landed or has an unknown result. Otherwise the refusal is not proof of absence.
    if (earlierIntent || ownWriteUnknown || ownWriteLanded) return unknown('refused-after-intent');
    await settle(receipts, identity, actionId, snapshot, { state: 'rejected', resultCode: error.code, resultMessage: error.message,
      ...(error.details ? { resultDetails: error.details } : {}), retryability: 'not_retryable', updatedAt: nowMs });
    throw error;
  };
  const applied = async (location, item, changed) => {
    const result = resultFor({ command, location, item, previousRevision: expectedRevision, changed });
    const authority = { authority: 'plan_authority', store: 'calendar', access: 'user_scoped', targetId: location,
      recordIds: [itemId], readAt: new Date(nowMs).toISOString() };
    const receipt = await settle(receipts, identity, actionId, snapshot, { state: 'applied', recordIds: [itemId],
      effectiveTarget: { store: 'calendar', id: location, date: parseCalendarPlanId(location) }, authority, result,
      resultingRevision: result.revision, appliedAt: nowMs, updatedAt: nowMs, resultCode: 'APPLIED', retryability: 'not_retryable' });
    return { result: { ...receipt.result, idempotentReplay: !claim.claimed }, authority: receipt.authority };
  };
  // Records the intent BEFORE the first domain write. The receipt CAS is the writer fence for every older attempt.
  const recordIntent = async planned => {
    const update = { intent: planned, updatedAt: nowMs };
    if ((await receipts.compareAndSet(identity.firebaseUid, actionId, { ...snapshot.value, ...update }, snapshot.etag)) !== 'written') throw pending('lease-contended');
    snapshot = await receipts.readWithEtag(identity.firebaseUid, actionId);
    if (snapshot.value?.attemptId !== attemptId || !same(snapshot.value.intent, planned)) throw pending('lease-contended');
    intent = planned;
  };

  for (let round = 0; round < ROUNDS; round++) {
    // ── observe: Plan Authority's server read (routing, frozen home zone, ended, active) + the exact physical copies
    let source, physical, destination = null, reader;
    try {
      reader = await createPlanRead(identity, { domain, nowMs });
      source = await reader.read({ store: 'calendar', id: planId });
      physical = await readPhysical(identity, domain, planId, itemId);
      if (destinationId) {
        destination = await reader.read({ store: 'calendar', id: destinationId });
        // An array item moves through ONE collection compare-and-set; a keyed item is refused before any write.
        if (physical.where === 'record') physical = await readMove(identity, domain, planId, destinationId, itemId);
      }
    } catch (error) {
      if (error instanceof ApiError && DEFINITIVE_REFUSALS.has(error.code)) return refuse(error);
      if (error instanceof ApiError) return unknown('observe-unavailable');
      throw error;
    }
    const pre = physical.item;
    const currentRevision = pre ? itemRevision(planId, pre) : null;

    // ── proof: the planned post-state is authoritative (its writer is this actionId: no other action can produce it)
    if (intent && currentRevision === intent.sourceRevision) {
      if (kind !== 'plan_move') return applied(planId, pre, true);
      // The source tombstone and the destination copy committed together: the tombstone proves the move.
      const moved = physical.destination?.item;
      if (!moved) return unknown('moved-item-missing');
      return applied(destinationId, moved, true);
    }
    // ── precondition: the item is exactly what the caller read, and still live in this plan
    if (!pre) return refuse(new ApiError('NOT_FOUND', 'That plan item does not exist in that plan.', { reason: 'plan-item-absent' }));
    if (currentRevision !== expectedRevision) {
      // An earlier attempt's write, or one of ours with an unknown result, may have applied and then been edited over.
      if (earlierIntent || ownWriteUnknown || ownWriteLanded) return unknown('item-changed-after-intent', { itemChanged: true });
      const active = source.items.find(item => item.itemId === itemId);
      return refuse(new ApiError('STALE_REVISION', 'That plan item changed since it was read. Read it again before changing it.',
        { reason: 'plan-item-stale', details: active ? { currentRevision: active.revision } : { state: pre.deleted === true ? 'tombstoned' : 'inactive' } }));
    }
    if (pre.deleted === true) return refuse(conflict('That plan item was removed.', 'plan-item-deleted', { state: 'tombstoned' }));
    if (!source.items.some(item => item.itemId === itemId)) {
      const inactive = await reader.inactiveItem({ store: 'calendar', id: planId }, itemId).catch(() => null);
      return refuse(conflict('That plan item is no longer active in that plan.', 'plan-item-inactive',
        inactive?.destinationTargetId ? { state: 'relocated', destinationTargetId: inactive.destinationTargetId } : { state: 'inactive' }));
    }

    // ── decide: the same Plan Authority semantics the owner's client applies
    const stampMs = intent?.stampMs ?? Math.max(snapshot.value.createdAt, (Number.isSafeInteger(pre.updatedAt) ? pre.updatedAt : 0) + 1);
    let planned;
    try {
      planned = planMutation(kind, parameters, pre, { stampMs, writer: actionId, date, ended: source.target.endMs <= nowMs,
        today: reader.today, accountZone: reader.timezone,
        destination: destination && { id: destinationId, sourceId: planId, date: destination.target.date, ended: destination.target.endMs <= nowMs,
          activePriorities: destination.items.filter(item => item.itemId !== itemId && item.kind === 'priority').length } });
    } catch (error) {
      if (error instanceof ApiError && DEFINITIVE_REFUSALS.has(error.code)) return refuse(error);
      throw error;
    }
    if (planned.noop) {
      if (intent) throw conflict('The action receipt is inconsistent with its item.', 'intent-noop-mismatch');
      return applied(planId, pre, false);
    }
    // Stored exactly as RTDB keeps it (a non-move has no destination revision key at all).
    const wanted = wireForm({ stampMs, sourceRevision: itemRevision(planId, planned.source),
      destinationRevision: planned.destination ? itemRevision(destinationId, planned.destination) : null });
    if (intent && !same(intent, wanted)) throw conflict('The action receipt is inconsistent with its item.', 'intent-mismatch');

    // ── origin: a plan holding only keyed items may have no canonical origin yet. Freeze it (R011-02) before
    // mutating its item, then observe again: the zone that won may differ from the one this round judged in.
    if (physical.where === 'fence') {
      try {
        if (!hasOrigin((await domain.readCalendarPlanWithEtag(identity, planId)).value)) {
          await ensurePlanOrigin(identity, { domain, planId, homeZone: source.target.timezone, createdAt: stampMs });
          continue;
        }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'RETRYABLE_TRANSPORT') continue; // the origin is not the item
        if (error instanceof ApiError && DEFINITIVE_REFUSALS.has(error.code)) return refuse(error);
        throw error;
      }
    }
    if (!intent) await recordIntent(wanted);

    // ── write: ONE conditional write on the ETag just read; any doubt goes back to observe
    try {
      let outcome;
      if (planned.destination) {
        // Destination origin frozen in the same write when absent, in the zone the destination was judged in.
        const plans = { ...physical.plans,
          [planId]: mergedRecord(physical.record, planId, planned.source, { stampMs, writer: actionId, homeZone: source.target.timezone }),
          [destinationId]: mergedRecord(physical.destination.record, destinationId, planned.destination, { stampMs, writer: actionId, homeZone: destination.target.timezone }) };
        outcome = await domain.putCalendarPlansIfMatch(identity, plans, physical.etag);
      } else {
        outcome = await writePhysical(identity, domain, planId, physical, planned.source, { stampMs, writer: actionId, homeZone: source.target.timezone });
      }
      if (outcome === 'written') ownWriteLanded = true;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RETRYABLE_TRANSPORT') { ownWriteUnknown = true; continue; }
      if (error instanceof ApiError && DEFINITIVE_REFUSALS.has(error.code)) return refuse(error);
      throw error;
    }
  }
  return unknown('rounds-exhausted');
}
