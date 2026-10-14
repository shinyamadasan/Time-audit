// TASK-012 conversational plan mutations: plan_set_completion, plan_edit, plan_move, plan_delete. Adversarial:
// identity, stale revisions, every item location (array / api1_ fence / bdp1| fence), carryover, time, receipts,
// crash/takeover/late-writer recovery and scope. The domain double is an RTDB-shaped store: ETags change on every
// write, null values are pruned exactly as Realtime Database prunes them, and fence children obey the fence rules
// (marker pinned, tombstone monotonic, no relocation, never created or removed by an update).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { COMMAND_PATH } from '../src/action-api.js';
import { actionActorRef } from '../src/envelope.js';
import { ApiError } from '../src/errors.js';
import { addCalendarDays, localPlanDate } from '../shared/plan-tomorrow-model.js';
import { NOW_MS, OWNER, harness, signedRequest } from './support.js';
import { ZONE, planDomain } from './plan-domain-support.js';

const TODAY = localPlanDate(NOW_MS, ZONE);
const TOMORROW = addCalendarDays(TODAY, 1);
const DAY_AFTER = addCalendarDays(TODAY, 2);
const YESTERDAY = addCalendarDays(TODAY, -1);
const planIdOf = date => `cal1:${date}`;
const P = { today: planIdOf(TODAY), tomorrow: planIdOf(TOMORROW), dayAfter: planIdOf(DAY_AFTER), yesterday: planIdOf(YESTERDAY) };
const uuid = () => randomUUID();
const newAction = () => `act1_${uuid()}`;
const ACTOR = actionActorRef(OWNER.ownerSubject);
import { ACTIVATED_AT } from './plan-domain-support.js';
const RECEIPT = actionId => `serverActionReceipts/${OWNER.ownerFirebaseUid}/${actionId}`;
const T0 = NOW_MS - 3_600_000;
const API_ACTION = 'act1_550e8400-e29b-41d4-a716-446655440000';
const API_ITEM = 'api1_550e8400-e29b-41d4-a716-446655440000';
const BD_ITEM = 'bdp1|cap_gym01';

const gym = (overrides = {}) => ({ id: 'pgym1', task: 'Gym', when: '18:00', whenTz: ZONE, durationMinutes: 60, done: false, updatedAt: T0, updatedBy: 'phone', ...overrides });
const other = (overrides = {}) => ({ id: 'pother', task: 'Groceries', when: '', done: false, kind: 'task', updatedAt: T0, updatedBy: 'laptop', ...overrides });
const planRecord = (items, extra = {}) => ({ createdAt: T0 - 1000, timezone: ZONE, updatedAt: T0, updatedBy: 'phone', items, ...extra });
const apiItem = (overrides = {}) => ({ id: API_ITEM, task: 'Gym', when: '18:00', whenTz: ZONE, durationMinutes: 60, done: false,
  updatedAt: T0, updatedBy: ACTOR, kind: 'task', creationActionId: API_ACTION, ...overrides });
const bdItem = (overrides = {}) => ({ id: BD_ITEM, task: 'Gym', when: '', done: false, updatedAt: T0, updatedBy: 'phone', kind: 'task',
  brainDumpOrigin: { v: 2, claimEpoch: 0, type: 'schedule', store: 'calendar', targetKey: P.tomorrow }, ...overrides });

const provenanceFor = actionId => ({ version: 1, sourceKind: 'chatgpt_plugin', actionId, actorRef: ACTOR, capturedAt: new Date(NOW_MS).toISOString() });
function command(kind, parameters, { actionId = API_ACTION.replace('550e8400', 'aaaa0000'), expectedRevision, scopes = ['chronasense:plan.write'], requestId = uuid() } = {}) {
  return signedRequest({ path: COMMAND_PATH, requestId, signed: { path: COMMAND_PATH, scopes },
    envelope: { contractVersion: 1, requestId, actionId, kind, parameters, expectedRevision, actionProvenance: provenanceFor(actionId) } });
}
async function getItem(h, planId, itemId) {
  const requestId = uuid();
  const response = await h.handle(signedRequest({ requestId, envelope: { contractVersion: 1, requestId, kind: 'get_item',
    parameters: { source: 'plan', id: itemId, target: { store: 'calendar', id: planId } } } }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.result;
}
async function getPlan(h, planId) {
  const requestId = uuid();
  const response = await h.handle(signedRequest({ requestId, envelope: { contractVersion: 1, requestId, kind: 'get_plan', parameters: { target: { store: 'calendar', id: planId } } } }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.result.plan;
}
const revisionOf = async (h, planId, itemId) => (await getItem(h, planId, itemId)).item.revision;
const code = response => response.body.error?.code;
const recordItem = (store, planId, itemId) => (store.room.calendarPlans[planId]?.items || []).find(item => item.id === itemId);
/** Runs one mutation against a fresh harness after reading the item's revision through get_item. */
async function setup(seed, hooks) {
  const store = planDomain(seed, hooks);
  const h = harness({ domain: store });
  return { store, h };
}
const tomorrowWith = (...items) => ({ calendarPlans: { [P.tomorrow]: planRecord(items) } });

// ── COMPLETE / UNCOMPLETE ───────────────────────────────────────────────────

test('"Mark gym done": the array item completes in place, same id, other items untouched, exact receipt, exact replay', async () => {
  const { store, h } = await setup(tomorrowWith(gym(), other()));
  const before = await revisionOf(h, P.tomorrow, 'pgym1');
  const actionId = newAction();
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true };
  const first = await h.handle(command('plan_set_completion', parameters, { actionId, expectedRevision: before }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const stamp = NOW_MS; // receipt createdAt > the item's own updatedAt
  assert.deepEqual(recordItem(store, P.tomorrow, 'pgym1'), gym({ done: true, doneAt: stamp, updatedAt: stamp, updatedBy: actionId }), 'the writer is this action: a per-action proof');
  assert.deepEqual(recordItem(store, P.tomorrow, 'pother'), other(), 'an unrelated item is byte-identical');
  assert.equal(store.room.calendarPlans[P.tomorrow].createdAt, T0 - 1000, 'origin kept');
  const { result } = first.body;
  assert.equal(result.itemId, 'pgym1');
  assert.equal(result.operation, 'plan_set_completion');
  assert.deepEqual(result.item.completed, true);
  assert.equal(result.previousRevision, before);
  assert.equal(result.revision, await revisionOf(h, P.tomorrow, 'pgym1'), 'the result revision is the readable one');
  assert.equal(result.changed, true);
  assert.equal(result.idempotentReplay, false);
  const receipt = h.infra.data.get(RECEIPT(actionId));
  assert.equal(receipt.state, 'applied');
  assert.equal(receipt.kind, 'plan_set_completion');
  assert.equal(receipt.intent.sourceRevision, result.revision, 'the intent named the exact resulting revision before writing');
  assert.ok(!JSON.stringify(receipt).includes('Gym'), 'the receipt never copies the task text');
  const replay = await h.handle(command('plan_set_completion', parameters, { actionId, expectedRevision: before }));
  assert.equal(replay.body.result.idempotentReplay, true);
  assert.equal(store.writes.length, 1, 'no second write');
});

test('"Actually, mark that incomplete again": done -> not done, doneAt removed (not null), already-in-state is a no-op success', async () => {
  const { store, h } = await setup(tomorrowWith(gym({ done: true, doneAt: T0 })));
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: false };
  const done = await h.handle(command('plan_set_completion', parameters, { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, 'pgym1') }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const item = recordItem(store, P.tomorrow, 'pgym1');
  assert.equal(item.done, false);
  assert.ok(!Object.hasOwn(item, 'doneAt'), 'cleared exactly as RTDB stores a null');
  assert.equal(done.body.result.revision, await revisionOf(h, P.tomorrow, 'pgym1'));
  const again = await h.handle(command('plan_set_completion', parameters, { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, 'pgym1') }));
  assert.equal(again.status, 200);
  assert.equal(again.body.result.changed, false, 'already incomplete: success, nothing written');
  assert.equal(store.writes.length, 1);
});

test('complete works on every location: api1_ and bdp1| fence children are updated in place, marker/origin pinned, array untouched', async () => {
  const seed = { calendarPlans: { [P.tomorrow]: planRecord([other()]) },
    calendarPlanFences: { [P.tomorrow]: { [API_ITEM]: apiItem(), [BD_ITEM]: bdItem() } } };
  const { store, h } = await setup(seed);
  for (const itemId of [API_ITEM, BD_ITEM]) {
    const response = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.tomorrow }, itemId, completed: true },
      { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, itemId) }));
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  assert.equal(store.room.calendarPlanFences[P.tomorrow][API_ITEM].creationActionId, API_ACTION, 'creation provenance never changes');
  assert.deepEqual(store.room.calendarPlanFences[P.tomorrow][BD_ITEM].brainDumpOrigin, bdItem().brainDumpOrigin);
  assert.equal(store.room.calendarPlanFences[P.tomorrow][API_ITEM].done, true);
  assert.equal(store.room.calendarPlanFences[P.tomorrow][BD_ITEM].done, true);
  assert.deepEqual(store.room.calendarPlans[P.tomorrow].items, [other()], 'no fenced item ever enters the array');
  assert.ok(store.writes.every(write => write.where === 'fence'));
});

test('a plan that holds only a keyed item and no origin gets its origin frozen before the item is mutated', async () => {
  const { store, h } = await setup({ calendarPlanFences: { [P.tomorrow]: { [API_ITEM]: apiItem() } } });
  const response = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.tomorrow }, itemId: API_ITEM, completed: true },
    { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, API_ITEM) }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(store.room.calendarPlans[P.tomorrow].timezone, ZONE);
  assert.equal(store.room.calendarPlanFences[P.tomorrow][API_ITEM].done, true);
});

// ── REVISION / STALE WRITES ─────────────────────────────────────────────────

test('stale conversational write: the owner edits after ChatGPT read -> STALE_REVISION, owner edit survives, receipt rejected and replayed', async () => {
  const { store, h } = await setup(tomorrowWith(gym(), other()));
  const stale = await revisionOf(h, P.tomorrow, 'pgym1');
  store.ownerRecord(P.tomorrow, planRecord([gym({ task: 'Gym (legs)', updatedAt: T0 + 5 }), other()]));
  const current = await revisionOf(h, P.tomorrow, 'pgym1');
  const actionId = newAction();
  for (const [kind, extra] of [['plan_set_completion', { completed: true }], ['plan_edit', { title: 'Strength' }],
    ['plan_move', { destination: { store: 'calendar', id: P.dayAfter } }], ['plan_delete', {}]]) {
    const id = kind === 'plan_set_completion' ? actionId : newAction();
    const response = await h.handle(command(kind, { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', ...extra }, { actionId: id, expectedRevision: stale }));
    assert.equal(code(response), 'STALE_REVISION', `${kind}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.details.currentRevision, current, 'the caller learns it must read again');
  }
  assert.deepEqual(recordItem(store, P.tomorrow, 'pgym1'), gym({ task: 'Gym (legs)', updatedAt: T0 + 5 }), 'the newer owner edit is never overwritten');
  assert.equal(store.writes.length, 0);
  assert.equal(h.infra.data.get(RECEIPT(actionId)).state, 'rejected');
  const replay = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true }, { actionId, expectedRevision: stale }));
  assert.equal(code(replay), 'STALE_REVISION', 'the same definite answer');
  const fresh = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true }, { actionId: newAction(), expectedRevision: current }));
  assert.equal(fresh.status, 200, 'a NEW action from a fresh read applies');
});

test('identity is the stable id: array reorder, duplicate titles and unrelated edits never change which item a revision names', async () => {
  const twin = gym({ id: 'pgym2' }); // same title and time, different identity
  const { store, h } = await setup(tomorrowWith(gym(), twin, other()));
  const rev = await revisionOf(h, P.tomorrow, 'pgym2');
  // Another device reorders the array and edits an unrelated item.
  store.ownerRecord(P.tomorrow, planRecord([other({ task: 'Groceries + milk', updatedAt: T0 + 9 }), twin, gym()]));
  const response = await h.handle(command('plan_delete', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym2' }, { actionId: newAction(), expectedRevision: rev }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(recordItem(store, P.tomorrow, 'pgym2').deleted, true);
  assert.equal(recordItem(store, P.tomorrow, 'pgym1').deleted, undefined, 'the same-titled twin is untouched');
  assert.equal(recordItem(store, P.tomorrow, 'pother').task, 'Groceries + milk', 'the concurrent unrelated edit survives');
});

test('caller cannot smuggle identity or immutable fields: index/title targeting, paths, markers and unknown fields are refused before a receipt', async () => {
  const { store, h } = await setup(tomorrowWith(gym()));
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const base = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1' };
  const cases = [
    ['plan_edit', { ...base, title: 'x', creationActionId: API_ACTION }],
    ['plan_edit', { ...base, title: 'x', id: 'pother' }],
    ['plan_edit', { ...base, title: 'x', updatedAt: 1 }],
    ['plan_edit', { ...base, title: 'x', relocationRevision: {} }],
    ['plan_edit', { ...base, title: 'x', deleted: false }],
    ['plan_edit', { target: base.target, index: 0, title: 'x' }],
    ['plan_edit', { target: base.target, itemId: '../calendarPlans/x', title: 'x' }],
    ['plan_edit', { target: base.target, itemId: 'a/b', title: 'x' }],
    ['plan_edit', { target: { ...base.target, uid: 'someoneElse' }, itemId: 'pgym1', title: 'x' }],
    ['plan_delete', { ...base, roomId: 'uid_other' }],
    ['plan_set_completion', { ...base, completed: 'yes' }],
    ['plan_edit', base],
    ['plan_edit', { ...base, clearSchedule: false }],
    ['plan_edit', { ...base, clearSchedule: true, durationMinutes: 30 }],
    ['plan_edit', { ...base, title: '   ' }],
    ['plan_edit', { ...base, time: { when: '7pm', whenTz: ZONE } }],
    ['plan_edit', { ...base, time: { when: '19:00', whenTz: 'asia/manila' } }],
    ['plan_edit', { ...base, time: { when: '19:00' } }],
    ['plan_edit', { ...base, time: { when: '19:00', whenTz: ZONE, whenDayOffset: 2 } }],
    ['plan_move', { ...base, destination: base.target }],
    ['plan_move', { ...base }],
  ];
  for (const [kind, parameters] of cases) {
    const actionId = newAction();
    const response = await h.handle(command(kind, parameters, { actionId, expectedRevision: rev }));
    assert.equal(code(response), 'INVALID_INPUT', `${kind} ${JSON.stringify(parameters)} -> ${JSON.stringify(response.body)}`);
    assert.equal(h.infra.data.get(RECEIPT(actionId)), undefined, 'refused before any receipt');
  }
  for (const expectedRevision of [null, undefined, 'rev1:short', 'etag:abc', 42]) {
    const response = await h.handle(command('plan_delete', base, { actionId: newAction(), expectedRevision }));
    assert.equal(code(response), 'INVALID_INPUT', `expectedRevision ${expectedRevision}`);
  }
  const legacy = await h.handle(command('plan_delete', { ...base, target: { store: 'legacy', id: TOMORROW } }, { actionId: newAction(), expectedRevision: rev }));
  assert.equal(code(legacy), 'DOMAIN_LIMIT', 'calendar store only');
  const long = await h.handle(command('plan_edit', { ...base, title: 'x'.repeat(201) }, { actionId: newAction(), expectedRevision: rev }));
  assert.equal(code(long), 'DOMAIN_LIMIT');
  assert.equal(store.writes.length, 0);
});

test('same action ID with a different payload is IDEMPOTENCY_CONFLICT and never executes', async () => {
  const { store, h } = await setup(tomorrowWith(gym()));
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const actionId = newAction();
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true };
  assert.equal((await h.handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }))).status, 200);
  const changed = [
    command('plan_set_completion', { ...parameters, completed: false }, { actionId, expectedRevision: rev }),
    command('plan_delete', { target: parameters.target, itemId: 'pgym1' }, { actionId, expectedRevision: rev }),
    command('plan_set_completion', parameters, { actionId, expectedRevision: `rev1:${'A'.repeat(43)}` }),
  ];
  for (const request of changed) assert.equal(code(await h.handle(request)), 'IDEMPOTENCY_CONFLICT');
  assert.equal(store.writes.length, 1);
});

test('missing / tombstoned / relocated items: typed refusals, nothing written, nothing resurrected', async () => {
  const { store, h } = await setup(tomorrowWith(gym(), other()));
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const absent = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pnope', completed: true }, { actionId: newAction(), expectedRevision: rev }));
  assert.equal(code(absent), 'NOT_FOUND');
  const deleted = await h.handle(command('plan_delete', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1' }, { actionId: newAction(), expectedRevision: rev }));
  assert.equal(deleted.status, 200);
  // A stale client replays its old live view: a fresh action with the pre-delete revision cannot resurrect it.
  for (const [kind, extra] of [['plan_set_completion', { completed: true }], ['plan_edit', { title: 'back' }], ['plan_delete', {}]]) {
    const response = await h.handle(command(kind, { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', ...extra }, { actionId: newAction(), expectedRevision: rev }));
    assert.equal(code(response), 'STALE_REVISION', kind);
    assert.deepEqual(response.body.error.details, { state: 'tombstoned' });
  }
  // Even a caller holding the tombstone's own revision cannot act on it.
  const tombstone = recordItem(store, P.tomorrow, 'pgym1');
  const { revision } = await import('../src/plan-read.js');
  const tombRev = revision({ v: 1, store: 'calendar', targetKey: P.tomorrow, item: tombstone });
  const onTomb = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true }, { actionId: newAction(), expectedRevision: tombRev }));
  assert.equal(code(onTomb), 'CONFLICT');
  assert.equal(recordItem(store, P.tomorrow, 'pgym1').deleted, true, 'still deleted');
  assert.equal(store.writes.length, 1);
});

// ── PAST PLANS / CARRYOVER ──────────────────────────────────────────────────

test('an ended plan is history: edit, move, delete and completion are refused; nothing is written', async () => {
  const seed = { calendarPlans: { [P.yesterday]: planRecord([gym({ when: '09:00' })]) } };
  const { store, h } = await setup(seed);
  const rev = await revisionOf(h, P.yesterday, 'pgym1');
  for (const [kind, extra] of [['plan_set_completion', { completed: true }], ['plan_edit', { title: 'x' }],
    ['plan_move', { destination: { store: 'calendar', id: P.tomorrow } }], ['plan_delete', {}]]) {
    const response = await h.handle(command(kind, { target: { store: 'calendar', id: P.yesterday }, itemId: 'pgym1', ...extra }, { actionId: newAction(), expectedRevision: rev }));
    assert.equal(code(response), 'PAST_TARGET_IMMUTABLE', kind);
  }
  const intoPast = await h.handle(command('plan_move', { target: { store: 'calendar', id: P.yesterday }, itemId: 'pgym1',
    destination: { store: 'calendar', id: addCalendarDays(YESTERDAY, -1).replace(/^/, 'cal1:') } }, { actionId: newAction(), expectedRevision: rev }));
  assert.equal(code(intoPast), 'PAST_TARGET_IMMUTABLE');
  assert.equal(store.writes.length, 0);
});

test('carryover completion exception: an ended plan\'s item whose own start lands TODAY can be completed and uncompleted, nothing else', async () => {
  const nowHour = new Date(NOW_MS + 8 * 3_600_000).getUTCHours();
  assert.ok(nowHour >= 1, 'fixture: today has started past 00:30 local');
  const seed = { calendarPlans: { [P.yesterday]: planRecord([gym({ id: 'plate', when: '00:30', whenDayOffset: 1, durationMinutes: 30 }), gym({ when: '09:00' })]) } };
  const { store, h } = await setup(seed);
  const done = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.yesterday }, itemId: 'plate', completed: true },
    { actionId: newAction(), expectedRevision: await revisionOf(h, P.yesterday, 'plate') }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(recordItem(store, P.yesterday, 'plate').done, true, 'written to the SAME source plan and item');
  const undone = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.yesterday }, itemId: 'plate', completed: false },
    { actionId: newAction(), expectedRevision: await revisionOf(h, P.yesterday, 'plate') }));
  assert.equal(undone.status, 200);
  const notToday = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.yesterday }, itemId: 'pgym1', completed: true },
    { actionId: newAction(), expectedRevision: await revisionOf(h, P.yesterday, 'pgym1') }));
  assert.equal(code(notToday), 'PAST_TARGET_IMMUTABLE', 'an item that does not land today stays history');
  const rename = await h.handle(command('plan_edit', { target: { store: 'calendar', id: P.yesterday }, itemId: 'plate', title: 'x' },
    { actionId: newAction(), expectedRevision: await revisionOf(h, P.yesterday, 'plate') }));
  assert.equal(code(rename), 'PAST_TARGET_IMMUTABLE', 'the exception is completion only');
});

// ── EDIT ────────────────────────────────────────────────────────────────────

test('"Change gym to 7 PM" / "Make it 90 minutes" / "Rename it": each changes only what it names; absence never clears', async () => {
  const { store, h } = await setup(tomorrowWith(gym({ kind: 'task' })));
  const target = { store: 'calendar', id: P.tomorrow };
  const edit = async extra => h.handle(command('plan_edit', { target, itemId: 'pgym1', ...extra }, { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, 'pgym1') }));
  assert.equal((await edit({ time: { when: '19:00', whenTz: ZONE } })).status, 200);
  assert.deepEqual([recordItem(store, P.tomorrow, 'pgym1').when, recordItem(store, P.tomorrow, 'pgym1').durationMinutes], ['19:00', 60], 'duration kept');
  const longer = await edit({ durationMinutes: 90 });
  assert.equal(longer.status, 200);
  assert.equal(longer.body.result.item.schedule.endAt, new Date(Date.parse(`${TOMORROW}T19:00:00+08:00`) + 90 * 60_000).toISOString());
  assert.equal((await edit({ title: 'Strength training' })).status, 200);
  const item = recordItem(store, P.tomorrow, 'pgym1');
  assert.deepEqual([item.task, item.when, item.whenTz, item.durationMinutes, item.kind, item.done], ['Strength training', '19:00', ZONE, 90, 'task', false]);
  assert.equal((await edit({ title: 'Strength training' })).body.result.changed, false, 'an unchanged edit is a no-op success');
  assert.equal(store.writes.length, 3);
});

test('date-only stays date-only unless scheduled explicitly; a duration needs a time; clearSchedule is the only way back', async () => {
  const { store, h } = await setup(tomorrowWith(other()));
  const target = { store: 'calendar', id: P.tomorrow };
  const edit = async extra => h.handle(command('plan_edit', { target, itemId: 'pother', ...extra }, { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, 'pother') }));
  assert.equal((await edit({ title: 'Groceries!' })).status, 200);
  assert.equal(recordItem(store, P.tomorrow, 'pother').when, '', 'a rename never invents a time (no midnight)');
  assert.ok(!Object.hasOwn(recordItem(store, P.tomorrow, 'pother'), 'whenTz'));
  assert.equal(code(await edit({ durationMinutes: 30 })), 'DOMAIN_LIMIT', 'a length without a start is refused');
  assert.equal((await edit({ time: { when: '10:00', whenTz: ZONE }, durationMinutes: 45 })).status, 200);
  assert.deepEqual([recordItem(store, P.tomorrow, 'pother').when, recordItem(store, P.tomorrow, 'pother').durationMinutes], ['10:00', 45]);
  assert.equal((await edit({ clearSchedule: true })).status, 200);
  const cleared = recordItem(store, P.tomorrow, 'pother');
  assert.equal(cleared.when, '');
  for (const key of ['whenTz', 'whenDayOffset', 'durationMinutes']) assert.ok(!Object.hasOwn(cleared, key), key);
});

test('time semantics: DST gap refused before a receipt, repeated hour resolves to the EARLIER instant, cross-midnight, extent', async () => {
  const gapDay = '2027-03-14'; // America/New_York springs forward at 02:00
  const fallDay = '2027-11-07'; // America/New_York repeats 01:00-02:00
  const seed = { calendarPlans: { [planIdOf(gapDay)]: planRecord([gym()]), [planIdOf(fallDay)]: planRecord([gym()]), [P.tomorrow]: planRecord([gym()]) } };
  const { h } = await setup(seed);
  const edit = async (planId, extra, actionId = newAction()) => h.handle(command('plan_edit', { target: { store: 'calendar', id: planId }, itemId: 'pgym1', ...extra },
    { actionId, expectedRevision: await revisionOf(h, planId, 'pgym1') }));
  const gapAction = newAction();
  const gap = await edit(planIdOf(gapDay), { time: { when: '02:30', whenTz: 'America/New_York' } }, gapAction);
  assert.equal(code(gap), 'NONEXISTENT_TIME');
  assert.equal(h.infra.data.get(RECEIPT(gapAction)), undefined, 'no receipt for a payload-decidable refusal');
  const fall = await edit(planIdOf(fallDay), { time: { when: '01:30', whenTz: 'America/New_York' }, durationMinutes: 30 });
  assert.equal(fall.status, 200, JSON.stringify(fall.body));
  assert.equal(fall.body.result.item.schedule.startAt, '2027-11-07T05:30:00.000Z', 'EDT (earlier) occurrence');
  const late = await edit(P.tomorrow, { time: { when: '23:30', whenTz: ZONE }, durationMinutes: 90 });
  assert.equal(late.status, 200, 'crossing midnight with an explicit duration stays in its own plan');
  const nextDay = await edit(P.tomorrow, { time: { when: '01:00', whenTz: ZONE, whenDayOffset: 1 } });
  assert.equal(nextDay.status, 200);
  assert.equal(nextDay.body.result.item.schedule.whenDayOffset, 1);
  const tooFar = await edit(P.tomorrow, { time: { when: '23:00', whenTz: ZONE, whenDayOffset: 1 }, durationMinutes: 120 });
  assert.equal(code(tooFar), 'DOMAIN_LIMIT', 'never past the plan extent');
});

// ── MOVE ────────────────────────────────────────────────────────────────────

test('"Move that to Friday": same id live at the destination (relocation seq 1), source tombstone, origin frozen, reads agree, replay idempotent', async () => {
  const { store, h } = await setup(tomorrowWith(gym(), other()));
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const actionId = newAction();
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', destination: { store: 'calendar', id: P.dayAfter } };
  const moved = await h.handle(command('plan_move', parameters, { actionId, expectedRevision: rev }));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const relocation = { schemaVersion: 1, sequence: 1, fromDayId: P.tomorrow, toDayId: P.dayAfter, updatedBy: actionId, updatedAt: NOW_MS };
  assert.deepEqual(recordItem(store, P.dayAfter, 'pgym1'), gym({ relocationRevision: relocation, updatedAt: NOW_MS, updatedBy: actionId }), 'the SAME identity, live at its destination');
  assert.deepEqual(recordItem(store, P.tomorrow, 'pgym1'), gym({ deleted: true, movedToDayId: P.dayAfter, relocationRevision: relocation, updatedAt: NOW_MS, updatedBy: actionId }));
  assert.deepEqual(recordItem(store, P.tomorrow, 'pother'), other());
  assert.deepEqual([store.room.calendarPlans[P.dayAfter].createdAt, store.room.calendarPlans[P.dayAfter].timezone], [NOW_MS, ZONE], 'destination origin frozen in the same write');
  assert.deepEqual((await getPlan(h, P.tomorrow)).items.map(item => item.itemId), ['pother'], 'never two current copies');
  assert.deepEqual((await getPlan(h, P.dayAfter)).items.map(item => item.itemId), ['pgym1']);
  assert.deepEqual(await getItem(h, P.tomorrow, 'pgym1'), { source: 'plan', target: (await getItem(h, P.tomorrow, 'pgym1')).target,
    state: 'tombstoned', itemId: 'pgym1' }, 'the unchanged read model reports the moved-away source copy as its tombstone');
  assert.equal(moved.body.result.revision, await revisionOf(h, P.dayAfter, 'pgym1'));
  assert.deepEqual(moved.body.result.destination, { store: 'calendar', id: P.dayAfter, date: DAY_AFTER });
  assert.equal((await h.handle(command('plan_move', parameters, { actionId, expectedRevision: rev }))).body.result.idempotentReplay, true);
  assert.deepEqual(store.writes, [{ planIds: [P.tomorrow, P.dayAfter].sort(), where: 'collection' }], 'source and destination in ONE atomic write');
  // Moving it again continues the same identity's relocation chain.
  const back = await h.handle(command('plan_move', { ...parameters, target: { store: 'calendar', id: P.dayAfter }, destination: { store: 'calendar', id: P.tomorrow } },
    { actionId: newAction(), expectedRevision: await revisionOf(h, P.dayAfter, 'pgym1') }));
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(recordItem(store, P.tomorrow, 'pgym1').relocationRevision.sequence, 2);
  assert.notEqual(recordItem(store, P.tomorrow, 'pgym1').deleted, true, 'the old tombstone is out-ranked by the newer relocation');
  assert.deepEqual((await getPlan(h, P.tomorrow)).items.map(item => item.itemId).sort(), ['pgym1', 'pother']);
  assert.deepEqual((await getPlan(h, P.dayAfter)).items, []);
});

test('move with an explicit new time judges the time on the destination date; an existing destination keeps its items and origin', async () => {
  const seed = { calendarPlans: { [P.tomorrow]: planRecord([gym()]), [P.dayAfter]: planRecord([other({ id: 'pthere' })], { createdAt: T0 - 5, timezone: 'Asia/Tokyo' }) } };
  const { store, h } = await setup(seed);
  const response = await h.handle(command('plan_move', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1',
    destination: { store: 'calendar', id: P.dayAfter }, time: { when: '07:00', whenTz: ZONE } }, { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, 'pgym1') }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.result.item.schedule.startAt, new Date(Date.parse(`${DAY_AFTER}T07:00:00+08:00`)).toISOString());
  const destination = store.room.calendarPlans[P.dayAfter];
  assert.deepEqual([destination.createdAt, destination.timezone], [T0 - 5, 'Asia/Tokyo'], 'an existing origin is never rewritten');
  assert.deepEqual(destination.items.map(item => item.id), ['pgym1', 'pthere']);
});

test('move refusals: bdp1| (bound by its capture), recovered carry copies, priority cap, unauthoritative destination', async () => {
  const fullTop3 = ['pa', 'pb', 'pc'].map(id => ({ id, task: `Priority ${id}`, when: '', done: false, updatedAt: T0, updatedBy: 'phone' }));
  const seed = { calendarPlans: { [P.tomorrow]: planRecord([gym(), gym({ id: 'pcarry', carriedFromId: 'porig', carriedFromDayId: P.yesterday,
    relocationRevision: { schemaVersion: 1, sequence: 1, fromDayId: P.yesterday, toDayId: P.tomorrow, updatedBy: 'phone' } })]),
  [P.dayAfter]: planRecord(fullTop3), [P.yesterday]: planRecord([gym({ id: 'porig' })]) },
  calendarPlanFences: { [P.tomorrow]: { [API_ITEM]: apiItem(), [BD_ITEM]: bdItem() } } };
  const { store, h } = await setup(seed);
  const move = async (itemId, destination = P.dayAfter) => h.handle(command('plan_move', { target: { store: 'calendar', id: P.tomorrow }, itemId,
    destination: { store: 'calendar', id: destination } }, { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, itemId) }));
  const bd = await move(BD_ITEM);
  assert.equal(code(bd), 'DOMAIN_LIMIT');
  assert.match(bd.body.error.message, /Brain Dump tasks can't be moved/);
  assert.equal(code(await move('pcarry')), 'DOMAIN_LIMIT');
  assert.equal(code(await move('pgym1')), 'DOMAIN_LIMIT', 'a priority never overflows the destination Top 3');
  const before = activationLimitDate();
  assert.equal(code(await move('pgym1', planIdOf(before))), 'NOT_FOUND', 'a pre-activation date is not calendar-authoritative');
  assert.equal(store.writes.length, 0);
});
const activationLimitDate = () => addCalendarDays(localPlanDate(ACTIVATED_AT, ZONE), -1);

test('destination prepared concurrently: the destination CAS fails, is re-merged, and the other writer\'s item survives', async () => {
  let once = true;
  const store = planDomain(tomorrowWith(gym()), {
    async beforePlansPut() {
      if (once) { once = false; store.ownerRecord(P.dayAfter, planRecord([other({ id: 'pphone' })], { createdAt: T0 - 7, timezone: ZONE })); }
    },
  });
  const h = harness({ domain: store });
  const response = await h.handle(command('plan_move', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', destination: { store: 'calendar', id: P.dayAfter } },
    { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, 'pgym1') }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(store.room.calendarPlans[P.dayAfter].items.map(item => item.id), ['pgym1', 'pphone']);
  assert.equal(store.room.calendarPlans[P.dayAfter].createdAt, T0 - 7, 'the concurrent writer\'s origin (earliest) wins');
});

test('move crash after its atomic write, before the receipt: the takeover proves it from the source tombstone; one effect', async () => {
  let crash = true;
  const store = planDomain(tomorrowWith(gym()), { async afterPlansPut() { if (crash) { crash = false; throw new Error('process died'); } } });
  const h = harness({ domain: store });
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const actionId = newAction();
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', destination: { store: 'calendar', id: P.dayAfter } };
  assert.equal((await h.handle(command('plan_move', parameters, { actionId, expectedRevision: rev }))).status, 500, 'the attempt died');
  const retry = await harnessWithInfra(store, h.infra, NOW_MS + 31_000).handle(command('plan_move', parameters, { actionId, expectedRevision: rev }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.result.revision, await revisionOf(h, P.dayAfter, 'pgym1'));
  assert.equal(store.writes.length, 1, 'proven, not re-applied');
});

test('a move never undoes a concurrent source edit: the source changes between read and write -> the atomic CAS fails -> STALE', async () => {
  let once = true;
  const store = planDomain(tomorrowWith(gym()), {
    async beforePlansPut() { if (once) { once = false; store.ownerRecord(P.tomorrow, planRecord([gym({ deleted: true, updatedAt: T0 + 2 })])); } },
  });
  const h = harness({ domain: store });
  const response = await h.handle(command('plan_move', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', destination: { store: 'calendar', id: P.dayAfter } },
    { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, 'pgym1') }));
  assert.equal(code(response), 'STALE_REVISION', JSON.stringify(response.body));
  assert.equal(store.room.calendarPlans[P.dayAfter], undefined, 'no destination copy ever landed');
  assert.equal(recordItem(store, P.tomorrow, 'pgym1').deleted, true, 'the owner delete stands');
});

// ── DELETE ──────────────────────────────────────────────────────────────────

test('"Delete that test task": an in-place stamped tombstone (never a physical delete), replay keeps one tombstone, fence tombstone is monotonic', async () => {
  const seed = { calendarPlans: { [P.tomorrow]: planRecord([gym(), other()]) }, calendarPlanFences: { [P.tomorrow]: { [API_ITEM]: apiItem() } } };
  const { store, h } = await setup(seed);
  const actionId = newAction();
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: API_ITEM };
  const rev = await revisionOf(h, P.tomorrow, API_ITEM);
  const deleted = await h.handle(command('plan_delete', parameters, { actionId, expectedRevision: rev }));
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(store.room.calendarPlanFences[P.tomorrow][API_ITEM], apiItem({ deleted: true, updatedAt: NOW_MS, updatedBy: actionId }), 'tombstone keeps creation provenance');
  assert.equal(deleted.body.result.item.deleted, true);
  assert.equal((await h.handle(command('plan_delete', parameters, { actionId, expectedRevision: rev }))).body.result.idempotentReplay, true);
  assert.equal(store.writes.length, 1, 'one tombstone');
  assert.deepEqual((await getPlan(h, P.tomorrow)).items.map(item => item.itemId).sort(), ['pgym1', 'pother']);
  const arrayDelete = await h.handle(command('plan_delete', { ...parameters, itemId: 'pgym1' }, { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, 'pgym1') }));
  assert.equal(arrayDelete.status, 200);
  assert.equal(recordItem(store, P.tomorrow, 'pgym1').deleted, true, 'array items keep a tombstone too');
  assert.equal(store.room.calendarPlans[P.tomorrow].items.length, 2, 'nothing physically removed');
});

test('completion/delete race and move/delete race: whichever lands first wins; the other is STALE, never both', async () => {
  for (const loser of ['plan_set_completion', 'plan_move']) {
    const { store, h } = await setup(tomorrowWith(gym()));
    const rev = await revisionOf(h, P.tomorrow, 'pgym1');
    const target = { store: 'calendar', id: P.tomorrow };
    const extra = loser === 'plan_move' ? { destination: { store: 'calendar', id: P.dayAfter } } : { completed: true };
    const [a, b] = await Promise.all([
      h.handle(command('plan_delete', { target, itemId: 'pgym1' }, { actionId: newAction(), expectedRevision: rev })),
      h.handle(command(loser, { target, itemId: 'pgym1', ...extra }, { actionId: newAction(), expectedRevision: rev })),
    ]);
    const outcomes = [a, b].map(r => r.status === 200 ? 'ok' : code(r)).sort();
    assert.deepEqual(outcomes, ['STALE_REVISION', 'ok'], `${loser}: ${JSON.stringify([a.body, b.body])}`);
    const live = [...(await getPlan(h, P.tomorrow)).items, ...(await getPlan(h, P.dayAfter)).items];
    assert.ok(live.length <= 1, 'never two current copies');
    void store;
  }
});

// ── RECEIPTS: crash, takeover, late writer, parallel ────────────────────────

function harnessWithInfra(domain, infra, nowMs) {
  const h = harness({ domain, nowMs });
  // Share one private receipt store across attempts (a crashed Function instance and its successor).
  for (const key of ['createIfAbsent', 'get', 'getWithEtag', 'putIfMatch']) h.infra[key] = infra[key].bind(infra);
  h.infra.data = infra.data;
  return h;
}

test('write landed but its response was lost: the same attempt re-reads and proves APPLIED; no second write', async () => {
  let lose = true;
  const store = planDomain(tomorrowWith(gym()), { async afterRecordPut() { if (lose) { lose = false; throw new ApiError('RETRYABLE_TRANSPORT', 'lost'); } } });
  const h = harness({ domain: store });
  const response = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true },
    { actionId: newAction(), expectedRevision: await revisionOf(h, P.tomorrow, 'pgym1') }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(store.writes.length, 1);
});

test('crash after the domain write, before the receipt: the takeover proves it from the planned revision, never re-applies', async () => {
  let crash = true;
  const store = planDomain(tomorrowWith(gym()), { async afterRecordPut() { if (crash) { crash = false; throw new Error('process died'); } } });
  const h = harness({ domain: store });
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const actionId = newAction();
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true };
  assert.equal((await h.handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }))).status, 500);
  assert.equal(h.infra.data.get(RECEIPT(actionId)).state, 'started');
  const early = await harnessWithInfra(store, h.infra, NOW_MS + 1_000).handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }));
  assert.equal(code(early), 'PENDING_UNKNOWN', 'an active lease is never executed twice');
  const retry = await harnessWithInfra(store, h.infra, NOW_MS + 31_000).handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(store.writes.length, 1, 'proven, not re-applied');
  assert.equal(h.infra.data.get(RECEIPT(actionId)).state, 'applied');
});

test('crash before any intent, then the owner edits: the takeover REJECTS as stale (no write of this action can exist)', async () => {
  let crash = true;
  const store = planDomain(tomorrowWith(gym()), { async beforeRecordRead() { if (crash) { crash = false; throw new Error('process died'); } } });
  const h = harness({ domain: store });
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  crash = true;
  const actionId = newAction();
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true };
  assert.equal((await h.handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }))).status, 500);
  assert.equal(h.infra.data.get(RECEIPT(actionId)).intent, undefined);
  store.ownerRecord(P.tomorrow, planRecord([gym({ task: 'Owner edit', updatedAt: T0 + 3 })]));
  const retry = await harnessWithInfra(store, h.infra, NOW_MS + 31_000).handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }));
  assert.equal(code(retry), 'STALE_REVISION');
  assert.equal(h.infra.data.get(RECEIPT(actionId)).state, 'rejected');
  assert.equal(recordItem(store, P.tomorrow, 'pgym1').task, 'Owner edit');
});

test('crash AFTER the intent, then the owner edits: never rejected (an earlier write may still land) -> PENDING_UNKNOWN; owner edit kept', async () => {
  let crash = true;
  const store = planDomain(tomorrowWith(gym()), { async beforeRecordPut() { if (crash) { crash = false; throw new Error('process died'); } } });
  const h = harness({ domain: store });
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const actionId = newAction();
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true };
  assert.equal((await h.handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }))).status, 500);
  assert.ok(h.infra.data.get(RECEIPT(actionId)).intent, 'the intent was recorded before the write');
  store.ownerRecord(P.tomorrow, planRecord([gym({ task: 'Owner edit', updatedAt: T0 + 3 })]));
  for (const at of [NOW_MS + 31_000, NOW_MS + 290_000]) { // within the signed-request freshness window
    const retry = await harnessWithInfra(store, h.infra, at).handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }));
    assert.equal(code(retry), 'PENDING_UNKNOWN', 'no elapsed time turns this into a rejection');
    assert.notEqual(h.infra.data.get(RECEIPT(actionId)).state, 'rejected');
  }
  assert.equal(recordItem(store, P.tomorrow, 'pgym1').task, 'Owner edit');
  assert.equal(store.writes.length, 0);
});

test('late writer: a paused first attempt resumes after the takeover applied; its CAS fails and it proves the same result', async () => {
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  let pauseOnce = true;
  const store = planDomain(tomorrowWith(gym()), {
    async beforeRecordPut() { if (pauseOnce) { pauseOnce = false; await paused; } },
  });
  const h = harness({ domain: store });
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const actionId = newAction();
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true };
  const first = h.handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const takeover = await harnessWithInfra(store, h.infra, NOW_MS + 31_000).handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }));
  assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
  release();
  const late = await first;
  assert.ok(late.status === 200 || code(late) === 'PENDING_UNKNOWN', JSON.stringify(late.body));
  assert.equal(store.writes.length, 1, 'the late writer\'s stale-ETag write never landed');
  assert.equal(h.infra.data.get(RECEIPT(actionId)).state, 'applied');
});

test('late writer vs owner edit: the paused attempt cannot land over a newer owner edit (its ETag is stale)', async () => {
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  let pauseOnce = true;
  const store = planDomain(tomorrowWith(gym()), { async beforeRecordPut() { if (pauseOnce) { pauseOnce = false; await paused; } } });
  const h = harness({ domain: store });
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const actionId = newAction();
  const first = h.handle(command('plan_edit', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', title: 'Strength' }, { actionId, expectedRevision: rev }));
  await new Promise(resolve => setTimeout(resolve, 20));
  store.ownerRecord(P.tomorrow, planRecord([gym({ task: 'Owner wins', updatedAt: T0 + 3 })]));
  release();
  const late = await first;
  // The ONLY attempt, and its own write got a definite 412: nothing of this action can ever land, so STALE is proven.
  assert.equal(code(late), 'STALE_REVISION', JSON.stringify(late.body));
  assert.equal(recordItem(store, P.tomorrow, 'pgym1').task, 'Owner wins');
  assert.equal(store.writes.length, 0);
});

test('parallel duplicates of one action: one logical effect; every answer is the result or PENDING_UNKNOWN', async () => {
  const { store, h } = await setup(tomorrowWith(gym()));
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const actionId = newAction();
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', destination: { store: 'calendar', id: P.dayAfter } };
  const all = await Promise.all(Array.from({ length: 10 }, () => h.handle(command('plan_move', parameters, { actionId, expectedRevision: rev }))));
  assert.ok(all.some(r => r.status === 200));
  assert.ok(all.every(r => r.status === 200 || code(r) === 'PENDING_UNKNOWN'), JSON.stringify(all.map(r => r.body.error)));
  assert.equal(store.writes.length, 1, 'one atomic move');
  assert.deepEqual((await getPlan(h, P.dayAfter)).items.map(item => item.itemId), ['pgym1']);
});

test('receipt CAS lost at settle: the answer is PENDING_UNKNOWN, and the retry proves APPLIED from the item', async () => {
  const store = planDomain(tomorrowWith(gym()));
  const h = harness({ domain: store });
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const actionId = newAction();
  const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true };
  const put = h.infra.putIfMatch;
  let calls = 0;
  h.infra.putIfMatch = async (path, value, etag) => (value.state === 'applied' && calls++ === 0 ? 'changed' : put(path, value, etag));
  assert.equal(code(await h.handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }))), 'PENDING_UNKNOWN');
  h.infra.putIfMatch = put;
  const retry = await harnessWithInfra(store, h.infra, NOW_MS + 31_000).handle(command('plan_set_completion', parameters, { actionId, expectedRevision: rev }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(store.writes.length, 1);
});

test('a rules refusal of the write on the FIRST attempt (nothing landed) is a definite rejection; the item is untouched', async () => {
  const store = planDomain(tomorrowWith(gym()), { async beforeRecordPut() { throw new ApiError('FORBIDDEN', 'ChronaSense account access was refused.'); } });
  const h = harness({ domain: store });
  const actionId = newAction();
  const response = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true },
    { actionId, expectedRevision: await revisionOf(h, P.tomorrow, 'pgym1') }));
  assert.equal(code(response), 'FORBIDDEN');
  assert.equal(h.infra.data.get(RECEIPT(actionId)).state, 'rejected');
});

// ── AUTH / SCOPE ────────────────────────────────────────────────────────────

test('scope isolation: read-only and Brain Dump write grants cannot mutate a plan item; nothing is claimed or written', async () => {
  const { store, h } = await setup(tomorrowWith(gym()));
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  for (const scopes of [['chronasense:read'], ['chronasense:brain-dump.write'], ['chronasense:brain-dump.write', 'chronasense:read']]) {
    for (const [kind, extra] of [['plan_set_completion', { completed: true }], ['plan_edit', { title: 'x' }], ['plan_move', { destination: { store: 'calendar', id: P.dayAfter } }], ['plan_delete', {}]]) {
      const actionId = newAction();
      const response = await h.handle(command(kind, { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', ...extra }, { actionId, expectedRevision: rev, scopes }));
      assert.equal(code(response), 'FORBIDDEN', `${kind} with ${scopes}`);
      assert.equal(h.infra.data.get(RECEIPT(actionId)), undefined);
    }
  }
  assert.equal(store.writes.length, 0);
});

test('two DIFFERENT actions with the identical intent in the same millisecond: one applies, the other never claims its write', async () => {
  for (const order of ['sequential', 'parallel']) {
    const { store, h } = await setup(tomorrowWith(gym()));
    const rev = await revisionOf(h, P.tomorrow, 'pgym1');
    const parameters = { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1', completed: true };
    const [a, b] = [newAction(), newAction()];
    const run = id => h.handle(command('plan_set_completion', parameters, { actionId: id, expectedRevision: rev }));
    const results = order === 'parallel' ? await Promise.all([run(a), run(b)]) : [await run(a), await run(b)];
    assert.deepEqual(results.map(r => (r.status === 200 ? 'ok' : code(r))).sort(), ['STALE_REVISION', 'ok'], order);
    assert.equal(store.writes.length, 1);
    const winner = results[0].status === 200 ? a : b;
    assert.equal(recordItem(store, P.tomorrow, 'pgym1').updatedBy, winner, 'the stored writer names the action that applied');
  }
});

test('two concurrent moves of one item to DIFFERENT days: one wins, the other is STALE; never two current copies', async () => {
  const third = planIdOf(addCalendarDays(TODAY, 3));
  const { store, h } = await setup(tomorrowWith(gym()));
  const rev = await revisionOf(h, P.tomorrow, 'pgym1');
  const move = destination => h.handle(command('plan_move', { target: { store: 'calendar', id: P.tomorrow }, itemId: 'pgym1',
    destination: { store: 'calendar', id: destination } }, { actionId: newAction(), expectedRevision: rev }));
  const results = await Promise.all([move(P.dayAfter), move(third)]);
  assert.deepEqual(results.map(r => (r.status === 200 ? 'ok' : code(r))).sort(), ['STALE_REVISION', 'ok'], JSON.stringify(results.map(r => r.body.error)));
  const live = [...(await getPlan(h, P.tomorrow)).items, ...(await getPlan(h, P.dayAfter)).items, ...(await getPlan(h, third)).items];
  assert.deepEqual(live.map(item => item.itemId), ['pgym1'], 'exactly one current copy');
  assert.equal(store.writes.length, 1);
});

// ── api1_ CROSS-DAY MOVE (TASK-012 gap closure) ─────────────────────────────
// "Move my ChatGPT gym task to Friday": the SAME api1_ id goes live at the destination plan's keyed fence child with the
// next relocationRevision, and its source child becomes a move tombstone, in ONE atomic multi-path update.
const fenceItem = (store, planId, itemId = API_ITEM) => store.room.calendarPlanFences[planId]?.[itemId];
const apiSeed = (extra = {}) => ({ calendarPlans: { [P.tomorrow]: planRecord([other()]) },
  calendarPlanFences: { [P.tomorrow]: { [API_ITEM]: apiItem() } }, ...extra });
const moveApi = (h, rev, { actionId = newAction(), destination = P.dayAfter, from = P.tomorrow, ...extra } = {}) =>
  h.handle(command('plan_move', { target: { store: 'calendar', id: from }, itemId: API_ITEM, destination: { store: 'calendar', id: destination }, ...extra },
    { actionId, expectedRevision: rev }));
const liveCopies = async (h, planIds) => (await Promise.all(planIds.map(id => getPlan(h, id)))).flatMap(plan => plan.items).filter(item => item.itemId === API_ITEM);

test('"Move my ChatGPT gym task to Friday": same api1_ id live at the destination child, source move tombstone, provenance kept, one atomic write', async () => {
  const { store, h } = await setup(apiSeed());
  const rev = await revisionOf(h, P.tomorrow, API_ITEM);
  const actionId = newAction();
  const moved = await moveApi(h, rev, { actionId });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const relocation = { schemaVersion: 1, sequence: 1, fromDayId: P.tomorrow, toDayId: P.dayAfter, updatedBy: actionId, updatedAt: NOW_MS };
  assert.deepEqual(fenceItem(store, P.dayAfter), apiItem({ relocationRevision: relocation, updatedAt: NOW_MS, updatedBy: actionId }),
    'the SAME identity and creation provenance, live at the destination');
  assert.deepEqual(fenceItem(store, P.tomorrow), apiItem({ deleted: true, movedToDayId: P.dayAfter, relocationRevision: relocation, updatedAt: NOW_MS, updatedBy: actionId }),
    'the source child is kept as a move tombstone (history is never physically deleted)');
  assert.deepEqual(store.writes, [{ planId: P.dayAfter, where: 'record' }, { planIds: [P.tomorrow, P.dayAfter], itemId: API_ITEM, where: 'relocation' }],
    'the destination origin, then ONE atomic relocation; nothing else');
  assert.ok(Object.values(store.room.calendarPlans).every(record => !(record.items || []).some(item => item.id === API_ITEM)), 'no api1_ ever enters a plan array');
  assert.deepEqual([store.room.calendarPlans[P.dayAfter].timezone, store.room.calendarPlans[P.dayAfter].createdAt], [ZONE, NOW_MS], 'destination origin frozen first');
  assert.deepEqual(await liveCopies(h, [P.tomorrow, P.dayAfter]).then(items => items.length), 1, 'get_plan shows ONE current logical item');
  assert.deepEqual((await getPlan(h, P.dayAfter)).items.map(item => item.itemId), [API_ITEM]);
  assert.equal((await getItem(h, P.tomorrow, API_ITEM)).state, 'tombstoned');
  const { result } = moved.body;
  assert.deepEqual([result.target.id, result.destination.id, result.itemId], [P.tomorrow, P.dayAfter, API_ITEM]);
  assert.equal(result.revision, await revisionOf(h, P.dayAfter, API_ITEM), 'the effective item revision is the readable one');
  const receipt = h.infra.data.get(RECEIPT(actionId));
  assert.deepEqual([receipt.state, receipt.plannedRecordId, receipt.plannedTarget.id, receipt.effectiveTarget.id], ['applied', API_ITEM, P.tomorrow, P.dayAfter],
    'the receipt names the source item/target and the resulting effective item/target');
  const replay = await moveApi(h, rev, { actionId });
  assert.equal(replay.body.result.idempotentReplay, true);
  assert.equal(store.writes.length, 2, 'no duplicate destination');
  const conflict = await moveApi(h, rev, { actionId, destination: planIdOf(addCalendarDays(TODAY, 3)) });
  assert.equal(code(conflict), 'IDEMPOTENCY_CONFLICT', 'same action, different destination');
});

test('api1_ move: stale revision, a source edit racing the relocation, an already-deleted source: never moved, owner state kept', async () => {
  const { store, h } = await setup(apiSeed());
  const stale = await revisionOf(h, P.tomorrow, API_ITEM);
  store.ownerFence(P.tomorrow, apiItem({ task: 'Gym (legs)', updatedAt: T0 + 5, updatedBy: 'phone' }));
  assert.equal(code(await moveApi(h, stale)), 'STALE_REVISION');

  // The owner edits after the Function's read but before the relocation commits: the rules' writer-stamp check refuses
  // the multi-path update, and the re-read reports STALE (never FORBIDDEN, never a half move).
  let once = true;
  const raced = planDomain(apiSeed(), { async beforeRelocate() { if (once) { once = false; raced.ownerFence(P.tomorrow, apiItem({ task: 'Owner', updatedAt: T0 + 7, updatedBy: 'phone' })); } } });
  const hr = harness({ domain: raced });
  const racedMove = await moveApi(hr, await revisionOf(hr, P.tomorrow, API_ITEM));
  assert.equal(code(racedMove), 'STALE_REVISION', JSON.stringify(racedMove.body));
  assert.equal(fenceItem(raced, P.dayAfter), undefined, 'no destination copy');
  assert.equal(fenceItem(raced, P.tomorrow).task, 'Owner', 'the racing owner edit stands');

  const deleted = planDomain(apiSeed());
  const hd = harness({ domain: deleted });
  const liveRev = await revisionOf(hd, P.tomorrow, API_ITEM);
  deleted.ownerFence(P.tomorrow, apiItem({ deleted: true, updatedAt: T0 + 9, updatedBy: 'phone' }));
  assert.equal(code(await moveApi(hd, liveRev)), 'STALE_REVISION', 'a deleted task is never moved back to life');
  assert.equal(fenceItem(deleted, P.dayAfter), undefined);
  assert.equal([...store.writes, ...raced.writes, ...deleted.writes].filter(write => write.where !== 'record').length, 0, 'no item write (only a destination origin)');
});

test('api1_ move: two concurrent moves to DIFFERENT days -> one destination, the other STALE; never two current copies', async () => {
  const third = planIdOf(addCalendarDays(TODAY, 3));
  const { store, h } = await setup(apiSeed());
  const rev = await revisionOf(h, P.tomorrow, API_ITEM);
  const results = await Promise.all([moveApi(h, rev, { destination: P.dayAfter }), moveApi(h, rev, { destination: third })]);
  assert.deepEqual(results.map(r => (r.status === 200 ? 'ok' : code(r))).sort(), ['STALE_REVISION', 'ok'], JSON.stringify(results.map(r => r.body.error)));
  assert.equal((await liveCopies(h, [P.tomorrow, P.dayAfter, third])).length, 1);
  assert.equal(store.writes.filter(write => write.where === 'relocation').length, 1);
  assert.equal([fenceItem(store, P.dayAfter), fenceItem(store, third)].filter(Boolean).length, 1, 'exactly one destination child exists');
});

test('api1_ move: crash after the atomic relocation -> the takeover proves it from the source tombstone; receipt CAS loss -> retry proves it', async () => {
  let crash = true;
  const store = planDomain(apiSeed(), { async afterRelocate() { if (crash) { crash = false; throw new Error('process died'); } } });
  const h = harness({ domain: store });
  const rev = await revisionOf(h, P.tomorrow, API_ITEM);
  const actionId = newAction();
  assert.equal((await moveApi(h, rev, { actionId })).status, 500);
  assert.ok(h.infra.data.get(RECEIPT(actionId)).intent.destinationRevision, 'the intent named the destination revision before writing');
  const retry = await harnessWithInfra(store, h.infra, NOW_MS + 31_000).handle(command('plan_move', { target: { store: 'calendar', id: P.tomorrow },
    itemId: API_ITEM, destination: { store: 'calendar', id: P.dayAfter } }, { actionId, expectedRevision: rev }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(store.writes.filter(write => write.where === 'relocation').length, 1, 'proven, never relocated twice');

  const lost = planDomain(apiSeed());
  const hl = harness({ domain: lost });
  const lostRev = await revisionOf(hl, P.tomorrow, API_ITEM);
  const lostId = newAction();
  const put = hl.infra.putIfMatch;
  let calls = 0;
  hl.infra.putIfMatch = async (path, value, etag) => (value.state === 'applied' && calls++ === 0 ? 'changed' : put(path, value, etag));
  assert.equal(code(await moveApi(hl, lostRev, { actionId: lostId })), 'PENDING_UNKNOWN');
  hl.infra.putIfMatch = put;
  const proven = await harnessWithInfra(lost, hl.infra, NOW_MS + 31_000).handle(command('plan_move', { target: { store: 'calendar', id: P.tomorrow },
    itemId: API_ITEM, destination: { store: 'calendar', id: P.dayAfter } }, { actionId: lostId, expectedRevision: lostRev }));
  assert.equal(proven.status, 200, JSON.stringify(proven.body));
  assert.equal(lost.writes.filter(write => write.where === 'relocation').length, 1);
});

test('api1_ move: destination origin absent, concurrently created in another zone, or already in another zone; past and pre-switch refused', async () => {
  // Concurrently created: another device writes the destination origin (Tokyo) while ours is being frozen.
  let once = true;
  const store = planDomain(apiSeed(), { async beforeRecordPut(planId) {
    if (planId === P.dayAfter && once) { once = false; store.ownerRecord(P.dayAfter, planRecord([other({ id: 'ptokyo' })], { createdAt: T0 - 9, timezone: 'Asia/Tokyo' })); }
  } });
  const h = harness({ domain: store });
  const moved = await moveApi(h, await revisionOf(h, P.tomorrow, API_ITEM), { time: { when: '07:00', whenTz: ZONE } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(store.room.calendarPlans[P.dayAfter].timezone, 'Asia/Tokyo', 'the earliest origin wins and is never rewritten');
  assert.equal(moved.body.result.item.schedule.startAt, new Date(Date.parse(`${DAY_AFTER}T07:00:00+08:00`)).toISOString(), 'the item keeps its own explicit zone');
  assert.deepEqual(store.room.calendarPlans[P.dayAfter].items.map(item => item.id), ['ptokyo'], 'still no api1_ in the array');

  const refused = planDomain(apiSeed());
  const hr = harness({ domain: refused });
  const rev = await revisionOf(hr, P.tomorrow, API_ITEM);
  assert.equal(code(await moveApi(hr, rev, { destination: P.yesterday })), 'PAST_TARGET_IMMUTABLE');
  assert.equal(code(await moveApi(hr, rev, { destination: planIdOf(addCalendarDays(localPlanDate(ACTIVATED_AT, ZONE), -1)) })), 'NOT_FOUND', 'pre-switch day');
  assert.equal(refused.writes.length, 0);
});

test('api1_ move: edits after the move keep the relocation; it can move on again (sequence 2) but not back onto its own tombstone', async () => {
  const third = planIdOf(addCalendarDays(TODAY, 3));
  const { store, h } = await setup(apiSeed());
  assert.equal((await moveApi(h, await revisionOf(h, P.tomorrow, API_ITEM))).status, 200);
  const done = await h.handle(command('plan_set_completion', { target: { store: 'calendar', id: P.dayAfter }, itemId: API_ITEM, completed: true },
    { actionId: newAction(), expectedRevision: await revisionOf(h, P.dayAfter, API_ITEM) }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(fenceItem(store, P.dayAfter).relocationRevision.sequence, 1, 'an edit never changes the relocation');
  const back = await moveApi(h, await revisionOf(h, P.dayAfter, API_ITEM), { from: P.dayAfter, destination: P.tomorrow });
  assert.equal(code(back), 'DOMAIN_LIMIT', 'a fence tombstone is never revived');
  const onward = await moveApi(h, await revisionOf(h, P.dayAfter, API_ITEM), { from: P.dayAfter, destination: third });
  assert.equal(onward.status, 200, JSON.stringify(onward.body));
  assert.equal(fenceItem(store, third).relocationRevision.sequence, 2);
  assert.equal(fenceItem(store, third).creationActionId, API_ACTION);
  assert.equal(fenceItem(store, P.tomorrow).relocationRevision.sequence, 1, 'older history is untouched');
  assert.deepEqual((await liveCopies(h, [P.tomorrow, P.dayAfter, third])).map(item => item.done), [true], 'one current copy, still done');
});

test('api1_ move: a stale client cannot resurrect the source or fabricate/strip a relocation (owner-write rules)', async () => {
  const { store, h } = await setup(apiSeed());
  assert.equal((await moveApi(h, await revisionOf(h, P.tomorrow, API_ITEM))).status, 200);
  const identity = { firebaseUid: OWNER.ownerFirebaseUid, roomId: `uid_${OWNER.ownerFirebaseUid}` };
  const source = await store.readPlanFenceItemWithEtag(identity, P.tomorrow, API_ITEM);
  await assert.rejects(store.putPlanFenceItemIfMatch(identity, P.tomorrow, API_ITEM, apiItem({ updatedAt: T0 + 99 }), source.etag),
    error => error.code === 'FORBIDDEN', 'the pre-move live copy cannot come back');
  const dest = await store.readPlanFenceItemWithEtag(identity, P.dayAfter, API_ITEM);
  const { relocationRevision: _r, ...stripped } = dest.value;
  await assert.rejects(store.putPlanFenceItemIfMatch(identity, P.dayAfter, API_ITEM, stripped, dest.etag), error => error.code === 'FORBIDDEN');
  assert.equal(await store.putPlanFenceItemIfMatch(identity, P.dayAfter, API_ITEM, { ...dest.value, task: 'Gym!', updatedAt: NOW_MS + 1 }, dest.etag), 'written',
    'an ordinary owner edit that keeps the relocation is fine');
});
