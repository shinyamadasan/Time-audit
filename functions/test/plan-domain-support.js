// functions/test/plan-domain-support.js
//
// Test-only RTDB-shaped owner room for the TASK-012 plan mutation suites: content ETags that change on every write
// (record, fence child, and the calendarPlans collection), null pruning exactly as Realtime Database prunes, and the
// unchanged fence-child update rules (marker/origin pinned, tombstone monotonic, no relocation, never created or
// removed by an update). Hooks inject crashes, lost responses and concurrent owner writes at exact points.
import assert from 'node:assert/strict';

import { ApiError } from '../src/errors.js';
import { wireForm } from '../src/plan-mutation-action.js';
import { localPlanDate } from '../shared/plan-tomorrow-model.js';
import { NOW_MS, OWNER } from './support.js';

export const ZONE = 'Asia/Manila';
export const ACTIVATED_AT = NOW_MS - 10 * 86_400_000;
export const FACT = { schemaVersion: 1, id: 'fact-1', activatedAtMs: ACTIVATED_AT, timezone: ZONE, activationDate: localPlanDate(ACTIVATED_AT, ZONE), deviceId: 'phone' };

/** RTDB-shaped owner room with content ETags, null pruning and the fence-child update rules. */
export function planDomain(seed = {}, hooks = {}) {
  const room = { settings: { timezone: ZONE }, calendarPlanAuthority: { [FACT.id]: FACT }, calendarPlans: {}, calendarPlanFences: {}, ...structuredClone(seed) };
  const versions = new Map();
  const writes = [];
  let collectionVersion = 1;
  let legacyCollectionVersion = 1;
  const bump = key => {
    versions.set(key, (versions.get(key) ?? 1) + 1);
    if (key.startsWith('rec:')) collectionVersion++;
    if (key.startsWith('lrec:')) legacyCollectionVersion++;
  };
  const etag = (key, exists) => (exists ? `v${versions.get(key) ?? 1}` : 'null_etag');
  const own = identity => assert.equal(identity.roomId, `uid_${OWNER.ownerFirebaseUid}`, 'every domain call is the bound owner room');
  const store = value => {
    const pruned = wireForm(structuredClone(value));
    if (Array.isArray(pruned.items) && !pruned.items.length) delete pruned.items;
    return pruned;
  };
  // The database's own clock (rules `now`), for the R1 move lock; tests may advance it to expire a lock.
  const lockActive = item => !!item?.moveLock && item.moveLock.at > api.serverNow - 60_000;
  const api = {
    room, writes, versions, serverNow: NOW_MS,
    /** Another device/owner write: replaces the record (or child) and changes its ETag. */
    ownerRecord(planId, record) { room.calendarPlans[planId] = store(record); bump(`rec:${planId}`); },
    ownerFence(planId, item) { (room.calendarPlanFences[planId] ??= {})[item.id] = store(item); bump(`fence:${planId}/${item.id}`); },
    async readRoomCollection(identity, collection) { own(identity); return structuredClone(room[collection] ?? null); },
    async readCalendarPlanWithEtag(identity, planId) {
      own(identity);
      if (hooks.beforeRecordRead) await hooks.beforeRecordRead(planId);
      return { value: structuredClone(room.calendarPlans[planId] ?? null), etag: etag(`rec:${planId}`, room.calendarPlans[planId] !== undefined) };
    },
    async putCalendarPlanIfMatch(identity, planId, record, tag) {
      own(identity);
      if (hooks.beforeRecordPut) await hooks.beforeRecordPut(planId, record);
      if (tag !== etag(`rec:${planId}`, room.calendarPlans[planId] !== undefined)) return 'changed';
      for (const item of record.items || []) assert.ok(!item.creationActionId && !String(item.id).startsWith('api1_') && !item.brainDumpOrigin, 'no fenced item in an array');
      room.calendarPlans[planId] = store(record);
      bump(`rec:${planId}`);
      writes.push({ planId, where: 'record' });
      if (hooks.afterRecordPut) await hooks.afterRecordPut(planId);
      return 'written';
    },
    async readCalendarPlansWithEtag(identity) {
      own(identity);
      if (hooks.beforePlansRead) await hooks.beforePlansRead();
      return { value: structuredClone(Object.keys(room.calendarPlans).length ? room.calendarPlans : null), etag: `c${collectionVersion}` };
    },
    async putCalendarPlansIfMatch(identity, plans, tag) {
      own(identity);
      if (hooks.beforePlansPut) await hooks.beforePlansPut(plans);
      if (tag !== `c${collectionVersion}`) return 'changed';
      const changed = Object.keys(plans).filter(planId => JSON.stringify(store(plans[planId])) !== JSON.stringify(room.calendarPlans[planId]));
      for (const planId of Object.keys(room.calendarPlans)) assert.ok(Object.hasOwn(plans, planId), 'a collection write never drops a plan');
      for (const planId of changed) { room.calendarPlans[planId] = store(plans[planId]); versions.set(`rec:${planId}`, (versions.get(`rec:${planId}`) ?? 1) + 1); }
      collectionVersion++;
      writes.push({ planIds: changed.sort(), where: 'collection' });
      if (hooks.afterPlansPut) await hooks.afterPlansPut();
      return 'written';
    },
    /** TASK-012: the atomic multi-path relocation, judged exactly as actionPlanItemRules' moveIn/moveOut judge it. */
    /** R1: the conditional move lock (PUT if-match on the source child's exact content), judged as lockCreate is. */
    async lockActionPlanItemForMove(identity, { actionId, sourcePlanId, destinationPlanId, itemId, record, etag }) {
      own(identity);
      if (hooks.beforeLock) await hooks.beforeLock();
      const current = room.calendarPlanFences[sourcePlanId]?.[itemId];
      assert.ok(current !== undefined && etag !== 'null_etag');
      if (etag !== `v${versions.get(`fence:${sourcePlanId}/${itemId}`) ?? 1}`) return 'changed';
      if (current.deleted === true || (lockActive(current) && current.moveLock.actionId !== actionId) || record.moveLock?.actionId !== actionId
        || record.moveLock.destination !== destinationPlanId || JSON.stringify(record.moveLock.at) !== '{".sv":"timestamp"}'
        || JSON.stringify(record.relocationRevision ?? null) !== JSON.stringify(current.relocationRevision ?? null)) {
        throw new ApiError('FORBIDDEN', 'ChronaSense account access was refused.');
      }
      room.calendarPlanFences[sourcePlanId][itemId] = store({ ...record, moveLock: { ...record.moveLock, at: api.serverNow } });
      bump(`fence:${sourcePlanId}/${itemId}`);
      writes.push({ planId: sourcePlanId, itemId, where: 'lock' });
      return 'written';
    },
    async relocateActionPlanItem(identity, { actionId, sourcePlanId, destinationPlanId, itemId, tombstone, moved }) {
      own(identity);
      assert.match(actionId, /^act1_/);
      if (hooks.beforeRelocate) await hooks.beforeRelocate();
      const source = room.calendarPlanFences[sourcePlanId]?.[itemId];
      const destination = room.calendarPlanFences[destinationPlanId]?.[itemId];
      const relocation = moved.relocationRevision;
      const refused = !source || source.deleted === true || destination !== undefined
        || !lockActive(source) || source.moveLock.actionId !== actionId || source.moveLock.destination !== destinationPlanId
        || tombstone.moveLock !== undefined || moved.moveLock !== undefined
        || moved.creationActionId !== source.creationActionId || tombstone.creationActionId !== source.creationActionId
        || JSON.stringify(relocation) !== JSON.stringify(tombstone.relocationRevision) || relocation?.schemaVersion !== 1
        || relocation.fromDayId !== sourcePlanId || relocation.toDayId !== destinationPlanId
        || relocation.sequence !== (source.relocationRevision?.sequence ?? 0) + 1
        || tombstone.deleted !== true || tombstone.movedToDayId !== destinationPlanId || moved.deleted === true || moved.movedToDayId !== undefined
        || !room.calendarPlanAuthority;
      if (refused) throw new ApiError('FORBIDDEN', 'ChronaSense account access was refused.');
      room.calendarPlanFences[sourcePlanId][itemId] = store(tombstone);
      (room.calendarPlanFences[destinationPlanId] ??= {})[itemId] = store(moved);
      bump(`fence:${sourcePlanId}/${itemId}`);
      bump(`fence:${destinationPlanId}/${itemId}`);
      writes.push({ planIds: [sourcePlanId, destinationPlanId], itemId, where: 'relocation' });
      if (hooks.afterRelocate) await hooks.afterRelocate();
      return 'written';
    },
    async readPlanFenceItemWithEtag(identity, planId, itemId) {
      own(identity);
      const value = room.calendarPlanFences[planId]?.[itemId];
      const result = { value: structuredClone(value ?? null), etag: etag(`fence:${planId}/${itemId}`, value !== undefined) };
      // Runs AFTER the read was taken: a write here lands between the caller's read and its next write (the R1 window).
      if (hooks.afterFenceRead) await hooks.afterFenceRead(planId, itemId, result.value);
      return result;
    },
    // ── TASK-036: the legacy store (plans/<date>, planFences/<date>/<bdp1|id>), under the same rules as the app's writes.
    ownerLegacyRecord(dateKey, record) { (room.plans ??= {})[dateKey] = store(record); bump(`lrec:${dateKey}`); },
    async readLegacyPlanWithEtag(identity, dateKey) {
      own(identity);
      if (hooks.beforeLegacyRecordRead) await hooks.beforeLegacyRecordRead(dateKey);
      const value = room.plans?.[dateKey];
      return { value: structuredClone(value ?? null), etag: etag(`lrec:${dateKey}`, value !== undefined) };
    },
    async putLegacyPlanIfMatch(identity, dateKey, record, tag) {
      own(identity);
      if (hooks.beforeLegacyRecordPut) await hooks.beforeLegacyRecordPut(dateKey, record);
      // The rules: no legacy write once any activation fact exists; no fenced/Action API item in an array.
      if (Object.keys(room.calendarPlanAuthority ?? {}).length) throw new ApiError('FORBIDDEN', 'ChronaSense account access was refused.');
      for (const item of Object.values(record.items || {})) assert.ok(!item?.creationActionId && !String(item?.id).startsWith('api1_') && !item?.brainDumpOrigin, 'no fenced item in an array');
      if (tag !== etag(`lrec:${dateKey}`, room.plans?.[dateKey] !== undefined)) return 'changed';
      room.plans[dateKey] = store(record);
      bump(`lrec:${dateKey}`);
      writes.push({ planId: dateKey, where: 'legacy-record' });
      if (hooks.afterLegacyRecordPut) await hooks.afterLegacyRecordPut(dateKey);
      return 'written';
    },
    // ── TASK-038: the legacy collection compare-and-set a legacy cross-day move uses.
    async readLegacyPlansWithEtag(identity) {
      own(identity);
      if (hooks.beforeLegacyPlansRead) await hooks.beforeLegacyPlansRead();
      return { value: structuredClone(room.plans && Object.keys(room.plans).length ? room.plans : null), etag: `l${legacyCollectionVersion}` };
    },
    async putLegacyPlansIfMatch(identity, plans, tag) {
      own(identity);
      if (hooks.beforeLegacyPlansPut) await hooks.beforeLegacyPlansPut(plans);
      if (Object.keys(room.calendarPlanAuthority ?? {}).length) throw new ApiError('FORBIDDEN', 'ChronaSense account access was refused.');
      if (tag !== `l${legacyCollectionVersion}`) return 'changed';
      for (const dateKey of Object.keys(room.plans ?? {})) assert.ok(Object.hasOwn(plans, dateKey), 'a collection write never drops a plan');
      for (const record of Object.values(plans)) {
        for (const item of Object.values(record.items || {})) assert.ok(!item?.creationActionId && !String(item?.id).startsWith('api1_') && !item?.brainDumpOrigin, 'no fenced item in an array');
      }
      const changed = Object.keys(plans).filter(dateKey => JSON.stringify(store(plans[dateKey])) !== JSON.stringify(room.plans?.[dateKey]));
      room.plans ??= {};
      for (const dateKey of changed) { room.plans[dateKey] = store(plans[dateKey]); versions.set(`lrec:${dateKey}`, (versions.get(`lrec:${dateKey}`) ?? 1) + 1); }
      legacyCollectionVersion++;
      writes.push({ planIds: changed.sort(), where: 'legacy-collection' });
      if (hooks.afterLegacyPlansPut) await hooks.afterLegacyPlansPut();
      return 'written';
    },
    async readLegacyPlanFenceItemWithEtag(identity, dateKey, itemId) {
      own(identity);
      assert.match(itemId, /^bdp1\|/, 'only a Brain Dump item can be a legacy fence child');
      const value = room.planFences?.[dateKey]?.[itemId];
      return { value: structuredClone(value ?? null), etag: etag(`lfence:${dateKey}/${itemId}`, value !== undefined) };
    },
    async putLegacyPlanFenceItemIfMatch(identity, dateKey, itemId, record, tag) {
      own(identity);
      const current = room.planFences?.[dateKey]?.[itemId];
      assert.ok(current !== undefined && tag !== 'null_etag', 'an update never creates a fence child');
      if (tag !== etag(`lfence:${dateKey}/${itemId}`, true)) return 'changed';
      if (JSON.stringify(record.brainDumpOrigin) !== JSON.stringify(current.brainDumpOrigin) || (current.deleted === true && record.deleted !== true)
        || JSON.stringify(record.relocationRevision ?? null) !== JSON.stringify(current.relocationRevision ?? null)) {
        throw new ApiError('FORBIDDEN', 'ChronaSense account access was refused.');
      }
      room.planFences[dateKey][itemId] = store(record);
      bump(`lfence:${dateKey}/${itemId}`);
      writes.push({ planId: dateKey, itemId, where: 'legacy-fence' });
      return 'written';
    },
    async putPlanFenceItemIfMatch(identity, planId, itemId, record, tag) {
      own(identity);
      if (hooks.beforeFencePut) await hooks.beforeFencePut(planId, itemId);
      const current = room.calendarPlanFences[planId]?.[itemId];
      assert.ok(current !== undefined && tag !== 'null_etag', 'an update never creates a fence child');
      if (tag !== etag(`fence:${planId}/${itemId}`, true)) return 'changed';
      // The unchanged fence rules, as the server applies them to an owner update.
      if (record.creationActionId !== current.creationActionId || JSON.stringify(record.brainDumpOrigin) !== JSON.stringify(current.brainDumpOrigin)
        || (current.deleted === true && record.deleted !== true)
        // TASK-012: an ordinary owner write keeps the item's relocation exactly (it can neither move nor fabricate one).
        || JSON.stringify(record.relocationRevision ?? null) !== JSON.stringify(current.relocationRevision ?? null)
        || (record.movedToDayId ?? null) !== (current.movedToDayId ?? null)
        // R1: nothing ordinary writes under an active move lock; an owner may keep or drop an expired lock, never forge one.
        || lockActive(current) || (record.moveLock !== undefined && JSON.stringify(record.moveLock) !== JSON.stringify(current.moveLock ?? null))) {
        throw new ApiError('FORBIDDEN', 'ChronaSense account access was refused.');
      }
      room.calendarPlanFences[planId][itemId] = store(record);
      bump(`fence:${planId}/${itemId}`);
      writes.push({ planId, itemId, where: 'fence' });
      if (hooks.afterFencePut) await hooks.afterFencePut(planId, itemId);
      return 'written';
    },
  };
  return api;
}
