import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadRestoreReceipt,
  verifyRestoreReceipt,
  previewRestore,
  applyRestore,
  runLifeLedgerRestoreCli
} from './life-ledger-sync-restore.mjs';
import { runLifeLedgerSyncWorker, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME } from './life-ledger-sync-worker.mjs';
import { createObsidianSyncTarget, planObsidianSync, applyObsidianSync } from '../obsidian-life-ledger-sync.js';
import { serializeLifeLedgerSnapshot, createLifeLedgerSnapshotFromEvents } from '../life-ledger-transport.js';

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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

// A rollback receipt's `backup` is a PRE-apply snapshot of the whole managed subtree — it can
// only ever contain files that already existed before that apply ran. A file newly CREATED by
// the very same apply is deliberately absent from its own receipt (there is nothing to "roll
// back" to). So every fixture here does two real cycles: the first (via direct test-mode apply)
// establishes Daily/2026-08-30.md as pre-existing, owned content; the second (the real worker
// --apply cycle under test) adds a further day, producing a receipt whose backup captures
// 2026-08-30.md's PRE-second-apply bytes — that file is what these tests corrupt and restore.
async function realCycleReceipt(cwd, extraEvents = [focusEventDay2()]) {
  const vault = path.join(cwd, 'vault');
  const outboxDir = path.join(cwd, 'outbox');
  const backupsRoot = path.join(cwd, 'backups');
  await seedOwnedVault(vault, [focusEvent()]);
  await writeOutbox(outboxDir, [focusEvent(), ...extraEvents]);
  const configPath = path.join(cwd, 'worker.config.json');
  await fs.writeFile(configPath, JSON.stringify({ outboxDir, vault, backupsRoot }), 'utf8');
  const outcome = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
  assert.equal(outcome.result.outcome, 'synced', `expected a real synced cycle to set up the fixture, got: ${JSON.stringify(outcome.result)}`);
  return { vault, outboxDir, backupsRoot, receiptPath: outcome.result.receiptPath };
}

test('inspect -> verify -> preview -> apply restores a damaged file back to its exact backed-up bytes', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { vault, backupsRoot, receiptPath } = await realCycleReceipt(cwd);
    const dailyPath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md');
    const originalContent = await fs.readFile(dailyPath, 'utf8');
    // Simulate exactly the failure this tool exists for: a partial/corrupted write left a
    // previously-owned file damaged.
    await fs.writeFile(dailyPath, 'CORRUPTED CONTENT — not the real Daily note\n', 'utf8');

    const { receipt } = await loadRestoreReceipt(receiptPath);
    const verification = await verifyRestoreReceipt(receipt, { vault, mode: 'test' });
    assert.equal(verification.ok, true, JSON.stringify(verification));

    const preview = await previewRestore(receipt, { vault });
    const dailyEntry = preview.entries.find(e => e.relativePath === 'Life Ledger/Daily/2026-08-30.md');
    assert.equal(dailyEntry.action, 'restore_overwrite');

    // Preview alone must never write anything.
    assert.equal(await fs.readFile(dailyPath, 'utf8'), 'CORRUPTED CONTENT — not the real Daily note\n');

    const applied = await applyRestore(receipt, preview, { vault, backupsRoot });
    assert.ok(applied.written.some(w => w.relativePath === 'Life Ledger/Daily/2026-08-30.md'));
    const restoredContent = await fs.readFile(dailyPath, 'utf8');
    assert.equal(restoredContent, originalContent);

    // Evidence of the corrupted bytes was preserved before being overwritten.
    assert.ok(applied.evidenceDir);
    const evidenceContent = await fs.readFile(path.join(applied.evidenceDir, 'Life Ledger', 'Daily', '2026-08-30.md'), 'utf8');
    assert.equal(evidenceContent, 'CORRUPTED CONTENT — not the real Daily note\n');

    // Idempotent: re-running preview against the now-restored vault reports no further changes
    // for that file.
    const preview2 = await previewRestore(receipt, { vault });
    const dailyEntry2 = preview2.entries.find(e => e.relativePath === 'Life Ledger/Daily/2026-08-30.md');
    assert.equal(dailyEntry2.action, 'noop_already_matches');
  })
));

test('restore never touches files outside the managed Life Ledger subtree', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { vault, backupsRoot, receiptPath } = await realCycleReceipt(cwd);
    await fs.writeFile(path.join(vault, '.obsidian', 'workspace.json'), '{"untouched":true}', 'utf8');
    const obsidianConfigBefore = await fs.readFile(path.join(vault, '.obsidian', 'workspace.json'), 'utf8');

    const dailyPath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md');
    await fs.writeFile(dailyPath, 'damaged\n', 'utf8');

    const { receipt } = await loadRestoreReceipt(receiptPath);
    await verifyRestoreReceipt(receipt, { vault, mode: 'test' });
    const preview = await previewRestore(receipt, { vault });
    await applyRestore(receipt, preview, { vault, backupsRoot });

    const obsidianConfigAfter = await fs.readFile(path.join(vault, '.obsidian', 'workspace.json'), 'utf8');
    assert.equal(obsidianConfigAfter, obsidianConfigBefore);
    // No receipt.backup.files entry should ever reference a path outside Life Ledger/.
    assert.ok(receipt.backup.files.every(f => f.relativePath.startsWith('Life Ledger/')));
  })
));

test('a file created after the receipt was captured is reported but never restored/deleted', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { vault, backupsRoot, receiptPath } = await realCycleReceipt(cwd);
    const { receipt } = await loadRestoreReceipt(receiptPath);

    // A legitimate later write adds a new daily file the old receipt never saw.
    const laterPath = path.join(vault, 'Life Ledger', 'Daily', '2026-09-01.md');
    await fs.mkdir(path.dirname(laterPath), { recursive: true });
    await fs.writeFile(laterPath, 'later content, unrelated to this receipt\n', 'utf8');

    await verifyRestoreReceipt(receipt, { vault, mode: 'test' });
    const preview = await previewRestore(receipt, { vault });
    assert.ok(preview.extraCurrentFiles.includes('Life Ledger/Daily/2026-09-01.md'));
    assert.ok(!preview.entries.some(e => e.relativePath === 'Life Ledger/Daily/2026-09-01.md'));

    const applied = await applyRestore(receipt, preview, { vault, backupsRoot });
    assert.ok(applied.notTouched.includes('Life Ledger/Daily/2026-09-01.md'));
    assert.equal(await fs.readFile(laterPath, 'utf8'), 'later content, unrelated to this receipt\n');
  })
));

test('verification fails closed when the receipt is bound to a different vault', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { receiptPath } = await realCycleReceipt(cwd);
    const otherVault = path.join(cwd, 'other-vault');
    await seedOwnedVault(otherVault, []);
    const { receipt } = await loadRestoreReceipt(receiptPath);
    const verification = await verifyRestoreReceipt(receipt, { vault: otherVault, mode: 'test' });
    assert.equal(verification.ok, false);
    assert.equal(verification.stage, 'vault_binding');
  })
));

test('verification fails closed when the backup artifact bytes have been tampered with', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { vault, receiptPath } = await realCycleReceipt(cwd);
    const { receipt } = await loadRestoreReceipt(receiptPath);
    const backedUpDaily = path.join(receipt.backup.backupArtifactPath, 'Life Ledger', 'Daily', '2026-08-30.md');
    await fs.writeFile(backedUpDaily, 'tampered backup bytes\n', 'utf8');
    const verification = await verifyRestoreReceipt(receipt, { vault, mode: 'test' });
    assert.equal(verification.ok, false);
    assert.equal(verification.stage, 'backup_integrity');
  })
));

test('verification fails closed when the vault is not currently owned', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { receiptPath } = await realCycleReceipt(cwd);
    const unownedVault = path.join(cwd, 'unowned-vault');
    await fs.mkdir(path.join(unownedVault, '.obsidian'), { recursive: true });
    const { receipt } = await loadRestoreReceipt(receiptPath);
    const verification = await verifyRestoreReceipt(receipt, { vault: unownedVault, mode: 'test' });
    assert.equal(verification.ok, false);
    assert.equal(verification.stage, 'ownership');
  })
));

test('a receipt claiming managedRootExistedBefore:false is refused as out of scope for this tool', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { vault } = await realCycleReceipt(cwd);
    const fakeReceiptPath = path.join(cwd, 'fake-first-run-receipt.json');
    await fs.writeFile(fakeReceiptPath, JSON.stringify({
      kind: 'obsidian-rollback-receipt', schemaVersion: 2,
      canonicalVaultRoot: await fs.realpath(vault),
      canonicalManagedRoot: path.join(await fs.realpath(vault), 'Life Ledger'),
      managedRoot: 'Life Ledger', managedRootExistedBefore: false, planFingerprint: 'x', backup: null
    }), 'utf8');
    const { receipt } = await loadRestoreReceipt(fakeReceiptPath);
    const verification = await verifyRestoreReceipt(receipt, { vault, mode: 'test' });
    assert.equal(verification.ok, false);
    assert.equal(verification.stage, 'scope');
    assert.equal(verification.reason, 'first_run_receipt_unsupported_by_restore_tool');
  })
));

test('a receipt path that is a directory is refused before any parsing', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const dirPath = path.join(cwd, 'receipt-is-a-dir');
    await fs.mkdir(dirPath, { recursive: true });
    await assert.rejects(loadRestoreReceipt(dirPath), /not a plain file/);
  })
));

test('a symlinked receipt path is refused, never followed', async () => {
  await withTempDir('chronasense-p11-restore-', async cwd => {
    const realReceipt = path.join(cwd, 'real-receipt.json');
    await fs.writeFile(realReceipt, '{"kind":"obsidian-rollback-receipt"}', 'utf8');
    const linkPath = path.join(cwd, 'link-receipt.json');
    try {
      await fs.symlink(realReceipt, linkPath, 'file');
    } catch {
      return;
    }
    await assert.rejects(loadRestoreReceipt(linkPath), /not a plain file/);
  });
});

test('CLI: preview without --apply-restore makes no writes; with it, writes happen', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { vault, backupsRoot, receiptPath } = await realCycleReceipt(cwd);
    const dailyPath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md');
    const original = await fs.readFile(dailyPath, 'utf8');
    await fs.writeFile(dailyPath, 'damaged via CLI test\n', 'utf8');

    const previewOnly = await runLifeLedgerRestoreCli(['--receipt', receiptPath, '--vault', vault]);
    assert.equal(previewOnly.applied, null);
    assert.equal(await fs.readFile(dailyPath, 'utf8'), 'damaged via CLI test\n');

    const applied = await runLifeLedgerRestoreCli(['--receipt', receiptPath, '--vault', vault, '--apply-restore', '--backups-root', backupsRoot]);
    assert.ok(applied.applied.written.length > 0);
    assert.equal(await fs.readFile(dailyPath, 'utf8'), original);
  })
));
