import test from 'node:test';
import assert from 'node:assert/strict';
import { CALENDAR_AUTHORITY_STORAGE_KEY, CALENDAR_PLAN_STORAGE_KEY, calendarCacheKeyForRoom, createCalendarPlanRepository } from './calendar-plan-repository.js';
import { buildActivationFact, calendarPlanId, calendarItemInstants } from './calendar-plan-model.js';
import { buildPreparation } from './plan-tomorrow-model.js';

const MANILA = 'Asia/Manila';
const SUNDAY = '2026-09-27';
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    keys: () => [...data.keys()],
    data,
  };
}

function scoped({ owner = { room: 'uid_A' }, storage = memoryStorage(), timezone = { tz: MANILA } } = {}) {
  let n = 0;
  const repository = createCalendarPlanRepository({ storage, getOwner: () => owner.room, getTimezone: () => timezone.tz, idGenerator: () => `fact-${++n}` });
  return { repository, storage, owner, timezone };
}

const item = (id, when = '', extra = {}) => ({ id, task: id, when, done: false, updatedAt: 1, updatedBy: 'dev', ...extra });

test('a scoped repository keeps ONE room per slot: A never sees B, and B -> A restores A', () => {
  const ctx = scoped();
  ctx.repository.write(SUNDAY, [item('a-task', '11:00')], { updatedBy: 'dev', now: 1000 });
  assert.equal(ctx.repository.read(SUNDAY).items[0].id, 'a-task');
  ctx.owner.room = 'uid_B';
  assert.equal(ctx.repository.read(SUNDAY), null);
  assert.deepEqual(ctx.repository.listAllRaw(), {});
  ctx.repository.write(SUNDAY, [item('b-task')], { updatedBy: 'dev', now: 2000 });
  ctx.owner.room = 'uid_A';
  assert.equal(ctx.repository.read(SUNDAY).items[0].id, 'a-task');
  assert.ok(ctx.storage.data.has(calendarCacheKeyForRoom('uid_A', CALENDAR_PLAN_STORAGE_KEY)));
  assert.ok(ctx.storage.data.has(calendarCacheKeyForRoom('uid_B', CALENDAR_PLAN_STORAGE_KEY)));
});

test('the same item id in two accounts never collides', () => {
  const ctx = scoped();
  ctx.repository.write(SUNDAY, [item('same-id')], { updatedBy: 'dev', now: 1 });
  ctx.owner.room = 'uid_B';
  ctx.repository.write(SUNDAY, [item('same-id', '09:00')], { updatedBy: 'dev', now: 2 });
  assert.equal(ctx.repository.read(SUNDAY).items[0].when, '09:00');
  ctx.owner.room = 'uid_A';
  assert.equal(ctx.repository.read(SUNDAY).items[0].when, '');
});

test('with no account there is no cache: reads are empty and writes throw', () => {
  const ctx = scoped({ owner: { room: null } });
  assert.equal(ctx.repository.read(SUNDAY), null);
  assert.deepEqual(ctx.repository.listAllRaw(), {});
  assert.deepEqual(ctx.repository.listAllActivationsRaw(), []);
  assert.equal(ctx.repository.activation(), null);
  assert.throws(() => ctx.repository.write(SUNDAY, [], { updatedBy: 'dev', now: 1 }), /No account is active/);
  assert.throws(() => ctx.repository.activate({ nowMs: 1000, deviceId: 'dev' }), /No account is active/);
  assert.deepEqual(ctx.repository.mergeRemote(calendarPlanId(SUNDAY), { items: [] }), { changed: false, record: null });
});

test('a bare (unowned) key is never read, merged into or adopted', () => {
  const storage = memoryStorage({
    [CALENDAR_PLAN_STORAGE_KEY]: JSON.stringify({ schemaVersion: 1, plans: { [calendarPlanId(SUNDAY)]: { items: [item('stranger')], updatedAt: 1 } } }),
    [CALENDAR_AUTHORITY_STORAGE_KEY]: JSON.stringify({ schemaVersion: 1, facts: {} }),
  });
  const ctx = scoped({ storage });
  assert.equal(ctx.repository.read(SUNDAY), null);
  ctx.repository.write(SUNDAY, [item('mine')], { updatedBy: 'dev', now: 5 });
  assert.equal(JSON.parse(storage.data.get(CALENDAR_PLAN_STORAGE_KEY)).plans[calendarPlanId(SUNDAY)].items[0].id, 'stranger'); // untouched
});

test('write freezes each timed reading\'s zone and the plan\'s home zone, and an unchanged reading keeps its zone after the account zone changes', () => {
  const ctx = scoped();
  ctx.repository.write(SUNDAY, [item('a', '11:00'), item('b', '01:00', { whenDayOffset: 1 })], { updatedBy: 'dev', now: 1000 });
  const first = ctx.repository.read(SUNDAY);
  assert.equal(first.timezone, MANILA);
  assert.equal(first.createdAt, 1000);
  assert.deepEqual(first.items.map(i => i.whenTz), [MANILA, MANILA]);
  const before = first.items.map(i => calendarItemInstants(SUNDAY, i).startMs);
  assert.deepEqual(before, [at('2026-09-27', '11:00'), at('2026-09-28', '01:00')]);

  ctx.timezone.tz = 'America/Los_Angeles'; // the account moves
  ctx.repository.write(SUNDAY, first.items.map(i => ({ ...i, done: true })), { updatedBy: 'dev', now: 2000 });
  const second = ctx.repository.read(SUNDAY);
  assert.equal(second.timezone, MANILA, 'home zone is frozen by the first write');
  assert.equal(second.createdAt, 1000);
  assert.deepEqual(second.items.map(i => calendarItemInstants(SUNDAY, i).startMs), before, 'historical instants did not move');

  ctx.repository.write(SUNDAY, [{ ...second.items[0], when: '12:00' }, second.items[1]], { updatedBy: 'dev', now: 3000 });
  const third = ctx.repository.read(SUNDAY);
  assert.equal(third.items[0].whenTz, 'America/Los_Angeles', 'a NEW reading is made in the zone in effect now');
  assert.equal(third.items[1].whenTz, MANILA);
});

test('an invalid item throws BEFORE anything is written (all-or-nothing)', () => {
  const ctx = scoped();
  ctx.repository.write(SUNDAY, [item('ok', '10:00')], { updatedBy: 'dev', now: 1 });
  const key = calendarCacheKeyForRoom('uid_A', CALENDAR_PLAN_STORAGE_KEY);
  const snapshot = ctx.storage.data.get(key);
  assert.throws(() => ctx.repository.write(SUNDAY, [item('ok', '10:00'), item('bad', '23:00', { whenDayOffset: 1, durationMinutes: 120 })], { updatedBy: 'dev', now: 2 }), /outside-plan-extent/);
  assert.throws(() => ctx.repository.write(SUNDAY, [item('bad', '10:00', { whenDayOffset: 5 })], { updatedBy: 'dev', now: 2 }), /invalid-offset/);
  assert.equal(ctx.storage.data.get(key), snapshot);
});

test('items and preparation land in ONE write, on the same record', () => {
  const ctx = scoped();
  const preparation = buildPreparation(null, { targetDate: SUNDAY, timezone: MANILA, now: at('2026-09-26', '20:00'), mode: 'normal', updatedBy: 'dev', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['a'] });
  ctx.repository.writeWithPreparation(SUNDAY, [item('a', '11:00')], preparation, { updatedBy: 'dev', now: at('2026-09-26', '20:00') });
  const record = ctx.repository.read(SUNDAY);
  assert.equal(record.preparation.targetDate, SUNDAY);
  assert.equal(record.items[0].id, 'a');
});

test('mergeRemote is per-item, reports whether anything changed, and rejects a non-calendar id', () => {
  const ctx = scoped();
  ctx.repository.write(SUNDAY, [item('a', '', { updatedAt: 10 })], { updatedBy: 'dev', now: 10 });
  const remote = { items: [item('a', '', { updatedAt: 20, task: 'edited elsewhere', updatedBy: 'other' }), item('b', '', { updatedAt: 5 })], updatedAt: 20, updatedBy: 'other' };
  const first = ctx.repository.mergeRemote(calendarPlanId(SUNDAY), remote);
  assert.equal(first.changed, true);
  assert.deepEqual(ctx.repository.read(SUNDAY).items.map(i => [i.id, i.task]), [['a', 'edited elsewhere'], ['b', 'b']]);
  assert.equal(ctx.repository.mergeRemote(calendarPlanId(SUNDAY), remote).changed, false);
  assert.throws(() => ctx.repository.mergeRemote('odv1:r:Asia/Manila:2026-09-27', remote));
});

test('the store never reads plans[dateKey] or an operational plan: nothing is inherited by absence', () => {
  const storage = memoryStorage({
    'ta3-plans:uid_A': JSON.stringify({ [SUNDAY]: { items: [item('legacy')] } }),
    'ta3-operational-plans-v1:uid_A': JSON.stringify({ schemaVersion: 1, plans: {} }),
  });
  const ctx = scoped({ storage });
  assert.equal(ctx.repository.read(SUNDAY), null);
  assert.deepEqual(ctx.repository.listAllRaw(), {});
});

test('a malformed or unsupported plan envelope fails loudly rather than reading as empty', () => {
  const key = calendarCacheKeyForRoom('uid_A', CALENDAR_PLAN_STORAGE_KEY);
  assert.throws(() => scoped({ storage: memoryStorage({ [key]: '{nope' }) }).repository.read(SUNDAY), /malformed JSON/);
  assert.throws(() => scoped({ storage: memoryStorage({ [key]: JSON.stringify({ schemaVersion: 9, plans: {} }) }) }).repository.read(SUNDAY), /unsupported/);
  assert.throws(() => scoped({ storage: memoryStorage({ [key]: JSON.stringify({ schemaVersion: 1, plans: { '2026-09-27': {} } }) }) }).repository.read(SUNDAY), /invalid plan id/);
});

// ── authority cutover ───────────────────────────────────────────────────────

test('activation is explicit, one fact, idempotent, and account-scoped', () => {
  const ctx = scoped();
  assert.deepEqual(ctx.repository.status(), { status: 'inactive', activation: null, factCount: 0 });
  const first = ctx.repository.activate({ nowMs: at('2026-09-27', '11:00'), deviceId: 'phone' });
  assert.equal(first.created, true);
  assert.equal(first.fact.activationDate, SUNDAY);
  const again = ctx.repository.activate({ nowMs: at('2026-09-27', '12:00'), deviceId: 'phone' });
  assert.equal(again.created, false);
  assert.equal(again.fact.id, first.fact.id);
  assert.equal(ctx.repository.status().factCount, 1);
  ctx.owner.room = 'uid_B';
  assert.equal(ctx.repository.activation(), null, 'B has not activated: A\'s cutover is not B\'s');
  assert.equal(ctx.repository.status().status, 'inactive');
  ctx.owner.room = 'uid_A';
  assert.equal(ctx.repository.activation().id, first.fact.id);
});

test('remote activations union in, the earliest wins regardless of arrival, and contradictory content for one id is rejected', () => {
  const ctx = scoped();
  const mine = ctx.repository.activate({ nowMs: at('2026-09-28', '09:00'), deviceId: 'mac' }).fact;
  const earlier = buildActivationFact({ id: 'ca1-remote', nowMs: at('2026-09-27', '11:00'), timezone: MANILA, deviceId: 'phone' });
  const result = ctx.repository.mergeRemoteActivations({ [earlier.id]: earlier });
  assert.deepEqual(result, { changed: true, changedIds: ['ca1-remote'], rejectedIds: [] });
  assert.equal(ctx.repository.activation().id, 'ca1-remote', 'the earlier device\'s activation is the account\'s');
  assert.equal(ctx.repository.listAllActivationsRaw().length, 2, 'the later fact is kept, just not effective');
  assert.equal(ctx.repository.mergeRemoteActivations({ [earlier.id]: earlier }).changed, false);
  const tampered = { ...earlier, deviceId: 'someone-else' };
  assert.deepEqual(ctx.repository.mergeRemoteActivations({ [earlier.id]: tampered }).rejectedIds, ['ca1-remote']);
  assert.deepEqual(ctx.repository.mergeRemoteActivations({ bogus: { id: 'bogus' }, [mine.id]: { ...mine, id: 'other' } }).rejectedIds.sort(), [mine.id, 'bogus'].sort());
  assert.equal(ctx.repository.activation().id, 'ca1-remote');
});

test('an unreadable authority slot reads as inactive but is reported, never silently activating anything', () => {
  const key = calendarCacheKeyForRoom('uid_A', CALENDAR_AUTHORITY_STORAGE_KEY);
  const ctx = scoped({ storage: memoryStorage({ [key]: '{broken' }) });
  assert.equal(ctx.repository.activation(), null);
  assert.equal(ctx.repository.status().status, 'invalid');
  assert.throws(() => ctx.repository.activate({ nowMs: 1000, deviceId: 'dev' }), /malformed JSON/);
});
