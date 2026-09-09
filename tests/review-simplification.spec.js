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


async function review(page, historical = false) {
  await today(page);
  await page.evaluate(historical => {
    const key = historical ? '2026-09-07' : planTodayKey();
    const start = Date.parse(key + 'T09:00:00Z');
    entries = [{ id: 'morning', activity: 'Morning', energy: 'shallow', tsStart: start, ts: start + 30 * 60000, blockIntervalMin: 30 }];
    reviews[key] = { win: '', waste: 'Saved waste', avoid: 'Saved avoid', tomorrow: 'Legacy tomorrow\r\nSecond line', extraReflection: 'preserve me' };
    openReview(key);
  }, historical);
}
const saveReflection = page => page.locator('#review-overlay').getByRole('button', { name: 'Save reflection', exact: true });

test('default has two optional inputs, no grade, separate details and no automatic waste', async ({ page }) => {
  await today(page);
  await page.evaluate(() => {
    entries = [{ id: 'waste', activity: 'Facebook', energy: 'waste', tsStart: Date.now() - 3600000, ts: Date.now(), blockIntervalMin: 60 }];
    openReview();
  });
  await expect(page.locator('#rv-feeling')).toBeVisible();
  await expect(page.locator('#rv-win')).toBeVisible();
  await expect(page.locator('#rv-waste')).toBeHidden();
  await expect(page.locator('#rv-waste')).toHaveValue('');
  await expect(page.locator('#rv-attention')).toBeHidden();
  await expect(page.locator('#rv-plan-vs-actual')).toBeHidden();
  await expect(page.locator('#review-overlay')).not.toContainText(/Reality Score|You regressed|You moved forward/);
  await expect(page.locator('#rv-closeout-summary')).toContainText('1h recorded');
  await saveReflection(page).click();
  expect(await page.evaluate(() => reviews[planTodayKey()])).toMatchObject({ win: '', waste: '', avoid: '', focusRating: null });
});

for (const historical of [false, true]) {
  test(`collapsed historical fields survive save (${historical}) and feeling can clear`, async ({ page }) => {
    await review(page, historical);
    await page.locator('#rv-feeling').getByRole('button', { name: 'Focused', exact: true }).click();
    await page.locator('#rv-feeling').getByRole('button', { name: 'Focused', exact: true }).click();
    await saveReflection(page).click();
    const saved = await page.evaluate(historical => JSON.parse(localStorage.getItem('ta3-reviews'))[historical ? '2026-09-07' : planTodayKey()], historical);
    expect(saved).toMatchObject({ waste: 'Saved waste', avoid: 'Saved avoid', tomorrow: 'Legacy tomorrow\r\nSecond line', focusRating: null, extraReflection: 'preserve me', _savedAt: NOW });
    await page.evaluate(historical => openReview(historical ? '2026-09-07' : undefined), historical);
    await page.locator('#rv-optional-details > summary').click();
    await page.locator('#rv-waste').fill('');
    await page.locator('#rv-legacy-tomorrow').fill('');
    await saveReflection(page).click();
    expect(await page.evaluate(historical => reviews[historical ? '2026-09-07' : planTodayKey()].waste, historical)).toBe('');
  });
}

for (const action of ['cancel gap', 'save gap', 'cancel plan', 'save plan']) {
  test(`unsaved historical reflection survives ${action}`, async ({ page }) => {
    await review(page, true);
    await page.locator('#rv-win').fill('Hard debugging');
    await page.locator('#rv-feeling').getByRole('button', { name: 'Distracted', exact: true }).click();
    await page.locator('#rv-optional-details > summary').click();
    await page.locator('#rv-waste').fill('Draft waste');
    await page.locator('#rv-avoid').fill('Draft avoid');
    await page.locator('#rv-legacy-tomorrow').fill('Draft tomorrow');
    await page.locator('#rv-optional-details > summary').click();
    await page.locator('#rv-unlogged-decision').getByRole('button', { name: 'Leave unknown' }).click();
    const before = await page.evaluate(() => JSON.stringify(reviews));
    if (action.includes('gap')) {
      await page.locator('#rv-unlogged-decision').getByRole('button', { name: 'Log time' }).click();
      if (action === 'save gap') {
        await page.locator('#retro-activity').fill('Remembered lunch');
        await page.locator('#retro-overlay .energy-btn.social').click();
        await page.locator('#retro-overlay').getByRole('button', { name: 'Save', exact: true }).click();
      } else await page.locator('#retro-overlay').getByRole('button', { name: 'Cancel', exact: true }).click();
    } else {
      await expect(page.locator('#rv-tomorrow-status')).toContainText('2026-09-09, relative to today');
      await page.locator('#rv-tomorrow-status button').click();
      if (action === 'save plan') {
        await page.locator('[data-pt-action="blank"]').click();
        await page.locator('#plan-tomorrow-confirm').click();
      }
      else await page.locator('[data-pt-action="close"]').first().click();
    }
    await expect(page.locator('#review-overlay')).toHaveClass(/open/);
    if (action === 'save gap') expect(await page.evaluate(() => entries.find(e => e.activity === 'Remembered lunch'))).toMatchObject({ date: '2026-09-07', energy: 'social' });
    await expect(page.locator('#rv-win')).toHaveValue('Hard debugging');
    await expect(page.locator('#rv-waste')).toHaveValue('Draft waste');
    await expect(page.locator('#rv-avoid')).toHaveValue('Draft avoid');
    await expect(page.locator('#rv-legacy-tomorrow')).toHaveValue('Draft tomorrow');
    expect(await page.evaluate(() => ({ rating: _reviewFocusRating, unknown: _reviewUnloggedOk, reviews: JSON.stringify(reviews) }))).toEqual({ rating: 'distracted', unknown: true, reviews: before });
  });
}

test('unknown acknowledgement only saves on Save and leaves gaps intact; offline feeling persists', async ({ page, context }) => {
  await today(page);
  await page.evaluate(() => { entries = [{ id: 'morning', activity: 'Morning', energy: 'shallow', tsStart: Date.now() - 180 * 60000, ts: Date.now() - 150 * 60000, blockIntervalMin: 30 }]; openReview(); });
  const before = await page.evaluate(() => JSON.stringify(getCloseoutGaps(planTodayKey())));
  await page.locator('#rv-unlogged-decision').getByRole('button', { name: 'Leave unknown' }).click();
  await page.locator('#review-overlay').getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.evaluate(() => reviews[planTodayKey()])).toBeUndefined();
  await page.evaluate(() => openReview());
  await page.locator('#rv-unlogged-decision').getByRole('button', { name: 'Leave unknown' }).click();
  await page.locator('#rv-feeling').getByRole('button', { name: 'Mixed', exact: true }).click();
  await context.setOffline(true);
  await page.evaluate(() => { fbRoomRef = null; });
  await saveReflection(page).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-reviews'))[planTodayKey()])).toMatchObject({ unloggedOk: true, focusRating: 'mixed' });
  expect(await page.evaluate(() => JSON.stringify(getCloseoutGaps(planTodayKey())))).toBe(before);
  expect(await page.evaluate(() => getGapRecoveryCandidate(getViewingEntries()))).toBeFalsy();
  await page.evaluate(() => openReview());
  await expect(page.locator('#rv-feeling button[aria-pressed="true"]')).toHaveText('Mixed');
});

test('Today Details opens analysis; collapse leaves win and feeling unchanged', async ({ page }) => {
  await today(page);
  await page.locator('#so-far').getByRole('button', { name: 'Details' }).click();
  await expect(page.locator('#rv-full-analysis')).toHaveAttribute('open', '');
  await expect(page.locator('#rv-attention')).toBeVisible();
  await page.locator('#rv-win').fill('Draft');
  await page.locator('#rv-full-analysis > summary').click();
  await expect(page.locator('#rv-win')).toHaveValue('Draft');
  await expect(page.locator('#rv-attention')).toBeHidden();
});

for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 480 }, { width: 1280, height: 900 }]) {
  test(`layout and Save reachability ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await review(page);
    await page.locator('#rv-win').fill('A small win');
    const size = await page.locator('#review-overlay .review-modal').evaluate(el => ({ content: el.scrollHeight, height: el.clientHeight, overflow: el.scrollWidth > el.clientWidth }));
    expect(size.overflow).toBe(false);
    expect(size.content).toBeLessThan(800);
    for (let i = 0; i < 8 && !(await saveReflection(page).evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(saveReflection(page)).toBeFocused();
    await saveReflection(page).scrollIntoViewIfNeeded();
    const box = await saveReflection(page).boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: testInfo.outputPath('review.png') });
    console.log('REVIEW_LAYOUT', viewport, size, box);
    await page.locator('#rv-full-analysis > summary').click();
    await expect(page.locator('#rv-attention')).toBeVisible();
    await page.keyboard.press('Tab');
    await saveReflection(page).click();
    await expect(page.locator('#review-overlay')).not.toHaveClass(/open/);
  });
}

const scenarios = [
  ['perfect planned day', 'deep', 60, true, 'focused'], ['no plan', 'shallow', 30, null, null],
  ['partially done plan', 'deep', 20, false, 'mixed'], ['valuable unplanned activity', 'learning', 90, null, 'focused'],
  ['high classified distraction', 'distraction', 240, null, 'focused'], ['intentional Facebook use', 'social', 60, null, 'focused'],
  ['no deep work', 'errands', 50, false, null], ['long deep session', 'deep', 300, true, 'distracted'],
  ['no tracked time', 'shallow', 0, null, null], ['many missing gaps', 'shallow', 15, false, null],
  ['sleep missing', 'shallow', 30, null, null], ['routines incomplete', 'shallow', 30, false, null],
  ['difficult debugging / low visible output', 'deep', 180, false, 'distracted'],
  ['emergency changed whole day', 'social', 180, false, 'mixed'],
  ['feels productive despite weak metrics', 'shallow', 10, false, 'focused'],
  ['feels bad despite strong metrics', 'deep', 240, true, 'distracted'],
  ['empty win and waste / 30-second closeout / Advisor absent', 'waste', 20, null, null]
];
for (const [label, energy, minutes, planned, feeling] of scenarios) {
  test(`chaos: ${label}`, async ({ page }) => {
    await today(page, label === 'routines incomplete' ? { routines: routineState([routine()]) } : {});
    await page.evaluate(({ energy, minutes, planned, label }) => {
      const task = label === 'intentional Facebook use' ? 'Facebook' : label;
      entries = minutes ? [{ id: 'e1', activity: task, energy, tsStart: Date.now() - minutes * 60000, ts: Date.now(), blockIntervalMin: minutes }] : [];
      if (label === 'many missing gaps') entries.push({ id: 'e2', activity: 'Earlier', energy: 'shallow', tsStart: Date.now() - 240 * 60000, ts: Date.now() - 225 * 60000, blockIntervalMin: 15 });
      if (planned !== null) plans[planTodayKey()] = { items: [{ id: 'p1', task, done: planned, doneAt: planned ? Date.now() : null }, { id: 'p2', task: 'Another priority', done: planned, doneAt: planned ? Date.now() : null }] };
      openReview();
    }, { energy, minutes, planned, label });
    const originals = await page.evaluate(() => JSON.stringify({ entries, plans }));
    if (feeling) await page.evaluate(value => setReviewFocusRating(value), feeling);
    await expect(page.locator('#rv-waste')).toHaveValue('');
    await expect(page.locator('#rv-plan-vs-actual')).toBeHidden();
    await expect(page.locator('#review-overlay')).not.toContainText(/Reality Score|You regressed|You failed|bad day|poor progress/);
    if (planned === false && minutes) await expect(page.locator('#rv-closeout-summary')).toContainText('1 of 2 done or worked on');
    await saveReflection(page).click();
    expect(await page.evaluate(() => JSON.stringify({ entries, plans }))).toBe(originals);
    expect(await page.evaluate(() => reviews[planTodayKey()].focusRating)).toBe(feeling);
  });
}

test('connected Save keeps review sync payload and record completion contract', async ({ page }) => {
  await review(page);
  await page.evaluate(() => { window.reviewWrites = []; fbRoomRef = { update(value) { window.reviewWrites.push(value); return Promise.resolve(); } }; });
  await page.locator('#rv-win').fill('Only a win');
  await saveReflection(page).click();
  const result = await page.evaluate(() => ({ writes: window.reviewWrites, review: reviews[planTodayKey()], key: planTodayKey() }));
  expect(result.writes).toContainEqual({ [`reviews/${result.key}`]: result.review });
  expect(result.review).toMatchObject({ win: 'Only a win', focusRating: null, _savedAt: NOW });
  expect(result.review).not.toHaveProperty('closed');
  expect(result.review).not.toHaveProperty('reviewCompleted');
});

test('recorded summary unions overlaps and feeling works without automatic analysis', async ({ page }) => {
  await today(page);
  await page.evaluate(() => {
    entries = [
      { id: 'a', activity: 'First', energy: 'social', tsStart: Date.now() - 60 * 60000, ts: Date.now(), blockIntervalMin: 60 },
      { id: 'b', activity: 'Second', energy: 'shallow', tsStart: Date.now() - 30 * 60000, ts: Date.now(), blockIntervalMin: 30 }
    ];
    globalThis.deriveAttentionSignals = undefined;
    openReview();
  });
  await expect(page.locator('#rv-closeout-summary')).toHaveText('Today1h recorded');
  await page.locator('#rv-feeling').getByRole('button', { name: 'Focused', exact: true }).click();
  await saveReflection(page).click();
  expect(await page.evaluate(() => reviews[planTodayKey()].focusRating)).toBe('focused');
});

test('historical mobile date and expanded long activity wrap without overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await review(page, true);
  await page.evaluate(() => {
    entries[0].activity = 'A very long activity label ' + 'debugging'.repeat(25);
    refreshReviewAnalysis();
  });
  await expect(page.locator('#rv-date-label')).toHaveText('Monday, Sep 7');
  await page.locator('#rv-full-analysis > summary').click();
  const modal = page.locator('#review-overlay .review-modal');
  expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.locator('#rv-plan-vs-actual').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('historical-analysis.png') });
  await saveReflection(page).click();
  await expect(page.locator('#review-overlay')).not.toHaveClass(/open/);
});


for (const [name, key, nextName] of [['Mixed', 'Enter', 'Distracted'], ['Distracted', 'Space', null], ['Focused', 'Enter', 'Mixed']]) {
  test(`feeling keyboard activation retains focus: ${name}`, async ({ page }) => {
    await review(page);
    const button = page.locator('#rv-feeling').getByRole('button', { name, exact: true });
    const next = nextName ? page.locator('#rv-feeling').getByRole('button', { name: nextName, exact: true }) : page.getByRole('textbox', { name: 'One win today (optional)', exact: true });
    await button.focus();
    await page.keyboard.press(key);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => _reviewFocusRating)).toBe(name.toLowerCase());
    await expect(button).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(next).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(button).toBeFocused();
    await page.keyboard.press(key);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => _reviewFocusRating)).toBeNull();
    await expect(button).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(next).toBeFocused();
  });
}

test('historical mouse feeling selection saves, restores and remains editable', async ({ page }) => {
  await review(page, true);
  const mixed = page.locator('#rv-feeling').getByRole('button', { name: 'Mixed', exact: true });
  await mixed.click();
  await saveReflection(page).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-reviews'))['2026-09-07'].focusRating)).toBe('mixed');
  await page.evaluate(() => openReview('2026-09-07'));
  await expect(mixed).toHaveAttribute('aria-pressed', 'true');
  await mixed.click();
  await saveReflection(page).click();
  expect(await page.evaluate(() => reviews['2026-09-07'].focusRating)).toBeNull();
});
