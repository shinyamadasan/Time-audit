// Cross-Store Account Isolation V1 — the PRODUCTION wiring of commitments and coarse life evidence
// across a direct account switch, in a real browser.
//
// The unit suite (cross-store-account-isolation.test.js) reproduces storage.js's order by hand. Here
// nothing is faked except Firebase itself: the page's own storage.js receives onAuthStateChanged(A),
// then onAuthStateChanged(B) with NO sign-out between (a direct switch), then onAuthStateChanged(null),
// and the test only OBSERVES what the real window.CommitmentsSync / window.CoarseLifeEvidenceSync
// singletons (loaded through the import map) write and what the real repositories expose.
//
// Before the fix this reproduced both leaks: A's commitment was transacted into
// rooms/uid_B/commitments/<id>, A's not-yet-synced evidence was written into
// rooms/uid_B/coarseLifeEvidence/<id>, and both read as B's current state.
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

const TZ = 'Asia/Manila';
const NOW = Date.parse('2026-09-24T08:00:00+08:00');

// A recording Firebase stub whose auth can be switched by the test. Every write (transaction or
// update) is logged with its absolute path and value; `failWrites` makes writes reject (a push that
// never reached the room); listeners are kept so a LATE delivery to a detached one can be forced.
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const log = { writes: [], listeners: [] };
  const tree = {};
  const listeners = new Map();
  const retained = [];
  const get = p => p.split('/').filter(Boolean).reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), tree);
  const put = (p, v) => {
    const segs = p.split('/').filter(Boolean); let n = tree;
    for (let i = 0; i < segs.length - 1; i++) { if (typeof n[segs[i]] !== 'object' || n[segs[i]] === null) n[segs[i]] = {}; n = n[segs[i]]; }
    n[segs[segs.length - 1]] = v;
  };
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const snapshot = value => ({ val: () => clone(value), ref: { remove: () => Promise.resolve() } });
  const fire = p => (listeners.get(p) || []).forEach(cb => cb(snapshot(get(p))));
  const fireUp = p => { let q = p; while (q) { fire(q); q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : ''; } };
  let connected = true;
  let failWrites = false;
  let authCb = null;
  const makeRef = refPath => ({
    path: refPath,
    child(c) { return makeRef(refPath + '/' + c); },
    on(ev, cb) {
      if (ev !== 'value') return cb;
      log.listeners.push(refPath);
      if (!listeners.has(refPath)) listeners.set(refPath, []);
      listeners.get(refPath).push(cb);
      retained.push({ path: refPath, cb });
      const value = refPath === '.info/connected' ? connected : get(refPath);
      setTimeout(() => cb(snapshot(value === undefined ? null : value)), 0);
      return cb;
    },
    off() { listeners.delete(refPath); },
    once() { return Promise.resolve(snapshot(get(refPath))); },
    update(map) {
      if (failWrites) return Promise.reject(new Error('offline'));
      Object.entries(map || {}).forEach(([k, v]) => { log.writes.push({ path: refPath + '/' + k, value: clone(v) }); put(refPath + '/' + k, clone(v)); fireUp(refPath + '/' + k); });
      return Promise.resolve();
    },
    set(v) { put(refPath, clone(v)); return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    transaction(fn) {
      if (failWrites) return Promise.reject(new Error('offline'));
      const cur = get(refPath);
      const next = fn(cur === undefined ? null : clone(cur));
      if (next === undefined) return Promise.resolve({ committed: false, snapshot: snapshot(cur) });
      log.writes.push({ path: refPath, value: clone(next) });
      put(refPath, clone(next));
      fireUp(refPath);
      return Promise.resolve({ committed: true, snapshot: snapshot(next) });
    },
    push(v) { const r = makeRef(refPath + '/pushed'); r.key = 'pushed'; if (v !== undefined) r.set(v); return r; },
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
    signInAs(uid) { authCb(user(uid)); },
  };
  const auth = () => ({ onAuthStateChanged(cb) { authCb = cb; setTimeout(() => cb(user('account-a')), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
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

const LEGACY_COMMITMENTS = JSON.stringify({ schemaVersion: 1, commitments: { clegacy: { schemaVersion: 1, id: 'clegacy', title: 'LEGACY-unowned', precision: 'timed', date: '2026-09-30', time: '10:00', timezone: TZ, startMs: Date.parse('2026-09-30T10:00:00+08:00'), createdAt: 1, updatedAt: 1, updatedBy: 'old' } } });
const LEGACY_EVIDENCE = JSON.stringify({ schemaVersion: 1, records: { '2026-09-23::legacy-unowned': { id: '2026-09-23::legacy-unowned', date: '2026-09-23', timezone: TZ, label: 'LEGACY-unowned', estimatedMinutes: 10, resolution: 'duration_without_placement', measurement: 'estimated', provenance: 'user_assertion', createdAt: 1, updatedAt: 1 } } });

async function openAsAccountA(page) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, legacyCommitments, legacyEvidence }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', timezone);
    localStorage.setItem('ta3-device-id', 'device-isolation');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', '[]'); localStorage.setItem('ta3-plans', '{}'); localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    // Pre-scoping data on this device: owner unknown.
    localStorage.setItem('ta3-commitments-v1', legacyCommitments);
    localStorage.setItem('ta3-coarse-life-evidence-v1', legacyEvidence);
  }, { timezone: TZ, now: NOW, legacyCommitments: LEGACY_COMMITMENTS, legacyEvidence: LEGACY_EVIDENCE });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.CommitmentsSync === 'object' && typeof window.CoarseLifeEvidenceSync === 'object' && !!window.__fbTest);
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode?.() === 'uid_account-a');
  await expect.poll(() => page.evaluate(() => window.__fbTest.log.listeners)).toContain('rooms/uid_account-a/coarseLifeEvidence');
}

/** Account A's facts, created through the same calls the UIs make: one of each store synced, plus one
 *  evidence record whose push failed (the record set that leaked into B before the fix). */
async function createAccountAFacts(page) {
  await page.evaluate(async () => {
    const created = window.CommitmentsRepository.create({ title: 'A-private dentist', date: '2026-09-30', time: '09:30', timezone: 'Asia/Manila' });
    await window.CommitmentsSync.syncCommitment(created.record.id);
    const evidence = window.CoarseLifeEvidenceSync.repository;
    const synced = evidence.save({ date: '2026-09-23', timezone: 'Asia/Manila', label: 'A-private therapy', estimatedMinutes: 60 });
    await window.CoarseLifeEvidenceSync.pushRecord(synced);
    window.__fbTest.setFailWrites(true);
    const unsynced = evidence.save({ date: '2026-09-23', timezone: 'Asia/Manila', label: 'A-unsynced errand', estimatedMinutes: 20 });
    await window.CoarseLifeEvidenceSync.pushRecord(unsynced);
    window.__fbTest.setFailWrites(false);
  });
}

const deviceState = page => page.evaluate(() => {
  const commitments = Object.values(window.CommitmentsRepository.listAllRaw()).map(r => r.title).sort();
  const evidence = window.CoarseLifeEvidenceSync.repository.list().map(r => r.label).sort();
  const day = Date.parse('2026-09-30T00:00:00+08:00');
  const myDayRows = (window.PlanningContinuityUI?.commitmentsForTarget({ startMs: day, endMs: day + 86400000 }) || []).map(r => r.title);
  return { commitments, evidence, myDayRows, room: globalThis.getChronaSenseRoomCode() };
});

// Only the two stores this phase isolates. Other paths storage.js writes on a switch (settings,
// entries, plans, ...) are NOT covered here — see the adjacent-store audit in CHANGELOG.md.
const writesUnder = (page, room) => page.evaluate(room => window.__fbTest.log.writes.filter(w => w.path.startsWith(`rooms/${room}/commitments`) || w.path.startsWith(`rooms/${room}/coarseLifeEvidence`)), room);

test('direct A -> B (no sign-out, no reload): zero A facts written into B or shown as B, for BOTH stores', async ({ page }) => {
  await openAsAccountA(page);
  await createAccountAFacts(page);
  expect(await deviceState(page)).toMatchObject({ commitments: ['A-private dentist'], evidence: ['A-private therapy', 'A-unsynced errand'], room: 'uid_account-a' });
  const slots = await page.evaluate(() => ({ c: localStorage.getItem('ta3-commitments-v1:uid_account-a'), e: localStorage.getItem('ta3-coarse-life-evidence-v1:uid_account-a') }));

  await page.evaluate(() => window.__fbTest.signInAs('account-b'));
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode() === 'uid_account-b');
  // Let startSync's listeners answer and the `.info/connected` reconnect hook run its pushAllLocal() calls.
  await expect.poll(() => page.evaluate(() => window.__fbTest.log.listeners.filter(p => p === '.info/connected').length)).toBe(2);
  await page.waitForTimeout(250);

  expect(await writesUnder(page, 'uid_account-b')).toEqual([]);
  expect(await page.evaluate(() => [window.__fbTest.get('rooms/uid_account-b/commitments'), window.__fbTest.get('rooms/uid_account-b/coarseLifeEvidence')])).toEqual([null, null]);
  expect(await deviceState(page)).toEqual({ commitments: [], evidence: [], myDayRows: [], room: 'uid_account-b' });
  // Both bridges are now bound to B's room.
  const listeners = await page.evaluate(() => window.__fbTest.log.listeners);
  expect(listeners).toContain('rooms/uid_account-b/commitments');
  expect(listeners).toContain('rooms/uid_account-b/coarseLifeEvidence');
  // A's scoped caches are untouched, and the unowned legacy keys were neither uploaded nor changed.
  expect(await page.evaluate(() => ({ c: localStorage.getItem('ta3-commitments-v1:uid_account-a'), e: localStorage.getItem('ta3-coarse-life-evidence-v1:uid_account-a') }))).toEqual(slots);
  expect(await page.evaluate(() => [localStorage.getItem('ta3-commitments-v1'), localStorage.getItem('ta3-coarse-life-evidence-v1')])).toEqual([LEGACY_COMMITMENTS, LEGACY_EVIDENCE]);
  expect(await page.evaluate(() => window.__fbTest.log.writes.filter(w => JSON.stringify(w.value).includes('LEGACY-unowned')))).toEqual([]);

  // A's other device writes while B is signed in; a late delivery on A's detached listeners is inert.
  await page.evaluate(() => {
    window.__fbTest.seed('rooms/uid_account-a/coarseLifeEvidence/2026-09-24::a-other-device', { id: '2026-09-24::a-other-device', date: '2026-09-24', timezone: 'Asia/Manila', label: 'A-other-device', estimatedMinutes: 5, resolution: 'duration_without_placement', measurement: 'estimated', provenance: 'user_assertion', createdAt: 5, updatedAt: 5 });
    window.__fbTest.fireLate('rooms/uid_account-a/coarseLifeEvidence');
    window.__fbTest.fireLate('rooms/uid_account-a/commitments');
  });
  expect(await deviceState(page)).toEqual({ commitments: [], evidence: [], myDayRows: [], room: 'uid_account-b' });

  // Back to A: A's data returns, and A's own unsynced record converges into A only.
  await page.evaluate(() => window.__fbTest.signInAs('account-a'));
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode() === 'uid_account-a');
  await expect.poll(async () => (await deviceState(page)).evidence).toEqual(['A-other-device', 'A-private therapy', 'A-unsynced errand']);
  expect((await deviceState(page)).commitments).toEqual(['A-private dentist']);
  await expect.poll(() => page.evaluate(() => Object.keys(window.__fbTest.get('rooms/uid_account-a/coarseLifeEvidence') || {}).length)).toBe(3);
  expect(await writesUnder(page, 'uid_account-b')).toEqual([]);
});

test('sign-out (onAuthStateChanged(null)) leaves no current state and no live callback; writes fail closed', async ({ page }) => {
  await openAsAccountA(page);
  await createAccountAFacts(page);
  const storeWrites = () => page.evaluate(() => window.__fbTest.log.writes.filter(w => /\/(commitments|coarseLifeEvidence)\//.test(w.path)).length);
  const writesBefore = await storeWrites();

  await page.evaluate(() => window.__fbTest.signInAs(null));
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode() === '');
  await expect(page.locator('#signin-overlay')).toBeVisible();
  await page.evaluate(() => {
    window.__fbTest.fireLate('rooms/uid_account-a/coarseLifeEvidence');
    window.__fbTest.fireLate('rooms/uid_account-a/commitments');
  });

  expect(await deviceState(page)).toEqual({ commitments: [], evidence: [], myDayRows: [], room: '' });
  const refused = await page.evaluate(async () => {
    const commitment = window.CommitmentsRepository.create({ title: 'x', date: '2026-09-30', time: '09:30', timezone: 'Asia/Manila' });
    let evidenceError = null;
    try { window.CoarseLifeEvidenceSync.repository.save({ date: '2026-09-23', timezone: 'Asia/Manila', label: 'x', estimatedMinutes: 5 }); } catch (err) { evidenceError = err.message; }
    await window.CommitmentsSync.pushAllLocal({ all: true });
    await window.CoarseLifeEvidenceSync.pushAllLocal({});
    return { commitment, evidenceError };
  });
  expect(refused.commitment).toEqual({ ok: false, reason: 'no-account' });
  expect(refused.evidenceError).toMatch(/no account is active/);
  expect(await storeWrites()).toBe(writesBefore);
  // Account-specific slots remain stored; nothing was deleted.
  expect(await page.evaluate(() => !!localStorage.getItem('ta3-commitments-v1:uid_account-a') && !!localStorage.getItem('ta3-coarse-life-evidence-v1:uid_account-a'))).toBe(true);
});

test('one page load runs one generation: each bridge and its repository are a single module instance', async ({ page }) => {
  await openAsAccountA(page);
  expect(await page.evaluate(() => window.CommitmentsSync.repository === window.CommitmentsRepository)).toBe(true);
  const scripts = await page.evaluate(() => performance.getEntriesByType('resource').map(r => r.name).filter(n => /(commitments|coarse-life-evidence)-(repository|sync)\.js/.test(n)).map(n => n.replace(/^.*\//, '')));
  // Every fetch of these four modules carried the one release token, and each was fetched once.
  const release = await page.evaluate(() => document.querySelector('meta[name="pdb-release"]').content);
  for (const file of ['commitments-repository.js', 'commitments-sync.js', 'coarse-life-evidence-repository.js', 'coarse-life-evidence-sync.js']) {
    expect(scripts.filter(n => n.startsWith(file))).toEqual([`${file}?v=${release}`]);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// the coarse-evidence EDITOR across a direct switch (FIX FIRST: before the fix a closed editor kept
// A's record in its inputs with focus inside it, and keyboard Save wrote it into B's slot and room)
// ═══════════════════════════════════════════════════════════════════════════

const EDITOR_FIELDS = ['cle-label', 'cle-hours', 'cle-minutes', 'cle-date'];
const editorState = page => page.evaluate(fields => {
  const overlay = document.getElementById('coarse-evidence-overlay');
  return {
    open: overlay.classList.contains('open'),
    fields: fields.map(id => document.getElementById(id).value),
    focusInside: overlay.contains(document.activeElement),
  };
}, EDITOR_FIELDS);
const evidenceIn = (page, room) => page.evaluate(room => ({
  local: Object.values((JSON.parse(localStorage.getItem(`ta3-coarse-life-evidence-v1:${room}`) || '{"records":{}}')).records).map(r => r.label).sort(),
  remote: Object.values(window.__fbTest.get(`rooms/${room}/coarseLifeEvidence`) || {}).map(r => r.label).sort(),
}), room);

async function openReviewList(page) {
  await page.evaluate(() => openReview('2026-09-23'));
  await page.locator('#rv-optional-details').evaluate(el => { el.open = true; });
}

async function switchToB(page) {
  await page.evaluate(() => window.__fbTest.signInAs('account-b'));
  await page.waitForFunction(() => globalThis.getChronaSenseRoomCode() === 'uid_account-b');
  await page.waitForTimeout(300); // the bridges' rebind notifications run after the switch
}

/** Every way a stale editor could still be submitted: Enter on its (hidden) Save button, the same
 *  after refilling the inputs as if stale DOM had survived, and the captured global save handler. */
async function attemptStaleSaves(page, refill) {
  await page.locator('#coarse-evidence-overlay .btn.primary').focus();
  await page.keyboard.press('Enter');
  await page.evaluate(values => values.forEach(([id, v]) => { document.getElementById(id).value = v; }), refill);
  await page.locator('#coarse-evidence-overlay .btn.primary').focus();
  await page.keyboard.press('Enter');
  await page.evaluate(values => { values.forEach(([id, v]) => { document.getElementById(id).value = v; }); window.__staleSave(); }, refill);
  await page.waitForTimeout(200);
}

test('EDIT an existing A record, direct switch to B: editor closed and cleared, focus out, every stale save fails closed', async ({ page }) => {
  await openAsAccountA(page);
  await page.evaluate(async () => {
    const r = window.CoarseLifeEvidenceSync.repository.save({ date: '2026-09-23', timezone: 'Asia/Manila', label: 'A-private therapy', estimatedMinutes: 75 });
    await window.CoarseLifeEvidenceSync.pushRecord(r);
  });
  await openReviewList(page);
  await page.locator('#rv-coarse-evidence').getByRole('button', { name: 'Edit', exact: true }).click();
  expect(await editorState(page)).toEqual({ open: true, fields: ['A-private therapy', '1', '15', '2026-09-23'], focusInside: true });
  await page.evaluate(() => { window.__staleSave = window.saveCoarseEvidenceEditor; });

  await switchToB(page);
  expect(await editorState(page)).toEqual({ open: false, fields: ['', '', '', ''], focusInside: false });
  expect(await page.locator('#cle-title').textContent()).toBe('Add approximate activity');

  // The reviewer's path: keyboard from wherever focus now is cannot reach a populated editor, and even
  // with A's values forced back into the inputs, neither Enter on Save nor the captured handler saves.
  await attemptStaleSaves(page, [['cle-label', 'A-private therapy'], ['cle-hours', '1'], ['cle-minutes', '15'], ['cle-date', '2026-09-23']]);
  expect(await evidenceIn(page, 'uid_account-b')).toEqual({ local: [], remote: [] });
  expect(await page.evaluate(() => window.CoarseLifeEvidenceSync.repository.list().map(r => r.label))).toEqual([]);
  expect(await page.evaluate(() => window.__fbTest.log.writes.filter(w => w.path.startsWith('rooms/uid_account-b/coarseLifeEvidence')))).toEqual([]);
  expect((await evidenceIn(page, 'uid_account-a')).local).toEqual(['A-private therapy']);
});

test('ADD mode with unsaved A-side values, direct switch to B: fields reset and the stale Add session cannot save', async ({ page }) => {
  await openAsAccountA(page);
  await openReviewList(page);
  await page.locator('#rv-coarse-evidence').getByRole('button', { name: '+ Add approximate activity' }).click();
  await page.fill('#cle-label', 'A-unsaved note');
  await page.fill('#cle-hours', '2');
  expect((await editorState(page)).fields.slice(0, 2)).toEqual(['A-unsaved note', '2']);
  await page.evaluate(() => { window.__staleSave = window.saveCoarseEvidenceEditor; });

  await switchToB(page);
  expect(await editorState(page)).toEqual({ open: false, fields: ['', '', '', ''], focusInside: false });
  await attemptStaleSaves(page, [['cle-label', 'A-unsaved note'], ['cle-hours', '2'], ['cle-minutes', '0'], ['cle-date', '2026-09-23']]);
  expect(await evidenceIn(page, 'uid_account-b')).toEqual({ local: [], remote: [] });
  expect(await evidenceIn(page, 'uid_account-a')).toEqual({ local: [], remote: [] });
});

test('after the switch, a NEW B editor session saves legitimate B data — into B only', async ({ page }) => {
  await openAsAccountA(page);
  await page.evaluate(async () => {
    const r = window.CoarseLifeEvidenceSync.repository.save({ date: '2026-09-23', timezone: 'Asia/Manila', label: 'A-private therapy', estimatedMinutes: 75 });
    await window.CoarseLifeEvidenceSync.pushRecord(r);
  });
  await openReviewList(page);
  await page.locator('#rv-coarse-evidence').getByRole('button', { name: 'Edit', exact: true }).click();
  await switchToB(page);

  await openReviewList(page);
  await expect(page.locator('#rv-coarse-evidence')).not.toContainText('A-private therapy');
  await page.locator('#rv-coarse-evidence').getByRole('button', { name: '+ Add approximate activity' }).click();
  expect((await editorState(page)).open).toBe(true);
  await page.fill('#cle-label', 'B-own walk');
  await page.fill('#cle-minutes', '30');
  await page.locator('#coarse-evidence-overlay').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rv-coarse-evidence')).toContainText('B-own walk');

  await expect.poll(() => evidenceIn(page, 'uid_account-b')).toEqual({ local: ['B-own walk'], remote: ['B-own walk'] });
  expect(await evidenceIn(page, 'uid_account-a')).toEqual({ local: ['A-private therapy'], remote: ['A-private therapy'] });
});
