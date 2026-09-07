# Contract versioning model

## What "V1" is

`WORKOUT_LEDGER_SOURCE_CONTRACT_V1` and `MEAL_LEDGER_SOURCE_CONTRACT_V1` are **repository/test/document contracts**,
not a field stored in production data. Neither source app is required to stamp a contract version into any record
it writes — there is no `contractVersion` field on a workout or a cookedMeal, and this phase does not add one. The
version lives in:

1. The contract document's own filename and `Status:` header (this repo, `contracts/`).
2. The adapter's existing `*_ADAPTER_VERSION` constant (`opengym-workout-v1`, `meal-v1`), already present in
   `workout-life-ledger-adapter.js` / `meal-life-ledger-adapter.js`, published into every event's
   `provenance.adapterVersion`.
3. The fixture filename (`fixtures/workout-source-contract-v1.fixture.json`, `fixtures/meal-source-contract-v1.fixture.json`).
4. `contracts/CONTRACT_FINGERPRINTS.json` — a change-detection snapshot, not a factual-equality authority (see below).

A source app never needs to *read* its own contract version at runtime. The version exists purely so a human or a
future coding agent can answer "which contract is this adapter build currently checked against?"

## What a version covers

A contract version is a snapshot of **factual interface** (identity, timestamps, deletion evidence, merge/conflict
rules, schema shape) — never of unrelated implementation detail. Two source commits can differ arbitrarily in UI,
routing, or internal architecture and still satisfy the same contract version.

## When a source change is compatible (no version bump)

- Extra/ignored fields on a source record (a new UI-only property, an unrelated pantry/athletic-profile field).
- New source variants that don't touch existing required fields (a new cardio metric alongside existing ones).
- Internal refactors that don't change any REQUIRED/FORBIDDEN clause's actual behavior.

These are exactly the "benign change" compatibility gate tests (see each repo's `*ledger-source-contract*` test
file) — a compatible change must pass the gate with **no** contract or fixture edit.

## When a source change requires a new contract version

Any change to a REQUIRED or FORBIDDEN clause in either contract document: an identity field renamed/removed, a
timestamp's meaning changing, a new legitimate deletion path appearing, a schema field's type changing, a merge
rule changing, etc.

### The V1 → V2 procedure

1. **The compatibility gate fails first.** That is the whole point of this phase — a breaking change should be
   caught before it reaches the Life Ledger integration, not discovered by a wrong assumption downstream.
2. Decide, explicitly, whether the break is intentional:
   - **Not intentional** → fix the source change (or the gate, if the gate itself was wrong) so V1 is satisfied
     again. No version bump.
   - **Intentional** → proceed to a new version.
3. Write `WORKOUT_LEDGER_SOURCE_CONTRACT_V2.md` (or `MEAL_...`) alongside V1 — do not edit V1 in place. V1's
   `Status:` header changes from `ACTIVE` to `SUPERSEDED BY V2` with a one-line pointer.
4. Add a new adapter version constant (e.g. `opengym-workout-v2`) and a new normalize/import code path, or an
   explicit branch inside the existing one keyed on a real structural signal in the source data — never an implicit
   overload of V1's behavior for two incompatible meanings of the same field.
5. Add `V2` fixtures and gate tests alongside the `V1` ones (do not delete V1's — see below).
6. **Old Life Ledger history remains valid, unconditionally.** A V2 adapter must never reinterpret, migrate, or
   re-normalize an already-stored event that was accepted under V1. If V1 and V2 disagree about what a field means,
   that disagreement is resolved by `provenance.adapterVersion` on each already-stored event, never by silently
   re-running V2's rules over V1-vintage data.
7. Retire V1 gate tests only once no source app in active development can still produce V1-shaped output — in
   practice, this will rarely happen; V1's fixtures and gate stay as a permanent regression guard for old history
   even after V2 ships, since old exported backups / old app versions in the wild can still submit V1 shapes.

## Fixture provenance and change detection

Each fixture file starts with a small provenance header (`capturedAt`, `capturedFrom` — a commit/branch note) so it
is traceable to the real source state it represents, exactly as `Meal prep app/tests/fixtures/cross-repo-life-ledger-fixture.json`
already does.

`npm run contracts:fingerprint` (see `scripts/contract-fingerprint.mjs`) computes a SHA-256 over each contract
document + its paired fixture and writes/compares against `contracts/CONTRACT_FINGERPRINTS.json`. This is
**developer tooling for change detection only** — a mismatch means "this contract or fixture changed since the
fingerprint file was last updated," prompting a human/agent to look at *why* and update the fingerprint
deliberately (`npm run contracts:fingerprint -- --write`). It is never used as a substitute for the actual factual
equality checks the gate tests perform, and it is never treated as a security control.
