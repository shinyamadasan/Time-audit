import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runLifeLedgerSyncWorker,
  LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME
} from './life-ledger-sync-worker.mjs';
import { planLifeLedgerRetention, applyLifeLedgerRetentionPlan } from './life-ledger-sync-retention.mjs';
import { createObsidianSyncTarget, planObsidianSync, applyObsidianSync } from '../obsidian-life-ledger-sync.js';
import { serializeLifeLedgerSnapshot, createLifeLedgerSnapshotFromEvents } from '../life-ledger-transport.js';

// Phase 11 — REQUIRED OUTCOME 6: long-run / chaos testing. These tests run the REAL worker
// (real fs, disposable temp vault/outbox/backupsRoot — never production) through many cycles and
// several fault scenarios, proving the invariants the North Star cares about: no duplicate
// events, no human overwrite, no blind dangerous retry, bounded local artifact growth, no
// deletion outside allowed roots, idempotent steady state.
//
// Coverage note: several scenarios from the Phase 11 chaos checklist are already exercised more
// directly elsewhere and are NOT duplicated here — partial-apply -> intervention latch and
// repeated latched scheduled runs (life-ledger-sync-worker.test.js, tests A/B/C/D), stale lock
// recovery and two-contender lock races (life-ledger-sync-worker.test.js), corrupt/malformed
// intervention latches (life-ledger-sync-intervention-latch-recovery.test.js), stale lock
// tombstone pruning and latch-protected-receipt-survives-pruning (life-ledger-sync-retention.test.js),
// and hard-kill-style orphaned .tmp artifacts (life-ledger-sync-tmp-cleanup.test.js). Precondition
// races (a file changing between plan and apply) are covered upstream in
// obsidian-life-ledger-sync.test.js's precondition_changed suite and are not re-derived at the
// worker level here.

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function focusEventForDay(day, index) {
  const id = `${index}`.padStart(8, '0');
  return {
    schemaVersion: 1,
    eventId: `${id}-0000-4000-8000-${id}0000`,
    sourceApp: 'chronasense',
    sourceEntityId: `focus-entry-${index}`,
    type: 'focus_session_completed',
    occurredAt: `${day}T16:00:00.000Z`,
    recordedAt: `${day}T16:00:00.000Z`,
    revisedAt: null,
    sourceTimezone: 'America/Phoenix',
    payload: {
      activity: `Synthetic focus ${index}`, startedAt: `${day}T15:35:00.000Z`, endedAt: `${day}T16:00:00.000Z`,
      durationMinutes: 25, additiveForTimeTotals: false, source: { focusEntryId: `focus-entry-${index}` }
    },
    provenance: {
      source: 'chronasense', sourceRecordKind: 'chronasense.focus_outcome', adapterVersion: 'test-v1',
      observedAt: `${day}T16:00:00.000Z`, captureMethod: 'pomodoro', evidence: [`synthetic.focus:${index}`]
    },
    confidence: { score: 1, basis: 'source-recorded' },
    revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null }
  };
}

async function seedOwnedVault(vault) {
  await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
  const target = createObsidianSyncTarget({ vaultPath: vault, mode: 'test', allowApply: true });
  const plan = await planObsidianSync(target, []);
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

async function setupFixture(cwd) {
  const vault = path.join(cwd, 'vault');
  const outboxDir = path.join(cwd, 'outbox');
  const backupsRoot = path.join(cwd, 'backups');
  await seedOwnedVault(vault);
  const configPath = path.join(cwd, 'worker.config.json');
  await fs.writeFile(configPath, JSON.stringify({ outboxDir, vault, backupsRoot }), 'utf8');
  return { vault, outboxDir, backupsRoot, configPath };
}

async function countEntries(dir) {
  try {
    return (await fs.readdir(dir)).length;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

test('A: many consecutive unchanged cycles stay idempotent — one receipt, bounded run-log growth', async () => (
  withTempDir('chronasense-p11-chaos-', async cwd => {
    const { outboxDir, backupsRoot, configPath } = await setupFixture(cwd);
    await writeOutbox(outboxDir, [focusEventForDay('2026-08-30', 1)]);

    const first = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
    assert.equal(first.result.outcome, 'synced');

    for (let i = 0; i < 30; i++) {
      const outcome = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
      assert.equal(outcome.result.outcome, 'unchanged', `cycle ${i} should be a steady-state no-op`);
    }

    assert.equal(await countEntries(path.join(backupsRoot, 'runs')), 31, 'one run log per cycle — growth is linear and bounded, not unbounded per-file duplication');
    assert.equal(await countEntries(path.join(backupsRoot, 'receipts')), 1, 'only the one cycle that actually wrote anything gets a rollback receipt');
  })
));

test('B: many days of incremental new events over many cycles — no duplicate events, no human overwrite of prior days', async () => (
  withTempDir('chronasense-p11-chaos-', async cwd => {
    const { vault, outboxDir, configPath } = await setupFixture(cwd);
    const DAYS = 12;
    const events = [];
    const writtenDailyPaths = [];
    for (let d = 1; d <= DAYS; d++) {
      const day = `2026-08-${String(d).padStart(2, '0')}`;
      events.push(focusEventForDay(day, d));
      await writeOutbox(outboxDir, events); // the browser always writes the FULL current snapshot
      const outcome = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
      assert.ok(['synced', 'unchanged'].includes(outcome.result.outcome), `day ${day}: ${JSON.stringify(outcome.result)}`);
      writtenDailyPaths.push(path.join(vault, 'Life Ledger', 'Daily', `${day}.md`));
    }
    for (const dailyPath of writtenDailyPaths) {
      const content = await fs.readFile(dailyPath, 'utf8');
      assert.equal((content.match(/life-ledger:event:/g) || []).length, 1, `${dailyPath} must have exactly one event, never a duplicate`);
    }
    // A final unrelated cycle with the exact same full snapshot must be a clean no-op — no
    // rewritten content, no new duplicate entries anywhere.
    const finalCheck = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
    assert.equal(finalCheck.result.outcome, 'unchanged');
  })
));

test('D: each cycle is a fresh worker invocation — no lock leaks and no shared state carries between "restarts"', async () => (
  withTempDir('chronasense-p11-chaos-', async cwd => {
    const { outboxDir, backupsRoot, configPath } = await setupFixture(cwd);
    for (let i = 0; i < 10; i++) {
      await writeOutbox(outboxDir, [focusEventForDay('2026-08-30', 1), focusEventForDay('2026-08-31', 2 + i)]);
      const outcome = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
      assert.notEqual(outcome.skipped, true, `cycle ${i} should never see a leftover lock from the "previous process"`);
      // The lock is fully released at the end of every invocation — simulating a full process
      // restart between cycles is simply calling the worker again, which is exactly what real
      // Task Scheduler invocations do (each is its own node.exe process).
      await assert.rejects(fs.access(path.join(backupsRoot, 'life-ledger-sync-worker.lock')), /ENOENT/);
    }
  })
));

test('E: the browser can replace the outbox snapshot between every cycle; the worker always reflects the latest bytes', async () => (
  withTempDir('chronasense-p11-chaos-', async cwd => {
    const { outboxDir, configPath } = await setupFixture(cwd);
    let lastSha = null;
    for (let i = 1; i <= 5; i++) {
      const json = await writeOutbox(outboxDir, [focusEventForDay('2026-08-30', 1), focusEventForDay(`2026-09-0${i}`, 10 + i)]);
      const outcome = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
      assert.notEqual(outcome.result.outboxSha256, lastSha, 'each replaced snapshot must be recognized as distinct from the last');
      lastSha = outcome.result.outboxSha256;
      const status = JSON.parse(await fs.readFile(path.join(outboxDir, 'chronasense-life-ledger-outbox-v1.status.json'), 'utf8'));
      assert.equal(status.outboxSha256, outcome.result.outboxSha256);
    }
  })
));

test('F: true concurrent contention — exactly one of two simultaneous invocations performs the cycle', async () => (
  withTempDir('chronasense-p11-chaos-', async cwd => {
    const { outboxDir, configPath } = await setupFixture(cwd);
    await writeOutbox(outboxDir, [focusEventForDay('2026-08-30', 1)]);
    const [a, b] = await Promise.all([
      runLifeLedgerSyncWorker(['--apply', '--config', configPath]),
      runLifeLedgerSyncWorker(['--apply', '--config', configPath])
    ]);
    const skippedCount = [a, b].filter(o => o.skipped === true).length;
    const ranCount = [a, b].filter(o => o.skipped === false).length;
    assert.equal(skippedCount, 1, 'exactly one contender must back off as already_running');
    assert.equal(ranCount, 1, 'exactly one contender must actually run the cycle');
  })
));

test('H: the outbox becoming transiently unavailable fails closed, then recovers cleanly once it returns', async () => (
  withTempDir('chronasense-p11-chaos-', async cwd => {
    const { outboxDir, vault, configPath } = await setupFixture(cwd);
    await writeOutbox(outboxDir, [focusEventForDay('2026-08-30', 1)]);
    const before = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
    assert.equal(before.result.outcome, 'synced');

    // Simulate the outbox folder becoming unavailable (e.g. a OneDrive-adjacent local folder
    // temporarily missing) — the worker must not crash and must not touch the vault.
    await fs.rm(outboxDir, { recursive: true, force: true });
    const during = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
    assert.equal(during.result.outcome, 'no_source');
    const dailyContent = await fs.readFile(path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md'), 'utf8');
    assert.ok(dailyContent.includes('life-ledger:event:'), 'prior synced content must be completely untouched while the source is unavailable');

    // Recovery: once the outbox reappears, normal operation resumes with no special handling.
    await writeOutbox(outboxDir, [focusEventForDay('2026-08-30', 1)]);
    const after = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
    assert.equal(after.result.outcome, 'unchanged');
  })
));

test('I: the vault becoming transiently unavailable fails closed with a reported error, then recovers cleanly once it returns', async () => (
  withTempDir('chronasense-p11-chaos-', async cwd => {
    const { vault, outboxDir, configPath } = await setupFixture(cwd);
    await writeOutbox(outboxDir, [focusEventForDay('2026-08-30', 1)]);
    const before = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
    assert.equal(before.result.outcome, 'synced');

    const movedAside = `${vault}-temporarily-moved`;
    await fs.rename(vault, movedAside);
    const during = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
    assert.equal(during.result.outcome, 'error');
    assert.equal(during.result.reason, 'vault_missing');
    assert.ok(await fs.access(path.join(movedAside, 'Life Ledger', 'Daily', '2026-08-30.md')).then(() => true, () => false), 'the moved-aside vault content is completely untouched');

    await fs.rename(movedAside, vault);
    const after = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
    assert.equal(after.result.outcome, 'unchanged');
  })
));

test('J: a rollback-preparation failure fails closed before any vault write, creates no latch, and a later real cycle recovers', async () => (
  withTempDir('chronasense-p11-chaos-', async cwd => {
    const { vault, outboxDir, backupsRoot, configPath } = await setupFixture(cwd);
    await writeOutbox(outboxDir, [focusEventForDay('2026-08-30', 1)]);

    const realFs = fs;
    const failingFs = {
      mkdir: async (target, opts) => {
        if (String(target).includes(path.join('backups', 'receipts'))) {
          throw Object.assign(new Error('simulated disk failure preparing rollback artifact'), { code: 'EIO' });
        }
        return realFs.mkdir(target, opts);
      },
      readFile: (...a) => realFs.readFile(...a),
      writeFile: (...a) => realFs.writeFile(...a),
      rename: (...a) => realFs.rename(...a),
      unlink: (...a) => realFs.unlink(...a),
      readdir: (...a) => realFs.readdir(...a),
      lstat: (...a) => realFs.lstat(...a),
      realpath: (...a) => realFs.realpath(...a)
    };

    const outcome = await runLifeLedgerSyncWorker(['--apply', '--config', configPath], { fs: failingFs });
    assert.equal(outcome.result.outcome, 'error');
    assert.equal(outcome.result.category, 'before_write');

    const dailyExists = await fs.access(path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md')).then(() => true, () => false);
    assert.equal(dailyExists, false, 'zero managed writes must have happened before the failure');
    await assert.rejects(fs.access(path.join(backupsRoot, 'intervention-required.json')), /ENOENT/, 'an infrastructure error before any write must never latch — only intervention_required does');

    const recovered = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
    assert.equal(recovered.result.outcome, 'synced', 'once the transient failure is gone, the very next real cycle must succeed with no special recovery step');
  })
));

test('M: end-to-end — many real cycles, a real latch, and retention pruning never touches the latch-protected receipt', async () => (
  withTempDir('chronasense-p11-chaos-', async cwd => {
    const { outboxDir, backupsRoot, configPath } = await setupFixture(cwd);

    // 15 real cycles, one new day each — real run logs and real receipts accumulate.
    for (let d = 1; d <= 15; d++) {
      const day = `2026-07-${String(d).padStart(2, '0')}`;
      await writeOutbox(outboxDir, [focusEventForDay(day, d)]);
      const outcome = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
      assert.equal(outcome.result.outcome, 'synced');
    }

    // Force a genuine intervention latch via a partial-apply failure on the 16th event.
    let tmpWriteCount = 0;
    const realFs = fs;
    const breaksOnSecondTmpWrite = {
      mkdir: (...a) => realFs.mkdir(...a),
      readFile: (...a) => realFs.readFile(...a),
      writeFile: async (p, content, enc) => {
        if (String(p).endsWith('.tmp')) {
          tmpWriteCount++;
          if (tmpWriteCount === 2) throw Object.assign(new Error('simulated disk failure mid-apply'), { code: 'EIO' });
        }
        return realFs.writeFile(p, content, enc);
      },
      rename: (...a) => realFs.rename(...a),
      unlink: (...a) => realFs.unlink(...a),
      readdir: (...a) => realFs.readdir(...a),
      lstat: (...a) => realFs.lstat(...a),
      realpath: (...a) => realFs.realpath(...a)
    };
    await writeOutbox(outboxDir, [focusEventForDay('2026-07-01', 1), focusEventForDay('2026-07-16', 16)]);
    const latched = await runLifeLedgerSyncWorker(['--apply', '--config', configPath], { fs: breaksOnSecondTmpWrite });
    assert.equal(latched.result.outcome, 'intervention_required');
    const latchPath = path.join(backupsRoot, 'intervention-required.json');
    const latch = JSON.parse(await fs.readFile(latchPath, 'utf8'));
    assert.ok(latch.receiptPath, 'the latch must reference the receipt that needs to survive pruning');

    // Age every run log and every receipt dir well past the default retention window, so a naive
    // policy would prune everything — including the one the active latch depends on.
    const past = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    for (const name of await fs.readdir(path.join(backupsRoot, 'runs'))) {
      await fs.utimes(path.join(backupsRoot, 'runs', name), past, past);
    }
    for (const name of await fs.readdir(path.join(backupsRoot, 'receipts'))) {
      await fs.utimes(path.join(backupsRoot, 'receipts', name), past, past);
    }

    const plan = await planLifeLedgerRetention(backupsRoot, { retentionDays: 30, minKeep: 1 });
    const latchedReceiptDirName = path.basename(path.dirname(path.resolve(latch.receiptPath)));
    const latchedReceiptEntry = plan.receipts.find(e => e.name === latchedReceiptDirName);
    assert.equal(latchedReceiptEntry.decision, 'keep');
    assert.equal(latchedReceiptEntry.why, 'active_latch_evidence');

    await applyLifeLedgerRetentionPlan(plan);
    assert.ok(await fs.access(latch.receiptPath).then(() => true, () => false), 'the receipt an active intervention latch depends on must survive pruning');
    // Some now-unreferenced old receipts should actually have been pruned (proves this wasn't a
    // no-op policy — pruning genuinely bounds growth, it just never touches protected evidence).
    assert.ok(plan.summary.receiptsToDelete > 0);
  })
));

test('N: a malformed/corrupt run log file does not crash retention planning and is treated like any other file by age', async () => (
  withTempDir('chronasense-p11-chaos-', async cwd => {
    const backupsRoot = path.join(cwd, 'backups');
    await fs.mkdir(path.join(backupsRoot, 'runs'), { recursive: true });
    const corruptRun = path.join(backupsRoot, 'runs', 'corrupt-run.json');
    await fs.writeFile(corruptRun, '{ this is not valid json !!', 'utf8');
    const past = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await fs.utimes(corruptRun, past, past);
    // A second, recent run log so the min-keep-floor-of-1 safety net (which always protects the
    // single newest entry, see life-ledger-sync-retention.test.js) doesn't itself keep the
    // corrupt one — retention never parses run log JSON at all (only lstat for mtime), so a
    // corrupt file is ranked and pruned purely by age like any other.
    await fs.writeFile(path.join(backupsRoot, 'runs', 'recent-run.json'), '{"outcome":"unchanged"}', 'utf8');
    const plan = await planLifeLedgerRetention(backupsRoot, { retentionDays: 30, minKeep: 1 });
    const corruptEntry = plan.runs.find(e => e.name === 'corrupt-run.json');
    assert.equal(corruptEntry.decision, 'delete');
    const applied = await applyLifeLedgerRetentionPlan(plan);
    assert.equal(applied.errors.length, 0);
    assert.ok(!(await fs.access(corruptRun).then(() => true, () => false)));
  })
));
