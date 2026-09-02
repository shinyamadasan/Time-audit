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
  readTextIfExists,
  writeFileAtomically
} from './obsidian-life-ledger-writer.js';
import { OBSIDIAN_LIFE_LEDGER_SENTINEL, buildObsidianLifeLedgerExport } from './obsidian-life-ledger-renderer.js';

// Phase 9 — production-capable Obsidian sync planner/applier.
//
// This module is deliberately separate from obsidian-life-ledger-writer.js rather than a
// rewrite of it. The writer's DENIED_VAULT_ROOTS unconditionally blocks BOTH real vaults
// (OneDrive active + Desktop stale) because the writer was built test-vault-only, and its own
// tests assert that unconditional block. A production target must be able to reach the real
// active vault under an explicit authorization — so this module reuses the writer's
// denylist-agnostic containment primitives (traversal / link-escape / atomic write) verbatim,
// but supplies its own MODE-AWARE denylist instead of calling the writer's hardcoded one.
// The writer itself is untouched beyond additive exports.

export const OBSIDIAN_SYNC_SCHEMA_VERSION = 1;
export const OBSIDIAN_SYNC_OWNER = 'chronasense-life-ledger';

// PHASE 9 FIRST-PASS HARD BLOCK. Production apply is disabled at the code level, independent
// of any runtime flag, CLI argument, or authorization token a caller can supply. Enabling it
// is a deliberate, reviewed, one-line commit that happens ONLY after independent adversarial
// review and explicit user authorization (spec sections 21 and 49). Until then, every production
// apply throws `production_sync_disabled` before any other check runs. The full multi-factor
// authorization below (mode + allowApply + apply flag + exact canonical-path match + path-
// bound first-run token + first-run backup acknowledgement) is the SECOND layer, exercised
// only once this switch is flipped.
export const OBSIDIAN_PRODUCTION_SYNC_ENABLED = false;
export const OBSIDIAN_SENTINEL_RELATIVE_PATH = 'Life Ledger/System/MANAGED-BY-CHRONASENSE.md';
export const OBSIDIAN_MANIFEST_RELATIVE_PATH = 'Life Ledger/System/manifest.json';
export const OBSIDIAN_SYSTEM_README_RELATIVE_PATH = 'Life Ledger/System/README.md';
const TEST_VAULT_MARKER_RELATIVE_PATH = 'TEST-VAULT.md';
const FIRST_RUN_ACK_PREFIX = 'FIRST-RUN-CONFIRMED:';

// The stale Desktop vault is never a valid target in any mode. Test mode additionally must
// never reach the real active vault; production mode additionally must never reach the test
// vault. These are safety rails, not the primary authorization mechanism — production access
// is gated on an exact canonical-path match supplied by the caller (see planObsidianSync),
// never on a hardcoded "this is the real vault" assumption.
const [DENIED_ONEDRIVE_VAULT_ROOT, DENIED_STALE_DESKTOP_VAULT_ROOT] = OBSIDIAN_LIFE_LEDGER_DENIED_VAULT_ROOTS;
// Production mode must never reach the test sandbox either, independent of whatever exact
// path a caller happens to authorize — this is a hardcoded rail, not the primary gate.
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
// 1. Production target model
// ---------------------------------------------------------------------------

export function createObsidianSyncTarget({ vaultPath, managedRoot = OBSIDIAN_LIFE_LEDGER_MANAGED_DIR, mode, allowApply = false } = {}) {
  if (typeof vaultPath !== 'string' || !vaultPath.trim()) {
    throw new ObsidianSyncError('invalid_target', 'vaultPath must be a non-empty string');
  }
  if (managedRoot !== OBSIDIAN_LIFE_LEDGER_MANAGED_DIR) {
    // V1 manages exactly one allowlisted subtree name. Accepting an arbitrary caller-supplied
    // managedRoot string here would let untrusted config pick the filesystem target — refused.
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
// 2/3. Real-vault identity check (read-only) + mode-aware containment primitives
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
  const normalizedRelative = assertRelativePath(relativePath);
  const { canonicalVaultRoot, canonicalManagedRoot } = await canonicalizeVaultRootForMode(vaultPath, deniedRoots, fsAdapter);
  const destinationPath = path.resolve(path.join(canonicalVaultRoot, ...normalizedRelative.split('/')));
  if (!pathEqualsOrContains(canonicalManagedRoot, destinationPath)) {
    throw new ObsidianSyncError('path_escape', `Sync path resolves outside managed root: ${relativePath}`);
  }
  await assertNoLinkEscape(fsAdapter, canonicalVaultRoot, destinationPath);
  await assertSafeExistingLeaf(fsAdapter, canonicalManagedRoot, destinationPath);
  return { relativePath: normalizedRelative, destinationPath, canonicalVaultRoot, canonicalManagedRoot };
}

// Read-only diagnostic pass. Never throws for an ordinary "this target is not safe" outcome —
// it reports `ok:false` with a reason instead, so callers (and the CLI preview) can show WHY
// a target was rejected without a try/catch. Programmer-error inputs still throw via
// createObsidianSyncTarget, which callers are expected to call first.
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

// ---------------------------------------------------------------------------
// Test-vault marker gate (mirrors scripts/export-life-ledger-to-obsidian.mjs exactly, so test
// mode here carries the same guarantee as the existing reviewed CLI — not a weaker one).
// ---------------------------------------------------------------------------

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
// 4/5. Ownership sentinel + deterministic manifest content
// ---------------------------------------------------------------------------

function sentinelContent() {
  return `${[
    OBSIDIAN_LIFE_LEDGER_SENTINEL,
    '---',
    `owner: ${OBSIDIAN_SYNC_OWNER}`,
    `schemaVersion: ${OBSIDIAN_SYNC_SCHEMA_VERSION}`,
    `managedRoot: ${OBSIDIAN_LIFE_LEDGER_MANAGED_DIR}`,
    '---',
    '',
    '# Managed by ChronaSense',
    '',
    'This subtree is under application management by the ChronaSense Life Ledger sync.',
    '',
    `Only files carrying the \`${OBSIDIAN_LIFE_LEDGER_SENTINEL}\` marker AND listed in`,
    `\`${OBSIDIAN_MANIFEST_RELATIVE_PATH}\` are application-owned and safe to regenerate.`,
    '',
    'Everything else in this vault, including sibling folders inside Life Ledger and any file',
    'without this marker, is left untouched by this tool. Do not hand-edit a generated file —',
    'edits are detected and treated as a conflict, never silently overwritten.'
  ].join('\n')}\n`;
}

function isValidSentinelContent(content) {
  if (typeof content !== 'string' || !content.includes(OBSIDIAN_LIFE_LEDGER_SENTINEL)) return false;
  return content.includes(`owner: ${OBSIDIAN_SYNC_OWNER}`)
    && content.includes(`schemaVersion: ${OBSIDIAN_SYNC_SCHEMA_VERSION}`)
    && content.includes(`managedRoot: ${OBSIDIAN_LIFE_LEDGER_MANAGED_DIR}`);
}

function manifestContent(fileHashes) {
  const files = fileHashes.slice().sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  const manifest = { schemaVersion: OBSIDIAN_SYNC_SCHEMA_VERSION, owner: OBSIDIAN_SYNC_OWNER, managedRoot: OBSIDIAN_LIFE_LEDGER_MANAGED_DIR, files };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function parseManifest(content) {
  if (typeof content !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.schemaVersion !== OBSIDIAN_SYNC_SCHEMA_VERSION) return null;
  if (parsed.owner !== OBSIDIAN_SYNC_OWNER) return null;
  if (parsed.managedRoot !== OBSIDIAN_LIFE_LEDGER_MANAGED_DIR) return null;
  if (!Array.isArray(parsed.files)) return null;
  const byPath = new Map();
  for (const entry of parsed.files) {
    if (!entry || typeof entry.relativePath !== 'string' || typeof entry.sha256 !== 'string') return null;
    if (byPath.has(entry.relativePath)) return null; // duplicate entries make the manifest untrustworthy
    byPath.set(entry.relativePath, entry.sha256);
  }
  return byPath;
}

// ---------------------------------------------------------------------------
// 7/8. Managed-root ownership inspection (read-only)
// ---------------------------------------------------------------------------

async function inspectManagedRoot(canonicalVaultRoot, canonicalManagedRoot, deniedRoots, vaultPath, fsAdapter) {
  let managedRootStats;
  try {
    managedRootStats = await fsAdapter.lstat(canonicalManagedRoot);
  } catch (err) {
    if (err?.code === 'ENOENT') return { state: 'absent', manifest: null };
    throw err;
  }
  if (isLinkStats(managedRootStats) || managedRootStats.isDirectory?.() !== true) {
    return { state: 'unmanaged_conflict', manifest: null, reason: 'managed_root_not_a_plain_directory' };
  }

  let sentinelText;
  try {
    const destination = await destinationForMode(vaultPath, OBSIDIAN_SENTINEL_RELATIVE_PATH, deniedRoots, fsAdapter);
    sentinelText = await readTextIfExists(fsAdapter, destination.destinationPath);
  } catch (err) {
    if (err instanceof ObsidianSyncError) return { state: 'unmanaged_conflict', manifest: null, reason: err.code };
    throw err;
  }
  if (sentinelText === null) return { state: 'unmanaged_conflict', manifest: null, reason: 'sentinel_missing' };
  if (!isValidSentinelContent(sentinelText)) return { state: 'invalid_sentinel', manifest: null, reason: 'sentinel_schema_mismatch' };

  const manifestDestination = await destinationForMode(vaultPath, OBSIDIAN_MANIFEST_RELATIVE_PATH, deniedRoots, fsAdapter);
  const manifestText = await readTextIfExists(fsAdapter, manifestDestination.destinationPath);
  const manifest = manifestText === null ? null : parseManifest(manifestText);
  if (manifestText !== null && manifest === null) {
    return { state: 'invalid_sentinel', manifest: null, reason: 'manifest_schema_mismatch' };
  }
  return { state: 'owned', manifest };
}

// ---------------------------------------------------------------------------
// 18/19. Plan (immutable, dry-run by construction)
// ---------------------------------------------------------------------------

const OP = Object.freeze({ CREATE: 'CREATE', UPDATE: 'UPDATE', UNCHANGED: 'UNCHANGED', CONFLICT: 'CONFLICT', BLOCKED: 'BLOCKED', STALE: 'STALE' });
export const OBSIDIAN_SYNC_OPERATIONS = OP;

function classifyGeneratedFile(relativePath, newContent, existingContent, manifestEntryHash) {
  const newHash = sha256(newContent);
  if (existingContent === null) {
    return { relativePath, op: OP.CREATE, reason: 'missing', contentSha256: newHash, previousSha256: null };
  }
  if (!existingContent.includes(OBSIDIAN_LIFE_LEDGER_SENTINEL)) {
    return { relativePath, op: OP.CONFLICT, reason: 'unowned_collision', contentSha256: newHash, previousSha256: sha256(existingContent) };
  }
  const existingHash = sha256(existingContent);
  if (manifestEntryHash != null && existingHash !== manifestEntryHash) {
    return { relativePath, op: OP.CONFLICT, reason: 'human_modified_owned_file', contentSha256: newHash, previousSha256: existingHash };
  }
  if (existingHash === newHash) {
    return { relativePath, op: OP.UNCHANGED, reason: 'byte_identical', contentSha256: newHash, previousSha256: existingHash };
  }
  return { relativePath, op: OP.UPDATE, reason: manifestEntryHash == null ? 'adopting_sentinel_owned_file' : 'content_drift', contentSha256: newHash, previousSha256: existingHash };
}

export async function planObsidianSync(target, events, options = {}) {
  const fsAdapter = options.fs || defaultFsAdapter();
  const deniedRoots = deniedRootsForMode(target.mode, options);
  const generatedAt = new Date(0).toISOString(); // fixed epoch: plan objects never carry a real wall-clock timestamp
  const basePlan = { schemaVersion: OBSIDIAN_SYNC_SCHEMA_VERSION, mode: target.mode, vaultPath: target.vaultPath, generatedAt, operations: [], blocked: true, blockReason: null, canonicalVaultRoot: null, canonicalManagedRoot: null, isFirstRun: false, rollbackPlan: null };

  const identity = await verifyObsidianVaultIdentity(target, { ...options, fs: fsAdapter });
  if (!identity.ok) {
    return Object.freeze({ ...basePlan, blockReason: identity.reason, operations: Object.freeze([]) });
  }

  const ownership = await inspectManagedRoot(identity.canonicalVaultRoot, identity.canonicalManagedRoot, deniedRoots, target.vaultPath, fsAdapter);
  if (ownership.state === 'unmanaged_conflict' || ownership.state === 'invalid_sentinel') {
    return Object.freeze({
      ...basePlan,
      canonicalVaultRoot: identity.canonicalVaultRoot,
      canonicalManagedRoot: identity.canonicalManagedRoot,
      blockReason: ownership.state,
      operations: Object.freeze([{ relativePath: OBSIDIAN_LIFE_LEDGER_MANAGED_DIR, op: OP.BLOCKED, reason: ownership.reason }])
    });
  }

  const isFirstRun = ownership.state === 'absent';
  const manifestByPath = ownership.manifest;

  const exportPlan = buildObsidianLifeLedgerExport(events, options.rendererOptions || {});
  const generatedFiles = [
    { relativePath: OBSIDIAN_SENTINEL_RELATIVE_PATH, content: sentinelContent() },
    ...exportPlan.files
  ];
  const expectedRelativePaths = new Set(generatedFiles.map(file => file.relativePath));

  const operations = [];
  const nextManifestEntries = [];
  for (const file of generatedFiles) {
    const destination = await destinationForMode(target.vaultPath, file.relativePath, deniedRoots, fsAdapter);
    const existingContent = await readTextIfExists(fsAdapter, destination.destinationPath);
    const manifestEntryHash = manifestByPath ? (manifestByPath.get(file.relativePath) ?? null) : null;
    const classification = classifyGeneratedFile(file.relativePath, file.content, existingContent, manifestEntryHash);
    operations.push({ ...classification, content: file.content });
    if (classification.op !== OP.CONFLICT) nextManifestEntries.push({ relativePath: file.relativePath, sha256: classification.contentSha256 });
  }

  // manifest.json itself: pure operational metadata (not human-authored content), so it is
  // always safe to (re)write once the sentinel proves the root is owned — see module header.
  const manifestFileContent = manifestContent(nextManifestEntries);
  const manifestDestination = await destinationForMode(target.vaultPath, OBSIDIAN_MANIFEST_RELATIVE_PATH, deniedRoots, fsAdapter);
  const existingManifestText = await readTextIfExists(fsAdapter, manifestDestination.destinationPath);
  const manifestHash = sha256(manifestFileContent);
  operations.push({
    relativePath: OBSIDIAN_MANIFEST_RELATIVE_PATH,
    op: existingManifestText === null ? OP.CREATE : (existingManifestText === manifestFileContent ? OP.UNCHANGED : OP.UPDATE),
    reason: existingManifestText === null ? 'missing' : (existingManifestText === manifestFileContent ? 'byte_identical' : 'manifest_refresh'),
    contentSha256: manifestHash,
    previousSha256: existingManifestText === null ? null : sha256(existingManifestText),
    content: manifestFileContent
  });

  // Stale detection: a previously-manifested Daily file absent from this run's event set is
  // reported, never deleted (V1 is conservative by design - spec section 16). Only files that
  // still carry the sentinel and still match their last manifested hash are eligible to be
  // reported stale; anything else is a pre-existing conflict already captured above.
  if (manifestByPath) {
    for (const [relativePath, previousHash] of manifestByPath.entries()) {
      if (expectedRelativePaths.has(relativePath) || relativePath === OBSIDIAN_MANIFEST_RELATIVE_PATH) continue;
      if (!/^Life Ledger\/Daily\/\d{4}-\d{2}-\d{2}\.md$/.test(relativePath)) continue;
      const destination = await destinationForMode(target.vaultPath, relativePath, deniedRoots, fsAdapter);
      const existingContent = await readTextIfExists(fsAdapter, destination.destinationPath);
      if (existingContent === null) continue;
      if (existingContent.includes(OBSIDIAN_LIFE_LEDGER_SENTINEL) && sha256(existingContent) === previousHash) {
        operations.push({ relativePath, op: OP.STALE, reason: 'absent_from_latest_snapshot', contentSha256: null, previousSha256: previousHash });
      }
    }
  }

  operations.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  const blocked = operations.some(operation => operation.op === OP.CONFLICT);

  // Smallest rollback artifact sufficient to undo app-owned changes (spec section 17). First
  // run: the managed root did not exist, so a full undo is "delete Life Ledger/". Subsequent
  // runs: the pre-apply manifest already on disk records the SHA-256 of every managed file
  // before this apply - combined with the vault's own Git history / backup, the restore path.
  const rollbackPlan = Object.freeze(isFirstRun
    ? { strategy: 'delete_managed_root', managedRootExistedBefore: false, note: 'Undo = remove the Life Ledger/ directory created by this apply.' }
    : { strategy: 'restore_from_prior_manifest', managedRootExistedBefore: true, note: 'Undo = restore managed files to the SHA-256 hashes in the pre-apply Life Ledger/System/manifest.json via vault Git history or backup.' });

  return Object.freeze({
    ...basePlan,
    canonicalVaultRoot: identity.canonicalVaultRoot,
    canonicalManagedRoot: identity.canonicalManagedRoot,
    isFirstRun,
    blocked,
    blockReason: blocked ? 'unresolved_conflicts' : null,
    rollbackPlan,
    operations: Object.freeze(operations.map(operation => Object.freeze(operation)))
  });
}

// ---------------------------------------------------------------------------
// 21. Production authorization gate + 19/20. Apply with TOCTOU precondition re-check
// ---------------------------------------------------------------------------

// Pure evaluation of the full production authorization stack. `enabled` defaults to the hard
// build constant — applyObsidianSync always uses that default, so production apply is truly
// hard-blocked in the real path. The parameter exists so the SECOND-layer checks (which only
// matter once the constant is flipped) remain directly testable without editing the module.
export function evaluateProductionAuthorization(plan, authorization = {}, { enabled = OBSIDIAN_PRODUCTION_SYNC_ENABLED } = {}) {
  if (enabled !== true) return { ok: false, code: 'production_sync_disabled' };
  if (authorization.mode !== 'production') return { ok: false, code: 'production_not_authorized' };
  if (authorization.allowApply !== true) return { ok: false, code: 'production_not_authorized' };
  if (authorization.apply !== true) return { ok: false, code: 'production_not_authorized' };
  if (typeof authorization.expectedCanonicalVaultPath !== 'string' || path.resolve(authorization.expectedCanonicalVaultPath) !== plan.canonicalVaultRoot) {
    return { ok: false, code: 'production_not_authorized' };
  }
  if (plan.isFirstRun) {
    if (authorization.firstRunAck !== `${FIRST_RUN_ACK_PREFIX}${plan.canonicalVaultRoot}`) return { ok: false, code: 'first_run_not_acknowledged' };
    if (authorization.firstRunBackupAcknowledged !== true) return { ok: false, code: 'first_run_backup_not_acknowledged' };
  }
  return { ok: true };
}

function assertProductionAuthorized(plan, authorization) {
  const result = evaluateProductionAuthorization(plan, authorization);
  if (!result.ok) {
    const messages = {
      production_sync_disabled: 'Production Obsidian sync is disabled in this build — apply is hard-blocked pending independent review and explicit authorization',
      production_not_authorized: 'Production apply requires mode/allowApply/apply flags and an exact canonical vault-path match',
      first_run_not_acknowledged: `First production apply requires authorization.firstRunAck === "${FIRST_RUN_ACK_PREFIX}${plan.canonicalVaultRoot}"`,
      first_run_backup_not_acknowledged: 'First production apply requires authorization.firstRunBackupAcknowledged === true (backup/preview completed — see plan.rollbackPlan)'
    };
    throw new ObsidianSyncError(result.code, messages[result.code]);
  }
}

async function assertTestAuthorized(plan, authorization, fsAdapter) {
  if (authorization?.mode !== 'test') throw new ObsidianSyncError('test_not_authorized', 'authorization.mode must be "test"');
  if (authorization?.apply !== true) throw new ObsidianSyncError('test_not_authorized', 'authorization.apply must be true');
  const authorized = await testVaultMarkerAuthorized(plan.canonicalVaultRoot, fsAdapter);
  if (!authorized) throw new ObsidianSyncError('test_not_authorized', 'Apply requires a real TEST-VAULT.md file at the vault root');
}

export async function applyObsidianSync(plan, authorization = {}, options = {}) {
  const fsAdapter = options.fs || defaultFsAdapter();
  if (plan.blocked) throw new ObsidianSyncError('plan_blocked', `Cannot apply a blocked plan: ${plan.blockReason}`);
  if (plan.mode === 'production') {
    assertProductionAuthorized(plan, authorization);
  } else if (plan.mode === 'test') {
    await assertTestAuthorized(plan, authorization, fsAdapter);
  } else {
    throw new ObsidianSyncError('invalid_plan', `Unknown plan mode: ${plan.mode}`);
  }

  const deniedRoots = deniedRootsForMode(plan.mode, { extraDeniedVaultRoots: options.extraDeniedVaultRoots });
  const writableOps = plan.operations.filter(operation => operation.op === OP.CREATE || operation.op === OP.UPDATE);

  // Preflight pass (TOCTOU guard): re-resolve and re-hash every writable target BEFORE any
  // write happens. If the filesystem no longer matches what the plan observed, abort with
  // zero writes performed rather than applying a stale plan against changed reality.
  const destinations = [];
  for (const operation of writableOps) {
    const destination = await destinationForMode(plan.vaultPath, operation.relativePath, deniedRoots, fsAdapter);
    const currentContent = await readTextIfExists(fsAdapter, destination.destinationPath);
    const currentHash = currentContent === null ? null : sha256(currentContent);
    if (currentHash !== operation.previousSha256) {
      throw new ObsidianSyncError('precondition_changed', `Filesystem changed since planning: ${operation.relativePath}`, { relativePath: operation.relativePath });
    }
    destinations.push({ operation, destination });
  }

  // Write phase. Preflight above makes a mid-loop failure unlikely but not impossible (disk
  // full, permission revoked mid-run, OneDrive lock). Individual writes are atomic (temp file
  // + rename), but the loop across files is not transactional — if item N fails, items before
  // it are already committed to disk. Report that honestly instead of throwing a bare fs error
  // that looks identical to "nothing happened."
  const written = [];
  for (const { operation, destination } of destinations) {
    try {
      await writeFileAtomically(fsAdapter, destination.destinationPath, operation.content);
    } catch (err) {
      throw new ObsidianSyncError(
        'partial_apply_failure',
        `Apply failed after writing ${written.length} of ${destinations.length} file(s); ${operation.relativePath} was not written`,
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
// 36. Human-readable preview
// ---------------------------------------------------------------------------

export function formatObsidianSyncPreview(plan) {
  if (plan.blocked && plan.operations.every(operation => operation.op === OP.BLOCKED)) {
    return `Obsidian sync preview\n\nBLOCKED\n${plan.blockReason}`;
  }
  const lines = ['Obsidian sync preview', ''];
  for (const operation of plan.operations) {
    lines.push(operation.op, operation.relativePath, '');
  }
  lines.push(plan.mode === 'production'
    ? 'Production apply blocked until explicit authorization.'
    : `Test apply ${plan.blocked ? 'blocked: unresolved conflicts.' : 'requires --apply plus a TEST-VAULT.md marker.'}`);
  return lines.join('\n').trimEnd();
}
