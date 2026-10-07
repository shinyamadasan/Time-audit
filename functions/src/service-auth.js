// functions/src/service-auth.js
//
// Worker → backend HMAC-SHA-256 service authentication (docs/CHRONASENSE_ACTION_API_V1.md §2).
//
// The signature authenticates "the trusted Worker asserts these values". Every value in the signing tuple is
// validated against a grammar that excludes newline and every other separator BEFORE it is joined, so two
// different tuples can never produce the same signing input. Any failure throws AUTH_REQUIRED with one
// generic message; the specific `reason` is internal only. Nothing here reads the domain, and nothing here
// trusts a caller-supplied identity: subject and scopes are only returned once the HMAC proves the Worker
// asserted them.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { ApiError } from './errors.js';

export const SIGNING_VERSION = 'chronasense-worker-auth-v1';
export const SERVICE_IDENTITY = 'chronasense-plugin-worker-v1';
export const FRESHNESS_SECONDS = 300;
export const MAX_BODY_BYTES = 64 * 1024;
export const KNOWN_SCOPES = Object.freeze(['chronasense:brain-dump.write', 'chronasense:plan.write', 'chronasense:read']);

export const HEADERS = Object.freeze({
  service: 'x-chronasense-service',
  keyId: 'x-chronasense-key-id',
  requestId: 'x-chronasense-request-id',
  timestamp: 'x-chronasense-timestamp',
  subject: 'x-chronasense-subject',
  scopes: 'x-chronasense-scopes',
  signature: 'x-chronasense-signature',
});
const SIGNED_HEADER_NAMES = new Set(Object.values(HEADERS));

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TIMESTAMP = /^(0|[1-9][0-9]{0,11})$/;
// Printable ASCII without space or comma: no separator of the signing tuple can appear inside a subject.
const SUBJECT = /^[\x21-\x2b\x2d-\x7e]{1,256}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

const reject = reason => new ApiError('AUTH_REQUIRED', 'Service authentication failed.', { reason });

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The exact canonical UTF-8 signing input of §2. */
export function signingInput({ keyId, serviceIdentity, method, path, timestamp, requestId, subject, scopes, bodySha256 }) {
  return [SIGNING_VERSION, keyId, serviceIdentity, method, path, String(timestamp), requestId, subject, scopes.join(','), bodySha256].join('\n');
}

export function sign(secret, input) {
  return createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

/** Reads each signed header exactly once from Node's rawHeaders ([name, value, name, value, ...]). A repeated
 *  header (which Node would silently comma-join) and any unknown x-chronasense-* header are rejected. */
function readSignedHeaders(rawHeaders) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) throw reject('malformed-headers');
  const seen = new Map();
  let contentType = null;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = String(rawHeaders[i]).toLowerCase();
    const value = String(rawHeaders[i + 1]);
    if (name === 'content-type') {
      if (contentType !== null) throw reject('duplicate-content-type');
      contentType = value;
      continue;
    }
    if (!name.startsWith('x-chronasense-')) continue;
    if (!SIGNED_HEADER_NAMES.has(name)) throw reject('unknown-chronasense-header');
    if (seen.has(name)) throw reject('duplicate-header');
    seen.set(name, value);
  }
  for (const name of SIGNED_HEADER_NAMES) if (!seen.has(name)) throw reject('missing-header');
  return { headers: seen, contentType };
}

function parseScopes(value) {
  if (value === '') return [];
  const scopes = value.split(',');
  for (let i = 0; i < scopes.length; i++) {
    if (!KNOWN_SCOPES.includes(scopes[i])) throw reject('unknown-scope');
    // Normalized = lexically sorted and unique; anything else is a second spelling of the same grant.
    if (i > 0 && !(scopes[i - 1] < scopes[i])) throw reject('scopes-not-normalized');
  }
  return scopes;
}

/**
 * Verifies one Worker request. Returns the authenticated assertion, or throws ApiError(AUTH_REQUIRED|INVALID_INPUT).
 * @param {{method:string, path:string, rawHeaders:string[], rawBody:Uint8Array}} request
 * @param {{keys: Map<string, Uint8Array>, nowSeconds: number, canonicalPath: string}} options
 * @returns {{requestId:string, timestamp:number, subject:string, scopes:string[], keyId:string, serviceIdentity:string}}
 */
export function verifyServiceRequest(request, { keys, nowSeconds, canonicalPath }) {
  if (request.method !== 'POST') throw new ApiError('INVALID_INPUT', 'Only POST is supported.', { reason: 'method', status: 405 });
  // The path is compared byte for byte with the one canonical route: no query string, trailing slash,
  // percent-encoding, dot segment or doubled slash can name the same route a second way.
  if (request.path !== canonicalPath) throw reject('noncanonical-path');
  const { headers, contentType } = readSignedHeaders(request.rawHeaders);
  if (contentType === null || !/^application\/json(; ?charset=utf-8)?$/i.test(contentType)) {
    throw new ApiError('INVALID_INPUT', 'Body must be application/json; charset=utf-8.', { reason: 'content-type', status: 415 });
  }

  const serviceIdentity = headers.get(HEADERS.service);
  if (serviceIdentity !== SERVICE_IDENTITY) throw reject('unknown-service');
  const keyId = headers.get(HEADERS.keyId);
  if (!KEY_ID.test(keyId) || !keys.has(keyId)) throw reject('unknown-key-id');

  const timestampText = headers.get(HEADERS.timestamp);
  if (!TIMESTAMP.test(timestampText)) throw reject('malformed-timestamp');
  const timestamp = Number(timestampText);
  if (!Number.isFinite(nowSeconds)) throw reject('no-clock');
  if (Math.abs(nowSeconds - timestamp) > FRESHNESS_SECONDS) throw reject('stale-timestamp');

  const requestId = headers.get(HEADERS.requestId);
  if (!UUID_V4.test(requestId)) throw reject('malformed-request-id');
  const subject = headers.get(HEADERS.subject);
  if (!SUBJECT.test(subject)) throw reject('malformed-subject');
  const scopes = parseScopes(headers.get(HEADERS.scopes));

  const signature = headers.get(HEADERS.signature);
  if (!HEX_SHA256.test(signature)) throw reject('malformed-signature');

  const body = request.rawBody;
  if (!(body instanceof Uint8Array)) throw new ApiError('INVALID_INPUT', 'A request body is required.', { reason: 'no-body' });
  if (body.length > MAX_BODY_BYTES) throw new ApiError('INVALID_INPUT', 'Request body exceeds 64 KiB.', { reason: 'body-too-large', status: 413 });

  const expected = sign(keys.get(keyId), signingInput({
    keyId, serviceIdentity, method: request.method, path: request.path, timestamp, requestId, subject, scopes, bodySha256: sha256Hex(body),
  }));
  // Constant-time over equal-length decoded digests (both are exactly 32 bytes here).
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) throw reject('bad-signature');

  return Object.freeze({ requestId, timestamp, subject, scopes: Object.freeze(scopes), keyId, serviceIdentity });
}
