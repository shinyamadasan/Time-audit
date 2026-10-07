// functions/src/infra-rtdb.js
//
// PRIVILEGED server-infrastructure access to the two server-private RTDB nodes, and nothing else
// (docs/CHRONASENSE_ACTION_API_V1.md §3, §6). It authenticates as the Admin credential (an OAuth access token
// for the service account; `Bearer owner` in the emulator), which bypasses security rules, so its reach is
// pinned by an allowlist: any path outside serverRequestNonces/ and serverActionReceipts/ throws
// AuthorityBoundaryViolation. Domain data (rooms/...) is NEVER reachable here; that goes through
// user-scoped-rtdb.js with the owner's ID token.
//
// The primitives are RTDB REST conditional requests, which the server evaluates atomically:
// createIfAbsent = PUT with `if-match: null_etag` (412 when anything already exists at the path).

import { ApiError, AuthorityBoundaryViolation } from './errors.js';

const INFRA_PATH = /^(serverRequestNonces|serverActionReceipts)(\/[A-Za-z0-9_-]{1,128}){1,2}$/;

export function assertInfraPath(path) {
  if (typeof path !== 'string' || !INFRA_PATH.test(path)) throw new AuthorityBoundaryViolation(`infrastructure access refused for a non-infrastructure path`);
  return path;
}

const transport = reason => new ApiError('RETRYABLE_TRANSPORT', 'The server infrastructure store is unavailable.', { reason });

/**
 * @param {{databaseUrl:string, namespace?:string, fetch?:typeof fetch, getAccessToken:()=>Promise<string>, timeoutMs?:number}} options
 */
export function createInfraRtdb({ databaseUrl, namespace, fetch: fetchImpl = globalThis.fetch, getAccessToken, timeoutMs = 10_000 }) {
  if (typeof getAccessToken !== 'function') throw new Error('infra RTDB needs an Admin access-token source');

  async function call(method, path, { body, headers = {}, query = {} } = {}) {
    assertInfraPath(path);
    const url = new URL(`${databaseUrl}/${path}.json`);
    if (namespace) url.searchParams.set('ns', namespace);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let token;
    try { token = await getAccessToken(); } catch { throw transport('admin-token-unavailable'); }
    try {
      return await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // A timeout is UNKNOWN, never "absent": the caller must fail closed.
      throw transport('infra-network');
    }
  }

  return Object.freeze({
    /** Atomically creates `value` iff nothing exists at `path`. @returns {Promise<'created'|'exists'>} */
    async createIfAbsent(path, value) {
      const response = await call('PUT', path, { body: value, headers: { 'if-match': 'null_etag' } });
      if (response.status === 200) return 'created';
      if (response.status === 412) return 'exists';
      throw transport(`infra-create-${response.status}`);
    },
    async get(path) {
      const response = await call('GET', path);
      if (response.status !== 200) throw transport(`infra-get-${response.status}`);
      try { return await response.json(); } catch { throw transport('infra-get-body'); }
    },
    /** Children of `path` ordered by `childKey` with value <= `endAt`, at most `limit` of them. */
    async queryAtMost(path, childKey, endAt, limit) {
      const response = await call('GET', path, { query: { orderBy: JSON.stringify(childKey), endAt: String(endAt), limitToFirst: String(limit) } });
      if (response.status !== 200) throw transport(`infra-query-${response.status}`);
      try { return (await response.json()) ?? {}; } catch { throw transport('infra-query-body'); }
    },
    /** Multi-path update relative to `path` (null values delete). */
    async patch(path, value) {
      const response = await call('PATCH', path, { body: value });
      if (response.status !== 200) throw transport(`infra-patch-${response.status}`);
    },
  });
}
