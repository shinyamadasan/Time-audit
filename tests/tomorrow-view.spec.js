// Tomorrow View V1 — a read-only projection of plans[tomorrowKey] on the main Today surface, next
// to a Today/Tomorrow toggle. Harness mirrors tests/daily-reconciliation.spec.js and
// tests/plan-tomorrow-ui.spec.js (same firebase stub, same localStorage seeding contract).
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

const routine = (overrides = {}) => ({ id: 'routine-1', createdDate: '2026-09-01', title: 'Deep work', enabled: true, cadence: 'daily', days: [], mode: 'exact', time: '09:00', endTime: '', cue: '', targetMinutes: 30, minimumMinutes: 10, fallback: 'Do 5 minutes', source: 'manual', planId: '', workoutRoutineId: '', ...overrides });
const routineState = (routines = [], timezone = 'Etc/UTC', extra = {}) => ({ schemaVersion: 1, timezone, routines, manual: {}, links: {}, focus: {}, skips: {}, ...extra });
const planItem = (id, task, extra = {}) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: NOW, updatedBy: 'device-test', ...extra });

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

async function openApp(page, { plans = {}, routines = routineState([]), entries = [], deviceId = 'device-test', viewport = null, commitmentsView = null } = {}) {
  if (viewport) await page.setViewportSize(viewport);
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ plans, routines, entries, now, deviceId, commitmentsView }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', 'Etc/UTC');
    localStorage.setItem('ta3-device-id', deviceId);
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone: 'Etc/UTC', hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', JSON.stringify(entries)); localStorage.setItem('ta3-focus-redemptions', '[]'); localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-plans', JSON.stringify(plans));
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify(routines));
    if (commitmentsView) localStorage.setItem('ta3-commitments-view', commitmentsView);
  }, { plans, routines, entries, now: NOW, deviceId, commitmentsView });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof openPlanTomorrow === 'function' && typeof getPlanTomorrowAppContext === 'function');
  await page.evaluate(() => { document.getElementById('today-commitments').hidden = false; });
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

test.describe('Navigation', () => {
  test('defaults to Today, toggles to Tomorrow and back, and never mutates plan truth', async ({ page }) => {
    await openApp(page, { plans: { [TODAY]: { items: [planItem('t1', 'Existing today task')] } } });
    await expect(page.locator('#today-commitments-today')).toBeVisible();
    await expect(page.locator('#tomorrow-view')).toBeHidden();
    await expect(page.locator('#tmr-tab-today')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tmr-tab-tomorrow')).toHaveAttribute('aria-pressed', 'false');

    const before = await page.evaluate(() => localStorage.getItem('ta3-plans'));
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('#tomorrow-view')).toBeVisible();
    await expect(page.locator('#today-commitments-today')).toBeHidden();
    await expect(page.locator('#tmr-tab-tomorrow')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tmr-tab-today')).toHaveAttribute('aria-pressed', 'false');

    await page.locator('#tmr-tab-today').click();
    await expect(page.locator('#today-commitments-today')).toBeVisible();
    await expect(page.locator('#tomorrow-view')).toBeHidden();
    await page.locator('#tmr-tab-tomorrow').click();
    await page.locator('#tmr-tab-today').click();

    const after = await page.evaluate(() => localStorage.getItem('ta3-plans'));
    expect(after).toBe(before);
    await expect(page.locator('#plan-strip')).toContainText('Existing today task');
  });

  test('an already-persisted Tomorrow preference cannot hide the primary My Day on load', async ({ page }) => {
    await openApp(page, { plans: { [TODAY]: { items: [planItem('t1', 'kept')] } }, commitmentsView: 'tomorrow' });
    const before = await page.evaluate(() => localStorage.getItem('ta3-plans'));
    await expect(page.locator('#tomorrow-view')).toBeHidden();
    await expect(page.locator('#today-commitments-today')).toBeVisible();
    await expect(page.locator('#tmr-tab-today')).toHaveAttribute('aria-pressed', 'true');
    const after = await page.evaluate(() => localStorage.getItem('ta3-plans'));
    expect(after).toBe(before);
  });

  test('is keyboard operable', async ({ page }) => {
    await openApp(page);
    await page.locator('#tmr-tab-tomorrow').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#tomorrow-view')).toBeVisible();
  });
});

test.describe('Prepared vs draft truth', () => {
  test('no plan at all shows the honest not-prepared empty state', async ({ page }) => {
    await openApp(page);
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('.tmr-empty')).toHaveText('Tomorrow hasn’t been prepared yet.');
    await expect(page.locator('[data-tmr-action="open"]')).toHaveText('Plan tomorrow');
    await expect(page.locator('.tmr-status')).toHaveCount(0);
  });

  test('content exists but preparation was never confirmed is labeled honestly, not "Prepared"', async ({ page }) => {
    await openApp(page, { plans: { [TARGET]: { items: [planItem('p1', 'Unconfirmed priority')], updatedAt: NOW } } });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('.tmr-status')).toHaveText('Not yet prepared');
    await expect(page.locator('.tmr-row-title')).toContainText('Unconfirmed priority');
    await expect(page.locator('[data-tmr-action="open"]')).toHaveText('Edit tomorrow');
  });

  test('a confirmed plan shows Prepared with timed and untimed priorities in chronological order', async ({ page }) => {
    await openApp(page, { routines: routineState([routine()]) });
    await page.evaluate(() => openPlanTomorrow());
    await page.locator('#plan-tomorrow-add input[name="when"]').fill('11:00');
    await page.locator('#plan-tomorrow-add input[name="task"]').fill('Workout');
    await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
    await page.locator('#plan-tomorrow-add input[name="task"]').fill('Call Alyssa');
    await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);

    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('.tmr-status')).toHaveText('Prepared');
    await expect(page.locator('.tmr-date')).toContainText('Wednesday, September 9');
    const rows = page.locator('.tmr-row-title');
    await expect(rows.nth(0)).toHaveText('Deep work'); // 9:00 routine
    await expect(rows.nth(1)).toHaveText('Workout'); // 11:00 timed one-off
    await expect(rows.nth(2)).toHaveText('Call Alyssa'); // untimed, stable order
    await expect(page.locator('.tmr-row-time').nth(1)).toHaveText('11:00 AM');
    await expect(page.locator('.tmr-row-time').nth(2)).toHaveText('—');
    await expect(page.locator('[data-tmr-action="open"]')).toHaveText('Edit tomorrow');
  });

  test('an explicit Open Day is shown distinctly, never inferred from zero items', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => openPlanTomorrow());
    await page.getByRole('button', { name: 'Rescue / minimum' }).click();
    await page.locator('#plan-tomorrow-overlay').getByRole('button', { name: 'Open day / no commitments' }).click();
    await page.getByRole('button', { name: 'Use this plan' }).click();
    await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);

    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('.tmr-open-day')).toHaveText('Tomorrow is an Open Day.');
    await expect(page.locator('.tmr-empty')).toHaveCount(0);
    await expect(page.locator('[data-tmr-action="open"]')).toHaveText('Edit tomorrow');
  });
});

test.describe('Plan projection', () => {
  test('same-title carried and manual items both stay visible, never deduplicated', async ({ page }) => {
    await openApp(page, {
      plans: { [TARGET]: { items: [
        planItem('carry:2026-09-08:open-1', 'Write follow-up', { carriedFromId: 'open-1' }),
        planItem('manual-1', 'Write follow-up')
      ] } }
    });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('.tmr-row-title')).toHaveCount(2);
    const texts = await page.locator('.tmr-row-title').allTextContents();
    expect(texts).toEqual(['Write follow-up', 'Write follow-up']);
  });

  test('a deleted tomorrow item never appears, and a plan left with nothing active is the honest empty state', async ({ page }) => {
    await openApp(page, { plans: { [TARGET]: { items: [planItem('gone', 'Removed', { deleted: true })] } } });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('.tmr-row-title')).toHaveCount(0);
    await expect(page.locator('.tmr-empty')).toHaveText('Tomorrow hasn’t been prepared yet.');
  });

  test('a deleted tomorrow item never appears alongside real content', async ({ page }) => {
    await openApp(page, { plans: { [TARGET]: { items: [
      planItem('gone', 'Removed', { deleted: true }),
      planItem('kept', 'Kept priority')
    ] } } });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('.tmr-row-title')).toHaveCount(1);
    await expect(page.locator('.tmr-row-title')).toHaveText('Kept priority');
  });

  test('a routine not occurring tomorrow (wrong weekday) is excluded; one that does occur is shown', async ({ page }) => {
    // 2026-09-09 is a Wednesday (day 3). "selected" days [1] = Monday only, never fires tomorrow.
    await openApp(page, { routines: routineState([
      routine({ id: 'mon-only', title: 'Monday only', cadence: 'selected', days: [1] }),
      routine({ id: 'daily-one', title: 'Every day', cadence: 'daily' })
    ]) });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('.tmr-row-title')).toHaveCount(1);
    await expect(page.locator('.tmr-row-title')).toHaveText('Every day');
  });

  test('a skipped-tomorrow routine instance is excluded from the projection', async ({ page }) => {
    await openApp(page, {
      plans: { [TARGET]: { items: [planItem('p1', 'Keeps this state out of the empty branch')] } },
      routines: routineState([routine()], 'Etc/UTC', { skips: { '["routine-1","2026-09-09"]': { skippedAt: NOW, updatedAt: NOW } } })
    });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('text=No routines occur on this date.')).toBeVisible();
    await expect(page.locator('.tmr-row-title')).toHaveText('Keeps this state out of the empty branch');
  });
});

test.describe('Read-only guarantee', () => {
  test('opening, toggling, and reopening Tomorrow writes nothing to plan storage', async ({ page }) => {
    await openApp(page, {
      plans: { [TARGET]: { items: [planItem('p1', 'Untouched')], updatedAt: NOW } },
      routines: routineState([routine()])
    });
    const snapshot = () => page.evaluate(() => ({ plans: localStorage.getItem('ta3-plans'), routines: localStorage.getItem('ta3-daily-routines-v1') }));
    const before = await snapshot();
    for (let i = 0; i < 3; i++) {
      await page.locator('#tmr-tab-tomorrow').click();
      await page.locator('#tmr-tab-today').click();
    }
    const after = await snapshot();
    expect(after).toEqual(before);
  });
});

test.describe('Edit handoff', () => {
  test('"Plan tomorrow" and "Edit tomorrow" both open the existing Plan Tomorrow flow, never a new editor', async ({ page }) => {
    await openApp(page);
    await page.locator('#tmr-tab-tomorrow').click();
    await page.locator('[data-tmr-action="open"]').click();
    await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
    await expect(page.locator('#plan-tomorrow-date')).toContainText('Wednesday, September 9');
  });
});

test.describe('Safety', () => {
  test('a hostile task title is escaped, never interpreted as markup', async ({ page }) => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    await openApp(page, { plans: { [TARGET]: { items: [planItem('p1', hostile)] } } });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('.tmr-row-title')).toHaveText(hostile);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await page.locator('.tmr-row-title').evaluate(el => el.querySelector('img'))).toBeNull();
  });
});

test.describe('Mobile', () => {
  test('fits at ~390px with no horizontal overflow and a reachable toggle', async ({ page }) => {
    await openApp(page, {
      plans: { [TARGET]: { items: [planItem('p1', 'A fairly long priority title that could wrap on a narrow phone screen')] } },
      viewport: { width: 390, height: 844 }
    });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('.tmr-row-title')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
