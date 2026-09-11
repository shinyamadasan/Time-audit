// node --test browser-extension/time-truth-idle.test.js
//
// Time Truth V1 — the browser extension previously had no idle/lock signal at all
// (confirmed absent in the pre-milestone audit: no chrome.idle usage anywhere) and
// trusted raw elapsed wall-clock time unconditionally across the periodic 5-minute
// flush alarm and service-worker restarts. That let computer sleep, browser
// suspension, or a long-dead service worker silently read as continuous browsing
// activity. This is the smallest deterministic harness needed to prove the fix：a
// minimal in-memory mock of the handful of chrome.* APIs background.js actually
// uses (storage.local, idle, alarms, tabs, windows, runtime, notifications), with no
// browser, no real extension loader, and no network (fetch is stubbed per test).
//
// Each test gets a fresh mock and a fresh dynamic import of background.js (import
// bypasses Node's module cache per-instance via a cache-busting query string) so
// module-level state (activeTab, lastHeartbeat, userTimezoneConfirmed, …) never
// leaks between tests.

import assert from 'node:assert/strict';
import test from 'node:test';

const BACKGROUND_URL = new URL('./background.js', import.meta.url);
let importCounter = 0;

function makeChromeMock({ now = 1_000_000_000_000, activeTabFixture = null, idleState = 'active' } = {}) {
  const store = {};
  if (activeTabFixture) Object.assign(store, activeTabFixture);
  const idleListeners = [];
  const alarmListeners = [];
  const tabActivatedListeners = [];
  const state = { idleState, currentTime: now };

  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          list.forEach(k => { if (k in store) out[k] = store[k]; });
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (key) => { (Array.isArray(key) ? key : [key]).forEach(k => delete store[k]); }
      }
    },
    idle: {
      setDetectionInterval: () => {},
      queryState: async () => state.idleState,
      onStateChanged: { addListener: (cb) => idleListeners.push(cb) }
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: (cb) => alarmListeners.push(cb) }
    },
    tabs: {
      query: (_opts, cb) => cb([]),
      get: (_id, cb) => cb && cb(null),
      onActivated: { addListener: (cb) => tabActivatedListeners.push(cb) },
      onUpdated: { addListener: () => {} }
    },
    windows: {
      onFocusChanged: { addListener: () => {} },
      WINDOW_ID_NONE: -1
    },
    runtime: {
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} }
    },
    notifications: { create: () => {}, onButtonClicked: { addListener: () => {} } },
    identity: {}
  };

  return {
    chrome,
    store,
    fireIdleState: (s) => { state.idleState = s; idleListeners.forEach(cb => cb(s)); },
    fireAlarm: () => alarmListeners.forEach(cb => cb({ name: 'flush' }))
  };
}

const loggedRequests = [];
function stubFetch(response = { status: 200 }) {
  return async (url, opts) => {
    loggedRequests.push({ url, opts });
    if (String(url).includes('/settings/timezone.json')) {
      return { json: async () => 'Asia/Manila' };
    }
    return { status: response.status, json: async () => ({}), text: async () => '' };
  };
}

async function importBackground(chromeMock, fetchImpl) {
  globalThis.chrome = chromeMock;
  globalThis.fetch = fetchImpl || stubFetch();
  importCounter++;
  // Cache-bust so each test gets fresh module-level state (activeTab, lastHeartbeat, …).
  return import(`${BACKGROUND_URL.href}?t=${importCounter}`);
}

test('idle transition closes the active session at the last heartbeat, not at "now"', async () => {
  const startedAt = 1_000_000_000_000;
  const { chrome, store, fireIdleState } = makeChromeMock({
    now: startedAt,
    activeTabFixture: {
      uid: 'u1', authToken: 'tok',
      customSites: {}, removedSites: [],
      activeTab: { url: 'https://github.com/x', title: 'x', domain: 'github.com', startedAt, sessionId: startedAt },
      lastHeartbeat: startedAt,
      trackedSites: undefined
    }
  });
  await importBackground(chrome);
  // Let the async init() settle (it's fire-and-forget at module load).
  await new Promise(r => setTimeout(r, 10));

  // Simulate 90 real seconds of active use (heartbeat advances via a tab event) then idle.
  fireIdleState('idle');

  // The mock's idle listener closes the session and calls logSession -> fetch PUT.
  await new Promise(r => setTimeout(r, 10));
  assert.equal(store.activeTab, undefined, 'activeTab must be cleared once idle is detected');
});

test('a long gap since the last heartbeat (service-worker restart after sleep) is NOT bridged as continuous use', async () => {
  const longAgo = 1_000_000_000_000;
  const now = longAgo + 20 * 60 * 1000; // 20 minutes later — far past the 5-minute idle threshold
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const { chrome, store } = makeChromeMock({
      activeTabFixture: {
        uid: 'u1', authToken: 'tok',
        customSites: {}, removedSites: [],
        activeTab: { url: 'https://github.com/x', title: 'x', domain: 'github.com', startedAt: longAgo, sessionId: longAgo },
        lastHeartbeat: longAgo // no heartbeat since the gap started — this IS the unobserved gap
      }
    });
    await importBackground(chrome);
    await new Promise(r => setTimeout(r, 10));
    // init() must have discovered the stale gap and closed the session out at `longAgo`,
    // not silently resumed it as still active 20 minutes later.
    assert.equal(store.activeTab, undefined, 'a session restored after an unobserved gap past the idle threshold must be closed, not resumed');
  } finally {
    Date.now = realNow;
  }
});

test('a short gap since the last heartbeat (normal SW restart) resumes the session unchanged', async () => {
  const recent = 1_000_000_000_000;
  const now = recent + 10 * 1000; // 10 seconds later — well within the idle threshold
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const { chrome, store } = makeChromeMock({
      activeTabFixture: {
        uid: 'u1', authToken: 'tok',
        customSites: {}, removedSites: [],
        activeTab: { url: 'https://github.com/x', title: 'x', domain: 'github.com', startedAt: recent, sessionId: recent },
        lastHeartbeat: recent
      }
    });
    await importBackground(chrome);
    await new Promise(r => setTimeout(r, 10));
    assert.ok(store.activeTab, 'a session restored within the idle threshold must be resumed, not discarded');
    assert.equal(store.activeTab.domain, 'github.com');
  } finally {
    Date.now = realNow;
  }
});

test('flushAndRestart (periodic alarm) closes the session instead of bridging when chrome.idle reports non-active', async () => {
  const startedAt = 2_000_000_000_000;
  const { chrome, store, fireAlarm } = makeChromeMock({
    idleState: 'locked',
    activeTabFixture: {
      uid: 'u1', authToken: 'tok',
      customSites: {}, removedSites: [],
      activeTab: { url: 'https://github.com/x', title: 'x', domain: 'github.com', startedAt, sessionId: startedAt },
      lastHeartbeat: startedAt
    }
  });
  await importBackground(chrome);
  await new Promise(r => setTimeout(r, 10));
  fireAlarm();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(store.activeTab, undefined, 'the periodic alarm must close a locked/idle session rather than extending it another 5 minutes');
});

test('flushAndRestart (periodic alarm) extends the session normally when chrome.idle reports active (no regression)', async () => {
  const startedAt = 3_000_000_000_000;
  const { chrome, store, fireAlarm } = makeChromeMock({
    idleState: 'active',
    activeTabFixture: {
      uid: 'u1', authToken: 'tok',
      customSites: {}, removedSites: [],
      activeTab: { url: 'https://github.com/x', title: 'x', domain: 'github.com', startedAt, sessionId: startedAt },
      lastHeartbeat: startedAt
    }
  });
  await importBackground(chrome);
  await new Promise(r => setTimeout(r, 10));
  fireAlarm();
  await new Promise(r => setTimeout(r, 10));
  assert.ok(store.activeTab, 'an actively-used session must still be extended by the periodic alarm');
  assert.equal(store.activeTab.domain, 'github.com');
});

// signIn() itself drives chrome.identity.launchWebAuthFlow (a real interactive OAuth
// popup) — out of scope to mock for this milestone. The ordering fix (await
// fetchUserTimezone(...) before startTracking()) is instead verified as a static
// source check, the same technique time-truth-pc-time.test.js uses for the PC-Time
// energy fix: deterministic, no OAuth mocking, and it fails loudly if the two calls
// are ever reordered.
test('signIn awaits fetchUserTimezone before calling startTracking (source-level ordering check)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const start = src.indexOf('export async function signIn()');
  assert.ok(start >= 0, 'signIn() not found');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  const fetchTzCall = body.indexOf('await fetchUserTimezone(');
  const startTrackingCall = body.indexOf('startTracking()');
  assert.ok(fetchTzCall >= 0, 'signIn must await fetchUserTimezone(...)');
  assert.ok(startTrackingCall >= 0, 'signIn must call startTracking()');
  assert.ok(fetchTzCall < startTrackingCall, 'fetchUserTimezone must be awaited BEFORE startTracking is called, or the first flush can race the account timezone fetch');
});

test('init() re-fetches the account timezone on every service-worker wake when signed in (source-level check)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const initStart = src.indexOf('async function init()');
  const initEnd = src.indexOf('\nfunction markHeartbeat', initStart);
  const initBody = src.slice(initStart, initEnd);
  assert.match(initBody, /fetchUserTimezone\(/, 'init() must attempt to refresh the timezone so a later web-app change eventually reaches the extension without requiring re-sign-in');
});
