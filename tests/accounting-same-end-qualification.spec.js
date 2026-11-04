// Integrated production coordinator, real SDK and loopback-only RTDB emulator.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';
import { holdEvaluates } from './accounting-retained-action.js';

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


// Additive qualification of the same frozen runtime; original raw SDK test remains historical.
for(const uid of ['alice','bob'])for(const form of ['quick','full']){
 test(`${uid}: G2-CV1 two app clients ${form==='quick'?'retain distinct same-end retro facts':'retain an occupied same-end form identity as conflict'} across offline replay and reload`,async({page,browser})=>{
  const world=await emulator.fresh(rules);await open(page,world,uid,'first-device');await pinned(page,world);
  const peerContext=await browser.newContext({serviceWorkers:'block'});await peerContext.route('**/*',route=>proofEndpoint(route.request().url())?route.continue():route.abort());
  try{
   const peer=await peerContext.newPage();await open(peer,world,uid,'second-device');await pinned(peer,world);
   const pattern=`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`,originals=[];
   for(const [tab,label]of [[page,'First same end'],[peer,'Second same end']]){
    await tab.route(pattern,route=>route.abort('failed'));
    await tab.evaluate(({end,label,form,MIN})=>{fbDb.goOffline();window.__setNow(end);let promise;if(form==='quick'){document.getElementById('retro-task').value=label;document.getElementById('retro-qstart').value='09:00';document.getElementById('retro-qend').value='09:10';promise=quickRetroLog();}else{openRetroLogPrefilled(end-10*MIN,end,label,'deep');promise=saveRetroEntry();}window.__sameEnd={promise};promise.then(result=>{window.__sameEnd.outcome={result};});},{end:T0+10*MIN,label,form,MIN});
    await expect.poll(()=>tab.evaluate(()=>window.__sameEnd.outcome)).toEqual({result:false});
    const captured=await tab.evaluate(name=>accountingCoordinator().snapshot().queue.find(op=>op.input.name===name),form==='quick'?'quick-retro-log':'retro-log');expect(captured).toBeTruthy();
    const row=captured.input.records.find(change=>change.store==='entries').after;expect(row).toMatchObject({activity:label,tsStart:T0,ts:T0+10*MIN,blockIntervalMin:10});
    expect(await tab.evaluate(()=>({entries:entries.length,undo:lastUndoAction}))).toEqual({entries:0,undo:null});originals.push({id:captured.id,row});
   }
   if(form==='quick')expect(originals[0].row.id).not.toBe(originals[1].row.id);
   else expect(originals[0].row.id).toBe(originals[1].row.id);
   for(const tab of [page,peer]){await tab.unroute(pattern);await tab.evaluate(async()=>{fbDb.goOnline();await accountingCoordinator().drain();});}
   const rows=(await remote(world,uid)).entries;expect(rows).toHaveLength(form==='quick'?2:1);
   for(const original of form==='quick'?originals:[originals[0]])expect(rows.find(row=>row.id===original.row.id)).toEqual({...original.row,_csWrite:expect.objectContaining({operationId:original.id})});
   for(const tab of [page,peer]){
    await tab.reload();await tab.waitForFunction(()=>accountingIdentity());await pinned(tab,world);
    await expect.poll(()=>tab.evaluate(()=>entries.map(row=>row.activity).sort())).toEqual(form==='quick'?['First same end','Second same end']:['First same end']);
   }
   if(form==='full'){
    const retained=await peer.evaluate(id=>accountingCoordinator().snapshot().queue.find(op=>op.id===id),originals[1].id);
    expect(retained.phase).toBe('conflict');expect(retained.input.records.find(change=>change.store==='entries').after).toEqual(originals[1].row);
    await expect(peer.locator('#time-ack-status')).toBeVisible();
   }
   expect((await remote(world,uid)).entries).toEqual(rows);
  }finally{await peerContext.close();}
 });
}
