# Review

> **Claude writes; Codex reads.** One entry per review cycle.
> After writing: set the task status in TASKS.md to `done` (reversible -> auto-merge),
> `approved` (red-zone -> held for human merge), or back to `codex` (rework).

---

## Review TASK-003 - APPROVED, HELD (per-task scope note, soft gate, ported from the Meal Prep app)
branch: task-003
verdict: approved (red-zone, held for human `/merge`)

### Context
Prompted by comparing the shared AI Dev OS template against `github.com/cathrynlavery/codex-build`,
a similar Claude-orchestrates/Codex-builds skill. Its `check_scope.py` mechanically fails a run if a
task touches a file outside its own declared allowlist -- something neither this app nor Meal Prep
had. Both apps already have `Run-Codex-Build.ps1`'s `$deniedPatterns` deny-list, but that's a
repo-wide "never touch the OS itself" guard, not a per-task check -- a task declaring
`files: app.js` that also edits `style.css` passes the deny-list untouched (CSS is legitimate
app-code surface) with nothing flagging the extra touch was never requested. Built in Meal Prep
first (its TASK-034/D-053), then ported here since both apps share the identical template file.

### Findings
**1. Confirmed identical before porting, not assumed.** Direct diff against Meal Prep's pre-fix
versions: `Run-Claude-Review.ps1` byte-identical; `Run-Codex-Build.ps1` differed only in two
comment lines referencing the other app's name/path, no logic differences. Same standard this
app's own TASK-001/TASK-002 ports already held themselves to.

**2. Soft-gate design carried over correctly.** A mismatch never blocks the build, never marks a
task blocked, never touches the build's own exit code -- only writes an advisory note, consumed
once by the review step. This was an explicit, deliberate choice in the source app (the user
specifically flagged that a hard-block version would trade silent scope creep for false-positive
blocks needing manual intervention) and the port preserves that shape exactly, not a
stricter/looser reinterpretation.

**3. Cross-task-ID leak prevention ported correctly.** The handoff file is prefixed with the task
ID(s) it applies to; `Run-Claude-Review.ps1` only uses it if the task currently under review is
named there, and unconditionally deletes the file after reading either way. This logic is
character-for-character identical to Meal Prep's already-tested version (6/6 fixture assertions
there covering exactly this) -- not re-derived, verified via the same direct-diff standard as
finding 1.

**4. Verification.** Both files parse clean. Fixture harness against the file/scope-parsing
helpers, re-run against this app's own copy: 8/8 assertions pass. No live end-to-end run in
either app -- a real build that genuinely touches an undeclared file, verified to surface in a
real REVIEW.md entry, remains outstanding; honestly disclosed in TEST_REPORT.md rather than
claimed.

### Risk-gate
Automation/OS-surface: solo, never chained. Touches `tools/Run-Codex-Build.ps1` and
`tools/Run-Claude-Review.ps1` directly -- the AI Dev OS's own automation. Held at `approved`,
`main` NOT changed. Same disclosed same-session caveat as TASK-001/TASK-002 (Claude both built and
reviewed this diff) -- mitigated by the fixture harness plus the direct-diff-against-tested-source
standard, not just a second read of the same code.

→ TASK-003 status set to `approved` in TASKS.md. Land with `/merge TASK-003` then
`/merge TASK-003 yes`.

## Review TASK-001 - APPROVED, HELD (ported automation fix from the Meal Prep app)
branch: task-001
verdict: approved (red-zone, held for human `/merge`)

### Context
This app and the Meal Prep app (a sibling project, same developer, same AI Dev OS template) share an
identical `tools/Dispatch-Commands.ps1` / `tools/Run-Codex-Build.ps1` -- confirmed byte-for-byte via
direct comparison before this change. The Meal Prep app hit a real incident: a rework retry silently
left a security fix unapplied, and a crashed re-review then left the task permanently stuck in a way
its own status message claimed was self-healing. That app fixed it as TASK-032/DECISIONS D-051. Since
the underlying code here was identical, the same bug was latent in this project too, just not yet
triggered.

### Findings
**1. No-op-build guard — correct.** `Run-Codex-Build.ps1`'s new `$hasEvidence` check requires
`CHANGELOG.md` or `TEST_REPORT.md` to appear in `$changed` before a build reaching `status: review` is
allowed to auto-chain into review — a general enforcement of AGENTS.md's own mandated evidence steps,
not special-cased to rework retries.

**2. Shared classifier — correct, including the HELD-vs-APPROVED fix.** Consolidating the inline
APPROVED/REWORK/else classification into `Resolve-ReviewOutcome` carries over the fix for a real,
previously-undetected bug: the old inline check would have matched the literal word "APPROVED" inside
a red-zone "APPROVED but HELD" message and incorrectly marked that task `done` on `main` even though
`main NOT changed` is explicit in that same message. Now checked and routed to `status: approved`
first.

**3. Crashed-review handling — correct.** Matches Run-Claude-Review.ps1's own documented intent (a
bare engine failure "stays `status: review`... a valid 'try me again' state") by mirroring that state
onto `main` instead of overwriting it to `blocked` with an unmatched note, with no strike cap since
this is transient infra flakiness, not a task defect.

**4. Pending-review-resume step — correct placement and gating.** Added before "plan once"/"idle
audit", with the build loop gated on `-not $built` so it never double-spends the one-mission-per-`/go`
budget.

**5. Verification — independent, not just copied.** Both files parse clean. `Resolve-ReviewOutcome`
verified via a fixture harness built against THIS repo's own extracted copy of the function (not
assumed correct from the source fix) — 5 cases / 9 assertions, all pass, including the two hardest
(HELD-not-done, strike-increment-from-existing-note). No live end-to-end run (would require a real
crashed `claude -p`/`codex exec` process) — honestly disclosed as unverified in TEST_REPORT.md.

### Verdict
Gate picked: `approved` (red-zone: touches `tools/Dispatch-Commands.ps1` and
`tools/Run-Codex-Build.ps1` directly — the AI Dev OS itself, explicitly listed as red-zone in this
project's own Risk-gated merge rules). Same disclosed same-session caveat as the Meal Prep app's
TASK-014/016/031/032 precedent (Claude both built and reviewed this specific diff) — mitigated by the
independent fixture verification rather than a second read of the same code.

→ TASK-001 status set to `approved` in TASKS.md. Land with `/merge TASK-001` then
`/merge TASK-001 yes`.

## Review TASK-002 - APPROVED, HELD (digest length cap + stale-lock visibility fix)
branch: task-002
verdict: approved (red-zone, held for human `/merge`)

### Context
Found live in the same session as TASK-001. While waiting for TASK-001's `/merge` commands to
process, a real Telegram delivery failure surfaced ("Bad Request: message is too long") on this
project's morning digest. Investigating why the queued `/merge` commands themselves hadn't been
picked up led to a second discovery: `automation.lock` had been held by a genuinely hung process for
48+ minutes with zero CPU activity, zero log output, and no working child process -- a human had to
notice this by hand (Task Manager, `Get-Process` CPU/child-process checks) and kill it before the
queue could move again.

### Findings
**1. Digest length cap — correct, verified against real failing data, not a synthetic case.**
`Generate-Digest.ps1` now tracks cumulative length while adding proposal groups/items and stops
before a 3700-char content threshold (leaving room for the fixed footer), appending a "+N more...see
planning/PROPOSALS.md" note rather than truncating the final joined string. Run against the actual
`planning/PROPOSALS.md` that produced the live failure (12 proposals): output is 3911 chars, safely
under Telegram's 4096 cap, and every higher-priority item (5 Approve, 2 Park) survives intact -- only
the lowest-priority Reject items get trimmed.

**2. Stale-lock fix — correct, and appropriately conservative.** The new check verifies the lock
file's recorded PID is actually still running before treating a fresh-looking lock as busy -- a
crashed process that never cleaned up now clears immediately regardless of age, no arbitrary wait.
For a PID that's still running, the wait is lowered from 2 hours to 45 minutes, a figure explicitly
derived from this project's own documented ceilings (Run-Codex-Build.ps1's 20-min build cap,
Run-Merge.ps1's 10-min npm-test cap), not picked arbitrarily. Verified via 4 fixture cases including
the boundary (44 min stays busy, 46 min clears) -- no off-by-one false positive.

**3. Deliberately does not auto-kill.** The fix clears only the lock file, never the lingering
process itself, and surfaces `/stop` (this project's own pre-existing, human-triggered kill path) in
the notice text as the explicit way to actually terminate a repeat offender. This is the right
conservative line: auto-clearing a lock file is reversible and low-stakes; auto-killing an unknown
process based on a time heuristic alone is not, and this project already has a deliberate,
human-invoked mechanism for that specific action.

**4. Visibility fix genuinely closes the gap that motivated this task.** The notice routes through
the exact same `Write-Reply` + `Invoke-CommitPushWithRetry` mechanism every other command reply
already uses, so a cleared stale lock now produces a real Telegram message instead of vanishing into
`Write-Host` output nobody watching a scheduled task ever sees.

**5. Verification is real, not assumed.** Both files parse clean. The digest fix was tested against
the actual data that caused the live failure, not a contrived example. The lock fix was tested via
constructed lock files exercising real `Get-Process` calls, not mocked assertions.

### Verdict
Gate picked: `approved` (red-zone: touches `tools/Generate-Digest.ps1` and
`tools/Dispatch-Commands.ps1` directly — the AI Dev OS itself). Same disclosed same-session caveat as
TASK-001 (Claude both built and reviewed this diff) — mitigated by testing against real failing data
and an independent fixture harness rather than a second read of the same code.

→ TASK-002 status set to `approved` in TASKS.md. Land with `/merge TASK-002` then
`/merge TASK-002 yes`.

<!-- REVIEW TEMPLATE -- copy and fill:

## Review TASK-<id> - <APPROVED | REWORK>
branch: task-<id>
verdict: approved | changes requested

### Findings

### Verdict
Gate picked: `done` (reversible) | `approved` (red-zone: <why>)

### Must-fix (Codex must address before approval)
- [ ] item

### Nits (optional)
- item

-->
