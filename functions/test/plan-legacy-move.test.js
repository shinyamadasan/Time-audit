// TASK-038 (DECISIONS #42): plan_move between two LEGACY plan days (`plans/<YYYY-MM-DD>`) of an account that never ran
// the calendar cutover — "move my unfinished tasks from today to tomorrow". The server twin of the app's own legacy
// updateItem cross-day move: the SAME item id goes live at the destination with the next relocationRevision and the
// source copy becomes a tombstone naming movedToDayId, both records in ONE compare-and-set of the plans collection, each
// changed in place. Same receipts, revisions, idempotency and recovery as every TASK-012 mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { COMMAND_PATH } from '../src/action-api.js';
import { actionActorRef } from '../src/envelope.js';
import { ApiError } from '../src/errors.js';
import { addCalendarDays, localPlanDate, mergeDatePlans } from '../shared/plan-tomorrow-model.js';
import { canonicalPlanItemRelocations, planItemIsActiveInDay } from '../shared/plan-item-relocation.js';
import { legacyBoundaryRevision, proposeBoundaryRevision } from '../shared/personal-day-boundary-model.js';
import { NOW_MS, OWNER, harness, signedRequest } from './support.js';
import { FACT, ZONE, planDomain } from './plan-domain-support.js';

const TODAY = localPlanDate(NOW_MS, ZONE);
const TOMORROW = addCalendarDays(TODAY, 1);
const YESTERDAY = addCalendarDays(TODAY, -1);
const ACTOR = actionActorRef(OWNER.ownerSubject);
const RECEIPT = actionId => `serverActionReceipts/${OWNER.ownerFirebaseUid}/${actionId}`;
const T0 = NOW_MS - 3_600_000;
const BD_ITEM = 'bdp1|cap_menu01';
const newAction = () => `act1_${randomUUID()}`;
const legacy = id => ({ store: 'legacy', id });

const task = (id, title, overrides = {}) => ({ id, task: title, when: '', done: false, kind: 'task', updatedAt: T0, updatedBy: 'phone', ...overrides });
const products = (o = {}) => task('p1', 'Post remaining products', o);
const menu = (o = {}) => task('p2', 'Make price menu', { when: '14:00', durationMinutes: 60, ...o });
const kuryente = (o = {}) => task('p3', 'Pay apartment kuryente', { when: '17:00', ...o });
const PREPARATION = { targetDate: TODAY, firstPreparedAt: T0 - 5000, timezone: ZONE, oneOffItemIds: ['p1', 'p2', 'p3'] };
const legacyRecord = (items, extra = {}) => ({ updatedAt: T0, updatedBy: 'phone', preparation: PREPARATION, items, ...extra });
const bdItem = (o = {}) => ({ id: BD_ITEM, task: 'Brain Dump task', when: '', done: false, kind: 'task', updatedAt: T0, updatedBy: 'phone',
  brainDumpOrigin: { v: 2, claimEpoch: 0, type: 'do-today', store: 'legacy', targetKey: TODAY }, ...o });
/** A never-activated account: no calendarPlanAuthority fact, so its plans route to the legacy store. */
const legacyAccount = (plans, extra = {}) => ({ calendarPlanAuthority: {}, plans, ...extra });
const threeTasks = () => legacyAccount({ [TODAY]: legacyRecord([products(), menu(), kuryente()]) });

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
const planOf = async (h, dateKey) => (await query(h, 'get_plan', { target: legacy(dateKey) })).plan;
const revisionOf = async (h, itemId, dateKey = TODAY) => (await query(h, 'get_item', { source: 'plan', id: itemId, target: legacy(dateKey) })).item.revision;
const code = response => response.body.error?.code;
const raw = (store, dateKey) => Object.values(store.room.plans?.[dateKey]?.items || {});
const stored = (store, itemId, dateKey = TODAY) => raw(store, dateKey).find(item => item?.id === itemId);
const move = (itemId, from = TODAY, to = TOMORROW) => ({ target: legacy(from), itemId, destination: legacy(to) });
function setup(seed, hooks) {
  const store = planDomain(seed, hooks);
  return { store, h: harness({ domain: store }) };
}
async function moveItem(h, itemId, from = TODAY, to = TOMORROW, actionId = newAction()) {
  return h.handle(command('plan_move', move(itemId, from, to), { actionId, expectedRevision: await revisionOf(h, itemId, from) }));
}
function harnessWithInfra(domain, infra, nowMs) {
  const h = harness({ domain, nowMs });
  for (const key of ['createIfAbsent', 'get', 'getWithEtag', 'putIfMatch']) h.infra[key] = infra[key].bind(infra);
  h.infra.data = infra.data;
  return h;
}
/** Where the app's own projection (the shared relocation index) shows each id live, across every legacy day. */
function liveDays(plans) {
  const days = Object.fromEntries(Object.entries(plans).map(([id, record]) => [id, { items: Object.values(record.items || {}) }]));
  const canonical = canonicalPlanItemRelocations(days);
  const live = {};
  for (const [dayId, record] of Object.entries(days)) {
    for (const item of record.items) if (planItemIsActiveInDay(item, dayId, canonical)) (live[item.id] ??= []).push(dayId);
  }
  return live;
}

test('move two explicitly selected unfinished tasks to tomorrow: same ids live tomorrow, tombstones today, the rest byte-identical', async () => {
  const { store, h } = setup(threeTasks());
  const before = structuredClone(store.room.plans[TODAY]);
  for (const itemId of ['p1', 'p2']) {
    const actionId = newAction();
    const previous = await revisionOf(h, itemId);
    const response = await moveItem(h, itemId, TODAY, TOMORROW, actionId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { result } = response.body;
    assert.deepEqual(result.target, { store: 'legacy', id: TODAY, date: TODAY });
    assert.deepEqual(result.destination, { store: 'legacy', id: TOMORROW, date: TOMORROW });
    assert.equal(result.itemId, itemId);
    assert.equal(result.changed, true);
    assert.equal(result.previousRevision, previous);
    assert.equal(result.revision, await revisionOf(h, itemId, TOMORROW), 'the result revision is the readable one, at the destination');
    const receipt = h.infra.data.get(RECEIPT(actionId));
    assert.equal(receipt.state, 'applied');
    assert.deepEqual(receipt.effectiveTarget, { store: 'legacy', id: TOMORROW, date: TOMORROW });
    assert.equal(JSON.stringify(receipt).includes('Post remaining') || JSON.stringify(receipt).includes('price menu'), false, 'the receipt never copies task text');
  }
  assert.deepEqual(store.writes.map(write => write.where), ['legacy-collection', 'legacy-collection'], 'one atomic write per move');
  // Destination: created exactly as the app's legacy save creates a record; the moved copies keep every field.
  const created = store.room.plans[TOMORROW];
  assert.deepEqual(Object.keys(created).sort(), ['items', 'updatedAt', 'updatedBy']);
  const movedMenu = stored(store, 'p2', TOMORROW);
  assert.deepEqual([movedMenu.task, movedMenu.when, movedMenu.durationMinutes, movedMenu.kind, movedMenu.done], ['Make price menu', '14:00', 60, 'task', false]);
  assert.deepEqual(movedMenu.relocationRevision, { schemaVersion: 1, sequence: 1, fromDayId: TODAY, toDayId: TOMORROW,
    updatedBy: movedMenu.updatedBy, updatedAt: movedMenu.updatedAt });
  assert.equal(movedMenu.movedToDayId, undefined);
  // Source: tombstones naming the destination, the third task and the preparation byte-identical.
  for (const itemId of ['p1', 'p2']) {
    const tombstone = stored(store, itemId);
    assert.equal(tombstone.deleted, true);
    assert.equal(tombstone.movedToDayId, TOMORROW);
    assert.deepEqual(tombstone.relocationRevision, stored(store, itemId, TOMORROW).relocationRevision);
  }
  assert.deepEqual(stored(store, 'p3'), before.items[2]);
  assert.deepEqual(store.room.plans[TODAY].preparation, before.preparation);
  // ChatGPT verifies: no duplicates, each task on exactly one day.
  assert.deepEqual((await planOf(h, TODAY)).items.map(item => item.itemId), ['p3']);
  assert.deepEqual((await planOf(h, TOMORROW)).items.map(item => item.itemId), ['p1', 'p2']);
  assert.deepEqual((await query(h, 'get_today', {})).plan.items.map(item => item.itemId), ['p3']);
  assert.deepEqual(liveDays(store.room.plans), { p1: [TOMORROW], p2: [TOMORROW], p3: [TODAY] }, 'the app projects each id on one day');
});

test('an existing destination plan keeps every item, its preparation and its array shape (array and pruned-slot object forms)', async () => {
  for (const items of [[task('t1', 'Already tomorrow')], { 0: task('t1', 'Already tomorrow'), 2: task('t2', 'Pruned slot neighbour') }]) {
    const tomorrow = { updatedAt: T0, updatedBy: 'laptop', preparation: { ...PREPARATION, targetDate: TOMORROW }, items };
    const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products()]), [TOMORROW]: tomorrow }));
    const before = structuredClone(store.room.plans[TOMORROW]);
    assert.equal((await moveItem(h, 'p1')).status, 200);
    const after = store.room.plans[TOMORROW];
    assert.deepEqual(after.preparation, before.preparation);
    for (const [key, item] of Object.entries(before.items)) assert.deepEqual(after.items[key], item, `item at ${key} unchanged`);
    assert.equal(Array.isArray(after.items), Array.isArray(before.items));
    assert.equal(Object.values(after.items).filter(item => item.id === 'p1').length, 1);
  }
});

test('replay of the same action is idempotent: same result, no second write, no duplicate', async () => {
  const { store, h } = setup(threeTasks());
  const actionId = newAction();
  const expectedRevision = await revisionOf(h, 'p1');
  const first = await h.handle(command('plan_move', move('p1'), { actionId, expectedRevision }));
  const replay = await h.handle(command('plan_move', move('p1'), { actionId, expectedRevision }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.result.idempotentReplay, true);
  assert.equal(replay.body.result.revision, first.body.result.revision);
  assert.equal(store.writes.length, 1);
  // The same action ID with another selection is a different command, never a second move.
  const reuse = await h.handle(command('plan_move', move('p2'), { actionId, expectedRevision: await revisionOf(h, 'p2') }));
  assert.equal(code(reuse), 'IDEMPOTENCY_CONFLICT');
  assert.equal(store.writes.length, 1);
});

test('Undo: moving it back makes it live today again (next relocation), tomorrow a tombstone; no duplicate either day', async () => {
  const { store, h } = setup(threeTasks());
  assert.equal((await moveItem(h, 'p1')).status, 200);
  const back = await moveItem(h, 'p1', TOMORROW, TODAY);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(back.body.result.destination, { store: 'legacy', id: TODAY, date: TODAY });
  const restored = stored(store, 'p1');
  assert.notEqual(restored.deleted, true);
  assert.equal(restored.relocationRevision.sequence, 2);
  assert.equal(restored.task, 'Post remaining products');
  assert.equal(raw(store, TODAY).filter(item => item.id === 'p1').length, 1, 'the old tombstone is replaced, never duplicated');
  assert.equal(stored(store, 'p1', TOMORROW).deleted, true);
  assert.deepEqual((await planOf(h, TODAY)).items.map(item => item.itemId), ['p1', 'p2', 'p3']);
  assert.deepEqual((await planOf(h, TOMORROW)).items, []);
  assert.deepEqual(liveDays(store.room.plans).p1, [TODAY]);
});

test('a Brain Dump task stays where its capture put it: DOMAIN_LIMIT, nothing written; it can still be completed there', async () => {
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products()]) }, { planFences: { [TODAY]: { [BD_ITEM]: bdItem() } } }));
  const before = structuredClone(store.room.planFences);
  const actionId = newAction();
  const fenced = await moveItem(h, BD_ITEM, TODAY, TOMORROW, actionId);
  assert.equal(code(fenced), 'DOMAIN_LIMIT');
  assert.equal(fenced.body.error.message, "Brain Dump tasks can't be moved to another day yet.");
  assert.equal(h.infra.data.get(RECEIPT(actionId)).state, 'rejected', 'a definite refusal: a new action ID may be used');
  assert.equal(store.writes.length, 0);
  assert.deepEqual(store.room.planFences, before);
  const done = await h.handle(command('plan_set_completion', { target: legacy(TODAY), itemId: BD_ITEM, completed: true }, { expectedRevision: await revisionOf(h, BD_ITEM) }));
  assert.equal(done.status, 200, 'the Brain Dump task can still be completed where it is');
});

test('a task recovered from an earlier day is rescheduled from Unfinished, not moved (DOMAIN_LIMIT)', async () => {
  // Exactly what the app's Unfinished flow writes (moveStaleItem): the source stays, the carry copy holds the relocation.
  const source = task('x', 'Recovered task');
  const copy = task('ocarry1|x', 'Recovered task', { carriedFromId: 'x', carriedFromDayId: YESTERDAY,
    relocationRevision: { schemaVersion: 1, sequence: 1, fromDayId: YESTERDAY, toDayId: TODAY, updatedBy: 'phone', updatedAt: T0 } });
  const { store, h } = setup(legacyAccount({ [YESTERDAY]: { updatedAt: T0, updatedBy: 'phone', items: [source] }, [TODAY]: legacyRecord([copy]) }));
  const response = await moveItem(h, 'ocarry1|x');
  assert.equal(code(response), 'DOMAIN_LIMIT', JSON.stringify(response.body));
  assert.match(response.body.error.message, /rescheduled from Unfinished/);
  assert.equal(store.writes.length, 0);
});

test('day rules: an ended or cut-over day, a boundary-owned destination and a full Top 3 are refused; nothing written', async () => {
  // To an ended day (yesterday) and from an ended day.
  const ended = setup(legacyAccount({ [TODAY]: legacyRecord([products()]), [YESTERDAY]: { updatedAt: T0, updatedBy: 'phone', items: [kuryente()] } }));
  assert.equal(code(await moveItem(ended.h, 'p1', TODAY, YESTERDAY)), 'PAST_TARGET_IMMUTABLE');
  assert.equal(code(await moveItem(ended.h, 'p3', YESTERDAY, TODAY)), 'PAST_TARGET_IMMUTABLE');
  assert.equal(ended.store.writes.length, 0);
  // After the cutover every legacy day is history (DECISIONS #29), the destination included.
  const cutover = setup({ calendarPlanAuthority: { [FACT.id]: { ...FACT, activatedAtMs: NOW_MS - 60_000, activationDate: TODAY } }, plans: { [TODAY]: legacyRecord([products()]) } });
  assert.equal(code(await moveItem(cutover.h, 'p1')), 'PAST_TARGET_IMMUTABLE');
  assert.equal(cutover.store.writes.length, 0);
  // A Personal Day boundary from tomorrow 04:00: the day after tomorrow is an operational day, not plans/<that date>.
  const history = proposeBoundaryRevision([legacyBoundaryRevision(ZONE)], { id: 'boundary-0400', boundaryTime: '04:00', timezone: ZONE },
    NOW_MS + 3_600_000).revisions;
  const later = addCalendarDays(TODAY, 2);
  const boundary = setup(legacyAccount({ [TODAY]: legacyRecord([products()]) }, { dayBoundaryRevisions: Object.fromEntries(history.map(revision => [revision.id, revision])) }));
  assert.equal((await query(boundary.h, 'get_today', {})).plan.target.store, 'legacy', 'fixture: today is still legacy');
  assert.equal(code(await moveItem(boundary.h, 'p1', TODAY, later)), 'NOT_FOUND');
  assert.equal(boundary.store.writes.length, 0);
  // Priorities obey the destination's Top 3, exactly as the app's own move does.
  const priority = (id, title) => task(id, title, { kind: 'priority' });
  const full = setup(legacyAccount({ [TODAY]: legacyRecord([priority('q1', 'One more priority')]),
    [TOMORROW]: { updatedAt: T0, updatedBy: 'phone', items: [priority('a', 'A'), priority('b', 'B'), priority('c', 'C')] } }));
  const capped = await moveItem(full.h, 'q1');
  assert.equal(code(capped), 'DOMAIN_LIMIT');
  assert.match(capped.body.error.message, /Top 3 is already full/);
  assert.equal(full.store.writes.length, 0);
});

test('envelope: legacy <-> calendar, a retime, the same day and malformed ids are refused before any receipt', async () => {
  const { store, h } = setup(threeTasks());
  const rev = await revisionOf(h, 'p1');
  const refusals = [
    [{ target: legacy(TODAY), itemId: 'p1', destination: { store: 'calendar', id: `cal1:${TOMORROW}` } }, 'DOMAIN_LIMIT'],
    [{ target: { store: 'calendar', id: `cal1:${TODAY}` }, itemId: 'p1', destination: legacy(TOMORROW) }, 'DOMAIN_LIMIT'],
    [{ ...move('p1'), time: { when: '09:00', whenTz: ZONE } }, 'DOMAIN_LIMIT'],
    [{ ...move('p1'), durationMinutes: 30 }, 'DOMAIN_LIMIT'],
    [move('p1', TODAY, TODAY), 'INVALID_INPUT'],
    [{ target: legacy(TODAY), itemId: 'p1', destination: { store: 'legacy', id: '2026-02-30' } }, 'INVALID_INPUT'],
    [{ target: legacy(TODAY), itemId: 'p1', destination: { store: 'legacy', id: `${TOMORROW}/../x` } }, 'INVALID_INPUT'],
    [{ target: legacy(TODAY), itemId: 'p1', destination: { store: 'legacy', id: TOMORROW, roomId: 'uid_victim' } }, 'INVALID_INPUT'],
    [{ target: legacy(TODAY), itemId: 'p1', destination: { store: 'operational', id: `odv1:rev:${ZONE}:${TOMORROW}` } }, 'DOMAIN_LIMIT'],
  ];
  for (const [parameters, expected] of refusals) {
    const actionId = newAction();
    const response = await h.handle(command('plan_move', parameters, { actionId, expectedRevision: rev }));
    assert.equal(code(response), expected, JSON.stringify(parameters));
    assert.equal(h.infra.data.get(RECEIPT(actionId)), undefined, 'refused before a receipt exists');
  }
  assert.equal(store.writes.length, 0);
  // Edit and delete still refuse a legacy target.
  assert.equal(code(await h.handle(command('plan_edit', { target: legacy(TODAY), itemId: 'p1', title: 'x' }, { expectedRevision: rev }))), 'DOMAIN_LIMIT');
  assert.equal(code(await h.handle(command('plan_delete', { target: legacy(TODAY), itemId: 'p1' }, { expectedRevision: rev }))), 'DOMAIN_LIMIT');
});

test('stale or ambiguous: a stale revision, another item\'s revision, an absent or already-moved task are refused; nothing written', async () => {
  const { store, h } = setup(threeTasks());
  const p1 = await revisionOf(h, 'p1');
  const p2 = await revisionOf(h, 'p2');
  assert.equal(code(await h.handle(command('plan_move', move('p1'), { expectedRevision: p2 }))), 'STALE_REVISION');
  assert.equal(code(await h.handle(command('plan_move', move('nope'), { expectedRevision: p1 }))), 'NOT_FOUND');
  assert.equal(store.writes.length, 0);
  assert.equal((await moveItem(h, 'p1')).status, 200);
  // A second move from the old read (a duplicate request under a new action ID) never makes a second copy.
  const again = await h.handle(command('plan_move', move('p1'), { expectedRevision: p1 }));
  assert.equal(code(again), 'STALE_REVISION');
  assert.equal(store.writes.length, 1);
  assert.deepEqual(liveDays(store.room.plans).p1, [TOMORROW]);
});

test('a batch with one stale selection: the others move, the stale one stays put, the report is per task', async () => {
  const { store, h } = setup(threeTasks());
  const revisions = Object.fromEntries(await Promise.all(['p1', 'p2', 'p3'].map(async id => [id, await revisionOf(h, id)])));
  // The app edits p2 after ChatGPT listed the tasks.
  store.ownerLegacyRecord(TODAY, legacyRecord([products(), menu({ task: 'Make price menu (renamed)', updatedAt: T0 + 5 }), kuryente()]));
  const outcomes = {};
  for (const itemId of ['p1', 'p2', 'p3']) {
    const response = await h.handle(command('plan_move', move(itemId), { expectedRevision: revisions[itemId] }));
    outcomes[itemId] = response.status === 200 ? 'moved' : code(response);
  }
  assert.deepEqual(outcomes, { p1: 'moved', p2: 'STALE_REVISION', p3: 'moved' });
  assert.deepEqual(liveDays(store.room.plans), { p1: [TOMORROW], p2: [TODAY], p3: [TOMORROW] });
  assert.equal(stored(store, 'p2').task, 'Make price menu (renamed)', 'the app\'s edit stands');
});

test('concurrency: an app write to the other day or another item between read and write retries; to the same item is STALE', async () => {
  let raced = false;
  const other = setup(threeTasks(), {
    async beforeLegacyPlansPut() {
      if (raced) return;
      raced = true;
      other.store.ownerLegacyRecord(TODAY, legacyRecord([products(), menu({ done: true, doneAt: T0 + 5, updatedAt: T0 + 5 }), kuryente()]));
      other.store.ownerLegacyRecord(TOMORROW, { updatedAt: T0 + 5, updatedBy: 'laptop', items: [task('t1', 'Planned on the laptop')] });
    } });
  const response = await moveItem(other.h, 'p1');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(stored(other.store, 'p2').done, true, 'the concurrent completion is kept');
  assert.deepEqual(raw(other.store, TOMORROW).map(item => item.id), ['t1', 'p1'], 'the concurrent destination plan is kept');
  assert.equal(other.store.writes.filter(write => write.where === 'legacy-collection').length, 1);

  let renamed = false;
  const same = setup(threeTasks(), {
    async beforeLegacyPlansPut() {
      if (renamed) return;
      renamed = true;
      same.store.ownerLegacyRecord(TODAY, legacyRecord([products({ task: 'Renamed in the app', updatedAt: T0 + 5 }), menu(), kuryente()]));
    } });
  assert.equal(code(await moveItem(same.h, 'p1')), 'STALE_REVISION');
  assert.equal(stored(same.store, 'p1').task, 'Renamed in the app');
  assert.equal(stored(same.store, 'p1').deleted, undefined);
  assert.equal(same.store.room.plans[TOMORROW], undefined, 'no destination copy exists');
});

test('interrupted: a lost response and a crash after the write are proven APPLIED by takeover, never moved twice', async () => {
  let lose = true;
  const lost = setup(threeTasks(), { async afterLegacyPlansPut() { if (lose) { lose = false; throw new ApiError('RETRYABLE_TRANSPORT', 'lost'); } } });
  const response = await moveItem(lost.h, 'p1');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(lost.store.writes.length, 1);

  let crash = true;
  const crashed = setup(threeTasks(), { async afterLegacyPlansPut() { if (crash) { crash = false; throw new Error('process died'); } } });
  const rev = await revisionOf(crashed.h, 'p1');
  const actionId = newAction();
  assert.equal((await crashed.h.handle(command('plan_move', move('p1'), { actionId, expectedRevision: rev }))).status, 500);
  const retry = await harnessWithInfra(crashed.store, crashed.h.infra, NOW_MS + 31_000).handle(command('plan_move', move('p1'), { actionId, expectedRevision: rev }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(retry.body.result.destination, { store: 'legacy', id: TOMORROW, date: TOMORROW });
  assert.equal(crashed.store.writes.length, 1, 'proven from the planned revision, not re-applied');
  assert.equal(crashed.h.infra.data.get(RECEIPT(actionId)).state, 'applied');

  // A crash BEFORE the write: the takeover applies it exactly once.
  let early = true;
  const before = setup(threeTasks(), { async beforeLegacyPlansPut() { if (early) { early = false; throw new Error('process died'); } } });
  const earlyRev = await revisionOf(before.h, 'p1');
  const earlyAction = newAction();
  assert.equal((await before.h.handle(command('plan_move', move('p1'), { actionId: earlyAction, expectedRevision: earlyRev }))).status, 500);
  assert.equal(before.store.writes.length, 0);
  const resumed = await harnessWithInfra(before.store, before.h.infra, NOW_MS + 31_000).handle(command('plan_move', move('p1'), { actionId: earlyAction, expectedRevision: earlyRev }));
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(before.store.writes.length, 1);
  assert.deepEqual(liveDays(before.store.room.plans).p1, [TOMORROW]);
});

test('the app converges: its own legacy merge of stale local copies keeps the move on both days', async () => {
  const { store, h } = setup(threeTasks());
  const localToday = structuredClone(store.room.plans[TODAY]);
  assert.equal((await moveItem(h, 'p2')).status, 200);
  const mergedToday = mergeDatePlans(localToday, store.room.plans[TODAY], TODAY);
  const mergedTomorrow = mergeDatePlans({}, store.room.plans[TOMORROW], TOMORROW);
  for (const merged of [mergedToday, mergeDatePlans(store.room.plans[TODAY], localToday, TODAY)]) {
    assert.equal(merged.items.find(item => item.id === 'p2').deleted, true, 'the stale local live copy never wins over the move');
  }
  assert.deepEqual(liveDays({ [TODAY]: mergedToday, [TOMORROW]: mergedTomorrow }), { p1: [TODAY], p2: [TOMORROW], p3: [TODAY] });
});

test('a completed task keeps its completion when it is explicitly moved (the app\'s own move does the same)', async () => {
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([products({ done: true, doneAt: T0 + 1 })]) }));
  assert.equal((await moveItem(h, 'p1')).status, 200);
  assert.deepEqual([stored(store, 'p1', TOMORROW).done, stored(store, 'p1', TOMORROW).doneAt], [true, T0 + 1]);
});

test('emulator finding: a stored task with a duration but no start time moves exactly as stored (never re-judged)', async () => {
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([task('p2', 'Make price menu', { durationMinutes: 60 })]) }));
  const response = await moveItem(h, 'p2');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const moved = stored(store, 'p2', TOMORROW);
  assert.deepEqual([moved.when, moved.durationMinutes], ['', 60]);
});

test('review: a pre-fence Brain Dump array item (no origin) moves as the app moves it; only a fenced child is refused', async () => {
  const old = task('bdp1|cap_old001', 'Old Brain Dump task');
  const { store, h } = setup(legacyAccount({ [TODAY]: legacyRecord([old]) }));
  const response = await moveItem(h, old.id);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(liveDays(store.room.plans), { [old.id]: [TOMORROW] });
});

test('review: a rules refusal of the collection write is a definite CONFLICT that says nothing moved, not an access failure', async () => {
  const { store, h } = setup(threeTasks(), { async beforeLegacyPlansPut() { throw new ApiError('FORBIDDEN', 'ChronaSense account access was refused.'); } });
  const actionId = newAction();
  const response = await moveItem(h, 'p1', TODAY, TOMORROW, actionId);
  assert.equal(code(response), 'CONFLICT');
  assert.match(response.body.error.message, /Nothing was moved/);
  assert.equal(h.infra.data.get(RECEIPT(actionId)).state, 'rejected');
  assert.equal(store.writes.length, 0);
});
