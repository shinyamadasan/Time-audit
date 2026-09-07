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
// everything a rollback receipt saw": it only ever WRITES files a verified receipt backed up,
// and only when it can do so WITHOUT ambiguity (see Review Finding 2 below). It never deletes
// anything. A delete-capable restore would materially expand this tool's blast radius for a
// benefit this system doesn't currently need — see the Phase 11 docs for that scoping decision.
//
// Every write is confined to the vault's managed `Life Ledger/` subtree via the same
// resolveObsidianLifeLedgerPath() reparse/leaf/traversal safety used by the reviewed Phase 9/10
// write path — so `.git`, `.obsidian`, `.rag`, and anything else outside `Life Ledger/` are
// structurally unreachable here, not just policy-excluded.
//
// --- Review Finding 2 (Phase 11 fix pass) — automated overwrite is NEVER safe here ---
//
// A receipt's `backup` only ever records PRE-incident bytes. When a currently-existing file's
// bytes differ from that pre-incident backup, this system has NO durable evidence of what the
// EXPECTED post-incident bytes should be: `applyObsidianSync`'s partial-failure evidence
// (`written[]` / `failedRelativePath`) records only relative PATHS, never the target content or
// its hash, and that in-memory plan is gone the moment the failed process exits — nothing durable
// persists it. So `currentHash != preIncidentBackupHash` can mean EITHER "this is what the failed
// apply wrote" OR "a human edited this file after the failure" OR something else entirely, and
// there is no way to tell those apart from evidence this system actually keeps. Inventing a
// comparison against a hash we don't have would be trust theater, not verification.
//
// This tool therefore takes the conservative design the review explicitly prefers: it NEVER
// automatically overwrites an existing file whose current bytes differ from the pre-incident
// backup. Such a file is reported as `ambiguous_current_state` with full diagnostic evidence
// (current hash, pre-incident hash, exact backup source) and left completely untouched — apply
// refuses to touch it, full stop. The only automated writes this tool performs are: (a) recreating
// a file that is CURRENTLY MISSING but was backed up (nothing existing is destroyed by that), and
// (b) true no-ops (current already matches). See REQUIRED CREATE-FAILURE / RESIDUAL FILE handling
// below for the companion Finding 3 fix.
//
// --- Review Finding 3 (Phase 11 fix pass) — residual CREATE-before-failure files ---
//
// A file newly CREATED by the same apply that later failed is, by construction, absent from that
// apply's own PRE-incident backup (there was nothing to back up — it didn't exist yet). Write-only
// restore cannot remove such a residual (removal is out of scope by design — see above), so this
// tool never silently reports "restored" when one is present. Any file that exists under the
// managed root now but is not part of the receipt's backup set is classified `residual_file` and
// forces the overall result to `manual_review_required` — restore explicitly states the exact
// pre-incident state was NOT achieved, names every residual path, and never claims full success.

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
  // Review Finding 5 (Phase 11 fix pass) — exact trust semantics for `planFingerprint`: it is
  // validated HERE only as present, non-empty shape. It is NEVER compared against a freshly
  // re-derived plan anywhere in this module. Doing that legitimately would require the exact
  // original outbox snapshot bytes the failed plan was built from — those are not guaranteed to
  // still exist (the outbox is a mutable mirror the browser can overwrite with newer events at
  // any time) — so this tool does not claim or attempt that binding. `planFingerprint` is carried
  // through purely as informational provenance (which run produced this receipt), not as a
  // verified "this receipt matches the exact current plan" guarantee. The bindings this tool
  // ACTUALLY verifies, in verifyRestoreReceipt() below, are: (1) vault/root identity — an
  // independent, live re-check that the current vault is owned and matches the receipt's exact
  // recorded canonical paths — and (2) backup CONTENT INTEGRITY — every backed-up file's bytes on
  // disk right now still reproduce their recorded per-file sha256 and the aggregate
  // backupManifestSha256. Integrity is not authentication: reproducing a hash proves the backup
  // bytes have not silently changed since they were written, NOT who wrote the receipt or that no
  // one could have regenerated a self-consistent but wrong one — this system has no adversarial
  // threat model (single-user local desktop automation) and does not claim one.
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

// Overall completeness classification — a human must be able to answer "did this tool actually
// return my Life Ledger to the exact pre-incident state?" with certainty from this one field.
//   'noop'                   — every backed-up file already matches; nothing to do; no residuals.
//   'exact_restore_possible' — every difference is a safe create (nothing existing at risk) and
//                               there are no residual/ambiguous files; applying WOULD achieve the
//                               exact pre-incident state.
//   'manual_review_required' — at least one ambiguous-overwrite or residual-created file exists;
//                               restore can proceed for the independently-safe subset ONLY, and
//                               the exact pre-incident state will NOT be achieved automatically.
export const RESTORE_COMPLETENESS = Object.freeze(['noop', 'exact_restore_possible', 'manual_review_required']);

function classifyCompleteness(entries, residualFiles) {
  const hasAmbiguous = entries.some(e => e.action === 'ambiguous_current_state' || e.action === 'unsafe_destination');
  if (hasAmbiguous || residualFiles.length > 0) return 'manual_review_required';
  if (entries.some(e => e.action === 'restore_create')) return 'exact_restore_possible';
  return 'noop';
}

// ---------------------------------------------------------------------------
// 3. Preview: file-by-file diff between the verified backup and the current vault state.
//    Read-only. Lists every change a restore would make, every file it refuses to touch and why,
//    and every residual file that write-only restore cannot remove.
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
      // Nothing existing is at risk — recreating a missing, previously-owned file never destroys
      // data, so this remains a safe automated action.
      entries.push({ relativePath: fileEntry.relativePath, action: 'restore_create', destinationPath: destination.destinationPath });
      continue;
    }
    const currentSha256 = sha256(current);
    if (currentSha256 === fileEntry.sha256) {
      entries.push({ relativePath: fileEntry.relativePath, action: 'noop_already_matches', destinationPath: destination.destinationPath });
      continue;
    }
    // Review Finding 2 — current bytes differ from the pre-incident backup, and this system has
    // no durable evidence of what the EXPECTED post-incident bytes should be (see the module
    // header note). This can be a failed apply's partial write, a human edit made afterward, or
    // something else — indistinguishable from evidence this system actually keeps. Never
    // auto-overwrite; report full diagnostic detail for manual review instead.
    entries.push({
      relativePath: fileEntry.relativePath,
      action: 'ambiguous_current_state',
      destinationPath: destination.destinationPath,
      currentSha256,
      preIncidentBackupSha256: fileEntry.sha256,
      backupSourcePath: path.join(receipt.backup.backupArtifactPath, ...fileEntry.relativePath.split('/')),
      note: 'Current bytes differ from the pre-incident backup and cannot be proven to be the failed incident\'s bytes rather than a later human edit. Restore refuses to overwrite this file automatically — inspect it manually (diff against backupSourcePath) before deciding whether to restore it by hand.'
    });
  }

  // Review Finding 3 — files that exist under the managed root now but are NOT part of this
  // receipt's backup set. A file newly CREATED by the same apply that later failed is, by
  // construction, absent from that apply's own pre-incident backup (nothing existed to back up)
  // — this is the CREATE-before-failure residual case. Write-only restore cannot remove these
  // (removal is out of scope by design), so they are never silently treated as "handled": their
  // presence always forces the overall completeness to 'manual_review_required'.
  const residualFiles = [];
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
      if (!backedUpPaths.has(relativePath)) {
        residualFiles.push({
          relativePath,
          classification: 'residual_created_file',
          note: 'Present now but not part of this receipt\'s pre-incident backup (either created by the same apply that later failed, or by an unrelated later sync). Write-only restore cannot remove it — exact pre-incident state will NOT be achieved automatically. Review and remove manually if it should not be there.'
        });
      }
    }
  }
  await walk(managedRoot, '');

  const completeness = classifyCompleteness(entries, residualFiles);
  const summary = {
    toCreate: entries.filter(e => e.action === 'restore_create').length,
    ambiguous: entries.filter(e => e.action === 'ambiguous_current_state').length,
    alreadyMatching: entries.filter(e => e.action === 'noop_already_matches').length,
    unsafe: entries.filter(e => e.action === 'unsafe_destination').length,
    residualFiles: residualFiles.length,
    completeness
  };
  // extraCurrentFiles is kept (as plain relative paths) for backward-compatible callers alongside
  // the richer residualFiles list.
  return { entries, residualFiles, extraCurrentFiles: residualFiles.map(r => r.relativePath), completeness, summary };
}

// ---------------------------------------------------------------------------
// 4. Explicit apply: write-only restore of the files a completed preview identified as safe
//    (`restore_create` only — a missing, previously-owned file being recreated). Never
//    overwrites an existing file (Review Finding 2) and never claims full success when an
//    ambiguous or residual file is present (Review Finding 3). Two-phase: resolves + re-verifies
//    every file first; if any single safe file fails, the whole restore aborts with zero writes.
// ---------------------------------------------------------------------------

function newRestoreRunId(clock) {
  return `restore-${new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function applyRestore(receipt, preview, { vault, fs: fsOverride, clock } = {}) {
  const fsAdapter = fsOverride || defaultFsAdapter();
  if (preview.entries.some(e => e.action === 'unsafe_destination')) {
    throw new LifeLedgerRestoreError('unsafe_entries_present', 'Refusing to restore: at least one file resolved to an unsafe destination — resolve manually.');
  }
  const toCreate = preview.entries.filter(e => e.action === 'restore_create');
  const ambiguous = preview.entries.filter(e => e.action === 'ambiguous_current_state');

  const restoreRunId = newRestoreRunId(clock);

  // Phase A: resolve every destination and re-verify the backup source bytes one more time
  // before touching anything (defense against a TOCTOU change between preview and apply). Also
  // re-checks that the destination is STILL missing right now — if something now exists there
  // (e.g. a human created it in the gap between preview and apply), this is no longer a safe
  // "nothing existing is at risk" create: it is downgraded to ambiguous and left untouched,
  // exactly like any other ambiguous file, rather than silently overwriting it.
  const resolved = [];
  const newlyAmbiguous = [];
  const byRelativePath = new Map(receipt.backup.files.map(f => [f.relativePath, f]));
  for (const entry of toCreate) {
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
    const stillMissing = (await readTextIfExists(fsAdapter, destination.destinationPath)) === null;
    if (!stillMissing) {
      newlyAmbiguous.push({
        relativePath: entry.relativePath, action: 'ambiguous_current_state', destinationPath: destination.destinationPath,
        note: 'A file appeared at this previously-missing destination between preview and apply — treated as ambiguous, not overwritten.'
      });
      continue;
    }
    resolved.push({ relativePath: entry.relativePath, destinationPath: destination.destinationPath, content });
  }

  // Phase B: write only what is still confirmed safe.
  const written = [];
  for (const item of resolved) {
    await writeFileAtomically(fsAdapter, item.destinationPath, item.content);
    written.push({ relativePath: item.relativePath, action: 'restore_create' });
  }

  const allAmbiguous = ambiguous.concat(newlyAmbiguous);
  const completeness = (allAmbiguous.length > 0 || preview.residualFiles.length > 0)
    ? 'manual_review_required'
    : (written.length > 0 ? 'exact_restore_complete' : 'noop');

  return {
    restoreRunId,
    completeness,
    written,
    skipped: preview.entries.filter(e => e.action === 'noop_already_matches').map(e => e.relativePath),
    ambiguous: allAmbiguous,
    residualFiles: preview.residualFiles,
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
    'Inspects, verifies, and previews a restore from a Phase 9/10 rollback receipt. Write-only and',
    'conservative: only ever recreates a file that is currently MISSING but was backed up (nothing',
    'existing is ever overwritten or deleted — see the module header for why an automated',
    'overwrite is never safe). A file whose current bytes differ from the pre-incident backup is',
    'reported as ambiguous and left untouched for manual review; a file created by the same apply',
    'that later failed cannot be removed by this tool and is reported as a residual — either case',
    'forces the result to "manual_review_required" and this tool never claims full success when',
    'that happens. Without --apply-restore this is preview-only — nothing is written.',
    '',
    'Options:',
    '  --receipt <path>        path to obsidian-rollback-receipt.json (required)',
    '  --vault <path>          vault root to restore into (required)',
    '  --expected-vault <path> production identity guard (defaults to --vault)',
    '  --apply-restore         actually write the safe subset. Without it, this only',
    '                          inspects/verifies/previews.',
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
  const applied = await applyRestore(receipt, preview, { vault: options.vault });
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
    if (outcome.preview.completeness === 'manual_review_required') {
      console.log('\nMANUAL REVIEW REQUIRED — the exact pre-incident state cannot be achieved automatically:');
      for (const e of outcome.preview.entries.filter(x => x.action === 'ambiguous_current_state')) {
        console.log(`  AMBIGUOUS: ${e.relativePath}\n    current sha256:        ${e.currentSha256}\n    pre-incident sha256:   ${e.preIncidentBackupSha256}\n    backup source:         ${e.backupSourcePath}\n    ${e.note}`);
      }
      for (const r of outcome.preview.residualFiles) {
        console.log(`  RESIDUAL:  ${r.relativePath}\n    ${r.note}`);
      }
    }
    if (!outcome.applied) {
      console.log(`\nPreview only. ${outcome.preview.summary.toCreate} file(s) would be safely created. Pass --apply-restore to write them. Completeness if applied now: ${outcome.preview.completeness}.`);
    }
  } catch (err) {
    console.error(`Life Ledger sync restore failed: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
