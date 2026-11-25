import {test} from 'node:test';
import assert from 'node:assert/strict';
import './meal-ready-food.js';
import './household-my-day-model.js';
import {buildSharedPayload, validateSharedPayload} from './shared-accountability-model.js';
import {buildPartnerViewProjection, validatePartnerViewProjection} from './partner-view-model.js';

const M = globalThis.HouseholdMyDayModel;
const nowMs = Date.parse('2026-11-25T18:00:00Z');
const tasks = Array.from({length: 6}, (_, i) => ({id: `t${i}`, title: `Task ${i}`, done: i === 0, when: i === 1 ? '17:00' : null}));

// Build exactly what the partner's client publishes, round-trip it through JSON
// (RTDB drops empty arrays), then validate it the way storage.js does.
function shared({dateKey = '2026-11-25', timezone = 'America/Phoenix', updatedAt = nowMs - 3600000, ...rest} = {}) {
  const dailyTasks = 'dailyTasks' in rest ? rest.dailyTasks : tasks;
  const raw = JSON.parse(JSON.stringify({
    ...buildSharedPayload({displayName: 'Alyssa', timezone, dateKey, updatedAt, todayItems: []}),
    partnerView: buildPartnerViewProjection({dateKey, priorities: [], dailyTasks})
  }));
  return {summary: validateSharedPayload(raw), view: validatePartnerViewProjection(raw.partnerView)};
}
const partner = (overrides = {}) => M.partner({linked: true, readState: 'received', nowMs, ...shared(), ...overrides});

test('partner: the full opted-in daily list is shown (more than three tasks), read through the real publish/validate path', () => {
  const view = partner();
  assert.equal(view.state, 'ready');
  assert.equal(view.name, 'Alyssa');
  assert.equal(view.items.length, 6);
  assert.deepEqual(view.items[1], {id: 't1', title: 'Task 1', done: false, when: '17:00', status: 'Not started'});
  assert.equal(view.items[0].status, 'Done');
});

test('partner: an hour-old publish on the same day is current (publishing is event driven, not periodic)', () => {
  assert.equal(partner({...shared({updatedAt: nowMs - 6 * 3600000})}).state, 'ready');
});

test('partner: day is judged in the publisher timezone, not the viewer timezone', () => {
  assert.equal(partner({...shared({dateKey: '2026-11-26', timezone: 'Asia/Manila'})}).state, 'ready');
  assert.equal(partner({...shared({dateKey: '2026-11-25', timezone: 'Asia/Manila'})}).state, 'stale');
});

test('partner: not linked, loading, refused, unpublished, yesterday, not opted in and malformed never show tasks', () => {
  assert.deepEqual(M.partner({linked: false, nowMs}), {state: 'not-linked'});
  assert.deepEqual(partner({readState: 'loading'}), {state: 'loading'});
  assert.deepEqual(partner({readState: undefined}), {state: 'loading'});
  assert.deepEqual(partner({readState: 'denied'}), {state: 'unavailable'});
  assert.deepEqual(partner({summary: null, view: null}), {state: 'not-published'});
  const stale = partner({...shared({dateKey: '2026-11-24'})});
  assert.equal(stale.state, 'stale'); assert.equal(stale.items, undefined);
  const off = partner({...shared({dailyTasks: undefined})});
  assert.equal(off.state, 'not-shared'); assert.equal(off.items, undefined);
  assert.equal(partner({...shared({updatedAt: nowMs + 3600000})}).state, 'error');
  const bad = shared(); bad.view.today.dailyTasks = [{id: 'a', title: 'x', done: false}, {id: 'a', title: 'dup', done: false}];
  assert.equal(partner(bad).state, 'error');
  const badTz = shared(); badTz.summary.publisher.timezone = 'Not/AZone';
  assert.equal(partner(badTz).state, 'error');
});

test('partner: shared but nothing planned is an honest empty list', () => {
  const view = partner({...shared({dailyTasks: []})});
  assert.equal(view.state, 'ready'); assert.deepEqual(view.items, []);
});

// ── FOOD — the real Meal Prep users/{uid} document shape ────────────────────
const doc = () => ({updatedAt: '2026-11-25T17:00:00.000Z', pantry: [
  {id: 'p1', name: 'Rice', quantity: 2, unit: 'kg'},
  {id: 'p2', name: 'Eggs', quantity: 6, unit: 'pieces'},
  {id: 'p3', name: 'Used up', quantity: 0, unit: 'g'},
  {id: 'p4', name: 'Salt'}
], cookedMeals: [
  {name: 'Fresh meal', cookedDate: '2026-11-25', fridgeLife: 3, portionsRemaining: 4},
  {name: 'Eat today', cookedDate: '2026-11-22', fridgeLife: 3, portionsRemaining: 1},
  {name: 'Expired', cookedDate: '2026-11-20', fridgeLife: 2, portionsRemaining: 3},
  {name: 'Finished', cookedDate: '2026-11-25', fridgeLife: 3, portionsRemaining: 0},
  {name: 'Unknown portions', cookedDate: '2026-11-25', fridgeLife: 3},
  {name: 'Frozen soup', cookedDate: '2026-11-24', storage: 'freezer', freezerLife: 30, portionsRemaining: 2}
]});
const food = (overrides = {}) => M.food({state: 'ready', exists: true, fromCache: false, today: '2026-11-25', doc: doc(), ...overrides});

test('food: Meal Prep ready-food projection excludes depleted and expired, ranks use-soon first, keeps unknown portions unknown', () => {
  const view = food();
  assert.equal(view.state, 'ready');
  assert.deepEqual(view.meals.map(m => m.name), ['Eat today', 'Fresh meal', 'Unknown portions', 'Frozen soup']);
  assert.deepEqual(view.meals[0], {name: 'Eat today', storage: 'fridge', portions: 1, daysLeft: 0});
  assert.equal(view.meals[2].portions, null);
});

test('food: pantry ingredients are separate, sorted, used-up items removed, missing quantity stays unknown', () => {
  assert.deepEqual(food().ingredients, [
    {name: 'Eggs', quantity: '6 pieces'}, {name: 'Rice', quantity: '2 kg'}, {name: 'Salt', quantity: 'Quantity unknown'}]);
});

test('food: every non-ready source state and every invalid document shows no food', () => {
  for (const state of ['not-configured', 'signed-out', 'loading', 'mismatch', 'refused', 'error'])
    assert.deepEqual(M.food({state}), {state});
  assert.deepEqual(food({fromCache: true}), {state: 'stale'});
  assert.deepEqual(food({exists: false, doc: null}), {state: 'no-account-data'});
  assert.deepEqual(food({today: 'bad'}), {state: 'error'});
  assert.deepEqual(food({doc: {cookedMeals: 'x'}}), {state: 'error'});
  assert.deepEqual(food({doc: {cookedMeals: [{name: 'x', storage: 'garage'}]}}), {state: 'error'});
  assert.deepEqual(food({doc: {cookedMeals: [{name: 'x', fridgeLife: -1}]}}), {state: 'error'});
  assert.deepEqual(food({doc: {pantry: [null]}}), {state: 'error'});
});

test('food: a document with no food recorded is an authoritative empty kitchen', () => {
  const view = food({doc: {pantry: [], cookedMeals: []}});
  assert.equal(view.state, 'ready'); assert.deepEqual([view.meals, view.ingredients], [[], []]);
});
