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

// TASK-050 (Decision 47): the automatic archive takes every settled kind and keeps what page readers still walk.
test('automatic archive takes every settled kind but keeps chains, the timer write chain, aliases and cache witnesses', async ({ page }) => {
  const uid = 'archive_kinds', world = await emulator.fresh(rules);
  await open(page, world, uid); await pinned(page);
  const result = await page.evaluate(async () => {
    const owner = 'uid_kinds_fixture', key = AccountingCommand.BASE + ':' + owner;
    const ctx = { owner, uid: 'kinds_fixture', device: 'proof-device', generation: 1 };
    const record = (id, input, extra = {}) => ({ v: 1, ...ctx, id, at: 1, phase: 'local-applied', input, local: null,
      eventKey: null, dependsOn: null, ...extra });
    const small = 'k'.repeat(10_000);
    const kinds = ['ping', 'automatic-log', 'scheduled-log', 'save-entry', 'retro-edit', 'retro-log', 'delete-entry', 'quick-save',
      'focus-start', 'focus-end-work', 'focus-end-break', 'focus-exit', 'focus-learning-finish', 'start-break', 'break-end',
      'start-away', 'end-away', 'undo', 'recovery', 'sleep-log', 'switch-task', 'takeover-timer', 'native-usage',
      'activity-cleanup', 'clear-selected-entries', 'common-log', 'stop-and-log', 'reset-timer'];
    const settledKinds = kinds.map((name, i) => record('kind-' + String(i).padStart(3, '0'), { name, pad: small },
      name.endsWith('-log') || name === 'ping' ? { eventKey: name + ':fixture:' + i } : {}));
    settledKinds.push(record('kind-ordinary-start', { name: 'start-timer', ordinary: { v: 1, kind: 'start' }, pad: small }));
    settledKinds.push(record('kind-coalesced-settled', { name: 'ping', pad: small }, { phase: 'coalesced', aliasOf: 'kind-000' }));
    const session = { running: true, mode: 'normal', ownerRoom: owner, ownerDeviceId: 'proof-device', startedAt: 5, trackingStartedAt: 5, intervalSecs: 1800 };
    // Held (not settled) and protected records.
    const pending = record('pending-conflict', { name: 'ping', pad: small }, { phase: 'conflict', reason: 'occurrence-changed',
      eventKey: 'ping:fixture:held', dependsOn: 'chain-a1' });
    const protectedRecords = [
      record('chain-a1', { name: 'focus-end-work' }, { dependsOn: 'chain-a2' }), // pinned by the coordinator (direct)
      record('chain-a2', { name: 'focus-start' }, { dependsOn: 'chain-a3' }),    // closure
      record('chain-a3', { name: 'save-entry' }),                                // closure
      record('timer-w2', { name: 'save-entry' }),                                // closure behind the timer writer
      record('timer-t1', { name: 'ping' }),                                      // the timer write chain's ping
      record('timer-writer', { name: 'switch-task' }, { dependsOn: 'timer-w2',
        proposal: { before: { timer: { ...session, _csWrite: { v: 1, operationId: 'timer-t1', revision: 3 } } }, patch: {}, local: {} } }),
      record('alias-pending', { name: 'ping' }, { phase: 'coalesced', aliasOf: 'pending-conflict', eventKey: 'ping:fixture:held' }),
      record('held-evidence', { name: 'hydrate-accounting' }, { authority: 'coherent-account-read', evidence: { raw: 'unknown server value' } }),
      record('cache-witness-entry', { name: 'save-entry', records: [{ store: 'entries', id: 77,
        before: { id: 77, activity: 'Old title' }, after: { id: 77, activity: 'New title' } }] }),
      record('cache-witness-timer', { name: 'start-timer', after: { running: true, timerStartedAt: 5, totalSecs: 1800, lastTaskForRepeat: 'Write',
        currentTask: 'Write', taskStartTime: 5, trackingStartedAt: 5, blockStartTime: 5, timerOwnerDeviceId: 'proof-device', currentTaskPlanItemId: null } })
    ];
    const notWitness = record('stale-not-cached', { name: 'save-entry', records: [{ store: 'entries', id: 88,
      before: { id: 88, activity: 'Gone' }, after: null }], pad: small });
    const filler = Array.from({ length: 60 }, (_, i) => record('filler-' + String(i).padStart(3, '0'),
      { name: 'hydrate-accounting', frame: { pad: 'f'.repeat(50_000) } }, { authority: 'coherent-account-read' }));
    const commit = filler.at(-1);
    commit.appliedGeneration = 1;
    const value = { entries: [{ id: 77, activity: 'New title' }], focusRedemptions: [],
      serverTimer: { ...session, _csWrite: { v: 1, operationId: 'timer-writer', revision: 4 } } };
    const history = [...settledKinds, ...protectedRecords, notWitness, ...filler];
    localStorage.setItem(key, JSON.stringify({ v: 1, owner, generation: 1, committed: { generation: 1, operationId: commit.id, value },
      history, queue: [pending] }));
    // A stale entry copy and a stale running-timer copy: only history images explain them.
    localStorage.setItem(accountLocalKey('ta3-entries', owner), JSON.stringify([{ id: 77, activity: 'Old title' }]));
    localStorage.setItem(accountLocalKey(TIMER_STORAGE_KEY, owner), JSON.stringify({ timerStartedAt: 5, totalSecs: 1800, running: true,
      lastTask: 'Write', currentTask: 'Write', taskStartTime: 5, trackingStartedAt: 5, blockStartTime: 5, timerUpdatedAt: 9,
      ownerDeviceId: 'proof-device', planItemId: null }));
    const initialChars = localStorage.getItem(key).length;
    let seq = 0;
    const coordinator = AccountingCommand.createCoordinator({ storage: localStorage, lock: TimeAckCore.webLock,
      identity: () => ctx, randomId: () => 'kinds-fresh-' + (++seq), same: TimeAckCore.same, compaction: accountingCompactionFlags(),
      transport: { enforcesAccounting: true, inspect: async () => ({}) },
      prepare: async () => ({ localOnly: true, projection: value }), apply() {} });
    const advance = () => coordinator.submit({ name: 'hydrate-accounting', confirmedOnly: true });
    await advance(); await AccountingHistoryArchive.read(owner); await advance();
    const final = coordinator.snapshot(owner), archived = await AccountingHistoryArchive.read(owner);
    const live = new Set(final.history.map(op => op.id)), dropped = Object.keys(final.droppedIds || {});
    // Page roots: this page's Focus producer and ordinary recovery (state owned by the signed-in account).
    const producer = _focusProducer, recovery = _ordinaryProvisionalRecovery;
    let roots;
    try {
      _focusProducer = { context: { owner: roomCode }, parentId: 'fp-1' };
      _ordinaryProvisionalRecovery = { operationId: 'or-1' };
      const at = (id, extra) => ({ id, phase: 'local-applied', input: { name: 'focus-start' }, ...extra });
      const state = { owner: roomCode, history: [at('fp-0'), at('fp-1', { dependsOn: 'fp-0' }), at('or-1'), at('other')], queue: [], committed: null };
      roots = [...accountingArchiveProtected(state, state.history, [])].sort();
    } finally { _focusProducer = producer; _ordinaryProvisionalRecovery = recovery; }
    return {
      initialChars, finalChars: localStorage.getItem(key).length, dropped, live: [...live], roots,
      kinds: settledKinds.map(op => op.id), protected: protectedRecords.map(op => op.id), notWitness: notWitness.id,
      preserved: history.every(op => [...final.history, ...archived].some(copy => copy.id === op.id && TimeAckCore.same(copy, op))),
      queue: final.queue.map(op => op.id), committedValue: TimeAckCore.same(final.committed.value, value)
    };
  });
  expect(result.kinds.filter(id => !result.dropped.includes(id)), 'settled kinds left in live history').toEqual([]);
  expect(result.dropped).toContain(result.notWitness);
  expect(result.protected.filter(id => !result.live.includes(id)), 'protected records archived').toEqual([]);
  expect(result.roots).toEqual(['fp-0', 'fp-1', 'or-1']);
  expect(result.queue).toEqual(['pending-conflict']);
  expect(result.preserved).toBe(true);
  expect(result.committedValue).toBe(true);
  expect(result.finalChars).toBeLessThan(result.initialChars);
});

test('at the wall, the verified cut frees room for a page-held capture, which then becomes durable and applies', async ({ page }) => {
  const uid = 'archive_wall', world = await emulator.fresh(rules);
  await open(page, world, uid); await pinned(page);
  const result = await page.evaluate(async () => {
    const owner = 'uid_wall_fixture', key = AccountingCommand.BASE + ':' + owner;
    const ctx = { owner, uid: 'wall_fixture', device: 'proof-device', generation: 1 };
    // 74 settled records: the commit cut (newest 50 + batch 25) has nothing to do, so only the quota cut can help.
    const history = Array.from({ length: 74 }, (_, i) => ({ v: 1, ...ctx, id: 'wall-' + String(i).padStart(3, '0'), at: 1 + i,
      phase: 'local-applied', input: { name: ['ping', 'save-entry', 'focus-start', 'automatic-log'][i % 4], pad: 'w'.repeat(30_000) },
      local: null, eventKey: null, dependsOn: null }));
    const commit = history.at(-1);
    commit.appliedGeneration = 1;
    localStorage.setItem(key, JSON.stringify({ v: 1, owner, generation: 1, committed: { generation: 1, operationId: commit.id, value: { entries: [] } },
      history, queue: [] }));
    // Real quota semantics for this owner's keys: a write fails when keys plus values would exceed the limit.
    const write = Storage.prototype.setItem;
    const used = () => Object.keys(localStorage).reduce((n, k) => n + k.length + localStorage.getItem(k).length, 0);
    let limit = Infinity;
    Storage.prototype.setItem = function (k, v) {
      if (this === localStorage && String(k).includes(owner)) {
        const old = localStorage.getItem(k), next = used() - (old == null ? 0 : k.length + old.length) + k.length + String(v).length;
        if (next > limit) throw new DOMException('Injected full storage', 'QuotaExceededError');
      }
      return write.call(this, k, v);
    };
    let seq = 0;
    const coordinator = AccountingCommand.createCoordinator({ storage: localStorage, lock: TimeAckCore.webLock,
      identity: () => ctx, randomId: () => 'wall-fresh-' + (++seq), same: TimeAckCore.same, compaction: accountingCompactionFlags(),
      transport: { enforcesAccounting: true, inspect: async () => ({}) },
      prepare: async () => ({ localOnly: true, projection: { entries: [] } }), apply() {} });
    try {
      limit = used() + 500;
      let captureError = null;
      try { coordinator.capture({ name: 'hydrate-accounting', confirmedOnly: true, original: 'p'.repeat(5_000) }); }
      catch (error) { captureError = error.name; }
      const heldAfterCapture = coordinator.failedCaptureCount(owner);
      const first = await coordinator.drain(); // offers the candidates to IndexedDB; nothing is verified yet
      const heldAfterFirst = coordinator.failedCaptureCount(owner);
      await AccountingHistoryArchive.read(owner); // the readonly transaction queues behind the archive write
      const second = await coordinator.drain(); // drops verified records, then retries the original bytes
      const final = coordinator.snapshot(owner), archived = await AccountingHistoryArchive.read(owner);
      return {
        captureError, heldAfterCapture, first: first.status, heldAfterFirst, second: second.status,
        held: coordinator.failedCaptureCount(owner), dropped: Object.keys(final.droppedIds || {}).length,
        applied: final.history.filter(op => op.input.original && op.phase === 'local-applied').length,
        preserved: history.every(op => [...final.history, ...archived].some(copy => copy.id === op.id && TimeAckCore.same(copy, op)))
      };
    } finally { Storage.prototype.setItem = write; }
  });
  expect(result.captureError).toBe('QuotaExceededError');
  expect(result.heldAfterCapture).toBe(1);
  expect(result.first).not.toBe('drained');
  expect(result.heldAfterFirst).toBe(1);
  expect(result.second).toBe('drained');
  expect(result.held).toBe(0);
  expect(result.applied).toBe(1);
  expect(result.dropped).toBe(24);
  expect(result.preserved).toBe(true);
});

// TASK-050 / TASK-051 §6: a queued Stop's whole ordinary lineage (Stop -> resume -> Start) survives a cut while the
// Stop is unconfirmed, so the provisional display still resolves its Start and the Stop still files the session.
// An expired resume rewrites the timer's session fields, so only the pending-chain protection reaches the Start.
for (const expired of [false, true]) test(`a cut while an offline Stop is unconfirmed keeps its whole lineage (resume ${expired ? 'after' : 'before'} the interval); display and Stop still resolve`, async ({ page }) => {
  test.setTimeout(180_000);
  const uid = 'archive_lineage' + (expired ? '_expired' : ''), world = await emulator.fresh(rules), MIN = 60_000;
  await open(page, world, uid); await pinned(page);
  const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
  await page.route(pattern, route => route.abort('failed'));
  expect(await page.evaluate(() => _startTimer('Lineage session'))).toBe(true);
  await page.evaluate(at => window.__setNow(at), T0 + (expired ? 35 : 5) * MIN);
  expect(await page.evaluate(timerExpired => captureOrdinaryTimer('resume', null, null, { timerExpired }), expired)).toBe(true);
  await page.evaluate(at => window.__setNow(at), T0 + 40 * MIN);
  expect(await page.evaluate(() => captureOrdinaryTimer('stop'))).toBe(true);
  const ids = await page.evaluate(() => Object.fromEntries(accountingCoordinator().snapshot().queue
    .filter(op => op.input.ordinary).map(op => [op.input.ordinary.kind, { id: op.id, dependsOn: op.dependsOn }])));
  expect(ids.resume.dependsOn).toBe(ids.start.id);
  expect(ids.stop.dependsOn).toBe(ids.resume.id);
  // Reconnect, but the Stop's write never arrives: Start and resume settle; the Stop stays unconfirmed.
  await page.unroute(pattern);
  await page.route(pattern, route => route.request().method() === 'PATCH' && (route.request().postData() || '').includes(ids.stop.id)
    ? route.abort('failed') : route.continue());
  await page.evaluate(() => accountingCoordinator().drain());
  // Normal reconciliation keeps committing read-only refreshes behind the held Stop until the Start leaves the newest 50.
  const before = await page.evaluate(async ({ ids }) => {
    for (let i = 0; i < 55; i++) await accountingCoordinator().submit({ name: 'hydrate-accounting', confirmedOnly: true });
    const state = accountingCoordinator().snapshot(), plain = state.history.filter(op => op.input.name !== 'checkpoint');
    return { queue: state.queue.map(op => [op.id, op.phase]), startAge: plain.length - plain.findIndex(op => op.id === ids.start.id) };
  }, { ids });
  expect(before.queue).toEqual([[ids.stop.id, 'unknown']]);
  expect(before.startAge).toBeGreaterThan(55);
  // A full store: the verified cut runs on its own (first drain archives, second drops).
  await installQuotaFault(page); await setFault(page, 'intake');
  const cut = await page.evaluate(async ({ ids }) => {
    const coordinator = accountingCoordinator();
    try { coordinator.capture({ name: 'hydrate-accounting', confirmedOnly: true }); } catch {}
    await coordinator.drain(); await AccountingHistoryArchive.read(roomCode); await coordinator.drain();
    const state = coordinator.snapshot(), dropped = Object.keys(state.droppedIds || {});
    const view = ordinaryProvisionalState();
    return { dropped: dropped.length, startDropped: dropped.includes(ids.start.id), resumeDropped: dropped.includes(ids.resume.id),
      view: view && { startId: view.startId, conflict: view.conflict, kind: view.command.kind }, paused: window._accountingLegacyLoadError || null };
  }, { ids });
  expect(cut.dropped).toBeGreaterThan(0);
  expect(cut).toMatchObject({ startDropped: false, resumeDropped: false, paused: null,
    view: { startId: ids.start.id, conflict: false, kind: 'stop' } });
  await expect(page.locator('#ordinary-provisional')).toContainText('Lineage session');
  // Storage recovers and the write goes through: the original session is filed exactly once.
  await setFault(page, ''); await page.unroute(pattern);
  const final = await page.evaluate(async () => {
    await accountingCoordinator().drain();
    return { queue: accountingCoordinator().snapshot().queue.length, held: accountingCoordinator().failedCaptureCount(roomCode) };
  });
  expect(final).toEqual({ queue: 0, held: 0 });
  const filed = Object.values(await world.read(`rooms/uid_${uid}/entries`) || {});
  expect(filed).toEqual([expect.objectContaining({ activity: 'Lineage session', tsStart: T0, ts: T0 + 40 * MIN })]);
});
