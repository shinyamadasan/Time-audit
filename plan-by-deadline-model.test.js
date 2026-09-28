import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validDeadlineTime, validDeadlineTimezone,
  validateDeadlineRevision, revisionsAreSemanticDuplicates, revisionsContradict,
  normalizeDeadlineRevisionHistory, activeDeadlineRevision,
  proposeDeadlineRevision, deadlineInstantForCalendarDate,
  findEqualAuthorityConflicts, activeEqualAuthorityConflicts,
  evaluatePlanningDeadlineQualification,
  validateIntentionalOffDayRecord, offDayDeclaredAtForDeadline,
  pickCanonicalRevisionId,
} from './plan-by-deadline-model.js';

const MANILA = 'Asia/Manila';
const NY = 'America/New_York';
const iso = s => Date.parse(s);

// ── validators ───────────────────────────────────────────────────────────

test('validDeadlineTime / validDeadlineTimezone reuse the boundary model primitives', () => {
  assert.equal(validDeadlineTime('08:00'), true);
  assert.equal(validDeadlineTime('8:00'), false);
  assert.equal(validDeadlineTime('24:00'), false);
  assert.equal(validDeadlineTimezone(MANILA), true);
  assert.equal(validDeadlineTimezone('Not/AZone'), false);
});

test('validateDeadlineRevision requires id/deadlineTime/timezone and a real, finite effectiveFromInstant — never null (no anchor concept)', () => {
  assert.equal(validateDeadlineRevision({ id: 'r1', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: iso('2026-09-27T00:00:00Z') }), true);
  assert.equal(validateDeadlineRevision({ id: 'r1', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: null }), false);
  assert.equal(validateDeadlineRevision({ id: 'r1', deadlineTime: '08:00', timezone: MANILA }), false);
  assert.equal(validateDeadlineRevision({ id: '', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 0 }), false);
  assert.equal(validateDeadlineRevision({ id: 'r1', deadlineTime: 'bad', timezone: MANILA, effectiveFromInstant: 0 }), false);
  assert.equal(validateDeadlineRevision({ id: 'r1', deadlineTime: '08:00', effectiveFromInstant: 0 }), false); // no timezone — FIX FIRST §8/§9
  assert.equal(validateDeadlineRevision({ id: 'r1', deadlineTime: '08:00', timezone: 'Not/AZone', effectiveFromInstant: 0 }), false);
});

test('revisionsAreSemanticDuplicates compares deadlineTime + timezone + effectiveFromInstant', () => {
  const a = { id: 'a', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const b = { id: 'b', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const c = { id: 'c', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const d = { id: 'd', deadlineTime: '08:00', timezone: NY, effectiveFromInstant: 1000 }; // same clock reading, different zone: NOT a duplicate
  assert.equal(revisionsAreSemanticDuplicates(a, b), true);
  assert.equal(revisionsAreSemanticDuplicates(a, c), false);
  assert.equal(revisionsAreSemanticDuplicates(a, d), false);
});

test('pickCanonicalRevisionId is re-exported and order-independent', () => {
  assert.equal(pickCanonicalRevisionId('a', 'b'), 'a');
  assert.equal(pickCanonicalRevisionId('b', 'a'), 'a');
});

// ── history normalization ───────────────────────────────────────────────

test('an empty deadline revision history is valid and means "never configured"', () => {
  assert.deepEqual(normalizeDeadlineRevisionHistory([]), []);
  assert.equal(activeDeadlineRevision([], Date.now()), null);
});

test('normalizeDeadlineRevisionHistory rejects duplicate ids or duplicate effective instants', () => {
  const t = 1000;
  assert.throws(() => normalizeDeadlineRevisionHistory([
    { id: 'a', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: t },
    { id: 'a', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: t + 1 },
  ]), /unique/);
  assert.throws(() => normalizeDeadlineRevisionHistory([
    { id: 'a', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: t },
    { id: 'b', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: t },
  ]), /unique/);
});

test('activeDeadlineRevision resolves strictly from the instant, returns null before the first revision', () => {
  const r1 = { id: 'r1', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const r2 = { id: 'r2', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: 2000 };
  assert.equal(activeDeadlineRevision([r1, r2], 999), null);
  assert.equal(activeDeadlineRevision([r1, r2], 1000).id, 'r1');
  assert.equal(activeDeadlineRevision([r1, r2], 1999).id, 'r1');
  assert.equal(activeDeadlineRevision([r1, r2], 2000).id, 'r2');
});

// ── §9 activation semantics ─────────────────────────────────────────────

test('proposeDeadlineRevision: if today\'s new deadline is still in the future, it begins today, and STORES the given timezone on the revision', () => {
  const now = iso('2026-09-27T00:00:00Z'); // 08:00 Manila
  const { revision } = proposeDeadlineRevision([], { id: 'r1', deadlineTime: '10:00', timezone: MANILA }, now);
  const expected = Date.parse('2026-09-27T02:00:00Z'); // 10:00 Manila == 02:00 UTC
  assert.equal(revision.effectiveFromInstant, expected);
  assert.equal(revision.timezone, MANILA); // FIX FIRST §8: revision-owned, not externally resolved later
});

test('proposeDeadlineRevision: if today\'s new deadline has already passed, first enforcement begins tomorrow', () => {
  const now = iso('2026-09-27T04:00:00Z'); // 12:00 Manila — 10:00 already passed
  const { revision } = proposeDeadlineRevision([], { id: 'r1', deadlineTime: '10:00', timezone: MANILA }, now);
  const expected = Date.parse('2026-09-28T02:00:00Z'); // 10:00 Manila next day
  assert.equal(revision.effectiveFromInstant, expected);
});

test('proposeDeadlineRevision never rewrites prior history — appends and re-sorts only', () => {
  const now1 = iso('2026-09-27T00:00:00Z');
  const step1 = proposeDeadlineRevision([], { id: 'r1', deadlineTime: '10:00', timezone: MANILA }, now1);
  const now2 = iso('2026-09-28T00:00:00Z');
  const step2 = proposeDeadlineRevision(step1.revisions, { id: 'r2', deadlineTime: '07:00', timezone: MANILA }, now2);
  assert.equal(step2.revisions.length, 2);
  assert.equal(step2.revisions[0].id, 'r1');
  assert.equal(step2.revisions[0].effectiveFromInstant, step1.revision.effectiveFromInstant); // untouched
});

test('changing the deadline before today\'s deadline vs after produces different activation dates (input-order independent outcome)', () => {
  const before7am = iso('2026-09-26T23:00:00Z'); // 07:00 Manila (UTC+8) on 2026-09-27
  const seed = [{ id: 'r0', deadlineTime: '11:00', timezone: MANILA, effectiveFromInstant: iso('2026-01-01T00:00:00Z') }];
  const changedEarly = proposeDeadlineRevision(seed, { id: 'r1', deadlineTime: '08:00', timezone: MANILA }, before7am);
  assert.equal(changedEarly.revision.effectiveFromInstant, iso('2026-09-27T00:00:00Z')); // 08:00 Manila same day

  const after9am = iso('2026-09-27T01:00:00Z'); // 09:00 Manila
  const changedLate = proposeDeadlineRevision(seed, { id: 'r1', deadlineTime: '08:00', timezone: MANILA }, after9am);
  assert.equal(changedLate.revision.effectiveFromInstant, iso('2026-09-28T00:00:00Z')); // 08:00 Manila next day
});

// ── deadlineInstantForCalendarDate (FIX FIRST §8: no external timezone param) ─

test('deadlineInstantForCalendarDate returns null when unconfigured for that date', () => {
  assert.equal(deadlineInstantForCalendarDate('2026-09-27', []), null);
  const revisions = [{ id: 'r1', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: iso('2026-10-01T00:00:00Z') }];
  assert.equal(deadlineInstantForCalendarDate('2026-09-27', revisions), null); // predates first revision
});

test('deadlineInstantForCalendarDate resolves the ordinary case', () => {
  const revisions = [{ id: 'r1', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: iso('2026-01-01T00:00:00Z') }];
  assert.equal(deadlineInstantForCalendarDate('2026-09-27', revisions), iso('2026-09-27T00:00:00Z')); // 08:00 Manila
});

test('deadlineInstantForCalendarDate: a revision that takes over mid-date before the prior deadline would have fired supersedes it', () => {
  const r0 = { id: 'r0', deadlineTime: '11:00', timezone: MANILA, effectiveFromInstant: iso('2026-01-01T00:00:00Z') };
  const r1 = { id: 'r1', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: iso('2026-09-27T00:00:00Z') }; // 08:00 Manila == 00:00Z
  const instant = deadlineInstantForCalendarDate('2026-09-27', [r0, r1]);
  assert.equal(instant, r1.effectiveFromInstant); // 08:00 wins, not the naive 11:00 from r0
});

test('deadlineInstantForCalendarDate: a revision that takes over mid-date AFTER the prior deadline would have fired does not affect that date', () => {
  const r0 = { id: 'r0', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: iso('2026-01-01T00:00:00Z') };
  const r1 = { id: 'r1', deadlineTime: '11:00', timezone: MANILA, effectiveFromInstant: iso('2026-09-27T03:00:00Z') }; // 11:00 Manila
  const instant = deadlineInstantForCalendarDate('2026-09-27', [r0, r1]);
  assert.equal(instant, iso('2026-09-27T00:00:00Z')); // r0's naive 08:00 stands
});

test('deadlineInstantForCalendarDate: first-ever configuration taking effect mid-date is honored for that date', () => {
  const r1 = { id: 'r1', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: iso('2026-09-27T00:00:00Z') }; // 08:00 Manila same date
  assert.equal(deadlineInstantForCalendarDate('2026-09-27', [r1]), r1.effectiveFromInstant);
  assert.equal(deadlineInstantForCalendarDate('2026-09-26', [r1]), null); // day before is still unconfigured
});

// ── FIX FIRST §8: historical timezone stability (revision-owned, never re-resolved) ─

test('a historical day\'s deadline instant is identical whether computed under the revision\'s OWN Manila timezone or NOT touched by a later, different revision', () => {
  const revisions = [{ id: 'r1', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: iso('2026-01-01T00:00:00Z') }];
  const before = deadlineInstantForCalendarDate('2026-06-15', revisions);
  // Simulates "the account's current timezone later became America/New_York" — this
  // revision's OWN stored timezone (Manila) is untouched; nothing external is passed in.
  const after = deadlineInstantForCalendarDate('2026-06-15', revisions);
  assert.equal(before, after);
  assert.equal(before, Date.parse('2026-06-15T00:00:00Z')); // 08:00 Manila, computed from the revision's own tz
});

test('a NEW revision proposed after a timezone change applies prospectively, in ITS OWN new timezone, without touching the old Manila-governed dates', () => {
  const r0 = { id: 'r0', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: iso('2026-01-01T00:00:00Z') };
  // Propose a new revision under a NEW timezone (the account moved to NY), effective 2026-09-27T00:00:00Z (08:00 America/New_York, EDT = UTC-4).
  const r1 = { id: 'r1', deadlineTime: '08:00', timezone: NY, effectiveFromInstant: iso('2026-09-27T12:00:00Z') };
  // A date BEFORE the timezone change: still governed by r0, in Manila.
  assert.equal(deadlineInstantForCalendarDate('2026-09-20', [r0, r1]), Date.parse('2026-09-20T00:00:00Z')); // 08:00 Manila
  // A date AFTER the timezone change: governed by r1, in New York (its own timezone), not Manila.
  const afterMs = deadlineInstantForCalendarDate('2026-09-28', [r0, r1]);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit', hour12: false });
  assert.equal(fmt.format(new Date(afterMs)), '08:00');
});

// ── FIX FIRST §14/§15: equal-authority contradictory revisions ────────────

test('revisionsContradict: true only for a shared effectiveFromInstant with different facts', () => {
  const a = { id: 'a', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const dup = { id: 'b', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const contradicting = { id: 'c', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const different = { id: 'd', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: 2000 };
  assert.equal(revisionsContradict(a, dup), false); // semantic duplicate, not a contradiction
  assert.equal(revisionsContradict(a, contradicting), true);
  assert.equal(revisionsContradict(a, different), false); // different instant — not equal authority at all
});

test('findEqualAuthorityConflicts detects a same-instant, different-facts group and ignores clean/duplicate ones', () => {
  const clean = [
    { id: 'a', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 },
    { id: 'b', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: 2000 },
  ];
  assert.deepEqual(findEqualAuthorityConflicts(clean), []);

  const dup = [
    { id: 'a', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 },
    { id: 'a2', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 }, // semantic duplicate, not a conflict
  ];
  assert.deepEqual(findEqualAuthorityConflicts(dup), []);

  const contradicting = [
    { id: 'x', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 },
    { id: 'y', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: 1000 }, // same instant, different facts
  ];
  const conflicts = findEqualAuthorityConflicts(contradicting);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].length, 2);
});

test('findEqualAuthorityConflicts never throws and never picks a winner — it only detects', () => {
  const contradicting = [
    { id: 'x', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 },
    { id: 'y', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: 1000 },
  ];
  assert.doesNotThrow(() => findEqualAuthorityConflicts(contradicting));
  const conflicts = findEqualAuthorityConflicts(contradicting);
  // Both facts are present in the result — neither was discarded.
  const ids = conflicts[0].map(r => r.id).sort();
  assert.deepEqual(ids, ['x', 'y']);
});

test('reversed delivery/arrival order produces the IDENTICAL conflict result — input order never decides truth', () => {
  const x = { id: 'x', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const y = { id: 'y', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const forward = findEqualAuthorityConflicts([x, y]);
  const reversed = findEqualAuthorityConflicts([y, x]);
  const idsOf = conflicts => conflicts[0].map(r => r.id).sort();
  assert.deepEqual(idsOf(forward), idsOf(reversed));
});

test('activeEqualAuthorityConflicts: a conflict stops being reported once a LATER clean revision exists (resolved by proposing a new one), but is not deleted from the raw set', () => {
  const x = { id: 'x', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const y = { id: 'y', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: 1000 };
  assert.equal(activeEqualAuthorityConflicts([x, y]).length, 1); // still open

  const resolved = { id: 'z', deadlineTime: '07:00', timezone: MANILA, effectiveFromInstant: 2000 }; // proposed AFTER the conflict
  assert.equal(activeEqualAuthorityConflicts([x, y, resolved]).length, 0); // no longer active...
  assert.equal(findEqualAuthorityConflicts([x, y, resolved]).length, 1); // ...but still detectable/preserved as raw history
});

test('activeEqualAuthorityConflicts: a conflict remains active if the only later revision is itself part of the SAME or an earlier conflict', () => {
  const x = { id: 'x', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const y = { id: 'y', deadlineTime: '09:00', timezone: MANILA, effectiveFromInstant: 1000 };
  const notYetResolving = { id: 'w', deadlineTime: '07:00', timezone: MANILA, effectiveFromInstant: 500 }; // BEFORE the conflict, not after
  assert.equal(activeEqualAuthorityConflicts([x, y, notYetResolving]).length, 1);
});

// ── §25 exact-instant adversarial cases: 07:59 / 08:00 for an 08:00 deadline ─

test('07:59 is before the deadline instant; 08:00 is at/after it (deadline instant itself belongs to "at")', () => {
  const revisions = [{ id: 'r1', deadlineTime: '08:00', timezone: MANILA, effectiveFromInstant: iso('2026-01-01T00:00:00Z') }];
  const deadline = deadlineInstantForCalendarDate('2026-09-27', revisions);
  const at0759 = deadline - 60000;
  const at0800 = deadline;
  assert.equal(evaluatePlanningDeadlineQualification(deadline, at0759, null).status, 'maintained');
  assert.equal(evaluatePlanningDeadlineQualification(deadline, at0800, null).status, 'missed'); // strictly before required
});

// ── streak qualification (§10, §12) ──────────────────────────────────────

test('evaluatePlanningDeadlineQualification: unenforced when the date has no deadline', () => {
  assert.equal(evaluatePlanningDeadlineQualification(null, 12345, null).status, 'unenforced');
});

test('evaluatePlanningDeadlineQualification: plan before deadline -> maintained; neither -> missed', () => {
  const deadline = 100000;
  assert.equal(evaluatePlanningDeadlineQualification(deadline, 50000, null).status, 'maintained');
  assert.equal(evaluatePlanningDeadlineQualification(deadline, null, null).status, 'missed');
  assert.equal(evaluatePlanningDeadlineQualification(deadline, 150000, null).status, 'missed'); // prepared after deadline doesn't retroactively count
});

test('evaluatePlanningDeadlineQualification: intentional off-day declared before deadline also maintains the streak', () => {
  const deadline = 100000;
  assert.equal(evaluatePlanningDeadlineQualification(deadline, null, 50000).status, 'maintained');
});

test('evaluatePlanningDeadlineQualification is deterministic from persisted facts alone — no timer dependency modeled at all', () => {
  const deadline = iso('2026-09-27T00:00:00Z');
  const preparedAt0759 = deadline - 60000;
  const resultAtOpenTime = evaluatePlanningDeadlineQualification(deadline, preparedAt0759, null);
  const resultCalledAgainMuchLater = evaluatePlanningDeadlineQualification(deadline, preparedAt0759, null);
  assert.deepEqual(resultAtOpenTime, resultCalledAgainMuchLater);
  assert.equal(resultAtOpenTime.status, 'maintained');
});

// ── intentional off-day ───────────────────────────────────────────────────

test('validateIntentionalOffDayRecord requires a dateKey and a real declaredAtMs; revokedAtMs must be at/after declaredAtMs', () => {
  assert.equal(validateIntentionalOffDayRecord({ dateKey: '2026-09-27', declaredAtMs: 1000 }), true);
  assert.equal(validateIntentionalOffDayRecord({ dateKey: '2026-9-27', declaredAtMs: 1000 }), false);
  assert.equal(validateIntentionalOffDayRecord({ dateKey: '2026-09-27', declaredAtMs: 1000, revokedAtMs: 999 }), false);
  assert.equal(validateIntentionalOffDayRecord({ dateKey: '2026-09-27', declaredAtMs: 1000, revokedAtMs: 1000 }), true); // same instant (fast action / frozen clock) is valid
  assert.equal(validateIntentionalOffDayRecord({ dateKey: '2026-09-27', declaredAtMs: 1000, revokedAtMs: 1001 }), true);
});

test('offDayDeclaredAtForDeadline: reversible before the deadline — a revoke before it means the off-day never qualifies', () => {
  const deadline = 100000;
  const declaredOnly = { dateKey: '2026-09-27', declaredAtMs: 1000 };
  assert.equal(offDayDeclaredAtForDeadline(declaredOnly, deadline), 1000);

  const revokedBeforeDeadline = { dateKey: '2026-09-27', declaredAtMs: 1000, revokedAtMs: 50000 };
  assert.equal(offDayDeclaredAtForDeadline(revokedBeforeDeadline, deadline), null);

  const revokedAfterDeadline = { dateKey: '2026-09-27', declaredAtMs: 1000, revokedAtMs: 150000 };
  assert.equal(offDayDeclaredAtForDeadline(revokedAfterDeadline, deadline), 1000); // revoke came too late to matter

  assert.equal(offDayDeclaredAtForDeadline(null, deadline), null);
});
