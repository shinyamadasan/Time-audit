// brain-dump-wire-format.test.js
//
// Brain Dump Production UX Correction V1, FIX FIRST #2: the REAL Firebase wire format.
//
// Firebase RTDB never stores a null. A record written with `disposedAt: null` is read
// back WITHOUT that key, at every nesting level. Every earlier Brain Dump fake room
// JSON-cloned records and so kept the nulls, which let a model that required literal
// nulls pass the whole suite while rejecting every record production ever read back.
//
// fixtures/brain-dump-rtdb-wire-capture.json was recorded with the real Firebase JS SDK
// 10.12.2 (compat, as index.html loads it) against the real RTDB emulator 4.11.2: each
// logical record written by transaction (as brain-dump-sync.js pushes) and read back
// through the subtree value listener (as it attaches). The first tests pin
// `pruneLikeFirebase` to that recording, so every pruning fake built on it is proven
// against the real SDK rather than assumed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCapture } from './brain-dump-model.js';
import { pruneLikeFirebase } from './brain-dump-test-support.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'brain-dump-rtdb-wire-capture.json'), 'utf8'));

test('the recording covers every capture state the app writes', () => {
  assert.deepEqual(CAPTURE.cases.map(c => c.name).sort(), [
    'archived', 'claimedDoToday', 'claimedSchedule', 'delegatedNoPerson', 'delegatedWithPerson',
    'promotedDoToday', 'promotedSchedule', 'recoveredExpiredClaim', 'reopenedV2', 'triaged', 'untriaged',
  ]);
  assert.match(CAPTURE.sdk, /10\.12\.2/);
});

test('pruneLikeFirebase reproduces the REAL SDK wire shape exactly, for every state (listener and transaction snapshot)', () => {
  for (const c of CAPTURE.cases) {
    assert.deepEqual(pruneLikeFirebase(c.logical), c.listenerValue, `${c.name}: listener value`);
    assert.deepEqual(pruneLikeFirebase(c.logical), c.transactionSnapshot, `${c.name}: transaction snapshot`);
  }
});

test('the real wire really does drop null keys (top-level and nested): the gap every JSON-clone fake missed', () => {
  const untriaged = CAPTURE.cases.find(c => c.name === 'untriaged');
  for (const key of ['important', 'urgent', 'triagedAt', 'disposedAt', 'promotionClaim', 'promotion', 'delegatedTo']) {
    assert.equal(untriaged.logical[key], null, `${key} is null locally`);
    assert.equal(key in untriaged.listenerValue, false, `${key} is absent on the wire`);
  }
  const doToday = CAPTURE.cases.find(c => c.name === 'claimedDoToday');
  assert.equal(doToday.logical.promotionClaim.durationMinutes, null);
  assert.equal('durationMinutes' in doToday.listenerValue.promotionClaim, false, 'a nested null is pruned too');
});

test('real SDK ordering: the subtree listener fires BEFORE the transaction Promise resolves, every time', () => {
  for (const c of CAPTURE.cases) assert.deepEqual(c.eventOrder, ['listener', 'transaction-resolved'], c.name);
});

test('every state round-trips: normalize(real wire record) succeeds and equals normalize(logical record)', () => {
  for (const c of CAPTURE.cases) {
    const fromWire = normalizeCapture(c.listenerValue);
    assert.ok(fromWire, `${c.name}: the real wire record must normalize`);
    assert.deepEqual(fromWire, normalizeCapture(c.logical), `${c.name}: same semantics either way`);
    assert.deepEqual(normalizeCapture(c.transactionSnapshot), fromWire, `${c.name}: transaction snapshot too`);
  }
});

test('meaningful semantics survive the wire, state by state', () => {
  const read = name => normalizeCapture(CAPTURE.cases.find(c => c.name === name).listenerValue);
  assert.equal(read('untriaged').status, 'untriaged');
  assert.equal(read('untriaged').important, null);
  assert.equal(read('triaged').important, true);
  assert.equal(read('triaged').urgent, false);
  assert.equal(read('triaged').disposedAt, null);
  assert.equal(read('delegatedWithPerson').delegatedTo, 'Alex');
  assert.equal(read('delegatedNoPerson').delegatedTo, null);
  assert.equal(read('archived').status, 'archived');
  assert.equal(read('claimedSchedule').promotionClaim.when, '14:30');
  assert.equal(read('claimedSchedule').promotionClaim.durationMinutes, 30);
  assert.equal(read('claimedDoToday').promotionClaim.durationMinutes, null);
  assert.equal(read('promotedSchedule').promotion.intentRecorded, true);
  assert.equal(read('promotedSchedule').promotion.when, '14:30');
  assert.equal(read('promotedDoToday').promotion.durationMinutes, null, 'an explicitly untimed duration, pruned, is still known-none');
  const reopened = read('reopenedV2');
  assert.equal(reopened.status, 'triaged');
  assert.equal(reopened.schemaVersion, 2);
  assert.equal(reopened.reopenCount, 1);
  assert.equal(reopened.important, true);
  assert.equal(reopened.delegatedTo, null);
  assert.equal(reopened.disposedAt, null);
  // FIX FIRST #3: a new claim is marked, and an expired-claim recovery keeps its provenance.
  assert.equal(read('claimedSchedule').promotionClaim.planWriteStarted, true);
  const recovered = read('recoveredExpiredClaim');
  assert.equal(recovered.status, 'triaged');
  assert.equal(recovered.promotionClaim, null);
  assert.equal(recovered.claimEpoch, 1);
  assert.equal(recovered.schemaVersion, 2);
  assert.equal(recovered.expiredClaim.targetId, 'cal1:2026-10-01');
  assert.equal(recovered.expiredClaim.when, '14:30');
  assert.equal(recovered.expiredClaim.durationMinutes, 30);
  assert.equal('planWriteStarted' in recovered.expiredClaim, false, 'provenance, not live claim state');
});

test('required fields are still required on the wire: absence never stands in for them', () => {
  const wire = CAPTURE.cases.find(c => c.name === 'archived').listenerValue;
  for (const key of ['schemaVersion', 'id', 'text', 'status', 'createdAt', 'updatedAt', 'updatedBy', 'disposedAt']) {
    const missing = { ...wire };
    delete missing[key];
    assert.equal(normalizeCapture(missing), null, `missing ${key} is malformed`);
  }
  const promoted = CAPTURE.cases.find(c => c.name === 'promotedSchedule').listenerValue;
  const noPromotion = { ...promoted };
  delete noPromotion.promotion;
  assert.equal(normalizeCapture(noPromotion), null, 'a promoted record without its promotion is malformed');
  for (const key of ['type', 'store', 'targetId', 'planItemId', 'promotedAt']) {
    const broken = { ...promoted, promotion: { ...promoted.promotion } };
    delete broken.promotion[key];
    assert.equal(normalizeCapture(broken), null, `promotion.${key} is required`);
  }
  const claimed = CAPTURE.cases.find(c => c.name === 'claimedSchedule').listenerValue;
  for (const key of ['type', 'store', 'targetId', 'planItemId', 'claimedAt', 'claimedBy']) {
    const broken = { ...claimed, promotionClaim: { ...claimed.promotionClaim } };
    delete broken.promotionClaim[key];
    assert.equal(normalizeCapture(broken), null, `promotionClaim.${key} is required`);
  }
  // Half-answered triage is still malformed when the other half is merely absent.
  const triaged = CAPTURE.cases.find(c => c.name === 'triaged').listenerValue;
  const halfTriage = { ...triaged };
  delete halfTriage.urgent;
  assert.equal(normalizeCapture(halfTriage), null);
});

test('a missing capture NODE is absence, never an empty record', () => {
  assert.equal(CAPTURE.absentNodeValue, null, 'the real SDK reports a missing node as null');
  assert.equal(normalizeCapture(CAPTURE.absentNodeValue), null);
  assert.equal(normalizeCapture(pruneLikeFirebase({})), null);
});
