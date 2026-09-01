// ── Compatibility gate: "Does current Meal still satisfy MEAL_LEDGER_SOURCE_CONTRACT_V1?" ──
//
// This is the adapter-side half of the gate; the source-side half lives in the Meal repo at
// tests/ledger-source-contract.spec.js. See contracts/MEAL_LEDGER_SOURCE_CONTRACT_V1.md for the
// numbered clauses every test below is anchored to. meal-cross-repo-life-ledger.test.js already
// proves the happy path end-to-end against real captured output; this file adds the adversarial
// half (chaos/mutation) and the benign-change half that file doesn't cover.
//
// Run in isolation: `npm run test:meal-source-gate`.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeMealConsumed,
  normalizeMealPrepared,
  normalizeMealSnapshot
} from './meal-life-ledger-adapter.js';
import { resolveMealFixture } from './fixtures/resolve-fixture.js';

const resolved = resolveMealFixture();
console.log(`\nmeal-source-contract-gate.test.js: using fixture from ${resolved.source || 'NONE'} (${resolved.path || resolved.reason})`);
const fixture = resolved.fixture;
const skip = !fixture;

const TZ = 'America/Phoenix';
const ctx = { assertedTimezone: TZ, observedAt: '2026-09-01T06:20:00.000Z' };

function clone(value) { return JSON.parse(JSON.stringify(value)); }

console.log('\nMeal source contract V1 — compatibility gate');

test('§2: the real cooked-meal fixture normalizes cleanly with date precision and no leaked current-state fields', { skip }, () => {
  const meal = fixture.cookedMeals[0];
  const result = normalizeMealPrepared(meal, ctx);
  assert.equal(result.ok, true, `Meal source contract V1 broken: ${JSON.stringify(result)}`);
  assert.equal('occurredAt' in result.draft, false, 'Meal source contract V1 broken: meal_prepared must never carry occurredAt (date precision only)');
  assert.equal(JSON.stringify(result.draft).includes('portionsRemaining'), false, 'Meal source contract V1 broken: current-state field portionsRemaining must never leak into the published fact');
  assert.equal(JSON.stringify(result.draft.payload).includes('storage'), false, 'Meal source contract V1 broken: current-state field storage must never leak into the published fact');
});

test('§3: the real consumption fixture normalizes cleanly as an instant-precision, source-recorded fact', { skip }, () => {
  const record = fixture.mealConsumptions[0];
  const result = normalizeMealConsumed(record, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.draft.confidence.basis, 'source-recorded');
  assert.equal(result.draft.confidence.score, 1);
});

test('benign: an unrelated future pantry/athletic-profile-shaped field on the snapshot is ignored, not fatal', { skip }, () => {
  const snapshot = {
    cookedMeals: clone(fixture.cookedMeals),
    mealConsumptions: clone(fixture.mealConsumptions),
    pantry: { flour: { qty: 2 } },
    athleticProfile: { ftp: 250 }
  };
  const result = normalizeMealSnapshot(snapshot, { assertedTimezone: TZ, observationClock: () => '2026-09-01T06:20:00.000Z' });
  assert.equal(result.fatal, false, 'Meal source contract V1 broken: unrelated snapshot keys must never cause a fatal rejection');
  assert.equal(result.mealPrepared.drafts.length, fixture.cookedMeals.length);
});

test('benign: an extra UI-only field on a cooked meal record does not break normalization', { skip }, () => {
  const meal = { ...clone(fixture.cookedMeals[0]), uiCardCollapsed: true, futureField: { anything: 1 } };
  const result = normalizeMealPrepared(meal, ctx);
  assert.equal(result.ok, true, `A benign extra field must never break the contract — ${JSON.stringify(result)}`);
});

// ── Chaos / mutation tests ──────────────────────────────────────────────────────────────────

test('chaos: removing cookedMeal.id (identity break) is rejected, never assigned a synthetic id', { skip }, () => {
  const mutated = clone(fixture.cookedMeals[0]);
  delete mutated.id;
  const result = normalizeMealPrepared(mutated, ctx);
  assert.equal(result.ok, false, 'Meal source contract V1 broken: a cooked meal with no id must be rejected, never assigned a fabricated one');
  assert.equal(result.reason, 'missing_source_entity_id');
});

test('chaos: renaming portionsConsumed (schema break) is rejected, not silently treated as absent/zero', { skip }, () => {
  const mutated = clone(fixture.mealConsumptions[0]);
  mutated.portions = mutated.portionsConsumed;
  delete mutated.portionsConsumed;
  const result = normalizeMealConsumed(mutated, ctx);
  assert.equal(result.ok, false, 'Meal source contract V1 broken: a renamed portionsConsumed field must be rejected, not defaulted');
  assert.equal(result.reason, 'invalid_portions_consumed');
});

test('chaos: a fractional portionsConsumed is rejected, never rounded or truncated', { skip }, () => {
  const mutated = clone(fixture.mealConsumptions[0]);
  mutated.portionsConsumed = 1.5;
  const result = normalizeMealConsumed(mutated, ctx);
  assert.equal(result.ok, false, 'Meal source contract V1 broken: a fractional portion count must be rejected, never rounded');
  assert.equal(result.reason, 'invalid_portions_consumed');
});

test('chaos: a consumption record missing cookedMealId (identity-linkage break) is rejected, not published unlinked', { skip }, () => {
  const mutated = clone(fixture.mealConsumptions[0]);
  delete mutated.cookedMealId;
  const result = normalizeMealConsumed(mutated, ctx);
  assert.equal(result.ok, false, 'Meal source contract V1 broken: a consumption record with no cookedMealId must be rejected');
  assert.equal(result.reason, 'missing_cooked_meal_id');
});

test('chaos: cookedDate meaning changing to an instant (with a time-of-day component) does not fabricate a false precision claim', { skip }, () => {
  const mutated = clone(fixture.cookedMeals[0]);
  mutated.cookedDate = '2026-08-28T14:30:00.000Z'; // an instant masquerading as a date
  const result = normalizeMealPrepared(mutated, ctx);
  assert.equal(result.ok, false, 'Meal source contract V1 broken: a non-YYYY-MM-DD cookedDate must be rejected, never truncated into a date and silently accepted');
  assert.equal(result.reason, 'invalid_cooked_date');
});

test('chaos: an impossible calendar date is rejected by real Date.UTC round-trip validation, not merely a regex', { skip }, () => {
  const mutated = clone(fixture.cookedMeals[0]);
  mutated.cookedDate = '2026-02-30';
  const result = normalizeMealPrepared(mutated, ctx);
  assert.equal(result.ok, false, 'Meal source contract V1 broken: an impossible calendar date must be rejected');
  assert.equal(result.reason, 'invalid_cooked_date');
});

test('chaos: replacing a consumption id\'s shape (non-UUID-looking string) is still accepted — the contract requires a stable id, never a specific format', { skip }, () => {
  // This is deliberately a NON-failure: MEAL_LEDGER_SOURCE_CONTRACT_V1 §3 requires `id` be
  // source-owned and stable, but never mandates the `mc_` + UUID shape at the adapter boundary
  // — that shape is a Meal-app implementation detail (generateMealConsumptionId()), not an
  // adapter-enforced format. A gate that silently started requiring UUID shape would itself be
  // an unauthorized narrowing of the contract.
  const mutated = clone(fixture.mealConsumptions[0]);
  mutated.id = 'a-perfectly-stable-but-non-uuid-id';
  const result = normalizeMealConsumed(mutated, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('chaos: a snapshot with mealConsumptions replaced by an object (realtime-shape corruption) fails fatally, not as an empty batch', { skip }, () => {
  const result = normalizeMealSnapshot(
    { cookedMeals: clone(fixture.cookedMeals), mealConsumptions: { notAnArray: true } },
    { assertedTimezone: TZ, observationClock: () => '2026-09-01T06:20:00.000Z' }
  );
  assert.equal(result.fatal, true, 'Meal source contract V1 broken: a non-array mealConsumptions must fail fatally, not silently import as zero consumptions');
  assert.equal(result.reason, 'snapshot_mealConsumptions_must_be_array');
});
