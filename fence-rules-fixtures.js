// fence-rules-fixtures.js
//
// Test-only (never loaded by index.html). The wire-shaped fixtures every rules suite
// shares: a capture, its (fenced) claim/promotion, and a fenced plan item, per physical
// store, built from the REAL contract (plan-item-origin.js's physicalTargetKey), never
// from guessed strings.

import { ROOM } from './rtdb-emulator-support.js';
import { FENCE_REMOTE_PATHS, physicalTargetKey } from './plan-item-origin.js';

export const T = 1790816400000;
export const CAPTURE = 'bfence1';
export const ITEM_ID = `bdp1|${CAPTURE}`;

const OP_DAY = 'odv1:rev-a1:Asia/Manila:2026-10-03';
const OP_OTHER = 'odv1:rev-a1:Asia/Manila:2026-10-04';

/** Per store: the plan target id, its physical key, a sibling target (a different day), and the
 *  paths of the ordinary plan record and of the fence collection. */
export const STORES = {
  calendar: { store: 'calendar', targetId: 'cal1:2026-10-03', otherId: 'cal1:2026-10-04', plans: 'calendarPlans' },
  legacy: { store: 'legacy', targetId: '2026-10-03', otherId: '2026-10-04', plans: 'plans' },
  operational: { store: 'operational', targetId: OP_DAY, otherId: OP_OTHER, plans: 'operationalPlans' },
};
for (const def of Object.values(STORES)) {
  def.key = physicalTargetKey(def.store, def.targetId);
  def.otherKey = physicalTargetKey(def.store, def.otherId);
  def.fence = FENCE_REMOTE_PATHS[def.store];
  def.planAt = `${ROOM}/${def.plans}/${def.key}`;
  def.fenceAt = key => `${ROOM}/${def.fence}/${key}/${ITEM_ID}`;
  def.itemAt = def.fenceAt(def.key);
}

export const captureAt = (id = CAPTURE) => `${ROOM}/brainDump/${id}`;

/** A claim carrying the physical location (a fenced, post-fence claim). */
export const claim = (def, extra = {}) => ({
  type: 'do-today', store: def.store, targetId: def.targetId, targetKey: def.key, planItemId: ITEM_ID, when: '', claimedAt: T + 1, claimedBy: 'd', ...extra,
});
/** A pre-fence claim (no targetKey), exactly what a cf43080 client writes. */
export const legacyClaim = (def, extra = {}) => ({
  type: 'do-today', store: def.store, targetId: def.targetId, planItemId: ITEM_ID, when: '', claimedAt: T + 1, claimedBy: 'old', ...extra,
});
export const promotion = (def, extra = {}) => ({
  type: 'do-today', store: def.store, targetId: def.targetId, targetKey: def.key, planItemId: ITEM_ID, intentRecorded: true, when: '', promotedAt: T + 3, ...extra,
});
export const capture = (extra = {}) => ({
  schemaVersion: 2, id: CAPTURE, text: 'x', createdAt: T, updatedAt: T, updatedBy: 'd', status: 'triaged', important: true, urgent: false, triagedAt: T, reopenCount: 0, ...extra,
});
export const promotedCapture = (def, extra = {}) => capture({ status: 'promoted', disposedAt: T + 3, promotion: promotion(def), ...extra });
export const expired = (def, extra = {}) => ({ ...claim(def), expiredAt: T + 6, expiredBy: 'b', ...extra });

export const origin = (def, extra = {}) => ({ v: 2, claimEpoch: 0, type: 'do-today', store: def.store, targetKey: def.key, ...extra });
export const fencedItem = (def, extra = {}) => {
  const { origin: originExtra, ...fields } = extra;
  return { id: ITEM_ID, task: 'x', when: '', done: false, updatedAt: T, updatedBy: 'd', kind: 'task', brainDumpOrigin: origin(def, originExtra), ...fields };
};
export const ordinary = { id: 'pnormal1', task: 'ordinary', when: '', done: false, updatedAt: T, updatedBy: 'd' };
export const planRecord = items => ({ items, updatedAt: T, updatedBy: 'd' });
