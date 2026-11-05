// LOCAL HAZARD REPRODUCTIONS against unchanged 9b0671b runtime; passing means hazard exists.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = readFileSync(path.join(root, 'firebase.rules.json'), 'utf8');
const allowed = new Set([...computeClosure({ rootDir: root }).files, 'sw.js']);
const MIN = 60000, T0 = Date.parse('2026-10-28T16:00:00Z');
let emulator, server, url;
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
test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
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
  await page.waitForFunction(owner => globalThis.getChronaSenseRoomCode?.() === owner && typeof _timeAckOnline !== 'undefined' && _timeAckOnline?.online, `uid_${uid}`);
}
const remote = async (world, uid) => ({ timer: await world.read(`rooms/uid_${uid}/timer`), entries: Object.values(await world.read(`rooms/uid_${uid}/entries`) || {}) });
async function saved(page, world, uid) {
  await page.evaluate(() => _startTimer('Writing'));
  await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
  await page.evaluate(() => { quickLogBusy = false; _doQuickSave('Writing', 'deep'); });
  await expect.poll(async () => (await remote(world, uid)).timer?.taskStartTime).toBe(T0 + 10 * MIN);
  await expect.poll(async () => (await remote(world, uid)).entries.filter(e => !e.deleted).length).toBe(1);
}

for (const uid of ['alice', 'bob']) {
  test(`${uid}: first-read gap permits cross-tab Save; stale agreement can erase its extension`, async ({ context }) => {
    const world = await emulator.fresh(rules), a = await context.newPage(), b = await context.newPage();
    await open(a, world, uid); await saved(a, world, uid); await open(b, world, uid);
    let release; const held = new Promise(resolve => { release = resolve; });
    let captured = 0;
    await a.route(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}/**`, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(); captured++;
      await held; await route.fulfill({ response });
    });
    const undo = a.evaluate(() => undoLastAction());
    try {
      await expect.poll(() => captured).toBe(2);
      expect(await a.evaluate(() => ({ preparing: !!_timeAckPreparing, operation: timeAckOpenOperation() }))).toEqual({ preparing: true, operation: null });
      expect(await b.evaluate(() => timeAckBlocks('Saving'))).toBe(false);
      // Independently delayed SDK channel: agreement REST reads are already captured; tab A's
      // realtime listener cannot learn B's subsequent Save before the original PATCH is sent.
      await a.evaluate(() => firebase.database().goOffline());
      await a.waitForFunction(() => _timeAckOnline?.online === false);
      await b.evaluate(ts => window.__setNow(ts), T0 + 12 * MIN);
      await b.evaluate(() => { quickLogBusy = false; _doQuickSave('Writing', 'deep'); });
      await expect.poll(async () => (await remote(world, uid)).entries.find(e => !e.deleted)?.blockIntervalMin).toBe(12);
      release(); await undo;
      await expect.poll(async () => (await remote(world, uid)).entries.filter(e => !e.deleted).length).toBe(0);
      // B correctly ignores the older timer timestamp. Its cursor remains at 12m while the
      // record that held 0..12m has been replaced by A's stale 0..10m tombstone.
      await expect.poll(() => b.evaluate(() => taskStartTime)).toBe(T0 + 12 * MIN);
      await b.evaluate(ts => window.__setNow(ts), T0 + 14 * MIN);
      await b.evaluate(() => { quickLogBusy = false; _doQuickSave('Writing', 'deep'); });
      await expect.poll(async () => (await remote(world, uid)).entries.filter(e => !e.deleted).map(e => [e.tsStart, e.ts])).toEqual([[T0 + 12 * MIN, T0 + 14 * MIN]]);
      await expect.poll(async () => (await remote(world, uid)).timer?.taskStartTime).toBe(T0 + 14 * MIN);
    } finally { release(); await undo.catch(() => {}); }
  });

  test(`${uid}: intentional crash recovery extends a held record then late Undo loses the extension`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    let patch;
    await page.route(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`, route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      patch = route.request().postDataJSON(); return route.abort('failed');
    });
    await page.evaluate(() => undoLastAction());
    expect(await page.evaluate(() => timeAckOpenOperation()?.phase)).toBe('unknown');
    await page.evaluate(({ uid, shutdown, now }) => {
      localStorage.setItem(`ta3-heartbeat-ts:uid_${uid}`, String(shutdown));
      window.__setNow(now); restoreHeartbeatRecoveryForAccount(); handleRecovery(true);
    }, { uid, shutdown: T0 + 12 * MIN, now: T0 + 15 * MIN });
    expect(await page.evaluate(() => ({ running, duration: entries.find(e => !e.deleted)?.blockIntervalMin,
      open: timeAckOpenOperation()?.phase }))).toEqual({ running: false, duration: 12, open: 'unknown' });
    // The automatic extension is local-only because syncEntries correctly holds this path.
    expect((await remote(world, uid)).entries.find(e => !e.deleted)?.blockIntervalMin).toBe(10);
    const response = await fetch(`${emulator.base}/rooms/uid_${uid}.json?ns=${world.name}&auth=${token(uid)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    expect(response.status).toBe(200);
    await expect.poll(() => page.evaluate(() => entries.filter(e => !e.deleted).length)).toBe(0);
    await page.evaluate(() => timeAckReconcile());
    await expect.poll(async () => (await remote(world, uid)).entries.filter(e => !e.deleted).length).toBe(0);
    await expect.poll(async () => (await remote(world, uid)).timer?.running).toBe(false);
    expect(await page.evaluate(() => running)).toBe(false);
  });
}
