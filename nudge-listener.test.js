import test from 'node:test';
import assert from 'node:assert/strict';
import { nudgeHarness } from './nudge-test-support.js';

function inbox({ denied = true, replay = true, nudge = { ts: 100_000, from: 'Partner' }, key = 'n1' } = {}) {
  let callback;
  let writes = 0;
  const snapshot = { key, val: () => nudge, ref: { remove() {
    writes++;
    // Firebase locally removes then restores a rejected write, delivering child_added again.
    if (denied && replay && writes < 8) callback(snapshot);
    return denied ? Promise.reject(new Error('permission_denied')) : Promise.resolve();
  } } };
  return { ref: { on: (_event, fn) => { callback = fn; }, off() {} },
    emit: () => callback(snapshot), get writes() { return writes; }, snapshot,
    callback: () => callback };
}

test('denied cleanup replay performs one write and one toast, with an observable rejection', async () => {
  const warnings = [], toasts = [], box = inbox();
  nudgeHarness({ warn: (...args) => warnings.push(args) }).attach('alice', box.ref, text => toasts.push(text));
  box.emit();
  await Promise.resolve();
  assert.equal(box.writes, 1);
  assert.equal(toasts.length, 1);
  assert.equal(warnings.length, 1);
});

test('deduplication survives reattach, A/B/A switch and same-tab reload, with IDs isolated by UID', () => {
  const storage = new Map(), toasts = [];
  let harness = nudgeHarness({ storage });
  const first = inbox({ denied: false });
  let detach = harness.attach('alice', first.ref, text => toasts.push(text));
  first.emit(); detach();
  const again = inbox({ denied: false });
  detach = harness.attach('alice', again.ref, text => toasts.push(text));
  again.emit(); detach();
  const bob = inbox({ denied: false });
  detach = harness.attach('bob', bob.ref, text => toasts.push(text));
  bob.emit(); detach();
  const back = inbox({ denied: false });
  detach = harness.attach('alice', back.ref, text => toasts.push(text));
  back.emit(); detach();
  harness = nudgeHarness({ storage });
  const reload = inbox({ denied: false });
  harness.attach('alice', reload.ref, text => toasts.push(text)); reload.emit();
  assert.deepEqual([first.writes, again.writes, bob.writes, back.writes, reload.writes], [1, 0, 1, 0, 0]);
  assert.equal(toasts.length, 2);
});

test('stale generation, signout, old listener and changed authenticated UID do no work', () => {
  const harness = nudgeHarness(), toasts = [], first = inbox({ denied: false });
  const replaced = inbox({ denied: false });
  harness.attach('alice', replaced.ref, text => toasts.push(text));
  const oldSameUser = replaced.callback();
  const detach = harness.attach('alice', first.ref, text => toasts.push(text));
  oldSameUser(replaced.snapshot); // exact-ref guard, even with the same authenticated UID
  const queued = first.callback(); detach();
  harness.attach('bob', inbox({ denied: false }).ref, text => toasts.push(text));
  queued(first.snapshot);
  harness.switchUser('bob');
  const alice = inbox({ denied: false });
  harness.attach('alice', alice.ref, text => toasts.push(text));
  harness.switchUser('bob'); alice.emit();
  harness.switchUser(null); alice.emit();
  assert.equal(replaced.writes + first.writes + alice.writes, 0);
  assert.equal(toasts.length, 0);
});

test('stale and malformed children clean up once without a toast; fresh new IDs still deliver', async () => {
  for (const nudge of [null, {}, { ts: 1 }, { ts: '100000' }, { ts: Infinity }]) {
    const harness = nudgeHarness(), box = inbox({ nudge }), toasts = [];
    harness.attach('alice', box.ref, text => toasts.push(text)); box.emit(); box.emit();
    await Promise.resolve();
    assert.equal(box.writes, 1);
    assert.equal(toasts.length, 0);
  }
  const harness = nudgeHarness(), toasts = [];
  for (const key of ['n1', 'n2']) {
    const box = inbox({ key, denied: false });
    harness.attach('alice', box.ref, text => toasts.push(text)); box.emit();
    assert.equal(box.writes, 1);
  }
  assert.equal(toasts.length, 2);
});

test('unavailable session storage keeps the in-memory replay/reattach guard', async () => {
  const storage = { get() { throw new Error('storage blocked'); }, set() { throw new Error('quota'); } };
  const harness = nudgeHarness({ storage }), box = inbox(), toasts = [];
  harness.attach('alice', box.ref, text => toasts.push(text)); box.emit();
  harness.attach('alice', box.ref, text => toasts.push(text)); box.emit();
  await Promise.resolve();
  assert.equal(box.writes, 1);
  assert.equal(toasts.length, 1);
});
