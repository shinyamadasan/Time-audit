import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';

let APP_URL;
let appServer;
test.beforeAll(async () => {
  const root = path.resolve('.');
  appServer = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  APP_URL = `http://127.0.0.1:${appServer.address().port}/index.html`;
});
test.afterAll(async () => { await new Promise(resolve => appServer.close(resolve)); });

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
    transaction(updateFn) {
      const value = updateFn(null);
      return Promise.resolve({ committed: true, snapshot: snapshot(value) });
    },
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
    reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30,
    sleepSetupDone: true, templates: [], ...overrides
  };
}

const utcDateKey = ts => new Date(ts).toISOString().slice(0, 10);
const todayKey = () => utcDateKey(Date.now());
const DAY_MS = 24 * 60 * 60 * 1000;

function stableNowTs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18, 0, 0);
}

function stableEntryWindow(startMsAgo, endMsAgo, nowTs = Date.now()) {
  const duration = startMsAgo - endMsAgo;
  const rawStart = nowTs - startMsAgo;
  const base = new Date(startMsAgo < DAY_MS ? nowTs : rawStart);
  const start = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 12, 0, 0);
  return { start, end: start + duration };
}

async function openApp(page, { entries = [], plans = {}, reviews = {}, settings = {}, nowTs = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: firebaseStub
  }));
  // addInitScript re-runs on every navigation, so seed exactly once — otherwise a reload
  // would wipe localStorage before the app could load it, and persistence can't be tested.
  await page.addInitScript(({ entries, plans, reviews, settings, nowTs }) => {
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
    localStorage.setItem('ta3-reviews', JSON.stringify(reviews));
    localStorage.setItem('ta3-test-seeded', '1');
  }, { entries, plans, reviews, settings: baseSettings(settings), nowTs });
  await page.goto(APP_URL);
  await page.waitForFunction(() => typeof window.renderTodayPlan === 'function' && typeof window.openPlanTomorrow === 'function');
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

function planForDate(dateKey, items) {
  return {
    [dateKey]: {
      items: items.map((it, i) => ({
        id: 'seed' + i, task: it.task, when: it.when || '',
        done: !!it.done, doneAt: null, updatedAt: Date.now()
      })),
      updatedAt: Date.now()
    }
  };
}

async function addItem(page, task, when = '') {
  if (!(await page.locator('#plan-strip').getAttribute('class')).includes('editing')) await page.locator('#plan-strip').getByRole('button', {name:'Edit',exact:true}).click();
  if (when) await page.locator('#plan-when').fill(when);
  await page.locator('#plan-task').fill(task);
  await page.locator('#plan-strip').getByRole('button', { name: 'Add' }).click();
}

async function openTodayDetails(page) {
  await page.evaluate(() => { document.getElementById('timeline-details').open = true; document.querySelector('#timeline-content > details').open = true; });
}

test('an unprepared day allows optional priorities without a ceremony', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#morning-startup')).toHaveCount(0);
  await addItem(page, 'Ship launch notes', 'first block');
  expect(await page.evaluate(() => getPlanItems(planTodayKey()).map(i => ({ task: i.task, when: i.when })))).toEqual([{ task: 'Ship launch notes', when: 'first block' }]);
});

test('today action strip starts work when no target exists', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#hero-context-prompt')).toHaveText('What are you working on?');
  await page.locator('#hero-task-input').click();
  await expect(page.locator('#hero-task-input')).toBeFocused();
});

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
  if (!(await page.locator('#plan-strip').getAttribute('class')).includes('editing')) await page.locator('#plan-strip').getByRole('button', {name:'Edit',exact:true}).click();
  await page.locator('.plan-item').first().locator('.plan-remove').click();
  await expect(page.locator('.plan-item')).toHaveCount(2);
  await expect(page.locator('.plan-add')).toHaveCount(1);

  await addItem(page, 'Read paper');
  await expect(page.locator('.plan-item')).toHaveCount(3);
});

test('today action strip starts the next planned item', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Write report' }]) });

  await expect(page.locator('#today-action-title')).toHaveText('Write report');
  await page.locator('#today-action-primary').click();

  await expect(page.locator('#hero-task-name')).toHaveText('Write report');
  await expect(page.locator('#up-next')).toHaveAttribute('data-state','tracker');
  await expect(page.locator('#hero-task-name')).toHaveText('Write report');
});

test('today details report plan progress instead of daily goal', async ({ page }) => {
  const end = Date.now() - 5 * 60 * 1000;
  const start = end - 45 * 60 * 1000;
  const entry = {
    id: end,
    ts: end,
    tsStart: start,
    updatedAt: end,
    blockIntervalMin: 45,
    date: utcDateKey(start),
    activity: 'Write report',
    energy: 'deep',
    category: 'deep_work',
    originalLabel: 'deep',
    onPlan: true,
    retro: false
  };

  await openApp(page, {
    entries: [entry],
    plans: planFor([{ task: 'Write report' }, { task: 'Gym' }])
  });
  await openTodayDetails(page);

  await expect(page.locator('#sb-needed-label')).toHaveText('plan');
  await expect(page.locator('#sb-needed-val')).toHaveText('1/2');
  await expect(page.locator('#status-banner')).not.toContainText(/goal/i);
});

test('when-then trigger renders with the task', async ({ page }) => {
  await openApp(page);
  await addItem(page, 'Write report', 'after lunch');
  await expect(page.locator('.plan-item').first().locator('.plan-when')).toHaveText('after lunch →');
  await expect(page.locator('.plan-item').first().locator('.plan-task')).toContainText('Write report');
});

test('tracked minutes are derived from real entries, not the checkbox', async ({ page }) => {
  const nowTs = stableNowTs();
  const { start, end } = stableEntryWindow(60 * 60 * 1000, 30 * 60 * 1000, nowTs);   // 30 minutes of real tracked time
  const entries = [{
    id: end, ts: end, tsStart: start, updatedAt: end, blockIntervalMin: 30,
    date: utcDateKey(start), activity: 'Write report', energy: 'deep',
    category: 'deep_work', originalLabel: 'deep', onPlan: true, retro: false
  }];

  await openApp(page, {
    entries,
    plans: planFor([{ task: 'Write report' }, { task: 'Gym' }]),
    nowTs
  });

  const rows = page.locator('.plan-item');
  // Worked on it -> the app says so, with no manual input at all.
  await expect(rows.nth(0).locator('.plan-status')).toHaveText('Logged');
  await expect(rows.nth(0).locator('.plan-status')).toHaveClass(/logged/);
  await expect(rows.nth(0).locator('.plan-tracked')).toHaveText('30m tracked');
  await expect(rows.nth(0).locator('.plan-tracked')).toHaveClass(/on/);
  // Never touched -> honest zero.
  await expect(rows.nth(1).locator('.plan-status')).toHaveText('Not started');
  await expect(rows.nth(1).locator('.plan-tracked')).toHaveText('0m tracked');

  // Ticking "done" on the untouched item does NOT invent tracked time.
  await rows.nth(1).locator('.plan-check').click();
  await expect(rows.nth(1)).toHaveClass(/done/);
  await expect(rows.nth(1).locator('.plan-status')).toHaveText('Not started');
  await expect(rows.nth(1).locator('.plan-tracked')).toHaveText('0m tracked');
  await expect(page.locator('.plan-count')).toHaveText('1 of 2 done');
});

test('one-tap start launches the timer with the planned task', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Write report' }]) });

  await page.locator('#plan-strip').getByRole('button', {name:'Edit',exact:true}).click();
  await page.locator('.plan-item').first().locator('.plan-start').click();

  await expect(page.locator('#hero-task-name')).toHaveText('Write report');
  await expect(page.locator('#activity-hero')).toHaveClass(/tracking/);
  // `let` globals live in the script's lexical scope, not on window — reference them bare.
  expect(await page.evaluate(() => running)).toBe(true);
  expect(await page.evaluate(() => currentTask)).toBe('Write report');
  await expect(page.locator('.plan-item').first().locator('.plan-status')).toHaveText('In progress');
  await expect(page.locator('.plan-item').first()).toHaveClass(/in-progress/);
  await expect(page.locator('#up-next')).toHaveAttribute('data-state','tracker');
});

test('start next launches the first unstarted plan item', async ({ page }) => {
  const nowTs = stableNowTs();
  const { start, end } = stableEntryWindow(60 * 60 * 1000, 30 * 60 * 1000, nowTs);
  const entries = [{
    id: end, ts: end, tsStart: start, updatedAt: end, blockIntervalMin: 30,
    date: utcDateKey(start), activity: 'Write report', energy: 'deep',
    category: 'deep_work', originalLabel: 'deep', onPlan: true, retro: false
  }];

  await openApp(page, {
    entries,
    plans: planFor([{ task: 'Write report' }, { task: 'Gym' }, { task: 'Read paper' }]),
    nowTs
  });

  await expect(page.locator('.plan-item').nth(0).locator('.plan-status')).toHaveText('Logged');
  await expect(page.locator('.plan-item').nth(1).locator('.plan-status')).toHaveText('Not started');
  await expect(page.locator('#today-action-primary')).toHaveText('Start');

  await page.locator('#today-action-primary').click();

  await expect(page.locator('#hero-task-name')).toHaveText('Gym');
  await expect(page.locator('.plan-item').nth(1).locator('.plan-status')).toHaveText('In progress');
  expect(await page.evaluate(() => currentTask)).toBe('Gym');
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

  if (!(await page.locator('#plan-strip').getAttribute('class')).includes('editing')) await page.locator('#plan-strip').getByRole('button', {name:'Edit',exact:true}).click();
  await page.locator('.plan-item').first().locator('.plan-remove').click();
  await expect(page.locator('.plan-item')).toHaveCount(1);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-plans')));
  const items = stored[Object.keys(stored)[0]].items;
  expect(items).toHaveLength(2);                       // still on disk...
  expect(items.find(i => i.task === 'Write report').deleted).toBe(true);   // ...as a tombstone
  expect(items.find(i => i.task === 'Write report').updatedBy).toBeTruthy();
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

// ══════════════════════════════════════════════════════
// The nightly ritual — the review modal becomes the plan picker
// ══════════════════════════════════════════════════════

function deepEntry(startMsAgo, endMsAgo, activity, nowTs = Date.now()) {
  const { start, end } = stableEntryWindow(startMsAgo, endMsAgo, nowTs);
  return {
    id: end, ts: end, tsStart: start, updatedAt: end,
    blockIntervalMin: Math.round((end - start) / 60000),
    date: utcDateKey(start), activity, energy: 'deep', category: 'deep_work',
    originalLabel: 'deep', onPlan: true, retro: false
  };
}

function wasteEntry(startMsAgo, endMsAgo, activity, nowTs = Date.now()) {
  const { start, end } = stableEntryWindow(startMsAgo, endMsAgo, nowTs);
  return {
    id: end, ts: end, tsStart: start, updatedAt: end,
    blockIntervalMin: Math.round((end - start) / 60000),
    date: utcDateKey(start), activity, energy: 'waste', category: 'waste',
    originalLabel: 'waste', onPlan: false, retro: false
  };
}

function datedEntry(dateKey, startHour, endHour, activity, energy = 'deep') {
  const start = Date.parse(`${dateKey}T${String(startHour).padStart(2, '0')}:00:00Z`);
  const end   = Date.parse(`${dateKey}T${String(endHour).padStart(2, '0')}:00:00Z`);
  return {
    id: end, ts: end, tsStart: start, updatedAt: end,
    blockIntervalMin: Math.round((end - start) / 60000),
    date: dateKey, activity, energy, category: energy,
    originalLabel: energy, onPlan: energy === 'deep', retro: false
  };
}

test('Plan Tomorrow writes priorities to the next day', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => openPlanTomorrow());

  await page.locator('#plan-tomorrow-add input[name="when"]').fill('after lunch');
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Ship the report');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Gym');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.pt-oneoff')).toHaveCount(2);

  await page.locator('#plan-tomorrow-confirm').click();

  const result = await page.evaluate(() => {
    const tomorrow = _dateKeyPlusDays(toDateKey(new Date()), 1);
    return {
      tasks: getPlanItems(tomorrow).map(i => i.task),
      when: getPlanItems(tomorrow)[0].when
    };
  });
  expect(result.tasks).toEqual(['Ship the report', 'Gym']);
  expect(result.when).toBe('after lunch');
});

test('Plan Tomorrow caps tomorrow at 3 items', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => openPlanTomorrow());

  for (const t of ['A', 'B', 'C']) {
    await page.locator('#plan-tomorrow-add input[name="task"]').fill(t);
    await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  }
  await expect(page.locator('.pt-oneoff')).toHaveCount(3);
  await expect(page.locator('#plan-tomorrow-add')).toBeHidden();   // no way to enter a 4th
});

test('unfinished items are OFFERED as chips, never auto-carried', async ({ page }) => {
  await openApp(page, {
    plans: planFor([{ task: 'Write report', done: true }, { task: 'Gym', done: false }])
  });
  await page.evaluate(() => openPlanTomorrow());

  // Not pre-added to tomorrow — auto-carry into a capped list is exactly what would deadlock it.
  await expect(page.locator('.pt-oneoff')).toHaveCount(0);

  const undoneChip = page.locator('.rv-plan-chip[data-pt-action="suggest"]');
  await expect(undoneChip).toHaveCount(1);
  await expect(undoneChip).toContainText('Gym');
  await expect(page.locator('.rv-plan-chip')).not.toContainText('Write report');  // finished work isn't re-offered

  await undoneChip.click();
  await expect(page.locator('.pt-oneoff')).toHaveCount(1);
  await expect(page.locator('.pt-oneoff')).toContainText('Gym');
});

test('this week’s priorities are offered as chips (weekly steers daily)', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const tomorrow = _dateKeyPlusDays(toDateKey(new Date()), 1);
    const wk = getWeekKey(new Date(tzParseTime(tomorrow, '12:00')));
    weeklyReviews[wk] = { plan: { p1: 'Ship the report', p2: 'Fix onboarding', p3: '' } };
  });
  await page.evaluate(() => openPlanTomorrow());

  const weekChips = page.locator('.rv-plan-chip[data-pt-action="suggest"]');
  await expect(weekChips).toHaveCount(2);
  await expect(weekChips.first()).toContainText('Ship the report');

  await weekChips.first().click();
  await expect(page.locator('.pt-oneoff')).toContainText('Ship the report');
});

test('waste and downtime are never offered as tomorrow’s priorities', async ({ page }) => {
  // Regression: recent-activity suggestions are unfiltered by energy, so the picker was offering
  // "Drinking with friends" as a candidate for tomorrow's top 3. Surfaced by real logged data.
  const logged = (activity, energy, daysAgo) => {
    const start = Date.now() - daysAgo * DAY_MS;
    const end   = start + 60 * 60 * 1000;
    return {
      id: end + activity.length, ts: end, tsStart: start, updatedAt: end, blockIntervalMin: 60,
      date: utcDateKey(start), activity, energy, category: energy,
      originalLabel: energy, onPlan: true, retro: false
    };
  };

  await openApp(page, {
    entries: [
      logged('App building', 'deep', 1),
      logged('Drinking with friends', 'waste', 1),
      logged('Coffee with friends', 'social', 2),
      logged('Afternoon nap', 'recovery', 2),
      logged('Gym', 'exercise', 3)
    ]
  });
  await page.evaluate(() => openPlanTomorrow());

  const chips = page.locator('.rv-plan-chip');
  const labels = await chips.allInnerTexts();
  const text = labels.join(' | ');

  expect(text).toContain('App building');     // deep work — plannable
  expect(text).toContain('Gym');              // exercise — plannable
  expect(text).not.toContain('Drinking');     // waste
  expect(text).not.toContain('Coffee');       // social
  expect(text).not.toContain('nap');          // recovery

  // The filter is on the CHIPS only — you can still hand-type anything at all.
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Drinking with friends');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.pt-oneoff')).toContainText('Drinking with friends');
});

test('review shows plan vs actual for the day being reviewed', async ({ page }) => {
  const nowTs = stableNowTs();
  await openApp(page, {
    entries: [deepEntry(90 * 60 * 1000, 45 * 60 * 1000, 'Write report', nowTs)],   // 45m of real work
    plans: planFor([{ task: 'Write report', done: true }, { task: 'Gym', done: false }]),
    nowTs
  });
  await page.evaluate(() => openReview());

  const pva = page.locator('#rv-plan-vs-actual');
  await page.locator('#rv-full-analysis > summary').click();
  await expect(pva).toBeVisible();
  await expect(pva.locator('.rv-pva-head')).toHaveText('Planned 2 · active 2 · done/worked on 1');

  const rows = pva.locator('.rv-pva-row');
  await expect(rows.nth(0)).toContainText('Write report');
  await expect(rows.nth(0)).toContainText('45m tracked with the same label');
  await expect(rows.nth(0).locator('.rv-pva-min')).toHaveText('Done');
  await expect(rows.nth(1)).toContainText('Gym');
  await expect(rows.nth(1).locator('.rv-pva-min')).toHaveText('Not done');   // honest, not scolding
});

test('close day CTA opens the review loop and marks today closed after save', async ({ page }) => {
  const nowTs = stableNowTs();
  await openApp(page, {
    entries: [
      deepEntry(120 * 60 * 1000, 75 * 60 * 1000, 'Write report', nowTs),
      wasteEntry(70 * 60 * 1000, 50 * 60 * 1000, 'Scrolling', nowTs)
    ],
    plans: planFor([{ task: 'Write report', done: true }, { task: 'Gym', done: false }]),
    settings: { reviewTime: '17:00', reviewHour: 17 },
    nowTs
  });

  await expect(page.getByRole('navigation',{name:'Today actions'}).getByRole('button',{name:'Review',exact:true})).toBeVisible();
  await expect(page.locator('#closeout-title')).toHaveText('Close day');
  await expect(page.locator('#closeout-stats')).toContainText('1/2 plan');
  await expect(page.locator('#closeout-stats')).toContainText('45m deep');
  await expect(page.locator('#closeout-stats')).toContainText('20m waste');

  await page.getByRole('navigation',{name:'Today actions'}).getByRole('button',{name:'Review',exact:true}).click();
  await expect(page.locator('#review-overlay')).toHaveClass(/open/);
  await expect(page.locator('#rv-closeout-summary')).toBeVisible();
  await expect(page.locator('#rv-closeout-summary')).toContainText('recorded');
  await expect(page.locator('#rv-closeout-summary')).toContainText('1 of 2 done or worked on');
  await expect(page.locator('#rv-metric-details')).toContainText('20m');
  await expect(page.locator('#rv-plan-vs-actual')).toBeHidden();
  await expect(page.locator('#rv-unlogged-decision')).toBeVisible();
  await expect(page.locator('#rv-unlogged-decision')).toContainText('Anything important missing?');
  await expect(page.locator('#rv-unlogged-decision').getByRole('button', { name: 'Log time' })).toBeVisible();
  await page.locator('#rv-unlogged-decision').getByRole('button', { name: 'Leave unknown' }).click();
  await expect(page.locator('#rv-unlogged-decision')).toContainText('Left unknown');

  await page.locator('#rv-win').fill('Shipped the report');
  await page.locator('#rv-optional-details > summary').click();
  await page.locator('#rv-waste').fill('Scrolling');
  await page.locator('#rv-avoid').fill('Block the feed');
  await page.locator('#review-overlay').getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('#review-overlay')).not.toHaveClass(/open/);
  await expect(page.locator('#closeout-title')).toHaveText('Day closed');
  await expect(page.locator('#closeout-action')).toHaveText('Edit review');
  await expect(page.locator('#closeout-stats')).toContainText('blank ok');
  expect(await page.evaluate(() => reviews[planTodayKey()].unloggedOk)).toBe(true);
  await expect(page.locator('#gap-recovery')).toBeHidden();
});

test('close day CTA waits until the configured closeout time', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 16, 18, 0, 0);
  await openApp(page, {
    entries: [datedEntry('2026-07-16', 15, 16, 'Write report')],
    plans: planForDate('2026-07-16', [{ task: 'Write report', done: true }]),
    settings: { reviewTime: '22:00', reviewHour: 22 },
    nowTs
  });

  await expect(page.locator('#closeout-card')).toBeHidden();
  await expect(page.locator('#up-next')).not.toHaveText('Close the loop');
});

test('morning closeout time treats yesterday as due after the graveyard cutoff', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 16, 8, 5, 0);
  await openApp(page, {
    entries: [datedEntry('2026-07-15', 22, 23, 'Scribe shift')],
    plans: planForDate('2026-07-15', [{ task: 'Scribe shift', done: true }]),
    settings: { reviewTime: '08:00', reviewHour: 8 },
    nowTs
  });

  await expect(page.locator('#yesterday-review-link')).toBeVisible();
  await expect(page.locator('#missed-closeout-title')).toHaveText("Yesterday wasn't closed");
  await expect(page.locator('#closeout-card')).toBeHidden();

  await page.locator('#yesterday-review-link').click();
  await expect(page.locator('#review-overlay')).toHaveClass(/open/);
  await expect(page.locator('#rv-plan-vs-actual')).toContainText('Scribe shift');
  expect(await page.evaluate(() => _reviewDateKey)).toBe('2026-07-15');
});

test('morning closeout time does not nag before the graveyard cutoff', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 16, 7, 30, 0);
  await openApp(page, {
    entries: [datedEntry('2026-07-15', 22, 23, 'Scribe shift')],
    plans: planForDate('2026-07-15', [{ task: 'Scribe shift', done: true }]),
    settings: { reviewTime: '08:00', reviewHour: 8 },
    nowTs
  });

  await expect(page.locator('#missed-closeout-card')).toBeHidden();
  await expect(page.locator('#closeout-card')).toBeHidden();
  await expect(page.locator('#up-next')).not.toHaveText('Close yesterday first');
});

test('missed closeout reviews yesterday without changing today priorities', async ({ page }) => {
  const nowTs = Date.UTC(2026, 6, 16, 10, 0, 0);
  const yesterday = utcDateKey(nowTs - DAY_MS);
  await openApp(page, {
    entries: [datedEntry(yesterday, 10, 11, 'Write report')],
    plans: planForDate(yesterday, [{ task: 'Write report', done: true }, { task: 'Gym', done: false }]),
    nowTs
  });

  await expect(page.locator('#yesterday-review-link')).toBeVisible();
  await expect(page.locator('#missed-closeout-title')).toHaveText("Yesterday wasn't closed");
  await expect(page.locator('#missed-closeout-stats')).toContainText('1/2 plan');
  await expect(page.locator('#missed-closeout-stats')).toContainText('1h deep');

  await page.locator('#yesterday-review-link').click();
  await expect(page.locator('#review-overlay')).toHaveClass(/open/);
  await expect(page.locator('#rv-date-label')).not.toHaveText('');
  await expect(page.locator('#rv-plan-vs-actual')).toContainText('Write report');

  await page.locator('#rv-win').fill('Closed yesterday late');
  await page.locator('#review-overlay').getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('#missed-closeout-card')).toBeHidden();
  const result = await page.evaluate(() => {
    const today = toDateKey(new Date());
    const yesterdayKey = _dateKeyPlusDays(today, -1);
    return {
      reviewedYesterday: !!reviews[yesterdayKey],
      todayTasks: getPlanItems(today).map(i => i.task)
    };
  });
  expect(result.reviewedYesterday).toBe(true);
  expect(result.todayTasks).toEqual([]);
});

test('Review keeps tomorrow preparation secondary to factual reflection', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => openReview());
  await expect(page.locator('#rv-tomorrow-status')).toContainText('Prepare tomorrow');
  await expect(page.locator('#rv-plan-task')).toHaveCount(0);
});

// ══════════════════════════════════════════════════════
// The ping cue — quick-log surfaces the plan
// ══════════════════════════════════════════════════════

test('ping offers the unfinished plan, and logging through it feeds auto-verify', async ({ page }) => {
  // A prior "Write report" entry gives inferPlanEnergy() history, so one tap logs it directly.
  await openApp(page, {
    entries: [deepEntry(5 * DAY_MS, 5 * DAY_MS - 30 * 60 * 1000, 'Write report')],
    plans: planFor([{ task: 'Write report' }, { task: 'Gym', done: true }])
  });

  // The ping only fires mid-block, so start one first.
  await page.locator('#plan-strip').getByRole('button', {name:'Edit',exact:true}).click();
  await page.locator('.plan-item').first().locator('.plan-start').click();
  await expect(page.locator('#activity-hero')).toHaveClass(/tracking/);

  await page.evaluate(() => openQuickLog());

  const chips = page.locator('.ql-plan-chip');
  await expect(chips).toHaveCount(1);                     // only the UNFINISHED item is offered
  await expect(chips.first()).toHaveText('Write report');

  await chips.first().click();
  await expect(page.locator('#quicklog-overlay')).not.toHaveClass(/open/);

  // The entry lands with the EXACT planned label, which is what makes planTrackedMin() match.
  const tracked = await page.evaluate(() => planTrackedMin('Write report', planTodayKey()));
  expect(tracked).toBeGreaterThan(0);
  await expect(page.locator('.plan-item').first().locator('.plan-tracked')).toHaveClass(/on/);
});

test('ping asks for a category rather than guessing one for a never-logged task', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Brand new task' }]) });

  await page.locator('#plan-strip').getByRole('button', {name:'Edit',exact:true}).click();
  await page.locator('.plan-item').first().locator('.plan-start').click();
  await page.evaluate(() => openQuickLog());
  await page.locator('.ql-plan-chip').first().click();

  // No history for it -> the form opens pre-filled instead of mislabelling the entry.
  await expect(page.locator('#quicklog-overlay')).toHaveClass(/open/);
  await expect(page.locator('#ql-activity')).toHaveValue('Brand new task');
});
