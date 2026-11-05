// F1: a transient Undo refusal (hydrate or Ping in flight) keeps the Undo button; a retry runs only once valid.
// Integrated production coordinator, real SDK and loopback-only RTDB emulator, both synthetic accounts.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';
import { acknowledgedUndo, holdEvaluates } from './accounting-retained-action.js';

holdEvaluates(test);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = readFileSync(path.join(root, 'firebase.rules.json'), 'utf8');
const allowed = new Set([...computeClosure({ rootDir: root }).files, 'sw.js']);
const MIN = 60000, T0 = Date.parse('2026-10-28T16:00:00Z');
let emulator, server, url;
const proofEndpoint = value => {
  const parsed = new URL(value);
  return ['127.0.0.1', 'localhost'].includes(parsed.hostname) && [String(emulator?.port), url && new URL(url).port].includes(parsed.port);
};

test.use({ serviceWorkers: 'block' });
test.beforeAll(async () => {
  emulator = await startEmulator();
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
    if (!allowed.has(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream' });
    response.end(readFileSync(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); emulator?.stop(); });
test.beforeEach(async ({ context, page }) => {
  page.on('pageerror', error => console.error('[runtime-pageerror]', error.message));
  await context.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
});

async function open(page, world, uid) {
  for (const name of ['app', 'database']) await page.route(`https://www.gstatic.com/firebasejs/10.12.2/firebase-${name}-compat.js`, route => route.fulfill({
    contentType: 'text/javascript', body: readFileSync(path.join(root, `node_modules/firebase/firebase-${name}-compat.js`), 'utf8') }));
  const config = { databaseURL: `${emulator.base}?ns=${world.name}`, projectId: 'demo-unknown-recovery' };
  await page.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js', route => route.fulfill({ contentType: 'text/javascript', body: `(()=>{
    const app=firebase.initializeApp(${JSON.stringify(config)});firebase.initializeApp=()=>app;
    app.database().useEmulator('127.0.0.1',${emulator.port},{mockUserToken:${JSON.stringify(token(uid))}});
    app.database().INTERNAL.forceWebSockets();
    const user={uid:${JSON.stringify(uid)},displayName:'Local proof',email:'proof@example.invalid',getIdToken:()=>Promise.resolve(${JSON.stringify(token(uid))})};
    firebase.auth=()=>({currentUser:user,onAuthStateChanged:fn=>{setTimeout(()=>fn(user),0);return()=>{};},signOut:async()=>{}});
    firebase.auth.GoogleAuthProvider=class{};firebase.auth.GoogleAuthProvider.credential=()=>({});
  })();` }));
  await page.addInitScript(({ T0, uid }) => {
    if (location.protocol !== 'http:') return;
    const RealDate = Date, now = () => Number(localStorage.getItem('__proof-now')) || T0;
    window.__setNow = ts => localStorage.setItem('__proof-now', String(ts));
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } };
    sessionStorage.setItem('ta3-session-started', '1');
    if (!localStorage.getItem('__proof-seeded')) {
      localStorage.setItem('__proof-seeded', '1'); localStorage.setItem('__proof-now', String(T0));
      localStorage.setItem('ta3-onboarded', '1'); localStorage.setItem('ta3-device-id', 'proof-device');
      localStorage.setItem(`ta3-settings:uid_${uid}`, JSON.stringify({ timezone: 'America/Phoenix', intervalMin: 30, sleepSetupDone: true, presets: [], templates: [] }));
      localStorage.setItem(`ta3-tz:uid_${uid}`, 'America/Phoenix');
    }
  }, { T0, uid });
  await page.goto(url);
  await page.waitForFunction(owner => globalThis.getChronaSenseRoomCode?.() === owner && _timeAckOnline?.online, `uid_${uid}`);
}
async function pinned(page) {
  await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4);
  await page.evaluate(() => accountingCoordinator().drain());
}
const remote = async (world, uid) => ({ timer: await world.read(`rooms/uid_${uid}/timer`), entries: Object.values(await world.read(`rooms/uid_${uid}/entries`) || {}) });
// Accounting facts only: write receipts and generated ids differ between otherwise identical runs.
const facts = ({ timer, entries }) => ({
  timer: { running: timer?.running, taskStartTime: timer?.taskStartTime, blockStartTime: timer?.blockStartTime, startedAt: timer?.startedAt },
  entries: entries.map(e => ({ activity: e.activity, energy: e.energy, tsStart: e.tsStart, ts: e.ts, blockIntervalMin: e.blockIntervalMin, deleted: !!e.deleted }))
    .sort((a, b) => a.tsStart - b.tsStart || Number(a.deleted) - Number(b.deleted)),
});
const undoOps = page => page.evaluate(() => { const s = accountingCoordinator().snapshot();
  return [...s.queue, ...s.history].filter(op => op.input?.name === 'undo').map(op => op.id).filter((id, i, all) => all.indexOf(id) === i).length; });

async function savedWithUndoToast(page, world, uid) {
  expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
  await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
  expect(await page.evaluate(() => { quickLogBusy = false; return _doQuickSave('Writing', 'deep'); })).toBe(true);
  await expect.poll(async () => (await remote(world, uid)).entries.filter(e => !e.deleted).length).toBe(1);
  await expect(page.locator('#toast .toast-undo-btn')).toBeVisible();
}
// Holds every accounting REST request for this room until released; the SDK websocket is untouched.
async function holdRoom(page, uid) {
  const held = [], match = value => proofEndpoint(value) && new URL(value).pathname.startsWith(`/rooms/uid_${uid}`);
  let open = true;
  const handler = route => { if (!open) return route.continue(); held.push(route); };
  await page.route(match, handler);
  return { held, release: async () => { open = false; await page.unroute(match, handler);
    for (const route of held.splice(0)) await route.continue().catch(() => {}); } };
}
async function pingInFlight(page, uid) {
  const hold = await holdRoom(page, uid);
  await page.evaluate(() => { window.__inflight = doPing(); });
  await expect.poll(() => hold.held.length).toBeGreaterThan(0);
  return hold;
}
async function seed(page, world, uid) {
  await open(page, world, uid); await pinned(page); await savedWithUndoToast(page, world, uid);
  await page.evaluate(ts => window.__setNow(ts), T0 + 11 * MIN);
  // A published startedAt derives from the ring's remaining, which the 1s ticker refreshes after the clock moves.
  await page.waitForFunction(() => remaining === totalSecs - Math.floor((Date.now() - timerStartedAt) / 1000) % totalSecs);
  return { before: await remote(world, uid), pressed: await page.evaluate(() => cloneUndoValue(lastUndoAction)) };
}
// One refused tap: the copy says nothing ran and nothing is queued, the button stays, nothing moved.
async function refusedTap(page, world, uid, { before, pressed }, copy) {
  const toast = page.locator('#toast'), button = toast.locator('.toast-undo-btn');
  await button.click();
  await expect(toast).toContainText(copy);
  await expect(toast).toContainText(/nothing was changed/i);
  await expect(toast).not.toContainText(/waits|queued/i);
  await expect(button).toBeVisible();
  expect(await page.evaluate(() => cloneUndoValue(lastUndoAction))).toEqual(pressed);
  expect(await undoOps(page)).toBe(0);
  expect(await remote(world, uid)).toEqual(before);
}
async function retriedOnce(page, world, uid, expected) {
  await page.locator('#toast .toast-undo-btn').click();
  await expect(page.locator('#toast')).toContainText('Undid');
  await expect.poll(() => page.evaluate(() => lastUndoAction)).toBeNull();
  expect(await undoOps(page)).toBe(1);
  expect(facts(await remote(world, uid))).toEqual(expected);
}
async function reloadedOnce(page, world, uid, expected) {
  await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page);
  expect(facts(await remote(world, uid))).toEqual(expected);
  expect(await page.evaluate(() => ({ taskStartTime, blockStartTime, live: entries.filter(e => !e.deleted).length, undo: lastUndoAction })))
    .toEqual({ taskStartTime: expected.timer.taskStartTime, blockStartTime: expected.timer.blockStartTime, live: 0, undo: null });
  expect(await page.evaluate(() => undoLastAction())).toBeUndefined();
  await expect(page.locator('#toast')).toContainText('Nothing to undo');
  await expect(page.locator('#toast .toast-undo-btn')).toHaveCount(0);
  expect(facts(await remote(world, uid))).toEqual(expected);
}

for (const uid of ['alice', 'bob']) {
  // Control: the same Save, optional Ping and Undo with nothing in flight, for the exact expected end state.
  async function control(browser, ping) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    try {
      const page = await context.newPage(), world = await emulator.fresh(rules);
      await seed(page, world, uid);
      if (ping) expect(await page.evaluate(() => doPing())).toBe(true);
      expect(await acknowledgedUndo(page)).toBe(true);
      const result = facts(await remote(world, uid));
      expect(result.entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10, deleted: true })]);
      return result;
    } finally { await context.close(); }
  }

  test(`${uid}: Undo refused while a Ping is in flight keeps its button; the retry runs once after it settles`, async ({ page, browser }) => {
    const expected = await control(browser, true);
    const world = await emulator.fresh(rules), state = await seed(page, world, uid);
    const hold = await pingInFlight(page, uid);
    try {
      await refusedTap(page, world, uid, state, 'Undo did not run');
      await refusedTap(page, world, uid, state, 'Undo did not run');
    } finally { await hold.release(); }
    expect(await page.evaluate(() => window.__inflight)).toBe(true);
    await page.waitForFunction(() => !accountingHasPending());
    await retriedOnce(page, world, uid, expected);
    await reloadedOnce(page, world, uid, expected);
  });

  test(`${uid}: Undo refused before hydration has seen every source keeps its button; the retry runs once`, async ({ page, browser }) => {
    const expected = await control(browser, false);
    const world = await emulator.fresh(rules), state = await seed(page, world, uid);
    // The window between account binding and the fourth source snapshot, held open deterministically.
    await page.evaluate(() => window._accountingSourcesSeen.delete('awayState'));
    await refusedTap(page, world, uid, state, 'Checking your confirmed time');
    await refusedTap(page, world, uid, state, 'Checking your confirmed time');
    await page.evaluate(() => { window._accountingSourcesSeen.add('awayState'); return requestAccountingRefresh(); });
    await retriedOnce(page, world, uid, expected);
    await reloadedOnce(page, world, uid, expected);
  });

  test(`${uid}: Undo pressed while a read-only hydrate is in flight is not refused and lands once`, async ({ page, browser }) => {
    const expected = await control(browser, false);
    const world = await emulator.fresh(rules), { before } = await seed(page, world, uid);
    const hold = await holdRoom(page, uid);
    await page.evaluate(() => { window.__inflight = hydrateAccounting(); });
    await expect.poll(() => hold.held.length).toBeGreaterThan(0);
    await page.locator('#toast .toast-undo-btn').click();
    await expect(page.locator('#toast')).not.toContainText('did not run');
    expect(await remote(world, uid)).toEqual(before);
    await hold.release();
    await expect(page.locator('#toast')).toContainText('Undid');
    expect(await undoOps(page)).toBe(1);
    expect(facts(await remote(world, uid))).toEqual(expected);
    await reloadedOnce(page, world, uid, expected);
  });

  test(`${uid}: a Ping refusal keeps the pressed Undo across reload; one later Undo runs once`, async ({ page, browser }) => {
    const expected = await control(browser, true);
    const world = await emulator.fresh(rules), state = await seed(page, world, uid);
    const hold = await pingInFlight(page, uid);
    try { await refusedTap(page, world, uid, state, 'Undo did not run'); } finally { await hold.release(); }
    expect(await page.evaluate(() => window.__inflight)).toBe(true);
    await page.waitForFunction(() => !accountingHasPending());
    const afterPing = await remote(world, uid);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page);
    expect(await remote(world, uid)).toEqual(afterPing);
    expect(await page.evaluate(() => cloneUndoValue(lastUndoAction))).toEqual(state.pressed);
    expect(await undoOps(page)).toBe(0);
    expect(await acknowledgedUndo(page)).toBe(true);
    expect(await undoOps(page)).toBe(1);
    expect(facts(await remote(world, uid))).toEqual(expected);
    expect(await page.evaluate(() => lastUndoAction)).toBeNull();
  });

  test(`${uid}: a persistent block refuses Undo without a retry button or a confirming claim`, async ({ page, browser }) => {
    const expected = await control(browser, false);
    const world = await emulator.fresh(rules), state = await seed(page, world, uid);
    // A failed Focus capture never clears by itself; it needs the status actions, not another Undo tap.
    await page.evaluate(() => _focusCaptureFailures.set(focusCaptureKey(), { failed: true, error: 'proof' }));
    await page.locator('#toast .toast-undo-btn').click();
    const toast = page.locator('#toast');
    await expect(toast).toContainText('Undo is unavailable until your retained time is resolved. Nothing was changed');
    await expect(toast).not.toContainText(/confirmed|try Undo again|waits|queued/i);
    await expect(toast.locator('.toast-undo-btn')).toHaveCount(0);
    expect(await page.evaluate(() => cloneUndoValue(lastUndoAction))).toEqual(state.pressed);
    expect(await undoOps(page)).toBe(0);
    expect(await remote(world, uid)).toEqual(state.before);
    await page.evaluate(() => _focusCaptureFailures.clear());
    expect(await acknowledgedUndo(page)).toBe(true);
    expect(await undoOps(page)).toBe(1);
    expect(facts(await remote(world, uid))).toEqual(expected);
  });
}
