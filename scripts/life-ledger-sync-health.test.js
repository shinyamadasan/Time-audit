import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeLifeLedgerHealth, worseClassification } from './life-ledger-sync-health.mjs';
import { runLifeLedgerSyncWorker, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME } from './life-ledger-sync-worker.mjs';
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

function focusEvent() {
  return {
    schemaVersion: 1, eventId: '10101010-1010-4010-8010-101010101010', sourceApp: 'chronasense',
    sourceEntityId: 'focus-entry-1', type: 'focus_session_completed',
    occurredAt: '2026-08-30T16:00:00.000Z', recordedAt: '2026-08-30T16:00:00.000Z', revisedAt: null,
    sourceTimezone: 'America/Phoenix',
    payload: { activity: 'Synthetic focus', startedAt: '2026-08-30T15:35:00.000Z', endedAt: '2026-08-30T16:00:00.000Z', durationMinutes: 25, additiveForTimeTotals: false, source: { focusEntryId: 'focus-entry-1' } },
    provenance: { source: 'chronasense', sourceRecordKind: 'chronasense.focus_outcome', adapterVersion: 'test-v1', observedAt: '2026-08-30T16:00:00.000Z', captureMethod: 'pomodoro', evidence: ['synthetic.focus:1'] },
    confidence: { score: 1, basis: 'source-recorded' }, revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null }
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

async function setupBasicFixture(cwd, { seedEvents = [], createOutboxDir = true } = {}) {
  const vault = path.join(cwd, 'vault');
  const outboxDir = path.join(cwd, 'outbox');
  const backupsRoot = path.join(cwd, 'backups');
  await seedOwnedVault(vault, seedEvents);
  if (createOutboxDir) await fs.mkdir(outboxDir, { recursive: true });
  const configPath = path.join(cwd, 'worker.config.json');
  await fs.writeFile(configPath, JSON.stringify({ outboxDir, vault, backupsRoot }), 'utf8');
  return { vault, outboxDir, backupsRoot, configPath };
}

test('worseClassification picks the more severe of two states', () => {
  assert.equal(worseClassification('HEALTHY', 'PENDING'), 'PENDING');
  assert.equal(worseClassification('BLOCKED', 'ACTION_REQUIRED'), 'ACTION_REQUIRED');
  assert.equal(worseClassification('UNAVAILABLE', 'HEALTHY'), 'UNAVAILABLE');
});

test('missing config is UNAVAILABLE, never HEALTHY', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const health = await computeLifeLedgerHealth({ configPath: path.join(cwd, 'nope.json') });
    assert.equal(health.classification, 'UNAVAILABLE');
  })
));

test('a freshly owned vault with no latch and nothing pending is HEALTHY', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const { configPath } = await setupBasicFixture(cwd);
    const health = await computeLifeLedgerHealth({ configPath });
    assert.equal(health.classification, 'HEALTHY');
    assert.equal(health.facts.ownership.owned, true);
    assert.equal(health.facts.latch.present, false);
  })
));

test('an intervention latch present is ACTION_REQUIRED, never HEALTHY', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const { configPath, backupsRoot } = await setupBasicFixture(cwd);
    await fs.mkdir(backupsRoot, { recursive: true });
    await fs.writeFile(
      path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME),
      JSON.stringify({ runId: 'r1', outcome: 'intervention_required' }),
      'utf8'
    );
    const health = await computeLifeLedgerHealth({ configPath });
    assert.equal(health.classification, 'ACTION_REQUIRED');
  })
));

test('a corrupt intervention latch is ACTION_REQUIRED and does not crash the health check', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const { configPath, backupsRoot } = await setupBasicFixture(cwd);
    await fs.mkdir(backupsRoot, { recursive: true });
    await fs.writeFile(path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME), '{not json', 'utf8');
    const health = await computeLifeLedgerHealth({ configPath });
    assert.equal(health.classification, 'ACTION_REQUIRED');
    assert.equal(health.facts.latch.corrupt, true);
  })
));

test('a vault that does not currently exist is UNAVAILABLE, never HEALTHY', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const configPath = path.join(cwd, 'worker.config.json');
    await fs.writeFile(configPath, JSON.stringify({
      outboxDir: path.join(cwd, 'outbox'),
      vault: path.join(cwd, 'vault-does-not-exist'),
      backupsRoot: path.join(cwd, 'backups')
    }), 'utf8');
    const health = await computeLifeLedgerHealth({ configPath });
    assert.equal(health.classification, 'UNAVAILABLE');
    assert.equal(health.facts.ownership.known, false);
  })
));

test('a vault with no managed root yet (first run) is ACTION_REQUIRED, never HEALTHY', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const vault = path.join(cwd, 'vault');
    await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
    const configPath = path.join(cwd, 'worker.config.json');
    await fs.writeFile(configPath, JSON.stringify({ outboxDir: path.join(cwd, 'outbox'), vault, backupsRoot: path.join(cwd, 'backups') }), 'utf8');
    const health = await computeLifeLedgerHealth({ configPath });
    assert.equal(health.classification, 'ACTION_REQUIRED');
  })
));

test('an outbox directory that does not exist yet is PENDING, not HEALTHY and not an error', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const { configPath } = await setupBasicFixture(cwd, { createOutboxDir: false });
    const health = await computeLifeLedgerHealth({ configPath });
    assert.equal(health.classification, 'PENDING');
    assert.equal(health.facts.outbox.dirExists, false);
  })
));

test('pruning-due is surfaced as PENDING via the real retention module, not duplicated logic', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const { configPath, backupsRoot } = await setupBasicFixture(cwd); // outbox present so that fact alone stays HEALTHY
    await fs.mkdir(path.join(backupsRoot, 'runs'), { recursive: true });
    const past = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    // The retention module's default min-keep floor (20) always protects the most recent 20
    // entries regardless of age, by design (see life-ledger-sync-retention.mjs) — so proving
    // "pruning due" through the real module (not a stub) requires more than 20 old entries here.
    for (let i = 0; i < 25; i++) {
      const oldRun = path.join(backupsRoot, 'runs', `ancient-${i}.json`);
      await fs.writeFile(oldRun, '{}', 'utf8');
      await fs.utimes(oldRun, past, past);
    }
    const health = await computeLifeLedgerHealth({ configPath });
    assert.equal(health.classification, 'PENDING');
    assert.equal(health.facts.retentionDue, true);
  })
));

test('a real end-to-end synced cycle produces HEALTHY with correct outbox/status facts', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const vault = path.join(cwd, 'vault');
    const outboxDir = path.join(cwd, 'outbox');
    const backupsRoot = path.join(cwd, 'backups');
    await seedOwnedVault(vault, []);
    await fs.mkdir(outboxDir, { recursive: true });
    const json = serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([focusEvent()]));
    await fs.writeFile(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME), json, 'utf8');
    const configPath = path.join(cwd, 'worker.config.json');
    await fs.writeFile(configPath, JSON.stringify({ outboxDir, vault, backupsRoot }), 'utf8');
    const outcome = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
    assert.equal(outcome.result.outcome, 'synced');

    const health = await computeLifeLedgerHealth({ configPath });
    assert.equal(health.classification, 'HEALTHY');
    assert.equal(health.facts.outbox.snapshotPresent, true);
    assert.equal(health.facts.outbox.statusPresent, true);
    assert.equal(health.facts.outbox.status.outcome, 'synced');
    assert.ok(health.facts.evidence.latestRunAt);
    assert.ok(health.facts.evidence.latestReceiptAt);
    assert.ok(health.facts.footprint.fileCount > 0);
    // Review Finding 4 — matching hashes contribute HEALTHY when everything else is fine too.
    assert.equal(health.facts.outboxProcessed.matches, true);
    assert.equal(health.facts.outboxProcessed.currentSha256, health.facts.outboxProcessed.processedSha256);
  })
));

// Review Finding 4 (Phase 11 fix pass) — the current outbox SHA and the worker's last PROCESSED
// outbox SHA were both already computed but never compared.
test('a newer outbox snapshot than the worker has processed is PENDING, never HEALTHY', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const vault = path.join(cwd, 'vault');
    const outboxDir = path.join(cwd, 'outbox');
    const backupsRoot = path.join(cwd, 'backups');
    await seedOwnedVault(vault, []);
    await fs.mkdir(outboxDir, { recursive: true });
    const json1 = serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([focusEvent()]));
    await fs.writeFile(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME), json1, 'utf8');
    const configPath = path.join(cwd, 'worker.config.json');
    await fs.writeFile(configPath, JSON.stringify({ outboxDir, vault, backupsRoot }), 'utf8');
    const first = await runLifeLedgerSyncWorker(['--apply', '--config', configPath]);
    assert.equal(first.result.outcome, 'synced');

    // The browser mirrors a NEW event — the scheduler has not processed it yet (no further
    // worker invocation happens here, simulating "the next cycle just hasn't fired yet").
    const day2 = {
      ...focusEvent(),
      eventId: '20202020-2020-4020-8020-202020202020', sourceEntityId: 'focus-entry-2',
      occurredAt: '2026-08-31T16:00:00.000Z', recordedAt: '2026-08-31T16:00:00.000Z',
      payload: { ...focusEvent().payload, startedAt: '2026-08-31T15:35:00.000Z', endedAt: '2026-08-31T16:00:00.000Z', source: { focusEntryId: 'focus-entry-2' } },
      provenance: { ...focusEvent().provenance, evidence: ['synthetic.focus:2'] }
    };
    const json2 = serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([focusEvent(), day2]));
    await fs.writeFile(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME), json2, 'utf8');

    const health = await computeLifeLedgerHealth({ configPath });
    assert.equal(health.classification, 'PENDING');
    assert.equal(health.facts.outboxProcessed.matches, false);
    assert.notEqual(health.facts.outboxProcessed.currentSha256, health.facts.outboxProcessed.processedSha256);
  })
));

test('a malformed backupsRoot/status.json makes worker status UNKNOWN — UNAVAILABLE, never HEALTHY', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const { configPath, backupsRoot, outboxDir } = await setupBasicFixture(cwd);
    await fs.mkdir(outboxDir, { recursive: true });
    await fs.writeFile(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME), serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([focusEvent()])), 'utf8');
    await fs.mkdir(backupsRoot, { recursive: true });
    await fs.writeFile(path.join(backupsRoot, 'status.json'), '{ not valid json !!', 'utf8');
    const health = await computeLifeLedgerHealth({ configPath });
    assert.equal(health.classification, 'UNAVAILABLE');
  })
));

test('an outbox snapshot with no worker status yet at all is PENDING (waiting for first sync), not HEALTHY', async () => (
  withTempDir('chronasense-p11-health-', async cwd => {
    const { configPath, outboxDir } = await setupBasicFixture(cwd);
    await fs.mkdir(outboxDir, { recursive: true });
    await fs.writeFile(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME), serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([focusEvent()])), 'utf8');
    // No backupsRoot/status.json has ever been written — the worker has never run yet.
    const health = await computeLifeLedgerHealth({ configPath });
    assert.equal(health.classification, 'PENDING');
  })
));
