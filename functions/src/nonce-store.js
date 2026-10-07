// functions/src/nonce-store.js
//
// HMAC transport replay protection (docs/CHRONASENSE_ACTION_API_V1.md §2): one server-private claim per
// request ID at serverRequestNonces/<serviceIdentity>/<requestId>, created atomically if absent AFTER the
// timestamp freshness check passed. A duplicate (including a concurrent race: the server lets exactly one
// conditional create win) fails closed. This is NOT domain idempotency (that is the command actionId).
//
// Bounded retention: a claim must outlive every moment its request could still pass the freshness check.
// A request stamped `t` is fresh only while |now - t| <= 300 s, and t <= claimTime + 300 s, so it can never
// be replayed later than claimTime + 600 s. Claims are kept RETENTION_MS = 660 s (that bound plus a 60 s
// clock-skew margin, "approximately 10 minutes") and then deleted by a bounded opportunistic sweep.

import { ApiError } from './errors.js';
import { FRESHNESS_SECONDS, UUID_V4 } from './service-auth.js';

export const NONCE_ROOT = 'serverRequestNonces';
export const RETENTION_MS = (2 * FRESHNESS_SECONDS + 60) * 1000;
export const SWEEP_LIMIT = 50;
const PARTITION = /^[A-Za-z0-9_-]{1,128}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);

/** @param {{infra: ReturnType<import('./infra-rtdb.js').createInfraRtdb>}} options */
export function createNonceStore({ infra }) {
  return Object.freeze({
    /** Throws AUTH_REQUIRED on a replay; RETRYABLE_TRANSPORT when the outcome is unknown. */
    async claim(partition, requestId, nowMs) {
      if (!matches(PARTITION, partition) || !matches(UUID_V4, requestId) || !Number.isSafeInteger(nowMs)) throw new Error('invalid nonce claim');
      const outcome = await infra.createIfAbsent(`${NONCE_ROOT}/${partition}/${requestId}`, { v: 1, claimedAt: nowMs, expiresAt: nowMs + RETENTION_MS });
      if (outcome !== 'created') throw new ApiError('AUTH_REQUIRED', 'Service authentication failed.', { reason: 'replayed-request-id' });
    },

    /** Deletes at most SWEEP_LIMIT claims that expired strictly before `nowMs`. Never touches a live claim.
     *  @returns {Promise<number>} how many were deleted */
    async sweepExpired(partition, nowMs) {
      if (!matches(PARTITION, partition) || !Number.isSafeInteger(nowMs)) throw new Error('invalid nonce sweep');
      const expired = await infra.queryAtMost(`${NONCE_ROOT}/${partition}`, 'expiresAt', nowMs - 1, SWEEP_LIMIT);
      const ids = Object.keys(expired).filter(id => UUID_V4.test(id) && Number.isSafeInteger(expired[id]?.expiresAt) && expired[id].expiresAt < nowMs);
      if (ids.length) await infra.patch(`${NONCE_ROOT}/${partition}`, Object.fromEntries(ids.map(id => [id, null])));
      return ids.length;
    },
  });
}
