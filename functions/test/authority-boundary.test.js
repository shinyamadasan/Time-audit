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
import { APPROVED_SPECIFIERS, authorityViolations, specifiersOf } from './authority-scan.js';
import { OWNER, harness, signedRequest } from './support.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const source = file => readFileSync(path.join(SRC, file), 'utf8');
const SRC_FILES = readdirSync(SRC).filter(name => name.endsWith('.js'));
/** Every runtime module the deployment package ships (tests excluded). */
const PACKAGE_FILES = [
  'index.js',
  ...SRC_FILES.map(name => `src/${name}`),
  ...readdirSync(path.join(ROOT, 'shared')).filter(name => name.endsWith('.js')).map(name => `shared/${name}`),
].map(name => ({ name, text: readFileSync(path.join(ROOT, name), 'utf8') }));

test('static: the real package holds the boundary; only index.js loads Firebase, and only app/auth/functions', () => {
  assert.deepEqual(authorityViolations(PACKAGE_FILES), []);
  const entry = PACKAGE_FILES.find(file => file.name === 'index.js').text;
  assert.deepEqual(specifiersOf(entry).filter(s => s.startsWith('firebase')).sort(), [...APPROVED_SPECIFIERS]);
  assert.ok(PACKAGE_FILES.length >= SRC_FILES.length + 3, 'index.js, every src module and the packaged shared modules were scanned');
});

test('scan: the approved privileged infrastructure wiring stays allowed', () => {
  const approved = `import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
/** @param {ReturnType<import('./infra-rtdb.js').createInfraRtdb>} x */
`;
  assert.deepEqual(authorityViolations([{ name: 'index.js', text: approved }]), []);
  assert.deepEqual(authorityViolations([{ name: 'src/nonce-store.js', text: "/** @param {ReturnType<import('./infra-rtdb.js').createInfraRtdb>} x */\nimport { ApiError } from './errors.js';\n" }]), []);
});

test('scan: static Admin/domain misuse is rejected (Database/Firestore SDK, bare Admin namespace, client SDK, outside index.js)', () => {
  const cases = [
    ['index.js', "import { getDatabase } from 'firebase-admin/database';"],
    ['index.js', "import admin from 'firebase-admin';"],
    ['index.js', "import { getFirestore } from 'firebase-admin/firestore';"],
    ['index.js', "import { getDatabase } from 'firebase/database';"],
    ['index.js', "export { getDatabase } from '@firebase/database';"],
    ['src/brain-dump-query.js', "import { getAuth } from 'firebase-admin/auth';"],
    ['src/user-scoped-rtdb.js', "import { initializeApp } from 'firebase-admin/app';"],
    ['shared/brain-dump-model.js', "import 'firebase-admin/database';"],
    ['src/x.js', "import { Database } from '@google-cloud/firestore';"],
  ];
  for (const [name, text] of cases) assert.equal(authorityViolations([{ name, text }]).length, 1, `${name}: ${text}`);
});

test('scan: dynamic import() misuse is rejected, literal or computed', () => {
  const cases = [
    ['src/brain-dump-query.js', "const { getDatabase } = await import('firebase-admin/database');"],
    ['index.js', "const admin = await import( \"firebase-admin\" );"],
    ['src/x.js', "const m = await import(name);"],
    ['src/x.js', "const m = await import('firebase-' + 'admin/database');"],
    ['src/x.js', "const m = await import(`firebase-admin/database`);"],
  ];
  for (const [name, text] of cases) assert.ok(authorityViolations([{ name, text }]).length >= 1, `${name}: ${text}`);
});

test('scan: require() and createRequire misuse is rejected', () => {
  const cases = [
    ['src/x.js', "const admin = require('firebase-admin');"],
    ['index.js', "const { getDatabase } = require ('firebase-admin/database');"],
    ['src/x.js', "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nload('firebase-admin');"],
    ['shared/brain-dump-model.js', "const x = require('./plan-item-origin.js');"],
  ];
  for (const [name, text] of cases) assert.ok(authorityViolations([{ name, text }]).length >= 1, `${name}: ${text}`);
});

test('static: only infra-rtdb.js sends a privileged Authorization header; domain modules never import it', () => {
  for (const file of PACKAGE_FILES.filter(file => file.name !== 'src/infra-rtdb.js' && file.name !== 'index.js')) {
    assert.ok(!/\bAuthorization\s*:|Bearer\s/.test(file.text), `${file.name} must not send a privileged Authorization header`);
  }
  // Runtime coupling only: JSDoc type references (`@param {ReturnType<import('./nonce-store.js')...>}`) are not loads.
  const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const file of ['user-scoped-rtdb.js', 'brain-dump-query.js', 'action-api.js', 'envelope.js', 'identity.js']) {
    assert.ok(!specifiersOf(code(source(file))).some(s => /infra-rtdb|nonce-store|receipts/.test(s)), `${file} must not import privileged infrastructure`);
  }
  // The domain query's only data dependency is the packaged copy of the shared, pure domain model.
  assert.deepEqual(specifiersOf(source('brain-dump-query.js')).filter(s => !s.startsWith('./') && !s.startsWith('node:')), ['../shared/brain-dump-model.js']);
});

test('static: index.js wires the domain reader with the ID-token provider only, never the Admin credential', () => {
  const entry = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const domainWiring = /domain:\s*createUserScopedRtdb\(\{([^}]*)\}\)/.exec(entry);
  assert.ok(domainWiring, 'domain reader wiring found');
  assert.equal(domainWiring[1].trim(), 'databaseUrl, idTokens');
  assert.match(entry, /createIdTokenProvider\(\{ authAdmin: getAuth\(\)/);
});

test('static: a read never creates a receipt (the request pipeline does not import the receipt store)', () => {
  assert.ok(!specifiersOf(source('action-api.js')).some(s => s.includes('receipts')));
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
