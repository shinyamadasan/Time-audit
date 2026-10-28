// Planning Continuity V1 — the UX surfaces, in a real browser.
//
// Covers what unit tests structurally cannot: that the Top 3 cap and the uncapped
// "Other planned tasks" block behave as two separate sections in the DOM, that a 4th
// priority is refused through explicit UX rather than silently dropped, that a
// commitment entered by real date/time shows up on the correct personal day, that a
// DST-ambiguous time asks the owner which instant they meant, that an arbitrary
// future personal day can be browsed and prepared, and that a stale task from days
// earlier is discoverable and movable.
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
const SERVE_ROOT = process.env.QUALITY_BASELINE_ROOT || APP_ROOT;
let appServer = null;
let appUrl = '';

const TZ = 'Asia/Manila';
// 19:00 on 2026-09-18, so the personal day in progress began at 18:00 that date.
const NOW = Date.parse('2026-09-18T19:00:00+08:00');

// 18:00 Manila, effective from 2026-09-01 18:00 — well before every day these tests
// touch, so each of them is genuinely operational-governed rather than legacy.
const BOUNDARY_STORE = JSON.stringify({ schemaVersion: 1, revisions: {
  'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
  'r-1800': { id: 'r-1800', boundaryTime: '18:00', timezone: TZ, effectiveFromInstant: Date.parse('2026-09-01T18:00:00+08:00') },
} });

const TRUNCATED_BOUNDARY_STORE = JSON.stringify({ schemaVersion: 1, revisions: {
  'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
  'r-1800': { id: 'r-1800', boundaryTime: '18:00', timezone: TZ, effectiveFromInstant: Date.parse('2026-09-01T18:00:00+08:00') },
  'r-2000': { id: 'r-2000', boundaryTime: '20:00', timezone: TZ, effectiveFromInstant: Date.parse('2026-09-18T20:00:00+08:00') },
} });

const boundaryStoreFor = boundaryTime => JSON.stringify({ schemaVersion: 1, revisions: {
  'legacy-calendar-day-v0': { id: 'legacy-calendar-day-v0', boundaryTime: '00:00', timezone: TZ, effectiveFromInstant: null },
  [`r-${boundaryTime.replace(':', '')}`]: { id: `r-${boundaryTime.replace(':', '')}`, boundaryTime, timezone: TZ, effectiveFromInstant: Date.parse(`2026-09-01T${boundaryTime}:00+08:00`) },
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
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'pc-user', displayName: 'PC User', email: 'pc@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup() { return Promise.resolve(); }, signInWithCredential() { return Promise.resolve(); }, signOut() { return Promise.resolve(); } });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(config) { const app = { config }; this.apps.push(app); return app; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
})();`;

test.beforeAll(async () => {
  appServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = path.resolve(SERVE_ROOT, `.${decodeURIComponent(pathname)}`);
      if (!filePath.startsWith(SERVE_ROOT)) { res.writeHead(403).end(); return; }
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

const ROUTINES = JSON.stringify({ schemaVersion: 1, timezone: TZ, routines: [], manual: {}, links: {}, focus: {}, skips: {} });

async function openApp(page, { now = NOW, boundaryStore = BOUNDARY_STORE, plans = '{}', operationalPlans = null, commitments = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ timezone, now, boundaryStore, plans, operationalPlans, commitments, routines }) => {
    // The Date mock must be re-installed on EVERY load, including a reload.
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    // Seeding, by contrast, must happen ONCE: addInitScript runs again on reload, and
    // clearing storage there would wipe exactly what a reload test is checking.
    if (localStorage.getItem('pc-seeded') === '1') return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('pc-seeded', '1');
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz:uid_pc-user', timezone);
    localStorage.setItem('ta3-device-id', 'device-pc-test');
    localStorage.setItem('ta3-settings:uid_pc-user', JSON.stringify({ timezone, hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries:uid_pc-user', '[]');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-plans:uid_pc-user', plans);
    localStorage.setItem('ta3-daily-routines-v1', routines);
    if (boundaryStore) localStorage.setItem('ta3-day-boundary-revisions-v1:uid_pc-user', boundaryStore);
    if (operationalPlans) localStorage.setItem('ta3-operational-plans-v1:uid_pc-user', operationalPlans);
    if (commitments) localStorage.setItem('ta3-commitments-v1:uid_pc-user', commitments);
  }, { timezone: TZ, now, boundaryStore, plans, operationalPlans, commitments, routines: ROUTINES });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.PlanAuthority === 'object' && typeof window.CommitmentsRepository === 'object');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function seedCommandDay(page) {
  await page.waitForFunction(() => !!globalThis.DailyCommandCenter);
  return page.evaluate(() => {
    const target = PlanAuthority.current();
    const items = [
      {...createPlanItem('Review client feedback','19:00'),description:'Read the feedback and identify three decisions.',durationMinutes:60},
      {...createPlanItem('Plan next week','20:30'),description:'Choose three outcomes. Leave other ideas in Brain Dump.',durationMinutes:30},
      {...createPlanItem('Evening walk','22:00'),durationMinutes:30}
    ];
    PlanAuthority.saveItems(target,items);
    refreshAuthoritativePlanSurfaces();
    return {dayId:target.id,ids:items.map(item=>item.id)};
  });
}

test('compact cards reveal one detail, preserve descriptions on edit/reload, and retain exact plan identity', async ({page}) => {
  const errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  await openApp(page);
  const seeded = await seedCommandDay(page);
  const rows = page.locator('#timeline-blocks .tl-plan-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.locator('.command-card[open]')).toHaveCount(0);
  await rows.nth(0).locator('summary').click();
  await expect(rows.nth(0).locator('.command-description')).toHaveText('Read the feedback and identify three decisions.');
  await rows.nth(1).locator('summary').click();
  await expect(rows.locator('.command-card[open]')).toHaveCount(1);
  await expect(rows.nth(0).locator('.command-card')).not.toHaveAttribute('open','');
  await rows.nth(1).getByRole('button',{name:'Edit planned task Plan next week'}).click();
  const form = page.locator('#pc-task-form');
  await form.locator('[name="description"]').fill('Edited description <literal text>');
  await form.getByRole('button',{name:'Save',exact:true}).click();
  await page.reload();
  await page.waitForFunction(() => !!globalThis.DailyCommandCenter);
  await rows.nth(1).locator('summary').click();
  await expect(rows.nth(1).locator('.command-description')).toHaveText('Edited description <literal text>');
  expect(await rows.nth(1).getAttribute('data-plan-item-id')).toBe(seeded.ids[1]);
  expect(await rows.nth(1).getAttribute('data-plan-day-id')).toBe(seeded.dayId);
  expect(errors).toEqual([]);
});

test('deleting a planned task leaves linked recorded time byte-for-byte intact', async ({page}) => {
  await openApp(page);
  const seeded = await seedCommandDay(page);
  const record = await page.evaluate(({id}) => {
    const entry = {id:Date.now()-1,activity:'Review client feedback',energy:'deep',category:'deep_work',originalLabel:'deep',tsStart:Date.now()-1800000,ts:Date.now(),blockIntervalMin:30,planItemId:id,updatedAt:Date.now()};
    entries.push(entry);persist();refreshMyDayTimeline();
    return JSON.stringify(entry);
  },{id:seeded.ids[0]});
  const row = page.locator(`.tl-plan-row[data-plan-item-id="${seeded.ids[0]}"]`);
  await row.locator('summary').click();
  page.once('dialog',dialog=>dialog.accept());
  await row.getByRole('button',{name:'Delete planned task'}).click();
  await expect(row).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(entries[0]))).toBe(record);
  const tombstone = await page.evaluate(({dayId,id})=>PlanAuthority.rawItems(PlanAuthority.targetById(dayId)).find(item=>item.id===id),{dayId:seeded.dayId,id:seeded.ids[0]});
  expect(tombstone.deleted).toBe(true);
  await page.reload();
  await expect(page.locator('.tl-plan-row')).toHaveCount(2);
  expect(await page.evaluate(() => JSON.stringify(entries[0]))).toBe(record);
});

test('tracking uses the selected canonical item and refuses a second active session', async ({page}) => {
  await openApp(page);
  const seeded = await seedCommandDay(page);
  const row = page.locator(`.tl-plan-row[data-plan-item-id="${seeded.ids[1]}"]`);
  await row.locator('summary').click();
  await row.getByRole('button',{name:'Start Tracking',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>currentTaskPlanItemId)).toBe(seeded.ids[1]);
  expect(await page.evaluate(()=>currentTask)).toBe('Plan next week');
  await expect(page.locator('#command-next')).not.toContainText('Next · Plan next week');
  const other = page.locator(`.tl-plan-row[data-plan-item-id="${seeded.ids[0]}"]`);
  await other.locator('summary').click();
  await other.getByRole('button',{name:'Start Focus',exact:true}).click();
  expect(await page.evaluate(()=>currentTaskPlanItemId)).toBe(seeded.ids[1]);
  await expect(page.locator('#focus-overlay')).not.toHaveClass(/open/);
});

test('Plan Tomorrow uses the approved desktop modal and existing preparation flow', async ({page}) => {
  await openApp(page);
  await seedCommandDay(page);
  await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  const modal = page.locator('.plan-tomorrow-modal');
  await expect(modal).toBeVisible();
  const size = await modal.boundingBox();
  const viewport = page.viewportSize();
  expect(size.width).toBe(880);
  expect(size.height).toBeLessThanOrEqual(viewport.height-48);
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Prepare once for tomorrow');
  await page.locator('#plan-tomorrow-add button').click();
  await page.locator('#plan-tomorrow-confirm').click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  expect(await page.evaluate(()=>PlanAuthority.items(PlanAuthority.upcoming()).some(item=>item.task==='Prepare once for tomorrow'))).toBe(true);
});

test('desktop and phone show real responsive dashboard and compact/expanded timeline', async ({page},testInfo) => {
  await openApp(page,{now:Date.parse('2026-10-25T19:00:00+08:00')});
  const seeded = await seedCommandDay(page);
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    await page.evaluate(()=>refreshMyDayTimeline());
    await expect(page.locator('#command-priorities')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const app = await page.locator('.app').boundingBox();
    if (width===1440) expect(app.width).toBeGreaterThan(1100);
    const row = page.locator(`.tl-plan-row[data-plan-item-id="${seeded.ids[1]}"]`);
    if (!await row.locator('details').evaluate(el=>el.open)) await row.locator('summary').click();
    await expect(row.getByRole('button',{name:'Start Focus',exact:true})).toBeVisible();
    await page.screenshot({path:testInfo.outputPath(`application-${width}.png`),fullPage:true});
    if(width===390){
      await page.screenshot({path:testInfo.outputPath('application-mobile-overview.png')});
      await row.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
      await page.screenshot({path:testInfo.outputPath('application-mobile-detail.png')});
    }
    await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
    await expect(page.locator('#plan-tomorrow-title')).toBeInViewport({ratio:1});
    if(width===390)await expect.poll(()=>page.locator('.plan-tomorrow-modal').evaluate(el=>Math.round(el.getBoundingClientRect().top))).toBe(0);
    else expect((await page.locator('.plan-tomorrow-modal').boundingBox()).width).toBe(880);
    await page.locator('#plan-tomorrow-add input[name="task"]').fill('Review proposal draft');
    await page.locator('#plan-tomorrow-add input[name="when"]').fill('20:00');
    await page.locator('#plan-tomorrow-add button').click();
    await fs.writeFile(testInfo.outputPath(`plan-layout-${width}.json`),JSON.stringify(await page.locator('.plan-tomorrow-modal').evaluate(el=>({scrollTop:el.scrollTop,height:el.clientHeight,top:el.getBoundingClientRect().top,headerTop:el.querySelector('.pt-head').getBoundingClientRect().top,pageScroll:scrollY})),null,2));
    await page.screenshot({path:testInfo.outputPath(`plan-tomorrow-${width}.png`)});
    await page.locator('[data-pt-action="close"]').first().click();
    await page.locator('[data-pt-exit="discard"]').click();
  }
});

test('an overnight operational task keeps its owner on a factual next-day row', async ({page}) => {
  await openApp(page,{now:Date.parse('2026-10-26T02:00:00+08:00')});
  await page.waitForFunction(()=>!!globalThis.DailyCommandCenter);
  const owner = await page.evaluate(()=>{
    const target=PlanAuthority.current();
    PlanAuthority.addItem({destination:target,item:createPlanItem('Overnight handoff','03:00')});
    refreshAuthoritativePlanSurfaces();
    return target.id;
  });
  const row=page.locator('.tl-plan-row');
  await row.locator('summary').click();
  expect(await row.getAttribute('data-plan-day-id')).toBe(owner);
  await expect(row.locator('.command-schedule')).toContainText('Oct 26');
  await expect(row.locator('.command-schedule')).toContainText('Asia/Manila');
});

test('untimed tasks expose the same description, owner, execution and deletion controls', async ({page})=>{
  await openApp(page);
  await page.waitForFunction(()=>!!globalThis.DailyCommandCenter);
  const owner=await page.evaluate(()=>{
    const target=PlanAuthority.current();
    PlanAuthority.addItem({destination:target,item:{...createPlanItem('Anytime review',''),description:'Context for an untimed task'}});
    refreshAuthoritativePlanSurfaces();return target.id;
  });
  const row=page.locator('#timeline-anytime .anytime-row');
  await expect(row.locator('details')).not.toHaveAttribute('open','');
  await row.locator('summary').click();
  await expect(row.locator('.command-description')).toHaveText('Context for an untimed task');
  await expect(row.locator('.command-schedule')).toContainText('Anytime');
  expect(await row.getAttribute('data-plan-day-id')).toBe(owner);
  for(const name of ['Start Focus','Start Tracking','Delete planned task']) await expect(row.getByRole('button',{name,exact:true})).toBeVisible();
  await row.locator('summary').press('Escape');
  await expect(row.locator('details')).not.toHaveAttribute('open','');
  await expect(row.locator('summary')).toBeFocused();
});

test('an asynchronous launch cannot be double-started from another agenda card', async ({page})=>{
  await openApp(page);await seedCommandDay(page);
  await page.evaluate(()=>{
    const start=_startTimer;
    window.__launchCalls=[];
    _startTimer=async(...args)=>{window.__launchCalls.push(args);await new Promise(resolve=>{window.__releaseLaunch=resolve;});return start(...args);};
  });
  const rows=page.locator('.tl-plan-row');
  await rows.nth(0).locator('summary').click();
  await rows.nth(0).getByRole('button',{name:'Start Tracking',exact:true}).click();
  await rows.nth(1).locator('summary').click();
  await rows.nth(1).getByRole('button',{name:'Start Tracking',exact:true}).click();
  expect(await page.evaluate(()=>window.__launchCalls.length)).toBe(1);
  await page.evaluate(()=>window.__releaseLaunch());
  await expect.poll(()=>page.evaluate(()=>running)).toBe(true);
});

test('carrying a described priority into Plan Tomorrow preserves its context',async({page})=>{
  await openApp(page);await seedCommandDay(page);
  await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  await page.locator('[data-pt-fold="unfinished"]>summary').click();
  const carry=page.locator('.pt-reconcile-row').filter({hasText:'Plan next week'}).locator('[data-pt-action="carry"]');
  await carry.click();
  await page.locator('#plan-tomorrow-confirm').click();
  expect(await page.evaluate(()=>PlanAuthority.items(PlanAuthority.upcoming()).find(item=>item.task==='Plan next week').description)).toBe('Choose three outcomes. Leave other ideas in Brain Dump.');
});

async function seedConsiderations(page) {
  await page.waitForFunction(()=>!!window.BrainDumpRepository);
  return page.evaluate(()=>{
    for(let i=0;i<30;i++){
      const created=BrainDumpRepository.create({id:`planner031_${i}`,text:`Considered outcome ${i+1}`});
      BrainDumpRepository.triage(created.record.id,{important:i%3!==2,urgent:i%3===0});
    }
    return JSON.stringify(BrainDumpRepository.listAllRaw());
  });
}
async function addTomorrowPriority(page,title) {
  await page.locator('#plan-tomorrow-add input[name="task"]').fill(title);
  await page.locator('#plan-tomorrow-add button').click();
}

test('TASK-033 actual product review captures',async({page})=>{
  const phase=process.env.QUALITY_CAPTURE_PHASE || 'after';
  const output=path.join(APP_ROOT,process.env.QUALITY_REVIEW_DIR || 'review-artifacts/task-033-product-quality',phase);
  await fs.mkdir(output,{recursive:true});
  await openApp(page,{now:Date.parse('2026-10-26T19:00:00+08:00')});
  await seedCommandDay(page);await seedConsiderations(page);
  const measurements=[];
  for(const [width,height,label]of[[1920,1080,'desktop'],[1366,768,'laptop'],[390,844,'mobile']]){
    await page.setViewportSize({width,height});
    const card=page.locator('#timeline-blocks .tl-plan-row').nth(1).locator('.command-card');
    if(await card.getAttribute('open')===null) await card.locator('summary').click();
    await page.evaluate(()=>document.fonts.ready);
    measurements.push(await page.evaluate(({width,height,label})=>({width,height,label,upNextHeight:document.querySelector('#up-next').getBoundingClientRect().height,visibleUpNextActions:[...document.querySelectorAll('#up-next button')].filter(el=>el.checkVisibility()).map(el=>el.textContent.trim()),navDestinations:[...document.querySelectorAll('.nav>.nav-btn')].filter(el=>el.checkVisibility()).map(el=>el.textContent.trim())}),{width,height,label}));
    await page.screenshot({path:path.join(output,`my-day-${label}.png`),animations:'disabled'});
    if(label==='mobile') {
      await card.evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}));
      if(phase==='after') {
        const metrics=await card.getByRole('button',{name:'Start Tracking',exact:true}).evaluate(el=>{const style=getComputedStyle(el),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.font=style.font;return {height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width,padding:style.padding,font:style.font,textWidth:ctx.measureText(el.textContent).width};});
        await fs.writeFile(path.join(output,'mobile-action-metrics.json'),JSON.stringify(metrics,null,2)+'\n');
        expect(metrics.height).toBe(44);
      }
      await page.screenshot({path:path.join(output,'my-day-mobile-detail.png'),animations:'disabled'});
      await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
    }
    await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
    if(label==='desktop'){await addTomorrowPriority(page,'Prepare the proposal');await addTomorrowPriority(page,'Make room for deep work');}
    await page.screenshot({path:path.join(output,`planner-${label}.png`),animations:'disabled'});
    await page.locator('[data-pt-action="close"]').first().click();
    await page.locator('[data-pt-exit="keep"]').click();
    await expect(page.locator('#plan-tomorrow-overlay')).toHaveCSS('opacity','0');
  }
  await fs.writeFile(path.join(output,'MEASUREMENTS.json'),JSON.stringify(measurements,null,2)+'\n');
});

test('TASK-033 readable compact planner keeps Save, editing and keyboard exit usable across viewports',async({page})=>{
  await openApp(page);await seedCommandDay(page);
  const agenda=page.locator('#timeline-blocks .command-card summary').first();
  await agenda.focus();await expect(agenda).toHaveCSS('outline-offset','-4px');
  await page.keyboard.press('Enter');await expect(agenda.locator('..')).toHaveAttribute('open','');
  await page.keyboard.press('Escape');await expect(agenda).toBeFocused();
  const results=[];
  for(const [width,height,label]of[[1920,1080,'desktop'],[1366,768,'laptop'],[768,1024,'tablet'],[390,844,'phone'],[683,384,'200-percent-css-viewport']]){
    await page.setViewportSize({width,height});
    await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
    if(label==='desktop'){await addTomorrowPriority(page,'Prepare a clear proposal');await addTomorrowPriority(page,'Leave room for deep work');}
    await page.evaluate(()=>document.fonts.ready);
    expect(await page.evaluate(()=>document.fonts.check('400 16px "Chrona Inter"'))).toBe(true);
    const metrics=await page.evaluate(()=>{
      const box=el=>({height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width});
      const scroll=document.querySelector('.pt-scroll');
      const lum=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(n=>{const c=Number(n)/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
      const intro=getComputedStyle(document.querySelector('.pt-section-intro')),surface=getComputedStyle(document.querySelector('.plan-tomorrow-modal'));
      const values=[lum(intro.color),lum(surface.backgroundColor)].sort((a,b)=>b-a);
      return {font:getComputedStyle(document.querySelector('.pt-title')).fontFamily,card:box(document.querySelector('.pt-oneoff')),save:box(document.querySelector('#plan-tomorrow-confirm')),scrollOverflow:scroll.scrollWidth-scroll.clientWidth,pageOverflow:document.documentElement.scrollWidth-innerWidth,mutedContrast:(values[0]+.05)/(values[1]+.05)};
    });
    expect(metrics.font).toContain('Chrona Inter');expect(metrics.card.height).toBeLessThan(130);expect(metrics.save.height).toBeGreaterThanOrEqual(44);expect(metrics.scrollOverflow).toBeLessThanOrEqual(1);expect(metrics.pageOverflow).toBeLessThanOrEqual(1);
    expect(metrics.mutedContrast).toBeGreaterThanOrEqual(4.5);
    await page.locator('.pt-plan-zone>section:first-child').locator('button:visible,input:visible,summary:visible').last().focus();
    await page.keyboard.press('Tab');await expect(page.locator('.pt-consider>summary')).toBeFocused();
    const save=page.locator('#plan-tomorrow-confirm');await save.focus();await page.keyboard.press('Tab');await expect(page.locator('.pt-head [data-pt-action="close"]')).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(save).toBeFocused();
    await page.locator('.pt-edit summary').first().click();
    await expect(page.getByRole('button',{name:'Move to other tasks'}).first()).toBeVisible();
    await page.locator('[data-pt-notes]').first().fill('A short, useful note.');
    await page.keyboard.press('Escape');await expect(page.locator('#pt-exit')).toBeVisible();
    await page.locator('[data-pt-exit="keep"]').click();
    await expect(page.getByRole('button',{name:'Plan Tomorrow',exact:true})).toBeFocused();
    results.push({label,width,height,...metrics});
  }
  await fs.writeFile(path.join(APP_ROOT,`${process.env.QUALITY_REVIEW_DIR || 'review-artifacts/task-033-product-quality'}/LAYOUT_CHECKS.json`),JSON.stringify(results,null,2)+'\n');
});

test('TASK-031 read-only Q1/Q2 source review preserves the same-tab planning draft and partial input',async({page,context})=>{
  await openApp(page);const source=await seedConsiderations(page);
  await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  await addTomorrowPriority(page,'Owner chosen priority');
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Unsubmitted thought');
  await expect(page.locator('.pt-candidate')).toHaveCount(4);
  await expect(page.locator('.pt-candidate small').filter({hasText:'Q1'})).toHaveCount(2);
  await expect(page.locator('.pt-candidate small').filter({hasText:'Q2'})).toHaveCount(2);
  await expect(page.locator('.pt-consider [data-pt-action="suggest"]')).toHaveCount(0);
  const tabs=context.pages().length;
  await page.locator('.pt-candidate button').first().click();
  await expect(page.locator('#view-braindump')).toHaveClass(/active/);expect(context.pages().length).toBe(tabs);
  await page.locator('#pt-return').click();
  await expect(page.locator('.pt-oneoff-task')).toContainText('Owner chosen priority');
  await expect(page.locator('#plan-tomorrow-add input[name="task"]')).toHaveValue('Unsubmitted thought');
  expect(await page.evaluate(()=>JSON.stringify(BrainDumpRepository.listAllRaw()))).toBe(source);
  expect(await page.evaluate(()=>PlanAuthority.items(PlanAuthority.upcoming()))).toEqual([]);
});

test('TASK-031 draft reload, Escape and explicit discard retain exact unsaved item identity',async({page})=>{
  await openApp(page);await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  await addTomorrowPriority(page,'Recover after reload');
  const id=await page.locator('[data-pt-item]').getAttribute('data-pt-item');
  await page.locator('.pt-edit summary').click();await page.locator('[data-pt-notes]').fill('Notes <literal>');
  await page.keyboard.press('Escape');await expect(page.locator('#pt-exit')).toBeVisible();await page.locator('[data-pt-exit="stay"]').click();
  page.once('dialog',dialog=>dialog.accept());await page.reload();await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  await expect(page.locator('[data-pt-item]')).toHaveAttribute('data-pt-item',id);
  await page.locator('.pt-edit summary').click();await expect(page.locator('[data-pt-notes]')).toHaveValue('Notes <literal>');
  await page.locator('[data-pt-action="close"]').first().click();await page.locator('[data-pt-exit="discard"]').click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  expect(await page.evaluate(()=>PlanAuthority.items(PlanAuthority.upcoming()))).toEqual([]);
});

test('TASK-031 offline outcome is local-only and repeated Save does not write twice',async({page})=>{
  await openApp(page);await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();await addTomorrowPriority(page,'Keep the local save');
  await page.evaluate(()=>{const original=PlanAuthority.confirmPreparation;window.__saves031=0;PlanAuthority.confirmPreparation=(...args)=>{window.__saves031++;const result=original(...args);return {...result,syncPromise:Promise.resolve(false)};};});
  await page.locator('#plan-tomorrow-confirm').click();await expect(page.locator('#pt-save-status')).toContainText('sync not confirmed');
  await page.locator('#plan-tomorrow-confirm').evaluate(el=>el.click());expect(await page.evaluate(()=>window.__saves031)).toBe(1);
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
  const items=await page.evaluate(()=>PlanAuthority.items(PlanAuthority.upcoming()));expect(items).toHaveLength(1);expect(items[0].task).toBe('Keep the local save');
  await page.locator('[data-pt-action="close"]').first().click();await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  await expect(page.locator('#pt-save-status')).toContainText('sync not confirmed');expect(await page.locator('[data-pt-item]').getAttribute('data-pt-item')).toBe(items[0].id);
});

test('TASK-031 failed preparation preserves draft and a successful retry keeps its identity',async({page})=>{
  await openApp(page);await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();await addTomorrowPriority(page,'Retry unchanged identity');
  const id=await page.locator('[data-pt-item]').getAttribute('data-pt-item');
  await page.locator('.pt-edit summary').click();await page.locator('[data-pt-title]').fill('Edited before retry');await page.locator('[data-pt-notes]').fill('Literal <notes> retained');
  await page.evaluate(()=>{window.__confirm031=PlanAuthority.confirmPreparation;PlanAuthority.confirmPreparation=()=>{throw new Error('Controlled preparation failure');};});
  await page.locator('#plan-tomorrow-confirm').click();await expect(page.locator('#plan-tomorrow-error')).toHaveText('Controlled preparation failure');
  await expect(page.locator('[data-pt-item]')).toHaveAttribute('data-pt-item',id);expect(await page.evaluate(()=>PlanAuthority.items(PlanAuthority.upcoming()))).toEqual([]);
  await page.evaluate(()=>PlanAuthority.confirmPreparation=window.__confirm031);await page.locator('#plan-tomorrow-confirm').click();
  expect((await page.evaluate(()=>PlanAuthority.items(PlanAuthority.upcoming()))).map(x=>x.id)).toEqual([id]);
  const saved=await page.evaluate(()=>PlanAuthority.items(PlanAuthority.upcoming())[0]);expect(saved.task).toBe('Edited before retry');expect(saved.description).toBe('Literal <notes> retained');
});

test('TASK-031 changed source plan is not overwritten; latest review preserves unsaved choices',async({page})=>{
  await openApp(page);await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();await addTomorrowPriority(page,'My unsaved outcome');
  const remote=await page.evaluate(()=>{const target=PlanAuthority.upcoming();const item=createPlanItem('Change from another device','','task');PlanAuthority.addItem({destination:target,item});return JSON.stringify(PlanAuthority.rawItems(target));});
  await page.locator('#plan-tomorrow-confirm').click();await expect(page.locator('#plan-tomorrow-error')).toContainText('changed at source');
  expect(await page.evaluate(()=>JSON.stringify(PlanAuthority.rawItems(PlanAuthority.upcoming())))).toBe(remote);
  await page.locator('[data-pt-action="latest"]').click();await expect(page.locator('.pt-latest')).toContainText('Change from another device');await expect(page.locator('.pt-oneoff-task')).toContainText('My unsaved outcome');
});

test('TASK-031 personal-day transition blocks re-owning the original planning draft',async({page})=>{
  await openApp(page);await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();await addTomorrowPriority(page,'Keep original Personal Day');
  const heading=await page.locator('#plan-tomorrow-date').textContent();
  const id=await page.evaluate(()=>PlanAuthority.upcoming().id);
  await page.evaluate(()=>{const now=Date.now();Date.now=()=>now+86400000;});
  await page.locator('#plan-tomorrow-confirm').click();await expect(page.locator('#plan-tomorrow-error')).toContainText('day changed');
  await expect(page.locator('#plan-tomorrow-date')).toHaveText(heading);
  expect(await page.evaluate(id=>PlanAuthority.preparation(PlanAuthority.targetById(id)),id)).toBeNull();
});

test('TASK-031 integrated planner screenshots and mobile keyboard-height geometry',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',err=>errors.push(err.message));
  await openApp(page,{now:Date.parse('2026-10-26T19:00:00+08:00')});await seedCommandDay(page);await seedConsiderations(page);
  for(const [width,height,label]of[[1920,1080,'desktop'],[1366,768,'laptop'],[390,844,'mobile']]){
    await page.setViewportSize({width,height});await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
    if(label==='desktop'){await addTomorrowPriority(page,'Prepare the proposal');await addTomorrowPriority(page,'Make room for deep work');}
    const modal=await page.locator('.plan-tomorrow-modal').boundingBox(),save=await page.locator('#plan-tomorrow-confirm').boundingBox();
    expect(modal.width).toBe(width===390?390:880);expect(save.y+save.height).toBeLessThanOrEqual(height);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path:testInfo.outputPath(`integrated-planner-${label}.png`)});
    if(width===390){
      await page.locator('.pt-edit summary').first().click();const notes=page.locator('[data-pt-notes]').first();await notes.fill('A clear outcome, with the existing plan authority preserved.');
      await page.setViewportSize({width,height:480});await notes.scrollIntoViewIfNeeded();const footer=await page.locator('.pt-footer').boundingBox(),field=await notes.boundingBox();
      expect(footer.y+footer.height).toBeLessThanOrEqual(480);expect(field.y+field.height).toBeLessThanOrEqual(footer.y+1);
      await page.setViewportSize({width,height});await page.screenshot({path:testInfo.outputPath('integrated-planner-mobile-edit.png')});
    }
    await page.locator('[data-pt-action="close"]').first().click();await page.locator('[data-pt-exit="keep"]').click();
  }
  expect(errors).toEqual([]);
});

test('TASK-031 explicit discard and fresh-plan replacement cannot recapture old form input',async({page})=>{
  await openApp(page);await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Explicitly discarded input');
  await page.locator('[data-pt-action="close"]').first().click();await page.locator('[data-pt-exit="discard"]').click();
  await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();await expect(page.locator('#plan-tomorrow-add input[name="task"]')).toHaveValue('');
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Discard on fresh plan');
  await page.evaluate(()=>PlanAuthority.addItem({destination:PlanAuthority.upcoming(),item:createPlanItem('Canonical task','','task')}));
  await page.locator('#plan-tomorrow-confirm').click();await page.locator('[data-pt-action="latest"]').click();
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-pt-action="fresh"]').click();
  await expect(page.locator('#plan-tomorrow-add input[name="task"]')).toHaveValue('');
});

test('TASK-031 Normal to Rescue round trip preserves unsubmitted form text',async({page})=>{
  await openApp(page);await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Partial normal-mode priority');
  await page.locator('[data-pt-mode="rescue"]').click();await page.locator('[data-pt-mode="normal"]').click();
  await expect(page.locator('#plan-tomorrow-add input[name="task"]')).toHaveValue('Partial normal-mode priority');
});

test('TASK-031 pending save freezes mode changes and late settlement does not steal navigation',async({page})=>{
  await openApp(page);await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();await addTomorrowPriority(page,'Pending confirmation');
  await page.evaluate(()=>{const original=PlanAuthority.confirmPreparation;PlanAuthority.confirmPreparation=(...args)=>({...original(...args),syncPromise:new Promise(resolve=>window.__resolveSave031=resolve)});});
  await page.locator('#plan-tomorrow-confirm').click();await expect(page.locator('#pt-save-status')).toHaveText('Saved on this device · sync pending');
  expect(await page.locator('.pt-scroll').evaluate(el=>el.inert)).toBe(true);
  await page.locator('[data-pt-mode="rescue"]').evaluate(el=>el.click());await expect(page.locator('[data-pt-mode="normal"]')).toHaveClass(/selected/);
  await page.locator('[data-pt-action="close"]').first().click();await page.evaluate(()=>showView('braindump'));
  const nav=page.locator('.nav-btn').filter({hasText:'Brain Dump'});await nav.focus();
  await page.evaluate(()=>window.__resolveSave031(true));await expect(page.locator('#view-braindump')).toHaveClass(/active/);await expect(nav).toBeFocused();
  await expect(page.locator('#review-overlay')).not.toHaveClass(/open/);
});

for(const change of['account','day'])test(`TASK-031 reason blur immediately after ${change} change performs no source write`,async({page})=>{
  await openApp(page);await seedCommandDay(page);await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  await page.locator('[data-pt-fold="unfinished"]>summary').click();await expect(page.locator('.pt-reconcile-reason').first()).toBeVisible();
  const result=await page.evaluate(change=>{
    const field=document.querySelector('.pt-reconcile-reason');const original=PlanAuthority.saveItems;let writes=0;
    PlanAuthority.saveItems=(...args)=>{writes++;return original(...args);};
    if(change==='account')window.getChronaSenseRoomCode=()=> 'uid_another';
    else{const now=Date.now();Date.now=()=>now+86400000;}
    field.value='Must not write through stale context';field.dispatchEvent(new Event('change',{bubbles:true}));return writes;
  },change);
  expect(result).toBe(0);
});

test('TASK-031 late sync acknowledgement cannot update the next account checkpoint',async({page})=>{
  await openApp(page);await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();await addTomorrowPriority(page,'Owner scoped pending save');
  await page.evaluate(()=>{const original=PlanAuthority.confirmPreparation;PlanAuthority.confirmPreparation=(...args)=>({...original(...args),syncPromise:new Promise(resolve=>window.__resolveSave031=resolve)});});
  await page.locator('#plan-tomorrow-confirm').click();await expect(page.locator('#pt-save-status')).toContainText('sync pending');
  const checkpoint=await page.evaluate(()=>sessionStorage.getItem('ta3-plan-tomorrow-draft-v1:uid_pc-user'));
  await page.evaluate(()=>{window.getChronaSenseRoomCode=()=> 'uid_another';window.__resolveSave031(true);});
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  expect(await page.evaluate(()=>sessionStorage.getItem('ta3-plan-tomorrow-draft-v1:uid_another'))).toBeNull();
  expect(await page.evaluate(()=>sessionStorage.getItem('ta3-plan-tomorrow-draft-v1:uid_pc-user'))).toBe(checkpoint);
});

test('TASK-031 normal sync item/key ordering and Firebase null pruning do not fabricate a source conflict',async({page})=>{
  await openApp(page);await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  await addTomorrowPriority(page,'First outcome');await addTomorrowPriority(page,'Second outcome');
  await page.evaluate(()=>{
    const confirm=PlanAuthority.confirmPreparation,rawItems=PlanAuthority.rawItems;
    PlanAuthority.confirmPreparation=(...args)=>{
      const result=confirm(...args);
      return {...result,syncPromise:new Promise(resolve=>window.__settleOrdered031=()=>{
        PlanAuthority.rawItems=target=>rawItems(target).slice().reverse().map(item=>Object.fromEntries(Object.entries(item).reverse().filter(([,value])=>value!==null&&value!==undefined)));
        resolve(true);
      })};
    };
  });
  await page.locator('#plan-tomorrow-confirm').click();await expect(page.locator('#pt-save-status')).toContainText('sync pending');
  await page.evaluate(()=>window.__settleOrdered031());
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  expect((await page.evaluate(()=>PlanAuthority.items(PlanAuthority.upcoming()))).map(item=>item.task).sort()).toEqual(['First outcome','Second outcome']);
});


test('TASK-033 visual refinement keeps one main action and all phone destinations behind accessible More',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await openApp(page,{now:Date.parse('2026-10-26T19:00:00+08:00')});await seedCommandDay(page);
  await expect(page.locator('#today-action-primary')).toBeVisible();
  await expect(page.locator('#choose-work')).toBeHidden();
  await expect(page.locator('#up-next button:visible')).toHaveCount(1);
  await page.locator('.execution-alternatives>summary').click();
  await expect(page.locator('#choose-work')).toBeVisible();
  await page.locator('.execution-alternatives>summary').click();
  await expect(page.locator('.nav>.nav-btn:visible')).toHaveCount(5);
  await expect(page.locator('.nav .nav-secondary:visible')).toHaveCount(0);
  for(const [label,view]of[['Life','life'],['Learning plans','learning'],['Career','career'],['Settings','settings']]){
    await page.locator('#nav-more').click();
    await expect(page.locator('#nav-more-dialog')).toBeVisible();
    if(label==='Life') await page.screenshot({path:path.join(APP_ROOT,'review-artifacts/task-033-visual-refinement/after/mobile-more.png'),animations:'disabled'});
    await page.locator('#nav-more-dialog').getByRole('button',{name:label,exact:true}).click();
    await expect(page.locator(`#view-${view}`)).toHaveClass(/active/);
    await expect(page.locator('#nav-more-dialog')).toBeHidden();
    expect(await page.locator('#nav-more').evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  await page.locator('#nav-more').click();await page.keyboard.press('Escape');
  await expect(page.locator('#nav-more')).toBeFocused();
  await page.locator('#nav-more').click();await page.mouse.click(2,2);
  await expect(page.locator('#nav-more-dialog')).toBeHidden();
  await expect(page.locator('#nav-more')).toBeFocused();
  await page.locator('#nav-today').click();
  await page.setViewportSize({width:1366,height:768});
  await expect(page.locator('.nav>.nav-btn:visible')).toHaveCount(8);
  await expect(page.locator('#nav-more')).toBeHidden();
});

test('TASK-033 visual refinement discovers read-only suggestions and keeps full-height sheet controls clear',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await openApp(page,{now:Date.parse('2026-10-26T19:00:00+08:00')});await seedCommandDay(page);const source=await seedConsiderations(page);
  await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  await addTomorrowPriority(page,'Prepare the proposal');
  await expect(page.locator('#plan-tomorrow-title')).toHaveText('Plan your next day');
  const date=await page.locator('#plan-tomorrow-date').textContent();
  expect(date).toContain('18:00');await expect(page.locator('#plan-tomorrow-timezone')).toHaveText('Asia/Manila');
  const discover=page.locator('.pt-source-jump');
  await expect(discover).toHaveText('From Brain Dump · 4');
  expect(await discover.evaluate(el=>el.getBoundingClientRect().bottom)).toBeLessThan(844);
  await discover.click();await expect(page.locator('.pt-consider')).toHaveAttribute('open','');
  await expect(page.locator('.pt-consider>summary')).toBeFocused();
  await page.screenshot({path:path.join(APP_ROOT,'review-artifacts/task-033-visual-refinement/after/planner-mobile-ideas.png'),animations:'disabled'});
  await expect(page.locator('.pt-candidate')).toHaveCount(4);
  await expect(page.locator('.pt-consider [data-pt-action="suggest"]')).toHaveCount(0);
  expect(await page.evaluate(()=>JSON.stringify(BrainDumpRepository.listAllRaw()))).toBe(source);
  for(const height of [844,480]){
    await page.setViewportSize({width:390,height});
    await page.locator('.pt-scroll').evaluate(el=>el.scrollTop=el.scrollHeight);
    const metrics=await page.evaluate(()=>{
      const footer=document.querySelector('.pt-footer').getBoundingClientRect(),scroll=document.querySelector('.pt-scroll').getBoundingClientRect(),save=document.querySelector('#plan-tomorrow-confirm').getBoundingClientRect();
      return {footerTop:footer.top,scrollBottom:scroll.bottom,saveBottom:save.bottom,saveHeight:save.height,overflow:document.querySelector('.pt-scroll').scrollWidth-document.querySelector('.pt-scroll').clientWidth};
    });
    expect(metrics.scrollBottom).toBeLessThanOrEqual(metrics.footerTop+1);expect(metrics.saveBottom).toBeLessThanOrEqual(height);expect(metrics.saveHeight).toBeGreaterThanOrEqual(44);expect(metrics.overflow).toBeLessThanOrEqual(1);
  }
  await page.keyboard.press('Escape');await page.locator('[data-pt-exit="keep"]').click();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Plan Tomorrow',exact:true}).click();
  await expect(page.locator('.pt-oneoff-task').first()).toHaveText('Prepare the proposal');
  await expect(page.locator('#plan-tomorrow-date')).toHaveText(date);
});
