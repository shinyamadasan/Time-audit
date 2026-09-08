import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActiveSnapshot,
  buildEndedSnapshot,
  createHudBridge,
  HUD_BRIDGE_URL,
  HUD_HEARTBEAT_MS
} from './windows-hud-bridge.js';

function fakeTimers() {
  const scheduled = new Map();
  let nextId = 1;
  return {
    setIntervalImpl: (fn, ms) => { const id = nextId++; scheduled.set(id, { fn, ms }); return id; },
    clearIntervalImpl: (id) => { scheduled.delete(id); },
    fire: (id) => scheduled.get(id).fn(),
    has: (id) => scheduled.has(id),
    intervalFor: (id) => scheduled.get(id)?.ms
  };
}

// document.visibilityState is read fresh by buildActiveSnapshot; this repo
// has no DOM in its Node test environment, so tests that need a specific
// visibility value stub a minimal `document` for the duration of the test.
function withDocumentVisibility(value, fn) {
  const had = 'document' in globalThis;
  const prior = globalThis.document;
  globalThis.document = { visibilityState: value };
  try { return fn(); } finally {
    if (had) globalThis.document = prior; else delete globalThis.document;
  }
}

test('buildActiveSnapshot normalizes fields and never fabricates values', () => {
  const snap = buildActiveSnapshot({ title: 'Deep work', phase: 'work', startedAt: 1000, plannedEndAt: 2000, linkType: 'daily-routine', deviceOwned: true });
  assert.equal(snap.type, 'focus-active');
  assert.equal(snap.title, 'Deep work');
  assert.equal(snap.phase, 'work');
  assert.equal(snap.startedAt, 1000);
  assert.equal(snap.plannedEndAt, 2000);
  assert.equal(snap.linkType, 'daily-routine');
  assert.equal(snap.deviceOwned, true);
});

test('buildActiveSnapshot falls back to a generic title and clamps phase to work/break', () => {
  const snap = buildActiveSnapshot({ title: '', phase: 'bogus', startedAt: NaN, plannedEndAt: NaN });
  assert.equal(snap.title, 'Focus session');
  assert.equal(snap.phase, 'work');
  assert.equal(typeof snap.startedAt, 'number');
});

test('buildActiveSnapshot truncates absurdly long titles', () => {
  const snap = buildActiveSnapshot({ title: 'x'.repeat(500) });
  assert.equal(snap.title.length, 200);
});

test('buildEndedSnapshot carries no leftover session fields', () => {
  assert.deepEqual(buildEndedSnapshot(), { type: 'focus-ended' });
});

test('a pure projection: the snapshot only ever reflects fields it was given, never invents session identity', () => {
  const snap = buildActiveSnapshot({ title: 'Write report', phase: 'work', startedAt: 1, plannedEndAt: 2 });
  const keys = Object.keys(snap).sort();
  assert.deepEqual(keys, ['deviceOwned', 'linkType', 'pageVisibility', 'phase', 'plannedEndAt', 'startedAt', 'title', 'type']);
});

test('createHudBridge exposes no outbound command mechanism of any kind', () => {
  const bridge = createHudBridge({ fetchImpl: async () => ({ ok: true }), setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
  const keys = Object.keys(bridge).sort();
  assert.deepEqual(keys, ['_send', 'isConnected', 'notifyVisibilityChange', 'pushActive', 'pushEnded']);
  assert.equal('onEndCommand' in bridge, false);
});

test('a response body is never parsed or acted on — status alone decides connected/not', async () => {
  let jsonWasCalled = false;
  const fetchImpl = async () => ({
    ok: true,
    // If the bridge ever reads a response body again, this proves it —
    // reintroducing a command channel would call this.
    json: async () => { jsonWasCalled = true; return { command: 'end-focus' }; }
  });
  const bridge = createHudBridge({ fetchImpl, setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
  bridge.pushActive({ title: 'A', phase: 'work', startedAt: 1, plannedEndAt: 2 });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(jsonWasCalled, false);
});

test('linkType: none, daily-routine, and learning-plan all round-trip correctly', () => {
  assert.equal(buildActiveSnapshot({ linkType: 'none' }).linkType, 'none');
  assert.equal(buildActiveSnapshot({ linkType: 'daily-routine' }).linkType, 'daily-routine');
  assert.equal(buildActiveSnapshot({ linkType: 'learning-plan' }).linkType, 'learning-plan');
});

test('linkType falls back to "none" for anything unrecognized — never fabricates a link', () => {
  assert.equal(buildActiveSnapshot({ linkType: undefined }).linkType, 'none');
  assert.equal(buildActiveSnapshot({ linkType: 'scheduled' }).linkType, 'none'); // the old, removed boolean-era name
  assert.equal(buildActiveSnapshot({ linkType: true }).linkType, 'none');
});

test('pageVisibility reflects document.visibilityState at push time: visible', () => {
  withDocumentVisibility('visible', () => {
    const snap = buildActiveSnapshot({ title: 'A' });
    assert.equal(snap.pageVisibility, 'visible');
  });
});

test('pageVisibility reflects document.visibilityState at push time: hidden', () => {
  withDocumentVisibility('hidden', () => {
    const snap = buildActiveSnapshot({ title: 'A' });
    assert.equal(snap.pageVisibility, 'hidden');
  });
});

test('pageVisibility defaults to visible when there is no document at all (non-browser test context)', () => {
  const had = 'document' in globalThis;
  const prior = globalThis.document;
  delete globalThis.document;
  try {
    const snap = buildActiveSnapshot({ title: 'A' });
    assert.equal(snap.pageVisibility, 'visible');
  } finally {
    if (had) globalThis.document = prior;
  }
});

test('notifyVisibilityChange immediately re-pushes the last active fields with fresh visibility, bypassing the in-flight guard', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: true }; };
  const bridge = createHudBridge({ fetchImpl, setIntervalImpl: () => 1, clearIntervalImpl: () => {} });

  withDocumentVisibility('visible', () => bridge.pushActive({ title: 'A', phase: 'work', startedAt: 1, plannedEndAt: 2 }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pageVisibility, 'visible');

  withDocumentVisibility('hidden', () => bridge.notifyVisibilityChange());
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 2, 'visibilitychange must force an immediate push');
  assert.equal(calls[1].pageVisibility, 'hidden');
  assert.equal(calls[1].title, 'A', 'the rebuilt snapshot still reflects the real last-known Focus fields');
});

test('notifyVisibilityChange with no active session is a silent no-op', async () => {
  const calls = [];
  const fetchImpl = async () => { calls.push(1); return { ok: true }; };
  const bridge = createHudBridge({ fetchImpl, setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
  bridge.notifyVisibilityChange();
  await Promise.resolve();
  assert.equal(calls.length, 0);
});

test('pushActive POSTs to the loopback bridge URL and starts a bounded heartbeat', async () => {
  const calls = [];
  const timers = fakeTimers();
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true };
  };
  const bridge = createHudBridge({ fetchImpl, ...timers });
  bridge.pushActive({ title: 'Write report', phase: 'work', startedAt: 1, plannedEndAt: 2 });
  await Promise.resolve(); await Promise.resolve();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HUD_BRIDGE_URL);
  assert.equal(calls[0].body.type, 'focus-active');
  assert.equal(calls[0].body.title, 'Write report');
});

test('heartbeat re-sends the last snapshot at the documented bounded interval, never faster — foreground or background alike', async () => {
  const calls = [];
  const timers = fakeTimers();
  const fetchImpl = async () => { calls.push(Date.now()); return { ok: true }; };
  const bridge = createHudBridge({ fetchImpl, ...timers });
  bridge.pushActive({ title: 'A', phase: 'work', startedAt: 1, plannedEndAt: 2 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 1);

  // Simulate the interval firing — must reuse the same bounded interval, not tick per-second.
  // (This is the browser-side interval only; real Chromium background-tab
  // throttling further slows how often this callback actually fires once
  // the tab is hidden — see windows-hud/README.md's "Real background test"
  // for the measured effect that has on actual bridge-contact intervals.)
  const activeIntervalId = 1;
  assert.equal(timers.intervalFor(activeIntervalId), HUD_HEARTBEAT_MS);
  timers.fire(activeIntervalId);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 2, 'heartbeat should have re-sent exactly once');
});

test('heartbeat never stacks a new request behind an in-flight one', async () => {
  let resolveFirst;
  let callCount = 0;
  const timers = fakeTimers();
  const fetchImpl = () => {
    callCount++;
    return new Promise((resolve) => { resolveFirst = resolve; });
  };
  const bridge = createHudBridge({ fetchImpl, ...timers });
  bridge.pushActive({ title: 'A', phase: 'work', startedAt: 1, plannedEndAt: 2 });
  assert.equal(callCount, 1);

  // Fire the heartbeat while the first request is still in flight.
  timers.fire(1);
  await Promise.resolve();
  assert.equal(callCount, 1, 'a slow in-flight request must not be joined by a second heartbeat call');

  resolveFirst({ ok: true });
});

test('pushEnded stops the heartbeat and sends exactly one ended snapshot; the HUD unambiguously hides', async () => {
  const calls = [];
  const timers = fakeTimers();
  const fetchImpl = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: true }; };
  const bridge = createHudBridge({ fetchImpl, ...timers });
  bridge.pushActive({ title: 'A', phase: 'work', startedAt: 1, plannedEndAt: 2 });
  await Promise.resolve(); await Promise.resolve();
  bridge.pushEnded();
  await Promise.resolve(); await Promise.resolve();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { type: 'focus-ended' });
  assert.equal(timers.has(1), false, 'heartbeat interval must be cleared on end');
});

test('pushEnded with no prior active push is a silent no-op (never fabricates a session to end)', async () => {
  const calls = [];
  const fetchImpl = async () => { calls.push(1); return { ok: true }; };
  const bridge = createHudBridge({ fetchImpl, setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
  bridge.pushEnded();
  await Promise.resolve();
  assert.equal(calls.length, 0);
});

test('no companion running (fetch rejects) never throws and is reported as disconnected — remains harmless', async () => {
  const statuses = [];
  const fetchImpl = async () => { throw new Error('Failed to fetch'); };
  const bridge = createHudBridge({
    fetchImpl,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
    onStatusChange: (v) => statuses.push(v)
  });
  await assert.doesNotReject(async () => {
    bridge.pushActive({ title: 'A', phase: 'work', startedAt: 1, plannedEndAt: 2 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
  assert.deepEqual(statuses, [false]);
  assert.equal(bridge.isConnected(), false);
});

test('onStatusChange only fires on actual transitions, not on every repeated push', async () => {
  const statuses = [];
  const fetchImpl = async () => ({ ok: true });
  const bridge = createHudBridge({
    fetchImpl,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
    onStatusChange: (v) => statuses.push(v)
  });
  bridge.pushActive({ title: 'A', phase: 'work', startedAt: 1, plannedEndAt: 2 });
  await Promise.resolve(); await Promise.resolve();
  bridge.pushActive({ title: 'A', phase: 'work', startedAt: 1, plannedEndAt: 2 });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(statuses, [true]);
});
