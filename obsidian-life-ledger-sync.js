import path from 'node:path';
import crypto from 'node:crypto';
import {
  OBSIDIAN_LIFE_LEDGER_MANAGED_DIR,
  OBSIDIAN_LIFE_LEDGER_DENIED_VAULT_ROOTS,
  isLinkStats,
  defaultFsAdapter,
  realPathOrResolved,
  assertRelativePath,
  assertNoLinkEscape,
  pathEqualsOrContains,
  assertSafeExistingLeaf,
  readTextIfExists
} from './obsidian-life-ledger-writer.js';
import { OBSIDIAN_LIFE_LEDGER_SENTINEL, buildObsidianLifeLedgerExport } from './obsidian-life-ledger-renderer.js';

// Phase 9 — production-capable Obsidian sync planner/applier (hardened).
//
// Separate from obsidian-life-ledger-writer.js by design: that writer's DENIED_VAULT_ROOTS
// unconditionally blocks BOTH real vaults (it is test-vault-only and its own tests assert
// that). This module reuses the writer's denylist-agnostic containment primitives (traversal
// / link-escape / leaf safety) verbatim but supplies its own MODE-AWARE denylist. The writer
// itself is untouched beyond additive exports.
//
// PRIMARY SAFETY INVARIANT: no file is overwritten unless the system can prove it owns the
// exact previous content baseline. A marker comment is not proof; a sentinel alone is not
// proof; a manifest whose bytes are not bound to the sentinel is not proof. Fail closed.

export const OBSIDIAN_SYNC_SCHEMA_VERSION = 2; // v2: sentinel carries manifestSha256 binding
export const OBSIDIAN_SYNC_OWNER = 'chronasense-life-ledger';

// PHASE 9 HARD BLOCK — RELEASED (Phase 9B). This is the deliberate, reviewed, one-line change
// the previous note described: the code-level production-apply block is now lifted. Flipping
// this constant ONLY removes the highest-level hard stop — it does NOT make writes automatic.
// Every production apply still requires the full authorization chain enforced by
// evaluateProductionAuthorization() and applyObsidianSync(): mode === 'production',
// allowApply === true, apply === true, an exact expectedCanonicalVaultPath match, a verified
// rollback receipt bound to the current plan fingerprint, and — on the first run — the exact
// FIRST-RUN-CONFIRMED:<canonical-vault-path> acknowledgement, plus the per-operation preflight
// and containment/link/leaf re-checks. No default supplies any of those.
export const OBSIDIAN_PRODUCTION_SYNC_ENABLED = true;

export const OBSIDIAN_SENTINEL_RELATIVE_PATH = 'Life Ledger/System/MANAGED-BY-CHRONASENSE.md';
export const OBSIDIAN_MANIFEST_RELATIVE_PATH = 'Life Ledger/System/manifest.json';
export const OBSIDIAN_SYSTEM_README_RELATIVE_PATH = 'Life Ledger/System/README.md';
const TEST_VAULT_MARKER_RELATIVE_PATH = 'TEST-VAULT.md';
const FIRST_RUN_ACK_PREFIX = 'FIRST-RUN-CONFIRMED:';
const ROLLBACK_RECEIPT_FILENAME = 'obsidian-rollback-receipt.json';

// Only these path shapes are ever application-owned generated CONTENT files. The sentinel and
// manifest.json are operational metadata, tracked separately and never listed in the manifest.
const GENERATED_CONTENT_PATH_RES = [
  /^Life Ledger\/System\/README\.md$/,
  /^Life Ledger\/Daily\/\d{4}-\d{2}-\d{2}\.md$/
];
function isGeneratedContentPath(relativePath) {
  return GENERATED_CONTENT_PATH_RES.some(re => re.test(relativePath));
}

const WINDOWS_RESERVED_SEGMENT_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

const [DENIED_ONEDRIVE_VAULT_ROOT, DENIED_STALE_DESKTOP_VAULT_ROOT] = OBSIDIAN_LIFE_LEDGER_DENIED_VAULT_ROOTS;
const DENIED_TEST_VAULT_ROOT = 'C:\\Users\\Admin\\Desktop\\Second-Brain-Test-Vault';

export class ObsidianSyncError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ObsidianSyncError';
    this.code = code;
    Object.assign(this, details);
  }
}

function deniedRootsForMode(mode, options = {}) {
  const extraDenied = Array.isArray(options.extraDeniedVaultRoots) ? options.extraDeniedVaultRoots : [];
  if (mode === 'production') {
    return [DENIED_STALE_DESKTOP_VAULT_ROOT, DENIED_TEST_VAULT_ROOT, ...extraDenied].filter(Boolean);
  }
  return [DENIED_STALE_DESKTOP_VAULT_ROOT, DENIED_ONEDRIVE_VAULT_ROOT, ...extraDenied].filter(Boolean);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Fix 4/12 — Windows-canonical manifest key identity + segment hardening
// ---------------------------------------------------------------------------

// Identity key for lookup and duplicate detection ONLY. The displayed/stored relativePath is
// never rewritten to build this — the code-owned canonical path is what gets rendered.
function manifestKeyIdentity(relativePath) {
  return String(relativePath).replace(/\\/g, '/').toLowerCase();
}

function assertWindowsSafeSegments(relativePath) {
  for (const segment of String(relativePath).split('/')) {
    if (segment.includes(':')) {
      throw new ObsidianSyncError('invalid_path', `Path segment contains a colon: ${relativePath}`);
    }
    if (/[ .]$/.test(segment)) {
      throw new ObsidianSyncError('invalid_path', `Path segment has a trailing dot or space: ${relativePath}`);
    }
    if (WINDOWS_RESERVED_SEGMENT_RE.test(segment)) {
      throw new ObsidianSyncError('invalid_path', `Path segment is a reserved Windows device name: ${relativePath}`);
    }
  }
}

function assertSyncRelativePath(relativePath) {
  let normalized;
  try {
    normalized = assertRelativePath(relativePath); // writer primitive: absolute/UNC/traversal/backslash/normalization + under "Life Ledger/"
  } catch (err) {
    throw new ObsidianSyncError('invalid_path', err.message, { cause: err });
  }
  assertWindowsSafeSegments(normalized);
  return normalized;
}

// ---------------------------------------------------------------------------
// 1. Production target model
// ---------------------------------------------------------------------------

export function createObsidianSyncTarget({ vaultPath, managedRoot = OBSIDIAN_LIFE_LEDGER_MANAGED_DIR, mode, allowApply = false } = {}) {
  if (typeof vaultPath !== 'string' || !vaultPath.trim()) {
    throw new ObsidianSyncError('invalid_target', 'vaultPath must be a non-empty string');
  }
  if (managedRoot !== OBSIDIAN_LIFE_LEDGER_MANAGED_DIR) {
    throw new ObsidianSyncError('invalid_target', `managedRoot must be "${OBSIDIAN_LIFE_LEDGER_MANAGED_DIR}"`);
  }
  if (mode !== 'test' && mode !== 'production') {
    throw new ObsidianSyncError('invalid_target', 'mode must be "test" or "production"');
  }
  if (typeof allowApply !== 'boolean') {
    throw new ObsidianSyncError('invalid_target', 'allowApply must be a boolean');
  }
  return Object.freeze({ vaultPath, managedRoot, mode, allowApply });
}

// ---------------------------------------------------------------------------
// 2/3. Vault identity + mode-aware containment
// ---------------------------------------------------------------------------

async function canonicalizeVaultRootForMode(vaultPath, deniedRoots, fsAdapter) {
  const resolvedVaultRoot = path.resolve(String(vaultPath || ''));
  for (const denied of deniedRoots) {
    if (pathEqualsOrContains(denied, resolvedVaultRoot)) {
      throw new ObsidianSyncError('denied_vault_root', `Obsidian sync refuses denied vault root: ${vaultPath}`);
    }
  }
  let rootStats;
  try {
    rootStats = await fsAdapter.lstat(resolvedVaultRoot);
  } catch (err) {
    if (err?.code === 'ENOENT') throw new ObsidianSyncError('vault_missing', `Vault path does not exist: ${vaultPath}`);
    throw err;
  }
  if (isLinkStats(rootStats)) {
    throw new ObsidianSyncError('vault_root_is_link', `Vault root is a symlink or reparse point: ${vaultPath}`);
  }
  if (rootStats.isDirectory?.() !== true) {
    throw new ObsidianSyncError('vault_not_directory', `Vault path is not a directory: ${vaultPath}`);
  }
  const canonicalVaultRoot = await realPathOrResolved(fsAdapter, resolvedVaultRoot);
  for (const denied of deniedRoots) {
    const deniedCanonical = await realPathOrResolved(fsAdapter, denied);
    if (pathEqualsOrContains(deniedCanonical, canonicalVaultRoot)) {
      throw new ObsidianSyncError('denied_vault_root', `Obsidian sync refuses denied vault root: ${vaultPath}`);
    }
  }
  const managedRootPath = path.join(canonicalVaultRoot, OBSIDIAN_LIFE_LEDGER_MANAGED_DIR);
  const canonicalManagedRoot = await realPathOrResolved(fsAdapter, managedRootPath);
  if (!pathEqualsOrContains(canonicalVaultRoot, canonicalManagedRoot)) {
    throw new ObsidianSyncError('path_escape', 'Managed Life Ledger root resolves outside the vault');
  }
  await assertNoLinkEscape(fsAdapter, canonicalVaultRoot, managedRootPath);
  return { resolvedVaultRoot, canonicalVaultRoot, canonicalManagedRoot };
}

async function destinationForMode(vaultPath, relativePath, deniedRoots, fsAdapter) {
  const normalizedRelative = assertSyncRelativePath(relativePath);
  const { canonicalVaultRoot, canonicalManagedRoot } = await canonicalizeVaultRootForMode(vaultPath, deniedRoots, fsAdapter);
  const destinationPath = path.resolve(path.join(canonicalVaultRoot, ...normalizedRelative.split('/')));
  if (!pathEqualsOrContains(canonicalManagedRoot, destinationPath)) {
    throw new ObsidianSyncError('path_escape', `Sync path resolves outside managed root: ${relativePath}`);
  }
  await assertNoLinkEscape(fsAdapter, canonicalVaultRoot, destinationPath);
  await assertSafeExistingLeaf(fsAdapter, canonicalManagedRoot, destinationPath);
  return { relativePath: normalizedRelative, destinationPath, canonicalVaultRoot, canonicalManagedRoot };
}

export async function verifyObsidianVaultIdentity(target, options = {}) {
  const fsAdapter = options.fs || defaultFsAdapter();
  const deniedRoots = deniedRootsForMode(target.mode, options);
  const signals = { hasObsidianDir: false, looksLikeOneDrivePath: /onedrive/i.test(target.vaultPath), insideKnownRepoRoot: false };

  const knownRepoRoots = Array.isArray(options.knownRepoRoots) ? options.knownRepoRoots : [];
  const resolvedVaultRoot = path.resolve(target.vaultPath);
  for (const repoRoot of knownRepoRoots) {
    if (pathEqualsOrContains(repoRoot, resolvedVaultRoot)) {
      signals.insideKnownRepoRoot = true;
      return { ok: false, reason: 'inside_known_repo_root', signals };
    }
  }

  let canonical;
  try {
    canonical = await canonicalizeVaultRootForMode(target.vaultPath, deniedRoots, fsAdapter);
  } catch (err) {
    if (err instanceof ObsidianSyncError) return { ok: false, reason: err.code, signals };
    throw err;
  }

  for (const repoRoot of knownRepoRoots) {
    if (pathEqualsOrContains(repoRoot, canonical.canonicalVaultRoot)) {
      signals.insideKnownRepoRoot = true;
      return { ok: false, reason: 'inside_known_repo_root', signals };
    }
  }

  try {
    const obsidianDirStats = await fsAdapter.lstat(path.join(canonical.canonicalVaultRoot, '.obsidian'));
    signals.hasObsidianDir = obsidianDirStats.isDirectory?.() === true;
  } catch {
    signals.hasObsidianDir = false;
  }

  if (target.mode === 'production') {
    const expectedCanonicalVaultPath = options.expectedCanonicalVaultPath;
    if (typeof expectedCanonicalVaultPath !== 'string' || !expectedCanonicalVaultPath.trim()) {
      return { ok: false, reason: 'missing_expected_canonical_path', signals, canonicalVaultRoot: canonical.canonicalVaultRoot };
    }
    if (path.resolve(expectedCanonicalVaultPath) !== canonical.canonicalVaultRoot) {
      return { ok: false, reason: 'canonical_path_mismatch', signals, canonicalVaultRoot: canonical.canonicalVaultRoot };
    }
  }

  return {
    ok: true,
    canonicalVaultRoot: canonical.canonicalVaultRoot,
    canonicalManagedRoot: canonical.canonicalManagedRoot,
    signals
  };
}

async function testVaultMarkerAuthorized(canonicalVaultRoot, fsAdapter) {
  const markerPath = path.join(canonicalVaultRoot, TEST_VAULT_MARKER_RELATIVE_PATH);
  try {
    const stats = await fsAdapter.lstat(markerPath);
    if (isLinkStats(stats) || stats.isFile?.() !== true) return false;
    const canonicalMarker = await realPathOrResolved(fsAdapter, markerPath);
    return path.resolve(canonicalMarker).toLowerCase() === path.resolve(markerPath).toLowerCase();
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 4/5 + Fix 2 — ownership sentinel bound to manifest, deterministic manifest
// ---------------------------------------------------------------------------

function sentinelContent(manifestSha256) {
  return `${[
    OBSIDIAN_LIFE_LEDGER_SENTINEL,
    '---',
    `owner: ${OBSIDIAN_SYNC_OWNER}`,
    `schemaVersion: ${OBSIDIAN_SYNC_SCHEMA_VERSION}`,
    `managedRoot: ${OBSIDIAN_LIFE_LEDGER_MANAGED_DIR}`,
    `manifestSha256: ${manifestSha256}`,
    '---',
    '',
    '# Managed by ChronaSense',
    '',
    'This subtree is under application management by the ChronaSense Life Ledger sync.',
    '',
    `The \`manifestSha256\` above is bound to the exact bytes of \`${OBSIDIAN_MANIFEST_RELATIVE_PATH}\`.`,
    'A file is regenerated only when it carries the generated marker AND its current content',
    'hash matches the manifest baseline. Any mismatch (a hand edit, a sync conflict copy, a',
    'partial write) is reported as a conflict and never silently overwritten.',
    '',
    'Everything else in this vault, including sibling folders inside Life Ledger, is untouched.'
  ].join('\n')}\n`;
}

function parseSentinel(content) {
  if (typeof content !== 'string' || !content.includes(OBSIDIAN_LIFE_LEDGER_SENTINEL)) return null;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/m);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

// Distinguishes a legacy (v1, no binding) sentinel from a structurally-wrong one, so the
// plan can report `legacy_sentinel_migration_required` vs `invalid_sentinel` precisely.
function classifySentinel(content) {
  const fields = parseSentinel(content);
  if (!fields) return { ok: false, reason: 'sentinel_unparseable' };
  if (fields.owner !== OBSIDIAN_SYNC_OWNER || fields.managedRoot !== OBSIDIAN_LIFE_LEDGER_MANAGED_DIR) {
    return { ok: false, reason: 'sentinel_owner_mismatch' };
  }
  if (fields.schemaVersion !== String(OBSIDIAN_SYNC_SCHEMA_VERSION) || !/^[0-9a-f]{64}$/.test(fields.manifestSha256 || '')) {
    return { ok: false, reason: 'legacy_sentinel_migration_required' };
  }
  return { ok: true, manifestSha256: fields.manifestSha256 };
}

function manifestContent(fileEntries) {
  const files = fileEntries
    .slice()
    .sort((a, b) => (manifestKeyIdentity(a.relativePath) < manifestKeyIdentity(b.relativePath) ? -1 : 1))
    .map(entry => ({ relativePath: entry.relativePath, sha256: entry.sha256 }));
  const manifest = { schemaVersion: OBSIDIAN_SYNC_SCHEMA_VERSION, owner: OBSIDIAN_SYNC_OWNER, managedRoot: OBSIDIAN_LIFE_LEDGER_MANAGED_DIR, files };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// Fix 5 — manifest.json is untrusted disk input. Every entry must be a known generated
// CONTENT path, Windows-safe, and normalized-unique. Any violation rejects the whole manifest.
function validateManifestFiles(rawFiles) {
  const byIdentity = new Map();
  const baseline = new Map();
  for (const entry of rawFiles) {
    if (!entry || typeof entry.relativePath !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
      throw new ObsidianSyncError('manifest_invalid_entry', 'Manifest entry is malformed');
    }
    assertSyncRelativePath(entry.relativePath); // absolute / traversal / backslash / reserved / trailing-dot
    if (!isGeneratedContentPath(entry.relativePath)) {
      throw new ObsidianSyncError('manifest_unknown_path', `Manifest lists a path that is not an owned generated file: ${entry.relativePath}`);
    }
    const identity = manifestKeyIdentity(entry.relativePath);
    if (byIdentity.has(identity)) {
      throw new ObsidianSyncError('manifest_duplicate_identity', `Manifest has a duplicate path identity: ${identity}`);
    }
    byIdentity.set(identity, entry.relativePath);
    baseline.set(entry.relativePath, entry.sha256);
  }
  return baseline;
}

function parseManifest(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ObsidianSyncError('manifest_unparseable', 'manifest.json is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ObsidianSyncError('manifest_schema_mismatch', 'manifest.json is not an object');
  if (parsed.schemaVersion !== OBSIDIAN_SYNC_SCHEMA_VERSION) throw new ObsidianSyncError('manifest_schema_mismatch', 'manifest.json schemaVersion mismatch');
  if (parsed.owner !== OBSIDIAN_SYNC_OWNER) throw new ObsidianSyncError('manifest_schema_mismatch', 'manifest.json owner mismatch');
  if (parsed.managedRoot !== OBSIDIAN_LIFE_LEDGER_MANAGED_DIR) throw new ObsidianSyncError('manifest_schema_mismatch', 'manifest.json managedRoot mismatch');
  if (!Array.isArray(parsed.files)) throw new ObsidianSyncError('manifest_schema_mismatch', 'manifest.json files is not an array');
  return validateManifestFiles(parsed.files);
}

// ---------------------------------------------------------------------------
// Fix 1/2/3 — managed-root ownership: sentinel + manifest + binding, or BLOCK
// ---------------------------------------------------------------------------

async function inspectManagedRoot(canonicalManagedRoot, deniedRoots, vaultPath, fsAdapter) {
  let managedRootStats;
  try {
    managedRootStats = await fsAdapter.lstat(canonicalManagedRoot);
  } catch (err) {
    if (err?.code === 'ENOENT') return { state: 'absent' };
    throw err;
  }
  if (isLinkStats(managedRootStats) || managedRootStats.isDirectory?.() !== true) {
    return { state: 'unmanaged_conflict', reason: 'managed_root_not_a_plain_directory' };
  }

  let sentinelText;
  let manifestText;
  try {
    const sentinelDest = await destinationForMode(vaultPath, OBSIDIAN_SENTINEL_RELATIVE_PATH, deniedRoots, fsAdapter);
    sentinelText = await readTextIfExists(fsAdapter, sentinelDest.destinationPath);
    const manifestDest = await destinationForMode(vaultPath, OBSIDIAN_MANIFEST_RELATIVE_PATH, deniedRoots, fsAdapter);
    manifestText = await readTextIfExists(fsAdapter, manifestDest.destinationPath);
  } catch (err) {
    if (err instanceof ObsidianSyncError) return { state: 'unmanaged_conflict', reason: err.code };
    throw err;
  }

  if (sentinelText === null) return { state: 'unmanaged_conflict', reason: 'sentinel_missing' };

  const sentinel = classifySentinel(sentinelText);
  if (!sentinel.ok) return { state: 'invalid_sentinel', reason: sentinel.reason };

  if (manifestText === null) return { state: 'invalid_sentinel', reason: 'missing_manifest_baseline' };

  let baseline;
  try {
    baseline = parseManifest(manifestText);
  } catch (err) {
    if (err instanceof ObsidianSyncError) return { state: 'invalid_sentinel', reason: err.code };
    throw err;
  }

  const manifestBytesSha256 = sha256(manifestText);
  if (manifestBytesSha256 !== sentinel.manifestSha256) {
    return { state: 'invalid_sentinel', reason: 'manifest_integrity_mismatch' };
  }

  // The sentinel body is fully deterministic given its manifestSha256. Any edit to it (prose
  // included) means the ownership marker is no longer one this tool wrote — fail closed.
  if (sentinelText !== sentinelContent(sentinel.manifestSha256)) {
    return { state: 'invalid_sentinel', reason: 'sentinel_content_mismatch' };
  }

  return {
    state: 'owned',
    baseline,
    manifestBytesSha256,
    manifestText,
    sentinelText,
    sentinelSha256: sha256(sentinelText)
  };
}

// ---------------------------------------------------------------------------
// 18/19 + Fix 3/6/9 — plan
// ---------------------------------------------------------------------------

const OP = Object.freeze({ CREATE: 'CREATE', UPDATE: 'UPDATE', UNCHANGED: 'UNCHANGED', CONFLICT: 'CONFLICT', BLOCKED: 'BLOCKED', STALE: 'STALE' });
export const OBSIDIAN_SYNC_OPERATIONS = OP;

// Explicit apply phases (Fix 9) — never lexicographic. Content, then manifest, then sentinel
// LAST so that a valid sentinel on disk always implies a matching manifest and complete content.
const PHASE = Object.freeze({ CONTENT: 0, MANIFEST: 1, SENTINEL: 2 });

// Fix 3 — a generated CONTENT file may be UPDATEd only against a trusted manifest baseline.
function classifyContentFile(relativePath, newContent, existingContent, baselineHash) {
  const newHash = sha256(newContent);
  if (existingContent === null) {
    return { relativePath, op: OP.CREATE, reason: 'missing', contentSha256: newHash, preconditionSha256: null, phase: PHASE.CONTENT };
  }
  const existingHash = sha256(existingContent);
  if (existingHash === newHash) {
    // Already exactly what we would write. No mutation, so safe regardless of baseline; the
    // fresh manifest records this hash and the file becomes properly owned next run.
    return { relativePath, op: OP.UNCHANGED, reason: 'byte_identical', contentSha256: newHash, preconditionSha256: existingHash, phase: PHASE.CONTENT };
  }
  if (!existingContent.includes(OBSIDIAN_LIFE_LEDGER_SENTINEL)) {
    return { relativePath, op: OP.CONFLICT, reason: 'unowned_collision', contentSha256: newHash, preconditionSha256: existingHash, phase: PHASE.CONTENT };
  }
  if (baselineHash == null) {
    // Marker present but no trusted baseline for this exact path — could be a copied generated
    // file or a sync conflict copy. Never UPDATE. (Fix 3 / test L.)
    return { relativePath, op: OP.CONFLICT, reason: 'missing_manifest_baseline', contentSha256: newHash, preconditionSha256: existingHash, phase: PHASE.CONTENT };
  }
  if (existingHash !== baselineHash) {
    return { relativePath, op: OP.CONFLICT, reason: 'human_modified_owned_file', contentSha256: newHash, preconditionSha256: existingHash, phase: PHASE.CONTENT };
  }
  return { relativePath, op: OP.UPDATE, reason: 'content_drift', contentSha256: newHash, preconditionSha256: existingHash, phase: PHASE.CONTENT };
}

function planFingerprint(fields) {
  return sha256(JSON.stringify({
    schemaVersion: fields.schemaVersion,
    mode: fields.mode,
    canonicalVaultRoot: fields.canonicalVaultRoot,
    canonicalManagedRoot: fields.canonicalManagedRoot,
    isFirstRun: fields.isFirstRun,
    operations: fields.operations
      .map(op => [op.relativePath, op.op, op.contentSha256 || null, op.preconditionSha256 || null])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  }));
}

export async function planObsidianSync(target, events, options = {}) {
  const fsAdapter = options.fs || defaultFsAdapter();
  const deniedRoots = deniedRootsForMode(target.mode, options);
  const generatedAt = new Date(0).toISOString();
  const base = {
    schemaVersion: OBSIDIAN_SYNC_SCHEMA_VERSION, mode: target.mode, vaultPath: target.vaultPath, generatedAt,
    operations: [], blocked: true, blockState: null, blockReason: null,
    canonicalVaultRoot: null, canonicalManagedRoot: null, isFirstRun: false, rollbackPlan: null, planFingerprint: null
  };

  const identity = await verifyObsidianVaultIdentity(target, { ...options, fs: fsAdapter });
  if (!identity.ok) {
    return Object.freeze({ ...base, blockState: 'identity', blockReason: identity.reason, operations: Object.freeze([]) });
  }

  const ownership = await inspectManagedRoot(identity.canonicalManagedRoot, deniedRoots, target.vaultPath, fsAdapter);
  if (ownership.state === 'unmanaged_conflict' || ownership.state === 'invalid_sentinel') {
    return Object.freeze({
      ...base,
      canonicalVaultRoot: identity.canonicalVaultRoot,
      canonicalManagedRoot: identity.canonicalManagedRoot,
      blockState: ownership.state,
      blockReason: ownership.reason,
      operations: Object.freeze([Object.freeze({ relativePath: OBSIDIAN_LIFE_LEDGER_MANAGED_DIR, op: OP.BLOCKED, reason: ownership.reason })])
    });
  }

  const isFirstRun = ownership.state === 'absent';
  const baseline = ownership.baseline || new Map();

  const exportPlan = buildObsidianLifeLedgerExport(events, options.rendererOptions || {});
  const generatedContentFiles = exportPlan.files; // README + Daily/* only (all match isGeneratedContentPath)
  const generatedPaths = new Set(generatedContentFiles.map(file => file.relativePath));

  const operations = [];
  const nextManifestEntries = [];
  let blocked = false;

  for (const file of generatedContentFiles) {
    const destination = await destinationForMode(target.vaultPath, file.relativePath, deniedRoots, fsAdapter);
    const existingContent = await readTextIfExists(fsAdapter, destination.destinationPath);
    const baselineHash = baseline.get(file.relativePath) ?? null;
    const classification = classifyContentFile(file.relativePath, file.content, existingContent, baselineHash);
    operations.push({ ...classification, content: file.content });
    if (classification.op === OP.CONFLICT) blocked = true;
    else nextManifestEntries.push({ relativePath: file.relativePath, sha256: classification.contentSha256 });
  }

  // Retain previously-owned files that are absent from this run's generated set (Fix 16 / no
  // deletion by absence). They stay owned in the new manifest with their current verified hash.
  for (const [relativePath, baselineHash] of baseline.entries()) {
    if (generatedPaths.has(relativePath)) continue;
    const destination = await destinationForMode(target.vaultPath, relativePath, deniedRoots, fsAdapter);
    const existingContent = await readTextIfExists(fsAdapter, destination.destinationPath);
    if (existingContent === null) continue; // file gone — drop from the manifest, nothing to own
    const existingHash = sha256(existingContent);
    if (!existingContent.includes(OBSIDIAN_LIFE_LEDGER_SENTINEL)) {
      operations.push(Object.freeze({ relativePath, op: OP.CONFLICT, reason: 'unowned_collision', contentSha256: null, preconditionSha256: existingHash, phase: PHASE.CONTENT }));
      blocked = true;
      continue;
    }
    if (existingHash !== baselineHash) {
      operations.push(Object.freeze({ relativePath, op: OP.CONFLICT, reason: 'human_modified_owned_file', contentSha256: null, preconditionSha256: existingHash, phase: PHASE.CONTENT }));
      blocked = true;
      continue;
    }
    operations.push(Object.freeze({ relativePath, op: OP.STALE, reason: 'absent_from_latest_snapshot', contentSha256: existingHash, preconditionSha256: existingHash, phase: PHASE.CONTENT }));
    nextManifestEntries.push({ relativePath, sha256: existingHash });
  }

  // manifest.json (phase 1) and sentinel (phase 2), computed from the final content set.
  const newManifestContent = manifestContent(nextManifestEntries);
  const newManifestSha256 = sha256(newManifestContent);
  const newSentinelContent = sentinelContent(newManifestSha256);
  const newSentinelSha256 = sha256(newSentinelContent);

  const manifestPrecondition = isFirstRun ? null : ownership.manifestBytesSha256;
  const manifestDiskContent = isFirstRun ? null : ownership.manifestText;
  operations.push({
    relativePath: OBSIDIAN_MANIFEST_RELATIVE_PATH,
    op: manifestDiskContent === null ? OP.CREATE : (manifestDiskContent === newManifestContent ? OP.UNCHANGED : OP.UPDATE),
    reason: manifestDiskContent === null ? 'missing' : (manifestDiskContent === newManifestContent ? 'byte_identical' : 'manifest_refresh'),
    contentSha256: newManifestSha256,
    preconditionSha256: manifestPrecondition,
    phase: PHASE.MANIFEST,
    content: newManifestContent
  });

  const sentinelPrecondition = isFirstRun ? null : ownership.sentinelSha256;
  const sentinelDiskContent = isFirstRun ? null : ownership.sentinelText;
  operations.push({
    relativePath: OBSIDIAN_SENTINEL_RELATIVE_PATH,
    op: sentinelDiskContent === null ? OP.CREATE : (sentinelDiskContent === newSentinelContent ? OP.UNCHANGED : OP.UPDATE),
    reason: sentinelDiskContent === null ? 'missing' : (sentinelDiskContent === newSentinelContent ? 'byte_identical' : 'ownership_binding_refresh'),
    contentSha256: newSentinelSha256,
    preconditionSha256: sentinelPrecondition,
    phase: PHASE.SENTINEL,
    content: newSentinelContent
  });

  // Display order: by (phase, path). Apply order is derived from `phase` explicitly, never
  // from this sort.
  operations.sort((a, b) => (a.phase - b.phase) || (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

  const rollbackPlan = Object.freeze(isFirstRun
    ? { strategy: 'delete_managed_root', managedRootExistedBefore: false, note: 'Undo = remove the Life Ledger/ directory created by this apply, after re-verifying its ownership state.' }
    : { strategy: 'restore_from_backup_artifact', managedRootExistedBefore: true, note: 'Undo = restore the Life Ledger/ subtree from the verified rollback artifact (see prepareObsidianRollbackArtifact).' });

  const operationsFrozen = Object.freeze(operations.map(op => Object.freeze(op)));
  const fingerprint = planFingerprint({
    schemaVersion: OBSIDIAN_SYNC_SCHEMA_VERSION,
    mode: target.mode,
    canonicalVaultRoot: identity.canonicalVaultRoot,
    canonicalManagedRoot: identity.canonicalManagedRoot,
    isFirstRun,
    operations: operationsFrozen
  });

  return Object.freeze({
    ...base,
    canonicalVaultRoot: identity.canonicalVaultRoot,
    canonicalManagedRoot: identity.canonicalManagedRoot,
    isFirstRun,
    blocked,
    blockState: blocked ? 'conflicts' : null,
    blockReason: blocked ? 'unresolved_conflicts' : null,
    rollbackPlan,
    planFingerprint: fingerprint,
    operations: operationsFrozen
  });
}

// ---------------------------------------------------------------------------
// Fix 11 — real rollback artifact API (used only via tests this pass; production is disabled)
// ---------------------------------------------------------------------------

async function copyManagedSubtreeHashed(fsAdapter, srcRoot, dstRoot, relPrefix = 'Life Ledger') {
  const files = [];
  async function walk(relDir) {
    const absDir = path.join(srcRoot, ...relDir.split('/'));
    let entries;
    try {
      entries = await fsAdapter.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory?.()) {
        await walk(rel);
        continue;
      }
      const content = await fsAdapter.readFile(path.join(srcRoot, ...rel.split('/')), 'utf8');
      const dst = path.join(dstRoot, ...rel.split('/'));
      await fsAdapter.mkdir(path.dirname(dst), { recursive: true });
      await fsAdapter.writeFile(dst, content, 'utf8');
      files.push({ relativePath: rel, sha256: sha256(content) });
    }
  }
  await walk(relPrefix);
  files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  return files;
}

export async function prepareObsidianRollbackArtifact({ target, plan, backupRoot, fs: fsOverride } = {}) {
  const fsAdapter = fsOverride || defaultFsAdapter();
  if (!plan || plan.blocked || !plan.canonicalVaultRoot) {
    throw new ObsidianSyncError('invalid_plan', 'Cannot prepare a rollback artifact for a missing or blocked plan');
  }
  if (typeof backupRoot !== 'string' || !backupRoot.trim()) {
    throw new ObsidianSyncError('invalid_backup_root', 'backupRoot must be a non-empty path');
  }
  const resolvedBackupRoot = path.resolve(backupRoot);
  if (pathEqualsOrContains(plan.canonicalVaultRoot, resolvedBackupRoot) || pathEqualsOrContains(resolvedBackupRoot, plan.canonicalVaultRoot)) {
    throw new ObsidianSyncError('backup_root_inside_vault', 'backupRoot must be entirely outside the target vault');
  }
  await fsAdapter.mkdir(resolvedBackupRoot, { recursive: true });
  const receiptPath = path.join(resolvedBackupRoot, ROLLBACK_RECEIPT_FILENAME);
  if (await readTextIfExists(fsAdapter, receiptPath) !== null) {
    throw new ObsidianSyncError('backup_artifact_exists', 'A rollback artifact already exists at this backupRoot — refusing to overwrite');
  }

  let backup = null;
  if (!plan.isFirstRun) {
    const copyRoot = path.join(resolvedBackupRoot, 'backup');
    const files = await copyManagedSubtreeHashed(fsAdapter, plan.canonicalVaultRoot, copyRoot);
    backup = { backupArtifactPath: copyRoot, files, backupManifestSha256: sha256(JSON.stringify(files)) };
  }

  const receiptBody = {
    kind: 'obsidian-rollback-receipt',
    schemaVersion: OBSIDIAN_SYNC_SCHEMA_VERSION,
    canonicalVaultRoot: plan.canonicalVaultRoot,
    canonicalManagedRoot: plan.canonicalManagedRoot,
    managedRoot: target.managedRoot,
    managedRootExistedBefore: !plan.isFirstRun,
    planFingerprint: plan.planFingerprint,
    backup
  };
  const receiptContent = `${JSON.stringify(receiptBody, null, 2)}\n`;
  await fsAdapter.writeFile(receiptPath, receiptContent, 'utf8');
  return Object.freeze({ ...receiptBody, receiptPath, receiptSha256: sha256(receiptContent) });
}

export async function verifyObsidianRollbackReceipt(receipt, { target, plan, fs: fsOverride } = {}) {
  const fsAdapter = fsOverride || defaultFsAdapter();
  if (!receipt || receipt.kind !== 'obsidian-rollback-receipt' || receipt.schemaVersion !== OBSIDIAN_SYNC_SCHEMA_VERSION) return false;
  if (!plan || plan.blocked) return false;
  if (receipt.canonicalVaultRoot !== plan.canonicalVaultRoot) return false;
  if (receipt.canonicalManagedRoot !== plan.canonicalManagedRoot) return false;
  if (receipt.managedRoot !== target.managedRoot) return false;
  if (receipt.managedRootExistedBefore !== !plan.isFirstRun) return false;
  if (receipt.planFingerprint !== plan.planFingerprint) return false;

  const onDisk = await readTextIfExists(fsAdapter, receipt.receiptPath);
  if (onDisk === null || sha256(onDisk) !== receipt.receiptSha256) return false;

  if (receipt.managedRootExistedBefore === false) {
    // First-run pre-state receipt: there is no prior content to back up, so `backup` MUST be
    // exactly null. A first-run receipt carrying any backup payload is structurally wrong (a
    // crossed-wires or hand-edited receipt) and is rejected before the pre-state check.
    if (receipt.backup !== null) return false;
    // The managed root must still be absent.
    try {
      await fsAdapter.lstat(plan.canonicalManagedRoot);
      return false; // it exists now — pre-state no longer holds
    } catch (err) {
      if (err?.code !== 'ENOENT') return false;
    }
    return true;
  }

  // Existing-root receipt: the copied backup bytes must still match.
  if (!receipt.backup) return false;
  let current;
  try {
    current = await copyManagedSubtreeHashedReadOnly(fsAdapter, receipt.backup.backupArtifactPath);
  } catch {
    return false;
  }
  return sha256(JSON.stringify(current)) === receipt.backup.backupManifestSha256;
}

async function copyManagedSubtreeHashedReadOnly(fsAdapter, backupArtifactRoot) {
  const files = [];
  async function walk(absDir, rel) {
    const entries = await fsAdapter.readdir(absDir, { withFileTypes: true });
    for (const entry of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(absDir, entry.name);
      if (entry.isDirectory?.()) {
        await walk(childAbs, childRel);
        continue;
      }
      const content = await fsAdapter.readFile(childAbs, 'utf8');
      files.push({ relativePath: `Life Ledger/${childRel.replace(/^Life Ledger\//, '')}`, sha256: sha256(content) });
    }
  }
  await walk(path.join(backupArtifactRoot, 'Life Ledger'), '');
  files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  return files.map(f => ({ relativePath: f.relativePath, sha256: f.sha256 }));
}

// ---------------------------------------------------------------------------
// 21 — production authorization + Fix 6/7/8/9/10 apply
// ---------------------------------------------------------------------------

export function evaluateProductionAuthorization(plan, authorization = {}, { enabled = OBSIDIAN_PRODUCTION_SYNC_ENABLED, rollbackReceiptValid } = {}) {
  if (enabled !== true) return { ok: false, code: 'production_sync_disabled' };
  if (authorization.mode !== 'production') return { ok: false, code: 'production_not_authorized' };
  if (authorization.allowApply !== true) return { ok: false, code: 'production_not_authorized' };
  if (authorization.apply !== true) return { ok: false, code: 'production_not_authorized' };
  if (typeof authorization.expectedCanonicalVaultPath !== 'string' || path.resolve(authorization.expectedCanonicalVaultPath) !== plan.canonicalVaultRoot) {
    return { ok: false, code: 'production_not_authorized' };
  }
  if (rollbackReceiptValid !== true) return { ok: false, code: 'rollback_receipt_unverified' };
  if (plan.isFirstRun && authorization.firstRunAck !== `${FIRST_RUN_ACK_PREFIX}${plan.canonicalVaultRoot}`) {
    return { ok: false, code: 'first_run_not_acknowledged' };
  }
  return { ok: true };
}

async function assertTestAuthorized(plan, authorization, fsAdapter) {
  if (authorization?.mode !== 'test') throw new ObsidianSyncError('test_not_authorized', 'authorization.mode must be "test"');
  if (authorization?.apply !== true) throw new ObsidianSyncError('test_not_authorized', 'authorization.apply must be true');
  const authorized = await testVaultMarkerAuthorized(plan.canonicalVaultRoot, fsAdapter);
  if (!authorized) throw new ObsidianSyncError('test_not_authorized', 'Apply requires a real TEST-VAULT.md file at the vault root');
}

async function guardedAtomicWrite(fsAdapter, canonicalVaultRoot, canonicalManagedRoot, vaultPath, relativePath, deniedRoots, content, contentSha256) {
  // Fix 8 — assert the frozen op's content still hashes to its recorded value.
  if (sha256(content) !== contentSha256) {
    throw new ObsidianSyncError('invalid_plan_content', `Plan content hash mismatch for ${relativePath}`, { relativePath });
  }
  // Fix 7 — re-resolve + re-check containment/link/leaf for THIS path immediately before writing.
  const destination = await destinationForMode(vaultPath, relativePath, deniedRoots, fsAdapter);
  if (!pathEqualsOrContains(canonicalManagedRoot, destination.destinationPath)) {
    throw new ObsidianSyncError('path_escape', `Write target escaped the managed root: ${relativePath}`, { relativePath });
  }
  const dir = path.dirname(destination.destinationPath);
  await fsAdapter.mkdir(dir, { recursive: true });
  // Re-assert after mkdir so a junction/reparse inserted for a not-yet-existing parent is caught.
  await assertNoLinkEscape(fsAdapter, canonicalVaultRoot, destination.destinationPath);
  await assertSafeExistingLeaf(fsAdapter, canonicalManagedRoot, destination.destinationPath);
  const tempPath = path.join(dir, `.${path.basename(destination.destinationPath)}.tmp`);
  await fsAdapter.writeFile(tempPath, content, 'utf8');
  try {
    await fsAdapter.rename(tempPath, destination.destinationPath);
  } catch (err) {
    try { await fsAdapter.unlink(tempPath); } catch { /* best effort */ }
    throw err;
  }
}

export async function applyObsidianSync(plan, authorization = {}, options = {}) {
  const fsAdapter = options.fs || defaultFsAdapter();
  if (plan.blocked) throw new ObsidianSyncError('plan_blocked', `Cannot apply a blocked plan: ${plan.blockReason}`);

  if (plan.mode === 'production') {
    if (OBSIDIAN_PRODUCTION_SYNC_ENABLED !== true) {
      throw new ObsidianSyncError('production_sync_disabled', 'Production Obsidian sync is disabled in this build — apply is hard-blocked pending independent review and explicit authorization');
    }
    let rollbackReceiptValid = false;
    if (authorization.rollbackReceipt) {
      rollbackReceiptValid = await verifyObsidianRollbackReceipt(authorization.rollbackReceipt, {
        target: { managedRoot: OBSIDIAN_LIFE_LEDGER_MANAGED_DIR },
        plan,
        fs: fsAdapter
      });
    }
    const result = evaluateProductionAuthorization(plan, authorization, { rollbackReceiptValid });
    if (!result.ok) throw new ObsidianSyncError(result.code, `Production apply refused: ${result.code}`);
  } else if (plan.mode === 'test') {
    await assertTestAuthorized(plan, authorization, fsAdapter);
  } else {
    throw new ObsidianSyncError('invalid_plan', `Unknown plan mode: ${plan.mode}`);
  }

  const deniedRoots = deniedRootsForMode(plan.mode, { extraDeniedVaultRoots: options.extraDeniedVaultRoots });
  const canonicalVaultRoot = plan.canonicalVaultRoot;
  const canonicalManagedRoot = plan.canonicalManagedRoot;

  // Fix 6 — preflight re-validates EVERY operation whose disk state feeds the new baseline,
  // not just CREATE/UPDATE. Any drift (including an edited UNCHANGED or STALE file) aborts
  // with zero writes.
  for (const operation of plan.operations) {
    if (operation.op === OP.BLOCKED) continue;
    const destination = await destinationForMode(plan.vaultPath, operation.relativePath, deniedRoots, fsAdapter);
    const currentContent = await readTextIfExists(fsAdapter, destination.destinationPath);
    const currentHash = currentContent === null ? null : sha256(currentContent);
    if (currentHash !== operation.preconditionSha256) {
      throw new ObsidianSyncError('precondition_changed', `Filesystem changed since planning: ${operation.relativePath}`, { relativePath: operation.relativePath });
    }
  }

  // Fix 9 — explicit apply order: content (phase 0), then manifest (phase 1), then sentinel
  // (phase 2). Within a phase, deterministic by path.
  const writable = plan.operations
    .filter(op => op.op === OP.CREATE || op.op === OP.UPDATE)
    .slice()
    .sort((a, b) => (a.phase - b.phase) || (a.relativePath < b.relativePath ? -1 : 1));

  const written = [];
  for (const operation of writable) {
    try {
      await guardedAtomicWrite(fsAdapter, canonicalVaultRoot, canonicalManagedRoot, plan.vaultPath, operation.relativePath, deniedRoots, operation.content, operation.contentSha256);
    } catch (err) {
      if (err instanceof ObsidianSyncError && (err.code === 'invalid_plan_content' || err.code === 'path_escape')) {
        // Defensive stop with zero-further-writes; `written` reports what already landed.
        throw new ObsidianSyncError(err.code, err.message, { written: Object.freeze([...written]), failedRelativePath: operation.relativePath, cause: err });
      }
      throw new ObsidianSyncError(
        'partial_apply_failure',
        `Apply failed after writing ${written.length} of ${writable.length} file(s); ${operation.relativePath} was not written. A fresh plan will fail closed on the incomplete ownership chain until this is recovered.`,
        { written: Object.freeze([...written]), failedRelativePath: operation.relativePath, cause: err }
      );
    }
    written.push(operation.relativePath);
  }

  return Object.freeze({
    applied: true,
    written: Object.freeze(written),
    unchanged: Object.freeze(plan.operations.filter(op => op.op === OP.UNCHANGED).map(op => op.relativePath)),
    stale: Object.freeze(plan.operations.filter(op => op.op === OP.STALE).map(op => op.relativePath))
  });
}

// ---------------------------------------------------------------------------
// 36 — human-readable preview
// ---------------------------------------------------------------------------

export function formatObsidianSyncPreview(plan) {
  if (plan.blocked && plan.operations.every(op => op.op === OP.BLOCKED)) {
    return `Obsidian sync preview\n\nBLOCKED\n${plan.blockState}: ${plan.blockReason}`;
  }
  const lines = ['Obsidian sync preview', ''];
  for (const op of plan.operations) {
    lines.push(`${op.op}${op.op === OP.CONFLICT ? ` (${op.reason})` : ''}`, op.relativePath, '');
  }
  lines.push(plan.mode === 'production'
    ? 'Production apply blocked until explicit authorization (production sync is disabled in this build).'
    : `Test apply ${plan.blocked ? `blocked: ${plan.blockReason}.` : 'requires --apply plus a TEST-VAULT.md marker.'}`);
  return lines.join('\n').trimEnd();
}
