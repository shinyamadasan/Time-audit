import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Phase 10 — lightweight browser smoke test for the Background Sync Settings wiring. The bridge
// module's actual enable/resume/disable/status logic is already exhaustively unit-tested against
// injectable fakes in life-ledger-sync-bridge.test.js (Node, no browser needed). This spec exists
// only to prove the DOM wiring (index.html -> life-ledger-sync-status-ui.js -> the real bridge
// singleton, real indexedDB, real feature detection) doesn't throw and renders truthfully in an
// actual browser, for both the supported and unsupported cases.

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';

test.beforeAll(async () => {
  appServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = path.resolve(APP_ROOT, `.${decodeURIComponent(pathname)}`);
      if (!filePath.startsWith(APP_ROOT)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      const contentType = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType });
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

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const makeRef = refPath => ({
    path: refPath,
    child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) { if (eventName === 'value') setTimeout(() => cb(snapshot(null)), 0); return cb; },
    off() {}, once() { return Promise.resolve(snapshot(null)); },
    update() { return Promise.resolve(); }, set() { return Promise.resolve(); }, remove() { return Promise.resolve(); },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  const auth = () => ({
    onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'u', displayName: 'U', email: 'u@example.test', photoURL: '' }), 0); return () => {}; },
    signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); }
  });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(config) { const app = { config }; this.apps.push(app); return app; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
})();
`;

function baseSettings() {
  return {
    hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [],
    timezone: 'UTC', activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00',
    sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: []
  };
}

async function openApp(page) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ settings }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', 'UTC');
    localStorage.setItem('ta3-settings', JSON.stringify(settings));
    localStorage.setItem('ta3-entries', '[]');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-plans', '{}');
    localStorage.setItem('ta3-reviews', '{}');
  }, { settings: baseSettings() });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function openSettings(page) {
  await page.locator('#nav-settings').click();
  await expect(page.locator('#view-settings')).toHaveClass(/active/);
}

test('Background Sync status renders "not available" when the browser lacks File System Access support, with no Enable button', async ({ page }) => {
  await page.addInitScript(() => { delete window.showDirectoryPicker; });
  await openApp(page);
  await openSettings(page);
  await expect(page.locator('#life-ledger-sync-status')).toHaveText(/not available/i);
  await expect(page.locator('#life-ledger-sync-enable-btn')).toBeHidden();
});

test('Background Sync status renders "off" with an Enable button when supported but not yet configured, and never claims synced', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  const status = page.locator('#life-ledger-sync-status');
  await expect(status).toBeVisible();
  const text = await status.textContent();
  expect(text || '').not.toMatch(/^Life Ledger synced/);
  const supported = await page.evaluate(() => typeof window.showDirectoryPicker === 'function' && typeof window.indexedDB === 'object');
  if (supported) {
    await expect(status).toHaveText(/off/i);
    await expect(page.locator('#life-ledger-sync-enable-btn')).toBeVisible();
    await expect(page.locator('#life-ledger-sync-enable-btn')).toHaveText('Enable Background Sync');
  }
});
