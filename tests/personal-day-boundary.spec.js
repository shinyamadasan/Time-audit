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
    localStorage.setItem('ta3-tz:uid_pdb-user', timezone);
    localStorage.setItem('ta3-device-id', 'device-pdb-test');
    localStorage.setItem('ta3-settings:uid_pdb-user', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries:uid_pdb-user', '[]');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-plans:uid_pdb-user', plans);
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify({ schemaVersion: 1, timezone, routines: [], manual: {}, links: {}, focus: {}, skips: {} }));
    if (boundaryStore) localStorage.setItem('ta3-day-boundary-revisions-v1:uid_pdb-user', boundaryStore);
  }, { timezone: TZ, now, boundaryStore, plans });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PersonalDayBoundaryLive === 'object' && typeof window.renderPersonalDayBoundarySettings === 'function');
  await page.evaluate(() => { document.getElementById('today-commitments').hidden = false; });
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

const openSettings = page => page.evaluate(() => showView('settings'));
const boundaryStore = page => page.evaluate(() => localStorage.getItem('ta3-day-boundary-revisions-v1:uid_pdb-user'));
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
  // There is no separate enable checkbox: the time/timezone editor and the
  // single activation button are both visible from the start.
  await expect(panel(page).locator('[data-pdb-input="enable"]')).toHaveCount(0);
  await expect(panel(page).locator('[data-pdb-input="time"]')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Turn on personal day boundary' })).toBeVisible();

  // Opening Settings (and Today, and the planning surface) wrote nothing.
  expect(await boundaryStore(page)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('ta3-operational-plans-v1:uid_pdb-user'))).toBeNull();
});

test('the enable flow needs no separate checkbox: choosing a time/timezone and pressing the one button is enough', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  // Just typing a start time writes nothing until the explicit save.
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  expect(await boundaryStore(page)).toBeNull();

  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();
  expect(await boundaryStore(page)).not.toBeNull();
});

// ── first enable at 08:00 for 18:00 (spec §7 / §11) ─────────────────────────

test('enabling an 18:00 boundary at 08:00 states when it activates, then activates exactly there', async ({ page }) => {
  await openApp(page);
  await openSettings(page);

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

test('at 08:00 the owner prepares the upcoming 18:00 personal day through the ONE workflow, and it is the current plan after an 18:00 reload', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();
  const stored = await boundaryStore(page);

  await page.evaluate(() => showView('today'));
  // The standalone status surface is gone; the timeline owns visible My Day identity.
  await expect(surface(page)).toBeHidden();
  await expect(page.locator('#timeline-date-label')).toBeVisible();

  // Prepare the upcoming personal day through the ordinary Prepare Tomorrow
  // workflow — the only planning editor in the product.
  await page.evaluate(() => openPlanTomorrow());
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
  // It names the personal-day interval, not a calendar date.
  await expect(page.locator('#plan-tomorrow-date')).toContainText('18:00');
  await expect(page.locator('#plan-tomorrow-date')).toContainText('→');
  // A boundary account is preparing the next personal day, not "tomorrow" —
  // the modal title and confirm action say so, and it states when that
  // personal day actually starts.
  await expect(page.locator('#plan-tomorrow-title')).toHaveText('Plan next personal day');
  await expect(page.locator('#plan-tomorrow-starts')).toContainText('Starts today at 18:00');

  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Night shift block');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Post-midnight review');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  // A post-midnight time a calendar-day plan could not represent is ordinary here.
  await page.locator('[data-pt-action="edit-schedule"]').last().click();
  await page.locator('.pt-time-input').fill('01:00');
  await page.getByRole('button', { name: 'Next personal day is ready' }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);

  // It went into the operational store, keyed by an operationalDayId (never a bare date),
  // with its preparation, and the legacy plans[dateKey] store was not touched.
  const operational = JSON.parse(await page.evaluate(() => localStorage.getItem('ta3-operational-plans-v1:uid_pdb-user')));
  const ids = Object.keys(operational.plans);
  expect(ids).toHaveLength(1);
  expect(ids[0]).toMatch(/^odv1:/);
  expect(operational.plans[ids[0]].preparation.targetOperationalDayId).toBe(ids[0]);
  expect(operational.plans[ids[0]].items.filter(i => !i.deleted).map(i => i.task).sort()).toEqual(['Night shift block', 'Post-midnight review']);
  expect(await page.evaluate(() => localStorage.getItem('ta3-plans:uid_pdb-user'))).toBe('{}');

  // Every prepared-state consumer agrees, right now, at 08:00.
  expect(await page.evaluate(() => {
    const upcoming = window.PlanAuthority.upcoming();
    return {
      prepared: window.PlanAuthority.preparedState(upcoming).prepared,
      consistency: window.PlanAuthority.consistency(upcoming),
      readyNow: window.PlanAuthority.readyNow(upcoming, []),
      streak: window.PlanAuthority.streak().current,
    };
  })).toEqual({ prepared: true, consistency: 'ahead', readyNow: true, streak: 1 });
  // Tomorrow View shows that same prepared plan, not "not prepared yet".
  await page.locator('#tmr-tab-tomorrow').click();
  await expect(page.locator('#tomorrow-view')).toContainText('Night shift block');
  await expect(page.locator('#tomorrow-view')).toContainText('Prepared');
  await page.locator('#tmr-tab-today').click();

  const operationalStore = await page.evaluate(() => localStorage.getItem('ta3-operational-plans-v1:uid_pdb-user'));

  // ── reload at 18:00: the prepared plan is now the CURRENT day's plan strip ──
  await page.addInitScript(({ boundaryStore, operationalStore, now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.setItem('ta3-day-boundary-revisions-v1:uid_pdb-user', boundaryStore);
    localStorage.setItem('ta3-operational-plans-v1:uid_pdb-user', operationalStore);
  }, { boundaryStore: stored, operationalStore, now: Date.parse('2026-09-16T18:00:00+08:00') });
  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');

  await expect(page.locator('#plan-strip')).toContainText('Night shift block');
  await expect(page.locator('#plan-strip')).toContainText('Post-midnight review');
  // Same record, not a copy: still exactly one operational plan id, unchanged.
  expect(Object.keys(JSON.parse(await page.evaluate(() => localStorage.getItem('ta3-operational-plans-v1:uid_pdb-user'))).plans)).toEqual(ids);
  expect(await page.evaluate(() => localStorage.getItem('ta3-plans:uid_pdb-user'))).toBe('{}');
  // The next personal day is a genuinely fresh, empty one.
  expect(await page.evaluate(() => window.PlanAuthority.items(window.PlanAuthority.upcoming()))).toEqual([]);

  // ── 00:30 the following calendar day: midnight must NOT rotate it ──
  await page.addInitScript(({ now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  }, { now: Date.parse('2026-09-17T00:30:00+08:00') });
  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');
  await expect(page.locator('#plan-strip')).toContainText('Night shift block');
  expect(await page.evaluate(() => window.PlanAuthority.current().id)).toBe(ids[0]);

  // ── 18:00 the next day: the next personal day begins ──
  await page.addInitScript(({ now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  }, { now: Date.parse('2026-09-17T18:00:00+08:00') });
  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');
  expect(await page.evaluate(() => window.PlanAuthority.current().id)).not.toBe(ids[0]);
  await expect(page.locator('#plan-strip')).not.toContainText('Night shift block');
});

// ── long-lived session: the real 60s interval rolls listeners over 18:00 ────

test('a page left open across 18:00 re-subscribes to the new current/upcoming days with no reload', async ({ page }) => {
  // 18:00 Manila was enabled the previous day, so both days around D 18:00 are operational.
  const store = JSON.stringify({ schemaVersion: 1, revisions: {
    'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
    'r-1800': { id: 'r-1800', boundaryTime: '18:00', timezone: TZ, effectiveFromInstant: Date.parse('2026-09-15T18:00:00+08:00') },
  } });
  await page.clock.install({ time: Date.parse('2026-09-16T17:58:30+08:00') });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, store }) => {
    if (sessionStorage.getItem('pdb-seeded')) return;
    localStorage.clear();
    sessionStorage.setItem('pdb-seeded', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz:uid_pdb-user', timezone);
    localStorage.setItem('ta3-device-id', 'device-pdb-test');
    localStorage.setItem('ta3-settings:uid_pdb-user', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries:uid_pdb-user', '[]');
    localStorage.setItem('ta3-plans:uid_pdb-user', '{}');
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify({ schemaVersion: 1, timezone, routines: [], manual: {}, links: {}, focus: {}, skips: {} }));
    localStorage.setItem('ta3-day-boundary-revisions-v1:uid_pdb-user', store);
  }, { timezone: TZ, store });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PersonalDayBoundaryLive === 'object');

  const wanted = () => page.evaluate(() => window.PersonalDayBoundaryLive.liveDayIds());
  const attached = () => page.evaluate(() => window.PersonalDayBoundaryLive.attachedDayIds());
  await page.evaluate(() => window.PersonalDayBoundaryLive.attachLiveDays());
  const before = await attached();
  expect(before).toHaveLength(2);

  // Only the app's own setInterval runs from here: no reload, no write, no reconnect.
  await page.clock.runFor('03:00');
  const after = await attached();
  expect(after).toEqual(await wanted());
  expect(after[0]).toBe(before[1]);
  expect(after).not.toContain(before[0]);
});

// ── boundary change through the real UI ─────────────────────────────────────

test('changing 18:00 -> 20:00 at 21:00 states "tomorrow", is reported as Current vs Scheduled, and a repeat of the exact same change never submits a duplicate', async ({ page }) => {
  // Enable first, at 08:00.
  await openApp(page);
  await openSettings(page);
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();
  const stored = await boundaryStore(page);

  // Reopen at 21:00, after 20:00 has already passed today.
  await page.addInitScript(({ boundaryStore, now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.setItem('ta3-day-boundary-revisions-v1:uid_pdb-user', boundaryStore);
  }, { boundaryStore: stored, now: Date.parse('2026-09-16T21:00:00+08:00') });
  await page.reload();
  await page.waitForFunction(() => typeof window.PersonalDayBoundaryLive === 'object');
  await openSettings(page);

  await expect(panel(page)).toContainText('Current:');
  await panel(page).locator('[data-pdb-input="time"]').fill('20:00');
  await expect(panel(page)).toContainText('20:00 tomorrow');

  await panel(page).getByRole('button', { name: 'Save personal day start' }).click();

  // History is append-only: the 18:00 revision survives alongside the new one.
  const after = Object.values(JSON.parse(await boundaryStore(page)).revisions);
  expect(after).toHaveLength(3);
  expect(after.map(r => r.boundaryTime).sort()).toEqual(['00:00', '18:00', '20:00']);
  // And the change is shown as Current vs Scheduled, not as already active.
  await expect(panel(page)).toContainText('Scheduled:');
  await expect(panel(page)).toContainText('20:00 tomorrow');

  // Proposing the EXACT same pending change again must not resubmit it, and
  // must never surface the model's raw uniqueness rejection: the Save button
  // is disabled before a click can even reach that path.
  await panel(page).locator('[data-pdb-input="time"]').fill('20:00');
  await expect(panel(page)).toContainText('Change scheduled');
  await expect(panel(page).getByRole('button', { name: 'Save personal day start' })).toBeDisabled();
  await expect(panel(page)).not.toContainText('effective instants must be unique');
  expect(Object.values(JSON.parse(await boundaryStore(page)).revisions)).toHaveLength(3);

  // A genuinely different pending value is still freely savable.
  await panel(page).locator('[data-pdb-input="time"]').fill('21:00');
  await expect(panel(page).getByRole('button', { name: 'Save personal day start' })).toBeEnabled();
  await panel(page).getByRole('button', { name: 'Save personal day start' }).click();
  const final = Object.values(JSON.parse(await boundaryStore(page)).revisions);
  expect(final).toHaveLength(4);
  expect(final.map(r => r.boundaryTime).sort()).toEqual(['00:00', '18:00', '20:00', '21:00']);
});

// ── Plan Tomorrow terminology (Personal Day UX V1.1) ────────────────────────

test('a legacy account keeps "Plan tomorrow" wording everywhere', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => toggleHdrMenu());
  await expect(page.locator('#hdr-menu-plan-tomorrow')).toHaveText('Browse future My Days');
  await page.evaluate(() => openPlanTomorrow());
  await expect(page.locator('#plan-tomorrow-title')).toHaveText('Plan tomorrow');
  await expect(page.locator('#plan-tomorrow-starts')).toBeEmpty();
  await expect(page.getByRole('button', { name: 'Tomorrow is ready' })).toBeVisible();
});

test('a custom-boundary account sees "Plan next personal day" wording in the hamburger menu and the modal', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();

  await page.evaluate(() => showView('today'));
  await page.evaluate(() => toggleHdrMenu());
  await expect(page.locator('#hdr-menu-plan-tomorrow')).toHaveText('Browse future My Days');

  await page.evaluate(() => openPlanTomorrow());
  await expect(page.locator('#plan-tomorrow-title')).toHaveText('Plan next personal day');
  await expect(page.getByRole('button', { name: 'Next personal day is ready' })).toBeVisible();
});

// ── "Starts today/tomorrow at HH:MM" (Personal Day UX V1.1) ────────────────

test('at 06:00 with an 18:00 boundary, the action already reads Plan next personal day and the next personal day is reported as starting today', async ({ page }) => {
  await openApp(page, { now: Date.parse('2026-09-15T22:00:00Z') }); // 06:00 Asia/Manila 2026-09-16
  await openSettings(page);
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();

  await page.evaluate(() => openPlanTomorrow());
  // The revision exists but has not taken effect yet (18:00 has not happened
  // today) — the action still reads "next personal day" immediately, never
  // gated on the currently governing revision being custom.
  await expect(page.locator('#plan-tomorrow-title')).toHaveText('Plan next personal day');
  await expect(page.locator('#plan-tomorrow-starts')).toHaveText('Starts today at 18:00');
  await page.locator('[data-pt-action="close"]').first().click();

  await page.evaluate(() => showView('today'));
  await expect(page.locator('#today-prepare-tomorrow')).toHaveCount(0);
  await page.evaluate(() => toggleHdrMenu());
  await expect(page.locator('#hdr-menu-plan-tomorrow')).toHaveText('Browse future My Days');
  await page.evaluate(() => toggleHdrMenu());
  await page.locator('#tmr-tab-tomorrow').click();
  await expect(page.locator('.tmr-starts')).toHaveText('Starts today at 18:00');
});

test('after 18:00, the next personal day is reported as starting tomorrow', async ({ page }) => {
  await openApp(page, { now: Date.parse('2026-09-16T00:00:00Z') }); // 08:00 Asia/Manila 2026-09-16
  await openSettings(page);
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();
  const stored = await boundaryStore(page);

  // Reopen at 19:00 Asia/Manila 2026-09-16, after today's 18:00 boundary has passed.
  await page.addInitScript(({ boundaryStore, now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.setItem('ta3-day-boundary-revisions-v1:uid_pdb-user', boundaryStore);
  }, { boundaryStore: stored, now: Date.parse('2026-09-16T19:00:00+08:00') });
  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');

  await page.evaluate(() => openPlanTomorrow());
  await expect(page.locator('#plan-tomorrow-starts')).toHaveText('Starts tomorrow at 18:00');
});

// ── FIX FIRST correction: remaining Tomorrow surfaces (Personal Day UX V1.1) ─

async function markTomorrowOpenDay(page) {
  await page.evaluate(() => openPlanTomorrow());
  await page.getByRole('button', { name: 'Rescue / minimum' }).click();
  await page.locator('#plan-tomorrow-overlay').getByRole('button', { name: 'Open day / no commitments' }).click();
  await page.getByRole('button', { name: 'Use this plan' }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
}

test('a legacy account keeps "Tomorrow" wording on the tab, the Today quick action, the review-flow action, and the open-day/prepared footers', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => showView('today'));
  await expect(page.locator('#tmr-tab-tomorrow')).toHaveText('Tomorrow');
  await expect(page.locator('#today-prepare-tomorrow')).toHaveCount(0);

  await page.evaluate(() => openReview());
  await expect(page.locator('#rv-tomorrow-status')).toContainText('Prepare tomorrow →');
  await page.evaluate(() => closeModal('review-overlay'));

  await markTomorrowOpenDay(page);
  await page.locator('#tmr-tab-tomorrow').click();
  await expect(page.locator('.tmr-open-day')).toHaveText('Tomorrow is an Open Day.');
  await expect(page.locator('[data-tmr-action="open"]')).toHaveText('Edit tomorrow');
});

test('a custom-boundary account reads "next personal day" on the tab, the Today quick action, the review-flow action, and the open-day/prepared footers', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();
  await page.evaluate(() => showView('today'));

  await expect(page.locator('#tmr-tab-tomorrow')).toHaveText('Next personal day');
  await expect(page.locator('#today-prepare-tomorrow')).toHaveCount(0);

  await page.evaluate(() => openReview());
  await expect(page.locator('#rv-tomorrow-status')).toContainText('Prepare next personal day →');
  await page.evaluate(() => closeModal('review-overlay'));

  await markTomorrowOpenDay(page);
  await page.locator('#tmr-tab-tomorrow').click();
  await expect(page.locator('.tmr-open-day')).toHaveText('Next personal day is an Open Day.');
  await expect(page.locator('[data-tmr-action="open"]')).toHaveText('Edit next personal day');

  // Prepared (non-open-day) footer also reads "Edit next personal day".
  await page.locator('[data-tmr-action="open"]').click();
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
  await page.getByRole('button', { name: 'Rescue / minimum' }).click();
  await page.locator('#plan-tomorrow-rescue-add input[name="task"]').fill('Night shift priority');
  await page.locator('#plan-tomorrow-rescue-add').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Use this plan' }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  await page.locator('#tmr-tab-tomorrow').click();
  await expect(page.locator('[data-tmr-action="open"]')).toHaveText('Edit next personal day');
});

// ── optional: same clock time, different timezone is NOT the same pending proposal ──

test('a same-clock-time proposal in a DIFFERENT timezone is never classified as the identical pending change', async ({ page }) => {
  // Enable 18:00 Manila at 08:00, then reload at 21:00 (after 20:00 has passed
  // today) and propose 20:00 Manila — exactly the earlier duplicate-guard
  // scenario, so there is a REAL pending revision (20:00 Asia/Manila,
  // effective tomorrow) to test the timezone-sensitivity of the guard against.
  await openApp(page);
  await openSettings(page);
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();
  const stored = await boundaryStore(page);

  await page.addInitScript(({ boundaryStore, now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.setItem('ta3-day-boundary-revisions-v1:uid_pdb-user', boundaryStore);
  }, { boundaryStore: stored, now: Date.parse('2026-09-16T21:00:00+08:00') });
  await page.reload();
  await page.waitForFunction(() => typeof window.PersonalDayBoundaryLive === 'object');
  await openSettings(page);

  await panel(page).locator('[data-pdb-input="time"]').fill('20:00');
  await panel(page).getByRole('button', { name: 'Save personal day start' }).click();
  await expect(panel(page)).toContainText('Scheduled:'); // a real 20:00 Asia/Manila pending revision now exists

  // Same 20:00 CLOCK READING, but a different timezone — must be treated as a
  // genuinely different proposal, never "already scheduled".
  await panel(page).locator('[data-pdb-input="time"]').fill('20:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption('America/New_York');
  await expect(panel(page)).not.toContainText('Change scheduled');
  await expect(panel(page).getByRole('button', { name: 'Save personal day start' })).toBeEnabled();
});

// ── Partner View terminology (provenance-neutral correction) ────────────────
//
// The shared wire payload (shared-accountability-model.js / partner-view-model.js)
// carries no publisher boundary flag — adding one would be a Partner View
// data-selection/allowlist change, explicitly out of scope. The PRIOR "final
// correction" read this device's own personalDayBoundaryConfigured() as a
// stand-in for the publisher's configuration, which is wrong whenever the two
// differ (publisher custom / viewer legacy, or publisher legacy / viewer
// custom — either way the label described this device, not the data actually
// being shown). Partner View's publisher-upcoming-plan label is now the fixed,
// provenance-neutral "Upcoming plan" — it never branches on
// personalDayBoundaryConfigured(), viewer boundary status, viewer
// target.store, or any other local/viewer signal, so it cannot mislabel the
// publisher's plan regardless of either party's configuration.

async function seedAndOpenPartnerView(page, { todayDateKey, timezone }) {
  await page.evaluate(() => localStorage.setItem('ta3-partner-uid', 'partner-1'));
  await page.evaluate(({ todayDateKey, timezone }) => {
    partnerShared = {
      schemaVersion: 1,
      publisher: { timezone, dateKey: todayDateKey, updatedAt: Date.now(), displayName: 'Partner' },
      today: { dateKey: todayDateKey, priorities: [] },
      tomorrow: { dateKey: todayDateKey, prepStatus: 'not-prepared' }
    };
    partnerViewShared = {
      today: { dateKey: todayDateKey, priorities: [], soFar: { deepMin: 0, wasteMin: 0 }, timeline: [] },
      tomorrow: { dateKey: todayDateKey, priorities: [] }
    };
    renderPartnerCard();
    openPartnerView();
  }, { todayDateKey, timezone });
}

test('a legacy-viewer device reads the neutral "Upcoming plan" label for a representative Partner payload', async ({ page }) => {
  await openApp(page);
  await seedAndOpenPartnerView(page, { todayDateKey: '2026-09-16', timezone: TZ });
  await expect(page.locator('#partner-card')).toContainText('Partner · Not planned');
  await expect(page.locator('#partner-card')).not.toContainText('Tomorrow:');
  await expect(page.locator('#partner-card')).not.toContainText('Next personal day');
  const screenText = await page.locator('#partner-view-screen').textContent();
  expect(screenText).toContain('Upcoming plan');
  expect(screenText).toContain('No upcoming plan yet');
  expect(screenText).not.toContain('No plan for tomorrow yet');
  expect(screenText).not.toContain('Next personal day');
});

test('a custom-boundary-viewer device reads the EXACT SAME neutral "Upcoming plan" label for the SAME representative Partner payload — viewer configuration cannot change how publisher data is described', async ({ page }) => {
  await openApp(page, { now: Date.parse('2026-09-15T22:00:00Z') }); // 06:00 Asia/Manila 2026-09-16
  await openSettings(page);
  await panel(page).locator('[data-pdb-input="time"]').fill('18:00');
  await panel(page).locator('[data-pdb-input="timezone"]').selectOption(TZ);
  await panel(page).getByRole('button', { name: 'Turn on personal day boundary' }).click();
  await page.evaluate(() => showView('today'));

  // Same seeded payload, same dateKey/timezone, as the legacy-viewer case above —
  // only this device's own boundary configuration differs.
  await seedAndOpenPartnerView(page, { todayDateKey: '2026-09-16', timezone: TZ });
  await expect(page.locator('#partner-card')).toContainText('Partner · Not planned');
  await expect(page.locator('#partner-card')).not.toContainText('Tomorrow:');
  await expect(page.locator('#partner-card')).not.toContainText('Next personal day');
  const screenText = await page.locator('#partner-view-screen').textContent();
  expect(screenText).toContain('Upcoming plan');
  expect(screenText).toContain('No upcoming plan yet');
  expect(screenText).not.toContain('No plan for tomorrow yet');
  expect(screenText).not.toContain('Next personal day');

  // The OWNER's own single-device surfaces are unaffected by this fix and
  // still correctly reflect this device's own custom boundary.
  await expect(page.locator('#tmr-tab-tomorrow')).toHaveText('Next personal day');
  await expect(page.locator('#today-prepare-tomorrow')).toHaveCount(0);
});
