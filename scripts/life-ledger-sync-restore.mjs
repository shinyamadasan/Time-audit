import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createObsidianSyncTarget,
  planObsidianSync,
  OBSIDIAN_SYNC_SCHEMA_VERSION
} from '../obsidian-life-ledger-sync.js';
import {
  defaultFsAdapter,
  resolveObsidianLifeLedgerPath,
  writeFileAtomically,
  readTextIfExists,
  OBSIDIAN_LIFE_LEDGER_MANAGED_DIR
} from '../obsidian-life-ledger-writer.js';

// Phase 11 — REQUIRED OUTCOME 2: recovery tooling.
//
// This is a HUMAN-AUTHORIZED recovery assistant, not autonomous rollback. It follows
// inspect -> verify -> preview -> explicit restore, and is deliberately scoped narrower than "undo
// everything a rollback receipt saw": it only ever WRITES (create/overwrite) the exact files a
// verified receipt backed up, back to their exact backed-up bytes. It never deletes anything —
// files that exist now but were not part of the receipt's backup set are reported, never touched.
// A delete-capable restore would materially expand this tool's blast radius for a benefit this
// system doesn't currently need (the real failure mode this exists for is a partial/corrupted
// apply, where some already-owned files need to go back to known-good bytes) — see the Phase 11
// final report for that scoping decision.
//
// Every write is confined to the vault's managed `Life Ledger/` subtree via the same
// resolveObsidianLifeLedgerPath() reparse/leaf/traversal safety used by the reviewed Phase 9/10
// write path — so `.git`, `.obsidian`, `.rag`, and anything else outside `Life Ledger/` are
// structurally unreachable here, not just policy-excluded.

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export class LifeLedgerRestoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LifeLedgerRestoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

// ---------------------------------------------------------------------------
// 1. Load + self-verify the receipt (exact path required, cryptographically hash-checked)
// ---------------------------------------------------------------------------

export async function loadRestoreReceipt(receiptPath, { fs: fsOverride } = {}) {
  const fsAdapter = fsOverride || defaultFsAdapter();
  const resolvedPath = path.resolve(receiptPath);
  let stats;
  try {
    stats = await fsAdapter.lstat(resolvedPath);
  } catch (err) {
    throw new LifeLedgerRestoreError('receipt_missing', `Receipt not found at ${resolvedPath}: ${err.message}`);
  }
  if (!stats.isFile()) {
    throw new LifeLedgerRestoreError('receipt_not_a_plain_file', `Receipt path is not a plain file (symlink/reparse point or directory): ${resolvedPath}`);
  }
  const raw = await fsAdapter.readFile(resolvedPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LifeLedgerRestoreError('receipt_unparseable', `Receipt is not valid JSON: ${err.message}`);
  }
  if (parsed.kind !== 'obsidian-rollback-receipt') {
    throw new LifeLedgerRestoreError('receipt_wrong_kind', `Not a rollback receipt (kind: ${parsed.kind})`);
  }
  if (parsed.schemaVersion !== OBSIDIAN_SYNC_SCHEMA_VERSION) {
    throw new LifeLedgerRestoreError('receipt_schema_mismatch', `Receipt schemaVersion ${parsed.schemaVersion} != expected ${OBSIDIAN_SYNC_SCHEMA_VERSION}`);
  }
  for (const field of ['canonicalVaultRoot', 'canonicalManagedRoot', 'managedRoot', 'planFingerprint']) {
    if (typeof parsed[field] !== 'string' || !parsed[field]) {
      throw new LifeLedgerRestoreError('receipt_malformed', `Receipt is missing required field: ${field}`);
    }
  }
  if (typeof parsed.managedRootExistedBefore !== 'boolean') {
    throw new LifeLedgerRestoreError('receipt_malformed', 'Receipt is missing required field: managedRootExistedBefore');
  }
  // Note on "cryptographically verified": the receipt file on disk (as written by
  // prepareObsidianRollbackArtifact) does NOT carry a persisted self-hash of its own bytes — that
  // hash is computed once, in-memory, at creation time, for that same process's immediate
  // self-check (see verifyObsidianRollbackReceipt). What IS persisted, and what this tool
  // actually re-verifies cryptographically in verifyRestoreReceipt() below, are the per-file
  // sha256 values and their aggregate backupManifestSha256 inside receipt.backup — reproduced
  // fresh from the backup artifact's bytes on disk right now, not merely trusted from the JSON.
  return { receipt: { ...parsed, receiptPath: resolvedPath }, receiptPath: resolvedPath, raw };
}

// ---------------------------------------------------------------------------
// 2. Verify: current managed ownership independently re-checked, receipt bound to the exact
//    vault/root, backup bytes reproduce their recorded hashes.
// ---------------------------------------------------------------------------

export async function verifyRestoreReceipt(receipt, { vault, expectedVault, mode = 'production', fs: fsOverride } = {}) {
  const fsAdapter = fsOverride || defaultFsAdapter();
  if (!vault) throw new LifeLedgerRestoreError('invalid_option', 'vault is required');

  const target = createObsidianSyncTarget({ vaultPath: vault, mode, allowApply: false });
  // planObsidianSync with zero events is a purely read-only identity + ownership inspection —
  // the same code path the worker already dry-runs on every cycle. Its per-file operations
  // (which would reflect an empty event set) are never consulted below.
  const plan = await planObsidianSync(target, [], { fs: fsAdapter, expectedCanonicalVaultPath: expectedVault || vault });

  if (plan.blockState === 'identity') {
    return { ok: false, stage: 'vault_identity', reason: plan.blockReason };
  }
  if (plan.isFirstRun) {
    return { ok: false, stage: 'ownership', reason: 'managed_root_currently_absent' };
  }
  if (plan.blockState === 'unmanaged_conflict' || plan.blockState === 'invalid_sentinel') {
    return { ok: false, stage: 'ownership', reason: plan.blockReason };
  }

  if (plan.canonicalVaultRoot !== receipt.canonicalVaultRoot || plan.canonicalManagedRoot !== receipt.canonicalManagedRoot || target.managedRoot !== receipt.managedRoot) {
    return { ok: false, stage: 'vault_binding', reason: 'receipt_not_bound_to_this_exact_vault_or_root' };
  }

  if (receipt.managedRootExistedBefore === false) {
    return { ok: false, stage: 'scope', reason: 'first_run_receipt_unsupported_by_restore_tool' };
  }

  if (!receipt.backup || !Array.isArray(receipt.backup.files) || typeof receipt.backup.backupArtifactPath !== 'string') {
    return { ok: false, stage: 'backup_payload', reason: 'receipt_missing_backup_payload' };
  }

  const mismatches = [];
  const reread = [];
  for (const fileEntry of receipt.backup.files) {
    const srcPath = path.join(receipt.backup.backupArtifactPath, ...fileEntry.relativePath.split('/'));
    let content;
    try {
      content = await fsAdapter.readFile(srcPath, 'utf8');
    } catch (err) {
      mismatches.push({ relativePath: fileEntry.relativePath, reason: `backup_file_unreadable: ${err.message}` });
      continue;
    }
    const actualSha256 = sha256(content);
    if (actualSha256 !== fileEntry.sha256) {
      mismatches.push({ relativePath: fileEntry.relativePath, reason: 'backup_file_hash_mismatch' });
    }
    reread.push({ relativePath: fileEntry.relativePath, sha256: actualSha256 });
  }
  if (mismatches.length) {
    return { ok: false, stage: 'backup_integrity', reason: 'backup_files_do_not_reproduce_recorded_hashes', mismatches };
  }
  const aggregateSha256 = sha256(JSON.stringify(reread));
  if (aggregateSha256 !== receipt.backup.backupManifestSha256) {
    return { ok: false, stage: 'backup_integrity', reason: 'backup_manifest_aggregate_hash_mismatch' };
  }

  return { ok: true, target, plan, canonicalVaultRoot: plan.canonicalVaultRoot, canonicalManagedRoot: plan.canonicalManagedRoot };
}

// ---------------------------------------------------------------------------
// 3. Preview: file-by-file diff between the verified backup and the current vault state.
//    Read-only. Lists every change a restore would make, and every current file it would NOT
//    touch.
// ---------------------------------------------------------------------------

export async function previewRestore(receipt, { vault, fs: fsOverride } = {}) {
  const fsAdapter = fsOverride || defaultFsAdapter();
  const backedUpPaths = new Set(receipt.backup.files.map(f => f.relativePath));
  const entries = [];
  for (const fileEntry of receipt.backup.files) {
    let destination;
    try {
      destination = await resolveObsidianLifeLedgerPath(vault, fileEntry.relativePath, { fs: fsAdapter });
    } catch (err) {
      entries.push({ relativePath: fileEntry.relativePath, action: 'unsafe_destination', reason: err.message });
      continue;
    }
    const current = await readTextIfExists(fsAdapter, destination.destinationPath);
    if (current === null) {
      entries.push({ relativePath: fileEntry.relativePath, action: 'restore_create', destinationPath: destination.destinationPath });
    } else if (sha256(current) === fileEntry.sha256) {
      entries.push({ relativePath: fileEntry.relativePath, action: 'noop_already_matches', destinationPath: destination.destinationPath });
    } else {
      entries.push({ relativePath: fileEntry.relativePath, action: 'restore_overwrite', destinationPath: destination.destinationPath });
    }
  }

  // Informational only — files that exist under the managed root now but were not part of this
  // receipt's backup set (created/modified after the receipt was captured). Never written to,
  // never deleted, listed purely so a human can decide whether to act on them separately.
  const extraCurrentFiles = [];
  const managedRoot = path.join(receipt.canonicalVaultRoot, OBSIDIAN_LIFE_LEDGER_MANAGED_DIR);
  async function walk(absDir, relDir) {
    let dirEntries;
    try {
      dirEntries = await fsAdapter.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const dirent of dirEntries) {
      if (dirent.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      const abs = path.join(absDir, dirent.name);
      if (dirent.isDirectory()) { await walk(abs, rel); continue; }
      const relativePath = `${OBSIDIAN_LIFE_LEDGER_MANAGED_DIR}/${rel}`;
      if (!backedUpPaths.has(relativePath)) extraCurrentFiles.push(relativePath);
    }
  }
  await walk(managedRoot, '');

  const summary = {
    toCreate: entries.filter(e => e.action === 'restore_create').length,
    toOverwrite: entries.filter(e => e.action === 'restore_overwrite').length,
    alreadyMatching: entries.filter(e => e.action === 'noop_already_matches').length,
    unsafe: entries.filter(e => e.action === 'unsafe_destination').length,
    extraCurrentFilesNotRestored: extraCurrentFiles.length
  };
  return { entries, extraCurrentFiles, summary };
}

// ---------------------------------------------------------------------------
// 4. Explicit apply: write-only restore of the files a completed preview identified as
//    restore_create/restore_overwrite. Preserves the CURRENT bytes of anything about to be
//    overwritten before touching it. Two-phase: resolves + re-verifies every file first; if any
//    single file fails, the whole restore aborts with zero writes.
// ---------------------------------------------------------------------------

function newRestoreRunId(clock) {
  return `restore-${new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function applyRestore(receipt, preview, { vault, backupsRoot, fs: fsOverride, clock } = {}) {
  const fsAdapter = fsOverride || defaultFsAdapter();
  if (!backupsRoot) throw new LifeLedgerRestoreError('invalid_option', 'backupsRoot is required (to preserve pre-restore evidence)');
  const toWrite = preview.entries.filter(e => e.action === 'restore_create' || e.action === 'restore_overwrite');
  if (preview.entries.some(e => e.action === 'unsafe_destination')) {
    throw new LifeLedgerRestoreError('unsafe_entries_present', 'Refusing to restore: at least one file resolved to an unsafe destination — resolve manually.');
  }

  const restoreRunId = newRestoreRunId(clock);
  const evidenceDir = path.join(path.resolve(backupsRoot), 'restore-evidence', restoreRunId);

  // Phase A: resolve every destination and re-verify the backup source bytes one more time
  // before touching anything (defense against a TOCTOU change between preview and apply).
  const resolved = [];
  const byRelativePath = new Map(receipt.backup.files.map(f => [f.relativePath, f]));
  for (const entry of toWrite) {
    const fileEntry = byRelativePath.get(entry.relativePath);
    const srcPath = path.join(receipt.backup.backupArtifactPath, ...entry.relativePath.split('/'));
    let content;
    try {
      content = await fsAdapter.readFile(srcPath, 'utf8');
    } catch (err) {
      throw new LifeLedgerRestoreError('backup_source_unreadable', `Cannot re-read backup source for ${entry.relativePath}: ${err.message}`);
    }
    if (sha256(content) !== fileEntry.sha256) {
      throw new LifeLedgerRestoreError('backup_source_changed', `Backup source for ${entry.relativePath} no longer matches its recorded hash — aborting before any write.`);
    }
    const destination = await resolveObsidianLifeLedgerPath(vault, entry.relativePath, { fs: fsAdapter });
    resolved.push({ relativePath: entry.relativePath, destinationPath: destination.destinationPath, content, action: entry.action });
  }

  // Phase B: preserve evidence of current bytes for anything about to be overwritten, THEN write.
  const written = [];
  for (const item of resolved) {
    if (item.action === 'restore_overwrite') {
      const currentContent = await readTextIfExists(fsAdapter, item.destinationPath);
      if (currentContent !== null) {
        const evidencePath = path.join(evidenceDir, ...item.relativePath.split('/'));
        await fsAdapter.mkdir(path.dirname(evidencePath), { recursive: true });
        await fsAdapter.writeFile(evidencePath, currentContent, 'utf8');
      }
    }
    await writeFileAtomically(fsAdapter, item.destinationPath, item.content);
    written.push({ relativePath: item.relativePath, action: item.action });
  }

  return {
    restoreRunId,
    evidenceDir: written.some(w => w.action === 'restore_overwrite') ? evidenceDir : null,
    written,
    skipped: preview.entries.filter(e => e.action === 'noop_already_matches').map(e => e.relativePath),
    notTouched: preview.extraCurrentFiles
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage:',
    '  node scripts/life-ledger-sync-restore.mjs --receipt <path> --vault <path> [options]',
    '',
    'Inspects, verifies, and previews a restore from a Phase 9/10 rollback receipt. Write-only:',
    'restores the exact files the receipt backed up back to their exact backed-up bytes. Never',
    'deletes anything. Without --apply-restore this is preview-only — nothing is written.',
    '',
    'Options:',
    '  --receipt <path>        path to obsidian-rollback-receipt.json (required)',
    '  --vault <path>          vault root to restore into (required)',
    '  --expected-vault <path> production identity guard (defaults to --vault)',
    '  --backups-root <path>   required with --apply-restore, to hold pre-restore evidence copies',
    '  --apply-restore         actually write. Without it, this only inspects/verifies/previews.',
    '  --json                  print machine-readable output',
    '  --help                  show this message'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { applyRestore: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new LifeLedgerRestoreError('missing_value', `Missing value after ${arg}`);
      i++;
      return value;
    };
    if (arg === '--receipt') options.receiptPath = takeValue();
    else if (arg === '--vault') options.vault = takeValue();
    else if (arg === '--expected-vault') options.expectedVault = takeValue();
    else if (arg === '--backups-root') options.backupsRoot = takeValue();
    else if (arg === '--apply-restore') options.applyRestore = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new LifeLedgerRestoreError('unknown_arg', `Unknown argument: ${arg}`);
  }
  return options;
}

export async function runLifeLedgerRestoreCli(argv) {
  const options = parseArgs(argv);
  if (options.help) return { help: true, text: usage() };
  if (!options.receiptPath || !options.vault) {
    throw new LifeLedgerRestoreError('missing_required', '--receipt and --vault are both required');
  }
  const { receipt } = await loadRestoreReceipt(options.receiptPath);
  const verification = await verifyRestoreReceipt(receipt, { vault: options.vault, expectedVault: options.expectedVault });
  if (!verification.ok) return { verification, preview: null, applied: null };
  const preview = await previewRestore(receipt, { vault: options.vault });
  if (!options.applyRestore) return { verification, preview, applied: null };
  if (!options.backupsRoot) throw new LifeLedgerRestoreError('missing_required', '--backups-root is required with --apply-restore');
  const applied = await applyRestore(receipt, preview, { vault: options.vault, backupsRoot: options.backupsRoot });
  return { verification, preview, applied };
}

async function main() {
  try {
    const outcome = await runLifeLedgerRestoreCli(process.argv.slice(2));
    if (outcome.help) { console.log(outcome.text); return; }
    if (!outcome.verification.ok) {
      console.error(`Restore refused at stage "${outcome.verification.stage}": ${outcome.verification.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ verification: { ok: true }, preview: outcome.preview.summary, applied: outcome.applied }, null, 2));
    if (!outcome.applied) {
      console.log(`\nPreview only. ${outcome.preview.summary.toCreate} file(s) would be created, ${outcome.preview.summary.toOverwrite} overwritten. Pass --apply-restore --backups-root <path> to actually write.`);
    }
  } catch (err) {
    console.error(`Life Ledger sync restore failed: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
