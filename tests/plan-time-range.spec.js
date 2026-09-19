// Plan Time Range + Faster Scheduling V1 — an optional start+length ("9:00–10:30 AM") on top of
// Quick Time V1's start-only `when`, plus quick preset chips for both. Harness mirrors
// tests/plan-tomorrow-ui.spec.js (same firebase stub, same localStorage seeding contract) since
// this feature lives inside the same Plan Tomorrow editor.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';
const NOW = Date.parse('2026-09-08T18:00:00Z');
const TODAY = '2026-09-08';
const TARGET = '2026-09-09';
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
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'plan-user', displayName: 'Plan User', email: 'plan@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(config) { const app = { config }; this.apps.push(app); return app; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
})();`;

const routineState = (routines = [], timezone = 'Etc/UTC', extra = {}) => ({ schemaVersion: 1, timezone, routines, manual: {}, links: {}, focus: {}, skips: {}, ...extra });
const planItem = (id, task, extra = {}) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: NOW, updatedBy: 'device-test', ...extra });

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

async function openApp(page, { plans = {}, entries = [], routines = routineState([]), deviceId = 'device-test', viewport = null } = {}) {
  if (viewport) await page.setViewportSize(viewport);
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ plans, entries, now, deviceId }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', 'Etc/UTC');
    localStorage.setItem('ta3-device-id', deviceId);
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone: 'Etc/UTC', hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', JSON.stringify(entries)); localStorage.setItem('ta3-focus-redemptions', '[]'); localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-plans', JSON.stringify(plans));
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify(routines));
  }, { plans, entries, routines, now: NOW, deviceId });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof openPlanTomorrow === 'function' && typeof getPlanTomorrowAppContext === 'function');
  await page.evaluate(() => { document.getElementById('today-commitments').hidden = false; });
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function openPlanTomorrowWith(page, items) {
  await openApp(page, { plans: { [TARGET]: { items, updatedAt: NOW } } });
  await page.evaluate(() => openPlanTomorrow());
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
}

async function storedItems(page) {
  const stored = await page.evaluate(target => JSON.parse(localStorage.getItem('ta3-plans'))[target], TARGET);
  return stored.items.filter(item => !item.deleted);
}

test.describe('Quick scheduling', () => {
  test('quick start sets the canonical when and keeps the panel open so a length can follow', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work')]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Set time for Deep work' }).click();
    await page.getByRole('button', { name: '9 AM', exact: true }).click();
    await expect(page.locator('.pt-time-input')).toHaveValue('09:00'); // still open — length row now visible
    await expect(page.getByRole('button', { name: '30m', exact: true })).toBeVisible();
  });

  test('quick length sets durationMinutes, converges on the same stored field as custom input, and closes the panel', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00' })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.getByRole('button', { name: '1.5h', exact: true }).click();
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('9:00–10:30 AM');
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const items = await storedItems(page);
    expect(items[0].when).toBe('09:00');
    expect(items[0].durationMinutes).toBe(90);
  });

  test('custom start via the native picker and custom end via a second native picker converge on when + durationMinutes', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work')]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Set time for Deep work' }).click();
    await page.locator('.pt-time-input').fill('09:00');
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('9:00 AM');
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.locator('.pt-end-input').fill('10:15');
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('9:00–10:15 AM');
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const items = await storedItems(page);
    expect(items[0].when).toBe('09:00');
    expect(items[0].durationMinutes).toBe(75);
  });

  test('a custom end at or before the start is rejected with an inline error and never stored', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00' })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.locator('.pt-end-input').fill('08:30');
    await expect(page.locator('#plan-tomorrow-error')).toHaveText('End time must be later than the start, on the same day.');
    // The rejected edit never touched draft state — the panel stays open, still showing the
    // valid original start, rather than silently closing or fabricating a range.
    await expect(page.locator('.pt-time-input')).toHaveValue('09:00');
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const items = await storedItems(page);
    expect(items[0].when).toBe('09:00');
    expect('durationMinutes' in items[0]).toBe(false);
  });
});

// FIX FIRST — write-time range validation. Prior to this fix, invalid ranges could be stamped
// into draft state (and then persisted) by quick-duration chips, a changed start left behind a
// hidden duration, and custom-end had no upper bound. All three write paths now validate BEFORE
// mutating draft.items, so a rejected attempt always leaves the last-known-good schedule intact.
test.describe('Write-time range validation (FIX FIRST)', () => {
  test('Blocker 1: quick length rejects a cross-midnight duration, preserving an existing valid range', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '23:00', durationMinutes: 30 })]);
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('11:00–11:30 PM');
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await expect(page.getByRole('button', { name: '30m', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '2h', exact: true }).click();
    await expect(page.locator('#plan-tomorrow-error')).toHaveText('That length would run past midnight. Choose a shorter length.');
    // The rejected click never touched draft state: 30m is still selected, the custom end still
    // reflects the prior valid end — nothing was silently changed or cleared.
    await expect(page.getByRole('button', { name: '30m', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.pt-end-input')).toHaveValue('23:30');
    // Keyboard-activate confirm (focus + Enter) rather than a mouse click: the still-open panel is
    // about to collapse as a side effect of losing focus, and a coordinate-based click can race that
    // layout shift. Enter on the already-focused button is immune to where it ends up on screen.
    await page.locator('#plan-tomorrow-confirm').focus();
    await page.keyboard.press('Enter');
    const items = await storedItems(page);
    expect(items[0].when).toBe('23:00');
    expect(items[0].durationMinutes).toBe(30);
  });

  test('Blocker 1: quick length rejects a cross-midnight duration when there is no prior range, leaving the item start-only', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Late task', { when: '23:00' })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Late task' }).click();
    await page.getByRole('button', { name: '2h', exact: true }).click();
    await expect(page.locator('#plan-tomorrow-error')).toHaveText('That length would run past midnight. Choose a shorter length.');
    await page.locator('#plan-tomorrow-confirm').focus();
    await page.keyboard.press('Enter');
    const items = await storedItems(page);
    expect(items[0].when).toBe('23:00');
    expect('durationMinutes' in items[0]).toBe(false);
  });

  test('Blocker 2: changing start via a quick-start chip preserves a still-valid existing duration', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00', durationMinutes: 120 })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.getByRole('button', { name: '10 AM', exact: true }).click();
    await expect(page.locator('.pt-end-input')).toHaveValue('12:00'); // still open — duration preserved
    await page.locator('#plan-tomorrow-date').click(); // click away to collapse
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('10:00 AM–12:00 PM');
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const items = await storedItems(page);
    expect(items[0].when).toBe('10:00');
    expect(items[0].durationMinutes).toBe(120);
  });

  test('Blocker 2: changing start via the native input clears a now-invalid duration in the same mutation, and it never resurrects', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00', durationMinutes: 120 })]);
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('9:00–11:00 AM');
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.locator('.pt-time-input').fill('23:00');
    // The native start input closing the panel is existing precedent; the collapsed view must show
    // start-only, never a hidden/garbage range, and no "Remove range" control since there is none.
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('11:00 PM');
    await expect(page.locator('.pt-oneoff').getByRole('button', { name: 'Remove range for Deep work' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    let items = await storedItems(page);
    expect(items[0].when).toBe('23:00');
    expect('durationMinutes' in items[0]).toBe(false);

    // Reopen and change the start back to 09:00 — the old 120-minute duration must not resurrect.
    await page.evaluate(() => openPlanTomorrow());
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.locator('.pt-time-input').fill('09:00');
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('9:00 AM');
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    items = await storedItems(page);
    expect(items[0].when).toBe('09:00');
    expect('durationMinutes' in items[0]).toBe(false);
  });

  test('Blocker 3: custom end enforces the 720-minute cap — 720 accepted, 721 and 780 rejected, prior valid range preserved', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Long block', { when: '06:00' })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Long block' }).click();
    await page.locator('.pt-end-input').fill('18:00'); // exactly 720 minutes — accepted
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('6:00 AM–6:00 PM');

    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Long block' }).click();
    await page.locator('.pt-end-input').fill('18:01'); // 721 minutes — rejected
    await expect(page.locator('#plan-tomorrow-error')).toHaveText('End time must be within 12 hours of the start.');
    await page.locator('#plan-tomorrow-date').click(); // let the panel settle/collapse before confirming
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('6:00 AM–6:00 PM');
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    let items = await storedItems(page);
    expect(items[0].durationMinutes).toBe(720); // the rejected 721 attempt never overwrote the valid 720

    await page.evaluate(() => openPlanTomorrow());
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Long block' }).click();
    await page.locator('.pt-end-input').fill('19:00'); // 780 minutes — the exact reported defect
    await expect(page.locator('#plan-tomorrow-error')).toHaveText('End time must be within 12 hours of the start.');
    await page.locator('#plan-tomorrow-date').click();
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('6:00 AM–6:00 PM');
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    items = await storedItems(page);
    expect(items[0].when).toBe('06:00');
    expect(items[0].durationMinutes).toBe(720);
  });

  test('persistence safety: confirming immediately after a rejected scheduling attempt never persists invalid range state', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '23:00', durationMinutes: 30 })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.getByRole('button', { name: '2h', exact: true }).click(); // rejected: crosses midnight
    await expect(page.locator('#plan-tomorrow-error')).toBeVisible();
    // Keyboard-activate confirm immediately — this test's whole point is confirming right after a
    // rejected attempt, without waiting for the panel to visually settle first.
    await page.locator('#plan-tomorrow-confirm').focus();
    await page.keyboard.press('Enter');
    const items = await storedItems(page);
    // Whatever persisted must itself be a valid range (or none) — never the rejected 120.
    expect(items[0].when).toBe('23:00');
    expect(items[0].durationMinutes).toBe(30);
    expect(items[0].durationMinutes).not.toBe(120);
  });
});

test.describe('Editing states', () => {
  test('untimed -> add start only leaves no range', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work')]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Set time for Deep work' }).click();
    await page.getByRole('button', { name: '10 AM', exact: true }).click();
    await page.locator('#plan-tomorrow-date').click(); // click away — leave length unset
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('10:00 AM');
    await expect(page.locator('.pt-oneoff').getByRole('button', { name: 'Remove range for Deep work' })).toHaveCount(0);
  });

  test('untimed -> add start + range in one fluid two-tap flow', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work')]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Set time for Deep work' }).click();
    await page.getByRole('button', { name: 'Noon', exact: true }).click();
    await page.getByRole('button', { name: '1h', exact: true }).click();
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('12:00–1:00 PM');
  });

  test('start-only -> add range keeps the same start', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00' })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.getByRole('button', { name: '2h', exact: true }).click();
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('9:00–11:00 AM');
  });

  test('start-only -> change start', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00' })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.getByRole('button', { name: '2 PM', exact: true }).click();
    await page.locator('#plan-tomorrow-date').click();
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('2:00 PM');
  });

  test('ranged -> change start shifts the whole block, keeping the same length', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00', durationMinutes: 60 })]);
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('9:00–10:00 AM');
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.locator('.pt-time-input').fill('10:00');
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('10:00–11:00 AM');
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const items = await storedItems(page);
    expect(items[0].when).toBe('10:00');
    expect(items[0].durationMinutes).toBe(60);
  });

  test('ranged -> change end/duration', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00', durationMinutes: 60 })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.getByRole('button', { name: '30m', exact: true }).click();
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('9:00–9:30 AM');
  });

  test('ranged -> remove range but keep start', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00', durationMinutes: 90 })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Remove range for Deep work' }).click();
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('9:00 AM');
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const items = await storedItems(page);
    expect(items[0].when).toBe('09:00');
    expect('durationMinutes' in items[0]).toBe(false);
  });

  test('start-only/ranged -> remove all timing never deletes the priority, and clears both fields', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00', durationMinutes: 90 })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Remove time for Deep work' }).click();
    await expect(page.locator('.pt-oneoff').getByRole('button', { name: 'Set time for Deep work' })).toHaveText('+ Add time');
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const items = await storedItems(page);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('p1');
    expect(items[0].when).toBe('');
    expect('durationMinutes' in items[0]).toBe(false);
  });

  test('close -> reopen restores the stored range exactly, chip and custom end preselected', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00', durationMinutes: 90 })]);
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('9:00–10:30 AM');
    await page.locator('[data-pt-action="close"]').first().click();
    await page.evaluate(() => openPlanTomorrow());
    await expect(page.locator('.pt-oneoff .pt-time-value')).toHaveText('9:00–10:30 AM');
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await expect(page.locator('.pt-time-input')).toHaveValue('09:00');
    await expect(page.getByRole('button', { name: '1.5h', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.pt-end-input')).toHaveValue('10:30');
  });
});

test.describe('Persistence and identity', () => {
  test('quick and custom paths converge on the exact same stored fields — no separate quick/custom/preset fields', async ({ page }) => {
    await openPlanTomorrowWith(page, [
      planItem('quick', 'Set via chips'),
      planItem('custom', 'Set via native inputs')
    ]);
    const quickRow = page.locator('.pt-oneoff', { hasText: 'Set via chips' });
    await quickRow.getByRole('button', { name: 'Set time for Set via chips' }).click();
    await page.getByRole('button', { name: '9 AM', exact: true }).first().click();
    await page.getByRole('button', { name: '1h', exact: true }).first().click();

    const customRow = page.locator('.pt-oneoff', { hasText: 'Set via native inputs' });
    await customRow.getByRole('button', { name: 'Set time for Set via native inputs' }).click();
    await page.locator('.pt-time-input').fill('09:00');
    await customRow.getByRole('button', { name: 'Change time for Set via native inputs' }).click();
    await page.locator('.pt-end-input').fill('10:00');

    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const items = await storedItems(page);
    const quick = items.find(i => i.id === 'quick');
    const custom = items.find(i => i.id === 'custom');
    expect(quick.when).toBe('09:00');
    expect(quick.durationMinutes).toBe(60);
    expect(custom.when).toBe('09:00');
    expect(custom.durationMinutes).toBe(60);
    expect(Object.keys(quick).sort()).toEqual(Object.keys(custom).sort());
  });

  test('every schedule mutation preserves the stable item id, and same-title items stay independent', async ({ page }) => {
    await openPlanTomorrowWith(page, [
      planItem('p1', 'Duplicate title', { when: '09:00' }),
      planItem('p2', 'Duplicate title')
    ]);
    const first = page.locator('.pt-oneoff').first();
    await first.getByRole('button', { name: 'Change time for Duplicate title' }).click();
    await page.getByRole('button', { name: '1h', exact: true }).first().click();
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const items = await storedItems(page);
    expect(items.map(i => i.id).sort()).toEqual(['p1', 'p2']);
    expect(items.find(i => i.id === 'p1').durationMinutes).toBe(60);
    expect(items.find(i => i.id === 'p2').durationMinutes).toBeUndefined();
  });

  test('double confirmation with a range never duplicates the item', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work')]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Set time for Deep work' }).click();
    await page.getByRole('button', { name: '9 AM', exact: true }).click();
    await page.getByRole('button', { name: '1h', exact: true }).click();
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    await page.evaluate(() => openPlanTomorrow());
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const items = await storedItems(page);
    expect(items).toHaveLength(1);
    expect(items[0].durationMinutes).toBe(60);
  });
});

test.describe('Planning Streak and Open Day regression', () => {
  test('every schedule action alone writes no preparation; only confirm does', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work')]);
    const noPrep = async () => expect(await page.evaluate(target => JSON.parse(localStorage.getItem('ta3-plans'))[target]?.preparation, TARGET)).toBeUndefined();
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Set time for Deep work' }).click();
    await noPrep();
    await page.getByRole('button', { name: '9 AM', exact: true }).click();
    await noPrep();
    await page.getByRole('button', { name: '1h', exact: true }).click();
    await noPrep();
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    await page.locator('.pt-end-input').fill('10:30');
    await noPrep();
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Remove range for Deep work' }).click();
    await noPrep();
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Remove time for Deep work' }).click();
    await noPrep();
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const preparation = await page.evaluate(target => JSON.parse(localStorage.getItem('ta3-plans'))[target].preparation, TARGET);
    expect(preparation).toMatchObject({ lastPreparedMode: 'normal', intentionalBlank: false });
  });
});

test.describe('Today integration', () => {
  test('Today shows the formatted range once the target date is Today, and sorting still uses when alone', async ({ page }) => {
    await openApp(page, { plans: { [TODAY]: { items: [
      planItem('p1', 'Later item', { when: '13:00', durationMinutes: 30 }),
      planItem('p2', 'Earlier item', { when: '09:00', durationMinutes: 90 })
    ], updatedAt: NOW } } });
    const rows = page.locator('.plan-item');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('9:00–10:30 AM');
    await expect(rows.nth(0)).toContainText('Earlier item');
    await expect(rows.nth(1)).toContainText('1:00–1:30 PM');
    await expect(rows.nth(1)).toContainText('Later item');
  });
});

test.describe('Tomorrow View integration', () => {
  test('renders untimed, start-only, and ranged priorities correctly and remains read-only', async ({ page }) => {
    await openApp(page, {
      plans: {
        [TARGET]: {
          items: [
            planItem('u1', 'Untimed one'),
            planItem('s1', 'Start only', { when: '09:00' }),
            planItem('r1', 'Ranged one', { when: '11:30', durationMinutes: 90 }),
            planItem('m1', 'Malformed range', { when: '14:00', durationMinutes: -5 })
          ],
          updatedAt: NOW,
          preparation: { schemaVersion: 1, targetDate: TARGET, timezone: 'Etc/UTC', firstPreparedAt: NOW, firstPreparedBy: 'device-test', firstPreparedMode: 'normal', lastPreparedAt: NOW, lastPreparedMode: 'normal', updatedBy: 'device-test', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['u1', 's1', 'r1', 'm1'] }
        }
      }
    });
    await page.locator('#tmr-tab-tomorrow').click();
    const rows = page.locator('#tomorrow-view .tmr-row');
    await expect(rows.filter({ hasText: 'Untimed one' }).locator('.tmr-row-time')).toHaveText('—');
    await expect(rows.filter({ hasText: 'Start only' }).locator('.tmr-row-time')).toHaveText('9:00 AM');
    await expect(rows.filter({ hasText: 'Ranged one' }).locator('.tmr-row-time')).toHaveText('11:30 AM–1:00 PM');
    // Malformed duration (-5) fails safely to start-only display, never a crash or garbage range.
    await expect(rows.filter({ hasText: 'Malformed range' }).locator('.tmr-row-time')).toHaveText('2:00 PM');
    const before = await page.evaluate(target => localStorage.getItem('ta3-plans'), TARGET);
    await page.locator('[data-tmr-action="open"]').click();
    await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
    const after = await page.evaluate(() => localStorage.getItem('ta3-plans'));
    expect(after).toBe(before); // opening for edit never itself wrote anything
  });
});

test.describe('Daily Reconciliation integration', () => {
  test('carry-forward clears both when and durationMinutes — a carried item is always unscheduled', async ({ page }) => {
    await openApp(page, { plans: { [TODAY]: { items: [planItem('open-1', 'Write follow-up', { when: '09:00', durationMinutes: 90 })] } } });
    await page.evaluate(() => openPlanTomorrow());
    await page.locator('[data-pt-reconcile-item="open-1"] [data-pt-action="carry"]').click();
    await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
    const tomorrow = await page.evaluate(target => JSON.parse(localStorage.getItem('ta3-plans'))[target], TARGET);
    const carried = tomorrow.items.find(item => !item.deleted);
    expect(carried.task).toBe('Write follow-up');
    expect(carried.when).toBe('');
    expect('durationMinutes' in carried).toBe(false);
  });
});

test.describe('Accessibility and mobile', () => {
  test('quick chips are real buttons with a visible, non-color-only selected state and aria-pressed', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00', durationMinutes: 90 })]);
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for Deep work' }).click();
    const startChip = page.getByRole('button', { name: '9 AM', exact: true });
    await expect(startChip).toHaveJSProperty('tagName', 'BUTTON');
    await expect(startChip).toHaveAttribute('aria-pressed', 'true');
    await expect(startChip).toHaveClass(/selected/);
    const lengthChip = page.getByRole('button', { name: '1.5h', exact: true });
    await expect(lengthChip).toHaveAttribute('aria-pressed', 'true');
    // Keyboard reachable: Tab from the custom start input lands on the length controls, not off the panel.
    await page.locator('.pt-time-input').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-pt-schedule-panel="p1"]')).toBeVisible(); // still open, focus stayed within
  });

  test('Remove range and Remove time are clearly distinct controls', async ({ page }) => {
    await openPlanTomorrowWith(page, [planItem('p1', 'Deep work', { when: '09:00', durationMinutes: 90 })]);
    const row = page.locator('.pt-oneoff');
    await expect(row.getByRole('button', { name: 'Remove range for Deep work' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Remove time for Deep work' })).toBeVisible();
  });

  test('at 390px the scheduling panel wraps with no horizontal overflow', async ({ page }) => {
    await openPlanTomorrowWith(page, [{ ...planItem('p1', 'A fairly long priority title that could wrap on a narrow phone screen', { when: '09:00' }) }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.pt-oneoff').getByRole('button', { name: 'Change time for A fairly long priority title that could wrap on a narrow phone screen' }).click();
    await expect(page.getByRole('button', { name: '30m', exact: true })).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });
});
