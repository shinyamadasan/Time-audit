import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validDeadlineTime, validDeadlineTimezone,
  validateDeadlineRevision, revisionsAreSemanticDuplicates,
  normalizeDeadlineRevisionHistory, activeDeadlineRevision,
  proposeDeadlineRevision, deadlineInstantForCalendarDate,
  evaluatePlanningDeadlineQualification,
  validateIntentionalOffDayRecord, offDayDeclaredAtForDeadline,
  pickCanonicalRevisionId,
} from './plan-by-deadline-model.js';

const MANILA = 'Asia/Manila';
const iso = s => Date.parse(s);

// ── validators ───────────────────────────────────────────────────────────

test('validDeadlineTime / validDeadlineTimezone reuse the boundary model primitives', () => {
  assert.equal(validDeadlineTime('08:00'), true);
  assert.equal(validDeadlineTime('8:00'), false);
  assert.equal(validDeadlineTime('24:00'), false);
  assert.equal(validDeadlineTimezone(MANILA), true);
  assert.equal(validDeadlineTimezone('Not/AZone'), false);
});

test('validateDeadlineRevision requires a real, finite effectiveFromInstant — never null (no anchor concept)', () => {
  assert.equal(validateDeadlineRevision({ id: 'r1', deadlineTime: '08:00', effectiveFromInstant: iso('2026-09-27T00:00:00Z') }), true);
  assert.equal(validateDeadlineRevision({ id: 'r1', deadlineTime: '08:00', effectiveFromInstant: null }), false);
  assert.equal(validateDeadlineRevision({ id: 'r1', deadlineTime: '08:00' }), false);
  assert.equal(validateDeadlineRevision({ id: '', deadlineTime: '08:00', effectiveFromInstant: 0 }), false);
  assert.equal(validateDeadlineRevision({ id: 'r1', deadlineTime: 'bad', effectiveFromInstant: 0 }), false);
});

test('revisionsAreSemanticDuplicates compares deadlineTime + effectiveFromInstant only', () => {
  const a = { id: 'a', deadlineTime: '08:00', effectiveFromInstant: 1000 };
  const b = { id: 'b', deadlineTime: '08:00', effectiveFromInstant: 1000 };
  const c = { id: 'c', deadlineTime: '09:00', effectiveFromInstant: 1000 };
  assert.equal(revisionsAreSemanticDuplicates(a, b), true);
  assert.equal(revisionsAreSemanticDuplicates(a, c), false);
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
    { id: 'a', deadlineTime: '08:00', effectiveFromInstant: t },
    { id: 'a', deadlineTime: '09:00', effectiveFromInstant: t + 1 },
  ]), /unique/);
  assert.throws(() => normalizeDeadlineRevisionHistory([
    { id: 'a', deadlineTime: '08:00', effectiveFromInstant: t },
    { id: 'b', deadlineTime: '09:00', effectiveFromInstant: t },
  ]), /unique/);
});

test('activeDeadlineRevision resolves strictly from the instant, returns null before the first revision', () => {
  const r1 = { id: 'r1', deadlineTime: '08:00', effectiveFromInstant: 1000 };
  const r2 = { id: 'r2', deadlineTime: '09:00', effectiveFromInstant: 2000 };
  assert.equal(activeDeadlineRevision([r1, r2], 999), null);
  assert.equal(activeDeadlineRevision([r1, r2], 1000).id, 'r1');
  assert.equal(activeDeadlineRevision([r1, r2], 1999).id, 'r1');
  assert.equal(activeDeadlineRevision([r1, r2], 2000).id, 'r2');
});

// ── §9 activation semantics ─────────────────────────────────────────────

test('proposeDeadlineRevision: if today\'s new deadline is still in the future, it begins today', () => {
  const now = iso('2026-09-27T00:00:00Z'); // 08:00 Manila
  const { revision } = proposeDeadlineRevision([], { id: 'r1', deadlineTime: '10:00', timezone: MANILA }, now);
  // 10:00 Manila on 2026-09-27 hasn't happened yet at 08:00 Manila -> begins today
  const expected = Date.parse('2026-09-27T02:00:00Z'); // 10:00 Manila == 02:00 UTC
  assert.equal(revision.effectiveFromInstant, expected);
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
  // Existing deadline 11:00; user changes to 08:00 at 07:00 (before both) -> new rule begins TODAY at 08:00
  const before7am = iso('2026-09-26T23:00:00Z'); // 07:00 Manila (UTC+8) on 2026-09-27
  const seed = [{ id: 'r0', deadlineTime: '11:00', effectiveFromInstant: iso('2026-01-01T00:00:00Z') }];
  const changedEarly = proposeDeadlineRevision(seed, { id: 'r1', deadlineTime: '08:00', timezone: MANILA }, before7am);
  assert.equal(changedEarly.revision.effectiveFromInstant, iso('2026-09-27T00:00:00Z')); // 08:00 Manila same day

  // Same change, but made at 09:00 (08:00 already passed) -> begins TOMORROW at 08:00
  const after9am = iso('2026-09-27T01:00:00Z'); // 09:00 Manila
  const changedLate = proposeDeadlineRevision(seed, { id: 'r1', deadlineTime: '08:00', timezone: MANILA }, after9am);
  assert.equal(changedLate.revision.effectiveFromInstant, iso('2026-09-28T00:00:00Z')); // 08:00 Manila next day
});

// ── deadlineInstantForCalendarDate ───────────────────────────────────────

test('deadlineInstantForCalendarDate returns null when unconfigured for that date', () => {
  assert.equal(deadlineInstantForCalendarDate('2026-09-27', MANILA, []), null);
  const revisions = [{ id: 'r1', deadlineTime: '08:00', effectiveFromInstant: iso('2026-10-01T00:00:00Z') }];
  assert.equal(deadlineInstantForCalendarDate('2026-09-27', MANILA, revisions), null); // predates first revision
});

test('deadlineInstantForCalendarDate resolves the ordinary case', () => {
  const revisions = [{ id: 'r1', deadlineTime: '08:00', effectiveFromInstant: iso('2026-01-01T00:00:00Z') }];
  assert.equal(deadlineInstantForCalendarDate('2026-09-27', MANILA, revisions), iso('2026-09-27T00:00:00Z')); // 08:00 Manila
});

test('deadlineInstantForCalendarDate: a revision that takes over mid-date before the prior deadline would have fired supersedes it', () => {
  // r0: 11:00 deadline, active since 2026-01-01. r1: changed to 08:00, effective exactly 2026-09-27T08:00 Manila (proposed early that morning).
  const r0 = { id: 'r0', deadlineTime: '11:00', effectiveFromInstant: iso('2026-01-01T00:00:00Z') };
  const r1 = { id: 'r1', deadlineTime: '08:00', effectiveFromInstant: iso('2026-09-27T00:00:00Z') }; // 08:00 Manila == 00:00Z
  const instant = deadlineInstantForCalendarDate('2026-09-27', MANILA, [r0, r1]);
  assert.equal(instant, r1.effectiveFromInstant); // 08:00 wins, not the naive 11:00 from r0
});

test('deadlineInstantForCalendarDate: a revision that takes over mid-date AFTER the prior deadline would have fired does not affect that date', () => {
  // r0: 08:00 deadline (already fired for the date by the time r1 takes effect at 11:00 same date)
  const r0 = { id: 'r0', deadlineTime: '08:00', effectiveFromInstant: iso('2026-01-01T00:00:00Z') };
  const r1 = { id: 'r1', deadlineTime: '11:00', effectiveFromInstant: iso('2026-09-27T03:00:00Z') }; // 11:00 Manila
  const instant = deadlineInstantForCalendarDate('2026-09-27', MANILA, [r0, r1]);
  assert.equal(instant, iso('2026-09-27T00:00:00Z')); // r0's naive 08:00 stands
});

test('deadlineInstantForCalendarDate: first-ever configuration taking effect mid-date is honored for that date', () => {
  const r1 = { id: 'r1', deadlineTime: '08:00', effectiveFromInstant: iso('2026-09-27T00:00:00Z') }; // 08:00 Manila same date
  assert.equal(deadlineInstantForCalendarDate('2026-09-27', MANILA, [r1]), r1.effectiveFromInstant);
  assert.equal(deadlineInstantForCalendarDate('2026-09-26', MANILA, [r1]), null); // day before is still unconfigured
});

// ── §25 exact-instant adversarial cases: 07:59 / 08:00 for an 08:00 deadline ─

test('07:59 is before the deadline instant; 08:00 is at/after it (deadline instant itself belongs to "at")', () => {
  const revisions = [{ id: 'r1', deadlineTime: '08:00', effectiveFromInstant: iso('2026-01-01T00:00:00Z') }];
  const deadline = deadlineInstantForCalendarDate('2026-09-27', MANILA, revisions);
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
  // Simulated "app opens late" at 09:30 for an 08:00 deadline: the function
  // never reads a clock itself, so its answer is identical whenever it's called.
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
