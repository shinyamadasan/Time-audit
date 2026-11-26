import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = readFileSync(path.join(root, 'firebase.rules.json'), 'utf8');
const allowed = new Set([...computeClosure({ rootDir: root }).files, 'sw.js']);
const T0 = Date.parse('2026-10-28T16:00:00Z');
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
  const config = { databaseURL: `${emulator.base}?ns=${world.name}`, projectId: 'demo-storage-durability' };
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
    const RealDate = Date;
    const now = () => Number(localStorage.getItem('__proof-now')) || T0;
    window.__setNow = ts => localStorage.setItem('__proof-now', String(ts));
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
async function installQuotaFault(page) {
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      const mode = this === localStorage && this.getItem('__quota-mode');
      if (mode === 'envelope' && key === AccountingCommand.BASE + ':' + roomCode
        || mode === 'intake' && key.startsWith(AccountingCommand.INTAKE + ':' + roomCode + ':')) {
        throw new DOMException('Injected full storage', 'QuotaExceededError');
      }
      return write.call(this, key, value);
    };
  });
}

const setFault = (page, mode) => page.evaluate(mode => localStorage.setItem('__quota-mode', mode), mode);
const beforeUnloadWarns = page => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

async function receipt(page, id) {
  return page.evaluate(id => accountingCoordinator().snapshot().history.filter(op => op.id === id), id);
}

test('a durable intake survives a failed import, creator reload and concurrent recovery', async ({ page, context }) => {
  const uid = 'quota_durable', world = await emulator.fresh(rules);
  await open(page, world, uid); await pinned(page);
  const peer = await context.newPage();
  await open(peer, world, uid); await pinned(peer);
  await installQuotaFault(page); await installQuotaFault(peer);
  await setFault(page, 'envelope');
  expect(await page.evaluate(() => _startTimer('Durable quota capture'))).toBe(true);
  const original = await page.evaluate(() => {
    const coordinator = accountingCoordinator();
    const { slot, captured } = coordinator.captures(roomCode).find(item => item.captured.input.name === 'start-timer');
    return { slot, captured, raw: localStorage.getItem(slot), failed: coordinator.failedCaptures(roomCode).length };
  });
  expect(original.failed).toBe(0);
  expect(await beforeUnloadWarns(page)).toBe(false);
  expect(await world.read('rooms/uid_' + uid + '/timer')).toBeNull();

  // Replace the originating page while the peer still simulates a full envelope.
  // The next page reads the exact intake bytes before releasing either tab to drain.
  await page.close();
  const restarted = await context.newPage();
  await restarted.addInitScript(slot => { window.__restartedRaw = localStorage.getItem(slot); }, original.slot);
  await open(restarted, world, uid);
  expect(await restarted.evaluate(() => window.__restartedRaw)).toBe(original.raw);
  await setFault(restarted, '');
  await Promise.all([pinned(restarted), pinned(peer)]);
  await expect.poll(() => receipt(restarted, original.captured.id)).toEqual([
    expect.objectContaining({ id: original.captured.id, input: original.captured.input, at: original.captured.at, phase: 'local-applied' })
  ]);
  expect(await peer.evaluate(slot => localStorage.getItem(slot), original.slot)).toBeNull();
  expect(await world.read('rooms/uid_' + uid + '/timer')).toMatchObject({
    running: true, _csWrite: { operationId: original.captured.id }
  });
});

test('failed capture shows the actual count and retries the exact facts without a second press', async ({ page, context }) => {
  test.setTimeout(75_000);
  const uid = 'quota_page', world = await emulator.fresh(rules);
  await open(page, world, uid); await pinned(page);
  const peer = await context.newPage();
  await open(peer, world, uid); await pinned(peer);
  await installQuotaFault(page);
  await setFault(page, 'intake');
  expect(await page.evaluate(() => _startTimer('Page-held quota capture'))).toBe(false);
  const original = await page.evaluate(async () => {
    const coordinator = accountingCoordinator();
    try { coordinator.capture({ name: 'hydrate-accounting', confirmedOnly: true }); }
    catch (error) { if (error.name !== 'QuotaExceededError') throw error; }
    await accountingOutcome(coordinator.drain());
    return coordinator.failedCaptures(roomCode).find(op => op.input.name === 'start-timer');
  });
  const status = page.locator('#time-ack-status');
  await expect(status).toContainText('2 accounting changes are held in this page');
  await expect(page.locator('#toast')).not.toContainText('kept safely');
  expect(await beforeUnloadWarns(page)).toBe(true);
  // A trusted click lets Chromium present its native unload confirmation.
  await page.mouse.click(4, 4);
  const confirmation = page.waitForEvent('dialog', { timeout: 5000 });
  await page.close({ runBeforeUnload: true });
  const dialog = await confirmation;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  expect(page.isClosed()).toBe(false);

  await peer.reload(); await pinned(peer);
  expect(await peer.evaluate(id => {
    const coordinator = accountingCoordinator();
    return [...coordinator.failedCaptures(roomCode), ...coordinator.captures(roomCode).map(item => item.captured),
      ...coordinator.snapshot().queue, ...coordinator.snapshot().history].some(op => op.id === id);
  }, original.id)).toBe(false);
  expect(await beforeUnloadWarns(peer)).toBe(false);
  expect(await world.read('rooms/uid_' + uid + '/timer')).toBeNull();

  await setFault(page, '');
  await expect.poll(() => receipt(peer, original.id), { timeout: 45_000 }).toEqual([
    expect.objectContaining({ id: original.id, input: original.input, at: original.at, phase: 'local-applied' })
  ]);
  await expect(status).toBeHidden();
  expect(await beforeUnloadWarns(page)).toBe(true); // now the confirmed running timer owns the warning
  await page.evaluate(() => { __setNow(Date.now() + 5 * 60000); return stopAndLog(); });
  await pinned(page);
  expect(await beforeUnloadWarns(page)).toBe(false);
  expect(await receipt(page, original.id)).toHaveLength(1);
});

test('automatic compaction preserves unfiled facts and requires an exact archive copy', async ({ page }) => {
  const uid = 'quota_archive', world = await emulator.fresh(rules);
  await open(page, world, uid); await pinned(page);
  const result = await page.evaluate(async () => {
    const owner = 'uid_cut_fixture', key = AccountingCommand.BASE + ':' + owner;
    const ctx = { owner, uid: 'cut_fixture', device: 'proof-device', generation: 1 };
    const record = (id, phase, input) => ({ v: 1, ...ctx, id, at: 1, phase, input, local: null, eventKey: null, dependsOn: null });
    const settled = Array.from({ length: 92 }, (_, i) => ({
      ...record('hydrate-' + String(i).padStart(3, '0'), 'local-applied', { name: 'hydrate-accounting', frame: { pad: 'p'.repeat(40_000) } }),
      authority: 'coherent-account-read'
    }));
    const legacy = record('unfiled-legacy', 'local-applied', { name: 'legacy-accounting-caches', source: { 'ta3-entries': 'original unfiled time' } });
    const open = { ...record('query-pending', 'awaiting-source', { name: 'native-usage', original: 'unacknowledged query' }), source: { outcomes: [] } };
    const commit = settled.at(-1);
    commit.appliedGeneration = 1;
    const entries = [{ id: 1, activity: 'Filed time' }];
    localStorage.setItem(key, JSON.stringify({ v: 1, owner, generation: 1,
      committed: { generation: 1, operationId: commit.id, value: { entries } },
      history: [...settled, legacy], queue: [], sources: [open] }));
    const initialChars = localStorage.getItem(key).length;
    let seq = 0, attempts = 0;
    const coordinator = AccountingCommand.createCoordinator({ storage: localStorage, lock: TimeAckCore.webLock,
      identity: () => ctx, randomId: () => 'fresh-00' + (++seq), same: TimeAckCore.same, compaction: accountingCompactionFlags(),
      transport: { enforcesAccounting: true, inspect: async () => ({}) },
      prepare: async () => ({ localOnly: true, projection: { entries } }),
      apply() {}
    });
    const advance = () => coordinator.submit({ name: 'hydrate-accounting', confirmedOnly: true });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { attempts++; throw Error('Archive write fault'); };
    try {
      await advance();
      // The readonly transaction queues behind any archive write for this origin.
      await AccountingHistoryArchive.read(owner);
      await advance();
      await AccountingHistoryArchive.read(owner);
    } finally { IDBObjectStore.prototype.put = put; }
    const afterFault = coordinator.snapshot(owner);
    await advance(); await AccountingHistoryArchive.read(owner); await advance();
    const final = coordinator.snapshot(owner), archived = await AccountingHistoryArchive.read(owner);
    const raw = localStorage.getItem(key);
    return {
      initialChars, finalChars: raw.length, attempts, faultDrops: Object.keys(afterFault.droppedIds || {}),
      filed: final.committed.value.entries, unfiled: final.history.find(op => op.id === legacy.id), legacy,
      sources: final.sources, open, dropped: Object.keys(final.droppedIds || {}),
      preserved: settled.every(op => [...final.history, ...archived].some(copy => copy.id === op.id && TimeAckCore.same(copy, op)))
    };
  });
  expect(result.attempts).toBeGreaterThan(0);
  expect(result.faultDrops).toEqual([]);
  expect(result.dropped.length).toBeGreaterThanOrEqual(25);
  expect(result.finalChars).toBeLessThan(result.initialChars);
  expect(result.preserved).toBe(true);
  expect(result.unfiled).toEqual(result.legacy);
  expect(result.sources).toEqual([result.open]);
  expect(result.filed).toEqual([{ id: 1, activity: 'Filed time' }]);
});
