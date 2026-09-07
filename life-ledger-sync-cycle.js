import crypto from 'node:crypto';
import {
  createObsidianSyncTarget,
  planObsidianSync,
  prepareObsidianRollbackArtifact,
  verifyObsidianRollbackReceipt,
  applyObsidianSync,
  ObsidianSyncError,
  OBSIDIAN_SYNC_OPERATIONS
} from './obsidian-life-ledger-sync.js';
import { defaultFsAdapter } from './obsidian-life-ledger-writer.js';
import { parseLifeLedgerSnapshotJson } from './life-ledger-transport.js';

// Phase 10 — the "existing-root safe sync transaction". This module is pure orchestration: it
// composes the already-reviewed Phase 9 primitives (plan / prepare-rollback / verify-rollback /
// apply) from obsidian-life-ledger-sync.js into the one full cycle described by the Phase 10
// spec, and classifies the outcome into a small closed set of states a background worker (or a
// human running one diagnostic cycle) can act on without inspecting hashes or manifests.
//
// It never invents new safety logic — every write-path guarantee (precondition re-check,
// conflict detection, atomic per-file write, fail-closed authorization) already lives in
// obsidian-life-ledger-sync.js and is exercised unchanged here.

const OP = OBSIDIAN_SYNC_OPERATIONS;

export const LIFE_LEDGER_SYNC_CYCLE_SCHEMA_VERSION = 1;

// Closed outcome vocabulary. A caller (CLI, status UI) should switch on these exact strings.
export const LIFE_LEDGER_SYNC_OUTCOMES = Object.freeze([
  'no_source', // no outbox snapshot was supplied — nothing to do (e.g. background sync not enabled yet)
  'unchanged', // snapshot parsed fine, vault already reflects it — zero writes
  'would_sync', // dryRun only: safe changes exist and were identified, but nothing was touched
  'synced', // safe changes existed, a fresh rollback artifact was prepared, apply succeeded and verified
  'conflict', // ownership/content conflict detected — fail closed, zero writes, safe to re-run later
  'intervention_required', // apply started writing and something went wrong, or post-apply state doesn't verify — do NOT auto-retry
  'error' // infrastructure/config failure before any write was attempted — safe to retry later
]);

export class LifeLedgerSyncCycleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LifeLedgerSyncCycleError';
    this.code = code;
    Object.assign(this, details);
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function isoNow(clock) {
  return (typeof clock === 'function' ? new Date(clock()) : new Date()).toISOString();
}

/**
 * Run exactly one Life Ledger -> Obsidian sync cycle against a real (or disposable temp)
 * existing-root vault. Never creates a managed root and never supplies a first-run
 * acknowledgement on a human's behalf — Phase 10 automation only ever touches an
 * already-owned managed root.
 *
 * @param {object} options
 * @param {string} options.runId - caller-supplied unique id for this run (used for logging only)
 * @param {function} [options.clock] - () => Date|number|string, for deterministic tests
 * @param {string|null} options.outboxSnapshotJson - raw JSON text of the latest outbox snapshot,
 *   or null/undefined if no outbox has been written yet
 * @param {string} options.vaultPath - the vault root to sync into
 * @param {string} options.expectedCanonicalVaultPath - required production identity guard
 * @param {string} options.backupRoot - a FRESH, not-yet-existing directory (outside the vault)
 *   to prepare this run's rollback artifact into, if a changing apply turns out to be needed
 * @param {object} [options.fs] - fs adapter override (defaults to the real filesystem)
 * @returns {Promise<object>} a result object; see LIFE_LEDGER_SYNC_OUTCOMES for `outcome`
 */
export async function runLifeLedgerSyncCycle(options = {}) {
  const {
    runId,
    clock,
    outboxSnapshotJson,
    vaultPath,
    expectedCanonicalVaultPath,
    backupRoot,
    fs: fsAdapter = defaultFsAdapter()
  } = options;

  if (typeof runId !== 'string' || !runId.trim()) {
    throw new LifeLedgerSyncCycleError('invalid_options', 'runId is required');
  }
  const startedAt = isoNow(clock);
  const finish = fields => Object.freeze({ ...fields, runId, startedAt, endedAt: isoNow(clock) });

  if (outboxSnapshotJson == null) {
    return finish({
      outcome: 'no_source',
      message: 'No outbox snapshot is available yet — background sync has not been enabled, or has not written anything yet.'
    });
  }

  let snapshot;
  let outboxSha256;
  try {
    outboxSha256 = sha256(String(outboxSnapshotJson));
    snapshot = parseLifeLedgerSnapshotJson(outboxSnapshotJson);
  } catch (err) {
    return finish({
      outcome: 'error', category: 'before_write', reason: 'invalid_outbox_snapshot',
      message: err.message, outboxSha256
    });
  }

  let target;
  try {
    target = createObsidianSyncTarget({ vaultPath, mode: 'production', allowApply: true });
  } catch (err) {
    return finish({
      outcome: 'error', category: 'before_write', reason: err.code || 'invalid_target',
      message: err.message, outboxSha256
    });
  }

  let plan;
  try {
    plan = await planObsidianSync(target, snapshot.events, { fs: fsAdapter, expectedCanonicalVaultPath });
  } catch (err) {
    return finish({
      outcome: 'error', category: 'before_write', reason: err.code || 'plan_failed',
      message: err.message, outboxSha256
    });
  }

  const base = { outboxSha256, planFingerprint: plan.planFingerprint, eventCount: snapshot.events.length };

  if (plan.blockState === 'identity') {
    return finish({ ...base, outcome: 'error', category: 'before_write', reason: plan.blockReason, message: `Vault identity check failed: ${plan.blockReason}` });
  }

  // A first-run state means the managed root this run expected to already own is, in fact,
  // absent. Phase 10 automation NEVER creates a managed root or supplies a first-run
  // acknowledgement on a human's behalf — recreating a whole managed subtree from scratch is a
  // one-time, irreversible decision that stays manual (see scripts/sync-life-ledger-to-obsidian.mjs
  // --first-run-ack). Treat it as requiring intervention, not as a routine conflict to wait out.
  if (plan.isFirstRun) {
    return finish({
      ...base, outcome: 'intervention_required', category: 'before_write', reason: 'unexpected_first_run_state',
      message: 'The managed Life Ledger root is absent. Automation refuses to create it — run the CLI manually with --first-run-ack after confirming this is expected.'
    });
  }

  if (plan.blockState === 'unmanaged_conflict' || plan.blockState === 'invalid_sentinel') {
    return finish({ ...base, outcome: 'conflict', reason: plan.blockReason, message: `Managed root ownership could not be verified: ${plan.blockReason}` });
  }

  if (plan.blocked) {
    const conflicts = plan.operations
      .filter(op => op.op === OP.CONFLICT)
      .map(op => ({ relativePath: op.relativePath, reason: op.reason }));
    return finish({
      ...base, outcome: 'conflict', reason: plan.blockReason || 'unresolved_conflicts', conflicts,
      message: `${conflicts.length} file(s) are in conflict and were not touched.`
    });
  }

  const writableOps = plan.operations.filter(op => op.op === OP.CREATE || op.op === OP.UPDATE);
  if (writableOps.length === 0) {
    return finish({ ...base, outcome: 'unchanged', message: 'Life Ledger is already reflected in Obsidian — nothing to write.' });
  }

  if (options.dryRun === true) {
    return finish({
      ...base, outcome: 'would_sync',
      operations: writableOps.map(op => ({ relativePath: op.relativePath, op: op.op, reason: op.reason })),
      message: `${writableOps.length} file(s) would be written (dry run — nothing applied).`
    });
  }

  // Safe changes exist. Prepare a FRESH existing-root rollback artifact before touching anything
  // in the vault. backupRoot must be a not-yet-existing directory the caller owns for this run.
  let receipt;
  try {
    receipt = await prepareObsidianRollbackArtifact({ target, plan, backupRoot, fs: fsAdapter });
  } catch (err) {
    return finish({
      ...base, outcome: 'error', category: 'before_write', reason: err.code || 'rollback_artifact_failed', message: err.message
    });
  }

  const receiptValid = await verifyObsidianRollbackReceipt(receipt, { target, plan, fs: fsAdapter });
  if (!receiptValid) {
    return finish({
      ...base, outcome: 'error', category: 'before_write', reason: 'receipt_self_verification_failed',
      message: 'The rollback artifact just written did not verify against its own plan — refusing to apply.',
      receiptPath: receipt.receiptPath
    });
  }

  const authorization = {
    mode: 'production', allowApply: true, apply: true, expectedCanonicalVaultPath, rollbackReceipt: receipt
  };

  let applyResult;
  try {
    applyResult = await applyObsidianSync(plan, authorization, { fs: fsAdapter });
  } catch (err) {
    if (err instanceof ObsidianSyncError && err.code === 'partial_apply_failure') {
      // Writes were IN PROGRESS when this failed. Never auto-retry — surface exact evidence.
      return finish({
        ...base, outcome: 'intervention_required', category: 'after_write_partial', reason: err.code,
        written: err.written, failedRelativePath: err.failedRelativePath, message: err.message,
        receiptPath: receipt.receiptPath
      });
    }
    if (err instanceof ObsidianSyncError && err.code === 'precondition_changed') {
      // Thrown during the Fix-6 preflight, strictly before any write in this apply call.
      return finish({
        ...base, outcome: 'conflict', category: 'before_write', reason: err.code,
        relativePath: err.relativePath, message: err.message, receiptPath: receipt.receiptPath
      });
    }
    const reason = err instanceof ObsidianSyncError ? err.code : 'apply_failed';
    return finish({ ...base, outcome: 'error', category: 'before_write', reason, message: err.message, receiptPath: receipt.receiptPath });
  }

  // Verify resulting state: replan read-only and confirm the vault now fully reflects the
  // snapshot we just applied. Apply already happened — this cannot undo it, only report.
  let verifyPlan;
  try {
    verifyPlan = await planObsidianSync(target, snapshot.events, { fs: fsAdapter, expectedCanonicalVaultPath });
  } catch (err) {
    return finish({
      ...base, outcome: 'intervention_required', category: 'after_write_verification', reason: 'post_apply_verification_failed',
      message: err.message, written: applyResult.written, receiptPath: receipt.receiptPath
    });
  }
  const stillWritable = verifyPlan.operations.some(op => op.op === OP.CREATE || op.op === OP.UPDATE);
  if (verifyPlan.blocked || stillWritable) {
    return finish({
      ...base, outcome: 'intervention_required', category: 'after_write_verification', reason: 'post_apply_state_mismatch',
      message: 'Apply completed but the vault does not verify as fully synced immediately afterward.',
      written: applyResult.written, receiptPath: receipt.receiptPath
    });
  }

  return finish({
    ...base, outcome: 'synced',
    written: applyResult.written, unchanged: applyResult.unchanged, stale: applyResult.stale,
    receiptPath: receipt.receiptPath,
    message: `Synced ${applyResult.written.length} file(s) to Obsidian.`
  });
}

// Trims a cycle result to the small, non-sensitive subset appropriate for writing back into the
// browser-writable outbox folder, so the Settings UI can render truthful status without ever
// reading the vault or backup filesystem directly. No paths outside the outbox folder itself,
// no receipt contents, no vault contents — just enough to answer "is this specific outbox
// snapshot synced yet, and if not, why".
export function summarizeCycleResultForOutbox(result) {
  return Object.freeze({
    schemaVersion: LIFE_LEDGER_SYNC_CYCLE_SCHEMA_VERSION,
    runId: result.runId,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    outboxSha256: result.outboxSha256 || null,
    outcome: result.outcome,
    category: result.category || null,
    reason: result.reason || null,
    message: result.message || '',
    eventCount: typeof result.eventCount === 'number' ? result.eventCount : null,
    writtenCount: Array.isArray(result.written) ? result.written.length : 0
  });
}
