import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { handleMcpRequest, READ_SCOPE, READ_TOOLS, RESOURCE, ISSUER } from '../src/mcp.js';
import { queryActionApi } from '../src/action-client.js';
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

test('MCP route lists exactly the five read tools with read-only annotations and per-tool OAuth scope', async () => {
  const response = await handleMcpRequest(request('tools/list'), env, { nowSeconds }, ctx());
  assert.equal(response.status, 200);
  const tools = (await message(response)).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), Object.keys(READ_TOOLS));
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: [READ_SCOPE] }]);
    assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
  }
  assert.ok(!tools.some(tool => /create|update|delete|reschedule|complete|query_path/.test(tool.name)));
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
