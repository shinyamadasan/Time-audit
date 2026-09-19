// Tomorrow Timeline Preview V1 — a read-only projection of tomorrow's plan onto the lower-page
// Timeline slot, replacing Today's actual Timeline + action controls whenever the Tomorrow tab is
// selected. Harness mirrors tests/tomorrow-view.spec.js exactly (same firebase stub, same
// localStorage seeding contract) since this feature extends that same module/toggle.
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
const TARGET = '2026-09-09'; // Wednesday, dow=3
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
const template = (overrides = {}) => ({ id: 'tpl-1', activity: 'Dinner', energy: 'recovery', days: [0, 1, 2, 3, 4, 5, 6], startTime: '04:00', endTime: '04:30', enabled: true, autoLog: false, skipDates: [], ...overrides });

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

async function openApp(page, { plans = {}, routines = routineState([]), entries = [], templates = [], deviceId = 'device-test', viewport = null, commitmentsView = null } = {}) {
  if (viewport) await page.setViewportSize(viewport);
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ plans, routines, entries, templates, now, deviceId, commitmentsView }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', 'Etc/UTC');
    localStorage.setItem('ta3-device-id', deviceId);
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone: 'Etc/UTC', hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates }));
    localStorage.setItem('ta3-entries', JSON.stringify(entries)); localStorage.setItem('ta3-focus-redemptions', '[]'); localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-plans', JSON.stringify(plans));
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify(routines));
    if (commitmentsView) localStorage.setItem('ta3-commitments-view', commitmentsView);
  }, { plans, routines, entries, templates, now: NOW, deviceId, commitmentsView });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof openPlanTomorrow === 'function' && typeof getPlanTomorrowAppContext === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
  // The permanent switcher is removed from the normal My Day page. This suite
  // unhides the retained secondary preview surface to regression-test its
  // read-only projection directly.
  await page.evaluate(() => { document.getElementById('today-commitments').hidden = false; });
}

function storageSnapshot(page) {
  return page.evaluate(() => ({
    plans: localStorage.getItem('ta3-plans'),
    routines: localStorage.getItem('ta3-daily-routines-v1'),
    entries: localStorage.getItem('ta3-entries'),
    settings: localStorage.getItem('ta3-settings')
  }));
}

test.describe('Today/Tomorrow coherence', () => {
  test('Today selected keeps the actual Timeline and its actions; Tomorrow hides them and shows the preview', async ({ page }) => {
    await openApp(page, { plans: { [TARGET]: { items: [planItem('p1', 'Buy eyedrops', { when: '09:00', durationMinutes: 120 })] } } });
    await expect(page.locator('#timeline-section')).toBeVisible();
    await expect(page.locator('#tomorrow-timeline-preview')).toBeHidden();
    await expect(page.locator('#so-far')).toBeVisible();
    await expect(page.locator('#today-nav-log-time')).toHaveCount(0);

    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('#timeline-section')).toBeHidden();
    await expect(page.locator('#timeline-entry-actions')).toBeHidden();
    await expect(page.locator('#tomorrow-timeline-preview')).toBeVisible();
    await expect(page.locator('#so-far')).toBeHidden();
    await expect(page.locator('#today-nav-log-time')).toHaveCount(0);
    await expect(page.locator('#log-time-details')).toBeHidden();
    await expect(page.locator('.ttp-row')).toContainText('Buy eyedrops');

    await page.locator('#tmr-tab-today').click();
    await expect(page.locator('#timeline-section')).toBeVisible();
    await expect(page.locator('#tomorrow-timeline-preview')).toBeHidden();
    await expect(page.locator('#so-far')).toBeVisible();
    await expect(page.locator('#today-nav-log-time')).toHaveCount(0);
  });

  test('needs-you stays hidden on Tomorrow even when a Today nudge would otherwise show it', async ({ page }) => {
    await openApp(page, { routines: routineState([routine({ fallback: '' })]) });
    await page.evaluate(() => { document.getElementById('routine-needs-item').hidden = false; renderNeedsYou(); });
    await expect(page.locator('#needs-you')).toBeVisible();
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('#needs-you')).toBeHidden();
    await page.evaluate(() => renderNeedsYou()); // simulate an independent, unrelated re-render (e.g. a MutationObserver)
    await expect(page.locator('#needs-you')).toBeHidden();
    await page.locator('#tmr-tab-today').click();
    await expect(page.locator('#needs-you')).toBeVisible();
  });

  test('no interactive Log it / Off today / edit controls exist inside the preview', async ({ page }) => {
    await openApp(page, {
      plans: { [TARGET]: { items: [planItem('p1', 'Ranged priority', { when: '09:00', durationMinutes: 60 })] } },
      routines: routineState([routine()]),
      templates: [template()]
    });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('#tomorrow-timeline-preview .ttp-row')).not.toHaveCount(0);
    expect(await page.locator('#tomorrow-timeline-preview button').count()).toBe(0);
    expect(await page.locator('#tomorrow-timeline-preview a').count()).toBe(0);
  });
});

test.describe('Read-only guarantee', () => {
  test('opening, toggling, and reopening Tomorrow writes nothing to any storage', async ({ page }) => {
    await openApp(page, {
      plans: { [TARGET]: { items: [planItem('p1', 'Untouched', { when: '09:00', durationMinutes: 30 })] } },
      routines: routineState([routine()]),
      templates: [template(), template({ id: 'tpl-2', activity: 'Scribe shift', startTime: '22:00', endTime: '08:00', autoLog: true })]
    });
    const before = await storageSnapshot(page);
    for (let i = 0; i < 3; i++) {
      await page.locator('#tmr-tab-tomorrow').click();
      await page.locator('#tmr-tab-today').click();
    }
    const after = await storageSnapshot(page);
    expect(after).toEqual(before);
  });
});

test.describe('Priorities', () => {
  test('a ranged priority shows a start–end range; a start-only priority shows just its start; an untimed priority is listed as Unscheduled, never positioned', async ({ page }) => {
    await openApp(page, {
      plans: { [TARGET]: { items: [
        planItem('ranged', 'Study automation', { when: '14:00', durationMinutes: 120 }),
        planItem('start-only', 'Buy eyedrops', { when: '09:00' }),
        planItem('untimed', 'Call Alyssa', { when: '' })
      ] } }
    });
    await page.locator('#tmr-tab-tomorrow').click();
    const rows = page.locator('#tomorrow-timeline-preview .ttp-row:not(.ttp-row-unscheduled)');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('9:00 AM');
    await expect(rows.nth(0)).toContainText('Buy eyedrops');
    await expect(rows.nth(0)).toContainText('Planned priority');
    await expect(rows.nth(1)).toContainText('2:00–4:00 PM');
    await expect(rows.nth(1)).toContainText('Study automation');
    await expect(page.locator('.ttp-unscheduled')).toContainText('Call Alyssa');
    await expect(page.locator('.ttp-unscheduled .ttp-row')).toHaveCount(1);
  });

  test('a malformed duration (would cross midnight) safely degrades to start-only, never fabricates an end', async ({ page }) => {
    await openApp(page, { plans: { [TARGET]: { items: [planItem('p1', 'Late task', { when: '23:00', durationMinutes: 300 })] } } });
    await page.locator('#tmr-tab-tomorrow').click();
    const row = page.locator('#tomorrow-timeline-preview .ttp-row').first();
    await expect(row).toContainText('11:00 PM');
    await expect(row.locator('.ttp-time')).not.toContainText('–');
  });
});

test.describe('Routines', () => {
  test('an applicable exact-time routine is positioned; a wrong-weekday routine is excluded; a skipped-tomorrow routine is excluded', async ({ page }) => {
    await openApp(page, {
      routines: routineState([
        routine({ id: 'daily-one', title: 'Deep work', mode: 'exact', time: '09:00' }),
        routine({ id: 'mon-only', title: 'Monday only', cadence: 'selected', days: [1] }),
        routine({ id: 'skipped-one', title: 'Skipped tomorrow' })
      ], 'Etc/UTC', { skips: { '["skipped-one","2026-09-09"]': { skippedAt: NOW, updatedAt: NOW } } })
    });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('#tomorrow-timeline-preview')).toContainText('Deep work');
    await expect(page.locator('#tomorrow-timeline-preview')).not.toContainText('Monday only');
    await expect(page.locator('#tomorrow-timeline-preview')).not.toContainText('Skipped tomorrow');
    await expect(page.locator('#tomorrow-timeline-preview .ttp-row', { hasText: 'Deep work' })).toContainText('Planned routine');
  });

  test('a window-mode routine shows a start–end range; a cue routine is Unscheduled, never given a fabricated time', async ({ page }) => {
    await openApp(page, {
      routines: routineState([
        routine({ id: 'gym', title: 'Gym', mode: 'window', time: '17:00', endTime: '18:00' }),
        routine({ id: 'stretch', title: 'Stretch', mode: 'cue', cue: 'After dinner' })
      ])
    });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('#tomorrow-timeline-preview .ttp-row', { hasText: 'Gym' })).toContainText('5:00–6:00 PM');
    await expect(page.locator('.ttp-unscheduled')).toContainText('Stretch');
  });
});

test.describe('Templates', () => {
  test('a same-day template shows the Template hint label; an autoLog template shows Scheduled auto-log, never Auto-logged', async ({ page }) => {
    await openApp(page, { templates: [
      template({ id: 'hint', activity: 'Hygiene', startTime: '08:30', endTime: '08:50', autoLog: false }),
      template({ id: 'auto', activity: 'Standup', startTime: '10:00', endTime: '10:15', autoLog: true })
    ] });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('#tomorrow-timeline-preview .ttp-row', { hasText: 'Hygiene' })).toContainText('Template hint');
    await expect(page.locator('#tomorrow-timeline-preview .ttp-row', { hasText: 'Standup' })).toContainText('Scheduled auto-log');
    await expect(page.locator('#tomorrow-timeline-preview')).not.toContainText('Auto-logged');
  });

  test('a cross-midnight template (10 PM to 8 AM) renders honestly as a single overnight range', async ({ page }) => {
    await openApp(page, { templates: [template({ id: 'night', activity: 'Scribe shift', startTime: '22:00', endTime: '08:00', autoLog: true })] });
    await page.locator('#tmr-tab-tomorrow').click();
    const row = page.locator('#tomorrow-timeline-preview .ttp-row', { hasText: 'Scribe shift' });
    await expect(row).toContainText('10:00 PM–8:00 AM');
    await expect(row).toContainText('Scheduled auto-log');
  });

  test('a template applies even when tomorrow has no confirmed plan (prep-independent)', async ({ page }) => {
    await openApp(page, { templates: [template({ activity: 'Dinner' })] });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('.tmr-empty')).toHaveText('Tomorrow hasn’t been prepared yet.');
    await expect(page.locator('#tomorrow-timeline-preview')).toContainText('Dinner');
  });
});

test.describe('Ordering', () => {
  test('mixed priorities, routines, and a template sort by clock start, breaking ties by stable id', async ({ page }) => {
    await openApp(page, {
      plans: { [TARGET]: { items: [
        planItem('late-p', 'Study automation', { when: '14:00' }),
        planItem('same-time-b', 'Same time B', { when: '09:00' }),
        planItem('same-time-a', 'Same time A', { when: '09:00' })
      ] } },
      routines: routineState([routine({ id: 'early-r', title: 'Early routine', time: '05:00' })]),
      templates: [template({ id: 'noon-t', activity: 'Noon block', startTime: '12:00', endTime: '12:30' })]
    });
    await page.locator('#tmr-tab-tomorrow').click();
    const titles = await page.locator('#tomorrow-timeline-preview .ttp-row:not(.ttp-row-unscheduled) .ttp-title').allTextContents();
    assertOrder(titles, ['Early routine', 'Same time A', 'Same time B', 'Noon block', 'Study automation']);
  });
});

function assertOrder(actual, expected) {
  expect(actual).toEqual(expected);
}

test.describe('Safety', () => {
  test('a hostile template/routine/priority title is escaped, never interpreted as markup', async ({ page }) => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    await openApp(page, {
      plans: { [TARGET]: { items: [planItem('p1', hostile, { when: '09:00' })] } }
    });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('#tomorrow-timeline-preview .ttp-title')).toHaveText(hostile);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });
});

test.describe('Mobile', () => {
  test('fits at ~390px with a long title and a template row, no horizontal overflow', async ({ page }) => {
    await openApp(page, {
      plans: { [TARGET]: { items: [planItem('p1', 'A fairly long priority title that could wrap on a narrow phone screen', { when: '09:00', durationMinutes: 90 })] } },
      templates: [template({ activity: 'Scribe shift', startTime: '22:00', endTime: '08:00', autoLog: true })],
      viewport: { width: 390, height: 844 }
    });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('#tomorrow-timeline-preview .ttp-row').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('Rollover', () => {
  test('the preview target date advances when the app-wide date tick crosses midnight', async ({ page }) => {
    await openApp(page, {
      plans: {
        [TARGET]: { items: [planItem('p1', 'Wednesday priority', { when: '09:00' })] },
        '2026-09-10': { items: [planItem('p2', 'Thursday priority', { when: '09:00' })] }
      },
      commitmentsView: 'tomorrow'
    });
    await page.locator('#tmr-tab-tomorrow').click();
    await expect(page.locator('#tomorrow-timeline-preview')).toContainText('Wednesday priority');
    await page.evaluate(() => {
      const RealDate = Date;
      const nextNow = Date.parse('2026-09-09T18:00:00Z');
      window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [nextNow])); } static now() { return nextNow; } };
      refreshTomorrowView();
    });
    await expect(page.locator('#tomorrow-timeline-preview')).toContainText('Thursday priority');
    await expect(page.locator('#tomorrow-timeline-preview')).not.toContainText('Wednesday priority');
  });
});
