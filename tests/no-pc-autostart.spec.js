import { test, expect } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The desktop "PC Time" auto-start was removed: a fresh desktop session must stay idle,
// while a timer restored from storage must still come back running with its own task.

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

const settings = {
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
  reviewTime: '22:00',
  sleepTime: '23:00',
  wakeTime: '07:00',
  sleepReminderMin: 30,
  sleepSetupDone: true,
  templates: []
};

// Deliberately does NOT set sessionStorage 'ta3-session-started', so this is a fresh browser session.
async function openFreshDesktopSession(page, { savedTimer = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: firebaseStub
  }));
  await page.addInitScript(({ settings, savedTimer }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    localStorage.setItem('ta3-tz:uid_smoke-user', 'UTC');
    localStorage.setItem('ta3-settings:uid_smoke-user', JSON.stringify(settings));
    localStorage.setItem('ta3-entries:uid_smoke-user', '[]');
    if (savedTimer) localStorage.setItem('ta3-timer:uid_smoke-user', JSON.stringify(savedTimer));
  }, { settings, savedTimer });
  await page.goto(APP_URL);
  await page.waitForFunction(() => typeof window.quickRetroLog === 'function' && !!document.getElementById('timeline-blocks'));
  await expect(page.locator('#signin-overlay')).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem('ta3-session-started'))).toBeNull();
}

test('fresh desktop session does not auto-start a PC Time timer', async ({ page }) => {
  await openFreshDesktopSession(page);

  // Outlast the former 5-second auto-start window.
  await page.waitForTimeout(6500);

  const state = await page.evaluate(() => ({
    running,
    currentTask,
    entryCount: entries.length,
    pcTimeEntries: entries.filter(e => e.activity === 'PC Time').length,
    savedTimer: JSON.parse(localStorage.getItem('ta3-timer:uid_smoke-user') || 'null')
  }));
  expect(state.running).toBe(false);
  expect(state.currentTask).not.toBe('PC Time');
  expect(state.entryCount).toBe(0);
  expect(state.pcTimeEntries).toBe(0);
  expect(state.savedTimer?.running ?? false).toBe(false);
  await expect(page.locator('#hero-active')).toBeHidden();
});

test('a timer restored from storage is still shown running with its original task', async ({ page }) => {
  const startedAt = Date.now() - 5 * 60 * 1000;
  await openFreshDesktopSession(page, {
    savedTimer: {
      running: true,
      currentTask: 'Restored deep work',
      lastTask: 'Restored deep work',
      timerStartedAt: startedAt,
      taskStartTime: startedAt,
      blockStartTime: startedAt,
      totalSecs: 1800
    }
  });

  await expect.poll(() => page.evaluate(() => running)).toBe(true);
  await page.waitForTimeout(6500);

  const state = await page.evaluate(() => ({ running, currentTask, lastTaskForRepeat, timerStartedAt }));
  expect(state).toEqual({
    running: true,
    currentTask: 'Restored deep work',
    lastTaskForRepeat: 'Restored deep work',
    timerStartedAt: startedAt
  });
  await expect(page.locator('#hero-active')).toBeVisible();
  await expect(page.locator('#hero-task-name')).toHaveText('Restored deep work');
});
