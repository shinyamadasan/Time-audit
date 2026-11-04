// TASK-039 — acknowledged Undo through the REAL app, REAL Firebase SDK and REAL RTDB emulator with
// the canonical rules. The app's own REST transport (ID-token reads + one multi-path PATCH) is the
// only Undo writer; faults are injected on the wire with Playwright routes, never in app code.
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
const MIN=60000;
const T0=Date.parse('2026-10-28T16:00:00Z');
const ROOM='rooms/uid_alice';
let emulator,server,url;

test.beforeAll(async()=>{
  emulator=await startEmulator();
  server=http.createServer((request,response)=>{
    const pathname=new URL(request.url,'http://localhost').pathname;
    const file=pathname==='/'?'index.html':decodeURIComponent(pathname).slice(1);
    if(!allowed.has(file)){response.writeHead(404).end();return;}
    const type={'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream';
    response.writeHead(200,{'content-type':type});
    response.end(readFileSync(path.join(root,file)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  url=`http://127.0.0.1:${server.address().port}/`;
});
test.afterAll(async()=>{if(server)await new Promise(resolve=>server.close(resolve));emulator?.stop();});

async function open(page,world,{fresh=true}={}){
  for(const name of ['app','database'])await page.route(`https://www.gstatic.com/firebasejs/10.12.2/firebase-${name}-compat.js`,route=>route.fulfill({
    contentType:'text/javascript',body:readFileSync(path.join(root,`node_modules/firebase/firebase-${name}-compat.js`),'utf8')}));
  const config={databaseURL:`http://127.0.0.1:${emulator.port}?ns=${world.name}`,projectId:'demo-time-ack'};
  const bootstrap=`(()=>{
    const app=firebase.initializeApp(${JSON.stringify(config)});firebase.initializeApp=()=>app;
    app.database().useEmulator('127.0.0.1',${emulator.port},{mockUserToken:${JSON.stringify(token('alice'))}});
    app.database().INTERNAL.forceWebSockets();
    const user={uid:'alice',displayName:'Time ack test',email:'ack@example.invalid',photoURL:'',getIdToken:()=>Promise.resolve(${JSON.stringify(token('alice'))})};
    const auth={currentUser:user,onAuthStateChanged:callback=>{setTimeout(()=>callback(user),0);return()=>{};},signOut:async()=>{}};
    firebase.auth=()=>auth;
    firebase.auth.GoogleAuthProvider=class{};firebase.auth.GoogleAuthProvider.credential=()=>({});
  })();`;
  await page.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',route=>route.fulfill({contentType:'text/javascript',body:bootstrap}));
  await page.addInitScript(({T0,fresh})=>{
    if(location.protocol!=='http:')return;
    const RealDate=Date;
    const now=()=>Number(localStorage.getItem('__ack-now'))||T0;
    window.__setNow=ts=>localStorage.setItem('__ack-now',String(ts));
    window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now()]));}static now(){return now();}};
    sessionStorage.setItem('ta3-session-started','1');
    if(fresh&&!localStorage.getItem('__ack-seeded')){
      localStorage.setItem('__ack-seeded','1');
      localStorage.setItem('__ack-now',String(T0));
      localStorage.setItem('ta3-onboarded','1');
      localStorage.setItem('ta3-device-id','ack-device');
      localStorage.setItem('ta3-settings:uid_alice',JSON.stringify({timezone:'America/Phoenix',intervalMin:30,sleepSetupDone:true,presets:[],templates:[]}));
      localStorage.setItem('ta3-tz:uid_alice','America/Phoenix');
    }
  },{T0,fresh});
  await page.goto(url);
  await ready(page);
}

async function ready(page){
  await page.waitForFunction(async()=>typeof firebase!=='undefined'
    &&(await firebase.database().ref('.info/connected').once('value')).val()===true
    &&globalThis.getChronaSenseRoomCode?.()==='uid_alice'&&typeof _doQuickSave==='function'
    &&!!globalThis.TimeAckCore);
  await page.waitForFunction(()=>typeof _timeAckOnline!=='undefined'&&_timeAckOnline?.online===true);
}

const local=page=>page.evaluate(()=>({running,taskStartTime,blockStartTime,undo:lastUndoAction&&{label:lastUndoAction.label,type:lastUndoAction.type},
  live:entries.filter(e=>!e.deleted).map(e=>({id:e.id,tsStart:e.tsStart,ts:e.ts})),
  record:JSON.parse(localStorage.getItem('ta3-time-ack:uid_alice')||'null')}));
const remote=async world=>({timer:await world.read(`${ROOM}/timer`),entries:Object.values(await world.read(`${ROOM}/entries`)||{})});

/** Starts at T0, saves at T0+10m; returns once the server holds the Save and its cursor. */
async function savedSession(page,world){
  await page.evaluate(async()=>{if(!await _startTimer('Writing'))throw Error('timer did not start');});
  await page.evaluate(ts=>window.__setNow(ts),T0+10*MIN);
  await page.evaluate(()=>{quickLogBusy=false;_doQuickSave('Writing','deep');});
  await expect.poll(async()=>{const r=await remote(world);return [r.entries.filter(e=>!e.deleted).length,r.timer?.taskStartTime];}).toEqual([1,T0+10*MIN]);
  expect((await local(page)).taskStartTime).toBe(T0+10*MIN);
}
const patches=page=>{const seen=[];page.on('request',r=>{if(r.method()==='PATCH'&&r.url().includes(`:${emulator.port}/`))seen.push(r.url());});return seen;};
const ackRoute=`http://127.0.0.1:*/rooms/uid_alice.json*`;

test('accepted Undo applies once from the toast; the next Stop logs the original span without duplicates',async({page})=>{
  const world=await emulator.fresh(rules);
  await open(page,world);
  const sent=patches(page);
  await savedSession(page,world);
  await page.evaluate(()=>showUndoToast('Logged · Writing',''));
  await page.locator('#toast').getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.locator('#toast')).toContainText('Undid log');
  const after=await local(page);
  expect(after).toMatchObject({running:true,taskStartTime:T0,blockStartTime:T0,undo:null,live:[]});
  expect(after.record.operation).toBeNull();
  expect(after.record.history.map(op=>op.outcome)).toEqual(['applied']);
  const r=await remote(world);
  expect(r.timer).toMatchObject({taskStartTime:T0,blockStartTime:T0,running:true});
  expect(r.entries).toHaveLength(1);
  expect(r.entries[0]).toMatchObject({deleted:true,tsStart:T0,ts:T0+10*MIN});
  expect(r.entries[0]._csWrite.operationId).toBe(after.record.history[0].id);
  expect(sent).toHaveLength(1);
  await expect(page.locator('#time-ack-status')).toBeHidden();
  await page.evaluate(ts=>window.__setNow(ts),T0+15*MIN);
  await page.evaluate(()=>stopAndLog());
  await expect.poll(async()=>(await remote(world)).entries.filter(e=>!e.deleted).map(e=>[e.tsStart,e.ts])).toEqual([[T0,T0+15*MIN]]);
});

test('server refusal keeps Undo, cursor and server state; a later accepted Undo still works',async({page})=>{
  const world=await emulator.fresh(rules);
  await open(page,world);
  await savedSession(page,world);
  const before=await remote(world);
  // The REAL server refuses: the PATCH reaches the emulator with another account's token.
  await page.route(ackRoute,route=>{
    if(route.request().method()!=='PATCH')return route.continue();
    const u=new URL(route.request().url());u.searchParams.set('auth',token('mallory'));
    return route.continue({url:u.toString()});
  });
  await page.evaluate(()=>undoLastAction());
  await expect(page.locator('#toast')).toContainText('The server refused this Undo');
  expect(await local(page)).toMatchObject({taskStartTime:T0+10*MIN,undo:{label:'log'},live:[{tsStart:T0,ts:T0+10*MIN}]});
  expect(await remote(world)).toEqual(before);
  expect((await local(page)).record.history[0].outcome).toBe('refused');
  await page.unroute(ackRoute);
  await page.evaluate(()=>undoLastAction());
  await expect.poll(async()=>(await local(page)).taskStartTime).toBe(T0);
});

test('offline: Undo is refused before anything changes',async({page})=>{
  const world=await emulator.fresh(rules);
  await open(page,world);
  await savedSession(page,world);
  const before=await remote(world);
  await page.evaluate(()=>firebase.database().goOffline());
  await page.waitForFunction(()=>_timeAckOnline?.online===false);
  await page.evaluate(()=>undoLastAction());
  await expect(page.locator('#toast')).toContainText('You are offline');
  expect(await local(page)).toMatchObject({taskStartTime:T0+10*MIN,undo:{label:'log'},record:null});
  expect(await remote(world)).toEqual(before);
});

test('lost reply: UNKNOWN blocks Save, survives reload and reconciles to exactly one application',async({page})=>{
  const world=await emulator.fresh(rules);
  await open(page,world);
  await savedSession(page,world);
  // The server commits the PATCH, but its reply never reaches the page.
  await page.route(ackRoute,async route=>{
    if(route.request().method()!=='PATCH')return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await page.evaluate(()=>undoLastAction());
  await expect(page.locator('#time-ack-status')).toContainText('Undo not confirmed yet');
  // Unconfirmed locally: Undo is not consumed and nothing is claimed. The server DID commit, so the
  // realtime listeners converge the screen on that committed state — never on a half of it.
  expect((await local(page)).undo).toEqual({label:'log',type:'created'});
  expect((await local(page)).record.operation.phase).toBe('unknown');
  await expect.poll(async()=>{const l=await local(page);return [l.taskStartTime,l.live.length];}).toEqual([T0,0]);
  await page.evaluate(ts=>window.__setNow(ts),T0+12*MIN);
  await page.evaluate(()=>{quickLogBusy=false;_doQuickSave('Writing','deep');});
  await expect(page.locator('#toast')).toContainText('Saving is paused until your Undo is confirmed');
  expect((await local(page)).live).toHaveLength(0);
  expect((await remote(world)).entries.filter(e=>!e.deleted)).toHaveLength(0);
  page.once('dialog',dialog=>dialog.accept());
  await page.evaluate(()=>clearTodayOnly());
  await expect(page.locator('#toast')).toContainText('Clearing entries is paused until your Undo is confirmed');
  await page.unroute(ackRoute);
  await page.reload();
  await ready(page);
  await expect.poll(async()=>(await local(page)).record?.history?.[0]?.outcome).toBe('applied');
  const after=await local(page);
  expect(after).toMatchObject({running:true,taskStartTime:T0,blockStartTime:T0,live:[]});
  expect(after.record.operation).toBeNull();
  expect(after.record.history.filter(op=>op.outcome==='applied')).toHaveLength(1);
  await expect(page.locator('#time-ack-status')).toBeHidden();
  expect((await remote(world)).timer.taskStartTime).toBe(T0);
});

test('lost request: elapsed time never offers unsafe Keep original or discards UNKNOWN',async({page})=>{
  const world=await emulator.fresh(rules);
  await open(page,world);
  await savedSession(page,world);
  const before=await remote(world);
  await page.route(ackRoute,route=>route.request().method()==='PATCH'?route.abort('failed'):route.continue());
  await page.evaluate(()=>undoLastAction());
  const status=page.locator('#time-ack-status');
  await expect(status).toContainText('Undo not confirmed yet');
  await status.getByRole('button',{name:'Check now'}).click();
  await expect(status).toContainText('The server still has your original time');
  await expect(status.getByRole('button',{name:'Keep original'})).toHaveCount(0);
  await page.evaluate(ts=>window.__setNow(ts),T0+10*MIN+3*MIN);
  await page.evaluate(()=>timeAckUserAction('abandon'));
  await expect(status).toBeVisible();
  expect(await remote(world)).toEqual(before);
  const after=await local(page);
  expect(after).toMatchObject({taskStartTime:T0+10*MIN,undo:{label:'log'}});
  expect(after.record.operation.phase).toBe('unknown');
  expect(after.record.history).toEqual([]);
});

test('lost request: Retry sends the identical operation and applies once',async({page})=>{
  const world=await emulator.fresh(rules);
  await open(page,world);
  await savedSession(page,world);
  await page.route(ackRoute,route=>route.request().method()==='PATCH'?route.abort('failed'):route.continue());
  await page.evaluate(()=>undoLastAction());
  const status=page.locator('#time-ack-status');
  await status.getByRole('button',{name:'Check now'}).click();
  await expect(status.getByRole('button',{name:'Retry Undo'})).toBeVisible();
  const staged=(await local(page)).record.operation;
  expect(await page.evaluate(()=>startBreak(5))).toBe(false);
  await expect(page.locator('#toast')).toContainText('Starting a break is paused until your Undo is confirmed');
  expect(await page.evaluate(()=>({running,breakActive}))).toEqual({running:true,breakActive:false});
  // A frame that moved on (e.g. a listener delivered a newer copy of the record) is never retried.
  await page.evaluate(()=>{window.__heldEntry=entries.find(e=>!e.deleted);window.__heldEntry.note='changed';});
  await status.getByRole('button',{name:'Retry Undo'}).click();
  await expect(page.locator('#toast')).toContainText('it was not retried');
  expect((await local(page)).record.operation.attempts).toBe(1);
  await page.evaluate(()=>{delete window.__heldEntry.note;});
  await page.unroute(ackRoute);
  await status.getByRole('button',{name:'Retry Undo'}).click();
  await expect(status).toBeHidden();
  const after=await local(page);
  expect(after).toMatchObject({taskStartTime:T0,undo:null});
  expect(after.record.history[0]).toMatchObject({id:staged.id,outcome:'applied',attempts:2});
  expect(after.record.history[0].patch).toEqual(staged.patch);
});

test('two tabs: the barrier holds in the other tab and the Undo is applied exactly once',async({context})=>{
  const world=await emulator.fresh(rules);
  const a=await context.newPage();
  await open(a,world);
  await savedSession(a,world);
  const b=await context.newPage();
  await open(b,world,{fresh:false});
  let release;const held=new Promise(resolve=>{release=resolve;});
  await a.route(ackRoute,async route=>{if(route.request().method()==='PATCH')await held;return route.continue();});
  const undo=a.evaluate(()=>undoLastAction());
  await expect.poll(async()=>(await local(a)).record?.operation?.phase).toBe('pending');
  await expect(b.locator('#time-ack-status')).toContainText('Confirming Undo');
  await b.evaluate(()=>deleteEntry(entries.find(e=>!e.deleted).id));
  await expect(b.locator('#toast')).toContainText('Deleting is paused until your Undo is confirmed');
  release();
  await undo;
  await expect.poll(async()=>(await local(a)).taskStartTime).toBe(T0);
  await expect(b.locator('#time-ack-status')).toBeHidden();
  const record=(await local(b)).record;
  expect(record.history.filter(op=>op.outcome==='applied')).toHaveLength(1);
  expect(record.operation).toBeNull();
  await expect.poll(async()=>(await remote(world)).entries.filter(e=>!e.deleted)).toHaveLength(0);
});
