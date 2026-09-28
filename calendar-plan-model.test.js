import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActivationFact,
  calendarAuthorityForDate,
  calendarItemInstants,
  calendarPlanId,
  calendarPlanInterval,
  effectiveActivation,
  mergeCalendarPlanRecords,
  parseCalendarPlanId,
  stampCalendarItemTimes,
  validateActivationFact,
  validateCalendarPlanItem,
} from './calendar-plan-model.js';

const MANILA = 'Asia/Manila';
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const SUNDAY = '2026-09-27';

const timed = (id, when, extra = {}) => ({ id, task: id, when, whenTz: MANILA, done: false, updatedAt: 1, updatedBy: 'a', ...extra });

// ── identity ────────────────────────────────────────────────────────────────

test('a calendar plan id is the date and nothing else: deterministic and reversible', () => {
  assert.equal(calendarPlanId(SUNDAY), 'cal1:2026-09-27');
  assert.equal(parseCalendarPlanId('cal1:2026-09-27'), SUNDAY);
  for (const bad of ['odv1:r:Asia/Manila:2026-09-27', '2026-09-27', 'cal1:2026-13-40', 'cal2:2026-09-27', '', null, undefined, 5]) {
    assert.equal(parseCalendarPlanId(bad), null, String(bad));
  }
  assert.throws(() => calendarPlanId('2026-9-27'));
});

// ── representability: the Sunday plan that continues across midnight ────────

test('one Sunday plan represents 11:00, 18:00, 23:00 AND Monday 01:00, 04:00, 09:00 with their true instants', () => {
  const items = [
    timed('a', '11:00'),
    timed('b', '18:00'),
    timed('c', '23:00'),
    timed('d', '01:00', { whenDayOffset: 1 }),
    timed('e', '04:00', { whenDayOffset: 1 }),
    timed('f', '09:00', { whenDayOffset: 1 }),
  ];
  const expected = {
    a: at('2026-09-27', '11:00'), b: at('2026-09-27', '18:00'), c: at('2026-09-27', '23:00'),
    d: at('2026-09-28', '01:00'), e: at('2026-09-28', '04:00'), f: at('2026-09-28', '09:00'),
  };
  for (const item of items) {
    assert.deepEqual(validateCalendarPlanItem(SUNDAY, item), { ok: true }, item.id);
    const instants = calendarItemInstants(SUNDAY, item);
    assert.equal(instants.startMs, expected[item.id], `${item.id} keeps its factual instant`);
  }
  // Monday 01:00 is NOT Sunday 01:00: the offset is what carries the date.
  assert.notEqual(calendarItemInstants(SUNDAY, items[3]).startMs, calendarItemInstants(SUNDAY, timed('x', '01:00')).startMs);
});

test('the legacy Personal Day boundary is not an input to any of it (an 18:00 boundary cannot reinterpret 11:00)', () => {
  // The model has no boundary parameter at all; the reading is the reading.
  const instants = calendarItemInstants(SUNDAY, timed('a', '11:00'));
  assert.equal(instants.startMs, at('2026-09-27', '11:00'));
});

test('a range may cross midnight inside its plan, and never past the end of the next date', () => {
  assert.equal(calendarItemInstants(SUNDAY, timed('r', '23:00', { durationMinutes: 120 })).endMs, at('2026-09-28', '01:00'));
  assert.deepEqual(validateCalendarPlanItem(SUNDAY, timed('r', '23:00', { durationMinutes: 120 })), { ok: true });
  // Monday 23:00 + 2h ends on Tuesday: outside a plan's two-date extent.
  assert.deepEqual(validateCalendarPlanItem(SUNDAY, timed('r', '23:00', { whenDayOffset: 1, durationMinutes: 120 })), { ok: false, reason: 'outside-plan-extent' });
  assert.deepEqual(validateCalendarPlanItem(SUNDAY, timed('r', '22:00', { whenDayOffset: 1, durationMinutes: 120 })), { ok: true });
});

test('malformed time fields are refused with a reason, never coerced', () => {
  assert.equal(validateCalendarPlanItem(SUNDAY, timed('x', '9:00')).ok, true); // free text is simply not a structured time
  assert.equal(calendarItemInstants(SUNDAY, timed('x', '9:00')).timed, false);
  assert.equal(validateCalendarPlanItem(SUNDAY, timed('x', '09:00', { whenDayOffset: 2 })).reason, 'invalid-offset');
  assert.equal(validateCalendarPlanItem(SUNDAY, timed('x', '09:00', { whenDayOffset: '1' })).reason, 'invalid-offset');
  assert.equal(validateCalendarPlanItem(SUNDAY, timed('x', '09:00', { whenTz: undefined })).reason, 'missing-timezone');
  assert.equal(validateCalendarPlanItem(SUNDAY, timed('x', '09:00', { whenTz: 'Mars/Base' })).reason, 'invalid-timezone');
  assert.equal(validateCalendarPlanItem(SUNDAY, timed('x', '09:00', { durationMinutes: 0 })).reason, 'invalid-range');
  assert.equal(validateCalendarPlanItem(SUNDAY, timed('x', '09:00', { durationMinutes: 721 })).reason, 'invalid-range');
  assert.equal(validateCalendarPlanItem(SUNDAY, { id: 'x', task: 'x', when: '', durationMinutes: 30 }).reason, 'invalid-range');
  assert.equal(validateCalendarPlanItem('nope', timed('x', '09:00')).reason, 'invalid-plan-date');
});

test('DST: a repeated clock hour resolves to the EARLIER occurrence, a skipped one is refused', () => {
  const ny = { whenTz: 'America/New_York' };
  // 2026-11-01: 01:30 happens twice (EDT then EST). 2026-03-08: 02:30 does not exist.
  const repeated = calendarItemInstants('2026-11-01', { id: 'x', task: 'x', when: '01:30', ...ny });
  assert.equal(repeated.startMs, Date.parse('2026-11-01T01:30:00-04:00'));
  assert.equal(calendarItemInstants('2026-03-08', { id: 'x', task: 'x', when: '02:30', ...ny }).reason, 'nonexistent-time');
});

// ── historical timezone truth ───────────────────────────────────────────────

test('stamping freezes the zone an item was scheduled in and never restamps an unchanged reading', () => {
  const stored = stampCalendarItemTimes([], [{ id: 'a', task: 'a', when: '11:00' }], MANILA);
  assert.equal(stored[0].whenTz, MANILA);
  const before = calendarItemInstants(SUNDAY, stored[0]).startMs;
  // The account later moves to Los Angeles; the item is edited only in ways that do not touch its reading.
  const later = stampCalendarItemTimes(stored, [{ ...stored[0], done: true, doneAt: 5 }], 'America/Los_Angeles');
  assert.equal(later[0].whenTz, MANILA);
  assert.equal(calendarItemInstants(SUNDAY, later[0]).startMs, before);
  assert.equal(before, at('2026-09-27', '11:00'));
});

test('changing an item\'s own reading restamps it with the zone the NEW reading is made in', () => {
  const stored = stampCalendarItemTimes([], [{ id: 'a', task: 'a', when: '11:00' }], MANILA);
  const moved = stampCalendarItemTimes(stored, [{ ...stored[0], when: '12:00' }], 'America/Los_Angeles');
  assert.equal(moved[0].whenTz, 'America/Los_Angeles');
  const offsetChanged = stampCalendarItemTimes(stored, [{ ...stored[0], whenDayOffset: 1 }], 'America/Los_Angeles');
  assert.equal(offsetChanged[0].whenTz, 'America/Los_Angeles');
});

test('an untimed item carries no time fields; offset 0 has exactly one representation (absent)', () => {
  const [item] = stampCalendarItemTimes([], [{ id: 'a', task: 'a', when: '', whenTz: MANILA, whenDayOffset: 1 }], MANILA);
  assert.equal('whenTz' in item, false);
  assert.equal('whenDayOffset' in item, false);
  const [zero] = stampCalendarItemTimes([], [{ id: 'b', task: 'b', when: '10:00', whenDayOffset: 0 }], MANILA);
  assert.equal('whenDayOffset' in zero, false);
});

test('a plan\'s home interval is its own calendar date in the given zone, not a boundary window', () => {
  const { startMs, endMs } = calendarPlanInterval(SUNDAY, MANILA);
  assert.equal(startMs, at('2026-09-27', '00:00'));
  assert.equal(endMs, at('2026-09-28', '00:00'));
});

// ── merge ───────────────────────────────────────────────────────────────────

const ID = calendarPlanId(SUNDAY);
const rec = (items, extra = {}) => ({ items, updatedAt: 10, updatedBy: 'a', ...extra });

test('merging is order-independent: the same two records converge whichever arrives first', () => {
  const a = rec([timed('x', '11:00', { updatedAt: 5 }), timed('y', '12:00', { updatedAt: 9 })], { createdAt: 100, timezone: MANILA, updatedAt: 9 });
  const b = rec([timed('x', '11:30', { updatedAt: 7, updatedBy: 'b' }), timed('z', '13:00')], { createdAt: 50, timezone: 'Asia/Tokyo', updatedAt: 7, updatedBy: 'b' });
  const ab = mergeCalendarPlanRecords(a, b, ID);
  const ba = mergeCalendarPlanRecords(b, a, ID);
  assert.deepEqual(ab, ba);
  assert.equal(ab.items.find(item => item.id === 'x').when, '11:30'); // per-item LWW
  assert.equal(ab.items.length, 3);
  assert.equal(ab.createdAt, 50); // the EARLIEST writer freezes the home zone
  assert.equal(ab.timezone, 'Asia/Tokyo');
});

test('merging never invents a home zone and rejects a non-calendar id', () => {
  const merged = mergeCalendarPlanRecords(rec([timed('x', '11:00')]), null, ID);
  assert.equal('timezone' in merged, false);
  assert.throws(() => mergeCalendarPlanRecords({}, {}, 'odv1:r:Asia/Manila:2026-09-27'));
});

test('a tombstone beats a live copy by the same rule as every other plan store (newest write wins)', () => {
  const live = timed('x', '11:00', { updatedAt: 5 });
  const gone = { ...live, deleted: true, updatedAt: 6 };
  assert.equal(mergeCalendarPlanRecords(rec([live]), rec([gone]), ID).items[0].deleted, true);
  assert.equal(mergeCalendarPlanRecords(rec([gone]), rec([live]), ID).items[0].deleted, true);
});

// ── authority cutover facts ─────────────────────────────────────────────────

const fact = (id, nowMs, extra = {}) => buildActivationFact({ id, nowMs, timezone: MANILA, deviceId: 'dev', ...extra });

test('an activation fact carries the date its instant was in its own zone, and a fact whose fields disagree is invalid', () => {
  const f = fact('a1', at('2026-09-27', '11:00'));
  assert.equal(f.activationDate, SUNDAY);
  assert.equal(validateActivationFact(f), true);
  assert.equal(validateActivationFact({ ...f, activationDate: '2026-09-28' }), false);
  assert.equal(validateActivationFact({ ...f, timezone: 'Mars/Base' }), false);
  assert.equal(validateActivationFact({ ...f, id: 'a/b' }), false);
  assert.equal(validateActivationFact({ ...f, schemaVersion: 2 }), false);
  assert.equal(validateActivationFact(null), false);
});

test('the effective activation is the earliest fact and does not depend on arrival order', () => {
  const early = fact('b', at('2026-09-27', '11:00'));
  const late = fact('a', at('2026-09-28', '09:00'));
  const tie1 = fact('m', at('2026-09-27', '11:00'), { deviceId: 'other' });
  assert.equal(effectiveActivation([late, early]).id, 'b');
  assert.equal(effectiveActivation([early, late]).id, 'b');
  assert.equal(effectiveActivation([early, tie1]).id, effectiveActivation([tie1, early]).id); // equal instant: id breaks the tie
  assert.equal(effectiveActivation([]), null);
  assert.equal(effectiveActivation([{ junk: true }]), null);
});

test('dates on/after the effective activation date are calendar-authoritative; earlier and no-activation are legacy', () => {
  const activation = fact('a', at('2026-09-27', '11:00'));
  assert.equal(calendarAuthorityForDate('2026-09-26', activation), 'legacy');
  assert.equal(calendarAuthorityForDate('2026-09-27', activation), 'calendar');
  assert.equal(calendarAuthorityForDate('2026-10-05', activation), 'calendar');
  assert.equal(calendarAuthorityForDate('2026-09-27', null), 'legacy');
});

test('cross-timezone cutover is set-derived and monotonic: adding a fact can move authority earlier, never later', () => {
  const earlierInstantLaterDate = buildActivationFact({
    id: 'a-manila', nowMs: Date.parse('2026-09-27T00:30:00Z'), timezone: MANILA, deviceId: 'manila-device',
  });
  const laterInstantEarlierDate = buildActivationFact({
    id: 'z-los-angeles', nowMs: Date.parse('2026-09-27T05:00:00Z'), timezone: 'America/Los_Angeles', deviceId: 'la-device',
  });
  assert.equal(earlierInstantLaterDate.activationDate, '2026-09-27');
  assert.equal(laterInstantEarlierDate.activationDate, '2026-09-26');

  for (const order of [[earlierInstantLaterDate, laterInstantEarlierDate], [laterInstantEarlierDate, earlierInstantLaterDate]]) {
    const states = [];
    for (let count = 1; count <= order.length; count++) {
      const activation = effectiveActivation(order.slice(0, count));
      states.push(calendarAuthorityForDate('2026-09-26', activation));
    }
    assert.equal(states.at(-1), 'calendar');
    const firstCalendar = states.indexOf('calendar');
    if (firstCalendar >= 0) assert.ok(states.slice(firstCalendar).every(state => state === 'calendar'));
    assert.equal(effectiveActivation(order).authorityActivationDate, '2026-09-26');
  }
});

test('same-instant cross-timezone facts converge by minimum activation date even when provenance selects the later date', () => {
  const instant = Date.parse('2026-09-27T00:30:00Z');
  const manila = buildActivationFact({ id: 'a-manila', nowMs: instant, timezone: MANILA, deviceId: 'a' });
  const losAngeles = buildActivationFact({ id: 'z-la', nowMs: instant, timezone: 'America/Los_Angeles', deviceId: 'z' });
  for (const facts of [[manila, losAngeles], [losAngeles, manila]]) {
    const activation = effectiveActivation(facts);
    assert.equal(activation.id, 'a-manila');
    assert.equal(activation.authorityActivationDate, '2026-09-26');
    assert.equal(calendarAuthorityForDate('2026-09-26', activation), 'calendar');
  }
});

// ── wire format: Realtime Database persists no empty array ─────────────────

import { restorePrunedPlanRecord } from './calendar-plan-model.js';
import { normalizePreparation } from './plan-tomorrow-model.js';

test('a record pruned by the database (no items, no routines) is restored before it is merged, so a second device still reads the preparation', () => {
  const written = { items: [], updatedAt: 5, updatedBy: 'a', preparation: { schemaVersion: 1, targetDate: SUNDAY, timezone: MANILA, firstPreparedAt: 1, firstPreparedMode: 'normal', lastPreparedAt: 1, lastPreparedMode: 'normal', updatedBy: 'a', intentionalBlank: true, routineInstanceIds: [], oneOffItemIds: [] } };
  const onTheWire = JSON.parse(JSON.stringify(written));
  delete onTheWire.items; delete onTheWire.preparation.routineInstanceIds; delete onTheWire.preparation.oneOffItemIds; // what RTDB does
  assert.equal(normalizePreparation(onTheWire.preparation, SUNDAY), null, 'without restoring, the preparation is unreadable');
  const restored = restorePrunedPlanRecord(onTheWire);
  assert.deepEqual(restored.items, []);
  assert.deepEqual(normalizePreparation(restored.preparation, SUNDAY)?.routineInstanceIds, []);
  assert.equal(mergeCalendarPlanRecords(null, onTheWire, ID).preparation.intentionalBlank, true);
  assert.deepEqual(restorePrunedPlanRecord(null), null);
  assert.deepEqual(restorePrunedPlanRecord({ items: [{ id: 'x' }] }).items, [{ id: 'x' }]);
});
