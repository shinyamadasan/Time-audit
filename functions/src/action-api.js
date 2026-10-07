// functions/src/action-api.js
//
// The Action API V1 request pipeline (docs/CHRONASENSE_ACTION_API_V1.md §2-§5), framework-free so every step
// is testable without Firebase. Order is load-bearing — each step runs only after every earlier one passed,
// and nothing touches the domain before all of them have:
//
//   1. service authentication (method, canonical path, headers, service, key, freshness, HMAC over raw body)
//   2. strict envelope (JSON, unknown fields, contractVersion, requestId == signed requestId, known kind)
//   3. identity binding (signed subject == configured owner -> configured UID -> room uid_<uid>)
//   4. required scope present in the SIGNED scopes
//   5. replay nonce: atomic create-if-absent (duplicate fails closed)
//   6. the typed query, through the user-scoped reader only
//
// Responses never echo anything unauthenticated: requestId appears only once the HMAC has verified it.

import { getBrainDump } from './brain-dump-query.js';
import { ApiError, errorBody } from './errors.js';
import { bindIdentity, requireScope } from './identity.js';
import { parseQueryEnvelope } from './envelope.js';
import { SERVICE_IDENTITY, verifyServiceRequest } from './service-auth.js';

export const CANONICAL_PATH = '/v1/query';

const QUERIES = Object.freeze({ get_brain_dump: getBrainDump });

/**
 * @param {{keys:Map<string,Uint8Array>, owner:{ownerSubject:string, ownerFirebaseUid:string},
 *          nonces:ReturnType<import('./nonce-store.js').createNonceStore>,
 *          domain:{readRoomCollection(identity:object, collection:string):Promise<unknown>},
 *          now?:()=>number, log?:(entry:object)=>void}} deps
 * @returns {(request:{method:string, path:string, rawHeaders:string[], rawBody:Uint8Array}) => Promise<{status:number, body:object, reason:string}>}
 */
export function createActionApiHandler({ keys, owner, nonces, domain, now = Date.now, log = () => {} }) {
  return async function handle(request) {
    let requestId = null;
    try {
      const nowMs = now();
      const assertion = verifyServiceRequest(request, { keys, nowSeconds: Math.floor(nowMs / 1000), canonicalPath: CANONICAL_PATH });
      requestId = assertion.requestId;
      const query = parseQueryEnvelope(request.rawBody, { requestId });
      const identity = bindIdentity(assertion, owner);
      requireScope(identity, query.scope);
      await nonces.claim(SERVICE_IDENTITY, requestId, nowMs);
      // Bounded retention sweep; best-effort, it never decides the outcome of this request.
      nonces.sweepExpired(SERVICE_IDENTITY, nowMs).catch(() => log({ event: 'nonce-sweep-failed', requestId }));
      const { result, authority } = await QUERIES[query.kind](identity, { domain, nowMs });
      log({ event: 'ok', kind: query.kind, requestId });
      return { status: 200, reason: 'ok', body: { contractVersion: 1, requestId, kind: query.kind, result, authority } };
    } catch (error) {
      // Anything untyped (including an AuthorityBoundaryViolation) is a server fault: fail closed, say nothing.
      const typed = error instanceof ApiError ? error : new ApiError('RETRYABLE_TRANSPORT', 'The request could not be completed.', { reason: error?.name === 'AuthorityBoundaryViolation' ? 'authority-boundary' : 'internal', status: 500 });
      log({ event: 'rejected', code: typed.code, reason: typed.reason, requestId });
      return { status: typed.status, reason: typed.reason, body: errorBody(typed, requestId) };
    }
  };
}
