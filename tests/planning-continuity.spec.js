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
    localStorage.setItem('ta3-tz', timezone);
    localStorage.setItem('ta3-device-id', 'device-pc-test');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', '[]');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-plans', plans);
    localStorage.setItem('ta3-daily-routines-v1', routines);
    if (boundaryStore) localStorage.setItem('ta3-day-boundary-revisions-v1', boundaryStore);
    if (operationalPlans) localStorage.setItem('ta3-operational-plans-v1', operationalPlans);
    if (commitments) localStorage.setItem('ta3-commitments-v1', commitments);
  }, { timezone: TZ, now, boundaryStore, plans, operationalPlans, commitments, routines: ROUTINES });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object' && typeof window.CommitmentsRepository === 'object');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

const strip = page => page.locator('#plan-strip');
const continuity = page => page.locator('#planning-continuity-section');

async function openStripEditor(page) {
  const cls = (await strip(page).getAttribute('class')) || '';
  if (!cls.includes('editing')) {
    await strip(page).getByRole('button', { name: 'Edit', exact: true }).click();
  }
}

async function addPriority(page, task) {
  await openStripEditor(page);
  await page.locator('#plan-task').fill(task);
  await strip(page).locator('.plan-editor').getByRole('button', { name: 'Add' }).click();
}

async function addSecondaryTask(page, task) {
  await openStripEditor(page);
  await page.locator('#plan-task-task').fill(task);
  await strip(page).locator('.plan-secondary').getByRole('button', { name: 'Add' }).click();
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Top 3 priorities vs uncapped other planned tasks
// ═══════════════════════════════════════════════════════════════════════

test('3 priorities fill the cap, a 4th is refused with an explicit message, and 10 other tasks are all accepted', async ({ page }) => {
  await openApp(page);

  for (const task of ['First', 'Second', 'Third']) await addPriority(page, task);
  await expect(strip(page)).toContainText('First');
  await expect(strip(page)).toContainText('3 of 3 priorities');

  // The 4th priority is REFUSED, and says what to do instead — never silently dropped.
  await openStripEditor(page);
  await expect(page.locator('#plan-task')).toHaveCount(0);
  await expect(strip(page)).toContainText('add it below as another task');

  // Secondary tasks are uncapped: ten of them all land.
  for (let n = 1; n <= 10; n++) await addSecondaryTask(page, `Task ${n}`);
  const secondary = strip(page).locator('.plan-secondary .plan-item');
  await expect(secondary).toHaveCount(10);
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
  await continuity(page).getByRole('button', { name: 'Add commitment' }).click();
  const form = page.locator('#pc-commitment-form');
  await form.locator('input[name="title"]').fill(title);
  await form.locator('input[name="date"]').fill(date);
  if (time) await form.locator('input[name="time"]').fill(time);
  if (duration) await form.locator('input[name="durationMinutes"]').fill(String(duration));
  if (note) await form.locator('input[name="note"]').fill(note);
  if (timezone) await form.locator('input[name="timezone"]').fill(timezone);
  await form.getByRole('button', { name: /^(Add|Save)$/ }).click();
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
  await continuity(page).getByRole('button', { name: 'Plan another day…' }).click();

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
  await continuity(page).getByRole('button', { name: 'Plan another day…' }).click();
  const browser = continuity(page).locator('.pc-block', { hasText: 'Plan another day' });
  await expect(browser).toContainText('Today');
  await expect(browser).toContainText('Next');
  // Every listed day names the hours it covers, never a bare calendar date alone.
  await expect(browser).toContainText('18:00');

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

test('an unfinished task from 3 days ago is discoverable and moves to today exactly once', async ({ page }) => {
  await openApp(page, { operationalPlans: staleOperationalPlans(4) });

  const recovery = continuity(page).locator('.pc-block', { hasText: 'Unfinished from previous days' });
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
  const recovery = continuity(page).locator('.pc-block', { hasText: 'Unfinished from previous days' });
  await expect(recovery).toContainText('Ancient task');
  await expect(recovery).toContainText('weeks ago');
});

test('a completed historical task never appears as unfinished', async ({ page }) => {
  await openApp(page, { operationalPlans: staleOperationalPlans(3, 'Finished task', { done: true, doneAt: 1500 }) });
  await expect(continuity(page)).not.toContainText('Unfinished from previous days');
});

test('a dismissed stale task stops resurfacing and is not marked done', async ({ page }) => {
  await openApp(page, { operationalPlans: staleOperationalPlans(3) });
  const recovery = continuity(page).locator('.pc-block', { hasText: 'Unfinished from previous days' });
  await recovery.getByRole('button', { name: 'Not doing this' }).click();
  await expect(continuity(page)).not.toContainText('Unfinished from previous days');

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
  const recovery = continuity(page).locator('.pc-block', { hasText: 'Unfinished from previous days' });
  await recovery.getByRole('button', { name: 'Reschedule…' }).click();

  // The browser opens so the owner can pick a destination rather than it being guessed.
  const browser = continuity(page).locator('.pc-block', { hasText: 'Plan another day' });
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
  const recovery = continuity(page).locator('.pc-block', { hasText: 'Unfinished from previous days' });
  await recovery.getByRole('button', { name: 'Move to today' }).click();
  await expect(strip(page)).toContainText('Slipped task');

  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');
  await expect(strip(page)).toContainText('Slipped task');
  await expect(continuity(page)).not.toContainText('Unfinished from previous days');
});

test('a LEGACY stale task is discoverable and moves into the current personal day', async ({ page }) => {
  // A pre-boundary calendar-day plan, which lives in the legacy plans[dateKey] store.
  const plans = JSON.stringify({ '2026-08-25': { items: [
    { id: 'plegacy', task: 'Legacy slipped', when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'device-pc-test' },
  ], updatedAt: 1000 } });
  await openApp(page, { plans });

  const recovery = continuity(page).locator('.pc-block', { hasText: 'Unfinished from previous days' });
  await expect(recovery).toContainText('Legacy slipped');
  await recovery.getByRole('button', { name: 'Move to today' }).click();
  await expect(strip(page)).toContainText('Legacy slipped');

  const state = await page.evaluate(() => ({
    today: window.PlanAuthority.items(window.PlanAuthority.current()).map(i => ({ task: i.task, from: i.carriedFromId })),
    legacyUntouched: JSON.parse(localStorage.getItem('ta3-plans'))['2026-08-25'].items.map(i => ({ id: i.id, done: i.done })),
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
    operational: localStorage.getItem('ta3-operational-plans-v1'),
    revisions: localStorage.getItem('ta3-day-boundary-revisions-v1'),
  }));
  expect(legacy.store).toBe('legacy');
  expect(legacy.enabled).toBe(false);
  expect(legacy.operational).toBeNull();
  expect(legacy.revisions).toBeNull();

  // The 3-cap and the uncapped tasks block behave the same on a calendar day.
  for (const task of ['A', 'B', 'C']) await addPriority(page, task);
  await expect(strip(page)).toContainText('3 of 3 priorities');
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
  expect(await page.evaluate(() => localStorage.getItem('ta3-operational-plans-v1'))).toBeNull();
});
