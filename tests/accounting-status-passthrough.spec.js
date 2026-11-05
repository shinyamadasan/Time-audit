// The pending-sync status stack informs without blocking: taps pass through except on its own buttons.
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


// Real offline state: Start while every room request fails, so the pending-sync stack is shown.
async function unconfirmed(page, world, uid) {
  await open(page, world, uid); await pinned(page);
  const match = value => proofEndpoint(value) && new URL(value).pathname.startsWith(`/rooms/uid_${uid}`);
  const handler = route => route.abort('failed');
  await page.route(match, handler);
  expect(await page.evaluate(() => _startTimer('Offline work'))).toBe(true);
  await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
  await page.evaluate(() => renderTimeAckStatus());
  return () => page.unroute(match, handler);
}

for (const uid of ['alice', 'bob']) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    test(`${uid}: pending-sync panel stays readable while taps reach the controls beneath it (${viewport.width}x${viewport.height})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const world = await emulator.fresh(rules), online = await unconfirmed(page, world, uid);
      const status = page.locator('#time-ack-status');
      await expect(status).toBeVisible();
      await expect(status).toContainText('Accounting is unconfirmed');
      await expect(page.locator('#ordinary-provisional')).toBeVisible();
      await expect(page.locator('#ordinary-provisional')).toContainText('awaiting sync');

      // Today navigation: real actionability checks, including Playwright's hit-target test.
      await page.evaluate(() => showView('today'));
      for (const control of [page.locator('#timeline-nav-next'), page.locator('#main-btn')])
        if (await control.isVisible()) await control.click({ trial: true });

      // Review details and reflection controls: real clicks.
      await page.evaluate(() => openReview(toDateKey(new Date())));
      await expect(page.locator('#review-overlay')).toHaveClass(/open/);
      for (const id of ['rv-optional-details', 'rv-full-analysis']) {
        await page.locator(`#${id} > summary`).click();
        await expect(page.locator(`#${id}`)).toHaveJSProperty('open', true);
      }
      await page.locator('#review-overlay').getByRole('button', { name: 'Save reflection', exact: true }).click({ trial: true });
      await page.evaluate(() => closeModal('review-overlay'));

      // The panel's own button still receives the tap and resolves the retained time once the room is reachable.
      await online();
      const check = status.getByRole('button', { name: 'Check now', exact: true });
      await check.click();
      await expect(status).toBeHidden({ timeout: 15_000 });
      await expect.poll(async () => { const t = await world.read(`rooms/uid_${uid}/timer`); return t && [t.running, t.taskStartTime, t.lastTask]; },
        { timeout: 15_000 }).toEqual([true, T0, 'Offline work']);
      await expect(page.locator('#ordinary-provisional')).toBeHidden();
    });
  }

  test(`${uid}: Undo toast stays tappable above the pending-sync panel`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page);
    expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
    await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
    expect(await page.evaluate(() => { quickLogBusy = false; return _doQuickSave('Writing', 'deep'); })).toBe(true);
    await page.locator('#toast .toast-undo-btn').click({ trial: true });
  });
}
