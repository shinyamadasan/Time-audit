import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPERATIONAL_DAY_SCHEMA_VERSION, LEGACY_CALENDAR_DAY_REVISION_ID,
  validBoundaryStartDate, validBoundaryTime, validOperationalDayTimezone, validateBoundaryRevision,
  legacyBoundaryRevision, normalizeBoundaryRevisionHistory, activeBoundaryRevision,
  nextBoundaryInstant, proposeBoundaryRevision,
  operationalDayId, parseOperationalDayId, isLegacyOperationalDay, operationalDayStartingOn,
  operationalDayContaining, currentOperationalDay, operationalDayInterval, instantInOperationalDay,
  nextOperationalDay, previousOperationalDay, overlappingCalendarDates, resolveClockTimeInOperationalDay,
} from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';
const NY = 'America/New_York';
const legacyManila = legacyBoundaryRevision(MANILA);
const legacyNY = legacyBoundaryRevision(NY);
const iso = s => Date.parse(s);

// ── validators ─────────────────────────────────────────────────────────────

test('validators reject malformed input', () => {
  assert.equal(validBoundaryStartDate('2026-09-14'), true);
  assert.equal(validBoundaryStartDate('2026-9-14'), false);
  assert.equal(validBoundaryStartDate('2026-02-30'), false); // not a real date
  assert.equal(validBoundaryStartDate(''), false);
  assert.equal(validBoundaryTime('18:00'), true);
  assert.equal(validBoundaryTime('00:00'), true);
  assert.equal(validBoundaryTime('24:00'), false);
  assert.equal(validBoundaryTime('9:00'), false);
  assert.equal(validOperationalDayTimezone(MANILA), true);
  assert.equal(validOperationalDayTimezone('Not/AZone'), false);
  assert.equal(validOperationalDayTimezone('odv1:x'), false); // colon disallowed for id-safety
});

test('validateBoundaryRevision requires id, boundaryTime, timezone, and a well-formed effectiveFromInstant', () => {
  assert.equal(validateBoundaryRevision(legacyManila), true);
  assert.equal(validateBoundaryRevision({ id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: 0 }), true);
  assert.equal(validateBoundaryRevision({ id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: -1 }), false);
  assert.equal(validateBoundaryRevision({ id: 'bad:id', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null }), false);
  assert.equal(validateBoundaryRevision({ id: 'r1', boundaryTime: '25:00', timezone: MANILA, effectiveFromInstant: null }), false);
  assert.equal(validateBoundaryRevision(null), false);
});

// ── revision history invariants ─────────────────────────────────────────────

test('normalizeBoundaryRevisionHistory requires exactly one null-anchor revision', () => {
  assert.throws(() => normalizeBoundaryRevisionHistory([]));
  assert.throws(() => normalizeBoundaryRevisionHistory([{ id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: 1000 }]));
  assert.throws(() => normalizeBoundaryRevisionHistory([legacyManila, legacyBoundaryRevision(MANILA, 'other-anchor')]));
  assert.throws(() => normalizeBoundaryRevisionHistory([legacyManila, legacyManila])); // duplicate id
  const alignedInstant = iso('2026-09-14T10:00:00Z'); // 18:00 Manila — an occurrence of '18:00'
  const r1 = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: alignedInstant };
  const r1dup = { id: 'r2', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: alignedInstant };
  assert.throws(() => normalizeBoundaryRevisionHistory([legacyManila, r1, r1dup])); // duplicate effective instant
  const sorted = normalizeBoundaryRevisionHistory([r1, legacyManila]);
  assert.deepEqual(sorted.map(r => r.id), [legacyManila.id, 'r1']);
});

test('normalizeBoundaryRevisionHistory rejects a revision whose effectiveFromInstant is not an occurrence of its own boundary time', () => {
  const misaligned = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: iso('2026-09-14T00:00:00Z') };
  assert.throws(() => normalizeBoundaryRevisionHistory([legacyManila, misaligned]));
});

test('activeBoundaryRevision resolves strictly from the instant, never from "latest"', () => {
  const r1 = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: iso('2026-09-14T10:00:00Z') };
  const history = [legacyManila, r1];
  assert.equal(activeBoundaryRevision(history, iso('2026-09-14T09:59:59Z')).id, legacyManila.id);
  assert.equal(activeBoundaryRevision(history, iso('2026-09-14T10:00:00Z')).id, 'r1'); // effective instant is inclusive
  assert.equal(activeBoundaryRevision(history, iso('2026-01-01T00:00:00Z')).id, legacyManila.id);
});

// ── §4 default compatibility: 00:00 boundary reduces to calendar day ───────

test('00:00 boundary parity with calendar-day semantics across timezones and DST', () => {
  const cases = [
    [MANILA, '2026-09-14T09:00:00Z'],       // ordinary
    [NY, '2026-03-08T06:59:00Z'],           // just before US spring-forward
    [NY, '2026-03-08T07:01:00Z'],           // just after
    [NY, '2026-11-01T05:30:00Z'],           // just before US fall-back
    [NY, '2026-11-01T06:30:00Z'],           // just after
    ['UTC', '2026-01-01T00:00:00Z'],        // exact midnight
  ];
  for (const [tz, instant] of cases) {
    const revisions = [legacyBoundaryRevision(tz)];
    const ref = operationalDayContaining(iso(instant), revisions);
    const calendarDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso(instant)));
    assert.equal(ref.boundaryStartDate, calendarDate, `${tz} ${instant}`);
    assert.deepEqual(overlappingCalendarDates(ref, revisions), [calendarDate]);
  }
});

// ── §3/§12 half-open interval + clock-time placement (18:00 Asia/Manila) ────

test('18:00 boundary: Monday 08:30 belongs to the operational day starting Sunday 18:00', () => {
  const revisions = [{ id: 'boundary-18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null }];
  // Monday 2026-09-14 08:30 Manila == 2026-09-14T00:30:00Z (Manila is UTC+8, no DST)
  const ref = operationalDayContaining(iso('2026-09-14T00:30:00Z'), revisions);
  assert.equal(ref.boundaryStartDate, '2026-09-13'); // Sunday
  assert.deepEqual(overlappingCalendarDates(ref, revisions), ['2026-09-13', '2026-09-14']);
});

test('an instant exactly at the boundary belongs to the NEW day, never the old one', () => {
  const revisions = [{ id: 'boundary-18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null }];
  const exactlyAtBoundary = iso('2026-09-15T10:00:00Z'); // Tuesday 18:00 Manila exactly
  const ref = operationalDayContaining(exactlyAtBoundary, revisions);
  assert.equal(ref.boundaryStartDate, '2026-09-15'); // Tuesday, not Monday
  const oneMsBefore = operationalDayContaining(exactlyAtBoundary - 1, revisions);
  assert.equal(oneMsBefore.boundaryStartDate, '2026-09-14'); // still Monday
});

test('clock-time placement table for an 18:00-boundary operational day', () => {
  const revisions = [{ id: 'boundary-18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null }];
  const ref = operationalDayStartingOn('2026-09-14', revisions[0]); // Monday
  const cases = [
    ['18:00', '2026-09-14T18:00:00'],
    ['22:00', '2026-09-14T22:00:00'],
    ['23:59', '2026-09-14T23:59:00'],
    ['00:00', '2026-09-15T00:00:00'],
    ['02:00', '2026-09-15T02:00:00'],
    ['08:00', '2026-09-15T08:00:00'],
    ['17:59', '2026-09-15T17:59:00'],
  ];
  for (const [hhmm, expectedLocal] of cases) {
    const ts = resolveClockTimeInOperationalDay(ref, hhmm, revisions);
    const expected = iso(`${expectedLocal}+08:00`); // Manila is fixed UTC+8
    assert.equal(ts, expected, hhmm);
  }
  // The boundary time itself resolves to this day's own start instant, which
  // is exactly the end instant of the previous day and the start of this one.
  const { startMs } = operationalDayInterval(ref, revisions);
  assert.equal(resolveClockTimeInOperationalDay(ref, '18:00', revisions), startMs);
  assert.equal(operationalDayInterval(previousOperationalDay(ref, revisions), revisions).endMs, startMs);
});

test('instantInOperationalDay respects the half-open interval', () => {
  const revisions = [{ id: 'boundary-18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null }];
  const ref = operationalDayStartingOn('2026-09-14', revisions[0]);
  const { startMs, endMs } = operationalDayInterval(ref, revisions);
  assert.equal(instantInOperationalDay(startMs, ref, revisions), true);       // inclusive start
  assert.equal(instantInOperationalDay(endMs - 1, ref, revisions), true);
  assert.equal(instantInOperationalDay(endMs, ref, revisions), false);        // exclusive end
  assert.equal(instantInOperationalDay(startMs - 1, ref, revisions), false);
});

// ── §6 stable identity ───────────────────────────────────────────────────

test('operationalDayId round-trips and never collides with a bare calendar dateKey', () => {
  const revision = { id: 'boundary-18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  const ref = operationalDayStartingOn('2026-09-14', revision);
  const id = operationalDayId(ref);
  assert.equal(id, 'odv1:boundary-18:Asia/Manila:2026-09-14');
  assert.notEqual(id, '2026-09-14'); // never a bare legacy plan dateKey
  assert.deepEqual(parseOperationalDayId(id), ref);
  assert.equal(parseOperationalDayId('2026-09-14'), null);
  assert.equal(parseOperationalDayId('garbage'), null);
  assert.equal(ref.v, OPERATIONAL_DAY_SCHEMA_VERSION);
});

test('isLegacyOperationalDay reflects only the governing revision, per §9 contract', () => {
  const revisions = [legacyManila];
  const ref = currentOperationalDay(Date.now(), revisions);
  assert.equal(isLegacyOperationalDay(ref, revisions), true);
  assert.equal(ref.boundaryRevisionId, LEGACY_CALENDAR_DAY_REVISION_ID);
  const nonLegacy = { id: 'boundary-18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  // Even a null-effective revision that ISN'T the designated legacy one is
  // still an anchor and still counts as legacy by the null-instant contract.
  assert.equal(isLegacyOperationalDay(operationalDayStartingOn('2026-09-14', nonLegacy), [nonLegacy]), true);
});

// ── §7/§8/§11 boundary revisions, prospective activation, no reinterpretation ─

test('proposeBoundaryRevision activates at the NEXT occurrence of the candidate\'s own boundary time', () => {
  const decisionBefore = iso('2026-09-14T00:30:00Z'); // Monday 08:30 Manila
  const { revision: r1 } = proposeBoundaryRevision([legacyManila], { id: 'r1', boundaryTime: '18:00', timezone: MANILA }, decisionBefore);
  assert.equal(r1.effectiveFromInstant, iso('2026-09-14T10:00:00Z')); // Monday 18:00 Manila — same day

  const decisionAfter = iso('2026-09-14T11:00:00Z'); // Monday 19:00 Manila, past today's 18:00
  const { revision: r2 } = proposeBoundaryRevision([legacyManila], { id: 'r2', boundaryTime: '18:00', timezone: MANILA }, decisionAfter);
  assert.equal(r2.effectiveFromInstant, iso('2026-09-15T10:00:00Z')); // rolls to Tuesday 18:00

  const decisionExactly = iso('2026-09-14T10:00:00Z'); // exactly Monday 18:00 Manila
  const { revision: r3 } = proposeBoundaryRevision([legacyManila], { id: 'r3', boundaryTime: '18:00', timezone: MANILA }, decisionExactly);
  assert.equal(r3.effectiveFromInstant, decisionExactly); // "at or after now" is inclusive of now
});

test('a boundary revision never reinterprets instants that came before it', () => {
  const decisionAt = iso('2026-09-14T00:30:00Z'); // Monday 08:30 Manila
  const { revision, revisions } = proposeBoundaryRevision([legacyManila], { id: 'r1', boundaryTime: '18:00', timezone: MANILA }, decisionAt);

  // An instant from last week is still governed by the legacy (00:00) revision.
  const lastWeek = iso('2026-09-07T00:30:00Z');
  const lastWeekRef = operationalDayContaining(lastWeek, revisions);
  assert.equal(lastWeekRef.boundaryRevisionId, LEGACY_CALENDAR_DAY_REVISION_ID);
  assert.equal(lastWeekRef.boundaryStartDate, '2026-09-07'); // plain calendar date, unaffected

  // The instant the new boundary activates is now governed by the new revision.
  const atActivation = operationalDayContaining(revision.effectiveFromInstant, revisions);
  assert.equal(atActivation.boundaryRevisionId, 'r1');
  assert.equal(atActivation.boundaryStartDate, '2026-09-14');

  // The decision moment itself (before its own revision takes effect) is
  // still governed by the legacy revision, exactly as the task's example
  // requires: earlier Monday morning is not retroactively redefined.
  const decisionMoment = operationalDayContaining(decisionAt, revisions);
  assert.equal(decisionMoment.boundaryRevisionId, LEGACY_CALENDAR_DAY_REVISION_ID);
  assert.equal(decisionMoment.boundaryStartDate, '2026-09-14');
});

test('nextOperationalDay/previousOperationalDay honor a revision change exactly at the crossing', () => {
  const activation = iso('2026-09-15T10:00:00Z'); // Tuesday 18:00 Manila — must align to r1's own boundary time
  const revisions = normalizeBoundaryRevisionHistory([
    legacyManila,
    { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: activation },
  ]);
  // The in-progress legacy (00:00-boundary) day that activation interrupts:
  // Tuesday's calendar day was already under way when r1 took over mid-day.
  const interruptedLegacyDay = operationalDayContaining(activation - 1, revisions);
  assert.equal(interruptedLegacyDay.boundaryRevisionId, LEGACY_CALENDAR_DAY_REVISION_ID);
  assert.equal(interruptedLegacyDay.boundaryStartDate, '2026-09-15'); // Tuesday, per legacy's own 00:00 boundary

  // Its interval is truncated at the takeover instant, not the full 24h a
  // naive same-revision computation would give — this is exactly why
  // instantInOperationalDay and operationalDayContaining must agree.
  const { endMs: interruptedEndMs } = operationalDayInterval(interruptedLegacyDay, revisions);
  assert.equal(interruptedEndMs, activation);
  assert.equal(instantInOperationalDay(activation, interruptedLegacyDay, revisions), false);
  assert.equal(operationalDayContaining(activation, revisions).boundaryRevisionId, 'r1');

  // nextOperationalDay from the interrupted legacy day lands exactly on the
  // new revision's first day, even though naive same-revision date+1 would not.
  const next = nextOperationalDay(interruptedLegacyDay, revisions);
  assert.equal(next.boundaryRevisionId, 'r1');
  assert.equal(next.boundaryStartDate, '2026-09-15');
  assert.equal(operationalDayInterval(next, revisions).startMs, activation);

  // And walking back from there returns the interrupted legacy day.
  assert.deepEqual(previousOperationalDay(next, revisions), interruptedLegacyDay);
});

test('nextBoundaryInstant finds the next occurrence at or after the reference instant', () => {
  const rule = { boundaryTime: '18:00', timezone: MANILA };
  assert.equal(nextBoundaryInstant(iso('2026-09-14T00:30:00Z'), rule), iso('2026-09-14T10:00:00Z'));
  assert.equal(nextBoundaryInstant(iso('2026-09-14T10:00:00Z'), rule), iso('2026-09-14T10:00:00Z')); // inclusive
  assert.equal(nextBoundaryInstant(iso('2026-09-14T10:00:01Z'), rule), iso('2026-09-15T10:00:00Z'));
});

// ── DST correctness for a non-midnight boundary ─────────────────────────────

test('a non-midnight boundary resolves correctly across a US DST transition', () => {
  const revisions = [{ id: 'boundary-22', boundaryTime: '22:00', timezone: NY, effectiveFromInstant: null }];
  // Spring-forward: 2026-03-08 02:00 EST -> 03:00 EDT. The operational day
  // starting 2026-03-07 22:00 (still EST) is the one whose [start,end) span
  // crosses that 2am jump, so it is 23 wall-clock hours long.
  const springRef = operationalDayStartingOn('2026-03-07', revisions[0]);
  const { startMs: springStart, endMs: springEnd } = operationalDayInterval(springRef, revisions);
  assert.equal(springStart, iso('2026-03-08T03:00:00Z')); // 2026-03-07 22:00 EST (UTC-5)
  assert.equal(springEnd, iso('2026-03-09T02:00:00Z'));   // 2026-03-08 22:00 EDT (UTC-4)
  assert.equal(springEnd - springStart, 23 * 3600000);

  // Fall-back: 2026-11-01 02:00 EDT -> 01:00 EST (clocks repeat 1am-2am).
  // The operational day starting 2026-10-31 22:00 (EDT) spans that repeat,
  // so it is 25 wall-clock hours long.
  const fallRef = operationalDayStartingOn('2026-10-31', revisions[0]);
  const { startMs: fallStart, endMs: fallEnd } = operationalDayInterval(fallRef, revisions);
  assert.equal(fallStart, iso('2026-11-01T02:00:00Z'));   // 2026-10-31 22:00 EDT (UTC-4)
  assert.equal(fallEnd, iso('2026-11-02T03:00:00Z'));     // 2026-11-01 22:00 EST (UTC-5)
  assert.equal(fallEnd - fallStart, 25 * 3600000);
});

test('legacy (00:00) boundary is unaffected by DST — always exactly 24h wall-clock, calendar day matches', () => {
  const ref = operationalDayStartingOn('2026-03-08', legacyNY);
  const { boundaryStartDate } = operationalDayContaining(operationalDayInterval(ref, [legacyNY]).startMs, [legacyNY]);
  assert.equal(boundaryStartDate, '2026-03-08');
});
