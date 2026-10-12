import { McpServer, createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames,
  localhostAllowedOrigins, originValidationResponse } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { commandActionApi, queryActionApi } from './action-client.js';

export const ISSUER = 'https://chronasense-conversational-bridge.shinyamadasan.workers.dev';
export const RESOURCE = `${ISSUER}/mcp`;
export const READ_SCOPE = 'chronasense:read';
export const WRITE_SCOPE = 'chronasense:brain-dump.write';
const RESOURCE_METADATA = `${ISSUER}/.well-known/oauth-protected-resource/mcp`;
const SCHEMES = [{ type: 'oauth2', scopes: [READ_SCOPE] }];
const WRITE_SCHEMES = [{ type: 'oauth2', scopes: [READ_SCOPE, WRITE_SCOPE] }];
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
const DEFINITIVE_WRITE_CODES = new Set(['INVALID_INPUT', 'AUTH_REQUIRED', 'FORBIDDEN', 'CONFLICT',
  'IDEMPOTENCY_CONFLICT', 'DOMAIN_LIMIT']);
const unknownWrite = z.strictObject({ outcome: z.literal('unknown'), code: z.enum(['PENDING_UNKNOWN', 'RETRYABLE_TRANSPORT']),
  mayHaveCommitted: z.literal(true), retry: z.strictObject({ actionId: z.string(), capturedAt: z.string(),
    parameters: z.strictObject({ text: z.string() }), newActionIdAllowed: z.literal(false) }) });
export const WRITE_TOOLS = Object.freeze({
  brain_dump_add: { title: 'Add Brain Dump capture', description: 'Create one untriaged Brain Dump capture. An unknown outcome may already be committed; retry with the same actionId, capturedAt and text.',
    inputSchema: z.strictObject({ actionId: z.string().regex(ACTION_ID), capturedAt: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      text: z.string().trim().min(1).max(1000) }),
    outputSchema: z.union([output('brain_dump_add', z.strictObject({ actionId: z.string(), captureId: z.string(),
      text: z.string(), status: z.string(), createdAt: z.string(), revision: z.string(), idempotentReplay: z.boolean() })), unknownWrite]) },
});

function unknownWriteResult(parameters, code) {
  const result = { outcome: 'unknown', code, mayHaveCommitted: true,
    retry: { actionId: parameters.actionId, capturedAt: parameters.capturedAt,
      parameters: { text: parameters.text }, newActionIdAllowed: false } };
  return { structuredContent: result, content: [{ type: 'text',
    text: `${code}: The capture may already exist. Retry with the same actionId, capturedAt and text. Keep the actionId unchanged.` }], isError: true };
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
  if (!Array.isArray(auth.scope) || !auth.scope.includes(requiredScope) || (requiredScope === WRITE_SCOPE && !auth.scope.includes(READ_SCOPE))
    || auth.scope.some(scope => ![READ_SCOPE, WRITE_SCOPE].includes(scope))
    || new Set(auth.scope).size !== auth.scope.length) throw new Error('insufficient-scope');
  return { subject, scopes: requiredScope === READ_SCOPE ? [READ_SCOPE] : [WRITE_SCOPE] };
}

export const requireReadContext = (env, ctx, nowSeconds) => requireContext(env, ctx, READ_SCOPE, nowSeconds);
export const requireWriteContext = (env, ctx, nowSeconds) => requireContext(env, ctx, WRITE_SCOPE, nowSeconds);

function challenge(error, requiredScope = READ_SCOPE) {
  const scope = error?.message === 'insufficient-scope';
  const message = scope ? `The ${requiredScope} scope is required.` : 'Authentication is required.';
  return { content: [{ type: 'text', text: message }], isError: true,
    _meta: { 'mcp/www_authenticate': [`Bearer resource_metadata="${RESOURCE_METADATA}", error="${scope ? 'insufficient_scope' : 'invalid_token'}", scope="${requiredScope === WRITE_SCOPE ? `${READ_SCOPE} ${WRITE_SCOPE}` : READ_SCOPE}"`] } };
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
    server.registerTool(kind, { ...spec, _meta: { securitySchemes: WRITE_SCHEMES },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async parameters => {
      let identity;
      try { identity = requireWriteContext(env, ctx, deps.nowSeconds); }
      catch (error) { return challenge(error, WRITE_SCOPE); }
      try {
        const command = { contractVersion: 1, actionId: parameters.actionId, kind,
          parameters: { text: parameters.text }, expectedRevision: null,
          actionProvenance: { version: 1, sourceKind: 'chatgpt_plugin', actionId: parameters.actionId,
            actorRef: await actorRef(identity.subject, deps.cryptoImpl), capturedAt: parameters.capturedAt } };
        const response = await (deps.commandActionApi || commandActionApi)(env, { ...identity, command }, deps);
        spec.outputSchema.parse(response);
        return { structuredContent: response, content: [{ type: 'text', text: JSON.stringify(response) }] };
      } catch (error) {
        if (!DEFINITIVE_WRITE_CODES.has(error?.code)) {
          return unknownWriteResult(parameters, error?.code === 'RETRYABLE_TRANSPORT' ? error.code : 'PENDING_UNKNOWN');
        }
        return { content: [{ type: 'text', text: error?.code ? `${error.code}: ${error.message}` : 'ChronaSense capture could not be created.' }], isError: true };
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
      tool.securitySchemes = Object.hasOwn(READ_TOOLS, tool.name) ? SCHEMES : WRITE_SCHEMES;
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
