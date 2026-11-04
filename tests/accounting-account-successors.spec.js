// Integrated production coordinator, real SDK and loopback-only RTDB emulator.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';
import { holdEvaluates, retainedAccountingResult } from './accounting-retained-action.js';

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



// CV1 successors exercise real SDK room binding and the existing staged contract.
// Redemption setup invokes the coordinator explicitly: no current reward UI is claimed.
async function switchTo(page,world,uid){
 await page.evaluate(uid=>window.__selectProofAccount(uid),uid);
 await page.waitForFunction(owner=>accountingIdentity()?.owner===owner&&window._accountingSourcesSeen?.size===4&&_timeAckOnline?.online,`uid_${uid}`);await pinned(page,world);
}
async function reward(page,label){
 await page.evaluate(label=>{
  const operation=stageAccountingChange('qualification-redemption',draft=>{draft.focusRedemptions.push({id:label,label,points:3,ts:Date.now(),updatedAt:Date.now()});});
  window.__retainedReward={operation};
  operation.then(result=>{window.__retainedReward.outcome={result};},error=>{window.__retainedReward.outcome={error:error.message};});
 },label);
 await expect.poll(()=>page.evaluate(()=>window.__retainedReward.outcome!==undefined),{timeout:0}).toBe(true);
 const outcome=await page.evaluate(()=>window.__retainedReward.outcome);
 if(outcome.error)throw Error(outcome.error);
 return outcome.result;
}
for(const uid of ['alice','bob']){
 test(`${uid}: G4-CV1 logout/login detaches confirmed Timer Away Break and rewards without erasing original account`,async({page})=>{
  const world=await emulator.fresh(rules);await open(page,world,uid);await pinned(page,world);
  expect(await reward(page,'Private reward')).toBe(true);expect(await page.evaluate(()=>_startTimer('Private work'))).toBe(true);
  for(const [step,mode]of ['timer','away','break'].entries()){
   await page.evaluate(at=>window.__setNow(at),T0+step*10*MIN);await page.waitForFunction(()=>!accountingHasPending());
   if(mode==='away')expect(await page.evaluate(()=>startAway('Private away'))).toBe(true);
   if(mode==='break'){expect(await page.evaluate(()=>toggleAway())).toBe(true);expect(await page.evaluate(()=>_startTimer('Private work'))).toBe(true);expect(await page.evaluate(()=>startBreak(5))).toBe(true);}
   const original=await world.read(`rooms/uid_${uid}`),raw=await page.evaluate(()=>accountingCoordinator().snapshot());
   await page.evaluate(()=>firebase.auth().signOut());await page.waitForFunction(()=>!accountingIdentity());
   expect(await page.evaluate(()=>({running,awayActive,breakActive,entries:entries.length,rewards:focusRedemptions.length}))).toEqual({running:false,awayActive:false,breakActive:false,entries:0,rewards:0});
   const retained=await page.evaluate(uid=>JSON.parse(localStorage.getItem(`${AccountingCommand.BASE}:uid_${uid}`)),uid);
   expect(retained.committed.value.entries).toEqual(raw.committed.value.entries);expect(retained.committed.value.focusRedemptions).toEqual(raw.committed.value.focusRedemptions);
   expect(retained.history.filter(op=>op.input.name!=='hydrate-accounting')).toEqual(raw.history.filter(op=>op.input.name!=='hydrate-accounting'));
   await switchTo(page,world,uid);expect(await world.read(`rooms/uid_${uid}`)).toMatchObject({timer:original.timer,focusRedemptions:original.focusRedemptions});
   expect(await page.evaluate(()=>focusRedemptions.map(row=>row.label))).toEqual(['Private reward']);
   expect(await page.evaluate(()=>({running,awayActive,breakActive}))).toEqual({running:mode==='timer',awayActive:mode==='away',breakActive:mode==='break'});
  }
 });
 for(const cached of [false,true])test(`${uid}: G4-CV1 offline pending redemption A-B-A with B canonical cache ${cached} stays partitioned and B can create its own reward`,async({page})=>{
  const world=await emulator.fresh(rules),other=uid==='alice'?'bob':'alice';await open(page,world,uid);await pinned(page,world);
  if(cached){await switchTo(page,world,other);expect(await reward(page,'Prior B reward')).toBe(true);await switchTo(page,world,uid);}
  const pattern=`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;await page.route(pattern,route=>route.abort('failed'));await page.evaluate(()=>fbDb.goOffline());
  expect(await reward(page,'Pending A reward')).toBe(false);
  const original=await page.evaluate(()=>accountingCoordinator().snapshot().queue.find(op=>op.input.name==='qualification-redemption'));
  expect(original).toBeTruthy();expect(await page.evaluate(()=>focusRedemptions)).toEqual([]);
  await switchTo(page,world,other);expect(await page.evaluate(()=>focusRedemptions.map(row=>row.label))).toEqual(cached?['Prior B reward']:[]);
  expect(await reward(page,'New B reward')).toBe(true);const second=await world.read(`rooms/uid_${other}/focusRedemptions`);
  expect(Object.values(second).map(row=>row.label).sort()).toEqual(cached?['New B reward','Prior B reward']:['New B reward']);
  expect(await page.evaluate(({uid,id})=>JSON.parse(localStorage.getItem(`${AccountingCommand.BASE}:uid_${uid}`)).queue.find(op=>op.id===id),{uid,id:original.id})).toEqual(original);
  await page.unroute(pattern);await switchTo(page,world,uid);
  await expect.poll(()=>page.evaluate(()=>focusRedemptions.map(row=>row.label))).toEqual(['Pending A reward']);
  const first=await world.read(`rooms/uid_${uid}/focusRedemptions`);expect(Object.values(first)).toEqual([expect.objectContaining({label:'Pending A reward',_csWrite:expect.objectContaining({operationId:original.id})})]);
  expect(await world.read(`rooms/uid_${other}/focusRedemptions`)).toEqual(second);
  expect(await page.evaluate(id=>accountingCoordinator().snapshot().history.filter(op=>op.id===id).length,original.id)).toBe(1);
 });
 test(`${uid}: G4-CV1 confirmed Focus A-B-A detaches its producer and restores only its own original session`,async({page})=>{
  const world=await emulator.fresh(rules),other=uid==='alice'?'bob':'alice';await open(page,world,uid);await pinned(page,world);
  expect(await page.evaluate(()=>enterFocusMode({task:'Private Focus',workMinutes:25,autoStart:true}))).toBe(true);
  const first=await world.read(`rooms/uid_${uid}/timer`),focus=await page.evaluate(()=>captureAccountingFrame().focus);
  await switchTo(page,world,other);expect(await page.evaluate(()=>captureAccountingFrame().focus)).toBeNull();
  expect(await page.evaluate(()=>({entries:entries.length,rewards:focusRedemptions.length,running}))).toEqual({entries:0,rewards:0,running:false});
  expect(await page.evaluate(()=>_startTimer('Other private task'))).toBe(true);const second=await world.read(`rooms/uid_${other}/timer`);
  await switchTo(page,world,uid);expect(await page.evaluate(()=>captureAccountingFrame().focus)).toEqual(focus);
  expect(await world.read(`rooms/uid_${uid}/timer`)).toEqual(first);expect(await world.read(`rooms/uid_${other}/timer`)).toEqual(second);
  expect(await world.read(`rooms/uid_${other}/entries`)).toBeNull();expect(await world.read(`rooms/uid_${other}/focusRedemptions`)).toBeNull();
 });
 test(`${uid}: G4-CV1 same-account offline reward reconnect confirms the original once`,async({page})=>{
  const world=await emulator.fresh(rules);await open(page,world,uid);await pinned(page,world);
  const pattern=`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;await page.route(pattern,route=>route.abort('failed'));await page.evaluate(()=>fbDb.goOffline());
  expect(await reward(page,'Reconnect reward')).toBe(false);const original=await page.evaluate(()=>accountingCoordinator().snapshot().queue.find(op=>op.input.name==='qualification-redemption'));
  expect(await world.read(`rooms/uid_${uid}/focusRedemptions`)).toBeNull();await page.unroute(pattern);await page.evaluate(async()=>{fbDb.goOnline();await accountingCoordinator().drain();});
  await page.reload();await page.waitForFunction(()=>accountingIdentity());await pinned(page,world);
  expect(await page.evaluate(()=>focusRedemptions.map(row=>row.label))).toEqual(['Reconnect reward']);
  expect(Object.values(await world.read(`rooms/uid_${uid}/focusRedemptions`))).toEqual([expect.objectContaining({_csWrite:expect.objectContaining({operationId:original.id})})]);
 });
 test(`${uid}: G4-CV1 foreign-device Break expiry cannot double-log the owner completion`,async({page,browser})=>{
  const world=await emulator.fresh(rules);await open(page,world,uid,'owner-device');await pinned(page,world);
  expect(await page.evaluate(()=>_startTimer('Owner task'))).toBe(true);expect(await page.evaluate(()=>startBreak(5))).toBe(true);
  const mirrorContext=await browser.newContext({serviceWorkers:'block'});await mirrorContext.route('**/*',route=>proofEndpoint(route.request().url())?route.continue():route.abort());
  try{const mirror=await mirrorContext.newPage();await open(mirror,world,uid,'mirror-device');await pinned(mirror,world);
   const before=await world.read(`rooms/uid_${uid}/breakState`);await mirror.evaluate(at=>window.__setNow(at),T0+6*MIN);
   expect(await retainedAccountingResult(mirror, 'end-break')).toBe(false);expect(await world.read(`rooms/uid_${uid}/breakState`)).toEqual(before);expect((await remote(world,uid)).entries).toEqual([]);
   await page.evaluate(at => window.__setNow(at), T0+5*MIN); expect(await retainedAccountingResult(page, 'end-break')).toBe(true);
   await mirror.evaluate(()=>requestAccountingRefresh());await expect.poll(()=>mirror.evaluate(()=>breakActive)).toBe(false);
   expect((await remote(world,uid)).entries).toEqual([expect.objectContaining({activity:'Break',tsStart:T0,ts:T0+5*MIN,blockIntervalMin:5})]);
  }finally{await mirrorContext.close();}
 });
}
