// Personal Day — the deployed WEB runtime on a phone-sized browser.
//
// A real phone kept showing "Off" (web/PWA, not the Capacitor app) after the cross-device sync fix was
// deployed, while the desktop was on. Against the DEPLOYED build with a stubbed Firebase, clean loads on
// desktop and every mobile emulation converged correctly, so the divergence was not viewport / user agent /
// bootstrap order. Two real defects were reproduced instead, and are pinned here in the real app:
//
//   1. Mixed module generations: entry scripts were versioned but the modules they import were bare URLs
//      cached independently — a stale bare module beside a fresh one gave a permanent Off, or a link error
//      that stopped PlanAuthority loading at all. index.html now pins the group to one release via an
//      import map. The stale-bare test below FAILS if that map is removed (see the control test).
//   2. Unknown rendered as Off: an unappliable remote history or a cancelled listener looked identical to
//      an account that never enabled the boundary.
//
// Nothing is faked except Firebase (an in-memory stub that also replaces the SDK request, so nothing can
// reach production) and the clock. No real project, no network, no production data.

import { test, expect, devices } from '@playwright/test';
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
const UID = 'web-runtime-user';
const REVISIONS_PATH = `rooms/uid_${UID}/dayBoundaryRevisions`;
const T_0800 = Date.parse('2026-09-16T08:00:00+08:00');
const T_2100 = Date.parse('2026-09-16T21:00:00+08:00');

/** The release token every group module must be requested with. */
let RELEASE = '';
const GROUP_FILES = ['personal-day-boundary-model', 'personal-day-boundary-repository', 'personal-day-boundary-sync', 'personal-day-boundary-live', 'personal-day-boundary-recovery', 'operational-plan-model', 'operational-plan-repository', 'operational-plan-sync', 'plan-authority'];

function accountHistory() {
  const anchor = legacyBoundaryRevision(TZ);
  const { revision } = proposeBoundaryRevision([anchor], { id: 'pc-18-00', boundaryTime: '18:00', timezone: TZ }, T_0800);
  return { [anchor.id]: anchor, [revision.id]: revision };
}

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const cfg = window.__fbSeed || {};
  const log = { transactions: [], listeners: [] };
  const tree = {};
  const get = p => p.split('/').filter(Boolean).reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), tree);
  const put = (p, v) => { const s = p.split('/').filter(Boolean); let n = tree; for (let i = 0; i < s.length - 1; i++) { if (typeof n[s[i]] !== 'object' || n[s[i]] === null) n[s[i]] = {}; n = n[s[i]]; } n[s[s.length - 1]] = v; };
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const snap = v => ({ val: () => clone(v), ref: { remove: () => Promise.resolve() } });
  const makeRef = path => ({
    path, key: path.split('/').pop(),
    child(c) { return makeRef(path + '/' + c); },
    on(ev, cb, errCb) {
      if (ev !== 'value') return cb;
      log.listeners.push(path);
      if ((cfg.failPaths || []).includes(path)) { setTimeout(() => errCb && errCb({ code: 'PERMISSION_DENIED' }), 0); return cb; }
      setTimeout(() => cb(snap(path === '.info/connected' ? false : get(path))), 0);
      return cb;
    },
    off() {}, once() { return Promise.resolve(snap(get(path))); }, update() { return Promise.resolve(); },
    set(v) { put(path, v); return Promise.resolve(); }, remove() { return Promise.resolve(); },
    transaction(fn) { log.transactions.push(path); const cur = get(path); const next = fn(clone(cur)); if (next === undefined) return Promise.resolve({ committed: false, snapshot: snap(cur) }); put(path, next); return Promise.resolve({ committed: true, snapshot: snap(next) }); },
    push(v) { const r = makeRef(path + '/pushed'); r.key = 'pushed'; return r; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; },
  });
  if (cfg.remote) put(cfg.path, cfg.remote);
  window.__fbTest = { log, get: p => clone(get(p)) };
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: '${UID}', displayName: 'Web Runtime', email: 'wr@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function () {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(c) { const a = { config: c, options: { projectId: 'stub-project', databaseURL: 'https://stub' } }; this.apps.push(a); return a; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
})();`;

test.beforeAll(async () => {
  const html = await fs.readFile(path.join(APP_ROOT, 'index.html'), 'utf8');
  RELEASE = /<meta name="pdb-release" content="([^"]+)">/.exec(html)[1];
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

// A phone-sized, touch, mobile-UA browser for everything in this file.
test.use({ ...devices['Pixel 7'] });

async function openDevice(page, { remote = null, failPaths = [], legacyCache = null, url = appUrl } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, remote, failPaths, legacyCache, path }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
    if (localStorage.getItem('wr-seeded') !== '1') {
      localStorage.clear(); sessionStorage.clear();
      localStorage.setItem('wr-seeded', '1');
      localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
      localStorage.setItem('ta3-tz:uid_web-runtime-user', timezone);
      localStorage.setItem('ta3-device-id', 'device-web-runtime');
      localStorage.setItem('ta3-settings:uid_web-runtime-user', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
      localStorage.setItem('ta3-entries:uid_web-runtime-user', '[]'); localStorage.setItem('ta3-plans:uid_web-runtime-user', '{}'); localStorage.setItem('ta3-reviews', '{}');
      localStorage.setItem('ta3-focus-redemptions', '[]');
      localStorage.setItem('ta3-daily-routines-v1', JSON.stringify({ schemaVersion: 1, timezone, routines: [], manual: {}, links: {}, focus: {}, skips: {} }));
      if (legacyCache) localStorage.setItem('ta3-day-boundary-revisions-v1', legacyCache);
    }
    window.__fbSeed = { remote, failPaths, path };
  }, { timezone: TZ, now: T_2100, remote, failPaths, legacyCache, path: REVISIONS_PATH });
  await page.goto(url, { waitUntil: 'load' });
}

const settingsPanel = page => page.locator('#personal-day-boundary-settings');
const openSettings = page => page.evaluate(() => showView('settings'));
const moduleReady = page => page.waitForFunction(() => typeof window.PersonalDayBoundaryLive === 'object' && typeof window.PlanAuthority === 'object' && typeof window.PersonalDayBoundaryRecovery === 'object' && typeof window.renderPersonalDayBoundarySettings === 'function');

test('MOBILE web: a fresh device converges on the account\'s 18:00 (viewport / UA / touch do not change bootstrap)', async ({ page }) => {
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  await openDevice(page, { remote: accountHistory() });
  await moduleReady(page);
  await openSettings(page);
  await expect(settingsPanel(page)).toContainText('Current: 18:00');
  expect(await page.evaluate(() => window.PlanAuthority.enabled())).toBe(true);
  expect(await page.evaluate(() => window.PersonalDayBoundarySync.syncState())).toBe('synced');
});

test('ONE release: every group module is requested exactly once, always with the release token, never as a bare URL', async ({ page }) => {
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    const name = url.pathname.split('/').pop().replace(/\.js$/, '');
    if (GROUP_FILES.includes(name)) requests.push({ name, search: url.search });
  });
  await openDevice(page, { remote: accountHistory() });
  await moduleReady(page);
  for (const name of GROUP_FILES) {
    const forFile = requests.filter(r => r.name === name);
    expect(forFile.length, `${name} requested ${forFile.length}x: ${JSON.stringify(forFile)}`).toBe(1);
    expect(forFile[0].search, `${name} must carry the release token`).toBe(`?v=${RELEASE}`);
  }
});

/** A bare group-module URL answering with deliberately incompatible "stale generation" code: exactly what a
 *  device holding an old cached copy of a bare import would run. */
async function staleBareModules(page) {
  const hits = [];
  await page.route(url => {
    const name = url.pathname.split('/').pop().replace(/\.js$/, '');
    return GROUP_FILES.includes(name) && url.search === '';
  }, route => {
    hits.push(new URL(route.request().url()).pathname);
    route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const STALE_GENERATION = true;' });
  });
  return hits;
}

test('REGRESSION (mixed generations): stale bare copies of the group cannot run beside the fresh release — the app still converges and PlanAuthority loads', async ({ page }) => {
  const hits = await staleBareModules(page);
  await openDevice(page, { remote: accountHistory() });
  await moduleReady(page);
  await openSettings(page);
  await expect(settingsPanel(page)).toContainText('Current: 18:00');
  expect(hits, 'the app never asked for a bare (unversioned) group module').toEqual([]);
});

test('CONTROL: without the import map the same stale bare modules DO break the runtime (so the regression above has teeth)', async ({ page }) => {
  await staleBareModules(page);
  await page.route(appUrl, async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace(/<script type="importmap">[\s\S]*?<\/script>/, '');
    await route.fulfill({ response, body: html });
  });
  const linkErrors = [];
  page.on('pageerror', error => linkErrors.push(error.message));
  await openDevice(page, { remote: accountHistory() });
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => typeof window.PlanAuthority)).toBe('undefined'); // the graph died on the stale bare module
  expect(linkErrors.some(message => /does not provide an export/.test(message))).toBe(true);
});

test('an account whose history cannot be applied is NOT shown as Off, and Save is blocked', async ({ page }) => {
  const { 'pc-18-00': custom } = accountHistory();
  await openDevice(page, { remote: { 'pc-18-00': custom } }); // a custom revision with no anchor: unmergeable
  await moduleReady(page);
  await openSettings(page);
  await expect(settingsPanel(page).locator('[data-pdb-state="unapplied"]')).toBeVisible();
  await expect(settingsPanel(page)).not.toContainText('Off. Your day currently starts at midnight');
  await expect(settingsPanel(page).getByRole('button', { name: /personal day/i })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('ta3-day-boundary-revisions-v1:uid_web-runtime-user'))).toBeNull();
});

test('a cancelled room listener says it could not load — not Off, not "Checking" forever', async ({ page }) => {
  await openDevice(page, { remote: accountHistory(), failPaths: [REVISIONS_PATH] });
  await moduleReady(page);
  await openSettings(page);
  await expect(settingsPanel(page).locator('[data-pdb-state="load-failed"]')).toBeVisible();
  await expect(settingsPanel(page)).not.toContainText('Off. Your day currently starts at midnight');
  await expect(settingsPanel(page)).not.toContainText('Checking your synced');
  await expect(settingsPanel(page).getByRole('button', { name: /personal day/i })).toBeDisabled();
});

test('the unowned legacy cache alone never turns the boundary on for the account, and is reported by the diagnostics view', async ({ page }) => {
  const legacy = JSON.stringify({ schemaVersion: 1, revisions: accountHistory() });
  await openDevice(page, { remote: null, legacyCache: legacy, url: `${appUrl}?pdbdiag=1` });
  await moduleReady(page);
  await openSettings(page);
  await expect(settingsPanel(page)).toContainText('Off. Your day currently starts at midnight');
  // Legacy Recovery V2: an authoritatively empty account + a device with a complete legacy cache is
  // a technically compatible candidate — but it is only ever OFFERED, with the ownership disclaimer,
  // never auto-adopted (Settings still plainly says "Off." above).
  await expect(settingsPanel(page).locator('[data-pdb-recovery="offer"]')).toContainText('Old personal day setting found on this device');
  await expect(settingsPanel(page).locator('[data-pdb-recovery="offer"]')).toContainText('ChronaSense cannot verify that it belongs to the account you are currently signed in to');
  const diag = page.locator('#pdb-diagnostics');
  await expect(diag).toContainText('old unowned cache revisions: 2', { timeout: 8000 });
  await expect(diag).toContainText('this account cache revisions: none');
  await expect(diag).toContainText('remote compatibility: true');
});

test('diagnostics view (?pdbdiag=1): one screenshot shows the whole chain, with no identity, token or revision content', async ({ page }) => {
  await openDevice(page, { remote: accountHistory(), url: `${appUrl}?pdbdiag=1` });
  await moduleReady(page);
  const diag = page.locator('#pdb-diagnostics');
  await expect(diag).toContainText('sync state: synced', { timeout: 8000 });
  const text = await diag.innerText();
  for (const expected of ['release match: yes', 'import map supported: true', 'mobile UA: yes', 'auth present: yes', 'room identity known: yes',
    'room ref matches identity: true', 'listener bound: true', 'first snapshot received: true', 'remote revisions received: 2',
    'remote unapplied: false', 'cache owner matches room: true', 'this account cache revisions: 2', 'effective boundary: 18:00', 'plan authority enabled: true']) {
    expect(text, expected).toContain(expected);
  }
  expect(text).toMatch(/account fingerprint: [0-9a-f]{8}/);
  expect(text).toMatch(/firebase project fingerprint: [0-9a-f]{8}/);
  expect(text).toContain(`v=${RELEASE}`); // the module list shows the versioned URLs actually loaded
  expect(text).not.toContain('UNVERSIONED');
  for (const secret of [UID, 'uid_', 'wr@example.test', 'Web Runtime', 'pc-18-00', TZ]) expect(text, `must not show ${secret}`).not.toContain(secret);
});

test('the diagnostics view is inert without the query parameter', async ({ page }) => {
  await openDevice(page, { remote: accountHistory() });
  await moduleReady(page);
  await page.waitForTimeout(2200);
  await expect(page.locator('#pdb-diagnostics')).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.showPersonalDayDiagnostics)).toBe('undefined');
});
