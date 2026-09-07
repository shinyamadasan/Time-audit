import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIFE_LEDGER_RUNTIME_KEY } from '../life-ledger-runtime.js';
import { deriveLifeLedgerKey, fingerprintLifeLedgerEvent } from '../life-ledger-core.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';

test.beforeAll(async () => {
  appServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = path.resolve(APP_ROOT, `.${decodeURIComponent(pathname)}`);
      if (!filePath.startsWith(APP_ROOT)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      const contentType = ext === '.html' ? 'text/html'
        : ext === '.js' ? 'application/javascript'
          : ext === '.css' ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${appServer.address().port}/index.html`;
});

test.afterAll(async () => {
  if (appServer) await new Promise(resolve => appServer.close(resolve));
});

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const makeRef = refPath => ({
    path: refPath,
    child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) { if (eventName === 'value') setTimeout(() => cb(snapshot(null)), 0); return cb; },
    off() {}, once() { return Promise.resolve(snapshot(null)); },
    update() { return Promise.resolve(); }, set() { return Promise.resolve(); }, remove() { return Promise.resolve(); },
    push(value) { const p = makeRef(refPath + '/pushed'); p.key = 'pushed'; if (value !== undefined) p.set(value); return p; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  const auth = () => ({
    onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'life-user', displayName: 'Life User', email: 'life@example.test', photoURL: '' }), 0); return () => {}; },
    signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); }
  });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = {
    apps: [], initializeApp(config) { const app = { config }; this.apps.push(app); return app; },
    app() { return this.apps[0] || this.initializeApp({}); },
    database() { return { ref: makeRef }; }, auth
  };
})();
`;

function baseSettings() {
  return {
    hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [],
    timezone: 'UTC', activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00',
    sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: []
  };
}

const DAY = '2026-02-10';
function uuid(n) { return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`; }

function mkEvent(o) {
  const event = {
    schemaVersion: 1,
    eventId: o.eventId,
    sourceApp: o.sourceApp,
    sourceEntityId: o.id,
    type: o.type,
    recordedAt: o.recordedAt || o.occurredAt || `${o.occurredDate}T12:00:00.000Z`,
    revisedAt: null,
    revision: 1,
    sourceTimezone: o.tz || 'Etc/UTC',
    payload: o.payload,
    provenance: {
      source: o.sourceApp,
      sourceRecordKind: `${o.sourceApp}.record`,
      adapterVersion: 'test-v1',
      observedAt: '2026-02-11T00:00:00.000Z',
      evidence: [`${o.sourceApp}.evidence:${o.id}`]
    },
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: o.tombstone || { active: false, deletedAt: null, reason: null, provenance: null }
  };
  if (o.occurredDate) {
    event.occurredDate = o.occurredDate;
    event.temporalPrecision = 'date';
  } else {
    event.occurredAt = o.occurredAt;
  }
  return event;
}

function mixedDayEvents() {
  return [
    mkEvent({ eventId: uuid(1), sourceApp: 'meal', id: 'mc-1', type: 'meal_consumed', occurredAt: `${DAY}T08:15:00.000Z`,
      payload: { mealName: 'Chicken Rice Bowl', consumedAt: `${DAY}T08:15:00.000Z`, portionCount: 1, cookedMealId: 'cm-1' } }),
    mkEvent({ eventId: uuid(2), sourceApp: 'chronasense', id: 'act-1', type: 'activity_logged', occurredAt: `${DAY}T09:45:00.000Z`,
      payload: { activity: 'Deep work — Client automation', category: 'deep', startedAt: `${DAY}T09:00:00.000Z`, endedAt: `${DAY}T09:45:00.000Z`, durationMinutes: 45 } }),
    mkEvent({ eventId: uuid(3), sourceApp: 'chronasense', id: 'focus-1', type: 'focus_session_completed', occurredAt: `${DAY}T10:32:00.000Z`,
      payload: { activity: 'Focus session', startedAt: `${DAY}T10:00:00.000Z`, endedAt: `${DAY}T10:32:00.000Z`, durationMinutes: 32, additiveForTimeTotals: false } }),
    mkEvent({ eventId: uuid(4), sourceApp: 'chronasense', id: 'plan-1:step-a', type: 'plan_step_completed', occurredAt: `${DAY}T10:35:00.000Z`,
      payload: { planDate: DAY, stepLabel: 'Build first webhook', completedAt: `${DAY}T10:35:00.000Z`, source: { planTitle: 'AI Automation Roadmap' } } }),
    mkEvent({ eventId: uuid(5), sourceApp: 'workout', id: 'wk-1', type: 'workout_completed', occurredAt: `${DAY}T18:42:00.000Z`,
      payload: { workoutName: 'Upper Body', startedAt: `${DAY}T18:00:00.000Z`, endedAt: `${DAY}T18:42:00.000Z`, durationMinutes: 42 } }),
    mkEvent({ eventId: uuid(6), sourceApp: 'meal', id: 'cm-2', type: 'meal_prepared', occurredDate: DAY,
      payload: { mealName: 'Overnight Oats', preparedDate: DAY, portionsPrepared: 4 } })
  ];
}

function envelope(events) {
  return JSON.stringify({
    schemaVersion: 1,
    records: events.map(event => ({
      key: deriveLifeLedgerKey(event),
      event,
      fingerprint: fingerprintLifeLedgerEvent(event)
    }))
  });
}

async function openApp(page, { lifeLedgerRaw = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: firebaseStub
  }));
  await page.addInitScript(({ lifeLedgerRaw, settings, key }) => {
    if (localStorage.getItem('ta3-life-feed-test-seeded')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', 'UTC');
    localStorage.setItem('ta3-settings', JSON.stringify(settings));
    localStorage.setItem('ta3-entries', '[]');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-plans', '{}');
    localStorage.setItem('ta3-reviews', '{}');
    if (lifeLedgerRaw !== null) localStorage.setItem(key, lifeLedgerRaw);
    localStorage.setItem('ta3-life-feed-test-seeded', '1');
  }, { lifeLedgerRaw, settings: baseSettings(), key: LIFE_LEDGER_RUNTIME_KEY });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.renderLifeFeed === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function openLife(page) {
  await page.locator('#nav-life').click();
  await expect(page.locator('#view-life')).toHaveClass(/active/);
  // Phase 7: the Life view opens on the Character Sheet; these tests exercise the Timeline.
  await page.locator('#life-subnav-timeline').click();
  await expect(page.locator('#life-feed-root')).toBeVisible();
}

test('empty ledger shows a useful, honest empty state (no over-promised domains)', async ({ page }) => {
  await openApp(page);
  await openLife(page);
  const empty = page.locator('.life-feed-empty');
  await expect(empty).toContainText('learning step');
  await expect(empty).toContainText('focus session');
  // must NOT claim time-logging / workouts / meals populate the feed today
  await expect(empty).not.toContainText(/work out|meal|prep/i);
  await expect(page.locator('.life-feed-item')).toHaveCount(0);
});

test('the Life tab subtitle is honest about which domains are live today', async ({ page }) => {
  await openApp(page);
  await openLife(page);
  const subtitle = page.locator('#view-life .life-feed-subtitle');
  await expect(subtitle).toContainText('Learning steps and focus sessions appear now');
  await expect(subtitle).toContainText(/integrations are connected/i);
});

// NOTE: the skipped-event footnote ("N Ledger events could not be displayed") is defensive.
// The runtime Life Ledger store validates every record on read (life-ledger-runtime.js), so
// `listEvents()` can only ever return well-formed events of a known type — feed.skipped is
// unreachable through the product today. Its reason-neutral wording is asserted at the source
// level (grep in the model regression) and its detailed `reason` codes are covered by
// life-feed-model.test.js.

test('a mixed-life day renders every fact once, in chronological order, with correct domains', async ({ page }) => {
  await openApp(page, { lifeLedgerRaw: envelope(mixedDayEvents()) });
  await openLife(page);

  await expect(page.locator('.life-feed-item')).toHaveCount(6);
  await expect(page.locator('.life-feed-day-header').first()).toContainText('Feb 10');

  const titles = await page.locator('.life-feed-item .life-feed-title').allTextContents();
  expect(titles).toEqual([
    'Prepared Overnight Oats',
    'Ate Chicken Rice Bowl',
    'Deep work — Client automation',
    'Focus session',
    'Completed: Build first webhook',
    'Upper Body'
  ]);

  const domains = await page.locator('.life-feed-item .life-feed-domain-tag').allTextContents();
  expect(domains).toEqual(['Meal', 'Meal', 'Time', 'Time', 'Learning', 'Workout']);

  // date-only meal_prepared shows NO clock time
  const preparedRow = page.locator('.life-feed-item', { hasText: 'Prepared Overnight Oats' });
  await expect(preparedRow.locator('.life-feed-time')).toHaveClass(/life-feed-time-none/);
  // meal_consumed does show a time
  const consumedRow = page.locator('.life-feed-item', { hasText: 'Ate Chicken Rice Bowl' });
  await expect(consumedRow.locator('.life-feed-time')).toHaveText('08:15');
});

test('domain filters narrow to a subset and expose an aria-selected state', async ({ page }) => {
  await openApp(page, { lifeLedgerRaw: envelope(mixedDayEvents()) });
  await openLife(page);

  await page.locator('[data-life-feed-domain="workout"]').click();
  await expect(page.locator('.life-feed-item')).toHaveCount(1);
  await expect(page.locator('.life-feed-item .life-feed-title')).toHaveText('Upper Body');
  await expect(page.locator('[data-life-feed-domain="workout"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-life-feed-domain="all"]')).toHaveAttribute('aria-selected', 'false');

  // a filter with zero matches shows a domain-specific empty state
  await page.locator('[data-life-feed-domain="learning"]').click();
  await expect(page.locator('.life-feed-item')).toHaveCount(1);
  await page.locator('[data-life-feed-domain="time"]').click();
  await expect(page.locator('.life-feed-item')).toHaveCount(2);

  await page.locator('[data-life-feed-domain="all"]').click();
  await expect(page.locator('.life-feed-item')).toHaveCount(6);
});

test('a filter with no matches shows a domain-specific empty message', async ({ page }) => {
  const onlyWorkout = [mixedDayEvents()[4]];
  await openApp(page, { lifeLedgerRaw: envelope(onlyWorkout) });
  await openLife(page);
  await page.locator('[data-life-feed-domain="meal"]').click();
  await expect(page.locator('.life-feed-empty')).toContainText('No Meal events');
});

test('tombstoned events do not appear in the feed', async ({ page }) => {
  const events = mixedDayEvents();
  events[4] = mkEvent({
    eventId: uuid(5), sourceApp: 'workout', id: 'wk-1', type: 'workout_completed', occurredAt: `${DAY}T18:42:00.000Z`,
    payload: { workoutName: 'Deleted Session', startedAt: `${DAY}T18:00:00.000Z`, endedAt: `${DAY}T18:42:00.000Z`, durationMinutes: 42 },
    tombstone: {
      active: true, deletedAt: `${DAY}T20:00:00.000Z`, reason: 'user_delete',
      provenance: { sourceOperation: 'delete', sourceRecordKind: 'workout.record', evidence: ['workout.evidence:wk-1:deleted'] }
    }
  });
  await openApp(page, { lifeLedgerRaw: envelope(events) });
  await openLife(page);
  await expect(page.locator('.life-feed-item')).toHaveCount(5);
  await expect(page.locator('#life-feed-root')).not.toContainText('Deleted Session');
});

test('hostile HTML in an event title is rendered as text, never executed', async ({ page }) => {
  const events = [mkEvent({
    eventId: uuid(9), sourceApp: 'chronasense', id: 'act-x', type: 'activity_logged', occurredAt: `${DAY}T09:45:00.000Z`,
    payload: {
      activity: '<img src=x onerror=alert(1)> <script>alert(2)</script> 日本語 🚀',
      category: 'deep', startedAt: `${DAY}T09:00:00.000Z`, endedAt: `${DAY}T09:45:00.000Z`, durationMinutes: 45
    }
  })];
  await openApp(page, { lifeLedgerRaw: envelope(events) });
  await openLife(page);
  await expect(page.locator('.life-feed-title')).toContainText('日本語');
  expect(await page.locator('#life-feed-root script').count()).toBe(0);
  expect(await page.locator('#life-feed-root img').count()).toBe(0);
});

test('the feed is read-only: viewing and filtering never rewrite the Life Ledger', async ({ page }) => {
  const raw = envelope(mixedDayEvents());
  await openApp(page, { lifeLedgerRaw: raw });
  await openLife(page);
  await page.locator('[data-life-feed-domain="meal"]').click();
  await page.locator('[data-life-feed-domain="all"]').click();
  await page.locator('#nav-today').click();
  await openLife(page);
  const stored = await page.evaluate(key => localStorage.getItem(key), LIFE_LEDGER_RUNTIME_KEY);
  expect(stored).toBe(raw);
});

test('filter chips are keyboard operable and the feed region announces changes', async ({ page }) => {
  await openApp(page, { lifeLedgerRaw: envelope(mixedDayEvents()) });
  await openLife(page);
  await expect(page.locator('#life-feed-root')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('.life-feed-filters')).toHaveAttribute('role', 'tablist');

  const workoutChip = page.locator('[data-life-feed-domain="workout"]');
  await workoutChip.focus();
  await workoutChip.press('Enter');
  await expect(page.locator('.life-feed-item')).toHaveCount(1);
  await expect(workoutChip).toBeFocused();
});
