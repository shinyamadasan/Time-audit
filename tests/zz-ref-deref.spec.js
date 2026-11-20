// QA test 0 (Jomar, 2026-11-11): measure accounting envelope growth per committed op.
// Synthetic uids only, loopback RTDB emulator only. Scratch file — not part of the product.
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
const MIN = 60000, T0 = Date.parse('2026-10-28T16:00:00Z');
const OUT = process.env.TEST0_OUT;
let emulator, server, url;
const proofEndpoint = value => {
  const parsed = new URL(value);
  return ['127.0.0.1', 'localhost'].includes(parsed.hostname) && [String(emulator?.port), url && new URL(url).port].includes(parsed.port);
};

test.use({ serviceWorkers: 'block' });
test.setTimeout(600_000);
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

const ACTS = ['Deep work', 'Email', 'Meeting', 'Reading', 'Exercise', 'Cooking', 'Admin', 'Learning'];
function synthEntries(E) {
  const out = [];
  for (let i = 0; i < E; i++) {
    const end = T0 - (i + 2) * 35 * MIN;             // strictly in the past, non-overlapping
    const date = new Date(end - 7 * 3600000).toISOString().slice(0, 10);
    out.push({ id: 1000 + i, activity: ACTS[i % ACTS.length], energy: i % 3 ? 'deep' : 'shallow', date,
      tsStart: end - 30 * MIN, ts: end, updatedAt: end, blockIntervalMin: 30, onPlan: i % 2 === 0, retro: false });
  }
  return out;
}

async function open(page, world, uid, entries) {
  for (const name of ['app', 'database']) await page.route(`https://www.gstatic.com/firebasejs/10.12.2/firebase-${name}-compat.js`, route => route.fulfill({
    contentType: 'text/javascript', body: readFileSync(path.join(root, `node_modules/firebase/firebase-${name}-compat.js`), 'utf8') }));
  const config = { databaseURL: `${emulator.base}?ns=${world.name}`, projectId: 'demo-test0' };
  await page.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js', route => route.fulfill({ contentType: 'text/javascript', body: `(()=>{
    const app=firebase.initializeApp(${JSON.stringify(config)});firebase.initializeApp=()=>app;
    app.database().useEmulator('127.0.0.1',${emulator.port},{mockUserToken:${JSON.stringify(token(uid))}});
    app.database().INTERNAL.forceWebSockets();
    const user={uid:${JSON.stringify(uid)},displayName:'Synthetic',email:'synthetic@example.invalid',getIdToken:()=>Promise.resolve(${JSON.stringify(token(uid))})};
    firebase.auth=()=>({currentUser:user,onAuthStateChanged:fn=>{setTimeout(()=>fn(user),0);return()=>{};},signOut:async()=>{}});
    firebase.auth.GoogleAuthProvider=class{};firebase.auth.GoogleAuthProvider.credential=()=>({});
  })();` }));
  await page.addInitScript(({ T0, uid, entries, flags }) => {
    if (location.protocol !== 'http:') return;
    const RealDate = Date, now = () => Number(localStorage.getItem('__proof-now')) || T0;
    window.__setNow = ts => localStorage.setItem('__proof-now', String(ts));
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } };
    sessionStorage.setItem('ta3-session-started', '1');
    // Count every hydrate-accounting captured to intake (unique op ids) so elision = captured - recorded.
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (this === window.localStorage && String(k).startsWith('ta3-accounting-capture-v1:') && String(v).includes('"hydrate-accounting"'))
        (window.__hydCaptured ||= new Set()).add(String(k).split(':').pop()); if (this === window.localStorage && String(k).startsWith('ta3-accounting-capture-v1:') && String(v).includes('"hydrate-accounting"')) window.__hydSlotMax = Math.max(window.__hydSlotMax || 0, String(v).length);
      return realSet.call(this, k, v);
    };
    if (!localStorage.getItem('__proof-seeded')) {
      localStorage.setItem('__proof-seeded', '1'); localStorage.setItem('__proof-now', String(T0));
      if (flags) { localStorage.setItem('ta3-accounting-flag-strip-first-hydrate', '1'); localStorage.setItem('ta3-accounting-flag-elide-noop-hydrate', '1'); if (flags === 'ref') localStorage.setItem('ta3-accounting-flag-ref-first-hydrate', '1'); }
      localStorage.setItem('ta3-onboarded', '1'); localStorage.setItem('ta3-device-id', 'test0-device');
      localStorage.setItem(`ta3-settings:uid_${uid}`, JSON.stringify({ timezone: 'America/Phoenix', intervalMin: 30, sleepSetupDone: true, presets: [], templates: [] }));
      localStorage.setItem(`ta3-tz:uid_${uid}`, 'America/Phoenix');
      if (entries) localStorage.setItem(`ta3-entries:uid_${uid}`, JSON.stringify(entries));
    }
  }, { T0, uid, entries, flags: world.flags });
  await page.goto(url);
  await page.waitForFunction(owner => globalThis.getChronaSenseRoomCode?.() === owner && _timeAckOnline?.online, `uid_${uid}`, { timeout: 120_000 });
  await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4, null, { timeout: 120_000 });
}

const queued = page => page.evaluate(() => accountingCoordinator().snapshot().queue.map(op => [op.input.name, op.phase, op.reason]));
const settle = page => expect.poll(async () => { await page.evaluate(() => accountingCoordinator().drain()); return queued(page); },
  { timeout: 240_000, intervals: [250, 500, 1000] }).toEqual([]);

const envelope = (page, uid) => page.evaluate(owner => JSON.parse(localStorage.getItem(`ta3-accounting-state-v1:${owner}`)), `uid_${uid}`);

// New device: no legacy caches, E entries only on the server, so the first hydrate prepares with no
// committed projection and must dereference its references (physicalEntries is the large field).
for (const E of [1000, 3000]) {
  test(`A1b deref: new device E=${E}, ref on == ref off, slot small`, async ({ browser }) => {
    const out = {};
    for (const mode of ['ref', true]) {
      const page = await browser.newPage();
      await page.context().route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
      const uid = `deref_${mode === 'ref' ? 'on' : 'off'}_e${E}`, entries = synthEntries(E);
      const world = await emulator.fresh(rules); world.flags = mode;
      await world.seed(`rooms/uid_${uid}`, { entries: Object.fromEntries(entries.map(e => [`e_${e.id}`, e])),
        timer: { ownerRoom: `uid_${uid}`, running: false, stopped: true, intervalSecs: 1800, updatedAt: T0 - 60 * MIN }, breakState: { active: false } });
      await open(page, world, uid, null);
      await settle(page);
      const env = await envelope(page, uid);
      out[mode] = { env, slotMax: await page.evaluate(() => window.__hydSlotMax || 0),
        intake: await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ta3-accounting-capture-v1:')).length),
        status: await page.evaluate(() => { const s = document.getElementById('time-ack-status'); return s && !s.hidden ? s.textContent.trim() : null; }) };
      await page.close();
    }
    const on = out.ref, off = out[true];
    console.log('DEREF ' + JSON.stringify({ E, slotOn: on.slotMax, slotOff: off.slotMax, envOn: JSON.stringify(on.env).length, envOff: JSON.stringify(off.env).length,
      histOn: on.env.history.map(h => [h.input.name, h.phase, h.authority]), statusOn: on.status }));
    expect(on.intake).toBe(0);
    expect(on.env.queue).toEqual([]);
    expect(on.env.history.map(h => [h.input.name, h.phase])).toEqual([['hydrate-accounting', 'local-applied']]);
    expect(on.env.committed.value.entries.length).toBe(E);
    // The projection is the same with references as with full copies (uid differs only in owner fields).
    const norm = env => JSON.parse(JSON.stringify(env.committed.value).replaceAll(/deref_(on|off)_/g, 'deref_'));
    expect(norm(on.env)).toEqual(norm(off.env));
    expect(on.slotMax).toBeLessThan(off.slotMax / 20);
  });
}

test('A1b deref: a referenced value that changed since capture is refused, never guessed', async ({ page }) => {
  const uid = 'deref_unit', world = await emulator.fresh(rules); world.flags = 'ref';
  await world.seed(`rooms/uid_${uid}`, { timer: { ownerRoom: `uid_${uid}`, running: false, stopped: true, intervalSecs: 1800, updatedAt: T0 - 60 * MIN } });
  await open(page, world, uid, null);
  const r = await page.evaluate(() => {
    const big = Array.from({ length: 50 }, (_, i) => ({ id: i, activity: 'x'.repeat(40) }));
    const ref = hydrateRef(big), small = hydrateRef([{ id: 1 }]), raw = 'y'.repeat(5000), rawRef = hydrateRef(raw);
    const threw = fn => { try { fn(); return false; } catch { return true; } };
    return { isRef: ref.$hydrateRef === 1 && !JSON.stringify(ref).includes('xxxx'), smallInline: !small.$hydrateRef,
      same: hydrateDeref(ref, JSON.parse(JSON.stringify(big))) !== undefined,
      reordered: threw(() => hydrateDeref(ref, [...big].reverse())),
      edited: threw(() => hydrateDeref(ref, big.map((e, i) => i === 7 ? { ...e, activity: 'z' } : e))),
      shrunk: threw(() => hydrateDeref(ref, [])), missing: threw(() => hydrateDeref(ref, null)),
      rawSame: hydrateDeref(rawRef, 'y'.repeat(5000)) === raw, rawEdited: threw(() => hydrateDeref(rawRef, 'y'.repeat(4999) + 'z')),
      flagDefaultOff: (() => { localStorage.removeItem('ta3-accounting-flag-ref-first-hydrate'); return accountingCompactionFlags().refFirstHydrate === false; })() };
  });
  expect(r).toEqual({ isRef: true, smallInline: true, same: true, reordered: true, edited: true, shrunk: true, missing: true,
    rawSame: true, rawEdited: true, flagDefaultOff: true });
});
