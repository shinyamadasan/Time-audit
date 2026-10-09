// functions/src/user-scoped-rtdb.js
//
// USER-SCOPED domain access (docs/CHRONASENSE_ACTION_API_V1.md §3). The Admin SDK is used here for exactly two
// things: confirming the configured UID is a live account, and minting a custom token for it. That token is
// exchanged (accounts:signInWithCustomToken) for a short-lived Firebase ID token, and every domain read is an
// RTDB REST request authenticated with that ID token (`?auth=`), so the existing security rules evaluate it as
// auth.uid === the owner and stay fully enforced. The refresh token is discarded; tokens never leave this module.
//
// There is deliberately NO Admin path here: this module never receives an Admin database or access token, and
// if the ID token cannot be obtained the read FAILS. It never falls back to privileged access.

import { ApiError, AuthorityBoundaryViolation } from './errors.js';
import { validFirebaseUid } from './identity.js';

/** The only room collections a user-scoped read may name. Paths are built here, never taken from a request. */
const READABLE_COLLECTIONS = new Set([
  'brainDump', 'settings', 'calendarPlanAuthority', 'dayBoundaryRevisions',
  'calendarPlans', 'operationalPlans', 'plans', 'calendarPlanFences',
  'operationalPlanFences', 'planFences', 'entries', 'commitments', 'coarseLifeEvidence',
]);
const TOKEN_EXCHANGE_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken';
// Fixed read model: cap each complete RTDB collection at 1 MiB before parsing; the separate API result cap is 64 KiB.
export const MAX_SOURCE_BODY_BYTES = 1024 * 1024;

const transport = reason => new ApiError('RETRYABLE_TRANSPORT', 'ChronaSense data is temporarily unavailable.', { reason });
const denied = reason => new ApiError('FORBIDDEN', 'ChronaSense account access was refused.', { reason });
const sourceTooLarge = () => new ApiError('DOMAIN_LIMIT', 'The complete source collection exceeds the 1 MiB read limit; no partial result is returned.',
  { reason: 'source-too-large', details: { limitBytes: MAX_SOURCE_BODY_BYTES } });

async function boundedSourceJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw transport('domain-read-body');
  const bytes = new Uint8Array(MAX_SOURCE_BODY_BYTES);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (length + value.length > MAX_SOURCE_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw sourceTooLarge();
      }
      bytes.set(value, length);
      length += value.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw transport('domain-read-body');
  }
}

function jwtSubject(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.user_id === 'string' ? payload.user_id : payload.sub;
  } catch { return null; }
}

/**
 * @param {{authAdmin:{getUser(uid:string):Promise<{disabled?:boolean}>, createCustomToken(uid:string):Promise<string>},
 *          webApiKey:string, fetch?:typeof fetch, exchangeUrl?:string, timeoutMs?:number}} options
 * @returns {{getIdToken(firebaseUid:string):Promise<string>}}
 */
export function createIdTokenProvider({ authAdmin, webApiKey, fetch: fetchImpl = globalThis.fetch, exchangeUrl = TOKEN_EXCHANGE_URL, timeoutMs = 10_000 }) {
  return Object.freeze({
    async getIdToken(firebaseUid) {
      if (!validFirebaseUid(firebaseUid)) throw denied('invalid-uid');
      let user;
      try { user = await authAdmin.getUser(firebaseUid); } catch (error) {
        if (error?.code === 'auth/user-not-found') throw denied('owner-account-missing');
        throw transport('admin-get-user');
      }
      if (!user || user.disabled) throw denied('owner-account-disabled');
      let customToken;
      try { customToken = await authAdmin.createCustomToken(firebaseUid); } catch { throw transport('custom-token'); }
      let response;
      try {
        response = await fetchImpl(`${exchangeUrl}?key=${encodeURIComponent(webApiKey)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: customToken, returnSecureToken: true }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch { throw transport('token-exchange-network'); }
      if (response.status >= 500) throw transport(`token-exchange-${response.status}`);
      if (response.status !== 200) throw denied(`token-exchange-${response.status}`);
      let idToken;
      try { ({ idToken } = await response.json()); } catch { throw transport('token-exchange-body'); }
      // The refresh token in that response is dropped here, unread. The ID token must name exactly the owner.
      if (typeof idToken !== 'string' || jwtSubject(idToken) !== firebaseUid) throw denied('token-exchange-identity');
      return idToken;
    },
  });
}

/**
 * @param {{databaseUrl:string, namespace?:string, fetch?:typeof fetch, idTokens:{getIdToken(uid:string):Promise<string>}, timeoutMs?:number}} options
 */
export function createUserScopedRtdb({ databaseUrl, namespace, fetch: fetchImpl = globalThis.fetch, idTokens, timeoutMs = 10_000 }) {
  if (!idTokens || typeof idTokens.getIdToken !== 'function') throw new Error('user-scoped RTDB needs an ID-token provider');
  return Object.freeze({
    /**
     * Reads rooms/<identity.roomId>/<collection> as the owner. Returns the parsed value (null = authoritatively
     * absent). Throws RETRYABLE_TRANSPORT when the outcome is unknown (timeout, 5xx, unreadable body): unknown
     * is never reported as absent.
     */
    async readRoomCollection(identity, collection) {
      if (!READABLE_COLLECTIONS.has(collection)) throw new AuthorityBoundaryViolation('collection is not readable through the Action API');
      if (!validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}`) throw new AuthorityBoundaryViolation('room is not derived from the bound UID');
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/${collection}.json`);
      if (namespace) url.searchParams.set('ns', namespace);
      url.searchParams.set('auth', idToken);
      let response;
      try {
        response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      } catch { throw transport('domain-read-network'); }
      if (response.status === 401 || response.status === 403) throw denied(`domain-read-${response.status}`);
      if (response.status !== 200) throw transport(`domain-read-${response.status}`);
      return boundedSourceJson(response);
    },
  });
}
