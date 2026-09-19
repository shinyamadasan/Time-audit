// Pure relocation authority for one immutable plan-item id across day records.
// This is metadata on the existing item, not another plan store.

export const PLAN_ITEM_RELOCATION_SCHEMA_VERSION = 1;

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizePlanItemRelocation(value) {
  const relocation = value?.relocationRevision;
  if (!relocation || typeof relocation !== 'object') return null;
  const sequence = Number(relocation.sequence);
  if (relocation.schemaVersion !== PLAN_ITEM_RELOCATION_SCHEMA_VERSION || !Number.isInteger(sequence) || sequence < 1) return null;
  if (typeof relocation.fromDayId !== 'string' || !relocation.fromDayId) return null;
  if (typeof relocation.toDayId !== 'string' || !relocation.toDayId || relocation.toDayId === relocation.fromDayId) return null;
  if (typeof relocation.updatedBy !== 'string' || !relocation.updatedBy) return null;
  const normalized = {
    schemaVersion: PLAN_ITEM_RELOCATION_SCHEMA_VERSION,
    sequence,
    fromDayId: relocation.fromDayId,
    toDayId: relocation.toDayId,
    updatedBy: relocation.updatedBy,
  };
  const updatedAt = Number(relocation.updatedAt);
  if (Number.isFinite(updatedAt) && updatedAt > 0) normalized.updatedAt = updatedAt;
  return normalized;
}

function relocationTieKey(relocation) {
  // `updatedAt` is deliberately absent: equal-sequence concurrent moves resolve
  // by immutable day/writer facts, never by arrival order or clock skew.
  return `${relocation.updatedBy}\u0000${relocation.fromDayId}\u0000${relocation.toDayId}`;
}

export function comparePlanItemRelocations(aValue, bValue) {
  const a = normalizePlanItemRelocation(aValue);
  const b = normalizePlanItemRelocation(bValue);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
  return compareStrings(relocationTieKey(a), relocationTieKey(b));
}

export function samePlanItemRelocation(aValue, bValue) {
  const a = normalizePlanItemRelocation(aValue);
  const b = normalizePlanItemRelocation(bValue);
  return !!a && !!b && a.sequence === b.sequence && relocationTieKey(a) === relocationTieKey(b);
}

export function nextPlanItemRelocation(item, { fromDayId, toDayId, updatedAt, updatedBy }) {
  if (typeof fromDayId !== 'string' || !fromDayId || typeof toDayId !== 'string' || !toDayId || fromDayId === toDayId) {
    throw new Error('A relocation needs two distinct authoritative day identities.');
  }
  if (typeof updatedBy !== 'string' || !updatedBy) throw new Error('A relocation writer is required.');
  const previous = normalizePlanItemRelocation(item);
  const revision = {
    schemaVersion: PLAN_ITEM_RELOCATION_SCHEMA_VERSION,
    sequence: (previous?.sequence || 0) + 1,
    fromDayId,
    toDayId,
    updatedBy,
  };
  if (Number.isFinite(Number(updatedAt)) && Number(updatedAt) > 0) revision.updatedAt = Number(updatedAt);
  return revision;
}

/** Highest relocation revision for each immutable item id across every known day. */
export function canonicalPlanItemRelocations(dayRecords = {}) {
  const byItemId = new Map();
  for (const record of Object.values(dayRecords || {})) {
    const items = Array.isArray(record?.items) ? record.items : [];
    for (const item of items) {
      if (!item?.id || !normalizePlanItemRelocation(item)) continue;
      const current = byItemId.get(item.id);
      if (!current || comparePlanItemRelocations(item, current) > 0) byItemId.set(item.id, item);
    }
  }
  return byItemId;
}

/** Projection rule: a relocated id is active only at its canonical destination. */
export function planItemIsActiveInDay(item, dayId, canonicalByItemId) {
  if (!item || item.deleted === true) return false;
  const canonical = canonicalByItemId?.get(item.id);
  if (!canonical) return true;
  const relocation = normalizePlanItemRelocation(canonical);
  return relocation.toDayId === dayId && samePlanItemRelocation(item, canonical);
}
