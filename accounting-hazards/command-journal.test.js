import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { accountingCommandRules } from './rules.js';
await import('../time-ack.js');
await import('./command-journal.js');
const core = globalThis.TimeAckCore;
const { createJournal } = globalThis.AccountingCommandJournal;
let emulator, sequence = 0;
before(async () => { emulator = await startEmulator(); });
after(() => emulator?.stop());
const memory = () => { const values = new Map(); return {
  getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
}; };
function mutex() { let tail = Promise.resolve(); return (_owner, fn) => {
  const result = tail.then(fn); tail = result.catch(() => {}); return result;
}; }
async function setup(uid) {
  const world = await emulator.fresh(accountingCommandRules()), owner = `uid_${uid}`, storage = memory(), lock = mutex();
  const entry = { id: 1, tsStart: 1000000, ts: 1600000, blockIntervalMin: 10, activity: 'Work', energy: 'deep', updatedAt: 1600000 };
  const timer = { ownerRoom: owner, ownerDeviceId: 'device-a', running: true, taskStartTime: 1600000,
    blockStartTime: 1600000, trackingStartedAt: 1000000, updatedAt: 1600000 };
  const before = { 'entries/e_1': entry, timer }, after = {
    'entries/e_1': { ...entry, ts: 1720000, blockIntervalMin: 12, updatedAt: 1720000 },
    timer: { ...timer, taskStartTime: 1720000, blockStartTime: 1720000, updatedAt: 1720000 },
  };
  await world.seed(`rooms/${owner}`, { timer, entries: { e_1: entry } });
  const real = core.createRestTransport({ databaseURL: `${emulator.base}?ns=${world.name}`,
    getIdToken: async () => token(uid), fetchImpl: fetch });
  const faults = { offline: false, loseReply: false, gate: null, patches: 0 };
  const transport = { read: (...args) => { if (faults.offline) throw Error('offline'); return real.read(...args); },
    async patch(...args) {
      faults.patches++; if (faults.gate) await faults.gate;
      const response = await real.patch(...args); if (faults.loseReply) throw Error('reply lost'); return response;
    } };
  const options = { storage, lock, transport, core, randomId: () => `ordinary_${++sequence}` };
  const journal = createJournal(options), local = { value: structuredClone(before) };
  const run = (target = journal, eventId = null) => target.run({ owner, uid, device: 'device-a', name: 'Save', at: 1720000, eventId,
    before, blocked: () => false, capture: () => local.value,
    apply() { local.value = structuredClone(after); target.checkpoint(owner, local.value); target.stage(owner, after); return true; } });
  return { world, owner, storage, lock, before, after, faults, journal, options, run, local };
}
for (const uid of ['alice', 'bob']) {
  test(`${uid}: completed event receipt is checked again under the lock before any stale body runs`, async () => {
    const env = await setup(uid);
    assert.equal((await env.run(env.journal, 'one_frozen_event')).command.phase, 'accepted');
    assert.equal(await env.journal.finalize(env.owner, () => true), true);
    env.local.value = structuredClone(env.before); // another tab captured this stale frame before refresh
    assert.deepEqual(await env.run(env.journal, 'one_frozen_event'), { value: true, command: null, completed: true });
    assert.deepEqual(env.local.value, env.before, 'duplicate body was never invoked');
    assert.equal(env.journal.pending(env.owner), null);
    assert.equal(env.journal.snapshot(env.owner).history.length, 1);
    assert.equal(env.faults.patches, 1);
  });
  test(`${uid}: unknown existing reserved metadata is refused rather than normalized by a later writer`, async () => {
    const env = await setup(uid);
    for (const metadata of [{ v: 99, revision: 7 }, { v: 1, revision: 0 }]) {
      await env.world.seed(`rooms/${env.owner}/entries/e_1`, { ...env.before['entries/e_1'], _csWrite: metadata });
      const proposed = { ...env.after['entries/e_1'], _csWrite: { v: 1, baseExists: true,
        baseRevision: metadata.revision, revision: metadata.revision + 1, operationId: 'other_writer' } };
      assert.equal(await env.world.write(`rooms/${env.owner}/entries/e_1`, proposed, token(uid)), false);
    }
  });
  test(`${uid}: entry and cursor use one durable identity and one atomic publication`, async () => {
    const env = await setup(uid), result = await env.run();
    assert.equal(result.command.phase, 'accepted');
    assert.equal(env.faults.patches, 1);
    const room = await env.world.read(`rooms/${env.owner}`);
    assert.equal(room.entries.e_1._csWrite.operationId, room.timer._csWrite.operationId);
    assert.equal(room.entries.e_1.ts, 1720000); assert.equal(room.timer.taskStartTime, 1720000);
    assert.equal(env.journal.pending(env.owner).draft['entries/e_1'].tsStart, 1000000);
  });
  test(`${uid}: a prior in-flight command holds the account barrier across two clients`, async () => {
    const env = await setup(uid); let release; env.faults.gate = new Promise(resolve => { release = resolve; });
    const first = env.run();
    while (!env.faults.patches) await new Promise(resolve => setTimeout(resolve, 5));
    const second = createJournal(env.options), queued = env.run(second);
    assert.equal(second.pending(env.owner).phase, 'pending'); release();
    assert.equal((await first).command.phase, 'accepted');
    assert.deepEqual(await queued, { blocked: true });
    assert.equal(env.faults.patches, 1);
  });
  test(`${uid}: lost response and newly constructed client recover the same accepted command once`, async () => {
    const env = await setup(uid); env.faults.loseReply = true;
    const original = (await env.run()).command;
    assert.equal(original.phase, 'unknown');
    const reload = createJournal(env.options); assert.equal((await reload.recover(env.owner)).phase, 'accepted');
    let applications = 0;
    assert.equal(await reload.finalize(env.owner, () => { applications++; return true; }), true);
    assert.equal(await reload.finalize(env.owner, () => { applications++; return true; }), false);
    assert.equal(applications, 1);
    assert.deepEqual(reload.snapshot(env.owner).history[0].patch, original.patch);
  });
  test(`${uid}: offline unsent draft survives; concurrent changes refuse the original base without rebasing`, async () => {
    const env = await setup(uid); env.faults.offline = true;
    assert.equal((await env.run()).command.phase, 'ready');
    const remote = { ...env.before['entries/e_1'], note: 'Concurrent correction', updatedAt: 1800000 };
    await env.world.seed(`rooms/${env.owner}/entries/e_1`, remote);
    env.faults.offline = false; const reload = createJournal(env.options);
    assert.equal((await reload.recover(env.owner)).phase, 'conflict');
    assert.equal(env.faults.patches, 0);
    assert.deepEqual(reload.pending(env.owner).draft, env.after);
    assert.deepEqual(await env.world.read(`rooms/${env.owner}/timer`), env.before.timer);
  });
  test(`${uid}: actual process interruption preserves original base and checkpoint; partial command is never sent`, async () => {
    const file = fileURLToPath(new URL(`./interrupted-${uid}.tmp`, import.meta.url));
    try {
      const process = spawnSync(globalThis.process.execPath, [fileURLToPath(new URL('./interrupt-worker.mjs', import.meta.url)), file, uid], { encoding: 'utf8' });
      assert.equal(process.status, 17, process.stderr);
      const storage = { getItem: () => fs.readFileSync(file, 'utf8'), setItem: (_key, value) => fs.writeFileSync(file, value) };
      const journal = createJournal({ storage, lock: (_owner, fn) => fn(), core, randomId: () => 'never',
        transport: { read() { throw Error('no partial publication'); }, patch() { throw Error('no partial publication'); } } });
      assert.equal((await journal.recover(`uid_${uid}`)).phase, 'interrupted');
      assert.equal(journal.pending(`uid_${uid}`).draft.entries[0].ts, 720000);
      assert.equal(journal.pending(`uid_${uid}`).before['entries/e_1'].ts, 600000);
    } finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
  });
}
