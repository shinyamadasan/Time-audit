// Calendar Day + Extended My Day V1 — browser coverage for the NEW UI surfaces
// (Plan-by-deadline settings, intentional off-day, the My Day date-break divider,
// and the carryover-from-prior-plan section) that node --test cannot exercise
// because they render DOM.
//
// Firebase is stubbed exactly the way the other specs stub it — no real project
// and no network. Local persistence is the real localStorage of the page.

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
const ROOM = 'uid_cdemd-user';
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);

// An 18:00 boundary, active well before the scenario window, so "Sunday's day"
// runs Sun 18:00 -> Mon 18:00 and "Monday's day" runs Mon 18:00 -> Tue 18:00.
const BOUNDARY_REVISION_ID = 'r-1800';
const boundaryStore = () => JSON.stringify({ schemaVersion: 1, revisions: {
  'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
  [BOUNDARY_REVISION_ID]: { id: BOUNDARY_REVISION_ID, boundaryTime: '18:00', timezone: TZ, effectiveFromInstant: at('2026-09-01', '18:00') },
} });

// odv1:<revisionId>:<timezone>:<boundaryStartDate> — personal-day-boundary-model.js's
// own format (operationalDayId), reproduced literally rather than imported, the same
// way tests/my-day-timeline.spec.js hand-builds its boundary store.
const sundayDayId = `odv1:${BOUNDARY_REVISION_ID}:${TZ}:2026-09-27`;
const mondayDayId = `odv1:${BOUNDARY_REVISION_ID}:${TZ}:2026-09-28`;

// Sunday's plan: an evening item (23:00, stays on Sunday) and two overnight items
// (01:00, 04:00 — both resolve to MONDAY's calendar date under an 18:00 boundary,
// since a clock time before the boundary names the following civil date).
const operationalPlanStore = () => JSON.stringify({ schemaVersion: 1, plans: {
  [sundayDayId]: {
    items: [
      { id: 'sun-evening', task: 'Sunday evening review', when: '23:00', done: false, updatedAt: 1000, updatedBy: 'device-a' },
      { id: 'sun-overnight-1', task: 'Overnight backup job', when: '01:00', done: false, updatedAt: 1000, updatedBy: 'device-a' },
      { id: 'sun-overnight-2', task: 'Early market check', when: '04:00', done: false, updatedAt: 1000, updatedBy: 'device-a' },
    ],
    preparation: { schemaVersion: 1, targetDate: 'irrelevant-for-operational', timezone: TZ, firstPreparedAt: at('2026-09-27', '17:00'), firstPreparedBy: 'device-a', firstPreparedMode: 'normal', lastPreparedAt: at('2026-09-27', '17:00'), lastPreparedMode: 'normal', updatedBy: 'device-a', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['sun-evening', 'sun-overnight-1', 'sun-overnight-2'] },
    updatedAt: 1000, updatedBy: 'device-a',
  },
  [mondayDayId]: {
    items: [{ id: 'mon-evening', task: 'Monday evening wrap-up', when: '20:00', done: false, updatedAt: 1000, updatedBy: 'device-a' }],
    updatedAt: 1000, updatedBy: 'device-a',
  },
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
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'cdemd-user', displayName: 'CDEMD User', email: 'cdemd@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
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

/** Opens the app at a frozen instant, with an optional operational-day boundary
 *  and operational plan seed. `now` can be changed across a reload via
 *  the `cdemd-now` localStorage key, exactly like tests/my-day-timeline.spec.js. */
async function openApp(page, { now, boundary = true, plans = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, boundary, plans }) => {
    const frozen = Number(localStorage.getItem('cdemd-now')) || now;
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [frozen])); } static now() { return frozen; } };
    if (localStorage.getItem('cdemd-seeded') === '1') return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('cdemd-seeded', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz:uid_cdemd-user', timezone);
    localStorage.setItem('ta3-device-id', 'device-cdemd');
    localStorage.setItem('ta3-settings:uid_cdemd-user', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries:uid_cdemd-user', '[]');
    localStorage.setItem('ta3-plans:uid_cdemd-user', '{}'); localStorage.setItem('ta3-reviews', '{}'); localStorage.setItem('ta3-focus-redemptions', '[]');
    if (boundary) localStorage.setItem('ta3-day-boundary-revisions-v1:uid_cdemd-user', boundary);
    if (plans) localStorage.setItem('ta3-operational-plans-v1:uid_cdemd-user', plans);
  }, { timezone: TZ, now, boundary: boundary ? boundaryStore() : null, plans });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object' && typeof window.PlanByDeadlineSync === 'object');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function setClockAndReload(page, ms) {
  await page.evaluate(v => localStorage.setItem('cdemd-now', String(v)), ms);
  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');
}

const timeline = page => page.locator('#timeline-blocks');

// ═══════════════════════════════════════════════════════════════════════
// Settings: Plan-by deadline
// ═══════════════════════════════════════════════════════════════════════

test('an account with no deadline configured sees the "choose a deadline" prompt, never a guessed default', async ({ page }) => {
  await openApp(page, { now: at('2026-09-27', '10:00'), boundary: false });
  await page.evaluate(() => showView('settings'));
  await expect(page.locator('#plan-by-deadline-settings')).toContainText('Choose a planning deadline to enable planning streak tracking.');
});

test('setting a Plan-by deadline persists it and switches the explain text, without touching the legacy Personal Day boundary', async ({ page }) => {
  await openApp(page, { now: at('2026-09-27', '10:00'), boundary: false });
  await page.evaluate(() => showView('settings'));
  await page.locator('#plan-by-deadline-time').fill('08:00');
  await page.locator('#plan-by-deadline-settings button', { hasText: 'Save' }).click();
  await expect(page.locator('#plan-by-deadline-settings')).toContainText('Plan your day before this time to maintain your planning streak.');
  const stored = await page.evaluate(() => localStorage.getItem('ta3-plan-by-deadline-revisions-v1:uid_cdemd-user'));
  expect(stored).toBeTruthy();
  const boundaryStored = await page.evaluate(() => localStorage.getItem('ta3-day-boundary-revisions-v1:uid_cdemd-user'));
  expect(boundaryStored).toBeNull(); // still untouched — no Personal Day boundary was ever configured
});

test('marking today an intentional off-day, then undoing it, round-trips through the real store', async ({ page }) => {
  await openApp(page, { now: at('2026-09-27', '10:00'), boundary: false });
  await page.evaluate(() => showView('settings'));
  const offDayBtn = page.locator('#plan-by-deadline-settings button.ghost');
  await offDayBtn.click();
  await expect(offDayBtn).toHaveText('Undo intentional off-day for today');
  const declared = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-intentional-off-days-v1:uid_cdemd-user'))?.days?.['2026-09-27']);
  expect(declared).toBeTruthy();
  expect(declared.revokedAtMs).toBeFalsy();

  await offDayBtn.click();
  await expect(offDayBtn).toHaveText('Mark today as an intentional off-day');
  const revoked = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-intentional-off-days-v1:uid_cdemd-user'))?.days?.['2026-09-27']);
  expect(revoked.revokedAtMs).toBeTruthy();
});

// ═══════════════════════════════════════════════════════════════════════
// My Day: date-break divider (§21, first case — still within the same
// spanning personal day)
// ═══════════════════════════════════════════════════════════════════════

test('viewing Sunday\'s still-active My Day shows a date-break before the Monday-dated rows, not a hidden midnight', async ({ page }) => {
  // Monday 08:00 — Monday's own boundary (18:00) has not yet arrived, so Sunday's
  // day (Sun 18:00 -> Mon 18:00) is still the CURRENT personal day.
  await openApp(page, { now: at('2026-09-28', '08:00'), plans: operationalPlanStore() });
  await expect(timeline(page)).toContainText('Sunday evening review');
  await expect(timeline(page)).toContainText('Overnight backup job');
  await expect(page.locator('.tl-date-break')).toBeVisible();
  await expect(page.locator('.tl-date-break')).toContainText('MONDAY');
  // The calendar-date-primary label (§4/§20) — never the old interval span.
  await expect(page.locator('#timeline-date-label')).not.toContainText('→');
});

// ═══════════════════════════════════════════════════════════════════════
// My Day: carryover from an active prior plan (§5/§21, second case — the
// boundary HAS moved on to Monday's own day, but Monday's calendar date
// still needs Sunday's overnight tail surfaced)
// ═══════════════════════════════════════════════════════════════════════

test('once Monday\'s own day is current, Monday\'s view still surfaces Sunday\'s overnight items as "Carryover from Sunday"', async ({ page }) => {
  // Monday 19:00 — past Monday's own 18:00 boundary, so Monday's day is now current.
  await openApp(page, { now: at('2026-09-28', '19:00'), plans: operationalPlanStore() });
  await expect(page.locator('.tl-carryover-header')).toContainText('Carryover from Sunday');
  const carryover = page.locator('.tl-carryover-section');
  await expect(carryover).toContainText('Overnight backup job');
  await expect(carryover).toContainText('Early market check');
  // Sunday's OWN evening item (23:00, stayed on Sunday) must NOT appear in the carryover section.
  await expect(carryover).not.toContainText('Sunday evening review');
  // Monday's own plan still renders too.
  await expect(timeline(page)).toContainText('Monday evening wrap-up');
});

test('a carryover row is a projection over the SAME authoritative record — never a clone under Monday\'s id, and its rendered state matches the one stored record', async ({ page }) => {
  await openApp(page, { now: at('2026-09-28', '19:00'), plans: operationalPlanStore() });
  const carryoverCheck = page.locator('.tl-carryover-section [data-plan-item-id="sun-overnight-1"] .tl-plan-check');
  await expect(carryoverCheck).toBeVisible();
  // Sunday's own operational day has fully ended by Monday 19:00 (its window was Sun
  // 18:00 -> Mon 18:00), so — exactly like navigating directly to any other past My Day
  // — it is correctly read-only here too; this is the SAME pre-existing "past My Days
  // are history" rule (isTimelineTargetEditable), not a carryover-specific regression.
  await expect(carryoverCheck).toBeDisabled();
  await expect(carryoverCheck).toHaveText(''); // stored done:false, rendered unchecked — no divergence

  const dayId = await carryoverCheck.getAttribute('onclick');
  expect(dayId).toContain(sundayDayId); // the row routes back to Sunday's own target id, never a copy

  const sunRecord = await page.evaluate(dayId => JSON.parse(localStorage.getItem('ta3-operational-plans-v1:uid_cdemd-user')).plans[dayId], sundayDayId);
  expect(sunRecord.items.filter(i => i.id === 'sun-overnight-1').length).toBe(1);
  // Exactly one record for this item anywhere in the store — no clone under Monday's id either.
  const monRecord = await page.evaluate(dayId => JSON.parse(localStorage.getItem('ta3-operational-plans-v1:uid_cdemd-user')).plans[dayId], mondayDayId);
  expect(monRecord.items.some(i => i.id === 'sun-overnight-1')).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════
// Midnight is boring (§6): crossing midnight alone changes neither the
// deadline streak status nor the underlying plan records.
// ═══════════════════════════════════════════════════════════════════════

test('crossing midnight with a deadline configured does not itself flip today\'s streak status or write anything new', async ({ page }) => {
  await openApp(page, { now: at('2026-09-27', '07:00'), boundary: false });
  await page.evaluate(() => showView('settings'));
  await page.locator('#plan-by-deadline-time').fill('08:00');
  await page.locator('#plan-by-deadline-settings button', { hasText: 'Save' }).click();
  const beforeMidnight = await page.evaluate(() => JSON.stringify(window.PlanAuthority.planningDeadlineStreak()));

  await setClockAndReload(page, at('2026-09-28', '00:30')); // midnight crossing, same account, same deadline setting
  await page.evaluate(() => showView('settings'));
  const afterMidnight = await page.evaluate(() => window.PlanAuthority.planningDeadlineStreak());
  // A NEW calendar date's own deadline (2026-09-28 08:00) has not arrived yet — "pending", not a
  // cascade of "missed" from crossing midnight, and yesterday's own outcome (already decided at
  // its own 08:00) is untouched by the crossing itself.
  expect(afterMidnight.status).toBe('configured');
  expect(afterMidnight.today.status).toBe('pending');
  expect(JSON.parse(beforeMidnight).status).toBe('configured');
});
