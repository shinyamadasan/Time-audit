// LOCAL PROOF ONLY. Not imported by the app. Canonical rules and the time engine stay unchanged.
import { readFileSync } from 'node:fs';

export const CANCEL = 'timeAckCancellations';
const clone = value => JSON.parse(JSON.stringify(value));

/** A permanent, owner-scoped deny fence for the ORIGINAL stamped operation, not a new Undo. */
export function cancellationRules() {
  // Historical primitive/counterexamples stay pinned to their original rule surface.
  const result = JSON.parse(readFileSync(new URL('../accounting-hazards/canonical-before-unified.json', import.meta.url), 'utf8'));
  const room = result.rules.rooms.$roomId;
  const allowed = "auth != null && $roomId === ('uid_' + auth.uid) && auth.token.chronasenseActionId == null";
  room[CANCEL] = { $operationId: {
    '.write': `${allowed} && newData.val() === true && (!data.exists() || data.val() === true)`,
  } };
  for (const node of [room.timer, room.entries.$entryId]) {
    node['.write'] = `(${node['.write']}) && (!newData.child('_csWrite').child('operationId').exists() || !root.child('rooms').child($roomId).child('${CANCEL}').child(newData.child('_csWrite').child('operationId').val()).exists())`;
  }
  // This collection grants at parent level, so each non-null stamped record needs validation.
  room.focusRedemptions.$redemptionId = {
    '.validate': `!newData.child('_csWrite').child('operationId').exists() || !root.child('rooms').child($roomId).child('${CANCEL}').child(newData.child('_csWrite').child('operationId').val()).exists()`,
  };
  return result;
}

/**
 * Proof of user-confirmed cancellation + coherent account readback. It never rewrites the Undo,
 * calls its applier, retires its envelope, or releases the app's accounting barrier.
 * The separate durable resolution intent allows retry after an offline/lost-response interruption.
 * transport is emulator-only; receipt authority depends on the above rules being installed.
 */
export function createRecoveryProof({ storage, lock, transport, attached }) {
  return async function keepServerVersion(owner, operation) {
    return lock(owner, async () => {
      if (!operation || operation.owner !== owner || owner !== `uid_${operation.uid}` || !attached(operation)) {
        return { status: 'blocked', reason: 'account-device-context' };
      }
      const key = `ta3-time-ack-resolution-proof:${owner}:${operation.id}`;
      // Phase/evidence/attempt counters may change during ordinary observation. Intent may not.
      const frozen = clone(Object.fromEntries(['id', 'owner', 'uid', 'device', 'session', 'label',
        'actionCreatedAt', 'createdAt', 'before', 'patch', 'local', 'proposedLocal'].map(field => [field, operation[field]])));
      const raw = storage.getItem(key);
      const intent = raw ? JSON.parse(raw) : { v: 1, owner, id: operation.id, operation: frozen };
      if (JSON.stringify(intent.operation) !== JSON.stringify(frozen)) throw new Error('Original intent changed');
      // Durable, exact original identity before any send. No timeout-based retirement.
      const encoded = JSON.stringify(intent);
      storage.setItem(key, encoded);
      if (storage.getItem(key) !== encoded) throw new Error('Resolution intent readback failed');
      try {
        // Idempotent PUT is smaller than a transaction/CAS: true can never change or be deleted.
        // A request that races this either commits BEFORE the fence, or is atomically refused.
        await transport.cancel(owner, operation.id);
        const snapshot = await transport.readAccount(owner);
        if (!attached(operation)) return { status: 'blocked', reason: 'account-device-context' };
        if (snapshot?.[CANCEL]?.[operation.id] !== true) return { status: 'blocked', reason: 'no-fence-proof' };
        return { status: 'fenced', owner, id: operation.id, snapshot };
      } catch {
        return { status: 'unknown', reason: 'cancellation-or-read-unconfirmed' };
      }
    });
  };
}

/** A clean-frame reconciliation candidate; no writes, arithmetic, LWW merge or stale cursor replay. */
export function reconcileCandidate({ proof, operation, local, same }) {
  if (proof.status !== 'fenced' || proof.owner !== operation.owner || proof.id !== operation.id) {
    return { status: 'blocked', reason: 'no-fence-proof' };
  }
  const server = proof.snapshot;
  if (!local.timer || ![operation.before.timer, operation.patch.timer, server.timer].some(timer => same(local.timer, timer))) {
    return { status: 'blocked', reason: 'unreconciled-local-timer' };
  }
  // Local-only/newer accounting facts must not be discarded to make an exit possible.
  for (const [store, prefix] of [['entries', 'e_'], ['focusRedemptions', 'r_']]) {
    for (const record of local[store] || []) {
      const path = `${store}/${prefix}${record.id}`;
      const actual = server[store]?.[`${prefix}${record.id}`] ?? null;
      if (!same(record, actual) && !same(record, operation.local.records?.[path])) {
        return { status: 'blocked', reason: 'unreconciled-local-accounting' };
      }
    }
  }
  if (server.timer?.ownerRoom !== operation.owner) return { status: 'blocked', reason: 'timer-owner-unproven' };
  return { status: 'candidate', owner: operation.owner,
    entries: Object.values(server.entries || {}), focusRedemptions: Object.values(server.focusRedemptions || {}),
    timer: clone(server.timer),
    cursor: { taskStartTime: server.timer.taskStartTime, blockStartTime: server.timer.blockStartTime,
      trackingStartedAt: server.timer.trackingStartedAt, timerOwnerDeviceId: server.timer.ownerDeviceId },
  };
}
