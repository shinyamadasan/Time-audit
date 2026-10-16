// TASK-018 real-cloud browser acceptance of the approved Refined A UI against STAGING ONLY.
// Fresh Chromium profile per account, service workers blocked, no trace/video (they would capture credentials).
// Every request and websocket is recorded; any production marker or production static host is aborted and FAILS the run.
//   node staging/task-018/browser-acceptance.mjs --config STAGING_CONFIG.json --site <built site dir> --tls <dir with key.pem/cert.pem> --out <evidence dir>
// Env: STAGING_USER_{A,B,C}_EMAIL/_PASSWORD, STAGING_SEED_ACCESS_TOKEN (operator OAuth token, sent only to the staging RTDB host).
import { createServer } from 'node:https';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { assertStagingConfig, guardedFetch, PRODUCTION } from './guard.mjs';
import { verifyStagingFrontend } from './frontend.mjs';
import { syntheticRoom } from './harness.mjs';

const DAY = 86400000, RESOLUTIONS = 'taskCompletionResolutions', TIMEOUT = 20000;
const utcDate = ms => new Date(ms).toISOString().slice(0, 10);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg' };
class Fail extends Error {}

export async function runBrowserAcceptance({ config, site, tls, out, env = process.env }) {
  const { endpoint } = assertStagingConfig(config);
  const isolation = verifyStagingFrontend({ config, out: site }); // static proof + manifest re-check before serving
  const gfetch = guardedFetch(config), db = config.databaseURL.replace(/\/$/, '');
  const admin = () => ({ authorization: `Bearer ${env.STAGING_SEED_ACCESS_TOKEN}` });
  const rtdb = async (path, options = {}) => {
    const r = await gfetch(`${db}/${path}.json${options.method ? '' : '?format=export'}`, { ...options, headers: admin(), signal: AbortSignal.timeout(TIMEOUT) });
    if (r.status !== 200) throw new Fail(`staging RTDB ${options.method || 'GET'} ${r.status}`);
    return r.json();
  };
  const signInRest = async user => {
    const r = await gfetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT),
      body: JSON.stringify({ email: env[`STAGING_USER_${user}_EMAIL`], password: env[`STAGING_USER_${user}_PASSWORD`], returnSecureToken: true }) });
    if (r.status !== 200) throw new Fail(`sign-in ${user} ${r.status}`);
    return (await r.json()).localId;
  };

  mkdirSync(out, { recursive: true });
  const results = [], requests = [], blocked = [], shots = [];
  const check = (name, pass, details = {}) => { results.push({ name, pass: Boolean(pass), ...details }); if (!pass) throw new Fail(`CHECK_FAILED: ${name}`); };
  const productionMarker = url => PRODUCTION.dataPlaneMarkers.some(m => url.includes(m)) || PRODUCTION.staticHosts.some(h => new URL(url).hostname === h);

  const server = createServer({ key: readFileSync(join(tls, 'key.pem')), cert: readFileSync(join(tls, 'cert.pem')) }, (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'https://localhost').pathname)).replace(/^([/\\])+/, '');
    const file = resolve(site, path || 'index.html');
    if (!file.startsWith(resolve(site))) { res.writeHead(403).end(); return; }
    try {
      const target = statSync(file).isDirectory() ? join(file, 'index.html') : file;
      res.writeHead(200, { 'content-type': TYPES[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(target));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((ok, bad) => server.once('error', bad).listen(443, '127.0.0.1', ok));
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP localhost 127.0.0.1'] });
  const report = { at: new Date().toISOString(), projectId: config.projectId, siteFiles: isolation.files, pass: false, stoppedAt: null, results, shots, requests: null, blocked };
  const now = Date.now(), today = utcDate(now), yesterday = utcDate(now - DAY);
  let activePage = null; // for a diagnostic screenshot if the run stops

  async function openAccount(user, uid, viewport, label) {
    const context = await browser.newContext({ viewport, timezoneId: 'Etc/UTC', ignoreHTTPSErrors: true, serviceWorkers: 'block',
      ...(viewport.width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (productionMarker(url)) { blocked.push({ account: user, url: new URL(url).origin }); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    context.on('request', request => requests.push({ account: user, label, method: request.method(), origin: new URL(request.url()).origin, path: new URL(request.url()).pathname }));
    const page = await context.newPage(); activePage = page;
    page.on('websocket', ws => requests.push({ account: user, label, method: 'WS', origin: new URL(ws.url()).origin, path: new URL(ws.url()).pathname }));
    const room = `uid_${uid}`;
    await page.addInitScript(({ room }) => {
      if (sessionStorage.getItem('stg-seeded') === '1') return;
      sessionStorage.setItem('stg-seeded', '1'); sessionStorage.setItem('ta3-session-started', '1');
      localStorage.setItem('ta3-onboarded', '1');
      localStorage.setItem(`ta3-tz:${room}`, 'Etc/UTC');
      localStorage.setItem(`ta3-settings:${room}`, JSON.stringify({ timezone: 'Etc/UTC', hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10,
        presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    }, { room });
    await page.goto('https://localhost/');
    await page.waitForFunction(() => !!window.firebase?.auth && typeof window.PlanAuthority === 'object', null, { timeout: TIMEOUT });
    await page.evaluate(({ email, password }) => firebase.auth().signInWithEmailAndPassword(email, password).then(() => true),
      { email: env[`STAGING_USER_${user}_EMAIL`], password: env[`STAGING_USER_${user}_PASSWORD`] });
    await page.waitForFunction(room => globalThis.getChronaSenseRoomCode?.() === room, room, { timeout: TIMEOUT });
    return { context, page };
  }
  const recovery = page => page.locator('#unfinished-recovery-section');
  const row = (page, id) => recovery(page).locator(`[data-pc-stale="${id}"]`);
  const toast = page => page.locator('.pc-completion-toast');
  const more = (page, id) => row(page, id).getByRole('button', { name: /^More actions:/ });
  const shot = async (page, name, { scroll = name.startsWith('390-') } = {}) => {
    if (scroll) await recovery(page).evaluate(el => el.scrollIntoView({ block: 'start' })); // mobile: list is below the fold
    const file = join(out, `${name}.png`); await page.screenshot({ path: file, fullPage: false }); shots.push(`${name}.png`);
  };
  const ready = async (page, id) => page.waitForFunction(id => {
    const entry = globalThis.PlanAuthority?.rawStaleUnfinished().items.find(e => e.item.id === id);
    return entry && globalThis.TaskCompletions?.view(entry)?.state === 'unfinished';
  }, id, { timeout: TIMEOUT });
  const openUnfinished = async (page, count) => {
    const button = recovery(page).getByRole('button', { name: `Unfinished · ${count}` });
    await button.waitFor({ timeout: TIMEOUT });
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  };
  const records = async uid => Object.values((await rtdb(`rooms/uid_${uid}/${RESOLUTIONS}`)) || {});
  const recordFor = async (uid, itemId) => (await records(uid)).find(r => r.identity.itemId === itemId);
  const seedRoom = async (uid, tasks, label) => {
    const world = syntheticRoom({ nowMs: now, tasks, label });
    for (const plan of Object.values(world.room.calendarPlans)) plan.items = plan.items.map(item => ({ ...item, kind: 'task', doneAt: null }));
    await rtdb(`rooms/uid_${uid}`, { method: 'PUT', body: JSON.stringify(world.room) });
    return world.identities.map(identity => identity.itemId);
  };
  const tw = 'Synthetic staging task';

  try {
    const [A, B, C] = [await signInRest('A'), await signInRest('B'), await signInRest('C')];
    const label = `ui${now.toString(36)}`;
    const idsA = await seedRoom(A, 22, `${label}a`), idsB = await seedRoom(B, 2, `${label}b`), idsC = await seedRoom(C, 22, `${label}c`);

    // ---------- Desktop 1440, account A ----------
    let { context, page } = await openAccount('A', A, { width: 1440, height: 900 }, 'desktop');
    await openUnfinished(page, 22); await ready(page, idsA[0]);
    check('compact:five-row-preview', await recovery(page).locator('.pc-completion-row').count() === 5);
    const targets = await recovery(page).locator('.pc-complete-target,.pc-complete-title,.pc-complete-more')
      .evaluateAll(els => els.map(el => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })));
    check('compact:44px-targets', targets.length >= 15 && targets.every(b => b.w >= 44 && b.h >= 44), { min: Math.min(...targets.flatMap(b => [b.w, b.h])) });
    await shot(page, '1440-unfinished');

    await row(page, idsA[0]).getByRole('checkbox').click();
    await row(page, idsA[0]).waitFor({ state: 'detached', timeout: TIMEOUT });
    await toast(page).getByText('Completion saved').waitFor({ timeout: TIMEOUT });
    const today0 = await recordFor(A, idsA[0]);
    check('done-today:one-click-authoritative', today0?.state === 'completed' && today0.operations[today0.completionOpId].date === today);
    await shot(page, '1440-done-today');

    await toast(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await toast(page).getByText('Completion undone').waitFor({ timeout: TIMEOUT });
    await row(page, idsA[0]).waitFor({ timeout: TIMEOUT });
    const undone = await recordFor(A, idsA[0]);
    check('undo:conditional-confirmed', undone?.state === 'open' && undone.revision === 2);

    await more(page, idsA[1]).click(); await page.getByRole('menuitem', { name: 'Done earlier' }).click();
    await page.getByLabel('Actual completion date').fill(yesterday); await shot(page, '1440-done-earlier');
    await page.getByRole('button', { name: 'Save completion' }).click();
    await row(page, idsA[1]).waitFor({ state: 'detached', timeout: TIMEOUT });
    const earlier = await recordFor(A, idsA[1]);
    check('done-earlier:selected-date', earlier?.state === 'completed' && earlier.operations[earlier.completionOpId].date === yesterday);

    await page.reload(); await page.waitForFunction(room => globalThis.getChronaSenseRoomCode?.() === room, `uid_${A}`, { timeout: TIMEOUT });
    await openUnfinished(page, 21); await ready(page, idsA[0]);
    check('reload:confirmed-completion-survives', await row(page, idsA[1]).count() === 0 && await row(page, idsA[0]).count() === 1);

    await recovery(page).getByRole('button', { name: /View all/ }).click();
    const dialog = page.getByRole('dialog', { name: 'All unfinished tasks' });
    await dialog.locator('.pc-completion-row').first().waitFor({ timeout: TIMEOUT });
    check('backlog:view-all', await dialog.locator('.pc-completion-row').count() === 21);
    await page.getByRole('searchbox', { name: 'Search unfinished tasks' }).fill(`${tw} 7`);
    for (const started = Date.now(); await dialog.locator('.pc-completion-row').count() !== 1 && Date.now() - started < TIMEOUT;) await page.waitForTimeout(200);
    check('backlog:search', await dialog.locator(`[data-pc-stale="${idsA[7]}"]`).count() === 1);
    await shot(page, '1440-backlog-search');
    await dialog.getByRole('button', { name: 'Close backlog' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: TIMEOUT });

    // REJECTED: the REAL backend rejects a request whose source revision no longer matches.
    const visible = await recovery(page).locator(".pc-completion-row").evaluateAll(els => els.map(el => el.dataset.pcStale));
    const [rejId, unkId, offId] = visible.filter(id => id !== idsA[0]); // preview is title-sorted; act on rendered rows only
    await ready(page, rejId);
    await page.route(endpoint, async route => {
      const input = route.request().postDataJSON();
      if (input.kind !== 'mutate') return route.continue();
      input.request.expectedSourceRevision = 'A'.repeat(43);
      return route.continue({ postData: JSON.stringify(input) });
    });
    await row(page, rejId).getByRole('checkbox').click();
    await toast(page).getByText(/Not saved · STALE_SOURCE/).waitFor({ timeout: TIMEOUT });
    check('rejected:real-backend-refusal-shown', await row(page, rejId).count() === 1 && !(await recordFor(A, rejId)));
    await shot(page, '1440-rejected');
    await page.unroute(endpoint);

    // UNKNOWN: the server commits, the acknowledgement is lost; recovery confirms the SAME operation.
    await ready(page, unkId);
    await page.route(endpoint, async route => {
      if (route.request().postDataJSON().kind !== 'mutate') return route.continue();
      await route.fetch(); return route.abort('failed'); // real commit, response dropped
    });
    await row(page, unkId).getByRole('checkbox').click();
    await toast(page).getByText('Still checking completion').waitFor({ timeout: TIMEOUT });
    const pending = await page.evaluate(() => TaskCompletions.pendingAll());
    const committed = await recordFor(A, unkId);
    check('unknown:pending-kept-after-real-commit', pending.length === 1 && !!committed?.operations[pending[0].operationId]);
    await shot(page, '1440-unknown');
    await page.unroute(endpoint);
    await toast(page).getByRole('button', { name: 'Check status' }).click();
    await toast(page).getByText('Completion status recovered').waitFor({ timeout: TIMEOUT });
    const recovered = await recordFor(A, unkId);
    check('unknown:recovered-same-operation', recovered.completionOpId === pending[0].operationId && recovered.revision === 1
      && await page.evaluate(() => TaskCompletions.pendingAll().length) === 0);

    // BACKEND UNAVAILABLE: every endpoint call fails; nothing is completed or written.
    await ready(page, offId);
    await page.route(endpoint, route => route.abort('connectionrefused'));
    await row(page, offId).getByRole('checkbox').click();
    await toast(page).getByText(/Not saved|Still checking/).waitFor({ timeout: TIMEOUT });
    check('unavailable:no-completion', await row(page, offId).count() === 1 && !(await recordFor(A, offId)), { toast: await toast(page).innerText() });
    await shot(page, '1440-unavailable');
    await page.unroute(endpoint);

    // NEEDS-REVIEW: the released cf43080 client edits the plan; the completed task returns flagged, not silently.
    const plan = Object.values((await rtdb(`rooms/uid_${A}`)).calendarPlans)[0];
    const { releasedClientReplay } = await import('./old-client.mjs');
    const replay = await Promise.race([releasedClientReplay(config, { email: env.STAGING_USER_A_EMAIL, password: env.STAGING_USER_A_PASSWORD,
      uid: A, date: utcDate(now - 3 * DAY), targetId: `cal1:${utcDate(now - 3 * DAY)}` }), new Promise((_, no) => setTimeout(() => no(new Fail('OLD_CLIENT_TIMEOUT')), 60000))]);
    check('needs-review:released-client-pushed', replay.committed.every(Boolean) && plan.items.length === 22);
    const warning = row(page, idsA[1]).locator('.pc-completion-warning');
    await warning.waitFor({ timeout: TIMEOUT });
    check('needs-review:flagged-and-locked', /Changed or ambiguous/.test(await warning.innerText()) && await row(page, idsA[1]).getByRole('checkbox').isDisabled()
      && (await recordFor(A, idsA[1]))?.state === 'completed');
    await shot(page, '1440-needs-review');

    // ACCOUNT SWITCH: B sees only B's tasks; B's completion never touches A.
    const aRecords = JSON.stringify(await records(A));
    await page.evaluate(() => firebase.auth().signOut());
    await page.evaluate(({ email, password }) => firebase.auth().signInWithEmailAndPassword(email, password).then(() => true),
      { email: env.STAGING_USER_B_EMAIL, password: env.STAGING_USER_B_PASSWORD });
    await page.waitForFunction(room => globalThis.getChronaSenseRoomCode?.() === room, `uid_${B}`, { timeout: TIMEOUT });
    await openUnfinished(page, 2); await ready(page, idsB[0]);
    check('switch:no-a-data-visible', await recovery(page).locator('.pc-completion-row').count() === 2
      && await page.locator(idsA.map(id => `[data-pc-stale="${id}"]`).join(',')).count() === 0 && await toast(page).count() === 0);
    // FRESH-DEVICE observation: B never used this browser, so its in-app zone comes from defaults, not the account.
    const zone = () => page.evaluate(() => globalThis.getTaskCompletionAppContext?.()?.timezone);
    const zoneAtSwitch = await zone();
    for (const started = Date.now(); await zone() !== 'Etc/UTC' && Date.now() - started < 15000;) await page.waitForTimeout(500);
    const zoneAfterWait = await zone();
    await row(page, idsB[0]).getByRole('checkbox').click();
    const freshToast = toast(page).getByText(/Completion saved|Not saved/);
    await freshToast.waitFor({ timeout: TIMEOUT });
    const freshText = await freshToast.innerText(), freshRecord = await recordFor(B, idsB[0]);
    await shot(page, '1440-account-b-fresh-device');
    check('switch:fresh-device-outcome-safe', (freshText.includes('Completion saved') && freshRecord?.state === 'completed')
      || (/ACCOUNT_ZONE_CHANGED/.test(freshText) && !freshRecord), { zoneAtSwitch, zoneAfterWait, accountZone: 'Etc/UTC', toast: freshText });
    if (!freshRecord) {
      // RETURNING-DEVICE path: B's device-local settings match the account (as after any prior session on this device).
      await page.evaluate(() => firebase.auth().signOut());
      await page.evaluate(room => {
        localStorage.setItem(`ta3-tz:${room}`, 'Etc/UTC');
        localStorage.setItem(`ta3-settings:${room}`, JSON.stringify({ ...JSON.parse(localStorage.getItem(`ta3-settings:${room}`) || '{}'), timezone: 'Etc/UTC' }));
      }, `uid_${B}`);
      await page.evaluate(({ email, password }) => firebase.auth().signInWithEmailAndPassword(email, password).then(() => true),
        { email: env.STAGING_USER_B_EMAIL, password: env.STAGING_USER_B_PASSWORD });
      await page.waitForFunction(room => globalThis.getChronaSenseRoomCode?.() === room, `uid_${B}`, { timeout: TIMEOUT });
      await openUnfinished(page, 2); await ready(page, idsB[0]);
      await row(page, idsB[0]).getByRole('checkbox').click();
      await toast(page).getByText('Completion saved').waitFor({ timeout: TIMEOUT });
    }
    check('switch:isolated-writes', (await recordFor(B, idsB[0]))?.state === 'completed' && JSON.stringify(await records(A)) === aRecords);
    await shot(page, '1440-account-b');
    await context.close();

    // ---------- Mobile 390, account C (fresh profile) ----------
    ({ context, page } = await openAccount('C', C, { width: 390, height: 844 }, 'mobile'));
    await openUnfinished(page, 22); await ready(page, idsC[0]);
    check('mobile:five-row-preview', await recovery(page).locator('.pc-completion-row').count() === 5);
    const mobileTargets = await recovery(page).locator('.pc-complete-target,.pc-complete-title,.pc-complete-more')
      .evaluateAll(els => els.map(el => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })));
    check('mobile:44px-targets', mobileTargets.every(b => b.w >= 44 && b.h >= 44), { min: Math.min(...mobileTargets.flatMap(b => [b.w, b.h])) });
    check('mobile:no-horizontal-scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await shot(page, '390-unfinished');
    await row(page, idsC[0]).getByRole('checkbox').tap();
    await toast(page).getByText('Completion saved').waitFor({ timeout: TIMEOUT });
    check('mobile:done-today', (await recordFor(C, idsC[0]))?.state === 'completed');
    await shot(page, '390-done-today');
    await more(page, idsC[1]).tap(); await page.getByRole('menuitem', { name: 'Done earlier' }).tap(); await shot(page, '390-done-earlier');
    await page.keyboard.press('Escape');
    await recovery(page).getByRole('button', { name: /View all/ }).tap();
    await page.getByRole('dialog', { name: 'All unfinished tasks' }).locator('.pc-completion-row').first().waitFor({ timeout: TIMEOUT });
    await shot(page, '390-backlog');
    await context.close();

    // ---------- Isolation verdict ----------
    const origins = [...new Set(requests.map(r => r.origin))].sort();
    check('isolation:zero-production-requests', blocked.length === 0 && requests.every(r => !productionMarker(`${r.origin}${r.path}`)), { blocked: blocked.length, origins });
    report.pass = true;
  } catch (error) {
    report.stoppedAt = error instanceof Fail ? error.message : `ERROR: ${String(error?.message || error).split('\n')[0].slice(0, 300)}`;
    await activePage?.screenshot({ path: join(out, 'failure.png') }).then(() => shots.push('failure.png')).catch(() => {});
  } finally {
    await browser.close(); server.close();
    const byOrigin = {};
    for (const r of requests) byOrigin[r.origin] = (byOrigin[r.origin] || 0) + 1;
    report.requests = { total: requests.length, byOrigin };
    writeFileSync(join(out, 'browser-request-log.json'), JSON.stringify(requests, null, 1));
    writeFileSync(join(out, 'browser-acceptance.json'), JSON.stringify(report, null, 2));
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  const report = await runBrowserAcceptance({ config: JSON.parse(readFileSync(arg('--config'), 'utf8')), site: arg('--site'), tls: arg('--tls'), out: arg('--out') });
  const passed = report.results.filter(r => r.pass).length;
  console.log(report.pass ? `BROWSER ACCEPTANCE PASS (${passed}/${report.results.length}); blocked production requests: ${report.blocked.length}`
    : `BROWSER ACCEPTANCE FAIL: ${report.stoppedAt} after ${passed} passing checks; blocked: ${report.blocked.length}`);
  process.exitCode = report.pass ? 0 : 1;
}
