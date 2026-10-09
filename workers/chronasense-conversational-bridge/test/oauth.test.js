import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, exportJWK, SignJWT } from 'jose';

import { createOAuthWorker, handleDefaultRequest, OAUTH_PROVIDER_CONFIG,
  rejectInvalidTokenResource, requireAccessSubject } from '../src/index.js';
import { ISSUER, READ_SCOPE, RESOURCE } from '../src/mcp.js';

const NOW = 1_800_000_000;
const ACCESS_ISSUER = 'https://fixture.cloudflareaccess.com';
const OWNER_SUB = 'fixture-access-sub';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = 'fixture-key';
publicJwk.alg = 'RS256';
const jwks = createLocalJWKSet({ keys: [publicJwk] });
const env = { ACCESS_TEAM_DOMAIN: ACCESS_ISSUER, ACCESS_POLICY_AUD: 'fixture-audience',
  CHRONASENSE_OWNER_SUBJECT: OWNER_SUB };

async function assertion(overrides = {}) {
  return new SignJWT({ type: 'app', sub: OWNER_SUB, email: 'irrelevant@example.test',
    iss: ACCESS_ISSUER, aud: ['fixture-audience'], nbf: NOW - 5, exp: NOW + 300, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(privateKey);
}
const deps = { jwks, currentDate: new Date(NOW * 1000) };

test('OAuth configuration is CIMD-enabled, DCR-disabled, read-only and resource-bound', () => {
  let options;
  createOAuthWorker(class { constructor(value) { options = value; } });
  assert.equal(options.clientIdMetadataDocumentEnabled, true);
  assert.equal(options.clientRegistrationEndpoint, undefined);
  assert.equal(options.apiRoute, '/mcp');
  assert.equal(options.authorizeEndpoint, '/authorize');
  assert.equal(options.tokenEndpoint, '/oauth/token');
  assert.deepEqual(options.scopesSupported, [READ_SCOPE]);
  assert.deepEqual(options.requiredScopes, [READ_SCOPE]);
  assert.equal(options.resourceMetadata.resource, RESOURCE);
  assert.equal(options.allowTokenExchangeGrant, false);
  assert.equal(ISSUER, 'https://chronasense-conversational-bridge.shinyamadasan.workers.dev');
  assert.equal(OAUTH_PROVIDER_CONFIG.clientRegistrationEndpoint, undefined);
});

test('Access JWT sub is the sole owner identity; email never chooses the account', async () => {
  const request = new Request(`${ISSUER}/authorize`, { headers: { 'Cf-Access-Jwt-Assertion': await assertion({ email: 'changed@example.test' }) } });
  assert.equal(await requireAccessSubject(request, env, deps), OWNER_SUB);
  await assert.rejects(requireAccessSubject(new Request(`${ISSUER}/authorize`, { headers: {
    'Cf-Access-Jwt-Assertion': await assertion({ sub: 'other', email: OWNER_SUB }) } }), env, deps));
  await assert.rejects(requireAccessSubject(new Request(`${ISSUER}/authorize`, { headers: {
    'Cf-Access-Jwt-Assertion': await assertion({ aud: ['wrong'] }) } }), env, deps));
  await assert.rejects(requireAccessSubject(request, { ...env, CHRONASENSE_OWNER_SUBJECT: '' }, deps));
});

test('Access gates /authorize and read consent; resource and scope are exact', async () => {
  const unauthenticated = await handleDefaultRequest(new Request(`${ISSUER}/authorize`), env, deps);
  assert.equal(unauthenticated.status, 401);
  const consent = {
    parseAuthRequest: async () => ({ scope: [READ_SCOPE], resource: RESOURCE }),
    describeConsent: async () => ({ clientName: 'Fixture client', redirectHost: 'chatgpt.com' }),
    beginConsent: async () => ({ handle: 'opaque', headers: new Headers() }),
  };
  const valid = new Request(`${ISSUER}/authorize?resource=${encodeURIComponent(RESOURCE)}`, {
    headers: { 'Cf-Access-Jwt-Assertion': await assertion() } });
  const result = await handleDefaultRequest(valid, { ...env, OAUTH_PROVIDER: consent }, deps);
  assert.equal(result.status, 200);
  assert.match(await result.text(), /read-only access/);
  const wrongResource = await handleDefaultRequest(new Request(`${ISSUER}/authorize?resource=https%3A%2F%2Fother.test%2Fmcp`, {
    headers: { 'Cf-Access-Jwt-Assertion': await assertion() } }), { ...env, OAUTH_PROVIDER: consent }, deps);
  assert.equal(wrongResource.status, 400);
  const wrongScope = await handleDefaultRequest(valid, { ...env, OAUTH_PROVIDER: {
    ...consent, parseAuthRequest: async () => ({ scope: ['chronasense:plan.write'], resource: RESOURCE }) } }, deps);
  assert.equal(wrongScope.status, 400);
});

test('token grant requires the canonical resource but no Access assertion', async () => {
  const form = resource => new Request(`${ISSUER}/oauth/token`, { method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', resource }) });
  assert.equal((await rejectInvalidTokenResource(form('https://other.test/mcp'))).status, 400);
  assert.equal(await rejectInvalidTokenResource(form(RESOURCE)), null);
  const oversized = new Request(`${ISSUER}/oauth/token`, { method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', resource: RESOURCE, padding: 'x'.repeat(9000) }) });
  assert.equal((await rejectInvalidTokenResource(oversized)).status, 413);
});
