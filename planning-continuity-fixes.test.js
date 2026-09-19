// planning-continuity-fixes.test.js
//
// Planning Continuity V1 — FIX FIRST regressions (model / authority level).
//
//   B2  a stale Move must respect the Top 3: a priority moved into a full Top 3 lands
//       as an Other planned task instead of becoming a 4th priority
//   B3  "Make task" / "Make priority": reclassify in place, same id, cap-enforced
//   B4  commitment duration values and explicit clearing of duration/note
//
// The browser halves (the notice copy, the buttons, the form) are in
// tests/planning-continuity.spec.js. In-memory storage, injected clocks.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlanAuthority } from './plan-authority.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { mergeOperationalPlanRecords } from './operational-plan-model.js';
import { planItemKind, activePriorityPlanItems } from './plan-tomorrow-model.js';
import { buildCommitment, updateCommitment, normalizeCommitment, mergeCommitmentRecords, validCommitmentDuration } from './commitments-model.js';
import { createCommitmentsRepository } from './commitments-repository.js';

const MANILA = 'Asia/Manila';
const manila = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const D = '2026-09-18';

const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

function legacyStore(seed = {}) {
  const plans = JSON.parse(JSON.stringify(seed));
  return {
    plans,
    record: k => plans[k] || null,
    rawItems: k => (plans[k]?.items || []).map(i => ({ ...i })),
    saveItems(k, items) { plans[k] = { ...(plans[k] || {}), items, updatedAt: 1000 }; },
    confirm: () => ({ localSaved: true, syncPromise: Promise.resolve(false) }),
    allPlans: () => plans,
    earliestPlanDate() { const ks = Object.keys(plans).sort(); return ks.length ? ks[0] : null; },
  };
}

let seq = 0;

function makeApp({ storage = memory(), planStorage = memory(), legacy = legacyStore(), deviceId = 'device-a' } = {}) {
  const nowRef = { value: manila('2026-09-01', '10:00') };
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage, idGenerator: () => `rev-${++seq}` });
  const planRepository = createOperationalPlanRepository({ storage: planStorage });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => nowRef.value, deviceId: () => deviceId, fallbackTimezone: () => MANILA,
  });
  const authority = createPlanAuthority({ live, legacy, now: () => nowRef.value, accountTimezone: () => MANILA });
  return { authority, live, legacy, planRepository, storage, planStorage, setNow: v => { nowRef.value = v; } };
}

/** An 18:00 boundary active from Sep 1, so every test day is operational-governed. */
function enabled(options) {
  const app = makeApp(options);
  if (!options?.storage || !options.storage.getItem('ta3-day-boundary-revisions-v1')) {
    app.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA });
  }
  app.setNow(manila(D, '20:00'));
  return app;
}

const item = (id, task, extra = {}) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'device-a', ...extra });
let clock = 10_000;
const stamp = value => ({ ...value, updatedAt: ++clock, updatedBy: 'device-a' });

/** A stale priority on yesterday's personal day, and today with `n` active priorities. */
function staleSetup(n, { staleKind = 'priority', options } = {}) {
  const app = enabled(options);
  app.setNow(manila('2026-09-17', '20:00'));
  const yesterday = app.authority.current();
  app.authority.saveItems(yesterday, [item('pstale', 'Slipped', staleKind === 'task' ? { kind: 'task' } : {})]);
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();
  app.authority.saveItems(today, Array.from({ length: n }, (_, i) => item(`ptoday${i}`, `Today ${i}`)));
  return { app, yesterday, today };
}

const movedCopy = (app, today) => app.authority.items(today).find(i => i.carriedFromId === 'pstale');

// ═══════════════════════════════════════════════════════════════════════
// B2 — stale Move respects the Top 3
// ═══════════════════════════════════════════════════════════════════════

for (const n of [0, 1, 2]) {
  test(`B2: a stale priority moved into a day with ${n} priorit${n === 1 ? 'y' : 'ies'} stays a priority`, () => {
    const { app, yesterday, today } = staleSetup(n);
    const result = app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'pstale', destination: today, stamp });
    assert.equal(result.moved, true);
    assert.equal(result.demoted, false);
    assert.equal(planItemKind(movedCopy(app, today)), 'priority');
    assert.equal(activePriorityPlanItems(app.authority.items(today)).length, n + 1);
  });
}

test('B2: a stale priority moved into a FULL Top 3 lands as an Other planned task', () => {
  const { app, yesterday, today } = staleSetup(3);
  const result = app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'pstale', destination: today, stamp });
  assert.equal(result.moved, true, 'recovery is not blocked by the cap');
  assert.equal(result.demoted, true, 'and the caller is told, so it can say so');
  const copy = movedCopy(app, today);
  assert.equal(planItemKind(copy), 'task');
  assert.equal(activePriorityPlanItems(app.authority.items(today)).length, 3, 'never a 4th priority');
  // Provenance and deterministic identity are unchanged by the demotion.
  assert.equal(copy.id, result.carryId);
  assert.equal(copy.carriedFromDayId, yesterday.id);
  // The original stays exactly as it was: still a priority, still not done.
  const original = app.authority.rawItems(yesterday).find(i => i.id === 'pstale');
  assert.equal(planItemKind(original), 'priority');
  assert.equal(original.done, false);
});

test('B2: a stale TASK stays a task whatever the destination holds', () => {
  for (const n of [0, 3]) {
    const { app, yesterday, today } = staleSetup(n, { staleKind: 'task' });
    const result = app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'pstale', destination: today, stamp });
    assert.equal(planItemKind(movedCopy(app, today)), 'task');
    assert.equal(result.demoted, false, 'a task was never a priority, so nothing was demoted');
  }
});

test('B2: a demoted move does not make the day ready or move the streak', () => {
  const { app, yesterday, today } = staleSetup(3);
  const before = { streak: app.authority.streak(), ready: app.authority.readyNow(today) };
  app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'pstale', destination: today, stamp });
  assert.deepEqual(app.authority.streak(), before.streak);
  assert.equal(app.authority.readyNow(today), before.ready);
});

test('B2: repeating the move is idempotent — still exactly one copy', () => {
  const { app, yesterday, today } = staleSetup(3);
  app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'pstale', destination: today, stamp });
  const again = app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'pstale', destination: today, stamp });
  assert.equal(again.moved, false);
  assert.equal(app.authority.items(today).filter(i => i.carriedFromId === 'pstale').length, 1);
});

test('B2: two devices moving to the same day converge on one copy', () => {
  // Device A sees a full Top 3 (demotes); device B saw a free slot (keeps priority).
  // Both devices share the SAME boundary revisions (as sync gives them), so they
  // resolve the same personal-day identities; their plan stores are separate.
  const sharedBoundary = memory();
  const a = staleSetup(3, { options: { storage: sharedBoundary } });
  const b = staleSetup(2, { options: { storage: sharedBoundary } });
  const ra = a.app.authority.moveStaleItem({ sourceTarget: a.yesterday, itemId: 'pstale', destination: a.today, stamp });
  const rb = b.app.authority.moveStaleItem({ sourceTarget: b.yesterday, itemId: 'pstale', destination: b.today, stamp });
  assert.equal(ra.carryId, rb.carryId, 'both devices mint the SAME deterministic id');
  const merged = mergeOperationalPlanRecords(a.app.authority.record(a.today), b.app.authority.record(b.today), a.today.id);
  const mergedAgain = mergeOperationalPlanRecords(b.app.authority.record(b.today), a.app.authority.record(a.today), a.today.id);
  const copies = merged.items.filter(i => i.carriedFromId === 'pstale');
  assert.equal(copies.length, 1, 'one copy after merge, never two');
  assert.deepEqual(copies, mergedAgain.items.filter(i => i.carriedFromId === 'pstale'), 'and merge order cannot change which');
});

test('B2: reload preserves the demoted kind', () => {
  const storage = memory();
  const planStorage = memory();
  const { app, yesterday, today } = staleSetup(3, { options: { storage, planStorage } });
  app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'pstale', destination: today, stamp });
  const reloaded = makeApp({ storage, planStorage });
  reloaded.setNow(manila(D, '20:00'));
  assert.equal(planItemKind(movedCopy(reloaded, reloaded.authority.current())), 'task');
});

test('B2: rescheduling into a full Top 3 also demotes', () => {
  const { app, yesterday, today } = staleSetup(0);
  const later = app.authority.dayAhead(3);
  app.authority.saveItems(later, [item('l1', 'a'), item('l2', 'b'), item('l3', 'c')]);
  app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'pstale', destination: today, stamp });
  const result = app.authority.rescheduleStaleItem({ sourceTarget: yesterday, itemId: 'pstale', destination: later, stamp });
  assert.equal(result.demoted, true);
  assert.equal(planItemKind(app.authority.items(later).find(i => i.carriedFromId === 'pstale')), 'task');
  assert.equal(activePriorityPlanItems(app.authority.items(later)).length, 3);
});

// ═══════════════════════════════════════════════════════════════════════
// B3 — Make task / Make priority
// ═══════════════════════════════════════════════════════════════════════

function todayWith(items) {
  const app = enabled();
  const target = app.authority.current();
  app.authority.saveItems(target, items);
  return { app, target };
}

test('B3: demote then promote returns the SAME item with every field intact', () => {
  const original = item('p1', 'Write report', { when: '09:00', durationMinutes: 90, planItemId: 'link-1', carriedFromId: 'older' });
  const { app, target } = todayWith([original]);

  const demoted = app.authority.setItemKind({ target, itemId: 'p1', kind: 'task', stamp });
  assert.equal(demoted.changed, true);
  const asTask = app.authority.items(target)[0];
  assert.equal(asTask.id, 'p1');
  assert.equal(planItemKind(asTask), 'task');

  app.authority.setItemKind({ target, itemId: 'p1', kind: 'priority', stamp });
  const back = app.authority.items(target)[0];
  assert.equal(back.id, 'p1', 'identity preserved');
  assert.ok(!('kind' in back), 'a priority is stored exactly as before — no residual kind');
  for (const field of ['task', 'when', 'durationMinutes', 'done', 'doneAt', 'planItemId', 'carriedFromId']) {
    assert.deepEqual(back[field], original[field], `${field} is preserved`);
  }
  assert.ok(back.updatedAt > original.updatedAt, 'the change is stamped so it syncs');
});

test('B3: done state and tracked linkage survive reclassification', () => {
  const { app, target } = todayWith([item('p1', 'Linked', { done: true, doneAt: 12345 })]);
  app.authority.setItemKind({ target, itemId: 'p1', kind: 'task', stamp });
  const t = app.authority.items(target)[0];
  assert.equal(t.done, true);
  assert.equal(t.doneAt, 12345);
  // Tracked entries link by planItemId === item.id; the id never changes, so the link holds.
  assert.equal(t.id, 'p1');
});

test('B3: demoting frees a Top 3 slot immediately', () => {
  const { app, target } = todayWith([item('p1', 'a'), item('p2', 'b'), item('p3', 'c'), item('t1', 'd', { kind: 'task' })]);
  assert.throws(() => app.authority.setItemKind({ target, itemId: 't1', kind: 'priority', stamp }), /Top 3 is already full/);
  app.authority.setItemKind({ target, itemId: 'p3', kind: 'task', stamp });
  app.authority.setItemKind({ target, itemId: 't1', kind: 'priority', stamp });
  assert.deepEqual(activePriorityPlanItems(app.authority.items(target)).map(i => i.id).sort(), ['p1', 'p2', 't1']);
});

test('B3: promoting into a full Top 3 is refused and changes nothing', () => {
  const items = [item('p1', 'a'), item('p2', 'b'), item('p3', 'c'), item('t1', 'd', { kind: 'task' })];
  const { app, target } = todayWith(items);
  const before = JSON.stringify(app.authority.rawItems(target));
  assert.throws(() => app.authority.setItemKind({ target, itemId: 't1', kind: 'priority', stamp }), /already full/);
  assert.equal(JSON.stringify(app.authority.rawItems(target)), before, 'no silent swap, no reorder');
});

test('B3: a tombstoned item cannot be reclassified', () => {
  const { app, target } = todayWith([item('gone', 'x', { kind: 'task', deleted: true })]);
  assert.throws(() => app.authority.setItemKind({ target, itemId: 'gone', kind: 'priority', stamp }), /was removed/);
  assert.throws(() => app.authority.setItemKind({ target, itemId: 'missing', kind: 'priority', stamp }), /no longer in this plan/);
  assert.throws(() => app.authority.setItemKind({ target, itemId: 'gone', kind: 'nope', stamp }), /Unknown plan item kind/);
});

test('B3: reclassifying to the same kind is a no-op, not a write', () => {
  const { app, target } = todayWith([item('p1', 'a')]);
  const before = app.authority.rawItems(target)[0].updatedAt;
  assert.equal(app.authority.setItemKind({ target, itemId: 'p1', kind: 'priority', stamp }).changed, false);
  assert.equal(app.authority.rawItems(target)[0].updatedAt, before);
});

test('B3: readiness follows the CURRENT kind of prepared items', () => {
  const app = enabled();
  const target = app.authority.current();
  app.authority.confirmPreparation(target, { items: [item('p1', 'only priority')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  assert.equal(app.authority.readyNow(target), true);
  app.authority.setItemKind({ target, itemId: 'p1', kind: 'task', stamp });
  assert.equal(app.authority.readyNow(target), false, 'a demoted priority no longer keeps the day ready');
  app.authority.setItemKind({ target, itemId: 'p1', kind: 'priority', stamp });
  assert.equal(app.authority.readyNow(target), true, 'and promoting it back restores readiness');
});

test('B3: reclassification works on a legacy calendar day too', () => {
  const legacy = legacyStore();
  const app = makeApp({ legacy });
  app.setNow(manila(D, '10:00'));
  const target = app.authority.current();
  assert.equal(target.store, 'legacy');
  app.authority.saveItems(target, [item('p1', 'legacy item')]);
  app.authority.setItemKind({ target, itemId: 'p1', kind: 'task', stamp });
  assert.equal(legacy.plans[target.dateKey].items[0].kind, 'task');
  assert.equal(legacy.plans[target.dateKey].items[0].id, 'p1');
});

// ═══════════════════════════════════════════════════════════════════════
// B4 — commitment duration values and explicit clearing
// ═══════════════════════════════════════════════════════════════════════

const T0 = manila('2026-09-18', '10:00');
const base = extra => buildCommitment({ id: 'cdentist', title: 'Dentist', date: '2026-09-30', time: '09:30', timezone: MANILA, now: T0, updatedBy: 'device-a', ...extra });

test('B4: common five-minute durations are all valid', () => {
  for (const minutes of [5, 15, 30, 45, 60, 90, 720]) {
    assert.equal(validCommitmentDuration(minutes), true, `${minutes} must be valid`);
    const built = base({ durationMinutes: minutes });
    assert.equal(built.ok, true, `${minutes} must build`);
    assert.equal(built.record.durationMinutes, minutes);
  }
});

test('B4: out-of-range and non-integer durations are refused', () => {
  for (const minutes of [0, -5, 721, 30.5, Number.NaN, '30']) {
    assert.equal(validCommitmentDuration(minutes), false, `${minutes} must be invalid`);
    assert.equal(base({ durationMinutes: minutes }).ok, false);
  }
});

test('B4: an explicit null CLEARS duration and note; undefined leaves them unchanged', () => {
  const full = base({ durationMinutes: 45, note: 'bring x-rays' }).record;
  const unchanged = updateCommitment(full, { title: 'Dentist!', now: T0 + 1000, updatedBy: 'device-b' }).record;
  assert.equal(unchanged.durationMinutes, 45, 'omitted means unchanged');
  assert.equal(unchanged.note, 'bring x-rays');

  const cleared = updateCommitment(full, { durationMinutes: null, note: null, now: T0 + 2000, updatedBy: 'device-b' }).record;
  assert.ok(!('durationMinutes' in cleared), 'duration cleared');
  assert.ok(!('note' in cleared), 'note cleared');
  assert.equal(cleared.id, full.id, 'same commitment');
  assert.equal(cleared.updatedAt, T0 + 2000);
  assert.equal(cleared.updatedBy, 'device-b');
  assert.ok(normalizeCommitment(cleared), 'the cleared record is fully valid');
});

test('B4: a cleared commitment converges and survives a reload', () => {
  const storage = memory();
  const repo = createCommitmentsRepository({ storage, now: () => T0, deviceId: () => 'device-a' });
  const created = repo.create({ id: 'cdentist', title: 'Dentist', date: '2026-09-30', time: '09:30', timezone: MANILA, durationMinutes: 60, note: 'x' });
  assert.equal(created.ok, true);
  const staleRemote = created.record; // another device still holds the old values
  const cleared = repo.update('cdentist', { durationMinutes: null, note: null, now: T0 + 5000 });
  assert.equal(cleared.ok, true);

  const merged = mergeCommitmentRecords(staleRemote, cleared.record);
  assert.ok(!('durationMinutes' in merged) && !('note' in merged), 'the later clear wins the merge');
  assert.deepEqual(mergeCommitmentRecords(cleared.record, staleRemote), merged, 'in either order');

  const reloaded = createCommitmentsRepository({ storage, now: () => T0, deviceId: () => 'device-a' });
  const after = reloaded.read('cdentist');
  assert.ok(!('durationMinutes' in after) && !('note' in after), 'still cleared after reload');
});
