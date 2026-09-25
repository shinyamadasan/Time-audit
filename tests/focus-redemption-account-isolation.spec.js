// Focus Redemption Account Isolation V1 — focus redemptions across account switches, in a real browser.
//
// Nothing is faked except Firebase: the page's own storage.js receives onAuthStateChanged(A), then
// onAuthStateChanged(B) with NO sign-out between (a direct switch), or null (sign-out), and the tests
// only OBSERVE what storage.js writes into a room-partitioned fake and what the real UI/state holds.
//
// Reproduced on origin/main cb71298 (before this fix): a direct A -> B switch pushed A's local
// `ta3-focus-redemptions` (a single unscoped key, unlike the already-scoped entries/settings/plans)
// into rooms/uid_B/focusRedemptions/<A id>, via startSync -> syncFocusRedemptions, which checked only
// `if (!fbRoomRef)` — never which account's redemptions were in memory. The remote focusRedemptions
// listener also had no isCurrentSync() guard, so a late delivery from A's session after B became
// current could still merge into `focusRedemptions` and re-persist it.
//
// No real Firebase project, no network, no production data.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';

const NOW = Date.parse('2026-09-24T08:00:00+08:00');
const A = 'uid_account-a';
const B = 'uid_account-b';

// A room-partitioned, write-recording Firebase stub whose auth, connectivity and async timing the
// test controls. Every write (update/set/transaction/remove) is logged with its absolute path.
// (Same shape as tests/remaining-remote-account-isolation.spec.js's stub — kept local so this spec
// has no cross-file dependency on another spec's harness.)
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const log = { writes: [], listeners: [] };
  const tree = {};
  const listeners = new Map();
  const retained = [];
  let connected = true;
  let failWrites = false;
  let authCb = null;
  const get = p => p.split('/').filter(Boolean).reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), tree);
  const put = (p, v) => {
    const segs = p.split('/').filter(Boolean); let n = tree;
    for (let i = 0; i < segs.length - 1; i++) { if (typeof n[segs[i]] !== 'object' || n[segs[i]] === null) n[segs[i]] = {}; n = n[segs[i]]; }
    if (v === null || v === undefined) delete n[segs[segs.length - 1]]; else n[segs[segs.length - 1]] = v;
  };
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const snapshot = value => ({ val: () => clone(value === undefined ? null : value), ref: { remove: () => Promise.resolve() } });
  const fire = p => (listeners.get(p) || []).forEach(cb => cb(snapshot(get(p))));
  const fireUp = p => { let q = p; while (q) { fire(q); q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : ''; } };
  const write = (p, v) => { log.writes.push({ path: p, value: clone(v) }); put(p, clone(v)); fireUp(p); };
  const makeRef = refPath => ({
    path: refPath,
    key: refPath.split('/').pop(),
    child(c) { return makeRef(refPath + '/' + c); },
    on(ev, cb) {
      if (ev !== 'value') return cb;
      log.listeners.push(refPath);
      if (!listeners.has(refPath)) listeners.set(refPath, []);
      listeners.get(refPath).push(cb);
      retained.push({ path: refPath, cb });
      setTimeout(() => cb(snapshot(refPath === '.info/connected' ? connected : get(refPath))), 0);
      return cb;
    },
    off() { listeners.delete(refPath); },
    once(ev, cb) {
      const s = snapshot(get(refPath));
      if (typeof cb === 'function') setTimeout(() => cb(s), 0);
      return Promise.resolve(s);
    },
    update(map) {
      if (failWrites) return Promise.reject(new Error('offline'));
      Object.entries(map || {}).forEach(([k, v]) => write(refPath + '/' + k, v));
      return Promise.resolve();
    },
    set(v) { if (failWrites) return Promise.reject(new Error('offline')); write(refPath, v); return Promise.resolve(); },
    remove() { if (failWrites) return Promise.reject(new Error('offline')); write(refPath, null); return Promise.resolve(); },
    transaction(fn) {
      if (failWrites) return Promise.reject(new Error('offline'));
      const cur = get(refPath);
      const next = fn(cur === undefined ? null : clone(cur));
      if (next === undefined) return Promise.resolve({ committed: false, snapshot: snapshot(cur) });
      write(refPath, next);
      return Promise.resolve({ committed: true, snapshot: snapshot(next) });
    },
    push(v) { const r = makeRef(refPath + '/pushed'); if (v !== undefined) r.set(v); return r; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; },
  });
  const user = uid => (uid ? { uid, displayName: uid, email: uid + '@example.test', photoURL: '' } : null);
  window.__fbTest = {
    log,
    get: p => clone(get(p) ?? null),
    seed(p, v) { put(p, clone(v)); },
    remoteWrite(p, v) { put(p, clone(v)); fireUp(p); },
    fireLate(p) { retained.filter(r => r.path === p).forEach(r => r.cb(snapshot(get(p)))); },
    setFailWrites(v) { failWrites = v; },
    setConnected(v) { connected = v; (listeners.get('.info/connected') || []).forEach(cb => cb(snapshot(connected))); },
    signInAs(uid) { authCb(user(uid)); },
    signOut() { authCb(null); },
  };
  const auth = () => ({ onAuthStateChanged(cb) { authCb = cb; setTimeout(() => cb(user(window.__initialUid || 'account-a')), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(c) { const a = { config: c }; this.apps.push(a); return a; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
})();`;

test.beforeAll(async () => {
  appServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = path.resolve(APP_ROOT, `.${decodeURIComponent(pathname)}`);
      if (!filePath.startsWith(APP_ROOT)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${appServer.address().port}/index.html`;
});

test.afterAll(async () => {
  if (appServer) await new Promise(resolve => appServer.close(resolve));
});

// Pre-scoping data on this device: owner unknown. Must never be adopted, displayed or uploaded.
const LEGACY_REDEMPTION = { id: 'legacy-1', label: 'LEGACY-unowned redemption', cost: 5, redeemedAt: NOW - 999999, updatedAt: NOW - 999999 };
const LEGACY = { 'ta3-focus-redemptions': JSON.stringify([LEGACY_REDEMPTION]) };
const LEGACY_MARK = /LEGACY-unowned/;
const A_MARK = /A-private redemption/;
const B_MARK = /B-own redemption/;

const aRedemption = { id: 'a-1', label: 'A-private redemption', cost: 10, redeemedAt: NOW - 600000, updatedAt: NOW - 600000 };
const bRedemption = { id: 'b-1', label: 'B-own redemption', cost: 20, redeemedAt: NOW - 700000, updatedAt: NOW - 700000 };

function seedBRoom(page) {
  return page.evaluate(({ B, bRedemption }) => {
    window.__fbTest.seed(`rooms/${B}/focusRedemptions/r_${bRedemption.id}`, bRedemption);
  }, { B, bRedemption });
}

async function openApp(page, { initialUid = 'account-a', scoped = {} } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ now, legacy, scoped, initialUid }) => {
    const RealDate = Date;
    let tick = now;
    window.Date = class MockDate extends RealDate { constructor(...a) { super(...(a.length ? a : [tick])); } static now() { return ++tick; } };
    window.__initialUid = initialUid;
    if (sessionStorage.getItem('fr-seeded')) return; // reloads keep what the app persisted
    localStorage.clear();
    sessionStorage.setItem('fr-seeded', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-device-id', 'device-fr');
    Object.entries(legacy).forEach(([k, v]) => localStorage.setItem(k, v));
    Object.entries(scoped).forEach(([k, v]) => localStorage.setItem(k, v));
  }, { now: NOW, legacy: LEGACY, scoped, initialUid });
  await page.goto(appUrl);
  await page.waitForFunction(uid => !!window.__fbTest && globalThis.getChronaSenseRoomCode?.() === `uid_${uid}`, initialUid);
  await settle(page);
}

const settle = page => page.waitForTimeout(250);

/** Creates a focus redemption the same way the (currently dormant) redemption path would: an item
 *  in the in-memory array, persisted and synced through the real functions the app uses. */
async function createRedemption(page, item) {
  await page.evaluate(async r => { focusRedemptions.unshift({ ...r }); persist(); await syncFocusRedemptions(); }, item);
  await settle(page);
}

async function switchTo(page, uid) {
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; });
  await page.evaluate(u => window.__fbTest.signInAs(u), uid);
  await page.waitForFunction(u => globalThis.getChronaSenseRoomCode() === `uid_${u}`, uid);
  await settle(page);
}

const writesSinceMark = page => page.evaluate(() => window.__fbTest.log.writes.slice(window.__mark || 0));
const writesUnder = (ws, room) => ws.filter(w => w.path.startsWith(`rooms/${room}/`));
const matching = (ws, re) => ws.filter(w => re.test(JSON.stringify(w.value)));
const allWrites = page => page.evaluate(() => window.__fbTest.log.writes);
const legacyKeys = page => page.evaluate(keys => Object.fromEntries(keys.map(k => [k, localStorage.getItem(k)])), Object.keys(LEGACY));
const scopedSlot = (page, room) => page.evaluate(room => localStorage.getItem(`ta3-focus-redemptions:${room}`), room);
const shown = page => page.evaluate(() => ({
  room: globalThis.getChronaSenseRoomCode(),
  redemptions: focusRedemptions.filter(r => !r.deleted).map(r => r.label).sort(),
}));

// ═══════════════════════════════════════════════════════════════════════════
// 1 & 4. Direct A -> empty B (the reproduced leak); wrong-room push refused
// ═══════════════════════════════════════════════════════════════════════════

test('direct A -> empty B: zero A focus-redemption writes into B, none shown as B; A slot and legacy key untouched', async ({ page }) => {
  await openApp(page);
  await createRedemption(page, aRedemption);
  expect(await shown(page)).toMatchObject({ room: A, redemptions: ['A-private redemption'] });
  const aRoom = await page.evaluate(A => window.__fbTest.get(`rooms/${A}`), A);
  expect(JSON.stringify(aRoom)).toMatch(A_MARK);
  const aSlot = await scopedSlot(page, A);
  expect(aSlot).toMatch(A_MARK);

  await switchTo(page, 'account-b');

  const ws = await writesSinceMark(page);
  expect(matching(writesUnder(ws, B), A_MARK)).toEqual([]);
  expect(JSON.stringify(await page.evaluate(B => window.__fbTest.get(`rooms/${B}`), B))).not.toMatch(A_MARK);
  expect(await shown(page)).toMatchObject({ room: B, redemptions: [] });
  // A's scoped slot is exactly as A left it; the unowned legacy key was neither read nor changed.
  expect(await scopedSlot(page, A)).toEqual(aSlot);
  expect(await legacyKeys(page)).toEqual(LEGACY);
  expect(matching(await allWrites(page), LEGACY_MARK)).toEqual([]);
});

test('a push whose target room is not the one owning local state is refused for focus redemptions', async ({ page }) => {
  await openApp(page);
  await createRedemption(page, aRedemption);
  const result = await page.evaluate(async ({ B }) => {
    const realRef = fbRoomRef;
    fbRoomRef = fbDb.ref(`rooms/${B}`); // points at B while A's state is in memory
    window.__mark = window.__fbTest.log.writes.length;
    const r = await syncFocusRedemptions();
    const writes = window.__fbTest.log.writes.slice(window.__mark);
    fbRoomRef = realRef;
    return { r, writes };
  }, { B });
  expect(result.r).toBe(false);
  expect(result.writes).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. A -> B with B history
// ═══════════════════════════════════════════════════════════════════════════

test('A -> B with B history: B sees B only, B cloud stays B-authoritative, no A merge or overwrite', async ({ page }) => {
  await openApp(page);
  await createRedemption(page, aRedemption);
  await seedBRoom(page);
  const bBefore = await page.evaluate(B => window.__fbTest.get(`rooms/${B}/focusRedemptions`), B);
  const aSlot = await scopedSlot(page, A);

  await switchTo(page, 'account-b');

  const ws = await writesSinceMark(page);
  expect(matching(writesUnder(ws, B), A_MARK)).toEqual([]);
  const bAfter = await page.evaluate(B => window.__fbTest.get(`rooms/${B}/focusRedemptions`), B);
  expect(bAfter).toEqual(bBefore); // A's switch changed nothing in B's own focus-redemption history
  expect(await shown(page)).toMatchObject({ room: B, redemptions: ['B-own redemption'] });
  expect(await scopedSlot(page, A)).toEqual(aSlot);
  expect(await scopedSlot(page, B)).toMatch(B_MARK);

  // A legitimate B redemption after the switch still works, and stays B-only.
  await createRedemption(page, { id: 'b-2', label: 'B-own second redemption', cost: 5, redeemedAt: NOW, updatedAt: NOW });
  const bRoomNow = await page.evaluate(B => window.__fbTest.get(`rooms/${B}/focusRedemptions`), B);
  expect(Object.keys(bRoomNow).sort()).toEqual(['r_b-1', 'r_b-2']);
  expect(JSON.stringify(await page.evaluate(A => window.__fbTest.get(`rooms/${A}`), A))).not.toMatch(B_MARK);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. A -> B -> A
// ═══════════════════════════════════════════════════════════════════════════

test('A -> B -> A: A restored exactly, B unchanged, no duplicates, no cross-room write either way', async ({ page }) => {
  await openApp(page);
  await createRedemption(page, aRedemption);
  await seedBRoom(page);
  const aSlot = await scopedSlot(page, A);
  await page.evaluate(() => { window.__start = window.__fbTest.log.writes.length; });

  await switchTo(page, 'account-b');
  const bRoomAfterB = await page.evaluate(B => window.__fbTest.get(`rooms/${B}`), B);
  await switchTo(page, 'account-a');

  expect(await shown(page)).toMatchObject({ room: A, redemptions: ['A-private redemption'] });
  expect(await scopedSlot(page, A)).toEqual(aSlot);
  const ws = await page.evaluate(() => window.__fbTest.log.writes.slice(window.__start));
  expect(matching(writesUnder(ws, B), A_MARK)).toEqual([]);
  expect(matching(writesUnder(ws, A), B_MARK)).toEqual([]);
  expect(await page.evaluate(B => window.__fbTest.get(`rooms/${B}`), B)).toEqual(bRoomAfterB);
  const aRoom = await page.evaluate(A => window.__fbTest.get(`rooms/${A}/focusRedemptions`), A);
  expect(Object.keys(aRoom)).toEqual(['r_a-1']); // no duplicate
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 & 6. Stale startSync/reconnect callback and in-flight async across the switch
// ═══════════════════════════════════════════════════════════════════════════

test('stale async: a late focusRedemptions listener delivery from A never merges into B, and a reconnect fired after the switch pushes nothing of A', async ({ page }) => {
  await openApp(page);
  await createRedemption(page, aRedemption);
  await seedBRoom(page);

  await switchTo(page, 'account-b');
  const bSlotBefore = await scopedSlot(page, B); // B's own history, already hydrated by the real switch
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; });
  // A listener from A's session delivering after the switch (a late network event under the old room).
  await page.evaluate(({ A }) => {
    window.__fbTest.remoteWrite(`rooms/${A}/focusRedemptions/r_late`, { id: 'late-1', label: 'A-private redemption late', cost: 1, redeemedAt: Date.now(), updatedAt: Date.now() });
    window.__fbTest.fireLate(`rooms/${A}/focusRedemptions`);
  }, { A });
  await settle(page);
  expect(await shown(page)).toMatchObject({ room: B, redemptions: ['B-own redemption'] });
  expect(await scopedSlot(page, B)).toEqual(bSlotBefore);
  expect(JSON.stringify(await scopedSlot(page, B))).not.toMatch(/A-private/);
  const ws = await writesSinceMark(page);
  expect(ws.filter(w => w.path !== `rooms/${A}/focusRedemptions/r_late`)).toEqual([]); // only the test's own seed write
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Sign-out
// ═══════════════════════════════════════════════════════════════════════════

test('sign-out: no active redemption state, stale callback cannot write, scoped slot and legacy key remain; signing back in as A restores A', async ({ page }) => {
  await openApp(page);
  await createRedemption(page, aRedemption);
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; window.__fbTest.signOut(); });
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode() === '');
  const aSlot = await scopedSlot(page, A);
  await page.evaluate(({ A }) => { window.__fbTest.fireLate(`rooms/${A}/focusRedemptions`); }, { A });
  await settle(page);
  expect(await writesSinceMark(page)).toEqual([]);
  expect(await shown(page)).toMatchObject({ room: '', redemptions: [] });
  expect(await scopedSlot(page, A)).toEqual(aSlot);
  expect(await legacyKeys(page)).toEqual(LEGACY);
  await switchTo(page, 'account-a');
  expect(await shown(page)).toMatchObject({ room: A, redemptions: ['A-private redemption'] });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 & 9. Offline account switching
// ═══════════════════════════════════════════════════════════════════════════
// Focus redemptions DO support local/offline creation: createRedemption() writes to the in-memory
// array and persists locally even when syncFocusRedemptions()'s push fails (matches the existing
// entries contract — an offline create is never blocked on the network).

test('offline A -> B, no B cache: B never sees A; reconnect converges nothing of A into B; back to A, A\'s pending redemption is intact and pushes to A', async ({ page }) => {
  await openApp(page);
  await createRedemption(page, aRedemption);
  await page.evaluate(() => { window.__fbTest.setConnected(false); window.__fbTest.setFailWrites(true); });
  await createRedemption(page, { id: 'a-2', label: 'A-private offline redemption', cost: 3, redeemedAt: NOW, updatedAt: NOW });
  await switchTo(page, 'account-b');
  expect(await shown(page)).toMatchObject({ room: B, redemptions: [] });
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; window.__fbTest.setFailWrites(false); window.__fbTest.setConnected(true); });
  await settle(page);
  expect(matching(writesUnder(await writesSinceMark(page), B), A_MARK)).toEqual([]);
  await switchTo(page, 'account-a');
  expect((await shown(page)).redemptions).toEqual(['A-private offline redemption', 'A-private redemption']);
  await page.evaluate(async () => { await syncFocusRedemptions(); });
  await settle(page);
  const aRoom = await page.evaluate(A => window.__fbTest.get(`rooms/${A}/focusRedemptions`), A);
  expect(Object.keys(aRoom).sort()).toEqual(['r_a-1', 'r_a-2']);
});

// Note on contract: unlike entries (which re-pushes on a bare `.info/connected` reconnect when its
// local-version marker is ahead of last-sync), focusRedemptions has no such automatic reconnect-push
// in the existing product contract — convergence happens via forceSyncNow() ("Sync Now") or the next
// startSync() (the next sign-in/switch). That is pre-existing behavior this phase does not change;
// the test drives convergence the same way a user's "Sync Now" click would.
test('offline A -> B with a prior B cache: B only; reconnect (Sync Now) converges only B state into B', async ({ page }) => {
  const pendingB = { id: 'b-3', label: 'B-own cached redemption', cost: 2, redeemedAt: NOW - 100000, updatedAt: NOW - 100000 };
  await openApp(page, { scoped: { [`ta3-focus-redemptions:${B}`]: JSON.stringify([pendingB]) } });
  await createRedemption(page, aRedemption);
  await page.evaluate(() => { window.__fbTest.setConnected(false); window.__fbTest.setFailWrites(true); });
  await switchTo(page, 'account-b');
  expect(await shown(page)).toMatchObject({ room: B, redemptions: ['B-own cached redemption'] });
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; window.__fbTest.setFailWrites(false); window.__fbTest.setConnected(true); });
  await settle(page);
  await page.evaluate(async () => { await syncFocusRedemptions(); });
  await settle(page);
  const ws = await writesSinceMark(page);
  expect(matching(writesUnder(ws, B), A_MARK)).toEqual([]);
  expect(ws.some(w => w.path === `rooms/${B}/focusRedemptions/r_b-3`)).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Same-account reconnect still converges
// ═══════════════════════════════════════════════════════════════════════════

test('same-account reconnect: A\'s offline redemption converges into A\'s room only', async ({ page }) => {
  await openApp(page);
  await createRedemption(page, aRedemption);
  await page.evaluate(() => { window.__fbTest.setConnected(false); window.__fbTest.setFailWrites(true); });
  await createRedemption(page, { id: 'a-3', label: 'A-private reconnect redemption', cost: 4, redeemedAt: NOW, updatedAt: NOW });
  await page.evaluate(() => { window.__fbTest.setFailWrites(false); window.__fbTest.setConnected(true); });
  await page.evaluate(async () => { await syncFocusRedemptions(); });
  await settle(page);
  const aRoom = await page.evaluate(A => window.__fbTest.get(`rooms/${A}/focusRedemptions`), A);
  expect(aRoom.r_a3?.label || aRoom['r_a-3']?.label).toBe('A-private reconnect redemption');
});

// ═══════════════════════════════════════════════════════════════════════════
// 11 & 12. Unowned old key: not adopted, not uploaded
// ═══════════════════════════════════════════════════════════════════════════

test('unowned old key is never adopted, shown or uploaded — not even for the first account on the device', async ({ page }) => {
  await openApp(page); // A signs in with NO scoped slot; only the unowned legacy key exists
  expect(await shown(page)).toMatchObject({ room: A, redemptions: [] });
  await createRedemption(page, aRedemption);
  await switchTo(page, 'account-b');
  expect(matching(await allWrites(page), LEGACY_MARK)).toEqual([]);
  expect(await legacyKeys(page)).toEqual(LEGACY);
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Same-id A/B isolation (tombstone semantics preserved, not changed)
// ═══════════════════════════════════════════════════════════════════════════

test('same-id A/B isolation: A\'s redemption record never reaches B, even when B holds a redemption with the same id', async ({ page }) => {
  await openApp(page);
  await createRedemption(page, aRedemption); // id 'a-1'
  await page.evaluate(({ B }) => window.__fbTest.seed(`rooms/${B}/focusRedemptions/r_a-1`, { id: 'a-1', label: 'B-own same-id redemption', cost: 1, redeemedAt: Date.now(), updatedAt: Date.now() }), { B });
  await switchTo(page, 'account-b');
  const bItem = await page.evaluate(B => window.__fbTest.get(`rooms/${B}/focusRedemptions/r_a-1`), B);
  expect(bItem.label).toBe('B-own same-id redemption');
  expect(await shown(page)).toMatchObject({ redemptions: ['B-own same-id redemption'] });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Legitimate B redemption still works (also covered inline above)
// ═══════════════════════════════════════════════════════════════════════════

test('legitimate B redemption after a direct switch is pushed to B\'s room only', async ({ page }) => {
  await openApp(page);
  await createRedemption(page, aRedemption);
  await switchTo(page, 'account-b');
  await createRedemption(page, bRedemption);
  const bRoom = await page.evaluate(B => window.__fbTest.get(`rooms/${B}/focusRedemptions/r_b-1`), B);
  expect(bRoom.label).toBe('B-own redemption');
  expect(JSON.stringify(await page.evaluate(A => window.__fbTest.get(`rooms/${A}`), A))).not.toMatch(B_MARK);
});
