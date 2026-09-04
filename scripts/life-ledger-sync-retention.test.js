import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  planLifeLedgerRetention,
  applyLifeLedgerRetentionPlan,
  computeLifeLedgerBackupsFootprint,
  runLifeLedgerRetentionCli
} from './life-ledger-sync-retention.mjs';
import { LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME } from './life-ledger-sync-worker.mjs';

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function touchWithAge(filePath, ageMs, content = '{}') {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  const past = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, past, past);
}

async function makeReceiptDir(backupsRoot, runId, ageMs) {
  const dir = path.join(backupsRoot, 'receipts', runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'rollback-receipt.json'), '{"kind":"obsidian-rollback-receipt"}', 'utf8');
  const past = new Date(Date.now() - ageMs);
  await fs.utimes(dir, past, past);
}

const DAY = 24 * 60 * 60 * 1000;

test('backupsRoot that does not exist yet is a safe no-op', async () => (
  withTempDir('chronasense-p11-retention-', async tmp => {
    const backupsRoot = path.join(tmp, 'does-not-exist');
    const plan = await planLifeLedgerRetention(backupsRoot);
    assert.equal(plan.rootExists, false);
    assert.equal(plan.summary.pruningDue, false);
    const applied = await applyLifeLedgerRetentionPlan(plan);
    assert.deepEqual(applied.deleted, []);
  })
));

test('old run logs beyond the min-keep floor are pruned; recent ones and the floor are kept', async () => (
  withTempDir('chronasense-p11-retention-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    // 5 old (40 days) + 3 recent (1 day). minKeep=2, retentionDays=30 -> the 3 recent are kept by
    // age, and the 2 newest of the 5 old are kept only by the min-keep floor once combined-ranked.
    for (let i = 0; i < 5; i++) {
      await touchWithAge(path.join(backupsRoot, 'runs', `old-${i}.json`), 40 * DAY - i * 1000);
    }
    for (let i = 0; i < 3; i++) {
      await touchWithAge(path.join(backupsRoot, 'runs', `recent-${i}.json`), 1 * DAY - i * 1000);
    }
    const plan = await planLifeLedgerRetention(backupsRoot, { retentionDays: 30, minKeep: 2 });
    assert.equal(plan.runs.length, 8);
    const kept = plan.runs.filter(e => e.decision === 'keep').map(e => e.name).sort();
    const deleted = plan.runs.filter(e => e.decision === 'delete').map(e => e.name).sort();
    // Newest-ranked 2 overall are recent-0 and recent-1 (min-keep floor), plus recent-2 and
    // recent-0/1 all pass the age test anyway (all 3 "recent" are within 30 days).
    assert.deepEqual(kept, ['recent-0.json', 'recent-1.json', 'recent-2.json'].sort());
    assert.deepEqual(deleted, ['old-0.json', 'old-1.json', 'old-2.json', 'old-3.json', 'old-4.json'].sort());

    const applied = await applyLifeLedgerRetentionPlan(plan);
    assert.equal(applied.deleted.length, 5);
    assert.equal(applied.errors.length, 0);
    const remaining = (await fs.readdir(path.join(backupsRoot, 'runs'))).sort();
    assert.deepEqual(remaining, kept);

    // Idempotent: re-planning + re-applying now deletes nothing further.
    const plan2 = await planLifeLedgerRetention(backupsRoot, { retentionDays: 30, minKeep: 2 });
    assert.equal(plan2.summary.runsToDelete, 0);
    const applied2 = await applyLifeLedgerRetentionPlan(plan2);
    assert.deepEqual(applied2.deleted, []);
  })
));

test('min-keep floor protects the most recent evidence even with retentionDays=0', async () => (
  withTempDir('chronasense-p11-retention-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    for (let i = 0; i < 4; i++) {
      await touchWithAge(path.join(backupsRoot, 'runs', `r-${i}.json`), i * DAY);
    }
    const plan = await planLifeLedgerRetention(backupsRoot, { retentionDays: 0, minKeep: 1 });
    const kept = plan.runs.filter(e => e.decision === 'keep');
    assert.equal(kept.length, 1, 'at least one — the newest — must always survive regardless of retentionDays');
    assert.equal(kept[0].name, 'r-0.json');
  })
));

test('an active intervention latch protects its exact run log and receipt dir regardless of age', async () => (
  withTempDir('chronasense-p11-retention-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    await touchWithAge(path.join(backupsRoot, 'runs', 'latched-run.json'), 90 * DAY);
    await makeReceiptDir(backupsRoot, 'latched-run', 90 * DAY);
    // A newer run/receipt pair exists too, so the latched one would otherwise fall outside
    // both the age window and a tight min-keep floor.
    await touchWithAge(path.join(backupsRoot, 'runs', 'newer-run.json'), 0);
    await makeReceiptDir(backupsRoot, 'newer-run', 0);

    const receiptPath = path.join(backupsRoot, 'receipts', 'latched-run', 'rollback-receipt.json');
    await fs.writeFile(
      path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME),
      JSON.stringify({ runId: 'latched-run', receiptPath }),
      'utf8'
    );

    const plan = await planLifeLedgerRetention(backupsRoot, { retentionDays: 1, minKeep: 1 });
    const runDecision = plan.runs.find(e => e.name === 'latched-run.json');
    const receiptDecision = plan.receipts.find(e => e.name === 'latched-run');
    assert.equal(runDecision.decision, 'keep');
    assert.equal(runDecision.why, 'active_latch_evidence');
    assert.equal(receiptDecision.decision, 'keep');
    assert.equal(receiptDecision.why, 'active_latch_evidence');

    const applied = await applyLifeLedgerRetentionPlan(plan);
    assert.ok(!applied.deleted.some(d => d.path.includes('latched-run')));
    assert.ok(await fs.access(receiptPath).then(() => true, () => false), 'latched receipt must survive pruning');
  })
));

test('a corrupt (unparseable) latch does not crash retention and the min-keep floor still applies', async () => (
  withTempDir('chronasense-p11-retention-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    await touchWithAge(path.join(backupsRoot, 'runs', 'a.json'), 90 * DAY);
    await fs.mkdir(backupsRoot, { recursive: true });
    await fs.writeFile(path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME), '{not json', 'utf8');
    const plan = await planLifeLedgerRetention(backupsRoot, { retentionDays: 1, minKeep: 1 });
    assert.equal(plan.latch.present, true);
    assert.equal(plan.latch.parsed, false);
    assert.equal(plan.runs[0].decision, 'keep', 'min-keep floor still protects the only run log');
  })
));

test('lock tombstones older than the threshold are pruned; recent ones are kept', async () => (
  withTempDir('chronasense-p11-retention-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    await fs.mkdir(backupsRoot, { recursive: true });
    const oldTombstone = path.join(backupsRoot, 'life-ledger-sync-worker.lock.stale-1234-1690000000000-abcd1234');
    const newTombstone = path.join(backupsRoot, 'life-ledger-sync-worker.lock.stale-5678-1690000000001-ef012345');
    await touchWithAge(oldTombstone, 2 * 60 * 60 * 1000);
    await touchWithAge(newTombstone, 1000);
    const plan = await planLifeLedgerRetention(backupsRoot, { staleLockMinutes: 60 });
    assert.equal(plan.lockTombstones.find(e => e.path === oldTombstone).decision, 'delete');
    assert.equal(plan.lockTombstones.find(e => e.path === newTombstone).decision, 'keep');
    const applied = await applyLifeLedgerRetentionPlan(plan);
    assert.ok(applied.deleted.some(d => d.path === oldTombstone));
    assert.ok(!(await fs.access(oldTombstone).then(() => true, () => false)));
    assert.ok(await fs.access(newTombstone).then(() => true, () => false));
  })
));

test('never touches anything outside the configured backupsRoot', async () => (
  withTempDir('chronasense-p11-retention-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    const sibling = path.join(tmp, 'sibling-untouched');
    await touchWithAge(path.join(backupsRoot, 'runs', 'old.json'), 90 * DAY);
    await touchWithAge(path.join(sibling, 'runs', 'old.json'), 90 * DAY);
    const plan = await planLifeLedgerRetention(backupsRoot, { retentionDays: 1, minKeep: 0 });
    await applyLifeLedgerRetentionPlan(plan);
    assert.ok(await fs.access(path.join(sibling, 'runs', 'old.json')).then(() => true, () => false), 'sibling directory must be untouched');
  })
));

test('a symlinked/junction entry inside backupsRoot is skipped, not deleted or followed', async () => {
  await withTempDir('chronasense-p11-retention-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    const outsideTarget = path.join(tmp, 'outside-target');
    await fs.mkdir(path.join(outsideTarget, 'Life Ledger'), { recursive: true });
    await fs.writeFile(path.join(outsideTarget, 'Life Ledger', 'sentinel.md'), 'do not touch', 'utf8');
    await fs.mkdir(path.join(backupsRoot, 'receipts'), { recursive: true });
    const linkPath = path.join(backupsRoot, 'receipts', 'evil-link');
    try {
      await fs.symlink(outsideTarget, linkPath, 'junction');
    } catch (err) {
      // Some environments restrict symlink/junction creation entirely — skip rather than fail.
      return;
    }
    const past = new Date(Date.now() - 90 * DAY);
    await fs.lutimes?.(linkPath, past, past).catch(() => {});
    const plan = await planLifeLedgerRetention(backupsRoot, { retentionDays: 1, minKeep: 0 });
    const entry = plan.receipts.find(e => e.name === 'evil-link');
    assert.equal(entry.decision, 'skip');
    assert.equal(entry.why, 'is_symlink');
    await applyLifeLedgerRetentionPlan(plan);
    assert.ok(await fs.access(path.join(outsideTarget, 'Life Ledger', 'sentinel.md')).then(() => true, () => false), 'link target must never be touched');
  });
});

test('computeLifeLedgerBackupsFootprint counts bytes and files, never follows symlinks', async () => (
  withTempDir('chronasense-p11-retention-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    await fs.mkdir(backupsRoot, { recursive: true });
    await fs.writeFile(path.join(backupsRoot, 'status.json'), '12345', 'utf8');
    await fs.mkdir(path.join(backupsRoot, 'runs'), { recursive: true });
    await fs.writeFile(path.join(backupsRoot, 'runs', 'a.json'), '1234567890', 'utf8');
    const footprint = await computeLifeLedgerBackupsFootprint(backupsRoot);
    assert.equal(footprint.exists, true);
    assert.equal(footprint.fileCount, 2);
    assert.equal(footprint.totalBytes, 5 + 10);
  })
));

test('CLI dry-run makes no changes; CLI --apply performs the same plan', async () => (
  withTempDir('chronasense-p11-retention-', async tmp => {
    const backupsRoot = path.join(tmp, 'backups');
    await touchWithAge(path.join(backupsRoot, 'runs', 'old.json'), 90 * DAY);
    await touchWithAge(path.join(backupsRoot, 'runs', 'new.json'), 0);
    const dry = await runLifeLedgerRetentionCli(['--backups-root', backupsRoot, '--retention-days', '1', '--min-keep', '1']);
    assert.equal(dry.applied, null);
    assert.equal(dry.plan.summary.runsToDelete, 1);
    assert.ok(await fs.access(path.join(backupsRoot, 'runs', 'old.json')).then(() => true, () => false));

    const applied = await runLifeLedgerRetentionCli(['--backups-root', backupsRoot, '--retention-days', '1', '--min-keep', '1', '--apply']);
    assert.equal(applied.applied.deleted.length, 1);
    assert.ok(!(await fs.access(path.join(backupsRoot, 'runs', 'old.json')).then(() => true, () => false)));
    assert.ok(await fs.access(path.join(backupsRoot, 'runs', 'new.json')).then(() => true, () => false));
  })
));
