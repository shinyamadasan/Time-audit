# Review

> **Claude writes; Codex reads.** One entry per review cycle.
> After writing: set the task status in TASKS.md to `done` (reversible -> auto-merge),
> `approved` (red-zone -> held for human merge), or back to `codex` (rework).

---

## Review TASK-038 - PASS WITH NOTES, HOLD AT APPROVED (conversational rescheduling on legacy plan targets)

Independent read-only reviewer (fresh context) on the uncommitted task-038 diff; reran functions 282/282, worker 44/44,
emulator subset 7/7, plus its own probe. Verdict: APPROVE-WITH-NOTES, no blockers.
- No path to two live copies or a lost task found (CAS, intent/takeover, Undo, A->B->C->A chains vs validateRelocations).
- In-place construction, day/cutover/boundary routing, isolation and envelope refusals: sound.
Should-fix (addressed):
1. A rules refusal of the whole-collection PUT surfaced as "access refused" -> now CONFLICT `legacy-history-unwritable`
   saying nothing moved (tests: unit + emulator). Still open: whether the second user's real history triggers the known
   limit needs a read-only, owner-approved production check (not run).
2. Docs/tool text said Brain Dump tasks never move; pre-fence `bdp1|` array items do (as in the app) -> wording fixed,
   behaviour pinned by a test.
Notes: overstated emulator "race" title corrected (mid-call interleaving is proven against the fake and the anchor); a
legacy target with a missing/malformed destination answers DOMAIN_LIMIT where INVALID_INPUT would fit (left as is).
Gate: `approved` (red zone: plan mutation / RTDB sync). Not merged, not deployed; the human merges.

## Review TASK-036 - PASS WITH NOTES, HOLD AT APPROVED (conversational completion on legacy plan targets)

Reviewer: independent general-purpose reviewer (fresh context), two rounds. Branch `task-036`, base `0e04ebb`.

**Round 1 - FIX FIRST.** M1 (must-fix, verified by probe): a legacy target was accepted for a date a Personal Day
boundary now owns; completion reported APPLIED into a `plans/<date>` record the app no longer shows (reachable only
with a legacy target get_today did not return). S1: real-rules acceptance of the new write shapes untested. S2: the
legacy end-of-day was computed in the settings zone, not Plan Authority's stored day-start zone. N1: legacy result
schedule is zoned while get_plan gives null instants. N2: unknown-store completion error named calendar only. N3:
non-integer `pre.updatedAt` ignored by the stamp (calendar path identical; theoretical).
Checked with no defect found: wrong item/date/store/user (envelope, pinned URLs, api1_ on legacy -> NOT_FOUND,
duplicates refused); calendar path unchanged; revision/intent/recovery; `inPlaceRecord` shapes and app convergence;
Worker schema. Deliberate code breaks turned tests red (cutover guard, by-index replace, store in the revision).

**Fixes.** M1+S2: `plan-read.js` `legacyDay(date)` routes the date as Plan Authority does (00:00 anchor ->
`operationalDayContaining` -> `resolvePlanAuthority`); the mutation refuses a non-legacy-owned date (NOT_FOUND) and
uses that interval as the day's end. S1: targaryen test of the legacy write shapes in firebase-rules.test.js. N2 fixed.
Regression tests for M1 and S2 both go red without the fix (verified).

**Round 2 - PASS WITH NOTES.** M1 probe now 404/0 writes; legacyDay agrees with get_today for a plain account (writable
until local midnight), a production-shaped anchor, a future boundary, an LA-stored anchor, and midnight-DST zones.
Notes carried, not blocking: N-b reads (get_plan/get_item) still use the settings zone in the zone-mismatch case (reads
deliberately unchanged); N-c a retry after a boundary is created over an already-completed date ends PENDING_UNKNOWN
(fails safe, same ordering as calendar); N-d rules proof is targaryen, not the RTDB emulator; N1 and N3 unchanged.

**Gate: `approved` (held).** Red zone: plan mutation / RTDB sync of plan items (Hard Rule 9). Not merged, not deployed.

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

## Review TASK-029 - APPROVED, HELD (two-user authentication for the MCP bridge)
branch: task-029 (base origin/main 8057e2e; staged, uncommitted)
verdict: approved, held for the owner

### Findings
Independent adversarial review (fresh read-only security agent): PASS-with-notes, no must-fix.
- Cross-user isolation: no path found. The Worker takes the subject only from the grant's userId. That userId
  must equal props.ownerSubject and be allowlisted on every call. The backend maps the HMAC-signed subject to
  its own configured UID and room. Receipts are per UID, and actor provenance is bound to the signed subject.
  RTDB rules independently confine a token to `uid_<auth.uid>`.
- Fail-closed configuration: verified for a half-set pair, equal subjects or UIDs, malformed values, and a
  Worker/backend allowlist mismatch in either direction.
- Existing protections unchanged: Access JWT checks, resource binding, scopes/step-up, expiry/nbf, HMAC,
  idempotency. Existing owner grants keep validating (same userId and props key).
- SHOULD-FIX 1 (applied): the consent page now names the signed-in person (the Access email, escaped, display
  only) and says whose account is being granted. This guards a shared-browser Access session.
- SHOULD-FIX 2 (applied as docs): removing the second subject rejects that user's tokens at /mcp but does not
  delete the grant in OAUTH_KV. README and rollback steps now require deleting those KV records.
- Not applied (noted): a hidden-field GET/POST subject binding. The POST already re-verifies the Access JWT,
  and the label covers the shared-session case.
- Notes for the owner: each person needs their own ChatGPT account; the second UID is trusted configuration
  and must be verified in Firebase before deploy; the Access policy must name exactly the two people.

### Verdict
Gate picked: `approved` (red-zone: authentication and cross-account data access).
Nothing merged or deployed. Production config, Access policy and second-user enablement need explicit owner
approval.

### Re-review (2026-10-25, pre-commit)
A second fresh independent adversarial review covered the staged diff, TASK_029_HANDOFF.md and the isolated real-OAuth
harness, and re-ran the harness (all checks passed): PASS-with-notes, no blocking finding. Each non-blocking note was
resolved in the handoff or the harness (see TEST_REPORT.md "TASK-029 continuation"). Gate unchanged: `approved` (held).

## Review TASK-032 Fix 1 - APPROVED, HELD (date-only commitment time: absent == null)
branch: task-032 (on task-029-rollout)
verdict: approved, held for the owner

### Findings
Independent adversarial review: PASS-with-notes, no blocking finding.
- Scope is exact. The change is reachable only for precision 'date'. Timed validation, '' refusal, startMs
  re-derivation and the fail-closed server reads are unchanged. The output is identical to the null-time record, so
  the merge tie-break cannot flip.
- Downstream it is a correctness improvement. A stale local copy can no longer beat a newer pruned remote edit or
  tombstone in the sync push transaction. update and delete work on pruned records. No rules change is needed.
- Notes addressed: tombstone and LWW tests added; task contract recorded; DECISIONS #40; evidence logged.

### Verdict
Gate picked: `approved` (red-zone: commitment sync and validator shared by the app and the Action API). Browser
specs were not run (declined by the owner).

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

## TASK-039 · Integrate proven time acknowledgement lifecycle · 2026-10-28
reviewer: independent Claude subagent on exact source (7d1ed10 REJECT -> 0d5dc14 APPROVE WITH FIXES -> f422f96 APPROVE).
findings resolved: B1 permanent barrier after commit (operation-stamp proof); S1/M1 unguarded clear/Data Doctor/break/Focus commands; S2 abandon quiet period; S3 hold from Undo press + cursor republish; S4 accepted re-check; S5/S5' cross-tab flush without stale timer; N1 token deadline; N2 parse cache.
accepted residuals: never-landed + changed-elsewhere stays UNKNOWN (owner decision); per-tab preparing hold; no watch on retired abandoned ops; automatic paths unbarred (superseded, not lost).
gate: **approved (held)** — red-zone (timer state, entry schema metadata, RTDB sync). Human merges; no auto-merge or deploy.

### TASK-039 - Shipped web and Android capability (November 2, 2026)
verdict: APPROVE WITH CONDITIONS for exact commit 456acec, local candidate only. Independent delta review; prior reviews of 788a6a1, 5e6f6c2 and 60c0bde recorded alongside it. Not Guardian.
conditions: owner decides F1 (refused Undo removes the only Undo button); cutover runbook and installed-rules verifier; synthetic CORS preflight; real-room timing; phone test.
risk gate: red-zone. Nothing is merged. Task held as blocked on owner decisions, not approved for merge.
evidence: accounting-hazards/evidence/shipped-capability-20261101/independent-review-final.md

### TASK-039 - F1 correction (November 2, 2026)
verdict: APPROVE WITH NOTES for exact commit 6abc40d (independent same-provider subagent; c925e7d and 7bb0928 each APPROVE WITH NOTES with a MEDIUM copy finding, both fixed). Not Guardian.
notes: two rare persistent states (predecessor-unconfirmed capture, intake rejected by importCaptures) still get retry copy; retry refuses safely. Button lives 5.2s per toast. Effects-only blocks get neutral copy.
risk gate: red-zone (Undo/accounting gate). Local checkpoint only; not merged.
evidence: accounting-hazards/evidence/f1-undo-refusal-20261102/F1-CORRECTION.md

### TASK-039 - Pending-sync panel pass-through (November 2, 2026)
verdict: APPROVE WITH NOTES for c556671 (independent same-provider subagent, not Guardian). Notes: :has() unsupported before Chromium 105 falls back to old behaviour; long panel text no longer scrollable; text not selectable. No protective role lost (gates are in JS).
risk gate: CSS only, but held with the red-zone task; nothing merged.

### TASK-043 - Household My Day V1 authenticated integration (November 25, 2026)
verdict: APPROVE WITH NOTES for the uncommitted task-043 worktree (independent same-provider QA subagent, not Guardian). Round 1: 1 major (Start refused for own tasks the timeline does not render) and 6 minor (focus lost on re-render; saved Meal Prep sign-in not resumed after reload; offline provisional Start not reflected; another device's timer offered Start; "verified" email comment overclaimed; interim docs). All fixed with regression tests (household spec 9/9 twice); no blocker. Allowlist, consent revoke, cross-account isolation, Meal Prep account binding and sign-out verified by the reviewer against the emulators.
notes: partner list freshness is by publisher day, not by age (publishing is event driven). Food shows only the viewer's own Meal Prep account; a household-wide food view needs a Meal Prep rules change (owner decision). meal-ready-food.js is a copied extraction of Meal Prep's ranking and can drift from it.
risk gate: red-zone (partner sync projection + storage.js listener) → approved, held. Not committed, merged or deployed; production enablement needs the owner approvals listed in STATUS/handoff.

## TASK-043 mobile-first UX pass — APPROVE (held with TASK-043)
Presentation-only change in household-my-day.js/.css; Start/Stop/Done reuse the same handlers and guard
(`invoke` → `DailyCommandCenter.startTask` / `stopAndLog` / `toggleTimelinePlanDone`); partner card still has no
buttons; no data, rules or auth path touched. QA findings fixed with regression tests. Gate: remains `approved`
(the TASK-043 branch as a whole touches partner sync and storage.js), held for owner merge.

## TASK-045 · Capture durability, storage capacity and truthful save status · 2026-11-26
reviewer: independent Claude review subagent (did not write the code). Range 6029be3..c2b6f95 (21daca4 docs + c2b6f95 runtime), worktree task-044-durability-integration.
verdict: **APPROVE WITH NOTES**. No blocker. One MAJOR finding is a scope and residual-risk note to track before release. It does not fail any TASK-045 acceptance criterion.

### Verified
- Move safety: a record leaves the envelope only when this page holds an IndexedDB copy that was read back and still equals the live record at cut time (`archivedCopyMatches`, accounting-command.js). If IndexedDB fails, is unavailable or is full, `store()` catches the error and nothing becomes droppable. The cut and the save are one synchronous step at accounting-command.js:626. A reload after the archive write but before the cut leaves only harmless duplicate copies. Multi-tab safety comes from the per-record equality check under the account lock. Committed data, legacy-*, resolution and pinned records, and queue/capture/failed/source dependencies are never eligible. In automatic mode only `local-applied` ordinary Start/Stop and coherent hydrates without evidence are offered (index.html:2788). Ordinary Start/Stop reach `local-applied` only after the server ACK, readback and projection.
- Readers: I checked every `.history` and envelope reader in index.html, storage.js and focus-mode.js. time-ack.js has its own envelope. sw.js, workers and the extension do not read the envelope. The ordinary-provisional walk, ping-origin walk, event dedupe (`droppedEventKeys`), `accountingCapturedCommands` (`droppedIds`), focus lease and restore, and legacy capture dedupe never need an archived Start/Stop/hydrate, or they already resolve dropped ids. `AccountingHistoryArchive.read` has no app caller, so the archive is write-only and nothing silently reads less.
- Truthful copy: no "kept safely" or durable claim remains on the page-held or storage-full paths. Page-held status and toasts show the real count from `failedCaptureCount(roomCode)`. "Keep server version" is hidden while captures are page-held.
- beforeunload: it fires only when `failedCaptureCount() > 0` (all owners) and does not return early, so the existing heartbeat-on-unload block still runs. There is no `onJsBeforeUnload` override under android/, so Android WebView and Capacitor proceed without a dialog. It neither blocks nor breaks, and it gives no protection there.
- Path B: the existing `flushFailedCaptures` rewrites the original raw bytes under the original id after readback, deletes the failed copy once, and accepts an identical existing slot. Spec test 2 proves the id, input and `at` are preserved, the receipt appears exactly once after Stop, and the peer tab never sees the page-held fact.
- Hard Rules 4/6/7/8/9: none of the hunks touch `_stopHeartbeat` callers, the heartbeat IIFE, the `doPing` guard or the INIT restore order. There is no schema, rules or config change.

### Findings
- **MAJOR (non-blocking; must be tracked before release, TASK-046/048): capacity is bounded only for the required workload.** Automatic eligibility (index.html:2788) excludes ping, automatic-log, save-entry, retro-*, focus-*, break/away, undo and the other kinds. Those records, plus committed entries, physical records and the separate entry cache, still grow without bound. The perf spec uses only Start → 25 min → Stop with a 30-min interval, so it never exercises pings. My reviewer probe ran the real coordinator over 200 mixed records: 65 Start/Stop/hydrate records were dropped and all 115 non-eligible records stayed. At 80 operations the measured total was about 4.65M of about 5.24M characters. Under real daily use with pings, edits and Focus, the wall is still reachable, just later than before. Decision 45 does not state this explicitly. Action: add the residual to DECISIONS 45 and STATUS, then measure a realistic operation mix in TASK-046.
- MINOR: at persistent real quota, archiving cannot free room for a page-held capture. The cut runs only inside `commitProjection` (accounting-command.js:626). Drain runs `flushFailedCaptures` first (accounting-command.js:801), which throws quota, so nothing commits. Recovery therefore needs space freed outside accounting. Decision 45 acknowledges this only in general terms.
- MINOR: the page-held toast has no throttle (index.html:3446). With a page-held hydrate, `timeAckReconcile` → `hydrateAccounting` → `accountingOutcome(drain)` returns storage-full every 30 s and shows the toast each time. The copy is truthful; this is noise only.
- MINOR: test gaps. The committed tests never exercise the automatic `eligible` predicate or the `minEnvelopeChars` gate. The browser fixture contains only hydrates, and legacy is excluded by the pre-existing base filter. My scratch probe confirms both behave correctly. Spec test 1 (Path A) already passes on 6029be3, so it is a regression guard rather than red/green proof. Test 2 is red only on the count copy.
- MINOR: `retainUnconfirmedCompatibilityCaches` uses history images to recognise stale `ta3-entries` caches. A cache stale past an archived record could be classified as unknown and captured as a legacy record. That is fail-safe (retained, logging paused for review), but it would be a false recovery prompt. It is improbable because the committed value holds current versions.
- NIT: `verifiedByOwner` (index.html:2836) keeps copies of every archived record in page memory after they are dropped. In automatic mode the archive is not warmed (index.html:2909), so each reload re-puts the first batch. Every commit with more than 75 history records reads the full stored envelope for the threshold check (accounting-command.js:544).

### Commands (TMP/TEMP=D:/t; evidence D:/t/rev045/)
- `git diff --quiet 6029be3 HEAD -- tests/zz-perf-profile.spec.js` → identical (blob 8de432f1…). `node scripts/runtime-mirror.mjs --check` → OK (111 files). `git diff --check 6029be3..HEAD` → clean.
- `npx playwright test tests/zz-perf-profile.spec.js --workers=1` → 1 passed (4.4 min).
- Red: scratch worktree at HEAD with accounting-command.js, index.html and their www mirrors restored from 6029be3. `npx playwright test tests/accounting-storage-durability.spec.js --workers=1` → 1 passed, 2 failed: test 2 on the "2 accounting changes are held" copy, and test 3 on `dropped.length` 0. Green on HEAD → 3/3 passed (41.3 s). Scratch worktree removed.
- Accounting browser specs, all `tests/accounting-*.spec.js` except release-artifacts (TASK-046 pins) and the durability spec: 490 passed, 8 failed. All ten mandatory specs passed. 4 failures are in accounting-focus-acceptance-boundary.spec.js, which is the recorded 0/4 boundary ledger (TEST_REPORT TASK-039). The other 4 are in accounting-extension-mv3.spec.js and are environmental. After re-creating `test-results/`, 2/4 passed and the other 2 fail because historical commit 73739e9 is absent from this clone (`git show` fails).
- Accounting node regressions (orphan-recovery, wall-observation, history-cut, storage-full, capability, staged-effects, storage-growth, current-gates, native-projection) → 195/195. `npm test` → exit 0, node 2561 pass / 0 fail / 1 existing skip.
- Reviewer probe D:/t/rev045/probe/eligible.probe.cjs → 2/2: non-eligible kinds are never dropped, and nothing is cut below 3 Mi.
- Review-environment incident (no repo effect): removing the scratch worktree followed its node_modules junction and emptied the shared `task-043-household-my-day/node_modules`. The task-044 and meal-prep worktrees link to it. I restored it with `npm ci --offline --legacy-peer-deps` from the local npm cache (602 packages, lockfile identical, no network). Under the allow-scripts policy the install scripts for protobufjs and sharp did not run. All tests above except the perf, red and green runs were run after the restore.

gate: **approved (held)**. This is red zone: accounting history retention, capture durability and storage-full behaviour. The human merges. There is no auto-merge, push or deploy.

## TASK-046 · Combined-tree qualification (TASK-044 + TASK-045) · 2026-11-26
reviewer: independent Claude review subagent (did not run TASK-046). HEAD fc29b2c (pins 0dc2a07, runtime 120dba5); pre-TASK-045 baseline 6029be3. Evidence: D:/ChronaSenseQualificationEvidence/20261126-queue/task-046/ (my outputs under `review/`, prefixed `rerun-`/`probe-`). The earlier release-bytes, pins and packaged-62 review (`review/VERDICT.md`) is not repeated here.
verdict: **APPROVE**. No blocking finding. The open mandatory intermittent is **PRE-EXISTING** and was reproduced deterministically on the pre-TASK-045 tree. It is a race in the test's reload sync point, not a TASK-045 effect. TASK-045 is **not** sent back for rework. The flake is routed to TASK-047 as a genuine required-CI failure to fix at its root.

### Part A — gate claims checked against raw evidence
- Wider aggregate: I reran `node scripts/ci-test-report.mjs legacy 1107 claude-wider-1.json wider-2.json claude-wider-3.json wider-4.json`. It exited 0: ran 1107, passed 808, 297 known, 2 history-only, **0 outside**, 17 baseline now passing. The output is byte-identical (sorted) to `claude-wider-aggregate-1107.log` (`review/rerun-wider-aggregate-1107.log`). Shards 2 and 4 are Codex's concurrent runs, but they are classifier-clean.
- Household: I reran it on HEAD (`emulators:exec … household-my-day.spec.js --workers=1`, ports 9099/8080 checked free first) and got **11/11 in 44.2 s**, exit 0 (`review/rerun-household-head.{log,json,exit}`). The recorded `claude-household-{head,pre045}.json` stats show 11 expected, 0 unexpected, 0 skipped and 0 flaky each.
- Worker: `claude-worker-test-worktree.log` shows tests 55, pass 55, fail 0, and the exit file shows 0.
- Owner-stall: both `claude-owner-stall-*.json` show 1/1. The two reports differ only in the random stuck-capture op id and the tree path, which supports the environmental (trace-teardown under load) classification.
- Mandatory classification: `mandatory-recheck-1` is 186/0 and `mandatory-3` is 40/0. O1 failed with the same `toMatchObject` assertion in loaded `mandatory-o1-pre-task045` (pre-TASK-045) and `mandatory-2-diagnostic` (HEAD), and passed 12/12 quiet on each tree. Both 490 classifier combinations reproduce as reported: FAIL 489/1 with `claude-mandatory-2`, and PASS 490/490 with `claude-mandatory-2-head-r2`.
- Doc correction (non-blocking; fix in the next TEST_REPORT append): the TASK-046 text says TASK-045 "warms the history archive on coordinator creation by default". That is wrong. index.html:2909 warms only when `historyCut.minEnvelopeChars == null`, which happens only under the explicit `ta3-accounting-flag-history-cut` flag. The default policy sets `minEnvelopeChars` (index.html:2785-2788), so there is no warm-up by default. The TASK-045 review already says this.

### Part B — `accounting-staged-effects.spec.js:1474` Focus terminal Learning frontier (reload → wait for `pomodoroPhase === 'break'`)
- Code analysis of the TASK-045 hunks on this path. None of them can delay or block the restore:
  - beforeunload (index.html:5208-5212) acts only when `failedCaptureCount() > 0`. This test's fault throws on the **envelope** save (`AccountingCommand.BASE` with `effectReceipts`). Only `capture()` intake failures populate `failed` (accounting-command.js:264-270), so the count is 0. The trace has no dialog, and the reload completed normally.
  - Archive warm-up does not run by default (see above).
  - `cutHistory` (accounting-command.js:538-544) now runs on every commit, but it returns at `plain.length <= keep + batch` (50 + 25). That is far above this fresh world's history, so there is no IndexedDB access and no lock.
  - The `hydrateAccounting` change (index.html:3270-3271) adds work only when the page holds captures. `renderTimeAckStatus` adds an O(n) count only.
  - Nothing new awaits on the account lock before `restoreFocusSession`.
- Trace of the failing quiet run (`claude-focus-terminal-trace/`):
  - Reload returned at +427 ms, and the waitForFunction was issued about 46 ms later.
  - The screencast at about +92 ms after load shows the BREAK overlay ("take a breather · 5 min").
  - By +179 ms Focus had ended: the Learning Plans "FOCUS COMPLETE — Did you finish this step?" was showing while the Stop ACK was still held.
  - The page then made only a few `GET rooms/uid_alice.json` reads and stayed idle until the timeout.
- Mechanism (instrumented probe; scratch copies of both trees outside the repo, with only this test patched — `review/probe-patch.py`):
  - The probe logs `pomodoroPhase`, `readyState` and the coordinator's queue/effects/committed-focus on every 1 ms tick and every requestAnimationFrame.
  - On both trees the sequence is the same: `readyState complete` → about 20 ms later `break` → about 90 ms later committed focus `none`, while the `focus-learning-finish` op is still queued (`1/1/break` → `1/1/none` → `0/0/none`). The phase never returns to `break`.
  - **Break window: HEAD median ≈89 ms (81–230, n=20); pre-TASK-045 median ≈88 ms (55–253, n=20).** All 40 probe runs caught the window, about 35 ms after `reload()` returned (`review/probe-phase-{head,pre}.log`).
  - Why the window closes before the ACK: the test's route handler calls `route.fetch()` **before** awaiting `held`. The old page's Stop PATCH therefore reaches the emulator, and only the HTTP response is delayed. The reloaded page reads the authoritative room state through unheld GETs and settles the finish. The test's 'break' wait therefore races that read by tens of milliseconds. The race is lost only when the Node→CDP round trip after `reload()` takes longer than the remaining window, which is plausible late in a 264-test single-worker shard or under load. That fits the history: failures only in full shards (one under load), 0/100 isolated.
  - Deterministic reproduction: the same test with a 200 ms pause between `reload()` and the unchanged waitForFunction **failed 4/4 on HEAD and 4/4 on pre-TASK-045**, with the identical `page.waitForFunction: Test timeout of 30000ms exceeded` (`review/probe-delay200-{head,pre}.log`).
  - The full-shard counts (HEAD 2/5 vs pre-TASK-045 0/3) are not significantly different (hypergeometric P≈0.36). No extra shard runs were needed after the deterministic reproduction.
- Classification: **PRE-EXISTING** test-timing race on a transient UI state. It is not caused by TASK-045, and TASK-045 does not measurably widen it.
- Product note: the app's behavior here is not a time-loss defect. The server already holds the Stop, and the test's later assertions (one entry, timer stopped, original id in history) still apply.

### Carry-forward to TASK-047 (not TASK-046 must-fix)
1. This mandatory test is a real required-CI flake, observed in about 1 of 4 full shard-2 runs. Fix the test's sync point at its root. Either hold the PATCH before it reaches the emulator, so "delayed Stop ACK" is actually delayed server-side (verify the rest of the test still means what it says), or replace the transient `pomodoroPhase === 'break'` wait with a stable restored-state condition. A timeout pad, retry or skip is not acceptable (TASK-047 constraints). Prove it with the 200 ms-pause variant passing and repeated full shard-2 runs.
2. Correct the archive warm-up wording in TEST_REPORT (above).

Scratch trees D:/t/rev/{head,pre} were removed after their node_modules junctions were deleted first. The shared node_modules is intact (404 entries). No repo file changed except this entry and TASK-046's status. Nothing was committed, pushed or deployed.

gate: **approved (held)**. This is red zone: the combined candidate carries TASK-045 accounting retention and capture-durability runtime and refreshed release pins. The human merges, and there is no auto-merge.

---

## TASK-049 review · 2026-11-26 · Life Ledger worker stale-lock takeover race

reviewer: independent Claude review subagent (did not write TASK-049). Range b227889..806854c (fix 015c298, docs 806854c). Scratch trees: D:/t/rev049/{old,new} (`git archive`, no worktree, no node_modules link). My outputs: D:/ChronaSenseQualificationEvidence/20261126-queue/task-049/review/.
verdict: **CHANGES REQUIRED**. The fix closes the TASK-047 interleaving, and every gate reruns green. But the invariant it claims ("at most one holder, even when several contenders race the same stale lock") is still breakable, deterministically, through an empty lock generation. TASK-049 goes back to `status: codex`.

### Must-fix
1. **Byte identity is not generation identity for an empty (or not-yet-written) lock, so two workers can hold the lock at once.** Locations: `scripts/life-ledger-sync-worker.mjs:197-217` (`judgeLockFile`), `:238-245` (byte-only re-check under the claim) and `:183-192` (`tryCreateLockFile`: the file exists, empty, between `open('wx')` and `writeFile`). DECISIONS #46 argues that "every lock and claim payload carries a random nonce, so two generations never share bytes or a claim name". That holds only once the payload is written. Every empty generation has bytes `""` and the same claim `<lock>.claim-<sha256("")>`.
   - Scenario: L is empty and its mtime is at least 30 min old. That happens when a worker was killed or crashed between `wx` and the write, or when the write failed. `tryCreateLockFile` leaves the empty file behind on a write error.
     1. D reads `""`, stats it as aged, and judges it stale. D then stalls after its `stat`.
     2. B breaks L, runs and releases.
     3. X opens a new L with `wx`. The file is still empty because X has not written yet.
     4. D takes the now-free claim, re-reads L, finds `"" === judged.raw`, and renames X's live lock to a tombstone. D creates its own lock and proceeds.
     5. X writes into its now-unlinked handle and also proceeds.
     6. Both are inside the lock. X's later `releaseLock` also deletes D's lock.
   - The same ABA works one level up on an aged empty claim file.
   - Reproduced: `review/probe-empty-generation-aba.mjs` (test-side fs wrapping only, gates on D's first `stat`) against 806854c printed **5/5 "VIOLATION: two holders at once"** (`review/probe-empty-generation-aba.log`). Pausing D after its `readFile` instead happens to be saved, because the later `stat` reads X's fresh mtime. That is luck of ordering, not design: `judgeLockFile` judges bytes from one file and mtime from whatever file is there later.
   - Production likelihood is low: the scheduler uses `IgnoreNew`, and the race needs three runs plus a crashed empty lock. But it is exactly the class of race the task's objective rules out, and the DECISIONS #46 proof is wrong as written.
   - Required: bind the judged generation to the file, not only its bytes. Choose one of the two approaches below, or another one that closes the race:
     - (a) Read bytes and identity from **one open handle** (`fh.stat()` + `fh.readFile()`; ino + birthtimeMs + size). Under the claim, re-open, then require the same identity and the same bytes, and re-judge staleness before the rename.
     - (b) Make a lock appear only with its full payload. Write a unique tmp, `fs.link(tmp, lock)` (EEXIST if held), then rm the tmp. A live generation is then never empty or partial, so it can never equal a crashed one's bytes.
   - Add a deterministic regression for this interleaving. It must be red on 806854c and green after the fix, with test-side injection only. Correct the DECISIONS #46 argument to match. Keep everything else.

### Checked and fine (non-blocking notes)
- **Interleavings, 2-3 contenders (non-empty generations).** Each case below behaves correctly:
  - Fresh lock with a live pid: never claimed.
  - Dead-pid lock: exactly one claimant removes it. A late claimant re-reads and gets ENOENT or different bytes, and backs off. This is the TASK-047 case, now covered by the red-to-green regression.
  - Claimant crashes before the removal: its claim is judged dead and broken through `claim.claim-*`.
  - Claimant crashes after the removal: L is created directly. The orphan claim is never consulted again.
  - Nested dead claims: recovered (new test 2).
  - Release racing a takeover: not reachable, because a live holder's lock is never stale.
  - Windows: rename of a file open with FILE_SHARE_DELETE is allowed, and the tombstone frees the name. A non-ENOENT read, rename or rm error (AV handle, delete-pending) now throws before any lock is held: the process exits non-zero, leaves nothing behind, and the next cycle retries. That is not a wedge. Direct `rm` in `releaseLock` is pre-existing.
- **Recursion** grows a level only per dead breaker. The filename component grows by 23 chars per level, so it hits ENAMETOOLONG at about 10 nested dead breakers. That would throw, not wedge, and is theoretical.
- **30-minute mtime ageing (behavior change).** A legitimate just-created lock is never misjudged by mtime: it would need a clock skew of 30 min or more inside a microsecond window. A crashed empty lock now costs about 2 skipped cycles (scheduler 15 min, `IgnoreNew`, 5-min limit). Skipped runs return at `:415-417` before writing any run log or outbox status, so the UI shows the last status. That is acceptable. Optional: have `tryCreateLockFile` remove its own file when the write fails. Approach (b) above makes this moot.
- **Leftovers.**
  - Orphan `.claim-*` files are inert, except the shared empty-generation claim name (must-fix 1).
  - Retention never prunes them, but neither retention nor tmp-cleanup can delete a live lock or claim: tmp-cleanup touches only its two fixed `.tmp` names, and `LOCK_TOMBSTONE_RE` matches only `.stale-*`.
  - Claim tombstones use the lock prefix, so retention prunes them.
  - `isBackupsRootLockLive()` (`:266-275`) calls an unparsable lock not live, while the worker holds it for 30 min. The only effect is that tmp-cleanup may delete its two fixed `.tmp` names while a lock is empty or corrupt. No live writer can be writing them then. That is harmless, and it was out of scope.
- PID reuse and cross-host pid checks are pre-existing and outside this task.

### Reruns (mine)
- Red/green: the new test file against b227889's worker ran **18 pass / 3 fail**. The regression failed with `a late contender with a stale verdict must back off, not also proceed` (false !== true). Against 806854c it ran **21/21**.
- Existing tests unchanged: the numstat is +155/-0. The b227889 blob is a byte-identical prefix of the 806854c blob (26,561 bytes, LF; the 27,126 in CHANGELOG is the CRLF checkout). The worker has no test hooks: the injection wraps `fs.readFile` on the shared `node:fs/promises` object, test-side only.
- Loop: **150/150** consecutive `node --test scripts/life-ledger-sync-worker.test.js` runs, 21/21 each, 0 failures (`review/rerun-loop-150.log`). The implementer's `loop-200.log` shows 0/200.
- Siblings: chaos 11, health 13, intervention-latch-recovery 5, restore 15, retention 13, tmp-cleanup 7, worker 21, all exit 0 (`review/rerun-siblings.summary`).
- `npm test` (TMP=TEMP=D:/t): exit 0. Node runner 2,564 passed, 0 failed. Custom 455/455 (`review/rerun-npm-test.{log,exit}`).
- `npm run lint`: exit 0, 0 errors, 172 warnings (baseline).
- Scope: only the seven files TASK-049 lists changed.

No code or test changed. Nothing was committed, pushed, merged or deployed. The scheduler installer and `--apply` were not run. D:/t/rev047 was not touched.

gate: **codex (rework)**. When it is approved, it lands as `approved` (held): this queue disallows `done`.

### TASK-047 - Focus terminal Stop test fix 3d8c9f9 + required-CI reproduction (November 26, 2026)
verdict: APPROVE WITH NOTES (independent same-provider reviewer, scratch worktree at 3d8c9f9; not Guardian).
verified: original assertions unchanged, 4 added (tests/accounting-staged-effects.spec.js:1506-1512); old test was vacuous
  (page already idle in 8/8 instrumented pre-fix runs), fixed test holds `break` 16/16; exactly one Stop reaches the server
  before and after the fix (no hidden duplicate delivery; app uses no keepalive/sendBeacon). No timeout/retry/skip/config or
  runtime change in 8e8ece9..c18bb2a. Reruns: 200 ms-pause variant 16/16; full spec 260/260; mandatory shard 2 264/264 x2,
  0 flaky. TASK-047 quiet/ evidence set uncontaminated; unit/lock-race/packaged/worker/wider numbers match raw logs.
notes (non-blocking): N1 no focus-learning-finish case for "server applied Stop, reply lost across reload" (same path covered
  at :1735/:1198/:2223; optional follow-up). N2 original/reloaded split uses a `reloaded` flag, not request origin
  (theoretical). N3 TEST_REPORT "4/4 without the pause" has no raw log (covered by reruns). N4 hosted CI not run; unit job
  blocked on TASK-049 lock race.
evidence: D:/ChronaSenseQualificationEvidence/20261126-queue/task-047/review/VERDICT.md
risk gate: test-only but accounting/Focus coverage → `approved` (held with the candidate), once TASK-049 lands and the unit
  job is re-run.
