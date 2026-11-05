// LOCAL prevention tests. Original loss harness is retained in accounting-hazards/baseline-loss.spec.js.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';
import { accountingCommandRules } from '../accounting-hazards/rules.js';
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
async function saved(page, world, uid, activity = 'Writing', energy = 'deep') {
  await page.evaluate(label => _startTimer(label), activity);
  await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
  await page.evaluate(({ activity, energy }) => { quickLogBusy = false; _doQuickSave(activity, energy); }, { activity, energy });
  await expect.poll(async () => (await remote(world, uid)).timer?.taskStartTime).toBe(T0 + 10 * MIN);
  await expect.poll(async () => (await remote(world, uid)).entries.filter(e => !e.deleted).length).toBe(1);
}

async function install(page) {
  for (const file of ['command-journal.js', 'browser-adapter.js']) {
    await page.addScriptTag({ path: path.join(root, 'accounting-hazards', file) });
  }
  await page.evaluate(() => LocalAccounting.ready);
}
async function enforce(world) {
  const response = await fetch(`${emulator.base}/.settings/rules.json?ns=${world.name}`, {
    method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify(accountingCommandRules()),
  });
  expect(response.status).toBe(200);
}

for (const uid of ['alice', 'bob']) {
  test(`${uid}: Undo waits for an already-submitted ordinary entry/cursor batch`, async ({ context }) => {
    const world = await emulator.fresh(rules), a = await context.newPage(), b = await context.newPage();
    await open(a, world, uid); await saved(a, world, uid); await open(b, world, uid);
    await install(a); await install(b); await enforce(world);
    let release; const held = new Promise(resolve => { release = resolve; }); let submitted = false;
    await a.route(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      submitted = true; await held; return route.continue();
    });
    await a.evaluate(ts => window.__setNow(ts), T0 + 12 * MIN);
    const save = a.evaluate(() => { quickLogBusy = false; return _doQuickSave('Writing', 'deep'); });
    try {
      await expect.poll(() => submitted).toBe(true);
      expect(await b.evaluate(() => LocalAccounting.journal.pending(roomCode)?.phase)).toBe('pending');
      expect(await b.evaluate(() => undoLastAction())).toBe(false);
      expect(await b.evaluate(() => timeAckOpenOperation())).toBeNull();
      expect((await remote(world, uid)).entries.find(e => !e.deleted)?.blockIntervalMin).toBe(10);
      release(); await save;
      const after = await remote(world, uid);
      expect(after.entries.find(e => !e.deleted)?.blockIntervalMin).toBe(12);
      expect(after.timer.taskStartTime).toBe(T0 + 12 * MIN);
      expect(after.entries.find(e => !e.deleted)?._csWrite.operationId).toBe(after.timer._csWrite.operationId);
    } finally { release(); await save.catch(() => {}); }
  });

  test(`${uid}: lost ordinary response survives reload and reconciles one atomic generation`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    await install(page); await enforce(world);
    await page.route(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fetch(); return route.abort('failed');
    });
    await page.evaluate(ts => window.__setNow(ts), T0 + 12 * MIN);
    await page.evaluate(() => { quickLogBusy = false; return _doQuickSave('Writing', 'deep'); });
    // settle() may already observe the committed operation; either way the receipt is one identity.
    await page.unroute(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`);
    await page.reload();
    await page.waitForFunction(room => globalThis.getChronaSenseRoomCode?.() === room && !!_timeAckOnline?.online, `uid_${uid}`);
    await install(page); await page.evaluate(() => LocalAccounting.settle());
    expect(await page.evaluate(() => LocalAccounting.journal.pending(roomCode))).toBeNull();
    const after = await remote(world, uid);
    expect(after.entries.filter(e => !e.deleted)).toHaveLength(1);
    expect(after.entries.find(e => !e.deleted)?.blockIntervalMin).toBe(12);
    expect(after.timer.taskStartTime).toBe(T0 + 12 * MIN);
  });

  test(`${uid}: shared first-read preparation refuses another tab before mutation; next Save covers the full span`, async ({ context }) => {
    const world = await emulator.fresh(rules), a = await context.newPage(), b = await context.newPage();
    await open(a, world, uid); await saved(a, world, uid); await open(b, world, uid);
    await install(a); await install(b); await enforce(world);
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
      expect(await a.evaluate(() => ({ preparing: !!_timeAckPreparing, phase: timeAckOpenOperation()?.phase }))).toEqual({ preparing: true, phase: 'preparing' });
      expect(await b.evaluate(() => timeAckBlocks('Saving'))).toBe(true);
      // Independently delayed SDK channel: agreement REST reads are already captured; tab A's
      // realtime listener cannot learn B's subsequent Save before the original PATCH is sent.
      await a.evaluate(() => firebase.database().goOffline());
      await a.waitForFunction(() => _timeAckOnline?.online === false);
      await b.evaluate(ts => window.__setNow(ts), T0 + 12 * MIN);
      await b.evaluate(() => { quickLogBusy = false; _doQuickSave('Writing', 'deep'); });
      expect((await remote(world, uid)).entries.find(e => !e.deleted)?.blockIntervalMin).toBe(10);
      release(); await undo;
      await expect.poll(async () => (await remote(world, uid)).entries.filter(e => !e.deleted).length).toBe(0);
      await expect.poll(() => b.evaluate(() => taskStartTime)).toBe(T0);
      await b.evaluate(ts => window.__setNow(ts), T0 + 14 * MIN);
      await b.evaluate(() => { quickLogBusy = false; _doQuickSave('Writing', 'deep'); });
      await expect.poll(async () => (await remote(world, uid)).entries.filter(e => !e.deleted).map(e => [e.tsStart, e.ts])).toEqual([[T0, T0 + 14 * MIN]]);
      await expect.poll(async () => (await remote(world, uid)).timer?.taskStartTime).toBe(T0 + 14 * MIN);
    } finally { release(); await undo.catch(() => {}); }
  });

  test(`${uid}: frozen recovery survives late Undo, reload and permanent cancellation with its original two minutes`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    await install(page); await enforce(world);
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
      open: timeAckOpenOperation()?.phase }))).toEqual({ running: true, duration: 10, open: 'unknown' });
    expect((await remote(world, uid)).entries.find(e => !e.deleted)?.blockIntervalMin).toBe(10);
    const response = await fetch(`${emulator.base}/rooms/uid_${uid}.json?ns=${world.name}&auth=${token(uid)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    expect(response.status).toBe(200);
    await expect.poll(() => page.evaluate(() => entries.filter(e => !e.deleted).length)).toBe(0);
    expect(await page.evaluate(() => LocalAccounting.keepServerVersion())).toBe(true);
    await page.unroute(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`);
    await page.reload();
    await page.waitForFunction(room => globalThis.getChronaSenseRoomCode?.() === room && !!_timeAckOnline?.online, `uid_${uid}`);
    await install(page);
    await page.evaluate(() => LocalAccounting.resumeEvents());
    await expect.poll(async () => (await remote(world, uid)).entries.filter(e => !e.deleted).map(e => [e.tsStart, e.ts])).toEqual([[T0 + 10 * MIN, T0 + 12 * MIN]]);
    await expect.poll(async () => (await remote(world, uid)).timer?.running).toBe(false);
    expect(await page.evaluate(() => running)).toBe(false);
    const replay = await fetch(`${emulator.base}/rooms/uid_${uid}.json?ns=${world.name}&auth=${token(uid)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    expect(replay.status).toBe(401);
  });

  test(`${uid}: scheduled logging keeps the original occurrence even if its template changes while UNKNOWN`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    await install(page); await enforce(world);
    const routePattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(routePattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(() => undoLastAction());
    await page.evaluate(() => {
      settings.templates = [{ id: 'scheduled-proof', enabled: true, autoLog: true, days: [3],
        startTime: '07:00', endTime: '08:00', activity: 'Scheduled work', energy: 'nine5' }];
      return autoLogDueTemplates({ notify: false });
    });
    await page.evaluate(() => { settings.templates[0].startTime = '06:00'; settings.templates[0].activity = 'Edited later'; });
    expect(await page.evaluate(() => LocalAccounting.keepServerVersion())).toBe(true);
    await page.unroute(routePattern); await page.evaluate(() => LocalAccounting.resumeEvents());
    const after = (await remote(world, uid)).entries.find(e => e.templateId === 'scheduled-proof');
    expect(after).toMatchObject({ activity: 'Scheduled work', tsStart: Date.parse('2026-10-28T14:00:00Z'),
      ts: Date.parse('2026-10-28T15:00:00Z'), blockIntervalMin: 60 });
    expect(await page.evaluate(() => settings.templates[0].startTime)).toBe('06:00');
  });

  test(`${uid}: PC Time automatic interval stays frozen behind UNKNOWN and is not reclassified`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid, 'PC Time', 'shallow');
    await install(page); await enforce(world);
    const routePattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(routePattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(() => undoLastAction());
    await page.evaluate(({ start, end }) => autoLogBlock('PC Time', 'shallow', start, end), { start: T0 + 10 * MIN, end: T0 + 12 * MIN });
    expect((await remote(world, uid)).entries.filter(e => !e.deleted)).toHaveLength(1);
    expect(await page.evaluate(() => LocalAccounting.keepServerVersion())).toBe(true);
    await page.unroute(routePattern); await page.evaluate(() => LocalAccounting.resumeEvents());
    const after = (await remote(world, uid)).entries.find(e => !e.deleted && e.activity === 'PC Time');
    expect(after).toMatchObject({ energy: 'shallow', tsStart: T0, ts: T0 + 12 * MIN, blockIntervalMin: 12 });
  });

  test(`${uid}: break expiry preserves its original endpoints while Undo is unresolved`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    expect(await page.evaluate(() => startBreak(5))).toBe(true);
    await expect.poll(async () => (await remote(world, uid)).timer?.running).toBe(false);
    await install(page); await enforce(world);
    const routePattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(routePattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(() => undoLastAction());
    await page.evaluate(ts => window.__setNow(ts), T0 + 15 * MIN);
    await page.evaluate(() => endBreak(breakStateOwnerRoom()));
    expect(await page.evaluate(() => breakActive)).toBe(true);
    expect(await page.evaluate(() => LocalAccounting.keepServerVersion())).toBe(true);
    await page.unroute(routePattern); await page.evaluate(ts => window.__setNow(ts), T0 + 20 * MIN);
    await page.evaluate(() => LocalAccounting.resumeEvents());
    const entry = (await remote(world, uid)).entries.find(e => !e.deleted && e.activity === 'Break');
    expect(entry).toMatchObject({ tsStart: T0 + 10 * MIN, ts: T0 + 15 * MIN, blockIntervalMin: 5 });
    expect((await remote(world, uid)).timer?.running).toBe(true);
  });

  test(`${uid}: accidental expired recovery still invalidates its prompt and sends the original ping`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    await install(page); await enforce(world);
    const routePattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(routePattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(() => undoLastAction());
    const beforePing = await page.evaluate(() => pingCount);
    await page.evaluate(({ uid, shutdown, now }) => {
      localStorage.setItem(`ta3-heartbeat-ts:uid_${uid}`, String(shutdown)); window.__setNow(now);
      remaining = 0; restoreHeartbeatRecoveryForAccount(); return handleRecovery(false);
    }, { uid, shutdown: T0 + 40 * MIN, now: T0 + 45 * MIN });
    expect(await page.evaluate(() => !!window._timerRecoveryState)).toBe(true);
    expect(await page.evaluate(() => LocalAccounting.keepServerVersion())).toBe(true);
    await page.unroute(routePattern); await page.evaluate(() => LocalAccounting.resumeEvents());
    expect(await page.evaluate(() => window._timerRecoveryState)).toBeNull();
    expect(await page.evaluate(() => pingCount)).toBe(beforePing + 1);
    expect((await remote(world, uid)).entries.find(e => !e.deleted)?.blockIntervalMin).toBe(10);
  });

  test(`${uid}: a queued automatic extension drains before a newer Save and cannot shrink it`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    await install(page); await enforce(world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(() => undoLastAction());
    await page.evaluate(({ start, end }) => autoLogBlock('Writing', 'deep', start, end), { start: T0 + 10 * MIN, end: T0 + 12 * MIN });
    expect(await page.evaluate(() => LocalAccounting.keepServerVersion())).toBe(true);
    await page.unroute(pattern); await page.evaluate(ts => window.__setNow(ts), T0 + 14 * MIN);
    await page.evaluate(() => { quickLogBusy = false; return _doQuickSave('Writing', 'deep'); });
    await page.evaluate(() => LocalAccounting.resumeEvents());
    expect((await remote(world, uid)).entries.find(e => !e.deleted)).toMatchObject({ ts: T0 + 14 * MIN, blockIntervalMin: 14 });
  });

  test(`${uid}: interruption after event receipt but before key removal cannot repeat completed recovery`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    await install(page); await enforce(world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(() => undoLastAction());
    await page.evaluate(({ uid, shutdown, now }) => {
      localStorage.setItem(`ta3-heartbeat-ts:uid_${uid}`, String(shutdown)); window.__setNow(now);
      restoreHeartbeatRecoveryForAccount(); return handleRecovery(true);
    }, { uid, shutdown: T0 + 12 * MIN, now: T0 + 15 * MIN });
    expect(await page.evaluate(() => LocalAccounting.keepServerVersion())).toBe(true);
    await page.unroute(pattern);
    expect(await page.evaluate(async () => {
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) {
        if (key.startsWith('ta3-accounting-event:')) throw Error('interruption after durable receipt');
        return original.call(this, key);
      };
      try { await LocalAccounting.resumeEvents(); return false; } catch { return true; }
    })).toBe(true);
    await page.reload();
    await page.waitForFunction(room => globalThis.getChronaSenseRoomCode?.() === room && !!_timeAckOnline?.online, `uid_${uid}`);
    await install(page); await page.evaluate(() => LocalAccounting.resumeEvents());
    expect(await page.evaluate(() => LocalAccounting.journal.pending(roomCode))).toBeNull();
    expect(await page.evaluate(() => LocalAccounting.journal.snapshot(roomCode).history.filter(c => c.name === 'handleRecovery').length)).toBe(1);
    expect((await remote(world, uid)).entries.find(e => !e.deleted)?.blockIntervalMin).toBe(12);
  });

  test(`${uid}: a fresh remote takeover revision cannot authorize stale local Save`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    await install(page); await enforce(world);
    await page.evaluate(() => firebase.database().goOffline());
    await page.waitForFunction(() => _timeAckOnline?.online === false);
    const original = (await remote(world, uid)).timer;
    const takeover = { ...original, ownerDeviceId: 'other-device', takeover: true, taskStartTime: T0 + 12 * MIN,
      blockStartTime: T0 + 12 * MIN, updatedAt: T0 + 12 * MIN };
    await world.seed(`rooms/uid_${uid}/timer`, takeover);
    await page.evaluate(ts => window.__setNow(ts), T0 + 14 * MIN);
    expect(await page.evaluate(() => { quickLogBusy = false; return _doQuickSave('Writing', 'deep'); })).toBe(false);
    expect((await remote(world, uid)).timer).toEqual(takeover);
    expect((await remote(world, uid)).entries.find(e => !e.deleted)?.blockIntervalMin).toBe(10);
    expect(await page.evaluate(() => entries.find(e => !e.deleted)?.blockIntervalMin)).toBe(10);
  });

  test(`${uid}: Keep server refuses local-only redemptions and an unapplied authoritative cursor`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    await install(page); await enforce(world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(() => undoLastAction());
    await page.evaluate(() => focusRedemptions.push({ id: 'local-only', activity: 'Legitimate pending reward', updatedAt: Date.now() }));
    expect(await page.evaluate(() => LocalAccounting.keepServerVersion())).toBe(false);
    expect(await page.evaluate(() => focusRedemptions[0]?.id)).toBe('local-only');
    await page.evaluate(() => { focusRedemptions.length = 0; firebase.database().goOffline(); });
    await page.waitForFunction(() => _timeAckOnline?.online === false);
    const original = (await remote(world, uid)).timer;
    await world.seed(`rooms/uid_${uid}/timer`, { ...original, taskStartTime: T0, blockStartTime: T0, updatedAt: original.updatedAt - 1 });
    expect(await page.evaluate(() => LocalAccounting.keepServerVersion())).toBe(false);
    expect(await page.evaluate(() => timeAckOpenOperation()?.phase)).toBe('unknown');
    expect(await page.evaluate(() => taskStartTime)).toBe(T0 + 10 * MIN);
  });

  test(`${uid}: lost cancellation reply keeps the same UNKNOWN through reload and completes on authoritative retry`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    await install(page); await enforce(world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(() => undoLastAction());
    const original = await page.evaluate(() => timeAckOpenOperation());
    await page.unroute(pattern);
    const cancel = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}/timeAckCancellations/*.json*`;
    await page.route(cancel, async route => { await route.fetch(); return route.abort('failed'); });
    expect(await page.evaluate(async () => { try { return await LocalAccounting.keepServerVersion(); } catch { return false; } })).toBe(false);
    expect(await page.evaluate(() => timeAckOpenOperation()?.id)).toBe(original.id);
    await page.reload();
    await page.waitForFunction(room => globalThis.getChronaSenseRoomCode?.() === room && !!_timeAckOnline?.online, `uid_${uid}`);
    await install(page); await page.unroute(cancel);
    expect(await page.evaluate(() => LocalAccounting.keepServerVersion())).toBe(true);
    const envelope = await page.evaluate(room => JSON.parse(localStorage.getItem(`ta3-time-ack:${room}`)), `uid_${uid}`);
    expect(envelope.operation).toBeNull(); expect(envelope.history[0].id).toBe(original.id);
    expect(envelope.history[0].patch).toEqual(original.patch);
  });

  test(`${uid}: a second tab's delayed event refresh cannot reopen an already completed receipt`, async ({ context }) => {
    const world = await emulator.fresh(rules), a = await context.newPage(), b = await context.newPage();
    await open(a, world, uid); await saved(a, world, uid); await open(b, world, uid);
    await install(a); await install(b); await enforce(world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await a.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await a.evaluate(() => undoLastAction());
    await a.evaluate(({ start, end }) => autoLogBlock('Writing', 'deep', start, end), { start: T0 + 10 * MIN, end: T0 + 12 * MIN });
    expect(await a.evaluate(() => LocalAccounting.keepServerVersion())).toBe(true);
    await a.unroute(pattern);
    let release; const held = new Promise(resolve => { release = resolve; }); let reads = 0;
    await b.route(pattern, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(); reads++;
      if (reads === 2) await held; // after receipt precheck, before account lock
      return route.fulfill({ response });
    });
    const stale = b.evaluate(() => LocalAccounting.resumeEvents());
    try {
      await expect.poll(() => reads).toBe(2);
      await b.evaluate(() => firebase.database().goOffline());
      await b.waitForFunction(() => _timeAckOnline?.online === false);
      await a.evaluate(() => LocalAccounting.resumeEvents());
      expect((await remote(world, uid)).entries.find(e => !e.deleted)?.blockIntervalMin).toBe(12);
      release(); await stale;
      expect(await b.evaluate(() => LocalAccounting.journal.pending(roomCode))).toBeNull();
      expect(await b.evaluate(() => LocalAccounting.journal.snapshot(roomCode).history.filter(c => c.name === 'autoLogBlock').length)).toBe(1);
    } finally { release(); await stale.catch(() => {}); }
  });
}
