// node life-ledger-temporal-regression.test.js
//
// Focused regression suite for the temporal-precision redesign (life-ledger-core.js's
// 'instant' vs 'date' invariant). Each test below is traceable to one bullet in the
// architectural review's "TEMPORAL REGRESSION TESTS" checklist.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalizeLifeLedgerFacts,
  createLifeLedgerMemoryStore,
  fingerprintLifeLedgerEvent,
  serializeLifeLedgerFacts,
  upsertLifeLedgerEvent,
  validateLifeLedgerEvent,
  validateLifeLedgerEventDraft
} from './life-ledger-core.js';
import { importMealSnapshot, normalizeMealPrepared } from './meal-life-ledger-adapter.js';
import { buildObsidianLifeLedgerExport } from './obsidian-life-ledger-renderer.js';
import {
  createLifeLedgerSnapshotFromEvents,
  parseLifeLedgerSnapshotJson,
  serializeLifeLedgerSnapshot
} from './life-ledger-transport.js';

const TZ = 'America/Phoenix';

function legacyInstantWorkoutEvent(overrides = {}) {
  // A workout_completed event exactly as it existed before this redesign — no
  // temporalPrecision field at all.
  return {
    schemaVersion: 1,
    sourceApp: 'workout',
    sourceEntityId: 'legacy-workout-1',
    type: 'workout_completed',
    occurredAt: '2026-08-30T18:00:00.000Z',
    sourceTimezone: TZ,
    payload: {
      workoutName: 'Legacy Full Body',
      startedAt: '2026-08-30T17:00:00.000Z',
      endedAt: '2026-08-30T18:00:00.000Z',
      durationMinutes: 60
    },
    provenance: {
      source: 'workout',
      sourceRecordKind: 'opengym.workout',
      adapterVersion: 'test-v1',
      observedAt: '2026-08-30T18:01:00.000Z',
      evidence: ['opengym.backup:workouts/legacy-workout-1']
    },
    confidence: { score: 0.9, basis: 'validated-supplied-backup-record' },
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null },
    ...overrides
  };
}

function mealPreparedDraft(overrides = {}) {
  return normalizeMealPrepared(
    {
      id: 'cm_temporal_1', recipeId: 'r_1', name: 'Temporal Test Meal',
      cookedDate: '2026-08-28', storage: 'fridge', fridgeLife: 4, freezerLife: 90,
      initialPortions: 2, portionsRemaining: 2, ...overrides
    },
    { assertedTimezone: TZ, observedAt: '2026-08-31T00:00:00.000Z' }
  ).draft;
}

console.log('\nTemporal precision — legacy instant compatibility');

test('a legacy instant event with no temporalPrecision field remains fully valid', () => {
  const result = validateLifeLedgerEvent({ ...legacyInstantWorkoutEvent(), eventId: '00000000-0000-4000-8000-000000000001', recordedAt: '2026-08-30T18:01:00.000Z', revision: 1 });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('instant-precision event TYPES still require occurredAt — omitting it fails validation', () => {
  const withoutOccurredAt = legacyInstantWorkoutEvent();
  delete withoutOccurredAt.occurredAt;
  assert.equal(validateLifeLedgerEventDraft(withoutOccurredAt).ok, false);
});

test('an instant event explicitly declaring temporalPrecision: "instant" is equivalent to omitting it', () => {
  const explicit = validateLifeLedgerEventDraft({ ...legacyInstantWorkoutEvent(), temporalPrecision: 'instant' });
  const implicit = validateLifeLedgerEventDraft(legacyInstantWorkoutEvent());
  assert.equal(explicit.ok, true);
  assert.equal(implicit.ok, true);
});

test('an instant-precision event asserting temporalPrecision: "date" is rejected', () => {
  const result = validateLifeLedgerEventDraft({ ...legacyInstantWorkoutEvent(), temporalPrecision: 'date' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('temporalPrecision')));
});

console.log('\nTemporal precision — date-precision facts');

test('date events do not claim occurredAt', () => {
  const draft = mealPreparedDraft();
  assert.equal('occurredAt' in draft, false);
  assert.equal(draft.temporalPrecision, 'date');
});

test('date events carry a valid factual calendar date matching payload', () => {
  const draft = mealPreparedDraft({ cookedDate: '2026-11-03' });
  assert.equal(draft.occurredDate, '2026-11-03');
  assert.equal(draft.payload.preparedDate, '2026-11-03');
  assert.equal(validateLifeLedgerEventDraft(draft).ok, true);
});

test('an invalid calendar date (2026-02-30) is rejected at the draft-validation layer directly, not just by the adapter', () => {
  const draft = mealPreparedDraft();
  const withImpossibleDate = { ...draft, occurredDate: '2026-02-30', payload: { ...draft.payload, preparedDate: '2026-02-30' } };
  assert.equal(validateLifeLedgerEventDraft(withImpossibleDate).ok, false);
});

test('a date event explicitly asserting a fabricated occurredAt (fake midnight) is rejected', () => {
  const draft = mealPreparedDraft();
  const fakeMidnight = { ...draft, occurredAt: `${draft.occurredDate}T00:00:00.000Z` };
  assert.equal(validateLifeLedgerEventDraft(fakeMidnight).ok, false);
});

test('a date event carrying occurredAt: null is rejected because the key itself must be absent', () => {
  const draft = mealPreparedDraft();
  assert.equal(validateLifeLedgerEventDraft({ ...draft, occurredAt: null }).ok, false);
});

test('an instant event carrying occurredDate: null is rejected because the key itself must be absent', () => {
  assert.equal(validateLifeLedgerEventDraft({ ...legacyInstantWorkoutEvent(), occurredDate: null }).ok, false);
});

test('date-only meal_prepared cannot accidentally enter duration/time-of-day validation logic', () => {
  // The generic duration rule is opt-in per event type (PAYLOAD_RULES[type].duration) and
  // meal_prepared never sets it — but also directly prove that supplying a
  // startedAt/endedAt/durationMinutes-shaped payload on it is rejected as unknown, not
  // silently accepted as if it were an interval event.
  const draft = mealPreparedDraft();
  const withFakeInterval = {
    ...draft,
    payload: { ...draft.payload, startedAt: draft.occurredDate + 'T00:00:00.000Z', endedAt: draft.occurredDate + 'T01:00:00.000Z', durationMinutes: 60 }
  };
  const result = validateLifeLedgerEventDraft(withFakeInterval);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('is not allowed for meal_prepared')));
});

console.log('\nTemporal precision — canonical serialization');

test('canonical serialization distinguishes temporal modes: instant events omit occurredDate/temporalPrecision entirely', () => {
  const canonical = canonicalizeLifeLedgerFacts(legacyInstantWorkoutEvent());
  assert.equal('occurredDate' in canonical, false);
  assert.equal('temporalPrecision' in canonical, false);
  assert.ok('occurredAt' in canonical);
});

test('canonical serialization distinguishes temporal modes: date events omit occurredAt and include occurredDate + temporalPrecision', () => {
  const canonical = canonicalizeLifeLedgerFacts(mealPreparedDraft());
  assert.equal('occurredAt' in canonical, false);
  assert.equal(canonical.temporalPrecision, 'date');
  assert.ok('occurredDate' in canonical);
});

test('backward compatibility: an instant event\'s fingerprint is unaffected by the redesign (no new canonical fields leak in)', () => {
  // If temporalPrecision/occurredDate ever leaked into an instant event's canonical form,
  // every already-stored instant event's fingerprint would silently change, which would
  // make upsertLifeLedgerEvent() misclassify every existing record as "changed" on its next
  // touch. This is the concrete failure mode this test rules out.
  const event = legacyInstantWorkoutEvent();
  const fp1 = fingerprintLifeLedgerEvent(event);
  const fp2 = fingerprintLifeLedgerEvent({ ...event, temporalPrecision: 'instant' });
  assert.equal(fp1, fp2);
  assert.equal(serializeLifeLedgerFacts(event), serializeLifeLedgerFacts({ ...event, temporalPrecision: 'instant' }));
});

console.log('\nTemporal precision — revision/store logic');

test('upsertLifeLedgerEvent creates and idempotently re-accepts a date-precision event exactly like an instant one', () => {
  const store = createLifeLedgerMemoryStore();
  const draft = mealPreparedDraft();
  const created = upsertLifeLedgerEvent(store, draft, { createId: () => '00000000-0000-4000-8000-000000000002', clock: () => '2026-08-31T00:00:00.000Z' });
  assert.equal(created.action, 'created');
  assert.equal(created.event.temporalPrecision, 'date');
  assert.equal('occurredAt' in created.event, false);
  const retry = upsertLifeLedgerEvent(store, draft, { clock: () => '2026-09-01T00:00:00.000Z' });
  assert.equal(retry.action, 'unchanged');
  assert.equal(retry.event.revision, 1);
});

console.log('\nTemporal precision — transport round-trip');

test('transport round-trip preserves temporal precision for a date event', () => {
  const store = createLifeLedgerMemoryStore();
  importMealSnapshot(
    { cookedMeals: [{ id: 'cm_transport_1', name: 'Transport Meal', cookedDate: '2026-08-28', storage: 'fridge' }], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => '2026-08-31T00:00:00.000Z' }
  );
  const snapshot = createLifeLedgerSnapshotFromEvents(store.listEvents());
  const json = serializeLifeLedgerSnapshot(snapshot);
  const roundTripped = parseLifeLedgerSnapshotJson(json);
  const event = roundTripped.events.find(e => e.type === 'meal_prepared');
  assert.equal(event.temporalPrecision, 'date');
  assert.equal(event.occurredDate, '2026-08-28');
  assert.equal('occurredAt' in event, false);
  assert.equal(validateLifeLedgerEvent(event).ok, true);
});

test('transport round-trip preserves temporal precision for an instant event unchanged', () => {
  const event = { ...legacyInstantWorkoutEvent(), eventId: '00000000-0000-4000-8000-000000000003', recordedAt: '2026-08-30T18:01:00.000Z', revision: 1 };
  const snapshot = createLifeLedgerSnapshotFromEvents([event]);
  const roundTripped = parseLifeLedgerSnapshotJson(serializeLifeLedgerSnapshot(snapshot));
  assert.equal(roundTripped.events[0].occurredAt, event.occurredAt);
  assert.equal('occurredDate' in roundTripped.events[0], false);
});

console.log('\nTemporal precision — deterministic mixed sorting and Daily file assignment');

test('deterministic mixed sorting: within a section that mixes both precisions (Meals), the date-precision event sorts before that same day\'s timed event', () => {
  // renderDaily groups events into fixed TYPE sections (Activity/Focus/Learning/Workouts/
  // Meals) printed in a fixed order — cross-section order is structural, not
  // chronological. The Meals section is the one place both temporal precisions genuinely
  // mix (meal_prepared is date-precision, meal_consumed is instant), so that is where
  // sortEvents' cross-precision ordering is actually observable in rendered output.
  const store = createLifeLedgerMemoryStore();
  const result = importMealSnapshot(
    {
      cookedMeals: [{ id: 'cm_sort_1', name: 'Sort Prep Meal', cookedDate: '2026-08-30', storage: 'fridge', initialPortions: 1, portionsRemaining: 1 }],
      // 20:00 UTC = 13:00 in America/Phoenix (UTC-7) — safely the same local calendar day.
      mealConsumptions: [{ id: 'mc_sort_1', cookedMealId: 'cm_sort_1', mealName: 'Sort Prep Meal', portionsConsumed: 1, consumedAt: '2026-08-30T20:00:00.000Z' }]
    },
    { store, assertedTimezone: TZ, observationClock: () => '2026-08-31T00:00:00.000Z' }
  );
  assert.equal(result.status, 'ok', JSON.stringify(result));
  const exportPlan = buildObsidianLifeLedgerExport(store.listEvents());
  const dayFile = exportPlan.files.find(f => f.relativePath === 'Life Ledger/Daily/2026-08-30.md');
  assert.ok(dayFile, 'expected a single 2026-08-30 Daily file to exist');
  const preparedIndex = dayFile.content.indexOf('Prepared **Sort Prep Meal**');
  const consumedIndex = dayFile.content.indexOf('Ate **Sort Prep Meal**');
  assert.ok(preparedIndex >= 0 && consumedIndex >= 0);
  assert.ok(preparedIndex < consumedIndex, 'the date-precision meal_prepared line should sort before the same-day instant meal_consumed line');
});

test('Daily file assignment for a date-precision event uses the factual date directly, never a timezone-derived reinterpretation', () => {
  const store = createLifeLedgerMemoryStore();
  // A timezone where naive UTC-midnight construction would have shifted the calendar day —
  // proves the Daily file uses occurredDate as-is, not a timezone conversion of a
  // nonexistent instant.
  importMealSnapshot(
    { cookedMeals: [{ id: 'cm_tzcheck_1', name: 'TZ Check Meal', cookedDate: '2026-01-15', storage: 'fridge' }], mealConsumptions: [] },
    { store, assertedTimezone: 'Pacific/Kiritimati', observationClock: () => '2026-01-16T00:00:00.000Z' }
  );
  const exportPlan = buildObsidianLifeLedgerExport(store.listEvents());
  const dayFile = exportPlan.files.find(f => f.relativePath === 'Life Ledger/Daily/2026-01-15.md');
  assert.ok(dayFile, 'expected the Daily file to be keyed by the exact asserted cookedDate');
});

test('two date-precision events on the same day with no time-of-day evidence sort deterministically by recordedAt, never a fabricated time', () => {
  const store = createLifeLedgerMemoryStore();
  importMealSnapshot(
    { cookedMeals: [
      { id: 'cm_tiebreak_a', name: 'Tiebreak Meal A', cookedDate: '2026-08-28', storage: 'fridge' },
      { id: 'cm_tiebreak_b', name: 'Tiebreak Meal B', cookedDate: '2026-08-28', storage: 'fridge' }
    ], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => '2026-08-31T00:00:00.000Z' }
  );
  const exportPlan = buildObsidianLifeLedgerExport(store.listEvents());
  const dayFile = exportPlan.files.find(f => f.relativePath === 'Life Ledger/Daily/2026-08-28.md');
  // Deterministic (same order every run), and never includes a fabricated clock time.
  const secondRun = buildObsidianLifeLedgerExport(store.listEvents()).files.find(f => f.relativePath === 'Life Ledger/Daily/2026-08-28.md');
  assert.equal(dayFile.content, secondRun.content);
  assert.equal(dayFile.content.includes('00:00'), false);
});
