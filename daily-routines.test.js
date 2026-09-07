import test from 'node:test';
import assert from 'node:assert/strict';
import { localContext, validateRoutine, instanceId, generateInstances, scheduleState, matchCompletion, completionLevel, dailyScore, routineStreak } from './daily-routines-model.js';
import { createDailyRoutineRepository } from './daily-routines-repository.js';
import { createLocalLifeLedgerStore, buildLearningPlanStepCompletedDraft } from './life-ledger-runtime.js';
import { normalizeWorkoutCompleted } from './workout-life-ledger-adapter.js';
import { createLearningPlan, addPhase, addLesson, addStep, completeStep } from './learning-plan-model.js';
const tz = 'America/Phoenix';
const now = '2026-09-09T02:00:00Z'; // Sep 8, 19:00
const routine = overrides => ({ id: 'routine-1', createdDate: '2026-09-01', title: 'Spanish', enabled: true, cadence: 'daily', days: [], mode: 'exact', time: '20:00', endTime: '21:00', cue: '', targetMinutes: 15, minimumMinutes: 5, fallback: '', source: 'manual', ...overrides });
const instance = r => generateInstances([r], '2026-09-08', tz)[0];
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v) }; };
const input = (r, extra = {}) => ({ routines: [r], ...extra });

test('stable identity survives title/time edits, same-day reload, duplicates; next day rolls once', () => {
  const r = routine();
  const first = generateInstances([r], '2026-09-08', tz);
  assert.deepEqual(first, generateInstances([r], '2026-09-08', tz));
  assert.equal(generateInstances([r,r], '2026-09-08', tz).length, 1);
  assert.equal(instance(routine({ title: 'Renamed', time: '21:00' })).id, first[0].id);
  const tomorrow = generateInstances([r], '2026-09-09', tz);
  assert.equal(tomorrow.length, 1); assert.notEqual(tomorrow[0].id, first[0].id);
  assert.equal(generateInstances([routine({ enabled: false })], '2026-09-08', tz).length, 0);
});
test('cadence: daily, weekdays, selected weekdays and creation date', () => {
  for (const [date, expected] of [['2026-09-07',1],['2026-09-12',0],['2026-09-13',0]]) assert.equal(generateInstances([routine({ cadence:'weekdays' })],date,tz).length,expected);
  for (const [date, expected] of [['2026-09-07',1],['2026-09-08',0],['2026-09-09',1]]) assert.equal(generateInstances([routine({ cadence:'selected',days:[1,3,5] })],date,tz).length,expected);
  assert.equal(generateInstances([routine()], '2026-08-31', tz).length, 0);
  assert.throws(() => validateRoutine(routine({ cadence:'selected' })));
  assert.throws(() => validateRoutine(routine({ mode:'window', endTime:'19:00' })));
  assert.throws(() => validateRoutine(routine({ minimumMinutes:16 })));
});
for (const [zone, instant, date, minute] of [
  ['Asia/Tokyo','2026-09-08T16:00:00Z','2026-09-09',60],
  [tz,'2026-09-09T06:59:00Z','2026-09-08',1439],
  [tz,'2026-09-09T07:01:00Z','2026-09-09',1],
  ['America/New_York','2026-03-08T06:59:00Z','2026-03-08',119],
  ['America/New_York','2026-03-08T07:00:00Z','2026-03-08',180],
  ['America/New_York','2026-11-01T05:30:00Z','2026-11-01',90],
  ['America/New_York','2026-11-01T06:30:00Z','2026-11-01',90]
]) test(`timezone ${zone} ${instant}`, () => {
  assert.deepEqual(localContext(instant,zone),{ date,minute,timezone:zone });
  const r = routine({createdDate:'2026-01-01'});
  assert.equal(generateInstances([r],date,zone)[0].id,instanceId(r.id,date));
});
test('DST skipped cue becomes available; repeated hour shares one identity', () => {
  const r = routine({createdDate:'2026-01-01',time:'02:30',fallback:'After breakfast'});
  const i = generateInstances([r],'2026-03-08','America/New_York')[0];
  assert.match(scheduleState(i,'2026-03-08T07:00:00Z').label,/Still available/);
  assert.equal(localContext('2026-11-01T05:30:00Z','America/New_York').date,localContext('2026-11-01T06:30:00Z','America/New_York').date);
});
test('exact before/now/late and fallback remain intentions until end of day', () => {
  const i=instance(routine());
  assert.equal(scheduleState(i,now).group,'Next');
  assert.equal(scheduleState(i,'2026-09-09T03:00:00Z').group,'Now');
  assert.equal(scheduleState(i,'2026-09-09T03:16:00Z').group,'Anytime');
  assert.match(scheduleState(instance(routine({fallback:'Before bed'})),'2026-09-09T03:16:00Z').label,/Before bed/);
  assert.equal(scheduleState(i,'2026-09-09T07:00:00Z').group,'Incomplete');
  assert.equal(matchCompletion(i,input(i.routine),'2026-09-09T07:00:00Z'),null);
});
test('window before/in/after, cue and anytime are honest', () => {
  const i=instance(routine({mode:'window',time:'17:00',endTime:'20:00'}));
  assert.equal(scheduleState(i,'2026-09-08T23:00:00Z').group,'Next');
  assert.equal(scheduleState(i,now).label,'Available now');
  assert.equal(scheduleState(i,'2026-09-09T03:00:00Z').group,'Anytime');
  assert.equal(scheduleState(instance(routine({mode:'cue',cue:'After dinner'})),now).label,'Cue: After dinner');
  assert.equal(scheduleState(instance(routine({mode:'anytime'})),now).group,'Anytime');
});
test('manual Done, minimum, undo and reload never write Ledger or duplicate instances', () => {
  const storage=memory(), repo=createDailyRoutineRepository(storage), r=routine(), i=instance(r);
  repo.update(tz,s=>s.routines.push(r));
  repo.manualDone(tz,i.id,'complete');
  let state=createDailyRoutineRepository(storage).read(tz);
  assert.equal(matchCompletion(i,state,now).level,'complete');
  assert.equal(scheduleState(i,now,matchCompletion(i,state,now)).group,'Done');
  assert.deepEqual(createLocalLifeLedgerStore({storage}).listEvents(),[]);
  repo.manualDone(tz,i.id,'minimum');
  assert.equal(matchCompletion(i,repo.read(tz),now).level,'minimum');
  repo.update(tz,s=>s.routines[0].enabled=false);
  assert.equal(repo.read(tz).manual[i.id].level,'minimum');
  repo.manualDone(tz,i.id,null);
  assert.equal(matchCompletion(i,repo.read(tz),now),null);
  assert.equal(generateInstances(state.routines,'2026-09-09',tz).length,1);
  assert.equal(repo.read('Asia/Tokyo').timezone,tz);
});
test('bad storage and failed writes fail visibly without replacing valid state', () => {
  const storage=memory(), repo=createDailyRoutineRepository(storage);
  repo.update(tz,s=>s.routines.push(routine()));
  assert.throws(()=>repo.update(tz,s=>s.routines.push(routine())));
  assert.equal(repo.read(tz).routines.length,1);
  storage.setItem=()=>{throw new Error('Quota');};
  assert.throws(()=>repo.manualDone(tz,instance(routine()).id,'complete'),/Quota/);
  assert.deepEqual(repo.read(tz).manual,{});
});
test('target/minimum/unknown duration and score remain distinct', () => {
  const r=routine();
  assert.equal(completionLevel(r,15),'target'); assert.equal(completionLevel(r,5),'minimum');
  assert.equal(completionLevel(r,4),'incomplete'); assert.equal(completionLevel(r,undefined),'complete');
  assert.deepEqual(dailyScore([{level:'target'},{level:'minimum'},{level:'complete'},null]),{planned:4,completed:3,target:1,minimum:1});
});
function workoutEvent() {
  const raw={id:'w-1',d:'2026-09-08',start:Date.parse('2026-09-09T00:30:00Z'),end:Date.parse('2026-09-09T01:12:00Z'),name:'Workout',entries:[]};
  const normalized=normalizeWorkoutCompleted(raw,{observedAt:now,assertedTimezone:tz});
  // Use the actual adapter, including its strict source schema.
  assert.equal(normalized.ok,true,JSON.stringify(normalized));
  const store=createLocalLifeLedgerStore({storage:memory()});
  store.upsertEvent(normalized.draft);
  return store.listEvents()[0];
}
test('real adapter workout 18:12 matches; wrong day/source, tombstone and ambiguous routines abstain; duplicates count once', () => {
  const event=workoutEvent(), r=routine({source:'workout',mode:'window',time:'17:00',endTime:'20:00',targetMinutes:30,minimumMinutes:15}),i=instance(r);
  const result=matchCompletion(i,input(r,{events:[event,event]}),now);
  assert.equal(result.level,'target'); assert.equal(result.source,'workout');
  assert.equal(matchCompletion(i,input(r,{events:[{...event,sourceApp:'other'}]}),now),null);
  assert.equal(matchCompletion(i,input(r,{events:[{...event,tombstone:{active:true}}]}),now),null);
  assert.equal(matchCompletion({...i,date:'2026-09-09'},input(r,{events:[event]}),now),null);
  assert.equal(matchCompletion(i,{routines:[r,{...r,id:'w2'}],events:[event]},now).source,'ambiguous');
  assert.equal(matchCompletion(i,input(r,{events:[event],manual:{[i.id]:{level:'complete'}}}),now).level,'target');
});
test('actual Learning completion matches pinned IDs; next step and unrelated plans do not replace today’s binding', () => {
  const options={clock:()=> '2026-09-09T01:00:00.000Z'};
  let p=createLearningPlan({title:'Course'},options); p=addPhase(p,{title:'Phase'},options); p=addLesson(p,p.phases[0].id,{title:'Lesson'},options); p=addStep(p,p.phases[0].lessons[0].id,{title:'First'},options); p=addStep(p,p.phases[0].lessons[0].id,{title:'Second'},options);
  const step=p.phases[0].lessons[0].steps[0]; p=completeStep(p,step.id,options);
  const store=createLocalLifeLedgerStore({storage:memory()}); store.upsertEvent(buildLearningPlanStepCompletedDraft(p,step.id,{sourceTimezone:tz}));
  const r=routine({source:'learning',planId:p.id}),i=instance(r), links={[i.id]:{planId:p.id,stepId:step.id}};
  assert.equal(matchCompletion(i,input(r,{links,events:store.listEvents()}),now).level,'complete');
  assert.equal(matchCompletion(i,input(r,{links:{[i.id]:{planId:p.id,stepId:'other'}},events:store.listEvents()}),now),null);
});
test('Focus requires linked completed outcome and matching source entry; abandoned/edited/deleted source cannot complete', () => {
  const r=routine({source:'focus'}),i=instance(r);
  const e={id:1,tsStart:Date.parse('2026-09-09T00:00:00Z'),ts:Date.parse('2026-09-09T00:15:00Z'),blockIntervalMin:15};
  const f={instanceId:i.id,entryId:'1',startedAt:e.tsStart,endedAt:e.ts,duration:15};
  assert.equal(matchCompletion(i,input(r,{entries:[e]}),now),null);
  assert.equal(matchCompletion(i,input(r,{entries:[e],focus:{1:f}}),now).level,'target');
  assert.equal(matchCompletion(i,input(r,{entries:[{...e,deleted:true}],focus:{1:f}}),now),null);
  assert.equal(matchCompletion(i,input(r,{entries:[{...e,blockIntervalMin:5}],focus:{1:f}}),now),null);
  assert.equal(matchCompletion(i,input(r,{entries:[e],focus:{1:{...f,instanceId:'unrelated'}}}),now),null);
});
test('streak counts consecutive calendar days, preserves yesterday until today expires', () => {
  const r=routine(), completed=new Set(['2026-09-06','2026-09-07']);
  assert.equal(routineStreak(r,'2026-09-08',d=>completed.has(d)),2);
  assert.equal(routineStreak(r,'2026-09-09',d=>completed.has(d)),0);
});
