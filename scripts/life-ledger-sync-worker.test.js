import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runLifeLedgerSyncWorker,
  LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME,
  LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME,
  LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME
} from './life-ledger-sync-worker.mjs';
import { createObsidianSyncTarget, planObsidianSync, applyObsidianSync, OBSIDIAN_MANIFEST_RELATIVE_PATH } from '../obsidian-life-ledger-sync.js';
import { serializeLifeLedgerSnapshot, createLifeLedgerSnapshotFromEvents } from '../life-ledger-transport.js';

function focusEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: '10101010-1010-4010-8010-101010101010',
    sourceApp: 'chronasense',
    sourceEntityId: 'focus-entry-1',
    type: 'focus_session_completed',
    occurredAt: '2026-08-30T16:00:00.000Z',
    recordedAt: '2026-08-30T16:00:00.000Z',
    revisedAt: null,
    sourceTimezone: 'America/Phoenix',
    payload: {
      activity: 'Synthetic focus', startedAt: '2026-08-30T15:35:00.000Z', endedAt: '2026-08-30T16:00:00.000Z',
      durationMinutes: 25, additiveForTimeTotals: false, source: { focusEntryId: 'focus-entry-1' }
    },
    provenance: {
      source: 'chronasense', sourceRecordKind: 'chronasense.focus_outcome', adapterVersion: 'test-v1',
      observedAt: '2026-08-30T16:00:00.000Z', captureMethod: 'pomodoro', evidence: ['synthetic.focus:1']
    },
    confidence: { score: 1, basis: 'source-recorded' },
    revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null },
    ...overrides
  };
}

function focusEventDay2() {
  return focusEvent({
    eventId: '20202020-2020-4020-8020-202020202020',
    sourceEntityId: 'focus-entry-2',
    occurredAt: '2026-08-31T16:00:00.000Z',
    recordedAt: '2026-08-31T16:00:00.000Z',
    payload: { ...focusEvent().payload, startedAt: '2026-08-31T15:35:00.000Z', endedAt: '2026-08-31T16:00:00.000Z', source: { focusEntryId: 'focus-entry-2' } },
    provenance: { ...focusEvent().provenance, evidence: ['synthetic.focus:2'] }
  });
}

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function seedOwnedVault(vault, events) {
  await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
  const target = createObsidianSyncTarget({ vaultPath: vault, mode: 'test', allowApply: true });
  const plan = await planObsidianSync(target, events);
  await fs.writeFile(path.join(vault, 'TEST-VAULT.md'), 'test vault\n', 'utf8');
  await applyObsidianSync(plan, { mode: 'test', apply: true });
  await fs.rm(path.join(vault, 'TEST-VAULT.md'));
}

async function writeOutbox(outboxDir, events) {
  await fs.mkdir(outboxDir, { recursive: true });
  const json = serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents(events));
  await fs.writeFile(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME), json, 'utf8');
  return json;
}

// A fs adapter that lets the SECOND write to a ".tmp" file (i.e. the second writable op in
// content->manifest->sentinel phase order) fail, simulating a real mid-apply crash.
function breaksOnSecondTmpWriteFs() {
  const real = fs;
  let tmpWriteCount = 0;
  return {
    mkdir: (...a) => real.mkdir(...a),
    readFile: (...a) => real.readFile(...a),
    writeFile: async (p, content, enc) => {
      if (String(p).endsWith('.tmp')) {
        tmpWriteCount++;
        if (tmpWriteCount === 2) throw Object.assign(new Error('simulated disk failure mid-apply'), { code: 'EIO' });
      }
      return real.writeFile(p, content, enc);
    },
    rename: (...a) => real.rename(...a),
    unlink: (...a) => real.unlink(...a),
    readdir: (...a) => real.readdir(...a),
    lstat: (...a) => real.lstat(...a),
    realpath: (...a) => real.realpath(...a)
  };
}

async function readLatch(backupsRoot) {
  try {
    return JSON.parse(await fs.readFile(path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function countReceiptDirs(backupsRoot) {
  try {
    return (await fs.readdir(path.join(backupsRoot, 'receipts'))).length;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

test('missing required config raises missing_config', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => {
    await assert.rejects(
      () => runLifeLedgerSyncWorker([], { cwd }),
      e => e.code === 'missing_config'
    );
  })
));

test('no outbox file yet -> no_source, and status is written back once the outbox folder exists', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          const outcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--json'],
            { cwd }
          );
          assert.equal(outcome.skipped, false);
          assert.equal(outcome.result.outcome, 'no_source');
          const status = JSON.parse(await fs.readFile(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME), 'utf8'));
          assert.equal(status.outcome, 'no_source');
          const runLog = await fs.readdir(path.join(backupsRoot, 'runs'));
          assert.equal(runLog.length, 1);
        })
      ))
    ))
  ))
));

test('missing outbox DIRECTORY entirely -> no crash, no status write attempted', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-vault-', async vault => (
      withTempDir('chronasense-p10-backups-', async backupsRoot => {
        const outboxDir = path.join(backupsRoot, '..', 'never-created-outbox-' + Date.now());
        const outcome = await runLifeLedgerSyncWorker(
          ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot],
          { cwd }
        );
        assert.equal(outcome.result.outcome, 'no_source');
        const outboxExists = await fs.access(outboxDir).then(() => true, () => false);
        assert.equal(outboxExists, false, 'worker must not create the outbox folder itself');
      })
    ))
  ))
));

test('default (no --apply) is a dry run: pending changes are reported but nothing is written', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await seedOwnedVault(vault, []);
          await writeOutbox(outboxDir, [focusEvent()]);
          const outcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot],
            { cwd }
          );
          assert.equal(outcome.result.outcome, 'would_sync');
          const dailyExists = await fs.access(path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md')).then(() => true, () => false);
          assert.equal(dailyExists, false, 'dry run (default) must not write to the vault');
        })
      ))
    ))
  ))
));

test('--apply performs a real cycle and writes truthful status back into the outbox folder', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await seedOwnedVault(vault, []);
          const outboxJson = await writeOutbox(outboxDir, [focusEvent()]);
          const outcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--apply'],
            { cwd }
          );
          assert.equal(outcome.result.outcome, 'synced');
          const dailyExists = await fs.access(path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md')).then(() => true, () => false);
          assert.equal(dailyExists, true);

          const status = JSON.parse(await fs.readFile(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME), 'utf8'));
          assert.equal(status.outcome, 'synced');
          const statusJson = JSON.stringify(status);
          assert.ok(!statusJson.includes(vault));
          assert.ok(!statusJson.includes(backupsRoot));
          void outboxJson;
        })
      ))
    ))
  ))
));

test('a second concurrent worker run is skipped while a fresh lock is held', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await fs.mkdir(backupsRoot, { recursive: true });
          await fs.writeFile(
            path.join(backupsRoot, 'life-ledger-sync-worker.lock'),
            JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: 'test' }),
            'utf8'
          );
          const outcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot],
            { cwd }
          );
          assert.equal(outcome.skipped, true);
          assert.equal(outcome.reason, 'already_running');
        })
      ))
    ))
  ))
));

test('a stale lock (process no longer running) is broken and the cycle proceeds', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await fs.mkdir(backupsRoot, { recursive: true });
          // A PID astronomically unlikely to be a live process on any machine.
          await fs.writeFile(
            path.join(backupsRoot, 'life-ledger-sync-worker.lock'),
            JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), hostname: 'test' }),
            'utf8'
          );
          const outcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot],
            { cwd }
          );
          assert.equal(outcome.skipped, false);
          assert.equal(outcome.result.outcome, 'no_source');
        })
      ))
    ))
  ))
));

test('Finding 4: an old lock with a CONFIRMED-LIVE pid is NEVER broken by age alone', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await fs.mkdir(backupsRoot, { recursive: true });
          const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago — well past STALE_LOCK_MS
          await fs.writeFile(
            path.join(backupsRoot, 'life-ledger-sync-worker.lock'),
            JSON.stringify({ pid: process.pid, startedAt: old, hostname: 'test' }), // process.pid is definitely alive (it's us)
            'utf8'
          );
          const outcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot],
            { cwd }
          );
          assert.equal(outcome.skipped, true, 'a live PID must hold the lock regardless of age');
          assert.equal(outcome.reason, 'already_running');
        })
      ))
    ))
  ))
));

test('Finding 4: a malformed/unverifiable lock (no parsable pid) falls back to the age ceiling', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await fs.mkdir(backupsRoot, { recursive: true });
          const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
          // No usable pid at all -- liveness can't be established, so this must fall back to age.
          await fs.writeFile(path.join(backupsRoot, 'life-ledger-sync-worker.lock'), JSON.stringify({ startedAt: old, hostname: 'test' }), 'utf8');
          const oldLockOutcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot],
            { cwd }
          );
          assert.equal(oldLockOutcome.skipped, false, 'an old unparsable-pid lock must be reclaimable via the age fallback');

          const fresh = new Date().toISOString();
          await fs.writeFile(path.join(backupsRoot, 'life-ledger-sync-worker.lock'), JSON.stringify({ startedAt: fresh, hostname: 'test' }), 'utf8');
          const freshLockOutcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot],
            { cwd }
          );
          assert.equal(freshLockOutcome.skipped, true, 'a FRESH unparsable-pid lock must be conservatively held, not stolen');
        })
      ))
    ))
  ))
));

test('config file supplies defaults, CLI flags override them', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDirFromConfig => (
      withTempDir('chronasense-p10-outbox-override-', async outboxDirFromFlag => (
        withTempDir('chronasense-p10-vault-', async vault => (
          withTempDir('chronasense-p10-backups-', async backupsRoot => {
            await fs.mkdir(path.join(cwd, 'scripts'), { recursive: true });
            await fs.writeFile(
              path.join(cwd, 'scripts', 'life-ledger-sync-worker.config.json'),
              JSON.stringify({ outboxDir: outboxDirFromConfig, vault, backupsRoot }),
              'utf8'
            );
            await seedOwnedVault(vault, []);
            await writeOutbox(outboxDirFromFlag, [focusEvent()]);
            const outcome = await runLifeLedgerSyncWorker(['--outbox-dir', outboxDirFromFlag], { cwd });
            // outboxDirFromConfig has nothing in it, but the flag override does — proves the
            // flag (not the config default) was actually used.
            assert.equal(outcome.result.outcome, 'would_sync');
          })
        ))
      ))
    ))
  ))
));

// ===========================================================================
// Finding 3 — atomic stale-lock takeover: two concurrent contenders, one stale lock
// ===========================================================================

test('Finding 3: two concurrent contenders racing the same stale lock -- exactly one obtains execution authority', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await fs.mkdir(backupsRoot, { recursive: true });
          // A dead PID -- unambiguously stale and reclaimable.
          await fs.writeFile(
            path.join(backupsRoot, 'life-ledger-sync-worker.lock'),
            JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), hostname: 'test' }),
            'utf8'
          );
          const argv = ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot];
          const [a, b] = await Promise.all([
            runLifeLedgerSyncWorker(argv, { cwd }),
            runLifeLedgerSyncWorker(argv, { cwd })
          ]);
          const skippedCount = [a, b].filter(r => r.skipped === true).length;
          const proceededCount = [a, b].filter(r => r.skipped === false).length;
          assert.equal(proceededCount, 1, 'exactly one contender must obtain execution authority');
          assert.equal(skippedCount, 1, 'the loser must back off safely, not crash or also proceed');
        })
      ))
    ))
  ))
));

// ===========================================================================
// Finding 1 — persisted intervention latch
// ===========================================================================

test('A: a partial-apply failure during a real --apply run creates a durable intervention latch', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await seedOwnedVault(vault, [focusEvent()]);
          await writeOutbox(outboxDir, [focusEvent(), focusEventDay2()]);
          const outcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--apply'],
            { cwd, fs: breaksOnSecondTmpWriteFs() }
          );
          assert.equal(outcome.result.outcome, 'intervention_required');
          assert.equal(outcome.result.category, 'after_write_partial');

          const latch = await readLatch(backupsRoot);
          assert.ok(latch, 'a latch file must be written');
          assert.equal(latch.outcome, 'intervention_required');
          assert.equal(latch.category, 'after_write_partial');
          assert.equal(latch.runId, outcome.result.runId);
          assert.equal(latch.failedRelativePath, OBSIDIAN_MANIFEST_RELATIVE_PATH);
          assert.ok(Array.isArray(latch.written) && latch.written.length === 1);
          assert.equal(typeof latch.createdAt, 'string');
          const latchJson = JSON.stringify(latch);
          assert.ok(!latchJson.includes(vault), 'latch must not leak the vault path');
        })
      ))
    ))
  ))
));

test('B+C: repeated scheduled --apply invocations while latched create zero receipts and zero managed writes', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await seedOwnedVault(vault, [focusEvent()]);
          await writeOutbox(outboxDir, [focusEvent(), focusEventDay2()]);
          await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--apply'],
            { cwd, fs: breaksOnSecondTmpWriteFs() }
          );
          const receiptCountAfterFailure = await countReceiptDirs(backupsRoot);
          assert.equal(receiptCountAfterFailure, 1, 'the failed run itself prepared exactly one receipt');

          for (let i = 0; i < 3; i++) {
            const outcome = await runLifeLedgerSyncWorker(
              ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--apply'],
              { cwd }
            );
            assert.equal(outcome.result.outcome, 'intervention_required');
            assert.equal(outcome.result.category, 'latched');
            assert.equal(outcome.result.reason, 'intervention_latch_present');
          }
          assert.equal(await countReceiptDirs(backupsRoot), receiptCountAfterFailure, 'no NEW receipt directories from blocked apply attempts');
        })
      ))
    ))
  ))
));

test('D: a dry run while latched may report state, but never clears or bypasses the latch', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await seedOwnedVault(vault, [focusEvent()]);
          await writeOutbox(outboxDir, [focusEvent(), focusEventDay2()]);
          await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--apply'],
            { cwd, fs: breaksOnSecondTmpWriteFs() }
          );
          const filesBefore = await fs.readdir(path.join(vault, 'Life Ledger', 'Daily')).catch(() => []);

          const dryRunOutcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot],
            { cwd }
          );
          // No --apply -> the latch-block short-circuit never triggers; the cycle runs in dry-run
          // mode and reports real state, purely informational.
          assert.notEqual(dryRunOutcome.result.outcome, 'error');

          const latchAfter = await readLatch(backupsRoot);
          assert.ok(latchAfter, 'the latch must still exist after a dry run');

          const filesAfter = await fs.readdir(path.join(vault, 'Life Ledger', 'Daily')).catch(() => []);
          assert.deepEqual(filesAfter, filesBefore, 'a dry run while latched must not write to the vault');
        })
      ))
    ))
  ))
));

test('E: --clear-intervention removes only the latch, and reports what was cleared', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await seedOwnedVault(vault, [focusEvent()]);
          await writeOutbox(outboxDir, [focusEvent(), focusEventDay2()]);
          await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--apply'],
            { cwd, fs: breaksOnSecondTmpWriteFs() }
          );
          const receiptCountBeforeClear = await countReceiptDirs(backupsRoot);
          const vaultFilesBefore = await fs.readdir(path.join(vault, 'Life Ledger', 'Daily'));

          const clearOutcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--clear-intervention'],
            { cwd }
          );
          assert.equal(clearOutcome.cleared, true);
          assert.equal(clearOutcome.result.outcome, 'intervention_cleared');
          assert.match(clearOutcome.result.message, /Cleared/);

          assert.equal(await readLatch(backupsRoot), null, 'the latch file itself must be gone');
          assert.equal(await countReceiptDirs(backupsRoot), receiptCountBeforeClear, 'clearing must not touch receipts/backups');
          assert.deepEqual(await fs.readdir(path.join(vault, 'Life Ledger', 'Daily')), vaultFilesBefore, 'clearing must not touch the vault');
        })
      ))
    ))
  ))
));

test('E (idempotent): clearing when no latch exists is a safe no-op', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          const outcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--clear-intervention'],
            { cwd }
          );
          assert.equal(outcome.cleared, false);
          assert.equal(outcome.result.outcome, 'no_intervention_latch');
        })
      ))
    ))
  ))
));

test('F: after clearing, a manually-triggered recovery cycle can proceed and finish once the underlying state is safe', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await seedOwnedVault(vault, [focusEvent()]);
          await writeOutbox(outboxDir, [focusEvent(), focusEventDay2()]);
          await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--apply'],
            { cwd, fs: breaksOnSecondTmpWriteFs() }
          );
          await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--clear-intervention'],
            { cwd }
          );

          // The underlying vault state is actually safe to complete (the one file that landed is
          // already byte-identical to the target) -- a normal fs, no injected failure this time.
          const recoveryOutcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--apply'],
            { cwd }
          );
          assert.equal(recoveryOutcome.result.outcome, 'synced');
          assert.equal(await readLatch(backupsRoot), null, 'a successful recovery must not re-create the latch');
        })
      ))
    ))
  ))
));

test('G: outbox status while latched says action is required, never synced, never "retry automatically"', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await seedOwnedVault(vault, [focusEvent()]);
          await writeOutbox(outboxDir, [focusEvent(), focusEventDay2()]);
          await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--apply'],
            { cwd, fs: breaksOnSecondTmpWriteFs() }
          );
          // A later blocked --apply attempt is what the scheduler would actually experience.
          await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot, '--apply'],
            { cwd }
          );
          const status = JSON.parse(await fs.readFile(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME), 'utf8'));
          assert.equal(status.outcome, 'intervention_required');
          const statusJson = JSON.stringify(status).toLowerCase();
          assert.ok(!statusJson.includes('"synced"'));
        })
      ))
    ))
  ))
));
