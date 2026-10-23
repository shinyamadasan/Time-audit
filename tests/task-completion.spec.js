// TASK-017: real UI/authority/sync modules; synthetic accounts and recording Firebase transport.
// The recording transport and account/clock harness match calendar-native-plan-identity.spec.js.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { completionWireValue } from '../task-completion-model.js';
import { createCompletionHandler, hash } from '../functions/src/completion-api.js';

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
  const tree = window.__completionSeed || {};
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
  const user = uid => (uid ? { uid, displayName: uid, email: uid + '@example.test', photoURL: '', getIdToken: async () => uid } : null);
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
  window.firebase = { apps: [], initializeApp(c) { const a = { config: c, options: { projectId: 'offline-task018' } }; this.apps.push(a); return a; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
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

async function seed(page, store = 'calendar', items = [item('a'), item('b')]) {
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

async function backend(page) {
  let persisted = null, mode = 'normal', held = null;
  const domain = {
    read: async uid => {
      const value = await page.evaluate(uid => __fbTest.get('rooms/uid_' + uid), uid);
      return { value: completionWireValue(value), etag: hash(completionWireValue(value)) };
    },
    readResolution: async (uid, key) => page.evaluate(({ uid, key }) => __fbTest.get('rooms/uid_' + uid + '/taskCompletionResolutions/' + key), { uid, key }),
    cas: async (uid, etag, next) => {
      const old = await domain.read(uid); if (old.etag !== etag) return 'changed';
      persisted = next;
      await page.evaluate(({ uid, records }) => __fbTest.remoteWrite('rooms/uid_' + uid + '/taskCompletionResolutions', records), { uid, records: next.taskCompletionResolutions });
      return 'written';
    },
  };
  const handler = createCompletionHandler({ verifyIdToken: async uid => ({ uid }), domain, now: () => at(SUN, '11:00') });
  await page.route('https://asia-southeast1-offline-task018.cloudfunctions.net/chronasenseCompletionApi', async route => {
    const input = route.request().postDataJSON();
    if (mode === 'before' && input.kind === 'mutate') { await route.abort('failed'); return; }
    const response = await handler({ method: 'POST', authorization: route.request().headers().authorization, rawBody: Buffer.from(route.request().postData() || '') });
    if (mode === 'undo-race' && input.kind === 'mutate' && input.request.kind === 'undo' && response.body.outcome === 'CONFIRMED') {
      const { undoOf, ...base } = input.request;
      const next = { ...base, operationId: randomUUID(), kind: 'complete', expectedRevision: response.body.record.revision, date: SUN, timezone: TZ };
      const newer = await handler({ method: 'POST', authorization: route.request().headers().authorization,
        rawBody: Buffer.from(JSON.stringify({ kind: 'mutate', request: next, uncertain: false })) });
      expect(newer.body.outcome).toBe('CONFIRMED'); response.body.record = newer.body.record;
    }
    if (mode === 'hold' && input.kind === 'mutate') await new Promise(resolve => { held = resolve; });
    if (mode === 'after' && input.kind === 'mutate') { await route.abort('failed'); return; }
    await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
  });
  return { mode: value => { mode = value; }, holding: () => !!held, release: () => { const release = held; held = null; release?.(); }, persisted: () => persisted, domain,
    async reload() {
      const tree = { rooms: { [ROOM]: persisted } };
      await page.addInitScript(tree => { window.__completionSeed = tree; }, tree);
      await page.reload(); await page.waitForFunction(() => !!globalThis.TaskCompletions && !!globalThis.PlanAuthority);
    } };
}

const checkbox = (page, id) => row(page, id).getByRole('checkbox');
const toast = page => page.locator('.pc-completion-toast');
const more = (page, id) => row(page, id).getByRole('button', { name: /^More actions:/ });
async function completionReady(page, id = 'a') {
  await expect.poll(() => page.evaluate(id => {
    const entry = PlanAuthority.rawStaleUnfinished().items.find(entry => entry.item.id === id);
    return entry && TaskCompletions.view(entry)?.state;
  }, id)).toBe('unfinished');
}
test('real production UI: today, Undo, Done earlier and history remain distinct', async ({ page }) => {
  await backend(page); await seed(page); await completionReady(page);
  const before = await raw(page, 'calendar');
  await checkbox(page, 'a').click(); await expect(row(page, 'a')).toHaveCount(0); await expect(toast(page)).toContainText('Completion saved');
  expect(await raw(page, 'calendar')).toEqual(before);
  await toast(page).getByRole('button', { name: 'Undo', exact: true }).click(); await expect(row(page, 'a')).toBeVisible();
  await more(page, 'a').click(); await page.getByRole('menuitem', { name: 'Done earlier' }).click();
  await page.getByLabel('Actual completion date').fill('2026-09-25'); await page.getByRole('button', { name: 'Save completion' }).click();
  await expect(row(page, 'a')).toHaveCount(0);
  const records = await page.evaluate(() => __fbTest.get('rooms/uid_account-a/taskCompletionResolutions'));
  const record = Object.values(records)[0]; expect(record.operations[record.completionOpId].date).toBe('2026-09-25');
  expect(await raw(page, 'calendar')).toEqual(before);
});
test('unknown after commit keeps recovery receipt; reload reconstructs confirmed completion', async ({ page }) => {
  const service = await backend(page); await seed(page); await completionReady(page);
  service.mode('after'); await checkbox(page, 'a').click();
  await expect(toast(page)).toContainText('Still checking');
  expect(await page.evaluate(() => TaskCompletions.pendingAll().length)).toBe(1);
  service.mode('normal'); await service.reload();
  await expect.poll(() => page.evaluate(() => PlanAuthority.staleUnfinished().items.map(entry => entry.item.id))).not.toContain('a');
  await toast(page).getByRole('button', { name: 'Check status' }).click();
  await expect.poll(() => page.evaluate(() => TaskCompletions.pendingAll().length)).toBe(0);
});
test('failed request keeps task and original receipt; recovery retries without a second completion', async ({ page }) => {
  const service = await backend(page); await seed(page); await completionReady(page);
  service.mode('before'); await checkbox(page, 'a').click();
  await expect(toast(page)).toContainText('Still checking'); await expect(row(page, 'a')).toBeVisible();
  const original = await page.evaluate(() => TaskCompletions.pendingAll()[0].operationId);
  await more(page, 'a').click(); await expect(page.getByRole('menu')).toContainText('still being checked');
  await expect(page.getByRole('menuitem', { name: 'Move to today' })).toHaveCount(0);
  await page.keyboard.press('Escape'); service.mode('normal');
  await toast(page).getByRole('button', { name: 'Check status' }).click();
  await expect(row(page, 'a')).toHaveCount(0);
  const records = await page.evaluate(() => __fbTest.get('rooms/uid_account-a/taskCompletionResolutions'));
  expect(Object.values(records)[0].completionOpId).toBe(original); expect(Object.values(records)[0].revision).toBe(1);
});
test('Undo refuses a newer remote edit and keeps completion provenance', async ({ page }) => {
  await backend(page); await seed(page); await completionReady(page);
  await checkbox(page, 'a').click(); await expect(toast(page)).toContainText('Completion saved');
  await page.evaluate(path => {
    const plan = __fbTest.get(path); plan.items[0] = { ...plan.items[0], task: 'Unseen newer edit', updatedAt: 2000, updatedBy: 'remote' };
    plan.updatedAt = 2000; __fbTest.remoteWrite(path, plan);
  }, remotePath('calendar'));
  await toast(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(toast(page)).toContainText('Undo refused');
  const records = await page.evaluate(() => __fbTest.get('rooms/uid_account-a/taskCompletionResolutions'));
  expect(Object.values(records)[0].state).toBe('completed'); expect(Object.values(records)[0].revision).toBe(1);
  expect((await raw(page, 'calendar'))[0].task).toBe('Unseen newer edit');
});
test('an acknowledged Undo superseded by a concurrent completion reports current status honestly', async ({ page }) => {
  const service = await backend(page); await seed(page); await completionReady(page);
  await checkbox(page, 'a').click(); await expect(toast(page)).toContainText('Completion saved');
  service.mode('undo-race'); await toast(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(toast(page)).toContainText('Undo recorded · status refreshed');
  await expect(row(page, 'a')).toHaveCount(0);
  const records = await page.evaluate(() => __fbTest.get('rooms/uid_account-a/taskCompletionResolutions'));
  expect(Object.values(records)[0].state).toBe('completed'); expect(Object.values(records)[0].revision).toBe(3);
});
test('account switch while response is held cannot expose A completion feedback or mutate B', async ({ page }) => {
  const service = await backend(page); await seed(page); await completionReady(page); service.mode('hold');
  await checkbox(page, 'a').click(); await expect.poll(() => service.persisted()?.taskCompletionResolutions != null).toBe(true);
  await page.evaluate(() => __fbTest.signInAs('account-b')); service.release();
  await expect.poll(() => page.evaluate(() => globalThis.getChronaSenseRoomCode?.())).toBe('uid_account-b');
  await expect(toast(page)).toHaveCount(0);
  expect(await page.evaluate(() => __fbTest.get('rooms/uid_account-b/taskCompletionResolutions'))).toBeNull();
  expect(await page.evaluate(() => TaskCompletions.pendingAll().length)).toBe(0);
});
test('backlog keyboard focus survives remote refresh and completion uses one Space action', async ({ page }) => {
  await backend(page); await seed(page, 'calendar', Array.from({ length: 22 }, (_, i) => item('key-' + i))); await completionReady(page, 'key-0');
  await recovery(page).getByRole('button', { name: /View all/ }).click();
  const dialog = page.getByRole('dialog', { name: 'All unfinished tasks' });
  const title = dialog.locator('[data-pc-stale="key-0"] .pc-complete-title'); await title.focus();
  await page.evaluate(() => refreshAuthoritativePlanSurfaces()); await expect(title).toBeFocused();
  const check = dialog.locator('[data-pc-stale="key-0"]').getByRole('checkbox'); await check.focus(); await page.keyboard.press('Space');
  await expect(dialog.locator('[data-pc-stale="key-0"]')).toHaveCount(0);
  await expect(dialog.locator('.pc-complete-more').first()).toBeFocused();
  await page.keyboard.press('Enter'); await expect(dialog.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowDown'); await expect(dialog.getByRole('menuitem', { name: 'Move to today', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog.locator('.pc-complete-more').first()).toBeFocused();
});
for (const width of [390, 1440]) test('approved Refined A evidence ' + width, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await backend(page);
  const names = ['Open play', 'Start AI automation project', 'Tara AI community — 1 hr', 'Fix business dashboard', 'Client follow-up',
    'Review the volunteer roster and confirm availability with every team lead before the weekend workshop'];
  const tasks = Array.from({ length: 22 }, (_, i) => item('task-' + String(i).padStart(2, '0'), names[i] || 'Prepare project follow-up ' + (i + 1)));
  await seed(page, 'calendar', tasks); await completionReady(page, 'task-00');
  await page.evaluate(() => {
    const target = PlanAuthority.current();
    CalendarPlanSync.attachPlan(target.id);
    __fbTest.remoteWrite('rooms/uid_account-a/calendarPlans/' + target.id, { items: [
      { id: 'today-a', task: 'Review client proposal', kind: 'priority', when: '09:00', whenTz: 'Asia/Manila', done: false, updatedAt: 1000, updatedBy: 'fixture' },
      { id: 'today-b', task: 'Prepare workshop materials', kind: 'task', when: '13:00', whenTz: 'Asia/Manila', done: false, updatedAt: 1000, updatedBy: 'fixture' }
    ], updatedAt: 1000, updatedBy: 'fixture' });
    refreshAuthoritativePlanSurfaces();
  });
  await expect(recovery(page).locator('.pc-completion-row')).toHaveCount(5);
  await completionReady(page, 'task-00');
  await expect(page.locator('[data-plan-item-id="today-a"]').first()).toBeVisible();
  const height = await recovery(page).evaluate(el => Math.round(el.getBoundingClientRect().height));
  expect(height).toBeLessThan(400);
  const targets = await recovery(page).locator('.pc-complete-target,.pc-complete-title,.pc-complete-more').evaluateAll(els => els.map(el => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })));
  expect(targets.every(box => box.w >= 44 && box.h >= 44)).toBe(true);
  await fs.mkdir(path.join(APP_ROOT, 'playwright-report/task-018-production'), { recursive: true });
  const shot = name => page.screenshot({ path: path.join(APP_ROOT, 'playwright-report/task-018-production/' + width + '-' + name + '.png'), fullPage: false });
  await page.setViewportSize({ width, height: await page.evaluate(() => document.documentElement.scrollHeight) });
  await shot('my-day');
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await recovery(page).evaluate(el => el.scrollIntoView({ block: 'center' })); await page.screenshot({ path: path.join(APP_ROOT, 'playwright-report/task-018-production/' + width + '-preview-viewport.png') });
  await more(page, 'task-00').click(); await shot('menu');
  await page.getByRole('menuitem', { name: 'Done earlier' }).click(); await shot('date'); await page.keyboard.press('Escape');
  await recovery(page).getByRole('button', { name: /View all/ }).click();
  await expect(page.getByRole('dialog', { name: 'All unfinished tasks' }).locator('.pc-completion-row')).toHaveCount(22);
  const box = await page.getByRole('dialog', { name: 'All unfinished tasks' }).boundingBox();
  expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
  await shot('backlog'); await page.getByRole('searchbox', { name: 'Search unfinished tasks' }).fill('volunteer');
  await expect(page.getByRole('dialog', { name: 'All unfinished tasks' }).locator('.pc-completion-row')).toHaveCount(1);
  const title = page.getByRole('button', { name: /^Review the volunteer/ }); await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'true'); await expect(title).toBeFocused();
  expect(await page.evaluate(() => __fbTest.get('rooms/uid_account-a/taskCompletionResolutions'))).toBeNull();
  await shot('search-long-title');
  await fs.writeFile(path.join(APP_ROOT, 'playwright-report/task-018-production/' + width + '-metrics.json'), JSON.stringify({ width, sectionHeight: height, rows: 5, targets, interactions: { today: 1, earlier: 'More + Done earlier + date + Save (4 controls)', backlogSearch: 'View all + type' } }, null, 2));
});

// O1 regression (found by the Day 1 production canary): before this, Undo existed only inside the
// temporary notice. Once it expired the task was suppressed from Unfinished and the completion
// became unreachable -- irreversible in the UI although the backend still supported undo.
const completedList = page => recovery(page).locator('.pc-completed-row');
test('O1: a completion stays undoable from the durable Completed list after reload, keeping its receipt', async ({ page }) => {
  const service = await backend(page); await seed(page); await completionReady(page);
  await checkbox(page, 'a').click();
  await expect(row(page, 'a')).toHaveCount(0);
  await expect(toast(page)).toContainText('Completion saved');

  // Reload: the temporary notice and its Undo are gone for good.
  await service.reload(); await completionReady(page, 'b');
  await expect(toast(page).getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);

  // The durable list is discoverable, collapsed, and counts the resolved task.
  const trigger = recovery(page).getByRole('button', { name: /^Completed/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(completedList(page)).toHaveCount(1);
  await expect(completedList(page)).toContainText('Task a');

  // 44px touch target, per the Refined A contract.
  const undo = recovery(page).getByRole('button', { name: 'Undo completion: Task a' });
  const box = await undo.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);

  await undo.click();
  // The resolution is reversed: the task is unfinished again and leaves the Completed list.
  await expect.poll(() => page.evaluate(() => PlanAuthority.staleUnfinished().items.map(entry => entry.item.id)))
    .toContain('a');
  await expect(completedList(page)).toHaveCount(0);
  // Unfinished renders collapsed after a reload; expanding it shows the restored row.
  await recovery(page).getByRole('button', { name: /^Unfinished/ }).click();
  await expect(row(page, 'a')).toBeVisible();

  // The original completion receipt survives the undo: state open, revision 2, BOTH operations.
  const records = await page.evaluate(() => __fbTest.get('rooms/uid_account-a/taskCompletionResolutions'));
  const record = Object.values(records)[0];
  expect(record.state).toBe('open');
  expect(record.revision).toBe(2);
  expect(Object.keys(record.operations)).toHaveLength(2);
  const kinds = Object.values(record.operations).map(op => op.kind).sort();
  expect(kinds).toEqual(['complete', 'undo']);
});
test('O1: an Undo committed without acknowledgement recovers its receipt after reload', async ({ page }) => {
  const service = await backend(page); await seed(page); await completionReady(page);
  const before = await raw(page, 'calendar');
  await checkbox(page, 'a').click(); await expect(toast(page)).toContainText('Completion saved');
  await recovery(page).getByRole('button', { name: /^Completed/ }).click();
  service.mode('after');
  await recovery(page).getByRole('button', { name: 'Undo completion: Task a' }).click();
  await expect(toast(page)).toContainText('Undo still checking');
  const pending = await page.evaluate(() => TaskCompletions.pendingAll());
  expect(pending).toHaveLength(1);
  expect(pending[0].kind).toBe('undo');

  service.mode('normal'); await service.reload(); await completionReady(page);
  await toast(page).getByRole('button', { name: 'Check status' }).click();
  await expect.poll(() => page.evaluate(() => TaskCompletions.pendingAll().length)).toBe(0);
  const records = await page.evaluate(() => __fbTest.get('rooms/uid_account-a/taskCompletionResolutions'));
  const record = Object.values(records)[0];
  expect(record.state).toBe('open');
  expect(record.revision).toBe(2);
  expect(Object.keys(record.operations)).toHaveLength(2);
  expect(record.operations[pending[0].operationId].kind).toBe('undo');
  // Reload uses Firebase wire form, where null properties are absent.
  expect(completionWireValue(await raw(page, 'calendar'))).toEqual(completionWireValue(before));
});

test('O1: the durable Completed list never offers Undo for a task whose source changed', async ({ page }) => {
  const service = await backend(page); await seed(page); await completionReady(page);
  await checkbox(page, 'a').click(); await expect(toast(page)).toContainText('Completion saved');
  await service.reload(); await completionReady(page, 'b');
  // A newer remote edit to the source makes the resolution needs-review, not completed.
  await page.evaluate(path => __fbTest.remoteWrite(path, { items: [
    { id: 'a', task: 'Task a edited elsewhere', kind: 'task', when: '', done: false, doneAt: null, updatedAt: 9000, updatedBy: 'other-device' },
    { id: 'b', task: 'Task b', kind: 'task', when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'device-original' },
  ], updatedAt: 9000, updatedBy: 'other-device' }), remotePath('calendar'));
  await expect.poll(() => page.evaluate(() => {
    const entry = PlanAuthority.rawStaleUnfinished().items.find(entry => entry.item.id === 'a');
    return entry && TaskCompletions.view(entry)?.state;
  })).not.toBe('completed');
  // Expand first: asserting absence on a COLLAPSED list would pass for the wrong reason.
  const trigger = recovery(page).getByRole('button', { name: /^Completed/ });
  if (await trigger.count()) await trigger.click();
  await expect(recovery(page).getByRole('button', { name: 'Undo completion: Task a' })).toHaveCount(0);
});

test('O1: an uncertain Undo resumes the same operation from Completed after reload', async ({ page }) => {
  const service = await backend(page); await seed(page); await completionReady(page);
  const before = await raw(page, 'calendar');
  await checkbox(page, 'a').click(); await expect(toast(page)).toContainText('Completion saved');
  await recovery(page).getByRole('button', { name: /^Completed/ }).click();
  service.mode('before');
  await recovery(page).getByRole('button', { name: 'Undo completion: Task a' }).click();
  await expect(toast(page)).toContainText('Undo still checking');
  const pending = await page.evaluate(() => TaskCompletions.pendingAll());
  expect(pending).toHaveLength(1);
  expect(pending[0].kind).toBe('undo');

  service.mode('normal'); await service.reload(); await completionReady(page, 'b');
  await recovery(page).getByRole('button', { name: /^Completed/ }).click();
  await recovery(page).getByRole('button', { name: /^(Undo completion|Check status): Task a$/ }).click();
  await expect.poll(() => page.evaluate(() => TaskCompletions.pendingAll().length)).toBe(0);
  await expect.poll(() => page.evaluate(() => PlanAuthority.staleUnfinished().items.map(entry => entry.item.id))).toContain('a');
  const records = await page.evaluate(() => __fbTest.get('rooms/uid_account-a/taskCompletionResolutions'));
  const record = Object.values(records)[0];
  expect(record.state).toBe('open');
  expect(record.revision).toBe(2);
  expect(Object.keys(record.operations)).toHaveLength(2);
  expect(record.operations[pending[0].operationId].kind).toBe('undo');
  expect(completionWireValue(await raw(page, 'calendar'))).toEqual(completionWireValue(before));
});

// O2 regression (found by the Day 1 production canary): after a network drop every row showed
// "Changed or ambiguous" and never recovered until a full reload. A failed inspection with the
// watch intact leaves the candidate signature unchanged, so ensure() is a no-op. Permission
// cancellations deliberately remain fail-closed until rebind; they are not network disconnects.
const ENDPOINT = 'https://asia-southeast1-offline-task018.cloudfunctions.net/chronasenseCompletionApi';

test('normal completion and persistent Undo show saving without recovery controls or duplicate requests', async ({ page }) => {
  const api = await backend(page); await seed(page); await completionReady(page);
  api.mode('hold');
  await checkbox(page, 'a').click();
  await expect(toast(page)).toHaveText('Saving…');
  await expect(toast(page).getByRole('button', { name: 'Check status' })).toHaveCount(0);
  await expect(checkbox(page, 'a')).toBeDisabled();
  await expect.poll(() => api.holding()).toBe(true);
  api.release(); await expect(toast(page)).toContainText('Completion saved');
  await recovery(page).getByRole('button', { name: /^Completed/ }).click();
  await recovery(page).getByRole('button', { name: 'Undo completion: Task a' }).click({ clickCount: 2, delay: 10 });
  await expect(toast(page)).toHaveText('Saving…');
  await expect(recovery(page).getByRole('button', { name: 'Check status: Task a' })).toHaveCount(0);
  await expect(recovery(page).locator('[data-pc-completed="a"] .pc-completed-undo:not(:disabled)')).toHaveCount(0);
  await expect.poll(() => api.holding()).toBe(true);
  api.release(); await expect(toast(page)).toContainText('Completion undone');
  const records = Object.values(api.persisted().taskCompletionResolutions);
  expect(records).toHaveLength(1); expect(Object.keys(records[0].operations)).toHaveLength(2);
});

test('known offline click refuses before staging; online refresh restores a usable row', async ({ page }) => {
  await backend(page); await seed(page); await completionReady(page);
  let requests = 0;
  page.on('request', request => { if (request.url() === ENDPOINT) requests++; });
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }));
  const before = requests;
  await checkbox(page, 'a').click(); await expect(toast(page)).toContainText('Not saved · SOURCE_UNAVAILABLE');
  expect(requests).toBe(before);
  expect(await page.evaluate(() => TaskCompletions.pendingAll())).toEqual([]);
  await expect(row(page, 'a')).toBeVisible();
  await page.evaluate(() => { delete navigator.onLine; dispatchEvent(new Event('online')); });
  await completionReady(page);
});

test('global recovery checks the inactive uncertain command while another command is active', async ({ page }) => {
  const api = await backend(page); await seed(page); await completionReady(page); await completionReady(page, 'b');
  api.mode('before');
  await checkbox(page, 'a').click(); await expect(toast(page)).toContainText('Still checking');
  await checkbox(page, 'b').click();
  await expect.poll(() => page.evaluate(() => TaskCompletions.pendingAll().length)).toBe(2);
  const [active, inactive] = await page.evaluate(() => TaskCompletions.pendingAll().map(request => request.identity.itemId));
  api.mode('normal');
  let release;
  await page.route(ENDPOINT, async route => {
    const input = route.request().postDataJSON();
    if (input.kind === 'status' && input.request.identity.itemId === active) await new Promise(resolve => { release = resolve; });
    await route.fallback();
  });
  try {
    await row(page, active).getByRole('button', { name: 'Still checking · Retry' }).click();
    await expect.poll(() => !!release).toBe(true);
    await expect(toast(page)).toContainText('A previous change is still being checked');
    await toast(page).getByRole('button', { name: 'Check status' }).click();
    await expect.poll(() => page.evaluate(() => TaskCompletions.pendingAll().map(request => request.identity.itemId))).toEqual([active]);
    await expect(row(page, inactive)).toHaveCount(0);
  } finally { release?.(); }
  await expect.poll(() => page.evaluate(() => TaskCompletions.pendingAll().length)).toBe(0);
});
test('O2: reconnect re-verifies without a reload, even though the watch never failed', async ({ page }) => {
  await backend(page); await seed(page); await completionReady(page);
  const state = () => page.evaluate(() => {
    const entry = PlanAuthority.rawStaleUnfinished().items.find(entry => entry.item.id === 'a');
    return entry && TaskCompletions.view(entry)?.state;
  });

  // The endpoint goes away and a re-inspection fails: verification is lost, fail-closed.
  const offline = route => route.abort('failed');
  await page.route(ENDPOINT, offline);
  await page.evaluate(() => TaskCompletions.refresh());
  await expect.poll(state).not.toBe('unfinished');

  // Connectivity returns. A plain re-render is NOT enough: the candidate signature is unchanged
  // and the watch never failed, so ensure() short-circuits and nothing re-inspects.
  await page.unroute(ENDPOINT, offline);
  await page.evaluate(() => globalThis.PlanningContinuityUI.render());
  await page.waitForTimeout(500);
  expect(await state()).not.toBe('unfinished');

  // The 'online' handler re-inspects explicitly. No reload.
  await page.evaluate(() => globalThis.dispatchEvent(new Event('online')));
  await expect.poll(state).toBe('unfinished');
});

// Closes two coverage gaps an independent review found by mutation: (1) the handler used the
// clicked row's data-id, but nothing proved it - undoing "the first completed task" instead
// passed every test; (2) nothing exercised escaping in the new template.
test('O1: Undo in the Completed list acts on the clicked row, not merely the first one', async ({ page }) => {
  await backend(page); await seed(page); await completionReady(page); await completionReady(page, 'b');
  await checkbox(page, 'a').click(); await expect(row(page, 'a')).toHaveCount(0);
  await checkbox(page, 'b').click(); await expect(row(page, 'b')).toHaveCount(0);

  await recovery(page).getByRole('button', { name: /^Completed/ }).click();
  await expect(recovery(page).locator('.pc-completed-row')).toHaveCount(2);

  // Undo ONLY Task b -- deliberately NOT the first row. The fixture's server clock is fixed, so
  // both receipts share recordedAt and completedEntries()[0] is Task a; undoing Task a could not
  // tell "the row I clicked" apart from "the first completed row".
  await recovery(page).getByRole('button', { name: 'Undo completion: Task b' }).click();
  await expect.poll(() => page.evaluate(() => PlanAuthority.staleUnfinished().items.map(e => e.item.id)))
    .toEqual(['b']);
  const records = await page.evaluate(() => __fbTest.get('rooms/uid_account-a/taskCompletionResolutions'));
  const byItem = Object.fromEntries(Object.values(records).map(r => [r.identity.itemId, r]));
  expect(byItem.b.state).toBe('open');
  expect(byItem.a.state).toBe('completed');
  expect(Object.keys(byItem.b.operations)).toHaveLength(2);
  expect(Object.keys(byItem.a.operations)).toHaveLength(1);
  // And the still-resolved row keeps its Undo affordance.
  await expect(recovery(page).getByRole('button', { name: 'Undo completion: Task a' })).toBeVisible();
});
test('O1: the Completed list escapes task titles', async ({ page }) => {
  await backend(page); await seed(page, 'calendar', [item('a', '<img src=x onerror="window.__xss=1">'), item('b')]);
  await completionReady(page);
  await checkbox(page, 'a').click(); await expect(row(page, 'a')).toHaveCount(0);
  await recovery(page).getByRole('button', { name: /^Completed/ }).click();
  const rowEl = recovery(page).locator('.pc-completed-row');
  await expect(rowEl).toHaveCount(1);
  await expect(rowEl).toContainText('<img src=x onerror=');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await rowEl.locator('img').count()).toBe(0);
});
