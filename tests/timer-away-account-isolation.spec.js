// Timer / Away Account Isolation V1 — direct account switches in the real browser runtime.
// Firebase is an in-memory, room-partitioned stub; no network or production data is used.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
const NOW = Date.parse('2026-09-30T08:00:00-07:00');
const A = 'uid_account-a';
const B = 'uid_account-b';
let appServer;
let appUrl;

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const log = { writes: [] };
  const tree = {};
  const listeners = new Map();
  const retained = [];
  const heldReads = [];
  let holdReadPrefix = null;
  let connected = true;
  let authCb = null;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const get = p => p.split('/').filter(Boolean).reduce((node, key) => node && node[key], tree);
  const put = (p, value) => {
    const parts = p.split('/').filter(Boolean);
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    if (value == null) delete node[parts.at(-1)]; else node[parts.at(-1)] = clone(value);
  };
  const snapshot = value => ({ val: () => clone(value ?? null), ref: { remove: () => Promise.resolve() } });
  const fire = p => (listeners.get(p) || []).forEach(cb => cb(snapshot(get(p))));
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
      retained.push({ path: refPath, cb });
      setTimeout(() => cb(snapshot(refPath === '.info/connected' ? connected : get(refPath))), 0);
      return cb;
    },
    off() { listeners.delete(refPath); },
    once(event, cb) {
      const answer = () => snapshot(get(refPath));
      if (holdReadPrefix && refPath.startsWith(holdReadPrefix)) {
        return new Promise(resolve => heldReads.push(() => {
          const result = answer();
          if (typeof cb === 'function') cb(result);
          resolve(result);
        }));
      }
      const result = answer();
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
    seed: (p, value) => put(p, value),
    remoteWrite(p, value) { put(p, value); fireUp(p); },
    fireLate(p) { retained.filter(item => item.path === p).forEach(item => item.cb(snapshot(get(p)))); },
    holdReads(prefix) { holdReadPrefix = prefix; },
    releaseReads() { holdReadPrefix = null; heldReads.splice(0).forEach(release => release()); },
    setConnected(value) {
      connected = value;
      (listeners.get('.info/connected') || []).forEach(cb => cb(snapshot(connected)));
    },
    signInAs: uid => authCb(user(uid)),
    signOut: () => authCb(null),
  };
  const auth = () => ({
    onAuthStateChanged(cb) { authCb = cb; setTimeout(() => cb(user(window.__initialUid || 'account-a')), 0); return () => {}; },
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

async function openApp(page, initialUid = 'account-a') {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ now, initialUid }) => {
    const RealDate = Date;
    let tick = now;
    window.Date = class MockDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [tick])); }
      static now() { return ++tick; }
    };
    window.__initialUid = initialUid;
    if (!sessionStorage.getItem('timer-away-seeded')) {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('ta3-onboarded', '1');
      localStorage.setItem('ta3-device-id', 'device-isolation');
      sessionStorage.setItem('ta3-session-started', '1');
      sessionStorage.setItem('timer-away-seeded', '1');
    }
  }, { now: NOW, initialUid });
  await page.goto(appUrl);
  await page.waitForFunction(room => globalThis.getChronaSenseRoomCode?.() === room, `uid_${initialUid}`);
  await page.waitForTimeout(150);
}

async function switchTo(page, uid) {
  await page.evaluate(() => { window.__writeMark = window.__fbTest.log.writes.length; });
  await page.evaluate(nextUid => window.__fbTest.signInAs(nextUid), uid);
  await page.waitForFunction(room => globalThis.getChronaSenseRoomCode?.() === room, `uid_${uid}`);
  await page.waitForTimeout(150);
}

const writesSinceSwitch = page => page.evaluate(() => window.__fbTest.log.writes.slice(window.__writeMark));
const state = page => page.evaluate(() => ({
  room: roomCode,
  running,
  task: currentTask,
  timerOwnerRoom: timerStateOwnerRoom(),
  awayActive,
  awayLabel,
  awayOwnerRoom: awayStateOwnerRoom(),
  focusPhase: typeof pomodoroPhase === 'undefined' ? 'unavailable' : pomodoroPhase,
  activities: entries.filter(entry => !entry.deleted).map(entry => entry.activity)
}));
const roomValue = (page, room, child = '') => page.evaluate(({ room, child }) => window.__fbTest.get(`rooms/${room}${child ? `/${child}` : ''}`), { room, child });

test('A Timer -> B: B never sees or receives A timer state', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => _startTimer('A private timer'));
  await switchTo(page, 'account-b');

  const state = await page.evaluate(() => ({ running, currentTask, room: roomCode }));
  const writes = await writesSinceSwitch(page);
  expect.soft(state).toEqual({ running: false, currentTask: '', room: B });
  expect(writes.filter(write => write.path.startsWith(`rooms/${B}/`) && JSON.stringify(write.value).includes('A private timer'))).toEqual([]);
});

test('A Away -> B: B neither inherits nor completes A away state', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => startAway('A private away'));
  await switchTo(page, 'account-b');

  expect.soft(await page.evaluate(() => ({ awayActive, awayLabel, room: roomCode }))).toEqual({ awayActive: false, awayLabel: 'Away', room: B });
  await page.evaluate(() => { if (awayActive) toggleAway(); });
  const writes = await writesSinceSwitch(page);
  expect(writes.filter(write => write.path.startsWith(`rooms/${B}/`) && JSON.stringify(write.value).includes('A private away'))).toEqual([]);
});

test('A Timer -> B Timer: both timers remain independently room-owned', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => _startTimer('A timer'));
  await switchTo(page, 'account-b');
  await page.evaluate(() => _startTimer('B timer'));

  expect(await state(page)).toMatchObject({ room: B, running: true, task: 'B timer', timerOwnerRoom: B });
  expect(await roomValue(page, A, 'timer')).toMatchObject({ lastTask: 'A timer', ownerRoom: A });
  expect(await roomValue(page, B, 'timer')).toMatchObject({ lastTask: 'B timer', ownerRoom: B });

  await switchTo(page, 'account-a');
  expect(await state(page)).toMatchObject({ room: A, running: true, task: 'A timer', timerOwnerRoom: A });
});

test('A Away -> B Away: both Away states remain independently room-owned', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => startAway('A away'));
  await switchTo(page, 'account-b');
  await page.evaluate(() => startAway('B away'));

  expect(await state(page)).toMatchObject({ room: B, awayActive: true, awayLabel: 'B away', awayOwnerRoom: B });
  expect(await roomValue(page, A, 'awayState')).toMatchObject({ active: true, label: 'A away', ownerRoom: A });
  expect(await roomValue(page, B, 'awayState')).toMatchObject({ active: true, label: 'B away', ownerRoom: B });

  await switchTo(page, 'account-a');
  expect(await state(page)).toMatchObject({ room: A, awayActive: true, awayLabel: 'A away', awayOwnerRoom: A });
});

test('A -> B -> A restores A timer without ownership mutation or loss', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => _startTimer('A recoverable timer'));
  const aBefore = await roomValue(page, A, 'timer');
  await switchTo(page, 'account-b');
  expect(await state(page)).toMatchObject({ room: B, running: false, task: '', timerOwnerRoom: null });
  await switchTo(page, 'account-a');
  expect(await state(page)).toMatchObject({ room: A, running: true, task: 'A recoverable timer', timerOwnerRoom: A });
  expect(await roomValue(page, A, 'timer')).toMatchObject({ lastTask: aBefore.lastTask, ownerRoom: A });
});

test('a delayed A write callback after switching cannot resolve against B', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    _startTimer('A delayed timer');
    const ownerRoom = timerStateOwnerRoom();
    window.__delayedTimerWrite = new Promise(resolve => {
      window.__releaseDelayedTimerWrite = () => {
        resolve(syncTimerState({ ownerRoom, lastTask: 'A delayed timer' }));
      };
    });
  });
  await switchTo(page, 'account-b');
  await page.evaluate(() => window.__releaseDelayedTimerWrite());
  expect(await page.evaluate(() => window.__delayedTimerWrite)).toBe(false);
  expect(JSON.stringify(await roomValue(page, B))).not.toContain('A delayed timer');
});

test('a late A listener callback after switching cannot hydrate B', async ({ page }) => {
  await openApp(page);
  const remoteA = { running: true, lastTask: 'A late hydration', intervalSecs: 1800, startedAt: NOW - 60000, taskStartTime: NOW - 60000, blockStartTime: NOW - 60000, ownerDeviceId: 'other-a', ownerRoom: A, updatedAt: NOW, updatedBy: 'other-a' };
  await page.evaluate(({ A, remoteA }) => window.__fbTest.seed(`rooms/${A}/timer`, remoteA), { A, remoteA });
  await switchTo(page, 'account-b');
  await page.evaluate(A => window.__fbTest.fireLate(`rooms/${A}/timer`), A);
  await page.waitForTimeout(50);
  expect(await state(page)).toMatchObject({ room: B, running: false, task: '', timerOwnerRoom: null });
  expect(JSON.stringify(await roomValue(page, B))).not.toContain('A late hydration');
});

test('switch during held A hydration discards the stale snapshots', async ({ page }) => {
  await openApp(page);
  const remoteA = { running: true, lastTask: 'A held hydration', intervalSecs: 1800, startedAt: NOW - 60000, taskStartTime: NOW - 60000, blockStartTime: NOW - 60000, ownerDeviceId: 'other-a', ownerRoom: A, updatedAt: NOW, updatedBy: 'other-a' };
  await page.evaluate(({ A, remoteA }) => {
    window.__fbTest.seed(`rooms/${A}/timer`, remoteA);
    window.__fbTest.holdReads(`rooms/${A}/`);
    window.__heldHydration = forceSyncNow();
  }, { A, remoteA });
  await switchTo(page, 'account-b');
  await page.evaluate(() => window.__fbTest.releaseReads());
  expect(await page.evaluate(() => window.__heldHydration)).toBe(false);
  expect(await state(page)).toMatchObject({ room: B, running: false, task: '', timerOwnerRoom: null });
  expect(JSON.stringify(await roomValue(page, B))).not.toContain('A held hydration');
});

test('reconnect after an account switch never replays A state into B', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => _startTimer('A offline timer'));
  await page.evaluate(() => window.__fbTest.setConnected(false));
  await switchTo(page, 'account-b');
  await page.evaluate(() => { window.__writeMark = window.__fbTest.log.writes.length; window.__fbTest.setConnected(true); });
  await page.waitForTimeout(100);
  const writes = await writesSinceSwitch(page);
  expect(writes.filter(write => write.path.startsWith(`rooms/${B}/`) && JSON.stringify(write.value).includes('A offline timer'))).toEqual([]);
  expect(await state(page)).toMatchObject({ room: B, running: false, task: '' });
});

test('reload as B after A use ignores quarantined unowned residue and A scoped state', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    localStorage.setItem('ta3-timer', JSON.stringify({ running: true, currentTask: 'UNOWNED timer' }));
    localStorage.setItem('ta3-away-state', JSON.stringify({ active: true, label: 'UNOWNED away' }));
    _startTimer('A before reload');
  });
  await switchTo(page, 'account-b');
  await page.addInitScript(() => { window.__initialUid = 'account-b'; });
  await page.reload();
  await page.waitForFunction(B => globalThis.getChronaSenseRoomCode?.() === B, B);
  await page.waitForTimeout(150);
  expect(await state(page)).toMatchObject({ room: B, running: false, task: '', awayActive: false, timerOwnerRoom: null, awayOwnerRoom: null });
  expect(await page.evaluate(() => [localStorage.getItem('ta3-timer'), localStorage.getItem('ta3-away-state')])).toEqual([
    JSON.stringify({ running: true, currentTask: 'UNOWNED timer' }),
    JSON.stringify({ active: true, label: 'UNOWNED away' })
  ]);
  expect(JSON.stringify(await roomValue(page, B))).not.toMatch(/A before reload|UNOWNED/);
});

test('identical-looking timer payloads stay separated by owner identity', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => _startTimer('Same task'));
  await switchTo(page, 'account-b');
  await page.evaluate(() => _startTimer('Same task'));

  const [aTimer, bTimer, keys] = await Promise.all([
    roomValue(page, A, 'timer'),
    roomValue(page, B, 'timer'),
    page.evaluate(({ A, B }) => [localStorage.getItem(`ta3-timer:${A}`), localStorage.getItem(`ta3-timer:${B}`)], { A, B })
  ]);
  expect(aTimer.lastTask).toBe(bTimer.lastTask);
  expect(aTimer.ownerRoom).toBe(A);
  expect(bTimer.ownerRoom).toBe(B);
  expect(keys.every(Boolean)).toBe(true);
});

test('logout/login transition exposes no prior account Timer/Away state', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => _startTimer('A before logout'));
  await page.evaluate(() => window.__fbTest.signOut());
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode?.() === '');
  expect(await state(page)).toMatchObject({ room: '', running: false, task: '', awayActive: false, timerOwnerRoom: null });
  await page.evaluate(() => window.__fbTest.signInAs('account-b'));
  await page.waitForFunction(B => globalThis.getChronaSenseRoomCode?.() === B, B);
  await page.waitForTimeout(100);
  expect(await state(page)).toMatchObject({ room: B, running: false, task: '', awayActive: false, timerOwnerRoom: null });
  expect(JSON.stringify(await roomValue(page, B))).not.toContain('A before logout');
  await switchTo(page, 'account-a');
  expect(await state(page)).toMatchObject({ room: A, running: true, task: 'A before logout', timerOwnerRoom: A });
});

test('Focus/Pomodoro uses the same account-owned Timer boundary', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => enterFocusMode({ autoStart: true, task: 'A private focus' }));
  expect(await state(page)).toMatchObject({ room: A, focusPhase: 'work', timerOwnerRoom: A });
  await switchTo(page, 'account-b');
  expect(await state(page)).toMatchObject({ room: B, focusPhase: 'idle', timerOwnerRoom: null, task: '' });
  expect(JSON.stringify(await roomValue(page, B))).not.toContain('A private focus');
  await switchTo(page, 'account-a');
  expect(await state(page)).toMatchObject({ room: A, focusPhase: 'work', timerOwnerRoom: A });
});

test('normal single-account Timer and Away completion still log and sync to that account', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    _startTimer('A normal timer');
    taskStartTime = Date.now() - 61000;
    blockStartTime = taskStartTime;
    stopAndLog();
    startAway('A normal away');
    awayStartTime = Date.now() - 61000;
    persist();
    toggleAway();
  });
  await page.waitForTimeout(100);
  const aRoom = await roomValue(page, A);
  expect(Object.values(aRoom.entries || {}).map(entry => entry.activity)).toEqual(expect.arrayContaining(['A normal timer', 'A normal away']));
  expect(await state(page)).toMatchObject({ room: A, running: false, awayActive: false, timerOwnerRoom: null, awayOwnerRoom: null });
});

test('Timer/Away switching does not mutate Calendar-Native plan paths or authority', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => _startTimer('A calendar-neutral timer'));
  await switchTo(page, 'account-b');
  await page.evaluate(() => startAway('B calendar-neutral away'));
  const calendarWrites = await page.evaluate(() => window.__fbTest.log.writes.filter(write => /calendarPlans|calendarPlanAuthority/.test(write.path)));
  expect(calendarWrites).toEqual([]);
  expect(await page.evaluate(() => typeof globalThis.PlanAuthority?.current === 'function' && typeof globalThis.CalendarPlanLive?.authorityState === 'function')).toBe(true);
});
