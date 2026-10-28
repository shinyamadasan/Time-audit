// TASK-036 (DECISIONS #41): plan_set_completion on a LEGACY plan target — the `plans/<YYYY-MM-DD>` record (and its
// `planFences/<YYYY-MM-DD>/<bdp1|id>` children) of an account that never ran the calendar cutover. Same receipts,
// revisions, idempotency and recovery as the calendar path; the write replaces exactly one item in the stored record.
// Edit and delete still refuse a legacy target (TASK-038 adds legacy -> legacy moves: plan-legacy-move.test.js), and the
// calendar path is unchanged (plan-mutation-action.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { COMMAND_PATH } from '../src/action-api.js';
import { actionActorRef } from '../src/envelope.js';
import { ApiError } from '../src/errors.js';
import { addCalendarDays, localPlanDate, mergeDatePlans } from '../shared/plan-tomorrow-model.js';
import { legacyBoundaryRevision, proposeBoundaryRevision } from '../shared/personal-day-boundary-model.js';
import { NOW_MS, OWNER, harness, signedRequest } from './support.js';
import { FACT, ZONE, planDomain } from './plan-domain-support.js';

const TODAY = localPlanDate(NOW_MS, ZONE);
const YESTERDAY = addCalendarDays(TODAY, -1);
const ACTOR = actionActorRef(OWNER.ownerSubject);
const RECEIPT = actionId => `serverActionReceipts/${OWNER.ownerFirebaseUid}/${actionId}`;
const T0 = NOW_MS - 3_600_000;
const BD_ITEM = 'bdp1|cap_menu01';
const newAction = () => `act1_${randomUUID()}`;
const target = (id = TODAY) => ({ store: 'legacy', id });

const task = (id, title, overrides = {}) => ({ id, task: title, when: '', done: false, kind: 'task', updatedAt: T0, updatedBy: 'phone', ...overrides });
const products = (o = {}) => task('p1', 'Post remaining products', o);
const menu = (o = {}) => task('p2', 'Make price menu', { durationMinutes: 60, ...o });
const kuryente = (o = {}) => task('p3', 'Pay apartment kuryente', { when: '17:00', ...o });
// A prepared legacy plan whose empty routineInstanceIds RTDB has already pruned: the legacy merge would not restore it.
const PREPARATION = { targetDate: TODAY, firstPreparedAt: T0 - 5000, timezone: ZONE, oneOffItemIds: ['p1', 'p2', 'p3'] };
const legacyRecord = (items, extra = {}) => ({ updatedAt: T0, updatedBy: 'phone', preparation: PREPARATION, items, ...extra });
const bdItem = (o = {}) => ({ id: BD_ITEM, task: 'Make price menu', when: '', done: false, kind: 'task', updatedAt: T0, updatedBy: 'phone',
  brainDumpOrigin: { v: 2, claimEpoch: 0, type: 'do-today', store: 'legacy', targetKey: TODAY }, ...o });
/** A never-activated account: no calendarPlanAuthority fact, so its plans route to the legacy store. */
const legacyAccount = (plans, extra = {}) => ({ calendarPlanAuthority: {}, plans, ...extra });

const provenanceFor = actionId => ({ version: 1, sourceKind: 'chatgpt_plugin', actionId, actorRef: ACTOR, capturedAt: new Date(NOW_MS).toISOString() });
function command(kind, parameters, { actionId = newAction(), expectedRevision } = {}) {
  const requestId = randomUUID();
  return signedRequest({ path: COMMAND_PATH, requestId, signed: { path: COMMAND_PATH, scopes: ['chronasense:plan.write'] },
    envelope: { contractVersion: 1, requestId, actionId, kind, parameters, expectedRevision, actionProvenance: provenanceFor(actionId) } });
}
async function query(h, kind, parameters) {
  const requestId = randomUUID();
  const response = await h.handle(signedRequest({ requestId, envelope: { contractVersion: 1, requestId, kind, parameters } }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.result;
}
const revisionOf = async (h, itemId, dateKey = TODAY) => (await query(h, 'get_item', { source: 'plan', id: itemId, target: target(dateKey) })).item.revision;
const code = response => response.body.error?.code;
const stored = (store, itemId, dateKey = TODAY) => Object.values(store.room.plans?.[dateKey]?.items || {}).find(item => item?.id === itemId);
const complete = (itemId, completed = true, dateKey = TODAY) => ({ target: target(dateKey), itemId, completed });
function setup(seed, hooks) {
  const store = planDomain(seed, hooks);
  return { store, h: harness({ domain: store }) };
}
function harnessWithInfra(domain, infra, nowMs) {
  const h = harness({ domain, nowMs });
  for (const key of ['createIfAbsent', 'get', 'getWithEtag', 'putIfMatch']) h.infra[key] = infra[key].bind(infra);
  h.infra.data = infra.data;
  return h;
}

test('get_today on a never-activated account names the legacy plan, and its items carry legacy-store revisions', async () => {
  const { h } = setup(legacyAccount({ [TODAY]: legacyRecord([products(), menu(), kuryente()]) }));
  const { plan } = await query(h, 'get_today', {});
  assert.equal(plan.target.store, 'legacy');
  assert.equal(plan.target.id, TODAY);
  assert.deepEqual(plan.items.map(item => item.itemId), ['p1', 'p2', 'p3']);
  assert.equal(plan.items[0].revision, await revisionOf(h, 'p1'), 'the revision get_today returns is the one completion checks');
});

test('complete "Post remaining products" and "Make price menu": same ids and plan, the third task and the preparation byte-identical', async () => {
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products(), menu(), kuryente()]) }));
  const before = structuredClone(store.room.plans[TODAY]);
  const results = [];
  for (const itemId of ['p1', 'p2']) {
    const actionId = newAction();
    const previous = await revisionOf(h, itemId);
    const response = await h.handle(command('plan_set_completion', complete(itemId), { actionId, expectedRevision: previous }));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { result } = response.body;
    assert.deepEqual(result.target, { store: 'legacy', id: TODAY, date: TODAY });
    assert.equal(result.itemId, itemId);
    assert.equal(result.item.completed, true);
    assert.equal(result.changed, true);
    assert.equal(result.previousRevision, previous);
    assert.equal(result.revision, await revisionOf(h, itemId), 'the result revision is the readable one');
    const receipt = h.infra.data.get(RECEIPT(actionId));
    assert.equal(receipt.state, 'applied');
    assert.deepEqual(receipt.plannedTarget, { store: 'legacy', id: TODAY });
    assert.deepEqual(receipt.effectiveTarget, { store: 'legacy', id: TODAY, date: TODAY });
    assert.equal(receipt.authority.store, 'legacy');
    assert.ok(!JSON.stringify(receipt).includes('price menu'), 'the receipt never copies the task text');
    results.push({ itemId, actionId });
  }
  const after = store.room.plans[TODAY];
  assert.deepEqual(stored(store, 'p1'), products({ done: true, doneAt: NOW_MS, updatedAt: NOW_MS, updatedBy: results[0].actionId }));
  assert.deepEqual(stored(store, 'p2'), menu({ done: true, doneAt: NOW_MS, updatedAt: NOW_MS, updatedBy: results[1].actionId }));
  assert.deepEqual(stored(store, 'p3'), before.items[2], '"Pay apartment kuryente" is unchanged');
  assert.deepEqual(after.items.map(item => item.id), ['p1', 'p2', 'p3'], 'same items, same positions');
  assert.deepEqual(after.preparation, PREPARATION, 'a pruned preparation is kept exactly as stored');
  assert.equal(after.updatedAt, NOW_MS);
  assert.equal(after.updatedBy, results[1].actionId);
  assert.equal(store.writes.length, 2);
  assert.ok(store.writes.every(write => write.where === 'legacy-record' && write.planId === TODAY));
  assert.deepEqual(Object.keys(store.room.calendarPlans), [], 'nothing is written to the calendar store');
  assert.equal(store.room.calendarPlanAuthority && Object.keys(store.room.calendarPlanAuthority).length, 0, 'no cutover, no migration');
});

test('replay of the same action is idempotent: same result, no second write', async () => {
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products()]) }));
  const actionId = newAction();
  const expectedRevision = await revisionOf(h, 'p1');
  const first = await h.handle(command('plan_set_completion', complete('p1'), { actionId, expectedRevision }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await h.handle(command('plan_set_completion', complete('p1'), { actionId, expectedRevision }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.result.idempotentReplay, true);
  assert.equal(replay.body.result.revision, first.body.result.revision);
  assert.equal(store.writes.length, 1);
  const reuse = await h.handle(command('plan_set_completion', complete('p1', false), { actionId, expectedRevision }));
  assert.equal(code(reuse), 'IDEMPOTENCY_CONFLICT', 'an action id never names a different command');
});

test('Undo: completed:false makes it not done again (doneAt removed, not null); already in that state is a no-op success', async () => {
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products()]) }));
  assert.equal((await h.handle(command('plan_set_completion', complete('p1'), { expectedRevision: await revisionOf(h, 'p1') }))).status, 200);
  const undo = await h.handle(command('plan_set_completion', complete('p1', false), { expectedRevision: await revisionOf(h, 'p1') }));
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  const item = stored(store, 'p1');
  assert.equal(item.done, false);
  assert.ok(!Object.hasOwn(item, 'doneAt'));
  const again = await h.handle(command('plan_set_completion', complete('p1', false), { expectedRevision: await revisionOf(h, 'p1') }));
  assert.equal(again.status, 200);
  assert.equal(again.body.result.changed, false);
  assert.equal(store.writes.length, 2, 'the no-op wrote nothing');
});

test('a legacy-fenced Brain Dump item completes at its own fence child; marker pinned, the record untouched', async () => {
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([kuryente()]) }, { planFences: { [TODAY]: { [BD_ITEM]: bdItem() } } }));
  const record = structuredClone(store.room.plans[TODAY]);
  const response = await h.handle(command('plan_set_completion', complete(BD_ITEM), { expectedRevision: await revisionOf(h, BD_ITEM) }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const child = store.room.planFences[TODAY][BD_ITEM];
  assert.equal(child.done, true);
  assert.deepEqual(child.brainDumpOrigin, bdItem().brainDumpOrigin);
  assert.deepEqual(store.room.plans[TODAY], record, 'the plan record is untouched');
  assert.deepEqual(store.writes, [{ planId: TODAY, itemId: BD_ITEM, where: 'legacy-fence' }]);
  assert.equal(response.body.result.revision, await revisionOf(h, BD_ITEM));
});

test('never the wrong task: a stale revision, another item\'s revision, an absent or removed item are refused and nothing is written', async () => {
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products(), menu(), task('gone', 'Old', { deleted: true })]) }));
  const p1 = await revisionOf(h, 'p1');
  store.ownerLegacyRecord(TODAY, legacyRecord([products({ task: 'Post remaining products today', updatedAt: T0 + 1 }), menu(), task('gone', 'Old', { deleted: true })]));
  const stale = await h.handle(command('plan_set_completion', complete('p1'), { expectedRevision: p1 }));
  assert.equal(code(stale), 'STALE_REVISION');
  assert.equal(stale.body.error.details.currentRevision, await revisionOf(h, 'p1'));
  const crossed = await h.handle(command('plan_set_completion', complete('p2'), { expectedRevision: await revisionOf(h, 'p1') }));
  assert.equal(code(crossed), 'STALE_REVISION', 'one item\'s revision never authorizes another item');
  const absent = await h.handle(command('plan_set_completion', complete('nope'), { expectedRevision: p1 }));
  assert.equal(code(absent), 'NOT_FOUND');
  const gone = await h.handle(command('plan_set_completion', complete('gone'), { expectedRevision: `rev1:${'A'.repeat(43)}` }));
  assert.equal(code(gone), 'STALE_REVISION');
  assert.equal(store.writes.length, 0);
  assert.equal(stored(store, 'p1').done, false);
  assert.equal(stored(store, 'p2').done, false);
});

test('a calendar revision never completes a legacy item, nor a legacy revision a calendar item (the store is in the revision)', async () => {
  const seed = legacyAccount({ [TODAY]: legacyRecord([products()]) });
  const { store, h } = setup(seed);
  const legacyRev = await revisionOf(h, 'p1');
  const calendar = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: `cal1:${TODAY}` }, itemId: 'p1', completed: true },
    { expectedRevision: legacyRev }));
  assert.notEqual(calendar.status, 200, 'a never-activated account has no authoritative calendar plan');
  assert.equal(store.writes.length, 0);
});

test('an ended legacy day and a legacy day superseded by the cutover are history: PAST_TARGET_IMMUTABLE, nothing written', async () => {
  const ended = setup(legacyAccount({ [YESTERDAY]: { updatedAt: T0, updatedBy: 'phone', items: [products()] } }));
  const past = await ended.h.handle(command('plan_set_completion', complete('p1', true, YESTERDAY), { expectedRevision: await revisionOf(ended.h, 'p1', YESTERDAY) }));
  assert.equal(code(past), 'PAST_TARGET_IMMUTABLE');
  assert.equal(ended.store.writes.length, 0);
  // Activated today: today's legacy plan is read-only (its tasks move through the Unfinished flow), even before midnight.
  const cutover = setup({ calendarPlanAuthority: { [FACT.id]: { ...FACT, activatedAtMs: NOW_MS - 60_000, activationDate: TODAY } },
    plans: { [TODAY]: legacyRecord([products()]) } });
  const superseded = await cutover.h.handle(command('plan_set_completion', complete('p1'), { expectedRevision: await revisionOf(cutover.h, 'p1') }));
  assert.equal(code(superseded), 'PAST_TARGET_IMMUTABLE');
  assert.equal(cutover.store.writes.length, 0);
});

test('scope: edit/delete, a legacy -> calendar move (TASK-038 moves legacy -> legacy only) and every operational target stay DOMAIN_LIMIT; malformed ids are invalid', async () => {
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products()]) }));
  const rev = await revisionOf(h, 'p1');
  const refusals = [
    ['plan_edit', { target: target(), itemId: 'p1', title: 'x' }, 'DOMAIN_LIMIT'],
    ['plan_delete', { target: target(), itemId: 'p1' }, 'DOMAIN_LIMIT'],
    ['plan_move', { target: target(), itemId: 'p1', destination: { store: 'calendar', id: `cal1:${addCalendarDays(TODAY, 1)}` } }, 'DOMAIN_LIMIT'],
    ['plan_set_completion', { target: { store: 'operational', id: `odv1:rev:${ZONE}:${TODAY}` }, itemId: 'p1', completed: true }, 'DOMAIN_LIMIT'],
    ['plan_set_completion', { target: { store: 'legacy', id: `cal1:${TODAY}` }, itemId: 'p1', completed: true }, 'INVALID_INPUT'],
    ['plan_set_completion', { target: { store: 'legacy', id: '2026-02-30' }, itemId: 'p1', completed: true }, 'INVALID_INPUT'],
    ['plan_set_completion', { target: { store: 'legacy', id: `${TODAY}/../x` }, itemId: 'p1', completed: true }, 'INVALID_INPUT'],
    ['plan_set_completion', { target: { store: 'legacy', id: TODAY, roomId: 'uid_victim' }, itemId: 'p1', completed: true }, 'INVALID_INPUT'],
  ];
  for (const [kind, parameters, expected] of refusals) {
    const response = await h.handle(command(kind, parameters, { expectedRevision: rev }));
    assert.equal(code(response), expected, `${kind} ${JSON.stringify(parameters.target)}`);
  }
  assert.equal(store.writes.length, 0);
});

test('a concurrent app edit of ANOTHER item between read and write: the CAS retries, both changes survive', async () => {
  let raced = false;
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products(), menu()]) }), {
    async beforeLegacyRecordPut() {
      if (raced) return;
      raced = true;
      store.ownerLegacyRecord(TODAY, legacyRecord([products(), menu({ done: true, doneAt: T0 + 5, updatedAt: T0 + 5 })]));
    } });
  const response = await h.handle(command('plan_set_completion', complete('p1'), { expectedRevision: await revisionOf(h, 'p1') }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(stored(store, 'p1').done, true);
  assert.equal(stored(store, 'p2').done, true, 'the app\'s concurrent completion is kept');
  assert.equal(store.writes.length, 1);
});

test('a concurrent app edit of THE SAME item between read and write: STALE_REVISION, the app\'s edit stands', async () => {
  let raced = false;
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products()]) }), {
    async beforeLegacyRecordPut() {
      if (raced) return;
      raced = true;
      store.ownerLegacyRecord(TODAY, legacyRecord([products({ task: 'Renamed in the app', updatedAt: T0 + 5 })]));
    } });
  const response = await h.handle(command('plan_set_completion', complete('p1'), { expectedRevision: await revisionOf(h, 'p1') }));
  assert.equal(code(response), 'STALE_REVISION');
  assert.deepEqual(stored(store, 'p1'), products({ task: 'Renamed in the app', updatedAt: T0 + 5 }));
});

test('write landed but its response was lost, and a crash before the receipt: proven APPLIED, never applied twice', async () => {
  let lose = true;
  const lost = setup(legacyAccount({ [TODAY]: legacyRecord([products()]) }), { async afterLegacyRecordPut() { if (lose) { lose = false; throw new ApiError('RETRYABLE_TRANSPORT', 'lost'); } } });
  const response = await lost.h.handle(command('plan_set_completion', complete('p1'), { expectedRevision: await revisionOf(lost.h, 'p1') }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(lost.store.writes.length, 1);

  let crash = true;
  const crashed = setup(legacyAccount({ [TODAY]: legacyRecord([products()]) }), { async afterLegacyRecordPut() { if (crash) { crash = false; throw new Error('process died'); } } });
  const rev = await revisionOf(crashed.h, 'p1');
  const actionId = newAction();
  assert.equal((await crashed.h.handle(command('plan_set_completion', complete('p1'), { actionId, expectedRevision: rev }))).status, 500);
  const retry = await harnessWithInfra(crashed.store, crashed.h.infra, NOW_MS + 31_000)
    .handle(command('plan_set_completion', complete('p1'), { actionId, expectedRevision: rev }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(crashed.store.writes.length, 1, 'proven from the planned revision, not re-applied');
  assert.equal(crashed.h.infra.data.get(RECEIPT(actionId)).state, 'applied');
});

test('the app converges: its own legacy merge of a stale local copy with the written record keeps the completion', async () => {
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products(), menu(), kuryente()]) }));
  const local = structuredClone(store.room.plans[TODAY]);
  assert.equal((await h.handle(command('plan_set_completion', complete('p2'), { expectedRevision: await revisionOf(h, 'p2') }))).status, 200);
  for (const merged of [mergeDatePlans(local, store.room.plans[TODAY], TODAY), mergeDatePlans(store.room.plans[TODAY], local, TODAY)]) {
    assert.deepEqual(merged.items.map(item => [item.id, item.done === true]), [['p1', false], ['p2', true], ['p3', false]]);
  }
  const { plan } = await query(h, 'get_today', {});
  assert.deepEqual(plan.items.map(item => [item.itemId, item.done]), [['p1', false], ['p2', true], ['p3', false]], 'ChatGPT reads it back');
});

test('review M1: a date a Personal Day boundary now owns is not writable through its old legacy record (NOT_FOUND, nothing written)', async () => {
  // A 04:00 boundary since three days ago: today's plan is the operational day, and plans/<today> is a leftover.
  const history = proposeBoundaryRevision([legacyBoundaryRevision(ZONE)], { id: 'boundary-0400', boundaryTime: '04:00', timezone: ZONE }, NOW_MS - 3 * 86_400_000).revisions;
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products()]) },
    { dayBoundaryRevisions: Object.fromEntries(history.map(revision => [revision.id, revision])) }));
  assert.equal((await query(h, 'get_today', {})).plan.target.store, 'operational', 'get_today never names that legacy record');
  const response = await h.handle(command('plan_set_completion', complete('p1'), { expectedRevision: await revisionOf(h, 'p1') }));
  assert.equal(code(response), 'NOT_FOUND');
  assert.equal(store.writes.length, 0);
  assert.equal(stored(store, 'p1').done, false);
  // A legacy day from BEFORE the boundary began is still its own legacy plan: ended, so history, not "not found".
  const before = localPlanDate(NOW_MS - 5 * 86_400_000, ZONE);
  const old = setup(legacyAccount({ [before]: { updatedAt: T0, updatedBy: 'phone', items: [products()] } },
    { dayBoundaryRevisions: Object.fromEntries(history.map(revision => [revision.id, revision])) }));
  const past = await old.h.handle(command('plan_set_completion', complete('p1', true, before), { expectedRevision: await revisionOf(old.h, 'p1', before) }));
  assert.equal(code(past), 'PAST_TARGET_IMMUTABLE');
  assert.equal(old.store.writes.length, 0);
});

test('review S2/N-a: a legacy day ends where Plan Authority ends it (the stored day-start zone), not in the settings zone', async () => {
  // Settings say Manila, but the account's 00:00 day-start setting was stored in Kiritimati (UTC+14), which has
  // already passed midnight: Plan Authority has ended that legacy day although Manila has not. Writes follow it.
  const anchor = legacyBoundaryRevision('Pacific/Kiritimati');
  assert.notEqual(localPlanDate(NOW_MS, 'Pacific/Kiritimati'), TODAY, 'fixture: the two zones disagree on today');
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products()]) }, { dayBoundaryRevisions: { [anchor.id]: anchor } }));
  const response = await h.handle(command('plan_set_completion', complete('p1'), { expectedRevision: await revisionOf(h, 'p1') }));
  assert.equal(code(response), 'PAST_TARGET_IMMUTABLE');
  assert.equal(store.writes.length, 0);
});
