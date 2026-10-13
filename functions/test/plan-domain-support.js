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
  const bump = key => { versions.set(key, (versions.get(key) ?? 1) + 1); if (key.startsWith('rec:')) collectionVersion++; };
  const etag = (key, exists) => (exists ? `v${versions.get(key) ?? 1}` : 'null_etag');
  const own = identity => assert.equal(identity.roomId, `uid_${OWNER.ownerFirebaseUid}`, 'every domain call is the bound owner room');
  const store = value => {
    const pruned = wireForm(structuredClone(value));
    if (Array.isArray(pruned.items) && !pruned.items.length) delete pruned.items;
    return pruned;
  };
  const api = {
    room, writes, versions,
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
    async readPlanFenceItemWithEtag(identity, planId, itemId) {
      own(identity);
      const value = room.calendarPlanFences[planId]?.[itemId];
      return { value: structuredClone(value ?? null), etag: etag(`fence:${planId}/${itemId}`, value !== undefined) };
    },
    async putPlanFenceItemIfMatch(identity, planId, itemId, record, tag) {
      own(identity);
      if (hooks.beforeFencePut) await hooks.beforeFencePut(planId, itemId);
      const current = room.calendarPlanFences[planId]?.[itemId];
      assert.ok(current !== undefined && tag !== 'null_etag', 'an update never creates a fence child');
      if (tag !== etag(`fence:${planId}/${itemId}`, true)) return 'changed';
      // The unchanged fence rules, as the server applies them to an owner update.
      if (record.creationActionId !== current.creationActionId || JSON.stringify(record.brainDumpOrigin) !== JSON.stringify(current.brainDumpOrigin)
        || (current.deleted === true && record.deleted !== true) || record.relocationRevision || record.movedToDayId) {
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
