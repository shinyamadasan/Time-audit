// Synthetic room fixtures only; no application/localStorage accounts or real tasks.
import { randomUUID } from 'node:crypto';
import { legacyBoundaryRevision, proposeBoundaryRevision, operationalDayContaining, operationalDayId } from '../../../personal-day-boundary-model.js';
import { encodeRevisionForWire } from '../../../personal-day-boundary-wire.js';
import { physicalTargetKey } from '../../../plan-item-origin.js';
import { hash, sourceRevision } from './prototype.mjs';
export const NOW = Date.parse('2026-10-15T12:00:00Z');
export function fixture(store = 'calendar', representation = 'array', namespace = 'brainDump') {
  const date = '2026-10-11', zone = 'Etc/UTC';
  const history = proposeBoundaryRevision([legacyBoundaryRevision(zone)],
    { id: 'boundary-a', boundaryTime: '18:00', timezone: zone }, Date.parse('2026-09-01T12:00:00Z')).revisions;
  const ref = operationalDayContaining(Date.parse('2026-10-11T20:00:00Z'), history);
  const targetId = store === 'calendar' ? `cal1:${date}` : store === 'legacy' ? date : operationalDayId(ref);
  const targetKey = physicalTargetKey(store, targetId);
  const plans = { calendar: 'calendarPlans', legacy: 'plans', operational: 'operationalPlans' }[store];
  const fences = { calendar: 'calendarPlanFences', legacy: 'planFences', operational: 'operationalPlanFences' }[store];
  const creationActionId = 'act1_11111111-1111-4111-8111-111111111111';
  const id = representation === 'array' ? 'ordinary-a' : namespace === 'brainDump' ? 'bdp1|contractcap' : creationActionId.replace('act1_', 'api1_');
  const origin = representation === 'array' ? 'unmarked' : namespace === 'brainDump'
    ? { v: 2, claimEpoch: 1, type: 'do-today', store, targetKey } : { creationActionId };
  const item = { id, task: 'Synthetic historical task', done: false, when: '', updatedAt: 100, updatedBy: 'fixture',
    ...(representation === 'array' ? {} : namespace === 'brainDump' ? { brainDumpOrigin: origin } : origin) };
  const fact = { schemaVersion: 1, id: 'ca1-contract', activatedAtMs: Date.parse('2026-10-01T12:00:00Z'),
    activationDate: '2026-10-01', timezone: zone, deviceId: 'fixture' };
  const room = { settings: { timezone: zone }, calendarPlanAuthority: { [fact.id]: fact },
    dayBoundaryRevisions: Object.fromEntries(history.map(revision => [revision.id, encodeRevisionForWire(revision)])), [plans]: { [targetKey]: { createdAt: 1, timezone: zone,
      updatedAt: 100, items: representation === 'array' ? [item] : [] } },
    entries: { e1: { id: 1, duration: 12, unknownFuture: { preserve: true } } },
    brainDump: {}, timer: { running: false }, futureUnknownSibling: { preserve: ['exactly', 3] } };
  if (representation === 'fence') room[fences] = { [targetKey]: { [id]: item } };
  const identity = { store, targetId, itemId: id, representation, origin };
  return { room, identity, item, plans, fences, targetKey };
}
export async function command(room, identity, extra = {}, uid = 'alice') {
  return { identity, operationId: randomUUID(), expectedRevision: 0,
    expectedSourceRevision: await sourceRevision(room, uid, identity, NOW), kind: 'complete',
    date: '2026-10-15', timezone: 'Etc/UTC', ...extra };
}
export function memory(room) {
  let value = structuredClone(room), etag = 0;
  return {
    read: async () => ({ value: structuredClone(value), etag }),
    cas: async (_uid, expected, next) => {
      if (expected !== etag) return 'changed'; value = structuredClone(next); etag++; return 'written';
    },
    change(fn) { value = fn(structuredClone(value)); etag++; },
    value: () => structuredClone(value),
    fingerprint: () => hash(value),
  };
}
