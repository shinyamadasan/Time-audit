import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskCompletionSync } from './task-completion-sync.js';
import { completionIdentity } from './task-completion-model.js';
import { createCompletionHandler, resolutionKey } from './functions/src/completion-api.js';
import { fixture, NOW, memory } from './task-completion-test-support.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup() {
  const f = fixture(), io = memory(f.room), data = new Map(), listeners = new Map();
  const storage = { get length() { return data.size; }, key: n => [...data.keys()][n], getItem: k => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  let uid = 'alice', hold = null, fault = null, calls = [];
  io.readResolution = async (_uid, key) => io.value().taskCompletionResolutions?.[key] || null;
  const handler = createCompletionHandler({ verifyIdToken: async token => ({ uid: token }), domain: io, now: () => NOW });
  const roomRef = { child(path) { return { on: (_event, fn, error) => listeners.set(path, { fn, error }), off: () => listeners.delete(path) }; } };
  const context = () => ({ uid, roomRef, endpoint: 'https://offline.invalid/completion', getIdToken: async () => uid });
  const fetchImpl = async (_url, options) => {
    const input = JSON.parse(options.body); calls.push(input);
    const result = await handler({ method: 'POST', authorization: options.headers.authorization, rawBody: Buffer.from(options.body) });
    if (hold) await hold(input);
    if (fault) return fault(input, result);
    return { json: async () => result.body };
  };
  const sync = createTaskCompletionSync({ context, storage, fetchImpl });
  const entry = { target: { store: f.identity.store, id: f.identity.targetId }, item: f.item };
  sync.ensure([entry]);
  return { ...f, io, data, listeners, sync, entry, storage, context, fetchImpl, calls,
    owner: value => { uid = value; sync.reset(); }, hold: value => { hold = value; }, fault: value => { fault = value; } };
}
async function ready(w) { await w.sync.refresh(); await tick(); assert.equal(w.sync.view(w.entry)?.state, 'unfinished'); }

test('real handler/client: complete earlier, reload, second client and conditional Undo preserve history', async () => {
  const w = setup(); await ready(w);
  const result = await w.sync.complete(w.entry, '2026-10-12', 'Etc/UTC');
  assert.equal(result.outcome, 'CONFIRMED'); assert.equal(w.sync.pendingAll().length, 0);
  assert.equal(w.sync.view(w.entry).state, 'completed');
  assert.equal(result.receipt.date, '2026-10-12');
  assert.deepEqual(w.io.value().calendarPlans, w.room.calendarPlans);
  const second = createTaskCompletionSync({ context: w.context, storage: w.storage, fetchImpl: w.fetchImpl });
  second.ensure([w.entry]); await second.refresh(); assert.equal(second.view(w.entry).state, 'completed');
  const undo = await second.undo({ uid: 'alice', record: result.record });
  assert.equal(undo.outcome, 'CONFIRMED'); assert.equal(undo.record.state, 'open');
  assert.equal(Object.keys(undo.record.operations).length, 2);
  w.sync.reset(); second.reset();
});
test('duplicate click shares one dispatched operation', async () => {
  const w = setup(); await ready(w);
  const result = await Promise.all([w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC'), w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC')]);
  assert.equal(result[0].outcome, 'CONFIRMED'); assert.equal(result[0].request.operationId, result[1].request.operationId);
  assert.equal(w.calls.filter(call => call.kind === 'mutate').length, 1); w.sync.reset();
});

test('fresh completion reuses inspection, while invalidation requires another inspection', async () => {
  const w = setup(); await ready(w);
  let start = w.calls.length;
  const done = await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  assert.equal(done.outcome, 'CONFIRMED');
  assert.deepEqual(w.calls.slice(start).map(call => call.kind), ['mutate', 'inspect']);
  await w.sync.undo({ uid: 'alice', record: done.record });
  w.listeners.get('settings').fn(); start = w.calls.length;
  assert.equal((await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC')).outcome, 'CONFIRMED');
  assert.deepEqual(w.calls.slice(start).map(call => call.kind), ['inspect', 'mutate', 'inspect']);
  w.sync.reset();
});

test('cached source and zone never bypass backend validation of a later remote change', async () => {
  for (const change of [room => { room.settings.timezone = 'Asia/Tokyo'; },
    room => { room.calendarPlans[wTarget(room)].items[0].task = 'edited remotely'; }]) {
    const w = setup(); await ready(w);
    w.io.change(room => { change(room); return room; }); // listener has not delivered yet
    const result = await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
    assert.equal(result.outcome, 'REJECTED');
    assert.equal(w.io.value().taskCompletionResolutions, undefined);
    assert.equal(w.sync.pendingAll().length, 0); w.sync.reset();
  }
  function wTarget(room) { return Object.keys(room.calendarPlans)[0]; }
});

test('concurrent Undo and status recovery share one operation and preserve its ID', async () => {
  const w = setup(); await ready(w);
  const done = await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  let release;
  w.hold(async input => { if (input.kind === 'mutate') await new Promise(resolve => { release = resolve; }); });
  const receipt = { uid: 'alice', record: done.record };
  const first = w.sync.undo(receipt), second = w.sync.undo(receipt);
  while (!release) await tick();
  const staged = w.sync.pendingAll()[0];
  const recovered = w.sync.resume(staged);
  assert.equal(w.sync.saving(), true); assert.equal(w.sync.active(staged), true);
  release();
  const results = await Promise.all([first, second, recovered]);
  assert.ok(results.every(result => result.outcome === 'CONFIRMED' && result.request.operationId === staged.operationId));
  assert.equal(w.calls.filter(call => call.kind === 'mutate' && call.request.kind === 'undo').length, 1);
  assert.equal(w.calls.filter(call => call.kind === 'status').length, 0);
  assert.equal(w.sync.saving(), false); w.sync.reset();
});

test('known offline refuses both actions without staging or network requests', async t => {
  const w = setup(); await ready(w);
  const done = await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  const calls = w.calls.length;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis.navigator, 'onLine', descriptor); else delete globalThis.navigator.onLine; });
  assert.equal((await w.sync.undo({ uid: 'alice', record: done.record })).reason, 'SOURCE_UNAVAILABLE');
  assert.equal((await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC')).reason, 'SOURCE_UNAVAILABLE');
  assert.equal(w.calls.length, calls); assert.equal(w.sync.pendingAll().length, 0); w.sync.reset();
});

test('going offline after a lost acknowledgement preserves UNKNOWN and the exact pending intent', async t => {
  const w = setup(); await ready(w);
  w.fault((input, result) => { if (input.kind === 'mutate') throw Error('lost acknowledgement'); return { json: async () => result.body }; });
  const unknown = await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  assert.equal(unknown.outcome, 'UNKNOWN');
  const pending = w.sync.pendingAll()[0], calls = w.calls.length;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis.navigator, 'onLine', descriptor); else delete globalThis.navigator.onLine; });
  const retry = await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  assert.equal(retry.outcome, 'UNKNOWN'); assert.deepEqual(retry.request, pending);
  const record = Object.values(w.io.value().taskCompletionResolutions)[0];
  const undo = await w.sync.undo({ uid: 'alice', record });
  assert.equal(undo.outcome, 'UNKNOWN'); assert.deepEqual(undo.request, pending);
  assert.equal(w.calls.length, calls); assert.deepEqual(w.sync.pendingAll(), [pending]); w.sync.reset();
});
test('lost acknowledgement keeps original operation pending; reload recovers exact receipt', async () => {
  const w = setup(); await ready(w);
  w.fault((input, result) => { if (input.kind === 'mutate') throw new Error('response lost'); return { json: async () => result.body }; });
  const unknown = await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  assert.equal(unknown.outcome, 'UNKNOWN'); assert.equal(w.sync.pendingAll().length, 1);
  w.fault(null); w.sync.reset(); w.sync.ensure([w.entry]); await w.sync.refresh();
  const recovered = await w.sync.resume(w.sync.pendingAll()[0]);
  assert.equal(recovered.outcome, 'CONFIRMED'); assert.equal(w.sync.pendingAll().length, 0);
  assert.equal(recovered.record.revision, 1); w.sync.reset();
});
test('forged receipt for another operation is UNKNOWN and retained for recovery', async () => {
  const w = setup(); await ready(w);
  w.fault((input, result) => ({ json: async () => input.kind === 'mutate' ? { ...result.body, receipt: { ...result.body.receipt, intentHash: 'x'.repeat(43) } } : result.body }));
  const result = await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  assert.equal(result.outcome, 'UNKNOWN'); assert.equal(w.sync.pendingAll().length, 1); w.sync.reset();
});
test('pending storage failure refuses before mutation; account switch never dispatches old owner request', async () => {
  const w = setup(); await ready(w);
  w.storage.setItem = () => { throw new Error('quota'); };
  assert.equal((await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC')).reason, 'RECEIPT_STORAGE_UNAVAILABLE');
  assert.equal(w.calls.filter(call => call.kind === 'mutate').length, 0);
  w.owner('bob'); assert.equal(w.sync.pendingAll().length, 0);
  assert.equal((await w.sync.undo({ uid: 'alice', record: {} })).reason, 'ACCOUNT_CHANGED'); w.sync.reset();
});
test('listener initial event during inspection invalidates old response and refreshes source', async () => {
  const w = setup(); await ready(w);
  let release, once = true;
  w.hold(async input => { if (once && input.kind === 'inspect') { once = false; await new Promise(resolve => { release = resolve; }); } });
  const pending = w.sync.refresh(); await tick();
  w.io.change(room => { room.calendarPlans[w.targetKey].items[0].task = 'changed remotely'; return room; });
  w.listeners.get('calendarPlans').fn(); release(); await pending; await tick(); await w.sync.refresh();
  assert.equal(w.sync.view(w.entry).state, 'needs-review'); w.sync.reset();
});
test('listener cancellation prevents inflight inspection from restoring fresh completion', async () => {
  const w = setup(); await ready(w);
  await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  let release; w.hold(async input => { if (input.kind === 'inspect') await new Promise(resolve => { release = resolve; }); });
  const pending = w.sync.refresh(); await tick();
  w.listeners.get('calendarPlans').error(new Error('permission denied')); release(); await pending; await tick();
  assert.notEqual(w.sync.view(w.entry).state, 'completed'); w.sync.reset();
});
test('late response after A → B → A cannot clear or confirm an old in-flight command', async () => {
  const w = setup(); await ready(w);
  let release; w.hold(async input => { if (input.kind === 'mutate') await new Promise(resolve => { release = resolve; }); });
  const pending = w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  while (!release) await tick();
  w.owner('bob'); w.owner('alice'); release();
  assert.equal((await pending).outcome, 'UNKNOWN'); assert.equal(w.sync.pendingAll().length, 1); w.sync.reset();
});
test('alias added in another source namespace invalidates completed projection', async () => {
  const w = setup(); await ready(w); await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  w.io.change(room => { room.plans = { '2026-10-10': { items: [{ ...w.item }] } }; return room; });
  w.listeners.get('plans').fn(); await w.sync.refresh();
  assert.notEqual(w.sync.view(w.entry).state, 'completed');
  assert.equal(w.io.value().taskCompletionResolutions[resolutionKey('alice', completionIdentity(w.entry.target, w.item))].state, 'completed');
  w.sync.reset();
});
test('A → B → A during acknowledgement digest cannot finish an old-generation pending receipt', async () => {
  const w = setup(); await ready(w);
  const original = globalThis.crypto.subtle.digest;
  let release;
  w.fault((input, result) => ({ json: async () => {
    if (input.kind === 'mutate') globalThis.crypto.subtle.digest = function (...args) {
      return new Promise(resolve => { release = () => resolve(original.apply(this, args)); });
    };
    return result.body;
  } }));
  try {
    const pending = w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
    while (!release) await tick();
    w.owner('bob'); w.owner('alice'); globalThis.crypto.subtle.digest = original; release();
    assert.equal((await pending).outcome, 'UNKNOWN'); assert.equal(w.sync.pendingAll().length, 1);
  } finally { globalThis.crypto.subtle.digest = original; w.sync.reset(); }
});
test('inspect cannot hide a task on completed label without a durable matching head', async () => {
  const w = setup(); await ready(w);
  w.fault((input, result) => ({ json: async () => input.kind === 'inspect'
    ? { ...result.body, views: result.body.views.map(view => ({ ...view, state: 'completed', record: null })) } : result.body }));
  await w.sync.refresh(); assert.notEqual(w.sync.view(w.entry).state, 'completed'); w.sync.reset();
});
test('inspect cannot hide a task with another identity or a mismatched source receipt', async () => {
  const w = setup(); await ready(w); await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  w.fault((input, result) => ({ json: async () => input.kind === 'inspect'
    ? { ...result.body, views: result.body.views.map(view => ({ ...view, sourceRevision: 'x'.repeat(43) })) } : result.body }));
  await w.sync.refresh(); assert.notEqual(w.sync.view(w.entry).state, 'completed');
  w.fault((input, result) => ({ json: async () => input.kind === 'inspect'
    ? { ...result.body, views: result.body.views.map(view => ({ ...view, record: { ...view.record, identity: { ...view.record.identity, itemId: 'other' } } })) } : result.body }));
  await w.sync.refresh(); assert.notEqual(w.sync.view(w.entry).state, 'completed'); w.sync.reset();
});
test('missing or duplicate inspection views invalidate any prior completed projection', async () => {
  const w = setup(); await ready(w); await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  const other = { ...w.entry, item: { ...w.item, id: 'another' } };
  w.io.change(room => { room.calendarPlans[w.targetKey].items.push(other.item); return room; });
  w.sync.ensure([w.entry, other]); await w.sync.refresh();
  assert.equal(w.sync.view(w.entry).state, 'completed');
  for (const duplicate of [false, true]) {
    w.fault((input, result) => ({ json: async () => input.kind === 'inspect'
      ? { ...result.body, views: duplicate ? [result.body.views[0], result.body.views[0]] : [] } : result.body }));
    await w.sync.refresh(); assert.notEqual(w.sync.view(w.entry).state, 'completed');
  }
  w.sync.reset();
});
test('fresh device: completion uses the account zone from the authoritative inspection, never the device zone', async () => {
  const w = setup(); await ready(w);
  assert.equal(w.sync.accountTimezone(), 'Etc/UTC');
  const before = w.calls.length;
  // Device-locked zone differs from rooms/<uid>/settings/timezone (observed in staging: "UTC" vs "Etc/UTC").
  const mismatch = await w.sync.complete(w.entry, '2026-10-15', 'UTC');
  assert.deepEqual([mismatch.outcome, mismatch.reason], ['REJECTED', 'ACCOUNT_ZONE_CHANGED']);
  assert.equal(w.calls.slice(before).filter(call => call.kind === 'mutate').length, 0, 'no request in a zone the account does not use');
  assert.equal(w.sync.pendingAll().length, 0); assert.equal(w.io.value().taskCompletionResolutions, undefined);
  const ok = await w.sync.complete(w.entry, '2026-10-15', w.sync.accountTimezone());
  assert.equal(ok.outcome, 'CONFIRMED'); assert.equal(ok.receipt.timezone, 'Etc/UTC');
  w.sync.reset(); assert.equal(w.sync.accountTimezone(), null, 'account reset forgets the zone');
});
test('account zone is invalidated by any room change and absent zones refuse completion', async () => {
  const w = setup(); await ready(w);
  w.listeners.get('settings').fn();
  assert.equal(w.sync.accountTimezone(), null, 'a settings event makes the observed zone stale until re-inspected');
  await new Promise(resolve => setTimeout(resolve, 200)); await w.sync.refresh(); await tick();
  assert.equal(w.sync.accountTimezone(), 'Etc/UTC');
  // An inspection without an account zone (e.g. an older server) leaves views fresh but no zone: refuse, never guess.
  w.fault((input, result) => ({ json: async () => input.kind === 'inspect' ? { ...result.body, timezone: undefined } : result.body }));
  w.listeners.get('settings').fn(); await new Promise(resolve => setTimeout(resolve, 200)); await w.sync.refresh(); await tick();
  assert.equal(w.sync.view(w.entry)?.state, 'unfinished'); assert.equal(w.sync.accountTimezone(), null);
  const refused = await w.sync.complete(w.entry, '2026-10-15', 'Etc/UTC');
  assert.deepEqual([refused.outcome, refused.reason], ['REJECTED', 'ACCOUNT_ZONE_UNAVAILABLE']);
  assert.equal(w.io.value().taskCompletionResolutions, undefined); w.sync.reset();
});
test('common case: a room event just before the click still completes; zone and today come from the post-refresh view', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW }); // align client "today" with the test server clock
  const w = setup(); await ready(w);
  w.listeners.get('plans').fn(); // e.g. this device's own previous write: zone is stale at click time
  assert.equal(w.sync.accountTimezone(), null);
  const today = await w.sync.complete(w.entry); // Done today: no pre-captured date or zone
  assert.equal(today.outcome, 'CONFIRMED', JSON.stringify(today));
  assert.deepEqual([today.receipt.date, today.receipt.timezone], ['2026-10-15', 'Etc/UTC']);
  const undo = await w.sync.undo({ uid: 'alice', record: today.record }); assert.equal(undo.outcome, 'CONFIRMED');
  w.listeners.get('settings').fn();
  const earlier = await w.sync.complete(w.entry, '2026-10-13'); // Done earlier: explicit date, zone from the account
  assert.equal(earlier.outcome, 'CONFIRMED', JSON.stringify(earlier));
  assert.deepEqual([earlier.receipt.date, earlier.receipt.timezone], ['2026-10-13', 'Etc/UTC']);
  w.sync.reset();
});
