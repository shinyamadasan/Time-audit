import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLifeLedgerSnapshotJson } from '../life-ledger-transport.js';
import { buildObsidianLifeLedgerExport } from '../obsidian-life-ledger-renderer.js';
import { resolveObsidianLifeLedgerPath, writeObsidianLifeLedgerExport } from '../obsidian-life-ledger-writer.js';

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export class LifeLedgerCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LifeLedgerCliError';
    this.code = code;
  }
}

function usage() {
  return [
    'Usage:',
    '  node scripts/export-life-ledger-to-obsidian.mjs --input <snapshot.json> --vault <vault-root> [--dry-run|--apply]',
    '',
    'Default mode is --dry-run. --apply requires TEST-VAULT.md at the vault root.'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { dryRun: true, apply: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--input') {
      if (seen.has('input')) throw new LifeLedgerCliError('duplicate_input', 'Duplicate --input argument');
      seen.add('input');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new LifeLedgerCliError('missing_input_value', 'Missing value after --input');
      options.input = value;
      index++;
    } else if (arg === '--vault') {
      if (seen.has('vault')) throw new LifeLedgerCliError('duplicate_vault', 'Duplicate --vault argument');
      seen.add('vault');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new LifeLedgerCliError('missing_vault_value', 'Missing value after --vault');
      options.vault = value;
      index++;
    } else if (arg === '--dry-run') {
      if (seen.has('dry-run')) throw new LifeLedgerCliError('duplicate_dry_run', 'Duplicate --dry-run argument');
      if (seen.has('apply')) throw new LifeLedgerCliError('conflicting_mode', '--dry-run cannot be combined with --apply');
      seen.add('dry-run');
      options.dryRun = true;
      options.apply = false;
    } else if (arg === '--apply') {
      if (seen.has('apply')) throw new LifeLedgerCliError('duplicate_apply', 'Duplicate --apply argument');
      if (seen.has('dry-run')) throw new LifeLedgerCliError('conflicting_mode', '--apply cannot be combined with --dry-run');
      seen.add('apply');
      options.apply = true;
      options.dryRun = false;
    } else if (arg === '--help' || arg === '-h') {
      if (seen.has('help')) throw new LifeLedgerCliError('duplicate_help', 'Duplicate help argument');
      seen.add('help');
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new LifeLedgerCliError('unknown_arg', `Unknown argument: ${arg}`);
    } else {
      throw new LifeLedgerCliError('unexpected_position', `Unexpected positional argument: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!options.input) throw new LifeLedgerCliError('missing_input', 'Missing --input snapshot path');
  if (!options.vault) throw new LifeLedgerCliError('missing_vault', 'Missing --vault root');
  return options;
}

async function readSnapshotFile(inputPath, fsAdapter = fs) {
  const stats = await fsAdapter.stat(inputPath);
  if (stats.size > MAX_SNAPSHOT_BYTES) {
    throw new LifeLedgerCliError('snapshot_too_large', `Snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  }
  return fsAdapter.readFile(inputPath, 'utf8');
}

function isMarkerLinkOrReparse(stats) {
  return stats.isSymbolicLink?.() === true || ((stats.mode || 0) & 0x400) === 0x400;
}

function sameResolvedPath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function getTestVaultMarkerAuthorization(vaultRoot, fsAdapter = fs) {
  const markerPath = path.join(vaultRoot, 'TEST-VAULT.md');
  try {
    const stats = await fsAdapter.lstat(markerPath);
    if (isMarkerLinkOrReparse(stats) || stats.isFile?.() !== true) {
      return { ok: false, reason: 'invalid_marker_type' };
    }
    if (typeof fsAdapter.realpath === 'function') {
      const canonicalMarker = await fsAdapter.realpath(markerPath);
      if (!sameResolvedPath(canonicalMarker, markerPath)) {
        return { ok: false, reason: 'marker_resolves_elsewhere' };
      }
    }
    return { ok: true, markerPath: path.resolve(markerPath) };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: 'missing_marker' };
    throw err;
  }
}

async function assertTestVaultMarkerAuthorized(vaultRoot, fsAdapter = fs) {
  const authorization = await getTestVaultMarkerAuthorization(vaultRoot, fsAdapter);
  if (!authorization.ok) {
    throw new LifeLedgerCliError('apply_not_authorized', 'Apply requires a real TEST-VAULT.md file at the vault root');
  }
  return authorization;
}

function summarize(result, exportPlan, eventCount, applyAuthorized) {
  return {
    valid: true,
    events: eventCount,
    applyAuthorized,
    plannedPaths: exportPlan.files.map(file => file.relativePath),
    written: result.written.length,
    skipped: result.skipped.length,
    deleted: result.deleted.length,
    conflicts: result.conflicts.length,
    dryRun: result.dryRun,
    result
  };
}

function formatSummary(summary) {
  return [
    'Life Ledger snapshot valid',
    `Events: ${summary.events}`,
    `Apply authorized: ${summary.applyAuthorized ? 'yes' : 'no'}`,
    summary.dryRun ? `Would write: ${summary.written}` : `Written: ${summary.written}`,
    summary.dryRun ? `Would skip identical: ${summary.skipped}` : `Skipped identical: ${summary.skipped}`,
    summary.dryRun ? `Would delete stale generated: ${summary.deleted}` : `Deleted stale generated: ${summary.deleted}`,
    `Conflicts: ${summary.conflicts}`,
    `Paths: ${summary.plannedPaths.join(', ') || '(none)'}`
  ].join('\n');
}

export async function runLifeLedgerObsidianExport(argv, options = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { help: true, text: usage() };

  const fsAdapter = options.fs || fs;
  const buildExportPlan = options.buildExportPlan || buildObsidianLifeLedgerExport;
  const resolvePath = options.resolvePath || resolveObsidianLifeLedgerPath;
  const writeExport = options.writeExport || writeObsidianLifeLedgerExport;
  const raw = await readSnapshotFile(parsed.input, fsAdapter);
  const snapshot = parseLifeLedgerSnapshotJson(raw);
  let applyAuthorized = false;
  if (parsed.apply) {
    await assertTestVaultMarkerAuthorized(parsed.vault, fsAdapter);
    applyAuthorized = true;
  } else {
    applyAuthorized = (await getTestVaultMarkerAuthorization(parsed.vault, fsAdapter)).ok;
  }

  const exportPlan = buildExportPlan(snapshot.events);

  await Promise.all(exportPlan.files.map(file => resolvePath(parsed.vault, file.relativePath, { fs: fsAdapter })));

  const result = await writeExport(exportPlan.files, {
    vaultRoot: parsed.vault,
    dryRun: !parsed.apply,
    fs: fsAdapter
  });
  return summarize(result, exportPlan, snapshot.events.length, applyAuthorized);
}

async function main() {
  try {
    const summary = await runLifeLedgerObsidianExport(process.argv.slice(2));
    console.log(summary.text || formatSummary(summary));
  } catch (err) {
    console.error(`Life Ledger export failed: ${err.message}`);
    if (err.errors) console.error(err.errors.join('\n'));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
