// My Day daily workflow, end to end, in the real UI (synthetic account, no network).
//
// One simulated day: at night capture ideas, set up a learning routine and plan tomorrow; next
// morning read the dashboard, start a task, mark it done WHILE its timer runs, track and finish a
// second task, then do today's learning step in Focus. Reloads in between check persistence.
// Harness: an in-memory RTDB stub persisted in localStorage, the acknowledging accounting transport
// from time-ack-test-server.js, and a clock whose base lives in localStorage so "now" can move.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acknowledgingServer } from './time-ack-test-server.js';
import { addLesson, addPhase, addStep, createLearningPlan } from '../learning-plan-model.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
const UID = 'uid_day-user';
const NIGHT = Date.parse('2026-11-18T21:30:00Z');
const MORNING = Date.parse('2026-11-19T08:00:00Z');
let server; let url;

test.beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const p = path.resolve(APP_ROOT, `.${decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname)}`);
      if (!p.startsWith(APP_ROOT)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(p); const ext = path.extname(p);
      res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/index.html`;
});
test.afterAll(async () => { if (server) await new Promise(r => server.close(r)); });

// In-memory RTDB persisted in localStorage so a reload keeps "server" state. No network.
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const load = () => { try { return JSON.parse(localStorage.getItem('__e2e-remote') || '{}'); } catch { return {}; } };
  const tree = load();
  const clone = v => v == null ? null : JSON.parse(JSON.stringify(v));
  const save = () => localStorage.setItem('__e2e-remote', JSON.stringify(tree));
  const get = p => p.split('/').filter(Boolean).reduce((n, k) => n && n[k], tree);
  const put = (p, v) => { const ks = p.split('/').filter(Boolean); let n = tree; for (let i = 0; i < ks.length - 1; i++) { if (!n[ks[i]] || typeof n[ks[i]] !== 'object') n[ks[i]] = {}; n = n[ks[i]]; } if (v == null) delete n[ks.at(-1)]; else n[ks.at(-1)] = clone(v); save(); };
  const listeners = new Map();
  const valueAt = p => p === '.info/connected' ? true : get(p);
  const snap = v => ({ val: () => clone(v ?? null), exists: () => v != null, ref: { remove: () => Promise.resolve() } });
  const fireUp = p => { let q = p; for (;;) { (listeners.get(q) || []).forEach(cb => cb(snap(valueAt(q)))); if (!q.includes('/')) break; q = q.slice(0, q.lastIndexOf('/')); } };
  const makeRef = rp => ({
    path: rp, key: rp.split('/').pop(),
    child(c) { return makeRef(rp + '/' + c); },
    on(e, cb) { if (e !== 'value') return cb; if (!listeners.has(rp)) listeners.set(rp, []); listeners.get(rp).push(cb); setTimeout(() => cb(snap(valueAt(rp))), 0); return cb; },
    off(e, cb) { const l = listeners.get(rp) || []; listeners.set(rp, cb ? l.filter(x => x !== cb) : []); },
    once() { return Promise.resolve(snap(valueAt(rp))); },
    set(v) { put(rp, v); fireUp(rp); return Promise.resolve(); },
    update(o) { for (const [k, v] of Object.entries(o || {})) put(rp + '/' + k, v); fireUp(rp); return Promise.resolve(); },
    remove() { put(rp, null); fireUp(rp); return Promise.resolve(); },
    transaction(fn) { const next = fn(clone(get(rp))); if (next !== undefined) { put(rp, next); fireUp(rp); } return Promise.resolve({ committed: next !== undefined, snapshot: snap(get(rp)) }); },
    push(v) { const k = 'p' + Math.random().toString(36).slice(2, 10); const r = makeRef(rp + '/' + k); if (v !== undefined) r.set(v); return r; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve(), update: () => Promise.resolve() }; }
  });
  window.__fbTest = { get: p => clone(get(p)), remoteWrite: (p, v) => { put(p, v); fireUp(p); }, log: { writes: [] } };
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'day-user', displayName: 'Day User', email: 'day@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function () {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(c) { const a = { config: c }; this.apps.push(a); return a; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef, ServerValue: { TIMESTAMP: Date.now() } }; }, auth };
  window.firebase.database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' } };
})();`;

function learningPlan() {
  const ids = (...l) => { let i = 0; return () => l[Math.min(i++, l.length - 1)]; };
  const clock = () => '2026-11-10T12:00:00.000Z';
  let p = createLearningPlan({ title: 'Spanish basics' }, { idGenerator: ids('plan-es'), clock });
  p = addPhase(p, { title: 'Foundations' }, { idGenerator: ids('phase-1'), clock });
  p = addLesson(p, 'phase-1', { title: 'Greetings' }, { idGenerator: ids('lesson-1'), clock });
  p = addStep(p, 'lesson-1', { title: 'Learn 10 greetings' }, { idGenerator: ids('step-1'), clock });
  p = addStep(p, 'lesson-1', { title: 'Practice a short dialogue' }, { idGenerator: ids('step-2'), clock });
  return { schemaVersion: 1, plans: [p] };
}

async function boot(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`); });
  await acknowledgingServer(page, { offlineKey: '__e2e-net' });
  await page.route('https://www.gstatic.com/firebasejs/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.route(/^https:\/\/(?!www\.gstatic\.com\/firebasejs)/, r => r.abort());
  await page.addInitScript(({ uid, night, learning }) => {
    // A clock that ticks in real time from a base kept in localStorage (so tests can move "now").
    const RealDate = Date; const realNow = RealDate.now.bind(RealDate);
    const loadedAt = realNow();
    if (!localStorage.getItem('__e2e-base')) localStorage.setItem('__e2e-base', String(night));
    const base = Number(localStorage.getItem('__e2e-base'));
    let shift = 0;
    const now = () => base + shift + (realNow() - loadedAt);
    window.__e2eShift = ms => { shift += ms; };
    window.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now()])); } static now() { return now(); } };
    if (localStorage.getItem('__e2e-seeded')) return;
    localStorage.setItem('ta3-onboarded', '1');
    localStorage.setItem(`ta3-tz:${uid}`, 'UTC');
    localStorage.setItem(`ta3-settings:${uid}`, JSON.stringify({ timezone: 'UTC', hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem(`ta3-entries:${uid}`, '[]'); localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem(`ta3-plans:${uid}`, '{}'); localStorage.setItem(`ta3-reviews:${uid}`, '{}');
    localStorage.setItem(`ta3-learning-plans-v1:${uid}`, JSON.stringify(learning));
    localStorage.setItem('__e2e-seeded', '1');
  }, { uid: UID, night: NIGHT, learning: learningPlan() });
  await page.addInitScript(() => sessionStorage.setItem('ta3-session-started', '1'));
  return errors;
}


const ready = page => page.waitForFunction(() => !!globalThis.PlanAuthority?.current() && typeof openPlanTomorrow === 'function' && !!globalThis.DailyCommandCenter?.refreshWork);
const work = (page, key) => page.locator(`#command-work [data-work-line="${key}"] span`);
const entries = page => page.evaluate(uid => JSON.parse(localStorage.getItem(`ta3-entries:${uid}`) || '[]').filter(e => !e.deleted), UID);
const planCard = (page, title) => page.locator('#timeline-section [data-plan-item-id]').filter({ hasText: title }).filter({ hasText: 'Planned' }).first();
async function moveClockTo(page, ms) {
  await page.evaluate(at => localStorage.setItem('__e2e-base', String(at)), ms);
  await page.reload();
  await ready(page);
}
async function markDone(page, title) {
  const card = planCard(page, title);
  await card.locator('summary').click();
  await card.getByRole('button', { name: `Mark done: ${title}`, exact: true }).click();
}

async function addLearningRoutine(page) {
  await page.evaluate(() => openRoutineDayDialog());
  await page.getByRole('button', { name: 'Manage routines', exact: true }).click();
  await page.getByRole('button', { name: 'Add routine', exact: true }).click();
  const form = page.locator('#daily-routine-form');
  await form.locator('[name=title]').fill('Spanish');
  await form.locator('[name=mode]').selectOption('anytime');
  await form.locator('[name=source]').selectOption('learning');
  await form.locator('[name=planId]').selectOption('plan-es');
  await form.locator('[name=minimumMinutes]').fill('10');
  await form.getByRole('button', { name: 'Save routine', exact: true }).click();
  await page.keyboard.press('Escape');
}

test('a whole day: night plan, morning dashboard, start, complete, learning', async ({ page }) => {
  test.setTimeout(120000);
  const errors = await boot(page);
  await page.goto(url);
  await ready(page);
  await expect(page.locator('#signin-overlay')).toBeHidden();

  // ── Night (Wed 21:30): capture, a learning routine, plan tomorrow ──────────────────────────
  for (const idea of ['Book dentist appointment', 'Call the bank']) {
    await page.locator('#command-capture-text').fill(idea);
    await page.locator('#command-capture-text').press('Enter');
    await expect(page.locator('#command-capture-status')).toHaveText('Captured. Sort it in Brain Dump to plan it.');
  }
  await addLearningRoutine(page);

  await page.getByRole('button', { name: 'Plan Tomorrow', exact: true }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
  await expect(page.locator('#plan-tomorrow-date')).toContainText('Thursday, November 19');
  // Tonight's captures are not lost here: the planner says they are waiting to be sorted.
  await expect(page.locator('#plan-tomorrow-overlay .pt-unsorted')).toHaveText('2 new ideas not sorted yet. Sort them in Brain Dump to plan them.');
  await expect(page.locator('#plan-tomorrow-overlay')).not.toContainText('No Q1 or Q2 ideas available');
  // Visible even when the section is folded (phones): the summary carries the count.
  await expect(page.locator('#plan-tomorrow-overlay .pt-consider > summary')).toHaveText('From Brain Dump 0 ideas · 2 to sort');
  const add = page.locator('#plan-tomorrow-add');
  await add.locator('[name="task"]').fill('Write the project brief');
  await add.locator('[name="when"]').fill('09:00');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await add.locator('[name="task"]').fill('Draft the quarterly report');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);

  // ── Morning (Thu 08:00): the plan is today's dashboard ─────────────────────────────────────
  await moveClockTo(page, MORNING);
  await expect(page.locator('#today-date')).toHaveText('Thursday, November 19');
  await expect(page.locator('#up-next')).toContainText('Write the project brief');
  await expect(work(page, 'tasks')).toHaveText('Tasks · 0/2 done');
  await expect(work(page, 'learning')).toHaveText('Learning · 1 step today · Next: Learn 10 greetings');
  await expect(planCard(page, 'Draft the quarterly report')).toBeVisible();

  // ── Start the first task, work 25 min, then Mark done WHILE the timer runs ─────────────────
  await page.locator('#up-next').getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('#up-next').getByRole('button', { name: /Stop/ })).toBeVisible();
  await page.evaluate(() => window.__e2eShift(25 * 60000));
  await markDone(page, 'Write the project brief');
  // Mark done stops and logs the running timer (it used to keep running into the next morning).
  await expect(page.locator('#up-next').getByRole('button', { name: /Stop/ })).toHaveCount(0);
  await expect(work(page, 'tasks')).toHaveText('Tasks · 1/2 done');
  await expect.poll(async () => (await entries(page)).filter(e => e.activity === 'Write the project brief').map(e => e.blockIntervalMin)).toEqual([25]);
  expect(await page.evaluate(() => running)).toBe(false);

  // ── Second task: Start, Stop (logged), then Mark done ──────────────────────────────────────
  await expect(page.locator('#up-next')).toContainText('Draft the quarterly report');
  await page.locator('#up-next').getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('#up-next').getByRole('button', { name: /Stop/ })).toBeVisible();
  await page.evaluate(() => window.__e2eShift(40 * 60000));
  await page.locator('#up-next').getByRole('button', { name: /Stop/ }).click();
  await expect(page.locator('#toast')).toContainText('Logged · Draft the quarterly report · 40m');
  await markDone(page, 'Draft the quarterly report');
  await expect(work(page, 'tasks')).toHaveText('Tasks · 2/2 done');
  const both = await entries(page);
  expect(both.map(e => [e.activity, e.blockIntervalMin, !!e.planItemId]).sort()).toEqual([['Draft the quarterly report', 40, true], ['Write the project brief', 25, true]]);

  // ── Learning: Today's work > Show opens the routine card; Start Focus on today's step ──────
  await page.locator('#command-work [data-work-line="learning"]').getByRole('button', { name: 'Show', exact: true }).click();
  const dialog = page.locator('#routine-day-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Spanish basics · Today's step: Learn 10 greetings");
  await expect(dialog.getByRole('button', { name: 'Open Learning Plans', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Start Focus', exact: true }).click();
  await expect(page.locator('#focus-overlay')).toContainText('Learn 10 greetings');
  // The 15-minute session runs to its end (the app restores it from wall time on reopen).
  await moveClockTo(page, MORNING + 2 * 3600000);
  // The finished session asks whether the step is done, in Learning Plans.
  const outcome = page.getByRole('region', { name: 'Focus outcome' });
  await expect(outcome).toContainText('Did you finish this step?');
  await expect(outcome).toContainText('Learn 10 greetings');
  await outcome.getByRole('button', { name: 'Done', exact: true }).click();
  // Done records the step and returns to My Day.
  await expect(work(page, 'learning')).toHaveText('Learning · 1 step done today');
  const steps = await page.evaluate(uid => JSON.parse(localStorage.getItem(`ta3-learning-plans-v1:${uid}`)).plans[0].phases[0].lessons[0].steps.map(s => [s.title, s.completed]), UID);
  expect(steps).toEqual([['Learn 10 greetings', true], ['Practice a short dialogue', false]]);
  expect((await entries(page)).some(e => e.activity === 'Learn 10 greetings' && e.blockIntervalMin === 15)).toBe(true);

  // ── Next morning: nothing is left running, the day is intact ────────────────────────────────
  await moveClockTo(page, MORNING + 24 * 3600000);
  expect(await page.evaluate(() => running)).toBe(false);
  await expect(page.getByText(/timer was running/i).filter({ visible: true })).toHaveCount(0);
  expect((await entries(page)).filter(e => e.planItemId).length).toBe(2);
  expect(errors.filter(e => !/Failed to load resource/.test(e))).toEqual([]);
});

test("a learning card leads to the plan itself (Open Learning Plans)", async ({ page }) => {
  await boot(page);
  await page.goto(url);
  await ready(page);
  await addLearningRoutine(page);
  await page.locator('#command-work [data-work-line="learning"]').getByRole('button', { name: 'Show', exact: true }).click();
  const dialog = page.locator('#routine-day-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Open Learning Plans', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#view-learning')).toBeVisible();
  await expect(page.locator('#view-learning')).toContainText('Spanish basics');
  await expect(page.getByRole('checkbox', { name: 'Complete step: Learn 10 greetings' })).toBeVisible();
});

test('offline: a provisional Start shows as running, and Mark done stops it', async ({ page }) => {
  await boot(page);
  await page.goto(url);
  await ready(page);
  await page.evaluate(() => {
    const item = createPlanItem('Pay the electricity bill', '');
    PlanAuthority.addItem({ destination: PlanAuthority.current(), item });
    refreshAuthoritativePlanSurfaces();
  });
  await expect(page.locator('#up-next')).toContainText('Pay the electricity bill');
  // The connection drops: sync attempts fail, so a Start is provisional.
  await page.evaluate(() => localStorage.setItem('__e2e-net', JSON.stringify({ failWrites: true })));
  await page.locator('#up-next').getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('#today-action-strip')).toContainText('Started offline — waiting to sync');
  await expect(page.locator('#today-action-primary')).toHaveText('Stop');
  // The fixed status dock (offline notice) never hides the page: scrolled to the end, the last
  // content of My Day sits above it, so no card's buttons are stuck underneath.
  await expect(page.locator('#ordinary-provisional')).toBeVisible();
  const gap = await page.evaluate(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(r => setTimeout(r, 400));
    const view = document.querySelector('.view.active');
    const last = [...view.querySelectorAll('*')].filter(el => el.offsetParent && el.getBoundingClientRect().height > 0)
      .reduce((max, el) => Math.max(max, el.getBoundingClientRect().bottom), 0);
    return document.getElementById('status-dock').getBoundingClientRect().top - last;
  });
  expect(gap).toBeGreaterThanOrEqual(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  const panel = page.locator('#ordinary-provisional');
  if (await panel.isVisible()) await expect(panel).not.toContainText(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
  await page.evaluate(() => window.__e2eShift(20 * 60000));
  await markDone(page, 'Pay the electricity bill');
  await expect(page.locator('#today-action-strip')).not.toContainText('Started offline');
  await expect(work(page, 'tasks')).toHaveText('Tasks · 1/1 done');
  expect(await page.evaluate(() => { try { return !!ordinaryProvisionalState()?.frame?.running; } catch { return 'error'; } })).toBe(false);
});

test('Plan Tomorrow keeps an unsaved draft across a trip to Brain Dump and back', async ({ page }) => {
  await boot(page);
  await page.goto(url);
  await ready(page);
  await page.locator('#command-capture-text').fill('Renew the passport');
  await page.locator('#command-capture-text').press('Enter');
  await page.getByRole('button', { name: 'Plan Tomorrow', exact: true }).click();
  const overlay = page.locator('#plan-tomorrow-overlay');
  await expect(overlay).toHaveClass(/open/);
  const add = page.locator('#plan-tomorrow-add');
  await add.locator('[name="task"]').fill('Water the plants');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(overlay).toContainText('Water the plants');
  await expect(overlay.locator('.pt-consider > summary')).toHaveText('From Brain Dump 0 ideas · 1 to sort');
  // Go sort the idea in Brain Dump (unsaved draft), then come back.
  if (!(await overlay.locator('.pt-consider').evaluate(d => d.open))) await overlay.locator('.pt-consider > summary').click();
  await overlay.getByRole('button', { name: 'Open Brain Dump', exact: true }).click();
  await expect(overlay).not.toHaveClass(/open/);
  await expect(page.locator('#view-braindump')).toBeVisible();
  await expect(page.locator('#view-braindump')).toContainText('Renew the passport');
  await page.locator('#pt-return').click();
  await expect(overlay).toHaveClass(/open/);
  await expect(overlay).toContainText('Water the plants');
  await expect(page.locator('#pt-save-status')).toHaveText('Unsaved changes');
});
