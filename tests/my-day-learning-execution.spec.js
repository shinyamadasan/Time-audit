import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addLesson, addPhase, addStep, createLearningPlan } from '../learning-plan-model.js';

// My Day learning + execution task candidate. Harness copied from daily-routines-ui.spec.js (account uid_learning-user).

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

async function openApp(page, { learningPlanRaw = null } = {}) {
  await page.route('https://**/*', route => route.abort());
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ learningPlanRaw, settings }) => {
    if (localStorage.getItem('ta3-my-day-candidate-seeded')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz:uid_learning-user', 'UTC');
    localStorage.setItem('ta3-settings:uid_learning-user', JSON.stringify(settings));
    localStorage.setItem('ta3-entries:uid_learning-user', '[]');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-plans:uid_learning-user', '{}');
    localStorage.setItem('ta3-reviews:uid_learning-user', '{}');
    if (learningPlanRaw !== null) localStorage.setItem('ta3-learning-plans-v1:uid_learning-user', learningPlanRaw);
    localStorage.setItem('ta3-my-day-candidate-seeded', '1');
  }, { learningPlanRaw, settings: baseSettings() });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.renderLearningPlans === 'function' && !!globalThis.SopUI && !!globalThis.PlanAuthority?.current());
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

/** Adds untimed (Anytime) tasks to the current My Day through the app's own plan API. */
async function addTasks(page, titles) {
  return page.evaluate(list => {
    const target = PlanAuthority.current();
    const ids = list.map(title => { const item = createPlanItem(title, ''); PlanAuthority.addItem({ destination: target, item }); return item.id; });
    refreshAuthoritativePlanSurfaces();
    return ids;
  }, titles);
}
const anytimeRow = (page, id) => page.locator(`#timeline-anytime .anytime-row[data-plan-item-id="${id}"]`);
const planStore = page => page.evaluate(() => JSON.stringify(PlanAuthority.items(PlanAuthority.current())));
const panel = page => page.locator('#sop-execution');

async function createSop(page, title, steps) {
  await panel(page).locator('summary', { hasText: 'Procedures (SOPs)' }).click();
  await panel(page).locator('.sop-new summary').click();
  await panel(page).locator('.sop-create-form [name="sop-title"]').fill(title);
  await panel(page).locator('.sop-create-form [name=steps]').fill(steps.join('\n'));
  await panel(page).getByRole('button', { name: 'Save SOP', exact: true }).click();
}

test('regular tasks are unaffected: no SOP line, no extra control, and the SOP panel starts closed', async ({ page }) => {
  await openApp(page);
  const [id] = await addTasks(page, ['Laundry']);
  await expect(anytimeRow(page, id)).toBeVisible();
  await expect(anytimeRow(page, id).locator('.sop-badge')).toHaveCount(0);
  await expect(anytimeRow(page, id).locator('[data-sop-open]')).toHaveCount(0);
  await expect(panel(page).locator('details.sop-panel')).not.toHaveAttribute('open', '');
  expect(await page.evaluate(() => localStorage.getItem('ta3-sops-v1:uid_learning-user'))).toBeNull();
});

test('an execution task opens its SOP, walks the steps, and never completes or edits the plan item', async ({ page }) => {
  await openApp(page);
  const [execId, regularId] = await addTasks(page, ['Weekly review', 'Laundry']);
  await createSop(page, 'Weekly review SOP', ['Clear inbox', 'Review calendar']);
  const before = await planStore(page);

  await panel(page).locator('.sop-link-form [name=itemId]').selectOption(execId);
  await panel(page).getByRole('button', { name: 'Link SOP', exact: true }).click();
  const row = anytimeRow(page, execId);
  await expect(row.locator('.sop-badge')).toContainText('SOP 0/2 · Next: Clear inbox');
  await expect(anytimeRow(page, regularId).locator('.sop-badge')).toHaveCount(0);

  const run = panel(page).locator('.sop-run');
  await expect(run).toContainText('Weekly review SOP');
  await run.getByLabel('Clear inbox').click();
  await expect(row.locator('.sop-badge')).toContainText('SOP 1/2 · Next: Review calendar');
  await run.getByLabel('Review calendar').click();
  await expect(row.locator('.sop-badge')).toContainText('SOP 2/2 · All steps done');
  await expect(run).toContainText('Mark the task done with its own checkbox');

  // Plan storage is byte-identical: linking and ticking SOP steps never write the plan item.
  expect(await planStore(page)).toBe(before);
  expect(await page.evaluate(id => PlanAuthority.items(PlanAuthority.current()).find(i => i.id === id).done, execId)).toBe(false);

  // Completion stays the plan item's own existing done/doneAt toggle.
  const dayId = await page.evaluate(() => PlanAuthority.current().id);
  await page.evaluate(([day, id]) => toggleTimelinePlanDone(day, id), [dayId, execId]);
  const done = await page.evaluate(id => PlanAuthority.items(PlanAuthority.current()).find(i => i.id === id), execId);
  expect(done.done).toBe(true);
  expect(Number.isFinite(done.doneAt)).toBe(true);

  // Survives reload (device-local, this account only).
  await page.reload();
  await page.waitForFunction(() => !!globalThis.SopUI && !!globalThis.PlanAuthority?.current());
  await expect(anytimeRow(page, execId).locator('.sop-badge')).toContainText('SOP 2/2 · All steps done');
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('ta3-sops-v1:uid_learning-user')).links).length)).toBe(1);
});

test("Open SOP from the task row opens that task's run; unlink returns it to a regular task", async ({ page }) => {
  await openApp(page);
  const [execId] = await addTasks(page, ['Deploy checklist']);
  await createSop(page, 'Deploy', ['Tag release', 'Notify team']);
  await panel(page).locator('.sop-link-form [name=itemId]').selectOption(execId);
  await panel(page).getByRole('button', { name: 'Link SOP', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel(page).locator('.sop-run')).toHaveCount(0);

  const row = anytimeRow(page, execId);
  await row.locator('summary').first().click(); // the My Day agenda card opens; the SOP line is in its body
  await row.getByRole('button', { name: 'Open SOP', exact: true }).click();
  await expect(panel(page).locator('.sop-run')).toContainText('Deploy');
  await panel(page).getByRole('button', { name: 'Unlink SOP', exact: true }).click();
  await expect(row.locator('.sop-badge')).toHaveCount(0);
});

test("a learning task shows its Learning Plan and today's step (existing Daily Routine linkage, no new association)", async ({ page }) => {
  await openApp(page, { learningPlanRaw: JSON.stringify({ schemaVersion: 1, plans: [seededLearningPlan()] }) });
  const before = await page.evaluate(() => localStorage.getItem('ta3-learning-plans-v1:uid_learning-user'));
  await page.evaluate(() => openRoutineDayDialog());
  await page.getByRole('button', { name: 'Manage routines', exact: true }).click();
  await page.getByRole('button', { name: 'Add routine', exact: true }).click();
  const form = page.locator('#daily-routine-form');
  await form.locator('[name=title]').fill('Learning');
  await form.locator('[name=mode]').selectOption('anytime');
  await form.locator('[name=source]').selectOption('learning');
  await form.locator('[name=planId]').selectOption('plan-a');
  await form.locator('[name=minimumMinutes]').fill('5');
  await form.getByRole('button', { name: 'Save routine', exact: true }).click();
  await page.evaluate(() => { openRoutineDayDialog(); document.getElementById('routine-details').open = true; });
  const card = page.locator('.daily-routine-card');
  await expect(card.locator('.routine-learning')).toHaveText("Frontend fundamentals · Today's step: Step A");
  // Read-only: showing the plan never writes the Learning Plan store.
  expect(await page.evaluate(() => localStorage.getItem('ta3-learning-plans-v1:uid_learning-user'))).toBe(before);
});
