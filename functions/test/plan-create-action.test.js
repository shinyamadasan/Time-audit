// plan_create (TASK-011): "Add gym tomorrow at 6 PM" as ONE structured, idempotent, user-scoped create through the
// Action Gateway. Adversarial: identity, idempotency, concurrency, crash/unknown recovery, target authority, time,
// input safety and scope isolation. The domain double stores the item at its keyed calendar fence child and serves
// the same room to Plan Authority's server read, so authority checks see what the create wrote.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { COMMAND_PATH, CANONICAL_PATH } from '../src/action-api.js';
import { actionActorRef } from '../src/envelope.js';
import { ApiError } from '../src/errors.js';
import { MAX_ATTEMPT_MS } from '../src/plan-create-action.js';
import { addCalendarDays, localPlanDate } from '../shared/plan-tomorrow-model.js';
import { NOW_MS, OWNER, harness, signedRequest } from './support.js';

const ZONE = 'Asia/Manila';
const TODAY = localPlanDate(NOW_MS, ZONE);
const TOMORROW = addCalendarDays(TODAY, 1);
const YESTERDAY = addCalendarDays(TODAY, -1);
const ACTION = 'act1_550e8400-e29b-41d4-a716-446655440000';
const ACTION_2 = 'act1_6a1f9b00-1c2d-4e3f-9a4b-5c6d7e8f9012';
const itemIdFor = actionId => `api1_${actionId.slice(5)}`;
const ITEM_ID = itemIdFor(ACTION);
const planIdOf = date => `cal1:${date}`;
const GYM = { target: { store: 'calendar', id: planIdOf(TOMORROW) }, title: 'Gym', when: '18:00', whenTz: ZONE, durationMinutes: 60 };
const ACTIVATED_AT = NOW_MS - 10 * 86_400_000;
const FACT = { schemaVersion: 1, id: 'fact-1', activatedAtMs: ACTIVATED_AT, timezone: ZONE, activationDate: localPlanDate(ACTIVATED_AT, ZONE), deviceId: 'phone' };
const RECEIPT = actionId => `serverActionReceipts/${OWNER.ownerFirebaseUid}/${actionId}`;

const provenanceFor = actionId => ({ version: 1, sourceKind: 'chatgpt_plugin', actionId,
  actorRef: actionActorRef(OWNER.ownerSubject), capturedAt: new Date(NOW_MS).toISOString() });

function request({ actionId = ACTION, parameters = GYM, requestId, scopes = ['chronasense:plan.write'], signed = {}, envelope = {}, rawBody } = {}) {
  const id = requestId ?? randomUUID();
  return signedRequest({ path: COMMAND_PATH, requestId: id, rawBody,
    signed: { path: COMMAND_PATH, scopes, ...signed },
    envelope: { contractVersion: 1, requestId: id, actionId, kind: 'plan_create', parameters, expectedRevision: null,
      actionProvenance: provenanceFor(actionId), ...envelope } });
}

/** One owner room: what Plan Authority's read sees and where the keyed item lands. */
function planDomain({ room: overrides = {}, loseResponse = false, failBeforeWrite = false, failRead = false, forbidCreate = false, hideAfterCreate = false } = {}) {
  const room = { settings: { timezone: ZONE }, calendarPlanAuthority: { [FACT.id]: FACT }, ...overrides };
  const writes = [];
  const fence = (planId, create = false) => {
    if (create) { room.calendarPlanFences ??= {}; room.calendarPlanFences[planId] ??= {}; }
    return room.calendarPlanFences?.[planId];
  };
  return {
    room, writes,
    set(flags) { ({ loseResponse = loseResponse, failBeforeWrite = failBeforeWrite, failRead = failRead, forbidCreate = forbidCreate, hideAfterCreate = hideAfterCreate } = flags); },
    async readRoomCollection(_identity, collection) { return structuredClone(room[collection] ?? null); },
    async readPlanItem(identity, planId, itemId) {
      assert.equal(identity.roomId, `uid_${OWNER.ownerFirebaseUid}`);
      if (failRead) throw new ApiError('RETRYABLE_TRANSPORT', 'Read unavailable.');
      if (hideAfterCreate) return null;
      return structuredClone(fence(planId)?.[itemId] ?? null);
    },
    async createPlanItemIfAbsent(identity, planId, itemId, actionId, record) {
      writes.push({ roomId: identity.roomId, planId, itemId, actionId });
      if (failBeforeWrite) throw new ApiError('RETRYABLE_TRANSPORT', 'Write unavailable.');
      if (forbidCreate) throw new ApiError('FORBIDDEN', 'ChronaSense account access was refused.');
      const children = fence(planId, true);
      if (children[itemId]) return 'exists';
      children[itemId] = structuredClone(record);
      if (loseResponse) { loseResponse = false; throw new ApiError('RETRYABLE_TRANSPORT', 'Response lost.'); }
      return 'created';
    },
  };
}

const itemAt = (store, date = TOMORROW, id = ITEM_ID) => store.room.calendarPlanFences?.[planIdOf(date)]?.[id];
const code = response => response.body.error?.code;

test('"Add gym tomorrow at 6 PM": one attributed item on tomorrow\'s calendar plan, exact receipt, exact replay', async () => {
  const store = planDomain();
  const h = harness({ domain: store });
  const first = await h.handle(request());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const item = itemAt(store);
  assert.deepEqual(item, { id: ITEM_ID, task: 'Gym', when: '18:00', whenTz: ZONE, durationMinutes: 60, done: false,
    updatedAt: NOW_MS, updatedBy: provenanceFor(ACTION).actorRef, kind: 'task', creationActionId: ACTION }, 'an ordinary planned task + action provenance only');
  assert.equal(store.room.calendarPlans, undefined, 'the plan record (and its array) is never written');
  const { result, authority } = first.body;
  assert.equal(result.itemId, ITEM_ID);
  assert.deepEqual(result.target, { store: 'calendar', id: planIdOf(TOMORROW), date: TOMORROW });
  assert.deepEqual(result.schedule, { when: '18:00', whenDayOffset: 0, whenTz: ZONE, durationMinutes: 60,
    startAt: new Date(Date.parse(`${TOMORROW}T18:00:00+08:00`)).toISOString(), endAt: new Date(Date.parse(`${TOMORROW}T19:00:00+08:00`)).toISOString() });
  assert.equal(result.idempotentReplay, false);
  assert.equal(authority.store, 'calendar');
  assert.deepEqual(authority.recordIds, [ITEM_ID]);
  const receipt = h.infra.data.get(RECEIPT(ACTION));
  assert.equal(receipt.state, 'applied');
  assert.equal(receipt.kind, 'plan_create');
  assert.equal(receipt.plannedRecordId, ITEM_ID);
  assert.deepEqual(receipt.plannedTarget, { store: 'calendar', id: planIdOf(TOMORROW) });
  assert.deepEqual(receipt.effectiveTarget, { store: 'calendar', id: planIdOf(TOMORROW), date: TOMORROW });
  assert.equal(receipt.authorizationContext.requiredScope, 'chronasense:plan.write');
  assert.ok(!JSON.stringify(receipt).includes('Gym'), 'the receipt never copies the task text');
  const replay = await h.handle(request());
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.result.idempotentReplay, true);
  assert.deepEqual({ ...replay.body.result, idempotentReplay: false }, result, 'the same logical result');
  assert.equal(store.writes.length, 1, 'no second write');
});

test('the created item reads back through the unchanged get_plan / get_item tools with a matching revision', async () => {
  const store = planDomain();
  const h = harness({ domain: store });
  const created = await h.handle(request());
  const read = async (kind, parameters) => {
    const requestId = randomUUID();
    return h.handle(signedRequest({ requestId, envelope: { contractVersion: 1, requestId, kind, parameters } }));
  };
  const plan = await read('get_plan', { target: { store: 'calendar', id: planIdOf(TOMORROW) } });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const listed = plan.body.result.plan.items.find(i => i.itemId === ITEM_ID);
  assert.equal(listed.task, 'Gym');
  assert.equal(listed.revision, created.body.result.revision);
  assert.equal(listed.sourceCaptureId, null);
  const one = await read('get_item', { source: 'plan', id: ITEM_ID, target: { store: 'calendar', id: planIdOf(TOMORROW) } });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.result.item.startMs, Date.parse(`${TOMORROW}T18:00:00+08:00`));
});

test('one action ID with a different semantic payload conflicts and never executes', async () => {
  const store = planDomain();
  const h = harness({ domain: store });
  assert.equal((await h.handle(request())).status, 200);
  for (const parameters of [{ ...GYM, title: 'Gym!' }, { ...GYM, when: '18:30' }, { ...GYM, durationMinutes: 90 },
    { ...GYM, target: { store: 'calendar', id: planIdOf(addCalendarDays(TOMORROW, 1)) } }, { ...GYM, whenTz: 'Asia/Tokyo' }]) {
    const response = await h.handle(request({ parameters }));
    assert.equal(code(response), 'IDEMPOTENCY_CONFLICT', JSON.stringify(parameters));
  }
  assert.equal(store.writes.length, 1);
});

test('normalization: an omitted whenDayOffset and an explicit 0 are the same command; a trimmed title too', async () => {
  const store = planDomain();
  const h = harness({ domain: store });
  assert.equal((await h.handle(request())).status, 200);
  const same = await h.handle(request({ parameters: { ...GYM, whenDayOffset: 0, title: '  Gym  ' } }));
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.result.idempotentReplay, true);
});

test('parallel identical calls create exactly one item; different actions on the same plan both survive', async () => {
  const store = planDomain();
  const h = harness({ domain: store });
  const responses = await Promise.all(Array.from({ length: 12 }, () => h.handle(request())));
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.ok(responses.filter(r => r.status !== 200).every(r => code(r) === 'PENDING_UNKNOWN'));
  assert.equal(store.writes.length, 1);
  const second = await h.handle(request({ actionId: ACTION_2, parameters: { ...GYM, title: 'Stretch', when: '19:30', durationMinutes: 15 } }));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(Object.keys(store.room.calendarPlanFences[planIdOf(TOMORROW)]).sort(), [ITEM_ID, itemIdFor(ACTION_2)].sort());
  assert.equal(itemAt(store).task, 'Gym', 'the first item is untouched by the second action');
});

test('the same title on another action is a different item (text is never identity)', async () => {
  const store = planDomain();
  const h = harness({ domain: store });
  assert.equal((await h.handle(request())).status, 200);
  assert.equal((await h.handle(request({ actionId: ACTION_2 }))).status, 200);
  assert.equal(Object.keys(store.room.calendarPlanFences[planIdOf(TOMORROW)]).length, 2);
});

test('lost write response: the exact child proves the effect; applied without a second item', async () => {
  const store = planDomain({ loseResponse: true });
  const h = harness({ domain: store });
  const response = await h.handle(request());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(store.writes.length, 1);
});

test('unobservable outcome stays PENDING_UNKNOWN (never "absent"), then the same action recovers it', async () => {
  const store = planDomain({ failRead: true });
  const h = harness({ domain: store });
  const first = await h.handle(request());
  assert.equal(code(first), 'PENDING_UNKNOWN');
  const receipt = h.infra.data.get(RECEIPT(ACTION));
  assert.equal(receipt.state, 'pending_unknown', 'nothing could be read: never terminal, never "absent"');
  assert.equal(receipt.leaseExpiresAt, NOW_MS, 'the lease is released for the same action\'s retry');
  store.set({ failRead: false });
  const recovered = await h.handle(request());
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(store.writes.length, 1, 'the effect existed only once');
});

test('applied requires authoritative readback: a "created" answer with the item not observable is never applied', async () => {
  const store = planDomain({ hideAfterCreate: true });
  const h = harness({ domain: store });
  const response = await h.handle(request());
  assert.equal(code(response), 'PENDING_UNKNOWN');
  assert.equal(h.infra.data.get(RECEIPT(ACTION)).state, 'pending_unknown');
  store.set({ hideAfterCreate: false });
  const retry = await h.handle(request());
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(store.writes.length, 1, 'the retry saw the existing attributed item instead of writing again');
});

test('a write that failed before any effect stays unknown, then safely creates once', async () => {
  const store = planDomain({ failBeforeWrite: true });
  const h = harness({ domain: store });
  assert.equal(code(await h.handle(request())), 'PENDING_UNKNOWN');
  assert.equal(itemAt(store), undefined);
  store.set({ failBeforeWrite: false });
  assert.equal((await h.handle(request())).status, 200);
  assert.ok(itemAt(store));
});

test('crash after the write, before the receipt: a takeover proves it from the item and never writes again', async () => {
  const store = planDomain();
  const h = harness({ domain: store });
  assert.equal((await h.handle(request())).status, 200);
  // Rewind the receipt to a crashed attempt (started, lease expired) while the item exists.
  const receipt = h.infra.data.get(RECEIPT(ACTION));
  h.infra.data.set(RECEIPT(ACTION), { ...receipt, state: 'started', result: undefined, authority: undefined, leaseExpiresAt: NOW_MS - 1, leaseAcquiredAt: NOW_MS - 40_000 });
  // The owner already edited and completed it meanwhile: attribution, not content, proves ownership.
  Object.assign(itemAt(store), { task: 'Gym (legs)', done: true, updatedAt: NOW_MS + 1 });
  const takeover = await h.handle(request());
  assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
  assert.equal(takeover.body.result.idempotentReplay, true);
  assert.equal(store.writes.length, 1);
});

test('an active lease held by another attempt answers PENDING_UNKNOWN without executing', async () => {
  const store = planDomain();
  const h = harness({ domain: store });
  h.infra.data.set(RECEIPT(ACTION), { contractVersion: 1, actionId: ACTION, requestHash: 'x', kind: 'plan_create', state: 'started' });
  // A different hash is a conflict, never an execution.
  assert.equal(code(await h.handle(request())), 'IDEMPOTENCY_CONFLICT');
  h.infra.data.delete(RECEIPT(ACTION));
  store.set({ failRead: true });
  await h.handle(request()); // leaves started + released lease
  const live = h.infra.data.get(RECEIPT(ACTION));
  h.infra.data.set(RECEIPT(ACTION), { ...live, attemptId: 'other-attempt', leaseExpiresAt: NOW_MS + 10_000 });
  store.set({ failRead: false });
  assert.equal(code(await h.handle(request())), 'PENDING_UNKNOWN');
  assert.equal(store.writes.length, 0);
});

test('the deterministic id occupied by a foreign or unattributed child is a CONFLICT; the child is untouched', async () => {
  for (const foreign of [{ id: ITEM_ID, task: 'foreign', when: '', done: false, kind: 'task' },
    { id: ITEM_ID, task: 'foreign', when: '', done: false, kind: 'task', creationActionId: ACTION_2 },
    { id: ITEM_ID, task: 'x', creationActionId: ACTION, brainDumpOrigin: { v: 2 } }, 'not-an-object']) {
    const store = planDomain({ room: { calendarPlanFences: { [planIdOf(TOMORROW)]: { [ITEM_ID]: structuredClone(foreign) } } } });
    const h = harness({ domain: store });
    const response = await h.handle(request());
    assert.equal(code(response), 'CONFLICT', JSON.stringify(foreign));
    assert.equal(store.writes.length, 0);
    assert.deepEqual(itemAt(store), foreign);
    assert.equal(h.infra.data.get(RECEIPT(ACTION)).state, 'conflict');
  }
});

test('target authority: no activation, a pre-activation date, a past day or an id already in the plan array are typed refusals with no write', async () => {
  const cases = [
    ['no calendar activation (never activated by this call)', { calendarPlanAuthority: null }, GYM, 'NOT_FOUND'],
    ['date before the activation date', {}, { ...GYM, target: { store: 'calendar', id: planIdOf(addCalendarDays(FACT.activationDate, -1)) } }, 'NOT_FOUND'],
    ['a past plan is history', {}, { ...GYM, target: { store: 'calendar', id: planIdOf(YESTERDAY) } }, 'PAST_TARGET_IMMUTABLE'],
    ['the api1 id already in the plan array', { calendarPlans: { [planIdOf(TOMORROW)]: { items: [{ id: ITEM_ID, task: 'smuggled', when: '', done: false }], updatedAt: 1 } } }, GYM, 'CONFLICT'],
    ['account timezone unavailable', { settings: null }, GYM, 'CONFLICT'],
  ];
  for (const [why, room, parameters, expected] of cases) {
    const store = planDomain({ room });
    const h = harness({ domain: store });
    const response = await h.handle(request({ parameters }));
    assert.equal(code(response), expected, `${why}: ${JSON.stringify(response.body)}`);
    assert.equal(store.writes.length, 0, why);
    const receipt = h.infra.data.get(RECEIPT(ACTION));
    assert.equal(receipt.state, 'rejected', `${why}: a fresh claim with proven absence is a definite refusal`);
    const replay = await h.handle(request({ parameters }));
    assert.equal(code(replay), expected, `${why}: the same definite answer on replay`);
    assert.equal(store.writes.length, 0);
  }
});

test('legacy/operational stores are refused before any receipt (calendar-only V1, no legacy fallback)', async () => {
  for (const target of [{ store: 'legacy', id: TOMORROW }, { store: 'operational', id: `odv1:rev:${ZONE}:${TOMORROW}` }]) {
    const h = harness({ domain: planDomain() });
    const response = await h.handle(request({ parameters: { ...GYM, target } }));
    assert.equal(code(response), 'DOMAIN_LIMIT');
    assert.equal(h.infra.data.has(RECEIPT(ACTION)), false, 'no receipt consumed');
  }
});

test('today is writable until its plan ends; at midnight it becomes history (frozen home zone)', async () => {
  const todayEnd = Date.parse(`${TOMORROW}T00:00:00+08:00`);
  const target = { store: 'calendar', id: planIdOf(TODAY) };
  const before = harness({ domain: planDomain(), nowMs: todayEnd - 1 });
  assert.equal((await before.handle(request({ parameters: { ...GYM, target } , signed: { timestamp: Math.floor((todayEnd - 1) / 1000) } }))).status, 200);
  const at = harness({ domain: planDomain(), nowMs: todayEnd });
  const refused = await at.handle(request({ parameters: { ...GYM, target }, signed: { timestamp: Math.floor(todayEnd / 1000) } }));
  assert.equal(code(refused), 'PAST_TARGET_IMMUTABLE');
  // A plan whose frozen home zone is behind the account zone is still live there.
  const homeLA = { calendarPlans: { [planIdOf(TODAY)]: { items: [], updatedAt: 1, createdAt: 1, timezone: 'America/Los_Angeles' } } };
  const la = harness({ domain: planDomain({ room: homeLA }), nowMs: todayEnd });
  const live = await la.handle(request({ parameters: { ...GYM, target }, signed: { timestamp: Math.floor(todayEnd / 1000) } }));
  assert.equal(live.status, 200, JSON.stringify(live.body));
});

test('time: cross-midnight offset, wrap-around duration, item zone != account zone, DST fall-back is earlier, date-only stays date-only', async () => {
  const cases = [
    [{ ...GYM, when: '01:00', whenDayOffset: 1, durationMinutes: 30 }, `${addCalendarDays(TOMORROW, 1)}T01:00:00+08:00`, { whenDayOffset: 1 }],
    [{ ...GYM, when: '23:00', durationMinutes: 120 }, `${TOMORROW}T23:00:00+08:00`, {}],
    [{ ...GYM, whenTz: 'America/New_York' }, null, { whenTz: 'America/New_York' }],
  ];
  for (const [parameters, startIso, stored] of cases) {
    const store = planDomain();
    const h = harness({ domain: store });
    const response = await h.handle(request({ parameters }));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    if (startIso) assert.equal(response.body.result.schedule.startAt, new Date(Date.parse(startIso)).toISOString());
    for (const [field, value] of Object.entries(stored)) assert.equal(itemAt(store)[field], value, field);
    if (!stored.whenDayOffset) assert.equal(itemAt(store).whenDayOffset, undefined, 'absent offset === 0, one representation');
  }
  // America/New_York repeats 01:30 on 2026-11-01: the EARLIER occurrence (EDT, UTC-4), deterministically.
  const fallBack = { target: { store: 'calendar', id: 'cal1:2026-11-01' }, title: 'x', when: '01:30', whenTz: 'America/New_York' };
  const later = harness({ domain: planDomain(), nowMs: Date.parse('2026-10-30T00:00:00Z') });
  const ny = await later.handle(request({ parameters: fallBack, signed: { timestamp: Math.floor(Date.parse('2026-10-30T00:00:00Z') / 1000) } }));
  assert.equal(ny.status, 200, JSON.stringify(ny.body));
  assert.equal(ny.body.result.schedule.startAt, '2026-11-01T05:30:00.000Z');
  // Date-only: no fabricated midnight, zone or offset.
  const store = planDomain();
  const h = harness({ domain: store });
  const dateOnly = await h.handle(request({ parameters: { target: GYM.target, title: 'Call mom' } }));
  assert.equal(dateOnly.status, 200, JSON.stringify(dateOnly.body));
  assert.equal(dateOnly.body.result.schedule, null);
  assert.deepEqual(Object.keys(itemAt(store)).sort(), ['creationActionId', 'done', 'id', 'kind', 'task', 'updatedAt', 'updatedBy', 'when']);
  assert.equal(itemAt(store).when, '');
});

test('time and input refusals happen before any receipt or write', async () => {
  const bad = [
    [{ ...GYM, target: { store: 'calendar', id: 'cal1:2026-03-08' }, when: '02:30', whenTz: 'America/New_York' }, 'NONEXISTENT_TIME'],
    [{ ...GYM, when: '23:30', whenDayOffset: 1, durationMinutes: 720 }, 'DOMAIN_LIMIT'],
    [{ ...GYM, when: '6pm' }, 'INVALID_INPUT'], [{ ...GYM, when: '24:00' }, 'INVALID_INPUT'], [{ ...GYM, when: '18:60' }, 'INVALID_INPUT'],
    [{ ...GYM, whenTz: 'Mars/Phobos' }, 'INVALID_INPUT'], [{ ...GYM, whenTz: '+08:00' }, 'INVALID_INPUT'], [{ ...GYM, whenTz: undefined }, 'INVALID_INPUT'],
    [{ ...GYM, whenDayOffset: 2 }, 'INVALID_INPUT'], [{ ...GYM, whenDayOffset: -1 }, 'INVALID_INPUT'], [{ ...GYM, whenDayOffset: '1' }, 'INVALID_INPUT'],
    [{ ...GYM, durationMinutes: 0 }, 'DOMAIN_LIMIT'], [{ ...GYM, durationMinutes: 721 }, 'DOMAIN_LIMIT'], [{ ...GYM, durationMinutes: 1.5 }, 'DOMAIN_LIMIT'],
    [{ target: GYM.target, title: 'x', whenTz: ZONE }, 'INVALID_INPUT'], [{ target: GYM.target, title: 'x', durationMinutes: 30 }, 'INVALID_INPUT'],
    [{ ...GYM, title: '' }, 'INVALID_INPUT'], [{ ...GYM, title: '   ' }, 'INVALID_INPUT'], [{ ...GYM, title: 7 }, 'INVALID_INPUT'],
    [{ ...GYM, title: 'x'.repeat(201) }, 'DOMAIN_LIMIT'],
    [{ ...GYM, itemId: 'api1_smuggled' }, 'INVALID_INPUT'], [{ ...GYM, creationActionId: ACTION }, 'INVALID_INPUT'], [{ ...GYM, uid: 'x' }, 'INVALID_INPUT'],
    [{ ...GYM, target: { store: 'calendar', id: planIdOf(TOMORROW), roomId: 'uid_x' } }, 'INVALID_INPUT'],
    [{ ...GYM, target: { store: 'calendar', id: '2026-10-13' } }, 'INVALID_INPUT'], [{ ...GYM, target: { store: 'calendar', id: 'cal1:2026-02-30' } }, 'INVALID_INPUT'],
    [{ ...GYM, target: { store: 'calendar', id: 'cal1:2026-10-13/../x' } }, 'INVALID_INPUT'], [{ ...GYM, target: 'cal1:2026-10-13' }, 'INVALID_INPUT'],
    [[], 'INVALID_INPUT'], [null, 'INVALID_INPUT'],
  ];
  // A canonical zone is required: an alias must be resolved by the controller, never guessed here.
  const alias = ['Asia/Calcutta', 'Asia/Kolkata', 'US/Eastern', 'Etc/UTC', 'UTC'].find(zone => new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone !== zone);
  if (alias) bad.push([{ ...GYM, whenTz: alias }, 'INVALID_INPUT']);
  for (const [parameters, expected] of bad) {
    const store = planDomain();
    const h = harness({ domain: store });
    const response = await h.handle(request({ parameters }));
    assert.equal(code(response), expected, JSON.stringify(parameters));
    assert.equal(store.writes.length, 0);
    assert.equal(h.infra.data.has(RECEIPT(ACTION)), false, `${JSON.stringify(parameters)}: no receipt consumed`);
  }
  assert.ok(alias, 'this runtime has at least one timezone alias to prove the canonical rule');
});

test('unicode, the maximum title and hostile markup are stored exactly as data', async () => {
  for (const title of ['x'.repeat(200), 'Gym 🏋️‍♀️ 健身房 — Ünïcödé', '<script>alert(1)</script><img src=x onerror=alert(1)>', 'a\u0000b"\'\\']) {
    const store = planDomain();
    const h = harness({ domain: store });
    const response = await h.handle(request({ parameters: { ...GYM, title } }));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(itemAt(store).task, title);
    assert.ok(!JSON.stringify(response.body).includes(title.slice(0, 20)) || title.startsWith('x'), 'the response carries no task text');
  }
});

test('strict JSON and the body cap still apply to commands', async () => {
  const id = randomUUID();
  const duplicate = `{"contractVersion":1,"requestId":"${id}","actionId":"${ACTION}","kind":"plan_create","kind":"plan_create","parameters":${JSON.stringify(GYM)},"expectedRevision":null,"actionProvenance":${JSON.stringify(provenanceFor(ACTION))}}`;
  const h = harness({ domain: planDomain() });
  const dup = await h.handle(request({ requestId: id, rawBody: Buffer.from(duplicate, 'utf8') }));
  assert.equal(code(dup), 'INVALID_INPUT');
  const huge = await h.handle(request({ parameters: { ...GYM, title: 'x'.repeat(70_000) } }));
  assert.ok([400, 401, 413, 422].includes(huge.status), `oversized body refused: ${huge.status}`);
  assert.equal(h.infra.data.has(RECEIPT(ACTION)), false);
});

test('scope isolation: read-only and Brain-Dump-only grants cannot plan-write; plan.write cannot Brain-Dump-write', async () => {
  for (const scopes of [['chronasense:read'], ['chronasense:brain-dump.write'], ['chronasense:brain-dump.write', 'chronasense:read']]) {
    const store = planDomain();
    const h = harness({ domain: store });
    const response = await h.handle(request({ scopes }));
    assert.equal(response.status, 403, JSON.stringify(scopes));
    assert.equal(code(response), 'FORBIDDEN');
    assert.equal(store.writes.length, 0);
    assert.ok(!h.infra.calls.some(([op, path]) => op === 'createIfAbsent' && path.startsWith('serverActionReceipts')), 'no receipt');
  }
  const h = harness({ domain: planDomain() });
  const id = randomUUID();
  const brainDump = signedRequest({ path: COMMAND_PATH, requestId: id, signed: { path: COMMAND_PATH, scopes: ['chronasense:plan.write'] },
    envelope: { contractVersion: 1, requestId: id, actionId: ACTION, kind: 'brain_dump_add', parameters: { text: 'x' }, expectedRevision: null, actionProvenance: provenanceFor(ACTION) } });
  assert.equal(code(await h.handle(brainDump)), 'FORBIDDEN');
  assert.equal(code(await h.handle(request({ signed: { subject: 'imposter' } }))), 'FORBIDDEN');
  // plan_create is a command, never a query kind.
  const asQuery = signedRequest({ envelope: { contractVersion: 1, requestId: randomUUID(), kind: 'plan_create', parameters: GYM }, signed: { path: CANONICAL_PATH } });
  assert.equal(code(await h.handle(asQuery)), 'INVALID_INPUT');
});

test('a definite refusal on a takeover stays unknown while an earlier attempt could still land, then becomes terminal', async () => {
  const store = planDomain({ room: { calendarPlanAuthority: null } });
  const started = NOW_MS - 40_000;
  const first = harness({ domain: store, nowMs: started });
  store.set({ failRead: true });
  await first.handle(request({ signed: { timestamp: Math.floor(started / 1000) } })); // an attempt whose outcome is unobservable
  store.set({ failRead: false });
  // Copy that receipt into a fresh harness clock, lease expired, 40 s after the first attempt began.
  const h = harness({ domain: store });
  const receipt = { ...first.infra.data.get(RECEIPT(ACTION)), leaseAcquiredAt: started, leaseExpiresAt: started + 30_000 };
  h.infra.data.set(RECEIPT(ACTION), receipt);
  const early = await h.handle(request());
  assert.equal(code(early), 'PENDING_UNKNOWN', 'NOT_FOUND now, but the first attempt may still be writing');
  assert.equal(h.infra.data.get(RECEIPT(ACTION)).state, 'pending_unknown');
  const lateMs = h.infra.data.get(RECEIPT(ACTION)).leaseAcquiredAt + MAX_ATTEMPT_MS;
  const late = harness({ domain: store, nowMs: lateMs });
  late.infra.data.set(RECEIPT(ACTION), { ...h.infra.data.get(RECEIPT(ACTION)), leaseExpiresAt: lateMs - 1 });
  const terminal = await late.handle(request({ signed: { timestamp: Math.floor(lateMs / 1000) } }));
  assert.equal(code(terminal), 'NOT_FOUND');
  assert.equal(late.infra.data.get(RECEIPT(ACTION)).state, 'rejected');
  assert.equal(store.writes.length, 0);
});

test('a rules refusal of the create is re-checked against the exact child before it is reported', async () => {
  const store = planDomain({ forbidCreate: true });
  const h = harness({ domain: store });
  const response = await h.handle(request());
  assert.equal(code(response), 'FORBIDDEN');
  assert.equal(h.infra.data.get(RECEIPT(ACTION)).state, 'rejected');
  // Same refusal, but the item is in fact there (attributed): applied, never "refused".
  const present = planDomain({ forbidCreate: true });
  present.room.calendarPlanFences = { [planIdOf(TOMORROW)]: {} };
  const h2 = harness({ domain: present });
  const originalCreate = present.createPlanItemIfAbsent;
  present.createPlanItemIfAbsent = async (identity, planId, itemId, actionId, record) => {
    present.room.calendarPlanFences[planId][itemId] = structuredClone(record); // an earlier attempt landed it
    return originalCreate(identity, planId, itemId, actionId, record);
  };
  const applied = await h2.handle(request());
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
});
