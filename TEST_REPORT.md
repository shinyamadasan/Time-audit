# Test Report

> **Codex writes; Claude reads.** Append-only. One entry per task run.
> Tests: `npm test` (node test.js) and Playwright. Manual: `SMOKETEST.md`.

---

## Phase 8 — Cross-Domain Intelligence / Highest-Leverage Next Action V1 — first-pass build · 2026-09-01
branch: `feat/cross-domain-intelligence-v1` (base `4857dc4d2a63c4aac4660edf8940f63c6e7f6d16`,
  == origin/main after fetch at phase start). Isolated git worktree; original `main` untouched.
suite: `npm test`; `npm run test:adapter-contracts`; `npm run lint`; strict
  `npm run test:cross-repo-compat` with `MEAL_REPO_PATH` / `OPENGYM_REPO_PATH` set; Playwright
  `smoke`, `learning-plan-ui`, `capability-career-ui`, `plan`, `life-feed-ui`,
  `life-character-sheet-ui`, and the new `cross-domain-intelligence-ui`; `node --check` on every
  new / changed `.js`; `git diff --check`; a control-byte / UTF-8 scan over every changed file.
result:
  - `npm test`: PASS. 661 model/unit tests — `test.js` 448/448; node:test suites
    workout-adapter 33, meal-adapter 45, meal-cross-repo 10, temporal-regression 20,
    life-feed-model 36, life-character-sheet-model 34 (+2 new: exposed learning ids),
    cross-domain-intelligence-model 35 (new). 0 failures, 0 skips.
  - Scenario matrix A–L: all pass. A concrete aligned learning candidate (HIGH); B a
    concrete shipping/portfolio project beats more learning, learning kept as an alternative;
    C a bare shipping stall with no project stays an attention signal and learning is
    recommended (no task invented); D no target -> learning candidate at MEDIUM; E empty
    profile -> abstain; F/G/H workout & meal never evaluated / never "you haven't ..."; I no
    focus today -> no productivity verdict; J tombstoned completion cannot create alignment;
    K duplicate candidates collapse by stable id; L deterministic tier + strength ordering.
  - Parity: `intelligence.capability.{dimensionTotals,target,nextActionKind,stalls}` equals a
    fresh `analyzeCapabilityCareer()` with the Character Sheet's own args; the recommended
    learning step is exactly `characterSheet.learning.activePlan.nextStep` (no independent
    traversal); explanation step counts equal the sheet exactly (never "5 of 10").
  - `npm run test:adapter-contracts`: PASS (workout 33, meal 45, meal-cross-repo 10, workout
    source-gate 12, meal source-gate 12, temporal 20).
  - strict `npm run test:cross-repo-compat`: PASS — all 3 legs executed and passed
    (ChronaSense adapter-contract gate, Meal source-contract gate, Workout source-contract
    gate — 29 vitest tests). No skips, exit 0.
  - `npm run lint`: 0 errors, 19 pre-existing warnings (all in index.html-extracted scripts,
    none in the two new modules).
  - Playwright: `cross-domain-intelligence-ui` 12/12, `life-character-sheet-ui` 10/10,
    `life-feed-ui` 9/9, `capability-career-ui` 8/8, `learning-plan-ui` 77/77, `plan` 27/27,
    `smoke` 64/64. Total 207/207, 0 failures.
  - `node --check` clean on all new / changed files; `git diff --check` clean (autocrlf=true,
    repo normalises to LF); control-byte / UTF-8 scan: 0 control bytes, all UTF-8 valid.
untested: no production deployment, no mobile install, no Firebase / shared-storage path, no
  Obsidian export or vault write (Phase 8 does not touch Obsidian — Phase 9), no background
  automation (Phase 10), no real end-user data. The OUTBOX main-automation race is only
  mitigated by worktree isolation so far — a fresh `origin/main` fetch + new-commit inspection
  is still required before integration. STOPPED at the independent-review checkpoint; not
  pushed, not merged, not deployed.

## Workout → Life Ledger Adapter V1 — third targeted fix pass · 2026-08-31
suite: `npm run test:workout-adapter`; `npm test`; `npx playwright test`; ESLint over the repository's
  configured production modules; `node --check` on the adapter, adapter tests, core, runtime,
  transport, renderer, CLI export script, and `test.js`; `git diff --check`; a control-byte/UTF-8
  round-trip scan over every changed file.
result: focused adapter tests passed 33/33 (3 new: a real verified FNV-1a 32-bit fingerprint collision
  between two distinct `note` values still produces `immutable_workout_conflict` — proven with the
  original event's `eventId`/revision/note unchanged, no duplicate event created, and the top-level
  `status` correctly `partial`, plus a sanity check that the collision genuinely occurs and a
  companion test proving true identical-facts retries still resolve to `unchanged`). Full Node
  regression passed 471/471 (438 ChronaSense/core/export tests, including 9 new time/interval cases
  added to the `workout_completed core/renderer validator parity matrix`, + 33 adapter tests). Full
  Playwright passed 176/176. ESLint completed with 0 errors and the same 19 pre-existing warnings
  outside the adapter/core/renderer. Syntax checks, `git diff --check`, and the control-byte scan all
  passed clean.
  Independently confirmed by direct script proof that the renderer now rejects every one of the
  reviewer's five reproduced time/interval cases (missing `endedAt`, missing `startedAt`,
  `durationMinutes: 0`, end earlier than start, `endedAt` disagreeing with top-level `occurredAt`)
  identically to the shared core, while the approved unknown-duration case (`startedAt === endedAt`,
  `durationMinutes` omitted) still renders correctly. Also independently confirmed, end to end through
  `importWorkoutBackup()`, that a genuine fingerprint collision (two distinct notes both hashing to
  `fnv1a32:9ce28ae5`) no longer causes a changed workout to be silently accepted as unchanged.
  Re-confirmed unchanged: `_ts` never orders corrections, restored backups cannot roll history
  backward, future `_ts` cannot freeze ingestion, kg/lb toggles never relabel history, `observedAt`
  comes only from the injected clock, unknown-duration history omits rather than fabricates duration,
  a missing later record never tombstones, a forged `iw`-prefixed record remains path-compatible
  provenance only, one outcome per physical record holds (including the fatal-context case), fatal
  context rejection remains `rejected`, the malformed-payload allowlists remain strict, valid mixed
  Obsidian export remains deterministic, and core validation remains scoped to `workout_completed`.
untested: unchanged from the entries below — no production deployment, mobile install, Firebase/
  shared storage, Obsidian export/write, Meal app, openGym source mutation, or real user backup
  import was exercised in this fix pass either.

## Workout → Life Ledger Adapter V1 — second targeted fix pass · 2026-08-31
suite: `npm run test:workout-adapter`; `npm test`; `npx playwright test`; ESLint over the repository's
  configured production modules; `node --check` on the adapter, adapter tests, core, runtime,
  transport, renderer, CLI export script, and `test.js`; `git diff --check`; a control-byte/UTF-8
  round-trip scan over every changed file.
result: focused adapter tests passed 30/30 (3 new: fatal batch/context rejection returning one
  `invalid` outcome per physical record for a 3-record batch, zero outcomes for a 0-record batch, and
  zero outcomes for a structurally-malformed backup). Full Node regression passed 468/468 (438
  ChronaSense/core/export tests, including the new `workout_completed core/renderer validator parity
  matrix` test covering 15 fixtures, + 30 adapter tests). Full Playwright passed 176/176. ESLint
  completed with 0 errors and the same 19 pre-existing warnings outside the adapter/core/renderer.
  Syntax checks, `git diff --check`, and the control-byte scan all passed clean.
  Confirmed by direct script proof (not just the test files) that every reviewer-reproduced case is
  now rejected identically by both `validateLifeLedgerEvent()` and `buildObsidianLifeLedgerExport()`:
  `program: {bad:true}`, a top-level `sets: "bad"`, an unknown `payload.source` key, an extra key
  inside `timezoneContext`, a contradictory `{ authority: 'unknown', unit: 'lb' }` weightUnitContext,
  an invalid `weightUnitContext.authority` enum, an overclaiming `recordOrigin`, an overclaiming
  `completionBasis`, a missing `exerciseId`, a missing `mode` paired with an invalid set, an empty
  `sets` array, an out-of-range `rir`, an invalid `prescription`, and a `bodyWeight` with an extra
  field. Also re-confirmed unchanged: higher/future/newly-restamped `_ts` cannot revise or freeze
  accepted facts, kg/lb toggles never relabel historical loads, observation time comes only from the
  injected clock, unknown-duration history is represented without fabrication, backup absence never
  implies deletion, and a forged `iw`-prefixed record is labeled shape-compatible only.
untested: unchanged from the entries below — no production deployment, mobile install, Firebase/
  shared storage, Obsidian export/write, Meal app, openGym source mutation, or real user backup
  import was exercised in this fix pass either.

## Workout → Life Ledger Adapter V1 · 2026-08-31
suite: `npm run test:workout-adapter`; `npm test`; `npx playwright test`; ESLint over the repository's
  configured production modules; `node --check` on the adapter, adapter tests, core, runtime,
  renderer, and `test.js`; `git diff --check`; source-path inspection of openGym persist, finish,
  rating/note, CSV import, backup replacement/export, deletion, reset, server pull, and native mirror.
result: focused adapter tests passed 20/20. Full Node regression passed 447/447 (427 existing/core/
  export + 20 adapter). Full Playwright passed 176/176. ESLint completed with 0 errors and the same
  19 pre-existing warnings in `focus-mode.js`, `insights.js`, and `storage.js`; changed production
  files had no warnings. Syntax checks and `git diff --check` passed. Adversarial proofs confirmed
  higher/future/newly-restamped global `_ts` cannot revise or freeze facts, unit toggles cannot relabel
  loads, observation time comes from the injected clock, unknown duration omits rather than fabricates
  duration, partial batches remain explicit/retryable, and mixed focus/plan/workout export succeeds.
  ESLint first hit sandbox `ENOTCACHED` and passed after the required approved registry retry.
untested: no production deployment, mobile install, Firebase/shared storage, Obsidian export/write,
  Meal app, openGym source mutation, or real user backup import was exercised. Deletion and restore
  remain intentionally unsupported until openGym emits explicit durable evidence. Backup-only record
  origin remains indeterminate when arbitrary/restored data matches a valid source shape.

## Workout → Life Ledger Adapter V1 — final consolidated fix pass · 2026-08-31
suite: `npm run test:workout-adapter`; `npm test`; `npx playwright test`; ESLint over the repository's
  configured production modules; `node --check` on the adapter, adapter tests, core, runtime,
  transport, renderer, CLI export script, and `test.js`; `git diff --check`.
result: focused adapter tests passed 27/27 (7 new: duplicate/conflict per-record outcomes with
  reversed order, forced ledger-upsert-rejection status, forged `iw`-prefixed record, oversized/
  control-character text and identifier rejection). Full Node regression passed 464/464 (437
  ChronaSense/core/export tests, including 10 new adversarial validation/renderer tests, + 27 adapter
  tests). Full Playwright passed 176/176. ESLint completed with 0 errors and the same 19 pre-existing
  warnings in `focus-mode.js`, `insights.js`, and `storage.js`; changed production files (adapter,
  core, renderer) had no warnings. Syntax checks and `git diff --check` passed.
  Reviewer-reproduced malformed payloads (null payload, object `workoutName`, string `exercises`,
  string `bodyWeight`, numeric `rating`, object `note`) are now confirmed rejected by both
  `validateLifeLedgerEvent()` (shared core) and `buildObsidianLifeLedgerExport()` (renderer) directly,
  independent of the adapter. Two identical physical backup rows now produce an explicit `accepted` +
  `duplicate` outcome pair (order-independent) instead of a silent collapse. A forced non-UUID
  `createId` reproduces a rejected ledger upsert whose top-level `importWorkoutBackup()` `status` is
  confirmed `partial`, never `ok`, and a retry with a valid `createId` is confirmed idempotent. A
  forged `iw`-prefixed record is confirmed labeled `csv_import_path_compatible` /
  `validated-supplied-backup-record`, never the old overclaiming `csv_imported_history` label.
untested: unchanged from the entry above — no production deployment, mobile install, Firebase/shared
  storage, Obsidian export/write, Meal app, openGym source mutation, or real user backup import was
  exercised in this fix pass either.

## Capability/Career V1 reviewer fix packet · 2026-08-31
suite: `npm test`; `npx playwright test tests/capability-career-ui.spec.js`;
  `npx playwright test tests/learning-plan-ui.spec.js`; `npm run test:smoke`; `npm run lint`;
  `node --check capability-career-model.js capability-career-repository.js
  capability-career-import.js capability-career-analytics.js capability-career-ui.js test.js
  tests/capability-career-ui.spec.js`; `git diff --check`; targeted `rg` boundary checks over the
  Career runtime modules for Firebase/sync, Obsidian/file writes, fetch/XHR, Meal/Workout coupling,
  Life Ledger write APIs, title/keyword inference, random IDs, hidden Date.now, and raw code eval.
result: `npm test` passed 424/424. Career Playwright spec passed 8/8. Learning Plan UI regression
  spec passed 77/77. Full smoke passed 176/176 after the final code change. Lint completed with 0
  errors and the same 19 pre-existing warnings in `focus-mode.js`, `insights.js`, and `storage.js`;
  no Career file warnings. Syntax checks passed. `git diff --check` reported no whitespace errors,
  only the repository's existing LF/CRLF normalization warnings. Boundary checks found no forbidden
  integration calls in the Career runtime modules. `npm run lint` first hit sandbox `ENOTCACHED` and
  was rerun with approved escalation. `npm run test:smoke` first hit sandbox EPERM creating
  Playwright artifacts and was rerun with approved escalation.
untested: no production deploy, mobile device install, Firebase sync, Obsidian write/export, external
  service, or real user data flow was exercised; those remain intentionally outside this local-only
  reviewer fix packet.

## Capability/Career V1 · 2026-08-31
suite: `npm test`; `npm run lint`; `npx playwright test tests/capability-career-ui.spec.js`;
  `npx playwright test tests/learning-plan-ui.spec.js`; `npm run test:smoke`;
  `node --check capability-career-model.js capability-career-repository.js
  capability-career-import.js capability-career-analytics.js capability-career-ui.js`;
  `git diff --check`; targeted `rg` boundary checks over the new Career modules for Firebase,
  Obsidian/file writes, fetch/XHR, Meal/Workout coupling, and Life Ledger write APIs.
result: `npm test` passed 412/412. Career Playwright spec passed 7/7. Learning Plan UI regression
  spec passed 77/77. Smoke suite passed 175/175. Lint completed with 0 errors and 19 pre-existing
  warnings outside the new Career files. New Career JS modules passed syntax checks. `git diff
  --check` reported no whitespace errors, only the repository's existing LF/CRLF normalization
  warnings for touched files. Boundary checks found no Firebase calls, no Obsidian/file writes, no
  fetch/XHR, no Meal/Workout coupling, and no Life Ledger write API usage in the new Career modules.
  `npm run lint` initially hit an npm cache/network `ENOTCACHED` condition inside the sandbox and
  was rerun with approved escalation. `npm run test:smoke` initially hit a sandbox EPERM creating
  Playwright artifacts and was rerun with approved escalation.
untested: no production deploy, mobile device install, Firebase sync flow, or Obsidian integration
  was exercised; those are intentionally outside this local-only Capability/Career V1 milestone.

## TASK-003 · 2026-07-21
suite: [System.Management.Automation.Language.Parser]::ParseFile on tools/Run-Codex-Build.ps1 and
  tools/Run-Claude-Review.ps1; direct diff against Meal Prep's pre-port versions of both files;
  fixture harness against `Get-TaskBlockText`/`Get-TaskDeclaredFiles` re-run against this app's own
  copy of the ported functions (extracted via brace-matching)
result: both files parse clean. Direct diff confirmed both files were functionally identical to
  Meal Prep's pre-fix versions before porting (Run-Claude-Review.ps1 byte-identical;
  Run-Codex-Build.ps1 differed only in two comment lines referencing the other app's name/path,
  no logic differences). Fixture harness: 8/8 assertions pass -- single-line files field,
  multi-line continuation with `(new)` annotations stripped, missing field returns `@()`, correct
  isolation of one task among several with no bleed into neighbors, unknown task ID handled
  without crash, out-of-scope diff logic correct for both an in-scope build and one with an extra
  undeclared file. The note read/match/consume logic (task-ID matching, stale-note rejection,
  always-delete-after-read) was not re-derived separately here -- it's character-for-character
  identical to Meal Prep's already-tested version (6/6 assertions there), confirmed via the same
  direct diff rather than re-running a duplicate fixture for no new signal.
untested: no live end-to-end run in either app -- reproducing a real build that touches a file its
  task never declared, and confirming the note actually reaches a real REVIEW.md entry, isn't
  safely reproducible without running the real headless build/review pipeline against a live
  branch. Honestly disclosed as unverified-live here rather than claimed.

## TASK-002 · 2026-07-21
suite: [System.Management.Automation.Language.Parser]::ParseFile on tools/Generate-Digest.ps1 and
  tools/Dispatch-Commands.ps1; tools/Generate-Digest.ps1 executed against the real, live-failing
  planning/PROPOSALS.md (12 pending proposals) with -OutFile pointed at a scratch file; isolated
  fixture harness against the stale-lock decision logic (same branching as the real fix, run against
  constructed lock files with real Get-Process checks, not mocked)
result: both files parse clean, no syntax errors. Digest run against real data: output 3911 chars
  (Telegram's limit is 4096) -- all 5 RECOMMEND APPROVE items and both RECOMMEND PARK items kept in
  full, only 1 of 5 RECOMMEND REJECT items shown before the safe-length threshold was reached,
  followed by a "+4 more waiting ... see planning/PROPOSALS.md" note. Stale-lock logic: 4/4 cases
  pass -- a lock file whose recorded PID is not currently running clears immediately regardless of
  timestamp age; a lock with a live PID and a fresh timestamp stays busy; a lock with a live PID and
  a 46-minute-old timestamp clears; a lock with a live PID and a 44-minute-old timestamp (2 minutes
  under the new 45-min threshold) stays busy, confirming no false-positive right at the boundary.
untested: full live end-to-end verification -- a real Telegram send of the truncated digest, and a
  real hung process actually getting auto-cleared with its Telegram notice actually arriving -- was
  not attempted beyond the isolated checks above.

## TASK-001 · 2026-07-20
suite: [System.Management.Automation.Language.Parser]::ParseFile on tools/Run-Codex-Build.ps1 and
  tools/Dispatch-Commands.ps1; isolated fixture harness against Resolve-ReviewOutcome (extracted from
  THIS repo's own copy of the file, along with its real Split-TaskBlock/Set-TaskStatus/
  Set-TaskBlockedAuto dependencies, Publish-TasksChange stubbed to a no-op so the test never touches
  git)
result: both files parse clean, no syntax errors. Resolve-ReviewOutcome: 9/9 assertions pass across 5
  cases -- a real auto-merge message sets status: done with NeedsHuman false; an "APPROVED but HELD"
  red-zone message correctly sets status: approved (NOT done) rather than false-positive-matching the
  literal word APPROVED; a REWORK message increments an existing strike 1/3 note to 2/3; a
  crashed-review-engine message ("Left at status: review for automatic retry") sets status: review
  with no strike; a "build NO-OP" message sets status: blocked with strike 1/3 recorded.
untested: full live end-to-end verification -- a real crashed claude/codex review process, and a real
  no-op rework retry -- was not attempted; not safely reproducible without spawning real codex/claude
  CLI processes against a live git branch. This is the first task run through this project's own
  TASKS.md/REVIEW.md/CHANGELOG.md/TEST_REPORT.md loop (ported directly from the Meal Prep app, which
  hit and fixed this bug live first).

<!-- Entries go here, newest first. -->
