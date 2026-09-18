// Single Plan Authority V1 — the cross-consumer agreement gate.
//
// Every planning surface is asked, in a real browser, about the SAME governed
// day, and must answer with the same authoritative plan. Also covers the
// Prepared Plans recovery surface, the boundary-change warning, the Decision B
// history projection, and the hard legacy-account regression.
//
// Firebase is stubbed exactly as the other specs stub it — no real project, no
// network. Local persistence is the page's own localStorage.

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
const D = '2026-09-16';
const D_NEXT = '2026-09-17';
const EIGHT_AM = Date.parse('2026-09-16T08:00:00+08:00');
const SEVEN_PM = Date.parse('2026-09-16T19:00:00+08:00');

// 18:00 Manila enabled the previous day, so the day in progress at 19:00 D is
// an ordinary personal day (not the transition day).
const BOUNDARY_STORE = JSON.stringify({ schemaVersion: 1, revisions: {
  'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
  'r-1800': { id: 'r-1800', boundaryTime: '18:00', timezone: TZ, effectiveFromInstant: Date.parse('2026-09-15T18:00:00+08:00') },
} });

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
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'spa-user', displayName: 'SPA User', email: 'spa@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
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

const ROUTINES = (routines = []) => JSON.stringify({ schemaVersion: 1, timezone: TZ, routines, manual: {}, links: {}, focus: {}, skips: {} });

const routine = (id, extra) => ({
  id, title: id, enabled: true, createdDate: '2026-09-01', cadence: 'daily', days: [], mode: 'anytime',
  time: null, endTime: null, cue: null, targetMinutes: 30, minimumMinutes: null, fallback: '', source: 'manual', ...extra
});

async function openApp(page, { now = SEVEN_PM, boundaryStore = null, plans = '{}', entries = '[]', routines = ROUTINES(), useClock = false } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, boundaryStore, plans, entries, routines, useClock }) => {
    // When page.clock owns time (a long-lived session test), Date must NOT be
    // frozen — otherwise the clock advances while the app still reads one instant.
    if (!useClock) {
      const RealDate = Date;
      window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    }
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', timezone);
    localStorage.setItem('ta3-device-id', 'device-spa-test');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', entries);
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-plans', plans);
    localStorage.setItem('ta3-daily-routines-v1', routines);
    if (boundaryStore) localStorage.setItem('ta3-day-boundary-revisions-v1', boundaryStore);
  }, { timezone: TZ, now, boundaryStore, plans, entries, routines, useClock });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function addTodayPriority(page, task) {
  // The strip's editor is behind its own Edit toggle, exactly as in plan.spec.js.
  if (!(await page.locator('#plan-strip').getAttribute('class')).includes('editing')) {
    await page.locator('#plan-strip').getByRole('button', { name: 'Edit', exact: true }).click();
  }
  await page.locator('#plan-task').fill(task);
  await page.locator('#plan-strip').getByRole('button', { name: 'Add' }).click();
}

// ── the hard legacy regression ──────────────────────────────────────────────

test('a never-enabled account plans, prepares and reviews with no operational record, revision or listener', async ({ page }) => {
  await openApp(page, { now: EIGHT_AM });

  await addTodayPriority(page, 'Legacy priority');
  await expect(page.locator('#plan-strip')).toContainText('Legacy priority');

  await page.evaluate(() => openPlanTomorrow());
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Tomorrow priority');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  await page.evaluate(() => openReview());

  // Everything landed in the legacy store, and the new machinery stayed asleep.
  const state = await page.evaluate(() => ({
    plans: JSON.parse(localStorage.getItem('ta3-plans')),
    operational: localStorage.getItem('ta3-operational-plans-v1'),
    boundary: localStorage.getItem('ta3-day-boundary-revisions-v1'),
    attached: window.PersonalDayBoundaryLive.attachedDayIds(),
    enabled: window.PlanAuthority.enabled(),
    surfaceHidden: document.getElementById('operational-plan-section').hidden,
  }));
  expect(state.operational).toBeNull();
  expect(state.boundary).toBeNull();
  expect(state.attached).toEqual([]);
  expect(state.enabled).toBe(false);
  expect(state.surfaceHidden).toBe(true);
  expect(Object.keys(state.plans).sort()).toEqual([D, D_NEXT]);
  expect(state.plans[D_NEXT].preparation.targetDate).toBe(D_NEXT);

  // And the streak is literally the existing calendar function's answer.
  expect(await page.evaluate(() => {
    const tz = settings.timezone;
    return {
      authority: window.PlanAuthority.streak(),
      legacy: window.PlanTomorrowModel.planningStreak(plans, Date.now(), tz),
    };
  }).then(r => r.authority)).toEqual(await page.evaluate(() => window.PlanTomorrowModel.planningStreak(plans, Date.now(), settings.timezone)));
});

// ── the agreement gate ──────────────────────────────────────────────────────

test('every planning consumer answers with the same authoritative plan for a governed personal day', async ({ page }) => {
  await openApp(page, {
    now: SEVEN_PM,
    boundaryStore: BOUNDARY_STORE,
    // A stale calendar plan for the same date must never be what any consumer shows.
    plans: JSON.stringify({ [D]: { items: [{ id: 'legacy-1', task: 'STALE CALENDAR ITEM', when: '', done: false, doneAt: null, updatedAt: 1 }], updatedAt: 1 } }),
    routines: ROUTINES([routine('r-anytime'), routine('r-morning', { mode: 'exact', time: '07:00' })]),
  });

  // Plan the current personal day through the one editable workflow.
  await addTodayPriority(page, 'Personal day priority');
  await expect(page.locator('#plan-strip')).toContainText('Personal day priority');
  await expect(page.locator('#plan-strip')).not.toContainText('STALE CALENDAR ITEM');

  const answers = await page.evaluate(() => {
    const A = window.PlanAuthority;
    const current = A.current();
    const upcoming = A.upcoming();
    const routineRows = getPlanTomorrowRoutineSummary(current).rows;
    return {
      currentId: current.id,
      store: current.store,
      editorItems: planItemsFor(current).map(i => i.task),
      upNext: getNextPlanItem(current)?.task || null,
      commitment: (syncCommitmentFromPlan(), dailyCommitment),
      byInstant: A.containing(Date.now()).id,
      afterMidnight: A.containing(Date.parse('2026-09-17T00:30:00+08:00')).id,
      reconciliationSource: A.current().id,
      preparedStateTarget: A.preparedState(current).target.id,
      historyProjection: A.daysOverlappingCalendarDate('2026-09-16').map(t => t.id),
      partnerToday: buildPartnerViewPriorityInputs(current).map(p => p.title),
      partnerPublished: buildPartnerViewProjectionForPublish()?.today?.priorities?.map(p => p.title) || null,
      // An untimed routine on the NEXT calendar date belongs to this personal day
      // (noon anchor), a 07:00 one on the next date does too (it is inside the interval).
      routineOwners: routineRows.map(r => JSON.parse(r.id)[0]).sort(),
      upcomingId: upcoming.id,
      legacyStoreUntouched: JSON.parse(localStorage.getItem('ta3-plans'))['2026-09-16'].items.map(i => i.task),
      operationalIds: Object.keys(JSON.parse(localStorage.getItem('ta3-operational-plans-v1')).plans),
    };
  });

  expect(answers.store).toBe('operational');
  // One identity, from every angle.
  expect(new Set([answers.currentId, answers.byInstant, answers.afterMidnight, answers.reconciliationSource, answers.preparedStateTarget]).size).toBe(1);
  // The history projection for this calendar date is the TWO personal days that
  // overlap it (Decision B) — the one that ended at 18:00 and the current one —
  // never one merged plan, and the current day is one of them.
  expect(answers.historyProjection).toHaveLength(2);
  expect(answers.historyProjection).toContain(answers.currentId);
  expect(answers.operationalIds).toEqual([answers.currentId]);
  expect(answers.upcomingId).not.toBe(answers.currentId);
  // One plan, from every consumer.
  expect(answers.editorItems).toEqual(['Personal day priority']);
  expect(answers.upNext).toBe('Personal day priority');
  expect(answers.commitment).toBe(1);
  expect(answers.partnerToday).toEqual(['Personal day priority']);
  expect(answers.partnerPublished).toEqual(['Personal day priority']);
  // Routines are owned by the personal day that contains their instant / noon anchor.
  expect(answers.routineOwners).toEqual(['r-anytime', 'r-morning']);
  // The stale calendar record still exists on disk, untouched, and is authoritative for nobody.
  expect(answers.legacyStoreUntouched).toEqual(['STALE CALENDAR ITEM']);

  // Prepared/ready/streak all speak about the same upcoming day.
  await page.evaluate(() => openPlanTomorrow());
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Next personal day priority');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Next personal day is ready' }).click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);

  const prepared = await page.evaluate(() => {
    const A = window.PlanAuthority;
    const upcoming = A.upcoming();
    const record = JSON.parse(localStorage.getItem('ta3-operational-plans-v1')).plans[upcoming.id];
    return {
      upcomingId: upcoming.id,
      preparationTarget: record.preparation.targetOperationalDayId,
      consistency: A.consistency(upcoming),
      readyNow: A.readyNow(upcoming, []),
      streak: A.streak(),
      legacyTomorrowUntouched: JSON.parse(localStorage.getItem('ta3-plans'))['2026-09-17'] || null,
    };
  });
  expect(prepared.preparationTarget).toBe(prepared.upcomingId);
  expect(prepared.consistency).toBe('ahead');
  expect(prepared.readyNow).toBe(true);
  expect(prepared.streak.current).toBe(1);
  expect(prepared.legacyTomorrowUntouched).toBeNull();

  // Tomorrow View shows that exact plan.
  await page.locator('#tmr-tab-tomorrow').click();
  await expect(page.locator('#tomorrow-view')).toContainText('Next personal day priority');
  await expect(page.locator('#tomorrow-view')).toContainText('Prepared');
});

// ── a long-lived session across the boundary ────────────────────────────────

test('a page left open across 18:00 rotates the visible plan to the new personal day, with no reload', async ({ page }) => {
  await page.clock.install({ time: Date.parse('2026-09-16T17:58:30+08:00') });
  await openApp(page, { boundaryStore: BOUNDARY_STORE, useClock: true });

  // Prepare the upcoming day, then just sit there while 18:00 passes.
  await page.evaluate(() => {
    const A = window.PlanAuthority;
    A.saveItems(A.current(), [createPlanItem('Before the boundary', '')]);
    A.saveItems(A.upcoming(), [createPlanItem('After the boundary', '')]);
  });
  await expect(page.locator('#plan-strip')).toContainText('Before the boundary');

  const before = await page.evaluate(() => window.PlanAuthority.current().id);
  await page.clock.runFor('03:00'); // only the app's own 60s interval runs

  await expect(page.locator('#plan-strip')).toContainText('After the boundary');
  await expect(page.locator('#plan-strip')).not.toContainText('Before the boundary');
  const after = await page.evaluate(() => ({
    current: window.PlanAuthority.current().id,
    attached: window.PersonalDayBoundaryLive.attachedDayIds(),
  }));
  expect(after.current).not.toBe(before);
  expect(after.attached).toContain(after.current);
  expect(after.attached).not.toContain(before);
});

// ── Decision B: history shows the overlapping personal days, never a merge ──

test('a calendar date covered by two personal days renders both, labeled, in Review', async ({ page }) => {
  await openApp(page, { now: SEVEN_PM, boundaryStore: BOUNDARY_STORE });

  await page.evaluate(() => {
    const A = window.PlanAuthority;
    const current = A.current();               // 18:00 D -> 18:00 D+1
    const previous = A.containing(Date.parse('2026-09-16T10:00:00+08:00')); // 18:00 D-1 -> 18:00 D
    A.saveItems(previous, [createPlanItem('Morning-side plan', '')]);
    A.saveItems(current, [createPlanItem('Evening-side plan', '')]);
  });
  await page.evaluate(() => openReview());

  const pva = page.locator('#rv-plan-vs-actual');
  await expect(pva).toContainText('Morning-side plan');
  await expect(pva).toContainText('Evening-side plan');
  // Two separate cards, each naming its own personal-day window.
  expect(await page.locator('#rv-plan-vs-actual .rv-pva-window').count()).toBe(2);
  await expect(pva).toContainText('Personal day');
  await expect(pva).toContainText('→');
});

// ── Prepared Plans + the boundary-change warning ────────────────────────────

test('a boundary change that orphans a prepared day warns by name, then keeps the plan under Prepared plans', async ({ page }) => {
  await openApp(page, { now: EIGHT_AM, boundaryStore: BOUNDARY_STORE });

  // Prepare the upcoming personal day (18:00 D -> 18:00 D+1 starts at 18:00 today).
  await page.evaluate(() => openPlanTomorrow());
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Prepared night shift');
  await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Next personal day is ready' }).click();
  const orphanId = await page.evaluate(() => window.PlanAuthority.upcoming().id);

  // Nothing is stray while it is still reachable.
  expect(await page.evaluate(() => window.PlanAuthority.preparedPlans().length)).toBe(0);

  // Choosing a 10:00 boundary would push it out of current/upcoming.
  await page.evaluate(() => showView('settings'));
  const panel = page.locator('#personal-day-boundary-settings');
  await panel.locator('[data-pdb-input="time"]').fill('10:00');
  const warning = panel.locator('[data-pdb-orphan-warning]');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('already prepared');
  await expect(warning).toContainText('18:00');
  await expect(warning).toContainText('Prepared plans');
  // Still only a warning — nothing was written yet.
  expect(await page.evaluate(() => window.PlanAuthority.preparedPlans().length)).toBe(0);

  await panel.getByRole('button', { name: 'Save personal day start' }).click();

  const after = await page.evaluate(() => {
    const A = window.PlanAuthority;
    return {
      upcomingId: A.upcoming().id,
      upcomingItems: A.items(A.upcoming()).map(i => i.task),
      prepared: A.preparedPlans().map(p => ({ id: p.id, tasks: p.items.map(i => i.task), hasPreparation: !!p.preparation })),
    };
  });
  expect(after.upcomingId).not.toBe(orphanId);
  expect(after.upcomingItems).toEqual([]);               // never relocated
  expect(after.prepared).toEqual([{ id: orphanId, tasks: ['Prepared night shift'], hasPreparation: true }]);

  // And it is genuinely discoverable on Today, not just in memory.
  await page.evaluate(() => showView('today'));
  const surface = page.locator('#operational-plan-section');
  await expect(surface).toContainText('Prepared plans');
  await expect(surface).toContainText('Prepared night shift');
});
