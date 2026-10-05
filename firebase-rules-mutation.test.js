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
import { PREDICATES, buildRules, serializeRules } from './scripts/firebase-rules-builder.mjs';
import { ITEM_ID, STORES, T, capture, captureAt, claim, expired, fencedItem, planRecord, promotedCapture } from './fence-rules-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED = readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8');
const CAL = STORES.calendar;
const LEGACY = STORES.legacy;
const revoked = (def, extra = {}) => capture({ promotionClaim: claim(def, { revokedAt: T + 5 }), ...extra });

let emulator;
test.before(async () => { emulator = await startEmulator(); });
test.after(() => emulator?.stop());

test('the committed firebase.rules.json is exactly the builder\'s output (no hand edit can drift from the named predicates)', () => {
  assert.equal(COMMITTED, serializeRules(buildRules()));
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
