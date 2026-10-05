// plan-authority-fence.test.js
//
// V1 is LOCATION-BOUND: a Brain Dump task keeps one factual owner for its whole life. Normal same-target
// editing (title, time, duration, done, kind, cross-midnight timing) stays fully supported; any attempt to move
// it to another target fails clearly and BEFORE a source tombstone or a destination copy can exist. Run against
// the real calendar-native Plan Authority stack; fence-source-mutation.test.js proves each guard is load-bearing.

import test from 'node:test';
import assert from 'node:assert/strict';
import targaryen from 'targaryen';
import { readFileSync } from 'node:fs';

import { createPlanAuthority, BRAIN_DUMP_MOVE_REFUSED } from './plan-authority.js';
import { BRAIN_DUMP_MOVE_REFUSED as ORIGIN_COPY } from './plan-item-origin.js';
import { fakeDatabase } from './calendar-plan-test-support.js';
import { rulesEnforcingDatabase } from './brain-dump-test-support.js';
import { capture } from './fence-rules-fixtures.js';
import {
  SUN_ID, crossTargetMoveScenario, ghostPushScenario, ordinaryMoveScenario, presenceScenario, sameTargetEditScenario, wrongTargetWriteScenario,
} from './fence-scenarios.js';

const RULES = JSON.parse(readFileSync(new URL('./firebase.rules.json', import.meta.url), 'utf8'));

test('the refusal copy is one string, shared by the API, the editor and the docs', () => {
  assert.equal(BRAIN_DUMP_MOVE_REFUSED, ORIGIN_COPY);
  assert.equal(BRAIN_DUMP_MOVE_REFUSED, "Brain Dump tasks can't be moved to another day yet.");
});

test('API level: moving a fenced item to another target is refused with the clear copy, and NOTHING is written (no source tombstone, no destination ghost)', () => {
  const facts = crossTargetMoveScenario({ createPlanAuthority });
  assert.equal(facts.threw, BRAIN_DUMP_MOVE_REFUSED);
  assert.equal(facts.changed, false, 'the stored plans are byte-for-byte what they were');
  assert.equal(facts.destinationHasIt, false);
  assert.equal(facts.sourceTombstoned, false);
});

test('funnel level: even a caller that skips updateItem cannot write a fenced item into a plan its origin does not name', () => {
  const facts = wrongTargetWriteScenario({ createPlanAuthority });
  assert.equal(facts.threw, BRAIN_DUMP_MOVE_REFUSED);
  assert.equal(facts.written, false);
});

test('same-target edits stay fully supported, cross-midnight timing included, and the factual owner never changes', () => {
  const { stored, planIds } = sameTargetEditScenario({ createPlanAuthority });
  assert.equal(stored.task, 'renamed');
  assert.equal(stored.when, '01:00');
  assert.equal(stored.whenDayOffset, 1, 'Sunday-owned, reading Monday 01:00: a later calendar date, the SAME plan');
  assert.equal(stored.durationMinutes, 30);
  assert.equal(stored.done, false);
  assert.equal(stored.brainDumpOrigin.targetKey, SUN_ID, 'the origin is untouched');
  assert.deepEqual(planIds, [SUN_ID], 'no Monday-owned clone: the display date is not the factual owner');
});

test('an ORDINARY item still moves across plans exactly as before (the refusal is for fenced items only)', () => {
  assert.deepEqual(ordinaryMoveScenario({ createPlanAuthority }), { moved: true, destinationHasIt: true });
});

test('exact remote presence comes from the server child, whatever this device\'s cache holds', async () => {
  const db = fakeDatabase();
  assert.equal(await presenceScenario({ createPlanAuthority, db, remoteHasIt: true, localHasIt: false }), 'present', 'present remotely, absent locally');
  assert.equal(await presenceScenario({ createPlanAuthority, db: fakeDatabase(), remoteHasIt: false, localHasIt: true }), 'absent', 'a local ghost is NOT remote presence');
  assert.equal(await presenceScenario({ createPlanAuthority, db: fakeDatabase(), remoteHasIt: false, localHasIt: false }), 'absent');
  assert.equal(await presenceScenario({ createPlanAuthority, db: null, remoteHasIt: false, localHasIt: false }), 'unknown', 'no connection: unknown, never absent');
});

test('local ghost cleanup on the queue guard path is cache-only: nothing reaches the server, not even a tombstone', async () => {
  const db = rulesEnforcingDatabase({ targaryen, rules: RULES, uid: 'A' });
  db.seed('rooms/uid_A/brainDump/bfence1', capture({ claimEpoch: 1 }));
  const facts = await ghostPushScenario({ db, createPlanAuthority, createCalendarPlanSyncBridge: undefined, recoveredCapture: capture({ claimEpoch: 1 }) });
  assert.deepEqual(facts, { outcome: 'committed', denied: 0, onServer: false, stillLocal: false });
});
