import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingWrites, createExtensionTransport } from '../browser-extension/pending-writes.js';
import { physicalWriterRules } from './rules.js';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { connectSdk } from '../rtdb-sdk-support.js';
const keys = globalThis.EntryPhysicalKeys;
let emulator, sequence = 0;
const connections = [];
before(async () => { emulator = await startEmulator(); });
after(async () => { await Promise.all(connections.map(c => c.close())); emulator?.stop(); });
const entry = (end = 1600000) => ({ id: 1000000, tsStart: 1000000, ts: end, updatedAt: end,
  blockIntervalMin: (end - 1000000) / 60000, activity: 'Browser evidence', energy: 'deep', source: 'browser-extension' });
const memory = () => { const values = new Map(); return {
  async get(key) { return values.get(key) ?? null; }, async set(key, value) { values.set(key, value); },
  async keys(prefix) { return [...values.keys()].filter(key => key.startsWith(prefix)); }, async remove(key) { values.delete(key); },
}; };
async function setup(uid) {
  const world = await emulator.fresh(physicalWriterRules()), storage = memory(), faults = { offline: false, loseReply: false, calls: [] };
  const attachment = { uid, owner: `uid_${uid}`, device: 'proof-device', generation: 1 };
  const actual = createExtensionTransport({ databaseURL: `${emulator.base}?ns=${world.name}`, getToken: async () => token(uid),
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).hostname, '127.0.0.1');
      if (faults.offline) throw Error('offline');
      const response = await fetch(url, options);
      if (options.method === 'PUT') { faults.calls.push({ path: new URL(url).pathname, payload: JSON.parse(options.body), etag: options.headers['If-Match'] });
        if (faults.loseReply) throw Error('lost response'); }
      return response;
    } });
  // Capability comes from this pinned emulator's loaded rules, never marker readback.
  const transport = { ...actual, enforcesPhysicalIdentity: true };
  const options = { storage, transport, identity: () => attachment, randomId: () => `extension_${++sequence}` };
  return { world, storage, faults, attachment, transport, options, queue: createPendingWrites(options), path: `rooms/uid_${uid}/entries` };
}
test('pure routing preserves physical sources, unrelated records and conflicting aliases', () => {
  const e = entry(), raw = { 1000000: e, e_2: { id: 2, activity: 'Unrelated', ts: 20 } };
  assert.deepEqual(Object.keys(keys.prepare(keys.resolve(raw, e.id), { ...e, deleted: true }, 'undo_original').patch), ['entries/1000000']);
  assert.equal(keys.resolve(raw, e.id).record.tsStart, e.tsStart);
  assert.equal(keys.resolve({ 1000000: e, e_1000000: { ...e, deleted: true } }, e.id).reason, 'contradictory-aliases');
  assert.equal(keys.resolve({ 1000000: { ...e, id: String(e.id) } }, e.id).reason, 'physical-key-occupied');
  assert.equal(keys.resolve({ other: e }, e.id).reason, 'physical-identity-conflict');
  assert.equal(keys.resolve({ e_1000000: { ...e, _csWrite: { v: 99, revision: 1 } } }, e.id).reason, 'unknown-metadata');
  assert.equal(keys.resolve({ 1000000: 0 }, e.id).reason, 'physical-key-occupied');
  assert.equal(keys.project({ 1000000: e, e_1000000: e }).entries.length, 1);
  assert.equal(keys.project({ 1000000: e, e_1000000: { ...e, deleted: true } }).conflicts.length, 1);
  assert.throws(() => keys.prepare(keys.resolve({ 1000000: { ...e, deleted: true } }, e.id), e, 'resurrect_bad'), /Tombstone/);
});
test('physical routing refuses malformed revision provenance while recognizing complete historical stamps', () => {
  const original = { v: 1, revision: 1, baseRevision: 0, baseExists: false, operationId: 'prior_writer' };
  const record = metadata => ({ ...entry(), _csWrite: metadata });
  for (const metadata of [
    { ...original, baseRevision: 'corrupt' }, { ...original, baseExists: 'corrupt' }, { ...original, operationId: { bad: true } },
    { ...original, operationId: 'invalid/path' }, { ...original, baseRevision: -1 }, { ...original, baseRevision: 1 },
    { ...original, revision: 2, baseRevision: 1 },
    ...['baseRevision', 'baseExists', 'operationId'].map(field => Object.fromEntries(Object.entries(original).filter(([key]) => key !== field))),
  ]) {
    assert.equal(keys.resolve({ 1000000: record(metadata) }, 1000000).reason, 'unknown-metadata', JSON.stringify(metadata));
  }
  for (const metadata of [original, { ...original, protocol: keys.PROTOCOL }]) {
    const basis = keys.resolve({ 1000000: record(metadata) }, 1000000);
    assert.equal(basis.status, 'found');
    assert.equal(keys.prepare(basis, entry(1720000), 'extension_next').patch['entries/1000000']._csWrite.revision, 2);
  }
});
for (const uid of ['alice', 'bob']) {
  test(`${uid}: default transport cannot infer a physical fence from server reads`, async () => {
    const env = await setup(uid); delete env.transport.enforcesPhysicalIdentity;
    await env.queue.enqueue(uid, entry());
    assert.equal((await env.queue.drain(uid)).reason, 'physical-fence-unproven');
    assert.equal((await env.queue.snapshot(uid)).queue.length, 1); assert.equal(env.faults.calls.length, 0);
  });
  test(`${uid}: offline capture, reload, refusal and lost response retain one immutable entry`, async () => {
    const env = await setup(uid), captured = entry(); env.faults.offline = true;
    const original = await env.queue.enqueue(uid, captured); captured.ts = 0;
    assert.equal((await env.queue.drain(uid)).reason, 'inspection-unconfirmed');
    env.faults.offline = false; env.faults.loseReply = true;
    const reload = createPendingWrites(env.options), unknown = await reload.drain(uid);
    assert.equal(unknown.reason, 'write-unconfirmed'); assert.equal(unknown.id, original.id);
    const immutable = structuredClone(unknown.command);
    env.faults.loseReply = false;
    assert.equal((await createPendingWrites(env.options).drain(uid)).phase, 'accepted');
    const state = await reload.snapshot(uid);
    assert.deepEqual(state.history[0].command, immutable); assert.equal(state.queue.length, 0); assert.equal(env.faults.calls.length, 1);
    assert.equal((await env.world.read(`${env.path}/1000000`)).ts, 1600000);
  });
  test(`${uid}: delayed duplicate original cannot overwrite a newer SDK edit`, async () => {
    const env = await setup(uid); let release; const gate = new Promise(resolve => { release = resolve; });
    const originalPut = env.transport.put; env.transport.put = async (...args) => { await gate; return originalPut(...args); };
    await env.queue.enqueue(uid, entry()); const delayed = env.queue.drain(uid);
    let pending;
    for (let n = 0; n < 100; n++) { const raw = await env.storage.get(`ta3-extension-writes-v1:${uid}`); pending = JSON.parse(raw).queue[0];
      if (pending.phase === 'pending') break; await new Promise(r => setTimeout(r, 5)); }
    assert.equal(pending.phase, 'pending');
    const sdk = connectSdk(emulator, env.world, { uid }); connections.push(sdk);
    const newer = keys.prepare(keys.resolve({}, 1000000, 'extension'), { ...entry(1720000), activity: 'Manual edit' }, 'other_tab_edit');
    await sdk.roomRef().update(newer.patch); release();
    const result = await delayed; assert.equal(result.reason, 'server-status-412');
    assert.equal((await env.queue.snapshot(uid)).queue[0].id, pending.id);
    const retry = await originalPut(uid, 'entries/1000000', pending.command.patch['entries/1000000'], pending.etag);
    assert.equal(retry.status, 412);
    assert.equal((await env.world.read(`${env.path}/1000000`)).activity, 'Manual edit');
    assert.equal(await env.world.read(`${env.path}/e_1000000`), null);
  });
  test(`${uid}: SDK clients racing numeric and e_ creation create exactly one physical record`, async () => {
    const env = await setup(uid), a = connectSdk(emulator, env.world, { uid }), b = connectSdk(emulator, env.world, { uid }); connections.push(a, b);
    const numeric = keys.prepare(keys.resolve({}, 1000000, 'extension'), entry(), 'numeric_creator');
    const prefixed = keys.prepare(keys.resolve({}, 1000000), entry(), 'prefixed_creator');
    a.offline(); const delayed = a.roomRef().update(numeric.patch).then(() => true, () => false);
    await b.roomRef().update(prefixed.patch); a.online(); assert.equal(await delayed, false);
    assert.deepEqual(Object.keys(await env.world.read(env.path)), ['e_1000000']);
    assert.equal(await env.world.write(`${env.path}/other`, numeric.patch['entries/1000000'], token(uid)), false);
    assert.equal(await env.world.write(`${env.path}/1000000`, numeric.patch['entries/1000000'], token(uid === 'alice' ? 'bob' : 'alice')), false);
  });
  test(`${uid}: existing identical aliases update atomically with their original keys and revisions`, async () => {
    const env = await setup(uid), e = entry();
    const stamped = { ...e, _csWrite: { v: 1, baseExists: false, baseRevision: 0, revision: 1, operationId: 'prior_writer' } };
    await env.world.seed(env.path, { 1000000: e, e_1000000: stamped });
    const basis = keys.resolve(await env.world.read(env.path), e.id);
    const command = keys.prepare(basis, { ...e, deleted: true, updatedAt: 1800000 }, 'alias_tombstone');
    assert.equal(command.patch['entries/1000000']._csWrite.revision, 1);
    assert.equal(command.patch['entries/e_1000000']._csWrite.revision, 2);
    assert.equal(await env.world.patch(`rooms/uid_${uid}`, { 'entries/1000000': command.patch['entries/1000000'] }, token(uid)), false);
    const sdk = connectSdk(emulator, env.world, { uid }); connections.push(sdk); await sdk.roomRef().update(command.patch);
    const raw = await env.world.read(env.path); assert.equal(Object.keys(raw).length, 2); assert.equal(keys.project(raw).entries.length, 1);
    assert.ok(Object.values(raw).every(value => value.deleted && value.tsStart === e.tsStart && value.ts === e.ts));
    assert.equal(await env.world.patch(`rooms/uid_${uid}`, command.patch, token(uid)), false, 'exact replay cannot advance revisions twice');
  });
  test(`${uid}: unproven legacy bases and tombstones remain UNKNOWN without migration`, async () => {
    for (const raw of [{ 1000000: entry() }, { e_1000000: { ...entry(), deleted: true } },
      { 1000000: entry(), e_1000000: { ...entry(), activity: 'Conflicting manual record' } }]) {
      const env = await setup(uid); await env.world.seed(env.path, raw); await env.queue.enqueue(uid, entry(1720000));
      assert.equal((await env.queue.drain(uid)).phase, 'unknown');
      assert.deepEqual(await env.world.read(env.path), raw); assert.equal(env.faults.calls.length, 0);
    }
  });
  test(`${uid}: acknowledged base permits exact extension merge but never rebases over a later edit`, async () => {
    const env = await setup(uid); await env.queue.enqueue(uid, entry()); assert.equal((await env.queue.drain(uid)).phase, 'accepted');
    await env.queue.enqueue(uid, entry(1720000)); assert.equal((await env.queue.drain(uid)).phase, 'accepted');
    const base = await env.world.read(`${env.path}/1000000`), changed = keys.prepare(keys.resolve({ 1000000: base }, 1000000), { ...base, activity: 'Manual changed' }, 'manual_changed');
    assert.equal(await env.world.patch(`rooms/uid_${uid}`, changed.patch, token(uid)), true);
    await env.queue.enqueue(uid, entry(1840000)); assert.equal((await env.queue.drain(uid)).reason, 'original-base-unproven');
    assert.equal((await env.world.read(`${env.path}/1000000`)).activity, 'Manual changed');
  });
  test(`${uid}: a stale shorter recovery capture cannot truncate an already retained interval`, async () => {
    const env = await setup(uid);
    await env.queue.enqueue(uid, entry()); await env.queue.enqueue(uid, entry(1300000));
    assert.equal((await env.queue.drain(uid)).reason, 'captured-range-regression');
    assert.equal((await env.world.read(`${env.path}/1000000`)).ts, 1600000);
    const state = await env.queue.snapshot(uid); assert.equal(state.history.length, 1);
    assert.equal(state.queue.length, 1); assert.equal(state.queue[0].entry.ts, 1300000);
  });
  test(`${uid}: exact existing content establishes a proven base, and conditional read failure can recover`, async () => {
    const env = await setup(uid); await env.world.seed(`${env.path}/1000000`, entry()); await env.queue.enqueue(uid, entry());
    assert.equal((await env.queue.drain(uid)).phase, 'accepted');
    const realRead = env.transport.read; env.transport.read = async () => { throw Error('read lost'); };
    await env.queue.enqueue(uid, entry(1720000)); const unknown = await env.queue.drain(uid);
    assert.equal(unknown.reason, 'conditional-read-unconfirmed');
    env.transport.read = realRead; assert.equal((await createPendingWrites(env.options).drain(uid)).phase, 'accepted');
    assert.deepEqual((await env.queue.snapshot(uid)).history.at(-1).command, unknown.command);
  });
  test(`${uid}: account detach, permanent refusal and unsupported alias PATCH never discard captured facts`, async () => {
    const env = await setup(uid); await env.queue.enqueue(uid, entry()); env.attachment.uid = 'other';
    assert.equal((await env.queue.drain(uid)).reason, 'account-detached'); assert.equal(env.faults.calls.length, 0);
    env.attachment.uid = uid; env.transport.put = async () => ({ status: 403, body: {} });
    assert.equal((await env.queue.drain(uid)).reason, 'server-status-403');
    const retained = (await env.queue.snapshot(uid)).queue[0]; assert.deepEqual(retained.entry, entry());
    assert.equal((await env.queue.drain(uid)).id, retained.id);
    const aliases = await setup(uid); delete aliases.transport.atomicPatch; await aliases.world.seed(aliases.path, { 1000000: entry(), e_1000000: entry() });
    await aliases.queue.enqueue(uid, entry()); await aliases.queue.drain(uid);
    await aliases.queue.enqueue(uid, entry(1720000)); assert.equal((await aliases.queue.drain(uid)).reason, 'atomic-alias-fence-required');
    assert.deepEqual(await aliases.world.read(aliases.path), { 1000000: entry(), e_1000000: entry() });
  });
  test(`${uid}: a pinned atomic transport updates all proven aliases with one immutable command`, async () => {
    const env = await setup(uid); await env.world.seed(env.path, { 1000000: entry(), e_1000000: entry() });
    await env.queue.enqueue(uid, entry()); await env.queue.drain(uid);
    let sent;
    env.transport.atomicPatch = async (_uid, patch) => {
      sent = structuredClone(patch);
      const response = await fetch(`${emulator.base}/rooms/uid_${uid}.json?ns=${env.world.name}&auth=${token(uid)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return { status: response.status, body: await response.json() };
    };
    await env.queue.enqueue(uid, entry(1720000)); assert.equal((await env.queue.drain(uid)).phase, 'accepted');
    assert.deepEqual(Object.keys(sent).sort(), ['entries/1000000', 'entries/e_1000000']);
    assert.equal(keys.project(await env.world.read(env.path)).entries[0].ts, 1720000);
  });
}
test('explicit authentication refusal refreshes once with the same conditional request', async () => {
  const tokens = [], requests = [], entryValue = entry();
  const transport = createExtensionTransport({ databaseURL: 'http://127.0.0.1:1', getToken: async (uid, force = false) => {
    assert.equal(uid, 'alice'); tokens.push(force); return force ? 'refreshed' : 'expired';
  }, fetchImpl: async (url, options) => {
    requests.push({ auth: new URL(url).searchParams.get('auth'), ...options });
    return { status: requests.length === 1 ? 401 : 200, json: async () => entryValue, headers: { get: () => 'etag' } };
  } });
  assert.equal((await transport.put('alice', 'entries/1000000', entryValue, 'original-etag')).status, 200);
  assert.deepEqual(tokens, [false, true]); assert.deepEqual(requests.map(r => r.auth), ['expired', 'refreshed']);
  assert.equal(requests[0].body, requests[1].body); assert.deepEqual(requests[0].headers, requests[1].headers);
});
