// Actual native projection/helpers with a controlled provider; no Android or external network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../time-ack.js';
const source = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const section = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first); return source.slice(first, last);
};
const code = section('var _accountingNativePingKey', 'async function initNativeNotifications')
  + section('async function scheduleNativePing', '// Pre-fill intention');
function fixture() {
  const calls = [], timers = new Map(), sw = [], history = [];
  let sequence = 0, now = 1000000, attachment = { owner: 'uid_alice', uid: 'alice', device: 'proof-device', generation: 1 };
  const provider = { cancel: async () => calls.push({ kind: 'cancel' }), schedule: async value => calls.push({ kind: 'schedule', value }) };
  const context = { console: { warn() {} }, TimeAckCore: globalThis.TimeAckCore, cloneUndoValue: structuredClone,
    isNative: true, LocalNotifications: provider, running: true, breakActive: false, awayActive: false,
    _timerStateOwner: 'uid_alice', timerOwnerDeviceId: 'proof-device', timerStartedAt: now, totalSecs: 1800, lastTaskForRepeat: 'Original work',
    accountingIdentity: () => attachment, accountingCoordinator: () => ({ snapshot: () => ({ history, committed: { value: {
      running: context.running, breakActive: context.breakActive, awayActive: context.awayActive, _timerStateOwner: context._timerStateOwner,
      timerOwnerDeviceId: context.timerOwnerDeviceId, timerStartedAt: context.timerStartedAt, totalSecs: context.totalSecs,
      lastTaskForRepeat: context.lastTaskForRepeat, serverTimer: context._accountingRawTimer } } }) }), _accountingRawTimer: null,
    accountingPendingStop: () => false, isInQuietHours: () => false, swCancelPing: ended => sw.push(ended),
    followupNotifTimer: null, PING_NOTIF_ID: 1001, PING_FOLLOWUP_ID: 1002,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id) };
  context.window = context;
  vm.createContext(context); vm.runInContext(code, context);
  return { context, provider, calls, timers, sw, history,
    project: receipt => context.materializeNativeAccountingPing(receipt),
    flush: async () => { await context._accountingNativePingTail; },
    set now(value) { now = value; }, set attachment(value) { attachment = value; } };
}
test('repeated native projection retains the original endpoint and schedules one stable notification', async () => {
  const f = fixture(); f.now = 1600000;
  await Promise.all([f.project(), f.project(), f.project()]);
  assert.deepEqual(f.calls.map(call => call.kind), ['cancel', 'schedule']);
  assert.equal(f.calls[1].value.notifications[0].schedule.at.getTime(), 2800000);
  assert.equal([...f.timers.values()][0].delay, 1200000);
});
test('provider readiness repairs an earlier unavailable scheduling attempt', async () => {
  const f = fixture(); f.context.LocalNotifications = null; await f.project(); assert.equal(f.calls.length, 0);
  f.context.LocalNotifications = f.provider; await f.project(); assert.equal(f.calls.filter(call => call.kind === 'schedule').length, 1);
});
test('a pending Stop cannot cancel the prior committed running notification', async () => {
  const f = fixture(); await f.project();
  f.context.accountingPendingStop = () => true; await f.project();
  assert.deepEqual(f.calls.map(call => call.kind), ['cancel', 'schedule']);
});
test('unconfirmed legacy timer globals cannot schedule a native ping before a canonical projection exists', async () => {
  const f = fixture(); f.context.accountingCoordinator = () => ({ snapshot: () => ({ history: [], committed: null }) });
  await f.project(); assert.deepEqual(f.calls.map(call => call.kind), ['cancel']);
});
test('native cancellation completes before scheduling and a newer Stop prevents the old schedule', async () => {
  const f = fixture(); let release, observed;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { observed = resolve; });
  const cancel = f.provider.cancel;
  f.provider.cancel = async () => { observed(); await held; return cancel(); };
  const starting = f.project(); await started;
  f.context.running = false; const stopping = f.project(); release(); await Promise.all([starting, stopping]);
  assert.equal(f.calls.filter(call => call.kind === 'schedule').length, 0); assert.equal(f.timers.size, 0);
  f.context.running = true; f.context.timerStartedAt = 1600000; await f.project();
  assert.equal(f.calls.at(-1).kind, 'schedule'); assert.equal(f.calls.at(-1).value.notifications[0].schedule.at.getTime(), 3400000);
});
test('a delayed schedule completing after Stop is cancelled and cannot create a follow-up', async () => {
  const f = fixture(); let release, observed;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { observed = resolve; });
  const schedule = f.provider.schedule;
  f.provider.schedule = async value => { observed(); await held; return schedule(value); };
  const starting = f.project(); await started;
  f.context.running = false; const stopping = f.project(); release(); await Promise.all([starting, stopping]);
  assert.deepEqual(f.calls.map(call => call.kind), ['cancel', 'schedule', 'cancel']); assert.equal(f.timers.size, 0);
});
test('native boot idle and Break cancel stale OS state; resumed timer uses its original new anchor', async () => {
  const f = fixture(); f.context.running = false; await f.project(); assert.equal(f.calls[0].kind, 'cancel');
  f.context.running = true; await f.project();
  f.context.running = false; f.context.breakActive = true; await f.project(); assert.equal(f.calls.at(-1).kind, 'cancel');
  f.context.running = true; f.context.breakActive = false; f.context.timerStartedAt = 1900000; f.now = 2200000;
  await f.project(); assert.equal(f.calls.at(-1).value.notifications[0].schedule.at.getTime(), 3700000);
});
test('captured quiet Ping remains quiet after hydration and does not retire its live SW session', async () => {
  const f = fixture(); await f.project({ effectName: 'ping', effectFacts: { quiet: true } });
  assert.deepEqual(f.calls.map(call => call.kind), ['cancel']); assert.equal(f.sw.at(-1), false);
  f.context._accountingRawTimer = { _csWrite: { operationId: 'original_ping' } };
  f.history.push({ id: 'original_ping', input: { name: 'ping', observation: { facts: { quiet: true } } } });
  await f.project({ effectName: 'hydrate-accounting' }); assert.equal(f.calls.length, 1);
});
test('guard-only timer revisions retain the captured quiet policy of the same original phase', async () => {
  const f = fixture(), timer = { running: true, mode: null, ownerRoom: 'uid_alice', ownerDeviceId: 'proof-device', startedAt: 1000000,
    intervalSecs: 1800, _csWrite: { operationId: 'original_ping' } };
  f.history.push({ id: 'original_ping', input: { name: 'ping', observation: { facts: { quiet: true } } } });
  f.context._accountingRawTimer = timer; await f.project();
  f.history.push({ id: 'guarded_save', input: { name: 'quick-save' }, proposal: { before: { timer } } });
  f.context._accountingRawTimer = { ...timer, _csWrite: { operationId: 'guarded_save' } };
  await f.project({ effectName: 'hydrate-accounting' });
  assert.equal(f.calls.filter(call => call.kind === 'schedule').length, 0);
});
test('quiet due endpoint suppresses native scheduling without retiring the live SW session', async () => {
  const f = fixture(); f.context.isInQuietHours = () => true; await f.project();
  assert.deepEqual(f.calls.map(call => call.kind), ['cancel']); assert.equal(f.sw.at(-1), false);
});
test('same-owner attachment change fences the old follow-up callback', async () => {
  const f = fixture(); await f.project(); const stale = [...f.timers.values()][0].callback;
  f.attachment = { owner: 'uid_alice', uid: 'alice', device: 'proof-device', generation: 3 };
  stale(); await f.flush(); assert.equal(f.calls.filter(call => call.kind === 'schedule').length, 1);
  await f.project(); assert.equal(f.calls.filter(call => call.kind === 'schedule').length, 2);
});
test('native provider failure remains retryable from the same committed state', async () => {
  const f = fixture(), schedule = f.provider.schedule;
  f.provider.schedule = async () => { throw Error('provider unavailable'); };
  await f.project(); f.provider.schedule = schedule; await f.project();
  assert.equal(f.calls.filter(call => call.kind === 'schedule').length, 1);
});
