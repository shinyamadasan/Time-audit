// functions/test/service-auth.test.js — §2 HMAC service authentication, attacked field by field.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CANONICAL_PATH } from '../src/action-api.js';
import { ApiError } from '../src/errors.js';
import { FRESHNESS_SECONDS, HEADERS, MAX_BODY_BYTES, SERVICE_IDENTITY, sign, signingInput, verifyServiceRequest } from '../src/service-auth.js';
import { KEYS, KEY_ID, NOW_S, OWNER, signedRequest } from './support.js';

const verify = (request, nowSeconds = NOW_S) => verifyServiceRequest(request, { keys: KEYS, nowSeconds, canonicalPath: CANONICAL_PATH });

function rejects(request, reason, { code = 'AUTH_REQUIRED', now } = {}) {
  assert.throws(() => verify(request, now), error => {
    assert.ok(error instanceof ApiError, `ApiError expected, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.reason, reason);
    if (code === 'AUTH_REQUIRED') assert.equal(error.message, 'Service authentication failed.', 'one generic message for every auth failure');
    return true;
  });
}

const setHeader = (name, value) => headers => headers.map((entry, i) => (i % 2 === 1 && headers[i - 1].toLowerCase() === name ? value : entry));

test('the signing input is exactly the newline-joined §2 tuple (golden vector)', () => {
  const input = signingInput({
    keyId: 'k1', serviceIdentity: SERVICE_IDENTITY, method: 'POST', path: '/v1/query', timestamp: 1790000000,
    requestId: '0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4', subject: 'sub-1', scopes: ['chronasense:plan.write', 'chronasense:read'],
    bodySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  assert.equal(input, [
    'chronasense-worker-auth-v1', 'k1', 'chronasense-plugin-worker-v1', 'POST', '/v1/query', '1790000000',
    '0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4', 'sub-1', 'chronasense:plan.write,chronasense:read',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'));
  assert.equal(sign(Buffer.alloc(32, 1), input), sign(Buffer.alloc(32, 1), input));
  assert.match(sign(Buffer.alloc(32, 1), input), /^[0-9a-f]{64}$/);
});

test('a valid trusted request verifies and yields only signed values', () => {
  const request = signedRequest();
  const assertion = verify(request);
  assert.equal(assertion.requestId, request.requestId);
  assert.equal(assertion.subject, OWNER.ownerSubject);
  assert.deepEqual([...assertion.scopes], ['chronasense:read']);
  assert.equal(assertion.keyId, KEY_ID);
  assert.ok(Object.isFrozen(assertion));
});

test('bad HMAC: wrong key, flipped signature, and a signature over different values are all rejected', () => {
  rejects(signedRequest({ key: Buffer.alloc(32, 8) }), 'bad-signature');
  const good = signedRequest();
  const sig = good.rawHeaders[good.rawHeaders.indexOf(HEADERS.signature) + 1];
  rejects({ ...good, rawHeaders: setHeader(HEADERS.signature, `${sig.slice(0, -1)}${sig.at(-1) === '0' ? '1' : '0'}`)(good.rawHeaders) }, 'bad-signature');
  rejects(signedRequest({ signature: 'A'.repeat(64) }), 'malformed-signature');
  rejects(signedRequest({ signature: 'ab' }), 'malformed-signature');
});

test('raw body tamper: any byte change (even JSON-equivalent whitespace) breaks the body hash', () => {
  const request = signedRequest();
  const spaced = Buffer.from(request.rawBody.toString('utf8').replace('{', '{ '), 'utf8');
  rejects({ ...request, rawBody: spaced }, 'bad-signature');
  const other = Buffer.from(request.rawBody.toString('utf8').replace('get_brain_dump', 'get_brain_dumq'), 'utf8');
  rejects({ ...request, rawBody: other }, 'bad-signature');
});

test('every signed header value is bound: subject, scopes, request id, timestamp, method and path cannot be swapped', () => {
  const base = signedRequest();
  rejects({ ...base, rawHeaders: setHeader(HEADERS.subject, 'someone-else')(base.rawHeaders) }, 'bad-signature');
  rejects({ ...base, rawHeaders: setHeader(HEADERS.scopes, 'chronasense:brain-dump.write,chronasense:read')(base.rawHeaders) }, 'bad-signature');
  rejects({ ...base, rawHeaders: setHeader(HEADERS.requestId, '11111111-2222-4333-8444-555555555555')(base.rawHeaders) }, 'bad-signature');
  rejects({ ...base, rawHeaders: setHeader(HEADERS.timestamp, String(NOW_S - 1))(base.rawHeaders) }, 'bad-signature');
  // A different method or path is refused before the HMAC even runs.
  assert.throws(() => verify({ ...base, method: 'PUT' }), error => error.code === 'INVALID_INPUT' && error.status === 405);
});

test(`freshness: exactly ±${FRESHNESS_SECONDS}s is accepted, one second beyond is stale, in both directions`, () => {
  for (const skew of [-FRESHNESS_SECONDS, 0, FRESHNESS_SECONDS]) assert.ok(verify(signedRequest({ signed: { timestamp: NOW_S + skew } })));
  rejects(signedRequest({ signed: { timestamp: NOW_S - FRESHNESS_SECONDS - 1 } }), 'stale-timestamp');
  rejects(signedRequest({ signed: { timestamp: NOW_S + FRESHNESS_SECONDS + 1 } }), 'stale-timestamp');
  rejects(signedRequest(), 'no-clock', { now: Number.NaN });
});

test('timestamp grammar: no sign, fraction, leading zero, exponent or milliseconds', () => {
  for (const bad of ['+1790000000', '1790000000.0', '01790000000', '1.79e9', ' 1790000000', '1790000000000x', '']) {
    const request = signedRequest();
    rejects({ ...request, rawHeaders: setHeader(HEADERS.timestamp, bad)(request.rawHeaders) }, 'malformed-timestamp');
  }
});

test('canonical path: only the exact route; query strings, trailing slashes, encodings and dot segments are refused', () => {
  for (const path of ['/v1/query/', '/v1/query?x=1', '/v1//query', '/v1/%71uery', '/v1/./query', '/V1/query', '/v1/query#a', '/v2/query']) {
    rejects(signedRequest({ path, signed: { path } }), 'noncanonical-path');
  }
});

test('headers: duplicates (any case), unknown chronasense headers, a missing header, and two content-types are refused', () => {
  rejects(signedRequest({ mutate: h => [...h, 'X-ChronaSense-Subject', OWNER.ownerSubject] }), 'duplicate-header');
  rejects(signedRequest({ mutate: h => [...h, HEADERS.signature, h[h.indexOf(HEADERS.signature) + 1]] }), 'duplicate-header');
  rejects(signedRequest({ mutate: h => [...h, 'x-chronasense-uid', 'victimUid'] }), 'unknown-chronasense-header');
  rejects(signedRequest({ mutate: h => [...h, 'x-chronasense-room', 'uid_victim'] }), 'unknown-chronasense-header');
  rejects(signedRequest({ mutate: h => { const i = h.indexOf(HEADERS.subject); return [...h.slice(0, i), ...h.slice(i + 2)]; } }), 'missing-header');
  rejects(signedRequest({ mutate: h => [...h, 'content-type', 'application/json'] }), 'duplicate-content-type');
  rejects(signedRequest({ mutate: h => ['x', ...h] }), 'malformed-headers');
  assert.throws(() => verify(signedRequest({ mutate: setHeader('content-type', 'text/plain') })), error => error.code === 'INVALID_INPUT' && error.status === 415);
});

test('unknown service identity and unknown key id are refused', () => {
  rejects(signedRequest({ signed: { serviceIdentity: 'chronasense-plugin-worker-v2' } }), 'unknown-service');
  rejects(signedRequest({ signed: { keyId: 'retired-key' } }), 'unknown-key-id');
  rejects(signedRequest({ signed: { keyId: 'bad key' } }), 'unknown-key-id');
});

test('scopes must be the normalized form: known, lexically sorted, unique', () => {
  rejects(signedRequest({ signed: { scopes: ['chronasense:read', 'chronasense:plan.write'] } }), 'scopes-not-normalized');
  rejects(signedRequest({ signed: { scopes: ['chronasense:read', 'chronasense:read'] } }), 'scopes-not-normalized');
  rejects(signedRequest({ signed: { scopes: ['chronasense:admin'] } }), 'unknown-scope');
  rejects(signedRequest({ signed: { scopes: ['chronasense:read '] } }), 'unknown-scope');
  assert.deepEqual([...verify(signedRequest({ signed: { scopes: [] } })).scopes], [], 'an empty grant verifies (the scope check refuses it later)');
});

test('request id must be a lowercase canonical UUIDv4; subject may not carry a separator', () => {
  for (const id of ['0B8F1C2E-3D4A-4B5C-8D6E-7F8091A2B3C4', '0b8f1c2e-3d4a-1b5c-8d6e-7f8091a2b3c4', 'not-a-uuid']) rejects(signedRequest({ requestId: id }), 'malformed-request-id');
  for (const subject of ['a,b', 'a b', '', 'x'.repeat(257)]) rejects(signedRequest({ signed: { subject } }), 'malformed-subject');
});

test('body: a missing body is refused and anything over 64 KiB is refused before hashing', () => {
  assert.throws(() => verify({ ...signedRequest(), rawBody: undefined }), error => error.code === 'INVALID_INPUT' && error.reason === 'no-body');
  const big = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20);
  assert.throws(() => verify(signedRequest({ rawBody: big })), error => error.code === 'INVALID_INPUT' && error.status === 413);
  assert.ok(verify(signedRequest({ rawBody: Buffer.alloc(MAX_BODY_BYTES, 0x20) })), 'exactly 64 KiB passes authentication');
});
