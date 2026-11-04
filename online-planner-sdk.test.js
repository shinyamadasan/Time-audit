import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {startEmulator} from './rtdb-emulator-support.js';
import {connectSdk} from './rtdb-sdk-support.js';
import {buildPreparation,mergeDatePlans,normalizePreparation} from './plan-tomorrow-model.js';

const rules=readFileSync(new URL('./firebase.rules.json',import.meta.url),'utf8');
const date='2026-10-28';
let emulator;
const connections=[];
test.before(async()=>{emulator=await startEmulator();});
test.after(async()=>{await Promise.all(connections.map(connection=>connection.close()));emulator?.stop();});

for(const [name,routineInstanceIds,oneOffItemIds] of [
  ['priority-only',[],['priority-1']],['routine-only',['routine-1'],[]],['open day',[],[]],
]) test(`real SDK ${name} preparation survives transaction acknowledgement and second-client read`,async()=>{
  const world=await emulator.fresh(rules);
  const writer=connectSdk(emulator,world),reader=connectSdk(emulator,world);
  connections.push(writer,reader);
  const now=Date.now();
  const preparation=buildPreparation(null,{targetDate:date,timezone:'America/Phoenix',now,mode:'normal',
    updatedBy:'sdk-writer',intentionalBlank:oneOffItemIds.length+routineInstanceIds.length===0,routineInstanceIds,oneOffItemIds});
  const local={items:oneOffItemIds.map(id=>({id,task:'SDK priority',when:'',done:false,updatedAt:now})),
    preparation,updatedAt:now,updatedBy:'sdk-writer'};
  const result=await writer.roomRef().child(`plans/${date}`).transaction(remote=>mergeDatePlans(remote,local,date),undefined,false);
  assert.equal(result.committed,true);
  const wire=result.snapshot.val();
  for(const key of ['routineInstanceIds','oneOffItemIds']) if(preparation[key].length===0) assert.equal(Object.hasOwn(wire.preparation,key),false);
  assert.deepEqual(normalizePreparation(wire.preparation,date),preparation);
  assert.deepEqual(mergeDatePlans(null,wire,date).preparation,preparation);
  const remote=(await reader.roomRef().child(`plans/${date}`).once('value')).val();
  assert.deepEqual(normalizePreparation(remote.preparation,date),preparation);
});
