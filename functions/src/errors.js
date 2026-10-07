// functions/src/errors.js
//
// The Action API V1 error contract (docs/CHRONASENSE_ACTION_API_V1.md §12). Every rejection the backend
// returns is one of these typed codes with a safe message; `reason` is an INTERNAL diagnostic (logged, never
// sent) so an attacker cannot learn which authentication check failed.

export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_REVISION: 409,
  NEEDS_USER_DECISION: 409,
  NONEXISTENT_TIME: 422,
  PENDING_UNKNOWN: 503,
  RETRYABLE_TRANSPORT: 503,
  ALREADY_APPLIED: 200,
  PAST_TARGET_IMMUTABLE: 409,
  AMBIGUOUS_TIME: 422,
  DOMAIN_LIMIT: 422,
});

/** Only transport failures with no known domain outcome are retryable (with a NEW request ID). */
const RETRYABLE = new Set(['RETRYABLE_TRANSPORT', 'PENDING_UNKNOWN']);

export class ApiError extends Error {
  /**
   * @param {keyof ERROR_CODES} code
   * @param {string} message safe, human-readable; never contains secrets, tokens, paths or raw data
   * @param {{reason?: string, status?: number, details?: object}} [options]
   */
  constructor(code, message, { reason = code, status, details } = {}) {
    super(message);
    if (!(code in ERROR_CODES)) throw new Error(`unknown error code ${code}`);
    this.code = code;
    this.reason = reason;
    this.status = status ?? ERROR_CODES[code];
    this.details = details;
  }
}

/** Raised by any helper asked to touch a path outside its authority (§3: STOP — AUTHORITY BOUNDARY VIOLATED). */
export class AuthorityBoundaryViolation extends Error {
  constructor(message) {
    super(`STOP — AUTHORITY BOUNDARY VIOLATED: ${message}`);
    this.name = 'AuthorityBoundaryViolation';
  }
}

export function errorBody(error, requestId = null) {
  return {
    contractVersion: 1,
    requestId,
    error: {
      code: error.code,
      message: error.message,
      retryability: RETRYABLE.has(error.code) ? 'retry_with_new_request_id' : 'not_retryable',
      ...(error.details ? { details: error.details } : {}),
    },
  };
}
