// functions/src/identity.js
//
// Exact allowlisted binding (docs/CHRONASENSE_ACTION_API_V1.md §2; TASK-029). The ONLY input is the subject the
// HMAC proved the Worker asserted; its Firebase UID comes from server configuration (the owner pair plus at most
// one explicit second pair) and the room is derived from that UID. Nothing from the request body or any header
// other than the signed subject can reach this decision.

import { timingSafeEqual } from 'node:crypto';

import { ApiError } from './errors.js';

/** A Firebase UID that is also a safe RTDB key segment (room `uid_<uid>`). Anything else fails closed. */
export const FIREBASE_UID = /^[A-Za-z0-9_-]{1,128}$/;
/** Typed: RegExp#test would coerce undefined to the string "undefined", which matches. */
export const validFirebaseUid = value => typeof value === 'string' && FIREBASE_UID.test(value);
// The signed-subject grammar (service-auth.js): printable ASCII without space or comma.
const SUBJECT = /^[\x21-\x2b\x2d-\x7e]{1,256}$/;
const validSubject = value => typeof value === 'string' && SUBJECT.test(value);

function sameString(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

const misconfigured = () => new ApiError('FORBIDDEN', 'The owner mapping is not configured.', { reason: 'owner-mapping-missing' });

/**
 * The explicit allowlist: the owner pair, plus the second pair only when BOTH of its values are set. A half-set,
 * malformed or colliding (same subject or same UID) configuration is a fault: every call is refused.
 * @param {{ownerSubject?:string, ownerFirebaseUid?:string, secondSubject?:string, secondFirebaseUid?:string}} owner
 * @returns {ReadonlyArray<{subject:string, firebaseUid:string}>}
 */
export function identityAllowlist(owner) {
  const { ownerSubject, ownerFirebaseUid, secondSubject = '', secondFirebaseUid = '' } = owner || {};
  if (!validSubject(ownerSubject) || !validFirebaseUid(ownerFirebaseUid)) throw misconfigured();
  if (secondSubject === '' && secondFirebaseUid === '') return Object.freeze([Object.freeze({ subject: ownerSubject, firebaseUid: ownerFirebaseUid })]);
  if (!validSubject(secondSubject) || !validFirebaseUid(secondFirebaseUid)
    || secondSubject === ownerSubject || secondFirebaseUid === ownerFirebaseUid) throw misconfigured();
  return Object.freeze([Object.freeze({ subject: ownerSubject, firebaseUid: ownerFirebaseUid }),
    Object.freeze({ subject: secondSubject, firebaseUid: secondFirebaseUid })]);
}

/**
 * @param {{subject:string, scopes:readonly string[]}} assertion verified by verifyServiceRequest
 * @param {Parameters<typeof identityAllowlist>[0]} owner the configured allowlist
 * @returns {Readonly<{principalSubject:string, firebaseUid:string, roomId:string, scopes:readonly string[]}>}
 */
export function bindIdentity(assertion, owner) {
  const allowlist = identityAllowlist(owner);
  // Compare against every entry (no early exit); config validation guarantees at most one can match.
  let firebaseUid = null;
  for (const entry of allowlist) if (sameString(assertion.subject, entry.subject)) firebaseUid = entry.firebaseUid;
  if (firebaseUid === null) {
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
