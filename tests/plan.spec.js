import { test, expect } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_URL = pathToFileURL(path.resolve('index.html')).href;

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const makeRef = refPath => ({
    path: refPath,
    child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) {
      if (eventName === 'value') setTimeout(() => cb(snapshot(null)), 0);
      return cb;
    },
    off() {},
    once() { return Promise.resolve(snapshot(null)); },
    update() { return Promise.resolve(); },
    set() { return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    push(value) {
      const pushed = makeRef(refPath + '/pushed');
      pushed.key = 'pushed';
      if (value !== undefined) pushed.set(value);
      return pushed;
    },
    onDisconnect() {
      return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() };
    }
  });
  const auth = () => ({
    onAuthStateChanged(cb) {
      setTimeout(() => cb({ uid: 'plan-user', displayName: 'Plan User', email: 'plan@example.test', photoURL: '' }), 0);
      return () => {};
    },
    signInWithPopup() { return Promise.resolve(); },
    signInWithCredential() { return Promise.resolve(); },
    signOut() { return Promise.resolve(); }
  });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = {
    apps: [],
    initializeApp(config) { const app = { config }; this.apps.push(app); return app; },
    app() { return this.apps[0] || this.initializeApp({}); },
    database() { return { ref: makeRef }; },
    auth
  };
})();
`;

function baseSettings(overrides = {}) {
  return {
    hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10,
    presets: [], timezone: 'UTC', activityColors: {}, coachTone: 'analyst',
    reviewHour: 22, sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30,
    sleepSetupDone: true, templates: [], ...overrides
  };
}

const utcDateKey = ts => new Date(ts).toISOString().slice(0, 10);
const todayKey = () => utcDateKey(Date.now());

async function openApp(page, { entries = [], plans = {}, settings = {} } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: firebaseStub
  }));
  // addInitScript re-runs on every navigation, so seed exactly once — otherwise a reload
  // would wipe localStorage before the app could load it, and persistence can't be tested.
  await page.addInitScript(({ entries, plans, settings }) => {
    if (localStorage.getItem('ta3-test-seeded')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', settings.timezone || 'UTC');
    localStorage.setItem('ta3-settings', JSON.stringify(settings));
    localStorage.setItem('ta3-entries', JSON.stringify(entries));
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-plans', JSON.stringify(plans));
    localStorage.setItem('ta3-test-seeded', '1');
  }, { entries, plans, settings: baseSettings(settings) });
  await page.goto(APP_URL);
  await page.waitForFunction(() => typeof window.renderTodayPlan === 'function' && !!document.getElementById('plan-strip'));
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

/** Build a plan for today with the given items. */
function planFor(items) {
  return {
    [todayKey()]: {
      items: items.map((it, i) => ({
        id: 'seed' + i, task: it.task, when: it.when || '',
        done: !!it.done, doneAt: null, updatedAt: Date.now()
      })),
      updatedAt: Date.now()
    }
  };
}

async function addItem(page, task, when = '') {
  if (when) await page.locator('#plan-when').fill(when);
  await page.locator('#plan-task').fill(task);
  await page.locator('#plan-strip').getByRole('button', { name: 'Add' }).click();
}

test('WIP cap holds at 3 and removing one frees a slot (no deadlock)', async ({ page }) => {
  await openApp(page);

  await addItem(page, 'Write report');
  await addItem(page, 'Gym');
  await expect(page.locator('.plan-item')).toHaveCount(2);
  await expect(page.locator('.plan-count')).toHaveText('0 of 2 done');

  await addItem(page, 'Email triage');
  await expect(page.locator('.plan-item')).toHaveCount(3);

  // Cap reached — the add row is replaced by the cap notice, so no 4th can be entered.
  await expect(page.locator('.plan-add')).toHaveCount(0);
  await expect(page.locator('.plan-full')).toContainText('3 of 3');

  // Removing one must reopen the add row — this is the deadlock guard.
  await page.locator('.plan-item').first().locator('.plan-remove').click();
  await expect(page.locator('.plan-item')).toHaveCount(2);
  await expect(page.locator('.plan-add')).toHaveCount(1);

  await addItem(page, 'Read paper');
  await expect(page.locator('.plan-item')).toHaveCount(3);
});

test('when-then trigger renders with the task', async ({ page }) => {
  await openApp(page);
  await addItem(page, 'Write report', 'after lunch');
  await expect(page.locator('.plan-item').first().locator('.plan-when')).toHaveText('after lunch →');
  await expect(page.locator('.plan-item').first().locator('.plan-task')).toContainText('Write report');
});

test('tracked minutes are derived from real entries, not the checkbox', async ({ page }) => {
  const start = Date.now() - 60 * 60 * 1000;
  const end   = Date.now() - 30 * 60 * 1000;   // 30 minutes of real tracked time
  const entries = [{
    id: end, ts: end, tsStart: start, updatedAt: end, blockIntervalMin: 30,
    date: utcDateKey(start), activity: 'Write report', energy: 'deep',
    category: 'deep_work', originalLabel: 'deep', onPlan: true, retro: false
  }];

  await openApp(page, {
    entries,
    plans: planFor([{ task: 'Write report' }, { task: 'Gym' }])
  });

  const rows = page.locator('.plan-item');
  // Worked on it -> the app says so, with no manual input at all.
  await expect(rows.nth(0).locator('.plan-tracked')).toHaveText('30m tracked');
  await expect(rows.nth(0).locator('.plan-tracked')).toHaveClass(/on/);
  // Never touched -> honest zero.
  await expect(rows.nth(1).locator('.plan-tracked')).toHaveText('0m tracked');

  // Ticking "done" on the untouched item does NOT invent tracked time.
  await rows.nth(1).locator('.plan-check').click();
  await expect(rows.nth(1)).toHaveClass(/done/);
  await expect(rows.nth(1).locator('.plan-tracked')).toHaveText('0m tracked');
  await expect(page.locator('.plan-count')).toHaveText('1 of 2 done');
});

test('one-tap start launches the timer with the planned task', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Write report' }]) });

  await page.locator('.plan-item').first().locator('.plan-start').click();

  await expect(page.locator('#hero-task-name')).toHaveText('Write report');
  await expect(page.locator('#activity-hero')).toHaveClass(/tracking/);
  // `let` globals live in the script's lexical scope, not on window — reference them bare.
  expect(await page.evaluate(() => running)).toBe(true);
  expect(await page.evaluate(() => currentTask)).toBe('Write report');
});

test('plan survives a reload and drives the daily target', async ({ page }) => {
  await openApp(page);
  await addItem(page, 'Write report', 'after lunch');
  await addItem(page, 'Gym');
  await page.locator('.plan-item').first().locator('.plan-check').click();
  await expect(page.locator('.plan-count')).toHaveText('1 of 2 done');

  await page.reload();
  await page.waitForFunction(() => typeof window.renderTodayPlan === 'function');

  await expect(page.locator('.plan-item')).toHaveCount(2);
  await expect(page.locator('.plan-count')).toHaveText('1 of 2 done');
  await expect(page.locator('.plan-item').first().locator('.plan-when')).toHaveText('after lunch →');
  // The plan IS the daily target — focus-mode's deep bar reads this.
  expect(await page.evaluate(() => dailyCommitment)).toBe(2);
});

test('removed items are tombstoned so sync cannot resurrect them', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Write report' }, { task: 'Gym' }]) });

  await page.locator('.plan-item').first().locator('.plan-remove').click();
  await expect(page.locator('.plan-item')).toHaveCount(1);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-plans')));
  const items = stored[Object.keys(stored)[0]].items;
  expect(items).toHaveLength(2);                       // still on disk...
  expect(items.find(i => i.task === 'Write report').deleted).toBe(true);   // ...as a tombstone
});

test('past days render the plan read-only', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Write report' }]) });
  await expect(page.locator('.plan-start')).toHaveCount(1);

  // Navigate back one day — that day has no plan, so the strip hides entirely.
  await page.evaluate(() => navigateDateBy(-1));
  await expect(page.locator('#plan-strip')).toBeHidden();

  // Forward to today again — controls return.
  await page.evaluate(() => navigateDateBy(1));
  await expect(page.locator('.plan-start')).toHaveCount(1);
});

test('a past day with a plan shows it read-only (no start/remove controls)', async ({ page }) => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await openApp(page, {
    plans: {
      [yesterday]: {
        items: [{ id: 'y1', task: 'Yesterday task', when: '', done: true, doneAt: Date.now(), updatedAt: Date.now() }],
        updatedAt: Date.now()
      }
    }
  });

  await page.evaluate(() => navigateDateBy(-1));

  await expect(page.locator('.plan-item')).toHaveCount(1);
  await expect(page.locator('.plan-title')).toHaveText('Planned that day');
  await expect(page.locator('.plan-start')).toHaveCount(0);   // read-only
  await expect(page.locator('.plan-remove')).toHaveCount(0);
  await expect(page.locator('.plan-add')).toHaveCount(0);
});
