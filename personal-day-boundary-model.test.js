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
  resolveLocalWallClock, resolveCivilBoundary, resolvePlannedRangeInOperationalDay,
  operationalDayOverlapMs, sliceIntervalAcrossOperationalDays,
  canonicalizeOperationalDayTimezone,
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
    const result = resolveClockTimeInOperationalDay(ref, hhmm, revisions);
    const expected = iso(`${expectedLocal}+08:00`); // Manila is fixed UTC+8
    assert.equal(result.ok, true, hhmm);
    assert.equal(result.instantMs, expected, hhmm);
  }
  // The boundary time itself resolves to this day's own start instant, which
  // is exactly the end instant of the previous day and the start of this one.
  const { startMs } = operationalDayInterval(ref, revisions);
  assert.equal(resolveClockTimeInOperationalDay(ref, '18:00', revisions).instantMs, startMs);
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

// ── Blocker fix #1: authoritative civil-time resolution (unique/ambiguous/nonexistent) ─

test('resolveLocalWallClock classifies an ordinary time as unique', () => {
  const r = resolveLocalWallClock('2026-06-01', '12:00', NY);
  assert.equal(r.kind, 'unique');
  assert.equal(r.instantMs, iso('2026-06-01T16:00:00Z')); // EDT (UTC-4)
});

test('resolveLocalWallClock classifies the spring-forward gap as nonexistent, never silently becoming another time', () => {
  // 2026-03-08: US clocks spring forward 02:00 EST -> 03:00 EDT. 02:00-02:59
  // never happens. The old implementation silently turned 02:30 into 03:30
  // via iterative offset correction with no signal anything was unusual.
  const r = resolveLocalWallClock('2026-03-08', '02:30', NY);
  assert.equal(r.kind, 'nonexistent');
  assert.equal(r.gapMinutes, 60);
  assert.equal(r.instantAfterGapMs, iso('2026-03-08T07:30:00Z')); // 03:30 EDT — the requested clock, shifted forward by exactly the gap
});

test('resolveLocalWallClock classifies the fall-back repeat as ambiguous, exposing both real instants', () => {
  // 2026-11-01: US clocks fall back 02:00 EDT -> 01:00 EST. 01:00-01:59
  // happens twice: once in EDT, once in EST.
  const r = resolveLocalWallClock('2026-11-01', '01:30', NY);
  assert.equal(r.kind, 'ambiguous');
  assert.equal(r.earlierMs, iso('2026-11-01T05:30:00Z')); // 01:30 EDT (first occurrence)
  assert.equal(r.laterMs, iso('2026-11-01T06:30:00Z'));   // 01:30 EST (second occurrence, repeat)
});

test('recurring boundary policy: nonexistent boundary advances by the DST gap (compatible-style recurrence)', () => {
  const revisions = [{ id: 'b0230', boundaryTime: '02:30', timezone: NY, effectiveFromInstant: null }];
  assert.equal(resolveCivilBoundary('2026-03-08', '02:30', NY), iso('2026-03-08T07:30:00Z'));
  // The operational day "starting" on the nonexistent boundary still exists
  // and still has a well-defined, gap-advanced start instant.
  const ref = operationalDayStartingOn('2026-03-08', revisions[0]);
  assert.equal(operationalDayInterval(ref, revisions).startMs, iso('2026-03-08T07:30:00Z'));
});

test('recurring boundary policy: ambiguous (repeated) boundary chooses the earlier occurrence', () => {
  const revisions = [{ id: 'b0130', boundaryTime: '01:30', timezone: NY, effectiveFromInstant: null }];
  assert.equal(resolveCivilBoundary('2026-11-01', '01:30', NY), iso('2026-11-01T05:30:00Z'));
  const ref = operationalDayStartingOn('2026-11-01', revisions[0]);
  assert.equal(operationalDayInterval(ref, revisions).startMs, iso('2026-11-01T05:30:00Z'));
});

test('planned clock policy: a nonexistent planned time fails explicitly rather than becoming another time', () => {
  const revisions = [legacyNY]; // 00:00 boundary -> clockDate is exactly the ref's own boundaryStartDate
  const ref = operationalDayStartingOn('2026-03-08', legacyNY);
  const result = resolveClockTimeInOperationalDay(ref, '02:30', revisions);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'nonexistent');
  assert.equal(result.gapMinutes, 60);
  assert.equal('instantMs' in result, false); // never a fabricated instant
});

test('planned clock policy: an ambiguous planned time exposes ambiguity rather than guessing by default', () => {
  const revisions = [legacyNY];
  const ref = operationalDayStartingOn('2026-11-01', legacyNY);
  const bare = resolveClockTimeInOperationalDay(ref, '01:30', revisions);
  assert.equal(bare.ok, false);
  assert.equal(bare.reason, 'ambiguous');
  assert.equal(bare.earlierMs, iso('2026-11-01T05:30:00Z'));
  assert.equal(bare.laterMs, iso('2026-11-01T06:30:00Z'));

  // An explicit disambiguation policy is honored — but only when supplied.
  const earlier = resolveClockTimeInOperationalDay(ref, '01:30', revisions, { disambiguate: 'earlier' });
  assert.deepEqual(earlier, { ok: true, instantMs: iso('2026-11-01T05:30:00Z') });
  const later = resolveClockTimeInOperationalDay(ref, '01:30', revisions, { disambiguate: 'later' });
  assert.deepEqual(later, { ok: true, instantMs: iso('2026-11-01T06:30:00Z') });
});

// ── Blocker fix #2: authoritative planned-range resolver ──────────────────

test('resolvePlannedRangeInOperationalDay: 23:00 -> 01:00 is valid and crosses calendar midnight inside one operational day', () => {
  const revision = { id: 'b18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  const ref = operationalDayStartingOn('2026-09-14', revision); // Monday
  const revisions = [revision];
  const result = resolvePlannedRangeInOperationalDay(ref, { startClock: '23:00', endClock: '01:00' }, revisions);
  assert.deepEqual(result, { ok: true, startMs: iso('2026-09-14T15:00:00Z'), endMs: iso('2026-09-14T17:00:00Z') });
  assert.equal(instantInOperationalDay(result.startMs, ref, revisions), true);
  assert.equal(instantInOperationalDay(result.endMs - 1, ref, revisions), true);
});

test('resolvePlannedRangeInOperationalDay: 17:30 -> 18:30 is invalid because the end lies beyond the operational-day boundary', () => {
  const revision = { id: 'b18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  const ref = operationalDayStartingOn('2026-09-14', revision);
  const result = resolvePlannedRangeInOperationalDay(ref, { startClock: '17:30', endClock: '18:30' }, [revision]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outside-operational-day');
});

test('resolvePlannedRangeInOperationalDay: duration-based input resolves without needing an end clock', () => {
  const revision = { id: 'b18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  const ref = operationalDayStartingOn('2026-09-14', revision);
  const result = resolvePlannedRangeInOperationalDay(ref, { startClock: '19:00', durationMinutes: 60 }, [revision]);
  assert.deepEqual(result, { ok: true, startMs: iso('2026-09-14T11:00:00Z'), endMs: iso('2026-09-14T12:00:00Z') });
  // The 720-minute Plan Time Range product cap is deliberately NOT enforced
  // here — temporal containment and product duration policy are separate.
  // 1400 minutes (23h20m) from Monday 19:00 lands at Tuesday 18:20, past the
  // day's own end (Tuesday 18:00) — well beyond the 720-minute product cap
  // too, but rejected here purely for exceeding the operational DAY.
  const long = resolvePlannedRangeInOperationalDay(ref, { startClock: '19:00', durationMinutes: 1400 }, [revision]);
  assert.equal(long.ok, false);
  assert.equal(long.reason, 'outside-operational-day');
});

test('resolvePlannedRangeInOperationalDay rejects malformed input, non-positive duration, and zero-length ranges', () => {
  const revision = { id: 'b18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  const ref = operationalDayStartingOn('2026-09-14', revision);
  assert.equal(resolvePlannedRangeInOperationalDay(ref, {}, [revision]).reason, 'invalid-input');
  assert.equal(resolvePlannedRangeInOperationalDay(ref, { startClock: '19:00' }, [revision]).reason, 'invalid-input');
  assert.equal(resolvePlannedRangeInOperationalDay(ref, { startClock: '19:00', endClock: '19:00' }, [revision]).reason, 'non-positive-duration');
});

test('resolvePlannedRangeInOperationalDay propagates nonexistent/ambiguous DST truth at either endpoint instead of fabricating a range', () => {
  const ref = operationalDayStartingOn('2026-03-08', legacyNY);
  const revisions = [legacyNY];
  const nonexistentStart = resolvePlannedRangeInOperationalDay(ref, { startClock: '02:30', durationMinutes: 30 }, revisions);
  assert.equal(nonexistentStart.ok, false);
  assert.equal(nonexistentStart.reason, 'nonexistent');
  assert.equal(nonexistentStart.at, 'start');

  const ambiguousRef = operationalDayStartingOn('2026-11-01', legacyNY);
  const ambiguousEnd = resolvePlannedRangeInOperationalDay(ambiguousRef, { startClock: '00:30', endClock: '01:30' }, revisions);
  assert.equal(ambiguousEnd.ok, false);
  assert.equal(ambiguousEnd.reason, 'ambiguous');
  assert.equal(ambiguousEnd.at, 'end');
});

// ── Blocker fix #3: authoritative factual interval overlap / slicing ──────

test('sliceIntervalAcrossOperationalDays: factual 17:30->18:30 across an 18:00 boundary splits into exactly 30m + 30m = 60m', () => {
  const revision = { id: 'b18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  const revisions = [revision];
  const eventStart = iso('2026-09-15T09:30:00Z'); // Tue 17:30 Manila
  const eventEnd = iso('2026-09-15T10:30:00Z');   // Tue 18:30 Manila
  const slices = sliceIntervalAcrossOperationalDays(eventStart, eventEnd, revisions);
  assert.equal(slices.length, 2);
  assert.equal(slices[0].ref.boundaryStartDate, '2026-09-14'); // prior operational day (Mon 18:00 -> Tue 18:00)
  assert.equal(slices[0].overlapMs, 30 * 60000);
  assert.equal(slices[1].ref.boundaryStartDate, '2026-09-15'); // next operational day (Tue 18:00 -> Wed 18:00)
  assert.equal(slices[1].overlapMs, 30 * 60000);
  assert.equal(slices.reduce((sum, s) => sum + s.overlapMs, 0), eventEnd - eventStart); // sums to the original 60m
  // Slices are projections only — the source interval is passed by value and
  // is never itself part of the returned shape.
  assert.equal(operationalDayOverlapMs(eventStart, eventEnd, slices[0].ref, revisions), 30 * 60000);
  assert.equal(operationalDayOverlapMs(eventStart, eventEnd, slices[1].ref, revisions), 30 * 60000);
});

test('operationalDayOverlapMs / sliceIntervalAcrossOperationalDays edge cases', () => {
  const revision = { id: 'b18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  const revisions = [revision];
  const ref = operationalDayStartingOn('2026-09-14', revision); // Mon 18:00 -> Tue 18:00
  const { startMs, endMs } = operationalDayInterval(ref, revisions);

  // wholly before / after
  assert.equal(operationalDayOverlapMs(startMs - 2 * 3600000, startMs - 3600000, ref, revisions), 0);
  assert.equal(operationalDayOverlapMs(endMs + 3600000, endMs + 2 * 3600000, ref, revisions), 0);
  assert.deepEqual(sliceIntervalAcrossOperationalDays(startMs - 2 * 3600000, startMs - 3600000, revisions).map(s => s.ref.boundaryStartDate), ['2026-09-13']);

  // exact day start / end
  assert.equal(operationalDayOverlapMs(startMs, startMs + 1, ref, revisions), 1);
  assert.equal(operationalDayOverlapMs(endMs - 1, endMs, ref, revisions), 1);
  assert.equal(operationalDayOverlapMs(endMs, endMs + 3600000, ref, revisions), 0); // end is exclusive

  // full-day span
  assert.equal(operationalDayOverlapMs(startMs, endMs, ref, revisions), endMs - startMs);
  assert.deepEqual(sliceIntervalAcrossOperationalDays(startMs, endMs, revisions), [{ ref, overlapStartMs: startMs, overlapEndMs: endMs, overlapMs: endMs - startMs }]);

  // zero duration and reversed interval — no overlap, no slices, never throws
  assert.equal(operationalDayOverlapMs(startMs, startMs, ref, revisions), 0);
  assert.equal(operationalDayOverlapMs(endMs, startMs, ref, revisions), 0); // reversed
  assert.deepEqual(sliceIntervalAcrossOperationalDays(startMs, startMs, revisions), []);
  assert.deepEqual(sliceIntervalAcrossOperationalDays(endMs, startMs, revisions), []);
});

test('sliceIntervalAcrossOperationalDays handles a DST 23-hour day and a DST 25-hour day without loss or duplication', () => {
  const revision = { id: 'b22', boundaryTime: '22:00', timezone: NY, effectiveFromInstant: null };
  const revisions = [revision];

  // Spans the entire 23h spring-forward day plus one hour into the next.
  const springRef = operationalDayStartingOn('2026-03-07', revision);
  const { startMs: sStart, endMs: sEnd } = operationalDayInterval(springRef, revisions);
  const springSlices = sliceIntervalAcrossOperationalDays(sStart, sEnd + 3600000, revisions);
  assert.equal(springSlices.length, 2);
  assert.equal(springSlices[0].overlapMs, sEnd - sStart); // the full 23h day
  assert.equal(springSlices[1].overlapMs, 3600000);
  assert.equal(springSlices.reduce((sum, s) => sum + s.overlapMs, 0), sEnd - sStart + 3600000);

  // Spans the entire 25h fall-back day exactly.
  const fallRef = operationalDayStartingOn('2026-10-31', revision);
  const { startMs: fStart, endMs: fEnd } = operationalDayInterval(fallRef, revisions);
  const fallSlices = sliceIntervalAcrossOperationalDays(fStart, fEnd, revisions);
  assert.equal(fallSlices.length, 1);
  assert.equal(fallSlices[0].overlapMs, 25 * 3600000);
});

test('sliceIntervalAcrossOperationalDays respects a revision-truncated (shortened) transition day', () => {
  const activation = iso('2026-09-15T10:00:00Z'); // Tuesday 18:00 Manila
  const revisions = normalizeBoundaryRevisionHistory([
    legacyManila,
    { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: activation },
  ]);
  // An interval spanning from well inside the truncated legacy day straight
  // through into the new revision's first day must slice at exactly the
  // takeover instant, with no gap and no overlap between the two slices.
  const slices = sliceIntervalAcrossOperationalDays(activation - 3600000, activation + 3600000, revisions);
  assert.equal(slices.length, 2);
  assert.equal(slices[0].ref.boundaryRevisionId, LEGACY_CALENDAR_DAY_REVISION_ID);
  assert.equal(slices[0].overlapEndMs, activation);
  assert.equal(slices[1].ref.boundaryRevisionId, 'r1');
  assert.equal(slices[1].overlapStartMs, activation);
  assert.equal(slices.reduce((sum, s) => sum + s.overlapMs, 0), 2 * 3600000);
});

// ── proposed transitions between two non-default boundary times ───────────

test('proposeBoundaryRevision: 18:00 -> 20:00 proposed at 19:00 activates the same day (19:00 < 20:00)', () => {
  const decisionAt1900 = iso('2026-09-14T11:00:00Z'); // Monday 19:00 Manila
  const current = { id: 'current-18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  const { revision } = proposeBoundaryRevision([current], { id: 'to-20', boundaryTime: '20:00', timezone: MANILA }, decisionAt1900);
  assert.equal(revision.effectiveFromInstant, iso('2026-09-14T12:00:00Z')); // Monday 20:00 Manila — same day
});

test('proposeBoundaryRevision: 18:00 -> 16:00 proposed at 19:00 rolls to the next day (19:00 > 16:00, already passed today)', () => {
  const decisionAt1900 = iso('2026-09-14T11:00:00Z'); // Monday 19:00 Manila
  const current = { id: 'current-18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  const { revision } = proposeBoundaryRevision([current], { id: 'to-16', boundaryTime: '16:00', timezone: MANILA }, decisionAt1900);
  assert.equal(revision.effectiveFromInstant, iso('2026-09-15T08:00:00Z')); // Tuesday 16:00 Manila
});

// ── chaos: month/year/leap transitions ─────────────────────────────────────

test('operational days cross year and leap-day boundaries with no gaps or overlaps', () => {
  const revision = { id: 'b18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  const revisions = [revision];
  for (const boundaryStartDate of ['2026-12-31', '2024-02-28', '2024-02-29']) {
    const ref = operationalDayStartingOn(boundaryStartDate, revision);
    const { startMs, endMs } = operationalDayInterval(ref, revisions);
    assert.equal(operationalDayContaining(startMs, revisions).boundaryStartDate, boundaryStartDate);
    assert.equal(operationalDayContaining(endMs - 1, revisions).boundaryStartDate, boundaryStartDate);
    assert.deepEqual(operationalDayContaining(endMs, revisions), nextOperationalDay(ref, revisions));
  }
  assert.equal(operationalDayStartingOn('2026-12-31', revision).boundaryStartDate, '2026-12-31');
  assert.equal(nextOperationalDay(operationalDayStartingOn('2026-12-31', revision), revisions).boundaryStartDate, '2027-01-01');
  assert.equal(nextOperationalDay(operationalDayStartingOn('2024-02-28', revision), revisions).boundaryStartDate, '2024-02-29');
  assert.equal(nextOperationalDay(operationalDayStartingOn('2024-02-29', revision), revisions).boundaryStartDate, '2024-03-01');
  // 2026 is not a leap year — Feb 29 is not a real calendar date.
  assert.equal(validBoundaryStartDate('2026-02-29'), false);
});

// ── chaos: three-revision reverse ordering ─────────────────────────────────

test('normalizeBoundaryRevisionHistory sorts three revisions correctly regardless of input order, and each instant resolves to its own regime', () => {
  const r1At = iso('2026-01-01T00:00:00Z'); // 08:00 Manila
  const r2At = iso('2026-06-01T00:00:00Z'); // 08:00 Manila
  const r1 = { id: 'r1', boundaryTime: '08:00', timezone: MANILA, effectiveFromInstant: r1At };
  const r2 = { id: 'r2', boundaryTime: '08:00', timezone: MANILA, effectiveFromInstant: r2At };
  // Deliberately inserted out of order: r2 (latest), legacy (anchor), r1 (middle).
  const revisions = normalizeBoundaryRevisionHistory([r2, legacyManila, r1]);
  assert.deepEqual(revisions.map(r => r.id), [legacyManila.id, 'r1', 'r2']);

  assert.equal(activeBoundaryRevision(revisions, r1At - 1).id, legacyManila.id);
  assert.equal(activeBoundaryRevision(revisions, r1At).id, 'r1');
  assert.equal(activeBoundaryRevision(revisions, r2At - 1).id, 'r1');
  assert.equal(activeBoundaryRevision(revisions, r2At).id, 'r2');
});

// ── chaos: a revision that changes BOTH timezone and boundary time ─────────

test('a boundary revision may change timezone and boundary time together, with no gap at the crossing', () => {
  const activation = iso('2026-09-15T10:00:00Z'); // Tuesday 18:00 Manila — aligned to the OLD revision's own rule
  const oldRevision = { id: 'manila-18', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: null };
  // The new revision's own effective instant must align to ITS OWN boundary
  // time/timezone (per normalizeBoundaryRevisionHistory's invariant) — build
  // it the sanctioned way, via proposeBoundaryRevision, rather than by hand.
  const { revision: newRevision, revisions } = proposeBoundaryRevision(
    [oldRevision], { id: 'ny-20', boundaryTime: '20:00', timezone: NY }, activation
  );
  const beforeCrossing = operationalDayContaining(newRevision.effectiveFromInstant - 1, revisions);
  assert.equal(beforeCrossing.boundaryRevisionId, 'manila-18');
  assert.equal(beforeCrossing.timezone, MANILA);
  const atCrossing = operationalDayContaining(newRevision.effectiveFromInstant, revisions);
  assert.equal(atCrossing.boundaryRevisionId, 'ny-20');
  assert.equal(atCrossing.timezone, NY);
  // No gap: the old day's truncated end is exactly the new day's start.
  assert.equal(operationalDayInterval(beforeCrossing, revisions).endMs, operationalDayInterval(atCrossing, revisions).startMs);
});

// ── chaos: template/routine-after-midnight compatibility (foundation-only) ─

test('legacy (00:00-boundary) operational-day dates match this app\'s existing after-midnight calendar-date fixtures', () => {
  // Same instants/timezones daily-routines.test.js already uses for its own
  // after-midnight DST table — this proves the foundation's legacy contract
  // agrees with the app's existing calendar-date truth. Foundation-only: no
  // import of daily-routines-model.js, no wiring.
  const cases = [
    ['Asia/Tokyo', '2026-09-08T16:00:00Z', '2026-09-09'],
    ['America/Phoenix', '2026-09-09T06:59:00Z', '2026-09-08'],
    ['America/Phoenix', '2026-09-09T07:01:00Z', '2026-09-09'],
    [NY, '2026-03-08T06:59:00Z', '2026-03-08'],
    [NY, '2026-03-08T07:00:00Z', '2026-03-08'],
    [NY, '2026-11-01T05:30:00Z', '2026-11-01'],
    [NY, '2026-11-01T06:30:00Z', '2026-11-01'],
  ];
  for (const [tz, instant, expectedDate] of cases) {
    const revisions = [legacyBoundaryRevision(tz)];
    assert.equal(operationalDayContaining(iso(instant), revisions).boundaryStartDate, expectedDate, `${tz} ${instant}`);
  }
});

// ── canonicalizeOperationalDayTimezone (§7) ─────────────────────────────────

test('canonicalizeOperationalDayTimezone resolves a known alias to its runtime-canonical IANA name', () => {
  assert.equal(canonicalizeOperationalDayTimezone('US/Eastern'), 'America/New_York');
  assert.equal(canonicalizeOperationalDayTimezone('America/New_York'), 'America/New_York');
});

test('canonicalizeOperationalDayTimezone is idempotent — canonicalizing an already-canonical name is a no-op', () => {
  for (const tz of [MANILA, NY, 'UTC', 'Etc/UTC']) {
    const once = canonicalizeOperationalDayTimezone(tz);
    assert.equal(canonicalizeOperationalDayTimezone(once), once);
  }
});

test('canonicalizeOperationalDayTimezone throws on a timezone Intl cannot resolve, matching validOperationalDayTimezone', () => {
  assert.throws(() => canonicalizeOperationalDayTimezone('Not/AZone'));
  assert.throws(() => canonicalizeOperationalDayTimezone(''));
  assert.throws(() => canonicalizeOperationalDayTimezone(null));
});

test('two alias strings for the same civil rules canonicalize to the same operationalDayId identity', () => {
  // The product-level reason this function exists: without it, "US/Eastern" and
  // "America/New_York" from two different callers would silently fork day identity.
  const revA = { id: 'r1', boundaryTime: '18:00', timezone: canonicalizeOperationalDayTimezone('US/Eastern'), effectiveFromInstant: null };
  const revB = { id: 'r1', boundaryTime: '18:00', timezone: canonicalizeOperationalDayTimezone('America/New_York'), effectiveFromInstant: null };
  assert.deepEqual(revA, revB);
  const refA = operationalDayStartingOn('2026-09-14', revA);
  const refB = operationalDayStartingOn('2026-09-14', revB);
  assert.equal(operationalDayId(refA), operationalDayId(refB));
});
