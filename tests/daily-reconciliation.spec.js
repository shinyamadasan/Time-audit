// Daily Reconciliation V1 — reconciling today's one-off priorities (completed vs unfinished,
// slipped-reason capture, optional carry-forward) as a section inside the existing Plan
// Tomorrow modal. Harness mirrors tests/plan-tomorrow-ui.spec.js.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';
const NOW = Date.parse('2026-09-08T18:00:00Z');
const TODAY = '2026-09-08';
const TARGET = '2026-09-09';
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const makeRef = refPath => ({
    path: refPath, child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) { if (eventName === 'value') setTimeout(() => cb(snapshot(null)), 0); return cb; },
    off() {}, once() { return Promise.resolve(snapshot(null)); }, update() { return Promise.resolve(); },
    set() { return Promise.resolve(); }, remove() { return Promise.resolve(); },
    transaction(updateFn) { const value = updateFn(null); return Promise.resolve({ committed: true, snapshot: snapshot(value) }); },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'plan-user', displayName: 'Plan User', email: 'plan@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(config) { const app = { config }; this.apps.push(app); return app; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
})();`;

const planItem = (id, task, extra = {}) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: NOW, ...extra });

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

async function openApp(page, { plans = {}, entries = [] } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ plans, entries, now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', 'Etc/UTC');
    localStorage.setItem('ta3-device-id', 'device-test');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone: 'Etc/UTC', hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', JSON.stringify(entries)); localStorage.setItem('ta3-focus-redemptions', '[]'); localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-plans', JSON.stringify(plans));
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify({ schemaVersion: 1, timezone: 'Etc/UTC', routines: [], manual: {}, links: {}, focus: {}, skips: {} }));
  }, { plans, entries, now: NOW });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof openPlanTomorrow === 'function' && typeof getPlanTomorrowAppContext === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
  await page.evaluate(() => openPlanTomorrow());
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
}

test('completed items show as read-only context; unfinished items get a reason box and carry control', async ({ page }) => {
  await openApp(page, {
    plans: { [TODAY]: { items: [
      planItem('done-1', 'Ship report', { done: true, doneAt: NOW }),
      planItem('open-1', 'Write follow-up')
    ] } }
  });
  const section = page.locator('.pt-reconcile');
  await expect(section).toBeVisible();
  await expect(section.locator('h3')).toContainText('1 unfinished');
  await expect(section.locator('h3')).toContainText('1 done');
  const done = section.locator('.pt-reconcile-done');
  await expect(done).toContainText('Ship report');
  await expect(done.locator('textarea')).toHaveCount(0);
  await expect(done.locator('button')).toHaveCount(0);
  const unfinished = section.locator('[data-pt-reconcile-item="open-1"]');
  await expect(unfinished.locator('.pt-reconcile-reason')).toBeVisible();
  await expect(unfinished.getByRole('button', { name: 'Carry to tomorrow' })).toBeVisible();
});

test('a deleted-after-prep item is excluded entirely and an all-resolved today hides the section', async ({ page }) => {
  await openApp(page, {
    plans: { [TODAY]: { items: [planItem('gone-1', 'Cancelled thing', { deleted: true, updatedAt: NOW })] } }
  });
  await expect(page.locator('.pt-reconcile')).toHaveCount(0);
});

test('tracked time without a done flag classifies as unfinished, not completed', async ({ page }) => {
  await openApp(page, {
    plans: { [TODAY]: { items: [planItem('wip-1', 'Write report')] } },
    entries: [{ id: 'e1', activity: 'Write report', planItemId: 'wip-1', tsStart: Date.parse('2026-09-08T10:00:00Z'), ts: Date.parse('2026-09-08T10:20:00Z') }]
  });
  const section = page.locator('.pt-reconcile');
  await expect(section.locator('[data-pt-reconcile-item="wip-1"]')).toBeVisible();
  await expect(section.locator('h3')).toContainText('1 unfinished · 0 done');
});

test('recording a reason persists on today\'s item without touching preparation or Planning Streak semantics', async ({ page }) => {
  await openApp(page, { plans: { [TODAY]: { items: [planItem('open-1', 'Write follow-up')] } } });
  const reason = page.locator('[data-pt-reconcile-item="open-1"] .pt-reconcile-reason');
  await reason.fill('Got pulled into an incident call');
  await reason.blur();
  const todayPlan = await page.evaluate(key => JSON.parse(localStorage.getItem('ta3-plans'))[key], TODAY);
  expect(todayPlan.items.find(i => i.id === 'open-1').reconciliationReason).toBe('Got pulled into an incident call');
  expect(todayPlan.preparation).toBeUndefined();
  // Reconciliation must never itself mark tomorrow "prepared".
  await expect(page.locator('#plan-tomorrow-readiness')).toContainText('not prepared');
});

test('carry forward adds a brand-new, independently identified tomorrow item and leaves today untouched', async ({ page }) => {
  await openApp(page, { plans: { [TODAY]: { items: [planItem('open-1', 'Write follow-up')] } } });
  await page.locator('[data-pt-reconcile-item="open-1"]').getByRole('button', { name: 'Carry to tomorrow' }).click();
  await expect(page.locator('[data-pt-reconcile-item="open-1"]').getByRole('button', { name: '✓ Carrying to tomorrow' })).toBeVisible();
  await expect(page.locator('.pt-oneoff .pt-oneoff-task', { hasText: 'Write follow-up' })).toHaveCount(1); // shows up in tomorrow's actual list too
  await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-plans')));
  const tomorrowItems = plans[TARGET].items.filter(i => !i.deleted);
  expect(tomorrowItems).toHaveLength(1);
  expect(tomorrowItems[0].task).toBe('Write follow-up');
  expect(tomorrowItems[0].id).not.toBe('open-1');
  expect(tomorrowItems[0].carriedFromId).toBe('open-1');
  const todayItem = plans[TODAY].items.find(i => i.id === 'open-1');
  expect(todayItem.done).toBe(false);
  expect(todayItem.deleted ?? false).toBe(false);
});

test('carrying twice does not duplicate: the second click un-carries via the existing tombstone pattern', async ({ page }) => {
  await openApp(page, { plans: { [TODAY]: { items: [planItem('open-1', 'Write follow-up')] } } });
  const carryButton = page.locator('[data-pt-reconcile-item="open-1"] [data-pt-action="carry"]');
  await carryButton.click();
  await expect(carryButton).toHaveText('✓ Carrying to tomorrow');
  await carryButton.click();
  await expect(carryButton).toHaveText('Carry to tomorrow');
  await expect(page.locator('.pt-oneoff')).toHaveCount(0); // nothing left in tomorrow's actual list
});

test('two priorities with identical titles remain independent after carry-forward', async ({ page }) => {
  await openApp(page, {
    plans: {
      [TODAY]: { items: [planItem('open-1', 'Write follow-up')] },
      [TARGET]: { items: [planItem('existing-1', 'Write follow-up')] }
    }
  });
  await page.locator('[data-pt-reconcile-item="open-1"]').getByRole('button', { name: 'Carry to tomorrow' }).click();
  await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
  const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-plans')));
  const tomorrowItems = plans[TARGET].items.filter(i => !i.deleted);
  expect(tomorrowItems.map(i => i.task)).toEqual(['Write follow-up', 'Write follow-up']);
  expect(new Set(tomorrowItems.map(i => i.id)).size).toBe(2);
});

test('reconciliation never blocks confirming tomorrow — no reason, no carry, still ready', async ({ page }) => {
  await openApp(page, { plans: { [TODAY]: { items: [planItem('open-1', 'Write follow-up')] } } });
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Something for tomorrow');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
});
