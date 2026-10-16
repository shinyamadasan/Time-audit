import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionHandler, RESOLUTIONS } from '../src/completion-api.js';
import { createCompletionDomain } from '../src/completion-domain.js';
import { bytesBucket, completionEvent, COMPLETION_REASONS, reasonLabel } from '../src/completion-telemetry.js';
import { fixture, command, NOW, memory } from '../../task-completion-test-support.js';

// Synthetic sentinels: every one is something the monitoring stream must never contain.
const UID = 'uidSentinel7Q', TOKEN = 'tokSentinel-9f3e.private.signature';
const ALLOWED_KEYS = new Set(['event', 'op', 'status', 'outcome', 'latencyMs', 'reason', 'kind', 'uncertain', 'replay',
  'reads', 'readBytes', 'casAttempts', 'casConflicts', 'casDenied', 'transportError', 'unconfirmedWrite', 'identities', 'states',
  'viewReasons', 'responseBytes', 'sizeRefusal', 'severity']);

function harness(domain, { clockStep = 7 } = {}) {
  const events = [];
  let t = 1000;
  const handler = createCompletionHandler({ verifyIdToken: async token => {
    if (token !== TOKEN) throw new Error(`bad token ${token}`);
    return { uid: UID };
  }, domain, now: () => NOW, log: event => events.push(event), clock: () => (t += clockStep) });
  const send = (input, authorization = `Bearer ${TOKEN}`) =>
    handler({ method: 'POST', authorization, rawBody: Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)) });
  return { handler, send, events, last: () => events.at(-1) };
}
function withResolutionRead(io) {
  io.readResolution = async (_uid, key) => io.value()[RESOLUTIONS]?.[key] ?? null;
  return io;
}

test('one sanitized event per request; no UID, token, task, identity, dates, zone, operation or revision leaks', async () => {
  const f = fixture(), base = withResolutionRead(memory(f.room)), ETAG = 'etagSentinel-55aa';
  const io = { read: async uid => ({ ...(await base.read(uid)), etag: `${ETAG}-${(await base.read(uid)).etag}` }),
    cas: (uid, etag, ...rest) => base.cas(uid, Number(String(etag).split('-').pop()), ...rest), readResolution: base.readResolution };
  const h = harness(io);
  const req = await command(f.room, f.identity, {}, UID);
  await h.send({ kind: 'inspect', identities: [f.identity] });
  await h.send({ kind: 'mutate', request: req, uncertain: false });
  await h.send({ kind: 'mutate', request: req, uncertain: true });
  await h.send({ kind: 'status', request: req });
  await h.send({ kind: 'inspect', identities: [] }, 'Bearer wrong-token-sentinel');
  await h.handler({ method: 'GET', authorization: `Bearer ${TOKEN}`, rawBody: Buffer.from('') });
  await h.send('{"kind":"inspect","identities":[],"uid":"uidSentinel7Q"}');
  assert.equal(h.events.length, 7);
  const text = JSON.stringify(h.events);
  const forbidden = [UID, TOKEN, 'wrong-token-sentinel', f.item.task, f.identity.itemId, f.identity.targetId, f.targetKey,
    req.operationId, req.date, req.timezone, req.expectedSourceRevision, ETAG, 'bad token', 'r1_', 'uid_'];
  for (const value of forbidden) assert.equal(text.includes(value), false, `event stream leaked ${value}`);
  for (const event of h.events) for (const key of Object.keys(event)) assert.ok(ALLOWED_KEYS.has(key), `unexpected field ${key}`);
  assert.deepEqual(h.events.map(e => [e.op, e.status, e.outcome]), [
    ['inspect', 200, 'CONFIRMED'], ['mutate', 200, 'CONFIRMED'], ['mutate', 200, 'CONFIRMED'], ['status', 200, 'CONFIRMED'],
    ['unparsed', 401, 'REJECTED'], ['unparsed', 405, 'REJECTED'], ['inspect', 400, 'REJECTED']]);
  assert.equal(h.events[4].reason, 'UNAUTHENTICATED'); assert.equal(h.events[4].reads, 0);
});

test('applied, replayed, rejected and unknown completion outcomes are distinguishable without HTTP status', async () => {
  const f = fixture(), io = withResolutionRead(memory(f.room)), h = harness(io);
  const req = await command(f.room, f.identity, {}, UID);
  await h.send({ kind: 'mutate', request: req, uncertain: false });
  assert.deepEqual(pick(h.last(), 'outcome', 'kind', 'replay', 'casAttempts', 'casConflicts', 'severity'),
    { outcome: 'CONFIRMED', kind: 'complete', replay: false, casAttempts: 1, casConflicts: 0, severity: 'INFO' });
  await h.send({ kind: 'mutate', request: req, uncertain: false });
  assert.deepEqual(pick(h.last(), 'outcome', 'replay', 'casAttempts'), { outcome: 'CONFIRMED', replay: true, casAttempts: 0 });
  const stale = await command(f.room, f.identity, {}, UID);
  await h.send({ kind: 'mutate', request: stale, uncertain: false });
  assert.deepEqual(pick(h.last(), 'status', 'outcome', 'reason', 'severity'), { status: 200, outcome: 'REJECTED', reason: 'STALE_RESOLUTION', severity: 'INFO' });

  // Written but authoritative readback lacks the receipt: UNKNOWN with HTTP 200 must still be visible.
  const g = fixture(), lost = memory(g.room), h2 = harness({ ...lost, cas: async () => 'written' });
  await h2.send({ kind: 'mutate', request: await command(g.room, g.identity, {}, UID), uncertain: false });
  assert.deepEqual(pick(h2.last(), 'status', 'outcome', 'reason', 'severity'), { status: 200, outcome: 'UNKNOWN', reason: 'ACK_UNPROVEN', severity: 'ERROR' });
  assert.equal(h2.last().unconfirmedWrite, true);
});

test('conditional-write conflicts and the three-attempt retry bound are counted', async () => {
  const f = fixture(), base = memory(f.room);
  const always = harness({ read: base.read, cas: async () => 'changed' });
  await always.send({ kind: 'mutate', request: await command(f.room, f.identity, {}, UID), uncertain: false });
  assert.deepEqual(pick(always.last(), 'outcome', 'reason', 'reads', 'casAttempts', 'casConflicts', 'severity'),
    { outcome: 'REJECTED', reason: 'CONTENDED', reads: 3, casAttempts: 3, casConflicts: 3, severity: 'WARNING' });

  let first = true;
  const once = harness({ read: base.read, cas: async (...args) => (first ? (first = false, 'changed') : base.cas(...args)) });
  await once.send({ kind: 'mutate', request: await command(f.room, f.identity, {}, UID), uncertain: false });
  assert.deepEqual(pick(once.last(), 'outcome', 'casAttempts', 'casConflicts', 'severity'),
    { outcome: 'CONFIRMED', casAttempts: 2, casConflicts: 1, severity: 'WARNING' });

  const denied = harness({ read: memory(f.room).read, cas: async () => 'denied' });
  await denied.send({ kind: 'mutate', request: await command(f.room, f.identity, {}, UID), uncertain: false });
  assert.deepEqual(pick(denied.last(), 'outcome', 'reason', 'casDenied', 'severity'), { outcome: 'REJECTED', reason: 'WRITE_DENIED', casDenied: 1, severity: 'WARNING' });
});

test('room-size refusals are flagged on mutate and inspect without relaxing the 16 MiB bound', async () => {
  const f = fixture();
  const oversized = createCompletionDomain({ databaseUrl: 'https://offline.firebaseio.com', getAccessToken: async () => 'server-only',
    fetchImpl: async () => new Response('{}', { headers: { etag: '"e"', 'content-length': String(16 * 1024 * 1024 + 1) } }) });
  const h = harness(oversized);
  await h.send({ kind: 'mutate', request: await command(f.room, f.identity, {}, UID), uncertain: false });
  assert.deepEqual(pick(h.last(), 'outcome', 'reason', 'sizeRefusal', 'transportError', 'severity'),
    { outcome: 'REJECTED', reason: 'ROOM_TOO_LARGE', sizeRefusal: true, transportError: 'ROOM_TOO_LARGE', severity: 'WARNING' });
  await h.send({ kind: 'inspect', identities: [f.identity] });
  assert.deepEqual(pick(h.last(), 'status', 'reason', 'sizeRefusal'), { status: 400, reason: 'ROOM_TOO_LARGE', sizeRefusal: true });

  const g = fixture(); g.room.settings['.priority'] = 1;
  const p = harness(memory(g.room));
  await p.send({ kind: 'inspect', identities: [g.identity] });
  // Unsupported export metadata is visible by reason but is not a size refusal.
  assert.equal(p.last().sizeRefusal, undefined); assert.equal(p.last().reason, 'PRIORITY_UNSUPPORTED');
});

test('latency, read bytes and transport timeouts are measured; inspect reports state counts only', async () => {
  const f = fixture(), body = JSON.stringify(f.room);
  const real = createCompletionDomain({ databaseUrl: 'https://offline.firebaseio.com', getAccessToken: async () => 'server-only',
    fetchImpl: async () => new Response(body, { headers: { etag: '"e"' } }) });
  const h = harness(real, { clockStep: 25 });
  await h.send({ kind: 'inspect', identities: [f.identity, { ...f.identity, itemId: 'missing-sentinel' }] });
  assert.deepEqual(pick(h.last(), 'latencyMs', 'reads', 'readBytes', 'identities', 'states', 'viewReasons'), {
    latencyMs: 25, reads: 1, readBytes: bytesBucket(Buffer.byteLength(body)), identities: '2-10',
    states: { unfinished: 1, completed: 0, needsReview: 1 }, viewReasons: { SOURCE_MISSING: 1 } });
  assert.equal(JSON.stringify(h.events).includes('missing-sentinel'), false);

  const slow = harness({ read: async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); } });
  const result = await slow.send({ kind: 'mutate', request: await command(f.room, f.identity, {}, UID), uncertain: true });
  assert.equal(result.body.outcome, 'UNKNOWN'); // existing contract: uncertain operation stays unknown
  assert.deepEqual(pick(slow.last(), 'outcome', 'reason', 'transportError', 'unconfirmedWrite', 'severity'),
    { outcome: 'UNKNOWN', reason: 'OTHER', transportError: 'TIMEOUT', unconfirmedWrite: true, severity: 'ERROR' });
});

test('a failing log sink never changes the completion response', async () => {
  const f = fixture(), req = await command(f.room, f.identity, {}, UID);
  const run = async log => {
    const io = withResolutionRead(memory(f.room));
    const handler = createCompletionHandler({ verifyIdToken: async () => ({ uid: UID }), domain: io, now: () => NOW, log });
    const send = input => handler({ method: 'POST', authorization: 'Bearer x', rawBody: Buffer.from(JSON.stringify(input)) });
    return [await send({ kind: 'mutate', request: req, uncertain: false }), await send({ kind: 'status', request: req })];
  };
  const expected = await run(() => {});
  assert.deepEqual(await run(() => { throw new Error('sink down'); }), expected);
  // A throwing clock or an unserializable-event path must not turn a committed result into a failure either.
  const io = withResolutionRead(memory(f.room));
  const broken = createCompletionHandler({ verifyIdToken: async () => ({ uid: UID }), domain: io, now: () => NOW,
    log: () => {}, clock: () => { throw new Error('clock down'); } });
  const committed = await broken({ method: 'POST', authorization: 'Bearer x', rawBody: Buffer.from(JSON.stringify({ kind: 'mutate', request: req, uncertain: false })) });
  assert.equal(committed.status, 200); assert.equal(committed.body.outcome, 'CONFIRMED'); assert.equal(committed.body.receipt.revision, 1);
});

test('vocabulary guards: unknown reasons, ops and kinds collapse to fixed labels', () => {
  assert.equal(reasonLabel('ECONNRESET /rooms/uid_x'), 'OTHER'); assert.equal(reasonLabel(23), 'OTHER');
  assert.ok(COMPLETION_REASONS.has('ROOM_TOO_LARGE'));
  const event = completionEvent({ op: 'drop-table', kind: 'complete; secret', status: 200,
    body: { outcome: 'CONFIRMED', reason: 'free text' }, latencyMs: 1.6 });
  assert.deepEqual(pick(event, 'op', 'kind', 'reason', 'latencyMs'), { op: 'unparsed', kind: undefined, reason: 'OTHER', latencyMs: 2 });
  assert.deepEqual([0, 65536, 65537, 16 * 1024 * 1024, 16 * 1024 * 1024 + 1].map(bytesBucket), ['le64KiB', 'le64KiB', 'le512KiB', 'le16MiB', 'gt16MiB']);
});

function pick(object, ...names) { return Object.fromEntries(names.map(name => [name, object?.[name]])); }
