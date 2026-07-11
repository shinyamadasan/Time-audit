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
      return {
        set() { return Promise.resolve(); },
        remove() { return Promise.resolve(); },
        cancel() { return Promise.resolve(); }
      };
    }
  });
  const auth = () => ({
    onAuthStateChanged(cb) {
      setTimeout(() => cb({
        uid: 'smoke-user',
        displayName: 'Smoke User',
        email: 'smoke@example.test',
        photoURL: ''
      }), 0);
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
    initializeApp(config) {
      const app = { config };
      this.apps.push(app);
      return app;
    },
    app() { return this.apps[0] || this.initializeApp({}); },
    database() { return { ref: makeRef }; },
    auth
  };
})();
`;

function baseSettings(overrides = {}) {
  return {
    hardMode: true,
    intervalMin: 30,
    targetRate: 250,
    deepGoal: 20,
    exitDelay: 10,
    presets: [],
    timezone: 'UTC',
    activityColors: {},
    coachTone: 'analyst',
    reviewHour: 22,
    sleepTime: '23:00',
    wakeTime: '07:00',
    sleepReminderMin: 30,
    sleepSetupDone: true,
    templates: [],
    ...overrides
  };
}

function minutesAgo(minutes) {
  return Date.now() - minutes * 60 * 1000;
}

function utcDateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function openApp(page, { entries = [], focusRedemptions = [], settings = {} } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: firebaseStub
  }));
  await page.addInitScript(({ entries, focusRedemptions, settings }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', settings.timezone || 'UTC');
    localStorage.setItem('ta3-settings', JSON.stringify(settings));
    localStorage.setItem('ta3-entries', JSON.stringify(entries));
    localStorage.setItem('ta3-focus-redemptions', JSON.stringify(focusRedemptions));
  }, {
    entries,
    focusRedemptions,
    settings: baseSettings(settings)
  });
  await page.goto(APP_URL);
  await page.waitForFunction(() => typeof window.quickRetroLog === 'function' && !!document.getElementById('timeline-blocks'));
  await expect(page.locator('#today-date')).not.toHaveText('');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function clickToastUndo(page) {
  const undo = page.locator('#toast .toast-undo-btn');
  await expect(undo).toBeVisible();
  await undo.click();
}

test('quick retro log can be undone', async ({ page }) => {
  await openApp(page);

  await page.locator('#retro-task').click();
  await page.locator('#retro-task').fill('Smoke deep work');
  await page.locator('#retro-qstart').fill('10:00');
  await page.locator('#retro-qend').fill('10:30');
  await page.locator('.quick-retro-bar').getByRole('button', { name: 'Log' }).click();

  await expect(page.locator('#recent-list')).toContainText('Smoke deep work');
  await clickToastUndo(page);
  await expect(page.locator('#recent-list')).not.toContainText('Smoke deep work');
});

test('deleted entries can be restored with undo', async ({ page }) => {
  const ts = minutesAgo(10);
  const entry = {
    id: ts,
    ts,
    tsStart: ts - 30 * 60 * 1000,
    updatedAt: ts,
    blockIntervalMin: 30,
    date: utcDateKey(ts),
    activity: 'Seeded focus block',
    energy: 'deep',
    category: 'deep_work',
    originalLabel: 'deep',
    onPlan: true,
    retro: true
  };
  await openApp(page, { entries: [entry] });

  const row = page.locator('#recent-list .entry-row').filter({ hasText: 'Seeded focus block' });
  await expect(row).toHaveCount(1);
  await row.locator('button[onclick*="deleteEntry"]').click();

  await expect(page.locator('#recent-list')).not.toContainText('Seeded focus block');
  await clickToastUndo(page);
  await expect(page.locator('#recent-list')).toContainText('Seeded focus block');
});

test('focus wallet spend can be undone without leaving point debt', async ({ page }) => {
  const ts = minutesAgo(5);
  const deepEntry = {
    id: ts,
    ts,
    tsStart: ts - 60 * 60 * 1000,
    updatedAt: ts,
    blockIntervalMin: 60,
    date: utcDateKey(ts),
    activity: 'Deep work',
    energy: 'deep',
    category: 'deep_work',
    originalLabel: 'deep',
    onPlan: true,
    retro: false
  };
  await openApp(page, { entries: [deepEntry] });

  await expect(page.locator('#fw-balance')).toHaveText('17');
  await page.locator('#focus-wallet-card').getByRole('button', { name: 'Spend' }).click();
  await page.locator('#fw-reward-label').fill('Movie smoke');
  await page.locator('#fw-reward-duration').fill('30');
  await page.locator('#fw-reward-points').fill('10');
  await page.getByRole('button', { name: 'Log reward' }).click();

  await expect(page.locator('#fw-balance')).toHaveText('7');
  await clickToastUndo(page);
  await expect(page.locator('#fw-balance')).toHaveText('17');
  await expect(page.locator('#recent-list')).not.toContainText('Movie smoke');
});

test('today health shows compact daily accounting', async ({ page }) => {
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const deepStart = todayStart + 9 * 60 * 60 * 1000;
  const deepEnd = deepStart + 60 * 60 * 1000;
  const wasteEnd = deepEnd + 20 * 60 * 1000;
  const entries = [
    {
      id: deepEnd,
      ts: deepEnd,
      tsStart: deepStart,
      updatedAt: deepEnd,
      blockIntervalMin: 60,
      date: utcDateKey(deepStart),
      activity: 'Smoke deep work',
      energy: 'deep',
      category: 'deep_work',
      originalLabel: 'deep',
      onPlan: true,
      retro: false
    },
    {
      id: wasteEnd,
      ts: wasteEnd,
      tsStart: deepEnd,
      updatedAt: wasteEnd,
      blockIntervalMin: 20,
      date: utcDateKey(deepEnd),
      activity: 'Smoke scrolling',
      energy: 'waste',
      category: 'waste',
      originalLabel: 'waste',
      onPlan: false,
      retro: true
    }
  ];
  await openApp(page, { entries });

  await expect(page.locator('#today-health')).toContainText('Today health');
  await expect(page.locator('#th-deep')).toHaveText('1h deep');
  await expect(page.locator('#th-waste')).toHaveText('20m waste');
  await expect(page.locator('#th-wallet')).toHaveText('15 pts');
  await expect(page.locator('#th-unlogged')).toContainText('unlogged');

  await page.locator('#th-unlogged').click();
  await expect(page.locator('#timeline-blocks')).toBeInViewport({ ratio: 0.1 });
});

test('crossing-day entries are clipped instead of displayed as one 28h block', async ({ page }) => {
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = todayStart - 24 * 60 * 60 * 1000;
  const end = todayStart + 4 * 60 * 60 * 1000;
  const entry = {
    id: end,
    ts: end,
    tsStart: start,
    updatedAt: end,
    blockIntervalMin: 28 * 60,
    date: utcDateKey(start),
    activity: 'PC Time',
    energy: 'deep',
    category: 'deep_work',
    originalLabel: 'deep',
    onPlan: true,
    retro: true
  };
  await openApp(page, { entries: [entry] });

  await expect(page.locator('#timeline-blocks')).toContainText('PC Time');
  await expect(page.locator('#timeline-blocks')).toContainText('4h');
  await expect(page.locator('#timeline-blocks')).not.toContainText('28h');

  await page.evaluate(dateKey => window.setViewDate(dateKey), utcDateKey(start));
  await expect(page.locator('#timeline-blocks')).toContainText('PC Time');
  await expect(page.locator('#timeline-blocks')).toContainText('24h');
  await expect(page.locator('#timeline-blocks')).not.toContainText('28h');
});
