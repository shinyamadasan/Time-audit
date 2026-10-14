// TASK-012 mutation anchors. Each test copies functions/src/plan-mutation-action.js, breaks exactly ONE load-bearing
// guard in the copy, and runs the SAME scenario that the shipped module passes. The mutant must visibly fail, or the
// guard is not load-bearing and a regression could ship unnoticed (the same discipline as fence-source-mutation.test.js).
//
// Copies are written into test/ as `.mutant-*.js` (never into src/, which other suites scan) with their relative
// imports pointed back at src/, and removed afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { actionActorRef } from '../src/envelope.js';
import { ApiError } from '../src/errors.js';
import * as shipped from '../src/plan-mutation-action.js';
import { revision } from '../src/plan-read.js';
import { createReceiptStore } from '../src/receipts.js';
import { addCalendarDays, localPlanDate } from '../shared/plan-tomorrow-model.js';
import { planDomain, ZONE } from './plan-domain-support.js';
import { NOW_MS, OWNER, fakeInfra } from './support.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, '..', 'src', 'plan-mutation-action.js');
const created = [];
test.after(() => { for (const file of created) { try { unlinkSync(file); } catch { /* already gone */ } } });

/** Imports a copy with each [from, to] edit applied; every edit must match exactly once. */
async function mutant(edits, tag) {
  let source = readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of edits) {
    assert.equal(source.split(from).length - 1, 1, `the guard to break must appear exactly once: ${from.slice(0, 90)}`);
    source = source.replace(from, to);
  }
  source = source.replace(/from '\.\/([^']+)'/g, "from '../src/$1'");
  const out = path.join(HERE, `.mutant-${tag}-plan-mutation-action.js`);
  writeFileSync(out, source);
  created.push(out);
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

const TODAY = localPlanDate(NOW_MS, ZONE);
const PLAN = `cal1:${addCalendarDays(TODAY, 1)}`;
const OTHER = `cal1:${addCalendarDays(TODAY, 2)}`;
const T0 = NOW_MS - 3_600_000;
const IDENTITY = Object.freeze({ firebaseUid: OWNER.ownerFirebaseUid, roomId: `uid_${OWNER.ownerFirebaseUid}`, scopes: ['chronasense:plan.write'] });
const gym = (extra = {}) => ({ id: 'pgym1', task: 'Gym', when: '18:00', whenTz: ZONE, durationMinutes: 60, done: false, updatedAt: T0, updatedBy: 'phone', ...extra });
const record = (items, extra = {}) => ({ createdAt: T0 - 1000, timezone: ZONE, updatedAt: T0, updatedBy: 'phone', items, ...extra });
const raw = (store, planId, itemId = 'pgym1') => (store.room.calendarPlans[planId]?.items || []).find(item => item.id === itemId);
const revOf = item => revision({ v: 1, store: 'calendar', targetKey: PLAN, item });
// TASK-012 api1_ move fixtures.
const API_ACTION = 'act1_550e8400-e29b-41d4-a716-446655440000';
const API_ITEM = 'api1_550e8400-e29b-41d4-a716-446655440000';
const apiItem = (extra = {}) => ({ id: API_ITEM, task: 'Gym', when: '18:00', whenTz: ZONE, durationMinutes: 60, done: false, updatedAt: T0, updatedBy: 'phone',
  kind: 'task', creationActionId: API_ACTION, ...extra });
const apiDomain = (extraFences = {}, hooks = {}) => planDomain({ calendarPlans: { [PLAN]: record([]) }, calendarPlanFences: { [PLAN]: { [API_ITEM]: apiItem() }, ...extraFences } }, hooks);
const moveApi = (impl, domain, { destination = OTHER, itemId = API_ITEM, item } = {}) => run(impl, { domain, infra: fakeInfra(),
  cmd: { ...command('plan_move', { destination: { store: 'calendar', id: destination } }, revOf(item ?? domain.room.calendarPlanFences[PLAN][itemId])),
    parameters: { target: { store: 'calendar', id: PLAN }, itemId, destination: { store: 'calendar', id: destination } } } });

/** One normalized command, exactly as parseCreateEnvelope produces it. */
function command(kind, parameters, expectedRevision, actionId = `act1_${randomUUID()}`) {
  return { contractVersion: 1, actionId, kind, parameters: { target: { store: 'calendar', id: PLAN }, itemId: 'pgym1', ...parameters }, expectedRevision,
    actionProvenance: { version: 1, sourceKind: 'chatgpt_plugin', actionId, actorRef: actionActorRef(OWNER.ownerSubject), capturedAt: new Date(NOW_MS).toISOString() } };
}
async function run(impl, { domain, infra, cmd, nowMs = NOW_MS }) {
  try { return { ok: await impl.mutatePlanAction(IDENTITY, { command: cmd, domain, receipts: createReceiptStore({ infra }), attemptId: randomUUID(), nowMs }) }; }
  catch (error) { return { code: error instanceof ApiError ? error.code : 'CRASH' }; }
}

// ── scenarios (each returns true when the invariant held) ────────────────────
const scenarios = {
  /** A newer owner edit is never overwritten by a stale conversational write. */
  async staleRefused(impl) {
    const domain = planDomain({ calendarPlans: { [PLAN]: record([gym()]) } });
    const stale = revOf(raw(domain, PLAN));
    domain.ownerRecord(PLAN, record([gym({ task: 'Owner edit', updatedAt: T0 + 5 })]));
    const result = await run(impl, { domain, infra: fakeInfra(), cmd: command('plan_edit', { title: 'Strength' }, stale) });
    return result.code === 'STALE_REVISION' && raw(domain, PLAN).task === 'Owner edit';
  },
  /** Crash after the write, before the receipt: the takeover proves APPLIED (never a false STALE rejection). */
  async proveAfterCrash(impl) {
    let crash = true;
    const domain = planDomain({ calendarPlans: { [PLAN]: record([gym()]) } }, { async afterRecordPut() { if (crash) { crash = false; throw new Error('died'); } } });
    const infra = fakeInfra();
    const cmd = command('plan_set_completion', { completed: true }, revOf(raw(domain, PLAN)));
    const first = await run(impl, { domain, infra, cmd });
    const retry = await run(impl, { domain, infra, cmd, nowMs: NOW_MS + 31_000 });
    return first.code === 'CRASH' && !!retry.ok && domain.writes.length === 1;
  },
  /** Crash after the intent, then the plan day ends: the item is still exactly the pre-state, so the earlier attempt's
   *  conditional write could still land. A refusal now (PAST) is not proof of absence: never rejected. */
  async neverRejectAfterIntent(impl) {
    let crash = true;
    const domain = planDomain({ calendarPlans: { [PLAN]: record([gym()]) } }, { async beforeRecordPut() { if (crash) { crash = false; throw new Error('died'); } } });
    const infra = fakeInfra();
    const cmd = command('plan_edit', { title: 'Strength' }, revOf(raw(domain, PLAN)));
    await run(impl, { domain, infra, cmd });
    const retry = await run(impl, { domain, infra, cmd, nowMs: NOW_MS + 3 * 86_400_000 });
    return retry.code === 'PENDING_UNKNOWN';
  },
  /** A move into an absent plan freezes that plan's origin (home zone) in the same write. */
  async destinationOriginFrozen(impl) {
    const domain = planDomain({ calendarPlans: { [PLAN]: record([gym()]) } });
    const result = await run(impl, { domain, infra: fakeInfra(), cmd: command('plan_move', { destination: { store: 'calendar', id: OTHER } }, revOf(raw(domain, PLAN))) });
    const destination = domain.room.calendarPlans[OTHER];
    return !!result.ok && destination?.timezone === ZONE && Number.isFinite(destination?.createdAt);
  },
  /** A move leaves the source copy as a tombstone naming its destination: never a second live source copy. */
  async sourceTombstoned(impl) {
    const domain = planDomain({ calendarPlans: { [PLAN]: record([gym()]) } });
    const result = await run(impl, { domain, infra: fakeInfra(), cmd: command('plan_move', { destination: { store: 'calendar', id: OTHER } }, revOf(raw(domain, PLAN))) });
    return !!result.ok && raw(domain, PLAN).deleted === true && raw(domain, PLAN).movedToDayId === OTHER;
  },
  /** An uncomplete (doneAt cleared) is proven against what RTDB actually stores (null pruned). */
  async wireFormProven(impl) {
    const domain = planDomain({ calendarPlans: { [PLAN]: record([gym({ done: true, doneAt: T0 })]) } });
    const result = await run(impl, { domain, infra: fakeInfra(), cmd: command('plan_set_completion', { completed: false }, revOf(raw(domain, PLAN))) });
    return !!result.ok && raw(domain, PLAN).done === false;
  },
  /** The source changes between the move's read and its write: the atomic CAS refuses; the owner's delete stands. */
  async moveNeverUndoesConcurrentDelete(impl) {
    // The owner deletes AFTER the move read the collection and before its write lands: at the first of a second
    // collection read or the write itself (so a write that re-reads its ETag just before writing is caught too).
    let once = true;
    let reads = 0;
    const ownerDelete = () => { if (once) { once = false; domain.ownerRecord(PLAN, record([gym({ deleted: true, updatedAt: T0 + 2 })])); } };
    const domain = planDomain({ calendarPlans: { [PLAN]: record([gym()]) } }, {
      async beforePlansRead() { if (++reads === 2) ownerDelete(); },
      async beforePlansPut() { ownerDelete(); },
    });
    const result = await run(impl, { domain, infra: fakeInfra(), cmd: command('plan_move', { destination: { store: 'calendar', id: OTHER } }, revOf(raw(domain, PLAN))) });
    return result.code === 'STALE_REVISION' && domain.room.calendarPlans[OTHER] === undefined && raw(domain, PLAN).deleted === true;
  },
  /** R1: a SAME-STAMP owner edit between the Function's read and its lock never moves stale content. */
  async apiSameStampEditIsStale(impl) {
    let once = true;
    // Right after the Function's source read in the round that locks (the destination origin is frozen by then).
    const domain = apiDomain({}, { async afterFenceRead(planId, itemId, value) {
      if (once && planId === PLAN && value && !value.moveLock && domain.room.calendarPlans[OTHER]) { once = false; domain.ownerFence(PLAN, apiItem({ task: 'Strength' })); }
    } });
    const result = await moveApi(impl, domain);
    return result.code === 'STALE_REVISION' && !domain.room.calendarPlanFences[OTHER] && domain.room.calendarPlanFences[PLAN][API_ITEM].task === 'Strength';
  },
  /** R1: this action's own lock expiring before the relocation is re-taken (from the same pre-image), never forced. */
  async apiExpiredLockRetaken(impl) {
    let once = true;
    const domain = apiDomain({}, { async beforeRelocate() { if (once) { once = false; domain.serverNow += 61_000; } } });
    const result = await moveApi(impl, domain);
    return !!result.ok && domain.writes.filter(write => write.where === 'lock').length === 2;
  },
  /** api1_: a move into a plan with no record freezes that plan's origin before the item lands there. */
  async apiDestinationOriginFrozen(impl) {
    const domain = apiDomain();
    const result = await moveApi(impl, domain);
    return !!result.ok && domain.room.calendarPlans[OTHER]?.timezone === ZONE && !!domain.room.calendarPlanFences[OTHER]?.[API_ITEM];
  },
  /** api1_: moving back onto its own move tombstone is a typed DOMAIN_LIMIT (a fence tombstone is never revived). */
  async apiOwnHistoryRefused(impl) {
    const domain = apiDomain({ [OTHER]: { [API_ITEM]: apiItem({ deleted: true, movedToDayId: PLAN }) } });
    const result = await moveApi(impl, domain);
    return result.code === 'DOMAIN_LIMIT' && domain.writes.length === 0;
  },
  /** bdp1|: a fenced Brain Dump item still never moves (its capture's promotion names its one location). */
  async brainDumpNeverMoves(impl) {
    const bdItem = { id: 'bdp1|cap_gym01', task: 'Gym', when: '', done: false, updatedAt: T0, updatedBy: 'phone', kind: 'task',
      brainDumpOrigin: { v: 2, claimEpoch: 0, type: 'schedule', store: 'calendar', targetKey: PLAN } };
    const domain = planDomain({ calendarPlans: { [PLAN]: record([]) }, calendarPlanFences: { [PLAN]: { [bdItem.id]: bdItem } } });
    const result = await moveApi(impl, domain, { itemId: bdItem.id, item: bdItem });
    return result.code === 'DOMAIN_LIMIT' && !domain.room.calendarPlanFences[OTHER];
  },
};

test('baseline: the shipped module passes every anchor scenario', async () => {
  for (const [name, scenario] of Object.entries(scenarios)) assert.equal(await scenario(shipped), true, name);
});

const ANCHORS = [
  ['revision check removed -> a stale write overwrites a newer owner edit', 'staleRefused',
    [["    if (currentRevision !== expectedRevision) {", '    if (false) {']]],
  ['intent never recorded -> an applied action is falsely rejected after a crash', 'proveAfterCrash',
    [['    if (!intent) await recordIntent(wanted);', '']]],
  ['takeover may reject after an intent -> a possibly-applied action is reported rejected', 'neverRejectAfterIntent',
    [['    if (earlierIntent || ownWriteUnknown || ownWriteLanded) return unknown(\'refused-after-intent\');', '']]],
  ['destination origin freeze omitted -> a populated plan keeps a floating home zone', 'destinationOriginFrozen',
    [['    ...(hasOrigin(record) ? {} : { createdAt: stampMs, timezone: homeZone }) };', '  };']]],
  ['source tombstone dropped -> the old source copy survives the move', 'sourceTombstoned',
    [["  return { source: stamped({ ...pre, deleted: true, movedToDayId: destination.id, relocationRevision }), destination: moved };",
      '  return { source: stamped({ ...pre }), destination: moved };']]],
  ['wire form ignored -> an applied uncomplete can never be proven', 'wireFormProven',
    [['  const stamped = item => wireForm({ ...item, updatedAt: stampMs, updatedBy: writer });', '  const stamped = item => ({ ...item, updatedAt: stampMs, updatedBy: writer });']]],
  ['move write not conditional on the read -> a concurrent owner delete is silently undone', 'moveNeverUndoesConcurrentDelete',
    [['        outcome = await domain.putCalendarPlansIfMatch(identity, plans, physical.etag);',
      '        outcome = await domain.putCalendarPlansIfMatch(identity, plans, (await domain.readCalendarPlansWithEtag(identity)).etag);']]],
  ['R1: lock not conditional on the read AND relocation in the same round -> a same-stamp edit is moved as stale content', 'apiSameStampEditIsStale',
    [["etag: physical.etag });\n        continue; // 'written' or 'changed': observe again (the lock, or whatever changed instead)",
      "etag: (await domain.readPlanFenceItemWithEtag(identity, planId, itemId)).etag });\n        outcome = await domain.relocateActionPlanItem(identity, { actionId, sourcePlanId: planId, destinationPlanId: destinationId, itemId, tombstone: planned.source, moved: planned.destination });"]]],
  ['expired own lock not re-taken -> the move fails instead of re-locking the same pre-image', 'apiExpiredLockRetaken',
    [['        if (fenceMove && holds && !relocationRefused) { relocationRefused = true; relockNeeded = true; continue; }', '']]],
  ['destination origin freeze skipped for an api1_ move -> the plan it lands in keeps a floating home zone', 'apiDestinationOriginFrozen',
    [['    if (fenceMove) {\n      // The destination plan\'s origin, likewise frozen before anything lands there.', '    if (false) {\n      // The destination plan\'s origin, likewise frozen before anything lands there.']]],
  ['own-history check removed -> a move back onto its tombstone is no longer a typed refusal', 'apiOwnHistoryRefused',
    [['    if (fenceMove && physical.destination.item !== null) {', '    if (false) {']]],
  ['bdp1| refusal removed -> a fenced Brain Dump item is relocated away from its promotion', 'brainDumpNeverMoves',
    [['  if (isFencedItem(pre) && !isActionPlanItem(pre)) throw', '  if (false) throw']]],
];

for (const [title, scenario, edits] of ANCHORS) {
  test(`mutant: ${title}`, async () => {
    const impl = await mutant(edits, scenario);
    assert.equal(await scenarios[scenario](impl), false, 'the mutant must FAIL the scenario the shipped module passes');
  });
}
