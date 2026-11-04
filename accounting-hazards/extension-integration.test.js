// Current canonical rules + actual extension transport; no production endpoints.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { createPendingWrites, createExtensionTransport } from '../browser-extension/pending-writes.js';
const keys = globalThis.EntryPhysicalKeys;
const rules = fs.readFileSync(new URL('../firebase.rules.json', import.meta.url), 'utf8');
let emulator, sequence = 0;
before(async () => { emulator = await startEmulator(); });
after(() => emulator?.stop());
const entry = (end = 1600000) => ({ id: 1000000, tsStart: 1000000, ts: end, updatedAt: end,
  blockIntervalMin: Math.round((end - 1000000) / 60000), date: '2026-10-28', activity: 'Browser evidence',
  energy: 'deep', onPlan: true, retro: true, browserUsage: true, quickLogged: true, source: 'browser-extension' });
async function setup(uid) {
  const world = await emulator.fresh(rules), values = new Map(), faults = { offline: false, calls: [] };
  const storage = { get: async key => values.get(key) ?? null, set: async (key, raw) => values.set(key, raw),
    keys: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)), remove: async key => values.delete(key) };
  const actual = createExtensionTransport({ databaseURL: `${emulator.base}?ns=${world.name}`, getToken: async () => token(uid),
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).hostname, '127.0.0.1'); assert.equal(new URL(url).port, String(emulator.port));
      if (['PUT', 'PATCH'].includes(options.method)) {
        if (faults.offline) throw Error('offline before send');
        faults.calls.push({ method: options.method, pathname: new URL(url).pathname, bytes: options.body });
      }
      const response = await fetch(url, options);
      if (faults.loseReply && ['PUT', 'PATCH'].includes(options.method)) throw Error('lost reply after server commit');
      return response;
    } });
  const transport = { ...actual, enforcesPhysicalIdentity: true };
  const attachment = { uid, owner: `uid_${uid}`, device: 'proof-device', generation: 1 };
  const options = { storage, transport, identity: () => attachment, randomId: () => `extension_${++sequence}` };
  return { world, values, storage, faults, transport, attachment, options, queue: createPendingWrites(options), owner: `uid_${uid}` };
}
for (const uid of ['alice', 'bob']) {
  test(`${uid}: canonical extension lost reply retires exactly from all original postimages after restart`, async () => {
    const f = await setup(uid); f.faults.loseReply = true;
    const original = await f.queue.enqueue(uid, entry());
    assert.equal((await f.queue.drain(uid)).reason, 'write-unconfirmed');
    const captured = (await f.queue.snapshot(uid)).queue[0]; f.faults.loseReply = false;
    const reload = createPendingWrites(f.options); assert.equal((await reload.drain(uid)).phase, 'accepted');
    const accepted = (await reload.snapshot(uid)).history.find(op => op.id === original.id);
    assert.deepEqual(accepted.command, captured.command); assert.deepEqual(accepted.entry, entry()); assert.equal(f.faults.calls.length, 1);
  });
  test(`${uid}: a delayed successful response cannot acknowledge across an attachment change`, async () => {
    const f = await setup(uid), put = f.transport.put;
    let release, observed;
    const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { observed = resolve; });
    f.transport.put = async (...args) => { const response = await put(...args); observed(); await held; return response; };
    const original = await f.queue.enqueue(uid, entry()), draining = f.queue.drain(uid);
    await started; f.attachment.generation++; release();
    assert.equal((await draining).reason, 'account-detached');
    const retained = (await f.queue.snapshot(uid)).queue[0];
    assert.equal(retained.id, original.id); assert.equal(retained.phase, 'pending');
    assert.equal((await f.queue.snapshot(uid)).history.length, 0);
    assert.deepEqual(await f.world.read(`rooms/${f.owner}/entries/1000000`), retained.command.patch['entries/1000000']);
    f.transport.put = put;
    assert.equal((await createPendingWrites(f.options).drain(uid)).phase, 'accepted');
    assert.equal(f.faults.calls.length, 1);
  });
  test(`${uid}: permanent operation fence rejects retained extension bytes without abandonment or rebase`, async () => {
    const f = await setup(uid); f.faults.offline = true;
    await f.queue.enqueue(uid, entry()); await f.queue.drain(uid);
    const original = structuredClone((await f.queue.snapshot(uid)).queue[0]);
    assert.equal(await f.world.write(`rooms/${f.owner}/timeAckCancellations/${original.id}`, true, token(uid)), true);
    f.faults.offline = false; await f.queue.drain(uid);
    const retained = (await f.queue.snapshot(uid)).queue[0]; assert.equal(retained.id, original.id);
    assert.deepEqual(retained.command, original.command); assert.deepEqual(retained.entry, original.entry);
    assert.equal(await f.world.read(`rooms/${f.owner}/entries`), null);
    assert.equal(await f.world.write(`rooms/${f.owner}/timeAckCancellations/${original.id}`, null, token(uid)), false);
  });
  for (const changed of ['manual-edit', 'tombstone']) {
    test(`${uid}: mixed writer ${changed} fences an offline extension continuation without replacing its original bytes`, async () => {
      const f = await setup(uid);
      await f.queue.enqueue(uid, entry()); assert.equal((await f.queue.drain(uid)).phase, 'accepted');
      f.faults.offline = true; await f.queue.enqueue(uid, entry(1720000)); await f.queue.drain(uid);
      const original = structuredClone((await f.queue.snapshot(uid)).queue[0]);
      const basis = keys.resolve(await f.world.read(`rooms/${f.owner}/entries`), 1000000);
      const peer = keys.prepare(basis, { ...basis.record, ...(changed === 'tombstone' ? { deleted: true } : { activity: 'Manual correction' }), updatedAt: 1800000 }, 'peer_original');
      assert.equal(await f.world.patch(`rooms/${f.owner}`, peer.patch, token(uid)), true);
      f.faults.offline = false;
      assert.equal((await f.queue.drain(uid)).reason, 'source-changed');
      const retained = (await f.queue.snapshot(uid)).queue[0];
      assert.deepEqual(retained.command, original.command); assert.deepEqual(retained.entry, original.entry);
      assert.deepEqual(await f.world.read(`rooms/${f.owner}/entries/1000000`), peer.patch['entries/1000000']);
      assert.equal(f.faults.calls.length, 1);
    });
    test(`${uid}: lost extension reply followed by ${changed} remains UNKNOWN when its complete acceptance evidence was overwritten`, async () => {
      const f = await setup(uid); f.faults.loseReply = true;
      await f.queue.enqueue(uid, entry()); await f.queue.drain(uid);
      const original = structuredClone((await f.queue.snapshot(uid)).queue[0]);
      const basis = keys.resolve(await f.world.read(`rooms/${f.owner}/entries`), 1000000);
      const peer = keys.prepare(basis, { ...basis.record, ...(changed === 'tombstone' ? { deleted: true } : { activity: 'Manual correction' }), updatedAt: 1800000 }, 'peer_original');
      assert.equal(await f.world.patch(`rooms/${f.owner}`, peer.patch, token(uid)), true);
      f.faults.loseReply = false;
      assert.equal((await createPendingWrites(f.options).drain(uid)).reason, 'source-changed');
      const state = await f.queue.snapshot(uid);
      assert.equal(state.history.length, 0); assert.deepEqual(state.queue[0].command, original.command);
      assert.equal(f.faults.calls.length, 1);
      assert.deepEqual(await f.world.read(`rooms/${f.owner}/entries/1000000`), peer.patch['entries/1000000']);
    });
  }
  test(`${uid}: concurrent app alias creation rejects the entire sealed extension command`, async () => {
    const f = await setup(uid), put = f.transport.put;
    const peer = keys.prepare(keys.resolve({}, 1000000, 'app'), { ...entry(), activity: 'App original' }, 'peer_original');
    f.transport.put = async (...args) => {
      assert.equal(await f.world.patch(`rooms/${f.owner}`, peer.patch, token(uid)), true);
      return put(...args);
    };
    await f.queue.enqueue(uid, entry());
    assert.equal((await f.queue.drain(uid)).phase, 'unknown');
    const raw = await f.world.read(`rooms/${f.owner}/entries`);
    assert.deepEqual(Object.keys(raw), ['e_1000000']); assert.deepEqual(raw.e_1000000, peer.patch['entries/e_1000000']);
    const retained = (await f.queue.snapshot(uid)).queue[0];
    assert.deepEqual(retained.entry, entry()); assert.deepEqual(Object.keys(retained.command.patch), ['entries/1000000']);
    assert.equal((await f.queue.snapshot(uid)).history.length, 0);
  });
  test(`${uid}: legacy extension command without owning device is retained without automatic metadata upgrade`, async () => {
    const f = await setup(uid); await f.queue.enqueue(uid, entry());
    const slot = `ta3-extension-writes-v1:${uid}`, state = JSON.parse(await f.storage.get(slot));
    for (const field of ['v', 'owner', 'device', 'generation']) delete state.queue[0][field];
    await f.storage.set(slot, JSON.stringify(state)); const original = structuredClone(state.queue[0]);
    const result = await f.queue.drain(uid); assert.equal(result.reason, 'captured-owner-device-unproven');
    const retained = (await f.queue.snapshot(uid)).queue[0]; assert.equal(retained.id, original.id);
    assert.deepEqual(retained.entry, original.entry); assert.equal(retained.command, original.command);
    assert.equal(Object.hasOwn(retained, 'device'), false); assert.equal(f.faults.calls.length, 0);
  });
  test(`${uid}: concurrent extension captures preserve causal order independently of random IDs`, async () => {
    const f = await setup(uid), ids = ['extension_zzzz', 'extension_aaaa'];
    const queue = createPendingWrites({ ...f.options, randomId: () => ids.shift() });
    const first = queue.enqueue(uid, entry()), second = queue.enqueue(uid, entry(1720000));
    await Promise.all([first, second]);
    assert.deepEqual((await queue.snapshot(uid)).queue.map(op => op.id), ['extension_zzzz', 'extension_aaaa']);
    assert.equal((await queue.drain(uid)).phase, 'accepted');
    const state = await queue.snapshot(uid);
    assert.equal(state.history.filter(op => op.phase === 'accepted').length, 2); assert.equal(state.queue.length, 0);
    assert.equal((await f.world.read(`rooms/${f.owner}/entries/1000000`)).ts, 1720000);
  });
  test(`${uid}: captured extension source retains owner device and attachment generation`, async () => {
    const f = await setup(uid); await f.queue.enqueue(uid, entry());
    const captured = (await f.queue.snapshot(uid)).queue[0];
    assert.equal(captured.owner, `uid_${uid}`); assert.equal(captured.device, 'proof-device'); assert.equal(captured.generation, 1);
  });
  test(`${uid}: extension enqueue freezes original complete facts before its first storage await`, async () => {
    const f = await setup(uid), original = entry(), captured = structuredClone(original);
    const pending = f.queue.enqueue(uid, original, { domain: 'example.invalid', sessionId: original.id });
    original.ts = 0; original.activity = 'later mutation';
    await pending;
    assert.deepEqual((await f.queue.snapshot(uid)).queue[0].entry, captured);
  });
  test(`${uid}: original extension intake survives failure before outbox import and is recovered once`, async () => {
    const f = await setup(uid), get = f.storage.get;
    f.storage.get = async key => { if (key.startsWith('ta3-extension-writes-v1:')) throw Error('Interrupted before import'); return get(key); };
    await assert.rejects(f.queue.enqueue(uid, entry(), { domain: 'example.invalid', sessionId: 1000000 }));
    const intakes = [...f.values].filter(([key]) => key.startsWith('ta3-extension-capture-v1:'));
    assert.equal(intakes.length, 1); const original = JSON.parse(intakes[0][1]); assert.deepEqual(original.entry, entry());
    f.storage.get = get;
    const reload = createPendingWrites(f.options), state = await reload.snapshot(uid);
    assert.equal(state.queue.length, 1); assert.equal(state.queue[0].id, original.id); assert.deepEqual(state.queue[0].entry, original.entry);
    assert.equal((await reload.snapshot(uid)).queue.length, 1);
  });
  test(`${uid}: actual extension transport atomically extends known identical aliases under canonical rules`, async () => {
    const f = await setup(uid), initial = entry();
    await f.world.seed(`rooms/${f.owner}/entries`, { 1000000: initial, e_1000000: initial });
    await f.queue.enqueue(uid, initial); assert.equal((await f.queue.drain(uid)).phase, 'accepted');
    const original = await f.queue.enqueue(uid, entry(1720000));
    assert.equal((await f.queue.drain(uid)).phase, 'accepted');
    const raw = await f.world.read(`rooms/${f.owner}/entries`);
    assert.deepEqual(Object.keys(raw).sort(), ['1000000', 'e_1000000']);
    assert.deepEqual(raw['1000000'], raw.e_1000000); assert.equal(raw['1000000'].ts, 1720000);
    assert.equal(raw['1000000']._csWrite.operationId, original.id);
    assert.equal(f.faults.calls.length, 1); assert.equal(f.faults.calls[0].method, 'PATCH');
    assert.equal((await f.queue.snapshot(uid)).queue.length, 0);
  });
  for (const corruption of ['outside-path', 'operation-identity']) {
    test(`${uid}: stored extension ${corruption} corruption remains retained before any transport handoff`, async () => {
      const f = await setup(uid); f.faults.offline = true;
      const original = await f.queue.enqueue(uid, entry()); await f.queue.drain(uid);
      const slot = `ta3-extension-writes-v1:${uid}`, state = JSON.parse(await f.storage.get(slot)), operation = state.queue[0];
      if (corruption === 'outside-path') {
        operation.command.patch['settings/unrelated'] = operation.command.patch['entries/1000000'];
        delete operation.command.patch['entries/1000000'];
      } else operation.command.patch['entries/1000000']._csWrite.operationId = 'different_operation';
      await f.storage.set(slot, JSON.stringify(state)); const sealed = structuredClone(operation.command);
      const before = await f.world.read(`rooms/${f.owner}`); f.faults.offline = false;
      await f.queue.drain(uid);
      assert.deepEqual(await f.world.read(`rooms/${f.owner}`), before);
      const retained = (await f.queue.snapshot(uid)).queue.find(item => item.id === original.id);
      assert.ok(retained); assert.deepEqual(retained.command, sealed); assert.equal(f.faults.calls.length, 0);
    });
  }
}

for (const accountChange of [false, true]) {
  test(`extension 401 retry cannot cross ${accountChange ? 'another owner' : 'same-owner reattachment'} generation`, async () => {
    let context = { uid: 'alice', owner: 'uid_alice', device: 'proof-device', generation: 1 }, release, observed;
    const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { observed = resolve; });
    const calls = [], tokens = [];
    const transport = createExtensionTransport({ databaseURL: 'http://127.0.0.1:1', identity: () => context,
      getToken: async (uid, force = false) => { tokens.push(force); return force ? 'new-token' : 'original-token'; },
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), body: options.body });
        if (calls.length === 1) { observed(); await held; }
        return { status: calls.length === 1 ? 401 : 200, json: async () => entry(), headers: { get: () => null } };
      } });
    const request = transport.put('alice', 'entries/1000000', entry(), 'original-etag'); await started;
    context = { ...context, ...(accountChange ? { uid: 'bob', owner: 'uid_bob' } : {}), generation: 3 }; release();
    await assert.rejects(request, /Account detached/);
    assert.equal(calls.length, 1); assert.deepEqual(tokens, [false]);
  });
}

test('credential cache commit cannot deadlock an active outbox capture during sign-out', async () => {
  const source = fs.readFileSync(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
  const extract = name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0] || '';
  let release, started;
  const held = new Promise(resolve => { release = resolve; }), fetching = new Promise(resolve => { started = resolve; });
  const context = { console: { log() {}, warn() {} }, FIREBASE_CONFIG: { apiKey: 'local-only' },
    chrome: { storage: { local: { get: async () => ({ fbRefreshToken: 'original-refresh' }), set: async () => {}, remove: async () => {} } } },
    reportAccountingStatus: async () => {}, fetch: async () => { started(); await held; return { json: async () => ({ id_token: 'refreshed-token' }) }; } };
  vm.createContext(context);
  vm.runInContext(`var uid='alice', authToken='original', activeTab={}, attachmentGeneration=1, transitions=Promise.resolve(), authWrites=Promise.resolve(), trackingFault=null;
    ${extract('transition')} ${extract('commitAuthentication')} ${extract('refreshAuthToken')} ${extract('signOut')}
    var refresh = refreshAuthToken();
    async function flushActiveTab() { await refresh; }
  `, context);
  await fetching;
  const signingOut = vm.runInContext('signOut()', context);
  await new Promise(resolve => setImmediate(resolve)); release();
  const result = await Promise.race([signingOut.then(() => 'signed-out'), new Promise(resolve => setTimeout(() => resolve('blocked-by-refresh-cycle'), 300))]);
  assert.equal(result, 'signed-out'); assert.equal(context.uid, null); assert.equal(context.authToken, null);
});

test('timezone response from an earlier same-owner attachment cannot change later capture classification', async () => {
  const source = fs.readFileSync(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
  const extract = name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0] || '';
  let release, observed;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { observed = resolve; }), writes = [];
  const context = { console: { log() {}, warn() {} }, FIREBASE_CONFIG: { databaseURL: 'http://127.0.0.1/' },
    chrome: { storage: { local: { set: async value => writes.push(value) } } },
    fetch: async () => ({ json: async () => { observed(); await held; return 'UTC'; } }) };
  vm.createContext(context);
  vm.runInContext(`var uid='alice', attachmentGeneration=1, authWrites=Promise.resolve(), userTimezone='America/Phoenix', userTimezoneConfirmed=false;
    ${extract('commitAuthentication')} ${extract('fetchUserTimezone')}`, context);
  const fetching = vm.runInContext("fetchUserTimezone('alice', 'local-token')", context);
  await started; context.attachmentGeneration = 3; release(); await fetching;
  assert.equal(context.userTimezone, 'America/Phoenix'); assert.equal(context.userTimezoneConfirmed, false); assert.equal(writes.length, 0);
  await vm.runInContext("fetchUserTimezone('alice', 'local-token')", context);
  assert.equal(context.userTimezone, 'UTC'); assert.equal(context.userTimezoneConfirmed, true); assert.equal(writes.length, 1);
});

for (const uid of [null, 'alice']) {
  test(`unbound device time remains visible through existing extension status ${uid ? 'beside a signed-in account' : 'while signed out'}`, async () => {
    const source = fs.readFileSync(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
    const report = source.match(/async function reportAccountingStatus\([^]*?\n\}/)[0], badges = [], titles = [];
    const quarantined = JSON.stringify({ phase: 'unknown', reason: 'legacy-account-unproven', activeTab: { title: 'Private old source' } });
    const context = { pendingWrites: { snapshot: async () => ({ queue: [] }), captureFailures: () => [] },
      chrome: { storage: { local: { get: async () => ({ 'ta3-extension-unbound:original': quarantined }) } },
        action: { setBadgeText: async value => badges.push(value), setTitle: async value => titles.push(value) } } };
    vm.createContext(context); vm.runInContext(`var uid=${JSON.stringify(uid)}, attachmentGeneration=1, trackingFault=null; ${report}`, context);
    const result = await vm.runInContext('reportAccountingStatus()', context);
    assert.equal(result.pendingCount, 1); assert.equal(result.operationId, null); assert.equal(result.reason, 'legacy-account-unproven');
    assert.equal(badges[0].text, '!'); assert.match(titles[0].title, /legacy-account-unproven/);
    assert.equal(JSON.stringify(result).includes('Private old source'), false);
    assert.equal(titles[0].title.includes('Private old source'), false);
  });
}
