// Non-production integration proof. Start the Firebase Auth emulator using test/auth-emulator.firebase.json.
// Uses the real Admin SDK custom-token mint and Auth emulator exchange, then real RTDB emulator rules.
// Tokens are never printed or persisted.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

import { buildCapture } from '../../brain-dump-model.js';
import { startEmulator } from '../../rtdb-emulator-support.js';
import { createIdTokenProvider, createUserScopedRtdb } from '../src/user-scoped-rtdb.js';

const PROJECT = 'demo-chronasense-task010';
const UID = 'action-proof-owner';
const ACTION = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const OTHER_ACTION = 'act1_1b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const ID = `bdc1_${ACTION.slice(5)}`;
const AUTH_HOST = '127.0.0.1:9099';

if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== AUTH_HOST) {
  throw new Error(`Set FIREBASE_AUTH_EMULATOR_HOST=${AUTH_HOST} for this local-only proof.`);
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } });
const app = initializeApp({ projectId: PROJECT, credential: cert({ projectId: PROJECT,
  clientEmail: `proof@${PROJECT}.iam.gserviceaccount.com`, privateKey }) }, 'task010-auth-claim-proof');
let database;
try {
  const auth = getAuth(app);
  await auth.createUser({ uid: UID });
  const mintedClaims = [];
  const provider = createIdTokenProvider({ authAdmin: {
    getUser: uid => auth.getUser(uid),
    createCustomToken: (uid, claims) => { mintedClaims.push(claims ?? null); return auth.createCustomToken(uid, claims); },
  }, webApiKey: 'emulator-only', exchangeUrl: `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken` });
  const actionToken = await provider.getIdToken(UID, ACTION);
  const normalToken = await provider.getIdToken(UID);
  const wrongToken = await provider.getIdToken(UID, OTHER_ACTION);
  assert.deepEqual(mintedClaims, [{ chronasenseActionId: ACTION }, null, { chronasenseActionId: OTHER_ACTION }]);
  const verified = await auth.verifyIdToken(actionToken);
  assert.equal(verified.uid, UID);
  assert.equal(verified.chronasenseActionId, ACTION, 'actual exchanged ID token carries the custom claim');
  assert.equal((await auth.verifyIdToken(normalToken)).chronasenseActionId, undefined);
  assert.equal((await auth.verifyIdToken(wrongToken)).chronasenseActionId, OTHER_ACTION);

  database = await startEmulator();
  const rules = readFileSync(new URL('../../firebase.rules.json', import.meta.url), 'utf8');
  const db = await database.fresh(rules);
  const at = `rooms/uid_${UID}/brainDump/${ID}`;
  const built = buildCapture({ id: ID, creationActionId: ACTION, text: 'non-production proof',
    now: Date.parse('2026-10-12T12:00:00.000Z'), updatedBy: 'proof-actor' });
  assert.equal(built.ok, true);
  assert.equal(await db.write(at, built.record, normalToken), false, 'normal owner cannot forge a marked create');
  assert.equal(await db.write(at, built.record, wrongToken), false, 'wrong action claim is denied');
  const scoped = createUserScopedRtdb({ databaseUrl: database.base, namespace: db.name, idTokens: provider });
  const identity = { firebaseUid: UID, roomId: `uid_${UID}` };
  assert.equal(await scoped.createCaptureIfAbsent(identity, ID, ACTION, built.record), 'created');
  assert.equal((await db.read(at)).creationActionId, ACTION);
  assert.equal(await db.write(`rooms/uid_${UID}/settings`, { timezone: 'UTC' }, actionToken), false,
    'action token cannot write unrelated owner domain data');
  assert.equal(await db.write(`rooms/uid_${UID}/settings`, { timezone: 'UTC' }, normalToken), true,
    'ordinary owner token remains writable');
  process.stdout.write('Auth custom claim exchange and RTDB rule proof passed.\n');
} finally {
  database?.stop();
  await app.delete();
}
