// operational-plan-repository.js
//
// Local persistence for the operational-day-keyed plan store — the authority
// resolvePlanAuthority() (operational-plan-model.js) routes to for any
// non-legacy operational day (contract §9). Keyed by operationalDayId, never
// by a bare date (§10), and structurally independent of `plans[dateKey]` —
// this file never reads, writes, or migrates a legacy plan record (§8, §13).
//
// Storage shape (envelope): { schemaVersion: 1, plans: { [operationalDayId]: PlanRecord } }.
// PlanRecord is structurally the SAME shape as the legacy plans[dateKey] record
// (items[], updatedAt, updatedBy, preparation?) — only the key and the
// preparation contract differ (§15). Reuses the legacy `p<base36><random>` item
// id shape is the caller's business (this file never mints item ids); this
// file only validates and stores whatever item shape it is given.
//
// "Absence is not migration" (§13): read() for an id with nothing stored
// returns null. It never falls back to the legacy plans[dateKey] record, and
// it never copies one in on read. There is no method on this repository that
// reads plans[dateKey] at all — the absence of such a method IS the guarantee.

import { validateOperationalPlanItemRange, mergeOperationalPlanRecords, OPERATIONAL_PLAN_SCHEMA_VERSION } from './operational-plan-model.js';
import { parseOperationalDayId } from './personal-day-boundary-model.js';

export const OPERATIONAL_PLAN_STORAGE_KEY = 'ta3-operational-plans-v1';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultStorage() {
  if (globalThis.localStorage) return globalThis.localStorage;
  throw new Error('Operational plan storage is unavailable.');
}

function normalizeItems(items) {
  if (Array.isArray(items)) return items.filter(item => item && typeof item === 'object');
  if (items && typeof items === 'object') return Object.values(items).filter(item => item && typeof item === 'object');
  return [];
}

function readEnvelope(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return { schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION, plans: {} };
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`Operational plan storage key ${key} contains malformed JSON.`);
  }
  if (!isPlainObject(envelope) || envelope.schemaVersion !== OPERATIONAL_PLAN_SCHEMA_VERSION || !isPlainObject(envelope.plans)) {
    throw new Error('Operational plan storage has an unsupported format or schema version.');
  }
  Object.keys(envelope.plans).forEach(id => {
    if (!parseOperationalDayId(id)) throw new Error(`Operational plan storage has an invalid operationalDayId key: ${id}`);
  });
  return envelope;
}

function writeEnvelope(storage, key, envelope) {
  storage.setItem(key, JSON.stringify(envelope));
}

export function createOperationalPlanRepository(deps = {}) {
  const storage = deps.storage || defaultStorage();
  const key = deps.key || OPERATIONAL_PLAN_STORAGE_KEY;

  return {
    key,

    /** No implicit fallback, no implicit migration (§13): unknown id -> null. */
    read(operationalDayIdValue) {
      if (!parseOperationalDayId(operationalDayIdValue)) throw new Error('A valid operationalDayId is required.');
      const envelope = readEnvelope(storage, key);
      return envelope.plans[operationalDayIdValue] || null;
    },

    /** Sync-only: every locally known operational plan, for pushing a durable remote copy. */
    listAllRaw() {
      return { ...readEnvelope(storage, key).plans };
    },

    /** Validates every timed item's range against the operational day's own
     *  interval (via ref+revisions, §16/§17) BEFORE any mutation is applied —
     *  an invalid range throws and nothing is written, rather than persisting
     *  first and hoping rendering hides it. `ref` must be the OperationalDayRef
     *  this operationalDayIdValue was derived from (the caller already has it,
     *  from resolvePlanAuthority's own resolution) — this repository does not
     *  re-derive it, keeping this file free of any "what instant is it now"
     *  assumption.
     *  @param {string} operationalDayIdValue @param {object[]} items
     *  @param {{updatedBy:string, now?:number, ref:object, revisions:object[]}} context
     *  @returns {object} the written PlanRecord */
    write(operationalDayIdValue, items, { updatedBy, now = Date.now(), ref, revisions }) {
      if (!parseOperationalDayId(operationalDayIdValue)) throw new Error('A valid operationalDayId is required.');
      if (!ref || !Array.isArray(revisions)) throw new Error('An operational-day ref and its governing revisions are required to validate item ranges.');
      const normalizedItems = normalizeItems(items);
      normalizedItems.forEach(item => {
        const result = validateOperationalPlanItemRange(ref, item, revisions);
        if (!result.ok) throw new Error(`Plan item "${item.id || item.task || '(untitled)'}" has an invalid range for this operational day: ${result.reason}`);
      });
      const envelope = readEnvelope(storage, key);
      const current = envelope.plans[operationalDayIdValue] || {};
      const nextPlan = { ...current, items: normalizedItems, updatedAt: now, updatedBy };
      const nextEnvelope = { schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION, plans: { ...envelope.plans, [operationalDayIdValue]: nextPlan } };
      writeEnvelope(storage, key, nextEnvelope);
      return nextPlan;
    },

    /** Writes a preparation confirmation onto the SAME record the items live in
     *  (§14: "prepared/Open Day/unprepared must all be scoped to the same day
     *  identity" — embedded exactly like the legacy plan.preparation, never a
     *  parallel store). `buildPreparation` is the caller's job (operational-plan-
     *  model.js's buildOperationalPreparation) — this method only persists the
     *  already-built result alongside the current items. */
    writePreparation(operationalDayIdValue, preparation) {
      if (!parseOperationalDayId(operationalDayIdValue)) throw new Error('A valid operationalDayId is required.');
      const envelope = readEnvelope(storage, key);
      const current = envelope.plans[operationalDayIdValue] || { items: [], updatedAt: 0 };
      const nextPlan = { ...current, preparation };
      const nextEnvelope = { schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION, plans: { ...envelope.plans, [operationalDayIdValue]: nextPlan } };
      writeEnvelope(storage, key, nextEnvelope);
      return nextPlan;
    },

    /** Sync-only: merges one remote operational plan record into local storage
     *  via mergeOperationalPlanRecords (per-item LWW-by-id + preparation merge —
     *  never a whole-record replace). Range-safety was already enforced at
     *  whichever device originally wrote each item; this merge does not
     *  re-validate ranges, matching how the legacy plans/ Firebase listener
     *  trusts mergeDatePlans without re-validating item shape either. */
    mergeRemote(operationalDayIdValue, remoteRecord) {
      if (!parseOperationalDayId(operationalDayIdValue)) throw new Error('A valid operationalDayId is required.');
      const envelope = readEnvelope(storage, key);
      const local = envelope.plans[operationalDayIdValue] || null;
      const merged = mergeOperationalPlanRecords(local, remoteRecord, operationalDayIdValue);
      const changed = JSON.stringify(local) !== JSON.stringify(merged);
      if (changed) {
        writeEnvelope(storage, key, { schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION, plans: { ...envelope.plans, [operationalDayIdValue]: merged } });
      }
      return { changed, record: merged };
    }
  };
}
