# Review

> **Claude writes; Codex reads.** One entry per review cycle.
> After writing: set the task status in TASKS.md to `done` (reversible -> auto-merge),
> `approved` (red-zone -> held for human merge), or back to `codex` (rework).

---

## Review TASK-018 - CLOSED, status `done` (owner real-use acceptance received)
branch: closure recorded on `docs/task-018-closure-task-016-plan`; the runtime it closes is origin/main
  `57754a3dad6817cc00bcc99fbfcf4b6939b35ce7` (PR #9 squash), already merged and deployed under separate
  owner authorization.
verdict: done (the closure record is docs-only and reversible; the runtime is already live)
reviewer: Claude (reviewer role), verifying the owner-named evidence against GitHub and retained artifacts

What was verified, and how:
  - PR #9 MERGED with merge commit 57754a3, and 57754a3 IS the current tip of origin/main. Verified via
    the GitHub API, not from the report text.
  - CI 39704038615 on that exact SHA: both required jobs success; 957/957 browser; 151/151 fence across
    four suites; 455/455 legacy unit. Counts read out of the CI log itself.
  - Pages deployment 7241148022 -> sha 57754a3, environment github-pages, state success; and
    `pages/builds/latest` is 57754a3, so production serves the accepted build.
  - Firebase backend unchanged: the ca2c90f..57754a3 diff for firebase.rules.json and firebase.json is
    empty; the change is frontend + generated mirrors + tests + docs only.
  - No unexpected data loss or privacy leakage, from the retained canary/privacy evidence.
  - Owner real-use acceptance PASS, stated directly by the owner. This was the only outstanding gate.

One correction to the owner's evidence list, for the record: the Pages identifier 7241148022 is a Pages
**deployment** id, not an Actions run id. The corresponding Actions run is 39704038172 and the Pages build
is 1304072541. The deployment id is correct; only its label needed pinning down.

Honest limitation, preserved and not smoothed over: completion median improved 29% (1344.5 -> 955.1 ms)
and request count fell 51 -> 40, but **Undo latency did not measurably improve and p95 improvement is not
established** (candidate Undo 1013.7/1594.2 ms vs baseline 924.4/946.2 ms). Backend mutate p95 rose
548 -> 1103 ms. O3, server-tail latency, uninstrumented subspans, expired-auth timing, larger-room costs
and real-device/APK acceptance all remain open and are carried forward in the TASKS.md closure block.

Risk gate: `done` rather than `approved`. The gate applies to what this entry SHIPS, and it ships only
documentation — the red-zone runtime was merged and deployed earlier under its own owner authorization,
and nothing here can alter it. No runtime file, www mirror, rule or Firebase config is touched.

## Review TASK-016 - PLANNING ACCEPTED, status `todo` (NOT implementation authorized)
branch: docs/task-018-closure-task-016-plan (docs only)
verdict: todo — ready for an owner GO/NO-GO decision; no implementation performed or authorized
reviewer: Claude (planning role)

The TASK-015 defect was confirmed to still exist on current main, and its root cause was established by
deterministic reproduction rather than inherited assumption. The owner's instruction not to assume the
localStorage overwrite was correct to give: that hypothesis is NOT the cause of the non-recovery, which
reproduces with a single client and no competing writer. The cause is trigger-side — `mergeRemote()`'s
deep-equality `changed` gate suppresses the only listener-driven reconciliation trigger once local and
remote agree, and the one remaining trigger (the bind-time sweep) fires once, early, and can silently
no-op on a module-evaluation race.

Recommendation: **GO** for the bounded three-part client-side fix in
docs/TASK_016_PROMOTION_RELIABILITY_DESIGN.md §3. It repairs existing mechanisms, adds no task store,
sync engine or backend, touches no Firebase rules or schema, and preserves the UNKNOWN/offline contract.
Any implementation is red-zone (Hard Rule 9) and must land at `approved`, held for human merge.

## Review TASK-015 - PASS WITH NOTES, HOLD AT APPROVED (Unified My Day + Brain Dump V1 planning tray)
branch: task-015 @ 5c5957e (rebased onto origin/main 2411ee4; pre-rebase builder SHA cabb793, tag task-015-prereconcile)
verdict: approved (red-zone, held for human merge), once the lead's post-rebase smoke run is green
reviewer: independent Claude reviewer (did not build this task)

### What was checked
Read the TASK-015 contract (TASKS.md), TASK_015_HANDOFF.md, the CODEMAP Brain Dump entry, the full
`git diff origin/main..HEAD`, brain-dump-promotion.js in full, and the changed and surrounding parts of
brain-dump-ui.js. I checked `dayForScheduledDate` / `scheduledDateForTarget` / `next` / `current` / `onWrite` in
plan-authority.js. I ran `npm test` (exit 0, every suite fail 0), `npm run lint` (0 errors; no warnings in
brain-dump files), `check:www-parity` (OK, 92-file closure, byte-identical), `check:firebase-rules` (matches builder)
and `git diff --check` (clean). I compared the commits with `git range-diff cbd82fc..task-015-prereconcile
2411ee4..HEAD`. Playwright was NOT run by me: the lead's smoke run owns the port and output dirs.

### Findings (verified)
1. **Constraints hold.** `git diff origin/main..HEAD` is empty for brain-dump-model/-repository/-sync/-promotion.js,
   plan-authority.js, plan-item-origin.js, plan-fence-sync.js, storage.js, firebase.rules.json, functions/ and
   workers/. The governed token `20261014-task014-normal-tracking-hud-v1` is untouched (index.html:8,16,1741-1770,
   1779-1810). Only the Brain Dump token moved, in 7 URLs (index.html:1771-1775 import map, 1811-1812 entry tags),
   plus the new CSS link at index.html:24. The test pin and the retired list moved together
   (personal-day-boundary-web-runtime.test.js:275,279). The old token appears nowhere else in runtime files.
   www/ is byte-identical for index.html, brain-dump-ui.js and brain-dump-tray.css.
2. **Extracting scheduleTo is behaviour-preserving.** confirmSchedule (brain-dump-ui.js:395-407) still has the
   pending guard, the "Pick a date first." validation, the same `when`/`durationMinutes` derivation, the
   `openScheduleId = null` reset on ok only, and the same `reportPromotionOutcome(..., 'Added to your plan.')`.
   scheduleTo (412-425) passes exactly the same promoteCaptureToPlan arguments; the `when = ''` default never
   applies because confirmSchedule always passes a string. Today uses the existing doToday (376-386) unchanged.
   The tray lives in the same module, so pendingPromotionIds, reconciling and the reconciler are shared.
3. **The Tomorrow round trip is correct and fails closed.** trayDays (brain-dump-ui.js:620-633) offers Tomorrow only
   when `dayForScheduledDate(date,'').target.id === next(current()).id`. promoteCaptureToPlan resolves the schedule
   target with exactly that call (brain-dump-promotion.js:137), so the label date and the written day are one
   resolution.
   - Calendar: `next` → `calendarTarget(D+1)`, and `dayForScheduledDate` returns the same id (plan-authority.js:401,
     467-472).
   - Legacy without a boundary: `scheduledDateForTarget` returns `dateKey`, and `dayForCalendarDate` →
     `legacyTarget` (plan-authority.js:522-525, 459-460).
   - Personal Day: the noon anchor is checked against `next.id`. The fallback label (start date) is still verified.
   - Legacy→calendar cutover eve: the ids differ, so Tomorrow is omitted. Never a wrong day.
   - Because the check demands `next.id`, Tomorrow can never land on today.
4. **The midnight guard is sound.** trayPlace (brain-dump-ui.js:703-720) recomputes trayDays and compares today id,
   target id and date for both kinds before any write. The guard and the promotion's target resolution run in the
   same synchronous segment: doToday and scheduleTo reach `planAuthority.current()` / `dayForScheduledDate` before
   their first `await` (brain-dump-promotion.js:121-140). The only write-side await is the claim, which is after
   resolution. A claim that straddles midnight is handled by the existing expired-claim reconciler (pre-existing
   behaviour, unchanged).
5. **Pending state and account switch.** A pending id shows "Still confirming…" with no buttons
   (brain-dump-ui.js:641-651). render() calls renderTray first (265-267), so every outcome path refreshes the tray.
   refreshBrainDumpSurfaces renders the tray on both the id and no-id paths, either via render() or the new `else`
   branch (732-737). The module also renders once at load (738). The tray has no element ids at all (only data-*),
   so it cannot collide with #bd-root.
6. **No XSS.** Capture text, chip, id, target id and date are all escapeHtml'd into double-quoted attributes or text
   (brain-dump-ui.js:635-651, 661-700). The inline onclicks pass `this` or constants, never a capture id. This is
   safer than the existing view's `'${id}'` inline handlers.
7. **Layout bounds hold.** The section is `hidden` and its innerHTML emptied with 0/0 captures (668-671), plus
   `#bd-plan-tray[hidden]{display:none}` (brain-dump-tray.css:7). It is collapsed by default, and the localStorage
   read/write is wrapped in try/catch (586-597). Rows are limited by TRAY_ROWS=5 and TRAY_PREVIEW=3, with an inline
   "Show all (N)" and no scroller. CSS is scoped to `#bd-plan-tray` / `.bdt-*` only.
8. **No loop in refreshAuthoritativePlanSurfaces.** The new line is index.html:7311. renderTray only reads Plan
   Authority. onWrite fires only from write paths (plan-authority.js:681,686,777,811), so there is no recursion. The
   addItem → onWrite → renderTray re-entry during createAndFinalize is synchronous, and the final render() corrects
   it.
9. **The rebase is clean.** The range-diff shows the TASK-015 patches as identical except for context lines (TASK-014
   tokens and the TASKS.md anchor). The only `-` lines in `git diff origin/main..HEAD` are the confirmSchedule
   extraction, the BrainDumpUI export line and the 7 Brain Dump token lines (x2 for www) plus the test pin. No
   TASK-014 hunk was lost, and both TASKS.md entries are present.
10. **Hard Rules are untouched.** The index.html diff contains no timer, heartbeat, `_todayRenderKey` or INIT-order
    change.

### Must-fix
- None.

### Should-fix (non-blocking)
- [ ] **S1. Handoff and evidence docs are stale after the rebase.** TASK_015_HANDOFF.md still says "base cbd82fc …
  Not reconciled onto main after TASK-014. That has NOT been done here". CHANGELOG.md and TEST_REPORT.md cite the
  pre-rebase base and pre-rebase results (lint "47 warnings"; it is 48 now, and the new one is from the base, not
  this task). Update them with the post-rebase smoke results before merge. The contract also requires a re-test
  after reconciliation.
- [ ] **S2. The F3 "double tap" test may not exercise two in-flight promotions.** `dblclick()`
  (tests/brain-dump-plan-tray.spec.js:300) can land its second click after the first promotion has already
  re-rendered or hidden the tray, and the follow-up stale tap (303-308) runs after settlement. The two-tab case and
  the deterministic plan-item id still cover the duplicate invariant. A stronger test would `__bdHold` the
  capture, call trayPlace twice, then release.
- [ ] **S3. The tray has no in-flight guard.** During a normal (non-pending) claim round trip, the row still shows
  Today and Tomorrow. Tapping Today then Tomorrow quickly gives the second attempt `already-claimed` → "…already
  being added to your plan on another device." That message is false, though nothing is duplicated. The Brain Dump
  view has the same pre-existing behaviour (Do today then Schedule). A tray-local in-flight Set in trayPlace would
  fix it. This does not block.

### Nits
- **F9 wording differs by surface.** The view says "Still confirming a previous action…" and the tray says "Still
  confirming…". Both hide the actions. This is acceptable because F11 pins the existing copy.
- **F6 covers transport refusal only.** Arbitration refusals (`already-claimed`/`already-disposed`) go through the
  same reportPromotionOutcome path and its existing copy. This is acceptable.
- **No "show less"** (not in the contract). Collapsing resets Show all. This is acceptable.
- **The tray date labels can go stale overnight** until any refresh. The guard turns a stale tap into a refusal, not
  a misplacement. The guard is conservative: a pre-midnight Tomorrow tap made just after midnight is refused even
  though its date is still valid. That matches the contract.
- **The Today label uses trayDateHint**, which for a truncated Personal Day can show the start date. It is
  presentation only, since Today always writes to `current()`.
- **Browser tests cover only the legacy store.** Calendar and Personal Day tray paths are verified here by reading
  the code, not by tests.

### Builder's mutation claims
I judged these plausible but did not re-run them. Without the guard, F8 would promote to Oct 2 and the
`plans === before` and status checks would fail. Without the round-trip check, the stubbed-authority test would
still render Tomorrow. Without the pending branch, F9's row assertion fails.

### Verdict
PASS WITH NOTES. No must-fix items. The approval is conditional on the lead's in-progress post-rebase smoke run
being green (I could not run Playwright here).

### Risk-gate
Gate picked: `approved` (red-zone, held). The tray writes plan items (`bdp1|<id>`) into authoritative plan stores
through the remote claim transaction and Plan Authority's addItem. That is RTDB sync plus plan data, where a
misplaced or lost item is not easily reconstructed (Hard Rule 9). It also changes the shared refresh path in
index.html. It must not auto-merge. TASKS.md status is left for the lead to set after the smoke run.

### Addendum — 2026-10-15 (post-rebase F3 rewrite, stuck-claim finding)
Reviewed at HEAD c305c02 (base origin/main 8abe63b; 2411ee4..8abe63b touches only TASKS.md). Since 5c5957e no
runtime file has changed (`git diff 5c5957e..HEAD` covers no .js/.html/.css/www file except the spec). The only
code change is test-only commit 601113e. I did not run Playwright; the results below are the lead's and builder's.

**The F3 rewrite (601113e) is not vacuous, and nothing was weakened except the cross-tab toast.**
- *Same-tab double tap.* Both `trayPlace(button,'today')` calls start synchronously under `__bdHold`, and
  `__bdHeldCount === 2` proves both claim transactions are queued and unsettled before the release. That is a real
  concurrent double tap, so my S2 is resolved. It keeps every assertion: `promoted`, exactly one `bdp1|<id>`, the
  stale re-tap still one item, and no false-conflict toast. The toast assertion is now stronger, because it holds
  under true concurrency.
- *Two tabs, tray + view.* Each tab holds its own queue, and the stub's `held` map is per window. Before any release
  the test proves both claims are in flight (count 1 per tab) and that nothing is written (`triaged`, 0 items). It
  runs both settle orders. It asserts `promoted` in both tabs' local stores, exactly one item, and one item after a
  stale re-tap. Starting from captured handles (`trayPlace(captured button)` and `doToday(id)`) skips only the
  inline onclick wiring, which F1, F2, F8 and F9 cover with real clicks. This is acceptable.
- *Dropped cross-tab no-false-conflict assertion.* This is justified. The lead reproduced the copy with two plain
  Brain Dump views, so it comes from the protected promotion/sync layer and not from the tray. Writing that copy
  is not a TASK-015 regression. It is a real defect, though ("another device" said to a winner of the same
  intent), and it must be tracked: see follow-up F-A.
- *Settle window.* The `promoted` poll now allows 20s. That gives tolerance under load, and a stuck claim would
  still fail it. It is not a weakening.

**S1 (stale docs) is mostly resolved.** TASK_015_HANDOFF.md, TEST_REPORT.md and CHANGELOG.md now describe the
rebased state. They label pre-rebase evidence as superseded and record the lead's results, the F3 rewrite, the
stuck-claim investigation and S3 as open. Three NITs remain:
- they cite base `2411ee4`, but the branch is now on `8abe63b` (a TASKS.md-only move);
- they cite the F3 commit as `2d712ed`, but it is now `601113e`;
- they cite this review as `602805b`, but after the rebase it is `ca1ab21`.
Fix these at merge time; they do not block.

**The stuck-claim finding does not change the verdict or the gate.** Reasons:
1. *It is pre-existing and outside TASK-015's diff.* It reproduces with two plain Brain Dump views and no tray
   (3/240 at 6 workers). Its mechanism lies in brain-dump-sync/-repository and the reconciler trigger, which this
   task is barred from editing.
2. *The tray adds no new writer.* renderTray and trayDays only read. trayPlace writes only through the pre-existing
   doToday / promoteCaptureToPlan path (brain-dump-ui.js:703-720). The suspected lost update (two tabs
   read-merge-writing the shared localStorage envelope) involves only the repository and sync writers, which are
   unchanged. 7/240 (tray + view) against 3/240 (plain views) is not a meaningful difference at these counts.
3. *Exposure is about the same as before.* The race needs two tabs in the same browser, both tapping one capture
   within a few hundred ms. The tray only adds a second place to tap from. That was already possible with two
   Brain Dump tabs, and a single tab cannot race itself cross-tab.
4. *The damage is bounded.* No duplicate item appeared in any run (480 + 180 + 150), and exactly one plan item
   exists. No logged time is involved. The inconsistency is that the capture stays `triaged` with its claim while
   the task is already on My Day. A manual `reconcilePromotionClaim` heals it. It does not violate Hard Rule 9.
The gate stays `approved` (held), for the reasons in the original Risk-gate. The verdict stays PASS WITH NOTES.

**New follow-ups.** These need owner approval and belong in the protected layer, so they are not TASK-015 work.
Record them in planning/ROADMAP.md Known Issues:
- [ ] **F-A.** A cross-tab or cross-device winner of the same intent can be told "…already being added to your plan
  on another device." even though the item was added.
- [ ] **F-B.** A same-browser two-tab race can leave a stuck claim (`triaged` + `promotionClaim`, one item) that
  neither the listener nor the bind-time sweep finalizes, even after a reload. The hypothesis is a localStorage
  whole-envelope lost update, not proven. Also determine why the rebind sweep (settleAllOutstandingClaims) did not
  heal it after the reload. That reconciler is the designed recovery path, so a gap there matters beyond this race.
- [ ] **S3** (unchanged, tray-local, non-blocking): an in-flight guard in trayPlace would cut both the tray's
  Today-then-Tomorrow false-conflict path and the same-tab re-tap window.

**Addendum verdict:** PASS WITH NOTES. Gate: `approved` (held). There is still no must-fix. Approval rests on the
reported green full smoke (921 passed / 0 failed), F3 150/150 over 50 repeats, and the new spec 15/15. I did not
re-run any of them.

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
