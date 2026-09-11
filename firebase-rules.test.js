// firebase-rules.test.js
//
// Shared Access Hardening V1 — authorization proof for firebase.rules.json.
//
// The full Firebase Emulator Suite needs a JDK + the Firebase CLI, neither of
// which is available in this environment. `targaryen` is the standard pure-JS
// interpreter for Realtime Database security rules — it parses the same
// firebase.rules.json the project deploys and evaluates reads/writes against
// mock auth + mock data, with no Java, no network, no emulator process.
//
// Run: node --test firebase-rules.test.js   (also part of `npm test`)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import targaryen from 'targaryen';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8'));

const A = { uid: 'alice_uid' };
const B = { uid: 'bob_uid' };
const C = { uid: 'carol_uid' }; // unrelated attacker

const db = (data) => targaryen.database(rules, data);
const canRead = (data, who, at) => db(data).as(who).read(at).allowed;
const canWrite = (data, who, at, value) => db(data).as(who).write(at, value).allowed;

// A <-> B linked reciprocally; C has self-claimed A as partner (attacker move).
const LINKED = {
  uid_alice_uid: { partnerUid: 'bob_uid', public: { deepHrsToday: 2 }, shared: { version: 1 } },
  uid_bob_uid:   { partnerUid: 'alice_uid', public: { deepHrsToday: 1 }, shared: { version: 1 } },
  uid_carol_uid: { partnerUid: 'alice_uid' },
  pairs: { ABC123: { creator: 'alice_uid', partner: 'bob_uid', createdAt: 1000 } }
};

test('shared node — write is owner-only', () => {
  assert.equal(canWrite(LINKED, A, '/uid_alice_uid/shared', { version: 2 }), true, 'owner writes own');
  assert.equal(canWrite(LINKED, B, '/uid_alice_uid/shared', { version: 9 }), false, 'linked partner cannot write');
  assert.equal(canWrite(LINKED, C, '/uid_alice_uid/shared', { version: 9 }), false, 'unrelated cannot write');
  assert.equal(canWrite(LINKED, null, '/uid_alice_uid/shared', { version: 9 }), false, 'unauth cannot write');
});

test('shared node — read is owner + reciprocally-linked partner only', () => {
  assert.equal(canRead(LINKED, A, '/uid_alice_uid/shared'), true, 'owner reads own');
  assert.equal(canRead(LINKED, B, '/uid_alice_uid/shared'), true, 'reciprocal partner reads');
  assert.equal(canRead(LINKED, C, '/uid_alice_uid/shared'), false, 'unrelated authed denied');
  assert.equal(canRead(LINKED, null, '/uid_alice_uid/shared'), false, 'unauthenticated denied');
});

test('shared node — attacker cannot self-grant by claiming the victim as their partner', () => {
  // C.partnerUid === alice_uid is already set in LINKED, but alice.partnerUid !== carol.
  assert.equal(canRead(LINKED, C, '/uid_alice_uid/shared'), false);
  // One-sided link (viewer claims owner, owner has not claimed viewer) is not enough.
  const oneSided = { uid_alice_uid: { shared: {} }, uid_bob_uid: { partnerUid: 'alice_uid' } };
  assert.equal(canRead(oneSided, B, '/uid_alice_uid/shared'), false);
});

test('partnerUid — a user may write only their own', () => {
  assert.equal(canWrite(LINKED, A, '/uid_alice_uid/partnerUid', 'bob_uid'), true, 'owner sets own');
  assert.equal(canWrite(LINKED, A, '/uid_alice_uid/partnerUid', null), true, 'owner clears own');
  assert.equal(canWrite(LINKED, C, '/uid_alice_uid/partnerUid', 'carol_uid'), false, 'attacker cannot write victim');
  assert.equal(canWrite(LINKED, B, '/uid_alice_uid/partnerUid', 'bob_uid'), false, 'even the real partner cannot write it');
  assert.equal(canWrite(LINKED, null, '/uid_alice_uid/partnerUid', 'x'), false, 'unauth cannot write');
  assert.equal(canRead(LINKED, C, '/uid_alice_uid/partnerUid'), false, 'partnerUid not readable by others');
});

test('pairs — record is readable only by its two participants, never enumerable', () => {
  assert.equal(canRead(LINKED, A, '/pairs/ABC123'), true, 'creator reads');
  assert.equal(canRead(LINKED, B, '/pairs/ABC123'), true, 'partner reads');
  assert.equal(canRead(LINKED, C, '/pairs/ABC123'), false, 'outsider denied — no UID directory');
  assert.equal(canRead(LINKED, null, '/pairs/ABC123'), false, 'unauth denied');
  assert.equal(canRead(LINKED, C, '/pairs'), false, 'collection not listable');
});

test('pairs — existing pair cannot be hijacked', () => {
  assert.equal(canWrite(LINKED, C, '/pairs/ABC123/partner', 'carol_uid'), false, 'cannot steal filled slot');
  assert.equal(canWrite(LINKED, C, '/pairs/ABC123/creator', 'carol_uid'), false, 'cannot rewrite creator');
  assert.equal(canWrite(LINKED, C, '/pairs/ABC123', null), false, 'cannot delete a pair it is not in');
  assert.equal(canWrite(LINKED, B, '/pairs/ABC123', null), false, 'partner cannot delete the record');
  assert.equal(canWrite(LINKED, A, '/pairs/ABC123', null), true, 'creator can delete own pair');
});

test('pairs — legitimate handshake works with owner-only writes', () => {
  const empty = { pairs: {} };
  assert.equal(canWrite(empty, A, '/pairs/NEW1', { creator: 'alice_uid', createdAt: 2000 }), true, 'A creates');
  assert.equal(canWrite(empty, C, '/pairs/NEW1', { creator: 'alice_uid', createdAt: 2000 }), false, 'C cannot forge a pair as A');
  assert.equal(canWrite(empty, A, '/pairs/NEW1', { creator: 'alice_uid', partner: 'x', createdAt: 2000 }), false, 'creator cannot pre-fill partner');

  const open = { pairs: { NEW1: { creator: 'alice_uid', createdAt: 2000 } } };
  assert.equal(canWrite(open, B, '/pairs/NEW1/partner', 'bob_uid'), true, 'B joins by claiming the open slot');
  assert.equal(canRead(open, B, '/pairs/NEW1'), false, 'B cannot read until it is a participant');
  assert.equal(canWrite(open, B, '/pairs/NEW1', { creator: 'bob_uid', partner: 'bob_uid', createdAt: 2000 }), false, 'joiner cannot rewrite creator');

  const filled = { pairs: { NEW1: { creator: 'alice_uid', partner: 'bob_uid', createdAt: 2000 } } };
  assert.equal(canRead(filled, B, '/pairs/NEW1'), true, 'B reads after joining to learn the creator UID');
  assert.equal(canWrite(filled, B, '/pairs/NEW1/partner', null), true, 'joiner can release its own slot on disconnect');
});

test('F2 rule fix — a claimant cannot combine "claim partner" with "set accepted" in one write', () => {
  // The exact discovered vector: an open pair (creator=A, no partner/accepted yet). B sends
  // ONE write to pairs/<code> that both claims the slot and sets accepted:true, trying to
  // suppress A's pending Accept/Reject prompt. Must be denied outright.
  const open = { pairs: { NEW1: { creator: 'alice_uid', createdAt: 2000 } } };
  assert.equal(
    canWrite(open, B, '/pairs/NEW1', { creator: 'alice_uid', partner: 'bob_uid', accepted: true, createdAt: 2000 }),
    false,
    'combined claim+accept forgery must be denied'
  );
  // Same attack via update() semantics at the record root.
  assert.equal(
    canWrite(open, B, '/pairs/NEW1', { ...open.pairs.NEW1, partner: 'bob_uid', accepted: true }),
    false,
    'combined claim+accept forgery denied regardless of write shape'
  );

  // A — normal claim (partner only) still works.
  assert.equal(canWrite(open, B, '/pairs/NEW1/partner', 'bob_uid'), true, 'A: plain claim still allowed');

  // B — claimant cannot alter accepted while claiming, even to false-ish/other values.
  assert.equal(
    canWrite(open, B, '/pairs/NEW1', { creator: 'alice_uid', partner: 'bob_uid', accepted: true, createdAt: 2000 }),
    false, 'B: claim + accepted=true denied'
  );

  // C — claimant cannot alter createdAt while claiming.
  assert.equal(
    canWrite(open, B, '/pairs/NEW1', { creator: 'alice_uid', partner: 'bob_uid', createdAt: 9999 }),
    false, 'C: claim + forged createdAt denied'
  );

  // D — claimant can still clear THEIR OWN pending claim without touching accepted/createdAt.
  const claimed = { pairs: { NEW1: { creator: 'alice_uid', partner: 'bob_uid', createdAt: 2000 } } };
  assert.equal(canWrite(claimed, B, '/pairs/NEW1/partner', null), true, 'D: claimant self-cancel still allowed');
  assert.equal(
    canWrite(claimed, B, '/pairs/NEW1', { creator: 'alice_uid', createdAt: 2000 }),
    true, 'D: claimant self-cancel via full-record write still allowed'
  );

  // E — the creator retains sole authority to set accepted through explicit Accept.
  assert.equal(canWrite(claimed, A, '/pairs/NEW1/accepted', true), true, 'E: creator explicit Accept still allowed');
  assert.equal(
    canWrite(claimed, A, '/pairs/NEW1', { creator: 'alice_uid', partner: 'bob_uid', accepted: true, createdAt: 2000 }),
    true, 'E: creator accept via full-record write still allowed'
  );
});

test('F2 — the acceptance handshake flag cannot be forged by the joiner', () => {
  const claimed = { pairs: { NEW1: { creator: 'alice_uid', partner: 'bob_uid', createdAt: 2000 } } };
  assert.equal(canWrite(claimed, B, '/pairs/NEW1/accepted', true), false, 'joiner cannot self-accept');
  assert.equal(canWrite(claimed, C, '/pairs/NEW1/accepted', true), false, 'outsider cannot accept');
  assert.equal(canWrite(claimed, A, '/pairs/NEW1/accepted', true), true, 'only the creator sets the accepted flag');
});

test('F2 — a claim alone grants no read; both partnerUids are still required', () => {
  // Bob has claimed Alice's code and Alice has even set the accepted flag, but neither
  // partnerUid is written yet. Authorization must still be denied both ways.
  const midHandshake = {
    uid_alice_uid: { shared: { version: 1 }, public: { deepHrsToday: 2 } },
    uid_bob_uid: {},
    pairs: { NEW1: { creator: 'alice_uid', partner: 'bob_uid', accepted: true, createdAt: 2000 } }
  };
  assert.equal(canRead(midHandshake, B, '/uid_alice_uid/shared'), false, 'no read before Alice writes her partnerUid');
  assert.equal(canRead(midHandshake, B, '/uid_alice_uid/public'), false);
  assert.equal(canRead(midHandshake, A, '/uid_bob_uid/shared'), false, 'no read before Bob writes his partnerUid');
});

test('disconnect — clearing the owner partnerUid revokes partner read immediately', () => {
  const afterA = JSON.parse(JSON.stringify(LINKED));
  delete afterA.uid_alice_uid.partnerUid;
  assert.equal(canRead(afterA, B, '/uid_alice_uid/shared'), false, 'ex-partner loses shared read');
  assert.equal(canRead(afterA, B, '/uid_alice_uid/public'), false, 'ex-partner loses public read');
  assert.equal(canRead(afterA, A, '/uid_alice_uid/shared'), true, 'owner still reads own');
});

test('legacy public node — no longer world-readable', () => {
  assert.equal(canRead(LINKED, B, '/uid_alice_uid/public'), true, 'linked partner still sees the partner card data');
  assert.equal(canRead(LINKED, C, '/uid_alice_uid/public'), false, 'unrelated user no longer reads deep-hours');
  assert.equal(canRead(LINKED, null, '/uid_alice_uid/public'), false, 'unauth denied');
  assert.equal(canWrite(LINKED, C, '/uid_alice_uid/public', {}), false, 'write still owner-only');
});

test('nudges — only the linked partner may write, only the owner may read', () => {
  assert.equal(canWrite(LINKED, B, '/uid_alice_uid/nudges/n1', { from: 'Bob', ts: 5 }), true, 'partner nudge allowed');
  assert.equal(canWrite(LINKED, C, '/uid_alice_uid/nudges/n1', { from: 'Carol', ts: 5 }), false, 'stranger cannot inject a toast');
  assert.equal(canWrite(LINKED, null, '/uid_alice_uid/nudges/n1', {}), false, 'unauth denied');
  assert.equal(canRead(LINKED, B, '/uid_alice_uid/nudges'), false, 'partner cannot read the inbox');
  assert.equal(canRead(LINKED, A, '/uid_alice_uid/nudges'), true, 'owner reads own inbox');
});

test('rooms and root — unchanged and locked', () => {
  assert.equal(canRead({}, A, '/rooms/uid_alice_uid/timer'), true, 'owner reads own room');
  assert.equal(canRead({}, C, '/rooms/uid_alice_uid/timer'), false, 'outsider denied');
  assert.equal(canRead(LINKED, C, '/'), false, 'root not readable');
  assert.equal(canWrite(LINKED, C, '/', {}), false, 'root not writable');
});
