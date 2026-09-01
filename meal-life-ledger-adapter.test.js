import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLifeLedgerMemoryStore,
  fingerprintLifeLedgerEvent,
  serializeLifeLedgerFacts,
  validateLifeLedgerEvent,
  validateLifeLedgerEventDraft
} from './life-ledger-core.js';
import {
  MEAL_LIFE_LEDGER_CAPABILITIES,
  importMealSnapshot,
  normalizeMealConsumed,
  normalizeMealPrepared,
  normalizeMealSnapshot
} from './meal-life-ledger-adapter.js';

const TZ = 'America/Phoenix'; // fixed UTC-7, no DST — keeps most fixtures simple
const OBSERVED = '2026-08-31T15:00:00.000Z';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Mirrors a normalizeCookedMeal()-shaped record from Meal app.js: recipe-cooked, tracked.
function cookedMeal(overrides = {}) {
  return {
    id: 'cm_1700000000000_123',
    recipeId: 'r_42',
    name: 'Chicken Bowls',
    cookedDate: '2026-08-28',
    storage: 'fridge',
    fridgeLife: 4,
    freezerLife: 90,
    initialPortions: 3,
    portionsRemaining: 2,
    ...overrides
  };
}

// Mirrors saveManualCookedMeal(): no recipeId, explicit source, possibly backdated.
function manualCookedMeal(overrides = {}) {
  return {
    id: 'cm_1700000000000_456',
    recipeId: null,
    source: 'leftovers',
    name: 'Backdated Leftover Pork',
    cookedDate: '2026-08-20',
    storage: 'freezer',
    fridgeLife: 3,
    freezerLife: 90,
    initialPortions: null,
    portionsRemaining: null,
    ...overrides
  };
}

// Mirrors recordMealConsumption()'s append-only fact (post-redesign: crypto.randomUUID()-based
// mc_<uuid> identity — see app.js). The exact id shape does not matter to this adapter (it only
// requires a bounded, non-empty string), so fixtures keep a readable id for test clarity.
function consumption(overrides = {}) {
  return {
    id: 'mc_1700000100000_789',
    cookedMealId: 'cm_1700000000000_123',
    recipeId: 'r_42',
    mealName: 'Chicken Bowls',
    portionsConsumed: 1,
    consumedAt: '2026-08-29T18:00:00.000Z',
    ...overrides
  };
}

function ctx(overrides = {}) {
  return { assertedTimezone: TZ, observedAt: OBSERVED, ...overrides };
}

function freshStore() {
  return createLifeLedgerMemoryStore();
}

// ── normalizeMealPrepared ─────────────────────────────────────────────────────

test('a recipe-cooked meal normalizes to a valid, date-precision meal_prepared draft', () => {
  const result = normalizeMealPrepared(cookedMeal(), ctx());
  assert.equal(result.ok, true);
  assert.equal(result.draft.sourceApp, 'meal');
  assert.equal(result.draft.sourceEntityId, 'cm_1700000000000_123');
  assert.equal(result.draft.type, 'meal_prepared');
  assert.equal(result.draft.temporalPrecision, 'date');
  assert.equal(result.draft.occurredDate, '2026-08-28');
  assert.equal('occurredAt' in result.draft, false); // never a fabricated instant
  assert.equal(result.draft.payload.mealName, 'Chicken Bowls');
  assert.equal(result.draft.payload.preparedDate, '2026-08-28');
  assert.equal(result.draft.payload.portionsPrepared, 3);
  assert.equal(result.draft.payload.source.preparationKind, 'recipe');
  assert.equal(result.draft.payload.source.recipeId, 'r_42');
  // storage is deliberately never emitted — it is Meal's current, mutable fridge/freezer
  // location, not a preparation-time fact this event proves.
  assert.equal('storage' in result.draft.payload.source, false);
  // portionsRemaining is deliberately never emitted — it is a live, ever-decrementing
  // derived quantity, fully reconstructable as initialPortions minus meal_consumed
  // events, and re-publishing it here would cause a spurious meal_prepared revision on
  // every single portion eaten.
  assert.equal('portionsRemaining' in result.draft.payload, false);
  assert.equal(validateLifeLedgerEventDraft(result.draft).ok, true);
});

test('preparedDate is exactly cookedDate — never converted into a constructed instant', () => {
  // The id embeds a save-time epoch; preparedDate must ignore it and use cookedDate — the
  // source's own explicit "when this was prepared" assertion, which a backdated manual
  // entry can set to any date regardless of save time. Unlike the pre-redesign adapter,
  // there is no timezone-dependent midnight construction here at all: the factual date is
  // published as-is, and the SAME cookedDate produces the SAME preparedDate under any
  // asserted timezone.
  const phoenix = normalizeMealPrepared(cookedMeal({ cookedDate: '2026-08-28' }), ctx({ assertedTimezone: 'America/Phoenix' }));
  const manila = normalizeMealPrepared(cookedMeal({ cookedDate: '2026-08-28' }), ctx({ assertedTimezone: 'Asia/Manila' }));
  assert.equal(phoenix.draft.payload.preparedDate, '2026-08-28');
  assert.equal(manila.draft.payload.preparedDate, '2026-08-28');
  assert.equal(phoenix.draft.occurredDate, phoenix.draft.payload.preparedDate);
});

test('a backdated manual entry uses the asserted cookedDate, never the app save time', () => {
  const result = normalizeMealPrepared(manualCookedMeal({ cookedDate: '2020-01-01' }), ctx());
  assert.equal(result.ok, true);
  assert.equal(result.draft.payload.preparedDate, '2020-01-01');
  assert.equal(result.draft.payload.source.preparationKind, 'leftovers');
  assert.equal('portionsPrepared' in result.draft.payload, false); // untracked batch
});

test('an impossible cookedDate (2026-02-30) is rejected, not silently rolled over', () => {
  const result = normalizeMealPrepared(cookedMeal({ cookedDate: '2026-02-30' }), ctx());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_cooked_date');
});

test('a takeout preparationKind is preserved and a recipe-linked entry never reports takeout/leftovers', () => {
  const takeout = normalizeMealPrepared(manualCookedMeal({ source: 'takeout' }), ctx());
  assert.equal(takeout.draft.payload.source.preparationKind, 'takeout');
  const recipeBacked = normalizeMealPrepared(cookedMeal(), ctx());
  assert.equal(recipeBacked.draft.payload.source.preparationKind, 'recipe');
});

test('a legacy record with neither recipeId nor a recognized source omits preparationKind entirely', () => {
  const result = normalizeMealPrepared(cookedMeal({ recipeId: null, source: undefined }), ctx());
  assert.equal(result.ok, true);
  assert.equal('preparationKind' in result.draft.payload.source, false);
});

test('missing or malformed identity/name/date fields are rejected, not coerced', () => {
  assert.equal(normalizeMealPrepared({ ...cookedMeal(), id: '' }, ctx()).ok, false);
  assert.equal(normalizeMealPrepared({ ...cookedMeal(), id: null }, ctx()).ok, false);
  assert.equal(normalizeMealPrepared({ ...cookedMeal(), name: '' }, ctx()).ok, false);
  assert.equal(normalizeMealPrepared({ ...cookedMeal(), name: '   ' }, ctx()).ok, false);
  assert.equal(normalizeMealPrepared({ ...cookedMeal(), name: null }, ctx()).ok, false);
  assert.equal(normalizeMealPrepared({ ...cookedMeal(), cookedDate: '08/28/2026' }, ctx()).ok, false);
  assert.equal(normalizeMealPrepared({ ...cookedMeal(), cookedDate: null }, ctx()).ok, false);
  assert.equal(normalizeMealPrepared({ ...cookedMeal(), cookedDate: '2026-02-30' }, ctx()).ok, false); // not a real day
  assert.equal(normalizeMealPrepared({ ...cookedMeal(), cookedDate: '2026-13-01' }, ctx()).ok, false); // month 13
  assert.equal(normalizeMealPrepared('not-an-object', ctx()).ok, false);
  assert.equal(normalizeMealPrepared(null, ctx()).ok, false);
});

test('hostile free text in mealName is rejected on control characters, accepted otherwise', () => {
  const withControlChar = normalizeMealPrepared(cookedMeal({ name: ('Chicken' + String.fromCharCode(0) + 'Bowls') }), ctx());
  assert.equal(withControlChar.ok, false);
  const withEmoji = normalizeMealPrepared(cookedMeal({ name: '🍗 Chicken "Bowls" <script>alert(1)</script>' }), ctx());
  assert.equal(withEmoji.ok, true);
  assert.equal(withEmoji.draft.payload.mealName, '🍗 Chicken "Bowls" <script>alert(1)</script>');
  const tooLong = normalizeMealPrepared(cookedMeal({ name: 'x'.repeat(201) }), ctx());
  assert.equal(tooLong.ok, false);
});

test('an invalid or missing timezone/observedAt context is rejected', () => {
  assert.equal(normalizeMealPrepared(cookedMeal(), ctx({ assertedTimezone: 'not-a-zone' })).ok, false);
  assert.equal(normalizeMealPrepared(cookedMeal(), ctx({ assertedTimezone: null })).ok, false);
  assert.equal(normalizeMealPrepared(cookedMeal(), ctx({ observedAt: null })).ok, false);
  assert.equal(normalizeMealPrepared(cookedMeal(), ctx({ observedAt: 'garbage' })).ok, false);
});

test('malformed or out-of-range initialPortions/recipeId are rejected', () => {
  assert.equal(normalizeMealPrepared(cookedMeal({ initialPortions: 0 }), ctx()).ok, false);
  assert.equal(normalizeMealPrepared(cookedMeal({ initialPortions: -1 }), ctx()).ok, false);
  assert.equal(normalizeMealPrepared(cookedMeal({ initialPortions: 1.5 }), ctx()).ok, false);
  assert.equal(normalizeMealPrepared(cookedMeal({ initialPortions: 100 }), ctx()).ok, false); // > 99 cap
  assert.equal(normalizeMealPrepared(cookedMeal({ initialPortions: 'three' }), ctx()).ok, false);
  assert.equal(normalizeMealPrepared(cookedMeal({ initialPortions: NaN }), ctx()).ok, false);
  assert.equal(normalizeMealPrepared(cookedMeal({ initialPortions: Infinity }), ctx()).ok, false);
  assert.equal(normalizeMealPrepared(cookedMeal({ recipeId: '' }), ctx()).ok, false);
});

test('an unrecognized meal.source value is rejected rather than silently dropped', () => {
  const result = normalizeMealPrepared(manualCookedMeal({ source: 'stolen-from-a-coworker' }), ctx());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unrecognized_preparation_source');
});

// ── normalizeMealConsumed ──────────────────────────────────────────────────────

test('a consumption record normalizes to a valid, instant-precision meal_consumed draft', () => {
  const result = normalizeMealConsumed(consumption(), ctx());
  assert.equal(result.ok, true);
  assert.equal(result.draft.sourceApp, 'meal');
  assert.equal(result.draft.sourceEntityId, 'mc_1700000100000_789');
  assert.equal(result.draft.type, 'meal_consumed');
  assert.equal(result.draft.occurredAt, '2026-08-29T18:00:00.000Z');
  assert.equal(result.draft.payload.portionCount, 1);
  assert.equal(result.draft.payload.cookedMealId, 'cm_1700000000000_123');
  assert.equal(result.draft.payload.source.recipeId, 'r_42');
  assert.equal(result.draft.confidence.score, 1); // consumedAt is directly source-recorded
  assert.equal(validateLifeLedgerEventDraft(result.draft).ok, true);
});

test('cookedMealId is required — every real consumption record durably captures it', () => {
  const missing = normalizeMealConsumed(consumption({ cookedMealId: null }), ctx());
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_cooked_meal_id');
  const empty = normalizeMealConsumed(consumption({ cookedMealId: '' }), ctx());
  assert.equal(empty.ok, false);
});

test('a consumption record with no recipe linkage still normalizes (cookedMealId still required)', () => {
  const result = normalizeMealConsumed(consumption({ recipeId: null }), ctx());
  assert.equal(result.ok, true);
  assert.equal('recipeId' in result.draft.payload.source, false);
  assert.equal(result.draft.payload.cookedMealId, 'cm_1700000000000_123');
});

test('malformed, zero, negative, fractional, or oversized portionsConsumed are all rejected', () => {
  assert.equal(normalizeMealConsumed(consumption({ portionsConsumed: 0 }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed(consumption({ portionsConsumed: -1 }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed(consumption({ portionsConsumed: 0.5 }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed(consumption({ portionsConsumed: 100 }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed(consumption({ portionsConsumed: 'one' }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed(consumption({ portionsConsumed: NaN }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed(consumption({ portionsConsumed: Infinity }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed(consumption({ portionsConsumed: null }), ctx()).ok, false);
});

test('an invalid or missing consumedAt is rejected', () => {
  assert.equal(normalizeMealConsumed(consumption({ consumedAt: null }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed(consumption({ consumedAt: 'not-a-date' }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed(consumption({ consumedAt: '' }), ctx()).ok, false);
});

test('a plausible future consumedAt is accepted, not rejected outright', () => {
  // A device clock can legitimately run ahead; this adapter never second-guesses the
  // source's own captured instant, matching workout_completed's treatment of _ts.
  const result = normalizeMealConsumed(consumption({ consumedAt: '2099-01-01T00:00:00.000Z' }), ctx());
  assert.equal(result.ok, true);
  assert.equal(result.draft.occurredAt, '2099-01-01T00:00:00.000Z');
});

test('missing id or mealName on a consumption record is rejected', () => {
  assert.equal(normalizeMealConsumed(consumption({ id: '' }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed(consumption({ mealName: '' }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed(consumption({ mealName: null }), ctx()).ok, false);
  assert.equal(normalizeMealConsumed('not-an-object', ctx()).ok, false);
});

// ── normalizeMealSnapshot: batch-level fatal errors ───────────────────────────

test('fatal batch errors are reported without evaluating any record', () => {
  assert.equal(normalizeMealSnapshot('nope', {}).fatal, true);
  assert.equal(normalizeMealSnapshot({ cookedMeals: 'nope' }, {}).fatal, true);
  assert.equal(normalizeMealSnapshot({ cookedMeals: [] }, {}).reason, 'missing_observation_clock');
  assert.equal(
    normalizeMealSnapshot({ cookedMeals: [], mealConsumptions: 'nope' }, { observationClock: () => OBSERVED, assertedTimezone: TZ }).fatal,
    true
  );
  assert.equal(
    normalizeMealSnapshot({ cookedMeals: [] }, { observationClock: () => OBSERVED, assertedTimezone: 'bogus' }).reason,
    'invalid_timezone_assertion'
  );
  assert.equal(
    normalizeMealSnapshot({ cookedMeals: [] }, { observationClock: () => 'garbage', assertedTimezone: TZ }).reason,
    'invalid_observation_clock'
  );
});

test('a snapshot with no mealConsumptions key at all (a pre-wave export) defaults to an empty batch, not a fatal error', () => {
  const normalized = normalizeMealSnapshot(
    { cookedMeals: [cookedMeal()] },
    { observationClock: () => OBSERVED, assertedTimezone: TZ }
  );
  assert.equal(normalized.fatal, false);
  assert.equal(normalized.mealConsumed.drafts.length, 0);
  assert.equal(normalized.mealPrepared.drafts.length, 1);
});

// ── within-batch duplicates and conflicts ─────────────────────────────────────

test('an exact duplicate physical record is deduplicated, not double-counted', () => {
  const snapshot = { cookedMeals: [cookedMeal(), clone(cookedMeal())], mealConsumptions: [] };
  const normalized = normalizeMealSnapshot(snapshot, { observationClock: () => OBSERVED, assertedTimezone: TZ });
  assert.equal(normalized.mealPrepared.drafts.length, 1);
  assert.deepEqual(normalized.mealPrepared.outcomes.map(o => o.status), ['accepted', 'duplicate']);
});

test('two physical records sharing one cookedMealId with different facts are flagged as a conflict, never array-order-resolved', () => {
  // cookedDate is a PUBLISHED fact (unlike storage, which this redesign deliberately never
  // emits) — differing on it produces genuinely different canonical facts under the same key.
  const snapshot = {
    cookedMeals: [cookedMeal({ cookedDate: '2026-08-28' }), cookedMeal({ cookedDate: '2026-08-29' })],
    mealConsumptions: []
  };
  const normalized = normalizeMealSnapshot(snapshot, { observationClock: () => OBSERVED, assertedTimezone: TZ });
  assert.equal(normalized.mealPrepared.drafts.length, 0);
  assert.deepEqual(normalized.mealPrepared.outcomes.map(o => o.status), ['conflict', 'conflict']);
  assert.equal(normalized.mealPrepared.rejected[0].reason, 'conflicting_duplicate_source_id');
});

test('two physical records differing only by storage are treated as identical facts, since storage is never published', () => {
  // Documents the deliberate scope decision: storage is NOT part of meal_prepared's
  // canonical facts (it is Meal's current, mutable location), so two records that differ
  // ONLY by storage are genuinely the same historical preparation fact, not a conflict.
  const snapshot = {
    cookedMeals: [cookedMeal({ storage: 'fridge' }), cookedMeal({ storage: 'freezer' })],
    mealConsumptions: []
  };
  const normalized = normalizeMealSnapshot(snapshot, { observationClock: () => OBSERVED, assertedTimezone: TZ });
  assert.equal(normalized.mealPrepared.drafts.length, 1);
  assert.deepEqual(normalized.mealPrepared.outcomes.map(o => o.status), ['accepted', 'duplicate']);
});

test('a within-batch consumption id conflict is flagged the same way', () => {
  const snapshot = {
    cookedMeals: [],
    mealConsumptions: [consumption({ portionsConsumed: 1 }), consumption({ portionsConsumed: 2 })]
  };
  const normalized = normalizeMealSnapshot(snapshot, { observationClock: () => OBSERVED, assertedTimezone: TZ });
  assert.equal(normalized.mealConsumed.drafts.length, 0);
  assert.deepEqual(normalized.mealConsumed.outcomes.map(o => o.status), ['conflict', 'conflict']);
});

test('one malformed record among valid ones never drops the valid ones, and every physical index gets an outcome', () => {
  const snapshot = {
    cookedMeals: [cookedMeal(), { id: '', name: 'broken' }, manualCookedMeal({ id: 'cm_other' })],
    mealConsumptions: []
  };
  const normalized = normalizeMealSnapshot(snapshot, { observationClock: () => OBSERVED, assertedTimezone: TZ });
  assert.equal(normalized.mealPrepared.drafts.length, 2);
  assert.deepEqual(normalized.mealPrepared.outcomes.map(o => o.status), ['accepted', 'invalid', 'accepted']);
});

// ── importMealSnapshot: created / unchanged / immutable conflict ─────────────

test('a fresh import creates both a meal_prepared and a meal_consumed event', () => {
  const store = freshStore();
  const result = importMealSnapshot(
    { cookedMeals: [cookedMeal()], mealConsumptions: [consumption()] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED }
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.mealPrepared.actions[0].action, 'created');
  assert.equal(result.mealConsumed.actions[0].action, 'created');
  assert.equal(store.listEvents().length, 2);
});

test('re-importing an identical snapshot is a fully idempotent no-op', () => {
  const store = freshStore();
  const snapshot = { cookedMeals: [cookedMeal()], mealConsumptions: [consumption()] };
  importMealSnapshot(snapshot, { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  const retry = importMealSnapshot(clone(snapshot), { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:00.000Z' });
  assert.equal(retry.status, 'ok');
  assert.equal(retry.mealPrepared.actions[0].action, 'unchanged');
  assert.equal(retry.mealConsumed.actions[0].action, 'unchanged');
  assert.equal(store.listEvents().length, 2);
  assert.equal(store.listEvents()[0].revision, 1);
});

test('a changed fact on an already-accepted meal_prepared record is an immutable conflict, never a silent revision', () => {
  const store = freshStore();
  importMealSnapshot({ cookedMeals: [cookedMeal({ cookedDate: '2026-08-28' })], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  const changed = importMealSnapshot({ cookedMeals: [cookedMeal({ cookedDate: '2026-08-29' })], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:00.000Z' });
  // No action is even attempted against the store — the existing fact is never touched.
  assert.equal(changed.mealPrepared.actions.length, 0);
  assert.equal(changed.mealPrepared.conflicts.length, 1);
  assert.equal(changed.mealPrepared.conflicts[0].reason, 'immutable_meal_conflict');
  assert.equal(changed.status, 'partial');
  const stored = store.getByKey('meal:cm_1700000000000_123:meal_prepared');
  assert.equal(stored.event.revision, 1); // unchanged — never revised
  assert.equal(stored.event.payload.preparedDate, '2026-08-28'); // original fact preserved
});

test('a changed fact on an already-accepted meal_consumed record is also an immutable conflict', () => {
  const store = freshStore();
  importMealSnapshot({ cookedMeals: [], mealConsumptions: [consumption({ portionsConsumed: 1 })] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  const changed = importMealSnapshot({ cookedMeals: [], mealConsumptions: [consumption({ portionsConsumed: 2 })] },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:00.000Z' });
  assert.equal(changed.mealConsumed.actions.length, 0);
  assert.equal(changed.mealConsumed.conflicts[0].reason, 'immutable_meal_conflict');
  const stored = store.getByKey('meal:mc_1700000100000_789:meal_consumed');
  assert.equal(stored.event.revision, 1);
  assert.equal(stored.event.payload.portionCount, 1);
});

// This exact mealName pair produces a real FNV-1a 32-bit fingerprint collision through this
// adapter's own normalization pipeline (verified independently before writing this test: both
// drafts, otherwise identical, hash to fnv1a32:b301e562 — found via a direct offline search
// against the adapter's real serialization/hash output, then re-verified end-to-end through
// normalizeMealPrepared()/fingerprintLifeLedgerEvent() directly, mirroring
// workout-life-ledger-adapter.test.js's own collisionWorkout/COLLISION_NOTE precedent). It
// proves the same class of bug the architectural review described: fingerprint equality must
// never, by itself, be treated as proof that two records carry the same facts.
function collisionMeal(name) {
  return cookedMeal({ id: 'm-collision-1', name, cookedDate: '2026-08-28', recipeId: null, source: undefined, initialPortions: null });
}
const COLLISION_NAME_A = 'n2z6';
const COLLISION_NAME_B = 'nox0a';

test('two distinct mealName values produce a real fingerprint collision (sanity check for the test below)', () => {
  const draftA = normalizeMealPrepared(collisionMeal(COLLISION_NAME_A), ctx()).draft;
  const draftB = normalizeMealPrepared(collisionMeal(COLLISION_NAME_B), ctx()).draft;
  assert.notEqual(draftA.payload.mealName, draftB.payload.mealName);
  assert.equal(fingerprintLifeLedgerEvent(draftA), fingerprintLifeLedgerEvent(draftB));
  assert.equal(fingerprintLifeLedgerEvent(draftA), 'fnv1a32:b301e562');
});

test('a fingerprint collision between changed facts still produces immutable_meal_conflict, not a silent unchanged', () => {
  const store = freshStore();
  const first = importMealSnapshot({ cookedMeals: [collisionMeal(COLLISION_NAME_A)], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  assert.equal(first.status, 'ok');
  const draftA = normalizeMealPrepared(collisionMeal(COLLISION_NAME_A), ctx()).draft;
  const draftB = normalizeMealPrepared(collisionMeal(COLLISION_NAME_B), ctx()).draft;
  assert.notEqual(draftA.payload.mealName, draftB.payload.mealName);
  assert.equal(fingerprintLifeLedgerEvent(draftA), fingerprintLifeLedgerEvent(draftB));
  assert.notEqual(serializeLifeLedgerFacts(draftA), serializeLifeLedgerFacts(draftB));

  const second = importMealSnapshot({ cookedMeals: [collisionMeal(COLLISION_NAME_B)], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:00.000Z' });
  assert.equal(second.mealPrepared.actions.length, 0);
  assert.equal(second.mealPrepared.conflicts[0].reason, 'immutable_meal_conflict');
  const stored = store.getByKey('meal:m-collision-1:meal_prepared');
  assert.equal(stored.event.payload.mealName, COLLISION_NAME_A); // original never overwritten
});

test('two different consumption ids from the same cooked meal both accumulate as separate events', () => {
  const store = freshStore();
  const first = consumption({ id: 'mc_1', portionsConsumed: 1, consumedAt: '2026-08-29T12:00:00.000Z' });
  const second = consumption({ id: 'mc_2', portionsConsumed: 1, consumedAt: '2026-08-29T18:00:00.000Z' });
  const result = importMealSnapshot({ cookedMeals: [], mealConsumptions: [first, second] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  assert.equal(result.status, 'ok');
  assert.equal(store.listEvents().length, 2);
  assert.deepEqual(new Set(store.listEvents().map(e => e.sourceEntityId)), new Set(['mc_1', 'mc_2']));
});

test('duplicate/reconnect import of the same consumption never creates a second event', () => {
  const store = freshStore();
  const snap = { cookedMeals: [], mealConsumptions: [consumption()] };
  importMealSnapshot(snap, { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  importMealSnapshot(clone(snap), { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:00.000Z' });
  importMealSnapshot(clone(snap), { store, assertedTimezone: TZ, observationClock: () => '2026-09-02T00:00:00.000Z' });
  assert.equal(store.listEvents().length, 1);
  assert.equal(store.listEvents()[0].revision, 1);
});

// ── Deletion / tombstone evidence ─────────────────────────────────────────────

test('an id absent from cookedMeals AND present in the deletion map becomes a tombstone with a truthful, generic reason', () => {
  const store = freshStore();
  const created = importMealSnapshot({ cookedMeals: [cookedMeal()], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  const eventId = created.mealPrepared.actions[0].event.eventId;

  const deleted = importMealSnapshot(
    { cookedMeals: [], mealConsumptions: [], deletions: { cookedMeals: { cm_1700000000000_123: '2026-09-01T00:00:00.000Z' } } },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:01.000Z' }
  );
  assert.equal(deleted.tombstones.actions[0].action, 'tombstoned');
  const stored = store.getByKey('meal:cm_1700000000000_123:meal_prepared');
  assert.equal(stored.event.eventId, eventId);
  assert.equal(stored.event.tombstone.active, true);
  assert.equal(stored.event.tombstone.deletedAt, '2026-09-01T00:00:00.000Z');
  // Never overclaims agency ('user_delete') — the source only proves deletion occurred, not why.
  assert.equal(stored.event.tombstone.reason, 'source_marked_deleted');
  assert.equal(stored.event.payload.mealName, 'Chicken Bowls'); // facts preserved, not erased
  assert.equal(stored.event.payload.preparedDate, '2026-08-28'); // date-precision facts preserved
  assert.equal(stored.event.temporalPrecision, 'date');
  assert.equal(stored.event.revision, 2);
});

test('presence in the deletion map alone, while the record is still live in cookedMeals, is not tombstoned', () => {
  const store = freshStore();
  importMealSnapshot({ cookedMeals: [cookedMeal()], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  // A stale/reconciled tombstone entry Meal's own applyTombstones() already treated as
  // beaten by a newer edit — the record is still genuinely present.
  const result = importMealSnapshot(
    { cookedMeals: [cookedMeal()], mealConsumptions: [], deletions: { cookedMeals: { cm_1700000000000_123: '2020-01-01T00:00:00.000Z' } } },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:00.000Z' }
  );
  assert.equal(result.tombstones.actions.length, 0);
  const stored = store.getByKey('meal:cm_1700000000000_123:meal_prepared');
  assert.equal(stored.event.tombstone.active, false);
});

test('absence from cookedMeals with NO deletion map entry is never inferred as deletion', () => {
  const store = freshStore();
  importMealSnapshot({ cookedMeals: [cookedMeal()], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  const result = importMealSnapshot({ cookedMeals: [], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:00.000Z' });
  assert.equal(result.tombstones.actions.length, 0);
  const stored = store.getByKey('meal:cm_1700000000000_123:meal_prepared');
  assert.equal(stored.event.tombstone.active, false);
  assert.equal(stored.event.revision, 1);
});

test('a deletion-map id with no prior known record is reported as skipped, not fabricated', () => {
  const store = freshStore();
  const result = importMealSnapshot(
    { cookedMeals: [], mealConsumptions: [], deletions: { cookedMeals: { cm_never_seen: OBSERVED } } },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED }
  );
  assert.equal(result.status, 'partial');
  assert.equal(result.tombstones.actions.length, 0);
  assert.equal(result.tombstones.skipped[0].reason, 'tombstone_without_prior_known_record');
  assert.equal(store.getByKey('meal:cm_never_seen:meal_prepared'), null);
});

test('re-processing an already-tombstoned id is an idempotent no-op, not a second tombstone action', () => {
  const store = freshStore();
  importMealSnapshot({ cookedMeals: [cookedMeal()], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  const snapshot = { cookedMeals: [], mealConsumptions: [], deletions: { cookedMeals: { cm_1700000000000_123: '2026-09-01T00:00:00.000Z' } } };
  importMealSnapshot(snapshot, { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:01.000Z' });
  const again = importMealSnapshot(snapshot, { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:02.000Z' });
  assert.equal(again.tombstones.actions.length, 0);
  const stored = store.getByKey('meal:cm_1700000000000_123:meal_prepared');
  assert.equal(stored.event.revision, 2);
});

test('a tombstoned record reappearing live in a later snapshot is rejected, not silently resurrected', () => {
  const store = freshStore();
  importMealSnapshot({ cookedMeals: [cookedMeal()], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  importMealSnapshot(
    { cookedMeals: [], mealConsumptions: [], deletions: { cookedMeals: { cm_1700000000000_123: '2026-09-01T00:00:00.000Z' } } },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:01.000Z' }
  );
  // The id is live again with NO explicit restore evidence — this adapter never sets
  // provenance.sourceOperation = 'restore', so upsertLifeLedgerEvent() must refuse. This is
  // NOT pre-empted by the adapter's own immutable-conflict check (that check only applies
  // when the existing record is still live) — it falls through to core's restore-evidence
  // rule, exactly like before this redesign.
  const reappeared = importMealSnapshot({ cookedMeals: [cookedMeal()], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-02T00:00:00.000Z' });
  assert.equal(reappeared.mealPrepared.actions.length, 1);
  assert.equal(reappeared.mealPrepared.actions[0].action, 'rejected');
  assert.equal(reappeared.mealPrepared.actions[0].reason, 'restore_requires_explicit_evidence');
  const stored = store.getByKey('meal:cm_1700000000000_123:meal_prepared');
  assert.equal(stored.event.tombstone.active, true); // still tombstoned
});

test('a malformed deletion-map timestamp is treated as no usable evidence, not a crash or a tombstone', () => {
  const store = freshStore();
  importMealSnapshot({ cookedMeals: [cookedMeal()], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  const result = importMealSnapshot(
    { cookedMeals: [], mealConsumptions: [], deletions: { cookedMeals: { cm_1700000000000_123: 'not-a-real-timestamp' } } },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T00:00:00.000Z' }
  );
  assert.equal(result.tombstones.actions.length, 0);
  assert.equal(result.tombstones.skipped.length, 0);
});

// ── Capability constants document reality, not aspiration ────────────────────

test('capability constants match the behavior actually implemented above', () => {
  assert.equal(MEAL_LIFE_LEDGER_CAPABILITIES.meal_prepared.correction, 'immutable-after-first-acceptance; changed-same-id-is-conflict');
  assert.equal(MEAL_LIFE_LEDGER_CAPABILITIES.meal_consumed.correction, 'immutable-after-first-acceptance; changed-same-id-is-conflict');
  assert.equal(MEAL_LIFE_LEDGER_CAPABILITIES.meal_prepared.deletion, 'supported-when-source-deletion-map-present');
  assert.equal(MEAL_LIFE_LEDGER_CAPABILITIES.meal_prepared.restore, 'unsupported-without-explicit-source-evidence');
  assert.equal(MEAL_LIFE_LEDGER_CAPABILITIES.meal_consumed.deletion, 'unsupported-no-source-deletion-path');
});

// ── Fatal snapshot-level errors surface through importMealSnapshot too ────────

test('a fatal snapshot-level error surfaces as a rejected top-level status without throwing', () => {
  const store = freshStore();
  const result = importMealSnapshot('not-a-snapshot', { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  assert.equal(result.status, 'rejected');
  assert.equal(result.mealPrepared.actions.length, 0);
  assert.equal(result.mealConsumed.actions.length, 0);
});

test('importMealSnapshot requires a store with getByKey()', () => {
  assert.throws(() => importMealSnapshot({ cookedMeals: [], mealConsumptions: [] }, {}), /store with getByKey/);
});

// ── Full-event-shape parity: validateLifeLedgerEvent agrees with the adapter's own draft ──

test('a normalized meal_prepared draft, once stored, still validates as a full Life Ledger event', () => {
  const store = freshStore();
  const result = importMealSnapshot({ cookedMeals: [cookedMeal()], mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  const stored = store.getByKey(result.mealPrepared.actions[0].key);
  assert.equal(validateLifeLedgerEvent(stored.event).ok, true);
});

test('a normalized meal_consumed draft, once stored, still validates as a full Life Ledger event', () => {
  const store = freshStore();
  const result = importMealSnapshot({ cookedMeals: [], mealConsumptions: [consumption()] },
    { store, assertedTimezone: TZ, observationClock: () => OBSERVED });
  const stored = store.getByKey(result.mealConsumed.actions[0].key);
  assert.equal(validateLifeLedgerEvent(stored.event).ok, true);
});
