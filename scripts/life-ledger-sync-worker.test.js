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

// ===========================================================================
// TASK-049 — a takeover removes only the exact stale lock generation it judged
// ===========================================================================

// (Import declarations are hoisted, so these are in scope for the whole module.)
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

const TASK049_LOCK_FILENAME = 'life-ledger-sync-worker.lock';
const TASK049_DEAD_PID = 999999; // a PID astronomically unlikely to be a live process

function task049Deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

// Mirrors the worker's documented claim naming: `<file>.claim-<first 16 hex of sha256(bytes)>`.
function task049ClaimPath(filePath, judgedBytes) {
  return `${filePath}.claim-${crypto.createHash('sha256').update(judgedBytes).digest('hex').slice(0, 16)}`;
}

async function task049LockArtifacts(backupsRoot) {
  return (await fs.readdir(backupsRoot)).filter(name => name.startsWith(TASK049_LOCK_FILENAME)).sort();
}

test('TASK-049: a contender acting on a stale verdict never removes the winner\'s fresh lock', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          const lockPath = path.join(backupsRoot, TASK049_LOCK_FILENAME);
          const latchPath = path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME);
          const deadLock = JSON.stringify({ pid: TASK049_DEAD_PID, startedAt: new Date().toISOString(), hostname: 'test' });
          await fs.writeFile(lockPath, deadLock, 'utf8');

          // The exact TASK-047 interleaving, forced deterministically. Both contenders read the
          // dead lock and form a "stale" verdict on the same bytes; A then takes over and is
          // running inside the lock (held at its first post-lock read, the latch check); only then
          // does B act on its now-outdated verdict. B must back off.
          const contender = new AsyncLocalStorage();
          const verdictRead = { A: task049Deferred(), B: task049Deferred() };
          const aHoldsLock = task049Deferred();
          const bSettled = task049Deferred();
          const lockReads = { A: 0, B: 0 };
          const judgedBytes = {};
          let aGatedAtLatch = false;
          const realReadFile = fs.readFile;
          fs.readFile = async function task049ReadFile(filePath, ...rest) {
            const who = contender.getStore();
            if (who === 'A' && String(filePath) === latchPath && !aGatedAtLatch) {
              aGatedAtLatch = true;
              aHoldsLock.resolve();
              await bSettled.promise;
            }
            const result = await realReadFile.call(this, filePath, ...rest);
            if (who && String(filePath) === lockPath && lockReads[who]++ === 0) {
              judgedBytes[who] = result;
              verdictRead[who].resolve();
              if (who === 'A') await verdictRead.B.promise;
              else await aHoldsLock.promise;
            }
            return result;
          };
          let aOutcome;
          let bOutcome;
          try {
            const argv = ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot];
            const a = contender.run('A', () => runLifeLedgerSyncWorker(argv, { cwd }));
            const b = contender.run('B', () => runLifeLedgerSyncWorker(argv, { cwd }));
            // Never hang if a contender takes a path that skips its gate point.
            a.finally(() => aHoldsLock.resolve()).catch(() => {});
            b.finally(() => { verdictRead.B.resolve(); bSettled.resolve(); }).catch(() => {});
            bOutcome = await b;
            bSettled.resolve();
            aOutcome = await a;
          } finally {
            fs.readFile = realReadFile;
          }

          assert.equal(judgedBytes.A, deadLock, 'A judged the dead lock');
          assert.equal(judgedBytes.B, deadLock, 'B judged the same dead lock before A took it over (race reproduced)');
          assert.equal(aGatedAtLatch, true, 'A was running inside the lock while B acted');
          assert.equal(aOutcome.skipped, false, 'the first contender to act obtains execution authority');
          assert.equal(bOutcome.skipped, true, 'a late contender with a stale verdict must back off, not also proceed');
          assert.equal(bOutcome.reason, 'already_running');
          assert.deepEqual(await task049LockArtifacts(backupsRoot), [], 'no lock, claim or tombstone left behind');
        })
      ))
    ))
  ))
));

test('TASK-049: a takeover abandoned mid-way is honoured while its breaker lives and recovered once it is dead', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          const argv = ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot];
          const lockPath = path.join(backupsRoot, TASK049_LOCK_FILENAME);
          const deadLock = JSON.stringify({ pid: TASK049_DEAD_PID, startedAt: new Date().toISOString(), hostname: 'test' });
          await fs.writeFile(lockPath, deadLock, 'utf8');
          const claimPath = task049ClaimPath(lockPath, deadLock);

          // A LIVE breaker is mid-takeover of the dead lock: nobody else may break it.
          const liveClaim = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: 'test', nonce: 'live-breaker' });
          await fs.writeFile(claimPath, liveClaim, 'utf8');
          const whileBreakerLive = await runLifeLedgerSyncWorker(argv, { cwd });
          assert.equal(whileBreakerLive.skipped, true, 'a live breaker\'s claim is never stolen');
          assert.equal(await fs.readFile(lockPath, 'utf8'), deadLock, 'the judged lock is left for the live breaker');
          assert.equal(await fs.readFile(claimPath, 'utf8'), liveClaim);

          // That breaker died mid-takeover, and so did the breaker that tried to break ITS claim:
          // two abandoned levels. The next run must still recover, not wedge.
          const deadClaim = JSON.stringify({ pid: TASK049_DEAD_PID, startedAt: new Date().toISOString(), hostname: 'test', nonce: 'dead-breaker-1' });
          await fs.writeFile(claimPath, deadClaim, 'utf8');
          const claimOfClaimPath = task049ClaimPath(claimPath, deadClaim);
          const deadClaimOfClaim = JSON.stringify({ pid: TASK049_DEAD_PID, startedAt: new Date().toISOString(), hostname: 'test', nonce: 'dead-breaker-2' });
          await fs.writeFile(claimOfClaimPath, deadClaimOfClaim, 'utf8');
          const afterBreakersDied = await runLifeLedgerSyncWorker(argv, { cwd });
          assert.equal(afterBreakersDied.skipped, false, 'abandoned breakers must not wedge the lock');
          assert.equal(afterBreakersDied.result.outcome, 'no_source');
          assert.deepEqual(await task049LockArtifacts(backupsRoot), [], 'the dead lock, both dead claims and all tombstones are gone');
        })
      ))
    ))
  ))
));

test('TASK-049: an unparsable lock is aged by its file time -- a lock still being written is held, an aged one is recovered', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          const argv = ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot];
          const lockPath = path.join(backupsRoot, TASK049_LOCK_FILENAME);
          // What a contender sees between a winner's `wx` open and its write: an empty lock.
          await fs.writeFile(lockPath, '', 'utf8');
          const whileBeingWritten = await runLifeLedgerSyncWorker(argv, { cwd });
          assert.equal(whileBeingWritten.skipped, true, 'a just-created, not-yet-written lock is never broken');
          assert.equal(await fs.readFile(lockPath, 'utf8'), '');

          // The same unparsable lock, abandoned long ago (writer crashed after `wx`, before writing).
          const longAgo = new Date(Date.now() - 60 * 60 * 1000);
          await fs.utimes(lockPath, longAgo, longAgo);
          const afterAbandoned = await runLifeLedgerSyncWorker(argv, { cwd });
          assert.equal(afterAbandoned.skipped, false, 'an aged unparsable lock is still recovered');
          assert.equal(afterAbandoned.result.outcome, 'no_source');
          assert.deepEqual(await task049LockArtifacts(backupsRoot), []);
        })
      ))
    ))
  ))
));

// ===========================================================================
// TASK-049 round 2 — an empty (or otherwise byte-identical) generation is never mistaken for a
// live one. Test-side injection only: the fs methods the worker calls are wrapped, and gates are
// keyed on paths and on which contender (AsyncLocalStorage) is calling.
// ===========================================================================

function task049Round2Gates(latchPath) {
  const contender = new AsyncLocalStorage();
  const real = { open: fs.open, link: fs.link, rename: fs.rename, readFile: fs.readFile };
  const settled = { D: task049Deferred(), X: task049Deferred() };
  const inside = new Set();
  const state = { maxInside: 0, renamesByD: [] };
  const dIn = task049Deferred();
  const xIn = task049Deferred();
  const hooks = { beforeCreate: null, afterCreate: null };
  // A "create" is the call that makes a name appear: open(name, 'wx') or link(existing, name).
  const createdName = (method, args) => {
    if (method === 'link') return String(args[1]);
    return args[1] === 'wx' ? String(args[0]) : null;
  };
  for (const method of ['open', 'link']) {
    fs[method] = async function task049Round2Wrapped(...args) {
      const who = contender.getStore();
      const name = who ? createdName(method, args) : null;
      if (name && hooks.beforeCreate) await hooks.beforeCreate(who, name);
      const result = await real[method].apply(this, args);
      if (name && hooks.afterCreate) await hooks.afterCreate(who, name);
      return result;
    };
  }
  fs.rename = async function task049Round2Rename(from, ...rest) {
    if (contender.getStore() === 'D') state.renamesByD.push(String(from));
    return real.rename.call(this, from, ...rest);
  };
  // Being inside the lock = reaching the latch check, the first read after the lock is held.
  fs.readFile = async function task049Round2ReadFile(filePath, ...rest) {
    const who = contender.getStore();
    if ((who === 'D' || who === 'X') && String(filePath) === latchPath && !inside.has(who)) {
      inside.add(who);
      state.maxInside = Math.max(state.maxInside, inside.size);
      if (who === 'D') { dIn.resolve(); await Promise.race([xIn.promise, settled.X.promise]); }
      else { xIn.resolve(); await Promise.race([dIn.promise, settled.D.promise]); }
    }
    return real.readFile.call(this, filePath, ...rest);
  };
  const run = (who, argv, cwd) => {
    const p = contender.run(who, () => runLifeLedgerSyncWorker(argv, { cwd }));
    if (settled[who]) p.finally(() => { inside.delete(who); settled[who].resolve(); }).catch(() => {});
    return p;
  };
  const restore = () => Object.assign(fs, real);
  return { hooks, state, settled, dIn, run, restore };
}

function task049Show(outcome) {
  return outcome.status === 'fulfilled'
    ? { skipped: outcome.value.skipped, reason: outcome.value.reason }
    : { threw: outcome.reason?.code || String(outcome.reason) };
}

async function task049WriteAgedEmpty(filePath) {
  await fs.writeFile(filePath, '', 'utf8');
  const longAgo = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(filePath, longAgo, longAgo);
}

test('TASK-049 r2: a stale verdict on an EMPTY lock never removes a newer live lock (no two holders)', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          const argv = ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot];
          const lockPath = path.join(backupsRoot, TASK049_LOCK_FILENAME);
          const latchPath = path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME);
          // A crashed, EMPTY lock (a writer died after creating the name, before writing), aged.
          await task049WriteAgedEmpty(lockPath);

          const g = task049Round2Gates(latchPath);
          const dJudged = task049Deferred();
          const xHasLock = task049Deferred();
          let dGated = false;
          let xGated = false;
          // D has judged the empty lock stale and is about to take its claim: stall it there.
          g.hooks.beforeCreate = async (who, name) => {
            if (who === 'D' && !dGated && name.startsWith(`${lockPath}.claim-`)) {
              dGated = true;
              dJudged.resolve();
              await Promise.race([xHasLock.promise, g.settled.X.promise]);
            }
          };
          // X's lock name now exists: let D act on its old verdict before X goes any further.
          g.hooks.afterCreate = async (who, name) => {
            if (who === 'X' && !xGated && name === lockPath) {
              xGated = true;
              xHasLock.resolve();
              await Promise.race([g.dIn.promise, g.settled.D.promise]);
            }
          };
          let b;
          let outcomes;
          try {
            const d = g.run('D', argv, cwd);
            d.finally(() => dJudged.resolve()).catch(() => {});
            await dJudged.promise;
            b = await g.run('B', argv, cwd); // breaks the empty lock, runs and releases
            const x = g.run('X', argv, cwd);
            outcomes = await Promise.allSettled([d, x]);
          } finally {
            g.restore();
          }
          const [dOut, xOut] = outcomes.map(task049Show);
          assert.equal(dGated, true, 'D formed a stale verdict on the empty lock (race reproduced)');
          assert.equal(b.skipped, false, 'B recovered the crashed empty lock');
          assert.equal(xGated, true, 'X created a new lock while D still held its old verdict');
          assert.ok(g.state.maxInside <= 1, `two workers were inside the lock at once (D ${JSON.stringify(dOut)}, X ${JSON.stringify(xOut)})`);
          assert.deepEqual(dOut, { skipped: true, reason: 'already_running' }, 'D must back off');
          assert.deepEqual(xOut, { skipped: false, reason: undefined }, 'the live holder X keeps execution authority');
          assert.deepEqual(await task049LockArtifacts(backupsRoot), [], 'no lock, claim, temp or tombstone left behind');
        })
      ))
    ))
  ))
));

test('TASK-049 r2: a stale verdict on an EMPTY claim never removes a newer live claim', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          const argv = ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot];
          const lockPath = path.join(backupsRoot, TASK049_LOCK_FILENAME);
          const latchPath = path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME);
          const claimPath = task049ClaimPath(lockPath, '');
          // A crashed empty lock AND a crashed empty claim on it (a breaker died the same way).
          await task049WriteAgedEmpty(lockPath);
          await task049WriteAgedEmpty(claimPath);

          const g = task049Round2Gates(latchPath);
          const dJudged = task049Deferred();
          const xHasClaim = task049Deferred();
          let dGated = false;
          let xGated = false;
          // D has judged the empty claim stale and is about to take the claim-of-claim: stall it.
          g.hooks.beforeCreate = async (who, name) => {
            if (who === 'D' && !dGated && name.startsWith(`${claimPath}.claim-`)) {
              dGated = true;
              dJudged.resolve();
              await Promise.race([xHasClaim.promise, g.settled.X.promise]);
            }
          };
          // X now holds the (same-named) claim on a later crashed empty lock: let D act first.
          g.hooks.afterCreate = async (who, name) => {
            if (who === 'X' && !xGated && name === claimPath) {
              xGated = true;
              xHasClaim.resolve();
              await Promise.race([g.dIn.promise, g.settled.D.promise]);
            }
          };
          let b;
          let outcomes;
          let artifactsAfterB;
          try {
            const d = g.run('D', argv, cwd);
            d.finally(() => dJudged.resolve()).catch(() => {});
            await dJudged.promise;
            b = await g.run('B', argv, cwd); // breaks the empty claim and the empty lock, runs, releases
            artifactsAfterB = await task049LockArtifacts(backupsRoot);
            await task049WriteAgedEmpty(lockPath); // later, another crashed empty lock: same bytes, same claim name
            const x = g.run('X', argv, cwd);
            outcomes = await Promise.allSettled([d, x]);
          } finally {
            g.restore();
          }
          const [dOut, xOut] = outcomes.map(task049Show);
          assert.equal(dGated, true, 'D formed a stale verdict on the empty claim (race reproduced)');
          assert.equal(b.skipped, false, 'B recovered through the crashed empty claim');
          // (A `.stale-*` name here can only be the stalled D's own in-flight publication temp.)
          assert.deepEqual(artifactsAfterB.filter(name => !name.includes('.stale-')), [], 'B left no lock or claim behind');
          assert.equal(xGated, true, 'X created the same-named claim while D still held its old verdict');
          assert.deepEqual(g.state.renamesByD.filter(from => from === claimPath), [], 'D removed X\'s live claim');
          assert.ok(g.state.maxInside <= 1, 'two workers were inside the lock at once');
          assert.deepEqual(dOut, { skipped: true, reason: 'already_running' }, 'D must back off');
          assert.deepEqual(xOut, { skipped: false, reason: undefined }, 'X, the live claimant, recovers the lock');
          assert.deepEqual(await task049LockArtifacts(backupsRoot), [], 'no lock, claim, temp or tombstone left behind');
        })
      ))
    ))
  ))
));

test('TASK-049 r2: a filesystem without hard links gets a clear error and no weaker lock', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          const argv = ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot];
          const realLink = fs.link;
          // What FAT/exFAT reports on Windows (ERROR_INVALID_FUNCTION surfaces as EISDIR).
          fs.link = async () => { throw Object.assign(new Error('simulated: no hard links'), { code: 'EISDIR' }); };
          let error;
          try {
            await runLifeLedgerSyncWorker(argv, { cwd });
          } catch (err) {
            error = err;
          } finally {
            fs.link = realLink;
          }
          assert.equal(error?.code, 'lock_unsupported_filesystem');
          assert.match(error.message, /hard links/);
          assert.deepEqual(await task049LockArtifacts(backupsRoot), [], 'no lock, empty lock or temp left behind');
        })
      ))
    ))
  ))
));
