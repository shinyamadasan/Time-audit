// Bounded test-only rule variants. No change to generated Firebase rules or application code.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {buildRules} from '../scripts/firebase-rules-builder.mjs';
import {startEmulator,token} from '../rtdb-emulator-support.js';
import {connectSdk} from '../rtdb-sdk-support.js';
import {buildPreparation,mergeDatePlans} from '../plan-tomorrow-model.js';
import * as old from './fixtures/plan-tomorrow-model.js';
import {capture,claim,STORES,CAPTURE,T} from '../fence-rules-fixtures.js';
import {createPlanAuthority} from '../plan-authority.js';
import {createPersonalDayBoundaryLiveWiring} from '../personal-day-boundary-live.js';
import {createPersonalDayBoundaryRepository} from '../personal-day-boundary-repository.js';
import {createOperationalPlanRepository} from '../operational-plan-repository.js';
import {createOperationalPlanSyncBridge} from '../operational-plan-sync.js';
import {createPersonalDayBoundarySyncBridge} from '../personal-day-boundary-sync.js';
const date='2026-10-28',now=Date.parse('2026-10-28T16:00:00Z'),uidList=['alice','bob'];
const at=uid=>`rooms/uid_${uid}`,hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const item={id:'one-1',task:'Plan work',when:'',kind:'task',done:false,doneAt:null,deleted:false,
  description:'Protected context',updatedAt:now,updatedBy:'device-a'};
const preparation=buildPreparation(null,{targetDate:date,timezone:'America/Phoenix',now:now-1000,
  mode:'normal',updatedBy:'device-a',intentionalBlank:false,routineInstanceIds:[],oneOffItemIds:['one-1']});
const wire=structuredClone(preparation);delete wire.routineInstanceIds;
const plan={items:[item],preparation:wire,updatedAt:now,updatedBy:'device-a'};
const entry={id:1213,tsStart:now-600000,ts:now-300000,blockIntervalMin:5,date,
  activity:'Historical synthetic time',energy:'deep',onPlan:false,note:'preserve facts',updatedAt:now-300000};
const tombstone={...entry,id:1214,deleted:true,updatedAt:now};
const copy=value=>JSON.parse(JSON.stringify(value));
let emulator;const connections=[],observations=[];
before(async()=>{emulator=await startEmulator();});
after(async()=>{await Promise.all(connections.map(c=>c.close()));emulator?.stop();
  fs.writeFileSync(new URL('../review-artifacts/task-039-final-local-safety/TEST_ONLY_RULE_VARIANTS.json',import.meta.url),JSON.stringify({
    preparation_presence:rules({prep:true}),description_freeze:rules({prep:true,freezeDescription:true}),
    entry_timestamp_monotonic:rules({prep:true,monotonic:true})},null,2)+'\n');
  fs.writeFileSync(new URL('../review-artifacts/task-039-final-local-safety/SAFETY_OBSERVATIONS.json',import.meta.url),JSON.stringify({
    scope:'synthetic local emulator/SDK, no live data',observations,
    conclusion:'BLOCKED: preservation guards cannot distinguish identical authorized old/current transitions without changing supported edit/write contract'},null,2)+'\n');});
const connect=(world,uid)=>{const sdk=connectSdk(emulator,world,{uid});connections.push(sdk);return sdk;};
const denied=promise=>assert.rejects(promise,error=>/permission_denied/i.test(error.code||error.message));
function rules({prep=false,freezeDescription=false,monotonic=false}={}) {
  const result=copy(buildRules()),room=result.rules.rooms.$roomId;
  for(const [store,key] of [['plans','$dateKey'],['calendarPlans','$planId'],['operationalPlans','$dayKey']]){
    if(prep)room[store][key]['.validate']="!data.child('preparation').exists() || newData.child('preparation').exists()";
    if(freezeDescription){const node=room[store][key].items.$i;
      node['.validate']=`(${node['.validate']}) && (!data.exists() || newData.child('id').val() !== data.child('id').val() || newData.child('description').val() === data.child('description').val())`;}
  }
  if(monotonic){const node=room.entries.$entryId;node['.write']=`(${node['.write']}) && (!data.exists() || newData.child('updatedAt').val() >= data.child('updatedAt').val())`;}
  return result;
}
async function seed(world,uid){await world.seed(at(uid),{plans:{[date]:plan},entries:{e_1213:entry,e_1214:tombstone}});}
const prune=value=>{if(value===null||value===undefined)return undefined;if(typeof value!=='object')return value;
  if(Array.isArray(value))return value.length?value.map(prune):undefined;const result={};for(const [key,v] of Object.entries(value)){const child=prune(v);if(child!==undefined)result[key]=child;}return Object.keys(result).length?result:undefined;};
// Same production PlanAuthority + boundary repositories, synthetic owning account, no mocked edit algorithm.
function legitimateDescriptionEdit(value,description) {
  const plans={[date]:copy(value)},memory=()=>{const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,v)=>map.set(key,v),removeItem:key=>map.delete(key)};};
  const legacy={record:key=>plans[key]||null,rawItems:key=>copy(plans[key]?.items||[]),
    saveItems(key,items){plans[key]={...plans[key],items,updatedAt:now+1,updatedBy:'device-a'};},allPlans:()=>plans};
  const boundaryRepository=createPersonalDayBoundaryRepository({storage:memory(),idGenerator:()=> 'fixture-rev',getOwner:()=> 'uid_alice'});
  const planRepository=createOperationalPlanRepository({storage:memory(),getOwner:()=> 'uid_alice'});
  const planSync=createOperationalPlanSyncBridge({repository:planRepository,getRoomRef:()=>null,getRoomId:()=> 'uid_alice'});
  const boundarySync=createPersonalDayBoundarySyncBridge({repository:boundaryRepository,getRoomRef:()=>null,getRoomId:()=> 'uid_alice'});
  const live=createPersonalDayBoundaryLiveWiring({boundaryRepository,planRepository,planSync,boundarySync,
    legacyPlans:{readItems:key=>legacy.rawItems(key),saveItems:(key,items)=>legacy.saveItems(key,items)},
    now:()=>now,deviceId:()=> 'device-a',fallbackTimezone:()=> 'America/Phoenix'});
  const authority=createPlanAuthority({live,legacy,now:()=>now,accountTimezone:()=> 'America/Phoenix'});
  authority.updateItem({sourceTarget:authority.current(),itemId:item.id,changes:{description},
    stamp:value=>({...value,updatedAt:now+1,updatedBy:'device-a'}),nowMs:now});
  return plans[date];
}

test('actual old model drops pruned preparation; candidate preserves it without changing the source',()=>{
  const before=JSON.stringify(plan),edit={items:[{...item,task:'Edit',updatedAt:now+1}],updatedAt:now+1,updatedBy:'device-a'};
  assert.equal(old.mergeDatePlans(plan,edit,date).preparation,undefined);
  assert.deepEqual(mergeDatePlans(plan,edit,date).preparation,preparation);assert.equal(JSON.stringify(plan),before);
});

for(const uid of uidList)test(`presence guard rejects old whole-plan preparation stripping and accepts current save: ${uid}`,async()=>{
  const world=await emulator.fresh(rules({prep:true}));await seed(world,uid);const sdk=connect(world,uid);
  const before=hash(await world.read(at(uid)+'/entries'));
  const edit={items:[{...item,task:'Supported edit',updatedAt:now+1}],updatedAt:now+1,updatedBy:'device-a'};
  await denied(sdk.roomRef().child('plans/'+date).transaction(remote=>old.mergeDatePlans(remote,edit,date)));
  assert.deepEqual(await world.read(at(uid)+'/plans/'+date),prune(plan));
  await sdk.roomRef().child('plans/'+date).transaction(remote=>mergeDatePlans(remote,edit,date));
  const saved=await world.read(at(uid)+'/plans/'+date);assert.equal(saved.items[0].task,'Supported edit');
  assert.deepEqual(saved.preparation,prune(preparation));assert.equal(hash(await world.read(at(uid)+'/entries')),before);
  observations.push({case:'preparation-presence',uid,old_rejected:true,current_saved:true,time_and_tombstones_unchanged:true});
});

test('offline stale SDK queue cannot bypass the preparation guard on reconnect',async()=>{
  const world=await emulator.fresh(rules({prep:true}));await seed(world,'alice');const sdk=connect(world,'alice');
  await sdk.roomRef().child('plans/'+date).once('value');sdk.offline();
  const queued=sdk.roomRef().child('plans/'+date).set(old.mergeDatePlans(plan,{items:[item],updatedAt:now+1},date)).then(()=>null,error=>error);
  sdk.online();const error=await queued;assert.match(error.code,/permission_denied/i);
  assert.deepEqual(await world.read(at('alice')+'/plans/'+date),prune(plan));
});

test('preparation presence alone still accepts source metadata replacement and cannot be called a complete guard',async()=>{
  const world=await emulator.fresh(rules({prep:true}));await seed(world,'alice');
  const next={...plan,preparation:{...wire,firstPreparedAt:wire.firstPreparedAt+1},updatedAt:now+1};
  assert.equal(await world.write(at('alice')+'/plans/'+date,next),true);
  observations.push({case:'presence-only-limit',replaced_firstPreparedAt_accepted:true,not_safe_for_activation:true});
});

test('description-freeze guard rejects stale metadata overwrite but also rejects actual supported PlanAuthority edit',async()=>{
  const world=await emulator.fresh(rules({prep:true,freezeDescription:true}));await seed(world,'alice');
  const legitimate=legitimateDescriptionEdit(plan,'Intentional revised description');
  assert.equal(legitimate.items[0].description,'Intentional revised description');
  assert.equal(await world.write(at('alice')+'/plans/'+date,legitimate),false,'real supported edit is blocked');
  const stale={...plan,items:[{...item,description:'Old text',updatedAt:now+1}],updatedAt:now+1};
  assert.equal(await world.write(at('alice')+'/plans/'+date,stale),false);
  assert.deepEqual(await world.read(at('alice')+'/plans/'+date),prune(plan));
  observations.push({case:'description-freeze',unsafe_rejected:true,supported_real_edit_rejected:true});
});

test('same authenticated transition: old stale description snapshot equals supported current intentional revert',async()=>{
  const serverPlan={items:[item],updatedAt:now,updatedBy:'device-a'};
  const current=legitimateDescriptionEdit(serverPlan,'Earlier description');
  const staleLocal={...copy(current),items:[{...copy(current.items[0]),updatedAt:now+1,updatedBy:'device-a'}]};
  // The old writer has not heard the newer rich description and sends its ordinary fresh-stamped edit.
  const oldWrite=old.mergeDatePlans(staleLocal,serverPlan,date);
  const currentWrite=mergeDatePlans(current,serverPlan,date);
  assert.deepEqual(oldWrite,currentWrite,'same uid,path,data,newData; user intent is not in the existing wire contract');
  for(const strict of [false,true]){
    const world=await emulator.fresh(rules({prep:true,freezeDescription:strict}));await world.seed(at('alice')+'/plans/'+date,serverPlan);
    const allowed=await world.write(at('alice')+'/plans/'+date,currentWrite,token('alice'));
    assert.equal(allowed,!strict);
    observations.push({case:'identical-description-transition',guard:strict?'freeze':'presence',both_allowed:allowed,
      transition_sha256:hash(currentWrite),owner:'alice',same_rules_inputs:true});
  }
});

test('timestamp monotonicity rejects an old queue but admits a freshly stamped stale recorded-time edit',async()=>{
  const world=await emulator.fresh(rules({prep:true,monotonic:true}));await seed(world,'alice');
  const newer={...entry,activity:'Latest corrected activity',updatedAt:now+100};await world.seed(at('alice')+'/entries/e_1213',newer);
  assert.equal(await world.write(at('alice')+'/entries/e_1213',entry),false);
  const stale={...entry,updatedAt:now+101},legitimate={...newer,activity:entry.activity,updatedAt:now+101};
  assert.deepEqual(stale,legitimate);
  assert.equal(await world.write(at('alice')+'/entries/e_1213',stale),true);
  assert.equal((await world.read(at('alice')+'/entries/e_1213')).activity,entry.activity);
  observations.push({case:'time-monotonicity-limit',old_queue_rejected:true,newer_stale_content_accepted:true,same_as_legitimate_revert:true});
});

test('day deletion and array reindexing bypass local leaf-only guards under existing ancestor grants',async()=>{
  const world=await emulator.fresh(rules({prep:true,freezeDescription:true}));await seed(world,'alice');
  assert.equal(await world.write(at('alice')+'/plans/'+date,null),true,'plan validation is skipped when its node is deleted');
  await world.seed(at('alice')+'/plans/'+date,{...plan,items:[item,{...item,id:'two-2',task:'Other',description:'Second context'}]});
  const swapped={...plan,items:[{...item,id:'two-2',task:'Other',description:'Stale second'},{...item,description:'Stale first'}]};
  assert.equal(await world.write(at('alice')+'/plans/'+date,swapped),true,'array slots are not stable logical identities');
  observations.push({case:'leaf-guard-bypass',whole_day_delete_allowed:true,reindex_strips_description_allowed:true,not_proposed_for_deployment:true});
});

test('source-fence protection, historical bytes, tombstones and cross-account isolation remain enforced',async()=>{
  const world=await emulator.fresh(rules({prep:true}));await seed(world,'alice');await seed(world,'bob');
  const alice=connect(world,'alice'),bob=connect(world,'bob');
  const original=capture({text:'Authoritative source',updatedAt:T+1});await alice.roomRef().child('brainDump/'+CAPTURE).set(original);
  await denied(alice.roomRef().child('brainDump/'+CAPTURE).set(capture({text:'Stale source',updatedAt:T+2,promotionClaim:claim(STORES.legacy)})));
  assert.deepEqual(await world.read(at('alice')+'/brainDump/'+CAPTURE),original);
  const before=await world.read(at('alice')+'/entries');
  await denied(bob.ref(at('alice')+'/plans/'+date).once('value'));await denied(bob.ref(at('alice')+'/plans/'+date).set(plan));
  await denied(bob.ref(at('alice')+'/entries/e_1213').set(entry));
  await denied(alice.roomRef().child('entries/e_1214').set({...entry,id:1214}));
  await denied(alice.roomRef().child('entries/e_1213').remove());
  assert.deepEqual(await world.read(at('alice')+'/entries'),before);
});
