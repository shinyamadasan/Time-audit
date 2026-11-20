// PERF PROFILE on current code. Synthetic uid + loopback RTDB emulator only (harness from zz-owner-scale).
// Splits each interaction's main-thread time into (a) localStorage I/O + JSON for persistence, (b) accounting
// processing, (c) rendering (render script + style/layout), from a CPU profile plus Chrome's Performance metrics.
import { test } from '@playwright/test';
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


const ACCOUNTING = /accounting|Accounting|drain|commitProjection|reconcile|prepare|validateLocal|importCaptures|captureOrdinary|stageAccounting|canonical|digest/;
const RENDER = /^render|^refresh|^update[A-Z]|^paint|^draw|Render/;
function bucket(profile) {
  const byId = new Map(profile.nodes.map(n => [n.id, n])); const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const out = { storageIO: 0, persistJSON: 0, accounting: 0, renderScript: 0, otherScript: 0, idle: 0 };
  const top = {}; const callers = {}; const memo = new Map();
  const classify = id => {
    if (memo.has(id)) return memo.get(id);
    const f = byId.get(id).callFrame; let cat;
    if (f.functionName === '(idle)') cat = 'idle';
    else if (['(program)', '(garbage collector)'].includes(f.functionName)) cat = 'otherScript';
    else {
      const names = []; for (let x = id; x != null; x = parent.get(x)) names.push(byId.get(x).callFrame);
      const has = re => names.some(n => re.test(n.functionName));
      const fromAcc = names.some(n => /accounting-command\.js/.test(n.url));
      if (has(/^__ls(Set|Get)$/)) cat = 'storageIO';
      else if (has(/^__json(Stringify|Parse)$/) && names.some(n => /^(save|load|capture|captures|readStored)$/.test(n.functionName) && /accounting-command\.js/.test(n.url))) cat = 'persistJSON';
      else if (fromAcc || has(ACCOUNTING)) cat = 'accounting';
      else if (has(RENDER)) cat = 'renderScript';
      else cat = 'otherScript';
    }
    memo.set(id, cat); return cat;
  };
  profile.samples.forEach((id, i) => {
    const ms = (profile.timeDeltas[i] || 0) / 1000; const cat = classify(id); out[cat] += ms;
    if (cat !== 'idle') { // who called the expensive leaves: first 3 named app frames above JSON/resolve/tzHHMM
      const leaf = byId.get(id).callFrame.functionName;
      if (/^(__json|resolve$|tzHHMM$)/.test(leaf)) { const chain = []; for (let x = parent.get(id); x != null && chain.length < 4; x = parent.get(x)) { const c = byId.get(x).callFrame; if (c.functionName && !/^__json/.test(c.functionName)) chain.push(`${c.functionName}:${c.lineNumber + 1}`); }
        const k = `${leaf.replace(/^__json/, 'JSON.')} <- ${chain.join(' <- ')}`; callers[k] = (callers[k] || 0) + ms; }
    }
    if (cat !== 'idle') { const f = byId.get(id).callFrame; const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`; top[k] = (top[k] || 0) + ms; }
  });
  for (const k in out) out[k] = Math.round(out[k]);
  out.callers = Object.entries(callers).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${Math.round(v)}ms ${k}`);
  out.topSelf = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${Math.round(v)}ms ${k}`);
  return out;
}
const metrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

async function measure(page, cdp, label, action, uiReady) {
  await page.evaluate(() => Object.assign(window.__perf, { set: 0, get: 0, setChars: 0, json: 0 }));
  const m0 = await metrics(cdp); await cdp.send('Profiler.start');
  const t0 = Date.now(); await page.evaluate(action);
  await page.waitForFunction(uiReady, null, { timeout: 120_000 }); const ui = Date.now() - t0;
  const q = await settle(page); const total = Date.now() - t0;
  const { profile } = await cdp.send('Profiler.stop'); const m1 = await metrics(cdp);
  const perf = await page.evaluate(() => window.__perf);
  const sizes = await page.evaluate(() => {
    const ks = Object.keys(localStorage);
    return { envelopeChars: ks.filter(k => k.startsWith('ta3-accounting-state-v1')).reduce((s, k) => s + localStorage.getItem(k).length, 0),
      localStorageChars: ks.reduce((s, k) => s + k.length + localStorage.getItem(k).length, 0) };
  });
  const d = k => Math.round((m1[k] - m0[k]) * 1000);
  return { label, uiMs: ui, settledMs: total, queue: q, ...sizes,
    cdp: { script: d('ScriptDuration'), layout: d('LayoutDuration'), style: d('RecalcStyleDuration'), task: d('TaskDuration') },
    wrappers: { setItemMs: Math.round(perf.set), getItemMs: Math.round(perf.get), jsonMs: Math.round(perf.json), setChars: perf.setChars },
    profile: bucket(profile) };
}

test('perf profile: storage vs accounting vs rendering per interaction', async ({ browser }) => {
  const uid = 'perfowner', entries = synthEntries(E), report = { E, code: process.env.PERF_LABEL || 'unlabelled', checkpoints: [] };
  const world = await emulator.fresh(rules);
  await world.seed(`rooms/uid_${uid}`, { entries: Object.fromEntries(entries.map(e => [`e_${e.id}`, e])),
    timer: { ownerRoom: `uid_${uid}`, running: false, stopped: true, intervalSecs: 1800, updatedAt: T0 - 60 * MIN }, breakState: { active: false } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', r => local(r.request().url()) ? r.continue() : r.abort());
  const page = await context.newPage(); const cdp = await context.newCDPSession(page);
  page.on('crash', () => console.log('CRASH', new Date().toISOString())); page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('NAV', new Date().toISOString(), f.url()); });
  page.on('console', m => { if (/error|warn/.test(m.type())) console.log('CONSOLE', m.type(), m.text().slice(0, 200)); });
  await cdp.send('Performance.enable'); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 2000 });
  // PERF_FLAGS=history-cut,ref-first-hydrate,... and PERF_KEEP=N switch the existing local flags on before boot.
  await page.addInitScript(({ flags, keep }) => {
    if (localStorage.getItem('__flags-set')) return; localStorage.setItem('__flags-set', '1');
    for (const f of flags) localStorage.setItem(`ta3-accounting-flag-${f}`, '1');
    if (keep) localStorage.setItem('ta3-accounting-history-keep-ops', keep);
  }, { flags: (process.env.PERF_FLAGS || '').split(',').filter(Boolean), keep: process.env.PERF_KEEP || '' });
  const t = Date.now(); await open(page, uid, world.name, null); report.firstBootMs = Date.now() - t; report.firstBootQueue = await settle(page);
  let done = 0;
  const advance = ms => page.evaluate(ms => localStorage.setItem('__proof-now', String(Number(localStorage.getItem('__proof-now')) + ms)), ms);
  for (const target of CHECKPOINTS) {
    for (; done < target; done++) { console.log('GROW', done); // grow history like real use: one 30-minute tracked block per Start/Stop pair
      await page.evaluate(i => { _startTimer(`Grow ${i}`); }, done); await page.waitForFunction(() => running, null, { timeout: 600_000 }); await settle(page);
      await advance(25 * MIN); await page.evaluate(() => { stopAndLog(); }); await page.waitForFunction(() => !running, null, { timeout: 600_000 }); await settle(page); await advance(5 * MIN);
    }
    const cp = { opsBefore: done * 2, steps: [] };
    cp.steps.push(await measure(page, cdp, 'Start', () => { _startTimer('Measured task'); }, () => running));
    await advance(25 * MIN);
    cp.steps.push(await measure(page, cdp, 'Stop + log', () => { stopAndLog(); }, () => !running));
    await advance(5 * MIN);
    cp.steps.push(await measure(page, cdp, 'Navigate to Brain Dump', () => showView('braindump'), () => document.getElementById('view-braindump').classList.contains('active')));
    cp.steps.push(await measure(page, cdp, 'Navigate to My Day', () => showView('today'), () => document.body.classList.contains('view-today')));
    done++;
    report.checkpoints.push(cp);
    writeFileSync(OUT, JSON.stringify(report, null, 1));
    console.log('PERF ' + JSON.stringify({ ops: cp.opsBefore, steps: cp.steps.map(s => [s.label, s.uiMs, s.settledMs, s.envelopeChars, s.profile.storageIO, s.profile.persistJSON, s.profile.accounting, s.profile.renderScript, s.profile.otherScript, s.cdp.layout + s.cdp.style]) }));
  }
});
