# WORKOUT_LEDGER_SOURCE_CONTRACT_V1

Status: **ACTIVE**
Adapter: [`workout-life-ledger-adapter.js`](../workout-life-ledger-adapter.js) (`WORKOUT_LIFE_LEDGER_ADAPTER_VERSION = 'opengym-workout-v1'`)
Source app: openGym / LongevityWork fork (`shinyamadasan/LongevityWork`, upstream `alexpcosta/opengym`)
Source verified against: `openGym-longevity` commit `375959ffb8f212874c632e23b89e14699f6cf3f2` (branch `main`), files
`frontend/src/sheets.jsx` (`doFinishWorkout`, `SessionRating`), `frontend/src/store/useStore.js` (`DEF`, `persist`),
`frontend/src/lib/import-csv.js` (`parseWorkoutCSV`).

## Purpose

This document is the **stable factual interface** the Workout → Life Ledger adapter depends on. It is not
documentation of openGym as an application. openGym's UI, routing, coaching features, athletic-profile screens,
etc. can change freely without touching this contract. Only the fields and behaviors listed below are load-bearing
for `normalizeWorkoutCompleted` / `normalizeWorkoutBackup` / `importWorkoutBackup`.

**If a future openGym change would violate a REQUIRED or FORBIDDEN clause below, the compatibility gate
(`frontend/src/lib/workout-ledger-source-contract.test.js` in the openGym-longevity repo, and
`workout-source-contract-gate.test.js` in this repo) must fail before that change reaches the Life Ledger
integration.** Update this document and the adapter together, as an explicit version bump, if the break is
intentional.

## 1. Transport shape

- The whole persisted app state (`localStorage['gym_state_v1']`, and the identical shape returned by
  `GET /api/data` / accepted by the backup import path) is the **backup object** the adapter reads.
- **REQUIRED**: `backup.workouts` is an array. Each element is one **completed** workout.
- **REQUIRED**: `backup._ts` (a `Date.now()` epoch-milliseconds number) is state-level snapshot metadata, stamped by
  `persist()` on every local write. It is **not** attached to any individual workout and proves nothing about when
  any one workout happened.
- **FORBIDDEN / SEMANTICALLY DANGEROUS**: treating `backup._ts` as a per-workout revision/version number. It is a
  whole-snapshot timestamp; a workout with a higher enclosing `_ts` is not "newer" in any sense the adapter (or the
  Ledger) can trust. The adapter never reads it for conflict resolution — only as inert `provenance.sourceStateTimestamp`.
- **REQUIRED**: `backup.unit` (`'kg' | 'lb'`) is a single **global, current** unit for the whole profile. It is not
  historical and does not travel with any individual workout record.
- **FORBIDDEN / SEMANTICALLY DANGEROUS**: inferring a workout's historical unit from the *current* `backup.unit`.
  A profile that switches kg↔lb does not retroactively convert `w.entries[].sets[].w` on already-completed workouts,
  so old numeric loads under a new global unit read as a different real quantity. The adapter never assumes a unit;
  callers must supply `context.assertedWeightUnit` explicitly per import, and its absence is a valid, honestly-labeled
  `authority: 'unknown'` state on the resulting event — never a silent conversion.

## 2. Completed workout identity

- **REQUIRED**: every element of `backup.workouts[]` has a stable, source-owned `id` (string). This is the sole
  source-of-truth entity id (`sourceEntityId`); the adapter never generates or infers one.
- Two id shapes exist and are both valid:
  - **native**: opaque `uid()` string, produced by `doFinishWorkout()` when a live session in `S.active` finishes.
  - **`iw`-prefixed**: `'iw' + uid()`, produced only by `parseWorkoutCSV()` (the CSV import path).
- **REQUIRED**: an `iw`-prefixed id is recognized ONLY as "shape/ID compatible with the CSV import path" —
  `recordCategory: 'csv_import_path_compatible'`. **FORBIDDEN**: treating the `iw` prefix as proof the record
  actually went through that importer. Arbitrary JSON handed to the adapter can imitate the prefix; the adapter's
  own confidence score and `basis` text must never overclaim this beyond "validated-supplied-backup-record".
- **REQUIRED**: a duplicate `id` within one physical import batch is never resolved by array order. Same id + same
  canonical facts collapses to one accepted record (`status: 'duplicate'`); same id + different canonical facts is
  a `conflicting_duplicate_workout_id` rejection for every physical record sharing that id (`status: 'conflict'`).

## 3. Completed-history semantics / active-session exclusion

- **REQUIRED**: a workout in `S.active` (the in-progress session) is a **completely separate top-level field**,
  never present in `backup.workouts[]`. `doFinishWorkout()` is the only code path that pushes into `s.workouts` —
  it does so in the same store update that sets `s.active = null`. There is no state in which an active session
  is readable from the array the adapter consumes.
- **REQUIRED**: `normalizeWorkoutCompleted` and `normalizeWorkoutBackup` only ever read `backup.workouts[]`. An
  in-progress session is structurally invisible to the adapter, not merely filtered by a status flag — there is no
  status flag on a workout record; presence in the array itself is completion.
- **FORBIDDEN / SEMANTICALLY DANGEROUS**: any future openGym change that starts writing in-progress state into
  `S.workouts[]` (e.g. an "autosave draft workouts" feature) without a new, explicit way to distinguish it. That
  would silently promote an incomplete session to Ledger `workout_completed` history.

## 4. Timestamps: start / end / local date

- **REQUIRED**: `workout.start` and `workout.end` are epoch-millisecond numbers (`Date.now()`-based). `start` is
  stamped when the session begins (`sheets.jsx`: `start: Date.now()` in `startFlow`); `end` is stamped at finish
  time (`end: Date.now()`) or, for CSV-imported rows, from the parsed timestamp.
- **REQUIRED**: `end >= start` always. The adapter rejects `end < start` as `invalid_workout_interval`.
- **REQUIRED / dangerous-if-missed**: **equal-time unknown-duration semantics.** `parseWorkoutCSV()` sets
  `end: end > start ? end : start` — when the source CSV row carries no distinct end time, `end` collapses to
  exactly `start`, producing a **real, valid, zero-length interval**, not a sentinel or an error. The adapter must
  treat `endedAtMs === startedAtMs` as "duration unknown", not "workout took zero minutes":
  `durationStatus: 'unknown'` for `csv_import_path_compatible` records, `'zero-or-unknown'` for native ones (a native
  same-millisecond finish is vanishingly unlikely but not impossible), and `payload.durationMinutes` is omitted
  entirely (never published as `0`) whenever `endedAtMs === startedAtMs`.
- **REQUIRED**: `workout.d` is a `YYYY-MM-DD` local-date string (openGym's own `todayISO()`/CSV-parsed date), asserted
  independently of `start`/`end`. It is published as `source.localDate` and is a separate fact from the derived
  UTC instant `occurredAt` — the adapter never requires them to agree on calendar day (a workout that starts before
  local midnight and ends after it is real, not a contradiction).
- **REQUIRED**: `context.assertedTimezone` (an IANA zone, validated via `Intl.DateTimeFormat`) must accompany every
  normalization call. Without it the record is rejected (`invalid_timezone_assertion`) rather than defaulting to
  UTC or the machine's local zone.

## 5. Workout / exercise / set shapes

- **REQUIRED**: `workout.name` (non-empty, ≤200 chars, control-character-safe, whitespace allowed) and
  `workout.entries` (array) are present.
- **REQUIRED**: each entry has a stable `id` (the exercise id) and a `sets` array where every element has a boolean
  `done`. Only `sets` with `done === true` are read; a workout whose every set is `done: false` ("finish anyway with
  nothing logged") is rejected as `exercise_has_no_completed_sets` for that exercise — but see §9, a whole-workout
  zero-completed-sets finish is a real, native, supported outcome at the *workout* level only when it also has no
  entries with any completed set; a mix (some exercises finished, others abandoned) drops only the abandoned ones
  at that layer, upstream of the adapter, in `doFinishWorkout`'s own `.filter(e => e.sets.some(s => s.done))`.
- **REQUIRED**: exactly one of three completed-set variants per exercise (mixing modes within one exercise across
  its completed sets is rejected as `ambiguous_set_mode`):
  - **strength/reps**: `{ w: number>=0, r: integer>=0, done: true }` → `mode: 'reps'`. `w` is a load in whatever
    unit context asserts; `r` is a repetition count (0 reps at a logged weight is valid — e.g. a failed rep).
  - **timed**: `{ sec: number>0, done: true, w?: number>=0 }` → `mode: 'time'`. `w` is optional (e.g. a loaded plank).
  - **cardio**: `{ min: number>0, done: true, speed?: number>=0 }` → `mode: 'cardio'`. `speed` (km/h) is optional.
  - Mode is inferred structurally from which of `min`/`speed` vs `sec` vs `r` keys are present — never from a
    separate declared "type" field on the set itself.
  - **OPTIONAL** per completed set: `rir` and `rpe`, each `0..10` when present (`normalizeEffort`).
- **REQUIRED**: `entry.target` (the prescription), when present, is a plain object whose `mode` (if given) must equal
  the exercise's inferred completed-set mode. **OPTIONAL** prescription fields and their published names:
  `sets→plannedSets` (int), `reps→plannedRepetitions` (int, `weight`-parallel), `weight→plannedLoad`,
  `sec→plannedSeconds`, `min→plannedMinutes`, `speed→plannedSpeedKph`, `inc→progressionIncrement`,
  `repsMin→progressionMinimumRepetitions` (int), `prog→progressionRule` (free text, ≤200 chars). A prescription is
  never required to exist, and existing without any of these sub-fields is valid (an empty target).
- **OPTIONAL**: `entry.n` (display exercise name snapshot, ≤200 chars) and `entry.topW` (top working weight for the
  exercise, `>=0`) are published verbatim as `exerciseName` / `topWeight` when present.
- **OPTIONAL**: `workout.routineId` (stable id string, when the session came from a saved routine).
- **OPTIONAL**: `workout.vol` (`workoutVolume(w)` — a derived total load×reps number, `>=0`) is published as
  `payload.volume` when present; **IGNORED** if absent (never computed by the adapter itself — it trusts the
  source's own computation or omits the fact).
- **OPTIONAL**: `workout.bw` (bodyweight at session start, `>0`, from `S.active.bw`) → `payload.bodyWeight.value`.
- **OPTIONAL**: `workout.rating` (`'easy' | 'right' | 'hard'`) and `workout.note` (≤300 chars, whitespace allowed).
  Both are written **after** initial completion by `SessionRating` (the AI-coach-gated post-workout rating sheet),
  which mutates the already-stored `w.rating` / `w.note` in place on the SAME workout record, keyed by the same
  `id`. See §8 — this is a **known, intentional** source of same-id refinement that the Ledger's immutability
  policy treats as a conflict, not a silent update.
- **OPTIONAL**: `workout.prs` — an array of exercise ids that set a personal record in this session (deduplicated,
  sorted by the adapter). **REQUIRED invariant**: every id in `prs` must also appear as a completed exercise in
  `entries` (`pr_without_completed_exercise` otherwise) — the source itself only ever appends an id to `prs` for an
  exercise it just evaluated inline in `doFinishWorkout`, so this should never legitimately fail, but it is not
  assumed.

## 6. Deletion / absence semantics

- **FORBIDDEN / SEMANTICALLY DANGEROUS**: treating a workout id's absence from `backup.workouts[]` as evidence of
  deletion, ever. openGym's "Delete workout" action (`sheets.jsx`, the `danger` button in the workout-detail sheet)
  performs a **plain, untombstoned array filter** — `s.workouts = s.workouts.filter(x => x.id !== w.id)` — and
  writes **no deletion evidence of any kind**. There is no `deletions` map, no per-workout tombstone field, nothing
  distinguishing "the user deleted this" from "this device's backup is merely older/incomplete" or "this was never
  synced here."
  - This is *why* `WORKOUT_LIFE_LEDGER_CAPABILITIES.deletion` is `'unsupported-without-explicit-source-evidence'`
    and always will be, unless openGym itself adds a real tombstone mechanism for workouts (it currently has none —
    contrast with Meal's `deletions.cookedMeals` map, §6 of the Meal contract).
  - A compatibility-gate test that "deletes" a workout and expects it to disappear from Ledger history on next
    import represents a misunderstanding of the source, not a real openGym behavior to support.

## 7. Import / batch semantics

- **REQUIRED**: `normalizeWorkoutBackup` requires an injected `context.observationClock` function; `observedAt` is
  never derived from `backup._ts` or wall-clock `Date.now()` read directly inside the adapter. A batch missing this,
  or an invalid/missing timezone/unit assertion, fails the **entire batch** (`fatal: true`) with one indexed
  `'invalid'` outcome per physical record — it never partially validates records against a context that itself
  never passed its own gate.
- **REQUIRED**: one explicit `outcome` per physical input record (`invalid` / `conflict` / `duplicate` / `accepted`),
  indexed positionally — no physical record is ever silently dropped from the outcome accounting.
- **REQUIRED**: grouping/dedup within a batch is decided on the **canonical factual serialization**
  (`serializeLifeLedgerFacts`), never on the 32-bit FNV-1a fingerprint alone — a confirmed-reproducible fingerprint
  collision between two genuinely different canonical facts must never be treated as "the same record."

## 8. Correction / conflict semantics

- **REQUIRED**: `workout_completed` is immutable after first acceptance. An exact-canonical-facts retry (same id,
  identical published facts) is an idempotent no-op. A same-id record with **any** changed published fact — including
  a rating/note added after the fact by `SessionRating` (§5) — is an explicit `immutable_workout_conflict`, never a
  silent revision, and never resolved by a higher enclosing `backup._ts` (§1 already forbids treating `_ts` as a
  revision marker; this is the concrete consequence).
- **REQUIRED**: restore is unsupported. Because there is no deletion evidence for workouts (§6), there is also
  nothing to "restore" — this capability is symmetric with deletion for exactly that reason.

## 9. Explicit classification summary

| Field / behavior | Classification |
|---|---|
| `backup.workouts[]` is an array; each has stable `id` | REQUIRED |
| `id` is the sole identity; `iw` prefix ⇒ CSV-shape-compatible only | REQUIRED |
| `backup._ts` as inert snapshot metadata | REQUIRED (as non-causal) |
| `backup._ts` as per-workout revision/version | **FORBIDDEN** |
| `backup.unit` as current global unit | REQUIRED |
| `backup.unit` applied retroactively to historical loads | **FORBIDDEN** |
| `S.active` excluded from `backup.workouts[]` | REQUIRED |
| `start`/`end` epoch ms, `end >= start` | REQUIRED |
| `end === start` ⇒ unknown/zero duration, never `durationMinutes: 0` | REQUIRED |
| `d` local date, independent fact from `start`/`end` | REQUIRED |
| strength / timed / cardio set variants (§5) | REQUIRED (one of three) |
| `rir` / `rpe` per set | OPTIONAL |
| `target` prescription sub-fields | OPTIONAL |
| `topW`, `n` (exercise name) | OPTIONAL |
| `routineId` | OPTIONAL |
| `vol` | OPTIONAL, IGNORED if absent |
| `bw` | OPTIONAL |
| `rating`, `note` (post-hoc mutable by source) | OPTIONAL, and a documented conflict source (§8) |
| `prs` (must reference a completed exercise) | OPTIONAL, invariant-checked |
| absence from `workouts[]` ⇒ deletion | **FORBIDDEN** |
| same-id changed facts ⇒ silent revision | **FORBIDDEN** |
| restore without new explicit source evidence | **FORBIDDEN** |

## 10. What this contract explicitly does NOT cover

Routine/plan editing, the coach feature, athletic-profile screens, bodyweight logging, cardio field tests,
progression-engine internals (`nextPrescription`), CSV import UI/parsing details beyond the shape it hands the
adapter, and any purely visual/UI state. None of these are read by the adapter; changes there cannot break this
contract and are explicitly **benign** (see the compatibility gate's benign-change tests).
