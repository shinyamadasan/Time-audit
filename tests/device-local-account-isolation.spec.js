// Device-Local Account Isolation V1 — Learning Plans, Capability/Career, Daily Routines, daily reviews
// and weekly reviews across account switches, in a real browser.
//
// Nothing is faked except Firebase: the page's own storage.js receives onAuthStateChanged(A), then
// onAuthStateChanged(B) with NO sign-out between (a direct switch), or null (sign-out). The tests only
// OBSERVE what the real runtime modules keep in memory, render (visible or hidden DOM, form values
// included), persist to localStorage, and write into a room-partitioned Firebase fake.
//
// Reproduced on origin/main 7ae7c68 (before this fix), all five stores:
//  - `ta3-learning-plans-v1`, `ta3-capability-career-v1`, `ta3-daily-routines-v1` were one unowned slot
//    per device: B's Learning, Career, Today routines and Life views showed A's plan/skill/routine, and
//    the Learning view kept A's plan in its DOM without any re-render.
//  - `ta3-reviews` / `ta3-weekly-reviews` were one unowned map each, loaded once at boot and merged with
//    whichever room was joined. After A -> B, B's Reflect view listed A's reflections, the weekly forms
//    stayed pre-filled with A's text, and the review modal pre-filled A's fields. B's own save of the same
//    date wrote {win: B, waste: A's text} to rooms/uid_B/reviews/<date>, and merely focusing/blurring a
//    weekly field (autosave) wrote A's weekly review to rooms/uid_B/weeklyReviews/<week>:
//    REMOTE CROSS-ROOM LEAK — PROVEN. The reviews/weeklyReviews listeners had no isCurrentSync() guard,
//    so a late delivery from A's room merged into B, and sign-out left every review in memory.
//
// No real Firebase project, no network, no production data.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningPlan, addPhase, addLesson, addStep } from '../learning-plan-model.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';

const NOW = Date.parse('2026-09-24T08:00:00+08:00');
const A = 'uid_account-a';
const B = 'uid_account-b';

// A room-partitioned, write-recording Firebase stub whose auth, connectivity and async timing the
// test controls. Every write (update/set/transaction/remove) is logged with its absolute path.
// (Same shape as tests/focus-redemption-account-isolation.spec.js's stub — kept local so this spec
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

const LP = 'ta3-learning-plans-v1';
const CC = 'ta3-capability-career-v1';
const DR = 'ta3-daily-routines-v1';
const RV = 'ta3-reviews';
const WR = 'ta3-weekly-reviews';
const T = '2026-01-01T00:00:00.000Z';

let seq = 0;
function learningEnvelope(title, stepTitle, id = 'plan-shared') {
  seq += 1;
  let n = 0;
  const opts = { idGenerator: () => `id-${seq}-${n++}`, clock: () => T };
  let plan = { ...createLearningPlan({ title }, opts), id };
  plan = addPhase(plan, { title: 'Phase' }, opts);
  plan = addLesson(plan, plan.phases[0].id, { title: 'Lesson' }, opts);
  plan = addStep(plan, plan.phases[0].lessons[0].id, { title: stepTitle }, opts);
  return JSON.stringify({ schemaVersion: 1, plans: [plan] });
}
const careerEnvelope = skill => JSON.stringify({ schemaVersion: 1, profile: { schemaVersion: 1, skills: [{ id: 'sk-1', name: skill, category: 'ai', status: 'active', createdAt: T, updatedAt: T }], knowledgeAreas: [], tools: [], careerTargets: [], projects: [], artifacts: [], evidence: [], createdAt: T, updatedAt: T } });
// Same ids in both accounts on purpose (plan-shared, sk-1, routine-1): a stale control or write built for
// one account must never act on the other account's twin record.
const routineEnvelope = title => JSON.stringify({ schemaVersion: 1, timezone: 'UTC', routines: [{ id: 'routine-1', createdDate: '2026-09-01', title, enabled: true, cadence: 'daily', days: [], mode: 'anytime', time: '', endTime: '', cue: '', targetMinutes: 15, minimumMinutes: 5, fallback: '', source: 'manual', planId: '', workoutRoutineId: '' }], manual: {}, links: {}, focus: {}, skips: {} });

const A_SLOTS = {
  [`${LP}:${A}`]: learningEnvelope('A-private plan', 'A-private step'),
  [`${CC}:${A}`]: careerEnvelope('A-private skill'),
  [`${DR}:${A}`]: routineEnvelope('A-private routine'),
};
const B_SLOTS = {
  [`${LP}:${B}`]: learningEnvelope('B-own plan', 'B-own step'),
  [`${CC}:${B}`]: careerEnvelope('B-own skill'),
  [`${DR}:${B}`]: routineEnvelope('B-own routine'),
};
// Pre-scoping data on this device: owner unknown. Must never be adopted, displayed, uploaded, rewritten or deleted.
const LEGACY = {
  [LP]: learningEnvelope('LEGACY-unowned plan', 'LEGACY-unowned step', 'plan-legacy'),
  [CC]: careerEnvelope('LEGACY-unowned skill'),
  [DR]: routineEnvelope('LEGACY-unowned routine'),
  [RV]: JSON.stringify({ '2026-09-01': { win: 'LEGACY-unowned win', _savedAt: 1 } }),
  [WR]: JSON.stringify({ '2026-W36': { overall: 'LEGACY-unowned weekly', savedAt: 1, _savedAt: 1 } }),
};
const A_MARK = /A-private|A-late/;
const B_MARK = /B-own/;
const LEGACY_MARK = /LEGACY-unowned/;

async function openApp(page, { initialUid = 'account-a', slots = A_SLOTS } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ now, legacy, slots, initialUid }) => {
    const RealDate = Date;
    let tick = now;
    window.Date = class MockDate extends RealDate { constructor(...a) { super(...(a.length ? a : [tick])); } static now() { return ++tick; } };
    window.__initialUid = initialUid;
    if (sessionStorage.getItem('dlai-seeded')) return; // reloads keep what the app persisted
    localStorage.clear();
    sessionStorage.setItem('dlai-seeded', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-device-id', 'device-dlai');
    Object.entries(legacy).forEach(([k, v]) => localStorage.setItem(k, v));
    Object.entries(slots).forEach(([k, v]) => localStorage.setItem(k, v));
  }, { now: NOW, legacy: LEGACY, slots, initialUid });
  await page.goto(appUrl);
  await page.waitForFunction(uid => !!window.__fbTest && globalThis.getChronaSenseRoomCode?.() === `uid_${uid}`
    && typeof window.renderLearningPlans === 'function' && typeof window.renderCapabilityCareer === 'function'
    && typeof globalThis.renderDailyRoutines === 'function' && typeof window.renderLifeView === 'function', initialUid);
  await settle(page);
}

const settle = page => page.waitForTimeout(250);

async function switchTo(page, uid) {
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; });
  await page.evaluate(u => window.__fbTest.signInAs(u), uid);
  await page.waitForFunction(u => globalThis.getChronaSenseRoomCode() === `uid_${u}`, uid);
  await settle(page);
}

/** A saves a daily review, a weekly review and next week's plan through the real Reflect paths. */
async function aWritesReflections(page) {
  await page.evaluate(() => {
    openReview(toDateKey(new Date()));
    document.getElementById('rv-win').value = 'A-private win';
    document.getElementById('rv-waste').value = 'A-private waste';
    saveReview();
    showView('reflect'); renderReflectView();
    document.getElementById('wr-overall').value = 'A-private weekly';
    saveWeeklyReview();
    document.getElementById('wp-p1').value = 'A-private priority';
    saveWeeklyPlan();
  });
  await settle(page);
}

/** Shows every surface that renders one of the five stores. */
async function renderAll(page) {
  await page.evaluate(() => {
    showView('learning'); showView('career'); showView('life'); showView('reflect'); renderReflectView();
    showView('today'); window.renderDailyRoutines?.();
  });
  await settle(page);
}

/** Everything the page holds for a user to see: the whole DOM's text (hidden views included) and every form value. */
const pageContent = page => page.evaluate(() => document.body.textContent + '\n' +
  [...document.querySelectorAll('input, textarea')].map(el => el.value).join('\n'));
const memory = page => page.evaluate(() => JSON.stringify({ reviews, weeklyReviews }));
const writesSinceMark = page => page.evaluate(() => window.__fbTest.log.writes.slice(window.__mark || 0));
const writesUnder = (ws, room) => ws.filter(w => w.path.startsWith(`rooms/${room}/`));
const matching = (ws, re) => ws.filter(w => re.test(JSON.stringify(w.value)));
const slots = (page, room) => page.evaluate(({ room, keys }) => Object.fromEntries(keys.map(k => [k, localStorage.getItem(`${k}:${room}`)])), { room, keys: [LP, CC, DR, RV, WR] });
const legacyKeys = page => page.evaluate(keys => Object.fromEntries(keys.map(k => [k, localStorage.getItem(k)])), Object.keys(LEGACY));

// ═══════════════════════════════════════════════════════════════════════════
// A -> empty B (the reproduced exposure, all five stores)
// ═══════════════════════════════════════════════════════════════════════════

test('direct A -> empty B: none of A\'s five stores is visible, derived, held or written as B; A slots and legacy keys untouched', async ({ page }) => {
  await openApp(page);
  await aWritesReflections(page);
  await renderAll(page);
  const shownAsA = await pageContent(page);
  for (const re of [/A-private plan/, /A-private skill/, /A-private routine/, /A-private win/, /A-private weekly/]) expect(shownAsA).toMatch(re); // A really sees its own data
  expect(shownAsA).not.toMatch(LEGACY_MARK);
  const aBefore = await slots(page, A);
  expect(aBefore[RV]).toMatch(/A-private win/);
  expect(aBefore[WR]).toMatch(/A-private weekly/);

  await switchTo(page, 'account-b'); // views are NOT re-shown: whatever the rebind leaves in the DOM is what B sees
  expect(await pageContent(page)).not.toMatch(A_MARK);
  expect(await memory(page)).not.toMatch(A_MARK);
  await renderAll(page);
  const shownAsB = await pageContent(page);
  expect(shownAsB).not.toMatch(A_MARK);
  expect(shownAsB).not.toMatch(LEGACY_MARK);
  expect(await page.evaluate(() => { openReview(toDateKey(new Date())); return ['rv-win', 'rv-waste', 'rv-avoid'].map(id => document.getElementById(id).value).join(''); })).toBe('');
  await page.evaluate(() => closeModal('review-overlay'));

  const bSlots = await slots(page, B);
  expect([bSlots[LP], bSlots[CC], bSlots[DR]]).toEqual([null, null, null]);
  expect(`${bSlots[RV]}${bSlots[WR]}`).not.toMatch(A_MARK);
  expect(await slots(page, A)).toEqual(aBefore);
  expect(await legacyKeys(page)).toEqual(LEGACY);
  expect(matching(writesUnder(await writesSinceMark(page), B), A_MARK)).toEqual([]);
});

test('A -> empty B: B\'s own review and weekly saves carry none of A\'s fields into rooms/uid_B (the proven remote leak)', async ({ page }) => {
  await openApp(page);
  await aWritesReflections(page);
  await switchTo(page, 'account-b');
  await page.evaluate(() => {
    openReview(toDateKey(new Date()));
    document.getElementById('rv-win').value = 'B-own win';
    saveReview();
    showView('reflect'); renderReflectView();
    const el = document.getElementById('wr-drain'); el.focus(); el.value = 'B-own drain'; el.blur(); // the onblur autosave
    document.getElementById('wp-p1').value = 'B-own priority';
    saveWeeklyPlan();
  });
  await settle(page);
  const ws = await writesSinceMark(page);
  const intoB = writesUnder(ws, B);
  expect(matching(intoB, A_MARK)).toEqual([]);
  expect(matching(intoB, /B-own win/)).toHaveLength(1);   // B's legitimate edits still land in B's room
  expect(matching(intoB, /B-own drain/)).toHaveLength(1);
  expect(matching(intoB, /B-own priority/)).toHaveLength(1);
  expect(writesUnder(ws, A)).toEqual([]);
  const room = await page.evaluate(b => window.__fbTest.get(`rooms/${b}`), B);
  expect(JSON.stringify(room)).not.toMatch(A_MARK);
  const stored = await slots(page, B);
  expect(stored[RV]).toMatch(/B-own win/);
  expect(stored[RV]).not.toMatch(A_MARK);
  expect(stored[WR]).toMatch(/B-own drain/);
  expect(stored[WR]).not.toMatch(A_MARK);
});

// ═══════════════════════════════════════════════════════════════════════════
// A -> B with B history; legitimate B editing; A -> B -> A
// ═══════════════════════════════════════════════════════════════════════════

test('A -> B with B history: B sees only B (local slots + remote reflections), no merge, and B can still edit every store', async ({ page }) => {
  await openApp(page, { slots: { ...A_SLOTS, ...B_SLOTS } });
  await aWritesReflections(page);
  await page.evaluate(b => {
    window.__fbTest.seed(`rooms/${b}/reviews/2026-09-20`, { win: 'B-own remote win', _savedAt: 5 });
    window.__fbTest.seed(`rooms/${b}/weeklyReviews/2026-W38`, { overall: 'B-own remote weekly', savedAt: 5, _savedAt: 5 });
  }, B);
  const bBefore = await slots(page, B);
  await switchTo(page, 'account-b');
  await renderAll(page);
  const shown = await pageContent(page);
  for (const re of [/B-own plan/, /B-own skill/, /B-own routine/, /B-own remote win/, /B-own remote weekly/]) expect(shown).toMatch(re);
  expect(shown).not.toMatch(A_MARK);
  expect(await memory(page)).not.toMatch(A_MARK);
  const hydrated = await slots(page, B);
  expect(hydrated[RV]).toMatch(/B-own remote win/);   // remote hydration lands in B's new scoped slot
  expect(hydrated[WR]).toMatch(/B-own remote weekly/);
  for (const k of [LP, CC, DR]) expect(hydrated[k]).toBe(bBefore[k]); // no merge, no overwrite

  // Legitimate B editing: a manual routine Done through the real Today control, a step completed through
  // the real Learning Plan checkbox, and a skill added through the real Career form.
  // A programmatic click still runs the real delegated Today handler (the compact Today layout keeps the
  // full list inside a collapsed section, so Playwright's visibility check is not what is under test here).
  await page.evaluate(() => { showView('today'); document.querySelector('#daily-routines-list [data-routine-action="done"]').click(); });
  await page.evaluate(() => showView('learning'));
  await page.evaluate(() => { const box = document.querySelector('#learning-plan-main input[data-lp-action="toggle-step"]'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.evaluate(() => { showView('career'); document.querySelector('[data-cc-action="open-panel"][data-panel="skill"]').click(); });
  await page.locator('form[data-cc-form="skill"] [name="name"]').fill('B-own second skill');
  await page.evaluate(() => document.querySelector('form[data-cc-form="skill"]').requestSubmit());
  await settle(page);
  const edited = await slots(page, B);
  expect(Object.keys(JSON.parse(edited[DR]).manual)).toHaveLength(1);
  expect(JSON.parse(edited[LP]).plans[0].phases[0].lessons[0].steps[0].completed).toBe(true);
  expect(edited[CC]).toMatch(/B-own second skill/);
  for (const k of [LP, CC, DR]) expect(edited[k]).not.toMatch(A_MARK);
  expect(await slots(page, A)).toMatchObject({ [LP]: A_SLOTS[`${LP}:${A}`], [CC]: A_SLOTS[`${CC}:${A}`], [DR]: A_SLOTS[`${DR}:${A}`] });
  expect(await legacyKeys(page)).toEqual(LEGACY);
});

test('A -> B -> A: A restores exactly, B keeps only its own edits, nothing duplicated or lost', async ({ page }) => {
  await openApp(page, { slots: { ...A_SLOTS, ...B_SLOTS } });
  await aWritesReflections(page);
  const aBefore = await slots(page, A);
  await switchTo(page, 'account-b');
  await page.evaluate(() => { openReview(toDateKey(new Date())); document.getElementById('rv-win').value = 'B-own win'; saveReview(); });
  await settle(page);
  const bAfterEdit = await slots(page, B);
  await switchTo(page, 'account-a');
  await renderAll(page);
  expect(await slots(page, A)).toEqual(aBefore);
  expect(await slots(page, B)).toEqual(bAfterEdit);
  const shown = await pageContent(page);
  for (const re of [/A-private plan/, /A-private skill/, /A-private routine/, /A-private win/, /A-private weekly/]) expect(shown).toMatch(re);
  expect(shown).not.toMatch(B_MARK);
  expect(await memory(page)).not.toMatch(B_MARK);
  expect(await page.evaluate(() => Object.keys(reviews).length)).toBe(1); // A's one review, not duplicated
  expect(await page.evaluate(() => { openReview(toDateKey(new Date())); return document.getElementById('rv-waste').value; })).toBe('A-private waste');
  expect(matching(writesUnder(await writesSinceMark(page), A), B_MARK)).toEqual([]);
  expect(await legacyKeys(page)).toEqual(LEGACY);
});

// ═══════════════════════════════════════════════════════════════════════════
// Sign-out, late callbacks, offline
// ═══════════════════════════════════════════════════════════════════════════

test('sign-out: no account-owned state stays active, writes are refused, slots and legacy keys stay stored, late callbacks are inert', async ({ page }) => {
  await openApp(page);
  await aWritesReflections(page);
  await renderAll(page);
  const aBefore = await slots(page, A);
  await page.evaluate(() => { window.__mark = window.__fbTest.log.writes.length; window.__fbTest.signOut(); });
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode() === '');
  await settle(page);
  expect(await pageContent(page)).not.toMatch(A_MARK);
  expect(await memory(page)).toBe(JSON.stringify({ reviews: {}, weeklyReviews: {} }));
  // A late delivery from A's room, after sign-out, must not repopulate anything.
  await page.evaluate(a => {
    window.__fbTest.seed(`rooms/${a}/reviews/2026-09-19`, { win: 'A-late win', _savedAt: 9e12 });
    window.__fbTest.seed(`rooms/${a}/weeklyReviews/2026-W37`, { overall: 'A-late weekly', savedAt: 9e12, _savedAt: 9e12 });
    window.__fbTest.fireLate(`rooms/${a}/reviews`); window.__fbTest.fireLate(`rooms/${a}/weeklyReviews`);
  }, A);
  expect(await memory(page)).toBe(JSON.stringify({ reviews: {}, weeklyReviews: {} }));
  const refused = await page.evaluate(async () => {
    const out = [];
    for (const [mod, fn] of [['./learning-plan-repository.js', m => m.createLearningPlanRepository().removePlan('plan-shared')],
      ['./capability-career-repository.js', m => m.createCapabilityCareerRepository().saveProfile(m.createCapabilityCareerRepository().loadProfile())],
      ['./daily-routines-repository.js', m => m.createDailyRoutineRepository().update('UTC', () => {})]]) {
      try { fn(await import(mod)); out.push('written'); } catch { out.push('refused'); }
    }
    saveReview(); saveWeeklyReview(); saveWeeklyPlan();
    return out;
  });
  expect(refused).toEqual(['refused', 'refused', 'refused']);
  expect(await slots(page, A)).toEqual(aBefore);
  expect(await legacyKeys(page)).toEqual(LEGACY);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => /:(null|undefined)?$/.test(k)))).toEqual([]);
  expect(await writesSinceMark(page)).toEqual([]);
});

test('late A reviews / weeklyReviews deliveries after a direct switch to B never reach B\'s memory, slot or room', async ({ page }) => {
  await openApp(page);
  await switchTo(page, 'account-b');
  await page.evaluate(a => {
    window.__fbTest.seed(`rooms/${a}/reviews/2026-09-19`, { win: 'A-late win', _savedAt: 9e12 });
    window.__fbTest.seed(`rooms/${a}/weeklyReviews/2026-W37`, { overall: 'A-late weekly', savedAt: 9e12, _savedAt: 9e12 });
    window.__fbTest.fireLate(`rooms/${a}/reviews`); window.__fbTest.fireLate(`rooms/${a}/weeklyReviews`);
  }, A);
  await settle(page);
  expect(await memory(page)).not.toMatch(A_MARK);
  const b = await slots(page, B);
  expect(`${b[RV]}${b[WR]}`).not.toMatch(A_MARK);
  expect(matching(writesUnder(await writesSinceMark(page), B), A_MARK)).toEqual([]);
});

test('offline: A\'s offline review stays in A\'s slot, B never inherits it, and A has it again on return', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    window.addEventListener('unhandledrejection', e => e.preventDefault()); // the fake rejects offline writes
    window.__fbTest.setConnected(false); window.__fbTest.setFailWrites(true);
    openReview(toDateKey(new Date())); document.getElementById('rv-win').value = 'A-private offline win'; saveReview();
  });
  await settle(page);
  expect((await slots(page, A))[RV]).toMatch(/A-private offline win/);
  await switchTo(page, 'account-b');
  await renderAll(page);
  expect(await pageContent(page)).not.toMatch(A_MARK);
  expect(await memory(page)).not.toMatch(A_MARK);
  await switchTo(page, 'account-a');
  expect(await memory(page)).toMatch(/A-private offline win/);
  expect((await slots(page, A))[RV]).toMatch(/A-private offline win/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale editors / actions
// ═══════════════════════════════════════════════════════════════════════════

test('stale editors opened as A fail closed under B: review modal, weekly forms, routine editor, Learning create form', async ({ page }) => {
  await openApp(page, { slots: { ...A_SLOTS, ...B_SLOTS } });
  await aWritesReflections(page);
  await page.evaluate(() => {
    showView('learning');
    document.querySelector('[data-lp-action="show-create"]')?.click();
    document.querySelector('#learning-plan-create-form input').value = 'A-private typed plan';
    showView('today'); document.getElementById('routine-details').open = true;
    document.querySelector('[data-routine-action="manage"]').click();
  });
  // The routine editor for routine-1 (same id as B's routine), filled from A, left open.
  await page.locator('#routine-manager [data-routine-action="edit"]').first().click();
  await expect(page.locator('#daily-routine-dialog')).toBeVisible();
  await page.locator('#daily-routine-form [name="title"]').fill('A-private typed routine');
  await page.evaluate(() => { openReview(toDateKey(new Date())); document.getElementById('rv-avoid').value = 'A-private typed avoid'; });
  const bBefore = await slots(page, B);

  await switchTo(page, 'account-b');
  expect(await page.evaluate(() => document.getElementById('review-overlay').classList.contains('open'))).toBe(false);
  expect(await page.evaluate(() => document.getElementById('daily-routine-dialog').open)).toBe(false);
  expect(await pageContent(page)).not.toMatch(A_MARK);
  // Invoke every stale save path anyway, as if the A-filled forms were still there: each must refuse,
  // touching neither B's slots nor B's room.
  await page.evaluate(() => {
    document.getElementById('rv-avoid').value = 'A-private typed avoid';
    _reviewOwner = 'uid_account-a'; saveReview();                 // a review modal filled from A
    _weeklyFormOwner = 'uid_account-a';                            // weekly forms pre-filled from A
    document.getElementById('wr-overall').value = 'A-private weekly'; saveWeeklyReview();
    document.getElementById('wp-p1').value = 'A-private priority'; saveWeeklyPlan();
  });
  await settle(page);
  expect(await slots(page, B)).toEqual(bBefore);
  expect(writesUnder(await writesSinceMark(page), B).filter(w => /reviews|weeklyReviews/i.test(w.path))).toEqual([]);
  expect(await memory(page)).not.toMatch(A_MARK);
});

test('same-id stale action: A\'s rendered routine Done control, replayed under B, never completes B\'s routine-1', async ({ page }) => {
  await openApp(page, { slots: { ...A_SLOTS, ...B_SLOTS } });
  await page.evaluate(() => { showView('today'); window.renderDailyRoutines(); });
  const aControl = await page.evaluate(() => document.querySelector('#daily-routines-list [data-routine-action="done"]').outerHTML);
  expect(aControl).toContain('data-routine-owner="uid_account-a"');
  await switchTo(page, 'account-b');
  const bBefore = await slots(page, B);
  await page.evaluate(html => { const host = document.createElement('div'); host.innerHTML = html; document.getElementById('daily-routines-list').prepend(host); host.firstElementChild.click(); }, aControl);
  await settle(page);
  expect(await slots(page, B)).toEqual(bBefore);
  expect(await page.evaluate(() => document.getElementById('daily-routines-error').textContent)).toMatch(/account changed/);
  // B's own control, rendered for B, still works on the same id.
  await page.evaluate(() => document.querySelector('#daily-routines-list [data-routine-owner="uid_account-b"][data-routine-action="done"]').click());
  await settle(page);
  expect(Object.keys(JSON.parse((await slots(page, B))[DR]).manual)).toHaveLength(1);
  expect((await slots(page, A))[DR]).toBe(A_SLOTS[`${DR}:${A}`]);
});

test('same-id stale writes: a Learning Plan step / Career skill edit built from A\'s loaded state is refused once B owns local state', async ({ page }) => {
  await openApp(page, { slots: { ...A_SLOTS, ...B_SLOTS } });
  await page.evaluate(() => { showView('learning'); });
  await page.evaluate(() => { showView('career'); document.querySelector('[data-cc-action="open-panel"][data-panel="skill"]').click(); });
  const bBefore = await slots(page, B);
  // The owner moves to B WITHOUT the module rebind running (a stale path's view of the world): A's
  // plan-shared / sk-1 are still what the Learning and Career modules hold in memory.
  await page.evaluate(() => { roomCode = 'uid_account-b'; });
  await page.evaluate(() => { const box = document.querySelector('#learning-plan-main input[data-lp-action="toggle-step"]'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('form[data-cc-form="skill"] [name="name"]').fill('A-private stale skill');
  await page.evaluate(() => document.querySelector('form[data-cc-form="skill"]').requestSubmit());
  await settle(page);
  expect(await slots(page, B)).toEqual(bBefore);
  expect(await page.evaluate(() => document.getElementById('learning-plan-error').textContent)).toMatch(/account changed/);
  expect(await page.evaluate(() => document.getElementById('view-career').textContent)).toMatch(/account changed/);
});
