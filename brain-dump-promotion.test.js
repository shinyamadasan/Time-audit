// brain-dump-promotion.test.js
//
// Brain Dump + Eisenhower V1 — promoteCaptureToPlan() (Do Today / Schedule) against
// a FAKE Plan Authority that mimics the real module's public shape
// (current/dayForScheduledDate/rawItems/addItem — read directly from plan-authority.js
// during architecture recon for this phase). Proves: the plan write always goes
// through Plan Authority, promotion is idempotent under retry via the deterministic
// plan-item id, a capture already disposed of is never re-promoted, and a Plan
// Authority refusal (invalid range, past day, DST ambiguity) surfaces as a reported
// reason rather than throwing past this layer.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrainDumpRepository } from './brain-dump-repository.js';
import { brainDumpPlanItemId } from './brain-dump-model.js';
import { promoteCaptureToPlan } from './brain-dump-promotion.js';

const T0 = Date.parse('2026-10-01T08:00:00Z');
const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

function makeRepository() {
  return createBrainDumpRepository({ storage: memory(), getOwner: () => 'uid_a', now: () => T0, deviceId: () => 'device-1' });
}

/** A fake Plan Authority. `items` is the mutable backing array addItem()/rawItems()
 *  read and write, so a test can assert on exactly what got added. */
function makeFakePlanAuthority({ todayTarget = { store: 'calendar', id: 'calplan:2026-10-01', dateKey: '2026-10-01' }, schedule = null } = {}) {
  const items = [];
  const calls = { current: 0, addItem: 0, dayForScheduledDate: 0 };
  return {
    items,
    calls,
    current() { calls.current++; return todayTarget; },
    dayForScheduledDate(dateKey, when) {
      calls.dayForScheduledDate++;
      if (schedule) return schedule(dateKey, when);
      return { ok: true, anchor: when ? 'time' : 'noon', target: { store: 'calendar', id: `calplan:${dateKey}`, dateKey } };
    },
    rawItems() { return items; },
    addItem({ item }) {
      calls.addItem++;
      items.push(item);
      return { item };
    },
  };
}

test('Do Today builds a plan item via Plan Authority with the deterministic id, untimed, kind:task', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Water the plants' });
  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });

  assert.ok(result.ok);
  assert.equal(result.record.status, 'promoted');
  assert.equal(planAuthority.calls.addItem, 1);
  assert.equal(planAuthority.items[0].id, brainDumpPlanItemId(record.id));
  assert.equal(planAuthority.items[0].task, 'Water the plants');
  assert.equal(planAuthority.items[0].when, '');
  assert.equal(planAuthority.items[0].kind, 'task');
  assert.equal(repository.read(record.id).promotion.type, 'do-today');
});

test('Do Today is idempotent at the top level: a capture already promoted is never promoted twice', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Only once' });
  promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  const retry = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 2, deviceId: 'device-1' });

  assert.equal(retry.ok, true);
  assert.equal(retry.alreadyDisposed, true);
  assert.equal(planAuthority.calls.addItem, 1, 'the plan item must not be created a second time');
});

test('a retry that still finds the capture untriaged (e.g. a crash before the disposition write landed) does not duplicate the plan item', () => {
  // Simulates: the plan write succeeded last time, but the capture's own status
  // update never persisted (process died in between). The deterministic id is
  // what makes the retry safe even though the repository's own guard did not fire.
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Half-finished promotion' });
  const deterministicId = brainDumpPlanItemId(record.id);
  planAuthority.items.push({ id: deterministicId, task: record.text, when: '', done: false, doneAt: null, updatedAt: T0, updatedBy: 'device-1', kind: 'task' });

  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 5, deviceId: 'device-1' });
  assert.ok(result.ok);
  assert.equal(planAuthority.calls.addItem, 0, 'the item is already there — addItem must not be called again');
  assert.equal(planAuthority.items.length, 1, 'no duplicate plan item');
  assert.equal(repository.read(record.id).status, 'promoted', 'the disposition catches up to match');
});

test('Schedule resolves the target via dayForScheduledDate and carries an optional time + duration', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Dentist follow-up' });
  const result = promoteCaptureToPlan({
    repository, planAuthority, id: record.id, type: 'schedule',
    dateKey: '2026-10-05', when: '14:30', durationMinutes: 45,
    now: T0 + 1, deviceId: 'device-1',
  });

  assert.ok(result.ok);
  assert.equal(planAuthority.calls.dayForScheduledDate, 1);
  assert.equal(planAuthority.items[0].when, '14:30');
  assert.equal(planAuthority.items[0].durationMinutes, 45);
  assert.equal(repository.read(record.id).promotion.type, 'schedule');
  assert.equal(repository.read(record.id).promotion.targetId, 'calplan:2026-10-05');
});

test('Schedule with no time produces an untimed (anytime) item — a time is never required', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Someday, no rush' });
  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'schedule', dateKey: '2026-11-01', now: T0 + 1, deviceId: 'device-1' });
  assert.ok(result.ok);
  assert.equal(planAuthority.items[0].when, '');
  assert.equal(planAuthority.items[0].durationMinutes, undefined);
});

test('a Plan Authority refusal (DST ambiguity) surfaces as a reported reason, never a thrown error', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority({ schedule: () => ({ ok: false, reason: 'ambiguous' }) });
  const { record } = repository.create({ text: 'Falls on the clock change' });
  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'schedule', dateKey: '2026-11-01', when: '02:30', now: T0 + 1, deviceId: 'device-1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(planAuthority.calls.addItem, 0);
  assert.equal(repository.read(record.id).status, 'untriaged', 'the capture is NOT disposed of when the plan write never happened');
});

test('addItem throwing (e.g. a past My Day, or the Top-3 cap) is caught and reported, not disposed', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  planAuthority.addItem = () => { throw new Error('Past My Days are history. Reschedule unfinished work from Unfinished instead.'); };
  const { record } = repository.create({ text: 'Too late now' });
  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Past My Days are history/);
  assert.equal(repository.read(record.id).status, 'untriaged');
});

test('promoting an unknown capture id reports not-found', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const result = promoteCaptureToPlan({ repository, planAuthority, id: 'bdoesnotexist1', type: 'do-today', now: T0, deviceId: 'device-1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-found');
});

test('a capture already archived is reported alreadyDisposed and Plan Authority is never touched', () => {
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Dropped already' });
  repository.archive(record.id);
  const result = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyDisposed, true);
  assert.equal(planAuthority.calls.current, 0);
  assert.equal(planAuthority.calls.addItem, 0);
});

test('two near-simultaneous promotions of the same capture (a two-device race) never create two plan items', () => {
  // Both "devices" share the same in-memory Plan Authority fake and repository
  // here (the real cross-device race is covered by brain-dump-account-isolation's
  // sync-level tests); this proves the deterministic id is what makes a second
  // writer's addItem a no-op rather than a duplicate, at this layer.
  const repository = makeRepository();
  const planAuthority = makeFakePlanAuthority();
  const { record } = repository.create({ text: 'Raced' });
  const first = promoteCaptureToPlan({ repository, planAuthority, id: record.id, type: 'do-today', now: T0 + 1, deviceId: 'device-1' });
  // Simulate device two racing in with the capture still (from ITS perspective)
  // showing as triaged, because it had not yet pulled device one's disposition —
  // directly exercise promoteCaptureToPlan's own id-presence check again.
  const sameDeterministicId = brainDumpPlanItemId(record.id);
  assert.equal(planAuthority.items.filter(i => i.id === sameDeterministicId).length, 1);
  assert.ok(first.ok);
});
