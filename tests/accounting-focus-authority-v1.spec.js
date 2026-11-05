// Integrated production coordinator, real SDK and loopback-only RTDB emulator.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';
import { holdEvaluates, retainedAccountingResult } from './accounting-retained-action.js';

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

// Focus authority acceptance V1, approved 2026-10-31. Originals remain unchanged.
// Explicit legacy disposition (twelve cases in focus-reload-recovery.spec.js):
// chaos 7: preserve malformed/incomplete bytes, never remove their source key (FA3).
// count clamp: no activation/adoption of ownerDeviceId:null, regardless of count (FA3).
// chaos 8 + older-owner reconciliation: raw timestamps cannot establish ownership (FA4).
// newer takeover + reload-after-B: coherent durable server winner survives reload (FA4).
// same-owner echo + same-owner/newer + same-owner/older: no one-shot flag authority (FA4).
// fresh conflicting update: raw claims cannot beat confirmed authority (FA4).
// newer generic + generic-then-Focus: coherent server state decides mode, not raw mode (FA4).
// Fourteen compatible original outcomes are exercised through actual staged ACK/SDK paths below
// and existing accounting-staged-effects Focus expiry, Learning and completion cases.
async function reloadPinned(page, world) {
  await page.reload(); await page.waitForFunction(() => accountingIdentity()); await pinned(page, world);
}
for (const uid of ['alice', 'bob']) {
  test(`${uid}: FA1-V1 confirmed work and break survive repeated reload with original identity and one receipt`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Authoritative Focus', workMinutes: 25, autoStart: true }))).toBe(true);
    const original = (await remote(world, uid)).timer;
    for (let i = 0; i < 2; i++) {
      await reloadPinned(page, world);
      expect((await remote(world, uid)).timer).toEqual(original);
      expect(await page.evaluate(() => ({ phase: pomodoroPhase, start: pomodoroPhaseStartedAt, owner: timerOwnerDeviceId })))
        .toEqual({ phase: 'work', start: T0, owner: 'proof-device' });
      await expect(page.locator('#focus-recovery-status')).toContainText('Confirmed Focus');
    }
    await page.evaluate(at => window.__setNow(at), T0 + 25 * MIN); expect(await retainedAccountingResult(page, 'focus-end-work')).toBe(true);
    const completed = await remote(world, uid);
    expect(completed.entries).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 25 * MIN, blockIntervalMin: 25 })]);
    await reloadPinned(page, world);
    expect(await page.evaluate(() => pomodoroPhase)).toBe('break');
    expect((await remote(world, uid)).entries).toEqual(completed.entries);
  });
  for (const elapsed of [25, 40, 300]) {
    test(`${uid}: FA1-V1 expired ${elapsed} minute restore keeps the planned endpoint and exactly one completion`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      expect(await page.evaluate(() => enterFocusMode({ task: 'Expired Focus', workMinutes: 25, autoStart: true }))).toBe(true);
      await page.evaluate(at => { clearInterval(_focusProducerTicker); _focusProducerTicker = null; window.__setNow(at); }, T0 + elapsed * MIN);
      await reloadPinned(page, world);
      await expect.poll(async () => (await remote(world, uid)).entries.length).toBe(1);
      const completed = (await remote(world, uid)).entries;
      expect(completed).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 25 * MIN, blockIntervalMin: 25 })]);
      await reloadPinned(page, world);
      expect((await remote(world, uid)).entries).toEqual(completed);
      expect(await page.evaluate(() => pomodoroPhase)).toBe(elapsed === 25 ? 'break' : 'idle');
    });
  }
  test(`${uid}: FA1-V1 manual early exit retains real elapsed time`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Early exit', workMinutes: 25, autoStart: true }))).toBe(true);
    expect(await page.evaluate(at => { window.__setNow(at); return confirmExitFocus(); }, T0 + 7 * MIN)).toBe(true);
    const rows = (await remote(world, uid)).entries;
    expect(rows).toEqual([expect.objectContaining({ tsStart: T0, ts: T0 + 7 * MIN, blockIntervalMin: 7 })]);
    await reloadPinned(page, world); expect(await page.evaluate(() => pomodoroPhase)).toBe('idle');
    expect((await remote(world, uid)).entries).toEqual(rows);
  });
  test(`${uid}: FA2-V1 durable owned Focus capture restores provisionally without confirmed accounting`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern, route => route.abort('failed'));
    expect(await page.evaluate(() => enterFocusMode({ task: 'Captured Focus', workMinutes: 25, autoStart: true }))).toBe(false);
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.input.name === 'focus-start'));
    expect(original.owner).toBe(`uid_${uid}`); expect(original.device).toBe('proof-device'); expect(original.at).toBe(T0);
    await reloadPinned(page, world);
    expect(await page.evaluate(() => ({ phase: pomodoroPhase, entries: entries.length, producer: _focusProducer?.frame.currentTask })))
      .toEqual({ phase: 'idle', entries: 0, producer: 'Captured Focus' });
    await expect(page.locator('#focus-recovery-status')).toContainText('Provisional Focus');
    expect(await page.evaluate(() => accountingCoordinator().snapshot().queue.find(op => op.id === _focusProducer.parentId).at)).toBe(T0);
    await page.unroute(pattern); await page.evaluate(() => accountingCoordinator().drain());
    await expect.poll(() => page.evaluate(() => pomodoroPhase)).toBe('work');
    expect((await remote(world, uid)).timer.startedAt).toBe(T0);
    expect((await remote(world, uid)).timer._csWrite.operationId).toBe(original.id);
    await expect(page.locator('#focus-recovery-status')).toContainText('Confirmed Focus');
  });
  test(`${uid}: FA2-V1 changed device cannot resume another device provisional producer`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`; await page.route(pattern, route => route.abort('failed'));
    await page.evaluate(() => enterFocusMode({ task: 'Other-device capture', workMinutes: 25, autoStart: true }));
    const original = await page.evaluate(() => accountingCoordinator().snapshot().queue.filter(op => op.input.name === 'focus-start'));
    await page.evaluate(() => localStorage.setItem('ta3-device-id', 'changed-device'));
    await reloadPinned(page, world);
    expect(await page.evaluate(() => _focusProducer)).toBeNull();
    expect(await page.evaluate(() => pomodoroPhase)).toBe('idle');
    expect(await page.evaluate(() => accountingCoordinator().snapshot().queue.filter(op => op.input.name !== 'hydrate-accounting').map(op => ({ id: op.id, input: op.input, device: op.device }))))
      .toEqual(original.map(op => ({ id: op.id, input: op.input, device: op.device })));
    expect((await remote(world, uid)).timer).toBeNull();
  });

  for (const fault of ['schema', 'account', 'session']) {
    test(`${uid}: FA2-V1 invalid ${fault} provisional identity is retained without producer activation`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      await page.route(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`, route => route.abort('failed'));
      await page.evaluate(() => enterFocusMode({ task: 'Invalid source', workMinutes: 25, autoStart: true }));
      const input = await page.evaluate(fault => {
        const key = `${AccountingCommand.BASE}:${roomCode}`, state = JSON.parse(localStorage.getItem(key));
        const op = state.queue.find(op => op.input.name === 'focus-start');
        if (fault === 'schema') op.input.after.focus.pomodoroCount = -1;
        if (fault === 'account') op.input.after._timerStateOwner = 'uid_other';
        if (fault === 'session') op.input.after.timerStartedAt++;
        localStorage.setItem(key, JSON.stringify(state)); return { id: op.id, input: op.input };
      }, fault);
      await reloadPinned(page, world);
      expect(await page.evaluate(() => ({ producer: _focusProducer, phase: pomodoroPhase }))).toEqual({ producer: null, phase: 'idle' });
      expect(await page.evaluate(id => accountingCoordinator().snapshot().queue.find(op => op.id === id).input, input.id)).toEqual(input.input);
      expect((await remote(world, uid)).timer).toBeNull(); expect((await remote(world, uid)).entries).toEqual([]);
      await page.unroute(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`);
      await page.evaluate(() => {
        window.__invalidReconnect = { promise: accountingCoordinator().drain() };
        window.__invalidReconnect.promise.then(result => { window.__invalidReconnect.outcome = { result }; },
          error => { window.__invalidReconnect.outcome = { error: error.message }; });
      });
      await expect.poll(() => page.evaluate(() => !!window.__invalidReconnect.outcome)).toBe(true);
      expect((await remote(world, uid)).timer).toBeNull(); expect((await remote(world, uid)).entries).toEqual([]);
      expect(await page.evaluate(() => ({ producer: _focusProducer, phase: pomodoroPhase }))).toEqual({ producer: null, phase: 'idle' });
      expect(await page.evaluate(id => accountingCoordinator().snapshot().queue.find(op => op.id === id).input, input.id)).toEqual(input.input);

    });
  }
  test(`${uid}: FA1-V1 temporary Focus restore readback failure pauses then recovers without permanent poison`, async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Readback recovery', workMinutes: 25, autoStart: true }))).toBe(true);
    const before = await remote(world, uid);
    const result = await page.evaluate(() => {
      accountingCoordinator().capture({ name: 'retained-readback-proof' });
      const read = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) { if (key.startsWith(`${AccountingCommand.INTAKE}:`)) throw Error('Transient read failure'); return read.call(this, key); };
      try { return { restored: restoreFocusSession(), error: window._accountingLegacyLoadError, producer: _focusProducer }; }
      finally { Storage.prototype.getItem = read; }
    });
    expect(result).toEqual({ restored: false, error: null, producer: null });
    expect(await page.evaluate(() => restoreFocusSession())).toBe(true);
    expect(await page.evaluate(() => _focusProducer.frame.currentTask)).toBe('Readback recovery');
    expect(await remote(world, uid)).toEqual(before);
  });
  for (const kind of ['ownerless', 'malformed', 'incomplete', 'null', 'false', 'zero', 'array', 'object', 'string']) {
    test(`${uid}: FA3-V1 ${kind} Focus cache stays byte-identical without activation or deletion`, async ({ page }) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      const raw = ({ null: 'null', false: 'false', zero: '0', array: '[]', object: '{}', string: '"legacy"' })[kind] || (kind === 'malformed' ? 'not valid json {{' : JSON.stringify(kind === 'incomplete' ? { pomodoroPhase: 'work' } : {
        pomodoroPhase: 'work', pomodoroPhaseStartedAt: T0 - MIN, pomodoroWorkMin: 25, pomodoroBreakMin: 5,
        pomodoroCount: 999999999, task: 'Corrupt count', hudFocusLinkType: 'none', ownerDeviceId: null }));
      await page.evaluate(raw => localStorage.setItem(accountLocalKey('ta3-focus-timer'), raw), raw);
      for (let i = 0; i < 2; i++) {
        await reloadPinned(page, world);
        expect(await page.evaluate(() => ({ phase: pomodoroPhase, producer: _focusProducer,
          raw: localStorage.getItem(accountLocalKey('ta3-focus-timer')), error: window._accountingLegacyLoadError })))
          .toEqual({ phase: 'idle', producer: null, raw, error: null });
        await expect(page.locator('#focus-recovery-status')).toContainText('Retained-unproven');
        expect((await remote(world, uid)).timer).toBeNull(); expect((await remote(world, uid)).entries).toEqual([]);
      }
    });
  }
  for (const legacyKind of ['ownerless', 'malformed']) {
  test(`${uid}: FA4-V1 ${legacyKind} raw legacy hints cannot override coherent Focus, peer takeover or newer generic state`, async ({ page, browser }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
    expect(await page.evaluate(() => enterFocusMode({ task: 'Confirmed original', workMinutes: 25, autoStart: true }))).toBe(true);
    const original = (await remote(world, uid)).timer;
    for (const timer of [{ ...original, ownerDeviceId: 'raw-other', updatedAt: T0 - MIN },
      { ...original, ownerDeviceId: 'raw-other', updatedAt: T0 + MIN },
      { ...original, updatedAt: T0 + MIN }, { ...original, mode: 'normal', updatedAt: T0 + MIN }]) {
      await page.evaluate(timer => applyRemoteTimerState(timer), timer);
      expect(await page.evaluate(() => timerOwnerDeviceId)).toBe('proof-device');
      expect((await remote(world, uid)).timer).toEqual(original);
    }
    const peerContext = await browser.newContext({ serviceWorkers: 'block' });
    await peerContext.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    try {
      const peer = await peerContext.newPage(); await open(peer, world, uid, 'peer-device'); await pinned(peer, world);
      expect(await peer.evaluate(() => takeOverSyncedFocusTimer())).toBe(true);
      await page.evaluate(() => requestAccountingRefresh());
      await expect.poll(() => page.evaluate(() => timerOwnerDeviceId)).toBe('peer-device');
      const raw = legacyKind === 'malformed' ? 'unreadable original {{' : JSON.stringify({ pomodoroPhase: 'work', pomodoroPhaseStartedAt: T0, ownerDeviceId: null, task: 'Unproven original' });
      await page.evaluate(raw => localStorage.setItem(accountLocalKey('ta3-focus-timer'), raw), raw);
      await reloadPinned(page, world);
      expect(await page.evaluate(() => timerOwnerDeviceId)).toBe('peer-device');
      expect(await page.evaluate(() => _focusProducer)).toBeNull();
      expect(await peer.evaluate(() => confirmExitFocus())).toBe(true);
      expect(await peer.evaluate(() => _startTimer('Newer coherent ordinary'))).toBe(true);
      await page.evaluate(() => requestAccountingRefresh());
      await expect.poll(() => page.evaluate(() => pomodoroPhase)).toBe('idle');
      expect(await page.evaluate(() => currentTask)).toBe('Newer coherent ordinary');
      expect(await page.evaluate(() => localStorage.getItem(accountLocalKey('ta3-focus-timer')))).toBe(raw);
      await expect(page.locator('#focus-recovery-status')).toContainText('Retained-unproven');
    } finally { await peerContext.close(); }
  });
  }
  for (const width of [390, 1280]) {
    test(`${uid}: FA-V1 pending panel remains opaque and unobscured at ${width}px`, async ({ page }, info) => {
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page, world);
      await page.setViewportSize({ width, height: 900 });
      await page.route(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`, route => route.abort('failed'));
      expect(await page.evaluate(() => _startTimer('Visible provisional facts'))).toBe(true);
      await expect(page.locator('#ordinary-provisional')).toContainText('Visible provisional facts');
      const actual = await page.evaluate(() => {
        const panel = document.getElementById('ordinary-provisional'), banner = document.getElementById('time-ack-status');
        const p = panel.getBoundingClientRect(), b = banner.getBoundingClientRect(), css = getComputedStyle(panel);
        // Unobscured means nothing paints above the panel. The stack lets taps through (pointer-events:none), so make it
        // hit-testable for this one measurement only.
        const stack = panel.parentElement, restore = [stack, panel].map(el => [el, el.style.pointerEvents]);
        stack.style.pointerEvents = panel.style.pointerEvents = 'auto';
        const hit = panel.contains(document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2));
        for (const [el, value] of restore) el.style.pointerEvents = value;
        return { separated: p.top >= b.bottom, inside: p.left >= 0 && p.right <= innerWidth && p.bottom <= innerHeight,
          background: css.backgroundColor, border: css.borderTopWidth, hit };
      });
      expect(actual).toMatchObject({ separated: true, inside: true, hit: true, border: '1px' });
      expect(actual.background).not.toBe('rgba(0, 0, 0, 0)');
      await info.attach(`provisional-${width}`, { body: await page.screenshot(), contentType: 'image/png' });
    });
  }
}
