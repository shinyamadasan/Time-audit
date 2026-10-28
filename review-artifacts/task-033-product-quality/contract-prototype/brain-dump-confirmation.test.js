import test from 'node:test';
import assert from 'node:assert/strict';
import {createPromotionConfirmation} from './brain-dump-confirmation.js';

function fixture(fetchImpl,timeoutMs=100) {
  const state={uid:'alice',generation:1,databaseURL:'https://fixture.invalid/',roomRef:{},getIdToken:async()=> 'synthetic-test-token'};
  return {state,confirmation:createPromotionConfirmation({context:()=>state,fetchImpl,timeoutMs})};
}
test('exact GET confirmation uses only the owned capture or canonical fence, never the SDK cache',async()=>{
  const requests=[];
  const f=fixture(async(url,options)=>{requests.push({url:new URL(url),options});return {ok:true,json:async()=>({server:true})};});
  assert.deepEqual(await f.confirmation.readCapture('capture_033'),{ok:true,value:{server:true}});
  assert.equal(requests[0].url.pathname,'/rooms/uid_alice/brainDump/capture_033.json');
  assert.equal(requests[0].options.method,'GET');assert.equal(requests[0].options.cache,'no-store');
  await f.confirmation.readItem({store:'calendar',id:'cal1:2026-10-27'},'bdp1|capture_033');
  assert.equal(decodeURIComponent(requests[1].url.pathname),'/rooms/uid_alice/calendarPlanFences/cal1:2026-10-27/bdp1|capture_033.json');
  assert.equal((await f.confirmation.readCapture('../other')).ok,false);assert.equal(requests.length,2);
});
for(const failure of ['offline','denied','malformed']) test(`confirmation ${failure} is unknown, never cached success`,async()=>{
  const f=fixture(async()=>{if(failure==='offline')throw new Error('offline');return {ok:failure!=='denied',json:async()=>{throw new Error('invalid JSON');}};});
  assert.equal((await f.confirmation.readCapture('capture_033')).ok,false);
});
test('A to B to A while token retrieval is pending issues no request',async()=>{
  let release,requests=0;const f=fixture(async()=>{requests++;return {ok:true,json:async()=>null};});
  f.state.getIdToken=()=>new Promise(resolve=>{release=resolve;});
  const read=f.confirmation.readCapture('capture_033');f.state.uid='bob';f.state.generation++;f.state.uid='alice';f.state.generation++;
  release('synthetic');assert.equal((await read).ok,false);assert.equal(requests,0);
});
test('account generation changing while response JSON is pending cannot establish confirmation',async()=>{
  let release;const f=fixture(async()=>({ok:true,json:()=>new Promise(resolve=>{release=resolve;})}));
  const read=f.confirmation.readCapture('capture_033');await new Promise(resolve=>setImmediate(resolve));
  f.state.generation++;release({status:'promoted'});assert.equal((await read).ok,false);
});
test('timeout bounds token retrieval and a late token cannot start a request',async()=>{
  let release,requests=0;const f=fixture(async()=>{requests++;},10);f.state.getIdToken=()=>new Promise(resolve=>{release=resolve;});
  assert.equal((await f.confirmation.readCapture('capture_033')).reason,'pending');release('synthetic');await new Promise(resolve=>setImmediate(resolve));assert.equal(requests,0);
});
