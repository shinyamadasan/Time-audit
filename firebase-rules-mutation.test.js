// firebase-rules-mutation.test.js
//
// Mutation proof for the fence rules. firebase-rules-emulator.test.js says the real rules refuse every
// attack; this says it is not by accident. scripts/firebase-rules-builder.mjs builds the rules from NAMED
// predicates, so each predicate can be switched off in a rebuilt rule set. For every one, the attack it
// exists to stop must (a) be REFUSED by the real rules and (b) SUCCEED against the mutant, on the real
// Realtime Database emulator. A predicate whose removal changes nothing would be dead weight, and an
// attack the matrix does not cover would let its mutant survive: this fails either way.
//
// Needs Java + the cached emulator jar (see rtdb-emulator-support.js). Run: npm run test:rules-mutation

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOM, startEmulator } from './rtdb-emulator-support.js';
import { PREDICATES, artifactMatchesBuilder, buildRules, serializeRules } from './scripts/firebase-rules-builder.mjs';
import { ITEM_ID, STORES, T, capture, captureAt, claim, expired, fencedItem, planRecord, promotedCapture,
  ACTION_A, ACTION_B, ACTION_OTHER_PLAN, ACTION_PLAN, actionItem, actionItemAt, actionItemId, planActionToken, seedCalendarAuthority,
  FENCES_AT, moveToken, movePatch, relocation } from './fence-rules-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED = readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8');
const CAL = STORES.calendar;
const LEGACY = STORES.legacy;
const revoked = (def, extra = {}) => capture({ promotionClaim: claim(def, { revokedAt: T + 5 }), ...extra });

let emulator;
test.before(async () => { emulator = await startEmulator(); });
test.after(() => emulator?.stop());

test('the committed firebase.rules.json is exactly the builder\'s output (no hand edit can drift from the named predicates)', () => {
  // CRLF-vs-LF is the only tolerated difference (a Windows autocrlf checkout); the comparison is the builder's own.
  assert.ok(artifactMatchesBuilder(COMMITTED, serializeRules(buildRules())), 'firebase.rules.json is not the builder output');
});

/** predicate -> the attack it stops. Each returns true iff the SERVER ALLOWED the forbidden write. */
const ATTACKS = {
  async targetBinding(db) { await db.seed(captureAt(), capture({ promotionClaim: claim(CAL) })); return db.write(CAL.fenceAt(CAL.otherKey), fencedItem(CAL)); },
  async storeBinding(db) {
    // A calendar claim whose physical key happens to read as a legacy date: only the store check can refuse it in planFences.
    const lookalike = { targetId: CAL.targetId, targetKey: LEGACY.key };
    await db.seed(captureAt(), capture({ promotionClaim: claim(CAL, lookalike) }));
    return db.write(LEGACY.itemAt, fencedItem(CAL, { origin: { targetKey: LEGACY.key } }));
  },
  async originImmutability(db) {
    await db.seed(captureAt(), promotedCapture(CAL));
    await db.seed(CAL.itemAt, fencedItem(CAL));
    return db.write(CAL.itemAt, fencedItem(CAL, { origin: { type: 'schedule' } }));
  },
  async itemIdBinding(db) { await db.seed(captureAt(), capture({ promotionClaim: claim(CAL) })); return db.write(CAL.itemAt, fencedItem(CAL, { id: 'bdp1|bother001' })); },
  async revokeMonotonic(db) { await db.seed(captureAt(), revoked(CAL)); return db.write(captureAt(), capture({ promotionClaim: claim(CAL) })); },
  async epochMonotonic(db) { await db.seed(captureAt(), capture({ claimEpoch: 2 })); return db.write(captureAt(), capture({ claimEpoch: 1 })); },
  async tombstoneMonotonic(db) {
    await db.seed(captureAt(), promotedCapture(CAL));
    await db.seed(CAL.itemAt, fencedItem(CAL, { deleted: true }));
    return db.write(CAL.itemAt, fencedItem(CAL, { deleted: false, updatedAt: T + 99 }));
  },
  async stableKeyFormat(db) {
    const bogus = 'cal1:not-a-date';
    await db.seed(captureAt(), capture({ promotionClaim: claim(CAL, { targetKey: bogus }) }));
    return db.write(`${ROOM}/${CAL.fence}/${bogus}/${ITEM_ID}`, fencedItem(CAL, { origin: { targetKey: bogus } }));
  },
  async parentOverwriteClosed(db) {
    await db.seed(captureAt(), capture({ promotionClaim: claim(CAL) }));
    return db.write(`${ROOM}/${CAL.fence}/${CAL.key}`, { [ITEM_ID]: fencedItem(CAL, { origin: { claimEpoch: 5 } }) });
  },
  async epochBinding(db) { await db.seed(captureAt(), capture({ promotionClaim: claim(CAL) })); return db.write(CAL.itemAt, fencedItem(CAL, { origin: { claimEpoch: 1 } })); },
  async claimIdentity(db) { await db.seed(captureAt(), capture({ promotionClaim: claim(CAL) })); return db.write(captureAt(), capture({ promotionClaim: claim(CAL, { targetKey: CAL.otherKey, targetId: CAL.otherId }) })); },
  async recoveryAbsence(db) {
    await db.seed(captureAt(), revoked(CAL));
    await db.seed(CAL.itemAt, fencedItem(CAL));
    return db.write(captureAt(), capture({ claimEpoch: 1, expiredClaim: expired(CAL) }));
  },
  async finalizePresence(db) { await db.seed(captureAt(), revoked(CAL)); return db.write(captureAt(), promotedCapture(CAL, { updatedAt: T + 7 })); },
  async claimDeletionClosed(db) { await db.seed(captureAt(), capture({ promotionClaim: claim(CAL) })); return db.write(captureAt(), capture({})); },
  async relocationRefused(db) {
    await db.seed(captureAt(), promotedCapture(CAL));
    return db.write(CAL.itemAt, fencedItem(CAL, { relocationRevision: { schemaVersion: 1, sequence: 1, fromDayId: CAL.targetId, toDayId: CAL.otherId, updatedBy: 'd' } }));
  },
  // ── Action API plan items (TASK-011) ──
  async actionKindBinding(db) { await seedCalendarAuthority(db); return db.write(actionItemAt(), actionItem(), planActionToken(ACTION_A, { kind: 'brain_dump_add' })); },
  async actionTargetBinding(db) { await seedCalendarAuthority(db); return db.write(actionItemAt(), actionItem(), planActionToken(ACTION_A, { target: ACTION_OTHER_PLAN })); },
  async actionMarkerBinding(db) {
    // A self-consistent item of ANOTHER action, written with this action's token.
    await seedCalendarAuthority(db);
    return db.write(actionItemAt(ACTION_B), actionItem({ id: actionItemId(ACTION_B), creationActionId: ACTION_B }), planActionToken(ACTION_A));
  },
  async actionIdMarkerConsistency(db) {
    // The token's own marker, at an item id that does not derive from it.
    await seedCalendarAuthority(db);
    return db.write(actionItemAt(ACTION_B), actionItem({ id: actionItemId(ACTION_B) }), planActionToken(ACTION_A));
  },
  async actionCreateOnly(db) {
    // The action token re-"creating" over its own tombstone would resurrect it.
    await seedCalendarAuthority(db);
    await db.seed(actionItemAt(), actionItem({ deleted: true }));
    return db.write(actionItemAt(), actionItem(), planActionToken());
  },
  async actionAuthorityRequired(db) { return db.write(actionItemAt(), actionItem(), planActionToken()); },
  async actionTombstoneMonotonic(db) {
    await seedCalendarAuthority(db);
    await db.seed(actionItemAt(), actionItem({ deleted: true }));
    return db.write(actionItemAt(), actionItem({ deleted: false, updatedAt: T + 99 }));
  },
  async actionRelocationRefused(db) {
    // A plan_create token cannot create an item that claims to have moved already.
    await seedCalendarAuthority(db);
    return db.write(actionItemAt(), actionItem({ relocationRevision: relocation({ fromDayId: ACTION_OTHER_PLAN, toDayId: ACTION_PLAN }) }), planActionToken());
  },
  // ── TASK-012 api1_ move: each attack is otherwise a well-formed atomic move ──
  async actionMoveBinding(db) {
    await seedCalendarAuthority(db);
    await db.seed(actionItemAt(), actionItem());
    return db.patch(FENCES_AT, movePatch(), moveToken({ item: actionItemId(ACTION_B) })); // a token minted for another item
  },
  async actionMoveSourceLive(db) {
    await seedCalendarAuthority(db);
    await db.seed(actionItemAt(), actionItem({ deleted: true })); // a deleted task "moved" back to life on another day
    return db.patch(FENCES_AT, movePatch(), moveToken());
  },
  async actionMoveSourceStamp(db) {
    await seedCalendarAuthority(db);
    await db.seed(actionItemAt(), actionItem({ task: 'Owner edit', updatedAt: T + 9, updatedBy: 'phone' })); // edited after the read
    return db.patch(FENCES_AT, movePatch(), moveToken());
  },
  async actionMoveLinked(db) {
    await seedCalendarAuthority(db);
    await db.seed(actionItemAt(), actionItem());
    return db.patch(FENCES_AT, movePatch({ omitSource: true }), moveToken()); // a destination copy with the source still live
  },
  async actionMoveSequence(db) {
    await seedCalendarAuthority(db);
    await db.seed(actionItemAt(), actionItem());
    return db.patch(FENCES_AT, movePatch({ reloc: { sequence: 7 } }), moveToken()); // a forged relocation order
  },
  async actionRelocationImmutable(db) {
    await seedCalendarAuthority(db);
    await db.seed(actionItemAt(), actionItem());
    return db.write(actionItemAt(), actionItem({ relocationRevision: relocation(), updatedAt: T + 1 })); // an ordinary owner write fabricating a move
  },
  async actionCaptureKind(db) {
    const id = `bdc1_${ACTION_A.slice(5)}`;
    return db.write(captureAt(id), capture({ id, creationActionId: ACTION_A }), planActionToken());
  },
  async arrayActionRefused(db) { return db.write(CAL.planAt, planRecord([actionItem()])); },
};

test('every named predicate has an attack in this suite (a new predicate cannot ship unproven)', () => {
  assert.deepEqual(Object.keys(ATTACKS).sort(), [...PREDICATES].sort());
});

for (const predicate of PREDICATES) {
  test(`mutant: without "${predicate}" the attack it stops is ACCEPTED by the server (and refused by the real rules)`, async () => {
    const real = await emulator.fresh(COMMITTED);
    assert.equal(await ATTACKS[predicate](real), false, `the real rules must refuse the "${predicate}" attack`);
    const mutant = await emulator.fresh(serializeRules(buildRules({ without: [predicate] })));
    assert.equal(await ATTACKS[predicate](mutant), true, `with "${predicate}" removed the attack must get through, or the predicate is not load-bearing`);
  });
}

test('the legacy-array authorization is load-bearing too: with it removed, a forged unfenced bdp1 item lands in an ordinary array', async () => {
  const forged = { id: 'bdp1|bforged01', task: 'forged', when: '', done: false, updatedAt: T, updatedBy: 'x' };
  const attack = db => db.write(CAL.planAt, planRecord([forged]));
  assert.equal(await attack(await emulator.fresh(COMMITTED)), false, 'refused: no such capture');
  const rules = buildRules();
  const items = rules.rules.rooms.$roomId.calendarPlans.$planId.items.$i;
  items['.validate'] = '!newData.child(\'brainDumpOrigin\').exists()'; // the array rule without any capture authorization
  assert.equal(await attack(await emulator.fresh(JSON.stringify(rules))), true, 'accepted once the capture authorization is gone');
});
