import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathEqualsOrContains } from '../obsidian-life-ledger-writer.js';
import { LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME } from './life-ledger-sync-worker.mjs';

// Phase 11 — bounded local retention for automation artifacts under a worker's backupsRoot.
//
// Scope is deliberately narrow: this module only ever looks at, and only ever deletes inside,
// the exact backupsRoot it is given. It never touches the vault, the outbox, or any path that
// does not resolve (after following any real symlink/reparse point) to somewhere underneath
// backupsRoot. Every entry is lstat'd before deletion — an entry that is itself a symlink/
// reparse point, or whose realpath escapes backupsRoot, is left alone and reported, not deleted.
//
// Policy (age-with-a-count-floor — see REQUIRED OUTCOME 1):
//   - runs/*.json        : delete only if older than retentionDays AND outside the most recent
//                           minKeep run logs (by mtime).
//   - receipts/<runId>/  : same rule, applied to receipt directories (by mtime).
//   - lock tombstones     : life-ledger-sync-worker.lock.stale-* directly under backupsRoot;
//                           these are always-orphaned (the worker itself never reads a tombstone
//                           name back) so they use a single conservative age threshold, no count
//                           floor needed.
//
// The count floor exists so that a misconfigured (too-small) retentionDays can never eat every
// last piece of diagnostic evidence — there are always at least minKeep of the most recent runs/
// receipts on disk. Whichever rule (age or count) would keep MORE is the one that wins.
//
// Active-latch protection is absolute and independent of age/count: if backupsRoot/
// intervention-required.json exists and parses, the run log for its runId and the receipt
// directory at its receiptPath are never candidates for deletion, full stop.
//
// Review Finding 1 (Phase 11 fix pass) — a CORRUPT (present but unparseable) latch is the
// dangerous case: its runId/receiptPath can't be read, so which specific run log and receipt
// it references is UNKNOWN. Silently falling back to "protect nothing specific, count-floor
// still applies" could prune exactly the evidence an active incident depends on. So when the
// latch is present but does not parse, ALL run-log and receipt pruning is blocked outright —
// `retentionBlocked: true, retentionBlockedReason: 'corrupt_intervention_latch'` — regardless of
// age or count floor, until a human runs the already-reviewed corrupt-latch clear action
// (`--clear-intervention`). Lock tombstones are unaffected by this block: they are always-orphaned
// by construction (see below) and never reference incident evidence, so pruning them stays safe
// even while a corrupt latch blocks everything else. `restore-evidence/` (written by
// life-ledger-sync-restore.mjs) is never walked or touched by this module at all, corrupt latch
// or not — it is simply out of this module's scope.

export const RETENTION_DEFAULT_DAYS = 30;
export const RETENTION_MIN_KEEP = 20;
export const RETENTION_STALE_LOCK_MINUTES = 60;
const RUNS_DIRNAME = 'runs';
const RECEIPTS_DIRNAME = 'receipts';
const LOCK_TOMBSTONE_RE = /^life-ledger-sync-worker\.lock\.stale-\d+-\d+-[0-9a-f]+$/;

export class LifeLedgerRetentionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LifeLedgerRetentionError';
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

// True only if `candidatePath` both lstats as a non-link AND its realpath still resolves
// underneath `containerRealRoot`. This is the reparse-safety gate every deletion goes through.
async function isSafeContainedEntry(containerRealRoot, candidatePath) {
  let stats;
  try {
    stats = await fs.lstat(candidatePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { safe: false, reason: 'missing' };
    throw err;
  }
  if (stats.isSymbolicLink()) return { safe: false, reason: 'is_symlink' };
  const real = await realPathOrResolved(candidatePath);
  if (!pathEqualsOrContains(containerRealRoot, real)) return { safe: false, reason: 'escapes_backups_root' };
  return { safe: true, stats };
}

async function readLatchBestEffort(backupsRoot) {
  const latchPath = path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME);
  let text;
  try {
    text = await fs.readFile(latchPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { present: false, parsed: null };
    throw err;
  }
  try {
    return { present: true, parsed: JSON.parse(text) };
  } catch {
    return { present: true, parsed: null }; // corrupt — protect nothing specific, count floor still applies
  }
}

async function listDirSafe(dirPath) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function classifyByAgeAndRank(entries, { retentionDays, minKeep, retentionBlocked }) {
  // entries: [{ name, mtimeMs, protected }] — newest first after sort.
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (retentionBlocked) {
    // A corrupt latch means we cannot know what it references — every run/receipt is kept,
    // full stop, until a human clears the corrupt latch. See the Review Finding 1 note above.
    return sorted.map(entry => ({ ...entry, decision: 'keep', why: 'retention_blocked_corrupt_latch' }));
  }
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const clampedMinKeep = Math.max(1, minKeep);
  return sorted.map((entry, rank) => {
    if (entry.protected) return { ...entry, decision: 'keep', why: 'active_latch_evidence' };
    if (rank < clampedMinKeep) return { ...entry, decision: 'keep', why: 'within_min_keep_floor' };
    if (entry.mtimeMs >= cutoffMs) return { ...entry, decision: 'keep', why: 'within_retention_days' };
    return { ...entry, decision: 'delete', why: 'older_than_retention_days_and_beyond_min_keep' };
  });
}

/**
 * Compute (without deleting anything) what retention would do right now.
 *
 * @param {string} backupsRoot
 * @param {object} [options]
 * @param {number} [options.retentionDays]
 * @param {number} [options.minKeep]
 * @param {number} [options.staleLockMinutes]
 * @returns {Promise<object>} plan with `runs`, `receipts`, `lockTombstones` arrays plus a summary
 */
export async function planLifeLedgerRetention(backupsRoot, options = {}) {
  const retentionDays = options.retentionDays ?? RETENTION_DEFAULT_DAYS;
  const minKeep = options.minKeep ?? RETENTION_MIN_KEEP;
  const staleLockMinutes = options.staleLockMinutes ?? RETENTION_STALE_LOCK_MINUTES;
  if (!(retentionDays >= 0)) throw new LifeLedgerRetentionError('invalid_option', 'retentionDays must be >= 0');
  if (!(minKeep >= 0)) throw new LifeLedgerRetentionError('invalid_option', 'minKeep must be >= 0');

  const resolvedRoot = path.resolve(backupsRoot);
  // backupsRoot itself is allowed to be a real directory (not a link) — if it doesn't exist yet
  // there is simply nothing to prune.
  let rootExists = true;
  try {
    const rootStats = await fs.lstat(resolvedRoot);
    if (rootStats.isSymbolicLink()) {
      throw new LifeLedgerRetentionError('backups_root_is_symlink', `backupsRoot must not itself be a symlink/reparse point: ${resolvedRoot}`);
    }
  } catch (err) {
    if (err?.code === 'ENOENT') rootExists = false;
    else if (err instanceof LifeLedgerRetentionError) throw err;
    else throw err;
  }
  if (!rootExists) {
    return {
      backupsRoot: resolvedRoot, rootExists: false, runs: [], receipts: [], lockTombstones: [],
      latch: { present: false }, retentionBlocked: false, retentionBlockedReason: null,
      summary: summarize([], [], [])
    };
  }
  const containerRealRoot = await realPathOrResolved(resolvedRoot);

  const latch = await readLatchBestEffort(resolvedRoot);
  const protectedRunId = latch.parsed?.runId || null;
  const protectedReceiptDirName = latch.parsed?.receiptPath
    ? path.basename(path.dirname(path.resolve(latch.parsed.receiptPath)))
    : null;
  // Review Finding 1: present-but-unparseable is the dangerous case — see the module-header note.
  const retentionBlocked = latch.present === true && latch.parsed === null;
  const retentionBlockedReason = retentionBlocked ? 'corrupt_intervention_latch' : null;

  // --- runs/*.json ---
  const runsDir = path.join(resolvedRoot, RUNS_DIRNAME);
  const runEntries = [];
  for (const dirent of await listDirSafe(runsDir)) {
    if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
    if (!dirent.name.endsWith('.json')) continue;
    const full = path.join(runsDir, dirent.name);
    const check = await isSafeContainedEntry(containerRealRoot, full);
    if (!check.safe) {
      runEntries.push({ name: dirent.name, path: full, decision: 'skip', why: check.reason });
      continue;
    }
    const runId = dirent.name.replace(/\.json$/, '');
    runEntries.push({
      name: dirent.name, path: full, mtimeMs: check.stats.mtimeMs,
      protected: protectedRunId != null && runId === protectedRunId
    });
  }
  const settledRuns = runEntries.filter(e => e.decision !== 'skip');
  const skippedRuns = runEntries.filter(e => e.decision === 'skip');
  const classifiedRuns = classifyByAgeAndRank(settledRuns, { retentionDays, minKeep, retentionBlocked }).concat(skippedRuns);

  // --- receipts/<runId>/ ---
  const receiptsDir = path.join(resolvedRoot, RECEIPTS_DIRNAME);
  const receiptEntries = [];
  for (const dirent of await listDirSafe(receiptsDir)) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    const full = path.join(receiptsDir, dirent.name);
    const check = await isSafeContainedEntry(containerRealRoot, full);
    if (!check.safe) {
      receiptEntries.push({ name: dirent.name, path: full, decision: 'skip', why: check.reason });
      continue;
    }
    receiptEntries.push({
      name: dirent.name, path: full, mtimeMs: check.stats.mtimeMs,
      protected: protectedReceiptDirName != null && dirent.name === protectedReceiptDirName
    });
  }
  const settledReceipts = receiptEntries.filter(e => e.decision !== 'skip');
  const skippedReceipts = receiptEntries.filter(e => e.decision === 'skip');
  const classifiedReceipts = classifyByAgeAndRank(settledReceipts, { retentionDays, minKeep, retentionBlocked }).concat(skippedReceipts);

  // --- lock tombstones directly under backupsRoot ---
  const tombstones = [];
  const staleCutoffMs = Date.now() - staleLockMinutes * 60 * 1000;
  for (const dirent of await listDirSafe(resolvedRoot)) {
    if (!LOCK_TOMBSTONE_RE.test(dirent.name)) continue;
    const full = path.join(resolvedRoot, dirent.name);
    const check = await isSafeContainedEntry(containerRealRoot, full);
    if (!check.safe) {
      tombstones.push({ name: dirent.name, path: full, decision: 'skip', why: check.reason });
      continue;
    }
    tombstones.push({
      name: dirent.name, path: full, mtimeMs: check.stats.mtimeMs,
      decision: check.stats.mtimeMs < staleCutoffMs ? 'delete' : 'keep',
      why: check.stats.mtimeMs < staleCutoffMs ? 'stale_lock_tombstone_past_age_threshold' : 'too_recent_to_assume_orphaned'
    });
  }

  return {
    backupsRoot: resolvedRoot,
    rootExists: true,
    policy: { retentionDays, minKeep, staleLockMinutes },
    latch: { present: latch.present, parsed: latch.parsed !== null, protectedRunId, protectedReceiptDirName },
    retentionBlocked,
    retentionBlockedReason,
    runs: classifiedRuns,
    receipts: classifiedReceipts,
    lockTombstones: tombstones,
    summary: summarize(classifiedRuns, classifiedReceipts, tombstones)
  };
}

function summarize(runs, receipts, tombstones) {
  const count = (list, decision) => list.filter(e => e.decision === decision).length;
  return {
    runsTotal: runs.length, runsToDelete: count(runs, 'delete'), runsSkipped: count(runs, 'skip'),
    receiptsTotal: receipts.length, receiptsToDelete: count(receipts, 'delete'), receiptsSkipped: count(receipts, 'skip'),
    tombstonesTotal: tombstones.length, tombstonesToDelete: count(tombstones, 'delete'), tombstonesSkipped: count(tombstones, 'skip'),
    pruningDue: count(runs, 'delete') > 0 || count(receipts, 'delete') > 0 || count(tombstones, 'delete') > 0
  };
}

/**
 * Apply a plan previously computed by planLifeLedgerRetention. Idempotent: re-running the plan
 * step against the resulting disk state yields zero further deletions. Every deletion re-checks
 * lstat/realpath containment immediately before removing (defense against a TOCTOU swap between
 * plan and apply), and silently no-ops (ENOENT) an entry that vanished in between.
 *
 * @param {object} plan - result of planLifeLedgerRetention
 * @returns {Promise<object>} { deleted: [...], errors: [...] }
 */
export async function applyLifeLedgerRetentionPlan(plan) {
  if (!plan || plan.rootExists === false) return { deleted: [], errors: [] };
  const containerRealRoot = await realPathOrResolved(plan.backupsRoot);
  const deleted = [];
  const errors = [];

  const removeOne = async (entry, kind) => {
    if (entry.decision !== 'delete') return;
    const recheck = await isSafeContainedEntry(containerRealRoot, entry.path).catch(err => ({ safe: false, reason: err.code || 'error' }));
    if (!recheck.safe) {
      if (recheck.reason === 'missing') return; // already gone — idempotent no-op
      errors.push({ path: entry.path, kind, reason: recheck.reason });
      return;
    }
    try {
      if (kind === 'receipt') await fs.rm(entry.path, { recursive: true, force: false });
      else await fs.rm(entry.path, { force: false });
      deleted.push({ path: entry.path, kind });
    } catch (err) {
      if (err?.code === 'ENOENT') return; // idempotent no-op
      errors.push({ path: entry.path, kind, reason: err.message });
    }
  };

  for (const entry of plan.runs) await removeOne(entry, 'run_log');
  for (const entry of plan.receipts) await removeOne(entry, 'receipt');
  for (const entry of plan.lockTombstones) await removeOne(entry, 'lock_tombstone');

  return { deleted, errors };
}

/**
 * Compute total bytes + entry counts under backupsRoot's runs/ and receipts/ subtrees, for
 * health-command reporting. Read-only; never deletes anything.
 */
export async function computeLifeLedgerBackupsFootprint(backupsRoot) {
  const resolvedRoot = path.resolve(backupsRoot);
  let totalBytes = 0;
  let fileCount = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow links while measuring footprint
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const stats = await fs.stat(full);
        totalBytes += stats.size;
        fileCount += 1;
      }
    }
  }
  let exists = true;
  try {
    await fs.access(resolvedRoot);
  } catch {
    exists = false;
  }
  if (exists) await walk(resolvedRoot);
  return { backupsRoot: resolvedRoot, exists, totalBytes, fileCount };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage:',
    '  node scripts/life-ledger-sync-retention.mjs [options]',
    '',
    'Previews (default) or applies bounded local retention for one worker backupsRoot.',
    '',
    'Options:',
    '  --config <path>            worker config JSON to read backupsRoot from (default: scripts/life-ledger-sync-worker.config.json)',
    '  --backups-root <path>      overrides the backupsRoot from config',
    '  --retention-days <n>       default 30',
    '  --min-keep <n>             default 20',
    '  --stale-lock-minutes <n>   default 60',
    '  --apply                    actually delete. Without it, this is a dry-run preview only.',
    '  --json                     print the machine-readable plan/result instead of a text summary',
    '  --help                     show this message'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new LifeLedgerRetentionError('missing_value', `Missing value after ${arg}`);
      i++;
      return value;
    };
    if (arg === '--config') options.configPath = takeValue();
    else if (arg === '--backups-root') options.backupsRoot = takeValue();
    else if (arg === '--retention-days') options.retentionDays = Number(takeValue());
    else if (arg === '--min-keep') options.minKeep = Number(takeValue());
    else if (arg === '--stale-lock-minutes') options.staleLockMinutes = Number(takeValue());
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new LifeLedgerRetentionError('unknown_arg', `Unknown argument: ${arg}`);
  }
  return options;
}

async function resolveBackupsRoot(options, cwd) {
  if (options.backupsRoot) return options.backupsRoot;
  const configPath = path.resolve(options.configPath || path.join(cwd, 'scripts', 'life-ledger-sync-worker.config.json'));
  try {
    const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (cfg.backupsRoot) return cfg.backupsRoot;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new LifeLedgerRetentionError('config_unreadable', `Cannot read config at ${configPath}: ${err.message}`);
  }
  throw new LifeLedgerRetentionError('missing_backups_root', `No --backups-root given and no backupsRoot found in ${configPath}`);
}

export async function runLifeLedgerRetentionCli(argv, { cwd = process.cwd() } = {}) {
  const options = parseArgs(argv);
  if (options.help) return { help: true, text: usage() };
  const backupsRoot = await resolveBackupsRoot(options, cwd);
  const plan = await planLifeLedgerRetention(backupsRoot, {
    retentionDays: options.retentionDays,
    minKeep: options.minKeep,
    staleLockMinutes: options.staleLockMinutes
  });
  if (!options.apply) return { plan, applied: null };
  const applied = await applyLifeLedgerRetentionPlan(plan);
  return { plan, applied };
}

async function main() {
  try {
    const outcome = await runLifeLedgerRetentionCli(process.argv.slice(2));
    if (outcome.help) { console.log(outcome.text); return; }
    const { plan, applied } = outcome;
    if (plan.rootExists === false) {
      console.log(`backupsRoot does not exist yet — nothing to prune (${plan.backupsRoot}).`);
      return;
    }
    console.log(JSON.stringify({ plan: plan.summary, retentionBlocked: plan.retentionBlocked, retentionBlockedReason: plan.retentionBlockedReason, applied }, null, 2));
    if (plan.retentionBlocked) {
      console.log(`\nRETENTION BLOCKED: ${plan.retentionBlockedReason}. Run/receipt pruning is refused until the corrupt intervention latch is cleared by a human (--clear-intervention). Only lock-tombstone cleanup (if any) proceeds normally.`);
    }
    if (!applied) {
      console.log(`\nDry run only. ${plan.summary.runsToDelete} run log(s), ${plan.summary.receiptsToDelete} receipt dir(s), ${plan.summary.tombstonesToDelete} lock tombstone(s) would be deleted. Pass --apply to actually delete.`);
    } else if (applied.errors.length) {
      console.error(`${applied.errors.length} deletion(s) failed — see errors above.`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Life Ledger sync retention failed: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
