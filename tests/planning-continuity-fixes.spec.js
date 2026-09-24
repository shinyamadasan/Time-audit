// Planning Continuity V1 — FIX FIRST browser regressions (B2, B3, B4).
// Same harness as tests/planning-continuity.spec.js, copied rather than shared because
// this repo's specs are self-contained files.

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
    if (boundaryStore) localStorage.setItem('ta3-day-boundary-revisions-v1:uid_pc-user', boundaryStore);
    if (operationalPlans) localStorage.setItem('ta3-operational-plans-v1:uid_pc-user', operationalPlans);
    if (commitments) localStorage.setItem('ta3-commitments-v1:uid_pc-user', commitments);
  }, { timezone: TZ, now, boundaryStore, plans, operationalPlans, commitments, routines: ROUTINES });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object' && typeof window.CommitmentsRepository === 'object');
  await page.evaluate(() => { document.getElementById('today-commitments').hidden = false; });
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
  await strip(page).getByRole('button', { name: 'Add', exact: true }).click();
}

async function addSecondaryTask(page, task) {
  await openStripEditor(page);
  await page.locator('#plan-task-task').fill(task);
  await strip(page).locator('.plan-secondary').getByRole('button', { name: 'Plan task' }).click();
}


async function addCommitment(page, { title, date, time = '', duration = '', note = '', timezone = null }) {
  await continuity(page).getByRole('button', { name: '＋ Add' }).click();
  await continuity(page).getByRole('button', { name: 'Commitment' }).click();
  const form = page.locator('#pc-commitment-form');
  await form.locator('input[name="title"]').fill(title);
  await form.locator('input[name="date"]').fill(date);
  if (time) await form.locator('input[name="time"]').fill(time);
  if (duration) await form.locator('input[name="durationMinutes"]').fill(String(duration));
  if (note) await form.locator('input[name="note"]').fill(note);
  if (timezone) await form.locator('input[name="timezone"]').fill(timezone);
  await form.getByRole('button', { name: /^(Add|Save)$/ }).click();
  await page.evaluate(() => openPlanningDetails('commitments'));
}

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

// ═══════════════════════════════════════════════════════════════════════
// FIX FIRST — B2 move into a full Top 3, B3 Make task / Make priority,
// B4 commitment duration values and clearing
// ═══════════════════════════════════════════════════════════════════════

test('B2: moving a stale priority into a full Top 3 lands it under Other planned tasks and says so', async ({ page }) => {
  await openApp(page, { operationalPlans: staleOperationalPlans(4) });
  for (const task of ['First', 'Second', 'Third']) await addPriority(page, task);

  const recovery = page.locator('#unfinished-recovery-section');
  await recovery.getByRole('button', { name: /Unfinished/ }).click();
  await recovery.getByRole('button', { name: 'Move to today' }).click();

  await expect(continuity(page)).toContainText('Moved to Other planned tasks because your Top 3 is already full.');
  await expect(strip(page).locator('.plan-secondary')).toContainText('Slipped task');
  const state = await page.evaluate(() => {
    const items = window.PlanAuthority.items(window.PlanAuthority.current());
    return {
      priorities: items.filter(i => i.kind !== 'task').length,
      moved: items.filter(i => i.carriedFromId === 'pstale').map(i => i.kind || 'priority'),
    };
  });
  expect(state).toEqual({ priorities: 3, moved: ['task'] });

  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');
  expect(await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())
    .filter(i => i.carriedFromId === 'pstale').map(i => i.kind))).toEqual(['task']);
});

test('B2: with room in the Top 3 the moved priority stays a priority and no notice is shown', async ({ page }) => {
  await openApp(page, { operationalPlans: staleOperationalPlans(4) });
  await addPriority(page, 'Only one');
  const recovery = page.locator('#unfinished-recovery-section');
  await recovery.getByRole('button', { name: /Unfinished/ }).click();
  await recovery.getByRole('button', { name: 'Move to today' }).click();
  await expect(strip(page)).toContainText('Slipped task');
  await expect(continuity(page)).not.toContainText('Top 3 is already full');
  expect(await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current())
    .filter(i => i.carriedFromId === 'pstale').map(i => i.kind || 'priority'))).toEqual(['priority']);
});

test('B3: Make task frees a slot, Make priority is refused when full, and items keep their ids', async ({ page }) => {
  await openApp(page);
  for (const task of ['First', 'Second', 'Third']) await addPriority(page, task);
  await addSecondaryTask(page, 'Extra');
  const ids = await page.evaluate(() => Object.fromEntries(window.PlanAuthority.items(window.PlanAuthority.current()).map(i => [i.task, i.id])));

  await openStripEditor(page);
  await strip(page).locator('.plan-secondary .plan-item', { hasText: 'Extra' }).getByRole('button', { name: 'Make priority' }).click();
  await expect(page.locator('#toast')).toContainText('already full');
  expect(await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current()).filter(i => i.kind !== 'task').length)).toBe(3);

  await strip(page).locator('.plan-item', { hasText: 'Third' }).getByRole('button', { name: 'Make task' }).click();
  await expect(strip(page).locator('.plan-secondary')).toContainText('Third');
  await expect(page.locator('#plan-task')).toHaveCount(1);

  await strip(page).locator('.plan-secondary .plan-item', { hasText: 'Extra' }).getByRole('button', { name: 'Make priority' }).click();
  const after = await page.evaluate(() => Object.fromEntries(window.PlanAuthority.items(window.PlanAuthority.current()).map(i => [i.task, { id: i.id, kind: i.kind || 'priority' }])));
  expect(after.Extra).toEqual({ id: ids.Extra, kind: 'priority' });
  expect(after.Third).toEqual({ id: ids.Third, kind: 'task' });
});

test('B3: demoting keeps tracked linkage, and Partner View / focus goal follow the new kind', async ({ page }) => {
  await openApp(page);
  for (const task of ['Keep', 'Demote me']) await addPriority(page, task);
  const demoteId = await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.current()).find(i => i.task === 'Demote me').id);
  expect(await page.evaluate(() => buildPartnerViewPriorityInputs(currentPlanTarget()).map(p => p.title)))
    .toEqual(expect.arrayContaining(['Keep', 'Demote me']));

  await openStripEditor(page);
  await strip(page).locator('.plan-item', { hasText: 'Demote me' }).getByRole('button', { name: 'Make task' }).click();

  const state = await page.evaluate(id => ({
    partner: buildPartnerViewPriorityInputs(currentPlanTarget()).map(p => p.title),
    commitment: (syncCommitmentFromPlan(), dailyCommitment),
    stillSameId: window.PlanAuthority.items(window.PlanAuthority.current()).some(i => i.id === id && i.kind === 'task'),
    trackedLookupWorks: typeof planTrackedMinFor(currentPlanTarget(), 'Demote me', id) === 'number',
  }), demoteId);
  expect(state).toEqual({ partner: ['Keep'], commitment: 1, stillSameId: true, trackedLookupWorks: true });
});

test('B3: Prepare Tomorrow offers Make task / Make priority on the draft and enforces the cap', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => openPlanTomorrow());
  const modal = page.locator('#plan-tomorrow-overlay');
  for (const task of ['Alpha', 'Bravo', 'Charlie']) {
    await modal.locator('#plan-tomorrow-add input[name="task"]').fill(task);
    await modal.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  }
  await modal.locator('#plan-tomorrow-add-task input[name="task"]').fill('Delta');
  await modal.locator('#plan-tomorrow-add-task').getByRole('button', { name: 'Add' }).click();

  await modal.locator('.pt-secondary', { hasText: 'Delta' }).getByRole('button', { name: 'Make priority' }).click();
  await expect(modal).toContainText('already full');

  await modal.locator('.pt-oneoff:not(.pt-secondary)', { hasText: 'Charlie' }).getByRole('button', { name: 'Make task' }).click();
  await modal.locator('.pt-secondary', { hasText: 'Delta' }).getByRole('button', { name: 'Make priority' }).click();
  await page.getByRole('button', { name: /is ready|Confirm/ }).first().click();
  await expect(modal).not.toHaveClass(/open/);

  const stored = await page.evaluate(() => {
    const t = window.PlanAuthority.upcoming();
    return {
      kinds: Object.fromEntries(window.PlanAuthority.items(t).map(i => [i.task, i.kind || 'priority'])),
      preparedIds: window.PlanAuthority.preparation(t).oneOffItemIds.length,
    };
  });
  expect(stored.kinds).toEqual({ Alpha: 'priority', Bravo: 'priority', Charlie: 'task', Delta: 'priority' });
  expect(stored.preparedIds).toBe(3);
});

test('B4: common five-minute durations are valid in the form; out-of-range values are not', async ({ page }) => {
  await openApp(page);
  await continuity(page).getByRole('button', { name: '＋ Add' }).click();
  await continuity(page).getByRole('button', { name: 'Commitment' }).click();
  const input = page.locator('#pc-commitment-form input[name="durationMinutes"]');
  for (const value of ['5', '15', '30', '45', '60', '90', '720']) {
    await input.fill(value);
    expect(await input.evaluate(el => el.checkValidity()), `${value} should be valid`).toBe(true);
  }
  for (const value of ['0', '1', '7', '721']) {
    await input.fill(value);
    expect(await input.evaluate(el => el.checkValidity()), `${value} should be invalid`).toBe(false);
  }
  await input.fill('45');
  const form = page.locator('#pc-commitment-form');
  await form.locator('input[name="title"]').fill('Dentist');
  await form.locator('input[name="date"]').fill('2026-09-30');
  await form.locator('input[name="time"]').fill('09:30');
  await form.getByRole('button', { name: 'Add' }).click();
  await page.evaluate(() => openPlanningDetails('commitments'));
  await expect(continuity(page)).toContainText('9:30–10:15 AM');
});

test('B4: clearing duration and note on edit really clears them, and survives a reload', async ({ page }) => {
  await openApp(page);
  await addCommitment(page, { title: 'Dentist', date: '2026-09-30', time: '09:30', duration: 60, note: 'bring x-rays' });
  const id = await page.evaluate(() => Object.keys(window.CommitmentsRepository.listAllRaw())[0]);
  await expect(continuity(page)).toContainText('bring x-rays');
  await expect(continuity(page)).toContainText('9:30–10:30 AM');

  await continuity(page).getByRole('button', { name: /^Edit Dentist$/ }).click();
  const form = page.locator('#pc-commitment-form');
  await form.locator('input[name="durationMinutes"]').fill('');
  await form.locator('input[name="note"]').fill('');
  await form.getByRole('button', { name: 'Save' }).click();

  await expect(continuity(page)).not.toContainText('bring x-rays');
  await expect(continuity(page)).not.toContainText('10:30');
  await expect(continuity(page)).toContainText('9:30 AM');
  const record = await page.evaluate(() => Object.values(window.CommitmentsRepository.listAllRaw())[0]);
  expect(record.id).toBe(id);
  expect('durationMinutes' in record).toBe(false);
  expect('note' in record).toBe(false);

  await page.reload();
  await page.waitForFunction(() => typeof window.CommitmentsRepository === 'object');
  const after = await page.evaluate(() => Object.values(window.CommitmentsRepository.listAllRaw())[0]);
  expect('durationMinutes' in after).toBe(false);
  expect('note' in after).toBe(false);
});
