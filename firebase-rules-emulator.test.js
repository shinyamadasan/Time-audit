// firebase-rules-emulator.test.js
//
// The location-bound Brain Dump promotion fence (firebase.rules.json, DECISIONS #33), proven
// against the REAL Firebase Realtime Database emulator, not an interpreter. Cross-path rules (a
// fenced item's validity depends on rooms/<room>/brainDump/<captureId>, and a capture's recovery
// depends on its destination child NOT existing) are exactly where a rules interpreter and the
// real server could disagree, so this boots the emulator jar, loads the real firebase.rules.json
// and drives it as an AUTHENTICATED ADVERSARY: the room owner writing RTDB directly, bypassing every
// client guard.
//
// Needs Java and the cached emulator jar (see rtdb-emulator-support.js). Run:
// npm run test:rules-emulator. It FAILS (never silently skips) when either is missing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALICE, MALLORY, ROOM, startEmulator, token } from './rtdb-emulator-support.js';
import { COMMAND_PATH, createActionApiHandler } from './functions/src/action-api.js';
import { actionActorRef } from './functions/src/envelope.js';
import { createInfraRtdb } from './functions/src/infra-rtdb.js';
import { createNonceStore, NONCE_ROOT } from './functions/src/nonce-store.js';
import { createReceiptStore } from './functions/src/receipts.js';
import { createUserScopedRtdb } from './functions/src/user-scoped-rtdb.js';
import { getBrainDump } from './functions/src/brain-dump-query.js';
import { KEYS, NOW_MS, signedRequest } from './functions/test/support.js';
import { localPlanDate } from './functions/shared/plan-tomorrow-model.js';
import { archiveCapture, buildCapture, claimPromotion, editHandledCapture, finalizePromotion,
  mergeCaptureRecords, normalizeCapture, reopenCapture, triageCapture } from './brain-dump-model.js';
import { wireCopy } from './brain-dump-test-support.js';
import {
  CAPTURE, ITEM_ID, STORES, T, capture, captureAt, claim, expired, fencedItem, legacyClaim, ordinary, origin, planRecord, promotedCapture, promotion,
  ACTION_A, ACTION_B, ACTION_OTHER_PLAN, ACTION_PLAN, actionItem, actionItemAt, actionItemId, planActionToken, seedCalendarAuthority,
  FENCES_AT, MOVE_ACTION, moveToken, movePatch, lockedItem, SERVER_TIME,
} from './fence-rules-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8');

let emulator;
test.before(async () => { emulator = await startEmulator(); });
test.after(() => emulator?.stop());
const freshDb = () => emulator.fresh(RULES);
const withActionClaim = actionId => {
  const [header, payload] = token('alice').split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return `${header}.${Buffer.from(JSON.stringify({ ...claims, chronasenseActionId: actionId })).toString('base64url')}.`;
};

/** The state in which a fenced item is authorized: a live claim at the exact location. */
async function liveClaim(db, def, extra = {}) { await db.seed(captureAt(), capture({ promotionClaim: claim(def), ...extra })); }
async function promoted(db, def, extra = {}) { await db.seed(captureAt(), promotedCapture(def, extra)); }
const otherStore = def => Object.values(STORES).find(o => o.store !== def.store);

for(const def of Object.values(STORES))test(`TASK-031 ${def.store}: server refuses stale-source new claims but permits current source and ordinary edits`,async()=>{
  const db=await freshDb();
  const remote=capture({text:'Newer source text',status:'triaged',important:true,urgent:false,triagedAt:T,updatedAt:T+2});
  await db.seed(captureAt(),remote);
  const next={...remote,promotionClaim:claim(def),updatedAt:T+3};
  for(const [field,value]of Object.entries({text:'Old source text',important:false,urgent:true,status:'untriaged'})) {
    assert.equal(await db.write(captureAt(),{...next,[field]:value}),false,`stale client cannot overwrite ${field}`);
  }
  const stale={...remote,text:'Old source text',urgent:true,updatedAt:T+1};
  const staleCandidate=claimPromotion(stale,{promotion:claim(def),now:T+3,updatedBy:'old-client'}).record;
  // The pre-fix active-source branch was exactly this unchanged merge function.
  const oldStaleOutput=wireCopy(mergeCaptureRecords(remote,staleCandidate));
  assert.equal(oldStaleOutput.text,'Old source text');
  assert.equal(await db.write(captureAt(),oldStaleOutput),false,'actual pre-fix arbitration output is refused');
  assert.deepEqual(await db.read(captureAt()),wireCopy(remote),'refusal leaves authoritative source exact');
  const matchingCandidate=claimPromotion(remote,{promotion:claim(def),now:T+3,updatedBy:'old-client'}).record;
  assert.equal(await db.write(captureAt(),wireCopy(mergeCaptureRecords(remote,matchingCandidate))),true,'same old-client algorithm succeeds with matching source');
  await db.seed(captureAt(),remote);
  assert.equal(await db.write(captureAt(),{...remote,text:'Explicit ordinary edit',updatedAt:T+4}),true);
  assert.equal(await db.write(captureAt(),{...next,text:'Explicit ordinary edit',updatedAt:T+5}),true,'matching current source claim succeeds');
});

test('Action API capture attribution requires its scoped claim and cannot be removed or changed by an ordinary owner', async () => {
  const db = await freshDb();
  const actionId = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const otherAction = 'act1_1b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const id = `bdc1_${actionId.slice(5)}`;
  const at = captureAt(id);
  const record = capture({ id, creationActionId: actionId });
  assert.equal(await db.write(at, record), false, 'ordinary owner cannot fabricate attribution');
  assert.equal(await db.write(at, record, withActionClaim(otherAction)), false, 'wrong action claim cannot create');
  assert.equal(await db.write(at, record, withActionClaim(actionId)), true, 'matching action claim creates');
  assert.equal(await db.write(at, { ...record, text: 'edited' }), true, 'ordinary owner may edit without losing attribution');
  assert.equal(await db.write(at, { ...record, creationActionId: undefined }), false, 'marker cannot be removed');
  assert.equal(await db.write(at, { ...record, creationActionId: otherAction }), false, 'marker cannot be changed');
  assert.equal(await db.write(captureAt('bnormal1'), capture({ id: 'bnormal1' })), true, 'ordinary unmarked capture remains supported');
});

test('action token can create only its marked capture; ordinary owner paths stay normal-token only', async () => {
  const db = await freshDb();
  const actionId = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const actionToken = withActionClaim(actionId);
  const id = `bdc1_${actionId.slice(5)}`;
  const at = captureAt(id);
  const record = capture({ id, creationActionId: actionId });
  const other = capture({ id: 'bnormal2' });
  const ordinaryWrites = [
    [`${ROOM}/settings`, { timezone: 'UTC' }],
    [`${ROOM}/entries/e1`, { id: 'e1', updatedAt: T }],
    [`${ROOM}/calendarPlans/cal1:2026-10-12`, { id: 'cal1:2026-10-12' }],
    [`${ROOM}/commitments`, { sample: true }],
    ['uid_alice/public', { sample: true }],
    ['uid_alice/pairCode', '1234'],
    ['pairs/p1', { creator: 'alice' }],
  ];
  for (const [path, value] of ordinaryWrites) {
    assert.equal(await db.write(path, value, actionToken), false, `action token denied at ${path}`);
    assert.equal(await db.write(path, value, ALICE), true, `ordinary owner allowed at ${path}`);
  }
  assert.equal(await db.write(captureAt(other.id), other, actionToken), false, 'action token cannot create an unmarked capture');
  assert.equal(await db.write(captureAt(other.id), other, ALICE), true);
  assert.equal(await db.write(captureAt(other.id), { ...other, text: 'changed' }, actionToken), false,
    'action token cannot edit an unrelated capture');
  assert.equal(await db.write(at, record, actionToken), true, 'action token creates the exact marked capture');
  assert.equal(await db.write(at, { ...record, text: 'changed' }, actionToken), false, 'action token cannot update even its marked capture');
  assert.equal(await db.write(at, { ...record, text: 'owner edit' }, ALICE), true, 'normal owner keeps existing capture edit authority');
});

test('current client preserves action attribution; stale-client drop is denied and current sync converges', async () => {
  const db = await freshDb();
  const actionId = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const id = `bdc1_${actionId.slice(5)}`;
  const at = captureAt(id);
  const built = buildCapture({ id, creationActionId: actionId, text: 'thought', now: T, updatedBy: 'action-actor' });
  assert.equal(built.ok, true);
  assert.equal(await db.write(at, built.record, withActionClaim(actionId)), true);
  const local = normalizeCapture(await db.read(at));
  assert.equal(local.creationActionId, actionId, 'current normalizer retains marker');
  const triaged = triageCapture(local, { important: true, urgent: false, now: T + 1, updatedBy: 'web' });
  assert.equal(triaged.record.creationActionId, actionId);
  assert.equal(await db.write(at, triaged.record, ALICE), true, 'current sync shape passes server rules');
  const archived = archiveCapture(triaged.record, { now: T + 2, updatedBy: 'web' });
  assert.equal(archived.record.creationActionId, actionId);
  const edited = editHandledCapture(archived.record, { text: 'edited thought', now: T + 3, updatedBy: 'web' });
  assert.equal(edited.record.creationActionId, actionId);
  const reopened = reopenCapture(edited.record, { now: T + 4, updatedBy: 'web' });
  assert.equal(reopened.record.creationActionId, actionId, 'reopen keeps marker');
  const claim = claimPromotion(triaged.record, { promotion: { type: 'do-today', store: 'calendar',
    targetId: 'cal1:2026-10-12', targetKey: 'cal1:2026-10-12', planItemId: `bdp1|${id}` },
  now: T + 2, updatedBy: 'web' });
  assert.equal(claim.record.creationActionId, actionId, 'promotion keeps marker on the capture');
  const finalized = finalizePromotion(claim.record, { now: T + 3, updatedBy: 'web' });
  assert.equal(finalized.record.creationActionId, actionId, 'finalization keeps marker');

  const { creationActionId: _droppedByOldNormalizer, ...stale } = normalizeCapture(await db.read(at));
  assert.ok(!Object.hasOwn(stale, 'creationActionId'), 'simulated old client strips unknown marker');
  const staleEdit = { ...stale, text: 'stale edit', updatedAt: T + 4, updatedBy: 'old-web' };
  assert.equal(await db.write(at, staleEdit, ALICE), false, 'stale whole-record write is rejected');
  assert.equal((await db.read(at)).text, triaged.record.text, 'server truth survives rejection');
  assert.equal((await db.read(at)).creationActionId, actionId);
  const converged = mergeCaptureRecords(staleEdit, normalizeCapture(await db.read(at)));
  assert.equal(converged.creationActionId, actionId, 'current merge restores immutable marker');
  assert.equal(await db.write(at, converged, ALICE), true, 'current client can sync after stale rejection');
  assert.equal((await db.read(at)).creationActionId, actionId);
});

for (const def of Object.values(STORES)) {
  const { store } = def;

  test(`${store}: ordinary owner items stay writable; an outsider is denied; a valid fenced create is allowed and the plan record is untouched`, async () => {
    const db = await freshDb();
    assert.equal(await db.write(def.planAt, planRecord([ordinary])), true, 'ordinary owner create');
    assert.equal(await db.write(def.planAt, planRecord([{ ...ordinary, task: 'edited' }])), true, 'ordinary owner edit');
    assert.equal(await db.write(def.planAt, planRecord([ordinary]), MALLORY), false, 'outsider write');
    assert.equal(await db.write(def.itemAt, fencedItem(def), MALLORY), false, 'outsider fenced write');
    await liveClaim(db, def);
    assert.equal(await db.write(def.itemAt, fencedItem(def)), true, 'exact location, live claim');
    assert.deepEqual((await db.read(def.planAt)).items.map(i => i.id), ['pnormal1'], 'the plan record never holds the fenced item');
    assert.equal(await db.write(def.itemAt, fencedItem(def, { task: 'renamed' })), true, 'a same-target edit while the claim is live');
  });

  test(`${store}: wrong LOCATION is denied (the path is the authorization identity)`, async () => {
    const db = await freshDb();
    await liveClaim(db, def);
    assert.equal(await db.write(def.fenceAt(def.otherKey), fencedItem(def)), false, 'authorized for key A, written under key B (origin names A)');
    assert.equal(await db.write(def.fenceAt(def.otherKey), fencedItem(def, { origin: { targetKey: def.otherKey } })), false, 'origin rewritten to the path, but the claim still names A');
    await db.seed(captureAt(), capture({ promotionClaim: claim(def, { targetKey: def.otherKey }) }));
    assert.equal(await db.write(def.itemAt, fencedItem(def)), false, 'the claim names another location than this one');
  });

  test(`${store}: wrong STORE is denied, including a replay into another store's fence collection`, async () => {
    const db = await freshDb();
    await liveClaim(db, def);
    for (const other of Object.values(STORES).filter(o => o.store !== store)) {
      assert.equal(await db.write(`${ROOM}/${other.fence}/${other.key}/${ITEM_ID}`, fencedItem(def)), false, `${store} item replayed into ${other.store}'s collection (origin names ${store})`);
      assert.equal(await db.write(`${ROOM}/${other.fence}/${other.key}/${ITEM_ID}`, fencedItem(other)), false, `${other.store} origin, but the claim is ${store}'s`);
    }
    assert.equal(await db.write(def.itemAt, fencedItem(def, { origin: { store: otherStore(def).store } })), false, 'origin.store rewritten');
  });

  test(`${store}: wrong CAPTURE, malformed id, capture swap and an arbitrary key are denied`, async () => {
    const db = await freshDb();
    await liveClaim(db, def);
    const at = id => def.fenceAt(def.key).replace(ITEM_ID, id);
    assert.equal(await db.write(at('bdp1|bnobody1'), fencedItem(def, { id: 'bdp1|bnobody1' })), false, 'no such capture');
    assert.equal(await db.write(def.itemAt, fencedItem(def, { id: 'bdp1|bother001' })), false, 'body id differs from the key');
    assert.equal(await db.write(at('plain-key'), fencedItem(def, { id: 'plain-key' })), false, 'a key outside the bdp1 grammar');
    assert.equal(await db.write(at('bdp1|'), fencedItem(def, { id: 'bdp1|' })), false, 'empty suffix');
    // Capture swap: capture B is claimed for location B; the item for capture A is replayed at B.
    const other = 'bfence2';
    await db.seed(captureAt(other), capture({ id: other, promotionClaim: claim(def, { planItemId: `bdp1|${other}`, targetKey: def.otherKey, targetId: def.otherId }) }));
    assert.equal(await db.write(def.fenceAt(def.otherKey), fencedItem(def, { origin: { targetKey: def.otherKey } })), false, 'capture A\'s item at capture B\'s location');
    assert.equal(await db.write(def.fenceAt(def.otherKey).replace(ITEM_ID, `bdp1|${other}`), fencedItem(def, { id: `bdp1|${other}`, origin: { targetKey: def.otherKey } })), true, 'capture B\'s own item at its own location is fine');
  });

  test(`${store}: wrong epoch, wrong type, missing and malformed origin are denied`, async () => {
    const db = await freshDb();
    await liveClaim(db, def);
    assert.equal(await db.write(def.itemAt, fencedItem(def, { origin: { claimEpoch: 1 } })), false, 'epoch ahead of the capture');
    assert.equal(await db.write(def.itemAt, fencedItem(def, { origin: { type: 'schedule' } })), false, 'wrong type');
    const noOrigin = fencedItem(def); delete noOrigin.brainDumpOrigin;
    assert.equal(await db.write(def.itemAt, noOrigin), false, 'missing origin');
    const without = key => { const o = origin(def); delete o[key]; return o; };
    for (const [label, bad] of Object.entries({
      'v:1': origin(def, { v: 1 }), 'string epoch': origin(def, { claimEpoch: '0' }), 'missing store': without('store'),
      'missing targetKey': without('targetKey'), 'extra key': { ...origin(def), evil: true }, 'numeric targetKey': origin(def, { targetKey: 7 }),
    })) assert.equal(await db.write(def.itemAt, fencedItem(def, { brainDumpOrigin: bad })), false, `malformed origin: ${label}`);
    // The same item, correctly formed, is accepted: the refusals above were about the origin, nothing else.
    assert.equal(await db.write(def.itemAt, fencedItem(def)), true);
  });

  test(`${store}: a newer generation is accepted only at its own epoch; the stale one is denied`, async () => {
    const db = await freshDb();
    await db.seed(captureAt(), capture({ claimEpoch: 1, promotionClaim: claim(def, { claimedAt: T + 20 }), expiredClaim: expired(def) }));
    assert.equal(await db.write(def.itemAt, fencedItem(def, { origin: { claimEpoch: 0 } })), false, 'G0 item vs a capture now at epoch 1');
    assert.equal(await db.write(def.itemAt, fencedItem(def, { origin: { claimEpoch: 1 } })), true, 'G1 item');
    assert.equal(await db.write(def.itemAt, fencedItem(def, { origin: { claimEpoch: 0 } })), false, 'an update cannot step the origin back to G0');
  });

  test(`${store}: REVOKED generation authorizes no create and no edit (the freeze), a late stale writer is refused`, async () => {
    const db = await freshDb();
    await db.seed(captureAt(), capture({ promotionClaim: claim(def, { revokedAt: T + 5 }) }));
    assert.equal(await db.write(def.itemAt, fencedItem(def)), false, 'late stale G1 writer after the revoke');
    // An item that already exists is frozen too while the outcome is resolved.
    await db.seed(def.itemAt, fencedItem(def));
    assert.equal(await db.write(def.itemAt, fencedItem(def, { task: 'edited' })), false, 'edit while revoked');
  });

  test(`${store}: a PROMOTED generation: a late first create is accepted, same-target edits all work, the origin is immutable`, async () => {
    const db = await freshDb();
    await promoted(db, def);
    assert.equal(await db.write(def.itemAt, fencedItem(def)), true, 'a late create after finalize (offline-first)');
    for (const [label, edit] of Object.entries({
      title: { task: 'renamed' }, 'start time': { when: '15:00' }, 'next-day reading (cross-midnight, same owner)': { when: '01:00', whenDayOffset: 1, whenTz: 'Asia/Manila' },
      duration: { when: '15:00', durationMinutes: 45 }, done: { done: true, doneAt: T + 9 }, kind: { kind: 'priority' }, metadata: { updatedAt: T + 10, updatedBy: 'e', reason: 'slipped' },
    })) assert.equal(await db.write(def.itemAt, fencedItem(def, edit)), true, `edit: ${label}`);
    for (const [label, bad] of Object.entries({
      type: { type: 'schedule' }, epoch: { claimEpoch: 3 }, store: { store: otherStore(def).store }, targetKey: { targetKey: def.otherKey }, version: { v: 1 },
    })) assert.equal(await db.write(def.itemAt, fencedItem(def, { origin: bad })), false, `origin mutation: ${label}`);
    assert.equal(await db.write(def.itemAt, fencedItem(def, { id: 'bdp1|bother001' })), false, 'item-id mutation');
    const stripped = fencedItem(def); delete stripped.brainDumpOrigin;
    assert.equal(await db.write(def.itemAt, stripped), false, 'origin stripping');
    assert.equal(await db.write(def.itemAt, { ...fencedItem(def), brainDumpOrigin: null }), false, 'origin deleted');
    assert.equal(await db.write(def.itemAt, { ...ordinary, id: ITEM_ID }), false, 'converted to an ordinary item (fenced -> ordinary)');
  });

  test(`${store}: cross-target relocation is refused by the server: no destination, no relocation metadata`, async () => {
    const db = await freshDb();
    await promoted(db, def);
    assert.equal(await db.write(def.itemAt, fencedItem(def)), true);
    assert.equal(await db.write(def.fenceAt(def.otherKey), fencedItem(def)), false, 'a second copy at another target of the same store');
    assert.equal(await db.write(def.fenceAt(def.otherKey), fencedItem(def, { origin: { targetKey: def.otherKey } })), false, 'the same, with the origin rewritten');
    assert.equal(await db.write(def.itemAt, fencedItem(def, { relocationRevision: { schemaVersion: 1, sequence: 1, fromDayId: def.targetId, toDayId: def.otherId, updatedBy: 'd' } })), false, 'relocation metadata');
    assert.equal(await db.write(def.itemAt, fencedItem(def, { deleted: true, movedToDayId: def.otherId })), false, 'a tombstone claiming a move');
    // And as an ordinary array item in another day's plan record:
    assert.equal(await db.write(`${ROOM}/${def.plans}/${def.otherKey}`, planRecord([fencedItem(def)])), false, 'the fenced item smuggled into another day\'s ordinary array');
  });

  test(`${store}: tombstone is monotonic: stays at its stable child, can never be cleared or removed, and counts as present`, async () => {
    const db = await freshDb();
    await promoted(db, def);
    assert.equal(await db.write(def.itemAt, fencedItem(def)), true);
    assert.equal(await db.write(def.itemAt, fencedItem(def, { deleted: true, updatedAt: T + 11 })), true, 'user deletes (tombstone)');
    assert.equal(await db.write(def.itemAt, fencedItem(def, { deleted: true, task: 'still gone', updatedAt: T + 12 })), true, 'a tombstone stays editable');
    assert.equal(await db.write(def.itemAt, fencedItem(def, { deleted: false, updatedAt: T + 99 })), false, 'a stale client clears the deletion');
    assert.equal(await db.write(def.itemAt, fencedItem(def, { updatedAt: T + 100 })), false, 'a stale create replays the live item (resurrection)');
    assert.equal(await db.write(def.itemAt, null), false, 'physical removal of the tombstone');
    assert.equal((await db.read(def.itemAt)).deleted, true);
    assert.equal((await db.read(captureAt())).status, 'promoted', 'the capture stays promoted after its item was deleted');
  });

  test(`${store}: parent overwrites cannot bypass the item rule (no grant exists above the item)`, async () => {
    const db = await freshDb();
    await liveClaim(db, def);
    assert.equal(await db.write(def.itemAt, fencedItem(def)), true);
    const good = fencedItem(def, { task: 'ok' });
    const forged = fencedItem(def, { origin: { claimEpoch: 5 } });
    assert.equal(await db.write(`${ROOM}/${def.fence}/${def.key}`, { [ITEM_ID]: good }), false, 'whole target overwrite, even with only a good item');
    assert.equal(await db.write(`${ROOM}/${def.fence}/${def.key}`, { [ITEM_ID]: forged, 'bdp1|bother001': good }), false, 'whole target overwrite with mixed good and bad');
    assert.equal(await db.write(`${ROOM}/${def.fence}`, { [def.key]: { [ITEM_ID]: forged } }), false, 'whole collection overwrite');
    assert.equal(await db.write(`${ROOM}/${def.fence}`, null), false, 'whole collection delete');
    assert.equal(await db.write(`${ROOM}/${def.fence}/${def.key}`, null), false, 'whole target delete');
    assert.equal(await db.write(ROOM, { [def.fence]: { [def.key]: { [ITEM_ID]: forged } } }), false, 'the whole room');
    assert.equal(await db.patch(ROOM, { [`${def.fence}/${def.key}/${ITEM_ID}`]: forged }), false, 'a multi-path update naming the item');
    assert.equal(await db.patch(ROOM, { [`${def.fence}/${def.key}/${ITEM_ID}/brainDumpOrigin/claimEpoch`]: 5 }), false, 'a direct child write of the origin');
    assert.equal(await db.patch(ROOM, { [`${def.fence}/${def.key}/${ITEM_ID}/task`]: 'direct child edit' }), true, 'an ordinary direct child edit is judged as the whole item and passes');
    assert.equal((await db.read(def.itemAt)).task, 'direct child edit');
    assert.equal((await db.read(def.itemAt)).brainDumpOrigin.claimEpoch, 0, 'nothing forged landed');
  });

  test(`${store}: ordinary plan arrays — pre-fence Brain Dump items are authorized by capture state alone; fenced and forged ones are refused`, async () => {
    const db = await freshDb();
    const legacyItem = { id: ITEM_ID, task: 'old', when: '', done: false, updatedAt: T, updatedBy: 'old', kind: 'task' };
    assert.equal(await db.write(def.planAt, planRecord([ordinary, legacyItem])), false, 'no capture at all');
    await db.seed(captureAt(), capture({ schemaVersion: 1, promotionClaim: legacyClaim(def) }));
    assert.equal(await db.write(def.planAt, planRecord([ordinary, legacyItem])), true, 'a pre-fence client\'s item under its own pre-fence claim');
    assert.equal(await db.write(def.planAt, planRecord([ordinary, { ...legacyItem, task: 'edited' }])), true, 'and its ordinary edit');
    await db.seed(captureAt(), capture({ schemaVersion: 1, status: 'promoted', disposedAt: T + 3, promotion: { type: 'do-today', store: def.store, targetId: def.targetId, planItemId: ITEM_ID, promotedAt: T + 3 } }));
    assert.equal(await db.write(def.planAt, planRecord([ordinary, legacyItem])), true, 'a pre-fence promoted capture keeps its item writable');
    assert.equal(await db.write(`${ROOM}/${def.plans}/${def.otherKey}`, planRecord([legacyItem])), true, 'a pre-fence item that was moved by an ordinary edit stays writable (not location-bound)');
    assert.equal(await db.write(def.planAt, planRecord([ordinary, { ...legacyItem, brainDumpOrigin: origin(def) }])), false, 'an origin-bearing item can never live in an ordinary array');
    assert.equal(await db.write(def.planAt, planRecord([ordinary, { ...ordinary, id: 'bdp1|bunknown1' }])), false, 'an ordinary item renamed into the bdp1 namespace');
    assert.equal(await db.write(def.planAt, planRecord([ordinary, { ...ordinary, id: 'bdp1|bad id!' }])), false, 'malformed bdp1 id');
    // A FENCED capture's item is refused in an array.
    await db.seed(captureAt(), capture({ promotionClaim: claim(def) }));
    assert.equal(await db.write(def.planAt, planRecord([ordinary, legacyItem])), false, 'the capture is fenced now: its item lives in the fence collection');
    await db.seed(captureAt(), promotedCapture(def));
    assert.equal(await db.write(def.planAt, planRecord([ordinary, legacyItem])), false, 'a fenced promotion too');
    assert.equal(await db.write(def.planAt, planRecord([ordinary])), true, 'the day itself stays writable');
  });

  test(`${store}: an OLD client's whole-record write leaves the fenced child alone and is not blocked by it`, async () => {
    const db = await freshDb();
    await promoted(db, def);
    assert.equal(await db.write(def.itemAt, fencedItem(def, { task: 'fenced task', updatedAt: T + 4 })), true);
    // The old client has never seen the fence collection: it rewrites its whole record, reordering its items.
    assert.equal(await db.write(def.planAt, planRecord([ordinary, { ...ordinary, id: 'pnormal2', task: 'second' }])), true, 'ordinary edit');
    assert.equal(await db.write(def.planAt, planRecord([{ ...ordinary, id: 'pnormal2', task: 'second' }, { ...ordinary, task: 'edited' }])), true, 'reordered whole-record rewrite');
    assert.equal(await db.write(def.planAt, null), true, 'even deleting its own record');
    const fenced = await db.read(def.itemAt);
    assert.equal(fenced.task, 'fenced task');
    assert.equal(fenced.brainDumpOrigin.targetKey, def.key, 'the fenced item survived byte-for-byte');
  });

  test(`${store}: the calendar cutover barrier applies to the fence collections exactly as it applies to the plan records`, async () => {
    const db = await freshDb();
    await promoted(db, def);
    assert.equal(await db.write(def.itemAt, fencedItem(def)), true, 'before the cutover');
    // The account activates calendar-native plans: legacy and operational plan records become read-only.
    await db.seed(`${ROOM}/calendarPlanAuthority/fact1`, { schemaVersion: 1, id: 'fact1', activatedAtMs: T, timezone: 'Asia/Manila', activationDate: '2026-10-03', deviceId: 'd' });
    const barred = store !== 'calendar';
    assert.equal(await db.write(def.itemAt, fencedItem(def, { task: 'after cutover', updatedAt: T + 20 })), !barred, `a fenced ${store} edit after the cutover`);
    assert.equal(await db.write(def.planAt, planRecord([ordinary])), !barred, `the ${store} plan record after the cutover (the same barrier)`);
  });

  test(`${store}: recovery protocol — revoke, then recover only when the exact destination is absent; finalize only when it is present`, async () => {
    const revoked = capture({ promotionClaim: claim(def, { revokedAt: T + 5 }), updatedAt: T + 5 });
    const recovered = capture({ claimEpoch: 1, updatedAt: T + 6, expiredClaim: expired(def) });
    const db = await freshDb();
    await liveClaim(db, def);
    assert.equal(await db.write(captureAt(), revoked), true, 'revoke (same claim + revokedAt)');
    // Destination absent: recover (epoch + 1), claim removed.
    assert.equal(await db.write(captureAt(), recovered), true, 'recovered to triage at epoch + 1');
    assert.equal(await db.write(def.itemAt, fencedItem(def)), false, 'the old generation can never land afterwards');
    // Destination PRESENT: recovery is refused; finalize is accepted.
    const db2 = await freshDb();
    await liveClaim(db2, def);
    assert.equal(await db2.write(def.itemAt, fencedItem(def)), true, 'the item landed first');
    assert.equal(await db2.write(captureAt(), revoked), true, 'revoke');
    assert.equal(await db2.write(captureAt(), recovered), false, 'recovery with the destination present');
    assert.equal(await db2.write(captureAt(), promotedCapture(def, { updatedAt: T + 7 })), true, 'finalize: destination present');
    // Finalizing a REVOKED claim whose destination is absent is refused.
    const db3 = await freshDb();
    await db3.seed(captureAt(), revoked);
    assert.equal(await db3.write(captureAt(), promotedCapture(def, { updatedAt: T + 7 })), false, 'finalize a revoked claim with NO destination');
    // A destination that exists at a different epoch is not "present" for finalize.
    const db4 = await freshDb();
    await db4.seed(captureAt(), revoked);
    await db4.seed(def.itemAt, fencedItem(def, { origin: { claimEpoch: 7 } }));
    assert.equal(await db4.write(captureAt(), promotedCapture(def, { updatedAt: T + 7 })), false, 'a different generation\'s child is not this generation\'s destination');
    assert.equal(await db4.write(captureAt(), recovered), false, 'and it is not absent either: recovery stays refused');
  });
}

// ── the capture state machine ───────────────────────────────────────────────

const CAL = STORES.calendar;

test('capture: a live claim may only become the SAME claim + an immutable revokedAt; nothing else', async () => {
  const db = await freshDb();
  await liveClaim(db, CAL);
  assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL) })), true, 'idempotent re-write');
  for (const [label, changed] of Object.entries({
    planItemId: { planItemId: 'bdp1|bother001' }, targetKey: { targetKey: CAL.otherKey }, targetId: { targetId: CAL.otherId }, store: { store: 'legacy' }, type: { type: 'schedule' },
    claimedAt: { claimedAt: T + 99 }, claimedBy: { claimedBy: 'someone-else' }, when: { when: '15:00' }, duration: { durationMinutes: 30 },
  })) assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL, changed) })), false, `same-epoch claim replacement: ${label}`);
  assert.equal(await db.write(captureAt(), capture({})), false, 'claim deletion');
  assert.equal(await db.write(captureAt(), capture({ status: 'archived', disposedAt: T + 4 })), false, 'a stale archive over a claim');
  assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL, { revokedAt: T + 5 }) })), true, 'revoke');
  assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL) })), false, 'un-revoke');
  assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL, { revokedAt: T + 50 }) })), false, 'change revokedAt');
  assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL, { revokedAt: T + 5 }), updatedAt: T + 60 })), true, 'the same revoked claim again');
  assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL, { claimedAt: T, revokedAt: T + 5 }) })), false, 'a replaced revoked claim');
});

test('capture: claimEpoch is an integer that only moves +1, only through recovery; decrement, omission, skip and bare bumps are denied', async () => {
  const db = await freshDb();
  await db.seed(captureAt(), capture({ claimEpoch: 2, promotionClaim: claim(CAL, { revokedAt: T + 5 }) }));
  assert.equal(await db.write(captureAt(), capture({ claimEpoch: 1, promotionClaim: claim(CAL, { revokedAt: T + 5 }) })), false, 'decrement');
  assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL, { revokedAt: T + 5 }) })), false, 'omission (= 0)');
  assert.equal(await db.write(captureAt(), capture({ claimEpoch: 4 })), false, 'skip +2 (and drop the claim)');
  assert.equal(await db.write(captureAt(), capture({ claimEpoch: 3, promotionClaim: claim(CAL, { revokedAt: T + 5 }) })), false, 'bump while keeping the claim');
  assert.equal(await db.write(captureAt(), capture({ claimEpoch: 2.5 })), false, 'a fractional epoch');
  assert.equal(await db.write(captureAt(), capture({ claimEpoch: 3, expiredClaim: expired(CAL) })), true, 'recovery: revoked claim, destination absent, +1');
  const bare = await freshDb();
  await bare.seed(captureAt(), capture({ claimEpoch: 1 }));
  assert.equal(await bare.write(captureAt(), capture({ claimEpoch: 2 })), false, 'a bare bump with no claim is not a recovery');
  assert.equal(await bare.write(captureAt(), capture({ claimEpoch: 1, text: 'edited' })), true, 'ordinary edits at the same epoch');
});

test('capture: recovery needs the claim REVOKED first; finalize of an unrevoked claim needs no proof (offline-first), a promoted capture is terminal', async () => {
  const db = await freshDb();
  await liveClaim(db, CAL);
  assert.equal(await db.write(captureAt(), capture({ claimEpoch: 1, expiredClaim: expired(CAL) })), false, 'recover an UNREVOKED claim');
  assert.equal(await db.write(captureAt(), promotedCapture(CAL)), true, 'finalize before the item has landed');
  assert.equal(await db.write(captureAt(), promotedCapture(CAL, { promotion: promotion(CAL, { targetKey: CAL.otherKey }) })), false, 'promotion identity is immutable');
  assert.equal(await db.write(captureAt(), promotedCapture(CAL, { promotion: promotion(CAL, { planItemId: 'bdp1|bother001' }) })), false, 'promotion planItemId immutable');
  assert.equal(await db.write(captureAt(), capture({})), false, 'un-promote');
  assert.equal(await db.write(captureAt(), promotedCapture(CAL, { claimEpoch: 1 })), false, 'promoted: epoch frozen');
  assert.equal(await db.write(captureAt(), promotedCapture(CAL, { promotionClaim: claim(CAL) })), false, 'a promoted capture cannot grow a claim');
  assert.equal(await db.write(captureAt(), promotedCapture(CAL, { text: 'still editable provenance', updatedAt: T + 9 })), true, 'ordinary field edits of a promoted record');
});

test('capture: a promotion cannot appear without a claim; a new claim needs an active capture, the right item id and no revoke', async () => {
  const db = await freshDb();
  await db.seed(captureAt(), capture({}));
  assert.equal(await db.write(captureAt(), promotedCapture(CAL)), false, 'promoted out of nowhere');
  assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL, { planItemId: 'bdp1|bother001' }) })), false, 'claim for another capture\'s item id');
  assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL, { revokedAt: T + 2 }) })), false, 'a claim born revoked');
  assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL, { store: 'nowhere' }) })), false, 'unknown store');
  assert.equal(await db.write(captureAt(), capture({ promotionClaim: claim(CAL) })), true, 'a proper claim');
  const archived = await freshDb();
  await archived.seed(captureAt(), capture({ status: 'archived', disposedAt: T + 2 }));
  assert.equal(await archived.write(captureAt(), capture({ status: 'archived', disposedAt: T + 2, promotionClaim: claim(CAL) })), false, 'claim on an archived capture');
  assert.equal(await archived.write(captureAt(), capture({ reopenCount: 1 })), true, 'reopen (archived -> triaged) is untouched');
});

test('capture: whole-record deletion, parent overwrites and direct-child bypasses are all denied', async () => {
  const db = await freshDb();
  await liveClaim(db, CAL, { claimEpoch: 2 });
  assert.equal(await db.write(captureAt(), null), false, 'delete the capture');
  assert.equal(await db.write(`${ROOM}/brainDump`, null), false, 'delete the whole collection');
  assert.equal(await db.write(`${ROOM}/brainDump`, { [CAPTURE]: capture({ claimEpoch: 0 }) }), false, 'whole-collection overwrite lowering the epoch');
  assert.equal(await db.write(ROOM, { brainDump: { [CAPTURE]: capture({}) } }), false, 'the whole room');
  assert.equal(await db.write(`${captureAt()}/promotionClaim`, null), false, 'direct child: delete the claim');
  assert.equal(await db.write(`${captureAt()}/promotionClaim/revokedAt`, T + 1), true, 'direct child: revoke the live claim');
  assert.equal(await db.write(`${captureAt()}/promotionClaim/revokedAt`, null), false, 'direct child: un-revoke');
  assert.equal(await db.write(`${captureAt()}/claimEpoch`, 1), false, 'direct child: epoch decrement');
  assert.equal(await db.write(`${captureAt()}/claimEpoch`, null), false, 'direct child: epoch removal');
  assert.equal(await db.write(`${captureAt()}/promotionClaim/targetKey`, CAL.otherKey), false, 'direct child: retarget the claim');
  assert.equal(await db.patch(ROOM, { [`brainDump/${CAPTURE}/promotionClaim`]: null }), false, 'multi-path: delete the claim');
  assert.equal(await db.write(`${captureAt()}/schemaVersion`, 1), false, 'schemaVersion can never be lowered');
  assert.equal(await db.write(`${captureAt()}/text`, 'x', MALLORY), false, 'a stranger');
});

test('capture: a capture is created with id === its key; a legacy (generation 1, no epoch, no targetKey) capture keeps working for an old client', async () => {
  const db = await freshDb();
  assert.equal(await db.write(captureAt('bwrongid1'), capture({ id: 'bother0001' })), false, 'id must equal the key');
  assert.equal(await db.write(captureAt('bnew00001'), capture({ id: 'bnew00001' })), true, 'create');
  assert.equal(await db.write(captureAt('bnew00002'), capture({ id: 'bnew00002', claimEpoch: -1 })), false, 'negative epoch');
  // A cf43080-shaped record: gen 1, no claimEpoch, a claim without targetKey/revokedAt.
  const old = (extra = {}) => ({ schemaVersion: 1, id: 'blegacy1', text: 'old', createdAt: T, updatedAt: T, updatedBy: 'old', status: 'triaged', important: true, urgent: false, triagedAt: T, ...extra });
  await db.seed(captureAt('blegacy1'), old());
  assert.equal(await db.write(captureAt('blegacy1'), old({ promotionClaim: legacyClaim(CAL, { planItemId: 'bdp1|blegacy1' }), updatedAt: T + 1 })), true, 'old client claims');
  assert.equal(await db.write(captureAt('blegacy1'), old({ status: 'promoted', disposedAt: T + 2, updatedAt: T + 2, promotion: { type: 'do-today', store: 'calendar', targetId: CAL.targetId, planItemId: 'bdp1|blegacy1', promotedAt: T + 2 } })), true, 'old client finalizes');
  await db.seed(captureAt('blegacy2'), old({ id: 'blegacy2' }));
  assert.equal(await db.write(captureAt('blegacy2'), old({ id: 'blegacy2', status: 'archived', disposedAt: T + 1, updatedAt: T + 1 })), true, 'old client archives');
  assert.equal(await db.write(captureAt('blegacy2'), old({ id: 'blegacy2', status: 'triaged', reopenCount: 1, schemaVersion: 2, updatedAt: T + 2 })), true, 'new client reopens (gen 2)');
});

// ── Action API V1 Phase A1 (TASK-005): server-private infrastructure + user-scoped domain reads ─────────────
// docs/CHRONASENSE_ACTION_API_V1.md §3/§6: an ordinary Firebase-authenticated client (even the room owner) can
// neither read nor write serverRequestNonces / serverActionReceipts; only the privileged server mechanism (the
// Admin credential; `Bearer owner` in the emulator) can. Domain reads go through the owner's own token and the
// unchanged room rules. These drive the REAL backend modules against the REAL emulator.

const SERVICE = 'chronasense-plugin-worker-v1';
const ACTION = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const NONCE_ID = '0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const asClient = (db, method, at, auth, value) => fetch(`${emulator.base}/${at}.json?ns=${db.name}${auth ? `&auth=${auth}` : ''}`, { method, body: value === undefined ? undefined : JSON.stringify(value) });
const infraFor = db => createInfraRtdb({ databaseUrl: emulator.base, namespace: db.name, getAccessToken: async () => 'owner' });
const userScopedFor = (db, tokenFor) => createUserScopedRtdb({ databaseUrl: emulator.base, namespace: db.name, idTokens: { getIdToken: async uid => tokenFor(uid) } });
const apiCapture = (id, extra = {}) => ({ schemaVersion: 1, id, text: `thought ${id}`, createdAt: T, updatedAt: T, updatedBy: 'dev', status: 'untriaged', ...extra });

test('action api: an owner client can neither read nor write request nonces or action receipts, at any depth', async () => {
  const db = await freshDb();
  await db.seed(`${NONCE_ROOT}/${SERVICE}/${NONCE_ID}`, { v: 1, claimedAt: 1, expiresAt: 2 });
  await db.seed(`serverActionReceipts/alice/${ACTION}`, { actionId: ACTION, state: 'started' });
  const paths = [
    NONCE_ROOT, `${NONCE_ROOT}/${SERVICE}`, `${NONCE_ROOT}/${SERVICE}/${NONCE_ID}`, `${NONCE_ROOT}/${SERVICE}/${NONCE_ID}/expiresAt`, `${NONCE_ROOT}/public`, `${NONCE_ROOT}/shared`,
    'serverActionReceipts', 'serverActionReceipts/alice', `serverActionReceipts/alice/${ACTION}`, `serverActionReceipts/alice/${ACTION}/state`, 'serverActionReceipts/public', 'serverActionReceipts/uid_alice',
  ];
  for (const auth of [ALICE, MALLORY, null]) {
    const who = auth === ALICE ? 'owner' : auth ? 'stranger' : 'anonymous';
    for (const at of paths) {
      assert.notEqual((await asClient(db, 'GET', at, auth)).status, 200, `read ${at} as ${who}`);
      assert.notEqual((await asClient(db, 'PUT', at, auth, { forged: true })).status, 200, `write ${at} as ${who}`);
      assert.notEqual((await asClient(db, 'DELETE', at, auth)).status, 200, `delete ${at} as ${who}`);
    }
    assert.notEqual((await asClient(db, 'PATCH', '', auth, { [`${NONCE_ROOT}/${SERVICE}/${NONCE_ID}`]: null })).status, 200, `multi-path nonce delete as ${who}`);
    assert.notEqual((await asClient(db, 'PATCH', '', auth, { [`serverActionReceipts/alice/${ACTION}/state`]: 'applied' })).status, 200, `multi-path receipt edit as ${who}`);
  }
  assert.deepEqual(await db.read(`${NONCE_ROOT}/${SERVICE}/${NONCE_ID}`), { v: 1, claimedAt: 1, expiresAt: 2 }, 'nonce untouched');
  assert.deepEqual(await db.read(`serverActionReceipts/alice/${ACTION}`), { actionId: ACTION, state: 'started' }, 'receipt untouched');
  assert.equal((await asClient(db, 'GET', ROOM, ALICE)).status, 200, 'the owner still reads their own room');
});

test('action api: the privileged server mechanism can claim nonces and receipts', async () => {
  const db = await freshDb();
  const infra = infraFor(db);
  await createNonceStore({ infra }).claim(SERVICE, NONCE_ID, NOW_MS);
  assert.equal((await db.read(`${NONCE_ROOT}/${SERVICE}/${NONCE_ID}`)).claimedAt, NOW_MS);
  const receipts = createReceiptStore({ infra });
  const first = await receipts.claim({ firebaseUid: 'alice', actionId: ACTION, requestHash: 'a'.repeat(64), kind: 'brain_dump_add', attemptId: 'x1', nowMs: NOW_MS, leaseMs: 30_000 });
  assert.equal(first.claimed, true);
  assert.equal((await receipts.read('alice', ACTION)).state, 'started');
  const again = await receipts.claim({ firebaseUid: 'alice', actionId: ACTION, requestHash: 'b'.repeat(64), kind: 'brain_dump_add', attemptId: 'x2', nowMs: NOW_MS, leaseMs: 30_000 });
  assert.equal(again.claimed, false);
  assert.equal(again.existing.requestHash, 'a'.repeat(64), 'the first claim is never overwritten');
});

test('action api: conditional capture create and receipt ETag compare-and-set work against the real RTDB emulator', async () => {
  const db = await freshDb();
  const id = `bdc1_${ACTION.slice(5)}`;
  const identity = { firebaseUid: 'alice', roomId: 'uid_alice' };
  const scoped = createUserScopedRtdb({ databaseUrl: emulator.base, namespace: db.name,
    idTokens: { getIdToken: async (_uid, actionId) => actionId ? withActionClaim(actionId) : ALICE } });
  const record = apiCapture(id, { creationActionId: ACTION });
  assert.equal(await scoped.createCaptureIfAbsent(identity, id, ACTION, record), 'created');
  assert.equal(await scoped.createCaptureIfAbsent(identity, id, ACTION, record), 'exists');
  assert.equal((await scoped.readCapture(identity, id)).creationActionId, ACTION);
  const infra = infraFor(db);
  const receipts = createReceiptStore({ infra });
  await receipts.claim({ firebaseUid: 'alice', actionId: ACTION, requestHash: 'a'.repeat(64),
    kind: 'brain_dump_add', attemptId: 'first', nowMs: NOW_MS, leaseMs: 30_000 });
  const first = await receipts.readWithEtag('alice', ACTION);
  assert.equal(await receipts.compareAndSet('alice', ACTION, { ...first.value, state: 'applied' }, first.etag), 'written');
  assert.equal(await receipts.compareAndSet('alice', ACTION, { ...first.value, state: 'conflict' }, first.etag), 'changed');
  assert.equal((await receipts.read('alice', ACTION)).state, 'applied');
});

test('action api: concurrent replay against the real server -> exactly one nonce claim wins', async () => {
  const db = await freshDb();
  const nonces = createNonceStore({ infra: infraFor(db) });
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => nonces.claim(SERVICE, NONCE_ID, NOW_MS)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.reason === 'replayed-request-id'));
});

test('action api: the bounded sweep uses the indexed query and deletes only expired claims', async () => {
  const db = await freshDb();
  const ids = Array.from({ length: 6 }, (_, i) => `0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c${i}`);
  // expiresAt: now-3, now-2, now-1 (expired) | now, now+1, now+2 (live)
  for (const [i, id] of ids.entries()) await db.seed(`${NONCE_ROOT}/${SERVICE}/${id}`, { v: 1, claimedAt: 0, expiresAt: NOW_MS - 3 + i });
  assert.equal(await createNonceStore({ infra: infraFor(db) }).sweepExpired(SERVICE, NOW_MS), 3);
  assert.deepEqual(Object.keys(await db.read(`${NONCE_ROOT}/${SERVICE}`)).sort(), ids.slice(3));
});

test('action api: own-account Brain Dump read is user-scoped; a cross-account token is refused by the unchanged rules', async () => {
  const db = await freshDb();
  await db.seed(`${ROOM}/brainDump/bdc_alice1`, apiCapture('bdc_alice1'));
  await db.seed('rooms/uid_mallory/brainDump/bdc_mall01', apiCapture('bdc_mall01', { text: 'MALLORY ONLY' }));
  const alice = Object.freeze({ principalSubject: 's', firebaseUid: 'alice', roomId: 'uid_alice', scopes: ['chronasense:read'] });
  const own = await getBrainDump(alice, { domain: userScopedFor(db, () => ALICE), nowMs: NOW_MS });
  assert.deepEqual(own.result.captures.map(c => c.captureId), ['bdc_alice1']);
  // Bound to alice but holding mallory's token: the server's rules refuse it.
  await assert.rejects(getBrainDump(alice, { domain: userScopedFor(db, () => MALLORY), nowMs: NOW_MS }), error => error.code === 'FORBIDDEN');
  // No token at all is refused too: there is no unauthenticated or privileged fallback.
  await assert.rejects(getBrainDump(alice, { domain: userScopedFor(db, () => ''), nowMs: NOW_MS }), error => error.code === 'FORBIDDEN');
});

test('action api: end to end against the real server - signed get_brain_dump, then its replay', async () => {
  const db = await freshDb();
  await db.seed('rooms/uid_ownerUid123/brainDump/bdc_owner1', apiCapture('bdc_owner1'));
  await db.seed(`${ROOM}/brainDump/bdc_alice1`, apiCapture('bdc_alice1', { text: 'NOT THE OWNER' }));
  const ownerToken = token('ownerUid123');
  const handle = createActionApiHandler({
    keys: KEYS, owner: { ownerSubject: 'access-sub-owner-1', ownerFirebaseUid: 'ownerUid123' },
    nonces: createNonceStore({ infra: infraFor(db) }), domain: userScopedFor(db, () => ownerToken), now: () => NOW_MS,
  });
  const request = signedRequest();
  const response = await handle(request);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.result.captures.map(c => c.captureId), ['bdc_owner1']);
  assert.ok(!JSON.stringify(response.body).includes('NOT THE OWNER'));
  assert.equal((await handle(request)).reason, 'replayed-request-id');
  assert.ok(await db.read(`${NONCE_ROOT}/${SERVICE}/${request.requestId}`), 'the nonce is persisted server-side');
  assert.equal(await db.read('serverActionReceipts'), null, 'a read creates no receipt');
});

// ── Action API plan items (TASK-011, DECISIONS #37) ─────────────────────────
// A conversational plan_create lands at ONE keyed calendar fence child. These attack it as the
// backend's own scoped token (wrong kind/target/marker/id, overwrite) and as the room owner
// (fabricate, strip/rewrite the marker, resurrect, move, smuggle it into the plan array).

test('action plan item: only the matching plan-scoped token creates it, and only on a calendar-authoritative account', async () => {
  const db = await freshDb();
  const at = actionItemAt();
  assert.equal(await db.write(at, actionItem()), false, 'an ordinary owner cannot fabricate Action API attribution');
  assert.equal(await db.write(at, actionItem(), planActionToken()), false, 'no calendar authority yet: refused (no implicit activation)');
  await seedCalendarAuthority(db);
  assert.equal(await db.write(at, actionItem(), planActionToken(ACTION_A, { kind: 'brain_dump_add' })), false, 'a non-plan action kind cannot create a plan item');
  assert.equal(await db.write(at, actionItem(), planActionToken(ACTION_A, { kind: null, target: null })), false, 'a TASK-010 Brain Dump token (id only) cannot create a plan item');
  assert.equal(await db.write(at, actionItem(), planActionToken(ACTION_A, { target: ACTION_OTHER_PLAN })), false, 'a token for another plan cannot create here');
  assert.equal(await db.write(at, actionItem(), planActionToken(ACTION_B)), false, "another action cannot create this action's item");
  const otherAt = actionItemAt(ACTION_B);
  assert.equal(await db.write(otherAt, actionItem({ id: actionItemId(ACTION_B), creationActionId: ACTION_B }), planActionToken(ACTION_A)), false,
    "this action cannot create another action's (self-consistent) item");
  assert.equal(await db.write(otherAt, actionItem({ id: actionItemId(ACTION_B) }), planActionToken(ACTION_A)), false, 'the item id must derive from the marker');
  assert.equal(await db.write(at, actionItem({ brainDumpOrigin: origin(STORES.calendar) }), planActionToken()), false, 'no Brain Dump origin on an action item');
  assert.equal(await db.write(at, actionItem({ movedToDayId: ACTION_OTHER_PLAN }), planActionToken()), false, 'created unmoved');
  assert.equal(await db.write(at, actionItem(), token('mallory', { chronasenseActionId: ACTION_A, chronasenseActionKind: 'plan_create', chronasenseActionTarget: ACTION_PLAN })), false,
    'another account holding identical claims cannot write this room');
  assert.equal(await db.write(at, actionItem(), planActionToken()), true, 'the exact scoped token creates the exact item');
  assert.equal(await db.write(at, actionItem(), planActionToken()), false, 'create-only: the token cannot rewrite it, even identically');
  assert.equal(await db.write(at, actionItem({ task: 'Gym!' }), planActionToken()), false, 'the action token cannot edit it');
  assert.deepEqual(await db.read(at), actionItem(), 'the stored item is exactly the created one');
});

test('action plan item: the owner edits it like any task but cannot strip/rewrite the marker, resurrect, move or delete it', async () => {
  const db = await freshDb();
  await seedCalendarAuthority(db);
  const at = actionItemAt();
  await db.seed(at, actionItem());
  assert.equal(await db.write(at, actionItem({ task: 'Gym (legs)', done: true, doneAt: T + 9, updatedAt: T + 9, updatedBy: 'device' })), true, 'ordinary edit + completion');
  assert.equal(await db.write(at, actionItem({ when: '19:00', durationMinutes: 45, updatedAt: T + 10 })), true, 'ordinary retime in the same plan');
  assert.equal(await db.write(at, actionItem({ creationActionId: undefined })), false, 'marker cannot be stripped');
  assert.equal(await db.write(at, actionItem({ creationActionId: ACTION_B })), false, 'marker cannot be rewritten');
  assert.equal(await db.write(at, actionItem({ relocationRevision: { schemaVersion: 1, sequence: 1, fromDayId: ACTION_PLAN, toDayId: ACTION_OTHER_PLAN, updatedBy: 'd' } })), false, 'no relocation');
  assert.equal(await db.write(at, actionItem({ deleted: true, movedToDayId: ACTION_OTHER_PLAN })), false, 'no move tombstone');
  assert.equal(await db.write(at, null), false, 'the child can never be removed');
  assert.equal(await db.write(`${ROOM}/calendarPlanFences/${ACTION_PLAN}`, { [actionItemId(ACTION_A)]: actionItem({ task: 'overwritten' }) }), false, 'no parent overwrite');
  assert.equal(await db.write(at, actionItem({ deleted: true, updatedAt: T + 11 })), true, 'ordinary delete is a tombstone');
  assert.equal(await db.write(at, actionItem({ deleted: false, updatedAt: T + 99 })), false, 'tombstone is monotonic: never resurrected');
  assert.equal(await db.write(at, actionItem({ updatedAt: T + 99 })), false, 'not even by omitting the flag');
  assert.equal(await db.write(at, actionItem({ deleted: true, task: 'renamed tombstone', updatedAt: T + 12 })), true, 'a tombstone may still be re-stamped');
  assert.equal((await db.read(at)).creationActionId, ACTION_A, 'attribution survived every owner write');
});

test('action plan item: the plan-scoped token cannot touch anything else, and no plan array can carry Action API identity', async () => {
  const db = await freshDb();
  await seedCalendarAuthority(db);
  const planToken = planActionToken();
  await db.seed(captureAt(), capture({ promotionClaim: claim(STORES.calendar) }));
  const deniedForToken = [
    [`${ROOM}/calendarPlans/${ACTION_PLAN}`, planRecord([ordinary])],
    [`${ROOM}/settings`, { timezone: 'UTC' }],
    [`${ROOM}/entries/e1`, { id: 'e1', updatedAt: T }],
    [`${ROOM}/timer`, { running: false }],
    [`${ROOM}/planFences/2026-10-03/${actionItemId(ACTION_A)}`, actionItem()],
    [`${ROOM}/operationalPlanFences/${STORES.operational.key}/${actionItemId(ACTION_A)}`, actionItem()],
    [STORES.calendar.itemAt, fencedItem(STORES.calendar)],
    ['uid_alice/public', { sample: true }],
  ];
  for (const [path, value] of deniedForToken) assert.equal(await db.write(path, value, planToken), false, `plan token denied at ${path}`);
  const bdc = `bdc1_${ACTION_A.slice(5)}`;
  assert.equal(await db.write(captureAt(bdc), capture({ id: bdc, creationActionId: ACTION_A }), planToken), false, 'a plan.write token cannot create a Brain Dump capture');
  assert.equal(await db.write(captureAt(bdc), capture({ id: bdc, creationActionId: ACTION_A }), token('alice', { chronasenseActionId: ACTION_A })), true,
    'the unchanged TASK-010 Brain Dump token still creates its capture');
  // The owner's ordinary plan arrays (calendar while active; legacy/operational before activation): no api1_ namespace, no marker.
  for (const def of Object.values(STORES)) {
    if (def.store !== 'calendar') await db.seed(`${ROOM}/calendarPlanAuthority`, null);
    assert.equal(await db.write(def.planAt, planRecord([ordinary, actionItem()])), false, `${def.store}: a marked api1_ item cannot sit in the array`);
    assert.equal(await db.write(def.planAt, planRecord([ordinary, { ...ordinary, id: actionItemId(ACTION_B) }])), false, `${def.store}: the api1_ namespace is reserved`);
    assert.equal(await db.write(def.planAt, planRecord([{ ...ordinary, creationActionId: ACTION_A }])), false, `${def.store}: an ordinary item cannot carry a marker`);
    assert.equal(await db.write(def.planAt, planRecord([ordinary])), true, `${def.store}: ordinary plan writes are unaffected`);
    if (def.store !== 'calendar') await seedCalendarAuthority(db);
  }
});

// The Function's own path against the real server: signed command -> receipt -> Plan Authority read -> REST
// conditional create with the claim-bearing token -> exact readback -> receipt applied; then replay, a race,
// an owner edit, and the conditional-create precedence the recovery protocol relies on.
const PLAN_OWNER_UID = 'ownerUid123';
const PLAN_ROOM = `rooms/uid_${PLAN_OWNER_UID}`;
// Exactly the claims user-scoped-rtdb.js asks Firebase Auth to mint: plan_create (action, kind, target) or, for TASK-012's
// api1_ move, plan_move (action, kind, destination, source, item, source writer stamp).
const planScopedTokens = { getIdToken: async (uid, actionId, plan) => token(uid, !actionId ? {} : !plan ? { chronasenseActionId: actionId }
  : plan.kind === 'plan_move' ? { chronasenseActionId: actionId, chronasenseActionKind: 'plan_move', chronasenseActionTarget: plan.target,
    chronasenseActionSource: plan.source, chronasenseActionItem: plan.item, chronasenseActionSourceStamp: plan.sourceStamp, chronasenseActionSourceWriter: plan.sourceWriter }
    : { chronasenseActionId: actionId, chronasenseActionKind: 'plan_create', chronasenseActionTarget: plan.target }) };
async function seedPlanAccount(db) {
  const activatedAtMs = NOW_MS - 10 * 86_400_000;
  await db.seed(`${PLAN_ROOM}/settings`, { timezone: 'Asia/Manila' });
  await db.seed(`${PLAN_ROOM}/calendarPlanAuthority/fact-1`, { schemaVersion: 1, id: 'fact-1', activatedAtMs, timezone: 'Asia/Manila',
    activationDate: new Date(activatedAtMs + 8 * 3_600_000).toISOString().slice(0, 10), deviceId: 'phone' });
}
function planCommand(actionId, parameters) {
  const requestId = randomUUID();
  return signedRequest({ path: COMMAND_PATH, requestId, signed: { path: COMMAND_PATH, scopes: ['chronasense:plan.write'] },
    envelope: { contractVersion: 1, requestId, actionId, kind: 'plan_create', parameters, expectedRevision: null,
      actionProvenance: { version: 1, sourceKind: 'chatgpt_plugin', actionId, actorRef: actionActorRef('access-sub-owner-1'), capturedAt: new Date(NOW_MS).toISOString() } } });
}

test('action api: plan_create end to end against the real server - create, replay, race, owner edit, conditional precedence', async () => {
  const db = await freshDb();
  await seedPlanAccount(db);
  const tomorrow = new Date(NOW_MS + 8 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
  const planId = `cal1:${tomorrow}`;
  const parameters = { target: { store: 'calendar', id: planId }, title: 'Gym', when: '18:00', whenTz: 'Asia/Manila', durationMinutes: 60 };
  const domain = createUserScopedRtdb({ databaseUrl: emulator.base, namespace: db.name, idTokens: planScopedTokens });
  const infra = infraFor(db);
  const handle = createActionApiHandler({ keys: KEYS, owner: { ownerSubject: 'access-sub-owner-1', ownerFirebaseUid: PLAN_OWNER_UID },
    nonces: createNonceStore({ infra }), receipts: createReceiptStore({ infra }), domain, now: () => NOW_MS });
  const itemAt = `${PLAN_ROOM}/calendarPlanFences/${planId}/${actionItemId(ACTION_A)}`;

  const first = await handle(planCommand(ACTION_A, parameters));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const stored = await db.read(itemAt);
  assert.equal(stored.creationActionId, ACTION_A);
  assert.equal(stored.task, 'Gym');
  assert.deepEqual(await db.read(`${PLAN_ROOM}/calendarPlans`), { [planId]: { createdAt: NOW_MS, timezone: 'Asia/Manila', updatedAt: 0 } },
    'R011-02: the absent plan got ONLY its canonical origin, through the ordinary owner rules; no item in its array');
  assert.equal((await db.read(`serverActionReceipts/${PLAN_OWNER_UID}/${ACTION_A}`)).state, 'applied');

  const replay = await handle(planCommand(ACTION_A, parameters));
  assert.equal(replay.body.result.idempotentReplay, true, JSON.stringify(replay.body));

  // The conditional create the recovery protocol relies on: an existing child answers 412 ("exists"), not a rules denial.
  assert.equal(await domain.createPlanItemIfAbsent({ firebaseUid: PLAN_OWNER_UID, roomId: `uid_${PLAN_OWNER_UID}` }, planId, actionItemId(ACTION_A), ACTION_A, stored), 'exists');

  // The owner edits it through the ordinary rules; the action's replay is unaffected and attribution survives.
  assert.equal((await asClient(db, 'PUT', itemAt, token(PLAN_OWNER_UID), { ...stored, task: 'Gym (legs)', done: true, updatedAt: NOW_MS + 5 })).status, 200);
  assert.equal((await handle(planCommand(ACTION_A, parameters))).body.result.idempotentReplay, true);
  assert.equal((await db.read(itemAt)).creationActionId, ACTION_A);

  // Twelve concurrent attempts of ANOTHER action: exactly one item, never two.
  const race = await Promise.all(Array.from({ length: 12 }, () => handle(planCommand(ACTION_B, { ...parameters, title: 'Stretch', when: '19:30' }))));
  assert.ok(race.some(r => r.status === 200), JSON.stringify(race.map(r => r.body.error?.code)));
  assert.ok(race.every(r => r.status === 200 || r.body.error.code === 'PENDING_UNKNOWN'));
  assert.deepEqual(Object.keys(await db.read(`${PLAN_ROOM}/calendarPlanFences/${planId}`)).sort(), [actionItemId(ACTION_A), actionItemId(ACTION_B)].sort());

  // Plan Authority's server read (the unchanged get_plan) sees both, with the create's revision.
  const requestId = randomUUID();
  const read = await handle(signedRequest({ requestId, envelope: { contractVersion: 1, requestId, kind: 'get_plan', parameters: { target: { store: 'calendar', id: planId } } } }));
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.result.plan.items.map(i => i.itemId).sort(), [actionItemId(ACTION_A), actionItemId(ACTION_B)].sort());
});

test('action api: plan_create refuses a non-authoritative account against the real rules without writing anything', async () => {
  const db = await freshDb();
  await db.seed(`${PLAN_ROOM}/settings`, { timezone: 'Asia/Manila' });
  const tomorrow = new Date(NOW_MS + 8 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
  const infra = infraFor(db);
  const handle = createActionApiHandler({ keys: KEYS, owner: { ownerSubject: 'access-sub-owner-1', ownerFirebaseUid: PLAN_OWNER_UID },
    nonces: createNonceStore({ infra }), receipts: createReceiptStore({ infra }),
    domain: createUserScopedRtdb({ databaseUrl: emulator.base, namespace: db.name, idTokens: planScopedTokens }), now: () => NOW_MS });
  const response = await handle(planCommand(ACTION_A, { target: { store: 'calendar', id: `cal1:${tomorrow}` }, title: 'Gym' }));
  assert.equal(response.body.error?.code, 'NOT_FOUND', JSON.stringify(response.body));
  assert.equal(await db.read(`${PLAN_ROOM}/calendarPlanFences`), null);
  assert.equal(await db.read(`${PLAN_ROOM}/calendarPlans`), null, 'no origin for a refused target');
  assert.equal(await db.read(`${PLAN_ROOM}/calendarPlanAuthority`), null, 'nothing activated');
});

test('action api (R011-02): an existing owner plan keeps origin, items and preparation; the origin freezes the home zone against a later settings change', async () => {
  const db = await freshDb();
  await seedPlanAccount(db);
  const tomorrow = new Date(NOW_MS + 8 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
  const planId = `cal1:${tomorrow}`;
  const ownerRecord = { createdAt: NOW_MS - 5_000, timezone: 'Asia/Tokyo', updatedAt: NOW_MS - 1, updatedBy: 'phone',
    items: [{ id: 'powner1', task: 'Owner task', when: '', done: false, updatedAt: NOW_MS - 1, updatedBy: 'phone' }] };
  assert.equal((await asClient(db, 'PUT', `${PLAN_ROOM}/calendarPlans/${planId}`, token(PLAN_OWNER_UID), ownerRecord)).status, 200, 'owner wrote the plan normally');
  const infra = infraFor(db);
  const domain = createUserScopedRtdb({ databaseUrl: emulator.base, namespace: db.name, idTokens: planScopedTokens });
  const handle = createActionApiHandler({ keys: KEYS, owner: { ownerSubject: 'access-sub-owner-1', ownerFirebaseUid: PLAN_OWNER_UID },
    nonces: createNonceStore({ infra }), receipts: createReceiptStore({ infra }), domain, now: () => NOW_MS });
  const created = await handle(planCommand(ACTION_A, { target: { store: 'calendar', id: planId }, title: 'Gym', when: '18:00', whenTz: 'Asia/Manila' }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(await db.read(`${PLAN_ROOM}/calendarPlans/${planId}`), ownerRecord, 'existing origin, items and writer untouched');

  // Absent plan: origin frozen; then the account moves zone and the plan interval does not move.
  const dayAfter = new Date(NOW_MS + 8 * 3_600_000 + 2 * 86_400_000).toISOString().slice(0, 10);
  const target = { store: 'calendar', id: `cal1:${dayAfter}` };
  assert.equal((await handle(planCommand(ACTION_B, { target, title: 'Call mom' }))).status, 200);
  const readPlan = async () => {
    const requestId = randomUUID();
    return (await handle(signedRequest({ requestId, envelope: { contractVersion: 1, requestId, kind: 'get_plan', parameters: { target } } }))).body.result.plan.target;
  };
  const before = await readPlan();
  assert.equal((await asClient(db, 'PUT', `${PLAN_ROOM}/settings`, token(PLAN_OWNER_UID), { timezone: 'America/Los_Angeles' })).status, 200);
  const after = await readPlan();
  assert.deepEqual([after.timezone, after.startMs, after.endMs], [before.timezone, before.startMs, before.endMs]);
  assert.equal(before.timezone, 'Asia/Manila');
  assert.equal((await db.read(`${PLAN_ROOM}/calendarPlans/${target.id}`)).items, undefined, 'no api1_ item in any plan array');
});

// ── TASK-012 conversational plan mutations (DECISIONS #38) ──────────────────
// The Function's mutation path against the REAL server and rules: owner-token compare-and-set of an array record,
// of an api1_/bdp1| fence child, and the ONE atomic calendarPlans write a move uses. Then the same primitives used
// as an adversary would: the unchanged rules still refuse resurrection, relocation, marker rewrite and array injection.
const MUTATION_PLAN = STORES.calendar.targetId;
const MUTATION_OTHER = STORES.calendar.otherId;
const mutationGym = (extra = {}) => ({ id: 'pgym1', task: 'Gym', when: '18:00', whenTz: 'Asia/Manila', durationMinutes: 60, done: false, updatedAt: T, updatedBy: 'phone', ...extra });
async function mutationAccount() {
  const db = await freshDb();
  await db.seed(`${ROOM}/settings`, { timezone: 'Asia/Manila' });
  await seedCalendarAuthority(db);
  const record = { createdAt: T - 10, timezone: 'Asia/Manila', updatedAt: T, updatedBy: 'phone', items: [mutationGym(), { ...ordinary }] };
  assert.equal((await asClient(db, 'PUT', `${ROOM}/calendarPlans/${MUTATION_PLAN}`, ALICE, record)).status, 200, 'the owner wrote the plan normally');
  const infra = infraFor(db);
  const domain = createUserScopedRtdb({ databaseUrl: emulator.base, namespace: db.name, idTokens: planScopedTokens });
  const handle = createActionApiHandler({ keys: KEYS, owner: { ownerSubject: 'access-sub-owner-1', ownerFirebaseUid: 'alice' },
    nonces: createNonceStore({ infra }), receipts: createReceiptStore({ infra }), domain, now: () => NOW_MS,
    log: entry => { if (process.env.DBG && entry.event === 'rejected') console.log('LOG', JSON.stringify(entry)); } });
  return { db, domain, handle };
}
function mutationCommand(kind, parameters, expectedRevision, actionId = `act1_${randomUUID()}`) {
  const requestId = randomUUID();
  return signedRequest({ path: COMMAND_PATH, requestId, signed: { path: COMMAND_PATH, scopes: ['chronasense:plan.write'] },
    envelope: { contractVersion: 1, requestId, actionId, kind, parameters, expectedRevision,
      actionProvenance: { version: 1, sourceKind: 'chatgpt_plugin', actionId, actorRef: actionActorRef('access-sub-owner-1'), capturedAt: new Date(NOW_MS).toISOString() } } });
}
async function readPlanItem(handle, planId, itemId) {
  const requestId = randomUUID();
  const response = await handle(signedRequest({ requestId, envelope: { contractVersion: 1, requestId, kind: 'get_item',
    parameters: { source: 'plan', id: itemId, target: { store: 'calendar', id: planId } } } }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.result;
}
const atPlan = planId => ({ store: 'calendar', id: planId });
const STALE_ETAG = '"stale-etag"';

test('TASK-012: complete, edit, delete and an atomic move through the real rules; replay; stale write refused; owner edit kept', async () => {
  const { db, handle } = await mutationAccount();
  const planAt = `${ROOM}/calendarPlans/${MUTATION_PLAN}`;
  const item = async () => (await db.read(planAt)).items.find(entry => entry.id === 'pgym1');

  const completeId = `act1_${randomUUID()}`;
  const before = (await readPlanItem(handle, MUTATION_PLAN, 'pgym1')).item.revision;
  const done = await handle(mutationCommand('plan_set_completion', { target: atPlan(MUTATION_PLAN), itemId: 'pgym1', completed: true }, before, completeId));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await item()).done, true);
  assert.equal(done.body.result.revision, (await readPlanItem(handle, MUTATION_PLAN, 'pgym1')).item.revision, 'readback revision == result');
  assert.equal((await handle(mutationCommand('plan_set_completion', { target: atPlan(MUTATION_PLAN), itemId: 'pgym1', completed: true }, before, completeId))).body.result.idempotentReplay, true);

  const undone = await handle(mutationCommand('plan_set_completion', { target: atPlan(MUTATION_PLAN), itemId: 'pgym1', completed: false },
    (await readPlanItem(handle, MUTATION_PLAN, 'pgym1')).item.revision));
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal((await item()).doneAt, undefined, 'RTDB pruned doneAt; the proof still matched');

  // The owner edits after ChatGPT read: the old revision is refused and the owner edit is kept.
  const stale = (await readPlanItem(handle, MUTATION_PLAN, 'pgym1')).item.revision;
  const record = await db.read(planAt);
  record.items = record.items.map(entry => entry.id === 'pgym1' ? { ...entry, task: 'Gym (legs)', updatedAt: entry.updatedAt + 1, updatedBy: 'phone' } : entry);
  assert.equal((await asClient(db, 'PUT', planAt, ALICE, record)).status, 200);
  const staleEdit = await handle(mutationCommand('plan_edit', { target: atPlan(MUTATION_PLAN), itemId: 'pgym1', title: 'Strength' }, stale));
  assert.equal(staleEdit.body.error?.code, 'STALE_REVISION', JSON.stringify(staleEdit.body));
  assert.equal((await item()).task, 'Gym (legs)');

  const retimed = await handle(mutationCommand('plan_edit', { target: atPlan(MUTATION_PLAN), itemId: 'pgym1',
    time: { when: '19:00', whenTz: 'Asia/Manila' }, durationMinutes: 90 }, (await readPlanItem(handle, MUTATION_PLAN, 'pgym1')).item.revision));
  assert.equal(retimed.status, 200, JSON.stringify(retimed.body));
  assert.deepEqual([(await item()).when, (await item()).durationMinutes, (await item()).task], ['19:00', 90, 'Gym (legs)']);

  const moved = await handle(mutationCommand('plan_move', { target: atPlan(MUTATION_PLAN), itemId: 'pgym1', destination: atPlan(MUTATION_OTHER) },
    (await readPlanItem(handle, MUTATION_PLAN, 'pgym1')).item.revision));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const destination = await db.read(`${ROOM}/calendarPlans/${MUTATION_OTHER}`);
  assert.equal(destination.items[0].id, 'pgym1', 'the same identity at the destination');
  assert.equal(destination.items[0].relocationRevision.toDayId, MUTATION_OTHER);
  assert.deepEqual([destination.timezone, destination.createdAt], ['Asia/Manila', destination.items[0].updatedAt], 'destination origin frozen at the move stamp');
  assert.equal((await item()).deleted, true);
  assert.equal((await item()).movedToDayId, MUTATION_OTHER);
  assert.equal((await readPlanItem(handle, MUTATION_PLAN, 'pgym1')).state, 'tombstoned');
  assert.equal((await readPlanItem(handle, MUTATION_OTHER, 'pgym1')).item.revision, moved.body.result.revision);

  const deleted = await handle(mutationCommand('plan_delete', { target: atPlan(MUTATION_OTHER), itemId: 'pgym1' },
    (await readPlanItem(handle, MUTATION_OTHER, 'pgym1')).item.revision));
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await db.read(`${ROOM}/calendarPlans/${MUTATION_OTHER}`)).items[0].deleted, true);
  assert.deepEqual((await db.read(planAt)).items.find(entry => entry.id === ordinary.id), ordinary, 'the unrelated item never changed');
});

test('TASK-012: an api1_ item and a fenced Brain Dump item are mutated at their keyed child through the real fence rules; a Brain Dump item never moves', async () => {
  const { db, handle } = await mutationAccount();
  // A plan_create item, created exactly as TASK-011 creates it.
  const created = await handle(planCommand(ACTION_A, { target: atPlan(MUTATION_PLAN), title: 'Gym', when: '07:00', whenTz: 'Asia/Manila' }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const apiAt = actionItemAt(ACTION_A, MUTATION_PLAN);
  const apiId = actionItemId(ACTION_A);
  for (const [kind, extra] of [['plan_set_completion', { completed: true }], ['plan_edit', { title: 'Strength training', durationMinutes: 45 }]]) {
    const response = await handle(mutationCommand(kind, { target: atPlan(MUTATION_PLAN), itemId: apiId, ...extra }, (await readPlanItem(handle, MUTATION_PLAN, apiId)).item.revision));
    assert.equal(response.status, 200, `${kind}: ${JSON.stringify(response.body)}`);
  }
  const deleted = await handle(mutationCommand('plan_delete', { target: atPlan(MUTATION_PLAN), itemId: apiId }, (await readPlanItem(handle, MUTATION_PLAN, apiId)).item.revision));
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const stored = await db.read(apiAt);
  assert.deepEqual([stored.creationActionId, stored.task, stored.durationMinutes, stored.done, stored.deleted], [ACTION_A, 'Strength training', 45, true, true]);
  assert.equal(stored.relocationRevision, undefined);

  // A fenced Brain Dump item: the rules re-authorize every update by its capture's promotion.
  await db.seed(captureAt(), promotedCapture(STORES.calendar));
  await db.seed(STORES.calendar.itemAt, fencedItem(STORES.calendar));
  const bd = await handle(mutationCommand('plan_set_completion', { target: atPlan(MUTATION_PLAN), itemId: ITEM_ID, completed: true },
    (await readPlanItem(handle, MUTATION_PLAN, ITEM_ID)).item.revision));
  assert.equal(bd.status, 200, JSON.stringify(bd.body));
  assert.equal((await db.read(STORES.calendar.itemAt)).done, true);
  assert.deepEqual((await db.read(STORES.calendar.itemAt)).brainDumpOrigin, origin(STORES.calendar), 'origin pinned');
  const bdMove = await handle(mutationCommand('plan_move', { target: atPlan(MUTATION_PLAN), itemId: ITEM_ID, destination: atPlan(MUTATION_OTHER) },
    (await readPlanItem(handle, MUTATION_PLAN, ITEM_ID)).item.revision));
  assert.equal(bdMove.body.error?.code, 'DOMAIN_LIMIT', JSON.stringify(bdMove.body));
  assert.equal(await db.read(`${ROOM}/calendarPlanFences/${MUTATION_OTHER}`), null, 'nothing ever landed on the other day');
});

test('TASK-012: the owner-token mutation primitives cannot break fence or array invariants (the real rules refuse)', async () => {
  const { db, domain } = await mutationAccount();
  const identity = { firebaseUid: 'alice', roomId: 'uid_alice' };
  await db.seed(actionItemAt(), actionItem({ deleted: true }));
  const read = await domain.readPlanFenceItemWithEtag(identity, ACTION_PLAN, actionItemId(ACTION_A));
  const refuse = (record, why) => assert.rejects(domain.putPlanFenceItemIfMatch(identity, ACTION_PLAN, actionItemId(ACTION_A), record, read.etag),
    error => error.code === 'FORBIDDEN', why);
  await refuse({ ...read.value, deleted: false }, 'a tombstone cannot be resurrected');
  await refuse({ ...read.value, creationActionId: ACTION_B }, 'the creation marker cannot be rewritten');
  await refuse({ ...read.value, relocationRevision: { schemaVersion: 1, sequence: 1, fromDayId: ACTION_PLAN, toDayId: ACTION_OTHER_PLAN, updatedBy: 'x' } }, 'no relocation');
  assert.equal(await domain.putPlanFenceItemIfMatch(identity, ACTION_PLAN, actionItemId(ACTION_A), { ...read.value, task: 'renamed' }, STALE_ETAG), 'changed', 'a stale ETag never writes');
  await assert.rejects(domain.putPlanFenceItemIfMatch(identity, ACTION_PLAN, actionItemId(ACTION_B), actionItem({ id: actionItemId(ACTION_B), creationActionId: ACTION_B }), 'null_etag'),
    error => error.name === 'AuthorityBoundaryViolation', 'an update can never create (fabricate) a fence child');
  const plans = await domain.readCalendarPlansWithEtag(identity);
  const injected = { ...plans.value, [MUTATION_PLAN]: { ...plans.value[MUTATION_PLAN], items: [...plans.value[MUTATION_PLAN].items, actionItem({ id: actionItemId(ACTION_B), creationActionId: ACTION_B })] } };
  await assert.rejects(domain.putCalendarPlansIfMatch(identity, injected, plans.etag), error => error.code === 'FORBIDDEN', 'no api1_/marker in a plan array');
  assert.equal(await domain.putCalendarPlansIfMatch(identity, plans.value, STALE_ETAG), 'changed');
  await assert.rejects(domain.putCalendarPlansIfMatch(identity, { settings: {} }, plans.etag), error => error.name === 'AuthorityBoundaryViolation');
  assert.equal((await db.read(actionItemAt())).deleted, true, 'still a tombstone');
});

// ── TASK-012 api1_ cross-day move against the REAL server and rules ─────────
test('TASK-012 api1_ move: "move my ChatGPT gym task to Friday" end to end through the real rules; one current copy; replay; second move denied', async () => {
  const { db, handle } = await mutationAccount();
  const created = await handle(planCommand(ACTION_A, { target: atPlan(MUTATION_PLAN), title: 'Gym', when: '18:00', whenTz: 'Asia/Manila', durationMinutes: 60 }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const apiId = actionItemId(ACTION_A);
  const rev = (await readPlanItem(handle, MUTATION_PLAN, apiId)).item.revision;
  const moveId = `act1_${randomUUID()}`;
  const parameters = { target: atPlan(MUTATION_PLAN), itemId: apiId, destination: atPlan(MUTATION_OTHER) };
  const moved = await handle(mutationCommand('plan_move', parameters, rev, moveId));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const source = await db.read(actionItemAt(ACTION_A, MUTATION_PLAN));
  const destination = await db.read(actionItemAt(ACTION_A, MUTATION_OTHER));
  assert.deepEqual([source.deleted, source.movedToDayId, source.creationActionId], [true, MUTATION_OTHER, ACTION_A], 'source kept as a move tombstone');
  assert.deepEqual([destination.id, destination.creationActionId, destination.deleted, destination.task], [apiId, ACTION_A, undefined, 'Gym'], 'same identity + provenance');
  assert.deepEqual(destination.relocationRevision, source.relocationRevision);
  assert.deepEqual([destination.relocationRevision.sequence, destination.relocationRevision.fromDayId, destination.relocationRevision.toDayId], [1, MUTATION_PLAN, MUTATION_OTHER]);
  assert.equal((await db.read(`${ROOM}/calendarPlans/${MUTATION_OTHER}`)).timezone, 'Asia/Manila', 'destination origin frozen');
  assert.equal((await db.read(`${ROOM}/calendarPlans/${MUTATION_OTHER}`)).items, undefined, 'no api1_ in any plan array');
  assert.equal((await readPlanItem(handle, MUTATION_PLAN, apiId)).state, 'tombstoned');
  assert.equal((await readPlanItem(handle, MUTATION_OTHER, apiId)).item.revision, moved.body.result.revision);
  assert.equal((await handle(mutationCommand('plan_move', parameters, rev, moveId))).body.result.idempotentReplay, true);
  // A second, different move from the same (old) read: refused as stale; never a second destination.
  const third = 'cal1:2026-10-05';
  const again = await handle(mutationCommand('plan_move', { ...parameters, destination: atPlan(third) }, rev));
  assert.equal(again.body.error?.code, 'STALE_REVISION', JSON.stringify(again.body));
  assert.equal(await db.read(actionItemAt(ACTION_A, third)), null);
  // The moved task keeps working as an ordinary task at its new day (owner client and Function edits keep the relocation).
  assert.equal((await asClient(db, 'PUT', actionItemAt(ACTION_A, MUTATION_OTHER), ALICE, { ...destination, done: true, updatedAt: destination.updatedAt + 1, updatedBy: 'phone' })).status, 200);
  const renamed = await handle(mutationCommand('plan_edit', { target: atPlan(MUTATION_OTHER), itemId: apiId, title: 'Strength' }, (await readPlanItem(handle, MUTATION_OTHER, apiId)).item.revision));
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal((await db.read(actionItemAt(ACTION_A, MUTATION_OTHER))).relocationRevision.sequence, 1);
});

test('TASK-012 api1_ move rules: only the exact atomic pair from the exact plan_move token; owners cannot resurrect, strip or fabricate a move', async () => {
  const db = await freshDb();
  await seedCalendarAuthority(db);
  await db.seed(actionItemAt(), actionItem());
  const id = actionItemId(ACTION_A);
  // Not by an ordinary owner, not by a plan_create token, not by another account holding identical claims, not half of it.
  assert.equal(await db.patch(FENCES_AT, movePatch()), false, 'owner token cannot relocate');
  assert.equal(await db.patch(FENCES_AT, movePatch(), planActionToken()), false, 'a plan_create token cannot relocate');
  assert.equal(await db.patch('rooms/uid_mallory/calendarPlanFences', movePatch(), token('mallory', { chronasenseActionId: MOVE_ACTION, chronasenseActionKind: 'plan_move',
    chronasenseActionTarget: ACTION_OTHER_PLAN, chronasenseActionSource: ACTION_PLAN, chronasenseActionItem: id, chronasenseActionSourceStamp: T, chronasenseActionSourceWriter: 'actor1:test' })), false, 'another room');
  assert.equal(await db.patch(FENCES_AT, movePatch({ omitDestination: true }), moveToken()), false, 'a source tombstone alone');
  assert.equal(await db.patch(FENCES_AT, { [`${ACTION_PLAN}/${id}`]: null, ...movePatch({ omitSource: true }) }, moveToken()), false, 'no physical delete of the source');
  assert.equal(await db.patch(FENCES_AT, movePatch({ destination: { creationActionId: ACTION_B } }), moveToken()), false, 'provenance cannot change');
  assert.equal(await db.patch(FENCES_AT, movePatch({ to: ACTION_PLAN, from: ACTION_PLAN }), moveToken({ target: ACTION_PLAN })), false, 'not onto itself');
  // The move token can write nothing else.
  const moveTokenOnly = moveToken();
  for (const [path, value] of [[`${ROOM}/settings`, { timezone: 'UTC' }], [`${ROOM}/entries/e1`, { id: 'e1', updatedAt: T }], [`${ROOM}/timer`, { running: false }],
    [`${ROOM}/calendarPlans/${ACTION_PLAN}`, planRecord([ordinary])], [captureAt(`bdc1_${MOVE_ACTION.slice(5)}`), capture({ id: `bdc1_${MOVE_ACTION.slice(5)}`, creationActionId: MOVE_ACTION })],
    [actionItemAt(ACTION_B), actionItem({ id: actionItemId(ACTION_B), creationActionId: ACTION_B })]]) {
    assert.equal(await db.write(path, value, moveTokenOnly), false, `move token denied at ${path}`);
  }
  // R1: without this action's lock the pair is refused; the lock is taken by the move token at server time only.
  assert.equal(await db.patch(FENCES_AT, movePatch(), moveToken()), false, 'no relocation without the move lock');
  assert.equal(await db.write(actionItemAt(), lockedItem({}, { at: Date.now() - 1000 }), moveToken()), false, 'the lock time is the server clock, never supplied');
  assert.equal(await db.write(actionItemAt(), lockedItem({}, { at: SERVER_TIME })), false, 'an ordinary owner cannot take a lock');
  assert.equal(await db.write(actionItemAt(), lockedItem({ task: 'x' }, { at: SERVER_TIME }), moveToken({ item: actionItemId(ACTION_B) })), false, 'a token for another item cannot lock this one');
  assert.equal(await db.write(actionItemAt(), lockedItem({}, { at: SERVER_TIME }), moveToken()), true, 'the move token takes its lock');
  const locked = await db.read(actionItemAt());
  // R1 on the real rules: a SAME-STAMP owner edit under the lock is refused, and so is another action's lock.
  assert.equal(await db.write(actionItemAt(), { ...locked, task: 'Strength' }), false, 'no accepted owner write under an active lock (same updatedAt/updatedBy)');
  assert.equal(await db.write(actionItemAt(), { ...locked, done: true }), false);
  assert.equal(await db.write(actionItemAt(), lockedItem({}, { actionId: ACTION_B, at: SERVER_TIME }), moveToken({ actionId: ACTION_B })), false, 'one move at a time');
  // The exact pair is accepted once; a replay/second move of the now-tombstoned source is not.
  assert.equal(await db.patch(FENCES_AT, movePatch(), moveToken()), true, 'the exact atomic move under its lock');
  assert.equal(await db.patch(FENCES_AT, movePatch({ to: 'cal1:2026-10-05' }), moveToken({ target: 'cal1:2026-10-05' })), false, 'never a second destination');
  // Owners afterwards: resurrecting the source, stripping or forging the relocation, or deleting either child is refused.
  const source = await db.read(actionItemAt());
  const destinationAt = actionItemAt(ACTION_A, ACTION_OTHER_PLAN);
  const destination = await db.read(destinationAt);
  assert.equal(await db.write(actionItemAt(), actionItem({ updatedAt: T + 99 })), false, 'stale client cannot resurrect the source');
  assert.equal(await db.write(actionItemAt(), { ...source, movedToDayId: 'cal1:2026-10-05' }), false, 'nor redirect its move');
  const { relocationRevision: _stripped, ...noRelocation } = destination;
  assert.equal(await db.write(destinationAt, noRelocation), false, 'the moved copy keeps its relocation');
  assert.equal(await db.write(destinationAt, { ...destination, relocationRevision: { ...destination.relocationRevision, sequence: 9 } }), false);
  assert.equal(await db.write(destinationAt, null), false);
  assert.equal(await db.write(destinationAt, { ...destination, task: 'Gym (legs)', updatedAt: T + 60 }), true, 'an ordinary edit at the new day');
});

// R1 on the REAL server, through the Function: the owner changes the item with an accepted write that keeps BOTH writer
// stamp fields, right after the Function read it. The move must be refused and the owner's content kept.
test('TASK-012 R1 (real rules): same-stamp owner edits after the Function read -> STALE_REVISION; owner content kept; nothing moved', async () => {
  for (const [name, change] of [['title', { task: 'Strength' }], ['completion', { done: true, doneAt: T + 1 }], ['time', { when: '19:00' }], ['duration', { durationMinutes: 90 }]]) {
    const { db, handle: _unused } = await mutationAccount();
    const real = createUserScopedRtdb({ databaseUrl: emulator.base, namespace: db.name, idTokens: planScopedTokens });
    const created = await createHandler(db, real)(planCommand(ACTION_A, { target: atPlan(MUTATION_PLAN), title: 'Gym', when: '18:00', whenTz: 'Asia/Manila', durationMinutes: 60 }));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const sourceAt = actionItemAt(ACTION_A, MUTATION_PLAN);
    let edited = false;
    const domain = { ...real, async readPlanFenceItemWithEtag(identity, planId, itemId) {
      const result = await real.readPlanFenceItemWithEtag(identity, planId, itemId);
      if (!edited && planId === MUTATION_PLAN && result.value && !result.value.moveLock && await db.read(`${ROOM}/calendarPlans/${MUTATION_OTHER}`)) {
        edited = true; // an accepted owner write, SAME updatedAt and updatedBy, different content
        const response = await asClient(db, 'PUT', sourceAt, ALICE, { ...result.value, ...change });
        assert.equal(response.status, 200, `${name}: the owner's same-stamp edit is accepted by the real rules`);
      }
      return result;
    } };
    const handle = createHandler(db, domain);
    const rev = (await readPlanItem(handle, MUTATION_PLAN, actionItemId(ACTION_A))).item.revision;
    const moveId = `act1_${randomUUID()}`;
    const moved = await handle(mutationCommand('plan_move', { target: atPlan(MUTATION_PLAN), itemId: actionItemId(ACTION_A), destination: atPlan(MUTATION_OTHER) }, rev, moveId));
    assert.equal(edited, true, `${name}: the edit really landed inside the window`);
    assert.equal(moved.body.error?.code, 'STALE_REVISION', `${name}: ${JSON.stringify(moved.body)}`);
    const source = await db.read(sourceAt);
    for (const [key, value] of Object.entries(change)) assert.equal(source[key], value, `${name}: owner content kept`);
    assert.equal(source.deleted, undefined, `${name}: no tombstone from stale state`);
    assert.equal(source.moveLock, undefined, `${name}: not even locked`);
    assert.equal(await db.read(actionItemAt(ACTION_A, MUTATION_OTHER)), null, `${name}: no live destination copy`);
    assert.equal((await db.read(`serverActionReceipts/alice/${moveId}`)).state, 'rejected', `${name}: receipt not applied`);
  }
});
function createHandler(db, domain) {
  const infra = infraFor(db);
  return createActionApiHandler({ keys: KEYS, owner: { ownerSubject: 'access-sub-owner-1', ownerFirebaseUid: 'alice' },
    nonces: createNonceStore({ infra }), receipts: createReceiptStore({ infra }), domain, now: () => NOW_MS });
}

// ── TASK-036 legacy-target completion (DECISIONS #41) ───────────────────────
// The Function's legacy completion against the REAL server and rules: the owner-token ETag compare-and-set of
// plans/<date> (one item replaced) and of a legacy planFences child, the cutover refusal, and account isolation.
const LEGACY_DATE = localPlanDate(NOW_MS, 'Asia/Manila');
const LEGACY = { store: 'legacy', targetId: LEGACY_DATE, key: LEGACY_DATE };
const legacyTask = (id, task, extra = {}) => ({ id, task, when: '', done: false, kind: 'task', updatedAt: T, updatedBy: 'phone', ...extra });
const legacyPlan = (stamp = T) => ({ updatedAt: stamp, updatedBy: 'phone', preparation: { targetDate: LEGACY_DATE, firstPreparedAt: T - 1, timezone: 'Asia/Manila' },
  items: [legacyTask('p1', 'Post remaining products', { updatedAt: stamp }), legacyTask('p2', 'Make price menu', { durationMinutes: 60, updatedAt: stamp }),
    legacyTask('p3', 'Pay apartment kuryente', { updatedAt: stamp })] });
async function legacyAccount() {
  const db = await freshDb();
  for (const [uid, auth, stamp] of [['alice', ALICE, T], ['mallory', MALLORY, T + 7]]) {
    assert.equal((await asClient(db, 'PUT', `rooms/uid_${uid}/settings`, auth, { timezone: 'Asia/Manila' })).status, 200);
    assert.equal((await asClient(db, 'PUT', `rooms/uid_${uid}/plans/${LEGACY_DATE}`, auth, legacyPlan(stamp))).status, 200, `${uid} wrote a legacy plan normally`);
  }
  const infra = infraFor(db);
  const domain = createUserScopedRtdb({ databaseUrl: emulator.base, namespace: db.name, idTokens: planScopedTokens });
  const handlerFor = uid => createActionApiHandler({ keys: KEYS, owner: { ownerSubject: 'access-sub-owner-1', ownerFirebaseUid: uid },
    nonces: createNonceStore({ infra }), receipts: createReceiptStore({ infra }), domain, now: () => NOW_MS, log: () => {} });
  return { db, domain, handle: handlerFor('alice'), handlerFor };
}
const atLegacy = () => ({ store: 'legacy', id: LEGACY_DATE });
async function legacyItem(handle, itemId) {
  const requestId = randomUUID();
  const response = await handle(signedRequest({ requestId, envelope: { contractVersion: 1, requestId, kind: 'get_item',
    parameters: { source: 'plan', id: itemId, target: atLegacy() } } }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.result;
}

test('TASK-036 (emulator): legacy completion and Undo through the real rules; one item replaced; replay; stale refused; neighbours and the other account untouched', async () => {
  const { db, handle } = await legacyAccount();
  const planAt = `${ROOM}/plans/${LEGACY_DATE}`;
  const malloryAt = `rooms/uid_mallory/plans/${LEGACY_DATE}`;
  const before = await db.read(planAt);
  const mallory = await db.read(malloryAt);
  const doneIds = [];
  for (const itemId of ['p1', 'p2']) {
    const actionId = `act1_${randomUUID()}`;
    const revision = (await legacyItem(handle, itemId)).item.revision;
    const done = await handle(mutationCommand('plan_set_completion', { target: atLegacy(), itemId, completed: true }, revision, actionId));
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body.result.target, { store: 'legacy', id: LEGACY_DATE, date: LEGACY_DATE });
    assert.equal(done.body.result.revision, (await legacyItem(handle, itemId)).item.revision, 'readback revision == result');
    const replay = await handle(mutationCommand('plan_set_completion', { target: atLegacy(), itemId, completed: true }, revision, actionId));
    assert.equal(replay.body.result.idempotentReplay, true);
    doneIds.push(actionId);
  }
  const after = await db.read(planAt);
  assert.deepEqual(after.items.map(item => [item.id, item.done]), [['p1', true], ['p2', true], ['p3', false]]);
  assert.deepEqual(after.items[2], before.items[2], 'the remaining task is byte-identical');
  assert.deepEqual(after.preparation, before.preparation, 'preparation kept');
  assert.equal(after.items[1].durationMinutes, 60);
  assert.equal(after.items[1].updatedBy, doneIds[1]);
  assert.deepEqual(await db.read(malloryAt), mallory, 'the other account is untouched');

  // Undo: completed:false; RTDB prunes doneAt and the planned post-state still proves APPLIED.
  const undo = await handle(mutationCommand('plan_set_completion', { target: atLegacy(), itemId: 'p2', completed: false }, (await legacyItem(handle, 'p2')).item.revision));
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  const undone = (await db.read(planAt)).items[1];
  assert.equal(undone.done, false);
  assert.equal(undone.doneAt, undefined);

  // The owner's app edits after ChatGPT read: the old revision is refused and the app's edit stands.
  const stale = (await legacyItem(handle, 'p1')).item.revision;
  const record = await db.read(planAt);
  record.items = record.items.map(item => item.id === 'p1' ? { ...item, done: false, task: 'Post remaining products (shop)', updatedAt: item.updatedAt + 1, updatedBy: 'phone' } : item);
  assert.equal((await asClient(db, 'PUT', planAt, ALICE, record)).status, 200);
  const refused = await handle(mutationCommand('plan_set_completion', { target: atLegacy(), itemId: 'p1', completed: true }, stale));
  assert.equal(refused.body.error?.code, 'STALE_REVISION', JSON.stringify(refused.body));
  const kept = (await db.read(planAt)).items[0];
  assert.deepEqual([kept.task, kept.done], ['Post remaining products (shop)', false]);
});

test('TASK-036 (emulator): a legacy-fenced Brain Dump task completes and un-completes at its own child through the real fence rules', async () => {
  const { db, handle } = await legacyAccount();
  const childAt = `${ROOM}/planFences/${LEGACY_DATE}/${ITEM_ID}`;
  await db.seed(captureAt(), promotedCapture(LEGACY));
  await db.seed(childAt, fencedItem(LEGACY));
  const record = await db.read(`${ROOM}/plans/${LEGACY_DATE}`);
  for (const completed of [true, false]) {
    const response = await handle(mutationCommand('plan_set_completion', { target: atLegacy(), itemId: ITEM_ID, completed }, (await legacyItem(handle, ITEM_ID)).item.revision));
    assert.equal(response.status, 200, `${completed}: ${JSON.stringify(response.body)}`);
    assert.equal((await db.read(childAt)).done, completed);
  }
  assert.deepEqual((await db.read(childAt)).brainDumpOrigin, origin(LEGACY), 'origin pinned');
  assert.deepEqual(await db.read(`${ROOM}/plans/${LEGACY_DATE}`), record, 'the plan record is untouched');
});

test('TASK-036 (emulator): conditional writes and isolation of the legacy primitives; no legacy write after the cutover', async () => {
  const { db, domain, handle, handlerFor } = await legacyAccount();
  const identity = { firebaseUid: 'alice', roomId: 'uid_alice' };
  const planAt = `${ROOM}/plans/${LEGACY_DATE}`;
  // A stale ETag never lands (412 -> 'changed'); the real ETag does.
  const { value, etag } = await domain.readLegacyPlanWithEtag(identity, LEGACY_DATE);
  assert.equal(await domain.putLegacyPlanIfMatch(identity, LEGACY_DATE, { ...value, updatedAt: T + 1 }, STALE_ETAG), 'changed');
  assert.equal((await db.read(planAt)).updatedAt, T);
  assert.equal(await domain.putLegacyPlanIfMatch(identity, LEGACY_DATE, { ...value, updatedAt: T + 1 }, etag), 'written');
  // Another account's token is refused by the unchanged rules at the owner's paths.
  const intruder = createUserScopedRtdb({ databaseUrl: emulator.base, namespace: db.name, idTokens: { getIdToken: async () => MALLORY } });
  await assert.rejects(intruder.readLegacyPlanWithEtag(identity, LEGACY_DATE), error => error.code === 'FORBIDDEN');
  const fresh = await domain.readLegacyPlanWithEtag(identity, LEGACY_DATE);
  await assert.rejects(intruder.putLegacyPlanIfMatch(identity, LEGACY_DATE, { ...fresh.value, updatedBy: 'mallory' }, fresh.etag), error => error.code === 'FORBIDDEN');
  // The Action API bound to the other account only ever sees that account's own room.
  const revision = (await legacyItem(handle, 'p1')).item.revision;
  const crossed = await handlerFor('mallory')(mutationCommand('plan_set_completion', { target: atLegacy(), itemId: 'p1', completed: true }, revision));
  // The binding is the verified subject -> that account's own room (TASK-029); a revision is content, not authority.
  assert.equal(crossed.body.error?.code, 'STALE_REVISION', 'another account never completes this account task by its revision');
  assert.equal((await db.read(planAt)).items[0].done, false);
  assert.equal((await db.read(`rooms/uid_mallory/plans/${LEGACY_DATE}`)).items[0].done, false);
  // After the cutover the rules refuse every legacy write, and the Function refuses before writing.
  await seedCalendarAuthority(db);
  const afterCutover = await domain.readLegacyPlanWithEtag(identity, LEGACY_DATE);
  await assert.rejects(domain.putLegacyPlanIfMatch(identity, LEGACY_DATE, { ...afterCutover.value, updatedAt: T + 2 }, afterCutover.etag), error => error.code === 'FORBIDDEN');
  const superseded = await handle(mutationCommand('plan_set_completion', { target: atLegacy(), itemId: 'p1', completed: true }, (await legacyItem(handle, 'p1')).item.revision));
  assert.equal(superseded.body.error?.code, 'PAST_TARGET_IMMUTABLE', JSON.stringify(superseded.body));
  assert.equal((await db.read(planAt)).items[0].done, false);
});

// ── TASK-038 legacy -> legacy move (DECISIONS #42) ──────────────────────────
// The Function's legacy move against the REAL server and rules: ONE owner-token ETag compare-and-set of rooms/<uid>/plans
// carrying the source tombstone and the destination copy, a race that changes the collection between read and write,
// the cutover refusal, account isolation, and the fail-closed answer when unrelated stored history no longer validates.
const addDays = (dateKey, days) => { const d = new Date(`${dateKey}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const LEGACY_NEXT = addDays(LEGACY_DATE, 1);
const moveTo = (itemId, from = LEGACY_DATE, to = LEGACY_NEXT) => ({ target: { store: 'legacy', id: from }, itemId, destination: { store: 'legacy', id: to } });
async function legacyItemOn(handle, itemId, dateKey) {
  const requestId = randomUUID();
  const response = await handle(signedRequest({ requestId, envelope: { contractVersion: 1, requestId, kind: 'get_item',
    parameters: { source: 'plan', id: itemId, target: { store: 'legacy', id: dateKey } } } }));
  return response.body.result;
}
async function legacyPlanItems(handle, dateKey) {
  const requestId = randomUUID();
  const response = await handle(signedRequest({ requestId, envelope: { contractVersion: 1, requestId, kind: 'get_plan', parameters: { target: { store: 'legacy', id: dateKey } } } }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.result.plan.items.map(item => item.itemId);
}

test('TASK-038 (emulator): move two tasks to tomorrow through the real rules in one CAS each; replay; Undo; unrelated days and the other account untouched', async () => {
  const { db, handle } = await legacyAccount();
  const plansAt = `${ROOM}/plans`;
  const older = addDays(LEGACY_DATE, -3);
  assert.equal((await asClient(db, 'PUT', `${plansAt}/${older}`, ALICE, { updatedAt: T, updatedBy: 'phone', items: [legacyTask('o1', 'Old day task')] })).status, 200);
  const before = await db.read(plansAt);
  const mallory = await db.read('rooms/uid_mallory/plans');
  for (const itemId of ['p1', 'p2']) {
    const actionId = `act1_${randomUUID()}`;
    const revision = (await legacyItemOn(handle, itemId, LEGACY_DATE)).item.revision;
    const moved = await handle(mutationCommand('plan_move', moveTo(itemId), revision, actionId));
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(moved.body.result.destination, { store: 'legacy', id: LEGACY_NEXT, date: LEGACY_NEXT });
    assert.equal(moved.body.result.revision, (await legacyItemOn(handle, itemId, LEGACY_NEXT)).item.revision, 'readback revision == result');
    const replay = await handle(mutationCommand('plan_move', moveTo(itemId), revision, actionId));
    assert.equal(replay.body.result.idempotentReplay, true);
  }
  const after = await db.read(plansAt);
  assert.deepEqual(after[older], before[older], 'an unrelated day is byte-identical');
  assert.deepEqual(after[LEGACY_DATE].items[2], before[LEGACY_DATE].items[2], 'the unselected task is byte-identical');
  assert.deepEqual(after[LEGACY_DATE].preparation, before[LEGACY_DATE].preparation);
  assert.deepEqual(after[LEGACY_DATE].items.slice(0, 2).map(item => [item.id, item.deleted, item.movedToDayId]), [['p1', true, LEGACY_NEXT], ['p2', true, LEGACY_NEXT]]);
  assert.deepEqual(after[LEGACY_NEXT].items.map(item => [item.id, item.task, item.durationMinutes ?? null, item.relocationRevision.toDayId]),
    [['p1', 'Post remaining products', null, LEGACY_NEXT], ['p2', 'Make price menu', 60, LEGACY_NEXT]]);
  assert.deepEqual(await legacyPlanItems(handle, LEGACY_DATE), ['p3']);
  assert.deepEqual(await legacyPlanItems(handle, LEGACY_NEXT), ['p1', 'p2']);
  assert.deepEqual(await db.read('rooms/uid_mallory/plans'), mallory, 'the other account is untouched');

  // Undo p2: back to today, through the same rules; no duplicate either day.
  const back = await handle(mutationCommand('plan_move', moveTo('p2', LEGACY_NEXT, LEGACY_DATE), (await legacyItemOn(handle, 'p2', LEGACY_NEXT)).item.revision));
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(await legacyPlanItems(handle, LEGACY_DATE), ['p2', 'p3']);
  assert.deepEqual(await legacyPlanItems(handle, LEGACY_NEXT), ['p1']);
  assert.equal((await db.read(`${plansAt}/${LEGACY_DATE}`)).items.filter(item => item.id === 'p2').length, 1);
});

test('TASK-038 (emulator): the collection CAS refuses a stale ETag; app writes after ChatGPT read keep another day and refuse a stale item (mid-call interleaving: plan-legacy-move.test.js)', async () => {
  const { db, domain, handle } = await legacyAccount();
  const identity = { firebaseUid: 'alice', roomId: 'uid_alice' };
  // The collection CAS: a stale ETag never lands (412 -> 'changed').
  const { value } = await domain.readLegacyPlansWithEtag(identity);
  assert.equal(await domain.putLegacyPlansIfMatch(identity, { ...value, [LEGACY_NEXT]: { updatedAt: T, updatedBy: 'x', items: [legacyTask('z', 'z')] } }, STALE_ETAG), 'changed');
  assert.equal(await db.read(`${ROOM}/plans/${LEGACY_NEXT}`), null);
  // The app writes tomorrow's plan after ChatGPT read today's: the move still lands and keeps the app's plan.
  assert.equal((await asClient(db, 'PUT', `${ROOM}/plans/${LEGACY_NEXT}`, ALICE, { updatedAt: T + 3, updatedBy: 'phone', items: [legacyTask('t1', 'Planned in the app')] })).status, 200);
  const moved = await handle(mutationCommand('plan_move', moveTo('p1'), (await legacyItemOn(handle, 'p1', LEGACY_DATE)).item.revision));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual((await db.read(`${ROOM}/plans/${LEGACY_NEXT}`)).items.map(item => item.id), ['t1', 'p1']);
  // The app renames p2 after ChatGPT read it: the old revision is refused and nothing moves.
  const stale = (await legacyItemOn(handle, 'p2', LEGACY_DATE)).item.revision;
  const record = await db.read(`${ROOM}/plans/${LEGACY_DATE}`);
  record.items = record.items.map(item => (item.id === 'p2' ? { ...item, task: 'Make price menu (v2)', updatedAt: item.updatedAt + 9 } : item));
  assert.equal((await asClient(db, 'PUT', `${ROOM}/plans/${LEGACY_DATE}`, ALICE, record)).status, 200);
  const refused = await handle(mutationCommand('plan_move', moveTo('p2'), stale));
  assert.equal(refused.body.error?.code, 'STALE_REVISION', JSON.stringify(refused.body));
  assert.deepEqual(await legacyPlanItems(handle, LEGACY_DATE), ['p2', 'p3']);
  assert.deepEqual(await legacyPlanItems(handle, LEGACY_NEXT), ['p1', 't1']);
});

test('TASK-038 (emulator): isolation and cutover; another account can neither read nor move these tasks; no legacy move after cutover', async () => {
  const { db, domain, handle, handlerFor } = await legacyAccount();
  const identity = { firebaseUid: 'alice', roomId: 'uid_alice' };
  const intruder = createUserScopedRtdb({ databaseUrl: emulator.base, namespace: db.name, idTokens: { getIdToken: async () => MALLORY } });
  await assert.rejects(intruder.readLegacyPlansWithEtag(identity), error => error.code === 'FORBIDDEN');
  const fresh = await domain.readLegacyPlansWithEtag(identity);
  await assert.rejects(intruder.putLegacyPlansIfMatch(identity, { ...fresh.value, [LEGACY_NEXT]: { items: [] } }, fresh.etag), error => error.code === 'FORBIDDEN');
  const revision = (await legacyItemOn(handle, 'p1', LEGACY_DATE)).item.revision;
  const crossed = await handlerFor('mallory')(mutationCommand('plan_move', moveTo('p1'), revision));
  assert.equal(crossed.body.error?.code, 'STALE_REVISION', 'the bound account only ever sees its own room');
  assert.equal(await db.read(`${ROOM}/plans/${LEGACY_NEXT}`), null);
  assert.equal(await db.read(`rooms/uid_mallory/plans/${LEGACY_NEXT}`), null);
  // After the cutover the rules refuse the collection write, and the Function refuses before writing.
  await seedCalendarAuthority(db);
  const afterCutover = await domain.readLegacyPlansWithEtag(identity);
  await assert.rejects(domain.putLegacyPlansIfMatch(identity, { ...afterCutover.value, [LEGACY_NEXT]: { items: [] } }, afterCutover.etag), error => error.code === 'FORBIDDEN');
  const superseded = await handle(mutationCommand('plan_move', moveTo('p1'), (await legacyItemOn(handle, 'p1', LEGACY_DATE)).item.revision));
  assert.equal(superseded.body.error?.code, 'PAST_TARGET_IMMUTABLE', JSON.stringify(superseded.body));
  assert.equal(await db.read(`${ROOM}/plans/${LEGACY_NEXT}`), null);
});

test('TASK-038 (emulator, known limit): stored history the rules no longer accept fails the move closed; refused, nothing written', async () => {
  const { db, handle } = await legacyAccount();
  // A pre-fence Brain Dump array item whose capture no longer exists: readable, but not writable again.
  await db.seed(`${ROOM}/plans/${addDays(LEGACY_DATE, -30)}`, { updatedAt: T, updatedBy: 'phone', items: [legacyTask('bdp1|gone01', 'Old Brain Dump task')] });
  const before = await db.read(`${ROOM}/plans`);
  const response = await handle(mutationCommand('plan_move', moveTo('p1'), (await legacyItemOn(handle, 'p1', LEGACY_DATE)).item.revision));
  assert.equal(response.body.error?.code, 'CONFLICT', JSON.stringify(response.body));
  assert.match(response.body.error.message, /Nothing was moved; move it in the ChronaSense app/);
  assert.deepEqual(await db.read(`${ROOM}/plans`), before, 'nothing written');
});
