import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runLifeLedgerSyncWorker,
  LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME,
  LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME
} from './life-ledger-sync-worker.mjs';
import { createObsidianSyncTarget, planObsidianSync, applyObsidianSync } from '../obsidian-life-ledger-sync.js';
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

test('an old lock (past the staleness ceiling) is broken even if the PID happens to be reused', async () => (
  withTempDir('chronasense-p10-worker-', async cwd => (
    withTempDir('chronasense-p10-outbox-', async outboxDir => (
      withTempDir('chronasense-p10-vault-', async vault => (
        withTempDir('chronasense-p10-backups-', async backupsRoot => {
          await fs.mkdir(backupsRoot, { recursive: true });
          const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
          await fs.writeFile(
            path.join(backupsRoot, 'life-ledger-sync-worker.lock'),
            JSON.stringify({ pid: process.pid, startedAt: old, hostname: 'test' }),
            'utf8'
          );
          const outcome = await runLifeLedgerSyncWorker(
            ['--outbox-dir', outboxDir, '--vault', vault, '--backups-root', backupsRoot],
            { cwd }
          );
          assert.equal(outcome.skipped, false);
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
