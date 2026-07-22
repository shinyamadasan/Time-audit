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
status: done
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

### TASK-003 - Per-task scope note: flag builds that touch files their own task never declared
status: done
review: Claude implemented directly (tools/Run-Codex-Build.ps1, tools/Run-Claude-Review.ps1 -- same
  reasoning as TASK-001/002, Codex cannot commit under tools/). Held at `approved` for human
  `/merge` -- touches the AI Dev OS itself. Deliberately a SOFT gate, not a hard block: an adjacent
  file can be a legitimate dependency, so this only surfaces the mismatch to the reviewer instead
  of silently trusting them to notice it in a raw diff. Ported from the Meal Prep app's TASK-034/
  D-053 -- confirmed via direct diff that both changed files were functionally identical to Meal
  Prep's pre-fix versions before porting (Run-Claude-Review.ps1 byte-identical; Run-Codex-Build.ps1
  differed only in two comment lines). Verified via the same fixture harness re-run against this
  app's own copy of the ported functions (8/8 assertions pass). Both files parse clean. Land with
  `/merge TASK-003` then `/merge TASK-003 yes`.
source: comparison against github.com/cathrynlavery/codex-build (a similar Claude-orchestrates/
  Codex-builds skill) surfaced its `check_scope.py` per-task allowlist enforcer as something
  neither app had -- Run-Codex-Build.ps1's existing `$deniedPatterns` is a repo-wide deny-list
  (blocks the OS/automation surface outright) but never checked whether a build stayed inside the
  specific files ITS OWN task declared. Built in Meal Prep first as TASK-034/D-053, then ported
  here since both apps share the identical template file.
priority: P2
depends-on: none
files: tools/Run-Codex-Build.ps1, tools/Run-Claude-Review.ps1, .gitignore

context:
  The existing commit-scope guard in Run-Codex-Build.ps1 is a repo-wide deny-list: it blocks
  Codex/Claude from ever touching tools/, docs/, CLAUDE.md, etc., regardless of which task is
  running. That's the right tool for "never touch the OS itself," but it says nothing about
  whether a build stayed within the app-code surface its OWN task actually declared in TASKS.md's
  `files:` field -- e.g. a task that says `files: app.js` but also edits `style.css` sails through
  the deny-list untouched (CSS is legitimate app-code surface) with nothing flagging that the
  touch was never requested. The reviewer sees the raw diff, but nothing prompts them to
  cross-check it against the task's own declared scope.

acceptance:
  - [x] New `Get-TaskBlockText`/`Get-TaskDeclaredFiles` helpers parse a task's `files:` field
        (single-line and multi-line-continuation forms), stripping `(new)` annotations, returning
        `@()` (never a false "everything is out of scope") when the field is missing/unparseable.
  - [x] After the existing deny-list guard passes, Run-Codex-Build.ps1 computes the union of
        declared files across every tracked task in this invocation, and flags any changed file
        that is neither declared nor a standard evidence file
        (CHANGELOG.md/TEST_REPORT.md/TASKS.md).
  - [x] This is a SOFT gate: a mismatch never blocks the build or marks it blocked. It only writes
        a task-ID-tagged note to a new gitignored `.scope-note.txt` handoff file when reaching
        `status: review`.
  - [x] Run-Claude-Review.ps1 reads `.scope-note.txt`, uses it ONLY if the task currently under
        review is one of the ID(s) the note names, and always deletes the file after reading
        regardless of match so nothing can leak into a later run.
  - [x] When present, the note is folded into the Claude reviewer's prompt as an explicit item.
        The Codex-as-reviewer fallback path does not receive this signal, consistent with its
        existing documented degraded-capability status.
  - [x] `.scope-note.txt` added to `.gitignore`, matching `.last-phase-result.txt`'s existing
        transient-handoff-file convention.

constraints:
  - Automation/OS-surface change: solo, never chained.
  - Red-zone surface -- held at `approved`, never auto-merged.
  - Must never become a hard block -- false positives (a legitimate adjacent-file touch) are
    expected and must not stall a real fix.

test steps:
  - [x] `[System.Management.Automation.Language.Parser]::ParseFile` on both changed `.ps1` files:
        no syntax errors.
  - [x] Direct diff against Meal Prep's pre-port versions confirmed both files were functionally
        identical before this change (Run-Claude-Review.ps1 byte-identical; Run-Codex-Build.ps1
        differed only in two comment lines referencing the other app's name).
  - [x] Fixture harness against `Get-TaskBlockText`/`Get-TaskDeclaredFiles`, re-run against this
        app's own copy of the ported functions: 8/8 assertions pass.
  - [ ] Live (human-verified): a real build that touches an undeclared file produces a visible
        scope note in a real REVIEW.md entry, in production.

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
