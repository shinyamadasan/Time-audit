// Current canonical-rule and privileged-lens qualification; original legacy tests remain preserved.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../time-ack.js';
import {startEmulator,token} from '../rtdb-emulator-support.js';
import {assertCompletionLens} from '../functions/src/completion-domain.js';
import {propose} from '../functions/src/completion-api.js';
import {fixture,command,NOW} from '../task-completion-test-support.js';
const rules=fs.readFileSync(new URL('../firebase.rules.json',import.meta.url),'utf8');
const stamp=(old,value,id)=>{const next=TimeAckCore.stamp(old,value,id);next._csWrite.protocol='staged-command-v1';return next;};
let emulator;
before(async()=>{emulator=await startEmulator();});after(()=>emulator?.stop());
const entry=(id=77,updatedAt=1000)=>({id,tsStart:100,ts:200,updatedAt,blockIntervalMin:1,activity:'Work',energy:'deep'});
for(const uid of ['alice','bob']){
 const own=token(uid),room=`rooms/uid_${uid}`;
 for(const sink of ['entries/e_77','timer','focusRedemptions/r_reward','awayState','breakState']){
  test(`${uid}: G4-CV1 ${sink} valid owner allowed; outsider and Action API claim refused`,async()=>{
   const db=await emulator.fresh(rules);
   const value=sink.startsWith('entries/')?entry():sink.startsWith('focusRedemptions/')?{id:'reward',ts:1000,updatedAt:1000,label:'Reward',points:3}:sink==='timer'?{running:false,ownerRoom:`uid_${uid}`}:{active:false,ownerRoom:`uid_${uid}`,updatedAt:1000};
   const first=stamp(null,value,'canonical_first');assert.equal(await db.write(`${room}/${sink}`,first,own),true,'positive control must be valid');
   const next=stamp(first,{...value,updatedAt:2000},'canonical_next');
   assert.equal(await db.write(`${room}/${sink}`,next,token('mallory')),false);
   const denied=await fetch(`${emulator.base}/${room}/${sink}.json?ns=${db.name}&auth=${encodeURIComponent(token('mallory'))}`);assert.ok([401,403].includes(denied.status),'outsider cannot read protected sink');
   assert.equal(await db.write(`${room}/${sink}`,next,token(uid,{chronasenseActionId:'act1_11111111-1111-4111-8111-111111111111'})),false);
   assert.deepEqual(await db.read(`${room}/${sink}`),first);assert.equal(await db.write(`${room}/${sink}`,next,own),true);
  });
  test(`${uid}: G5-CV1 permanent cancellation refuses next-day original at ${sink}`,async()=>{
   const db=await emulator.fresh(rules),id='cancelled_original';
   const value=sink.startsWith('entries/')?entry():sink.startsWith('focusRedemptions/')?{id:'reward',ts:1000,updatedAt:1000,label:'Reward',points:3}:sink==='timer'?{running:false,ownerRoom:`uid_${uid}`}:{active:false,ownerRoom:`uid_${uid}`,updatedAt:1000};
   const original=stamp(null,value,id);assert.equal(await db.write(`${room}/timeAckCancellations/${id}`,true,own),true);
   assert.equal(await db.write(`${room}/${sink}`,original,own),false);assert.equal(await db.write(`${room}/${sink}`,{...original,updatedAt:1000+86400000},own),false);
   assert.equal(await db.write(`${room}/timeAckCancellations/${id}`,null,own),false);assert.equal(await db.write(`${room}/timeAckCancellations/${id}`,false,own),false);
   assert.equal(await db.read(`${room}/${sink}`),null);
  });
 }
 test(`${uid}: G3-CV1 canonical tombstone and original Undo retain stale-replay and atomic-batch protections`,async()=>{
  const db=await emulator.fresh(rules),path=`${room}/entries/e_77`,active=stamp(null,entry(),'entry_create');
  assert.equal(await db.write(path,active,own),true);const dead=stamp(active,{...entry(77,2000),deleted:true},'entry_delete');assert.equal(await db.write(path,dead,own),true);
  const invalid=stamp(dead,{...entry(77,3000)},'ordinary_resurrection');assert.equal(await db.write(path,invalid,own),false);
  assert.equal(await db.patch(room,{'entries/e_77':invalid,'entries/e_78':stamp(null,entry(78),'other_create')},own),false);assert.equal(await db.read(`${room}/entries/e_78`),null);
  const restored=stamp(dead,{...entry(77,3000),undoRestoredAt:3000},'original_undo');assert.equal(await db.write(path,restored,own),true);
  assert.equal(await db.write(path,dead,own),false);assert.deepEqual(await db.read(path),restored);
  assert.equal(await db.write(`${room}/entries/e_99`,entry(99),own),false,'original unstamped legacy allow expectation superseded by C3');
  assert.equal(await db.write(room,{entries:{e_77:active}},own),false,'no parent replacement bypass');
 });
 test(`${uid}: G3-CV1 numeric and e_ concurrent counterpart race creates one physical identity`,async()=>{
  const db=await emulator.fresh(rules),body=entry();
  const results=await Promise.all([db.write(`${room}/entries/77`,stamp(null,body,'numeric_creator'),own),db.write(`${room}/entries/e_77`,stamp(null,body,'alias_creator'),own)]);
  assert.equal(results.filter(Boolean).length,1);assert.equal(Object.keys(await db.read(`${room}/entries`)).length,1);
 });

 for(const delayed of ['timer','awayState','breakState','entries/e_77','focusRedemptions/r_reward']){
 test(`${uid}: G4-CV1 stale ${delayed} rejects every path in the causal command`,async()=>{
  const db=await emulator.fresh(rules);
  const initial={timer:{running:false,ownerRoom:`uid_${uid}`},awayState:{active:false,ownerRoom:`uid_${uid}`},breakState:{active:false,ownerRoom:`uid_${uid}`},
    'entries/e_77':entry(),'focusRedemptions/r_reward':{id:'reward',ts:1000,updatedAt:1000,points:3,label:'Reward'}};
  const before=Object.fromEntries(Object.entries(initial).map(([path,row])=>[path,stamp(null,row,'atomic_initial')]));assert.equal(await db.patch(room,before,own),true);
  const proposed=Object.fromEntries(Object.entries(before).map(([path,row])=>[path,stamp(row,{...row,updatedAt:2000},'atomic_original')]));
  const peer=stamp(before[delayed],{...initial[delayed],updatedAt:3000},'atomic_peer');assert.equal(await db.write(`${room}/${delayed}`,peer,own),true);
  assert.equal(await db.patch(room,proposed,own),false);
  for(const [path,row]of Object.entries(before))assert.deepEqual(await db.read(`${room}/${path}`),path===delayed?peer:row);
 });
 }

}
test('G4-CV1 unchanged privileged completion lens preserves every new accounting/cancellation sibling',async()=>{
 const f=fixture();f.room.entries.e1._csWrite={v:1,protocol:'staged-command-v1',revision:1,baseRevision:0,baseExists:false,operationId:'entry_original'};
 f.room.timer={running:false,_csWrite:{...f.room.entries.e1._csWrite}};f.room.awayState={active:false,_csWrite:{...f.room.entries.e1._csWrite}};f.room.breakState={active:false,_csWrite:{...f.room.entries.e1._csWrite}};
 f.room.focusRedemptions={r_reward:{id:'reward',points:3,_csWrite:{...f.room.entries.e1._csWrite}}};f.room.timeAckCancellations={cancelled_original:true};
 const request=await command(f.room,f.identity),result=await propose(f.room,'alice',request,NOW);assert.doesNotThrow(()=>assertCompletionLens(f.room,result.next,'alice'));
 for(const path of ['entries','timer','awayState','breakState','focusRedemptions','timeAckCancellations']){
  assert.deepEqual(result.next[path],f.room[path]);const changed=structuredClone(result.next);delete changed[path];assert.throws(()=>assertCompletionLens(f.room,changed,'alice'),/LENS/);
 }
 const changed=structuredClone(result.next);changed.entries.e1._csWrite.revision++;assert.throws(()=>assertCompletionLens(f.room,changed,'alice'),/LENS/);
});
