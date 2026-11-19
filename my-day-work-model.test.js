// my-day-work-model.test.js — My Day Unified Command Center V1, "Today's work" tile (pure lines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './my-day-work-model.js';

const { workLines } = globalThis.MyDayWorkModel;
const text = lines => Object.fromEntries(lines.map(line => [line.key, line.text]));

test('every line names the My Day section that manages it (no separate window)', () => {
  assert.deepEqual(workLines().map(line => [line.key, line.target]),
    [['tasks', 'timeline-section'], ['learning', 'daily-routines'], ['sop', 'sop-execution']]);
});

test('sections that have not loaded say so instead of claiming zero', () => {
  assert.deepEqual(text(workLines()), { tasks: 'Tasks · loading…', learning: 'Learning · loading…', sop: 'Procedures · loading…' });
});

test('tasks: done over total, and an empty plan', () => {
  assert.equal(text(workLines({ tasks: { total: 4, done: 1 } })).tasks, 'Tasks · 1/4 done');
  assert.equal(text(workLines({ tasks: { total: 0, done: 0 } })).tasks, 'Tasks · none planned today');
});

test('learning: the next unfinished step, singular/plural, and all done', () => {
  const steps = [{ planTitle: 'Spanish', stepTitle: 'Verbs 1', complete: true }, { planTitle: 'Spanish', stepTitle: 'Verbs 2', complete: false }];
  assert.equal(text(workLines({ learning: steps })).learning, 'Learning · 1 step today · Next: Verbs 2');
  assert.equal(text(workLines({ learning: [...steps, { planTitle: 'Go', stepTitle: 'Joseki', complete: false }] })).learning,
    'Learning · 2 steps today · Next: Verbs 2');
  assert.equal(text(workLines({ learning: [steps[0]] })).learning, 'Learning · 1 step done today');
  assert.equal(text(workLines({ learning: [] })).learning, 'Learning · no learning step today');
});

test('procedures: complete runs over linked tasks, and none linked', () => {
  assert.equal(text(workLines({ sop: { linked: 2, complete: 1 } })).sop, 'Procedures · 1/2 SOP runs complete');
  assert.equal(text(workLines({ sop: { linked: 1, complete: 0 } })).sop, 'Procedures · 0/1 SOP run complete');
  assert.equal(text(workLines({ sop: { linked: 0, complete: 0 } })).sop, 'Procedures · no task linked to an SOP');
});


test('step titles are returned as plain text (the tile sets textContent, never innerHTML)', () => {
  const line = text(workLines({ learning: [{ planTitle: 'x', stepTitle: '<img src=x onerror=alert(1)>', complete: false }] })).learning;
  assert.ok(line.endsWith('<img src=x onerror=alert(1)>'), 'unchanged here; escaping is the renderer\'s job via textContent');
});

// SopUI.summary(): the read-only counts the tile shows for tasks and SOP runs.
import { emptySopState, createSop, upsertSop, linkSop, setStepChecked } from './sop-model.js';
import { createSopUi } from './sop-ui.js';

function sopUiWith(state) {
  let writes = 0;
  const repository = { read: () => state, update() { writes++; } };
  return { ui: createSopUi({ repository, root: () => null, refreshMyDay: () => {} }), writes: () => writes };
}

test('SopUI.summary is null until My Day has handed over its rows (tile says loading, not zero)', () => {
  assert.equal(sopUiWith(emptySopState()).ui.summary(), null);
});

test('SopUI.summary counts today\'s tasks and complete/linked SOP runs, ignoring commitments, without writing', () => {
  let n = 0;
  const sop = createSop('Close books', ['Export', 'Reconcile'], { now: 1, randomId: () => `id${n++}` });
  let state = linkSop(linkSop(upsertSop(emptySopState(), sop), 'pA', sop.id, 2), 'pB', sop.id, 3);
  state = setStepChecked(setStepChecked(state, 'pA', sop.steps[0].id, true, 4), 'pA', sop.steps[1].id, true, 5);
  const { ui, writes } = sopUiWith(state);
  ui.setMyDayTasks([
    { itemId: 'pA', dayId: 'd', title: 'A', done: true },
    { itemId: 'pB', dayId: 'd', title: 'B', done: false },
    { itemId: 'pC', dayId: 'd', title: 'C', done: false },
    { itemId: 'c1', dayId: 'd', title: 'Meeting', done: false, sourceType: 'commitment' },
  ], true);
  assert.deepEqual(ui.summary(), { tasks: { total: 3, done: 1 }, sop: { linked: 2, complete: 1 } });
  assert.equal(writes(), 0);
  assert.equal(text(workLines({ tasks: ui.summary().tasks, sop: ui.summary().sop })).sop, 'Procedures · 1/2 SOP runs complete');
});

test('SopUI.summary is null (loading) when SOP storage cannot be read, instead of claiming no links', () => {
  const repository = { read() { throw new Error('corrupt'); }, update() {} };
  const ui = createSopUi({ repository, root: () => null, refreshMyDay: () => {} });
  ui.setMyDayTasks([{ itemId: 'pA', dayId: 'd', title: 'A', done: false }], true);
  assert.equal(ui.summary(), null);
});
