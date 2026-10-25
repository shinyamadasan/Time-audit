import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-10-24T12:00:00Z');
const row = (id, extra = {}) => ({ id, ts: NOW, tsStart: NOW - 60_000, updatedAt: NOW,
  blockIntervalMin: 1, date: '2026-10-24', activity: 'Synthetic task', energy: 'deep',
  category: 'deep', originalLabel: 'deep', ...extra });
const A = [row(NOW, { blockIntervalMin: 0, tsStart: NOW - 5400 }),
  row('tpllog_fixture_2026-10-24', { blockIntervalMin: 600, tsStart: NOW - 600 * 60_000 })];
const B = [row(NOW + 1)];
let server;
let url;

// Entirely in-memory compat facade: source entry listener/persistence run in the real page.
function installFirebase() {
  if (window.firebase) return;
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const data = {};
  const callbacks = new Map();
  const retained = [];
  const writes = [];
  let authCallback;
  const get = p => p.split('/').filter(Boolean).reduce((n, k) => n?.[k], data);
  const put = (p, value) => {
    const keys = p.split('/').filter(Boolean);
    let n = data;
    for (const key of keys.slice(0, -1)) n = n[key] ||= {};
    n[keys.at(-1)] = clone(value);
  };
  for (const owner of ['A', 'B']) {
    const rows = JSON.parse(localStorage.getItem('ta3-entries:uid_' + owner) || '[]');
    put('rooms/uid_' + owner + '/entries', Object.fromEntries(rows.map(e => ['e_' + e.id, e])));
  }
  const snap = value => ({ val: () => clone(value), ref: { remove: () => Promise.resolve() } });
  const fire = p => {
    for (const cb of callbacks.get(p) || []) cb(snap(get(p)));
  };
  const fireUp = p => {
    let current = p;
    while (current) { fire(current); current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : ''; }
  };
  const ref = p => ({
    key: p.split('/').at(-1), child: child => ref(p + '/' + child),
    on(event, cb) {
      if (event !== 'value') return cb;
      if (!callbacks.has(p)) callbacks.set(p, new Set());
      callbacks.get(p).add(cb); retained.push({ path: p, cb });
      setTimeout(() => cb(snap(p === '.info/connected' ? true : get(p))), 0);
      return cb;
    },
    off() { callbacks.delete(p); },
    once() { return Promise.resolve(snap(get(p))); },
    update(changes) {
      for (const [key, value] of Object.entries(changes)) {
        const at = p + '/' + key; writes.push({ path: at, value: clone(value) }); put(at, value); fireUp(at);
      }
      return Promise.resolve();
    },
    set(value) { writes.push({ path: p, value: clone(value) }); put(p, value); fireUp(p); return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    transaction() { return Promise.resolve({ committed: false, snapshot: snap(get(p)) }); },
    onDisconnect() { return { remove() {}, set() {}, cancel() {} }; },
  });
  const user = uid => ({ uid, displayName: 'Synthetic user', email: 'fixture@example.invalid', photoURL: '' });
  const auth = () => ({ onAuthStateChanged(cb) { authCallback = cb; setTimeout(() => cb(user('A')), 0); },
    signOut() { authCallback(null); return Promise.resolve(); } });
  auth.GoogleAuthProvider = function () {};
  window.firebase = { apps: [], initializeApp() { const app = { options: {} }; this.apps.push(app); return app; },
    app() { return this.apps[0]; }, database: () => ({ ref }), auth };
  window.__entryValidation = {
    writes, emit(owner, rows) { put('rooms/uid_' + owner + '/entries', Object.fromEntries(rows.map(e => ['e_' + e.id, e]))); fire('rooms/uid_' + owner + '/entries'); },
    switchAccount(uid) { authCallback(user(uid)); },
    stale(owner, rows) { for (const item of retained.filter(item => item.path === 'rooms/uid_' + owner + '/entries')) item.cb(snap(Object.fromEntries(rows.map(e => ['e_' + e.id, e])))); },
  };
}

test.beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = path.resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = 'http://127.0.0.1:' + server.address().port + '/';
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

test('real account load/reload, remote replay and idle reconciliation preserve entries and keep genuine duration diagnostics', async ({ page }) => {
  const warnings = [];
  page.on('console', message => { if (message.type() === 'warning' && message.text().startsWith('[validateEntry]')) warnings.push(message.text()); });
  await page.clock.install({ time: NOW });
  await page.route('**/*', route => {
    const at = route.request().url();
    if (at.startsWith('https://www.gstatic.com/firebasejs/')) {
      return route.fulfill({ contentType: 'application/javascript', body: '(' + installFirebase.toString() + ')();' });
    }
    return at.startsWith('http://127.0.0.1:') ? route.continue() : route.abort();
  });
  await page.addInitScript(({ a, b }) => {
    if (localStorage.getItem('entry-validation-seeded')) return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('entry-validation-seeded', '1'); localStorage.setItem('ta3-onboarded', '1');
    localStorage.setItem('ta3-device-id', 'entry-fixture-device');
    for (const [owner, rows] of [['A', a], ['B', b]]) {
      localStorage.setItem('ta3-entries:uid_' + owner, JSON.stringify(rows));
      localStorage.setItem('ta3-tz:uid_' + owner, 'UTC');
      localStorage.setItem('ta3-settings:uid_' + owner, JSON.stringify({ timezone: 'UTC', templates: [], intervalMin: 30,
        sleepSetupDone: true, sleepTime: '23:00', wakeTime: '07:00', activityColors: {} }));
    }
  }, { a: A, b: B });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode?.() === 'uid_A');
  await page.clock.runFor(100);
  const rows = () => page.evaluate(() => JSON.parse(JSON.stringify(entries)));
  const writes = () => page.evaluate(() => window.__entryValidation.writes.filter(w => /\/entries\//.test(w.path)).length);
  expect(await rows()).toEqual(A);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('blockIntervalMin < 1');
  expect(warnings.some(w => w.includes('id invalid'))).toBe(false);
  const before = await writes();
  await page.evaluate(a => { for (let n = 0; n < 20; n++) window.__entryValidation.emit('A', a); }, A);
  await page.clock.fastForward(125_000);
  expect(warnings).toHaveLength(1);
  expect(await rows()).toEqual(A);
  expect(await writes()).toBe(before);
  await page.evaluate(() => window.__entryValidation.switchAccount('B'));
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode?.() === 'uid_B');
  await page.clock.runFor(100);
  await page.evaluate(a => window.__entryValidation.stale('A', a), A);
  expect(await rows()).toEqual(B);
  expect(warnings).toHaveLength(1);
  await page.evaluate(() => window.__entryValidation.switchAccount('A'));
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode?.() === 'uid_A');
  await page.clock.runFor(100);
  expect(await rows()).toEqual(A);
  expect(warnings).toHaveLength(2);
  warnings.length = 0;
  await page.reload();
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode?.() === 'uid_A');
  await page.clock.runFor(100);
  expect(await rows()).toEqual(A);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('blockIntervalMin < 1');
});
