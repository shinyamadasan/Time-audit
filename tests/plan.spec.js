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

async function openApp(page, { entries = [], plans = {}, reviews = {}, settings = {} } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: firebaseStub
  }));
  // addInitScript re-runs on every navigation, so seed exactly once — otherwise a reload
  // would wipe localStorage before the app could load it, and persistence can't be tested.
  await page.addInitScript(({ entries, plans, reviews, settings }) => {
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
  }, { entries, plans, reviews, settings: baseSettings(settings) });
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

  await page.locator('.plan-item').first().locator('.plan-start').click();

  await expect(page.locator('#hero-task-name')).toHaveText('Write report');
  await expect(page.locator('#activity-hero')).toHaveClass(/tracking/);
  // `let` globals live in the script's lexical scope, not on window — reference them bare.
  expect(await page.evaluate(() => running)).toBe(true);
  expect(await page.evaluate(() => currentTask)).toBe('Write report');
  await expect(page.locator('.plan-item').first().locator('.plan-status')).toHaveText('In progress');
  await expect(page.locator('.plan-item').first()).toHaveClass(/in-progress/);
  await expect(page.locator('.plan-next')).toHaveText('Working now');
  await expect(page.locator('.plan-next')).toBeDisabled();
});

test('start next launches the first unstarted plan item', async ({ page }) => {
  const start = Date.now() - 60 * 60 * 1000;
  const end   = Date.now() - 30 * 60 * 1000;
  const entries = [{
    id: end, ts: end, tsStart: start, updatedAt: end, blockIntervalMin: 30,
    date: utcDateKey(start), activity: 'Write report', energy: 'deep',
    category: 'deep_work', originalLabel: 'deep', onPlan: true, retro: false
  }];

  await openApp(page, {
    entries,
    plans: planFor([{ task: 'Write report' }, { task: 'Gym' }, { task: 'Read paper' }])
  });

  await expect(page.locator('.plan-item').nth(0).locator('.plan-status')).toHaveText('Logged');
  await expect(page.locator('.plan-item').nth(1).locator('.plan-status')).toHaveText('Not started');
  await expect(page.locator('.plan-next')).toHaveText('Start next');

  await page.locator('.plan-next').click();

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

// ══════════════════════════════════════════════════════
// The nightly ritual — the review modal becomes the plan picker
// ══════════════════════════════════════════════════════

const DAY_MS = 24 * 60 * 60 * 1000;

function deepEntry(startMsAgo, endMsAgo, activity) {
  const start = Date.now() - startMsAgo;
  const end   = Date.now() - endMsAgo;
  return {
    id: end, ts: end, tsStart: start, updatedAt: end,
    blockIntervalMin: Math.round((end - start) / 60000),
    date: utcDateKey(start), activity, energy: 'deep', category: 'deep_work',
    originalLabel: 'deep', onPlan: true, retro: false
  };
}

function wasteEntry(startMsAgo, endMsAgo, activity) {
  const start = Date.now() - startMsAgo;
  const end   = Date.now() - endMsAgo;
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

test('review picks tomorrow’s plan and writes it to the next day', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => openReview());

  await page.locator('#rv-plan-when').fill('after lunch');
  await page.locator('#rv-plan-task').fill('Ship the report');
  await page.locator('#rv-plan-add').getByRole('button', { name: 'Add' }).click();
  await page.locator('#rv-plan-task').fill('Gym');
  await page.locator('#rv-plan-add').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.rv-plan-item')).toHaveCount(2);

  await page.locator('#review-overlay').getByRole('button', { name: 'Save' }).click();

  const result = await page.evaluate(() => {
    const tomorrow = _dateKeyPlusDays(toDateKey(new Date()), 1);
    return {
      tasks: getPlanItems(tomorrow).map(i => i.task),
      when: getPlanItems(tomorrow)[0].when,
      legacy: reviews[toDateKey(new Date())].tomorrow   // Reflect history still renders this
    };
  });
  expect(result.tasks).toEqual(['Ship the report', 'Gym']);
  expect(result.when).toBe('after lunch');
  expect(result.legacy).toBe('Ship the report · Gym');
});

test('review caps tomorrow at 3 items', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => openReview());

  for (const t of ['A', 'B', 'C']) {
    await page.locator('#rv-plan-task').fill(t);
    await page.locator('#rv-plan-add').getByRole('button', { name: 'Add' }).click();
  }
  await expect(page.locator('.rv-plan-item')).toHaveCount(3);
  await expect(page.locator('#rv-plan-add')).toBeHidden();   // no way to enter a 4th
});

test('unfinished items are OFFERED as chips, never auto-carried', async ({ page }) => {
  await openApp(page, {
    plans: planFor([{ task: 'Write report', done: true }, { task: 'Gym', done: false }])
  });
  await page.evaluate(() => openReview());

  // Not pre-added to tomorrow — auto-carry into a capped list is exactly what would deadlock it.
  await expect(page.locator('.rv-plan-item')).toHaveCount(0);

  const undoneChip = page.locator('.rv-plan-chip.undone');
  await expect(undoneChip).toHaveCount(1);
  await expect(undoneChip).toContainText('Gym');
  await expect(page.locator('.rv-plan-chip')).not.toContainText('Write report');  // finished work isn't re-offered

  await undoneChip.click();
  await expect(page.locator('.rv-plan-item')).toHaveCount(1);
  await expect(page.locator('.rv-plan-item')).toContainText('Gym');
});

test('this week’s priorities are offered as chips (weekly steers daily)', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const tomorrow = _dateKeyPlusDays(toDateKey(new Date()), 1);
    const wk = getWeekKey(new Date(tzParseTime(tomorrow, '12:00')));
    weeklyReviews[wk] = { plan: { p1: 'Ship the report', p2: 'Fix onboarding', p3: '' } };
  });
  await page.evaluate(() => openReview());

  const weekChips = page.locator('.rv-plan-chip.week');
  await expect(weekChips).toHaveCount(2);
  await expect(weekChips.first()).toContainText('Ship the report');

  await weekChips.first().click();
  await expect(page.locator('.rv-plan-item')).toContainText('Ship the report');
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
  await page.evaluate(() => openReview());

  const chips = page.locator('.rv-plan-chip');
  const labels = await chips.allInnerTexts();
  const text = labels.join(' | ');

  expect(text).toContain('App building');     // deep work — plannable
  expect(text).toContain('Gym');              // exercise — plannable
  expect(text).not.toContain('Drinking');     // waste
  expect(text).not.toContain('Coffee');       // social
  expect(text).not.toContain('nap');          // recovery

  // The filter is on the CHIPS only — you can still hand-type anything at all.
  await page.locator('#rv-plan-task').fill('Drinking with friends');
  await page.locator('#rv-plan-add').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.rv-plan-item')).toContainText('Drinking with friends');
});

test('review shows plan vs actual for the day being reviewed', async ({ page }) => {
  await openApp(page, {
    entries: [deepEntry(90 * 60 * 1000, 45 * 60 * 1000, 'Write report')],   // 45m of real work
    plans: planFor([{ task: 'Write report', done: true }, { task: 'Gym', done: false }])
  });
  await page.evaluate(() => openReview());

  const pva = page.locator('#rv-plan-vs-actual');
  await expect(pva).toBeVisible();
  await expect(pva.locator('.rv-pva-head')).toHaveText('You planned 2 · finished 1');

  const rows = pva.locator('.rv-pva-row');
  await expect(rows.nth(0)).toContainText('Write report');
  await expect(rows.nth(0).locator('.rv-pva-min')).toHaveText('45m');
  await expect(rows.nth(1)).toContainText('Gym');
  await expect(rows.nth(1).locator('.rv-pva-min')).toHaveText('0m');   // honest, not scolding
});

test('close day CTA opens the review loop and marks today closed after save', async ({ page }) => {
  await openApp(page, {
    entries: [
      deepEntry(120 * 60 * 1000, 75 * 60 * 1000, 'Write report'),
      wasteEntry(70 * 60 * 1000, 50 * 60 * 1000, 'Scrolling')
    ],
    plans: planFor([{ task: 'Write report', done: true }, { task: 'Gym', done: false }])
  });

  await expect(page.locator('#closeout-card')).toBeVisible();
  await expect(page.locator('#closeout-title')).toHaveText('Close day');
  await expect(page.locator('#closeout-stats')).toContainText('1/2 plan');
  await expect(page.locator('#closeout-stats')).toContainText('45m deep');
  await expect(page.locator('#closeout-stats')).toContainText('20m waste');

  await page.locator('#closeout-card').click();
  await expect(page.locator('#review-overlay')).toHaveClass(/open/);
  await expect(page.locator('#rv-closeout-summary')).toBeVisible();
  await expect(page.locator('#rv-closeout-summary')).toContainText('Closeout summary');
  await expect(page.locator('#rv-closeout-summary')).toContainText('45m');
  await expect(page.locator('#rv-closeout-summary')).toContainText('20m');
  await expect(page.locator('#rv-plan-vs-actual')).toBeVisible();

  await page.locator('#rv-win').fill('Shipped the report');
  await page.locator('#rv-waste').fill('Scrolling');
  await page.locator('#rv-avoid').fill('Block the feed');
  await page.locator('#review-overlay').getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('#review-overlay')).not.toHaveClass(/open/);
  await expect(page.locator('#closeout-title')).toHaveText('Day closed');
  await expect(page.locator('#closeout-action')).toHaveText('Edit review');
});

test('missed closeout recovery reviews yesterday and writes today plan', async ({ page }) => {
  const yesterday = utcDateKey(Date.now() - DAY_MS);
  await openApp(page, {
    entries: [datedEntry(yesterday, 10, 11, 'Write report')],
    plans: planForDate(yesterday, [{ task: 'Write report', done: true }, { task: 'Gym', done: false }])
  });

  await expect(page.locator('#missed-closeout-card')).toBeVisible();
  await expect(page.locator('#missed-closeout-title')).toHaveText("Yesterday wasn't closed");
  await expect(page.locator('#missed-closeout-stats')).toContainText('1/2 plan');
  await expect(page.locator('#missed-closeout-stats')).toContainText('1h deep');

  await page.locator('#missed-closeout-card').click();
  await expect(page.locator('#review-overlay')).toHaveClass(/open/);
  await expect(page.locator('#rv-date-label')).not.toHaveText('');
  await expect(page.locator('#rv-plan-vs-actual')).toContainText('Write report');

  await page.locator('#rv-win').fill('Closed yesterday late');
  await page.locator('#rv-plan-task').fill('Today focus');
  await page.locator('#rv-plan-add').getByRole('button', { name: 'Add' }).click();
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
  expect(result.todayTasks).toContain('Today focus');
});

test('reference-class line reports what you actually do on that weekday', async ({ page }) => {
  // Tomorrow's weekday recurs at today-6 and today-13.
  const sameWeekday = daysAgo => {
    const start = Date.now() - daysAgo * DAY_MS;
    const end   = start + 2 * 60 * 60 * 1000;   // 2h deep
    return {
      id: end, ts: end, tsStart: start, updatedAt: end, blockIntervalMin: 120,
      date: utcDateKey(start), activity: 'Deep work', energy: 'deep',
      category: 'deep_work', originalLabel: 'deep', onPlan: true, retro: false
    };
  };
  await openApp(page, { entries: [sameWeekday(6), sameWeekday(13)] });
  await page.evaluate(() => openReview());

  const ref = page.locator('#rv-plan-ref');
  await expect(ref).toBeVisible();
  await expect(ref).toContainText('On a typical');
  await expect(ref).toContainText('2.0h of deep work');
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

  await page.locator('.plan-item').first().locator('.plan-start').click();
  await page.evaluate(() => openQuickLog());
  await page.locator('.ql-plan-chip').first().click();

  // No history for it -> the form opens pre-filled instead of mislabelling the entry.
  await expect(page.locator('#quicklog-overlay')).toHaveClass(/open/);
  await expect(page.locator('#ql-activity')).toHaveValue('Brand new task');
});
