import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseLifeLedgerSnapshotJson } from '../life-ledger-transport.js';
import {
  createObsidianSyncTarget,
  planObsidianSync,
  applyObsidianSync,
  formatObsidianSyncPreview
} from '../obsidian-life-ledger-sync.js';

// Phase 9 production-capable CLI. This is deliberately a NEW entry point alongside the
// existing scripts/export-life-ledger-to-obsidian.mjs (left untouched) rather than a
// replacement — that script's own reviewed test-vault-only contract stays exactly as-is.
// This one can target a production vault, but every production apply is gated behind
// --mode production, --apply, an exact --expected-vault canonical-path match, a verified
// --rollback-receipt, and (on the very first run) --first-run-ack — AND the build-level
// OBSIDIAN_PRODUCTION_SYNC_ENABLED constant, which is false. No default supplies any of these.

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export class LifeLedgerSyncCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LifeLedgerSyncCliError';
    this.code = code;
  }
}

function usage() {
  return [
    'Usage:',
    '  node scripts/sync-life-ledger-to-obsidian.mjs --input <snapshot.json> --vault <vault-root> --mode test|production [options]',
    '',
    'Always plans first; prints a preview; never writes without --apply.',
    '',
    'Options:',
    '  --input <path>            Life Ledger snapshot JSON (required)',
    '  --vault <path>            vault root to plan/sync against (required)',
    '  --mode test|production    required — there is no default mode',
    '  --apply                   execute the plan (otherwise: plan + preview only, zero writes)',
    '  --expected-vault <path>   production only: must exactly canonicalize to --vault',
    '  --first-run-ack <token>   production only, first run only: "FIRST-RUN-CONFIRMED:<canonical-vault-path>"',
    '  --rollback-receipt <path> production only: JSON receipt from prepareObsidianRollbackArtifact()',
    '  --json                    print the machine-readable summary instead of the text preview',
    '',
    'NOTE: production apply is hard-disabled in this build and will refuse regardless of flags.'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { apply: false, json: false };
  const seen = new Set();
  const takeValue = (name, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new LifeLedgerSyncCliError('missing_value', `Missing value after --${name}`);
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--input') {
      if (seen.has('input')) throw new LifeLedgerSyncCliError('duplicate_input', 'Duplicate --input');
      seen.add('input'); options.input = takeValue('input', index); index++;
    } else if (arg === '--vault') {
      if (seen.has('vault')) throw new LifeLedgerSyncCliError('duplicate_vault', 'Duplicate --vault');
      seen.add('vault'); options.vault = takeValue('vault', index); index++;
    } else if (arg === '--mode') {
      if (seen.has('mode')) throw new LifeLedgerSyncCliError('duplicate_mode', 'Duplicate --mode');
      seen.add('mode'); options.mode = takeValue('mode', index); index++;
    } else if (arg === '--expected-vault') {
      if (seen.has('expected-vault')) throw new LifeLedgerSyncCliError('duplicate_expected_vault', 'Duplicate --expected-vault');
      seen.add('expected-vault'); options.expectedVault = takeValue('expected-vault', index); index++;
    } else if (arg === '--first-run-ack') {
      if (seen.has('first-run-ack')) throw new LifeLedgerSyncCliError('duplicate_first_run_ack', 'Duplicate --first-run-ack');
      seen.add('first-run-ack'); options.firstRunAck = takeValue('first-run-ack', index); index++;
    } else if (arg === '--rollback-receipt') {
      if (seen.has('rollback-receipt')) throw new LifeLedgerSyncCliError('duplicate_rollback_receipt', 'Duplicate --rollback-receipt');
      seen.add('rollback-receipt'); options.rollbackReceiptPath = takeValue('rollback-receipt', index); index++;
    } else if (arg === '--apply') {
      if (seen.has('apply')) throw new LifeLedgerSyncCliError('duplicate_apply', 'Duplicate --apply');
      seen.add('apply'); options.apply = true;
    } else if (arg === '--json') {
      if (seen.has('json')) throw new LifeLedgerSyncCliError('duplicate_json', 'Duplicate --json');
      seen.add('json'); options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new LifeLedgerSyncCliError('unknown_arg', `Unknown argument: ${arg}`);
    } else {
      throw new LifeLedgerSyncCliError('unexpected_position', `Unexpected positional argument: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!options.input) throw new LifeLedgerSyncCliError('missing_input', 'Missing --input snapshot path');
  if (!options.vault) throw new LifeLedgerSyncCliError('missing_vault', 'Missing --vault root');
  if (options.mode !== 'test' && options.mode !== 'production') {
    throw new LifeLedgerSyncCliError('missing_mode', 'Missing or invalid --mode (must be exactly "test" or "production")');
  }
  return options;
}

async function readSnapshotFile(inputPath, fsAdapter) {
  const stats = await fsAdapter.stat(inputPath);
  if (stats.size > MAX_SNAPSHOT_BYTES) throw new LifeLedgerSyncCliError('snapshot_too_large', `Snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  return fsAdapter.readFile(inputPath, 'utf8');
}

// Safe rollback-receipt loading for CLI activation. The persisted receipt intentionally does
// NOT carry `receiptPath` / `receiptSha256`, but verifyObsidianRollbackReceipt() needs both as
// runtime metadata. This resolves the supplied path, reads the exact bytes off disk, parses
// them, and attaches ONLY those two runtime-only fields to the in-memory object. The SHA-256 is
// always computed from the live disk bytes — a hash is never accepted from the caller — and the
// enriched object is never written back to disk. Every failure is fail-closed.
export async function loadRollbackReceiptFromDisk(receiptPathArg, fsAdapter) {
  const resolvedReceiptPath = path.resolve(receiptPathArg);
  let bytes;
  try {
    bytes = await fsAdapter.readFile(resolvedReceiptPath); // Buffer — exact on-disk bytes
  } catch (err) {
    throw new LifeLedgerSyncCliError('rollback_receipt_unreadable', `Cannot read --rollback-receipt at ${resolvedReceiptPath}: ${err.message}`);
  }
  const receiptSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new LifeLedgerSyncCliError('rollback_receipt_invalid_json', `--rollback-receipt is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LifeLedgerSyncCliError('rollback_receipt_malformed', '--rollback-receipt must be a JSON object');
  }
  return { ...parsed, receiptPath: resolvedReceiptPath, receiptSha256 };
}

function summarize(plan, applyResult) {
  return {
    schemaVersion: plan.schemaVersion,
    mode: plan.mode,
    blocked: plan.blocked,
    blockState: plan.blockState,
    blockReason: plan.blockReason,
    isFirstRun: plan.isFirstRun,
    planFingerprint: plan.planFingerprint,
    operations: plan.operations.map(op => ({ relativePath: op.relativePath, op: op.op, reason: op.reason })),
    applied: applyResult ? applyResult.applied : false,
    written: applyResult ? applyResult.written : []
  };
}

export async function runLifeLedgerObsidianSync(argv, options = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { help: true, text: usage() };

  const fsAdapter = options.fs || fs;
  const raw = await readSnapshotFile(parsed.input, fsAdapter);
  const snapshot = parseLifeLedgerSnapshotJson(raw);

  const target = createObsidianSyncTarget({
    vaultPath: parsed.vault,
    mode: parsed.mode,
    allowApply: parsed.apply === true
  });

  const planOptions = { fs: fsAdapter };
  if (parsed.mode === 'production') planOptions.expectedCanonicalVaultPath = parsed.expectedVault;
  const plan = await planObsidianSync(target, snapshot.events, planOptions);

  let applyResult = null;
  if (parsed.apply) {
    let authorization;
    if (parsed.mode === 'production') {
      let rollbackReceipt;
      if (parsed.rollbackReceiptPath) {
        rollbackReceipt = await loadRollbackReceiptFromDisk(parsed.rollbackReceiptPath, fsAdapter);
      }
      authorization = { mode: 'production', allowApply: true, apply: true, expectedCanonicalVaultPath: parsed.expectedVault, firstRunAck: parsed.firstRunAck, rollbackReceipt };
    } else {
      authorization = { mode: 'test', apply: true };
    }
    applyResult = await applyObsidianSync(plan, authorization, { fs: fsAdapter });
  }

  return { plan, applyResult, summary: summarize(plan, applyResult), json: parsed.json };
}

async function main() {
  try {
    const result = await runLifeLedgerObsidianSync(process.argv.slice(2));
    if (result.help) { console.log(result.text); return; }
    if (result.json) {
      console.log(JSON.stringify(result.summary, null, 2));
    } else {
      console.log(formatObsidianSyncPreview(result.plan));
      if (result.applyResult) console.log(`\nApplied. Written: ${result.applyResult.written.length}`);
      else console.log('\nDry run only — no files were written. Pass --apply to execute this plan.');
    }
  } catch (err) {
    console.error(`Life Ledger Obsidian sync failed: ${err.message}`);
    if (err.errors) console.error(err.errors.join('\n'));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
