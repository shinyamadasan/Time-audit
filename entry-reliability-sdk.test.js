import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { startEmulator } from './rtdb-emulator-support.js';
import { connectSdk } from './rtdb-sdk-support.js';

const source = readFileSync(new URL('./storage.js', import.meta.url), 'utf8');
const rules = readFileSync(new URL('./firebase.rules.json', import.meta.url), 'utf8');
const functionSource = name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0];
const room = 'uid_alice';
const start = Date.parse('2026-10-14T01:00:00Z');
let emulator;
const connections = [];
test.before(async () => { emulator = await startEmulator(); });
test.after(async () => { await Promise.all(connections.map(c => c.close())); emulator?.stop(); });

async function world() {
  const db = await emulator.fresh(rules);
  const connect = () => { const c = connectSdk(emulator, db); connections.push(c); return c; };
  return { db, connect };
}

async function until(condition) {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'local SDK acknowledgement did not arrive');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('separate SDK clients retain same-end retro records through offline reconnection', async () => {
  const {db,connect} = await world();
  const a=connect(), b=connect();
  const create = activity => {
    const context=vm.createContext({crypto:webcrypto,Uint32Array,entries:[]});
    const id=vm.runInContext(functionSource('newEntryId')+'\nnewEntryId()',context);
    assert.ok(Number.isSafeInteger(id) && id>0);
    return {id,activity,tsStart:start,ts:start+30*60000,blockIntervalMin:30,
      date:'2026-10-14',energy:'shallow',updatedAt:start+60000,retro:true};
  };
  const first=create('Lunch'), second=create('Email');
  assert.notEqual(first.id,second.id);
  a.offline();
  const queued=a.roomRef().update({[`entries/e_${first.id}`]:first});
  await b.roomRef().update({[`entries/e_${second.id}`]:second});
  a.online();
  await queued;
  const stored=Object.values(await db.read(`rooms/${room}/entries`));
  assert.deepEqual(stored.map(e=>e.activity).sort(),['Email','Lunch']);
  assert.deepEqual(stored.find(e=>e.id===first.id),first);
  assert.deepEqual(stored.find(e=>e.id===second.id),second);
});

function restoredContext(connection) {
  const context=vm.createContext({
    _restoredTimerSync:{ownerRoom:room,baseline:start,sessionStart:start,inFlight:false},
    _syncGeneration:1,_localStateOwner:room,roomCode:room,_timerStateOwner:room,
    running:true,totalSecs:1800,remaining:1200,timerStartedAt:start,syncedFocusTimer:null,
    taskStartTime:start,blockStartTime:start,trackingStartedAt:null,
    currentTask:'Writing',lastTaskForRepeat:'Writing',timerOwnerDeviceId:'device-a',syncedDeviceId:'device-a',
    navigator:{userAgent:'PC'},Date,
    ownedRoomRef:()=>connection.roomRef(),isLocalFocusTimerActive:()=>false,
    rememberTimerSyncStamp:()=>{},persist:()=>{},updateTimerSyncDetail:()=>{},
    notifySyncWriteFailed:error=>{throw error;},
  });
  context.applyRemoteTimerState=data=>{context.observed=data;context.running=data.running;};
  vm.runInContext(functionSource('remoteTimerSyncStamp')+'\n'+functionSource('syncTimerState'),context);
  return context;
}

for(const takeover of [false,true]) test(`first restored publication cannot replace a newer remote ${takeover?'takeover':'stop'}`,async()=>{
  const {db,connect}=await world();
  const remote={running:takeover,stopped:!takeover,lastTask:'Phone task',startedAt:start+600000,
    taskStartTime:start+600000,blockStartTime:start+600000,ownerDeviceId:'device-b',updatedAt:start+1200000};
  await db.seed(`rooms/${room}/timer`,remote);
  const context=restoredContext(connect()); // no primed cache: SDK first tries null, then real server value
  vm.runInContext('syncTimerState()',context);
  await until(()=>context._restoredTimerSync===null);
  assert.deepEqual(await db.read(`rooms/${room}/timer`),remote);
  assert.deepEqual(context.observed,remote);
});

test('first restored publication preserves an offline session when remote is genuinely absent',async()=>{
  const {db,connect}=await world();
  const context=restoredContext(connect());
  vm.runInContext('syncTimerState()',context);
  await until(()=>context._restoredTimerSync===null);
  const remote=await db.read(`rooms/${room}/timer`);
  assert.equal(remote.running,true);
  assert.equal(remote.taskStartTime,start);
  assert.equal(remote.ownerRoom,room);
});

test('cached old timer cannot overwrite a newer server stop during offline restore publication',async()=>{
  const {db,connect}=await world();
  const old={running:true,lastTask:'Writing',startedAt:start,taskStartTime:start,
    ownerDeviceId:'device-a',updatedAt:start};
  await db.seed(`rooms/${room}/timer`,old);
  const a=connect(),b=connect();
  const ref=a.roomRef().child('timer');
  await new Promise(resolve=>ref.on('value',()=>resolve()));
  a.offline();
  const stopped={running:false,stopped:true,updatedAt:start+20*60000,ownerDeviceId:'device-b'};
  await b.roomRef().child('timer').set(stopped);
  const context=restoredContext(a);
  vm.runInContext('syncTimerState()',context);
  a.online();
  await until(()=>context._restoredTimerSync===null);
  assert.deepEqual(await db.read(`rooms/${room}/timer`),stopped);
  assert.deepEqual(context.observed,stopped);
});

test('a late restored publication acknowledgement never rebinds another account',async()=>{
  const {db,connect}=await world();
  const connection=connect();
  const actualRoomRef=connection.roomRef;
  let pending;
  connection.roomRef=()=>new Proxy(actualRoomRef(),{get(ref,key){
    if(key==='child')return name=>new Proxy(ref.child(name),{get(child,method){
      if(method==='transaction')return(...args)=>{pending=child.transaction(...args);return pending;};
      return typeof child[method]==='function'?child[method].bind(child):child[method];
    }});
    return typeof ref[key]==='function'?ref[key].bind(ref):ref[key];
  }});
  connection.offline();
  const context=restoredContext(connection);
  vm.runInContext('syncTimerState()',context);
  context._syncGeneration++;
  context.roomCode=context._localStateOwner=context._timerStateOwner='uid_bob';
  context.taskStartTime=start+40*60000;
  context._restoredTimerSync=null;
  connection.online();
  await pending;
  assert.equal(context.taskStartTime,start+40*60000);
  assert.equal(context.observed,undefined);
  assert.equal(await db.read('rooms/uid_bob/timer'),null);
});
