// Offline audit of the EXISTING contract, not tests proving a completion implementation safe.
// No Firebase connection, account credentials, application storage or production writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import targaryen from 'targaryen';
import { mergeCalendarPlanRecords } from '../../calendar-plan-model.js';
import { mergeDatePlans, classifyOneOffActual } from '../../plan-tomorrow-model.js';
import { mergeOperationalPlanRecords } from '../../operational-plan-model.js';
import { mergeFencedItem, physicalTargetKey } from '../../plan-item-origin.js';
import { itemIsRecoverable } from '../../stale-plan-recovery-model.js';
import { createCalendarPlanLiveWiring } from '../../calendar-plan-live.js';
import { operationalDayId } from '../../personal-day-boundary-model.js';
import { planMutation } from '../../functions/src/plan-mutation-action.js';
import { mergeCalendarPlanRecords as oldCalendar } from '../../fixtures/cf43080-client/calendar-plan-model.js';
import { mergeDatePlans as oldLegacy } from '../../fixtures/cf43080-client/plan-tomorrow-model.js';
import { mergeOperationalPlanRecords as oldOperational } from '../../fixtures/cf43080-client/operational-plan-model.js';

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const manifest = JSON.parse(read('fixtures/cf43080-client/MANIFEST.json'));
assert.equal(manifest.commit, 'cf43080ad51428cb78442e6cabadbf3d48edc827');
assert.equal(Object.keys(manifest.files).length, 14);
for (const [file, hash] of Object.entries(manifest.files)) {
  const text = read(`fixtures/cf43080-client/${file}`).replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(text).digest('hex'), hash, file);
}
const findings = [];
function observe(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  findings.push({ name, observed: actual === undefined ? 'undefined' : actual });
}
const date = '2026-10-11', planId = `cal1:${date}`;
const opId = operationalDayId({ boundaryRevisionId: 'audit', timezone: 'Etc/UTC', boundaryStartDate: date });
const opKey = physicalTargetKey('operational', opId);
const now = Date.parse('2026-10-15T12:00:00Z');
const before = { id: 'task-a', task: 'Synthetic audit task', when: '', done: false, updatedAt: 50, updatedBy: 'offline' };
const resolved = { ...before, updatedAt: 100, updatedBy: 'new-client', completionResolution: {
  date: '2026-10-14', timezone: 'Etc/UTC', recordedAt: now, recordedBy: 'new-client',
} };
const stale = { ...before, task: 'Edited offline without the new field', updatedAt: 200 };
const record = item => ({ items: [item], updatedAt: item.updatedAt, createdAt: 1, timezone: 'Etc/UTC' });
for (const [name, merge, id] of [
  ['current calendar', mergeCalendarPlanRecords, planId], ['cf43080 calendar', oldCalendar, planId],
  ['current legacy', mergeDatePlans, date], ['cf43080 legacy', oldLegacy, date],
  ['current operational', mergeOperationalPlanRecords, opId], ['cf43080 operational', oldOperational, opId],
]) {
  const merged = merge(record(resolved), record(stale), id);
  observe(`${name}: newer stale item erases annotation`, Object.hasOwn(merged.items[0], 'completionResolution'), false);
}
const choose = (a, b) => mergeCalendarPlanRecords(record(a), record(b), planId).items[0];
const origin = { v: 2, claimEpoch: 1, type: 'do-today', store: 'calendar', targetKey: planId };
const fenced = value => ({ ...value, id: 'bdp1|audit', brainDumpOrigin: origin });
observe('same-generation fenced merge erases annotation',
  Object.hasOwn(mergeFencedItem(fenced(resolved), fenced(stale), choose), 'completionResolution'), false);

const rules = JSON.parse(read('firebase.rules.json'));
const fact = { schemaVersion: 1, id: 'ca1-audit', activatedAtMs: now - 86400000,
  activationDate: '2026-10-14', timezone: 'Etc/UTC', deviceId: 'audit' };
const room = { calendarPlanAuthority: { [fact.id]: fact }, calendarPlans: { [planId]: record(resolved) },
  plans: { [date]: record(before) }, operationalPlans: { [opKey]: record(before) } };
const data = { rooms: { uid_audit: room } };
const allowed = (store, id, value, uid = 'audit') => targaryen.database(rules, data)
  .as({ uid, token: {} }).write(`/rooms/uid_audit/${store}/${id}`, value).allowed;
observe('rules accept stale ordinary calendar overwrite removing annotation', allowed('calendarPlans', planId, record(stale)), true);
observe('rules deny ordinary legacy completion after cutover', allowed('plans', date, record(resolved)), false);
observe('rules deny ordinary operational completion after cutover', allowed('operationalPlans', opKey, record(resolved)), false);
observe('ordinary calendar writes remain account-bound', allowed('calendarPlans', planId, record(stale), 'other'), false);

let errorCode = null;
try {
  planMutation('plan_set_completion', { completed: true }, before,
    { stampMs: now, writer: 'audit', date, ended: true, today: '2026-10-15', accountZone: 'Etc/UTC' });
} catch (error) { errorCode = error.code; }
observe('existing backend completion refuses arbitrary ended task', errorCode, 'PAST_TARGET_IMMUTABLE');
observe('setting done with late doneAt classifies original day as done',
  classifyOneOffActual({ ...before, done: true, doneAt: now }, { targetDate: date, timezone: 'Etc/UTC' }), 'done');
observe('annotation alone preserves original-day not-done',
  classifyOneOffActual(resolved, { targetDate: date, timezone: 'Etc/UTC' }), 'not-done');
observe('annotation alone is still returned as recoverable', itemIsRecoverable(resolved), true);

let localWrites = 0, syncCalls = 0;
const live = createCalendarPlanLiveWiring({
  repository: { activation: () => fact, listAllRaw: () => ({ [planId]: record(before) }), write: () => { localWrites++; } },
  sync: { syncPlan: async () => { syncCalls++; return { committed: false, outcome: 'transport-failure' }; } },
  now: () => now, timezone: () => 'Etc/UTC', deviceId: () => 'audit',
});
observe('historical source is absent from live listener dates', live.liveDateKeys().includes(date), false);
observe('writePlanItems returns no durability acknowledgement', live.writePlanItems(date, [resolved]), undefined);
observe('local write happens despite unsuccessful synthetic sync', { localWrites, syncCalls }, { localWrites: 1, syncCalls: 1 });
console.log(JSON.stringify({ gate: 'BLOCKED', scope: 'Existing-contract observations only; no implemented completion operation',
  fixtureCommit: manifest.commit, verifiedFixtureHashes: Object.keys(manifest.files).length,
  observations: findings.length, findings }, null, 2));
