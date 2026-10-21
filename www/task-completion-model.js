// TASK-018: resolution facts only. No task copies or historical plan mutations.
import { physicalTargetKey, originOf, isActionPlanItem } from './plan-item-origin.js';
import { validPlanDate, validPlanTimezone, localPlanDate } from './plan-tomorrow-model.js';
export const COMPLETION_PATH = 'taskCompletionResolutions';
export const COMPLETION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = COMPLETION_UUID;
const fail = reason => { throw Object.assign(new Error(reason), { reason }); };
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('MALFORMED');
}
export function canonicalCompletion(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalCompletion).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalCompletion(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export async function completionDigest(value) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new globalThis.TextEncoder().encode(canonicalCompletion(value)));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
// Firebase prunes nullable/empty object fields. The source comparison never uses title or timestamp alone.
export function completionWireValue(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(item => completionWireValue(item) ?? null);
  if (typeof value === 'object') {
    const fields = Object.entries(value).map(([key, item]) => [key, completionWireValue(item)]).filter(([, item]) => item !== undefined);
    return fields.length ? Object.fromEntries(fields) : undefined;
  }
  return value;
}
export function completionIdentity(target, item) {
  const origin = originOf(item) || (isActionPlanItem(item) ? { creationActionId: item.creationActionId } : 'unmarked');
  const identity = { store: target.store, targetId: target.id, itemId: item.id, representation: origin === 'unmarked' ? 'array' : 'fence', origin };
  if (!physicalTargetKey(identity.store, identity.targetId)) fail('IDENTITY');
  return identity;
}
export function validateCompletionRecord(record, uid) {
  if (!record) return;
  keys(record, ['v', 'identity', 'revision', 'state', 'completionOpId', 'operations']);
  if (record.v !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1
      || record.revision >= Number.MAX_SAFE_INTEGER || !['completed', 'open'].includes(record.state)
      || !record.operations || typeof record.operations !== 'object' || Array.isArray(record.operations)) fail('RECORD_CONFLICT');
  const ordered = Object.entries(record.operations).sort((a, b) => a[1].revision - b[1].revision);
  if (ordered.length !== record.revision) fail('RECORD_CONFLICT');
  let completedBy = null, state = 'open';
  for (const [index, [id, receipt]] of ordered.entries()) {
    keys(receipt, ['intentHash', 'kind', 'revision', 'recordedAt', 'actorUid', 'sourceRevision',
      ...(receipt.kind === 'complete' ? ['date', 'timezone'] : ['undoOf'])]);
    if (!UUID.test(id) || receipt.revision !== index + 1 || receipt.actorUid !== uid
        || typeof receipt.intentHash !== 'string' || receipt.intentHash.length !== 43
        || typeof receipt.sourceRevision !== 'string' || receipt.sourceRevision.length !== 43
        || !Number.isFinite(receipt.recordedAt) || receipt.recordedAt <= 0) fail('RECORD_CONFLICT');
    if (receipt.kind === 'complete') {
      if (state !== 'open' || !validPlanDate(receipt.date) || !validPlanTimezone(receipt.timezone)
          || receipt.date > localPlanDate(receipt.recordedAt, receipt.timezone)) fail('RECORD_CONFLICT');
      completedBy = id; state = 'completed';
    } else {
      if (receipt.kind !== 'undo' || state !== 'completed' || receipt.undoOf !== completedBy) fail('RECORD_CONFLICT');
      state = 'open';
    }
  }
  if (record.state !== state || record.completionOpId !== completedBy) fail('RECORD_CONFLICT');
}
