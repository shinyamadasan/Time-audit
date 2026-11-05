// First start of the accounting release in a browser that ran the previous version (cutover 2026-11-05).
// The room is shaped as the previous version left it: unstamped entries, an inactive break state without
// ownerRoom, a scheduled block that version already auto-logged, and the device still holds its old caches.
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
const MIN = 60000, T0 = Date.parse('2026-10-28T16:00:00Z');   // 09:00 in America/Phoenix
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

const template = { id: 'dinner', activity: 'Dinner', energy: 'deep', startTime: '08:00', endTime: '08:30',
  days: [0, 1, 2, 3, 4, 5, 6], enabled: true, autoLog: true };
const oldEntries = [
  { id: 101, activity: 'Old work', energy: 'deep', date: '2026-10-28', ts: T0 - 90 * MIN, tsStart: T0 - 120 * MIN, updatedAt: T0 - 90 * MIN },
  // The previous version already auto-logged today's and yesterday's Dinner blocks.
  ...['2026-10-27', '2026-10-28'].map((date, i) => ({ id: `tpllog_dinner_${date}`, activity: 'Dinner', energy: 'deep', date,
    tsStart: T0 - (i ? 60 : 1500) * MIN, ts: T0 - (i ? 30 : 1470) * MIN, updatedAt: T0 - (i ? 30 : 1470) * MIN,
    blockIntervalMin: 30, onPlan: true, retro: false, autoLogged: true, scheduledAutoLog: true, templateId: 'dinner' })),
];
const previousRoom = uid => ({
  entries: Object.fromEntries(oldEntries.map(entry => [`e_${entry.id}`, entry])),
  timer: { ownerRoom: `uid_${uid}`, running: false, stopped: true, intervalSecs: 1800, updatedAt: T0 - 90 * MIN },
  breakState: { active: false },
});

async function open(page, world, uid, cached = oldEntries) {
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
  await page.addInitScript(({ T0, uid, template, oldEntries }) => {
    if (location.protocol !== 'http:') return;
    const RealDate = Date, now = () => Number(localStorage.getItem('__proof-now')) || T0;
    window.__setNow = ts => localStorage.setItem('__proof-now', String(ts));
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } };
    sessionStorage.setItem('ta3-session-started', '1');
    if (!localStorage.getItem('__proof-seeded')) {
      localStorage.setItem('__proof-seeded', '1'); localStorage.setItem('__proof-now', String(T0));
      localStorage.setItem('ta3-onboarded', '1'); localStorage.setItem('ta3-device-id', 'upgraded-device');
      localStorage.setItem(`ta3-settings:uid_${uid}`, JSON.stringify({ timezone: 'America/Phoenix', intervalMin: 30, sleepSetupDone: true, presets: [], templates: [template] }));
      localStorage.setItem(`ta3-tz:uid_${uid}`, 'America/Phoenix');
      // The previous version's device caches.
      localStorage.setItem(`ta3-entries:uid_${uid}`, JSON.stringify(oldEntries));
    }
  }, { T0, uid, template, oldEntries: cached });
  await page.goto(url);
  await page.waitForFunction(owner => globalThis.getChronaSenseRoomCode?.() === owner && _timeAckOnline?.online, `uid_${uid}`);
  await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4);
}
const queued = page => page.evaluate(() => accountingCoordinator().snapshot().queue.map(op => [op.input.name, op.phase, op.reason]));
const live = async (world, uid) => Object.values(await world.read(`rooms/uid_${uid}/entries`) || {}).filter(entry => !entry.deleted);

for (const uid of ['alice', 'bob']) {
  test(`${uid}: a browser upgraded from the previous version settles and can save time`, async ({ page }) => {
    const world = await emulator.fresh(rules);
    await world.seed(`rooms/uid_${uid}`, previousRoom(uid));
    await open(page, world, uid);
    await expect.poll(async () => { await page.evaluate(() => accountingCoordinator().drain()); return queued(page); },
      { timeout: 20_000 }).toEqual([]);
    await expect(page.locator('#time-ack-status')).toBeHidden();

    // The already-logged scheduled blocks stay single, and the old entry is kept.
    const before = await live(world, uid);
    expect(before.filter(entry => String(entry.id).startsWith('tpllog_dinner_')).length).toBe(2);
    expect(before.some(entry => entry.id === 101)).toBe(true);

    expect(await page.evaluate(() => _startTimer('Smoke'))).toBe(true);
    await expect.poll(() => queued(page), { timeout: 15_000 }).toEqual([]);
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    const saved = await page.evaluate(async () => { quickLogBusy = false; const result = await _doQuickSave('Smoke', 'deep');
      return [result, document.getElementById('toast')?.textContent || null, running, timerOwnerDeviceId === syncedDeviceId, timerStateOwnedByCurrentAccount()]; });
    expect(saved[0], JSON.stringify(saved)).toBe(true);
    await expect.poll(async () => (await live(world, uid)).filter(entry => entry.activity === 'Smoke').length, { timeout: 15_000 }).toBe(1);
    expect(await queued(page)).toEqual([]);
  });
}

for (const uid of ['alice', 'bob']) {
  test(`${uid}: an old cache holding a record the server lacks can be resolved with Keep server version`, async ({ page }) => {
    const world = await emulator.fresh(rules);
    await world.seed(`rooms/uid_${uid}`, previousRoom(uid));
    await open(page, world, uid, [...oldEntries, { id: 999, activity: 'Device only', energy: 'deep', date: '2026-10-28',
      ts: T0 - 200 * MIN, tsStart: T0 - 230 * MIN, updatedAt: T0 - 200 * MIN }]);
    const status = page.locator('#time-ack-status');
    await expect(status).toContainText('Legacy time needs recovery review', { timeout: 15_000 });
    await expect.poll(async () => (await queued(page))[0], { timeout: 15_000 }).toEqual(['legacy-accounting-caches', 'conflict', 'legacy-source-needs-resolution']);
    await page.waitForTimeout(1000);
    const keep = status.getByRole('button', { name: 'Keep server version', exact: true });
    await keep.click();
    await status.getByRole('button', { name: 'Confirm keep server', exact: true }).click();
    await expect.poll(async () => { await page.evaluate(() => accountingCoordinator().drain()); return queued(page); },
      { timeout: 20_000 }).toEqual([]);
    expect((await live(world, uid)).some(entry => entry.id === 999)).toBe(false);
    expect(await page.evaluate(() => _startTimer('Smoke'))).toBe(true);
    await expect.poll(() => queued(page), { timeout: 15_000 }).toEqual([]);
  });

  test(`${uid}: a planning conflict clears once the server data is repaired`, async ({ page }) => {
    const world = await emulator.fresh(rules);
    const room = previousRoom(uid);
    // The extension's older `<id>` copy disagrees with the app's `e_<id>` copy (production 2026-11-05).
    room.entries['101'] = { ...oldEntries[0], energy: 'light', updatedAt: T0 - 300 * MIN };
    await world.seed(`rooms/uid_${uid}`, room);
    await open(page, world, uid);
    await expect.poll(async () => { await page.evaluate(() => accountingCoordinator().drain()); return (await queued(page)).map(op => op[2]); },
      { timeout: 15_000 }).toContain('physical-source-unresolved');
    await world.seed(`rooms/uid_${uid}/entries/101`, oldEntries[0]);
    await expect.poll(async () => { await page.evaluate(() => accountingCoordinator().drain()); return queued(page); },
      { timeout: 20_000 }).toEqual([]);
  });
}

test('a cached running session that is not the server session is never settled away', async ({ page }) => {
  const uid = 'alice', world = await emulator.fresh(rules);
  await world.seed(`rooms/uid_${uid}`, previousRoom(uid));
  await page.addInitScript(({ uid, T0 }) => {
    if (localStorage.getItem('__proof-timer')) return;
    localStorage.setItem('__proof-timer', '1');
    localStorage.setItem(`ta3-timer:uid_${uid}`, JSON.stringify({ running: true, taskStartTime: T0 - 20 * 60000,
      blockStartTime: T0 - 20 * 60000, timerStartedAt: T0 - 20 * 60000, currentTask: 'Unlogged', ownerDeviceId: 'upgraded-device' }));
  }, { uid, T0 });
  await open(page, world, uid);
  await expect.poll(async () => { await page.evaluate(() => accountingCoordinator().drain()); return (await queued(page))[0]?.[0]; },
    { timeout: 15_000 }).toBe('legacy-accounting-caches');
  await page.waitForTimeout(2000);
  expect((await queued(page))[0]).toEqual(['legacy-accounting-caches', 'conflict', 'legacy-source-needs-resolution']);
});

test('conflicts stored by the first release are planned again and drain', async ({ page }) => {
  const uid = 'alice', world = await emulator.fresh(rules);
  await world.seed(`rooms/uid_${uid}`, previousRoom(uid));
  await open(page, world, uid);
  await expect.poll(async () => { await page.evaluate(() => accountingCoordinator().drain()); return queued(page); }, { timeout: 20_000 }).toEqual([]);
  // Store the held queue the first release left on the owner's device, without the new flag.
  await page.evaluate(owner => {
    const key = `ta3-accounting-state-v1:${owner}`, state = JSON.parse(localStorage.getItem(key));
    const like = name => state.history.find(op => op.input.name === name);
    const held = (name, reason, n) => { const { proposal, appliedGeneration, authority, settledWrites, evidence, replannable, ...op } = like(name);
      return { ...op, id: `held-${n}-${op.id}`.slice(0, 90), phase: 'conflict', reason }; };
    state.queue = [held('scheduled-log', 'scheduled-source-changed', 1), held('hydrate-accounting', 'account-state-owner-unproven', 2)];
    localStorage.setItem(key, JSON.stringify(state));
  }, `uid_${uid}`);
  await page.reload();
  await page.waitForFunction(owner => globalThis.getChronaSenseRoomCode?.() === owner && _timeAckOnline?.online, `uid_${uid}`);
  await expect.poll(async () => { await page.evaluate(() => accountingCoordinator().drain()); return queued(page); }, { timeout: 20_000 }).toEqual([]);
  expect(await page.evaluate(() => _startTimer('Smoke'))).toBe(true);
  await expect.poll(() => queued(page), { timeout: 15_000 }).toEqual([]);
});
