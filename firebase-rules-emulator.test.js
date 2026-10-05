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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MALLORY, ROOM, startEmulator } from './rtdb-emulator-support.js';
import {
  CAPTURE, ITEM_ID, STORES, T, capture, captureAt, claim, expired, fencedItem, legacyClaim, ordinary, origin, planRecord, promotedCapture, promotion,
} from './fence-rules-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8');

let emulator;
test.before(async () => { emulator = await startEmulator(); });
test.after(() => emulator?.stop());
const freshDb = () => emulator.fresh(RULES);

/** The state in which a fenced item is authorized: a live claim at the exact location. */
async function liveClaim(db, def, extra = {}) { await db.seed(captureAt(), capture({ promotionClaim: claim(def), ...extra })); }
async function promoted(db, def, extra = {}) { await db.seed(captureAt(), promotedCapture(def, extra)); }
const otherStore = def => Object.values(STORES).find(o => o.store !== def.store);

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
