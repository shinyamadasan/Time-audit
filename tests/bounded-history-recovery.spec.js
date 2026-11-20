// Bounded-history recovery: owner checklist (a) archive integrity (b) restoration (c) headroom (d) multi-device
// (f) failed archive leaves the original intact. Synthetic uid + loopback RTDB emulator only (harness from zz-owner-scale).
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
const OUT = process.env.OWNER_OUT || path.join(root, 'owner-scale.json');
let emulator, server, url;
const local = value => { const u = new URL(value); return ['127.0.0.1', 'localhost'].includes(u.hostname) && [String(emulator?.port), url && new URL(url).port].includes(u.port); };

test.use({ serviceWorkers: 'block' });
test.setTimeout(1_200_000);
test.describe.configure({ mode: 'serial' });
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
      localStorage.setItem('ta3-onboarded', '1'); localStorage.setItem('ta3-device-id', window.__deviceId || 'owner-scale-device');
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
    catch (e) { if (!/context was destroyed/.test(e.message)) throw e; await page.waitForTimeout(500); continue; }
    if (!q.length || q.every(([, phase]) => ['conflict', 'unknown'].includes(phase))) return q;
    await page.waitForTimeout(1000);
  }
  return 'timeout';
};


// ── Bounded-history recovery checks (owner checklist 2026-11-19) ────────────────────────────────────────────
const KEEP = Number(process.env.BH_KEEP || 10), PAIRS = Number(process.env.BH_PAIRS || 20);
const flagsInit = (deviceId, flags) => ({ deviceId, flags });
async function prepare(page, { deviceId, cut = true, keep = KEEP }) {
  await page.addInitScript(({ deviceId, cut, keep }) => {
    window.__deviceId = deviceId;
    if (localStorage.getItem('__flags-set')) return;
    localStorage.setItem('__flags-set', '1');
    if (cut) { localStorage.setItem('ta3-accounting-flag-history-cut', '1'); localStorage.setItem('ta3-accounting-history-keep-ops', String(keep)); }
  }, { deviceId, cut, keep });
}
const owner = uid => `uid_${uid}`;
const env = (page, uid) => page.evaluate(o => { const raw = localStorage.getItem(`ta3-accounting-state-v1:${o}`); return { raw, chars: raw.length, state: JSON.parse(raw) }; }, owner(uid));
const advance = (page, ms) => page.evaluate(ms => localStorage.setItem('__proof-now', String(Number(localStorage.getItem('__proof-now')) + ms)), ms);
// A second device whose compatibility caches went stale meets the app's existing 'legacy-source-needs-resolution'
// conflict (it happens with the cut OFF too). The user's answer there is Keep server; take it like a user would.
async function resolveStale(page) {
  for (let i = 0; i < 10; i++) {
    const head = await page.evaluate(async () => { try { await accountingCoordinator().drain(); } catch {} const q = accountingCoordinator().snapshot().queue[0]; return q ? [q.phase, q.reason] : null; });
    if (!head || head[0] !== 'conflict' || head[1] !== 'legacy-source-needs-resolution') { await settle(page); return; }
    console.log('KEEP-SERVER ' + (await page.evaluate(() => syncedDeviceId)));
    await page.evaluate(() => timeAckUserAction('keep-server'));
  }
}
async function pair(page, label) {
  await resolveStale(page);
  const ok = await page.evaluate(t => _startTimer(t), label);
  try { await page.waitForFunction(() => running, null, { timeout: 60_000 }); }
  catch (e) { console.log('START-STUCK ' + JSON.stringify(await page.evaluate(() => ({ toast: document.getElementById('toast')?.textContent, owner: timerOwnerDeviceId, me: syncedDeviceId,
    queue: accountingCoordinator().snapshot().queue.map(o => [o.input.name, o.phase, o.reason]), pending: accountingHasPending() })))); console.log('START-RESULT ' + ok); throw e; }
  await settle(page);
  await advance(page, 25 * MIN);
  await page.evaluate(() => { stopAndLog(); }); await page.waitForFunction(() => !running, null, { timeout: 120_000 }); await settle(page);
  await advance(page, 5 * MIN);
}
// Every history record this device has ever held, by id, exactly as stored (to prove archive + live == original).
async function observe(page, uid, seen) {
  const { state } = await env(page, uid);
  for (const op of state.history) if (!op.input?.compacted) seen.set(op.id, JSON.stringify(op));
  return state;
}
async function seedWorld(uid, n) {
  const world = await emulator.fresh(rules), entries = synthEntries(n);
  await world.seed(`rooms/uid_${uid}`, { entries: Object.fromEntries(entries.map(e => [`e_${e.id}`, e])),
    timer: { ownerRoom: `uid_${uid}`, running: false, stopped: true, intervalSecs: 1800, updatedAt: T0 - 60 * MIN }, breakState: { active: false } });
  return world;
}
async function device(browser, world, uid, opts) {
  const context = await browser.newContext(); await context.route('**/*', r => local(r.request().url()) ? r.continue() : r.abort());
  const page = await context.newPage(); await prepare(page, opts); await open(page, uid, world.name, null); await settle(page);
  return { context, page };
}
// Each simulated device has its own fake clock; real devices share wall time, so hand "now" over on every switch.
async function handOver(from, to) {
  const now = await from.evaluate(() => localStorage.getItem('__proof-now'));
  await to.evaluate(n => localStorage.setItem('__proof-now', n), now);
}
const archived = (page, uid) => page.evaluate(o => AccountingHistoryArchive.read(o), owner(uid));
const serverEntries = (page, uid) => page.evaluate(o => { const s = accountingCoordinator().snapshot(o); return s.committed.value.entries.map(e => e.id); }, owner(uid));

test('(a)(b)(c) archive integrity, restoration and headroom: archived + live history == every record ever held', async ({ browser }) => {
  test.setTimeout(900_000);
  const uid = 'bhrestore', world = await seedWorld(uid, Number(process.env.OWNER_E || 300));
  const { page } = await device(browser, world, uid, { deviceId: 'device-a' });
  const seen = new Map(); let maxHistory = 0; const sizes = [];
  for (let i = 0; i < PAIRS; i++) { await pair(page, `Restore ${i}`); const s = await observe(page, uid, seen); maxHistory = Math.max(maxHistory, s.history.length); sizes.push((await env(page, uid)).chars); }
  const { state } = await env(page, uid);
  const dropped = Object.keys(state.droppedIds || {});
  expect(dropped.length, 'the cut must actually drop records in this run').toBeGreaterThan(0);
  const arch = await archived(page, uid);
  const archById = new Map(arch.map(r => [r.id, JSON.stringify(r)]));
  // (a) integrity: every dropped id has an archived copy byte-equal to what the device held
  for (const id of dropped) { expect(archById.has(id), `archived copy of ${id}`).toBe(true); expect(archById.get(id)).toBe(seen.get(id)); }
  // (b) restoration: archive ∪ live reproduces every record ever held, exactly
  const live = new Map(state.history.map(op => [op.id, JSON.stringify(op)]));
  for (const [id, raw] of seen) expect(live.get(id) ?? archById.get(id), `restorable ${id}`).toBe(raw);
  // time entries are never part of the cut: every synthetic entry plus the new blocks are still committed
  const ids = await serverEntries(page, uid);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBe(Number(process.env.OWNER_E || 300) + PAIRS);
  // (c) headroom: live history stays bounded while operations keep coming
  console.log('BH-RESTORE ' + JSON.stringify({ pairs: PAIRS, keep: KEEP, dropped: dropped.length, archived: arch.length, liveHistory: state.history.length, maxHistory, envelopeChars: sizes }));
  // reload: the archive's verified set is rebuilt and the envelope still loads
  await page.reload(); await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4, null, { timeout: 180_000 });
  const reloaded = (await env(page, uid)).state;
  // A reload adds only its own hydrate refreshes (one or two, depending on when the confirmed refresh lands);
  // nothing is removed and no other record appears.
  const before = new Set(state.history.map(op => op.id));
  const added = reloaded.history.filter(op => !before.has(op.id));
  expect(added.map(op => op.input?.name).filter(name => name !== 'hydrate-accounting')).toEqual([]);
  expect(state.history.filter(op => !reloaded.history.some(r => r.id === op.id)).map(op => op.id)).toEqual([]);
  for (const op of reloaded.history) expect(Object.hasOwn(reloaded.droppedIds || {}, op.id), `dropped ${op.id} back after reload`).toBe(false);
  expect(Object.keys(reloaded.droppedIds || {}).length).toBe(dropped.length);
});

test('(f) a failing archive never drops or corrupts anything: the original history is fully intact', async ({ browser }) => {
  test.setTimeout(900_000);
  const uid = 'bhfail', world = await seedWorld(uid, Number(process.env.OWNER_E || 300));
  const context = await browser.newContext(); await context.route('**/*', r => local(r.request().url()) ? r.continue() : r.abort());
  const page = await context.newPage(); await prepare(page, { deviceId: 'device-f' });
  // Archive writes abort part-way through every transaction (after the first put): a mid-archive failure.
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put; const seen = new WeakMap();
    IDBObjectStore.prototype.put = function (...args) {
      const n = (seen.get(this.transaction) || 0) + 1; seen.set(this.transaction, n);
      const request = put.apply(this, args); if (n === 2) this.transaction.abort(); return request;
    };
  });
  await open(page, uid, world.name, null); await settle(page);
  const seen = new Map();
  for (let i = 0; i < PAIRS; i++) { await pair(page, `Fail ${i}`); await observe(page, uid, seen); }
  const { state } = await env(page, uid);
  expect(Object.keys(state.droppedIds || {}).length, 'nothing may be dropped without a verified archive copy').toBe(0);
  const live = new Map(state.history.map(op => [op.id, JSON.stringify(op)]));
  for (const [id, raw] of seen) expect(live.get(id), `original ${id} untouched`).toBe(raw);
  const ids = await serverEntries(page, uid);
  expect(ids.length).toBe(Number(process.env.OWNER_E || 300) + PAIRS);
  console.log('BH-FAIL ' + JSON.stringify({ pairs: PAIRS, liveHistory: state.history.length, observed: seen.size }));
});

test('(d) two devices: syncing from a device without the cut never reintroduces dropped history or duplicates time', async ({ browser }) => {
  test.setTimeout(1_800_000);
  const uid = 'bhtwo', world = await seedWorld(uid, Number(process.env.OWNER_E || 300));
  const a = await device(browser, world, uid, { deviceId: 'device-a', cut: process.env.BH_CONTROL !== '1' });
  const b = await device(browser, world, uid, { deviceId: 'device-b', cut: false });
  for (let i = 0; i < PAIRS; i++) {
    await pair(a.page, `A ${i}`);
    if (i % 4 === 3) { await handOver(a.page, b.page); await settle(b.page); await pair(b.page, `B ${i}`); await handOver(b.page, a.page); await settle(a.page); }
  }
  await settle(a.page); await settle(b.page);
  const before = (await env(a.page, uid)).state; const dropped = new Set(Object.keys(before.droppedIds || {}));
  if (process.env.BH_CONTROL !== '1') expect(dropped.size).toBeGreaterThan(0);
  // B keeps working with its full, never-cut history; A must take B's results without resurrecting what it dropped.
  await handOver(a.page, b.page);
  for (let i = 0; i < 3; i++) { await pair(b.page, `B late ${i}`); await settle(a.page); }
  await handOver(b.page, a.page);
  await a.page.reload(); await a.page.waitForFunction(() => window._accountingSourcesSeen?.size === 4, null, { timeout: 180_000 }); await settle(a.page);
  const after = (await env(a.page, uid)).state;
  for (const op of after.history) expect(dropped.has(op.id), `dropped ${op.id} came back`).toBe(false);
  for (const id of dropped) expect(Object.hasOwn(after.droppedIds, id), `still recorded as dropped ${id}`).toBe(true);
  const ea = await serverEntries(a.page, uid), eb = await serverEntries(b.page, uid);
  expect(new Set(ea).size).toBe(ea.length);
  expect([...ea].sort()).toEqual([...eb].sort()); // both devices agree on the time log
  const expected = Number(process.env.OWNER_E || 300) + PAIRS + Math.floor(PAIRS / 4) + 3;
  expect(ea.length).toBe(expected);
  await resolveStale(a.page);
  const q = await settle(a.page);
  expect(Array.isArray(q) ? q.filter(([, phase]) => phase === 'conflict') : q).toEqual([]);
  console.log('BH-TWO ' + JSON.stringify({ dropped: dropped.size, liveA: after.history.length, entries: ea.length }));
});
