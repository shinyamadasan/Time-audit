// functions/test/support.js
//
// Test-only helpers: a Worker-side signer that builds requests exactly as §2 describes, a fake privileged
// infra store with the same atomic create-if-absent contract as RTDB REST `if-match: null_etag`, and a
// recording user-scoped domain reader. The test HMAC key is a fixed dummy, not a real secret.

import { randomUUID } from 'node:crypto';

import { createActionApiHandler, CANONICAL_PATH } from '../src/action-api.js';
import { createNonceStore } from '../src/nonce-store.js';
import { HEADERS, SERVICE_IDENTITY, sha256Hex, sign, signingInput } from '../src/service-auth.js';

export const KEY_ID = 'test-key-1';
export const KEY = Buffer.alloc(32, 7);
export const KEYS = new Map([[KEY_ID, KEY]]);
export const OWNER = Object.freeze({ ownerSubject: 'access-sub-owner-1', ownerFirebaseUid: 'ownerUid123' });
export const NOW_MS = 1_790_000_000_000;
export const NOW_S = Math.floor(NOW_MS / 1000);

/** A signed Worker request. Every field can be overridden; `mutate(headers)` edits raw headers AFTER signing. */
export function signedRequest(overrides = {}) {
  const requestId = overrides.requestId ?? randomUUID();
  const envelope = overrides.envelope ?? { contractVersion: 1, requestId, kind: 'get_brain_dump', parameters: {} };
  const rawBody = overrides.rawBody ?? Buffer.from(JSON.stringify(envelope), 'utf8');
  const fields = {
    keyId: KEY_ID, serviceIdentity: SERVICE_IDENTITY, method: 'POST', path: CANONICAL_PATH, timestamp: NOW_S,
    requestId, subject: OWNER.ownerSubject, scopes: ['chronasense:read'], bodySha256: sha256Hex(rawBody), ...overrides.signed,
  };
  const signature = overrides.signature ?? sign(overrides.key ?? KEY, signingInput(fields));
  let rawHeaders = [
    'Content-Type', 'application/json',
    HEADERS.service, fields.serviceIdentity, HEADERS.keyId, fields.keyId, HEADERS.requestId, fields.requestId,
    HEADERS.timestamp, String(fields.timestamp), HEADERS.subject, fields.subject, HEADERS.scopes, fields.scopes.join(','),
    HEADERS.signature, signature,
  ];
  if (overrides.mutate) rawHeaders = overrides.mutate(rawHeaders);
  return { method: overrides.method ?? fields.method, path: overrides.path ?? fields.path, rawHeaders, rawBody: overrides.sendBody ?? rawBody, requestId };
}

/** In-memory privileged store: createIfAbsent is atomic (JS is single-threaded between awaits). Records every call. */
export function fakeInfra() {
  const data = new Map();
  const calls = [];
  return {
    data, calls,
    async createIfAbsent(path, value) { calls.push(['createIfAbsent', path]); await null; if (data.has(path)) return 'exists'; data.set(path, structuredClone(value)); return 'created'; },
    async get(path) { calls.push(['get', path]); return data.has(path) ? structuredClone(data.get(path)) : null; },
    async queryAtMost(path, childKey, endAt, limit) {
      calls.push(['queryAtMost', path]);
      const rows = [...data].filter(([key, value]) => key.startsWith(`${path}/`) && value[childKey] <= endAt)
        .sort((a, b) => a[1][childKey] - b[1][childKey]).slice(0, limit);
      return Object.fromEntries(rows.map(([key, value]) => [key.slice(path.length + 1), value]));
    },
    async patch(path, value) { calls.push(['patch', path]); for (const [key, child] of Object.entries(value)) if (child === null) data.delete(`${path}/${key}`); },
  };
}

/** A user-scoped reader double that serves `rooms` ({ uid_x: { brainDump: {...} } }) and records each read. */
export function fakeDomain(rooms = {}) {
  const reads = [];
  return {
    reads,
    async readRoomCollection(identity, collection) { reads.push({ roomId: identity.roomId, collection }); return rooms[identity.roomId]?.[collection] ?? null; },
  };
}

export function harness({ rooms, owner = OWNER, nowMs = NOW_MS, domain } = {}) {
  const infra = fakeInfra();
  const reader = domain ?? fakeDomain(rooms);
  const logs = [];
  const handle = createActionApiHandler({ keys: KEYS, owner, nonces: createNonceStore({ infra }), domain: reader, now: () => nowMs, log: entry => logs.push(entry) });
  return { handle, infra, domain: reader, logs };
}

export function capture(id, overrides = {}) {
  return { schemaVersion: 1, id, text: `thought ${id}`, createdAt: 1_789_000_000_000, updatedAt: 1_789_000_000_000, updatedBy: 'device-a', status: 'untriaged', ...overrides };
}
