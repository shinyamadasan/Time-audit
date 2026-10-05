// calendar-plan-repository.js
//
// Local persistence for the calendar-native plan store (calendar-plan-model.js)
// and for the account's calendar-authority activation facts. Two envelopes, both
// scoped to ONE account's room exactly like operational-plan-repository.js /
// plan-by-deadline-repository.js:
//
//   plans:      { schemaVersion: 1, plans:  { [calendarPlanId]: PlanRecord } }
//   activation: { schemaVersion: 1, facts:  { [factId]: ActivationFact } }
//
// ── account scoping ─────────────────────────────────────────────────────────
// The slot for the joined room `uid_A` is `ta3-calendar-plans-v1:uid_A` (and
// `ta3-calendar-plan-authority-v1:uid_A`). The room identity is the same canonical
// source every other scoped cache uses (appRoomOwner). With NO room joined there is
// NO active cache: reads are empty and writes throw. A bare, unsuffixed key is never
// read, merged, pushed or adopted — there is no such thing as an unowned calendar
// plan. A repository built over an INJECTED storage without `getOwner` is "plain"
// (one unowned slot) purely so the plan semantics themselves can be unit tested.
//
// ── what write() guarantees ─────────────────────────────────────────────────
// Every item's time fields are stamped (stampCalendarItemTimes — the zone a reading
// is made in is frozen with it) and every item is validated against ITS OWN plan
// date (validateCalendarPlanItem) BEFORE anything is persisted: an invalid item
// throws and nothing is written. The plan's home zone and creation instant are
// frozen by the first write and never change.
//
// "Absence is not migration": read() for an id with nothing stored returns null. It
// never falls back to plans[dateKey] or an operational plan, and there is no method
// here that reads either — the absence of such a method IS the guarantee.

import {
  CALENDAR_AUTHORITY_SCHEMA_VERSION,
  CALENDAR_PLAN_SCHEMA_VERSION,
  buildActivationFact,
  calendarPlanId,
  effectiveActivation,
  mergeCalendarPlanRecords,
  parseCalendarPlanId,
  stampCalendarItemTimes,
  validateActivationFact,
  validateCalendarPlanItem,
} from './calendar-plan-model.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';
import { foldFencedItems } from './plan-item-origin.js';

export const CALENDAR_PLAN_STORAGE_KEY = 'ta3-calendar-plans-v1';
export const CALENDAR_AUTHORITY_STORAGE_KEY = 'ta3-calendar-plan-authority-v1';

/** The storage slot holding ONE room's cache: `<key>:<roomId>`. */
export function calendarCacheKeyForRoom(roomId, key) {
  return `${key}:${roomId}`;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultStorage() {
  if (globalThis.localStorage) return globalThis.localStorage;
  throw new Error('Calendar plan storage is unavailable.');
}

function defaultIdGenerator() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return `ca1-${cryptoRef.randomUUID()}`;
  throw new Error('No UUID generator available; inject idGenerator for this runtime');
}

function normalizeItems(items) {
  if (Array.isArray(items)) return items.filter(item => item && typeof item === 'object');
  if (items && typeof items === 'object') return Object.values(items).filter(item => item && typeof item === 'object');
  return [];
}

function readPlansEnvelope(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return { schemaVersion: CALENDAR_PLAN_SCHEMA_VERSION, plans: {} };
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`Calendar plan storage key ${key} contains malformed JSON.`);
  }
  if (!isPlainObject(envelope) || envelope.schemaVersion !== CALENDAR_PLAN_SCHEMA_VERSION || !isPlainObject(envelope.plans)) {
    throw new Error('Calendar plan storage has an unsupported format or schema version.');
  }
  Object.keys(envelope.plans).forEach(id => {
    if (!parseCalendarPlanId(id)) throw new Error(`Calendar plan storage has an invalid plan id key: ${id}`);
  });
  return envelope;
}

function readAuthorityEnvelope(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return { schemaVersion: CALENDAR_AUTHORITY_SCHEMA_VERSION, facts: {} };
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`Calendar authority storage key ${key} contains malformed JSON.`);
  }
  if (!isPlainObject(envelope) || envelope.schemaVersion !== CALENDAR_AUTHORITY_SCHEMA_VERSION || !isPlainObject(envelope.facts)) {
    throw new Error('Calendar authority storage has an unsupported format or schema version.');
  }
  Object.entries(envelope.facts).forEach(([id, fact]) => {
    if (!fact || fact.id !== id || !validateActivationFact(fact)) throw new Error(`Calendar authority storage holds an invalid activation: ${id}.`);
  });
  return envelope;
}

export function createCalendarPlanRepository(deps = {}) {
  const storage = deps.storage || defaultStorage();
  const plansBaseKey = deps.key || CALENDAR_PLAN_STORAGE_KEY;
  const authorityBaseKey = deps.authorityKey || CALENDAR_AUTHORITY_STORAGE_KEY;
  const idGenerator = deps.idGenerator || defaultIdGenerator;
  // The account's CURRENT timezone — consulted only at the instant a reading is made,
  // never afterwards (see stampCalendarItemTimes).
  const getTimezone = typeof deps.getTimezone === 'function' ? deps.getTimezone : () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const getOwner = typeof deps.getOwner === 'function' ? deps.getOwner : (deps.storage ? null : appRoomOwner);

  function ownerRoomId() {
    if (!getOwner) return null;
    const owner = getOwner();
    return typeof owner === 'string' && owner ? owner : null;
  }

  /** The active slot for a base key, or null when there is NO active cache. */
  function activeKeyFor(baseKey) {
    if (!getOwner) return baseKey;
    const owner = ownerRoomId();
    return owner ? calendarCacheKeyForRoom(owner, baseKey) : null;
  }

  function requireActiveKey(baseKey, what) {
    const key = activeKeyFor(baseKey);
    if (key === null) throw new Error(`No account is active, so there is no ${what} cache to change.`);
    return key;
  }

  function writePlan(dateKey, items, { updatedBy, now }, preparation) {
    const planId = calendarPlanId(dateKey);
    const key = requireActiveKey(plansBaseKey, 'calendar plan');
    const envelope = readPlansEnvelope(storage, key);
    const current = envelope.plans[planId] || null;
    const stamped = stampCalendarItemTimes(current?.items, normalizeItems(items), getTimezone());
    stamped.forEach(item => {
      const check = validateCalendarPlanItem(dateKey, item);
      if (!check.ok) throw new Error(`Plan item "${item.id || item.task || '(untitled)'}" has an invalid time for ${dateKey}: ${check.reason}`);
    });
    const nextPlan = { ...(current || {}), items: stamped, updatedAt: now, updatedBy };
    if (!Number.isFinite(nextPlan.createdAt) || typeof nextPlan.timezone !== 'string') {
      nextPlan.createdAt = now;
      nextPlan.timezone = getTimezone();
    }
    if (preparation) nextPlan.preparation = preparation;
    writePlansEnvelopeFor(key, envelope, planId, nextPlan);
    return nextPlan;
  }

  function writePlansEnvelopeFor(key, envelope, planId, plan) {
    storage.setItem(key, JSON.stringify({ schemaVersion: CALENDAR_PLAN_SCHEMA_VERSION, plans: { ...envelope.plans, [planId]: plan } }));
  }

  return {
    key: plansBaseKey,
    authorityKey: authorityBaseKey,

    /** The room whose cache is active, or null. The sync bridge refuses to push or
     *  merge unless this equals the room it is talking to. */
    ownerRoomId,

    // ── plans ───────────────────────────────────────────────────────────────

    /** No implicit fallback, no implicit migration: unknown date -> null. @param {string} dateKey */
    read(dateKey) {
      const planId = calendarPlanId(dateKey);
      const key = activeKeyFor(plansBaseKey);
      if (key === null) return null;
      return readPlansEnvelope(storage, key).plans[planId] || null;
    },

    /** Sync/derivation-only: every locally known plan, keyed by plan id. */
    listAllRaw() {
      const key = activeKeyFor(plansBaseKey);
      if (key === null) return {};
      return { ...readPlansEnvelope(storage, key).plans };
    },

    /** Items only. @param {string} dateKey @param {object[]} items @param {{updatedBy:string, now?:number}} context */
    write(dateKey, items, { updatedBy, now = Date.now() }) {
      return writePlan(dateKey, items, { updatedBy, now });
    },

    /** Items AND a preparation confirmation in ONE storage write, so a plan can never be
     *  observed with the new items but the old preparation (or the reverse). The
     *  preparation is built by the caller (plan-tomorrow-model's buildPreparation). */
    writeWithPreparation(dateKey, items, preparation, { updatedBy, now = Date.now() }) {
      return writePlan(dateKey, items, { updatedBy, now }, preparation);
    },

    /** Sync-only: removes items from THIS device's cached copy of one plan, without
     *  touching updatedAt and without writing anything remotely. Used only for Brain
     *  Dump plan items the promotion fence has made unpushable (plan-item-origin.js):
     *  a cache correction, never a user edit. @returns {boolean} whether anything was removed */
    dropItemsLocal(planId, itemIds) {
      if (!parseCalendarPlanId(planId)) throw new Error('A valid calendar plan id is required.');
      const key = activeKeyFor(plansBaseKey);
      if (key === null || !Array.isArray(itemIds) || !itemIds.length) return false;
      const envelope = readPlansEnvelope(storage, key);
      const local = envelope.plans[planId];
      if (!local) return false;
      const drop = new Set(itemIds);
      const before = normalizeItems(local.items);
      const items = before.filter(item => !drop.has(item.id));
      if (items.length === before.length) return false;
      writePlansEnvelopeFor(key, envelope, planId, { ...local, items });
      return true;
    },

    /** Sync-only: merges one remote record via mergeCalendarPlanRecords (per-item LWW —
     *  never a whole-record replace). Range safety was enforced by whichever device wrote
     *  each item; the merge does not re-validate, matching the other plan stores. */
    mergeRemote(planId, remoteRecord) {
      if (!parseCalendarPlanId(planId)) throw new Error('A valid calendar plan id is required.');
      const key = activeKeyFor(plansBaseKey);
      if (key === null) return { changed: false, record: null };
      const envelope = readPlansEnvelope(storage, key);
      const local = envelope.plans[planId] || null;
      const merged = mergeCalendarPlanRecords(local, remoteRecord, planId);
      const changed = JSON.stringify(local) !== JSON.stringify(merged);
      if (changed) writePlansEnvelopeFor(key, envelope, planId, merged);
      return { changed, record: merged };
    },

    /** Sync-only: folds FENCED Brain Dump items read from their stable keyed children
     *  (plan-item-origin.js) into this device's one local array, with the fenced-item merge
     *  (newer generation wins, a tombstone is monotonic) — never the store's last-writer-wins,
     *  which could un-delete what the server will refuse to un-delete. Touches only those items.
     *  @param {string} planId @param {object[]} items @returns {{changed:boolean, record:object|null}} */
    mergeRemoteFenced(planId, items) {
      if (!parseCalendarPlanId(planId)) throw new Error('A valid calendar plan id is required.');
      const key = activeKeyFor(plansBaseKey);
      if (key === null) return { changed: false, record: null };
      const envelope = readPlansEnvelope(storage, key);
      const local = envelope.plans[planId] || null;
      const choose = (a, b) => mergeCalendarPlanRecords({ items: [a] }, { items: [b] }, planId).items[0];
      const { items: next, changed } = foldFencedItems(normalizeItems(local?.items), items, choose);
      if (!changed) return { changed: false, record: local };
      const record = { ...(local || { updatedAt: 0 }), items: next };
      writePlansEnvelopeFor(key, envelope, planId, record);
      return { changed: true, record };
    },

    // ── authority cutover ───────────────────────────────────────────────────

    /** Sync/derivation-only: every locally known activation fact. */
    listAllActivationsRaw() {
      const key = activeKeyFor(authorityBaseKey);
      if (key === null) return [];
      return Object.values(readAuthorityEnvelope(storage, key).facts);
    },

    /** The account's effective activation (the earliest fact), or null. Never throws for a
     *  corrupt slot: an unreadable authority state is reported as "no activation" (the
     *  legacy default) instead of crashing every plan read — the corruption itself stays
     *  visible through status(). */
    activation() {
      try { return effectiveActivation(this.listAllActivationsRaw()); } catch { return null; }
    },

    /** 'inactive' | 'active' | 'invalid' (something stored there is broken). */
    status() {
      const key = activeKeyFor(authorityBaseKey);
      if (key === null) return { status: 'inactive', activation: null, factCount: 0 };
      try {
        const facts = Object.values(readAuthorityEnvelope(storage, key).facts);
        const activation = effectiveActivation(facts);
        return { status: activation ? 'active' : 'inactive', activation, factCount: facts.length };
      } catch (err) {
        return { status: 'invalid', activation: null, factCount: 0, error: err.message };
      }
    },

    /** The ONE explicit cutover action. Idempotent for an account that already has an
     *  effective activation (nothing new is written — the earliest fact is already
     *  authoritative); otherwise appends one immutable fact.
     *  @param {{nowMs:number, deviceId:string, timezone?:string}} input @returns {{fact:object, created:boolean}} */
    activate({ nowMs, deviceId, timezone }) {
      const key = requireActiveKey(authorityBaseKey, 'calendar authority');
      const envelope = readAuthorityEnvelope(storage, key);
      const existing = effectiveActivation(Object.values(envelope.facts));
      if (existing) return { fact: existing, created: false };
      const fact = buildActivationFact({ id: idGenerator(), nowMs, timezone: timezone || getTimezone(), deviceId });
      storage.setItem(key, JSON.stringify({ schemaVersion: CALENDAR_AUTHORITY_SCHEMA_VERSION, facts: { ...envelope.facts, [fact.id]: fact } }));
      return { fact, created: true };
    },

    /** Sync-only: union-by-id of remote facts. A fact is immutable, so the same id with
     *  different content is refused (rejected), never overwritten; an invalid or
     *  key-mismatched remote fact is rejected and never stored. Both sides of two
     *  independent activations are KEPT (a grow-only set) — the effective one is decided
     *  by effectiveActivation's total order, not by arrival. */
    mergeRemoteActivations(remoteFactsById) {
      const key = activeKeyFor(authorityBaseKey);
      if (key === null || !isPlainObject(remoteFactsById)) return { changed: false, changedIds: [], rejectedIds: [] };
      const envelope = readAuthorityEnvelope(storage, key);
      const facts = { ...envelope.facts };
      const changedIds = [];
      const rejectedIds = [];
      Object.entries(remoteFactsById).forEach(([id, remote]) => {
        if (!remote || remote.id !== id || !validateActivationFact(remote)) { rejectedIds.push(id); return; }
        const local = facts[id];
        if (local) { if (JSON.stringify(local) !== JSON.stringify(remote)) rejectedIds.push(id); return; }
        facts[id] = remote;
        changedIds.push(id);
      });
      if (!changedIds.length) return { changed: false, changedIds, rejectedIds };
      storage.setItem(key, JSON.stringify({ schemaVersion: CALENDAR_AUTHORITY_SCHEMA_VERSION, facts }));
      return { changed: true, changedIds, rejectedIds };
    },
  };
}
