import fs from 'node:fs/promises';
import path from 'node:path';
import { OBSIDIAN_LIFE_LEDGER_SENTINEL } from './obsidian-life-ledger-renderer.js';

export const OBSIDIAN_LIFE_LEDGER_MANAGED_DIR = 'Life Ledger';

const DAILY_FILE_RE = /^Life Ledger\/Daily\/\d{4}-\d{2}-\d{2}\.md$/;
const DENIED_VAULT_ROOTS = [
  'C:\\Users\\Admin\\OneDrive\\2nd Brain',
  'C:\\Users\\Admin\\Desktop\\2nd Brain'
];

export class ObsidianLifeLedgerWriterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ObsidianLifeLedgerWriterError';
    this.code = code;
    Object.assign(this, details);
  }
}

function slashPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function pathEqualsOrContains(parent, child) {
  const normalizedParent = path.resolve(parent);
  const normalizedChild = path.resolve(child);
  if (normalizedParent.toLowerCase() === normalizedChild.toLowerCase()) return true;
  const relative = path.relative(normalizedParent, normalizedChild);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isLinkStats(stats) {
  return stats.isSymbolicLink?.() === true || ((stats.mode || 0) & 0x400) === 0x400;
}

function defaultFsAdapter() {
  return {
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    unlink: fs.unlink,
    readdir: fs.readdir,
    lstat: fs.lstat,
    realpath: fs.realpath
  };
}

async function realPathOrResolved(fsAdapter, target) {
  try {
    return await fsAdapter.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function assertRelativePath(relativePath) {
  const raw = String(relativePath || '');
  const normalizedSlashes = slashPath(raw);
  if (!raw.trim()) throw new ObsidianLifeLedgerWriterError('invalid_path', 'Export path must be non-empty');
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\') || normalizedSlashes.startsWith('//')) {
    throw new ObsidianLifeLedgerWriterError('invalid_path', `Export path must be relative: ${raw}`);
  }
  const parts = normalizedSlashes.split('/');
  if (parts.some(part => part === '..')) {
    throw new ObsidianLifeLedgerWriterError('invalid_path', `Export path cannot contain traversal: ${raw}`);
  }
  const normalized = path.posix.normalize(normalizedSlashes);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new ObsidianLifeLedgerWriterError('invalid_path', `Export path escapes after normalization: ${raw}`);
  }
  if (normalized !== normalizedSlashes) {
    throw new ObsidianLifeLedgerWriterError('invalid_path', `Export path must already be normalized: ${raw}`);
  }
  if (!normalized.startsWith(`${OBSIDIAN_LIFE_LEDGER_MANAGED_DIR}/`)) {
    throw new ObsidianLifeLedgerWriterError('invalid_path', `Export path must stay under ${OBSIDIAN_LIFE_LEDGER_MANAGED_DIR}`);
  }
  return normalized;
}

async function assertNoLinkEscape(fsAdapter, canonicalVaultRoot, destinationPath) {
  const relative = path.relative(canonicalVaultRoot, destinationPath);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = canonicalVaultRoot;
  for (let index = 0; index < parts.length - 1; index++) {
    current = path.join(current, parts[index]);
    try {
      const stats = await fsAdapter.lstat(current);
      if (isLinkStats(stats)) {
        throw new ObsidianLifeLedgerWriterError('link_escape', `Export parent is a link or reparse point: ${current}`, { path: current });
      }
    } catch (err) {
      if (err instanceof ObsidianLifeLedgerWriterError) throw err;
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    const realCurrent = await realPathOrResolved(fsAdapter, current);
    if (!pathEqualsOrContains(canonicalVaultRoot, realCurrent)) {
      throw new ObsidianLifeLedgerWriterError('path_escape', `Export parent resolves outside managed vault: ${current}`, { path: current });
    }
  }
}

function assertNotDeniedVaultRoot(vaultRoot, candidatePath) {
  for (const denied of DENIED_VAULT_ROOTS) {
    if (pathEqualsOrContains(denied, candidatePath)) {
      throw new ObsidianLifeLedgerWriterError('denied_vault_root', `Life Ledger export refuses denied vault root: ${vaultRoot}`);
    }
  }
}

async function assertSafeExistingLeaf(fsAdapter, canonicalManagedRoot, destinationPath) {
  let stats;
  try {
    stats = await fsAdapter.lstat(destinationPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  if (isLinkStats(stats)) {
    throw new ObsidianLifeLedgerWriterError('link_escape', `Export target is a link or reparse point: ${destinationPath}`, { path: destinationPath });
  }
  const realDestination = await realPathOrResolved(fsAdapter, destinationPath);
  if (!pathEqualsOrContains(canonicalManagedRoot, realDestination)) {
    throw new ObsidianLifeLedgerWriterError('path_escape', `Export target resolves outside managed root: ${destinationPath}`, { path: destinationPath });
  }
}

async function canonicalizeVaultRoot(vaultRoot, fsAdapter) {
  const resolvedVaultRoot = path.resolve(String(vaultRoot || ''));
  assertNotDeniedVaultRoot(vaultRoot, resolvedVaultRoot);
  const canonicalVaultRoot = await fsAdapter.realpath(resolvedVaultRoot);
  for (const denied of DENIED_VAULT_ROOTS) {
    const deniedCanonical = await realPathOrResolved(fsAdapter, denied);
    if (pathEqualsOrContains(deniedCanonical, canonicalVaultRoot)) {
      throw new ObsidianLifeLedgerWriterError('denied_vault_root', `Life Ledger export refuses denied vault root: ${vaultRoot}`);
    }
  }
  const managedRoot = path.join(canonicalVaultRoot, OBSIDIAN_LIFE_LEDGER_MANAGED_DIR);
  const canonicalManagedRoot = await realPathOrResolved(fsAdapter, managedRoot);
  if (!pathEqualsOrContains(canonicalVaultRoot, canonicalManagedRoot)) {
    throw new ObsidianLifeLedgerWriterError('path_escape', 'Managed Life Ledger root resolves outside the vault');
  }
  await assertNoLinkEscape(fsAdapter, canonicalVaultRoot, managedRoot);
  return { canonicalVaultRoot, canonicalManagedRoot };
}

async function destinationFor(vaultRoot, relativePath, fsAdapter) {
  const normalizedRelative = assertRelativePath(relativePath);
  const { canonicalVaultRoot, canonicalManagedRoot } = await canonicalizeVaultRoot(vaultRoot, fsAdapter);
  const destinationPath = path.join(canonicalVaultRoot, ...normalizedRelative.split('/'));
  const resolvedDestination = path.resolve(destinationPath);
  if (!pathEqualsOrContains(canonicalManagedRoot, resolvedDestination)) {
    throw new ObsidianLifeLedgerWriterError('path_escape', `Export path resolves outside managed root: ${relativePath}`);
  }
  await assertNoLinkEscape(fsAdapter, canonicalVaultRoot, resolvedDestination);
  await assertSafeExistingLeaf(fsAdapter, canonicalManagedRoot, resolvedDestination);
  return { relativePath: normalizedRelative, destinationPath: resolvedDestination, canonicalManagedRoot };
}

async function readTextIfExists(fsAdapter, filePath) {
  try {
    return await fsAdapter.readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function listGeneratedDailyFiles(fsAdapter, canonicalManagedRoot) {
  const dailyRoot = path.join(canonicalManagedRoot, 'Daily');
  let entries;
  try {
    entries = await fsAdapter.readdir(dailyRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter(entry => /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
    .map(entry => ({
      relativePath: `Life Ledger/Daily/${entry.name}`,
      path: path.join(dailyRoot, entry.name)
    }));
}

async function writeFileAtomically(fsAdapter, destinationPath, content) {
  const dir = path.dirname(destinationPath);
  await fsAdapter.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(destinationPath)}.tmp`);
  try {
    await fsAdapter.writeFile(tempPath, content, 'utf8');
    await fsAdapter.rename(tempPath, destinationPath);
  } catch (err) {
    try {
      await fsAdapter.unlink(tempPath);
    } catch {
      // Best effort cleanup only; the final destination is not replaced until rename succeeds.
    }
    throw err;
  }
}

export async function resolveObsidianLifeLedgerPath(vaultRoot, relativePath, options = {}) {
  return destinationFor(vaultRoot, relativePath, options.fs || defaultFsAdapter());
}

export async function writeObsidianLifeLedgerExport(plan, options = {}) {
  const fsAdapter = options.fs || defaultFsAdapter();
  const vaultRoot = options.vaultRoot;
  const dryRun = options.dryRun === true;
  if (!Array.isArray(plan)) throw new ObsidianLifeLedgerWriterError('invalid_plan', 'Export plan must be an array of files');
  const results = { written: [], skipped: [], deleted: [], conflicts: [], dryRun };
  const expectedDailyPaths = new Set();
  let canonicalManagedRoot = null;

  for (const item of plan) {
    if (!item || typeof item.relativePath !== 'string' || typeof item.content !== 'string') {
      throw new ObsidianLifeLedgerWriterError('invalid_plan', 'Each export plan item must include relativePath and content');
    }
    const destination = await destinationFor(vaultRoot, item.relativePath, fsAdapter);
    canonicalManagedRoot = destination.canonicalManagedRoot;
    if (DAILY_FILE_RE.test(destination.relativePath)) expectedDailyPaths.add(destination.relativePath);
    const existing = await readTextIfExists(fsAdapter, destination.destinationPath);
    if (existing !== null && !existing.includes(OBSIDIAN_LIFE_LEDGER_SENTINEL)) {
      results.conflicts.push({ relativePath: destination.relativePath, path: destination.destinationPath, reason: 'missing_generated_sentinel' });
      continue;
    }
    if (existing === item.content) {
      results.skipped.push({ relativePath: destination.relativePath, path: destination.destinationPath, reason: 'byte_identical' });
      continue;
    }
    results.written.push({ relativePath: destination.relativePath, path: destination.destinationPath, action: existing === null ? 'create' : 'replace' });
    if (!dryRun) await writeFileAtomically(fsAdapter, destination.destinationPath, item.content);
  }

  if (!canonicalManagedRoot) {
    canonicalManagedRoot = (await canonicalizeVaultRoot(vaultRoot, fsAdapter)).canonicalManagedRoot;
  }

  const dailyFiles = await listGeneratedDailyFiles(fsAdapter, canonicalManagedRoot);
  for (const stale of dailyFiles) {
    if (expectedDailyPaths.has(stale.relativePath)) continue;
    const destination = await destinationFor(vaultRoot, stale.relativePath, fsAdapter);
    const existing = await readTextIfExists(fsAdapter, destination.destinationPath);
    if (existing === null) continue;
    if (!existing.includes(OBSIDIAN_LIFE_LEDGER_SENTINEL)) {
      results.conflicts.push({ relativePath: destination.relativePath, path: destination.destinationPath, reason: 'stale_daily_missing_generated_sentinel' });
      continue;
    }
    results.deleted.push({ relativePath: destination.relativePath, path: destination.destinationPath, reason: 'stale_generated_daily' });
    if (!dryRun) await fsAdapter.unlink(destination.destinationPath);
  }

  return results;
}
