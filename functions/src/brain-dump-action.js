// One user-intended create, one deterministic domain key. The private receipt serializes attempts;
// the user-scoped RTDB conditional create prevents a second effect even across lease expiry/crash.
import { buildCapture, normalizeCapture } from '../shared/brain-dump-model.js';
import { captureRevision } from './brain-dump-query.js';
import { captureIdForAction } from './command-identity.js';
import { ApiError } from './errors.js';
import { canonicalRequestHash, classifyExistingReceipt } from './receipts.js';

const LEASE_MS = 30_000;
const pending = () => new ApiError('PENDING_UNKNOWN', 'The create outcome is being reconciled. Retry with the same action ID and a new request ID.', { reason: 'capture-outcome-unknown' });
const conflict = reason => new ApiError('CONFLICT', 'The action ID is occupied by an incompatible capture.', { reason });

function actionOwnedCapture(raw, actionId, captureId, createdAt) {
  if (raw === null) return null;
  const capture = normalizeCapture(raw);
  if (!capture || capture.id !== captureId || capture.creationActionId !== actionId || capture.createdAt !== createdAt) {
    throw conflict('capture-attribution-mismatch');
  }
  return capture;
}

function resultFor(capture, actionId) {
  return { actionId, captureId: capture.id, text: capture.text, status: capture.status,
    createdAt: new Date(capture.createdAt).toISOString(), revision: captureRevision(capture) };
}

async function settle(receipts, identity, actionId, snapshot, update) {
  const receipt = { ...snapshot.value, ...update, updatedAt: update.updatedAt };
  if ((await receipts.compareAndSet(identity.firebaseUid, actionId, receipt, snapshot.etag)) === 'written') return receipt;
  throw pending();
}

export async function createBrainDumpAction(identity, { command, domain, receipts, attemptId, nowMs }) {
  const { actionId, actionProvenance } = command;
  const captureId = captureIdForAction(actionId);
  const requestHash = canonicalRequestHash(command);
  const claim = await receipts.claim({ firebaseUid: identity.firebaseUid, actionId, requestHash,
    kind: command.kind, attemptId, nowMs, leaseMs: LEASE_MS, plannedRecordId: captureId,
    authorizationContext: { actorRef: actionProvenance.actorRef, requiredScope: 'chronasense:brain-dump.write',
      grantedScopes: identity.scopes, serviceIdentity: 'chronasense-plugin-worker-v1' },
    actionProvenanceRefs: { sourceKind: actionProvenance.sourceKind, capturedAt: actionProvenance.capturedAt } });
  let snapshot = await receipts.readWithEtag(identity.firebaseUid, actionId);
  if (!snapshot.value) throw pending();
  const existing = snapshot.value;
  if (existing.requestHash !== requestHash || existing.kind !== command.kind) {
    throw new ApiError('IDEMPOTENCY_CONFLICT', 'This action ID was used for a different command.', { reason: 'action-id-reuse' });
  }
  if (existing.plannedRecordId !== captureId) throw conflict('receipt-record-id-mismatch');
  if (existing.state === 'applied') {
    return { result: { ...existing.result, idempotentReplay: true }, authority: existing.authority };
  }
  if (['conflict', 'rejected', 'needs_user_decision'].includes(existing.state)) {
    throw conflict('terminal-receipt');
  }
  if (!['started', 'pending_unknown'].includes(existing.state)) throw conflict('malformed-receipt-state');
  if (!claim.claimed) {
    const mode = classifyExistingReceipt(existing, { requestHash, nowMs });
    if (mode === 'lease_active') throw pending();
    const takeover = { ...existing, attemptId, leaseAcquiredAt: nowMs, leaseExpiresAt: nowMs + LEASE_MS,
      updatedAt: nowMs };
    if ((await receipts.compareAndSet(identity.firebaseUid, actionId, takeover, snapshot.etag)) !== 'written') throw pending();
    snapshot = await receipts.readWithEtag(identity.firebaseUid, actionId);
  }
  if (snapshot.value?.attemptId !== attemptId || snapshot.value.requestHash !== requestHash) throw pending();
  const createdAt = snapshot.value.createdAt;
  const built = buildCapture({ id: captureId, text: command.parameters.text, now: createdAt,
    updatedBy: actionProvenance.actorRef, creationActionId: actionId });
  if (!built.ok) throw new ApiError('INVALID_INPUT', 'The capture could not be created.', { reason: `capture-${built.field}` });

  try { await domain.createCaptureIfAbsent(identity, captureId, actionId, built.record); }
  catch (error) {
    if (error.code === 'FORBIDDEN') {
      await settle(receipts, identity, actionId, snapshot, { state: 'rejected', resultCode: 'FORBIDDEN', updatedAt: nowMs });
      throw error;
    }
    if (error.code !== 'RETRYABLE_TRANSPORT') throw error;
  }
  let capture;
  try { capture = actionOwnedCapture(await domain.readCapture(identity, captureId), actionId, captureId, createdAt); }
  catch (error) {
    if (error.code === 'CONFLICT') {
      await settle(receipts, identity, actionId, snapshot, { state: 'conflict', resultCode: 'CONFLICT', updatedAt: nowMs });
      throw error;
    }
    await settle(receipts, identity, actionId, snapshot, { state: 'pending_unknown', leaseExpiresAt: nowMs, updatedAt: nowMs });
    throw pending();
  }
  if (!capture) {
    await settle(receipts, identity, actionId, snapshot, { state: 'pending_unknown', leaseExpiresAt: nowMs, updatedAt: nowMs });
    throw pending();
  }
  const result = resultFor(capture, actionId);
  const authority = { authority: 'brain_dump_capture', store: 'brainDump', access: 'user_scoped',
    recordIds: [captureId], readAt: new Date(nowMs).toISOString() };
  const receipt = await settle(receipts, identity, actionId, snapshot, { state: 'applied', recordIds: [captureId],
    authority, result, resultingRevision: result.revision, appliedAt: nowMs, updatedAt: nowMs,
    resultCode: 'APPLIED', retryability: 'not_retryable' });
  return { result: { ...receipt.result, idempotentReplay: !claim.claimed }, authority: receipt.authority };
}
