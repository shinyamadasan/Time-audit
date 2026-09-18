// commitments-model.test.js
//
// Planning Continuity V1 — the canonical scheduled-commitment contract.
//
// The load-bearing claim under test: a commitment owns its INSTANT, and the
// personal day containing it is derived on read. Everything else here exists to
// prove that claim survives the cases that would break a day-scoped design —
// boundary revisions, timezone changes, DST anomalies and exact-boundary times.
//
// Deterministic throughout: fixed dates, explicit IANA zones, injected clocks.
// No real Firebase project, no network, no production data.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMITMENT_SCHEMA_VERSION, DATE_ONLY_ANCHOR_TIME,
  resolveCommitmentInstant, buildCommitment, updateCommitment, deleteCommitment,
  normalizeCommitment, commitmentWindow, mergeCommitmentRecords, mergeCommitmentMaps,
  projectCommitment, commitmentsForTarget, activeCommitments, upcomingCommitments,
  formatCommitmentTime, validCommitmentId, commitmentAnchorTime,
} from './commitments-model.js';
import { createCommitmentsRepository, COMMITMENTS_STORAGE_KEY } from './commitments-repository.js';
import {
  legacyBoundaryRevision, proposeBoundaryRevision, operationalDayContaining,
  operationalDayId, operationalDayInterval, resolveLocalWallClock,
} from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';          // UTC+8, no DST
const NEW_YORK = 'America/New_York';   // DST
const TOKYO = 'Asia/Tokyo';            // UTC+9, no DST

const manila = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const DEVICE = 'device-a';
const T0 = manila('2026-09-18', '10:00');

const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

/** An 18:00 Asia/Manila personal-day history, active from 2026-09-18 18:00. */
function boundary1800(nowMs = T0, timezone = MANILA, boundaryTime = '18:00') {
  return proposeBoundaryRevision([legacyBoundaryRevision(timezone)], { id: 'rev-1800', boundaryTime, timezone }, nowMs).revisions;
}

/** Plan Authority's `containing(instantMs)`, reduced to what the projection needs:
 *  a target carrying the day's identity and its real half-open interval. */
function dayResolver(revisions) {
  return instantMs => {
    const ref = operationalDayContaining(instantMs, revisions);
    const { startMs, endMs } = operationalDayInterval(ref, revisions);
    return { store: 'operational', id: operationalDayId(ref), ref, startMs, endMs, timezone: ref.timezone };
  };
}

const ok = result => { assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`); return result; };

function dentist(overrides = {}) {
  return ok(buildCommitment({
    id: 'cdentist', title: 'Dentist', date: '2026-09-30', time: '09:30',
    timezone: MANILA, now: T0, updatedBy: DEVICE, ...overrides,
  })).record;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. the contract matrix: which personal day owns a commitment
// ═══════════════════════════════════════════════════════════════════════

test('Dentist Sep 30 09:30 Asia/Manila under an 18:00 boundary belongs to the Sep 29 18:00 personal day', () => {
  const revisions = boundary1800();
  const projected = ok(projectCommitment(dentist(), dayResolver(revisions)));
  assert.equal(projected.target.id, 'odv1:rev-1800:Asia/Manila:2026-09-29');
  assert.equal(projected.target.startMs, manila('2026-09-29', '18:00'));
  assert.equal(projected.target.endMs, manila('2026-09-30', '18:00'));
  // The stored appointment is still 09:30 on the 30th — the DAY is what shifted.
  assert.equal(projected.startMs, manila('2026-09-30', '09:30'));
});

test('Sep 30 21:30 belongs to the Sep 30 18:00 personal day', () => {
  const revisions = boundary1800();
  const record = dentist({ id: 'cevening', title: 'Evening call', time: '21:30' });
  const projected = ok(projectCommitment(record, dayResolver(revisions)));
  assert.equal(projected.target.id, 'odv1:rev-1800:Asia/Manila:2026-09-30');
  assert.equal(projected.target.startMs, manila('2026-09-30', '18:00'));
});

test('a commitment at exactly 18:00 belongs to the day that STARTS there (start-inclusive)', () => {
  const revisions = boundary1800();
  const record = dentist({ id: 'cexact', title: 'Exactly the boundary', time: '18:00' });
  const projected = ok(projectCommitment(record, dayResolver(revisions)));
  assert.equal(projected.target.id, 'odv1:rev-1800:Asia/Manila:2026-09-30');
  assert.equal(projected.target.startMs, projected.startMs, 'the commitment sits on its day\'s own start instant');
});

test('one minute before the boundary still belongs to the PREVIOUS personal day', () => {
  const revisions = boundary1800();
  const record = dentist({ id: 'cjustbefore', title: 'Just before', time: '17:59' });
  const projected = ok(projectCommitment(record, dayResolver(revisions)));
  assert.equal(projected.target.id, 'odv1:rev-1800:Asia/Manila:2026-09-29');
});

test('a legacy (never-enabled) account projects a commitment onto its plain calendar day', () => {
  const revisions = [legacyBoundaryRevision(MANILA)];
  const projected = ok(projectCommitment(dentist(), dayResolver(revisions)));
  // The anchor revision is the 00:00 calendar day, so Sep 30 09:30 is simply Sep 30.
  assert.equal(projected.target.ref.boundaryStartDate, '2026-09-30');
});

// ═══════════════════════════════════════════════════════════════════════
// 2. THE invariant: a boundary change never moves the appointment
// ═══════════════════════════════════════════════════════════════════════

test('a boundary revision after creation leaves the commitment instant untouched and only moves its projection', () => {
  const before = boundary1800();
  const record = dentist();
  const storedInstant = record.startMs;
  const projectedBefore = ok(projectCommitment(record, dayResolver(before)));

  // The owner later moves their personal day from 18:00 to 20:00.
  const after = proposeBoundaryRevision(before, { id: 'rev-2000', boundaryTime: '20:00', timezone: MANILA }, manila('2026-09-20', '10:00')).revisions;
  const projectedAfter = ok(projectCommitment(record, dayResolver(after)));

  // 1. The record itself is byte-identical — nothing migrated it.
  assert.equal(record.startMs, storedInstant);
  assert.equal(record.date, '2026-09-30');
  assert.equal(record.time, '09:30');
  assert.equal(record.timezone, MANILA);
  // 2. The resolved instant is the same real moment.
  assert.equal(projectedAfter.startMs, storedInstant);
  // 3. Only the projection changed, and it changed deterministically.
  assert.notEqual(projectedAfter.target.id, projectedBefore.target.id);
  assert.equal(projectedAfter.target.id, 'odv1:rev-2000:Asia/Manila:2026-09-29');
  assert.equal(projectedAfter.target.startMs, manila('2026-09-29', '20:00'));
});

test('a boundary revision can move a commitment into a DIFFERENT calendar-start day, still without moving it in time', () => {
  // Under 18:00, 19:00 on Sep 30 is in the Sep 30 day. Move the boundary to
  // 21:00 and the same instant falls into the Sep 29 day instead.
  const before = boundary1800();
  const record = dentist({ id: 'cshift', title: 'Shifts day', time: '19:00' });
  assert.equal(ok(projectCommitment(record, dayResolver(before))).target.ref.boundaryStartDate, '2026-09-30');

  const after = proposeBoundaryRevision(before, { id: 'rev-2100', boundaryTime: '21:00', timezone: MANILA }, manila('2026-09-20', '10:00')).revisions;
  const projected = ok(projectCommitment(record, dayResolver(after)));
  assert.equal(projected.target.ref.boundaryStartDate, '2026-09-29');
  assert.equal(projected.startMs, manila('2026-09-30', '19:00'), 'the real appointment time is unchanged');
});

test('a commitment is never projected into two personal days at once', () => {
  const revisions = boundary1800();
  const record = dentist();
  const resolve = dayResolver(revisions);
  const owning = ok(projectCommitment(record, resolve)).target;

  // Walk every personal day across the surrounding week and count memberships.
  const days = [];
  for (let d = 26; d <= 32; d++) {
    const day = resolve(manila('2026-09-01', '12:00') + (d - 1) * 86400000);
    if (!days.some(existing => existing.id === day.id)) days.push(day);
  }
  const hits = days.filter(day => commitmentsForTarget([record], day).length > 0);
  assert.equal(hits.length, 1, 'exactly one personal day may contain a given commitment');
  assert.equal(hits[0].id, owning.id);
});

test('a durated commitment that runs past its day end still belongs only to the day it STARTS in', () => {
  const revisions = boundary1800();
  // 17:30 + 90min = 19:00, crossing the 18:00 boundary.
  const record = dentist({ id: 'ccross', title: 'Crosses the boundary', time: '17:30', durationMinutes: 90 });
  const resolve = dayResolver(revisions);
  const startDay = resolve(manila('2026-09-30', '17:30'));
  const nextDay = resolve(manila('2026-09-30', '19:00'));
  assert.notEqual(startDay.id, nextDay.id, 'sanity: the block really does cross a boundary');
  assert.equal(commitmentsForTarget([record], startDay).length, 1);
  assert.equal(commitmentsForTarget([record], nextDay).length, 0, 'no duplicate in the following day');
});

// ═══════════════════════════════════════════════════════════════════════
// 3. timezone provenance
// ═══════════════════════════════════════════════════════════════════════

test('a commitment timezone may differ from the personal-day boundary timezone', () => {
  // Boundary is 18:00 Asia/Manila; the appointment is authored in Tokyo time.
  const revisions = boundary1800();
  const record = ok(buildCommitment({
    id: 'ctokyo', title: 'Tokyo meeting', date: '2026-09-30', time: '09:30',
    timezone: TOKYO, now: T0, updatedBy: DEVICE,
  })).record;
  assert.equal(record.timezone, TOKYO);
  // 09:30 JST is 08:30 Manila, which is inside the Sep 29 18:00 personal day.
  assert.equal(record.startMs, Date.parse('2026-09-30T09:30:00+09:00'));
  const projected = ok(projectCommitment(record, dayResolver(revisions)));
  assert.equal(projected.target.id, 'odv1:rev-1800:Asia/Manila:2026-09-29');
});

test('changing the boundary TIMEZONE does not re-interpret the commitment timezone', () => {
  const before = boundary1800();
  const record = dentist();
  const after = proposeBoundaryRevision(before, { id: 'rev-tokyo', boundaryTime: '18:00', timezone: TOKYO }, manila('2026-09-20', '10:00')).revisions;
  const projected = ok(projectCommitment(record, dayResolver(after)));
  assert.equal(projected.record.timezone, MANILA, 'the commitment keeps its own authored zone');
  assert.equal(projected.startMs, manila('2026-09-30', '09:30'), 'and its own real instant');
  assert.equal(projected.target.timezone, TOKYO, 'only the DAY is now expressed in the new zone');
});

test('the authored timezone is canonicalized once and stored, never inferred later', () => {
  const record = ok(buildCommitment({
    id: 'czone', title: 'Zone', date: '2026-09-30', time: '09:30',
    timezone: 'asia/manila', now: T0, updatedBy: DEVICE,
  })).record;
  assert.equal(record.timezone, MANILA, 'canonicalized to the IANA spelling');
});

test('an invalid timezone is refused outright', () => {
  const result = buildCommitment({ id: 'cbad', title: 'x', date: '2026-09-30', time: '09:30', timezone: 'Mars/Olympus', now: T0, updatedBy: DEVICE });
  assert.equal(result.ok, false);
  assert.equal(result.field, 'timezone');
});

// ═══════════════════════════════════════════════════════════════════════
// 4. DST: never silently resolved
// ═══════════════════════════════════════════════════════════════════════

test('a NONEXISTENT wall-clock time (spring forward) is refused, never shifted', () => {
  // 2027-03-14 02:30 America/New_York does not exist.
  const probe = resolveLocalWallClock('2027-03-14', '02:30', NEW_YORK);
  assert.equal(probe.kind, 'nonexistent', 'sanity: the fixture really is a DST gap');

  const result = buildCommitment({ id: 'cgap', title: 'Gap', date: '2027-03-14', time: '02:30', timezone: NEW_YORK, now: T0, updatedBy: DEVICE });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'nonexistent');
  assert.equal(result.gapMinutes, 60);
  // Even an explicit disambiguation cannot rescue it: there is no such instant.
  const forced = buildCommitment({ id: 'cgap', title: 'Gap', date: '2027-03-14', time: '02:30', timezone: NEW_YORK, now: T0, updatedBy: DEVICE, disambiguate: 'later' });
  assert.equal(forced.ok, false);
  assert.equal(forced.reason, 'nonexistent');
});

test('an AMBIGUOUS wall-clock time (fall back) is refused until the owner chooses', () => {
  const probe = resolveLocalWallClock('2026-11-01', '01:30', NEW_YORK);
  assert.equal(probe.kind, 'ambiguous', 'sanity: the fixture really is a repeated hour');

  const refused = buildCommitment({ id: 'camb', title: 'Ambiguous', date: '2026-11-01', time: '01:30', timezone: NEW_YORK, now: T0, updatedBy: DEVICE });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'ambiguous');
  assert.equal(refused.earlierMs, probe.earlierMs);
  assert.equal(refused.laterMs, probe.laterMs);

  // With an explicit choice it resolves, and the choice is RECORDED.
  const earlier = ok(buildCommitment({ id: 'camb', title: 'Ambiguous', date: '2026-11-01', time: '01:30', timezone: NEW_YORK, now: T0, updatedBy: DEVICE, disambiguate: 'earlier' })).record;
  assert.equal(earlier.startMs, probe.earlierMs);
  assert.equal(earlier.dstChoice, 'earlier');
  const later = ok(buildCommitment({ id: 'camb2', title: 'Ambiguous', date: '2026-11-01', time: '01:30', timezone: NEW_YORK, now: T0, updatedBy: DEVICE, disambiguate: 'later' })).record;
  assert.equal(later.startMs, probe.laterMs);
  assert.equal(later.dstChoice, 'later');
  assert.notEqual(earlier.startMs, later.startMs);
});

test('a recorded dstChoice survives normalization; without it the same record is rejected', () => {
  const probe = resolveLocalWallClock('2026-11-01', '01:30', NEW_YORK);
  const record = ok(buildCommitment({ id: 'camb', title: 'A', date: '2026-11-01', time: '01:30', timezone: NEW_YORK, now: T0, updatedBy: DEVICE, disambiguate: 'later' })).record;
  assert.ok(normalizeCommitment(record));
  // Strip the choice: the stored instant can no longer be re-derived from the
  // civil fields alone, so the record is refused rather than half-trusted.
  const { dstChoice, ...withoutChoice } = record;
  void dstChoice;
  assert.equal(normalizeCommitment(withoutChoice), null);
  assert.equal(record.startMs, probe.laterMs);
});

test('a DST-capable appointment zone works even when the boundary zone has no DST', () => {
  const revisions = boundary1800(); // 18:00 Asia/Manila — no DST at all
  const record = ok(buildCommitment({
    id: 'cny', title: 'New York call', date: '2027-03-15', time: '09:00',
    timezone: NEW_YORK, now: T0, updatedBy: DEVICE,
  })).record;
  // 09:00 EDT the day after the spring-forward = 21:00 Manila -> Mar 15 18:00 day.
  assert.equal(record.startMs, Date.parse('2027-03-15T09:00:00-04:00'));
  const projected = ok(projectCommitment(record, dayResolver(revisions)));
  assert.equal(projected.target.ref.boundaryStartDate, '2027-03-15');
});

// ═══════════════════════════════════════════════════════════════════════
// 5. date-only commitments: noon anchor for ownership, never a fake time
// ═══════════════════════════════════════════════════════════════════════

test('a date-only commitment uses the 12:00 ownership anchor and stores no time', () => {
  assert.equal(DATE_ONLY_ANCHOR_TIME, '12:00');
  assert.equal(commitmentAnchorTime('date', null), '12:00');
  const record = ok(buildCommitment({
    id: 'cdateonly', title: 'Dentist sometime', date: '2026-09-30',
    precision: 'date', timezone: MANILA, now: T0, updatedBy: DEVICE,
  })).record;
  assert.equal(record.precision, 'date');
  assert.equal(record.time, null, 'no time was authored, so none is stored');
  assert.equal(record.startMs, manila('2026-09-30', '12:00'), 'anchored at noon for ownership only');
});

test('a date-only commitment NEVER displays a time — the noon anchor stays invisible', () => {
  const record = ok(buildCommitment({
    id: 'cdateonly', title: 'Dentist sometime', date: '2026-09-30',
    precision: 'date', timezone: MANILA, now: T0, updatedBy: DEVICE,
  })).record;
  assert.equal(formatCommitmentTime(record), null, 'the one formatter must not surface 12:00 PM');
});

test('the noon anchor resolves date-only ownership deterministically under an 18:00 boundary', () => {
  const revisions = boundary1800();
  const record = ok(buildCommitment({
    id: 'cdateonly', title: 'Dentist sometime', date: '2026-09-30',
    precision: 'date', timezone: MANILA, now: T0, updatedBy: DEVICE,
  })).record;
  // Noon on the 30th is inside the day that began at 18:00 on the 29th — the same
  // answer Decision A already gives an untimed routine dated Sep 30.
  assert.equal(ok(projectCommitment(record, dayResolver(revisions))).target.id, 'odv1:rev-1800:Asia/Manila:2026-09-29');
});

test('absence of a time is never turned into midnight', () => {
  const record = ok(buildCommitment({
    id: 'cdateonly', title: 'x', date: '2026-09-30',
    precision: 'date', timezone: MANILA, now: T0, updatedBy: DEVICE,
  })).record;
  assert.notEqual(record.startMs, manila('2026-09-30', '00:00'));
  assert.notEqual(record.startMs, manila('2026-09-29', '00:00'));
});

test('a date-only commitment may not also carry a time', () => {
  const result = buildCommitment({
    id: 'cbad', title: 'x', date: '2026-09-30', time: '09:30',
    precision: 'date', timezone: MANILA, now: T0, updatedBy: DEVICE,
  });
  assert.equal(result.ok, false);
  assert.equal(result.field, 'time');
});

test('a date-only commitment can be promoted to a timed one, and demoted back', () => {
  const dateOnly = ok(buildCommitment({
    id: 'cpromote', title: 'Dentist', date: '2026-09-30',
    precision: 'date', timezone: MANILA, now: T0, updatedBy: DEVICE,
  })).record;
  const timed = ok(updateCommitment(dateOnly, { precision: 'timed', time: '09:30', now: T0 + 1000, updatedBy: DEVICE })).record;
  assert.equal(timed.precision, 'timed');
  assert.equal(timed.time, '09:30');
  assert.equal(timed.startMs, manila('2026-09-30', '09:30'));
  assert.equal(formatCommitmentTime(timed), '9:30 AM');

  const backToDate = ok(updateCommitment(timed, { precision: 'date', now: T0 + 2000, updatedBy: DEVICE })).record;
  assert.equal(backToDate.time, null);
  assert.equal(backToDate.startMs, manila('2026-09-30', '12:00'));
  assert.equal(formatCommitmentTime(backToDate), null);
  assert.equal(backToDate.id, dateOnly.id, 'identity survives both changes');
});

// ═══════════════════════════════════════════════════════════════════════
// 6. identity, editing, tombstones
// ═══════════════════════════════════════════════════════════════════════

test('identity is an opaque immutable id — never the title or the date', () => {
  const record = dentist();
  const edited = ok(updateCommitment(record, { title: 'Dentist (rescheduled)', date: '2026-10-07', time: '14:00', now: T0 + 5000, updatedBy: 'device-b' })).record;
  assert.equal(edited.id, record.id, 'id survives a full re-author of title, date and time');
  assert.equal(edited.createdAt, record.createdAt, 'createdAt is history, not a mutable field');
  assert.equal(edited.updatedAt, T0 + 5000);
  assert.equal(edited.updatedBy, 'device-b');
  assert.equal(edited.startMs, manila('2026-10-07', '14:00'), 'an AUTHORED change does move the appointment');
});

test('commitment ids are Firebase-key-safe, so the id is the remote key verbatim', () => {
  assert.ok(validCommitmentId('cabc123'));
  assert.ok(validCommitmentId('c-_09Az'));
  for (const bad of ['has.dot', 'has#hash', 'has$dollar', 'has[bracket', 'has]bracket', 'has/slash', '', 'ab', 'x'.repeat(65)]) {
    assert.equal(validCommitmentId(bad), false, `${bad} must be refused as a commitment id`);
  }
});

test('deletion is a tombstone, and absence is not deletion', () => {
  const record = dentist();
  const tombstoned = ok(deleteCommitment(record, { now: T0 + 1000, updatedBy: DEVICE })).record;
  assert.equal(tombstoned.deleted, true);
  assert.equal(tombstoned.id, record.id);
  assert.equal(tombstoned.startMs, record.startMs, 'a tombstone still describes what it was');
  assert.deepEqual(activeCommitments([tombstoned]), []);

  // A peer that simply does not mention the record cannot delete it.
  const merged = mergeCommitmentMaps({ [record.id]: record }, {});
  assert.equal(merged[record.id].deleted, undefined);
});

test('normalization rejects malformed records rather than half-accepting them', () => {
  const base = dentist();
  assert.ok(normalizeCommitment(base));
  assert.equal(normalizeCommitment(null), null);
  assert.equal(normalizeCommitment({ ...base, schemaVersion: 2 }), null);
  assert.equal(normalizeCommitment({ ...base, id: 'bad/id' }), null);
  assert.equal(normalizeCommitment({ ...base, title: '   ' }), null);
  assert.equal(normalizeCommitment({ ...base, precision: 'whenever' }), null);
  assert.equal(normalizeCommitment({ ...base, date: '2026-13-01' }), null);
  assert.equal(normalizeCommitment({ ...base, date: '2026-02-30' }), null);
  assert.equal(normalizeCommitment({ ...base, time: '25:00' }), null);
  assert.equal(normalizeCommitment({ ...base, timezone: 'Nowhere/Nothing' }), null);
  assert.equal(normalizeCommitment({ ...base, durationMinutes: 0 }), null);
  assert.equal(normalizeCommitment({ ...base, durationMinutes: 721 }), null);
  assert.equal(normalizeCommitment({ ...base, deleted: 'yes' }), null);
  assert.equal(normalizeCommitment({ ...base, updatedAt: base.createdAt - 1 }), null);
  // A stored instant that disagrees with its own civil fields is a corruption,
  // not a preference — refused rather than displayed one way and sorted another.
  assert.equal(normalizeCommitment({ ...base, startMs: base.startMs + 60000 }), null);
});

test('a duration is optional and bounded to a single continuous block', () => {
  const point = dentist();
  assert.deepEqual(commitmentWindow(point), { startMs: point.startMs, endMs: point.startMs });
  const durated = dentist({ id: 'cdur', durationMinutes: 45 });
  assert.deepEqual(commitmentWindow(durated), { startMs: durated.startMs, endMs: durated.startMs + 45 * 60000 });
  assert.equal(buildCommitment({ id: 'cdur1', title: 'x', date: '2026-09-30', time: '09:30', timezone: MANILA, now: T0, updatedBy: DEVICE, durationMinutes: 721 }).ok, false);
  assert.equal(buildCommitment({ id: 'cdur2', title: 'x', date: '2026-09-30', time: '09:30', timezone: MANILA, now: T0, updatedBy: DEVICE, durationMinutes: 30.5 }).ok, false);
  assert.equal(ok(buildCommitment({ id: 'cdur3', title: 'x', date: '2026-09-30', time: '09:30', timezone: MANILA, now: T0, updatedBy: DEVICE, durationMinutes: 720 })).record.durationMinutes, 720);
});

test('an optional note is trimmed, bounded, and omitted when blank', () => {
  assert.equal(dentist({ id: 'cn1', note: '   ' }).note, undefined);
  assert.equal(dentist({ id: 'cn2', note: '  bring x-rays  ' }).note, 'bring x-rays');
  assert.equal(dentist({ id: 'cn3', note: 'z'.repeat(400) }).note.length, 240);
});

// ═══════════════════════════════════════════════════════════════════════
// 7. merge / convergence
// ═══════════════════════════════════════════════════════════════════════

test('two devices editing the same commitment converge on the later edit, on both sides', () => {
  const base = dentist();
  const a = ok(updateCommitment(base, { time: '10:00', now: T0 + 1000, updatedBy: 'device-a' })).record;
  const b = ok(updateCommitment(base, { time: '11:00', now: T0 + 2000, updatedBy: 'device-b' })).record;
  assert.deepEqual(mergeCommitmentRecords(a, b), b);
  assert.deepEqual(mergeCommitmentRecords(b, a), b, 'merge is symmetric — order of arrival cannot matter');
});

test('an exact updatedAt tie is broken deterministically and identically on both devices', () => {
  const base = dentist();
  const a = ok(updateCommitment(base, { time: '10:00', now: T0 + 1000, updatedBy: 'device-a' })).record;
  const b = ok(updateCommitment(base, { time: '11:00', now: T0 + 1000, updatedBy: 'device-b' })).record;
  const ab = mergeCommitmentRecords(a, b);
  const ba = mergeCommitmentRecords(b, a);
  assert.deepEqual(ab, ba, 'both devices must pick the SAME winner with no coordination');
  assert.ok(ab.time === '10:00' || ab.time === '11:00');
});

test('a tombstone converges like any other later write and is not undone by a stale peer', () => {
  const base = dentist();
  const deletedRec = ok(deleteCommitment(base, { now: T0 + 5000, updatedBy: 'device-a' })).record;
  const staleEdit = ok(updateCommitment(base, { title: 'Dentist!', now: T0 + 1000, updatedBy: 'device-b' })).record;
  assert.equal(mergeCommitmentRecords(staleEdit, deletedRec).deleted, true);
  assert.equal(mergeCommitmentRecords(deletedRec, staleEdit).deleted, true);
  // ...but a LATER un-delete does win, because it is genuinely newer.
  const restored = { ...base, updatedAt: T0 + 9000, updatedBy: 'device-b' };
  assert.equal(mergeCommitmentRecords(deletedRec, restored).deleted, undefined);
});

test('merging maps keeps every id and ignores malformed remote payloads', () => {
  const a = dentist({ id: 'conly-a' });
  const b = dentist({ id: 'conly-b', time: '11:00' });
  const merged = mergeCommitmentMaps({ [a.id]: a }, { [b.id]: b, ['cjunk']: { nope: true } });
  assert.deepEqual(Object.keys(merged).sort(), ['conly-a', 'conly-b']);
  // An id/payload mismatch is dropped rather than stored under the wrong key.
  assert.deepEqual(mergeCommitmentMaps({}, { cwrong: a }), {});
});

// ═══════════════════════════════════════════════════════════════════════
// 8. selection / upcoming
// ═══════════════════════════════════════════════════════════════════════

test('commitmentsForTarget selects by instant containment, in chronological order', () => {
  const revisions = boundary1800();
  const resolve = dayResolver(revisions);
  const day = resolve(manila('2026-09-30', '09:30')); // Sep 29 18:00 -> Sep 30 18:00
  const records = [
    dentist({ id: 'csel3', title: 'Third', time: '15:00' }),
    dentist({ id: 'csel1', title: 'First', time: '09:30' }),
    dentist({ id: 'csel2', title: 'Second', time: '12:00' }),
    dentist({ id: 'cout', title: 'Next day', time: '21:00' }),
    ok(deleteCommitment(dentist({ id: 'cdel', time: '10:00' }), { now: T0 + 1, updatedBy: DEVICE })).record,
  ];
  assert.deepEqual(commitmentsForTarget(records, day).map(r => r.id), ['csel1', 'csel2', 'csel3']);
  assert.deepEqual(commitmentsForTarget(records, resolve(manila('2026-09-30', '21:00'))).map(r => r.id), ['cout']);
  assert.deepEqual(commitmentsForTarget(records, null), []);
});

test('upcomingCommitments lists what is still ahead, soonest first, unbounded by default', () => {
  const records = [
    dentist({ id: 'cfar', time: '09:30', date: '2027-01-15' }),
    dentist({ id: 'csoon', time: '09:30', date: '2026-09-30' }),
    dentist({ id: 'cpast', time: '09:30', date: '2026-09-01' }),
  ];
  const from = manila('2026-09-18', '10:00');
  assert.deepEqual(upcomingCommitments(records, from).map(r => r.id), ['csoon', 'cfar']);
  assert.deepEqual(upcomingCommitments(records, from, 1).map(r => r.id), ['csoon']);
  // A durated commitment still counts as upcoming until its END has passed.
  const running = dentist({ id: 'crun', date: '2026-09-18', time: '09:30', durationMinutes: 120 });
  assert.deepEqual(upcomingCommitments([running], from).map(r => r.id), ['crun']);
});

test('formatCommitmentTime renders a moment, a same-period range, and a cross-period range', () => {
  assert.equal(formatCommitmentTime(dentist()), '9:30 AM');
  assert.equal(formatCommitmentTime(dentist({ id: 'cr1', time: '09:30', durationMinutes: 60 })), '9:30–10:30 AM');
  assert.equal(formatCommitmentTime(dentist({ id: 'cr2', time: '11:30', durationMinutes: 90 })), '11:30 AM–1:00 PM');
  assert.equal(formatCommitmentTime({ nope: true }), null);
});

test('an unresolvable revision history does not make a commitment vanish', () => {
  const record = dentist();
  const result = projectCommitment(record, () => { throw new Error('unknown boundary revision id'); });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unresolvable-day');
  // The commitment is still fully readable by its own id and civil fields.
  assert.ok(normalizeCommitment(record));
});

// ═══════════════════════════════════════════════════════════════════════
// 9. repository
// ═══════════════════════════════════════════════════════════════════════

test('the repository mints ids, persists, reads back and survives a reload', () => {
  const storage = memory();
  const repo = createCommitmentsRepository({ storage, now: () => T0, deviceId: () => DEVICE });
  const created = ok(repo.create({ title: 'Dentist', date: '2026-09-30', time: '09:30', timezone: MANILA }));
  assert.ok(validCommitmentId(created.record.id));
  assert.equal(repo.read(created.record.id).startMs, manila('2026-09-30', '09:30'));

  // A brand-new repository over the SAME storage sees it — that is a reload.
  const reloaded = createCommitmentsRepository({ storage, now: () => T0, deviceId: () => DEVICE });
  assert.deepEqual(reloaded.read(created.record.id), created.record);
  assert.equal(Object.keys(reloaded.listAllRaw()).length, 1);
  assert.equal(storage.getItem(COMMITMENTS_STORAGE_KEY).includes('"schemaVersion":1'), true);
});

test('the repository refuses a DST-anomalous create and persists nothing', () => {
  const storage = memory();
  const repo = createCommitmentsRepository({ storage, now: () => T0, deviceId: () => DEVICE });
  const refused = repo.create({ title: 'Gap', date: '2027-03-14', time: '02:30', timezone: NEW_YORK });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'nonexistent');
  assert.deepEqual(repo.listAllRaw(), {}, 'a refused create must leave storage untouched');

  const ambiguous = repo.create({ title: 'Amb', date: '2026-11-01', time: '01:30', timezone: NEW_YORK });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'ambiguous');
  assert.deepEqual(repo.listAllRaw(), {});
  // With the explicit choice it lands.
  assert.equal(ok(repo.create({ title: 'Amb', date: '2026-11-01', time: '01:30', timezone: NEW_YORK, disambiguate: 'later' })).record.dstChoice, 'later');
});

test('the repository updates in place, tombstones, and restores', () => {
  const storage = memory();
  const clock = { value: T0 };
  const repo = createCommitmentsRepository({ storage, now: () => clock.value, deviceId: () => DEVICE });
  const id = ok(repo.create({ title: 'Dentist', date: '2026-09-30', time: '09:30', timezone: MANILA })).record.id;

  clock.value = T0 + 1000;
  const updated = ok(repo.update(id, { time: '14:00' }));
  assert.equal(updated.record.id, id);
  assert.equal(updated.record.startMs, manila('2026-09-30', '14:00'));

  clock.value = T0 + 2000;
  assert.equal(ok(repo.remove(id)).record.deleted, true);
  assert.equal(repo.read(id).deleted, true, 'the key is retained — a hard delete would be resurrected by merge');

  clock.value = T0 + 3000;
  assert.equal(ok(repo.restore(id)).record.deleted, undefined);

  assert.equal(repo.update('cmissing', { title: 'x' }).reason, 'not-found');
  assert.equal(repo.remove('cmissing').reason, 'not-found');
});

test('the repository merges remote records per record and ignores malformed ones', () => {
  const storage = memory();
  const repo = createCommitmentsRepository({ storage, now: () => T0, deviceId: () => DEVICE });
  const local = ok(repo.create({ id: 'cshared', title: 'Dentist', date: '2026-09-30', time: '09:30', timezone: MANILA })).record;

  const remoteNewer = ok(updateCommitment(local, { time: '15:00', now: T0 + 9000, updatedBy: 'device-b' })).record;
  const merged = repo.mergeRemote('cshared', remoteNewer);
  assert.equal(merged.changed, true);
  assert.equal(repo.read('cshared').startMs, manila('2026-09-30', '15:00'));

  // Idempotent: merging the same payload again changes nothing.
  assert.equal(repo.mergeRemote('cshared', remoteNewer).changed, false);
  // A malformed remote payload cannot corrupt local truth.
  assert.equal(repo.mergeRemote('cshared', { garbage: true }).changed, false);
  assert.equal(repo.read('cshared').startMs, manila('2026-09-30', '15:00'));
});

test('malformed local storage is reported, never silently reset', () => {
  const bad = memory();
  bad.setItem(COMMITMENTS_STORAGE_KEY, '{not json');
  assert.throws(() => createCommitmentsRepository({ storage: bad }).listAllRaw(), /malformed JSON/);

  const wrongVersion = memory();
  wrongVersion.setItem(COMMITMENTS_STORAGE_KEY, JSON.stringify({ schemaVersion: 99, commitments: {} }));
  assert.throws(() => createCommitmentsRepository({ storage: wrongVersion }).listAllRaw(), /unsupported format or schema version/);

  const badKey = memory();
  badKey.setItem(COMMITMENTS_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, commitments: { 'bad/key': {} } }));
  assert.throws(() => createCommitmentsRepository({ storage: badKey }).listAllRaw(), /invalid commitment id key/);
});

test('the model exposes its schema version and is side-effect free under node', () => {
  assert.equal(COMMITMENT_SCHEMA_VERSION, 1);
  assert.equal(resolveCommitmentInstant({ date: 'nope' }).reason, 'invalid-input');
});
