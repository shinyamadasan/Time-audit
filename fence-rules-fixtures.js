// fence-rules-fixtures.js
//
// Test-only (never loaded by index.html). The wire-shaped fixtures every rules suite
// shares: a capture, its (fenced) claim/promotion, and a fenced plan item, per physical
// store, built from the REAL contract (plan-item-origin.js's physicalTargetKey), never
// from guessed strings.

import { ROOM, token } from './rtdb-emulator-support.js';
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

// ── Action API plan items (TASK-011, DECISIONS #37) ─────────────────────────
export const ACTION_A = 'act1_0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
export const ACTION_B = 'act1_1c9a2d3e-4f5a-4b6c-9d7e-8f9012a3b4c5';
export const ACTION_PLAN = STORES.calendar.targetId;
export const ACTION_OTHER_PLAN = STORES.calendar.otherId;
export const actionItemId = actionId => `api1_${actionId.slice(5)}`;
export const actionItemAt = (actionId = ACTION_A, planId = ACTION_PLAN) => `${ROOM}/${FENCE_REMOTE_PATHS.calendar}/${planId}/${actionItemId(actionId)}`;
/** The backend's action-scoped owner token: exactly the claims the Function mints for one plan_create. */
export const planActionToken = (actionId = ACTION_A, { target = ACTION_PLAN, kind = 'plan_create', uid = 'alice' } = {}) => token(uid,
  { chronasenseActionId: actionId, ...(kind === null ? {} : { chronasenseActionKind: kind }), ...(target === null ? {} : { chronasenseActionTarget: target }) });
export const actionItem = (extra = {}) => ({
  id: actionItemId(ACTION_A), task: 'Gym', when: '18:00', whenTz: 'Asia/Manila', durationMinutes: 60, done: false,
  updatedAt: T, updatedBy: 'actor1:test', kind: 'task', creationActionId: ACTION_A, ...extra,
});
export const authorityFact = { schemaVersion: 1, id: 'fact1', activatedAtMs: T, timezone: 'Asia/Manila', activationDate: '2026-10-01', deviceId: 'd' };
export const seedCalendarAuthority = db => db.seed(`${ROOM}/calendarPlanAuthority/fact1`, authorityFact);
