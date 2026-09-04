import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runLifeLedgerSyncCycle, summarizeCycleResultForOutbox } from '../life-ledger-sync-cycle.js';

// Phase 10 — the background worker entry point. This is a ONE-SHOT script: it runs exactly one
// sync cycle and exits. It is meant to be invoked repeatedly by an external scheduler (Windows
// Task Scheduler, via setup-life-ledger-sync-scheduler.ps1) rather than run as a long-lived
// daemon — that keeps startup/restart trivially safe (there is no in-process state to recover)
// and matches the "no dependence on VS Code / the coding agent being active" requirement.
//
// It does three things beyond calling the cycle: (1) reads the browser-written outbox snapshot
// from a configured local folder, (2) holds a single-instance lock for the duration of the run,
// (3) writes a run log plus a truthful, secret-free status file BACK into the outbox folder so
// the ChronaSense Settings UI can read it without ever touching the vault or backup filesystem.

export const LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME = 'chronasense-life-ledger-outbox-v1.json';
export const LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME = 'chronasense-life-ledger-outbox-v1.status.json';
const LOCK_FILENAME = 'life-ledger-sync-worker.lock';
const STALE_LOCK_MS = 30 * 60 * 1000; // 30 minutes — generous vs. the expected sub-minute cycle time

export class LifeLedgerSyncWorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LifeLedgerSyncWorkerError';
    this.code = code;
  }
}

function usage() {
  return [
    'Usage:',
    '  node scripts/life-ledger-sync-worker.mjs [options]',
    '',
    'Runs exactly one Life Ledger -> Obsidian background sync cycle and exits.',
    '',
    'Options:',
    '  --config <path>         JSON config file (default: scripts/life-ledger-sync-worker.config.json)',
    '  --outbox-dir <path>     folder the browser was granted write access to (overrides config)',
    '  --vault <path>          vault root to sync into (overrides config)',
    '  --expected-vault <path> production identity guard (defaults to --vault)',
    '  --backups-root <path>   base directory for fresh per-run rollback artifacts (overrides config)',
    '  --apply                 perform a real cycle (plan + prepare + apply). Without it, this run',
    '                          is a dry run: it reports what would happen and writes nothing.',
    '  --once                  no effect beyond documentation intent — this script is always one-shot',
    '  --json                  print the machine-readable result instead of a text summary',
    '  --help                  show this message',
    '',
    'Config file shape: { "outboxDir": "...", "vault": "...", "expectedVault": "...", "backupsRoot": "..." }'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { apply: false, json: false, once: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new LifeLedgerSyncWorkerError('missing_value', `Missing value after ${arg}`);
      i++;
      return value;
    };
    if (arg === '--config') options.configPath = takeValue();
    else if (arg === '--outbox-dir') options.outboxDir = takeValue();
    else if (arg === '--vault') options.vault = takeValue();
    else if (arg === '--expected-vault') options.expectedVault = takeValue();
    else if (arg === '--backups-root') options.backupsRoot = takeValue();
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new LifeLedgerSyncWorkerError('unknown_arg', `Unknown argument: ${arg}`);
  }
  return options;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new LifeLedgerSyncWorkerError('config_unreadable', `Cannot read config at ${filePath}: ${err.message}`);
  }
}

async function resolveConfig(options, { cwd = process.cwd() } = {}) {
  const configPath = path.resolve(options.configPath || path.join(cwd, 'scripts', 'life-ledger-sync-worker.config.json'));
  const fileConfig = (await readJsonIfExists(configPath)) || {};
  const outboxDir = options.outboxDir || fileConfig.outboxDir;
  const vault = options.vault || fileConfig.vault;
  const expectedVault = options.expectedVault || fileConfig.expectedVault || vault;
  const backupsRoot = options.backupsRoot || fileConfig.backupsRoot;
  const missing = [];
  if (!outboxDir) missing.push('outboxDir');
  if (!vault) missing.push('vault');
  if (!backupsRoot) missing.push('backupsRoot');
  if (missing.length) {
    throw new LifeLedgerSyncWorkerError('missing_config', `Missing required configuration: ${missing.join(', ')} (set via --flags or ${configPath})`);
  }
  return { outboxDir: path.resolve(outboxDir), vault: path.resolve(vault), expectedVault: path.resolve(expectedVault), backupsRoot: path.resolve(backupsRoot) };
}

// ---------------------------------------------------------------------------
// Single-instance lock. A plain exclusive-create lock file; a lock older than STALE_LOCK_MS or
// whose PID is no longer running is treated as abandoned (e.g. the machine was rebooted mid-run)
// and is safely broken. This is a diagnostic/courtesy layer — Task Scheduler's own "do not start
// a new instance if already running" setting is the primary concurrency guard (see the installer
// script); this lock protects manual/diagnostic invocations too.
// ---------------------------------------------------------------------------

function pidIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but we lack permission to signal it — treat as running
  }
}

async function acquireLock(backupsRoot) {
  await fs.mkdir(backupsRoot, { recursive: true });
  const lockPath = path.join(backupsRoot, LOCK_FILENAME);
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || null });
  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(payload, 'utf8');
    await handle.close();
    return lockPath;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  // Lock exists — decide whether it is stale.
  let existing;
  try {
    existing = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch {
    existing = null;
  }
  const ageMs = existing?.startedAt ? Date.now() - new Date(existing.startedAt).getTime() : Infinity;
  const stillRunning = existing?.pid != null && pidIsRunning(existing.pid);
  if (stillRunning && ageMs < STALE_LOCK_MS) {
    return null; // genuinely already running — caller should skip this cycle
  }
  // Stale (process gone, or older than the generous ceiling regardless of PID reuse) — break it.
  await fs.rm(lockPath, { force: true });
  const handle = await fs.open(lockPath, 'wx');
  await handle.writeFile(payload, 'utf8');
  await handle.close();
  return lockPath;
}

async function releaseLock(lockPath) {
  if (lockPath) await fs.rm(lockPath, { force: true });
}

// ---------------------------------------------------------------------------
// Outbox I/O
// ---------------------------------------------------------------------------

async function readOutboxSnapshot(outboxDir) {
  try {
    return await fs.readFile(path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new LifeLedgerSyncWorkerError('outbox_unreadable', `Cannot read outbox snapshot: ${err.message}`);
  }
}

async function writeOutboxStatus(outboxDir, result) {
  const summary = summarizeCycleResultForOutbox(result);
  const content = `${JSON.stringify(summary, null, 2)}\n`;
  const target = path.join(outboxDir, LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME);
  const tempPath = `${target}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, target);
}

async function writeRunLog(backupsRoot, result) {
  const runsDir = path.join(backupsRoot, 'runs');
  await fs.mkdir(runsDir, { recursive: true });
  const logPath = path.join(runsDir, `${result.runId}.json`);
  await fs.writeFile(logPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const statusPath = path.join(backupsRoot, 'status.json');
  await fs.writeFile(statusPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return logPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runLifeLedgerSyncWorker(argv, { cwd = process.cwd(), clock } = {}) {
  const options = parseArgs(argv);
  if (options.help) return { help: true, text: usage() };

  const config = await resolveConfig(options, { cwd });
  const runId = `${new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;

  const lockPath = await acquireLock(config.backupsRoot);
  if (!lockPath) {
    return { skipped: true, reason: 'already_running', runId };
  }

  try {
    const outboxSnapshotJson = await readOutboxSnapshot(config.outboxDir);
    const result = await runLifeLedgerSyncCycle({
      runId,
      clock,
      outboxSnapshotJson,
      vaultPath: config.vault,
      expectedCanonicalVaultPath: config.expectedVault,
      backupRoot: path.join(config.backupsRoot, 'receipts', runId),
      dryRun: options.apply !== true
    });
    await writeRunLog(config.backupsRoot, result);
    // Only write outbox status back if there IS an outbox to write into (an outbox folder the
    // browser can read requires the folder to already exist, which it will once the browser has
    // ever picked it — if it does not exist yet there is no UI to serve status to).
    const outboxDirExists = await fs.access(config.outboxDir).then(() => true, () => false);
    if (outboxDirExists) await writeOutboxStatus(config.outboxDir, result);
    return { skipped: false, result, json: options.json };
  } finally {
    await releaseLock(lockPath);
  }
}

async function main() {
  try {
    const outcome = await runLifeLedgerSyncWorker(process.argv.slice(2));
    if (outcome.help) { console.log(outcome.text); return; }
    if (outcome.skipped) {
      console.log(`Life Ledger sync worker: skipped (${outcome.reason}) — another run is already in progress.`);
      return;
    }
    if (outcome.json) {
      console.log(JSON.stringify(outcome.result, null, 2));
    } else {
      const r = outcome.result;
      console.log(`Life Ledger sync worker: ${r.outcome}${r.reason ? ` (${r.reason})` : ''} — ${r.message}`);
    }
    if (outcome.result && (outcome.result.outcome === 'error' || outcome.result.outcome === 'intervention_required')) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Life Ledger sync worker failed: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
