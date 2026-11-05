import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startEmulator,token} from '../rtdb-emulator-support.js';
import {computeClosure} from '../scripts/runtime-mirror.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rules=readFileSync(path.join(root,'firebase.rules.json'),'utf8');
const allowed=new Set([...computeClosure({rootDir:root}).files,'sw.js']);
const now=Date.parse('2026-10-27T18:00:00Z');
let emulator,server,url;
test.beforeAll(async()=>{
  emulator=await startEmulator();
  server=http.createServer((request,response)=>{
    const pathname=new URL(request.url,'http://localhost').pathname;
    const file=pathname==='/'?'index.html':decodeURIComponent(pathname).slice(1);
    if(!allowed.has(file)){response.writeHead(404).end();return;}
    const type={'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream';
    response.writeHead(200,{'content-type':type,'Content-Security-Policy':`default-src 'self'; script-src 'self' 'unsafe-inline' https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:${emulator.port} ws://127.0.0.1:${emulator.port}; worker-src 'self'`});
    response.end(readFileSync(path.join(root,file)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  url=`http://127.0.0.1:${server.address().port}/`;
});
test.afterAll(async()=>{if(server)await new Promise(resolve=>server.close(resolve));emulator?.stop();});

async function open(page,world,device){
  for(const name of ['app','database'])await page.route(`https://www.gstatic.com/firebasejs/10.12.2/firebase-${name}-compat.js`,route=>route.fulfill({
    contentType:'text/javascript',body:readFileSync(path.join(root,`node_modules/firebase/firebase-${name}-compat.js`),'utf8')}));
  const config={databaseURL:`http://127.0.0.1:${emulator.port}?ns=${world.name}`,projectId:'demo-fence'};
  const bootstrap=`(()=>{
    const app=firebase.initializeApp(${JSON.stringify(config)});firebase.initializeApp=()=>app;
    app.database().useEmulator('127.0.0.1',${emulator.port},{mockUserToken:${JSON.stringify(token('alice'))}});
    app.database().INTERNAL.forceWebSockets();
    const user={uid:'alice',displayName:'Isolated SDK test',email:'sdk@example.invalid',photoURL:'',getIdToken:()=>Promise.reject(Error('Completion backend excluded'))};
    const auth={currentUser:user,onAuthStateChanged:callback=>{setTimeout(()=>callback(user),0);return()=>{};},signOut:async()=>{}};
    firebase.auth=()=>auth;
    firebase.auth.GoogleAuthProvider=class{};firebase.auth.GoogleAuthProvider.credential=()=>({});
  })();`;
  await page.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',route=>route.fulfill({contentType:'text/javascript',body:bootstrap}));
  await page.addInitScript(({now,device})=>{
    const RealDate=Date;
    window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
    localStorage.setItem('ta3-onboarded','1');sessionStorage.setItem('ta3-session-started','1');
    localStorage.setItem('ta3-device-id',device);
    localStorage.setItem('ta3-settings:uid_alice',JSON.stringify({timezone:'America/Phoenix',intervalMin:30,sleepSetupDone:true,presets:[],templates:[]}));
    localStorage.setItem('ta3-tz:uid_alice','America/Phoenix');
  },{now,device});
  await page.goto(url);
  await page.waitForFunction(async()=>{
    if(typeof firebase==='undefined'||(await firebase.database().ref('.info/connected').once('value')).val()!==true)return false;
    if(globalThis.getChronaSenseRoomCode?.()!=='uid_alice'||!globalThis.PlanAuthority?.upcoming()
      ||globalThis.accountLocalKey?.('ta3-plan-tomorrow-draft-v1')!=='ta3-plan-tomorrow-draft-v1:uid_alice')return false;
    try{PlanAuthority.assertDirectSchedulingTarget(PlanAuthority.upcoming());}catch{return false;}
    return globalThis.CalendarPlanLive?.authorityState?.()==='legacy'&&PlanAuthority.authorityState()==='legacy';
  });
}

async function openReadyPlanner(page){
  await page.waitForFunction(()=>{
    if(typeof openPlanTomorrow!=='function'||typeof getPlanTomorrowAppContext!=='function'
      ||globalThis.CalendarPlanLive?.authorityState?.()!=='legacy'||globalThis.PlanAuthority?.authorityState?.()!=='legacy'
      ||!PlanAuthority.upcoming())return false;
    openPlanTomorrow();
    return document.getElementById('plan-tomorrow-overlay').classList.contains('open');
  });
}

test('real SDK planner Save confirms, persists on another browser and still refuses a genuine source change',async({page,browser})=>{
  const world=await emulator.fresh(rules);
  await world.seed('rooms/uid_alice/settings',{timezone:'America/Phoenix',intervalMin:30,sleepSetupDone:true});
  await open(page,world,'sdk-ui-writer');
  await openReadyPlanner(page);
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
  await page.locator('#plan-tomorrow-add input[name="task"]').fill('Real SDK priority');
  await page.locator('#plan-tomorrow-add').getByRole('button',{name:'Add',exact:true}).click();
  await page.getByRole('button',{name:'Save plan',exact:true}).click();
  await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  const date=await page.evaluate(()=>PlanAuthority.upcoming().dateKey);
  const remote=await world.read(`rooms/uid_alice/plans/${date}`);
  expect(remote.items[0].task).toBe('Real SDK priority');
  expect(Object.hasOwn(remote.preparation,'routineInstanceIds')).toBe(false);
  await page.reload();
  await page.waitForFunction(()=>{const target=globalThis.PlanAuthority?.upcoming();return !!target&&PlanAuthority.preparation(target)?.oneOffItemIds.length===1;});
  const observer=await browser.newPage();
  try{
    await open(observer,world,'sdk-ui-reader');
    await observer.waitForFunction(()=>{const target=globalThis.PlanAuthority?.upcoming();return !!target&&PlanAuthority.preparation(target)?.oneOffItemIds.length===1;});
    expect(await observer.evaluate(()=>PlanAuthority.preparation(PlanAuthority.upcoming()).routineInstanceIds)).toEqual([]);
    await openReadyPlanner(page);
    const edited=await observer.evaluate(()=>{
      const target=PlanAuthority.upcoming(),item=PlanAuthority.items(target)[0];
      return PlanAuthority.updateItem({sourceTarget:target,itemId:item.id,changes:{task:'Changed on another device'},
        stamp:value=>stampPlanItemMutation(value,Date.now()+1000)}).item.task;
    });
    expect(edited).toBe('Changed on another device');
    await expect.poll(async()=>(await world.read(`rooms/uid_alice/plans/${date}`)).items[0].task).toBe('Changed on another device');
    await expect(page.locator('#pt-context-warning')).toContainText('This plan changed at source or on another device');
    await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
    await page.getByRole('button',{name:'Save plan',exact:true}).click();
    await expect(page.locator('#plan-tomorrow-error')).toContainText('This plan changed at source or on another device');
    expect((await world.read(`rooms/uid_alice/plans/${date}`)).items[0].task).toBe('Changed on another device');
  }finally{await observer.close();}
});

const MINUTE=60000;
async function quickLogWorld(page,{recent=false}={}){
  const world=await emulator.fresh(rules);
  await world.seed('rooms/uid_alice/settings',{timezone:'America/Phoenix',intervalMin:30,sleepSetupDone:true});
  if(recent)await world.seed('rooms/uid_alice/entries',{
    [`e_${now-70*MINUTE}`]:{id:now-70*MINUTE,ts:now-70*MINUTE,tsStart:now-75*MINUTE,updatedAt:now-70*MINUTE,
      blockIntervalMin:5,date:'2026-10-27',activity:'Recent test',energy:'deep',onPlan:true}
  });
  await open(page,world,'quick-log-ui-writer');
  if(recent)await page.waitForFunction(()=>entries.some(e=>e.activity==='Recent test'));
  await page.evaluate(async start=>{
    const BaseDate=Date;
    window.__quickLogNow=start;
    window.Date=class extends BaseDate{
      constructor(...args){super(...(args.length?args:[window.__quickLogNow]));}
      static now(){return window.__quickLogNow;}
    };
    if(!await _startTimer('UI test task'))throw Error('Test timer did not start');
    if(!running||!timerStateOwnedByCurrentAccount()||timerOwnerDeviceId!==syncedDeviceId)
      throw Error('Test requires the owned running timer');
    window.__quickLogNow=start+3*60000;
    openQuickLog();
  },now);
  if(recent)await page.locator('#ql-other-btn').click();
  await expect(page.locator('#quicklog-overlay')).toHaveClass(/open/);
  return world;
}

const liveEntries=async world=>Object.values(await world.read('rooms/uid_alice/entries')||{});

for(const adapter of ['quick','recent'])test(`quick-log UI: ${adapter} activity saves once, then Stop/reloads preserve contiguous time`,async({page})=>{
  const recent=adapter==='recent';
  const world=await quickLogWorld(page,{recent});
  const button=recent?page.locator('#ql-recent-tasks').getByRole('button',{name:/Recent test/})
    :page.locator('#ql-quick-actions').getByRole('button',{name:/^Deep Work/});
  await button.click();
  // A second event on the same adapter must retain the centralized busy guard.
  await button.evaluate(element=>element.click());
  await expect(page.locator('#quicklog-overlay')).not.toHaveClass(/open/);
  const saved=await page.evaluate(()=>({running,taskStartTime,busy:quickLogBusy,
    entries:entries.filter(e=>e.tsStart>=window.__quickLogNow-3*60000)}));
  expect(saved.running).toBe(true);
  expect(saved.busy).toBe(true);
  expect(saved.entries).toHaveLength(1);
  expect(saved.entries[0]).toMatchObject({activity:recent?'Recent test':'Deep work',tsStart:now,ts:now+3*MINUTE,blockIntervalMin:3});
  expect(saved.taskStartTime).toBe(now+3*MINUTE);
  await expect.poll(async()=>liveEntries(world)).toHaveLength(recent?2:1);
  await page.evaluate(end=>{window.__quickLogNow=end;},now+5*MINUTE);
  await page.locator('button[onclick="stopAndLog()"]').first().click();
  const expected=[{tsStart:now,ts:now+3*MINUTE},{tsStart:now+3*MINUTE,ts:now+5*MINUTE}];
  const spans=values=>values.filter(e=>e.tsStart>=now).sort((a,b)=>a.tsStart-b.tsStart).map(e=>({tsStart:e.tsStart,ts:e.ts}));
  await expect.poll(async()=>spans(await liveEntries(world))).toEqual(expected);
  for(let repeat=0;repeat<2;repeat++){
    await page.reload();
    await page.waitForFunction(start=>globalThis.getChronaSenseRoomCode?.()==='uid_alice'&&entries.filter(e=>e.tsStart>=start).length===2,now);
    expect(await page.evaluate(()=>running)).toBe(false);
    expect(spans(await page.evaluate(()=>entries))).toEqual(expected);
    expect(spans(await liveEntries(world))).toEqual(expected);
  }
});

test('quick-log UI: valid manual activity and category Save persists the pending span',async({page})=>{
  const world=await quickLogWorld(page);
  await page.locator('#ql-activity').fill('Manual test');
  await page.locator('#quicklog-overlay .energy-btn.deep').click();
  await page.locator('#quicklog-overlay').getByRole('button',{name:'Save Entry',exact:true}).click();
  await expect(page.locator('#quicklog-overlay')).not.toHaveClass(/open/);
  await expect.poll(async()=>(await liveEntries(world)).length).toBe(1);
  expect((await liveEntries(world))[0]).toMatchObject({activity:'Manual test',energy:'deep',tsStart:now,ts:now+3*MINUTE});
});

for(const guard of ['device','account'])test(`quick-log UI: ${guard} ownership refusal records nothing`,async({page})=>{
  const world=await quickLogWorld(page);
  await page.evaluate(kind=>{if(kind==='device')timerOwnerDeviceId='another-device';else _timerStateOwner='uid_another-account';},guard);
  await page.locator('#ql-quick-actions').getByRole('button',{name:/^Deep Work/}).click();
  expect(await page.evaluate(()=>({entries:entries.length,busy:quickLogBusy}))).toEqual({entries:0,busy:false});
  expect(await liveEntries(world)).toHaveLength(0);
});

test('quick-log UI: an already busy saver rejects another adapter event',async({page})=>{
  const world=await quickLogWorld(page);
  await page.evaluate(()=>{quickLogBusy=true;});
  await page.locator('#ql-quick-actions').getByRole('button',{name:/^Deep Work/}).click();
  expect(await page.evaluate(()=>entries.length)).toBe(0);
  expect(await liveEntries(world)).toHaveLength(0);
});
