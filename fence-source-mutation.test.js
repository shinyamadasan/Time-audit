// fence-source-mutation.test.js
//
// Mutation proof for the CLIENT half of the fence (firebase-rules-mutation.test.js does the rules half). Each
// test copies one shipped module, breaks exactly one guard in the copy, and runs the SAME scenario
// (fence-scenarios.js) that proves the shipped behavior. The mutant must visibly fail the scenario, or the guard
// is not load-bearing and a regression could ship unnoticed.
//
// Copies are written next to the sources (so their relative imports resolve) as `.mutant-*.js` and removed
// afterwards; they are never imported by anything but this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import targaryen from 'targaryen';

import { createPlanAuthority as createShippedPlanAuthority, BRAIN_DUMP_MOVE_REFUSED } from './plan-authority.js';
import { createCalendarPlanSyncBridge as createShippedCalendarBridge } from './calendar-plan-sync.js';
import { fakeDatabase } from './calendar-plan-test-support.js';
import { rulesEnforcingDatabase } from './brain-dump-test-support.js';
import { capture } from './fence-rules-fixtures.js';
import { crossTargetMoveScenario, ghostPushScenario, presenceScenario, wrongTargetWriteScenario } from './fence-scenarios.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = JSON.parse(readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8'));
const created = [];
test.after(() => { for (const file of created) { try { unlinkSync(file); } catch { /* already gone */ } } });

/** Imports a copy of `file` with each [from, to] edit applied; every edit must match exactly once (so a refactor
 *  that moves the guard breaks THIS test loudly instead of silently mutating nothing). */
async function mutant(file, edits, tag) {
  let source = readFileSync(path.join(HERE, file), 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of edits) {
    assert.equal(source.split(from).length - 1, 1, `${file}: the guard to remove must appear exactly once: ${from.slice(0, 80)}`);
    source = source.replace(from, to);
  }
  const out = path.join(HERE, `.mutant-${tag}-${file}`);
  writeFileSync(out, source);
  created.push(out);
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

const UPDATE_ITEM_REFUSAL = "    if (isFencedItem(current) && (destination.store !== sourceTarget.store || destination.id !== sourceTarget.id)) throw new Error(BRAIN_DUMP_MOVE_REFUSED);";
const FUNNEL_GUARD = "    assertFencedItemsBelong(target, nextItems);";

test('baseline: the shipped modules pass every scenario (so a failing mutant fails because of the mutation, nothing else)', async () => {
  const move = crossTargetMoveScenario({ createPlanAuthority: createShippedPlanAuthority });
  assert.equal(move.threw, BRAIN_DUMP_MOVE_REFUSED);
  assert.equal(move.changed, false);
  assert.equal(wrongTargetWriteScenario({ createPlanAuthority: createShippedPlanAuthority }).written, false);
});

test('mutant: the updateItem refusal alone removed — the saveItems funnel guard still refuses (two independent levels)', async () => {
  const { createPlanAuthority } = await mutant('plan-authority.js', [[UPDATE_ITEM_REFUSAL, '']], 'api');
  const move = crossTargetMoveScenario({ createPlanAuthority });
  assert.equal(move.threw, BRAIN_DUMP_MOVE_REFUSED, 'refused by the funnel');
  assert.equal(move.changed, false, 'and still nothing written');
});

test('mutant: the saveItems funnel guard alone removed — the updateItem refusal still refuses', async () => {
  const { createPlanAuthority } = await mutant('plan-authority.js', [[FUNNEL_GUARD, '']], 'funnel');
  assert.equal(crossTargetMoveScenario({ createPlanAuthority }).threw, BRAIN_DUMP_MOVE_REFUSED);
  assert.equal(wrongTargetWriteScenario({ createPlanAuthority }).written, true, 'but a caller that skips updateItem now lands a fenced item in the wrong plan');
});

test('KILLED mutant: cross-target refusal removed at BOTH levels — the editor move creates a destination ghost and a source tombstone', async () => {
  const { createPlanAuthority } = await mutant('plan-authority.js', [[UPDATE_ITEM_REFUSAL, ''], [FUNNEL_GUARD, '']], 'both');
  const move = crossTargetMoveScenario({ createPlanAuthority });
  assert.equal(move.threw, null, 'nothing refused it');
  assert.equal(move.destinationHasIt, true, 'a destination copy exists');
  assert.equal(move.sourceTombstoned, true, 'and a source tombstone: the two ghosts the V1 refusal exists to prevent');
});

test('KILLED mutant: local absence substituted for remote absence — Plan Authority answers from this device\'s cache', async () => {
  const { createPlanAuthority } = await mutant('plan-authority.js', [[
    "  function remoteItemPresence(target, itemId, { timeoutMs = 8000, expected = null } = {}) {\n    let read = null;",
    "  function remoteItemPresence(target, itemId) {\n    return Promise.resolve(rawItems(target).some(item => item.id === itemId) ? 'present' : 'absent');\n    // eslint-disable-next-line no-unreachable\n    let read = null;",
  ]], 'presence');
  // Present on the server but not in this cache: the mutant calls it absent (and would RECOVER a promoted capture).
  assert.equal(await presenceScenario({ createPlanAuthority, db: fakeDatabase(), remoteHasIt: true, localHasIt: false }), 'absent', 'wrongly absent');
  // A stale local ghost with no server child: the mutant calls it present (and would FINALIZE a capture with no destination).
  assert.equal(await presenceScenario({ createPlanAuthority, db: fakeDatabase(), remoteHasIt: false, localHasIt: true }), 'present', 'wrongly present');
  // The shipped module gets both right.
  assert.equal(await presenceScenario({ createPlanAuthority: createShippedPlanAuthority, db: fakeDatabase(), remoteHasIt: true, localHasIt: false }), 'present');
  assert.equal(await presenceScenario({ createPlanAuthority: createShippedPlanAuthority, db: fakeDatabase(), remoteHasIt: false, localHasIt: true }), 'absent');
});

test('mutant: the queue guard removed — local convergence degrades (a denied write) but the SERVER still keeps the ghost out', async () => {
  const recovered = capture({ claimEpoch: 1 });
  const run = async createCalendarPlanSyncBridge => {
    const db = rulesEnforcingDatabase({ targaryen, rules: RULES, uid: 'A' });
    db.seed('rooms/uid_A/brainDump/bfence1', recovered);
    return ghostPushScenario({ db, createPlanAuthority: createShippedPlanAuthority, createCalendarPlanSyncBridge, recoveredCapture: recovered });
  };
  const shipped = await run(createShippedCalendarBridge);
  assert.deepEqual(shipped, { outcome: 'committed', denied: 0, onServer: false, stillLocal: false }, 'guard on: withheld, zero denied writes, ghost purged locally');
  const { createCalendarPlanSyncBridge } = await mutant('calendar-plan-sync.js', [[
    "if (outbound.superseded.length && repository.dropItemsLocal(planId, outbound.superseded)) {", "if (false && outbound.superseded.length && repository.dropItemsLocal(planId, outbound.superseded)) {",
  ]], 'guard');
  const unguarded = await run(createCalendarPlanSyncBridge);
  assert.equal(unguarded.outcome, 'fence-denied');
  assert.equal(unguarded.denied, 1, 'convergence degrades: the server had to refuse it');
  assert.equal(unguarded.onServer, false, 'but disabling the guard NEVER permits remote corruption');
  assert.equal(unguarded.stillLocal, true, 'and the ghost lingers in this cache');
});
