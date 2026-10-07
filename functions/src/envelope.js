// functions/src/envelope.js
//
// The §5 query envelope, strictly: exactly { contractVersion: 1, requestId, kind, parameters }, nothing else at
// either level. Account, UID, room, path or subject are never parameters, so there is no field through which a
// caller could name them. Phase A1 knows exactly one kind; every other kind (other reads, every command) is
// INVALID_INPUT, so there is no write surface.

import { JsonInputError, strictParseJson } from './canonical-json.js';
import { ApiError } from './errors.js';

/** kind -> { scope, parameter keys } */
export const QUERY_KINDS = Object.freeze({
  get_brain_dump: Object.freeze({ scope: 'chronasense:read', parameters: Object.freeze([]) }),
});
const ENVELOPE_KEYS = ['contractVersion', 'kind', 'parameters', 'requestId'];

const invalid = (message, reason) => new ApiError('INVALID_INPUT', message, { reason });

/** @returns {{kind:string, parameters:object, scope:string}} */
export function parseQueryEnvelope(rawBody, { requestId }) {
  let body;
  try { body = strictParseJson(rawBody); } catch (error) {
    if (error instanceof JsonInputError) throw invalid(`Malformed request body: ${error.message}.`, 'malformed-json');
    throw error;
  }
  const keys = Object.keys(body).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key, i) => key !== ENVELOPE_KEYS[i])) throw invalid('The envelope must contain exactly contractVersion, requestId, kind and parameters.', 'envelope-fields');
  if (body.contractVersion !== 1) throw invalid('contractVersion must be 1.', 'contract-version');
  // The body's requestId is the one the HMAC covered in the header; they must be the same attempt.
  if (body.requestId !== requestId) throw invalid('requestId does not match the authenticated request.', 'request-id-mismatch');
  if (typeof body.kind !== 'string' || !Object.hasOwn(QUERY_KINDS, body.kind)) throw invalid('Unsupported kind.', 'unsupported-kind');
  const spec = QUERY_KINDS[body.kind];
  const { parameters } = body;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw invalid('parameters must be an object.', 'parameters-type');
  const unknown = Object.keys(parameters).filter(key => !spec.parameters.includes(key));
  if (unknown.length) throw invalid('Unknown parameters.', 'unknown-parameters');
  return { kind: body.kind, parameters, scope: spec.scope };
}
