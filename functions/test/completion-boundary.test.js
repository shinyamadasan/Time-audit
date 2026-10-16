import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionDomain, assertCompletionLens, readCompletionJson } from '../src/completion-domain.js';
import { createCompletionHandler, propose, resolutionKey } from '../src/completion-api.js';
import { fixture, command, NOW, memory } from '../../task-completion-test-support.js';

test('authentication completes before any privileged access; claims and malformed requests refuse', async () => {
  let reads = 0, revoked = false;
  const handler = createCompletionHandler({ verifyIdToken: async (token, check) => {
    revoked = check; if (token === 'revoked') throw new Error('revoked');
    return token === 'action' ? { uid: 'alice', chronasenseActionId: 'restricted' } : { uid: token };
  }, domain: { read: () => { reads++; throw new Error('unreachable'); } }, now: () => NOW });
  for (const token of ['', 'revoked', 'action', '../alice']) {
    const result = await handler({ method: 'POST', authorization: `Bearer ${token}`, rawBody: Buffer.from('{"kind":"inspect","identities":[]}') });
    assert.equal(result.status, 401);
  }
  assert.equal(reads, 0); assert.equal(revoked, true);
  for (const raw of ['{"kind":"inspect","kind":"mutate","identities":[]}', '{"kind":"inspect","identities":[],"uid":"bob"}', '{}']) {
    assert.equal((await handler({ method: 'POST', authorization: 'Bearer alice', rawBody: Buffer.from(raw) })).body.outcome, 'REJECTED');
  }
  assert.equal(reads, 0);
});
test('handler strips privileged room including idempotent replay, and account cannot address another owner', async () => {
  const f = fixture(), io = memory(f.room), req = await command(f.room, f.identity);
  io.readResolution = async (_uid, key) => io.value().taskCompletionResolutions?.[key];
  const handler = createCompletionHandler({ verifyIdToken: async uid => ({ uid }), domain: io, now: () => NOW });
  const send = (uid, input) => handler({ method: 'POST', authorization: `Bearer ${uid}`, rawBody: Buffer.from(JSON.stringify(input)) });
  for (let i = 0; i < 2; i++) {
    const { body } = await send('alice', { kind: 'mutate', request: req, uncertain: false });
    assert.equal(body.outcome, 'CONFIRMED'); assert.deepEqual(Object.keys(body).sort(), ['outcome', 'receipt', 'record']);
    assert.equal(JSON.stringify(body).includes('futureUnknownSibling'), false);
  }
  assert.equal((await send('bob', { kind: 'mutate', request: req, uncertain: false })).body.outcome, 'REJECTED');
  assert.equal((await send('alice', { kind: 'status', request: req })).body.outcome, 'CONFIRMED');
});
test('independent privileged lens rejects any sibling change, wrong key, deletion or receipt rewrite', async () => {
  const f = fixture(), req = await command(f.room, f.identity), p = await propose(f.room, 'alice', req, NOW);
  assert.doesNotThrow(() => assertCompletionLens(f.room, p.next, 'alice'));
  const bad = structuredClone(p.next); bad.timer.running = true;
  assert.throws(() => assertCompletionLens(f.room, bad, 'alice'), /LENS/);
  const wrong = structuredClone(p.next), key = resolutionKey('alice', f.identity);
  wrong.taskCompletionResolutions['r1_' + 'x'.repeat(43)] = wrong.taskCompletionResolutions[key]; delete wrong.taskCompletionResolutions[key];
  assert.throws(() => assertCompletionLens(f.room, wrong, 'alice'), /LENS/);
  assert.throws(() => assertCompletionLens(p.next, f.room, 'alice'), /LENS/);
});
test('transport derives only verified owner paths and requires exact conditional PUT without fallback', async () => {
  const f = fixture(), req = await command(f.room, f.identity), p = await propose(f.room, 'alice', req, NOW), calls = [];
  const domain = createCompletionDomain({ databaseUrl: 'https://offline.firebaseio.com', getAccessToken: async () => 'server-only',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(f.room), { status: options.method ? 412 : 200, headers: { etag: '"revision-a"' } }); } });
  const snap = await domain.read('alice');
  assert.equal(await domain.cas('alice', snap.etag, p.next, snap.value), 'changed');
  assert.equal(calls[0].url, 'https://offline.firebaseio.com/rooms/uid_alice.json?format=export');
  assert.equal(calls[1].options.method, 'PUT'); assert.equal(calls[1].options.headers['if-match'], '"revision-a"');
  await assert.rejects(domain.cas('alice', '*', p.next, snap.value), /ETAG/);
  await assert.rejects(domain.read('../bob'), /UNAUTHENTICATED/); assert.equal(calls.length, 2);
});
test('streaming room bound refuses oversized header and chunked data before allocation', async () => {
  await assert.rejects(readCompletionJson(new Response('null', { headers: { 'content-length': '100' } }), 5), /ROOM_TOO_LARGE/);
  await assert.rejects(readCompletionJson(new Response('0123456789'), 5), /ROOM_TOO_LARGE/);
  assert.deepEqual(await readCompletionJson(new Response('{"ok":true}'), 20), { ok: true });
});
test('inspect returns the account zone from the same snapshot; an invalid zone is withheld as null', async () => {
  const f = fixture(), io = memory(f.room);
  const handler = createCompletionHandler({ verifyIdToken: async uid => ({ uid }), domain: io, now: () => NOW });
  const inspect = () => handler({ method: 'POST', authorization: 'Bearer alice', rawBody: Buffer.from(JSON.stringify({ kind: 'inspect', identities: [f.identity] })) });
  assert.equal((await inspect()).body.timezone, 'Etc/UTC');
  io.change(room => { room.settings.timezone = 'Not/AZone'; return room; });
  assert.equal((await inspect()).body.timezone, null);
});
