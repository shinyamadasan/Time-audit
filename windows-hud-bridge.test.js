import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActiveSnapshot,
  buildEndedSnapshot,
  buildTrackingSnapshot,
  hudSessionKey,
  HUD_TRACKING_POLL_MS,
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
  // refresh is page-internal (index.html re-derives after its own timer transitions); it reads nothing from the HUD.
  assert.deepEqual(keys, ['_send', 'isConnected', 'notifyVisibilityChange', 'pushActive', 'pushEnded', 'refresh']);
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
  // TASK-014: the ended snapshot names only the (title-free) session it ends and when.
  assert.deepEqual(Object.keys(calls[1]).sort(), ['claimedAt', 'sessionKey', 'type']);
  assert.equal(calls[1].type, 'focus-ended');
  assert.equal(calls[1].sessionKey, calls[0].sessionKey);
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

// ══════════════════════════════════════════════════════
// TASK-014 — Normal Tracking HUD V1
// ══════════════════════════════════════════════════════

// A tracking-aware bridge: interval 1 is the 1 s tracking poll, created at construction.
function trackingBridge(initialFields = null) {
  const calls = [];
  const timers = fakeTimers();
  const state = { fields: initialFields, clock: 1000 };
  const bridge = createHudBridge({
    fetchImpl: async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: true }; },
    ...timers,
    getTrackingFields: () => state.fields,
    now: () => state.clock
  });
  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  return { bridge, calls, timers, state, flush, poll: () => timers.fire(1) };
}

test('tracking: buildTrackingSnapshot carries only title, start and visibility', () => {
  const snap = buildTrackingSnapshot({ title: 'Write report', startedAt: 5000 });
  assert.deepEqual(Object.keys(snap).sort(), ['pageVisibility', 'startedAt', 'title', 'type']);
  assert.equal(snap.type, 'tracking-active');
  assert.equal(buildTrackingSnapshot({ title: 'x'.repeat(500), startedAt: 1 }).title.length, 200);
});

test('tracking: session keys are title-free and distinguish Focus phases from normal tasks', () => {
  assert.equal(hudSessionKey({ type: 'tracking-active', title: 'Secret', startedAt: 7 }), 'tracking:7');
  assert.equal(hudSessionKey({ type: 'focus-active', phase: 'break', startedAt: 7 }), 'focus:break:7');
  assert.equal(hudSessionKey({ type: 'focus-ended' }), null);
});

test('tracking: normal tracking start is projected with its authoritative start time', async () => {
  const t = trackingBridge();
  t.poll(); await t.flush();
  assert.equal(t.calls.length, 0, 'no authoritative session -> nothing is invented');
  t.state.fields = { title: 'Deep work', startedAt: 900 };
  t.poll(); await t.flush();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].type, 'tracking-active');
  assert.equal(t.calls[0].title, 'Deep work');
  assert.equal(t.calls[0].startedAt, 900);
  assert.equal(t.calls[0].sessionKey, 'tracking:900');
  assert.equal(t.calls[0].claimedAt, 1000);
});

test('tracking: identical state is never re-sent by the poll; only the 4 s heartbeat repeats it', async () => {
  const t = trackingBridge({ title: 'Deep work', startedAt: 900 });
  t.poll(); await t.flush();
  for (let i = 0; i < 10; i++) { t.poll(); await t.flush(); }
  assert.equal(t.calls.length, 1, 'repeated identical polls send nothing new');
  assert.equal(t.timers.intervalFor(2), HUD_HEARTBEAT_MS);
  t.state.clock = 9000;
  t.timers.fire(2); await t.flush();
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1].claimedAt, 1000, 'a heartbeat keeps the original claim stamp');
});

test('tracking: stop clears the snapshot with exactly one ended message and never re-sends it', async () => {
  const t = trackingBridge({ title: 'Deep work', startedAt: 900 });
  t.bridge.refresh(); await t.flush();
  t.state.fields = null; t.state.clock = 5000;
  t.bridge.refresh(); await t.flush();
  assert.equal(t.calls.length, 2);
  assert.deepEqual(t.calls[1], { type: 'focus-ended', sessionKey: 'tracking:900', claimedAt: 5000 });
  assert.equal(t.timers.has(2), false, 'heartbeat stops once nothing is active');
  t.poll(); t.bridge.refresh(); await t.flush();
  assert.equal(t.calls.length, 2, 'a cleared HUD stays cleared - no repeated ended snapshots');
});

test('tracking: a heartbeat after an unhooked stop clears instead of re-sending the completed session', async () => {
  const t = trackingBridge({ title: 'Deep work', startedAt: 900 });
  t.bridge.refresh(); await t.flush();
  t.state.fields = null;
  t.timers.fire(2); await t.flush();
  assert.equal(t.calls.at(-1).type, 'focus-ended');
});

test('tracking: an activity change is a new session with a new claim', async () => {
  const t = trackingBridge({ title: 'Email', startedAt: 900 });
  t.bridge.refresh(); await t.flush();
  t.state.fields = { title: 'Report', startedAt: 2000 }; t.state.clock = 2001;
  t.poll(); await t.flush();
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1].title, 'Report');
  assert.equal(t.calls[1].sessionKey, 'tracking:2000');
  assert.equal(t.calls[1].claimedAt, 2001);
});

test('tracking: Focus wins while active; normal tracking is never shown alongside it', async () => {
  const t = trackingBridge({ title: 'Paused task', startedAt: 900 });
  t.bridge.pushActive({ title: 'Focus task', phase: 'work', startedAt: 3000, plannedEndAt: 4500 });
  await t.flush();
  t.poll(); await t.flush();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].type, 'focus-active');
  assert.equal(t.calls[0].title, 'Focus task');
});

test('tracking: Focus end falls back to normal tracking only when the selector confirms it', async () => {
  const confirmed = trackingBridge({ title: 'Still running', startedAt: 900 });
  confirmed.bridge.pushActive({ title: 'F', phase: 'work', startedAt: 3000, plannedEndAt: 4500 });
  confirmed.state.clock = 5000;
  confirmed.bridge.pushEnded(); await confirmed.flush();
  assert.equal(confirmed.calls.at(-1).type, 'tracking-active');
  assert.equal(confirmed.calls.at(-1).claimedAt, 5000);

  const released = trackingBridge(null);
  released.bridge.pushActive({ title: 'F', phase: 'work', startedAt: 3000, plannedEndAt: 4500 });
  released.bridge.pushEnded(); await released.flush();
  assert.equal(released.calls.at(-1).type, 'focus-ended');
});

test('tracking: a throwing or malformed selector is treated as "no session", never fabricated', async () => {
  for (const bad of [{ title: '', startedAt: 1 }, { title: 'x', startedAt: NaN }, { title: 'x', startedAt: 0 }, 'str']) {
    const t = trackingBridge(bad);
    t.bridge.refresh(); await t.flush();
    assert.equal(t.calls.length, 0, `rejected ${JSON.stringify(bad)}`);
  }
  const calls = [];
  const bridge = createHudBridge({
    fetchImpl: async (u, o) => { calls.push(o); return { ok: true }; },
    setIntervalImpl: () => 1, clearIntervalImpl: () => {},
    getTrackingFields: () => { throw new Error('boom'); }
  });
  assert.doesNotThrow(() => bridge.refresh());
  assert.equal(calls.length, 0);
});

test('tracking: no companion running never throws and is reported as disconnected', async () => {
  const bridge = createHudBridge({
    fetchImpl: async () => { throw new Error('Failed to fetch'); },
    setIntervalImpl: () => 1, clearIntervalImpl: () => {},
    getTrackingFields: () => ({ title: 'Deep work', startedAt: 900 })
  });
  await assert.doesNotReject(async () => { bridge.refresh(); await Promise.resolve(); await Promise.resolve(); });
  assert.equal(bridge.isConnected(), false);
});

test('tracking: a Focus-only bridge (no selector) never polls; the 1 s poll exists only with a selector', () => {
  const timers = fakeTimers();
  createHudBridge({ fetchImpl: async () => ({ ok: true }), ...timers });
  assert.equal(timers.has(1), false);
  assert.equal(trackingBridge().timers.intervalFor(1), HUD_TRACKING_POLL_MS);
});
