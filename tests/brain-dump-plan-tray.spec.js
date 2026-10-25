// TASK-015 — Unified My Day + Brain Dump V1: the My Day planning tray (#bd-plan-tray).
//
// Harness: tests/brain-dump-production-ux.spec.js's real-ordering stub (a committed
// transaction raises the brainDump subtree 'value' event BEFORE the transaction's own
// Promise resolves; records are stored in RTDB's pruned wire form; __bdHold/__bdRelease
// delay one capture's transactions). Three additions, each needed by one criterion:
//   - the remote brainDump subtree lives in localStorage, so two tabs of one browser
//     context share one "server" and see each other's commits through the storage event (F3);
//   - __bdFail makes every brainDump transaction reject, a definite transport failure (F6);
//   - __signInAs switches the signed-in account the way storage.js receives it (F7).
// The clock ticks from a settable base (__setNow), so a test can cross midnight (F8).
// The account never activates a Personal Day boundary or calendar plans, so Plan
// Authority routes through the legacy calendar-day store, as in the other Brain Dump specs.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireCopy } from '../brain-dump-test-support.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
// Not test-results/: Playwright empties that directory at the start of every run.
const SHOTS = path.join(APP_ROOT, 'playwright-report', 'task-015');
let appServer = null;
let appUrl = '';

const TZ = 'Asia/Manila';
const UID = 'bdtray-user';
const OTHER_UID = 'bdtray-other';
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const clone = value => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
  const snapshot = value => ({ val: () => clone(value), ref: { remove: () => Promise.resolve() } });
  const prune = value => {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value) || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) { const kept = prune(child); if (kept !== undefined) out[key] = kept; }
    return Object.keys(out).length ? out : undefined;
  };
  const remoteKey = root => '__bdtRemote:' + root;
  const readBd = root => JSON.parse(localStorage.getItem(remoteKey(root)) || '{}');
  const writeBd = (root, bd) => localStorage.setItem(remoteKey(root), JSON.stringify(bd));
  const bdListeners = new Map(); // subtree path -> Set(cb)
  const held = new Map();
  window.__bdFail = false;
  window.__bdHold = id => held.set(id, []);
  window.__bdRelease = id => { const q = held.get(id) || []; held.delete(id); q.forEach(fn => fn()); };
  window.__bdHeldCount = id => (held.get(id) || []).length;
  const fireBd = root => (bdListeners.get(root) || new Set()).forEach(cb => cb(snapshot(readBd(root))));
  window.__bdReplay = () => bdListeners.forEach((_listeners, root) => fireBd(root));
  // Another tab committed: its write reaches this tab as the real SDK's listener would deliver it.
  window.addEventListener('storage', event => {
    if (event.key && event.key.startsWith('__bdtRemote:')) fireBd(event.key.slice('__bdtRemote:'.length));
  });
  const bdRoot = p => /\\/brainDump$/.test(p) ? p : null;
  const bdChild = p => { const m = /^(.*\\/brainDump)\\/([^/]+)$/.exec(p); return m ? { root: m[1], id: m[2] } : null; };
  function runBd(root, id, updateFn) {
    const bd = readBd(root);
    const next = updateFn(bd[id] === undefined ? null : clone(bd[id]));
    if (next === undefined) return { committed: false, snapshot: snapshot(bd[id]) };
    const kept = prune(clone(next));
    if (kept === undefined) delete bd[id]; else bd[id] = kept;
    writeBd(root, bd);
    fireBd(root); // real Firebase: events first, then the transaction settles
    return { committed: true, snapshot: snapshot(bd[id]) };
  }
  const makeRef = refPath => ({
    path: refPath, child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) {
      if (eventName !== 'value') return cb;
      const root = bdRoot(refPath);
      if (root) {
        if (!bdListeners.has(root)) bdListeners.set(root, new Set());
        bdListeners.get(root).add(cb);
        const deliver = () => { window.__bdHydrated = true; cb(snapshot(readBd(root))); };
        if (sessionStorage.getItem('task016-hold-hydration')) window.__bdHydrate = deliver;
        else setTimeout(deliver, 0);
        return cb;
      }
      setTimeout(() => cb(snapshot(null)), 0); return cb;
    },
    off() { const root = bdRoot(refPath); if (root) bdListeners.delete(root); },
    once() { return Promise.resolve(snapshot(null)); }, update() { return Promise.resolve(); },
    set() { return Promise.resolve(); }, remove() { return Promise.resolve(); },
    transaction(updateFn) {
      const child = bdChild(refPath);
      if (child) {
        if (window.__bdFail) return Promise.reject(new Error('network'));
        const queue = held.get(child.id);
        if (queue) return new Promise(resolve => queue.push(() => resolve(runBd(child.root, child.id, updateFn))));
        return Promise.resolve(runBd(child.root, child.id, updateFn));
      }
      const value = updateFn(null); return Promise.resolve({ committed: true, snapshot: snapshot(value) });
    },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  const user = uid => (uid ? { uid, displayName: uid, email: uid + '@example.test', photoURL: '' } : null);
  let authCb = null;
  window.__signInAs = uid => authCb(user(uid));
  const auth = () => ({ onAuthStateChanged(cb) { authCb = cb; setTimeout(() => cb(user('${UID}')), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
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

/** Boots the app on My Day. `fresh: false` opens a second tab onto the SAME browser
 *  storage (a real second tab), without resetting it. */
async function openApp(page, { now, fresh = true } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, fresh, uids }) => {
    // Ticks from a settable base: real devices never stamp two clicks with one millisecond.
    const RealDate = Date;
    let base = now;
    // Reload must not move behind an already-persisted claim's timestamp, and a second
    // tab shares the first tab's clock, as two tabs on one device share its wall clock.
    let startedAt = Number(sessionStorage.getItem('bdt-clock-start'))
      || (!fresh && Number(localStorage.getItem('bdt-clock-start'))) || RealDate.now();
    const current = () => base + (RealDate.now() - startedAt);
    window.__setNow = value => { base = value; startedAt = RealDate.now(); };
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [current()])); } static now() { return current(); } };
    if (!fresh || sessionStorage.getItem('bdt-booted') === '1') {
      sessionStorage.setItem('bdt-clock-start', String(startedAt));
      return;
    }
    localStorage.clear(); sessionStorage.clear();
    sessionStorage.setItem('bdt-clock-start', String(startedAt));
    localStorage.setItem('bdt-clock-start', String(startedAt));
    sessionStorage.setItem('bdt-booted', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-device-id', 'device-bdtray');
    for (const uid of uids) {
      localStorage.setItem(`ta3-tz:uid_${uid}`, timezone);
      localStorage.setItem(`ta3-settings:uid_${uid}`, JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
      localStorage.setItem(`ta3-entries:uid_${uid}`, '[]');
      localStorage.setItem(`ta3-plans:uid_${uid}`, '{}');
    }
    localStorage.setItem('ta3-reviews', '{}'); localStorage.setItem('ta3-focus-redemptions', '[]');
  }, { timezone: TZ, now, fresh, uids: [UID, OTHER_UID] });
  if (!fresh) await page.addInitScript(() => sessionStorage.setItem('ta3-session-started', '1'));
  await page.goto(appUrl);
  await page.waitForFunction(uid => typeof window.PlanAuthority === 'object' && typeof window.BrainDumpUI === 'object'
    && typeof window.BrainDumpSync === 'object' && globalThis.getChronaSenseRoomCode?.() === `uid_${uid}`
    && window.PlanAuthority.authorityState() === 'legacy', UID);
  await expect(page.locator('#signin-overlay')).toBeHidden();
  await page.evaluate(() => {
    window.__toasts = [];
    const original = window.showToast;
    window.showToast = (msg, ...rest) => { window.__toasts.push(msg); return original(msg, ...rest); };
    showView('today');
  });
}

/** Captures (and, unless `untriaged`, triages) through the real repository, then
 *  pushes each record to the remote exactly as the Brain Dump view's own writes do. */
function seed(page, rows) {
  return page.evaluate(async rows => {
    const repo = window.BrainDumpRepository;
    const ids = [];
    for (const row of rows) {
      const created = repo.create({ text: row.text, now: Date.now(), updatedBy: 'device-bdtray' });
      const id = created.record.id;
      if (!row.untriaged) repo.triage(id, { important: row.important ?? true, urgent: row.urgent ?? true, now: Date.now(), updatedBy: 'device-bdtray' });
      await window.BrainDumpSync.syncCapture(id);
      ids.push(id);
    }
    window.BrainDumpUI.renderTray();
    return ids;
  }, rows);
}

const tray = page => page.locator('#bd-plan-tray');
const head = page => page.locator('#bd-plan-tray .bdt-head');
const row = (page, id) => page.locator(`#bd-plan-tray [data-bdt-row="${id}"]`);
const todayButton = (page, id) => row(page, id).locator('button', { hasText: /^Today ·/ });
const tomorrowButton = (page, id) => row(page, id).locator('button', { hasText: /^Tomorrow ·/ });
const toasts = page => page.evaluate(() => window.__toasts.slice());
const storage = (page, uid = UID) => page.evaluate(uid => JSON.parse(localStorage.getItem(`ta3-brain-dump-v1:uid_${uid}`) || '{"captures":{}}').captures, uid);
const plans = page => page.evaluate(uid => JSON.parse(localStorage.getItem(`ta3-plans:uid_${uid}`) || '{}'), UID);
const planItemsWithId = async (page, itemId) => Object.values(await plans(page)).flatMap(day => day.items || []).filter(item => item.id === itemId);
const FALSE_CONFLICT = /elsewhere|another device/i;

// Synthetic fixture only: establish the real original claim and its plan item,
// then restore that claim in the cache while the remote still holds it.
async function stuckFixture(page) {
  const [id] = await seed(page, [{ text: 'TASK-016 recovery fixture' }]);
  return page.evaluate(async id => {
    const repo = window.BrainDumpRepository, sync = window.BrainDumpSync;
    sync.detach();
    const refresh = globalThis.refreshBrainDumpSurfaces;
    globalThis.refreshBrainDumpSurfaces = undefined;
    try {
      const target = window.PlanAuthority.current();
      const claim = await sync.claimPromotionRemote(id, { type: 'do-today', store: target.store, targetId: target.id,
        targetKey: target.id, planItemId: 'bdp1|' + id });
      if (!claim.ok) throw new Error(claim.reason);
      const { reconcilePromotionClaim } = await import('../brain-dump-promotion.js');
      const outcome = reconcilePromotionClaim({ repository: repo, planAuthority: window.PlanAuthority, id, now: Date.now(), deviceId: 'fixture-original' });
      if (!outcome.ok) throw new Error(outcome.reason);
      const key = 'ta3-brain-dump-v1:uid_bdtray-user';
      const envelope = JSON.parse(localStorage.getItem(key));
      envelope.captures[id] = claim.record;
      localStorage.setItem(key, JSON.stringify(envelope));
      return { id, claim: claim.record.promotionClaim, item: window.PlanAuthority.rawItems(target).find(item => item.id === 'bdp1|' + id) };
    } finally { globalThis.refreshBrainDumpSurfaces = refresh; }
  }, id);
}

for (const mode of ['warm-before-ui', 'cold-before-ui', 'cold-after-ui']) {
  test(`TASK-016 C3/C4: automatic reload recovery ${mode}, original item unchanged`, async ({ page }) => {
    await openApp(page, { now: at('2026-10-01', '09:00') });
    const fixture = await stuckFixture(page);
    if (mode.startsWith('cold')) await page.evaluate(() => localStorage.removeItem('ta3-brain-dump-v1:uid_bdtray-user'));
    if (mode === 'cold-after-ui') await page.evaluate(() => sessionStorage.setItem('task016-hold-hydration', '1'));
    let release;
    if (mode !== 'cold-after-ui') {
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/brain-dump-ui.js*', async route => { await gate; await route.continue(); });
    }
    const navigation = page.reload();
    if (mode !== 'cold-after-ui') {
      await page.waitForFunction(() => window.BrainDumpSync && window.__bdHydrated && !globalThis.refreshBrainDumpSurfaces);
      expect(await page.evaluate(id => window.BrainDumpRepository.read(id)?.status, fixture.id)).toBe('triaged');
      release();
    } else {
      await navigation;
      await page.waitForFunction(() => window.BrainDumpUI && window.__bdHydrate && window.PlanAuthority?.authorityState() === 'legacy'
        && globalThis.getChronaSenseRoomCode?.() === 'uid_bdtray-user');
      expect(await page.evaluate(id => window.BrainDumpRepository.read(id), fixture.id)).toBe(null);
      await page.evaluate(() => {
        window.__hydrationSweeps = 0;
        const refresh = globalThis.refreshBrainDumpSurfaces;
        globalThis.refreshBrainDumpSurfaces = (...args) => { if (!args[0]) window.__hydrationSweeps++; return refresh(...args); };
        window.__bdHydrate();
      });
      expect(await page.evaluate(() => window.__hydrationSweeps)).toBe(1);
    }
    await navigation;
    await expect.poll(async () => (await storage(page))[fixture.id]?.status).toBe('promoted');
    const record = (await storage(page))[fixture.id];
    expect(record.promotionClaim).toBe(null);
    expect(record.promotion.targetId).toBe(fixture.claim.targetId);
    expect(await planItemsWithId(page, 'bdp1|' + fixture.id)).toEqual([fixture.item]);
  });
}

for (const event of ['online', 'visibilitychange']) test(`TASK-016 C5/B: ${event} recovers once without polling`, async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const fixture = await stuckFixture(page);
  await page.evaluate(event => {
    window.__finalizes = 0;
    const finalize = window.BrainDumpRepository.finalizePromotion;
    window.BrainDumpRepository.finalizePromotion = (...args) => { window.__finalizes++; return finalize(...args); };
    if (event === 'visibilitychange') {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event(event));
      if (window.__finalizes !== 0) throw new Error('hidden document triggered a sweep');
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event(event));
    } else window.dispatchEvent(new Event(event));
  }, event);
  expect(await page.evaluate(() => window.__finalizes)).toBe(1);
  await page.evaluate(() => {
    for (let n = 0; n < 5; n++) {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.BrainDumpSync.handleRemoteSnapshot(window.BrainDumpRepository.listAllRaw());
    }
  });
  await expect.poll(async () => (await storage(page))[fixture.id]?.status).toBe('promoted');
  expect(await page.evaluate(() => window.__finalizes)).toBe(1);
  expect(await planItemsWithId(page, 'bdp1|' + fixture.id)).toEqual([fixture.item]);
});

test('TASK-016 C6: thrown foreground work unlocks the row for a retry', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const [id] = await seed(page, [{ text: 'Retry after throw' }]);
  await expand(page);
  await page.evaluate(async id => {
    const claim = window.BrainDumpSync.claimPromotionRemote;
    window.BrainDumpSync.claimPromotionRemote = () => Promise.reject(new Error('synthetic transport rejection'));
    try { await window.BrainDumpUI.doToday(id); } catch { /* test the finally cleanup */ }
    finally { window.BrainDumpSync.claimPromotionRemote = claim; }
  }, id);
  await expect(todayButton(page, id)).toHaveCount(1);
  expect(await planItemsWithId(page, 'bdp1|' + id)).toEqual([]);
  await todayButton(page, id).click();
  await expect.poll(async () => (await storage(page))[id]?.status).toBe('promoted');
});

for (const [surface, different] of [['tray', false], ['view', false], ['tray', true], ['view', true]]) {
  test(`TASK-016 C8 ${different ? 'competing' : 'same'} stress ${surface}: two tabs converge on the original winning intent`, async ({ context }, testInfo) => {
    const a = await context.newPage(), b = await context.newPage();
    await openApp(a, { now: at('2026-10-01', '09:00') });
    const [id] = await seed(a, [{ text: 'Concurrent synthetic fixture' }]);
    await openApp(b, { now: at('2026-10-01', '09:00'), fresh: false });
    const first = testInfo.repeatEachIndex % 2;
    for (const [index, tab] of [a, b].entries()) {
      if (surface === 'tray') await expand(tab);
      else await tab.evaluate(() => showView('braindump'));
      await tab.evaluate(({ id, surface, tomorrow }) => {
        window.__bdHold(id);
        if (surface === 'tray') {
          const buttons = document.querySelectorAll(`#bd-plan-tray [data-bdt-row="${id}"] .bdt-btn`);
          window.__tap = window.BrainDumpUI.trayPlace(buttons[tomorrow ? 1 : 0], tomorrow ? 'tomorrow' : 'today');
        } else if (tomorrow) {
          window.BrainDumpUI.toggleSchedule(id);
          document.getElementById(`bd-sched-date-${id}`).value = '2026-10-02';
          window.__tap = window.BrainDumpUI.confirmSchedule(id);
        } else window.__tap = window.BrainDumpUI.doToday(id);
      }, { id, surface, tomorrow: index === 1 && different });
      expect(await tab.evaluate(id => window.__bdHeldCount(id), id)).toBe(1);
    }
    const ordered = first ? [b, a] : [a, b];
    await ordered[0].evaluate(id => window.__bdRelease(id), id);
    await ordered[1].evaluate(id => window.__bdRelease(id), id);
    await Promise.all([a.evaluate(() => window.__tap), b.evaluate(() => window.__tap)]);
    // No manual reconciliation/reload/lifecycle stimulation: observations must converge.
    await expect.poll(async () => (await storage(a))[id]?.status, { timeout: 20_000 }).toBe('promoted');
    const capture = (await storage(a))[id];
    const remote = await a.evaluate(id => Object.keys(localStorage).filter(key => key.startsWith('__bdtRemote:'))
      .map(key => JSON.parse(localStorage.getItem(key))[id]).find(Boolean), id);
    expect(remote.status).toBe('promoted');
    expect(remote.promotion).toEqual(wireCopy(capture.promotion));
    expect((await storage(b))[id].promotion).toEqual(capture.promotion);
    expect(capture.promotion.targetId).toBe(different && first === 1 ? '2026-10-02' : '2026-10-01');
    const items = await planItemsWithId(a, 'bdp1|' + id);
    expect(items).toHaveLength(1);
    const messages = [...await toasts(a), ...await toasts(b)];
    expect(messages.some(message => FALSE_CONFLICT.test(message))).toBe(false);
    await testInfo.attach('promotion-stress.json', { contentType: 'application/json', body: JSON.stringify({ surface, first,
      different, stuck: 0, duplicates: items.length - 1,
      falseConflict: !different && messages.some(message => /already being added|different details/i.test(message)) ? 1 : 0 }) });
  });
}

test('TASK-016 C5/C10/C12: revoked UNKNOWN waits for authoritative presence and coalesces repeated observations', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const fixture = await stuckFixture(page);
  await page.evaluate(() => {
    const authority = window.PlanAuthority;
    window.__assertTarget = authority.assertDirectSchedulingTarget;
    authority.assertDirectSchedulingTarget = (_target, now) => { if (now > 0) throw new Error('synthetic ended day'); };
    window.__remotePresence = authority.remoteItemPresence;
    window.__presenceReads = 0;
    authority.remoteItemPresence = () => { window.__presenceReads++; return new Promise(resolve => { window.__resolvePresence = resolve; }); };
    window.dispatchEvent(new Event('online'));
  });
  await page.waitForFunction(() => window.__presenceReads === 1);
  const revoked = (await storage(page))[fixture.id];
  expect(revoked.promotionClaim.revokedAt).toBeTruthy();
  expect(revoked.promotionClaim.claimedAt).toBe(fixture.claim.claimedAt);
  expect(revoked.promotionClaim.claimedBy).toBe(fixture.claim.claimedBy);
  await page.evaluate(() => {
    for (let n = 0; n < 8; n++) {
      window.BrainDumpSync.handleRemoteSnapshot(window.BrainDumpRepository.listAllRaw());
      window.dispatchEvent(new Event('online'));
    }
  });
  expect(await page.evaluate(() => window.__presenceReads)).toBe(1);
  await page.evaluate(() => window.__resolvePresence('unknown'));
  await expect.poll(async () => (await storage(page))[fixture.id]?.status).toBe('triaged');
  expect((await storage(page))[fixture.id].promotionClaim.revokedAt).toBeTruthy();
  // An existing local item did not authorize finalization. A later authoritative
  // presence reply does, without changing its historical data or claim identity.
  await page.evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    window.dispatchEvent(new Event('online'));
  });
  await page.waitForFunction(() => window.__presenceReads === 2);
  await page.evaluate(() => window.__resolvePresence('present'));
  await expect.poll(async () => (await storage(page))[fixture.id]?.status).toBe('promoted');
  expect(await planItemsWithId(page, 'bdp1|' + fixture.id)).toEqual([fixture.item]);
  expect((await storage(page))[fixture.id].promotion.targetId).toBe(fixture.claim.targetId);
});

test('TASK-016 C6: Today then Tomorrow and Schedule are refused during the first round trip', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const [id] = await seed(page, [{ text: 'One foreground request' }]);
  await expand(page);
  await page.evaluate(id => {
    window.__bdHold(id);
    const buttons = document.querySelectorAll(`#bd-plan-tray [data-bdt-row="${id}"] .bdt-btn`);
    window.__tap = window.BrainDumpUI.trayPlace(buttons[0], 'today');
    window.__second = window.BrainDumpUI.trayPlace(buttons[1], 'tomorrow');
    window.BrainDumpUI.toggleSchedule(id);
  }, id);
  expect(await page.evaluate(id => window.__bdHeldCount(id), id)).toBe(1);
  await expect(row(page, id)).toContainText('Still confirming');
  await page.evaluate(id => window.__bdRelease(id), id);
  await page.evaluate(() => Promise.all([window.__tap, window.__second]));
  await expect.poll(async () => (await storage(page))[id]?.status).toBe('promoted');
  expect((await storage(page))[id].promotion.type).toBe('do-today');
  expect((await planItemsWithId(page, 'bdp1|' + id)).length).toBe(1);
  expect((await toasts(page)).some(message => FALSE_CONFLICT.test(message))).toBe(false);
});

test('TASK-016 C6: authoritative listener delivery cannot unlock a still-held foreground response', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const [id] = await seed(page, [{ text: 'Listener before response' }]);
  await expand(page);
  await page.evaluate(id => {
    const sync = window.BrainDumpSync, authority = window.PlanAuthority;
    const claim = sync.claimPromotionRemote;
    window.__targetById = authority.targetById;
    authority.targetById = () => null; // keep the observed claim outstanding
    window.__claimRequests = 0;
    sync.claimPromotionRemote = async (...args) => {
      window.__claimRequests++;
      const result = await claim(...args); // real listener runs before this returns
      await new Promise(resolve => { window.__releaseResponse = resolve; });
      return result;
    };
    const buttons = document.querySelectorAll(`#bd-plan-tray [data-bdt-row="${id}"] .bdt-btn`);
    window.__tomorrowButton = buttons[1];
    window.__tap = window.BrainDumpUI.trayPlace(buttons[0], 'today');
  }, id);
  await page.waitForFunction(() => window.__releaseResponse);
  expect((await storage(page))[id].promotionClaim).toBeTruthy();
  await expect(row(page, id)).toContainText('Still confirming');
  await page.evaluate(() => window.BrainDumpUI.trayPlace(window.__tomorrowButton, 'tomorrow'));
  expect(await page.evaluate(() => window.__claimRequests)).toBe(1);
  await page.evaluate(() => { window.PlanAuthority.targetById = window.__targetById; window.__releaseResponse(); });
  await page.evaluate(() => window.__tap);
  await expect.poll(async () => (await storage(page))[id]?.status).toBe('promoted');
  expect((await planItemsWithId(page, 'bdp1|' + id)).length).toBe(1);
});

async function expand(page) {
  await expect(head(page)).toHaveAttribute('aria-expanded', 'false');
  await head(page).click();
  await expect(head(page)).toHaveAttribute('aria-expanded', 'true');
}

// ═══════════════════════════════════════════════════════════════════════
// F1 — Today: two taps, no view change
// ═══════════════════════════════════════════════════════════════════════

test('F1. Today: expand + Today = 2 taps on My Day; bdp1|<id> lands in items(current()) and renders in the My Day timeline', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const [id] = await seed(page, [{ text: 'Call the bank' }]);
  await expect(head(page)).toContainText('Brain Dump · 1 to plan');
  await expand(page); // tap 1
  await expect(todayButton(page, id)).toHaveText('Today · Thu, Oct 1');
  await todayButton(page, id).click(); // tap 2
  await expect.poll(async () => (await storage(page))[id].status).toBe('promoted');

  const placed = await page.evaluate(itemId => {
    const authority = window.PlanAuthority;
    const today = authority.current();
    return { today: authority.items(today).some(item => item.id === itemId), tomorrow: authority.items(authority.next(today)).some(item => item.id === itemId) };
  }, `bdp1|${id}`);
  expect(placed).toEqual({ today: true, tomorrow: false });
  await expect(page.locator('#view-today')).toHaveClass(/active/);
  await expect(page.locator('#view-braindump')).not.toHaveClass(/active/);
  await expect(page.locator('#timeline-anytime')).toContainText('Call the bank'); // untimed rows render in Anytime
  await expect(tray(page)).toBeHidden(); // nothing left to plan
  expect(await toasts(page)).toContain('Added to today\'s plan.');
});

// ═══════════════════════════════════════════════════════════════════════
// F2 — Tomorrow (owner refinement 2)
// ═══════════════════════════════════════════════════════════════════════

test('F2. Tomorrow: 2 taps put bdp1|<id> on next(current()) only; label date = that target\'s date; next-day timeline and Recently handled agree', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const [id] = await seed(page, [{ text: 'Renew passport', important: true, urgent: false }]);
  await expand(page); // tap 1
  const label = await tomorrowButton(page, id).textContent();
  const nextDay = await page.evaluate(() => {
    const authority = window.PlanAuthority;
    const next = authority.next(authority.current());
    return { id: next.id, dateKey: authority.scheduledDateForTarget(next, '') };
  });
  expect(nextDay.dateKey).toBe('2026-10-02');
  expect(label).toBe('Tomorrow · Fri, Oct 2');
  await tomorrowButton(page, id).click(); // tap 2
  await expect.poll(async () => (await storage(page))[id].status).toBe('promoted');

  const placed = await page.evaluate(itemId => {
    const authority = window.PlanAuthority;
    const today = authority.current();
    const next = authority.next(today);
    return { nextId: next.id, inNext: authority.items(next).some(item => item.id === itemId), inToday: authority.items(today).some(item => item.id === itemId) };
  }, `bdp1|${id}`);
  expect(placed).toEqual({ nextId: nextDay.id, inNext: true, inToday: false });
  expect((await storage(page))[id].promotion.type).toBe('schedule');
  expect((await planItemsWithId(page, `bdp1|${id}`)).length).toBe(1);
  expect(await toasts(page)).toContain('Added to tomorrow\'s plan.');

  // Today's timeline does not show it; the next day's does.
  await expect(page.locator('#timeline-anytime')).not.toContainText('Renew passport');
  await page.locator('#timeline-nav-next').click();
  await expect(page.locator('#timeline-date-label')).toContainText('Oct 2');
  await expect(page.locator('#timeline-anytime')).toContainText('Renew passport');

  await page.evaluate(() => showView('braindump'));
  await expect(page.locator(`[data-bd-handled="${id}"]`)).toContainText('Scheduled · Fri, Oct 2');
});

test('F2. the Tomorrow button is omitted when its date does not round-trip to next(current()); Today stays', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const [id] = await seed(page, [{ text: 'Round trip check' }]);
  await expand(page);
  await expect(tomorrowButton(page, id)).toHaveCount(1);
  // A stubbed authority whose date resolution lands on another day than next(current()).
  await page.evaluate(() => {
    const authority = window.PlanAuthority;
    window.__realDayForScheduledDate = authority.dayForScheduledDate;
    authority.dayForScheduledDate = () => ({ ok: true, anchor: 'noon', target: authority.current() });
    window.BrainDumpUI.renderTray();
  });
  await expect(tomorrowButton(page, id)).toHaveCount(0);
  await expect(todayButton(page, id)).toHaveCount(1);
  // ...and a resolution failure omits it too.
  await page.evaluate(() => {
    window.PlanAuthority.dayForScheduledDate = () => ({ ok: false, reason: 'no-authoritative-day' });
    window.BrainDumpUI.renderTray();
  });
  await expect(tomorrowButton(page, id)).toHaveCount(0);
  await page.evaluate(() => { window.PlanAuthority.dayForScheduledDate = window.__realDayForScheduledDate; window.BrainDumpUI.renderTray(); });
  await expect(tomorrowButton(page, id)).toHaveCount(1);
});

// ═══════════════════════════════════════════════════════════════════════
// F3 — no duplicates
// ═══════════════════════════════════════════════════════════════════════

test('F3. a double tap on Today, both taps in flight before either claim settles, yields exactly one bdp1|<id> item and no false conflict', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const [id] = await seed(page, [{ text: 'Double tapped' }]);
  await expand(page);
  // Hold this capture's transactions so the second tap starts while the first claim is
  // still unsettled — a genuinely concurrent double tap, not two taps in sequence.
  await page.evaluate(id => {
    window.__bdHold(id);
    const button = document.querySelector(`#bd-plan-tray [data-bdt-row="${id}"] .bdt-btn`);
    window.__taps = [window.BrainDumpUI.trayPlace(button, 'today'), window.BrainDumpUI.trayPlace(button, 'today')];
  }, id);
  // The local in-flight guard refuses the second tap before it starts a claim.
  await expect.poll(() => page.evaluate(id => window.__bdHeldCount(id), id)).toBe(1);
  await page.evaluate(id => window.__bdRelease(id), id);
  await page.evaluate(() => Promise.all(window.__taps));
  await expect.poll(async () => (await storage(page))[id].status).toBe('promoted');
  // A tap that lands on the stale button after the first already resolved.
  await page.evaluate(id => {
    const button = document.createElement('button');
    const today = window.PlanAuthority.current();
    Object.assign(button.dataset, { bdtId: id, bdtToday: today.id, bdtTarget: today.id, bdtDate: '2026-10-01' });
    return window.BrainDumpUI.trayPlace(button, 'today');
  }, id);
  expect((await planItemsWithId(page, `bdp1|${id}`)).length).toBe(1);
  // Same tab, so this is not the cross-tab race below: no false conflict is allowed here.
  const told = await toasts(page);
  expect(told.some(m => FALSE_CONFLICT.test(m)), JSON.stringify(told)).toBe(false);
});

for (const first of ['tray', 'view']) {
  test(`F3. the tray in one tab and the Brain Dump view in another, both claims in flight, ${first} tab settles first: exactly one bdp1|<id> item, promoted`, async ({ context }) => {
    const trayTab = await context.newPage();
    await openApp(trayTab, { now: at('2026-10-01', '09:00') });
    const [id] = await seed(trayTab, [{ text: 'Two tabs, one item' }]);
    const viewTab = await context.newPage();
    await openApp(viewTab, { now: at('2026-10-01', '09:00'), fresh: false });
    await viewTab.evaluate(() => showView('braindump'));
    await expect(viewTab.locator(`button[onclick="window.BrainDumpUI.doToday('${id}')"]`)).toHaveCount(1);
    await expand(trayTab);
    await expect(todayButton(trayTab, id)).toHaveCount(1);

    // Each tab holds its own transactions for this capture, then starts its promotion:
    // the view tab through the Brain Dump view's Do today handler, the tray tab through
    // the button it rendered (captured up front, so a re-render cannot take it away).
    // Nothing settles until the releases below, so both claims are in flight together.
    await trayTab.evaluate(id => {
      window.__bdHold(id);
      window.__trayButton = document.querySelector(`#bd-plan-tray [data-bdt-row="${id}"] .bdt-btn`);
      window.__tap = window.BrainDumpUI.trayPlace(window.__trayButton, 'today');
    }, id);
    await viewTab.evaluate(id => {
      window.__bdHold(id);
      window.__tap = window.BrainDumpUI.doToday(id);
    }, id);
    // Both claims are queued in their own tab and nothing has been written yet.
    for (const tab of [trayTab, viewTab]) await expect.poll(() => tab.evaluate(id => window.__bdHeldCount(id), id)).toBe(1);
    expect((await storage(trayTab))[id].status).toBe('triaged');
    expect(await planItemsWithId(trayTab, `bdp1|${id}`)).toEqual([]);
    const [a, b] = first === 'tray' ? [trayTab, viewTab] : [viewTab, trayTab];
    await a.evaluate(id => window.__bdRelease(id), id);
    await b.evaluate(id => window.__bdRelease(id), id);
    await Promise.all([trayTab.evaluate(() => window.__tap), viewTab.evaluate(() => window.__tap)]);

    const snapshot = async () => ({
      local: (await storage(trayTab))[id],
      remote: await trayTab.evaluate(id => Object.keys(localStorage).filter(k => k.startsWith('__bdtRemote:')).map(k => JSON.parse(localStorage.getItem(k))[id]), id),
      items: (await planItemsWithId(trayTab, `bdp1|${id}`)).length,
    });
    // Generous on purpose: this asks "does it settle at all", not "how fast under load".
    try {
      await expect.poll(async () => (await storage(trayTab))[id].status, { timeout: 20_000 }).toBe('promoted');
    } catch {
      throw new Error(`capture did not settle to promoted: ${JSON.stringify(await snapshot())}`);
    }
    await expect.poll(async () => (await planItemsWithId(trayTab, `bdp1|${id}`)).length).toBe(1);
    // One more stale tap from the tray tab after everything settled.
    await trayTab.evaluate(() => window.BrainDumpUI.trayPlace(window.__trayButton, 'today'));
    expect((await planItemsWithId(trayTab, `bdp1|${id}`)).length).toBe(1);
    expect((await storage(viewTab))[id].status).toBe('promoted');
    // No toast assertion here on purpose. The tab that loses this cross-tab race can be told
    // "This item is already being added to your plan on another device." That is pre-existing
    // behaviour of the protected promotion/sync layer (reproducible with two plain Brain Dump
    // views and no tray) and is recorded as a known limitation in TASK_015_HANDOFF.md.
  });
}

// ═══════════════════════════════════════════════════════════════════════
// F4 — 150 captures stay bounded
// ═══════════════════════════════════════════════════════════════════════

test('F4. 150 triaged + 12 untriaged: 5 rows + "Show all (150)", 3 preview rows, collapsed header <=56px; quadrant order holds', async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const quadrants = [[false, false], [false, true], [true, false], [true, true]]; // archive, delegate, schedule, do-first
  const rows = Array.from({ length: 150 }, (_, n) => ({ text: `Triaged ${n}`, important: quadrants[n % 4][0], urgent: quadrants[n % 4][1] }));
  for (let n = 0; n < 12; n++) rows.push({ text: `Untriaged ${n}`, untriaged: true });
  await seed(page, rows);
  await expect(head(page)).toContainText('Brain Dump · 150 to plan · 12 to triage');
  const collapsed = await tray(page).boundingBox();
  expect(collapsed.height).toBeLessThanOrEqual(56);
  await expect(page.locator('#bd-plan-tray .bdt-row')).toHaveCount(0);

  await expand(page);
  await expect(page.locator('#bd-plan-tray .bdt-row')).toHaveCount(5);
  await expect(page.locator('#bd-plan-tray .bdt-preview li')).toHaveCount(3);
  await expect(page.locator('#bd-plan-tray .bdt-chip').first()).toHaveText('Do first');
  // Do first (n = 3, 7, 11, ...) in createdAt order.
  await expect(page.locator('#bd-plan-tray .bdt-row .bdt-text').first()).toHaveText('Triaged 3');
  await page.locator('#bd-plan-tray button', { hasText: 'Show all (150)' }).click();
  await expect(page.locator('#bd-plan-tray .bdt-row')).toHaveCount(150);
  const chips = await page.locator('#bd-plan-tray .bdt-chip').allTextContents();
  const order = ['Do first', 'Schedule', 'Delegate?', 'Archive?'];
  expect(chips.map(c => order.indexOf(c))).toEqual(chips.map(c => order.indexOf(c)).slice().sort((a, b) => a - b));
  // No nested scroll container.
  const scrollers = await page.evaluate(() => [...document.querySelectorAll('#bd-plan-tray *')].filter(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)).length);
  expect(scrollers).toBe(0);

  // The untriaged link opens the Brain Dump view; the tray has no triage controls.
  await expect(page.locator('#bd-plan-tray [onclick*="setTriageAnswer"], #bd-plan-tray [onclick*="saveTriage"]')).toHaveCount(0);
  await expect(page.locator('#bd-plan-tray .bdt-untriaged button')).toHaveText('12 to triage');
  await page.locator('#bd-plan-tray .bdt-untriaged button').click();
  await expect(page.locator('#view-braindump')).toHaveClass(/active/);
  await expect(page.locator('#bd-root')).toContainText('To triage (12)');
});

test('expanded/collapsed is remembered on this device across a reload', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  await seed(page, [{ text: 'Remember me' }]);
  await expand(page);
  await page.reload();
  await page.waitForFunction(() => typeof window.BrainDumpUI === 'object' && window.PlanAuthority?.authorityState() === 'legacy');
  await page.evaluate(() => window.BrainDumpUI.renderTray());
  await expect(head(page)).toHaveAttribute('aria-expanded', 'true');
});

// ═══════════════════════════════════════════════════════════════════════
// F5 — nothing to plan: no tray at all
// ═══════════════════════════════════════════════════════════════════════

test('F5. 0 active captures: the tray is hidden with zero layout height, also once the last one is handled', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  await page.evaluate(() => window.BrainDumpUI.renderTray());
  await expect(tray(page)).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('bd-plan-tray').offsetHeight)).toBe(0);

  const [id] = await seed(page, [{ text: 'Only one', important: false, urgent: false }]);
  await expect(tray(page)).toBeVisible();
  await page.evaluate(id => { window.BrainDumpRepository.archive(id, { now: Date.now(), updatedBy: 'device-bdtray' }); window.BrainDumpUI.renderTray(); }, id);
  await expect(tray(page)).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('bd-plan-tray').offsetHeight)).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════
// F6 — offline: the existing copy, nothing written
// ═══════════════════════════════════════════════════════════════════════

test('F6. offline (claim transaction rejected): existing offline copy, no plan item, the capture stays triaged and placeable', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const [id] = await seed(page, [{ text: 'No connection' }]);
  await page.evaluate(() => { window.__bdFail = true; });
  await expand(page);
  await todayButton(page, id).click();
  await expect.poll(() => toasts(page)).toContain('Could not confirm with the server — check your connection and try again.');
  expect((await storage(page))[id].status).toBe('triaged');
  expect((await storage(page))[id].promotionClaim ?? null).toBe(null);
  expect(await planItemsWithId(page, `bdp1|${id}`)).toEqual([]);
  await tomorrowButton(page, id).click();
  await expect.poll(async () => (await toasts(page)).filter(m => /Could not confirm with the server/.test(m)).length).toBe(2);
  expect((await storage(page))[id].status).toBe('triaged');
  expect(await planItemsWithId(page, `bdp1|${id}`)).toEqual([]);
  await expect(todayButton(page, id)).toHaveCount(1);
});

// ═══════════════════════════════════════════════════════════════════════
// F7 — account switch
// ═══════════════════════════════════════════════════════════════════════

test('F7. account A -> B: the tray shows none of A\'s captures after the switch', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  await seed(page, [{ text: 'Account A secret' }, { text: 'Account A idea', untriaged: true }]);
  await expand(page);
  await expect(tray(page)).toContainText('Account A secret');
  await page.evaluate(uid => window.__signInAs(uid), OTHER_UID);
  await page.waitForFunction(uid => globalThis.getChronaSenseRoomCode?.() === `uid_${uid}`, OTHER_UID);
  await expect(tray(page)).toBeHidden();
  await expect(tray(page)).not.toContainText('Account A');
  expect(await page.evaluate(() => document.getElementById('bd-plan-tray').innerHTML)).toBe('');
});

// ═══════════════════════════════════════════════════════════════════════
// F8 — rendered before midnight, tapped after
// ═══════════════════════════════════════════════════════════════════════

test('F8. a Today or Tomorrow tap made after midnight on a pre-midnight render refuses, writes nothing, and re-renders with the new days', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '23:59') });
  const [id] = await seed(page, [{ text: 'Late night idea' }]);
  await expand(page);
  await expect(todayButton(page, id)).toHaveText('Today · Thu, Oct 1');
  await expect(tomorrowButton(page, id)).toHaveText('Tomorrow · Fri, Oct 2');
  const before = JSON.stringify(await plans(page));

  // Clock change and tap in one task, so no app timer can redraw the tray in between.
  const tapAfter = (ms, kind) => page.evaluate(([ms, id, kind]) => {
    const button = [...document.querySelectorAll(`#bd-plan-tray [data-bdt-row="${id}"] .bdt-btn`)].find(b => b.textContent.startsWith(kind));
    window.__setNow(ms);
    button.click();
  }, [ms, id, kind]);
  await tapAfter(at('2026-10-02', '00:00') + 30_000, 'Today');
  await expect.poll(() => toasts(page)).toContain('The day just changed — check where this goes.');
  expect(JSON.stringify(await plans(page)), 'nothing written').toBe(before);
  expect((await storage(page))[id].status).toBe('triaged');
  await expect(todayButton(page, id)).toHaveText('Today · Fri, Oct 2');
  await expect(tomorrowButton(page, id)).toHaveText('Tomorrow · Sat, Oct 3');

  // Same for a Tomorrow button rendered before the next midnight.
  await tapAfter(at('2026-10-03', '00:00') + 30_000, 'Tomorrow');
  await expect.poll(async () => (await toasts(page)).filter(m => m === 'The day just changed — check where this goes.').length).toBe(2);
  expect(JSON.stringify(await plans(page))).toBe(before);
  expect((await storage(page))[id].status).toBe('triaged');

  // After the re-render, the label is the date the tap lands on.
  await expect(tomorrowButton(page, id)).toHaveText('Tomorrow · Sun, Oct 4');
  await tomorrowButton(page, id).click();
  await expect.poll(async () => (await storage(page))[id].status).toBe('promoted');
  const items = await plans(page);
  expect((items['2026-10-04']?.items || []).some(item => item.id === `bdp1|${id}`)).toBe(true);
  expect((await planItemsWithId(page, `bdp1|${id}`)).length).toBe(1);
});

// ═══════════════════════════════════════════════════════════════════════
// F9 — pending claim on both surfaces
// ═══════════════════════════════════════════════════════════════════════

test('F9. a pending claim shows "Still confirming…" with no Today/Tomorrow in the tray AND the Brain Dump view; it settles to one item', async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page, { now: at('2026-10-01', '09:00') });
  const [id] = await seed(page, [{ text: 'Slow server' }]);
  await page.evaluate(id => window.__bdHold(id), id);
  await expand(page);
  await todayButton(page, id).click();
  await expect(row(page, id)).toContainText('Still confirming…', { timeout: 15_000 });
  // The busy row now also covers the foreground await. Wait for the actual
  // timeout outcome so this still proves UNKNOWN survives finally cleanup.
  await expect.poll(() => toasts(page), { timeout: 15_000 }).toContain('Still confirming…');
  await expect(todayButton(page, id)).toHaveCount(0);
  await expect(tomorrowButton(page, id)).toHaveCount(0);

  await page.evaluate(() => showView('braindump'));
  await expect(page.locator('#bd-root')).toContainText('Still confirming');
  await expect(page.locator(`button[onclick="window.BrainDumpUI.doToday('${id}')"]`)).toHaveCount(0);
  await expect(page.locator(`button[onclick="window.BrainDumpUI.toggleSchedule('${id}')"]`)).toHaveCount(0);

  await page.evaluate(() => showView('today'));
  await page.evaluate(id => window.__bdRelease(id), id);
  await expect.poll(async () => (await storage(page))[id].status).toBe('promoted');
  expect((await planItemsWithId(page, `bdp1|${id}`)).length).toBe(1);
  await expect(tray(page)).toBeHidden();
});

// ═══════════════════════════════════════════════════════════════════════
// F10 — phone width
// ═══════════════════════════════════════════════════════════════════════

const LONG = 'Follow up with the landlord about the broken window latch, the hallway light and the parking permit renewal before the end of the month';

test('F10. 390px: no horizontal scroll and every tray button is >=44px tall; screenshots at 390px and 1920px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, { now: at('2026-10-01', '09:00') });
  await seed(page, [
    { text: LONG }, { text: 'Book dentist', important: true, urgent: false }, { text: 'Ask Sam to send the invoice', important: false, urgent: true },
    { text: 'Clean out the garage', important: false, urgent: false }, { text: 'Pay the electricity bill' }, { text: 'Sixth triaged item' },
    { text: 'Untriaged thought one', untriaged: true }, { text: LONG, untriaged: true },
  ]);
  await expand(page);
  await expect(page.locator('#bd-plan-tray .bdt-row')).toHaveCount(5);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const buttons = page.locator('#bd-plan-tray button');
  const count = await buttons.count();
  expect(count).toBeGreaterThan(10);
  for (let n = 0; n < count; n++) {
    const box = await buttons.nth(n).boundingBox();
    expect(box.height, `button ${n}: ${await buttons.nth(n).textContent()}`).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  // The long text is clamped to two lines.
  const clamp = await page.locator('#bd-plan-tray .bdt-text').first().evaluate(el => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) || 18 }));
  expect(clamp.height).toBeLessThanOrEqual(clamp.line * 2 + 2);

  await fs.mkdir(SHOTS, { recursive: true });
  await tray(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'tray-390x844.png') });
  await tray(page).screenshot({ path: path.join(SHOTS, 'tray-390-element.png') });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await tray(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'tray-1920x1080.png') });
  await tray(page).screenshot({ path: path.join(SHOTS, 'tray-1920-element.png') });
});

test('tray DOM ids never collide with the Brain Dump view\'s', async ({ page }) => {
  await openApp(page, { now: at('2026-10-01', '09:00') });
  await seed(page, [{ text: 'Id check' }, { text: 'Untriaged id check', untriaged: true }]);
  await expand(page);
  await page.evaluate(() => window.BrainDumpUI.render());
  const duplicates = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
    return ids.filter((id, n) => ids.indexOf(id) !== n);
  });
  expect(duplicates).toEqual([]);
  expect(await page.locator('#bd-plan-tray [id]').count()).toBe(0);
});
