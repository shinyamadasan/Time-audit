// Integrated production coordinator, real SDK and loopback-only RTDB emulator.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';
import { acknowledgedUndo, holdEvaluates, retainedAccountingResult } from './accounting-retained-action.js';

holdEvaluates(test);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = readFileSync(path.join(root, 'firebase.rules.json'), 'utf8');
const allowed = new Set([...computeClosure({ rootDir: root }).files, 'sw.js']);
const beforeFixture = process.env.CHRONASENSE_ACCOUNTING_RUNTIME_FIXTURE
  ? path.resolve(root, process.env.CHRONASENSE_ACCOUNTING_RUNTIME_FIXTURE) : null;
if (beforeFixture && !beforeFixture.startsWith(path.join(root, 'test-results') + path.sep)) throw Error('Before fixture must be inside local test-results');
const runtimeSnapshots = new Map([...allowed].map(file => [file, readFileSync(
  beforeFixture && existsSync(path.join(beforeFixture, file)) ? path.join(beforeFixture, file) : path.join(root, file))]));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const manifest = { test: sha256(readFileSync(fileURLToPath(import.meta.url))), rules: sha256(rules),
  files: Object.fromEntries([...runtimeSnapshots].map(([file, body]) => [file, sha256(body)])) };
const MIN = 60000, T0 = Date.parse('2026-10-28T16:00:00Z');
let emulator, server, url;
function proofEndpoint(value) {
  const parsed = new URL(value);
  return ['127.0.0.1', 'localhost'].includes(parsed.hostname)
    && [String(emulator?.port), url && new URL(url).port].includes(parsed.port);
}

test.use({ serviceWorkers: 'block' });
test.beforeAll(async ({}, info) => {
  await info.attach('exact-runtime-manifest', { contentType: 'application/json', body: JSON.stringify(manifest, null, 2) });
  emulator = await startEmulator();
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
    if (!allowed.has(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream' });
    response.end(runtimeSnapshots.get(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); emulator?.stop(); });
test.beforeEach(async ({ context, page }) => {
  page.on('pageerror', error => console.error('[runtime-pageerror]', error.message));
  await context.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
});

async function open(page, world, uid, device = 'proof-device', waitForOnline = true) {
  for (const name of ['app', 'database']) await page.route(`https://www.gstatic.com/firebasejs/10.12.2/firebase-${name}-compat.js`, route => route.fulfill({
    contentType: 'text/javascript', body: readFileSync(path.join(root, `node_modules/firebase/firebase-${name}-compat.js`), 'utf8') }));
  const config = { databaseURL: `${emulator.base}?ns=${world.name}`, projectId: 'demo-unknown-recovery' };
  await page.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js', route => route.fulfill({ contentType: 'text/javascript', body: `(()=>{
    const initialize=firebase.initializeApp.bind(firebase),app=initialize(${JSON.stringify(config)});firebase.initializeApp=()=>app;
    app.database().useEmulator('127.0.0.1',${emulator.port},{mockUserToken:${JSON.stringify(token(uid))}});
    app.database().INTERNAL.forceWebSockets();
    if (localStorage.getItem('__proof-offline-sdk') === '1') app.database().goOffline();
    const tokens=${JSON.stringify({alice:token('alice'),bob:token('bob')})};
    const userFor=uid=>({uid,displayName:'Local proof',email:'proof@example.invalid',getIdToken:()=>Promise.resolve(tokens[uid])});
    let callback,sequence=0;const auth={currentUser:userFor(${JSON.stringify(uid)}),onAuthStateChanged:fn=>{callback=fn;setTimeout(()=>fn(auth.currentUser),0);return()=>{};},signOut:async()=>{auth.currentUser=null;callback(null);}};
    firebase.auth=()=>auth;
    window.__selectProofAccount=uid=>{
      fbDb.goOffline();
      const next=initialize(${JSON.stringify(config)},'account-proof-'+(++sequence)).database();next.useEmulator('127.0.0.1',${emulator.port},{mockUserToken:tokens[uid]});next.INTERNAL.forceWebSockets();
      fbDb=next;auth.currentUser=userFor(uid);callback(auth.currentUser);
    };
    firebase.auth.GoogleAuthProvider=class{};firebase.auth.GoogleAuthProvider.credential=()=>({});
  })();` }));
  await page.addInitScript(({ T0, uid, device }) => {
    if (location.protocol !== 'http:') return;
    const RealDate = Date, now = () => Number(localStorage.getItem('__proof-now')) || T0;
    window.__setNow = ts => localStorage.setItem('__proof-now', String(ts));
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } };
    sessionStorage.setItem('ta3-session-started', '1');
    if (!localStorage.getItem('__proof-seeded')) {
      localStorage.setItem('__proof-seeded', '1'); localStorage.setItem('__proof-now', String(T0));
      localStorage.setItem('ta3-onboarded', '1'); localStorage.setItem('ta3-device-id', device);
      localStorage.setItem(`ta3-settings:uid_${uid}`, JSON.stringify({ timezone: 'America/Phoenix', intervalMin: 30, sleepSetupDone: true, presets: [], templates: [] }));
      localStorage.setItem(`ta3-tz:uid_${uid}`, 'America/Phoenix');
    }
  }, { T0, uid, device });
  await page.goto(url);
  await page.waitForFunction(({owner, online}) => globalThis.getChronaSenseRoomCode?.() === owner && (!online || typeof _timeAckOnline !== 'undefined' && _timeAckOnline?.online), {owner: `uid_${uid}`, online: waitForOnline});
}
const remote = async (world, uid) => ({ timer: await world.read(`rooms/uid_${uid}/timer`), entries: Object.values(await world.read(`rooms/uid_${uid}/entries`) || {}) });
async function saved(page, world, uid, activity = 'Writing', energy = 'deep') {
  await page.evaluate(label => _startTimer(label), activity);
  await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
  await page.evaluate(({ activity, energy }) => { quickLogBusy = false; return _doQuickSave(activity, energy); }, { activity, energy });
  await expect.poll(async () => (await remote(world, uid)).timer?.taskStartTime).toBe(T0 + 10 * MIN);
  await expect.poll(async () => (await remote(world, uid)).entries.filter(e => !e.deleted).length).toBe(1);
}


async function pinned(page, world) {
  await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4);
  const response = await fetch(`${emulator.base}/.settings/rules.json?ns=${world.name}`, {
    method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules,
  });
  expect(response.status).toBe(200);
  await page.evaluate(async () => {
    await accountingCoordinator().drain();
  });
}

// Missing mandatory G1/G2/G8 bootstrap and cross-mode guard scenarios. No old assertion is rewritten.
for (const uid of ['alice', 'bob']) {
  for (const kind of ['timer', 'away', 'break', 'entries', 'redemptions']) {
    test(`${uid}: G8 legacy ${kind} without canonical envelope stays unconfirmed offline and retains exact source`, async ({page}, info) => {
      const world = await emulator.fresh(rules);
      const source = {
        timer: ['ta3-timer', { running:true, timerStartedAt:T0, totalSecs:1800, currentTask:'Legacy work', lastTask:'Legacy work', taskStartTime:T0, blockStartTime:T0, ownerDeviceId:'proof-device' }],
        away: ['ta3-away-state', {active:true, startedAt:T0, label:'Legacy away'}],
        break: ['ta3-break-state', {active:true, startedAt:T0, endsAt:T0+5*MIN, durationMin:5, startedBy:'proof-device', timerOwnerDeviceId:'proof-device', currentTask:'Legacy work', lastTask:'Legacy work', totalSecs:1800, remaining:1800}],
        entries: ['ta3-entries', [{id:88,tsStart:T0-MIN,ts:T0,blockIntervalMin:1,date:'2026-10-28',activity:'Legacy actual',energy:'deep',onPlan:true}]],
        redemptions: ['ta3-focus-redemptions', [{id:'legacy-reward',ts:T0,label:'Legacy reward',points:5}]]
      }[kind];
      const raw=JSON.stringify(source[1]);
      await page.addInitScript(({uid,base,raw,T0})=>{
        if(location.protocol!=='http:')return;
        if(!localStorage.getItem('__legacy-seeded')){
          localStorage.setItem('__legacy-seeded','1');localStorage.setItem('__proof-offline-sdk','1');
          localStorage.setItem(`${base}:uid_${uid}`,raw);localStorage.setItem(`ta3-heartbeat-ts:uid_${uid}`,String(T0));
        }
      },{uid,base:source[0],raw,T0});
      await page.route(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`,route=>route.abort('failed'));
      await open(page,world,uid,'proof-device',false);
      const actual=await page.evaluate(base=>({running,awayActive,breakActive,entries:cloneUndoValue(entries),redemptions:cloneUndoValue(focusRedemptions),
        committed:accountingCoordinator().snapshot().committed,raw:localStorage.getItem(accountLocalKey(base)),heartbeat:localStorage.getItem(accountLocalKey('ta3-heartbeat-ts'))}),source[0]);
      await info.attach('bootstrap-proof',{contentType:'application/json',body:JSON.stringify({kind,raw,actual})});
      expect(actual).toMatchObject({running:false,awayActive:false,breakActive:false,entries:[],redemptions:[],committed:null});
      expect(actual.raw).toBe(raw);expect(actual.heartbeat).toBe(String(T0));
      expect((await remote(world,uid)).timer).toBeNull();expect((await remote(world,uid)).entries).toEqual([]);
      const newer={running:false,stopped:true,ownerRoom:`uid_${uid}`,ownerDeviceId:'peer-device',updatedAt:T0+MIN,lastTask:'Newer coherent stop',
        _csWrite:{v:1,protocol:'staged-command-v1',revision:1,baseRevision:0,baseExists:false,operationId:'newer_server_stop'}};
      const confirmed={id:902,tsStart:T0,ts:T0+MIN,updatedAt:T0+MIN,blockIntervalMin:1,date:'2026-10-28',activity:'Newer server fact',energy:'deep'};
      await world.seed(`rooms/uid_${uid}/timer`,newer);await world.seed(`rooms/uid_${uid}/entries/e_902`,confirmed);
      await page.unroute(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`);await page.evaluate(()=>{localStorage.removeItem('__proof-offline-sdk');fbDb.goOnline();});
      await page.waitForFunction(()=>window._accountingSourcesSeen?.size===4&&_timeAckOnline?.online);await pinned(page,world);await page.evaluate(()=>requestAccountingRefresh());
      await expect.poll(()=>page.evaluate(()=>entries.map(row=>row.id))).toEqual([902]);
      expect(await page.evaluate(()=>({running,awayActive,breakActive}))).toEqual({running:false,awayActive:false,breakActive:false});
      expect(await page.evaluate(({base,raw})=>accountingCoordinator().snapshot().queue.some(op=>op.input.name==='legacy-accounting-caches'&&op.input.source?.[base]===raw),{base:source[0],raw})).toBe(true);
      expect((await remote(world,uid)).timer).toEqual(newer);expect((await remote(world,uid)).entries).toEqual([confirmed]);

    });
  }

  for (const fault of ['read', 'quota', 'readback', 'version', 'malformed']) {
    test(`${uid}: G1 no-envelope bootstrap ${fault} failure never exposes cached facts as confirmed`,async({page},info)=>{
      const world=await emulator.fresh(rules),raw=JSON.stringify([{id:89,tsStart:T0-MIN,ts:T0,blockIntervalMin:1,date:'2026-10-28',activity:'Unconfirmed bootstrap fact',energy:'deep',onPlan:true}]);
      await page.addInitScript(({uid,raw,T0,fault})=>{
        if(location.protocol!=='http:')return;
        localStorage.setItem('__proof-offline-sdk','1');localStorage.setItem(`ta3-entries:uid_${uid}`,raw);localStorage.setItem(`ta3-heartbeat-ts:uid_${uid}`,String(T0));
        if(fault==='version')localStorage.setItem(`ta3-accounting-state-v1:uid_${uid}`,JSON.stringify({v:99,owner:`uid_${uid}`,generation:0,committed:null,queue:[],history:[]}));
        if(fault==='malformed')localStorage.setItem(`ta3-accounting-state-v1:uid_${uid}`,'{ original unreadable envelope');
        const read=Storage.prototype.getItem,write=Storage.prototype.setItem,written=new Set();let reads=0;
        Storage.prototype.getItem=function(key){
          if(fault==='read'&&key===`ta3-entries:uid_${uid}`&&++reads===2)throw Error('Bootstrap source read failed');
          if(fault==='readback'&&written.has(key))throw Error('Bootstrap capture readback failed');
          return read.call(this,key);
        };
        Storage.prototype.setItem=function(key,value){
          if(fault==='quota'&&key.startsWith('ta3-accounting-capture-v1:'))throw Error('Bootstrap capture quota');
          const result=write.call(this,key,value);if(key.startsWith('ta3-accounting-capture-v1:'))written.add(key);return result;
        };
        window.__restoreBootstrapFault=()=>{Storage.prototype.getItem=read;Storage.prototype.setItem=write;};
      },{uid,raw,T0,fault});
      await page.route(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`,route=>route.abort('failed'));
      await open(page,world,uid,'proof-device',false);await page.evaluate(()=>window.__restoreBootstrapFault());
      const actual=await page.evaluate(()=>({entries:cloneUndoValue(entries),redemptions:cloneUndoValue(focusRedemptions),running,awayActive,breakActive,error:window._accountingLegacyLoadError,
        raw:localStorage.getItem(accountLocalKey('ta3-entries')),heartbeat:localStorage.getItem(accountLocalKey('ta3-heartbeat-ts'))}));
      await info.attach('bootstrap-failure-proof',{contentType:'application/json',body:JSON.stringify({fault,actual})});
      expect(actual).toMatchObject({entries:[],redemptions:[],running:false,awayActive:false,breakActive:false,raw,heartbeat:String(T0)});
      if(fault==='readback')expect(await page.evaluate(()=>accountingCoordinator().failedCaptures(roomCode).length)).toBeGreaterThan(0);
      else expect(actual.error).toBeTruthy();
      expect((await remote(world,uid)).entries).toEqual([]);
    });
  }

  for (const fault of ['missing', 'refused']) {
    test(`${uid}: G1 Web Lock ${fault} retains original capture and refuses confirmed apply before recovery`,async({page})=>{
      const world=await emulator.fresh(rules);await open(page,world,uid);await pinned(page,world);
      await page.evaluate(fault=>{
        const locks=navigator.locks;
        Object.defineProperty(navigator,'locks',{configurable:true,value:fault==='missing'?undefined:{request:()=>Promise.reject(Error('Lock unavailable'))}});
        window.__restoreLocks=()=>Object.defineProperty(navigator,'locks',{configurable:true,value:locks});
      },fault);
      expect(await page.evaluate(()=>_startTimer('Lock original'))).toBe(false);
      expect(await page.evaluate(()=>({running,undo:lastUndoAction,entries:entries.length}))).toEqual({running:false,undo:null,entries:0});
      const original=await page.evaluate(()=>accountingCoordinator().captures(roomCode).map(item=>item.captured).find(op=>op.input.ordinary?.kind==='start'));
      expect(original).toMatchObject({at:T0,owner:`uid_${uid}`,device:'proof-device'});expect((await remote(world,uid)).timer).toBeNull();
      await page.evaluate(async()=>{window.__restoreLocks();await timeAckUserAction('check');});
      await expect.poll(async()=>(await remote(world,uid)).timer?.startedAt).toBe(T0);
      expect((await remote(world,uid)).timer._csWrite.operationId).toBe(original.id);
    });
  }
  test(`${uid}: G1 actual browser storage supports2032 synthetic historical entries through five acknowledged Saves`,async({page},info)=>{
    // The full qualification run contends with real SDK/emulator work; this is
    // a capacity assertion, not a 90-second performance requirement.
    test.setTimeout(180000);
    const world=await emulator.fresh(rules),rows={};
    for(let n=0;n<2032;n++){
      const ts=T0-(2033-n)*MIN,id=10000+n;
      rows[`e_${id}`]={id,tsStart:ts-MIN,ts,updatedAt:ts,blockIntervalMin:1,date:new Date(ts).toISOString().slice(0,10),activity:'Synthetic history',energy:'shallow',onPlan:true,retro:true};
    }
    await world.seed(`rooms/uid_${uid}/entries`,rows);await open(page,world,uid);await pinned(page,world);
    expect(await page.evaluate(()=>entries.length)).toBe(2032);
    expect(await page.evaluate(()=>_startTimer('Capacity work'))).toBe(true);
    for(let n=1;n<=5;n++){
      await page.evaluate(at=>window.__setNow(at),T0+n*MIN);
      await page.evaluate(()=>openQuickLog());
      expect(await page.evaluate(()=>_doQuickSave('Capacity work','deep'))).toBe(true);
    }
    const stored=await world.read(`rooms/uid_${uid}/entries`);
    for(const [key,row]of Object.entries(rows))expect(stored[key]).toEqual(row);
    expect(Object.values(stored).filter(row=>row.activity==='Capacity work')).toEqual([expect.objectContaining({tsStart:T0,ts:T0+5*MIN,blockIntervalMin:5})]);
    await info.attach('capacity-result',{contentType:'application/json',body:JSON.stringify(await page.evaluate(()=>({recordCount:entries.length,historyCount:accountingCoordinator().snapshot().history.length,
      localStorageCodeUnits:Object.keys(localStorage).reduce((sum,key)=>sum+key.length+(localStorage.getItem(key)||'').length,0)})))});
  });
  test(`${uid}: G7 two original scheduled due dates both survive one UNKNOWN predecessor and template edits`,async({page})=>{
    const world=await emulator.fresh(rules);await open(page,world,uid);await pinned(page,world);
    const pattern=`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;await page.route(pattern,route=>route.request().method()==='PATCH'?route.abort('failed'):route.continue());
    await page.evaluate(()=>{
      settings.templates=[{id:'two-dates',enabled:true,autoLog:true,days:[2,3],startTime:'07:00',endTime:'08:00',activity:'Original scheduled',energy:'nine5'}];
      window.__scheduled=autoLogDueTemplates({notify:false});
    });
    await expect.poll(()=>page.evaluate(()=>[...accountingCoordinator().snapshot().queue,...accountingCoordinator().captures(roomCode).map(item=>item.captured)].filter(op=>op.input.name==='scheduled-log').length)).toBe(2);
    const original=await page.evaluate(()=>[...accountingCoordinator().snapshot().queue,...accountingCoordinator().captures(roomCode).map(item=>item.captured)].filter(op=>op.input.name==='scheduled-log').map(op=>({id:op.id,entry:op.input.observation.facts.entry})));
    expect(original.map(op=>op.entry.id).sort()).toEqual(['tpllog_two-dates_2026-10-27','tpllog_two-dates_2026-10-28']);
    await page.evaluate(()=>{settings.templates[0].activity='Edited after capture';settings.templates[0].startTime='06:00';persist();});
    await page.unroute(pattern);await page.reload();await page.waitForFunction(()=>accountingIdentity());await pinned(page,world);await page.evaluate(()=>timeAckUserAction('check'));
    const stored=(await remote(world,uid)).entries.filter(row=>row.templateId==='two-dates');expect(stored).toHaveLength(2);
    for(const op of original)expect(stored.find(row=>row.id===op.entry.id)).toEqual({...op.entry,_csWrite:expect.objectContaining({operationId:op.id})});
  });

  for(const writer of ['quick-retro','same-as-last','common','sleep','cleanup','duplicates','flagged','bulk-category','focus-skip','focus-enter','deep-start','deep-quicklog','reset']){
    test(`${uid}: G2 missing writer ${writer} holds its original local delta until ACK and survives reload once`,async({page},info)=>{
      const world=await emulator.fresh(rules);
      const first={id:77,tsStart:T0-10*MIN,ts:T0-5*MIN,updatedAt:T0,blockIntervalMin:5,date:'2026-10-28',activity:'Existing work',energy:'deep',onPlan:true};
      const second={...first,id:78,tsStart:writer==='duplicates'?first.tsStart:T0-20*MIN,ts:writer==='duplicates'?first.ts:T0-15*MIN};
      if(writer==='flagged'){first.tsStart=T0+3*86400000;first.ts=first.tsStart+5*MIN;}
      await world.seed(`rooms/uid_${uid}/entries`,{77:first,e_78:second});await open(page,world,uid);await pinned(page,world);page.on('dialog',dialog=>dialog.accept());
      if(['focus-enter','deep-start','deep-quicklog','reset'].includes(writer))expect(await page.evaluate(()=>_startTimer('Original ordinary'))).toBe(true);
      if(writer==='focus-skip'){
        expect(await page.evaluate(()=>enterFocusMode({task:'Skip original',workMinutes:5,autoStart:true}))).toBe(true);
        await page.evaluate(at => window.__setNow(at), T0+5*MIN); expect(await retainedAccountingResult(page, 'focus-end-work')).toBe(true);
      }
      await page.evaluate(({writer,at})=>{
        window.__setNow(at);
        if(writer==='cleanup'){
          activityCleanupGroupsCache=[{key:activityGroupKey('Existing work'),canonical:'Renamed work',variants:[]}];
          const input=document.createElement('input');input.id='activity-cleanup-input-0';input.value='Renamed work';document.body.append(input);
        }
        if(writer==='bulk-category'){openEditEntry(77);retroEnergy='recovery';document.getElementById('retro-activity').focus();}
      },{writer,at:T0+10*MIN});
      const pattern=`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;let release,submitted=false,patches=0;const held=new Promise(resolve=>{release=resolve;});
      await page.route(pattern,async route=>{
        if(route.request().method()!=='PATCH')return route.continue();
        patches++;if(writer==='bulk-category'&&patches===1)return route.continue();
        const response=await route.fetch();submitted=true;await held;await route.fulfill({response});
      });
      try{
        await page.evaluate(({writer,at,MIN})=>{
          if(writer==='quick-retro')document.getElementById('retro-task').value='New retro';
          const actions={'quick-retro':quickRetroLog,'same-as-last':quickLogSameAsLast,common:()=>logCommonActivity('Common original','recovery',5),
            sleep:()=>logSleepEntry(at-8*60*MIN,at),cleanup:()=>applyActivityCleanup(0),duplicates:repairDataDoctorDuplicates,flagged:repairDataDoctorFlaggedEntries,
            'bulk-category':saveRetroEntry,'focus-skip':skipBreak,'focus-enter':()=>enterFocusMode({task:'New Focus',workMinutes:25,autoStart:true}),
            'deep-start':()=>handleDeepLink('chronasense://start?task=Deep+link+original'),'deep-quicklog':()=>handleDeepLink('chronasense://quicklog?task=Original+ordinary&energy=deep'),reset:resetTimer};
          window.__closureWriter={promise:Promise.resolve(actions[writer]())};window.__closureWriter.promise.then(result=>{window.__closureWriter.outcome={done:true,result};},error=>{window.__closureWriter.outcome={error:error.message};});
        },{writer,at:T0+10*MIN,MIN});
        try{await expect.poll(()=>submitted).toBe(true);}catch(error){
          await info.attach('missing-writer-state',{contentType:'application/json',body:JSON.stringify(await page.evaluate(()=>({state:accountingCoordinator().snapshot(),outcome:window.__closureWriter.outcome,toast:document.getElementById('toast')?.textContent})))});throw error;
        }
        const op=await page.evaluate(()=>accountingCoordinator().snapshot().queue.find(op=>op.phase==='pending'));
        const live=await page.evaluate(()=>captureAccountingFrame());
        for(const field of ['running','taskStartTime','blockStartTime','timerOwnerDeviceId','focus','awayActive','breakActive','lastUndoAction'])expect(live[field]).toEqual(op.input.before[field]);
        for(const change of op.input.records){if(change.store==='entries')expect(live.entries.find(row=>row.id===change.id)||null).toEqual(change.before);}
        release();await expect.poll(()=>page.evaluate(()=>window.__closureWriter.outcome?.done)).toBe(true);expect(await page.evaluate(()=>window.__closureWriter.outcome.error)).toBeUndefined();
        const receipt=await page.evaluate(id=>accountingCoordinator().snapshot().history.find(item=>item.id===id),op.id);expect(receipt.phase).toBe('local-applied');expect(receipt.proposal.patch).toEqual(op.proposal.patch);
        const beforeReload=await remote(world,uid);
        for(const [path,row]of Object.entries(op.proposal.patch))if(path.startsWith('entries/'))expect(await world.read(`rooms/uid_${uid}/${path}`)).toEqual(row);
        await page.reload();await page.waitForFunction(()=>accountingIdentity());await pinned(page,world);expect(await remote(world,uid)).toEqual(beforeReload);
        expect(await page.evaluate(id=>accountingCoordinator().snapshot().history.filter(item=>item.id===id).length,op.id)).toBe(1);
      }finally{release();await page.unroute(pattern);}
    });
  }

  for(const point of ['before-capture','after-capture','after-import','after-intake-removal','after-seal','after-pending','after-server-commit','after-accepted-save','after-local-receipt','mid-cache']){
    test(`${uid}: G1 renderer termination ${point} preserves the durable boundary and once-only original Save`,async({page,context})=>{
      const world=await emulator.fresh(rules);await open(page,world,uid);await pinned(page,world);expect(await page.evaluate(()=>_startTimer('Kill original'))).toBe(true);
      await page.evaluate(at=>window.__setNow(at),T0+10*MIN);
      let committed=false;const pattern=`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
      if(point==='after-server-commit')await page.route(pattern,async route=>{
        if(route.request().method()!=='PATCH')return route.continue();await route.fetch();committed=true;await new Promise(()=>{});
      });
      await page.evaluate(({point,uid})=>{
        const write=Storage.prototype.setItem,remove=Storage.prototype.removeItem,read=Storage.prototype.getItem,lock=navigator.locks.request.bind(navigator.locks);
        const stateKey=`${AccountingCommand.BASE}:uid_${uid}`,intake=`${AccountingCommand.INTAKE}:uid_${uid}:`;
        let hit=false;
        const interrupt=()=>{hit=true;window.__killReached=point;throw Error(`Deliberate boundary stop ${point}`);};
        navigator.locks.request=(...args)=>hit?new Promise(()=>{}):lock(...args);
        Storage.prototype.setItem=function(key,value){
          if(hit&&key===stateKey)throw Error('Hold boundary until actual renderer termination');
          const record=key.startsWith(intake)?JSON.parse(value):null;
          if(point==='before-capture'&&record?.input?.name==='quick-save')return interrupt();
          const result=write.call(this,key,value);
          if(key===stateKey){
            const state=JSON.parse(value),op=state.queue.find(op=>op.input.name==='quick-save');
            const phases={'after-import':'captured','after-seal':'sealed','after-pending':'pending','after-accepted-save':'accepted'};
            if(phases[point]&&op?.phase===phases[point])interrupt();
            if(point==='after-local-receipt'&&state.committed?.effectName==='quick-save')interrupt();
          }
          if(point==='mid-cache'&&key===`ta3-entries:uid_${uid}`&&JSON.parse(read.call(this,stateKey)).committed?.effectName==='quick-save')interrupt();
          return result;
        };
        Storage.prototype.getItem=function(key){const value=read.call(this,key);
          if(point==='after-capture'&&!hit&&key.startsWith(intake)&&value&&JSON.parse(value).input?.name==='quick-save'){hit=true;window.__killReached=point;}
          return value;
        };
        Storage.prototype.removeItem=function(key){const original=read.call(this,key),result=remove.call(this,key);
          if(point==='after-intake-removal'&&key.startsWith(intake)&&original&&JSON.parse(original).input?.name==='quick-save')interrupt();return result;
        };
        window.__killOperation={promise:_doQuickSave('Kill original','deep')};window.__killOperation.promise.catch(()=>{});
      },{point,uid});
      if(point==='after-server-commit')await expect.poll(()=>committed).toBe(true);
      else await expect.poll(()=>page.evaluate(()=>window.__killReached)).toBe(point);
      const original=await page.evaluate(()=>{const c=accountingCoordinator(),state=c.snapshot();return [...state.queue,...state.history,...c.captures(roomCode).map(item=>item.captured),...c.failedCaptures(roomCode)].find(op=>op.input.name==='quick-save');});
      expect(original).toBeTruthy();expect(original.at).toBe(T0+10*MIN);
      const session=await context.newCDPSession(page);const crashed=page.waitForEvent('crash');session.send('Page.crash').catch(()=>{});await crashed;await page.close();
      const restored=await context.newPage();await open(restored,world,uid);await pinned(restored,world);await restored.evaluate(()=>timeAckUserAction('check'));
      const actual=await remote(world,uid);
      if(point==='before-capture'){
        expect(actual.entries).toEqual([]);expect(actual.timer.taskStartTime).toBe(T0); // no pre-capture durability promise
      }else{
        expect(actual.entries).toEqual([expect.objectContaining({tsStart:T0,ts:T0+10*MIN,blockIntervalMin:10,_csWrite:expect.objectContaining({operationId:original.id})})]);
        expect(actual.timer.taskStartTime).toBe(T0+10*MIN);
        const receipt=await restored.evaluate(id=>accountingCoordinator().snapshot().history.filter(op=>op.id===id),original.id);expect(receipt).toHaveLength(1);
        if(original.proposal)expect(receipt[0].proposal).toEqual(original.proposal);
        expect(await restored.evaluate(()=>lastUndoAction?.accountingReceipt.operationId)).toBe(original.id);
      }
      await restored.close();
    });
  }

  for(const point of ['query-await','result-write','result-readback','watermark-receipt']){
    test(`${uid}: G7 renderer termination native ${point} retains original range result and acknowledged watermark`,async({page,context})=>{
      const world=await emulator.fresh(rules);await open(page,world,uid);await pinned(page,world);
      await page.evaluate(({point,at,MIN})=>{
        window.__setNow(at+10*MIN);const write=Storage.prototype.setItem,read=Storage.prototype.getItem,lock=navigator.locks.request.bind(navigator.locks);let hit=false;
        navigator.locks.request=(...args)=>hit?new Promise(()=>{}):lock(...args);
        Storage.prototype.setItem=function(key,value){
          if(hit&&key.startsWith(`${AccountingCommand.BASE}:`))throw Error('Hold native boundary');
          const result=write.call(this,key,value);
          if(!hit&&(point==='result-write'&&key.includes(':result:')||point==='watermark-receipt'&&key===`${AccountingCommand.BASE}:${roomCode}`&&JSON.parse(value).committed?.effectName==='native-usage')){
            hit=true;window.__nativeKill=point;throw Error('Deliberate native boundary stop');
          }return result;
        };
        Storage.prototype.getItem=function(key){const value=read.call(this,key);if(!hit&&point==='result-readback'&&key.includes(':result:')&&value){hit=true;window.__nativeKill=point;}return value;};
        window.__nativeJob={promise:syncPhoneUsage({queryEvents:async request=>{
          window.__originalNativeRequest=request;
          if(point==='query-await'){window.__nativeKill=point;return new Promise(()=>{});}
          return {events:[{pkg:'com.instagram.android',type:1,ts:at},{pkg:'com.instagram.android',type:2,ts:at+3*MIN}]};
        }})};window.__nativeJob.promise.catch(()=>{});
      },{point,at:T0,MIN});
      await expect.poll(()=>page.evaluate(()=>window.__nativeKill)).toBe(point);
      const original=await page.evaluate(()=>phoneUsageSources(accountingCoordinator(),roomCode).find(op=>op.input.name==='native-usage'));
      expect(original).toBeTruthy();expect(original.at).toBe(T0+10*MIN);
      const cdp=await context.newCDPSession(page),crashed=page.waitForEvent('crash');cdp.send('Page.crash').catch(()=>{});await crashed;await page.close();
      const restored=await context.newPage();await open(restored,world,uid);await pinned(restored,world);
      if(point==='query-await'){
        expect(await restored.evaluate(async({at,MIN})=>{
          window.__setNow(at+86400000);return syncPhoneUsage({queryEvents:async request=>{window.__recoveredNativeRequest=request;return {events:[{pkg:'com.instagram.android',type:1,ts:at},{pkg:'com.instagram.android',type:2,ts:at+3*MIN}]};}});
        },{at:T0,MIN})).toBe(true);
        expect(await restored.evaluate(()=>window.__recoveredNativeRequest)).toEqual(original.input.observation.facts.query);
      }else await restored.evaluate(()=>accountingCoordinator().drain());
      expect((await remote(world,uid)).entries).toEqual([expect.objectContaining({id:T0,tsStart:T0,ts:T0+3*MIN,phoneUsage:true})]);
      expect(await restored.evaluate(()=>captureAccountingFrame().phoneUsage.devices['proof-device'].endTime)).toBe(T0+10*MIN);
      const accepted=await restored.evaluate(id=>accountingCoordinator().snapshot().history.filter(op=>op.id===id),original.id);expect(accepted).toHaveLength(1);expect(accepted[0].input).toEqual(original.input);
      await restored.close();
    });
  }

  for(const kind of ['numeric','e','identical','contradictory','type','tombstone','metadata','key']){
    test(`${uid}: G3 actual app ${kind} physical source edits or retains every original without alias migration`,async({page})=>{
      const world=await emulator.fresh(rules),record={id:77,tsStart:T0-5*MIN,ts:T0,updatedAt:T0,blockIntervalMin:5,date:'2026-10-28',activity:'Writing',energy:'deep',onPlan:true};
      const raw=kind==='e'?{e_77:record}:kind==='numeric'?{77:record}:kind==='key'?{weird_77:record}:kind==='metadata'?{77:{...record,_csWrite:{v:1,revision:1}}}:
        {77:record,e_77:kind==='contradictory'?{...record,activity:'Conflicting original'}:kind==='type'?{...record,id:'77'}:kind==='tombstone'?{...record,deleted:true,updatedAt:T0+MIN}:record};
      await world.seed(`rooms/uid_${uid}/entries`,raw);await open(page,world,uid);await pinned(page,world);
      if(['numeric','e','identical'].includes(kind)){
        expect(await page.evaluate(()=>entries.length)).toBe(1);
        await page.evaluate(at=>{window.__setNow(at);openEditEntry(77);const input=document.getElementById('retro-activity');input.focus();input.value='Edited Writing';},T0+MIN);
        await page.evaluate(()=>{window.__physicalEdit={promise:saveRetroEntry()};window.__physicalEdit.promise.then(value=>{window.__physicalEdit.value=value;});});
        await expect.poll(async()=>page.evaluate(()=>accountingCoordinator().snapshot().history.find(op=>op.input.name==='retro-edit')?.phase)).toBe('local-applied');
        await expect.poll(async()=>(await remote(world,uid)).entries.find(row=>row.id===77)).toMatchObject({activity:'Edited Writing',_csWrite:{revision:1}});
        await page.evaluate(at=>window.__setNow(at),T0+2*MIN);expect(await page.evaluate(()=>deleteEntry(77))).toBe(true);
        await page.evaluate(at=>window.__setNow(at),T0+3*MIN);expect(await acknowledgedUndo(page)).toBe(true);
        const after=await world.read(`rooms/uid_${uid}/entries`);expect(Object.keys(after).sort()).toEqual(Object.keys(raw).sort());
        for(const row of Object.values(after))expect(row).toMatchObject({id:77,activity:'Edited Writing',tsStart:T0-5*MIN,ts:T0,blockIntervalMin:5,undoRestoredAt:T0+3*MIN,_csWrite:{revision:3}});
        expect(Object.values(after).some(row=>row.deleted)).toBe(false);expect(await page.evaluate(()=>entries.length)).toBe(1);
      }else{
        expect(await page.evaluate(()=>_doQuickSave('Writing','deep'))).not.toBe(true);
        expect(await world.read(`rooms/uid_${uid}/entries`)).toEqual(raw);
        await expect(page.locator('#time-ack-status')).toBeVisible();
        expect(await page.evaluate(()=>accountingCoordinator().snapshot().history.some(op=>op.input.name==='quick-save'))).toBe(false);
      }
    });
  }
  test(`${uid}: G5 all original postimages overwritten after lost ACK retain UNKNOWN with immutable proposal`,async({page})=>{
    const world=await emulator.fresh(rules);await open(page,world,uid);await pinned(page,world);expect(await page.evaluate(()=>_startTimer('Overwrite source'))).toBe(true);
    await page.evaluate(at=>window.__setNow(at),T0+10*MIN);
    let release,committed=false;const held=new Promise(resolve=>{release=resolve;}),pattern=`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern,async route=>{if(route.request().method()!=='PATCH')return route.continue();await route.fetch();committed=true;await held;await route.abort('failed');});
    await page.evaluate(()=>{window.__allOverwrite={promise:_doQuickSave('Overwrite source','deep')};window.__allOverwrite.promise.then(result=>{window.__allOverwrite.result=result;});});
    try{
      await expect.poll(()=>committed).toBe(true);const original=await page.evaluate(()=>accountingCoordinator().snapshot().queue.find(op=>op.input.name==='quick-save'));
      const newer=await page.evaluate(({patch,at})=>Object.fromEntries(Object.entries(patch).map(([path,row])=>{
        const value={...row,updatedAt:at};if(path==='timer'){value.running=false;value.stopped=true;value.ownerDeviceId='peer-device';}
        if(path.startsWith('entries/'))value.activity='Peer authoritative edit';
        const stamped=TimeAckCore.stamp(row,value,'peer_all_overwrite');stamped._csWrite.protocol='staged-command-v1';return [path,stamped];
      })),{patch:original.proposal.patch,at:T0+86400000});
      expect(await world.patch(`rooms/uid_${uid}`,newer,token(uid))).toBe(true);release();
      await expect.poll(()=>page.evaluate(()=>window.__allOverwrite.result)).toBe(false);
      await page.unroute(pattern);await page.evaluate(()=>timeAckUserAction('check'));
      const retained=await page.evaluate(id=>accountingCoordinator().snapshot().queue.find(op=>op.id===id),original.id);expect(retained).toBeTruthy();expect(retained.proposal).toEqual(original.proposal);
      expect(await page.evaluate(id=>accountingCoordinator().snapshot().history.some(op=>op.id===id&&op.phase==='local-applied'),original.id)).toBe(false);
      for(const [path,row]of Object.entries(newer))expect(await world.read(`rooms/uid_${uid}/${path}`)).toEqual(row);
      await expect(page.locator('#time-ack-status')).toBeVisible();
    }finally{release();await page.unroute(pattern);}
  });

  for(const mode of ['timer','away','break']){
    test(`${uid}: G4 direct auth ${mode} A-B-A uses real SDK account rooms without confirmed/cache leakage`,async({page})=>{
      const world=await emulator.fresh(rules),other=uid==='alice'?'bob':'alice';await open(page,world,uid);await pinned(page,world);
      expect(await page.evaluate(()=>_startTimer('Private first account'))).toBe(true);
      if(mode==='away')expect(await page.evaluate(()=>startAway('Private first away'))).toBe(true);
      if(mode==='break')expect(await page.evaluate(()=>startBreak(5))).toBe(true);
      const first=await remote(world,uid);
      await world.seed(`rooms/uid_${other}/entries/e_901`,{id:901,tsStart:T0-MIN,ts:T0,updatedAt:T0,blockIntervalMin:1,date:'2026-10-28',activity:'Private second account',energy:'deep'});
      await world.seed(`rooms/uid_${other}/focusRedemptions/r_second`,{id:'second',ts:T0,updatedAt:T0,label:'Second reward',points:3});
      await page.evaluate(uid=>window.__selectProofAccount(uid),other);
      await page.waitForFunction(owner=>accountingIdentity()?.owner===owner&&window._accountingSourcesSeen?.size===4&&_timeAckOnline?.online,`uid_${other}`);await pinned(page,world);
      expect(await page.evaluate(()=>entries.map(row=>row.activity))).toEqual(['Private second account']);
      expect(await page.evaluate(()=>focusRedemptions.map(row=>row.label))).toEqual(['Second reward']);
      expect(await page.evaluate(()=>({running,awayActive,breakActive}))).toEqual({running:false,awayActive:false,breakActive:false});
      expect(await page.evaluate(()=>_startTimer('Private second timer'))).toBe(true);const second=await remote(world,other);
      await page.evaluate(uid=>window.__selectProofAccount(uid),uid);await page.waitForFunction(owner=>accountingIdentity()?.owner===owner&&window._accountingSourcesSeen?.size===4&&_timeAckOnline?.online,`uid_${uid}`);await pinned(page,world);
      expect(await remote(world,uid)).toEqual(first);expect(await remote(world,other)).toEqual(second);
      expect(await page.evaluate(()=>entries.some(row=>row.id===901))).toBe(false);expect(await page.evaluate(()=>focusRedemptions)).toEqual([]);
      expect(await page.evaluate(()=>({running,awayActive,breakActive}))).toEqual({running:mode==='timer',awayActive:mode==='away',breakActive:mode==='break'});
    });
  }
  test(`${uid}: G4 late Save ACK during direct auth switch cannot apply first account data or Undo to second`,async({page})=>{
    const world=await emulator.fresh(rules),other=uid==='alice'?'bob':'alice';await open(page,world,uid);await pinned(page,world);expect(await page.evaluate(()=>_startTimer('Late private source'))).toBe(true);
    await page.evaluate(at=>window.__setNow(at),T0+10*MIN);
    let release,committed=false;const held=new Promise(resolve=>{release=resolve;}),pattern=`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    await page.route(pattern,async route=>{if(route.request().method()!=='PATCH')return route.continue();const response=await route.fetch();committed=true;await held;await route.fulfill({response});});
    await page.evaluate(()=>{window.__privateLate={promise:_doQuickSave('Late private source','deep')};window.__privateLate.promise.then(result=>{window.__privateLate.result=result;});});
    try{
      await expect.poll(()=>committed).toBe(true);const original=await page.evaluate(()=>accountingCoordinator().snapshot().queue.find(op=>op.input.name==='quick-save'));
      await page.evaluate(uid=>window.__selectProofAccount(uid),other);await page.waitForFunction(owner=>accountingIdentity()?.owner===owner&&window._accountingSourcesSeen?.size===4&&_timeAckOnline?.online,`uid_${other}`);await pinned(page,world);
      release();await expect.poll(()=>page.evaluate(()=>window.__privateLate.result)).toBe(false);
      expect(await page.evaluate(()=>({entries:entries.length,redemptions:focusRedemptions.length,undo:lastUndoAction,running}))).toEqual({entries:0,redemptions:0,undo:null,running:false});
      expect((await remote(world,other)).entries).toEqual([]);expect((await remote(world,other)).timer).toBeNull();
      await page.unroute(pattern);await page.evaluate(uid=>window.__selectProofAccount(uid),uid);await page.waitForFunction(owner=>accountingIdentity()?.owner===owner&&window._accountingSourcesSeen?.size===4&&_timeAckOnline?.online,`uid_${uid}`);await pinned(page,world);
      expect((await remote(world,uid)).entries).toEqual([expect.objectContaining({tsStart:T0,ts:T0+10*MIN})]);
      expect(await page.evaluate(id=>lastUndoAction?.accountingReceipt.operationId===id,original.id)).toBe(true);
    }finally{release();await page.unroute(pattern);}
  });

  test(`${uid}: G8 actual SDK queued unstamped original is denied by strict gates without optimistic confirmation`,async({page})=>{
    const world=await emulator.fresh(rules);await open(page,world,uid);await pinned(page,world);
    const raw={id:777,tsStart:T0-MIN,ts:T0,updatedAt:T0,blockIntervalMin:1,date:'2026-10-28',activity:'Legacy queued fact',energy:'deep'};
    await page.evaluate(raw=>{fbDb.goOffline();window.__legacyQueued={raw,promise:fbDb.ref(`rooms/${roomCode}/entries/e_777`).set(raw)};
      window.__legacyQueued.promise.then(()=>{window.__legacyQueued.outcome={accepted:true};},error=>{window.__legacyQueued.outcome={code:error.code};});},raw);
    await page.evaluate(()=>requestAccountingRefresh());expect(await page.evaluate(()=>entries.some(row=>row.id===777))).toBe(false);
    await page.evaluate(()=>fbDb.goOnline());await expect.poll(()=>page.evaluate(()=>window.__legacyQueued.outcome?.code)).toBe('PERMISSION_DENIED');
    expect(await world.read(`rooms/uid_${uid}/entries/e_777`)).toBeNull();expect(await page.evaluate(()=>window.__legacyQueued.raw)).toEqual(raw);
    // The retained value belongs to this synthetic old-client fixture. No old installed queue migration is claimed.
  });

  test(`${uid}: G4 identical typed entry and redemption IDs remain private through direct auth switches`,async({page})=>{
    const world=await emulator.fresh(rules),other=uid==='alice'?'bob':'alice';
    for(const owner of [uid,other]){
      await world.seed(`rooms/uid_${owner}/entries/e_77`,{id:77,tsStart:T0-MIN,ts:T0,updatedAt:T0,blockIntervalMin:1,date:'2026-10-28',activity:`Private ${owner}`,energy:'deep'});
      await world.seed(`rooms/uid_${owner}/focusRedemptions/r_same`,{id:'same',ts:T0,updatedAt:T0,label:`Reward ${owner}`,points:owner===uid?3:4});
    }
    await open(page,world,uid);await pinned(page,world);
    for(const owner of [uid,other,uid]){
      if(await page.evaluate(()=>currentUser.uid)!==owner){await page.evaluate(uid=>window.__selectProofAccount(uid),owner);await page.waitForFunction(room=>accountingIdentity()?.owner===room&&window._accountingSourcesSeen?.size===4&&_timeAckOnline?.online,`uid_${owner}`);await pinned(page,world);}
      expect(await page.evaluate(()=>entries.map(row=>row.activity))).toEqual([`Private ${owner}`]);expect(await page.evaluate(()=>focusRedemptions.map(row=>row.label))).toEqual([`Reward ${owner}`]);
      expect((await remote(world,owner)).entries).toHaveLength(1);expect(await page.evaluate(()=>accountingCoordinator().snapshot().queue)).toEqual([]);
    }
  });

  test(`${uid}: G9-CV1 Focus reopened across midnight dates its one receipt to original planned end`,async({page})=>{
    const world=await emulator.fresh(rules);await open(page,world,uid);await pinned(page,world);const start=Date.parse('2026-10-28T06:30:00Z');
    expect(await page.evaluate(start=>{window.__setNow(start);return enterFocusMode({task:'Midnight Focus',workMinutes:25,autoStart:true});},start)).toBe(true);
    await page.evaluate(at=>{clearInterval(_focusProducerTicker);_focusProducerTicker=null;window.__setNow(at);},start+40*MIN);
    await page.reload();await page.waitForFunction(()=>accountingIdentity());await pinned(page,world);await page.evaluate(()=>timeAckUserAction('check'));
    await expect.poll(async()=>(await remote(world,uid)).entries.length).toBe(1);
    const original=(await remote(world,uid)).entries;expect(original).toEqual([expect.objectContaining({tsStart:start,ts:start+25*MIN,date:'2026-10-27',blockIntervalMin:25})]);
    await page.reload();await page.waitForFunction(()=>accountingIdentity());await pinned(page,world);expect((await remote(world,uid)).entries).toEqual(original);
  });
  for (const entrypoint of ['start','deep-link']) {
    test(`${uid}: G2 active confirmed Focus refuses conflicting ${entrypoint} without creating an incoherent ordinary capture`, async ({page})=>{
      const world=await emulator.fresh(rules);await open(page,world,uid);await pinned(page,world);
      expect(await page.evaluate(()=>enterFocusMode({task:'Owned Focus',workMinutes:25,autoStart:true}))).toBe(true);
      const before=await remote(world,uid);
      expect(await page.evaluate(kind=>kind==='start'?_startTimer('Conflicting ordinary'):handleDeepLink('chronasense://start?task=Conflicting+ordinary'),entrypoint)).toBe(false);
      expect(await page.evaluate(()=>window._accountingLegacyLoadError)).toBeNull();
      expect(await page.evaluate(()=>accountingCoordinator().snapshot().queue.length+accountingCoordinator().captures(roomCode).length)).toBe(0);
      expect(await page.evaluate(()=>pomodoroPhase)).toBe('work');expect(await remote(world,uid)).toEqual(before);
    });
  }
}
