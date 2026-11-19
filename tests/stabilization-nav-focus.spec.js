// Stabilization 2026-11-19: Focus never traps navigation; one nav shell on every page.
// Harness copied from my-day-daily-workflow.spec.js (synthetic account, no network).
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


async function startFocus(page, task) {
  await page.evaluate(() => enterFocusMode());
  await expect(page.locator('#focus-overlay')).toHaveClass(/open/);
  await page.locator('#focus-task-input').fill(task);
  await page.locator('#focus-start-btn').click();
  await page.waitForFunction(() => isFocusSessionRunning());
}
const queueLength = page => page.evaluate(() => accountingCoordinator().snapshot().queue.length);

test('Focus with unresolved accounting: Exit is refused but Hide leaves the session running and the app navigable', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await boot(page);
  await page.goto(url); await ready(page);
  await startFocus(page, 'Write the project brief');
  // The owner's real state: an accounting operation is retained, so ending the session is refused.
  await page.evaluate(() => { window.timeAckBlocks = label => { showToast(`${label} waits for your retained accounting operation`); return true; }; });
  page.on('dialog', d => d.accept());
  await page.locator('#focus-overlay').getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(page.locator('#focus-overlay')).toHaveClass(/open/);
  await expect(page.locator('#toast')).toContainText('Use Hide to keep it running');
  // The overlay covers the nav: navigation is impossible until it closes.
  expect(await page.evaluate(() => { const r = document.getElementById('nav-braindump').getBoundingClientRect();
    return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('#focus-overlay'); })).toBe(true);
  const before = await queueLength(page);
  await page.getByRole('button', { name: 'Hide · keep running', exact: true }).click();
  await expect(page.locator('#focus-overlay')).not.toHaveClass(/open/);
  expect(await page.evaluate(() => isFocusSessionRunning())).toBe(true);
  expect(await queueLength(page)).toBe(before); // Hide staged no accounting operation
  await page.locator('#nav-braindump').click();
  await expect(page.locator('#view-braindump')).toHaveClass(/active/);
  await page.locator('#nav-today').click();
  await expect(page.locator('#up-next')).toContainText('Focus session running');
  await page.locator('#up-next').getByRole('button', { name: 'Open focus', exact: true }).click();
  await expect(page.locator('#focus-overlay')).toHaveClass(/open/);
  await expect(page.locator('#focus-intention-text')).toHaveText('Write the project brief');
  expect(errors.filter(e => !/Failed to load resource/.test(e))).toEqual([]);
});

test('Hide after a reload: the restored Focus screen can always be left', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page);
  await page.goto(url); await ready(page);
  await startFocus(page, 'Draft the quarterly report');
  await page.reload(); await ready(page);
  await expect(page.locator('#focus-overlay')).toHaveClass(/open/);
  await page.getByRole('button', { name: 'Hide · keep running', exact: true }).click();
  await expect(page.locator('#focus-overlay')).not.toHaveClass(/open/);
  expect(await page.evaluate(() => isFocusSessionRunning())).toBe(true);
  await page.locator('#nav-learning').click();
  await expect(page.locator('#view-learning')).toHaveClass(/active/);
});

for (const [w, h, where] of [[1280, 900, 'left'], [1000, 800, 'bottom'], [390, 844, 'bottom']]) {
  test(`one nav shell at ${w}px: the nav sits at the ${where} on every page, same box and same buttons`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await boot(page);
    await page.goto(url); await ready(page);
    const shapes = [];
    for (const view of ['today', 'braindump', 'week', 'learning', 'settings']) {
      await page.evaluate(v => showView(v), view);
      shapes.push(await page.evaluate(() => {
        const r = document.querySelector('.nav').getBoundingClientRect(); const b = getComputedStyle(document.querySelector('#nav-today'));
        return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), font: b.fontFamily, size: b.fontSize, minH: b.minHeight, dir: b.flexDirection });
      }));
    }
    expect(new Set(shapes).size, shapes.join('\n')).toBe(1);
    const box = JSON.parse(shapes[0]);
    if (where === 'left') expect(box.x).toBeLessThan(40); else expect(box.y + box.h).toBeGreaterThan(h - 4);
    if (where === 'left') { // content never sits under the sidebar
      for (const view of ['today', 'braindump', 'learning']) {
        await page.evaluate(v => showView(v), view);
        const left = await page.evaluate(v => document.getElementById('view-' + v).getBoundingClientRect().left, view);
        expect(left).toBeGreaterThanOrEqual(box.x + box.w);
      }
    }
  });
}
