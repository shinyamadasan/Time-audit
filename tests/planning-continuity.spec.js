// Planning Continuity V1 — the UX surfaces, in a real browser.
//
// Covers what unit tests structurally cannot: that the Top 3 cap and the uncapped
// "Other planned tasks" block behave as two separate sections in the DOM, that a 4th
// priority is refused through explicit UX rather than silently dropped, that a
// commitment entered by real date/time shows up on the correct personal day, that a
// DST-ambiguous time asks the owner which instant they meant, that an arbitrary
// future personal day can be browsed and prepared, and that a stale task from days
// earlier is discoverable and movable.
//
// Firebase is stubbed exactly as the other specs stub it — no real project, no
// network. Local persistence is the page's own localStorage.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';

const TZ = 'Asia/Manila';
// 19:00 on 2026-09-18, so the personal day in progress began at 18:00 that date.
const NOW = Date.parse('2026-09-18T19:00:00+08:00');

// 18:00 Manila, effective from 2026-09-01 18:00 — well before every day these tests
// touch, so each of them is genuinely operational-governed rather than legacy.
const BOUNDARY_STORE = JSON.stringify({ schemaVersion: 1, revisions: {
  'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
  'r-1800': { id: 'r-1800', boundaryTime: '18:00', timezone: TZ, effectiveFromInstant: Date.parse('2026-09-01T18:00:00+08:00') },
} });

const TRUNCATED_BOUNDARY_STORE = JSON.stringify({ schemaVersion: 1, revisions: {
  'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
  'r-1800': { id: 'r-1800', boundaryTime: '18:00', timezone: TZ, effectiveFromInstant: Date.parse('2026-09-01T18:00:00+08:00') },
  'r-2000': { id: 'r-2000', boundaryTime: '20:00', timezone: TZ, effectiveFromInstant: Date.parse('2026-09-18T20:00:00+08:00') },
} });

const boundaryStoreFor = boundaryTime => JSON.stringify({ schemaVersion: 1, revisions: {
  'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
  [`r-${boundaryTime.replace(':', '')}`]: { id: `r-${boundaryTime.replace(':', '')}`, boundaryTime, timezone: TZ, effectiveFromInstant: Date.parse(`2026-09-01T${boundaryTime}:00+08:00`) },
} });

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const makeRef = refPath => ({
    path: refPath, child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) { if (eventName === 'value') setTimeout(() => cb(snapshot(null)), 0); return cb; },
    off() {}, once() { return Promise.resolve(snapshot(null)); }, update() { return Promise.resolve(); },
    set() { return Promise.resolve(); }, remove() { return Promise.resolve(); },
    transaction(updateFn) { const value = updateFn(null); return Promise.resolve({ committed: true, snapshot: snapshot(value) }); },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'pc-user', displayName: 'PC User', email: 'pc@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(config) { const app = { config }; this.apps.push(app); return app; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
})();`;

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

const ROUTINES = JSON.stringify({ schemaVersion: 1, timezone: TZ, routines: [], manual: {}, links: {}, focus: {}, skips: {} });

async function openApp(page, { now = NOW, boundaryStore = BOUNDARY_STORE, plans = '{}', operationalPlans = null, commitments = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, boundaryStore, plans, operationalPlans, commitments, routines }) => {
    // The Date mock must be re-installed on EVERY load, including a reload.
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    // Seeding, by contrast, must happen ONCE: addInitScript runs again on reload, and
    // clearing storage there would wipe exactly what a reload test is checking.
    if (localStorage.getItem('pc-seeded') === '1') return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('pc-seeded', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz:uid_pc-user', timezone);
    localStorage.setItem('ta3-device-id', 'device-pc-test');
    localStorage.setItem('ta3-settings:uid_pc-user', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries:uid_pc-user', '[]');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-plans:uid_pc-user', plans);
    localStorage.setItem('ta3-daily-routines-v1', routines);
    if (boundaryStore) localStorage.setItem('ta3-day-boundary-revisions-v1:uid_pc-user', boundaryStore);
    if (operationalPlans) localStorage.setItem('ta3-operational-plans-v1:uid_pc-user', operationalPlans);
    if (commitments) localStorage.setItem('ta3-commitments-v1:uid_pc-user', commitments);
  }, { timezone: TZ, now, boundaryStore, plans, operationalPlans, commitments, routines: ROUTINES });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object' && typeof window.CommitmentsRepository === 'object');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

const strip = page => page.locator('#timeline-anytime');
const continuity = page => page.locator('#planning-continuity-section');
const unfinished = page => page.locator('#unfinished-recovery-section');

async function openTaskForm(page) {
  const form = page.locator('#pc-task-form');
  if (!await form.isVisible()) await continuity(page).getByRole('button', { name: /Add/ }).first().click();
  return form;
}

async function addPriority(page, task) {
  const form = await openTaskForm(page);
  await form.locator('input[name="title"]').fill(task);
  await form.locator('select[name="kind"]').selectOption('priority');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
}

async function addSecondaryTask(page, task) {
  const form = await openTaskForm(page);
  await form.locator('input[name="title"]').fill(task);
  await form.locator('select[name="kind"]').selectOption('task');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
}

async function seedThreePriorities(page, date = null) {
  return page.evaluate(selectedDate => {
    const target = selectedDate
      ? window.PlanAuthority.dayForScheduledDate(selectedDate, '').target
      : window.PlanAuthority.current();
    window.PlanAuthority.saveItems(target, ['Seed one', 'Seed two', 'Seed three'].map(title => createPlanItem(title, '')));
    refreshAuthoritativePlanSurfaces();
    return target.id;
  }, date);
}

async function openStaleRecovery(page) {
  await unfinished(page).getByRole('button', { name: /Unfinished/ }).click();
  return unfinished(page).locator('.pc-block', { hasText: 'Unfinished ·' }).last();
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Top 3 priorities vs uncapped other planned tasks
// ═══════════════════════════════════════════════════════════════════════

test('3 priorities fill the cap, a 4th is refused with an explicit message, and 10 other tasks are all accepted', async ({ page }) => {
  await openApp(page);

  for (const task of ['First', 'Second', 'Third']) await addPriority(page, task);
  await expect(strip(page)).toContainText('First');

  // The 4th priority is REFUSED, and says what to do instead — never silently dropped.
  const fourth = await openTaskForm(page);
  await fourth.locator('input[name="title"]').fill('Fourth');
  await fourth.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(fourth).toContainText('Top 3 is already full');
  await fourth.getByRole('button', { name: 'Cancel' }).click();

  // Secondary tasks are uncapped: ten of them all land.
  for (let n = 1; n <= 10; n++) await addSecondaryTask(page, `Task ${n}`);
  await strip(page).getByRole('button', { name: /Show 9 more/ }).click();
  await expect(strip(page).locator('[data-plan-item-id]')).toHaveCount(13);
  await expect(strip(page)).toContainText('Task 10');

  // The priorities count is still 3 — secondary tasks never consumed the cap.
  const counts = await page.evaluate(() => {
    const target = window.PlanAuthority.current();
    const items = window.PlanAuthority.items(target);
    return {
      priorities: items.filter(i => i.kind !== 'task').length,
      tasks: items.filter(i => i.kind === 'task').length,
      commitment: (syncCommitmentFromPlan(), dailyCommitment),
    };
  });
  expect(counts).toEqual({ priorities: 3, tasks: 10, commitment: 3 });
});

test('ten secondary tasks do not make the day prepared or move the Planning Streak', async ({ page }) => {
  await openApp(page);
  const before = await page.evaluate(() => window.PlanAuthority.streak());
  for (let n = 1; n <= 10; n++) await addSecondaryTask(page, `Task ${n}`);
  const after = await page.evaluate(() => ({
    streak: window.PlanAuthority.streak(),
    prepared: window.PlanAuthority.preparedState(window.PlanAuthority.current()).prepared,
    ready: window.PlanAuthority.readyNow(window.PlanAuthority.current()),
  }));
  expect(after.streak).toEqual(before);
  expect(after.prepared).toBe(false);
  expect(after.ready).toBe(false);
});

test('Top Priorities and Other Tasks render once in the bounded Anytime lane', async ({ page }) => {
  await openApp(page);
  await addPriority(page, 'Priority in timeline');
  await addSecondaryTask(page, 'Other task in timeline');
  await expect(page.locator('#timeline-anytime')).toContainText('Priority in timeline');
  await expect(page.locator('#timeline-anytime')).toContainText('Other task in timeline');
  await expect(page.locator('#today-commitments')).toBeHidden();
  await expect(page.locator('#operational-plan-section')).toBeHidden();
  await expect(page.locator('#planning-continuity-section')).not.toContainText('Upcoming');
  await expect(page.locator('#planning-continuity-section')).not.toContainText('Plan another day');
  await expect(page.locator('#timeline-entry-actions')).toHaveCount(0);
  await expect(page.getByText('Accountability', { exact: true })).toHaveCount(0);
});

test('timing edits move the same task between Anytime and the clock timeline', async ({ page }) => {
  await openApp(page);
  await addPriority(page, 'Move me through time');
  const originalId = await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())[0].id);
  await page.getByRole('button', { name: 'Edit planned task Move me through time' }).click();
  let form = page.locator('#pc-task-form');
  await form.locator('input[name="time"]').fill('10:00');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#timeline-blocks')).toContainText('Move me through time');
  await expect(page.locator('#timeline-anytime')).not.toContainText('Move me through time');
  expect(await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())[0].id)).toBe(originalId);

  await page.getByRole('button', { name: 'Edit planned task Move me through time' }).click();
  form = page.locator('#pc-task-form');
  await form.locator('input[name="time"]').fill('');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#timeline-anytime')).toContainText('Move me through time');
  await expect(page.locator('#timeline-blocks')).not.toContainText('Move me through time');
  expect(await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())[0].id)).toBe(originalId);
});

for (const boundaryTime of ['04:00', '12:00']) {
  test(`${boundaryTime} Today/Tomorrow/default Add dates resolve to consecutive authoritative My Days`, async ({ page }) => {
    await openApp(page, { boundaryStore: boundaryStoreFor(boundaryTime) });
    const form = await openTaskForm(page);
    const date = form.locator('input[name="date"]');
    await expect(date).toHaveValue('2026-09-18');
    await form.getByRole('button', { name: 'Tomorrow' }).click();
    await expect(date).toHaveValue('2026-09-19');
    await form.getByRole('button', { name: 'Today' }).click();
    await form.locator('input[name="title"]').fill(`Morning boundary ${boundaryTime}`);
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    const result = await page.evaluate(() => {
      const current = window.PlanAuthority.current();
      const next = window.PlanAuthority.next(current);
      return {
        current: window.PlanAuthority.items(current).map(item => item.task),
        next: window.PlanAuthority.items(next).map(item => item.task),
      };
    });
    expect(result.current).toEqual([`Morning boundary ${boundaryTime}`]);
    expect(result.next).toEqual([]);
  });
}

for (const boundaryTime of ['04:00', '18:00']) {
  for (const [time, expectedDate] of [['21:00', '2026-09-18'], ['02:00', '2026-09-19']]) {
    test(`${boundaryTime} target-preserving ${time} entry stays in Today and displays ${expectedDate}`, async ({ page }) => {
      await openApp(page, { boundaryStore: boundaryStoreFor(boundaryTime) });
      const form = await openTaskForm(page);
      await form.locator('input[name="title"]').fill(`${boundaryTime} at ${time}`);
      await form.locator('input[name="time"]').fill(time);
      await expect(form.locator('input[name="date"]')).toHaveValue(expectedDate);
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      const result = await page.evaluate(task => {
        const target = window.PlanAuthority.current();
        const planned = window.PlanAuthority.items(target).find(item => item.task === task);
        return { count: planned ? 1 : 0, instantMs: planned ? window.PlanAuthority.itemStartInstant(target, planned.when) : null };
      }, `${boundaryTime} at ${time}`);
      expect(result).toEqual({ count: 1, instantMs: Date.parse(`${expectedDate}T${time}:00+08:00`) });
    });
  }
}

test('a truncated 18:00 to 20:00 My Day supports add, edit, valid time, refusal, and clear-time flows', async ({ page }) => {
  await openApp(page, { boundaryStore: TRUNCATED_BOUNDARY_STORE });
  await expect(continuity(page)).not.toContainText('Planning surfaces are unavailable');
  let form = await openTaskForm(page);
  await expect(form.locator('input[name="date"]')).toHaveValue('2026-09-18');
  await form.locator('input[name="title"]').fill('Truncated task');
  await form.getByRole('button', { name: 'Add', exact: true }).click();

  await page.getByRole('button', { name: 'Edit planned task Truncated task' }).click();
  form = page.locator('#pc-task-form');
  await form.locator('input[name="title"]').fill('Truncated renamed');
  await form.locator('select[name="kind"]').selectOption('task');
  await form.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('button', { name: 'Edit planned task Truncated renamed' }).click();
  form = page.locator('#pc-task-form');
  await form.locator('input[name="time"]').fill('19:00');
  await form.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('button', { name: 'Edit planned task Truncated renamed' }).click();
  form = page.locator('#pc-task-form');
  await form.locator('input[name="time"]').fill('09:00');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.pc-error')).toContainText('outside this My Day');
  expect(await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())[0].when)).toBe('19:00');

  await form.locator('input[name="time"]').fill('');
  await form.getByRole('button', { name: 'Save' }).click();
  const finalItem = await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())[0]);
  expect({ task: finalItem.task, kind: finalItem.kind, when: finalItem.when }).toEqual({ task: 'Truncated renamed', kind: 'task', when: '' });
});

test('editing the civil date explicitly relocates the same untimed task id', async ({ page }) => {
  await openApp(page);
  await addSecondaryTask(page, 'Explicit reschedule');
  const original = await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())[0]);
  await page.getByRole('button', { name: 'Edit planned task Explicit reschedule' }).click();
  const form = page.locator('#pc-task-form');
  await form.locator('input[name="date"]').fill('2026-09-25');
  await form.getByRole('button', { name: 'Save' }).click();
  const result = await page.evaluate(() => {
    const current = window.PlanAuthority.current();
    const destination = window.PlanAuthority.dayForScheduledDate('2026-09-25', '').target;
    return {
      sourceCount: window.PlanAuthority.items(current).filter(item => item.task === 'Explicit reschedule').length,
      destination: window.PlanAuthority.items(destination).find(item => item.task === 'Explicit reschedule'),
    };
  });
  expect(result.sourceCount).toBe(0);
  expect(result.destination.id).toBe(original.id);
  expect(result.destination.when).toBe('');
});

for (const time of ['21:00', '02:00']) {
  test(`refused fourth priority resets to target mode before a ${time} Other Task retry`, async ({ page }) => {
    await openApp(page);
    await seedThreePriorities(page);
    let form = await openTaskForm(page);
    const date = form.locator('input[name="date"]');
    await date.fill('2026-09-20');
    await date.fill('2026-09-19');
    await form.locator('input[name="title"]').fill(`Refused then ${time}`);
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(form.locator('.pc-error')).toContainText('Top 3 is already full');
    await expect(date).toHaveValue('2026-09-19');

    form = page.locator('#pc-task-form');
    await form.locator('input[name="title"]').fill(`Retry ${time}`);
    await form.locator('select[name="kind"]').selectOption('task');
    await form.locator('input[name="time"]').fill(time);
    await expect(form.locator('input[name="date"]')).toHaveValue(time === '21:00' ? '2026-09-18' : '2026-09-19');
    await form.getByRole('button', { name: 'Add', exact: true }).click();

    const result = await page.evaluate(title => {
      const current = window.PlanAuthority.current();
      const next = window.PlanAuthority.next(current);
      return {
        current: window.PlanAuthority.items(current).filter(item => item.task === title).map(item => item.when),
        next: window.PlanAuthority.items(next).filter(item => item.task === title).length,
      };
    }, `Retry ${time}`);
    expect(result).toEqual({ current: [time], next: 0 });
  });
}

test('a refused explicit future-date Add visibly and internally resets to the current anchor', async ({ page }) => {
  await openApp(page);
  await seedThreePriorities(page, '2026-09-25');
  let form = await openTaskForm(page);
  await form.locator('input[name="date"]').fill('2026-09-25');
  await form.locator('input[name="title"]').fill('Future refusal');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(form.locator('.pc-error')).toContainText('Top 3 is already full');
  await expect(form.locator('input[name="date"]')).toHaveValue('2026-09-19');

  form = page.locator('#pc-task-form');
  await form.locator('input[name="title"]').fill('Future retry anchored');
  await form.locator('select[name="kind"]').selectOption('task');
  await form.locator('input[name="time"]').fill('21:00');
  await expect(form.locator('input[name="date"]')).toHaveValue('2026-09-18');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  const result = await page.evaluate(() => {
    const current = window.PlanAuthority.current();
    const future = window.PlanAuthority.dayForScheduledDate('2026-09-25', '').target;
    return {
      current: window.PlanAuthority.items(current).filter(item => item.task === 'Future retry anchored').length,
      future: window.PlanAuthority.items(future).filter(item => item.task === 'Future retry anchored').length,
    };
  });
  expect(result).toEqual({ current: 1, future: 0 });
});

test('a refused explicit future-date Edit resets to the source anchor before retry', async ({ page }) => {
  await openApp(page);
  await seedThreePriorities(page, '2026-09-25');
  await addSecondaryTask(page, 'Edit refusal source');
  const originalId = await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current()).find(item => item.task === 'Edit refusal source').id);
  await page.getByRole('button', { name: 'Edit planned task Edit refusal source' }).click();
  let form = page.locator('#pc-task-form');
  await form.locator('input[name="date"]').fill('2026-09-25');
  await form.locator('select[name="kind"]').selectOption('priority');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.pc-error')).toContainText('Top 3 is already full');
  await expect(form.locator('input[name="date"]')).toHaveValue('2026-09-19');

  form = page.locator('#pc-task-form');
  await form.locator('input[name="title"]').fill('Edit retry anchored');
  await form.locator('input[name="time"]').fill('21:00');
  await expect(form.locator('input[name="date"]')).toHaveValue('2026-09-18');
  await form.getByRole('button', { name: 'Save' }).click();
  const result = await page.evaluate(id => {
    const current = window.PlanAuthority.current();
    const future = window.PlanAuthority.dayForScheduledDate('2026-09-25', '').target;
    const currentItem = window.PlanAuthority.items(current).find(item => item.id === id);
    return {
      current: currentItem && { task: currentItem.task, when: currentItem.when, kind: currentItem.kind },
      future: window.PlanAuthority.items(future).filter(item => item.id === id).length,
    };
  }, originalId);
  expect(result).toEqual({ current: { task: 'Edit retry anchored', when: '21:00', kind: 'task' }, future: 0 });
});

test('a historical-date refusal also resets the retry to target-preserving mode', async ({ page }) => {
  await openApp(page);
  let form = await openTaskForm(page);
  await form.locator('input[name="date"]').fill('2026-09-18');
  await form.locator('input[name="title"]').fill('Historical refusal');
  await form.locator('select[name="kind"]').selectOption('task');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(form.locator('.pc-error')).toContainText('Past My Days are history');
  await expect(form.locator('input[name="date"]')).toHaveValue('2026-09-19');

  form = page.locator('#pc-task-form');
  await form.locator('input[name="title"]').fill('Historical retry anchored');
  await form.locator('select[name="kind"]').selectOption('task');
  await form.locator('input[name="time"]').fill('21:00');
  await expect(form.locator('input[name="date"]')).toHaveValue('2026-09-18');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  expect(await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current()).filter(item => item.task === 'Historical retry anchored').length)).toBe(1);
});

test('direct Add refuses yesterday and weeks ago without mutating historical plans', async ({ page }) => {
  await openApp(page);
  const form = await openTaskForm(page);
  await form.locator('input[name="title"]').fill('Must not enter history');
  for (const date of ['2026-09-18', '2026-08-20']) {
    await form.locator('input[name="date"]').fill(date);
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(form.locator('.pc-error')).toContainText('Past My Days are history');
  }
  expect(await page.evaluate(() => window.PlanAuthority.recoverableDays().flatMap(row => window.PlanAuthority.items(row.target)).length)).toBe(0);
});

test('editing a current task backward is refused and leaves the source unchanged', async ({ page }) => {
  await openApp(page);
  await addPriority(page, 'Stay current');
  const before = await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())[0]);
  await page.getByRole('button', { name: 'Edit planned task Stay current' }).click();
  const form = page.locator('#pc-task-form');
  await form.locator('input[name="date"]').fill('2026-09-18');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.pc-error')).toContainText('Past My Days are history');
  const after = await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())[0]);
  expect(after).toEqual(before);
});

test('editing a future task into history is refused and leaves the future source unchanged', async ({ page }) => {
  await openApp(page);
  let form = await openTaskForm(page);
  await form.locator('input[name="title"]').fill('Stay future');
  await form.locator('input[name="date"]').fill('2026-09-25');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  const before = await page.evaluate(() => {
    const target = window.PlanAuthority.dayForScheduledDate('2026-09-25').target;
    const item = window.PlanAuthority.items(target)[0];
    PlanningContinuityUI.editTask(target.id, item.id);
    return { targetId: target.id, item };
  });
  form = page.locator('#pc-task-form');
  await form.locator('input[name="date"]').fill('2026-09-18');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.pc-error')).toContainText('Past My Days are history');
  const after = await page.evaluate(targetId => window.PlanAuthority.items(window.PlanAuthority.targetById(targetId))[0], before.targetId);
  expect(after).toEqual(before.item);
});

for (const store of ['legacy', 'operational']) {
  test(`clearing task time clears range metadata and returns one same-id row to Anytime in the ${store} store`, async ({ page }) => {
    await openApp(page, { boundaryStore: store === 'legacy' ? null : BOUNDARY_STORE });
    const originalId = await page.evaluate(() => {
      const target = window.PlanAuthority.current();
      const item = { ...createPlanItem('Clear ranged time', '22:00'), durationMinutes: 60, endClock: '23:00' };
      window.PlanAuthority.saveItems(target, [item]);
      refreshAuthoritativePlanSurfaces();
      return item.id;
    });
    await page.getByRole('button', { name: 'Edit planned task Clear ranged time' }).click();
    const form = page.locator('#pc-task-form');
    await form.locator('input[name="time"]').fill('');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#timeline-anytime')).toContainText('Clear ranged time');
    const stored = await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current()).filter(item => item.task === 'Clear ranged time'));
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(originalId);
    expect(stored[0].when).toBe('');
    expect(stored[0]).not.toHaveProperty('durationMinutes');
    expect(stored[0]).not.toHaveProperty('endClock');
  });
}

test('task checkbox and promotion preserve identity without fabricating evidence', async ({ page }) => {
  await openApp(page);
  await addSecondaryTask(page, 'Identity stays put');
  const original = await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())[0].id);
  await page.getByRole('button', { name: 'Mark done: Identity stays put' }).click();
  const checked = await page.evaluate(() => ({
    item: window.PlanAuthority.items(window.PlanAuthority.current())[0],
    entries: JSON.parse(localStorage.getItem('ta3-entries:uid_pc-user')),
  }));
  expect(checked.item.id).toBe(original);
  expect(checked.item.done).toBe(true);
  expect(checked.entries).toEqual([]);

  await page.getByRole('button', { name: 'Edit planned task Identity stays put' }).click();
  const form = page.locator('#pc-task-form');
  await form.locator('select[name="kind"]').selectOption('priority');
  await form.getByRole('button', { name: 'Save' }).click();
  const promoted = await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())[0]);
  expect(promoted.id).toBe(original);
  expect(promoted.kind).toBeUndefined();
});

test('direct date scheduling jumps one week ahead without repeated paging', async ({ page }) => {
  await openApp(page);
  const form = await openTaskForm(page);
  await form.locator('input[name="title"]').fill('One week ahead');
  await form.locator('input[name="date"]').fill('2026-09-25');
  await form.locator('select[name="kind"]').selectOption('task');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#timeline-anytime')).not.toContainText('One week ahead');

  await page.locator('#my-day-calendar').evaluate(input => {
    input.value = '2026-09-25';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#timeline-date-label')).toContainText('My Day');
  await expect(page.locator('#timeline-anytime')).toContainText('One week ahead');
  const count = await page.evaluate(() => window.PlanAuthority.recoverableDays().reduce((sum, row) => sum + window.PlanAuthority.items(row.target).filter(item => item.task === 'One week ahead').length, 0));
  expect(count).toBe(1);
});

test('same-time planned, commitment, template, and actual rows all survive in stable order', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const target = window.PlanAuthority.current();
    const task = createPlanItem('Same-time planned', '10:00');
    window.PlanAuthority.saveItems(target, [task]);
    window.CommitmentsRepository.create({ title: 'Same-time commitment', date: '2026-09-19', time: '10:00', precision: 'timed', timezone: 'Asia/Manila', updatedBy: 'device-pc-test' });
    settings.templates.push({ id: 'same-template', activity: 'Same-time template', energy: 'recovery', days: [6], startTime: '10:00', endTime: '10:30', enabled: true, autoLog: false, skipDates: [] });
    entries = [{ id: 'same-actual', activity: 'Same-time actual', energy: 'deep', date: '2026-09-19', tsStart: Date.parse('2026-09-19T10:00:00+08:00'), ts: Date.parse('2026-09-19T10:30:00+08:00'), blockIntervalMin: 30 }];
    refreshAuthoritativePlanSurfaces();
  });
  const text = await page.locator('#timeline-blocks').innerText();
  const labels = ['Same-time planned', 'Same-time commitment', 'Same-time template', 'Same-time actual'];
  const positions = labels.map(label => text.indexOf(label));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
});

test('Prepare Tomorrow shows Top priorities and Other planned tasks as separate sections', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => openPlanTomorrow());
  const modal = page.locator('#plan-tomorrow-overlay');
  await expect(modal).toContainText('Top priorities');
  await expect(modal).toContainText('Other planned tasks');

  await modal.locator('#plan-tomorrow-add input[name="task"]').fill('A priority');
  await modal.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await modal.locator('#plan-tomorrow-add-task input[name="task"]').fill('A secondary task');
  await modal.locator('#plan-tomorrow-add-task').getByRole('button', { name: 'Add' }).click();
  await expect(modal).toContainText('1/3');
  await expect(modal).toContainText('A secondary task');

  await page.getByRole('button', { name: /is ready|Confirm/ }).first().click();
  await expect(modal).not.toHaveClass(/open/);

  // The confirmed preparation carries the PRIORITY only.
  const prep = await page.evaluate(() => window.PlanAuthority.preparation(window.PlanAuthority.upcoming()));
  expect(prep.oneOffItemIds.length).toBe(1);
  const items = await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.upcoming()).map(i => [i.task, i.kind || 'priority']));
  expect(items).toEqual(expect.arrayContaining([['A priority', 'priority'], ['A secondary task', 'task']]));
});

// ═══════════════════════════════════════════════════════════════════════
// 2. scheduled commitments
// ═══════════════════════════════════════════════════════════════════════

async function addCommitment(page, { title, date, time = '', duration = '', note = '', timezone = null }) {
  await continuity(page).getByRole('button', { name: /Add/ }).first().click();
  await page.getByRole('button', { name: 'Commitment', exact: true }).click();
  const form = page.locator('#pc-commitment-form');
  await form.locator('input[name="title"]').fill(title);
  await form.locator('input[name="date"]').fill(date);
  if (time) await form.locator('input[name="time"]').fill(time);
  if (duration) await form.locator('input[name="durationMinutes"]').fill(String(duration));
  if (note) await form.locator('input[name="note"]').fill(note);
  if (timezone) await form.locator('input[name="timezone"]').fill(timezone);
  await form.getByRole('button', { name: /^(Add|Save)$/ }).click();
  if (!await form.isVisible()) await page.evaluate(() => openPlanningDetails('commitments'));
}

test('the dentist is entered by real date and time, and lands on the personal day that contains it', async ({ page }) => {
  await openApp(page);
  await addCommitment(page, { title: 'Dentist', date: '2026-09-30', time: '09:30' });

  await expect(continuity(page)).toContainText('Dentist');
  await expect(continuity(page)).toContainText('9:30 AM');

  // Sep 30 09:30 under an 18:00 boundary belongs to the day that began Sep 29 18:00.
  const owned = await page.evaluate(() => {
    const records = Object.values(window.CommitmentsRepository.listAllRaw());
    const record = records.find(r => r.title === 'Dentist');
    const target = window.PlanAuthority.containing(record.startMs);
    return { startMs: record.startMs, dayStart: target.startMs, dayEnd: target.endMs, boundaryStartDate: target.ref.boundaryStartDate };
  });
  expect(owned.startMs).toBe(Date.parse('2026-09-30T09:30:00+08:00'));
  expect(owned.dayStart).toBe(Date.parse('2026-09-29T18:00:00+08:00'));
  expect(owned.dayEnd).toBe(Date.parse('2026-09-30T18:00:00+08:00'));
  expect(owned.boundaryStartDate).toBe('2026-09-29');
});

test('a commitment appears on its own day in the future-day browser, not on the neighbouring one', async ({ page }) => {
  await openApp(page);
  // Two days out from the current personal day (Sep 18 18:00) is Sep 20 18:00.
  await addCommitment(page, { title: 'Evening call', date: '2026-09-20', time: '21:30' });
  await page.evaluate(() => openPlanningDetails('browse'));

  const dayIds = await page.evaluate(() => {
    const records = Object.values(window.CommitmentsRepository.listAllRaw());
    const model = window.CommitmentsModel;
    return window.PlanAuthority.upcomingDays(6).map(t => ({
      id: t.id,
      titles: model.commitmentsForTarget(records, t).map(c => c.title),
    }));
  });
  const withCall = dayIds.filter(d => d.titles.includes('Evening call'));
  expect(withCall).toHaveLength(1);
  expect(withCall[0].id).toContain('2026-09-20');
  await expect(continuity(page)).toContainText('Evening call');
});

test('a date-only commitment shows its date and never a fabricated time', async ({ page }) => {
  await openApp(page);
  await addCommitment(page, { title: 'Passport renewal', date: '2026-10-05' });

  await expect(continuity(page)).toContainText('Passport renewal');
  await expect(continuity(page)).toContainText('no time set');
  // Neither the noon anchor nor midnight is ever rendered.
  await expect(continuity(page)).not.toContainText('12:00');
  await expect(continuity(page)).not.toContainText('00:00');

  const record = await page.evaluate(() => Object.values(window.CommitmentsRepository.listAllRaw()).find(r => r.title === 'Passport renewal'));
  expect(record.precision).toBe('date');
  expect(record.time).toBeNull();
  expect(record.startMs).toBe(Date.parse('2026-10-05T12:00:00+08:00'));
});

test('a nonexistent DST clock time is refused with an explanation, and nothing is stored', async ({ page }) => {
  await openApp(page);
  await addCommitment(page, { title: 'Impossible', date: '2027-03-14', time: '02:30', timezone: 'America/New_York' });
  await expect(page.locator('#pc-commitment-form')).toContainText('does not exist');
  expect(await page.evaluate(() => Object.keys(window.CommitmentsRepository.listAllRaw()).length)).toBe(0);
});

test('an ambiguous DST clock time asks which instant the owner meant, and records the choice', async ({ page }) => {
  await openApp(page);
  await addCommitment(page, { title: 'Repeated hour', date: '2026-11-01', time: '01:30', timezone: 'America/New_York' });
  const form = page.locator('#pc-commitment-form');
  await expect(form).toContainText('happens twice');
  expect(await page.evaluate(() => Object.keys(window.CommitmentsRepository.listAllRaw()).length)).toBe(0);

  await form.getByRole('button', { name: 'Second (later)' }).click();
  const record = await page.evaluate(() => Object.values(window.CommitmentsRepository.listAllRaw())[0]);
  expect(record.dstChoice).toBe('later');
  expect(record.startMs).toBe(Date.parse('2026-11-01T01:30:00-05:00'));
});

test('a commitment can be edited and deleted, keeping its id and tombstoning on delete', async ({ page }) => {
  await openApp(page);
  await addCommitment(page, { title: 'Dentist', date: '2026-09-30', time: '09:30', note: 'bring x-rays' });
  const originalId = await page.evaluate(() => Object.keys(window.CommitmentsRepository.listAllRaw())[0]);
  await expect(continuity(page)).toContainText('bring x-rays');

  await continuity(page).getByRole('button', { name: /^Edit Dentist$/ }).click();
  const form = page.locator('#pc-commitment-form');
  await form.locator('input[name="time"]').fill('14:00');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(continuity(page)).toContainText('2:00 PM');
  expect(await page.evaluate(() => Object.keys(window.CommitmentsRepository.listAllRaw()))).toEqual([originalId]);

  await continuity(page).getByRole('button', { name: /^Delete Dentist$/ }).click();
  await expect(continuity(page)).not.toContainText('Dentist');
  const after = await page.evaluate(() => window.CommitmentsRepository.read(Object.keys(window.CommitmentsRepository.listAllRaw())[0]));
  expect(after.deleted).toBe(true);
});

test('commitments survive a reload and never consume a priority slot', async ({ page }) => {
  await openApp(page);
  for (const task of ['First', 'Second', 'Third']) await addPriority(page, task);
  await addCommitment(page, { title: 'Dentist', date: '2026-09-30', time: '09:30' });

  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object' && typeof window.CommitmentsRepository === 'object');
  await page.evaluate(() => openPlanningDetails('commitments'));
  await expect(continuity(page)).toContainText('Dentist');

  const state = await page.evaluate(() => {
    const target = window.PlanAuthority.current();
    return {
      priorities: window.PlanAuthority.items(target).filter(i => i.kind !== 'task').length,
      commitments: Object.keys(window.CommitmentsRepository.listAllRaw()).length,
      prepared: window.PlanAuthority.preparedState(target).prepared,
    };
  });
  expect(state).toEqual({ priorities: 3, commitments: 1, prepared: false });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. future personal-day browser
// ═══════════════════════════════════════════════════════════════════════

test('the browser lists personal days by their real interval and prepares an arbitrary one', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => openPlanningDetails('browse'));
  const browser = continuity(page).locator('.pc-block', { hasText: 'Browse future My Days' });
  await expect(browser).toContainText('Today');
  await expect(browser).toContainText('Next');
  // Every listed day names the hours it covers, never a bare calendar date alone.
  await expect(browser).toContainText('6:00 PM');

  const days = browser.locator('.pc-day');
  await expect(days).toHaveCount(14);

  // Prepare a day several rows out through the ONE preparation workflow.
  const targetDayId = await page.evaluate(() => window.PlanAuthority.dayAhead(5).id);
  await browser.locator(`.pc-day[data-pc-day="${targetDayId}"]`).getByRole('button', { name: 'Prepare' }).click();
  const modal = page.locator('#plan-tomorrow-overlay');
  await expect(modal).toHaveClass(/open/);
  // The title names the day actually being edited, not "tomorrow".
  await expect(page.locator('#plan-tomorrow-title')).not.toHaveText('Plan tomorrow');

  await modal.locator('#plan-tomorrow-add input[name="task"]').fill('Five days out');
  await modal.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: /is ready|Confirm/ }).first().click();
  await expect(modal).not.toHaveClass(/open/);

  const stored = await page.evaluate(id => {
    const target = window.PlanAuthority.targetById(id);
    return { tasks: window.PlanAuthority.items(target).map(i => i.task), prepared: window.PlanAuthority.preparedState(target).prepared };
  }, targetDayId);
  expect(stored.tasks).toEqual(['Five days out']);
  expect(stored.prepared).toBe(true);
});

test('a day prepared weeks ahead survives a reload and is still discoverable', async ({ page }) => {
  await openApp(page);
  const farDayId = await page.evaluate(() => {
    const target = window.PlanAuthority.dayAhead(21);
    window.PlanAuthority.confirmPreparation(target, {
      items: [{ id: 'pfar', task: 'Three weeks out', when: '', done: false, doneAt: null, updatedAt: Date.now(), updatedBy: 'device-pc-test' }],
      mode: 'normal', intentionalBlank: false, routineInstanceIds: [],
    });
    return target.id;
  });

  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');
  const after = await page.evaluate(id => {
    const target = window.PlanAuthority.targetById(id);
    return { tasks: window.PlanAuthority.items(target).map(i => i.task), prepared: window.PlanAuthority.preparedState(target).prepared };
  }, farDayId);
  expect(after.tasks).toEqual(['Three weeks out']);
  expect(after.prepared).toBe(true);
});

test('a boundary change warns by name about a far-future prepared day', async ({ page }) => {
  await openApp(page);
  const farDayId = await page.evaluate(() => {
    const target = window.PlanAuthority.dayAhead(21);
    window.PlanAuthority.confirmPreparation(target, {
      items: [{ id: 'pfar', task: 'Three weeks out', when: '', done: false, doneAt: null, updatedAt: Date.now(), updatedBy: 'device-pc-test' }],
      mode: 'normal', intentionalBlank: false, routineInstanceIds: [],
    });
    return target.id;
  });
  const named = await page.evaluate(() => window.PlanAuthority
    .boundaryChangeImpact({ boundaryTime: '20:00', timezone: 'Asia/Manila' })
    .orphaned.map(t => t.id));
  expect(named).toContain(farDayId);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Unfinished from previous days
// ═══════════════════════════════════════════════════════════════════════

/** A stored operational plan for the personal day that began `daysAgo` days before
 *  the current one, holding one unfinished task. */
function staleOperationalPlans(daysAgo, task = 'Slipped task', extra = {}) {
  const startDate = new Date(Date.parse('2026-09-18T18:00:00+08:00') - daysAgo * 86400000);
  const boundaryStartDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(startDate);
  const id = `odv1:r-1800:Asia/Manila:${boundaryStartDate}`;
  return JSON.stringify({ schemaVersion: 1, plans: { [id]: {
    items: [{ id: 'pstale', task, when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'device-pc-test', ...extra }],
    updatedAt: 1000, updatedBy: 'device-pc-test',
  } } });
}

function manyStaleOperationalPlans(count) {
  const parsed = JSON.parse(staleOperationalPlans(4));
  const record = Object.values(parsed.plans)[0];
  record.items = Array.from({ length: count }, (_, index) => ({
    id: `pstale-${index}`,
    task: `Stale task ${index + 1}`,
    when: '', done: false, doneAt: null, updatedAt: 1000 + index, updatedBy: 'device-pc-test',
  }));
  return JSON.stringify(parsed);
}

test('30 stale tasks occupy one compact main-page indicator until opened', async ({ page }) => {
  await openApp(page, { operationalPlans: manyStaleOperationalPlans(30) });
  const trigger = unfinished(page).getByRole('button', { name: 'Unfinished · 30' });
  await expect(trigger).toBeVisible();
  await expect(unfinished(page)).not.toContainText('Stale task 1');
  const compactHeight = await unfinished(page).evaluate(element => element.getBoundingClientRect().height);
  expect(compactHeight).toBeLessThan(140);
  await trigger.click();
  await expect(unfinished(page)).toContainText('Stale task 30');
});

test('long task titles keep usable controls at mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp(page);
  await addPriority(page, 'A very long planned task title that must wrap without pushing the checkbox and edit action beyond the narrow mobile viewport');
  const row = page.locator('#timeline-anytime [data-plan-item-id]').first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  await expect(row.getByRole('button', { name: /Mark done/ })).toBeVisible();
  await expect(row.getByRole('button', { name: /Edit planned task/ })).toBeVisible();
});

test('an unfinished task from 3 days ago is discoverable and moves to today exactly once', async ({ page }) => {
  await openApp(page, { operationalPlans: staleOperationalPlans(4) });

  const recovery = await openStaleRecovery(page);
  await expect(recovery).toContainText('Slipped task');
  await expect(recovery).toContainText('3 days ago');

  await recovery.getByRole('button', { name: 'Move to today' }).click();
  await expect(recovery).toHaveCount(0);
  await expect(strip(page)).toContainText('Slipped task');

  const state = await page.evaluate(() => {
    const today = window.PlanAuthority.current();
    const items = window.PlanAuthority.items(today);
    const stale = window.PlanAuthority.staleUnfinished();
    const source = window.PlanAuthority.recoverableDays().find(d => d.target.id !== today.id);
    return {
      todayTasks: items.map(i => i.task),
      carriedFrom: items.map(i => i.carriedFromId),
      staleCount: stale.items.length,
      originalStillThere: window.PlanAuthority.rawItems(source.target).map(i => ({ id: i.id, done: i.done, deleted: !!i.deleted })),
    };
  });
  expect(state.todayTasks).toEqual(['Slipped task']);
  expect(state.carriedFrom).toEqual(['pstale']);
  expect(state.staleCount).toBe(0);
  // History is not rewritten: the original stays planned-and-not-done on its own day.
  expect(state.originalStillThere).toEqual([{ id: 'pstale', done: false, deleted: false }]);
});

test('an unfinished task from weeks ago is still discoverable', async ({ page }) => {
  await openApp(page, { operationalPlans: staleOperationalPlans(30, 'Ancient task') });
  const recovery = await openStaleRecovery(page);
  await expect(recovery).toContainText('Ancient task');
  await expect(recovery).toContainText('weeks ago');
});

test('a completed historical task never appears as unfinished', async ({ page }) => {
  await openApp(page, { operationalPlans: staleOperationalPlans(3, 'Finished task', { done: true, doneAt: 1500 }) });
  await expect(unfinished(page)).not.toContainText('Unfinished ·');
});

test('a dismissed stale task stops resurfacing and is not marked done', async ({ page }) => {
  await openApp(page, { operationalPlans: staleOperationalPlans(3) });
  const recovery = await openStaleRecovery(page);
  await recovery.getByRole('button', { name: 'Not doing this' }).click();
  await expect(unfinished(page)).not.toContainText('Unfinished ·');

  const original = await page.evaluate(() => {
    const today = window.PlanAuthority.current();
    const source = window.PlanAuthority.recoverableDays().find(d => d.target.id !== today.id);
    return window.PlanAuthority.rawItems(source.target)[0];
  });
  expect(original.done).toBe(false);
  expect(typeof original.dismissedAt).toBe('number');
});

test('a stale task can be rescheduled onto an arbitrary future personal day', async ({ page }) => {
  await openApp(page, { operationalPlans: staleOperationalPlans(3) });
  const recovery = await openStaleRecovery(page);
  await recovery.getByRole('button', { name: 'Reschedule…' }).click();

  // The browser opens so the owner can pick a destination rather than it being guessed.
  const browser = continuity(page).locator('.pc-block', { hasText: 'Browse future My Days' });
  await expect(browser).toBeVisible();
  const targetDayId = await page.evaluate(() => window.PlanAuthority.dayAhead(4).id);
  await browser.locator(`.pc-day[data-pc-day="${targetDayId}"]`).getByRole('button', { name: 'Prepare' }).click();

  const state = await page.evaluate(id => ({
    destination: window.PlanAuthority.items(window.PlanAuthority.targetById(id)).map(i => i.task),
    today: window.PlanAuthority.items(window.PlanAuthority.current()).map(i => i.task),
    stale: window.PlanAuthority.staleUnfinished().items.length,
  }), targetDayId);
  expect(state.destination).toEqual(['Slipped task']);
  expect(state.today).toEqual([]);
  expect(state.stale).toBe(0);
});

test('a reload preserves a recovered task and does not re-offer it', async ({ page }) => {
  await openApp(page, { operationalPlans: staleOperationalPlans(3) });
  const recovery = await openStaleRecovery(page);
  await recovery.getByRole('button', { name: 'Move to today' }).click();
  await expect(strip(page)).toContainText('Slipped task');

  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');
  await expect(strip(page)).toContainText('Slipped task');
  await expect(unfinished(page)).not.toContainText('Unfinished ·');
});

test('a LEGACY stale task is discoverable and moves into the current personal day', async ({ page }) => {
  // A pre-boundary calendar-day plan, which lives in the legacy plans[dateKey] store.
  const plans = JSON.stringify({ '2026-08-25': { items: [
    { id: 'plegacy', task: 'Legacy slipped', when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'device-pc-test' },
  ], updatedAt: 1000 } });
  await openApp(page, { plans });

  const recovery = await openStaleRecovery(page);
  await expect(recovery).toContainText('Legacy slipped');
  await recovery.getByRole('button', { name: 'Move to today' }).click();
  await expect(strip(page)).toContainText('Legacy slipped');

  const state = await page.evaluate(() => ({
    today: window.PlanAuthority.items(window.PlanAuthority.current()).map(i => ({ task: i.task, from: i.carriedFromId })),
    legacyUntouched: JSON.parse(localStorage.getItem('ta3-plans:uid_pc-user'))['2026-08-25'].items.map(i => ({ id: i.id, done: i.done })),
  }));
  expect(state.today).toEqual([{ task: 'Legacy slipped', from: 'plegacy' }]);
  expect(state.legacyUntouched).toEqual([{ id: 'plegacy', done: false }]);
});

// ═══════════════════════════════════════════════════════════════════════
// 5. legacy account regression
// ═══════════════════════════════════════════════════════════════════════

test('a never-enabled account keeps calendar behaviour, and the new surfaces still work', async ({ page }) => {
  await openApp(page, { boundaryStore: null });

  const legacy = await page.evaluate(() => ({
    store: window.PlanAuthority.current().store,
    enabled: window.PlanAuthority.enabled(),
    operational: localStorage.getItem('ta3-operational-plans-v1:uid_pc-user'),
    revisions: localStorage.getItem('ta3-day-boundary-revisions-v1:uid_pc-user'),
  }));
  expect(legacy.store).toBe('legacy');
  expect(legacy.enabled).toBe(false);
  expect(legacy.operational).toBeNull();
  expect(legacy.revisions).toBeNull();

  // The 3-cap and the uncapped tasks block behave the same on a calendar day.
  for (const task of ['A', 'B', 'C']) await addPriority(page, task);
  await expect(strip(page)).toContainText('C');
  await addSecondaryTask(page, 'Extra task');
  await expect(strip(page)).toContainText('Extra task');

  // Commitments work with no boundary at all, projecting onto plain calendar days.
  await addCommitment(page, { title: 'Dentist', date: '2026-09-30', time: '09:30' });
  const owned = await page.evaluate(() => {
    const record = Object.values(window.CommitmentsRepository.listAllRaw())[0];
    const target = window.PlanAuthority.containing(record.startMs);
    return { store: target.store, dateKey: target.dateKey };
  });
  expect(owned).toEqual({ store: 'legacy', dateKey: '2026-09-30' });

  // Still no operational record was created by any of it.
  expect(await page.evaluate(() => localStorage.getItem('ta3-operational-plans-v1:uid_pc-user'))).toBeNull();
});
