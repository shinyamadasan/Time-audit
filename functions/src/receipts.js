// functions/src/receipts.js
//
// Private action receipts (docs/CHRONASENSE_ACTION_API_V1.md §5, §6). Brain Dump create uses the
// canonical request hash, initial claim and ETag-guarded transitions. Reads create no receipt.
//
// A receipt records only what ChronaSense accepted/applied for one actionId. It is operational/audit linkage,
// never domain truth, and never evidence that anything happened in real life (Action Provenance V1).

import { canonicalSha256Hex } from './canonical-json.js';
import { ACTION_ID } from './command-identity.js';
import { validFirebaseUid } from './identity.js';

export const RECEIPT_ROOT = 'serverActionReceipts';
export { ACTION_ID } from './command-identity.js';
export const RECEIPT_STATES = Object.freeze(['started', 'pending_unknown', 'applied', 'conflict', 'rejected', 'needs_user_decision']);
export const TERMINAL_RECEIPT_STATES = Object.freeze(['applied', 'conflict', 'rejected', 'needs_user_decision']);

/** started -> pending_unknown | terminal; pending_unknown -> terminal (reconciliation only); terminal is immutable. */
export function canTransition(from, to) {
  if (!RECEIPT_STATES.includes(from) || !RECEIPT_STATES.includes(to)) return false;
  if (TERMINAL_RECEIPT_STATES.includes(from)) return false;
  if (from === 'started') return to !== 'started';
  return TERMINAL_RECEIPT_STATES.includes(to);
}

const COMMAND_FIELDS = ['contractVersion', 'actionId', 'kind', 'parameters', 'expectedRevision', 'actionProvenance'];

/** §5: lowercase hex SHA-256 of the RFC 8785 canonical semantic command. `expectedRevision` is an explicit null
 *  when absent, so "no expectation" and "omitted" hash identically and nothing else does. */
export function canonicalRequestHash(command) {
  const semantic = {};
  for (const field of COMMAND_FIELDS) semantic[field] = command[field] === undefined && field === 'expectedRevision' ? null : command[field];
  for (const field of COMMAND_FIELDS) if (semantic[field] === undefined) throw new Error(`command is missing ${field}`);
  return canonicalSha256Hex(semantic);
}

export function receiptPath(firebaseUid, actionId) {
  if (!validFirebaseUid(firebaseUid) || typeof actionId !== 'string' || !ACTION_ID.test(actionId)) throw new Error('invalid receipt address');
  return `${RECEIPT_ROOT}/${firebaseUid}/${actionId}`;
}

/**
 * How an EXISTING receipt answers a new attempt with the same actionId. Never authorizes blind re-execution:
 * an expired lease only permits the operation-specific recovery protocol (Phase C/D), never a fresh run.
 * @returns {'conflict'|'replay'|'lease_active'|'recover'}
 */
export function classifyExistingReceipt(existing, { requestHash, nowMs }) {
  if (existing.requestHash !== requestHash) return 'conflict';
  if (TERMINAL_RECEIPT_STATES.includes(existing.state)) return 'replay';
  if (['started', 'pending_unknown'].includes(existing.state)
    && Number.isSafeInteger(existing.leaseExpiresAt) && existing.leaseExpiresAt > nowMs) return 'lease_active';
  return 'recover';
}

/** @param {{infra: ReturnType<import('./infra-rtdb.js').createInfraRtdb>}} options */
export function createReceiptStore({ infra }) {
  return Object.freeze({
    /** The atomic initial claim (§6): ABSENT grants exactly one executor. */
    async claim({ firebaseUid, actionId, requestHash, kind, attemptId, nowMs, leaseMs, plannedRecordId, plannedTarget, authorizationContext, actionProvenanceRefs }) {
      if (!/^[0-9a-f]{64}$/.test(requestHash) || typeof kind !== 'string' || !kind || typeof attemptId !== 'string' || !attemptId) throw new Error('invalid receipt claim');
      if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('invalid receipt lease');
      const receipt = {
        contractVersion: 1, actionId, requestHash, kind, state: 'started', attemptId,
        leaseAcquiredAt: nowMs, leaseExpiresAt: nowMs + leaseMs, createdAt: nowMs, updatedAt: nowMs,
        ...(plannedRecordId ? { plannedRecordId } : {}),
        ...(plannedTarget ? { plannedTarget } : {}),
        ...(authorizationContext ? { authorizationContext } : {}),
        ...(actionProvenanceRefs ? { actionProvenanceRefs } : {}),
      };
      const path = receiptPath(firebaseUid, actionId);
      if ((await infra.createIfAbsent(path, receipt)) === 'created') return { claimed: true, receipt };
      return { claimed: false, existing: await infra.get(path) };
    },
    async read(firebaseUid, actionId) {
      return infra.get(receiptPath(firebaseUid, actionId));
    },
    async readWithEtag(firebaseUid, actionId) {
      return infra.getWithEtag(receiptPath(firebaseUid, actionId));
    },
    async compareAndSet(firebaseUid, actionId, receipt, etag) {
      return infra.putIfMatch(receiptPath(firebaseUid, actionId), receipt, etag);
    },
  });
}
