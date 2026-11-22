// OVERNIGHT INTEGRATION at owner scale. Synthetic uid + loopback RTDB emulator only (harness from zz-perf-profile).
// Splits each interaction's main-thread time into (a) localStorage I/O + JSON for persistence, (b) accounting
// processing, (c) rendering (render script + style/layout), from a CPU profile plus Chrome's Performance metrics.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = readFileSync(path.join(root, 'firebase.rules.json'), 'utf8');
const allowed = new Set([...computeClosure({ rootDir: root }).files, 'sw.js']);
const MIN = 60000, T0 = Date.parse('2026-10-28T16:00:00Z'), E = Number(process.env.OWNER_E || 2489);
const OUT = process.env.PERF_OUT || path.join(root, 'perf-profile.json');
const CHECKPOINTS = (process.env.PERF_OPS || '0,40').split(',').map(Number);
let emulator, server, url;
const local = value => { const u = new URL(value); return ['127.0.0.1', 'localhost'].includes(u.hostname) && [String(emulator?.port), url && new URL(url).port].includes(u.port); };

test.use({ serviceWorkers: 'block' });
test.setTimeout(1_200_000);
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

const ACTS = ['Deep work', 'Email', 'Meeting', 'Reading', 'Exercise', 'Cooking', 'Admin', 'Learning'];
// ~676 chars/entry in committed (owner: 1,683,893 / 2,489) -> pad the activity text.
const synthEntries = n => Array.from({ length: n }, (_, i) => {
  const end = T0 - (i + 2) * 35 * MIN;
  return { id: 1000 + i, activity: `${ACTS[i % ACTS.length]} ${'s'.repeat(380)}`, energy: i % 3 ? 'deep' : 'shallow',
    date: new Date(end - 7 * 3600000).toISOString().slice(0, 10), tsStart: end - 30 * MIN, ts: end, updatedAt: end,
    blockIntervalMin: 30, onPlan: i % 2 === 0, retro: false };
});

async function open(page, uid, ns, seedLocal) {
  for (const name of ['app', 'database']) await page.route(`https://www.gstatic.com/firebasejs/10.12.2/firebase-${name}-compat.js`, route => route.fulfill({
    contentType: 'text/javascript', body: readFileSync(path.join(root, `node_modules/firebase/firebase-${name}-compat.js`), 'utf8') }));
  const config = { databaseURL: `${emulator.base}?ns=${ns}`, projectId: 'demo-owner-scale' };
  await page.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js', route => route.fulfill({ contentType: 'text/javascript', body: `(()=>{
    const app=firebase.initializeApp(${JSON.stringify(config)});firebase.initializeApp=()=>app;
    app.database().useEmulator('127.0.0.1',${emulator.port},{mockUserToken:${JSON.stringify(token(uid))}});
    app.database().INTERNAL.forceWebSockets();
    const user={uid:${JSON.stringify(uid)},displayName:'Synthetic',email:'synthetic@example.invalid',getIdToken:()=>Promise.resolve(${JSON.stringify(token(uid))})};
    firebase.auth=()=>({currentUser:user,onAuthStateChanged:fn=>{setTimeout(()=>fn(user),0);return()=>{};},signOut:async()=>{}});
    firebase.auth.GoogleAuthProvider=class{};firebase.auth.GoogleAuthProvider.credential=()=>({});
  })();` }));
  await page.addInitScript(({ T0, uid, seedLocal }) => {
    if (location.protocol !== 'http:') return;
    const RealDate = Date, now = () => Number(localStorage.getItem('__proof-now')) || T0;
    window.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now()])); } static now() { return now(); } };
    sessionStorage.setItem('ta3-session-started', '1');
    const P = performance, S = Storage.prototype, rs = S.setItem, rg = S.getItem, js = JSON.stringify, jp = JSON.parse;
    const acc = window.__perf = { set: 0, get: 0, setChars: 0, json: 0, depth: 0 };
    S.setItem = function __lsSet(k, v) { const t = P.now(); try { return rs.call(this, k, v); } finally { acc.set += P.now() - t; acc.setChars += String(v).length; } };
    S.getItem = function __lsGet(k) { const t = P.now(); try { return rg.call(this, k); } finally { acc.get += P.now() - t; } };
    JSON.stringify = function __jsonStringify(...a) { if (acc.depth++) { try { return js(...a); } finally { acc.depth--; } } const t = P.now(); try { return js(...a); } finally { acc.depth--; acc.json += P.now() - t; } };
    JSON.parse = function __jsonParse(...a) { if (acc.depth++) { try { return jp(...a); } finally { acc.depth--; } } const t = P.now(); try { return jp(...a); } finally { acc.depth--; acc.json += P.now() - t; } };
    // Log every write: key family, new length, previous length, outcome.
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (this !== window.localStorage || String(k).startsWith('__')) return realSet.call(this, k, v);
      const prev = this.getItem(k), rec = { key: String(k).replace(/uid_[A-Za-z0-9_]+/, 'uid_X').replace(/:[A-Za-z0-9_-]{12,}$/, ':<id>'),
        len: String(v).length, prev: prev == null ? null : prev.length, ok: true };
      try { return realSet.call(this, k, v); } catch (e) { rec.ok = false; rec.err = e.name; throw e; }
      finally { const log = JSON.parse(sessionStorage.getItem('__writes') || '[]'); log.push(rec); sessionStorage.setItem('__writes', JSON.stringify(log.slice(-400))); }
    };
    if (!localStorage.getItem('__proof-seeded')) {
      localStorage.setItem('__proof-seeded', '1'); localStorage.setItem('__proof-now', String(T0));
      localStorage.setItem('ta3-onboarded', '1'); localStorage.setItem('ta3-device-id', 'owner-scale-device');
      localStorage.setItem(`ta3-settings:uid_${uid}`, JSON.stringify({ timezone: 'America/Phoenix', intervalMin: 30, sleepSetupDone: true, presets: [], templates: [] }));
      localStorage.setItem(`ta3-tz:uid_${uid}`, 'America/Phoenix');
      if (seedLocal) localStorage.setItem(`ta3-entries:uid_${uid}`, seedLocal);
    }
  }, { T0, uid, seedLocal });
  await page.goto(url);
  await page.waitForFunction(owner => globalThis.getChronaSenseRoomCode?.() === owner && _timeAckOnline?.online, `uid_${uid}`, { timeout: 180_000 });
  await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4, null, { timeout: 180_000 });
}

const settle = async page => {
  for (let i = 0; i < 120; i++) {
    let q;
    try { q = await page.evaluate(async () => { try { await accountingCoordinator().drain(); } catch {} return accountingCoordinator().snapshot().queue.map(o => [o.input.name, o.phase, o.reason]); }); }
    catch (e) { if (!/context was destroyed/.test(e.message)) throw e; console.log('CTXLOST', new Date().toISOString()); await page.waitForTimeout(500); continue; }
    if (!q.length || q.every(([, phase]) => ['conflict', 'unknown'].includes(phase))) return q;
    await page.waitForTimeout(1000);
  }
  return 'timeout';
};

// ── Overnight 2026-11-22: cross-feature integration at owner scale (E2489, established device, ~92% full). ──
// INTEG_STUCK=1 adds the owner's stuck 1.7M legacy slot (state between the release and F1); default = after F1.
const STUCK = process.env.INTEG_STUCK === '1';
const advance = (page, ms) => page.evaluate(ms => localStorage.setItem('__proof-now', String(Number(localStorage.getItem('__proof-now')) + ms)), ms);
const dump = page => page.evaluate(() => { const c = accountingCoordinator(), s = c.snapshot();
  return { toast: document.getElementById('toast')?.textContent, running, queue: s.queue.map(o => [o.input?.name, o.phase, o.reason]), history: s.history.length,
    captures: c.captures(roomCode).map(i => [i.captured.input?.name, i.captured.phase, JSON.stringify(i.captured).length]), stuck: c.stuckCaptures?.().length,
    legacyErr: String(window._accountingLegacyLoadError || ''), failedWrites: JSON.parse(sessionStorage.getItem('__writes') || '[]').filter(w => !w.ok).slice(-6),
    histSizes: s.history.map(h => [h.input?.name, h.phase, JSON.stringify(h).length]), committedChars: JSON.stringify(s.committed || null).length, ls: Object.keys(localStorage).reduce((t, k) => t + k.length + localStorage.getItem(k).length, 0),
    big: Object.keys(localStorage).map(k => [k.replace(/uid_\w+/, 'uid_X').slice(0, 50), localStorage.getItem(k).length]).sort((a, b) => b[1] - a[1]).slice(0, 8) }; }).catch(e => String(e));
let PAGE;
const timed = async (log, label, fn, page = PAGE) => { const t = Date.now(); try { const r = await fn(); log.push([label, Date.now() - t]); return r; }
  catch (e) { console.log('STUCK ' + label + ' ' + JSON.stringify(page ? await dump(page) : null)); throw e; } };
// Accounting truth: committed entries (local) vs server entries, by id and by content; no duplicate ids.
async function truth(page, world, uid) {
  const local = await page.evaluate(owner => { const e = JSON.parse(localStorage.getItem(`ta3-accounting-state-v1:${owner}`));
    return { committed: e.committed.value.entries, live: entries.map(x => x.id), running, focus: isFocusSessionRunning(), queue: e.queue.map(q => [q.input.name, q.phase, q.reason]) }; }, `uid_${uid}`);
  const server = Object.values(await world.read(`rooms/uid_${uid}/entries`) || {});
  const ids = a => a.map(e => String(e.id)), dup = a => a.length - new Set(a).size;
  const sById = new Map(server.map(e => [String(e.id), e]));
  return { committed: local.committed.length, live: local.live.length, server: server.length,
    dupCommitted: dup(ids(local.committed)), dupLive: dup(local.live.map(String)), dupServer: dup(ids(server)),
    onlyLocal: ids(local.committed).filter(id => !sById.has(id)).length,
    onlyServer: ids(server).filter(id => !local.committed.some(e => String(e.id) === id)).length,
    liveVsCommitted: local.live.length - local.committed.length, running: local.running, focus: local.focus, queue: local.queue };
}

test(`integration at owner scale (${STUCK ? 'stuck slot present' : 'after F1'}): Focus, My Day, Start/Stop, plan, navigation, sync together`, async ({ browser }) => {
  const uid = 'integowner', report = { E, STUCK, timings: [], checks: [], errors: [] };
  const world = await emulator.fresh(rules), base = synthEntries(E);
  await world.seed(`rooms/uid_${uid}`, { entries: Object.fromEntries(base.map(e => [`e_${e.id}`, e])),
    timer: { ownerRoom: `uid_${uid}`, running: false, stopped: true, intervalSecs: 1800, updatedAt: T0 - 60 * MIN }, breakState: { active: false } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', r => local(r.request().url()) ? r.continue() : r.abort());
  const page = await context.newPage(); PAGE = page;
  page.on('pageerror', e => report.errors.push('pageerror ' + e.message.slice(0, 200)));
  page.on('console', m => { if (/\[accounting\]/.test(m.text())) console.log('APPWARN ' + m.text().slice(0, 300)); if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) report.errors.push('console ' + m.text().slice(0, 200)); });
  const toasts = new Set(); await page.exposeFunction('__toast', t => toasts.add(t.slice(0, 120)));
  await page.addInitScript(() => { new MutationObserver(() => { const t = document.getElementById('toast'); if (t?.textContent) window.__toast(t.textContent); })
    .observe(document, { subtree: true, childList: true, characterData: true }); });
  const FLAGS = (process.env.INTEG_FLAGS ?? 'history-cut,ref-first-hydrate').split(',').filter(Boolean);
  await page.addInitScript(({ flags }) => { if (localStorage.getItem('__flags-set')) return; localStorage.setItem('__flags-set', '1');
    for (const f of flags) localStorage.setItem(`ta3-accounting-flag-${f}`, '1'); if (flags.length) localStorage.setItem('ta3-accounting-history-keep-ops', '50'); }, { flags: FLAGS });
  report.flags = FLAGS;
  await open(page, uid, world.name, null); await settle(page);
  if (STUCK) await page.evaluate(() => accountingCoordinator().capture({ name: 'legacy-accounting-caches', attribution: 'unproven',
    source: { runtime: { name: 'owner-stall', requested: null, frame: captureAccountingFrame() } } }));
  const used = await page.evaluate(() => Object.keys(localStorage).reduce((t, k) => t + k.length + localStorage.getItem(k).length, 0));
  await page.evaluate(n => { if (n > 0) localStorage.setItem('zz-filler', 'f'.repeat(n)); }, Number(process.env.INTEG_FILL || 4_810_387) - used - 9);
  if (process.env.INTEG_FLAGS_OFF_AFTER_BOOT) { await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^ta3-accounting-(flag-|history-keep)/.test(k)) localStorage.removeItem(k); }); report.flagsOffAfterBoot = true; }
  console.log('PRE-RELOAD ' + JSON.stringify(await dump(page)));
  await page.evaluate(() => sessionStorage.setItem('__writes', '[]'));
  await page.reload(); await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4, null, { timeout: 180_000 }); await settle(page);
  console.log('POST-RELOAD ' + JSON.stringify(await dump(page)));
  if (process.env.INTEG_PROBE) { console.log('RESTORE-ERR ' + await page.evaluate(() => { try { restoreUnifiedAccounting(); return 'no throw'; } catch (e) { return e.name + ': ' + e.message + ' | ' + String(e.stack).split(String.fromCharCode(10)).slice(0, 6).join(' <- '); } })); return; }
  const check = async (label, expect) => { await settle(page); const t = await truth(page, world, uid); report.checks.push({ label, ...t, expect });
    console.log('CHECK ' + JSON.stringify({ label, ...t })); return t; };
  let expected = E; await check('baseline', expected);

  // A. My Day: add a plan item, start it, open Focus while it runs (must be refused, timer untouched), navigate, Mark done.
  await page.evaluate(() => showView('today'));
  const planA = await page.evaluate(() => { document.getElementById('plan-task').value = 'Integration plan A'; addPlanItem();
    return planRawItemsFor(currentPlanTarget()).find(i => i.task === 'Integration plan A')?.id; });
  console.log('PLAN-A ' + JSON.stringify(planA) + ' ' + JSON.stringify(await dump(page)));
  await timed(report.timings, 'A start plan item', async () => { await page.evaluate(id => startPlanItem(id), planA); await page.waitForFunction(() => running, null, { timeout: 120_000 }); });
  await advance(page, 10 * MIN);
  const focusWhileRunning = await page.evaluate(async () => { await enterFocusMode(); document.getElementById('focus-task-input').value = 'Focus over timer';
    const r = await startPomodoro().catch(e => 'threw ' + e.message); return { r, focus: isFocusSessionRunning(), running }; });
  report.focusWhileRunning = focusWhileRunning;
  await page.evaluate(() => { document.getElementById('focus-overlay')?.classList.remove('open'); });
  await timed(report.timings, 'A nav braindump+today while running', async () => { await page.evaluate(() => { showView('braindump'); showView('today'); }); });
  await advance(page, 15 * MIN);
  await timed(report.timings, 'A Mark done (running)', async () => { await page.evaluate(id => togglePlanDone(id), planA);
    await page.waitForFunction(id => !running && planRawItemsFor(currentPlanTarget()).find(i => i.id === id)?.done === true, planA, { timeout: 120_000 }); });
  expected += 1; await check('A after Mark done', expected);

  // B. Focus from My Day: start a Focus session, Hide, navigate, a remote entry arrives mid-navigation, reopen, Exit.
  await advance(page, 5 * MIN);
  await timed(report.timings, 'B Focus start', async () => { await page.evaluate(async () => { await enterFocusMode(); document.getElementById('focus-task-input').value = 'Integration focus'; await startPomodoro(); });
    await page.waitForFunction(() => isFocusSessionRunning(), null, { timeout: 120_000 }); });
  await page.evaluate(() => hideFocusOverlay());
  const rid = 910001; const remote = { ...synthEntries(1)[0], id: rid, activity: 'Remote during focus', tsStart: T0 - 20000 * MIN, ts: T0 - 19970 * MIN, updatedAt: T0 };
  await world.seed(`rooms/uid_${uid}/entries/e_${rid}`, remote);
  await timed(report.timings, 'B nav x6 during sync', async () => { for (const v of ['braindump', 'today', 'braindump', 'today', 'braindump', 'today']) await page.evaluate(v => showView(v), v); });
  await timed(report.timings, 'B remote entry visible', () => page.waitForFunction(id => entries.some(e => e.id === id), rid, { timeout: 120_000 }));
  expected += 1;
  report.focusStillOpenHidden = await page.evaluate(() => ({ focus: isFocusSessionRunning(), overlayOpen: document.getElementById('focus-overlay').classList.contains('open') }));
  await advance(page, 25 * MIN);
  const exitB = await timed(report.timings, 'B Focus exit', () => page.evaluate(async () => { await enterFocusMode(); return confirmExitFocus(); }));
  await page.waitForFunction(() => !isFocusSessionRunning(), null, { timeout: 120_000 }).catch(() => {});
  report.focusExit = exitB; expected += 1; // a work-phase exit logs one focus entry
  await check('B after Focus exit', expected);

  // C. Timer running, reload mid-timer, plan view open, stop and log.
  await advance(page, 5 * MIN);
  await page.evaluate(() => _startTimer('Integration C')); await page.waitForFunction(() => running, null, { timeout: 120_000 }); await settle(page);
  await advance(page, 10 * MIN);
  await timed(report.timings, 'C reload while running', async () => { await page.reload(); await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4, null, { timeout: 180_000 }); });
  report.runningAfterReload = await page.evaluate(() => running);
  await advance(page, 15 * MIN);
  await timed(report.timings, 'C Stop+log', async () => { await page.evaluate(() => { showView('today'); stopAndLog(); }); await page.waitForFunction(() => !running, null, { timeout: 120_000 }); });
  expected += 1; await check('C after stop', expected);

  // D. Edge: Stop pressed twice quickly, then Start immediately (double-click / impatience under lag).
  await advance(page, 5 * MIN);
  await page.evaluate(() => _startTimer('Integration D')); await page.waitForFunction(() => running, null, { timeout: 120_000 });
  await advance(page, 20 * MIN);
  await timed(report.timings, 'D double stop + immediate start', async () => { await page.evaluate(() => { stopAndLog(); stopAndLog(); _startTimer('Integration D2'); });
    await page.waitForFunction(() => running, null, { timeout: 120_000 }).catch(() => {}); });
  await settle(page); report.dAfter = await page.evaluate(() => ({ running, lastTask: typeof timerTask !== 'undefined' ? timerTask : null }));
  await advance(page, 10 * MIN);
  await page.evaluate(() => stopAndLog()); await page.waitForFunction(() => !running, null, { timeout: 120_000 });
  expected += 2; await check('D after double stop + start + stop', expected);

  // E. Reload at the end: everything persisted, nothing duplicated.
  await page.reload(); await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4, null, { timeout: 180_000 });
  const final = await check('E after final reload', expected);
  report.toasts = [...toasts];
  writeFileSync(process.env.INTEG_OUT || path.join(root, `integration-${STUCK ? 'stuck' : 'clean'}.json`), JSON.stringify(report, null, 1));
  console.log('INTEG ' + JSON.stringify({ timings: report.timings, focusWhileRunning, focusExit: report.focusExit, focusHidden: report.focusStillOpenHidden,
    runningAfterReload: report.runningAfterReload, dAfter: report.dAfter, toasts: report.toasts, errors: report.errors.slice(0, 8) }));
  for (const c of report.checks) {
    expect.soft(c.dupCommitted + c.dupLive + c.dupServer, `${c.label} duplicates`).toBe(0);
    expect.soft(c.committed, `${c.label} committed count`).toBe(c.expect);
    expect.soft(c.server, `${c.label} server count`).toBe(c.expect);
    expect.soft(c.onlyLocal + c.onlyServer, `${c.label} local/server set`).toBe(0);
    expect.soft(c.liveVsCommitted, `${c.label} live vs committed`).toBe(0);
  }
  expect.soft(report.runningAfterReload, 'timer survives reload').toBe(true);
  expect.soft(final.running, 'no timer left running').toBe(false);
  expect.soft(report.errors, 'page errors').toEqual([]);
});

// Overnight bug 1 (confirmed 2026-11-22): at owner scale with storage full, the derived ta3-entries copy cannot be
// rewritten; restore's persist() threw QuotaExceeded and the account was marked 'accounting-recovery-unconfirmed', so
// every reload paused logging for good although the confirmed log was intact. Fresh device, flags OFF (as shipped).
test('storage full: a failed write of the derived entry copy never pauses logging after reload; confirmed log intact', async ({ browser }) => {
  const uid = 'quotacache', world = await emulator.fresh(rules), base = synthEntries(E);
  await world.seed(`rooms/uid_${uid}`, { entries: Object.fromEntries(base.map(e => [`e_${e.id}`, e])),
    timer: { ownerRoom: `uid_${uid}`, running: false, stopped: true, intervalSecs: 1800, updatedAt: T0 - 60 * MIN }, breakState: { active: false } });
  const context = await browser.newContext(); await context.route('**/*', r => local(r.request().url()) ? r.continue() : r.abort());
  const page = await context.newPage(); PAGE = page;
  await open(page, uid, world.name, null); await settle(page);
  const committedOf = () => page.evaluate(owner => JSON.stringify(JSON.parse(localStorage.getItem(`ta3-accounting-state-v1:${owner}`)).committed.value.entries), `uid_${uid}`);
  const before = await committedOf();
  await page.reload(); await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4, null, { timeout: 180_000 }); await settle(page);
  const after = await page.evaluate(() => ({ legacyErr: window._accountingLegacyLoadError || null, entries: entries.length }));
  console.log('QUOTACACHE ' + JSON.stringify({ ...after, dump: await dump(page) }).slice(0, 1200));
  expect(after.legacyErr).toBeNull();
  expect(after.entries).toBe(E);
  expect(await committedOf()).toBe(before);
  await page.evaluate(() => _startTimer('After full-storage reload'));
  await page.waitForFunction(() => running, null, { timeout: 120_000 });
  await advance(page, 20 * MIN); await page.evaluate(() => stopAndLog()); await page.waitForFunction(() => !running, null, { timeout: 120_000 }); await settle(page);
  const t = await truth(page, world, uid);
  expect([t.committed, t.server, t.onlyLocal + t.onlyServer, t.dupCommitted]).toEqual([E + 1, E + 1, 0, 0]);
});
