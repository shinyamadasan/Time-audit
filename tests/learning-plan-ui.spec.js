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
  createLearningPlan
} from '../learning-plan-model.js';
import {
  LEARNING_PLAN_REPOSITORY_KEY,
  LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION
} from '../learning-plan-repository.js';

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

function envelope(plans) {
  return JSON.stringify({
    schemaVersion: LEARNING_PLAN_REPOSITORY_SCHEMA_VERSION,
    plans
  });
}

async function openApp(page, { learningPlanRaw = null, dailyPlans = {} } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: firebaseStub
  }));
  await page.addInitScript(({ learningPlanRaw, dailyPlans, settings }) => {
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
    localStorage.setItem('ta3-learning-ui-test-seeded', '1');
  }, { learningPlanRaw, dailyPlans, settings: baseSettings() });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function openLearningPlans(page) {
  await page.locator('#nav-learning').click();
  await expect(page.locator('#view-learning')).toHaveClass(/active/);
}

async function createPlanThroughUi(page, title = 'JavaScript fundamentals') {
  await page.locator('#learning-plan-title-input').fill(title);
  await page.getByRole('button', { name: 'Create plan' }).click();
  await expect(page.locator('.learning-plan-list-item')).toContainText(title);
}

async function fillImportForm(page, {
  title = 'JavaScript fundamentals',
  outline = '# Fundamentals\n## Variables\n- Read lesson\n- Complete exercises'
} = {}) {
  await page.locator('#learning-plan-import-title-input').fill(title);
  await page.locator('#learning-plan-import-outline').fill(outline);
}

async function previewImport(page) {
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('region', { name: 'Learning Plan import preview' })).toBeVisible();
}

async function importPlan(page) {
  await page.getByRole('button', { name: 'Import plan' }).click();
}

async function addPhaseThroughUi(page, title = 'Phase 1') {
  await page.locator('form[data-lp-action="add-phase"] input[name="title"]').fill(title);
  await page.locator('form[data-lp-action="add-phase"]').getByRole('button', { name: 'Add phase' }).click();
  await expect(page.locator('[data-lp-action="rename-phase"]').first()).toHaveValue(title);
}

async function addLessonThroughUi(page, title = 'Lesson 1') {
  await page.locator('form[data-lp-action="add-lesson"] input[name="title"]').fill(title);
  await page.locator('form[data-lp-action="add-lesson"]').getByRole('button', { name: 'Add lesson' }).click();
  await expect(page.locator('[data-lp-action="rename-lesson"]').first()).toHaveValue(title);
}

async function addStepThroughUi(page, title = 'Read docs') {
  await page.locator('form[data-lp-action="add-step"] input[name="title"]').fill(title);
  await page.locator('form[data-lp-action="add-step"]').getByRole('button', { name: 'Add step' }).click();
  await expect(page.locator('[data-lp-action="rename-step"]').first()).toHaveValue(title);
}

async function storedEnvelope(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), LEARNING_PLAN_REPOSITORY_KEY);
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

test('Learning Plans opens an empty repository without error', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);

  await expect(page.locator('#learning-plan-error')).toBeHidden();
  await expect(page.locator('#learning-plan-list')).toContainText('No Learning Plans yet.');
  await expect(page.locator('#learning-plan-main')).toContainText('Create a Learning Plan');
});

test('Quick Import is the primary path while manual creation remains available', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);

  const sections = await page.locator('#view-learning section.settings-section').evaluateAll(items => items.map(item => item.className));
  expect(sections[0]).toContain('learning-plan-import');
  expect(sections[1]).toContain('learning-plan-create');
  await expect(page.locator('#learning-plan-import-title')).toHaveText('Import / Paste Plan');
  await expect(page.getByLabel('Plan title').first()).toHaveAttribute('id', 'learning-plan-import-title-input');
  await expect(page.getByRole('button', { name: 'Preview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import plan' })).toBeDisabled();
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
  await expect(page.getByRole('button', { name: 'Import plan' })).toBeEnabled();
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

  await page.reload();
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await openLearningPlans(page);

  await expect(page.locator('.learning-plan-list-item')).toContainText('JavaScript Fundamentals');
  await expect(page.locator('[data-lp-action="rename-phase"]').first()).toHaveValue('Fundamentals');
  await expect(page.locator('[data-lp-action="rename-lesson"]').first()).toHaveValue('Variables');
  await expect(page.locator('[data-lp-action="rename-step"]').first()).toHaveValue('Read lesson');
});

test('rapid double Import creates at most one Learning Plan', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await fillImportForm(page);
  await previewImport(page);

  await page.getByRole('button', { name: 'Import plan' }).dblclick();

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

  await page.getByRole('button', { name: 'Preview' }).click();

  await expect(page.locator('#learning-plan-error')).toContainText('Line 2');
  await expect(page.locator('#learning-plan-error')).toContainText('Step must come after a lesson');
  await expect(page.locator('#learning-plan-import-preview')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Import plan' })).toBeDisabled();
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
  await expect(page.getByRole('button', { name: 'Import plan' })).toBeDisabled();

  await previewImport(page);
  await page.locator('#learning-plan-import-title-input').fill('Changed title');
  await expect(page.locator('#learning-plan-import-preview')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Import plan' })).toBeDisabled();
});

test('Import remains unavailable until the current input has a valid preview', async ({ page }) => {
  await openApp(page);
  await openLearningPlans(page);
  await fillImportForm(page);

  await expect(page.getByRole('button', { name: 'Import plan' })).toBeDisabled();
  await previewImport(page);
  await expect(page.getByRole('button', { name: 'Import plan' })).toBeEnabled();
  await page.locator('#learning-plan-import-outline').fill('## Lesson before phase');
  await expect(page.getByRole('button', { name: 'Import plan' })).toBeDisabled();
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
  await expect(page.locator('[data-lp-action="rename-phase"]').first()).toHaveValue('<svg onload=alert(1)>');
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

  await expect(page.locator('[data-lp-action="rename-phase"]').first()).toHaveValue('Phase 1');
  await expect(page.locator('[data-lp-action="rename-lesson"]').first()).toHaveValue('Lesson 1');
  await expect(page.locator('[data-lp-action="rename-step"]').first()).toHaveValue('Read docs');
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

test('plan and step IDs survive UI rename, complete, and reopen', async ({ page }) => {
  await openApp(page, { learningPlanRaw: envelope([seededLearningPlan()]) });
  await openLearningPlans(page);
  const before = await storedEnvelope(page);
  const beforeIds = entityIds(before.plans[0]);

  await page.locator('[data-lp-action="rename-plan"]').fill('Frontend mastery');
  await page.locator('[data-lp-action="rename-plan"]').blur();
  await page.locator('[data-lp-action="rename-phase"]').fill('Basics');
  await page.locator('[data-lp-action="rename-phase"]').blur();
  await page.locator('[data-lp-action="rename-lesson"]').fill('Syntax');
  await page.locator('[data-lp-action="rename-lesson"]').blur();
  await page.locator('[data-lp-action="rename-step"]').first().fill('Read docs');
  await page.locator('[data-lp-action="rename-step"]').first().blur();
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

  await expect(page.locator('[data-lp-action="rename-plan"]')).toHaveValue('Frontend fundamentals');
  await page.locator('.learning-plan-list-item').filter({ hasText: 'Backend fundamentals' }).click();

  await expect(page.locator('[data-lp-action="rename-plan"]')).toHaveValue('Backend fundamentals');
  await expect(page.locator('[data-lp-action="rename-phase"]')).toHaveCount(0);
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

  await page.locator('#learning-plan-title-input').fill('Blocked plan');
  await page.getByRole('button', { name: 'Create plan' }).click();
  await expect(page.locator('#learning-plan-error')).toContainText('Could not create Learning Plan');
  await expect(page.locator('.learning-plan-list-item')).toHaveCount(0);

  await page.reload();
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function');
  await openLearningPlans(page);
  await page.locator('#learning-plan-title-input').fill('Single plan');
  await page.getByRole('button', { name: 'Create plan' }).dblclick();

  const stored = await storedEnvelope(page);
  expect(stored.plans).toHaveLength(1);
  expect(stored.plans[0].title).toBe('Single plan');
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

  await expect(page.locator('[data-lp-action="rename-plan"]')).toHaveValue(longTitle);
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
  await expect(page.locator('[data-lp-action="rename-phase"]').first()).toHaveValue('Phase alpha');
  await expect(page.locator('[data-lp-action="rename-lesson"]').first()).toHaveValue('Lesson alpha');
  await expect(page.locator('[data-lp-action="rename-step"]').first()).toHaveValue('Finish alpha step');
  await expect(page.locator('.learning-plan-step input[type="checkbox"]')).toBeChecked();
  await expect(page.locator('.learning-plan-progress')).toContainText('1 / 1 steps');
});
