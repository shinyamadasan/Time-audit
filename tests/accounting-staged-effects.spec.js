// Integrated production coordinator, real SDK and loopback-only RTDB emulator.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';
import { acknowledgedUndo, holdEvaluates, retainedAccountingResult } from './accounting-retained-action.js';

holdEvaluates(test);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = readFileSync(path.join(root, 'firebase.rules.json'), 'utf8');
const allowed = new Set([...computeClosure({ rootDir: root }).files, 'sw.js']);
const beforeFixture = process.env.CHRONASENSE_ACCOUNTING_RUNTIME_FIXTURE
  ? path.resolve(root, process.env.CHRONASENSE_ACCOUNTING_RUNTIME_FIXTURE) : null;
if (beforeFixture && !beforeFixture.startsWith(path.join(root, 'test-results') + path.sep)) throw Error('Before fixture must be inside local test-results');
const runtimeSnapshots = new Map([...allowed].map(file => [file, readFileSync(
  beforeFixture && existsSync(path.join(beforeFixture, file)) ? path.join(beforeFixture, file) : path.join(root, file))]));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const manifest = { test: sha256(readFileSync(fileURLToPath(import.meta.url))), rules: sha256(rules),
  files: Object.fromEntries([...runtimeSnapshots].map(([file, body]) => [file, sha256(body)])) };
const MIN = 60000, T0 = Date.parse('2026-10-28T16:00:00Z');
let emulator, server, url;
function proofEndpoint(value) {
  const parsed = new URL(value);
  return ['127.0.0.1', 'localhost'].includes(parsed.hostname)
    && [String(emulator?.port), url && new URL(url).port].includes(parsed.port);
}

test.use({ serviceWorkers: 'block' });
test.beforeAll(async ({}, info) => {
  await info.attach('exact-runtime-manifest', { contentType: 'application/json', body: JSON.stringify(manifest, null, 2) });
  emulator = await startEmulator();
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
    if (!allowed.has(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream' });
    response.end(runtimeSnapshots.get(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); emulator?.stop(); });
test.beforeEach(async ({ context, page }) => {
  page.on('pageerror', error => console.error('[runtime-pageerror]', error.message));
  await context.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
});

async function open(page, world, uid, device = 'proof-device') {
  for (const name of ['app', 'database']) await page.route(`https://www.gstatic.com/firebasejs/10.12.2/firebase-${name}-compat.js`, route => route.fulfill({
    contentType: 'text/javascript', body: readFileSync(path.join(root, `node_modules/firebase/firebase-${name}-compat.js`), 'utf8') }));
  const config = { databaseURL: `${emulator.base}?ns=${world.name}`, projectId: 'demo-unknown-recovery' };
  await page.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js', route => route.fulfill({ contentType: 'text/javascript', body: `(()=>{
    const app=firebase.initializeApp(${JSON.stringify(config)});firebase.initializeApp=()=>app;
    app.database().useEmulator('127.0.0.1',${emulator.port},{mockUserToken:${JSON.stringify(token(uid))}});
    app.database().INTERNAL.forceWebSockets();
    if (localStorage.getItem('__proof-offline-sdk') === '1') app.database().goOffline();
    const user={uid:${JSON.stringify(uid)},displayName:'Local proof',email:'proof@example.invalid',getIdToken:()=>Promise.resolve(${JSON.stringify(token(uid))})};
    firebase.auth=()=>({currentUser:user,onAuthStateChanged:fn=>{setTimeout(()=>fn(user),0);return()=>{};},signOut:async()=>{}});
    firebase.auth.GoogleAuthProvider=class{};firebase.auth.GoogleAuthProvider.credential=()=>({});
  })();` }));
  await page.addInitScript(({ T0, uid, device }) => {
    if (location.protocol !== 'http:') return;
    const RealDate = Date, now = () => Number(localStorage.getItem('__proof-now')) || T0;
    window.__setNow = ts => localStorage.setItem('__proof-now', String(ts));
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } };
    sessionStorage.setItem('ta3-session-started', '1');
    if (!localStorage.getItem('__proof-seeded')) {
      localStorage.setItem('__proof-seeded', '1'); localStorage.setItem('__proof-now', String(T0));
      localStorage.setItem('ta3-onboarded', '1'); localStorage.setItem('ta3-device-id', device);
      localStorage.setItem(`ta3-settings:uid_${uid}`, JSON.stringify({ timezone: 'America/Phoenix', intervalMin: 30, sleepSetupDone: true, presets: [], templates: [] }));
      localStorage.setItem(`ta3-tz:uid_${uid}`, 'America/Phoenix');
    }
  }, { T0, uid, device });
  await page.goto(url);
  await page.waitForFunction(owner => globalThis.getChronaSenseRoomCode?.() === owner && typeof _timeAckOnline !== 'undefined' && _timeAckOnline?.online, `uid_${uid}`);
}
const remote = async (world, uid) => ({ timer: await world.read(`rooms/uid_${uid}/timer`), entries: Object.values(await world.read(`rooms/uid_${uid}/entries`) || {}) });
async function saved(page, world, uid, activity = 'Writing', energy = 'deep') {
  await page.evaluate(label => _startTimer(label), activity);
  await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
  await page.evaluate(({ activity, energy }) => { quickLogBusy = false; return _doQuickSave(activity, energy); }, { activity, energy });
  await expect.poll(async () => (await remote(world, uid)).timer?.taskStartTime).toBe(T0 + 10 * MIN);
  await expect.poll(async () => (await remote(world, uid)).entries.filter(e => !e.deleted).length).toBe(1);
}


async function pinned(page, world) {
  await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4);
  const response = await fetch(`${emulator.base}/.settings/rules.json?ns=${world.name}`, {
    method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules,
  });
  expect(response.status).toBe(200);
  await page.evaluate(async () => {
    await accountingCoordinator().drain();
  });
}
for (const uid of ['alice', 'bob']) {
  for (const acknowledgeBeforeChoice of [false, true]) {
    test(`${uid}: O1 recovery expiry stays frozen while modal crosses deadline; ACK before choice ${acknowledgeBeforeChoice}`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`; await page.route(pattern, route => route.abort('failed'));
      expect(await page.evaluate(() => _startTimer('Frozen recovery decision'))).toBe(true);
      await page.evaluate(async at => { window.__setNow(at); await observeOrdinaryProvisional(); }, T0 + 5 * MIN);
      await page.evaluate(at => window.__setNow(at), T0 + 10 * MIN);
      await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
      await expect(page.locator('#recovery-overlay')).toBeVisible();
      await page.evaluate(at => window.__setNow(at), T0 + 45 * MIN);
      if (acknowledgeBeforeChoice) { await page.unroute(pattern); await page.evaluate(() => accountingCoordinator().drain()); }
      expect(await page.evaluate(() => handleRecovery(false))).toBe(true);
      await page.evaluate(at => window.__setNow(at), T0 + 90 * MIN);
      if (!acknowledgeBeforeChoice) await page.unroute(pattern);
      await page.evaluate(async () => { await accountingCoordinator().drain(); clearInterval(ticker); ticker = null; });
      expect((await remote(world, uid)).timer).toMatchObject({ taskStartTime: T0, blockStartTime: T0, startedAt: T0 });
      expect(await page.evaluate(() => pingCount)).toBe(0); expect((await remote(world, uid)).entries).toEqual([]);
    });
  }
  for (const failure of ['quota', 'readback']) {
    test(`${uid}: O1 Start ${failure} failure never reports durable success and retries original identity time and configuration`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`; await page.route(pattern, route => route.abort('failed'));
      await page.evaluate(failure => {
        const read = Storage.prototype.getItem, write = Storage.prototype.setItem;
        const matches = (key, raw) => key.startsWith('ta3-accounting-capture-v1:') && raw?.includes('"name":"start-timer"');
        if (failure === 'quota') Storage.prototype.setItem = function (key, raw) {
          if (this === localStorage && matches(key, raw)) { Storage.prototype.setItem = write; throw Error('Start quota'); }
          return write.call(this, key, raw);
        };
        else Storage.prototype.getItem = function (key) {
          const raw = read.call(this, key);
          if (this === localStorage && matches(key, raw)) { Storage.prototype.getItem = read; throw Error('Start readback'); }
          return raw;
        };
      }, failure);
      expect(await page.evaluate(() => _startTimer('Failed original capture', 'original-plan'))).toBe(false);
      const original = await page.evaluate(() => accountingCoordinator().failedCaptures(roomCode)[0]);
      expect(original.at).toBe(T0); expect(await page.evaluate(() => ordinaryProvisionalState())).toBeNull();
      expect(await page.evaluate(() => ({ running, entries, lastUndoAction }))).toEqual({ running: false, entries: [], lastUndoAction: null });
      await page.evaluate(at => { window.__setNow(at); document.getElementById('interval-input').value = '15'; }, T0 + 60 * MIN);
      await page.evaluate(() => timeAckUserAction('check'));
      const retained = await page.evaluate(id => accountingCoordinator().snapshot().queue.find(op => op.id === id), original.id);
      expect(retained.input).toEqual(original.input); expect(retained.at).toBe(T0);
      await page.unroute(pattern); await page.evaluate(async () => { await accountingCoordinator().drain(); clearInterval(ticker); ticker = null; });
      expect((await remote(world, uid)).timer).toMatchObject({ taskStartTime: T0, startedAt: T0, intervalSecs: 1800, lastTask: 'Failed original capture' });
      expect((await remote(world, uid)).entries).toEqual([]);
    });
  }
  for (const elapsed of [10, 45]) {
    test(`${uid}: O1 accidental recovery at ${elapsed} minutes freezes the original phase observation across a late ACK`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`; await page.route(pattern, route => route.abort('failed'));
      expect(await page.evaluate(() => _startTimer('Original recovery phase'))).toBe(true);
      await page.evaluate(async at => { window.__setNow(at); await observeOrdinaryProvisional(); }, T0 + 5 * MIN);
      await page.evaluate(at => window.__setNow(at), T0 + elapsed * MIN);
      await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
      await expect(page.locator('#recovery-overlay')).toBeVisible(); expect(await page.evaluate(() => handleRecovery(false))).toBe(true);
      const fact = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.ordinary?.kind === 'resume'));
      expect(fact).toBeTruthy(); expect(fact.at).toBe(T0 + elapsed * MIN);
      expect(await page.evaluate(() => ordinaryProvisionalState().observedAt)).toBe(T0 + elapsed * MIN);
      expect(await page.evaluate(() => ({ running, pingCount, entries }))).toEqual({ running: false, pingCount: 0, entries: [] });
      await page.evaluate(at => window.__setNow(at), T0 + 90 * MIN);
      await page.unroute(pattern); await page.evaluate(async () => { await accountingCoordinator().drain(); clearInterval(ticker); ticker = null; });
      const phase = elapsed >= 30 ? T0 + elapsed * MIN : T0;
      expect((await remote(world, uid)).timer).toMatchObject({ taskStartTime: T0, blockStartTime: phase, startedAt: phase });
      expect(await page.evaluate(() => pingCount)).toBe(elapsed >= 30 ? 1 : 0);
      expect((await remote(world, uid)).entries).toEqual([]);
    });
  }
  test(`${uid}: O1 two complete offline sessions remain visible and excluded from confirmed totals exports and Undo`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`; await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('Offline first'))).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 + 10 * MIN); expect(await retainedAccountingResult(page, 'stop')).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 + 12 * MIN); expect(await page.evaluate(() => _startTimer('Offline second'))).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 + 20 * MIN); expect(await retainedAccountingResult(page, 'stop')).toBe(true);
    await expect(page.locator('#ordinary-provisional')).toContainText('Offline first');
    await expect(page.locator('#ordinary-provisional')).toContainText('Offline second');
    expect(await page.evaluate(() => {
      window.__o1ExportAttempt = false; URL.createObjectURL = () => { window.__o1ExportAttempt = true; return 'blob:o1-test'; };
      HTMLAnchorElement.prototype.click = () => {}; exportCSV(); undoLastAction();
      return { exported: window.__o1ExportAttempt, today: getTodayEntries(), entries, lastUndoAction, redemptions: focusRedemptions };
    })).toEqual({ exported: false, today: [], entries: [], lastUndoAction: null, redemptions: [] });
    const originals = await page.evaluate(() => accountingCoordinator().snapshot().queue.filter(op => op.input.ordinary).map(op => ({ id: op.id, at: op.at, input: op.input })));
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    expect(await page.evaluate(() => accountingCoordinator().snapshot().queue.filter(op => op.input.ordinary).map(op => ({ id: op.id, at: op.at, input: op.input })))).toEqual(originals);
    await page.unroute(pattern); await page.evaluate(() => accountingCoordinator().drain());
    expect((await remote(world, uid)).entries.sort((a, b) => a.ts - b.ts)).toEqual([
      expect.objectContaining({ activity: 'Offline first', tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 }),
      expect.objectContaining({ activity: 'Offline second', tsStart: T0 + 12 * MIN, ts: T0 + 20 * MIN, blockIntervalMin: 8 })]);
    await expect(page.locator('#ordinary-provisional')).toBeHidden();
  });
  test(`${uid}: O1 unsupported provisional version stays intact and visibly blocks capture rather than throwing or publishing`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`; await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('Unsupported original'))).toBe(true);
    const original = await page.evaluate(() => {
      const key = `${AccountingCommand.BASE}:${roomCode}`, state = JSON.parse(localStorage.getItem(key));
      const op = state.queue.find(item => item.input.ordinary); op.input.ordinary.v = 999;
      localStorage.setItem(key, JSON.stringify(state)); renderTimeAckStatus(); return op.input;
    });
    expect(await page.evaluate(() => _startTimer('Refused new capture'))).toBe(false);
    await expect(page.locator('#time-ack-status')).toBeVisible();
    expect(await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.ordinary).input)).toEqual(original);
    expect((await remote(world, uid)).timer).toBeNull(); expect(await page.evaluate(() => entries)).toEqual([]);
  });
  test(`${uid}: O1 offline SDK bootstrap permits Stop from its validated durable canonical base without waiting for realtime listeners`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('Fully disconnected source'))).toBe(true);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.ordinary));
    await page.evaluate(at => { window.__setNow(at); localStorage.setItem('__proof-offline-sdk', '1'); fbDb.goOffline(); }, T0 + 10 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity());
    expect(await page.evaluate(() => _timeAckOnline?.online)).toBe(false);
    expect(await retainedAccountingResult(page, 'stop')).toBe(true);
    expect(await page.evaluate(() => ({ running, entries, lastUndoAction }))).toEqual({ running: false, entries: [], lastUndoAction: null });
    expect(await page.evaluate(() => ordinaryProvisionalState().pendingEntries[0])).toMatchObject({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 });
    await page.unroute(pattern);
    await page.evaluate(() => { localStorage.removeItem('__proof-offline-sdk'); fbDb.goOnline(); }); await pinned(page, world);
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 })]);
    expect(await page.evaluate(id => accountingCoordinator().snapshot().history.filter(op => op.id === id).length, original.id)).toBe(1);
  });
  test(`${uid}: O1 reversed-clock Stop retains its original conflict without inventing or rebasing an interval`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('Backward original'))).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 - 5 * MIN);
    expect(await retainedAccountingResult(page, 'stop')).toBe(true);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.ordinary?.kind === 'stop'));
    expect(original.input.ordinary.endpoint).toBe(T0 - 5 * MIN);
    await page.evaluate(at => window.__setNow(at), T0 + 1440 * MIN);
    await page.unroute(pattern); await page.evaluate(() => accountingCoordinator().drain());
    expect(await page.evaluate(() => ordinaryProvisionalState().conflict)).toBe(true);
    expect((await remote(world, uid)).entries).toEqual([]);
    const held = await page.evaluate(id => accountingCoordinator().snapshot().queue.find(op => op.id === id), original.id);
    expect(held.input).toEqual(original.input); expect(held.at).toBe(T0 - 5 * MIN);
  });
  test(`${uid}: O1 Check now resumes provisional observation after retaining the failed original heartbeat`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('Paused original heartbeat'))).toBe(true);
    await page.evaluate(at => {
      window.__setNow(at); const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, raw) {
        if (this === localStorage && key.startsWith('ta3-accounting-capture-v1:') && raw.includes('ordinary-heartbeat')) {
          Storage.prototype.setItem = write; throw Error('Heartbeat capture quota');
        }
        return write.call(this, key, raw);
      };
    }, T0 + 5 * MIN);
    expect(await page.evaluate(() => observeOrdinaryProvisional())).toBe(false);
    const failed = await page.evaluate(() => accountingCoordinator().failedCaptures(roomCode)[0]);
    await page.evaluate(() => timeAckUserAction('check'));
    expect(await page.evaluate(() => ordinaryProvisionalState().observedAt)).toBe(T0 + 5 * MIN);
    await page.evaluate(at => window.__setNow(at), T0 + 6 * MIN);
    expect(await page.evaluate(() => observeOrdinaryProvisional())).toBe(true);
    expect(await page.evaluate(() => ordinaryProvisionalState().observedAt)).toBe(T0 + 6 * MIN);
    expect(await page.evaluate(id => accountingCoordinator().failedCaptures(roomCode).some(op => op.id === id), failed.id)).toBe(false);
  });
  test(`${uid}: O1 transferring recovery before native effects prevents an overdue Start notification while choice is open`, async ({ page }) => {
    page.on('console', message => { if (message.type() === 'warning' && message.text().includes('accounting')) console.log('native recovery warning', message.text()); });
    await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, Plugins: {} }; });
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('Native recovery transfer'))).toBe(true);
    await page.evaluate(async at => { window.__setNow(at); await observeOrdinaryProvisional(); }, T0 + 5 * MIN);
    await page.evaluate(at => window.__setNow(at), T0 + 45 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    await page.evaluate(() => { window.__o1NativeSchedules = []; LocalNotifications = {
      cancel: async () => {}, schedule: async value => { window.__o1NativeSchedules.push(value); } }; });
    await page.unroute(pattern); await page.evaluate(async () => { await accountingCoordinator().drain(); await _accountingNativePingTail; });
    expect(await page.evaluate(() => window.__o1NativeSchedules)).toEqual([]);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    const recovered = await page.evaluate(() => handleRecovery(true));
    if (!recovered) console.log('O1 native recovery diagnostic', await page.evaluate(() => ({ pending: accountingCoordinator().snapshot().queue, legacy: window._accountingLegacyLoadError, view: ordinaryProvisionalState(), recovery: window._timerRecoveryState, privateRecovery: _ordinaryProvisionalRecovery })));
    expect(recovered).toBe(true);
    expect((await remote(world, uid)).entries[0]).toMatchObject({ tsStart: T0, ts: T0 + 5 * MIN });
  });
  test(`${uid}: O1 account switch retains original partition and never applies its provisional session to another account`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('Private original session'))).toBe(true);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.ordinary));
    const other = uid === 'alice' ? 'bob' : 'alice'; await open(page, world, other); await pinned(page, world);
    expect(await page.evaluate(() => ordinaryProvisionalState())).toBeNull();
    await expect(page.locator('#ordinary-provisional')).toBeHidden();
    expect(await page.evaluate(owner => accountingCoordinator().snapshot(owner).queue.find(op => op.input.ordinary).input, `uid_${uid}`)).toEqual(original.input);
    expect((await remote(world, other)).timer).toBeNull(); expect(await page.evaluate(() => entries)).toEqual([]);
    await open(page, world, uid); await pinned(page, world); await page.unroute(pattern);
    await page.evaluate(() => accountingCoordinator().drain());
    expect((await remote(world, uid)).timer).toMatchObject({ taskStartTime: T0, lastTask: 'Private original session' });
  });
  test(`${uid}: O1 coherent peer takeover freezes producer and retains both original commands as a visible conflict`, async ({ page, browser }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('Original losing race'))).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 + 10 * MIN); expect(await retainedAccountingResult(page, 'stop')).toBe(true);
    const originals = await page.evaluate(() => accountingCoordinator().snapshot().queue.filter(op => op.input.ordinary).map(op => ({ id: op.id, at: op.at, input: op.input })));
    const peerContext = await browser.newContext({ serviceWorkers: 'block' }), peer = await peerContext.newPage();
    await peerContext.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    try {
      await open(peer, world, uid, 'peer-device'); await pinned(peer, world);
      expect(await peer.evaluate(() => _startTimer('Accepted peer session'))).toBe(true);
      await page.unroute(pattern); await page.evaluate(() => hydrateAccounting()); await page.evaluate(() => accountingCoordinator().drain());
      expect(await page.evaluate(() => ordinaryProvisionalState().conflict)).toBe(true);
      await expect(page.locator('#ordinary-provisional')).toContainText('Original losing race');
      expect(await page.evaluate(() => accountingCoordinator().snapshot().queue.filter(op => op.input.ordinary).map(op => ({ id: op.id, at: op.at, input: op.input })))).toEqual(originals);
      expect((await remote(world, uid)).timer).toMatchObject({ lastTask: 'Accepted peer session', ownerDeviceId: 'peer-device' });
      expect((await remote(world, uid)).entries).toEqual([]);
    } finally { await peerContext.close(); }
  });
  test(`${uid}: O1 heartbeat readback survives a blocked import lock and recovery uses the last observed endpoint`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('Lock-held observation'))).toBe(true);
    let inspectHeld = false;
    await page.unroute(pattern); await page.route(pattern, () => { inspectHeld = true; });
    await page.evaluate(() => { window.__heldDrain = accountingCoordinator().drain(); });
    await expect.poll(() => inspectHeld).toBe(true);
    await page.evaluate(at => { window.__setNow(at); window.__heldObservation = observeOrdinaryProvisional(); }, T0 + 5 * MIN);
    expect(await page.evaluate(() => ordinaryProvisionalState().observedAt)).toBe(T0 + 5 * MIN);
    await page.evaluate(at => window.__setNow(at), T0 + 45 * MIN);
    await page.unroute(pattern); await page.route(pattern, route => route.abort('failed'));
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    expect(await page.evaluate(() => handleRecovery(true))).toBe(true);
    await page.unroute(pattern); await page.evaluate(() => accountingCoordinator().drain());
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 5 * MIN, blockIntervalMin: 5 })]);
  });
  test(`${uid}: O1 reconnect before recovery choice preserves intentional original endpoint after Start ACK`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('Recovery ACK race'))).toBe(true);
    await page.evaluate(async at => { window.__setNow(at); await observeOrdinaryProvisional(); }, T0 + 5 * MIN);
    await page.evaluate(at => window.__setNow(at), T0 + 45 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    await page.unroute(pattern); await page.evaluate(() => accountingCoordinator().drain());
    expect(await page.evaluate(() => handleRecovery(true))).toBe(true);
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 5 * MIN, blockIntervalMin: 5 })]);
    await expect(page.locator('#recovery-overlay')).toBeHidden();
  });
  test(`${uid}: O1 late Start ACK cannot restart a captured Stop or publish provisional totals and Undo`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    let releaseStart, releaseStop, starts = 0, stops = 0, startReleased = false;
    const startHeld = new Promise(resolve => { releaseStart = resolve; }), stopHeld = new Promise(resolve => { releaseStop = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() === 'GET') return starts && !startReleased || stops ? route.abort('failed') : route.continue();
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch();
      if (route.request().postDataJSON().timer.running) { starts++; await startHeld; }
      else { stops++; await stopHeld; }
      await route.fulfill({ response });
    });
    try {
      await page.evaluate(() => { window.__o1Start = _startTimer('Held original'); });
      await expect.poll(() => starts).toBe(1);
      await page.evaluate(at => { window.__setNow(at); window.__o1Stop = stopAndLog(); }, T0 + 10 * MIN);
      expect(await page.evaluate(() => ordinaryProvisionalState().frame.running)).toBe(false);
      expect(await page.evaluate(() => ({ running, entries, lastUndoAction, heartbeat: localStorage.getItem(accountLocalKey('ta3-heartbeat-ts', roomCode)) })))
        .toEqual({ running: false, entries: [], lastUndoAction: null, heartbeat: null });
      startReleased = true; releaseStart(); await expect.poll(() => stops).toBe(1);
      expect(await page.evaluate(() => ({ running, entries, lastUndoAction }))).toEqual({ running: true, entries: [], lastUndoAction: null });
      await expect(page.locator('#timer-status')).toHaveText('Saved on this device — awaiting sync');
      releaseStop(); await page.unroute(pattern);
      expect(await page.evaluate(async () => [await window.__o1Start, await window.__o1Stop])).toEqual([true, true]);
      expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 })]);
      expect(await page.evaluate(() => running)).toBe(false);
    } finally { releaseStart(); releaseStop(); }
  });
  test(`${uid}: O1 failed Stop readback reports failure and keeps prior durable Start until original retry`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('Readback original'))).toBe(true);
    await page.evaluate(at => {
      window.__setNow(at); const read = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        const raw = read.call(this, key);
        if (this === localStorage && key.startsWith('ta3-accounting-capture-v1:') && raw?.includes('stop-and-log')) {
          Storage.prototype.getItem = read; throw Error('Stop post-write readback failed');
        }
        return raw;
      };
    }, T0 + 10 * MIN);
    expect(await retainedAccountingResult(page, 'stop')).toBe(false);
    const failed = await page.evaluate(() => accountingCoordinator().failedCaptures(roomCode)[0]);
    expect(failed.at).toBe(T0 + 10 * MIN);
    expect(await page.evaluate(() => ordinaryProvisionalState().frame.running)).toBe(true);
    expect(await page.evaluate(() => entries)).toEqual([]);
    await page.evaluate(at => window.__setNow(at), T0 + 60 * MIN);
    await page.evaluate(() => accountingCoordinator().drain());
    expect(await page.evaluate(() => ordinaryProvisionalState().frame.running)).toBe(false);
    await page.unroute(pattern); await page.evaluate(() => accountingCoordinator().drain());
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 })]);
    expect(await page.evaluate(id => accountingCoordinator().snapshot().history.filter(op => op.id === id).length, failed.id)).toBe(1);
  });
  test(`${uid}: O1 lost Start reply and next-day Stop recovery keep sealed bytes and original exact interval`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`; let writes = 0;
    await page.route(pattern, async route => {
      if (route.request().method() === 'PATCH') { writes++; await route.fetch(); return route.abort('failed'); }
      return writes ? route.abort('failed') : route.continue();
    });
    expect(await page.evaluate(() => _startTimer('Lost original'))).toBe(true);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.name === 'start-timer'));
    await page.evaluate(at => window.__setNow(at), T0 + 10 * MIN);
    expect(await retainedAccountingResult(page, 'stop')).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 + 1440 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    expect(await page.evaluate(id => accountingCoordinator().snapshot().queue.find(op => op.id === id).proposal, original.id)).toEqual(original.proposal);
    await page.unroute(pattern); await page.evaluate(() => accountingCoordinator().drain());
    expect(writes).toBe(1);
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 })]);
  });
  test(`${uid}: F1-O1 offline Start restores visibly provisional original session after expired recovery`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('O1 original work'))).toBe(true);
    const original = await page.evaluate(() => ordinaryProvisionalState());
    expect(original.frame).toMatchObject({ running: true, taskStartTime: T0, currentTask: 'O1 original work' });
    expect(await page.evaluate(() => ({ running, entries, lastUndoAction }))).toEqual({ running: false, entries: [], lastUndoAction: null });
    await page.evaluate(async at => { window.__setNow(at); await observeOrdinaryProvisional(); }, T0 + 5 * MIN);
    await page.evaluate(at => window.__setNow(at), T0 + 45 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    expect(await page.evaluate(() => handleRecovery(false))).toBe(true);
    expect(await page.evaluate(() => ordinaryProvisionalState().frame.taskStartTime)).toBe(T0);
    expect((await remote(world, uid)).timer).toBeNull();
    await page.unroute(pattern); await page.evaluate(() => accountingCoordinator().drain());
    expect((await remote(world, uid)).timer).toMatchObject({ running: true, taskStartTime: T0 });
    expect(await page.evaluate(id => accountingCoordinator().snapshot().history.filter(op => op.id === id).length, original.operationId)).toBe(1);
  });
  test(`${uid}: F2-O1 intentional recovery retains last-observed Stop and confirms its exact interval once`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('O1 intentional close'))).toBe(true);
    await page.evaluate(async at => { window.__setNow(at); await observeOrdinaryProvisional(); }, T0 + 5 * MIN);
    await page.evaluate(at => window.__setNow(at), T0 + 45 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    await expect(page.locator('#recovery-overlay')).toBeVisible();
    expect(await page.evaluate(() => handleRecovery(true))).toBe(true);
    expect(await page.evaluate(() => ({ running, entries, lastUndoAction }))).toEqual({ running: false, entries: [], lastUndoAction: null });
    expect(await page.evaluate(() => ordinaryProvisionalState().pendingEntries)).toMatchObject([{ tsStart: T0, ts: T0 + 5 * MIN, blockIntervalMin: 5 }]);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    await expect(page.locator('#recovery-overlay')).toBeHidden();
    await page.unroute(pattern); await page.evaluate(() => accountingCoordinator().drain());
    const accepted = await remote(world, uid);
    expect(accepted.timer.running).toBe(false); expect(accepted.entries).toHaveLength(1);
    expect(accepted.entries[0]).toMatchObject({ tsStart: T0, ts: T0 + 5 * MIN, blockIntervalMin: 5 });
    await page.reload(); await pinned(page, world); expect((await remote(world, uid)).entries).toHaveLength(1);
  });
  test(`${uid}: F3-O1 Start Stop Start before ACK preserves ordered original sessions and confirmed exclusion`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => _startTimer('O1 first'))).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 + 10 * MIN);
    expect(await retainedAccountingResult(page, 'stop')).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 + 12 * MIN);
    expect(await page.evaluate(() => _startTimer('O1 second'))).toBe(true);
    await page.evaluate(async at => { window.__setNow(at); await observeOrdinaryProvisional(); }, T0 + 42 * MIN + 30000);
    await page.evaluate(at => window.__setNow(at), T0 + 43 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    expect(await page.evaluate(() => ordinaryProvisionalState().frame)).toMatchObject({ running: true, taskStartTime: T0 + 12 * MIN });
    expect(await page.evaluate(() => ({ running, entries, lastUndoAction, pingCount }))).toEqual({ running: false, entries: [], lastUndoAction: null, pingCount: 0 });
    await page.unroute(pattern); await page.evaluate(() => accountingCoordinator().drain());
    const accepted = await remote(world, uid);
    expect(accepted.timer).toMatchObject({ running: true, taskStartTime: T0 + 12 * MIN, lastTask: 'O1 second' });
    expect(accepted.entries).toHaveLength(1); expect(accepted.entries[0]).toMatchObject({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 });
  });
  test(`${uid}: O1 supersedes C5 capture-return expectation while retaining original offline Start and confirmed exclusion`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => ['GET', 'PATCH'].includes(route.request().method()) ? route.abort('failed') : route.continue());
    // O1 changes only successful durable-capture return semantics; pre-ACK accounting assertions remain.
    expect(await page.evaluate(() => _startTimer('Original offline Start'))).toBe(true);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.name === 'start-timer'));
    expect(original).toBeTruthy(); expect(original.at).toBe(T0);
    expect(await page.evaluate(() => ({ running, taskStartTime, lastUndoAction }))).toEqual({ running: false, taskStartTime: null, lastUndoAction: null });
    expect((await remote(world, uid)).timer).toBeNull();
    await page.evaluate(now => window.__setNow(now), T0 + 45 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    const retained = await page.evaluate(id => accountingCoordinator().snapshot().queue.find(op => op.id === id), original.id);
    expect(retained.input).toEqual(original.input); expect(retained.at).toBe(T0);
    expect(await page.evaluate(() => running)).toBe(false);
    await page.unroute(pattern);
    expect((await page.evaluate(async () => { const result = await accountingCoordinator().drain(); clearInterval(ticker); ticker = null; return result; })).status).toBe('drained');
    expect((await remote(world, uid)).timer).toMatchObject({ running: true, startedAt: T0, taskStartTime: T0, lastTask: 'Original offline Start' });
    expect((await remote(world, uid)).entries).toEqual([]);
    expect(await page.evaluate(id => accountingCoordinator().snapshot().history.filter(op => op.id === id).length, original.id)).toBe(1);
  });
  test(`${uid}: native scheduling repairs an accepted Start interrupted before runtime materialization`, async ({ page }) => {
    await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, Plugins: {} }; });
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    await page.evaluate(() => {
      window.__nativeSchedules = [];
      LocalNotifications = { cancel: async () => {}, schedule: async value => { window.__nativeSchedules.push(value.notifications[0].schedule.at.getTime()); } };
      window.__interruptNativeMaterialization = true;
      const original = persist;
      persist = function () {
        if (window.__interruptNativeMaterialization && running && currentTask === 'Interrupted native start') throw Error('Interrupted compatibility cache materialization');
        return original();
      };
    });
    expect(await page.evaluate(() => _startTimer('Interrupted native start'))).toBe(false);
    expect((await remote(world, uid)).timer).toMatchObject({ running: true, lastTask: 'Interrupted native start' });
    expect(await page.evaluate(() => window.__nativeSchedules)).toEqual([]);
    await page.evaluate(async () => { window.__interruptNativeMaterialization = false; restoreUnifiedAccounting(); restoreUnifiedAccounting(); await _accountingNativePingTail; });
    expect(await page.evaluate(() => window.__nativeSchedules)).toEqual([T0 + 30 * MIN]);
    expect(await page.evaluate(() => ({ running, currentTask, taskStartTime }))).toEqual({ running: true, currentTask: 'Interrupted native start', taskStartTime: T0 });
  });
  test(`${uid}: native scheduling repairs an accepted Stop even when the interrupted live globals are already idle`, async ({ page }) => {
    await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, Plugins: {} }; });
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    await page.evaluate(() => {
      window.__nativeCalls = [];
      LocalNotifications = { cancel: async () => { window.__nativeCalls.push('cancel'); }, schedule: async () => { window.__nativeCalls.push('schedule'); } };
    });
    expect(await page.evaluate(() => _startTimer('Native Stop proof'))).toBe(true);
    await page.evaluate(async () => { await _accountingNativePingTail; window.__nativeCalls = []; });
    await page.evaluate(now => window.__setNow(now), T0 + 10 * MIN);
    await page.evaluate(() => {
      window.__interruptNativeStop = true; const original = persist;
      persist = function () { if (window.__interruptNativeStop && !running) throw Error('Interrupted Stop cache'); return original(); };
    });
    expect(await retainedAccountingResult(page, 'stop')).toBe(false);
    expect(await page.evaluate(() => running)).toBe(false);
    expect((await remote(world, uid)).timer.running).toBe(false);
    expect(await page.evaluate(() => window.__nativeCalls)).toEqual([]);
    await page.evaluate(async () => { window.__interruptNativeStop = false; restoreUnifiedAccounting(); restoreUnifiedAccounting(); await _accountingNativePingTail; });
    expect(await page.evaluate(() => window.__nativeCalls)).toEqual(['cancel']);
    expect((await remote(world, uid)).entries.filter(entry => !entry.deleted)).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 })]);
  });
  test(`${uid}: native provider initialization and reload project one original accepted timer endpoint`, async ({ page }) => {
    await page.addInitScript(() => {
      window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
      window.__providerSchedules = [];
    });
    await page.route('https://cdn.jsdelivr.net/npm/@capacitor/local-notifications/dist/esm/index.js', route => route.fulfill({
      contentType: 'application/javascript', body: `export const LocalNotifications = {
        requestPermissions: async () => ({ display: 'granted' }), createChannel: async () => {}, addListener: () => {}, cancel: async () => {},
        schedule: async value => { window.__providerSchedules.push(value.notifications[0].schedule.at.getTime()); }
      };` }));
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    await page.waitForFunction(() => LocalNotifications);
    expect(await page.evaluate(() => _startTimer('Native reload proof'))).toBe(true);
    await page.evaluate(async () => { await _accountingNativePingTail; });
    expect(await page.evaluate(() => window.__providerSchedules)).toEqual([T0 + 30 * MIN]);
    await page.evaluate(now => window.__setNow(now), T0 + 1 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    await expect.poll(() => page.evaluate(() => window.__providerSchedules)).toEqual([T0 + 30 * MIN]);
  });
  for (const writer of ['manual-form', 'retro-midnight', 'merged-edit', 'delete', 'clear-all', 'clear-day', 'clear-today', 'metadata-repair', 'away-start', 'away-end']) {
    test(`${uid}: qualified writer ${writer} preserves its exact frame until ACK and repairs it once after reload`, async ({ page }, info) => {
      const world = await emulator.fresh(rules);
      const record = (id, start, end) => ({ id, tsStart: start, ts: end, blockIntervalMin: (end - start) / MIN,
        activity: 'Existing work', energy: 'deep', onPlan: true, retro: true, updatedAt: end, date: '2026-10-28' });
      const first = record(77, T0 - 60 * MIN, T0 - 50 * MIN), second = record(78, T0 - 50 * MIN, T0 - 40 * MIN);
      if (writer === 'metadata-repair') first.date = '2026-10-27';
      const historical = { ...record(79, T0 - 1500 * MIN, T0 - 1490 * MIN), date: '2026-10-27', activity: 'Historical work' };
      await world.seed(`rooms/uid_${uid}/entries`, { 77: first, e_78: second, e_79: historical });
      await open(page, world, uid); await pinned(page, world);
      if (writer === 'away-start') expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
      if (writer === 'away-end') expect(await page.evaluate(() => startAway('Lunch'))).toBe(true);
      await page.evaluate(now => window.__setNow(now), T0 + 10 * MIN);
      page.on('dialog', dialog => dialog.accept());
      const before = await page.evaluate(() => ({ entries: cloneUndoValue(entries), cursor: taskStartTime,
        undo: cloneUndoValue(lastUndoAction), awayActive, awayStartTime, running }));
      let release, submitted = false;
      const held = new Promise(resolve => { release = resolve; });
      const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
      await page.route(pattern, async route => {
        if (route.request().method() !== 'PATCH') return route.continue();
        const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
      });
      try {
        await page.evaluate(writer => {
          if (writer === 'manual-form') {
            document.getElementById('f-activity').value = 'Manual form'; selectedEnergy = 'shallow'; selectedOnPlan = true;
          }
          if (writer === 'retro-midnight') {
            openRetroLog(); document.getElementById('retro-activity').value = 'Midnight original';
            retroEnergy = 'deep'; document.getElementById('retro-start').value = '23:50'; document.getElementById('retro-end').value = '00:10';
          }
          if (writer === 'merged-edit') openEditMergedEntry('77,78', entries.find(e => e.id === 77).tsStart, entries.find(e => e.id === 78).ts);
          if (writer === 'clear-day') {
            const select = document.getElementById('clear-day-select'); select.innerHTML = '<option value="2026-10-28">Today</option>'; select.value = '2026-10-28';
          }
          const actions = { 'manual-form': saveEntry, 'retro-midnight': saveRetroEntry, 'merged-edit': saveRetroEntry,
            delete: () => deleteEntry(77), 'clear-all': clearAll, 'clear-day': clearSelectedDay, 'clear-today': clearTodayOnly,
            'metadata-repair': repairDataDoctorMetadata, 'away-start': () => startAway('Lunch'), 'away-end': toggleAway };
          window.__writerOperation = Promise.resolve(actions[writer]());
          window.__writerOperation.then(result => { window.__writerOutcome = { done: true, result }; }, error => { window.__writerOutcome = { error: error.message }; });
        }, writer);
        try { await expect.poll(() => submitted).toBe(true); }
        catch (error) {
          await info.attach('writer-before-send-state', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => ({
            outcome: window.__writerOutcome, snapshot: accountingCoordinator().snapshot(), error: window._accountingLegacyLoadError,
            toast: document.getElementById('toast')?.textContent }))) });
          throw error;
        }
        expect(await page.evaluate(() => ({ entries: cloneUndoValue(entries), cursor: taskStartTime,
          undo: cloneUndoValue(lastUndoAction), awayActive, awayStartTime, running }))).toEqual(before);
        const original = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.phase === 'pending'));
        expect(original).toBeTruthy(); release();
        await page.waitForFunction(() => window.__writerOutcome);
        expect(await page.evaluate(() => window.__writerOutcome.error)).toBeUndefined();
        expect(await page.evaluate(() => window.__writerOutcome.result)).not.toBe(false);
        const raw = await world.read(`rooms/uid_${uid}`), paths = Object.keys(original.proposal.patch);
        for (const target of paths) expect(target.split('/').reduce((value, key) => value?.[key], raw)).toEqual(original.proposal.patch[target]);
        const rows = raw.entries;
        if (writer === 'retro-midnight') {
          const start = Date.parse('2026-10-29T06:50:00Z'), midnight = Date.parse('2026-10-29T07:00:00Z'), end = midnight + 10 * MIN;
          expect(Object.values(rows).filter(e => e.activity === 'Midnight original').sort((a, b) => a.ts - b.ts)
            .map(e => [e.id, e.tsStart, e.ts, e.blockIntervalMin])).toEqual([[midnight - 1, start, midnight, 10], [end, midnight, end, 10]]);
        }
        if (writer === 'merged-edit') {
          expect(rows['77']).toMatchObject({ id: 77, tsStart: first.tsStart, ts: second.ts, blockIntervalMin: 20 });
          expect(rows.e_78.deleted).toBe(true); expect(rows.e_77).toBeUndefined();
        }
        if (writer.startsWith('clear-')) {
          expect(rows['77'].deleted).toBe(true); expect(rows.e_78.deleted).toBe(true);
          expect(!!rows.e_79.deleted).toBe(writer === 'clear-all');
        }
        if (writer === 'metadata-repair') expect(rows['77'].date).toBe('2026-10-28');
        if (writer === 'away-start') {
          expect(raw.timer).toMatchObject({ running: false, stopped: true }); expect(raw.awayState.active).toBe(true);
          expect(raw.timer._csWrite.operationId).toBe(raw.awayState._csWrite.operationId);
          expect(Object.values(rows).find(e => e.activity === 'Writing')).toMatchObject({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 });
        }
        if (writer === 'away-end') {
          expect(raw.awayState.active).toBe(false);
          expect(Object.values(rows).find(e => e.activity === 'Lunch')).toMatchObject({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 });
        }
        if (writer !== 'clear-all') expect(rows.e_79).toEqual(historical);
        await page.unroute(pattern); await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
        expect(await world.read(`rooms/uid_${uid}/entries`)).toEqual(rows);
        const accepted = await page.evaluate(id => accountingCoordinator().snapshot().history.filter(op => op.id === id), original.id);
        expect(accepted).toHaveLength(1); expect(accepted[0].proposal).toEqual(original.proposal);
      } finally { release(); }
    });
  }
  test(`${uid}: Sprint original local/publication anchors retain task coverage through Save Undo reload and takeover`, async ({ page, browser }, info) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Sprint coverage'))).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 + 5 * MIN); expect(await page.evaluate(() => startSprint())).toBe(true);
    expect((await remote(world, uid)).timer).toMatchObject({ startedAt: T0 + 5 * MIN, taskStartTime: T0, intervalSecs: 1500 });
    await page.evaluate(() => requestAccountingRefresh());
    expect(await page.evaluate(() => timerStartedAt)).toBe(T0);
    await page.evaluate(at => window.__setNow(at), T0 + 10 * MIN); expect(await page.evaluate(() => _doQuickSave('Sprint coverage', 'deep'))).toBe(true);
    expect((await remote(world, uid)).entries.filter(entry => !entry.deleted)).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 })]);
    expect(await acknowledgedUndo(page)).toBe(true);
    const savedTimer = (await remote(world, uid)).timer;
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    await page.evaluate(() => requestAccountingRefresh());
    expect(await page.evaluate(() => ({ timerStartedAt, taskStartTime }))).toEqual({ timerStartedAt: T0, taskStartTime: T0 });
    const peerContext = await browser.newContext({ serviceWorkers: 'block' });
    await peerContext.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    try {
      const peer = await peerContext.newPage(); await open(peer, world, uid, 'peer-device'); await pinned(peer, world);
      if (await peer.evaluate(() => timerStartedAt) == null) await info.attach('sprint-peer-bootstrap-state', { contentType: 'application/json',
        body: JSON.stringify(await peer.evaluate(() => ({ state: accountingCoordinator().snapshot(), live: captureAccountingFrame(),
          captures: accountingCoordinator().captures(roomCode), error: window._accountingLegacyLoadError }))) });
      expect(await peer.evaluate(() => timerStartedAt)).toBe(savedTimer.startedAt);
      await peer.evaluate(at => window.__setNow(at), T0 + 11 * MIN); expect(await retainedAccountingResult(peer, 'take-over')).toBe(true);
      await peer.evaluate(at => window.__setNow(at), T0 + 12 * MIN); expect(await retainedAccountingResult(peer, 'stop')).toBe(true);
      const rows = (await remote(world, uid)).entries;
      expect(rows.filter(entry => !entry.deleted)).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 12 * MIN, blockIntervalMin: 12 })]);
      expect(rows.filter(entry => entry.deleted)).toHaveLength(1);
    } finally { await peerContext.close(); }
  });

  test(`${uid}: captured interval clock and prospective setting survive reload and repeated coherent snapshots`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Original30'))).toBe(true);
    await page.evaluate(at => { window.__setNow(at); const input = document.getElementById('interval-input'); input.value = '15'; input.dispatchEvent(new Event('change')); }, T0 + 5 * MIN);
    await page.evaluate(() => requestAccountingRefresh());
    expect(await page.evaluate(() => ({ totalSecs, preference: settings.intervalMin }))).toEqual({ totalSecs: 1800, preference: 15 });
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    await page.evaluate(() => requestAccountingRefresh()); await page.evaluate(() => requestAccountingRefresh());
    expect(await page.evaluate(() => ({ totalSecs, remaining, preference: settings.intervalMin }))).toEqual({ totalSecs: 1800, remaining: 1500, preference: 15 });
    await page.evaluate(at => window.__setNow(at), T0 + 10 * MIN);
    expect(await retainedAccountingResult(page, 'stop')).toBe(true);
    expect(await page.evaluate(() => ({ totalSecs, remaining, preference: settings.intervalMin }))).toEqual({ totalSecs: 900, remaining: 900, preference: 15 });
  });

  test(`${uid}: a genuinely new external timer adopts its original interval while repeated snapshots preserve later preference`, async ({ page, browser }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    await page.evaluate(() => { const input = document.getElementById('interval-input'); input.value = '15'; input.dispatchEvent(new Event('change')); });
    await page.evaluate(() => requestAccountingRefresh());
    const peerContext = await browser.newContext({ serviceWorkers: 'block' });
    await peerContext.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    try {
      const peer = await peerContext.newPage(); await open(peer, world, uid, 'peer-device'); await pinned(peer, world);
      await peer.evaluate(() => { const input = document.getElementById('interval-input'); input.value = '40'; input.dispatchEvent(new Event('change')); });
      expect(await peer.evaluate(() => _startTimer('External40'))).toBe(true);
      await expect.poll(() => page.evaluate(() => ({ running, totalSecs, preference: settings.intervalMin }))).toEqual({ running: true, totalSecs: 2400, preference: 40 });
      await page.evaluate(() => { const input = document.getElementById('interval-input'); input.value = '15'; input.dispatchEvent(new Event('change')); });
      await page.evaluate(() => requestAccountingRefresh());
      expect(await page.evaluate(() => ({ totalSecs, preference: settings.intervalMin }))).toEqual({ totalSecs: 2400, preference: 15 });
    } finally { await peerContext.close(); }
  });

  test(`${uid}: Sprint keeps its frozen active clock while a later prospective preference survives ACK`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Sprint original'))).toBe(true);
    let release, submitted = false; const held = new Promise(resolve => { release = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
    });
    await page.evaluate(at => window.__setNow(at), T0 + 5 * MIN);
    const sprint = page.evaluate(() => startSprint());
    try {
      await expect.poll(() => submitted).toBe(true);
      expect(await page.evaluate(() => totalSecs)).toBe(1800);
      await page.evaluate(at => { window.__setNow(at); const input = document.getElementById('interval-input'); input.value = '15'; input.dispatchEvent(new Event('change')); }, T0 + 6 * MIN);
      release(); expect(await sprint).toBe(true);
      expect(await page.evaluate(() => ({ totalSecs, remaining, preference: settings.intervalMin, input: document.getElementById('interval-input').value })))
        .toEqual({ totalSecs: 1500, remaining: 1140, preference: 15, input: '15' });
      expect((await remote(world, uid)).timer).toMatchObject({ startedAt: T0 + 5 * MIN, intervalSecs: 1500 });
      // The approved source captures distinct local and published anchors; do not normalize either.
      await page.evaluate(() => requestAccountingRefresh());
      expect(await page.evaluate(() => ({ timerStartedAt, remaining, preference: settings.intervalMin })))
        .toEqual({ timerStartedAt: T0, remaining: 1140, preference: 15 });
    } finally { release(); await sprint.catch(() => {}); }
  });

  test(`${uid}: interval preference survives coherent refresh and an independent retro write`, async ({ page }, info) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    await page.evaluate(() => { const input = document.getElementById('interval-input'); input.value = '15'; input.dispatchEvent(new Event('change')); });
    await page.evaluate(() => requestAccountingRefresh());
    expect(await page.evaluate(() => ({ preference: settings.intervalMin, totalSecs }))).toEqual({ preference: 15, totalSecs: 900 });
    await page.evaluate(({ at, MIN }) => { window.__setNow(at + 10 * MIN); openRetroLogPrefilled(at, at + 3 * MIN, 'Independent retro', 'deep'); document.getElementById('retro-activity').focus(); }, { at: T0, MIN });
    // A settings echo may queue another read-only refresh. Wait for its captured
    // source to settle before asking this test's deliberate writer to proceed.
    await page.waitForFunction(() => !accountingHasPending());
    await page.evaluate(() => saveRetroEntry());
    // This existing modal handler has no success return; the authoritative
    // local-applied receipt distinguishes acceptance from its guarded early exit.
    const receipt = await page.evaluate(() => accountingCoordinator().snapshot().history.find(op => op.input.name === 'retro-log'));
    if (!receipt) await info.attach('retro-refusal-state', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => ({
      state: accountingCoordinator().snapshot(), sources: [...window._accountingSourcesSeen],
      toast: document.getElementById('toast').textContent, refresh: !!_accountingRefreshTask,
    }))) });
    expect(receipt).toMatchObject({ phase: 'local-applied' });
    expect(await page.evaluate(() => ({ preference: settings.intervalMin, totalSecs }))).toEqual({ preference: 15, totalSecs: 900 });
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 3 * MIN, blockIntervalMin: 3 })]);
  });

  test(`${uid}: pending Start preserves its captured clock while a later preference stays prospective`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    let release, submitted = false; const held = new Promise(resolve => { release = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
    });
    const start = page.evaluate(() => _startTimer('Captured interval'));
    try {
      await expect.poll(() => submitted).toBe(true);
      await page.evaluate(at => { window.__setNow(at); const input = document.getElementById('interval-input'); input.value = '15'; input.dispatchEvent(new Event('change')); }, T0 + 2 * MIN);
      expect(await page.evaluate(() => running)).toBe(false);
      await page.evaluate(at => window.__setNow(at), T0 + 5 * MIN); release(); expect(await start).toBe(true);
      expect(await page.evaluate(() => ({ totalSecs, remaining, preference: settings.intervalMin }))).toEqual({ totalSecs: 1800, remaining: 1500, preference: 15 });
      expect((await remote(world, uid)).timer).toMatchObject({ startedAt: T0, intervalSecs: 1800 });
      await page.unroute(pattern); await page.evaluate(at => window.__setNow(at), T0 + 10 * MIN);
      expect(await retainedAccountingResult(page, 'stop')).toBe(true);
      expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 })]);
    } finally { release(); await start.catch(() => {}); }
  });

  test(`${uid}: shared accounting receipts repair an SDK-offline tab through Save and Undo without remote retry`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    const peer = await page.context().newPage(); await open(peer, world, uid); await pinned(peer, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    try {
      await peer.evaluate(() => fbDb.goOffline());
      await peer.route(pattern, route => route.abort('failed'));
      await page.evaluate(at => window.__setNow(at), T0 + 10 * MIN);
      expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(true);
      await expect.poll(() => peer.evaluate(() => entries.filter(entry => !entry.deleted).length)).toBe(1);
      expect(await peer.evaluate(() => ({ taskStartTime, undo: lastUndoAction })))
        .toEqual(await page.evaluate(() => ({ taskStartTime, undo: lastUndoAction })));
      expect(await acknowledgedUndo(page)).toBe(true);
      await expect.poll(() => peer.evaluate(() => entries.filter(entry => !entry.deleted).length)).toBe(0);
      expect(await peer.evaluate(() => ({ taskStartTime, undo: lastUndoAction })))
        .toEqual(await page.evaluate(() => ({ taskStartTime, undo: lastUndoAction })));
      expect((await remote(world, uid)).entries).toHaveLength(1);
    } finally { await peer.close(); }
  });

  test(`${uid}: repeated legacy quota recovery retains one original command for identical bytes`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const original = await page.evaluate(() => {
      const coordinator = accountingCoordinator(), write = Storage.prototype.setItem;
      const raw = JSON.stringify({ v: 7, owner: roomCode, original: 'retain identical legacy bytes once' });
      const observed = { slot: `${TimeAckCore.STORAGE_BASE}:${roomCode}`, raw };
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith(`${AccountingCommand.INTAKE}:`) && JSON.parse(value).input.name === 'legacy-time-ack') throw Error('Injected repeated legacy quota');
        return write.call(this, key, value);
      };
      window.__restoreRepeatedLegacy = () => { Storage.prototype.setItem = write; };
      retainLegacyTimeAck(coordinator, observed);
      const first = coordinator.failedCaptures(roomCode).find(op => op.input.name === 'legacy-time-ack');
      for (let i = 0; i < 4; i++) retainLegacyTimeAck(coordinator, observed);
      return { first, raw };
    });
    try {
      expect(await page.evaluate(() => accountingCoordinator().failedCaptures(roomCode).filter(op => op.input.name === 'legacy-time-ack').length)).toBe(1);
      await page.evaluate(() => { window.__restoreRepeatedLegacy(); return timeAckUserAction('check'); });
      const commands = await page.evaluate(() => [...accountingCoordinator().snapshot().queue, ...accountingCoordinator().snapshot().history,
        ...accountingCoordinator().captures(roomCode).map(item => item.captured)].filter(op => op.input.name === 'legacy-time-ack'));
      expect(commands).toHaveLength(1); expect(commands[0].id).toBe(original.first.id); expect(commands[0].input.source.raw).toBe(original.raw);
    } finally { await page.evaluate(() => window.__restoreRepeatedLegacy()); }
  });
  test(`${uid}: legacy event capture quota holds original bytes in page until exact recovery`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world); await saved(page, world, uid);
    const peer = await page.context().newPage(); await open(peer, world, uid); await pinned(peer, world);
    try {
      await page.evaluate(() => {
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) { if (key.startsWith(`${AccountingCommand.INTAKE}:`)) throw Error('Injected legacy intake quota'); return write.call(this, key, value); };
        window.__restoreLegacyStorage = () => { Storage.prototype.setItem = write; };
      });
      const raw = await peer.evaluate(() => {
        const raw = JSON.stringify({ v: 1, owner: roomCode, operation: { id: 'legacy_quota_001', phase: 'unknown', original: 'never discard these original bytes' }, history: [] });
        const slot = `${TimeAckCore.STORAGE_BASE}:${roomCode}`; localStorage.setItem(slot, raw); localStorage.removeItem(slot); return raw;
      });
      await expect.poll(() => page.evaluate(raw => (_accountingLegacyCaptureJobs.get(roomCode) || []).some(input => input.source.raw === raw)
        || accountingCoordinator().failedCaptures(roomCode).some(op => op.input.name === 'legacy-time-ack' && op.input.source.raw === raw), raw)).toBe(true);
      await expect(page.locator('#time-ack-status')).toContainText('held in this page');
      await page.evaluate(() => window.__restoreLegacyStorage());
      await page.evaluate(() => timeAckUserAction('check'));
      expect(await page.evaluate(raw => [...accountingCoordinator().snapshot().queue, ...accountingCoordinator().captures(roomCode).map(item => item.captured)]
        .some(op => op.input.name === 'legacy-time-ack' && op.input.source.raw === raw), raw)).toBe(true);
      expect(await page.evaluate(() => _accountingLegacyCaptureJobs.get(roomCode)?.length || 0)).toBe(0);
    } finally { await page.evaluate(() => window.__restoreLegacyStorage?.()); await peer.close(); }
  });

  test(`${uid}: same-origin offline contexts do not amplify unchanged UNKNOWN retry notifications`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    const peer = await page.context().newPage(); await open(peer, world, uid); await pinned(peer, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    try {
      await page.waitForFunction(() => !_accountingRefreshTask && !accountingHasPending());
      await peer.waitForFunction(() => !_accountingRefreshTask && !accountingHasPending());
      for (const tab of [page, peer]) await tab.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
      await page.evaluate(at => { window.__setNow(at); window.__unknownSave = _doQuickSave('Writing', 'deep'); }, T0 + 10 * MIN);
      await page.waitForTimeout(700);
      const first = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.name === 'quick-save')?.attempts || 0);
      await page.waitForTimeout(700);
      const later = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.name === 'quick-save')?.attempts || 0);
      expect(first).toBeGreaterThan(0); expect(later).toBe(first);
      expect((await remote(world, uid)).entries).toHaveLength(0);
    } finally { await peer.close(); }
  });

  test(`${uid}: same-origin legacy removal event preserves the original record even after its slot disappears`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world); await saved(page, world, uid);
    const before = await remote(world, uid), peer = await page.context().newPage();
    try {
      await open(peer, world, uid); await pinned(peer, world);
      const raw = await peer.evaluate(() => {
        const raw = JSON.stringify({ v: 1, owner: roomCode, operation: { id: 'legacy_removed_001', phase: 'unknown',
          owner: roomCode, uid: currentUser.uid, device: syncedDeviceId, originalFact: { label: 'retained old bytes', ts: Date.now() } }, history: [] });
        const slot = `${TimeAckCore.STORAGE_BASE}:${roomCode}`; localStorage.setItem(slot, raw); localStorage.removeItem(slot); return raw;
      });
      await expect.poll(() => page.evaluate(raw => [...accountingCoordinator().snapshot().queue,
        ...accountingCoordinator().captures(roomCode).map(item => item.captured)].some(op => op.input.name === 'legacy-time-ack' && op.input.source.raw === raw), raw)).toBe(true);
      expect(await page.evaluate(() => localStorage.getItem(`${TimeAckCore.STORAGE_BASE}:${roomCode}`))).toBeNull();
      expect(await remote(world, uid)).toEqual(before);
    } finally { await peer.close(); }
  });

  for (const legacy of ['accepted', 'unknown', 'foreign', 'corrupt']) {
  test(`${uid}: legacy Undo ${legacy} is retained verbatim without separate replay or local apply`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world); await saved(page, world, uid);
    const before = await remote(world, uid), localBefore = await page.evaluate(() => ({ entries, undo: lastUndoAction, taskStartTime, blockStartTime }));
    const raw = await page.evaluate(legacy => {
      const entry = entries.find(item => !item.deleted), path = `entries/e_${entry.id}`, id = 'legacy_undo_001';
      const original = { id, owner: roomCode, uid: legacy === 'foreign' ? 'unrelated-owner' : currentUser.uid, device: syncedDeviceId,
        phase: legacy === 'accepted' ? 'accepted' : 'unknown', label: 'legacy Undo', session: trackingStartedAt || taskStartTime,
        actionCreatedAt: lastUndoAction.createdAt, before: { [path]: cloneUndoValue(entry) },
        patch: { [path]: TimeAckCore.stamp(entry, { ...entry, deleted: true, updatedAt: Date.now() }, id) },
        local: { records: { [path]: cloneUndoValue(entry) } }, proposedLocal: {} };
      const raw = legacy === 'corrupt' ? '{unreadable original legacy bytes' : JSON.stringify({ v: 1, owner: roomCode, operation: original, history: [] });
      localStorage.setItem(`${TimeAckCore.STORAGE_BASE}:${roomCode}`, raw); return raw;
    }, legacy);
    await page.evaluate(() => timeAckReconcile());
    expect(await remote(world, uid)).toEqual(before);
    expect(await page.evaluate(() => ({ entries, undo: lastUndoAction, taskStartTime, blockStartTime }))).toEqual(localBefore);
    expect(await page.evaluate(() => localStorage.getItem(`${TimeAckCore.STORAGE_BASE}:${roomCode}`))).toBe(raw);
    const retained = await page.evaluate(() => [...accountingCoordinator().snapshot().queue,
      ...accountingCoordinator().captures(roomCode).map(item => item.captured)].find(op => op.input.name === 'legacy-time-ack'));
    expect(retained).toBeDefined(); expect(retained.input.source.raw).toBe(raw);
    await expect(page.locator('#time-ack-status')).toContainText('Legacy time needs recovery review');
    await expect(page.getByRole('button', { name: 'Retry Undo', exact: true })).toHaveCount(0);
  });
  }

  test(`${uid}: legacy drift is durably quarantined instead of publishing or discarding the original rows`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world); await saved(page, world, uid);
    const before = await remote(world, uid);
    expect(await page.evaluate(async ({ at, MIN }) => {
      const original = { id: at + 90 * MIN, tsStart: at + 80 * MIN, ts: at + 90 * MIN, blockIntervalMin: 10,
        date: '2026-10-28', activity: 'Unconfirmed legacy row', energy: 'deep', updatedAt: at + 90 * MIN };
      window.__legacyRow = cloneUndoValue(original); entries.unshift(original); persist(); return syncEntries();
    }, { at: T0, MIN })).toBe(false);
    expect(await remote(world, uid)).toEqual(before);
    const state = await page.evaluate(() => ({ pending: [...accountingCoordinator().snapshot().queue,
      ...accountingCoordinator().captures(roomCode).map(item => item.captured)], committed: accountingCoordinator().snapshot().committed }));
    const retained = state.pending.find(op => op.input.source?.runtime?.name === 'syncEntries');
    expect(retained).toBeDefined();
    expect(retained.input.source.runtime.frame.entries).toContainEqual(await page.evaluate(() => window.__legacyRow));
    expect(retained.reason).toBe('legacy-source-needs-resolution');
    expect(state.committed.value.entries.filter(entry => !entry.deleted)).toHaveLength(1);
  });

  test(`${uid}: confirmed refresh masks partial own postimages until the full original command is acknowledged`, async ({ page, browser }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`; let lost = false;
    await page.route(pattern, async route => {
      if (route.request().method() === 'GET' && lost) return route.abort('failed');
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fetch(); lost = true; await route.abort('failed');
    });
    await page.evaluate(at => window.__setNow(at), T0 + 10 * MIN);
    expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(false);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    const peerContext = await browser.newContext({ serviceWorkers: 'block' });
    await peerContext.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    try {
      const peer = await peerContext.newPage(); await open(peer, world, uid, 'peer-device'); await pinned(peer, world);
      await peer.evaluate(at => window.__setNow(at), T0 + 11 * MIN); expect(await retainedAccountingResult(peer, 'take-over')).toBe(true);
      await peer.evaluate(at => window.__setNow(at), T0 + 12 * MIN); expect(await retainedAccountingResult(peer, 'stop')).toBe(true);
      const authoritative = await remote(world, uid); expect(authoritative.entries.filter(entry => !entry.deleted)).toHaveLength(2);
      await page.unroute(pattern); await page.evaluate(() => requestAccountingRefresh());
      expect(await page.evaluate(() => running)).toBe(false);
      const local = await page.evaluate(() => ({ entries, undo: lastUndoAction, state: accountingCoordinator().snapshot() }));
      expect(local.entries.filter(entry => !entry.deleted)).toEqual(authoritative.entries.filter(entry => entry.tsStart === T0 + 10 * MIN));
      expect(local.undo).toBeNull();
      const retained = local.state.queue.find(op => op.id === original.id);
      expect(retained.input).toEqual(original.input); expect(retained.proposal).toEqual(original.proposal);
      expect(local.state.history.some(op => op.input.confirmedOnly && op.evidence?.heldOwnPostImages)).toBe(true);
      expect(await remote(world, uid)).toEqual(authoritative);
    } finally { await peerContext.close(); }
  });

  test(`${uid}: legacy sync entry points do not publish derived SDK accounting writes`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world); await saved(page, world, uid);
    const before = await remote(world, uid);
    const calls = await page.evaluate(async () => {
      const ref = ownedRoomRef(), original = ref.update; const writes = [];
      ref.update = function (patch) { if (Object.keys(patch).some(path => /^(timer|awayState|breakState|entries|focusRedemptions)(\/|$)/.test(path))) writes.push(cloneUndoValue(patch)); return original.call(this, patch).catch(() => {}); };
      try { await Promise.all([syncEntries(), syncTimerState(), syncFocusRedemptions(), syncAwayState({ ownerRoom: roomCode, active: false }), syncBreakState()]); }
      finally { ref.update = original; }
      return writes;
    });
    expect(calls).toEqual([]); expect(await remote(world, uid)).toEqual(before);
  });

  test(`${uid}: retained UNKNOWN Save still learns a newer peer Stop without rewriting its original command`, async ({ page, browser }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(at => window.__setNow(at), T0 + 10 * MIN);
    expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(false);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    const peerContext = await browser.newContext({ serviceWorkers: 'block' });
    await peerContext.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    try {
      const peer = await peerContext.newPage(); await open(peer, world, uid, 'peer-device'); await pinned(peer, world);
      await peer.evaluate(at => window.__setNow(at), T0 + 11 * MIN); expect(await retainedAccountingResult(peer, 'take-over')).toBe(true);
      await peer.evaluate(at => window.__setNow(at), T0 + 12 * MIN); expect(await retainedAccountingResult(peer, 'stop')).toBe(true);
      await page.unroute(pattern); await page.evaluate(() => requestAccountingRefresh());
      expect(await page.evaluate(() => ({ running, currentTask, timerOwnerDeviceId }))).toEqual({ running: false, currentTask: '', timerOwnerDeviceId: null });
      const retained = await page.evaluate(id => accountingCoordinator().snapshot().queue.find(op => op.id === id), original.id);
      expect(retained).toBeDefined(); expect(retained.input).toEqual(original.input); expect(retained.proposal).toEqual(original.proposal);
      expect(retained.at).toBe(original.at);
      expect(await page.evaluate(() => entries.filter(entry => !entry.deleted))).toEqual((await remote(world, uid)).entries.filter(entry => !entry.deleted));
    } finally { await peerContext.close(); }
  });

  test(`${uid}: native malformed pending request never invokes the native query`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    await page.evaluate(async at => {
      window.__setNow(at); await syncPhoneUsage({ queryEvents: async () => { throw Error('reserve source'); } });
      const state = accountingCoordinator().snapshot(); state.sources[0].input.observation.facts.query.startTime = 'corrupt-start';
      localStorage.setItem(`${AccountingCommand.BASE}:${roomCode}`, JSON.stringify(state)); window.__nativeCalls = 0;
    }, T0 + 10 * MIN);
    expect(await page.evaluate(() => syncPhoneUsage({ queryEvents: async () => { window.__nativeCalls++; return { events: [] }; } }))).toBe(false);
    expect(await page.evaluate(() => window.__nativeCalls)).toBe(0);
    const state = await page.evaluate(() => accountingCoordinator().snapshot());
    expect(state.sources).toHaveLength(1); expect(state.sources[0].input.observation.facts.query.startTime).toBe('corrupt-start');
    expect(state.committed.value.phoneUsage).toBeNull();
    await expect(page.locator('#time-ack-status')).toContainText('retained query');
  });

  for (const corrupt of ['range', 'open']) {
  test(`${uid}: native malformed ${corrupt} stays retained before local-only receipt or watermark commit`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const outcome = await page.evaluate(async ({ at, MIN, corrupt }) => {
      window.__setNow(at + 10 * MIN); await syncPhoneUsage({ queryEvents: async () => { throw Error('reserve source'); } });
      const coordinator = accountingCoordinator(), state = coordinator.snapshot(), source = state.sources[0];
      if (corrupt === 'range') source.input.observation.facts.query.endTime = 'corrupt-range-end';
      else source.input.observation.facts.open = [{ pkg: 'com.instagram.android', type: 1, ts: at + 100 * MIN }];
      localStorage.setItem(`${AccountingCommand.BASE}:${roomCode}`, JSON.stringify(state));
      coordinator.completeSource(source, { ok: true, events: [] });
      try { return await coordinator.drain(); } catch (error) { return { status: 'threw', message: error.message }; }
    }, { at: T0, MIN, corrupt });
    expect(outcome.status).toBe('conflict');
    const state = await page.evaluate(() => accountingCoordinator().snapshot());
    expect(state.queue).toHaveLength(1); expect(state.queue[0].reason).toBe('native-request-unreadable');
    expect(state.committed.value.phoneUsage).toBeNull();
    expect(state.history.some(op => op.input.name === 'native-usage')).toBe(false);
    expect((await remote(world, uid)).entries).toHaveLength(0);
  });
  }

  for (const fault of ['quota', 'readback']) {
  test(`${uid}: native request ${fault} freezes the invocation before any query or asynchronous handoff`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(async ({ at, MIN, fault }) => {
      window.__setNow(at + 10 * MIN); window.__nativeCalls = 0;
      const write = Storage.prototype.setItem, read = Storage.prototype.getItem; const written = new Set();
      Storage.prototype.setItem = function (key, value) {
        if (fault === 'quota' && key.startsWith(`${AccountingCommand.INTAKE}:`)) throw Error('Injected request quota');
        const result = write.call(this, key, value); if (key.startsWith(`${AccountingCommand.INTAKE}:`)) written.add(key); return result;
      };
      Storage.prototype.getItem = function (key) { if (fault === 'readback' && written.has(key)) throw Error('Injected request readback'); return read.call(this, key); };
      window.__restoreNativeStorage = () => { Storage.prototype.setItem = write; Storage.prototype.getItem = read; };
      return syncPhoneUsage({ queryEvents: async () => { window.__nativeCalls++; return { events: [] }; } });
    }, { at: T0, MIN, fault })).toBe(false);
    try { expect(await page.evaluate(() => window.__nativeCalls)).toBe(0); }
    finally { await page.evaluate(() => window.__restoreNativeStorage()); }
    expect(await page.evaluate(async at => {
      window.__setNow(at); return syncPhoneUsage({ queryEvents: async request => { window.__nativeCalls++; window.__retainedQuery = request; return { events: [] }; } });
    }, T0 + 20 * MIN)).toBe(true);
    expect(await page.evaluate(() => window.__nativeCalls)).toBe(1);
    expect(await page.evaluate(() => window.__retainedQuery.endTime)).toBe(T0 + 10 * MIN);
    const sources = await page.evaluate(() => phoneUsageSources(accountingCoordinator(), roomCode));
    expect(sources).toHaveLength(1); expect(sources[0].at).toBe(T0 + 10 * MIN);
  });
  }

  test(`${uid}: native classification snapshot and later independent peer retro preserve both original facts`, async ({ page, browser }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const peerContext = await browser.newContext({ serviceWorkers: 'block' });
    await peerContext.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    let release, submitted = false; const held = new Promise(resolve => { release = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      submitted = true; await held; const response = await route.fetch(); await route.fulfill({ response });
    });
    const native = page.evaluate(async ({ at, MIN }) => {
      window.__setNow(at + 10 * MIN); return syncPhoneUsage({ queryEvents: async () => ({ events: [
        { pkg: 'com.instagram.android', type: 1, ts: at }, { pkg: 'com.instagram.android', type: 2, ts: at + 3 * MIN }] }) });
    }, { at: T0, MIN });
    try {
      await expect.poll(() => submitted).toBe(true);
      const peer = await peerContext.newPage(); await open(peer, world, uid, 'peer-device'); await pinned(peer, world);
      await peer.evaluate(({ at, MIN }) => {
        window.__setNow(at + 10 * MIN); openRetroLogPrefilled(at + MIN, at + 4 * MIN, 'Independent peer work', 'deep'); document.getElementById('retro-activity').focus();
      }, { at: T0, MIN });
      await peer.evaluate(() => saveRetroEntry());
      await expect.poll(async () => (await remote(world, uid)).entries.length).toBe(1);
      release(); expect(await native).toBe(true);
      const rows = (await remote(world, uid)).entries;
      expect(rows).toHaveLength(2);
      expect(rows.filter(entry => entry.phoneUsage)).toEqual([expect.objectContaining({ id: T0, tsStart: T0, ts: T0 + 3 * MIN })]);
      expect(rows.filter(entry => !entry.phoneUsage)).toEqual([expect.objectContaining({ activity: 'Independent peer work', tsStart: T0 + MIN, ts: T0 + 4 * MIN })]);
      // This proves frozen classification, not global interval exclusion: later independent observations retain their existing overlap meaning (contract G2).
    } finally { release(); await native.catch(() => {}); await peerContext.close(); }
  });

  test(`${uid}: native query detach retains old-owner result without writing or applying to the next account`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const other = uid === 'alice' ? 'bob' : 'alice';
    await page.evaluate(({ at, MIN }) => {
      window.__setNow(at + 10 * MIN);
      window.__nativeOriginalContext = { currentUser, roomCode, _localStateOwner, _syncGeneration, entries };
      window.__nativeRun = syncPhoneUsage({ queryEvents: () => {
        window.__nativeStarted = true; return new Promise(resolve => { window.__finishNative = () => resolve({ events: [
          { pkg: 'com.instagram.android', type: 1, ts: at }, { pkg: 'com.instagram.android', type: 2, ts: at + 3 * MIN }] }); });
      } });
    }, { at: T0, MIN });
    await page.waitForFunction(() => window.__nativeStarted);
    await page.evaluate(other => {
      currentUser = { uid: other }; roomCode = `uid_${other}`; _localStateOwner = roomCode; _syncGeneration++;
      entries = []; window.__finishNative();
    }, other);
    expect(await page.evaluate(() => window.__nativeRun)).toBe(false);
    expect((await remote(world, uid)).entries).toHaveLength(0);
    expect((await remote(world, other)).entries).toHaveLength(0);
    expect(await page.evaluate(() => entries)).toEqual([]);
    const retained = await page.evaluate(owner => accountingCoordinator().captures(owner).find(item => item.captured.phase === 'source-result').captured, `uid_${uid}`);
    expect(retained.owner).toBe(`uid_${uid}`); expect(retained.result.events).toHaveLength(2);
    await page.evaluate(() => {
      ({ currentUser, roomCode, _localStateOwner, _syncGeneration, entries } = window.__nativeOriginalContext); _syncGeneration++;
    });
    await page.evaluate(() => accountingCoordinator().drain());
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ id: T0, ts: T0 + 3 * MIN })]);
    expect((await remote(world, other)).entries).toHaveLength(0);
  });

  test(`${uid}: native import preserves Save Undo and leaves the native record unchanged`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world); await saved(page, world, uid);
    const originalUndo = await page.evaluate(() => lastUndoAction);
    expect(await page.evaluate(async ({ at, MIN }) => {
      window.__setNow(at + 30 * MIN); return syncPhoneUsage({ queryEvents: async () => ({ events: [
        { pkg: 'com.instagram.android', type: 1, ts: at + 20 * MIN }, { pkg: 'com.instagram.android', type: 2, ts: at + 23 * MIN }] }) });
    }, { at: T0, MIN })).toBe(true);
    const phone = (await remote(world, uid)).entries.find(entry => entry.phoneUsage);
    expect(await page.evaluate(() => lastUndoAction)).toEqual(originalUndo);
    expect(await acknowledgedUndo(page)).toBe(true);
    expect((await remote(world, uid)).entries.find(entry => entry.phoneUsage)).toEqual(phone);
    expect((await remote(world, uid)).entries.filter(entry => !entry.deleted)).toEqual([phone]);
  });

  test(`${uid}: native tombstone collision is retained without resurrection or watermark advancement`, async ({ page }) => {
    const world = await emulator.fresh(rules);
    const tombstone = { id: T0, activity: 'Instagram', ts: T0 + 3 * MIN, tsStart: T0,
      date: '2026-10-28', energy: 'waste', blockIntervalMin: 3, phoneUsage: true, deleted: true, updatedAt: T0 + 5 * MIN };
    await world.seed(`rooms/uid_${uid}/entries/e_${T0}`, tombstone);
    await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(async ({ at, MIN }) => {
      window.__setNow(at + 10 * MIN); return syncPhoneUsage({ queryEvents: async () => ({ events: [
        { pkg: 'com.instagram.android', type: 1, ts: at }, { pkg: 'com.instagram.android', type: 2, ts: at + 3 * MIN }] }) });
    }, { at: T0, MIN })).toBe(false);
    expect(await world.read(`rooms/uid_${uid}/entries/e_${T0}`)).toEqual(tombstone);
    expect(await page.evaluate(() => captureAccountingFrame().phoneUsage)).toBeNull();
    expect(await page.evaluate(() => accountingCoordinator().snapshot().queue[0].reason)).toBe('native-entry-source-unresolved');
  });

  for (const fault of ['quota', 'readback']) {
  test(`${uid}: native result ${fault} retains original unprocessed events and retries without another query`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(async ({ at, MIN, fault }) => {
      window.__setNow(at + 10 * MIN); window.__nativeCalls = 0;
      const write = Storage.prototype.setItem, read = Storage.prototype.getItem; const written = new Set();
      Storage.prototype.setItem = function (key, value) {
        if (fault === 'quota' && key.includes(':result:')) throw Error('Injected result quota');
        const result = write.call(this, key, value); if (key.includes(':result:')) written.add(key); return result;
      };
      Storage.prototype.getItem = function (key) { if (fault === 'readback' && written.has(key)) throw Error('Injected result readback'); return read.call(this, key); };
      window.__restoreNativeStorage = () => { Storage.prototype.setItem = write; Storage.prototype.getItem = read; };
      return syncPhoneUsage({ queryEvents: async () => { window.__nativeCalls++; return { events: [
        { pkg: 'com.instagram.android', type: 1, ts: at }, { pkg: 'com.instagram.android', type: 2, ts: at + 3 * MIN }] }; } });
    }, { at: T0, MIN, fault })).toBe(false);
    try {
      expect((await remote(world, uid)).entries).toHaveLength(0);
      expect(await page.evaluate(() => _phoneUsageCaptureFailures.get(`${roomCode}:${syncedDeviceId}`).result.events.length)).toBe(2);
    } finally { await page.evaluate(() => window.__restoreNativeStorage()); }
    expect(await page.evaluate(async at => {
      window.__setNow(at); return syncPhoneUsage({ queryEvents: async () => { window.__nativeCalls++; throw Error('must not requery original result'); } });
    }, T0 + 20 * MIN)).toBe(true);
    expect(await page.evaluate(() => window.__nativeCalls)).toBe(1);
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ id: T0, ts: T0 + 3 * MIN, updatedAt: T0 + 10 * MIN })]);
  });
  }

  test(`${uid}: native query failure survives reload without advancing its frozen request`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    await page.evaluate(async at => { window.__setNow(at); await syncPhoneUsage({ queryEvents: async () => { throw Error('offline native source'); } }); }, T0 + 10 * MIN);
    const source = await page.evaluate(() => accountingCoordinator().snapshot().sources[0]);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    expect(await page.evaluate(() => phoneUsageHasRequest())).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 + 30 * MIN);
    expect(await page.evaluate(() => syncPhoneUsage({ queryEvents: async request => { window.__resumedRequest = request; return { events: [] }; } }))).toBe(true);
    expect(await page.evaluate(() => window.__resumedRequest)).toEqual(source.input.observation.facts.query);
    const receipt = await page.evaluate(id => accountingCoordinator().snapshot().history.find(op => op.id === id), source.id);
    expect(receipt).toMatchObject({ phase: 'local-applied', id: source.id, source: { outcomes: expect.any(Array) } });
    expect(receipt.source.outcomes).toHaveLength(2);
  });

  test(`${uid}: native lost ACK reload retries original records and watermark once`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    let lost = false;
    await page.route(pattern, async route => {
      if (route.request().method() === 'GET' && lost) return route.abort('failed');
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fetch(); lost = true; await route.abort('failed');
    });
    expect(await page.evaluate(async ({ at, MIN }) => {
      window.__setNow(at + 10 * MIN); return syncPhoneUsage({ queryEvents: async () => ({ events: [
        { pkg: 'com.instagram.android', type: 1, ts: at }, { pkg: 'com.instagram.android', type: 2, ts: at + 4 * MIN }] }) });
    }, { at: T0, MIN })).toBe(false);
    const pending = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    expect(pending.input.name).toBe('native-usage');
    expect(await page.evaluate(() => captureAccountingFrame().phoneUsage)).toBeNull();
    await page.unroute(pattern); await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ id: T0, ts: T0 + 4 * MIN, _csWrite: expect.objectContaining({ operationId: pending.id }) })]);
    expect(await page.evaluate(() => captureAccountingFrame().phoneUsage.devices['proof-device'].endTime)).toBe(T0 + 10 * MIN);
    expect(await page.evaluate(id => accountingCoordinator().snapshot().history.filter(op => op.id === id).length, pending.id)).toBe(1);
  });

  test(`${uid}: native staged result keeps records and owned watermark unchanged until ACK`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    let release, submitted = false; const held = new Promise(resolve => { release = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
    });
    const promise = page.evaluate(async ({ at, MIN }) => {
      window.__setNow(at + 10 * MIN); localStorage.setItem(PHONE_USAGE_KEY, String(at + 100 * MIN));
      return syncPhoneUsage({ queryEvents: async request => {
        window.__nativeRequest = request;
        return { events: [{ pkg: 'com.google.android.youtube', type: 1, ts: at },
          { pkg: 'com.google.android.youtube', type: 2, ts: at + 3.4 * MIN }] };
      } });
    }, { at: T0, MIN });
    try {
      await expect.poll(() => submitted).toBe(true);
      expect(await page.evaluate(() => captureAccountingFrame().phoneUsage)).toBeNull();
      expect(await page.evaluate(() => entries.filter(entry => entry.phoneUsage))).toHaveLength(0);
      const pending = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.name === 'native-usage'));
      expect(pending.source.result.events).toHaveLength(2);
      expect(pending.input.observation.facts.legacyWatermark).toBe(String(T0 + 100 * MIN));
    } finally { release(); }
    expect(await promise).toBe(true);
    const rows = (await remote(world, uid)).entries;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: T0, tsStart: T0, ts: T0 + 3.4 * MIN, blockIntervalMin: 3, updatedAt: T0 + 10 * MIN, activity: 'YouTube' });
    expect(await page.evaluate(() => captureAccountingFrame().phoneUsage.devices['proof-device'].endTime)).toBe(T0 + 10 * MIN);
    expect(await page.evaluate(() => localStorage.getItem(PHONE_USAGE_KEY))).toBe(String(T0 + 100 * MIN));
  });

  test(`${uid}: native failed request retries its original window; successful empty result advances only that window`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(async at => {
      window.__setNow(at); return syncPhoneUsage({ queryEvents: async request => { window.__nativeFirst = request; throw Error('PERMISSION_DENIED'); } });
    }, T0 + 10 * MIN)).toBe(false);
    const original = await page.evaluate(() => window.__nativeFirst);
    expect(await page.evaluate(() => captureAccountingFrame().phoneUsage)).toBeNull();
    expect(await page.evaluate(() => phoneUsageHasRequest())).toBe(true);
    await expect(page.locator('#time-ack-status')).toContainText('other logging remains available');
    expect(await page.evaluate(() => _startTimer('Query failure does not block work'))).toBe(true);
    expect(await page.evaluate(async at => {
      window.__setNow(at); return syncPhoneUsage({ queryEvents: async request => { window.__nativeRetry = request; return { events: [] }; } });
    }, T0 + 20 * MIN)).toBe(true);
    expect(await page.evaluate(() => window.__nativeRetry)).toEqual(original);
    expect(await page.evaluate(() => captureAccountingFrame().phoneUsage.devices['proof-device'].endTime)).toBe(original.endTime);
    expect((await remote(world, uid)).entries).toHaveLength(0);
  });

  test(`${uid}: native foreground continuation crosses query windows without loss or duplicate import`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(async ({ at, MIN }) => {
      window.__setNow(at + 2 * MIN);
      return syncPhoneUsage({ queryEvents: async () => ({ events: [{ pkg: 'com.instagram.android', type: 1, ts: at }] }) });
    }, { at: T0, MIN })).toBe(true);
    expect((await remote(world, uid)).entries).toHaveLength(0);
    expect(await page.evaluate(() => captureAccountingFrame().phoneUsage.devices['proof-device'].open.length)).toBe(1);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    expect(await page.evaluate(async ({ at, MIN }) => {
      window.__setNow(at + 6 * MIN);
      return syncPhoneUsage({ queryEvents: async request => {
        window.__nativeSecond = request;
        return { events: [{ pkg: 'com.instagram.android', type: 2, ts: at + 5 * MIN }] };
      } });
    }, { at: T0, MIN })).toBe(true);
    expect(await page.evaluate(() => window.__nativeSecond.startTime)).toBe(T0 + 2 * MIN);
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ id: T0, tsStart: T0, ts: T0 + 5 * MIN, blockIntervalMin: 5 })]);
    expect(await page.evaluate(() => captureAccountingFrame().phoneUsage.devices['proof-device'].open)).toEqual([]);
    await page.evaluate(() => accountingCoordinator().drain());
    expect((await remote(world, uid)).entries).toHaveLength(1);
  });
  test(`${uid}: fresh peer hydrates and reloads an acknowledged paused Break without inventing a running clock`, async ({ page, browser }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Paused source'))).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 + 5 * MIN);
    expect(await page.evaluate(() => startBreak(5))).toBe(true);
    const original = await remote(world, uid);
    const peerContext = await browser.newContext({ serviceWorkers: 'block' });
    await peerContext.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    try {
      const peer = await peerContext.newPage(); await open(peer, world, uid, 'peer-device'); await pinned(peer, world);
      await expect.poll(() => peer.evaluate(() => breakActive)).toBe(true);
      expect(await peer.evaluate(() => ({ taskStartTime, blockStartTime, breakStartTs, breakEndsAt, running, timerOwnerDeviceId }))).toEqual({
        taskStartTime: T0 + 5 * MIN, blockStartTime: T0 + 5 * MIN, breakStartTs: T0 + 5 * MIN, breakEndsAt: T0 + 10 * MIN, running: false, timerOwnerDeviceId: 'proof-device',
      });
      await peer.reload(); await peer.waitForFunction(() => accountingIdentity()); await pinned(peer, world);
      expect(await peer.evaluate(() => breakActive)).toBe(true); expect(await remote(world, uid)).toEqual(original);
    } finally { await peerContext.close(); }
  });
  test(`${uid}: failed Focus fact precedes native classification without losing its original event`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Manual before native', workMinutes: 5, autoStart: true }))).toBe(true);
    await page.evaluate(at => {
      window.__setNow(at); const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith(`${AccountingCommand.INTAKE}:`) && JSON.parse(value).input.name === 'focus-end-work') throw Error('Injected Focus quota');
        return write.call(this, key, value);
      };
      window.__restoreFocusNative = () => { Storage.prototype.setItem = write; };
    }, T0 + 5 * MIN);
    expect(await retainedAccountingResult(page, 'focus-end-work')).toBe(false);
    const original = await page.evaluate(() => accountingCoordinator().failedCaptures(roomCode).find(op => op.input.name === 'focus-end-work'));
    try {
      expect(original.at).toBe(T0 + 5 * MIN);
      const result = await page.evaluate(async ({ at, MIN }) => {
        window.__restoreFocusNative(); window.__setNow(at + 6 * MIN);
        return syncPhoneUsage({ queryEvents: async () => ({ events: [
          { pkg: 'com.instagram.android', type: 1, ts: at + MIN },
          { pkg: 'com.instagram.android', type: 2, ts: at + 4 * MIN },
        ] }) });
      }, { at: T0, MIN });
      const state = await page.evaluate(() => accountingCoordinator().snapshot());
      expect(result, JSON.stringify({ queue: state.queue, sources: state.sources, history: state.history.map(op => ({ id: op.id, name: op.input.name, phase: op.phase, reason: op.reason })) })).toBe(true);
      const manual = state.history.find(op => op.id === original.id), native = state.history.find(op => op.input.name === 'native-usage');
      expect(manual.input).toEqual(original.input); expect(manual.at).toBe(original.at);
      expect(native.source.requestDependency).toBe(original.id);
      expect(native.evidence).toEqual([expect.objectContaining({ disposition: 'manual-overlap' })]);
      expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ activity: 'Manual before native', tsStart: T0, ts: T0 + 5 * MIN, blockIntervalMin: 5 })]);
    } finally { await page.evaluate(() => window.__restoreFocusNative()); }
  });
  for (const corrupt of ['focus', 'phone', 'clock', 'zero-clock']) {
  test(`${uid}: stored ${corrupt} local frame corruption is retained before any remote send or apply receipt`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort() : route.continue());
    expect(await page.evaluate(() => enterFocusMode({ task: 'Corruption retained', workMinutes: 5, autoStart: true }))).toBe(false);
    const original = await page.evaluate(corrupt => {
      const coordinator = accountingCoordinator(), state = coordinator.snapshot(), op = state.queue.find(item => item.input.name === 'focus-start');
      if (corrupt === 'focus') op.proposal.local.after.focus.pomodoroWorkMin = 0;
      if (corrupt === 'phone') op.proposal.local.after.phoneUsage = { v: 1, owner: roomCode, devices: { bad: { endTime: 'bad', open: [] } } };
      if (corrupt === 'clock') op.proposal.local.after.totalSecs = 'corrupt';
      if (corrupt === 'zero-clock') op.proposal.local.after.totalSecs = 0;
      localStorage.setItem(`${AccountingCommand.BASE}:${roomCode}`, JSON.stringify(state));
      return { id: op.id, proposal: op.proposal, generation: state.generation };
    }, corrupt);
    const before = await remote(world, uid); await page.unroute(pattern);
    await page.evaluate(() => accountingCoordinator().drain().catch(error => ({ retainedError: error.message })));
    expect(await remote(world, uid)).toEqual(before);
    const state = await page.evaluate(() => accountingCoordinator().snapshot());
    expect(state.queue.find(item => item.id === original.id)?.proposal).toEqual(original.proposal);
    expect(state.history.some(item => item.id === original.id)).toBe(false);
  });
  }
  for (const pendingKind of ['failed-work-end', 'pending-start']) {
  test(`${uid}: Focus source lease ${pendingKind} cannot resume after a coherent peer Stop`, async ({ page, browser }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    if (pendingKind === 'pending-start') await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort() : route.continue());
    expect(await page.evaluate(() => enterFocusMode({ task: 'Original source lease', workMinutes: 5, autoStart: true }))).toBe(pendingKind !== 'pending-start');
    if (pendingKind === 'failed-work-end') {
      await page.evaluate(at => {
        window.__setNow(at);
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key.startsWith(`${AccountingCommand.INTAKE}:`) && JSON.parse(value).input.name === 'focus-end-work') throw Error('Injected work-end quota');
          return write.call(this, key, value);
        };
        window.__restoreLeaseStorage = () => { Storage.prototype.setItem = write; };
      }, T0 + 5 * MIN);
      expect(await retainedAccountingResult(page, 'focus-end-work')).toBe(false);
      expect(await page.evaluate(() => focusCaptureIsPaused())).toBe(true);
    }
    const original = await page.evaluate(() => {
      const job = _focusCaptureFailures.get(focusCaptureKey());
      return job ? { facts: job.facts, at: job.options.at } : accountingCoordinator().snapshot().queue.find(op => op.input.name === 'focus-start');
    });
    const peerContext = await browser.newContext({ serviceWorkers: 'block' });
    await peerContext.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    try {
      const peer = await peerContext.newPage(); await open(peer, world, uid, 'peer-device'); await pinned(peer, world);
      await peer.evaluate(at => window.__setNow(at), T0 + 6 * MIN);
      if (pendingKind === 'failed-work-end') expect(await peer.evaluate(() => takeOverSyncedFocusTimer())).toBe(true);
      else expect(await peer.evaluate(() => enterFocusMode({ task: 'Peer source lease', workMinutes: 5, autoStart: true }))).toBe(true);
      await peer.evaluate(at => window.__setNow(at), T0 + 7 * MIN);
      expect(await peer.evaluate(() => confirmExitFocus())).toBe(true);
      await page.evaluate(() => requestAccountingRefresh());
      await expect.poll(() => page.evaluate(() => accountingCoordinator().snapshot().committed.value.focus)).toBeNull();
      if (pendingKind === 'failed-work-end') {
        await page.evaluate(() => window.__restoreLeaseStorage());
        await page.evaluate(() => retryFocusCapture());
        const captured = await page.evaluate(() => [...accountingCoordinator().snapshot().queue, ...accountingCoordinator().snapshot().history,
          ...accountingCoordinator().captures(roomCode).map(item => item.captured)].find(op => op.input.name === 'focus-end-work'));
        expect(captured.input.observation.facts).toEqual(original.facts); expect(captured.at).toBe(original.at);
      } else {
        await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
        const retained = await page.evaluate(id => accountingCoordinator().snapshot().queue.find(op => op.id === id), original.id);
        expect(retained.input).toEqual(original.input);
      }
      const before = await remote(world, uid);
      expect(await page.evaluate(() => ({ producer: !!_focusProducer, ticker: !!_focusProducerTicker }))).toEqual({ producer: false, ticker: false });
      await page.evaluate(at => { window.__setNow(at); for (let i = 0; i < 1000; i++) tickPomodoro(); }, T0 + 30 * MIN);
      expect(await remote(world, uid)).toEqual(before);
      expect(await page.evaluate(() => [...accountingCoordinator().snapshot().queue, ...accountingCoordinator().captures(roomCode).map(item => item.captured)]
        .some(op => op.input.name === 'focus-end-break'))).toBe(false);
    } finally { await page.evaluate(() => window.__restoreLeaseStorage?.()); await peerContext.close(); }
  });
  }
  for (const captureFault of ['quota', 'readback']) {
  test(`${uid}: Focus capture failure ${captureFault} pauses and retries its original AutoStart instant and configuration`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Capture pause', workMinutes: 1, autoStart: true }))).toBe(true);
    await page.evaluate(at => { window.__setNow(at); _pomodoroAutoStart = true; }, T0 + MIN);
    await page.evaluate(() => {
      window.__focusQualificationOperation = endWorkSession();
      window.__focusQualificationOperation.then(result => { window.__focusQualificationOutcome = { result }; }, error => { window.__focusQualificationOutcome = { error: error.message }; });
    });
    await expect.poll(() => page.evaluate(() => window.__focusQualificationOutcome)).toEqual({ result: true });
    await expect.poll(() => page.evaluate(() => accountingCoordinator().snapshot().queue.length + accountingCoordinator().captures(roomCode).length)).toBe(0);
    const before = await remote(world, uid);
    await page.evaluate(({ at, captureFault }) => {
      window.__setNow(at);
      const write = Storage.prototype.setItem, read = Storage.prototype.getItem;
      const written = new Set();
      Storage.prototype.setItem = function (key, value) {
        if (captureFault === 'quota' && key.startsWith(`${AccountingCommand.INTAKE}:`)) throw Error('Injected original fact quota failure');
        const result = write.call(this, key, value);
        if (key.startsWith(`${AccountingCommand.INTAKE}:`)) written.add(key);
        return result;
      };
      Storage.prototype.getItem = function (key) {
        if (captureFault === 'readback' && written.has(key)) throw Error('Injected original fact readback failure');
        return read.call(this, key);
      };
      window.__restoreCaptureStorage = () => { Storage.prototype.setItem = write; Storage.prototype.getItem = read; };
      window.__originalFocusCaptureId = () => {
        const key = Object.keys(localStorage).find(key => key.startsWith(`${AccountingCommand.INTAKE}:`) && JSON.parse(read.call(localStorage, key)).input.name === 'focus-end-break');
        return key ? JSON.parse(read.call(localStorage, key)).id : null;
      };
      const callbacks = _focusProducer.remaining;
      for (let i = 0; i < callbacks; i++) tickPomodoro();
    }, { at: T0 + 6 * MIN, captureFault });
    try {
      const originalId = await page.evaluate(() => window.__originalFocusCaptureId());
      if (captureFault === 'readback') expect(originalId).not.toBeNull();
      expect(await remote(world, uid)).toEqual(before);
      expect(await page.evaluate(() => accountingCoordinator().failedCaptures(roomCode).filter(op => op.input.name === 'focus-end-break').length)).toBe(1);
      await page.evaluate(at => {
        window.__setNow(at); document.getElementById('pomo-work-min').value = '45';
        window.__restoreCaptureStorage();
        for (let i = 0; i < 10; i++) tickPomodoro();
      }, T0 + 7 * MIN);
      const attempts = await page.evaluate(() => [...accountingCoordinator().snapshot().queue, ...accountingCoordinator().snapshot().history,
        ...accountingCoordinator().captures(roomCode).map(item => item.captured)].filter(op => op.input.name === 'focus-end-break'));
      expect(attempts.length).toBeLessThanOrEqual(1);
      if (attempts.length) { expect(attempts[0].at).toBe(T0 + 6 * MIN); if (originalId) expect(attempts[0].id).toBe(originalId); }
      await page.evaluate(() => timeAckUserAction('check'));
      await expect.poll(async () => (await remote(world, uid)).timer.startedAt).toBe(T0 + 6 * MIN);
      expect((await remote(world, uid)).timer).toMatchObject({ focusPhase: 'work', intervalSecs: 60 });
      if (originalId) expect((await remote(world, uid)).timer._csWrite.operationId).toBe(originalId);
      expect((await remote(world, uid)).entries).toEqual(before.entries);
    } finally { await page.evaluate(() => window.__restoreCaptureStorage()); }
  });
  }
  test(`${uid}: Focus terminal Learning frontier survives interrupted receipt, reload and delayed Stop ACK`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    await page.evaluate(() => {
      _pomodoroAutoStart = true; localStorage.setItem('ta3-pomo-auto', '1');
      globalThis.onLearningPlanFocusSessionEnded = () => true;
    });
    expect(await page.evaluate(() => enterFocusMode({ task: 'Terminal Learning', workMinutes: 5, autoStart: true,
      learningPlan: { planId: 'proof-plan', phaseId: 'proof-phase', lessonId: 'proof-lesson', stepId: 'proof-step' } }))).toBe(true);
    let release, stopSubmitted = false; const held = new Promise(resolve => { release = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH' || !route.request().postDataJSON().timer?.stopped) return route.continue();
      const response = await route.fetch(); stopSubmitted = true; await held;
      try { await route.fulfill({ response }); } catch { /* original page may already have reloaded */ }
    });
    await page.evaluate(at => {
      window.__setNow(at);
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === `${AccountingCommand.BASE}:${roomCode}` && JSON.parse(value).effectReceipts) throw Error('Interrupted terminal receipt');
        return write.call(this, key, value);
      };
    }, T0 + 5 * MIN);
    const complete = page.evaluate(() => endWorkSession()).catch(error => ({ detached: true, message: error.message }));
    try {
      await expect.poll(() => stopSubmitted).toBe(true);
      const original = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.name === 'focus-learning-finish'));
      expect(original).toBeDefined();
      expect(await page.evaluate(() => accountingCoordinator().snapshot().effects.length)).toBe(1);
      await page.reload(); await page.waitForFunction(() => document.readyState === 'complete' && accountingIdentity() && pomodoroPhase === 'break');
      await page.evaluate(at => { window.__setNow(at); for (let i = 0; i < 400; i++) tickPomodoro(); }, T0 + 20 * MIN);
      const candidates = await page.evaluate(() => [...accountingCoordinator().snapshot().queue,
        ...accountingCoordinator().captures(roomCode).map(item => item.captured)]);
      expect(candidates.some(op => op.input.name === 'focus-end-break')).toBe(false);
      release(); await page.unroute(pattern); await pinned(page, world);
      await expect.poll(() => page.evaluate(() => pomodoroPhase)).toBe('idle');
      expect((await remote(world, uid)).timer.running).toBe(false);
      expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 5 * MIN, blockIntervalMin: 5 })]);
      expect(await page.evaluate(id => accountingCoordinator().snapshot().history.some(op => op.id === id), original.id)).toBe(true);
    } finally { release(); await complete.catch(() => {}); }
  });
  test(`${uid}: Focus SDK takeover fences the original device and preserves the phase endpoint`, async ({ page, browser }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Peer Focus', workMinutes: 5, autoStart: true }))).toBe(true);
    const peerContext = await browser.newContext({ serviceWorkers: 'block' });
    await peerContext.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    try {
      const peer = await peerContext.newPage(); await open(peer, world, uid, 'peer-device'); await pinned(peer, world);
      await peer.evaluate(at => window.__setNow(at), T0 + MIN);
      expect(await peer.evaluate(() => takeOverSyncedFocusTimer())).toBe(true);
      await page.evaluate(() => requestAccountingRefresh());
      await expect.poll(() => page.evaluate(() => timerOwnerDeviceId)).toBe('peer-device');
      expect(await retainedAccountingResult(page, 'focus-end-work')).toBe(false);
      await peer.evaluate(at => window.__setNow(at), T0 + 5 * MIN);
      expect(await retainedAccountingResult(peer, 'focus-end-work')).toBe(true);
      expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({
        tsStart: T0, ts: T0 + 5 * MIN, blockIntervalMin: 5, activity: 'Peer Focus',
      })]);
      await page.evaluate(() => requestAccountingRefresh());
      const before = await remote(world, uid);
      expect(await retainedAccountingResult(page, 'focus-end-pomodoro-break')).toBe(false);
      expect(await remote(world, uid)).toEqual(before);
      expect(await peer.evaluate(() => confirmExitFocus())).toBe(true);
      expect((await remote(world, uid)).timer.running).toBe(false);
    } finally { await peerContext.close(); }
  });
  for (const handled of [true, false]) {
    test(`${uid}: Focus Learning outcome ${handled ? 'finishes once' : 'holds its continuation until a durable receipt'}`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      await page.evaluate(({ handled }) => {
        window.__focusOutcomes = {};
        globalThis.onLearningPlanFocusSessionEnded = outcome => { window.__focusOutcomes[outcome.focusEntryId] = outcome; return handled; };
      }, { handled });
      expect(await page.evaluate(() => enterFocusMode({ task: 'Learning Focus', workMinutes: 5, autoStart: true,
        learningPlan: { planId: 'proof-plan', phaseId: 'proof-phase', lessonId: 'proof-lesson', stepId: 'proof-step' } }))).toBe(true);
      if (!handled) await page.evaluate(() => {
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === `${AccountingCommand.BASE}:${roomCode}` && JSON.parse(value).effectReceipts) throw Error('Interrupted Learning effect receipt');
          return write.call(this, key, value);
        };
        window.__restoreLearningReceiptStorage = () => { Storage.prototype.setItem = write; };
      });
      try {
        await page.evaluate(at => window.__setNow(at), T0 + 5 * MIN);
        expect(await retainedAccountingResult(page, 'focus-end-work')).toBe(true);
        if (handled) {
          await expect.poll(async () => (await remote(world, uid)).timer.running).toBe(false);
          await expect.poll(() => page.evaluate(() => pomodoroPhase)).toBe('idle');
          const receipt = await page.evaluate(() => accountingCoordinator().snapshot().history.find(op => op.input.name === 'focus-learning-finish'));
          expect(receipt.at).toBe(T0 + 5 * MIN);
          expect(receipt.dependsOn).toBe(receipt.input.observation.facts.completionEffect.split(':')[0]);
          await page.evaluate(() => { for (let i = 0; i < 400; i++) tickPomodoro(); });
        } else {
          await expect.poll(() => page.evaluate(() => _focusEffectDelivery === null)).toBe(true);
          const original = await page.evaluate(() => accountingCoordinator().snapshot().effects);
          expect(original).toHaveLength(1);
          await page.evaluate(at => { window.__setNow(at); for (let i = 0; i < 400; i++) tickPomodoro(); }, T0 + 12 * MIN);
          expect(await page.evaluate(() => accountingCoordinator().snapshot().effects)).toEqual(original);
          expect(await page.evaluate(() => ({ waiting: _focusProducer.waitingLearning, remaining: _focusProducer.remaining })))
            .toEqual({ waiting: true, remaining: 300 });
          await expect(page.getByRole('button', { name: 'Check now', exact: true })).toBeVisible();
          // Automatic recovery may finish first once storage returns, removing the button, so invoke its action.
          await page.evaluate(() => { window.__restoreLearningReceiptStorage(); return timeAckUserAction('check'); });
          await expect.poll(() => page.evaluate(() => accountingCoordinator().snapshot().effects.length)).toBe(0);
          expect(await page.evaluate(() => _focusProducer.waitingLearning)).toBe(false);
          const remaining = await page.evaluate(() => { const before = _focusProducer.remaining; tickPomodoro(); return { before, after: _focusProducer.remaining }; });
          expect(remaining.after).toBe(remaining.before - 1);
        }
        expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({
          tsStart: T0, ts: T0 + 5 * MIN, blockIntervalMin: 5,
        })]);
        expect(Object.values(await page.evaluate(() => window.__focusOutcomes))).toHaveLength(1);
      } finally { if (!handled) await page.evaluate(() => window.__restoreLearningReceiptStorage()); }
    });
  }
  test(`${uid}: Focus timing retains callback-driven phase facts behind a held Start ACK`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    await page.evaluate(() => { _pomodoroAutoStart = true; localStorage.setItem('ta3-pomo-auto', '1'); });
    let release, submitted = false; const held = new Promise(resolve => { release = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
    });
    const start = page.evaluate(() => enterFocusMode({ task: 'Pending callback source', workMinutes: 25, autoStart: true }));
    try {
      await expect.poll(() => submitted).toBe(true);
      await page.evaluate(({ work, next }) => {
        window.__setNow(work);
        const workCallbacks = _focusProducer.remaining;
        for (let i = 0; i < workCallbacks; i++) tickPomodoro();
        window.__setNow(next);
        const breakCallbacks = _focusProducer.remaining;
        for (let i = 0; i < breakCallbacks; i++) tickPomodoro();
      }, { work: T0 + 25 * MIN, next: T0 + 30 * MIN });
      const captured = await page.evaluate(() => accountingCoordinator().captures(roomCode).map(item => item.captured));
      const work = captured.find(op => op.input.name === 'focus-end-work'), next = captured.find(op => op.input.name === 'focus-end-break');
      expect(work.input.observation.facts.entry).toMatchObject({ tsStart: T0, ts: T0 + 25 * MIN, blockIntervalMin: 25 });
      expect(next.at).toBe(T0 + 30 * MIN); expect(next.dependsOn).toBe(work.id);
      expect(await page.evaluate(() => ({ phase: pomodoroPhase, entries, lastUndoAction })))
        .toEqual({ phase: 'idle', entries: [], lastUndoAction: null });
      await page.evaluate(at => window.__setNow(at), T0 + 35 * MIN);
      release(); expect(await start).toBe(true);
      await expect.poll(() => page.evaluate(() => accountingCoordinator().snapshot().queue.length)).toBe(0);
      const after = await remote(world, uid);
      expect(after.entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 25 * MIN, blockIntervalMin: 25 })]);
      expect(after.timer).toMatchObject({ mode: 'focus', focusPhase: 'work', startedAt: T0 + 30 * MIN });
      expect(await page.evaluate(() => pomodoroRemaining)).toBeGreaterThan(1490);
    } finally { release(); await start.catch(() => {}); }
  });
  test(`${uid}: Focus timing preserves one decrement per delivered live callback`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Callback counted Focus', workMinutes: 25, autoStart: true }))).toBe(true);
    const before = await remote(world, uid);
    const result = await page.evaluate(at => {
      clearInterval(pomodoroTimer); pomodoroTimer = null;
      const previous = pomodoroRemaining;
      window.__setNow(at); tickPomodoro();
      return { previous, remaining: pomodoroRemaining, phase: pomodoroPhase };
    }, T0 + 10 * MIN);
    expect(result.remaining).toBe(result.previous - 1);
    expect(result.phase).toBe('work'); expect(await remote(world, uid)).toEqual(before);
  });
  test(`${uid}: Focus timing freezes overdue restore AutoStart before a delayed next tick and ACK`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Restore AutoStart', workMinutes: 1, autoStart: true }))).toBe(true);
    await page.evaluate(at => { window.__setNow(at); _pomodoroAutoStart = true; localStorage.setItem('ta3-pomo-auto', '1'); }, T0 + MIN);
    expect(await retainedAccountingResult(page, 'focus-end-work')).toBe(true);
    await page.evaluate(at => window.__setNow(at), T0 + 6 * MIN);
    await page.addInitScript(() => {
      const interval = window.setInterval;
      window.setInterval = (fn, ...args) => fn?.name === 'tickPomodoro' ? 0 : interval(fn, ...args);
    });
    let release, submitted = false; const held = new Promise(resolve => { release = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
    });
    let resume;
    try {
      await page.reload(); await page.waitForFunction(() => accountingIdentity());
      resume = pinned(page, world);
      try { await expect.poll(() => submitted).toBe(true); } catch (error) {
        error.message += JSON.stringify(await page.evaluate(() => ({ state: accountingCoordinator().snapshot(), producer: _focusProducer, captures: accountingCoordinator().captures(roomCode), legacy: window._accountingLegacyLoadError }))); throw error;
      }
      const captured = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.name === 'focus-end-break'));
      expect(captured.at).toBe(T0 + 6 * MIN);
      await page.evaluate(at => { window.__setNow(at); tickPomodoro(); }, T0 + 7 * MIN);
      release(); await resume;
      const after = await remote(world, uid);
      expect(after.timer).toMatchObject({ mode: 'focus', focusPhase: 'work', startedAt: T0 + 6 * MIN });
      expect(after.entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + MIN, blockIntervalMin: 1 })]);
    } finally { release(); await resume?.catch(() => {}); }
  });
  test(`${uid}: Focus integration retains an unknown checkpoint version and pauses publication`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Versioned Focus', workMinutes: 5, autoStart: true }))).toBe(true);
    const before = await remote(world, uid);
    await page.addInitScript(({ uid }) => {
      if (location.protocol !== 'http:') return;
      const key = `ta3-accounting-state-v1:uid_${uid}`;
      const state = JSON.parse(localStorage.getItem(key));
      state.committed.value.focus.v = 900;
      localStorage.setItem(key, JSON.stringify(state));
    }, { uid });
    await page.reload(); await page.waitForFunction(() => accountingIdentity() && window._accountingLegacyLoadError);
    expect(await page.evaluate(() => accountingCoordinator().snapshot().committed.value.focus.v)).toBe(900);
    expect(await page.evaluate(() => _startTimer('Must wait for recovery'))).toBe(false);
    expect(await remote(world, uid)).toEqual(before);
    expect(await page.evaluate(() => localStorage.getItem(accountLocalKey('ta3-focus-timer')))).not.toBeNull();
  });
  test(`${uid}: Focus integration defers phase and routine delivery until ACK and retains failed callbacks`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    await page.evaluate(() => {
      window.__focusHookCalls = [];
      window.__focusHookFail = true;
      globalThis.onDailyRoutineFocusStarted = (link, startedAt) => {
        window.__focusHookCalls.push({ link, startedAt });
        return !window.__focusHookFail;
      };
    });
    let release, submitted = false; const held = new Promise(resolve => { release = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
    });
    const start = page.evaluate(() => enterFocusMode({ task: 'Linked Focus', workMinutes: 5, autoStart: true,
      dailyRoutine: { instanceId: 'proof-routine', timezone: 'America/Phoenix' } }));
    try {
      await expect.poll(() => submitted).toBe(true);
      expect(await page.evaluate(() => ({ pomodoroPhase, calls: window.__focusHookCalls.length })))
        .toEqual({ pomodoroPhase: 'idle', calls: 0 });
      release(); expect(await start).toBe(true);
      expect(await page.evaluate(() => pomodoroPhase)).toBe('work');
      const original = await page.evaluate(() => accountingCoordinator().snapshot().effects[0]);
      expect(original.kind).toBe('focus-started');
      expect(await page.evaluate(() => _startTimer('Other task'))).toBe(false);
      await page.evaluate(() => { window.__focusHookFail = false; });
      await page.getByRole('button', { name: 'Check now', exact: true }).click();
      await expect.poll(() => page.evaluate(() => accountingCoordinator().snapshot().effects.length)).toBe(0);
      expect(await page.evaluate(id => accountingCoordinator().snapshot().effectReceipts[id].operationId, original.id)).toBe(original.operationId);
      expect((await remote(world, uid)).timer).toMatchObject({ mode: 'focus', focusPhase: 'work', startedAt: T0 });
    } finally { release(); await start.catch(() => {}); }
  });
  test(`${uid}: Focus integration partial exit retains its captured endpoint through lost reply and reload`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Partial Focus', workMinutes: 5, autoStart: true }))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 3 * MIN);
    let sent = false;
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() === 'GET' && sent) return route.abort('failed');
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fetch(); sent = true; return route.abort('failed');
    });
    expect(await page.evaluate(() => confirmExitFocus())).toBe(false);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    expect(original.input.name).toBe('focus-exit');
    expect(await page.evaluate(() => pomodoroPhase)).toBe('work');
    await page.unroute(pattern); await page.evaluate(ts => window.__setNow(ts), T0 + 6 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    await page.evaluate(() => accountingCoordinator().drain());
    expect(await page.evaluate(() => pomodoroPhase)).toBe('idle');
    const after = await remote(world, uid);
    expect(after.entries).toEqual([expect.objectContaining({ id: T0 + 3 * MIN, tsStart: T0, ts: T0 + 3 * MIN, blockIntervalMin: 3 })]);
    expect(after.timer.running).toBe(false);
    expect(await page.evaluate(id => accountingCoordinator().snapshot().history.find(op => op.id === id).proposal, original.id)).toEqual(original.proposal);
    expect(await page.evaluate(() => localStorage.getItem(accountLocalKey('ta3-focus-timer')))).toBeNull();
  });
  test(`${uid}: Focus integration keeps an unrelated prior Undo and refuses foreign-device completion`, async ({ page }) => {

    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world); await saved(page, world, uid);
    const undo = await page.evaluate(() => cloneUndoValue(lastUndoAction));
    expect(await page.evaluate(() => enterFocusMode({ task: 'Owned Focus', workMinutes: 5, autoStart: true }))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 15 * MIN);
    await page.evaluate(() => {
      window.__proofFocusStep = { promise: endWorkSession() };
      window.__proofFocusStep.promise.then(result => { window.__proofFocusStep.result = result; });
    });
    await expect.poll(() => page.evaluate(() => window.__proofFocusStep.result)).toBe(true);
    expect(await page.evaluate(() => lastUndoAction)).toEqual(undo);
    const before = await remote(world, uid);
    await page.evaluate(() => {
      window.__proofFocusStep = { promise: stageAccountingChange('proof-focus-transfer', draft => { draft.timerOwnerDeviceId = 'peer-device'; }, { timer: true }) };
      window.__proofFocusStep.promise.then(result => { window.__proofFocusStep.result = result; });
    });
    await expect.poll(() => page.evaluate(() => window.__proofFocusStep.result)).toBe(true);
    const transferred = (await remote(world, uid)).timer;
    const history = await page.evaluate(() => accountingCoordinator().snapshot().history.filter(op => op.input.name === 'focus-end-break').length);
    expect(await retainedAccountingResult(page, 'focus-end-pomodoro-break')).toBe(false);
    expect(await page.evaluate(() => accountingCoordinator().snapshot().history.filter(op => op.input.name === 'focus-end-break').length)).toBe(history);
    expect((await remote(world, uid)).timer).toEqual(transferred);
    expect((await remote(world, uid)).entries).toEqual(before.entries);
    expect(await acknowledgedUndo(page)).toBe(true);
    const after = await remote(world, uid);
    expect(after.entries.find(entry => entry.id === T0 + 10 * MIN).deleted).toBe(true);
    expect(after.entries.find(entry => entry.id === T0 + 15 * MIN).deleted).toBeUndefined();
    expect(after.timer).toMatchObject({ ownerDeviceId: 'peer-device', mode: 'focus', focusPhase: 'break' });
  });
  test(`${uid}: Focus integration keeps the original full-phase endpoint through delayed observation and Break`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Focus proof', workMinutes: 5, autoStart: true }))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 7 * MIN);
    expect(await retainedAccountingResult(page, 'focus-end-work')).toBe(true);
    const after = await remote(world, uid);
    expect(after.entries.filter(entry => !entry.deleted)).toEqual([expect.objectContaining({
      id: T0 + 5 * MIN, tsStart: T0, ts: T0 + 5 * MIN, blockIntervalMin: 5, activity: 'Focus proof', energy: 'deep',
    })]);
    expect(after.timer).toMatchObject({ mode: 'focus', focusPhase: 'break', running: true, startedAt: T0 + 5 * MIN });
    expect(await page.evaluate(() => ({ pomodoroPhase, focusStartTime, pomodoroCount, lastUndoAction })))
      .toEqual({ pomodoroPhase: 'break', focusStartTime: null, pomodoroCount: 1, lastUndoAction: null });
    await page.evaluate(ts => window.__setNow(ts), T0 + 12 * MIN);
    expect(await retainedAccountingResult(page, 'focus-end-pomodoro-break')).toBe(true);
    expect((await remote(world, uid)).timer.running).toBe(false);
    expect((await remote(world, uid)).entries).toHaveLength(1);
  });
  for (const canonical of ['stopped', 'foreign-owned']) {
    test(`${uid}: integrated ${canonical} restore preserves heartbeat beside unreadable caches`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world); await saved(page, world, uid);
      if (canonical === 'stopped') expect(await retainedAccountingResult(page, 'stop')).toBe(true);
      else {
        await page.evaluate(() => {
          window.__ownerTransferProof = { promise: stageAccountingChange('proof-owner-transfer', draft => {
            draft.timerOwnerDeviceId = 'peer-device';
          }, { timer: true }) };
          window.__ownerTransferProof.promise.then(value => { window.__ownerTransferProof.result = value; });
        });
        await expect.poll(() => page.evaluate(() => window.__ownerTransferProof.result)).toBe(true);
      }
      const before = await remote(world, uid), original = '{retain unreadable recorded time';
      await page.addInitScript(({ uid, original, heartbeat }) => {
        if (location.protocol !== 'http:') return;
        localStorage.setItem(`ta3-entries:uid_${uid}`, original);
        localStorage.setItem(`ta3-heartbeat-ts:uid_${uid}`, String(heartbeat));
      }, { uid, original, heartbeat: T0 + 11 * MIN });
      await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
      expect(await remote(world, uid)).toEqual(before);
      expect(await page.evaluate(() => window._accountingLegacyLoadError)).toBeTruthy();
      expect(await page.evaluate(() => localStorage.getItem(accountLocalKey('ta3-entries')))).toBe(original);
      expect(await page.evaluate(() => localStorage.getItem(accountLocalKey('ta3-heartbeat-ts')))).toBe(String(T0 + 11 * MIN));
      expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).not.toBe(true);
    });
  }
  for (const cacheCase of ['interrupted-cache', 'unacknowledged-cache', 'unreadable-cache']) {
    test(`${uid}: integrated bootstrap preserves ${cacheCase} before canonical restore`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world); await saved(page, world, uid);
      const before = await remote(world, uid);
      const original = await page.evaluate(({ cacheCase, start, end }) => {
        const key = accountLocalKey('ta3-entries');
        let raw;
        if (cacheCase === 'interrupted-cache') raw = '[]';
        else if (cacheCase === 'unreadable-cache') raw = '{original unreadable entry bytes';
        else raw = JSON.stringify([...entries, { id: end, tsStart: start, ts: end, blockIntervalMin: 2,
          activity: 'Unacknowledged work', energy: 'deep', originalNote: 'retain original legacy fact' }]);
        localStorage.setItem(key, raw);
        localStorage.setItem(accountLocalKey('ta3-heartbeat-ts'), String(start + 60000));
        return raw;
      }, { cacheCase, start: T0 + 10 * MIN, end: T0 + 12 * MIN });
      await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
      expect(await remote(world, uid)).toEqual(before);
      if (cacheCase === 'interrupted-cache') {
        expect(await page.evaluate(() => entries.length)).toBe(1);
        await expect.poll(() => page.evaluate(() => accountingCoordinator().snapshot().queue.length)).toBe(0);
      } else if (cacheCase === 'unacknowledged-cache') {
        const pending = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.name === 'legacy-accounting-caches'));
        expect(pending).toMatchObject({ phase: 'conflict', reason: 'legacy-source-needs-resolution' });
        expect(pending.input.source['ta3-entries']).toBe(original);
        expect(JSON.parse(pending.input.source['ta3-entries']).some(entry => entry.activity === 'Unacknowledged work')).toBe(true);
        expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).not.toBe(true);
      } else {
        expect(await page.evaluate(() => localStorage.getItem(accountLocalKey('ta3-entries')))).toBe(original);
        expect(await page.evaluate(() => localStorage.getItem(accountLocalKey('ta3-heartbeat-ts')))).toBe(String(T0 + 11 * MIN));
        expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).not.toBe(true);
        expect(await page.evaluate(() => window._accountingLegacyLoadError)).toBeTruthy();
      }
    });
  }
  test(`${uid}: integrated late ACK retains an old writer cache fact before materialization`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    let release, submitted = false; const held = new Promise(resolve => { release = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
    });
    const save = page.evaluate(() => _doQuickSave('Writing', 'deep'));
    try {
      await expect.poll(() => submitted).toBe(true);
      const original = await page.evaluate(({ start, end }) => {
        const raw = JSON.stringify([{ id: end, tsStart: start, ts: end, blockIntervalMin: 2,
          activity: 'Old writer observed work', energy: 'deep', originalNote: 'exact original cache bytes' }]);
        localStorage.setItem(accountLocalKey('ta3-entries'), raw);
        return raw;
      }, { start: T0 + 20 * MIN, end: T0 + 22 * MIN });
      release(); await save;
      const pending = await page.evaluate(() => [...accountingCoordinator().snapshot().queue,
        ...accountingCoordinator().captures(roomCode).map(item => item.captured)]
        .find(op => op.input.name === 'legacy-accounting-caches'));
      expect(pending?.input.source['ta3-entries']).toBe(original);
      expect((await remote(world, uid)).entries).toHaveLength(1);
      expect(await page.evaluate(() => taskStartTime)).toBe(T0 + 10 * MIN);
      expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).not.toBe(true);
    } finally { release(); await save.catch(() => {}); }
  });
  test(`${uid}: integrated late Save ACK preserves a newer SDK takeover and Stop generation`, async ({ page, browser }, info) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    let release, submitted = false; const held = new Promise(resolve => { release = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
    });
    const save = page.evaluate(() => _doQuickSave('Writing', 'deep'));
    const peerContext = await browser.newContext({ serviceWorkers: 'block' });
    await peerContext.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    try {
      await expect.poll(() => submitted).toBe(true);
      const peer = await peerContext.newPage(); await open(peer, world, uid, 'peer-device'); await pinned(peer, world);
      await peer.evaluate(ts => window.__setNow(ts), T0 + 11 * MIN);
      const takeover = await retainedAccountingResult(peer, 'take-over');
      if (!takeover) await info.attach('peer-takeover-diagnostic', { contentType: 'application/json', body: JSON.stringify(await peer.evaluate(() => ({
        state: accountingCoordinator().snapshot(), captures: accountingCoordinator().captures(roomCode), live: captureAccountingFrame(),
        error: window._accountingLegacyLoadError,
      })), null, 2) });
      expect(takeover).toBe(true);
      await peer.evaluate(ts => window.__setNow(ts), T0 + 12 * MIN);
      expect(await retainedAccountingResult(peer, 'stop')).toBe(true);
      const stopped = await remote(world, uid);
      release(); expect(await save).toBe(true);
      expect(await page.evaluate(() => ({ running, currentTask, taskStartTime, timerOwnerDeviceId })))
        .toEqual({ running: false, currentTask: '', taskStartTime: null, timerOwnerDeviceId: null });
      expect(await remote(world, uid)).toEqual(stopped);
      expect(stopped.entries.filter(entry => !entry.deleted).sort((a, b) => a.ts - b.ts)
        .map(entry => [entry.tsStart, entry.ts, entry.blockIntervalMin]))
        .toEqual([[T0, T0 + 10 * MIN, 10], [T0 + 10 * MIN, T0 + 12 * MIN, 2]]);
      await expect.poll(() => page.evaluate(() => accountingCoordinator().snapshot().queue.length)).toBe(0);
      expect(await page.evaluate(() => localStorage.getItem(accountLocalKey('ta3-heartbeat-ts')))).toBeNull();
      expect(await acknowledgedUndo(page)).toBe(true);
      expect((await remote(world, uid)).timer).toEqual(stopped.timer);
    } finally {
      await info.attach('newer-generation-local-state', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => {
        const state = accountingCoordinator().snapshot();
        return { queue: state.queue, committed: state.committed, live: captureAccountingFrame() };
      }), null, 2) });
      release(); await save.catch(() => {}); await peerContext.close();
    }
  });
  test(`${uid}: integrated permanent Keep server fence survives a lost cancellation reply and rejects original Undo forever`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world); await saved(page, world, uid);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    expect(await page.evaluate(() => undoLastAction())).toBe(false);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    await page.unroute(pattern);
    const cancelPattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}/timeAckCancellations/*.json*`;
    await page.route(cancelPattern, async route => { await route.fetch(); return route.abort('failed'); });
    await page.getByRole('button', { name: 'Keep server version', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm keep server', exact: true }).click();
    await expect.poll(() => page.evaluate(() => accountingCoordinator().snapshot().queue.length)).toBe(0);
    const after = await remote(world, uid);
    expect(after.entries).toHaveLength(1); expect(after.entries[0].deleted).toBeUndefined();
    expect(after.timer.taskStartTime).toBe(T0 + 10 * MIN);
    expect(await page.evaluate(() => lastUndoAction)).toEqual(original.input.before.lastUndoAction);
    expect(await world.read(`rooms/uid_${uid}/timeAckCancellations/${original.id}`)).toBe(true);
    const late = await page.evaluate(async ({ owner, patch }) => {
      const rest = TimeAckCore.createRestTransport({ databaseURL: fbApp.options.databaseURL,
        getIdToken: () => currentUser.getIdToken(), fetchImpl: (...args) => fetch(...args) });
      return (await rest.patch(owner, patch)).status;
    }, { owner: `uid_${uid}`, patch: original.proposal.patch });
    expect(late).toBe(401);
    await page.evaluate(ts => window.__setNow(ts), T0 + 12 * MIN);
    expect(await page.evaluate(() => { quickLogBusy = false; return _doQuickSave('Writing', 'deep'); })).toBe(true);
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 12 * MIN, blockIntervalMin: 12 })]);
  });
  test(`${uid}: integrated cancellation preserves a usable guarded Undo for an accepted Save`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    await page.evaluate(() => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === `${AccountingCommand.BASE}:${roomCode}`) {
          const receipt = JSON.parse(value).history?.at(-1);
          if (receipt?.input.name === 'quick-save' && receipt.phase === 'local-applied') throw Error('Interrupted Save apply');
        }
        return write.call(this, key, value);
      };
      window.__restoreAccountingStorage = () => { Storage.prototype.setItem = write; };
    });
    try {
      expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(false);
      const original = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
      expect(original.phase).toBe('accepted');
      expect((await page.evaluate(id => accountingCoordinator().cancel(id), original.id)).status).toBe('fenced-reconciled');
      await page.evaluate(() => window.__restoreAccountingStorage());
      expect(await acknowledgedUndo(page)).toBe(true);
      expect((await remote(world, uid)).entries[0].deleted).toBe(true);
      expect(await page.evaluate(() => taskStartTime)).toBe(T0);
    } finally { await page.evaluate(() => window.__restoreAccountingStorage()); }
  });
  test(`${uid}: integrated cancellation consumes an accepted Undo after interrupted local apply`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world); await saved(page, world, uid);
    const undoBefore = await page.evaluate(() => cloneUndoValue(lastUndoAction));
    await page.evaluate(() => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === `${AccountingCommand.BASE}:${roomCode}`) {
          const receipt = JSON.parse(value).history?.at(-1);
          if (receipt?.input.name === 'undo' && receipt.phase === 'local-applied') throw Error('Interrupted Undo apply');
        }
        return write.call(this, key, value);
      };
      window.__restoreAccountingStorage = () => { Storage.prototype.setItem = write; };
    });
    try {
      expect(await page.evaluate(() => undoLastAction())).toBe(false);
      const original = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
      expect(original.phase).toBe('accepted');
      expect(await page.evaluate(() => lastUndoAction)).toEqual(undoBefore);
      expect((await remote(world, uid)).entries[0].deleted).toBe(true);
      expect((await page.evaluate(id => accountingCoordinator().cancel(id), original.id)).status).toBe('fenced-reconciled');
      expect(await page.evaluate(() => lastUndoAction)).toBeNull();
      expect(await page.evaluate(() => accountingCoordinator().snapshot().queue.filter(op => op.input.name !== 'hydrate-accounting').length)).toBe(0);
      expect(await page.evaluate(() => taskStartTime)).toBe(T0);
    } finally { await page.evaluate(() => window.__restoreAccountingStorage()); }
  });
  test(`${uid}: integrated fence cannot silently discard an unsubmitted captured work span`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(false);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    await page.unroute(pattern);
    expect((await page.evaluate(id => accountingCoordinator().cancel(id), original.id)).reason).toBe('captured-time-needs-resolution');
    const pending = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    expect(pending.input).toEqual(original.input); expect(pending.proposal).toEqual(original.proposal);
    expect(pending.phase).toBe('cancelling');
    expect(await page.evaluate(() => ({ taskStartTime, entries }))).toEqual({ taskStartTime: T0, entries: [] });
    expect((await remote(world, uid)).entries).toHaveLength(0);
  });
  test(`${uid}: pending-span reversed automatic clock retains the child without shortening its accepted parent`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('PC Time'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 45 * MIN);
    let release, submitted = false; const held = new Promise(resolve => { release = resolve; });
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
    });
    const parent = page.evaluate(({ start, end }) => autoLogBlock('PC Time', 'shallow', start, end), { start: T0, end: T0 + 45 * MIN });
    let child;
    try {
      await expect.poll(() => submitted).toBe(true);
      const parentId = await page.evaluate(() => accountingCoordinator().snapshot().queue[0].id);
      await page.evaluate(ts => window.__setNow(ts), T0 + 42 * MIN);
      child = page.evaluate(({ start, end }) => autoLogBlock('PC Time', 'shallow', start, end), { start: T0, end: T0 + 42 * MIN });
      await expect.poll(() => page.evaluate(() => accountingCoordinator().captures(roomCode).filter(item => item.captured.input.name === 'automatic-log').length)).toBe(1);
      const original = await page.evaluate(() => accountingCoordinator().captures(roomCode).find(item => item.captured.input.name === 'automatic-log').captured);
      expect(original.dependsOn).toBe(parentId);
      release(); await Promise.all([parent, child]);
      const after = await remote(world, uid);
      expect(after.entries).toEqual([expect.objectContaining({ id: T0 + 45 * MIN, tsStart: T0,
        ts: T0 + 45 * MIN, blockIntervalMin: 45, _csWrite: expect.objectContaining({ operationId: parentId }) })]);
      expect(after.timer.taskStartTime).toBe(T0 + 45 * MIN);
      const pending = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
      expect(pending).toMatchObject({ id: original.id, phase: 'conflict', reason: 'observation-end-precedes-source' });
      expect(pending.input).toEqual(original.input);
      await page.unroute(pattern); await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
      expect((await page.evaluate(() => accountingCoordinator().drain())).status).toBe('conflict');
      expect(await page.evaluate(id => accountingCoordinator().snapshot().queue[0].id, original.id)).toBe(original.id);
      expect(await remote(world, uid)).toEqual(after);
      expect(await page.evaluate(() => _doQuickSave('PC Time', 'shallow'))).not.toBe(true);
    } finally { release(); await Promise.allSettled([parent, child]); }
  });
  for (const lostReply of [false, true]) {
    test(`${uid}: pending-span accepted PC-Time frontier ${lostReply ? 'after lost reply/reload' : 'before ping'} is excluded from Switch`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      expect(await page.evaluate(() => _startTimer('PC Time'))).toBe(true);
      await page.evaluate(ts => window.__setNow(ts), T0 + 29 * MIN);
      const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
      let replyLost = false;
      if (lostReply) await page.route(pattern, async route => {
        if (route.request().method() === 'GET' && replyLost) return route.abort('failed');
        if (route.request().method() !== 'PATCH') return route.continue();
        await route.fetch(); replyLost = true; return route.abort('failed');
      });
      expect(await page.evaluate(({ start, end }) => autoLogBlock('PC Time', 'shallow', start, end), { start: T0, end: T0 + 29 * MIN })).toBe(!lostReply);
      if (lostReply) {
        expect(await page.evaluate(() => taskStartTime)).toBe(T0);
        const original = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
        await page.unroute(pattern); await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
        expect((await page.evaluate(() => accountingCoordinator().drain())).status).toBe('drained');
        expect(await page.evaluate(id => accountingCoordinator().snapshot().history.find(op => op.id === id).proposal, original.id)).toEqual(original.proposal);
      }
      expect(await page.evaluate(() => taskStartTime)).toBe(T0 + 29 * MIN);
      await page.evaluate(ts => window.__setNow(ts), T0 + 30 * MIN);
      expect(await page.evaluate(() => doPing())).toBe(true);
      await page.evaluate(ts => window.__setNow(ts), T0 + 35 * MIN);
      expect(await page.evaluate(() => switchToTask('Next task'))).toBe(true);
      const after = await remote(world, uid);
      expect(after.entries.filter(entry => !entry.deleted).sort((a, b) => a.ts - b.ts)
        .map(entry => [entry.id, entry.tsStart, entry.ts, entry.blockIntervalMin]))
        .toEqual([[T0 + 29 * MIN, T0, T0 + 29 * MIN, 29], [T0 + 35 * MIN, T0 + 29 * MIN, T0 + 35 * MIN, 6]]);
    });
  }
  for (const next of ['save', 'second-break', 'rename-save', 'undo-save']) {
    test(`${uid}: pending-span short Break remains excluded through ${next}`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
      await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
      expect(await page.evaluate(() => startBreak(1))).toBe(true);
      await page.evaluate(ts => window.__setNow(ts), T0 + 11 * MIN);
      expect(await retainedAccountingResult(page, 'end-break')).toBe(true);
      if (next === 'undo-save') expect(await acknowledgedUndo(page)).toBe(true);
      if (next === 'rename-save') {
        await page.evaluate(id => {
          const operation = stageAccountingChange('test-user-reclassification', draft => {
            const entry = draft.entries.find(entry => entry.id === id);
            entry.activity = 'User renamed rest';
          });
          window.__retainedQualification = { operation };
          operation.then(result => { window.__retainedQualification.outcome = { result }; },
            error => { window.__retainedQualification.outcome = { error: error.message }; });
        }, T0 + 11 * MIN);
        await expect.poll(() => page.evaluate(() => window.__retainedQualification.outcome)).toEqual({ result: true });
      }
      await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
      await page.evaluate(ts => window.__setNow(ts), T0 + 12 * MIN);
      expect(await page.evaluate(next => next === 'second-break' ? startBreak(1) : _doQuickSave('Writing', 'deep'), next)).toBe(true);
      const after = await remote(world, uid);
      expect(after.entries.filter(entry => !entry.deleted && entry.activity === 'Writing')
        .sort((a, b) => a.ts - b.ts).map(entry => [entry.id, entry.tsStart, entry.ts, entry.blockIntervalMin]))
        .toEqual([[T0 + 10 * MIN, T0, T0 + 10 * MIN, 10], [T0 + 12 * MIN, T0 + 11 * MIN, T0 + 12 * MIN, 1]]);
      const rest = after.entries.find(entry => entry.id === T0 + 11 * MIN);
      if (next === 'undo-save') expect(rest.deleted).toBe(true);
      else expect(rest).toMatchObject({ activity: next === 'rename-save' ? 'User renamed rest' : 'Break',
        tsStart: T0 + 10 * MIN, ts: T0 + 11 * MIN, blockIntervalMin: 1 });
    });
  }
  test(`${uid}: pending-span mid-block Switch uses the task anchor and later Save/Undo cannot repeat it`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 30 * MIN);
    expect(await page.evaluate(() => doPing())).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 35 * MIN);
    await page.evaluate(() => switchTaskMidBlock());
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ id: T0 + 35 * MIN,
      tsStart: T0, ts: T0 + 35 * MIN, blockIntervalMin: 35 })]);
    expect(await page.evaluate(() => taskStartTime)).toBe(T0 + 35 * MIN);
    await page.evaluate(ts => window.__setNow(ts), T0 + 37 * MIN);
    expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(true);
    expect((await remote(world, uid)).entries).toEqual([expect.objectContaining({ id: T0 + 35 * MIN,
      tsStart: T0, ts: T0 + 37 * MIN, blockIntervalMin: 37 })]);
    expect(await acknowledgedUndo(page)).toBe(true);
    expect(await page.evaluate(() => taskStartTime)).toBe(T0 + 35 * MIN);
    await page.evaluate(ts => window.__setNow(ts), T0 + 38 * MIN);
    expect(await retainedAccountingResult(page, 'stop')).toBe(true);
    expect((await remote(world, uid)).entries.filter(entry => !entry.deleted).sort((a, b) => a.ts - b.ts)
      .map(entry => [entry.tsStart, entry.ts, entry.blockIntervalMin]))
      .toEqual([[T0, T0 + 35 * MIN, 35], [T0 + 35 * MIN, T0 + 38 * MIN, 3]]);
  });
  test(`${uid}: pending-span Switch and Break refuse a different owning device before capture`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    const before = await remote(world, uid);
    await page.evaluate(() => { timerOwnerDeviceId = 'another-device'; });
    expect(await page.evaluate(() => switchToTask('Next task'))).toBe(false);
    expect(await page.evaluate(() => switchTaskMidBlock())).toBe(false);
    expect(await page.evaluate(() => startBreak(5))).toBe(false);
    expect(await remote(world, uid)).toEqual(before);
    expect(await page.evaluate(() => accountingCoordinator().snapshot().queue)).toHaveLength(0);
  });
  test(`${uid}: pending-span failed durable capture cannot close work or begin Break`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    const before = await remote(world, uid);
    await page.evaluate(ts => {
      window.__setNow(ts);
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith(AccountingCommand.INTAKE + ':')) throw Error('Capture unavailable');
        return original.call(this, key, value);
      };
    }, T0 + 10 * MIN);
    expect(await page.evaluate(() => startBreak(5))).toBe(false);
    expect(await page.evaluate(() => switchToTask('Next task'))).toBe(false);
    expect(await page.evaluate(() => ({ taskStartTime, breakActive, running }))).toEqual({ taskStartTime: T0, breakActive: false, running: true });
    expect(await remote(world, uid)).toEqual(before);
    expect(await page.evaluate(() => accountingCoordinator().snapshot().queue)).toHaveLength(0);
  });
  for (const kind of ['switch', 'break-start', 'break-end']) {
    test(`${uid}: pending-span ${kind} keeps entries, cursor and Undo unchanged during pending ACK`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
      if (kind === 'switch') {
        await page.evaluate(ts => window.__setNow(ts), T0 + 30 * MIN);
        expect(await page.evaluate(() => doPing())).toBe(true);
      } else if (kind === 'break-end') {
        await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
        expect(await page.evaluate(() => startBreak(5))).toBe(true);
      }
      await page.evaluate(ts => window.__setNow(ts), T0 + (kind === 'switch' ? 35 : kind === 'break-start' ? 10 : 15) * MIN);
      const local = () => page.evaluate(() => ({ entries, taskStartTime, blockStartTime, currentTask, running, breakActive, lastUndoAction }));
      const before = await local();
      let release, submitted = false; const held = new Promise(resolve => { release = resolve; });
      const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
      await page.route(pattern, async route => {
        if (route.request().method() !== 'PATCH') return route.continue();
        const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
      });
      const action = page.evaluate(kind => kind === 'switch' ? switchToTask('Next task') : kind === 'break-start' ? startBreak(5) : endBreak(), kind);
      try {
        await expect.poll(() => submitted).toBe(true);
        expect(await local()).toEqual(before);
        expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).not.toBe(true);
        expect(await local()).toEqual(before);
        release(); expect(await action).toBe(true);
        const after = await remote(world, uid);
        const record = after.entries.find(entry => entry.id === T0 + (kind === 'switch' ? 35 : kind === 'break-start' ? 10 : 15) * MIN);
        expect(record._csWrite.operationId).toBe(after.timer._csWrite.operationId);
        expect(await page.evaluate(() => taskStartTime)).toBe(record.ts);
      } finally { release(); await action.catch(() => {}); }
    });
  }
  for (const committed of [false, true]) {
    test(`${uid}: pending-span Switch ${committed ? 'lost reply' : 'offline send'} survives reload, immutable retry and Undo`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
      await page.evaluate(ts => window.__setNow(ts), T0 + 30 * MIN);
      expect(await page.evaluate(() => doPing())).toBe(true);
      await page.evaluate(ts => window.__setNow(ts), T0 + 35 * MIN);
      const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
      let replyLost = false;
      await page.route(pattern, async route => {
        if (route.request().method() === 'GET' && replyLost) return route.abort('failed');
        if (route.request().method() !== 'PATCH') return route.continue();
        if (committed) { await route.fetch(); replyLost = true; }
        return route.abort('failed');
      });
      expect(await page.evaluate(() => switchToTask('Next task'))).toBe(false);
      const original = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
      expect(original.phase).toBe('unknown');
      expect(await page.evaluate(() => taskStartTime)).toBe(T0);
      await page.unroute(pattern); await page.evaluate(ts => window.__setNow(ts), T0 + 40 * MIN);
      await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
      expect((await page.evaluate(() => accountingCoordinator().drain())).status).toBe('drained');
      const applied = await page.evaluate(id => accountingCoordinator().snapshot().history.find(op => op.id === id), original.id);
      expect(applied.proposal).toEqual(original.proposal);
      const after = await remote(world, uid);
      expect(after.entries.filter(entry => !entry.deleted)).toHaveLength(1);
      expect(after.entries[0]).toMatchObject({ id: T0 + 35 * MIN, tsStart: T0, ts: T0 + 35 * MIN,
        blockIntervalMin: 35, _csWrite: { operationId: original.id } });
      expect(await acknowledgedUndo(page)).toBe(true);
      expect(await page.evaluate(() => ({ taskStartTime, currentTask }))).toEqual({ taskStartTime: T0 + 35 * MIN, currentTask: 'Next task' });
      await page.evaluate(ts => window.__setNow(ts), T0 + 42 * MIN);
      expect(await retainedAccountingResult(page, 'stop')).toBe(true);
      await page.evaluate(() => accountingCoordinator().drain());
      const final = await remote(world, uid);
      expect(final.entries.find(entry => entry.id === T0 + 35 * MIN).deleted).toBe(true);
      expect(final.entries.filter(entry => !entry.deleted)).toEqual([expect.objectContaining({ activity: 'Next task',
        tsStart: T0 + 35 * MIN, ts: T0 + 42 * MIN, blockIntervalMin: 7 })]);
    });
  }
  test(`${uid}: pending-span Break offline capture and lost end reply recover exact endpoints; Save Undo cannot cross Break`, async ({ page }, info) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    expect(await page.evaluate(() => startBreak(5))).toBe(false);
    const start = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    expect(await page.evaluate(() => ({ running, taskStartTime, breakActive }))).toEqual({ running: true, taskStartTime: T0, breakActive: false });
    await page.unroute(pattern); await page.evaluate(ts => window.__setNow(ts), T0 + 11 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    expect((await page.evaluate(() => accountingCoordinator().drain())).status).toBe('drained');
    expect(await page.evaluate(id => accountingCoordinator().snapshot().history.find(op => op.id === id).proposal, start.id)).toEqual(start.proposal);
    let endSent = false;
    await page.route(pattern, async route => {
      if (route.request().method() === 'GET' && endSent) return route.abort('failed');
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fetch(); endSent = true; return route.abort('failed');
    });
    await page.evaluate(ts => window.__setNow(ts), T0 + 15 * MIN);
    expect(await retainedAccountingResult(page, 'end-break')).toBe(false);
    const end = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    if (!end) await info.attach('break-end-diagnostic', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => ({
      state: accountingCoordinator().snapshot(), captures: accountingCoordinator().captures(roomCode), live: captureAccountingFrame(),
      error: window._accountingLegacyLoadError,
    })), null, 2) });
    expect(end.input.name).toBe('break-end');
    expect(await page.evaluate(() => ({ breakActive, taskStartTime }))).toEqual({ breakActive: true, taskStartTime: T0 + 10 * MIN });
    await page.unroute(pattern); await page.evaluate(ts => window.__setNow(ts), T0 + 20 * MIN);
    await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
    expect((await page.evaluate(() => accountingCoordinator().drain())).status).toBe('drained');
    expect(await page.evaluate(id => accountingCoordinator().snapshot().history.find(op => op.id === id).proposal, end.id)).toEqual(end.proposal);
    expect(await page.evaluate(() => ({ breakActive, taskStartTime }))).toEqual({ breakActive: false, taskStartTime: T0 + 15 * MIN });
    expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(true);
    expect(await acknowledgedUndo(page)).toBe(true);
    expect(await page.evaluate(() => taskStartTime)).toBe(T0 + 15 * MIN);
    await page.evaluate(ts => window.__setNow(ts), T0 + 22 * MIN);
    await page.evaluate(() => {
      window.__pendingSpanStopProof = { promise: stopAndLog() };
      window.__pendingSpanStopProof.promise.then(value => { window.__pendingSpanStopProof.result = value; });
    });
    await expect.poll(() => page.evaluate(() => window.__pendingSpanStopProof.result)).toBe(true);
    await page.evaluate(() => accountingCoordinator().drain());
    const after = await remote(world, uid);
    expect(after.entries.filter(entry => !entry.deleted).sort((a, b) => a.ts - b.ts).map(entry => [entry.activity, entry.tsStart, entry.ts, entry.blockIntervalMin]))
      .toEqual([['Writing', T0, T0 + 10 * MIN, 10], ['Break', T0 + 10 * MIN, T0 + 15 * MIN, 5], ['Writing', T0 + 15 * MIN, T0 + 22 * MIN, 7]]);
    expect(after.entries.find(entry => entry.id === T0 + 20 * MIN).deleted).toBe(true);
  });
  for (const kind of ['switch-task', 'start-break']) {
    test(`${uid}: pending-span ${kind} interrupted before local receipt recovers after reload`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
      if (kind === 'switch-task') {
        await page.evaluate(ts => window.__setNow(ts), T0 + 30 * MIN);
        expect(await page.evaluate(() => doPing())).toBe(true);
      }
      await page.evaluate(({ ts, kind }) => {
        window.__setNow(ts);
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key.startsWith(AccountingCommand.BASE + ':') && JSON.parse(value).committed?.effectName === kind) throw Error('Interrupted before atomic apply receipt');
          return original.call(this, key, value);
        };
      }, { ts: T0 + (kind === 'switch-task' ? 35 : 10) * MIN, kind });
      expect(await page.evaluate(kind => kind === 'switch-task' ? switchToTask('Next task') : startBreak(5), kind)).toBe(false);
      expect(await page.evaluate(() => taskStartTime)).toBe(T0);
      const pending = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
      expect(pending.phase).toBe('accepted');
      await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
      expect((await page.evaluate(() => accountingCoordinator().drain())).status).toBe('drained');
      const after = await remote(world, uid);
      expect(after.entries).toHaveLength(1);
      expect(after.entries[0]._csWrite.operationId).toBe(pending.id);
      expect(await page.evaluate(() => taskStartTime)).toBe(T0 + (kind === 'switch-task' ? 35 : 10) * MIN);
    });
  }
  test(`${uid}: pending-span corrections preserve fractional event times, rounding and unrelated historical records`, async ({ page }) => {
    const world = await emulator.fresh(rules);
    const historical = { id: 77, activity: 'Historical', energy: 'shallow', tsStart: T0 - 10 * MIN,
      ts: T0 - 5 * MIN, blockIntervalMin: 5, originalNote: 'preserve byte content', deleted: true };
    await world.seed(`rooms/uid_${uid}/entries/77`, historical);
    await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    const start = T0 + 10 * MIN + 20000, end = T0 + 15 * MIN + 10000, save = T0 + 20 * MIN + 20000;
    await page.evaluate(ts => window.__setNow(ts), start); expect(await page.evaluate(() => startBreak(5))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), end); expect(await retainedAccountingResult(page, 'end-break')).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), save); expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(true);
    const after = await remote(world, uid);
    expect(after.entries.filter(entry => !entry.deleted).sort((a, b) => a.ts - b.ts).map(entry => [entry.id, entry.tsStart, entry.ts, entry.blockIntervalMin]))
      .toEqual([[start, T0, start, 10], [end, start, end, 5], [save, end, save, 5]]);
    expect(await world.read(`rooms/uid_${uid}/entries/77`)).toEqual(historical);
  });
  test(`${uid}: G2 boundary — notification-only ping then Switch must retain the whole pending task span`, async ({ page }, info) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 30 * MIN);
    expect(await page.evaluate(() => doPing())).toBe(true);
    expect((await remote(world, uid)).entries).toHaveLength(0);
    await page.evaluate(ts => window.__setNow(ts), T0 + 35 * MIN);
    expect(await page.evaluate(() => switchToTask('Next task'))).toBe(true);
    const after = await remote(world, uid);
    await info.attach('accounting-math-boundary', { contentType: 'application/json', body: JSON.stringify({ after,
      envelope: await page.evaluate(() => accountingCoordinator().snapshot()) }, null, 2) });
    expect(after.entries.filter(entry => !entry.deleted).map(entry => [entry.tsStart, entry.ts, entry.blockIntervalMin]))
      .toEqual([[T0, T0 + 35 * MIN, 35]]);
  });
  test(`${uid}: G2 boundary — work after Break must not repeat earlier work or include the logged break`, async ({ page }, info) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    expect(await page.evaluate(() => startBreak(5))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 15 * MIN);
    expect(await retainedAccountingResult(page, 'end-break')).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 20 * MIN);
    expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(true);
    const after = await remote(world, uid);
    await info.attach('accounting-math-boundary', { contentType: 'application/json', body: JSON.stringify({ after,
      envelope: await page.evaluate(() => accountingCoordinator().snapshot()) }, null, 2) });
    const work = after.entries.filter(entry => !entry.deleted && entry.activity === 'Writing')
      .sort((a, b) => a.tsStart - b.tsStart).map(entry => [entry.tsStart, entry.ts, entry.blockIntervalMin]);
    expect(work).toEqual([[T0, T0 + 10 * MIN, 10], [T0 + 15 * MIN, T0 + 20 * MIN, 5]]);
  });
  test(`${uid}: actual scheduled replay survives the abort window, template edit and reload with its original occurrence`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(true);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    expect(await page.evaluate(() => undoLastAction())).toBe(false);
    const undo = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    await page.evaluate(() => {
      settings.templates = [{ id: 'scheduled-proof', enabled: true, autoLog: true, days: [3],
        startTime: '07:00', endTime: '08:00', activity: 'Scheduled work', energy: 'nine5' }];
      return autoLogDueTemplates({ notify: false });
    });
    await page.evaluate(() => { settings.templates[0].startTime = '06:00'; settings.templates[0].activity = 'Edited later'; });
    expect(await world.patch(`rooms/uid_${uid}`, undo.proposal.patch, token(uid))).toBe(true);
    await page.evaluate(() => autoLogHeartbeatTick());
    await expect.poll(() => page.evaluate(() => {
      const command = accountingCoordinator().snapshot().queue[0];
      return [command?.input.name, command?.phase];
    })).toEqual(['scheduled-log', 'unknown']);
    const captured = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    expect((await remote(world, uid)).entries.find(entry => entry.templateId === 'scheduled-proof')).toBeUndefined();
    expect(captured.input.observation.facts.entry).toMatchObject({ activity: 'Scheduled work', blockIntervalMin: 60,
      tsStart: Date.parse('2026-10-28T14:00:00Z'), ts: Date.parse('2026-10-28T15:00:00Z') });
    await page.unroute(pattern); await page.reload();
    await page.waitForFunction(room => getChronaSenseRoomCode() === room && !!_timeAckOnline?.online, `uid_${uid}`);
    await pinned(page, world);
    await page.evaluate(() => timeAckUserAction('check'));
    const after = (await remote(world, uid)).entries.filter(entry => entry.templateId === 'scheduled-proof');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ activity: 'Scheduled work', blockIntervalMin: 60,
      tsStart: Date.parse('2026-10-28T14:00:00Z'), ts: Date.parse('2026-10-28T15:00:00Z'),
      _csWrite: { operationId: captured.id } });
    expect(await page.evaluate(() => accountingCoordinator().snapshot().queue)).toHaveLength(0);
    expect(await page.evaluate(() => settings.templates[0].startTime)).toBe('06:00');
  });
  test(`${uid}: numeric physical source remains singular through extension, Delete and Undo`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await world.seed(`rooms/uid_${uid}/entries/77`, { id: 77, activity: 'Writing', energy: 'deep',
      tsStart: T0, ts: T0 + 10 * MIN, updatedAt: T0 + 10 * MIN, blockIntervalMin: 10,
      originalNote: 'preserve original source' });
    await page.waitForFunction(() => entries.some(entry => entry.id === 77));
    await page.evaluate(ts => window.__setNow(ts), T0 + 12 * MIN);
    expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(true);
    let raw = await world.read(`rooms/uid_${uid}/entries`);
    expect(Object.keys(raw)).toEqual(['77']);
    expect(raw['77']).toMatchObject({ blockIntervalMin: 12, originalNote: 'preserve original source' });
    expect(await page.evaluate(() => deleteEntry(77))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 13 * MIN);
    expect(await acknowledgedUndo(page)).toBe(true);
    raw = await world.read(`rooms/uid_${uid}/entries`);
    expect(Object.keys(raw)).toEqual(['77']);
    expect(raw['77'].deleted).toBeUndefined();
    expect(raw['77']).toMatchObject({ blockIntervalMin: 12, originalNote: 'preserve original source' });
  });
  test(`${uid}: integrated Undo rewinds the acknowledged cursor and Stop logs the full next span atomically`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(true);
    expect(await acknowledgedUndo(page)).toBe(true);
    expect(await page.evaluate(() => taskStartTime)).toBe(T0);
    expect((await remote(world, uid)).entries.filter(e => !e.deleted)).toHaveLength(0);
    await page.evaluate(ts => window.__setNow(ts), T0 + 12 * MIN);
    expect(await retainedAccountingResult(page, 'stop')).toBe(true);
    const after = await remote(world, uid);
    expect(after.entries.filter(e => !e.deleted)).toHaveLength(1);
    const entry = after.entries.find(e => !e.deleted);
    expect(entry).toMatchObject({ tsStart: T0, ts: T0 + 12 * MIN, blockIntervalMin: 12 });
    expect(after.timer).toMatchObject({ running: false, stopped: true });
    expect(after.timer._csWrite.operationId).toBe(entry._csWrite.operationId);
    expect(await page.evaluate(() => ({ running, taskStartTime, currentTask }))).toEqual({ running: false, taskStartTime: null, currentTask: '' });
  });
  test(`${uid}: integrated Save keeps committed cursor/Undo unchanged until exact acknowledgement`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    let release; const held = new Promise(resolve => { release = resolve; }); let submitted = false;
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); submitted = true; await held; await route.fulfill({ response });
    });
    const save = page.evaluate(() => _doQuickSave('Writing', 'deep'));
    try {
      await expect.poll(() => submitted).toBe(true);
      expect(await page.evaluate(() => ({ count: entries.length, cursor: taskStartTime, undo: lastUndoAction })))
        .toEqual({ count: 0, cursor: T0, undo: null });
      release(); expect(await save).toBe(true);
      const after = await remote(world, uid);
      expect(after.entries.filter(e => !e.deleted)).toHaveLength(1);
      expect(after.entries[0]).toMatchObject({ tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 });
      expect(after.entries[0]._csWrite.operationId).toBe(after.timer._csWrite.operationId);
      expect(await page.evaluate(() => taskStartTime)).toBe(T0 + 10 * MIN);
      expect(await page.evaluate(() => lastUndoAction.type)).toBe('created');
    } finally { release(); await save.catch(() => {}); }
  });
  test(`${uid}: integrated Save lost reply recovers original command without recalculation`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    let replyLost = false;
    await page.route(pattern, async route => {
      if (route.request().method() === 'GET' && replyLost) return route.abort('failed');
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fetch(); replyLost = true; return route.abort('failed');
    });
    expect(await page.evaluate(() => _doQuickSave('Writing', 'deep'))).toBe(false);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue[0]);
    expect(original.phase).toBe('unknown');
    expect(await page.evaluate(() => taskStartTime)).toBe(T0);
    await page.unroute(pattern); await page.evaluate(ts => window.__setNow(ts), T0 + 15 * MIN);
    expect((await page.evaluate(() => accountingCoordinator().drain())).status).toBe('drained');
    expect(await page.evaluate(() => taskStartTime)).toBe(T0 + 10 * MIN);
    const after = await remote(world, uid);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]).toMatchObject({ ts: T0 + 10 * MIN, blockIntervalMin: 10,
      _csWrite: { operationId: original.id } });
  });
}
