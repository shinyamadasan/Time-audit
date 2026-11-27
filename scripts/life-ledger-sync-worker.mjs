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
// It does four things beyond calling the cycle: (1) reads the browser-written outbox snapshot
// from a configured local folder, (2) holds a single-instance lock for the duration of the run,
// (3) writes a run log plus a truthful, secret-free status file BACK into the outbox folder so
// the ChronaSense Settings UI can read it without ever touching the vault or backup filesystem,
// and (4) enforces the intervention latch — once a real apply reports `intervention_required`,
// every later `--apply` invocation is blocked (zero rollback prep, zero managed writes) until a
// human explicitly runs `--clear-intervention`.

export const LIFE_LEDGER_SYNC_WORKER_OUTBOX_FILENAME = 'chronasense-life-ledger-outbox-v1.json';
export const LIFE_LEDGER_SYNC_WORKER_STATUS_FILENAME = 'chronasense-life-ledger-outbox-v1.status.json';
export const LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME = 'intervention-required.json';
export const LIFE_LEDGER_SYNC_INTERVENTION_LATCH_SCHEMA_VERSION = 1;
const LOCK_FILENAME = 'life-ledger-sync-worker.lock';
// Used ONLY as a fallback when a lock's PID cannot be parsed/verified (Review Finding 4) — a
// confirmed-live PID is always held regardless of age, and a confirmed-dead PID is always
// reclaimable regardless of age. 30 minutes is generous vs. the expected sub-minute cycle time.
const STALE_LOCK_MS = 30 * 60 * 1000;

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
    '  --clear-intervention    explicitly clear a persisted intervention latch (see below). Does',
    '                          not run a sync cycle in the same invocation.',
    '  --once                  no effect beyond documentation intent — this script is always one-shot',
    '  --json                  print the machine-readable result instead of a text summary',
    '  --help                  show this message',
    '',
    'Config file shape: { "outboxDir": "...", "vault": "...", "expectedVault": "...", "backupsRoot": "..." }',
    '',
    'Intervention latch: if a real (--apply) cycle ever reports intervention_required (e.g. a',
    'partial-write failure), a durable latch file is written under --backups-root. Every later',
    '--apply invocation is refused (zero rollback-artifact prep, zero managed writes) until a',
    'human runs --clear-intervention after resolving the underlying issue. Dry runs may still',
    'observe and report state while latched, but never clear or bypass the latch.'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { apply: false, json: false, once: true, clearIntervention: false };
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
    else if (arg === '--clear-intervention') options.clearIntervention = true;
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
// Single-instance lock (Review Findings 3 & 4, TASK-049)
//
// Finding 4 — liveness is authoritative, never overridden by age:
//   - a lock with a parsable, confirmed-LIVE pid is held, full stop, regardless of age.
//   - a lock with a parsable, confirmed-DEAD pid is stale and reclaimable, regardless of age.
//   - a lock whose content parses but has no usable pid falls back to the age ceiling
//     (its startedAt) as a documented, conservative last resort.
//   - a lock whose content does not parse at all (an empty or partial file left by an older
//     worker version that died between creating and writing it, or a foreign file) is aged by
//     the file's own mtime against the same ceiling (TASK-049).
//
// TASK-049 — a takeover removes only the exact stale lock generation that was judged. The
// earlier rename-to-tombstone takeover moved whatever file sat at the lock path at rename time,
// so a contender holding a stale verdict could rename away a winner's FRESH lock and both would
// proceed. Three rules now make that impossible:
//   1. Publication. A lock or claim name only ever appears already holding its full payload,
//      which carries a random nonce: the payload is written to a unique temp file, then
//      hard-linked into place (`link()` fails with EEXIST if the name exists — one atomic step on
//      NTFS and POSIX alike). There is no empty or half-written window, so no two generations this
//      worker creates ever share bytes. A filesystem without hard links (FAT/exFAT, some network
//      shares) gets a clear `lock_unsupported_filesystem` error, never a weaker fallback.
//   2. Judgment. Bytes, age and file identity (dev, ino, birthtime) are read through ONE open
//      handle, so a verdict never mixes one file's bytes with a later file's mtime; and a name
//      whose bytes changed between a read by name and the handle read is never judged stale.
//   3. Removal. A judged-stale generation is removed only under its per-generation CLAIM,
//      `<file>.claim-<sha256(judged bytes)>`, itself created by rule 1. Under the claim the name is
//      re-read through one handle and removed only if it is the very file judged (same identity
//      AND same bytes) and still stale; then a new lock is published by rule 1.
// Why this is exclusive: the only things that ever remove a lock are its own holder's release and
// the holder of that generation's claim, and the claim excludes every other remover. A live
// generation created after the verdict has different bytes (rule 1) and a different identity, so
// it is never mistaken for the judged one — not even when the judged one was an old empty file,
// whose bytes and claim name every empty file shares. A live holder's lock is never removed, and
// while it exists no `link()` can create the name.
//
// Crash recovery is the same rule applied one level up: a claim file carries its own pid and
// nonce, and a claim left behind by a contender that died mid-takeover is judged by exactly the
// same liveness/age rules and broken through ITS OWN claim (`<claim>.claim-<sha256>`). Each extra
// level exists only because the level below was abandoned by a dead process, so a dead holder or
// a dead breaker can never wedge the lock permanently. Every removal is a rename to a unique
// `<lock>.stale-<pid>-<ms>-<hex>` tombstone (frees the name at once even if another contender
// has the file open on Windows; the retention tool prunes these) followed by an rm.
// ---------------------------------------------------------------------------

function pidIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but we lack permission to signal it — treat as running
  }
}

function isLockStale(existing) {
  const hasParsablePid = existing && typeof existing.pid === 'number' && Number.isFinite(existing.pid);
  if (hasParsablePid) {
    return !pidIsRunning(existing.pid); // authoritative — age is never consulted here
  }
  const ageMs = existing?.startedAt ? Date.now() - new Date(existing.startedAt).getTime() : Infinity;
  return ageMs >= STALE_LOCK_MS;
}

function newLockPayload() {
  return JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || null,
    nonce: crypto.randomUUID()
  });
}

// A unique `<lock>.stale-<pid>-<ms>-<hex>` name. It is used for removal tombstones and for the
// publication temp file, so anything a crash leaves under it is pruned by the retention tool.
function tombstonePathFor(lockPath) {
  return `${lockPath}.stale-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

// Error codes with which link() reports "this filesystem has no hard links" (Windows reports
// ERROR_INVALID_FUNCTION on FAT/exFAT as EISDIR).
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR', 'EXDEV']);

// Rule 1 (publication): makes `filePath` appear already holding a full, nonced payload, or not at
// all. Returns false when the name already exists.
async function tryCreateLockFile(filePath, lockPath) {
  const tempPath = tombstonePathFor(lockPath);
  try {
    await fs.writeFile(tempPath, newLockPayload(), { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.link(tempPath, filePath);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      if (LINK_UNSUPPORTED_CODES.has(err.code)) {
        throw new LifeLedgerSyncWorkerError('lock_unsupported_filesystem',
          `Cannot create ${filePath}: the single-instance lock needs hard links, which this filesystem refused (${err.code}). Put backupsRoot on NTFS (or another filesystem with hard links).`);
      }
      throw err;
    }
  } finally {
    // The temp is never at a lock or claim name; one left behind is pruned by retention.
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

// Rule 2 (judgment): a lock (or claim) generation is described from ONE open handle (its bytes,
// age and identity all belong to the same file), and it counts as settled only if those bytes
// equal a read of the name made just before the handle was opened. A name whose content changed
// while it was being judged is therefore never taken for an abandoned one. Null: it is gone.
async function readLockGeneration(filePath) {
  let rawByName;
  let handle;
  try {
    rawByName = await fs.readFile(filePath, 'utf8');
    handle = await fs.open(filePath, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const raw = await handle.readFile('utf8');
    const stats = await handle.stat({ bigint: true });
    return {
      raw,
      settled: raw === rawByName,
      identity: `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`,
      mtimeMs: Number(stats.mtimeMs)
    };
  } finally {
    await handle.close();
  }
}

function isGenerationStale(generation) {
  if (!generation.settled) return false; // changed while being judged: someone is alive there
  let parsed;
  try {
    parsed = JSON.parse(generation.raw);
  } catch {
    return Date.now() - generation.mtimeMs >= STALE_LOCK_MS;
  }
  return isLockStale(parsed);
}

async function removeViaTombstone(filePath, lockPath) {
  const tombstonePath = tombstonePathFor(lockPath);
  await fs.rename(filePath, tombstonePath);
  await fs.rm(tombstonePath, { force: true });
}

// Creates `filePath` exclusively, breaking it first only if it holds a stale generation.
// Returns true when this process now owns `filePath`; false means "someone else does" (skip).
async function acquireExclusiveFile(filePath, lockPath) {
  if (await tryCreateLockFile(filePath, lockPath)) return true;
  const judged = await readLockGeneration(filePath);
  if (!judged || !isGenerationStale(judged)) return false;

  const generation = crypto.createHash('sha256').update(judged.raw).digest('hex').slice(0, 16);
  const claimPath = `${filePath}.claim-${generation}`;
  if (!(await acquireExclusiveFile(claimPath, lockPath))) return false; // another contender is breaking it
  try {
    // Rule 3 (removal): only the very file judged — same identity AND bytes — and still stale.
    const current = await readLockGeneration(filePath);
    if (!current) return false; // already broken and released by an earlier claimant
    if (current.identity !== judged.identity || current.raw !== judged.raw) return false; // a later generation
    if (!isGenerationStale(current)) return false;
    await removeViaTombstone(filePath, lockPath);
    return await tryCreateLockFile(filePath, lockPath);
  } finally {
    await removeViaTombstone(claimPath, lockPath);
  }
}

async function acquireLock(backupsRoot) {
  await fs.mkdir(backupsRoot, { recursive: true });
  const lockPath = path.join(backupsRoot, LOCK_FILENAME);
  return (await acquireExclusiveFile(lockPath, lockPath)) ? lockPath : null;
}

async function releaseLock(lockPath) {
  if (lockPath) await fs.rm(lockPath, { force: true });
}

// Phase 11 — exposed read-only for the stale-artifact cleanup tool (life-ledger-sync-cleanup.mjs):
// reuses the exact same liveness/staleness judgment the lock itself uses, so cleanup can refuse
// to touch a known-generated .tmp filename while a worker might still be actively writing it,
// without duplicating the liveness logic.
export async function isBackupsRootLockLive(backupsRoot) {
  let existing;
  try {
    existing = JSON.parse(await fs.readFile(path.join(backupsRoot, LOCK_FILENAME), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return false; // no lock file at all — nothing is running
    existing = null; // unparsable — fall through to the same conservative staleness ceiling
  }
  return !isLockStale(existing);
}

// ---------------------------------------------------------------------------
// Intervention latch (Review Finding 1)
// ---------------------------------------------------------------------------

function interventionLatchPath(backupsRoot) {
  return path.join(backupsRoot, LIFE_LEDGER_SYNC_INTERVENTION_LATCH_FILENAME);
}

async function readInterventionLatch(backupsRoot) {
  try {
    return JSON.parse(await fs.readFile(interventionLatchPath(backupsRoot), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new LifeLedgerSyncWorkerError('intervention_latch_unreadable', `Cannot read intervention latch: ${err.message}`);
  }
}

async function writeInterventionLatch(backupsRoot, result) {
  await fs.mkdir(backupsRoot, { recursive: true });
  const latch = {
    schemaVersion: LIFE_LEDGER_SYNC_INTERVENTION_LATCH_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    runId: result.runId,
    outcome: result.outcome,
    category: result.category || null,
    reason: result.reason || null,
    message: result.message || '',
    planFingerprint: result.planFingerprint || null,
    outboxSha256: result.outboxSha256 || null,
    receiptPath: result.receiptPath || null,
    written: Array.isArray(result.written) ? result.written : [],
    failedRelativePath: result.failedRelativePath || null
  };
  const target = interventionLatchPath(backupsRoot);
  const tempPath = `${target}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(latch, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, target);
  return latch;
}

// Phase 11 — clearing must work even when the latch file itself is corrupt/unparseable JSON
// (readInterventionLatch() above intentionally still THROWS in the normal apply/dry-run path on
// a corrupt latch, so every automated cycle keeps failing loud until a human clears it — that
// part is unchanged). --clear-intervention is the one explicit, human-authorized action that
// must never itself get stuck behind the corruption it is meant to resolve. It never touches
// readInterventionLatch: it inspects and clears the exact latch path directly, refuses anything
// that is not a plain file (a symlink/reparse point or a directory at that exact path is left
// alone and reported, never removed), and — when the JSON is corrupt — preserves the bytes by
// renaming them aside instead of deleting them outright, so a human can still inspect what was
// there.
async function clearInterventionLatch(backupsRoot) {
  const target = interventionLatchPath(backupsRoot);
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch (err) {
    if (err.code === 'ENOENT') return { cleared: false, latch: null, corrupt: false };
    throw new LifeLedgerSyncWorkerError('intervention_latch_unreadable', `Cannot inspect intervention latch: ${err.message}`);
  }
  if (!stats.isFile()) {
    throw new LifeLedgerSyncWorkerError(
      'intervention_latch_not_a_plain_file',
      `Refusing to clear: ${target} is not a plain file (symlink/reparse point or directory) — resolve this manually before retrying.`
    );
  }
  const raw = await fs.readFile(target, 'utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt latch: preserve the evidence by renaming it aside (same directory, exact target
    // name only — no other files touched) rather than unlinking it. This still "clears" the
    // latch, since every future --apply check looks for the exact original filename.
    const evidencePath = `${target}.corrupt-${Date.now()}`;
    await fs.rename(target, evidencePath);
    return { cleared: true, latch: null, corrupt: true, evidencePath };
  }
  await fs.rm(target, { force: true });
  return { cleared: true, latch: parsed, corrupt: false };
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

async function maybeWriteOutboxStatus(outboxDir, result) {
  const outboxDirExists = await fs.access(outboxDir).then(() => true, () => false);
  if (outboxDirExists) await writeOutboxStatus(outboxDir, result);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function newRunId(clock) {
  return `${new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
}

function isoNow(clock) {
  return new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString();
}

export async function runLifeLedgerSyncWorker(argv, { cwd = process.cwd(), clock, fs: cycleFsOverride } = {}) {
  const options = parseArgs(argv);
  if (options.help) return { help: true, text: usage() };

  const config = await resolveConfig(options, { cwd });
  const runId = newRunId(clock);

  const lockPath = await acquireLock(config.backupsRoot);
  if (!lockPath) {
    return { skipped: true, reason: 'already_running', runId };
  }

  try {
    // --clear-intervention is a standalone action: it never runs a sync cycle in the same
    // invocation, and it requires the lock too (so it never races an in-progress cycle).
    if (options.clearIntervention) {
      const { cleared, latch, corrupt, evidencePath } = await clearInterventionLatch(config.backupsRoot);
      const message = !cleared
        ? 'No intervention latch was present — nothing to clear.'
        : corrupt
          ? `Cleared an intervention latch whose JSON was corrupt/unparseable. The original bytes were preserved for review at ${evidencePath}.`
          : `Cleared the intervention latch from run ${latch.runId} (${latch.outcome}${latch.category ? `/${latch.category}` : ''}${latch.reason ? `: ${latch.reason}` : ''}).`;
      const result = {
        runId,
        startedAt: isoNow(clock),
        endedAt: isoNow(clock),
        outcome: cleared ? 'intervention_cleared' : 'no_intervention_latch',
        message,
        clearedLatch: latch,
        clearedLatchWasCorrupt: corrupt === true,
        ...(evidencePath ? { corruptLatchEvidencePath: evidencePath } : {})
      };
      await writeRunLog(config.backupsRoot, result);
      await maybeWriteOutboxStatus(config.outboxDir, result);
      return { skipped: false, result, json: options.json, cleared };
    }

    const existingLatch = await readInterventionLatch(config.backupsRoot);

    // A real apply-style invocation while a latch is present is refused BEFORE the cycle is ever
    // called — no rollback-artifact preparation, no backup copy, no managed write, and no new
    // backup-directory churn on repeated scheduled invocations.
    if (options.apply === true && existingLatch) {
      const result = {
        runId,
        startedAt: isoNow(clock),
        endedAt: isoNow(clock),
        outcome: 'intervention_required',
        category: 'latched',
        reason: 'intervention_latch_present',
        message: `Automated apply is blocked by an unresolved intervention from run ${existingLatch.runId} (${existingLatch.outcome}${existingLatch.category ? `/${existingLatch.category}` : ''}, recorded ${existingLatch.createdAt}). Resolve the underlying issue, then run --clear-intervention to resume.`,
        latch: existingLatch
      };
      await writeRunLog(config.backupsRoot, result);
      await maybeWriteOutboxStatus(config.outboxDir, result);
      return { skipped: false, result, json: options.json };
    }

    const outboxSnapshotJson = await readOutboxSnapshot(config.outboxDir);
    const result = await runLifeLedgerSyncCycle({
      runId,
      clock,
      outboxSnapshotJson,
      vaultPath: config.vault,
      expectedCanonicalVaultPath: config.expectedVault,
      backupRoot: path.join(config.backupsRoot, 'receipts', runId),
      dryRun: options.apply !== true,
      ...(cycleFsOverride ? { fs: cycleFsOverride } : {})
    });

    let finalResult = result;
    if (options.apply === true && result.outcome === 'intervention_required') {
      // Only a REAL (non-dry-run) intervention_required latches. Dry runs can observe the same
      // outcome (e.g. an unexpected first-run state) without ever creating the latch.
      await writeInterventionLatch(config.backupsRoot, result);
    } else if (existingLatch) {
      // A dry run (or diagnostic) executed while a latch from an earlier run is still present —
      // annotate a COPY of the (frozen) cycle result so status/logs stay accurate. Never touches
      // the latch itself.
      finalResult = { ...result, latched: true, latch: existingLatch };
    }

    await writeRunLog(config.backupsRoot, finalResult);
    await maybeWriteOutboxStatus(config.outboxDir, finalResult);
    return { skipped: false, result: finalResult, json: options.json };
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
