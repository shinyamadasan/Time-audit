// plan-action-item.test.js
//
// TASK-011 (DECISIONS #37): an Action API-created calendar plan item (`api1_<uuid>`, immutable
// `creationActionId`) is location-bound exactly like a fenced Brain Dump item. First the pure contract
// (plan-item-origin.js), then the REAL calendar Plan Authority stack against the compiled firebase.rules.json
// (targaryen): the server-created item appears in the owner's one plan array, ordinary edits/completion/
// delete reach its keyed child with the marker intact, a move is refused, a stale device cannot resurrect
// it, and concurrent ordinary edits of the plan record never touch it (or vice versa).

import test from 'node:test';
import assert from 'node:assert/strict';
import targaryen from 'targaryen';
import { readFileSync } from 'node:fs';

import {
  ACTION_PLAN_ITEM_MOVE_REFUSED, BRAIN_DUMP_MOVE_REFUSED, actionPlanItemIdFor, fencedItemsOf, fencedMoveRefusal, foldFencedItems,
  isActionPlanItem, isActionPlanItemId, isFencedItem, mergeFencedItem, partitionOutboundItemsWith, splitFencedItems,
} from './plan-item-origin.js';
import { createPlanAuthority } from './plan-authority.js';
import { mergeCalendarPlanRecords } from './calendar-plan-model.js';
import { rulesEnforcingDatabase } from './brain-dump-test-support.js';
import { MON_ID, SUN, SUN_ID, fencedFor, makeFenceApp } from './fence-scenarios.js';

const RULES = JSON.parse(readFileSync(new URL('./firebase.rules.json', import.meta.url), 'utf8'));
const ACTION = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const OTHER_ACTION = 'act1_1c9a2d3e-4f5a-4b6c-9d7e-8f9012a3b4c5';
const ITEM_ID = 'api1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const FENCE_AT = `rooms/uid_A/calendarPlanFences/${SUN_ID}/${ITEM_ID}`;
const actionItem = (extra = {}) => ({
  id: ITEM_ID, task: 'Gym', when: '18:00', whenTz: 'Asia/Manila', durationMinutes: 60, done: false,
  updatedAt: 5, updatedBy: 'actor1:x', kind: 'task', creationActionId: ACTION, ...extra,
});
const choose = (a, b) => mergeCalendarPlanRecords({ items: [a] }, { items: [b] }, SUN_ID).items[0];

test('contract: only an api1_<uuid> item whose marker is exactly its own action is an Action API item', () => {
  assert.equal(actionPlanItemIdFor(ACTION), ITEM_ID);
  assert.equal(isActionPlanItemId(ITEM_ID), true);
  assert.equal(isActionPlanItem(actionItem()), true);
  assert.equal(isFencedItem(actionItem()), true, 'location-bound: it belongs at a keyed fence child');
  const not = {
    'no marker': actionItem({ creationActionId: undefined }),
    'another action\'s marker': actionItem({ creationActionId: OTHER_ACTION }),
    'uppercase id': actionItem({ id: ITEM_ID.toUpperCase() }),
    'non-v4 uuid': actionItem({ id: 'api1_0b8f1c2e-3d4a-1b5c-8d6e-7f8091a2b3c4', creationActionId: 'act1_0b8f1c2e-3d4a-1b5c-8d6e-7f8091a2b3c4' }),
    'marker on an ordinary id': { id: 'p123', task: 'x', creationActionId: ACTION },
    'malformed marker': actionItem({ creationActionId: 'act1_x' }),
  };
  for (const [why, item] of Object.entries(not)) {
    assert.equal(isActionPlanItem(item), false, why);
    assert.equal(isFencedItem(item), false, `${why}: never upgraded to a fenced item`);
  }
  for (const bad of [undefined, null, 'act1_nope', `act1_${'0'.repeat(36)}`, ITEM_ID]) assert.equal(actionPlanItemIdFor(bad), null);
});

test('contract: split/fold/keyed snapshot treat it like any location-bound item, independent of array order', () => {
  const ordinary = { id: 'pzzz', task: 'ordinary', when: '', done: false, updatedAt: 1, updatedBy: 'd' };
  const { ordinary: kept, fenced } = splitFencedItems([ordinary, actionItem()]);
  assert.deepEqual(kept.map(i => i.id), ['pzzz']);
  assert.deepEqual(fenced.map(i => i.id), [ITEM_ID], 'never written into the plan record array');
  assert.deepEqual(fencedItemsOf({ [ITEM_ID]: actionItem() }).map(i => i.id), [ITEM_ID]);
  assert.deepEqual(fencedItemsOf({ wrongKey: actionItem() }), [], 'the key must be the id');
  assert.deepEqual(fencedItemsOf({ [ITEM_ID]: actionItem({ creationActionId: OTHER_ACTION }) }), [], 'a mismatched marker is not folded in');
  const a = foldFencedItems([ordinary], [actionItem()], choose).items;
  const b = foldFencedItems([], [actionItem()], choose).items;
  assert.deepEqual(a.find(i => i.id === ITEM_ID), b[0], 'identity and content do not depend on what else (or in what order) the array holds');
  assert.deepEqual(partitionOutboundItemsWith([actionItem()], () => null), { kept: [actionItem()], superseded: [] }, 'the Brain Dump queue guard never withholds it');
});

test('contract: merge keeps the tombstone monotonic and the attributed copy authoritative', () => {
  const live = actionItem({ updatedAt: 99, task: 'newer but stale' });
  const tomb = actionItem({ deleted: true, updatedAt: 10 });
  assert.equal(mergeFencedItem(live, tomb, choose).deleted, true);
  assert.equal(mergeFencedItem(tomb, live, choose).deleted, true, 'order-independent');
  const unmarked = { ...actionItem({ updatedAt: 999 }), creationActionId: undefined };
  assert.equal(mergeFencedItem(unmarked, actionItem(), choose).creationActionId, ACTION, 'an unattributed same-id copy never wins');
  assert.equal(mergeFencedItem(actionItem(), unmarked, choose).creationActionId, ACTION);
  assert.equal(mergeFencedItem(actionItem({ task: 'a', updatedAt: 6 }), actionItem({ task: 'b', updatedAt: 7 }), choose).task, 'b', 'ordinary fields: the store\'s own choice');
});

test('contract: each location-bound kind has its own refusal copy', () => {
  assert.equal(fencedMoveRefusal(actionItem()), ACTION_PLAN_ITEM_MOVE_REFUSED);
  assert.equal(ACTION_PLAN_ITEM_MOVE_REFUSED, "Tasks added from ChatGPT can't be moved to another day yet.");
  assert.equal(fencedMoveRefusal(fencedFor({ id: SUN_ID })), BRAIN_DUMP_MOVE_REFUSED);
});

function device(db, deviceId = 'phone') {
  return makeFenceApp({ createPlanAuthority, db, deviceId });
}

test('end to end: a server-created item appears in the plan, and owner edits/completion/delete reach ITS child with the marker intact', async () => {
  const db = rulesEnforcingDatabase({ targaryen, rules: RULES, uid: 'A' });
  db.seed(FENCE_AT, actionItem());
  const app = device(db);
  const today = app.authority.current();
  assert.equal(today.id, SUN_ID);
  const seen = app.authority.items(today).find(i => i.id === ITEM_ID);
  assert.ok(seen, 'the keyed child is folded into the one local plan array');
  assert.equal(seen.creationActionId, ACTION);

  app.authority.updateItem({ sourceTarget: today, itemId: ITEM_ID, changes: { task: 'Gym (legs)', when: '19:00', durationMinutes: 45 }, stamp: app.stamp });
  await app.calendarSync.pushPlan(SUN_ID);
  let server = db.read(FENCE_AT);
  assert.equal(server.task, 'Gym (legs)');
  assert.equal(server.when, '19:00');
  assert.equal(server.whenTz, 'Asia/Manila', 'the item-owned zone is kept for a same-plan retime in the account zone');
  assert.equal(server.creationActionId, ACTION, 'the marker survives an ordinary edit');
  assert.equal((db.read(`rooms/uid_A/calendarPlans/${SUN_ID}`)?.items || []).some(i => i?.id === ITEM_ID), false, 'never copied into the plan record');

  app.authority.updateItem({ sourceTarget: today, itemId: ITEM_ID, changes: { done: true, doneAt: app.clock.now }, stamp: app.stamp });
  await app.calendarSync.pushPlan(SUN_ID);
  assert.equal(db.read(FENCE_AT).done, true, 'completion is an ordinary edit of the same item');

  app.authority.saveItems(today, app.authority.rawItems(today).map(i => (i.id === ITEM_ID ? app.stamp({ ...i, deleted: true }) : i)));
  await app.calendarSync.pushPlan(SUN_ID);
  server = db.read(FENCE_AT);
  assert.equal(server.deleted, true, 'delete is a tombstone at the child');
  assert.equal(server.creationActionId, ACTION);
  assert.deepEqual(db.denials, [], 'every owner write was accepted by the real rules');
});

test('end to end: moving it to another day is refused before anything is written', async () => {
  const db = rulesEnforcingDatabase({ targaryen, rules: RULES, uid: 'A' });
  db.seed(FENCE_AT, actionItem());
  const app = device(db);
  const today = app.authority.current();
  const tomorrow = app.authority.upcoming();
  assert.equal(tomorrow.id, MON_ID);
  const before = JSON.stringify(app.calendarRepository.listAllRaw());
  assert.throws(() => app.authority.updateItem({ sourceTarget: today, itemId: ITEM_ID, destination: tomorrow, changes: {}, stamp: app.stamp }),
    { message: ACTION_PLAN_ITEM_MOVE_REFUSED });
  assert.equal(JSON.stringify(app.calendarRepository.listAllRaw()), before, 'no source tombstone, no destination copy');
});

test('end to end: a stale device cannot resurrect a deleted item; concurrent ordinary plan edits and the item never collide', async () => {
  const db = rulesEnforcingDatabase({ targaryen, rules: RULES, uid: 'A' });
  db.seed(FENCE_AT, actionItem());
  const phone = device(db, 'phone');
  const laptop = device(db, 'laptop');
  const today = phone.authority.current();
  // Laptop holds a live copy and goes offline (no listeners, no pushes); phone deletes.
  laptop.state.online = false;
  laptop.calendarSync.detachPlans();
  phone.authority.saveItems(today, phone.authority.rawItems(today).map(i => (i.id === ITEM_ID ? phone.stamp({ ...i, deleted: true }) : i)));
  await phone.calendarSync.pushPlan(SUN_ID);
  // Laptop edits its stale live copy later (newer updatedAt), adds an ordinary task, and reconnects.
  laptop.clock.now += 60_000;
  laptop.authority.updateItem({ sourceTarget: today, itemId: ITEM_ID, changes: { task: 'stale rename' }, stamp: laptop.stamp });
  laptop.authority.addItem({ destination: today, item: { id: 'plaptop1', task: 'laptop task', when: '', done: false, doneAt: null, updatedAt: laptop.clock.now, updatedBy: 'laptop', kind: 'task' } });
  laptop.state.online = true;
  await laptop.calendarSync.pushPlan(SUN_ID);
  const server = db.read(FENCE_AT);
  assert.equal(server.deleted, true, 'the tombstone stays authoritative');
  assert.equal(server.creationActionId, ACTION);
  assert.ok(db.read(`rooms/uid_A/calendarPlans/${SUN_ID}`).items.some(i => i.id === 'plaptop1'), 'the unrelated ordinary edit landed');
  assert.deepEqual(db.denials, [], 'convergence needed no denied write');
  assert.equal(laptop.calendarRepository.read(SUN).items.find(i => i.id === ITEM_ID).deleted, true, 'the stale device converged locally too');
});

test('end to end: an ordinary owner client cannot fabricate one (Plan Authority refuses; the rules refuse a bypass; the plan record is unaffected)', async () => {
  const db = rulesEnforcingDatabase({ targaryen, rules: RULES, uid: 'A' });
  const app = device(db);
  const today = app.authority.current();
  const tomorrow = app.authority.upcoming();
  assert.throws(() => app.authority.addItem({ destination: today, item: actionItem({ updatedAt: app.clock.now }) }), { message: ACTION_PLAN_ITEM_MOVE_REFUSED },
    'the saveItems funnel never introduces an Action API item into a plan');
  db.seed(FENCE_AT, actionItem());
  assert.throws(() => app.authority.saveItems(tomorrow, [...app.authority.rawItems(tomorrow), actionItem()]), { message: ACTION_PLAN_ITEM_MOVE_REFUSED },
    'nor copies one it holds into another plan');
  db.seed(FENCE_AT, null);
  // A buggy or hostile client that bypasses Plan Authority entirely is refused by the server.
  app.calendarRepository.write(SUN, [...app.calendarRepository.read(SUN).items.filter(i => i.id !== ITEM_ID), actionItem({ updatedAt: app.clock.now }),
    { id: 'pfine1', task: 'fine', when: '', done: false, doneAt: null, updatedAt: app.clock.now, updatedBy: 'phone', kind: 'task' }], { updatedBy: 'phone', now: app.clock.now });
  const result = await app.calendarSync.pushPlan(SUN_ID);
  assert.equal(result.outcome, 'fence-denied');
  assert.equal(db.read(FENCE_AT), null, 'no attributed item exists');
  assert.ok(db.read(`rooms/uid_A/calendarPlans/${SUN_ID}`).items.some(i => i.id === 'pfine1'), 'ordinary items still sync');
});
