// planning-capacity.test.js
//
// Planning Continuity V1 — "3" is a PRIORITIZATION limit, not a PLANNING limit.
//
// These tests pin the three things that make that safe:
//   1. `kind` is additive and absent-means-priority, so every item already
//      persisted keeps its exact bytes, id and behaviour with no migration.
//   2. The 3-cap is measured on active TOP PRIORITIES only; secondary planned
//      tasks are uncapped.
//   3. Readiness / Day Prepared / Planning Streak are fed from priorities only,
//      so they cannot be inflated by adding secondary tasks (or commitments,
//      which are never plan items at all).
//
// Everything runs against in-memory storage and an injected clock: no real
// Firebase project, no network, no production data.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_ITEM_KINDS, planItemKind, isPriorityPlanItem, isSecondaryPlanItem,
  priorityPlanItems, secondaryPlanItems, activePriorityPlanItems, withPlanItemKind,
  planningStreak, normalizePreparation, computeReadyNow,
} from './plan-tomorrow-model.js';
import { createPlanAuthority } from './plan-authority.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';

const MANILA = 'Asia/Manila';
const manila = (dateStr, hhmm) => Date.parse(`${dateStr}T${hhmm}:00+08:00`);
const D = '2026-09-16';

const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

const item = (id, task, extra = {}) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'device-a', ...extra });
const priority = (id, task, extra = {}) => item(id, task, extra);
const secondary = (id, task, extra = {}) => item(id, task, { kind: 'task', ...extra });

let seq = 0;

/** index.html's plans[dateKey] path, with the SAME priorities-only preparation
 *  rule confirmPreparedDatePlan applies in production. */
function legacyStore(seed = {}) {
  const plans = JSON.parse(JSON.stringify(seed));
  return {
    plans,
    record: dateKey => plans[dateKey] || null,
    rawItems: dateKey => (plans[dateKey]?.items || []).map(i => ({ ...i })),
    saveItems(dateKey, items) { plans[dateKey] = { ...(plans[dateKey] || {}), items, updatedAt: 1000, updatedBy: 'legacy-device' }; },
    confirm(input) {
      const activePriorities = activePriorityPlanItems(input.items);
      if (activePriorities.length > 3) throw new Error('Reduce the plan to 3 priorities before confirming.');
      const hasAction = activePriorities.some(i => !i.done) || input.actionableRoutineInstanceIds.length > 0;
      if (!hasAction && input.intentionalBlank !== true) throw new Error('Add one priority, keep a routine, or choose Open day.');
      const preparation = {
        schemaVersion: 1, targetDate: input.targetDate, timezone: MANILA,
        firstPreparedAt: 1000, firstPreparedBy: 'legacy-device', firstPreparedMode: input.mode,
        lastPreparedAt: 1000, lastPreparedMode: input.mode, updatedBy: 'legacy-device',
        intentionalBlank: !hasAction && input.intentionalBlank === true,
        routineInstanceIds: input.routineInstanceIds,
        oneOffItemIds: activePriorities.map(i => i.id),
      };
      plans[input.targetDate] = { ...(plans[input.targetDate] || {}), items: input.items, preparation, updatedAt: 1000 };
      return { localSaved: true, syncPromise: Promise.resolve(false) };
    },
    allPlans: () => plans,
    earliestPlanDate() { const k = Object.keys(plans).sort(); return k.length ? k[0] : null; },
  };
}

function makeApp({ clock = manila(D, '08:00'), legacy = legacyStore(), storage = memory(), planStorage = memory() } = {}) {
  const nowRef = { value: clock };
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage, idGenerator: () => `rev-${++seq}` });
  const planRepository = createOperationalPlanRepository({ storage: planStorage });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => nowRef.value, deviceId: () => 'device-a', fallbackTimezone: () => MANILA,
  });
  const authority = createPlanAuthority({ live, legacy, now: () => nowRef.value, accountTimezone: () => MANILA });
  return { authority, live, legacy, planRepository, boundaryRepository, setNow: v => { nowRef.value = v; } };
}

function enableBoundary(app, { boundaryTime = '18:00', timezone = MANILA } = {}) {
  app.live.proposeBoundary({ boundaryTime, timezone });
  return app;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. kind: additive, absent-means-priority, no migration
// ═══════════════════════════════════════════════════════════════════════

test('absent kind is a priority — every item already persisted keeps its meaning', () => {
  assert.equal(planItemKind(item('p1', 'a')), 'priority');
  assert.equal(planItemKind({}), 'priority');
  assert.equal(planItemKind(null), 'priority');
  assert.equal(planItemKind(undefined), 'priority');
  assert.ok(isPriorityPlanItem(item('p1', 'a')));
  assert.ok(!isSecondaryPlanItem(item('p1', 'a')));
});

test('only the literal string "task" is secondary — corrupt values fall back to priority', () => {
  assert.equal(planItemKind({ kind: 'task' }), 'task');
  for (const bad of ['Task', 'TASK', 'priority', 'other', '', 0, 1, true, null, {}, []]) {
    assert.equal(planItemKind({ kind: bad }), 'priority', `kind=${JSON.stringify(bad)} must fall back to priority`);
  }
  assert.deepEqual([...PLAN_ITEM_KINDS], ['priority', 'task']);
});

test('withPlanItemKind round-trips to the EXACT original stored shape', () => {
  const original = item('p1', 'ship it', { when: '09:00', durationMinutes: 60 });
  const asTask = withPlanItemKind(original, 'task');
  assert.equal(asTask.kind, 'task');
  const backToPriority = withPlanItemKind(asTask, 'priority');
  // No residual key: a priority is represented by ABSENCE, exactly once.
  assert.ok(!('kind' in backToPriority));
  assert.deepEqual(backToPriority, original);
  assert.throws(() => withPlanItemKind(original, 'nope'), /Unknown plan item kind/);
});

test('kind filters do not also filter tombstones — the two questions stay separate', () => {
  const items = [priority('p1', 'a'), secondary('s1', 'b'), priority('p2', 'c', { deleted: true }), secondary('s2', 'd', { deleted: true })];
  assert.deepEqual(priorityPlanItems(items).map(i => i.id), ['p1', 'p2']);
  assert.deepEqual(secondaryPlanItems(items).map(i => i.id), ['s1', 's2']);
  assert.deepEqual(activePriorityPlanItems(items).map(i => i.id), ['p1']);
  assert.deepEqual(priorityPlanItems(null), []);
  assert.deepEqual(secondaryPlanItems('nope'), []);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. capacity: 3 priorities, unlimited secondary tasks
// ═══════════════════════════════════════════════════════════════════════

test('exactly 3 active priorities confirm; a 4th is refused, never silently dropped', () => {
  const app = enableBoundary(makeApp(), {});
  app.setNow(manila(D, '20:00'));
  const target = app.authority.current();
  assert.equal(target.store, 'operational');

  const three = [priority('p1', 'a'), priority('p2', 'b'), priority('p3', 'c')];
  const ok = app.authority.confirmPreparation(target, { items: three, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  assert.equal(ok.localSaved, true);
  assert.equal(app.authority.preparation(target).oneOffItemIds.length, 3);

  const four = [...three, priority('p4', 'd')];
  assert.throws(
    () => app.authority.confirmPreparation(target, { items: four, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] }),
    /Reduce the plan to 3 priorities/,
  );
  // Refused means REFUSED: the stored plan is untouched, nothing was dropped.
  assert.equal(app.authority.items(target).length, 3);
});

test('a tombstoned priority frees a slot; a done priority still occupies one', () => {
  const app = enableBoundary(makeApp(), {});
  app.setNow(manila(D, '20:00'));
  const target = app.authority.current();
  const items = [priority('p1', 'a', { deleted: true }), priority('p2', 'b', { done: true }), priority('p3', 'c'), priority('p4', 'd')];
  // 3 active (p2 done still counts), so this confirms.
  const res = app.authority.confirmPreparation(target, { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  assert.equal(res.localSaved, true);
  assert.deepEqual(app.authority.preparation(target).oneOffItemIds, ['p2', 'p3', 'p4']);
});

test('12 secondary tasks alongside 3 priorities are all stored — no cap on plan capacity', () => {
  const app = enableBoundary(makeApp(), {});
  app.setNow(manila(D, '20:00'));
  const target = app.authority.current();
  const items = [
    priority('p1', 'a'), priority('p2', 'b'), priority('p3', 'c'),
    ...Array.from({ length: 12 }, (_, n) => secondary(`s${n}`, `task ${n}`)),
  ];
  const res = app.authority.confirmPreparation(target, { items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  assert.equal(res.localSaved, true);
  const stored = app.authority.items(target);
  assert.equal(stored.length, 15);
  assert.equal(activePriorityPlanItems(stored).length, 3);
  assert.equal(secondaryPlanItems(stored).length, 12);
  // ...and the cap still refuses a 4th priority even with 12 tasks present.
  assert.throws(
    () => app.authority.confirmPreparation(target, { items: [...items, priority('p4', 'd')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [] }),
    /Reduce the plan to 3 priorities/,
  );
});

test('the injected cap is the authority-level rule, not a UI-only convention', () => {
  const app = makeApp();
  assert.equal(app.authority.priorityMax(), 3);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. non-inflation: secondary tasks cannot buy readiness or streak
// ═══════════════════════════════════════════════════════════════════════

test('secondary tasks alone cannot make a day prepared — an intention is still required', () => {
  const app = enableBoundary(makeApp(), {});
  app.setNow(manila(D, '20:00'));
  const target = app.authority.current();
  const onlyTasks = [secondary('s1', 'laundry'), secondary('s2', 'emails'), secondary('s3', 'tidy')];
  assert.throws(
    () => app.authority.confirmPreparation(target, { items: onlyTasks, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] }),
    /Add one priority, keep a routine, or choose Open day/,
  );
});

test('an Open Day stays an Open Day even with secondary tasks on it', () => {
  const app = enableBoundary(makeApp(), {});
  app.setNow(manila(D, '20:00'));
  const target = app.authority.current();
  const res = app.authority.confirmPreparation(target, {
    items: [secondary('s1', 'laundry'), secondary('s2', 'emails')],
    mode: 'normal', intentionalBlank: true, routineInstanceIds: [],
  });
  assert.equal(res.localSaved, true);
  const prep = app.authority.preparation(target);
  assert.equal(prep.intentionalBlank, true, 'secondary tasks must not cancel an explicit Open Day');
  assert.deepEqual(prep.oneOffItemIds, [], 'secondary tasks never enter preparation');
  // The tasks themselves are still really there — absence from preparation is not deletion.
  assert.equal(app.authority.items(target).length, 2);
});

test('readyNow ignores secondary tasks and tracks only priorities', () => {
  const app = enableBoundary(makeApp(), {});
  app.setNow(manila(D, '20:00'));
  const target = app.authority.current();
  app.authority.confirmPreparation(target, {
    items: [priority('p1', 'ship'), secondary('s1', 'laundry')],
    mode: 'normal', intentionalBlank: false, routineInstanceIds: [],
  });
  assert.equal(app.authority.readyNow(target), true);

  // Completing the only PRIORITY exhausts the day even though a task remains.
  const items = app.authority.rawItems(target).map(i => (i.id === 'p1' ? { ...i, done: true, updatedAt: 2000 } : i));
  app.authority.saveItems(target, items);
  assert.equal(app.authority.readyNow(target), false, 'an unfinished secondary task must not keep the day "ready"');
});

test('adding secondary tasks to a prepared day does not extend the Planning Streak', () => {
  const app = enableBoundary(makeApp(), {});
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();
  const tomorrow = app.authority.upcoming();

  // Prepare tomorrow ahead with a real priority -> today earns its habit day.
  app.authority.confirmPreparation(tomorrow, { items: [priority('p1', 'ship')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  const withPriority = app.authority.streak();
  assert.equal(withPriority.todayEarned, true);

  // Now pile secondary tasks onto today. The streak must not move.
  app.authority.saveItems(today, [secondary('s1', 'a'), secondary('s2', 'b'), secondary('s3', 'c'), secondary('s4', 'd')]);
  const after = app.authority.streak();
  assert.deepEqual(after, withPriority, 'secondary tasks must not change any streak number');
});

test('a day holding ONLY secondary tasks earns its predecessor nothing', () => {
  const app = enableBoundary(makeApp(), {});
  app.setNow(manila(D, '20:00'));
  const tomorrow = app.authority.upcoming();
  // Write secondary tasks WITHOUT confirming (no preparation at all).
  app.authority.saveItems(tomorrow, [secondary('s1', 'a'), secondary('s2', 'b')]);
  assert.equal(app.authority.streak().todayEarned, false);
  assert.equal(app.authority.preparation(tomorrow), null, 'writing items is not preparing a day');
});

// ═══════════════════════════════════════════════════════════════════════
// 4. legacy compatibility — identical results, no migration
// ═══════════════════════════════════════════════════════════════════════

test('a legacy account with kind-less plans produces the SAME streak it always did', () => {
  // Built by the shipped planningStreak() with no kind field anywhere: this is
  // the historical result, and it must not move.
  const prep = (date, ids) => ({
    schemaVersion: 1, targetDate: date, timezone: MANILA,
    firstPreparedAt: manila(date, '00:00') - 3600000, firstPreparedBy: 'd', firstPreparedMode: 'normal',
    lastPreparedAt: manila(date, '00:00') - 3600000, lastPreparedMode: 'normal', updatedBy: 'd',
    intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ids,
  });
  const plans = {
    '2026-09-14': { items: [item('a1', 'a')], preparation: prep('2026-09-14', ['a1']) },
    '2026-09-15': { items: [item('b1', 'b')], preparation: prep('2026-09-15', ['b1']) },
    '2026-09-16': { items: [item('c1', 'c')], preparation: prep('2026-09-16', ['c1']) },
  };
  const expected = planningStreak(plans, manila(D, '08:00'), MANILA);

  // Same account routed through the authority layer (never enabled a boundary).
  const app = makeApp({ legacy: legacyStore(plans) });
  assert.deepEqual(app.authority.streak(), expected, 'legacy streak must be the existing function, unchanged');
  assert.ok(expected.current >= 1, 'sanity: the fixture really does have a streak to preserve');
});

test('legacy kind-less items keep their ids, shape and cap behaviour', () => {
  const app = makeApp();
  const target = app.authority.current();
  assert.equal(target.store, 'legacy');
  const legacyItems = [item('old1', 'a'), item('old2', 'b'), item('old3', 'c')];
  app.authority.saveItems(target, legacyItems);
  const read = app.authority.items(target);
  assert.deepEqual(read, legacyItems, 'stored bytes are untouched — no kind field written, no id rewritten');
  assert.equal(activePriorityPlanItems(read).length, 3, 'all pre-existing items are priorities');
});

test('an over-cap legacy plan that arrived from a synced device still loads and is never truncated', () => {
  // The pre-existing "more priorities arrived from synced devices" case.
  const plans = { [D]: { items: [item('a', '1'), item('b', '2'), item('c', '3'), item('d', '4')] } };
  const app = makeApp({ legacy: legacyStore(plans) });
  const target = app.authority.current();
  assert.equal(app.authority.items(target).length, 4, 'nothing is dropped on read');
  assert.equal(activePriorityPlanItems(app.authority.items(target)).length, 4);
});

test('preparation and readiness are unchanged for a kind-less prepared legacy day', () => {
  const targetDate = D;
  const preparation = {
    schemaVersion: 1, targetDate, timezone: MANILA,
    firstPreparedAt: 1000, firstPreparedBy: 'd', firstPreparedMode: 'normal',
    lastPreparedAt: 1000, lastPreparedMode: 'normal', updatedBy: 'd',
    intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['x1'],
  };
  const plan = { items: [item('x1', 'a')], preparation };
  // The shipped helpers, called directly, still see exactly what they always saw.
  assert.ok(normalizePreparation(preparation, targetDate));
  assert.equal(computeReadyNow({ plan, targetDate, routines: [] }), true);

  const app = makeApp({ legacy: legacyStore({ [targetDate]: plan }) });
  const target = app.authority.current();
  assert.equal(app.authority.readyNow(target), true);
  assert.equal(app.authority.preparedState(target).prepared, true);
});
