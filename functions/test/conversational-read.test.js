import test from 'node:test';
import assert from 'node:assert/strict';

import { buildActivationFact } from '../shared/calendar-plan-model.js';
import { LEGACY_CALENDAR_DAY_REVISION_ID, legacyBoundaryRevision, operationalDayContaining, operationalDayId, proposeBoundaryRevision } from '../shared/personal-day-boundary-model.js';
import { physicalTargetKey } from '../shared/plan-item-origin.js';
import { entryRange } from '../src/read-queries.js';
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

const orderedEntries = pairs => new Proxy(Object.fromEntries(pairs), {
  ownKeys: () => pairs.map(([key]) => key),
});

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

test('equal-sequence relocation identities for one stable ID conflict in either record order', async () => {
  const a = 'cal1:2026-10-07';
  const c = 'cal1:2026-10-08';
  const b = TARGET.id;
  const claim = fromDayId => ({ schemaVersion: 1, sequence: 1, fromDayId, toDayId: b, updatedBy: 'fixture' });
  const source = fromDayId => ({ ...item, deleted: true, movedToDayId: b, relocationRevision: claim(fromDayId) });
  for (const order of [[a, c, b], [b, c, a]]) {
    const records = { [a]: { timezone: 'UTC', items: [source(a)] },
      [c]: { timezone: 'UTC', items: [source(c)] },
      [b]: { timezone: 'UTC', items: [{ ...item, relocationRevision: claim(c) }] } };
    const data = rooms({ calendarPlans: Object.fromEntries(order.map(day => [day, records[day]])) });
    for (const [kind, parameters] of [['get_plan', {}], ['get_item', { source: 'plan', id: item.id, target: TARGET }],
      ['get_today', {}], ['get_intelligence', {}]]) {
      const response = await query(harness({ rooms: data, nowMs: NOW }), kind, parameters);
      assert.equal(response.body.error?.code, 'CONFLICT', `${order.join(',')} ${kind}: ${JSON.stringify(response.body)}`);
      assert.ok(!('result' in response.body));
    }
  }
});

test('a valid higher relocation sequence supersedes lower contradictory claims', async () => {
  const a = 'cal1:2026-10-07';
  const c = 'cal1:2026-10-08';
  const b = TARGET.id;
  const d = 'cal1:2026-10-10';
  const lower = fromDayId => ({ schemaVersion: 1, sequence: 1, fromDayId, toDayId: b, updatedBy: 'fixture' });
  const higher = { schemaVersion: 1, sequence: 2, fromDayId: b, toDayId: d, updatedBy: 'fixture' };
  const data = rooms({ calendarPlans: {
    [a]: { timezone: 'UTC', items: [{ ...item, deleted: true, movedToDayId: b, relocationRevision: lower(a) }] },
    [c]: { timezone: 'UTC', items: [{ ...item, deleted: true, movedToDayId: b, relocationRevision: lower(c) }] },
    [b]: { timezone: 'UTC', items: [{ ...item, deleted: true, movedToDayId: d, relocationRevision: higher }] },
    [d]: { timezone: 'UTC', items: [{ ...item, relocationRevision: higher }] },
  } });
  const current = await query(harness({ rooms: data, nowMs: NOW }), 'get_plan');
  assert.equal(current.status, 200, JSON.stringify(current.body));
  assert.deepEqual(current.body.result.plan.items, []);
  const destination = await query(harness({ rooms: data, nowMs: NOW }), 'get_plan',
    { target: { store: 'calendar', id: d } });
  assert.equal(destination.status, 200, JSON.stringify(destination.body));
  assert.deepEqual(destination.body.result.plan.items.map(row => row.itemId), [item.id]);
});

test('divergent equal-authority recovery destinations fail every affected read in either record order', async () => {
  const source = 'cal1:2026-10-08';
  const prior = { ...item, id: 'stale-source', when: '09:00', durationMinutes: 30 };
  const destinations = ['cal1:2026-10-09', 'cal1:2026-10-10'];
  const moved = destinations.map((day, index) => ({ ...prior, id: `carry-${index}`, task: `Different ${index}`,
    carriedFromId: prior.id, carriedFromDayId: source,
    relocationRevision: { schemaVersion: 1, sequence: 1, fromDayId: source, toDayId: day, updatedBy: 'fixture' } }));
  for (const order of [destinations, [...destinations].reverse()]) {
    const calendarPlans = Object.fromEntries([[source, { timezone: 'UTC', items: [prior] }],
      ...order.map(day => [day, { timezone: 'UTC', items: [moved[destinations.indexOf(day)]] }])]);
    const data = rooms({ calendarPlans });
    for (const [kind, parameters] of [['get_plan', {}], ['get_today', {}], ['get_intelligence', {}],
      ['get_item', { source: 'plan', id: moved[0].id, target: TARGET }]]) {
      const response = await query(harness({ rooms: data, nowMs: NOW }), kind, parameters);
      assert.equal(response.body.error?.code, 'CONFLICT', `${kind}: ${JSON.stringify(response.body)}`);
      assert.ok(!('result' in response.body));
    }
  }
});

test('malformed and impossible relocation authority fails closed while absent and valid metadata remains readable', async () => {
  const destination = 'cal1:2026-10-10';
  const valid = { schemaVersion: 1, sequence: 1, fromDayId: TARGET.id, toDayId: destination, updatedBy: 'fixture' };
  const badCases = [
    { name: 'invalid revision', value: { ...valid, sequence: 'bad' } },
    { name: 'malformed target', value: { ...valid, toDayId: 'not-a-day' } },
    { name: 'stale impossible reference', value: valid },
  ];
  for (const { name, value } of badCases) {
    const data = rooms({ calendarPlans: { [TARGET.id]: { timezone: 'UTC', items: [{ ...item,
      ...(name === 'stale impossible reference' ? { deleted: true } : {}), relocationRevision: value }] } } });
    for (const [kind, parameters] of [['get_plan', {}], ['get_item', { source: 'plan', id: item.id, target: TARGET }],
      ['get_today', {}], ['get_intelligence', {}]]) {
      const response = await query(harness({ rooms: data, nowMs: NOW }), kind, parameters);
      assert.equal(response.body.error?.code, 'CONFLICT', `${name} ${kind}: ${JSON.stringify(response.body)}`);
      assert.ok(!('result' in response.body));
    }
  }
  const ordinary = await query(harness({ rooms: rooms(), nowMs: NOW }), 'get_plan');
  assert.deepEqual(ordinary.body.result.plan.items.map(row => row.itemId), [item.id]);
  const orphan = rooms({ calendarPlans: { [destination]: { timezone: 'UTC', items: [{ ...item, relocationRevision: valid }] } } });
  const orphanRead = await query(harness({ rooms: orphan, nowMs: NOW }), 'get_plan',
    { target: { store: 'calendar', id: destination } });
  assert.equal(orphanRead.body.error?.code, 'CONFLICT');
  const data = rooms({ calendarPlans: {
    [TARGET.id]: { timezone: 'UTC', items: [{ ...item, deleted: true, movedToDayId: destination, relocationRevision: valid }] },
    [destination]: { timezone: 'UTC', items: [{ ...item, relocationRevision: valid }] },
  } });
  const source = await query(harness({ rooms: data, nowMs: NOW }), 'get_item', { source: 'plan', id: item.id, target: TARGET });
  assert.equal(source.body.result.state, 'tombstoned');
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

test('Today, Plan and Intelligence accept the production-shaped Firebase-pruned legacy anchor', async () => {
  const anchor = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: 'Asia/Manila' };
  const timed = { id: '95ad6b59-ca56-4053-a93f-18af3f2e8e9b', boundaryTime: '18:00',
    timezone: 'Asia/Manila', effectiveFromInstant: Date.parse('2026-09-14T10:00:00Z') };
  for (const entries of [[[timed.id, timed], [anchor.id, anchor]], [[anchor.id, anchor], [timed.id, timed]]]) {
    const data = rooms({ settings: { timezone: 'Asia/Manila', intervalMin: 30 },
      dayBoundaryRevisions: Object.fromEntries(entries) });
    const responses = [];
    for (const kind of ['get_today', 'get_plan', 'get_intelligence']) {
      const response = await query(harness({ rooms: data, nowMs: NOW }), kind);
      assert.equal(response.status, 200, `${kind}: ${JSON.stringify(response.body)}`);
      responses.push(response);
    }
    const [today, plan, intelligence] = responses;
    assert.deepEqual(today.body.result.plan.target, plan.body.result.plan.target);
    assert.deepEqual(intelligence.body.result.view.planActual.map(row => row.refs[0]?.id), [item.id]);
  }
});

test('a malformed __proto__ revision beside a valid pruned Manila anchor fails all three signed reads', async () => {
  const anchor = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: 'Asia/Manila' };
  const malformed = { id: '__proto__', boundaryTime: '18:00', timezone: 'Asia/Manila' };
  const dayBoundaryRevisions = Object.fromEntries([[anchor.id, anchor], ['__proto__', malformed]]);
  assert.deepEqual(Object.keys(dayBoundaryRevisions), [anchor.id, '__proto__']);
  for (const kind of ['get_today', 'get_plan', 'get_intelligence']) {
    const response = await query(harness({ rooms: rooms({ settings: { timezone: 'Asia/Manila', intervalMin: 30 },
      dayBoundaryRevisions }), nowMs: NOW }), kind);
    assert.equal(response.status, 409, `${kind}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.code, 'CONFLICT');
    assert.equal(response.reason, 'malformed-day-boundary');
  }
});

test('the day-boundary reader still rejects missing activation on non-anchors and malformed anchor shapes', async () => {
  const anchor = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: 'Asia/Manila' };
  const malformed = [
    { ...anchor, id: 'ordinary-revision' },
    { ...anchor, boundaryTime: '18:00' },
    { ...anchor, timezone: 'Not/A_Zone' },
    { ...anchor, id: 'ordinary-revision', effectiveFromInstant: 'legacy-anchor-instant' },
  ];
  for (const bad of malformed) {
    const data = rooms({ dayBoundaryRevisions: { [bad.id]: bad } });
    for (const kind of ['get_today', 'get_plan', 'get_intelligence']) {
      const response = await query(harness({ rooms: data, nowMs: NOW }), kind);
      assert.equal(response.status, 409, `${kind}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'CONFLICT');
    }
  }
  const badTimed = { id: 'timed-revision', boundaryTime: '18:00', timezone: 'Asia/Manila' };
  const histories = [
    { [anchor.id]: anchor, [badTimed.id]: badTimed },
    { [anchor.id]: anchor, other: { ...anchor, id: 'other' } },
    { wrongKey: anchor },
  ];
  for (const dayBoundaryRevisions of histories) {
    const response = await query(harness({ rooms: rooms({ dayBoundaryRevisions }), nowMs: NOW }), 'get_plan');
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'CONFLICT');
  }
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

test('extension numeric wire keys and newer web copies produce one stable entry in either order', async () => {
  const id = NOW - 3_600_000;
  const raw = { id, tsStart: id, ts: id + 1_800_000, blockIntervalMin: 30,
    activity: 'Fixture observation', category: 'waste', date: DAY, energy: 'waste',
    originalLabel: 'waste', onPlan: false, quickLogged: true, retro: true,
    source: 'browser-extension', browserUsage: true, updatedAt: id + 1_800_000 };
  const newer = { ...raw, activity: 'Updated fixture observation', updatedAt: raw.updatedAt + 1 };
  for (const kind of ['get_today', 'get_intelligence']) {
    const expected = await query(harness({ rooms: rooms({ entries: { [`e_${id}`]: newer } }), nowMs: NOW }), kind);
    assert.equal(expected.status, 200, JSON.stringify(expected.body));
    for (const pairs of [[[String(id), raw], [`e_${id}`, newer]], [[`e_${id}`, newer], [String(id), raw]]]) {
      const response = await query(harness({ rooms: rooms({ entries: orderedEntries(pairs) }), nowMs: NOW }), kind);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body.result, expected.body.result);
    }
    const rawOnly = await query(harness({ rooms: rooms({ entries: { [id]: raw } }), nowMs: NOW }), kind);
    const prefixedOnly = await query(harness({ rooms: rooms({ entries: { [`e_${id}`]: raw } }), nowMs: NOW }), kind);
    assert.deepEqual(rawOnly.body.result, prefixedOnly.body.result);
    const identicalTwins = await query(harness({ rooms: rooms({ entries: { [id]: raw, [`e_${id}`]: { ...raw } } }), nowMs: NOW }), kind);
    assert.deepEqual(identicalTwins.body.result, prefixedOnly.body.result);
  }
});

test('entry tombstones prevail over extension copies unless an explicit newer undo restored the ID', async () => {
  const id = NOW - 3_600_000;
  const raw = { id, tsStart: id, ts: id + 1_800_000, blockIntervalMin: 30,
    activity: 'Fixture observation', source: 'browser-extension', updatedAt: id + 3_000_000 };
  const tombstone = { id, ts: raw.ts, deleted: true, updatedAt: id + 2_000_000 };
  for (const pairs of [[[String(id), raw], [`e_${id}`, tombstone]], [[`e_${id}`, tombstone], [String(id), raw]]]) {
    const response = await query(harness({ rooms: rooms({ entries: orderedEntries(pairs) }), nowMs: NOW }), 'get_intelligence');
    const onlyTombstone = await query(harness({ rooms: rooms({ entries: { [`e_${id}`]: tombstone } }), nowMs: NOW }), 'get_intelligence');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.result, onlyTombstone.body.result);
  }
  const restored = { ...raw, undoRestoredAt: raw.updatedAt };
  const result = await query(harness({ rooms: rooms({ entries: { [id]: restored, [`e_${id}`]: tombstone } }), nowMs: NOW }), 'get_intelligence');
  const onlyRestored = await query(harness({ rooms: rooms({ entries: { [`e_${id}`]: restored } }), nowMs: NOW }), 'get_intelligence');
  assert.deepEqual(result.body.result, onlyRestored.body.result);
});

test('entry key compatibility does not accept wrong provenance, ambiguous twins or zero-length evidence', async () => {
  const id = NOW - 3_600_000;
  const raw = { id, tsStart: id, ts: id + 1_800_000, blockIntervalMin: 30,
    activity: 'Fixture observation', source: 'browser-extension', updatedAt: id + 1_800_000 };
  const badStores = [
    { [id]: { ...raw, source: 'other' } },
    { [id]: { ...raw, id: id + 1 } },
    { [id]: { ...raw, id: String(id) } },
    { not_numeric: raw },
    { [id]: raw, [`e_${id}`]: { ...raw, id: String(id) } },
    { [id]: raw, [`e_${id}`]: { ...raw, activity: 'Conflicting same-version value' } },
    { [`e_${id}`]: { id, ts: id, tsStart: id, blockIntervalMin: 0,
      activity: 'Zero-duration fixture', date: DAY, energy: 'deep', onPlan: false, retro: true,
      category: 'deep', originalLabel: 'deep', updatedAt: id } },
  ];
  for (const entries of badStores) for (const kind of ['get_today', 'get_intelligence']) {
    const response = await query(harness({ rooms: rooms({ entries }), nowMs: NOW }), kind);
    assert.equal(response.status, 409, `${kind}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.code, 'CONFLICT');
    assert.equal(response.reason, 'malformed-entries');
  }
  const plan = await query(harness({ rooms: rooms({ entries: badStores.at(-1) }), nowMs: NOW }), 'get_plan');
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
});

test('malformed active entry copies cannot hide behind a newer valid copy', async () => {
  const id = NOW - 3_600_000;
  const valid = { id, ts: id + 1_800_000, tsStart: id, blockIntervalMin: 30,
    activity: 'Fixture observation', source: 'browser-extension', updatedAt: id + 2_000_000 };
  const malformed = { ...valid, blockIntervalMin: 0, updatedAt: id + 1_000_000 };
  delete malformed.tsStart;
  const pairs = [
    [[String(id), malformed], [`e_${id}`, valid]],
    [[`e_${id}`, malformed], [String(id), valid]],
  ];
  for (const copies of pairs) for (const ordered of [copies, [...copies].reverse()]) {
    const data = rooms({ entries: orderedEntries(ordered) });
    for (const kind of ['get_today', 'get_intelligence']) {
      const response = await query(harness({ rooms: data, nowMs: NOW }), kind);
      assert.equal(response.status, 409, `${kind}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'CONFLICT');
    }
    const plan = await query(harness({ rooms: data, nowMs: NOW }), 'get_plan');
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
  }
});

test('authoritative entry tombstones still mask stale malformed active copies', async () => {
  const id = NOW - 3_600_000;
  const malformed = { id, ts: id + 1_800_000, blockIntervalMin: 0,
    activity: 'Fixture observation', source: 'browser-extension', updatedAt: id + 1_000_000 };
  const tombstone = { id, deleted: true, updatedAt: id + 2_000_000 };
  for (const copies of [
    [[String(id), malformed], [`e_${id}`, tombstone]],
    [[`e_${id}`, tombstone], [String(id), malformed]],
  ]) for (const kind of ['get_today', 'get_intelligence']) {
    const response = await query(harness({ rooms: rooms({ entries: orderedEntries(copies) }), nowMs: NOW }), kind);
    const expected = await query(harness({ rooms: rooms({ entries: { [`e_${id}`]: tombstone } }), nowMs: NOW }), kind);
    assert.equal(response.status, 200, `${kind}: ${JSON.stringify(response.body)}`);
    assert.deepEqual(response.body.result, expected.body.result);
  }
});

test('active entries require positive persisted interval evidence', async () => {
  const id = NOW - 3_600_000;
  const valid = { id, ts: id + 1_800_000, tsStart: id, blockIntervalMin: 30,
    activity: 'Fixture observation', updatedAt: id + 1_800_000 };
  const zeroWithoutStart = { ...valid, blockIntervalMin: 0 };
  delete zeroWithoutStart.tsStart;
  const missingDuration = { ...zeroWithoutStart };
  delete missingDuration.blockIntervalMin;
  const malformed = {
    zeroWithoutStart,
    missingDuration,
    negativeDuration: { ...zeroWithoutStart, blockIntervalMin: -30 },
    zeroWithSpan: { ...valid, blockIntervalMin: 0 },
    negativeWithSpan: { ...valid, blockIntervalMin: -30 },
    malformedDurationWithSpan: { ...valid, blockIntervalMin: '30' },
    malformedStart: { ...valid, tsStart: 'not-a-time' },
    endBeforeStart: { ...valid, tsStart: valid.ts + 1 },
    malformedEnd: { ...valid, ts: 'not-a-time' },
    negativeSegment: { ...valid, segments: [{ duration: -60 }] },
  };
  for (const [caseName, entry] of Object.entries(malformed)) {
    const data = rooms({ entries: { [`e_${id}`]: entry } });
    for (const kind of ['get_today', 'get_intelligence']) {
      const response = await query(harness({ rooms: data, nowMs: NOW }), kind);
      assert.equal(response.status, 409, `${caseName} ${kind}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'CONFLICT');
    }
    const plan = await query(harness({ rooms: data, nowMs: NOW }), 'get_plan');
    assert.equal(plan.status, 200, `${caseName}: ${JSON.stringify(plan.body)}`);
  }
});

test('manual-save explicit elapsed span wins over a different positive configured block size', async () => {
  const end = NOW - 30 * 60000;
  for (const elapsedMinutes of [25, 45]) {
    const entry = { id: end, ts: end, tsStart: end - elapsedMinutes * 60000,
      blockIntervalMin: 30, date: DAY, activity: 'Manual-save fixture', energy: 'deep',
      onPlan: true, retro: false, category: 'deep', originalLabel: 'deep', updatedAt: end };
    assert.deepEqual(entryRange(entry), { startMs: end - elapsedMinutes * 60000, endMs: end });
    const explicitOnly = { ...entry };
    delete explicitOnly.blockIntervalMin;
    const data = rooms({ entries: { [`e_${entry.id}`]: entry } });
    const expectedData = rooms({ entries: { [`e_${entry.id}`]: explicitOnly } });
    for (const kind of ['get_today', 'get_intelligence']) {
      const response = await query(harness({ rooms: data, nowMs: NOW }), kind);
      const expected = await query(harness({ rooms: expectedData, nowMs: NOW }), kind);
      assert.equal(response.status, 200, `${elapsedMinutes}m ${kind}: ${JSON.stringify(response.body)}`);
      assert.deepEqual(response.body.result, expected.body.result);
      if (kind === 'get_intelligence') assert.ok(response.body.result.view.actuals.some(row => row.id === `entry:${entry.id}`));
    }
    const plan = await query(harness({ rooms: data, nowMs: NOW }), 'get_plan');
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
  }
});

test('positive sub-minute persisted spans are evidence before whole-minute interpretation', async () => {
  const end = NOW - 30 * 60000;
  for (const [elapsedMs, blockIntervalMin] of [[1, 0], [20_000, 0], [20_000, 0.1], [20_000, 1], [20_000, 30]]) {
    const entry = { id: end, ts: end, tsStart: end - elapsedMs, blockIntervalMin,
      date: DAY, activity: 'Short fixture observation', energy: 'deep', updatedAt: end };
    assert.deepEqual(entryRange(entry), { startMs: end - elapsedMs, endMs: end });
    const data = rooms({ entries: { [`e_${end}`]: entry } });
    for (const kind of ['get_today', 'get_intelligence', 'get_plan']) {
      const response = await query(harness({ rooms: data, nowMs: NOW }), kind);
      assert.equal(response.status, 200, `${elapsedMs}ms/${blockIntervalMin} ${kind}: ${JSON.stringify(response.body)}`);
      if (kind === 'get_intelligence') assert.ok(response.body.result.view.actuals.some(row => row.id === `entry:${end}`));
    }
  }
  const shortSegments = { id: end, ts: end, segments: [{ duration: 5 }, { duration: 5 }],
    activity: 'Short segment fixture', updatedAt: end };
  assert.deepEqual(entryRange(shortSegments), { startMs: end - 10_000, endMs: end });
  const segmentRead = await query(harness({ rooms: rooms({ entries: { [`e_${end}`]: shortSegments } }), nowMs: NOW }), 'get_intelligence');
  assert.equal(segmentRead.status, 200, JSON.stringify(segmentRead.body));
});

test('positive persisted spans and legacy duration fields remain usable without settings fallback', async () => {
  const id = NOW - 3_600_000;
  const entry = { id, ts: id + 1_800_000, tsStart: id, blockIntervalMin: 30,
    activity: 'Fixture observation', updatedAt: id + 1_800_000 };
  const storedDuration = { ...entry };
  delete storedDuration.tsStart;
  const explicitSpan = { ...entry };
  delete explicitSpan.blockIntervalMin;
  const storedSegments = { ...storedDuration, segments: [{ duration: 1_800 }] };
  delete storedSegments.blockIntervalMin;
  for (const valid of [
    entry,
    storedDuration,
    explicitSpan,
    storedSegments,
  ]) for (const kind of ['get_today', 'get_intelligence']) {
    const response = await query(harness({ rooms: rooms({ entries: { [`e_${id}`]: valid } }), nowMs: NOW }), kind);
    assert.equal(response.status, 200, `${kind}: ${JSON.stringify(response.body)}`);
  }
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
