import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addLesson, addPhase, addStep, completeStep, createLearningPlan } from '../learning-plan-model.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';
const NOW = Date.parse('2026-09-08T18:00:00Z');
const TARGET = '2026-09-09';
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const listeners = new Map();
  window.__firebasePlanWriteCount = 0;
  window.__emitFirebaseValue = (refPath, value) => (listeners.get(refPath) || []).forEach(cb => cb(snapshot(value)));
  const makeRef = refPath => {
    const countPlanWrite = () => { if (refPath.includes('/plans')) window.__firebasePlanWriteCount++; };
    return ({
    path: refPath, child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) { if (eventName === 'value') { const rows = listeners.get(refPath) || []; rows.push(cb); listeners.set(refPath, rows); setTimeout(() => cb(snapshot(null)), 0); } return cb; },
    off() {}, once() { return Promise.resolve(snapshot(null)); }, update() { countPlanWrite(); return Promise.resolve(); },
    set() { countPlanWrite(); return Promise.resolve(); }, remove() { countPlanWrite(); return Promise.resolve(); },
    transaction(updateFn) { countPlanWrite(); const value = updateFn(null); return Promise.resolve({ committed: true, snapshot: snapshot(value) }); },
    push(value) { const pushed = makeRef(refPath + '/pushed'); pushed.key = 'pushed'; if (value !== undefined) pushed.set(value); return pushed; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
    });
  };
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'plan-user', displayName: 'Plan User', email: 'plan@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(config) { const app = { config }; this.apps.push(app); return app; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
})();`;

const routine = (overrides = {}) => ({ id: 'routine-1', createdDate: '2026-09-01', title: 'Deep work', enabled: true, cadence: 'daily', days: [], mode: 'exact', time: '09:00', endTime: '', cue: '', targetMinutes: 30, minimumMinutes: 10, fallback: 'Do 5 minutes', source: 'manual', planId: '', workoutRoutineId: '', ...overrides });
const routineState = (routines = [], timezone = 'Etc/UTC', extra = {}) => ({ schemaVersion: 1, timezone, routines, manual: {}, links: {}, focus: {}, skips: {}, ...extra });
const planItem = (id, task, extra = {}) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: NOW, ...extra });

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

async function openApp(page, { timezone = 'Etc/UTC', routines = [], plans = {}, learningPlans = null, failPlanWrite = false, deviceId = 'device-test', firebaseScript = firebaseStub } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseScript }));
  await page.addInitScript(({ timezone, routines, plans, learningPlans, now, failPlanWrite, deviceId }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', timezone);
    localStorage.setItem('ta3-device-id', deviceId);
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', '[]'); localStorage.setItem('ta3-focus-redemptions', '[]'); localStorage.setItem('ta3-reviews', '{}'); localStorage.setItem('ta3-plans', JSON.stringify(plans));
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify(routines));
    if (learningPlans) localStorage.setItem('ta3-learning-plans-v1', JSON.stringify(learningPlans));
    if (failPlanWrite) {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === 'ta3-plans') throw new Error('Plan quota exceeded'); return set.call(this, key, value); };
    }
  }, { timezone, routines, plans, learningPlans, now: NOW, failPlanWrite, deviceId });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof openPlanTomorrow === 'function' && typeof getPlanTomorrowAppContext === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
  await page.evaluate(() => openPlanTomorrow());
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
}


async function today(page, options = {}) {
  await openApp(page, { routines: routineState([]), ...options });
  await page.locator('[data-pt-action="close"]').first().click();
  await page.evaluate(() => { renderTodayPlan(); renderDailyRoutines(); });
}

test('compact Now and Anytime routines execute without rendered cards', async ({ page }) => {
  for (const mode of ['exact', 'anytime']) {
    await today(page, { routines: routineState([routine({ mode, time: '00:00' })]) });
    await expect(page.locator('#routine-details')).not.toHaveAttribute('open');
    await page.evaluate(() => document.getElementById('daily-routines-list').replaceChildren());
    await page.locator('#today-action-primary').click();
    expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('ta3-daily-routines-v1')).manual).length)).toBe(1);
    expect(await page.evaluate(() => entries.length)).toBe(0);
  }
});

test('Workout awaits source evidence; compact list stays bounded', async ({ page }) => {
  await today(page, { routines: routineState(Array.from({length: 12}, (_, i) => routine({id: `r${i}`, title: `Workout ${i}`, source: 'workout', mode: 'anytime', workoutRoutineId: `w${i}`}))) });
  await expect(page.locator('#routine-compact .commitment-routine')).toHaveCount(2);
  await expect(page.locator('#hero-task-input')).toBeVisible();
  await page.locator('#routine-details > summary').click();
  await expect(page.locator('#daily-routines-list [data-routine-action="done"]')).toHaveCount(0);
  await expect(page.locator('#daily-routines-list')).toContainText('matching workout is imported');
});

test('one known Start and intentional free-form work with three long priorities', async ({ page }) => {
  await today(page);
  await page.evaluate(() => { savePlanItems(planTodayKey(), Array.from({length: 3}, (_, i) => createPlanItem(`Priority ${i} ${'long title '.repeat(6)}`, ''))); renderTodayPlan(); });
  await expect(page.locator('#hero-task-input')).toBeHidden();
  await expect(page.locator('#plan-task')).toBeHidden();
  await expect(page.locator('#up-next button:visible').filter({hasText: /^Start$/})).toHaveCount(1);
  await page.locator('#choose-work').click();
  await page.locator('#hero-task-input').fill('Free-form work');
  await page.locator('#hero-idle').getByRole('button', {name:'Start',exact:true}).click();
  expect(await page.evaluate(() => currentTask)).toBe('Free-form work');
  expect(await page.evaluate(() => getPlanItems(planTodayKey()).every(p => !p.done))).toBe(true);
});

test('Needs You never nags for a generic gap; configured sleep and empty state still work (Phase 6J)', async ({ page }) => {
  await today(page);
  await page.evaluate(() => { settings.sleepSetupDone = false; entries = [{id:93,activity:'Earlier work',energy:'deep',date:planTodayKey(),tsStart:Date.now()-7200000,ts:Date.now()-3600000,blockIntervalMin:60}]; reviews[planTodayKey()] = {unloggedOk:true}; checkSleepReminder(); renderToday(); });
  await expect(page.locator('#needs-you')).toBeHidden();
  expect(await page.evaluate(() => getCloseoutGaps(planTodayKey()).length)).toBeGreaterThan(0);
  await page.evaluate(() => { delete reviews[planTodayKey()]; renderToday(); });
  // A generic gap alone, with no review acknowledgment, no longer opens a Needs You
  // interruption (§14) — the raw gap is still a diagnostic fact (getCloseoutGaps).
  await expect(page.locator('#needs-you')).toBeHidden();
  await expect(page.locator('#gap-recovery')).toBeHidden();
  expect(await page.evaluate(() => getCloseoutGaps(planTodayKey()).length)).toBeGreaterThan(0);
  await page.evaluate(() => { settings.sleepSetupDone = true; checkSleepReminder(); });
  await expect(page.locator('#needs-you-count')).toHaveText('1 thing');
  await expect(page.locator('#needs-you-more')).toBeHidden();
  await expect(page.locator('#today-sleep-reminder')).toBeVisible();
  await page.evaluate(() => { localStorage.setItem('ta3-sleep-snooze', String(Date.now()+3600000)); checkSleepReminder(); });
  await expect(page.locator('#needs-you')).toBeHidden();
  expect(await page.evaluate(() => entries.map(e=>e.id))).toEqual([93]);
});

for (const state of ['tracker','break','away','focus','remote']) {
  test(`execution ${state} dominates with no generic Start`, async ({ page }) => {
    await today(page);
    await page.evaluate(state => {
      if (state === 'focus') enterFocusMode({task:'Active focus',autoStart:true});
      else if (state === 'away') startAway('Eat');
      else if (state === 'remote') { running=true; currentTask='Remote work'; timerOwnerDeviceId='other-device'; timerOwnerName='Other device'; }
      else { document.getElementById('hero-task-input').value='Active work'; startFromHero(); if (state==='break') { breakActive=true; document.getElementById('break-active-row').style.display='flex'; } }
      renderToday();
    }, state);
    await expect(page.locator('#up-next')).toHaveAttribute('data-state', state);
    expect(await page.locator('#hero-idle').isVisible()).toBe(false);
    if (state === 'focus') { await expect(page.locator('#focus-overlay')).toBeVisible(); expect(await page.evaluate(() => pomodoroPhase)).toBe('work'); }
  });
}

for (const energy of ['deep','waste','none']) {
  test(`So Far ${energy} uses facts without interpretation`, async ({ page }) => {
    await today(page);
    await page.evaluate(energy => { entries = energy === 'none' ? [] : [{id:91,activity:'Work',energy,date:planTodayKey(),tsStart:Date.now()-4800000,ts:Date.now(),blockIntervalMin:80}]; renderToday(); }, energy);
    await expect(page.locator('#so-far-summary')).toHaveText(energy === 'none' ? 'No time recorded yet.' : energy === 'deep' ? '1h 20m deep · 0m waste' : '0m deep · 1h 20m waste');
    for (const id of ['today-health','daily-summary','awareness-signal','timeline-section','recent-entries-section']) await expect(page.locator(`#${id}`)).toBeHidden();
  });
}

test('intentional Log time and Timeline retain shortcuts and corrections', async ({page}) => {
  await today(page);
  await page.evaluate(() => { entries=[{id:92,activity:'Previous work',energy:'deep',date:planTodayKey(),tsStart:Date.now()-3600000,ts:Date.now(),blockIntervalMin:60}]; renderToday(); });
  await page.getByRole('navigation', {name:'Today actions'}).getByRole('button',{name:'Log time',exact:true}).click();
  for (const name of ['Sleep','Eat','Cooking','Dishes','Hygiene','Walk','Commute','Exercise']) await expect(page.locator('#daily-basics')).toContainText(name);
  await expect(page.locator('#same-as-last-btn')).toBeVisible();
  await page.getByRole('navigation', {name:'Today actions'}).getByRole('button',{name:'Timeline',exact:true}).click();
  await expect(page.locator('#timeline-blocks')).toBeVisible();
  await page.locator('#timeline-content > details > summary').click();
  await expect(page.locator('#recent-list')).toBeVisible();
  await page.locator('#recent-list button').filter({hasText:'✎'}).first().click();
  await expect(page.locator('#retro-overlay')).toBeVisible();
});

test('rendered before/after phone and desktop hierarchy', async ({ page }) => {
  const { execFileSync } = await import('node:child_process');
  await fs.mkdir(path.join(APP_ROOT,'test-results','phase6d'), {recursive:true});
  for (const width of [390,1280]) {
    await page.setViewportSize({width,height:900});
    const measurements={};
    for (const version of ['before','after']) {
      if (version==='before') for (const file of ['index.html','style.css','daily-routines-ui.js']) {
        const body=execFileSync('git',['show',`HEAD:${file}`],{cwd:APP_ROOT,encoding:'utf8'});
        await page.route(`**/${file}*`,route=>route.fulfill({status:200,contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/javascript',body}));
      }
      else await page.unrouteAll({behavior:'wait'});
      await today(page, {routines:routineState([routine({mode:'anytime'})]),plans:{'2026-09-08':{items:[planItem('p1','Finish HVAC workflow'),planItem('p2','Send handoff')]}}});
      await page.evaluate(() => { reviews[planTodayKey()]={unloggedOk:true}; localStorage.setItem('ta3-sleep-reminded',planTodayKey()); checkSleepReminder(); renderToday(); });
      measurements[version]=await page.locator('#view-today').evaluate(el=>Math.round(el.getBoundingClientRect().height));
      await page.screenshot({path:path.join(APP_ROOT,'test-results','phase6d',`${version}-${width}.png`),fullPage:true,animations:'disabled'});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(version==='after') {
        await expect(page.locator('#needs-you')).toBeHidden();
        await expect(page.locator('#today-action-primary')).toBeVisible();
        await expect(page.locator('#up-next')).not.toContainText('Advisor');
      }
    }
    console.log(`LAYOUT ${width}: ${JSON.stringify(measurements)}`);
    expect(measurements.after).toBeLessThanOrEqual(measurements.before + 16);
  }
});


test('repeat logging stays intentional and separate from Away', async ({page}) => {
  await today(page);
  await page.evaluate(() => { entries=[{id:94,activity:'Client build',energy:'deep',date:planTodayKey(),tsStart:Date.now()-7200000,ts:Date.now()-3600000,blockIntervalMin:60}]; renderToday(); });
  await expect(page.locator('#same-as-last-btn')).toBeHidden();
  await page.getByRole('navigation',{name:'Today actions'}).getByRole('button',{name:'Log time',exact:true}).click();
  await page.locator('#same-as-last-btn').click();
  expect(await page.evaluate(() => ({running,awayActive,currentTask}))).toEqual({running:true,awayActive:false,currentTask:'Client build'});
  expect(await page.evaluate(() => entries.length)).toBeGreaterThan(1);
});

test('many entries and long commitments stay bounded; active Focus keeps repair passive', async ({page}) => {
  await today(page,{routines:routineState(Array.from({length:15},(_,i)=>routine({id:`long-${i}`,mode:'anytime',title:`Routine ${i} ${'Long commitment '.repeat(8)}`})))});
  await page.evaluate(() => {
    entries=Array.from({length:80},(_,i)=>({id:1000+i,activity:`Activity ${i}`,energy:i%2?'deep':'waste',date:planTodayKey(),tsStart:Date.now()-(180+i*5)*60000,ts:Date.now()-(177+i*5)*60000,blockIntervalMin:3}));
    savePlanItems(planTodayKey(),Array.from({length:3},(_,i)=>createPlanItem(`Priority ${i} ${'long title '.repeat(6)}`,'')));
    renderToday();
  });
  await fs.mkdir(path.join(APP_ROOT,'test-results','phase6d'),{recursive:true});
  for(const width of [390,1280]) {
    await page.setViewportSize({width,height:900});
    await expect(page.locator('#routine-compact .commitment-routine')).toHaveCount(2);
    await expect(page.locator('#timeline-section')).toBeHidden();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:path.join(APP_ROOT,'test-results','phase6d',`long-commitments-${width}.png`),fullPage:true,animations:'disabled'});
  }
  await page.evaluate(() => { enterFocusMode({task:'Active Focus with unresolved history',autoStart:true}); checkSleepReminder(); renderToday(); });
  await expect(page.locator('#up-next')).toHaveAttribute('data-state','focus');
  expect(await page.evaluate(()=>getGapRecoveryCandidate(getViewingEntries())!==null)).toBe(true);
  await expect(page.locator('#sleep-reminder-overlay')).toBeHidden();
  for(const width of [390,1280]) {
    await page.setViewportSize({width,height:900});
    await expect(page.locator('#focus-overlay')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:path.join(APP_ROOT,'test-results','phase6d',`focus-${width}.png`),fullPage:false,animations:'disabled'});
  }
});


test('sleep snooze and log immediately remove the configured Needs You action', async ({page}) => {
  await today(page);
  await page.evaluate(() => { checkSleepReminder(); });
  await expect(page.locator('#today-sleep-reminder')).toBeVisible();
  await page.locator('#today-sleep-reminder').click();
  await page.evaluate(() => snoozeSleepReminder());
  await expect(page.locator('#needs-you')).toBeHidden();
  await page.evaluate(() => { localStorage.removeItem('ta3-sleep-snooze'); checkSleepReminder(); });
  await page.locator('#today-sleep-reminder').click();
  await page.evaluate(() => confirmSleepLog());
  await expect(page.locator('#today-sleep-reminder')).toBeHidden();
  expect(await page.evaluate(() => entries.some(e=>e.activity==='Sleep'))).toBe(true);
});


test('idle layout holds and a generic gap raises no Today interruption at phone and desktop widths', async ({page}) => {
  await fs.mkdir(path.join(APP_ROOT,'test-results','phase6d'),{recursive:true});
  for (const width of [390,1280]) {
    await page.setViewportSize({width,height:900});
    await today(page);
    await page.evaluate(() => { settings.sleepSetupDone=false; checkSleepReminder(); renderToday(); });
    await expect(page.locator('#routine-compact')).not.toContainText('Deep work');
    await page.screenshot({path:path.join(APP_ROOT,'test-results','phase6d',`idle-${width}.png`),fullPage:true});
    await page.evaluate(() => {
      // ~1h logged early, then a multi-hour generic gap to "now".
      entries=[{id:99,activity:'Earlier work',energy:'deep',date:planTodayKey(),tsStart:Date.now()-7200000,ts:Date.now()-3600000,blockIntervalMin:60}];
      renderToday();
    });
    // Phase 6J: the generic gap is a diagnostic fact but never a Needs You interruption.
    expect(await page.evaluate(() => getCloseoutGaps(planTodayKey()).length)).toBeGreaterThan(0);
    await expect(page.locator('#needs-you')).toBeHidden();
    await expect(page.locator('#gap-recovery')).toBeHidden();
    await page.screenshot({path:path.join(APP_ROOT,'test-results','phase6d',`needs-you-${width}.png`),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});
