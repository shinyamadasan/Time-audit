import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarPlanSyncBridge, CALENDAR_AUTHORITY_REMOTE_PATH, CALENDAR_PLANS_REMOTE_PATH } from './calendar-plan-sync.js';
import { createCalendarPlanRepository } from './calendar-plan-repository.js';
import { buildActivationFact, calendarPlanId } from './calendar-plan-model.js';
import { fakeDatabase, memoryStorage } from './calendar-plan-test-support.js';

const MANILA = 'Asia/Manila';
const SUNDAY = '2026-09-27';
const PLAN_ID = calendarPlanId(SUNDAY);
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);

/** One device: its own storage, its own repository, the shared database. */
function device(db, { room = 'uid_A', tz = MANILA, deviceId = 'dev', onRemoteChange = () => {} } = {}) {
  const state = { room };
  const storage = memoryStorage();
  let n = 0;
  const repository = createCalendarPlanRepository({ storage, getOwner: () => state.room, getTimezone: () => tz, idGenerator: () => `${deviceId}-fact-${++n}` });
  const bridge = createCalendarPlanSyncBridge({
    repository,
    getRoomRef: () => (state.room ? db.ref(`rooms/${state.room}`) : null),
    getRoomId: () => state.room,
    onRemoteChange,
  });
  return { state, storage, repository, bridge };
}

const item = (id, extra = {}) => ({ id, task: id, when: '', done: false, updatedAt: 1, updatedBy: 'dev', ...extra });

test('pushPlan commits through a transaction and two devices\' concurrent edits converge by per-item merge', async () => {
  const db = fakeDatabase();
  const a = device(db, { deviceId: 'a' });
  const b = device(db, { deviceId: 'b' });
  a.repository.write(SUNDAY, [item('one', { updatedAt: 10 })], { updatedBy: 'a', now: 10 });
  b.repository.write(SUNDAY, [item('two', { updatedAt: 11 })], { updatedBy: 'b', now: 11 });
  assert.equal((await a.bridge.pushPlan(PLAN_ID)).outcome, 'committed');
  assert.equal((await b.bridge.pushPlan(PLAN_ID)).outcome, 'committed');
  const remote = db.getAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}/${PLAN_ID}`);
  assert.deepEqual(remote.items.map(i => i.id), ['one', 'two'], 'neither device overwrote the other');
  assert.deepEqual(b.repository.read(SUNDAY).items.map(i => i.id), ['one', 'two'], 'the committed value was merged back locally');
});

test('a push is refused with ZERO writes when the joined room is not the cache owner', async () => {
  const db = fakeDatabase();
  const a = device(db);
  a.repository.write(SUNDAY, [item('one')], { updatedBy: 'a', now: 1 });
  // The repository still serves uid_A's cache, but the app has already joined B.
  const bridge = createCalendarPlanSyncBridge({ repository: a.repository, getRoomRef: () => db.ref('rooms/uid_B'), getRoomId: () => 'uid_B' });
  a.state.room = 'uid_A';
  const result = await bridge.pushPlan(PLAN_ID);
  assert.equal(result.outcome, 'owner-mismatch');
  assert.deepEqual(db.tree, {}, 'nothing was written anywhere');
});

test('an account switch DURING a transaction retry aborts with zero writes and merges nothing back', async () => {
  const db = fakeDatabase();
  const a = device(db);
  a.repository.write(SUNDAY, [item('one')], { updatedBy: 'a', now: 1 });
  const realRef = db.ref(`rooms/uid_A`);
  const bridge = createCalendarPlanSyncBridge({
    repository: a.repository,
    getRoomId: () => a.state.room,
    getRoomRef: () => ({
      child: name => ({
        child: id => ({
          transaction: (fn, ...rest) => {
            a.state.room = 'uid_B'; // the switch lands before Firebase (re)runs the update function
            return realRef.child(name).child(id).transaction(fn, ...rest);
          },
        }),
      }),
    }),
  });
  const result = await bridge.pushPlan(PLAN_ID);
  assert.equal(result.outcome, 'owner-mismatch');
  assert.deepEqual(db.tree, {});
});

test('a late callback from a superseded or old-room listener is inert', () => {
  const db = fakeDatabase();
  const seen = [];
  const a = device(db, { onRemoteChange: (...args) => seen.push(args) });
  a.bridge.attachPlan(PLAN_ID);
  // A remote write from another device reaches A's listener: merged and announced.
  db.setAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}/${PLAN_ID}`, { items: [item('remote', { updatedAt: 5 })], updatedAt: 5 });
  db.fire();
  assert.equal(a.repository.read(SUNDAY).items[0].id, 'remote');
  assert.equal(seen.length, 1);

  // The account switches to B without a sign-out in between; A's old listener then fires late.
  a.state.room = 'uid_B';
  db.setAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}/${PLAN_ID}`, { items: [item('leak', { updatedAt: 9 })], updatedAt: 9 });
  db.fire();
  assert.equal(seen.length, 1, 'nothing announced for the old room');
  assert.equal(a.repository.read(SUNDAY), null, 'and nothing merged into B\'s cache');
  assert.equal(a.bridge.handleRemotePlanSnapshot(PLAN_ID, { items: [item('direct')], updatedAt: 1 }, 'uid_A'), false);
});

test('attaching for another room drops every listener bound to the previous one (direct A -> B switch)', () => {
  const db = fakeDatabase();
  const a = device(db);
  a.bridge.attachPlan(PLAN_ID);
  a.bridge.attachPlan(calendarPlanId('2026-09-28'));
  a.bridge.attachAuthority();
  assert.equal(db.listenerCount(), 3);
  a.state.room = 'uid_B';
  a.bridge.attachPlan(PLAN_ID);
  assert.equal(db.listenerCount(), 1, 'only the B-bound plan listener remains; the old plan + authority listeners are gone');
  a.bridge.attachAuthority();
  assert.equal(db.listenerCount(), 2);
});

test('sign-out: detachAll removes every listener, and a stale hydrate/push does nothing', async () => {
  const db = fakeDatabase();
  const a = device(db);
  a.repository.write(SUNDAY, [item('one')], { updatedBy: 'a', now: 1 });
  a.bridge.attachPlan(PLAN_ID);
  a.bridge.attachAuthority();
  a.bridge.detachAll();
  assert.equal(db.listenerCount(), 0);
  a.state.room = null; // signed out
  assert.equal((await a.bridge.pushPlan(PLAN_ID)).outcome, 'skipped');
  assert.equal(await a.bridge.hydrateAll(), false);
  assert.equal(a.bridge.handleRemotePlanSnapshot(PLAN_ID, { items: [item('late')] }, 'uid_A'), false);
  assert.deepEqual(db.tree, {});
});

test('hydrateAll fills the joined room\'s own cache once per binding and never another room\'s', async () => {
  const db = fakeDatabase();
  db.setAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}/${PLAN_ID}`, { items: [item('from-cloud', { updatedAt: 3 })], updatedAt: 3 });
  db.setAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}/not-a-plan-id`, { items: [item('junk')] });
  const a = device(db);
  assert.equal(await a.bridge.hydrateAll(), true);
  assert.deepEqual(a.repository.read(SUNDAY).items.map(i => i.id), ['from-cloud']);
  assert.equal(await a.bridge.hydrateAll(), false, 'a second call for the same binding is a no-op');
  a.state.room = 'uid_B';
  assert.equal(await a.bridge.hydrateAll(), true);
  assert.equal(a.repository.read(SUNDAY), null, 'B\'s cache did not receive A\'s cloud plan');
});

test('a hydrate that resolves AFTER the account switched merges nothing', async () => {
  const db = fakeDatabase();
  db.setAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}/${PLAN_ID}`, { items: [item('from-cloud')], updatedAt: 3 });
  const a = device(db);
  const pending = a.bridge.hydrateAll();
  a.state.room = 'uid_B';
  await pending;
  assert.equal(a.repository.read(SUNDAY), null);
});

// ── authority ───────────────────────────────────────────────────────────────

test('activation facts are pushed one child per fact; a second device that hears them adopts the SAME cutover', async () => {
  const db = fakeDatabase();
  const phone = device(db, { deviceId: 'phone' });
  const mac = device(db, { deviceId: 'mac' });
  mac.bridge.attachAuthority();
  const { fact } = phone.repository.activate({ nowMs: at('2026-09-27', '11:00'), deviceId: 'phone' });
  assert.equal((await phone.bridge.pushActivations()).outcome, 'committed');
  assert.deepEqual(Object.keys(db.getAt(`rooms/uid_A/${CALENDAR_AUTHORITY_REMOTE_PATH}`)), [fact.id]);
  assert.equal(mac.repository.activation().id, fact.id, 'the Mac learned the cutover from the account');
});

test('authority hydration is explicit: empty snapshot proves legacy, detach/account switch returns to unknown', () => {
  const db = fakeDatabase();
  const a = device(db);
  assert.equal(a.bridge.authorityHydrationState(), 'unknown');
  a.bridge.attachAuthority();
  assert.equal(a.bridge.authorityHydrationState(), 'hydrated', 'the initial empty value snapshot is a trustworthy negative');
  a.state.room = 'uid_B';
  assert.equal(a.bridge.authorityHydrationState(), 'unknown', 'A readiness never leaks into B');
  a.bridge.attachAuthority();
  assert.equal(a.bridge.authorityHydrationState(), 'hydrated');
  a.bridge.detachAll();
  assert.equal(a.bridge.authorityHydrationState(), 'unknown');
});

test('two devices that activated independently converge on the EARLIEST fact, whatever the delivery order', async () => {
  const early = buildActivationFact({ id: 'ca1-early', nowMs: at('2026-09-27', '11:00'), timezone: MANILA, deviceId: 'phone' });
  const late = buildActivationFact({ id: 'ca1-late', nowMs: at('2026-09-28', '08:00'), timezone: MANILA, deviceId: 'mac' });
  for (const order of [[early, late], [late, early]]) {
    const db = fakeDatabase();
    const observer = device(db, { deviceId: 'observer' });
    observer.bridge.attachAuthority();
    for (const fact of order) db.setAt(`rooms/uid_A/${CALENDAR_AUTHORITY_REMOTE_PATH}/${fact.id}`, fact);
    db.fire();
    assert.equal(observer.repository.activation().id, 'ca1-early');
    assert.equal(observer.repository.listAllActivationsRaw().length, 2);
  }
});

test('an activation snapshot for a room that is no longer joined is dropped; pushes are refused', async () => {
  const db = fakeDatabase();
  const seen = [];
  const a = device(db, { onRemoteChange: (...args) => seen.push(args) });
  const fact = buildActivationFact({ id: 'ca1-x', nowMs: at('2026-09-27', '11:00'), timezone: MANILA, deviceId: 'x' });
  a.bridge.attachAuthority();
  const beforeLate = seen.length;
  a.state.room = 'uid_B';
  db.setAt(`rooms/uid_A/${CALENDAR_AUTHORITY_REMOTE_PATH}/${fact.id}`, fact);
  db.fire();
  assert.equal(a.repository.activation(), null);
  assert.equal(seen.length, beforeLate, 'the old-room callback announced nothing');
  a.repository.activate({ nowMs: at('2026-09-27', '11:00'), deviceId: 'b-dev' });
  a.state.room = 'uid_A'; // the cache owner (B's slot) no longer matches the joined room
  a.state.room = 'uid_B';
  const bridgeForWrongRoom = createCalendarPlanSyncBridge({ repository: a.repository, getRoomRef: () => db.ref('rooms/uid_A'), getRoomId: () => 'uid_A' });
  assert.equal((await bridgeForWrongRoom.pushActivations()).outcome, 'owner-mismatch');
  assert.equal(db.getAt(`rooms/uid_A/${CALENDAR_AUTHORITY_REMOTE_PATH}/${fact.id}`).id, fact.id, 'only the fixture write exists');
  assert.equal(Object.keys(db.getAt(`rooms/uid_A/${CALENDAR_AUTHORITY_REMOTE_PATH}`)).length, 1);
});

test('offline (no room ref) is not an error: nothing pushed, nothing lost locally', async () => {
  const storage = memoryStorage();
  const repository = createCalendarPlanRepository({ storage, getOwner: () => 'uid_A', getTimezone: () => MANILA, idGenerator: () => 'f1' });
  const bridge = createCalendarPlanSyncBridge({ repository, getRoomRef: () => null, getRoomId: () => 'uid_A' });
  repository.write(SUNDAY, [item('local')], { updatedBy: 'a', now: 1 });
  repository.activate({ nowMs: at('2026-09-27', '11:00'), deviceId: 'a' });
  assert.equal((await bridge.pushPlan(PLAN_ID)).outcome, 'skipped');
  assert.equal((await bridge.pushActivations()).outcome, 'skipped');
  assert.equal(repository.read(SUNDAY).items[0].id, 'local');
  assert.ok(repository.activation());
});

test('a preparation with NO routines (an empty array the database drops) survives the cloud round trip: the second device reads the plan as prepared', async () => {
  const db = fakeDatabase();
  const a = device(db, { deviceId: 'a' });
  const b = device(db, { deviceId: 'b' });
  const preparation = { schemaVersion: 1, targetDate: SUNDAY, timezone: MANILA, firstPreparedAt: at('2026-09-26', '20:00'), firstPreparedMode: 'normal', lastPreparedAt: at('2026-09-26', '20:00'), lastPreparedMode: 'normal', updatedBy: 'a', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['p1'] };
  a.repository.writeWithPreparation(SUNDAY, [item('p1')], preparation, { updatedBy: 'a', now: at('2026-09-26', '20:00') });
  assert.equal((await a.bridge.pushPlan(PLAN_ID)).outcome, 'committed');
  const stored = db.getAt(`rooms/uid_A/${CALENDAR_PLANS_REMOTE_PATH}/${PLAN_ID}`);
  assert.equal('routineInstanceIds' in stored.preparation, false, 'the fake really pruned it, like the real database');
  assert.equal(await b.bridge.hydrateAll(), true);
  const record = b.repository.read(SUNDAY);
  assert.deepEqual(record.preparation.routineInstanceIds, []);
  assert.deepEqual(record.items.map(i => i.id), ['p1']);
});
