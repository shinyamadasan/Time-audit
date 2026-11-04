// Historical counterexamples pinned to checkpoint 021d1ee. Current extension prevention
// is exercised by physical-writer.test.js and extension-interruption.test.js.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { accountingCommandRules } from './rules.js';
await import('../time-ack.js');
const core = globalThis.TimeAckCore;
const canonical = fs.readFileSync(new URL('./legacy-rules-73739e9.json', import.meta.url), 'utf8');
const extension = fs.readFileSync(new URL('./baseline-extension-log-session.js.txt', import.meta.url), 'utf8');
const storageSource = fs.readFileSync(new URL('./baseline-storage-sync-entries.js.txt', import.meta.url), 'utf8');
const actualLogSession = extension.match(/async function logSession\([^]*?\n\}/)?.[0];
const actualSyncEntries = storageSource.match(/function syncEntries\([^]*?\n\}/)?.[0];
assert.ok(actualLogSession && actualSyncEntries, 'actual physical writers are required');
let emulator;
before(async () => { emulator = await startEmulator(); });
after(() => emulator?.stop());

async function extensionWorld(uid, rules) {
  const world = await emulator.fresh(rules), persisted = {}, statuses = [], owner = `uid_${uid}`;
  const context = { uid, authToken: token(uid), trackedSites: { 'example.invalid': { label: 'Browser evidence', energy: 'waste' } },
    lastSessionByDomain: {}, MERGE_WINDOW_MS: 600000, userTimezoneConfirmed: true,
    FIREBASE_CONFIG: { databaseURL: `${emulator.base}/` }, console: { log() {}, warn() {} },
    chrome: { storage: { local: { set: async value => Object.assign(persisted, structuredClone(value)) } } },
    refreshAuthToken: async () => false, toDateKey: () => '2026-10-28', getBucket: record => record.energy,
    fetch: async (url, options) => {
      const target = new URL(url); assert.equal(target.hostname, '127.0.0.1');
      target.searchParams.set('ns', world.name);
      const response = await fetch(target, options); statuses.push(response.status); return response;
    },
  };
  vm.createContext(context); vm.runInContext(actualLogSession, context);
  await vm.runInContext("logSession('example.invalid', 'Fixture', 1000000, 1600000, 600000)", context);
  return { world, owner, persisted, statuses };
}
for (const uid of ['alice', 'bob']) {
  test(`${uid}: strict accounting gate refuses the actual extension writer after its merge cursor is already advanced`, async () => {
    const env = await extensionWorld(uid, accountingCommandRules());
    assert.deepEqual(env.statuses, [401]);
    assert.deepEqual(env.persisted.lastSessionByDomain, { 'example.invalid': { startTs: 1000000, endTs: 1600000 } });
    assert.deepEqual(Object.keys(env.persisted), ['lastSessionByDomain'], 'no durable full pending command retained');
    assert.equal(await env.world.read(`rooms/${env.owner}/entries/1000000`), null);
  });
  test(`${uid}: canonical extension numeric key plus actual app sync produces an alias that entry-only Undo cannot resolve`, async () => {
    const env = await extensionWorld(uid, canonical);
    assert.deepEqual(env.statuses, [200]);
    const entry = await env.world.read(`rooms/${env.owner}/entries/1000000`);
    const context = { entries: [entry], ownedRoomRef: () => ({ update: async patch => {
      assert.equal(await env.world.patch(`rooms/${env.owner}`, patch, token(uid)), true);
    } }), publishPublicStats() {}, notifySyncWriteFailed(error) { throw error; } };
    vm.createContext(context); vm.runInContext(actualSyncEntries, context);
    await vm.runInContext('syncEntries()', context);
    assert.deepEqual(Object.keys(await env.world.read(`rooms/${env.owner}/entries`)).sort(), ['1000000', 'e_1000000']);
    const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const engine = core.createTimeAck({ storage, lock: (_owner, fn) => fn(), randomId: () => 'original_undo_alias',
      transport: core.createRestTransport({ databaseURL: `${emulator.base}?ns=${env.world.name}`,
        getIdToken: async () => token(uid), fetchImpl: fetch }) });
    const result = await engine.begin({ owner: env.owner, uid, device: 'fixture', session: null, label: 'entry-only Undo',
      records: { 'entries/e_1000000': { ...entry, deleted: true, updatedAt: 1700000 } },
      local: { records: { 'entries/e_1000000': entry } }, proposedLocal: {}, agrees: actual => core.same(actual['entries/e_1000000'], entry) });
    assert.equal(result.operation.phase, 'accepted');
    const server = await env.world.read(`rooms/${env.owner}/entries`);
    assert.equal(server.e_1000000.deleted, true);
    assert.equal(server['1000000'].deleted, undefined, 'same logical ID remains authoritative at the physical source');
  });
}
