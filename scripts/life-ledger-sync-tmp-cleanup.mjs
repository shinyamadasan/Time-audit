import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathEqualsOrContains } from '../obsidian-life-ledger-writer.js';
import {
  LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME,
  LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME,
  isBackupsRootLockLive
} from './life-ledger-sync-worker.mjs';

// Phase 11 — REQUIRED OUTCOME 4: safe cleanup of orphaned `.tmp` atomic-write artifacts left
// behind by a hard-kill between a temp-file write and its rename into place.
//
// This is intentionally narrow. The worker (life-ledger-sync-worker.mjs) only ever creates
// exactly two `.tmp` files, both with fixed, fully-known names, both written and renamed within
// a single synchronous async step:
//   - <backupsRoot>/intervention-required.json.tmp
//   - <outboxDir>/chronasense-life-ledger-outbox-v1.status.json.tmp
//
// A per-vault-content-file `.tmp` (written by obsidian-life-ledger-writer.js during apply, inside
// the managed `Life Ledger/` subtree) is deliberately OUT OF SCOPE here: cleaning that up would
// mean reaching into the vault itself, which Phase 11 automation must never touch, and would
// require touching the already-reviewed Phase 9 write path to distinguish an orphan from a
// currently-in-progress write. That is accepted debt (see CHANGELOG / final report), not silently
// dropped.
//
// Safety gate for the two known names above: a leftover `.tmp` with one of these exact names is
// deleted only if BOTH (a) no worker lock is currently live in backupsRoot (reusing the worker's
// own liveness judgment — a live lock is the only way either tmp file could still be actively
// written) AND (b) its mtime is older than a conservative age threshold. Either condition alone
// already rules out "an active worker might still need this"; requiring both is belt-and-suspenders.

export const STALE_TMP_DEFAULT_AGE_MINUTES = 10;

export class LifeLedgerTmpCleanupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LifeLedgerTmpCleanupError';
    this.code = code;
  }
}

async function realPathOrResolved(target) {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function evaluateCandidate(root, filePath, { lockLive, ageMinutes }) {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { path: filePath, present: false };
    throw err;
  }
  if (!stats.isFile()) {
    return { path: filePath, present: true, decision: 'skip', why: 'not_a_plain_file' };
  }
  const containerRealRoot = await realPathOrResolved(root);
  const real = await realPathOrResolved(filePath);
  if (!pathEqualsOrContains(containerRealRoot, real)) {
    return { path: filePath, present: true, decision: 'skip', why: 'escapes_configured_root' };
  }
  const ageMs = Date.now() - stats.mtimeMs;
  if (lockLive) {
    return { path: filePath, present: true, decision: 'keep', why: 'worker_lock_currently_live' };
  }
  if (ageMs < ageMinutes * 60 * 1000) {
    return { path: filePath, present: true, decision: 'keep', why: 'too_recent_to_assume_orphaned' };
  }
  return { path: filePath, present: true, decision: 'delete', why: 'orphaned_tmp_past_age_threshold' };
}

/**
 * Preview (never deletes) which of the two known worker `.tmp` artifacts are safe to remove.
 *
 * @param {object} options
 * @param {string} options.backupsRoot
 * @param {string} [options.outboxDir] - optional; the outbox status `.tmp` check is skipped if omitted
 * @param {number} [options.ageMinutes]
 */
export async function planStaleTmpCleanup({ backupsRoot, outboxDir, ageMinutes = STALE_TMP_DEFAULT_AGE_MINUTES } = {}) {
  if (!backupsRoot) throw new LifeLedgerTmpCleanupError('invalid_option', 'backupsRoot is required');
  const resolvedBackupsRoot = path.resolve(backupsRoot);
  const lockLive = await isBackupsRootLockLive(resolvedBackupsRoot);

  const candidates = [];
  const latchTmp = path.join(resolvedBackupsRoot, `${LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME}.tmp`);
  candidates.push({ kind: 'intervention_latch_tmp', ...await evaluateCandidate(resolvedBackupsRoot, latchTmp, { lockLive, ageMinutes }) });

  if (outboxDir) {
    const resolvedOutboxDir = path.resolve(outboxDir);
    const statusTmp = path.join(resolvedOutboxDir, `${LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME}.tmp`);
    candidates.push({ kind: 'outbox_status_tmp', ...await evaluateCandidate(resolvedOutboxDir, statusTmp, { lockLive, ageMinutes }) });
  }

  const present = candidates.filter(c => c.present);
  return {
    backupsRoot: resolvedBackupsRoot,
    outboxDir: outboxDir ? path.resolve(outboxDir) : null,
    lockLive,
    ageMinutes,
    candidates,
    summary: {
      total: present.length,
      toDelete: present.filter(c => c.decision === 'delete').length,
      kept: present.filter(c => c.decision === 'keep').length,
      skipped: present.filter(c => c.decision === 'skip').length
    }
  };
}

/**
 * Apply a plan from planStaleTmpCleanup. Idempotent — re-checks each entry immediately before
 * deleting and treats ENOENT as a no-op (already gone).
 */
export async function applyStaleTmpCleanupPlan(plan) {
  const deleted = [];
  const errors = [];
  for (const candidate of plan.candidates) {
    if (candidate.decision !== 'delete') continue;
    try {
      const stats = await fs.lstat(candidate.path);
      if (!stats.isFile()) {
        errors.push({ path: candidate.path, reason: 'no_longer_a_plain_file' });
        continue;
      }
      await fs.rm(candidate.path, { force: false });
      deleted.push({ path: candidate.path, kind: candidate.kind });
    } catch (err) {
      if (err?.code === 'ENOENT') continue; // idempotent no-op
      errors.push({ path: candidate.path, reason: err.message });
    }
  }
  return { deleted, errors };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage:',
    '  node scripts/life-ledger-sync-tmp-cleanup.mjs [options]',
    '',
    'Previews (default) or applies cleanup of orphaned worker .tmp atomic-write artifacts.',
    '',
    'Options:',
    '  --config <path>       worker config JSON (default: scripts/life-ledger-sync-worker.config.json)',
    '  --backups-root <path> overrides backupsRoot from config',
    '  --outbox-dir <path>   overrides outboxDir from config',
    '  --age-minutes <n>     default 10',
    '  --apply               actually delete. Without it, this is a dry-run preview only.',
    '  --json                print the machine-readable plan/result instead of a text summary',
    '  --help                show this message'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new LifeLedgerTmpCleanupError('missing_value', `Missing value after ${arg}`);
      i++;
      return value;
    };
    if (arg === '--config') options.configPath = takeValue();
    else if (arg === '--backups-root') options.backupsRoot = takeValue();
    else if (arg === '--outbox-dir') options.outboxDir = takeValue();
    else if (arg === '--age-minutes') options.ageMinutes = Number(takeValue());
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new LifeLedgerTmpCleanupError('unknown_arg', `Unknown argument: ${arg}`);
  }
  return options;
}

async function resolveRoots(options, cwd) {
  if (options.backupsRoot) return { backupsRoot: options.backupsRoot, outboxDir: options.outboxDir };
  const configPath = path.resolve(options.configPath || path.join(cwd, 'scripts', 'life-ledger-sync-worker.config.json'));
  try {
    const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
    return { backupsRoot: options.backupsRoot || cfg.backupsRoot, outboxDir: options.outboxDir || cfg.outboxDir };
  } catch (err) {
    if (err.code !== 'ENOENT') throw new LifeLedgerTmpCleanupError('config_unreadable', `Cannot read config at ${configPath}: ${err.message}`);
  }
  if (!options.backupsRoot) throw new LifeLedgerTmpCleanupError('missing_backups_root', `No --backups-root given and no backupsRoot found in ${configPath}`);
  return { backupsRoot: options.backupsRoot, outboxDir: options.outboxDir };
}

export async function runLifeLedgerTmpCleanupCli(argv, { cwd = process.cwd() } = {}) {
  const options = parseArgs(argv);
  if (options.help) return { help: true, text: usage() };
  const { backupsRoot, outboxDir } = await resolveRoots(options, cwd);
  const plan = await planStaleTmpCleanup({ backupsRoot, outboxDir, ageMinutes: options.ageMinutes });
  if (!options.apply) return { plan, applied: null };
  const applied = await applyStaleTmpCleanupPlan(plan);
  return { plan, applied };
}

async function main() {
  try {
    const outcome = await runLifeLedgerTmpCleanupCli(process.argv.slice(2));
    if (outcome.help) { console.log(outcome.text); return; }
    const { plan, applied } = outcome;
    console.log(JSON.stringify({ plan: plan.summary, applied }, null, 2));
    if (!applied) {
      console.log(`\nDry run only. ${plan.summary.toDelete} tmp artifact(s) would be deleted. Pass --apply to actually delete.`);
    } else if (applied.errors.length) {
      console.error(`${applied.errors.length} deletion(s) failed — see errors above.`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Life Ledger sync tmp cleanup failed: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
