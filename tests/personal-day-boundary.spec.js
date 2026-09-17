// Personal Day Boundary Live Wiring V1 — browser coverage for the two NEW UI
// surfaces (the Settings section and the personal-day planning panes), which
// node --test cannot exercise because they render DOM.
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
// 08:00 Asia/Manila on Wednesday 2026-09-16 — the owner's stated case.
const EIGHT_AM = Date.parse('2026-09-16T00:00:00Z');

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
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'pdb-user', displayName: 'PDB User', email: 'pdb@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
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

async function openApp(page, { now = EIGHT_AM, boundaryStore = null, plans = '{}' } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, boundaryStore, plans }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', timezone);
    localStorage.setItem('ta3-device-id', 'device-pdb-test');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', '[]');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-plans', plans);
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify({ schemaVersion: 1, timezone, routines: [], manual: {}, links: {}, focus: {}, skips: {} }));
    if (boundaryStore) localStorage.setItem('ta3-day-boundary-revisions-v1', boundaryStore);
  }, { timezone: TZ, now, boundaryStore, plans });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PersonalDayBoundaryLive === 'object' && typeof window.renderPersonalDayBoundarySettings === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

const openSettings = page => page.evaluate(() => showView('settings'));
const boundaryStore = page => page.evaluate(() => localStorage.getItem('ta3-day-boundary-revisions-v1'));
const panel = page => page.locator('#personal-day-boundary-settings');
const surface = page => page.locator('#operational-plan-section');

// ── legacy account (HARD REQUIREMENT) ───────────────────────────────────────

test('a legacy account sees the OFF state, no personal-day surface on Today, and nothing is persisted', async ({ page }) => {
  await openApp(page);

  // Today is unchanged: the personal-day section is hidden and empty.
  await expect(surface(page)).toBeHidden();
  await expect(surface(page)).toBeEmpty();
  // The legacy Today/Tomorrow commitments pane is still there and working.
  await expect(page.locator('#today-commitments')).toBeVisible();

  await openSettings(page);
  await expect(panel(page)).toContainText('Off. Your day currently starts at midnight');
  await expect(panel(page).locator('[data-pdb-input="enable"]')).not.toBeChecked();
  // The time/timezone editor is not even rendered until the user opts in.
  await expect(panel(page).locator('[data-pdb-input="time"]')).toHaveCount(0);

  // Opening Settings (and Today, and the planning surface) wrote nothing.
  expect(await boundaryStore(page)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('ta3-operational-plans-v1'))).toBeNull();
});

test('ticking Enable still writes nothing until the explicit save', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await panel(page).locator('[data-pdb-input="enable"]').check();
  await expect(panel(page).locator('[data-pdb-input="time"]')).toBeVisible();
  expect(await boundaryStore(page)).toBeNull();
});

// ── first enable at 08:00 for 18:00 (spec §7 / §11) ─────────────────────────

test('enabling an 18:00 boundary at 08:00 states when it activates, then activates exactly there', async ({ page }) => {
  await openApp(page);
  await openSettings(page);

  await panel(page).locator('[data-pdb-input="enable"]').check();
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);

  // Activation timing is stated BEFORE saving, and it is "today" at 08:00.
  await expect(panel(page)).toContainText('This takes effect at');
  await expect(panel(page)).toContainText('18:00 today');
  await expect(panel(page)).toContainText('may be shorter than usual');
  expect(await boundaryStore(page)).toBeNull();

  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();

  // Persisted as an anchor + one prospective revision, and reported as active.
  const stored = JSON.parse(await boundaryStore(page));
  const revisions = Object.values(stored.revisions);
  expect(revisions).toHaveLength(2);
  expect(revisions.filter(r => r.effectiveFromInstant === null)).toHaveLength(1);
  const custom = revisions.find(r => r.effectiveFromInstant !== null);
  expect(custom.boundaryTime).toBe('18:00');
  expect(custom.timezone).toBe(TZ);
  expect(custom.effectiveFromInstant).toBe(Date.parse('2026-09-16T18:00:00+08:00'));

  // No disable/reset control is offered now that it is active.
  await expect(panel(page)).toContainText('Active and adjustable');
  await expect(panel(page).locator('[data-pdb-input="enable"]')).toHaveCount(0);
  for (const forbidden of ['Disable', 'Return to legacy', 'Use calendar day', 'Reset']) {
    await expect(panel(page)).not.toContainText(forbidden);
  }
  // Still freely adjustable.
  await expect(panel(page).locator('[data-pdb-input="time"]')).toBeVisible();
});

// ── the owner's graveyard workflow through the real UI ──────────────────────

test('at 08:00 the owner can prepare the upcoming 18:00 personal day, and it is the current plan after an 18:00 reload', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await panel(page).locator('[data-pdb-input="enable"]').check();
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();
  const stored = await boundaryStore(page);

  await page.evaluate(() => showView('today'));
  await expect(surface(page)).toBeVisible();

  // The day already in progress at 08:00 is still legacy-governed — stated, not hidden.
  const nextPane = surface(page).locator('[data-op-pane-root="upcoming"]');
  await expect(surface(page).locator('[data-op-pane-root="current"]')).toContainText('still uses your existing calendar-day plan');
  await expect(nextPane).not.toContainText('still uses your existing calendar-day plan');

  // Prepare the upcoming personal day, including a post-midnight block that a
  // calendar-day plan could not represent.
  await nextPane.locator('input[name="task"]').fill('Night shift block');
  await nextPane.locator('input[name="when"]').fill('22:00');
  await nextPane.getByRole('button', { name: 'Add' }).click();
  await expect(nextPane).toContainText('Night shift block');

  await nextPane.locator('input[name="task"]').fill('Post-midnight review');
  await nextPane.locator('input[name="when"]').fill('01:00');
  await nextPane.getByRole('button', { name: 'Add' }).click();
  await expect(nextPane).toContainText('Post-midnight review');

  // It went into the operational store, keyed by an operationalDayId (never a bare date),
  // and the legacy plans[dateKey] store was not touched.
  const operational = JSON.parse(await page.evaluate(() => localStorage.getItem('ta3-operational-plans-v1')));
  const ids = Object.keys(operational.plans);
  expect(ids).toHaveLength(1);
  expect(ids[0]).toMatch(/^odv1:/);
  expect(await page.evaluate(() => localStorage.getItem('ta3-plans'))).toBe('{}');

  const operationalStore = await page.evaluate(() => localStorage.getItem('ta3-operational-plans-v1'));

  // ── reload at 18:00: the prepared plan is now the CURRENT personal day's plan ──
  await page.addInitScript(({ boundaryStore, operationalStore, now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.setItem('ta3-day-boundary-revisions-v1', boundaryStore);
    localStorage.setItem('ta3-operational-plans-v1', operationalStore);
  }, { boundaryStore: stored, operationalStore, now: Date.parse('2026-09-16T18:00:00+08:00') });
  await page.reload();
  await page.waitForFunction(() => typeof window.PersonalDayBoundaryLive === 'object');

  const currentPane = surface(page).locator('[data-op-pane-root="current"]');
  await expect(currentPane).toContainText('Night shift block');
  await expect(currentPane).toContainText('Post-midnight review');
  await expect(currentPane).not.toContainText('still uses your existing calendar-day plan');
  // And the next personal day is a genuinely fresh, empty one.
  await expect(surface(page).locator('[data-op-pane-root="upcoming"]')).toContainText('Nothing planned yet.');

  // ── 00:30 the following calendar day: midnight must NOT rotate it ──
  await page.addInitScript(({ now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  }, { now: Date.parse('2026-09-17T00:30:00+08:00') });
  await page.reload();
  await page.waitForFunction(() => typeof window.PersonalDayBoundaryLive === 'object');
  await expect(surface(page).locator('[data-op-pane-root="current"]')).toContainText('Night shift block');
});

// ── boundary change through the real UI ─────────────────────────────────────

test('changing 18:00 -> 20:00 at 21:00 states "tomorrow" and is reported as a pending change', async ({ page }) => {
  // Enable first, at 08:00.
  await openApp(page);
  await openSettings(page);
  await panel(page).locator('[data-pdb-input="enable"]').check();
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();
  const stored = await boundaryStore(page);

  // Reopen at 21:00, after 20:00 has already passed today.
  await page.addInitScript(({ boundaryStore, now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.setItem('ta3-day-boundary-revisions-v1', boundaryStore);
  }, { boundaryStore: stored, now: Date.parse('2026-09-16T21:00:00+08:00') });
  await page.reload();
  await page.waitForFunction(() => typeof window.PersonalDayBoundaryLive === 'object');
  await openSettings(page);

  await expect(panel(page)).toContainText('Active: your personal day starts at');
  await panel(page).locator('[data-pdb-input="time"]').fill('20:00');
  await expect(panel(page)).toContainText('20:00 tomorrow');

  await panel(page).getByRole('button', { name: 'Save personal day start' }).click();

  // History is append-only: the 18:00 revision survives alongside the new one.
  const after = Object.values(JSON.parse(await boundaryStore(page)).revisions);
  expect(after).toHaveLength(3);
  expect(after.map(r => r.boundaryTime).sort()).toEqual(['00:00', '18:00', '20:00']);
  // And the change is shown as pending, not as already active.
  await expect(panel(page)).toContainText('Pending change:');
  await expect(panel(page)).toContainText('20:00 tomorrow');
});
