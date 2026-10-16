// TASK-018 completion monitoring. One sanitized structured event per request.
// Fields come ONLY from fixed vocabularies, counts, booleans and size buckets: never UID, room/path, task text,
// identity, dates, timezone, operation IDs, ETags, tokens, request/response bodies or error messages.

export const COMPLETION_REASONS = new Set([
  'ACCOUNT_ZONE_CHANGED', 'ACK_UNPROVEN', 'ALREADY_RESOLVED', 'CONTENDED', 'DUPLICATE_ID', 'ETAG_REQUIRED',
  'IDENTITY', 'IDENTITY_CONFLICT', 'INVALID_DATE_OR_ZONE', 'LENS_REFUSED', 'MALFORMED', 'METHOD', 'MISSING_ROOM',
  'MOVED_OR_AMBIGUOUS', 'MOVED_OR_LOCKED', 'NOT_UNFINISHED', 'OPERATION_ID_REUSE', 'ORIGIN_CONFLICT',
  'PRIORITY_UNSUPPORTED', 'RECORD_CONFLICT', 'RESOLUTION_TOO_LARGE', 'RESPONSE_TOO_LARGE', 'ROOM_TOO_LARGE',
  'SOURCE_MISSING', 'STALE_RESOLUTION', 'STALE_SOURCE', 'UNAUTHENTICATED', 'UNAVAILABLE', 'UNDO_CONFLICT',
  'UNKNOWN_WRITE', 'WRITE_DENIED', 'SOURCE_UNAVAILABLE',
]);
const SIZE_REFUSALS = new Set(['ROOM_TOO_LARGE', 'RESOLUTION_TOO_LARGE', 'RESPONSE_TOO_LARGE']);
const INTEGRITY = new Set(['CONTENDED', 'ACK_UNPROVEN', 'LENS_REFUSED', 'WRITE_DENIED', 'UNKNOWN_WRITE', 'ETAG_REQUIRED', 'RECORD_CONFLICT']);
const OPS = new Set(['inspect', 'status', 'mutate']);
const KINDS = new Set(['complete', 'undo']);
const STATES = { unfinished: 'unfinished', completed: 'completed', 'needs-review': 'needsReview' };

export const reasonLabel = value => value === undefined || value === null ? undefined
  : COMPLETION_REASONS.has(value) ? value : 'OTHER';
const KIB = 1024, MIB = 1024 * KIB;
const BYTE_BUCKETS = [[64 * KIB, 'le64KiB'], [512 * KIB, 'le512KiB'], [2 * MIB, 'le2MiB'], [8 * MIB, 'le8MiB'], [16 * MIB, 'le16MiB']];
export function bytesBucket(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return undefined;
  return (BYTE_BUCKETS.find(([limit]) => bytes <= limit) || [0, 'gt16MiB'])[1];
}
const countBucket = n => n === 0 ? '0' : n === 1 ? '1' : n <= 10 ? '2-10' : n <= 50 ? '11-50' : '51-100';
// Error class only; the thrown error object itself is never inspected for text. Domain refusals keep their
// controlled reason (e.g. ROOM_TOO_LARGE, LENS_REFUSED); other unexpected errors are FAULT.
const transportClass = error => error?.name === 'TimeoutError' ? 'TIMEOUT'
  : error?.name === 'AbortError' ? 'ABORTED' : error?.reason ? reasonLabel(error.reason)
    : error?.name === 'TypeError' ? 'NETWORK' : 'FAULT'; // fetch() signals network failure as TypeError

// Wraps the privileged transport without altering arguments, results or thrown errors.
// Methods are resolved at call time so a transport may gain readResolution after construction.
export function meterTransport(domain) {
  const stats = { reads: 0, readBytes: 0, casAttempts: 0, casConflicts: 0, casDenied: 0, transportError: undefined };
  const observe = async (run) => {
    try { return await run(); } catch (error) { stats.transportError ||= transportClass(error); throw error; }
  };
  return {
    stats,
    io: {
      read: uid => observe(async () => {
        stats.reads++;
        const snapshot = await domain.read(uid);
        if (Number.isFinite(snapshot?.bytes)) stats.readBytes += snapshot.bytes;
        return snapshot;
      }),
      cas: (uid, etag, next, before) => observe(async () => {
        stats.casAttempts++;
        const result = await domain.cas(uid, etag, next, before);
        if (result === 'changed') stats.casConflicts++;
        if (result === 'denied') stats.casDenied++;
        return result;
      }),
      readResolution: (uid, key) => observe(async () => { stats.reads++; return domain.readResolution(uid, key); }),
    },
  };
}

export function completionEvent({ op, kind, uncertain, replay, status, body, stats, views, latencyMs }) {
  const outcome = ['CONFIRMED', 'REJECTED', 'UNKNOWN'].includes(body?.outcome) ? body.outcome : 'OTHER';
  const reason = reasonLabel(body?.reason);
  const event = { event: 'completion-request', op: OPS.has(op) ? op : 'unparsed', status, outcome,
    latencyMs: Math.max(0, Math.round(latencyMs)) };
  if (reason) event.reason = reason;
  if (KINDS.has(kind)) event.kind = kind;
  if (typeof uncertain === 'boolean') event.uncertain = uncertain;
  if (typeof replay === 'boolean') event.replay = replay;
  if (stats) {
    Object.assign(event, { reads: stats.reads, casAttempts: stats.casAttempts, casConflicts: stats.casConflicts, casDenied: stats.casDenied });
    if (stats.readBytes > 0) event.readBytes = bytesBucket(stats.readBytes);
    if (stats.transportError) event.transportError = stats.transportError;
  }
  if (Array.isArray(views)) {
    const states = { unfinished: 0, completed: 0, needsReview: 0 }, viewReasons = {};
    for (const view of views) {
      const state = STATES[view?.state];
      if (state) states[state]++;
      const label = reasonLabel(view?.reason);
      if (label) viewReasons[label] = (viewReasons[label] || 0) + 1;
    }
    Object.assign(event, { identities: countBucket(views.length), states });
    if (Object.keys(viewReasons).length) event.viewReasons = viewReasons;
  }
  const responseBytes = body === undefined ? undefined : bytesBucket(Buffer.byteLength(JSON.stringify(body)));
  if (responseBytes) event.responseBytes = responseBytes;
  const sizeRefused = SIZE_REFUSALS.has(reason) || Object.keys(event.viewReasons || {}).some(r => SIZE_REFUSALS.has(r));
  if (sizeRefused) event.sizeRefusal = true;
  // A mutate that may have written without proof is the never-lose-time risk: dedicated flag + ERROR for alerting.
  if (event.op === 'mutate' && outcome === 'UNKNOWN') event.unconfirmedWrite = true;
  event.severity = status >= 500 || event.unconfirmedWrite ? 'ERROR'
    : outcome === 'UNKNOWN' || sizeRefused || INTEGRITY.has(reason) || event.casConflicts > 0 || event.transportError ? 'WARNING' : 'INFO';
  return event;
}

// Logging is best-effort: no monitoring failure (clock, event construction or sink) may change a response.
export function emitSafely(run) {
  try { run(); } catch { /* monitoring must not affect the completion contract */ }
}
