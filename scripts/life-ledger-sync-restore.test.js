import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  loadRestoreReceipt,
  verifyRestoreReceipt,
  previewRestore,
  applyRestore,
  runLifeLedgerRestoreCli
} from './life-ledger-sync-restore.mjs';
import { runLifeLedgerSyncWorker, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME } from './life-ledger-sync-worker.mjs';
import { createObsidianSyncTarget, planObsidianSync, applyObsidianSync, prepareObsidianRollbackArtifact } from '../obsidian-life-ledger-sync.js';
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

// Review Finding 2 (Phase 11 fix pass) — a file whose current bytes differ from the pre-incident
// backup can NEVER be proven to be the failed incident's bytes rather than a later human edit
// (this system keeps no durable evidence of the expected post-incident bytes — see the module
// header). Restore must never auto-overwrite it.
test('a file whose current bytes differ from the pre-incident backup is reported ambiguous and NEVER auto-overwritten', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { vault, receiptPath } = await realCycleReceipt(cwd);
    const dailyPath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md');
    const originalContent = await fs.readFile(dailyPath, 'utf8');
    const editedContent = 'edited after the fact — could be damage OR a deliberate human change\n';
    await fs.writeFile(dailyPath, editedContent, 'utf8');

    const { receipt } = await loadRestoreReceipt(receiptPath);
    const verification = await verifyRestoreReceipt(receipt, { vault, mode: 'test' });
    assert.equal(verification.ok, true, JSON.stringify(verification));

    const preview = await previewRestore(receipt, { vault });
    const dailyEntry = preview.entries.find(e => e.relativePath === 'Life Ledger/Daily/2026-08-30.md');
    assert.equal(dailyEntry.action, 'ambiguous_current_state');
    assert.equal(dailyEntry.currentSha256, crypto.createHash('sha256').update(editedContent, 'utf8').digest('hex'));
    assert.equal(dailyEntry.preIncidentBackupSha256, crypto.createHash('sha256').update(originalContent, 'utf8').digest('hex'));
    assert.ok(dailyEntry.backupSourcePath);
    assert.ok(dailyEntry.note.length > 0);
    assert.equal(preview.completeness, 'manual_review_required');

    const applied = await applyRestore(receipt, preview, { vault });
    assert.equal(applied.completeness, 'manual_review_required', 'must never claim success when an ambiguous file exists');
    assert.equal(applied.written.length, 0, 'the ambiguous file must not be among the writes');
    assert.ok(applied.ambiguous.some(a => a.relativePath === 'Life Ledger/Daily/2026-08-30.md'));

    // The file — and therefore the evidence needed to manually decide what to do — is completely
    // untouched by the whole inspect/verify/preview/apply cycle.
    assert.equal(await fs.readFile(dailyPath, 'utf8'), editedContent);
  })
));

test('restore never touches files outside the managed Life Ledger subtree', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { vault, receiptPath } = await realCycleReceipt(cwd);
    await fs.writeFile(path.join(vault, '.obsidian', 'workspace.json'), '{"untouched":true}', 'utf8');
    const obsidianConfigBefore = await fs.readFile(path.join(vault, '.obsidian', 'workspace.json'), 'utf8');

    const dailyPath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md');
    await fs.writeFile(dailyPath, 'damaged\n', 'utf8');

    const { receipt } = await loadRestoreReceipt(receiptPath);
    await verifyRestoreReceipt(receipt, { vault, mode: 'test' });
    const preview = await previewRestore(receipt, { vault });
    await applyRestore(receipt, preview, { vault });

    const obsidianConfigAfter = await fs.readFile(path.join(vault, '.obsidian', 'workspace.json'), 'utf8');
    assert.equal(obsidianConfigAfter, obsidianConfigBefore);
    // No receipt.backup.files entry should ever reference a path outside Life Ledger/.
    assert.ok(receipt.backup.files.every(f => f.relativePath.startsWith('Life Ledger/')));
  })
));

test('a file created after the receipt was captured is a residual: reported, never restored/deleted, forces manual_review_required', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { vault, receiptPath } = await realCycleReceipt(cwd);
    const { receipt } = await loadRestoreReceipt(receiptPath);

    // A legitimate later write adds a new daily file the old receipt never saw.
    const laterPath = path.join(vault, 'Life Ledger', 'Daily', '2026-09-01.md');
    await fs.mkdir(path.dirname(laterPath), { recursive: true });
    await fs.writeFile(laterPath, 'later content, unrelated to this receipt\n', 'utf8');

    await verifyRestoreReceipt(receipt, { vault, mode: 'test' });
    const preview = await previewRestore(receipt, { vault });
    assert.ok(preview.extraCurrentFiles.includes('Life Ledger/Daily/2026-09-01.md'));
    assert.ok(preview.residualFiles.some(r => r.relativePath === 'Life Ledger/Daily/2026-09-01.md' && r.classification === 'residual_created_file'));
    assert.ok(!preview.entries.some(e => e.relativePath === 'Life Ledger/Daily/2026-09-01.md'));
    assert.equal(preview.completeness, 'manual_review_required');

    const applied = await applyRestore(receipt, preview, { vault });
    assert.equal(applied.completeness, 'manual_review_required', 'a residual file must prevent claiming full success');
    assert.ok(applied.notTouched.includes('Life Ledger/Daily/2026-09-01.md'));
    assert.ok(applied.residualFiles.some(r => r.relativePath === 'Life Ledger/Daily/2026-09-01.md'));
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

test('a receipt missing required fields (malformed) is rejected before any vault contact', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const malformedPath = path.join(cwd, 'malformed-receipt.json');
    await fs.writeFile(malformedPath, JSON.stringify({ kind: 'obsidian-rollback-receipt', schemaVersion: 2 }), 'utf8');
    await assert.rejects(loadRestoreReceipt(malformedPath), /receipt_malformed|Receipt is missing required field/);
  })
));

test('no delete-capable path exists anywhere in this module — grep-level static proof', async () => {
  const source = await fs.readFile(new URL('./life-ledger-sync-restore.mjs', import.meta.url), 'utf8');
  assert.ok(!/fsAdapter\.(rm|unlink|rmdir)\(/.test(source), 'restore must never call a filesystem delete primitive');
});

test('CLI: preview without --apply-restore makes no writes; with it, only the safe missing-file create happens', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    // This scenario needs a receipt whose backup exactly matches the vault's current CONSISTENT
    // state (manifest/sentinel/content all mutually agreeing) — i.e. an "accidental deletion of
    // an already-owned file, nothing else changed" recovery, not an in-progress/failed apply. A
    // receipt from a real worker cycle (any real cycle, even a fully successful one) legitimately
    // advances manifest.json/the sentinel relative to ITS OWN pre-apply backup — correctly
    // ambiguous under Finding 2's rule, same as any other file, and not what this test is after.
    // So the receipt here is captured directly (prepareObsidianRollbackArtifact), snapshotting a
    // vault that is not about to change at all.
    const vault = path.join(cwd, 'vault');
    const backupsRoot = path.join(cwd, 'backups');
    await seedOwnedVault(vault, [focusEvent()]);
    const target = createObsidianSyncTarget({ vaultPath: vault, mode: 'test', allowApply: true });
    const stablePlan = await planObsidianSync(target, [focusEvent()]); // same events -> nothing writable, pure snapshot
    assert.equal(stablePlan.blocked, false);
    const receiptRoot = path.join(backupsRoot, 'receipts', 'manual-snapshot');
    const receipt = await prepareObsidianRollbackArtifact({ target, plan: stablePlan, backupRoot: receiptRoot });
    const receiptPath = receipt.receiptPath;

    const dailyPath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md');
    const original = await fs.readFile(dailyPath, 'utf8');
    // A MISSING (not edited) previously-owned file is the one case restore can safely recreate —
    // nothing existing is at risk.
    await fs.unlink(dailyPath);

    const previewOnly = await runLifeLedgerRestoreCli(['--receipt', receiptPath, '--vault', vault]);
    assert.equal(previewOnly.applied, null);
    assert.equal(previewOnly.preview.completeness, 'exact_restore_possible');
    assert.equal(await fs.access(dailyPath).then(() => true, () => false), false);

    const applied = await runLifeLedgerRestoreCli(['--receipt', receiptPath, '--vault', vault, '--apply-restore']);
    assert.equal(applied.applied.completeness, 'exact_restore_complete');
    assert.ok(applied.applied.written.length > 0);
    assert.equal(await fs.readFile(dailyPath, 'utf8'), original);
  })
));

test('CLI: an ambiguous edit is never overwritten via --apply-restore, and the result is explicit about it', async () => (
  withTempDir('chronasense-p11-restore-', async cwd => {
    const { vault, receiptPath } = await realCycleReceipt(cwd);
    const dailyPath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md');
    await fs.writeFile(dailyPath, 'a human or a failed apply wrote this — restore cannot tell which\n', 'utf8');

    const applied = await runLifeLedgerRestoreCli(['--receipt', receiptPath, '--vault', vault, '--apply-restore']);
    assert.equal(applied.applied.completeness, 'manual_review_required');
    assert.equal(await fs.readFile(dailyPath, 'utf8'), 'a human or a failed apply wrote this — restore cannot tell which\n');
  })
));

// ---------------------------------------------------------------------------
// Review-required end-to-end scenarios (Phase 11 fix pass) — real worker, real fs, a REAL
// injected partial-apply failure (not a simulated/artificial one), disposable fixtures only.
// ---------------------------------------------------------------------------

// A fs adapter that lets the SECOND write to a ".tmp" file fail — same technique used in
// life-ledger-sync-worker.test.js and life-ledger-sync-chaos.test.js to produce a REAL
// partial_apply_failure / intervention_required outcome via the real, reviewed write path.
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

// REQUIRED: human-edit-after-failure test.
// 1. valid owned pre-state; 2. prepare a real existing-root receipt; 3. simulate a partial
// failure; 4. modify an affected managed file AFTER the failure with human bytes; 5. preview
// restore; 6. attempt --apply-restore. Required: the human edit is NOT overwritten, restore
// blocks/refuses that path, output clearly identifies ambiguity/manual review, no misleading
// "restore succeeded fully", and evidence (the human's edited file itself) remains available.
test('REQUIRED: a human edit made to an already-owned file AFTER a real partial-apply failure is never overwritten by restore', async () => (
  withTempDir('chronasense-p11-restore-human-edit-', async cwd => {
    const vault = path.join(cwd, 'vault');
    const outboxDir = path.join(cwd, 'outbox');
    const backupsRoot = path.join(cwd, 'backups');
    // 1. Valid owned pre-state: Daily/2026-08-30.md + System files, all consistent.
    await seedOwnedVault(vault, [focusEvent()]);
    // Introduce a second day so the apply has real writable ops (CREATE the new day, UPDATE
    // manifest, UPDATE sentinel) — 2026-08-30.md itself has nothing to write (already correct).
    await writeOutbox(outboxDir, [focusEvent(), focusEventDay2()]);
    const configPath = path.join(cwd, 'worker.config.json');
    await fs.writeFile(configPath, JSON.stringify({ outboxDir, vault, backupsRoot }), 'utf8');

    // 2 + 3. A REAL partial failure: the second .tmp write (manifest.json, phase 1, after the
    // new day's content phase 0 succeeds) fails — a real existing-root receipt is prepared
    // before any of this, and a real intervention latch is created.
    const failing = await runLifeLedgerSyncWorker(['--apply', '--config', configPath], { fs: breaksOnSecondTmpWriteFs() });
    assert.equal(failing.result.outcome, 'intervention_required');
    assert.equal(failing.result.category, 'after_write_partial');
    const receiptPath = failing.result.receiptPath;
    assert.ok(receiptPath, 'a real rollback receipt must exist for this incident');

    // 4. A human edits an AFFECTED managed file (one this receipt's backup actually covers)
    // AFTER the failure — e.g. manually correcting the Daily note by hand.
    const dailyPath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md');
    const humanBytes = 'I fixed this by hand after the sync broke, please do not overwrite me\n';
    await fs.writeFile(dailyPath, humanBytes, 'utf8');

    // 5. Preview restore.
    const { receipt } = await loadRestoreReceipt(receiptPath);
    const verification = await verifyRestoreReceipt(receipt, { vault, mode: 'test' });
    assert.equal(verification.ok, true, JSON.stringify(verification));
    const preview = await previewRestore(receipt, { vault });
    const dailyEntry = preview.entries.find(e => e.relativePath === 'Life Ledger/Daily/2026-08-30.md');
    assert.equal(dailyEntry.action, 'ambiguous_current_state');
    assert.equal(preview.completeness, 'manual_review_required');

    // 6. Attempt --apply-restore.
    const applied = await applyRestore(receipt, preview, { vault });

    // Required assertions.
    assert.equal(await fs.readFile(dailyPath, 'utf8'), humanBytes, 'the human edit must survive completely untouched');
    assert.ok(!applied.written.some(w => w.relativePath === 'Life Ledger/Daily/2026-08-30.md'), 'restore must refuse to write this path');
    assert.ok(applied.ambiguous.some(a => a.relativePath === 'Life Ledger/Daily/2026-08-30.md'), 'output must clearly identify the ambiguity');
    assert.notEqual(applied.completeness, 'exact_restore_complete', 'must never claim the restore fully succeeded');
    assert.equal(applied.completeness, 'manual_review_required');
    // Evidence remains available: the human's bytes are still on disk, and the pre-incident
    // backup bytes are still intact and readable for comparison.
    const backupSrc = path.join(receipt.backup.backupArtifactPath, 'Life Ledger', 'Daily', '2026-08-30.md');
    assert.ok(await fs.access(backupSrc).then(() => true, () => false));
  })
));

// REQUIRED: CREATE-before-failure / incomplete-restore test.
// Pre-state: Daily/old-date.md, System/README.md, manifest, sentinel. Target introduces
// Daily/new-date.md. Partial apply creates it, then fails before completing manifest/sentinel.
// Receipt backup naturally does NOT contain Daily/new-date.md. Restore must truthfully represent
// that the exact pre-state (here: "new-date.md never existed") has not been achieved.
test('REQUIRED: a file CREATEd just before a real partial-apply failure is a named residual, restore never claims complete success', async () => (
  withTempDir('chronasense-p11-restore-residual-', async cwd => {
    const vault = path.join(cwd, 'vault');
    const outboxDir = path.join(cwd, 'outbox');
    const backupsRoot = path.join(cwd, 'backups');
    // Pre-state: Daily/2026-08-30.md ("old-date"), System/README.md, manifest, sentinel.
    await seedOwnedVault(vault, [focusEvent()]);
    // Target introduces Daily/2026-08-31.md ("new-date") via a second event.
    await writeOutbox(outboxDir, [focusEvent(), focusEventDay2()]);
    const configPath = path.join(cwd, 'worker.config.json');
    await fs.writeFile(configPath, JSON.stringify({ outboxDir, vault, backupsRoot }), 'utf8');

    // Partial apply: content phase (the new day) succeeds, then the SECOND .tmp write
    // (manifest.json) fails — manifest/sentinel are never completed.
    const failing = await runLifeLedgerSyncWorker(['--apply', '--config', configPath], { fs: breaksOnSecondTmpWriteFs() });
    assert.equal(failing.result.outcome, 'intervention_required');
    assert.ok(failing.result.written.includes('Life Ledger/Daily/2026-08-31.md'), 'the new day must have actually been created before the failure');
    const newDatePath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-31.md');
    assert.ok(await fs.access(newDatePath).then(() => true, () => false), 'the residual file is really there');

    const { receipt } = await loadRestoreReceipt(failing.result.receiptPath);
    // The receipt's own pre-apply backup naturally does NOT contain the new day.
    assert.ok(!receipt.backup.files.some(f => f.relativePath === 'Life Ledger/Daily/2026-08-31.md'));

    const verification = await verifyRestoreReceipt(receipt, { vault, mode: 'test' });
    assert.equal(verification.ok, true, JSON.stringify(verification));
    const preview = await previewRestore(receipt, { vault });

    // Required: names the exact residual path, states write-only restore cannot remove it,
    // states the exact pre-incident state will not be achieved, and this must never be silently
    // treated as "handled".
    const residual = preview.residualFiles.find(r => r.relativePath === 'Life Ledger/Daily/2026-08-31.md');
    assert.ok(residual, 'the exact residual path must be named');
    assert.equal(residual.classification, 'residual_created_file');
    assert.match(residual.note, /cannot remove|not.*achieved|review/i);
    assert.equal(preview.completeness, 'manual_review_required');

    const applied = await applyRestore(receipt, preview, { vault });
    assert.notEqual(applied.completeness, 'exact_restore_complete', 'must never report complete/full success while a residual exists');
    assert.equal(applied.completeness, 'manual_review_required');
    assert.ok(applied.residualFiles.some(r => r.relativePath === 'Life Ledger/Daily/2026-08-31.md'));
    // The residual file itself is left exactly as it was — restore is write-only and never
    // deletes it, but also never pretends it isn't there.
    assert.ok(await fs.access(newDatePath).then(() => true, () => false));
  })
));
