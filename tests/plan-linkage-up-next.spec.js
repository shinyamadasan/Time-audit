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

/** Same "today, but at a chosen UTC hour" pattern as stableNowTs(), parameterized so due-time
 *  tests can control exactly which planned times are already due. */
function nowAtUTC(hour, minute = 0) {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0);
}

function stableEntryWindow(startMsAgo, endMsAgo, nowTs = Date.now()) {
  const duration = startMsAgo - endMsAgo;
  const rawStart = nowTs - startMsAgo;
  const base = new Date(startMsAgo < DAY_MS ? nowTs : rawStart);
  const start = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 12, 0, 0);
  return { start, end: start + duration };
}

function deepEntry(startMsAgo, endMsAgo, activity, nowTs = Date.now(), extra = {}) {
  const { start, end } = stableEntryWindow(startMsAgo, endMsAgo, nowTs);
  return {
    id: end, ts: end, tsStart: start, updatedAt: end,
    blockIntervalMin: Math.round((end - start) / 60000),
    date: utcDateKey(start), activity, energy: 'deep', category: 'deep_work',
    originalLabel: 'deep', onPlan: true, retro: false, ...extra
  };
}

async function openApp(page, { entries = [], plans = {}, reviews = {}, settings = {}, routines = null, nowTs = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: firebaseStub
  }));
  await page.addInitScript(({ entries, plans, reviews, settings, routines, nowTs }) => {
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
    if (routines) localStorage.setItem('ta3-daily-routines-v1', JSON.stringify(routines));
    localStorage.setItem('ta3-test-seeded', '1');
  }, { entries, plans, reviews, settings: baseSettings(settings), routines, nowTs });
  await page.goto(APP_URL);
  await page.waitForFunction(() => typeof window.renderTodayPlan === 'function' && typeof window.openPlanTomorrow === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

/** Build a plan for today with the given items ({task, when, done}). */
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

/** A single exact-mode routine due "Now" at `time` (HH:MM), matching daily-routines-model.js's
 *  validateRoutine() shape. source:'manual' keeps completion out of scope for these tests —
 *  only UP NEXT's precedence choice is under test here. */
function routineEnvelope({ id = 'r1', title = 'Morning pages', time = '09:00', mode = 'exact', source = 'manual' } = {}) {
  return {
    schemaVersion: 1,
    timezone: 'UTC',
    routines: [{
      id, title, enabled: true, createdDate: '2020-01-01',
      cadence: 'daily', days: [],
      mode, time, endTime: null,
      targetMinutes: 30, minimumMinutes: null, fallback: '',
      source, planId: null, workoutRoutineId: null
    }],
    manual: {}, links: {}, focus: {}, skips: {}
  };
}

test('A: starting a planned item stamps the resulting entry with its plan item id', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Client automation build' }]) });
  const planItemId = await page.evaluate(() => getPlanItems(planTodayKey())[0].id);

  await page.locator('#plan-strip').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.plan-item').first().locator('.plan-start').click();
  expect(await page.evaluate(() => currentTaskPlanItemId)).toBe(planItemId);

  // stopAndLog() only logs a >=1-minute block — rewind the (real, un-mocked) start clock
  // rather than waiting on a live minute to pass.
  await page.evaluate(() => { taskStartTime -= 5 * 60000; blockStartTime -= 5 * 60000; });
  await page.evaluate(() => stopAndLog());
  const created = await page.evaluate(() => entries);
  expect(created).toHaveLength(1);
  expect(created[0].activity).toBe('Client automation build');
  expect(created[0].planItemId).toBe(planItemId);
});

test('B: focusing a planned item retains the same plan item id on the Focus completion entry', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Client automation build' }]) });
  const planItemId = await page.evaluate(() => getPlanItems(planTodayKey())[0].id);

  await page.evaluate(() => focusTodayAction());
  await expect(page.locator('#focus-overlay')).toHaveClass(/open/);
  expect(await page.evaluate(() => pomodoroPhase)).toBe('work');
  expect(await page.evaluate(() => activeFocusPlanItemId)).toBe(planItemId);

  // Manual early exit still uses real elapsed time — rewind the phase start so a real
  // >=1-minute session is on record without waiting on a live pomodoro countdown.
  await page.evaluate(() => { focusStartTime -= 5 * 60000; });
  const entry = await page.evaluate(() => saveActiveFocusSession());
  expect(entry).toBeTruthy();
  expect(entry.planItemId).toBe(planItemId);
  expect(entry.activity).toBe('Client automation build');
});

test('C: a plan item started/linked stays "Worked on" in Review even if its logged text later differs', async ({ page }) => {
  const nowTs = stableNowTs();
  // Models the end-state of: start linked (id stamped) -> entry text edited afterward
  // (e.g. a retro correction) without touching planItemId — the exact failure mode the prior
  // text-only matching mis-scored as "not done" even though the linked work happened.
  const plans = planFor([{ task: 'Client automation build' }]);
  const linkedId = plans[todayKey()].items[0].id;
  const entries = [deepEntry(90 * 60 * 1000, 45 * 60 * 1000, 'Client build', nowTs, { planItemId: linkedId })];

  await openApp(page, { entries, plans, nowTs });
  await page.evaluate(() => openReview());
  await page.locator('#rv-full-analysis > summary').click();

  const row = page.locator('.rv-pva-row').filter({ hasText: 'Client automation build' });
  await expect(row.locator('.rv-pva-min')).toHaveText('Worked on');
});

test('D: a legacy entry with no plan item id still matches by exact normalized text', async ({ page }) => {
  const nowTs = stableNowTs();
  const entries = [deepEntry(90 * 60 * 1000, 45 * 60 * 1000, 'Write report', nowTs)]; // no planItemId
  await openApp(page, { entries, plans: planFor([{ task: 'Write report' }]), nowTs });
  await page.evaluate(() => openReview());
  await page.locator('#rv-full-analysis > summary').click();

  const row = page.locator('.rv-pva-row').filter({ hasText: 'Write report' });
  await expect(row.locator('.rv-pva-min')).toHaveText('Worked on');
});

test('E: unlinked, unrelated manual work stays Unplanned tracked activity, never double-counted', async ({ page }) => {
  const nowTs = stableNowTs();
  const entries = [deepEntry(90 * 60 * 1000, 45 * 60 * 1000, 'Random errand', nowTs)];
  await openApp(page, { entries, plans: planFor([{ task: 'Write report' }]), nowTs });
  await page.evaluate(() => openReview());
  await page.locator('#rv-full-analysis > summary').click();

  const planned = page.locator('.rv-pva-row').filter({ hasText: 'Write report' });
  await expect(planned.locator('.rv-pva-min')).toHaveText('Not done');
  const unplannedSection = page.locator('.rv-pva:has(> .rv-pva-head:text-is("Unplanned tracked activity"))');
  await expect(unplannedSection.locator('.rv-pva-row')).toContainText('Random errand');
});

test('F: explicit Done stays independent of tracked minutes even with id-linked entries', async ({ page }) => {
  const nowTs = stableNowTs();
  const plans = planFor([{ task: 'Write report' }]);
  const linkedId = plans[todayKey()].items[0].id;
  // Tracked time exists (id-linked) but the item was never checked done.
  const entries = [deepEntry(90 * 60 * 1000, 45 * 60 * 1000, 'Write report', nowTs, { planItemId: linkedId })];
  await openApp(page, { entries, plans, nowTs });

  await expect(page.locator('.plan-item').first().locator('.plan-status')).toHaveText('Logged');
  await expect(page.locator('.plan-item').first()).not.toHaveClass(/done/);
});

test('G: a removed planned item is still shown as Removed in Review, id linkage untouched', async ({ page }) => {
  const nowTs = stableNowTs();
  await openApp(page, { plans: planFor([{ task: 'Write report' }, { task: 'Gym' }]), nowTs });
  await page.evaluate(async () => {
    const items = getPlanItemsRaw(planTodayKey());
    await confirmPreparedDatePlan({ targetDate: planTodayKey(), items, mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  });
  if (!(await page.locator('#plan-strip').getAttribute('class')).includes('editing')) {
    await page.locator('#plan-strip').getByRole('button', { name: 'Edit', exact: true }).click();
  }
  await page.locator('.plan-item').first().locator('.plan-remove').click();

  await page.evaluate(() => openReview());
  await page.locator('#rv-full-analysis > summary').click();
  const row = page.locator('.rv-pva-row').filter({ hasText: 'Write report' });
  await expect(row.locator('.rv-pva-min')).toHaveText('Removed');
});

test('H: 09:00 and 13:00 priorities entered out of order — due selection respects parseable time, not array order', async ({ page }) => {
  const nowTs = nowAtUTC(10, 0); // 10:00 — only the 09:00 item is due
  await openApp(page, {
    plans: planFor([{ task: 'Afternoon sync', when: '13:00' }, { task: 'Morning review', when: '09:00' }]),
    nowTs
  });
  const next = await page.evaluate(() => getNextPlanItem(planTodayKey()));
  expect(next.task).toBe('Morning review');
  const state = await page.evaluate(() => todayGuidedAction());
  expect(state.task).toBe('Morning review');
});

test('I: an unparseable when is never treated as due — safe fallback, no guessing', async ({ page }) => {
  const nowTs = nowAtUTC(10, 0);
  await openApp(page, {
    plans: planFor([{ task: 'Write report', when: 'after lunch' }, { task: 'Gym', when: '' }]),
    nowTs
  });
  const due = await page.evaluate(() => dueTimedPlanItem(getPlanItems(planTodayKey()), planTodayKey()));
  expect(due).toBeNull();
  const next = await page.evaluate(() => getNextPlanItem(planTodayKey()));
  expect(next.task).toBe('Write report'); // stable existing order, not a guess at "after lunch"
});

test('J: a blank when falls back to normal order, same as before', async ({ page }) => {
  const nowTs = nowAtUTC(10, 0);
  await openApp(page, { plans: planFor([{ task: 'Write report' }, { task: 'Gym' }]), nowTs });
  const next = await page.evaluate(() => getNextPlanItem(planTodayKey()));
  expect(next.task).toBe('Write report');
});

test('K: a due timed one-off outranks a due-now routine in UP NEXT', async ({ page }) => {
  const nowTs = nowAtUTC(9, 15); // both the 09:00 plan item and the 09:00 routine are due
  await openApp(page, {
    plans: planFor([{ task: 'Client automation build', when: '09:00' }]),
    routines: routineEnvelope({ time: '09:00' }),
    nowTs
  });
  const state = await page.evaluate(() => todayGuidedAction());
  expect(state.task).toBe('Client automation build');
  expect(state.action).toBe('startNextPlanItem()');
});

test('L: with no due timed one-off, a due-now routine may win', async ({ page }) => {
  const nowTs = nowAtUTC(9, 15);
  await openApp(page, {
    // Planned but not timed — not "due", so it must not preempt the routine.
    plans: planFor([{ task: 'Client automation build' }]),
    routines: routineEnvelope({ time: '09:00' }),
    nowTs
  });
  const state = await page.evaluate(() => todayGuidedAction());
  expect(state.action).toBe('startTodayRoutineAction()');
});

test('M: worked-on vs done vs not-done stay distinct under id-preferred matching', async ({ page }) => {
  const nowTs = stableNowTs();
  const plans = planFor([
    { task: 'Client automation build', done: true },
    { task: 'Write report' },
    { task: 'Gym' }
  ]);
  const [doneId, workedId] = plans[todayKey()].items.map(i => i.id);
  const entries = [
    deepEntry(90 * 60 * 1000, 45 * 60 * 1000, 'Client automation build', nowTs, { planItemId: doneId }),
    deepEntry(60 * 60 * 1000, 30 * 60 * 1000, 'Write report', nowTs, { planItemId: workedId })
  ];
  await openApp(page, { entries, plans, nowTs });
  await page.evaluate(() => openReview());
  await page.locator('#rv-full-analysis > summary').click();

  await expect(page.locator('.rv-pva-row').filter({ hasText: 'Client automation build' }).locator('.rv-pva-min')).toHaveText('Done');
  await expect(page.locator('.rv-pva-row').filter({ hasText: 'Write report' }).locator('.rv-pva-min')).toHaveText('Worked on');
  await expect(page.locator('.rv-pva-row').filter({ hasText: 'Gym' }).locator('.rv-pva-min')).toHaveText('Not done');
});

test('N: no plan and no routines still falls back gracefully to free-text work', async ({ page }) => {
  await openApp(page);
  const state = await page.evaluate(() => todayGuidedAction());
  expect(state.action).toBe("document.getElementById('hero-task-input').focus()");
  await expect(page.locator('#hero-context-prompt')).toHaveText('What are you working on?');
});

test('O: Today still shows the full plan strip (all priorities, not just one)', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Write report' }, { task: 'Gym' }, { task: 'Email triage' }]) });
  await expect(page.locator('.plan-item')).toHaveCount(3);
  await expect(page.locator('.plan-count')).toHaveText('0 of 3 done');
});

test('P: Review Plan-vs-Actual still renders with the existing summary line', async ({ page }) => {
  const nowTs = stableNowTs();
  await openApp(page, {
    entries: [deepEntry(90 * 60 * 1000, 45 * 60 * 1000, 'Write report', nowTs)],
    plans: planFor([{ task: 'Write report', done: true }, { task: 'Gym' }]),
    nowTs
  });
  await page.evaluate(() => openReview());
  await page.locator('#rv-full-analysis > summary').click();
  await expect(page.locator('#rv-plan-vs-actual')).toBeVisible();
  await expect(page.locator('.rv-pva-head').first()).toHaveText('Planned 2 · active 2 · done/worked on 1');
});

test('Q: an ordinary unplanned Start never gets a fabricated plan item id', async ({ page }) => {
  await openApp(page);
  await page.locator('#hero-task-input').click();
  await page.locator('#hero-task-input').fill('Random task');
  await page.locator('.hero-start-row').getByRole('button', { name: 'Start', exact: true }).click();
  expect(await page.evaluate(() => currentTaskPlanItemId)).toBeNull();
  await page.evaluate(() => { taskStartTime -= 5 * 60000; blockStartTime -= 5 * 60000; });
  await page.evaluate(() => stopAndLog());
  const created = await page.evaluate(() => entries);
  expect(created).toHaveLength(1);
  expect(created[0].planItemId).toBeUndefined();
});

test('R: a focus-linked routine start never picks up a stray plan item id', async ({ page }) => {
  await openApp(page, { routines: routineEnvelope({ time: '09:00', source: 'focus' }), nowTs: nowAtUTC(9, 15) });
  await page.evaluate(() => startTodayRoutineAction());
  await expect(page.locator('#focus-overlay')).toHaveClass(/open/);
  expect(await page.evaluate(() => activeFocusPlanItemId)).toBeNull();
});

// ── Targeted re-review fixes ─────────────────────────────────────────────

test('S: at 08:00, before either planned time is due, UP NEXT and the plan strip agree on the earlier (09:00) item', async ({ page }) => {
  const nowTs = nowAtUTC(8, 0);
  await openApp(page, {
    // 13:00 typed first, 09:00 second — array/insertion order must not decide this.
    plans: planFor([{ task: 'Aly & Pon', when: '13:00' }, { task: 'Client work', when: '09:00' }]),
    nowTs
  });
  const next = await page.evaluate(() => getNextPlanItem(planTodayKey()));
  expect(next.task).toBe('Client work');
  const state = await page.evaluate(() => todayGuidedAction());
  expect(state.task).toBe('Client work');
  await expect(page.locator('.plan-item').first().locator('.plan-task')).toContainText('Client work');
});

test('T: an already-worked-on-but-not-done morning item does not block a newly-due afternoon item', async ({ page }) => {
  const nowTs = nowAtUTC(13, 30);
  const plans = planFor([{ task: 'Client work', when: '09:00' }, { task: 'Aly & Pon', when: '13:00' }]);
  const workedId = plans[todayKey()].items[0].id;
  const entries = [deepEntry(90 * 60 * 1000, 60 * 60 * 1000, 'Client work', nowTs, { planItemId: workedId })]; // 30m tracked, not Done
  await openApp(page, { entries, plans, nowTs });

  const next = await page.evaluate(() => getNextPlanItem(planTodayKey()));
  expect(next.task).toBe('Aly & Pon');
  const state = await page.evaluate(() => todayGuidedAction());
  expect(state.task).toBe('Aly & Pon');
  // The worked-on item is still available, not silently marked complete.
  await expect(page.locator('.plan-item').filter({ hasText: 'Client work' }).locator('.plan-status')).toHaveText('Logged');
});

test('U: an ordinary plan-linked timer survives reload with its plan item id intact', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Client automation build' }]) });
  const planItemId = await page.evaluate(() => getPlanItems(planTodayKey())[0].id);

  await page.locator('#plan-strip').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.plan-item').first().locator('.plan-start').click();
  expect(await page.evaluate(() => currentTaskPlanItemId)).toBe(planItemId);

  await page.reload();
  await page.waitForFunction(() => typeof window.renderTodayPlan === 'function');
  expect(await page.evaluate(() => running)).toBe(true);
  expect(await page.evaluate(() => currentTaskPlanItemId)).toBe(planItemId);

  await page.evaluate(() => { taskStartTime -= 5 * 60000; blockStartTime -= 5 * 60000; });
  await page.evaluate(() => stopAndLog());
  const created = await page.evaluate(() => entries);
  expect(created).toHaveLength(1);
  expect(created[0].planItemId).toBe(planItemId);
});

test('U2: a pre-existing ta3-timer blob with no planItemId field restores safely with no fabricated linkage', async ({ page }) => {
  const nowTs = nowAtUTC(10, 0);
  await openApp(page, { nowTs });
  await page.evaluate((now) => {
    localStorage.setItem('ta3-timer', JSON.stringify({
      timerStartedAt: now - 5 * 60000, totalSecs: 1800, running: true,
      lastTask: 'Old task', currentTask: 'Old task',
      taskStartTime: now - 5 * 60000, blockStartTime: now - 5 * 60000,
      timerUpdatedAt: now, ownerDeviceId: null
      // deliberately no planItemId key — the pre-migration shape
    }));
  }, nowTs);

  await page.reload();
  await page.waitForFunction(() => typeof window.renderTodayPlan === 'function');
  expect(await page.evaluate(() => running)).toBe(true);
  expect(await page.evaluate(() => currentTask)).toBe('Old task');
  expect(await page.evaluate(() => currentTaskPlanItemId)).toBeNull();
});

test('V: a Focus session started from a plan item survives reload with its plan item id intact', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Client automation build' }]) });
  const planItemId = await page.evaluate(() => getPlanItems(planTodayKey())[0].id);

  await page.evaluate(() => focusTodayAction());
  await expect(page.locator('#focus-overlay')).toHaveClass(/open/);
  expect(await page.evaluate(() => activeFocusPlanItemId)).toBe(planItemId);

  await page.reload();
  await page.waitForFunction(() => typeof window.renderTodayPlan === 'function');
  expect(await page.evaluate(() => pomodoroPhase)).toBe('work');
  expect(await page.evaluate(() => activeFocusPlanItemId)).toBe(planItemId);

  await page.evaluate(() => { focusStartTime -= 5 * 60000; });
  const entry = await page.evaluate(() => saveActiveFocusSession());
  expect(entry).toBeTruthy();
  expect(entry.planItemId).toBe(planItemId);
});

test('W: switching between two planned items never leaks the first plan item id onto the second entry', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Client automation build' }, { task: 'Gym' }]) });
  const [p1, p2] = await page.evaluate(() => getPlanItems(planTodayKey()));

  await page.locator('#plan-strip').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.plan-item').first().locator('.plan-start').click();
  expect(await page.evaluate(() => currentTaskPlanItemId)).toBe(p1.id);

  await page.evaluate(id => startPlanItem(id), p2.id); // switches mid-block, forced-min-1m auto-log of P1
  expect(await page.evaluate(() => currentTaskPlanItemId)).toBe(p2.id);

  await page.evaluate(() => { taskStartTime -= 5 * 60000; blockStartTime -= 5 * 60000; });
  await page.evaluate(() => stopAndLog());

  const created = await page.evaluate(() => entries);
  expect(created).toHaveLength(2);
  expect(created.find(e => e.activity === 'Client automation build').planItemId).toBe(p1.id);
  expect(created.find(e => e.activity === 'Gym').planItemId).toBe(p2.id);
});

test('X: switching from a planned item to a manually typed task never leaks the plan item id forward', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Client automation build' }]) });
  const planItemId = await page.evaluate(() => getPlanItems(planTodayKey())[0].id);

  await page.locator('#plan-strip').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.plan-item').first().locator('.plan-start').click();
  expect(await page.evaluate(() => currentTaskPlanItemId)).toBe(planItemId);

  await page.evaluate(() => switchToTask('Random unplanned task')); // no id — the hero Switch path
  expect(await page.evaluate(() => currentTaskPlanItemId)).toBeNull();

  await page.evaluate(() => { taskStartTime -= 5 * 60000; blockStartTime -= 5 * 60000; });
  await page.evaluate(() => stopAndLog());

  const created = await page.evaluate(() => entries);
  expect(created).toHaveLength(2);
  expect(created.find(e => e.activity === 'Client automation build').planItemId).toBe(planItemId);
  expect(created.find(e => e.activity === 'Random unplanned task').planItemId).toBeUndefined();
});

test('Y: with multiple overdue unworked items, the earliest scheduled time wins (documented V1 behavior, not urgency scoring)', async ({ page }) => {
  const nowTs = nowAtUTC(14, 0);
  await openApp(page, { plans: planFor([{ task: 'P1', when: '09:00' }, { task: 'P2', when: '13:00' }]), nowTs });
  const next = await page.evaluate(() => getNextPlanItem(planTodayKey()));
  expect(next.task).toBe('P1');
  const due = await page.evaluate(() => dueTimedPlanItem(getPlanItems(planTodayKey()), planTodayKey()));
  expect(due.task).toBe('P1');
});

test('Z: the plan-when input is a native time picker producing canonical HH:MM, and historical free-text values still display safely', async ({ page }) => {
  await openApp(page, { plans: planFor([{ task: 'Legacy freeform', when: 'after lunch' }]) });
  await page.locator('#plan-strip').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#plan-when')).toHaveAttribute('type', 'time');
  // A historical free-text `when` still renders exactly as stored, never rewritten.
  await expect(page.locator('.plan-item').first().locator('.plan-when')).toHaveText('after lunch →');

  await page.locator('#plan-when').fill('09:30');
  await page.locator('#plan-task').fill('New timed item');
  await page.locator('#plan-strip').getByRole('button', { name: 'Add' }).click();
  const items = await page.evaluate(() => getPlanItems(planTodayKey()));
  expect(items.find(i => i.task === 'New timed item').when).toBe('09:30');
});
