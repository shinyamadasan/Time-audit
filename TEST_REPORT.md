# Test Report

> **Codex writes; Claude reads.** Append-only. One entry per task run.
> Tests: `npm test` (node test.js) and Playwright. Manual: `SMOKETEST.md`.

---

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
