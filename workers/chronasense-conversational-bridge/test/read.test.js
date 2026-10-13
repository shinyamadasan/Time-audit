import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { handleMcpRequest, PLAN_WRITE_SCOPE, READ_SCOPE, READ_TOOLS, WRITE_SCOPE, WRITE_TOOLS, RESOURCE, ISSUER } from '../src/mcp.js';
import { COMMAND_TIMEOUT_MS, commandActionApi, queryActionApi } from '../src/action-client.js';
import { actionActorRef } from '../../../functions/src/envelope.js';
import { harness, KEY, OWNER, NOW_MS, capture } from '../../../functions/test/support.js';

const subject = OWNER.ownerSubject;
const env = { CHRONASENSE_OWNER_SUBJECT: subject,
  CHRONASENSE_ACTION_API_URL: 'https://example.test/v1/query',
  CHRONASENSE_WORKER_HMAC_KEY_ID: 'test-key-1',
  CHRONASENSE_WORKER_HMAC_KEY_HEX: KEY.toString('hex') };
const nowSeconds = Math.floor(NOW_MS / 1000);

const ctx = (overrides = {}) => ({
  auth: { token: 'fixture-token', audience: RESOURCE, expiresAt: nowSeconds + 300, scope: [READ_SCOPE], userId: subject,
    ...overrides.auth },
  props: { ownerSubject: subject, resource: RESOURCE, issuer: ISSUER, notBefore: nowSeconds - 1,
    ...overrides.props },
});

function request(method, params = {}) {
  return new Request('https://localhost/mcp', { method: 'POST', headers: { Host: 'localhost',
    Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}

async function message(response) {
  const body = await response.text();
  const line = body.split(/\r?\n/).find(value => value.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : body);
}

test('MCP route preserves the five reads and exposes exactly two scoped create tools (Brain Dump, plan task)', async () => {
  const response = await handleMcpRequest(request('tools/list'), env, { nowSeconds }, ctx());
  assert.equal(response.status, 200);
  const tools = (await message(response)).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), [...Object.keys(READ_TOOLS), ...Object.keys(WRITE_TOOLS)]);
  for (const tool of tools.filter(tool => Object.hasOwn(READ_TOOLS, tool.name))) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: [READ_SCOPE] }]);
    assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
  }
  const write = tools.find(tool => tool.name === 'brain_dump_add');
  assert.equal(write.annotations.readOnlyHint, false);
  assert.equal(write.annotations.destructiveHint, false);
  assert.deepEqual(write.securitySchemes, [{ type: 'oauth2', scopes: [READ_SCOPE, WRITE_SCOPE] }]);
  const plan = tools.find(tool => tool.name === 'plan_create');
  assert.equal(plan.annotations.readOnlyHint, false);
  assert.equal(plan.annotations.destructiveHint, false);
  assert.deepEqual(plan.securitySchemes, [{ type: 'oauth2', scopes: [READ_SCOPE, PLAN_WRITE_SCOPE] }]);
  assert.deepEqual(plan._meta.securitySchemes, plan.securitySchemes);
  assert.deepEqual(Object.keys(WRITE_TOOLS), ['brain_dump_add', 'plan_create']);
  assert.ok(!tools.some(tool => /update|delete|reschedule|complete|move|archive|query_path|execute|raw/.test(tool.name)));
});

test('MCP scope/owner/resource checks refuse invocation before reaching the backend', async () => {
  let calls = 0;
  const deps = { nowSeconds, queryActionApi: async () => { calls++; throw new Error('should not call'); } };
  const input = request('tools/call', { name: 'get_plan', arguments: {} });
  for (const context of [ctx({ auth: { scope: [] } }), ctx({ auth: { userId: 'wrong' } }),
    ctx({ auth: { audience: 'https://other.test/mcp' } }), ctx({ props: { ownerSubject: 'wrong' } }),
    ctx({ auth: { expiresAt: nowSeconds } })]) {
    const answer = await message(await handleMcpRequest(input.clone(), env, deps, context));
    assert.equal(answer.result.isError, true);
  }
  assert.equal(calls, 0);
});

test('MCP tool maps only typed arguments to one Action API read; no generic path or write tool is accepted', async () => {
  const calls = [];
  const deps = { nowSeconds, queryActionApi: async (_env, query) => {
    calls.push(query);
    return { contractVersion: 1, requestId: 'fixture', kind: query.kind,
      result: { plan: { target: { store: 'calendar', id: 'cal1:2026-10-09', date: '2026-10-09', timezone: 'UTC',
        startMs: 1, endMs: 2, boundaryTime: '00:00' }, items: [], state: 'absent', revision: 'rev1:x' } },
      authority: { authority: 'plan_authority', access: 'user_scoped', readAt: '2026-10-09T00:00:00.000Z' } };
  } };
  const answer = await message(await handleMcpRequest(request('tools/call', { name: 'get_plan', arguments: {} }), env, deps, ctx()));
  assert.equal(answer.result.isError, undefined, JSON.stringify(answer));
  assert.deepEqual(calls, [{ subject, scopes: [READ_SCOPE], kind: 'get_plan', parameters: {} }]);
  const forged = await message(await handleMcpRequest(request('tools/call', { name: 'get_plan', arguments: { path: 'rooms/uid_victim' } }), env, deps, ctx()));
  assert.equal(forged.result.isError, true);
  const write = await message(await handleMcpRequest(request('tools/call', { name: 'plan_complete', arguments: {} }), env, deps, ctx()));
  assert.equal(write.error.code, -32602);
  assert.equal(calls.length, 1);
});

test('Brain Dump create requires step-up scope and sends one structured action with verified actor provenance', async () => {
  const actionId = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const args = { actionId, capturedAt: '2026-10-12T12:00:00.000Z', text: 'buy milk' };
  const calls = [];
  const deps = { nowSeconds, cryptoImpl: webcrypto, commandActionApi: async (_env, call) => {
    calls.push(call);
    return { contractVersion: 1, requestId: 'fixture', kind: 'brain_dump_add',
      result: { actionId, captureId: `bdc1_${actionId.slice(5)}`, text: 'buy milk', status: 'untriaged',
        createdAt: args.capturedAt, revision: 'rev1:x', idempotentReplay: false },
      authority: { authority: 'brain_dump_capture', access: 'user_scoped', readAt: args.capturedAt } };
  } };
  const call = () => request('tools/call', { name: 'brain_dump_add', arguments: args });
  const denied = await message(await handleMcpRequest(call(), env, deps, ctx()));
  assert.equal(denied.result.isError, true);
  assert.match(JSON.stringify(denied), /insufficient_scope/);
  assert.equal(calls.length, 0);
  const permitted = await message(await handleMcpRequest(call(), env, deps,
    ctx({ auth: { scope: [READ_SCOPE, WRITE_SCOPE] } })));
  assert.equal(permitted.result.isError, undefined, JSON.stringify(permitted));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].scopes, [WRITE_SCOPE]);
  assert.equal(calls[0].command.actionProvenance.actorRef, actionActorRef(subject));
  assert.deepEqual(calls[0].command.parameters, { text: 'buy milk' });
});

test('Worker command HMAC signs /v1/command, write scope and the stable action payload', async () => {
  const actionId = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const records = new Map();
  const backend = harness({ domain: {
    async createCaptureIfAbsent(_identity, id, _action, record) { if (records.has(id)) return 'exists'; records.set(id, record); return 'created'; },
    async readCapture(_identity, id) { return records.get(id) ?? null; },
  } });
  const command = { contractVersion: 1, actionId, kind: 'brain_dump_add', parameters: { text: 'buy milk' },
    expectedRevision: null, actionProvenance: { version: 1, sourceKind: 'chatgpt_plugin', actionId,
      actorRef: actionActorRef(subject), capturedAt: '2026-10-12T12:00:00.000Z' } };
  const fetchImpl = async (url, init) => {
    assert.equal(new URL(url).pathname, '/v1/command');
    const result = await backend.handle({ method: init.method, path: new URL(url).pathname,
      rawHeaders: Object.entries(init.headers).flat(), rawBody: new TextEncoder().encode(init.body) });
    return new Response(result.payload, { status: result.status });
  };
  const answer = await commandActionApi(env, { subject, scopes: [WRITE_SCOPE], command },
    { fetchImpl, cryptoImpl: webcrypto, now: () => NOW_MS });
  assert.equal(answer.result.captureId, `bdc1_${actionId.slice(5)}`);
  assert.equal(records.size, 1);
});

test('write timeout after backend commit reports a typed unknown and same-action retry returns one capture', async () => {
  const actionId = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  const args = { actionId, capturedAt: '2026-10-12T12:00:00.000Z', text: 'buy milk' };
  const records = new Map();
  const backend = harness({ domain: {
    async createCaptureIfAbsent(_identity, id, _action, record) { if (!records.has(id)) records.set(id, record); },
    async readCapture(_identity, id) { return records.get(id) ?? null; },
  } });
  let calls = 0;
  const deps = { nowSeconds, cryptoImpl: webcrypto, now: () => NOW_MS, fetchImpl: async (url, init) => {
    assert.equal(init.signal?.constructor.name, 'AbortSignal');
    assert.equal(COMMAND_TIMEOUT_MS, 130_000);
    const result = await backend.handle({ method: init.method, path: new URL(url).pathname,
      rawHeaders: Object.entries(init.headers).flat(), rawBody: new TextEncoder().encode(init.body) });
    if (++calls === 1) throw new DOMException('timed out after commit', 'TimeoutError');
    return new Response(result.payload, { status: result.status });
  } };
  const call = () => request('tools/call', { name: 'brain_dump_add', arguments: args });
  const context = ctx({ auth: { scope: [READ_SCOPE, WRITE_SCOPE] } });
  const first = (await message(await handleMcpRequest(call(), env, deps, context))).result;
  assert.equal(first.isError, true);
  assert.equal(first.structuredContent.outcome, 'unknown');
  assert.equal(first.structuredContent.code, 'PENDING_UNKNOWN');
  assert.equal(first.structuredContent.mayHaveCommitted, true);
  assert.deepEqual(first.structuredContent.retry, { actionId, capturedAt: args.capturedAt,
    parameters: { text: args.text }, newActionIdAllowed: false });
  assert.doesNotMatch(JSON.stringify(first), /(?:use|try|mint|create) a new actionId/i);
  const retry = (await message(await handleMcpRequest(call(), env, deps, context))).result;
  assert.equal(retry.isError, undefined, JSON.stringify(retry));
  assert.equal(retry.structuredContent.result.idempotentReplay, true);
  assert.equal(records.size, 1);
});

test('malformed success after commit is unknown; backend unknown stays typed; definite rejection stays definite', async () => {
  const args = { actionId: 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4',
    capturedAt: '2026-10-12T12:00:00.000Z', text: 'buy milk' };
  const context = ctx({ auth: { scope: [READ_SCOPE, WRITE_SCOPE] } });
  const call = () => request('tools/call', { name: 'brain_dump_add', arguments: args });
  const records = new Map();
  const backend = harness({ domain: {
    async createCaptureIfAbsent(_identity, id, _action, record) { if (!records.has(id)) records.set(id, record); },
    async readCapture(_identity, id) { return records.get(id) ?? null; },
  } });
  for (const mode of ['bad-json', 'bad-output', 'PENDING_UNKNOWN', 'RETRYABLE_TRANSPORT', 'INVALID_INPUT']) {
    const deps = { nowSeconds, cryptoImpl: webcrypto, now: () => NOW_MS, fetchImpl: async (url, init) => {
      const { requestId } = JSON.parse(init.body);
      if (mode === 'bad-json' || mode === 'bad-output') {
        const committed = await backend.handle({ method: init.method, path: new URL(url).pathname,
          rawHeaders: Object.entries(init.headers).flat(), rawBody: new TextEncoder().encode(init.body) });
        assert.equal(committed.status, 200);
      }
      if (mode === 'bad-json') return new Response('{');
      if (mode === 'bad-output') return new Response(JSON.stringify({ contractVersion: 1, requestId,
        kind: 'brain_dump_add', result: {}, authority: {} }));
      return new Response(JSON.stringify({ contractVersion: 1, requestId,
        error: { code: mode, message: 'Safe backend response.', retryability: 'not_retryable' } }),
      { status: mode === 'INVALID_INPUT' ? 400 : 503 });
    } };
    const result = (await message(await handleMcpRequest(call(), env, deps, context))).result;
    assert.equal(result.isError, true);
    if (mode === 'INVALID_INPUT') {
      assert.equal(result.structuredContent, undefined);
      assert.match(result.content[0].text, /^INVALID_INPUT:/);
    } else {
      assert.equal(result.structuredContent.outcome, 'unknown', mode);
      assert.equal(result.structuredContent.code, mode === 'RETRYABLE_TRANSPORT' ? mode : 'PENDING_UNKNOWN');
      assert.equal(result.structuredContent.retry.actionId, args.actionId);
      assert.equal(result.structuredContent.retry.newActionIdAllowed, false);
    }
  }
  assert.equal(records.size, 1, 'both unreadable post-commit responses refer to one deterministic capture');
});

test('Worker HMAC exactly matches the existing Action API pipeline, including subject and scope', async () => {
  const backend = harness({ rooms: { [`uid_${OWNER.ownerFirebaseUid}`]: { brainDump: { cap_1: capture('cap_1') } } } });
  const fetchImpl = async (url, init) => {
    assert.equal(url, env.CHRONASENSE_ACTION_API_URL);
    const headers = Object.entries(init.headers).flat();
    const result = await backend.handle({ method: init.method, path: new URL(url).pathname,
      rawHeaders: headers, rawBody: new TextEncoder().encode(init.body) });
    return new Response(result.payload, { status: result.status });
  };
  const answer = await queryActionApi(env, { subject, scopes: [READ_SCOPE], kind: 'get_brain_dump', parameters: {} },
    { fetchImpl, cryptoImpl: webcrypto, now: () => NOW_MS });
  assert.equal(answer.result.captures[0].captureId, 'cap_1');
  assert.deepEqual(backend.domain.reads, [{ roomId: `uid_${OWNER.ownerFirebaseUid}`, collection: 'brainDump' }]);
});

test('invalid Worker config and wrong backend response identity fail closed', async () => {
  const args = { subject, scopes: [READ_SCOPE], kind: 'get_brain_dump', parameters: {} };
  await assert.rejects(queryActionApi({ ...env, CHRONASENSE_WORKER_HMAC_KEY_HEX: 'bad' }, args), /not configured/);
  await assert.rejects(queryActionApi(env, args, { cryptoImpl: webcrypto, now: () => NOW_MS,
    fetchImpl: async () => new Response(JSON.stringify({ contractVersion: 1, requestId: 'different', kind: 'get_brain_dump', result: {}, authority: {} })) }), /does not match/);
  await assert.rejects(queryActionApi(env, args, { cryptoImpl: webcrypto, now: () => NOW_MS,
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(65_537));
      controller.close();
    } })) }), /exceeds the contract limit/);
});
