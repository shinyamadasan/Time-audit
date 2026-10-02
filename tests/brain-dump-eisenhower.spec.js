// Brain Dump + Eisenhower V1 — browser coverage for the new "Brain Dump" view
// (capture, triage, Do Today / Schedule / Archive / Delegate), which node --test
// cannot exercise because it renders DOM. Mirrors
// tests/calendar-day-extended-my-day.spec.js's Firebase stub and app-boot harness.
//
// No real Firebase, no network. Local persistence is the real localStorage of the
// page. The default account here never enables a Personal Day boundary or
// calendar-native activation, so Plan Authority routes through the LEGACY plan
// store — the same store every other never-activated account already uses, and
// the one Plan Authority abstracts away identically to the calendar store for
// everything this phase's promotion code calls.

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
const UID = 'bdemd-user';
const ROOM = `uid_${UID}`;
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);

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
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: '${UID}', displayName: 'BDEMD User', email: 'bdemd@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
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

async function openApp(page, { now } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now }) => {
    const frozen = Number(localStorage.getItem('bdemd-now')) || now;
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [frozen])); } static now() { return frozen; } };
    if (localStorage.getItem('bdemd-seeded') === '1') return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('bdemd-seeded', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz:uid_bdemd-user', timezone);
    localStorage.setItem('ta3-device-id', 'device-bdemd');
    localStorage.setItem('ta3-settings:uid_bdemd-user', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries:uid_bdemd-user', '[]');
    localStorage.setItem('ta3-plans:uid_bdemd-user', '{}'); localStorage.setItem('ta3-reviews', '{}'); localStorage.setItem('ta3-focus-redemptions', '[]');
  }, { timezone: TZ, now });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object' && typeof window.BrainDumpUI === 'object');
  await expect(page.locator('#signin-overlay')).toBeHidden();
  await page.evaluate(() => showView('braindump'));
}

function brainDumpStorage(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('ta3-brain-dump-v1:uid_bdemd-user') || '{"captures":{}}').captures);
}

const root = page => page.locator('#bd-root');

// ═══════════════════════════════════════════════════════════════════════
// capture
// ═══════════════════════════════════════════════════════════════════════

test('capturing a thought needs only text and Add — it appears under "To triage" immediately', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  await page.locator('#bd-capture-text').fill('Call the vet');
  await page.locator('#bd-capture-form button[type=submit]').click();
  await expect(root(page)).toContainText('Call the vet');
  await expect(root(page)).toContainText('To triage (1)');
});

test('several rapid captures without triaging each one immediately: the input stays focused for the next capture', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const input = page.locator('#bd-capture-text');
  for (const text of ['Capture A', 'Capture B', 'Capture C']) {
    await input.fill(text);
    await page.locator('#bd-capture-form button[type=submit]').click();
    await expect(input).toBeFocused();
  }
  await expect(root(page)).toContainText('To triage (3)');
  const captures = await brainDumpStorage(page);
  expect(Object.keys(captures).length).toBe(3);
});

test('identical text captured twice still produces two distinct, independently triageable items', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const input = page.locator('#bd-capture-text');
  await input.fill('Buy milk'); await page.locator('#bd-capture-form button[type=submit]').click();
  await input.fill('Buy milk'); await page.locator('#bd-capture-form button[type=submit]').click();
  const captures = await brainDumpStorage(page);
  const ids = Object.keys(captures);
  expect(ids.length).toBe(2);
  expect(ids[0]).not.toBe(ids[1]);
});

test('a capture survives reload', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  await page.locator('#bd-capture-text').fill('Persisted thought');
  await page.locator('#bd-capture-form button[type=submit]').click();
  await page.reload();
  await page.waitForFunction(() => typeof window.BrainDumpUI === 'object');
  await page.evaluate(() => showView('braindump'));
  await expect(root(page)).toContainText('Persisted thought');
});

// ═══════════════════════════════════════════════════════════════════════
// triage
// ═══════════════════════════════════════════════════════════════════════

async function captureOne(page, text) {
  await page.locator('#bd-capture-text').fill(text);
  await page.locator('#bd-capture-form button[type=submit]').click();
  const captures = await brainDumpStorage(page);
  return Object.values(captures).find(c => c.text === text).id;
}

async function triage(page, id, important, urgent) {
  await page.locator(`button[onclick="window.BrainDumpUI.setTriageAnswer('${id}','important',${important})"]`).click();
  await page.locator(`button[onclick="window.BrainDumpUI.setTriageAnswer('${id}','urgent',${urgent})"]`).click();
  await page.locator(`button[onclick="window.BrainDumpUI.saveTriage('${id}')"]`).click();
}

test('all four Eisenhower combinations classify and label correctly in the UI', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const cases = [
    ['Do first item', true, true, 'Do first'],
    ['Schedule item', true, false, 'Schedule —'],
    ['Delegate item', false, true, 'Delegate candidate'],
    ['Archive item', false, false, 'Archive candidate'],
  ];
  for (const [text, important, urgent, label] of cases) {
    const id = await captureOne(page, text);
    await triage(page, id, important, urgent);
    await expect(root(page)).toContainText(label);
  }
  await expect(root(page)).toContainText('Triaged (4)');
});

test('triage survives reload', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Reload me');
  await triage(page, id, true, true);
  await page.reload();
  await page.waitForFunction(() => typeof window.BrainDumpUI === 'object');
  await page.evaluate(() => showView('braindump'));
  const captures = await brainDumpStorage(page);
  expect(captures[id].status).toBe('triaged');
  expect(captures[id].important).toBe(true);
  expect(captures[id].urgent).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════
// Do Today — promotes through Plan Authority, lands on My Day
// ═══════════════════════════════════════════════════════════════════════

test('Do Today promotes into the real plan via Plan Authority, and the item leaves the Triaged list', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Ship the brain dump feature');
  await triage(page, id, true, true);
  await page.locator(`button[onclick="window.BrainDumpUI.doToday('${id}')"]`).click();
  await expect(root(page)).toContainText('Done today');

  const captures = await brainDumpStorage(page);
  expect(captures[id].status).toBe('promoted');
  expect(captures[id].promotion.type).toBe('do-today');

  await page.evaluate(() => showView('today'));
  await expect(page.locator('#plan-strip')).toContainText('Ship the brain dump feature');
});

test('retrying Do Today on an already-promoted capture never creates a second plan item', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Only once please');
  await triage(page, id, true, true);
  await page.locator(`button[onclick="window.BrainDumpUI.doToday('${id}')"]`).click();
  // The button for a promoted item no longer renders (it left the Triaged
  // section) — call the handler directly to simulate a stale retry (e.g. a
  // double-tap that landed after the first render already resolved).
  await page.evaluate(id => window.BrainDumpUI.doToday(id), id);
  const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-plans:uid_bdemd-user')));
  const today = Object.values(plans)[0];
  const matching = today.items.filter(item => item.task === 'Only once please');
  expect(matching.length).toBe(1);
});

// ═══════════════════════════════════════════════════════════════════════
// Schedule — optional date/time/duration, no time required
// ═══════════════════════════════════════════════════════════════════════

test('Schedule with only a date (no time) promotes an untimed item onto that date\'s plan', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Renew passport');
  await triage(page, id, true, false);
  await page.locator(`button[onclick="window.BrainDumpUI.toggleSchedule('${id}')"]`).click();
  await page.locator(`#bd-sched-date-${id}`).fill('2026-10-10');
  await page.locator(`button[onclick="window.BrainDumpUI.confirmSchedule('${id}')"]`).click();
  await expect(root(page)).toContainText('Scheduled');

  const captures = await brainDumpStorage(page);
  expect(captures[id].status).toBe('promoted');
  expect(captures[id].promotion.type).toBe('schedule');
  const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-plans:uid_bdemd-user')));
  const scheduledDay = plans['2026-10-10'];
  expect(scheduledDay.items.some(item => item.task === 'Renew passport' && item.when === '')).toBe(true);
});

test('Schedule with a time and duration carries both onto the plan item', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Dentist follow-up');
  await triage(page, id, true, false);
  await page.locator(`button[onclick="window.BrainDumpUI.toggleSchedule('${id}')"]`).click();
  await page.locator(`#bd-sched-date-${id}`).fill('2026-10-12');
  await page.locator(`#bd-sched-time-${id}`).fill('14:30');
  await page.locator(`#bd-sched-duration-${id}`).fill('45');
  await page.locator(`button[onclick="window.BrainDumpUI.confirmSchedule('${id}')"]`).click();

  const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-plans:uid_bdemd-user')));
  const item = plans['2026-10-12'].items.find(i => i.task === 'Dentist follow-up');
  expect(item.when).toBe('14:30');
  expect(item.durationMinutes).toBe(45);
});

test('a capture already promoted cannot be scheduled a second time', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Already promoted');
  await triage(page, id, true, true);
  await page.locator(`button[onclick="window.BrainDumpUI.doToday('${id}')"]`).click();
  await page.evaluate(id => window.BrainDumpUI.confirmSchedule(id), id); // stale retry, no date field exists anymore
  const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-plans:uid_bdemd-user')));
  const allItems = Object.values(plans).flatMap(day => day.items || []);
  expect(allItems.filter(item => item.task === 'Already promoted').length).toBe(1);
});

// ═══════════════════════════════════════════════════════════════════════
// Archive
// ═══════════════════════════════════════════════════════════════════════

test('Archive moves the item to "Recently handled" without creating a plan item, and this is distinguishable from deletion', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Drop this one');
  await triage(page, id, false, false);
  await page.locator(`button[onclick="window.BrainDumpUI.archive('${id}')"]`).click();
  await expect(root(page)).toContainText('Recently handled');
  await expect(root(page)).toContainText('Archived');

  const captures = await brainDumpStorage(page);
  expect(captures[id].status).toBe('archived'); // present and labeled, not missing — never a silent delete
  const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-plans:uid_bdemd-user')));
  const allItems = Object.values(plans).flatMap(day => day.items || []);
  expect(allItems.some(item => item.task === 'Drop this one')).toBe(false);
});

test('archive survives reload', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Archived, then reloaded');
  await triage(page, id, false, false);
  await page.locator(`button[onclick="window.BrainDumpUI.archive('${id}')"]`).click();
  await page.reload();
  await page.waitForFunction(() => typeof window.BrainDumpUI === 'object');
  await page.evaluate(() => showView('braindump'));
  const captures = await brainDumpStorage(page);
  expect(captures[id].status).toBe('archived');
});

// ═══════════════════════════════════════════════════════════════════════
// Delegate — minimal disposition, no new task store (V1 scope decision)
// ═══════════════════════════════════════════════════════════════════════

test('Delegate records an optional free-text note as a terminal disposition, nothing more', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Hand this off');
  await triage(page, id, false, true);
  page.once('dialog', dialog => dialog.accept('Alex'));
  await page.locator(`button[onclick="window.BrainDumpUI.delegate('${id}')"]`).click();
  await expect(root(page)).toContainText('Delegated — Alex');

  const captures = await brainDumpStorage(page);
  expect(captures[id].status).toBe('delegated');
  expect(captures[id].delegatedTo).toBe('Alex');
});

// ═══════════════════════════════════════════════════════════════════════
// regression: existing Daily Plan surfaces are unaffected by Brain Dump
// ═══════════════════════════════════════════════════════════════════════

test('navigating to Brain Dump and back does not disturb My Day\'s own plan rendering', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  await page.evaluate(() => showView('today'));
  await expect(page.locator('#view-today')).toHaveClass(/active/);
  await page.evaluate(() => showView('braindump'));
  await expect(page.locator('#view-braindump')).toHaveClass(/active/);
  await page.evaluate(() => showView('today'));
  await expect(page.locator('#view-today')).toHaveClass(/active/);
  await expect(page.locator('#signin-overlay')).toBeHidden();
});
