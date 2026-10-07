// functions/test/authority-boundary.test.js
//
// §3 STOP — AUTHORITY BOUNDARY VIOLATED, guarded two ways:
//   static : which module may hold which credential, proven from the source itself;
//   runtime: the privileged client refuses every non-infrastructure path before any token or network use, and a
//            failed user-scoped read can never be "rescued" by privileged access.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiError, AuthorityBoundaryViolation } from '../src/errors.js';
import { assertInfraPath, createInfraRtdb } from '../src/infra-rtdb.js';
import { OWNER, harness, signedRequest } from './support.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const source = file => readFileSync(path.join(SRC, file), 'utf8');
const imports = text => [...text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1]);
const SRC_FILES = readdirSync(SRC).filter(name => name.endsWith('.js'));

test('static: only index.js imports Firebase; no src module can reach the Admin SDK', () => {
  for (const file of SRC_FILES) {
    for (const specifier of imports(source(file))) assert.ok(!/^firebase/.test(specifier), `${file} imports ${specifier}`);
  }
  const entry = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.deepEqual(imports(entry).filter(s => s.startsWith('firebase')).sort(), ['firebase-admin/app', 'firebase-admin/auth', 'firebase-functions/params', 'firebase-functions/v2/https']);
  assert.ok(!/firebase-admin\/database/.test(entry), 'the Admin Database SDK is never loaded');
});

test('static: only infra-rtdb.js sends a privileged Authorization header; domain modules never import it', () => {
  for (const file of SRC_FILES.filter(name => name !== 'infra-rtdb.js')) {
    assert.ok(!/Authorization|Bearer/.test(source(file)), `${file} must not carry a privileged credential`);
  }
  for (const file of ['user-scoped-rtdb.js', 'brain-dump-query.js', 'action-api.js', 'envelope.js', 'identity.js']) {
    assert.ok(!imports(source(file)).some(s => /infra-rtdb|nonce-store|receipts/.test(s)), `${file} must not import privileged infrastructure`);
  }
  // The domain query's only data dependency is the shared, pure domain model.
  assert.deepEqual(imports(source('brain-dump-query.js')).filter(s => !s.startsWith('./') && !s.startsWith('node:')), ['../../brain-dump-model.js']);
});

test('static: index.js wires the domain reader with the ID-token provider only, never the Admin credential', () => {
  const entry = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const domainWiring = /domain:\s*createUserScopedRtdb\(\{([^}]*)\}\)/.exec(entry);
  assert.ok(domainWiring, 'domain reader wiring found');
  assert.equal(domainWiring[1].trim(), 'databaseUrl, idTokens');
  assert.match(entry, /createIdTokenProvider\(\{ authAdmin: getAuth\(\)/);
});

test('static: a read never creates a receipt (the request pipeline does not import the receipt store)', () => {
  assert.ok(!imports(source('action-api.js')).some(s => s.includes('receipts')));
});

test('runtime: the privileged client refuses every domain / non-infrastructure path before touching a token or the network', async () => {
  let tokenRequests = 0;
  let fetches = 0;
  const infra = createInfraRtdb({ databaseUrl: 'https://x.firebaseio.com', fetch: async () => { fetches++; return new Response('null'); }, getAccessToken: async () => { tokenRequests++; return 'admin'; } });
  const forbidden = [
    'rooms/uid_ownerUid123/brainDump', 'rooms/uid_victim', 'uid_ownerUid123/public', 'pairs/x', '', 'serverRequestNonces',
    'serverRequestNonces/../rooms', 'serverRequestNonces/a/b/c', 'serverActionReceiptsX/a', 'serverActionReceipts/a b', 'serverActionReceipts/a/b.json',
    'serverRequestNonces/a?x=1', '/serverRequestNonces/a',
  ];
  for (const bad of forbidden) {
    assert.throws(() => assertInfraPath(bad), AuthorityBoundaryViolation, bad);
    await assert.rejects(infra.get(bad), AuthorityBoundaryViolation, bad);
    await assert.rejects(infra.createIfAbsent(bad, {}), AuthorityBoundaryViolation, bad);
  }
  assert.equal(tokenRequests, 0);
  assert.equal(fetches, 0);
  assert.throws(() => assertInfraPath(undefined), AuthorityBoundaryViolation);
  assert.equal(assertInfraPath('serverActionReceipts/ownerUid123/act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4'), 'serverActionReceipts/ownerUid123/act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4');
});

test('runtime: when the user-scoped read is refused, the API fails closed; nothing privileged reads the domain instead', async () => {
  const domain = { reads: [], async readRoomCollection(identity, collection) { this.reads.push(collection); throw new ApiError('FORBIDDEN', 'refused', { reason: 'token-exchange-401' }); } };
  const h = harness({ domain });
  const response = await h.handle(signedRequest());
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
  assert.ok(!('result' in response.body));
  await new Promise(resolve => setImmediate(resolve));
  for (const [, at] of h.infra.calls) assert.match(at, /^serverRequestNonces\//, 'privileged access stayed on its own nonce');
});

test('runtime: an authority-boundary violation anywhere is a closed failure with no detail leaked', async () => {
  const domain = { async readRoomCollection() { throw new AuthorityBoundaryViolation('x'); } };
  const response = await harness({ domain }).handle(signedRequest());
  assert.equal(response.status, 500);
  assert.equal(response.reason, 'authority-boundary');
  assert.ok(!JSON.stringify(response.body).includes('AUTHORITY'));
  assert.ok(!JSON.stringify(response.body).includes(OWNER.ownerFirebaseUid));
});
