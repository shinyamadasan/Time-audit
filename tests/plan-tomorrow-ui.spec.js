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

const firebaseConvergenceStub = `
(() => {
  if (window.firebase) return;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const snapshot = value => ({ val: () => clone(value), ref: { remove: () => Promise.resolve() } });
  const listeners = new Map();
  window.__emitFirebaseValue = (refPath, value) => (listeners.get(refPath) || []).forEach(cb => cb(snapshot(value)));
  const makeRef = refPath => ({
    path: refPath,
    child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) {
      if (eventName === 'value') {
        const rows = listeners.get(refPath) || [];
        rows.push(cb);
        listeners.set(refPath, rows);
        window.__firebaseRead(refPath).then(result => cb(snapshot(result.value)));
      }
      return cb;
    },
    off() {},
    once() { return window.__firebaseRead(refPath).then(result => snapshot(result.value)); },
    update() { return Promise.resolve(); }, set() { return Promise.resolve(); }, remove() { return Promise.resolve(); },
    async transaction(updateFn) {
      for (;;) {
        const current = await window.__firebaseRead(refPath);
        const next = updateFn(clone(current.value));
        const result = await window.__firebaseCas(refPath, current.version, next);
        if (result.ok) return { committed: true, snapshot: snapshot(result.value) };
      }
    },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
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

test('normal plan includes live routine details, adds one-off, and persists Ready metadata', async ({ page }) => {
  await openApp(page, { routines: routineState([routine()]) });
  await expect(page.locator('#plan-tomorrow-date')).toContainText('Wednesday, September 9');
  await expect(page.locator('.pt-routine')).toContainText('09:00');
  await expect(page.locator('.pt-routine')).toContainText('Target 30 min · Minimum 10 min · Fallback: Do 5 minutes');
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Ship report');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  await expect(page.locator('#toast')).not.toHaveClass(/show/);
  const stored = await page.evaluate(target => JSON.parse(localStorage.getItem('ta3-plans'))[target], TARGET);
  expect(stored.items.filter(item => !item.deleted).map(item => item.task)).toEqual(['Ship report']);
  expect(stored.items[0].updatedBy).toBe('device-test');
  expect(stored.preparation).toMatchObject({ schemaVersion: 1, targetDate: TARGET, timezone: 'Etc/UTC', firstPreparedBy: 'device-test', firstPreparedMode: 'normal', lastPreparedMode: 'normal', intentionalBlank: false });
  expect(stored.preparation.routineInstanceIds).toEqual(['["routine-1","2026-09-09"]']);
});

test('rescue uses existing content without asking new scheduling questions', async ({ page }) => {
  await openApp(page, { routines: routineState([routine()]), plans: { [TARGET]: { items: [planItem('p1', 'One priority')], updatedAt: NOW } } });
  await page.getByRole('button', { name: 'Rescue / minimum' }).click();
  await expect(page.locator('.pt-rescue')).toContainText('1 routine · 1 priority');
  await expect(page.locator('.pt-rescue input')).toHaveCount(0);
  await page.getByRole('button', { name: 'Use this plan' }).click();
  const mode = await page.evaluate(target => JSON.parse(localStorage.getItem('ta3-plans'))[target].preparation.lastPreparedMode, TARGET);
  expect(mode).toBe('rescue');
});

test('empty rescue supports one anytime priority or an explicit intentional blank day', async ({ page }) => {
  await openApp(page, { routines: routineState([]) });
  await page.getByRole('button', { name: 'Rescue / minimum' }).click();
  await expect(page.locator('#plan-tomorrow-rescue-add input')).toHaveCount(1);
  await page.locator('#plan-tomorrow-overlay').getByRole('button', { name: 'Open day / no commitments' }).click();
  await page.getByRole('button', { name: 'Use this plan' }).click();
  const preparation = await page.evaluate(target => JSON.parse(localStorage.getItem('ta3-plans'))[target].preparation, TARGET);
  expect(preparation.intentionalBlank).toBe(true);
  expect(preparation.oneOffItemIds).toEqual([]);
});

test('routine timezone mismatch warns and leaves one-off planning available', async ({ page }) => {
  await openApp(page, { timezone: 'America/Phoenix', routines: routineState([routine()], 'Asia/Tokyo') });
  await expect(page.locator('.pt-warning')).toContainText('Routines use Asia/Tokyo; Today uses America/Phoenix.');
  await expect(page.locator('.pt-routine')).toHaveCount(0);
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Local priority');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
  const refs = await page.evaluate(target => JSON.parse(localStorage.getItem('ta3-plans'))[target].preparation.routineInstanceIds, TARGET);
  expect(refs).toEqual([]);
});

test('skip tomorrow persists one occurrence identity and unskip restores it', async ({ page }) => {
  await openApp(page, { routines: routineState([routine()]) });
  await page.getByRole('button', { name: 'Skip tomorrow' }).click();
  let skips = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-daily-routines-v1')).skips);
  expect(Object.keys(skips)).toEqual(['["routine-1","2026-09-09"]']);
  await page.getByRole('button', { name: 'Restore tomorrow' }).click();
  skips = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-daily-routines-v1')).skips);
  expect(skips).toEqual({});
});

test('Learning preview is live and never pins tomorrow tonight', async ({ page }) => {
  let plan = createLearningPlan({ title: 'Course', id: 'learning-1' });
  plan = addPhase(plan, { title: 'Phase' }); plan = addLesson(plan, plan.phases[0].id, { title: 'Lesson' });
  plan = addStep(plan, plan.phases[0].lessons[0].id, { title: 'Step A' }); plan = addStep(plan, plan.phases[0].lessons[0].id, { title: 'Step B' });
  const learningPlans = { schemaVersion: 1, plans: [plan] };
  await openApp(page, { routines: routineState([routine({ title: 'Learning', source: 'learning', planId: plan.id })]), learningPlans });
  await expect(page.locator('.pt-learning')).toHaveText('Likely next: Step A');
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('ta3-daily-routines-v1')).links))).not.toContain('["routine-1","2026-09-09"]');
  const completed = completeStep(plan, plan.phases[0].lessons[0].steps[0].id);
  await page.evaluate(value => localStorage.setItem('ta3-learning-plans-v1', JSON.stringify({ schemaVersion: 1, plans: [value] })), completed);
  await page.locator('[data-pt-action="close"]').first().click(); await page.evaluate(() => openPlanTomorrow());
  await expect(page.locator('.pt-learning')).toHaveText('Likely next: Step B');
});

test('concurrent over-cap items are shown and must be reduced, never deleted silently', async ({ page }) => {
  const items = [1, 2, 3, 4].map(value => planItem(`p${value}`, `Priority ${value}`));
  await openApp(page, { routines: routineState([]), plans: { [TARGET]: { items, updatedAt: NOW } } });
  await expect(page.locator('.pt-oneoff')).toHaveCount(4);
  await expect(page.locator('.pt-warning')).toContainText('Nothing was deleted');
  await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
  await expect(page.locator('#plan-tomorrow-error')).toContainText('Reduce the plan to 3');
  expect(await page.evaluate(target => JSON.parse(localStorage.getItem('ta3-plans'))[target].items.length, TARGET)).toBe(4);
});

test('local plan write failure keeps the dialog and draft open without Ready metadata', async ({ page }) => {
  await openApp(page, { routines: routineState([routine()]), failPlanWrite: true });
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Preserved draft');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
  await expect(page.locator('.pt-oneoff')).toContainText('Preserved draft');
  await expect(page.locator('#plan-tomorrow-error')).toContainText('Plan quota exceeded');
});

test('offline confirmation persists locally and reports Ready on this device', async ({ page }) => {
  await openApp(page, { routines: routineState([routine()]) });
  await page.evaluate(() => { fbRoomRef = null; });
  await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
  await expect(page.locator('#toast')).toContainText('Ready on this device');
  expect(await page.evaluate(target => !!JSON.parse(localStorage.getItem('ta3-plans'))[target].preparation, TARGET)).toBe(true);
});

test('cloud acknowledgement failure keeps locally prepared state', async ({ page }) => {
  await openApp(page, { routines: routineState([routine()]) });
  await page.evaluate(() => { fbRoomRef = { child() { return this; }, transaction() { return Promise.reject(new Error('offline')); } }; });
  await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  await expect(page.locator('#toast')).toContainText('Ready on this device');
  await expect.poll(() => page.evaluate(target => !!JSON.parse(localStorage.getItem('ta3-plans'))[target].preparation, TARGET)).toBe(true);
});

test('model-unavailable inbound conflicts defer both equal-timestamp orientations and replay canonically', async ({ browser }) => {
  const live = planItem('shared', 'Live mutation', { updatedBy: 'device-a' });
  const tombstone = planItem('shared', 'Deleted mutation', { deleted: true, updatedBy: 'device-z' });
  const livePlan = { items: [live], updatedAt: NOW, updatedBy: 'device-a' };
  const tombstonePlan = { items: [tombstone], updatedAt: NOW, updatedBy: 'device-z' };

  const runOrientation = async (page, localPlan, remotePlan) => {
    await openApp(page, { routines: routineState([]), plans: { [TARGET]: localPlan } });
    return page.evaluate(async ({ targetDate, localPlan, remotePlan }) => {
      const model = globalThis.PlanTomorrowModel;
      globalThis.PlanTomorrowModel = null;
      globalThis.__firebasePlanWriteCount = 0;
      globalThis.__emitFirebaseValue('rooms/uid_plan-user/plans', { [targetDate]: remotePlan });
      const fallback = JSON.parse(localStorage.getItem('ta3-plans'))[targetDate];
      const deferred = globalThis.replayPendingPlanRemotes();
      const syncResult = await syncPlans(targetDate);
      const writesWhileUnavailable = globalThis.__firebasePlanWriteCount;
      const expected = model.mergeDatePlans(localPlan, remotePlan, targetDate);
      globalThis.PlanTomorrowModel = model;
      const replay = globalThis.replayPendingPlanRemotes();
      const canonical = JSON.parse(localStorage.getItem('ta3-plans'))[targetDate];
      const replayAgain = globalThis.replayPendingPlanRemotes();
      return { fallback, deferred, syncResult, writesWhileUnavailable, expected, replay, canonical, replayAgain };
    }, { targetDate: TARGET, localPlan, remotePlan });
  };

  const liveLocalPage = await browser.newPage();
  const tombstoneLocalPage = await browser.newPage();
  try {
    const liveLocal = await runOrientation(liveLocalPage, livePlan, tombstonePlan);
    const tombstoneLocal = await runOrientation(tombstoneLocalPage, tombstonePlan, livePlan);
    expect(liveLocal.fallback).toEqual(livePlan);
    expect(tombstoneLocal.fallback).toEqual(tombstonePlan);
    expect(liveLocal.deferred).toEqual({ pending: 1, replayed: 0, changed: false });
    expect(tombstoneLocal.deferred).toEqual({ pending: 1, replayed: 0, changed: false });
    expect(liveLocal.syncResult).toBe(false);
    expect(tombstoneLocal.syncResult).toBe(false);
    expect(liveLocal.writesWhileUnavailable).toBe(0);
    expect(tombstoneLocal.writesWhileUnavailable).toBe(0);
    expect(liveLocal.canonical).toEqual(liveLocal.expected);
    expect(tombstoneLocal.canonical).toEqual(tombstoneLocal.expected);
    expect(liveLocal.canonical).toEqual(tombstoneLocal.canonical);
    expect(liveLocal.canonical.items[0].deleted).toBe(true);
    expect(liveLocal.replay).toMatchObject({ pending: 0, replayed: 1 });
    expect(tombstoneLocal.replay).toMatchObject({ pending: 0, replayed: 1 });
    expect(liveLocal.replayAgain).toEqual({ pending: 0, replayed: 0, changed: false });
    expect(tombstoneLocal.replayAgain).toEqual({ pending: 0, replayed: 0, changed: false });
  } finally {
    await liveLocalPage.close();
    await tombstoneLocalPage.close();
  }
});

test('model-unavailable inbound fallback safely preserves no-local and preparation cases', async ({ page }) => {
  const noLocalDate = '2026-09-10';
  const remotePrepDate = '2026-09-11';
  const localPrepDate = '2026-09-12';
  const contestedPrepDate = '2026-09-13';
  const preparation = (targetDate, by, offset, ids) => ({
    schemaVersion: 1, targetDate, timezone: 'Etc/UTC', firstPreparedAt: NOW + offset,
    firstPreparedBy: by, firstPreparedMode: 'normal', lastPreparedAt: NOW + offset,
    lastPreparedMode: 'normal', updatedBy: by, intentionalBlank: false,
    routineInstanceIds: [], oneOffItemIds: ids
  });
  const remotePreparation = preparation(remotePrepDate, 'remote', -3000, ['remote-prep']);
  const localPreparation = preparation(localPrepDate, 'local', -2000, ['local-prep']);
  const contestedLocalPreparation = preparation(contestedPrepDate, 'local-a', -1000, ['local-contested']);
  const contestedRemotePreparation = preparation(contestedPrepDate, 'remote-z', -500, ['remote-contested']);
  const localPlans = {
    [remotePrepDate]: { items: [planItem('local-remote-prep', 'Local')], updatedAt: NOW - 20 },
    [localPrepDate]: { items: [planItem('local-prep', 'Local')], preparation: localPreparation, updatedAt: NOW - 20 },
    [contestedPrepDate]: { items: [planItem('local-contested', 'Local')], preparation: contestedLocalPreparation, updatedAt: NOW - 20 }
  };
  const remotePlans = {
    [noLocalDate]: { items: [planItem('remote-only', 'Remote only')], updatedAt: NOW - 10 },
    [remotePrepDate]: { items: [planItem('remote-prep', 'Remote')], preparation: remotePreparation, updatedAt: NOW - 10 },
    [localPrepDate]: { items: [planItem('remote-local-prep', 'Remote')], updatedAt: NOW - 10 },
    [contestedPrepDate]: { items: [planItem('remote-contested', 'Remote')], preparation: contestedRemotePreparation, updatedAt: NOW - 10 }
  };
  await openApp(page, { routines: routineState([]), plans: localPlans });
  const result = await page.evaluate(async ({ dates, localPlans, remotePlans }) => {
    const model = globalThis.PlanTomorrowModel;
    globalThis.PlanTomorrowModel = null;
    globalThis.__firebasePlanWriteCount = 0;
    globalThis.__emitFirebaseValue('rooms/uid_plan-user/plans', remotePlans);
    const fallback = JSON.parse(localStorage.getItem('ta3-plans'));
    const deferred = globalThis.replayPendingPlanRemotes();
    const syncResult = await syncPlans(dates.remotePrepDate);
    const writesWhileUnavailable = globalThis.__firebasePlanWriteCount;
    const expected = {};
    [dates.remotePrepDate, dates.localPrepDate, dates.contestedPrepDate].forEach(date => {
      expected[date] = model.mergeDatePlans(fallback[date], remotePlans[date], date);
    });
    globalThis.PlanTomorrowModel = model;
    const replay = globalThis.replayPendingPlanRemotes();
    const canonical = JSON.parse(localStorage.getItem('ta3-plans'));
    const replayAgain = globalThis.replayPendingPlanRemotes();
    return { fallback, deferred, syncResult, writesWhileUnavailable, expected, replay, canonical, replayAgain };
  }, { dates: { noLocalDate, remotePrepDate, localPrepDate, contestedPrepDate }, localPlans, remotePlans });

  expect(result.fallback[noLocalDate]).toEqual(remotePlans[noLocalDate]);
  expect(result.fallback[remotePrepDate].items).toEqual(localPlans[remotePrepDate].items);
  expect(result.fallback[remotePrepDate].preparation).toEqual(remotePreparation);
  expect(result.fallback[localPrepDate]).toEqual(localPlans[localPrepDate]);
  expect(result.fallback[contestedPrepDate]).toEqual(localPlans[contestedPrepDate]);
  expect(result.deferred).toEqual({ pending: 3, replayed: 0, changed: false });
  expect(result.syncResult).toBe(false);
  expect(result.writesWhileUnavailable).toBe(0);
  expect(result.replay).toMatchObject({ pending: 0, replayed: 3 });
  expect(result.canonical[noLocalDate]).toEqual(remotePlans[noLocalDate]);
  expect(result.canonical[remotePrepDate]).toEqual(result.expected[remotePrepDate]);
  expect(result.canonical[localPrepDate]).toEqual(result.expected[localPrepDate]);
  expect(result.canonical[contestedPrepDate]).toEqual(result.expected[contestedPrepDate]);
  expect(result.replayAgain).toEqual({ pending: 0, replayed: 0, changed: false });
});

test('two real clients converge through transaction retry and inbound synchronization', async ({ browser }) => {
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const base = { items: [planItem('shared', 'Base', { updatedAt: NOW - 2000, updatedBy: 'base' })], updatedAt: NOW - 2000, updatedBy: 'base' };
  const remote = { value: clone(base), version: 0 };
  const firstRound = [];
  let casCalls = 0;
  const read = async refPath => ({
    value: refPath.endsWith(`/plans/${TARGET}`) ? clone(remote.value) : refPath.endsWith('/plans') ? { [TARGET]: clone(remote.value) } : null,
    version: remote.version
  });
  const cas = async (refPath, version, next) => {
    casCalls++;
    if (!refPath.endsWith(`/plans/${TARGET}`)) return { ok: false, value: null, version: remote.version };
    if (version !== remote.version) return { ok: false, value: clone(remote.value), version: remote.version };
    if (version === 0) {
      return new Promise(resolve => {
        firstRound.push({ next: clone(next), resolve });
        if (firstRound.length !== 2) return;
        const [winner, retry] = firstRound;
        remote.value = clone(winner.next);
        remote.version++;
        winner.resolve({ ok: true, value: clone(remote.value), version: remote.version });
        retry.resolve({ ok: false, value: clone(remote.value), version: remote.version });
      });
    }
    remote.value = clone(next);
    remote.version++;
    return { ok: true, value: clone(remote.value), version: remote.version };
  };
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();
  try {
    for (const page of [pageA, pageB]) {
      await page.exposeFunction('__firebaseRead', read);
      await page.exposeFunction('__firebaseCas', cas);
    }
    await Promise.all([
      openApp(pageA, { routines: routineState([]), plans: { [TARGET]: base }, deviceId: 'device-a', firebaseScript: firebaseConvergenceStub }),
      openApp(pageB, { routines: routineState([]), plans: { [TARGET]: base }, deviceId: 'device-b', firebaseScript: firebaseConvergenceStub })
    ]);
    const prepA = { schemaVersion: 1, targetDate: TARGET, timezone: 'Etc/UTC', firstPreparedAt: NOW - 1000, firstPreparedBy: 'device-a', firstPreparedMode: 'normal', lastPreparedAt: NOW - 500, lastPreparedMode: 'normal', updatedBy: 'device-a', intentionalBlank: false, routineInstanceIds: ['routine-a'], oneOffItemIds: ['a1', 'a2', 'shared'] };
    const prepB = { schemaVersion: 1, targetDate: TARGET, timezone: 'Etc/UTC', firstPreparedAt: NOW - 900, firstPreparedBy: 'device-b', firstPreparedMode: 'rescue', lastPreparedAt: NOW, lastPreparedMode: 'rescue', updatedBy: 'device-b', intentionalBlank: false, routineInstanceIds: ['routine-b'], oneOffItemIds: ['b1', 'b2', 'shared'] };
    const candidateA = { items: [
      planItem('shared', 'Deleted by A', { deleted: true, updatedAt: NOW, updatedBy: 'device-z' }),
      planItem('a1', 'A one', { updatedBy: 'device-a' }), planItem('a2', 'A two', { updatedBy: 'device-a' })
    ], preparation: prepA, updatedAt: NOW, updatedBy: 'device-a' };
    const candidateB = { items: [
      planItem('shared', 'Edited by B', { updatedAt: NOW, updatedBy: 'device-b' }),
      planItem('b1', 'B one', { updatedBy: 'device-b' }), planItem('b2', 'B two', { updatedBy: 'device-b' })
    ], preparation: prepB, updatedAt: NOW, updatedBy: 'device-b' };
    const syncResults = await Promise.all([
      pageA.evaluate(({ targetDate, candidate }) => { writeDatePlanLocal(targetDate, candidate); return syncPlans(targetDate); }, { targetDate: TARGET, candidate: candidateA }),
      pageB.evaluate(({ targetDate, candidate }) => { writeDatePlanLocal(targetDate, candidate); return syncPlans(targetDate); }, { targetDate: TARGET, candidate: candidateB })
    ]);
    expect(syncResults).toEqual([true, true]);
    const canonicalRemote = await pageA.evaluate(({ targetDate, value }) => globalThis.PlanTomorrowModel.mergeDatePlans(null, value, targetDate), { targetDate: TARGET, value: remote.value });
    await Promise.all([pageA, pageB].map(page => page.evaluate(({ targetDate, value }) => {
      globalThis.__emitFirebaseValue('rooms/uid_plan-user/plans', { [targetDate]: value });
    }, { targetDate: TARGET, value: remote.value })));
    const readClient = page => page.evaluate(targetDate => ({ memory: plans[targetDate], stored: JSON.parse(localStorage.getItem('ta3-plans'))[targetDate] }), TARGET);
    await expect.poll(async () => (await readClient(pageA)).stored).toEqual(canonicalRemote);
    await expect.poll(async () => (await readClient(pageB)).stored).toEqual(canonicalRemote);
    expect((await readClient(pageA)).memory).toEqual(canonicalRemote);
    expect((await readClient(pageB)).memory).toEqual(canonicalRemote);
    expect(canonicalRemote.items.filter(value => !value.deleted)).toHaveLength(4);
    expect(canonicalRemote.items.find(value => value.id === 'shared').deleted).toBe(true);
    expect(canonicalRemote.preparation.firstPreparedBy).toBe('device-a');
    expect(canonicalRemote.preparation.updatedBy).toBe('device-b');
    expect(casCalls).toBeGreaterThan(2);
  } finally {
    await pageA.close();
    await pageB.close();
  }
});

test('Review delegates preparation to Plan Tomorrow and saves independently', async ({ page }) => {
  await openApp(page, { routines: routineState([routine()]) });
  await page.locator('[data-pt-action="close"]').first().click();
  await page.evaluate(() => openReview('2026-09-08'));
  await page.locator('#rv-win').fill('Saved reflection');
  await page.locator('#review-overlay').getByRole('button', { name: /Prepare tomorrow/ }).click();
  await page.locator('#plan-tomorrow-confirm').click();
  await expect(page.locator('#review-overlay')).toHaveClass(/open/);
  await expect(page.locator('#rv-win')).toHaveValue('Saved reflection');
  await expect(page.locator('#rv-tomorrow-status')).toContainText('Prepare tomorrow');
  const before = await page.evaluate(() => JSON.stringify(plans));
  await page.locator('#review-overlay').getByRole('button', { name: 'Save reflection', exact: true }).click();
  expect(await page.evaluate(() => JSON.stringify(plans))).toBe(before);
});

test('Review distinguishes done early and removed without calling unfinished work skipped', async ({ page }) => {
  const firstPreparedAt = Date.parse('2026-09-07T18:00:00Z');
  const preparation = { schemaVersion: 1, targetDate: '2026-09-08', timezone: 'Etc/UTC', firstPreparedAt, firstPreparedMode: 'normal', lastPreparedAt: firstPreparedAt, lastPreparedMode: 'normal', updatedBy: 'device-a', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['early', 'removed', 'open'] };
  const items = [
    planItem('early', 'Finished early', { done: true, doneAt: Date.parse('2026-09-07T20:00:00Z') }),
    planItem('removed', 'Removed task', { deleted: true, updatedAt: firstPreparedAt + 1000 }),
    planItem('open', 'Never started')
  ];
  await openApp(page, { routines: routineState([]), plans: { '2026-09-08': { items, preparation, updatedAt: NOW } } });
  await page.locator('[data-pt-action="close"]').first().click();
  await page.evaluate(() => openReview('2026-09-08'));
  await expect(page.locator('#rv-plan-vs-actual')).toContainText('Done early');
  await expect(page.locator('#rv-plan-vs-actual')).toContainText('Removed');
  await expect(page.locator('#rv-plan-vs-actual')).toContainText('Not done');
  await expect(page.locator('#rv-plan-vs-actual')).not.toContainText('skipped');
  await expect(page.locator('.rv-pva-head')).toContainText('active 2');
});

test('a date skip filters Today projection before grouping and remains reversible', async ({ page }) => {
  const todayId = '["routine-1","2026-09-08"]';
  await openApp(page, { routines: routineState([routine()], 'Etc/UTC', { skips: { [todayId]: { skippedAt: NOW, updatedAt: NOW } } }) });
  await page.locator('[data-pt-action="close"]').first().click();
  await expect(page.locator('.daily-routine-card')).toHaveCount(0);
  await expect(page.locator('.routine-skipped')).toContainText('Skipped today (1)');
  await page.locator('#routine-details > summary').click();
  await page.locator('.routine-skipped summary').click();
  await page.getByRole('button', { name: 'Restore today' }).click();
  await expect(page.locator('.daily-routine-card')).toHaveCount(1);
});
