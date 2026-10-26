// TASK-029: the backend's explicit two-entry allowlist (owner pair + optional second pair). The signed subject is
// the ONLY input: it resolves to exactly its own configured UID and room, and every malformed, partial or colliding
// configuration refuses every call, the owner's included. Fixture identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { COMMAND_PATH } from '../src/action-api.js';
import { actionActorRef } from '../src/envelope.js';
import { captureIdForAction } from '../src/command-identity.js';
import { bindIdentity, identityAllowlist } from '../src/identity.js';
import { NOW_S, capture, harness, signedRequest } from './support.js';

const A = Object.freeze({ subject: 'access-sub-owner-a', uid: 'uidOwnerA' });
const B = Object.freeze({ subject: 'access-sub-second-b', uid: 'uidSecondB' });
const BOTH = Object.freeze({ ownerSubject: A.subject, ownerFirebaseUid: A.uid, secondSubject: B.subject, secondFirebaseUid: B.uid });
const OWNER_ONLY = Object.freeze({ ownerSubject: A.subject, ownerFirebaseUid: A.uid, secondSubject: '', secondFirebaseUid: '' });
const ROOMS = Object.freeze({
  [`uid_${A.uid}`]: { brainDump: { cap_a: capture('cap_a', { text: 'owner A private' }) } },
  [`uid_${B.uid}`]: { brainDump: { cap_b: capture('cap_b', { text: 'second B private' }) } },
});
const read = subject => signedRequest({ signed: { subject } });

test('allowlist config: owner only, or owner + a complete, distinct, well-formed second pair; anything else refuses', () => {
  assert.deepEqual(identityAllowlist({ ownerSubject: A.subject, ownerFirebaseUid: A.uid }), [{ subject: A.subject, firebaseUid: A.uid }]);
  assert.deepEqual(identityAllowlist(OWNER_ONLY), [{ subject: A.subject, firebaseUid: A.uid }]);
  assert.deepEqual(identityAllowlist(BOTH), [{ subject: A.subject, firebaseUid: A.uid }, { subject: B.subject, firebaseUid: B.uid }]);
  const invalid = [
    undefined, {}, { ...BOTH, ownerSubject: '' }, { ...BOTH, ownerFirebaseUid: undefined },
    { ...BOTH, secondFirebaseUid: '' }, { ...BOTH, secondSubject: '' },        // half-set second pair
    { ...BOTH, secondSubject: A.subject }, { ...BOTH, secondFirebaseUid: A.uid }, // colliding with the owner
    { ...BOTH, secondSubject: 'a,b' }, { ...BOTH, secondSubject: 'has space' }, { ...BOTH, ownerSubject: 'x\ny' },
    { ...BOTH, secondFirebaseUid: '../uid_victim' }, { ...BOTH, secondFirebaseUid: 'uid/x' }, { ...BOTH, secondSubject: 42 },
  ];
  for (const config of invalid) {
    assert.throws(() => identityAllowlist(config), error => error.code === 'FORBIDDEN' && error.reason === 'owner-mapping-missing', JSON.stringify(config));
  }
});

test('bindIdentity: A -> A room, B -> B room; unknown, removed or case-variant subjects are refused', () => {
  const scopes = ['chronasense:read'];
  assert.deepEqual({ ...bindIdentity({ subject: A.subject, scopes }, BOTH) }, { principalSubject: A.subject, firebaseUid: A.uid, roomId: `uid_${A.uid}`, scopes });
  assert.deepEqual({ ...bindIdentity({ subject: B.subject, scopes }, BOTH) }, { principalSubject: B.subject, firebaseUid: B.uid, roomId: `uid_${B.uid}`, scopes });
  assert.equal(bindIdentity({ subject: A.subject, scopes }, OWNER_ONLY).firebaseUid, A.uid, 'existing owner unchanged');
  for (const [subject, owner] of [['access-sub-unknown', BOTH], [B.subject, OWNER_ONLY], [B.subject.toUpperCase(), BOTH], [`${B.subject}x`, BOTH]]) {
    assert.throws(() => bindIdentity({ subject, scopes }, owner), error => error.code === 'FORBIDDEN' && error.reason === 'owner-mismatch');
  }
});

test('A->A and B->B through the full pipeline: each signed subject reads only its own room', async () => {
  for (const [user, mine, theirs] of [[A, 'cap_a', 'cap_b'], [B, 'cap_b', 'cap_a']]) {
    const h = harness({ owner: BOTH, rooms: ROOMS });
    const response = await h.handle(read(user.subject));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const ids = response.body.result.captures.map(item => item.captureId);
    assert.deepEqual(ids, [mine]);
    assert.ok(!response.payload.includes(theirs) && !response.payload.includes(user === A ? B.uid : A.uid));
    assert.deepEqual(h.domain.reads, [{ roomId: `uid_${user.uid}`, collection: 'brainDump' }]);
  }
});

test('A->B, B->A and unknown: no request field can choose another room; an unmapped subject touches nothing', async () => {
  // The envelope has no account/room/uid field: a forged one is rejected before any domain access.
  const h = harness({ owner: BOTH, rooms: ROOMS });
  for (const subject of [A.subject, B.subject]) {
    const forgedRoom = signedRequest({ signed: { subject }, envelope: { contractVersion: 1, requestId: randomUUID(), kind: 'get_brain_dump',
      parameters: { roomId: `uid_${subject === A.subject ? B.uid : A.uid}` } } });
    const response = await h.handle(forgedRoom);
    assert.notEqual(response.status, 200);
  }
  assert.deepEqual(h.domain.reads, []);
  for (const [subject, owner] of [['access-sub-unknown', BOTH], [B.subject, OWNER_ONLY]]) {
    const g = harness({ owner, rooms: ROOMS });
    const response = await g.handle(read(subject));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
    assert.deepEqual(g.domain.reads, []);
    assert.deepEqual(g.infra.calls, [], 'refused before the replay nonce or any receipt');
  }
});

test('expired or forged service credentials for B are refused; B identity does not bypass HMAC', async () => {
  const h = harness({ owner: BOTH, rooms: ROOMS });
  const stale = await h.handle(signedRequest({ signed: { subject: B.subject, timestamp: NOW_S - 301 } }));
  assert.equal(stale.status, 401);
  const forged = await h.handle(signedRequest({ signed: { subject: B.subject }, key: Buffer.alloc(32, 9) }));
  assert.equal(forged.status, 401);
  // Signed as A, header rewritten to B after signing: the signature no longer matches.
  const swapped = await h.handle(signedRequest({ signed: { subject: A.subject },
    mutate: headers => headers.map(value => value === A.subject ? B.subject : value) }));
  assert.equal(swapped.status, 401);
  assert.deepEqual(h.domain.reads, []);
});

test('invalid identity configuration refuses every call, the owner included', async () => {
  for (const owner of [{ ...BOTH, secondFirebaseUid: '' }, { ...BOTH, secondSubject: A.subject }, { ...BOTH, secondFirebaseUid: A.uid }]) {
    for (const subject of [A.subject, B.subject]) {
      const h = harness({ owner, rooms: ROOMS });
      const response = await h.handle(read(subject));
      assert.equal(response.status, 403);
      assert.equal(response.reason, 'owner-mapping-missing');
      assert.deepEqual(h.domain.reads, []);
    }
  }
});

function roomDomain() {
  const rooms = new Map();
  const writes = [];
  const room = id => rooms.get(id) ?? rooms.set(id, new Map()).get(id);
  return { rooms, writes,
    async createCaptureIfAbsent(identity, captureId, _actionId, record) {
      writes.push(identity.roomId);
      if (!room(identity.roomId).has(captureId)) room(identity.roomId).set(captureId, structuredClone(record));
    },
    async readCapture(identity, captureId) { return room(identity.roomId).get(captureId) ?? null; } };
}

test('B write lands in B room with B receipt and B actor; the same actionId from A is a separate, idempotent A action', async () => {
  const actionId = 'act1_550e8400-e29b-41d4-a716-446655440000';
  const store = roomDomain();
  const h = harness({ owner: BOTH, domain: store });
  const write = (user, actorSubject = user.subject) => {
    const requestId = randomUUID();
    return signedRequest({ path: COMMAND_PATH, requestId, signed: { path: COMMAND_PATH, subject: user.subject, scopes: ['chronasense:brain-dump.write'] },
      envelope: { contractVersion: 1, requestId, actionId, kind: 'brain_dump_add', parameters: { text: 'note' }, expectedRevision: null,
        actionProvenance: { version: 1, sourceKind: 'chatgpt_plugin', actionId, actorRef: actionActorRef(actorSubject), capturedAt: new Date(NOW_S * 1000).toISOString() } } });
  };
  // B cannot claim A's actor provenance (nor the reverse): the actor is derived from the signed subject.
  const spoofed = await h.handle(write(B, A.subject));
  assert.notEqual(spoofed.status, 200);
  assert.deepEqual(store.writes, []);

  const b = await h.handle(write(B));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.deepEqual(store.writes, [`uid_${B.uid}`]);
  assert.equal(store.rooms.get(`uid_${B.uid}`).get(captureIdForAction(actionId)).updatedBy, actionActorRef(B.subject));
  const receipts = [...h.infra.data.keys()].filter(key => key.startsWith('serverActionReceipts/'));
  assert.deepEqual(receipts, [`serverActionReceipts/${B.uid}/${actionId}`]);

  const a = await h.handle(write(A));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.result.idempotentReplay, false, 'A is not a replay of B');
  assert.deepEqual(store.writes, [`uid_${B.uid}`, `uid_${A.uid}`]);
  const replayB = await h.handle(write(B));
  assert.equal(replayB.body.result.idempotentReplay, true);
  assert.deepEqual(store.writes, [`uid_${B.uid}`, `uid_${A.uid}`], 'replay writes nothing');
});

test('logs never carry a subject, UID, room or capture text', async () => {
  const h = harness({ owner: BOTH, rooms: ROOMS });
  for (const subject of [A.subject, B.subject, 'access-sub-unknown']) await h.handle(read(subject));
  const text = JSON.stringify(h.logs);
  for (const secret of [A.subject, B.subject, 'access-sub-unknown', A.uid, B.uid, 'private']) assert.ok(!text.includes(secret), secret);
});
