import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8').replaceAll('\r\n','\n');
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
const pageSource=section('let _swReg = null;','// ══════════════════════════════════════════════════════\n// ONBOARDING');
const pingSource=section('function doPing() {','\nfunction startPCTimeLive()');
const cancelSource=section('function cancelNativePing(', '// Pre-fill intention');
const workerSource=readFileSync(new URL('./sw.js',import.meta.url),'utf8');

async function world({pendingReady=false,pendingRegister=false,rejectNotification=false}={}){
  let now=1000000,nextTimer=0,resolveReady,resolveRegister;
  const timers=new Map(),messages=[],notifications=[],handlers={},visibilityHandlers=[];
  const pending=[],logMessages=[];
  const worker=vm.createContext({self:{registration:{showNotification:(title,options)=>{
    notifications.push({title,tag:options.tag,data:options.data});return rejectNotification?Promise.reject(Error('denied')):Promise.resolve();
  }},addEventListener:(name,handler)=>{handlers[name]=handler;}},
  Date:class extends Date{static now(){return now;}},
  clients:{matchAll:async()=>[{url:'http://localhost:8765/',focus:()=>{},postMessage:message=>logMessages.push(message)}]},
  setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,at:now+delay});return id;},
  clearTimeout:id=>timers.delete(id)});
  vm.runInContext(workerSource,worker);
  const active={postMessage:message=>messages.push(structuredClone(message))};
  const registration={active};
  const ready=pendingReady?new Promise(resolve=>{resolveReady=()=>resolve(registration);}):Promise.resolve(registration);
  const registered=pendingRegister?new Promise(resolve=>{resolveRegister=()=>resolve(registration);}):ready;
  const app=vm.createContext({console:{log:()=>{},warn:()=>{}},
    navigator:{serviceWorker:{ready,register:()=>registered,addEventListener:()=>{}}},
    document:{hidden:false,title:'',addEventListener:(name,callback)=>{if(name==='visibilitychange')visibilityHandlers.push(callback);}},
    Date:class extends Date{static now(){return now;}},
    running:true,breakActive:false,isNative:false,LocalNotifications:null,roomCode:'uid_test',
    timerOwnerDeviceId:'device-a',syncedDeviceId:'device-a',trackingStartedAt:null,taskStartTime:now,
    totalSecs:60,timerStartedAt:now,remaining:60,blockStartTime:now,pingCount:0,currentState:null,
    blockSegments:[],lastStateChange:now,quiet:false,isInQuietHours:()=>app.quiet,
    updateRing:()=>{},scheduleNativePing:()=>{},playAlert:()=>{},persist:()=>{},syncTimerState:()=>{},
    clearTimeout:()=>{},followupNotifTimer:null,PING_NOTIF_ID:1001,PING_FOLLOWUP_ID:1002});
  vm.runInContext(pageSource+'\n'+pingSource+'\n'+cancelSource,app);
  const flush=async()=>{
    await Promise.resolve();await Promise.resolve();
    while(messages.length)handlers.message({data:messages.shift(),waitUntil:promise=>pending.push(promise)});
    await Promise.all(pending.splice(0));
  };
  await flush();
  return {app,timers,messages,notifications,logMessages,flush,
    run:source=>vm.runInContext(source,app),
    advance:ms=>{now+=ms;},
    hide:async hidden=>{app.document.hidden=hidden;visibilityHandlers.forEach(callback=>callback());await flush();},
    fire:async()=>{for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.callback();}await flush();},
    ready:async()=>{resolveReady();await flush();},
    register:async()=>{resolveRegister();await flush();},
    snooze:async()=>{handlers.notificationclick({action:'snooze',notification:{data:notifications.at(-1)?.data,close:()=>{}}});await flush();},
    clickLog:async()=>{handlers.notificationclick({action:'log',notification:{data:notifications.at(-1)?.data,close:()=>{}},waitUntil:promise=>pending.push(promise)});await flush();},
    message:async message=>{handlers.message({data:message,waitUntil:promise=>pending.push(promise)});await flush();}};
}

for(const workerFirst of [false,true])test(`one notification per interval with ${workerFirst?'worker':'page ticker'} first`,async()=>{
  const w=await world();await w.hide(true);
  assert.equal(w.timers.size,1);
  for(let interval=1;interval<=3;interval++){
    w.advance(60000);
    if(workerFirst)await w.fire();
    w.run('doPing()');await w.flush();await w.fire();
    assert.equal(w.notifications.length,interval,'due interval must notify exactly once');
    assert.equal(w.timers.size,1,'next interval must retain its backup');
  }
});

test('foreground cancellation allows the same session to resume after hiding',async()=>{
  const w=await world();await w.hide(true);await w.hide(false);
  assert.equal(w.timers.size,0);
  await w.hide(true);w.advance(60000);await w.fire();
  assert.equal(w.notifications.length,1);
});

test('mirrored device and quiet hours do not schedule or deliver reminders',async()=>{
  for(const condition of ['mirrored','quiet']){
    const w=await world();
    if(condition==='mirrored')w.app.timerOwnerDeviceId='device-b';else w.app.quiet=true;
    await w.hide(true);w.advance(60000);w.run('doPing()');await w.flush();await w.fire();
    assert.equal(w.notifications.length,0);assert.equal(w.timers.size,0);
  }
});

test('Stop cancels a browser backup before the native-only guard',async()=>{
  const w=await world();await w.hide(true);
  w.run('running=false;cancelNativePing()');await w.flush();w.advance(60000);await w.fire();
  assert.equal(w.notifications.length,0);assert.equal(w.timers.size,0);
});

test('Stop before worker readiness prevents deferred schedules from reappearing',async()=>{
  const w=await world({pendingReady:true});await w.hide(true);
  w.run('running=false;cancelNativePing()');await w.flush();await w.ready();w.advance(60000);await w.fire();
  assert.equal(w.notifications.length,0);assert.equal(w.timers.size,0);
});

test('late duplicate or ended-session delivery is refused while a new session can notify',async()=>{
  const w=await world();await w.hide(true);
  const first=w.run("JSON.stringify([roomCode,timerOwnerDeviceId,trackingStartedAt||taskStartTime||timerStartedAt])");
  w.advance(60000);await w.fire();
  await w.message({action:'ping-due',sessionKey:first,dueAt:1060000});
  assert.equal(w.notifications.length,1);
  w.run('running=false;cancelNativePing()');await w.flush();
  await w.message({action:'ping-due',sessionKey:first,dueAt:1120000});
  await w.message({action:'schedule-ping',sessionKey:first,dueAt:1120000,delayMs:1});
  w.advance(1);await w.fire();assert.equal(w.notifications.length,1);
  w.run('running=true;taskStartTime=Date.now();timerStartedAt=taskStartTime;blockStartTime=taskStartTime');
  await w.hide(true);w.advance(60000);await w.fire();assert.equal(w.notifications.length,2);
});

test('Quick Save cursor advance keeps the session deduplication identity',async()=>{
  const w=await world();await w.hide(true);w.advance(60000);await w.fire();
  w.run('trackingStartedAt=taskStartTime;taskStartTime=Date.now();doPing()');await w.flush();await w.fire();
  assert.equal(w.notifications.length,1);
});

test('notification rejection is absorbed without retrying the same due interval',async()=>{
  const w=await world({rejectNotification:true});await w.hide(true);w.advance(60000);await w.fire();
  w.run('doPing()');await w.flush();await w.fire();assert.equal(w.notifications.length,1);
});

test('deferred delivery is invalidated by Stop while registration is pending',async()=>{
  const w=await world({pendingReady:true});await w.hide(true);w.advance(60000);
  w.run('doPing();running=false;cancelNativePing()');await w.flush();await w.ready();await w.fire();
  assert.equal(w.notifications.length,0);assert.equal(w.timers.size,0);
});

test('account detach cancels the cached old-room session after roomCode changes',async()=>{
  const w=await world();await w.hide(true);
  w.run("roomCode='uid_new';running=false;cancelNativePing()");await w.flush();w.advance(60000);await w.fire();
  assert.equal(w.notifications.length,0);assert.equal(w.timers.size,0);
});

test('quiet cancellation does not retire the live session',async()=>{
  const w=await world();await w.hide(true);
  w.app.quiet=true;w.app.isNative=true;w.app.LocalNotifications={cancel:()=>Promise.resolve()};
  w.run(section('function scheduleNativePing(', 'function scheduleFollowUpPing(')+'\nscheduleNativePing(60)');
  await w.flush();assert.equal(w.timers.size,0);
  w.app.quiet=false;w.app.isNative=false;await w.hide(true);w.advance(60000);await w.fire();
  assert.equal(w.notifications.length,1);
});

test('older unkeyed clients retain backup delivery and cancellation',async()=>{
  const w=await world();await w.message({action:'schedule-ping',delayMs:60000});
  w.advance(60000);await w.fire();assert.equal(w.notifications.length,1);
  await w.message({action:'schedule-ping',delayMs:60000});await w.message({action:'cancel-ping'});
  w.advance(60000);await w.fire();assert.equal(w.notifications.length,1);
});

test('snoozed notification remains cancellable by Stop',async()=>{
  const w=await world();await w.hide(true);w.advance(60000);await w.fire();await w.snooze();
  assert.equal(w.timers.size,1);
  w.run('running=false;cancelNativePing()');await w.flush();w.advance(5*60000);await w.fire();
  assert.equal(w.notifications.length,1);assert.equal(w.timers.size,0);
});

test('late ready visibility cancellation cannot clear a newer registered backup',async()=>{
  const w=await world({pendingReady:true,pendingRegister:true});
  await w.hide(true);await w.hide(false);await w.register();await w.hide(true);
  assert.equal(w.timers.size,1);
  await w.ready();assert.equal(w.timers.size,1);
  w.advance(60000);await w.fire();assert.equal(w.notifications.length,1);
});

test('a current notification opens logging, but its ended-session card cannot reopen it',async()=>{
  const w=await world();await w.hide(true);w.advance(60000);await w.fire();await w.clickLog();
  assert.equal(w.logMessages.length,1);assert.equal(w.logMessages[0].action,'open-log');
  w.run('running=false;cancelNativePing()');await w.flush();await w.clickLog();
  assert.equal(w.logMessages.length,1);
});

test('snooze alone retains the existing five-minute reminder',async()=>{
  const w=await world();await w.hide(true);w.advance(60000);await w.fire();await w.snooze();
  w.advance(5*60000-1);await w.fire();assert.equal(w.notifications.length,1);
  w.advance(1);await w.fire();assert.equal(w.notifications.length,2);
  assert.equal(w.notifications[1].title,'⏱ Snooze over');
});
