import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';
const NOW = Date.parse('2026-09-09T18:00:00Z');

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const listeners = new Map();
  const makeRef = refPath => ({
    path: refPath, child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) { if (eventName === 'value') { const rows = listeners.get(refPath) || []; rows.push(cb); listeners.set(refPath, rows); setTimeout(() => cb(snapshot(null)), 0); } return cb; },
    off() {}, once() { return Promise.resolve(snapshot(null)); }, update() { return Promise.resolve(); },
    set() { return Promise.resolve(); }, remove() { return Promise.resolve(); },
    transaction(updateFn) { const value = updateFn(null); return Promise.resolve({ committed: true, snapshot: snapshot(value) }); },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'cle-user', displayName: 'CLE User', email: 'cle@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
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

async function openApp(page, { timezone = 'Etc/UTC', entries = [] } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, entries, now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', timezone);
    localStorage.setItem('ta3-device-id', 'device-cle-test');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', JSON.stringify(entries));
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-plans', '{}');
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify({ schemaVersion: 1, timezone, routines: [], manual: {}, links: {}, focus: {}, skips: {} }));
  }, { timezone, entries, now: NOW });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof openReview === 'function' && typeof renderCoarseEvidenceList === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function openReviewFor(page, dateKey) {
  await page.evaluate(dateKey => openReview(dateKey), dateKey);
  await expect(page.locator('#review-overlay')).toHaveClass(/open/);
  await page.locator('#rv-optional-details').evaluate(el => { el.open = true; });
}

// Scoped to the coarse-evidence modal — "Save reflection" on Review also matches a
// loose "Save" text selector, so this must not be ambiguous.
function saveCoarseEditor(page) {
  return page.locator('#coarse-evidence-overlay').getByRole('button', { name: 'Save', exact: true }).click();
}

const DATE = '2026-09-09';

test('add an approximate activity — no start/end time is ever written, shown separately', async ({ page }) => {
  await openApp(page);
  await openReviewFor(page, DATE);

  await page.evaluate(dateKey => openCoarseEvidenceEditor(dateKey), DATE);
  await expect(page.locator('#coarse-evidence-overlay')).toHaveClass(/open/);
  await page.fill('#cle-label', 'Cooking / eating');
  await page.fill('#cle-hours', '1');
  await page.fill('#cle-minutes', '20');
  await saveCoarseEditor(page);

  await expect(page.locator('#coarse-evidence-overlay')).not.toHaveClass(/open/);
  await expect(page.locator('#rv-coarse-evidence')).toContainText('Cooking / eating');
  await expect(page.locator('#rv-coarse-evidence')).toContainText('~1h 20m');
  await expect(page.locator('#rv-coarse-evidence')).toContainText('Approximate activities: ~1h 20m');

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-coarse-life-evidence-v1')));
  const records = Object.values(stored.records);
  expect(records.length).toBe(1);
  const record = records[0];
  expect(record.date).toBe(DATE);
  expect(record.estimatedMinutes).toBe(80);
  expect(record.resolution).toBe('duration_without_placement');
  expect(record.measurement).toBe('estimated');
  expect(record.provenance).toBe('user_assertion');
  expect(record).not.toHaveProperty('tsStart');
  expect(record).not.toHaveProperty('tsEnd');
});

test('editing replaces rather than adds: 80 -> 100 shows 100, not 180', async ({ page }) => {
  await openApp(page);
  await openReviewFor(page, DATE);
  await page.evaluate(dateKey => openCoarseEvidenceEditor(dateKey), DATE);
  await page.fill('#cle-label', 'Cooking / eating');
  await page.fill('#cle-minutes', '80');
  await saveCoarseEditor(page);
  await expect(page.locator('#rv-coarse-evidence')).toContainText('~1h 20m');

  await page.locator('#rv-coarse-evidence').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#coarse-evidence-overlay')).toHaveClass(/open/);
  await page.fill('#cle-minutes', '40'); // 1h + 40m = 100m
  await saveCoarseEditor(page);

  await expect(page.locator('#rv-coarse-evidence')).toContainText('~1h 40m');
  await expect(page.locator('#rv-coarse-evidence')).not.toContainText('180');
  const records = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('ta3-coarse-life-evidence-v1')).records));
  expect(records.length).toBe(1);
  expect(records[0].estimatedMinutes).toBe(100);
});

test('reopening and saving unchanged does not duplicate', async ({ page }) => {
  await openApp(page);
  await openReviewFor(page, DATE);
  await page.evaluate(dateKey => openCoarseEvidenceEditor(dateKey), DATE);
  await page.fill('#cle-label', 'Household');
  await page.fill('#cle-minutes', '45');
  await saveCoarseEditor(page);
  await page.locator('#rv-coarse-evidence').getByRole('button', { name: 'Edit', exact: true }).click();
  await saveCoarseEditor(page); // unchanged
  const records = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('ta3-coarse-life-evidence-v1')).records));
  expect(records.length).toBe(1);
});

test('remove deletes only the coarse assertion, never touches exact entries', async ({ page }) => {
  await openApp(page, { entries: [{ id: 'e1', activity: 'Cooking', energy: 'recovery', tsStart: Date.parse(`${DATE}T09:00:00Z`), ts: Date.parse(`${DATE}T09:30:00Z`), blockIntervalMin: 30 }] });
  await openReviewFor(page, DATE);
  await page.evaluate(dateKey => openCoarseEvidenceEditor(dateKey), DATE);
  await page.fill('#cle-label', 'Cooking / eating');
  await page.fill('#cle-minutes', '80');
  await saveCoarseEditor(page);
  await expect(page.locator('#rv-coarse-evidence')).toContainText('Cooking / eating');

  await page.locator('#rv-coarse-evidence').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('#rv-coarse-evidence')).not.toContainText('Cooking / eating');
  // Durability V1: remove() tombstones (deleted:true) rather than erasing the row, so a
  // durable remote copy converges to "deleted" instead of a stale echo resurrecting it —
  // see coarse-life-evidence-repository.js. The observable contract is still "gone": no
  // non-deleted record remains, and ordinary reads (list()/get()) never see it.
  const records = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('ta3-coarse-life-evidence-v1')).records));
  expect(records.filter(r => !r.deleted).length).toBe(0);
  expect(records.length).toBe(1);
  expect(records[0].deleted).toBe(true);
  const entryCount = await page.evaluate(() => entries.filter(e => !e.deleted).length);
  expect(entryCount).toBe(1); // untouched
});

test('coarse evidence + a same-category exact interval are shown separately, never blindly summed into one total', async ({ page }) => {
  await openApp(page, { entries: [{ id: 'e1', activity: 'Cooking', energy: 'recovery', tsStart: Date.parse(`${DATE}T09:00:00Z`), ts: Date.parse(`${DATE}T09:30:00Z`), blockIntervalMin: 30 }] });
  await openReviewFor(page, DATE);
  await page.evaluate(dateKey => openCoarseEvidenceEditor(dateKey), DATE);
  await page.fill('#cle-label', 'Cooking / eating');
  await page.fill('#cle-hours', '1');
  await page.fill('#cle-minutes', '30');
  await saveCoarseEditor(page);

  // Closeout summary (exact recorded time) and the approximate-activities block both render,
  // and neither claims a combined "actual" total.
  await expect(page.locator('#rv-closeout-summary')).toContainText('30m recorded');
  await expect(page.locator('#rv-coarse-evidence')).toContainText('~1h 30m');
  await expect(page.locator('#review-overlay')).not.toContainText('2h');
});

test('an existing plain-text label is accepted; empty label and nonsense duration are rejected without saving', async ({ page }) => {
  await openApp(page);
  await openReviewFor(page, DATE);
  await page.evaluate(dateKey => openCoarseEvidenceEditor(dateKey), DATE);

  // empty label
  await page.fill('#cle-minutes', '30');
  await saveCoarseEditor(page);
  await expect(page.locator('#cle-error')).toContainText('broad thing');
  await expect(page.locator('#coarse-evidence-overlay')).toHaveClass(/open/);

  // zero duration
  await page.fill('#cle-label', 'Errands');
  await page.fill('#cle-minutes', '0');
  await page.fill('#cle-hours', '0');
  await saveCoarseEditor(page);
  await expect(page.locator('#cle-error')).toContainText('greater than zero');

  // extreme value
  await page.fill('#cle-hours', '30');
  await saveCoarseEditor(page);
  await expect(page.locator('#cle-error')).toContainText('24h');

  const records = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('ta3-coarse-life-evidence-v1') || '{"records":{}}').records));
  expect(records.length).toBe(0);
});

test('an evidence-only day never fabricates a timeline block and never enters deep/waste analytics', async ({ page }) => {
  await openApp(page); // zero entries
  await openReviewFor(page, DATE);
  await page.evaluate(dateKey => openCoarseEvidenceEditor(dateKey), DATE);
  await page.fill('#cle-label', 'Recovery / downtime');
  await page.fill('#cle-hours', '2');
  await saveCoarseEditor(page);

  // No timeline block was fabricated: the underlying entries array is still empty.
  const entryCount = await page.evaluate(() => entries.length);
  expect(entryCount).toBe(0);

  // computeDailySummary (deep%/waste% pulse card) only ever reads `entries`; a day with
  // nothing but coarse evidence still yields no summary — no deep/waste claim is manufactured.
  const summary = await page.evaluate(dateKey => computeDailySummary(dateKey), DATE);
  expect(summary).toBeNull();
});

// ── Independent-review targeted corrections ────────────────────────────────

test('renaming a record onto an existing independent label is rejected in the UI, not silently merged', async ({ page }) => {
  await openApp(page);
  await openReviewFor(page, DATE);

  await page.evaluate(dateKey => openCoarseEvidenceEditor(dateKey), DATE);
  await page.fill('#cle-label', 'Household');
  await page.fill('#cle-minutes', '45');
  await saveCoarseEditor(page);

  await page.evaluate(dateKey => openCoarseEvidenceEditor(dateKey), DATE);
  await page.fill('#cle-label', 'Errands');
  await page.fill('#cle-minutes', '60');
  await saveCoarseEditor(page);

  // Edit "Errands" and rename it to the already-taken "Household".
  const rows = page.locator('#rv-coarse-evidence .cle-row');
  await rows.filter({ hasText: 'Errands' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#coarse-evidence-overlay')).toHaveClass(/open/);
  await page.fill('#cle-label', 'Household');
  await saveCoarseEditor(page);

  await expect(page.locator('#cle-error')).toContainText('already exists');
  await expect(page.locator('#coarse-evidence-overlay')).toHaveClass(/open/); // save was refused, modal stays open

  await page.locator('#coarse-evidence-overlay').getByRole('button', { name: 'Cancel', exact: true }).click();
  // Both original records survive untouched.
  await expect(page.locator('#rv-coarse-evidence')).toContainText('Household');
  await expect(page.locator('#rv-coarse-evidence')).toContainText('Errands');
  await expect(page.locator('#rv-coarse-evidence')).toContainText('~45m');
  await expect(page.locator('#rv-coarse-evidence')).toContainText('~1h');
  const records = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('ta3-coarse-life-evidence-v1')).records));
  expect(records.length).toBe(2);
});

test('a label containing quotes/HTML markers cannot inject script through Edit/Remove, and both still target the correct record', async ({ page }) => {
  await openApp(page);
  await openReviewFor(page, DATE);
  const dangerousLabel = `x'); window.__xssFired = true; // <>&"'`;

  await page.evaluate(dateKey => openCoarseEvidenceEditor(dateKey), DATE);
  await page.fill('#cle-label', dangerousLabel);
  await page.fill('#cle-minutes', '42');
  await saveCoarseEditor(page);

  // Renders as inert text, never as markup or executed script.
  await expect(page.locator('#rv-coarse-evidence')).toContainText(dangerousLabel);
  expect(await page.evaluate(() => window.__xssFired)).toBeUndefined();

  // Clicking Edit is the exact action that would fire an injected inline-onclick payload.
  await page.locator('#rv-coarse-evidence').getByRole('button', { name: 'Edit', exact: true }).click();
  expect(await page.evaluate(() => window.__xssFired)).toBeUndefined();
  await expect(page.locator('#coarse-evidence-overlay')).toHaveClass(/open/);
  // The correct record opened — the id round-tripped exactly through the data attribute.
  await expect(page.locator('#cle-label')).toHaveValue(dangerousLabel);
  await expect(page.locator('#cle-minutes')).toHaveValue('42');
  await page.locator('#coarse-evidence-overlay').getByRole('button', { name: 'Cancel', exact: true }).click();

  // Remove is the other exploitable action; must also target the correct record, no script fires.
  await page.locator('#rv-coarse-evidence').getByRole('button', { name: 'Remove', exact: true }).click();
  expect(await page.evaluate(() => window.__xssFired)).toBeUndefined();
  await expect(page.locator('#rv-coarse-evidence')).not.toContainText(dangerousLabel);
  // Durability V1: remove() tombstones (deleted:true) rather than erasing the row — see the
  // "remove deletes only the coarse assertion" test above for why. Still gone from ordinary reads.
  const records = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('ta3-coarse-life-evidence-v1')).records));
  expect(records.filter(r => !r.deleted).length).toBe(0);
});

for (const [label, storedValue] of [
  ['invalid JSON', 'not valid json{{{'],
  ['unsupported schemaVersion', JSON.stringify({ schemaVersion: 99, records: {} })],
  ['a structurally invalid record', JSON.stringify({ schemaVersion: 1, records: { bad: { id: 'bad', date: 'nonsense' } } })]
]) {
  test(`a corrupted coarse-evidence store (${label}) degrades only the widget — Review still opens and stays usable`, async ({ page }) => {
    await openApp(page);
    await page.evaluate(value => localStorage.setItem('ta3-coarse-life-evidence-v1', value), storedValue);
    await openReviewFor(page, DATE);

    await expect(page.locator('#review-overlay')).toHaveClass(/open/);
    await expect(page.locator('#rv-coarse-evidence')).toContainText('unavailable');
    // Core Review controls remain fully usable.
    await page.fill('#rv-win', 'Still usable');
    await expect(page.locator('#rv-win')).toHaveValue('Still usable');
    // The corrupted store is left exactly as-is — never auto-repaired or wiped.
    const raw = await page.evaluate(() => localStorage.getItem('ta3-coarse-life-evidence-v1'));
    expect(raw).toBe(storedValue);
  });
}
