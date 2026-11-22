// TAKEOVER: the original device must not be blocked after another device takes over and stops (Jomar S5).
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


const TE = Number(process.env.TAKEOVER_E || 300);
const deviceB = page => page.addInitScript(({ T0, uid }) => { // device B: same seed as open(), its own device id
  if (location.protocol !== 'http:' || localStorage.getItem('__proof-seeded')) return;
  localStorage.setItem('__proof-seeded', '1'); localStorage.setItem('__proof-now', String(T0));
  localStorage.setItem('ta3-onboarded', '1'); localStorage.setItem('ta3-device-id', 'takeover-device-B');
  localStorage.setItem(`ta3-settings:uid_${uid}`, JSON.stringify({ timezone: 'America/Phoenix', intervalMin: 30, sleepSetupDone: true, presets: [], templates: [] }));
  localStorage.setItem(`ta3-tz:uid_${uid}`, 'America/Phoenix');
}, { T0, uid: 'takeover' });
const state = page => page.evaluate(() => { const s = accountingCoordinator().snapshot();
  return { running, owner: timerOwnerDeviceId, legacyErr: window._accountingLegacyLoadError || null,
    queue: s.queue.map(o => [o.input.name, o.phase, o.reason, Object.keys(o.input.source || {}).filter(k => o.input.source[k] != null)]),
    timerCache: localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('ta3-timer:')) || '') }; });

test('takeover: after device B takes over and stops, device A is not blocked by its own timer cache', async ({ browser }) => {
  const uid = 'takeover', world = await emulator.fresh(rules), base = synthEntries(TE);
  await world.seed(`rooms/uid_${uid}`, { entries: Object.fromEntries(base.map(e => [`e_${e.id}`, e])),
    timer: { ownerRoom: `uid_${uid}`, running: false, stopped: true, intervalSecs: 1800, updatedAt: T0 - 60 * MIN }, breakState: { active: false } });
  const ctx = async () => { const c = await browser.newContext(); await c.route('**/*', r => local(r.request().url()) ? r.continue() : r.abort()); return c; };
  const A = await (await ctx()).newPage(); PAGE = A;
  await open(A, uid, world.name, null); await settle(A);
  await A.evaluate(() => _startTimer('Started on A')); await A.waitForFunction(() => running, null, { timeout: 120_000 }); await settle(A);
  const B = await (await ctx()).newPage(); await deviceB(B);
  await open(B, uid, world.name, null); await settle(B);
  await B.waitForFunction(() => running && timerOwnerDeviceId && timerOwnerDeviceId !== syncedDeviceId, null, { timeout: 120_000 });
  for (const p of [A, B]) await advance(p, 10 * MIN);
  await B.evaluate(() => takeOverActiveTimer()); await B.waitForFunction(() => running && timerOwnerDeviceId === syncedDeviceId, null, { timeout: 120_000 }); await settle(B);
  await A.waitForFunction(() => running && timerOwnerDeviceId !== syncedDeviceId, null, { timeout: 120_000 }); await settle(A);
  const aAfterTakeover = await state(A);
  for (const p of [A, B]) await advance(p, 15 * MIN);
  await B.evaluate(() => stopAndLog()); await B.waitForFunction(() => !running, null, { timeout: 120_000 }); await settle(B);
  await A.waitForFunction(() => !running, null, { timeout: 120_000 }); await settle(A);
  const aAfterStop = await state(A);
  const startOnA = await A.evaluate(async () => { const r = await _startTimer('A again'); return { r, running }; });
  console.log('TAKEOVER ' + JSON.stringify({ aAfterTakeover, aAfterStop, startOnA }));
  expect(aAfterStop.queue.filter(([name]) => name === 'legacy-accounting-caches')).toEqual([]);
  expect(aAfterStop.legacyErr).toBeNull();
  expect(startOnA.running).toBe(true);
  await settle(A); await advance(A, 10 * MIN); await A.evaluate(() => stopAndLog()); await A.waitForFunction(() => !running, null, { timeout: 120_000 }); await settle(A);
  const t = await truth(A, world, uid); console.log('TRUTH ' + JSON.stringify(t));
  expect([t.committed, t.server, t.onlyLocal + t.onlyServer, t.dupCommitted]).toEqual([TE + 2, TE + 2, 0, 0]);
});
