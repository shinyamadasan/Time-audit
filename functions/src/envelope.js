// functions/src/envelope.js
//
// The §5 query envelope, strictly: exactly { contractVersion: 1, requestId, kind, parameters }, nothing else at
// either level. Account, UID, room, path or subject are never parameters, so there is no field through which a
// caller could name them. Only fixed, read-only kinds are accepted; every command is INVALID_INPUT.

import { JsonInputError, strictParseJson } from './canonical-json.js';
import { ApiError } from './errors.js';

/** kind -> { scope, parameter keys } */
export const QUERY_KINDS = Object.freeze({
  get_brain_dump: Object.freeze({ scope: 'chronasense:read', parameters: Object.freeze([]) }),
  get_today: Object.freeze({ scope: 'chronasense:read', parameters: Object.freeze([]) }),
  get_plan: Object.freeze({ scope: 'chronasense:read', parameters: Object.freeze(['target']) }),
  get_item: Object.freeze({ scope: 'chronasense:read', parameters: Object.freeze(['source', 'id', 'target']) }),
  get_intelligence: Object.freeze({ scope: 'chronasense:read', parameters: Object.freeze([]) }),
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
  if (body.kind === 'get_plan' && Object.hasOwn(parameters, 'target') && !validTarget(parameters.target)) throw invalid('Invalid plan target.', 'plan-target');
  if (body.kind === 'get_item') {
    if (!['brain_dump', 'plan'].includes(parameters.source) || typeof parameters.id !== 'string' || !parameters.id || parameters.id.length > 500) throw invalid('A supported source and stable item ID are required.', 'item-identity');
    if (parameters.source === 'plan' ? !validTarget(parameters.target) : Object.hasOwn(parameters, 'target')) throw invalid('Plan items require an exact target; captures do not take one.', 'item-target');
  }
  return { kind: body.kind, parameters, scope: spec.scope };
}

function validTarget(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'id,store'
    && ['calendar', 'legacy', 'operational'].includes(value.store)
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 500;
}
