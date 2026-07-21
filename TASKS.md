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
status: done
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

### TASK-002 - Fix unbounded digest length + silent 2-hour stale-lock wait
status: approved
review: Claude implemented directly (tools/Generate-Digest.ps1, tools/Dispatch-Commands.ps1 -- same
  reasoning as TASK-001, Codex cannot commit under tools/). Held at `approved` for human `/merge`.
  Digest fix verified against the real, live-failing planning/PROPOSALS.md data (12 pending
  proposals): output is 3911 chars, under Telegram's 4096 limit, keeping every Approve/Park item.
  Lock fix verified via an isolated 4-case fixture test of the exact decision branching (dead PID,
  live PID + fresh timestamp, live PID + stale timestamp, live PID + just-under-threshold
  timestamp). Both files parse clean. Land with `/merge TASK-002` then `/merge TASK-002 yes`.
source: found live in the same session as TASK-001, while investigating a real Telegram delivery
  failure ("Bad Request: message is too long") and the automation.lock incident that led to TASK-001
priority: P1
depends-on: none
files: tools/Generate-Digest.ps1, tools/Dispatch-Commands.ps1, DECISIONS.md

context:
  Two separate reliability bugs. (1) `Generate-Digest.ps1` had no cap on the digest's length --
  with enough pending proposals (12, each carrying full reasoning text), the generated message hit
  ~5000 characters and Telegram rejected the send outright with "Bad Request: message is too long."
  The human got NOTHING that morning, not a partial digest, just silence. (2) Separately,
  `Dispatch-Commands.ps1`'s stale-lock check waited a full 2 hours before self-healing, and even
  then cleared silently. Confirmed live: a genuinely hung process (0% CPU, no log output since
  before it started, no working child process) sat holding `automation.lock` for 48+ minutes,
  completely invisible, until a human happened to check Task Manager and killed it by hand -- the
  queued `/merge` commands for TASK-001 sat stuck behind it the whole time.

acceptance:
  - [x] `Generate-Digest.ps1` builds the digest message incrementally and stops adding
        proposal groups/items before a safe character threshold (3700, leaving headroom for the
        fixed footer), appending a "+N more waiting ... see planning/PROPOSALS.md" note when
        truncated, rather than truncating the final joined string (which could cut a Markdown
        entity in half and trade one delivery failure for a different one).
  - [x] `Dispatch-Commands.ps1`'s lock check reads the lock file's recorded PID and checks whether
        that process is still actually running -- if it has already exited, the lock is stale
        regardless of age, no waiting required.
  - [x] If the recorded PID is still running, the staleness wait is lowered from 2 hours to 45
        minutes (comfortably above the ~35-40 min worst-case legitimate run: Run-Codex-Build.ps1
        caps its build step at 20 min, Run-Merge.ps1 caps npm test at 10 min).
  - [x] Clearing a stale lock now sends a Telegram notice through the existing OUTBOX/reply relay
        (`Write-Reply` + `Invoke-CommitPushWithRetry`, same mechanism every other command reply
        uses) instead of clearing silently, so a stuck run and a quiet one no longer look identical
        from Telegram.
  - [x] Does NOT auto-kill the lingering process -- only clears the lock file. The notice mentions
        `/stop` (which already kills the lock-holding process by PID) as the explicit,
        human-triggered way to do that if it keeps happening.
  - [x] `DECISIONS.md` gains a numbered entry.

constraints:
  - Automation/OS-surface change: solo, never chained.
  - Red-zone surface -- held at `approved`, never auto-merged.
  - Digest truncation must stop at item boundaries, never mid-string, to avoid breaking Markdown
    parsing on the Telegram side.
  - The stale-lock fix must not auto-kill any process -- clearing the lock file only; killing stays
    a human's explicit call via `/stop`.

test steps:
  - [x] `[System.Management.Automation.Language.Parser]::ParseFile` on both changed `.ps1` files: no
        syntax errors.
  - [x] `Generate-Digest.ps1` run against the real (live-failing) `planning/PROPOSALS.md`: output
        3911 chars, all 5 Approve items and both Park items kept, only the lowest-priority Reject
        items truncated with a count note.
  - [x] Isolated fixture harness against the lock decision logic (extracted from this repo's own
        copy): 4 cases / 4 assertions, all pass -- dead PID clears regardless of age; live PID with
        a fresh timestamp stays busy; live PID with a 46-minute-old timestamp clears; live PID with
        a 44-minute-old timestamp (just under the new 45-min threshold) stays busy, confirming no
        false positive right at the boundary.
  - [ ] Live (human-verified): the next real oversized digest sends successfully with a truncation
        note, and the next real hung process self-clears within 45 minutes with a visible Telegram
        notice, instead of requiring manual intervention.

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
