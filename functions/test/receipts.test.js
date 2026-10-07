// functions/test/receipts.test.js — the private receipt foundation (no command executes in Phase A1).

import test from 'node:test';
import assert from 'node:assert/strict';

import { canTransition, canonicalRequestHash, classifyExistingReceipt, createReceiptStore, receiptPath, RECEIPT_STATES, TERMINAL_RECEIPT_STATES } from '../src/receipts.js';
import { fakeInfra } from './support.js';

const ACTION = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const command = (overrides = {}) => ({
  contractVersion: 1, actionId: ACTION, kind: 'brain_dump_add', parameters: { text: 'buy milk' }, expectedRevision: null,
  actionProvenance: { version: 1, sourceKind: 'chatgpt_plugin', actionId: ACTION, actorRef: 'actor1:x', capturedAt: '2026-10-07T00:00:00Z' }, ...overrides,
});

test('state machine: started -> pending_unknown|terminal; pending_unknown -> terminal only; terminal is immutable', () => {
  assert.deepEqual(RECEIPT_STATES, ['started', 'pending_unknown', 'applied', 'conflict', 'rejected', 'needs_user_decision']);
  for (const to of RECEIPT_STATES.filter(s => s !== 'started')) assert.ok(canTransition('started', to), `started -> ${to}`);
  assert.ok(!canTransition('started', 'started'));
  for (const to of TERMINAL_RECEIPT_STATES) assert.ok(canTransition('pending_unknown', to));
  assert.ok(!canTransition('pending_unknown', 'started') && !canTransition('pending_unknown', 'pending_unknown'));
  for (const from of TERMINAL_RECEIPT_STATES) for (const to of RECEIPT_STATES) assert.ok(!canTransition(from, to), `${from} -> ${to}`);
  assert.ok(!canTransition('bogus', 'applied') && !canTransition('started', 'bogus'));
});

test('canonical request hash: key order immaterial; values, array order and expectedRevision material; omitted == explicit null', () => {
  const h = canonicalRequestHash(command());
  assert.match(h, /^[0-9a-f]{64}$/);
  const reordered = Object.fromEntries(Object.entries(command()).reverse());
  assert.equal(canonicalRequestHash(reordered), h);
  const { expectedRevision, ...withoutRevision } = command();
  assert.equal(expectedRevision, null);
  assert.equal(canonicalRequestHash(withoutRevision), h);
  assert.notEqual(canonicalRequestHash(command({ parameters: { text: 'buy milk!' } })), h);
  assert.notEqual(canonicalRequestHash(command({ expectedRevision: 'rev1:abc' })), h);
  assert.notEqual(canonicalRequestHash(command({ parameters: { tags: ['a', 'b'] } })), canonicalRequestHash(command({ parameters: { tags: ['b', 'a'] } })));
  // Transport-only fields never enter the hash; a missing semantic field is an error, not a silent default.
  assert.equal(canonicalRequestHash({ ...command(), requestId: 'x' }), h);
  assert.throws(() => canonicalRequestHash({ ...command(), actionProvenance: undefined }), /actionProvenance/);
});

test('receipt address: serverActionReceipts/<uid>/<actionId> with strict grammar', () => {
  assert.equal(receiptPath('ownerUid123', ACTION), `serverActionReceipts/ownerUid123/${ACTION}`);
  for (const [uid, id] of [['ownerUid123', 'act1_x'], ['../x', ACTION], ['ownerUid123', ACTION.toUpperCase()], ['', ACTION]]) assert.throws(() => receiptPath(uid, id));
});

test('atomic claim: absent grants exactly one executor; concurrent claims -> one winner, the rest see the existing receipt', async () => {
  const infra = fakeInfra();
  const store = createReceiptStore({ infra });
  const requestHash = canonicalRequestHash(command());
  const attempts = await Promise.all(Array.from({ length: 10 }, (_, i) => store.claim({ firebaseUid: 'ownerUid123', actionId: ACTION, requestHash, kind: 'brain_dump_add', attemptId: `a${i}`, nowMs: 1000, leaseMs: 30_000 })));
  assert.equal(attempts.filter(a => a.claimed).length, 1);
  const winner = attempts.find(a => a.claimed).receipt;
  assert.deepEqual(Object.keys(winner).sort(), ['actionId', 'attemptId', 'contractVersion', 'createdAt', 'kind', 'leaseAcquiredAt', 'leaseExpiresAt', 'requestHash', 'state', 'updatedAt']);
  assert.equal(winner.state, 'started');
  for (const loser of attempts.filter(a => !a.claimed)) assert.deepEqual(loser.existing, winner);
});

test('existing receipt classification never authorizes blind re-execution', () => {
  const base = { requestHash: 'h', state: 'started', leaseExpiresAt: 2000 };
  assert.equal(classifyExistingReceipt(base, { requestHash: 'other', nowMs: 0 }), 'conflict');
  assert.equal(classifyExistingReceipt(base, { requestHash: 'h', nowMs: 1999 }), 'lease_active');
  assert.equal(classifyExistingReceipt(base, { requestHash: 'h', nowMs: 2000 }), 'recover');
  assert.equal(classifyExistingReceipt({ ...base, state: 'pending_unknown' }, { requestHash: 'h', nowMs: 0 }), 'recover');
  for (const state of TERMINAL_RECEIPT_STATES) assert.equal(classifyExistingReceipt({ ...base, state }, { requestHash: 'h', nowMs: 0 }), 'replay');
  assert.equal(classifyExistingReceipt({ ...base, state: 'applied' }, { requestHash: 'other', nowMs: 0 }), 'conflict');
});

test('non-string addresses never coerce into a valid path ("undefined" is not a UID)', () => {
  assert.throws(() => receiptPath(undefined, ACTION));
  assert.throws(() => receiptPath(null, ACTION));
  assert.throws(() => receiptPath('ownerUid123', undefined));
});
