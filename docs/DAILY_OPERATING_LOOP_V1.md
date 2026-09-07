# Phase 6 — Daily Operating Loop V1

Review candidate on `feat/daily-operating-loop-v1`. Base: fetched `origin/main`
`c1d9a96b22abbcefb17736f112d756e477ef8700`. No merge, push, deployment, production
Firebase write, real Obsidian write, or Meal/openGym modification.

## Product and architecture

Today answers what is available now without rebuilding a daily list. Routines are
intentions; Life Ledger and the existing Focus timeline remain factual sources.
Neither reaching a time nor manual Done creates a Ledger event. Existing day
templates are deliberately not reused: their optional auto-log path has different
semantics. Existing Today Plan, templates, and manual timeline controls remain intact.

Reused: `enterFocusMode`, `startPomodoro`, `endWorkSession`, existing timer takeover,
Learning Plan repository/model and `findNextLearningPlanStep`, existing Learning
Focus outcome/Done flow, validated `createLocalLifeLedgerStore().listEvents()`,
and the root-to-`www` runtime mirror. No timer or Learning Plan is duplicated.
The date-scoped ChronaSense adapter was inspected and remains unchanged: it selects
source records by start date. Scheduled Focus instead requires the exact completed
session receipt plus its still-present source entry, not a generic activity-name match.

## Definition and daily instance

`daily-routines-model.js` owns deterministic, injected-clock calculations.
`daily-routines-repository.js` stores a validated version-1 localStorage envelope
at `ta3-daily-routines-v1`, following the local-only Learning/Career pattern.
Firebase settings/timer sync is unchanged; scheduler data is not cloud-synced.

Definition fields: UUID `id`, `createdDate`, `title`, `enabled`, `cadence`, selected
`days` (Sunday=0), `mode`, preferred `time`, `endTime`, `cue`, `targetMinutes`,
nullable `minimumMinutes`, optional `fallback`, completion `source`, and optional
`planId` / `workoutRoutineId`. Targets are integer minutes, 1–240; minimum cannot
exceed target. No examples become data until the user saves a routine.

Daily instances are derived, not stored copies. Identity is
`JSON.stringify([routine.id, localDate])`; labels, ordering, and time edits do not
change it. Duplicate definitions collapse at generation; duplicate IDs in storage
are rejected. Daily, Monday–Friday, and selected weekdays are supported, beginning
on creation date. Disabled routines generate nothing.

A time/cue edit immediately updates today's same logical instance. Disabling hides
it, but retains assertions, links, receipts, and source facts; re-enabling can show
the same completion. Source changes retain identity and prior manual assertions,
with Undo available. Current definition thresholds/cadence/link settings are used
for derived history; this V1 does not retain definition revisions. Thus editing
those rules may change historical derived streak interpretation, without deleting
source facts or manual history. No historical schedule-audit UI is introduced.

## Scheduling and timezone

The envelope pins one explicit timezone from the app's configured timezone when
first saved. It is displayed on Today. Every scheduler date, cadence, wall-clock
comparison, fact-date selection, and Focus binding uses that same timezone. It
never uses a fact's stored display date or another implicit host timezone.
Changing app timezone later does not migrate an existing scheduler; travel/timezone
migration is deferred, avoiding silent history re-dating.

Exact: before the preferred minute = Up next; from that minute for the target
span = Now. Window: before start = Later; start-inclusive/end-exclusive = Available
now. These are soft preferences, not hard deadlines. After either span, the
routine remains available today; a fallback cue is shown as Still available.
Without fallback it moves to Anytime with explicit preferred-time-passed text.
Cue routines display their cue under Later, without asserting external detection.
Anytime routines appear under Anytime. Earliest future timed item is Next; other
future timed items are Later. Simultaneously available items can all appear in Now.

Clock calculations use zoned wall-clock parts rather than synthesizing UTC
instants with an offset guess. A spring-forward nonexistent cue becomes late/still
available after the jump. A repeated fall hour has the same instance identity;
its availability can repeat, but completion cannot double-count. Cross-midnight
windows are rejected; midnight expires incomplete intentions. Tomorrow generates
only tomorrow's normal instance, with no overdue copies.

## Completion sources

- **Manual:** Done records an explicit scheduler assertion; optional Minimum done
  records only minimum. Undo removes only that assertion. No Ledger fabrication.
- **Workout:** an active `workout_completed` event from `sourceApp: workout` on the
  scheduler date matches one eligible routine, optionally constrained by the actual
  `payload.source.routineId`. Multiple eligible routines abstain visibly. The
  setup flow rejects overlapping active source/link configurations conservatively.
  A time window is a preference, so a same-day workout outside it may complete it.
  The adapter's supplied-backup provenance is unchanged. There is **no live openGym
  connection** here: automatic completion starts when a real fact reaches this
  device's existing Ledger, not simply when another app finishes a workout.
- **Learning:** pins the actual first unfinished step by immutable plan/step IDs,
  without copying Plan state. If Today first opens after an existing same-day
  completion, it binds that factual completed step instead. A same-day completion
  keeps that step on the Done card; tomorrow surfaces the next unfinished step.
  Deleted steps can rebind; source reopening/tombstones remove automatic completion.
  A missing plan/step is reported rather than replaced by a vague study task.
  Existing `plan_step_completed` facts match the binding. Historical dates without
  a saved binding can use same-plan completion facts, subject to source ambiguity.
- **Focus:** Start launches the existing timer with the routine target. A local
  launch reference is persisted before starting. Only `endWorkSession` records a
  scheduler receipt, and matching requires its exact source entry ID, start/end,
  and duration. Opening Focus, partial exit, abandoned session, arbitrary deep-work
  entries, or unrelated Ledger events do not complete it. Same-device restored
  timer takeover retains linkage. Other-device takeover cannot carry this local
  scheduler link and is outside V1. No new generic Focus Ledger event is emitted.

Source-owned completion cannot be toggled off in Scheduler. Correct it at source.
Duplicate facts/receipts produce one completion per daily identity. A manual
assertion followed by automatic evidence yields one result, choosing the strongest
level (target, unknown-duration complete, minimum, incomplete); the assertion stays
explicit and independently undoable. Source events are never rewritten.

Known positive duration >= target = Target complete; >= minimum = Minimum complete;
below both = Incomplete. Unknown duration = Complete, never invented target/minimum.
Durations are not summed across unrelated or repeated sessions in V1. Learning's
existing step completion remains authoritative even when its reported Focus duration
is below the routine threshold; the schedule can honestly remain below minimum.

## Today, persistence, and consistency

A compact section precedes the existing activity hero: Now, Next, Later, Anytime,
Done (empty sections omitted), plus Add/Edit and collapsed Other routines for
unscheduled/disabled definitions. Manual sources get Done; Learning/Focus get
Start Focus. Workout has no redundant scheduler Done control. The form supports
all four cues and all three cadences. Scheduler hides while browsing another
Today timeline date. Existing daily-plan setup is not required by routines.

Stored state is definitions, timezone, manual assertions, daily Learning links,
one current Focus launch, and completed Focus receipts. Reads validate storage;
failed writes do not report Done or replace valid state. No destructive reset is
offered for corrupt storage. All facts are re-read on rendering; source changes
can revoke derived completion. Updates occur on Today render, storage/focus/
visibility events, and every 30 seconds while Today is visible. No background
polling service or new database. A quota failure saving a completed Focus receipt
is explicitly reported; source time survives, but scheduler completion may need
retry/recovery outside V1 if the callback cannot persist it.

Score: completed / planned, with a separate count of minimum completions. Streak:
consecutive **calendar** days completed, allowing today to remain pending until
midnight. Non-scheduled days break this deliberately simple calendar streak;
it is not a scheduled-opportunity streak, XP, or a productivity score.

Reminders are deferred. Existing Capacitor IDs and service-worker timers handle
interval pings; their cancellation/permission/retry semantics are not a safe
recurring reminder abstraction. V1 exposes time-aware states without nagging.

Responsive styling uses existing tokens, wrapping rows, 16px form inputs, a
scrollable native dialog, and only a compact short-landscape treatment for the
existing hero and Focus overlay. Headless portrait/landscape verified; physical
iOS Safari/Android usability remains an independent human check.

## Friction audit

| Typical activity | Existing activity action | Extra scheduler tracking actions |
|---|---|---:|
| Workout | Finish in openGym; existing ingestion must deliver its fact | 0 once fact arrives |
| Learning | Start real step; existing Done outcome/toggle | 0 |
| Deep Work | Start Focus; complete work session | 0 |
| Unsupported habit | Perform activity; tap scheduler Done | 1 |

Estimated extra tracking actions: **1/day**, conditional on Workout fact delivery.
There is no automatic ingestion claim; any existing backup/import effort is outside
this scheduler and can make total real-world friction higher. One-time setup and
optional corrections are not daily requirements.

## Chaos and review evidence

1. Yesterday missed: next-day generation/reload shows exactly one instance.
2. Workout completed at 18:12: actual adapter event automatically completes it.
3. Start/abandon Focus: no completion; no Workout completion from Focus.
4. Learning next changes: today keeps completed step, no duplicate; next date derives anew.
5. 20:00 -> 21:00 edit: same identity, new time immediately.
6. Disable midday: hides instance, retains manual history; re-enable restores it.
7. DST spring/fall: correct local date and one stable identity.
8. 23:59 -> 00:01 reload: one new identity and no old overdue copy.
9. Duplicate Ledger fact: one completion.
10. Manual then automatic: one result; minimum and target remain distinct.

Focused tests live in `daily-routines.test.js` and `tests/daily-routines-ui.spec.js`.
Gate totals and final git/safety checks are recorded in `TEST_REPORT.md`.

Changed files: three `daily-routines-*.js` runtime modules, `daily-routines.css`,
`index.html`, bounded `focus-mode.js` hooks, their six runtime mirrors, two test
files, `package.json`, `eslint.config.js`, this document, and context/decision/
changelog/test-report entries. No existing adapters or source contracts changed.

Highest-risk independent review targets: completion ambiguity and exact source
linkage; Learning rebinding/reopening; local-only timezone/history interpretation;
Focus outcome persistence failures and same-device takeover; physical landscape
usability. Deferred: reliable recurring notifications, live Workout ingestion,
cross-device routine sync, timezone migration, definition revision history,
multiple same-source opportunities, cross-midnight windows, and recovery of a
failed receipt write. All expressly excluded calendar/social/gamification/external
scraping features remain out of scope.
