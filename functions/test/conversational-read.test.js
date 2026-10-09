import test from 'node:test';
import assert from 'node:assert/strict';

import { buildActivationFact } from '../shared/calendar-plan-model.js';
import { legacyBoundaryRevision, operationalDayContaining, operationalDayId, proposeBoundaryRevision } from '../shared/personal-day-boundary-model.js';
import { physicalTargetKey } from '../shared/plan-item-origin.js';
import { harness, OWNER, signedRequest, capture } from './support.js';

const NOW = Date.UTC(2026, 9, 9, 12);
const DAY = '2026-10-09';
const TARGET = { store: 'calendar', id: `cal1:${DAY}` };
const fact = buildActivationFact({ id: 'test-activation', nowMs: Date.UTC(2026, 9, 1, 12), timezone: 'UTC', deviceId: 'fixture' });
const item = { id: 'stable-1', task: 'Review notes', done: false, when: '23:30', whenDayOffset: 0,
  whenTz: 'UTC', durationMinutes: 60, updatedAt: NOW - 60_000, updatedBy: 'fixture' };

function rooms(overrides = {}) {
  return { [`uid_${OWNER.ownerFirebaseUid}`]: {
    settings: { timezone: 'UTC', intervalMin: 30 },
    calendarPlanAuthority: { [fact.id]: fact },
    calendarPlans: { [TARGET.id]: { timezone: 'UTC', createdAt: NOW - 100_000, updatedAt: NOW - 60_000, items: [item] } },
    brainDump: { cap_1: capture('cap_1') },
    entries: {}, commitments: {}, coarseLifeEvidence: {}, ...overrides,
  } };
}

async function query(h, kind, parameters = {}, overrides = {}) {
  const request = signedRequest({ ...overrides, signed: { timestamp: Math.floor(NOW / 1000), ...overrides.signed },
    envelope: { contractVersion: 1, requestId: overrides.requestId || 'b1477114-9b6a-4b3d-8e34-b80bec490651', kind, parameters },
    requestId: overrides.requestId || 'b1477114-9b6a-4b3d-8e34-b80bec490651' });
  return h.handle(request);
}

test('plan read preserves calendar target, item identity, frozen time and missing-actual uncertainty', async () => {
  const h = harness({ rooms: rooms(), nowMs: NOW });
  const plan = await query(h, 'get_plan');
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.deepEqual(plan.body.result.plan.target, { store: 'calendar', id: TARGET.id, date: DAY,
    timezone: 'UTC', startMs: Date.UTC(2026, 9, 9), endMs: Date.UTC(2026, 9, 10), boundaryTime: '00:00' });
  assert.equal(plan.body.result.plan.items[0].itemId, item.id);
  assert.equal(plan.body.result.plan.items[0].startMs, Date.UTC(2026, 9, 9, 23, 30));
  assert.equal(plan.body.result.plan.items[0].endMs, Date.UTC(2026, 9, 10, 0, 30));
  const today = await query(harness({ rooms: rooms(), nowMs: NOW }), 'get_today');
  assert.equal(today.status, 200, JSON.stringify(today.body));
  assert.ok(today.body.result.attention.some(row => row.id === `plan:${TARGET.id}:${item.id}` && row.kind === 'unknown' && row.status === 'Actual unknown'));
});

test('stable item lookup needs the exact target and never guesses from title', async () => {
  const plan = await query(harness({ rooms: rooms(), nowMs: NOW }), 'get_item', { source: 'plan', id: item.id, target: TARGET });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body.result.item.itemId, item.id);
  assert.equal((await query(harness({ rooms: rooms(), nowMs: NOW }), 'get_item', { source: 'plan', id: 'Review notes', target: TARGET })).body.error.code, 'NOT_FOUND');
  const captureRead = await query(harness({ rooms: rooms(), nowMs: NOW }), 'get_item', { source: 'brain_dump', id: 'cap_1' });
  assert.equal(captureRead.body.result.item.captureId, 'cap_1');
  const malformed = await query(harness({ rooms: rooms(), nowMs: NOW }), 'get_item', { source: 'plan', id: item.id, target: { store: 'calendar', id: TARGET.id, path: 'victim' } });
  assert.equal(malformed.body.error.code, 'INVALID_INPUT');
});

test('a tombstoned stable ID reports its known state rather than pretending it never existed', async () => {
  const data = rooms({ calendarPlans: { [TARGET.id]: { timezone: 'UTC', items: [{ ...item, deleted: true }] } } });
  const response = await query(harness({ rooms: data, nowMs: NOW }), 'get_item',
    { source: 'plan', id: item.id, target: TARGET });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.result.state, 'tombstoned');
});

test('Intelligence V1 is derived with typed provenance and deterministic plan ordering', async () => {
  const planItems = [{ ...item, id: 'z' }, { ...item, id: 'a' }];
  const data = rooms({ calendarPlans: { [TARGET.id]: { timezone: 'UTC', createdAt: NOW - 100_000, items: planItems } } });
  data.uid_victim = { calendarPlans: { [TARGET.id]: { timezone: 'UTC', items: [{ ...item, id: 'victim-secret' }] } } };
  const h = harness({ rooms: data, nowMs: NOW });
  const response = await query(h, 'get_intelligence');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.authority.authority, 'intelligence_v1_derived');
  assert.deepEqual(response.body.result.view.planActual.map(row => row.refs[0].id), ['a', 'z']);
  assert.ok(!JSON.stringify(response.body).includes('victim-secret'));
  assert.ok(response.body.result.view.notes.some(note => note.includes('not evaluated')));
  assert.ok(h.domain.reads.every(read => read.roomId === `uid_${OWNER.ownerFirebaseUid}`));
});

test('empty authoritative stores are empty, while malformed and contradictory plan authority fails closed', async () => {
  const empty = await query(harness({ rooms: rooms({ calendarPlans: {}, brainDump: {} }), nowMs: NOW }), 'get_plan');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.result.plan.state, 'absent');
  assert.deepEqual(empty.body.result.plan.items, []);
  const badFact = await query(harness({ rooms: rooms({ calendarPlanAuthority: { x: fact } }), nowMs: NOW }), 'get_plan');
  assert.equal(badFact.body.error.code, 'CONFLICT');
  const conflicting = await query(harness({ rooms: rooms({ calendarPlans: { [TARGET.id]: { timezone: 'UTC', items: [item, { ...item, task: 'Other' }] } } }), nowMs: NOW }), 'get_plan');
  assert.equal(conflicting.body.error.code, 'CONFLICT');
  const badZone = await query(harness({ rooms: rooms({ settings: {} }), nowMs: NOW }), 'get_plan');
  assert.equal(badZone.body.error.code, 'CONFLICT');
  const badHistorical = await query(harness({ rooms: rooms({ calendarPlans: {
    [TARGET.id]: { timezone: 'UTC', items: [] },
    'cal1:2026-10-08': { timezone: 'UTC', items: [{ ...item, id: 'bad', when: '02:00', whenDayOffset: 3 }] },
  } }), nowMs: NOW }), 'get_intelligence');
  assert.equal(badHistorical.body.error.code, 'CONFLICT');
  const badLegacyDate = await query(harness({ rooms: rooms({ plans: { '2026-13-01': { items: [item] } } }), nowMs: NOW }), 'get_plan');
  assert.equal(badLegacyDate.body.error.code, 'CONFLICT');
});

test('relocation authority, not input order, decides which plan owns one stable item', async () => {
  const destination = 'cal1:2026-10-10';
  const relocationRevision = { schemaVersion: 1, sequence: 1, fromDayId: TARGET.id,
    toDayId: destination, updatedBy: 'fixture' };
  const moved = { ...item, relocationRevision };
  const data = rooms({ calendarPlans: {
    [destination]: { timezone: 'UTC', items: [{ ...moved, when: '10:00', whenDayOffset: 0 }] },
    [TARGET.id]: { timezone: 'UTC', items: [moved] },
  } });
  const source = await query(harness({ rooms: data, nowMs: NOW }), 'get_plan');
  assert.equal(source.status, 200, JSON.stringify(source.body));
  assert.deepEqual(source.body.result.plan.items, []);
  const target = await query(harness({ rooms: data, nowMs: NOW }), 'get_plan', { target: { store: 'calendar', id: destination } });
  assert.deepEqual(target.body.result.plan.items.map(row => row.itemId), [item.id]);
});

test('a fenced Brain Dump item wins over an older same-ID plan-array copy', async () => {
  const id = 'bdp1|bcap0001';
  const old = { id, task: 'Old array copy', when: '', done: false, updatedAt: 1, updatedBy: 'old' };
  const fenced = { ...old, task: 'Fenced authority', updatedAt: 2, updatedBy: 'new',
    brainDumpOrigin: { v: 2, claimEpoch: 0, type: 'do-today', store: 'calendar', targetKey: TARGET.id } };
  const data = rooms({ calendarPlans: { [TARGET.id]: { timezone: 'UTC', items: [old] } },
    calendarPlanFences: { [TARGET.id]: { [id]: fenced } } });
  const response = await query(harness({ rooms: data, nowMs: NOW }), 'get_plan');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.result.plan.items[0].task, 'Fenced authority');
  assert.equal(response.body.result.plan.items[0].sourceCaptureId, 'bcap0001');
});

test('previous unfinished plans remain open loops; missing actual never becomes a missed fact', async () => {
  const previous = 'cal1:2026-10-08';
  const yesterday = { ...item, id: 'still-open', when: '09:00', durationMinutes: 30 };
  const data = rooms({ calendarPlans: {
    [previous]: { timezone: 'UTC', items: [yesterday] },
    [TARGET.id]: { timezone: 'UTC', items: [item] },
  } });
  const response = await query(harness({ rooms: data, nowMs: NOW }), 'get_intelligence');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const loop = response.body.result.view.openLoops.find(row => row.id === `stale:${previous}:${yesterday.id}`);
  assert.equal(loop.status, 'Previous plan still open');
  assert.equal(loop.kind, 'derived');
  assert.match(loop.detail, /no claim about what happened/);
});

test('an exact stable ID remains readable in a legacy record superseded by calendar routing', async () => {
  const data = rooms({ plans: { [DAY]: { items: [{ ...item, id: 'historical' }] } } });
  const current = await query(harness({ rooms: data, nowMs: NOW }), 'get_plan');
  assert.equal(current.body.result.plan.target.store, 'calendar');
  const historical = await query(harness({ rooms: data, nowMs: NOW }), 'get_item',
    { source: 'plan', id: 'historical', target: { store: 'legacy', id: DAY } });
  assert.equal(historical.status, 200, JSON.stringify(historical.body));
  assert.equal(historical.body.result.item.task, item.task);
  assert.equal(historical.body.result.target.store, 'legacy');
});

test('a personal-day boundary selects the operational target and preserves an overnight item', async () => {
  const history = proposeBoundaryRevision([legacyBoundaryRevision('UTC')],
    { id: 'boundary-1800', boundaryTime: '18:00', timezone: 'UTC' }, Date.UTC(2026, 9, 8, 10)).revisions;
  const ref = operationalDayContaining(NOW, history);
  const id = operationalDayId(ref);
  const { whenDayOffset, whenTz, ...baseItem } = item;
  const overnight = { ...baseItem, id: 'overnight', when: '23:00', durationMinutes: 120 };
  const data = rooms({ calendarPlanAuthority: {}, dayBoundaryRevisions: Object.fromEntries(history.map(value => [value.id, value])),
    calendarPlans: {}, operationalPlans: { [physicalTargetKey('operational', id)]: { items: [overnight] } } });
  const response = await query(harness({ rooms: data, nowMs: NOW }), 'get_plan');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.result.plan.target.store, 'operational');
  assert.equal(response.body.result.plan.target.id, id);
  assert.equal(response.body.result.plan.items[0].startMs, Date.UTC(2026, 9, 8, 23));
  assert.equal(response.body.result.plan.items[0].endMs, Date.UTC(2026, 9, 9, 1));
});

test('calendar carryover keeps the source plan ID and next-day instant', async () => {
  const prior = 'cal1:2026-10-08';
  const carry = { ...item, id: 'carry', when: '01:00', whenDayOffset: 1, durationMinutes: 30 };
  const data = rooms({ calendarPlans: {
    [prior]: { timezone: 'UTC', items: [carry] }, [TARGET.id]: { timezone: 'UTC', items: [] },
  } });
  const response = await query(harness({ rooms: data, nowMs: NOW }), 'get_intelligence');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const row = response.body.result.view.planActual.find(value => value.refs[0]?.id === carry.id);
  assert.equal(row.planId, prior);
  assert.equal(row.whenDayOffset, 1);
  assert.equal(row.kind, 'unknown');
});

test('malformed entry evidence and Unicode oversize plan fail whole reads', async () => {
  const tombstone = rooms({ entries: { e_123: { id: 123, ts: NOW - 1000, deleted: true, updatedAt: NOW } } });
  const deleted = await query(harness({ rooms: tombstone, nowMs: NOW }), 'get_intelligence');
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body.result.view.actuals, []);
  const malformedEntry = rooms({ entries: { e_wrong: { id: 'other', activity: 'Work', ts: NOW - 1000, tsStart: NOW - 2000 } } });
  const bad = await query(harness({ rooms: malformedEntry, nowMs: NOW }), 'get_intelligence');
  assert.equal(bad.body.error.code, 'CONFLICT');
  const huge = rooms({ calendarPlans: { [TARGET.id]: { timezone: 'UTC', items: [{ ...item, task: '😀'.repeat(18_000) }] } } });
  const oversize = await query(harness({ rooms: huge, nowMs: NOW }), 'get_plan');
  assert.equal(oversize.body.error.code, 'DOMAIN_LIMIT');
  assert.ok(!('result' in oversize.body));
});

test('wrong signed subject, wrong scope, replay, duplicate keys and caller paths fail before any domain read', async () => {
  const h = harness({ rooms: rooms(), nowMs: NOW });
  const wrongSubject = await query(h, 'get_plan', {}, { signed: { subject: 'different-subject' } });
  assert.equal(wrongSubject.body.error.code, 'FORBIDDEN');
  const wrongScope = await query(h, 'get_plan', {}, { signed: { scopes: ['chronasense:plan.write'] } });
  assert.equal(wrongScope.body.error.code, 'FORBIDDEN');
  assert.equal(h.domain.reads.length, 0);
  const valid = await query(h, 'get_plan');
  assert.equal(valid.status, 200);
  assert.equal((await query(h, 'get_plan')).body.error.code, 'AUTH_REQUIRED');
  const smuggled = await query(harness({ rooms: rooms(), nowMs: NOW }), 'get_plan', { path: 'rooms/uid_victim' });
  assert.equal(smuggled.body.error.code, 'INVALID_INPUT');
  const id = 'b1477114-9b6a-4b3d-8e34-b80bec490651';
  const rawBody = Buffer.from(`{"contractVersion":1,"requestId":"${id}","kind":"get_plan","kind":"get_today","parameters":{}}`);
  const duplicate = await harness({ rooms: rooms(), nowMs: NOW }).handle(signedRequest({ requestId: id, rawBody, signed: { timestamp: Math.floor(NOW / 1000) } }));
  assert.equal(duplicate.body.error.code, 'INVALID_INPUT');
});
