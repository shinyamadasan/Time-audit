import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addLesson, addPhase, addStep, createLearningPlan } from '../learning-plan-model.js';

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

async function openApp(page, { learningPlanRaw = null, dailyPlans = {}, lifeLedgerRaw = null } = {}) {
  await page.route('https://**/*', route => route.abort());
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


async function addRoutine(page, { title='Spanish', source='manual', mode='anytime' }={}) {
  await page.getByRole('button',{name:'Add routine',exact:true}).click();
  const form=page.locator('#daily-routine-form');
  await form.locator('[name=title]').fill(title);
  await form.locator('[name=mode]').selectOption(mode);
  await form.locator('[name=source]').selectOption(source);
  if(source==='learning') await form.locator('[name=planId]').selectOption('plan-a');
  if(mode==='exact') await form.locator('[name=time]').fill('20:00');
  await form.locator('[name=minimumMinutes]').fill('5');
  await form.getByRole('button',{name:'Save routine',exact:true}).click();
  await expect(page.locator('#daily-routine-dialog')).not.toBeVisible();
}
const card = page => page.locator('.daily-routine-card');

test('empty state creates no routines; manual minimum, reload, correction and one next-day instance',async({page})=>{
  await openApp(page);
  await expect(page.locator('#daily-routines')).toContainText('0 / 0');
  expect(await page.evaluate(()=>localStorage.getItem('ta3-daily-routines-v1'))).toBeNull();
  await addRoutine(page);
  const id=await card(page).getAttribute('data-instance-id');
  await card(page).getByRole('button',{name:'Minimum done',exact:true}).click();
  await expect(card(page)).toContainText('Minimum complete');
  await page.reload();
  await expect(card(page)).toContainText('Minimum complete');
  expect(await card(page).getAttribute('data-instance-id')).toBe(id);
  expect(await page.evaluate(()=>localStorage.getItem('ta3-life-ledger-v1'))).toBeNull();
  await card(page).getByRole('button',{name:'Undo manual Done',exact:true}).click();
  await expect(page.locator('#daily-routines')).toContainText('0 / 1');
  await card(page).getByRole('button',{name:'Done',exact:true}).click();
  await expect(page.locator('#daily-routines')).toContainText('1 / 1');
});
test('midday edit preserves identity; disabling preserves manual history and re-enabling restores it',async({page})=>{
  await openApp(page); await addRoutine(page,{mode:'exact'});
  const id=await card(page).getAttribute('data-instance-id');
  await card(page).getByRole('button',{name:'Done',exact:true}).click();
  await card(page).getByRole('button',{name:'Edit',exact:true}).click();
  await page.locator('[name=time]').fill('21:00');
  await page.getByRole('button',{name:'Save routine',exact:true}).click();
  expect(await card(page).getAttribute('data-instance-id')).toBe(id);
  await expect(card(page)).toContainText('21:00');
  await card(page).getByRole('button',{name:'Edit',exact:true}).click();
  await page.locator('[name=enabled]').uncheck();
  await page.getByRole('button',{name:'Save routine',exact:true}).click();
  await expect(card(page)).toHaveCount(0);
  await page.locator('#daily-routines summary').click();
  await page.locator('#daily-routines').getByRole('button',{name:'Edit',exact:true}).click();
  await page.locator('[name=enabled]').check();
  await page.getByRole('button',{name:'Save routine',exact:true}).click();
  await expect(card(page)).toContainText('Complete');
});
test('Focus start and abandoned partial session do not complete; full session and reload do',async({page})=>{
  await openApp(page); await addRoutine(page,{title:'Deep Work',source:'focus'});
  await card(page).getByRole('button',{name:'Start Focus',exact:true}).click();
  expect(await page.evaluate(()=>pomodoroWorkMin)).toBe(15);
  await expect(card(page)).not.toContainText('Target complete');
  await page.evaluate(()=>{focusStartTime=Date.now()-6*60000;confirmExitFocus();});
  await expect(page.locator('#daily-routines')).toContainText('0 / 1');
  await card(page).getByRole('button',{name:'Start Focus',exact:true}).click();
  const finishAt=await page.evaluate(()=>focusStartTime+15*60000);
  await page.clock.setFixedTime(new Date(finishAt));
  await page.evaluate(()=>{endWorkSession();confirmExitFocus();});
  await expect(card(page)).toContainText('Target complete');
  await page.reload();
  await expect(card(page)).toContainText('Target complete');
});
test('Learning uses real next step; existing completion flows mark today done without a second scheduler action',async({page})=>{
  await openApp(page,{learningPlanRaw:JSON.stringify({schemaVersion:1,plans:[seededLearningPlan()]})});
  await addRoutine(page,{title:'Learning',source:'learning'});
  await expect(card(page)).toContainText('Step A');
  await card(page).getByRole('button',{name:'Start Focus',exact:true}).click();
  await page.evaluate(()=>{focusStartTime=Date.now()-15*60000;endWorkSession();});
  await page.getByRole('region',{name:'Focus outcome'}).getByRole('button',{name:'Done',exact:true}).click();
  await page.evaluate(()=>showView('today'));
  await expect(card(page)).toContainText('Target complete');
  await expect(card(page)).toContainText('Step A');
  await page.reload();
  await expect(card(page)).toHaveCount(1);
  await expect(card(page)).toContainText('Target complete');
});
test('phone and compact landscape remain usable; form fits and inputs avoid zoom',async({page})=>{
  await openApp(page); await addRoutine(page);
  for(const viewport of [{width:390,height:844},{width:844,height:390}]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await expect(card(page).getByRole('button',{name:'Done',exact:true})).toBeVisible();
    await card(page).getByRole('button',{name:'Edit',exact:true}).click();
    expect(await page.locator('[name=title]').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    await page.locator('#daily-routine-cancel').click();
  }
  await page.screenshot({path:'test-results/daily-routines-landscape.png',fullPage:true});
});
test('storage failure is visible and never reports Done',async({page})=>{
  await openApp(page); await addRoutine(page);
  await page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='ta3-daily-routines-v1')throw new Error('Quota exceeded');return set.call(this,k,v);};});
  await card(page).getByRole('button',{name:'Done',exact:true}).click();
  await expect(page.locator('#daily-routines-error')).toContainText('Quota exceeded');
  await expect(page.locator('#daily-routines')).toContainText('0 / 1');
});

test('23:59 to 00:01 reload creates one new intention, never yesterday’s overdue copy',async({page})=>{
  await page.clock.setFixedTime(new Date('2026-09-08T23:59:00Z'));
  await openApp(page); await addRoutine(page);
  const yesterday=await card(page).getAttribute('data-instance-id');
  await page.clock.setFixedTime(new Date('2026-09-09T00:01:00Z'));
  await page.reload();
  await expect(card(page)).toHaveCount(1);
  expect(await card(page).getAttribute('data-instance-id')).not.toBe(yesterday);
  await expect(page.locator('#daily-routines')).toContainText('2026-09-09');
  await page.reload();
  await expect(card(page)).toHaveCount(1);
});
test('real Workout fact completes automatically, duplicate stays one completion',async({page})=>{
  await page.clock.setFixedTime(new Date('2026-09-08T19:00:00Z'));
  await openApp(page); await addRoutine(page,{title:'Workout',source:'workout'});
  await expect(card(page)).toContainText('No live openGym connection');
  await page.evaluate(async()=>{
    const {normalizeWorkoutCompleted}=await import('./workout-life-ledger-adapter.js');
    const {createLocalLifeLedgerStore}=await import('./life-ledger-runtime.js');
    const result=normalizeWorkoutCompleted({id:'test-workout',d:'2026-09-08',start:Date.parse('2026-09-08T17:30:00Z'),end:Date.parse('2026-09-08T18:12:00Z'),name:'Workout',entries:[]},{observedAt:'2026-09-08T19:00:00Z',assertedTimezone:'Etc/UTC'});
    if(!result.ok)throw new Error(JSON.stringify(result));
    const store=createLocalLifeLedgerStore();store.upsertEvent(result.draft);store.upsertEvent(result.draft);
    renderDailyRoutines();
  });
  await expect(card(page)).toContainText('Target complete');
  await expect(page.locator('#daily-routines')).toContainText('1 / 1');
  await page.reload();await expect(card(page)).toHaveCount(1);await expect(card(page)).toContainText('Target complete');
});
test('Learning already completed before Today opens binds today’s factual step',async({page})=>{
  await openApp(page,{learningPlanRaw:JSON.stringify({schemaVersion:1,plans:[seededLearningPlan()]})});
  await page.evaluate(async()=>{
    const {createLearningPlanRepository}=await import('./learning-plan-repository.js');
    const {completeStep}=await import('./learning-plan-model.js');
    const {recordLearningPlanStepCompleted}=await import('./life-ledger-runtime.js');
    const repo=createLearningPlanRepository();
    const plan=completeStep(repo.listPlans()[0],'step-a');
    repo.savePlan(plan);
    recordLearningPlanStepCompleted(plan,'step-a',{sourceTimezone:'Etc/UTC'});
  });
  await addRoutine(page,{title:'Learning',source:'learning'});
  await expect(card(page)).toContainText('Step A');
  await expect(page.locator('#daily-routines')).toContainText('1 / 1');
});

test('scheduled Focus linkage survives reload and existing same-device timer takeover',async({page})=>{
  await openApp(page);await addRoutine(page,{title:'Deep Work',source:'focus'});
  await card(page).getByRole('button',{name:'Start Focus',exact:true}).click();
  const startedAt=await page.evaluate(()=>focusStartTime);
  await page.reload();
  await page.evaluate(startedAt=>{
    // Synthetic restored timer uses the existing takeover mechanism, without Firebase.
    syncedFocusTimer={running:true,focusPhase:'work',intervalSecs:900,startedAt,task:'Deep Work',ownerDeviceId:syncedDeviceId};
    document.getElementById('focus-overlay').classList.add('open');
    takeOverSyncedFocusTimer();
  },startedAt);
  await page.clock.setFixedTime(new Date(startedAt+15*60000));
  await page.evaluate(()=>{endWorkSession();confirmExitFocus();});
  await expect(card(page)).toContainText('Target complete');
});

test('active scheduled Focus has a compact scrollable landscape surface',async({page})=>{
  await openApp(page);await addRoutine(page,{title:'Deep Work',source:'focus'});
  await page.setViewportSize({width:844,height:390});
  await card(page).getByRole('button',{name:'Start Focus',exact:true}).click();
  expect(await page.locator('#focus-countdown').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBe(58);
  expect(await page.locator('#focus-overlay').evaluate(el=>getComputedStyle(el).overflowY)).toBe('auto');
  await expect(page.locator('#focus-overlay')).toHaveCSS('opacity','1');
  await expect(page.locator('#focus-countdown')).toHaveText('15:00');
  await page.screenshot({path:'test-results/daily-routines-active-focus-landscape.png'});
});

test('failed launch persistence reports the actual error and does not start the timer',async({page})=>{
  await openApp(page);await addRoutine(page,{title:'Deep Work',source:'focus'});
  await page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='ta3-daily-routines-v1')throw new Error('Quota exceeded');return set.call(this,k,v);};});
  await card(page).getByRole('button',{name:'Start Focus',exact:true}).click();
  expect(await page.evaluate(()=>pomodoroPhase)).toBe('idle');
  await expect(page.locator('#daily-routines-error')).toContainText('Quota exceeded');
});
