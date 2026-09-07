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
    onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'cdi-user', displayName: 'CDI User', email: 'cdi@example.test', photoURL: '' }), 0); return () => {}; },
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

function uuid(n) { return `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`; }
let planSeq = 0;
function planOpts() {
  planSeq += 1;
  let counter = 0;
  return { idGenerator: () => `${uuid(900 + planSeq)}-${counter++}`, clock: () => '2026-02-01T00:00:00.000Z' };
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

function dayKeyOffset(deltaDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}
const TWO_DAYS_AGO = dayKeyOffset(-2);

function workoutEvent(n, day = dayKeyOffset(-120)) {
  return mkEvent({
    eventId: uuid(n), sourceApp: 'workout', id: `wk-${n}`, type: 'workout_completed',
    occurredAt: `${day}T18:42:00.000Z`,
    payload: { workoutName: 'Upper Body', startedAt: `${day}T18:00:00.000Z`, endedAt: `${day}T18:42:00.000Z`, durationMinutes: 42 }
  });
}

// A learning plan of `steps` steps with `done` completed, plus (optionally) a matching
// plan_step_completed ledger event so the plan is the Character Sheet's "active" plan.
function planEnvelope({ id = 'plan-a', title = 'AI Automation Roadmap', steps = 5, done = 2, lessonTitle = 'Webhooks' } = {}) {
  const opts = planOpts();
  let plan = createLearningPlan({ title }, opts);
  plan = { ...plan, id };
  plan = addPhase(plan, { title: 'Phase 1' }, opts);
  const phaseId = plan.phases[0].id;
  plan = addLesson(plan, phaseId, { title: lessonTitle }, opts);
  const lessonId = plan.phases[0].lessons[0].id;
  for (let i = 0; i < steps; i += 1) plan = addStep(plan, lessonId, { title: `Step ${i + 1}` }, opts);
  for (let i = 0; i < done; i += 1) plan = completeStep(plan, plan.phases[0].lessons[0].steps[i].id, opts);
  return { plan, envelope: JSON.stringify({ schemaVersion: 1, plans: [plan] }) };
}

function planStepEvent(n, planId, stepId, day = TWO_DAYS_AGO) {
  return mkEvent({
    eventId: uuid(n), sourceApp: 'chronasense', id: `${planId}:${stepId}`, type: 'plan_step_completed',
    occurredAt: `${day}T16:00:00.000Z`,
    payload: { planDate: day, stepLabel: 'Completed step', completedAt: `${day}T16:00:00.000Z`, source: { planId, planTitle: 'AI Automation Roadmap', stepId } }
  });
}

const T = '2026-01-01T00:00:00.000Z';
// Career profile: target + skill + a shippable project → "Turn <project> into presentable proof".
function shippingProfileEnvelope() {
  return JSON.stringify({
    schemaVersion: 1,
    profile: {
      schemaVersion: 1,
      skills: [{ id: 'sk-1', name: 'Automation', category: 'ai', status: 'active', createdAt: T, updatedAt: T }],
      knowledgeAreas: [], tools: [],
      careerTargets: [{ id: 'ct-1', title: 'Automation Specialist', objective: 'Ship automations', skillIds: ['sk-1'], priority: 'primary', status: 'active', createdAt: T, updatedAt: T }],
      projects: [{ id: 'pr-1', title: 'Webhook Demo', summary: '', status: 'active', skillIds: ['sk-1'], toolIds: [], careerTargetIds: ['ct-1'], portfolioStatus: 'candidate', artifactIds: [], createdAt: T, updatedAt: T }],
      artifacts: [],
      evidence: [
        { id: 'ev-1', skillId: 'sk-1', dimension: 'execution', source: 'manual', summary: 'built', projectId: 'pr-1', observedAt: '2026-01-15T00:00:00.000Z', createdAt: T, updatedAt: T },
        { id: 'ev-2', skillId: 'sk-1', dimension: 'execution', source: 'manual', summary: 'built more', projectId: 'pr-1', observedAt: '2026-02-01T00:00:00.000Z', createdAt: T, updatedAt: T },
        { id: 'ev-3', skillId: 'sk-1', dimension: 'shipping', source: 'manual', summary: 'shipped', projectId: 'pr-1', observedAt: '2026-02-05T00:00:00.000Z', createdAt: T, updatedAt: T }
      ],
      createdAt: T, updatedAt: T
    }
  });
}

async function openApp(page, seed = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: firebaseStub
  }));
  await page.addInitScript(({ seed, settings, ledgerKey, planKey, profileKey }) => {
    if (localStorage.getItem('ta3-cdi-test-seeded')) return;
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
    localStorage.setItem('ta3-cdi-test-seeded', '1');
  }, {
    seed, settings: baseSettings(),
    ledgerKey: LIFE_LEDGER_RUNTIME_KEY, planKey: LEARNING_PLAN_REPOSITORY_KEY, profileKey: CAPABILITY_CAREER_REPOSITORY_KEY
  });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.renderLifeView === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function openNext(page) {
  await page.locator('#nav-life').click();
  await expect(page.locator('#view-life')).toHaveClass(/active/);
  await page.locator('#life-subnav-next').click();
  await expect(page.locator('#cross-domain-intelligence-root')).toBeVisible();
}

test('Life view exposes a third "Next" sub-tab that shows the intelligence view and hides the others', async ({ page }) => {
  await openApp(page);
  await page.locator('#nav-life').click();
  await expect(page.locator('#life-subnav-next')).toBeVisible();
  await page.locator('#life-subnav-next').click();
  await expect(page.locator('#cross-domain-intelligence-root')).toBeVisible();
  await expect(page.locator('#life-character-sheet-root')).toBeHidden();
  await expect(page.locator('#life-feed-root')).toBeHidden();
  await expect(page.locator('#life-subnav-next')).toHaveAttribute('aria-pressed', 'true');
  // still exactly 7 bottom-nav items — no 8th
  await expect(page.locator('nav.nav .nav-btn')).toHaveCount(7);
});

test('empty state: honest "no recommendation yet" plus a Data-not-evaluated list — never a fake verdict', async ({ page }) => {
  await openApp(page);
  await openNext(page);
  const root = page.locator('#cross-domain-intelligence-root');
  await expect(root).toContainText('No cross-domain recommendation yet');
  await expect(root).toContainText('Data not evaluated');
  await expect(root).toContainText('Workout');
  await expect(root).toContainText('Meals');
  const text = (await root.innerText()).toLowerCase();
  for (const banned of ['inactive', 'on track', 'off track', 'unhealthy', 'behind', 'you should', 'you failed', 'lazy']) {
    expect(text, `must not contain "${banned}"`).not.toContain(banned);
  }
});

test('an actively tracked learning plan → a bounded recommendation with a traceable "Why this" and evidence', async ({ page }) => {
  const { plan, envelope: plans } = planEnvelope({ id: 'plan-a', steps: 10, done: 6 });
  const stepId = plan.phases[0].lessons[0].steps[0].id;
  const ledger = envelope([planStepEvent(1, 'plan-a', stepId)]);
  await openApp(page, { ledger, plans });
  await openNext(page);
  const root = page.locator('#cross-domain-intelligence-root');
  await expect(root.locator('.cdi-headline')).toContainText('Complete "Step 7"');
  await expect(root).toContainText('Why this');
  await expect(root).toContainText('6 of 10 steps complete');
  await expect(root.locator('.cdi-evidence')).toContainText('AI Automation Roadmap');
  // strength tag is textual, not colour-only; a tracked-but-unaligned plan is MEDIUM
  await expect(root.locator('.cdi-strength-tag')).toHaveText('MEDIUM');
});

test('a recency-only learning plan is NOT recommended — the Next view abstains and shows it as an attention area', async ({ page }) => {
  // a plan with unfinished steps, but no plan_step_completed maps to it and no career target
  const { envelope: plans } = planEnvelope({ id: 'plan-a', title: 'Recency Only Plan', steps: 8, done: 3 });
  await openApp(page, { plans });
  await openNext(page);
  const root = page.locator('#cross-domain-intelligence-root');
  // no recommendation headline action
  await expect(root.locator('.cdi-recommendation-none')).toBeVisible();
  expect(await root.locator('.cdi-headline').innerText()).toBe('No cross-domain recommendation yet');
  await expect(root).toContainText('picked only by recency');
  // the factual attention signal for this plan remains, with plan title + progress + next step
  const planSignal = root.locator('.cdi-signal', { hasText: 'Recency Only Plan' });
  await expect(planSignal).toHaveAttribute('data-severity', 'attention');
  await expect(planSignal).toContainText('3 of 8 steps complete');
  await expect(planSignal).toContainText(/next unfinished step/i);
  // nothing is escalated into a "Complete ..." recommendation
  await expect(root.locator('.cdi-recommendation .cdi-headline')).not.toContainText('Complete');
});

test('shipping stall + explicit project → shipping recommendation, actively tracked learning offered as an alternative', async ({ page }) => {
  const { plan, envelope: plans } = planEnvelope({ id: 'plan-a', steps: 6, done: 1 });
  const stepId = plan.phases[0].lessons[0].steps[0].id;
  const ledger = envelope([planStepEvent(1, 'plan-a', stepId)]);
  await openApp(page, { ledger, plans, profile: shippingProfileEnvelope() });
  await openNext(page);
  const root = page.locator('#cross-domain-intelligence-root');
  await expect(root.locator('.cdi-headline')).toContainText('Webhook Demo');
  await expect(root).toContainText('Other valid options');
  await expect(root.locator('.cdi-alt')).toContainText('Step 2');
  await expect(root.locator('.cdi-alt-meta')).toContainText(/outranks|tier|evidence strength/);
});

test('Data-not-evaluated block explains why workout/meal are excluded, in words', async ({ page }) => {
  const { envelope: plans } = planEnvelope({ id: 'plan-a', steps: 4, done: 1 });
  await openApp(page, { ledger: envelope([workoutEvent(1)]), plans });
  await openNext(page);
  const block = page.locator('#cross-domain-intelligence-root .cdi-not-evaluated');
  await expect(block).toContainText('Workout');
  await expect(block).toContainText(/not updating live|Not connected/);
  const text = (await block.innerText()).toLowerCase();
  expect(text).not.toContain('inactive');
  expect(text).not.toContain('you have not');
});

test('"Open in Learning Plans" navigates without writing to any store', async ({ page }) => {
  const { plan, envelope: plans } = planEnvelope({ id: 'plan-a', steps: 5, done: 2 });
  const stepId = plan.phases[0].lessons[0].steps[0].id;
  const ledger = envelope([planStepEvent(1, 'plan-a', stepId)]);
  await openApp(page, { ledger, plans });
  await openNext(page);
  const before = await page.evaluate(({ l, p, c }) => ({
    ledger: localStorage.getItem(l), plans: localStorage.getItem(p), profile: localStorage.getItem(c)
  }), { l: LIFE_LEDGER_RUNTIME_KEY, p: LEARNING_PLAN_REPOSITORY_KEY, c: CAPABILITY_CAREER_REPOSITORY_KEY });
  await page.locator('#cross-domain-intelligence-root [data-cdi-open="learning"]').click();
  await expect(page.locator('#view-learning')).toHaveClass(/active/);
  const after = await page.evaluate(({ l, p, c }) => ({
    ledger: localStorage.getItem(l), plans: localStorage.getItem(p), profile: localStorage.getItem(c)
  }), { l: LIFE_LEDGER_RUNTIME_KEY, p: LEARNING_PLAN_REPOSITORY_KEY, c: CAPABILITY_CAREER_REPOSITORY_KEY });
  expect(after).toEqual(before);
});

test('opening / switching / re-rendering the Next view never writes to any store', async ({ page }) => {
  const { envelope: plans } = planEnvelope({ id: 'plan-a', steps: 5, done: 2 });
  const ledger = envelope([workoutEvent(1)]);
  const profile = shippingProfileEnvelope();
  await openApp(page, { ledger, plans, profile });
  await openNext(page);
  await page.locator('#life-subnav-sheet').click();
  await page.locator('#life-subnav-next').click();
  await page.locator('#nav-today').click();
  await openNext(page);
  const stored = await page.evaluate(({ l, p, c }) => ({
    ledger: localStorage.getItem(l), plans: localStorage.getItem(p), profile: localStorage.getItem(c)
  }), { l: LIFE_LEDGER_RUNTIME_KEY, p: LEARNING_PLAN_REPOSITORY_KEY, c: CAPABILITY_CAREER_REPOSITORY_KEY });
  expect(stored.ledger).toBe(ledger);
  expect(stored.plans).toBe(plans);
  expect(stored.profile).toBe(profile);
});

test('the Next sub-tab is keyboard operable', async ({ page }) => {
  const { envelope: plans } = planEnvelope({ id: 'plan-a', steps: 4, done: 1 });
  await openApp(page, { plans });
  await page.locator('#nav-life').click();
  const nextBtn = page.locator('#life-subnav-next');
  await nextBtn.focus();
  await nextBtn.press('Enter');
  await expect(page.locator('#cross-domain-intelligence-root')).toBeVisible();
  await page.locator('#life-subnav-sheet').focus();
  await page.locator('#life-subnav-sheet').press('Enter');
  await expect(page.locator('#life-character-sheet-root')).toBeVisible();
});

test('hostile HTML in a plan / project name is rendered as text, never executed', async ({ page }) => {
  const { envelope: plans } = planEnvelope({ id: 'plan-a', title: '<img src=x onerror=alert(1)> <script>alert(2)</script> Roadmap', steps: 4, done: 1 });
  await openApp(page, { plans });
  await openNext(page);
  const root = page.locator('#cross-domain-intelligence-root');
  await expect(root).toContainText('Roadmap');
  expect(await root.locator('script').count()).toBe(0);
  expect(await root.locator('img').count()).toBe(0);
});

test('the Next region announces changes politely', async ({ page }) => {
  await openApp(page);
  await openNext(page);
  await expect(page.locator('#cross-domain-intelligence-root')).toHaveAttribute('aria-live', 'polite');
});

test('the Next view has no horizontal overflow on a narrow phone, even with long labels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { plan, envelope: plans } = planEnvelope({
    id: 'plan-a',
    title: 'A deliberately very long learning plan title that should wrap rather than push the layout wide',
    lessonTitle: 'An equally long lesson title used as the next-step context line for the recommendation',
    steps: 6, done: 2
  });
  const stepId = plan.phases[0].lessons[0].steps[0].id;
  await openApp(page, { ledger: envelope([planStepEvent(1, 'plan-a', stepId), workoutEvent(2)]), plans, profile: shippingProfileEnvelope() });
  await openNext(page);
  await expect(page.locator('#cross-domain-intelligence-root .cdi-headline')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('no moral / productivity language anywhere in the Next view', async ({ page }) => {
  const { plan, envelope: plans } = planEnvelope({ id: 'plan-a', steps: 8, done: 1 });
  const stepId = plan.phases[0].lessons[0].steps[0].id;
  await openApp(page, {
    ledger: envelope([planStepEvent(1, 'plan-a', stepId), workoutEvent(2)]),
    plans, profile: shippingProfileEnvelope()
  });
  await openNext(page);
  const text = (await page.locator('#cross-domain-intelligence-root').innerText()).toLowerCase();
  for (const banned of ['you failed', 'lazy', "you're behind", 'you are behind', 'slacking',
    'health score', 'productivity score', 'crushing it', 'you should focus', 'need to focus more']) {
    expect(text, `must not contain "${banned}"`).not.toContain(banned);
  }
});
