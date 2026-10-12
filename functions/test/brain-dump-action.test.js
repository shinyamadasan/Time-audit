import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { COMMAND_PATH } from '../src/action-api.js';
import { actionActorRef } from '../src/envelope.js';
import { captureIdForAction } from '../src/command-identity.js';
import { ApiError } from '../src/errors.js';
import { NOW_MS, OWNER, harness, signedRequest } from './support.js';

const ACTION = 'act1_550e8400-e29b-41d4-a716-446655440000';
const CAPTURE_ID = captureIdForAction(ACTION);
const PROVENANCE = { version: 1, sourceKind: 'chatgpt_plugin', actionId: ACTION,
  actorRef: actionActorRef(OWNER.ownerSubject), capturedAt: new Date(NOW_MS).toISOString() };

function request({ actionId = ACTION, text = 'Remember the insight', requestId, provenance = PROVENANCE,
  signed = {}, key, envelope = {} } = {}) {
  const id = requestId ?? randomUUID();
  return signedRequest({ path: COMMAND_PATH, requestId: id, key,
    signed: { path: COMMAND_PATH, scopes: ['chronasense:brain-dump.write'], ...signed },
    envelope: { contractVersion: 1, requestId: id, actionId, kind: 'brain_dump_add',
      parameters: { text }, expectedRevision: null, actionProvenance: provenance, ...envelope } });
}

function domain({ loseResponse = false, failBeforeWrite = false, failRead = false } = {}) {
  const records = new Map();
  const writes = [];
  return {
    records, writes,
    setFailRead(value) { failRead = value; },
    setFailBeforeWrite(value) { failBeforeWrite = value; },
    async createCaptureIfAbsent(identity, captureId, actionId, record) {
      writes.push({ roomId: identity.roomId, captureId, actionId });
      if (failBeforeWrite) throw new ApiError('RETRYABLE_TRANSPORT', 'Write unavailable.');
      if (!records.has(captureId)) records.set(captureId, structuredClone(record));
      if (loseResponse) { loseResponse = false; throw new ApiError('RETRYABLE_TRANSPORT', 'Response lost.'); }
    },
    async readCapture(_identity, captureId) {
      if (failRead) throw new ApiError('RETRYABLE_TRANSPORT', 'Read unavailable.');
      return records.get(captureId) ?? null;
    },
  };
}

test('create applies once, persists provenance marker and replays through the receipt', async () => {
  const store = domain();
  const h = harness({ domain: store });
  const first = await h.handle(request());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.result.captureId, CAPTURE_ID);
  assert.equal(first.body.result.idempotentReplay, false);
  assert.equal(store.records.get(CAPTURE_ID).creationActionId, ACTION);
  assert.equal(store.records.get(CAPTURE_ID).updatedBy, PROVENANCE.actorRef);
  assert.equal(store.writes.length, 1);
  const replay = await h.handle(request());
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.result.idempotentReplay, true);
  assert.equal(store.writes.length, 1);
});

test('changed semantic payload under one action ID conflicts without a second write', async () => {
  const store = domain();
  const h = harness({ domain: store });
  assert.equal((await h.handle(request())).status, 200);
  const response = await h.handle(request({ text: 'Different idea' }));
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(store.writes.length, 1);
});

test('concurrent attempts for the same action apply one capture', async () => {
  const store = domain();
  const h = harness({ domain: store });
  const responses = await Promise.all(Array.from({ length: 12 }, () => h.handle(request())));
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal(responses.filter(r => r.body.error?.code === 'PENDING_UNKNOWN').length, 11);
  assert.equal(store.records.size, 1);
  assert.equal(store.writes.length, 1);
});

test('lost write response reconciles by exact readback', async () => {
  const store = domain({ loseResponse: true });
  const h = harness({ domain: store });
  const result = await h.handle(request());
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(store.records.size, 1);
});

test('failed readback yields pending unknown then recovers after the lease', async () => {
  const store = domain({ failRead: true });
  const first = harness({ domain: store, nowMs: NOW_MS });
  const response = await first.handle(request());
  assert.equal(response.body.error.code, 'PENDING_UNKNOWN');
  store.setFailRead(false);
  // The pending receipt relinquishes its lease for a fresh, signed attempt.
  const recovered = await first.handle(request());
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(store.records.size, 1);
});

test('write failure before any effect stays pending, then safely retries', async () => {
  const store = domain({ failBeforeWrite: true });
  const h = harness({ domain: store });
  const first = await h.handle(request());
  assert.equal(first.body.error.code, 'PENDING_UNKNOWN');
  assert.equal(store.records.size, 0);
  store.setFailBeforeWrite(false);
  const retry = await h.handle(request());
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(store.records.size, 1);
});

test('occupied deterministic ID with missing marker is a conflict', async () => {
  const store = domain();
  store.records.set(CAPTURE_ID, { id: CAPTURE_ID, text: 'foreign', createdAt: NOW_MS,
    updatedAt: NOW_MS, updatedBy: 'other', status: 'untriaged', schemaVersion: 1 });
  const h = harness({ domain: store });
  const response = await h.handle(request());
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'CONFLICT');
  assert.equal(store.records.get(CAPTURE_ID).text, 'foreign');
});

test('malformed create and over-limit text fail before receipt or write', async () => {
  for (const req of [request({ envelope: { unexpected: true } }),
    request({ text: 'x'.repeat(1001) }), request({ provenance: { ...PROVENANCE, actorRef: 'imposter' } }),
    request({ actionId: 'bad' })]) {
    const store = domain();
    const h = harness({ domain: store });
    const response = await h.handle(req);
    assert.ok(['INVALID_INPUT', 'DOMAIN_LIMIT'].includes(response.body.error.code));
    assert.equal(store.writes.length, 0);
    assert.equal(h.infra.calls.length, 0);
  }
});

test('wrong subject, missing scope, bad HMAC and stale timestamp fail before write', async () => {
  const variants = [request({ signed: { subject: 'imposter' } }),
    request({ signed: { scopes: ['chronasense:read'] } }),
    request({ key: Buffer.alloc(32, 9) }),
    request({ signed: { timestamp: Math.floor(NOW_MS / 1000) - 301 } })];
  for (const req of variants) {
    const store = domain();
    const h = harness({ domain: store });
    const response = await h.handle(req);
    assert.ok([401, 403].includes(response.status));
    assert.equal(store.writes.length, 0);
    assert.equal(h.infra.calls.length, 0);
  }
});
