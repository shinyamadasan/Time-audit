// Owner-scale reproduction on PRODUCTION code (main 9fd8c91). Synthetic uid + loopback RTDB emulator only.
// Question: which write raises QuotaExceededError on ta3-accounting-state-v1 at ~91.8% usage, and what is in it.
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
const OUT = process.env.OWNER_OUT || path.join(root, 'owner-scale.json');
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
  return { id: 1000 + i, activity: ACTS[i % ACTS.length], energy: i % 3 ? 'deep' : 'shallow',
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
    const q = await page.evaluate(async () => { try { await accountingCoordinator().drain(); } catch {} return accountingCoordinator().snapshot().queue.map(o => [o.input.name, o.phase, o.reason]); });
    if (!q.length || q.every(([, phase]) => ['conflict', 'unknown'].includes(phase))) return q;
    await page.waitForTimeout(1000);
  }
  return 'timeout';
};

const inventory = (page, uid) => page.evaluate(owner => {
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(k => !k.startsWith('__'));
  const sizes = keys.map(k => [k.replace(owner, 'uid_X').replace(/:[A-Za-z0-9_-]{12,}$/, ':<id>'), k.length + localStorage.getItem(k).length]).sort((a, b) => b[1] - a[1]);
  const env = JSON.parse(localStorage.getItem(`ta3-accounting-state-v1:${owner}`) || 'null');
  const fieldSizes = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, JSON.stringify(v ?? null).length]));
  return { total: sizes.reduce((s, [, n]) => s + n, 0), sizes: sizes.slice(0, 12),
    envelope: env && { total: JSON.stringify(env).length, fields: fieldSizes(env),
      history: env.history.map(h => ({ name: h.input.name, phase: h.phase, chars: JSON.stringify(h).length, fields: fieldSizes(h),
        input: fieldSizes(h.input), source: fieldSizes(h.input.source) })),
      queue: env.queue.map(q => ({ name: q.input.name, phase: q.phase, reason: q.reason, chars: JSON.stringify(q).length, input: fieldSizes(q.input) })),
      entries: env.committed?.value?.entries?.length },
    writes: JSON.parse(sessionStorage.getItem('__writes') || '[]').filter(w => w.key.startsWith('ta3-accounting')) };
}, `uid_${uid}`);

const MODE = 'off'; // F2-only build: no slim mode
test(`owner stall shape (${MODE}): established device, 1.7M runtime-frame legacy slot, 91.8% full, reload`, async ({ browser }) => {
  const uid = 'ownerstall', entries = synthEntries(E), report = { E, mode: MODE, tree: root, steps: [] };
  const world = await emulator.fresh(rules);
  await world.seed(`rooms/uid_${uid}`, { entries: Object.fromEntries(entries.map(e => [`e_${e.id}`, e])),
    timer: { ownerRoom: `uid_${uid}`, running: false, stopped: true, intervalSecs: 1800, updatedAt: T0 - 60 * MIN }, breakState: { active: false } });
  const context = await browser.newContext(); await context.route('**/*', r => local(r.request().url()) ? r.continue() : r.abort());
  const page = await context.newPage();
  await open(page, uid, world.name, null);                       // new device: first boot settles (no legacy cache)
  report.steps.push({ step: 'established', queue: await settle(page), ...(await inventory(page, uid)) });
  { const st = report.steps.at(-1); console.log('ESTABLISHED ' + JSON.stringify({ total: st.total, sizes: st.sizes.slice(0, 5), env: st.envelope && { total: st.envelope.total, fields: st.envelope.fields, history: st.envelope.history.map(h => [h.name, h.phase, h.chars, h.fields]) } })); }
  if (process.env.STALL_PROBE) return;
  const before = await page.evaluate(owner => { const e = JSON.parse(localStorage.getItem(`ta3-accounting-state-v1:${owner}`));
    return { entries: e.committed.value.entries.length, digest: JSON.stringify(e.committed.value.entries) }; }, `uid_${uid}`);
  // the compatibility path's capture (runtime frame = every entry), written to its slot but not yet imported
  await page.evaluate(() => { accountingCoordinator().capture({ name: 'legacy-accounting-caches', attribution: 'unproven',
    source: { runtime: { name: 'owner-stall', requested: null, frame: captureAccountingFrame() } } }); });
  const used = (await inventory(page, uid)).total;
  await page.evaluate(n => { if (n > 0) localStorage.setItem('zz-filler', 'f'.repeat(n)); }, 4_810_387 - used - 9);
  await page.evaluate(() => sessionStorage.setItem('__writes', '[]'));
  const toasts = [];
  page.on('console', m => { if (/retained|storage is full|unconfirmed/i.test(m.text())) toasts.push(m.text().slice(0, 120)); });
  await page.reload(); await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4, null, { timeout: 180_000 });
  const q = await settle(page);
  // a NEW ordinary refresh after the stall must still go through
  const fresh = await page.evaluate(async () => { try { return await accountingCoordinator().submit({ name: 'hydrate-accounting', confirmedOnly: true }); } catch (e) { return { threw: e.name + ':' + e.message }; } });
  report.slimProbe = await page.evaluate(owner => {
    const slot = Object.keys(localStorage).find(k => k.startsWith('ta3-accounting-capture-v1:'));
    if (!slot || typeof accountingSlimLegacy !== 'function') return null;
    const cap = JSON.parse(localStorage.getItem(slot)), committed = JSON.parse(localStorage.getItem(`ta3-accounting-state-v1:${owner}`)).committed.value;
    const fe = cap.input.source.runtime.frame.entries || [];
    const ce = committed.entries;
    const byId = new Map(ce.map(e => [String(e.id), e]));
    const firstDiff = fe.find(e => JSON.stringify(e) !== JSON.stringify(byId.get(String(e.id))));
    const keysF = firstDiff ? Object.keys(firstDiff).sort().join(',') : null, keysC = firstDiff ? Object.keys(byId.get(String(firstDiff.id)) || {}).sort().join(',') : null;
    const same = firstDiff ? TimeAckCore.same(firstDiff, byId.get(String(firstDiff.id))) : null;
    const slimmed = accountingSlimLegacy(cap.input, committed);
    return { flag: accountingSlimEnabled(), frameEntries: fe.length, committedEntries: ce.length, identicalBytes: fe.filter(e => JSON.stringify(e) === JSON.stringify(byId.get(String(e.id)))).length,
      keysF, keysC, sameByValue: same, slimmed: slimmed !== cap.input, slimChars: JSON.stringify(slimmed).length };
  }, `uid_${uid}`);
  console.log('SLIMPROBE ' + JSON.stringify(report.slimProbe));
  const inv = await inventory(page, uid);
  const after = await page.evaluate(owner => { const e = JSON.parse(localStorage.getItem(`ta3-accounting-state-v1:${owner}`));
    return { entries: e.committed.value.entries.length, digest: JSON.stringify(e.committed.value.entries),
      slots: Object.keys(localStorage).filter(k => k.startsWith('ta3-accounting-capture-v1:')).map(k => [k.slice(-8), localStorage.getItem(k).length]),
      stuck: accountingCoordinator().stuckCaptures?.() || null }; }, `uid_${uid}`);
  for (const x of [before, after]) x.digest = require('node:crypto').createHash('sha256').update(x.digest, 'utf8').digest('hex');
  report.result = { queue: q, freshSubmit: fresh && (fresh.threw || { status: fresh.status, ownApplied: fresh.ownApplied }), before, after,
    quotaFailures: inv.writes.filter(w => !w.ok).length, total: inv.total, envelope: inv.envelope && { total: inv.envelope.total,
      history: inv.envelope.history.map(h => [h.name, h.phase, h.chars]) }, toasts: [...new Set(toasts)].slice(0, 5) };
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log('OWNERSTALL ' + JSON.stringify(report.result));
});
