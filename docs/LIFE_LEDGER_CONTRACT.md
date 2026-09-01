# Life Ledger V1 Contract

Phase 1 defines the contract only. It does not create storage, adapters, Firebase paths, Obsidian
writes, UI, or app changes.

Architecture principle:

> Apps record facts. Life Ledger connects them. Obsidian remembers them. Claude interprets them.

## Scope

Life Ledger V1 is an append-first event ledger that receives factual events from source apps and
exposes them for deterministic statistics, future interpretation, and one-way Obsidian memory.

V1 source apps:

- `chronasense`
- `workout`
- `meal`

V1 event types:

- `activity_logged`
- `focus_session_completed`
- `plan_step_completed`
- `workout_completed`
- `meal_prepared`
- `meal_consumed`

V1 MUST NOT add other life domains or inferred event families merely because they may be useful
later.

## Event Envelope

Every Life Ledger event MUST use this envelope:

```json
{
  "schemaVersion": 1,
  "eventId": "3f1d7f69-8b5a-4f10-b7ec-d1c45e6fba55",
  "sourceApp": "chronasense",
  "sourceEntityId": "1700000000000",
  "type": "activity_logged",
  "occurredAt": "2026-08-27T16:45:00.000Z",
  "recordedAt": "2026-08-27T16:46:03.000Z",
  "revisedAt": null,
  "sourceTimezone": "America/Phoenix",
  "payload": {},
  "provenance": {
    "source": "chronasense",
    "sourceRecordKind": "chronasense.entry",
    "adapterVersion": "chronasense-v1",
    "observedAt": "2026-08-27T16:46:03.000Z",
    "captureMethod": "timer",
    "evidence": ["chronasense.entries/1700000000000"]
  },
  "confidence": {
    "score": 1,
    "basis": "source-recorded"
  },
  "revision": 1,
  "tombstone": {
    "active": false,
    "deletedAt": null,
    "reason": null,
    "provenance": null
  }
}
```

Envelope field rules:

- `schemaVersion`: integer Life Ledger event schema compatibility version. V1 uses `1`.
- `eventId`: immutable Life Ledger UUID. It is never copied from a source app ID.
- `sourceApp`: one of the V1 source app names.
- `sourceEntityId`: the source app's existing ID, stored as a string without normalization-driven
  migration.
- `type`: one of the V1 event types.
- `occurredAt`: event occurrence instant in UTC ISO 8601. For interval events, this is the interval
  completion/end time.
- `recordedAt`: immutable UTC ISO 8601 timestamp when Life Ledger first created the logical event.
  It MUST NOT change on revision.
- `revisedAt`: UTC ISO 8601 timestamp for the latest meaningful Life Ledger revision. It MAY be
  null or absent on initial revision.
- `sourceTimezone`: IANA timezone used for local date/window semantics, such as `Asia/Manila`.
- `payload`: event-type data needed to reproduce statistics without calling an LLM.
- `provenance`: evidence trail describing where the fact came from.
- `confidence`: deterministic confidence metadata. V1 uses a `score` from `0` to `1` plus a short
  `basis`.
- `revision`: monotonic integer revision for this logical event. First write is `1`.
- `tombstone`: deletion marker. Tombstoned events remain addressable by `eventId`.

Persisted timestamps MUST be ISO 8601 instants. Local-day grouping MUST use `sourceTimezone`, not
the machine timezone at import time.

## Core Rules

1. Source apps own their facts and existing source IDs.
2. Life Ledger owns a separate immutable UUID `eventId`.
3. Logical idempotency key is `sourceApp + sourceEntityId + type`.
4. Duplicate synchronization MUST NOT create duplicate logical events.
5. Corrections MUST retain `eventId` and increment `revision` only under deterministic revision
   rules.
6. Source deletion MUST become a tombstone only when there is an explicit source deletion signal.
7. Missing evidence stays missing. Adapters MUST NOT infer or backfill facts that the source did not
   record.
8. Claude and other LLMs are not authoritative sources of facts or statistics.
9. Statistics MUST be deterministically reproducible from stored events.
10. Initial Obsidian integration is one-way from Life Ledger to Obsidian.
11. Production Obsidian writes MUST be restricted to canonical paths inside `<vault-root>/Life Ledger/`.
12. Existing source IDs MUST NOT be migrated merely for normalization.

## Ownership Boundaries

Source apps own:

- Creating, editing, deleting, restoring, and syncing their own records.
- The meaning and stability of their own `sourceEntityId`.
- Source-specific data validation.
- Source timestamps and any source-local revision, deletion, restore, or `updatedAt` metadata.

Life Ledger owns:

- Assigning and preserving immutable `eventId` values.
- Enforcing logical idempotency.
- Storing event revisions and tombstones.
- Recomputing deterministic statistics from events.
- Emitting one-way Obsidian records.

Obsidian owns:

- Human-readable memory files created from Life Ledger events.
- No source facts and no event identity.

Claude/LLMs own:

- Interpretation, summaries, questions, and hypotheses.
- No authoritative facts, no event IDs, no statistics, and no silent correction of missing evidence.

## Source ID Policy

`sourceEntityId` preserves the source app's own ID, even if the ID format is inconsistent across
sources or old/new records.

Known V1 source truth:

- ChronaSense activity records commonly use timestamp-based IDs. Preserve them.
- ChronaSense focus completions are currently commonly stored as ordinary activity/time entries,
  not as a separate durable focus source record. Preserve the entry ID and follow the focus
  double-counting rule below.
- ChronaSense daily-plan IDs are stable enough to preserve as source IDs.
- Future ChronaSense Learning Plan / Step entities should use immutable UUIDs.
- Workout completed workouts already retain a stable workout ID. Preserve it.
- Meal cooked meals have stable cooked-meal IDs. Preserve them.
- Meal consumption does not currently have an independent source record. Do not fabricate historical
  `meal_consumed` events.

Adapters MAY stringify source IDs for the envelope, but MUST NOT rewrite existing source records just
to make ID formats uniform. Numeric source ID `1700000000000` and string source ID `"1700000000000"`
must both be represented as source-owned strings in Life Ledger, scoped by `sourceApp` and `type`.

## Idempotency

The logical idempotency key is:

```text
sourceApp + ":" + sourceEntityId + ":" + type
```

When importing or syncing:

- If no event exists for the idempotency key, create a new event with a new UUID `eventId`.
- If an event exists and the normalized authoritative material is unchanged, do nothing.
- If an event exists and the normalized authoritative material changed, keep the same `eventId`,
  write a new revision, and update `revisedAt`.
- If the same source fact arrives from multiple devices, it MUST converge to one logical event.
- Adapter crash/retry MUST preserve one logical event and one `eventId`.

One source entity MAY produce more than one Life Ledger event only when the event types represent
different facts. The different `type` values keep their idempotency keys separate.

`workout_completed` is a documented exception to the "changed facts become a new revision" rule
above: see `workout_completed` > "Immutable-after-first-acceptance conflict policy" below.

## Duplicate Physical Source Records

If multiple physical source rows share the same source-owned ID, Life Ledger MUST NOT mint multiple
logical events for the same idempotency key.

Resolution rules:

- Use authoritative source-app conflict/sync rules when they are deterministic.
- Otherwise flag the conflict for review.
- Never silently select a winner by array order.
- Never generate extra `eventId` values merely because duplicate physical rows exist.
- If duplicate cleanup removes a physical row and deletion intent cannot be proven, do not create a
  tombstone for that missing row.

This is especially relevant to ChronaSense Data Doctor repairs and duplicate-ID cleanup.

## Revision Fingerprint

Revisions preserve identity through correction. `recordedAt` is immutable and does not change on
revision. `revisedAt` updates whenever a meaningful Life Ledger revision is created.

Life Ledger MUST compute a deterministic canonical normalized-event fingerprint for each import.
The fingerprint is calculated over normalized authoritative material only:

- `schemaVersion`
- `sourceApp`
- `sourceEntityId`
- `type`
- `occurredAt`
- `sourceTimezone`
- normalized statistical/factual `payload`
- normalized semantically meaningful `provenance`
- normalized semantically meaningful `confidence`
- normalized `tombstone` state

Canonical comparison semantics:

- Use stable object-key ordering.
- Remove fields that are null, absent, or contract-defined as operational-only unless their absence
  changes factual meaning.
- Normalize source IDs to their Life Ledger string representation.
- Normalize timestamps to UTC ISO 8601 instants.
- Preserve `sourceTimezone` exactly as the source context used to interpret local windows.
- Compare arrays in a contract-defined order. If order is not meaningful, sort deterministically.
- Exclude `eventId`, `recordedAt`, `revisedAt`, `revision`, `provenance.observedAt`, source sync
  stamps, download time, and adapter observation metadata.

`revision` increments only when the canonical fingerprint changes because normalized authoritative
material changed, such as:

- factual/statistical payload
- tombstone state
- factual provenance/confidence where semantically meaningful
- contract-defined normalized representation after an adapter upgrade

`revision` MUST NOT increment solely because of:

- source sync timestamps
- adapter observation time
- download time
- Firebase/local replication metadata
- ordering differences with no factual meaning
- formatting-only changes
- unrelated source metadata
- `provenance.adapterVersion` change alone
- `provenance.observedAt` change alone

V1 does not require full historical payload snapshots for every prior revision, but the storage
design should not prevent adding that later.

## Schema And Adapter Versioning

`schemaVersion` describes Life Ledger event schema compatibility.

`provenance.adapterVersion` identifies the normalization/mapping logic used by the source adapter,
for example `chronasense-v1`.

Adapter upgrade behavior:

- Adapter upgrades MUST preserve `eventId`.
- Adapter upgrades MUST preserve the logical idempotency key.
- Adapter upgrade alone MUST NOT create a second logical event.
- Adapter observation/version metadata alone MUST NOT trigger a factual revision.
- If a newer adapter legitimately changes normalized factual representation, it MAY create a new
  revision under the deterministic fingerprint rules.
- Migrations MUST be explicit and testable.

## Explicit Deletion Signals

Life Ledger MUST NOT treat simple source absence as deletion.

For ChronaSense V1, a valid explicit deletion signal includes:

- a source record with `deleted: true`
- source-owned deletion/update metadata such as `updatedAt`

The following MUST NOT create a Life Ledger tombstone by themselves:

- record missing from one synchronization snapshot
- Firebase child absence/removal observed without explicit source deletion semantics
- local absence
- network/sync failure
- partial source load
- adapter crash
- conflicting duplicate cleanup where deletion intent cannot be proven

Deletion reason/provenance MUST distinguish cases such as:

- `user_delete`: source user explicitly deleted the fact.
- `bulk_clear`: source explicitly marked many records deleted as a clear operation.
- `merge_replaced`: source explicitly replaced one or more records as part of a merge edit.
- `data_doctor_repair`: source explicitly deleted or replaced records as a data repair.

`tombstone.provenance` should include the explicit deletion marker, source record kind, source
operation, adapter version, and observed source metadata. Absence-only deletion provenance is invalid.

ChronaSense currently contains hard-delete behavior in `clearAll()` and `clearTodayOnly()`. V1
adapters cannot safely infer tombstones after those records merely disappear. If Life Ledger requires
durable deletion history for those operations, ChronaSense must later emit explicit deletion
markers/events before adapter support can claim authoritative deletion capture.

## Tombstones And Restores

Source deletion becomes a Life Ledger tombstone only with an explicit deletion signal.

Tombstone requirements:

- The event keeps its original `eventId`.
- `revision` increments when the tombstone state changes.
- `tombstone.active` becomes `true`.
- `tombstone.deletedAt` records when deletion was observed or source-recorded, according to
  tombstone provenance.
- `tombstone.reason` uses a contract-defined reason such as `user_delete`, `bulk_clear`,
  `merge_replaced`, or `data_doctor_repair`.
- Deterministic statistics MUST exclude tombstoned events unless a query explicitly asks for deleted
  history.

Restore/resurrection requirements:

- Restore uses the same logical idempotency key.
- Restore keeps the same `eventId`.
- Restore increments `revision`.
- `tombstone.active` changes back to `false` only when the source emits an explicit authoritative
  restore/live-after-delete signal.
- Simple reappearance after sync absence is not sufficient if deletion/restore intent is ambiguous.

ChronaSense undo/restore behavior can provide explicit restore evidence for future adapters when a
restored source record carries source-owned restore metadata such as `undoRestoredAt` and newer
`updatedAt`. A future adapter may use that as an authoritative restore signal, preserving the same
`eventId` and incrementing `revision`.

Silent hard deletion is not compatible with Life Ledger history. If a source hard-deletes records
before an adapter observes deletion, the missing evidence stays missing; the adapter must not invent
tombstones after the fact without a source deletion signal.

## Provenance And Confidence

`provenance` records evidence, not interpretation. It should identify the source path, source record
family, device/app mechanism when known, and any linked source IDs.

Required provenance fields:

- `source`: source app name.
- `sourceRecordKind`: source record family, such as `chronasense.entry`,
  `chronasense.plan_step`, `workout.workout`, `meal.cooked_meal`, or `meal.consumption`.
- `adapterVersion`: adapter normalization/mapping version.
- `observedAt`: UTC ISO time when the adapter observed/imported the source record.
- `evidence`: array of source paths or stable source references.

Recommended provenance fields:

- `captureMethod`: examples include `timer`, `retro_log`, `phone_usage`, `browser_usage`,
  `pomodoro`, `plan_toggle`, `workout_app`, `meal_app`.
- `sourceOperation`: examples include `create`, `update`, `delete`, `restore`, `merge`, `repair`.

`observedAt` is operational provenance only. It MUST NOT change `recordedAt` and MUST NOT cause
revision increments by itself.

`confidence.score` is deterministic:

- `1`: directly source-recorded fact.
- `0.8-0.99`: source-derived fact with complete evidence, such as imported Android usage sessions.
- `<0.8`: partial source evidence. Payload must show what is missing.
- `0`: should be rare; use only for records retained as known-missing placeholders.

LLM confidence is not accepted as factual confidence.

## Time And Timezone Semantics

For interval events such as `activity_logged`, `payload.startedAt` is the authoritative interval
start, `payload.endedAt` is the authoritative interval end, and `occurredAt` is the interval
completion/end time.

Statistics involving duration or window overlap MUST use `payload.startedAt` and `payload.endedAt`,
not `occurredAt` alone.

Timezone requirements:

- Include `sourceTimezone` when local date/window semantics matter.
- Use IANA timezone names, for example `Asia/Manila` or `America/Phoenix`.
- Local-day grouping uses `sourceTimezone`.
- Retro logs must preserve the timezone context used to interpret wall-clock input.
- DST changes and offline sync must not change the original event's interpreted local date/window.
- Importers MUST NOT rely only on the machine timezone at import time.

## Event Payloads

Payloads are intentionally source-neutral enough for deterministic statistics, but source-specific
details may be included under `source`.

### `activity_logged`

Source apps: `chronasense`.

Required payload fields:

- `activity`
- `category`
- `startedAt`
- `endedAt`
- `durationMinutes`

Optional payload fields:

- `energy`
- `onPlan`
- `project`
- `note`
- `captureMethod`
- `source`

### `focus_session_completed`

Source apps: `chronasense`.

Required payload fields:

- `activity`
- `startedAt`
- `endedAt`
- `durationMinutes`

Optional payload fields:

- `pomodoroCount`
- `phase`
- `onPlan`
- `source`
- `additiveForTimeTotals`

Focus double-counting rule:

- One source fact MUST NOT contribute the same duration twice.
- If a ChronaSense focus completion has no distinct durable source record or authoritative marker,
  it maps only to `activity_logged`.
- `focus_session_completed` MAY be emitted only when a distinct authoritative source marker/record
  exists.
- If future source metadata represents focus completion over the same interval as an activity log,
  the event MUST be marked non-additive, for example `payload.additiveForTimeTotals: false`, and its
  duration MUST be excluded from aggregate time totals.

Current ChronaSense does not yet provide a separate durable focus source record that can
authoritatively produce additive `focus_session_completed` events.

### `plan_step_completed`

Source apps: `chronasense`.

Required payload fields:

- `planDate`
- `stepLabel`
- `completedAt`

Optional payload fields:

- `plannedWhen`
- `trackedMinutes`
- `source`

The `sourceEntityId` is the stable ChronaSense plan item ID. V1 treats explicit completion as the
fact. Derived "logged minutes against this plan" remains a deterministic statistic unless the source
creates a separate completion fact.

### `workout_completed`

Source apps: `workout`. Implemented by `workout-life-ledger-adapter.js`, reading only the openGym
backup's supplied `workouts` collection.

Required payload fields:

- `workoutName`
- `startedAt`
- `endedAt`

Optional payload fields:

- `durationMinutes` (see "Optional duration" below; omitted, never fabricated, for legitimate
  unknown-duration source history)
- `exercises` (see "Exact payload shape" below)
- `volume` (non-negative number)
- `bodyWeight` (`{ value: positive number }` — no other keys)
- `rating` (`easy` | `right` | `hard`)
- `note` (bounded free text, max 300 characters)
- `source` (see "Source context" below)

`workoutName`, `exercises[]`, `payload.source`, and every nested object under them are validated
against an explicit allowlisted schema, documented field by field below — not merely type-checked
while tolerating arbitrary extra keys. Any payload key, or nested-object key, outside the lists in
this section is REJECTED, not silently ignored. This is enforced identically in
`life-ledger-core.js`'s shared `validateLifeLedgerEvent`/`Draft` (so transport and any caller inherit
it) and independently mirrored in `obsidian-life-ledger-renderer.js` (so a malformed payload handed
directly to the renderer, bypassing the adapter and core validation entirely, still fails closed).
See `test.js`'s `WORKOUT_PARITY_FIXTURES` for the canonical accept/reject matrix proving both
validators agree on every case.

`program` and a top-level `sets` field are explicitly FORBIDDEN, not merely unused: they are not
part of Workout V1 semantics (per-exercise set data lives at `exercises[].sets`), and a payload
carrying either is rejected as an unrecognized key rather than silently accepted or ignored.

The `sourceEntityId` is the existing stable completed-workout ID (openGym's `workout.id`), preserved
without normalization-driven migration, including for structurally hostile IDs.

#### Exact payload shape

`payload.exercises[]` — each entry:

| Field | Required | Type / constraint |
|---|---|---|
| `exerciseId` | yes | bounded identifier: non-empty string, ≤200 chars, no C0 control characters |
| `mode` | yes | `reps` \| `time` \| `cardio` |
| `sets` | yes | non-empty array; each entry validated per `mode` below |
| `exerciseName` | no | bounded text: non-empty string, ≤200 chars, no unsafe control characters (tab/LF/CR allowed) |
| `topWeight` | no | non-negative number |
| `personalRecord` | no | boolean |
| `prescription` | no | object, see below |

No other key is allowed on an exercise object.

`exercises[].sets[]` — allowed keys depend on `mode`; no other key is allowed on a set object:

| `mode` | Required keys | Optional keys |
|---|---|---|
| `reps` | `load` (non-negative number), `repetitions` (non-negative integer) | `rir`, `rpe` |
| `time` | `seconds` (positive number) | `load` (non-negative number), `rir`, `rpe` |
| `cardio` | `minutes` (positive number) | `speedKph` (non-negative number), `rir`, `rpe` |

`rir` and `rpe` (effort fields), when present in any mode, must be a number between `0` and `10`
inclusive.

`exercises[].prescription` (optional) — allowed keys, no others:

- `mode`: if present, must equal the parent exercise's `mode`.
- `plannedSets`, `plannedRepetitions`, `plannedLoad`, `plannedSeconds`, `plannedMinutes`,
  `plannedSpeedKph`, `progressionIncrement`, `progressionMinimumRepetitions`: each, if present, a
  non-negative number.
- `progressionRule`: if present, bounded text (≤200 chars, no unsafe control characters).

PR representation: `exercises[].personalRecord` (boolean) marks an individual exercise; the source
list of PR-worthy exercise IDs is separately carried at `payload.source.personalRecordExerciseIds`
(see "Source context" below) — both are source-supplied facts, never inferred.

`payload.bodyWeight` (optional): exactly `{ value: positive number }` — no other key is allowed.

`payload.rating` (optional): `easy` | `right` | `hard`.

`payload.note` (optional): bounded text, ≤300 chars; tab/LF/CR allowed, other C0 control characters
rejected.

`payload.volume` (optional): non-negative number.

#### Optional duration

`startedAt` and `endedAt` are both required, must each be a valid UTC ISO instant, and
`payload.endedAt` must equal the top-level `occurredAt`. `durationMinutes` is required — and must be
a positive number; `0` is not accepted merely because it is numeric — only when `endedAt` is
strictly after `startedAt`. When `endedAt === startedAt` — including openGym's own CSV-imported
history, which does not carry a real duration — the adapter omits `durationMinutes` entirely rather
than fabricating `0` or any other placeholder value, and supplying `durationMinutes` alongside a
zero interval is itself rejected as inconsistent. A negative interval (`endedAt` before `startedAt`)
always fails validation. This full time/interval contract is enforced identically by
`life-ledger-core.js`'s shared validator and by `obsidian-life-ledger-renderer.js`'s independent
guard — the renderer never falls back to `occurredAt` or any other substitute when a workout's own
timestamps are missing or invalid; it fails closed instead.

#### Immutable-after-first-acceptance conflict policy (adapter-enforced)

`workout_completed` does NOT use the general "keep `eventId`, write a new revision" correction path
described in Idempotency and Revision Fingerprint above. Instead, `importWorkoutBackup()` compares
the incoming record against any existing stored record for the same logical key BEFORE calling the
shared upsert path:

- Identical canonical factual content is an idempotent no-op (`action: 'unchanged'`).
- Changed canonical factual content for an already-accepted `sourceEntityId` is rejected as an
  explicit `immutable_workout_conflict` and never overwrites the accepted record — regardless of a
  higher, future, or newly restamped backup-level `_ts`.
- The first structurally valid record accepted for a given `sourceEntityId` wins; nothing in the
  backup can revise it after the fact.

This comparison is made against the actual canonical factual serialization (`serializeLifeLedgerFacts()`
— the same normalized representation the fingerprint is derived from), not merely against the 32-bit
FNV-1a fingerprint. The fingerprint is a fast, compact identity/change hint elsewhere in the system,
but a 32-bit hash can collide for genuinely different canonical facts — confirmed reproducible
through this adapter's own normalization pipeline — so fingerprint equality alone is never treated
as sufficient proof that two records carry the same facts, either when comparing multiple physical
rows within one backup or when comparing an incoming record against an already-accepted stored
record. This applies only within the workout adapter's own conflict/duplicate comparisons; it is not
a change to the shared fingerprint algorithm in `life-ledger-core.js`, which remains unchanged and
still useful for compact identity/change metadata elsewhere.

This is an import-time guard inside the workout adapter, not a structural invariant enforced by
`life-ledger-core.js` itself. A caller that bypasses `importWorkoutBackup()` and calls
`upsertLifeLedgerEvent()` directly with a changed-fact `workout_completed` draft would still receive
the general revision behavior (and that generic path's own duplicate-physical-input detection in
`upsertManyLifeLedgerEvents()` still compares by fingerprint only). All in-repo workout import paths
go through `importWorkoutBackup()`.

#### No `_ts` causal versioning

The backup's state-level `_ts` and `unit` fields describe the whole backup snapshot, not any
individual workout. `_ts` is retained only as optional non-causal `provenance.sourceStateTimestamp`
metadata (informational only) and never orders or authorizes corrections — a higher, lower, or
future-dated `_ts` has no effect on whether a change is accepted. The mutable global `unit` is never
read; only an explicit importer-asserted unit (see below) provides a weight-unit authority.

#### Unit assertion semantics

openGym backups store raw numeric loads with no durable per-number unit. The adapter never infers a
unit from the backup's mutable global `unit` setting. An importer MAY pass `assertedWeightUnit`
(`kg` | `lb`) as explicit import-time context; when present it is recorded as
`payload.source.weightUnitContext: { authority: 'import_assertion', unit }`. When absent, the
context is recorded as `{ authority: 'unknown' }`. Numeric loads themselves are stored as-is; the
weight-unit assertion never relabels or converts them, and changing the current global unit setting
never retroactively relabels historical loads.

#### Timezone assertion semantics

`sourceTimezone` and `payload.source.timezoneContext` both come from an explicit
`assertedTimezone` import-time context argument (a valid IANA timezone), never from `workout.d`
(the source-local calendar date) or machine timezone at import time. `payload.source.localDate`
preserves `workout.d` as a separate fact; a timezone that produces a different local calendar date
than `workout.d` is not treated as a mismatch or rejected — they are independent facts.

#### Observation-time semantics

`provenance.observedAt` comes only from an injected observation clock (`context.observationClock()`
for a batch, `context.observedAt` for a single record), never from the backup's `_ts` or any
source-embedded timestamp. This holds even when `_ts` is old, missing, or skewed into the future.

#### Source context (`payload.source`)

Every field below is validated by TYPE/enum only when present (the adapter always produces
`workoutId`, `localDate`, `recordCategory`, `recordOrigin`, `completionBasis`, `durationStatus`,
`timezoneContext`, and `weightUnitContext`; `routineId` and `personalRecordExerciseIds` are present
only when the source supplied them). No key outside this list is allowed on `payload.source`:

- `workoutId`: bounded identifier, and must equal the event's `sourceEntityId`.
- `localDate`: `workout.d`, the source-local calendar date (`YYYY-MM-DD`), as a separate fact from
  `sourceTimezone` (see above).
- `recordCategory`: exactly `workouts_collection_record` (ordinary ID) or
  `csv_import_path_compatible` (`iw`-prefixed ID). No other value is accepted.
- `recordOrigin`: exactly `indeterminate_from_backup` — the only value V1 ever produces. An importer
  cannot assert a stronger claim (e.g. `definitely_native`); any other value is rejected.
- `completionBasis`: exactly `validated-workouts-collection-membership` or
  `source-import-path-shape-compatible`. An overclaiming string (e.g. `cryptographically_verified`)
  is rejected, not accepted as free-form provenance text.
- `durationStatus`: exactly `recorded-interval`, `zero-or-unknown`, or `unknown`.
- `timezoneContext`: exactly `{ authority: 'import_assertion', timeZone: <valid IANA timezone> }` —
  no other key allowed.
- `weightUnitContext`: exactly `{ authority: 'unknown' }` (no `unit` key — `unknown` asserting a unit
  is a contradictory combination and is rejected) OR exactly
  `{ authority: 'import_assertion', unit: 'kg' | 'lb' }`. No other `authority` value is accepted.
- `routineId` (optional): bounded identifier.
- `personalRecordExerciseIds` (optional): array of bounded identifiers.

#### Provenance uncertainty (the `iw` ID prefix)

An `iw`-prefixed `sourceEntityId` means the ID's shape is compatible with openGym's CSV-import path
— it does NOT cryptographically prove that origin. Arbitrary supplied JSON can imitate an `iw`
prefix. The adapter therefore labels such records `csv_import_path_compatible`
(`recordCategory`) with `confidence.basis: 'validated-supplied-backup-record'` — the same basis used
for ordinary records — and a slightly lower `confidence.score` (`0.85` vs `0.9`) reflecting the
weaker structural certainty. It MUST NOT claim `csv_imported_history` or any other definitive,
categorical provenance label.

More generally, backup JSON cannot prove whether a structurally valid record was created natively,
restored, or injected. `recordOrigin` is therefore always `indeterminate_from_backup`.

#### Same-ID factual conflict behavior

See "Immutable-after-first-acceptance conflict policy" above. There is no merge, no "latest wins",
and no silent overwrite for a changed same-ID record — only accept-as-first, exact-retry no-op, or
explicit conflict.

#### Deletion/restore unsupported without durable source evidence

openGym backup restore/replacement copies supplied state wholesale and restamps the backup-level
`_ts`; it adds no record-level deletion or restore evidence. Consistent with "Explicit Deletion
Signals" above, `workout_completed` therefore treats a workout's absence from a backup as no
information at all — never as deletion — and never fabricates a tombstone or restore for it. Until
openGym emits an explicit durable per-record deletion/restore signal, `workout_completed` deletion
and restore both remain unsupported (`WORKOUT_LIFE_LEDGER_CAPABILITIES.deletion` /
`.restore`, both `'unsupported-without-explicit-source-evidence'`).

#### Malformed records and per-record outcomes

Both `normalizeWorkoutBackup()` and `importWorkoutBackup()` return an `outcomes` array with exactly
one entry per physical record in the input backup's `workouts` array, indexed to match physical
input order (`outcomes[i]` describes `backup.workouts[i]`), classified as one of:

- `accepted`: the batch's canonical draft for its logical key, successfully upserted (or an
  idempotent no-op retry of already-accepted facts).
- `duplicate`: an exact repeat (same key, same fingerprint) of an already-`accepted` record earlier
  in the same batch.
- `conflict`: same logical key as another record with differing facts — either within the batch
  (`conflicting_duplicate_workout_id`) or against an already-accepted stored record
  (`immutable_workout_conflict`).
- `invalid`: failed structural validation (either an individual record's shape, or — see below — a
  fatal batch/context error that prevented any record in the batch from being evaluated).
- `failed`: passed normalization and had no identity conflict, but the ledger's store-level upsert
  itself rejected the write.

One malformed, duplicate, or conflicting record never causes silent loss of any other record's
outcome in the same batch — every physical index gets an entry, and none are ever dropped.

#### Top-level import status semantics

`importWorkoutBackup()` returns a top-level `status` of exactly `ok`, `partial`, or `rejected`:

- `rejected`: a FATAL batch-level or per-record-context error prevented normalization from running at
  all. This includes: the backup itself is not a well-formed object; `backup.workouts` is not an
  array; the required observation clock or timezone assertion is missing/invalid; or the asserted
  weight unit is invalid. `actions` is `[]`. `outcomes` still carries one entry per physical record
  when the physical record count was knowable (`backup.workouts` was confirmed to be an array before
  the fatal error) — each such entry is `invalid` with the same reason as the top-level rejection, so
  the per-record accounting never falsely implies individual payload validation occurred when the
  batch context itself blocked it. When the physical record count could not be determined (the
  backup itself isn't a well-formed object, or `.workouts` isn't an array), `outcomes` is `[]`.
- `ok`: the batch was evaluated per-record and every physical record's outcome is `accepted` or
  `duplicate` — including the trivial case of zero physical records (`workouts: []`, `outcomes: []`).
- `partial`: the batch was evaluated per-record and at least one record produced `invalid`,
  `conflict`, or `failed` — regardless of whether any other record in the same batch was `accepted`.
  `status` can never report `ok` when any record's outcome is `invalid`, `conflict`, or `failed`,
  including the case where an individually-valid draft's ledger-level upsert itself was rejected
  (`failed`) — a rejected store write is never reported as unconditional success.

Concretely, for a batch that was evaluated (not fatally rejected): all-`accepted` → `ok`;
all-`accepted`-plus-some-`duplicate` → `ok`; any `invalid` present → `partial`; any `conflict`
present → `partial`; any `failed` upsert present → `partial`; all-`invalid` → `partial` (the batch
context itself was fine — every record failed its own validation, which is still a per-record
outcome, not a fatal error); all-`failed` upserts → `partial`.

Retrying an already-processed batch is idempotent: an `accepted` retry of unchanged facts resolves to
the ledger's `unchanged` action and does not change `status` to anything other than what a clean
re-evaluation would produce.

### `meal_prepared`

Source apps: `meal`.

Required payload fields:

- `mealName`
- `preparedAt`

Optional payload fields:

- `servingsPrepared`
- `portionsRemaining`
- `ingredients`
- `source`

The `sourceEntityId` is the existing stable cooked-meal ID.

### `meal_consumed`

Source apps: `meal`.

Required payload fields:

- `mealName`
- `consumedAt`
- `portionCount`

Optional payload fields:

- `cookedMealId`
- `source`

Current Meal app behavior only decrements `portionsRemaining` when the user eats one portion. It
does not create an independent consumption-history record. Therefore V1 MUST NOT fabricate
historical `meal_consumed` events from portion deltas.

Future implementation must create an append-only meal consumption record automatically when the
current eat-one-portion action occurs, with no extra user interaction. That new consumption record's
ID becomes the `sourceEntityId` for `meal_consumed`.

## Obsidian Boundary

Initial Obsidian integration is one-way:

```text
source apps -> Life Ledger -> Obsidian
```

Obsidian files are memory projections, not source records. Editing an Obsidian note MUST NOT mutate
Life Ledger events or source app records in V1.

Production Obsidian writes MUST be restricted to canonical destinations inside:

```text
<vault-root>/Life Ledger/
```

Future implementations MUST:

- Reject absolute output paths.
- Reject `..` traversal.
- Reject encoded or normalized traversal attempts.
- Canonicalize the destination path before writing.
- Verify the canonical destination remains inside `<vault-root>/Life Ledger/`.
- Reject symlink, junction, or reparse-point escapes where applicable.
- Derive generated filenames from safe IDs/slugs, never raw untrusted activity, meal, project, or
  note text.
- Never allow payload content to determine arbitrary filesystem paths.

Development or migration tooling may write elsewhere only in explicitly marked non-production
contexts.

## Deterministic Statistics

Statistics must be reproducible from stored Life Ledger events without an LLM and without reading
source apps at query time.

Requirements:

- Use latest non-tombstoned revision of each logical event.
- Exclude tombstoned events by default.
- Derive interval totals from `payload.startedAt` and `payload.endedAt`.
- Exclude non-additive events from aggregate time totals.
- Keep missing evidence absent from totals.
- Make query windows explicit.
- Use `sourceTimezone` for local-day and local-window grouping.
- Treat source-specific labels as data, not instructions.

Claude may explain statistics after deterministic code computes them. Claude may not create,
correct, or estimate the statistics.

## V1 Non-Goals

V1 does not include:

- Life Ledger storage implementation.
- Firebase schema changes.
- Source adapters.
- Obsidian write implementation.
- UI changes.
- Meal app changes.
- Workout app changes.
- Backfilling fabricated meal consumption history.
- Migrating existing ChronaSense, Workout, or Meal IDs for normalization.
- Bidirectional Obsidian sync.
- LLM-authored facts or LLM-computed authoritative statistics.
- Absence-based deletion inference.
- Additive focus statistics without distinct source evidence.

## Implementation Order

1. Add Life Ledger storage with `eventId`, idempotency key, fingerprinted revisions, tombstones,
   restores, and deterministic query helpers.
2. Add adapter test fixtures for ChronaSense, Workout, and Meal source records.
3. Implement ChronaSense adapter for `activity_logged` and `plan_step_completed`.
4. Implement ChronaSense `focus_session_completed` only after a distinct durable focus source
   marker/record exists, or mark it non-additive if it is metadata over the same interval.
5. Implement Workout adapter for `workout_completed`.
6. Add Meal adapter for `meal_prepared`.
7. Add Meal source change that writes append-only consumption records when eat-one-portion runs.
8. Implement Meal adapter for future `meal_consumed` records only.
9. Add deterministic statistics over Life Ledger events.
10. Add one-way Obsidian projection with canonical path safety inside the configured Life Ledger
   folder, with production restriction to `<vault-root>/Life Ledger/`.

## Acceptance Tests

The implementation that follows this contract should pass these acceptance tests.

Duplicate sync:

- Given the same source fact arrives twice with the same `sourceApp`, `sourceEntityId`, and `type`,
  Life Ledger stores exactly one logical event.
- Given the same ChronaSense entry arrives from two devices, the idempotency key resolves to one
  event and one `eventId`.
- Given an adapter crashes and retries the same source import, Life Ledger preserves one logical
  event and one `eventId`.

Stable identity:

- Given a ChronaSense timestamp-based entry ID, the Life Ledger `sourceEntityId` equals that source
  ID string and `eventId` is a separate UUID.
- Given numeric and string source IDs, both remain stable source-owned strings scoped by
  `sourceApp`, `sourceEntityId`, and `type`.
- Given a Workout completed-workout ID, the Life Ledger `sourceEntityId` preserves the existing
  workout ID.
- Given a Meal cooked-meal ID, the Life Ledger `sourceEntityId` preserves the existing cooked-meal
  ID.

Duplicate physical records:

- Given duplicate physical source records share one source ID, Life Ledger does not create multiple
  logical events.
- Given duplicate physical source records cannot be resolved by authoritative source rules, the
  adapter flags a conflict rather than silently selecting by array order.

Revision:

- Given a source record changes authoritative material after import, the event keeps the same
  `eventId`, increments `revision`, and updates `revisedAt`.
- Given an activity's duration changes, deterministic statistics use the latest non-tombstoned
  revision only.
- Given operational sync metadata alone changes, `revision` does not increment.
- Given only `provenance.adapterVersion` changes, Life Ledger does not create a duplicate event and
  does not automatically create a factual revision.

Tombstone and absence:

- Given a source record is deleted with an explicit source deletion signal, Life Ledger creates a
  tombstone revision instead of removing the event.
- Given a source record is absent from one sync snapshot, no tombstone is created.
- Given `clearAll()` or `clearTodayOnly()` hard-removes ChronaSense records without explicit
  deletion evidence, V1 cannot create inferred historical tombstones.
- Given a tombstoned event exists, default statistics exclude it while explicit history queries can
  still find it by `eventId`.
- Given an adapter crash, network failure, partial source load, or local absence occurs, no
  tombstone is inferred.

Merge and repair handling:

- Given a merged edit removes multiple source identities, Life Ledger does not silently lose removed
  source identities.
- Given merge-replaced IDs should become tombstones, the source must provide explicit
  `merge_replaced` semantics before tombstoning.
- Given Data Doctor physically removes duplicate-ID extras without provable deletion intent, Life
  Ledger does not infer tombstones.

Restore:

- Given a source emits an explicit restore/live-after-delete signal for the same idempotency key,
  Life Ledger reactivates the same `eventId` and increments `revision`.
- Given ChronaSense restore metadata such as `undoRestoredAt` and newer `updatedAt` is present, a
  future adapter may treat it as explicit restore evidence.

Missing evidence:

- Given historical Meal records only show decremented `portionsRemaining`, no historical
  `meal_consumed` events are created.
- Given a source fact is hard-deleted before Life Ledger observes it, the adapter does not fabricate
  the missing source fact.

Focus double counting:

- Given a ChronaSense focus interval has only an ordinary activity/time entry as source evidence, it
  maps only to `activity_logged`.
- Given a future `focus_session_completed` event is metadata over the same interval, aggregate time
  totals count the interval only once.

Obsidian write boundary:

- Given V1 writes to Obsidian, data flows from Life Ledger to Obsidian only.
- Given production Obsidian writing is enabled, writes are restricted to canonical destinations
  inside `<vault-root>/Life Ledger/`.
- Given an Obsidian note is edited manually, no source record or Life Ledger event changes in V1.
- Given a generated Obsidian path contains `../`, traversal is rejected.
- Given a generated Obsidian path is absolute, the escape is rejected.
- Given a generated Obsidian path escapes through symlink, junction, or reparse-point behavior, the
  escape is rejected where supported.

Time and timezone:

- Given a retro interval crosses DST or is imported offline later, local-day grouping remains
  deterministic from `sourceTimezone` and the original interpreted interval.
- Given an interval event is queried for window overlap, statistics use `payload.startedAt` and
  `payload.endedAt`, not `occurredAt` alone.

Reproducible statistics:

- Given a fixed set of events, the same statistic query returns the same result without LLM calls.
- Given tombstoned and non-tombstoned events, default totals include only latest non-tombstoned
  revisions.
- Given missing meal consumption evidence, meal-consumption totals do not estimate or backfill it.
- Given a non-additive focus metadata event, aggregate time totals exclude its duration.

Source isolation:

- Given two source apps use the same raw source ID, their Life Ledger events do not collide because
  `sourceApp` is part of the idempotency key.
- Given one source app edits or deletes a source record, no other source app's event changes.
- Given Obsidian or Claude produces a summary, it does not become a source fact.

## Existing ChronaSense Alignment Notes

Observed ChronaSense behavior relevant to implementation:

- `storage.js` persists entries, settings, reviews, weekly reviews, focus redemptions, and plans to
  localStorage, then syncs several collections under `rooms/{roomCode}` in Firebase.
- `syncEntries()` writes entries to Firebase under `entries/e_${e.id}` and the Firebase listener
  merges remote entries by `id` with `updatedAt` conflict resolution.
- `deleteEntry()` tombstones entries with `deleted: true` and `updatedAt`, and may tombstone
  semantic duplicates rather than only the clicked raw ID.
- `clearSelectedDay()` tombstones entries for the selected date with `deleted: true` and
  `updatedAt`.
- `clearAll()` hard-deletes local entries and removes the Firebase `entries` path.
- `clearTodayOnly()` hard-deletes today's local entries and removes corresponding Firebase children.
- Plan items are synced per date and per item ID. Removed plan items are tombstoned with
  `deleted: true`.
- Merged editing can splice/remove multiple source entries and replace them with one source entry.
- ChronaSense activity entries commonly use timestamp-derived IDs such as `Date.now()`, `tsEnd`, or
  session start timestamps. These remain valid source IDs.
- Completed focus sessions can be stored as ordinary time entries without a separate durable focus
  source record, so V1 must avoid double-counting and must not claim authoritative additive
  `focus_session_completed` events from current evidence alone.
- Scheduled template auto-logs use stable string IDs from `autoTemplateEntryId()`.
- `validateEntry()` warns when `entry.id` is not a positive number, while scheduled auto-template
  entries can use stable string IDs.
- Phone usage auto-logs use the Android session start timestamp as the entry ID and skip duplicates
  by source evidence.
- Data Doctor may physically remove duplicate-ID extras during repair.

Potential conflicts to resolve during implementation:

- `clearAll()` and `clearTodayOnly()` hard-remove entries/Firebase paths, while authoritative Life
  Ledger tombstones require explicit source deletion evidence.
- Merged entry edits need explicit source semantics before removed sub-entry IDs can become
  tombstones such as `merge_replaced`.
- Duplicate physical ChronaSense rows sharing one ID must resolve through deterministic source rules
  or be flagged for review; Life Ledger must not select by array order.
- Some ChronaSense corrections replace an entry object with the same `id`; Life Ledger should treat
  these as revisions only when the canonical normalized-event fingerprint changes.
