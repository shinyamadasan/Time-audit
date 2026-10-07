// functions/index.js
//
// ChronaSense Action API V1 — Phase A1 entry point: Firebase Functions v2 HTTPS in asia-southeast1.
// NOT DEPLOYED. The only file that imports Firebase; everything it wires is in src/ and tested without it.
//
// Authority split (docs/CHRONASENSE_ACTION_API_V1.md §3):
//   - Admin SDK: confirm the configured UID, mint its custom token, and (via the Admin credential's access
//     token) the server-private nonce/receipt nodes only — src/infra-rtdb.js refuses every other path.
//   - Domain data: the owner's exchanged ID token over RTDB REST — src/user-scoped-rtdb.js. No fallback.

import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';

import { createActionApiHandler } from './src/action-api.js';
import { ConfigError, parseDatabaseUrl, parseHmacKeys, requireValue } from './src/config.js';
import { ApiError, errorBody } from './src/errors.js';
import { createInfraRtdb } from './src/infra-rtdb.js';
import { createNonceStore } from './src/nonce-store.js';
import { createIdTokenProvider, createUserScopedRtdb } from './src/user-scoped-rtdb.js';

const HMAC_KEYS = defineSecret('CHRONASENSE_WORKER_HMAC_KEYS');
const OWNER_SUBJECT = defineString('CHRONASENSE_OWNER_SUBJECT');
const OWNER_FIREBASE_UID = defineString('CHRONASENSE_OWNER_FIREBASE_UID');
const RTDB_URL = defineString('CHRONASENSE_RTDB_URL');
const WEB_API_KEY = defineString('CHRONASENSE_FIREBASE_WEB_API_KEY');

initializeApp();
const adminCredential = applicationDefault();

let handler = null;
function getHandler() {
  if (handler) return handler;
  const databaseUrl = parseDatabaseUrl(RTDB_URL.value());
  const infra = createInfraRtdb({ databaseUrl, getAccessToken: async () => (await adminCredential.getAccessToken()).access_token });
  const idTokens = createIdTokenProvider({ authAdmin: getAuth(), webApiKey: requireValue('CHRONASENSE_FIREBASE_WEB_API_KEY', WEB_API_KEY.value()) });
  handler = createActionApiHandler({
    keys: parseHmacKeys(HMAC_KEYS.value()),
    owner: { ownerSubject: OWNER_SUBJECT.value(), ownerFirebaseUid: OWNER_FIREBASE_UID.value() },
    nonces: createNonceStore({ infra }),
    domain: createUserScopedRtdb({ databaseUrl, idTokens }),
    // Codes, reasons and request IDs only: never headers, bodies, subjects, tokens or secrets.
    log: entry => console.log(JSON.stringify({ component: 'chronasense-action-api', ...entry })),
  });
  return handler;
}

export const chronasenseActionApi = onRequest({ region: 'asia-southeast1', secrets: [HMAC_KEYS] },async (req, res) => {
  let handle;
  try { handle = getHandler(); } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(JSON.stringify({ component: 'chronasense-action-api', event: 'config-invalid' }));
    const refused = new ApiError('AUTH_REQUIRED', 'Service authentication failed.', { reason: 'config-invalid' });
    res.status(refused.status).json(errorBody(refused));
    return;
  }
  const { status, body } = await handle({ method: req.method, path: req.url, rawHeaders: req.rawHeaders, rawBody: req.rawBody });
  res.status(status).set('cache-control', 'no-store').json(body);
});
