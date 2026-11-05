import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {startEmulator, token} from '../rtdb-emulator-support.js';
import {copy, intent} from '../stale-contract/contract.js';
import {same, accountingRules, createLifecycle} from './lifecycle.js';
import {project, hashes} from './engine-fixture.js';
import {setup, cleanup, frameFor, start, saved, now} from './fixtures.js';
const OUT = new URL('../review-artifacts/task-039-time-ack/', import.meta.url);
fs.mkdirSync(OUT, {recursive: true});
let emulator;
const observations = [];
before(async () => {emulator = await startEmulator();});
after(() => {
  emulator?.stop(); cleanup();
  fs.writeFileSync(new URL('OBSERVATIONS.json', OUT), JSON.stringify({scope: 'LOCAL proof fixture only', observations}, null, 2) + '\n');
  fs.writeFileSync(new URL('EXTRACTED_FUNCTION_HASHES.json', OUT), JSON.stringify(hashes, null, 2) + '\n');
  fs.writeFileSync(new URL('TEST_ONLY_RULES.json', OUT), JSON.stringify(accountingRules(), null, 2) + '\n');
});
function prepare(fixture, kind = 'undo', id = 'operation-1', time = now) {
  const original = fixture.lifecycle.snapshot().frame;
  const projection = project(original, kind, time);
  const result = fixture.lifecycle.prepare({id, kind, projection});
  assert.ok(same(fixture.lifecycle.snapshot().frame, original), 'projection never mutates live accounting');
  return result;
}
async function preserveHistory(fixture, operation) {
  const remote = await fixture.world.read(fixture.path + '/entries');
  for (const entry of fixture.frame.entries.slice(1)) assert.deepEqual(remote[`e_${entry.id}`], entry);
  for (const path of Object.keys(operation.patch).filter(path => path.startsWith('entries/'))) {
    const record = await fixture.world.read(fixture.path + '/' + path);
    assert.deepEqual(record, operation.patch[path]);
  }
}

for (const uid of ['alice', 'bob']) {
  test(`${uid}: accepted actual Undo applies once; original record timestamps and historical data survive`, async () => {
    const f = await setup(emulator, uid), operation = prepare(f);
    assert.equal(operation.phase, 'intent');
    assert.equal((await f.lifecycle.submit()).phase, 'accepted');
    assert.ok(same(f.lifecycle.snapshot().frame, f.frame), 'network success alone has no local effect');
    assert.equal(f.lifecycle.apply(), true); assert.equal(f.lifecycle.apply(), false);
    const local = f.lifecycle.snapshot(); assert.equal(local.frame.undo, null);
    assert.equal(local.frame.timer.taskStartTime, start); assert.equal(local.frame.timer.blockStartTime, start);
    assert.equal(local.applications, 1); assert.equal(local.frame.entries[0].tsStart, start); assert.equal(local.frame.entries[0].ts, saved);
    const restored = f.open(); assert.equal(restored.apply(), false); assert.equal(restored.snapshot().applications, 1);
    await preserveHistory(f, operation);
    observations.push({case: 'accepted-once', uid, authoritativeAck: true, logicalApplications: 1});
  });

  test(`${uid}: concurrent edit makes actual entry CAS fail atomically; Undo/cursor stay original`, async () => {
    const f = await setup(emulator, uid), operation = prepare(f);
    const original = copy(f.frame.entries[0]);
    const changed = intent(f.frame.owner, 'entries/e_1213', original, {...original, note: 'Concurrent valid correction', updatedAt: now + 1}).after;
    f.transport.beforeWrite = async () => {assert.equal(await f.world.write(f.path + '/entries/e_1213', changed, token(uid)), true);};
    const response = await f.lifecycle.submit(); assert.equal(response.phase, 'refused');
    assert.equal(response.evidence.authority, 'server-refusal'); assert.equal(f.lifecycle.apply(), false);
    assert.ok(same(f.lifecycle.snapshot().frame, f.frame)); assert.deepEqual(await f.world.read(f.path + '/timer'), f.frame.timer);
    assert.deepEqual(await f.world.read(f.path + '/entries/e_1213'), changed);
    assert.equal(f.lifecycle.snapshot().operation.patch['entries/e_1213'].updatedAt, operation.patch['entries/e_1213'].updatedAt);
    observations.push({case: 'stale-refusal', uid, undoRetained: true, cursorUnchanged: true, serverTimerUnchanged: true});
  });

  test(`${uid}: lost response then reload recovers exact server post-image; duplicate never reapplies`, async () => {
    const f = await setup(emulator, uid), operation = prepare(f);
    f.transport.loseReply = true;
    assert.equal((await f.lifecycle.submit()).phase, 'unknown'); assert.equal(f.lifecycle.apply(), false);
    assert.ok(same(f.lifecycle.snapshot().frame, f.frame));
    const reloaded = f.open();
    assert.equal((await reloaded.recover()).phase, 'accepted'); assert.equal(reloaded.apply(), true);
    f.transport.loseReply = false;
    assert.equal((await reloaded.submit()).phase, 'accepted'); assert.equal(reloaded.apply(), false);
    assert.equal(f.transport.writes, 1); assert.equal(reloaded.snapshot().applications, 1);
    assert.equal(await f.world.patch(f.path, operation.patch, token(uid)), false, 'raw duplicate CAS rejected');
    await preserveHistory(f, operation);
    observations.push({case: 'lost-response-reload', uid, identity: operation.id, exactFrozenPatchRecovered: true});
  });

  test(`${uid}: offline before submission retains intent, Undo and timestamps through durable reload`, async () => {
    const f = await setup(emulator, uid), operation = prepare(f), serialized = JSON.parse(f.store.read());
    f.transport.offline = true;
    assert.equal((await f.lifecycle.submit()).phase, 'unknown'); assert.equal(f.transport.writes, 0);
    assert.equal(f.lifecycle.apply(), false); assert.ok(same(f.lifecycle.snapshot().frame, f.frame));
    const reloaded = f.open(); assert.deepEqual(reloaded.snapshot().operation.before, serialized.operation.before);
    f.transport.offline = false;
    assert.equal((await reloaded.submit()).phase, 'accepted'); assert.equal(reloaded.apply(), true);
    assert.equal(reloaded.snapshot().operation.patch['entries/e_1213'].updatedAt, now, 'no retry-clock restamping');
    await preserveHistory(f, operation);
  });

  test(`${uid}: lost result followed by later server edit remains UNKNOWN, never inferred refused/accepted`, async () => {
    const f = await setup(emulator, uid), op = prepare(f);
    f.transport.loseReply = true; assert.equal((await f.lifecycle.submit()).phase, 'unknown');
    const acceptedEntry = op.patch['entries/e_1213'];
    const changed = intent(f.frame.owner, 'entries/e_1213', acceptedEntry,
      {...acceptedEntry, note: 'Later allowed tombstone metadata correction', updatedAt: now + 1}).after;
    assert.equal(await f.world.write(f.path + '/entries/e_1213', changed, token(uid)), true);
    const reloaded = f.open(); assert.equal((await reloaded.recover()).phase, 'unknown');
    assert.equal(reloaded.apply(), false); assert.ok(same(reloaded.snapshot().frame, f.frame));
    assert.equal((await reloaded.submit()).phase, 'unknown'); assert.equal(f.transport.writes, 1, 'no new-base replay');
    assert.throws(() => prepare({...f, lifecycle: reloaded}, 'undo', 'different-id'), /barrier/);
    observations.push({case: 'advanced-state-unknown', uid, noAutomaticReauthorization: true, retainsFullRecoveryState: true});
  });

  test(`${uid}: wrong-account write is refused; account/device/session changes cannot apply another frame`, async () => {
    const f = await setup(emulator, uid); prepare(f);
    f.transport.writeUid = uid === 'alice' ? 'bob' : 'alice';
    assert.equal((await f.lifecycle.submit()).phase, 'refused'); assert.equal(f.lifecycle.apply(), false);
    const good = await setup(emulator, uid); prepare(good);
    assert.equal((await good.lifecycle.submit()).phase, 'accepted');
    for (const [key, value] of [['owner', 'uid_other'], ['device', 'device-b'], ['session', 'replacement-session']]) {
      const old = good.active[key]; good.active[key] = value; assert.equal(good.lifecycle.apply(), false); good.active[key] = old;
    }
    assert.ok(same(good.lifecycle.snapshot().frame, good.frame)); assert.equal(good.lifecycle.apply(), true);
    assert.throws(() => createLifecycle({store: good.store, owner: 'uid_other', active: () => good.active, transport: good.transport}).snapshot(), /Wrong account/);
  });

  test(`${uid}: actual Save followed by actual Undo preserves the original span and applies each once`, async () => {
    const f = await setup(emulator, uid), save = prepare(f, 'save', 'save-1', now);
    assert.equal((await f.lifecycle.submit()).phase, 'accepted'); assert.equal(f.lifecycle.apply(), true);
    const savedFrame = f.lifecycle.snapshot().frame, entry = savedFrame.entries[0];
    assert.equal(entry.tsStart, saved); assert.equal(entry.ts, now); assert.equal(entry.blockIntervalMin, 2);
    assert.equal(savedFrame.timer.taskStartTime, now); assert.equal(savedFrame.undo.timerCursor.taskStart, saved);
    assert.equal(savedFrame.undo.timerCursor.savedThrough, now);
    assert.equal(await f.world.patch(f.path, save.patch, token(uid)), false);
    const undo = prepare(f, 'undo', 'undo-2', now + 60000);
    assert.equal((await f.lifecycle.submit()).phase, 'accepted'); assert.equal(f.lifecycle.apply(), true); assert.equal(f.lifecycle.apply(), false);
    const final = f.lifecycle.snapshot(); assert.equal(final.applications, 2); assert.equal(final.frame.timer.taskStartTime, saved);
    assert.equal(final.frame.undo, null); assert.equal(final.frame.entries.find(item => item.id === now).deleted, true);
    assert.equal(final.frame.entries.find(item => item.id === 1213).deleted, undefined);
    assert.deepEqual(await f.world.read(f.path + '/entries/e_1213'), f.frame.entries[0]);
    assert.equal(undo.patch[`entries/e_${now}`].tsStart, saved); assert.equal(undo.patch[`entries/e_${now}`].ts, now);
    observations.push({case: 'actual-save-undo-cycle', uid, interval: [saved, now], unchangedCalculationResult: 2});
  });
}

test('actual Save extension and restore-Undo use the authoritative current tombstone/revision, not old snapshot counters', async () => {
  const f = await setup(emulator), save = prepare(f, 'save', 'extend-1');
  // Recompute with the same activity to exercise the unchanged extension formula.
  const g = await setup(emulator), projection = project(g.frame, 'save', now, {activity: 'Work'});
  g.lifecycle.prepare({id: 'extend-actual', kind: 'save', projection});
  assert.equal((await g.lifecycle.submit()).phase, 'accepted'); assert.equal(g.lifecycle.apply(), true);
  assert.equal(g.lifecycle.snapshot().frame.entries[0].blockIntervalMin, 12);
  assert.equal(g.lifecycle.snapshot().frame.undo.type, 'restore-entries');
  const undo = prepare(g, 'undo', 'restore-2', now + 60000);
  assert.equal(undo.patch['entries/e_1213']._csWrite.baseRevision, 2);
  assert.equal((await g.lifecycle.submit()).phase, 'accepted'); assert.equal(g.lifecycle.apply(), true);
  const restored = g.lifecycle.snapshot().frame.entries[0];
  assert.equal(restored.tsStart, start); assert.equal(restored.ts, saved); assert.equal(restored.blockIntervalMin, 10);
  assert.deepEqual(restored.metadata, g.frame.entries[0].metadata); assert.equal(restored.undoRestoredAt, now + 60000);
  assert.equal(save.patch[`entries/e_${now}`].tsStart, saved); assert.equal(f.lifecycle.snapshot().applications, 0);
});

test('rejected actual Undo followed by actual Save does not re-record the prior live span', async () => {
  const f = await setup(emulator); prepare(f);
  f.transport.beforeWrite = async () => {
    const changed = intent(f.frame.owner, 'entries/e_1213', f.frame.entries[0], {...f.frame.entries[0], note: 'Remote correction'}).after;
    assert.equal(await f.world.write(f.path + '/entries/e_1213', changed, token('alice')), true);
  };
  assert.equal((await f.lifecycle.submit()).phase, 'refused'); assert.equal(f.lifecycle.apply(), false);
  f.transport.beforeWrite = null;
  const save = prepare(f, 'save', 'new-save-after-refusal');
  assert.equal((await f.lifecycle.submit()).phase, 'accepted'); assert.equal(f.lifecycle.apply(), true);
  const next = save.patch[`entries/e_${now}`]; assert.equal(next.tsStart, saved);
  const prior = await f.world.read(f.path + '/entries/e_1213'); assert.equal(prior.deleted, undefined);
  assert.ok(next.tsStart >= prior.ts); assert.equal(f.lifecycle.snapshot().applications, 1);
});

test('current device takeover after prepare refuses the old session atomically; legacy timer blind write is denied', async () => {
  const f = await setup(emulator); prepare(f);
  f.transport.beforeWrite = async () => {
    const replacement = intent(f.frame.owner, 'timer', f.frame.timer,
      {...f.frame.timer, ownerDeviceId: 'device-b', taskStartTime: now, blockStartTime: now, updatedAt: now}).after;
    assert.equal(await f.world.write(f.path + '/timer', replacement, token('alice')), true);
  };
  assert.equal((await f.lifecycle.submit()).phase, 'refused'); assert.equal(f.lifecycle.apply(), false);
  assert.equal((await f.world.read(f.path + '/timer')).ownerDeviceId, 'device-b');
  assert.deepEqual(await f.world.read(f.path + '/entries/e_1213'), f.frame.entries[0]);
  assert.equal(await f.world.write(f.path + '/timer', {...f.frame.timer, updatedAt: now + 1}, token('alice')), false);
  const foreign = frameFor('alice'); foreign.device = 'device-b'; const g = await setup(emulator, 'alice', foreign);
  assert.throws(() => prepare(g), /guard/);
});

test('accepted but newer local Stop/replacement is not rolled back by late acknowledgement application', async () => {
  const f = await setup(emulator); prepare(f); assert.equal((await f.lifecycle.submit()).phase, 'accepted');
  const newer = JSON.parse(f.store.read()); newer.frame.timer.running = false; newer.frame.generation++;
  f.store.write(JSON.stringify(newer)); assert.equal(f.lifecycle.apply(), false);
  assert.equal(f.lifecycle.snapshot().frame.timer.running, false); assert.equal(f.lifecycle.snapshot().operation.phase, 'accepted');
  assert.equal(f.lifecycle.snapshot().operation.applied, false);
});

test('staging failure performs no domain write; local-apply failure retains full original frame and can recover', async () => {
  const f = await setup(emulator); f.store.failBefore = true;
  assert.throws(() => prepare(f), /quota/); assert.equal(f.transport.reads, 0); assert.equal(f.transport.writes, 0);
  assert.equal(f.lifecycle.snapshot().operation, null); assert.ok(same(f.lifecycle.snapshot().frame, f.frame));
  prepare(f); assert.equal((await f.lifecycle.submit()).phase, 'accepted');
  f.store.failBefore = true; assert.throws(() => f.lifecycle.apply(), /quota/);
  assert.ok(same(f.lifecycle.snapshot().frame, f.frame)); assert.equal(f.open().apply(), true);
  assert.equal(f.open().snapshot().applications, 1);
});

test('crash after local durable application cannot consume Undo or rewind a second time on reload', async () => {
  const f = await setup(emulator); prepare(f); assert.equal((await f.lifecycle.submit()).phase, 'accepted');
  f.store.failAfter = true; assert.throws(() => f.lifecycle.apply(), /interruption/);
  const restored = f.open(); assert.equal(restored.snapshot().applications, 1); assert.equal(restored.apply(), false);
  assert.equal(restored.snapshot().frame.timer.taskStartTime, start);
});

test('interrupted accepted-receipt persistence recovers from original pending envelope and server evidence', async () => {
  const f = await setup(emulator); prepare(f);
  f.transport.afterWrite = () => {f.store.failBefore = true;};
  await assert.rejects(f.lifecycle.submit(), /quota/);
  assert.equal(f.lifecycle.snapshot().operation.phase, 'pending'); assert.ok(same(f.lifecycle.snapshot().frame, f.frame));
  const reloaded = f.open(); assert.equal((await reloaded.recover()).phase, 'accepted'); assert.equal(reloaded.apply(), true);
  assert.equal(reloaded.snapshot().applications, 1); assert.equal(f.transport.writes, 1);
});

test('unknown pre-state retry retains identity and frozen timestamps; later refusal cannot disprove an uncertain earlier attempt', async () => {
  const f = await setup(emulator), original = prepare(f);
  f.transport.beforeWrite = () => {throw new Error('request lost before reaching server');};
  assert.equal((await f.lifecycle.submit()).phase, 'unknown');
  const reloaded = f.open(); assert.equal((await reloaded.recover()).phase, 'unknown');
  assert.equal(reloaded.snapshot().operation.retrySafe, true);
  f.transport.beforeWrite = async () => {
    const changed = intent(f.frame.owner, 'entries/e_1213', f.frame.entries[0], {...f.frame.entries[0], note: 'Concurrent change'}).after;
    assert.equal(await f.world.write(f.path + '/entries/e_1213', changed, token('alice')), true);
  };
  assert.equal((await reloaded.submit()).phase, 'unknown', 'a retry denial is not proof the original attempt was refused');
  assert.deepEqual(reloaded.snapshot().operation.patch, original.patch);
  assert.equal(reloaded.apply(), false); assert.ok(same(reloaded.snapshot().frame, f.frame));
});

test('recovery read failure and forged/optimistic local UI data never establish acceptance', async () => {
  const f = await setup(emulator); prepare(f); f.transport.offline = true;
  assert.equal((await f.lifecycle.recover()).phase, 'unknown');
  const ui = project(f.frame, 'undo', now); assert.equal(ui.frame.undo, null);
  assert.equal(f.lifecycle.apply(), false); assert.ok(same(f.lifecycle.snapshot().frame, f.frame));
  assert.equal(await f.world.read(f.path + '/entries/e_1213').then(entry => entry.deleted), undefined);
});

test('strict controls: disabling timer gate admits legacy rewind; deferring local application alone does not enforce server cursor safety', async () => {
  const f = await setup(emulator, 'alice', frameFor('alice'), accountingRules({timerGate: false}));
  assert.equal(await f.world.write(f.path + '/timer', {...f.frame.timer, taskStartTime: start, updatedAt: now}, token('alice')), true);
  const protectedWorld = await setup(emulator);
  assert.equal(await protectedWorld.world.write(protectedWorld.path + '/timer', {...protectedWorld.frame.timer, taskStartTime: start, updatedAt: now}, token('alice')), false);
  observations.push({case: 'timer-gate-negative-control', unsafeMutationAcceptedOnlyWithoutGate: true});
});

test('pending accounting barrier preserves subsequent requested intent; unsupported physical deletion/focus side effects fail explicitly', async () => {
  const f = await setup(emulator), op = prepare(f);
  assert.throws(() => prepare(f, 'save', 'save-while-pending'), /barrier/);
  assert.deepEqual(f.lifecycle.snapshot().operation.patch, op.patch);
  const g = await setup(emulator), projected = project(g.frame, 'undo', now);
  projected.frame.entries.shift(); assert.throws(() => g.lifecycle.prepare({id: 'remove-physical', kind: 'undo', projection: projected}), /explicit tombstone/);
  const focus = project(g.frame, 'undo', now); focus.frame.focusRedemptions.push({id: 'unmodeled'});
  assert.throws(() => g.lifecycle.prepare({id: 'focus', kind: 'undo', projection: focus}), /outside/);
});

test('fresh process recovers lost acknowledgement from durable identity/state plus authenticated server read', async () => {
  const f = await setup(emulator), op = prepare(f); f.transport.loseReply = true;
  assert.equal((await f.lifecycle.submit()).phase, 'unknown');
  const worker = spawnSync(process.execPath, ['time-ack-proof/reload-worker.mjs', f.store.file,
    emulator.base, f.world.name, f.active.owner, f.active.device, f.active.session], {encoding: 'utf8', timeout: 15000});
  assert.equal(worker.status, 0, worker.stderr || worker.error?.message);
  const result = JSON.parse(worker.stdout); assert.deepEqual(result,
    {phase: 'accepted', first: true, second: false, applications: 1, cursor: start, writes: 0});
  assert.equal(f.open().apply(), false); await preserveHistory(f, op);
  observations.push({case: 'fresh-process-reload', ...result, originalPromiseUnavailable: true});
});

test('unknown unchanged pre-state permits only the exact original retry; retry clocks and identity do not drift', async () => {
  const f = await setup(emulator), op = prepare(f);
  f.transport.beforeWrite = () => {throw new Error('request never reached server');};
  assert.equal((await f.lifecycle.submit()).phase, 'unknown'); f.transport.beforeWrite = null;
  const restored = f.open(); assert.equal((await restored.recover()).phase, 'unknown');
  assert.equal(restored.snapshot().operation.retrySafe, true);
  assert.equal((await restored.submit()).phase, 'accepted'); assert.equal(restored.apply(), true);
  assert.deepEqual(restored.snapshot().operation.patch, op.patch);
  assert.equal(restored.snapshot().operation.attempts, 2); assert.equal(restored.snapshot().applications, 1);
});

test('account switch while read is in flight prevents submission; switch during response cannot apply into another account', async () => {
  const f = await setup(emulator); prepare(f);
  const read = f.transport.read;
  f.transport.read = async (...args) => {const value = await read(...args); f.active.owner = 'uid_bob'; return value;};
  assert.equal((await f.lifecycle.submit()).phase, 'intent'); assert.equal(f.transport.writes, 0);
  f.active.owner = 'uid_alice'; f.transport.read = read;
  f.transport.afterWrite = () => {f.active.owner = 'uid_bob';};
  assert.equal((await f.lifecycle.submit()).phase, 'accepted'); assert.equal(f.lifecycle.apply(), false);
  assert.ok(same(f.lifecycle.snapshot().frame, f.frame));
  f.active.owner = 'uid_alice'; assert.equal(f.lifecycle.apply(), true);
});

test('stopped-session Undo keeps stopped cursor semantics; no active-device cursor is fabricated', async () => {
  const frame = frameFor('alice'); frame.timer.running = false; frame.timer.stopped = true;
  delete frame.timer.ownerDeviceId;
  const f = await setup(emulator, 'alice', frame); prepare(f);
  assert.equal((await f.lifecycle.submit()).phase, 'accepted'); assert.equal(f.lifecycle.apply(), true);
  const local = f.lifecycle.snapshot().frame;
  assert.equal(local.timer.running, false); assert.equal(local.timer.taskStartTime, saved);
  assert.equal(local.undo, null); assert.equal(local.timer.ownerDeviceId, undefined);
});

test('multi-entry source tombstone and replacement descendants commit together with frozen times, or not at all', async () => {
  const f = await setup(emulator), projection = project(f.frame, 'undo', now);
  projection.frame.entries.push({id: 2213, tsStart: start, ts: start + 300000, blockIntervalMin: 5,
    date: '2026-10-28', activity: 'Replacement A', energy: 'deep', updatedAt: now},
  {id: 2214, tsStart: start + 300000, ts: saved, blockIntervalMin: 5,
    date: '2026-10-28', activity: 'Replacement B', energy: 'deep', updatedAt: now});
  const op = f.lifecycle.prepare({id: 'batch-1', kind: 'replace-batch', projection});
  f.transport.beforeWrite = async () => {
    const collision = {...projection.frame.entries.at(-1), activity: 'Existing valid record', _csWrite: {v: 1, baseExists: false, baseRevision: 0, revision: 1}};
    assert.equal(await f.world.write(f.path + '/entries/e_2214', collision, token('alice')), true);
  };
  assert.equal((await f.lifecycle.submit()).phase, 'refused'); assert.equal(f.lifecycle.apply(), false);
  assert.deepEqual(await f.world.read(f.path + '/entries/e_1213'), f.frame.entries[0]);
  assert.equal(await f.world.read(f.path + '/entries/e_2213'), null);
  assert.deepEqual(await f.world.read(f.path + '/timer'), f.frame.timer);
  const g = await setup(emulator); g.lifecycle.prepare({id: 'batch-2', kind: 'replace-batch', projection});
  assert.equal((await g.lifecycle.submit()).phase, 'accepted'); assert.equal(g.lifecycle.apply(), true);
  for (const id of [2213, 2214]) {
    const record = await g.world.read(g.path + '/entries/e_' + id);
    assert.equal(record.tsStart, op.patch['entries/e_' + id].tsStart); assert.equal(record.ts, op.patch['entries/e_' + id].ts);
  }
  observations.push({case: 'multi-entry-atomicity', conflictLeavesNoPartialReplacement: true, completeBatchAllowed: true});
});

test('partial transport and incomplete 200 response remain UNKNOWN and cannot apply local accounting', async () => {
  const f = await setup(emulator); prepare(f);
  const patch = f.transport.patch;
  f.transport.patch = (owner, body) => patch(owner, {'entries/e_1213': body['entries/e_1213']});
  assert.equal((await f.lifecycle.submit()).phase, 'unknown'); assert.equal(f.lifecycle.apply(), false);
  assert.ok(same(f.lifecycle.snapshot().frame, f.frame));
  assert.deepEqual(await f.world.read(f.path + '/timer'), f.frame.timer);
  assert.equal((await f.lifecycle.recover()).phase, 'unknown', 'one matching child is not a complete batch receipt');
  observations.push({case: 'split-transport-negative-control', remotePartialPossibleForArbitraryOwnerCode: true,
    partialAckNotAcceptedByCoordinator: true});
});

test('simultaneous duplicate submissions cannot downgrade an accepted receipt or apply local consequences twice', async () => {
  const f = await setup(emulator); prepare(f);
  const responses = await Promise.all([f.lifecycle.submit(), f.open().submit()]);
  assert.ok(responses.some(response => response.phase === 'accepted'));
  assert.equal(f.lifecycle.snapshot().operation.phase, 'accepted');
  assert.equal(f.lifecycle.apply(), true); assert.equal(f.open().apply(), false);
  assert.equal(f.lifecycle.snapshot().applications, 1);
});

test('pre-cutover unversioned timer mismatch is rejected by exact authoritative before-image check', async () => {
  const f = await setup(emulator); prepare(f);
  // Seed represents a different pre-cutover snapshot with the same implicit revision zero.
  await f.world.seed(f.path + '/timer', {...f.frame.timer, taskStartTime: saved + 60000, updatedAt: now});
  assert.equal((await f.lifecycle.submit()).phase, 'refused'); assert.equal(f.transport.writes, 0);
  assert.equal(f.lifecycle.apply(), false); assert.ok(same(f.lifecycle.snapshot().frame, f.frame));
});

test('a proposal captured before a local accounting change cannot be silently staged against a new base', async () => {
  const f = await setup(emulator), proposal = project(f.frame, 'undo', now);
  const changed = JSON.parse(f.store.read()); changed.frame.generation++; changed.frame.timer.running = false;
  f.store.write(JSON.stringify(changed));
  assert.throws(() => f.lifecycle.prepare({id: 'stale-projection', kind: 'undo', projection: proposal}), /original state changed/);
  assert.equal(f.transport.writes, 0); assert.equal(f.lifecycle.snapshot().operation, null);
  assert.equal(f.lifecycle.snapshot().frame.timer.running, false);
});

test('actual restore-Undo legitimately restores a tombstoned entry using the current tombstone base', async () => {
  const frame = frameFor('alice'), original = copy(frame.entries[0]);
  frame.entries[0] = {...frame.entries[0], deleted: true, updatedAt: now,
    _csWrite: {v: 1, baseExists: true, baseRevision: 1, revision: 2}};
  frame.undo = {type: 'restore-entries', label: 'delete', entries: [original], createdAt: now};
  const f = await setup(emulator, 'alice', frame), op = prepare(f, 'undo', 'undo-deletion', now + 60000);
  assert.equal(op.patch['entries/e_1213']._csWrite.baseRevision, 2);
  assert.equal(op.patch['entries/e_1213'].deleted, undefined);
  assert.equal((await f.lifecycle.submit()).phase, 'accepted'); assert.equal(f.lifecycle.apply(), true);
  const restored = await f.world.read(f.path + '/entries/e_1213');
  assert.equal(restored.undoRestoredAt, now + 60000); assert.equal(restored.tsStart, original.tsStart); assert.equal(restored.ts, original.ts);
  assert.deepEqual(restored.metadata, original.metadata);
});
