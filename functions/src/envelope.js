// functions/src/envelope.js
//
// The §5 query envelope, strictly: exactly { contractVersion: 1, requestId, kind, parameters }, nothing else at
// either level. Account, UID, room, path or subject are never parameters, so there is no field through which a
// caller could name them. Commands use the separate strict create envelope and route below.

import { JsonInputError, strictParseJson } from './canonical-json.js';
import { ApiError } from './errors.js';
import { createHash } from 'node:crypto';
import { ACTION_ID } from './command-identity.js';
import { parseCalendarPlanId, validateCalendarPlanItem } from '../shared/calendar-plan-model.js';
import { canonicalizeOperationalDayTimezone, validOperationalDayTimezone } from '../shared/personal-day-boundary-model.js';
import { validPlanItemDuration, validPlanItemTime } from '../shared/plan-tomorrow-model.js';

/** command kind -> the write scope it requires. Exactly one user-intended mutation per command. */
export const COMMAND_KINDS = Object.freeze({
  brain_dump_add: Object.freeze({ scope: 'chronasense:brain-dump.write' }),
  plan_create: Object.freeze({ scope: 'chronasense:plan.write' }),
});
/** The plan task editor's own title bound (planning-continuity-ui.js maxlength). */
export const PLAN_TITLE_MAX = 200;

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

export function actionActorRef(subject) {
  return `actor1:${createHash('sha256').update(`chronasense-action-actor-v1\n${subject}`, 'utf8').digest('base64url')}`;
}

/** A single structured create command. Transport requestId changes on retry; every other field remains semantic. */
export function parseCreateEnvelope(rawBody, { requestId, subject }) {
  let body;
  try { body = strictParseJson(rawBody); }
  catch (error) { if (error instanceof JsonInputError) throw invalid('Malformed command body.', 'malformed-json'); throw error; }
  const fields = ['actionId', 'actionProvenance', 'contractVersion', 'expectedRevision', 'kind', 'parameters', 'requestId'];
  if (Object.keys(body).sort().join(',') !== fields.join(',') || body.contractVersion !== 1 || body.requestId !== requestId
    || typeof body.kind !== 'string' || !Object.hasOwn(COMMAND_KINDS, body.kind) || typeof body.actionId !== 'string' || !ACTION_ID.test(body.actionId)
    || body.expectedRevision !== null) throw invalid('Unsupported or malformed create command.', 'command-envelope');
  const parameters = body.kind === 'plan_create' ? planCreateParameters(body.parameters) : brainDumpParameters(body.parameters);
  return { contractVersion: 1, actionId: body.actionId, kind: body.kind,
    parameters, expectedRevision: null, actionProvenance: actionProvenance(body, subject) };
}

function brainDumpParameters(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).join(',') !== 'text'
    || typeof parameters.text !== 'string' || !parameters.text.trim()) {
    throw invalid('Brain Dump text is required.', 'capture-text');
  }
  if (parameters.text.trim().length > 1000) throw new ApiError('DOMAIN_LIMIT', 'Brain Dump text exceeds 1000 characters.',
    { reason: 'capture-text-limit', details: { limit: 1000 } });
  return { text: parameters.text.trim() };
}

function actionProvenance(body, subject) {
  const provenance = body.actionProvenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)
    || Object.keys(provenance).sort().join(',') !== 'actionId,actorRef,capturedAt,sourceKind,version'
    || provenance.version !== 1 || provenance.sourceKind !== 'chatgpt_plugin'
    || provenance.actionId !== body.actionId || provenance.actorRef !== actionActorRef(subject)
    || typeof provenance.capturedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(provenance.capturedAt)
    || Number.isNaN(Date.parse(provenance.capturedAt)) || new Date(provenance.capturedAt).toISOString() !== provenance.capturedAt) {
    throw invalid('Action provenance is invalid.', 'action-provenance');
  }
  return provenance;
}

const PLAN_CREATE_KEYS = ['durationMinutes', 'target', 'title', 'when', 'whenDayOffset', 'whenTz'];

/** plan_create's structured intent (docs/CHRONASENSE_ACTION_API_V1.md §9). Natural language was resolved by the
 *  controller; nothing here guesses a date, time, zone or duration. Everything decidable from the payload alone
 *  (shape, title, wall time, DST gap, the plan's two-date extent) is decided HERE, before any receipt exists, so a
 *  definite rejection never consumes an action ID. Store routing, activation and past-day immutability need the
 *  account's authoritative state and are decided after the claim (plan-create-action.js). */
function planCreateParameters(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
    || Object.keys(parameters).some(key => !PLAN_CREATE_KEYS.includes(key))) throw invalid('Unsupported plan create parameters.', 'plan-parameters');
  const { target } = parameters;
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).sort().join(',') !== 'id,store'
    || typeof target.store !== 'string' || typeof target.id !== 'string') throw invalid('An exact plan target is required.', 'plan-target');
  if (target.store !== 'calendar') {
    throw new ApiError('DOMAIN_LIMIT', 'Conversational plan create supports calendar-day plans only.',
      { reason: 'plan-store-unsupported', details: { supportedStores: ['calendar'] } });
  }
  const date = parseCalendarPlanId(target.id);
  if (!date || target.id !== `cal1:${date}`) throw invalid('Invalid calendar plan identity.', 'plan-target');
  if (typeof parameters.title !== 'string' || !parameters.title.trim()) throw invalid('A task title is required.', 'plan-title');
  const title = parameters.title.trim();
  if (title.length > PLAN_TITLE_MAX) {
    throw new ApiError('DOMAIN_LIMIT', `Task titles are limited to ${PLAN_TITLE_MAX} characters.`, { reason: 'plan-title-limit', details: { limit: PLAN_TITLE_MAX } });
  }
  const normalized = { target: { store: 'calendar', id: target.id }, title };
  if (!Object.hasOwn(parameters, 'when')) {
    // A date-only task stays date-only: no zone, offset or length without a wall time to anchor them.
    if (['whenDayOffset', 'whenTz', 'durationMinutes'].some(key => Object.hasOwn(parameters, key))) throw invalid('Time fields require an explicit start time.', 'plan-untimed-fields');
    return normalized;
  }
  if (!validPlanItemTime(parameters.when)) throw invalid('Start time must be HH:MM (24-hour).', 'plan-when');
  if (typeof parameters.whenTz !== 'string' || !validOperationalDayTimezone(parameters.whenTz)
    || canonicalizeOperationalDayTimezone(parameters.whenTz) !== parameters.whenTz) throw invalid('A canonical IANA timezone is required with a start time.', 'plan-timezone');
  const whenDayOffset = Object.hasOwn(parameters, 'whenDayOffset') ? parameters.whenDayOffset : 0;
  if (whenDayOffset !== 0 && whenDayOffset !== 1) throw invalid('whenDayOffset must be 0 or 1.', 'plan-day-offset');
  if (Object.hasOwn(parameters, 'durationMinutes') && !validPlanItemDuration(parameters.durationMinutes)) {
    throw new ApiError('DOMAIN_LIMIT', 'Duration must be a whole number of minutes from 1 to 720.', { reason: 'plan-duration', details: { min: 1, max: 720 } });
  }
  Object.assign(normalized, { when: parameters.when, whenDayOffset, whenTz: parameters.whenTz,
    ...(Object.hasOwn(parameters, 'durationMinutes') ? { durationMinutes: parameters.durationMinutes } : {}) });
  const check = validateCalendarPlanItem(date, planItemTime(normalized));
  if (check.ok) return normalized;
  if (check.reason === 'nonexistent-time') {
    throw new ApiError('NONEXISTENT_TIME', 'That wall time does not exist on that date in that timezone (DST gap).', { reason: 'plan-nonexistent-time' });
  }
  if (check.reason === 'outside-plan-extent') {
    throw new ApiError('DOMAIN_LIMIT', 'A plan item must end before the start of the second day after its plan date.', { reason: 'plan-extent' });
  }
  throw invalid('The plan time is invalid.', `plan-${check.reason}`);
}

/** The calendar model's time fields for normalized plan_create parameters (absent offset === 0). */
export function planItemTime(parameters) {
  if (!Object.hasOwn(parameters, 'when')) return { when: '' };
  return { when: parameters.when, whenTz: parameters.whenTz,
    ...(parameters.whenDayOffset ? { whenDayOffset: parameters.whenDayOffset } : {}),
    ...(Object.hasOwn(parameters, 'durationMinutes') ? { durationMinutes: parameters.durationMinutes } : {}) };
}
