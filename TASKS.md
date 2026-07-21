# Tasks

> **Handoff document.** Claude writes tasks; Codex checks them off.
> Tasks must come from an approved item in `planning/BUILD_QUEUE.md`.
> One task = one atomic, independently testable unit.

## Status legend

`todo` -> `codex` -> `in-progress` -> `review` -> `approved` / `done`

- `done`     = approved AND reversible -> auto-merged to main (see CLAUDE.md Risk-gated merge)
- `approved` = approved BUT red-zone   -> HELD, human merges after a glance
- `blocked`  = Codex hit an ambiguity; Claude must resolve before work continues

---

### TASK-001 - Fix silent no-op rework retry + stuck crashed-review state
status: approved
review: Claude implemented directly (tools/Dispatch-Commands.ps1, tools/Run-Codex-Build.ps1 -- Codex
  cannot commit under tools/, same reasoning as this file's own Hard Rules). Held at `approved` for
  human `/merge`, not auto-merged -- this touches the AI Dev OS itself, which this project's own
  Risk-gated merge section lists as red-zone. No independent second set of eyes on this specific
  diff (same-session build+review), mitigated by an isolated 9-case fixture harness giving
  independent-of-the-author verification of the actual behavior. Both changed files parse clean.
  Land with `/merge TASK-001` then `/merge TASK-001 yes` when ready.
source: ported directly from the Meal Prep app (sibling project, same tools/Dispatch-Commands.ps1 /
  tools/Run-Codex-Build.ps1 template) after that app hit this bug live and fixed it as its own
  TASK-032/DECISIONS D-051 -- confirmed byte-for-byte identical before this change, so the same bug
  was latent here too
owner: codex
priority: P1
depends-on: none
files: tools/Run-Codex-Build.ps1, tools/Dispatch-Commands.ps1, DECISIONS.md

context:
  A rework retry can flip a task's TASKS.md status from `codex` to `review` without Codex actually
  changing any code (confirmed live on the Meal Prep app: a retry commit changed nothing but
  TASKS.md itself, and a must-fix security patch from a prior review was never applied). Separately,
  when the auto-chained review engine crashes (a known, occasional `claude -p` flakiness), the
  autopilot's classifier had no case for "review engine crashed, not a verdict" -- it fell into the
  generic `else` branch and got marked `blocked` with a note that doesn't match either of its own
  auto-release patterns (`waiting on merge of` / `strike N/3`), so a task could get permanently
  stuck the moment a crash happened, with the note itself claiming otherwise.

acceptance:
  - [x] `Run-Codex-Build.ps1`: before auto-chaining a build that reached `status: review` into
        review, verify it touched `CHANGELOG.md` or `TEST_REPORT.md` (AGENTS.md's own mandated
        evidence steps). If not, mark it `blocked` with a clear "no-op" note and skip the review
        chain entirely.
  - [x] `Dispatch-Commands.ps1`: factor the build/review outcome classification into one shared
        `Resolve-ReviewOutcome` function used by both the build loop and a new pending-review-resume
        step, so the two call sites cannot drift apart.
  - [x] Add a case recognizing the review-engine-crash signal ("Left at status: review for automatic
        retry") that sets `status: review` on main (not `blocked`), with no strike cap.
  - [x] Add a case recognizing the "build NO-OP" signal, reusing the existing `strike N/3`
        bounded-retry idiom REWORK already has.
  - [x] Fix a latent bug found while consolidating the classifier: a red-zone "APPROVED but HELD"
        review message contains the literal word APPROVED, so the old inline classifier would have
        matched it and marked the task `done` on main even though the branch was never actually
        merged. Now checked before the generic APPROVED match and routed to `status: approved`.
  - [x] Add a pending-review-resume step to `Invoke-Autopilot` so a plain `/go` resumes a task stuck
        at `status: review`, taking priority over starting a new build and counting as that
        mission's one action.
  - [x] The `/go` summary says `RETRYING:` (not `NEEDS YOU:`) for a self-healing crash retry.
  - [x] `DECISIONS.md` gains a numbered entry (this project's own plain-number convention, not
        Meal Prep's `D-NNN` style).

constraints:
  - Automation/OS-surface change: solo, never chained.
  - Red-zone surface (per this project's own Risk-gated merge rules) -- held at `approved`, never
    auto-merged.
  - No strike cap on the pure engine-crash retry case (unlike REWORK and the new no-op case, which
    both must stay bounded at 3).

test steps:
  - [x] `[System.Management.Automation.Language.Parser]::ParseFile` on both changed `.ps1` files: no
        syntax errors.
  - [x] Isolated fixture harness against `Resolve-ReviewOutcome`, extracted from THIS repo's own
        copy of the file (not assumed from the source fix): 5 representative cases / 9 assertions,
        all pass -- real auto-merge -> `done`; APPROVED-but-HELD -> `approved` (not `done`); REWORK
        -> strike incremented from a prior note; crash signal -> `status: review`, no strike; no-op
        signal -> `blocked` with strike recorded.
  - [ ] Live (human-verified): the next real crashed review or real no-op rework retry in this
        project's own production use resolves itself on the next `/go` instead of getting stuck. Not
        safely reproducible without spawning real codex/claude CLI processes against a live branch.

---

<!-- Paste new tasks above this line. -->

<!-- TASK TEMPLATE -- copy and fill:

### TASK-001 - <short title>
status: codex
owner: codex
source: BQ-<id>
priority: P2
depends-on: none
files: index.html (CODEMAP section: <name>), storage.js

context:
  <what exists today, which CODEMAP section, why this change>

acceptance:
  - [ ] criterion 1
  - [ ] criterion 2

constraints:
  - Read CODEMAP.md first; never read index.html in full
  - <hard-rule constraints that apply>

test steps:
  - [ ] npm test
  - [ ] SMOKETEST.md items touched by this change

-->
