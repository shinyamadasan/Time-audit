import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  planStaleTmpCleanup,
  applyStaleTmpCleanupPlan,
  runLifeLedgerTmpCleanupCli
} from './life-ledger-sync-tmp-cleanup.mjs';
import { LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME, LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME } from './life-ledger-sync-worker.mjs';

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeWithAge(filePath, ageMs, content = 'x') {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  const past = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, past, past);
}

test('an old orphaned latch .tmp with no live lock is deleted', async () => (
  withTempDir('chronasense-p11-tmpcleanup-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    const tmpPath = path.join(backupsRoot, `${LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME}.tmp`);
    await writeWithAge(tmpPath, 20 * 60 * 1000);
    const plan = await planStaleTmpCleanup({ backupsRoot, ageMinutes: 10 });
    const entry = plan.candidates.find(c => c.kind === 'intervention_latch_tmp');
    assert.equal(entry.decision, 'delete');
    const applied = await applyStaleTmpCleanupPlan(plan);
    assert.equal(applied.deleted.length, 1);
    assert.ok(!(await fs.access(tmpPath).then(() => true, () => false)));
  })
));

test('a recent .tmp (younger than the age threshold) is kept even with no live lock', async () => (
  withTempDir('chronasense-p11-tmpcleanup-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    const tmpPath = path.join(backupsRoot, `${LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME}.tmp`);
    await writeWithAge(tmpPath, 1000);
    const plan = await planStaleTmpCleanup({ backupsRoot, ageMinutes: 10 });
    const entry = plan.candidates.find(c => c.kind === 'intervention_latch_tmp');
    assert.equal(entry.decision, 'keep');
    assert.equal(entry.why, 'too_recent_to_assume_orphaned');
    await applyStaleTmpCleanupPlan(plan);
    assert.ok(await fs.access(tmpPath).then(() => true, () => false), 'must survive');
  })
));

test('an old .tmp is still kept when the worker lock is currently live', async () => (
  withTempDir('chronasense-p11-tmpcleanup-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    const tmpPath = path.join(backupsRoot, `${LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME}.tmp`);
    await writeWithAge(tmpPath, 20 * 60 * 1000);
    await fs.writeFile(
      path.join(backupsRoot, 'life-ledger-sync-worker.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      'utf8'
    );
    const plan = await planStaleTmpCleanup({ backupsRoot, ageMinutes: 10 });
    assert.equal(plan.lockLive, true);
    const entry = plan.candidates.find(c => c.kind === 'intervention_latch_tmp');
    assert.equal(entry.decision, 'keep');
    assert.equal(entry.why, 'worker_lock_currently_live');
    await applyStaleTmpCleanupPlan(plan);
    assert.ok(await fs.access(tmpPath).then(() => true, () => false), 'a possibly in-progress write must never be deleted');
  })
));

test('the outbox status .tmp is only evaluated when outboxDir is supplied, and is confined to it', async () => (
  withTempDir('chronasense-p11-tmpcleanup-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    const outboxDir = path.join(tmp, 'outbox');
    const statusTmp = path.join(outboxDir, `${LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME}.tmp`);
    await writeWithAge(statusTmp, 20 * 60 * 1000);

    const withoutOutbox = await planStaleTmpCleanup({ backupsRoot, ageMinutes: 10 });
    assert.ok(!withoutOutbox.candidates.some(c => c.kind === 'outbox_status_tmp'));

    const withOutbox = await planStaleTmpCleanup({ backupsRoot, outboxDir, ageMinutes: 10 });
    const entry = withOutbox.candidates.find(c => c.kind === 'outbox_status_tmp');
    assert.equal(entry.decision, 'delete');
    await applyStaleTmpCleanupPlan(withOutbox);
    assert.ok(!(await fs.access(statusTmp).then(() => true, () => false)));
  })
));

test('a directory or symlink at the exact known tmp path is skipped, never deleted', async () => (
  withTempDir('chronasense-p11-tmpcleanup-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    const tmpPath = path.join(backupsRoot, `${LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME}.tmp`);
    await fs.mkdir(tmpPath, { recursive: true }); // unexpected: a directory where a plain file is expected
    const plan = await planStaleTmpCleanup({ backupsRoot, ageMinutes: 0 });
    const entry = plan.candidates.find(c => c.kind === 'intervention_latch_tmp');
    assert.equal(entry.decision, 'skip');
    assert.equal(entry.why, 'not_a_plain_file');
    await applyStaleTmpCleanupPlan(plan);
    const stats = await fs.lstat(tmpPath);
    assert.ok(stats.isDirectory(), 'must be left exactly as found');
  })
));

test('a missing tmp file is simply absent, never an error', async () => (
  withTempDir('chronasense-p11-tmpcleanup-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    const plan = await planStaleTmpCleanup({ backupsRoot });
    const entry = plan.candidates.find(c => c.kind === 'intervention_latch_tmp');
    assert.equal(entry.present, false);
    assert.equal(plan.summary.total, 0);
  })
));

test('CLI dry-run vs --apply', async () => (
  withTempDir('chronasense-p11-tmpcleanup-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    const tmpPath = path.join(backupsRoot, `${LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME}.tmp`);
    await writeWithAge(tmpPath, 20 * 60 * 1000);
    const dry = await runLifeLedgerTmpCleanupCli(['--backups-root', backupsRoot, '--age-minutes', '10']);
    assert.equal(dry.applied, null);
    assert.ok(await fs.access(tmpPath).then(() => true, () => false));
    const applied = await runLifeLedgerTmpCleanupCli(['--backups-root', backupsRoot, '--age-minutes', '10', '--apply']);
    assert.equal(applied.applied.deleted.length, 1);
    assert.ok(!(await fs.access(tmpPath).then(() => true, () => false)));
  })
));
