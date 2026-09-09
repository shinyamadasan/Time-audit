import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addLesson, addPhase, addStep, completeStep, createLearningPlan } from '../learning-plan-model.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';
const NOW = Date.parse('2026-09-08T18:00:00Z');
const TARGET = '2026-09-09';
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const listeners = new Map();
  window.__firebasePlanWriteCount = 0;
  window.__emitFirebaseValue = (refPath, value) => (listeners.get(refPath) || []).forEach(cb => cb(snapshot(value)));
  const makeRef = refPath => {
    const countPlanWrite = () => { if (refPath.includes('/plans')) window.__firebasePlanWriteCount++; };
    return ({
    path: refPath, child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) { if (eventName === 'value') { const rows = listeners.get(refPath) || []; rows.push(cb); listeners.set(refPath, rows); setTimeout(() => cb(snapshot(null)), 0); } return cb; },
    off() {}, once() { return Promise.resolve(snapshot(null)); }, update() { countPlanWrite(); return Promise.resolve(); },
    set() { countPlanWrite(); return Promise.resolve(); }, remove() { countPlanWrite(); return Promise.resolve(); },
    transaction(updateFn) { countPlanWrite(); const value = updateFn(null); return Promise.resolve({ committed: true, snapshot: snapshot(value) }); },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
    });
  };
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'plan-user', displayName: 'Plan User', email: 'plan@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(config) { const app = { config }; this.apps.push(app); return app; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
})();`;

const routine = (overrides = {}) => ({ id: 'routine-1', createdDate: '2026-09-01', title: 'Deep work', enabled: true, cadence: 'daily', days: [], mode: 'exact', time: '09:00', endTime: '', cue: '', targetMinutes: 30, minimumMinutes: 10, fallback: 'Do 5 minutes', source: 'manual', planId: '', workoutRoutineId: '', ...overrides });
const routineState = (routines = [], timezone = 'Etc/UTC', extra = {}) => ({ schemaVersion: 1, timezone, routines, manual: {}, links: {}, focus: {}, skips: {}, ...extra });
const planItem = (id, task, extra = {}) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: NOW, ...extra });

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

async function openApp(page, { timezone = 'Etc/UTC', routines = [], plans = {}, learningPlans = null, failPlanWrite = false, deviceId = 'device-test', firebaseScript = firebaseStub } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseScript }));
  await page.addInitScript(({ timezone, routines, plans, learningPlans, now, failPlanWrite, deviceId }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', timezone);
    localStorage.setItem('ta3-device-id', deviceId);
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', '[]'); localStorage.setItem('ta3-focus-redemptions', '[]'); localStorage.setItem('ta3-reviews', '{}'); localStorage.setItem('ta3-plans', JSON.stringify(plans));
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify(routines));
    if (learningPlans) localStorage.setItem('ta3-learning-plans-v1', JSON.stringify(learningPlans));
    if (failPlanWrite) {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === 'ta3-plans') throw new Error('Plan quota exceeded'); return set.call(this, key, value); };
    }
  }, { timezone, routines, plans, learningPlans, now: NOW, failPlanWrite, deviceId });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof openPlanTomorrow === 'function' && typeof getPlanTomorrowAppContext === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
  await page.evaluate(() => openPlanTomorrow());
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
}


async function today(page, options = {}) {
  await openApp(page, { routines: routineState([]), ...options });
  await page.locator('[data-pt-action="close"]').first().click();
  await page.evaluate(() => { renderTodayPlan(); renderDailyRoutines(); });
}

test('no-plan day starts ordinary admin without a planning ceremony or skill inference', async ({ page }) => {
  await today(page);
  await expect(page.locator('#morning-startup')).toHaveCount(0);
  await expect(page.locator('#hero-context-prompt')).toHaveText('What are you working on?');
  await page.locator('#hero-task-input').click();
  await page.locator('#hero-task-input').fill('Ordinary admin');
  await page.locator('#hero-idle').getByRole('button', { name: 'Start', exact: true }).click();
  expect(await page.evaluate(() => ({ running, currentTask, learning: activeFocusLearningPlan }))).toEqual({ running: true, currentTask: 'Ordinary admin', learning: null });
});

for (const kind of ['priorities', 'routines', 'open', 'rescue']) {
  test(`prepared ${kind} day stays usable without startup planning`, async ({ page }) => {
    await today(page, { routines: routineState(kind === 'routines' ? [routine({ mode: 'anytime' })] : []) });
    await page.evaluate(kind => {
      const targetDate = planTodayKey();
      const routineRows = getPlanTomorrowRoutineSummary(targetDate).rows;
      confirmPreparedDatePlan({ targetDate, items: kind === 'priorities' ? [createPlanItem('Client build', '')] : [], mode: kind === 'rescue' ? 'rescue' : 'normal', intentionalBlank: ['open', 'rescue'].includes(kind), routineInstanceIds: routineRows.map(r => r.id), actionableRoutineInstanceIds: routineRows.map(r => r.id) });
      renderTodayPlan(); renderDailyRoutines();
    }, kind);
    await expect(page.locator('#morning-startup')).toHaveCount(0);
    await expect(page.locator('#plan-strip')).toContainText('Priorities');
    if (kind === 'priorities') {
      await expect(page.locator('#today-action-title')).toHaveText('Client build');
      await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
      expect(await page.evaluate(() => ({ task: getFocusTaskLabel(), phase: pomodoroPhase }))).toEqual({ task: 'Client build', phase: 'work' });
    }
  });
}

test('due routine wins, skip preserves intent and exposes the priority', async ({ page }) => {
  await today(page, { routines: routineState([routine({ time: '00:00', fallback: 'Later today' })]) });
  await page.evaluate(() => { savePlanItems(planTodayKey(), [createPlanItem('Client build', '')]); renderDailyRoutines(); });
  await expect(page.locator('#today-action-title')).toHaveText('Deep work');
  await page.locator('#routine-details > summary').click();
  await page.getByRole('button', { name: 'Skip today', exact: true }).click();
  await expect(page.locator('#today-action-title')).toHaveText('Client build');
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('ta3-daily-routines-v1')).skips).length)).toBe(1);
});

test('Review saves without preparing tomorrow and preserves legacy reflection', async ({ page }) => {
  await today(page);
  await page.evaluate(() => { reviews[planTodayKey()] = { tomorrow: 'Old reflection' }; openReview(); });
  await page.locator('#rv-win').fill('Shipped client fix');
  await page.locator('#review-overlay').getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => ({ review: reviews[planTodayKey()], tomorrow: plans[PlanTomorrowModel.planTomorrowTargetDate(Date.now(), settings.timezone)] || null }))).toMatchObject({ review: { win: 'Shipped client fix', tomorrow: 'Old reflection' }, tomorrow: null });
});

test('Review links to one editor and leaves the draft reflection intact', async ({ page }) => {
  await today(page);
  await page.evaluate(() => openReview());
  await page.locator('#rv-win').fill('Draft win');
  await page.locator('#review-overlay').getByRole('button', { name: 'Prepare tomorrow', exact: true }).click();
  await expect(page.locator('#review-overlay')).not.toHaveClass(/open/);
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
  await expect(page.locator('#rv-win')).toHaveValue('Draft win');
});

test('sleep and Review eligibility never interrupt active Focus', async ({ page }) => {
  await today(page);
  await page.evaluate(() => { settings.sleepSetupDone = false; enterFocusMode({ task: 'Client build', autoStart: true }); checkReviewPrompt(); checkSleepReminder(); });
  await page.waitForTimeout(3700);
  await expect(page.locator('#sleep-setup-overlay')).toBeHidden();
  await expect(page.locator('#sleep-reminder-overlay')).toBeHidden();
  await expect(page.locator('#review-overlay')).not.toHaveClass(/open/);
  expect(await page.evaluate(() => pomodoroPhase)).toBe('work');
  await page.evaluate(() => { settings.sleepSetupDone = true; checkSleepReminder(); });
  await expect(page.locator('#sleep-reminder-overlay')).toBeHidden();
});

test('Review contrasts untouched priorities with unplanned actual time', async ({ page }) => {
  await today(page);
  await page.evaluate(() => {
    savePlanItems(planTodayKey(), [createPlanItem('Workout', '')]);
    entries.push({ id: 100, tsStart: Date.now() - 3600000, ts: Date.now(), date: planTodayKey(), activity: 'Unplanned debugging', energy: 'deep', blockIntervalMin: 60 });
    openReview();
  });
  await expect(page.locator('#rv-plan-vs-actual')).toContainText('Not done');
  await expect(page.locator('#rv-plan-vs-actual')).toContainText('Unplanned debugging');
});

test('scheduled Learning starts from Today, preserves provenance, then returns after Done', async ({ page }) => {
  let plan = createLearningPlan({ title: 'Automation' });
  plan = addPhase(plan, { title: 'Build' });
  plan = addLesson(plan, plan.phases[0].id, { title: 'Webhooks' });
  plan = addStep(plan, plan.phases[0].lessons[0].id, { title: 'Practice webhook handling' });
  await today(page, { routines: routineState([routine({ source: 'learning', planId: plan.id, mode: 'anytime' })]), learningPlans: { schemaVersion: 1, plans: [plan] } });
  await expect(page.locator('#today-action-title')).toHaveText('Practice webhook handling');
  await page.locator('#today-action-primary').click();
  expect(await page.evaluate(() => getFocusLearningPlanMetadata().planId)).toBe(plan.id);
  await page.evaluate(() => { focusStartTime = Date.now() - 30 * 60000; endWorkSession(); });
  await page.getByRole('region', { name: 'Focus outcome' }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('#nav-today')).toHaveClass(/active/);
  await expect(page.locator('#daily-routines')).toContainText('1 / 1');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-entries')).length)).toBe(1);
});

test('Learning plans without a scheduled occurrence create no daily obligation', async ({ page }) => {
  let plan = createLearningPlan({ title: 'Optional learning' });
  plan = addPhase(plan, { title: 'Phase' });
  plan = addLesson(plan, plan.phases[0].id, { title: 'Lesson' });
  plan = addStep(plan, plan.phases[0].lessons[0].id, { title: 'Study later' });
  await today(page, { learningPlans: { schemaVersion: 1, plans: [plan] } });
  await expect(page.locator('#up-next')).not.toContainText('Study later');
  await page.evaluate(() => openPlanTomorrow());
  await expect(page.locator('#plan-tomorrow-body')).not.toContainText('Study later');
});

test('Today keeps one primary action usable at phone and desktop widths', async ({ page }) => {
  await today(page);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('#hero-task-input')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/today-${width}.png`, fullPage: false, animations: 'disabled' });
  }
});

test('Focus on a manual routine hands off its label without claiming completion', async ({ page }) => {
  await today(page, { routines: routineState([routine({ mode: 'anytime' })]) });
  await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
  expect(await page.evaluate(() => getFocusTaskLabel())).toBe('Deep work');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-daily-routines-v1') || '{"manual":{}}').manual)).toEqual({});
});

test('planned routine activity is not presented as unplanned work', async ({ page }) => {
  await today(page, { routines: routineState([routine({ mode: 'anytime' })]) });
  await page.evaluate(() => {
    const targetDate = planTodayKey();
    const rows = getPlanTomorrowRoutineSummary(targetDate).rows;
    confirmPreparedDatePlan({ targetDate, items: [], mode: 'normal', intentionalBlank: false, routineInstanceIds: rows.map(r => r.id), actionableRoutineInstanceIds: rows.map(r => r.id) });
    entries.push({ id: 101, tsStart: Date.now() - 1800000, ts: Date.now(), date: targetDate, activity: 'Deep work', energy: 'deep', blockIntervalMin: 30 });
    openReview();
  });
  await expect(page.locator('#rv-plan-vs-actual')).toContainText('Deep work');
  await expect(page.locator('#rv-plan-vs-actual')).not.toContainText('Unplanned tracked activity');
});

for (const activities of [[], ['Unplanned debugging'], ['Unplanned debugging', 'Customer support']]) {
  test(`Review renders unplanned activity once with two priorities (${activities.length} activities)`, async ({ page }) => {
    await today(page);
    const before = await page.evaluate(activities => {
      const items = [createPlanItem('Client build', ''), createPlanItem('Workout', '')];
      items[0].done = true; items[0].doneAt = Date.now();
      savePlanItems(planTodayKey(), items);
      entries.push(...activities.map((activity, index) => ({ id: 500 + index, tsStart: Date.now() - (index + 1) * 3600000, ts: Date.now() - index * 3600000, date: planTodayKey(), activity, energy: 'deep', blockIntervalMin: 60 })));
      const before = JSON.stringify(entries);
      openReview();
      return before;
    }, activities);
    const review = page.locator('#rv-plan-vs-actual');
    const section = review.locator('.rv-pva:has(> .rv-pva-head:text-is("Unplanned tracked activity"))');
    await expect(section).toHaveCount(activities.length ? 1 : 0);
    if (activities.length) {
      await expect(section.locator(':scope > .rv-pva-row')).toHaveCount(activities.length);
      for (const activity of activities) await expect(section.locator(':scope > .rv-pva-row').filter({ hasText: activity })).toHaveCount(1);
    }
    const planned = review.locator(':scope > .rv-pva').first();
    await expect(planned.locator(':scope > .rv-pva-row')).toHaveCount(2);
    await expect(planned.locator(':scope > .rv-pva-head')).toHaveText('Planned 2 · active 2 · done/worked on 1');
    await expect(planned.locator('.rv-pva-row').filter({ hasText: 'Client build' })).toContainText('Done');
    await expect(planned.locator('.rv-pva-row').filter({ hasText: 'Workout' })).toContainText('Not done');
    expect(await page.evaluate(() => JSON.stringify(entries))).toBe(before);
  });
}
