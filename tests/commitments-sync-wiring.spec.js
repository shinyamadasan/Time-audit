// Planning Continuity V1 — PRODUCTION commitment-sync wiring, in a real browser.
//
// The unit suite (commitments-sync.test.js) builds the bridge with fake deps, so it
// could not see the defect this spec exists for: the production singleton read
// globalThis.fbRoomRef, which index.html declares with a top-level `let` and is
// therefore never a window property. The bridge silently never synced.
//
// Here nothing is faked except Firebase itself. The app signs in through its own
// storage.js path, joins its own room, and the test only OBSERVES what the real
// window.CommitmentsSync singleton does against a recording Firebase stub:
//   - it resolves the real room ref (rooms/uid_<uid>)
//   - it registers a listener on rooms/<room>/commitments
//   - creating a commitment runs a transaction at rooms/<room>/commitments/<id>
//   - a remote value delivered on that listener is merged into local storage
//   - a write made while offline is pushed by storage.js's own reconnect handler
//
// No real Firebase project, no network, no production data.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';

const TZ = 'Asia/Manila';
const NOW = Date.parse('2026-09-18T19:00:00+08:00');
const UID = 'wiring-user';
const ROOM = `rooms/uid_${UID}`;

// A recording Firebase stub. Unlike the other specs' stubs it keeps an in-memory tree,
// records every transaction path and every listener path, lets the test deliver a
// remote value to a registered listener, and lets it flip .info/connected.
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const log = { transactions: [], listeners: [], sets: [] };
  const tree = {};
  const listeners = new Map();
  const get = p => p.split('/').filter(Boolean).reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), tree);
  const put = (p, v) => {
    const segs = p.split('/').filter(Boolean); let n = tree;
    for (let i = 0; i < segs.length - 1; i++) { if (typeof n[segs[i]] !== 'object' || n[segs[i]] === null) n[segs[i]] = {}; n = n[segs[i]]; }
    n[segs[segs.length - 1]] = v;
  };
  const snapshot = (value) => ({ val: () => (value === undefined ? null : JSON.parse(JSON.stringify(value))), ref: { remove: () => Promise.resolve() } });
  const fire = p => (listeners.get(p) || []).forEach(cb => cb(snapshot(get(p))));
  let connected = false;
  const makeRef = refPath => ({
    path: refPath,
    child(c) { return makeRef(refPath + '/' + c); },
    on(ev, cb) {
      if (ev !== 'value') return cb;
      log.listeners.push(refPath);
      if (!listeners.has(refPath)) listeners.set(refPath, []);
      listeners.get(refPath).push(cb);
      const value = refPath === '.info/connected' ? connected : get(refPath);
      setTimeout(() => cb(snapshot(value === undefined ? null : value)), 0);
      return cb;
    },
    off() { listeners.delete(refPath); },
    once() { return Promise.resolve(snapshot(get(refPath))); },
    update() { return Promise.resolve(); },
    set(v) { log.sets.push(refPath); put(refPath, v); return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    transaction(fn) {
      log.transactions.push(refPath);
      const cur = get(refPath);
      const next = fn(cur === undefined ? null : JSON.parse(JSON.stringify(cur)));
      if (next === undefined) return Promise.resolve({ committed: false, snapshot: snapshot(cur) });
      put(refPath, next);
      return Promise.resolve({ committed: true, snapshot: snapshot(next) });
    },
    push(v) { const r = makeRef(refPath + '/pushed'); r.key = 'pushed'; if (v !== undefined) r.set(v); return r; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; },
  });
  window.__fbTest = {
    log,
    get: p => JSON.parse(JSON.stringify(get(p) ?? null)),
    remoteWrite(p, v) { put(p, v); let q = p; while (q) { fire(q); q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : ''; } },
    setConnected(v) { connected = v; (listeners.get('.info/connected') || []).forEach(cb => cb(snapshot(v))); },
  };
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: '${UID}', displayName: 'Wiring', email: 'w@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(c) { const a = { config: c }; this.apps.push(a); return a; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
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
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${appServer.address().port}/index.html`;
});

test.afterAll(async () => {
  if (appServer) await new Promise(resolve => appServer.close(resolve));
});

async function openSignedIn(page, { commitments = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, commitments }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
    if (localStorage.getItem('wiring-seeded') === '1') return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('wiring-seeded', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', timezone);
    localStorage.setItem('ta3-device-id', 'device-wiring');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', '[]'); localStorage.setItem('ta3-plans', '{}'); localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    if (commitments) localStorage.setItem('ta3-commitments-v1', commitments);
  }, { timezone: TZ, now: NOW, commitments });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.CommitmentsSync === 'object' && !!window.__fbTest);
  // Wait for the REAL sign-in path to join the room through storage.js.
  await page.waitForFunction(() => typeof globalThis.getChronaSenseRoomRef === 'function' && !!globalThis.getChronaSenseRoomRef());
}

const commitmentRecord = (id, time, updatedAt, title = 'Dentist') => {
  const startMs = Date.parse(`2026-09-30T${time}:00+08:00`);
  return { schemaVersion: 1, id, title, precision: 'timed', date: '2026-09-30', time, timezone: TZ, startMs, createdAt: 1000, updatedAt, updatedBy: 'device-remote' };
};

test('the production singleton resolves the real room and registers the commitments listener', async ({ page }) => {
  await openSignedIn(page);
  const state = await page.evaluate(() => ({
    roomPath: globalThis.getChronaSenseRoomRef().path,
    listeners: window.__fbTest.log.listeners,
  }));
  expect(state.roomPath).toBe('rooms/uid_wiring-user');
  await expect.poll(() => page.evaluate(() => window.__fbTest.log.listeners)).toContain('rooms/uid_wiring-user/commitments');
});

test('creating a commitment runs a transaction at rooms/<room>/commitments/<id>', async ({ page }) => {
  await openSignedIn(page);
  await page.evaluate(() => window.__fbTest.setConnected(true));
  const id = await page.evaluate(() => {
    const created = window.CommitmentsRepository.create({ title: 'Dentist', date: '2026-09-30', time: '09:30', timezone: 'Asia/Manila' });
    return window.CommitmentsSync.syncCommitment(created.record.id).then(() => created.record.id);
  });
  const state = await page.evaluate(id => ({
    transactions: window.__fbTest.log.transactions,
    remote: window.__fbTest.get(`rooms/uid_wiring-user/commitments/${id}`),
  }), id);
  expect(state.transactions).toContain(`${ROOM}/commitments/${id}`);
  expect(state.remote.startMs).toBe(Date.parse('2026-09-30T09:30:00+08:00'));
});

test('adding a commitment through the UI form reaches Firebase through the real wiring', async ({ page }) => {
  await openSignedIn(page);
  await page.evaluate(() => window.__fbTest.setConnected(true));
  const section = page.locator('#planning-continuity-section');
  await section.getByRole('button', { name: 'Add commitment' }).click();
  const form = page.locator('#pc-commitment-form');
  await form.locator('input[name="title"]').fill('Dentist');
  await form.locator('input[name="date"]').fill('2026-09-30');
  await form.locator('input[name="time"]').fill('09:30');
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(section).toContainText('Dentist');
  const id = await page.evaluate(() => Object.keys(window.CommitmentsRepository.listAllRaw())[0]);
  await expect.poll(() => page.evaluate(() => window.__fbTest.log.transactions)).toContain(`${ROOM}/commitments/${id}`);
});

test('a remote update delivered on the listener is merged and shown', async ({ page }) => {
  await openSignedIn(page, { commitments: JSON.stringify({ schemaVersion: 1, commitments: { cshared1: commitmentRecord('cshared1', '09:30', 2000) } }) });
  await expect.poll(() => page.evaluate(() => window.__fbTest.log.listeners)).toContain(`${ROOM}/commitments`);

  // Another device moved the appointment later in the day.
  await page.evaluate(rec => window.__fbTest.remoteWrite('rooms/uid_wiring-user/commitments/cshared1', rec),
    commitmentRecord('cshared1', '15:00', 9000));
  await expect.poll(() => page.evaluate(() => window.CommitmentsRepository.read('cshared1').time)).toBe('15:00');
  await expect(page.locator('#planning-continuity-section')).toContainText('3:00 PM');

  // A brand-new remote commitment also arrives.
  await page.evaluate(rec => window.__fbTest.remoteWrite('rooms/uid_wiring-user/commitments/cremote2', rec),
    commitmentRecord('cremote2', '11:00', 9500, 'Remote call'));
  await expect.poll(() => page.evaluate(() => !!window.CommitmentsRepository.read('cremote2'))).toBe(true);
  await expect(page.locator('#planning-continuity-section')).toContainText('Remote call');
});

test('an offline write is pushed by storage.js\'s own reconnect handler', async ({ page }) => {
  await openSignedIn(page);
  // Take the room away, exactly as sign-out/room loss does, so the write cannot push.
  const id = await page.evaluate(async () => {
    const realGetter = globalThis.getChronaSenseRoomRef;
    globalThis.getChronaSenseRoomRef = () => null;
    const created = window.CommitmentsRepository.create({ title: 'Offline dentist', date: '2026-10-02', time: '10:00', timezone: 'Asia/Manila' });
    await window.CommitmentsSync.syncCommitment(created.record.id);
    globalThis.getChronaSenseRoomRef = realGetter;
    return created.record.id;
  });
  expect(await page.evaluate(() => window.CommitmentsSync.pendingPushIds())).toEqual([id]);
  expect(await page.evaluate(id => window.__fbTest.get(`rooms/uid_wiring-user/commitments/${id}`), id)).toBeNull();

  // Reconnect through the REAL path: storage.js's .info/connected handler calls
  // CommitmentsSync.pushAllLocal(). The test never calls pushAllLocal itself.
  await page.evaluate(() => window.__fbTest.setConnected(true));
  await expect.poll(() => page.evaluate(id => window.__fbTest.get(`rooms/uid_wiring-user/commitments/${id}`)?.title, id)).toBe('Offline dentist');
  expect(await page.evaluate(() => window.CommitmentsSync.pendingPushIds())).toEqual([]);
});

test('a commitment stored before sign-in is pushed once the room is joined', async ({ page }) => {
  await openSignedIn(page, { commitments: JSON.stringify({ schemaVersion: 1, commitments: { cbefore1: commitmentRecord('cbefore1', '08:00', 1500, 'Stored earlier') } }) });
  await page.evaluate(() => window.__fbTest.setConnected(true));
  await expect.poll(() => page.evaluate(() => window.__fbTest.get('rooms/uid_wiring-user/commitments/cbefore1')?.title)).toBe('Stored earlier');
});
