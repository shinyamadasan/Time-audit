// functions/src/user-scoped-rtdb.js
//
// USER-SCOPED domain access (docs/CHRONASENSE_ACTION_API_V1.md §3). The Admin SDK is used here for exactly two
// things: confirming the configured UID is a live account, and minting a custom token for it. That token is
// exchanged (accounts:signInWithCustomToken) for a short-lived Firebase ID token, and every domain read is an
// RTDB REST request authenticated with that ID token (`?auth=`), so the existing security rules evaluate it as
// auth.uid === the owner and stay fully enforced. The refresh token is discarded; tokens never leave this module.
//
// There is deliberately NO Admin path here: this module never receives an Admin database or access token, and
// if the ID token cannot be obtained the operation FAILS. It never falls back to privileged access.

import { ApiError, AuthorityBoundaryViolation } from './errors.js';
import { ACTION_ID, captureIdForAction } from './command-identity.js';
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

function jwtClaims(idToken) {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  } catch { return null; }
}

/**
 * @param {{authAdmin:{getUser(uid:string):Promise<{disabled?:boolean}>, createCustomToken(uid:string, claims?:object):Promise<string>},
 *          webApiKey:string, fetch?:typeof fetch, exchangeUrl?:string, timeoutMs?:number}} options
 * @returns {{getIdToken(firebaseUid:string, actionId?:string):Promise<string>}}
 */
export function createIdTokenProvider({ authAdmin, webApiKey, fetch: fetchImpl = globalThis.fetch, exchangeUrl = TOKEN_EXCHANGE_URL, timeoutMs = 10_000 }) {
  return Object.freeze({
    async getIdToken(firebaseUid, actionId) {
      if (!validFirebaseUid(firebaseUid)) throw denied('invalid-uid');
      if (actionId !== undefined && (typeof actionId !== 'string' || !ACTION_ID.test(actionId))) throw denied('invalid-action-id');
      let user;
      try { user = await authAdmin.getUser(firebaseUid); } catch (error) {
        if (error?.code === 'auth/user-not-found') throw denied('owner-account-missing');
        throw transport('admin-get-user');
      }
      if (!user || user.disabled) throw denied('owner-account-disabled');
      let customToken;
      try { customToken = await authAdmin.createCustomToken(firebaseUid, actionId ? { chronasenseActionId: actionId } : undefined); } catch { throw transport('custom-token'); }
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
      const claims = typeof idToken === 'string' ? jwtClaims(idToken) : null;
      if (!claims || (claims.user_id ?? claims.sub) !== firebaseUid || (actionId && claims.chronasenseActionId !== actionId)) throw denied('token-exchange-identity');
      return idToken;
    },
  });
}

/**
 * @param {{databaseUrl:string, namespace?:string, fetch?:typeof fetch, idTokens:{getIdToken(uid:string):Promise<string>}, timeoutMs?:number}} options
 */
export function createUserScopedRtdb({ databaseUrl, namespace, fetch: fetchImpl = globalThis.fetch, idTokens, timeoutMs = 10_000 }) {
  if (!idTokens || typeof idTokens.getIdToken !== 'function') throw new Error('user-scoped RTDB needs an ID-token provider');
  function captureUrl(identity, captureId, idToken) {
    if (!validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}`
      || typeof captureId !== 'string' || !/^bdc1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(captureId)) {
      throw new AuthorityBoundaryViolation('capture address is not derived from the bound UID and action ID');
    }
    const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/brainDump/${captureId}.json`);
    if (namespace) url.searchParams.set('ns', namespace);
    url.searchParams.set('auth', idToken);
    return url;
  }
  return Object.freeze({
    async createCaptureIfAbsent(identity, captureId, actionId, record) {
      if (typeof actionId !== 'string' || !ACTION_ID.test(actionId) || captureId !== captureIdForAction(actionId)
        || record?.id !== captureId || record.creationActionId !== actionId) {
        throw new AuthorityBoundaryViolation('capture create requires its exact action attribution');
      }
      const idToken = await idTokens.getIdToken(identity.firebaseUid, actionId);
      const url = captureUrl(identity, captureId, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'PUT', headers: { 'if-match': 'null_etag', 'content-type': 'application/json' },
        body: JSON.stringify(record), signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-create-network'); }
      if (response.status === 200) return 'created';
      if (response.status === 412) return 'exists';
      if (response.status === 401 || response.status === 403) throw denied(`domain-create-${response.status}`);
      throw transport(`domain-create-${response.status}`);
    },
    async readCapture(identity, captureId) {
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      const url = captureUrl(identity, captureId, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-capture-read-network'); }
      if (response.status === 401 || response.status === 403) throw denied(`domain-capture-read-${response.status}`);
      if (response.status !== 200) throw transport(`domain-capture-read-${response.status}`);
      return boundedSourceJson(response);
    },
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
