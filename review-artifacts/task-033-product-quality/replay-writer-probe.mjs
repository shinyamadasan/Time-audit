// Synthetic contract gap; optional --emulator uses localhost RTDB. No production or application storage.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import targaryen from 'targaryen';
import {pushFencedItems} from '../../plan-fence-sync.js';
import {mergeCalendarPlanRecords} from '../../calendar-plan-model.js';
import {capture,claim,fencedItem,STORES,T} from '../../fence-rules-fixtures.js';
import {startEmulator} from '../../rtdb-emulator-support.js';
const def=STORES.calendar;
const draftIntent={v:1,kind:'priority',task:'Edited in planning draft',description:'Draft notes',whenDayOffset:0,timezone:'Asia/Manila',source:{text:'x',important:true,urgent:false,status:'triaged',updatedAt:T,updatedBy:'d',reopenCount:0,claimEpoch:0}};
const source=capture({schemaVersion:3,promotionClaim:claim(def,{draftIntent}),updatedAt:T+1});
let remote=fencedItem(def,{task:'Owner edit from device B',description:'Owner notes',kind:'priority',updatedAt:T+20,updatedBy:'device-b'});
const original=structuredClone(remote);
const candidate=fencedItem(def,{task:draftIntent.task,description:draftIntent.description,kind:'priority',whenDayOffset:0,updatedAt:T+30,updatedBy:'device-a'});
const rules=JSON.parse(fs.readFileSync(new URL('./contract-prototype/firebase.rules.json',import.meta.url)));
const emulator=process.argv.includes('--emulator')?await startEmulator():null;
const db=emulator && await emulator.fresh(rules);
if(db){
  await db.seed('rooms/uid_alice/brainDump/bfence1',source);
  assert.equal(await db.write(def.fenceAt(def.key),{...candidate,updatedAt:T+2}),true,'exact initial creation accepted');
  assert.equal(await db.write(def.fenceAt(def.key),original),true,'subsequent owner edit accepted');
}
let allowed=false;
const ref={child(){return this;},async transaction(update){
  const next=update(structuredClone(remote));
  if(next===undefined)return {committed:false,snapshot:{val:()=>remote}};
  const data={rooms:{uid_alice:{brainDump:{bfence1:source},calendarPlanFences:{[def.key]:{'bdp1|bfence1':remote}}}}};
  allowed=db ? await db.write(def.fenceAt(def.key),next) : targaryen.database(rules,data).as({uid:'alice'}).write(def.fenceAt(def.key),next).allowed;
  if(allowed)remote=next;
  return {committed:allowed,snapshot:{val:()=>remote}};
}};
try {
  await pushFencedItems({roomRef:ref,store:'calendar',targetKey:def.key,items:[candidate],stillOwned:()=>true,
    choose:(a,b)=>mergeCalendarPlanRecords({items:[a]},{items:[b]},def.targetId).items[0]});
} finally { emulator?.stop(); }
assert.equal(allowed,true,'prototype rules still authorize ordinary existing-child update');
assert.equal(remote.task,draftIntent.task,'actual fence writer replay overwrites unseen owner edit');
const result={integrationGate:'FAIL — prototype is unsafe for exact edited creation replay',method:`Actual pushFencedItems + calendar merge; ${db?'real local RTDB emulator accepts exact creation, owner edit, then replay':'prototype rules interpreted by targaryen'}; synthetic only`,before:original,after:remote,ownerEditOverwritten:remote.task!==original.task,ruleAllowed:allowed};
fs.writeFileSync(new URL(db?'./REPLAY_WRITER_EMULATOR_RESULT.json':'./REPLAY_WRITER_RESULT.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log('Reproduced unsafe creation replay. This is NOT a passing release gate.');
