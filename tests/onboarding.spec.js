import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let appServer;
let appUrl;

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const listeners = new Map();
  window.__emitFirebaseValue = (refPath, value) => (listeners.get(refPath) || []).forEach(cb => cb(snapshot(value)));
  const makeRef = refPath => ({
    path: refPath, child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) { if (eventName === 'value') { const rows = listeners.get(refPath) || []; rows.push(cb); listeners.set(refPath, rows); setTimeout(() => cb(snapshot(null)), 0); } return cb; },
    off() {}, once() { return Promise.resolve(snapshot(null)); }, update() { return Promise.resolve(); },
    set() { return Promise.resolve(); }, remove() { return Promise.resolve(); },
    transaction(updateFn) { const value = updateFn(null); return Promise.resolve({ committed: true, snapshot: snapshot(value) }); },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  const auth = () => ({ onAuthStateChanged(cb) { window.__authChanged = cb; setTimeout(() => cb({ uid: 'ob-user', displayName: 'OB User', email: 'ob@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(config) { const app = { config }; this.apps.push(app); return app; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
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

// Fresh first-run: no ta3-onboarded flag, signed in, sleep setup already done so
// nothing else competes for the first screen.
async function openFirstRun(page) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    sessionStorage.setItem('ta3-session-started', '1');
    if (localStorage.getItem('ob-test-seeded')) return; // survive page.reload()
    localStorage.clear();
    localStorage.setItem('ob-test-seeded', '1');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone: 'Etc/UTC', sleepSetupDone: true, intervalMin: 30, presets: [], templates: [] }));
  });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof openOnboarding === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

const overlay = page => page.locator('#ob-overlay');
const activeStep = page => page.locator('#ob-overlay .ob-step.active');

test('first run opens onboarding on the Plan → Do → Review welcome, not a 30-minute-ping pitch', async ({ page }) => {
  await openFirstRun(page);
  await expect(overlay(page)).toHaveClass(/open/);
  const welcome = activeStep(page);
  await expect(welcome).toContainText('Welcome to ChronaSense');
  await expect(welcome).toContainText('Plan a little. Do the work. Review reality. Adjust tomorrow.');

  // The obsolete mental model must be gone from the whole onboarding sheet.
  const sheetText = (await overlay(page).innerText()).toLowerCase();
  expect(sheetText).not.toContain('every 30 minutes');
  expect(sheetText).not.toContain('every half hour');
  expect(sheetText).not.toContain('what were you just doing');
  expect(sheetText).not.toContain('pings you');
  expect(sheetText).not.toContain('account for');
  expect(sheetText).not.toContain('fill in gaps');
  expect(sheetText).not.toContain('9 categories');
});

test('the four steps teach Plan, Today/Up next, Start vs Focus, and Review', async ({ page }) => {
  await openFirstRun(page);
  await expect(overlay(page)).toHaveClass(/open/);

  await expect(activeStep(page)).toContainText('Welcome to ChronaSense');
  await page.locator('#ob-next-btn').click();

  const plan = activeStep(page);
  await expect(plan).toContainText('Prepare tomorrow');
  await expect(plan).toContainText('open day');
  await expect(plan).toContainText('routines');
  await page.locator('#ob-next-btn').click();

  const doStep = activeStep(page);
  await expect(doStep).toContainText('Up next');
  await expect(doStep).toContainText('Start');
  await expect(doStep).toContainText('Focus');
  await expect(doStep).toContainText(/no need to time every/i);
  await page.locator('#ob-next-btn').click();

  const review = activeStep(page);
  await expect(review).toContainText('Review');
  await expect(review).toContainText('Unknown time is fine');
  await expect(review).toContainText(/nothing piles up/i);

  // Last step: primary button becomes the finish CTA, skip is gone.
  await expect(page.locator('#ob-next-btn')).toHaveText("Let's go");
  await expect(page.locator('#ob-skip-btn')).toBeHidden();
});

test('exactly four steps and four progress dots — no more, no fewer', async ({ page }) => {
  await openFirstRun(page);
  await expect(page.locator('#ob-overlay .ob-step')).toHaveCount(4);
  await expect(page.locator('#ob-overlay .ob-dot')).toHaveCount(4);
  expect(await page.evaluate(() => OB_STEPS)).toBe(4);
});

test('onboarding asks for no input and no mandatory decision', async ({ page }) => {
  await openFirstRun(page);
  // No form fields of any kind inside the sheet.
  await expect(page.locator('#ob-overlay input, #ob-overlay select, #ob-overlay textarea')).toHaveCount(0);
  // Only two controls: Skip and Next.
  await expect(page.locator('#ob-overlay button')).toHaveCount(2);
});

test('clicking through completes onboarding, persists the flag, and lands on a usable Today', async ({ page }) => {
  await openFirstRun(page);
  for (let i = 0; i < 4; i++) await page.locator('#ob-next-btn').click();

  await expect(overlay(page)).not.toHaveClass(/open/);
  expect(await page.evaluate(() => localStorage.getItem('ta3-onboarded'))).toBe('1');

  // Today is the landing surface with an obvious next action available.
  await expect(page.locator('#view-today')).toHaveClass(/active/);
  await expect(page.locator('#up-next')).toBeVisible();

  // No-plan path is usable straight away — free-text Start, nothing forced.
  await expect(page.locator('#hero-task-input')).toBeVisible();
  await expect(page.locator('#hero-idle').getByRole('button', { name: 'Start', exact: true })).toBeVisible();
});

test('Skip also completes and persists', async ({ page }) => {
  await openFirstRun(page);
  await page.locator('#ob-skip-btn').click();
  await expect(overlay(page)).not.toHaveClass(/open/);
  expect(await page.evaluate(() => localStorage.getItem('ta3-onboarded'))).toBe('1');
});

test('onboarding does not reappear on reload once completed', async ({ page }) => {
  await openFirstRun(page);
  for (let i = 0; i < 4; i++) await page.locator('#ob-next-btn').click();
  await expect(overlay(page)).not.toHaveClass(/open/);

  await page.reload();
  await page.waitForFunction(() => typeof openOnboarding === 'function');
  await page.waitForTimeout(700); // longer than the 400ms first-run delay
  await expect(overlay(page)).not.toHaveClass(/open/);
});

test('replay from Settings reopens the guide at step one', async ({ page }) => {
  await openFirstRun(page);
  await page.locator('#ob-skip-btn').click();
  await expect(overlay(page)).not.toHaveClass(/open/);

  await page.evaluate(() => showView('settings'));
  await page.getByRole('button', { name: /How to use/ }).click();
  await expect(overlay(page)).toHaveClass(/open/);
  await expect(activeStep(page)).toContainText('Welcome to ChronaSense');
});
