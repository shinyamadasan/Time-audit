import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-10-07T12:00:00+08:00');
let server;
let appUrl;
// Recording Firebase transport from the existing cross-store isolation browser fixture.
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const log = { writes: [], listeners: [] };
  const tree = {};
  const listeners = new Map();
  const retained = [];
  const get = p => p.split('/').filter(Boolean).reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), tree);
  const put = (p, v) => {
    const segs = p.split('/').filter(Boolean); let n = tree;
    for (let i = 0; i < segs.length - 1; i++) { if (typeof n[segs[i]] !== 'object' || n[segs[i]] === null) n[segs[i]] = {}; n = n[segs[i]]; }
    n[segs[segs.length - 1]] = v;
  };
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const snapshot = value => ({ val: () => clone(value), ref: { remove: () => Promise.resolve() } });
  const fire = p => (listeners.get(p) || []).forEach(cb => cb(snapshot(get(p))));
  const fireUp = p => { let q = p; while (q) { fire(q); q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : ''; } };
  let connected = true;
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
      const value = refPath === '.info/connected' ? connected : get(refPath);
      setTimeout(() => cb(snapshot(value === undefined ? null : value)), 0);
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
    fireLate(p) { retained.filter(r => r.path === p).forEach(r => r.cb(snapshot(get(p)))); },
    setFailWrites(v) { failWrites = v; },
    signInAs(uid) { authCb(user(uid)); },
  };
  const auth = () => ({ onAuthStateChanged(cb) { authCb = cb; setTimeout(() => cb(user('account-a')), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(c) { const a = { config: c }; this.apps.push(a); return a; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
})();`;

test.beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const file = path.resolve(APP_ROOT, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(APP_ROOT + path.sep)) { res.writeHead(403).end(); return; }
      const data = await fs.readFile(file);
      const ext = path.extname(file);
      res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${server.address().port}/`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

async function open(page) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ now }) => {
    const RealDate = Date;
    let frozen = now;
    window.__setNow = value => { frozen = value; };
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [frozen])); } static now() { return frozen; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-device-id', 'intelligence-test-device');
    for (const room of ['uid_account-a', 'uid_account-b']) {
      localStorage.setItem(`ta3-tz:${room}`, 'Asia/Manila');
      localStorage.setItem(`ta3-settings:${room}`, JSON.stringify({ timezone: 'Asia/Manila', intervalMin: 30, templates: [], presets: [], reviewHour: 22, sleepTime: '23:00', wakeTime: '07:00', sleepSetupDone: true }));
      localStorage.setItem(`ta3-entries:${room}`, '[]'); localStorage.setItem(`ta3-plans:${room}`, '{}');
    }
  }, { now: NOW });
  await page.goto(appUrl);
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode?.() === 'uid_account-a' && globalThis.PlanAuthority?.authorityState() === 'legacy' && typeof globalThis.renderIntelligence === 'function' && !!window.BrainDumpRepository);
  await page.locator('#intelligence-panel > summary').click();
  await expect(page.locator('#intelligence-root')).toContainText('Calendar today 2026-10-07');
}

async function seed(page) {
  return page.evaluate(() => {
    const p = createPlanItem('Private planned task', '09:00');
    const target = PlanAuthority.current();
    PlanAuthority.addItem({ destination: target, item: p });
    BrainDumpRepository.create({ text: 'Private capture <img src=x onerror="window.__xss=1">' });
    CommitmentsRepository.create({ title: 'Dentist', date: '2026-10-07', time: '09:00', timezone: 'Asia/Manila' });
    globalThis.renderIntelligence();
    return p.id;
  });
}

test('empty account has a coherent snapshot and no invented obligation', async ({ page }) => {
  await open(page);
  for (const heading of ['Today / attention', 'Plan vs actual', 'Recorded actuals today', 'Open loops', 'Recent patterns']) await expect(page.locator('#intelligence-root h3', { hasText: heading })).toBeVisible();
  await expect(page.locator('#intelligence-root article')).toHaveCount(0);
});
test('plans without actuals stay unknown; captures and elapsed appointments expose their actual source semantics', async ({ page }) => {
  await open(page); await seed(page);
  const plan = page.locator('#intelligence-root article', { hasText: 'Private planned task' });
  await expect(plan.first()).toContainText('Unknown / gap'); await expect(plan.first()).toContainText('Actual unknown');
  await expect(page.locator('#intelligence-root')).toContainText('scheduled time passed', { ignoreCase: true });
  await expect(page.locator('#intelligence-root')).toContainText('Needs triage');
  await expect(page.locator('#intelligence-root img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});
test('linked work is derived, explicit completion is fact, and neither is a title match', async ({ page }) => {
  await open(page); const id = await seed(page);
  await page.evaluate(id => {
    entries.push({ id: 'actual-linked', activity: 'Private planned task', tsStart: Date.now() - 3600000, ts: Date.now() - 1800000, blockIntervalMin: 30, energy: 'deep', planItemId: id });
    globalThis.renderIntelligence();
  }, id);
  await expect(page.locator('#intelligence-root [data-intelligence-kind="derived"]', { hasText: 'Private planned task' }).first()).toContainText('Recorded work');
  await page.evaluate(id => { __setNow(Date.now() + 1); togglePlanDone(id); renderIntelligence(); }, id);
  await expect(page.locator('#intelligence-root [data-intelligence-kind="fact"]', { hasText: 'Private planned task' }).first()).toContainText('Marked done');
});
test('read/refresh is recomputable and creates no domain writes or storage changes', async ({ page }) => {
  await open(page); await seed(page);
  const result = await page.evaluate(async () => {
    const { collectIntelligenceInput } = await import('./intelligence-ui.js?v=20261007-intelligence-v1');
    const before = Object.fromEntries(Object.keys(localStorage).filter(k => k.includes(':uid_')).sort().map(k => [k, localStorage.getItem(k)]));
    const writes = __fbTest.log.writes.length;
    collectIntelligenceInput(); renderIntelligence(); renderIntelligence();
    const after = Object.fromEntries(Object.keys(localStorage).filter(k => k.includes(':uid_')).sort().map(k => [k, localStorage.getItem(k)]));
    return { before, after, writes, afterWrites: __fbTest.log.writes.length };
  });
  expect(result.after).toEqual(result.before); expect(result.afterWrites).toBe(result.writes);
});
test('direct account switch and sign-out clear even the hidden snapshot DOM', async ({ page }) => {
  await open(page); await seed(page);
  await page.locator('#intelligence-panel > summary').click();
  await page.evaluate(() => __fbTest.signInAs('account-b'));
  await page.waitForFunction(() => getChronaSenseRoomCode() === 'uid_account-b');
  await expect(page.locator('#intelligence-root')).toHaveText('');
  await page.locator('#intelligence-panel > summary').click();
  await expect(page.locator('#intelligence-root')).not.toContainText('Private');
  await page.evaluate(() => __fbTest.signInAs(null));
  await expect(page.locator('#intelligence-root')).toContainText('Sign in');
  await expect(page.locator('#intelligence-root')).not.toContainText('Private');
});
test('repeated activity pattern and approximate broad evidence remain distinct from plans', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    for (let n = 0; n < 3; n++) entries.push({ id: `repeat-${n}`, activity: 'Writing', tsStart: Date.now() - n * 86400000 - 3600000, ts: Date.now() - n * 86400000 - 1800000, blockIntervalMin: 30, energy: 'deep' });
    CoarseLifeEvidenceSync.repository.save({ date: '2026-10-07', timezone: 'Asia/Manila', label: 'Cooking', estimatedMinutes: 50 });
    renderIntelligence();
  });
  await expect(page.locator('#intelligence-root [data-intelligence-kind="pattern"]')).toContainText('Recorded on 3 of 7 calendar dates');
  await expect(page.locator('#intelligence-root')).toContainText('Approximate · no placement');
});
test('passive, scheduled and PC context evidence cannot turn an unknown plan into actual work', async ({ page }) => {
  await open(page); const id = await seed(page);
  await page.evaluate(id => {
    for (const [n, flags] of [{ scheduledAutoLog: true }, { browserUsage: true }, { autoLogged: true }].entries()) {
      entries.push({ id: `unverified-${n}`, activity: n === 2 ? 'PC Time' : 'Private planned task', planItemId: id, tsStart: Date.now() - 3600000, ts: Date.now() - 1800000, blockIntervalMin: 30, energy: 'deep', ...flags });
    }
    renderIntelligence();
  }, id);
  await expect(page.locator('#intelligence-root article', { hasText: 'Private planned task' }).first()).toContainText('Actual unknown');
  await expect(page.locator('#intelligence-root')).not.toContainText('Recorded work');
});
test('mobile disclosure fits viewport with long source text', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page); await seed(page);
  expect(await page.locator('#intelligence-root').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.locator('#intelligence-refresh')).toBeVisible();
});

test('live session requires current account ownership and never counts as logged actual time', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { currentTask = 'Unowned secret session'; running = true; renderIntelligence(); running = false; });
  await expect(page.locator('#intelligence-root')).not.toContainText('Unowned secret');
  await page.evaluate(() => { currentTask = 'Owned active session'; claimTimerStateOwnership(); running = true; renderIntelligence(); running = false; releaseTimerStateOwnership(); });
  await expect(page.locator('#intelligence-root')).toContainText('Owned active session');
  await expect(page.locator('#intelligence-root [data-record-key="session"]')).toContainText('Timer running');
  await expect(page.locator('#intelligence-root [data-record-key^="entry:"]')).toHaveCount(0);
});

test('normalized collector drops all source data on an account-context mismatch', async ({ page }) => {
  await open(page); await seed(page);
  const snapshot = await page.evaluate(async () => {
    const { collectIntelligenceInput } = await import('./intelligence-ui.js?v=20261007-intelligence-v1');
    const original = getIntelligenceAppContext;
    globalThis.getIntelligenceAppContext = (...args) => ({ ...original(...args), contextOwner: 'uid_other-account' });
    try { return collectIntelligenceInput(); }
    finally { globalThis.getIntelligenceAppContext = original; }
  });
  expect(Object.keys(snapshot).sort()).toEqual(['contextOwner', 'now', 'owner']);
  expect(snapshot.contextOwner).toBeNull();
  expect(JSON.stringify(snapshot)).not.toContain('Private');
});
