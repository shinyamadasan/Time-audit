// Personal Day Boundary — cross-device convergence, in the REAL app.
//
// The node suite (personal-day-boundary-cross-device.test.js) proves the revision
// semantics converge. It cannot see the two production defects this spec exists for,
// because both live in how index.html / storage.js / the deferred ES modules are wired:
//
//   1. STARTUP RACE. storage.js joins the account room from firebase.auth()'s
//      onAuthStateChanged and calls PersonalDayBoundaryLive.attachLiveDays() only
//      `if (globalThis.PersonalDayBoundaryLive)`. That singleton is created by a
//      DEFERRED module graph, so on a device where auth resolves first (slow module
//      fetch — a cold mobile load) the attach was skipped and never retried: the
//      device never subscribed to dayBoundaryRevisions and stayed on the default.
//   2. NO RECOMPUTE / FALSE "OFF". An arriving revision repainted Settings only, and
//      the Settings panel said "Off" for a device that simply had not heard from the
//      account yet.
//
// Nothing is faked except Firebase itself (a recording in-memory stub) and the clock.
// No real project, no network, no production data.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyBoundaryRevision, proposeBoundaryRevision } from '../personal-day-boundary-model.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';

const TZ = 'Asia/Manila';
const UID = 'cross-device-user';
const REVISIONS_PATH = `rooms/uid_${UID}/dayBoundaryRevisions`;
const T_0800 = Date.parse('2026-09-16T08:00:00+08:00');
const T_1900 = Date.parse('2026-09-16T19:00:00+08:00');

/** The account's authoritative history as the PC would have pushed it: the legacy
 *  anchor plus one 18:00 revision proposed at 08:00 (activates 18:00 the same day). */
function accountHistory() {
  const anchor = legacyBoundaryRevision(TZ);
  const { revision } = proposeBoundaryRevision([anchor], { id: 'pc-18-00', boundaryTime: '18:00', timezone: TZ }, T_0800);
  return { [anchor.id]: anchor, [revision.id]: revision };
}

// Recording Firebase stub. `held` paths keep their first `.on('value')` delivery
// pending until the test releases it — that is "the account has not been heard from
// yet" (a slow/offline first snapshot), the exact state the UI must not call "Off".
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const log = { transactions: [], listeners: [] };
  const tree = {};
  const held = new Set();
  const pending = new Map();
  const listeners = new Map();
  const seedConfig = window.__fbSeed || {};
  const get = p => p.split('/').filter(Boolean).reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), tree);
  const put = (p, v) => {
    const segs = p.split('/').filter(Boolean); let n = tree;
    for (let i = 0; i < segs.length - 1; i++) { if (typeof n[segs[i]] !== 'object' || n[segs[i]] === null) n[segs[i]] = {}; n = n[segs[i]]; }
    n[segs[segs.length - 1]] = v;
  };
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const snapshot = value => ({ val: () => clone(value), ref: { remove: () => Promise.resolve() } });
  const fire = p => (listeners.get(p) || []).forEach(cb => cb(snapshot(get(p))));
  const makeRef = refPath => ({
    path: refPath,
    child(c) { return makeRef(refPath + '/' + c); },
    on(ev, cb) {
      if (ev !== 'value') return cb;
      log.listeners.push(refPath);
      if (!listeners.has(refPath)) listeners.set(refPath, []);
      listeners.get(refPath).push(cb);
      const deliver = () => cb(snapshot(refPath === '.info/connected' ? false : get(refPath)));
      if (held.has(refPath)) pending.set(refPath, deliver); else setTimeout(deliver, 0);
      return cb;
    },
    off() { listeners.delete(refPath); },
    once() { return Promise.resolve(snapshot(get(refPath))); },
    update() { return Promise.resolve(); },
    set(v) { put(refPath, v); return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    transaction(fn) {
      log.transactions.push(refPath);
      const cur = get(refPath);
      const next = fn(clone(cur));
      if (next === undefined) return Promise.resolve({ committed: false, snapshot: snapshot(cur) });
      put(refPath, next);
      return Promise.resolve({ committed: true, snapshot: snapshot(next) });
    },
    push(v) { const r = makeRef(refPath + '/pushed'); r.key = 'pushed'; if (v !== undefined) r.set(v); return r; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; },
  });
  if (seedConfig.remote) put(seedConfig.path, seedConfig.remote);
  if (seedConfig.held) held.add(seedConfig.path);
  window.__fbTest = {
    log,
    get: p => clone(get(p)),
    seed(p, v) { put(p, v); },
    hold(p) { held.add(p); },
    release(p) { held.delete(p); const d = pending.get(p); pending.delete(p); if (d) d(); },
    remoteWrite(p, v) { put(p, v); fire(p); },
  };
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: '${UID}', displayName: 'Cross Device', email: 'cd@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
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

/** Opens the app as ONE device of the account. `remote` seeds the fake cloud,
 *  `cache` seeds this device's localStorage boundary cache, `held` keeps the first
 *  boundary snapshot pending, `gateModule` delays the deferred boundary module so
 *  auth/room-join provably resolves first. Resolves once the room is joined. */
async function openDevice(page, { now = T_1900, remote = null, cache = null, held = false, gateModule = null, deviceId = 'device-x' } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  if (gateModule) await page.route('**/personal-day-boundary-live.js*', async route => { await gateModule.promise; await route.continue(); });
  await page.addInitScript(({ timezone, now, remote, cache, held, revisionsPath, deviceId }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
    if (localStorage.getItem('xd-seeded') !== '1') {
      localStorage.clear(); sessionStorage.clear();
      localStorage.setItem('xd-seeded', '1');
      localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
      localStorage.setItem('ta3-tz', timezone);
      localStorage.setItem('ta3-device-id', deviceId);
      localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
      localStorage.setItem('ta3-entries', '[]'); localStorage.setItem('ta3-plans', '{}'); localStorage.setItem('ta3-reviews', '{}');
      localStorage.setItem('ta3-focus-redemptions', '[]');
      localStorage.setItem('ta3-daily-routines-v1', JSON.stringify({ schemaVersion: 1, timezone, routines: [], manual: {}, links: {}, focus: {}, skips: {} }));
      if (cache) localStorage.setItem('ta3-day-boundary-revisions-v1', cache);
    }
    window.__fbSeed = { remote, held, path: revisionsPath };
  }, { timezone: TZ, now, remote, cache, held, revisionsPath: REVISIONS_PATH, deviceId });
  await page.goto(appUrl, { waitUntil: 'commit' });
  // storage.js assigns getChronaSenseRoomRef before the `let fbRoomRef` it closes over has been
  // evaluated, so polling while the classic scripts are still running throws a ReferenceError.
  // (The deferred modules under test always run after that parse, so the app never sees it.)
  await page.waitForFunction(() => {
    try { return typeof globalThis.getChronaSenseRoomRef === 'function' && !!globalThis.getChronaSenseRoomRef(); } catch { return false; }
  });
}

const settingsPanel = page => page.locator('#personal-day-boundary-settings');
const openSettings = page => page.evaluate(() => showView('settings'));
const boundaryStore = page => page.evaluate(() => localStorage.getItem('ta3-day-boundary-revisions-v1'));
const moduleReady = page => page.waitForFunction(() => typeof window.PersonalDayBoundaryLive === 'object' && typeof window.PlanAuthority === 'object' && typeof window.renderPersonalDayBoundarySettings === 'function');

// ── 1. the startup race ─────────────────────────────────────────────────────

test('a device whose room joins BEFORE the deferred boundary module loads still subscribes and converges on the account boundary', async ({ page }) => {
  let release;
  const gateModule = { promise: new Promise(resolve => { release = resolve; }) };
  await openDevice(page, { remote: accountHistory(), gateModule });

  // Prove the interesting ordering really happened: the room is joined, the module is not.
  expect(await page.evaluate(() => typeof window.PersonalDayBoundaryLive)).toBe('undefined');
  expect(await page.evaluate(() => window.__fbTest.log.listeners.includes(`rooms/uid_cross-device-user/dayBoundaryRevisions`))).toBe(false);

  release();
  await moduleReady(page);

  // The module found the room already joined and attached itself (storage.js's one-shot call had found nothing).
  await expect.poll(() => page.evaluate(p => window.__fbTest.log.listeners.includes(p), REVISIONS_PATH)).toBe(true);
  await expect.poll(() => boundaryStore(page)).not.toBeNull();
  await page.evaluate(() => showView('settings'));
  await expect(settingsPanel(page)).toContainText('Current: 18:00');
  await expect(settingsPanel(page)).not.toContainText('Off.');
});

// ── 2. honest neutral state, then convergence + recompute ───────────────────

test('until the account has been heard from, Settings is neutral (not "Off"), Save is blocked, and the arrival recomputes Settings AND Today', async ({ page }) => {
  await openDevice(page, { remote: accountHistory(), held: true });
  await moduleReady(page);
  await expect.poll(() => page.evaluate(p => window.__fbTest.log.listeners.includes(p), REVISIONS_PATH)).toBe(true);

  await openSettings(page);
  await expect(settingsPanel(page)).toContainText('Checking your synced personal day setting');
  await expect(settingsPanel(page)).not.toContainText('Off. Your day currently starts at midnight');
  await expect(settingsPanel(page).getByRole('button', { name: /personal day/i })).toBeDisabled();
  expect(await boundaryStore(page)).toBeNull();
  // Today is still on the default derivation — and the authority layer agrees it is legacy.
  expect(await page.evaluate(() => window.PlanAuthority.enabled())).toBe(false);
  await page.evaluate(() => showView('today'));
  await expect(page.locator('#timeline-date-label')).toHaveText("Today's timeline");
  await openSettings(page);

  // The authoritative snapshot arrives.
  await page.evaluate(p => window.__fbTest.release(p), REVISIONS_PATH);

  await expect(settingsPanel(page)).toContainText('Current: 18:00');
  await expect(settingsPanel(page)).not.toContainText('Checking your synced');
  expect(await page.evaluate(() => window.PlanAuthority.enabled())).toBe(true);
  // The derived caches were dropped: Today's authoritative current day is now the 18:00 personal day.
  const current = await page.evaluate(() => window.PlanAuthority.current());
  expect(current.store).toBe('operational');
  expect(current.startMs).toBe(Date.parse('2026-09-16T18:00:00+08:00'));
  // ...and the visible My Day timeline was rebuilt for it, not left on the calendar day.
  await page.evaluate(() => showView('today'));
  await expect(page.locator('#timeline-date-label')).toHaveText('My Day · Wed Sep 16, 6:00 PM → Thu Sep 17, 6:00 PM');
});

test('an account that is authoritatively empty really is Off once it has been heard from', async ({ page }) => {
  await openDevice(page, { remote: null });
  await moduleReady(page);
  await openSettings(page);
  await expect(settingsPanel(page)).toContainText('Off. Your day currently starts at midnight');
  await expect(settingsPanel(page)).not.toContainText('Checking your synced');
});

// ── 3. PC -> fresh mobile, offline launch, stale cache ──────────────────────

test('PC saves 18:00 through the UI; a fresh MOBILE device with an empty cache converges on the identical personal day', async ({ browser }) => {
  const pcContext = await browser.newContext();
  const pc = await pcContext.newPage();
  await openDevice(pc, { now: T_0800, deviceId: 'device-pc' });
  await moduleReady(pc);
  await openSettings(pc);
  await settingsPanel(pc).locator('[data-pdb-input="time"]').fill('18:00');
  await settingsPanel(pc).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await settingsPanel(pc).getByRole('button', { name: 'Turn on personal day boundary' }).click();
  await expect.poll(() => pc.evaluate(p => window.__fbTest.get(p), REVISIONS_PATH)).not.toBeNull();
  const pushed = await pc.evaluate(p => window.__fbTest.get(p), REVISIONS_PATH);
  expect(Object.keys(pushed)).toHaveLength(2);
  const pcDays = await pc.evaluate(t => { const d = window.PersonalDayBoundaryLive.planningDays(t); return { current: d.current.authority, upcoming: d.upcoming.authority }; }, T_1900);

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' });
  const mobile = await mobileContext.newPage();
  await openDevice(mobile, { now: T_1900, remote: pushed, deviceId: 'device-mobile' });
  await moduleReady(mobile);
  await expect.poll(() => boundaryStore(mobile)).not.toBeNull();
  await openSettings(mobile);
  await expect(settingsPanel(mobile)).toContainText('Current: 18:00');
  const mobileDays = await mobile.evaluate(t => { const d = window.PersonalDayBoundaryLive.planningDays(t); return { current: d.current.authority, upcoming: d.upcoming.authority }; }, T_1900);
  expect(mobileDays).toEqual(pcDays);
  await pcContext.close(); await mobileContext.close();
});

test('a mobile that already synced 18:00 and launches with NO account snapshot (offline) still uses its cached 18:00', async ({ page }) => {
  const cached = JSON.stringify({ schemaVersion: 1, revisions: accountHistory() });
  await openDevice(page, { cache: cached, held: true });
  await moduleReady(page);
  await openSettings(page);
  await expect(settingsPanel(page)).toContainText('Current: 18:00');
  await expect(settingsPanel(page)).not.toContainText('Off.');
  await expect(settingsPanel(page)).not.toContainText('Checking your synced');
  expect(await page.evaluate(() => window.PlanAuthority.current().store)).toBe('operational');
});

test('a mobile whose cache is an OLDER boundary converges to the newer account revision when it reconnects, and never pushes the old one over it', async ({ page }) => {
  const anchor = legacyBoundaryRevision(TZ);
  const older = proposeBoundaryRevision([anchor], { id: 'old-20-00', boundaryTime: '20:00', timezone: TZ }, Date.parse('2026-09-10T08:00:00+08:00')).revision;
  const newer = proposeBoundaryRevision([anchor, older], { id: 'pc-18-00', boundaryTime: '18:00', timezone: TZ }, T_0800).revision;
  const cloud = { [anchor.id]: anchor, [older.id]: older, [newer.id]: newer };
  const staleCache = JSON.stringify({ schemaVersion: 1, revisions: { [anchor.id]: anchor, [older.id]: older } });

  await openDevice(page, { cache: staleCache, remote: cloud, held: true });
  await moduleReady(page);
  await openSettings(page);
  await expect(settingsPanel(page)).toContainText('Current: 20:00'); // the cache, until the account answers

  await page.evaluate(p => window.__fbTest.release(p), REVISIONS_PATH);
  await expect(settingsPanel(page)).toContainText('Current: 18:00');
  // The cloud history is untouched by the stale device.
  expect(await page.evaluate(p => window.__fbTest.get(p), REVISIONS_PATH)).toEqual(cloud);
});
