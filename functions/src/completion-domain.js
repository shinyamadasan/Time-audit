// TASK-018's explicit privileged-domain exception. No imports/callers in user-scoped-rtdb.js.
// URLs are derived ONLY from verified UID. Never a generic privileged database adapter.
import { parseDatabaseUrl } from './config.js';
import { canonicalize } from './canonical-json.js';
import { validFirebaseUid } from './identity.js';
import { validateCompletionRecord } from '../shared/task-completion-model.js';
import { assertExportSupported, resolutionKey } from './completion-api.js';
export const COMPLETION_ROOM_LIMIT = 16 * 1024 * 1024;
const refusal = reason => { throw Object.assign(new Error(reason), { reason }); };

export async function readCompletionJson(response, limit = COMPLETION_ROOM_LIMIT) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); refusal('ROOM_TOO_LARGE'); }
  if (!response.body) refusal('UNAVAILABLE');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); refusal('ROOM_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export function assertCompletionLens(before, after, uid) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') refusal('LENS_REFUSED');
  const { taskCompletionResolutions: oldRecords = {}, ...oldSiblings } = before;
  const { taskCompletionResolutions: nextRecords = {}, ...nextSiblings } = after;
  if (canonicalize(oldSiblings) !== canonicalize(nextSiblings)) refusal('LENS_REFUSED');
  const changed = [...new Set([...Object.keys(oldRecords), ...Object.keys(nextRecords)])]
    .filter(key => canonicalize(oldRecords[key] ?? null) !== canonicalize(nextRecords[key] ?? null));
  if (changed.length !== 1) refusal('LENS_REFUSED');
  const key = changed[0], old = oldRecords[key], next = nextRecords[key];
  if (!/^r1_[A-Za-z0-9_-]{43}$/.test(key) || !next || next.revision !== (old?.revision || 0) + 1) refusal('LENS_REFUSED');
  validateCompletionRecord(next, uid);
  if (key !== resolutionKey(uid, next.identity)) refusal('LENS_REFUSED');
  if (old) {
    validateCompletionRecord(old, uid);
    if (canonicalize(old.identity) !== canonicalize(next.identity)) refusal('LENS_REFUSED');
    for (const [id, receipt] of Object.entries(old.operations)) {
      if (canonicalize(receipt) !== canonicalize(next.operations[id] ?? null)) refusal('LENS_REFUSED');
    }
  }
  if (Object.keys(next.operations).length !== Object.keys(old?.operations || {}).length + 1) refusal('LENS_REFUSED');
}

export function createCompletionDomain({ databaseUrl, getAccessToken, fetchImpl = fetch, timeoutMs = 12000 }) {
  const origin = parseDatabaseUrl(databaseUrl);
  const url = uid => {
    if (!validFirebaseUid(uid)) refusal('UNAUTHENTICATED');
    return `${origin}/rooms/uid_${uid}.json`;
  };
  const headers = async extra => ({ Authorization: `Bearer ${await getAccessToken()}`, ...extra });
  return {
    async read(uid) {
      const at = url(uid);
      const response = await fetchImpl(`${at}?format=export`, { headers: await headers({ 'X-Firebase-ETag': 'true' }), signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { await response.body?.cancel(); refusal('UNAVAILABLE'); }
      const etag = response.headers.get('etag');
      if (!etag || etag === '*') { await response.body?.cancel(); refusal('ETAG_REQUIRED'); }
      return { value: await readCompletionJson(response), etag };
    },
    async cas(uid, etag, next, before) {
      const at = url(uid);
      if (typeof etag !== 'string' || !etag || etag === '*') refusal('ETAG_REQUIRED');
      assertExportSupported(before);
      assertExportSupported(next);
      assertCompletionLens(before, next, uid);
      const body = JSON.stringify(next);
      if (Buffer.byteLength(body) > COMPLETION_ROOM_LIMIT) refusal('ROOM_TOO_LARGE');
      // No PATCH, wildcard precondition, omitted If-Match or blind overwrite fallback.
      const response = await fetchImpl(at, { method: 'PUT', headers: await headers({ 'if-match': etag, 'content-type': 'application/json' }), body, signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel(); // never materialize or log a privileged room write response
      if (response.status === 412) return 'changed';
      if ([401, 403].includes(response.status)) return 'denied';
      if (!response.ok) refusal('UNKNOWN_WRITE');
      return 'written';
    },
    async readResolution(uid, key) {
      if (!/^r1_[A-Za-z0-9_-]{43}$/.test(key)) refusal('IDENTITY');
      const at = url(uid).replace(/\.json$/, `/taskCompletionResolutions/${key}.json`);
      const response = await fetchImpl(at, { headers: await headers({}), signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { await response.body?.cancel(); refusal('UNAVAILABLE'); }
      return readCompletionJson(response);
    },
  };
}
