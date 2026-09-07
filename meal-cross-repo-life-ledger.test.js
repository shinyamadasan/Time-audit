import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createLifeLedgerMemoryStore,
  validateLifeLedgerEvent
} from './life-ledger-core.js';
import {
  LIFE_LEDGER_RUNTIME_KEY,
  createLocalLifeLedgerStore
} from './life-ledger-runtime.js';
import { buildObsidianLifeLedgerExport } from './obsidian-life-ledger-renderer.js';
import {
  importMealSnapshot,
  normalizeMealConsumed,
  normalizeMealPrepared
} from './meal-life-ledger-adapter.js';

/**
 * Cross-repo Life Ledger proof, half B (adapter side).
 *
 * Proves this adapter accepts REAL Meal cookedMeal/mealConsumption output end-to-end:
 * normalization, snapshot import, full Life Ledger event validation, and Obsidian export.
 *
 * The fixture is a committed, deterministic capture of the Meal repo's real runtime output
 * (`normalizeCookedMeals()` / `useCookedPortion()` in a real browser page), checked in at a
 * stable repo-relative path so this proof runs from a clone of THIS repo alone. It is
 * refreshed only by the explicit `npm run fixture:update` workflow (see
 * scripts/update-meal-cross-repo-fixture.mjs), which copies the Meal repo's own committed
 * fixture — an ordinary `npm test` never regenerates it, so the UUID/timestamp bytes stay
 * frozen and the assertions stay deterministic.
 *
 * This is a REQUIRED contract gate. A missing or malformed fixture FAILS the suite — it must
 * never silently skip, because a skipped cross-repo proof is indistinguishable from a broken
 * one.
 */

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'tests', 'fixtures', 'meal-cross-repo-life-ledger-fixture.json'
);

function assertLedgerShape(ledger, where) {
  assert.ok(ledger && typeof ledger === 'object' && !Array.isArray(ledger), `${where} must be an object`);
  assert.ok(Array.isArray(ledger.cookedMeals), `${where}.cookedMeals must be an array`);
  assert.ok(Array.isArray(ledger.mealConsumptions), `${where}.mealConsumptions must be an array`);
  assert.ok(ledger.deletions && typeof ledger.deletions === 'object', `${where}.deletions must be an object`);
}

function loadRequiredFixture() {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(
      `REQUIRED cross-repo fixture missing at ${FIXTURE_PATH}. ` +
      'This contract gate fails closed — it does not skip. Run `npm run fixture:update` ' +
      '(with the sibling Meal repo present) to regenerate it.'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`REQUIRED cross-repo fixture at ${FIXTURE_PATH} is not valid JSON: ${error.message}`);
  }
  assertLedgerShape(parsed, 'fixture');
  assert.equal(parsed.cookedMeals.length, 2, 'fixture must carry exactly two real cookedMeal records');
  assert.equal(parsed.mealConsumptions.length, 1, 'fixture must carry exactly one real mealConsumption record');
  assert.ok(parsed.tombstoneScenario, 'fixture must carry a tombstoneScenario');
  assertLedgerShape(parsed.tombstoneScenario.before, 'fixture.tombstoneScenario.before');
  assertLedgerShape(parsed.tombstoneScenario.after, 'fixture.tombstoneScenario.after');
  return parsed;
}

const fixture = loadRequiredFixture();

function makeMemoryStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    }
  };
}

const TZ = 'America/Phoenix';
const ctx = { assertedTimezone: TZ, observedAt: '2026-09-01T06:20:00.000Z' };

console.log('\nCross-repo: real Meal source output through the ChronaSense adapter');

test('REQUIRED contract gate: the committed cross-repo fixture is present and well-formed (fails closed, never skips)', () => {
  // loadRequiredFixture() already ran at module load and would have aborted the file if the
  // fixture were missing/malformed. This test makes the gate an explicit, visible pass/fail
  // line rather than an absence.
  assert.ok(fs.existsSync(FIXTURE_PATH));
  assert.equal(fixture.cookedMeals.length, 2);
  assert.equal(fixture.mealConsumptions.length, 1);
  assert.ok(fixture.tombstoneScenario.before && fixture.tombstoneScenario.after);
});

test('a real captured cookedMeal record normalizes to a valid date-precision meal_prepared event', () => {
  const realCookedMeal = fixture.cookedMeals[0];
  const result = normalizeMealPrepared(realCookedMeal, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.draft.temporalPrecision, 'date');
  assert.equal(result.draft.occurredDate, realCookedMeal.cookedDate);
  assert.equal('occurredAt' in result.draft, false);
  assert.equal(result.draft.payload.mealName, realCookedMeal.name);
});

test('the real untracked/manual cookedMeal record (no portion count) also normalizes cleanly', () => {
  const manualMeal = fixture.cookedMeals[1];
  const result = normalizeMealPrepared(manualMeal, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal('portionsPrepared' in result.draft.payload, false);
  assert.equal(result.draft.payload.source.preparationKind, 'leftovers');
});

test('the real useCookedPortion() output produces exactly one durable mealConsumption record', () => {
  assert.equal(fixture.mealConsumptions.length, 1);
  const realConsumption = fixture.mealConsumptions[0];
  assert.equal(realConsumption.id.indexOf('mc_'), 0);
  // crypto.randomUUID()-shaped: mc_ + 36 chars, not the old Date.now()+small-random scheme.
  assert.equal(realConsumption.id.length, 'mc_'.length + 36);
  assert.equal(realConsumption.cookedMealId, fixture.cookedMeals[0].id);
});

test('that real mealConsumption record normalizes to a valid meal_consumed event', () => {
  const realConsumption = fixture.mealConsumptions[0];
  const result = normalizeMealConsumed(realConsumption, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  // No migration branch: Meal had no durable mealConsumptions before 0c884e3, and that
  // source writer always included cookedMealId. A missing linkage remains invalid input.
  assert.equal(result.draft.payload.cookedMealId, realConsumption.cookedMealId);
  assert.equal(result.draft.payload.portionCount, realConsumption.portionsConsumed);
});

test('importMealSnapshot accepts the full real snapshot end-to-end and every stored event passes full Life Ledger validation', () => {
  const store = createLifeLedgerMemoryStore();
  const result = importMealSnapshot(
    { cookedMeals: fixture.cookedMeals, mealConsumptions: fixture.mealConsumptions, deletions: fixture.deletions },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T06:20:00.000Z' }
  );
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.mealPrepared.actions.length, 2);
  assert.equal(result.mealConsumed.actions.length, 1);
  store.listEvents().forEach((event) => {
    assert.equal(validateLifeLedgerEvent(event).ok, true, JSON.stringify(validateLifeLedgerEvent(event)));
  });
});

test('the real snapshot survives an Obsidian export with no time-of-day fabricated for the date-precision meal_prepared events', () => {
  const store = createLifeLedgerMemoryStore();
  importMealSnapshot(
    { cookedMeals: fixture.cookedMeals, mealConsumptions: fixture.mealConsumptions },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T06:20:00.000Z' }
  );
  const events = store.listEvents();
  const exportPlan = buildObsidianLifeLedgerExport(events);
  const allContent = exportPlan.files.map((f) => f.content).join('\n');
  assert.ok(allContent.includes('Prepared **Cross-Repo Chicken Bowls**'));
  assert.ok(allContent.includes('Ate **Cross-Repo Chicken Bowls**'));
  assert.equal(allContent.includes('00:00'), false);
});

test('duplicate reconnect import of the exact same real snapshot is a fully idempotent no-op', () => {
  const store = createLifeLedgerMemoryStore();
  const snapshot = { cookedMeals: fixture.cookedMeals, mealConsumptions: fixture.mealConsumptions };
  importMealSnapshot(snapshot, { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T06:20:00.000Z' });
  const before = store.listEvents().length;
  const retry = importMealSnapshot(
    JSON.parse(JSON.stringify(snapshot)),
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T06:21:00.000Z' }
  );
  assert.equal(retry.status, 'ok');
  assert.equal(retry.mealPrepared.actions.every((a) => a.action === 'unchanged'), true);
  assert.equal(retry.mealConsumed.actions.every((a) => a.action === 'unchanged'), true);
  assert.equal(store.listEvents().length, before);
});

test('local + an identical cloud-arrived copy of the real snapshot collapse to one logical fact per source record', () => {
  // Simulates: this device already imported it locally, then the "cloud" (a second,
  // structurally-identical copy of the same real snapshot) arrives and is imported again.
  const store = createLifeLedgerMemoryStore();
  const local = { cookedMeals: fixture.cookedMeals, mealConsumptions: fixture.mealConsumptions };
  const cloud = JSON.parse(JSON.stringify(local));
  importMealSnapshot(local, { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T06:20:00.000Z' });
  importMealSnapshot(cloud, { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T06:22:00.000Z' });
  assert.equal(store.listEvents().length, fixture.cookedMeals.length + fixture.mealConsumptions.length);
});

test('local + a cloud copy with the same source id but different facts produces an explicit conflict, never a silent overwrite', () => {
  const store = createLifeLedgerMemoryStore();
  importMealSnapshot(
    { cookedMeals: fixture.cookedMeals, mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T06:20:00.000Z' }
  );
  const conflicting = JSON.parse(JSON.stringify(fixture.cookedMeals));
  conflicting[0].cookedDate = '2026-08-30'; // genuinely different fact, same id
  const result = importMealSnapshot(
    { cookedMeals: conflicting, mealConsumptions: [] },
    { store, assertedTimezone: TZ, observationClock: () => '2026-09-01T06:23:00.000Z' }
  );
  assert.equal(result.status, 'partial');
  assert.equal(result.mealPrepared.conflicts.some((c) => c.sourceEntityId === fixture.cookedMeals[0].id), true);
  const stored = store.getByKey(`meal:${fixture.cookedMeals[0].id}:meal_prepared`);
  assert.equal(stored.event.payload.preparedDate, fixture.cookedMeals[0].cookedDate); // original never overwritten
});

test('a real Meal deletion fixture tombstones a runtime-stored meal_prepared event and survives reload', () => {
  const storage = makeMemoryStorage();
  const store = createLocalLifeLedgerStore({ storage, key: LIFE_LEDGER_RUNTIME_KEY });
  const before = fixture.tombstoneScenario.before;
  const after = fixture.tombstoneScenario.after;
  const deletedIds = before.cookedMeals
    .map(meal => meal.id)
    .filter(id => !after.cookedMeals.some(meal => meal.id === id));
  assert.equal(deletedIds.length, 1, 'the real source fixture must contain one cookedMeal deletion');
  const deletedId = deletedIds[0];
  assert.equal(typeof after.deletions.cookedMeals[deletedId], 'string');

  const created = importMealSnapshot(before, {
    store,
    assertedTimezone: TZ,
    observationClock: () => '2026-09-01T06:20:00.000Z'
  });
  const createdRecord = store.getByKey(`meal:${deletedId}:meal_prepared`);
  assert.equal(created.status, 'ok', JSON.stringify(created));
  assert.equal(createdRecord.event.tombstone.active, false);

  const result = importMealSnapshot(after, {
    store,
    assertedTimezone: TZ,
    observationClock: () => '2026-09-01T06:24:01.000Z'
  });
  assert.equal(result.tombstones.actions[0].action, 'tombstoned');
  const stored = store.getByKey(`meal:${deletedId}:meal_prepared`);
  assert.equal(stored.event.tombstone.active, true);
  assert.equal(stored.event.eventId, createdRecord.event.eventId);
  assert.equal(stored.event.tombstone.reason, 'source_marked_deleted'); // never overclaims user_delete
  assert.equal('occurredAt' in stored.event, false);

  const reloaded = createLocalLifeLedgerStore({ storage, key: LIFE_LEDGER_RUNTIME_KEY });
  const persisted = reloaded.getByKey(`meal:${deletedId}:meal_prepared`);
  assert.equal(persisted.event.eventId, createdRecord.event.eventId);
  assert.equal(persisted.event.tombstone.active, true);
  assert.equal(persisted.event.tombstone.reason, 'source_marked_deleted');
  assert.equal(buildObsidianLifeLedgerExport([persisted.event]).files.some(file => file.relativePath.includes('/Daily/')), false);
});
