// functions/src/identity.js
//
// Exact single-owner binding (docs/CHRONASENSE_ACTION_API_V1.md §2). The ONLY input is the subject the HMAC
// proved the Worker asserted; the Firebase UID comes from server configuration and the room is derived from it.
// Nothing from the request body or any header other than the signed subject can reach this decision.

import { timingSafeEqual } from 'node:crypto';

import { ApiError } from './errors.js';

/** A Firebase UID that is also a safe RTDB key segment (room `uid_<uid>`). Anything else fails closed. */
export const FIREBASE_UID = /^[A-Za-z0-9_-]{1,128}$/;
/** Typed: RegExp#test would coerce undefined to the string "undefined", which matches. */
export const validFirebaseUid = value => typeof value === 'string' && FIREBASE_UID.test(value);

function sameString(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * @param {{subject:string, scopes:readonly string[]}} assertion verified by verifyServiceRequest
 * @param {{ownerSubject?:string, ownerFirebaseUid?:string}} owner the configured single-owner mapping
 * @returns {Readonly<{principalSubject:string, firebaseUid:string, roomId:string, scopes:readonly string[]}>}
 */
export function bindIdentity(assertion, owner) {
  const ownerSubject = owner?.ownerSubject;
  const firebaseUid = owner?.ownerFirebaseUid;
  // A missing or malformed mapping is a configuration fault: every call is refused, nothing is guessed.
  if (typeof ownerSubject !== 'string' || !ownerSubject || !validFirebaseUid(firebaseUid)) {
    throw new ApiError('FORBIDDEN', 'The owner mapping is not configured.', { reason: 'owner-mapping-missing' });
  }
  if (!sameString(assertion.subject, ownerSubject)) {
    throw new ApiError('FORBIDDEN', 'The principal is not linked to this ChronaSense account.', { reason: 'owner-mismatch' });
  }
  return Object.freeze({
    principalSubject: assertion.subject,
    firebaseUid,
    roomId: `uid_${firebaseUid}`,
    scopes: assertion.scopes,
  });
}

export function requireScope(identity, scope) {
  if (!identity.scopes.includes(scope)) {
    throw new ApiError('FORBIDDEN', 'The granted scopes do not allow this request.', { reason: 'missing-scope', details: { requiredScope: scope } });
  }
}
