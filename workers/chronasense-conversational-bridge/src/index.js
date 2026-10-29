import { createRemoteJWKSet, jwtVerify } from 'jose';
import { allowedSubjects, handleMcpRequest, ISSUER, KNOWN_SCOPES, OFFLINE_ACCESS_SCOPE, PLAN_WRITE_SCOPE, RESOURCE, READ_SCOPE, WRITE_SCOPE, validateMcpRequestOrigin } from './mcp.js';

const ACCESS_ASSERTION_HEADER = 'Cf-Access-Jwt-Assertion';
const ACCESS_ALGORITHM = 'RS256';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;
const MAX_TOKEN_FORM_BYTES = 8192;
/** Live (code-exchanged) grants one subject may hold for one client + redirect + resource, the new one included. */
export const MAX_GRANTS_PER_CLIENT = 5;

let oauthWorkerPromise = null;
let remoteJwksUrl = null;
let remoteJwks = null;

export const OAUTH_PROVIDER_CONFIG = Object.freeze({
  apiRoute: '/mcp', authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token',
  scopesSupported: [...KNOWN_SCOPES], requiredScopes: [READ_SCOPE],
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

  let accessSubject;
  let accessLabel;
  try {
    ({ subject: accessSubject, label: accessLabel } = await verifyAccessIdentity(request, env, deps));
  } catch (error) {
    if (error instanceof AccessConfigurationError) {
      return textResponse('Access identity verification is not configured.', 503);
    }
    return textResponse('Cloudflare Access authentication is required.', 401);
  }

  if (request.method === 'GET' && isIdentityBootstrapRequest(url)) {
    return identityResponse(accessSubject);
  }
  if (request.method === 'GET') return beginAuthorization(request, env.OAUTH_PROVIDER, accessSubject, accessLabel);
  if (request.method === 'POST') return finishAuthorization(request, env.OAUTH_PROVIDER, accessSubject);
  return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, POST' } });
}

function isIdentityBootstrapRequest(url) {
  const params = [...url.searchParams.entries()];
  return params.length === 1 && params[0][0] === 'identity' && params[0][1] === '1';
}

export async function requireAccessSubject(request, env, deps = {}) {
  return (await verifyAccessIdentity(request, env, deps)).subject;
}

/** The allowlisted `sub` (the identity) plus the Access email as a display-only label: never an identity key. */
async function verifyAccessIdentity(request, env, deps = {}) {
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
  let allowed;
  try { allowed = allowedSubjects(env); } catch { throw new AccessConfigurationError(); }
  if (!allowed.includes(payload.sub)) throw new Error('Access subject is not allowlisted.');
  const label = typeof payload.email === 'string' && payload.email.length <= 320 ? payload.email : '';
  return { subject: payload.sub, label };
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

async function beginAuthorization(request, oauth, accessSubject, accessLabel) {
  if (!oauth) return textResponse('OAuth provider is unavailable.', 503);
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    requireAuthorizationRequest(request, authRequest);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    consent.headers.set('Content-Type', 'text/html; charset=utf-8');
    consent.headers.set('Cache-Control', 'no-store');
    return new Response(consentPage(details, consent.handle, accessSubject, accessLabel, authorizedScopes(authRequest)), { status: 200, headers: consent.headers });
  } catch (error) {
    return authorizationErrorResponse(error);
  }
}

async function finishAuthorization(request, oauth, accessSubject) {
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
    requireApprovedRequest(approved.request);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: accessSubject,
      metadata: {},
      scope: authorizedScopes(approved.request),
      props: { ownerSubject: accessSubject, issuer: ISSUER, resource: RESOURCE, notBefore: Math.floor(Date.now() / 1000) },
      // ChatGPT web, mobile and a reconnect each hold their own grant; replacing them all on every new
      // authorization signed the other holders out. pruneOldestGrants bounds how many stay live instead.
      revokeExistingGrants: false
    });
    // Only after the new grant exists, so a failed authorization never evicts one. The cap is hygiene, not the
    // access boundary: if pruning fails, the approval still completes and the next authorization prunes.
    try { await pruneOldestGrants(oauth, accessSubject, approved.request); }
    catch (error) { console.warn('Grant pruning failed:', error instanceof Error ? error.name : 'unknown'); }
    approved.headers.set('Location', redirectTo);
    approved.headers.set('Cache-Control', 'no-store');
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    return authorizationErrorResponse(error);
  }
}

/** After a new (still pending) grant is added, revoke this subject's oldest live grants for the same client, redirect
 *  and resource, keeping MAX_GRANTS_PER_CLIENT - 1, so at most MAX_GRANTS_PER_CLIENT are live once its code is
 *  exchanged. Only this subject's grants are listed. Pending grants (approved, code not yet exchanged, the new one
 *  included) have no expiresAt and are skipped: they expire on their own after 10 minutes. */
async function pruneOldestGrants(oauth, subject, authRequest) {
  const matching = [];
  let cursor;
  do {
    const page = await oauth.listUserGrants(subject, cursor ? { cursor } : undefined);
    matching.push(...page.items.filter(grant => grant.userId === subject && grant.expiresAt !== undefined
      && grant.clientId === authRequest.clientId && grant.redirectUri === authRequest.redirectUri && grant.resource === RESOURCE));
    cursor = page.cursor;
  } while (cursor);
  matching.sort((a, b) => b.createdAt - a.createdAt);
  for (const grant of matching.slice(MAX_GRANTS_PER_CLIENT - 1)) await oauth.revokeGrant(grant.id, subject);
}

function requireAuthorizationRequest(request, authRequest) {
  authorizedScopes(authRequest);
  const url = new URL(request.url);
  const resources = url.searchParams.getAll('resource');
  if (resources.length !== 1 || resources[0] !== RESOURCE || authRequest.resource !== RESOURCE) {
    throw invalidAuthorizationRequest(authRequest);
  }
}

function requireApprovedRequest(authRequest) {
  authorizedScopes(authRequest);
  if (authRequest.resource !== RESOURCE) throw invalidAuthorizationRequest(authRequest);
}

function authorizedScopes(authRequest) {
  const requestedScopes = (Array.isArray(authRequest.scope) ? authRequest.scope : [authRequest.scope])
    .flatMap((scope) => typeof scope === 'string' ? scope.split(' ') : [])
    .filter(Boolean);
  const uniqueScopes = [...new Set(requestedScopes)];
  if (!uniqueScopes.includes(READ_SCOPE) || uniqueScopes.some(scope => !KNOWN_SCOPES.includes(scope))
    || uniqueScopes.length !== requestedScopes.length) throw invalidAuthorizationRequest(authRequest);
  return uniqueScopes.sort();
}

function invalidAuthorizationRequest(authRequest) {
  const error = new Error('Only the ChronaSense read, Brain Dump write, plan write, offline access scopes and resource are supported.');
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

function consentHeading(scopes) {
  const capture = scopes.includes(WRITE_SCOPE);
  const plan = scopes.includes(PLAN_WRITE_SCOPE);
  if (capture && plan) return ['Allow Brain Dump capture and plan task changes?', 'Allow captures and task changes'];
  if (plan) return ['Allow adding and changing tasks in your ChronaSense plan?', 'Allow task changes'];
  if (capture) return ['Allow Brain Dump capture creation?', 'Allow capture creation'];
  return ['Allow read access to ChronaSense?', 'Allow read access'];
}

function consentPage(details, handle, accessSubject, accessLabel, scopes) {
  const clientName = escapeHtml(details.clientName || 'OAuth client');
  const [heading, approve] = consentHeading(scopes);
  const writes = scopes.includes(WRITE_SCOPE) || scopes.includes(PLAN_WRITE_SCOPE);
  const clientDomain = details.clientDomain
    ? 'Published by <strong>' + escapeHtml(details.clientDomain) + '</strong>.'
    : 'The client identity document is not available.';
  const subject = escapeHtml(accessSubject);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Authorize ' + clientName + '</title></head><body><main><h1>' + heading + '</h1>' +
    '<p>' + clientDomain + ' The redirect destination is <strong>' + escapeHtml(details.redirectHost) + '</strong>.</p>' +
    // TASK-029: two people can sign in here, so name whose ChronaSense account this grant opens (display only).
    (accessLabel ? '<p>Signed in as <strong>' + escapeHtml(accessLabel) + '</strong>. This grants access to <strong>that person\'s</strong> ChronaSense account. If that is not you, deny and sign out of Cloudflare Access first.</p>' : '') +
    '<p>Verified Cloudflare Access subject: <code>' + subject + '</code>.</p>' +
    '<p>This grants <code>' + READ_SCOPE + '</code>: ' + (writes ? 'read access' : 'read-only access') + ' to your ChronaSense plan, captures and derived intelligence.'
    + (scopes.includes(WRITE_SCOPE) ? ' It also grants <code>' + WRITE_SCOPE + '</code>: create one Brain Dump capture per action. It cannot edit, delete or schedule items.' : '')
    + (scopes.includes(PLAN_WRITE_SCOPE) ? ' It also grants <code>' + PLAN_WRITE_SCOPE + '</code>: per action, add one new task to an exact calendar-day plan, or complete/uncomplete, edit, move or remove one existing task named by its id and the revision last read. It cannot touch Brain Dump, settings, timers or time entries.' : '')
    + (scopes.includes(OFFLINE_ACCESS_SCOPE) ? ' It also grants <code>offline_access</code>: the client can renew access using a refresh token without requiring a new sign-in each time the short-lived access token expires.' : '')
    + (writes ? '' : ' It cannot change your data.') + '</p>' +
    '<form method="post"><input type="hidden" name="handle" value="' + escapeHtml(handle) + '">' +
    '<button name="decision" value="approve">' + approve + '</button> ' +
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
