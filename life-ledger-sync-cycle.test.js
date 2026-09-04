import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runLifeLedgerSyncCycle, summarizeCycleResultForOutbox } from './life-ledger-sync-cycle.js';
import {
  createObsidianSyncTarget,
  planObsidianSync,
  applyObsidianSync,
  OBSIDIAN_MANIFEST_RELATIVE_PATH,
  OBSIDIAN_SENTINEL_RELATIVE_PATH
} from './obsidian-life-ledger-sync.js';
import { OBSIDIAN_LIFE_LEDGER_SENTINEL } from './obsidian-life-ledger-renderer.js';
import { serializeLifeLedgerSnapshot, createLifeLedgerSnapshotFromEvents } from './life-ledger-transport.js';

const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

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
      activity: 'Synthetic focus',
      startedAt: '2026-08-30T15:35:00.000Z',
      endedAt: '2026-08-30T16:00:00.000Z',
      durationMinutes: 25,
      additiveForTimeTotals: false,
      source: { focusEntryId: 'focus-entry-1' }
    },
    provenance: {
      source: 'chronasense',
      sourceRecordKind: 'chronasense.focus_outcome',
      adapterVersion: 'test-v1',
      observedAt: '2026-08-30T16:00:00.000Z',
      captureMethod: 'pomodoro',
      evidence: ['synthetic.focus:1']
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

function outboxJson(events) {
  return serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents(events));
}

async function withTempVault(fn, { obsidian = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronasense-p10-vault-'));
  try {
    if (obsidian) await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Seeds a vault into an "owned, existing-root" state the way a prior first-run apply would have
// left it — using the already-reviewed test-mode apply path purely as a fixture setup device.
// The resulting sentinel/manifest are mode-agnostic, so this is a faithful stand-in for "a real
// vault that was onboarded previously" without touching production authorization at all.
async function seedOwnedVault(vault, events) {
  const target = createObsidianSyncTarget({ vaultPath: vault, mode: 'test', allowApply: true });
  const plan = await planObsidianSync(target, events);
  assert.equal(plan.blocked, false, 'seed plan should not be blocked');
  await fs.writeFile(path.join(vault, 'TEST-VAULT.md'), 'test vault\n', 'utf8');
  const result = await applyObsidianSync(plan, { mode: 'test', apply: true });
  await fs.rm(path.join(vault, 'TEST-VAULT.md'));
  return result;
}

function freshBackupRoot(base) {
  return path.join(base, `run-${crypto.randomUUID()}`);
}

async function readVaultFile(vault, rel) {
  try {
    return await fs.readFile(path.join(vault, ...rel.split('/')), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function listVaultFiles(vault) {
  const files = [];
  async function walk(dir, rel) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
      else files.push(childRel);
    }
  }
  await walk(path.join(vault, 'Life Ledger'), 'Life Ledger');
  return files.sort();
}

// ===========================================================================
// Basic shape / no-source / invalid input
// ===========================================================================

test('runLifeLedgerSyncCycle requires a runId', async () => {
  await assert.rejects(() => runLifeLedgerSyncCycle({}), e => e.code === 'invalid_options');
});

test('no outbox snapshot -> no_source, zero vault interaction', async () => {
  const result = await runLifeLedgerSyncCycle({ runId: 'r1', outboxSnapshotJson: null, vaultPath: 'C:\\Nope', expectedCanonicalVaultPath: 'C:\\Nope', backupRoot: 'C:\\Nope\\backup' });
  assert.equal(result.outcome, 'no_source');
});

test('malformed outbox JSON -> error/before_write, safe to retry', async () => {
  const result = await runLifeLedgerSyncCycle({ runId: 'r2', outboxSnapshotJson: '{not json', vaultPath: 'C:\\Nope', expectedCanonicalVaultPath: 'C:\\Nope', backupRoot: 'C:\\Nope\\backup' });
  assert.equal(result.outcome, 'error');
  assert.equal(result.category, 'before_write');
  assert.equal(result.reason, 'invalid_outbox_snapshot');
});

test('missing vault -> error/before_write (vault_missing), safe to retry', async () => {
  const result = await runLifeLedgerSyncCycle({
    runId: 'r3', outboxSnapshotJson: outboxJson([]),
    vaultPath: 'C:\\Definitely\\Not\\A\\Real\\Vault\\Path', expectedCanonicalVaultPath: 'C:\\Definitely\\Not\\A\\Real\\Vault\\Path',
    backupRoot: 'C:\\Nope\\backup'
  });
  assert.equal(result.outcome, 'error');
  assert.equal(result.category, 'before_write');
});

// ===========================================================================
// First-run guard — automation never creates a managed root
// ===========================================================================

test('brand-new vault (no managed root) -> intervention_required, zero writes, never auto-first-runs', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      const result = await runLifeLedgerSyncCycle({
        runId: 'first-run-guard', outboxSnapshotJson: outboxJson([focusEvent()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase)
      });
      assert.equal(result.outcome, 'intervention_required');
      assert.equal(result.reason, 'unexpected_first_run_state');
      const exists = await fs.access(path.join(vault, 'Life Ledger')).then(() => true, () => false);
      assert.equal(exists, false, 'no managed root should have been created');
    })
  ))
));

// ===========================================================================
// Happy path: temp existing-root end-to-end proof (capability 23/24)
// ===========================================================================

test('E2E: existing-root vault, first changing cycle syncs, second unchanged cycle writes nothing', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, [focusEvent()]);
      const filesBeforeChange = await listVaultFiles(vault);

      // First changing cycle: a new day-2 event exists in the outbox but not yet in the vault.
      const snapshotJson = outboxJson([focusEvent(), focusEventDay2()]);
      const runA = await runLifeLedgerSyncCycle({
        runId: 'cycle-a', outboxSnapshotJson: snapshotJson,
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase)
      });
      assert.equal(runA.outcome, 'synced');
      assert.ok(runA.written.length >= 2, 'expect the new Daily file plus manifest/sentinel refresh');
      const receiptRaw = await fs.readFile(runA.receiptPath, 'utf8');
      const receipt = JSON.parse(receiptRaw);
      assert.equal(receipt.managedRootExistedBefore, true);
      assert.ok(receipt.backup && Array.isArray(receipt.backup.files) && receipt.backup.files.length === filesBeforeChange.length, 'existing-root receipt must back up the exact pre-state file set');

      // Second cycle with the SAME snapshot: must be a no-op.
      const filesAfterFirstSync = await listVaultFiles(vault);
      const runB = await runLifeLedgerSyncCycle({
        runId: 'cycle-b', outboxSnapshotJson: snapshotJson,
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase)
      });
      assert.equal(runB.outcome, 'unchanged');
      assert.equal(runB.written, undefined);
      assert.deepEqual(await listVaultFiles(vault), filesAfterFirstSync, 'unchanged cycle must write nothing');
    })
  ))
));

test('restart does not duplicate events: re-running the identical cycle twice yields the same file set', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, []);
      const snapshotJson = outboxJson([focusEvent()]);
      await runLifeLedgerSyncCycle({ runId: 'restart-a', outboxSnapshotJson: snapshotJson, vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase) });
      const filesAfterFirst = await listVaultFiles(vault);
      const runAgain = await runLifeLedgerSyncCycle({ runId: 'restart-b', outboxSnapshotJson: snapshotJson, vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase) });
      assert.equal(runAgain.outcome, 'unchanged');
      assert.deepEqual(await listVaultFiles(vault), filesAfterFirst, 'no duplicate Daily entries or files after restart-equivalent re-run');
    })
  ))
));

// ===========================================================================
// Rollback artifact — fresh generation + stale/collision rejection
// ===========================================================================

test('a pre-existing receipt file at the chosen backupRoot blocks preparation, zero vault writes', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, [focusEvent()]);
      const before = await listVaultFiles(vault);
      const backupRoot = freshBackupRoot(backupBase);
      await fs.mkdir(backupRoot, { recursive: true });
      await fs.writeFile(path.join(backupRoot, 'obsidian-rollback-receipt.json'), '{"kind":"stale"}\n', 'utf8');

      const result = await runLifeLedgerSyncCycle({
        runId: 'stale-receipt', outboxSnapshotJson: outboxJson([focusEvent(), focusEventDay2()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot
      });
      assert.equal(result.outcome, 'error');
      assert.equal(result.category, 'before_write');
      assert.equal(result.reason, 'backup_artifact_exists');
      assert.deepEqual(await listVaultFiles(vault), before, 'vault must be untouched');
    })
  ))
));

// ===========================================================================
// Conflict fail-closed — human edit / manifest tamper / sentinel tamper / unowned collision
// ===========================================================================

test('human-edited Daily file fails closed: conflict, zero writes anywhere', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, [focusEvent()]);
      const dailyPath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md');
      const original = await fs.readFile(dailyPath, 'utf8');
      await fs.writeFile(dailyPath, `${original}\n\nHand-typed note from a human.\n`, 'utf8');
      const before = await listVaultFiles(vault);

      const result = await runLifeLedgerSyncCycle({
        runId: 'human-edit', outboxSnapshotJson: outboxJson([focusEvent(), focusEventDay2()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase)
      });
      assert.equal(result.outcome, 'conflict');
      assert.ok(result.conflicts.some(c => c.reason === 'human_modified_owned_file'));
      assert.deepEqual(await listVaultFiles(vault), before, 'no file, including the untouched new Daily entry, should be written while a conflict exists');
    })
  ))
));

test('manifest tamper fails closed: conflict, zero writes', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, [focusEvent()]);
      const manifestPath = path.join(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH.split('/').join(path.sep));
      const tampered = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      tampered.files[0].sha256 = '0'.repeat(64);
      await fs.writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
      const before = await listVaultFiles(vault);

      const result = await runLifeLedgerSyncCycle({
        runId: 'manifest-tamper', outboxSnapshotJson: outboxJson([focusEvent()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase)
      });
      assert.equal(result.outcome, 'conflict');
      assert.equal(result.reason, 'manifest_integrity_mismatch');
      assert.deepEqual(await listVaultFiles(vault), before);
    })
  ))
));

test('sentinel tamper fails closed: conflict, zero writes', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, [focusEvent()]);
      const sentinelPath = path.join(vault, OBSIDIAN_SENTINEL_RELATIVE_PATH.split('/').join(path.sep));
      const original = await fs.readFile(sentinelPath, 'utf8');
      await fs.writeFile(sentinelPath, original.replace('Managed by ChronaSense', 'Managed by Someone Else'), 'utf8');
      const before = await listVaultFiles(vault);

      const result = await runLifeLedgerSyncCycle({
        runId: 'sentinel-tamper', outboxSnapshotJson: outboxJson([focusEvent()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase)
      });
      assert.equal(result.outcome, 'conflict');
      assert.equal(result.reason, 'sentinel_content_mismatch');
      assert.deepEqual(await listVaultFiles(vault), before);
    })
  ))
));

test('ownership failure blocks: managed root replaced by a plain file', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, [focusEvent()]);
      await fs.rm(path.join(vault, 'Life Ledger'), { recursive: true, force: true });
      await fs.writeFile(path.join(vault, 'Life Ledger'), 'not a directory\n', 'utf8');

      const result = await runLifeLedgerSyncCycle({
        runId: 'ownership-failure', outboxSnapshotJson: outboxJson([focusEvent()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase)
      });
      assert.equal(result.outcome, 'conflict');
      assert.equal(result.reason, 'managed_root_not_a_plain_directory');
    })
  ))
));

test('unowned collision (a non-ChronaSense file at a generated path) fails closed', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await fs.mkdir(path.join(vault, 'Life Ledger', 'Daily'), { recursive: true });
      await fs.writeFile(path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md'), 'A human already made this file.\n', 'utf8');

      const result = await runLifeLedgerSyncCycle({
        runId: 'unowned-collision', outboxSnapshotJson: outboxJson([focusEvent()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase)
      });
      // The managed root directory exists (we created Daily/ under it) but carries no sentinel —
      // an unmanaged-root conflict, distinct from a genuine first-run (absent directory).
      assert.equal(result.outcome, 'conflict');
      assert.equal(result.reason, 'sentinel_missing');
    })
  ))
));

// ===========================================================================
// Precondition race (Fix 6) — plan says X, disk says Y by the time apply re-checks
// ===========================================================================

test('precondition race between plan and apply is caught and fails closed, zero writes', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, [focusEvent()]);
      const before = await listVaultFiles(vault);
      const readmePath = path.join(vault, 'Life Ledger', 'System', 'README.md');

      // A stateful fs adapter: the FIRST read of README.md (during the cycle's own plan) sees the
      // real on-disk (owned) content; every subsequent read of that exact file (i.e. apply's
      // Fix-6 preflight re-check) sees a simulated concurrent edit instead — modelling a human (or
      // another sync agent) editing the file in the narrow window between plan and apply.
      const realFs = await import('node:fs/promises');
      let readmeReadCount = 0;
      const raceFs = {
        mkdir: (...a) => realFs.mkdir(...a),
        readFile: async (p, enc) => {
          if (path.resolve(p) === path.resolve(readmePath)) {
            readmeReadCount++;
            if (readmeReadCount > 1) return 'races happen\n';
          }
          return realFs.readFile(p, enc);
        },
        writeFile: (...a) => realFs.writeFile(...a),
        rename: (...a) => realFs.rename(...a),
        unlink: (...a) => realFs.unlink(...a),
        readdir: (...a) => realFs.readdir(...a),
        lstat: (...a) => realFs.lstat(...a),
        realpath: (...a) => realFs.realpath(...a)
      };

      const result = await runLifeLedgerSyncCycle({
        runId: 'precondition-race', outboxSnapshotJson: outboxJson([focusEvent(), focusEventDay2()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase),
        fs: raceFs
      });
      assert.equal(result.outcome, 'conflict');
      assert.equal(result.category, 'before_write');
      assert.equal(result.reason, 'precondition_changed');
      assert.deepEqual(await listVaultFiles(vault), before, 'the race must be caught before any write lands');
    })
  ))
));

// ===========================================================================
// Failure taxonomy — before-write (retryable) vs after-write-started (never blind-retried)
// ===========================================================================

test('a transient failure before any write (rollback prep) is safe to retry: next cycle with normal fs succeeds', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, [focusEvent()]);
      const before = await listVaultFiles(vault);
      const backupRoot = freshBackupRoot(backupBase);

      const realFs = await import('node:fs/promises');
      let mkdirCalls = 0;
      const flakyFs = {
        mkdir: async (p, opts) => {
          if (path.resolve(p) === path.resolve(backupRoot)) {
            mkdirCalls++;
            if (mkdirCalls === 1) throw Object.assign(new Error('simulated transient failure'), { code: 'EBUSY' });
          }
          return realFs.mkdir(p, opts);
        },
        readFile: (...a) => realFs.readFile(...a),
        writeFile: (...a) => realFs.writeFile(...a),
        rename: (...a) => realFs.rename(...a),
        unlink: (...a) => realFs.unlink(...a),
        readdir: (...a) => realFs.readdir(...a),
        lstat: (...a) => realFs.lstat(...a),
        realpath: (...a) => realFs.realpath(...a)
      };

      const attempt1 = await runLifeLedgerSyncCycle({
        runId: 'flaky-1', outboxSnapshotJson: outboxJson([focusEvent(), focusEventDay2()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot, fs: flakyFs
      });
      assert.equal(attempt1.outcome, 'error');
      assert.equal(attempt1.category, 'before_write');
      assert.deepEqual(await listVaultFiles(vault), before, 'zero writes on the failed attempt');

      const attempt2 = await runLifeLedgerSyncCycle({
        runId: 'flaky-2', outboxSnapshotJson: outboxJson([focusEvent(), focusEventDay2()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase), fs: flakyFs
      });
      assert.equal(attempt2.outcome, 'synced', 'a later cycle with the transient condition resolved must succeed');
    })
  ))
));

test('a failure after writes started (partial apply) is intervention_required, never blindly retried within the call, and safely resumable (not corrupted) later', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, [focusEvent()]);

      const realFs = await import('node:fs/promises');
      let tempWriteCount = 0;
      const breaksAfterFirstWriteFs = {
        mkdir: (...a) => realFs.mkdir(...a),
        readFile: (...a) => realFs.readFile(...a),
        writeFile: async (p, content, enc) => {
          if (String(p).endsWith('.tmp')) {
            tempWriteCount++;
            if (tempWriteCount === 2) throw Object.assign(new Error('simulated disk failure mid-apply'), { code: 'EIO' });
          }
          return realFs.writeFile(p, content, enc);
        },
        rename: (...a) => realFs.rename(...a),
        unlink: (...a) => realFs.unlink(...a),
        readdir: (...a) => realFs.readdir(...a),
        lstat: (...a) => realFs.lstat(...a),
        realpath: (...a) => realFs.realpath(...a)
      };

      const result = await runLifeLedgerSyncCycle({
        runId: 'partial-1', outboxSnapshotJson: outboxJson([focusEvent(), focusEventDay2()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase), fs: breaksAfterFirstWriteFs
      });
      assert.equal(result.outcome, 'intervention_required');
      assert.equal(result.category, 'after_write_partial');
      assert.equal(result.written.length, 1, 'exactly the first (content-phase) file should have landed');
      assert.equal(result.failedRelativePath, OBSIDIAN_MANIFEST_RELATIVE_PATH);

      // The module itself never loops/retries within this call — exactly one attempt, reported
      // precisely (written + failedRelativePath), no automatic follow-up write. Separately: the
      // underlying apply is intentionally phase-ordered (content, then manifest, then sentinel)
      // so that a half-applied vault is never corrupted — the one file that DID land already has
      // byte-identical target content, so a later independent cycle can safely complete the
      // interrupted sync (finishing only the still-pending manifest/sentinel writes) rather than
      // being permanently jammed. That later cycle is a fresh, independently-evaluated run, not a
      // retry loop inside this one — and it must not rewrite the file that already landed.
      const followUp = await runLifeLedgerSyncCycle({
        runId: 'partial-2', outboxSnapshotJson: outboxJson([focusEvent(), focusEventDay2()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase)
      });
      assert.equal(followUp.outcome, 'synced');
      assert.equal(followUp.written.length, 2, 'only the still-pending manifest + sentinel should be written; the already-landed Daily file must not be rewritten');
      assert.ok(!followUp.written.includes('Life Ledger/Daily/2026-08-31.md'));
    })
  ))
));

// ===========================================================================
// Status truthfulness / no secrets
// ===========================================================================

test('summarizeCycleResultForOutbox carries no filesystem paths outside the browser-writable envelope', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, []);
      const result = await runLifeLedgerSyncCycle({
        runId: 'status-shape', outboxSnapshotJson: outboxJson([focusEvent()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase)
      });
      assert.equal(result.outcome, 'synced');
      const summary = summarizeCycleResultForOutbox(result);
      const json = JSON.stringify(summary);
      assert.ok(!json.includes(vault), 'vault path must not leak into the outbox-facing status');
      assert.ok(!json.includes(backupBase), 'backup path must not leak into the outbox-facing status');
      assert.equal(summary.outcome, 'synced');
      assert.equal(typeof summary.outboxSha256, 'string');
    })
  ))
));

test('dryRun identifies pending writes without touching the vault', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-p10-backup-', async backupBase => {
      await seedOwnedVault(vault, [focusEvent()]);
      const before = await listVaultFiles(vault);
      const result = await runLifeLedgerSyncCycle({
        runId: 'dry-run', outboxSnapshotJson: outboxJson([focusEvent(), focusEventDay2()]),
        vaultPath: vault, expectedCanonicalVaultPath: vault, backupRoot: freshBackupRoot(backupBase),
        dryRun: true
      });
      assert.equal(result.outcome, 'would_sync');
      assert.ok(result.operations.length >= 2);
      assert.deepEqual(await listVaultFiles(vault), before, 'dry run must not write anything');
      const backupExists = await fs.access(backupBase).then(() => true).catch(() => false);
      const backupContents = backupExists ? await fs.readdir(backupBase) : [];
      assert.deepEqual(backupContents, [], 'dry run must not create a rollback artifact either');
    })
  ))
));

test('summarizeCycleResultForOutbox never claims "synced" for a conflict/unchanged/error result', async () => {
  for (const outcome of ['unchanged', 'conflict', 'error', 'no_source', 'intervention_required']) {
    const summary = summarizeCycleResultForOutbox({ runId: 'x', startedAt: 't', endedAt: 't', outcome, message: '' });
    assert.equal(summary.outcome, outcome);
    assert.notEqual(summary.outcome, 'synced');
  }
});
