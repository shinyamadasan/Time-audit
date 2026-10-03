// Brain Dump Production UX Correction V1 — browser coverage for the owner's
// exact production usage.
//
// Unlike tests/brain-dump-eisenhower.spec.js, this stub keeps a real in-memory
// brainDump subtree and reproduces real Firebase behavior for it: a committed
// transaction raises the subtree 'value' event BEFORE the transaction's own
// Promise resolves, and every record is stored in RTDB's wire form, with null
// keys pruned. Normalization rejecting that pruned form is what made every fresh
// promotion in production report "Already being promoted elsewhere"; the old
// stub (which never re-fires the listener, and kept nulls) could not show it.
// `window.__bdHold(id)` / `window.__bdRelease(id)` delay one capture's
// transactions, to observe a pending claim.
//
// Every other path keeps the old stub's behavior. No real Firebase, no network.

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
const UID = 'bdpux-user';
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => (value === undefined ? null : JSON.parse(JSON.stringify(value))), ref: { remove: () => Promise.resolve() } });
  // Real RTDB never stores a null: its key disappears, recursively (proven against the real SDK in
  // brain-dump-wire-format.test.js). The brainDump subtree here is stored ONLY in that wire form.
  const prune = value => {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value) || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) { const kept = prune(child); if (kept !== undefined) out[key] = kept; }
    return Object.keys(out).length ? out : undefined;
  };
  const bd = {};
  const bdListeners = new Set();
  const held = new Map();
  window.__bdRemote = () => JSON.parse(JSON.stringify(bd));
  window.__bdHold = id => held.set(id, []);
  window.__bdRelease = id => { const q = held.get(id) || []; held.delete(id); q.forEach(fn => fn()); };
  const isBdRoot = p => /\\/brainDump$/.test(p);
  const bdId = p => { const m = /\\/brainDump\\/([^/]+)$/.exec(p); return m ? m[1] : null; };
  function runBd(id, updateFn) {
    const next = updateFn(bd[id] === undefined ? null : JSON.parse(JSON.stringify(bd[id])));
    if (next === undefined) return { committed: false, snapshot: snapshot(bd[id]) };
    bd[id] = prune(JSON.parse(JSON.stringify(next)));
    bdListeners.forEach(cb => cb(snapshot(bd))); // real Firebase: events first, then the transaction settles
    return { committed: true, snapshot: snapshot(bd[id]) };
  }
  const makeRef = refPath => ({
    path: refPath, child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) {
      if (eventName !== 'value') return cb;
      if (isBdRoot(refPath)) { bdListeners.add(cb); setTimeout(() => cb(snapshot(bd)), 0); return cb; }
      setTimeout(() => cb(snapshot(null)), 0); return cb;
    },
    off() { if (isBdRoot(refPath)) bdListeners.clear(); }, once() { return Promise.resolve(snapshot(null)); }, update() { return Promise.resolve(); },
    set() { return Promise.resolve(); }, remove() { return Promise.resolve(); },
    transaction(updateFn) {
      const id = bdId(refPath);
      if (id) {
        const queue = held.get(id);
        if (queue) return new Promise(resolve => queue.push(() => resolve(runBd(id, updateFn))));
        return Promise.resolve(runBd(id, updateFn));
      }
      const value = updateFn(null); return Promise.resolve({ committed: true, snapshot: snapshot(value) });
    },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: '${UID}', displayName: 'BDPUX User', email: 'bdpux@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
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
  await page.addInitScript(({ timezone, now, uid }) => {
    // Starts at `now` and keeps ticking. A frozen clock would give every write
    // the same updatedAt, and this stub (unlike the old one) holds real remote
    // records, so same-millisecond writes would fall to the canonical tie-break
    // instead of LWW, which no real device clock produces between two clicks.
    const RealDate = Date;
    const startedAt = RealDate.now();
    const current = () => now + (RealDate.now() - startedAt);
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [current()])); } static now() { return current(); } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem(`ta3-tz:uid_${uid}`, timezone);
    localStorage.setItem('ta3-device-id', 'device-bdpux');
    localStorage.setItem(`ta3-settings:uid_${uid}`, JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem(`ta3-entries:uid_${uid}`, '[]');
    localStorage.setItem(`ta3-plans:uid_${uid}`, '{}'); localStorage.setItem('ta3-reviews', '{}'); localStorage.setItem('ta3-focus-redemptions', '[]');
  }, { timezone: TZ, now, uid: UID });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object' && typeof window.BrainDumpUI === 'object' && typeof window.BrainDumpSync === 'object');
  await expect(page.locator('#signin-overlay')).toBeHidden();
  // Record every toast so a test can assert on exactly what the owner was told.
  await page.evaluate(() => {
    window.__toasts = [];
    const original = window.showToast;
    window.showToast = (msg, ...rest) => { window.__toasts.push(msg); return original(msg, ...rest); };
  });
  await page.evaluate(() => showView('braindump'));
}

const root = page => page.locator('#bd-root');
const toasts = page => page.evaluate(() => window.__toasts.slice());
const storage = page => page.evaluate(uid => JSON.parse(localStorage.getItem(`ta3-brain-dump-v1:uid_${uid}`) || '{"captures":{}}').captures, UID);
const plans = page => page.evaluate(uid => JSON.parse(localStorage.getItem(`ta3-plans:uid_${uid}`) || '{}'), UID);
const planItemsNamed = async (page, text) => Object.values(await plans(page)).flatMap(day => day.items || []).filter(item => item.task === text);

async function captureOne(page, text) {
  await page.locator('#bd-capture-text').fill(text);
  await page.locator('#bd-capture-form button[type=submit]').click();
  const captures = await storage(page);
  return Object.values(captures).find(c => c.text === text).id;
}

async function triage(page, id, important, urgent) {
  await page.locator(`button[onclick="window.BrainDumpUI.setTriageAnswer('${id}','important',${important})"]`).click();
  await page.locator(`button[onclick="window.BrainDumpUI.setTriageAnswer('${id}','urgent',${urgent})"]`).click();
  await page.locator(`button[onclick="window.BrainDumpUI.saveTriage('${id}')"]`).click();
}

async function schedule(page, id, dateKey) {
  await page.locator(`button[onclick="window.BrainDumpUI.toggleSchedule('${id}')"]`).click();
  await page.locator(`#bd-sched-date-${id}`).fill(dateKey);
  await page.locator(`button[onclick="window.BrainDumpUI.confirmSchedule('${id}')"]`).click();
}

const FALSE_CONFLICT = /elsewhere|another device/i;

// ═══════════════════════════════════════════════════════════════════════
// F1 — one coherent Brain Dump module generation
// ═══════════════════════════════════════════════════════════════════════

test('F1. a stale browser cache of the OLD bare brain-dump modules cannot break the new page: every Brain Dump module loads through its versioned URL', async ({ page }) => {
  // Simulates the HTTP cache still holding the pre-reopen (cf43080) model/repository/promotion at their
  // BARE urls. A page that imports them bare links new entry code against old modules and fails with
  // "does not provide an export named ...". The new page must never request them bare at all.
  const stale = {};
  for (const name of ['brain-dump-model.js', 'brain-dump-repository.js', 'brain-dump-promotion.js']) {
    stale[name] = (await fs.readFile(path.join(APP_ROOT, 'fixtures', 'brain-dump-pre-reopen', name), 'utf8'))
      .replace("'../../personal-day-boundary-repository.js'", "'./personal-day-boundary-repository.js'");
  }
  const bareRequests = [];
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route(url => /\/brain-dump-[a-z-]+\.js$/.test(url.pathname) && !url.search, route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    bareRequests.push(name);
    return stale[name] ? route.fulfill({ status: 200, contentType: 'application/javascript', body: stale[name] }) : route.continue();
  });
  await openApp(page, { now: at('2026-10-01', '09:00') });
  expect(bareRequests, 'no Brain Dump module may be fetched through a bare (cacheable-forever-stale) URL').toEqual([]);
  expect(errors.filter(m => /does not provide an export/.test(m))).toEqual([]);
  const id = await captureOne(page, 'Coherent generation');
  await triage(page, id, true, true);
  await page.locator(`button[onclick="window.BrainDumpUI.doToday('${id}')"]`).click();
  await expect.poll(async () => (await storage(page))[id].status).toBe('promoted');
});

// ═══════════════════════════════════════════════════════════════════════
// Problem 1 — fresh captures never report a false conflict
// ═══════════════════════════════════════════════════════════════════════

test('A+B. fresh capture A schedules with a plain success; fresh capture B right after it also succeeds independently', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const a = await captureOne(page, 'Capture A');
  await triage(page, a, true, false);
  await schedule(page, a, '2026-10-10');
  await expect.poll(async () => (await storage(page))[a].status).toBe('promoted');

  const b = await captureOne(page, 'Capture B');
  await triage(page, b, true, false);
  await schedule(page, b, '2026-10-11');
  await expect.poll(async () => (await storage(page))[b].status).toBe('promoted');

  const told = await toasts(page);
  expect(told.filter(m => m === 'Added to your plan.').length).toBe(2);
  expect(told.some(m => FALSE_CONFLICT.test(m)), `toasts: ${JSON.stringify(told)}`).toBe(false);
  expect((await planItemsNamed(page, 'Capture A')).length).toBe(1);
  expect((await planItemsNamed(page, 'Capture B')).length).toBe(1);
  expect((await page.evaluate(() => window.__bdRemote()))[a].status).toBe('promoted');
  await expect(root(page)).toContainText('Scheduled · Sat, Oct 10');
});

test('C. fresh capture -> Do Today: one plan item and a normal success message', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Do it today');
  await triage(page, id, true, true);
  await page.locator(`button[onclick="window.BrainDumpUI.doToday('${id}')"]`).click();
  await expect.poll(async () => (await storage(page))[id].status).toBe('promoted');
  const told = await toasts(page);
  expect(told).toContain('Added to today\'s plan.');
  expect(told.some(m => FALSE_CONFLICT.test(m))).toBe(false);
  expect((await planItemsNamed(page, 'Do it today')).length).toBe(1);
  await expect(root(page)).toContainText('Added to plan · Thu, Oct 1');
});

test('F. capture A pending ("Still confirming…") does not block capture B; A then settles to one destination', async ({ page }) => {
  test.setTimeout(45_000);
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const a = await captureOne(page, 'Slow capture');
  await triage(page, a, true, false);
  const b = await captureOne(page, 'Independent capture');
  await triage(page, b, true, false);
  await page.evaluate(id => window.__bdHold(id), a);
  await schedule(page, a, '2026-10-10');
  await expect(root(page)).toContainText('Still confirming a previous action…', { timeout: 15_000 });
  await schedule(page, b, '2026-10-11');
  await expect.poll(async () => (await storage(page))[b].status).toBe('promoted');
  expect((await storage(page))[a].status).toBe('triaged');
  await page.evaluate(id => window.__bdRelease(id), a);
  await expect.poll(async () => (await storage(page))[a].status).toBe('promoted');
  expect((await planItemsNamed(page, 'Slow capture')).length).toBe(1);
  expect((await planItemsNamed(page, 'Independent capture')).length).toBe(1);
  const told = await toasts(page);
  expect(told).toContain('Still confirming…');
  expect(told.some(m => FALSE_CONFLICT.test(m))).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════
// Problem 2 — handled items are editable and reopenable
// ═══════════════════════════════════════════════════════════════════════

test('G+H+I. delegated: edit text and person keeps it delegated; Reopen returns it to triage with the same id, then it schedules once', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Call contractor');
  await triage(page, id, true, false);
  page.once('dialog', dialog => dialog.accept('Alex'));
  await page.locator(`button[onclick="window.BrainDumpUI.delegate('${id}')"]`).click();
  await expect(root(page)).toContainText('Delegated — Alex');

  await page.locator(`button[onclick="window.BrainDumpUI.toggleHandledEdit('${id}')"]`).click();
  await page.locator(`#bd-edit-text-${id}`).fill('Call roofing contractor');
  await page.locator(`#bd-edit-delegated-${id}`).fill('Sam');
  await page.locator(`button[onclick="window.BrainDumpUI.saveHandledEdit('${id}')"]`).click();
  await expect(root(page)).toContainText('Delegated — Sam');
  let record = (await storage(page))[id];
  expect(record.status).toBe('delegated');
  expect(record.text).toBe('Call roofing contractor');
  expect(record.delegatedTo).toBe('Sam');

  await page.locator(`button[onclick="window.BrainDumpUI.reopen('${id}')"]`).click();
  await expect(root(page)).toContainText('Triaged (1)');
  await expect(root(page)).toContainText('Schedule — important, not urgent');
  record = (await storage(page))[id];
  expect(record.status).toBe('triaged');
  expect(record.delegatedTo).toBe(null);
  expect(Object.keys(await storage(page))).toEqual([id]);
  expect(await toasts(page)).toContain('Moved back to triage.');

  await schedule(page, id, '2026-10-12');
  await expect.poll(async () => (await storage(page))[id].status).toBe('promoted');
  expect((await planItemsNamed(page, 'Call roofing contractor')).length).toBe(1);
});

test('J+K. archived: edit keeps it archived; Reopen returns it to triage', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Old idea');
  await triage(page, id, false, false);
  await page.locator(`button[onclick="window.BrainDumpUI.archive('${id}')"]`).click();
  await expect(root(page)).toContainText('Archived');
  await page.locator(`button[onclick="window.BrainDumpUI.toggleHandledEdit('${id}')"]`).click();
  await expect(page.locator(`#bd-edit-delegated-${id}`)).toHaveCount(0);
  await page.locator(`#bd-edit-text-${id}`).fill('Old idea, reworded');
  await page.locator(`button[onclick="window.BrainDumpUI.saveHandledEdit('${id}')"]`).click();
  await expect(root(page)).toContainText('Old idea, reworded');
  expect((await storage(page))[id].status).toBe('archived');

  await page.locator(`button[onclick="window.BrainDumpUI.reopen('${id}')"]`).click();
  await expect(root(page)).toContainText('Archive candidate');
  expect((await storage(page))[id].status).toBe('triaged');
  expect((await page.evaluate(() => window.__bdRemote()))[id].status).toBe('triaged');
});

test('M. a promoted item shows where it went and offers Open in plan, never Edit/Reopen', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const id = await captureOne(page, 'Dentist follow-up');
  await triage(page, id, true, false);
  await page.locator(`button[onclick="window.BrainDumpUI.toggleSchedule('${id}')"]`).click();
  await page.locator(`#bd-sched-date-${id}`).fill('2026-10-12');
  await page.locator(`#bd-sched-time-${id}`).fill('14:30');
  await page.locator(`button[onclick="window.BrainDumpUI.confirmSchedule('${id}')"]`).click();
  await expect(root(page)).toContainText('Scheduled · Mon, Oct 12 at 14:30');
  const row = page.locator(`[data-bd-handled="${id}"]`);
  await expect(row.locator('button', { hasText: 'Reopen' })).toHaveCount(0);
  await expect(row.locator('button', { hasText: 'Edit' })).toHaveCount(0);
  await row.locator('button', { hasText: 'Open in plan' }).click();
  await expect(page.locator('#view-today')).toHaveClass(/active/);
  await expect(page.locator('#view-today')).toContainText('Dentist follow-up');
});
