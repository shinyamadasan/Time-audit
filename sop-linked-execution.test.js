import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOP_STORAGE_KEY, emptySopState, validateSopState, createSop, upsertSop, deleteSop,
  linkSop, unlinkSop, setStepChecked, sopRunView, pruneSopLinks, validPlanItemId
} from './sop-model.js';
import { createSopRepository, sopKeyForRoom } from './sop-repository.js';

const ids = () => { let n = 0; return () => `id${++n}`; };
const memory = () => { const map = new Map(); return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) }; };
const T = 1_800_000_000_000;
const withSop = () => {
  const sop = createSop('Weekly review', ['Clear inbox', 'Review calendar', 'Pick 3 priorities'], { now: T, randomId: ids() });
  return { sop, state: upsertSop(emptySopState(), sop) };
};

test('an SOP is an ordered checklist with stable step ids; blanks dropped; limits enforced', () => {
  const sop = createSop('  Morning reset ', ['Water', '  ', 'Stretch'], { now: T, randomId: ids() });
  assert.equal(sop.title, 'Morning reset');
  assert.deepEqual(sop.steps.map(s => s.text), ['Water', 'Stretch']);
  assert.throws(() => createSop('', ['x'], { now: T, randomId: ids() }), /title/);
  assert.throws(() => createSop('No steps', [], { now: T, randomId: ids() }), /1–50 steps/);
  assert.throws(() => createSop('Too many', Array.from({ length: 51 }, (_, i) => `s${i}`), { now: T, randomId: ids() }), /1–50 steps/);
  assert.throws(() => createSop('Long', ['x'.repeat(201)], { now: T, randomId: ids() }), /200/);
});

test('every existing plan item id shape can be linked (p…, bdp1|…, api1_…); junk cannot', () => {
  for (const id of ['plq3x9k2abcd', 'bdp1|cap_123-abc', 'api1_act-42']) assert.ok(validPlanItemId(id), id);
  for (const id of ['', 'a b', 'x'.repeat(81), '../etc', null]) assert.equal(validPlanItemId(id), false, String(id));
});

test('executing a linked task walks its SOP: progress, next step, completion', () => {
  const { sop, state } = withSop();
  let s = linkSop(state, 'pTask1', sop.id, T);
  let view = sopRunView(s, 'pTask1');
  assert.deepEqual([view.done, view.total, view.nextStep.text, view.complete], [0, 3, 'Clear inbox', false]);
  s = setStepChecked(s, 'pTask1', sop.steps[0].id, true, T + 1);
  s = setStepChecked(s, 'pTask1', sop.steps[1].id, true, T + 2);
  view = sopRunView(s, 'pTask1');
  assert.deepEqual([view.done, view.nextStep.text], [2, 'Pick 3 priorities']);
  s = setStepChecked(s, 'pTask1', sop.steps[2].id, true, T + 3);
  assert.equal(sopRunView(s, 'pTask1').complete, true);
  assert.equal(sopRunView(s, 'pTask1').nextStep, null);
  s = setStepChecked(s, 'pTask1', sop.steps[1].id, false, T + 4);
  assert.equal(sopRunView(s, 'pTask1').nextStep.text, 'Review calendar');
});

test('re-ticking keeps the first tick time; an unlinked item has no view and cannot be ticked', () => {
  const { sop, state } = withSop();
  let s = linkSop(state, 'pTask1', sop.id, T);
  s = setStepChecked(s, 'pTask1', sop.steps[0].id, true, T + 1);
  s = setStepChecked(s, 'pTask1', sop.steps[0].id, true, T + 99);
  assert.equal(s.runs.pTask1.checked[sop.steps[0].id], T + 1);
  assert.equal(sopRunView(s, 'pOther'), null);
  assert.throws(() => setStepChecked(s, 'pOther', sop.steps[0].id, true, T), /no SOP linked/);
  assert.throws(() => setStepChecked(s, 'pTask1', 'not-a-step', true, T), /no longer in this SOP/);
});

test('one SOP template, many independent runs (the same SOP on two tasks)', () => {
  const { sop, state } = withSop();
  let s = linkSop(linkSop(state, 'pMon', sop.id, T), 'pTue', sop.id, T);
  s = setStepChecked(s, 'pMon', sop.steps[0].id, true, T + 1);
  assert.equal(sopRunView(s, 'pMon').done, 1);
  assert.equal(sopRunView(s, 'pTue').done, 0);
});

test('re-linking to a different SOP starts fresh; re-linking the same SOP keeps progress; unlink clears', () => {
  const { sop, state } = withSop();
  const other = createSop('Packing', ['Passport'], { now: T, randomId: () => 'z' + Math.random().toString(36).slice(2, 8) });
  let s = upsertSop(linkSop(state, 'pTask1', sop.id, T), other);
  s = setStepChecked(s, 'pTask1', sop.steps[0].id, true, T + 1);
  assert.equal(sopRunView(linkSop(s, 'pTask1', sop.id, T + 2), 'pTask1').done, 1);
  const switched = linkSop(s, 'pTask1', other.id, T + 2);
  assert.equal(sopRunView(switched, 'pTask1').title, 'Packing');
  assert.equal(sopRunView(switched, 'pTask1').done, 0);
  const cleared = unlinkSop(s, 'pTask1');
  assert.equal(sopRunView(cleared, 'pTask1'), null);
  assert.equal(cleared.runs.pTask1, undefined);
});

test('editing an SOP mid-run: removed steps stop counting, added steps appear undone', () => {
  const { sop, state } = withSop();
  let s = linkSop(state, 'pTask1', sop.id, T);
  s = setStepChecked(s, 'pTask1', sop.steps[0].id, true, T + 1);
  const edited = { ...sop, steps: [sop.steps[1], { id: 'new1', text: 'Archive notes' }], updatedAt: T + 5 };
  s = upsertSop(s, edited);
  const view = sopRunView(s, 'pTask1');
  assert.deepEqual([view.done, view.total, view.nextStep.text], [0, 2, 'Review calendar']);
});

test('deleting an SOP removes its links and runs, nothing else', () => {
  const { sop, state } = withSop();
  const keep = createSop('Other', ['x'], { now: T, randomId: () => 'k' + Math.random().toString(36).slice(2, 8) });
  let s = upsertSop(linkSop(state, 'pA', sop.id, T), keep);
  s = linkSop(s, 'pB', keep.id, T);
  s = deleteSop(s, sop.id);
  assert.equal(s.links.pA, undefined);
  assert.equal(s.links.pB.sopId, keep.id);
  assert.throws(() => linkSop(s, 'pC', sop.id, T), /no longer exists/);
});

test('pruning drops links for plan items that no longer exist', () => {
  const { sop, state } = withSop();
  const s = pruneSopLinks(linkSop(linkSop(state, 'pLive', sop.id, T), 'pGone', sop.id, T), ['pLive', 'pUnlinked']);
  assert.deepEqual(Object.keys(s.links), ['pLive']);
});

test('model functions never mutate their input state', () => {
  const { sop, state } = withSop();
  const before = JSON.stringify(state);
  linkSop(state, 'pTask1', sop.id, T);
  assert.equal(JSON.stringify(state), before);
});

test('state validation rejects corrupt envelopes instead of guessing', () => {
  const { sop, state } = withSop();
  const s = linkSop(state, 'pTask1', sop.id, T);
  assert.throws(() => validateSopState({ ...s, schemaVersion: 2 }), /unsupported/);
  assert.throws(() => validateSopState({ ...s, links: { pX: { sopId: 'missing', linkedAt: T } } }), /Invalid SOP link/);
  assert.throws(() => validateSopState({ ...s, runs: { pNope: { sopId: sop.id, checked: {} } } }), /Invalid SOP run/);
  assert.throws(() => validateSopState({ ...s, sops: [sop, sop] }), /Duplicate SOP ID/);
});

test('repository: room-scoped, isolated per account, refuses writes with no owner', () => {
  const storage = memory();
  let owner = 'uid_alice';
  const repo = createSopRepository(storage, { getOwner: () => owner });
  const { sop } = withSop();
  repo.update(s => linkSop(upsertSop(s, sop), 'pTask1', sop.id, T));
  assert.ok(storage.map.has(sopKeyForRoom('uid_alice')));
  assert.equal(sopKeyForRoom('uid_alice'), `${SOP_STORAGE_KEY}:uid_alice`);
  owner = 'uid_bob';
  assert.deepEqual(repo.read(), emptySopState());
  owner = null;
  assert.deepEqual(repo.read(), emptySopState());
  assert.throws(() => repo.update(s => s), /No signed-in account/);
  owner = 'uid_alice';
  assert.equal(sopRunView(repo.read(), 'pTask1').total, 3);
});

test('repository: an invalid change is refused and nothing is written', () => {
  const storage = memory();
  const repo = createSopRepository(storage, { getOwner: () => 'uid_alice' });
  assert.throws(() => repo.update(s => ({ ...s, links: { pX: { sopId: 'missing', linkedAt: T } } })), /Invalid SOP link/);
  assert.equal(storage.map.size, 0);
});

// ── My Day execution-task helpers (sop-ui.js, pure parts) ────────────────────
import { runSummary, linkableTasks } from './sop-ui.js';

test('My Day run line: progress + next step, "All steps done" when complete, nothing when unlinked', () => {
  const { sop, state } = withSop();
  let s = linkSop(state, 'pTask1', sop.id, T);
  assert.equal(runSummary(sopRunView(s, 'pTask1')), 'SOP 0/3 · Next: Clear inbox');
  for (const step of sop.steps) s = setStepChecked(s, 'pTask1', step.id, true, T + 1);
  assert.equal(runSummary(sopRunView(s, 'pTask1')), 'SOP 3/3 · All steps done');
  assert.equal(runSummary(sopRunView(s, 'pRegular')), null);
});

test('only open, unlinked My Day tasks are offered for linking', () => {
  const { sop, state } = withSop();
  const s = linkSop(state, 'pLinked', sop.id, T);
  const tasks = [{ itemId: 'pLinked', done: false }, { itemId: 'pDone', done: true }, { itemId: 'pOpen', done: false }];
  assert.deepEqual(linkableTasks(tasks, s).map(t => t.itemId), ['pOpen']);
});
