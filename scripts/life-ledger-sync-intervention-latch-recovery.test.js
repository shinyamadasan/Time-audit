import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runLifeLedgerSyncWorker,
  LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME
} from './life-ledger-sync-worker.mjs';

// Phase 11 — REQUIRED OUTCOME 3: a corrupt/unparseable intervention-required.json must not be
// able to block the one explicit, human-authorized recovery action (--clear-intervention) that
// exists specifically to get out of that state. These tests exercise that path directly against
// the latch file, without needing a real vault/outbox (the clear-intervention branch never
// touches either).

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function makeConfig(cwd, backupsRoot) {
  const configPath = path.join(cwd, 'worker.config.json');
  await fs.writeFile(configPath, JSON.stringify({
    outboxDir: path.join(cwd, 'outbox-does-not-exist'),
    vault: path.join(cwd, 'vault-unused-by-clear-intervention'),
    backupsRoot
  }), 'utf8');
  return configPath;
}

test('a corrupt intervention latch is cleared: the exact path is removed, evidence is preserved, no other files are touched', async () => (
  withTempDir('chronasense-p11-latch-', async cwd => {
    const backupsRoot = path.join(cwd, 'backups');
    await fs.mkdir(backupsRoot, { recursive: true });
    const latchPath = path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME);
    const corruptBytes = '{ this is not valid json at all !! ';
    await fs.writeFile(latchPath, corruptBytes, 'utf8');
    // A sibling file that must survive untouched.
    await fs.writeFile(path.join(backupsRoot, 'status.json'), '{"ok":true}', 'utf8');
    const configPath = await makeConfig(cwd, backupsRoot);

    const outcome = await runLifeLedgerSyncWorker(['--clear-intervention', '--config', configPath, '--json']);
    assert.equal(outcome.skipped, false);
    assert.equal(outcome.cleared, true);
    assert.equal(outcome.result.outcome, 'intervention_cleared');
    assert.equal(outcome.result.clearedLatchWasCorrupt, true);
    assert.ok(outcome.result.corruptLatchEvidencePath, 'an evidence path must be reported');

    // The exact original path is gone — future --apply checks (which look for this exact
    // filename) will no longer see a latch.
    await assert.rejects(fs.access(latchPath), /ENOENT/);

    // The corrupt bytes were preserved, not lost.
    const evidenceContent = await fs.readFile(outcome.result.corruptLatchEvidencePath, 'utf8');
    assert.equal(evidenceContent, corruptBytes);

    // Nothing else in backupsRoot was touched by this operation (status.json survives; the run
    // log and evidence file are the only additions).
    const remaining = await fs.readdir(backupsRoot);
    assert.ok(remaining.includes('status.json'));
    assert.ok(remaining.includes(path.basename(outcome.result.corruptLatchEvidencePath)));
    assert.ok(!remaining.includes(LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME));
  })
));

test('clearing when the latch path is a directory (reparse/unexpected-state surprise) refuses and removes nothing', async () => (
  withTempDir('chronasense-p11-latch-', async cwd => {
    const backupsRoot = path.join(cwd, 'backups');
    const latchPath = path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME);
    await fs.mkdir(latchPath, { recursive: true }); // a directory sits where a plain file is expected
    await fs.writeFile(path.join(latchPath, 'unexpected-child.txt'), 'must survive', 'utf8');
    const configPath = await makeConfig(cwd, backupsRoot);

    await assert.rejects(
      runLifeLedgerSyncWorker(['--clear-intervention', '--config', configPath]),
      err => /not a plain file/.test(err.message)
    );

    // Nothing was removed — the directory and its child are exactly as before.
    const stats = await fs.lstat(latchPath);
    assert.ok(stats.isDirectory());
    assert.ok(await fs.access(path.join(latchPath, 'unexpected-child.txt')).then(() => true, () => false));
  })
));

test('a symlink at the exact latch path is refused, never followed or deleted', async () => {
  await withTempDir('chronasense-p11-latch-', async cwd => {
    const backupsRoot = path.join(cwd, 'backups');
    await fs.mkdir(backupsRoot, { recursive: true });
    const outsideFile = path.join(cwd, 'outside-file.json');
    await fs.writeFile(outsideFile, '{"outside":true}', 'utf8');
    const latchPath = path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME);
    try {
      await fs.symlink(outsideFile, latchPath, 'file');
    } catch {
      return; // symlink creation restricted in this environment — skip rather than fail
    }
    const configPath = await makeConfig(cwd, backupsRoot);

    await assert.rejects(
      runLifeLedgerSyncWorker(['--clear-intervention', '--config', configPath]),
      err => /not a plain file/.test(err.message)
    );

    assert.ok(await fs.access(outsideFile).then(() => true, () => false), 'the symlink target must never be touched');
    const stats = await fs.lstat(latchPath);
    assert.ok(stats.isSymbolicLink(), 'the symlink itself must still be exactly where it was');
  });
});

test('no latch present is still a clean, non-throwing no-op', async () => (
  withTempDir('chronasense-p11-latch-', async cwd => {
    const backupsRoot = path.join(cwd, 'backups');
    const configPath = await makeConfig(cwd, backupsRoot);
    const outcome = await runLifeLedgerSyncWorker(['--clear-intervention', '--config', configPath]);
    assert.equal(outcome.cleared, false);
    assert.equal(outcome.result.outcome, 'no_intervention_latch');
  })
));

test('a healthy (valid JSON) latch still clears exactly as before, with clearedLatchWasCorrupt: false', async () => (
  withTempDir('chronasense-p11-latch-', async cwd => {
    const backupsRoot = path.join(cwd, 'backups');
    await fs.mkdir(backupsRoot, { recursive: true });
    const latchPath = path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME);
    const validLatch = { runId: 'run-abc', outcome: 'intervention_required', category: 'after_write_partial', reason: 'partial_apply_failure' };
    await fs.writeFile(latchPath, JSON.stringify(validLatch), 'utf8');
    const configPath = await makeConfig(cwd, backupsRoot);

    const outcome = await runLifeLedgerSyncWorker(['--clear-intervention', '--config', configPath]);
    assert.equal(outcome.cleared, true);
    assert.equal(outcome.result.clearedLatchWasCorrupt, false);
    assert.equal(outcome.result.clearedLatch.runId, 'run-abc');
    await assert.rejects(fs.access(latchPath), /ENOENT/);
  })
));
