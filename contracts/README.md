# Life Ledger source contracts

**If you are changing Meal or openGym in a way that touches anything a cookedMeal, mealConsumption, or completed
workout record looks like — read this first.**

This directory is the compatibility boundary between each source app and Life Ledger. It exists so that ordinary
Meal/openGym feature work does not require remembering hidden Life Ledger assumptions: a contract-breaking change
should fail an automated gate, with a message that says what broke, before it ever reaches production data.

| Document | Covers |
|---|---|
| [`WORKOUT_LEDGER_SOURCE_CONTRACT_V1.md`](./WORKOUT_LEDGER_SOURCE_CONTRACT_V1.md) | openGym → `workout-life-ledger-adapter.js` |
| [`MEAL_LEDGER_SOURCE_CONTRACT_V1.md`](./MEAL_LEDGER_SOURCE_CONTRACT_V1.md) | Meal → `meal-life-ledger-adapter.js` |
| [`CONTRACT_VERSIONING.md`](./CONTRACT_VERSIONING.md) | What "V1" means, and what happens on a V2 |

## The gate, end to end

```
source app change
      │
      ▼
source-side compatibility gate            (runs IN the source repo, on real source code)
  openGym-longevity: npm --prefix frontend run test:ledger-contract
  Meal:              npm run test:ledger-contract
      │  pass
      ▼
adapter contract gate                     (runs IN this repo, against fixtures + hand-built cases)
  npm run test:adapter-contracts
      │  pass
      ▼
cross-repo compatibility check            (runs IN this repo, orchestrates all of the above)
  npm run test:cross-repo-compat
      │  pass
      ▼
safe to integrate / merge
```

A failure at any stage names the specific contract clause it violates (see each contract's numbered sections) —
never a bare assertion failure. If you hit one and the change is intentional, see `CONTRACT_VERSIONING.md` for how
to move the contract forward instead of silencing the gate.

## Fixtures

`../fixtures/workout-source-contract-v1.fixture.json` and `../fixtures/meal-source-contract-v1.fixture.json` are
checked-in, versioned, deterministic snapshots of real source output shapes. They are regenerated only by an
explicit `npm run fixture:update:*` command (see `../scripts/`), never by a normal test run — normal test runs must
leave `git status` clean. See `CONTRACT_VERSIONING.md` §"Fixture provenance and change detection".

## Scope discipline

This is a **factual-interface** boundary, not application documentation. If you're touching UI, routing, pantry,
recipes, coaching, athletic-profile screens, or anything else the two contract documents explicitly list under
"what this contract does NOT cover" — you don't need to update anything here. If you're touching an identity field,
a timestamp's meaning, a deletion/tombstone path, a schema's field set, or a merge/conflict rule — you do.
