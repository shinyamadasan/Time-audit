// Start-time truth: ordinary Start keeps the invocation instant, not the later acknowledgement instant.
// Integrated production coordinator, real SDK and loopback-only RTDB emulator, both synthetic accounts.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';
import { holdEvaluates } from './accounting-retained-action.js';

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
    const RealDate = Date, counting = localStorage.getItem('__proof-counting') === '1';
    let calls = 0; window.__dateCalls = () => calls;
    const now = () => (Number(localStorage.getItem('__proof-now')) || T0) + (counting ? ++calls : 0);
    window.__setNow = ts => { calls = 0; localStorage.setItem('__proof-now', String(ts)); };
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

const hold = async (page, uid, mode) => {
  const held = [], match = value => proofEndpoint(value) && new URL(value).pathname.startsWith(`/rooms/uid_${uid}`);
  const handler = route => mode === 'fail' ? route.abort('failed')
    : mode === 'write' && route.request().method() === 'GET' ? route.continue() : held.push(route);
  await page.route(match, handler);
  return { release: async () => { await page.unroute(match, handler); for (const route of held.splice(0)) await route.continue().catch(() => {}); },
    held: () => held.length };
};
// Starts in one page tick and returns the instant the person invoked Start, read from the app's own clock.
const tap = (page, task) => page.evaluate(task => {
  const invokedAt = Date.now(); window.__start = _startTimer(task); return invokedAt;
}, task);
const local = page => page.evaluate(() => ({ running, taskStartTime, blockStartTime, timerStartedAt, currentTask }));
// The captured accounting record of this Start: its own instant and the timer it proposed.
const captured = page => page.evaluate(() => {
  const c = accountingCoordinator(), s = c.snapshot();
  const all = [...s.queue, ...s.history, ...c.captures(roomCode).map(item => item.captured)];
  const op = all.find(item => item.input?.ordinary?.kind === 'start');
  return op && { at: op.at, taskStartTime: op.input.after.taskStartTime, blockStartTime: op.input.after.blockStartTime,
    timerStartedAt: op.input.after.timerStartedAt };
});
const authoritative = async (world, uid) => {
  const t = await world.read(`rooms/uid_${uid}/timer`);
  return t && { running: t.running, taskStartTime: t.taskStartTime, blockStartTime: t.blockStartTime, startedAt: t.startedAt };
};
const startedAt = ts => ({ running: true, taskStartTime: ts, blockStartTime: ts, startedAt: ts });
const TAP = T0 + 2 * MIN, LATE = T0 + 9 * MIN;

for (const uid of ['alice', 'bob']) {
  test(`${uid}: normal Start saves the invocation instant`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page);
    await page.evaluate(ts => window.__setNow(ts), TAP);
    expect(await tap(page, 'Writing')).toBe(TAP);
    expect(await page.evaluate(() => window.__start)).toBe(true);
    expect(await captured(page)).toEqual({ at: TAP, taskStartTime: TAP, blockStartTime: TAP, timerStartedAt: TAP });
    await expect.poll(() => authoritative(world, uid)).toEqual(startedAt(TAP));
    expect(await local(page)).toMatchObject({ running: true, taskStartTime: TAP, blockStartTime: TAP, timerStartedAt: TAP });
  });

  for (const delayed of ['read', 'write']) {
    test(`${uid}: Start whose ${delayed} is answered 7 minutes later still saves the invocation instant`, async ({ page }, info) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page);
      const held = await hold(page, uid, delayed === 'write' ? 'write' : 'all');
      await page.evaluate(ts => window.__setNow(ts), TAP);
      expect(await tap(page, 'Writing')).toBe(TAP);
      await expect.poll(held.held).toBeGreaterThan(0);
      expect(await authoritative(world, uid)).toBeNull();
      // Confirmed globals change only after acknowledgement; until then the provisional view carries the start.
      expect(await page.evaluate(() => { const f = ordinaryProvisionalState()?.frame; return f && { taskStartTime: f.taskStartTime, blockStartTime: f.blockStartTime, timerStartedAt: f.timerStartedAt }; }))
        .toEqual({ taskStartTime: TAP, blockStartTime: TAP, timerStartedAt: TAP });
      await page.evaluate(ts => window.__setNow(ts), LATE); // every later step, including any acknowledgement, happens at LATE
      await held.release();
      expect(await page.evaluate(() => window.__start)).toBe(true);
      await page.waitForFunction(() => !accountingCoordinator().snapshot().queue.some(op => ['captured', 'sealed', 'pending', 'accepted'].includes(op.phase)));
      const settled = await page.evaluate(() => accountingCoordinator().snapshot().queue.map(op => ({ name: op.input.name, phase: op.phase, reason: op.reason || null })));
      await info.attach('phase-after-release', { contentType: 'application/json', body: JSON.stringify(settled) });
      await page.evaluate(() => accountingCoordinator().drain()); // the app's own reconcile does this on its next pass
      await expect.poll(() => authoritative(world, uid)).toEqual(startedAt(TAP));
      expect(await captured(page)).toEqual({ at: TAP, taskStartTime: TAP, blockStartTime: TAP, timerStartedAt: TAP });
      expect(await local(page)).toMatchObject({ running: true, taskStartTime: TAP, blockStartTime: TAP, timerStartedAt: TAP });
      await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page);
      expect(await authoritative(world, uid)).toEqual(startedAt(TAP));
      expect(await local(page)).toMatchObject({ running: true, taskStartTime: TAP, blockStartTime: TAP });
    });
  }

  test(`${uid}: offline Start publishes the invocation instant on reconnect`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page);
    const offline = await hold(page, uid, 'fail');
    await page.evaluate(ts => window.__setNow(ts), TAP);
    expect(await tap(page, 'Offline writing')).toBe(TAP);
    expect(await page.evaluate(() => window.__start)).toBe(true);
    expect(await captured(page)).toEqual({ at: TAP, taskStartTime: TAP, blockStartTime: TAP, timerStartedAt: TAP });
    expect(await authoritative(world, uid)).toBeNull();
    await page.evaluate(ts => window.__setNow(ts), LATE);
    await offline.release();
    await page.evaluate(() => accountingCoordinator().drain());
    await expect.poll(() => authoritative(world, uid)).toEqual(startedAt(TAP));
    expect(await local(page)).toMatchObject({ running: true, taskStartTime: TAP, blockStartTime: TAP });
  });

  for (const intentional of [false, true]) {
    test(`${uid}: offline Start recovered after reload (${intentional ? 'stop and log' : 'keep running'}) keeps the invocation instant`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page);
      const offline = await hold(page, uid, 'fail');
      await page.evaluate(ts => window.__setNow(ts), TAP);
      expect(await tap(page, 'Recovered writing')).toBe(TAP);
      expect(await page.evaluate(() => window.__start)).toBe(true);
      await page.evaluate(async at => { window.__setNow(at); await observeOrdinaryProvisional(); }, TAP + 5 * MIN);
      await page.evaluate(ts => window.__setNow(ts), LATE);
      await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page);
      await expect(page.locator('#recovery-overlay')).toBeVisible();
      expect(await page.evaluate(i => handleRecovery(i), intentional)).toBe(true);
      await offline.release();
      await page.evaluate(() => accountingCoordinator().drain());
      if (!intentional) {
        await expect.poll(() => authoritative(world, uid)).toEqual(startedAt(TAP));
      } else {
        // Stop-and-log may end at the last proven observation; the logged span must still begin at the invocation instant.
        await expect.poll(async () => Object.values(await world.read(`rooms/uid_${uid}/entries`) || {}).filter(e => !e.deleted)
          .map(e => ({ activity: e.activity, tsStart: e.tsStart }))).toEqual([{ activity: 'Recovered writing', tsStart: TAP }]);
      }
    });
  }

  test(`${uid}: online Start survives a reload after the interval with the invocation instant`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page);
    await page.evaluate(ts => window.__setNow(ts), TAP);
    expect(await tap(page, 'Writing')).toBe(TAP);
    await expect.poll(() => authoritative(world, uid)).toEqual(startedAt(TAP));
    await page.evaluate(ts => window.__setNow(ts), LATE);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page);
    expect(await local(page)).toMatchObject({ running: true, taskStartTime: TAP, blockStartTime: TAP });
    expect((await authoritative(world, uid)).taskStartTime).toBe(TAP);
  });

  // daily-use-reliability's clock: every Date.now() call adds 1 ms, so boot alone moves it.
  test(`${uid}: counting test clock, not the app, explains the 1.1 s late start in daily-use-reliability`, async ({ page }, info) => {
    const world = await emulator.fresh(rules);
    await page.addInitScript(() => localStorage.setItem('__proof-counting', '1'));
    await open(page, world, uid); await pinned(page);
    const bootCalls = await page.evaluate(() => window.__dateCalls());
    const invokedAt = await tap(page, 'Writing');
    expect(await page.evaluate(() => window.__start)).toBe(true);
    const stamp = (await captured(page)).taskStartTime;
    await expect.poll(async () => (await authoritative(world, uid))?.taskStartTime).toBe(stamp);
    const observation = { T0, bootCalls, invokedAt, stamp, invokedMinusT0: invokedAt - T0, stampMinusInvoked: stamp - invokedAt };
    await info.attach('counting-clock', { contentType: 'application/json', body: JSON.stringify(observation, null, 2) });
    console.log('[counting-clock]', uid, JSON.stringify(observation));
    // The stamp follows the invocation by only the synchronous calls inside _startTimer, before any network.
    expect(observation.stampMinusInvoked).toBeGreaterThan(0);
    expect(observation.stampMinusInvoked).toBeLessThan(50);
    expect(observation.invokedMinusT0).toBeGreaterThanOrEqual(bootCalls);
  });
}
