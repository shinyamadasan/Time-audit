import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDatePlans } from './plan-tomorrow-model.js';
import { mergeCalendarPlanRecords } from './calendar-plan-model.js';
import { mergeOperationalPlanRecords } from './operational-plan-model.js';
import { buildMovedItem } from './stale-plan-recovery-model.js';
import { legacyBoundaryRevision, proposeBoundaryRevision, operationalDayContaining, operationalDayId } from './personal-day-boundary-model.js';

const zone = 'Asia/Manila';
const revisions = proposeBoundaryRevision([legacyBoundaryRevision(zone)],{id:'r-1800',boundaryTime:'18:00',timezone:zone},Date.parse('2026-10-24T00:30:00Z')).revisions;
const dayId = operationalDayId(operationalDayContaining(Date.parse('2026-10-25T12:00:00Z'),revisions));
const stores = [
  ['legacy',(a,b)=>mergeDatePlans(a,b,'2026-10-25')],
  ['calendar',(a,b)=>mergeCalendarPlanRecords(a,b,'cal1:2026-10-25')],
  ['operational',(a,b)=>mergeOperationalPlanRecords(a,b,dayId)]
];
test('explicit unfinished recovery retains optional description without changing source identity',()=>{
  const source={id:'source-a',task:'Read feedback',description:'Keep this context',when:'20:00'};
  const before=JSON.stringify(source);
  const moved=buildMovedItem({carryId:'carry-a',sourceItem:source,sourceDayId:dayId,stamp:item=>({...item,updatedAt:200,updatedBy:'b'})});
  assert.equal(moved.description,source.description);
  assert.equal(moved.carriedFromId,source.id);
  assert.equal(moved.id,'carry-a');
  assert.equal(JSON.stringify(source),before);
});
for (const [name,merge] of stores) {
  test(`${name}: task description survives stale item delivery, confirmation copies and tombstones`,()=>{
    const older = {items:[{id:'task-a',task:'Review feedback',when:'',updatedAt:100,updatedBy:'a'}],updatedAt:100};
    const described = {items:[{...older.items[0],description:'Line one\nLiteral <text>',updatedAt:200,updatedBy:'b'}],updatedAt:200};
    const forward = merge(older,described);
    const reverse = merge(described,older);
    assert.deepEqual(forward.items,reverse.items);
    assert.equal(forward.items[0].description,'Line one\nLiteral <text>');
    const preparedCopy = {...forward,items:forward.items.map(item=>({...item}))};
    assert.equal(merge(preparedCopy,older).items[0].description,described.items[0].description);
    const removed = {...preparedCopy,items:preparedCopy.items.map(item=>({...item,deleted:true,updatedAt:300}))};
    const result = merge(removed,described).items[0];
    assert.equal(result.deleted,true);
    assert.equal(result.id,'task-a');
    assert.equal(result.description,described.items[0].description);
  });
}
