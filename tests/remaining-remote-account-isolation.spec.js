// Remaining Remote Cross-Account Isolation V1 — entries, settings/templates and legacy plans across account
// switches, in a real browser.
//
// Nothing is faked except Firebase: the page's own storage.js receives onAuthStateChanged(A), then
// onAuthStateChanged(B) with NO sign-out between (a direct switch), or null (sign-out), and the tests only
// OBSERVE what storage.js writes into a room-partitioned fake and what the real UI renders.
//
// Before the fix, on origin/main c346388, a direct A -> B switch:
//   - pushed A's entries into rooms/uid_B/entries (startSync -> syncEntries, unconditional),
//   - wrote A's settings into an empty rooms/uid_B/settings (syncSettings, remote empty -> push local),
//     and OVERWROTE B's existing settings + templates when A's local _savedAt was newer,
//   - merged B's remote legacy plans into the single unscoped local plan store, so an ordinary B edit
//     transacted A's task into rooms/uid_B/plans/<date>,
//   - showed A's entries, settings, templates and plan tasks as B's.
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
const TODAY = '2026-09-24';
const A = 'uid_account-a';
const B = 'uid_account-b';

// A room-partitioned, write-recording Firebase stub whose auth, connectivity, write failures and async
// timing the test controls. Every write (update/set/transaction/remove) is logged with its absolute path.
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const log = { writes: [], listeners: [] };
  const tree = {};
  const listeners = new Map();
  const retained = [];
  const heldReads = [];
  const heldTx = [];
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
  let connected = true;
  let failWrites = false;
  let holdReadPrefix = null;
  let holdTransactions = false;
  let authCb = null;
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
      const answer = () => snapshot(get(refPath));
      if (holdReadPrefix && refPath.startsWith(holdReadPrefix)) {
        return new Promise(resolve => heldReads.push(() => { const s = answer(); if (typeof cb === 'function') cb(s); resolve(s); }));
      }
      const s = answer();
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
      const attempt = () => {
        const cur = get(refPath);
        const next = fn(cur === undefined ? null : clone(cur));
        if (next === undefined) return { committed: false, snapshot: snapshot(cur) };
        write(refPath, next);
        return { committed: true, snapshot: snapshot(next) };
      };
      if (!holdTransactions) return Promise.resolve(attempt());
      // First attempt runs now (as Firebase's optimistic local run does); the retry runs when released.
      const cur = get(refPath);
      fn(cur === undefined ? null : clone(cur));
      return new Promise(resolve => heldTx.push(() => resolve(attempt())));
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
    holdReads(prefix) { holdReadPrefix = prefix; },
    releaseReads() { holdReadPrefix = null; heldReads.splice(0).forEach(f => f()); },
    holdTransactions(v) { holdTransactions = v; },
    releaseTransactions() { heldTx.splice(0).forEach(f => f()); },
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

// Pre-scoping data on this device: owner unknown. Must never be adopted, displayed, uploaded or changed.
const LEGACY = {
  'ta3-entries': JSON.stringify([{ id: 900001, ts: NOW - 3600000, tsStart: NOW - 5400000, date: TODAY, activity: 'LEGACY-unowned entry', energy: 'deep', blockIntervalMin: 30, updatedAt: NOW - 3600000 }]),
  'ta3-settings': JSON.stringify({ deepGoal: 55, templates: [{ id: 'tLegacy', activity: 'LEGACY-unowned template', energy: 'deep', days: [0, 1, 2, 3, 4, 5, 6], startTime: '06:00', endTime: '07:00', enabled: true }], _savedAt: NOW - 1000, _templatesSavedAt: NOW - 1000 }),
  'ta3-plans': JSON.stringify({ [TODAY]: { items: [{ id: 'pLegacy', task: 'LEGACY-unowned task', when: '', done: false, doneAt: null, updatedAt: NOW - 1000, updatedBy: 'old' }], updatedAt: NOW - 1000 } }),
  'ta3-tz': 'Pacific/Auckland',
  'ta3-lv': String(NOW + 999999),
  'ta3-last-sync': '1',
};
const LEGACY_MARK = /LEGACY-unowned|"deepGoal":55|Pacific\/Auckland|900001|pLegacy/;
const A_MARK = /A-private|"deepGoal":37|America\/Denver|111111|pAprivate/;
const B_MARK = /B-own|"deepGoal":11|Europe\/London|222222|pBown/;

const aEntry = { id: 111111, ts: NOW - 600000, tsStart: NOW - 1800000, date: TODAY, activity: 'A-private entry', energy: 'deep', blockIntervalMin: 30, updatedAt: NOW - 600000 };
const bEntry = { id: 222222, ts: NOW - 700000, tsStart: NOW - 2500000, date: TODAY, activity: 'B-own entry', energy: 'shallow', blockIntervalMin: 30, updatedAt: NOW - 700000 };
const aTemplate = { id: 'tA', activity: 'A-private template', energy: 'deep', days: [0, 1, 2, 3, 4, 5, 6], startTime: '09:00', endTime: '10:00', enabled: true, skipDates: [] };
const bTemplate = { id: 'tB', activity: 'B-own template', energy: 'shallow', days: [0, 1, 2, 3, 4, 5, 6], startTime: '14:00', endTime: '15:00', enabled: true, skipDates: [] };
const planItem = (id, task) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: NOW - 5000, updatedBy: 'seed' });

/** Seeds B's room with B's own history (the "B already has data" case). */
function seedBRoom(page) {
  return page.evaluate(({ B, bEntry, bTemplate, plan, TODAY, NOW }) => {
    const older = NOW - 86400000; // older than anything A writes locally — the case that used to overwrite B
    window.__fbTest.seed(`rooms/${B}/entries/e_${bEntry.id}`, bEntry);
    window.__fbTest.seed(`rooms/${B}/settings`, { deepGoal: 11, timezone: 'Europe/London', _savedAt: older, _templatesSavedAt: older, templates: [bTemplate] });
    window.__fbTest.seed(`rooms/${B}/templates`, [bTemplate]);
    window.__fbTest.seed(`rooms/${B}/templatesSavedAt`, older);
    window.__fbTest.seed(`rooms/${B}/plans/${TODAY}`, { items: [plan], updatedAt: NOW - 5000, updatedBy: 'b-device' });
  }, { B, bEntry, bTemplate, plan: planItem('pBown', 'B-own task'), TODAY, NOW });
}

async function openApp(page, { initialUid = 'account-a', scoped = {}, beforeAuth } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ now, legacy, scoped, initialUid }) => {
    const RealDate = Date;
    // Fixed start instant; the clock still advances (1 ms per Date.now()) so "changed since last sync" stays observable.
    let tick = now;
    window.Date = class MockDate extends RealDate { constructor(...a) { super(...(a.length ? a : [tick])); } static now() { return ++tick; } };
    window.__initialUid = initialUid;
    if (sessionStorage.getItem('rr-seeded')) return; // reloads keep what the app persisted
    localStorage.clear();
    sessionStorage.setItem('rr-seeded', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-device-id', 'device-rr');
    Object.entries(legacy).forEach(([k, v]) => localStorage.setItem(k, v));
    Object.entries(scoped).forEach(([k, v]) => localStorage.setItem(k, v));
  }, { now: NOW, legacy: LEGACY, scoped, initialUid });
  await page.goto(appUrl);
  await page.waitForFunction(uid => !!window.__fbTest && globalThis.getChronaSenseRoomCode?.() === `uid_${uid}`, initialUid);
  if (beforeAuth) await beforeAuth();
  await settle(page);
}

const settle = page => page.waitForTimeout(250);

/** Account A's facts, created through the same functions the UI calls: an entry, a settings change,
 *  a template, a pinned timezone and a legacy plan task — all synced to A's room. */
async function createAccountAFacts(page) {
  await page.evaluate(async ({ aEntry, aTemplate }) => {
    entries.unshift({ ...aEntry }); persist(); await syncEntries();
    document.getElementById('set-timezone').value = 'Asia/Tokyo';
    document.getElementById('set-deepgoal').value = '37';
    saveSettings();
    settings.templates = [{ ...aTemplate }]; persist(); await syncTemplates();
    document.getElementById('plan-task').value = 'A-private task'; addPlanItem();
    await new Promise(r => setTimeout(r, 50));
  }, { aEntry, aTemplate });
  await settle(page);
}

async function switchTo(page, uid) {
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; });
  await page.evaluate(u => window.__fbTest.signInAs(u), uid);
  await page.waitForFunction(u => globalThis.getChronaSenseRoomCode() === `uid_${u}`, uid);
  await settle(page);
}

const writesSinceMark = page => page.evaluate(() => window.__fbTest.log.writes.slice(window.__mark || 0));
const writesUnder = (ws, room) => ws.filter(w => w.path.startsWith(`rooms/${room}/`) || w.path.startsWith(`${room}/`));
const matching = (ws, re) => ws.filter(w => re.test(JSON.stringify(w.value)));
const allWrites = page => page.evaluate(() => window.__fbTest.log.writes);
const legacyKeys = page => page.evaluate(keys => Object.fromEntries(keys.map(k => [k, localStorage.getItem(k)])), Object.keys(LEGACY));
const slots = (page, room) => page.evaluate(room => Object.fromEntries(['ta3-entries', 'ta3-settings', 'ta3-plans', 'ta3-tz', 'ta3-lv', 'ta3-last-sync'].map(k => [k, localStorage.getItem(`${k}:${room}`)])), room);

/** What the app currently holds and shows as the signed-in account's state. */
const shown = page => page.evaluate(TODAY => ({
  room: globalThis.getChronaSenseRoomCode(),
  entries: entries.filter(e => !e.deleted).map(e => e.activity).sort(),
  deepGoal: settings.deepGoal,
  timezone: settings.timezone,
  windowTimezone: window.settings.timezone,
  templates: settings.templates.map(t => t.activity).sort(),
  plan: getPlanItems(TODAY).map(i => i.task).sort(),
  todayText: document.getElementById('view-today')?.innerText || '',
}), TODAY);

async function visibleTextAcrossViews(page) {
  let text = '';
  for (const view of ['today', 'week', 'settings']) {
    await page.evaluate(v => showView(v), view);
    await page.waitForTimeout(80);
    text += await page.evaluate(v => document.getElementById(`view-${v}`)?.innerText || '', view);
  }
  await page.evaluate(() => showView('today'));
  return text;
}

// ═══════════════════════════════════════════════════════════════════════════
// Direct A -> empty B (the reproduced leak), all three stores at once
// ═══════════════════════════════════════════════════════════════════════════

test('direct A -> empty B: zero A entries/settings/templates/plans written into B, none shown as B; A slots and legacy keys untouched', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  expect(await shown(page)).toMatchObject({ room: A, entries: ['A-private entry'], deepGoal: 37, timezone: 'Asia/Tokyo', templates: ['A-private template'], plan: ['A-private task'] });
  // A's facts really reached A's room (so the switch has something to leak).
  const aRoom = await page.evaluate(A => window.__fbTest.get(`rooms/${A}`), A);
  expect(JSON.stringify(aRoom)).toMatch(/A-private entry/);
  expect(JSON.stringify(aRoom)).toMatch(/A-private task/);
  expect(JSON.stringify(aRoom.settings)).toMatch(/"deepGoal":37/);
  const aSlots = await slots(page, A);

  await switchTo(page, 'account-b');

  const ws = await writesSinceMark(page);
  expect(matching(writesUnder(ws, B), A_MARK)).toEqual([]);
  expect(await page.evaluate(B => JSON.stringify(window.__fbTest.get(`rooms/${B}`)), B)).not.toMatch(A_MARK);
  expect(await page.evaluate(B => JSON.stringify(window.__fbTest.get(B)), B)).not.toMatch(A_MARK); // uid_B/public, uid_B/shared
  const b = await shown(page);
  expect(b).toMatchObject({ room: B, entries: [], deepGoal: 20, templates: [], plan: [] });
  expect(b.timezone).not.toBe('Asia/Tokyo');
  expect(b.windowTimezone).toBe(b.timezone);
  expect(await visibleTextAcrossViews(page)).not.toMatch(/A-private|LEGACY-unowned/);
  // A's scoped slots are exactly as A left them; the unowned legacy keys were neither read nor changed.
  expect(await slots(page, A)).toEqual(aSlots);
  expect(await legacyKeys(page)).toEqual(LEGACY);
  expect(matching(await allWrites(page), LEGACY_MARK)).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// A -> B with B history
// ═══════════════════════════════════════════════════════════════════════════

test('A -> B with B history: B hydrates B only, B cloud stays B-authoritative (no overwrite, no merge), A slots untouched', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  await seedBRoom(page);
  const bBefore = await page.evaluate(B => window.__fbTest.get(`rooms/${B}`), B);
  const aSlots = await slots(page, A);

  await switchTo(page, 'account-b');

  const ws = await writesSinceMark(page);
  expect(matching(writesUnder(ws, B), A_MARK)).toEqual([]);
  const bAfter = await page.evaluate(B => window.__fbTest.get(`rooms/${B}`), B);
  // settings, templates and plans in B's room are byte-identical: A overwrote nothing, merged nothing.
  expect(bAfter.settings).toEqual(bBefore.settings);
  expect(bAfter.templates).toEqual(bBefore.templates);
  expect(bAfter.templatesSavedAt).toEqual(bBefore.templatesSavedAt);
  expect(bAfter.plans).toEqual(bBefore.plans);
  expect(Object.keys(bAfter.entries)).toEqual(['e_222222']);
  expect(await shown(page)).toMatchObject({ room: B, entries: ['B-own entry'], deepGoal: 11, timezone: 'Europe/London', templates: ['B-own template'], plan: ['B-own task'] });
  // B's hydration landed in B's slot — never in A's.
  expect(await slots(page, A)).toEqual(aSlots);
  expect((await slots(page, B))['ta3-plans']).toMatch(/B-own task/);
  expect((await slots(page, B))['ta3-tz']).toBe('Europe/London');
  expect(await visibleTextAcrossViews(page)).not.toMatch(/A-private|LEGACY-unowned/);
});

test('legacy plans: an ordinary B edit after the switch transacts B tasks only into B\'s plan', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  await seedBRoom(page);
  await switchTo(page, 'account-b');
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; document.getElementById('plan-task').value = 'B-own new task'; addPlanItem(); });
  await settle(page);
  const planWrites = (await writesSinceMark(page)).filter(w => w.path.includes('/plans/'));
  expect(planWrites.map(w => w.path)).toEqual([`rooms/${B}/plans/${TODAY}`]);
  expect(planWrites[0].value.items.map(i => i.task).sort()).toEqual(['B-own new task', 'B-own task']);
  expect(await shown(page)).toMatchObject({ plan: ['B-own new task', 'B-own task'] });
  // The A task is still A's, in A's slot and A's room only.
  expect((await slots(page, A))['ta3-plans']).toMatch(/A-private task/);
  expect(JSON.stringify(await page.evaluate(A => window.__fbTest.get(`rooms/${A}/plans`), A))).not.toMatch(/B-own/);
});

test('settings/templates: B edits after the switch write B settings into B\'s room only; A\'s room never receives B state', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  await seedBRoom(page);
  await switchTo(page, 'account-b');
  await page.evaluate(async () => {
    window.__mark = window.__fbTest.log.writes.length;
    document.getElementById('set-deepgoal').value = '12'; saveSettings();
    settings.templates = [...settings.templates, { id: 'tB2', activity: 'B-own second template', energy: 'deep', days: [1], startTime: '16:00', endTime: '17:00', enabled: true }];
    persist(); await syncTemplates();
  });
  await settle(page);
  const ws = await writesSinceMark(page);
  expect(ws.every(w => w.path.startsWith(`rooms/${B}/`))).toBe(true);
  expect(matching(ws, A_MARK)).toEqual([]);
  const bRoom = await page.evaluate(B => window.__fbTest.get(`rooms/${B}`), B);
  expect(bRoom.settings.deepGoal).toBe(12);
  expect(bRoom.templates.map(t => t.activity).sort()).toEqual(['B-own second template', 'B-own template']);
  expect(JSON.stringify(await page.evaluate(A => window.__fbTest.get(`rooms/${A}`), A))).not.toMatch(B_MARK);
});

// ═══════════════════════════════════════════════════════════════════════════
// A -> B -> A
// ═══════════════════════════════════════════════════════════════════════════

test('A -> B -> A: A state (entries, settings, timezone pin, templates, plans, sync metadata) restored; B unchanged; no cross-room write either way', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  await seedBRoom(page);
  const aSlots = await slots(page, A);
  await page.evaluate(() => { window.__start = window.__fbTest.log.writes.length; });

  await switchTo(page, 'account-b');
  const bRoomAfterB = await page.evaluate(B => window.__fbTest.get(`rooms/${B}`), B);
  const bSlots = await slots(page, B);
  await switchTo(page, 'account-a');

  expect(await shown(page)).toMatchObject({ room: A, entries: ['A-private entry'], deepGoal: 37, timezone: 'Asia/Tokyo', windowTimezone: 'Asia/Tokyo', templates: ['A-private template'], plan: ['A-private task'] });
  const aNow = await slots(page, A);
  // Content identical; only A's own last-sync marker may advance on reconnect.
  expect({ ...aNow, 'ta3-last-sync': null }).toEqual({ ...aSlots, 'ta3-last-sync': null });
  expect(await slots(page, B)).toMatchObject({ 'ta3-entries': bSlots['ta3-entries'], 'ta3-settings': bSlots['ta3-settings'], 'ta3-plans': bSlots['ta3-plans'], 'ta3-tz': 'Europe/London' });
  const ws = await page.evaluate(() => window.__fbTest.log.writes.slice(window.__start));
  expect(matching(writesUnder(ws, B), A_MARK)).toEqual([]);
  expect(matching(writesUnder(ws, A), B_MARK)).toEqual([]);
  expect(await page.evaluate(B => window.__fbTest.get(`rooms/${B}`), B)).toEqual(bRoomAfterB);
  const aRoom = await page.evaluate(A => window.__fbTest.get(`rooms/${A}`), A);
  expect(JSON.stringify(aRoom)).not.toMatch(B_MARK);
  // No duplicate A entry anywhere.
  expect(Object.keys(aRoom.entries)).toEqual(['e_111111']);
  expect(await visibleTextAcrossViews(page)).not.toMatch(/B-own|LEGACY-unowned/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Direct wrong-room push attempts
// ═══════════════════════════════════════════════════════════════════════════

test('a push whose target room is not the one owning local state is refused for entries, settings, templates and plans', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  const result = await page.evaluate(async ({ B, TODAY }) => {
    const realRef = fbRoomRef;
    fbRoomRef = fbDb.ref(`rooms/${B}`); // points at B while A's state is in memory
    window.__mark = window.__fbTest.log.writes.length;
    const r = { entries: await syncEntries(), templates: await syncTemplates(), plans: await syncPlans(TODAY) };
    syncSettings(); pushSettings();
    await new Promise(res => setTimeout(res, 100));
    const writes = window.__fbTest.log.writes.slice(window.__mark);
    fbRoomRef = realRef;
    return { r, writes };
  }, { B, TODAY });
  expect(result.r).toEqual({ entries: false, templates: false, plans: false });
  expect(result.writes).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale async operations begun under A
// ═══════════════════════════════════════════════════════════════════════════

test('stale async: a settings read, a plan transaction retry and a late listener delivery begun under A never resume as B', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  await seedBRoom(page);
  // Begin under A: a syncSettings() read and a legacy-plan transaction, both still in flight.
  await page.evaluate(({ A }) => {
    window.__fbTest.holdReads(`rooms/${A}/settings`);
    window.__fbTest.holdTransactions(true);
    settings._savedAt = Date.now() + 5000; // A's local settings are "newer" — the case that used to push
    syncSettings();
    document.getElementById('plan-task').value = 'A-private late task'; addPlanItem();
    window.__planInFlight = true;
  }, { A });
  await switchTo(page, 'account-b');
  const bSlotsBefore = await slots(page, B);
  await page.evaluate(({ A }) => {
    window.__mark = window.__fbTest.log.writes.length;
    window.__fbTest.holdTransactions(false);
    window.__fbTest.releaseReads();
    window.__fbTest.releaseTransactions();
    // A listener from A's session delivering after the switch (as a late network event would).
    window.__fbTest.remoteWrite(`rooms/${A}/entries/e_333333`, { id: 333333, ts: Date.now(), tsStart: Date.now() - 60000, date: '2026-09-24', activity: 'A-private late entry', energy: 'deep', blockIntervalMin: 1, updatedAt: Date.now() });
    ['entries', 'settings', 'templates', 'plans'].forEach(p => window.__fbTest.fireLate(`rooms/${A}/${p}`));
  }, { A });
  await settle(page);
  const ws = await writesSinceMark(page);
  expect(ws.filter(w => w.path !== `rooms/${A}/entries/e_333333`)).toEqual([]); // the retry aborted; the settings read pushed nothing
  expect(await shown(page)).toMatchObject({ room: B, entries: ['B-own entry'], deepGoal: 11, templates: ['B-own template'], plan: ['B-own task'] });
  expect(await slots(page, B)).toMatchObject({ 'ta3-entries': bSlotsBefore['ta3-entries'], 'ta3-settings': bSlotsBefore['ta3-settings'], 'ta3-plans': bSlotsBefore['ta3-plans'] });
  expect(JSON.stringify(await slots(page, B))).not.toMatch(A_MARK);
});

test('stale async: a settings read begun under A (A has no remote settings) that answers after the switch pushes nothing — B\'s state never lands in A\'s room', async ({ page }) => {
  await openApp(page);
  await seedBRoom(page);
  await page.evaluate(({ A }) => {
    window.__fbTest.seed(`rooms/${A}/settings`, null); // A's room holds no settings when the read answers
    window.__fbTest.holdReads(`rooms/${A}/settings`); syncSettings();
  }, { A });
  await switchTo(page, 'account-b');
  expect((await shown(page)).deepGoal).toBe(11);
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; window.__fbTest.releaseReads(); });
  await settle(page);
  expect(writesUnder(await writesSinceMark(page), A)).toEqual([]);
  expect(await page.evaluate(A => window.__fbTest.get(`rooms/${A}/settings`), A)).toBeNull();
});

test('stale undo: an undo snapshot captured under A cannot restore or tombstone A entries into B', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { rememberRestoreEntriesUndo('edit', [{ id: 444444, ts: Date.now(), tsStart: Date.now() - 60000, date: '2026-09-24', activity: 'A-private undo snapshot', energy: 'deep', blockIntervalMin: 1 }]); });
  await switchTo(page, 'account-b');
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; undoLastAction(); });
  await settle(page);
  expect(matching(await writesSinceMark(page), A_MARK)).toEqual([]);
  expect((await shown(page)).entries).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Sync metadata ownership (local version / last-sync markers)
// ═══════════════════════════════════════════════════════════════════════════

test('sync metadata: A\'s local-version / last-sync markers can neither cause nor suppress B\'s reconnect push', async ({ page }) => {
  // B has a pending offline entry on this device (lv > last-sync); A has everything synced (lv <= last-sync).
  const pendingB = { id: 555555, ts: NOW - 100000, tsStart: NOW - 400000, date: TODAY, activity: 'B-own pending entry', energy: 'deep', blockIntervalMin: 5, updatedAt: NOW - 100000 };
  await openApp(page, { scoped: {
    [`ta3-entries:${B}`]: JSON.stringify([pendingB]), [`ta3-lv:${B}`]: String(NOW), [`ta3-last-sync:${B}`]: '1', [`ta3-tz:${B}`]: 'Asia/Manila',
    [`ta3-entries:${A}`]: '[]', [`ta3-lv:${A}`]: '1', [`ta3-last-sync:${A}`]: String(NOW + 999999), [`ta3-tz:${A}`]: 'Asia/Manila',
    // Unowned device-wide markers that WOULD suppress the push if anything still consulted them.
    'ta3-lv': '0', 'ta3-last-sync': String(NOW + 999999),
  } });
  const aMeta = await page.evaluate(A => [localStorage.getItem(`ta3-lv:${A}`), localStorage.getItem(`ta3-last-sync:${A}`)], A);
  await page.evaluate(() => { window.__fbTest.setConnected(false); window.__fbTest.setFailWrites(true); });
  await switchTo(page, 'account-b');
  // Offline: B shows B's pending entry only.
  expect((await shown(page)).entries).toEqual(['B-own pending entry']);
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; window.__fbTest.setFailWrites(false); window.__fbTest.setConnected(true); });
  await settle(page);
  const ws = await writesSinceMark(page);
  expect(ws.filter(w => w.path === `rooms/${B}/entries/e_555555`).length).toBeGreaterThan(0); // not suppressed by A's markers
  expect(writesUnder(ws, A)).toEqual([]);
  expect(await page.evaluate(A => [localStorage.getItem(`ta3-lv:${A}`), localStorage.getItem(`ta3-last-sync:${A}`)], A)).toEqual(aMeta);
  // The unowned global markers were never consulted or rewritten.
  expect(await page.evaluate(() => [localStorage.getItem('ta3-lv'), localStorage.getItem('ta3-last-sync')])).toEqual(['0', String(NOW + 999999)]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Offline account switch
// ═══════════════════════════════════════════════════════════════════════════

test('offline A -> B, no B cache: B never sees A; reconnect converges nothing of A into B; back to A, A\'s pending work is intact and pushes to A', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  // A logs an entry and edits a plan while offline — both pushes fail.
  await page.evaluate(() => { window.__fbTest.setConnected(false); window.__fbTest.setFailWrites(true); });
  await page.evaluate(async () => {
    entries.unshift({ id: 111112, ts: Date.now() - 1000, tsStart: Date.now() - 61000, date: '2026-09-24', activity: 'A-private offline entry', energy: 'deep', blockIntervalMin: 1, updatedAt: Date.now() - 1000 });
    persist(); await syncEntries();
  });
  await switchTo(page, 'account-b');
  expect(await shown(page)).toMatchObject({ room: B, entries: [], plan: [], templates: [], deepGoal: 20 });
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; window.__fbTest.setFailWrites(false); window.__fbTest.setConnected(true); });
  await settle(page);
  expect(matching(writesUnder(await writesSinceMark(page), B), A_MARK)).toEqual([]);
  expect(await page.evaluate(B => JSON.stringify(window.__fbTest.get(`rooms/${B}`)), B)).not.toMatch(A_MARK);
  // Return to A: the offline entry is still pending in A's slot and converges into A's room only.
  await switchTo(page, 'account-a');
  expect((await shown(page)).entries).toEqual(['A-private entry', 'A-private offline entry']);
  const aWrites = writesUnder(await writesSinceMark(page), A);
  expect(aWrites.some(w => w.path === `rooms/${A}/entries/e_111112`)).toBe(true);
});

test('offline A -> B with a prior B cache: B only; reconnect converges only B state into B', async ({ page }) => {
  const pendingB = { id: 555556, ts: NOW - 100000, tsStart: NOW - 400000, date: TODAY, activity: 'B-own cached entry', energy: 'deep', blockIntervalMin: 5, updatedAt: NOW - 100000 };
  await openApp(page, { scoped: {
    [`ta3-entries:${B}`]: JSON.stringify([pendingB]), [`ta3-lv:${B}`]: String(NOW), [`ta3-last-sync:${B}`]: '1',
    [`ta3-settings:${B}`]: JSON.stringify({ deepGoal: 11, templates: [bTemplate], _savedAt: NOW - 50, _templatesSavedAt: NOW - 50 }), [`ta3-tz:${B}`]: 'Europe/London',
    [`ta3-plans:${B}`]: JSON.stringify({ [TODAY]: { items: [planItem('pBown', 'B-own task')], updatedAt: NOW - 5000 } }),
  } });
  await createAccountAFacts(page);
  await page.evaluate(() => { window.__fbTest.setConnected(false); window.__fbTest.setFailWrites(true); });
  await switchTo(page, 'account-b');
  expect(await shown(page)).toMatchObject({ room: B, entries: ['B-own cached entry'], deepGoal: 11, timezone: 'Europe/London', templates: ['B-own template'], plan: ['B-own task'] });
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; window.__fbTest.setFailWrites(false); window.__fbTest.setConnected(true); });
  await settle(page);
  const ws = await writesSinceMark(page);
  expect(matching(writesUnder(ws, B), A_MARK)).toEqual([]);
  expect(ws.some(w => w.path === `rooms/${B}/entries/e_555556`)).toBe(true);
  const bRoom = await page.evaluate(B => window.__fbTest.get(`rooms/${B}`), B);
  expect(bRoom.settings.deepGoal).toBe(11);
  expect(JSON.stringify(bRoom)).not.toMatch(A_MARK);
});

// ═══════════════════════════════════════════════════════════════════════════
// Sign-out
// ═══════════════════════════════════════════════════════════════════════════

test('sign-out: no account state stays current, later callbacks cannot write, owner is absent, scoped slots and legacy keys remain', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  await page.evaluate(({ A }) => {
    window.__fbTest.holdReads(`rooms/${A}/settings`);
    window.__fbTest.holdTransactions(true);
    settings._savedAt = Date.now() + 5000; syncSettings();
    document.getElementById('plan-task').value = 'A-private in-flight task'; addPlanItem();
  }, { A });
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; window.__fbTest.signOut(); });
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode() === '');
  const aSlots = await slots(page, A); // as A left it, in-flight work included — sign-out must not change it
  await page.evaluate(({ A }) => {
    window.__fbTest.holdTransactions(false); window.__fbTest.releaseReads(); window.__fbTest.releaseTransactions();
    ['entries', 'settings', 'templates', 'plans'].forEach(p => window.__fbTest.fireLate(`rooms/${A}/${p}`));
  }, { A });
  await settle(page);
  expect(await writesSinceMark(page)).toEqual([]);
  const s = await shown(page);
  expect(s).toMatchObject({ room: '', entries: [], templates: [], plan: [], deepGoal: 20 });
  // Nothing persisted for "no account": a local save is refused and no unowned slot is created or changed.
  const refused = await page.evaluate(() => { persist(); try { writeDatePlanLocal('2026-09-24', { items: [] }); return false; } catch { return true; } });
  expect(refused).toBe(true);
  expect(await slots(page, A)).toEqual(aSlots);
  expect(await legacyKeys(page)).toEqual(LEGACY);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => /^ta3-(entries|settings|plans|tz|lv|last-sync):$/.test(k)))).toEqual([]);
  // Signing back in as A restores A.
  await switchTo(page, 'account-a');
  // (the in-flight task was A's own local save before sign-out — it stays A's)
  expect(await shown(page)).toMatchObject({ room: A, entries: ['A-private entry'], deepGoal: 37, plan: ['A-private in-flight task', 'A-private task'] });
});

// ═══════════════════════════════════════════════════════════════════════════
// Same-account reconnect still converges
// ═══════════════════════════════════════════════════════════════════════════

test('same-account reconnect: A\'s offline entry, settings and template changes converge into A\'s room; a later plan save carries A\'s offline plan item', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  await page.evaluate(async () => {
    window.__fbTest.setConnected(false); window.__fbTest.setFailWrites(true);
    entries.unshift({ id: 111113, ts: Date.now() - 1000, tsStart: Date.now() - 61000, date: '2026-09-24', activity: 'A-private reconnect entry', energy: 'deep', blockIntervalMin: 1, updatedAt: Date.now() - 1000 });
    persist(); await syncEntries();
    document.getElementById('set-deepgoal').value = '38'; settings._savedAt = Date.now() + 10; saveSettings(); settings._savedAt = Date.now() + 10; persist();
    settings.templates = [...settings.templates, { id: 'tA2', activity: 'A-private offline template', energy: 'deep', days: [2], startTime: '11:00', endTime: '12:00', enabled: true }];
    settings._templatesSavedAt = Date.now() + 20; persist(); await syncTemplates();
    document.getElementById('plan-task').value = 'A-private offline plan item'; addPlanItem();
  });
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; window.__fbTest.setFailWrites(false); window.__fbTest.setConnected(true); });
  await settle(page);
  const aRoom = await page.evaluate(A => window.__fbTest.get(`rooms/${A}`), A);
  expect(aRoom.entries.e_111113.activity).toBe('A-private reconnect entry');
  expect(aRoom.settings.deepGoal).toBe(38);
  expect(aRoom.templates.map(t => t.activity).sort()).toEqual(['A-private offline template', 'A-private template']);
  // Legacy plans have no reconnect replay of their own (unchanged contract): the next same-date save
  // transacts the whole local plan, so the offline item is not lost.
  await page.evaluate(() => { document.getElementById('plan-task').value = 'A-private after-reconnect item'; addPlanItem(); });
  await settle(page);
  const plan = await page.evaluate(({ A, TODAY }) => window.__fbTest.get(`rooms/${A}/plans/${TODAY}`), { A, TODAY });
  expect(plan.items.map(i => i.task).sort()).toEqual(['A-private after-reconnect item', 'A-private offline plan item', 'A-private task']);
});

// ═══════════════════════════════════════════════════════════════════════════
// Deletes / tombstones stay with their account
// ═══════════════════════════════════════════════════════════════════════════

test('entry tombstones stay same-account: A\'s delete never reaches B, even for a B entry with the same id', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  // B happens to hold an entry with the SAME id as A's.
  await page.evaluate(({ B }) => window.__fbTest.seed(`rooms/${B}/entries/e_111111`, { id: 111111, ts: Date.now() - 900000, tsStart: Date.now() - 1000000, date: '2026-09-24', activity: 'B-own same-id entry', energy: 'shallow', blockIntervalMin: 5, updatedAt: Date.now() - 900000 }), { B });
  // A deletes its entry (the Week/Settings "clear day" path tombstones it).
  await page.evaluate(() => { window.confirm = () => true; document.getElementById('clear-day-select').innerHTML = '<option value="2026-09-24">x</option>'; document.getElementById('clear-day-select').value = '2026-09-24'; clearSelectedDay(); });
  await settle(page);
  expect((await page.evaluate(A => window.__fbTest.get(`rooms/${A}/entries/e_111111`), A)).deleted).toBe(true);
  await switchTo(page, 'account-b');
  const bEntryNow = await page.evaluate(B => window.__fbTest.get(`rooms/${B}/entries/e_111111`), B);
  expect(bEntryNow.deleted).toBeUndefined();
  expect(bEntryNow.activity).toBe('B-own same-id entry');
  expect((await shown(page)).entries).toEqual(['B-own same-id entry']);
  expect(matching(writesUnder(await writesSinceMark(page), B), /"deleted":true/)).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Unowned pre-scoping data and device-local keys
// ═══════════════════════════════════════════════════════════════════════════

test('unowned pre-scoping entries/settings/templates/plans/timezone are never adopted, shown or uploaded — not even for the first account on the device', async ({ page }) => {
  await openApp(page); // A signs in with NO scoped slots; only the unowned legacy keys exist
  const a = await shown(page);
  expect(a).toMatchObject({ room: A, entries: [], templates: [], plan: [], deepGoal: 20 });
  expect(a.timezone).not.toBe('Pacific/Auckland');
  expect(await visibleTextAcrossViews(page)).not.toMatch(/LEGACY-unowned/);
  await createAccountAFacts(page);
  await switchTo(page, 'account-b');
  expect(matching(await allWrites(page), LEGACY_MARK)).toEqual([]);
  expect(await legacyKeys(page)).toEqual(LEGACY);
});

test('A\'s cloud history hydrates back into A\'s fresh scoped slot (records durable in the right account are not lost)', async ({ page }) => {
  await openApp(page, { beforeAuth: async () => {} });
  // Simulate an upgraded device: A's room already holds A's history; A's scoped slots do not exist yet.
  await page.evaluate(({ A, aEntry, aTemplate, TODAY }) => {
    window.__fbTest.remoteWrite(`rooms/${A}/entries/e_${aEntry.id}`, aEntry);
    window.__fbTest.remoteWrite(`rooms/${A}/settings`, { deepGoal: 37, timezone: 'Asia/Tokyo', templates: [aTemplate], _savedAt: Date.now() - 10, _templatesSavedAt: Date.now() - 10 });
    window.__fbTest.remoteWrite(`rooms/${A}/plans/${TODAY}`, { items: [{ id: 'pAprivate', task: 'A-private task', when: '', done: false, doneAt: null, updatedAt: Date.now() - 10, updatedBy: 'x' }], updatedAt: Date.now() - 10 });
  }, { A, aEntry, aTemplate, TODAY });
  await settle(page);
  expect(await shown(page)).toMatchObject({ room: A, entries: ['A-private entry'], deepGoal: 37, timezone: 'Asia/Tokyo', templates: ['A-private template'], plan: ['A-private task'] });
  const aSlots = await slots(page, A);
  expect(aSlots['ta3-entries']).toMatch(/A-private entry/);
  expect(aSlots['ta3-settings']).toMatch(/"deepGoal":37/);
  expect(aSlots['ta3-plans']).toMatch(/A-private task/);
  expect(aSlots['ta3-tz']).toBe('Asia/Tokyo');
  expect(await legacyKeys(page)).toEqual(LEGACY);
});

test('device-local keys (device id, onboarding) are unchanged by switches — they are not account settings', async ({ page }) => {
  await openApp(page);
  const before = await page.evaluate(() => [localStorage.getItem('ta3-device-id'), localStorage.getItem('ta3-onboarded')]);
  await createAccountAFacts(page);
  await switchTo(page, 'account-b');
  await switchTo(page, 'account-a');
  expect(await page.evaluate(() => [localStorage.getItem('ta3-device-id'), localStorage.getItem('ta3-onboarded')])).toEqual(before);
});

// ═══════════════════════════════════════════════════════════════════════════
// Reload: the scoped slots are what a fresh page load binds
// ═══════════════════════════════════════════════════════════════════════════

test('reload as B after A used the device: B loads B\'s slot only; A\'s data is not visible and not pushed', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  await page.evaluate(() => { window.__initialUid = 'account-b'; });
  await page.addInitScript(() => { window.__initialUid = 'account-b'; });
  await page.reload();
  await page.waitForFunction(B => !!window.__fbTest && globalThis.getChronaSenseRoomCode?.() === B, B);
  await settle(page);
  expect(await shown(page)).toMatchObject({ room: B, entries: [], templates: [], plan: [], deepGoal: 20 });
  expect(matching(writesUnder(await allWrites(page), B), A_MARK)).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Operational plan authority is untouched
// ═══════════════════════════════════════════════════════════════════════════

test('operational-plan authority unaffected: the switch neither creates nor alters operational-plan or boundary caches with another account\'s data', async ({ page }) => {
  await openApp(page);
  await createAccountAFacts(page);
  const aOp = await page.evaluate(A => [localStorage.getItem(`ta3-operational-plans-v1:${A}`), localStorage.getItem(`ta3-day-boundary-revisions-v1:${A}`)], A);
  await switchTo(page, 'account-b');
  const bOp = await page.evaluate(B => [localStorage.getItem(`ta3-operational-plans-v1:${B}`), localStorage.getItem(`ta3-day-boundary-revisions-v1:${B}`)], B);
  expect(JSON.stringify(bOp)).not.toMatch(A_MARK);
  // Legacy-governed day for B: the authority serves B's (empty) legacy plan, never A's.
  expect(await page.evaluate(() => (globalThis.PlanAuthority?.itemsFor?.(currentPlanTarget()) || getPlanItems(planTodayKey())).map(i => i.task))).toEqual([]);
  await switchTo(page, 'account-a');
  expect(await page.evaluate(A => [localStorage.getItem(`ta3-operational-plans-v1:${A}`), localStorage.getItem(`ta3-day-boundary-revisions-v1:${A}`)], A)).toEqual(aOp);
});
