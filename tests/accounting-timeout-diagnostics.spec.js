// Timeout-group diagnostics (investigation only): the real SDK reproduction of the two largest 120 s timeout groups.
// Integrated production coordinator, real SDK and loopback-only RTDB emulator, both synthetic accounts.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
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


import { addLesson, addPhase, addStep, createLearningPlan } from '../learning-plan-model.js';
import { LEARNING_PLAN_REPOSITORY_KEY, LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION } from '../learning-plan-repository.js';

const fixed = () => '2026-08-28T12:00:00.000Z';
const ids = (...list) => { let i = 0; return () => list[Math.min(i++, list.length - 1)]; };
function learningPlanRaw() {
  let plan = createLearningPlan({ title: 'Frontend fundamentals' }, { idGenerator: ids('plan-a'), clock: fixed });
  plan = addPhase(plan, { title: 'Phase A' }, { idGenerator: ids('phase-a'), clock: fixed });
  plan = addLesson(plan, 'phase-a', { title: 'Lesson A' }, { idGenerator: ids('lesson-a'), clock: fixed });
  plan = addStep(plan, 'lesson-a', { title: 'Step A' }, { idGenerator: ids('step-a'), clock: fixed });
  plan = addStep(plan, 'lesson-a', { title: 'Step B' }, { idGenerator: ids('step-b'), clock: fixed });
  return JSON.stringify({ schemaVersion: LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION, plans: [plan] });
}
// Which element would receive a real tap at the centre of `selector`, and is it inside the accounting status stack?
const tapTarget = (page, selector) => page.evaluate(selector => {
  const el = selector.startsWith('text:') ? [...document.querySelectorAll('button')].find(b => b.textContent.trim() === selector.slice(5) && b.offsetParent)
    : document.querySelector(selector);
  if (!el) return { missing: true };
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  const stack = document.getElementById('time-ack-status')?.parentElement;
  return { reachable: !!hit && (hit === el || el.contains(hit)), blockedByAccountingStatus: !!hit && !!stack && stack.contains(hit),
    hit: hit ? `${hit.tagName}#${hit.id || ''}.${String(hit.className || '').slice(0, 40)}` : null };
}, selector);

for (const uid of ['alice', 'bob']) {
  // Timeout group A: Learning Plan Focus outcome (Done / Continue) never appeared in the fake-room spec.
  test(`${uid}: real UI Learning Plan Focus shows the outcome and Done completes the step once`, async ({ page }) => {
    const world = await emulator.fresh(rules);
    await page.addInitScript(({ uid, raw, key }) => {
      if (!localStorage.getItem('__lp-seeded')) { localStorage.setItem('__lp-seeded', '1'); localStorage.setItem(`${key}:uid_${uid}`, raw); }
      HTMLMediaElement.prototype.play = () => Promise.resolve();
    }, { uid, raw: learningPlanRaw(), key: LEARNING_PLAN_REPOSITORY_KEY });
    await open(page, world, uid); await pinned(page);
    await page.evaluate(() => showView('learning'));
    await page.getByRole('button', { name: 'Start Focus: Step A' }).click();
    await expect.poll(() => page.evaluate(() => pomodoroPhase)).toBe('work');
    await page.evaluate(ts => window.__setNow(ts), T0 + 25 * MIN);
    expect(await retainedAccountingResult(page, 'focus-end-work')).toBe(true);
    const outcome = page.getByRole('region', { name: 'Focus outcome' });
    await expect(outcome).toBeVisible({ timeout: 10_000 });
    await outcome.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => page.evaluate(k => JSON.parse(localStorage.getItem(k)).plans[0].phases[0].lessons[0].steps.map(s => !!s.completed),
      `${LEARNING_PLAN_REPOSITORY_KEY}:uid_${uid}`)).toEqual([true, false]);
    await expect(page.locator('.learning-plan-next-title')).toHaveText('Step B');
    const focus = Object.values(await world.read(`rooms/uid_${uid}/entries`) || {}).filter(e => !e.deleted);
    expect(focus.map(e => ({ tsStart: e.tsStart, ts: e.ts, min: e.blockIntervalMin }))).toEqual([{ tsStart: T0, ts: T0 + 25 * MIN, min: 25 }]);
  });

  // Timeout group B: Review summaries were covered by the accounting status. Reproduce with a real unconfirmed state.
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    test(`${uid}: Review controls while accounting is genuinely unconfirmed (${viewport.width}x${viewport.height})`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      const world = await emulator.fresh(rules); await open(page, world, uid); await pinned(page);
      const pattern = value => proofEndpoint(value) && new URL(value).pathname.startsWith(`/rooms/uid_${uid}`);
      await page.route(pattern, route => route.abort('failed'));
      expect(await page.evaluate(() => _startTimer('Offline work'))).toBe(true);
      await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
      await page.evaluate(() => { quickLogBusy = false; return _doQuickSave('Offline work', 'deep'); });
      await page.evaluate(() => renderTimeAckStatus());
      const statusShown = await page.evaluate(() => [...document.getElementById('time-ack-status').parentElement.children].some(el => !el.hidden));
      await page.evaluate(() => openReview(toDateKey(new Date())));
      await expect(page.locator('#review-overlay')).toHaveClass(/open/);
      const result = { statusShown };
      for (const selector of ['#rv-full-analysis > summary', '#rv-optional-details > summary', 'text:Save reflection', 'text:Close'])
        result[selector] = await tapTarget(page, selector);
      await info.attach('review-tap-targets', { contentType: 'application/json', body: JSON.stringify(result, null, 2) });
      console.log('[review-tap]', uid, JSON.stringify(viewport), JSON.stringify(result));
      await page.screenshot({ path: info.outputPath('review-unconfirmed.png') });
      await page.evaluate(() => closeModal('review-overlay'));
      await page.evaluate(() => showView('today'));
      // Every visible control on Today whose centre a tap would deliver to the accounting status stack instead.
      const covered = await page.evaluate(() => {
        const stack = document.getElementById('time-ack-status').parentElement, out = [];
        for (const el of document.querySelectorAll('button, a, summary, input, select')) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || stack.contains(el)) continue;
          const hits = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          const under = hits.find(h => !stack.contains(h));
          // Covered only if the control would otherwise receive the tap.
          if (hits[0] && stack.contains(hits[0]) && under && (under === el || el.contains(under))) out.push((el.id ? '#' + el.id : el.tagName) + ' "' + (el.textContent || el.value || '').trim().slice(0, 24) + '"');
        }
        return out;
      });
      console.log('[today-covered]', uid, JSON.stringify(viewport), JSON.stringify(covered));
      await page.screenshot({ path: info.outputPath('today-unconfirmed.png') });
    });
  }

  // Timeout group E: a pre-accounting (legacy-shaped) cloud entry seeded before open never appeared in `entries`.
  test(`${uid}: a legacy-shaped cloud entry is visible after load`, async ({ page }, info) => {
    const world = await emulator.fresh(rules), at = T0 - 70 * MIN;
    await world.seed(`rooms/uid_${uid}/entries`, { [`e_${at}`]: { id: at, ts: at, tsStart: at - 5 * MIN, updatedAt: at,
      blockIntervalMin: 5, date: '2026-10-28', activity: 'Recent test', energy: 'deep', onPlan: true } });
    await open(page, world, uid); await pinned(page);
    const state = await page.evaluate(() => ({ visible: entries.filter(e => !e.deleted).map(e => e.activity),
      legacyError: window._accountingLegacyLoadError || null, pending: accountingHasPending(),
      phases: accountingCoordinator().snapshot().queue.map(op => [op.input.name, op.phase, op.reason || null]) }));
    console.log('[legacy-entry]', uid, JSON.stringify(state));
    await info.attach('legacy-entry', { contentType: 'application/json', body: JSON.stringify(state) });
    expect(state.visible).toContain('Recent test');
  });
}
