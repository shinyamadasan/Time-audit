// Synthetic LOCAL contract proof. Production clients and rules remain byte-identical to b662d14.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {startEmulator, token} from '../rtdb-emulator-support.js';
import {connectSdk} from '../rtdb-sdk-support.js';
import {buildRules} from '../scripts/firebase-rules-builder.mjs';
import {buildPreparation, mergeDatePlans} from '../plan-tomorrow-model.js';
import {mergeCalendarPlanRecords} from '../calendar-plan-model.js';
import {itemRevision} from '../functions/src/plan-read.js';
import {buildOperationalPreparation, mergeOperationalPlanRecords} from '../operational-plan-model.js';
import * as old from './fixtures/plan-tomorrow-model.js';
import {STORES, CAPTURE, ITEM_ID, capture, claim, fencedItem, authorityFact,
  ACTION_PLAN, ACTION_A, actionItem, actionItemId, planActionToken, moveToken, movePatch, SERVER_TIME, MOVE_ACTION,
  ACTION_OTHER_PLAN} from '../fence-rules-fixtures.js';
import {META, MAX_REVISION, copy, canonical, revision, intent, transactionUpdate, proofRules} from './contract.js';
const OUT = new URL('../review-artifacts/task-039-stale-contract/', import.meta.url);
fs.mkdirSync(OUT, {recursive: true});
let emulator;
const connections = [], observations = [];
const room = uid => `rooms/uid_${uid}`;
const wire = value => JSON.parse(JSON.stringify(value, (_key, v) => v === null || Array.isArray(v) && v.length === 0 ? undefined : v));
const same = (a, b) => assert.deepEqual(canonical(a), canonical(b));
const denied = promise => assert.rejects(promise, error => /permission_denied/i.test(error.code || error.message));
const connect = (world, uid) => {const sdk = connectSdk(emulator, world, {uid}); connections.push(sdk); return sdk;};
const stamp = 1793203200000;
const entry = {id: 1213, tsStart: stamp - 600000, ts: stamp - 300000, blockIntervalMin: 5,
  date: '2026-10-28', activity: 'Historical time', energy: 'deep', onPlan: false,
  updatedAt: stamp, note: 'Preserve every original field', metadata: {unknownHistoricalField: 'exact'}};
const tombstone = {...entry, id: 1214, deleted: true};
const makePlan = def => {
  const input = {now: stamp, mode: 'normal', updatedBy: 'device-a', intentionalBlank: false,
    routineInstanceIds: [], oneOffItemIds: ['ordinary-1']};
  const preparation = def.store === 'operational'
    ? buildOperationalPreparation(null, {...input, targetOperationalDayId: def.targetId})
    : buildPreparation(null, {...input, targetDate: def.targetId.replace('cal1:', ''), timezone: 'Asia/Manila'});
  return wire({items: [{id: 'ordinary-1', task: 'Task', description: 'Earlier description', when: '', kind: 'task',
    done: false, deleted: false, updatedAt: stamp, updatedBy: 'device-a', extraHistorical: {retain: true}}],
    preparation, updatedAt: stamp, updatedBy: 'device-a', historicalMetadata: {source: 'synthetic original', firstSeen: stamp - 2000},
    ...(def.store === 'calendar' ? {createdAt: stamp - 1000, timezone: 'Asia/Manila'} : {})});
};
// Actual production merge functions produce the payload. The proof adapter carries the intent base separately.
function edit(def, before, description) {
  const updatedAt = before.updatedAt + 10;
  const local = {...copy(before), items: before.items.map(item => ({...item, description, updatedAt})),
    updatedAt, updatedBy: 'device-a'};
  const merge = def.store === 'legacy' ? mergeDatePlans : def.store === 'calendar' ? mergeCalendarPlanRecords : mergeOperationalPlanRecords;
  // Preserve untouched before-image fields, including preparation that an operational model can
  // omit after RTDB prunes its empty ID arrays. This retention is part of the proposed client change.
  return wire({...copy(before), ...merge(before, local, def.targetId)});
}
async function readAs(world, path, uid) {
  return fetch(`${emulator.base}/${path}.json?ns=${world.name}&auth=${token(uid)}`);
}
before(async () => {emulator = await startEmulator();});
after(async () => {
  await Promise.all(connections.map(sdk => sdk.close())); emulator?.stop();
  fs.writeFileSync(new URL('TEST_ONLY_RULES.json', OUT), JSON.stringify(proofRules(), null, 2) + '\n');
  fs.writeFileSync(new URL('OBSERVATIONS.json', OUT), JSON.stringify({baseline: 'b662d14616e5744807304d0621f6354392d2c2be',
    scope: 'synthetic local real RTDB emulator and SDK; proof adapters only', observations}, null, 2) + '\n');
});

for (const uid of ['alice', 'bob']) for (const def of Object.values(STORES)) {
  test(`${uid}/${def.store}: unversioned enrollment, stale replacements, real model edits and intentional revert`, async () => {
    const world = await emulator.fresh(proofRules()), path = `${room(uid)}/${def.plans}/${def.key}`;
    const initial = makePlan(def); await world.seed(path, initial);
    await world.seed(`${room(uid)}/entries`, {e_1213: entry, e_1214: tombstone});
    const oldReplacement = {...initial, items: [{...initial.items[0], description: 'stale'}]}; delete oldReplacement.preparation;
    assert.equal(await world.write(path, oldReplacement, token(uid)), false, 'legacy direct write before enrollment');
    assert.equal(await world.patch(path, {'items/0/description': 'stale'}, token(uid)), false, 'descendant write cannot bypass');
    assert.equal(await world.write(path, null, token(uid)), false, 'unversioned deletion denied');
    const first = intent(uid, path, initial, edit(def, initial, 'New description'));
    assert.equal(await world.write(path, first.after, token(uid)), true, 'enroll on legitimate edit');
    const current = await world.read(path); assert.equal(current.items[0].description, 'New description');
    same(current.preparation, initial.preparation); same(current.items[0].extraHistorical, initial.items[0].extraHistorical);
    // The very same old payload is now stale even if it preserves protocol metadata or stamps the wall clock.
    const stale = {...current, items: initial.items, updatedAt: stamp + 100000}; delete stale.preparation;
    assert.equal(await world.write(path, stale, token(uid)), false, 'copied unchanged revision rejected');
    assert.equal(await world.write(path, first.after, token(uid)), false, 'duplicate raw retry rejected, no second edit');
    const revert = intent(uid, path, current, edit(def, current, 'Earlier description'));
    assert.equal(await world.write(path, revert.after, token(uid)), true, 'intentional earlier-value edit accepted');
    const saved = await world.read(path); assert.equal(saved.items[0].description, 'Earlier description');
    assert.equal(revision(saved), 2); same(saved.preparation, initial.preparation);
    same(saved.historicalMetadata, initial.historicalMetadata);
    if (def.store === 'calendar') {assert.equal(saved.createdAt, initial.createdAt); assert.equal(saved.timezone, initial.timezone);}
    const staleIntent = intent(uid, path, initial, oldReplacement);
    assert.equal(await world.write(path, staleIntent.after, token(uid)), false, 'old before revision zero cannot overwrite rev2');
    assert.equal(await world.write(path, null, token(uid)), false, 'physical plan deletion cannot reset revision');
    assert.equal(await world.write(`${room(uid)}/${def.plans}`, {[def.key]: saved}, token(uid)), false, 'ancestor collection PUT closed');
    assert.equal(await world.write(room(uid), {}, token(uid)), false, 'whole room replacement closed');
    assert.equal(await world.write(path, revert.after, token(uid === 'alice' ? 'bob' : 'alice')), false);
    assert.equal((await readAs(world, path, uid === 'alice' ? 'bob' : 'alice')).status, 401);
    same(await world.read(path), saved);
    same(await world.read(`${room(uid)}/entries`), {e_1213: entry, e_1214: tombstone});
    observations.push({case: 'plan-revision', uid, store: def.store, enrolled: true, revert: true, legacyAndStaleDenied: true});
  });
}

test('actual pre-release model transaction and offline blind queue are refused in every store and account', async () => {
  for (const uid of ['alice', 'bob']) for (const def of Object.values(STORES)) {
    const world = await emulator.fresh(proofRules()), path = `${room(uid)}/${def.plans}/${def.key}`, initial = makePlan(def);
    await world.seed(path, initial); const sdk = connect(world, uid), ref = sdk.ref(path);
    await ref.once('value'); sdk.offline();
    const pending = ref.set(old.mergeDatePlans(initial, {items: initial.items, updatedAt: stamp + 1000}, '2026-10-03'))
      .then(() => null, error => error);
    sdk.online(); assert.match((await pending).code, /permission_denied/i); same(await world.read(path), initial);
    await denied(ref.transaction(remote => old.mergeDatePlans(remote, initial, '2026-10-03'), undefined, false));
    same(await world.read(path), initial);
  }
  observations.push({case: 'actual-legacy-sdk-offline-and-transaction', accounts: 2, stores: 3, allDenied: true});
});

test('existence is part of revision-zero before-image; legacy queues cannot be silently enrolled', async () => {
  const def = STORES.legacy, world = await emulator.fresh(proofRules()), path = `${room('alice')}/plans/${def.key}`;
  const initial = makePlan(def), queuedCreate = intent('alice', path, null, {...initial, items: [{...initial.items[0], task: 'offline create'}]});
  await world.seed(path, initial);
  assert.equal(await world.write(path, queuedCreate.after), false, 'absent base cannot overwrite present unversioned data');
  same(await world.read(path), initial);
  const emptyPath = `${room('alice')}/plans/${def.otherKey}`;
  assert.equal(await world.write(emptyPath, intent('alice', emptyPath, initial, initial).after), false, 'present base cannot invent a missing record');
  assert.equal(await world.write(emptyPath, intent('alice', emptyPath, null, initial).after), true, 'new current create allowed');
  // Proof adapter never manufactures a base from a legacy queue. A caller must possess its before-image.
  const unknownLegacyQueue = {owner: 'alice', path, after: initial};
  assert.equal(transactionUpdate(unknownLegacyQueue, initial, 'alice'), undefined);
  observations.push({case: 'enrollment', absentVsUnversionedDistinct: true, oldQueueNeedsExplicitReconciliation: true});
});

test('SDK transaction retries retain original before-image; conflict and account switch abort without clearing intent', async () => {
  const def = STORES.legacy, world = await emulator.fresh(proofRules()), path = `${room('alice')}/plans/${def.key}`;
  const initial = makePlan(def); await world.seed(path, initial);
  const a = connect(world, 'alice'), b = connect(world, 'alice');
  const keepCache = () => {};
  a.ref(path).on('value', keepCache); b.ref(path).on('value', keepCache);
  await a.ref(path).once('value'); await b.ref(path).once('value');
  const stale = intent('alice', path, initial, edit(def, initial, 'Stale local draft'));
  const fresh = intent('alice', path, initial, edit(def, initial, 'Other device edit'));
  const frozen = copy(stale), callbacks = []; let started;
  const callbackStarted = new Promise(resolve => {started = resolve;});
  // Cache a known before-image, then disconnect while device B commits.
  a.offline();
  const transaction = a.ref(path).transaction(remote => {callbacks.push(revision(remote)); started();
    return transactionUpdate(stale, remote, 'alice');}, undefined, false);
  await callbackStarted;
  assert.equal(await world.write(path, fresh.after), true);
  a.online(); const result = await transaction;
  assert.equal(result.committed, false); assert.ok(callbacks.length >= 2, 'real SDK reran callback');
  assert.ok(callbacks.includes(0) && callbacks.includes(1)); same(await world.read(path), fresh.after); same(stale, frozen);
  assert.equal(transactionUpdate(stale, initial, 'bob'), undefined, 'account switch aborts original owner intent');
  const current = intent('alice', path, fresh.after, edit(def, fresh.after, 'Earlier description'));
  await b.ref(path).once('value');
  const ok = await b.ref(path).transaction(remote => transactionUpdate(current, remote, 'alice'), undefined, false);
  assert.equal(ok.committed, true); same(await world.read(path), current.after);
  observations.push({case: 'transaction-retry', observedRevisions: callbacks, conflictAborted: true, pendingUntouched: true, intentionalRevertCommitted: true});
});

for (const uid of ['alice', 'bob']) test(`${uid}: recorded time, tombstones, explicit edits and undo retain revision guards`, async () => {
  const world = await emulator.fresh(proofRules()), path = `${room(uid)}/entries/e_1213`, deletedPath = `${room(uid)}/entries/e_1214`;
  await world.seed(path, entry); await world.seed(deletedPath, tombstone);
  assert.equal(await world.write(path, {...entry, activity: 'stale', updatedAt: stamp + 1}, token(uid)), false);
  const correction = intent(uid, path, entry, {...entry, activity: 'Legitimate correction', updatedAt: stamp + 2});
  assert.equal(await world.write(path, correction.after, token(uid)), true);
  const stale = intent(uid, path, entry, {...entry, tsStart: stamp, ts: stamp + 5000, updatedAt: stamp + 3});
  assert.equal(await world.write(path, stale.after, token(uid)), false, 'old timestamps cannot replace valid recorded time');
  const corrected = await world.read(path); same(corrected.metadata, entry.metadata);
  assert.equal(corrected.tsStart, entry.tsStart); assert.equal(corrected.ts, entry.ts);
  assert.equal(await world.write(path, null, token(uid)), false);
  const deleting = intent(uid, path, corrected, {...corrected, deleted: true, updatedAt: stamp + 4});
  assert.equal(await world.write(path, deleting.after, token(uid)), true);
  const illegalResurrection = {...deleting.after}; delete illegalResurrection.deleted;
  assert.equal(await world.write(path, intent(uid, path, deleting.after, illegalResurrection).after, token(uid)), false, 'revision does not weaken tombstone rules');
  const undo = {...illegalResurrection, undoRestoredAt: stamp + 5, updatedAt: stamp + 5};
  assert.equal(await world.write(path, intent(uid, path, deleting.after, undo).after, token(uid)), true, 'existing explicit undo remains allowed');
  assert.equal(await world.write(deletedPath, intent(uid, deletedPath, tombstone, entry).after, token(uid)), false);
  same(await world.read(deletedPath), tombstone);
});

for (const uid of ['alice', 'bob']) for (const def of Object.values(STORES)) {
  test(`${uid}/${def.store}: fenced description edits/reverts pass; stale source changes, relocation and resurrection fail`, async () => {
    const world = await emulator.fresh(proofRules()), path = `${room(uid)}/${def.fence}/${def.key}/${ITEM_ID}`;
    const initial = fencedItem(def, {description: 'Earlier description'});
    await world.seed(`${room(uid)}/brainDump/${CAPTURE}`, capture({promotionClaim: claim(def)})); await world.seed(path, initial);
    assert.equal(await world.write(path, {...initial, description: 'stale'}, token(uid)), false);
    const first = intent(uid, path, initial, {...initial, description: 'New description'});
    assert.equal(await world.write(path, first.after, token(uid)), true);
    const revert = intent(uid, path, first.after, {...first.after, description: 'Earlier description'});
    assert.equal(await world.write(path, revert.after, token(uid)), true);
    const corrupt = {...revert.after, brainDumpOrigin: {...initial.brainDumpOrigin, claimEpoch: 7}};
    assert.equal(await world.write(path, intent(uid, path, revert.after, corrupt).after, token(uid)), false);
    assert.equal(await world.write(path, intent(uid, path, revert.after, {...revert.after, movedToDayId: def.otherKey}).after, token(uid)), false);
    assert.equal(await world.write(path, null, token(uid)), false);
    const deleted = intent(uid, path, revert.after, {...revert.after, deleted: true});
    assert.equal(await world.write(path, deleted.after, token(uid)), true);
    assert.equal(await world.write(path, intent(uid, path, deleted.after, {...deleted.after, deleted: false}).after, token(uid)), false);
    same((await world.read(path)).brainDumpOrigin, initial.brainDumpOrigin);
  });
}

test('atomic two-plan move retains source/destination CAS; stale either end rejects entire update', async () => {
  const def = STORES.calendar, world = await emulator.fresh(proofRules()), base = `${room('alice')}/calendarPlans`;
  const from = `${base}/${def.key}`, to = `${base}/${def.otherKey}`, initial = makePlan(def);
  await world.seed(from, initial);
  const moved = {...initial.items[0], relocationRevision: {sequence: 1}, updatedAt: stamp + 2};
  const source = intent('alice', from, initial, {...initial, items: [{...moved, deleted: true, movedToDayId: def.otherId}]});
  const destination = intent('alice', to, null, {items: [moved], updatedAt: stamp + 2});
  const competing = intent('alice', to, null, {items: [{id: 'other', task: 'Other'}], updatedAt: stamp + 1});
  assert.equal(await world.write(to, competing.after), true);
  assert.equal(await world.patch(room('alice'), {[`calendarPlans/${def.key}`]: source.after, [`calendarPlans/${def.otherKey}`]: destination.after}), false);
  same(await world.read(from), initial); same(await world.read(to), competing.after);
  const rechecked = intent('alice', to, competing.after, {...competing.after, items: [...competing.after.items, moved]});
  // A source conflict must likewise reject BOTH ends. Then a newly reviewed source intent succeeds.
  const sourceEdit = intent('alice', from, initial, edit(def, initial, 'Concurrent source edit'));
  assert.equal(await world.write(from, sourceEdit.after), true);
  assert.equal(await world.patch(room('alice'), {[`calendarPlans/${def.key}`]: source.after, [`calendarPlans/${def.otherKey}`]: rechecked.after}), false);
  same(await world.read(to), competing.after); same(await world.read(from), sourceEdit.after);
  source.after = intent('alice', from, sourceEdit.after, {...sourceEdit.after,
    items: [{...sourceEdit.after.items[0], deleted: true, movedToDayId: def.otherId}]}).after;
  assert.equal(await world.patch(room('alice'), {[`calendarPlans/${def.key}`]: source.after, [`calendarPlans/${def.otherKey}`]: rechecked.after}), true);
  same(await world.read(from), source.after); same(await world.read(to), rechecked.after);
  assert.equal(await world.patch(room('alice'), {[`calendarPlans/${def.key}`]: source.after, [`calendarPlans/${def.otherKey}`]: rechecked.after}), false);
  observations.push({case: 'atomic-record-CAS', staleDestinationRejectedAtomically: true, staleSourceRejectedAtomically: true, supportedMove: true, duplicateDenied: true});
});

test('strict negative controls: disabling revision, existence or parent closure admits destructive writes', async () => {
  const def = STORES.legacy, initial = makePlan(def), path = `${room('alice')}/plans/${def.key}`;
  for (const mutation of ['revision', 'existence', 'parent']) {
    const world = await emulator.fresh(proofRules({checkRevision: mutation !== 'revision', checkExists: mutation !== 'existence', parentBypass: mutation === 'parent'}));
    await world.seed(path, initial);
    if (mutation === 'revision') {
      const first = intent('alice', path, initial, edit(def, initial, 'New'));
      assert.equal(await world.write(path, first.after), true);
      assert.equal(await world.write(path, intent('alice', path, initial, initial).after), true, 'mutant admits stale base');
    } else if (mutation === 'existence') {
      assert.equal(await world.write(path, intent('alice', path, null, initial).after), true, 'mutant confuses absent and unversioned');
    } else assert.equal(await world.write(path, null), true, 'ancestor grant overrides child deletion denial');
    observations.push({case: 'strict-mutation-control', mutation, unsafeAcceptedOnlyByMutant: true});
  }
});

test('revision shapes, safe integer boundary, token isolation and original Brain Dump source guards', async () => {
  const def = STORES.calendar, world = await emulator.fresh(proofRules()), path = `${room('alice')}/calendarPlans/${def.key}`, initial = makePlan(def);
  await world.seed(path, initial);
  const good = intent('alice', path, initial, initial);
  for (const meta of [null, {v: 2, baseExists: true, baseRevision: 0, revision: 1}, {...good.after[META], revision: 1.5},
    {...good.after[META], revision: MAX_REVISION + 1}, {...good.after[META], baseRevision: -1, revision: 0}, {...good.after[META], baseRevision: '0'}]) {
    assert.equal(await world.write(path, {...initial, [META]: meta}), false);
  }
  assert.equal(await world.write(path, good.after, token('alice', {chronasenseActionId: ACTION_A})), false);
  const max = {...initial, [META]: {v: 1, baseExists: true, baseRevision: MAX_REVISION - 1, revision: MAX_REVISION}};
  await world.seed(path, {...initial, [META]: {...max[META], revision: MAX_REVISION - 1}});
  assert.equal(await world.write(path, max), true); assert.throws(() => intent('alice', path, max, initial), /exhausted/);
  const capPath = `${room('alice')}/brainDump/${CAPTURE}`, original = capture(); await world.seed(capPath, original);
  const bad = capture({text: 'Changed source', promotionClaim: claim(def), claimEpoch: 1, updatedAt: stamp});
  assert.equal(await world.write(capPath, bad), false);
  same(await world.read(capPath), original);
  // Preserve the canonical capture/authority/token validation bytes; the contract adds no trusted client identity.
  same(proofRules().rules.rooms.$roomId.brainDump, buildRules().rules.rooms.$roomId.brainDump);
  same(proofRules().rules.rooms.$roomId.calendarPlanAuthority, buildRules().rules.rooms.$roomId.calendarPlanAuthority);
});

test('existing Action API create, owner edit, move lock and atomic fenced move remain expressible with the gate', async () => {
  const world = await emulator.fresh(proofRules()), base = `${room('alice')}/calendarPlanFences`, id = actionItemId(ACTION_A);
  const from = `${base}/${ACTION_PLAN}/${id}`, to = `${base}/${ACTION_OTHER_PLAN}/${id}`;
  await world.seed(`${room('alice')}/calendarPlanAuthority/fact1`, authorityFact);
  const create = intent('alice', from, null, actionItem());
  assert.equal(await world.write(from, create.after, planActionToken()), true);
  assert.equal(await world.write(to, create.after, planActionToken()), false, 'target token binding unchanged');
  const edit = intent('alice', from, create.after, {...create.after, description: 'Owner edit'});
  assert.equal(await world.write(from, edit.after), true);
  const lock = intent('alice', from, edit.after, {...edit.after,
    moveLock: {actionId: MOVE_ACTION, destination: ACTION_OTHER_PLAN, at: SERVER_TIME}});
  assert.equal(await world.write(from, lock.after, moveToken()), true);
  const locked = await world.read(from);
  assert.equal(await world.write(from, intent('alice', from, locked, {...locked, task: 'Bypass lock'}).after), false);
  const patch = movePatch();
  patch[`${ACTION_PLAN}/${id}`] = intent('alice', from, locked, {...locked, ...patch[`${ACTION_PLAN}/${id}`]}).after;
  delete patch[`${ACTION_PLAN}/${id}`].moveLock;
  patch[`${ACTION_OTHER_PLAN}/${id}`] = intent('alice', to, null, patch[`${ACTION_OTHER_PLAN}/${id}`]).after;
  assert.equal(await world.patch(base, patch, moveToken({uid: 'bob'})), false);
  assert.equal(await world.patch(base, patch, moveToken()), true);
  assert.equal((await world.read(from)).deleted, true); assert.equal((await world.read(to)).id, id);
  assert.equal(await world.patch(base, patch, moveToken()), false);
  // Cutover still prevents every legacy/operational write even with a correct protocol envelope.
  for (const def of [STORES.legacy, STORES.operational]) {
    const path = `${room('alice')}/${def.plans}/${def.key}`;
    assert.equal(await world.write(path, intent('alice', path, null, makePlan(def)).after), false);
  }
  observations.push({case: 'existing-action-fences', createEditLockMoveAllowed: true, ownershipScopeAndCutoverUnchanged: true});
});

test('before-image retention covers RTDB-pruned operational preparation and legitimate preparation confirmation', async () => {
  const def = STORES.operational, initial = makePlan(def);
  assert.equal(mergeOperationalPlanRecords(initial, initial, def.targetId).preparation, undefined,
    'baseline model drops preparation when RTDB omits empty routine IDs; not a contract proof pass');
  const after = edit(def, initial, 'Legitimate edit'); same(after.preparation, initial.preparation);
  const world = await emulator.fresh(proofRules()), path = `${room('alice')}/${def.plans}/${def.key}`;
  await world.seed(path, initial);
  const preparation = buildOperationalPreparation({...initial.preparation, routineInstanceIds: []}, {
    targetOperationalDayId: def.targetId, now: stamp + 50, mode: 'normal', updatedBy: 'device-a',
    intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['ordinary-1']});
  const confirmation = intent('alice', path, initial, {...initial, preparation: wire(preparation)});
  assert.equal(await world.write(path, confirmation.after), true);
  const saved = await world.read(path); assert.equal(saved.preparation.firstPreparedAt, initial.preparation.firstPreparedAt);
  assert.equal(saved.preparation.lastPreparedAt, stamp + 50);
  assert.equal(await world.write(path, intent('alice', path, initial, {...initial, preparation: {firstPreparedAt: 1}}).after), false);
  observations.push({case: 'operational-preparation', baselineModelDropsPrunedPreparation: true,
    proposedUntouchedFieldRetentionRequired: true, confirmationAllowed: true});
});

test('a counter must never be minted from retry data for an old replacement: explicit unsafe-adapter negative control', async () => {
  const def = STORES.legacy, world = await emulator.fresh(proofRules()), path = `${room('alice')}/plans/${def.key}`;
  const initial = makePlan(def); await world.seed(path, initial);
  const good = intent('alice', path, initial, edit(def, initial, 'New description'));
  assert.equal(await world.write(path, good.after), true);
  const pending = intent('alice', path, initial, initial);
  assert.equal(transactionUpdate(pending, good.after, 'alice'), undefined);
  // The owner can explicitly choose an earlier value; rules cannot infer whether a NEW correct-base
  // command reflects that choice or a broken adapter that silently re-authorized an old queue.
  const unsafeRebase = intent('alice', path, good.after, pending.after);
  assert.equal(await world.write(path, unsafeRebase.after), true, 'demonstrates scope of server guarantee, not safe retry policy');
  observations.push({case: 'unsafe-adapter-control', originalBaseAborts: true, fabricatedFreshBaseAllowed: true,
    implication: 'No automatic rebasing or enrollment of legacy pending replacements; explicit intent delta/conflict review required.'});
});

test('pre-cutover unversioned before-images differ despite equal zero revision; SDK exact comparison refuses stale intent', async () => {
  const def = STORES.legacy, world = await emulator.fresh(proofRules()), path = `${room('alice')}/plans/${def.key}`;
  const oldBefore = makePlan(def), currentBefore = edit(def, oldBefore, 'Pre-cutover remote edit');
  assert.equal(revision(oldBefore), 0); assert.equal(revision(currentBefore), 0);
  await world.seed(path, currentBefore);
  const sdk = connect(world, 'alice'); sdk.ref(path).on('value', () => {}); await sdk.ref(path).once('value');
  const pending = intent('alice', path, oldBefore, oldBefore), frozen = copy(pending);
  const result = await sdk.ref(path).transaction(remote => transactionUpdate(pending, remote, 'alice'), undefined, false);
  assert.equal(result.committed, false); same(await world.read(path), currentBefore); same(pending, frozen);
  assert.throws(() => intent('alice', path, undefined, oldBefore), /missing before-image/);
  assert.throws(() => intent('alice', path, {...oldBefore, [META]: false}, oldBefore), /invalid stored revision/);
  observations.push({case: 'unversioned-pre-cutover-staleness', equalRevisionZeroInsufficient: true,
    exactBeforeImageRequired: true, sdkAborted: true, pendingRetained: true});
});

test('first-null SDK cache cannot be mistaken for missing server data or a successful save', async () => {
  const def = STORES.legacy, world = await emulator.fresh(proofRules()), path = `${room('alice')}/plans/${def.key}`;
  const initial = makePlan(def); await world.seed(path, initial);
  const sdk = connect(world, 'alice'), pending = intent('alice', path, initial, edit(def, initial, 'Supported edit'));
  const attempts = [];
  const first = await sdk.ref(path).transaction(remote => {attempts.push(remote); return transactionUpdate(pending, remote, 'alice');}, undefined, false);
  assert.equal(first.committed, false); assert.equal(attempts[0], null); same(await world.read(path), initial);
  sdk.ref(path).on('value', () => {}); await sdk.ref(path).once('value');
  const retried = await sdk.ref(path).transaction(remote => transactionUpdate(pending, remote, 'alice'), undefined, false);
  assert.equal(retried.committed, true); same(await world.read(path), pending.after);
  observations.push({case: 'first-null-cache', refusedWithoutFalseSuccess: true, sameFrozenIntentLaterCommitted: true});
});

test('transport counters must be excluded from existing Action API semantic revisions and receipt comparisons', () => {
  const original = actionItem(), withCounter = intent('alice', 'fixture', null, original).after;
  assert.notEqual(itemRevision('calendar', ACTION_PLAN, withCounter), itemRevision('calendar', ACTION_PLAN, original),
    'baseline hashes unknown metadata, so a rules-only counter addition would change existing receipt semantics');
  const semanticRevision = item => {const content = copy(item); delete content[META]; return itemRevision('calendar', ACTION_PLAN, content);};
  const locked = intent('alice', 'fixture', withCounter, {...withCounter,
    moveLock: {actionId: MOVE_ACTION, destination: ACTION_OTHER_PLAN, at: stamp}}).after;
  assert.equal(semanticRevision(locked), itemRevision('calendar', ACTION_PLAN, original));
  assert.equal(semanticRevision(withCounter), itemRevision('calendar', ACTION_PLAN, original));
  assert.notEqual(semanticRevision({...locked, task: 'Real semantic edit'}), semanticRevision(locked));
  observations.push({case: 'existing-receipt-semantics', baselineHashesNewCounter: true,
    reservedTransportMetadataMustBeExcluded: true, semanticEditsStillChangeRevision: true});
});
