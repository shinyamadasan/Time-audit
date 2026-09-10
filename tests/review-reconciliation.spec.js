// Phase 6I/J — Review Reconciliation + Today Gap Replacement V1.
//
// §38 (reconciliation) and §39 (today gap replacement) of the milestone spec. Uses the
// same HTTP-served harness as coarse-life-evidence.spec.js because the reconciliation
// "Add broad activity" action reuses the 6H coarse-evidence ES module.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const makeRef = refPath => ({
    path: refPath, child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) { if (eventName === 'value') setTimeout(() => cb(snapshot(null)), 0); return cb; },
    off() {}, once() { return Promise.resolve(snapshot(null)); }, update() { return Promise.resolve(); },
    set() { return Promise.resolve(); }, remove() { return Promise.resolve(); },
    transaction(updateFn) { const value = updateFn(null); return Promise.resolve({ committed: true, snapshot: snapshot(value) }); },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'rr-user', displayName: 'RR User', email: 'rr@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(config) { const app = { config }; this.apps.push(app); return app; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
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

async function openApp(page, { timezone = 'Etc/UTC', entries = [], reviews = {}, coarse = null, now, suppressSleep = false } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, entries, reviews, coarse, now, suppressSleep }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', timezone);
    localStorage.setItem('ta3-device-id', 'device-rr-test');
    // suppressSleep isolates the Today-interruption assertions to the gap question only —
    // the configured sleep reminder is a separate, concrete Needs You signal (§15).
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: !suppressSleep, templates: [] }));
    localStorage.setItem('ta3-entries', JSON.stringify(entries));
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-reviews', JSON.stringify(reviews));
    localStorage.setItem('ta3-plans', '{}');
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify({ schemaVersion: 1, timezone, routines: [], manual: {}, links: {}, focus: {}, skips: {} }));
    if (coarse) localStorage.setItem('ta3-coarse-life-evidence-v1', JSON.stringify(coarse));
  }, { timezone, entries, reviews, coarse, now, suppressSleep });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof openReview === 'function' && typeof renderCoarseEvidenceList === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

const NOW = Date.parse('2026-09-09T18:00:00Z');
const DATE = '2026-09-09';
// One short morning block — the rest of the day is a large diagnostic gap.
const morningBlock = (dateKey = DATE) => ({ id: 'morning', activity: 'Morning work', energy: 'deep', date: dateKey, tsStart: Date.parse(`${dateKey}T09:00:00Z`), ts: Date.parse(`${dateKey}T09:30:00Z`), blockIntervalMin: 30 });

const decision = page => page.locator('#rv-unlogged-decision');
const saveReflection = page => page.locator('#review-overlay').getByRole('button', { name: 'Save reflection', exact: true });

// ── §38 A/B/K — the section appears, is optional, and Save works untouched ──
test('reconciliation prompt appears and Save works without touching it', async ({ page }) => {
  await openApp(page, { entries: [morningBlock()], now: NOW });
  await page.evaluate(() => openReview());
  await expect(decision(page)).toBeVisible();
  await expect(decision(page)).toContainText('Anything important missing?');
  // Hierarchy: "Looks about right" is the one primary exit; the rest are secondary.
  await expect(decision(page).getByRole('button', { name: 'Looks about right' })).toHaveClass(/primary/);
  await expect(decision(page).getByRole('button', { name: 'Leave unknown' })).not.toHaveClass(/primary/);
  await expect(decision(page).getByRole('button', { name: 'Add broad activity' })).not.toHaveClass(/primary/);
  // "Log time" is a demoted text link, not an equal-weight button.
  await expect(decision(page).getByRole('button', { name: 'Log time' })).toHaveClass(/rv-gap-link/);
  // The prompt is a calm neutral surface, not the amber-alarm styling it used to carry.
  const bg = await decision(page).locator('.rv-gap-check').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).not.toMatch(/249,\s*199,\s*79/); // old #f9c74f alarm tint
  // No completeness/score/coverage language (§10/§25/§43-Q17).
  await expect(page.locator('#review-overlay')).not.toContainText(/complete your day|accounted for|% of (your )?day|unaccounted|100%|coverage/i);

  await saveReflection(page).click();
  await expect(page.locator('#review-overlay')).not.toHaveClass(/open/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-reviews'))[Object.keys(JSON.parse(localStorage.getItem('ta3-reviews')))[0]]);
  expect(saved.reconciliation).toBeNull();
});

// ── §38 E — "Looks about right" persists, claims nothing, closes no gap ──
test('Looks about right persists as a review acknowledgment and does not fabricate or close anything', async ({ page }) => {
  await openApp(page, { entries: [morningBlock()], now: NOW });
  const gapsBefore = await page.evaluate(k => JSON.stringify(getCloseoutGaps(k)), DATE);
  await page.evaluate(() => openReview());
  await decision(page).getByRole('button', { name: 'Looks about right' }).click();
  await expect(decision(page)).toContainText('Looks about right');
  await expect(decision(page)).not.toContainText(/complete|all time known|verified|nothing missing/i);
  await saveReflection(page).click();

  const state = await page.evaluate(k => ({
    review: JSON.parse(localStorage.getItem('ta3-reviews'))[k],
    gaps: JSON.stringify(getCloseoutGaps(k)),
    entryCount: entries.length,
    coarse: localStorage.getItem('ta3-coarse-life-evidence-v1')
  }), DATE);
  expect(state.review.reconciliation).toBe('reviewed_ok');
  expect(state.review.unloggedOk).toBe(false); // not a detected-gap acknowledgment
  expect(state.gaps).toBe(gapsBefore); // raw gaps unchanged (§38-H, §38-I)
  expect(state.entryCount).toBe(1); // no fabricated activity (§38-G)
  expect(state.coarse).toBeNull(); // no fabricated duration
});

// ── §38 F — "Leave unknown" persists both the new field and legacy unloggedOk ──
test('Leave unknown persists and never fabricates an activity', async ({ page }) => {
  await openApp(page, { entries: [morningBlock()], now: NOW });
  await page.evaluate(() => openReview());
  await decision(page).getByRole('button', { name: 'Leave unknown' }).click();
  await expect(decision(page)).toContainText('Left unknown');
  await saveReflection(page).click();

  const review = await page.evaluate(k => JSON.parse(localStorage.getItem('ta3-reviews'))[k], DATE);
  expect(review.reconciliation).toBe('left_unknown');
  expect(review.unloggedOk).toBe(true); // a real >=30m gap is present, so legacy field is set too
  const entryCount = await page.evaluate(() => entries.length);
  expect(entryCount).toBe(1);
});

// ── §38 J / §20 — reopen preserves state without re-nagging ──
test('reopening a reconciled day shows a calm summary, not the full prompt again', async ({ page }) => {
  await openApp(page, {
    entries: [morningBlock()],
    reviews: { [DATE]: { win: 'shipped', reconciliation: 'reviewed_ok', unloggedOk: false, _savedAt: NOW } },
    now: NOW
  });
  await page.evaluate(k => openReview(k), DATE);
  await expect(decision(page)).toContainText('Looks about right');
  await expect(decision(page)).not.toContainText('Anything important missing?');
  // Acknowledged state is visually quiet: no box, no helper sentence, no primary button —
  // just a checked line plus two small text links (§4).
  await expect(decision(page).locator('.rv-gap-check.ok')).toBeVisible();
  await expect(decision(page).locator('.rv-gap-copy')).toHaveCount(0);
  await expect(decision(page).locator('.btn.primary')).toHaveCount(0);
  await expect(decision(page).getByRole('button', { name: 'Add activity' })).toBeVisible();
  await expect(decision(page).getByRole('button', { name: 'Change' })).toBeVisible();
  await decision(page).getByRole('button', { name: 'Change' }).click();
  await expect(decision(page)).toContainText('Anything important missing?');
});

// ── §38 J — old review from before 6I (unloggedOk only) does not re-nag ──
test('a pre-6I review record with unloggedOk:true is treated as already left-unknown', async ({ page }) => {
  await openApp(page, {
    entries: [morningBlock()],
    reviews: { [DATE]: { win: '', waste: '', avoid: '', unloggedOk: true, _savedAt: NOW } },
    now: NOW
  });
  await page.evaluate(k => openReview(k), DATE);
  await expect(decision(page)).toContainText('Left unknown');
  await expect(decision(page)).not.toContainText('Anything important missing?');
  // Saving preserves both fields truthfully.
  await saveReflection(page).click();
  const review = await page.evaluate(k => JSON.parse(localStorage.getItem('ta3-reviews'))[k], DATE);
  expect(review.unloggedOk).toBe(true);
  expect(review.reconciliation).toBe('left_unknown');
});

// ── §38 C/D — "Add broad activity" reuses the 6H editor for the review's selected date ──
test('Add broad activity opens the 6H editor prefilled to the review date and stores it there', async ({ page }) => {
  await openApp(page, { entries: [morningBlock()], now: NOW });
  await page.evaluate(() => openReview());
  await decision(page).getByRole('button', { name: 'Add broad activity' }).click();
  await expect(page.locator('#coarse-evidence-overlay')).toHaveClass(/open/);
  await expect(page.locator('#cle-date')).toHaveValue(DATE);
  await page.fill('#cle-label', 'Household');
  await page.fill('#cle-minutes', '45');
  await page.locator('#coarse-evidence-overlay').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#coarse-evidence-overlay')).not.toHaveClass(/open/);
  await expect(page.locator('#review-overlay')).toHaveClass(/open/); // returned to Review

  const record = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('ta3-coarse-life-evidence-v1')).records)[0]);
  expect(record.date).toBe(DATE);
  expect(record.estimatedMinutes).toBe(45);
  expect(record).not.toHaveProperty('tsStart');
});

// ── §21 — adding coarse evidence after "Looks about right" does not force reconfirmation ──
test('adding coarse evidence after acknowledgment keeps the acknowledgment', async ({ page }) => {
  await openApp(page, {
    entries: [morningBlock()],
    reviews: { [DATE]: { reconciliation: 'reviewed_ok', unloggedOk: false, _savedAt: NOW } },
    now: NOW
  });
  await page.evaluate(k => openReview(k), DATE);
  await decision(page).getByRole('button', { name: 'Add activity' }).click();
  await page.fill('#cle-label', 'Household');
  await page.fill('#cle-minutes', '45');
  await page.locator('#coarse-evidence-overlay').getByRole('button', { name: 'Save', exact: true }).click();
  // Still acknowledged, no nag.
  await expect(decision(page)).toContainText('Looks about right');
  await saveReflection(page).click();
  const review = await page.evaluate(k => JSON.parse(localStorage.getItem('ta3-reviews'))[k], DATE);
  expect(review.reconciliation).toBe('reviewed_ok');
});

// ── §34 / §38 M — after-midnight review keeps Tuesday ownership ──
test('after-midnight review of the previous day owns that day, not today', async ({ page }) => {
  const AFTER_MIDNIGHT = Date.parse('2026-09-10T00:30:00Z');
  await openApp(page, { entries: [morningBlock('2026-09-09')], now: AFTER_MIDNIGHT });
  await page.evaluate(() => openReview('2026-09-09'));
  await expect(page.locator('#review-overlay')).toHaveClass(/open/);
  expect(await page.evaluate(() => _reviewDateKey)).toBe('2026-09-09');
  await decision(page).getByRole('button', { name: 'Add broad activity' }).click();
  await expect(page.locator('#cle-date')).toHaveValue('2026-09-09');
  await page.locator('#coarse-evidence-overlay').getByRole('button', { name: 'Cancel', exact: true }).click();
  await decision(page).getByRole('button', { name: 'Looks about right' }).click();
  await saveReflection(page).click();
  const reviews = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-reviews')));
  expect(reviews['2026-09-09'].reconciliation).toBe('reviewed_ok');
  expect(reviews['2026-09-10']).toBeUndefined();
});

// ── §29 — empty historical day still works, no "nothing happened" / "complete" ──
test('an empty historical day reconciles without a completeness claim', async ({ page }) => {
  await openApp(page, { now: NOW });
  await page.evaluate(() => openReview('2026-09-01'));
  await expect(page.locator('#review-overlay')).toHaveClass(/open/);
  await expect(page.locator('#review-overlay')).not.toContainText(/nothing happened|0 waste|all good|day complete/i);
  await decision(page).getByRole('button', { name: 'Leave unknown' }).click();
  await saveReflection(page).click();
  const review = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-reviews'))['2026-09-01']);
  expect(review.reconciliation).toBe('left_unknown');
});

// ── §39 P/Q/R/S/T — Today no longer interrupts for generic gaps; diagnostics remain ──
for (const [label, block] of [
  ['35m gap', { id: 'a', activity: 'Work', energy: 'deep', tsStart: NOW - 95 * 60000, ts: NOW - 60 * 60000, blockIntervalMin: 35 }],
  ['5h gap', { id: 'a', activity: 'Work', energy: 'deep', tsStart: NOW - 6 * 3600000, ts: NOW - 5 * 3600000, blockIntervalMin: 60 }],
]) {
  test(`Today shows no Needs You interruption for a ${label}, but the raw gap still computes`, async ({ page }) => {
    await openApp(page, { entries: [{ ...block, date: DATE }], now: NOW, suppressSleep: true });
    await expect(page.locator('#needs-you')).toBeHidden();
    await expect(page.locator('#gap-recovery')).toBeHidden();
    expect(await page.evaluate(k => getCloseoutGaps(k).length > 0, DATE)).toBe(true);
    // Full analysis still lists raw unlogged intervals (§17/§39-T).
    await page.evaluate(k => openReview(k, true), DATE);
    await expect(page.locator('#rv-gap-details')).toContainText('Unlogged intervals');
  });
}

test('multiple gaps across the day still raise no repeated Today interruption', async ({ page }) => {
  await openApp(page, {
    entries: [
      { id: 'a', activity: 'A', energy: 'deep', date: DATE, tsStart: Date.parse(`${DATE}T08:00:00Z`), ts: Date.parse(`${DATE}T08:40:00Z`), blockIntervalMin: 40 },
      { id: 'b', activity: 'B', energy: 'deep', date: DATE, tsStart: Date.parse(`${DATE}T10:00:00Z`), ts: Date.parse(`${DATE}T10:45:00Z`), blockIntervalMin: 45 },
      { id: 'c', activity: 'C', energy: 'deep', date: DATE, tsStart: Date.parse(`${DATE}T13:00:00Z`), ts: Date.parse(`${DATE}T14:30:00Z`), blockIntervalMin: 90 },
    ],
    now: NOW,
    suppressSleep: true
  });
  await expect(page.locator('#needs-you')).toBeHidden();
  expect(await page.evaluate(k => getCloseoutGaps(k).length, DATE)).toBeGreaterThan(1);
});

test('today future time is not treated as a missing-time interruption', async ({ page }) => {
  // Morning block only; "now" is 18:00 — the evening is unlogged, the night is future.
  await openApp(page, { entries: [morningBlock()], now: NOW, suppressSleep: true });
  await expect(page.locator('#needs-you')).toBeHidden();
  // The reconciliation prompt, when opened, never counts the remaining/future hours.
  await page.evaluate(() => openReview());
  await expect(decision(page)).not.toContainText(/hours (missing|left|remaining)|countdown/i);
});

// ── Day-to-day UX correction pass ─────────────────────────────────────────

test('Today Health carries no unlogged-time debt stat and no deficit copy', async ({ page }) => {
  await openApp(page, {
    entries: [
      { id: 'a', activity: 'A', energy: 'deep', date: DATE, tsStart: Date.parse(`${DATE}T08:00:00Z`), ts: Date.parse(`${DATE}T09:00:00Z`), blockIntervalMin: 60 },
      { id: 'b', activity: 'B', energy: 'waste', date: DATE, tsStart: Date.parse(`${DATE}T09:00:00Z`), ts: Date.parse(`${DATE}T09:20:00Z`), blockIntervalMin: 20 },
    ],
    now: NOW, suppressSleep: true
  });
  await expect(page.locator('#th-unlogged')).toHaveCount(0);
  await expect(page.locator('#today-health')).not.toContainText(/unlogged|unaccounted|missing/i);
  // raw gap diagnostics preserved
  expect(await page.evaluate(k => getCloseoutGaps(k).length > 0, DATE)).toBe(true);
});

test('generic meal/chore check-in prompts do not appear on Today', async ({ page }) => {
  // Old dinner-window time; the hard-coded "Dinner check" used to show here.
  await openApp(page, { entries: [morningBlock()], now: Date.parse('2026-09-09T19:00:00Z'), suppressSleep: true });
  await page.evaluate(() => { renderRoutinePrompt(); });
  await expect(page.locator('#routine-prompt')).toBeHidden();
  await expect(page.locator('#routine-prompt')).toBeEmpty();
  expect(await page.evaluate(() => typeof ROUTINE_PROMPTS)).toBe('undefined');
});

test('Close Day copy is neutral — no "leak" / deficit framing', async ({ page }) => {
  // reviewTime 22:00 already elapsed at a late "now" → the closeout CTA is due.
  await openApp(page, {
    entries: [{ id: 'a', activity: 'A', energy: 'deep', date: DATE, tsStart: Date.parse(`${DATE}T09:00:00Z`), ts: Date.parse(`${DATE}T10:00:00Z`), blockIntervalMin: 60 }],
    now: Date.parse('2026-09-09T23:30:00Z'), suppressSleep: true
  });
  const sub = await page.evaluate(() => { renderCloseoutCta(); return document.getElementById('closeout-sub').textContent; });
  expect(sub).toContain('prepare tomorrow');
  expect(sub).not.toMatch(/leak|missing time|unaccounted|name the/i);
});

test('the analytical tab reads "Trends", not "Reflect"', async ({ page }) => {
  await openApp(page, { now: NOW });
  await expect(page.locator('#nav-reflect')).toContainText('Trends');
  await expect(page.locator('#nav-reflect')).not.toContainText('Reflect');
  await page.locator('#nav-reflect').click();
  await expect(page.locator('#view-reflect .page-title')).toHaveText('Trends');
});

test('concrete Needs You integrity signals still surface (sleep reminder)', async ({ page }) => {
  // sleep reminder is a concrete signal — untouched by the UX pass.
  await openApp(page, { entries: [morningBlock()], now: NOW }); // suppressSleep defaults false
  await expect(page.locator('#needs-you')).toBeVisible();
  await expect(page.locator('#today-sleep-reminder')).toBeVisible();
});
