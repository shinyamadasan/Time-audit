// TASK-014 — Normal Tracking HUD V1.
//
// Drives the real app (index.html + storage.js + focus-mode.js + windows-hud-bridge.js) and
// observes exactly what the page POSTs to the Windows HUD companion. Nothing here talks to a real
// companion: the loopback fetch is intercepted in-page and every POST body is recorded on the Node
// side in arrival order, across tabs. The companion's own acceptance/arbitration and rendering
// (privacy, stale indicator, hide) are covered by windows-hud/Test-HudNormalTracking.ps1.
//
// Firebase is the same in-memory, localStorage-persisted, room-partitioned stub TASK-013 uses
// (tests/daily-use-reliability.spec.js), so reloads, a second tab and sign-out run real app code.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
const MIN = 60 * 1000;
const A = 'uid_account-a';
const T0 = Date.parse('2026-10-14T01:00:00Z');
const POLL_WAIT_MS = 1500; // > one 1 s tracking poll
let appServer;
let appUrl;

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const load = (key, fallback) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
  const tree = load('__t14-remote', {});
  const log = { writes: [] };
  const listeners = new Map();
  let authCb = null;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const save = () => localStorage.setItem('__t14-remote', JSON.stringify(tree));
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
  const valueAt = p => p === '.info/connected' ? true : get(p);
  const snapshot = value => ({ val: () => clone(value ?? null), ref: { remove: () => Promise.resolve() } });
  const fire = p => (listeners.get(p) || []).forEach(cb => cb(snapshot(valueAt(p))));
  const fireUp = p => { let q = p; while (q) { fire(q); q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : ''; } };
  const write = (p, value) => { log.writes.push({ path: p, value: clone(value) }); put(p, value); fireUp(p); };
  const makeRef = refPath => ({
    path: refPath,
    key: refPath.split('/').pop(),
    child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(event, cb) {
      if (event !== 'value') return cb;
      if (!listeners.has(refPath)) listeners.set(refPath, []);
      listeners.get(refPath).push(cb);
      setTimeout(() => cb(snapshot(valueAt(refPath))), 0);
      return cb;
    },
    off() { listeners.delete(refPath); },
    once(event, cb) {
      const result = snapshot(get(refPath));
      if (typeof cb === 'function') setTimeout(() => cb(result), 0);
      return Promise.resolve(result);
    },
    update(values) { Object.entries(values || {}).forEach(([key, value]) => write(refPath + '/' + key, value)); return Promise.resolve(); },
    set(value) { write(refPath, value); return Promise.resolve(); },
    remove() { write(refPath, null); return Promise.resolve(); },
    transaction(fn) {
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
    signInAs: uid => authCb(user(uid)),
  };
  const auth = () => ({
    onAuthStateChanged(cb) { authCb = cb; setTimeout(() => cb(user('account-a')), 0); return () => {}; },
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

function settings() {
  return {
    hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [],
    timezone: 'UTC', activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00',
    sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: []
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

/** Opens a tab. All tabs of one context share localStorage (app state, stub remote, clock). */
async function openApp(context, { companion = 'up' } = {}) {
  if (!context.__hud) {
    context.__hud = [];
    let tabSeq = 0;
    await context.exposeBinding('__hudRecord', ({ page }, body) => {
      page.__tab = page.__tab || ++tabSeq;
      context.__hud.push({ tab: page.__tab, ...JSON.parse(body) });
    });
    await context.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
      status: 200, contentType: 'application/javascript', body: firebaseStub
    }));
    await context.addInitScript(seed => {
      if (location.protocol !== 'http:') return;
      const RealDate = Date;
      const clock = { base: Number(localStorage.getItem('__t14-now')) || seed.now, n: 0 };
      const tick = () => clock.base + (++clock.n);
      window.__t14 = { set(ts) { clock.base = ts; clock.n = 0; localStorage.setItem('__t14-now', String(ts)); } };
      window.Date = class MockDate extends RealDate {
        constructor(...args) { super(...(args.length ? args : [tick()])); }
        static now() { return tick(); }
      };
      window.Notification = class FakeNotification {
        static get permission() { return 'denied'; }
        static requestPermission() { return Promise.resolve('denied'); }
      };
      HTMLMediaElement.prototype.play = () => Promise.resolve();
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        if (String(url).startsWith('http://127.0.0.1:51739/')) {
          if (localStorage.getItem('__t14-companion') === 'down') return Promise.reject(new TypeError('Failed to fetch'));
          (window.__hudLocal = window.__hudLocal || []).push(JSON.parse(opts.body));
          window.__hudRecord(opts.body);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return realFetch(url, opts);
      };
      sessionStorage.setItem('ta3-session-started', '1');
      if (localStorage.getItem('__t14-seeded')) return;
      localStorage.clear();
      localStorage.setItem('__t14-seeded', '1');
      localStorage.setItem('__t14-now', String(seed.now));
      localStorage.setItem('ta3-onboarded', '1');
      localStorage.setItem('ta3-device-id', 'device-a');
      for (const room of ['uid_account-a', 'uid_account-b']) {
        localStorage.setItem(`ta3-tz:${room}`, 'UTC');
        localStorage.setItem(`ta3-settings:${room}`, JSON.stringify(seed.settings));
        localStorage.setItem(`ta3-entries:${room}`, '[]');
      }
    }, { now: T0, settings: settings() });
  }
  const page = await context.newPage();
  page.on('pageerror', err => { (context.__errors = context.__errors || []).push(String(err)); });
  await page.goto(appUrl);
  await page.evaluate(mode => localStorage.setItem('__t14-companion', mode), companion);
  await ready(page);
  return page;
}

async function ready(page) {
  await page.waitForFunction(r => typeof window.getHudTrackingFields === 'function'
    && window.chronaSenseHudBridge && globalThis.getChronaSenseRoomCode?.() === r, A);
  await page.waitForTimeout(250);
}

const hud = context => context.__hud;
const last = context => context.__hud.at(-1);
const appState = page => page.evaluate(() => ({
  running, currentTask, taskStartTime,
  selector: getHudTrackingFields(),
  entries: entries.filter(e => !e.deleted).map(e => ({ activity: e.activity, tsStart: e.tsStart, ts: e.ts })),
}));

async function startTracking(page, task) {
  expect(await page.evaluate(t => _startTimer(t), task)).toBe(true);
}

test.describe('TASK-014 normal tracking on the Windows HUD', () => {
  test('start -> the HUD shows the activity with its authoritative start time', async ({ context }) => {
    const page = await openApp(context);
    expect(hud(context)).toHaveLength(0); // no authoritative session -> nothing invented
    await startTracking(page, 'Deep work');
    const s = await appState(page);
    expect(last(context)).toMatchObject({
      type: 'tracking-active', title: 'Deep work', startedAt: s.taskStartTime,
      sessionKey: `tracking:${s.taskStartTime}`, pageVisibility: 'visible'
    });
    expect(typeof last(context).claimedAt).toBe('number');
    expect(Object.keys(last(context)).sort()).toEqual(['claimedAt', 'pageVisibility', 'sessionKey', 'startedAt', 'tab', 'title', 'type']);
  });

  test('stop -> the HUD is cleared at once, never left showing the completed session', async ({ context }) => {
    const page = await openApp(context);
    await startTracking(page, 'Deep work');
    const key = last(context).sessionKey;
    await page.evaluate(ts => window.__t14.set(ts), T0 + 25 * MIN);
    const countBeforeStop = hud(context).length;
    // Read in the same task as the stop: the clear must not wait for the 1 s safety-net poll.
    const pushedSynchronously = await page.evaluate(() => { stopAndLog(); return window.__hudLocal.at(-1); });
    expect(pushedSynchronously).toMatchObject({ type: 'focus-ended', sessionKey: key });
    await expect.poll(() => last(context)?.type).toBe('focus-ended');
    await page.waitForTimeout(POLL_WAIT_MS);
    expect(hud(context).filter(p => p.type === 'tracking-active' && hud(context).indexOf(p) >= countBeforeStop)).toHaveLength(0);
    const s = await appState(page);
    expect(s.running).toBe(false);
    expect(s.selector).toBeNull();
    expect(s.entries).toHaveLength(1); // exactly the one Stop entry; the HUD path logs nothing
  });

  test('activity change -> the HUD shows the new activity as a new session', async ({ context }) => {
    const page = await openApp(context);
    await startTracking(page, 'Email');
    const first = last(context);
    await page.evaluate(ts => window.__t14.set(ts), T0 + 10 * MIN);
    await startTracking(page, 'Report');
    const second = last(context);
    expect(second).toMatchObject({ type: 'tracking-active', title: 'Report' });
    expect(second.sessionKey).not.toBe(first.sessionKey);
    expect(second.claimedAt).toBeGreaterThan(first.claimedAt);
  });

  test('Focus during tracking -> Focus is shown; ending it shows tracking only if authoritative state confirms it', async ({ context }) => {
    const page = await openApp(context);
    await startTracking(page, 'Paused task');
    await page.evaluate(() => {
      enterFocusMode();
      document.getElementById('focus-task-input').value = 'Focus block';
      startPomodoro();
    });
    expect(last(context)).toMatchObject({ type: 'focus-active', title: 'Focus block', phase: 'work' });
    const focusIndex = hud(context).length - 1;
    await page.waitForTimeout(POLL_WAIT_MS);
    expect(hud(context).slice(focusIndex).every(p => p.type === 'focus-active')).toBe(true);

    await page.evaluate(() => confirmExitFocus());
    const s = await appState(page);
    // enterFocusMode() already logged and stopped 'Paused task', and confirmExitFocus() releases timer
    // ownership, so ChronaSense confirms no running normal session -> the HUD clears, never resurrects it.
    expect(s.selector).toBeNull();
    expect(last(context).type).toBe('focus-ended');
    await page.waitForTimeout(POLL_WAIT_MS);
    expect(hud(context).slice(focusIndex).some(p => p.type === 'tracking-active')).toBe(false);
  });

  // Pre-existing app behavior surfaced by TASK-014 (finding H-1 in TASK_014_HANDOFF.md, not changed here): the
  // Focus timer's own RTDB echo starts a normal ticker in applyRemoteTimerState(); once the 5-min break interval
  // elapses, doPing() re-syncs it as a NORMAL running timer named after the Focus block, and ChronaSense's own
  // Today hero shows it as tracking. The HUD must mirror exactly that authoritative state — never invent a
  // different one — and never project it while Focus itself is still active.
  test('Focus break ends inside the overlay -> the HUD shows only what ChronaSense itself reports', async ({ context }) => {
    const page = await openApp(context);
    await page.evaluate(() => {
      enterFocusMode();
      document.getElementById('focus-task-input').value = 'Focus block';
      startPomodoro();
    });
    await page.evaluate(ts => { window.__t14.set(ts); endWorkSession(); }, T0 + 30 * MIN);
    expect(last(context)).toMatchObject({ type: 'focus-active', phase: 'break' });
    expect((await appState(page)).selector).toBeNull(); // the echoed timer is never projected during Focus
    const breakIndex = hud(context).length;
    await page.evaluate(ts => { window.__t14.set(ts); _pomodoroAutoStart = false; endPomodoroBreak(); }, T0 + 36 * MIN);
    await page.waitForTimeout(POLL_WAIT_MS);
    const app = await page.evaluate(() => ({
      heroTracking: document.getElementById('activity-hero').classList.contains('tracking'),
      heroTask: document.getElementById('hero-task-name').textContent,
      remoteMode: window.__fbTest.get('rooms/uid_account-a/timer').mode,
      taskStartTime, selector: getHudTrackingFields()
    }));
    if (app.heroTracking && app.remoteMode == null) {
      expect(app.selector).toEqual({ title: app.heroTask, startedAt: app.taskStartTime });
      // The 1 s tracking poll projects a session up to one poll after the selector confirms it, and the sample
      // above can land inside that gap: wait for that projection instead of racing the poll.
      await expect.poll(() => last(context), { timeout: 5_000 })
        .toMatchObject({ type: 'tracking-active', title: app.heroTask, startedAt: app.taskStartTime });
      expect(hud(context).slice(breakIndex).filter(p => p.type === 'tracking-active')
        .every(p => p.title === app.heroTask && p.startedAt === app.taskStartTime)).toBe(true);
    } else {
      expect(app.selector).toBeNull();
      expect(last(context).type).toBe('focus-ended');
    }
  });

  test('entering Focus mode -> ChronaSense logs and stops the normal block, and the HUD clears in the same task', async ({ context }) => {
    const page = await openApp(context);
    await startTracking(page, 'Before focus');
    const active = last(context);
    await page.evaluate(ts => window.__t14.set(ts), T0 + 12 * MIN);
    const pushed = await page.evaluate(() => { enterFocusMode(); return window.__hudLocal.at(-1); });
    expect(pushed).toMatchObject({ type: 'focus-ended', sessionKey: active.sessionKey });
    const s = await appState(page);
    expect(s.running).toBe(false);
    expect(s.entries).toEqual([expect.objectContaining({ activity: 'Before focus' })]); // logged by the app, once
  });

  test('Focus alone keeps its pre-TASK-014 projection fields', async ({ context }) => {
    const page = await openApp(context);
    await page.evaluate(() => {
      enterFocusMode();
      document.getElementById('focus-task-input').value = 'Solo focus';
      startPomodoro();
    });
    expect(last(context)).toMatchObject({
      type: 'focus-active', title: 'Solo focus', phase: 'work', linkType: 'none', deviceOwned: true, pageVisibility: 'visible'
    });
    expect(last(context).plannedEndAt - last(context).startedAt).toBe(25 * MIN);
    await page.evaluate(() => confirmExitFocus());
    expect(last(context)).toMatchObject({ type: 'focus-ended' });
  });

  test('reload -> the restored session is re-projected with the same identity', async ({ context }) => {
    const page0 = await openApp(context);
    await startTracking(page0, 'Writing');
    const before = last(context);
    await page0.evaluate(ts => window.__t14.set(ts), T0 + 10 * MIN);
    await page0.reload();
    await ready(page0);
    await expect.poll(() => hud(context).length, { timeout: 5000 }).toBeGreaterThan(hud(context).indexOf(before) + 1);
    const s = await appState(page0);
    expect(s.running).toBe(true);
    expect(last(context)).toMatchObject({ type: 'tracking-active', title: 'Writing', sessionKey: before.sessionKey, startedAt: before.startedAt });
  });

  test('backgrounded tab -> visibility is reported as bridge metadata without changing the session', async ({ context }) => {
    const page = await openApp(context);
    await startTracking(page, 'Deep work');
    const active = last(context);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(last(context)).toMatchObject({
      type: 'tracking-active', pageVisibility: 'hidden', sessionKey: active.sessionKey, claimedAt: active.claimedAt
    });
  });

  test('two tabs -> a stale tab can only repeat the old session with an older claim than the stop', async ({ context }) => {
    const tabA = await openApp(context);
    await startTracking(tabA, 'Shared task');
    const started = last(context);
    const tabB = await openApp(context); // loads the same remote timer
    await expect.poll(() => hud(context).some(p => p.tab !== started.tab), { timeout: 5000 }).toBe(true);
    const fromB = hud(context).find(p => p.tab !== started.tab);
    expect(fromB).toMatchObject({ type: 'tracking-active', sessionKey: started.sessionKey });

    await tabA.evaluate(ts => window.__t14.set(ts), T0 + 20 * MIN);
    await tabA.evaluate(() => stopAndLog());
    await expect.poll(() => last(context)?.type).toBe('focus-ended');
    const ended = last(context);

    // Tab B has not heard about the stop yet; its next heartbeat is the dangerous one.
    await tabB.evaluate(() => chronaSenseHudBridge.refresh());
    const staleBeat = last(context);
    expect(staleBeat.tab).toBe(fromB.tab);
    expect(staleBeat).toMatchObject({ type: 'tracking-active', sessionKey: ended.sessionKey });
    // The companion drops it: a different key than nothing-on-screen, and claimedAt < the stop's claim.
    expect(staleBeat.claimedAt).toBeLessThan(ended.claimedAt);

    // Once B receives the authoritative stop, it clears too, naming the same session.
    const timer = await tabA.evaluate(r => window.__fbTest.get(`rooms/${r}/timer`), A);
    await tabB.evaluate(([r, t]) => window.__fbTest.remoteWrite(`rooms/${r}/timer`, t), [A, timer]);
    await expect.poll(() => last(context)).toMatchObject({ tab: fromB.tab, type: 'focus-ended', sessionKey: ended.sessionKey });
  });

  test('a timer owned by another device is never projected on this machine', async ({ context }) => {
    const page = await openApp(context);
    await page.evaluate(([r, ts]) => window.__fbTest.remoteWrite(`rooms/${r}/timer`, {
      lastTask: 'Phone task', running: true, stopped: false, intervalSecs: 1800,
      startedAt: ts, taskStartTime: ts, blockStartTime: ts, ownerDeviceId: 'device-phone',
      mode: null, updatedAt: ts + 1, updatedBy: 'device-phone', ownerRoom: r
    }), [A, T0 + 1000]);
    await expect.poll(() => page.evaluate(() => running)).toBe(true); // the app mirrors it…
    await page.waitForTimeout(POLL_WAIT_MS);
    expect((await appState(page)).selector).toBeNull(); // …but this device does not own it
    expect(hud(context)).toHaveLength(0);
  });

  test('sign-out -> the HUD is cleared and no later push carries the activity title', async ({ context }) => {
    const page = await openApp(context);
    await startTracking(page, 'Private client work');
    const count = hud(context).length;
    const cleared = await page.evaluate(() => { window.__fbTest.signInAs(null); return window.__hudLocal.at(-1); });
    expect(cleared.type).toBe('focus-ended'); // in the same task as the auth change
    await page.waitForTimeout(POLL_WAIT_MS);
    const after = hud(context).slice(count);
    expect(after.some(p => JSON.stringify(p).includes('Private client work'))).toBe(false);
    expect((await appState(page)).selector).toBeNull();
  });

  test('companion unavailable -> normal tracking starts, stops and logs exactly as without a HUD', async ({ context }) => {
    const page = await openApp(context, { companion: 'down' });
    await startTracking(page, 'Offline HUD');
    await page.waitForTimeout(POLL_WAIT_MS);
    expect((await appState(page)).running).toBe(true);
    await page.evaluate(ts => window.__t14.set(ts), T0 + 15 * MIN);
    await page.evaluate(() => stopAndLog());
    const s = await appState(page);
    expect(s.running).toBe(false);
    expect(s.entries).toEqual([expect.objectContaining({ activity: 'Offline HUD' })]);
    expect(hud(context)).toHaveLength(0);
    expect(context.__errors || []).toEqual([]);
  });

  test('repeated identical snapshots never write entries, Firebase or local state', async ({ context }) => {
    const page = await openApp(context);
    await startTracking(page, 'Deep work');
    const result = await page.evaluate(() => {
      const snapshotStorage = () => JSON.stringify(Object.keys(localStorage).sort()
        .filter(k => !k.startsWith('__t14')).map(k => [k, localStorage.getItem(k)]));
      const before = { storage: snapshotStorage(), writes: window.__fbTest.log.writes.length, entries: JSON.stringify(entries) };
      for (let i = 0; i < 25; i++) { chronaSenseHudBridge.refresh(); getHudTrackingFields(); }
      return {
        storageSame: snapshotStorage() === before.storage,
        writes: window.__fbTest.log.writes.length - before.writes,
        entriesSame: JSON.stringify(entries) === before.entries,
      };
    });
    expect(result).toEqual({ storageSame: true, writes: 0, entriesSame: true });
    const keys = new Set(hud(context).map(p => `${p.sessionKey}|${p.claimedAt}`));
    expect(keys.size).toBe(1); // 26 POSTs, one session, one claim
  });
});
