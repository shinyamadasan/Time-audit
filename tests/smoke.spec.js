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

async function openApp(page, { entries = [], focusRedemptions = [], settings = {}, nowTs = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: firebaseStub
  }));
  await page.addInitScript(({ entries, focusRedemptions, settings, nowTs }) => {
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
  }, {
    entries,
    focusRedemptions,
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

  await openTodayDetails(page);
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
  await expect(recentRows).toHaveCount(3);
  const recentText = await page.locator('#recent-list').innerText();
  expect(recentText).toContain('App building');
  expect(recentText).not.toContain('APP BUILDING');
  expect(recentText).not.toContain('app building');
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
