# Test Report

> **Codex writes; Claude reads.** Append-only. One entry per task run.
> Tests: `npm test` (node test.js) and Playwright. Manual: `SMOKETEST.md`.

---

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
