import { McpServer, createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames,
  localhostAllowedOrigins, originValidationResponse } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { commandActionApi, queryActionApi } from './action-client.js';

export const ISSUER = 'https://chronasense-conversational-bridge.shinyamadasan.workers.dev';
export const RESOURCE = `${ISSUER}/mcp`;
export const READ_SCOPE = 'chronasense:read';
export const WRITE_SCOPE = 'chronasense:brain-dump.write';
export const PLAN_WRITE_SCOPE = 'chronasense:plan.write';
/** Every scope this resource knows. A write tool requires read plus exactly its own write scope. */
export const KNOWN_SCOPES = Object.freeze([READ_SCOPE, WRITE_SCOPE, PLAN_WRITE_SCOPE]);
const RESOURCE_METADATA = `${ISSUER}/.well-known/oauth-protected-resource/mcp`;
const SCHEMES = [{ type: 'oauth2', scopes: [READ_SCOPE] }];
const writeSchemes = scope => [{ type: 'oauth2', scopes: [READ_SCOPE, scope] }];
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const HOST = new URL(ISSUER).hostname;

const row = z.looseObject({ id: z.string(), title: z.string(), kind: z.enum(['fact', 'derived', 'unknown', 'pattern']),
  status: z.string(), detail: z.string(), refs: z.array(z.looseObject({ source: z.string(), id: z.string() })) });
const target = z.strictObject({ store: z.enum(['calendar', 'legacy', 'operational']), id: z.string().min(1),
  date: z.string(), timezone: z.string(), startMs: z.number(), endMs: z.number(), boundaryTime: z.string() });
const targetInput = z.strictObject({ store: z.enum(['calendar', 'legacy', 'operational']), id: z.string().min(1).max(500) });
const item = z.looseObject({ itemId: z.string(), task: z.string(), kind: z.string(), done: z.boolean(),
  when: z.string().nullable(), whenDayOffset: z.number().int(), whenTz: z.string().nullable(),
  durationMinutes: z.number().nullable(), startMs: z.number().nullable(), endMs: z.number().nullable(),
  sourceCaptureId: z.string().nullable(), revision: z.string() });
const plan = z.strictObject({ target, items: z.array(item), state: z.enum(['absent', 'present']), revision: z.string() });
const capture = z.looseObject({ captureId: z.string(), text: z.string(), status: z.string(),
  promotionPending: z.boolean(), revision: z.string() });
const view = z.looseObject({ state: z.literal('ready'), today: z.string(), timezone: z.string(),
  attention: z.array(row), planActual: z.array(row), actuals: z.array(row), openLoops: z.array(row),
  patterns: z.array(row), notes: z.array(z.string()) });
const output = (kind, result) => z.strictObject({ contractVersion: z.literal(1), requestId: z.string(),
  kind: z.literal(kind), result, authority: z.looseObject({ authority: z.string(), access: z.literal('user_scoped'), readAt: z.string() }) });

export const READ_TOOLS = Object.freeze({
  get_brain_dump: { title: 'Get Brain Dump', description: 'Read recent captures and their current dispositions.',
    inputSchema: z.strictObject({}), outputSchema: output('get_brain_dump', z.strictObject({ captures: z.array(capture) })) },
  get_today: { title: 'Get Today', description: 'Read the authoritative current plan target and derived attention. Unknown actuals stay unknown.',
    inputSchema: z.strictObject({}), outputSchema: output('get_today', z.strictObject({ date: z.string(), timezone: z.string(),
      plan, attention: z.array(row), notes: z.array(z.string()) })) },
  get_plan: { title: 'Get Plan', description: 'Read the current authoritative plan, or an exact target ID returned by a prior read.',
    inputSchema: z.strictObject({ target: targetInput.optional() }), outputSchema: output('get_plan', z.strictObject({ plan })) },
  get_item: { title: 'Get Item', description: 'Read a capture or plan item by stable ID. Plan items require the exact target ID.',
    inputSchema: z.discriminatedUnion('source', [
      z.strictObject({ source: z.literal('brain_dump'), id: z.string().min(1).max(500) }),
      z.strictObject({ source: z.literal('plan'), id: z.string().min(1).max(500), target: targetInput }),
    ]), outputSchema: output('get_item', z.union([
      z.strictObject({ source: z.literal('brain_dump'), item: capture }),
      z.strictObject({ source: z.literal('plan'), target, item }),
      z.strictObject({ source: z.literal('plan'), target, state: z.enum(['tombstoned', 'relocated', 'inactive']),
        itemId: z.string(), destinationTargetId: z.string().optional() }),
    ])) },
  get_intelligence: { title: 'Get Intelligence', description: 'Read deterministic Intelligence V1 interpretation, with evidence and unknowns identified.',
    inputSchema: z.strictObject({}), outputSchema: output('get_intelligence', z.strictObject({ view })) },
});

const ACTION_ID = /^act1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPTURED_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
// Backend answers that are definite facts (nothing was or will be written by this action); everything else is unknown.
const DEFINITIVE_WRITE_CODES = new Set(['INVALID_INPUT', 'AUTH_REQUIRED', 'FORBIDDEN', 'CONFLICT',
  'IDEMPOTENCY_CONFLICT', 'DOMAIN_LIMIT', 'NOT_FOUND', 'NONEXISTENT_TIME', 'PAST_TARGET_IMMUTABLE', 'STALE_REVISION']);
const unknownWrite = (parameters, revised = false) => z.strictObject({ outcome: z.literal('unknown'), code: z.enum(['PENDING_UNKNOWN', 'RETRYABLE_TRANSPORT']),
  mayHaveCommitted: z.literal(true), retry: z.strictObject({ actionId: z.string(), capturedAt: z.string(),
    ...(revised ? { expectedRevision: z.string() } : {}), parameters, newActionIdAllowed: z.literal(false) }) });
const planCreateParameters = z.strictObject({ target: targetInput, title: z.string().trim().min(1).max(200),
  when: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), whenDayOffset: z.union([z.literal(0), z.literal(1)]).optional(),
  whenTz: z.string().min(1).max(64).optional(), durationMinutes: z.number().int().min(1).max(720).optional() });
const schedule = z.strictObject({ when: z.string(), whenDayOffset: z.number().int(), whenTz: z.string(),
  durationMinutes: z.number().nullable(), startAt: z.string(), endAt: z.string().nullable() });
// TASK-012: one existing plan item, named by its stable itemId + exact plan target + the item revision a read returned.
const ITEM_REVISION = /^rev1:[A-Za-z0-9_-]{43}$/;
const calendarTarget = z.strictObject({ store: z.literal('calendar'), id: z.string().regex(/^cal1:\d{4}-\d{2}-\d{2}$/) });
const itemRef = { target: calendarTarget, itemId: z.string().min(1).max(200) };
const wallTime = z.strictObject({ when: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), whenTz: z.string().min(1).max(64),
  whenDayOffset: z.union([z.literal(0), z.literal(1)]).optional() });
const mutationParameters = Object.freeze({
  plan_set_completion: z.strictObject({ ...itemRef, completed: z.boolean() }),
  plan_edit: z.strictObject({ ...itemRef, title: z.string().trim().min(1).max(200).optional(), time: wallTime.optional(),
    durationMinutes: z.number().int().min(1).max(720).optional(), clearSchedule: z.literal(true).optional() }),
  plan_move: z.strictObject({ ...itemRef, destination: calendarTarget, time: wallTime.optional(), durationMinutes: z.number().int().min(1).max(720).optional() }),
  plan_delete: z.strictObject(itemRef),
});
const planRef = z.strictObject({ store: z.literal('calendar'), id: z.string(), date: z.string() });
const mutationResult = kind => output(kind, z.strictObject({ actionId: z.string(), itemId: z.string(), operation: z.literal(kind), target: planRef,
  ...(kind === 'plan_move' ? { destination: planRef } : {}),
  item: z.strictObject({ completed: z.boolean(), deleted: z.boolean(), schedule: schedule.nullable() }),
  revision: z.string(), previousRevision: z.string(), changed: z.boolean(), idempotentReplay: z.boolean() }));
const REVISION_RULES = ' Name the item by itemId and its plan target exactly as get_plan/get_item returned them, and pass that read\'s item revision as expectedRevision. STALE_REVISION means the item changed since that read: read it again and confirm with the user; a new attempt then uses a NEW actionId. An unknown outcome may already be committed: retry with the same actionId, capturedAt, expectedRevision and parameters, never a new actionId.';
const mutationTool = (kind, { title, description, destructive = false }) => ({ scope: PLAN_WRITE_SCOPE, noun: 'plan change', title,
  description: description + REVISION_RULES, destructive, revised: true,
  inputSchema: mutationParameters[kind].extend({ actionId: z.string().regex(ACTION_ID), capturedAt: z.string().regex(CAPTURED_AT),
    expectedRevision: z.string().regex(ITEM_REVISION) }),
  parameters: ({ actionId: _actionId, capturedAt: _capturedAt, expectedRevision: _expectedRevision, ...rest }) => rest,
  outputSchema: z.union([mutationResult(kind), unknownWrite(mutationParameters[kind], true)]) });

export const WRITE_TOOLS = Object.freeze({
  brain_dump_add: { scope: WRITE_SCOPE, noun: 'capture', title: 'Add Brain Dump capture', description: 'Create one untriaged Brain Dump capture. An unknown outcome may already be committed; retry with the same actionId, capturedAt and text.',
    inputSchema: z.strictObject({ actionId: z.string().regex(ACTION_ID), capturedAt: z.string().regex(CAPTURED_AT),
      text: z.string().trim().min(1).max(1000) }),
    parameters: ({ text }) => ({ text }),
    outputSchema: z.union([output('brain_dump_add', z.strictObject({ actionId: z.string(), captureId: z.string(),
      text: z.string(), status: z.string(), createdAt: z.string(), revision: z.string(), idempotentReplay: z.boolean() })),
    unknownWrite(z.strictObject({ text: z.string() }))]) },
  plan_create: { scope: PLAN_WRITE_SCOPE, noun: 'plan task', title: 'Add task to a plan day',
    description: 'Create ONE new task on an exact calendar-day plan (target from get_today/get_plan, e.g. cal1:YYYY-MM-DD). Resolve natural language first: pass an explicit HH:MM start with its IANA timezone (whenDayOffset 1 = after midnight of the plan date) and optional duration, or omit all time fields for an anytime task. It never edits, moves, completes or deletes an existing task (plan_edit, plan_move, plan_set_completion and plan_delete do). An unknown outcome may already be committed; retry with the same actionId, capturedAt and parameters.',
    inputSchema: planCreateParameters.extend({ actionId: z.string().regex(ACTION_ID), capturedAt: z.string().regex(CAPTURED_AT) }),
    parameters: ({ actionId: _actionId, capturedAt: _capturedAt, ...rest }) => rest,
    outputSchema: z.union([output('plan_create', z.strictObject({ actionId: z.string(), itemId: z.string(),
      target: z.strictObject({ store: z.literal('calendar'), id: z.string(), date: z.string() }), schedule: schedule.nullable(),
      createdAt: z.string(), revision: z.string(), idempotentReplay: z.boolean() })), unknownWrite(planCreateParameters)]) },
  plan_set_completion: mutationTool('plan_set_completion', { title: 'Mark a plan task done or not done',
    description: 'Mark ONE existing plan task done (completed: true) or not done again (completed: false). Already in that state is a no-op success. A task on an ended day can only be completed if it is scheduled to happen today.' }),
  plan_edit: mutationTool('plan_edit', { title: 'Edit a plan task',
    description: 'Change ONE existing task within the SAME plan day: a new title, a new explicit HH:MM start with its IANA timezone (whenDayOffset 1 = after midnight of the plan date), a new durationMinutes, or clearSchedule: true to make it an anytime task. Omitted fields stay exactly as they are. It never moves the task to another day (use plan_move), completes or deletes it.' }),
  plan_move: mutationTool('plan_move', { title: 'Move a plan task to another day',
    description: 'Move ONE existing task to another calendar-day plan (destination cal1:YYYY-MM-DD), keeping the same task identity; optionally give a new explicit time and/or durationMinutes, judged on the destination date. Tasks added from ChatGPT move like any other (same task, same itemId at the destination). Tasks promoted from Brain Dump, tasks recovered from an earlier day, and a ChatGPT task returning to a day it already left cannot be moved yet (DOMAIN_LIMIT): say so instead of deleting and re-adding.' }),
  plan_delete: mutationTool('plan_delete', { title: 'Remove a plan task', destructive: true,
    description: 'Remove ONE existing task from its plan. Confirm with the user which task first. The task is tombstoned (it stops appearing), never physically erased, and cannot be restored by this tool.' }),
});

function unknownWriteResult(spec, parameters, code) {
  const result = { outcome: 'unknown', code, mayHaveCommitted: true,
    retry: { actionId: parameters.actionId, capturedAt: parameters.capturedAt,
      ...(spec.revised ? { expectedRevision: parameters.expectedRevision } : {}),
      parameters: spec.parameters(parameters), newActionIdAllowed: false } };
  const fields = spec.scope === WRITE_SCOPE ? 'text' : spec.revised ? 'expectedRevision and parameters' : 'parameters';
  return { structuredContent: result, content: [{ type: 'text',
    text: `${code}: The ${spec.noun} may already ${spec.revised ? 'be applied' : 'exist'}. Retry with the same actionId, capturedAt and ${fields}. Keep the actionId unchanged.` }], isError: true };
}

function requireContext(env, ctx, requiredScope, nowSeconds = Math.floor(Date.now() / 1000)) {
  const subject = env.CHRONASENSE_OWNER_SUBJECT;
  if (typeof subject !== 'string' || !subject || !/^[\x21-\x2b\x2d-\x7e]{1,256}$/.test(subject)) throw new Error('owner-not-configured');
  const auth = ctx?.auth;
  const props = ctx?.props;
  if (!auth || !props || typeof auth.token !== 'string' || !auth.token || auth.audience !== RESOURCE
      || props.resource !== RESOURCE || props.issuer !== ISSUER || auth.userId !== subject
      || props.ownerSubject !== subject || !Number.isFinite(props.notBefore) || props.notBefore > nowSeconds
      || !Number.isFinite(auth.expiresAt) || auth.expiresAt <= nowSeconds) throw new Error('invalid-token');
  if (!Array.isArray(auth.scope) || !auth.scope.includes(requiredScope) || (requiredScope !== READ_SCOPE && !auth.scope.includes(READ_SCOPE))
    || auth.scope.some(scope => !KNOWN_SCOPES.includes(scope))
    || new Set(auth.scope).size !== auth.scope.length) throw new Error('insufficient-scope');
  // Forward only the one scope this call needs: the backend re-checks it, and never sees broader grants.
  return { subject, scopes: [requiredScope] };
}

export const requireReadContext = (env, ctx, nowSeconds) => requireContext(env, ctx, READ_SCOPE, nowSeconds);
export const requireWriteContext = (env, ctx, nowSeconds, scope = WRITE_SCOPE) => requireContext(env, ctx, scope, nowSeconds);

function challenge(error, requiredScope = READ_SCOPE) {
  const scope = error?.message === 'insufficient-scope';
  const message = scope ? `The ${requiredScope} scope is required.` : 'Authentication is required.';
  return { content: [{ type: 'text', text: message }], isError: true,
    _meta: { 'mcp/www_authenticate': [`Bearer resource_metadata="${RESOURCE_METADATA}", error="${scope ? 'insufficient_scope' : 'invalid_token'}", scope="${requiredScope === READ_SCOPE ? READ_SCOPE : `${READ_SCOPE} ${requiredScope}`}"`] } };
}

async function actorRef(subject, cryptoImpl = globalThis.crypto) {
  const bytes = new TextEncoder().encode(`chronasense-action-actor-v1\n${subject}`);
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  return `actor1:${btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export function createReadServer(env = {}, deps = {}, ctx = {}) {
  const server = new McpServer({ name: 'chronasense-private-reads', version: '1.0.0' });
  for (const [kind, spec] of Object.entries(READ_TOOLS)) {
    server.registerTool(kind, { ...spec, _meta: { securitySchemes: SCHEMES }, annotations: ANNOTATIONS }, async parameters => {
      let identity;
      try { identity = requireReadContext(env, ctx, deps.nowSeconds); }
      catch (error) { return challenge(error); }
      try {
        const response = await (deps.queryActionApi || queryActionApi)(env, { ...identity, kind, parameters }, deps);
        spec.outputSchema.parse(response);
        return { structuredContent: response, content: [{ type: 'text', text: JSON.stringify(response) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: error?.code ? `${error.code}: ${error.message}` : 'ChronaSense data could not be read.' }], isError: true };
      }
    });
  }
  for (const [kind, spec] of Object.entries(WRITE_TOOLS)) {
    const { scope, noun: _noun, parameters: toParameters, destructive = false, revised = false, ...definition } = spec;
    server.registerTool(kind, { ...definition, _meta: { securitySchemes: writeSchemes(scope) },
      annotations: { readOnlyHint: false, destructiveHint: destructive, openWorldHint: false } }, async parameters => {
      let identity;
      try { identity = requireWriteContext(env, ctx, deps.nowSeconds, scope); }
      catch (error) { return challenge(error, scope); }
      try {
        const command = { contractVersion: 1, actionId: parameters.actionId, kind,
          parameters: toParameters(parameters), expectedRevision: revised ? parameters.expectedRevision : null,
          actionProvenance: { version: 1, sourceKind: 'chatgpt_plugin', actionId: parameters.actionId,
            actorRef: await actorRef(identity.subject, deps.cryptoImpl), capturedAt: parameters.capturedAt } };
        const response = await (deps.commandActionApi || commandActionApi)(env, { ...identity, command }, deps);
        spec.outputSchema.parse(response);
        return { structuredContent: response, content: [{ type: 'text', text: JSON.stringify(response) }] };
      } catch (error) {
        if (!DEFINITIVE_WRITE_CODES.has(error?.code)) {
          return unknownWriteResult(spec, parameters, error?.code === 'RETRYABLE_TRANSPORT' ? error.code : 'PENDING_UNKNOWN');
        }
        const details = error?.details ? ` ${JSON.stringify(error.details)}` : '';
        return { content: [{ type: 'text', text: error?.code ? `${error.code}: ${error.message}${details}` : `ChronaSense ${spec.noun} could not be ${revised ? 'applied' : 'created'}.` }], isError: true };
      }
    });
  }
  return server;
}

export function validateMcpRequestOrigin(request) {
  return hostHeaderValidationResponse(request, localhostAllowedHostnames().concat(HOST))
    || originValidationResponse(request, localhostAllowedOrigins().concat(HOST));
}

export async function handleMcpRequest(request, env = {}, deps = {}, ctx = {}) {
  const rejected = validateMcpRequestOrigin(request);
  if (rejected) return rejected;
  const handler = createMcpHandler(() => createReadServer(env, deps, ctx), { legacy: 'stateless', maxRequestBodySize: 8192 });
  return exposeToolScopes(await handler.fetch(request));
}

async function exposeToolScopes(response) {
  const contentType = response.headers.get('Content-Type') || '';
  if (!/application\/json|text\/event-stream/i.test(contentType)) return response;
  const original = await response.clone().text();
  let changed = false;
  const decorate = message => {
    for (const tool of message?.result?.tools || []) if (Object.hasOwn(READ_TOOLS, tool.name) || Object.hasOwn(WRITE_TOOLS, tool.name)) {
      tool.securitySchemes = Object.hasOwn(READ_TOOLS, tool.name) ? SCHEMES : writeSchemes(WRITE_TOOLS[tool.name].scope);
      changed = true;
    }
    return message;
  };
  let body;
  try {
    body = /text\/event-stream/i.test(contentType)
      ? original.split(/(\r?\n)/).map(line => line.startsWith('data: ') ? `data: ${JSON.stringify(decorate(JSON.parse(line.slice(6))))}` : line).join('')
      : JSON.stringify(decorate(JSON.parse(original)));
  } catch { return response; }
  if (!changed) return response;
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
