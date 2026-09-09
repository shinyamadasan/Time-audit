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
  window.__firebasePlanWriteCount = 0;
  window.__emitFirebaseValue = (refPath, value) => (listeners.get(refPath) || []).forEach(cb => cb(snapshot(value)));
  const makeRef = refPath => {
    const countPlanWrite = () => { if (refPath.includes('/plans')) window.__firebasePlanWriteCount++; };
    return ({
    path: refPath, child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) { if (eventName === 'value') { const rows = listeners.get(refPath) || []; rows.push(cb); listeners.set(refPath, rows); setTimeout(() => cb(snapshot(null)), 0); } return cb; },
    off() {}, once() { return Promise.resolve(snapshot(null)); }, update() { countPlanWrite(); return Promise.resolve(); },
    set() { countPlanWrite(); return Promise.resolve(); }, remove() { countPlanWrite(); return Promise.resolve(); },
    transaction(updateFn) { countPlanWrite(); const value = updateFn(null); return Promise.resolve({ committed: true, snapshot: snapshot(value) }); },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
    });
  };
  const auth = () => ({ onAuthStateChanged(cb) { window.__authChanged = cb; setTimeout(() => cb(window.__signedOut ? null : { uid: 'plan-user', displayName: 'Plan User', email: 'plan@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { window.__authChanged(null); return Promise.resolve(); } });
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


async function openApp(page, { firstVisit = false, signedOut = false } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ firstVisit, signedOut }) => {
    window.__signedOut = signedOut;
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    if (localStorage.getItem('install-test-seeded')) return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('install-test-seeded', '1');
    if (!firstVisit) localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone: 'Etc/UTC', sleepSetupDone: true, intervalMin: 30, presets: [], templates: [] }));
  }, { firstVisit, signedOut });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof enterFocusMode === 'function' && typeof window.__authChanged === 'function');
  if (!signedOut) await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function eligible(page) {
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    window.__installPrompts = 0;
    event.prompt = () => { window.__installPrompts++; };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.__installEvent = event;
    window.dispatchEvent(event);
  });
}

async function suppressed(page) {
  await expect(page.locator('#install-banner')).toBeHidden();
  expect(await page.locator('#install-banner').evaluate(el => el.getClientRects().length)).toBe(0);
  expect(await page.evaluate(() => deferredPrompt === window.__installEvent)).toBe(true);
}

test('beforeinstallprompt during Focus is retained without showing a banner; returns after exit', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => enterFocusMode({ task: 'Client build', autoStart: true }));
  await eligible(page);
  await suppressed(page);
  await expect(page.locator('#focus-overlay')).toHaveClass(/open/);
  await page.evaluate(() => confirmExitFocus());
  await expect(page.locator('#install-banner')).toBeVisible();
  await page.locator('#install-btn').click();
  expect(await page.evaluate(() => window.__installPrompts)).toBe(1);
  await expect(page.locator('#install-banner')).toBeHidden();
});

test('already-visible install hides when Focus starts and stays hidden across real reload recovery', async ({ page }) => {
  await openApp(page);
  await eligible(page);
  await expect(page.locator('#install-banner')).toBeVisible();
  await page.evaluate(() => enterFocusMode({ task: 'Reload work', autoStart: true }));
  await suppressed(page);
  const startedAt = await page.evaluate(() => pomodoroPhaseStartedAt);
  await page.reload();
  await page.waitForFunction(() => typeof pomodoroPhase !== 'undefined' && pomodoroPhase === 'work');
  await eligible(page);
  await suppressed(page);
  expect(await page.evaluate(() => pomodoroPhaseStartedAt)).toBe(startedAt);
  await page.evaluate(() => confirmExitFocus());
  await expect(page.locator('#install-banner')).toBeVisible();
});

test('already-visible install is suppressed by the actual Focus restore path', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    enterFocusMode({ task: 'Restored work', autoStart: true });
    window.__savedFocus = localStorage.getItem('ta3-focus-timer');
    confirmExitFocus();
  });
  await eligible(page);
  await expect(page.locator('#install-banner')).toBeVisible();
  await page.evaluate(() => { localStorage.setItem('ta3-focus-timer', window.__savedFocus); restoreFocusSession(); });
  await suppressed(page);
  expect(await page.evaluate(() => pomodoroPhase)).toBe('work');
});

test('timer crash recovery defers eligibility until its actual decision completes', async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await _startTimer('Recover admin');
    localStorage.setItem('ta3-heartbeat-ts', String(Date.now() - 3 * 60000));
  });
  // Emulate a crashed process: the normal unload handler must not refresh the heartbeat.
  await page.addInitScript(() => {
    localStorage.setItem('ta3-heartbeat-ts', String(Date.now() - 3 * 60000));
    document.addEventListener('DOMContentLoaded', () => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      event.prompt = () => {}; event.userChoice = Promise.resolve({ outcome: 'dismissed' });
      window.__installEvent = event; window.dispatchEvent(event);
      window.__installRectsAtRecovery = document.getElementById('install-banner').getClientRects().length;
    });
  });
  await page.reload();
  await expect(page.locator('#recovery-overlay')).toBeVisible();
  expect(await page.evaluate(() => window.__installRectsAtRecovery)).toBe(0);
  await suppressed(page);
  await page.locator('#recovery-overlay').getByRole('button', { name: /Yes, I closed it intentionally/ }).click();
  await expect(page.locator('#install-banner')).toBeVisible();
});

test('visible install hides when recovery opens without consuming eligibility', async ({ page }) => {
  await openApp(page);
  await eligible(page);
  await expect(page.locator('#install-banner')).toBeVisible();
  await page.evaluate(() => {
    window._timerRecoveryState = { shutdownTs: Date.now() - 180000, task: 'Recovered task', taskStartTime: Date.now() - 240000, timerExpired: false };
    showRecoveryModal();
  });
  await suppressed(page);
  await page.locator('#recovery-overlay').getByRole('button', { name: /Yes, I closed it intentionally/ }).click();
  await expect(page.locator('#install-banner')).toBeVisible();
});

test('first-visit authentication and onboarding never compete with install', async ({ page }) => {
  await openApp(page, { firstVisit: true, signedOut: true });
  await eligible(page);
  await expect(page.locator('#signin-overlay')).toBeVisible();
  await suppressed(page);
  await page.evaluate(() => window.__authChanged({ uid: 'plan-user', displayName: 'Plan User', email: 'plan@example.test', photoURL: '' }));
  await expect(page.locator('#signin-overlay')).toBeHidden();
  await expect(page.locator('#ob-overlay')).toHaveClass(/open/);
  await suppressed(page);
  await page.locator('#ob-skip-btn').click();
  await expect(page.locator('#install-banner')).toBeVisible();
});

test('visible install hides on sign-out and returns only after sign-in', async ({ page }) => {
  await openApp(page);
  await eligible(page);
  await expect(page.locator('#install-banner')).toBeVisible();
  await page.evaluate(() => firebase.auth().signOut());
  await expect(page.locator('#signin-overlay')).toBeVisible();
  await suppressed(page);
  await page.evaluate(() => window.__authChanged({ uid: 'plan-user', displayName: 'Plan User', email: 'plan@example.test', photoURL: '' }));
  await expect(page.locator('#install-banner')).toBeVisible();
});

test('ordinary tracking suppresses an existing banner; dismissal stays dismissed', async ({ page }) => {
  await openApp(page);
  await eligible(page);
  await expect(page.locator('#install-banner')).toBeVisible();
  await page.evaluate(() => _startTimer('Admin'));
  await suppressed(page);
  await page.evaluate(() => resetTimer());
  await expect(page.locator('#install-banner')).toBeVisible();
  await page.evaluate(() => dismissInstall());
  await page.evaluate(() => enterFocusMode({ task: 'More work', autoStart: true }));
  await page.evaluate(() => confirmExitFocus());
  await expect(page.locator('#install-banner')).toBeHidden();
});

test.describe('iOS installation help', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  test('delayed iOS help waits for Focus to end', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => enterFocusMode({ task: 'Mobile work', autoStart: true }));
    await expect.poll(() => page.evaluate(() => pendingInstallPlatform)).toBe('ios');
    await expect(page.locator('#install-banner')).toBeHidden();
    await page.evaluate(() => confirmExitFocus());
    await expect(page.locator('#install-banner')).toBeVisible();
    await expect(page.locator('#install-sub')).toContainText('Add to Home Screen');
    await expect(page.locator('#install-btn')).toBeHidden();
  });
});
