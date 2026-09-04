import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createObsidianSyncTarget, planObsidianSync } from '../obsidian-life-ledger-sync.js';
import { LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME, LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME } from './life-ledger-sync-worker.mjs';
import { planLifeLedgerRetention, computeLifeLedgerBackupsFootprint } from './life-ledger-sync-retention.mjs';

// Phase 11 — REQUIRED OUTCOME 5: one low-friction, read-only health command. This module gathers
// every fact this repo (Node side) can see without the Windows Task Scheduler — config validity,
// outbox state, the worker's own last-run status, the intervention latch, current managed vault
// ownership (read-only — the same inspection the worker already does every cycle, never a write),
// backup-root storage footprint, and whether pruning is due — and reduces them to one of five
// classifications: HEALTHY, PENDING, BLOCKED, ACTION_REQUIRED, UNAVAILABLE.
//
// setup-life-ledger-sync-scheduler.ps1 -Action Health adds the one fact only PowerShell can see
// (the registered Scheduled Task's own state/LastTaskResult/next run) and merges it with this
// module's classification by taking whichever is worse — see SEVERITY_ORDER below.

export const HEALTH_CLASSIFICATIONS = Object.freeze(['HEALTHY', 'PENDING', 'BLOCKED', 'ACTION_REQUIRED', 'UNAVAILABLE']);
export const SEVERITY_ORDER = Object.freeze({ HEALTHY: 0, PENDING: 1, BLOCKED: 2, ACTION_REQUIRED: 3, UNAVAILABLE: 4 });

export function worseClassification(a, b) {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function readJsonBestEffort(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    try {
      return { present: true, parsed: JSON.parse(text), raw: text };
    } catch {
      return { present: true, parsed: null, raw: text };
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return { present: false, parsed: null, raw: null };
    return { present: true, parsed: null, raw: null, error: err.message };
  }
}

async function loadConfig(configPath) {
  const result = await readJsonBestEffort(configPath);
  if (!result.present) return { ok: false, reason: 'config_missing', configPath };
  if (result.parsed === null) return { ok: false, reason: 'config_unparseable', configPath };
  const cfg = result.parsed;
  const missing = ['outboxDir', 'vault', 'backupsRoot'].filter(key => !cfg[key]);
  if (missing.length) return { ok: false, reason: 'config_incomplete', missing, configPath };
  return {
    ok: true, configPath,
    outboxDir: path.resolve(cfg.outboxDir),
    vault: path.resolve(cfg.vault),
    expectedVault: path.resolve(cfg.expectedVault || cfg.vault),
    backupsRoot: path.resolve(cfg.backupsRoot)
  };
}

async function inspectOutbox(outboxDir) {
  const snapshot = await readJsonBestEffort(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME));
  const status = await readJsonBestEffort(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME));
  let dirExists = true;
  try {
    await fs.access(outboxDir);
  } catch {
    dirExists = false;
  }
  return {
    dirExists,
    snapshotPresent: snapshot.present,
    snapshotSha256: snapshot.raw ? sha256(snapshot.raw) : null,
    statusPresent: status.present,
    status: status.parsed
  };
}

async function inspectWorkerStatus(backupsRoot) {
  const statusPath = path.join(backupsRoot, 'status.json');
  const status = await readJsonBestEffort(statusPath);
  return { present: status.present, parsed: status.parsed };
}

async function inspectLatch(backupsRoot) {
  const latch = await readJsonBestEffort(path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME));
  if (!latch.present) return { present: false };
  if (latch.parsed === null) return { present: true, corrupt: true };
  return { present: true, corrupt: false, runId: latch.parsed.runId, outcome: latch.parsed.outcome, createdAt: latch.parsed.createdAt };
}

async function inspectVaultOwnership(vault, expectedVault) {
  try {
    const target = createObsidianSyncTarget({ vaultPath: vault, mode: 'production', allowApply: false });
    const plan = await planObsidianSync(target, [], { expectedCanonicalVaultPath: expectedVault });
    if (plan.blockState === 'identity') {
      // "vault_missing" specifically means the vault path can't currently be reached at all —
      // e.g. OneDrive hasn't finished mounting/syncing yet (see REQUIRED OUTCOME 7). That is a
      // transient-unknown, not a proven-broken ownership state, so it is NOT the same severity as
      // a tampered sentinel/manifest — it is reported as "unknown" (known: false), same as any
      // other unreachable-vault condition.
      if (plan.blockReason === 'vault_missing') return { known: false, owned: false, blocked: false, error: 'vault_missing' };
      return { known: true, owned: false, blocked: true, reason: plan.blockReason, stage: 'identity' };
    }
    if (plan.isFirstRun) return { known: true, owned: false, blocked: false, reason: 'managed_root_absent', stage: 'ownership' };
    if (plan.blockState === 'unmanaged_conflict' || plan.blockState === 'invalid_sentinel') {
      return { known: true, owned: false, blocked: true, reason: plan.blockReason, stage: 'ownership' };
    }
    return { known: true, owned: true, blocked: plan.blocked === true, reason: plan.blocked ? (plan.blockReason || 'file_conflicts') : null, stage: plan.blocked ? 'plan' : null };
  } catch (err) {
    return { known: false, owned: false, blocked: false, error: err.message };
  }
}

async function inspectLatestEvidence(backupsRoot) {
  async function newestMtime(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    let newest = null;
    for (const entry of entries) {
      const stats = await fs.lstat(path.join(dir, entry.name)).catch(() => null);
      if (!stats) continue;
      if (!newest || stats.mtimeMs > newest) newest = stats.mtimeMs;
    }
    return newest;
  }
  const latestRunMtime = await newestMtime(path.join(backupsRoot, 'runs'));
  const latestReceiptMtime = await newestMtime(path.join(backupsRoot, 'receipts'));
  return {
    latestRunAt: latestRunMtime ? new Date(latestRunMtime).toISOString() : null,
    latestReceiptAt: latestReceiptMtime ? new Date(latestReceiptMtime).toISOString() : null
  };
}

/**
 * Gather every Node-visible health fact and classify. Read-only — never writes, never prunes,
 * never touches the vault beyond the same read-only ownership inspection the worker already
 * performs on every cycle.
 */
export async function computeLifeLedgerHealth({ configPath, cwd = process.cwd() } = {}) {
  const resolvedConfigPath = path.resolve(configPath || path.join(cwd, 'scripts', 'life-ledger-sync-worker.config.json'));
  const config = await loadConfig(resolvedConfigPath);
  if (!config.ok) {
    return { classification: 'UNAVAILABLE', reasons: [config.reason], facts: { config } };
  }

  const [outbox, workerStatus, latch, ownership, evidence, footprint, retentionPlan] = await Promise.all([
    inspectOutbox(config.outboxDir),
    inspectWorkerStatus(config.backupsRoot),
    inspectLatch(config.backupsRoot),
    inspectVaultOwnership(config.vault, config.expectedVault),
    inspectLatestEvidence(config.backupsRoot),
    computeLifeLedgerBackupsFootprint(config.backupsRoot),
    planLifeLedgerRetention(config.backupsRoot).catch(err => ({ error: err.message }))
  ]);

  const reasons = [];
  let classification = 'HEALTHY';

  if (!ownership.known) {
    classification = worseClassification(classification, 'UNAVAILABLE');
    reasons.push(`vault ownership could not be determined: ${ownership.error}`);
  } else if (latch.present) {
    classification = worseClassification(classification, 'ACTION_REQUIRED');
    reasons.push(latch.corrupt ? 'a corrupt intervention latch is present — run ClearIntervention after review' : `an intervention latch is present (run ${latch.runId}, ${latch.outcome}) — run ClearIntervention after resolving the cause`);
  } else if (!ownership.owned || ownership.blocked) {
    classification = worseClassification(classification, ownership.stage === 'ownership' || ownership.stage === 'identity' ? 'ACTION_REQUIRED' : 'BLOCKED');
    reasons.push(`vault is not currently in a clean owned/unblocked state: ${ownership.reason}`);
  }

  if (!outbox.dirExists) {
    classification = worseClassification(classification, 'PENDING');
    reasons.push('outbox directory does not exist yet — background sync may not be enabled in the browser');
  }

  if (!retentionPlan.error && retentionPlan.summary?.pruningDue) {
    classification = worseClassification(classification, 'PENDING');
    reasons.push('local run-log/receipt/lock-tombstone pruning is due — see life-ledger-sync-retention.mjs');
  }

  if (reasons.length === 0) reasons.push('no issues detected');

  return {
    classification,
    reasons,
    facts: { config, outbox, workerStatus, latch, ownership, evidence, footprint, retentionDue: retentionPlan.summary?.pruningDue ?? null }
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage:',
    '  node scripts/life-ledger-sync-health.mjs [--config <path>] [--json]',
    '',
    'Read-only health summary for the Life Ledger background sync worker. Never writes, never',
    'prunes, never touches the vault beyond the same read-only ownership check the worker already',
    'performs each cycle.'
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  if (args.includes('--help') || args.includes('-h')) { console.log(usage()); return; }

  const health = await computeLifeLedgerHealth({ configPath });
  if (json) {
    console.log(JSON.stringify(health, null, 2));
  } else {
    console.log(`Classification: ${health.classification}`);
    for (const reason of health.reasons) console.log(`  - ${reason}`);
  }
  if (health.classification === 'UNAVAILABLE' || health.classification === 'ACTION_REQUIRED') process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
