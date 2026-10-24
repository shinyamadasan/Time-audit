// TASK-017: real UI/authority/sync modules; synthetic accounts and recording Firebase transport.
// The recording transport and account/clock harness match calendar-native-plan-identity.spec.js.
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
const ROOM = 'uid_account-a';
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const SUN = '2026-09-27';


const BOUNDARY_ID = 'r-1800';
const boundaryStore = () => JSON.stringify({ schemaVersion: 1, revisions: {
  'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
  [BOUNDARY_ID]: { id: BOUNDARY_ID, boundaryTime: '18:00', timezone: TZ, effectiveFromInstant: at('2026-09-01', '18:00') },
} });
// A recording Firebase stub (same shape the isolation specs use), plus a movable clock.
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const log = { writes: [], listeners: [] };
  const tree = {};
  const listeners = new Map();
  const retained = [];
  let delayAuthority = window.__delayCalendarAuthority === true;
  const get = p => p.split('/').filter(Boolean).reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), tree);
  const put = (p, v) => {
    const segs = p.split('/').filter(Boolean); let n = tree;
    for (let i = 0; i < segs.length - 1; i++) { if (typeof n[segs[i]] !== 'object' || n[segs[i]] === null) n[segs[i]] = {}; n = n[segs[i]]; }
    n[segs[segs.length - 1]] = v;
  };
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const snapshot = value => ({ val: () => clone(value), ref: { remove: () => Promise.resolve() } });
  const fire = p => {
    if (delayAuthority && p.endsWith('/calendarPlanAuthority')) return;
    (listeners.get(p) || []).forEach(cb => cb(snapshot(get(p))));
  };
  const fireUp = p => { let q = p; while (q) { fire(q); q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : ''; } };
  let failWrites = false;
  let authCb = null;
  const makeRef = refPath => ({
    path: refPath,
    child(c) { return makeRef(refPath + '/' + c); },
    on(ev, cb) {
      if (ev !== 'value') return cb;
      log.listeners.push(refPath);
      if (!listeners.has(refPath)) listeners.set(refPath, []);
      listeners.get(refPath).push(cb);
      retained.push({ path: refPath, cb });
      const value = refPath === '.info/connected' ? true : get(refPath);
      if (!(delayAuthority && refPath.endsWith('/calendarPlanAuthority'))) {
        setTimeout(() => cb(snapshot(value === undefined ? null : value)), 0);
      }
      return cb;
    },
    off() { listeners.delete(refPath); },
    once() { return Promise.resolve(snapshot(get(refPath))); },
    update(map) {
      if (failWrites) return Promise.reject(new Error('offline'));
      Object.entries(map || {}).forEach(([k, v]) => { log.writes.push({ path: refPath + '/' + k, value: clone(v) }); put(refPath + '/' + k, clone(v)); fireUp(refPath + '/' + k); });
      return Promise.resolve();
    },
    set(v) { put(refPath, clone(v)); return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    transaction(fn) {
      if (failWrites) return Promise.reject(new Error('offline'));
      const cur = get(refPath);
      const next = fn(cur === undefined ? null : clone(cur));
      if (next === undefined) return Promise.resolve({ committed: false, snapshot: snapshot(cur) });
      log.writes.push({ path: refPath, value: clone(next) });
      put(refPath, clone(next));
      fireUp(refPath);
      return Promise.resolve({ committed: true, snapshot: snapshot(next) });
    },
    push(v) { const r = makeRef(refPath + '/pushed'); r.key = 'pushed'; if (v !== undefined) r.set(v); return r; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; },
  });
  const user = uid => (uid ? { uid, displayName: uid, email: uid + '@example.test', photoURL: '' } : null);
  window.__fbTest = {
    log,
    get: p => clone(get(p) ?? null),
    seed(p, v) { put(p, clone(v)); },
    remoteWrite(p, v) { put(p, clone(v)); fireUp(p); },
    deliverAuthority() {
      delayAuthority = false;
      for (const [p, callbacks] of listeners.entries()) {
        if (p.endsWith('/calendarPlanAuthority')) callbacks.forEach(cb => cb(snapshot(get(p))));
      }
    },
    setFailWrites(v) { failWrites = v; },
    signInAs(uid) { authCb(user(uid)); },
    reconnect() { put('.info/connected', true); retained.filter(r => r.path === '.info/connected').forEach(r => r.cb(snapshot(true))); },
  };
  const auth = () => ({ onAuthStateChanged(cb) { authCb = cb; setTimeout(() => cb(user('account-a')), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(c) { const a = { config: c }; this.apps.push(a); return a; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
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

/** Opens the app at a frozen instant. `boundary` seeds the legacy Personal Day boundary (18:00);
 *  `operationalPlans` seeds a plan in the legacy operational store. The seed happens once per page
 *  (a reload keeps whatever the app itself has written since). */
async function openApp(page, { now = at(SUN, '11:00'), boundary = true, operationalPlans = null, legacyPlans = '{}', delayAuthority = false } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, boundary, operationalPlans, legacyPlans, delayAuthority }) => {
    window.__delayCalendarAuthority = delayAuthority;
    let frozen = Number(localStorage.getItem('cnpi-now')) || now;
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [frozen])); } static now() { return frozen; } };
    window.__setNow = value => { frozen = value; localStorage.setItem('cnpi-now', String(value)); };
    if (localStorage.getItem('cnpi-seeded') === '1') return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('cnpi-seeded', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz:uid_account-a', timezone);
    localStorage.setItem('ta3-device-id', 'device-cnpi');
    localStorage.setItem('ta3-settings:uid_account-a', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries:uid_account-a', '[]');
    localStorage.setItem('ta3-plans:uid_account-a', legacyPlans); localStorage.setItem('ta3-reviews', '{}'); localStorage.setItem('ta3-focus-redemptions', '[]');
    if (boundary) localStorage.setItem('ta3-day-boundary-revisions-v1:uid_account-a', boundary);
    if (operationalPlans) localStorage.setItem('ta3-operational-plans-v1:uid_account-a', operationalPlans);
  }, { timezone: TZ, now, boundary: boundary ? boundaryStore() : null, operationalPlans, legacyPlans, delayAuthority });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object' && typeof window.CalendarPlanLive === 'object' && typeof window.PlanByDeadlineSync === 'object' && !!window.__fbTest);
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode?.() === 'uid_account-a');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

const SOURCE_DATE = '2026-09-23';
const sourceId = store => store === 'calendar' ? `cal1:${SOURCE_DATE}`
  : store === 'operational' ? `odv1:r-1800:${TZ}:${SOURCE_DATE}` : SOURCE_DATE;
const item = (id, task = `Task ${id}`) => ({ id, task, kind: 'task', when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'device-original' });
const recovery = page => page.locator('#unfinished-recovery-section');
const row = (page, id) => recovery(page).locator(`[data-pc-stale="${id}"]`);
const remotePath = store => `rooms/${ROOM}/${store === 'calendar' ? 'calendarPlans' : store === 'operational' ? 'operationalPlans' : 'plans'}/${sourceId(store)}`;

async function seed(page, store = 'operational', items = [item('a'), item('b')]) {
  const record = { items, updatedAt: 1000, updatedBy: 'device-original' };
  await openApp(page, {
    boundary: store === 'operational',
    operationalPlans: store === 'operational' ? JSON.stringify({ schemaVersion: 1, plans: { [sourceId(store)]: record } }) : null,
    legacyPlans: store === 'legacy' ? JSON.stringify({ [SOURCE_DATE]: record }) : '{}',
  });
  if (store === 'calendar') {
    await page.evaluate(({ record, sourceDate }) => {
      __fbTest.seed(`rooms/uid_account-a/calendarPlans/cal1:${sourceDate}`, record);
      __fbTest.remoteWrite('rooms/uid_account-a/calendarPlanAuthority/ca1-task017', {
        schemaVersion: 1, id: 'ca1-task017', activationDate: '2026-09-01',
        activatedAtMs: Date.parse('2026-09-01T00:00:00+08:00'), timezone: 'Asia/Manila', deviceId: 'device-original',
      });
      CalendarPlanSync.attachPlan(`cal1:${sourceDate}`);
      refreshAuthoritativePlanSurfaces();
    }, { record, sourceDate: SOURCE_DATE });
  }
  await expect(recovery(page).getByRole('button', { name: `Unfinished · ${items.length}` })).toBeVisible();
  await recovery(page).getByRole('button', { name: /Unfinished/ }).click();
}

async function raw(page, store = 'operational') {
  return page.evaluate(id => PlanAuthority.rawItems(PlanAuthority.targetById(id)), sourceId(store));
}

async function dismiss(page, id = 'a') {
  await row(page, id).getByRole('button', { name: /^More actions:/ }).click();
  await page.getByRole('menuitem', { name: 'Not doing this', exact: true }).click();
}

for (const store of ['legacy', 'operational', 'calendar']) {
  test(`${store}: targeted dismissal + same-clock Undo preserve original history and survive stale merge`, async ({ page }) => {
    await seed(page, store);
    const before = await raw(page, store);
    await expect(page.getByRole('menuitem', { name: 'Not doing this' })).toBeHidden();
    await dismiss(page);
    await expect(row(page, 'a')).toHaveCount(0);
    await expect(row(page, 'b')).toBeVisible();
    const dismissed = await raw(page, store);
    expect(dismissed[1]).toEqual(before[1]);
    expect(dismissed[0]).toMatchObject({ id: before[0].id, task: before[0].task, when: before[0].when, done: false });
    expect(dismissed[0].dismissedAt).toBeGreaterThan(1000);
    await expect(recovery(page)).toContainText('Original plan and history kept');
    await recovery(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(row(page, 'a')).toBeVisible();
    const restored = await raw(page, store);
    const { updatedAt, updatedBy, ...facts } = restored[0];
    const { updatedAt: oldAt, updatedBy: oldBy, ...oldFacts } = before[0];
    expect(facts).toEqual(oldFacts);
    expect(updatedAt).toBeGreaterThan(dismissed[0].updatedAt);
    expect(updatedBy).toBe('device-cnpi');
    expect(restored[1]).toEqual(before[1]);
    // Deliver the stale dismissal through the real sync listener after the Undo.
    await page.evaluate(({ path, items }) => __fbTest.remoteWrite(path, { items, updatedAt: items[0].updatedAt, updatedBy: items[0].updatedBy }), { path: remotePath(store), items: dismissed });
    await expect.poll(() => page.evaluate(() => PlanAuthority.staleUnfinished().items.map(e => e.item.id))).toContain('a');
    await expect(recovery(page).getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  });
}

test('125 tasks use five-item preview and bounded searchable backlog', async ({ page }) => {
  await seed(page, 'calendar', Array.from({ length: 125 }, (_, i) => item('large-' + i)));
  await expect(recovery(page).locator('[data-pc-stale]')).toHaveCount(5);
  await recovery(page).getByRole('button', { name: /View all/ }).click();
  const dialog=page.getByRole('dialog', { name: 'All unfinished tasks' });
  await expect(dialog.locator('[data-pc-stale]')).toHaveCount(50);
  await dialog.getByRole('button', { name: 'Show 50 more' }).click();
  await expect(dialog.locator('[data-pc-stale]')).toHaveCount(100);
  await dialog.getByRole('searchbox').fill('large-124');
  await expect(dialog.locator('[data-pc-stale]')).toHaveCount(1);
  await expect(dialog).toContainText('large-124');
  await dialog.getByRole('button', { name: 'Close backlog' }).click();
  await expect(recovery(page).locator('[data-pc-stale]')).toHaveCount(5);
});

test('same item id on different days dismisses only the chosen source', async ({ page }) => {
  await seed(page, 'calendar', [item('same', 'Original source')]);
  await page.evaluate(() => {
    CalendarPlanSync.attachPlan('cal1:2026-09-22');
    __fbTest.remoteWrite('rooms/uid_account-a/calendarPlans/cal1:2026-09-22', {
      items: [{ id: 'same', task: 'Other source', kind: 'task', when: '', done: false, updatedAt: 1000, updatedBy: 'other' }],
      updatedAt: 1000, updatedBy: 'other',
    });
  });
  const chosen = recovery(page).locator('[data-pc-stale="same"][data-pc-day="cal1:2026-09-23"]');
  await chosen.getByRole('button', { name: /^More actions:/ }).click();
  await page.getByRole('menuitem', { name: 'Not doing this' }).click();
  await expect(recovery(page)).toContainText('Other source');
  await expect.poll(() => page.evaluate(() => PlanAuthority.staleUnfinished().items.map(e => e.sourceDayId))).toEqual(['cal1:2026-09-22']);
  await recovery(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(recovery(page).locator('[data-pc-stale]')).toHaveCount(2);
});

test('double dismissal and double Undo are single mutations', async ({ page }) => {
  await seed(page);
  await row(page, 'a').getByRole('button', { name: /^More actions:/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Not doing this' })).toBeVisible();
  // Background inspection can replace a Locator.evaluate ElementHandle before its callback runs.
  // Query and double-click the connected control in one turn; the second click still tests one-shot behavior.
  await page.evaluate(() => {
    const button = document.querySelector('[role="menuitem"][data-pc-action="dismiss"]');
    if (!button?.isConnected) throw new Error('Dismiss control is not connected');
    button.click(); button.click();
  });
  const dismissed = await raw(page);
  expect(dismissed.filter(i => i.dismissedAt)).toHaveLength(1);
  await expect(recovery(page).getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const button = document.querySelector('#unfinished-recovery-section [data-pc-action="undo-dismiss"]');
    if (!button?.isConnected) throw new Error('Undo control is not connected');
    button.click(); button.click();
  });
  const restored = await raw(page);
  expect(restored).toHaveLength(2);
  expect(restored.filter(i => i.dismissedAt)).toHaveLength(0);
  expect(restored[0].updatedAt).toBe(dismissed[0].updatedAt + 1);
  expect(restored[1]).toEqual(dismissed[1]);
  await expect(recovery(page).locator('[data-pc-stale]')).toHaveCount(2);
});

test('dismiss → Undo → dismiss at the same clock beats the prior restored revision', async ({ page }) => {
  await seed(page, 'calendar');
  await dismiss(page);
  await recovery(page).getByRole('button', { name: 'Undo', exact: true }).click();
  const restored = await raw(page, 'calendar');
  await dismiss(page);
  expect((await raw(page, 'calendar'))[0].updatedAt).toBeGreaterThan(restored[0].updatedAt);
  await page.evaluate(({ path, items }) => __fbTest.remoteWrite(path, { items, updatedAt: items[0].updatedAt, updatedBy: items[0].updatedBy }), { path: remotePath('calendar'), items: restored });
  await expect(row(page, 'a')).toHaveCount(0);
  expect((await raw(page, 'calendar'))[0].dismissedAt).toBeGreaterThan(1000);
});

test('Undo accepts Firebase null pruning and object key reordering', async ({ page }) => {
  await seed(page, 'calendar');
  await dismiss(page);
  await page.evaluate(path => {
    const record = __fbTest.get(path);
    record.items = record.items.map(item => Object.fromEntries(Object.entries(item).reverse().filter(([, value]) => value !== null)));
    __fbTest.remoteWrite(path, record);
  }, remotePath('calendar'));
  await recovery(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row(page, 'a')).toBeVisible();
});

test('Undo refuses when the unchanged source has a new recovery destination', async ({ page }) => {
  await seed(page, 'calendar');
  await dismiss(page);
  await page.evaluate(() => {
    __fbTest.remoteWrite('rooms/uid_account-a/calendarPlans/cal1:2026-09-27', {
      items: [{ id: 'ocarry1|cal1:2026-09-23|a', task: 'Task a', kind: 'task', when: '', done: false,
        carriedFromId: 'a', carriedFromDayId: 'cal1:2026-09-23', updatedAt: Date.now() + 100, updatedBy: 'device-other' }],
      updatedAt: Date.now() + 100, updatedBy: 'device-other',
    });
  });
  await expect.poll(() => page.evaluate(() => !!PlanAuthority.staleMoveDestination('a', 'cal1:2026-09-23'))).toBe(true);
  await recovery(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(recovery(page)).toContainText('Undo was not applied');
  expect((await raw(page, 'calendar'))[0].dismissedAt).toBeGreaterThan(1000);
});

test('stale rendered dismissal refuses a task already moved by another device', async ({ page }) => {
  await seed(page, 'calendar');
  await row(page, 'a').getByRole('button', { name: /^More actions:/ }).click();
  await page.getByRole('menuitem', { name: 'Not doing this' }).evaluate(button => {
    const refresh = refreshAuthoritativePlanSurfaces;
    globalThis.refreshAuthoritativePlanSurfaces = () => {};
    const entry = PlanAuthority.staleUnfinished().items.find(e => e.item.id === 'a');
    PlanAuthority.moveStaleItem({ sourceTarget: entry.target, itemId: 'a', destination: PlanAuthority.current(), stamp: value => ({ ...value, updatedAt: Date.now(), updatedBy: 'device-other' }) });
    button.click();
    globalThis.refreshAuthoritativePlanSurfaces = refresh;
  });
  expect((await raw(page, 'calendar'))[0].dismissedAt).toBeUndefined();
  await expect(page.locator('#planning-continuity-section')).toContainText('no longer unfinished');
});

test('Undo refuses a changed or remotely moved item without overwriting it', async ({ page }) => {
  await seed(page, 'calendar');
  await dismiss(page);
  await page.evaluate(() => {
    const path = 'rooms/uid_account-a/calendarPlans/cal1:2026-09-23';
    const record = __fbTest.get(path);
    record.items[0] = { ...record.items[0], task: 'Remote edit after dismissal', updatedAt: Date.now() + 100, updatedBy: 'device-other' };
    __fbTest.remoteWrite(path, record);
  });
  await expect.poll(async () => (await raw(page, 'calendar'))[0].task).toBe('Remote edit after dismissal');
  await recovery(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(recovery(page)).toContainText('Undo was not applied');
  expect((await raw(page, 'calendar'))[0]).toMatchObject({ task: 'Remote edit after dismissal', dismissedAt: at(SUN, '11:00') });
});

test('account switch clears dismissal receipt and cannot undo into a matching item in B', async ({ page }) => {
  await seed(page, 'calendar');
  await dismiss(page);
  const a = await raw(page, 'calendar');
  await page.evaluate(() => __fbTest.signInAs('account-b'));
  await page.waitForFunction(() => getChronaSenseRoomCode() === 'uid_account-b');
  await expect(recovery(page)).not.toContainText('Task a');
  await expect(recovery(page).getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => __fbTest.get('rooms/uid_account-b/calendarPlans'))).toBeNull();
  await page.evaluate(() => __fbTest.signInAs('account-a'));
  await page.waitForFunction(() => getChronaSenseRoomCode() === 'uid_account-a');
  expect((await raw(page, 'calendar'))[0].dismissedAt).toBe(a[0].dismissedAt);
  await expect(recovery(page).getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
});

test('two simulated devices receive dismissal and Undo via real calendar sync listeners', async ({ page, browser }) => {
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await seed(page, 'calendar');
    await seed(other, 'calendar');
    await dismiss(page);
    const dismissed = await page.evaluate(path => __fbTest.get(path), remotePath('calendar'));
    await other.evaluate(({ path, record }) => __fbTest.remoteWrite(path, record), { path: remotePath('calendar'), record: dismissed });
    await expect(row(other, 'a')).toHaveCount(0);
    await expect(row(other, 'b')).toBeVisible();
    await recovery(page).getByRole('button', { name: 'Undo', exact: true }).click();
    const restored = await page.evaluate(path => __fbTest.get(path), remotePath('calendar'));
    await other.evaluate(({ path, record }) => __fbTest.remoteWrite(path, record), { path: remotePath('calendar'), record: restored });
    await expect(row(other, 'a')).toBeVisible();
    expect((await raw(other, 'calendar'))[0].done).toBe(false);
  } finally { await context.close(); }
});

test('last dismissal keeps Undo visible with no backlog, reload retains history but expires Undo', async ({ page }) => {
  await seed(page, 'operational', [item('a')]);
  await dismiss(page);
  await expect(recovery(page).getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => !!window.PlanAuthority && !!window.PlanningContinuityUI);
  await expect(recovery(page).getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  expect((await raw(page))[0].dismissedAt).toBeGreaterThan(1000);
  expect((await raw(page))[0].done).toBe(false);
});

for (const width of [360, 390, 1920]) {
  test(`layout ${width}px: readable dates, clamped titles, touch controls and evidence`, async ({ page }) => {
    await page.setViewportSize({ width, height: width > 1000 ? 1080 : 844 });
    await seed(page, 'operational', Array.from({ length: 100 }, (_, n) => item(String(n).padStart(3, '0'), n ? `Previously planned task ${n + 1}` : 'Review the previous project notes and prepare the next practical action with the team '.repeat(4))));
    await expect(row(page, '000')).toContainText(/Planned Sep 23/);
    await expect(row(page, '000').getByRole('button', { name: 'Not doing this' })).toBeHidden();
    // Read the dynamic control set and its geometry in one browser turn.
    const measurements = await page.evaluate(() => [...document.querySelectorAll('#unfinished-recovery-section button, #unfinished-recovery-section summary')]
      .filter(element => element.checkVisibility({ visibilityProperty: true }))
      .map(element => ({
        action: element.dataset.pcAction, id: element.dataset.id, connected: element.isConnected,
        height: element.getBoundingClientRect().height,
      })));
    expect(measurements).toHaveLength(12);
    expect(measurements.filter(control => control.action === 'collapse-stale')).toHaveLength(1);
    expect(measurements.filter(control => control.action === 'view-all-stale')).toHaveLength(1);
    for (const action of ['reveal-stale-title', 'completion-menu']) {
      expect(measurements.filter(control => control.action === action).map(control => control.id).sort()).toEqual(['000', '001', '002', '003', '004']);
    }
    for (const control of measurements) {
      expect(control.connected).toBe(true);
      expect(control.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await fs.mkdir(path.join(APP_ROOT, 'playwright-report', 'task-017'), { recursive: true });
    await recovery(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(APP_ROOT, 'playwright-report', 'task-017', `unfinished-${width}.png`) });
    await row(page, '000').getByRole('button', { name: /^More actions:/ }).click();
    await expect(page.getByRole('menu')).toContainText('keeps its history');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(APP_ROOT, 'playwright-report', 'task-017', `unfinished-more-${width}.png`) });
    // A routine refresh preserves the open disclosure.
    await page.evaluate(() => refreshAuthoritativePlanSurfaces());
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(row(page, '000').getByRole('button', { name: /^More actions:/ })).toHaveAttribute('aria-expanded', 'true');
  });
}
