// TASK-013 — Daily-Use Reliability Baseline V1.
//
// Deterministic characterization of the daily loop in the real browser runtime (index.html +
// storage.js): start/resume -> interval ping -> log -> persist -> sync -> recover.
//
// Harness:
//   - Firebase is an in-memory, room-partitioned stub. Its tree and network flags live in
//     localStorage so they survive a reload or a simulated termination (page closed without
//     beforeunload, then reopened in the same browser context). No network or production data.
//   - Date is a controlled clock (persisted the same way). Each Date.now() call advances it by
//     1 ms so ids stay unique and time never runs backwards. The only real-time waits are for the
//     app's own 1 s ticker / setTimeout(0) deliveries, never for the clock under test.
//
// TASK-035 retains the original seven contract assertions as ordinary required passes.
// No expected-failure annotation or strict-mode exception remains. F-4 follows the owner's
// approved pending-block-through-Save contract. Finding ids refer to the original baseline.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
const MIN = 60 * 1000;
const A = 'uid_account-a';
const B = 'uid_account-b';
// 2026-10-14 09:00 in Asia/Manila (UTC+8, no DST).
const T0 = Date.parse('2026-10-14T01:00:00Z');
// The recovery prompt is scheduled 600 ms after restore (restoreHeartbeatRecoveryForAccount); wait past it.
const PAST_RECOVERY_PROMPT_MS = 800;
let appServer;
let appUrl;

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const load = (key, fallback) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
  const tree = load('__t13-remote', {});
  const net = load('__t13-net', { connected: true, failWrites: false });
  const log = { writes: [], failed: [] };
  const listeners = new Map();
  const deferred = [];
  let authCb = null;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const save = () => localStorage.setItem('__t13-remote', JSON.stringify(tree));
  const saveNet = () => localStorage.setItem('__t13-net', JSON.stringify(net));
  const get = p => p.split('/').filter(Boolean).reduce((node, key) => node && node[key], tree);
  const put = (p, value) => {
    const parts = p.split('/').filter(Boolean);
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    if (value == null) delete node[parts.at(-1)]; else node[parts.at(-1)] = clone(value);
    save();
  };
  const valueAt = p => p === '.info/connected' ? net.connected : get(p);
  const snapshot = value => ({ val: () => clone(value ?? null), ref: { remove: () => Promise.resolve() } });
  const fire = p => (listeners.get(p) || []).forEach(cb => cb(snapshot(valueAt(p))));
  const fireUp = p => { let q = p; while (q) { fire(q); q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : ''; } };
  const write = (p, value) => { log.writes.push({ path: p, value: clone(value) }); put(p, value); fireUp(p); };
  const refuse = (p, value) => { log.failed.push({ path: p, value: clone(value) }); return Promise.reject(new Error('offline (test stub)')); };
  const makeRef = refPath => ({
    path: refPath,
    key: refPath.split('/').pop(),
    child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(event, cb) {
      if (event !== 'value') return cb;
      if (!listeners.has(refPath)) listeners.set(refPath, []);
      listeners.get(refPath).push(cb);
      const deliver = () => cb(snapshot(valueAt(refPath)));
      // Like the real SDK without disk persistence: no data snapshot until connected.
      if (refPath !== '.info/connected' && !net.connected) deferred.push(deliver);
      else setTimeout(deliver, 0);
      return cb;
    },
    off() { listeners.delete(refPath); },
    once(event, cb) {
      const result = snapshot(get(refPath));
      if (typeof cb === 'function') setTimeout(() => cb(result), 0);
      return Promise.resolve(result);
    },
    update(values) {
      if (net.failWrites) return refuse(refPath, values);
      Object.entries(values || {}).forEach(([key, value]) => write(refPath + '/' + key, value));
      return Promise.resolve();
    },
    set(value) { if (net.failWrites) return refuse(refPath, value); write(refPath, value); return Promise.resolve(); },
    remove() { if (net.failWrites) return refuse(refPath, null); write(refPath, null); return Promise.resolve(); },
    transaction(fn) {
      if (net.failWrites) return refuse(refPath, '(transaction)');
      const current = get(refPath);
      const next = fn(clone(current ?? null));
      if (next === undefined) return Promise.resolve({ committed: false, snapshot: snapshot(current) });
      write(refPath, next);
      return Promise.resolve({ committed: true, snapshot: snapshot(next) });
    },
    push(value) { const ref = makeRef(refPath + '/pushed'); if (value !== undefined) ref.set(value); return ref; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; },
  });
  const user = uid => uid ? { uid, displayName: uid, email: uid + '@example.test', photoURL: '' } : null;
  window.__fbTest = {
    log,
    get: p => clone(get(p) ?? null),
    remoteWrite(p, value) { put(p, value); fireUp(p); },
    setNet(next) {
      if ('failWrites' in next) net.failWrites = !!next.failWrites;
      if ('connected' in next) net.connected = !!next.connected;
      saveNet();
      fire('.info/connected');
      if (net.connected) deferred.splice(0).forEach(deliver => deliver());
    },
    signInAs: uid => authCb(user(uid)),
  };
  const auth = () => ({
    onAuthStateChanged(cb) { authCb = cb; setTimeout(() => cb(user(localStorage.getItem('__t13-uid') || 'account-a')), 0); return () => {}; },
    signInWithPopup: () => Promise.resolve(),
    signInWithCredential: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
  });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = {
    apps: [],
    initializeApp(config) { const app = { config }; this.apps.push(app); return app; },
    app() { return this.apps[0] || this.initializeApp({}); },
    database() { return { ref: makeRef }; },
    auth,
  };
})();`;

// Fake @capacitor/local-notifications ESM module whose permission is denied and whose schedule rejects.
const deniedLocalNotificationsModule = `
const calls = (window.__nativeCalls = window.__nativeCalls || []);
export const LocalNotifications = {
  async requestPermissions() { calls.push('requestPermissions'); return { display: 'denied' }; },
  async createChannel() { calls.push('createChannel'); },
  addListener(name) { calls.push('addListener:' + name); return { remove() {} }; },
  async schedule() { calls.push('schedule'); throw new Error('notifications permission denied'); },
  async cancel() { calls.push('cancel'); },
};`;

const fakeCapacitorAppModule = `
export const App = { addListener() { return { remove() {} }; }, async getLaunchUrl() { return null; } };`;

function settingsFor(overrides = {}) {
  return {
    hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [],
    timezone: 'Asia/Manila', activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00',
    sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [],
    ...overrides
  };
}

function entry(activity, energy, tsStart, ts, extra = {}) {
  return {
    id: ts, ts, tsStart, updatedAt: ts, blockIntervalMin: Math.round((ts - tsStart) / MIN),
    date: new Date(ts + 8 * 60 * MIN).toISOString().slice(0, 10), activity, energy,
    onPlan: true, retro: true, category: energy, originalLabel: energy, ...extra
  };
}

test.beforeAll(async () => {
  appServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = path.resolve(APP_ROOT, `.${decodeURIComponent(pathname)}`);
      if (!filePath.startsWith(APP_ROOT)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${appServer.address().port}/index.html`;
});

test.afterAll(async () => {
  if (appServer) await new Promise(resolve => appServer.close(resolve));
});

async function ready(page, room = A) {
  await page.waitForFunction(r => typeof window.quickRetroLog === 'function'
    && globalThis.getChronaSenseRoomCode?.() === r, room);
  await page.waitForTimeout(250);
}

/**
 * Opens the app in a fresh browser context. Everything is seeded once per context; reloads and
 * reopened pages in the same context keep localStorage (app state + stub remote + clock).
 */
async function openApp(context, {
  now = T0, entriesA = [], entriesB = [], remote = {}, settings = {}, notification = null, native = false
} = {}) {
  await context.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: firebaseStub
  }));
  if (native) {
    const cors = { 'access-control-allow-origin': '*' };
    await context.route('https://cdn.jsdelivr.net/npm/@capacitor/local-notifications/**', route => route.fulfill({
      status: 200, contentType: 'application/javascript', headers: cors, body: deniedLocalNotificationsModule
    }));
    await context.route('https://cdn.jsdelivr.net/npm/@capacitor/app/**', route => route.fulfill({
      status: 200, contentType: 'application/javascript', headers: cors, body: fakeCapacitorAppModule
    }));
  }
  await context.addInitScript(seed => {
    if (location.protocol !== 'http:') return; // a new page's about:blank has no usable storage
    const RealDate = Date;
    const clock = { base: Number(localStorage.getItem('__t13-now')) || seed.now, n: 0 };
    const tick = () => clock.base + (++clock.n);
    window.__t13 = {
      set(ts) { clock.base = ts; clock.n = 0; localStorage.setItem('__t13-now', String(ts)); },
      peek: () => clock.base + clock.n
    };
    window.Date = class MockDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [tick()])); }
      static now() { return tick(); }
    };
    sessionStorage.setItem('ta3-session-started', '1');
    if (seed.native) window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
    if (seed.notification) {
      const permission = seed.notification === 'denied' ? 'denied' : 'default';
      window.Notification = class FakeNotification {
        static get permission() { return permission; }
        static requestPermission() {
          return seed.notification === 'throws' ? Promise.reject(new Error('blocked by browser')) : Promise.resolve('denied');
        }
        constructor() { throw new Error('notifications are denied'); }
      };
    }
    if (localStorage.getItem('__t13-seeded')) return;
    localStorage.clear();
    localStorage.setItem('__t13-seeded', '1');
    localStorage.setItem('__t13-now', String(seed.now));
    localStorage.setItem('__t13-remote', JSON.stringify(seed.remote));
    localStorage.setItem('ta3-onboarded', '1');
    localStorage.setItem('ta3-device-id', 'device-a');
    for (const [room, list] of [['uid_account-a', seed.entriesA], ['uid_account-b', seed.entriesB]]) {
      localStorage.setItem(`ta3-tz:${room}`, seed.settings.timezone);
      localStorage.setItem(`ta3-settings:${room}`, JSON.stringify(seed.settings));
      localStorage.setItem(`ta3-entries:${room}`, JSON.stringify(list));
    }
  }, { now, entriesA, entriesB, remote, settings: settingsFor(settings), notification, native });
  const page = await context.newPage();
  await page.goto(appUrl);
  await ready(page);
  return page;
}

/** Reopens the app at `nextNow`. kill=true closes the page WITHOUT beforeunload (simulated termination). */
async function reopen(context, page, nextNow, { kill = false } = {}) {
  if (kill) {
    // Only the stored clock moves: the terminated page keeps its own time (and last heartbeat).
    await page.evaluate(ts => localStorage.setItem('__t13-now', String(ts)), nextNow);
    await page.close({ runBeforeUnload: false });
    page = await context.newPage();
    await page.goto(appUrl);
  } else {
    // A real reload happens "now": beforeunload stamps the heartbeat at the reload instant.
    await page.evaluate(ts => window.__t13.set(ts), nextNow);
    await page.reload();
  }
  await ready(page);
  return page;
}

const setNow = (page, ts) => page.evaluate(t => window.__t13.set(t), ts);

const state = page => page.evaluate(() => ({
  running,
  currentTask,
  taskStartTime,
  blockStartTime,
  timerStartedAt,
  pingCount,
  timerOwnerDeviceId,
  trackingStartedAt,
  hud: getHudTrackingFields(),
  entries: entries.filter(e => !e.deleted).map(e => ({
    id: e.id, activity: e.activity, energy: e.energy, tsStart: e.tsStart, ts: e.ts,
    blockIntervalMin: e.blockIntervalMin, date: e.date, updatedAt: e.updatedAt,
    retro: !!e.retro, quickLogged: !!e.quickLogged, autoLogged: !!e.autoLogged
  })),
  timerSlot: JSON.parse(localStorage.getItem('ta3-timer:uid_account-a') || 'null'),
  heartbeat: localStorage.getItem('ta3-heartbeat-ts:uid_account-a'),
  slotEntries: JSON.parse(localStorage.getItem('ta3-entries:uid_account-a') || '[]').filter(e => !e.deleted),
  recoveryVisible: getComputedStyle(document.getElementById('recovery-overlay')).display !== 'none'
}));

const remoteEntries = (page, room = A) => page.evaluate(r =>
  Object.values(window.__fbTest.get(`rooms/${r}/entries`) || {}).filter(e => e && !e.deleted), room);

const goOffline = page => page.evaluate(() => window.__fbTest.setNet({ connected: false, failWrites: true }));
const goOnline = page => page.evaluate(() => window.__fbTest.setNet({ connected: true, failWrites: false }));

const markWrites = page => page.evaluate(() => { window.__writeMark = window.__fbTest.log.writes.length; });
const writesSinceMark = page => page.evaluate(() => window.__fbTest.log.writes.slice(window.__writeMark));

async function startTimer(page, task) {
  const started = await page.evaluate(t => _startTimer(t), task);
  expect(started).toBe(true);
}

/** Moves the clock past the interval and waits for the app's own 1 s ticker to run doPing(). */
async function letPingFire(page, atTs) {
  const before = await page.evaluate(() => pingCount);
  await setNow(page, atTs);
  await page.waitForFunction(n => pingCount > n, before, { timeout: 5000 });
}

/** Starts a timer at T0, advances 5 min, refreshes the heartbeat as its 15 s ticker would, then terminates. */
async function startThenTerminate(context, page, reopenAt) {
  await startTimer(page, 'Writing');
  await setNow(page, T0 + 5 * MIN);
  await page.evaluate(() => _startHeartbeat());
  return reopen(context, page, reopenAt, { kill: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Timer lifecycle (scenarios 1-2)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('A. Timer lifecycle', () => {
  test('S1: running timer survives reload within the interval with the original start and activity', async ({ context }) => {
    const page0 = await openApp(context);
    await startTimer(page0, 'Writing');
    const page = await reopen(context, page0, T0 + 10 * MIN);
    await page.waitForTimeout(PAST_RECOVERY_PROMPT_MS);
    const s = await state(page);
    expect(s.running).toBe(true);
    expect(s.currentTask).toBe('Writing');
    expect(s.taskStartTime).toBeGreaterThanOrEqual(T0);
    expect(s.taskStartTime).toBeLessThan(T0 + 1000);
    expect(s.blockStartTime).toBeGreaterThanOrEqual(T0);
    expect(s.blockStartTime).toBeLessThan(T0 + 1000);
    expect(s.recoveryVisible).toBe(false);

    await setNow(page, T0 + 20 * MIN);
    await page.evaluate(() => stopAndLog());
    const after = await state(page);
    expect(after.running).toBe(false);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]).toMatchObject({ activity: 'Writing', tsStart: s.taskStartTime });
    expect(after.entries[0].ts - after.entries[0].tsStart).toBeGreaterThanOrEqual(20 * MIN - 1000);
  });

  test('S1: reload after an in-page ping keeps the original task start (the block anchor moves to the ping)', async ({ context }) => {
    const page0 = await openApp(context);
    await startTimer(page0, 'Writing');
    const start = (await state(page0)).taskStartTime;
    await letPingFire(page0, T0 + 30 * MIN + 5000);
    const pinged = await state(page0);
    expect(pinged.pingCount).toBe(1);
    expect(pinged.taskStartTime).toBe(start);
    expect(pinged.blockStartTime).toBeGreaterThanOrEqual(T0 + 30 * MIN);
    expect(pinged.entries).toHaveLength(0); // the ping itself writes no evidence

    const page = await reopen(context, page0, T0 + 40 * MIN);
    const s = await state(page);
    expect(s.running).toBe(true);
    expect(s.taskStartTime).toBe(start);
    expect(s.blockStartTime).toBe(pinged.blockStartTime);

    await setNow(page, T0 + 45 * MIN);
    await page.evaluate(() => stopAndLog());
    const after = await state(page);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0].tsStart).toBe(start);
  });

  test('S1/S2: termination within the interval -> recovery "intentional" logs exactly once and clears the heartbeat', async ({ context }) => {
    const page0 = await openApp(context);
    const page = await startThenTerminate(context, page0, T0 + 12 * MIN);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    const restored = await state(page);
    expect(restored.running).toBe(true);
    expect(restored.taskStartTime).toBeLessThan(T0 + 1000);

    await page.getByRole('button', { name: /closed it intentionally/ }).click();
    const s = await state(page);
    expect(s.running).toBe(false);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].activity).toBe('Writing');
    expect(s.entries[0].tsStart).toBe(restored.taskStartTime);
    expect(s.entries[0].ts).toBeGreaterThanOrEqual(T0 + 5 * MIN);
    expect(s.entries[0].ts).toBeLessThan(T0 + 6 * MIN); // ends at the last heartbeat, not at reopen
    expect(s.heartbeat).toBeNull();
    expect(s.timerSlot).toBeNull();

    const page2 = await reopen(context, page, T0 + 20 * MIN);
    await page2.waitForTimeout(PAST_RECOVERY_PROMPT_MS);
    const again = await state(page2);
    expect(again.recoveryVisible).toBe(false);
    expect(again.entries).toHaveLength(1);
    expect((await remoteEntries(page2)).filter(e => e.activity === 'Writing')).toHaveLength(1);
  });

  test('S1: termination within the interval -> recovery "accidental" keeps the original session running', async ({ context }) => {
    const page0 = await openApp(context);
    const page = await startThenTerminate(context, page0, T0 + 12 * MIN);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    await page.getByRole('button', { name: /it was accidental/ }).click();
    const s = await state(page);
    expect(s.running).toBe(true);
    expect(s.currentTask).toBe('Writing');
    expect(s.taskStartTime).toBeLessThan(T0 + 1000);
    expect(s.entries).toHaveLength(0);
    expect(Number(s.heartbeat)).toBeGreaterThan(T0 + 11 * MIN);
  });

  // The modal promises "Keep the timer running as if it never stopped"; at minimum the T0 -> shutdown
  // session must survive, either still running from T0 or as a logged entry.
  const sessionKept = s => (s.running && s.taskStartTime < T0 + 1000)
    || s.entries.some(e => e.activity === 'Writing' && e.tsStart < T0 + 1000);

  test('S1: termination longer than one interval, reopened ONLINE -> "accidental" keeps the session (re-adopted from the remote timer copy)', async ({ context }) => {
    const page0 = await openApp(context);
    const page = await startThenTerminate(context, page0, T0 + 45 * MIN);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    await expect(page.locator('#recovery-msg')).toContainText('The ping timer also expired');
    await page.getByRole('button', { name: /it was accidental/ }).click();
    expect(sessionKept(await state(page))).toBe(true);
  });

  test('F-1 termination longer than one interval in an OFFLINE session -> "accidental" must not lose the session', async ({ context }) => {
    const page0 = await openApp(context);
    await goOffline(page0); // timer started without connectivity: no remote copy exists to re-adopt
    const page = await startThenTerminate(context, page0, T0 + 45 * MIN);
    // Preconditions: the recovery prompt describes this session and its expired ping timer.
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    await expect(page.locator('#recovery-msg')).toContainText('Writing');
    await expect(page.locator('#recovery-msg')).toContainText('The ping timer also expired');
    expect(await page.evaluate(room => window.__fbTest.get(`rooms/${room}/timer`), A)).toBeNull(); // nothing to re-adopt
    await page.getByRole('button', { name: /it was accidental/ }).click();
    await goOnline(page);
    await page.waitForTimeout(500);
    const s = await state(page);
    expect(sessionKept(s)).toBe(true);
  });

  test('S2: termination longer than one interval -> "intentional" logs the session exactly once', async ({ context }) => {
    const page0 = await openApp(context);
    const page = await startThenTerminate(context, page0, T0 + 45 * MIN);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    await page.getByRole('button', { name: /closed it intentionally/ }).click();
    const s = await state(page);
    expect(s.running).toBe(false);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].tsStart).toBeLessThan(T0 + 1000);
    expect(s.entries[0].ts).toBeLessThan(T0 + 6 * MIN);

    // Reopening again (even if a recovery prompt reappears, it is not acted on) never adds a second entry.
    const page2 = await reopen(context, page, T0 + 60 * MIN);
    await page2.waitForTimeout(PAST_RECOVERY_PROMPT_MS);
    expect((await state(page2)).entries).toHaveLength(1);
  });

  test('S1: expired-timer recovery reopened ONLINE clears the heartbeat (no repeat prompt on the next open)', async ({ context }) => {
    const page0 = await openApp(context);
    const page = await startThenTerminate(context, page0, T0 + 45 * MIN);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    await page.getByRole('button', { name: /closed it intentionally/ }).click();
    expect((await state(page)).heartbeat).toBeNull();
    const page2 = await reopen(context, page, T0 + 60 * MIN);
    await page2.waitForTimeout(PAST_RECOVERY_PROMPT_MS);
    expect((await state(page2)).recoveryVisible).toBe(false);
  });

  test('F-2 expired-timer recovery in an OFFLINE session must clear the heartbeat (no false recovery prompt on the next open)', async ({ context }) => {
    const page0 = await openApp(context);
    await goOffline(page0);
    const page = await startThenTerminate(context, page0, T0 + 45 * MIN);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    await page.getByRole('button', { name: /closed it intentionally/ }).click();
    // Preconditions: the clean exit itself worked (session logged once, timer stopped).
    const exited = await state(page);
    expect(exited.running).toBe(false);
    expect(exited.entries).toHaveLength(1);
    expect(exited.entries[0]).toMatchObject({ activity: 'Writing' });
    await goOnline(page);
    const page2 = await reopen(context, page, T0 + 60 * MIN);
    await page2.waitForTimeout(PAST_RECOVERY_PROMPT_MS);
    const s = await state(page2);
    expect(s.entries).toHaveLength(1);
    expect(s.heartbeat).toBeNull();
    expect(s.recoveryVisible).toBe(false);
  });

  // Simulates a suspended/throttled page: the ticker never ran the due ping, but the heartbeat was
  // written 30 s before the page went away (as its 15 s writer does). Reopen is 1 min after that.
  async function missedPingThenTerminate(context, page0) {
    await startTimer(page0, 'Writing');
    await page0.evaluate(() => { clearInterval(ticker); ticker = null; });
    await setNow(page0, T0 + 30 * MIN + 30 * 1000);
    await page0.evaluate(() => _startHeartbeat());
    // Preconditions: a running Writing session from T0 is persisted with a 30 s-old heartbeat, and no ping ran.
    const before = await state(page0);
    expect(before).toMatchObject({ running: true, currentTask: 'Writing', pingCount: 0 });
    expect(before.timerSlot).toMatchObject({ running: true, currentTask: 'Writing' });
    expect(before.timerSlot.taskStartTime).toBeLessThan(T0 + 1000);
    expect(Number(before.heartbeat)).toBeGreaterThanOrEqual(T0 + 30 * MIN + 30 * 1000);
    const page = await reopen(context, page0, T0 + 31 * MIN, { kill: true });
    await page.waitForTimeout(PAST_RECOVERY_PROMPT_MS);
    return page;
  }

  test('S1: reopened ONLINE within 2 min of the last heartbeat after a missed ping -> the session is re-adopted from the remote timer copy', async ({ context }) => {
    const page = await missedPingThenTerminate(context, await openApp(context));
    expect(sessionKept(await state(page))).toBe(true);
  });

  test('F-3 in an OFFLINE session, reopening within 2 min of the last heartbeat after a missed ping must not silently drop the session', async ({ context }) => {
    const page0 = await openApp(context);
    await goOffline(page0);
    const page = await missedPingThenTerminate(context, page0);
    const offline = await state(page);
    await goOnline(page);
    await page.waitForTimeout(500);
    const s = await state(page);
    expect(offline.recoveryVisible || sessionKept(s)).toBe(true);
  });

  test('S2: a stopped and logged block is never duplicated by repeated reloads', async ({ context }) => {
    const page0 = await openApp(context);
    await startTimer(page0, 'Writing');
    await setNow(page0, T0 + 25 * MIN);
    await page0.evaluate(() => stopAndLog());
    let page = await reopen(context, page0, T0 + 26 * MIN);
    page = await reopen(context, page, T0 + 27 * MIN);
    page = await reopen(context, page, T0 + 28 * MIN, { kill: true });
    await page.waitForTimeout(PAST_RECOVERY_PROMPT_MS);
    const s = await state(page);
    expect(s.running).toBe(false);
    expect(s.recoveryVisible).toBe(false);
    expect(s.entries).toHaveLength(1);
    expect(s.slotEntries).toHaveLength(1);
    expect(await remoteEntries(page)).toHaveLength(1);
  });
});

test.describe('TASK-035 bounded reliability closure', () => {
  async function savePending(page) {
    await page.evaluate(() => { openQuickLog(); _doQuickSave('Writing', 'deep'); });
  }

  for(const totalSecs of [null,0,-1,'invalid']) test(`malformed saved countdown ${totalSecs} never becomes a running or published timer`,async({context})=>{
    const page=await openApp(context);
    await page.evaluate(({totalSecs,t0})=>{
      localStorage.setItem(`ta3-timer:${roomCode}`,JSON.stringify({running:true,timerStartedAt:t0,totalSecs}));
      bindAccountLocalState(roomCode);
    },{totalSecs,t0:T0});
    const s=await state(page);
    expect(s.running).toBe(false);
    expect(s.taskStartTime).toBeNull();
    expect(await page.evaluate(room=>window.__fbTest.get(`rooms/${room}/timer`),A)).toBeNull();
  });

  test('two reminders retain pending time; Save/reload/Stop has no duplicate coverage or HUD restart', async ({context}) => {
    let page = await openApp(context);
    await startTimer(page, 'Writing');
    const start = (await state(page)).taskStartTime;
    await letPingFire(page, T0 + 31 * MIN);
    await letPingFire(page, T0 + 62 * MIN);
    await setNow(page, T0 + 65 * MIN);
    await savePending(page);
    const saved = await state(page);
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0].tsStart).toBe(start);
    expect(saved.taskStartTime).toBe(saved.entries[0].ts);
    expect(saved.hud.startedAt).toBe(start);
    page = await reopen(context, page, T0 + 66 * MIN);
    expect((await state(page)).taskStartTime).toBe(saved.entries[0].ts);
    expect((await state(page)).hud.startedAt).toBe(start);
    await setNow(page, T0 + 75 * MIN);
    await page.evaluate(() => stopAndLog());
    const records = (await state(page)).entries.sort((a,b) => a.tsStart-b.tsStart);
    expect(records).toHaveLength(2);
    expect(records[1].tsStart).toBe(records[0].ts);
    expect(Math.round(records.reduce((n,e)=>n+e.ts-e.tsStart,0)/MIN)).toBe(75);
  });

  for (const extend of [false,true]) test(`Quick Save Undo restores the owned pending span (${extend?'extension':'new record'})`, async ({context}) => {
    const previous = entry('Writing','deep',T0-10*MIN,T0);
    const page = await openApp(context,{entriesA:extend?[previous]:[]});
    await startTimer(page,'Writing');
    const original = await state(page);
    await setNow(page,T0+10*MIN);
    await savePending(page);
    expect((await state(page)).taskStartTime).toBeGreaterThan(original.taskStartTime);
    await page.evaluate(()=>undoLastAction());
    const undone = await state(page);
    expect(undone.taskStartTime).toBe(original.taskStartTime);
    expect(undone.blockStartTime).toBe(original.blockStartTime);
    expect(undone.entries).toHaveLength(extend?1:0);
    if(extend) expect(undone.entries[0]).toMatchObject({id:previous.id,tsStart:previous.tsStart,ts:previous.ts});
    await setNow(page,T0+20*MIN);
    await page.evaluate(()=>stopAndLog());
    expect((await state(page)).entries.find(e=>e.ts>T0).tsStart).toBe(original.taskStartTime);
  });

  test('sub-minute Save never substitutes the interval and duplicate callbacks write once', async ({context}) => {
    const page=await openApp(context);
    await startTimer(page,'Writing');
    await setNow(page,T0+10*1000);
    await page.evaluate(()=>{openQuickLog();_doQuickSave('Writing','deep');_doQuickSave('Writing','deep');});
    const s=await state(page);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].blockIntervalMin).toBe(1);
    expect(s.entries[0].ts-s.entries[0].tsStart).toBeLessThan(11000);
    await setNow(page,T0+20*1000);
    await savePending(page);
    expect((await state(page)).entries).toHaveLength(1);
    expect((await state(page)).entries[0].blockIntervalMin).toBe(1);
  });

  test('a stale recovery cannot appear or log after switching A to B and back', async ({context}) => {
    const first=await openApp(context);
    await goOffline(first);
    const page=await startThenTerminate(context,first,T0+45*MIN);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    await page.evaluate(()=>window.__fbTest.signInAs('account-b'));
    await ready(page,B);
    await page.evaluate(()=>handleRecovery(true));
    expect((await state(page)).entries).toHaveLength(0);
    await expect(page.locator('#recovery-overlay')).toBeHidden();
    expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('ta3-entries:uid_account-a')||'[]'))).toEqual([]);
    await page.evaluate(()=>window.__fbTest.signInAs('account-a'));
    await ready(page,A);
    expect((await state(page)).entries).toHaveLength(0);
  });

  for(const takeover of [false,true]) test(`newer remote ${takeover?'takeover':'stop'} invalidates pending recovery without logging`,async({context})=>{
    const first=await openApp(context);
    await goOffline(first);
    const page=await startThenTerminate(context,first,T0+45*MIN);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    await goOnline(page);
    await page.evaluate(({room,takeover,t0})=>window.__fbTest.remoteWrite(`rooms/${room}/timer`,{
      running:takeover,stopped:!takeover,lastTask:'Phone task',startedAt:t0+44*60000,
      taskStartTime:t0+44*60000,blockStartTime:t0+44*60000,intervalSecs:1800,
      ownerDeviceId:'device-b',updatedBy:'device-b',ownerRoom:room,takeover:true,updatedAt:Date.now()+2000
    }),{room:A,takeover,t0:T0});
    await page.evaluate(()=>handleRecovery(true));
    const s=await state(page);
    expect(s.entries).toHaveLength(0);
    expect(s.running).toBe(takeover);
    await expect(page.locator('#recovery-overlay')).toBeHidden();
    if(takeover)expect(s.currentTask).toBe('Phone task');
  });

  test('Undo after replacement timer never rewinds its accounting cursor',async({context})=>{
    const page=await openApp(context);
    await startTimer(page,'Writing');
    await setNow(page,T0+10*MIN);
    await savePending(page);
    await page.evaluate(()=>{window.__savedUndo=lastUndoAction;resetTimer();});
    await setNow(page,T0+11*MIN);
    await startTimer(page,'Writing');
    const replacement=await state(page);
    await page.evaluate(()=>{lastUndoAction=window.__savedUndo;undoLastAction();});
    expect((await state(page)).taskStartTime).toBe(replacement.taskStartTime);
  });

  for(const takeover of [false,true]) test(`held restore acknowledgement ${takeover?'cannot publish over remote Focus':'cannot rewind a newer Quick Save'}`,async({context})=>{
    const page=await openApp(context);
    await startTimer(page,'Writing');
    await setNow(page,T0+5*MIN);
    await page.evaluate(()=>{
      window.__realOwnedRef=ownedRoomRef;
      ownedRoomRef=()=>new Proxy(window.__realOwnedRef(),{get(ref,key){
        if(key==='child')return name=>name==='timer'?{transaction(fn){
          window.__heldTimer=fn(window.__fbTest.get(`rooms/${roomCode}/timer`));
          return new Promise(resolve=>{window.__releaseRestore=resolve;});
        }}:ref.child(name);
        return typeof ref[key]==='function'?ref[key].bind(ref):ref[key];
      }});
      _restoredTimerSync={ownerRoom:roomCode,baseline:currentTimerSyncStamp(),
        sessionStart:trackingStartedAt||taskStartTime,inFlight:false};
      syncTimerState();
    });
    expect(await page.evaluate(()=>!!window.__heldTimer)).toBe(true);
    await setNow(page,T0+10*MIN);
    await savePending(page);
    const saved=await state(page);
    if(takeover)await page.evaluate(({room,t0})=>window.__fbTest.remoteWrite(`rooms/${room}/timer`,{
      running:true,stopped:false,lastTask:'Remote focus',startedAt:t0+9*60000,
      taskStartTime:t0+9*60000,blockStartTime:t0+9*60000,intervalSecs:1800,
      mode:'focus',focusPhase:'work',ownerDeviceId:'device-b',updatedBy:'device-b',
      ownerRoom:room,takeover:true,updatedAt:Date.now()+2000
    }),{room:A,t0:T0});
    else {
      await page.evaluate(()=>applyRemoteTimerState(window.__heldTimer,roomCode));
      expect((await state(page)).taskStartTime).toBe(saved.taskStartTime);
    }
    await page.evaluate(()=>{
      ownedRoomRef=window.__realOwnedRef;
      window.__releaseRestore({committed:true,snapshot:{val:()=>window.__heldTimer}});
    });
    if(takeover){
      await expect.poll(()=>page.evaluate(()=>syncedFocusTimer?.running)).toBe(true);
      expect(await page.evaluate(room=>window.__fbTest.get(`rooms/${room}/timer`).mode,A)).toBe('focus');
      expect((await state(page)).timerOwnerDeviceId).toBe('device-b');
    }else{
      await expect.poll(()=>page.evaluate(room=>window.__fbTest.get(`rooms/${room}/timer`).taskStartTime,A)).toBe(saved.taskStartTime);
      expect((await state(page)).taskStartTime).toBe(saved.taskStartTime);
      await setNow(page,T0+20*MIN);
      await page.evaluate(()=>stopAndLog());
      const records=(await state(page)).entries.sort((a,b)=>a.tsStart-b.tsStart);
      expect(records[1].tsStart).toBe(records[0].ts);
    }
  });

  test('numeric identities reject zero and existing tombstones; retro identity survives edit/delete/Undo/reload',async({context})=>{
    let page=await openApp(context);
    const generated=await page.evaluate(()=>{
      const random=crypto.getRandomValues.bind(crypto);
      entries.push({id:42,ts:Date.now(),deleted:true,updatedAt:Date.now()});
      let calls=0;
      crypto.getRandomValues=words=>{words[0]=0;words[1]=[0,42,43][calls++];return words;};
      try{return {id:newEntryId(),calls};}finally{crypto.getRandomValues=random;}
    });
    expect(generated).toEqual({id:43,calls:3});
    await page.evaluate(()=>{document.getElementById('retro-task').value='Email';document.getElementById('retro-qstart').value='08:00';document.getElementById('retro-qend').value='08:30';quickRetroLog();});
    const created=(await state(page)).entries[0];
    expect(Number.isSafeInteger(created.id)).toBe(true);
    await page.evaluate(id=>{openEditEntry(id);document.getElementById('retro-activity').value='Edited email';saveRetroEntry();},created.id);
    expect((await state(page)).entries[0].id).toBe(created.id);
    await page.evaluate(id=>deleteEntry(id),created.id);
    expect((await state(page)).entries).toHaveLength(0);
    await page.evaluate(()=>undoLastAction());
    page=await reopen(context,page,T0+MIN);
    expect((await state(page)).entries[0]).toMatchObject({id:created.id,activity:'Edited email',tsStart:created.tsStart,ts:created.ts});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Ping / notification (scenarios 3-5)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('B. Ping and notification', () => {
  test('S3: a mirror device never pings, publishes or logs for a timer owned by another device', async ({ context }) => {
    const page = await openApp(context);
    await page.evaluate(({ room, t0 }) => window.__fbTest.remoteWrite(`rooms/${room}/timer`, {
      lastTask: 'Phone task', running: true, stopped: false, intervalSecs: 1800, startedAt: t0,
      taskStartTime: t0, blockStartTime: t0, pausedRemaining: null, ownerDeviceId: 'device-b', mode: null,
      focusPhase: null, takeover: false, updatedAt: Date.now() + 1000, updatedBy: 'device-b', deviceName: 'phone', ownerRoom: room
    }), { room: A, t0: T0 });
    await page.waitForFunction(() => running && timerOwnerDeviceId === 'device-b');
    await markWrites(page);
    await setNow(page, T0 + 31 * MIN);
    // The guard path resets the local countdown; wait for that instead of pingCount.
    await page.waitForFunction(t => timerStartedAt > t, T0 + 30 * MIN, { timeout: 5000 });
    const s = await state(page);
    expect(s.pingCount).toBe(0);
    expect(s.timerOwnerDeviceId).toBe('device-b');
    expect(s.entries).toHaveLength(0);
    const ownTimerWrites = (await writesSinceMark(page)).filter(w => w.path.endsWith('/timer') && w.value?.updatedBy === 'device-a');
    expect(ownTimerWrites).toHaveLength(0);
  });

  test('S3: the owning device pings exactly once per due interval and publishes itself as owner', async ({ context }) => {
    const page = await openApp(context);
    await startTimer(page, 'Writing');
    await markWrites(page);
    await letPingFire(page, T0 + 31 * MIN);
    await page.waitForTimeout(1500); // two more ticker turns: no second ping
    const s = await state(page);
    expect(s.pingCount).toBe(1);
    expect(s.entries).toHaveLength(0);
    const ownTimerWrites = (await writesSinceMark(page)).filter(w => w.path.endsWith('/timer') && w.value?.updatedBy === 'device-a');
    expect(ownTimerWrites.length).toBeGreaterThan(0);
    expect(ownTimerWrites.at(-1).value).toMatchObject({ running: true, ownerDeviceId: 'device-a', lastTask: 'Writing' });
  });

  test('S3: stop on one device logs once; the other device resets on the remote stop without logging', async ({ context }) => {
    const page = await openApp(context);
    await startTimer(page, 'Writing');
    await setNow(page, T0 + 20 * MIN);
    await page.evaluate(room => window.__fbTest.remoteWrite(`rooms/${room}/timer`, {
      lastTask: null, running: false, stopped: true, intervalSecs: 1800, startedAt: null, taskStartTime: null,
      blockStartTime: null, pausedRemaining: null, ownerDeviceId: null, mode: null, focusPhase: null, takeover: false,
      updatedAt: Date.now() + 1000, updatedBy: 'device-b', deviceName: 'phone', ownerRoom: room
    }), A);
    await page.waitForFunction(() => !running);
    const s = await state(page);
    expect(s.entries).toHaveLength(0); // the stopping device (B) owns the log
    expect(s.timerSlot).toBeNull();
    expect(s.heartbeat).toBeNull();

    // Mirror side of the same contract: adopting a remote timer, then stopping locally, logs exactly once.
    await page.evaluate(({ room, t0 }) => window.__fbTest.remoteWrite(`rooms/${room}/timer`, {
      lastTask: 'Phone task', running: true, stopped: false, intervalSecs: 1800, startedAt: t0 + 21 * 60000,
      taskStartTime: t0 + 21 * 60000, blockStartTime: t0 + 21 * 60000, pausedRemaining: null, ownerDeviceId: 'device-b',
      mode: null, focusPhase: null, takeover: false, updatedAt: Date.now() + 2000, updatedBy: 'device-b', deviceName: 'phone', ownerRoom: room
    }), { room: A, t0: T0 });
    await page.waitForFunction(() => running && currentTask === 'Phone task');
    await setNow(page, T0 + 41 * MIN);
    await page.evaluate(() => stopAndLog());
    const after = await state(page);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]).toMatchObject({ activity: 'Phone task', tsStart: T0 + 21 * MIN });
    const remoteTimer = await page.evaluate(room => window.__fbTest.get(`rooms/${room}/timer`), A);
    expect(remoteTimer).toMatchObject({ running: false, stopped: true });
  });

  test('S4: a ping delayed by long suspension fires once, fabricates no entry and keeps the task start', async ({ context }) => {
    const page = await openApp(context);
    await startTimer(page, 'Writing');
    const start = (await state(page)).taskStartTime;
    await letPingFire(page, T0 + 75 * MIN);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1500);
    const s = await state(page);
    expect(s.pingCount).toBe(1);
    expect(s.entries).toHaveLength(0);
    expect(s.taskStartTime).toBe(start);
    expect(s.blockStartTime).toBeGreaterThanOrEqual(T0 + 75 * MIN);
  });

  async function pingThenTapNotification(context) {
    const page = await openApp(context, {
      entriesA: [entry('Writing', 'deep', T0 - 26 * 60 * MIN, T0 - 25 * 60 * MIN)]
    });
    await startTimer(page, 'Writing');
    const start = (await state(page)).taskStartTime;
    await letPingFire(page, T0 + 30 * MIN + 5000);
    // A notification tap (native localNotificationActionPerformed or the SW 'open-log' message)
    // calls openQuickLog(); the user then taps "Continue: Writing" ten seconds later.
    await setNow(page, T0 + 30 * MIN + 15 * 1000);
    await page.evaluate(() => openQuickLog());
    await expect(page.locator('#quicklog-overlay')).toHaveClass(/open/);
    await expect(page.locator('#ql-continue-btn')).toBeVisible();
    await page.locator('#ql-continue-btn').click();
    // Preconditions: exactly one quick-log entry was created, for the continued activity, and the timer runs on.
    const s = await state(page);
    const created = s.entries.filter(e => e.quickLogged && e.ts > T0);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ activity: 'Writing', energy: 'deep' });
    expect(created[0].ts).toBeGreaterThanOrEqual(T0 + 30 * MIN + 15 * 1000);
    expect(s.slotEntries.some(e => e.id === created[0].id)).toBe(true);
    expect(s.running).toBe(true);
    return { start, created: created[0] };
  }

  test('F-4 a notification-tap quick log preserves the pending start through Save', async ({ context }) => {
    const { start, created } = await pingThenTapNotification(context);
    expect(created.tsStart).toBe(start);
  });

  test('F-5 a quick log must not store a duration its own instants do not support', async ({ context }) => {
    const { created } = await pingThenTapNotification(context);
    const measuredMin = (created.ts - created.tsStart) / MIN;
    expect(Math.abs(created.blockIntervalMin - measuredMin)).toBeLessThan(1);
  });

  test('S2: quick log during a running task, then Stop: nothing is fabricated outside the task span (overlap recorded, D-2)', async ({ context }) => {
    const page = await openApp(context, {
      entriesA: [entry('Writing', 'deep', T0 - 26 * 60 * MIN, T0 - 25 * 60 * MIN)]
    });
    await startTimer(page, 'Writing');
    const start = (await state(page)).taskStartTime;
    await letPingFire(page, T0 + 30 * MIN + 5000);
    await setNow(page, T0 + 40 * MIN);
    await page.evaluate(() => openQuickLog());
    await page.locator('#ql-continue-btn').click();
    const afterQuickLog = (await state(page)).entries.filter(e => e.ts > T0);
    expect(afterQuickLog).toHaveLength(1);
    expect(afterQuickLog[0]).toMatchObject({ activity: 'Writing', quickLogged: true });
    expect(afterQuickLog[0].ts).toBeGreaterThanOrEqual(T0 + 40 * MIN);
    await setNow(page, T0 + 50 * MIN);
    await page.evaluate(() => stopAndLog());
    const created = (await state(page)).entries.filter(e => e.ts > T0);
    expect(created).toHaveLength(2);
    expect(created.filter(e => e.quickLogged).map(e => e.id)).toEqual([afterQuickLog[0].id]);
    const stopEnd = Math.max(...created.map(e => e.ts));
    for (const e of created) {
      expect(e.tsStart).toBeGreaterThanOrEqual(start);
      expect(e.ts).toBeLessThanOrEqual(stopEnd);
    }
    const ranges = created.map(e => [e.tsStart, e.ts]).sort((a, b) => a[0] - b[0]);
    let union = 0, sum = 0, cursor = -Infinity;
    for (const [s, e] of ranges) {
      sum += e - s;
      if (e > cursor) { union += e - Math.max(s, cursor); cursor = e; }
    }
    expect(Math.round(union / MIN)).toBe(50);
    // Observation only (no assertion): how much of the task span is covered twice today.
    test.info().annotations.push({ type: 'D-2 observed', description: `${created.length} entries, ${Math.round((sum - union) / MIN)} min covered twice` });
  });

  test('S5: browser notification permission denied: the timer starts and pings without crashing or corrupting data', async ({ context }) => {
    const errors = [];
    context.on('weberror', err => errors.push(String(err.error())));
    const seeded = entry('Reading', 'shallow', T0 - 60 * MIN, T0 - 30 * MIN);
    const page = await openApp(context, { notification: 'denied', entriesA: [seeded] });
    await startTimer(page, 'Writing');
    await letPingFire(page, T0 + 31 * MIN);
    await setNow(page, T0 + 40 * MIN);
    await page.evaluate(() => stopAndLog());
    const s = await state(page);
    expect(s.entries.map(e => e.activity).sort()).toEqual(['Reading', 'Writing']);
    expect(s.entries.find(e => e.activity === 'Reading')).toMatchObject({ tsStart: seeded.tsStart, ts: seeded.ts });
    expect(errors).toEqual([]);
  });

  test('S5: a permission request that throws does not block starting the timer', async ({ context }) => {
    const errors = [];
    context.on('weberror', err => errors.push(String(err.error())));
    const page = await openApp(context, { notification: 'throws' });
    await startTimer(page, 'Writing');
    const s = await state(page);
    expect(s.running).toBe(true);
    expect(errors).toEqual([]);
  });

  test('S5: native (Capacitor JS bridge) permission denied: no crash, rejected schedules are absorbed, logging still works', async ({ context }) => {
    const errors = [];
    context.on('weberror', err => errors.push(String(err.error())));
    const page = await openApp(context, { native: true });
    await page.waitForFunction(() => (window.__nativeCalls || []).includes('requestPermissions'));
    await startTimer(page, 'Writing');
    await letPingFire(page, T0 + 31 * MIN);
    await setNow(page, T0 + 40 * MIN);
    await page.evaluate(() => stopAndLog());
    const s = await state(page);
    const calls = await page.evaluate(() => window.__nativeCalls);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].activity).toBe('Writing');
    expect(calls).toContain('requestPermissions');
    expect(calls).toContain('schedule'); // scheduleNativePing() still calls the plugin; its rejection is absorbed
    expect(errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C/D. Logging, persistence and synchronization (scenarios 6-9)
// ─────────────────────────────────────────────────────────────────────────────

// A pre-existing remote entry makes the app record a last-sync stamp on load, as on a real device.
const priorRemote = room => ({
  rooms: { [room]: { entries: { [`e_${T0 - 60 * MIN}`]: entry('Reading', 'shallow', T0 - 90 * MIN, T0 - 60 * MIN) } } }
});

test.describe('C/D. Logging, persistence and sync', () => {
  test('S6: an entry logged while offline is kept locally and pushed on reconnect', async ({ context }) => {
    const page = await openApp(context, { remote: priorRemote(A), entriesA: [entry('Reading', 'shallow', T0 - 90 * MIN, T0 - 60 * MIN)] });
    await goOffline(page);
    await startTimer(page, 'Writing');
    await setNow(page, T0 + 20 * MIN);
    await page.evaluate(() => stopAndLog());
    const offline = await state(page);
    const logged = offline.entries.find(e => e.activity === 'Writing');
    expect(logged).toBeTruthy();
    expect(offline.slotEntries.some(e => e.id === logged.id)).toBe(true);
    expect((await remoteEntries(page)).some(e => e.id === logged.id)).toBe(false);
    // Stub-dependent: the stub rejects offline writes; the real SDK keeps them pending, so no toast there.
    await expect(page.locator('#toast')).toContainText('saved locally');

    await goOnline(page);
    await expect.poll(async () => (await remoteEntries(page)).some(e => e.id === logged.id)).toBe(true);
    const pushed = (await remoteEntries(page)).find(e => e.id === logged.id);
    expect(pushed).toMatchObject({ activity: 'Writing', tsStart: logged.tsStart, ts: logged.ts });
  });

  test('S6: an offline entry survives a reload while still offline and is pushed once the device reconnects', async ({ context }) => {
    const page0 = await openApp(context, { remote: priorRemote(A), entriesA: [entry('Reading', 'shallow', T0 - 90 * MIN, T0 - 60 * MIN)] });
    await goOffline(page0);
    await startTimer(page0, 'Writing');
    await setNow(page0, T0 + 20 * MIN);
    await page0.evaluate(() => stopAndLog());
    const logged = (await state(page0)).entries.find(e => e.activity === 'Writing');

    const page = await reopen(context, page0, T0 + 25 * MIN);
    expect((await state(page)).entries.some(e => e.id === logged.id)).toBe(true);
    expect((await remoteEntries(page)).some(e => e.id === logged.id)).toBe(false);
    await goOnline(page);
    await expect.poll(async () => (await remoteEntries(page)).some(e => e.id === logged.id)).toBe(true);
  });

  test('S7: an offline entry of account A is never pushed into account B, and reaches A when A reconnects', async ({ context }) => {
    const page = await openApp(context, { remote: priorRemote(A), entriesA: [entry('Reading', 'shallow', T0 - 90 * MIN, T0 - 60 * MIN)] });
    await goOffline(page);
    await startTimer(page, 'A private task');
    await setNow(page, T0 + 20 * MIN);
    await page.evaluate(() => stopAndLog());
    const logged = (await state(page)).entries.find(e => e.activity === 'A private task');
    expect(logged).toBeTruthy();

    await page.evaluate(() => window.__fbTest.signInAs('account-b'));
    await ready(page, B);
    await goOnline(page);
    await page.waitForTimeout(500);
    const bView = await page.evaluate(() => entries.map(e => e.activity));
    expect(bView).not.toContain('A private task');
    expect((await remoteEntries(page, B)).map(e => e.activity)).not.toContain('A private task');
    expect((await remoteEntries(page, A)).some(e => e.id === logged.id)).toBe(false);

    await page.evaluate(() => window.__fbTest.signInAs('account-a'));
    await ready(page, A);
    await expect.poll(async () => (await remoteEntries(page, A)).some(e => e.id === logged.id)).toBe(true);
    expect((await remoteEntries(page, B)).map(e => e.activity)).not.toContain('A private task');
  });

  test('S8: automatic tracking never rewrites an overlapping manual entry, and a stale remote copy cannot overwrite it', async ({ context }) => {
    const manual = entry('Writing', 'deep', T0 - 30 * MIN, T0, { updatedAt: T0 + 1 });
    const page = await openApp(context, { now: T0 + 1 * MIN, entriesA: [manual] });
    await setNow(page, T0 - 30 * MIN);
    await startTimer(page, 'PC Time');
    await setNow(page, T0 + 2 * MIN);
    // Exactly what the PC Time live ticker and Android usage sync call.
    await page.evaluate(() => autoLogBlock('PC Time', 'shallow', blockStartTime, Date.now()));
    let s = await state(page);
    const stillManual = s.entries.find(e => e.id === manual.id);
    expect(stillManual).toMatchObject({
      activity: 'Writing', energy: 'deep', tsStart: manual.tsStart, ts: manual.ts, updatedAt: manual.updatedAt, retro: true
    });
    expect(s.entries.filter(e => e.autoLogged && e.activity === 'PC Time')).toHaveLength(1);

    await page.evaluate(({ room, m }) => window.__fbTest.remoteWrite(`rooms/${room}/entries/e_${m.id}`, {
      ...m, activity: 'PC Time', energy: 'shallow', autoLogged: true, retro: false, updatedAt: m.updatedAt - 10
    }), { room: A, m: manual });
    await page.waitForTimeout(300);
    s = await state(page);
    expect(s.entries.find(e => e.id === manual.id)).toMatchObject({ activity: 'Writing', energy: 'deep' });
  });

  test('S9: a timer block across local midnight keeps its exact instants and splits by authoritative day', async ({ context }) => {
    const start = Date.parse('2026-10-14T15:40:00Z'); // 23:40 Manila
    const end = Date.parse('2026-10-14T16:20:00Z');   // 00:20 Manila, next day
    const page = await openApp(context, { now: start });
    await startTimer(page, 'Late reading');
    await setNow(page, end);
    await page.evaluate(() => stopAndLog());
    const result = await page.evaluate(() => {
      const e = entries.find(x => x.activity === 'Late reading');
      const minutes = key => getEntriesForDateWindow(key)
        .filter(x => x.activity === 'Late reading')
        .reduce((sum, x) => sum + Math.round((x.ts - x.tsStart) / 60000), 0);
      return { tsStart: e.tsStart, ts: e.ts, date: e.date, day1: minutes('2026-10-14'), day2: minutes('2026-10-15') };
    });
    expect(result.tsStart).toBeGreaterThanOrEqual(start);
    expect(result.tsStart).toBeLessThan(start + 1000);
    expect(result.ts).toBeGreaterThanOrEqual(end);
    expect(result.ts).toBeLessThan(end + 1000);
    expect(result.day1).toBe(20);
    expect(result.day2).toBe(20);
    expect(result.date).toBe('2026-10-15'); // the stored `date` field is the stop day for a timer block
  });

  async function retroLog(page, task, startHHMM, endHHMM) {
    await page.evaluate(({ task, startHHMM, endHHMM }) => {
      document.getElementById('retro-task').value = task;
      document.getElementById('retro-qstart').value = startHHMM;
      document.getElementById('retro-qend').value = endHHMM;
      quickRetroLog();
    }, { task, startHHMM, endHHMM });
  }

  test('F-6 two retro logs that cross the same midnight must both survive locally and remotely', async ({ context }) => {
    const page = await openApp(context); // 2026-10-14 09:00 Manila
    await page.evaluate(() => setViewDate('2026-10-13'));
    await retroLog(page, 'Movie', '22:30', '00:30');
    await setNow(page, T0 + 1 * MIN);
    await retroLog(page, 'Sleep', '23:45', '07:00');
    await page.waitForTimeout(300);
    const s = await state(page);
    const remote = await remoteEntries(page);
    // Preconditions: both logs were created locally (each split at midnight), in memory and in the
    // account's local slot, and the sync push reached the remote.
    const midnight = Date.parse('2026-10-13T16:00:00Z');
    for (const list of [s.entries, s.slotEntries]) {
      expect(list.filter(e => e.activity === 'Movie').map(e => [e.tsStart, e.ts]).sort())
        .toEqual([[midnight - 90 * MIN, midnight], [midnight, midnight + 30 * MIN]]);
      expect(list.filter(e => e.activity === 'Sleep').map(e => [e.tsStart, e.ts]).sort())
        .toEqual([[midnight - 15 * MIN, midnight], [midnight, midnight + 7 * 60 * MIN]]);
    }
    expect(remote.length).toBeGreaterThan(0);
    // Contract: all four segments survive remotely, with distinct ids.
    expect(remote.filter(e => e.activity === 'Movie')).toHaveLength(2);
    expect(remote.filter(e => e.activity === 'Sleep')).toHaveLength(2);
    expect(new Set(s.entries.map(e => e.id)).size).toBe(s.entries.length);
  });

  test('F-7 two retro logs ending in the same minute must both survive locally and remotely', async ({ context }) => {
    const page = await openApp(context, { now: Date.parse('2026-10-14T06:00:00Z') }); // 14:00 Manila
    await retroLog(page, 'Lunch', '12:00', '12:30');
    await setNow(page, Date.parse('2026-10-14T06:01:00Z'));
    await retroLog(page, 'Email', '12:15', '12:30');
    await page.waitForTimeout(300);
    const s = await state(page);
    const remote = await remoteEntries(page);
    // Preconditions: both logs were created locally, in memory and in the account's local slot.
    const end = Date.parse('2026-10-14T04:30:00Z');
    for (const list of [s.entries, s.slotEntries]) {
      expect(list.map(e => [e.activity, e.tsStart, e.ts]).sort()).toEqual([
        ['Email', end - 15 * MIN, end],
        ['Lunch', end - 30 * MIN, end]
      ]);
    }
    expect(remote.length).toBeGreaterThan(0);
    expect(remote.map(e => e.activity).sort()).toEqual(['Email', 'Lunch']);
  });
});
