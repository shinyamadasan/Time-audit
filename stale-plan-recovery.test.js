// stale-plan-recovery.test.js
//
// Planning Continuity V1 — "Unfinished from previous days".
//
// The user-visible failure being fixed: an unfinished planned task from several
// days earlier was effectively inaccessible — it could not be edited and could not
// be moved back into the current day. Reconnaissance traced this to five
// mechanisms, none of which was item identity (the records were always intact):
// mutation paths gated on isViewingToday(), history rendered read-only, the only
// carry affordance scoped to authority.current(), Prepared Plans covering the
// operational store only with no actions, and date navigation capped at 14 days back.
//
// These tests pin the recovery contract, including the parts that are easy to get
// wrong: no second active copy, no rewritten history, no infinite carry, and
// nothing becoming unreachable because it is old or because the boundary moved.
//
// In-memory storage, injected clocks, explicit timezones.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISMISSED_FIELD, CARRIED_FROM_DAY_FIELD,
  itemIsRecoverable, findMoveDestination, collectStaleUnfinished,
  buildMovedItem, buildDismissedItem, buildUndismissedItem, describeStaleAge,
} from './stale-plan-recovery-model.js';
import { createPlanAuthority, OPERATIONAL_CARRY_ID_PREFIX } from './plan-authority.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { planItemKind } from './plan-tomorrow-model.js';

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

function makeApp({ clock = manila(D, '20:00'), storage = memory(), planStorage = memory(), legacy = legacyStore() } = {}) {
  const nowRef = { value: clock };
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage, idGenerator: () => `rev-${++seq}` });
  const planRepository = createOperationalPlanRepository({ storage: planStorage });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => nowRef.value, deviceId: () => 'device-a', fallbackTimezone: () => MANILA,
  });
  const authority = createPlanAuthority({ live, legacy, now: () => nowRef.value, accountTimezone: () => MANILA });
  return {
    authority, live, legacy, planRepository, boundaryRepository, storage, planStorage,
    setNow: v => { nowRef.value = v; },
    now: () => nowRef.value,
  };
}

/** Enables the boundary with an EARLY activation instant, so every day the tests
 *  then write to is genuinely operational-governed. A revision activates at the next
 *  occurrence of its own boundary time AFTER the proposal, so proposing at the test's
 *  "now" would leave the days before that activation legacy-governed — correct
 *  behaviour, but not what these tests are exercising. */
function enable(app, boundaryTime = '18:00') {
  const restore = app.now ? app.now() : null;
  app.setNow(manila('2026-09-01', '10:00'));
  app.live.proposeBoundary({ boundaryTime, timezone: MANILA });
  if (restore !== null) app.setNow(restore);
  else app.setNow(manila(D, '20:00'));
  return app;
}

const item = (id, task, extra = {}) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'device-a', ...extra });

/** index.html's stampPlanItemMutation, as the authority's callers inject it. */
let stampClock = 5000;
const stamp = value => ({ ...value, updatedAt: ++stampClock, updatedBy: 'device-a' });

const target = (store, id, endMs, startMs = endMs - 86400000) => ({ store, id, endMs, startMs, ...(store === 'legacy' ? { dateKey: id } : { operationalDayId: id }) });

// ═══════════════════════════════════════════════════════════════════════
// 1. pure projection: what counts as stale
// ═══════════════════════════════════════════════════════════════════════

test('an unfinished, undeleted, undismissed item on an ENDED day is stale', () => {
  const day = target('legacy', '2026-09-15', manila('2026-09-16', '00:00'));
  const { items } = collectStaleUnfinished({
    nowMs: manila(D, '20:00'),
    days: [{ target: day, record: { items: [item('p1', 'slipped')] } }],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].item.id, 'p1');
  assert.equal(items[0].sourceDayId, '2026-09-15');
  assert.equal(items[0].store, 'legacy');
});

test('a day that has NOT ended yet contributes nothing — it is not "previous"', () => {
  const today = target('operational', 'odv1:r:Asia/Manila:2026-09-18', manila('2026-09-19', '18:00'));
  const { items } = collectStaleUnfinished({
    nowMs: manila(D, '20:00'),
    days: [{ target: today, record: { items: [item('p1', 'in progress')] } }],
  });
  assert.deepEqual(items, []);
});

test('done, deleted and dismissed items are all excluded', () => {
  const day = target('legacy', '2026-09-15', manila('2026-09-16', '00:00'));
  const { items } = collectStaleUnfinished({
    nowMs: manila(D, '20:00'),
    days: [{ target: day, record: { items: [
      item('done', 'finished', { done: true, doneAt: manila('2026-09-15', '10:00') }),
      item('gone', 'removed', { deleted: true }),
      item('nope', 'abandoned', { [DISMISSED_FIELD]: manila('2026-09-16', '09:00') }),
      item('live', 'still open'),
    ] } }],
  });
  assert.deepEqual(items.map(r => r.item.id), ['live']);
  assert.equal(itemIsRecoverable(item('x', 'y', { done: true })), false);
  assert.equal(itemIsRecoverable(item('x', 'y', { deleted: true })), false);
  assert.equal(itemIsRecoverable(item('x', 'y', { [DISMISSED_FIELD]: 1 })), false);
  assert.equal(itemIsRecoverable(item('x', 'y')), true);
  assert.equal(itemIsRecoverable(null), false);
});

test('stale items are ordered most-recently-ended first', () => {
  const nowMs = manila(D, '20:00');
  const days = [
    { target: target('legacy', '2026-08-01', manila('2026-08-02', '00:00')), record: { items: [item('old', 'six weeks')] } },
    { target: target('legacy', '2026-09-17', manila('2026-09-18', '00:00')), record: { items: [item('recent', 'yesterday')] } },
    { target: target('legacy', '2026-09-10', manila('2026-09-11', '00:00')), record: { items: [item('mid', 'a week')] } },
  ];
  assert.deepEqual(collectStaleUnfinished({ nowMs, days }).items.map(r => r.item.id), ['recent', 'mid', 'old']);
});

test('a day with an unresolvable interval is REPORTED, never dropped', () => {
  const broken = { store: 'operational', id: 'odv1:missing-rev:Asia/Manila:2026-09-10', startMs: null, endMs: null };
  const { items, unresolvable } = collectStaleUnfinished({
    nowMs: manila(D, '20:00'),
    days: [{ target: broken, record: { items: [item('p1', 'orphaned by a lost revision')] } }],
  });
  assert.deepEqual(items, []);
  assert.equal(unresolvable.length, 1, 'nothing becomes unreachable just because its revision cannot be resolved');
  assert.deepEqual(unresolvable[0].items.map(i => i.id), ['p1']);
});

test('an already-moved item is not offered again', () => {
  const sourceDay = target('legacy', '2026-09-15', manila('2026-09-16', '00:00'));
  const dayRecords = {
    '2026-09-15': { items: [item('p1', 'slipped')] },
    '2026-09-17': { items: [item('carry:x', 'slipped', { carriedFromId: 'p1', [CARRIED_FROM_DAY_FIELD]: '2026-09-15' })] },
  };
  const { items } = collectStaleUnfinished({
    nowMs: manila(D, '20:00'),
    days: [{ target: sourceDay, record: dayRecords['2026-09-15'] }],
    dayRecords,
  });
  assert.deepEqual(items, []);
  assert.deepEqual(findMoveDestination('p1', '2026-09-15', dayRecords), { dayId: '2026-09-17', itemId: 'carry:x', item: dayRecords['2026-09-17'].items[0] });
});

test('a TOMBSTONED destination copy does not count as moved — the task resurfaces', () => {
  const dayRecords = {
    '2026-09-15': { items: [item('p1', 'slipped')] },
    '2026-09-17': { items: [item('carry:x', 'slipped', { carriedFromId: 'p1', [CARRIED_FROM_DAY_FIELD]: '2026-09-15', deleted: true })] },
  };
  assert.equal(findMoveDestination('p1', '2026-09-15', dayRecords), null);
});

test('provenance matching requires the source DAY when the copy records one', () => {
  const dayRecords = {
    '2026-09-17': { items: [item('carry:x', 't', { carriedFromId: 'p1', [CARRIED_FROM_DAY_FIELD]: 'some-other-day' })] },
  };
  assert.equal(findMoveDestination('p1', '2026-09-15', dayRecords), null, 'a same-id item from a different day is not a match');
  // A legacy copy with no recorded day still matches on item id alone.
  const older = { '2026-09-17': { items: [item('carry:y', 't', { carriedFromId: 'p1' })] } };
  assert.ok(findMoveDestination('p1', '2026-09-15', older));
});

test('collectStaleUnfinished refuses a missing clock rather than guessing', () => {
  assert.throws(() => collectStaleUnfinished({ days: [] }), /valid current instant/);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. discovery across both stores, at any age
// ═══════════════════════════════════════════════════════════════════════

test('yesterday, 3 days ago and weeks ago are ALL discoverable', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  // Write plans into three past personal days by addressing them from a past clock.
  const written = [];
  for (const [dayStr, taskName] of [['2026-09-17', 'yesterday'], ['2026-09-15', 'three days ago'], ['2026-08-20', 'weeks ago']]) {
    app.setNow(manila(dayStr, '20:00'));
    const t = app.authority.current();
    app.authority.saveItems(t, [item(`p-${taskName.replace(/ /g, '')}`, taskName)]);
    written.push(t.id);
  }
  app.setNow(manila(D, '20:00'));
  const { items } = app.authority.staleUnfinished();
  const tasks = items.map(r => r.item.task);
  for (const expected of ['yesterday', 'three days ago', 'weeks ago']) {
    assert.ok(tasks.includes(expected), `${expected} must stay discoverable; got ${JSON.stringify(tasks)}`);
  }
  assert.equal(new Set(written).size, 3, 'sanity: three distinct personal days');
});

test('a LEGACY stale task (pre-boundary day) is discoverable — both stores are scanned', () => {
  const legacy = legacyStore({ '2026-09-10': { items: [item('leg1', 'legacy slipped')] } });
  const app = enable(makeApp({ legacy }));
  app.setNow(manila(D, '20:00'));
  // ...and an operational one too.
  app.setNow(manila('2026-09-17', '20:00'));
  app.authority.saveItems(app.authority.current(), [item('op1', 'operational slipped')]);
  app.setNow(manila(D, '20:00'));

  const { items } = app.authority.staleUnfinished();
  const byStore = Object.fromEntries(items.map(r => [r.item.id, r.store]));
  assert.equal(byStore.leg1, 'legacy', 'the legacy plan store is covered');
  assert.equal(byStore.op1, 'operational', 'and so is the operational store');
});

test('a completed historical task never appears as stale', () => {
  const legacy = legacyStore({
    '2026-09-10': { items: [
      item('finished', 'did it', { done: true, doneAt: manila('2026-09-10', '15:00') }),
      item('open', 'did not'),
    ] },
  });
  const app = makeApp({ legacy });
  app.setNow(manila(D, '20:00'));
  assert.deepEqual(app.authority.staleUnfinished().items.map(r => r.item.id), ['open']);
});

test('secondary tasks are recoverable too, and keep their kind', () => {
  const legacy = legacyStore({
    '2026-09-10': { items: [item('p1', 'a priority'), item('s1', 'a secondary task', { kind: 'task' })] },
  });
  const app = makeApp({ legacy });
  app.setNow(manila(D, '20:00'));
  const { items } = app.authority.staleUnfinished();
  assert.deepEqual(items.map(r => [r.item.id, r.kind]).sort(), [['p1', 'priority'], ['s1', 'task']]);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. moving: exactly one copy, provenance preserved, history intact
// ═══════════════════════════════════════════════════════════════════════

test('unfinished yesterday -> move to today: one copy, original untouched', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-17', '20:00'));
  const yesterday = app.authority.current();
  app.authority.saveItems(yesterday, [item('p1', 'slipped')]);

  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();
  assert.notEqual(today.id, yesterday.id);

  const result = app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'p1', destination: today, stamp });
  assert.equal(result.moved, true);

  // Exactly one active copy, on today.
  const todayItems = app.authority.items(today);
  assert.equal(todayItems.length, 1);
  assert.equal(todayItems[0].task, 'slipped');
  assert.equal(todayItems[0].done, false);
  assert.ok(todayItems[0].id.startsWith(OPERATIONAL_CARRY_ID_PREFIX), 'the destination id is the deterministic carry id');

  // Provenance points back, and the ORIGINAL is untouched.
  assert.equal(todayItems[0].carriedFromId, 'p1');
  assert.equal(todayItems[0][CARRIED_FROM_DAY_FIELD], yesterday.id);
  const originals = app.authority.items(yesterday);
  assert.equal(originals.length, 1);
  assert.equal(originals[0].id, 'p1');
  assert.equal(originals[0].done, false, 'history is not rewritten to pretend it was done');
  assert.equal(originals[0].deleted, undefined, 'nor to pretend it was never planned');
});

test('the moved task stops being offered as stale, and says where it went', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-17', '20:00'));
  const yesterday = app.authority.current();
  app.authority.saveItems(yesterday, [item('p1', 'slipped')]);
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();

  assert.equal(app.authority.staleUnfinished().items.length, 1);
  app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'p1', destination: today, stamp });
  assert.deepEqual(app.authority.staleUnfinished().items, [], 'no longer stale once recovered');
  const where = app.authority.staleMoveDestination('p1', yesterday.id);
  assert.equal(where.dayId, today.id);
});

test('moving the SAME task twice to the same day is idempotent — never two copies', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-17', '20:00'));
  const yesterday = app.authority.current();
  app.authority.saveItems(yesterday, [item('p1', 'slipped')]);
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();

  const first = app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'p1', destination: today, stamp });
  const second = app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'p1', destination: today, stamp });
  assert.equal(first.moved, true);
  assert.equal(second.moved, false, 'the second call is a no-op, not a duplicate');
  assert.equal(app.authority.items(today).length, 1);
});

test('moving an already-moved task to a DIFFERENT day is refused; reschedule re-targets it', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-17', '20:00'));
  const yesterday = app.authority.current();
  app.authority.saveItems(yesterday, [item('p1', 'slipped')]);
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();
  const later = app.authority.dayAhead(5);

  app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'p1', destination: today, stamp });
  assert.throws(
    () => app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'p1', destination: later, stamp }),
    /already been moved/,
  );

  // Reschedule tombstones the old copy and writes the new one.
  app.authority.rescheduleStaleItem({ sourceTarget: yesterday, itemId: 'p1', destination: later, stamp });
  assert.equal(app.authority.items(today).length, 0, 'the old destination copy is gone (tombstoned)');
  assert.equal(app.authority.rawItems(today).filter(i => i.deleted).length, 1, 'tombstoned, not hard-removed');
  assert.equal(app.authority.items(later).length, 1);
  assert.equal(app.authority.items(later)[0].carriedFromId, 'p1');
  // Still exactly one active copy anywhere.
  assert.equal(app.authority.staleMoveDestination('p1', yesterday.id).dayId, later.id);
});

test('a stale task can be moved to an arbitrary FUTURE personal day', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-10', '20:00'));
  const old = app.authority.current();
  app.authority.saveItems(old, [item('p1', 'do it eventually')]);
  app.setNow(manila(D, '20:00'));

  const future = app.authority.dayAhead(21);
  app.authority.moveStaleItem({ sourceTarget: old, itemId: 'p1', destination: future, stamp });
  assert.deepEqual(app.authority.items(future).map(i => i.task), ['do it eventually']);
  assert.equal(app.authority.items(app.authority.current()).length, 0, 'today was not touched');
});

test('a LEGACY stale task moves into the current 18:00 personal day', () => {
  const legacy = legacyStore({ '2026-09-10': { items: [item('leg1', 'legacy slipped')] } });
  const app = enable(makeApp({ legacy }));
  app.setNow(manila(D, '20:00'));
  const source = app.authority.targetById('2026-09-10');
  assert.equal(source.store, 'legacy');
  const today = app.authority.current();
  assert.equal(today.store, 'operational');

  const result = app.authority.moveStaleItem({ sourceTarget: source, itemId: 'leg1', destination: today, stamp });
  assert.equal(result.moved, true);
  const moved = app.authority.items(today);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].carriedFromId, 'leg1');
  assert.equal(moved[0][CARRIED_FROM_DAY_FIELD], '2026-09-10');
  // The legacy record keeps its own item, unchanged.
  assert.deepEqual(legacy.plans['2026-09-10'].items.map(i => i.id), ['leg1']);
  assert.equal(legacy.plans['2026-09-10'].items[0].done, false);
});

test('a moved secondary task stays secondary; a moved priority stays a priority', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-17', '20:00'));
  const yesterday = app.authority.current();
  app.authority.saveItems(yesterday, [item('p1', 'priority'), item('s1', 'secondary', { kind: 'task' })]);
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();

  app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'p1', destination: today, stamp });
  app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 's1', destination: today, stamp });
  const kinds = app.authority.items(today).map(i => [i.carriedFromId, planItemKind(i)]).sort();
  assert.deepEqual(kinds, [['p1', 'priority'], ['s1', 'task']]);
});

test('moving out of a day that has NOT ended is refused — that is the ordinary carry flow', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();
  app.authority.saveItems(today, [item('p1', 'still today')]);
  const tomorrow = app.authority.upcoming();
  assert.throws(
    () => app.authority.moveStaleItem({ sourceTarget: today, itemId: 'p1', destination: tomorrow, stamp }),
    /has not ended yet/,
  );
});

test('a done or removed task cannot be moved', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-17', '20:00'));
  const yesterday = app.authority.current();
  app.authority.saveItems(yesterday, [
    item('done', 'finished', { done: true, doneAt: manila('2026-09-17', '10:00') }),
    item('gone', 'removed', { deleted: true }),
  ]);
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();
  assert.throws(() => app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'done', destination: today, stamp }), /already done/);
  assert.throws(() => app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'gone', destination: today, stamp }), /was removed/);
  assert.throws(() => app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'nope', destination: today, stamp }), /no longer on its original day/);
});

test('moving does not auto-carry: nothing moves without an explicit call', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-15', '20:00'));
  const old = app.authority.current();
  app.authority.saveItems(old, [item('p1', 'left alone')]);

  // Three days pass with no action at all.
  app.setNow(manila(D, '20:00'));
  assert.equal(app.authority.items(app.authority.current()).length, 0, 'no automatic carry-forward');
  assert.equal(app.authority.items(app.authority.upcoming()).length, 0);
  // It is still discoverable — that is the point.
  assert.equal(app.authority.staleUnfinished().items.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. dismissal
// ═══════════════════════════════════════════════════════════════════════

test('a dismissed stale item stops resurfacing, without claiming completion', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-15', '20:00'));
  const old = app.authority.current();
  app.authority.saveItems(old, [item('p1', 'not doing this')]);
  app.setNow(manila(D, '20:00'));

  assert.equal(app.authority.staleUnfinished().items.length, 1);
  app.authority.dismissStaleItem({ sourceTarget: old, itemId: 'p1', stamp });
  assert.deepEqual(app.authority.staleUnfinished().items, []);

  const stored = app.authority.rawItems(old).find(i => i.id === 'p1');
  assert.ok(Number.isFinite(stored[DISMISSED_FIELD]), 'abandonment is recorded');
  assert.equal(stored.done, false, 'but completion is NOT claimed');
  assert.equal(stored.doneAt, null);
  assert.equal(stored.deleted, undefined, 'and the task is not deleted from its day');
});

test('dismissal can be undone, restoring the exact previous shape', () => {
  const original = item('p1', 'maybe');
  const dismissed = buildDismissedItem(original, { nowMs: 9999, stamp });
  assert.equal(dismissed[DISMISSED_FIELD], 9999);
  const undone = buildUndismissedItem(dismissed, { stamp });
  assert.ok(!(DISMISSED_FIELD in undone), 'the field is removed, not set to null');
  assert.equal(undone.task, 'maybe');
});

test('undismissing through the authority makes the task discoverable again', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-15', '20:00'));
  const old = app.authority.current();
  app.authority.saveItems(old, [item('p1', 'changed my mind')]);
  app.setNow(manila(D, '20:00'));
  app.authority.dismissStaleItem({ sourceTarget: old, itemId: 'p1', stamp });
  assert.deepEqual(app.authority.staleUnfinished().items, []);
  app.authority.undismissStaleItem({ sourceTarget: old, itemId: 'p1', stamp });
  assert.equal(app.authority.staleUnfinished().items.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// 5. reload, boundary revisions, and non-inflation
// ═══════════════════════════════════════════════════════════════════════

test('reload preserves the move (a fresh authority over the same storage)', () => {
  const storage = memory();
  const planStorage = memory();
  const app = enable(makeApp({ storage, planStorage }));
  app.setNow(manila('2026-09-17', '20:00'));
  const yesterday = app.authority.current();
  app.authority.saveItems(yesterday, [item('p1', 'slipped')]);
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();
  app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'p1', destination: today, stamp });

  const reloaded = makeApp({ storage, planStorage });
  reloaded.setNow(manila(D, '20:00'));
  const reloadedToday = reloaded.authority.current();
  assert.equal(reloadedToday.id, today.id);
  assert.deepEqual(reloaded.authority.items(reloadedToday).map(i => i.task), ['slipped']);
  assert.deepEqual(reloaded.authority.staleUnfinished().items, [], 'still recorded as recovered after reload');
});

test('a boundary revision AFTER the original planning does not orphan the stale task', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-15', '20:00'));
  const old = app.authority.current();
  const oldId = old.id;
  app.authority.saveItems(old, [item('p1', 'planned under the old boundary')]);

  // The owner changes their boundary a few days later.
  app.setNow(manila('2026-09-17', '10:00'));
  app.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA });
  app.setNow(manila('2026-09-19', '21:00'));

  // Still discoverable, under its original identity, with its interval resolvable.
  const { items, unresolvable } = app.authority.staleUnfinished();
  const found = items.find(r => r.item.id === 'p1');
  assert.ok(found, 'a boundary change must not orphan a stale task');
  assert.equal(found.sourceDayId, oldId, 'its source day identity is unchanged');
  assert.deepEqual(unresolvable, []);

  // And it can still be moved into the CURRENT day under the new boundary.
  app.authority.moveStaleItem({ sourceTarget: found.target, itemId: 'p1', destination: app.authority.current(), stamp });
  assert.deepEqual(app.authority.items(app.authority.current()).map(i => i.task), ['planned under the old boundary']);
});

test('a boundary revision after a MOVE does not orphan the destination copy', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-15', '20:00'));
  const old = app.authority.current();
  app.authority.saveItems(old, [item('p1', 'moved then boundary changed')]);
  app.setNow(manila('2026-09-16', '20:00'));
  const destination = app.authority.current();
  app.authority.moveStaleItem({ sourceTarget: old, itemId: 'p1', destination, stamp });

  app.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA });
  app.setNow(manila('2026-09-19', '21:00'));

  // The destination record still holds the copy, and provenance still resolves.
  assert.deepEqual(app.authority.items(destination).map(i => i.task), ['moved then boundary changed']);
  assert.equal(app.authority.staleMoveDestination('p1', old.id).dayId, destination.id);
  // ...so the source is still not re-offered.
  assert.ok(!app.authority.staleUnfinished().items.some(r => r.item.id === 'p1'));
});

test('recovering a stale task does not inflate readiness or the Planning Streak', () => {
  const app = enable(makeApp());
  app.setNow(manila('2026-09-17', '20:00'));
  const yesterday = app.authority.current();
  app.authority.saveItems(yesterday, [item('p1', 'slipped')]);
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();

  const before = app.authority.streak();
  app.authority.moveStaleItem({ sourceTarget: yesterday, itemId: 'p1', destination: today, stamp });
  const after = app.authority.streak();
  assert.deepEqual(after, before, 'moving a task is not preparing a day');
  assert.equal(app.authority.preparation(today), null, 'and it does not confirm preparation');
  assert.equal(app.authority.readyNow(today), false);
});

test('a legacy-only account gets the whole recovery surface with no boundary at all', () => {
  const legacy = legacyStore({
    '2026-09-10': { items: [item('leg1', 'legacy slipped')] },
    '2026-09-16': { items: [item('leg2', 'also slipped')] },
  });
  const app = makeApp({ legacy });
  app.setNow(manila(D, '20:00'));
  const { items } = app.authority.staleUnfinished();
  assert.deepEqual(items.map(r => r.item.id).sort(), ['leg1', 'leg2']);

  const source = app.authority.targetById('2026-09-10');
  const today = app.authority.current();
  assert.equal(today.store, 'legacy');
  app.authority.moveStaleItem({ sourceTarget: source, itemId: 'leg1', destination: today, stamp });
  const moved = app.authority.items(today);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].id, 'carry:2026-09-10:leg1', 'a legacy->legacy move keeps the EXISTING carry id format');
});

test('describeStaleAge reads naturally across the ranges a surface shows', () => {
  const day = 86400000;
  assert.equal(describeStaleAge(0), 'earlier today');
  assert.equal(describeStaleAge(day), 'yesterday');
  assert.equal(describeStaleAge(3 * day), '3 days ago');
  assert.equal(describeStaleAge(8 * day), 'last week');
  assert.equal(describeStaleAge(20 * day), '2 weeks ago');
  assert.equal(describeStaleAge(35 * day), '5 weeks ago');
  assert.equal(describeStaleAge(70 * day), '2 months ago');
});

test('buildMovedItem refuses malformed input rather than minting a broken copy', () => {
  assert.throws(() => buildMovedItem({ carryId: '', sourceItem: item('p1', 'x'), stamp }), /deterministic carry id/);
  assert.throws(() => buildMovedItem({ carryId: 'c1', sourceItem: null, stamp }), /source item is required/);
  assert.throws(() => buildMovedItem({ carryId: 'c1', sourceItem: item('p1', 'x'), stamp: null }), /stamping function/);
});
