// Personal Day Legacy Recovery V2 — the provenance-aware confirmation UI, end to end, in the real
// app. Structural compatibility is never treated as ownership proof; the explicit owner attestation
// checkbox is the only provenance gate, and it is re-validated live against the current room and the
// current compatible set every time it matters.
//
// Nothing is faked except Firebase (an in-memory stub) and the clock. No real project, no network,
// no production data.

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
const UID = 'legacy-recovery-user';
const REVISIONS_PATH = `rooms/uid_${UID}/dayBoundaryRevisions`;
const T_0800 = Date.parse('2026-09-14T08:00:00+08:00');
const T_2100 = Date.parse('2026-09-16T21:00:00+08:00');

const anchor = legacyBoundaryRevision(TZ);
const custom = proposeBoundaryRevision([anchor], { id: 'device-custom', boundaryTime: '18:00', timezone: TZ }, T_0800).revision;
const legacyComplete = () => JSON.stringify({ schemaVersion: 1, revisions: { [anchor.id]: anchor, [custom.id]: custom } });

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const cfg = window.__fbSeed || {};
  const tree = {};
  const get = p => p.split('/').filter(Boolean).reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), tree);
  const put = (p, v) => { const s = p.split('/').filter(Boolean); let n = tree; for (let i = 0; i < s.length - 1; i++) { if (typeof n[s[i]] !== 'object' || n[s[i]] === null) n[s[i]] = {}; n = n[s[i]]; } n[s[s.length - 1]] = v; };
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const snap = v => ({ val: () => clone(v), ref: { remove: () => Promise.resolve() } });
  const listeners = new Map();
  const fire = p => (listeners.get(p) || []).forEach(cb => cb(snap(get(p))));
  const makeRef = path => ({
    path, key: path.split('/').pop(),
    child(c) { return makeRef(path + '/' + c); },
    on(ev, cb) {
      if (ev !== 'value') return cb;
      if (!listeners.has(path)) listeners.set(path, new Set());
      listeners.get(path).add(cb);
      setTimeout(() => cb(snap(path === '.info/connected' ? false : get(path))), 0);
      return cb;
    },
    off() { listeners.delete(path); },
    once() { return Promise.resolve(snap(get(path))); },
    update() { return Promise.resolve(); },
    set(v) { put(path, v); fire(path); return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    transaction(fn) {
      const cur = get(path);
      const next = fn(clone(cur));
      if (next === undefined) return Promise.resolve({ committed: false, snapshot: snap(cur) });
      put(path, next);
      fire(path);
      return Promise.resolve({ committed: true, snapshot: snap(next) });
    },
    push(v) { const r = makeRef(path + '/pushed'); r.key = 'pushed'; return r; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; },
  });
  if (cfg.remote) put(cfg.path, cfg.remote);
  window.__fbTest = { get: p => clone(get(p)) };
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: '${UID}', displayName: 'Legacy Recovery', email: 'lr@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function () {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(c) { const a = { config: c, options: { projectId: 'stub-project', databaseURL: 'https://stub' } }; this.apps.push(a); return a; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
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

async function openDevice(page, { remote = null, legacyCache = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, remote, legacyCache, path: revisionsPath }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', timezone);
    localStorage.setItem('ta3-device-id', 'device-legacy-recovery');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', '[]'); localStorage.setItem('ta3-plans', '{}'); localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify({ schemaVersion: 1, timezone, routines: [], manual: {}, links: {}, focus: {}, skips: {} }));
    if (legacyCache) localStorage.setItem('ta3-day-boundary-revisions-v1', legacyCache);
    window.__fbSeed = { remote, path: revisionsPath };
  }, { timezone: TZ, now: T_2100, remote, legacyCache, path: REVISIONS_PATH });
  await page.goto(appUrl, { waitUntil: 'load' });
}

const settingsPanel = page => page.locator('#personal-day-boundary-settings');
const openSettings = page => page.evaluate(() => showView('settings'));
const moduleReady = page => page.waitForFunction(() => typeof window.PersonalDayBoundaryLive === 'object' && typeof window.PersonalDayBoundaryRecovery === 'object' && typeof window.renderPersonalDayBoundarySettings === 'function');
const offerCard = page => settingsPanel(page).locator('[data-pdb-recovery="offer"]');
const attestCheckbox = page => offerCard(page).locator('[data-pdb-attest]');
const recoverButton = page => offerCard(page).getByRole('button', { name: /Recover this setting/i });

test('the offer never claims ownership, the button stays disabled until the owner attests, and only then does recovery proceed', async ({ page }) => {
  await openDevice(page, { remote: { [anchor.id]: anchor }, legacyCache: legacyComplete() });
  await moduleReady(page);
  await openSettings(page);

  await expect(settingsPanel(page)).toContainText('Off. Your day currently starts at midnight');
  await expect(offerCard(page)).toContainText('Old personal day setting found on this device');
  await expect(offerCard(page)).toContainText('18:00');
  await expect(offerCard(page)).toContainText('Asia/Manila');
  await expect(offerCard(page)).toContainText('ChronaSense cannot verify that it belongs to the account you are currently signed in to');
  for (const forbidden of ['Previous personal day setting found', 'belongs to you', 'your old setting', 'verified', 'proven safe']) {
    await expect(offerCard(page)).not.toContainText(forbidden, { ignoreCase: true });
  }

  await expect(recoverButton(page)).toBeDisabled();
  await attestCheckbox(page).check();
  await expect(recoverButton(page)).toBeEnabled();

  await recoverButton(page).click();
  await expect(settingsPanel(page)).toContainText('Recovered. The historical personal day revision(s) have been added to your account.');
  await expect(settingsPanel(page)).toContainText('Current: 18:00');
  await expect(offerCard(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.PlanAuthority.enabled())).toBe(true);

  const remoteAfter = await page.evaluate(p => window.__fbTest.get(p), REVISIONS_PATH);
  expect(remoteAfter[anchor.id]).toBeTruthy();
  expect(Object.keys(remoteAfter).sort()).toEqual([anchor.id, custom.id].sort());
});

test('unchecking the attestation disables the button again, with zero writes', async ({ page }) => {
  await openDevice(page, { remote: { [anchor.id]: anchor }, legacyCache: legacyComplete() });
  await moduleReady(page);
  await openSettings(page);

  await attestCheckbox(page).check();
  await expect(recoverButton(page)).toBeEnabled();
  await attestCheckbox(page).uncheck();
  await expect(recoverButton(page)).toBeDisabled();

  const remote = await page.evaluate(p => window.__fbTest.get(p), REVISIONS_PATH);
  expect(Object.keys(remote)).toEqual([anchor.id]);
});

test('a reload requires attesting again — the checkbox is never remembered', async ({ page }) => {
  await openDevice(page, { remote: { [anchor.id]: anchor }, legacyCache: legacyComplete() });
  await moduleReady(page);
  await openSettings(page);
  await attestCheckbox(page).check();
  await expect(recoverButton(page)).toBeEnabled();

  await page.reload();
  await moduleReady(page);
  await openSettings(page);
  await expect(attestCheckbox(page)).not.toBeChecked();
  await expect(recoverButton(page)).toBeDisabled();
});

test('an account that already has its own configured boundary is never offered recovery, even with a legacy cache present', async ({ page }) => {
  const ownRevision = proposeBoundaryRevision([anchor], { id: 'account-own', boundaryTime: '20:00', timezone: TZ }, T_0800).revision;
  await openDevice(page, { remote: { [anchor.id]: anchor, [ownRevision.id]: ownRevision }, legacyCache: legacyComplete() });
  await moduleReady(page);
  await openSettings(page);
  await expect(settingsPanel(page)).toContainText('Current: 20:00');
  await expect(offerCard(page)).toHaveCount(0);
});

test('no legacy cache on this device at all -> no offer, ordinary "Off"', async ({ page }) => {
  await openDevice(page, { remote: { [anchor.id]: anchor } });
  await moduleReady(page);
  await openSettings(page);
  await expect(settingsPanel(page)).toContainText('Off. Your day currently starts at midnight');
  await expect(offerCard(page)).toHaveCount(0);
});

test('diagnostics reports compatibility and attestation-required as facts, never a claim of verified ownership', async ({ page }) => {
  await openDevice(page, { remote: { [anchor.id]: anchor }, legacyCache: legacyComplete() });
  await page.goto(`${appUrl}?pdbdiag=1`, { waitUntil: 'load' });
  await moduleReady(page);
  const diag = page.locator('#pdb-diagnostics');
  await expect(diag).toContainText('legacy history present: true', { timeout: 8000 });
  await expect(diag).toContainText('legacy history validates: true');
  await expect(diag).toContainText('remote compatibility: true');
  await expect(diag).toContainText('attestation required: yes');
  const text = await diag.innerText();
  expect(text.toLowerCase()).not.toContain('ownership verified');
  expect(text.toLowerCase()).not.toContain('safe owner match');
});
