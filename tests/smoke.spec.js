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
    reviewTime: '22:00',
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

async function openApp(page, { entries = [], focusRedemptions = [], plans = {}, settings = {}, nowTs = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: firebaseStub
  }));
  await page.addInitScript(({ entries, focusRedemptions, plans, settings, nowTs }) => {
    if (nowTs) {
      const RealDate = Date;
      window.Date = class MockDate extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [nowTs]));
        }
        static now() {
          return nowTs;
        }
      };
    }
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', settings.timezone || 'UTC');
    localStorage.setItem('ta3-settings', JSON.stringify(settings));
    localStorage.setItem('ta3-entries', JSON.stringify(entries));
    localStorage.setItem('ta3-focus-redemptions', JSON.stringify(focusRedemptions));
    localStorage.setItem('ta3-plans', JSON.stringify(plans));
  }, {
    entries,
    focusRedemptions,
    plans,
    settings: baseSettings(settings),
    nowTs
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

async function openTodayDetails(page) {
  const toggle = page.locator('#today-details-toggle');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
    await toggle.click();
  }
}

test('focus overlay exit logs and renders the active session', async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.confirm = () => true;
    enterFocusMode();
    document.getElementById('focus-task-input').value = 'Focus exit save';
    startPomodoro();
    focusStartTime = Date.now() - 7 * 60 * 1000;
    exitFocusConfirm();

    const saved = JSON.parse(localStorage.getItem('ta3-entries') || '[]')
      .filter(e => e.activity === 'Focus exit save');
    return {
      savedCount: saved.length,
      minutes: saved[0]?.blockIntervalMin,
      overlayOpen: document.getElementById('focus-overlay').classList.contains('open')
    };
  });

  expect(result).toMatchObject({
    savedCount: 1,
    minutes: 7,
    overlayOpen: false
  });
  await expect(page.locator('#recent-list')).toContainText('Focus exit save');
});

test('leaving during a focus break does not duplicate the completed work session', async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.confirm = () => true;
    enterFocusMode();
    document.getElementById('focus-task-input').value = 'Focus break duplicate guard';
    startPomodoro();
    focusStartTime = Date.now() - 25 * 60 * 1000;
    endWorkSession();
    exitFocusConfirm();

    const saved = entries.filter(e => e.activity === 'Focus break duplicate guard');
    return {
      savedCount: saved.length,
      minutes: saved[0]?.blockIntervalMin,
      phase: pomodoroPhase
    };
  });

  expect(result).toMatchObject({
    savedCount: 1,
    minutes: 25,
    phase: 'idle'
  });
});

test('focus work publishes active timer sync and exit publishes stopped state', async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.confirm = () => true;
    window.__timerUpdates = [];
    fbRoomRef = {
      update(payload) {
        window.__timerUpdates.push(payload);
        return Promise.resolve();
      }
    };
    enterFocusMode();
    document.getElementById('focus-task-input').value = 'Synced focus block';
    startPomodoro();
    const activeTimer = window.__timerUpdates.filter(item => item.timer).at(-1).timer;
    exitFocusConfirm();
    const stoppedTimer = window.__timerUpdates.filter(item => item.timer).at(-1).timer;
    return { activeTimer, stoppedTimer, syncedDeviceId };
  });

  expect(result.activeTimer).toMatchObject({
    running: true,
    stopped: false,
    mode: 'focus',
    focusPhase: 'work',
    lastTask: 'Synced focus block',
    intervalSecs: 25 * 60,
    ownerDeviceId: result.syncedDeviceId
  });
  expect(result.activeTimer.startedAt).toBeGreaterThan(0);
  expect(result.stoppedTimer).toMatchObject({
    running: false,
    stopped: true,
    mode: 'focus',
    lastTask: null,
    ownerDeviceId: null
  });
});

test('focus started before sync connects publishes when sync becomes available', async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    fbRoomRef = null;
    enterFocusMode();
    document.getElementById('focus-task-input').value = 'Late sync focus';
    startPomodoro();

    window.__timerUpdates = [];
    fbRoomRef = {
      update(payload) {
        window.__timerUpdates.push(payload);
        return Promise.resolve();
      }
    };

    const pushed = syncLocalActiveTimerState();
    const timer = window.__timerUpdates.at(-1)?.timer;
    return { pushed, timer, syncedDeviceId };
  });

  expect(result.pushed).toBe(true);
  expect(result.timer).toMatchObject({
    running: true,
    stopped: false,
    mode: 'focus',
    focusPhase: 'work',
    lastTask: 'Late sync focus',
    intervalSecs: 25 * 60,
    ownerDeviceId: result.syncedDeviceId
  });
  expect(result.timer.startedAt).toBeGreaterThan(0);
});

test('active local focus owner rejects remote timer takeover and republishes focus', async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.__timerUpdates = [];
    fbRoomRef = {
      update(payload) {
        window.__timerUpdates.push(payload);
        return Promise.resolve();
      }
    };
    enterFocusMode();
    document.getElementById('focus-task-input').value = 'Owner focus block';
    startPomodoro();

    const applied = applyRemoteTimerState({
      running: true,
      lastTask: 'Phone auto timer',
      intervalSecs: 1800,
      startedAt: Date.now(),
      taskStartTime: Date.now(),
      blockStartTime: Date.now(),
      ownerDeviceId: 'phone-device',
      updatedAt: Date.now() + 1000,
      updatedBy: 'phone-device',
      deviceName: 'phone'
    });
    const republished = window.__timerUpdates.at(-1)?.timer;
    return { applied, currentTask, republished, syncedDeviceId };
  });

  expect(result.applied).toBe(false);
  expect(result.currentTask).toBe('Owner focus block');
  expect(result.republished).toMatchObject({
    running: true,
    mode: 'focus',
    lastTask: 'Owner focus block',
    ownerDeviceId: result.syncedDeviceId
  });
  await expect(page.locator('#sync-event-log')).toContainText('ignored remote timer; focus owned here');
  await expect(page.locator('#sync-detail-label')).toContainText('focus: Owner focus block');
});

test('quick retro log can be undone', async ({ page }) => {
  await openApp(page);
  await openTodayDetails(page);

  await page.locator('#retro-task').click();
  await page.locator('#retro-task').fill('Smoke deep work');
  await page.locator('#retro-qstart').fill('10:00');
  await page.locator('#retro-qend').fill('10:30');
  await page.locator('.quick-retro-bar').getByRole('button', { name: 'Log' }).click();

  await openTodayDetails(page);
  await expect(page.locator('#recent-list')).toContainText('Smoke deep work');
  await clickToastUndo(page);
  await expect(page.locator('#recent-list')).not.toContainText('Smoke deep work');
});

test('deleted entries can be restored with undo', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 12, 0, 0);
  const ts = nowTs - 10 * 60 * 1000;
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
  await openApp(page, { entries: [entry], nowTs });

  await openTodayDetails(page);
  const row = page.locator('#recent-list .entry-row').filter({ hasText: 'Seeded focus block' });
  await expect(row).toHaveCount(1);
  await row.locator('button[onclick*="deleteEntry"]').click();

  await expect(page.locator('#recent-list')).not.toContainText('Seeded focus block');
  await clickToastUndo(page);
  await expect(page.locator('#recent-list')).toContainText('Seeded focus block');
});

test('delete hides the entry before storage and sync work runs', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 12, 0, 0);
  const start = Date.UTC(2026, 6, 15, 9, 0, 0);
  const entry = {
    id: 'fast-delete',
    ts: start + 30 * 60 * 1000,
    tsStart: start,
    updatedAt: start,
    blockIntervalMin: 30,
    date: utcDateKey(start),
    activity: 'Delete responsiveness check',
    energy: 'deep',
    category: 'deep_work',
    originalLabel: 'deep',
    onPlan: true,
    retro: true
  };
  await openApp(page, { entries: [entry], nowTs });
  await openTodayDetails(page);
  await expect(page.locator('#recent-list')).toContainText('Delete responsiveness check');

  const result = await page.evaluate(() => {
    window.__deletePersistCalls = 0;
    window.__deleteSyncCalls = 0;
    window.__deleteWeekCalls = 0;
    const originalPersist = persist;
    const originalSyncEntries = syncEntries;
    const originalRenderWeek = renderWeek;
    window.__restoreDeleteFns = () => {
      persist = originalPersist;
      syncEntries = originalSyncEntries;
      renderWeek = originalRenderWeek;
    };
    persist = () => { window.__deletePersistCalls += 1; };
    syncEntries = () => {
      window.__deleteSyncCalls += 1;
      return Promise.resolve(true);
    };
    renderWeek = () => { window.__deleteWeekCalls += 1; };

    deleteEntry('fast-delete');

    return {
      listText: document.getElementById('recent-list').textContent,
      timelineText: document.getElementById('timeline-blocks').textContent,
      deleted: entries.find(e => e.id === 'fast-delete')?.deleted,
      persistCalls: window.__deletePersistCalls,
      syncCalls: window.__deleteSyncCalls,
      weekCalls: window.__deleteWeekCalls
    };
  });

  expect(result.deleted).toBe(true);
  expect(result.listText).not.toContain('Delete responsiveness check');
  expect(result.timelineText).not.toContain('Delete responsiveness check');
  expect(result.persistCalls).toBe(0);
  expect(result.syncCalls).toBe(0);
  expect(result.weekCalls).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__deletePersistCalls)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__deleteSyncCalls)).toBe(1);
  await page.evaluate(() => window.__restoreDeleteFns());
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

  await expect(page.locator('#th-wallet')).toHaveText('17 pts');
  await page.locator('#th-wallet').click();
  await page.locator('#fw-reward-label').fill('Movie smoke');
  await page.locator('#fw-reward-duration').fill('30');
  await page.locator('#fw-reward-points').fill('10');
  await page.getByRole('button', { name: 'Log reward' }).click();

  await expect(page.locator('#th-wallet')).toHaveText('7 pts');
  await clickToastUndo(page);
  await expect(page.locator('#th-wallet')).toHaveText('17 pts');
  await openTodayDetails(page);
  await expect(page.locator('#recent-list')).not.toContainText('Movie smoke');
});

test('sync event text wraps on narrow screens without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);

  await page.evaluate(() => {
    document.getElementById('auth-signed-in').style.display = 'block';
    showView('settings');
    recordSyncEvent('timer', {
      updatedAt: Date.now() - 65000,
      updatedBy: 'phone-device',
      ownerDeviceId: 'phone-device',
      deviceName: 'very-long-phone-device-name-that-should-wrap'
    }, 'active: Cooking with a deliberately long synced task label');
  });

  await expect(page.locator('#sync-event-log')).toBeVisible();
  await expect(page.locator('.sync-event-main').first()).toContainText('Cooking');
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    metaWhiteSpace: getComputedStyle(document.querySelector('.sync-event-meta')).whiteSpace
  }));
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.metaWhiteSpace).toBe('normal');
});

test('today defaults to clean mode and can reveal details', async ({ page }) => {
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

  await expect(page.locator('#today-details-toggle')).toHaveText('Details');
  await expect(page.locator('#today-details-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#daily-basics')).toBeVisible();
  await expect(page.locator('.quick-retro-bar')).toBeHidden();
  await expect(page.locator('#timeline-section')).toBeHidden();
  await expect(page.locator('#focus-wallet-card')).toBeHidden();
  await expect(page.locator('#recent-entries-section')).toBeHidden();

  await page.locator('#today-details-toggle').click();
  await expect(page.locator('#today-details-toggle')).toHaveText('Clean');
  await expect(page.locator('#today-details-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.quick-retro-bar')).toBeVisible();
  await expect(page.locator('#timeline-section')).toBeVisible();
  await expect(page.locator('#focus-wallet-card')).toBeVisible();
  await expect(page.locator('#recent-entries-section')).toBeVisible();

  await page.locator('#today-details-toggle').click();
  await expect(page.locator('.quick-retro-bar')).toBeHidden();
  await expect(page.locator('#timeline-section')).toBeHidden();
  await expect(page.locator('#focus-wallet-card')).toBeHidden();
  await expect(page.locator('#recent-entries-section')).toBeHidden();
});

test('today daily basics logs common mandatory activity from clean mode', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 10, 12, 0, 0);
  await openApp(page, { nowTs });

  await expect(page.locator('#daily-basics')).toBeVisible();
  await expect(page.locator('#daily-basics')).not.toContainText('Chores');
  await expect(page.locator('#daily-basics')).not.toContainText('Errand');
  await expect(page.locator('#daily-basics')).toContainText('Cooking');
  await expect(page.locator('#daily-basics')).toContainText('Dishes');
  await expect(page.locator('#daily-basics')).toContainText('Hygiene');
  await expect(page.locator('.quick-retro-bar')).toBeHidden();
  await page.locator('#daily-basics').getByRole('button', { name: /Eat/ }).click();

  const saved = await page.evaluate(() => {
    const entry = entries.find(e => e.commonLogged && e.activity === 'Eat');
    return entry && {
      activity: entry.activity,
      energy: entry.energy,
      minutes: entry.blockIntervalMin,
      category: entry.category,
      retro: entry.retro
    };
  });
  expect(saved).toEqual({
    activity: 'Eat',
    energy: 'recovery',
    minutes: 30,
    category: 'recovery',
    retro: true
  });
});

test('today sleep basic logs overnight sleep as recovery', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 10, 12, 0, 0);
  await openApp(page, { nowTs });

  await page.locator('#daily-basics').getByRole('button', { name: /Sleep/ }).click();

  const saved = await page.evaluate(() => {
    const entry = entries.find(e => e.activity === 'Sleep');
    return entry && {
      activity: entry.activity,
      energy: entry.energy,
      minutes: entry.blockIntervalMin,
      start: new Date(entry.tsStart).toISOString(),
      end: new Date(entry.ts).toISOString()
    };
  });
  expect(saved).toEqual({
    activity: 'Sleep',
    energy: 'recovery',
    minutes: 480,
    start: '2026-07-09T23:00:00.000Z',
    end: '2026-07-10T07:00:00.000Z'
  });
});

test('today routine prompt logs the current meal window', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 10, 12, 15, 0);
  await openApp(page, { nowTs });

  await expect(page.locator('#routine-prompt')).toBeVisible();
  await expect(page.locator('#routine-prompt')).toContainText('Lunch check');
  await page.locator('#routine-prompt').getByRole('button', { name: /Eat/ }).click();

  const saved = await page.evaluate(() => {
    const entry = entries.find(e => e.routinePrompt === 'lunch' && e.activity === 'Eat');
    const dismissed = JSON.parse(localStorage.getItem('ta3-routine-dismissed-2026-07-10') || '[]');
    return entry && {
      activity: entry.activity,
      energy: entry.energy,
      minutes: entry.blockIntervalMin,
      category: entry.category,
      commonLogged: entry.commonLogged,
      routinePrompt: entry.routinePrompt,
      dismissed
    };
  });
  expect(saved).toEqual({
    activity: 'Eat',
    energy: 'recovery',
    minutes: 30,
    category: 'recovery',
    commonLogged: true,
    routinePrompt: 'lunch',
    dismissed: ['lunch']
  });
  await expect(page.locator('#routine-prompt')).toBeHidden();
});

test('today routine prompt stays quiet when the routine was already logged', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 10, 12, 45, 0);
  const eatStart = Date.UTC(2026, 6, 10, 12, 0, 0);
  const eatEnd = Date.UTC(2026, 6, 10, 12, 30, 0);
  const entries = [{
    id: eatEnd,
    ts: eatEnd,
    tsStart: eatStart,
    updatedAt: eatEnd,
    blockIntervalMin: 30,
    date: utcDateKey(eatStart),
    activity: 'Eat',
    energy: 'recovery',
    category: 'recovery',
    originalLabel: 'recovery',
    onPlan: false,
    retro: true
  }];
  await openApp(page, { entries, nowTs });

  await expect(page.locator('#routine-prompt')).toBeHidden();
});

test('today gap recovery fills a missing block from clean mode', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 10, 10, 45, 0);
  const deepStart = Date.UTC(2026, 6, 10, 9, 0, 0);
  const deepEnd = Date.UTC(2026, 6, 10, 10, 0, 0);
  const entries = [{
    id: deepEnd,
    ts: deepEnd,
    tsStart: deepStart,
    updatedAt: deepEnd,
    blockIntervalMin: 60,
    date: utcDateKey(deepStart),
    activity: 'Deep block',
    energy: 'deep',
    category: 'deep_work',
    originalLabel: 'deep',
    onPlan: true,
    retro: false
  }];
  await openApp(page, { entries, nowTs, settings: { wakeTime: '09:00' } });

  await expect(page.locator('#gap-recovery')).toBeVisible();
  await expect(page.locator('#gap-recovery')).toContainText('10:00 AM - 10:45 AM');
  await expect(page.locator('#gap-recovery')).toContainText('45m');
  await expect(page.locator('.quick-retro-bar')).toBeHidden();

  await page.locator('#gap-recovery').getByRole('button', { name: 'Cooking' }).click();

  const saved = await page.evaluate(() => {
    const entry = entries.find(e => e.gapRecovered && e.activity === 'Cooking');
    return entry && {
      activity: entry.activity,
      energy: entry.energy,
      minutes: entry.blockIntervalMin,
      category: entry.category,
      start: new Date(entry.tsStart).toISOString(),
      end: new Date(entry.ts).toISOString()
    };
  });
  expect(saved).toEqual({
    activity: 'Cooking',
    energy: 'recovery',
    minutes: 45,
    category: 'recovery',
    start: '2026-07-10T10:00:00.000Z',
    end: '2026-07-10T10:45:00.000Z'
  });
  await expect(page.locator('#gap-recovery')).toBeHidden();
});

test('today gap recovery other opens prefilled retro log', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 10, 10, 45, 0);
  const deepStart = Date.UTC(2026, 6, 10, 9, 0, 0);
  const deepEnd = Date.UTC(2026, 6, 10, 10, 0, 0);
  const entries = [{
    id: deepEnd,
    ts: deepEnd,
    tsStart: deepStart,
    updatedAt: deepEnd,
    blockIntervalMin: 60,
    date: utcDateKey(deepStart),
    activity: 'Deep block',
    energy: 'deep',
    category: 'deep_work',
    originalLabel: 'deep',
    onPlan: true,
    retro: false
  }];
  await openApp(page, { entries, nowTs, settings: { wakeTime: '09:00' } });

  await page.locator('#gap-recovery').getByRole('button', { name: 'Other' }).click();

  await expect(page.locator('#retro-overlay')).toBeVisible();
  await expect(page.locator('#retro-start')).toHaveValue('10:00');
  await expect(page.locator('#retro-end')).toHaveValue('10:45');
});

test('today long labels wrap on phone width without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);

  await page.evaluate(async () => {
    const longTask = 'Very long focus task name that should wrap calmly instead of stretching the Today tab sideways';
    savePlanItems(planTodayKey(), [createPlanItem(longTask, 'this morning after the first coffee')]);
    renderToday();
    await _startTimer(longTask);
  });

  await expect(page.locator('#hero-task-name')).toContainText('Very long focus task name');
  await expect(page.locator('.plan-task')).toContainText('Very long focus task name');
  await expect(page.locator('#today-action-title')).toBeVisible();

  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    heroWhiteSpace: getComputedStyle(document.getElementById('hero-task-name')).whiteSpace,
    actionWhiteSpace: getComputedStyle(document.getElementById('today-action-title')).whiteSpace
  }));
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.heroWhiteSpace).toBe('normal');
  expect(layout.actionWhiteSpace).toBe('normal');
});

test('today compact cards use readable UI text instead of the display font', async ({ page }) => {
  await openApp(page);

  await page.evaluate(() => {
    document.getElementById('today-action-strip').style.display = 'flex';
    document.getElementById('missed-closeout-card').style.display = 'flex';
  });

  const fonts = await page.evaluate(() => ({
    action: getComputedStyle(document.getElementById('today-action-strip')).fontFamily,
    actionButton: getComputedStyle(document.getElementById('today-action-primary')).fontFamily,
    health: getComputedStyle(document.getElementById('today-health')).fontFamily,
    dailyBasics: getComputedStyle(document.getElementById('daily-basics')).fontFamily,
    dailyBasicsButton: getComputedStyle(document.querySelector('#daily-basics .daily-basic-btn')).fontFamily,
    closeout: getComputedStyle(document.getElementById('missed-closeout-card')).fontFamily,
    closeoutAction: getComputedStyle(document.querySelector('#missed-closeout-card .closeout-action')).fontFamily
  }));
  Object.values(fonts).forEach(fontFamily => {
    expect(fontFamily).toContain('Segoe UI');
    expect(fontFamily).not.toContain('Syne');
  });
});

test('today health shows compact daily accounting', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 10, 12, 0, 0);
  const todayStart = Date.UTC(2026, 6, 10);
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
  await openApp(page, { entries, nowTs });

  await expect(page.locator('#today-health')).toContainText('Today health');
  await expect(page.locator('#th-deep')).toHaveText('1h deep');
  await expect(page.locator('#th-waste')).toHaveText('20m waste');
  await expect(page.locator('#th-wallet')).toHaveText('15 pts');
  await expect(page.locator('#th-unlogged')).toContainText('unlogged');

  await page.locator('#th-unlogged').click();
  await expect(page.locator('#today-details-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#timeline-section')).toBeVisible();
  await expect(page.locator('#timeline-blocks')).toBeInViewport({ ratio: 0.1 });

  await page.locator('#today-health').scrollIntoViewIfNeeded();
  await page.locator('#th-waste').click();
  const wasteRow = page.locator('#timeline-blocks .tl-row[data-energy="waste"]').first();
  await expect(wasteRow).toBeInViewport({ ratio: 0.1 });
  await expect(wasteRow).toHaveClass(/tl-row-focus/);
});

test('today health hides minor unlogged gaps', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 10, 10, 20, 0);
  const todayStart = Date.UTC(2026, 6, 10);
  const deepStart = todayStart + 10 * 60 * 60 * 1000;
  const deepEnd = deepStart + 10 * 60 * 1000;
  const entries = [{
    id: deepEnd,
    ts: deepEnd,
    tsStart: deepStart,
    updatedAt: deepEnd,
    blockIntervalMin: 10,
    date: utcDateKey(deepStart),
    activity: 'Short focus',
    energy: 'deep',
    category: 'deep_work',
    originalLabel: 'deep',
    onPlan: true,
    retro: false
  }];
  await openApp(page, { entries, nowTs });

  await expect(page.locator('#th-deep')).toHaveText('10m deep');
  await expect(page.locator('#th-unlogged')).toBeHidden();
});

test('weekly schedule auto-logs fixed blocks after they end', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 9, 0, 0);
  await openApp(page, {
    nowTs,
    settings: {
      templates: [{
        id: 'scribe',
        activity: 'Scribe shift',
        energy: 'nine5',
        days: [3],
        startTime: '00:00',
        endTime: '08:00',
        autoLog: true,
        enabled: true
      }]
    }
  });

  const saved = await page.evaluate(() => {
    const entry = entries.find(e => e.id === 'tpllog_scribe_2026-07-15');
    return entry && {
      activity: entry.activity,
      energy: entry.energy,
      minutes: entry.blockIntervalMin,
      category: entry.category,
      autoLogged: entry.autoLogged,
      scheduledAutoLog: entry.scheduledAutoLog,
      start: new Date(entry.tsStart).toISOString(),
      end: new Date(entry.ts).toISOString()
    };
  });
  expect(saved).toEqual({
    activity: 'Scribe shift',
    energy: 'nine5',
    minutes: 480,
    category: 'nine5',
    autoLogged: true,
    scheduledAutoLog: true,
    start: '2026-07-15T00:00:00.000Z',
    end: '2026-07-15T08:00:00.000Z'
  });
  await expect(page.locator('#recent-list')).toContainText('Scribe shift');
});

test('editing an auto-logged schedule can update the recurring template', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 9, 0, 0);
  await openApp(page, {
    nowTs,
    settings: {
      templates: [{
        id: 'scribe',
        activity: 'Scribe shift',
        energy: 'nine5',
        days: [3],
        startTime: '00:00',
        endTime: '08:00',
        autoLog: true,
        enabled: true
      }]
    }
  });

  await openTodayDetails(page);
  const row = page.locator('#recent-list .entry-row').filter({ hasText: 'Scribe shift' }).first();
  await row.locator('button[onclick*="openEditEntry"]').click();
  await expect(page.locator('#retro-overlay')).toBeVisible();
  await expect(page.locator('#retro-activity')).toHaveValue('Scribe shift');
  await page.locator('#retro-start').fill('01:00');
  await page.locator('#retro-end').fill('09:00');
  await page.locator('#retro-activity').fill('Scribe shift');
  await expect(page.locator('#retro-activity')).toHaveValue('Scribe shift');
  await page.locator('#retro-overlay').getByRole('button', { name: 'Save' }).click();

  const toast = page.locator('#toast');
  await expect(toast).toContainText('Update recurring schedule too?');
  await toast.getByRole('button', { name: 'Update schedule' }).click();

  const template = await page.evaluate(() => settings.templates[0]);
  expect(template).toMatchObject({
    id: 'scribe',
    activity: 'Scribe shift',
    energy: 'nine5',
    days: [3],
    startTime: '01:00',
    endTime: '09:00',
    autoLog: true,
    enabled: true
  });
});

test('scheduled blocks can be marked off today before auto-log', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 7, 0, 0);
  await openApp(page, {
    nowTs,
    settings: {
      templates: [{
        id: 'scribe',
        activity: 'Scribe shift',
        energy: 'nine5',
        days: [3],
        startTime: '00:00',
        endTime: '08:00',
        autoLog: true,
        enabled: true
      }]
    }
  });

  await openTodayDetails(page);
  await expect(page.locator('#timeline-blocks')).toContainText('Scribe shift');
  await page.locator('#timeline-blocks .template-off-btn').click();
  await expect(page.locator('#timeline-blocks')).not.toContainText('Scribe shift');

  const result = await page.evaluate(() => {
    Date.now = () => Date.UTC(2026, 6, 15, 9, 0, 0);
    return {
      created: autoLogDueTemplates({ notify: false }),
      liveCount: entries.filter(e => !e.deleted && e.activity === 'Scribe shift').length,
      skipDates: settings.templates[0].skipDates
    };
  });

  expect(result).toEqual({
    created: false,
    liveCount: 0,
    skipDates: ['2026-07-15']
  });
});

test('schedule-matched pocket logs show the shift as context without splitting it', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 9, 0, 0);
  const shiftStart = Date.UTC(2026, 6, 15, 0, 0, 0);
  const firstDetailStart = Date.UTC(2026, 6, 15, 0, 45, 0);
  const firstDetailEnd = Date.UTC(2026, 6, 15, 0, 47, 0);
  const secondDetailStart = Date.UTC(2026, 6, 15, 1, 25, 0);
  const secondDetailEnd = Date.UTC(2026, 6, 15, 1, 33, 0);
  const shiftEnd = Date.UTC(2026, 6, 15, 8, 0, 0);
  const entries = [
    {
      id: 'tpllog_scribe_2026-07-15',
      ts: shiftEnd,
      tsStart: shiftStart,
      updatedAt: shiftEnd,
      blockIntervalMin: 480,
      date: utcDateKey(shiftStart),
      activity: 'Scribe shift',
      energy: 'nine5',
      category: 'nine5',
      onPlan: true,
      retro: false
    },
    {
      id: 'detail-a',
      ts: firstDetailEnd,
      tsStart: firstDetailStart,
      updatedAt: firstDetailEnd,
      blockIntervalMin: 2,
      date: utcDateKey(firstDetailStart),
      activity: 'App building',
      energy: 'deep',
      onPlan: true,
      retro: true
    },
    {
      id: 'detail-b',
      ts: secondDetailEnd,
      tsStart: secondDetailStart,
      updatedAt: secondDetailEnd,
      blockIntervalMin: 8,
      date: utcDateKey(secondDetailStart),
      activity: 'App building',
      energy: 'deep',
      onPlan: true,
      retro: true
    }
  ];
  await openApp(page, {
    entries,
    nowTs,
    settings: {
      templates: [{
        id: 'scribe',
        activity: 'Scribe shift',
        energy: 'nine5',
        days: [3],
        startTime: '00:00',
        endTime: '08:00',
        autoLog: true,
        enabled: true
      }]
    }
  });
  await openTodayDetails(page);

  const timeline = page.locator('#timeline-blocks');
  const activityLabels = await timeline.locator('.tl-row .tl-activity').allTextContents();
  expect(activityLabels.filter(text => text.includes('Scribe shift'))).toHaveLength(1);
  await expect(timeline.locator('.tl-row').filter({ hasText: 'App building' }).first()).toContainText('during Scribe shift');
  await expect(timeline).not.toContainText('12:47 AM – 1:25 AM · 38m');
  await expect(timeline.locator('.tl-untracked-row').filter({ hasText: '12:47 AM' })).toHaveCount(0);
});

test('long non-job coverage blocks are not split by the legacy fallback', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 10, 0, 0);
  const sleepStart = Date.UTC(2026, 6, 15, 0, 0, 0);
  const detailStart = Date.UTC(2026, 6, 15, 1, 0, 0);
  const detailEnd = Date.UTC(2026, 6, 15, 1, 10, 0);
  const sleepEnd = Date.UTC(2026, 6, 15, 8, 0, 0);
  await openApp(page, {
    entries: [
      {
        id: 'sleep-coverage',
        ts: sleepEnd,
        tsStart: sleepStart,
        updatedAt: sleepEnd,
        blockIntervalMin: 480,
        date: utcDateKey(sleepStart),
        activity: 'Sleep',
        energy: 'recovery',
        category: 'recovery',
        onPlan: true,
        retro: true
      },
      {
        id: 'sleep-detail',
        ts: detailEnd,
        tsStart: detailStart,
        updatedAt: detailEnd,
        blockIntervalMin: 10,
        date: utcDateKey(detailStart),
        activity: 'Phone',
        energy: 'waste',
        onPlan: false,
        retro: true
      }
    ],
    nowTs
  });
  await openTodayDetails(page);

  const timeline = page.locator('#timeline-blocks');
  await expect(timeline.locator('.tl-row').filter({ hasText: 'Sleep' })).toHaveCount(1);
  await expect(timeline.locator('.tl-row').filter({ hasText: 'Phone' })).not.toContainText('during Sleep');
  await expect(timeline).not.toContainText('12:00 AM – 1:00 AM');
});

test('day dropdown adds a chosen task to the selected weekday', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 12, 0, 0);
  await openApp(page, {
    nowTs,
    settings: {
      sleepTime: '02:00',
      wakeTime: '10:00'
    }
  });

  await page.evaluate(() => showView('settings'));
  await page.selectOption('#day-template-select', '6');
  const panel = page.locator('#day-template-panel');
  await expect(panel).toContainText('No blocks yet for Saturday');
  await expect(page.locator('#template-form-card')).toBeHidden();
  await expect(page.locator('#template-form-overlay')).not.toHaveClass(/open/);
  await expect(page.locator('#template-list')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add missing basics' })).toHaveCount(0);
  await page.getByRole('button', { name: '+ Block' }).click();
  await expect(page.locator('#template-form-card')).toBeVisible();
  await expect(page.locator('#template-form-overlay')).toHaveClass(/open/);
  await page.selectOption('#tpl-task-choice', 'sleep');
  await expect(page.locator('#tpl-activity')).toHaveValue('Sleep');
  await expect(page.locator('#tpl-energy')).toHaveValue('recovery');
  await expect(page.locator('#tpl-start')).toHaveValue('02:00');
  await expect(page.locator('#tpl-end')).toHaveValue('10:00');
  await page.locator('#template-form-card').getByRole('button', { name: '+ Add recurring block' }).click();

  const templates = await page.evaluate(() => settings.templates.map(t => ({
    id: t.id,
    activity: t.activity,
    energy: t.energy,
    days: t.days,
    startTime: t.startTime,
    endTime: t.endTime,
    autoLog: t.autoLog,
    skeleton: t.skeleton
  })));

  expect(templates).toHaveLength(1);
  expect(templates.map(t => t.activity)).toEqual(['Sleep']);
  expect(templates.every(t => t.days.length === 1 && t.days[0] === 6)).toBe(true);
  expect(templates[0]).toEqual(expect.objectContaining({
    activity: 'Sleep',
    energy: 'recovery',
    startTime: '02:00',
    endTime: '10:00',
    autoLog: false
  }));
  await expect(panel).toContainText('Sleep');
  await expect(panel).toContainText('02:00-10:00');
  await expect(panel.getByRole('button', { name: 'Edit Sleep' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Delete Sleep' })).toBeVisible();
  await expect(page.locator('#template-form-card')).toBeHidden();
  await expect(page.locator('#template-form-overlay')).not.toHaveClass(/open/);
  await page.selectOption('#day-template-select', '1');
  await expect(panel).toContainText('No blocks yet for Monday');
  await page.evaluate(() => {
    settings.templates[0].startTime = '09:00';
    settings.templates[0].endTime = '17:00';
    settings.templates.push({
      id: 'hygiene',
      activity: 'Hygiene',
      energy: 'recovery',
      days: [6],
      startTime: '08:30',
      endTime: '08:50',
      autoLog: false,
      enabled: true
    });
    settings.templates.push({
      id: 'long-label',
      activity: 'Check smmncourse and follow the system',
      energy: 'deep',
      days: [5],
      startTime: '22:00',
      endTime: '23:00',
      autoLog: false,
      enabled: true
    });
    renderTemplateList();
  });
  await page.locator('.template-advanced summary').click();
  const calendar = page.locator('.template-cal');
  await expect(calendar).toBeVisible();
  await expect(calendar.locator('.template-cal-head div')).toHaveText(['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  await expect(calendar.locator('.template-cal-time')).toHaveText([
    '12 AM', '1 AM', '2 AM', '3 AM', '4 AM', '5 AM', '6 AM', '7 AM',
    '8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM',
    '4 PM', '5 PM', '6 PM', '7 PM', '8 PM', '9 PM', '10 PM', '11 PM'
  ]);
  const satDay = calendar.locator('.template-cal-day[data-day="6"]');
  const friDay = calendar.locator('.template-cal-day[data-day="5"]');
  const tueDay = calendar.locator('.template-cal-day[data-day="2"]');
  const satSleep = satDay.locator('.template-cal-event').filter({ hasText: 'Sleep' });
  const satHygiene = satDay.locator('.template-cal-event').filter({ hasText: 'Hygiene' });
  const friLongEvent = friDay.locator('.template-cal-event').filter({ hasText: 'Check smmncourse and follow the system' });
  await expect(satSleep).toContainText('09:00-17:00');
  await expect(satHygiene).toContainText('08:30-08:50');
  await expect(friLongEvent).toContainText('22:00-23:00');
  const [dayHeight, sleepHeight, hygieneEventHeight, hygieneCardHeight] = await Promise.all([
    satDay.evaluate(el => el.getBoundingClientRect().height),
    satSleep.evaluate(el => el.getBoundingClientRect().height),
    satHygiene.evaluate(el => el.getBoundingClientRect().height),
    satHygiene.locator('.template-cal-event-card').evaluate(el => el.getBoundingClientRect().height)
  ]);
  expect(dayHeight).toBeGreaterThan(1400);
  expect(sleepHeight).toBeGreaterThan(450);
  expect(hygieneCardHeight).toBeGreaterThan(hygieneEventHeight);
  await expect(satHygiene.locator('.template-cal-event-card')).toHaveCSS('overflow', 'visible');
  const [friWidth, tueWidth] = await Promise.all([
    friDay.evaluate(el => el.getBoundingClientRect().width),
    tueDay.evaluate(el => el.getBoundingClientRect().width)
  ]);
  expect(friWidth).toBeGreaterThan(tueWidth);
  await expect(friLongEvent.locator('.template-cal-event-title')).toHaveCSS('white-space', 'normal');
  await expect(calendar.locator('.template-cal-day[data-day="1"] .template-cal-slot')).toHaveCount(48);
  const monTwoSlot = page.getByRole('button', { name: 'Add Mon 02:00' });
  const monTwoThirtySlot = page.getByRole('button', { name: 'Add Mon 02:30' });
  await expect(monTwoSlot).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await monTwoSlot.hover();
  await expect(monTwoSlot).toHaveCSS('background-color', 'rgba(76, 199, 240, 0.1)');
  await expect(monTwoThirtySlot).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(calendar.locator('button[aria-label="Edit Sleep"]')).toHaveCount(0);
  const deleteSleep = satSleep.locator('.template-cal-delete');
  await expect(deleteSleep).toHaveCSS('opacity', '0');
  await satSleep.hover();
  await expect(deleteSleep).toHaveCSS('opacity', '1');
  await satSleep.click({ position: { x: 12, y: 12 } });
  await expect(page.locator('#template-form-card')).toBeVisible();
  await expect(page.locator('#template-form-overlay')).toHaveClass(/open/);
  await expect(page.locator('#tpl-form-title')).toHaveText('Edit recurring block');
  await page.locator('#template-form-card').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#template-form-card')).toBeHidden();
  await expect(page.locator('#template-form-overlay')).not.toHaveClass(/open/);
  await expect(calendar.locator('.template-cal-day[data-day="1"] .template-cal-event').filter({ hasText: 'Sleep' })).toHaveCount(0);

  await page.locator('.template-cal-wrap').evaluate(el => { el.scrollTop = 0; });
  await monTwoSlot.click();
  await expect(page.locator('#template-form-card')).toBeVisible();
  await expect(page.locator('#template-form-overlay')).toHaveClass(/open/);
  await expect(page.locator('#tpl-start')).toHaveValue('02:00');
  await expect(page.locator('#tpl-end')).toHaveValue('02:30');
  const clickedDays = await page.evaluate(() =>
    [...document.querySelectorAll('#tpl-day-picker .tpl-day-btn.on')].map(btn => parseInt(btn.dataset.day))
  );
  expect(clickedDays).toEqual([1]);
  await page.locator('#template-form-card').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#template-form-card')).toBeHidden();

  await page.setViewportSize({ width: 390, height: 900 });
  const mobileScroll = await page.locator('.template-cal-wrap').evaluate(el => ({
    internalScroll: el.scrollWidth > el.clientWidth,
    pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  }));
  expect(mobileScroll).toEqual({ internalScroll: true, pageFits: true });
});

test('day dropdown preselects one day and lets a block repeat on checked days', async ({ page }) => {
  await openApp(page, {
    settings: {
      sleepTime: '23:00',
      wakeTime: '07:00'
    }
  });

  await page.evaluate(() => showView('settings'));
  await page.selectOption('#day-template-select', '6');
  await expect(page.locator('#template-form-card')).toBeHidden();
  await page.getByRole('button', { name: '+ Block' }).click();
  await expect(page.locator('#template-form-card')).toBeVisible();
  await expect(page.locator('#template-form-overlay')).toHaveClass(/open/);
  const initiallySelectedDays = await page.evaluate(() =>
    [...document.querySelectorAll('#tpl-day-picker .tpl-day-btn.on')].map(btn => parseInt(btn.dataset.day))
  );
  expect(initiallySelectedDays).toEqual([6]);

  await page.selectOption('#tpl-task-choice', 'breakfast');
  await expect(page.locator('#tpl-activity')).toHaveValue('Breakfast');
  await expect(page.locator('#tpl-start')).toHaveValue('08:00');
  await expect(page.locator('#tpl-end')).toHaveValue('08:30');
  await page.locator('#tpl-day-picker .tpl-day-btn[data-day="1"]').click();
  await page.locator('#template-form-card').getByRole('button', { name: '+ Add recurring block' }).click();

  const templates = await page.evaluate(() => settings.templates.map(t => ({
    id: t.id,
    activity: t.activity,
    days: t.days,
    startTime: t.startTime,
    endTime: t.endTime
  })));

  expect(templates).toHaveLength(1);
  expect(templates[0]).toEqual(expect.objectContaining({
    activity: 'Breakfast',
    days: [1, 6],
    startTime: '08:00',
    endTime: '08:30'
  }));
  expect(new Set(templates.map(t => t.id)).size).toBe(1);

  const panel = page.locator('#day-template-panel');
  await expect(panel).toContainText('Breakfast');
  await page.selectOption('#day-template-select', '1');
  await expect(panel).toContainText('Breakfast');
  await page.selectOption('#day-template-select', '2');
  await expect(panel).toContainText('No blocks yet for Tuesday');
});

test('day dropdown shows existing recurring blocks for the selected weekday', async ({ page }) => {
  await openApp(page, {
    settings: {
      templates: [{
        id: 'scribe',
        activity: 'Scribe shift',
        energy: 'nine5',
        days: [6],
        startTime: '22:00',
        endTime: '08:00',
        autoLog: true,
        enabled: true
      }]
    }
  });

  await page.evaluate(() => showView('settings'));
  const panel = page.locator('#day-template-panel');
  await page.selectOption('#day-template-select', '6');
  await expect(panel).toContainText('Scribe shift');
  await expect(panel).toContainText('22:00-08:00');
  await expect(panel).toContainText('auto-log');
  await panel.getByRole('button', { name: 'Edit Scribe shift' }).click();
  await expect(page.locator('#template-form-card')).toBeVisible();
  await expect(page.locator('#template-form-overlay')).toHaveClass(/open/);
  await expect(page.locator('#tpl-form-title')).toHaveText('Edit recurring block');
  await expect(page.locator('#tpl-task-choice')).toHaveValue('custom');
  await expect(page.locator('#tpl-activity')).toHaveValue('Scribe shift');
  await page.locator('#template-form-card').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#template-form-card')).toBeHidden();
  await expect(page.locator('#template-form-overlay')).not.toHaveClass(/open/);
  await page.locator('.template-advanced summary').click();
  const calendar = page.locator('.template-cal');
  await expect(calendar.locator('.template-cal-day[data-day="6"] .template-cal-event').filter({ hasText: 'Scribe shift' })).toContainText('22:00-08:00');
  await expect(calendar.locator('.template-cal-day[data-day="0"] .template-cal-event.continuation').filter({ hasText: 'Scribe shift cont.' })).toContainText('22:00-08:00');
  await panel.getByRole('button', { name: 'Delete Scribe shift' }).click();
  await expect(panel).toContainText('No blocks yet for Saturday');
  expect(await page.evaluate(() => settings.templates.length)).toBe(0);
  await page.selectOption('#day-template-select', '1');
  await expect(panel).toContainText('No blocks yet for Monday');
});

test('mobile normalizes synced recurring templates for settings and today hints', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const nowTs = Date.UTC(2026, 6, 15, 12, 0, 0);
  await openApp(page, {
    nowTs,
    settings: {
      _savedAt: 10,
      _templatesSavedAt: 10,
      templates: {
        0: {
          id: 'lunch',
          activity: 'Lunch',
          energy: 'recovery',
          days: { 0: 3 },
          startTime: '13:00',
          endTime: '13:30',
          autoLog: false,
          enabled: true,
          skipDates: {}
        }
      }
    }
  });

  const normalized = await page.evaluate(() => ({
    isArray: Array.isArray(settings.templates),
    days: settings.templates[0]?.days
  }));
  expect(normalized).toEqual({ isArray: true, days: [3] });

  await page.evaluate(() => showView('settings'));
  await expect(page.locator('#view-settings')).toContainText('Day Templates');
  await expect(page.locator('#day-template-select')).toBeVisible();
  await page.selectOption('#day-template-select', '3');
  await expect(page.locator('#day-template-panel')).toContainText('Lunch');
  const mobileSkeleton = page.locator('.day-template-mobile-skeleton');
  await expect(mobileSkeleton).toBeVisible();
  await expect(mobileSkeleton.locator('.day-template-mobile-event')).toContainText('Lunch');
  await expect(mobileSkeleton).toContainText('13:00-13:30');
  const mobileSkeletonFits = await mobileSkeleton.evaluate(el => ({
    width: el.getBoundingClientRect().width,
    pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  }));
  expect(mobileSkeletonFits.width).toBeLessThanOrEqual(358);
  expect(mobileSkeletonFits.pageFits).toBe(true);
  await page.locator('.template-advanced summary').click();
  await expect(page.locator('.template-cal-day[data-day="3"] .template-cal-event').filter({ hasText: 'Lunch' })).toContainText('13:00-13:30');

  await page.evaluate(() => showView('today'));
  await openTodayDetails(page);
  const row = page.locator('#timeline-blocks .tl-template-row').filter({ hasText: 'Lunch' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('template hint');
});

test('mobile shows empty day skeleton and advanced grid before templates exist', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, {
    settings: {
      templates: []
    }
  });

  await page.evaluate(() => showView('settings'));
  await page.selectOption('#day-template-select', '3');

  const panel = page.locator('#day-template-panel');
  await expect(panel).toContainText('No blocks yet for Wednesday');
  const mobileSkeleton = panel.locator('.day-template-mobile-skeleton');
  await expect(mobileSkeleton).toBeVisible();
  await expect(mobileSkeleton.locator('.day-template-mobile-time')).toHaveCount(24);
  await expect(mobileSkeleton.locator('.day-template-mobile-event')).toHaveCount(0);

  await page.locator('.template-advanced summary').click();
  const calendar = page.locator('.template-cal');
  await expect(calendar).toBeVisible();
  await expect(calendar.locator('.template-cal-day')).toHaveCount(7);
  await expect(calendar.locator('.template-cal-day[data-day="3"] .template-cal-slot')).toHaveCount(48);
  await expect(page.getByRole('button', { name: 'Add Wed 09:00' })).toBeVisible();
});

test('settings sync preserves and pushes newer local recurring templates', async ({ page }) => {
  await openApp(page, {
    settings: {
      _savedAt: 100,
      _templatesSavedAt: 500,
      templates: [{
        id: 'local-lunch',
        activity: 'Lunch',
        energy: 'recovery',
        days: [3],
        startTime: '13:00',
        endTime: '13:30',
        autoLog: false,
        enabled: true
      }]
    }
  });

  const result = await page.evaluate(async () => {
    const remoteSettings = {
      _savedAt: 800,
      _templatesSavedAt: 100,
      intervalMin: 45,
      templates: {}
    };
    const updates = [];
    roomCode = 'sync-test';
    fbRoomRef = {
      update(payload) {
        updates.push(payload);
        return Promise.resolve();
      }
    };
    fbDb = {
      ref(path) {
        return {
          once() {
            return Promise.resolve({ val: () => path.endsWith('/settings') ? remoteSettings : null });
          }
        };
      }
    };

    const changed = applyRemoteSettings(remoteSettings);
    await new Promise(resolve => setTimeout(resolve, 0));
    syncSettings();
    await new Promise(resolve => setTimeout(resolve, 0));

    return {
      changed,
      intervalMin: settings.intervalMin,
      templates: settings.templates.map(t => ({
        id: t.id,
        activity: t.activity,
        days: t.days,
        startTime: t.startTime,
        endTime: t.endTime
      })),
      updates
    };
  });

  expect(result.changed).toBe(true);
  expect(result.intervalMin).toBe(45);
  expect(result.templates).toEqual([{
    id: 'local-lunch',
    activity: 'Lunch',
    days: [3],
    startTime: '13:00',
    endTime: '13:30'
  }]);
  expect(result.updates).toContainEqual(expect.objectContaining({
    'settings/templates': expect.arrayContaining([expect.objectContaining({ id: 'local-lunch' })]),
    'settings/_templatesSavedAt': 500
  }));
});

test('recurring template mutations publish template sync paths', async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(async () => {
    showView('settings');
    const updates = [];
    fbRoomRef = {
      update(payload) {
        updates.push(payload);
        return Promise.resolve();
      }
    };
    document.getElementById('tpl-activity').value = 'Scribe shift';
    document.getElementById('tpl-energy').value = 'nine5';
    document.getElementById('tpl-start').value = '22:00';
    document.getElementById('tpl-end').value = '08:00';
    document.querySelectorAll('#tpl-day-picker .tpl-day-btn').forEach(btn =>
      btn.classList.toggle('on', parseInt(btn.dataset.day) === 1)
    );
    addTemplate();
    await new Promise(resolve => setTimeout(resolve, 100));
    return {
      templates: settings.templates.map(t => ({ activity: t.activity, days: t.days })),
      updates
    };
  });

  expect(result.templates).toEqual([{ activity: 'Scribe shift', days: [1] }]);
  expect(result.updates).toContainEqual(expect.objectContaining({
    'settings/templates': expect.arrayContaining([expect.objectContaining({ activity: 'Scribe shift' })]),
    'settings/_templatesSavedAt': expect.any(Number)
  }));
});

test('today template rows expose log and off actions without settings clutter', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 9, 0, 0);
  await openApp(page, {
    nowTs,
    settings: {
      templates: [{
        id: 'lunch',
        activity: 'Lunch',
        energy: 'recovery',
        days: [3],
        startTime: '11:00',
        endTime: '11:30',
        autoLog: false,
        enabled: true,
        skeleton: true
      }]
    }
  });

  await openTodayDetails(page);
  const row = page.locator('#timeline-blocks .tl-template-row').filter({ hasText: 'Lunch' });
  await expect(row.getByRole('button', { name: 'Log it' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Off today' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Edit' })).toHaveCount(0);

  await row.getByRole('button', { name: 'Log it' }).click();
  await expect(page.locator('#retro-overlay')).toBeVisible();
  await expect(page.locator('#retro-activity')).toHaveValue('Lunch');
  await expect(page.locator('#retro-start')).toHaveValue('11:00');
  await expect(page.locator('#retro-end')).toHaveValue('11:30');
  await page.locator('#retro-overlay').getByRole('button', { name: 'Cancel' }).click();

  await row.getByRole('button', { name: 'Off today' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('#timeline-blocks')).not.toContainText('Lunch');
});

test('day template form rejects duplicate recurring blocks on add and edit', async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(() => {
    showView('settings');
    settings.templates = [];
    renderTemplateList();

    const fillTemplateForm = (activity, energy, startTime, endTime, days) => {
      document.getElementById('tpl-activity').value = activity;
      document.getElementById('tpl-energy').value = energy;
      document.getElementById('tpl-start').value = startTime;
      document.getElementById('tpl-end').value = endTime;
      document.querySelectorAll('#tpl-day-picker .tpl-day-btn').forEach(btn =>
        btn.classList.toggle('on', days.includes(parseInt(btn.dataset.day)))
      );
    };

    fillTemplateForm('Scribe shift', 'nine5', '00:00', '08:00', [1]);
    addTemplate();
    fillTemplateForm('scribe shift', 'nine5', '00:00', '08:00', [1]);
    addTemplate();
    const afterDuplicateAdd = settings.templates.map(t => ({ activity: t.activity, days: t.days }));

    fillTemplateForm('Lunch', 'recovery', '12:00', '12:30', [1]);
    addTemplate();
    editTemplate(1);
    fillTemplateForm('SCRIBE SHIFT', 'deep', '00:00', '08:00', [1]);
    addTemplate();

    return {
      afterDuplicateAdd,
      templates: settings.templates.map(t => ({
        activity: t.activity,
        energy: t.energy,
        startTime: t.startTime,
        endTime: t.endTime,
        days: t.days
      })),
      editingIndex: _editingTplIdx
    };
  });

  expect(result.afterDuplicateAdd).toEqual([{ activity: 'Scribe shift', days: [1] }]);
  expect(result.templates).toEqual([
    { activity: 'Scribe shift', energy: 'nine5', startTime: '00:00', endTime: '08:00', days: [1] },
    { activity: 'Lunch', energy: 'recovery', startTime: '12:00', endTime: '12:30', days: [1] }
  ]);
  expect(result.editingIndex).toBe(1);
});

test('weekly schedule add and delete update the list before deferred refresh', async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(() => {
    showView('settings');
    window.__templatePersistCalls = 0;
    window.__templateRenderTodayCalls = 0;
    const originalPersist = persist;
    const originalRenderToday = renderToday;
    window.__restoreTemplateFns = () => {
      persist = originalPersist;
      renderToday = originalRenderToday;
    };
    persist = () => { window.__templatePersistCalls++; };
    renderToday = () => { window.__templateRenderTodayCalls++; };

    document.getElementById('tpl-activity').value = 'Fast block';
    document.getElementById('tpl-energy').value = 'deep';
    document.getElementById('tpl-start').value = '09:00';
    document.getElementById('tpl-end').value = '10:00';
    document.querySelector('#tpl-day-picker .tpl-day-btn[data-day="1"]').classList.add('on');
    addTemplate();
    const afterAdd = {
      listText: document.getElementById('template-list').textContent,
      persistCalls: window.__templatePersistCalls,
      renderTodayCalls: window.__templateRenderTodayCalls
    };

    removeTemplate(0);
    const afterDelete = {
      listText: document.getElementById('template-list').textContent,
      persistCalls: window.__templatePersistCalls,
      renderTodayCalls: window.__templateRenderTodayCalls
    };

    return { afterAdd, afterDelete };
  });

  expect(result.afterAdd.listText).toContain('Fast block');
  expect(result.afterAdd.persistCalls).toBe(0);
  expect(result.afterAdd.renderTodayCalls).toBe(0);
  expect(result.afterDelete.listText).not.toContain('Fast block');
  expect(result.afterDelete.persistCalls).toBe(0);
  expect(result.afterDelete.renderTodayCalls).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__templatePersistCalls)).toBe(2);
  await page.evaluate(() => window.__restoreTemplateFns());
});

test('weekly schedule auto-log respects a deleted day skip', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 9, 0, 0);
  await openApp(page, {
    nowTs,
    entries: [{
      id: 'tpllog_scribe_2026-07-15',
      ts: Date.UTC(2026, 6, 15, 8, 0, 0),
      tsStart: Date.UTC(2026, 6, 15, 0, 0, 0),
      updatedAt: Date.UTC(2026, 6, 15, 8, 30, 0),
      blockIntervalMin: 480,
      date: '2026-07-15',
      activity: 'Scribe shift',
      energy: 'nine5',
      category: 'nine5',
      deleted: true
    }],
    settings: {
      templates: [{
        id: 'scribe',
        activity: 'Scribe shift',
        energy: 'nine5',
        days: [3],
        startTime: '00:00',
        endTime: '08:00',
        autoLog: true,
        enabled: true
      }]
    }
  });

  const liveCount = await page.evaluate(() =>
    entries.filter(e => e.id === 'tpllog_scribe_2026-07-15' && !e.deleted).length
  );
  expect(liveCount).toBe(0);
  await expect(page.locator('#recent-list')).not.toContainText('Scribe shift');
});

test('week top activities merge activity labels that only differ by case', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 18, 0, 0);
  const sleepAStart = Date.UTC(2026, 6, 13, 0, 0, 0);
  const sleepAEnd = sleepAStart + 8 * 60 * 60 * 1000;
  const sleepBStart = Date.UTC(2026, 6, 14, 0, 0, 0);
  const sleepBEnd = sleepBStart + 2 * 60 * 60 * 1000;
  const scribeStart = Date.UTC(2026, 6, 15, 9, 0, 0);
  const scribeEnd = scribeStart + 3 * 60 * 60 * 1000;
  const entries = [
    {
      id: sleepAEnd,
      ts: sleepAEnd,
      tsStart: sleepAStart,
      updatedAt: sleepAEnd,
      blockIntervalMin: 480,
      date: utcDateKey(sleepAStart),
      activity: 'Sleep',
      energy: 'recovery',
      category: 'recovery'
    },
    {
      id: sleepBEnd,
      ts: sleepBEnd,
      tsStart: sleepBStart,
      updatedAt: sleepBEnd,
      blockIntervalMin: 120,
      date: utcDateKey(sleepBStart),
      activity: 'sleep',
      energy: 'recovery',
      category: 'recovery'
    },
    {
      id: scribeEnd,
      ts: scribeEnd,
      tsStart: scribeStart,
      updatedAt: scribeEnd,
      blockIntervalMin: 180,
      date: utcDateKey(scribeStart),
      activity: 'Scribe shift',
      energy: 'nine5',
      category: 'nine5'
    }
  ];
  await openApp(page, { entries, nowTs });

  await page.evaluate(() => showView('week'));

  const top = page.locator('#w-top-acts-week');
  await expect(top.locator('[data-activity-key="sleep"]')).toHaveCount(1);
  await expect(top.locator('[data-activity-key="sleep"]')).toContainText('Sleep');
  await expect(top.locator('[data-activity-key="sleep"]')).toContainText('10.0h');

  const options = await page.locator('#filter-activity option').allTextContents();
  expect(options.filter(text => text.trim().toLowerCase() === 'sleep')).toHaveLength(1);

  await page.locator('#filter-activity').selectOption('sleep');
  const tableText = await page.locator('#week-table-body').innerText();
  expect(tableText).toContain('Sleep');
  expect(tableText).not.toContain('sleep');
  expect(tableText).not.toContain('Scribe shift');
});

test('week share builds an accountability summary and copies it', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 18, 0, 0);
  const sleepStart = Date.UTC(2026, 6, 13, 0, 0, 0);
  const sleepEnd = sleepStart + 8 * 60 * 60 * 1000;
  const appStart = Date.UTC(2026, 6, 14, 9, 0, 0);
  const appEnd = appStart + 2 * 60 * 60 * 1000;
  const scribeStart = Date.UTC(2026, 6, 15, 9, 0, 0);
  const scribeEnd = scribeStart + 3 * 60 * 60 * 1000;
  const wasteStart = Date.UTC(2026, 6, 15, 14, 0, 0);
  const wasteEnd = wasteStart + 60 * 60 * 1000;
  const entries = [
    {
      id: sleepEnd,
      ts: sleepEnd,
      tsStart: sleepStart,
      updatedAt: sleepEnd,
      blockIntervalMin: 480,
      date: utcDateKey(sleepStart),
      activity: 'Sleep',
      energy: 'recovery',
      category: 'recovery'
    },
    {
      id: appEnd,
      ts: appEnd,
      tsStart: appStart,
      updatedAt: appEnd,
      blockIntervalMin: 120,
      date: utcDateKey(appStart),
      activity: 'App building',
      energy: 'deep',
      category: 'deep'
    },
    {
      id: scribeEnd,
      ts: scribeEnd,
      tsStart: scribeStart,
      updatedAt: scribeEnd,
      blockIntervalMin: 180,
      date: utcDateKey(scribeStart),
      activity: 'Scribe shift',
      energy: 'nine5',
      category: 'nine5'
    },
    {
      id: wasteEnd,
      ts: wasteEnd,
      tsStart: wasteStart,
      updatedAt: wasteEnd,
      blockIntervalMin: 60,
      date: utcDateKey(wasteStart),
      activity: 'Doom scrolling',
      energy: 'waste',
      category: 'waste'
    }
  ];
  await openApp(page, { entries, nowTs, settings: { deepGoal: 5 } });

  await page.evaluate(() => showView('week'));
  await page.evaluate(() => {
    window.__copiedWeekShare = '';
    window.copyWeekShareText = text => {
      window.__copiedWeekShare = text;
      return Promise.resolve();
    };
  });

  await page.locator('#week-share-btn').click();
  await expect(page.locator('#week-share-overlay')).toBeVisible();
  const preview = page.locator('#week-share-preview');
  await expect(preview).toContainText('My ChronaSense week:');
  await expect(preview).toContainText('Logged: 14.0h');
  await expect(preview).toContainText('Deep work: 2.0h / 5.0h');
  await expect(preview).toContainText('Waste: 1.0h');
  await expect(preview).toContainText('Sleep - 8.0h');
  await expect(preview).toContainText('Shared from ChronaSense:');

  await page.getByRole('button', { name: 'Copy text' }).click();
  const copied = await page.evaluate(() => window.__copiedWeekShare);
  expect(copied).toContain('Where my time went:');
  expect(copied).toContain('App building - 2.0h');
});

test('today timeline and recent entries display activity casing consistently', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 18, 0, 0);
  const firstStart = Date.UTC(2026, 6, 15, 9, 0, 0);
  const firstEnd = firstStart + 10 * 60 * 1000;
  const secondStart = firstEnd;
  const secondEnd = secondStart + 10 * 60 * 1000;
  const laterStart = Date.UTC(2026, 6, 15, 11, 0, 0);
  const laterEnd = laterStart + 10 * 60 * 1000;
  const entries = [
    {
      id: firstEnd,
      ts: firstEnd,
      tsStart: firstStart,
      updatedAt: firstEnd,
      blockIntervalMin: 10,
      date: utcDateKey(firstStart),
      activity: 'APP BUILDING',
      energy: 'deep',
      category: 'deep_work'
    },
    {
      id: secondEnd,
      ts: secondEnd,
      tsStart: secondStart,
      updatedAt: secondEnd,
      blockIntervalMin: 10,
      date: utcDateKey(secondStart),
      activity: 'app building',
      energy: 'deep',
      category: 'deep_work'
    },
    {
      id: laterEnd,
      ts: laterEnd,
      tsStart: laterStart,
      updatedAt: laterEnd,
      blockIntervalMin: 10,
      date: utcDateKey(laterStart),
      activity: 'app building',
      energy: 'deep',
      category: 'deep_work'
    }
  ];
  await openApp(page, { entries, nowTs });
  await openTodayDetails(page);

  const timelineRows = page.locator('#timeline-blocks .tl-row[data-activity-key="app building"]');
  await expect(timelineRows).toHaveCount(2);
  const mergedRow = timelineRows.filter({ hasText: '20m' });
  await expect(mergedRow).toHaveCount(1);
  await expect(mergedRow).toContainText('App building');
  await expect(mergedRow).toContainText('×2');

  const recentRows = page.locator('#recent-list .entry-row[data-activity-key="app building"]');
  await expect(recentRows).toHaveCount(2);
  const recentText = await page.locator('#recent-list').innerText();
  expect(recentText).toContain('App building');
  expect(recentText).toContain('20m');
  expect(recentText).not.toContain('APP BUILDING');
  expect(recentText).not.toContain('app building');
});

test('today display collapses exact duplicates and merges continuous same task', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 10, 0, 0);
  const start = Date.UTC(2026, 6, 15, 9, 0, 0);
  const mid = Date.UTC(2026, 6, 15, 9, 8, 0);
  const end = Date.UTC(2026, 6, 15, 9, 16, 0);
  const entries = [
    {
      id: 'dup-a',
      ts: mid,
      tsStart: start,
      updatedAt: mid,
      blockIntervalMin: 8,
      date: '2026-07-15',
      activity: 'App building',
      energy: 'deep',
      onPlan: true,
      retro: true
    },
    {
      id: 'dup-b',
      ts: mid,
      tsStart: start,
      updatedAt: mid + 1,
      blockIntervalMin: 8,
      date: '2026-07-15',
      activity: 'APP BUILDING',
      energy: 'deep',
      onPlan: true,
      retro: true
    },
    {
      id: 'cont',
      ts: end,
      tsStart: mid,
      updatedAt: end,
      blockIntervalMin: 8,
      date: '2026-07-15',
      activity: 'app building',
      energy: 'deep',
      onPlan: true,
      retro: true
    }
  ];

  await openApp(page, { entries, nowTs });
  await openTodayDetails(page);

  const timelineRows = page.locator('#timeline-blocks .tl-row').filter({ hasText: 'App building' });
  await expect(timelineRows).toHaveCount(1);
  await expect(timelineRows.first()).toContainText('9:00 AM – 9:16 AM');
  await expect(timelineRows.first()).toContainText('16m');
  await expect(timelineRows.first()).toContainText('×3');
  await expect(page.locator('#timeline-summary')).toContainText('1 blocks');
  await expect(page.locator('#recent-list .entry-row').filter({ hasText: 'App building' })).toHaveCount(1);
  expect(await page.evaluate(() => entries.length)).toBe(3);
});

test('activity cleanup merges stored name variants with undo', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 18, 0, 0);
  const start = Date.UTC(2026, 6, 15, 9, 0, 0);
  const entries = [
    {
      id: 1,
      ts: start + 10 * 60 * 1000,
      tsStart: start,
      updatedAt: start,
      blockIntervalMin: 10,
      date: utcDateKey(start),
      activity: 'APP BUILDING',
      energy: 'deep'
    },
    {
      id: 2,
      ts: start + 25 * 60 * 1000,
      tsStart: start + 15 * 60 * 1000,
      updatedAt: start,
      blockIntervalMin: 10,
      date: utcDateKey(start),
      activity: 'app building (Output: deploy)',
      energy: 'deep'
    },
    {
      id: 3,
      ts: start + 40 * 60 * 1000,
      tsStart: start + 30 * 60 * 1000,
      updatedAt: start,
      blockIntervalMin: 10,
      date: utcDateKey(start),
      activity: 'App Building',
      energy: 'deep'
    },
    {
      id: 4,
      ts: start + 55 * 60 * 1000,
      tsStart: start + 45 * 60 * 1000,
      updatedAt: start,
      blockIntervalMin: 10,
      date: utcDateKey(start),
      activity: 'app building',
      energy: 'deep',
      deleted: true
    }
  ];
  await openApp(page, { entries, nowTs });
  await page.evaluate(() => showView('settings'));
  await page.locator('summary').filter({ hasText: 'Advanced: Activity Cleanup' }).click();

  const group = page.locator('.activity-cleanup-group[data-activity-key="app building"]');
  await expect(group).toBeVisible();
  await expect(group).toContainText('APP BUILDING');
  await expect(group).toContainText('app building');
  await group.locator('input').fill('App Building');
  await group.getByRole('button', { name: 'Apply' }).click();

  const cleaned = await page.evaluate(() => entries
    .sort((a, b) => a.id - b.id)
    .map(e => ({ id: e.id, activity: e.activity, deleted: !!e.deleted })));
  expect(cleaned).toEqual([
    { id: 1, activity: 'App Building', deleted: false },
    { id: 2, activity: 'App Building (Output: deploy)', deleted: false },
    { id: 3, activity: 'App Building', deleted: false },
    { id: 4, activity: 'app building', deleted: true }
  ]);

  await clickToastUndo(page);
  const restored = await page.evaluate(() => entries
    .sort((a, b) => a.id - b.id)
    .map(e => ({ id: e.id, activity: e.activity, deleted: !!e.deleted })));
  expect(restored).toEqual(entries.map(e => ({ id: e.id, activity: e.activity, deleted: !!e.deleted })));
});

test('activity guardrail canonicalizes new timer and retro logs', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 18, 0, 0);
  const seedStart = Date.UTC(2026, 6, 15, 8, 0, 0);
  const seed = {
    id: seedStart + 30 * 60 * 1000,
    ts: seedStart + 30 * 60 * 1000,
    tsStart: seedStart,
    updatedAt: seedStart,
    blockIntervalMin: 30,
    date: utcDateKey(seedStart),
    activity: 'App Building',
    energy: 'deep'
  };
  await openApp(page, { entries: [seed], nowTs });

  const timerEntry = await page.evaluate(async () => {
    await _startTimer('app building');
    taskStartTime = Date.now() - 6 * 60 * 1000;
    blockStartTime = taskStartTime;
    stopAndLog();
    return entries.find(e => e.id !== 1 && e.activity === 'App Building' && e.blockIntervalMin === 6)?.activity;
  });
  expect(timerEntry).toBe('App Building');

  await openTodayDetails(page);
  await page.locator('#retro-task').click();
  await page.locator('#retro-task').fill('app building (Output: deploy)');
  await page.locator('#retro-qstart').fill('10:00');
  await page.locator('#retro-qend').fill('10:15');
  await page.locator('.quick-retro-bar').getByRole('button', { name: 'Log' }).click();

  const retroEntry = await page.evaluate(() => entries.find(e =>
    e.activity === 'App Building (Output: deploy)' && e.blockIntervalMin === 15
  )?.activity);
  expect(retroEntry).toBe('App Building (Output: deploy)');
});

test('activity guardrail canonicalizes quick saves', async ({ page }) => {
  const seedStart = Date.now() - 60 * 60 * 1000;
  const seed = {
    id: seedStart + 30 * 60 * 1000,
    ts: seedStart + 30 * 60 * 1000,
    tsStart: seedStart,
    updatedAt: seedStart,
    blockIntervalMin: 30,
    date: utcDateKey(seedStart),
    activity: 'App Building',
    energy: 'deep'
  };
  await openApp(page, { entries: [seed] });

  const saved = await page.evaluate(() => {
    blockStartTime = Date.now() - 5 * 60 * 1000;
    totalSecs = 30 * 60;
    _doQuickSave('app building', 'deep');
    return entries.find(e => e.quickLogged && e.activity === 'App Building')?.activity;
  });

  expect(saved).toBe('App Building');
});

test('activity guardrail canonicalizes focus sessions', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 18, 0, 0);
  const seedStart = Date.UTC(2026, 6, 15, 8, 0, 0);
  const seed = {
    id: seedStart + 30 * 60 * 1000,
    ts: seedStart + 30 * 60 * 1000,
    tsStart: seedStart,
    updatedAt: seedStart,
    blockIntervalMin: 30,
    date: utcDateKey(seedStart),
    activity: 'App Building',
    energy: 'deep'
  };
  await openApp(page, { entries: [seed], nowTs });

  const result = await page.evaluate(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.confirm = () => true;
    enterFocusMode();
    document.getElementById('focus-task-input').value = 'app building';
    startPomodoro();
    focusStartTime = Date.now() - 7 * 60 * 1000;
    exitFocusConfirm();
    const saved = entries.find(e => e.activity === 'App Building' && e.blockIntervalMin === 7);
    return {
      savedActivity: saved?.activity,
      lastTaskForRepeat
    };
  });

  expect(result).toMatchObject({
    savedActivity: 'App Building',
    lastTaskForRepeat: 'App Building'
  });
});

test('remote away switch updates an already mirrored away state', async ({ page }) => {
  await openApp(page);
  const cookingStart = Date.now() - 2 * 60 * 1000;

  await page.evaluate((startTs) => {
    awayActive = true;
    awayStartTime = startTs - 5 * 60 * 1000;
    awayLabel = 'Eat';
    showHeroState('away');
    document.getElementById('hero-away-label').textContent = 'Eat';
    document.getElementById('timer-status').textContent = 'Away · Eat · synced';
  }, cookingStart);

  await expect(page.locator('#hero-away-label')).toHaveText('Eat');

  const applied = await page.evaluate((startTs) => applyRemoteAwayState({
    active: true,
    label: 'Cooking',
    startedAt: startTs,
    startedBy: 'phone-device',
    updatedAt: Date.now(),
    deviceName: 'phone'
  }), cookingStart);

  expect(applied).toBe(true);
  await expect(page.locator('#hero-away-label')).toHaveText('Cooking');
  await expect(page.locator('#timer-status')).toHaveText('Away · Cooking · synced');
  await expect(page.locator('#sync-event-log')).toContainText('away');
  await expect(page.locator('#sync-event-log')).toContainText('away: Cooking');
  await expect(page.locator('#sync-event-log')).toContainText('phone');

  const state = await page.evaluate(() => ({ awayActive, awayLabel, awayStartTime }));
  expect(state).toEqual({ awayActive: true, awayLabel: 'Cooking', awayStartTime: cookingStart });
});

test('remote away start stops an older mirrored timer', async ({ page }) => {
  await openApp(page);
  const eatStart = Date.now() - 10 * 60 * 1000;
  const cookingStart = Date.now() - 2 * 60 * 1000;

  await page.evaluate((startTs) => {
    running = true;
    totalSecs = 1800;
    remaining = 1200;
    currentTask = 'Eat';
    lastTaskForRepeat = 'Eat';
    timerStartedAt = startTs;
    taskStartTime = startTs;
    blockStartTime = startTs;
    timerOwnerDeviceId = 'phone-device';
    showHeroState('active');
    document.getElementById('hero-task-name').textContent = 'Eat';
    document.getElementById('timer-status').textContent = 'Synced · pinging every 30 min';
  }, eatStart);

  const applied = await page.evaluate((startTs) => applyRemoteAwayState({
    active: true,
    label: 'Cooking',
    startedAt: startTs,
    startedBy: 'phone-device',
    updatedAt: Date.now(),
    deviceName: 'phone'
  }), cookingStart);

  expect(applied).toBe(true);
  await expect(page.locator('#hero-away-label')).toHaveText('Cooking');
  await expect(page.locator('#timer-status')).toHaveText('Away · Cooking · synced');

  const state = await page.evaluate(() => ({
    running,
    currentTask,
    taskStartTime,
    blockStartTime,
    timerStartedAt,
    timerOwnerDeviceId,
    awayActive,
    awayLabel,
    awayStartTime
  }));
  expect(state).toEqual({
    running: false,
    currentTask: '',
    taskStartTime: null,
    blockStartTime: null,
    timerStartedAt: null,
    timerOwnerDeviceId: null,
    awayActive: true,
    awayLabel: 'Cooking',
    awayStartTime: cookingStart
  });
});

test('background sync reconciliation pulls a missed remote away snapshot', async ({ page }) => {
  await openApp(page);
  const eatStart = Date.now() - 10 * 60 * 1000;
  const cookingStart = Date.now() - 2 * 60 * 1000;

  const applied = await page.evaluate(({ eatStartTs, cookingStartTs }) => {
    running = true;
    totalSecs = 1800;
    remaining = 1200;
    currentTask = 'Eat';
    lastTaskForRepeat = 'Eat';
    timerStartedAt = eatStartTs;
    taskStartTime = eatStartTs;
    blockStartTime = eatStartTs;
    timerOwnerDeviceId = 'phone-device';
    showHeroState('active');
    document.getElementById('hero-task-name').textContent = 'Eat';
    document.getElementById('timer-status').textContent = 'Synced · pinging every 30 min';

    const awayState = {
      active: true,
      label: 'Cooking',
      startedAt: cookingStartTs,
      startedBy: 'phone-device',
      updatedAt: Date.now(),
      deviceName: 'phone'
    };
    fbRoomRef = {
      child(path) {
        return {
          once() {
            return Promise.resolve({ val: () => path === 'awayState' ? awayState : null });
          }
        };
      }
    };
    return reconcileRemoteActiveState();
  }, { eatStartTs: eatStart, cookingStartTs: cookingStart });

  expect(applied).toBe(true);
  await expect(page.locator('#hero-away-label')).toHaveText('Cooking');
  await expect(page.locator('#timer-status')).toHaveText('Away · Cooking · synced');
  await expect(page.locator('#sync-event-log')).toContainText('away: Cooking');

  const state = await page.evaluate(() => ({
    running,
    currentTask,
    taskStartTime,
    blockStartTime,
    timerStartedAt,
    timerOwnerDeviceId,
    awayActive,
    awayLabel,
    awayStartTime,
    lastSync: Number(localStorage.getItem('ta3-last-sync') || 0)
  }));
  expect(state).toMatchObject({
    running: false,
    currentTask: '',
    taskStartTime: null,
    blockStartTime: null,
    timerStartedAt: null,
    timerOwnerDeviceId: null,
    awayActive: true,
    awayLabel: 'Cooking',
    awayStartTime: cookingStart
  });
  expect(state.lastSync).toBeGreaterThan(0);
});

test('stale remote away snapshot cannot overwrite newer local away state', async ({ page }) => {
  await openApp(page);
  const localStart = Date.now() - 60 * 1000;
  const localStamp = Date.now();
  const staleStart = Date.now() - 8 * 60 * 1000;

  await page.evaluate(({ startTs, stamp }) => {
    awayActive = true;
    awayStartTime = startTs;
    awayLabel = 'Cooking';
    localStorage.setItem('ta3-away-updated-at', String(stamp));
    showHeroState('away');
    document.getElementById('hero-away-label').textContent = 'Cooking';
    document.getElementById('timer-status').textContent = 'Away · Cooking · synced';
  }, { startTs: localStart, stamp: localStamp });

  const applied = await page.evaluate(({ startTs, stamp }) => applyRemoteAwayState({
    active: true,
    label: 'Eat',
    startedAt: startTs,
    startedBy: 'phone-device',
    updatedAt: stamp
  }), { startTs: staleStart, stamp: localStamp - 1000 });

  expect(applied).toBe(false);
  await expect(page.locator('#hero-away-label')).toHaveText('Cooking');
  await expect(page.locator('#sync-detail-label')).toContainText('ignored stale away');
  await expect(page.locator('#sync-event-log')).toContainText('ignored stale away');

  const state = await page.evaluate(() => ({ awayActive, awayLabel, awayStartTime }));
  expect(state).toEqual({ awayActive: true, awayLabel: 'Cooking', awayStartTime: localStart });
});

test('remote timer handoff updates task label and block anchors', async ({ page }) => {
  await openApp(page);
  const oldStart = Date.now() - 10 * 60 * 1000;
  const remoteStart = Date.now() - 2 * 60 * 1000;

  await page.evaluate((startTs) => {
    running = true;
    totalSecs = 1800;
    remaining = 1200;
    currentTask = 'Eat';
    lastTaskForRepeat = 'Eat';
    timerStartedAt = startTs;
    taskStartTime = startTs;
    blockStartTime = startTs;
    timerOwnerDeviceId = syncedDeviceId;
    showHeroState('active');
    document.getElementById('hero-task-name').textContent = 'Eat';
    document.getElementById('timer-status').textContent = 'Pinging every 30 min';
  }, oldStart);

  const applied = await page.evaluate((startTs) => applyRemoteTimerState({
    running: true,
    lastTask: 'Cooking',
    intervalSecs: 1800,
    startedAt: startTs,
    taskStartTime: startTs,
    blockStartTime: startTs,
    ownerDeviceId: 'phone-device',
    updatedAt: Date.now(),
    updatedBy: 'phone-device',
    deviceName: 'phone'
  }), remoteStart);

  expect(applied).toBe(true);
  await expect(page.locator('#hero-task-name')).toHaveText('Cooking');
  await expect(page.locator('#timer-status')).toHaveText('Synced · pinging every 30 min');
  await expect(page.locator('#sync-detail-label')).toContainText('cloud heard phone');
  await expect(page.locator('#sync-detail-label')).toContainText('owner: phone');
  await expect(page.locator('#sync-detail-label')).toContainText('active: Cooking');
  await expect(page.locator('#sync-event-log')).toContainText('timer');
  await expect(page.locator('#sync-event-log')).toContainText('active: Cooking');
  await expect(page.locator('#sync-event-log')).toContainText('phone');

  const state = await page.evaluate(() => ({
    currentTask,
    lastTaskForRepeat,
    taskStartTime,
    blockStartTime,
    timerOwnerDeviceId,
    savedTimer: JSON.parse(localStorage.getItem('ta3-timer') || 'null')
  }));
  expect(state.currentTask).toBe('Cooking');
  expect(state.lastTaskForRepeat).toBe('Cooking');
  expect(state.taskStartTime).toBe(remoteStart);
  expect(state.blockStartTime).toBe(remoteStart);
  expect(state.timerOwnerDeviceId).toBe('phone-device');
  expect(state.savedTimer.currentTask).toBe('Cooking');
  expect(state.savedTimer.taskStartTime).toBe(remoteStart);
});

test('remote focus timer is adopted as active sync state', async ({ page }) => {
  await openApp(page);
  const remoteStart = Date.now() - 2 * 60 * 1000;

  const applied = await page.evaluate((startTs) => applyRemoteTimerState({
    running: true,
    mode: 'focus',
    focusPhase: 'work',
    lastTask: 'PC focus block',
    intervalSecs: 25 * 60,
    startedAt: startTs,
    taskStartTime: startTs,
    blockStartTime: startTs,
    ownerDeviceId: 'pc-device',
    updatedAt: Date.now(),
    updatedBy: 'pc-device',
    deviceName: 'PC'
  }), remoteStart);

  expect(applied).toBe(true);
  await expect(page.locator('#hero-task-name')).toHaveText('PC focus block');
  await expect(page.locator('#timer-status')).toHaveText('Focus synced · PC focus block');
  await expect(page.locator('#sync-detail-label')).toContainText('focus: PC focus block');

  const state = await page.evaluate(() => ({
    running,
    currentTask,
    taskStartTime,
    blockStartTime,
    timerOwnerDeviceId,
    savedTimer: JSON.parse(localStorage.getItem('ta3-timer') || 'null')
  }));
  expect(state.currentTask).toBe('PC focus block');
  expect(state.taskStartTime).toBe(remoteStart);
  expect(state.blockStartTime).toBe(remoteStart);
  expect(state.timerOwnerDeviceId).toBe('pc-device');
  expect(state.savedTimer.currentTask).toBe('PC focus block');
  expect(state.savedTimer.ownerDeviceId).toBe('pc-device');
});

test('focus overlay mirrors a remote PC focus session without taking ownership', async ({ page }) => {
  await openApp(page);
  const remoteStart = Date.now() - 2 * 60 * 1000;

  const result = await page.evaluate((startTs) => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.__timerUpdates = [];
    fbRoomRef = {
      update(payload) {
        window.__timerUpdates.push(payload);
        return Promise.resolve();
      }
    };
    applyRemoteTimerState({
      running: true,
      mode: 'focus',
      focusPhase: 'work',
      lastTask: 'PC focus mirror',
      intervalSecs: 25 * 60,
      startedAt: startTs,
      taskStartTime: startTs,
      blockStartTime: startTs,
      ownerDeviceId: 'pc-device',
      updatedAt: Date.now(),
      updatedBy: 'pc-device',
      deviceName: 'PC'
    });
    const entryCountBefore = entries.length;

    enterFocusMode();
    const openState = {
      overlayOpen: document.getElementById('focus-overlay').classList.contains('open'),
      phaseLabel: document.getElementById('focus-phase-label').textContent,
      task: document.getElementById('focus-intention-text').textContent,
      sub: document.getElementById('focus-phase-sub').textContent,
      countdown: document.getElementById('focus-countdown').textContent,
      startDisplay: document.getElementById('focus-start-btn').style.display,
      entryCountAfterEnter: entries.length,
      runningAfterEnter: running,
      ownerAfterEnter: timerOwnerDeviceId
    };

    confirmExitFocus();
    return {
      ...openState,
      overlayStillOpen: document.getElementById('focus-overlay').classList.contains('open'),
      entryCountAfterExit: entries.length,
      runningAfterExit: running,
      taskAfterExit: currentTask,
      ownerAfterExit: timerOwnerDeviceId,
      stoppedWrites: window.__timerUpdates.filter(item => item.timer?.stopped).length,
      entryCountBefore
    };
  }, remoteStart);

  expect(result).toMatchObject({
    overlayOpen: true,
    phaseLabel: 'FOCUS',
    task: 'PC focus mirror',
    sub: 'PC synced · work session',
    startDisplay: 'none',
    entryCountAfterEnter: result.entryCountBefore,
    runningAfterEnter: true,
    ownerAfterEnter: 'pc-device',
    overlayStillOpen: false,
    entryCountAfterExit: result.entryCountBefore,
    runningAfterExit: true,
    taskAfterExit: 'PC focus mirror',
    ownerAfterExit: 'pc-device',
    stoppedWrites: 0
  });
  expect(result.countdown).toMatch(/^2[2-3]:\d{2}$/);
});

test('remote owner banner can intentionally take over a synced focus timer', async ({ page }) => {
  await openApp(page);
  const remoteStart = Date.now() - 2 * 60 * 1000;

  await page.evaluate((startTs) => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.__timerUpdates = [];
    fbRoomRef = {
      update(payload) {
        window.__timerUpdates.push(payload);
        return Promise.resolve();
      }
    };
    applyRemoteTimerState({
      running: true,
      mode: 'focus',
      focusPhase: 'work',
      lastTask: 'Takeover focus',
      intervalSecs: 25 * 60,
      startedAt: startTs,
      taskStartTime: startTs,
      blockStartTime: startTs,
      ownerDeviceId: 'pc-device',
      updatedAt: Date.now(),
      updatedBy: 'pc-device',
      deviceName: 'PC'
    });
    renderToday();
  }, remoteStart);

  const banner = page.locator('#active-device-banner');
  await expect(banner).toBeVisible();
  await expect(page.locator('#active-device-title')).toHaveText('PC is active');
  await expect(page.locator('#active-device-detail')).toContainText('Focus: Takeover focus');

  await page.locator('#active-device-takeover-btn').click();
  await expect(banner).toBeHidden();

  const state = await page.evaluate(() => ({
    timerOwnerDeviceId,
    syncedDeviceId,
    syncedFocusOwner: syncedFocusTimer?.ownerDeviceId,
    update: window.__timerUpdates.at(-1)?.timer,
    syncEvents: JSON.parse(localStorage.getItem('ta3-sync-event-log') || '[]')
  }));
  expect(state.timerOwnerDeviceId).toBe(state.syncedDeviceId);
  expect(state.syncedFocusOwner).toBe(state.syncedDeviceId);
  expect(state.update).toMatchObject({
    running: true,
    mode: 'focus',
    focusPhase: 'work',
    lastTask: 'Takeover focus',
    ownerDeviceId: state.syncedDeviceId,
    takeover: true
  });
  expect(state.syncEvents[0]).toMatchObject({
    kind: 'timer',
    stateLabel: 'takeover: Takeover focus'
  });
});

test('local focus owner accepts explicit takeover from another device', async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.__timerUpdates = [];
    fbRoomRef = {
      update(payload) {
        window.__timerUpdates.push(payload);
        return Promise.resolve();
      }
    };
    enterFocusMode();
    document.getElementById('focus-task-input').value = 'Relinquish focus';
    startPomodoro();
    const startedAt = focusStartTime;
    const applied = applyRemoteTimerState({
      running: true,
      mode: 'focus',
      focusPhase: 'work',
      lastTask: 'Relinquish focus',
      intervalSecs: 25 * 60,
      startedAt,
      taskStartTime: startedAt,
      blockStartTime: startedAt,
      ownerDeviceId: 'phone-device',
      updatedAt: Date.now() + 1000,
      updatedBy: 'phone-device',
      deviceName: 'phone',
      takeover: true
    });
    return {
      applied,
      currentTask,
      timerOwnerDeviceId,
      syncedFocusOwner: syncedFocusTimer?.ownerDeviceId,
      phaseSub: document.getElementById('focus-phase-sub').textContent,
      republishedCount: window.__timerUpdates.filter(item => item.timer?.ownerDeviceId === syncedDeviceId).length
    };
  });

  expect(result).toMatchObject({
    applied: true,
    currentTask: 'Relinquish focus',
    timerOwnerDeviceId: 'phone-device',
    syncedFocusOwner: 'phone-device',
    phaseSub: 'phone synced · work session',
    republishedCount: 1
  });
});

test('stale remote timer snapshot cannot overwrite newer local timer state', async ({ page }) => {
  await openApp(page);
  const localStart = Date.now() - 60 * 1000;
  const localStamp = Date.now();
  const staleStart = Date.now() - 12 * 60 * 1000;

  await page.evaluate(({ startTs, stamp }) => {
    running = true;
    totalSecs = 1800;
    remaining = 1740;
    currentTask = 'Cooking';
    lastTaskForRepeat = 'Cooking';
    timerStartedAt = startTs;
    taskStartTime = startTs;
    blockStartTime = startTs;
    timerOwnerDeviceId = syncedDeviceId;
    localStorage.setItem('ta3-timer-updated-at', String(stamp));
    showHeroState('active');
    document.getElementById('hero-task-name').textContent = 'Cooking';
    document.getElementById('timer-status').textContent = 'Pinging every 30 min';
  }, { startTs: localStart, stamp: localStamp });

  const applied = await page.evaluate(({ startTs, stamp }) => applyRemoteTimerState({
    running: true,
    lastTask: 'Eat',
    intervalSecs: 1800,
    startedAt: startTs,
    taskStartTime: startTs,
    blockStartTime: startTs,
    ownerDeviceId: 'phone-device',
    updatedAt: stamp,
    updatedBy: 'phone-device',
    deviceName: 'phone'
  }), { startTs: staleStart, stamp: localStamp - 1000 });

  expect(applied).toBe(false);
  await expect(page.locator('#hero-task-name')).toHaveText('Cooking');
  await expect(page.locator('#sync-detail-label')).toContainText('ignored stale timer');
  await expect(page.locator('#sync-event-log')).toContainText('ignored stale timer');

  const state = await page.evaluate(() => ({
    currentTask,
    taskStartTime,
    blockStartTime,
    timerOwnerDeviceId,
    syncedDeviceId
  }));
  expect(state).toEqual({
    currentTask: 'Cooking',
    taskStartTime: localStart,
    blockStartTime: localStart,
    timerOwnerDeviceId: state.syncedDeviceId,
    syncedDeviceId: state.syncedDeviceId
  });
});

test('sync now pulls the latest remote timer snapshot', async ({ page }) => {
  await openApp(page);
  const remoteStart = Date.now() - 3 * 60 * 1000;

  const ok = await page.evaluate(async (startTs) => {
    const timer = {
      running: true,
      lastTask: 'Cooking',
      intervalSecs: 1800,
      startedAt: startTs,
      taskStartTime: startTs,
      blockStartTime: startTs,
      ownerDeviceId: 'phone-device',
      updatedAt: Date.now(),
      updatedBy: 'phone-device',
      deviceName: 'phone'
    };
    window.__syncUpdates = [];
    fbRoomRef = {
      child(path) {
        return {
          once() {
            return Promise.resolve({ val: () => path === 'timer' ? timer : null });
          }
        };
      },
      update(payload) {
        window.__syncUpdates.push(payload);
        return Promise.resolve();
      }
    };
    return forceSyncNow();
  }, remoteStart);

  expect(ok).toBe(true);
  await expect(page.locator('#hero-task-name')).toHaveText('Cooking');
  await expect(page.locator('#sync-detail-label')).toContainText('cloud heard phone');
  await expect(page.locator('#sync-detail-label')).toContainText('owner: phone');
  await expect(page.locator('#sync-detail-label')).toContainText('active: Cooking');
});

test('sync now pulls newer remote recurring templates', async ({ page }) => {
  await openApp(page, {
    settings: {
      _savedAt: 100,
      _templatesSavedAt: 100,
      templates: []
    }
  });

  const ok = await page.evaluate(async () => {
    const remoteSettings = {
      _savedAt: 200,
      _templatesSavedAt: 500,
      templates: [{
        id: 'pc-scribe',
        activity: 'Scribe shift',
        energy: 'nine5',
        days: [1],
        startTime: '22:00',
        endTime: '08:00',
        autoLog: false,
        enabled: true
      }]
    };
    window.__syncUpdates = [];
    fbDb = {
      ref() {
        return {
          once() { return Promise.resolve({ val: () => remoteSettings }); }
        };
      }
    };
    fbRoomRef = {
      child(path) {
        return {
          once() {
            return Promise.resolve({ val: () => path === 'settings' ? remoteSettings : null });
          }
        };
      },
      update(payload) {
        window.__syncUpdates.push(payload);
        return Promise.resolve();
      }
    };
    const result = await forceSyncNow();
    showView('settings');
    document.getElementById('day-template-select').value = '1';
    renderDayTemplatePanel();
    return {
      result,
      templates: settings.templates.map(t => ({
        id: t.id,
        activity: t.activity,
        days: t.days,
        startTime: t.startTime,
        endTime: t.endTime
      }))
    };
  });

  expect(ok.result).toBe(true);
  expect(ok.templates).toEqual([{
    id: 'pc-scribe',
    activity: 'Scribe shift',
    days: [1],
    startTime: '22:00',
    endTime: '08:00'
  }]);
  await expect(page.locator('#day-template-panel')).toContainText('Scribe shift');
});

test('remote timer stop resets local state and clears restored timer storage', async ({ page }) => {
  await openApp(page);
  const startTs = Date.now() - 5 * 60 * 1000;

  await page.evaluate((ts) => {
    running = true;
    totalSecs = 1800;
    remaining = 1200;
    currentTask = 'Cooking';
    lastTaskForRepeat = 'Cooking';
    timerStartedAt = ts;
    taskStartTime = ts;
    blockStartTime = ts;
    timerOwnerDeviceId = 'phone-device';
    localStorage.setItem('ta3-timer', JSON.stringify({
      running: true,
      currentTask: 'Cooking',
      lastTask: 'Cooking',
      timerStartedAt: ts,
      taskStartTime: ts,
      totalSecs: 1800
    }));
    showHeroState('active');
    document.getElementById('hero-task-name').textContent = 'Cooking';
  }, startTs);

  const applied = await page.evaluate(() => applyRemoteTimerState({
    running: false,
    stopped: true,
    ownerDeviceId: null,
    lastTask: null,
    updatedAt: Date.now(),
    updatedBy: 'phone-device',
    deviceName: 'phone'
  }));

  expect(applied).toBe(true);
  await expect(page.locator('#timer-status')).toHaveText('Ready');
  await expect(page.locator('#sync-detail-label')).toContainText('timer stopped');

  const state = await page.evaluate(() => ({
    running,
    currentTask,
    taskStartTime,
    blockStartTime,
    timerStartedAt,
    timerOwnerDeviceId,
    savedTimer: localStorage.getItem('ta3-timer')
  }));
  expect(state).toEqual({
    running: false,
    currentTask: '',
    taskStartTime: null,
    blockStartTime: null,
    timerStartedAt: null,
    timerOwnerDeviceId: null,
    savedTimer: null
  });
});

test('local timer reset publishes stopped state for other devices', async ({ page }) => {
  await openApp(page);
  const startTs = Date.now() - 4 * 60 * 1000;

  const timer = await page.evaluate((ts) => {
    window.__timerUpdates = [];
    fbRoomRef = {
      update(payload) {
        window.__timerUpdates.push(payload);
        return Promise.resolve();
      }
    };
    running = true;
    totalSecs = 1800;
    remaining = 1000;
    currentTask = 'Cooking';
    lastTaskForRepeat = 'Cooking';
    timerStartedAt = ts;
    taskStartTime = ts;
    blockStartTime = ts;
    timerOwnerDeviceId = syncedDeviceId;
    localStorage.setItem('ta3-timer', JSON.stringify({
      running: true,
      currentTask: 'Cooking',
      timerStartedAt: ts,
      taskStartTime: ts,
      totalSecs: 1800
    }));
    resetTimer();
    return window.__timerUpdates.at(-1).timer;
  }, startTs);

  expect(timer.running).toBe(false);
  expect(timer.stopped).toBe(true);
  expect(timer.lastTask).toBe(null);
  expect(timer.ownerDeviceId).toBe(null);
  expect(timer.startedAt).toBe(null);
});

test('tiny PC Time fragments inside planned blocks are absorbed in displays', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 15, 12, 0, 0);
  const todayKey = '2026-07-15';
  const appStart = Date.UTC(2026, 6, 15, 9, 0, 0);
  const appEnd = Date.UTC(2026, 6, 15, 10, 0, 0);
  const pcStart = Date.UTC(2026, 6, 15, 9, 5, 0);
  const pcEnd = Date.UTC(2026, 6, 15, 9, 9, 0);
  const entries = [
    {
      id: appEnd,
      ts: appEnd,
      tsStart: appStart,
      updatedAt: appEnd,
      blockIntervalMin: 60,
      date: todayKey,
      activity: 'App building',
      energy: 'deep',
      category: 'deep_work',
      originalLabel: 'deep',
      onPlan: true,
      retro: true
    },
    {
      id: pcEnd,
      ts: pcEnd,
      tsStart: pcStart,
      updatedAt: pcEnd,
      blockIntervalMin: 4,
      date: todayKey,
      activity: 'PC Time',
      energy: 'shallow',
      category: 'shallow_work',
      originalLabel: 'shallow',
      onPlan: true,
      autoLogged: true
    }
  ];
  const plans = {
    [todayKey]: {
      items: [{ id: 'p1', task: 'App building', when: '', done: false, updatedAt: nowTs }],
      updatedAt: nowTs
    }
  };

  await openApp(page, { entries, plans, nowTs });
  await openTodayDetails(page);

  await expect(page.locator('#timeline-blocks')).toContainText('App building');
  await expect(page.locator('#timeline-blocks')).not.toContainText('PC Time');
  await expect(page.locator('#recent-list')).toContainText('App building');
  await expect(page.locator('#recent-list')).not.toContainText('PC Time');
  await expect.poll(() => page.evaluate(() => entries.length)).toBe(2);

  await page.evaluate(() => showView('week'));
  await expect(page.locator('#week-content')).toContainText('App building');
  await expect(page.locator('#week-content')).not.toContainText('PC Time');
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
