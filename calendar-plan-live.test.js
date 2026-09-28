import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarPlanLiveWiring } from './calendar-plan-live.js';
import { createCalendarPlanRepository } from './calendar-plan-repository.js';
import { createCalendarPlanSyncBridge, CALENDAR_PLANS_REMOTE_PATH } from './calendar-plan-sync.js';
import { calendarPlanId } from './calendar-plan-model.js';
import { fakeDatabase, memoryStorage } from './calendar-plan-test-support.js';

const MANILA = 'Asia/Manila';
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const item = (id, when = '', extra = {}) => ({ id, task: id, when, done: false, updatedAt: 1, updatedBy: 'dev', ...extra });

function device(db, { room = 'uid_A', clock = { now: at('2026-09-27', '11:00') }, deviceId = 'phone', changes = [] } = {}) {
  const state = { room, online: true };
  let n = 0;
  const repository = createCalendarPlanRepository({ storage: memoryStorage(), getOwner: () => state.room, getTimezone: () => MANILA, idGenerator: () => `${deviceId}-f${++n}` });
  const sync = createCalendarPlanSyncBridge({
    repository,
    getRoomRef: () => (state.room && state.online ? db.ref(`rooms/${state.room}`) : null),
    getRoomId: () => state.room,
    onRemoteChange: kind => changes.push(kind),
  });
  const live = createCalendarPlanLiveWiring({ repository, sync, now: () => clock.now, deviceId: () => deviceId, timezone: () => MANILA, onChange: () => changes.push('local') });
  return { state, repository, sync, live, clock, changes };
}

test('reading never activates: an account is inactive until the owner explicitly activates', () => {
  const d = device(fakeDatabase());
  assert.equal(d.live.active(), false);
  assert.equal(d.live.activation(), null);
  assert.equal(d.live.status().status, 'inactive');
  d.live.readRecord('2026-09-27');
  d.live.liveDateKeys();
  assert.equal(d.live.active(), false);
  assert.deepEqual(d.live.liveDateKeys(), [], 'no listeners are wanted for an inactive account');
});

test('activate() appends the fact, pushes it, announces the change, and is idempotent', async () => {
  const db = fakeDatabase();
  const d = device(db);
  const { fact, created } = d.live.activate();
  assert.equal(created, true);
  assert.equal(fact.activationDate, '2026-09-27');
  assert.equal(d.live.active(), true);
  assert.deepEqual(d.changes, ['local']);
  await Promise.resolve();
  assert.equal(Object.keys(db.getAt('rooms/uid_A/calendarPlanAuthority')).length, 1);
  assert.equal(d.live.activate().created, false);
});

test('writes go to the calendar store only and reach the cloud; the record is ONE plan per date', async () => {
  const db = fakeDatabase();
  const d = device(db);
  d.live.activate();
  d.live.writePlanItems('2026-09-27', [item('a', '11:00'), item('b', '01:00', { whenDayOffset: 1 })]);
  await new Promise(resolve => setTimeout(resolve, 0));
  const remote = db.getAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}/${calendarPlanId('2026-09-27')}`);
  assert.deepEqual(remote.items.map(i => [i.id, i.when, i.whenDayOffset ?? 0, i.whenTz]), [['a', '11:00', 0, MANILA], ['b', '01:00', 1, MANILA]]);
  assert.equal(d.live.readRecord('2026-09-28'), null, 'nothing is cloned into Monday');
  assert.deepEqual(Object.keys(d.live.listAllRaw()), ['cal1:2026-09-27']);
});

test('a rejected item writes nothing locally and nothing remotely', async () => {
  const db = fakeDatabase();
  const d = device(db);
  d.live.activate();
  assert.throws(() => d.live.writePlanItems('2026-09-27', [item('bad', '23:00', { whenDayOffset: 1, durationMinutes: 300 })]), /outside-plan-extent/);
  assert.equal(d.live.readRecord('2026-09-27'), null);
  assert.equal(db.getAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}`), undefined);
});

test('items + preparation are one write and the returned promise reports the cloud commit', async () => {
  const db = fakeDatabase();
  const d = device(db);
  d.live.activate();
  const committed = await d.live.writePlanWithPreparation('2026-09-27', [item('a', '11:00')], { schemaVersion: 1, targetDate: '2026-09-27', timezone: MANILA, firstPreparedAt: 5, firstPreparedMode: 'normal', lastPreparedAt: 5, lastPreparedMode: 'normal', updatedBy: 'phone', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['a'] });
  assert.equal(committed, true);
  assert.equal(d.live.readRecord('2026-09-27').preparation.oneOffItemIds[0], 'a');
});

test('listeners follow the calendar: today, tomorrow and every plan still ahead — and roll over at midnight', () => {
  const db = fakeDatabase();
  const d = device(db);
  d.live.activate();
  d.live.writePlanItems('2026-10-20', [item('far')]);
  d.live.writePlanItems('2026-09-20', [item('past')]);
  assert.deepEqual(d.live.liveDateKeys(), ['2026-09-27', '2026-09-28', '2026-10-20']);
  d.live.refreshLive();
  assert.deepEqual(d.live.attachedPlanIds(), ['cal1:2026-09-27', 'cal1:2026-09-28', 'cal1:2026-10-20']);
  d.clock.now = at('2026-09-28', '00:05'); // midnight passes with no user action
  d.live.tick();
  assert.deepEqual(d.live.attachedPlanIds(), ['cal1:2026-09-28', 'cal1:2026-09-29', 'cal1:2026-10-20'], 'Sunday is finalized history and lost its listener');
});

test('a device that has NOT activated still listens for the cutover and adopts it when another device makes it', () => {
  const db = fakeDatabase();
  const phone = device(db, { deviceId: 'phone' });
  const mac = device(db, { deviceId: 'mac' });
  mac.live.attachLive();
  assert.equal(mac.live.active(), false);
  phone.live.activate();
  assert.equal(mac.live.active(), true, 'the Mac learned the cutover from the account');
  assert.equal(mac.repository.activation().deviceId, 'phone');
  assert.ok(mac.changes.includes('activation'), 'and was told, so it can re-render');
  assert.deepEqual(mac.live.attachedPlanIds(), ['cal1:2026-09-27', 'cal1:2026-09-28'], 'now listening for the calendar plans too');
});

test('plans written on one device appear on the other through the live listeners', () => {
  const db = fakeDatabase();
  const phone = device(db, { deviceId: 'phone' });
  const mac = device(db, { deviceId: 'mac' });
  mac.live.attachLive();
  phone.live.activate();
  phone.live.writePlanItems('2026-09-27', [item('shared', '11:00')]);
  assert.equal(mac.live.readRecord('2026-09-27')?.items[0].id, 'shared');
});

test('pushAllLocal re-pushes the activation and EVERY local plan, including far-future ones written while offline', async () => {
  const db = fakeDatabase();
  const d = device(db);
  d.state.online = false; // no reachable room ref: every push is skipped, nothing is lost locally
  d.live.activate();
  d.live.writePlanItems('2027-01-15', [item('future')]);
  d.live.writePlanItems('2026-09-27', [item('today')]);
  assert.equal(db.getAt('rooms/uid_A'), undefined, 'the cloud has seen nothing');
  d.state.online = true; // reconnect
  d.live.pushAllLocal();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(db.getAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}/cal1:2027-01-15`), 'the far-future plan reached the cloud');
  assert.ok(db.getAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}/cal1:2026-09-27`));
  assert.equal(Object.keys(db.getAt('rooms/uid_A/calendarPlanAuthority')).length, 1);
});

test('detach() (sign-out / room switch) removes every listener and later callbacks change nothing', () => {
  const db = fakeDatabase();
  const d = device(db);
  d.live.activate();
  d.live.attachLive();
  assert.ok(db.listenerCount() > 0);
  d.live.detach();
  assert.equal(db.listenerCount(), 0);
  assert.deepEqual(d.live.attachedPlanIds(), []);
  const before = d.changes.length;
  db.setAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}/cal1:2026-09-27`, { items: [item('late')], updatedAt: 9 });
  db.fire();
  assert.equal(d.changes.length, before);
  assert.equal(d.live.readRecord('2026-09-27'), null);
});

test('a direct A -> B switch: A\'s cutover and plans are not B\'s, and B -> A restores A', () => {
  const db = fakeDatabase();
  const d = device(db);
  d.live.activate();
  d.live.writePlanItems('2026-09-27', [item('a-only', '11:00')]);
  d.state.room = 'uid_B';
  d.live.attachLive();
  assert.equal(d.live.active(), false, 'B never activated');
  assert.equal(d.live.readRecord('2026-09-27'), null);
  assert.deepEqual(d.live.listAllRaw(), {});
  assert.deepEqual(d.live.liveDateKeys(), []);
  assert.throws(() => d.live.writePlanItems('2026-09-27', [item('x')]), /not active for this account/);
  d.state.room = 'uid_A';
  d.live.attachLive();
  assert.equal(d.live.active(), true);
  assert.equal(d.live.readRecord('2026-09-27').items[0].id, 'a-only');
});
