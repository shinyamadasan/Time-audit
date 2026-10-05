// Calendar-Native Plan Identity V1 — production-equivalent browser coverage.
//
// The page loads the app's REAL modules through the import map; the only fakes are Firebase (a
// recording in-memory stub whose auth can be switched, whose writes can be made to fail, and into
// which "another device" can write) and the clock (frozen, movable with window.__setNow).
//
// The definitive scenario (§9): Asia/Manila, a LEGACY Personal Day boundary of 18:00, the clock at
// Sunday 2026-09-27 11:00 — no waiting until 18:00.

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
const MON = '2026-09-28';
const TOKEN = '20261005-location-bound-fence-v1';

const BOUNDARY_ID = 'r-1800';
const boundaryStore = () => JSON.stringify({ schemaVersion: 1, revisions: {
  'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
  [BOUNDARY_ID]: { id: BOUNDARY_ID, boundaryTime: '18:00', timezone: TZ, effectiveFromInstant: at('2026-09-01', '18:00') },
} });
// The personal day that is "current" at Sunday 11:00 under an 18:00 boundary is SATURDAY's: Sat 18:00 -> Sun 18:00.
const SATURDAY_DAY_ID = `odv1:${BOUNDARY_ID}:${TZ}:2026-09-26`;
const saturdayOperationalPlans = () => JSON.stringify({ schemaVersion: 1, plans: {
  [SATURDAY_DAY_ID]: {
    items: [
      { id: 'sat-a', task: 'Saturday-window errand', when: '09:00', done: false, updatedAt: 1000, updatedBy: 'device-a' },
      { id: 'sat-b', task: 'Saturday-window report', when: '', done: false, updatedAt: 1000, updatedBy: 'device-a' },
    ],
    updatedAt: 1000, updatedBy: 'device-a',
  },
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
async function openApp(page, { now, boundary = true, operationalPlans = null, legacyPlans = '{}', delayAuthority = false } = {}) {
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

/** Moves the frozen clock and makes every surface re-derive from it (what the 60s tick does). */
async function setClock(page, ms) {
  await page.evaluate(value => {
    window.__setNow(value);
    window.PlanAuthority.invalidate();
    globalThis.CalendarPlanLive.tick();
    globalThis.refreshOnPersonalDayRollover?.();
    globalThis.renderTodayOnDateChange?.();
    globalThis.refreshAuthoritativePlanSurfaces();
  }, ms);
}

async function switchToCalendarPlans(page) {
  await page.locator('#calendar-plan-section [data-cp-action="ask"]').click();
  await page.locator('#calendar-plan-section [data-cp-action="confirm"]').click();
  await page.waitForFunction(() => window.PlanAuthority.calendarActive());
}

const calendarStore = page => page.evaluate(() => JSON.parse(localStorage.getItem('ta3-calendar-plans-v1:uid_account-a') || '{"plans":{}}').plans);
const current = page => page.evaluate(() => { const t = window.PlanAuthority.current(); return { store: t.store, id: t.id, dateKey: t.dateKey || null }; });
const upcoming = page => page.evaluate(() => { const t = window.PlanAuthority.upcoming(); return { store: t.store, id: t.id, dateKey: t.dateKey || null }; });
const rawLegacy = page => page.evaluate(() => ({ ops: localStorage.getItem('ta3-operational-plans-v1:uid_account-a'), plans: localStorage.getItem('ta3-plans:uid_account-a') }));

/** Adds a Top Priority (default) or an "other planned task" through Today's own strip. */
async function addToStrip(page, { task, when = '', nextDay = false, kind = 'priority' }) {
  // Today keeps its plan pane collapsed by default; the other specs open it the same way.
  await page.evaluate(() => { document.getElementById('today-commitments').hidden = false; });
  const strip = page.locator('#plan-strip');
  if (!(await strip.getAttribute('class') || '').includes('editing')) await strip.getByRole('button', { name: 'Edit', exact: true }).click();
  const ids = kind === 'task' ? { when: '#plan-task-when', next: '#plan-task-when-next', task: '#plan-task-task' } : { when: '#plan-when', next: '#plan-when-next', task: '#plan-task' };
  if (when) await page.locator(ids.when).fill(when);
  if (nextDay) await page.locator(ids.next).check();
  await page.locator(ids.task).fill(task);
  if (kind === 'task') await strip.getByRole('button', { name: 'Plan task', exact: true }).click();
  else await strip.locator('.plan-add').getByRole('button', { name: 'Add', exact: true }).click();
}

async function prepareViaPlanTomorrow(page, { target = null, tasks }) {
  await page.evaluate(explicit => (explicit ? window.openPlanTomorrow({ target: window.PlanAuthority.current() }) : window.openPlanTomorrow()), !!target);
  for (const task of tasks) {
    await page.locator('#plan-tomorrow-add input[name="task"]').fill(task);
    await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  }
  await page.locator('#plan-tomorrow-confirm').click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
}

// ═══════════════════════════════════════════════════════════════════════════
// §9 — the literal Sunday 11:00 / 18:00 legacy boundary scenario
// ═══════════════════════════════════════════════════════════════════════════

test('BEFORE switching: Sunday 11:00 under the 18:00 boundary is still the legacy personal day, and the switch is offered', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00'), operationalPlans: saturdayOperationalPlans() });
  const now = await current(page);
  expect(now.store).toBe('operational');
  expect(now.id).toBe(SATURDAY_DAY_ID);
  await expect(page.locator('#calendar-plan-section')).toBeVisible();
  await expect(page.locator('#calendar-plan-section')).toContainText('Use calendar-day plans');
  // Asking is not switching: nothing changes until the second confirmation.
  await page.locator('#calendar-plan-section [data-cp-action="ask"]').click();
  await expect(page.locator('#calendar-plan-section')).toContainText('can\'t be switched back');
  await expect(page.locator('#calendar-plan-section')).toContainText('Update all devices');
  await expect(page.locator('#calendar-plan-section')).toContainText('Older versions');
  await page.locator('#calendar-plan-section [data-cp-action="cancel"]').click();
  expect(await page.evaluate(() => window.PlanAuthority.calendarActive())).toBe(false);
  expect(await calendarStore(page)).toEqual({});
});

test('delayed authority hydration is fail-closed: no legacy fallback or write occurs before the account answer arrives', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00'), operationalPlans: saturdayOperationalPlans(), delayAuthority: true });
  expect(await page.evaluate(() => window.PlanAuthority.authorityState())).toBe('unknown');
  expect(await page.evaluate(() => window.PlanAuthority.current())).toBeNull();
  await expect(page.locator('#calendar-plan-section')).toContainText('Syncing plan authority');

  const legacyBefore = await rawLegacy(page);
  const attempt = await page.evaluate(() => {
    try {
      window.PlanAuthority.saveItems(window.PlanAuthority.legacyTarget('2026-09-27'), [
        { id: 'must-not-land', task: 'Blocked while syncing', when: '', done: false },
      ]);
      return { threw: false };
    } catch (error) {
      return { threw: true, message: String(error?.message || error) };
    }
  });
  expect(attempt).toMatchObject({ threw: true });
  expect(attempt.message).toContain('still syncing');
  expect(await rawLegacy(page)).toEqual(legacyBefore);
  expect(await page.evaluate(() => window.__fbTest.log.writes.filter(w => /\/plans(?:\/|$)|\/operationalPlans(?:\/|$)/.test(w.path)).length)).toBe(0);

  const fact = { schemaVersion: 1, id: 'ca1-hydrated', activatedAtMs: at(SUN, '09:00'), timezone: TZ, activationDate: SUN, deviceId: 'device-other' };
  await page.evaluate(value => {
    window.__fbTest.seed('rooms/uid_account-a/calendarPlanAuthority/ca1-hydrated', value);
    window.__fbTest.deliverAuthority();
  }, fact);
  await expect.poll(() => page.evaluate(() => window.PlanAuthority.authorityState())).toBe('calendar');
  expect(await current(page)).toEqual({ store: 'calendar', id: `cal1:${SUN}`, dateKey: SUN });
  await page.evaluate(() => {
    const target = window.PlanAuthority.current();
    window.PlanAuthority.saveItems(target, [{ id: 'after-hydration', task: 'Calendar write only', when: '11:30', whenTz: target.timezone, done: false }]);
  });
  await expect.poll(async () => (await calendarStore(page))[`cal1:${SUN}`]?.items?.[0]?.task).toBe('Calendar write only');
  expect(await rawLegacy(page)).toEqual(legacyBefore);
});

test('Sunday 11:00: after switching, the current plan is SUNDAY\'s; a first item at 11:00 writes ONLY Sunday\'s calendar plan; the legacy Saturday plan gets zero writes', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00'), operationalPlans: saturdayOperationalPlans() });
  const legacyBefore = await rawLegacy(page);
  await switchToCalendarPlans(page);
  const legacyWritesAtSwitch = await page.evaluate(() => window.__fbTest.log.writes.filter(w => w.path.includes('operationalPlans')).length);

  expect(await current(page)).toEqual({ store: 'calendar', id: `cal1:${SUN}`, dateKey: SUN });
  expect(await upcoming(page)).toEqual({ store: 'calendar', id: `cal1:${MON}`, dateKey: MON });

  await addToStrip(page, { task: 'Sunday morning priority', when: '11:00' });
  await expect(page.locator('#plan-strip .plan-item').first()).toContainText('Sunday morning priority');
  await expect(page.locator('#plan-strip .plan-item').first().locator('.plan-when')).toHaveText('11:00 AM →');

  const plans = await calendarStore(page);
  expect(Object.keys(plans)).toEqual([`cal1:${SUN}`]);
  const [first] = plans[`cal1:${SUN}`].items;
  expect(first).toMatchObject({ task: 'Sunday morning priority', when: '11:00', whenTz: TZ });
  expect(first.whenDayOffset).toBeUndefined();
  expect(await page.evaluate(() => { const t = window.PlanAuthority.current(); return window.PlanAuthority.itemInstants(t, window.PlanAuthority.items(t)[0]).startMs; })).toBe(at(SUN, '11:00'));

  expect(await rawLegacy(page)).toEqual(legacyBefore);
  const writes = await page.evaluate(() => window.__fbTest.log.writes.map(w => w.path));
  // The app's ordinary re-push of the pre-existing legacy record may have happened at load; what must
  // not exist is ANY legacy write caused by planning after the switch, or legacy content that is new.
  expect(writes.filter(p => p.includes('operationalPlans')).length).toBe(legacyWritesAtSwitch);
  const legacyContent = await page.evaluate(() => JSON.stringify(window.__fbTest.log.writes.filter(w => w.path.includes('operationalPlans')).map(w => w.value)));
  expect(legacyContent).not.toContain('Sunday morning priority');
  expect(writes.some(p => p.includes(`calendarPlans/cal1:${SUN}`))).toBe(true);
  // The cutover survives a reload (and is synchronously readable, so the first paint agrees).
  await page.reload();
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object' && window.PlanAuthority.calendarActive());
  expect(await current(page)).toEqual({ store: 'calendar', id: `cal1:${SUN}`, dateKey: SUN });
  await expect(page.locator('#plan-strip')).toContainText('Sunday morning priority');
});

test('direct date navigation remains calendar-date-primary after switching to calendar plans', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  await switchToCalendarPlans(page);
  await page.evaluate(() => {
    const target = window.PlanAuthority.dayForCalendarDate('2026-09-28');
    window.PlanAuthority.confirmPreparation(target, {
      items: [{ id: 'monday-identity-proof', task: 'Monday identity proof', when: '', done: false, doneAt: null, updatedAt: 123456789, updatedBy: 'device-cnpi' }],
      mode: 'normal', intentionalBlank: false, routineInstanceIds: [],
    });
  });
  const plansBefore = await page.evaluate(() => localStorage.getItem('ta3-calendar-plans-v1:uid_account-a'));
  const writesBefore = await page.evaluate(() => window.__fbTest.log.writes.length);
  await page.locator('#my-day-calendar').evaluate(input => {
    input.value = '2026-09-28';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#timeline-date-label')).toHaveText("Monday, Sep 28's timeline");
  expect(await page.evaluate(() => {
    const target = window.PlanAuthority.dayForCalendarDate('2026-09-28');
    return { id: target.id, store: target.store, dateKey: target.dateKey };
  })).toEqual({ id: 'cal1:2026-09-28', store: 'calendar', dateKey: '2026-09-28' });
  await expect(page.locator('#timeline-anytime')).toContainText('Monday identity proof');
  expect(await page.evaluate(() => localStorage.getItem('ta3-calendar-plans-v1:uid_account-a'))).toBe(plansBefore);
  expect(await page.evaluate(() => window.__fbTest.log.writes.length)).toBe(writesBefore);
});

test('delayed authority hydration and midnight cannot leave a selected date attached to a different target', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00'), operationalPlans: saturdayOperationalPlans(), delayAuthority: true });
  await page.evaluate(() => window.__fbTest.deliverAuthority());
  await expect.poll(() => page.evaluate(() => window.PlanAuthority.authorityState())).toBe('legacy');
  const storesBefore = await page.evaluate(() => ({
    legacy: localStorage.getItem('ta3-plans:uid_account-a'),
    operational: localStorage.getItem('ta3-operational-plans-v1:uid_account-a'),
    calendar: localStorage.getItem('ta3-calendar-plans-v1:uid_account-a'),
  }));
  const planWritesBefore = await page.evaluate(() => window.__fbTest.log.writes.filter(write => /\/(?:plans|operationalPlans|calendarPlans)(?:\/|$)/.test(write.path)).length);
  await page.locator('#my-day-calendar').evaluate(input => {
    input.value = '2026-09-27';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const selectedId = await page.evaluate(() => window.currentMyDayTimelineTarget().id);
  expect(selectedId).toBe(SATURDAY_DAY_ID);
  expect(await page.evaluate(() => ({
    legacy: localStorage.getItem('ta3-plans:uid_account-a'),
    operational: localStorage.getItem('ta3-operational-plans-v1:uid_account-a'),
    calendar: localStorage.getItem('ta3-calendar-plans-v1:uid_account-a'),
  }))).toEqual(storesBefore);
  expect(await page.evaluate(() => window.__fbTest.log.writes.filter(write => /\/(?:plans|operationalPlans|calendarPlans)(?:\/|$)/.test(write.path)).length)).toBe(planWritesBefore);

  const fact = { schemaVersion: 1, id: 'ca1-hydrated-label', activatedAtMs: at(SUN, '09:00'), timezone: TZ, activationDate: SUN, deviceId: 'device-other' };
  await page.evaluate(value => window.__fbTest.remoteWrite('rooms/uid_account-a/calendarPlanAuthority/ca1-hydrated-label', value), fact);
  await expect.poll(() => page.evaluate(() => window.PlanAuthority.authorityState())).toBe('calendar');
  await page.evaluate(() => window.refreshAuthoritativePlanSurfaces());
  expect(await current(page)).toEqual({ store: 'calendar', id: `cal1:${SUN}`, dateKey: SUN });
  await page.evaluate(() => {
    const target = window.PlanAuthority.dayForCalendarDate('2026-09-28');
    window.PlanAuthority.saveItems(target, [{ id: 'hydrated-monday', task: 'Hydrated Monday proof', when: '', done: false, updatedAt: 987654321, updatedBy: 'device-cnpi' }]);
  });
  const storesAfterSetup = await page.evaluate(() => ({
    legacy: localStorage.getItem('ta3-plans:uid_account-a'),
    operational: localStorage.getItem('ta3-operational-plans-v1:uid_account-a'),
    calendar: localStorage.getItem('ta3-calendar-plans-v1:uid_account-a'),
  }));
  const planWritesAfterSetup = await page.evaluate(() => window.__fbTest.log.writes.filter(write => /\/(?:plans|operationalPlans|calendarPlans)(?:\/|$)/.test(write.path)).length);

  await setClock(page, at(MON, '00:01'));
  expect(await current(page)).toEqual({ store: 'calendar', id: `cal1:${MON}`, dateKey: MON });
  await expect(page.locator('#timeline-anytime')).toContainText('Hydrated Monday proof');
  await expect(page.locator('#timeline-date-label')).toHaveText("Today's timeline");
  expect(await page.evaluate(() => ({
    legacy: localStorage.getItem('ta3-plans:uid_account-a'),
    operational: localStorage.getItem('ta3-operational-plans-v1:uid_account-a'),
    calendar: localStorage.getItem('ta3-calendar-plans-v1:uid_account-a'),
  }))).toEqual(storesAfterSetup);
  expect(await page.evaluate(() => window.__fbTest.log.writes.filter(write => /\/(?:plans|operationalPlans|calendarPlans)(?:\/|$)/.test(write.path)).length)).toBe(planWritesAfterSetup);
});

test('Sunday 11:00: Plan Tomorrow prepares MONDAY\'s calendar plan (never derived from the 18:00 boundary)', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  await switchToCalendarPlans(page);
  // The static labels say "Tomorrow" again once plans follow the calendar (they read "Next personal day" before).
  await expect(page.locator('#tmr-tab-tomorrow')).toHaveText('Tomorrow');
  await page.evaluate(() => window.openPlanTomorrow());
  await expect(page.locator('#plan-tomorrow-title')).toHaveText('Plan tomorrow');
  await expect(page.locator('#plan-tomorrow-date')).toContainText('Monday');
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Monday priority');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.locator('#plan-tomorrow-confirm').click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  const plans = await calendarStore(page);
  expect(Object.keys(plans)).toEqual([`cal1:${MON}`]);
  expect(plans[`cal1:${MON}`].preparation).toMatchObject({ targetDate: MON, intentionalBlank: false });
  expect(plans[`cal1:${MON}`].items[0].task).toBe('Monday priority');
  // 23:00 is still "tomorrow = Monday"; only midnight moves it.
  await setClock(page, at(SUN, '23:00'));
  expect(await upcoming(page)).toEqual({ store: 'calendar', id: `cal1:${MON}`, dateKey: MON });
});

test('Sunday 11:00: the Plan-by deadline evaluates THIS SAME Sunday plan once it is prepared (no waiting until 18:00)', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  await switchToCalendarPlans(page);
  await page.evaluate(() => window.showView('settings'));
  await page.locator('#plan-by-deadline-time').fill('12:00');
  await page.locator('#plan-by-deadline-settings').getByRole('button', { name: 'Save' }).click();
  await prepareViaPlanTomorrow(page, { target: true, tasks: ['Sunday plan priority'] });
  await page.evaluate(() => window.showView('settings'));
  await expect(page.locator('#plan-by-deadline-settings')).toContainText('Today: maintained');
  const streak = await page.evaluate(() => window.PlanAuthority.planningDeadlineStreak());
  expect(streak.today.deadlineInstantMs).toBe(at(SUN, '12:00'));
  expect(Object.keys(await calendarStore(page))).toEqual([`cal1:${SUN}`]);
});

// ═══════════════════════════════════════════════════════════════════════════
// §11 / §12 — one Sunday plan across midnight, carryover, completion, no clones
// ═══════════════════════════════════════════════════════════════════════════

async function sundayPlanWithOvernight(page) {
  await openApp(page, { now: at(SUN, '11:00') });
  await switchToCalendarPlans(page);
  await addToStrip(page, { task: 'Sunday 11:00 item', when: '11:00' });
  await addToStrip(page, { task: 'Overnight backup', when: '01:00', nextDay: true, kind: 'task' });
  await addToStrip(page, { task: 'Early market check', when: '04:00', nextDay: true, kind: 'task' });
  await addToStrip(page, { task: 'Monday 09:00 from Sunday', when: '09:00', nextDay: true, kind: 'task' });
}

test('a Sunday plan holds Sunday 11:00 AND Monday 01:00 / 04:00 / 09:00 with their true instants, in ONE record', async ({ page }) => {
  await sundayPlanWithOvernight(page);
  const items = (await calendarStore(page))[`cal1:${SUN}`].items;
  // (Records are kept sorted by item id by the shared merge, so compare as a set of readings.)
  expect(items.map(i => `${i.whenDayOffset ?? 0}:${i.when}`).sort()).toEqual(['0:11:00', '1:01:00', '1:04:00', '1:09:00']);
  const instants = await page.evaluate(() => { const t = window.PlanAuthority.current(); return window.PlanAuthority.items(t).map(i => window.PlanAuthority.itemInstants(t, i).startMs); });
  expect([...instants].sort((x, y) => x - y)).toEqual([at(SUN, '11:00'), at(MON, '01:00'), at(MON, '04:00'), at(MON, '09:00')]);
  // Ordered by the real clock, not by the digits: Monday 01:00 does not jump ahead of Sunday 11:00.
  await expect(page.locator('#plan-strip .plan-item .plan-task').first()).toContainText('Sunday 11:00 item');
  await expect(page.locator('#plan-strip .plan-item .plan-when').nth(1)).toContainText('(next day)');
  expect(Object.keys(await calendarStore(page))).toEqual([`cal1:${SUN}`]);
  // Sunday's own My Day shows them after a date break, still one plan.
  await expect(page.locator('#timeline-blocks .tl-date-break')).toContainText('MONDAY');
});

test('Monday 02:00 while still working through Sunday\'s plan: Monday\'s Daily View projects Sunday\'s Monday-dated items in place + Monday\'s own plan; completing one updates SUNDAY\'s record only', async ({ page }) => {
  await sundayPlanWithOvernight(page);
  await setClock(page, at(MON, '02:00'));
  expect(await current(page)).toEqual({ store: 'calendar', id: `cal1:${MON}`, dateKey: MON });
  expect(await upcoming(page)).toEqual({ store: 'calendar', id: 'cal1:2026-09-29', dateKey: '2026-09-29' });

  // Configurable Daily View V1: no separate carryover section — Sunday's rows sit in Monday's
  // window where they fall, still owned by (and routed to) Sunday's plan.
  await expect(page.locator('#timeline-blocks .tl-carryover-header')).toHaveCount(0);
  const carryover = page.locator(`#timeline-blocks .tl-plan-row[data-plan-day-id="cal1:${SUN}"]`);
  await expect(carryover).toHaveCount(3);
  await expect(carryover.first()).toContainText('Overnight backup');
  await expect(carryover.first()).toContainText("Sunday's plan");
  await expect(carryover.first().locator('.tl-plan-check')).toHaveAttribute('onclick', /toggleCarryoverItemDone\('cal1:2026-09-27'/);
  await expect(page.locator('#plan-strip')).not.toContainText('Overnight backup'); // Monday's own strip is Monday's plan

  // Monday's own plan is a separate plan: add something to it.
  await addToStrip(page, { task: 'Monday morning priority', when: '10:00' });
  expect(Object.keys(await calendarStore(page)).sort()).toEqual([`cal1:${SUN}`, `cal1:${MON}`]);

  // Complete the 01:00 carryover row.
  await carryover.first().locator('.tl-plan-check').click();
  await expect.poll(async () => (await calendarStore(page))[`cal1:${SUN}`].items.find(i => i.task === 'Overnight backup').done).toBe(true);
  const after = await calendarStore(page);
  expect(after[`cal1:${MON}`].items.map(i => i.task)).toEqual(['Monday morning priority']); // no clone in Monday
  expect(after[`cal1:${SUN}`].items.filter(i => i.task === 'Overnight backup')).toHaveLength(1);
  await expect(carryover.first()).toHaveClass(/done/);
  // Undo uses the same authority.
  await page.evaluate(() => window.__setNow(Date.now() + 1000));
  await carryover.first().locator('.tl-plan-check').click();
  await expect.poll(async () => (await calendarStore(page))[`cal1:${SUN}`].items.find(i => i.task === 'Overnight backup').done).toBe(false);
});

test('Review: Sunday\'s card covers its Monday 01:10 work by exact link and the actual keeps its Monday timestamp; Monday\'s review does not list it as "unplanned"', async ({ page }) => {
  await sundayPlanWithOvernight(page);
  await setClock(page, at(MON, '12:00'));
  const entryId = await page.evaluate(({ start, end, day }) => {
    const target = window.PlanAuthority.targetById('cal1:2026-09-27');
    const overnight = window.PlanAuthority.items(target).find(item => item.task === 'Overnight backup');
    entries.push({ id: 'e-overnight', activity: 'Overnight backup', energy: 'deep', date: day, tsStart: start, ts: end, blockIntervalMin: 30, planItemId: overnight.id });
    persist();
    return 'e-overnight';
  }, { start: at(MON, '01:10'), end: at(MON, '01:40'), day: MON });

  const evidenceBefore = await page.evaluate(() => window.PlanAuthority.reviewEvidenceWindow(window.PlanAuthority.targetById('cal1:2026-09-27')));
  await page.evaluate(() => { settings.timezone = 'America/Los_Angeles'; window.PlanAuthority.invalidate(); });
  const evidenceAfter = await page.evaluate(() => window.PlanAuthority.reviewEvidenceWindow(window.PlanAuthority.targetById('cal1:2026-09-27')));
  expect(evidenceAfter).toEqual(evidenceBefore);

  await page.evaluate(() => openReview('2026-09-27'));
  await expect(page.locator('#rv-plan-vs-actual')).toContainText('Overnight backup');
  await expect(page.locator('#rv-plan-vs-actual')).toContainText('30m tracked with the same label');
  expect(((await page.locator('#rv-plan-vs-actual').textContent()).match(/Overnight backup/g) || []).length).toBe(1);
  await page.evaluate(() => closeModal('review-overlay'));

  await page.evaluate(() => openReview('2026-09-28'));
  // Nothing planned on Monday, and Sunday's linked work is not "unplanned": the renderer leaves the block empty.
  // (Asserted on content: the block sits inside a collapsed <details>, so visibility would be vacuous.)
  await expect(page.locator('#rv-plan-vs-actual')).toHaveText('');
  await page.evaluate(() => closeModal('review-overlay'));

  // The factual entry still sits at its Monday timestamp, once.
  const factual = await page.evaluate(id => entries.filter(e => e.id === id).map(e => [e.tsStart, e.ts]), entryId);
  expect(factual).toEqual([[at(MON, '01:10'), at(MON, '01:40')]]);
  expect(Object.keys(await calendarStore(page))).toEqual([`cal1:${SUN}`]);
});

test('early wake and normal night shift: at Monday 04:30 (past Sunday\'s 01:00 and 04:00) the day is Monday and Sunday\'s remaining Monday-dated item is carryover', async ({ page }) => {
  await sundayPlanWithOvernight(page);
  await setClock(page, at(MON, '04:30'));
  expect(await current(page)).toEqual({ store: 'calendar', id: `cal1:${MON}`, dateKey: MON });
  await expect(page.locator(`#timeline-blocks .tl-plan-row[data-plan-day-id="cal1:${SUN}"]`)).toHaveCount(3);
  // A night shift working 22:00 -> 06:00 crosses midnight inside ONE plan and never becomes a Monday plan.
  const before = Object.keys(await calendarStore(page));
  await setClock(page, at(MON, '05:59'));
  expect(Object.keys(await calendarStore(page))).toEqual(before);
});

test('normal night shift: a 22:00 -> 06:00 range made in the real editor crosses midnight inside ONE Sunday plan; it is neither Monday carryover nor "unfinished" until its own span is over', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  await switchToCalendarPlans(page);
  await page.evaluate(() => window.openPlanTomorrow({ target: window.PlanAuthority.current() }));
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Night shift');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.locator('[data-pt-action="edit-schedule"]').first().click();
  await page.locator('.pt-time-input').first().fill('22:00');
  await page.locator('[data-pt-action="edit-schedule"]').first().click();
  await page.locator('.pt-end-input').first().fill('06:00');
  await expect(page.locator('#plan-tomorrow-body')).toContainText('10:00 PM–6:00 AM');
  await page.locator('#plan-tomorrow-confirm').click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);

  const [shift] = (await calendarStore(page))[`cal1:${SUN}`].items;
  expect(shift).toMatchObject({ task: 'Night shift', when: '22:00', durationMinutes: 480, whenTz: TZ });
  expect(shift.whenDayOffset).toBeUndefined();
  const span = await page.evaluate(() => { const t = window.PlanAuthority.current(); return window.PlanAuthority.itemInstants(t, window.PlanAuthority.items(t)[0]); });
  expect(span).toEqual({ startMs: at(SUN, '22:00'), endMs: at(MON, '06:00') });

  await setClock(page, at(MON, '03:00'));
  expect(await current(page)).toMatchObject({ dateKey: MON });
  expect(await page.evaluate(() => window.PlanAuthority.calendarCarryoverFor('2026-09-28').items.length)).toBe(0); // it started on Sunday: not Monday-dated carryover
  expect(await page.evaluate(() => window.PlanAuthority.staleUnfinished().items.length)).toBe(0);             // still inside its own span
  await setClock(page, at(MON, '07:00'));
  expect(await page.evaluate(() => window.PlanAuthority.staleUnfinished().items.map(row => row.item.task))).toEqual(['Night shift']);
  expect(Object.keys(await calendarStore(page))).toEqual([`cal1:${SUN}`]);
});

test('primary My Day editor creates, reloads, crosses midnight, returns same-day, and clears one canonical range without changing item or plan identity', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  await switchToCalendarPlans(page);
  await page.locator('[data-pc-action="open-item-form"]').click();
  const form = page.locator('#pc-task-form');
  await form.locator('input[name="title"]').fill('Evening build');
  await form.locator('input[name="time"]').fill('20:00');
  await form.locator('input[name="endTime"]').fill('22:00');
  await form.getByRole('button', { name: 'Add', exact: true }).click();

  let item = (await calendarStore(page))[`cal1:${SUN}`].items.find(row => row.task === 'Evening build');
  const itemId = item.id;
  expect(item).toMatchObject({ when: '20:00', durationMinutes: 120, whenTz: TZ });
  expect(item.whenDayOffset).toBeUndefined();
  let row = page.locator(`#timeline-blocks [data-plan-item-id="${itemId}"]`);
  await expect(row).toContainText('8:00 PM–10:00 PM');
  await expect(row).toContainText('2h');

  await page.reload();
  await page.waitForFunction(() => window.PlanAuthority?.authorityState() === 'calendar' && typeof window.PlanningContinuityUI?.editTask === 'function');
  row = page.locator(`#timeline-blocks [data-plan-item-id="${itemId}"]`);
  await expect(row).toContainText('8:00 PM–10:00 PM');
  item = (await calendarStore(page))[`cal1:${SUN}`].items.find(candidate => candidate.id === itemId);
  expect(item.durationMinutes).toBe(120);

  await setClock(page, at(SUN, '11:01'));
  await row.getByRole('button', { name: 'Edit planned task Evening build' }).click();
  await form.locator('input[name="time"]').fill('23:00');
  await form.locator('input[name="endTime"]').fill('01:00');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toBeHidden();
  item = (await calendarStore(page))[`cal1:${SUN}`].items.find(candidate => candidate.id === itemId);
  expect(item).toMatchObject({ id: itemId, when: '23:00', durationMinutes: 120 });
  expect(Object.keys(await calendarStore(page))).toEqual([`cal1:${SUN}`]);
  await expect(row).toContainText('11:00 PM–1:00 AM');
  await expect(row).toContainText('Ends Monday, Sep 28');

  await setClock(page, at(SUN, '11:02'));
  await row.getByRole('button', { name: 'Edit planned task Evening build' }).click();
  await form.locator('input[name="endTime"]').fill('03:00');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row).toContainText('11:00 PM–3:00 AM');
  expect((await calendarStore(page))[`cal1:${SUN}`].items.find(candidate => candidate.id === itemId).durationMinutes).toBe(240);

  await setClock(page, at(SUN, '11:03'));
  await row.getByRole('button', { name: 'Edit planned task Evening build' }).click();
  await form.locator('input[name="time"]').fill('20:00');
  await form.locator('input[name="endTime"]').fill('22:00');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row).toContainText('8:00 PM–10:00 PM');
  await expect(row).not.toContainText('Ends Monday');

  await setClock(page, at(SUN, '11:04'));
  await row.getByRole('button', { name: 'Edit planned task Evening build' }).click();
  await form.locator('input[name="endTime"]').fill('');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  item = (await calendarStore(page))[`cal1:${SUN}`].items.find(candidate => candidate.id === itemId);
  expect(item.id).toBe(itemId);
  expect(item.when).toBe('20:00');
  expect(item).not.toHaveProperty('durationMinutes');
  await expect(row).toContainText('8:00 PM');
  await expect(row).not.toContainText('10:00 PM');
});

test('the default 36h Daily View shows several factual Monday items through 3 AM, with no projection writes or duplicate persistence', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  await switchToCalendarPlans(page);
  await page.evaluate(() => {
    const target = window.PlanAuthority.current();
    window.PlanAuthority.saveItems(target, [
      { id: 'late-work', task: 'Late work', when: '23:00', durationMinutes: 120, done: false, updatedAt: 1, updatedBy: 'device-cnpi' },
      { id: 'wind-down', task: 'Wind down', when: '01:00', whenDayOffset: 1, done: false, updatedAt: 2, updatedBy: 'device-cnpi' },
      { id: 'sleep', task: 'Sleep', when: '03:00', whenDayOffset: 1, done: false, updatedAt: 3, updatedBy: 'device-cnpi' },
    ]);
    window.refreshAuthoritativePlanSurfaces();
  });
  const before = await page.evaluate(() => ({
    store: localStorage.getItem('ta3-calendar-plans-v1:uid_account-a'),
    writes: window.__fbTest.log.writes.length,
  }));
  await expect(page.locator('#timeline-blocks .tl-date-break')).toContainText('MONDAY');
  await expect(page.locator('#timeline-blocks [data-plan-item-id="late-work"]')).toContainText('11:00 PM–1:00 AM');
  await expect(page.locator('#timeline-blocks [data-plan-item-id="late-work"]')).toContainText('Ends Monday, Sep 28');
  await expect(page.locator('#timeline-blocks [data-plan-item-id="wind-down"]')).toContainText('1:00 AM');
  await expect(page.locator('#timeline-blocks [data-plan-item-id="sleep"]')).toContainText('3:00 AM');
  // Configurable Daily View V1: the extent is selected date + Daily View Length (default 36h),
  // never derived from content (the old "+30 min after the last item" rule is retired).
  await expect(page.locator('#timeline-blocks')).toHaveAttribute('data-daily-view-hours', '36');
  await expect(page.locator('#timeline-blocks')).toHaveAttribute('data-daily-view-start-ms', String(at(SUN, '00:00')));
  await expect(page.locator('#timeline-blocks')).toHaveAttribute('data-daily-view-end-ms', String(at(MON, '12:00')));
  await expect(page.locator('#timeline-blocks')).not.toHaveAttribute('data-display-end-ms', /.*/);
  const after = await page.evaluate(() => ({
    store: localStorage.getItem('ta3-calendar-plans-v1:uid_account-a'),
    writes: window.__fbTest.log.writes.length,
  }));
  expect(after).toEqual(before);
  const persisted = (await calendarStore(page))[`cal1:${SUN}`].items;
  expect(persisted.map(item => item.id).sort()).toEqual(['late-work', 'sleep', 'wind-down']);
  expect(Object.keys(await calendarStore(page))).toEqual([`cal1:${SUN}`]);
});

test('a legacy write that lands AFTER the switch (another device on the old model) is a superseded plan — never the current plan, never merged into the calendar plan', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  await switchToCalendarPlans(page);
  await addToStrip(page, { task: 'Calendar priority', when: '12:00' });
  const before = JSON.stringify(await calendarStore(page));
  const key = Buffer.from(SATURDAY_DAY_ID).toString('base64url');
  await page.evaluate(({ key }) => window.__fbTest.remoteWrite(`rooms/uid_account-a/operationalPlans/${key}`, { items: [{ id: 'late-legacy', task: 'Written by a stale device', when: '', done: false, updatedAt: 9000, updatedBy: 'old-device' }], updatedAt: 9000, updatedBy: 'old-device' }), { key });
  await expect(page.locator('#calendar-plan-section [data-cp-older]')).toContainText('Written by a stale device');
  expect((await current(page)).store).toBe('calendar');
  await expect(page.locator('#plan-strip')).not.toContainText('Written by a stale device');
  expect(JSON.stringify(await calendarStore(page))).toBe(before);
});

test('midnight rolls the current plan in-session with no reload: Sunday 23:59 -> Monday 00:01', async ({ page }) => {
  await openApp(page, { now: at(SUN, '23:59') });
  await switchToCalendarPlans(page);
  expect(await current(page)).toMatchObject({ dateKey: SUN });
  await setClock(page, at(MON, '00:01'));
  expect(await current(page)).toMatchObject({ dateKey: MON });
  expect(await upcoming(page)).toMatchObject({ dateKey: '2026-09-29' });
});

test('an unfinished task from a superseded legacy day can be moved into the calendar plan — and the legacy record is never rewritten', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00'), operationalPlans: saturdayOperationalPlans() });
  const legacyBefore = await rawLegacy(page);
  await switchToCalendarPlans(page);
  await expect(page.locator('#calendar-plan-section [data-cp-older]')).toHaveCount(1);
  await expect(page.locator('#calendar-plan-section [data-cp-older]')).toContainText('Saturday-window errand');
  await expect(page.locator('#calendar-plan-section [data-cp-older]')).toContainText('Made before you switched');
  const moved = await page.evaluate(() => {
    const layer = window.PlanAuthority;
    const source = layer.targetById(layer.supersededPlans()[0].id);
    return layer.moveStaleItem({ sourceTarget: source, itemId: 'sat-a', destination: layer.current(), stamp: item => ({ ...item, updatedAt: Date.now(), updatedBy: 'device-cnpi' }) }).moved;
  });
  expect(moved).toBe(true);
  expect(await rawLegacy(page)).toEqual(legacyBefore);
  // Still open (sat-b) → still listed, with the moved task marked; once it moves too, Today stops carrying it.
  await expect(page.locator('#calendar-plan-section [data-cp-older]')).toContainText('moved to a calendar plan');
  await page.evaluate(() => {
    const layer = window.PlanAuthority;
    const source = layer.targetById(layer.supersededPlans()[0].id);
    layer.moveStaleItem({ sourceTarget: source, itemId: 'sat-b', destination: layer.current(), stamp: item => ({ ...item, updatedAt: Date.now() + 1, updatedBy: 'device-cnpi' }) });
  });
  await expect(page.locator('#calendar-plan-section [data-cp-older]')).toHaveCount(0);
  expect(await rawLegacy(page)).toEqual(legacyBefore);
  const plans = await calendarStore(page);
  expect(plans[`cal1:${SUN}`].items[0]).toMatchObject({ task: 'Saturday-window errand', carriedFromId: 'sat-a' });
});

test('divergent recovery edits expose both candidates and an explicit keep-version resolution', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  await switchToCalendarPlans(page);
  const sourceDayId = '2026-09-26';
  const carryId = 'ocarry1|recovery-conflict-browser';
  const candidate = (dayId, task, updatedBy) => ({
    id: carryId, task, when: '', done: false, doneAt: null,
    carriedFromId: 'source-task', carriedFromDayId: sourceDayId,
    updatedAt: updatedBy === 'device-a' ? 20 : 21, updatedBy,
    relocationRevision: {
      schemaVersion: 1, sequence: 1, fromDayId: sourceDayId,
      toDayId: dayId, updatedAt: updatedBy === 'device-a' ? 10 : 11, updatedBy,
    },
  });
  await page.evaluate(({ sunday, monday }) => {
    window.__fbTest.remoteWrite('rooms/uid_account-a/calendarPlans/cal1:2026-09-27', { items: [sunday], updatedAt: 20, updatedBy: 'device-a' });
    window.__fbTest.remoteWrite('rooms/uid_account-a/calendarPlans/cal1:2026-09-28', { items: [monday], updatedAt: 21, updatedBy: 'device-b' });
  }, {
    sunday: candidate(`cal1:${SUN}`, 'Edited on Sunday device', 'device-a'),
    monday: candidate(`cal1:${MON}`, 'Edited on Monday device', 'device-b'),
  });

  await expect.poll(() => page.evaluate(() => window.PlanAuthority.recoveryConflicts().length)).toBe(1);
  const recovery = page.locator('#unfinished-recovery-section');
  await recovery.getByRole('button', { name: 'Unfinished · 1' }).click();
  const conflict = recovery.locator('[data-pc-recovery-conflict="source-task"]');
  await expect(conflict).toContainText('Recovery conflict');
  await expect(conflict).toContainText('Edited on Sunday device');
  await expect(conflict).toContainText('Edited on Monday device');
  await expect(conflict.getByRole('button', { name: 'Keep this version' })).toHaveCount(2);
  await conflict.locator('[data-pc-recovery-candidate="cal1:2026-09-27"]').getByRole('button', { name: 'Keep this version' }).click();

  await expect.poll(() => page.evaluate(() => window.PlanAuthority.recoveryConflicts().length)).toBe(0);
  const live = await page.evaluate(() => [window.PlanAuthority.current(), window.PlanAuthority.upcoming()]
    .flatMap(target => window.PlanAuthority.items(target))
    .filter(item => item.carriedFromId === 'source-task')
    .map(item => item.task));
  expect(live).toEqual(['Edited on Sunday device']);
  expect(await page.evaluate(() => window.__fbTest.get('rooms/uid_account-a/calendarPlans/cal1:2026-09-28').items[0].task)).toBe('Edited on Monday device');
});

// ═══════════════════════════════════════════════════════════════════════════
// §16 / §22 — timezone and boundary changes decide nothing new
// ═══════════════════════════════════════════════════════════════════════════

test('changing the account timezone later leaves the Sunday plan\'s scheduled instants — and its zone — where they were', async ({ page }) => {
  await sundayPlanWithOvernight(page);
  const snapshot = () => page.evaluate(() => { const t = window.PlanAuthority.targetById('cal1:2026-09-27'); return { zone: t.timezone, start: t.startMs, instants: window.PlanAuthority.items(t).map(i => window.PlanAuthority.itemInstants(t, i).startMs) }; });
  const before = await snapshot();
  await page.evaluate(() => { settings.timezone = 'America/Los_Angeles'; window.PlanAuthority.invalidate(); });
  await page.evaluate(() => {
    const t = window.PlanAuthority.targetById('cal1:2026-09-27');
    window.PlanAuthority.saveItems(t, window.PlanAuthority.rawItems(t).map((item, index) => (index === 0 ? { ...item, done: true } : item)));
  });
  expect(await snapshot()).toEqual(before);
  expect((await calendarStore(page))[`cal1:${SUN}`].items.every(i => i.whenTz === TZ)).toBe(true);
});

test('changing the legacy Personal Day boundary after the switch changes nothing about which plan is current', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  await switchToCalendarPlans(page);
  await page.evaluate(() => window.PersonalDayBoundaryLive.proposeBoundary({ boundaryTime: '20:00', timezone: 'Asia/Manila' }));
  await setClock(page, at(SUN, '21:00'));
  expect(await current(page)).toMatchObject({ store: 'calendar', dateKey: SUN });
  expect(await upcoming(page)).toMatchObject({ store: 'calendar', dateKey: MON });
});

// ═══════════════════════════════════════════════════════════════════════════
// §17 — account isolation
// ═══════════════════════════════════════════════════════════════════════════

test('direct A -> B: no A plan, deadline or cutover in B, no write into B\'s room; B -> A restores A; sign-out empties', async ({ page }) => {
  await sundayPlanWithOvernight(page);
  await page.evaluate(() => window.showView('settings'));
  await page.locator('#plan-by-deadline-time').fill('12:00');
  await page.locator('#plan-by-deadline-settings').getByRole('button', { name: 'Save' }).click();

  await page.evaluate(() => window.__fbTest.signInAs('account-b'));
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode() === 'uid_account-b');
  await page.waitForTimeout(250);
  const isolated = await page.evaluate(() => ({
    active: window.PlanAuthority.calendarActive(),
    current: window.PlanAuthority.current().store,
    plans: Object.keys(window.CalendarPlanLive.listAllRaw()),
    deadlines: window.PlanByDeadlineSync.repository.readDeadlines().length,
    writesToB: window.__fbTest.log.writes.filter(w => w.path.startsWith('rooms/uid_account-b/')).map(w => w.path),
    remoteB: window.__fbTest.get('rooms/uid_account-b/calendarPlans'),
  }));
  expect(isolated).toMatchObject({ active: false, current: 'legacy', plans: [], deadlines: 0, remoteB: null });
  expect(isolated.writesToB.filter(p => /calendarPlan|planByDeadline|intentionalOffDays/.test(p))).toEqual([]);
  await expect(page.locator('#plan-strip')).not.toContainText('Overnight backup');

  // B's own cutover (made on some device of B) is heard through the join hook — and it is B's, not A's.
  await page.evaluate(() => window.__fbTest.remoteWrite('rooms/uid_account-b/calendarPlanAuthority/ca1-b', { schemaVersion: 1, id: 'ca1-b', activatedAtMs: 1790000000000, timezone: 'Asia/Manila', activationDate: '2026-09-21', deviceId: 'b-device' }));
  await expect.poll(() => page.evaluate(() => window.PlanAuthority.calendarActivation()?.deviceId)).toBe('b-device');

  await page.evaluate(() => window.__fbTest.signInAs('account-a'));
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode() === 'uid_account-a');
  await expect.poll(() => page.evaluate(() => window.PlanAuthority.calendarActivation()?.deviceId)).toBe('device-cnpi'); // A's own cutover, not B's
  await expect.poll(() => page.evaluate(() => window.CalendarPlanLive.readRecord('2026-09-27')?.items.length)).toBe(4);

  await page.evaluate(() => window.__fbTest.signInAs(null));
  await expect.poll(() => page.evaluate(() => globalThis.getChronaSenseRoomCode() || '')).toBe('');
  expect(await page.evaluate(() => ({ active: window.PlanAuthority.calendarActive(), plans: Object.keys(window.CalendarPlanLive.listAllRaw()) }))).toEqual({ active: false, plans: [] });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 / §18 — offline, reconnect, cross-device cutover
// ═══════════════════════════════════════════════════════════════════════════

test('offline: the switch and Sunday\'s plan persist locally, reach the cloud after reconnect, and nothing is lost', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  await page.evaluate(() => window.__fbTest.setFailWrites(true));
  await switchToCalendarPlans(page);
  await addToStrip(page, { task: 'Written offline', when: '11:30' });
  expect(await page.evaluate(() => [window.__fbTest.get('rooms/uid_account-a/calendarPlans'), window.__fbTest.get('rooms/uid_account-a/calendarPlanAuthority')])).toEqual([null, null]);
  expect((await calendarStore(page))[`cal1:${SUN}`].items[0].task).toBe('Written offline');
  await page.evaluate(() => { window.__fbTest.setFailWrites(false); window.__fbTest.reconnect(); });
  await expect.poll(() => page.evaluate(() => window.__fbTest.get(`rooms/uid_account-a/calendarPlans/cal1:2026-09-27`)?.items?.[0]?.task)).toBe('Written offline');
  await expect.poll(() => page.evaluate(() => Object.keys(window.__fbTest.get('rooms/uid_account-a/calendarPlanAuthority') || {}).length)).toBe(1);
});

test('cross-device: a cutover made on ANOTHER device is learned here, and this device then plans on the calendar', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00'), operationalPlans: saturdayOperationalPlans() });
  expect((await current(page)).store).toBe('operational');
  await expect(page.locator('#calendar-plan-section')).toContainText('Use calendar-day plans');
  const fact = { schemaVersion: 1, id: 'ca1-other-device', activatedAtMs: at(SUN, '09:00'), timezone: TZ, activationDate: SUN, deviceId: 'device-other' };
  await page.evaluate(value => window.__fbTest.remoteWrite('rooms/uid_account-a/calendarPlanAuthority/ca1-other-device', value), fact);
  await expect.poll(() => page.evaluate(() => window.PlanAuthority.calendarActive())).toBe(true);
  expect(await current(page)).toEqual({ store: 'calendar', id: `cal1:${SUN}`, dateKey: SUN });
  await expect(page.locator('#calendar-plan-section')).not.toContainText('Use calendar-day plans');
  // It also starts hearing the other device's calendar plans.
  await page.evaluate(() => window.__fbTest.remoteWrite('rooms/uid_account-a/calendarPlans/cal1:2026-09-27', { items: [{ id: 'remote-item', task: 'From the other device', when: '15:00', whenTz: 'Asia/Manila', done: false, updatedAt: 5, updatedBy: 'device-other' }], updatedAt: 5, updatedBy: 'device-other' }));
  await expect(page.locator('#plan-strip')).toContainText('From the other device');
  // And a stale legacy write for the same window stays a superseded plan, never a second current plan.
  await expect(page.locator('#calendar-plan-section [data-cp-older]')).toContainText('Saturday-window errand');
  expect((await current(page)).store).toBe('calendar');
});

test('a never-switched account with NO Personal Day is offered the switch in Settings only, and its plans are untouched', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00'), boundary: false });
  await expect(page.locator('#calendar-plan-section')).toBeHidden();
  await page.evaluate(() => window.showView('settings'));
  await expect(page.locator('#calendar-plan-settings')).toContainText('already follow the calendar date');
  expect((await current(page)).store).toBe('legacy');
  expect(await calendarStore(page)).toEqual({});
});

test('the Plan-by deadline is account-owned end to end: a deadline set on another device arrives, a deadline set here reaches the cloud after reconnect, and sign-out detaches it', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  // Another device of the same account sets a deadline.
  const other = { id: 'pbd-other', deadlineTime: '09:30', timezone: TZ, effectiveFromInstant: at(SUN, '09:30') };
  await page.evaluate(value => window.__fbTest.remoteWrite('rooms/uid_account-a/planByDeadlineRevisions/pbd-other', value), other);
  await expect.poll(() => page.evaluate(() => window.PlanByDeadlineSync.repository.readDeadlines().map(r => r.id))).toEqual(['pbd-other']);

  // A deadline saved here while offline stays local, then reaches the cloud on reconnect.
  await page.evaluate(() => window.__fbTest.setFailWrites(true));
  await page.evaluate(() => window.showView('settings'));
  await page.locator('#plan-by-deadline-time').fill('12:00');
  await page.locator('#plan-by-deadline-settings').getByRole('button', { name: 'Save' }).click();
  expect(await page.evaluate(() => Object.keys(window.__fbTest.get('rooms/uid_account-a/planByDeadlineRevisions') || {}))).toEqual(['pbd-other']);
  await page.evaluate(() => { window.__fbTest.setFailWrites(false); window.__fbTest.reconnect(); });
  await expect.poll(() => page.evaluate(() => Object.keys(window.__fbTest.get('rooms/uid_account-a/planByDeadlineRevisions') || {}).length)).toBe(2);

  // Joining ANOTHER room after the modules exist goes through storage.js's own join hook: B hears B's
  // deadlines (never A's), and A's listener is gone.
  await page.evaluate(() => window.__fbTest.signInAs('account-b'));
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode() === 'uid_account-b');
  expect(await page.evaluate(() => window.PlanByDeadlineSync.repository.readDeadlines().length)).toBe(0);
  await page.evaluate(() => window.__fbTest.remoteWrite('rooms/uid_account-b/planByDeadlineRevisions/pbd-b', { id: 'pbd-b', deadlineTime: '07:00', timezone: 'Asia/Manila', effectiveFromInstant: 5 }));
  await expect.poll(() => page.evaluate(() => window.PlanByDeadlineSync.repository.readDeadlines().map(r => r.id))).toEqual(['pbd-b']);
  await page.evaluate(() => window.__fbTest.remoteWrite('rooms/uid_account-a/planByDeadlineRevisions/pbd-a-late', { id: 'pbd-a-late', deadlineTime: '05:00', timezone: 'Asia/Manila', effectiveFromInstant: 1 }));
  expect(await page.evaluate(() => window.PlanByDeadlineSync.repository.readDeadlines().map(r => r.id))).toEqual(['pbd-b']);

  // Sign-out tears the listeners down: a later remote change is not merged into a signed-out device.
  await page.evaluate(() => window.__fbTest.signInAs(null));
  await expect.poll(() => page.evaluate(() => globalThis.getChronaSenseRoomCode() || '')).toBe('');
  await page.evaluate(() => window.__fbTest.remoteWrite('rooms/uid_account-b/planByDeadlineRevisions/pbd-late', { id: 'pbd-late', deadlineTime: '05:00', timezone: 'Asia/Manila', effectiveFromInstant: 1 }));
  expect(await page.evaluate(() => window.PlanByDeadlineSync.repository.readDeadlines().map(r => r.id))).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// §25 — one page load, one generation
// ═══════════════════════════════════════════════════════════════════════════

test('release generation: the meta, the import map and every loaded calendar/plan module carry the ONE token, each loaded once', async ({ page }) => {
  await openApp(page, { now: at(SUN, '11:00') });
  const seen = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /(calendar-plan|plan-authority|plan-by-deadline|personal-day-boundary-live|operational-plan)[^/]*\.js/.test(url)));
  expect(seen.length).toBeGreaterThanOrEqual(8);
  for (const url of seen) expect(url).toContain(`?v=${TOKEN}`);
  expect(new Set(seen).size).toBe(seen.length);
  expect(await page.evaluate(() => document.querySelector('meta[name="pdb-release"]').content)).toBe(TOKEN);
  for (const file of ['calendar-plan-model.js', 'calendar-plan-repository.js', 'calendar-plan-sync.js', 'calendar-plan-live.js', 'calendar-plan-ui.js']) {
    expect(seen.filter(url => url.includes(file))).toHaveLength(1);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Configurable 24–48 Hour Daily View V1 — the owner's acceptance case, in the real app
// ═══════════════════════════════════════════════════════════════════════════

const SAT = '2026-09-26';

/** Saturday 09:00, calendar-day plans on since Saturday. Saturday's plan: "Ticktick list"
 *  22:00 for 600 min (ends Sunday 08:00). Sunday's plan: "★ sad" 01:43 for 121 min. */
async function saturdaySundayPlans(page) {
  await openApp(page, { now: at(SAT, '09:00') });
  await switchToCalendarPlans(page);
  await page.evaluate(({ sat, sun, tz }) => {
    window.PlanAuthority.saveItems(window.PlanAuthority.calendarTarget(sat), [
      { id: 'ticktick', task: 'Ticktick list', kind: 'task', when: '22:00', durationMinutes: 600, whenTz: tz, done: false, updatedAt: 1, updatedBy: 'device-cnpi' },
    ]);
    window.PlanAuthority.saveItems(window.PlanAuthority.calendarTarget(sun), [
      { id: 'sad', task: 'sad', when: '01:43', durationMinutes: 121, whenTz: tz, done: false, updatedAt: 2, updatedBy: 'device-cnpi' },
    ]);
    window.refreshAuthoritativePlanSurfaces();
  }, { sat: SAT, sun: SUN, tz: TZ });
}

const timelineOrder = page => page.evaluate(() => [...document.querySelectorAll('#timeline-blocks > .tl-row, #timeline-blocks > .tl-date-break')]
  .map(el => el.classList.contains('tl-date-break') ? `break:${el.textContent.trim()}` : (el.dataset.planItemId ? `plan:${el.dataset.planItemId}` : 'other')));

test('Daily View ACCEPTANCE — Saturday 36h: Sat 00:00 → Sun 12:00, Ticktick, the Sunday boundary, then ★ sad 1:43–3:44 AM still owned by Sunday', async ({ page }) => {
  await saturdaySundayPlans(page);
  const tl = page.locator('#timeline-blocks');
  await expect(tl).toHaveAttribute('data-daily-view-hours', '36');
  await expect(tl).toHaveAttribute('data-daily-view-start-ms', String(at(SAT, '00:00')));
  await expect(tl).toHaveAttribute('data-daily-view-end-ms', String(at(SUN, '12:00')));

  const ticktick = tl.locator('[data-plan-item-id="ticktick"]');
  await expect(ticktick).toHaveAttribute('data-plan-day-id', `cal1:${SAT}`);
  await expect(ticktick).toContainText('10:00 PM–8:00 AM');
  await expect(ticktick).toContainText('Ends Sunday, Sep 27');
  await expect(tl.locator('.tl-date-break')).toHaveText('SUNDAY, SEPTEMBER 27 · NEXT DAY');
  const sad = tl.locator('[data-plan-item-id="sad"]');
  await expect(sad).toHaveAttribute('data-plan-day-id', `cal1:${SUN}`);
  await expect(sad).toContainText('★');
  await expect(sad).toContainText('1:43 AM–3:44 AM');
  await expect(sad).toContainText("Sunday's plan");
  expect(await timelineOrder(page)).toEqual(['plan:ticktick', 'break:SUNDAY, SEPTEMBER 27 · NEXT DAY', 'plan:sad']);
  // Its actions name Sunday's plan, never the Saturday view date.
  await expect(sad.getByRole('button', { name: 'Edit planned task sad' })).toHaveAttribute('onclick', `PlanningContinuityUI.editTask('cal1:${SUN}','sad')`);
  await expect(sad.locator('.tl-plan-check')).toHaveAttribute('onclick', `toggleTimelinePlanDone('cal1:${SUN}','sad')`);

  // Completing it from Saturday's view writes Sunday's one record; Saturday is untouched; no copy anywhere.
  const saturdayBefore = JSON.stringify((await calendarStore(page))[`cal1:${SAT}`]);
  await sad.locator('.tl-plan-check').click();
  await expect.poll(async () => (await calendarStore(page))[`cal1:${SUN}`].items.find(i => i.id === 'sad').done).toBe(true);
  const store = await calendarStore(page);
  expect(Object.keys(store).sort()).toEqual([`cal1:${SAT}`, `cal1:${SUN}`]);
  expect(store[`cal1:${SUN}`].items.map(i => i.id)).toEqual(['sad']);
  expect(JSON.stringify(store[`cal1:${SAT}`])).toBe(saturdayBefore);
});

test('Daily View ACCEPTANCE — Sunday view: ★ sad as Sunday\'s own and Saturday\'s Ticktick continuing until 8:00 AM, same records, viewing writes nothing', async ({ page }) => {
  await saturdaySundayPlans(page);
  const before = await page.evaluate(() => ({ store: localStorage.getItem('ta3-calendar-plans-v1:uid_account-a'), writes: window.__fbTest.log.writes.length }));
  await page.evaluate(day => window.setViewDate(day), SUN);
  const tl = page.locator('#timeline-blocks');
  await expect(tl).toHaveAttribute('data-daily-view-start-ms', String(at(SUN, '00:00')));
  await expect(tl).toHaveAttribute('data-daily-view-end-ms', String(at(MON, '12:00')));
  const ticktick = tl.locator('[data-plan-item-id="ticktick"]');
  await expect(ticktick).toHaveClass(/tl-carry-in/);
  await expect(ticktick).toHaveAttribute('data-plan-day-id', `cal1:${SAT}`);
  await expect(ticktick).toContainText('Continues from Saturday');
  await expect(ticktick).toContainText('10:00 PM–8:00 AM');
  await expect(ticktick).toContainText("Saturday's plan");
  const sad = tl.locator('[data-plan-item-id="sad"]');
  await expect(sad).toHaveAttribute('data-plan-day-id', `cal1:${SUN}`);
  await expect(sad).not.toContainText("Sunday's plan");
  expect(await timelineOrder(page)).toEqual(['plan:ticktick', 'plan:sad']);
  // Saturday's plan is still running at Saturday 09:00, so the carry-in row edits Saturday's record.
  await expect(ticktick.getByRole('button', { name: 'Edit planned task Ticktick list' })).toHaveAttribute('onclick', `PlanningContinuityUI.editTask('cal1:${SAT}','ticktick')`);
  const after = await page.evaluate(() => ({ store: localStorage.getItem('ta3-calendar-plans-v1:uid_account-a'), writes: window.__fbTest.log.writes.length }));
  expect(after).toEqual(before);
});

test('Daily View Length: 24–48h control, device-local only; 24h drops Sunday 1:43 AM from Saturday; malformed reads as 36h', async ({ page }) => {
  await saturdaySundayPlans(page);
  await page.evaluate(() => window.renderSettings());
  const options = await page.locator('#set-daily-view-hours option').evaluateAll(els => els.map(el => el.value));
  expect(options).toEqual(Array.from({ length: 25 }, (_, i) => String(24 + i)));
  await expect(page.locator('#set-daily-view-hours')).toHaveValue('36');

  const remoteWritesBefore = await page.evaluate(() => window.__fbTest.log.writes.length);
  await page.evaluate(() => window.saveDailyViewHours('24'));
  expect(await page.evaluate(() => localStorage.getItem('ta3-daily-view-hours'))).toBe('24');
  expect(await page.evaluate(() => window.__fbTest.log.writes.length)).toBe(remoteWritesBefore);
  expect(await page.evaluate(() => JSON.stringify(settings).includes('dailyView'))).toBe(false);
  const tl = page.locator('#timeline-blocks');
  await expect(tl).toHaveAttribute('data-daily-view-end-ms', String(at(SUN, '00:00')));
  await expect(tl.locator('[data-plan-item-id="ticktick"]')).toBeVisible();
  await expect(tl.locator('[data-plan-item-id="sad"]')).toHaveCount(0);
  await expect(tl.locator('.tl-date-break')).toHaveCount(0);

  await page.evaluate(() => window.saveDailyViewHours('48'));
  await expect(tl).toHaveAttribute('data-daily-view-end-ms', String(at(MON, '00:00')));
  await expect(tl.locator('[data-plan-item-id="sad"]')).toBeVisible();

  await page.evaluate(() => { localStorage.setItem('ta3-daily-view-hours', 'banana'); _todayRenderKey = '__FORCE__'; renderToday(); renderSettings(); });
  await expect(tl).toHaveAttribute('data-daily-view-hours', '36');
  await expect(page.locator('#set-daily-view-hours')).toHaveValue('36');
});

test('Daily View: a next-date schedule occurrence keeps its own date — "Off today" on Sunday\'s 07:00 shown in Saturday\'s view skips SUNDAY only', async ({ page }) => {
  await saturdaySundayPlans(page);
  await page.evaluate(() => {
    settings.templates = [{ id: 'tpl-gym', enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startTime: '07:00', endTime: '08:00', activity: 'Gym', energy: 'deep', autoLog: false, skipDates: [] }];
    _todayRenderKey = '__FORCE__';
    renderToday();
  });
  const rows = page.locator('#timeline-blocks .tl-template-row');
  await expect(rows).toHaveCount(2); // Saturday 07:00 and Sunday 07:00 (inside the 36h window); Friday's ended before it
  const offButtons = page.locator('#timeline-blocks .tl-template-row .template-off-btn');
  const handlers = await offButtons.evaluateAll(els => els.map(el => el.getAttribute('onclick')));
  expect(handlers[0]).toContain(`'${SAT}'`);
  expect(handlers[1]).toContain(`'${SUN}'`);
  expect(await timelineOrder(page)).toEqual(['other', 'plan:ticktick', `break:SUNDAY, SEPTEMBER 27 · NEXT DAY`, 'plan:sad', 'other']);
  await offButtons.nth(1).click();
  expect(await page.evaluate(() => settings.templates[0].skipDates)).toEqual([SUN]);
  await expect(rows).toHaveCount(1);
  await expect(page.locator('#timeline-blocks .tl-template-row .template-off-btn')).toHaveAttribute('onclick', new RegExp(`'${SAT}'`));
});
