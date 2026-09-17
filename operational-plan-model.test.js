import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePlanAuthority, validateOperationalPlanItemRange,
  normalizeOperationalPreparation, buildOperationalPreparation, mergeOperationalPreparations,
  mergeOperationalPlanRecords, OPERATIONAL_PLAN_SCHEMA_VERSION,
} from './operational-plan-model.js';
import {
  legacyBoundaryRevision, proposeBoundaryRevision, operationalDayContaining, operationalDayId,
} from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';

function eighteenHundredHistory() {
  const legacy = legacyBoundaryRevision(MANILA);
  const nowMs = Date.parse('2026-09-14T00:30:00Z'); // Monday 08:30 Manila, the product case
  return proposeBoundaryRevision([legacy], { id: 'r-1800', boundaryTime: '18:00', timezone: MANILA }, nowMs).revisions;
}

// ── resolvePlanAuthority (§9-§13) ───────────────────────────────────────────

test('a legacy (never-configured) day routes to the existing calendar dateKey', () => {
  const revisions = [legacyBoundaryRevision(MANILA)];
  const ref = operationalDayContaining(Date.parse('2026-09-14T04:00:00Z'), revisions); // noon Manila
  const authority = resolvePlanAuthority(ref, revisions);
  assert.deepEqual(authority, { store: 'legacy', dateKey: '2026-09-14' });
});

test('a non-legacy day routes to the operational store keyed by operationalDayId, never a bare date', () => {
  const revisions = eighteenHundredHistory();
  // Monday 20:00 Manila is inside the new Monday-18:00 operational day.
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions);
  const authority = resolvePlanAuthority(ref, revisions);
  assert.equal(authority.store, 'operational');
  assert.equal(authority.operationalDayId, operationalDayId(ref));
  assert.notEqual(authority.operationalDayId, '2026-09-15'); // never a bare date
});

test('the legacy Monday calendar plan and the new Monday-18:00 operational day are different identities (§12)', () => {
  const revisions = eighteenHundredHistory();
  const legacyRef = { v: 1, boundaryRevisionId: 'legacy-calendar-day-v0', timezone: MANILA, boundaryStartDate: '2026-09-14' };
  const legacyAuthority = resolvePlanAuthority(legacyRef, [legacyBoundaryRevision(MANILA)]);
  const newDayRef = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions); // Monday 20:00 Manila -> new Monday-18:00 day
  const newDayAuthority = resolvePlanAuthority(newDayRef, revisions);
  assert.equal(legacyAuthority.store, 'legacy');
  assert.equal(legacyAuthority.dateKey, '2026-09-14');
  assert.equal(newDayAuthority.store, 'operational');
  assert.notEqual(newDayAuthority.operationalDayId, legacyAuthority.dateKey);
});

test('an instant just before the new boundary still routes to legacy — no mid-day flip', () => {
  const revisions = eighteenHundredHistory();
  const justBefore = operationalDayContaining(Date.parse('2026-09-14T09:59:00Z'), revisions); // 17:59 Manila, 1 min before 18:00
  assert.equal(resolvePlanAuthority(justBefore, revisions).store, 'legacy');
  const justAfter = operationalDayContaining(Date.parse('2026-09-14T10:00:00Z'), revisions); // exactly 18:00 Manila
  assert.equal(resolvePlanAuthority(justAfter, revisions).store, 'operational');
});

// ── validateOperationalPlanItemRange (§16, §17) ─────────────────────────────

test('23:00 -> 01:00 under an 18:00-boundary day is VALID (cross-midnight, §16)', () => {
  const revisions = eighteenHundredHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions); // Monday-18:00 day
  const result = validateOperationalPlanItemRange(ref, { when: '23:00', durationMinutes: 120 }, revisions);
  assert.equal(result.ok, true);
});

test('23:00 -> 01:00 as an explicit endClock is also VALID', () => {
  const revisions = eighteenHundredHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions);
  const result = validateOperationalPlanItemRange(ref, { when: '23:00', endClock: '01:00' }, revisions);
  assert.equal(result.ok, true);
});

test('17:30 -> 18:30 for a single 18:00-boundary day is REJECTED (outside the day, §17)', () => {
  const revisions = eighteenHundredHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions);
  const result = validateOperationalPlanItemRange(ref, { when: '17:30', endClock: '18:30' }, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outside-operational-day');
});

test('an untimed item (no when) is not validated against any range — nothing to reject', () => {
  const revisions = eighteenHundredHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions);
  assert.deepEqual(validateOperationalPlanItemRange(ref, { task: 'no time set' }, revisions), { ok: true });
});

test('validation does not reject what the legacy midnight-clamped validator would reject — operational days are not calendar-clamped', () => {
  // planItemEndTime() in plan-tomorrow-model.js would return null for a 23:00+120min
  // block (it wraps past midnight). This module's authority must not inherit that limit.
  const revisions = eighteenHundredHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions);
  const result = validateOperationalPlanItemRange(ref, { when: '23:00', durationMinutes: 120 }, revisions);
  assert.equal(result.ok, true);
  assert.ok(result.endMs > result.startMs);
});

// ── start-only timed items (Live Wiring V1 defect fix) ──────────────────────
//
// `durationMinutes` and `endClock` are BOTH optional on a plan item — the
// legacy store's ordinary "+ Add time, no length" shape. Forwarding that shape
// to resolvePlannedRangeInOperationalDay (which requires exactly one of the
// two) rejected it as 'invalid-input', so the operational store could not hold
// the most common timed item the legacy store already holds.

test('a start-only timed item (when, no duration, no endClock) is VALID and resolves its start inside the day', () => {
  const revisions = eighteenHundredHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions); // Monday-18:00 day
  const result = validateOperationalPlanItemRange(ref, { when: '22:00' }, revisions);
  assert.equal(result.ok, true);
  assert.equal(typeof result.startMs, 'number');
  assert.equal(result.endMs, undefined, 'a start-only item has no end — none is invented for it');
});

test('a start-only timed item AFTER midnight is valid on an 18:00-boundary day (it is inside that day, not the next one)', () => {
  const revisions = eighteenHundredHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions);
  const result = validateOperationalPlanItemRange(ref, { when: '01:00' }, revisions);
  assert.equal(result.ok, true);
  assert.equal(result.startMs, Date.parse('2026-09-14T17:00:00Z'), '01:00 Manila on the FOLLOWING calendar date');
});

test('a start-only item whose `when` is not a canonical HH:MM is rejected, never silently stored as timed', () => {
  const revisions = eighteenHundredHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions);
  assert.deepEqual(validateOperationalPlanItemRange(ref, { when: 'after lunch' }, revisions), { ok: false, reason: 'invalid-input' });
});

// A present-but-malformed range field is an invalid RANGE, not "no range". The
// start-only branch applies only when both fields are genuinely absent; every
// case below was 'invalid-input' before start-only support existed and must stay so.
for (const [label, extra] of [
  ['durationMinutes: 0', { durationMinutes: 0 }],
  ['negative durationMinutes', { durationMinutes: -30 }],
  ['fractional durationMinutes', { durationMinutes: 30.5 }],
  ['string durationMinutes "30"', { durationMinutes: '30' }],
  ['durationMinutes: null', { durationMinutes: null }],
  ['empty endClock', { endClock: '' }],
  ['malformed endClock', { endClock: '25:00' }],
  ['non-clock endClock', { endClock: 'later' }],
  ['endClock: null', { endClock: null }],
]) {
  test(`a timed item with a present-but-malformed range (${label}) is rejected, never treated as start-only`, () => {
    const revisions = eighteenHundredHistory();
    const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions);
    assert.deepEqual(validateOperationalPlanItemRange(ref, { when: '22:00', ...extra }, revisions), { ok: false, reason: 'invalid-input' });
  });
}

test('an explicitly-undefined range field is absent (JSON cannot carry it), so the item is start-only', () => {
  const revisions = eighteenHundredHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions);
  const result = validateOperationalPlanItemRange(ref, { when: '22:00', durationMinutes: undefined, endClock: undefined }, revisions);
  assert.equal(result.ok, true);
  assert.equal(result.endMs, undefined);
});

// ── start-only containment in a revision-truncated day ─────────────────────
//
// The Monday-18:00 day, cut short by a 20:00 revision proposed at 19:00 Monday,
// runs 18:00 -> 20:00 only. resolveClockTimeInOperationalDay picks a calendar
// date but knows nothing about truncation, so containment must be checked.

function truncatedMondayHistory() {
  const proposedAt = Date.parse('2026-09-14T11:00:00Z'); // Monday 19:00 Manila
  return proposeBoundaryRevision(eighteenHundredHistory(), { id: 'r-2000', boundaryTime: '20:00', timezone: MANILA }, proposedAt).revisions;
}

test('truncated 18:00 -> 20:00 day: start-only 19:00 is valid', () => {
  const revisions = truncatedMondayHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T10:30:00Z'), revisions); // Monday 18:30 Manila
  assert.equal(ref.boundaryRevisionId, 'r-1800');
  const result = validateOperationalPlanItemRange(ref, { when: '19:00' }, revisions);
  assert.deepEqual(result, { ok: true, startMs: Date.parse('2026-09-14T11:00:00Z') });
});

for (const when of ['21:00', '01:00', '20:00', '17:59']) {
  test(`truncated 18:00 -> 20:00 day: start-only ${when} is rejected as outside the operational day`, () => {
    const revisions = truncatedMondayHistory();
    const ref = operationalDayContaining(Date.parse('2026-09-14T10:30:00Z'), revisions);
    assert.deepEqual(validateOperationalPlanItemRange(ref, { when }, revisions), { ok: false, reason: 'outside-operational-day' });
  });
}

test('truncated 18:00 -> 20:00 day: a ranged item keeps the same outside-day failure form', () => {
  const revisions = truncatedMondayHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T10:30:00Z'), revisions);
  assert.deepEqual(validateOperationalPlanItemRange(ref, { when: '21:00', durationMinutes: 30 }, revisions), { ok: false, reason: 'outside-operational-day' });
});

// ── operational preparation (§14) ───────────────────────────────────────────

test('normalizeOperationalPreparation requires targetOperationalDayId, not a calendar targetDate', () => {
  const opId = 'odv1:r-1800:Asia/Manila:2026-09-14';
  const value = {
    schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION, targetOperationalDayId: opId,
    firstPreparedAt: 1000, firstPreparedMode: 'normal', firstPreparedBy: 'device-a',
    lastPreparedAt: 1000, lastPreparedMode: 'normal', updatedBy: 'device-a',
    intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['p1']
  };
  assert.ok(normalizeOperationalPreparation(value, opId));
  assert.equal(normalizeOperationalPreparation({ ...value, targetOperationalDayId: 'other' }, opId), null);
  assert.equal(normalizeOperationalPreparation({ ...value, targetDate: '2026-09-14', targetOperationalDayId: undefined }, opId), null);
});

test('buildOperationalPreparation + mergeOperationalPreparations mirror the legacy earliest-first/latest-last contract', () => {
  const opId = 'odv1:r-1800:Asia/Manila:2026-09-14';
  const first = buildOperationalPreparation(null, {
    targetOperationalDayId: opId, now: 1000, mode: 'normal', updatedBy: 'device-a',
    intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['p1']
  });
  assert.equal(first.firstPreparedAt, 1000);
  assert.equal(first.lastPreparedAt, 1000);
  const second = buildOperationalPreparation(first, {
    targetOperationalDayId: opId, now: 2000, mode: 'rescue', updatedBy: 'device-b',
    intentionalBlank: true, routineInstanceIds: [], oneOffItemIds: []
  });
  assert.equal(second.firstPreparedAt, 1000); // first stays first
  assert.equal(second.firstPreparedBy, 'device-a');
  assert.equal(second.lastPreparedAt, 2000); // last advances
  assert.equal(second.lastPreparedMode, 'rescue');
  assert.equal(second.intentionalBlank, true);
});

test('operational preparation never leaks into or reads from a calendar targetDate field', () => {
  const opId = 'odv1:r-1800:Asia/Manila:2026-09-14';
  const prep = buildOperationalPreparation(null, {
    targetOperationalDayId: opId, now: 1000, mode: 'normal', updatedBy: 'device-a',
    intentionalBlank: true, routineInstanceIds: [], oneOffItemIds: []
  });
  assert.equal('targetDate' in prep, false);
  assert.equal(prep.targetOperationalDayId, opId);
});

// ── operational plan record merge (§15) ─────────────────────────────────────

test('mergeOperationalPlanRecords does per-item LWW-by-id merge, same algorithm as the legacy store', () => {
  const opId = 'odv1:r-1800:Asia/Manila:2026-09-14';
  const local = { items: [{ id: 'p1', task: 'local version', updatedAt: 100, updatedBy: 'device-a' }], updatedAt: 100, updatedBy: 'device-a' };
  const remote = { items: [{ id: 'p1', task: 'remote version', updatedAt: 200, updatedBy: 'device-b' }], updatedAt: 200, updatedBy: 'device-b' };
  const merged = mergeOperationalPlanRecords(local, remote, opId);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].task, 'remote version'); // newer updatedAt wins
});

test('mergeOperationalPlanRecords preserves cross-midnight item fields untouched (durationMinutes past midnight)', () => {
  const opId = 'odv1:r-1800:Asia/Manila:2026-09-14';
  const local = { items: [{ id: 'p1', task: 'late shift', when: '23:00', durationMinutes: 120, updatedAt: 100, updatedBy: 'a' }], updatedAt: 100 };
  const merged = mergeOperationalPlanRecords(local, null, opId);
  assert.equal(merged.items[0].when, '23:00');
  assert.equal(merged.items[0].durationMinutes, 120);
});

test('mergeOperationalPlanRecords merges preparation using the operational (not calendar) contract', () => {
  const opId = 'odv1:r-1800:Asia/Manila:2026-09-14';
  const local = { items: [], updatedAt: 100, preparation: { schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION, targetOperationalDayId: opId, firstPreparedAt: 1000, firstPreparedMode: 'normal', firstPreparedBy: 'a', lastPreparedAt: 1000, lastPreparedMode: 'normal', updatedBy: 'a', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: [] } };
  const remote = { items: [], updatedAt: 50, preparation: { schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION, targetOperationalDayId: opId, firstPreparedAt: 500, firstPreparedMode: 'normal', firstPreparedBy: 'b', lastPreparedAt: 2000, lastPreparedMode: 'rescue', updatedBy: 'b', intentionalBlank: true, routineInstanceIds: [], oneOffItemIds: [] } };
  const merged = mergeOperationalPlanRecords(local, remote, opId);
  assert.equal(merged.preparation.firstPreparedAt, 500); // earliest first
  assert.equal(merged.preparation.lastPreparedAt, 2000); // latest last
  assert.equal(merged.preparation.intentionalBlank, true);
});
