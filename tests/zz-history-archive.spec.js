// Storage-growth C: the verified IndexedDB archive in real Chromium (synthetic records only, no account, no network).
// Only ids whose archived copy reads back equal may be dropped; with no IndexedDB, nothing is ever droppable.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeClosure } from '../scripts/runtime-mirror.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Set([...computeClosure({ rootDir: root }).files, 'sw.js']);
let server, url;
test.use({ serviceWorkers: 'block' });
test.beforeAll(async () => {
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
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });
test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => new URL(route.request().url()).host === new URL(url).host ? route.continue() : route.abort());
});

const records = owner => [1, 2, 3].map(n => ({ v: 1, owner, uid: owner.slice(4), id: `arch-op-${String(n).padStart(4, '0')}`,
  phase: 'local-applied', input: { name: 'start-timer', n }, settledWrites: { timer: { n } }, proposal: { local: { blob: 'x'.repeat(5000) } } }));

test('store -> read back equal -> verified; survives reload via warm(); owners are isolated', async ({ page }) => {
  await page.goto(url);
  await page.waitForFunction(() => typeof AccountingHistoryArchive === 'object');
  const owner = 'uid_synthA';
  const verified = await page.evaluate(async ([owner, recs]) => {
    await AccountingHistoryArchive.store(owner, recs);
    return [...(AccountingHistoryArchive.verified(owner) || [])].sort();
  }, [owner, records(owner)]);
  expect(verified).toEqual(['arch-op-0001', 'arch-op-0002', 'arch-op-0003']);
  expect(await page.evaluate(() => AccountingHistoryArchive.verified('uid_other'))).toBeNull();
  await page.reload();
  await page.waitForFunction(() => typeof AccountingHistoryArchive === 'object');
  expect(await page.evaluate(() => AccountingHistoryArchive.verified('uid_synthA'))).toBeNull(); // memory only until warmed
  const warmed = await page.evaluate(async owner => { await AccountingHistoryArchive.warm(owner); return [...AccountingHistoryArchive.verified(owner)].sort(); }, owner);
  expect(warmed).toEqual(['arch-op-0001', 'arch-op-0002', 'arch-op-0003']);
  const stored = await page.evaluate(() => new Promise(resolve => {
    const open = indexedDB.open('chronasense-accounting-archive', 1);
    open.onsuccess = () => { const get = open.result.transaction('history').objectStore('history').get('uid_synthA\u0000arch-op-0002'); get.onsuccess = () => resolve(get.result.record); };
  }));
  expect(stored).toEqual(records(owner)[1]);
});

test('a read-back mismatch is never verified', async ({ page }) => {
  await page.goto(url);
  await page.waitForFunction(() => typeof AccountingHistoryArchive === 'object');
  const verified = await page.evaluate(async recs => {
    const put = IDBObjectStore.prototype.put; // simulate storage corrupting the copy as it is written
    IDBObjectStore.prototype.put = function (row, ...rest) { return put.call(this, { ...row, record: { ...row.record, phase: 'corrupted' } }, ...rest); };
    try { await AccountingHistoryArchive.store('uid_synthB', recs); } finally { IDBObjectStore.prototype.put = put; }
    return AccountingHistoryArchive.verified('uid_synthB')?.size ?? 0;
  }, records('uid_synthB'));
  expect(verified).toBe(0);
});

test('without IndexedDB nothing becomes droppable and nothing throws', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true }); });
  await page.goto(url);
  await page.waitForFunction(() => typeof AccountingHistoryArchive === 'object');
  const verified = await page.evaluate(async recs => { await AccountingHistoryArchive.store('uid_synthC', recs); return AccountingHistoryArchive.verified('uid_synthC'); }, records('uid_synthC'));
  expect(verified).toBeNull();
});
