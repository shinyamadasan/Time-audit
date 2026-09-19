// Planning Continuity V1 — My Day timeline, in a real browser.
//
// Reproduces the owner's screenshot. Asia/Manila, 18:00 boundary. The current My Day is
// Fri Sep 18 18:00 → Sat Sep 19 18:00, but Today's timeline used to show the CALENDAR
// date Sat Sep 19 00:00 → 24:00: it dropped Friday evening's schedule and showed
// Saturday evening's (which belongs to the next My Day).
//
// Everything here is observed through the real app: settings.templates (recurring
// schedule blocks) and real entries, a frozen clock, the stubbed Firebase used by the
// other specs. Timestamps in storage are ordinary Manila instants throughout.

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
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);

const boundaryStore = boundaryTime => JSON.stringify({ schemaVersion: 1, revisions: {
  'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
  [`r-${boundaryTime.replace(':', '')}`]: { id: `r-${boundaryTime.replace(':', '')}`, boundaryTime, timezone: TZ, effectiveFromInstant: at('2026-09-01', boundaryTime) },
} });

// Sep 18 2026 is a Friday (5), Sep 19 a Saturday (6). Friday-only blocks sit in the
// Friday evening half of the current My Day; the Saturday 20:00 block belongs to the
// NEXT My Day. Daily blocks cover the overnight / morning half.
const tpl = (id, activity, days, startTime, endTime) => ({ id, activity, energy: 'recovery', days, startTime, endTime, enabled: true, autoLog: false, skipDates: [] });
const TEMPLATES = [
  tpl('fri-dinner', 'Friday dinner', [5], '18:00', '19:00'),
  tpl('fri-reading', 'Friday reading', [5], '22:00', '23:00'),
  tpl('fri-winddown', 'Friday wind down', [5], '23:00', '23:30'),
  tpl('sat-early', 'Saturday early shift', [6], '04:00', '05:00'),
  tpl('sat-breakfast', 'Saturday breakfast', [6], '08:30', '09:00'),
  tpl('sat-work', 'Saturday work block', [6], '09:00', '12:00'),
  tpl('sat-party', 'Saturday party', [6], '20:00', '22:00'),
  tpl('fri-early', 'Friday early errand', [5], '17:00', '17:30'),
];

const entry = (id, activity, startIso, endIso) => {
  const tsStart = Date.parse(startIso);
  const ts = Date.parse(endIso);
  return { id, activity, energy: 'deep', tsStart, ts, blockIntervalMin: Math.round((ts - tsStart) / 60000), date: startIso.slice(0, 10) };
};
const ENTRIES = [
  entry('e-fri-study', 'Friday evening study', '2026-09-18T20:00:00+08:00', '2026-09-18T21:00:00+08:00'),
  entry('e-sat-midnight', 'Midnight notes', '2026-09-19T00:00:00+08:00', '2026-09-19T00:45:00+08:00'),
  entry('e-sat-deep', 'Saturday deep work', '2026-09-19T13:00:00+08:00', '2026-09-19T14:44:00+08:00'),
];

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
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'myday-user', displayName: 'My Day', email: 'md@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
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

/** Opens the app at a frozen instant. The instant can be changed between reloads with
 *  setClock(), which is how the rollover tests move time forward on ONE device. */
async function openApp(page, { now, boundary = '18:00' }) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, boundary, templates, entries }) => {
    const frozen = Number(localStorage.getItem('myday-now')) || now;
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [frozen])); } static now() { return frozen; } };
    if (localStorage.getItem('myday-seeded') === '1') return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('myday-seeded', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', timezone);
    localStorage.setItem('ta3-device-id', 'device-myday');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates }));
    localStorage.setItem('ta3-entries', JSON.stringify(entries));
    localStorage.setItem('ta3-plans', '{}'); localStorage.setItem('ta3-reviews', '{}'); localStorage.setItem('ta3-focus-redemptions', '[]');
    if (boundary) localStorage.setItem('ta3-day-boundary-revisions-v1', boundary);
  }, { timezone: TZ, now, boundary: boundary ? boundaryStore(boundary) : null, templates: TEMPLATES, entries: ENTRIES });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function setClock(page, ms) {
  await page.evaluate(v => localStorage.setItem('myday-now', String(v)), ms);
  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');
}

const timeline = page => page.locator('#timeline-blocks');

// ═══════════════════════════════════════════════════════════════════════
// the owner's screenshot scenario
// ═══════════════════════════════════════════════════════════════════════

test('Sat 14:44, 18:00 boundary: the timeline is Fri 18:00 → Sat 18:00, not the calendar Saturday', async ({ page }) => {
  await openApp(page, { now: at('2026-09-19', '14:44') });

  await expect(page.locator('#timeline-date-label')).toHaveText('My Day · Fri Sep 18, 6:00 PM → Sat Sep 19, 6:00 PM');

  // Previous-evening schedule and entries are now visible…
  for (const label of ['Friday dinner', 'Friday evening study', 'Friday reading', 'Friday wind down']) {
    await expect(timeline(page)).toContainText(label);
  }
  // …as are the overnight / morning / afternoon parts…
  for (const label of ['Midnight notes', 'Saturday early shift', 'Saturday breakfast', 'Saturday work block', 'Saturday deep work']) {
    await expect(timeline(page)).toContainText(label);
  }
  // …while Saturday 18:00-and-later belongs to the NEXT My Day, and Friday before
  // 18:00 belongs to the previous one.
  await expect(timeline(page)).not.toContainText('Saturday party');
  await expect(timeline(page)).not.toContainText('Friday early errand');

  // Rows are in real chronological order across the midnight line.
  const text = await timeline(page).innerText();
  const order = ['Friday dinner', 'Friday evening study', 'Friday reading', 'Friday wind down', 'Midnight notes', 'Saturday early shift', 'Saturday breakfast', 'Saturday work block', 'Saturday deep work'];
  const positions = order.map(label => text.indexOf(label));
  expect(positions.every(p => p >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);

  // The timeline header is now the one visible owner of the interval; the old
  // standalone My Day summary stays absent.
  await expect(page.locator('#operational-plan-section')).toBeHidden();
});

test('the stored timestamps are untouched — only grouping changed', async ({ page }) => {
  await openApp(page, { now: at('2026-09-19', '14:44') });
  // Compared by id: the app keeps its own storage order (newest first).
  const byId = rows => [...rows].sort((a, b) => a[0].localeCompare(b[0]));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-entries')).map(e => [e.id, e.tsStart, e.ts]));
  expect(byId(stored)).toEqual(byId(ENTRIES.map(e => [e.id, e.tsStart, e.ts])));
});

test('at 18:00 the timeline rolls to the next My Day, which shows Saturday evening', async ({ page }) => {
  await openApp(page, { now: at('2026-09-19', '18:00') });
  await expect(page.locator('#timeline-date-label')).toHaveText('My Day · Sat Sep 19, 6:00 PM → Sun Sep 20, 6:00 PM');
  await expect(timeline(page)).toContainText('Saturday party');
  for (const label of ['Friday dinner', 'Friday evening study', 'Saturday deep work', 'Saturday breakfast']) {
    await expect(timeline(page)).not.toContainText(label);
  }
});

test('midnight does not roll the My Day timeline', async ({ page }) => {
  await openApp(page, { now: at('2026-09-19', '00:30') });
  await expect(page.locator('#timeline-date-label')).toHaveText('My Day · Fri Sep 18, 6:00 PM → Sat Sep 19, 6:00 PM');
  await expect(timeline(page)).toContainText('Friday dinner');
  await expect(timeline(page)).toContainText('Friday evening study');
  await expect(timeline(page)).toContainText('Midnight notes');
});

test('timeline arrows move one authoritative My Day and return without changing the clock', async ({ page }) => {
  await openApp(page, { now: at('2026-09-19', '14:44') });
  const label = page.locator('#timeline-date-label');
  const original = await label.textContent();
  await page.getByRole('button', { name: 'Next My Day' }).click();
  await expect(label).toHaveText('My Day · Sat Sep 19, 6:00 PM → Sun Sep 20, 6:00 PM');
  await page.getByRole('button', { name: 'Previous My Day' }).click();
  await expect(label).toHaveText(original);
});

test('an in-session 18:00 rollover rebuilds the timeline without a calendar-date change', async ({ page }) => {
  await openApp(page, { now: at('2026-09-19', '17:59') });
  await expect(timeline(page)).toContainText('Friday dinner');
  // Move the frozen clock past 18:00 WITHOUT reloading, then fire the app's own
  // rollover watcher (the 60s tick calls it in production).
  await page.evaluate(ms => {
    const RealDate = Object.getPrototypeOf(window.Date);
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [ms])); } static now() { return ms; } };
    refreshOnPersonalDayRollover();
  }, at('2026-09-19', '18:01'));
  await expect(page.locator('#timeline-date-label')).toHaveText('My Day · Sat Sep 19, 6:00 PM → Sun Sep 20, 6:00 PM');
  await expect(timeline(page)).toContainText('Saturday party');
  await expect(timeline(page)).not.toContainText('Friday dinner');
});

// ═══════════════════════════════════════════════════════════════════════
// other boundaries, legacy, and history
// ═══════════════════════════════════════════════════════════════════════

test('a 17:00 boundary uses its own interval', async ({ page }) => {
  await openApp(page, { now: at('2026-09-19', '14:44'), boundary: '17:00' });
  await expect(page.locator('#timeline-date-label')).toHaveText('My Day · Fri Sep 18, 5:00 PM → Sat Sep 19, 5:00 PM');
  await expect(timeline(page)).toContainText('Friday early errand'); // Fri 17:00 is now inside
  await expect(timeline(page)).toContainText('Friday dinner');
  await expect(timeline(page)).not.toContainText('Saturday party');
});

test('custom 00:00 shows the calendar Saturday, labelled as My Day', async ({ page }) => {
  await openApp(page, { now: at('2026-09-19', '14:44'), boundary: '00:00' });
  await expect(page.locator('#timeline-date-label')).toHaveText('My Day · Sat Sep 19, 12:00 AM → Sun Sep 20, 12:00 AM');
  await expect(timeline(page)).not.toContainText('Friday dinner');
  await expect(timeline(page)).toContainText('Saturday breakfast');
  await expect(timeline(page)).toContainText('Saturday party');
  expect(await page.evaluate(() => window.PlanAuthority.current().store)).toBe('operational');
});

test('a legacy account keeps its calendar-day timeline and label exactly', async ({ page }) => {
  await openApp(page, { now: at('2026-09-19', '14:44'), boundary: null });
  await expect(page.locator('#timeline-date-label')).toHaveText("Today's timeline");
  await expect(timeline(page)).not.toContainText('Friday dinner');
  await expect(timeline(page)).not.toContainText('Friday evening study');
  await expect(timeline(page)).toContainText('Saturday breakfast');
  await expect(timeline(page)).toContainText('Saturday party');
  expect(await page.evaluate(() => window.PlanAuthority.current().store)).toBe('legacy');
});

test('browsing a past date keeps the factual calendar timeline', async ({ page }) => {
  await openApp(page, { now: at('2026-09-19', '14:44') });
  await page.evaluate(() => setViewDate('2026-09-18'));
  await expect(page.locator('#timeline-date-label')).toHaveText("Yesterday's timeline");
  await expect(timeline(page)).toContainText('Friday evening study');
  await expect(timeline(page)).toContainText('Friday early errand'); // calendar Friday includes 17:00
  await expect(timeline(page)).not.toContainText('Saturday deep work');
});

// ═══════════════════════════════════════════════════════════════════════
// Planning Streak / readiness across the clock, on one device
// ═══════════════════════════════════════════════════════════════════════

test('streak and readiness follow My Day across 17:59, 18:00, 23:59, 00:00 and 05:00', async ({ page }) => {
  await openApp(page, { now: at('2026-09-18', '17:59') });
  const before = await page.evaluate(() => window.PlanAuthority.current().id);

  await setClock(page, at('2026-09-18', '18:00'));
  const myDay = await page.evaluate(() => window.PlanAuthority.current().id);
  expect(myDay).not.toBe(before);
  // Prepare the NEXT My Day now, ahead of time.
  const nextId = await page.evaluate(() => {
    const next = window.PlanAuthority.upcoming();
    window.PlanAuthority.confirmPreparation(next, {
      items: [{ id: 'pnext', task: 'Next My Day priority', when: '', done: false, doneAt: null, updatedAt: Date.now(), updatedBy: 'device-myday' }],
      mode: 'normal', intentionalBlank: false, routineInstanceIds: [],
    });
    return next.id;
  });

  for (const [date, hhmm] of [['2026-09-18', '23:59'], ['2026-09-19', '00:00'], ['2026-09-19', '05:00']]) {
    await setClock(page, at(date, hhmm));
    const state = await page.evaluate(() => ({
      current: window.PlanAuthority.current().id,
      upcoming: window.PlanAuthority.upcoming().id,
      streak: window.PlanAuthority.streak(),
      ready: window.PlanAuthority.readyNow(window.PlanAuthority.upcoming()),
    }));
    expect(state.current, `${date} ${hhmm}`).toBe(myDay);
    expect(state.upcoming, `${date} ${hhmm}`).toBe(nextId);
    expect(state.streak.todayEarned, `${date} ${hhmm}: midnight must not reset habit credit`).toBe(true);
    expect(state.ready, `${date} ${hhmm}`).toBe(true);
  }

  await setClock(page, at('2026-09-19', '18:00'));
  const rolled = await page.evaluate(() => ({ current: window.PlanAuthority.current().id, streak: window.PlanAuthority.streak() }));
  expect(rolled.current).toBe(nextId);
  expect(rolled.streak.current).toBeGreaterThanOrEqual(1);
});
