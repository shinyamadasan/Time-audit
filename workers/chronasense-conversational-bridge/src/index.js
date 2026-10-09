import { createRemoteJWKSet, jwtVerify } from 'jose';
import { handleMcpRequest, ISSUER, RESOURCE, READ_SCOPE, validateMcpRequestOrigin } from './mcp.js';

const ACCESS_ASSERTION_HEADER = 'Cf-Access-Jwt-Assertion';
const ACCESS_ALGORITHM = 'RS256';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;
const MAX_TOKEN_FORM_BYTES = 8192;

let oauthWorkerPromise = null;
let remoteJwksUrl = null;
let remoteJwks = null;

export const OAUTH_PROVIDER_CONFIG = Object.freeze({
  apiRoute: '/mcp', authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token',
  scopesSupported: [READ_SCOPE], requiredScopes: [READ_SCOPE],
  resourceMetadata: { resource: RESOURCE, authorization_servers: [ISSUER],
    bearer_methods_supported: ['header'], resource_name: 'ChronaSense' },
  clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
  allowTokenExchangeGrant: false
});

export default {
  async fetch(request, env, ctx) {
    const invalidResource = await rejectInvalidTokenResource(request);
    if (invalidResource) return invalidResource;
    if (new URL(request.url).pathname === '/mcp') {
      const rejected = validateMcpRequestOrigin(request);
      if (rejected) return rejected;
    }
    const oauthWorker = await getOAuthWorker();
    return oauthWorker.fetch(request, env, ctx);
  }
};

function getOAuthWorker() {
  if (!oauthWorkerPromise) {
    oauthWorkerPromise = import('@cloudflare/workers-oauth-provider').then(({ default: OAuthProvider }) =>
      createOAuthWorker(OAuthProvider));
  }
  return oauthWorkerPromise;
}

export function createOAuthWorker(OAuthProvider) {
  return new OAuthProvider({ ...OAUTH_PROVIDER_CONFIG,
    apiHandler: { fetch: (request, env, ctx) => handleMcpRequest(request, env, {}, ctx) },
    defaultHandler: { fetch: handleDefaultRequest } });
}

export async function handleDefaultRequest(request, env, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/authorize') return new Response('Not found.', { status: 404 });

  let ownerSubject;
  try {
    ownerSubject = await requireAccessSubject(request, env, deps);
  } catch (error) {
    if (error instanceof AccessConfigurationError) {
      return textResponse('Access identity verification is not configured.', 503);
    }
    return textResponse('Cloudflare Access authentication is required.', 401);
  }

  if (request.method === 'GET' && isIdentityBootstrapRequest(url)) {
    return identityResponse(ownerSubject);
  }
  if (request.method === 'GET') return beginAuthorization(request, env.OAUTH_PROVIDER, ownerSubject);
  if (request.method === 'POST') return finishAuthorization(request, env.OAUTH_PROVIDER, ownerSubject);
  return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, POST' } });
}

function isIdentityBootstrapRequest(url) {
  const params = [...url.searchParams.entries()];
  return params.length === 1 && params[0][0] === 'identity' && params[0][1] === '1';
}

export async function requireAccessSubject(request, env, deps = {}) {
  const token = request.headers.get(ACCESS_ASSERTION_HEADER) || '';
  if (!token) throw new Error('Access assertion missing.');

  const teamDomain = configuredTeamDomain(env);
  const audience = configuredValue(env, 'ACCESS_POLICY_AUD');
  const jwks = deps.jwks || getRemoteJwks(teamDomain);
  const { payload } = await jwtVerify(token, jwks, {
    algorithms: [ACCESS_ALGORITHM],
    issuer: teamDomain,
    audience,
    requiredClaims: ['iss', 'aud', 'sub', 'exp', 'nbf'],
    clockTolerance: 0,
    currentDate: deps.currentDate
  });
  if (typeof payload.sub !== 'string' || !payload.sub || payload.type !== 'app') {
    throw new Error('Access identity is invalid.');
  }
  if (payload.sub !== configuredValue(env, 'CHRONASENSE_OWNER_SUBJECT')) throw new Error('Access subject does not match the configured owner.');
  return payload.sub;
}

function configuredTeamDomain(env) {
  const raw = configuredValue(env, 'ACCESS_TEAM_DOMAIN');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new AccessConfigurationError();
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new AccessConfigurationError();
  }
  return parsed.origin;
}

function configuredValue(env, name) {
  const value = env && typeof env[name] === 'string' ? env[name].trim() : '';
  if (!value) throw new AccessConfigurationError();
  return value;
}

function getRemoteJwks(teamDomain) {
  const url = teamDomain + '/cdn-cgi/access/certs';
  if (!remoteJwks || remoteJwksUrl !== url) {
    remoteJwksUrl = url;
    remoteJwks = createRemoteJWKSet(new URL(url));
  }
  return remoteJwks;
}

class AccessConfigurationError extends Error {}

async function beginAuthorization(request, oauth, ownerSubject) {
  if (!oauth) return textResponse('OAuth provider is unavailable.', 503);
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    requireBootstrapAuthorizationRequest(request, authRequest);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    consent.headers.set('Content-Type', 'text/html; charset=utf-8');
    consent.headers.set('Cache-Control', 'no-store');
    return new Response(consentPage(details, consent.handle, ownerSubject), { status: 200, headers: consent.headers });
  } catch (error) {
    return authorizationErrorResponse(error);
  }
}

async function finishAuthorization(request, oauth, ownerSubject) {
  if (!oauth) return textResponse('OAuth provider is unavailable.', 503);
  let form;
  try {
    const bytes = await readBoundedFormBytes(request);
    form = await new Request(request.url, { method: 'POST',
      headers: { 'Content-Type': request.headers.get('Content-Type') || '' }, body: bytes }).formData();
  } catch (error) {
    if (error instanceof FormBodyTooLarge) return textResponse('Authorization request is too large.', 413);
    return textResponse('The authorization form is invalid.', 400);
  }
  try {
    const handle = String(form.get('handle') || '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const approved = await oauth.approveConsent(request, handle);
    requireApprovedBootstrapRequest(approved.request);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: ownerSubject,
      metadata: {},
      scope: [READ_SCOPE],
      props: { ownerSubject, issuer: ISSUER, resource: RESOURCE, notBefore: Math.floor(Date.now() / 1000) }
    });
    approved.headers.set('Location', redirectTo);
    approved.headers.set('Cache-Control', 'no-store');
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    return authorizationErrorResponse(error);
  }
}

function requireBootstrapAuthorizationRequest(request, authRequest) {
  requireBootstrapScope(authRequest);
  const url = new URL(request.url);
  const resources = url.searchParams.getAll('resource');
  if (resources.length !== 1 || resources[0] !== RESOURCE || authRequest.resource !== RESOURCE) {
    throw invalidAuthorizationRequest(authRequest);
  }
}

function requireApprovedBootstrapRequest(authRequest) {
  requireBootstrapScope(authRequest);
  if (authRequest.resource !== RESOURCE) throw invalidAuthorizationRequest(authRequest);
}

function requireBootstrapScope(authRequest) {
  const requestedScopes = (Array.isArray(authRequest.scope) ? authRequest.scope : [authRequest.scope])
    .flatMap((scope) => typeof scope === 'string' ? scope.split(' ') : [])
    .filter(Boolean);
  const uniqueScopes = [...new Set(requestedScopes)];
  if (uniqueScopes.length !== 1 || uniqueScopes[0] !== READ_SCOPE) throw invalidAuthorizationRequest(authRequest);
}

function invalidAuthorizationRequest(authRequest) {
  const error = new Error('Only the ChronaSense read scope and resource are supported.');
  error.name = 'AuthorizationError';
  if (authRequest.redirectUri) {
    const redirectTo = new URL(authRequest.redirectUri);
    redirectTo.searchParams.set('error', 'invalid_request');
    if (authRequest.state) redirectTo.searchParams.set('state', authRequest.state);
    error.redirectTo = redirectTo.href;
  }
  return error;
}

function authorizationErrorResponse(error) {
  if (error && error.name === 'AuthorizationError' && error.redirectTo) {
    return Response.redirect(error.redirectTo, 302);
  }
  if (error && (error.name === 'AuthorizationError' || error.name === 'CimdFetchError')) {
    return textResponse('The authorization request is invalid or expired.', 400);
  }
  return textResponse('Authorization is temporarily unavailable.', 503);
}

function consentPage(details, handle, ownerSubject) {
  const clientName = escapeHtml(details.clientName || 'OAuth client');
  const clientDomain = details.clientDomain
    ? 'Published by <strong>' + escapeHtml(details.clientDomain) + '</strong>.'
    : 'The client identity document is not available.';
  const subject = escapeHtml(ownerSubject);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Authorize ' + clientName + '</title></head><body><main><h1>Allow read access to ChronaSense?</h1>' +
    '<p>' + clientDomain + ' The redirect destination is <strong>' + escapeHtml(details.redirectHost) + '</strong>.</p>' +
    '<p>Verified Cloudflare Access subject: <code>' + subject + '</code>.</p>' +
    '<p>This grants <code>' + READ_SCOPE + '</code>: read-only access to your ChronaSense plan, captures and derived intelligence. It cannot change your data.</p>' +
    '<form method="post"><input type="hidden" name="handle" value="' + escapeHtml(handle) + '">' +
    '<button name="decision" value="approve">Allow read access</button> ' +
    '<button name="decision" value="deny">Deny</button></form></main></body></html>';
}

function identityResponse(subject) {
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>ChronaSense owner identity</title></head><body><main><h1>ChronaSense owner identity</h1>' +
    '<p>Verified Cloudflare Access subject (<code>sub</code>):</p><pre>' + escapeHtml(subject) + '</pre></main></body></html>';
  return new Response(html, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store, private',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => '&#' + character.charCodeAt(0) + ';');
}

export async function rejectInvalidTokenResource(request) {
  if (new URL(request.url).pathname !== '/oauth/token' || request.method !== 'POST') return null;
  if (!/^application\/x-www-form-urlencoded(?:\s*;|\s*$)/i.test(request.headers.get('Content-Type') || '')) return textResponse('Invalid token request.', 400);
  let form;
  try {
    const bytes = await readBoundedFormBytes(request.clone());
    form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof FormBodyTooLarge) return textResponse('Token request is too large.', 413);
    return textResponse('Invalid token request.', 400);
  }
  if (!['authorization_code', 'refresh_token'].includes(String(form.get('grant_type') || ''))) return null;
  const resources = form.getAll('resource').map(String);
  if (resources.length === 1 && resources[0] === RESOURCE) return null;
  return new Response(JSON.stringify({ error: 'invalid_target', error_description: 'The canonical MCP resource is required.' }), {
    status: 400,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' }
  });
}

class FormBodyTooLarge extends Error {}

async function readBoundedFormBytes(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_TOKEN_FORM_BYTES) throw new FormBodyTooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError('Missing form body.');
  const bytes = new Uint8Array(MAX_TOKEN_FORM_BYTES);
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (length + value.length > MAX_TOKEN_FORM_BYTES) {
      void reader.cancel().catch(() => {});
      throw new FormBodyTooLarge();
    }
    bytes.set(value, length);
    length += value.length;
  }
  return bytes.subarray(0, length);
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
