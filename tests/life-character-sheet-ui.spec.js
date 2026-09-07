import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIFE_LEDGER_RUNTIME_KEY } from '../life-ledger-runtime.js';
import { deriveLifeLedgerKey, fingerprintLifeLedgerEvent } from '../life-ledger-core.js';
import { LEARNING_PLAN_REPOSITORY_KEY } from '../learning-plan-repository.js';
import { CAPABILITY_CAREER_REPOSITORY_KEY } from '../capability-career-repository.js';
import {
  createLearningPlan, addPhase, addLesson, addStep, completeStep
} from '../learning-plan-model.js';

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
    onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'lcs-user', displayName: 'LCS User', email: 'lcs@example.test', photoURL: '' }), 0); return () => {}; },
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

function uuid(n) { return `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`; }
let planId = 0;
function planOpts() {
  planId += 1;
  let counter = 0;
  return { idGenerator: () => `${uuid(900 + planId)}-${counter++}`, clock: () => '2026-02-01T00:00:00.000Z' };
}

function mkEvent(o) {
  const event = {
    schemaVersion: 1, eventId: o.eventId, sourceApp: o.sourceApp, sourceEntityId: o.id, type: o.type,
    recordedAt: o.recordedAt || o.occurredAt || `${o.occurredDate}T12:00:00.000Z`,
    revisedAt: null, revision: 1, sourceTimezone: o.tz || 'Etc/UTC', payload: o.payload,
    provenance: {
      source: o.sourceApp, sourceRecordKind: `${o.sourceApp}.record`, adapterVersion: 'test-v1',
      observedAt: '2026-02-11T00:00:00.000Z', evidence: [`${o.sourceApp}.evidence:${o.id}`]
    },
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: o.tombstone || { active: false, deletedAt: null, reason: null, provenance: null }
  };
  if (o.occurredDate) { event.occurredDate = o.occurredDate; event.temporalPrecision = 'date'; }
  else { event.occurredAt = o.occurredAt; }
  return event;
}

function envelope(events) {
  return JSON.stringify({
    schemaVersion: 1,
    records: events.map(event => ({
      key: deriveLifeLedgerKey(event), event, fingerprint: fingerprintLifeLedgerEvent(event)
    }))
  });
}

// Events are seeded relative to the real run date (UTC) so "today" / "last 7 days" windows
// are exercised without overriding the page clock.
function dayKeyOffset(deltaDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}
const DAY = dayKeyOffset(0);
const SIX_DAYS_AGO = dayKeyOffset(-6);

function focusEvent(n, mins, day = DAY) {
  return mkEvent({
    eventId: uuid(n), sourceApp: 'chronasense', id: `focus-${n}`, type: 'focus_session_completed',
    occurredAt: `${day}T10:${String(n).padStart(2, '0')}:00.000Z`,
    payload: {
      activity: 'Focus session', startedAt: `${day}T09:00:00.000Z`,
      endedAt: `${day}T10:${String(n).padStart(2, '0')}:00.000Z`, durationMinutes: mins, additiveForTimeTotals: false
    }
  });
}
function workoutEvent(n, day = DAY) {
  return mkEvent({
    eventId: uuid(n), sourceApp: 'workout', id: `wk-${n}`, type: 'workout_completed',
    occurredAt: `${day}T18:42:00.000Z`,
    payload: { workoutName: 'Upper Body', startedAt: `${day}T18:00:00.000Z`, endedAt: `${day}T18:42:00.000Z`, durationMinutes: 42 }
  });
}

function samplePlanEnvelope() {
  const opts = planOpts();
  let plan = createLearningPlan({ title: 'AI Automation Roadmap' }, opts);
  plan = addPhase(plan, { title: 'Phase 1' }, opts);
  const phaseId = plan.phases[0].id;
  plan = addLesson(plan, phaseId, { title: 'Webhooks' }, opts);
  const lessonId = plan.phases[0].lessons[0].id;
  for (let i = 0; i < 4; i += 1) plan = addStep(plan, lessonId, { title: `Step ${i + 1}` }, opts);
  plan = completeStep(plan, plan.phases[0].lessons[0].steps[0].id, opts);
  plan = completeStep(plan, plan.phases[0].lessons[0].steps[1].id, opts);
  return JSON.stringify({ schemaVersion: 1, plans: [plan] });
}

function sampleProfileEnvelope() {
  const t = '2026-01-01T00:00:00.000Z';
  return JSON.stringify({
    schemaVersion: 1,
    profile: {
      schemaVersion: 1,
      skills: [{ id: 'sk-1', name: 'Prompt Engineering', category: 'ai', status: 'active', createdAt: t, updatedAt: t }],
      knowledgeAreas: [], tools: [],
      careerTargets: [{ id: 'ct-1', title: 'AI Automation Engineer', objective: 'Ship automations', skillIds: ['sk-1'], priority: 'primary', status: 'active', createdAt: t, updatedAt: t }],
      projects: [{ id: 'pr-1', title: 'Pipeline', summary: '', status: 'active', skillIds: ['sk-1'], toolIds: [], careerTargetIds: ['ct-1'], portfolioStatus: 'candidate', artifactIds: [], createdAt: t, updatedAt: t }],
      artifacts: [],
      evidence: [
        { id: 'ev-1', skillId: 'sk-1', dimension: 'knowledge', source: 'manual', summary: 'Read docs', observedAt: '2026-01-15T00:00:00.000Z', createdAt: t, updatedAt: t },
        { id: 'ev-2', skillId: 'sk-1', dimension: 'execution', source: 'manual', summary: 'Built', observedAt: '2026-02-01T00:00:00.000Z', createdAt: t, updatedAt: t }
      ],
      createdAt: t, updatedAt: t
    }
  });
}

async function openApp(page, seed = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: firebaseStub
  }));
  await page.addInitScript(({ seed, settings, ledgerKey, planKey, profileKey }) => {
    if (localStorage.getItem('ta3-lcs-test-seeded')) return;
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
    if (seed.ledger != null) localStorage.setItem(ledgerKey, seed.ledger);
    if (seed.plans != null) localStorage.setItem(planKey, seed.plans);
    if (seed.profile != null) localStorage.setItem(profileKey, seed.profile);
    localStorage.setItem('ta3-lcs-test-seeded', '1');
  }, {
    seed, settings: baseSettings(),
    ledgerKey: LIFE_LEDGER_RUNTIME_KEY, planKey: LEARNING_PLAN_REPOSITORY_KEY, profileKey: CAPABILITY_CAREER_REPOSITORY_KEY
  });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.renderLifeView === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function openLife(page) {
  await page.locator('#nav-life').click();
  await expect(page.locator('#view-life')).toHaveClass(/active/);
  await expect(page.locator('#life-character-sheet-root')).toBeVisible();
}

test('the Life view opens on the Character Sheet by default', async ({ page }) => {
  await openApp(page);
  await openLife(page);
  await expect(page.locator('#life-subnav-sheet')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#life-feed-root')).toBeHidden();
  await expect(page.locator('#life-character-sheet-root')).toContainText('Time & Focus');
});

test('empty state is intentional and honest — zero is never faked for unconnected domains', async ({ page }) => {
  await openApp(page);
  await openLife(page);
  const root = page.locator('#life-character-sheet-root');
  await expect(root).toContainText('No focus sessions logged yet');
  await expect(root).toContainText('No learning plan yet');
  await expect(root).toContainText('No Workout data in the Life Ledger yet');
  await expect(root).toContainText('No Meal data in the Life Ledger yet');
  await expect(root).toContainText('Not connected to the Life Ledger yet');
  // must NOT assert behavioural zeros for the unconnected domains
  await expect(root).not.toContainText('0 workouts');
  await expect(root).not.toContainText('0 meals');
});

test('focus + learning facts render with real counts and a bounded progress bar', async ({ page }) => {
  await openApp(page, {
    ledger: envelope([focusEvent(1, 25), focusEvent(2, 40)]),
    plans: samplePlanEnvelope()
  });
  await openLife(page);
  const root = page.locator('#life-character-sheet-root');
  await expect(root).toContainText('Focus today');
  await expect(root).toContainText('2 sessions · 1h 5m');
  await expect(root).toContainText('AI Automation Roadmap');
  await expect(root).toContainText('2 / 4 steps');
  await expect(root).toContainText('Next unfinished step');
  await expect(root).toContainText('Step 3');
  const progress = root.locator('progress.lcs-progress');
  await expect(progress).toHaveAttribute('value', '2');
  await expect(progress).toHaveAttribute('max', '4');
});

test('supplied Workout ledger data shows facts plus an honest "loaded from import" coverage line', async ({ page }) => {
  await openApp(page, { ledger: envelope([workoutEvent(1), workoutEvent(2, SIX_DAYS_AGO)]) });
  await openLife(page);
  const root = page.locator('#life-character-sheet-root');
  await expect(root).toContainText('Most recent');
  await expect(root).toContainText('Upper Body');
  await expect(root).toContainText('Total recorded');
  await expect(root).toContainText('2 workouts');
  await expect(root).toContainText('not updating automatically');
});

test('capability facts mirror the profile with no keyword inference', async ({ page }) => {
  await openApp(page, { profile: sampleProfileEnvelope() });
  await openLife(page);
  const root = page.locator('#life-character-sheet-root');
  await expect(root).toContainText('AI Automation Engineer');
  await expect(root).toContainText('Tracked capabilities');
  await expect(root).toContainText('Evidence records');
  // dimension tiles
  await expect(root.locator('.lcs-dim', { hasText: 'Knowledge' })).toContainText('1');
  await expect(root.locator('.lcs-dim', { hasText: 'Execution' })).toContainText('1');
});

test('sub-navigation switches to the Timeline and back, keyboard operable', async ({ page }) => {
  await openApp(page, { ledger: envelope([focusEvent(1, 25)]) });
  await openLife(page);
  const timelineBtn = page.locator('#life-subnav-timeline');
  await timelineBtn.focus();
  await timelineBtn.press('Enter');
  await expect(page.locator('#life-feed-root')).toBeVisible();
  await expect(page.locator('#life-character-sheet-root')).toBeHidden();
  await expect(page.locator('.life-feed-item')).toHaveCount(1);
  await page.locator('#life-subnav-sheet').click();
  await expect(page.locator('#life-character-sheet-root')).toBeVisible();
});

test('no coaching, scoring, or advice language on the Character Sheet', async ({ page }) => {
  await openApp(page, {
    ledger: envelope([focusEvent(1, 25), workoutEvent(2)]),
    plans: samplePlanEnvelope(),
    profile: sampleProfileEnvelope()
  });
  await openLife(page);
  const text = (await page.locator('#life-character-sheet-root').innerText()).toLowerCase();
  for (const banned of ['you should', 'recommend', 'best next action', 'needs improvement',
    'crushing it', 'stay consistent', 'health score', 'productivity score', 'readiness']) {
    expect(text, `must not contain "${banned}"`).not.toContain(banned);
  }
});

test('opening / switching / re-rendering the Character Sheet never writes to any store', async ({ page }) => {
  const ledger = envelope([focusEvent(1, 25), workoutEvent(2)]);
  const plans = samplePlanEnvelope();
  const profile = sampleProfileEnvelope();
  await openApp(page, { ledger, plans, profile });
  await openLife(page);
  await page.locator('#life-subnav-timeline').click();
  await page.locator('#life-subnav-sheet').click();
  await page.locator('#nav-today').click();
  await openLife(page);
  const stored = await page.evaluate(({ l, p, c }) => ({
    ledger: localStorage.getItem(l), plans: localStorage.getItem(p), profile: localStorage.getItem(c)
  }), { l: LIFE_LEDGER_RUNTIME_KEY, p: LEARNING_PLAN_REPOSITORY_KEY, c: CAPABILITY_CAREER_REPOSITORY_KEY });
  expect(stored.ledger).toBe(ledger);
  expect(stored.plans).toBe(plans);
  expect(stored.profile).toBe(profile);
});

test('hostile HTML in a workout name is rendered as text, never executed', async ({ page }) => {
  const evt = mkEvent({
    eventId: uuid(1), sourceApp: 'workout', id: 'wk-x', type: 'workout_completed', occurredAt: `${DAY}T18:42:00.000Z`,
    payload: {
      workoutName: '<img src=x onerror=alert(1)> <script>alert(2)</script> lift',
      startedAt: `${DAY}T18:00:00.000Z`, endedAt: `${DAY}T18:42:00.000Z`, durationMinutes: 42
    }
  });
  await openApp(page, { ledger: envelope([evt]) });
  await openLife(page);
  await expect(page.locator('#life-character-sheet-root')).toContainText('lift');
  expect(await page.locator('#life-character-sheet-root script').count()).toBe(0);
  expect(await page.locator('#life-character-sheet-root img').count()).toBe(0);
});

test('the Character Sheet region announces changes politely', async ({ page }) => {
  await openApp(page);
  await openLife(page);
  await expect(page.locator('#life-character-sheet-root')).toHaveAttribute('aria-live', 'polite');
});
