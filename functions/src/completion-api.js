// TASK-018 dedicated completion authority, derived from reviewed contract df7c279.
// This is never a fallback from the existing user-scoped Action API.
import { createHash } from 'node:crypto';
import { validateCompletionRecord as validateRecord } from '../shared/task-completion-model.js';
import { strictParseJson } from './canonical-json.js';
import { canonicalize } from './canonical-json.js';
import { createPlanRead } from './plan-read.js';
import { physicalTargetKey } from '../shared/plan-item-origin.js';
import { localPlanDate, validPlanDate, validPlanTimezone } from '../shared/plan-tomorrow-model.js';
import { completionEvent, emitSafely, meterTransport } from './completion-telemetry.js';

export const RESOLUTIONS = 'taskCompletionResolutions';
const stores = { calendar: ['calendarPlans', 'calendarPlanFences'], operational: ['operationalPlans', 'operationalPlanFences'], legacy: ['plans', 'planFences'] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const hash = value => createHash('sha256').update(canonicalize(value)).digest('base64url');
const fail = reason => { throw Object.assign(new Error(reason), { reason }); };
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('MALFORMED');
}
function principal(uid) { if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) fail('UNAUTHENTICATED'); }
export function resolutionKey(uid, identity) { principal(uid); return `r1_${hash([1, uid, identity])}`; }
export function assertExportSupported(room) {
  if (!room || typeof room !== 'object' || Array.isArray(room)) fail('MISSING_ROOM');
  if (Buffer.byteLength(JSON.stringify(room)) > 16 * 1024 * 1024) fail('ROOM_TOO_LARGE');
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, '.priority') || Object.hasOwn(value, '.value')) fail('PRIORITY_UNSUPPORTED');
    Object.values(value).forEach(visit);
  };
  visit(room);
}
function rawSource(room, identity) {
  keys(identity, ['store', 'targetId', 'itemId', 'representation', 'origin']);
  if (!Object.hasOwn(stores, identity.store) || !['array', 'fence'].includes(identity.representation)
      || typeof identity.itemId !== 'string' || !identity.itemId || identity.itemId.length > 200) fail('IDENTITY');
  const targetKey = physicalTargetKey(identity.store, identity.targetId);
  if (!targetKey) fail('IDENTITY');
  const [plans, fences] = stores[identity.store];
  const record = room[plans]?.[targetKey];
  const matches = Object.values(record?.items || {}).filter(item => item?.id === identity.itemId);
  const fence = room[fences]?.[targetKey]?.[identity.itemId];
  if (matches.length > 1 || (matches.length && fence)) fail('DUPLICATE_ID');
  const item = identity.representation === 'array' ? matches[0] : fence;
  if (!item || item.id !== identity.itemId) fail('SOURCE_MISSING');
  if (identity.representation === 'array' && (item.brainDumpOrigin || item.creationActionId || item.id.startsWith('api1_'))) fail('ORIGIN_CONFLICT');
  const origin = identity.representation === 'array' ? 'unmarked'
    : item.brainDumpOrigin || (item.creationActionId ? { creationActionId: item.creationActionId } : null);
  if (hash(origin) !== hash(identity.origin) || (identity.representation === 'fence' && origin === null)) fail('ORIGIN_CONFLICT');
  if (['carriedFromId', 'carriedFromDayId', 'relocationRevision', 'movedToDayId', 'moveLock'].some(key => Object.hasOwn(item, key))) fail('MOVED_OR_LOCKED');
  // V1 refuses globally duplicated IDs, including ambiguous older id-only recovery provenance.
  let occurrences = 0;
  for (const [planCollection, fenceCollection] of Object.values(stores)) {
    for (const plan of Object.values(room[planCollection] || {})) for (const other of Object.values(plan.items || {})) {
      if (other?.id === item.id) occurrences++;
      if (other?.carriedFromId === item.id) fail('MOVED_OR_AMBIGUOUS');
    }
    for (const group of Object.values(room[fenceCollection] || {})) for (const other of Object.values(group)) {
      if (other?.id === item.id) occurrences++;
      if (other?.carriedFromId === item.id) fail('MOVED_OR_AMBIGUOUS');
    }
  }
  if (occurrences !== 1) fail('DUPLICATE_ID');
  const { items: _items, ...metadata } = record || {};
  return { item, metadata };
}
// One immutable room observation per inspection batch; authority and stale scans are shared.
function sourceObservation(room, uid, now) {
  principal(uid); assertExportSupported(room);
  let reader;
  const plans = new Map();
  let stale;
  return async identity => {
    const { item, metadata } = rawSource(room, identity);
    const authority = await (reader ||= createPlanRead({ firebaseUid: uid, roomId: `uid_${uid}` }, {
      nowMs: now, domain: { readRoomCollection: async (_identity, collection) => room[collection] ?? null },
    })), key = canonicalize([identity.store, identity.targetId]);
    if (!plans.has(key)) plans.set(key, authority.read({ store: identity.store, id: identity.targetId }));
    stale ||= authority.stale();
    const [plan, unfinished] = await Promise.all([plans.get(key), stale]);
    if (!plan.items.some(candidate => candidate.itemId === identity.itemId)
        || !unfinished.items.some(candidate => candidate.planId === identity.targetId && candidate.itemId === identity.itemId)) fail('NOT_UNFINISHED');
    return hash({ v: 1, uid, identity, item, metadata, authority: room.calendarPlanAuthority || null,
      boundaries: room.dayBoundaryRevisions || null, timezone: room.settings?.timezone || null });
  };
}
export async function sourceRevision(room, uid, identity, now) {
  return sourceObservation(room, uid, now)(identity);
}
function validate(request, now) {
  const names = ['identity', 'operationId', 'expectedRevision', 'expectedSourceRevision', 'kind'];
  keys(request, [...names, ...(request.kind === 'complete' ? ['date', 'timezone'] : ['undoOf'])]);
  if (!UUID.test(request.operationId) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
      || typeof request.expectedSourceRevision !== 'string' || request.expectedSourceRevision.length !== 43) fail('MALFORMED');
  if (request.kind === 'complete') {
    let valid = false;
    try { valid = validPlanDate(request.date) && validPlanTimezone(request.timezone)
      && request.date <= localPlanDate(now, request.timezone); } catch { /* malformed calendar date */ }
    if (!valid) fail('INVALID_DATE_OR_ZONE');
  } else if (request.kind !== 'undo' || !UUID.test(request.undoOf)) fail('MALFORMED');
}
export async function propose(room, uid, request, now) {
  principal(uid); assertExportSupported(room); validate(request, now);
  // Validate identity even for replay, without requiring the historical source to remain available.
  keys(request.identity, ['store', 'targetId', 'itemId', 'representation', 'origin']);
  const key = resolutionKey(uid, request.identity), intentHash = hash(request);
  const current = room[RESOLUTIONS]?.[key];
  validateRecord(current, uid);
  if (current && hash(current.identity) !== hash(request.identity)) fail('IDENTITY_CONFLICT');
  const receipt = current?.operations?.[request.operationId];
  if (receipt) {
    if (receipt.intentHash !== intentHash) fail('OPERATION_ID_REUSE');
    return { replay: true, key, record: current, receipt }; // historical APPLIED, current head may be different
  }
  if (request.expectedRevision !== (current?.revision || 0)) fail('STALE_RESOLUTION');
  if (request.kind === 'complete' && request.timezone !== room.settings?.timezone) fail('ACCOUNT_ZONE_CHANGED');
  const observed = await sourceRevision(room, uid, request.identity, now);
  if (observed !== request.expectedSourceRevision) fail('STALE_SOURCE');
  if (request.kind === 'complete' && current?.state === 'completed') fail('ALREADY_RESOLVED');
  if (request.kind === 'undo' && (current?.state !== 'completed' || current.completionOpId !== request.undoOf
      || current.operations[request.undoOf].sourceRevision !== observed)) fail('UNDO_CONFLICT');
  const revision = (current?.revision || 0) + 1;
  const nextReceipt = { intentHash, kind: request.kind, revision, recordedAt: now, actorUid: uid,
    sourceRevision: observed, ...(request.kind === 'complete' ? { date: request.date, timezone: request.timezone } : { undoOf: request.undoOf }) };
  const record = { v: 1, identity: request.identity, revision,
    state: request.kind === 'complete' ? 'completed' : 'open',
    completionOpId: request.kind === 'complete' ? request.operationId : current.completionOpId,
    operations: { ...(current?.operations || {}), [request.operationId]: nextReceipt } };
  if (Buffer.byteLength(JSON.stringify({ outcome: 'CONFIRMED', record, receipt: nextReceipt })) > 500 * 1024) fail('RESOLUTION_TOO_LARGE');
  const next = { ...room, [RESOLUTIONS]: { ...(room[RESOLUTIONS] || {}), [key]: record } };
  assertExportSupported(next);
  return { next, key, record, receipt: nextReceipt, replay: false };
}

// Transport receives only the UID produced by verified Firebase authentication.
// Every CAS covers the entire owner room; only the resolution lens may differ from its exact export preimage.
export async function execute(transport, uid, request, now, { uncertain = false } = {}) {
  let mayHaveWritten = uncertain;
  try {
    principal(uid);
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await transport.read(uid);
      const proposal = await propose(snapshot.value, uid, request, now);
      if (proposal.replay) return { outcome: 'CONFIRMED', ...proposal };
      mayHaveWritten = true;
      const result = await transport.cas(uid, snapshot.etag, proposal.next, snapshot.value);
      if (result === 'changed') { mayHaveWritten = uncertain; continue; }
      if (result === 'denied') { mayHaveWritten = uncertain; fail('WRITE_DENIED'); }
      if (result !== 'written') fail('UNKNOWN_WRITE');
      // Require authoritative readback of our immutable operation receipt; absence is never a rejection.
      const readback = await transport.read(uid);
      const record = readback.value?.[RESOLUTIONS]?.[proposal.key];
      const receipt = record?.operations?.[request.operationId];
      validateRecord(record, uid);
      if (!receipt || receipt.intentHash !== hash(request)) fail('ACK_UNPROVEN');
      return { outcome: 'CONFIRMED', key: proposal.key, record, receipt };
    }
    fail('CONTENDED');
  } catch (error) { return { outcome: mayHaveWritten ? 'UNKNOWN' : 'REJECTED', reason: error.reason || error.code || 'UNAVAILABLE' }; }
}
// A remote receipt alone never hides a task after a changed source: show a distinct needs-review state.
export async function projection(room, uid, identity, now, { remotelyConfirmed = false } = {}) {
  if (!remotelyConfirmed) return 'unfinished';
  const record = room[RESOLUTIONS]?.[resolutionKey(uid, identity)];
  if (!record) return 'unfinished';
  try {
    validateRecord(record, uid);
    if (hash(record.identity) !== hash(identity)) fail('IDENTITY_CONFLICT');
    if (record.state !== 'completed') return 'unfinished';
    return await sourceRevision(room, uid, identity, now) === record.operations[record.completionOpId].sourceRevision
      ? 'completed' : 'needs-review';
  } catch { return 'needs-review'; }
}
// Pass ONLY an authoritative exact-child read, bound to uid + derived resolutionKey. Never a local cache value.
export function operationStatus(record, uid, request) {
  try {
    principal(uid);
    if (!record) return { outcome: 'UNKNOWN' }; // absence does not rule out a delayed write
    validateRecord(record, uid);
    if (hash(record.identity) !== hash(request.identity)) fail('IDENTITY_CONFLICT');
    const receipt = record.operations[request.operationId];
    if (!receipt || receipt.intentHash !== hash(request)) return { outcome: 'UNKNOWN' };
    return { outcome: 'CONFIRMED', record, receipt };
  } catch { return { outcome: 'UNKNOWN' }; }
}

// Browser-facing endpoint. Authentication completes before ANY privileged read or write.
// `log` receives one sanitized event per request (completion-telemetry.js); it never sees request data.
export function createCompletionHandler({ verifyIdToken, domain, now = Date.now, log = () => {}, clock = () => performance.now() }) {
  const handle = createRequestHandler({ verifyIdToken, domain, now });
  return async request => {
    let started = 0;
    emitSafely(() => { started = clock(); });
    const metered = meterTransport(domain), facts = {};
    const result = await handle(request, metered.io, facts);
    // Clock, event construction and sink all sit inside the guard: none can turn a committed result into a failure.
    emitSafely(() => log(completionEvent({ ...facts, status: result.status, body: result.body, stats: metered.stats, latencyMs: clock() - started })));
    return result;
  };
}
function createRequestHandler({ verifyIdToken, now }) {
  return async ({ method, authorization, rawBody }, domain, facts) => {
    if (method !== 'POST') return { status: 405, body: { outcome: 'REJECTED', reason: 'METHOD' } };
    let uid;
    try {
      if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization)) fail('UNAUTHENTICATED');
      const decoded = await verifyIdToken(authorization.slice(7), true);
      principal(decoded.uid);
      // Action API claim-bearing tokens are not ordinary app sessions.
      if (decoded.chronasenseActionId !== undefined) fail('UNAUTHENTICATED');
      uid = decoded.uid;
    } catch { return { status: 401, body: { outcome: 'REJECTED', reason: 'UNAUTHENTICATED' } }; }
    try {
      if (!(rawBody instanceof Uint8Array) || rawBody.byteLength > 65536) fail('MALFORMED');
      const input = strictParseJson(rawBody), instant = now();
      facts.op = input?.kind;
      let body;
      if (input.kind === 'inspect') {
        keys(input, ['kind', 'identities']);
        if (!Array.isArray(input.identities) || input.identities.length > 100) fail('MALFORMED');
        const snapshot = await domain.read(uid);
        const observe = sourceObservation(snapshot.value, uid, instant);
        const views = [];
        for (const identity of input.identities) {
          try {
            const revision = await observe(identity);
            const key = resolutionKey(uid, identity), record = snapshot.value[RESOLUTIONS]?.[key] || null;
            validateRecord(record, uid);
            const raw = rawSource(snapshot.value, identity);
            views.push({ identity, sourceRevision: revision, itemHash: hash(raw.item), record,
              state: !record || record.state !== 'completed' ? 'unfinished' : record.operations[record.completionOpId].sourceRevision === revision ? 'completed' : 'needs-review' });
          } catch (error) { views.push({ identity, state: 'needs-review', reason: error.reason || error.code || 'SOURCE_UNAVAILABLE' }); }
        }
        facts.views = views;
        // The account's authoritative zone from this SAME snapshot: completion requests must name it (see propose()).
        const zone = snapshot.value.settings?.timezone;
        body = { outcome: 'CONFIRMED', uid, timezone: typeof zone === 'string' && validPlanTimezone(zone) ? zone : null, views };
      } else if (input.kind === 'status') {
        keys(input, ['kind', 'request']);
        const request = input.request;
        facts.kind = request?.kind;
        validate(request, instant);
        const record = await domain.readResolution(uid, resolutionKey(uid, request.identity));
        body = operationStatus(record, uid, request);
      } else {
        keys(input, ['kind', 'request', 'uncertain']);
        if (input.kind !== 'mutate' || typeof input.uncertain !== 'boolean') fail('MALFORMED');
        Object.assign(facts, { kind: input.request?.kind, uncertain: input.uncertain });
        // Never return the privileged room preimage/candidate, including on same-operation replay.
        const result = await execute(domain, uid, input.request, instant, { uncertain: input.uncertain });
        facts.replay = result.replay === true;
        body = result.outcome === 'CONFIRMED'
          ? { outcome: result.outcome, record: result.record, receipt: result.receipt }
          : { outcome: result.outcome, reason: result.reason };
      }
      if (Buffer.byteLength(JSON.stringify(body)) > 512 * 1024) return { status: 503, body: { outcome: input.kind === 'mutate' ? 'UNKNOWN' : 'REJECTED', reason: 'RESPONSE_TOO_LARGE' } };
      return { status: 200, body };
    } catch (error) { return { status: 400, body: { outcome: 'REJECTED', reason: error.reason || 'MALFORMED' } }; }
  };
}
