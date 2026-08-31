import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addLesson,
  addPhase,
  addStep,
  completeStep,
  createLearningPlan,
  reopenStep
} from '../learning-plan-model.js';
import {
  LEARNING_PLAN_REPOSITORY_KEY,
  LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION
} from '../learning-plan-repository.js';
import { LIFE_LEDGER_RUNTIME_KEY, learningPlanStepSourceEntityId } from '../life-ledger-runtime.js';
import { deriveLifeLedgerKey, fingerprintLifeLedgerEvent } from '../life-ledger-core.js';
import {
  LIFE_LEDGER_EXPORT_FILENAME,
  LIFE_LEDGER_TRANSPORT_KIND,
  LIFE_LEDGER_TRANSPORT_SCHEMA_VERSION
} from '../life-ledger-transport.js';

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
      if (!filePath.startsWith(APP_ROOT)) {
        res.writeHead(403).end();
        return;
      }
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      const contentType = ext === '.html' ? 'text/html'
        : ext === '.js' ? 'application/javascript'
          : ext === '.css' ? 'text/css'
            : 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  const address = appServer.address();
  appUrl = `http://127.0.0.1:${address.port}/index.html`;
});

test.afterAll(async () => {
  if (!appServer) return;
  await new Promise(resolve => appServer.close(resolve));
});

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const makeRef = refPath => ({
    path: refPath,
    child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) {
      if (eventName === 'value') setTimeout(() => cb(snapshot(null)), 0);
      return cb;
    },
    off() {},
    once() { return Promise.resolve(snapshot(null)); },
    update() { return Promise.resolve(); },
    set() { return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    push(value) {
      const pushed = makeRef(refPath + '/pushed');
      pushed.key = 'pushed';
      if (value !== undefined) pushed.set(value);
      return pushed;
    },
    onDisconnect() {
      return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() };
    }
  });
  const auth = () => ({
    onAuthStateChanged(cb) {
      setTimeout(() => cb({ uid: 'learning-user', displayName: 'Learning User', email: 'learning@example.test', photoURL: '' }), 0);
      return () => {};
    },
    signInWithPopup() { return Promise.resolve(); },
    signInWithCredential() { return Promise.resolve(); },
    signOut() { return Promise.resolve(); }
  });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = {
    apps: [],
    initializeApp(config) { const app = { config }; this.apps.push(app); return app; },
    app() { return this.apps[0] || this.initializeApp({}); },
    database() { return { ref: makeRef }; },
    auth
  };
})();
`;

function baseSettings() {
  return {
    hardMode: true,
    intervalMin: 30,
    targetRate: 250,
    deepGoal: 20,
    exitDelay: 10,
    presets: [],
    timezone: 'UTC',
    activityColors: {},
    coachTone: 'analyst',
    reviewHour: 22,
    reviewTime: '22:00',
    sleepTime: '23:00',
    wakeTime: '07:00',
    sleepReminderMin: 30,
    sleepSetupDone: true,
    templates: []
  };
}

function fixedClock(value = '2026-08-28T12:00:00.000Z') {
  return () => value;
}

function sequencedIds(...ids) {
  let index = 0;
  return () => ids[Math.min(index++, ids.length - 1)];
}

function seededLearningPlan() {
  let plan = createLearningPlan({ title: 'Frontend fundamentals' }, {
    idGenerator: sequencedIds('plan-a'),
    clock: fixedClock()
  });
  plan = addPhase(plan, { title: 'Phase A' }, {
    idGenerator: sequencedIds('phase-a'),
    clock: fixedClock()
  });
  plan = addLesson(plan, 'phase-a', { title: 'Lesson A' }, {
    idGenerator: sequencedIds('lesson-a'),
    clock: fixedClock()
  });
  plan = addStep(plan, 'lesson-a', { title: 'Step A' }, {
    idGenerator: sequencedIds('step-a'),
    clock: fixedClock()
  });
  plan = addStep(plan, 'lesson-a', { title: 'Step B' }, {
    idGenerator: sequencedIds('step-b'),
    clock: fixedClock()
  });
  return plan;
}

function secondLearningPlan() {
  return createLearningPlan({ title: 'Backend fundamentals' }, {
    idGenerator: sequencedIds('plan-b'),
    clock: fixedClock()
  });
}

function multiSectionPlan({ sameTitles = false, completeFirstLesson = false } = {}) {
  let plan = createLearningPlan({ title: 'Structured course' }, {
    idGenerator: sequencedIds('plan-structured'),
    clock: fixedClock()
  });
  for (let phaseIndex = 1; phaseIndex <= 2; phaseIndex++) {
    const phaseId = `phase-${phaseIndex}`;
    plan = addPhase(plan, { title: sameTitles ? 'Repeated phase' : `Phase ${phaseIndex}` }, {
      idGenerator: sequencedIds(phaseId),
      clock: fixedClock()
    });
    for (let lessonIndex = 1; lessonIndex <= 2; lessonIndex++) {
      const lessonId = `lesson-${phaseIndex}-${lessonIndex}`;
      plan = addLesson(plan, phaseId, { title: sameTitles ? 'Repeated lesson' : `Lesson ${phaseIndex}.${lessonIndex}` }, {
        idGenerator: sequencedIds(lessonId),
        clock: fixedClock()
      });
      for (let stepIndex = 1; stepIndex <= 2; stepIndex++) {
        plan = addStep(plan, lessonId, { title: `Step ${phaseIndex}.${lessonIndex}.${stepIndex}` }, {
          idGenerator: sequencedIds(`step-${phaseIndex}-${lessonIndex}-${stepIndex}`),
          clock: fixedClock()
        });
      }
    }
  }
  if (completeFirstLesson) {
    plan = completeStep(plan, 'step-1-1-1', { clock: fixedClock('2026-08-28T12:10:00.000Z') });
    plan = completeStep(plan, 'step-1-1-2', { clock: fixedClock('2026-08-28T12:11:00.000Z') });
  }
  return plan;
}

function fullyCompletedPlan() {
  let plan = seededLearningPlan();
  plan = completeStep(plan, 'step-a', { clock: fixedClock('2026-08-28T12:10:00.000Z') });
  plan = completeStep(plan, 'step-b', { clock: fixedClock('2026-08-28T12:11:00.000Z') });
  return plan;
}

function zeroStepPlan() {
  let plan = createLearningPlan({ title: 'Shell course' }, {
    idGenerator: sequencedIds('plan-zero'),
    clock: fixedClock()
  });
  plan = addPhase(plan, { title: 'Empty phase' }, {
    idGenerator: sequencedIds('phase-zero'),
    clock: fixedClock()
  });
  plan = addLesson(plan, 'phase-zero', { title: 'Empty lesson' }, {
    idGenerator: sequencedIds('lesson-zero'),
    clock: fixedClock()
  });
  return plan;
}

function largeOutline() {
  const lines = [];
  for (let phaseIndex = 1; phaseIndex <= 3; phaseIndex++) {
    lines.push(`# Phase ${phaseIndex}`);
    for (let lessonIndex = 1; lessonIndex <= 4; lessonIndex++) {
      lines.push(`## Lesson ${phaseIndex}.${lessonIndex}`);
      for (let stepIndex = 1; stepIndex <= 5; stepIndex++) {
        lines.push(`- Step ${phaseIndex}.${lessonIndex}.${stepIndex}`);
      }
    }
  }
  return lines.join('\n');
}

function envelope(plans) {
  return JSON.stringify({
    schemaVersion: LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION,
    plans
  });
}

function browserFocusEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: '50505050-5050-4050-8050-505050505050',
    sourceApp: 'chronasense',
    sourceEntityId: 'browser-focus-1',
    type: 'focus_session_completed',
    occurredAt: '2026-08-30T16:25:00.000Z',
    recordedAt: '2026-08-30T16:26:00.000Z',
    revisedAt: null,
    sourceTimezone: 'Etc/UTC',
    payload: {
      activity: 'Browser synthetic focus',
      startedAt: '2026-08-30T16:00:00.000Z',
      endedAt: '2026-08-30T16:25:00.000Z',
      durationMinutes: 25,
      additiveForTimeTotals: false,
      source: { focusEntryId: 'browser-focus-1' }
    },
    provenance: {
      source: 'chronasense',
      sourceRecordKind: 'chronasense.focus_outcome',
      adapterVersion: 'test-v1',
      observedAt: '2026-08-30T16:26:00.000Z',
      captureMethod: 'pomodoro',
      evidence: ['browser.synthetic.focus:1']
    },
    confidence: { score: 1, basis: 'source-recorded' },
    revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null },
    ...overrides
  };
}

function runtimeLedgerEnvelope(events) {
  return JSON.stringify({
    schemaVersion: 1,
    records: events.map(event => ({
      key: deriveLifeLedgerKey(event),
      event,
      fingerprint: fingerprintLifeLedgerEvent(event)
    }))
  });
}

async function openApp(page, { learningPlanRaw = null, dailyPlans = {}, lifeLedgerRaw = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: firebaseStub
  }));
  await page.addInitScript(({ learningPlanRaw, dailyPlans, lifeLedgerRaw, settings }) => {
    if (localStorage.getItem('ta3-learning-ui-test-seeded')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', 'UTC');
    localStorage.setItem('ta3-settings', JSON.stringify(settings));
    localStorage.setItem('ta3-entries', '[]');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-plans', JSON.stringify(dailyPlans));
    localStorage.setItem('ta3-reviews', '{}');
    if (learningPlanRaw !== null) localStorage.setItem('ta3-learning-plans-v1', learningPlanRaw);
    if (lifeLedgerRaw !== null) localStorage.setItem('ta3-life-ledger-v1', lifeLedgerRaw);
    localStorage.setItem('firebase-auth-token', 'unrelated-secret-token');
    localStorage.setItem('ta3-learning-ui-test-seeded', '1');
  }, { learningPlanRaw, dailyPlans, lifeLedgerRaw, settings: baseSettings() });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function openLearningPlans(page) {
  await page.locator('#nav-learning').click();
  await expect(page.locator('#view-learning')).toHaveClass(/active/);
}

async function openSettings(page) {
  await page.locator('#nav-settings').click();
  await expect(page.locator('#view-settings')).toHaveClass(/active/);
}

async function stubFocusAudio(page) {
  await page.evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.resolve(); });
}

async function captureSyncWrites(page) {
  await page.evaluate(() => {
    window.__syncPayloads = [];
    const ref = {
      update(payload) {
        window.__syncPayloads.push(JSON.parse(JSON.stringify(payload)));
        return Promise.resolve();
      },
      set(payload) {
        window.__syncPayloads.push(JSON.parse(JSON.stringify({ set: payload })));
        return Promise.resolve();
      },
      child() { return ref; },
      once() { return Promise.resolve({ val: () => null }); },
      on() {},
      off() {},
      remove() { return Promise.resolve(); }
    };
    fbRoomRef = ref;
    fbDb = { ref: () => ref };
    roomCode = 'SYNC-TEST';
    currentUser = null;
  });
}

function expectNoLearningPlanProvenance(value) {
  const text = JSON.stringify(value);
  expect(text).not.toContain('"learningPlan"');
  ['plan-a', 'phase-a', 'lesson-a', 'step-a', 'plan-b', 'phase-b', 'lesson-b', 'step-build-endpoint']
    .forEach(id => { expect(text).not.toContain(id); });
}

async function createPlanThroughUi(page, title = 'JavaScript fundamentals') {
  await page.locator('[data-lp-action="show-create"]').click();
  await expect(page.locator('#learning-plan-create-panel')).toBeVisible();
  await page.locator('#learning-plan-title-input').fill(title);
  await page.getByRole('button', { name: 'Create plan' }).click();
  await expect(page.locator('.learning-plan-list-item')).toContainText(title);
}

async function fillImportForm(page, {
  title = 'JavaScript fundamentals',
  outline = '# Fundamentals\n## Variables\n- Read lesson\n- Complete exercises'
} = {}) {
  if (await page.locator('#learning-plan-import-panel').isHidden()) {
    await page.locator('[data-lp-action="show-import"]').click();
  }
  await page.locator('#learning-plan-import-title-input').fill(title);
  await page.locator('#learning-plan-import-outline').fill(outline);
}

async function previewImport(page) {
  await page.locator('#learning-plan-import-form').getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('region', { name: 'Learning Plan import preview' })).toBeVisible();
}

async function importPlan(page) {
  await page.locator('#learning-plan-import-form').getByRole('button', { name: 'Import plan' }).click();
}

async function addPhaseThroughUi(page, title = 'Phase 1') {
  await page.locator('[data-lp-action="open-add"][data-add-kind="phase"]').click();
  await page.locator('form[data-lp-action="add-phase"] input[name="title"]').fill(title);
  await page.locator('form[data-lp-action="add-phase"]').getByRole('button', { name: 'Add phase' }).click();
  await expect(page.locator('[data-lp-action="toggle-phase"]').first()).toContainText(title);
}

async function addLessonThroughUi(page, title = 'Lesson 1') {
  await page.locator('[data-lp-action="open-add"][data-add-kind="lesson"]').first().click();
  await page.locator('form[data-lp-action="add-lesson"] input[name="title"]').fill(title);
  await page.locator('form[data-lp-action="add-lesson"]').getByRole('button', { name: 'Add lesson' }).click();
  await expect(page.locator('[data-lp-action="toggle-lesson"]').first()).toContainText(title);
}

async function addStepThroughUi(page, title = 'Read docs') {
  await page.locator('[data-lp-action="open-add"][data-add-kind="step"]').first().click();
  await page.locator('form[data-lp-action="add-step"] input[name="title"]').fill(title);
  await page.locator('form[data-lp-action="add-step"]').getByRole('button', { name: 'Add step' }).click();
  await expect(page.locator('.learning-plan-step')).toContainText(title);
}

async function renameThroughUi(page, kind, currentTitle, nextTitle) {
  const block = kind === 'step'
    ? page.locator('.learning-plan-step').filter({ hasText: currentTitle }).first()
    : kind === 'plan'
      ? page.locator('.learning-plan-title-display').filter({ hasText: currentTitle }).first()
      : page.locator('.learning-plan-section-summary').filter({ hasText: currentTitle }).first();
  await block.getByRole('button', { name: 'Edit' }).click();
  const form = page.locator(`form[data-lp-action="rename-${kind}"]`).first();
  await form.locator('input[name="title"]').fill(nextTitle);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#learning-plan-main').getByText(nextTitle, { exact: true }).first()).toBeVisible();
}

async function storedEnvelope(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), LEARNING_PLAN_REPOSITORY_KEY);
}

async function lifeLedgerEnvelope(page) {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, LIFE_LEDGER_RUNTIME_KEY);
}

async function lifeLedgerEvents(page) {
  const envelope = await lifeLedgerEnvelope(page);
  return envelope?.records?.map(record => record.event) || [];
}

async function installSelectiveLedgerFailure(page, needles = []) {
  return page.evaluate(({ key, needles }) => {
    window.__realLedgerSetItem = window.__realLedgerSetItem || Storage.prototype.setItem;
    window.__blockedLedgerNeedles = needles;
    window.__blockAllLedgerWrites = false;
    Storage.prototype.setItem = function setItem(keyName, value) {
      let sourceEntityIds = [];
      try {
        sourceEntityIds = (JSON.parse(String(value)).records || []).map(record => record?.event?.sourceEntityId);
      } catch {
        sourceEntityIds = [];
      }
      if (
        keyName === key
        && (
          window.__blockAllLedgerWrites
          || (window.__blockedLedgerNeedles || []).some(needle => sourceEntityIds.includes(needle))
        )
      ) {
        throw new Error('blocked ledger write');
      }
      return window.__realLedgerSetItem.call(this, keyName, value);
    };
  }, { key: LIFE_LEDGER_RUNTIME_KEY, needles });
}

async function blockAllLedgerWrites(page) {
  return page.evaluate(({ key }) => {
    window.__realLedgerSetItem = window.__realLedgerSetItem || Storage.prototype.setItem;
    window.__blockAllLedgerWrites = true;
    window.__blockedLedgerNeedles = [];
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key && window.__blockAllLedgerWrites) throw new Error('blocked ledger write');
      return window.__realLedgerSetItem.call(this, keyName, value);
    };
  }, { key: LIFE_LEDGER_RUNTIME_KEY });
}

async function setBlockedLedgerNeedles(page, needles = []) {
  return page.evaluate(needles => {
    window.__blockAllLedgerWrites = false;
    window.__blockedLedgerNeedles = needles;
  }, needles);
}

async function restoreLedgerWrites(page) {
  return page.evaluate(() => {
    if (window.__realLedgerSetItem) Storage.prototype.setItem = window.__realLedgerSetItem;
    window.__blockAllLedgerWrites = false;
    window.__blockedLedgerNeedles = [];
  });
}

async function countLearningPlanWrites(page) {
  return page.evaluate(key => {
    window.__learningPlanSetCalls = 0;
    window.__learningPlanRealSetItem = window.__learningPlanRealSetItem || Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) window.__learningPlanSetCalls++;
      return window.__learningPlanRealSetItem.call(this, keyName, value);
    };
  }, LEARNING_PLAN_REPOSITORY_KEY);
}

async function finishLearningPlanFocusWork(page, buttonName = 'Start Focus: Step A', elapsedMin = 25) {
  await stubFocusAudio(page);
  await page.getByRole('button', { name: buttonName }).click();
  await page.evaluate(minutes => {
    focusStartTime = Date.now() - minutes * 60 * 1000;
    endWorkSession();
  }, elapsedMin);
}

function focusOutcomeButton(page, name) {
  return page.getByRole('region', { name: 'Focus outcome' }).getByRole('button', { name });
}

function planWithBackendStep() {
  let plan = secondLearningPlan();
  plan = addPhase(plan, { title: 'API phase' }, { idGenerator: sequencedIds('phase-b'), clock: fixedClock() });
  plan = addLesson(plan, 'phase-b', { title: 'API lesson' }, { idGenerator: sequencedIds('lesson-b'), clock: fixedClock() });
  return addStep(plan, 'lesson-b', { title: 'Build endpoint' }, { idGenerator: sequencedIds('step-build-endpoint'), clock: fixedClock() });
}

function duplicateTitlePlan() {
  let plan = createLearningPlan({ title: 'Same title plan' }, {
    idGenerator: sequencedIds('plan-dup'),
    clock: fixedClock()
  });
  plan = addPhase(plan, { title: 'Repeated phase' }, {
    idGenerator: sequencedIds('phase-dup-a'),
    clock: fixedClock()
  });
  plan = addLesson(plan, 'phase-dup-a', { title: 'Repeated lesson' }, {
    idGenerator: sequencedIds('lesson-dup-a'),
    clock: fixedClock()
  });
  plan = addStep(plan, 'lesson-dup-a', { title: 'Repeated step' }, {
    idGenerator: sequencedIds('step-dup-a'),
    clock: fixedClock()
  });
  plan = addPhase(plan, { title: 'Repeated phase' }, {
    idGenerator: sequencedIds('phase-dup-b'),
    clock: fixedClock()
  });
  plan = addLesson(plan, 'phase-dup-b', { title: 'Repeated lesson' }, {
    idGenerator: sequencedIds('lesson-dup-b'),
    clock: fixedClock()
  });
  plan = addStep(plan, 'lesson-dup-b', { title: 'Repeated step' }, {
    idGenerator: sequencedIds('step-dup-b'),
    clock: fixedClock()
  });
  return completeStep(plan, 'step-dup-a', { clock: fixedClock('2026-08-28T12:10:00.000Z') });
}

function entityIds(plan) {
  return [
    plan.id,
    ...plan.phases.flatMap(phase => [
      phase.id,
      ...phase.lessons.flatMap(lesson => [
        lesson.id,
        ...lesson.steps.map(step => step.id)
      ])
    ])
  ];
}

test('Life Ledger export button exists in Settings data controls', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await expect(page.getByRole('button', { name: 'Export Life Ledger' })).toBeVisible();
});

test('Life Ledger export downloads the fixed filename and current snapshot', async ({ page }) => {
  const event = browserFocusEvent();
  await openApp(page, { lifeLedgerRaw: runtimeLedgerEnvelope([event]) });
  await openSettings(page);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Life Ledger' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(LIFE_LEDGER_EXPORT_FILENAME);
  const snapshot = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  expect(snapshot).toMatchObject({
    transportSchemaVersion: LIFE_LEDGER_TRANSPORT_SCHEMA_VERSION,
    kind: LIFE_LEDGER_TRANSPORT_KIND
  });
  expect(snapshot.events).toHaveLength(1);
  expect(snapshot.events[0].eventId).toBe(event.eventId);
  expect(snapshot.events[0].revision).toBe(event.revision);
  expect(JSON.stringify(snapshot)).not.toContain('unrelated-secret-token');
});

test('Life Ledger export revokes object URLs and uses no vault filesystem API', async ({ page }) => {
  await openApp(page, { lifeLedgerRaw: runtimeLedgerEnvelope([browserFocusEvent()]) });
  await openSettings(page);
  await page.evaluate(() => {
    window.__ledgerExportUrls = [];
    window.__ledgerExportFsCalls = 0;
    const realCreate = URL.createObjectURL.bind(URL);
    const realRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      const url = realCreate(blob);
      window.__ledgerExportUrls.push({ url, revoked: false });
      return url;
    };
    URL.revokeObjectURL = url => {
      const entry = window.__ledgerExportUrls.find(item => item.url === url);
      if (entry) entry.revoked = true;
      return realRevoke(url);
    };
    window.showOpenFilePicker = () => { window.__ledgerExportFsCalls++; throw new Error('blocked'); };
    window.showDirectoryPicker = () => { window.__ledgerExportFsCalls++; throw new Error('blocked'); };
    window.showSaveFilePicker = () => { window.__ledgerExportFsCalls++; throw new Error('blocked'); };
  });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Life Ledger' }).click();
  await downloadPromise;
  const result = await page.evaluate(() => ({
    urls: window.__ledgerExportUrls,
    fsCalls: window.__ledgerExportFsCalls
  }));
  expect(result.urls).toHaveLength(1);
  expect(result.urls[0].revoked).toBe(true);
  expect(result.fsCalls).toBe(0);
});

test('Life Ledger export downloads an empty valid snapshot', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Life Ledger' }).click();
  const download = await downloadPromise;
  const snapshot = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  expect(download.suggestedFilename()).toBe(LIFE_LEDGER_EXPORT_FILENAME);
  expect(snapshot.events).toEqual([]);
});

test('Life Ledger export failure is shown truthfully', async ({ page }) => {
  await openApp(page, { lifeLedgerRaw: runtimeLedgerEnvelope([browserFocusEvent()]) });
  await openSettings(page);
  await page.evaluate(() => {
    URL.createObjectURL = () => { throw new Error('synthetic download failure'); };
  });
  await page.getByRole('button', { name: 'Export Life Ledger' }).click();
  await expect(page.locator('#life-ledger-export-status')).toContainText('Life Ledger export failed: synthetic download failure');
});

test('Learning Plans opens an empty repository without error', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);

  await expect(page.locator('#learning-plan-error')).toBeHidden();
  await expect(page.locator('#learning-plan-list')).toContainText('No Learning Plans yet.');
  await expect(page.locator('#learning-plan-main')).toContainText('Import a plan or create one manually');
  await expect(page.locator('#learning-plan-import-panel')).toBeHidden();
  await expect(page.locator('#learning-plan-create-panel')).toBeHidden();
});

test('How this works guide is available, closed by default, toggleable, and storage-neutral', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  const before = await page.evaluate(key => localStorage.getItem(key), LEARNING_PLAN_REPOSITORY_KEY);
  const guideButton = page.getByRole('button', { name: 'How this works' });
  const guide = page.getByRole('region', { name: 'How this works' });

  await expect(guideButton).toBeVisible();
  await expect(guideButton).toHaveAttribute('aria-expanded', 'false');
  await expect(guide).toBeHidden();

  await guideButton.click();
  await expect(guideButton).toHaveAttribute('aria-expanded', 'true');
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("Don't decide what to study. Do the next unfinished step.");
  await expect(guide).toContainText('Setup once');
  await expect(guide).toContainText('Research');
  await expect(guide).toContainText('Customize');
  await expect(guide).toContainText('Import');
  await expect(guide).toContainText('Every session');
  await expect(guide).toContainText('Next Step');
  await expect(guide).toContainText('Focus');
  await expect(guide).toContainText('Complete');
  await expect(guide).toContainText('Repeat');
  await expect(guide).toContainText('Review');

  await guideButton.click();
  await expect(guideButton).toHaveAttribute('aria-expanded', 'false');
  await expect(guide).toBeHidden();
  expect(await page.evaluate(key => localStorage.getItem(key), LEARNING_PLAN_REPOSITORY_KEY)).toBe(before);
});

test('creation controls are collapsed by default and open one flow at a time', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);

  await expect(page.locator('[data-lp-action="show-import"]')).toBeVisible();
  await expect(page.locator('[data-lp-action="show-create"]')).toBeVisible();
  await expect(page.locator('#learning-plan-import-panel')).toBeHidden();
  await expect(page.locator('#learning-plan-create-panel')).toBeHidden();

  await page.locator('[data-lp-action="show-import"]').click();
  await expect(page.locator('#learning-plan-import-panel')).toBeVisible();
  await expect(page.locator('#learning-plan-create-panel')).toBeHidden();
  await expect(page.locator('#learning-plan-import-title')).toHaveText('Import / Paste Plan');
  await expect(page.getByLabel('Plan title').first()).toHaveAttribute('id', 'learning-plan-import-title-input');
  await expect(page.locator('#learning-plan-import-form').getByRole('button', { name: 'Preview' })).toBeVisible();
  await expect(page.locator('#learning-plan-import-form').getByRole('button', { name: 'Import plan' })).toBeDisabled();

  await page.locator('[data-lp-action="show-create"]').click();
  await expect(page.locator('#learning-plan-import-panel')).toBeHidden();
  await expect(page.locator('#learning-plan-create-panel')).toBeVisible();
  await expect(page.locator('#learning-plan-create-title')).toHaveText('Create manually');
  await expect(page.getByRole('button', { name: 'Create plan' })).toBeVisible();
});

test('valid paste previews hierarchy and counts without writing repository storage', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await fillImportForm(page, {
    title: 'JavaScript Fundamentals',
    outline: '# Fundamentals\n## Variables\n- Read lesson\n- Complete exercises\n\n## Functions\n- Watch tutorial\n- Build project\n# Intermediate\n## Arrays\n- Solve exercises'
  });

  await previewImport(page);

  const preview = page.getByRole('region', { name: 'Learning Plan import preview' });
  await expect(preview).toContainText('JavaScript Fundamentals');
  await expect(preview).toContainText('2 phases - 3 lessons - 5 steps');
  await expect(preview).toContainText('Fundamentals');
  await expect(preview).toContainText('Variables');
  await expect(preview).toContainText('Complete exercises');
  await expect(page.locator('#learning-plan-import-form').getByRole('button', { name: 'Import plan' })).toBeEnabled();
  expect(await page.evaluate(key => localStorage.getItem(key), LEARNING_PLAN_REPOSITORY_KEY)).toBeNull();
});

test('Import creates one durable Learning Plan and reload restores the hierarchy with model IDs', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await page.evaluate(key => {
    window.__learningPlanSetCalls = 0;
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) window.__learningPlanSetCalls++;
      return realSetItem.call(this, keyName, value);
    };
  }, LEARNING_PLAN_REPOSITORY_KEY);
  await fillImportForm(page, {
    title: 'JavaScript Fundamentals',
    outline: '# Fundamentals\n## Variables\n- Read lesson\n- Complete exercises\n## Functions\n- Build project'
  });
  await previewImport(page);

  await importPlan(page);

  const stored = await storedEnvelope(page);
  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(1);
  expect(stored.plans).toHaveLength(1);
  expect(stored.plans[0].title).toBe('JavaScript Fundamentals');
  expect(stored.plans[0].phases[0].title).toBe('Fundamentals');
  expect(stored.plans[0].phases[0].lessons.map(lesson => lesson.title)).toEqual(['Variables', 'Functions']);
  expect(stored.plans[0].phases[0].lessons[0].steps.map(step => step.title)).toEqual(['Read lesson', 'Complete exercises']);
  const ids = entityIds(stored.plans[0]);
  expect(ids.every(id => /^[0-9a-f-]{36}$/i.test(id))).toBe(true);
  expect(ids).not.toContain('JavaScript Fundamentals');
  expect(ids).not.toContain('Fundamentals');
  await expect(page.locator('#learning-plan-import-panel')).toBeHidden();
  await expect(page.locator('#learning-plan-import-title-input')).toHaveValue('');
  await expect(page.locator('#learning-plan-import-outline')).toHaveValue('');
  await expect(page.locator('[data-lp-action="toggle-phase"]').first()).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-lp-action="toggle-lesson"]').first()).toHaveAttribute('aria-expanded', 'true');

  await page.reload();
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await openLearningPlans(page);

  await expect(page.locator('.learning-plan-list-item')).toContainText('JavaScript Fundamentals');
  await expect(page.locator('[data-lp-action="toggle-phase"]').first()).toContainText('Fundamentals');
  await expect(page.locator('[data-lp-action="toggle-lesson"]').first()).toContainText('Variables');
  await expect(page.locator('.learning-plan-step').first()).toContainText('Read lesson');
});

test('rapid double Import creates at most one Learning Plan', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await fillImportForm(page);
  await previewImport(page);

  await page.locator('#learning-plan-import-form').getByRole('button', { name: 'Import plan' }).dblclick();

  const stored = await storedEnvelope(page);
  expect(stored.plans).toHaveLength(1);
  expect(stored.plans[0].title).toBe('JavaScript fundamentals');
});

test('malformed import shows a line-level error and persists nothing', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await fillImportForm(page, {
    title: 'Broken outline',
    outline: '# Phase\n- Step without lesson'
  });

  await page.locator('#learning-plan-import-form').getByRole('button', { name: 'Preview' }).click();

  await expect(page.locator('#learning-plan-error')).toContainText('Line 2');
  await expect(page.locator('#learning-plan-error')).toContainText('Step must come after a lesson');
  await expect(page.locator('#learning-plan-import-preview')).toBeHidden();
  await expect(page.locator('#learning-plan-import-form').getByRole('button', { name: 'Import plan' })).toBeDisabled();
  await expect(page.locator('#learning-plan-import-panel')).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), LEARNING_PLAN_REPOSITORY_KEY)).toBeNull();
});

test('import save failure keeps input contents and does not claim success', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await fillImportForm(page, {
    title: 'Blocked import',
    outline: '# Phase\n## Lesson\n- Step'
  });
  await previewImport(page);
  await page.evaluate(key => {
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) throw new Error('blocked write');
      return realSetItem.call(this, keyName, value);
    };
  }, LEARNING_PLAN_REPOSITORY_KEY);

  await importPlan(page);

  await expect(page.locator('#learning-plan-error')).toContainText('Could not import Learning Plan');
  await expect(page.locator('#learning-plan-import-panel')).toBeVisible();
  await expect(page.locator('#learning-plan-import-title-input')).toHaveValue('Blocked import');
  await expect(page.locator('#learning-plan-import-outline')).toHaveValue('# Phase\n## Lesson\n- Step');
  await expect(page.locator('.learning-plan-list-item')).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), LEARNING_PLAN_REPOSITORY_KEY)).toBeNull();
});

test('editing outline or title after Preview invalidates stale import state', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await fillImportForm(page);
  await previewImport(page);

  await page.locator('#learning-plan-import-outline').fill('# Fundamentals\n## Variables\n- Changed task');
  await expect(page.locator('#learning-plan-import-preview')).toBeHidden();
  await expect(page.locator('#learning-plan-import-form').getByRole('button', { name: 'Import plan' })).toBeDisabled();

  await previewImport(page);
  await page.locator('#learning-plan-import-title-input').fill('Changed title');
  await expect(page.locator('#learning-plan-import-preview')).toBeHidden();
  await expect(page.locator('#learning-plan-import-form').getByRole('button', { name: 'Import plan' })).toBeDisabled();
});

test('Import remains unavailable until the current input has a valid preview', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await fillImportForm(page);

  await expect(page.locator('#learning-plan-import-form').getByRole('button', { name: 'Import plan' })).toBeDisabled();
  await previewImport(page);
  await expect(page.locator('#learning-plan-import-form').getByRole('button', { name: 'Import plan' })).toBeEnabled();
  await page.locator('#learning-plan-import-outline').fill('## Lesson before phase');
  await expect(page.locator('#learning-plan-import-form').getByRole('button', { name: 'Import plan' })).toBeDisabled();
});

test('XSS-like import titles render as text in preview and saved UI', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await fillImportForm(page, {
    title: '<script>Plan</script>',
    outline: '# <svg onload=alert(1)>\n## Lesson & "quotes"\n- <img src=x onerror=alert(1)>'
  });
  await previewImport(page);

  await expect(page.locator('#learning-plan-import-preview')).toContainText('<script>Plan</script>');
  await expect(page.locator('#learning-plan-import-preview')).toContainText('<svg onload=alert(1)>');
  await expect(page.locator('#learning-plan-import-preview script')).toHaveCount(0);
  await importPlan(page);

  await expect(page.locator('.learning-plan-list-item')).toContainText('<script>Plan</script>');
  await expect(page.locator('#learning-plan-list script')).toHaveCount(0);
  await expect(page.locator('[data-lp-action="toggle-phase"]').first()).toContainText('<svg onload=alert(1)>');
  await expect(page.locator('.learning-plan-next-card')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('.learning-plan-next-card img')).toHaveCount(0);
  await expect(page.locator('.learning-plan-next-card script')).toHaveCount(0);
});

test('mobile Quick Import preview wraps long outlines without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp(page);
  await openLearningPlans(page);
  await fillImportForm(page, {
    title: 'A very long imported plan title that needs to wrap cleanly on phone width',
    outline: '# Phase with a deliberately long title that must wrap cleanly instead of widening the viewport\n## Lesson with a deliberately long title that remains readable in preview\n- Step with a deliberately long title and punctuation / slashes / parentheses that should wrap safely'
  });

  await previewImport(page);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('manual plan creation persists and reload restores it', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await createPlanThroughUi(page);

  const stored = await storedEnvelope(page);
  expect(stored.plans).toHaveLength(1);
  expect(stored.plans[0].title).toBe('JavaScript fundamentals');
  await expect(page.locator('#learning-plan-create-panel')).toBeHidden();
  await expect(page.locator('#learning-plan-title-input')).toHaveValue('');

  await page.reload();
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await openLearningPlans(page);

  await expect(page.locator('.learning-plan-list-item')).toContainText('JavaScript fundamentals');
  await expect(page.locator('#learning-plan-main')).toContainText('0 / 0 steps');
});

test('phase, lesson, step, complete, and reopen persist through reload', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await createPlanThroughUi(page);
  await addPhaseThroughUi(page);
  await addLessonThroughUi(page);
  await addStepThroughUi(page);

  await page.locator('.learning-plan-step input[type="checkbox"]').check();
  await expect(page.locator('.learning-plan-progress')).toContainText('1 / 1 steps');
  await expect(page.locator('.learning-plan-step-state')).toHaveText('Complete');

  await page.locator('.learning-plan-step input[type="checkbox"]').uncheck();
  await expect(page.locator('.learning-plan-progress')).toContainText('0 / 1 steps');
  await expect(page.locator('.learning-plan-step-state')).toHaveText('Open');

  await page.reload();
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await openLearningPlans(page);

  await expect(page.locator('[data-lp-action="toggle-phase"]').first()).toContainText('Phase 1');
  await expect(page.locator('[data-lp-action="toggle-lesson"]').first()).toContainText('Lesson 1');
  await expect(page.locator('.learning-plan-step').first()).toContainText('Read docs');
  await expect(page.locator('.learning-plan-step input[type="checkbox"]')).not.toBeChecked();
});

test('progress display follows model semantics for seeded completed steps', async ({ page }) => {
  const plan = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock('2026-08-28T12:10:00.000Z') });
  await openApp(page, { learningPlanRaw: envelope([plan]) });
  await openLearningPlans(page);

  await expect(page.locator('.learning-plan-progress')).toContainText('1 / 2 steps');
  await expect(page.locator('.learning-plan-progress')).toContainText('50%');
  await expect(page.locator('.learning-plan-list-progress')).toHaveText('1 / 2 steps - 50%');
});

test('incomplete plan shows the selected plan Next Action with context', async ({ page }) => {
  const plan = completeStep(multiSectionPlan(), 'step-1-1-1', { clock: fixedClock('2026-08-28T12:10:00.000Z') });
  await openApp(page, { learningPlanRaw: envelope([plan]) });
  await page.evaluate(key => {
    window.__learningPlanSetCalls = 0;
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) window.__learningPlanSetCalls++;
      return realSetItem.call(this, keyName, value);
    };
  }, LEARNING_PLAN_REPOSITORY_KEY);
  await openLearningPlans(page);

  const card = page.locator('.learning-plan-next-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('NEXT ACTION');
  await expect(card.locator('.learning-plan-next-title')).toHaveText('Step 1.1.2');
  await expect(card.locator('.learning-plan-next-context')).toHaveText('Phase 1 - Lesson 1.1');
  await expect(card.getByRole('button', { name: 'Start Focus: Step 1.1.2' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Open next step: Step 1.1.2' })).toBeVisible();
  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(0);
});

test('Start Focus starts existing Focus with exact Next Action IDs and readable context without completing the step', async ({ page }) => {
  const plan = completeStep(multiSectionPlan(), 'step-1-1-1', { clock: fixedClock('2026-08-28T12:10:00.000Z') });
  await openApp(page, { learningPlanRaw: envelope([plan]) });
  await openLearningPlans(page);
  const before = await storedEnvelope(page);

  await page.evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.resolve(); });
  await page.getByRole('button', { name: 'Start Focus: Step 1.1.2' }).click();

  await expect(page.locator('#focus-overlay')).toHaveClass(/open/);
  await expect(page.locator('#focus-phase-label')).toHaveText('FOCUS');
  await expect(page.locator('#focus-intention-text')).toHaveText('Step 1.1.2');
  await expect(page.locator('#focus-phase-sub')).toHaveText('Structured course · Phase 1 · Lesson 1.1 · 25 min');
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step 1.1.2');

  const state = await page.evaluate(() => ({
    metadata: getFocusLearningPlanMetadata(),
    entries: JSON.parse(localStorage.getItem('ta3-entries') || '[]'),
    timer: JSON.parse(localStorage.getItem('ta3-timer') || 'null')
  }));
  expect(state.metadata).toEqual({
    planId: 'plan-structured',
    phaseId: 'phase-1',
    lessonId: 'lesson-1-1',
    stepId: 'step-1-1-2',
    planTitle: 'Structured course',
    phaseTitle: 'Phase 1',
    lessonTitle: 'Lesson 1.1',
    stepTitle: 'Step 1.1.2'
  });
  expect(state.entries).toHaveLength(0);
  expect(state.timer).toBeNull();
  expect(await storedEnvelope(page)).toEqual(before);
});

test('generic Focus work completion logs normally without showing a Learning Plan outcome prompt', async ({ page }) => {
  await openApp(page);
  await stubFocusAudio(page);
  const state = await page.evaluate(() => {
    enterFocusMode();
    document.getElementById('focus-task-input').value = 'Generic focus';
    startPomodoro();
    focusStartTime = Date.now() - 25 * 60 * 1000;
    endWorkSession();
    return {
      outcomePrompts: document.querySelectorAll('.learning-plan-focus-outcome').length,
      phase: pomodoroPhase,
      label: document.getElementById('focus-phase-label').textContent,
      entries: JSON.parse(localStorage.getItem('ta3-entries') || '[]')
    };
  });

  expect(state.outcomePrompts).toBe(0);
  expect(state.phase).toBe('break');
  expect(state.label).toBe('BREAK ☕');
  expect(state.entries).toHaveLength(1);
  expect(state.entries[0].activity).toBe('Generic focus');
});

test('Learning Plan Focus completion shows one Done or Continue prompt with correct context and does not auto-complete', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);

  await finishLearningPlanFocusWork(page);

  const prompt = page.getByRole('region', { name: 'Focus outcome' });
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Focus complete');
  await expect(prompt).toContainText('Did you finish this step?');
  await expect(prompt).toContainText('Step A');
  await expect(prompt).toContainText('Frontend fundamentals · Phase A · Lesson A');
  await expect(prompt.getByRole('button', { name: 'Done' })).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(page.locator('.learning-plan-focus-outcome')).toHaveCount(1);
  await expect(page.locator('#focus-overlay')).not.toHaveClass(/open/);

  const stored = await storedEnvelope(page);
  expect(stored.plans[0].phases[0].lessons[0].steps[0].completed).toBe(false);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');
});

test('Done completes the exact Learning Plan step once and advances Next Action', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page);
  await countLearningPlanWrites(page);

  await focusOutcomeButton(page, 'Done').click();

  const stored = await storedEnvelope(page);
  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(1);
  expect(stored.plans[0].id).toBe('plan-a');
  expect(stored.plans[0].phases[0].id).toBe('phase-a');
  expect(stored.plans[0].phases[0].lessons[0].id).toBe('lesson-a');
  expect(stored.plans[0].phases[0].lessons[0].steps[0].id).toBe('step-a');
  expect(stored.plans[0].phases[0].lessons[0].steps[0].completed).toBe(true);
  expect(stored.plans[0].phases[0].lessons[0].steps[1].completed).toBe(false);
  const events = await lifeLedgerEvents(page);
  expect(events.map(event => event.type).sort()).toEqual(['focus_session_completed', 'plan_step_completed']);
  const stepEvent = events.find(event => event.type === 'plan_step_completed');
  const focusEvent = events.find(event => event.type === 'focus_session_completed');
  expect(stepEvent.sourceEntityId).toBe(learningPlanStepSourceEntityId('plan-a', 'step-a'));
  expect(stepEvent.payload.stepLabel).toBe('Step A');
  expect(stepEvent.payload.trackedMinutes).toBe(25);
  expect(focusEvent.sourceEntityId).toBe(focusEvent.payload.source.focusEntryId);
  await expect(page.locator('.learning-plan-focus-outcome')).toHaveCount(0);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step B');
});

test('Continue performs zero Learning Plan writes and leaves the same Next Action', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  const before = await storedEnvelope(page);
  await finishLearningPlanFocusWork(page);
  await countLearningPlanWrites(page);

  await focusOutcomeButton(page, 'Continue').click();

  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(0);
  expect(await storedEnvelope(page)).toEqual(before);
  const events = await lifeLedgerEvents(page);
  expect(events.map(event => event.type)).toEqual(['focus_session_completed']);
  expect(events[0].payload.additiveForTimeTotals).toBe(false);
  await expect(page.locator('.learning-plan-focus-outcome')).toHaveCount(0);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');
});

test('rapid Done activation creates at most one completion save', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page);
  await countLearningPlanWrites(page);

  await focusOutcomeButton(page, 'Done').dblclick();

  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(1);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step B');
});

test('duplicate-title Learning Plan outcome completes the step by immutable IDs only', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([duplicateTitlePlan()]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page, 'Start Focus: Repeated step');

  await focusOutcomeButton(page, 'Done').click();

  const stepStates = await page.evaluate(key => {
    const plan = JSON.parse(localStorage.getItem(key)).plans[0];
    return plan.phases.flatMap(phase => phase.lessons.flatMap(lesson => lesson.steps.map(step => ({
      id: step.id,
      completed: step.completed
    }))));
  }, LEARNING_PLAN_REPOSITORY_KEY);
  expect(stepStates).toEqual([
    { id: 'step-dup-a', completed: true },
    { id: 'step-dup-b', completed: true }
  ]);
});

test('stale deleted outcome target cannot complete another Learning Plan step', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page);
  await countLearningPlanWrites(page);
  await page.evaluate(key => {
    const stored = JSON.parse(localStorage.getItem(key));
    stored.plans[0].phases[0].lessons[0].steps = stored.plans[0].phases[0].lessons[0].steps.filter(step => step.id !== 'step-a');
    window.__learningPlanRealSetItem.call(localStorage, key, JSON.stringify(stored));
    window.__learningPlanSetCalls = 0;
  }, LEARNING_PLAN_REPOSITORY_KEY);

  await focusOutcomeButton(page, 'Done').click();

  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(0);
  await expect(page.locator('#learning-plan-error')).toContainText('no longer exists');
  const stored = await storedEnvelope(page);
  expect(stored.plans[0].phases[0].lessons[0].steps.map(step => step.id)).toEqual(['step-b']);
  expect(stored.plans[0].phases[0].lessons[0].steps[0].completed).toBe(false);
});

test('already-completed outcome target clears deterministically without another save', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page);
  await countLearningPlanWrites(page);
  await page.evaluate(key => {
    const stored = JSON.parse(localStorage.getItem(key));
    stored.plans[0].phases[0].lessons[0].steps[0].completed = true;
    stored.plans[0].phases[0].lessons[0].steps[0].completedAt = '2026-08-28T12:30:00.000Z';
    window.__learningPlanRealSetItem.call(localStorage, key, JSON.stringify(stored));
    window.__learningPlanSetCalls = 0;
  }, LEARNING_PLAN_REPOSITORY_KEY);

  await focusOutcomeButton(page, 'Done').click();

  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(0);
  await expect(page.locator('.learning-plan-focus-outcome')).toHaveCount(0);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step B');
});

test('Done save failure keeps the outcome prompt and does not falsely advance', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  const before = await storedEnvelope(page);
  await finishLearningPlanFocusWork(page);
  await page.evaluate(key => {
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) throw new Error('blocked write');
      return realSetItem.call(this, keyName, value);
    };
  }, LEARNING_PLAN_REPOSITORY_KEY);

  await focusOutcomeButton(page, 'Done').click();

  await expect(page.locator('#learning-plan-error')).toContainText('Unable to write Learning Plan storage');
  await expect(page.locator('.learning-plan-focus-outcome')).toHaveCount(1);
  expect(await storedEnvelope(page)).toEqual(before);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');
});

test('Focus Life Ledger failure keeps the time entry and retries without duplicate focus events', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await page.evaluate(key => {
    window.__realLedgerSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) throw new Error('blocked ledger write');
      return window.__realLedgerSetItem.call(this, keyName, value);
    };
  }, LIFE_LEDGER_RUNTIME_KEY);

  await finishLearningPlanFocusWork(page);

  await expect(page.locator('#learning-plan-error')).toContainText('Life Ledger history is pending');
  await expect(page.locator('.learning-plan-focus-outcome-warning')).toContainText('Focus history pending');
  const savedWhileBlocked = await page.evaluate(() => JSON.parse(localStorage.getItem('ta3-entries') || '[]'));
  expect(savedWhileBlocked).toHaveLength(1);
  expect(await lifeLedgerEnvelope(page)).toBeNull();

  await page.evaluate(() => { Storage.prototype.setItem = window.__realLedgerSetItem; });
  await focusOutcomeButton(page, 'Continue').click();

  const events = await lifeLedgerEvents(page);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe('focus_session_completed');
  expect(events[0].payload.additiveForTimeTotals).toBe(false);
  await expect(page.locator('.learning-plan-focus-outcome')).toHaveCount(0);
});

test('Done plan save success with step ledger failure keeps retryable pending outcome', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page);
  await countLearningPlanWrites(page);
  await page.evaluate(key => {
    window.__realLedgerSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) throw new Error('blocked ledger write');
      return window.__realLedgerSetItem.call(this, keyName, value);
    };
  }, LIFE_LEDGER_RUNTIME_KEY);

  await focusOutcomeButton(page, 'Done').click();

  const stored = await storedEnvelope(page);
  expect(stored.plans[0].phases[0].lessons[0].steps[0].completed).toBe(true);
  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(1);
  await expect(page.locator('.learning-plan-focus-outcome')).toHaveCount(1);
  await expect(page.locator('.learning-plan-focus-outcome-warning')).toContainText('Step completion history pending');
  expect((await lifeLedgerEvents(page)).map(event => event.type)).toEqual(['focus_session_completed']);

  await page.evaluate(() => { Storage.prototype.setItem = window.__realLedgerSetItem; });
  await focusOutcomeButton(page, 'Done').click();

  const events = await lifeLedgerEvents(page);
  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(1);
  expect(events.map(event => event.type).sort()).toEqual(['focus_session_completed', 'plan_step_completed']);
  await expect(page.locator('.learning-plan-focus-outcome')).toHaveCount(0);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step B');
});

test('repository corruption during Done does not overwrite or reset stored data', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page);
  await page.evaluate(key => localStorage.setItem(key, '{bad json'), LEARNING_PLAN_REPOSITORY_KEY);

  await focusOutcomeButton(page, 'Done').click();

  await expect(page.locator('#learning-plan-error')).toContainText('malformed JSON');
  expect(await page.evaluate(key => localStorage.getItem(key), LEARNING_PLAN_REPOSITORY_KEY)).toBe('{bad json');
});

test('completion context clears after Done and after Continue', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page);
  await focusOutcomeButton(page, 'Done').click();
  await expect(page.locator('.learning-plan-focus-outcome')).toHaveCount(0);

  const plan = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock('2026-08-28T12:10:00.000Z') });
  await page.evaluate(({ key, raw }) => {
    localStorage.setItem(key, raw);
    window.renderLearningPlans();
  }, { key: LEARNING_PLAN_REPOSITORY_KEY, raw: envelope([plan]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page, 'Start Focus: Step B');
  await focusOutcomeButton(page, 'Continue').click();

  await expect(page.locator('.learning-plan-focus-outcome')).toHaveCount(0);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step B');
});

test('later generic Focus gets no stale Learning Plan outcome decision', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page);
  await focusOutcomeButton(page, 'Continue').click();

  const state = await page.evaluate(() => {
    enterFocusMode();
    document.getElementById('focus-task-input').value = 'Generic follow-up';
    startPomodoro();
    focusStartTime = Date.now() - 5 * 60 * 1000;
    endWorkSession();
    return {
      outcomePrompts: document.querySelectorAll('.learning-plan-focus-outcome').length,
      entries: JSON.parse(localStorage.getItem('ta3-entries') || '[]')
    };
  });

  expect(state.outcomePrompts).toBe(0);
  expect(state.entries.map(entry => entry.activity)).toEqual(['Generic follow-up', 'Step A']);
});

test('Learning Plan Focus A then B cannot reuse the A outcome decision', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan(), planWithBackendStep()]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page, 'Start Focus: Step A');
  await focusOutcomeButton(page, 'Continue').click();
  await page.locator('.learning-plan-list-item').filter({ hasText: 'Backend fundamentals' }).click();
  await finishLearningPlanFocusWork(page, 'Start Focus: Build endpoint');

  const prompt = page.getByRole('region', { name: 'Focus outcome' });
  await expect(prompt).toContainText('Build endpoint');
  await expect(prompt).toContainText('Backend fundamentals · API phase · API lesson');
  await expect(prompt).not.toContainText('Step A');
});

test('early logged Learning Plan Focus exit still asks for explicit outcome', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await stubFocusAudio(page);
  await page.getByRole('button', { name: 'Start Focus: Step A' }).click();

  await page.evaluate(() => {
    focusStartTime = Date.now() - 3 * 60 * 1000;
    confirmExitFocus();
  });

  await expect(page.getByRole('region', { name: 'Focus outcome' })).toBeVisible();
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');
});

test('abandoned unlogged Learning Plan Focus exit does not show outcome prompt', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await stubFocusAudio(page);
  await page.getByRole('button', { name: 'Start Focus: Step A' }).click();

  await page.evaluate(() => { confirmExitFocus(); });

  await expect(page.locator('.learning-plan-focus-outcome')).toHaveCount(0);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');
});

test('Learning Plan outcome keeps provenance out of entries, timer sync, and Firebase while writing local Life Ledger', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await page.evaluate(() => {
    window.__dispatchedEvents = [];
    const realDispatch = window.dispatchEvent.bind(window);
    window.dispatchEvent = event => {
      window.__dispatchedEvents.push(event.type);
      return realDispatch(event);
    };
  });
  await captureSyncWrites(page);
  await finishLearningPlanFocusWork(page);

  const state = await page.evaluate(() => ({
    entries: JSON.parse(localStorage.getItem('ta3-entries') || '[]'),
    timer: JSON.parse(localStorage.getItem('ta3-timer') || 'null'),
    payloads: window.__syncPayloads,
    dispatchedEvents: window.__dispatchedEvents,
    allStorage: Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return [key, localStorage.getItem(key)];
    }))
  }));

  expect(state.entries).toHaveLength(1);
  expectNoLearningPlanProvenance(state.entries);
  expectNoLearningPlanProvenance(state.payloads);
  expect(state.timer).toBeNull();
  expect(state.allStorage).toHaveProperty('ta3-life-ledger-v1');
  expect(JSON.stringify(state.dispatchedEvents)).not.toContain('plan_step_completed');
  expect(JSON.stringify(state.dispatchedEvents)).not.toContain('focus_session_completed');
  const events = await lifeLedgerEvents(page);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe('focus_session_completed');
  expect(events[0].payload.source.stepId).toBe('step-a');
  expect(events[0].payload.additiveForTimeTotals).toBe(false);
});

test('mobile Learning Plan outcome controls fit without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await finishLearningPlanFocusWork(page);

  await expect(page.getByRole('region', { name: 'Focus outcome' })).toBeVisible();
  await expect(focusOutcomeButton(page, 'Done')).toBeVisible();
  await expect(focusOutcomeButton(page, 'Continue')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('Learning Plan provenance clears before skipped break starts the next Pomodoro', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await stubFocusAudio(page);
  await page.getByRole('button', { name: 'Start Focus: Step A' }).click();

  const state = await page.evaluate(() => {
    focusStartTime = Date.now() - 25 * 60 * 1000;
    endWorkSession();
    const afterWorkMetadata = getFocusLearningPlanMetadata();
    document.getElementById('focus-task-input').value = 'Generic after skip';
    skipBreak();
    return {
      afterWorkMetadata,
      afterSkipMetadata: getFocusLearningPlanMetadata(),
      task: getFocusTaskLabel(),
      sub: document.getElementById('focus-phase-sub').textContent,
      entries: JSON.parse(localStorage.getItem('ta3-entries') || '[]')
    };
  });

  expect(state.afterWorkMetadata).toBeNull();
  expect(state.afterSkipMetadata).toBeNull();
  expect(state.task).toBe('Generic after skip');
  expect(state.sub).toBe('work session · 25 min');
  expect(state.entries).toHaveLength(1);
  expectNoLearningPlanProvenance(state.entries);
});

test('Learning Plan provenance clears before completed break auto-starts the next Pomodoro', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await stubFocusAudio(page);
  await page.getByRole('button', { name: 'Start Focus: Step A' }).click();

  const state = await page.evaluate(() => {
    _pomodoroAutoStart = true;
    focusStartTime = Date.now() - 25 * 60 * 1000;
    endWorkSession();
    document.getElementById('focus-task-input').value = 'Generic after auto break';
    endPomodoroBreak();
    _pomodoroAutoStart = false;
    return {
      metadata: getFocusLearningPlanMetadata(),
      task: getFocusTaskLabel(),
      sub: document.getElementById('focus-phase-sub').textContent,
      entries: JSON.parse(localStorage.getItem('ta3-entries') || '[]')
    };
  });

  expect(state.metadata).toBeNull();
  expect(state.task).toBe('Generic after auto break');
  expect(state.sub).toBe('work session · 25 min');
  expect(state.entries).toHaveLength(1);
  expectNoLearningPlanProvenance(state.entries);
});

test('later generic Focus cannot inherit Learning Plan provenance', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await stubFocusAudio(page);
  await page.getByRole('button', { name: 'Start Focus: Step A' }).click();

  const state = await page.evaluate(() => {
    focusStartTime = Date.now() - 7 * 60 * 1000;
    confirmExitFocus();
    enterFocusMode();
    document.getElementById('focus-task-input').value = 'Generic focus';
    const started = startPomodoro();
    return {
      started,
      metadata: getFocusLearningPlanMetadata(),
      task: getFocusTaskLabel(),
      entries: JSON.parse(localStorage.getItem('ta3-entries') || '[]')
    };
  });

  expect(state.started).toBe(true);
  expect(state.metadata).toBeNull();
  expect(state.task).toBe('Generic focus');
  expect(state.entries).toHaveLength(1);
  expectNoLearningPlanProvenance(state.entries);
});

test('Learning Plan Focus A followed by Learning Plan Focus B carries only B provenance', async ({ page }) => {
  let second = secondLearningPlan();
  second = addPhase(second, { title: 'API phase' }, { idGenerator: sequencedIds('phase-b'), clock: fixedClock() });
  second = addLesson(second, 'phase-b', { title: 'API lesson' }, { idGenerator: sequencedIds('lesson-b'), clock: fixedClock() });
  second = addStep(second, 'lesson-b', { title: 'Build endpoint' }, { idGenerator: sequencedIds('step-build-endpoint'), clock: fixedClock() });
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan(), second]) });
  await openLearningPlans(page);
  await stubFocusAudio(page);

  await page.getByRole('button', { name: 'Start Focus: Step A' }).click();
  await page.evaluate(() => { confirmExitFocus(); });
  await page.locator('.learning-plan-list-item').filter({ hasText: 'Backend fundamentals' }).click();
  await page.getByRole('button', { name: 'Start Focus: Build endpoint' }).click();
  const metadata = await page.evaluate(() => getFocusLearningPlanMetadata());

  expect(metadata).toEqual({
    planId: 'plan-b',
    phaseId: 'phase-b',
    lessonId: 'lesson-b',
    stepId: 'step-build-endpoint',
    planTitle: 'Backend fundamentals',
    phaseTitle: 'API phase',
    lessonTitle: 'API lesson',
    stepTitle: 'Build endpoint'
  });
});

test('Learning Plan Focus does not persist provenance in synced timer or entry payloads', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await stubFocusAudio(page);
  await captureSyncWrites(page);

  await page.getByRole('button', { name: 'Start Focus: Step A' }).click();
  const during = await page.evaluate(() => ({
    metadata: getFocusLearningPlanMetadata(),
    payloads: window.__syncPayloads
  }));
  expect(during.metadata?.planId).toBe('plan-a');
  expectNoLearningPlanProvenance(during.payloads);

  const after = await page.evaluate(() => {
    focusStartTime = Date.now() - 7 * 60 * 1000;
    confirmExitFocus();
    return {
      entries: JSON.parse(localStorage.getItem('ta3-entries') || '[]'),
      payloads: window.__syncPayloads
    };
  });
  expect(after.entries).toHaveLength(1);
  expectNoLearningPlanProvenance(after.entries);
  expectNoLearningPlanProvenance(after.payloads);
});

test('rapid Start Focus activation creates one Focus session and no duplicate Learning Plan writes', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await page.evaluate(key => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.__learningPlanSetCalls = 0;
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) window.__learningPlanSetCalls++;
      return realSetItem.call(this, keyName, value);
    };
  }, LEARNING_PLAN_REPOSITORY_KEY);

  const start = page.getByRole('button', { name: 'Start Focus: Step A' });
  await start.dblclick();
  const state = await page.evaluate(() => {
    const firstStart = focusStartTime;
    document.querySelector('[data-lp-action="start-next-focus"]')?.click();
    return {
      firstStart,
      afterClickStart: focusStartTime,
      running: isFocusSessionRunning(),
      task: getFocusTaskLabel(),
      setCalls: window.__learningPlanSetCalls
    };
  });

  expect(state.firstStart).toBeGreaterThan(0);
  expect(state.afterClickStart).toBe(state.firstStart);
  expect(state.running).toBe(true);
  expect(state.task).toBe('Step A');
  expect(state.setCalls).toBe(0);
});

test('Start Focus control remains usable after exiting an uncompleted Learning Plan session', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await stubFocusAudio(page);

  await page.getByRole('button', { name: 'Start Focus: Step A' }).click();
  const firstStart = await page.evaluate(() => focusStartTime);
  await page.evaluate(() => { confirmExitFocus(); });
  await openLearningPlans(page);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');
  await expect(page.getByRole('button', { name: 'Start Focus: Step A' })).toBeEnabled();
  await page.waitForTimeout(20);
  await page.getByRole('button', { name: 'Start Focus: Step A' }).click();

  const state = await page.evaluate(() => ({
    focusStartTime,
    metadata: getFocusLearningPlanMetadata(),
    running: isFocusSessionRunning(),
    entries: JSON.parse(localStorage.getItem('ta3-entries') || '[]')
  }));
  expect(state.focusStartTime).toBeGreaterThan(firstStart);
  expect(state.metadata?.stepId).toBe('step-a');
  expect(state.running).toBe(true);
  expect(state.entries).toHaveLength(0);
});

test('stale Start Focus controls cannot start a previous, completed, or deleted Next Action', async ({ page }) => {
  let second = secondLearningPlan();
  second = addPhase(second, { title: 'API phase' }, { idGenerator: sequencedIds('phase-b'), clock: fixedClock() });
  second = addLesson(second, 'phase-b', { title: 'API lesson' }, { idGenerator: sequencedIds('lesson-b'), clock: fixedClock() });
  second = addStep(second, 'lesson-b', { title: 'Build endpoint' }, { idGenerator: sequencedIds('step-build-endpoint'), clock: fixedClock() });
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan(), second]) });
  await openLearningPlans(page);
  await page.evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.resolve(); });

  const staleDataset = await page.locator('[data-lp-action="start-next-focus"]').evaluate(button => ({ ...button.dataset }));
  await page.locator('.learning-plan-list-item').filter({ hasText: 'Backend fundamentals' }).click();
  await page.evaluate(dataset => {
    const stale = document.createElement('button');
    Object.entries(dataset).forEach(([key, value]) => { stale.dataset[key] = value; });
    stale.textContent = 'stale';
    document.getElementById('view-learning').append(stale);
    stale.click();
    stale.remove();
  }, staleDataset);
  await expect(page.locator('#learning-plan-error')).toContainText('selected Learning Plan changed');
  expect(await page.evaluate(() => isFocusSessionRunning())).toBe(false);

  await page.locator('.learning-plan-list-item').filter({ hasText: 'Frontend fundamentals' }).click();
  const completedDataset = await page.locator('[data-lp-action="start-next-focus"]').evaluate(button => ({ ...button.dataset }));
  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').check();
  await page.evaluate(dataset => {
    const stale = document.createElement('button');
    Object.entries(dataset).forEach(([key, value]) => { stale.dataset[key] = value; });
    document.getElementById('view-learning').append(stale);
    stale.click();
    stale.remove();
  }, completedDataset);
  await expect(page.locator('#learning-plan-error')).toContainText('Next Action changed');
  expect(await page.evaluate(() => isFocusSessionRunning())).toBe(false);

  const deletedDataset = await page.locator('[data-lp-action="start-next-focus"]').evaluate(button => ({ ...button.dataset }));
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.evaluate(dataset => {
    const stale = document.createElement('button');
    Object.entries(dataset).forEach(([key, value]) => { stale.dataset[key] = value; });
    document.getElementById('view-learning').append(stale);
    stale.click();
    stale.remove();
  }, deletedDataset);
  await expect(page.locator('#learning-plan-error')).toContainText('selected Learning Plan changed');
  expect(await page.evaluate(() => isFocusSessionRunning())).toBe(false);
});

test('Start Focus failure leaves Learning Plan state unchanged', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  const before = await storedEnvelope(page);
  await page.evaluate(() => {
    window.enterFocusMode = () => { throw new Error('blocked focus start'); };
  });

  await page.getByRole('button', { name: 'Start Focus: Step A' }).click();

  await expect(page.locator('#learning-plan-error')).toContainText('blocked focus start');
  await expect(page.locator('#focus-overlay')).not.toHaveClass(/open/);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');
  expect(await storedEnvelope(page)).toEqual(before);
});

test('existing generic Focus start still uses default duration and no Learning Plan metadata', async ({ page }) => {
  await openApp(page);
  const state = await page.evaluate(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    enterFocusMode();
    document.getElementById('focus-task-input').value = 'Generic focus';
    const started = startPomodoro();
    return {
      started,
      task: getFocusTaskLabel(),
      countdown: document.getElementById('focus-countdown').textContent,
      sub: document.getElementById('focus-phase-sub').textContent,
      metadata: getFocusLearningPlanMetadata()
    };
  });

  expect(state).toEqual({
    started: true,
    task: 'Generic focus',
    countdown: '25:00',
    sub: 'work session · 25 min',
    metadata: null
  });
});

test('active Focus prevents a second Learning Plan Start Focus while preserving the running session', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await page.evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.resolve(); });
  const startDataset = await page.locator('[data-lp-action="start-next-focus"]').evaluate(button => ({ ...button.dataset }));
  await page.getByRole('button', { name: 'Start Focus: Step A' }).click();
  const firstStart = await page.evaluate(() => focusStartTime);

  await page.evaluate(dataset => {
    const duplicate = document.createElement('button');
    Object.entries(dataset).forEach(([key, value]) => { duplicate.dataset[key] = value; });
    document.getElementById('view-learning').append(duplicate);
    duplicate.click();
  }, startDataset);

  await expect(page.locator('#learning-plan-error')).toContainText('Focus is already running');
  const state = await page.evaluate(() => ({
    focusStartTime,
    task: getFocusTaskLabel(),
    running: isFocusSessionRunning()
  }));
  expect(state).toEqual({
    focusStartTime: firstStart,
    task: 'Step A',
    running: true
  });
});

test('Open step expands the exact phase and lesson, reveals the target step, and writes nothing', async ({ page }) => {
  const plan = multiSectionPlan({ sameTitles: true, completeFirstLesson: true });
  await openApp(page, { learningPlanRaw: envelope([plan]) });
  await openLearningPlans(page);
  await page.evaluate(key => {
    window.__learningPlanSetCalls = 0;
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) window.__learningPlanSetCalls++;
      return realSetItem.call(this, keyName, value);
    };
  }, LEARNING_PLAN_REPOSITORY_KEY);

  await page.locator('[data-lp-action="toggle-phase"][data-phase-id="phase-1"]').click();
  await expect(page.locator('[data-lp-action="toggle-phase"][data-phase-id="phase-1"]')).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Open next step: Step 1.2.1' }).click();

  await expect(page.locator('[data-lp-action="toggle-phase"][data-phase-id="phase-1"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-lp-action="toggle-lesson"][data-lesson-id="lesson-1-2"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-lp-step-target="step-1-2-1"]')).toBeVisible();
  await expect(page.locator('[data-lp-step-target="step-1-2-1"]')).toBeFocused();
  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(0);
});

test('completing and reopening steps updates Next Action from durable hierarchy', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);

  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');
  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').check();
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step B');
  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').uncheck();
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');
});

test('manual complete records a plan_step_completed Life Ledger event', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);

  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').check();

  const events = await lifeLedgerEvents(page);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe('plan_step_completed');
  expect(events[0].sourceEntityId).toBe(learningPlanStepSourceEntityId('plan-a', 'step-a'));
  expect(events[0].payload.stepLabel).toBe('Step A');
  expect(events[0].tombstone.active).toBe(false);
});

test('manual reopen tombstones the existing plan_step_completed event', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);

  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').check();
  const [created] = await lifeLedgerEvents(page);
  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').uncheck();

  const [event] = await lifeLedgerEvents(page);
  expect(event.eventId).toBe(created.eventId);
  expect(event.revision).toBe(2);
  expect(event.tombstone.active).toBe(true);
  expect(event.tombstone.reason).toBe('user_delete');
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');
});

test('manual complete after reopen restores the same Life Ledger event', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);

  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').check();
  const [created] = await lifeLedgerEvents(page);
  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').uncheck();
  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').check();

  const [event] = await lifeLedgerEvents(page);
  expect(event.eventId).toBe(created.eventId);
  expect(event.revision).toBe(3);
  expect(event.tombstone.active).toBe(false);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step B');
});

test('manual ledger write failure leaves completion saved with retry evidence', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await page.evaluate(key => {
    window.__realLedgerSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) throw new Error('blocked ledger write');
      return window.__realLedgerSetItem.call(this, keyName, value);
    };
  }, LIFE_LEDGER_RUNTIME_KEY);

  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').check();

  const stored = await storedEnvelope(page);
  expect(stored.plans[0].phases[0].lessons[0].steps[0].completed).toBe(true);
  await expect(page.locator('#learning-plan-error')).toContainText('Life Ledger history is pending');
  await expect(page.getByRole('region', { name: 'Life Ledger retry' })).toBeVisible();
  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(1);
  expect(await lifeLedgerEnvelope(page)).toBeNull();

  await page.getByRole('region', { name: 'Life Ledger retry' }).getByRole('button', { name: 'Retry history' }).click();
  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(1);

  await page.evaluate(() => { Storage.prototype.setItem = window.__realLedgerSetItem; });
  await page.getByRole('region', { name: 'Life Ledger retry' }).getByRole('button', { name: 'Retry history' }).click();

  await expect(page.getByRole('region', { name: 'Life Ledger retry' })).toHaveCount(0);
  expect((await lifeLedgerEvents(page)).map(event => event.type)).toEqual(['plan_step_completed']);
});

test('successful later step write does not clear an earlier pending step retry', async ({ page }) => {
  const stepAIdentity = learningPlanStepSourceEntityId('plan-a', 'step-a');
  const stepBIdentity = learningPlanStepSourceEntityId('plan-a', 'step-b');
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await installSelectiveLedgerFailure(page, [stepAIdentity]);

  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').check();
  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(1);

  await setBlockedLedgerNeedles(page, []);
  await page.locator('[data-lp-step-target="step-b"] input[type="checkbox"]').check();

  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(1);
  expect((await lifeLedgerEvents(page)).map(event => event.sourceEntityId)).toEqual([stepBIdentity]);

  await restoreLedgerWrites(page);
  await page.getByRole('region', { name: 'Life Ledger retry' }).getByRole('button', { name: 'Retry history' }).click();

  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(0);
  expect((await lifeLedgerEvents(page)).map(event => event.sourceEntityId).sort()).toEqual([stepAIdentity, stepBIdentity].sort());
});

test('two failed step writes both remain pending and recoverable', async ({ page }) => {
  const stepAIdentity = learningPlanStepSourceEntityId('plan-a', 'step-a');
  const stepBIdentity = learningPlanStepSourceEntityId('plan-a', 'step-b');
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await installSelectiveLedgerFailure(page, [stepAIdentity, stepBIdentity]);

  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').check();
  await page.locator('[data-lp-step-target="step-b"] input[type="checkbox"]').check();

  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(2);
  expect(await lifeLedgerEnvelope(page)).toBeNull();

  await restoreLedgerWrites(page);
  await page.getByRole('region', { name: 'Life Ledger retry' }).getByRole('button', { name: 'Retry history' }).click();

  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(0);
  expect((await lifeLedgerEvents(page)).map(event => event.sourceEntityId).sort()).toEqual([stepAIdentity, stepBIdentity].sort());
});

test('failed step retry followed by failed Focus event keeps both retries', async ({ page }) => {
  const stepAIdentity = learningPlanStepSourceEntityId('plan-a', 'step-a');
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await installSelectiveLedgerFailure(page, [stepAIdentity]);

  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').check();
  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(1);

  await blockAllLedgerWrites(page);
  await finishLearningPlanFocusWork(page, 'Start Focus: Step B');

  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(2);
  await expect(page.locator('[data-ledger-retry-key]').filter({ hasText: 'Learning Plan step was saved' })).toHaveCount(1);
  await expect(page.locator('[data-ledger-retry-key]').filter({ hasText: 'Focus session was saved' })).toHaveCount(1);
});

test('retry history clears only successful retry items and preserves remaining failures', async ({ page }) => {
  const stepAIdentity = learningPlanStepSourceEntityId('plan-a', 'step-a');
  const stepBIdentity = learningPlanStepSourceEntityId('plan-a', 'step-b');
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await installSelectiveLedgerFailure(page, [stepAIdentity, stepBIdentity]);

  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').check();
  await page.locator('[data-lp-step-target="step-b"] input[type="checkbox"]').check();
  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(2);

  await setBlockedLedgerNeedles(page, [stepBIdentity]);
  await page.getByRole('region', { name: 'Life Ledger retry' }).getByRole('button', { name: 'Retry history' }).click();

  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(1);
  await expect(page.locator('[data-ledger-retry-key]').first()).toContainText('Learning Plan step');
  expect((await lifeLedgerEvents(page)).map(event => event.sourceEntityId)).toEqual([stepAIdentity]);

  await restoreLedgerWrites(page);
  await page.getByRole('region', { name: 'Life Ledger retry' }).getByRole('button', { name: 'Retry history' }).click();

  await expect(page.locator('[data-ledger-retry-key]')).toHaveCount(0);
  expect((await lifeLedgerEvents(page)).map(event => event.sourceEntityId).sort()).toEqual([stepAIdentity, stepBIdentity].sort());
});

test('fully complete and zero-step plans show distinct Next Action states', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([fullyCompletedPlan(), zeroStepPlan()]) });
  await openLearningPlans(page);

  await expect(page.locator('.learning-plan-next-card')).toContainText('Plan complete');
  await expect(page.locator('.learning-plan-next-card')).toContainText('All 2 steps finished.');
  await expect(page.getByRole('button', { name: /Start Focus/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Open next step/ })).toHaveCount(0);

  await page.locator('[data-lp-action="toggle-phase"][data-phase-id="phase-a"]').click();
  await page.locator('[data-lp-action="toggle-lesson"][data-lesson-id="lesson-a"]').click();
  await page.locator('[data-lp-step-target="step-a"] input[type="checkbox"]').uncheck();
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');

  await page.locator('.learning-plan-list-item').filter({ hasText: 'Shell course' }).click();
  await expect(page.locator('.learning-plan-next-card')).toContainText('No steps yet');
  await expect(page.locator('.learning-plan-next-card')).toContainText('Add a step to begin.');
  await expect(page.locator('.learning-plan-next-card')).not.toContainText('Plan complete');
});

test('switching plans and reload derive the same selected-plan Next Action', async ({ page }) => {
  let first = seededLearningPlan();
  first = completeStep(first, 'step-a', { clock: fixedClock('2026-08-28T12:10:00.000Z') });
  let second = secondLearningPlan();
  second = addPhase(second, { title: 'API phase' }, { idGenerator: sequencedIds('phase-b'), clock: fixedClock() });
  second = addLesson(second, 'phase-b', { title: 'API lesson' }, { idGenerator: sequencedIds('lesson-b'), clock: fixedClock() });
  second = addStep(second, 'lesson-b', { title: 'Build endpoint' }, { idGenerator: sequencedIds('step-build-endpoint'), clock: fixedClock() });
  await openApp(page, { learningPlanRaw: envelope([first, second]) });
  await openLearningPlans(page);

  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step B');
  await page.locator('.learning-plan-list-item').filter({ hasText: 'Backend fundamentals' }).click();
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Build endpoint');

  await page.reload();
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await openLearningPlans(page);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step B');
});

test('default expansion opens first unfinished phase and lesson only', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([multiSectionPlan({ completeFirstLesson: true })]) });
  await openLearningPlans(page);

  const phases = page.locator('[data-lp-action="toggle-phase"]');
  const lessons = page.locator('[data-lp-action="toggle-lesson"]');
  await expect(phases.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(phases.nth(1)).toHaveAttribute('aria-expanded', 'false');
  await expect(lessons.nth(0)).toHaveAttribute('aria-expanded', 'false');
  await expect(lessons.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.learning-plan-step')).toHaveCount(2);

  await page.reload();
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await openLearningPlans(page);

  await expect(page.locator('[data-lp-action="toggle-phase"]').nth(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-lp-action="toggle-phase"]').nth(1)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-lp-action="toggle-lesson"]').nth(0)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-lp-action="toggle-lesson"]').nth(1)).toHaveAttribute('aria-expanded', 'true');
});

test('phase and lesson collapse state follows immutable IDs even with same titles', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([multiSectionPlan({ sameTitles: true })]) });
  await openLearningPlans(page);

  const phases = page.locator('[data-lp-action="toggle-phase"]');
  const firstPhaseId = await phases.nth(0).getAttribute('data-phase-id');
  const secondPhaseId = await phases.nth(1).getAttribute('data-phase-id');
  expect(firstPhaseId).not.toBe(secondPhaseId);
  await phases.nth(1).click();
  await expect(page.locator(`[data-lp-action="toggle-phase"][data-phase-id="${firstPhaseId}"]`)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(`[data-lp-action="toggle-phase"][data-phase-id="${secondPhaseId}"]`)).toHaveAttribute('aria-expanded', 'true');

  const secondPhase = page.locator(`.learning-plan-phase:has([data-phase-id="${secondPhaseId}"])`);
  const secondPhaseLessons = secondPhase.locator('[data-lp-action="toggle-lesson"]');
  const firstLessonId = await secondPhaseLessons.nth(0).getAttribute('data-lesson-id');
  const secondLessonId = await secondPhaseLessons.nth(1).getAttribute('data-lesson-id');
  await secondPhaseLessons.nth(1).click();
  await expect(page.locator(`[data-lp-action="toggle-lesson"][data-lesson-id="${firstLessonId}"]`)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator(`[data-lp-action="toggle-lesson"][data-lesson-id="${secondLessonId}"]`)).toHaveAttribute('aria-expanded', 'true');
});

test('60-step imported plan shows only the active working lesson after import', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await fillImportForm(page, {
    title: 'Large course',
    outline: largeOutline()
  });
  await previewImport(page);
  await importPlan(page);

  const stored = await storedEnvelope(page);
  expect(stored.plans[0].phases.flatMap(phase => phase.lessons.flatMap(lesson => lesson.steps))).toHaveLength(60);
  await expect(page.locator('#learning-plan-import-panel')).toBeHidden();
  await expect(page.locator('[data-lp-action="toggle-phase"]')).toHaveCount(3);
  await expect(page.locator('[data-lp-action="toggle-lesson"]')).toHaveCount(4);
  await expect(page.locator('.learning-plan-step')).toHaveCount(5);
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step 1.1.1');
});

test('plan and step IDs survive UI rename, complete, and reopen', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  const before = await storedEnvelope(page);
  const beforeIds = entityIds(before.plans[0]);

  await renameThroughUi(page, 'plan', 'Frontend fundamentals', 'Frontend mastery');
  await renameThroughUi(page, 'phase', 'Phase A', 'Basics');
  await renameThroughUi(page, 'lesson', 'Lesson A', 'Syntax');
  await renameThroughUi(page, 'step', 'Step A', 'Read docs');
  await page.locator('.learning-plan-step input[type="checkbox"]').first().check();
  await page.locator('.learning-plan-step input[type="checkbox"]').first().uncheck();

  const after = await storedEnvelope(page);
  expect(entityIds(after.plans[0])).toEqual(beforeIds);
  expect(after.plans[0].title).toBe('Frontend mastery');
  expect(after.plans[0].phases[0].lessons[0].steps[0].completed).toBe(false);
});

test('switching plans renders the selected persisted plan', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan(), secondLearningPlan()]) });
  await openLearningPlans(page);

  await expect(page.locator('.learning-plan-plan-title-display')).toContainText('Frontend fundamentals');
  await page.locator('.learning-plan-list-item').filter({ hasText: 'Backend fundamentals' }).click();

  await expect(page.locator('.learning-plan-plan-title-display')).toContainText('Backend fundamentals');
  await expect(page.locator('[data-lp-action="toggle-phase"]')).toHaveCount(0);
});

test('corrupt repository shows an error and does not reset storage', async ({ page }) => {
  await openApp(page, { learningPlanRaw: '{bad json' });
  await openLearningPlans(page);

  await expect(page.locator('#learning-plan-error')).toContainText('could not be loaded');
  await expect(page.locator('#learning-plan-error')).toContainText('malformed JSON');
  await expect(page.getByText('Learning Plans unavailable')).toBeVisible();
  await expect(page.getByText("We couldn't load your saved Learning Plans. Your stored data was left unchanged.")).toBeVisible();
  await expect(page.getByText('No Learning Plans yet.')).toHaveCount(0);
  await expect(page.getByText('Create a Learning Plan to start a checklist.')).toHaveCount(0);
  await expect(page.locator('.learning-plan-create')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Create plan' })).toBeHidden();
  await expect(page.locator('.learning-plan-next-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'How this works' }).click();
  await expect(page.getByRole('region', { name: 'How this works' })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), LEARNING_PLAN_REPOSITORY_KEY)).toBe('{bad json');
});

test('save failure shows an error and does not claim completion persisted', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  await page.evaluate(key => {
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) throw new Error('blocked write');
      return realSetItem.call(this, keyName, value);
    };
  }, LEARNING_PLAN_REPOSITORY_KEY);

  await page.locator('.learning-plan-step input[type="checkbox"]').first().click();

  await expect(page.locator('#learning-plan-error')).toContainText('Could not save Learning Plan changes');
  await expect(page.locator('.learning-plan-step input[type="checkbox"]').first()).not.toBeChecked();
  await expect(page.locator('.learning-plan-progress')).toContainText('0 / 2 steps');
  await expect(page.locator('.learning-plan-next-title')).toHaveText('Step A');
});

test('failed create and duplicate click do not create duplicate plans', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await page.evaluate(key => {
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) throw new Error('blocked write');
      return realSetItem.call(this, keyName, value);
    };
  }, LEARNING_PLAN_REPOSITORY_KEY);

  await page.locator('[data-lp-action="show-create"]').click();
  await page.locator('#learning-plan-title-input').fill('Blocked plan');
  await page.getByRole('button', { name: 'Create plan' }).click();
  await expect(page.locator('#learning-plan-error')).toContainText('Could not create Learning Plan');
  await expect(page.locator('#learning-plan-create-panel')).toBeVisible();
  await expect(page.locator('#learning-plan-title-input')).toHaveValue('Blocked plan');
  await expect(page.locator('.learning-plan-list-item')).toHaveCount(0);

  await page.reload();
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await openLearningPlans(page);
  await page.locator('[data-lp-action="show-create"]').click();
  await page.locator('#learning-plan-title-input').fill('Single plan');
  await page.getByRole('button', { name: 'Create plan' }).dblclick();

  const stored = await storedEnvelope(page);
  expect(stored.plans).toHaveLength(1);
  expect(stored.plans[0].title).toBe('Single plan');
});

test('failed add and failed rename keep editors open with input intact', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await createPlanThroughUi(page);
  await addPhaseThroughUi(page);
  await addLessonThroughUi(page);
  const before = await storedEnvelope(page);
  const beforeIds = entityIds(before.plans[0]);
  await expect(page.locator('form[data-lp-action="add-step"]')).toHaveCount(0);

  await page.evaluate(key => {
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) throw new Error('blocked write');
      return realSetItem.call(this, keyName, value);
    };
  }, LEARNING_PLAN_REPOSITORY_KEY);

  await expect(page.locator('[data-lp-action="open-add"][data-add-kind="step"]').first()).toBeVisible();
  await page.locator('[data-lp-action="open-add"][data-add-kind="step"]').first().click();
  await page.locator('form[data-lp-action="add-step"] input[name="title"]').fill('Blocked step');
  await page.locator('form[data-lp-action="add-step"]').getByRole('button', { name: 'Add step' }).click();
  await expect(page.locator('#learning-plan-error')).toContainText('Could not save Learning Plan changes');
  await expect(page.locator('form[data-lp-action="add-step"]')).toBeVisible();
  await expect(page.locator('form[data-lp-action="add-step"] input[name="title"]')).toHaveValue('Blocked step');

  await page.locator('form[data-lp-action="add-step"]').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.learning-plan-lesson-summary').getByRole('button', { name: 'Edit' }).click();
  await page.locator('form[data-lp-action="rename-lesson"] input[name="title"]').fill('Blocked lesson rename');
  await page.locator('form[data-lp-action="rename-lesson"]').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#learning-plan-error')).toContainText('Could not save Learning Plan changes');
  await expect(page.locator('form[data-lp-action="rename-lesson"] input[name="title"]')).toHaveValue('Blocked lesson rename');
  expect(entityIds((await storedEnvelope(page)).plans[0])).toEqual(beforeIds);
});

test('repeated renders do not duplicate add, checkbox, or rename actions', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await createPlanThroughUi(page);
  await addPhaseThroughUi(page);
  await addLessonThroughUi(page);

  await page.evaluate(() => {
    window.renderLearningPlans();
    window.renderLearningPlans();
    window.renderLearningPlans();
  });
  await addStepThroughUi(page, 'Only step');
  expect((await storedEnvelope(page)).plans[0].phases[0].lessons[0].steps).toHaveLength(1);

  await page.evaluate(key => {
    window.__learningPlanSetCalls = 0;
    window.__learningPlanRealSetItem = window.__learningPlanRealSetItem || Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(keyName, value) {
      if (keyName === key) window.__learningPlanSetCalls++;
      return window.__learningPlanRealSetItem.call(this, keyName, value);
    };
  }, LEARNING_PLAN_REPOSITORY_KEY);
  await page.locator('.learning-plan-step input[type="checkbox"]').check();
  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(1);

  await page.evaluate(() => {
    window.__learningPlanSetCalls = 0;
    window.renderLearningPlans();
    window.renderLearningPlans();
  });
  await renameThroughUi(page, 'step', 'Only step', 'Renamed once');
  expect(await page.evaluate(() => window.__learningPlanSetCalls)).toBe(1);
  expect((await storedEnvelope(page)).plans[0].phases[0].lessons[0].steps[0].title).toBe('Renamed once');
});

test('existing daily plan storage is unaffected by Learning Plan edits', async ({ page }) => {
  const dailyPlans = {
    '2026-08-28': {
      items: [{ id: 'daily-1', task: 'Daily task', when: '', done: false, doneAt: null, updatedAt: 1 }],
      updatedAt: 1
    }
  };
  await openApp(page, { dailyPlans });
  const before = await page.evaluate(() => localStorage.getItem('ta3-plans'));
  await openLearningPlans(page);
  await createPlanThroughUi(page);
  await addPhaseThroughUi(page);
  await addLessonThroughUi(page);
  await addStepThroughUi(page);

  expect(await page.evaluate(() => localStorage.getItem('ta3-plans'))).toBe(before);
});

test('long Learning Plan titles remain usable without mobile horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const longTitle = 'A very long learning plan title that should wrap instead of forcing the page wider than the phone viewport';
  await openApp(page);
  await openLearningPlans(page);
  await createPlanThroughUi(page, longTitle);
  await addPhaseThroughUi(page, 'Phase with a deliberately long title that wraps across multiple compact lines');
  await addLessonThroughUi(page, 'Lesson with a deliberately long title that keeps the hierarchy readable');
  await addStepThroughUi(page, 'Step with a deliberately long checklist label that wraps cleanly on a narrow screen');

  await expect(page.locator('.learning-plan-plan-title-display')).toContainText(longTitle);
  await expect(page.locator('.learning-plan-next-title')).toContainText('Step with a deliberately long checklist label');
  await expect(page.locator('.learning-plan-next-actions')).toBeVisible();
  await page.getByRole('button', { name: 'How this works' }).click();
  await expect(page.getByRole('region', { name: 'How this works' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('visible Learning Plans smoke flow survives reload with completion present', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await createPlanThroughUi(page, 'Low friction learning');
  await addPhaseThroughUi(page, 'Phase alpha');
  await addLessonThroughUi(page, 'Lesson alpha');
  await addStepThroughUi(page, 'Finish alpha step');
  await page.locator('.learning-plan-step input[type="checkbox"]').check();

  await page.reload();
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await openLearningPlans(page);

  await expect(page.locator('.learning-plan-list-item')).toContainText('Low friction learning');
  await expect(page.locator('[data-lp-action="toggle-phase"]').first()).toContainText('Phase alpha');
  await expect(page.locator('[data-lp-action="toggle-phase"]').first()).toHaveAttribute('aria-expanded', 'false');
  await page.locator('[data-lp-action="toggle-phase"]').first().click();
  await expect(page.locator('[data-lp-action="toggle-lesson"]').first()).toContainText('Lesson alpha');
  await expect(page.locator('[data-lp-action="toggle-lesson"]').first()).toHaveAttribute('aria-expanded', 'false');
  await page.locator('[data-lp-action="toggle-lesson"]').first().click();
  await expect(page.locator('.learning-plan-step').first()).toContainText('Finish alpha step');
  await expect(page.locator('.learning-plan-step input[type="checkbox"]')).toBeChecked();
  await expect(page.locator('.learning-plan-progress')).toContainText('1 / 1 steps');
});
