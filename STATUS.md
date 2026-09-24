# Session Log

Newest entry at top. Append after every session -- never edit past entries.
The top entry is the current **working memory** (where we are / next task / blockers).

---

## 2026-09-24 — Remaining Remote Cross-Account Isolation V1 (review candidate, NOT integrated)

Candidate on `fix/remaining-remote-account-isolation-v1`, from `origin/main` @ `c346388`. Cross-Store
Account Isolation V1 is **integrated** on `main` at that commit. Not pushed, merged or deployed.

Entries, settings/templates and legacy plans are now stored per account room (`ta3-entries:<room>`,
`ta3-settings:<room>`, `ta3-plans:<room>`). The sync metadata (`ta3-lv`, `ta3-last-sync`) and the
account timezone pin (`ta3-tz`) are scoped with them. A direct account switch tears down the previous
room and rebinds before sync. Every push is owner-guarded, and stale async work is bound to the account
that started it. The unowned pre-scoping keys are quarantined. Release token
`20260924-remaining-remote-account-isolation-v1`. Details in CHANGELOG.md.

**App-wide account isolation is still NOT complete:**
- Remote cross-room leak FIXED in this phase: entries, settings/templates, legacy plans.
- Local cross-account visibility PROVEN: learning plan, career/capability, daily routines, reviews,
  weekly reviews.
- Remote write path UNKNOWN: reviews, weekly reviews.
- UNKNOWN: focus redemptions, intention, timer/away state.

**Next:** strict independent review of this candidate. The local-visibility stores are a separate phase,
only on a fresh request.

---

## 2026-09-24 — Cross-Store Account Isolation V1 FIX FIRST corrections (review candidate, NOT integrated)

Candidate on `fix/cross-store-account-isolation-v1`, from `origin/main` @ `cfe8800`. Not pushed, merged
or deployed. Strict review of the first candidate `1edc639` returned FIX FIRST. The repository and sync
isolation passed; the blocker was the coarse-evidence editor. Its "close on rebind" only hid it, so a
keyboard Save after a direct A -> B switch wrote A's record into B's slot and B's room. Fixed in
coarse-life-evidence-ui.js: editor sessions and list actions are bound to the account room they were
opened for, stale saves fail closed, and rebind/close clears the fields and moves focus out. Release
token `20260924-cross-store-account-isolation-fix1`. Details in CHANGELOG.md.

Earlier phase: Operational Plan Account Isolation V1 is **integrated** on `main` @ `cfe8800`. The
CHANGELOG heading that still called it a candidate has been corrected.

**App-wide account isolation is NOT complete.** "Not remotely synced" is not the same as "account isolated":
- Remote cross-room leak PROVEN: entries, settings/templates, legacy plans.
- Local cross-account visibility PROVEN, not remotely synced: learning plan, career/capability,
  daily routines.
- Local cross-account visibility PROVEN, remote write path UNKNOWN: reviews, weekly reviews.
- UNKNOWN: focus redemptions, intention, timer/away state.

**Next:** targeted re-review of the FIX FIRST corrections. Isolating the stores above is a separate
phase, only on a fresh request.

---

## 2026-09-21 — Personal Day Cross-Device Sync — integrated

`main` was fast-forwarded from `b9e2de89e4ca07084fa7335b7b10270ce10a60a0` to reviewed candidate
`f128a164647f08e0233db0fdfacae1582211cb62` in an isolated integration worktree (strict review FIX
FIRST -> targeted re-review PASS). No reviewed commit was rewritten and the feature branch
`fix/personal-day-cross-device-sync-v1` remains preserved.

Behavior now on `main`:

- Personal Day configuration hydrates across devices of the same account.
- Startup attach ordering is safe (auth-before-module and module-before-auth both attach).
- A remote boundary arrival recomputes the authoritative My Day surfaces, not just Settings.
- A fresh device no longer falsely shows "Off" while the account has not yet been heard from.
- The Personal Day cache is account-scoped (`ta3-day-boundary-revisions-v1:<room>`).
- A foreign account's boundary revisions cannot be uploaded into another account's room.
- The old unowned legacy cache is quarantined (never adopted, read or pushed), not guessed into
  an owner; an account's scoped cache is populated from its own snapshot.
- Same-account offline use remains supported once the scoped cache has hydrated.
- Cloud schema and revision semantics are unchanged.

Not claimed: the installed Android phone is NOT fixed (its bundle has not been rebuilt/`cap sync`ed);
operational plans are NOT account-isolated; the app's local stores are NOT all cross-account safe.

**Next / HIGH-PRIORITY DEBT: the operational-plan store leaks across accounts (reproduced by the
reviewer).** Separate deferred debt: other unscoped local stores (entries, legacy plans,
commitments); CoarseLifeEvidenceSync startup attach race; `personal-day-boundary-live.js` double
module evaluation; Firebase listener error surfacing; cache-bust mixed-module window; Node/GitHub
Action deprecation notices.

Integrated verification: `npm test` exit 0 (1277 tests / 1276 pass / 1 known opt-in skip); focused
Node (repository 17, sync 32, live 41, cross-device 13, account-scope 23, plan-authority 72,
future-day-planning 28) all pass; focused Playwright **96/96**; full Playwright **692/692**; lint
0 errors / 38 existing warnings; 70-file runtime parity and diff checks clean. Nothing was written
to production Firebase, deployed to Firebase rules, built/deployed to Android, or manually deployed
to Pages. The protected primary README stayed byte-identical.

---

## 2026-09-19 — My Day UX Simplification V1 — integrated

`main` was fast-forwarded from `f99f5d06b24506e8fa781e692dccc99fcba32667` to reviewed candidate
`af78fc5a7ee4a0566935b6bd44beb1ca4b65d0d0` in an isolated integration worktree. No reviewed
commit was rewritten, and the feature branch remains preserved.

My Day is now the simplified daily command center: universal `+ Add`, direct future scheduling,
and planned tasks/commitments projected into one timeline with compact stale recovery. My Day
remains the authoritative planning target while factual timestamps stay local truth. Only an
explicit date selection invokes civil-date scheduling; refused task submits reset consistently,
and truncated My Days remain usable. Cross-day moves preserve stable identity and one canonical
location. So Far remains calendar-day evidence, and routines remain secondary with calendar-day
completion semantics. Unrelated deferred debt is not claimed as resolved.

Integrated verification: `npm test` PASS; required focused Playwright **85/85** (including
planning-continuity **46/46**); full Playwright **680/680**; lint 0 errors / 38 existing warnings;
70-file runtime parity and diff checks clean. Nothing was manually deployed, written to production
Firebase, or built/deployed to Android. The protected primary README remained byte-identical.

---

## 2026-09-19 — My Day refused-submit form-state correction (review candidate, NOT integrated)

Continued on `feat/my-day-ux-simplification-v1` from reviewed/pushed tip
`bd21c67848eeb18e7db3374b78f30ea6f42832d6`. Every refused task-form submission now resets the
date scheduling mode to the canonical item/anchor state shown by the re-rendered form. A retry
therefore cannot silently retain an explicit-date move after the visible date hint has reset.

Focused browser coverage proves Top-3 refusal/retry at 21:00 and 02:00, future-date refusal,
same-id Edit refusal, and historical-date refusal. Verification: focused Playwright **5/5**;
planning-continuity Playwright **46/46**; `npm test` PASS; full Playwright **680/680**; lint 0
errors / 38 pre-existing warnings; 70-file runtime parity, syntax, and diff checks clean. Nothing
was merged, deployed, written to production Firebase, or built/deployed to Android. The protected
primary README remains untouched.

---

## 2026-09-19 — My Day form date/time semantics final correction (review candidate, NOT integrated)

Continued on `feat/my-day-ux-simplification-v1` from reviewed/pushed tip
`cbe28990c892bf8460a7fdf9070ddc02a4c1e54a`. A truncated current My Day can now open and use
Add/Edit even when no date-only local-noon inverse exists. Untouched forms preserve their selected
authoritative target; clock entry resolves uniquely inside that target's half-open interval, while
an owner-edited civil date retains the existing explicit rescheduling contract. Today/Tomorrow
select targets rather than silently issuing date relocations, and repeated-hour DST ambiguity is
never guessed.

Focused model and browser regressions cover 04:00 and 18:00 overnight dates, inclusive start and
exclusive end, the 18:00→20:00 truncated case (untimed add, title/kind edit, 19:00, 09:00 refusal,
clear time), explicit same-id date relocation, historical refusal, and DST ambiguity. Verification:
Plan Authority **72/72**; new focused Playwright **6/6**; planning-continuity Playwright **41/41**;
`npm test` PASS; full Playwright **675/675**; lint 0 errors / 38 pre-existing warnings; 70-file
runtime parity and clean diff checks. Nothing was merged, deployed, written to production Firebase,
or built/deployed to Android. The protected primary README remains untouched.

---

## 2026-09-19 — My Day UX Simplification V1 FIX FIRST corrections (review candidate, NOT integrated)

Continued on `feat/my-day-ux-simplification-v1` from reviewed candidate `049bf8e`. The successful
My Day hierarchy and timeline projection are unchanged. The correction pass fixes arbitrary
boundary scheduling-date inversion, refuses direct Add/Edit into ended authoritative intervals,
and adds deterministic cross-store relocation revisions so ordinary stale source edits cannot
resurrect a second active location. Equal-sequence conflicting moves use stable writer/day facts;
a later explicit move increments the sequence and can supersede the earlier move.

Clearing task time now clears range-only metadata in both stores while preserving identity.
Inspect routines opens and focuses the existing secondary dialog. So Far is visibly labelled
`Calendar today` and remains calendar-day evidence. The protected primary README was not touched;
nothing was merged, deployed, or written to production Firebase. Verification: focused Node
**274/274**; corrected focused Playwright **54/54** after one synthetic-fixture race; full
`npm test` PASS; full Playwright **669/669**; lint 0 errors / 38 pre-existing warnings. Parity and
diff checks pass (70-file runtime closure; clean diff check), as recorded in `TEST_REPORT.md`.

---

## 2026-09-19 — My Day UX Simplification V1 (review candidate, NOT integrated)

Branch `feat/my-day-ux-simplification-v1`, created in an isolated worktree from verified
`origin/main` `f99f5d06b24506e8fa781e692dccc99fcba32667`. The protected primary worktree and its intentional
uncommitted six-line README change were not touched.

The primary My Day page is consolidated around `UP NEXT` and one timeline. Existing authoritative
plan items and commitments are projected into typed rows; untimed tasks occupy a bounded Anytime
lane and timed tasks occupy their actual clock position alongside, but never merged with,
schedule/template and actual-evidence rows. Universal Add supports direct Today/Tomorrow/date
scheduling. Timeline edits retain item identity and resolve moves through `PlanAuthority`.

Redundant normal-page surfaces are gone: standalone My Day summary, Today/Next switcher, large
Upcoming card, separate Top Priorities and Other Tasks, permanent Day Actions, standalone
Routines, Entry Actions heading, and Accountability heading. Stale recovery, So Far, and combined
partner/streak UI are compact. Full recovery, future browsing, partner detail, review, and routine
completion/management remain reachable through contextual or secondary surfaces.

No truth-model redesign: evidence remains evidence, a task checkbox creates no elapsed-time log,
routines and So Far retain calendar-day semantics, and Personal Day authority, commitment truth,
planning readiness/streak, partner sharing, and Firebase schemas are unchanged. No deploy or
production write was performed. See `TEST_REPORT.md` for verification.

**Verified:** focused unit baseline 211/211 and candidate 218/218; focused Playwright 59/59 plus
41/41 retained-domain regressions; `npm test` exit 0; full Playwright **661/661**; lint 0 errors /
38 pre-existing warnings; 69-file `www/` parity clean; `git diff --check` clean. One initial full
run failure was a wall-clock-sensitive test fixture that could cross Manila midnight; anchoring
its synthetic 3.6-hour dataset at local noon passed in isolation and in the clean full rerun. No
product failure was waived and no base/candidate flake reproduction was needed.

---

## 2026-09-19 — Post-integration follow-up: gated the extra Today rebuild

**On `main` at `8d20975`** (product code; one line in `plan-authority.js` plus its `www/` mirror).
Planning Continuity V1 + My Day itself is integrated at `e838321` — see the entry below.

The My Day work added a second full `renderToday()` when `plan-authority.js` finishes loading, so
the timeline could be rebuilt against the authoritative interval. That rebuild is now gated on
`PlanAuthority.enabled()`: an account with no boundary already had the correct calendar timeline
from the first render, so the second one was pure startup cost on the most common path.

**Why it was made.** CI on `main` passed at `e838321` and then failed twice at `b712643`, whose
product tree is byte-identical (docs-only diff), with a changing failure set: `pair-accountability`
F2 plus `today-persistent-sections` E on attempt 1, only `pair-accountability` F2 on attempt 2 —
both timeouts. Base `795ce08` re-ran green on the same runner. Locally both specs pass 96/96 and
32/32 and the full suite has been clean repeatedly. No causal link was found for the
persistent-sections failure (`applyTodayDetailsMode` only removes a body class and cannot re-open
a section), so this is NOT claimed as the fix for it; it is a real reduction in per-load work that
also narrows the surface under suspicion.

**Verified:** `npm test` exits 0; 67/67 across `my-day-timeline`, `planning-continuity`,
`personal-day-boundary`, `single-plan-authority`, `today-persistent-sections` and
`pair-accountability`; lint 0 errors / 38 pre-existing warnings; `www/` parity clean.
**CI on `main` HEAD `8d20975`: run 35433882487 SUCCESS; Pages 35433881976 SUCCESS.**

Residual: `smoke.spec.js:861` and these two specs remain occasional CI-load flakes; use the
base/candidate rerun discipline (an old run can be re-run to sample the base) before attributing
any of them to a change.

---

## 2026-09-19 — Planning Continuity V1 + My Day (INTEGRATED)

**Integrated to `main` at `e838321`** by pure fast-forward from `795ce08` — 13 reviewed commits,
no merge commit, no squash, no rebase, no force. The reviewed tree is byte-identical on main
(same tree object as the candidate), and `e838321` is an ancestor of `origin/main`. The feature
branch `feat/future-planning-capacity-v1` is preserved at the same SHA.

Review history: strict independent review → FIX FIRST (4 blockers) → bounded corrections
(`2949759`, `13ebeb8`) → targeted re-review PASS → owner My Day correction (`cd4c1ae`).

**Integration was done in a throwaway worktree** (`Time audit app - integrate-main`), since the
primary worktree is on `docs/phase12-personal-intelligence-design` with its own uncommitted
6-line README change. That change was not touched: README is the same blob (`2803bec`) in both
`795ce08` and `e838321`, so the fast-forward could not affect it, and the protected working copy
still hashes to `653dbd2`.

**Verified on the integrated tree, before pushing:**
- `npm ci --legacy-peer-deps` OK; `npm test` exits 0 (53 suites, 0 failures).
- Focused Playwright 59/59: `my-day-timeline`, `planning-continuity`,
  `planning-continuity-fixes`, `commitments-sync-wiring`, `personal-day-boundary`.
- Full Playwright **653/653, clean**. `smoke.spec.js:861` did not recur, so no base/candidate
  reproduction was needed this time.
- Lint 0 errors / 38 pre-existing warnings; `www/` parity clean; `git diff --check` clean.

**Deferred, and still not built:** reminders/notifications, recurrence, external calendar sync,
partner commitment sharing, Personal Day Boundary turn-off, commitments in the evidence
timeline, and UI for undismiss or for re-targeting an already-moved stale task (model-only).

**Open owner decision:** the Today Routines checklist is still calendar-day. Its completions are
keyed `[routineId, calendarDate]`, its actions key on that date, and its streak counts calendar
days — so it was not converted to My Day without a decision.

**Known limits carried forward:** a far-future day that exists only on another device is not
listened to until it becomes relevant or this device writes to it; two devices moving the same
stale task offline to *different* destinations can each create a copy (same-destination moves
converge to one); `smoke.spec.js:861` remains a pre-existing flake (base `795ce08` 27/30 vs
candidate 28/30 under equal repeats).

---

## 2026-09-19 — Planning Continuity V1: My Day timeline correction (review candidate, NOT integrated)

Same branch, `feat/future-planning-capacity-v1`. This is a bounded owner correction on top of
`8e4277e`. Nothing is merged or deployed; `main` is still `795ce08`.

**Defect.** With an 18:00 Asia/Manila boundary, the status block showed My Day as Fri 18:00 →
Sat 18:00, but Today's timeline showed calendar Saturday 00:00–24:00. It dropped Friday
evening's schedule and entries, and showed Saturday evening's, which belongs to the next My Day.

**Root cause.** `renderToday` built the timeline only from calendar-date inputs, all keyed by
`getViewingDateKey()`: entries, schedule blocks, gaps and coverage. It never consulted Plan
Authority. Its cache key was also the calendar date, so the 18:00 rollover never rebuilt it.

**Fix (`cd4c1ae`).** When viewing today with an active boundary, the timeline rows are built
from `PlanAuthority.current()`'s `[startMs, endMs)`:
- entries are clipped to that window;
- schedule blocks come from `PlanAuthority.templatesForTarget` (selected by start instant,
  de-duplicated);
- the cache key includes the day's id;
- the label reads "My Day · …".

There is no "after 6 PM" logic, and no timestamps are shifted. It also fixes a rollover gap
that existed before this phase: the 60-second watcher took its baseline from its first tick,
so a page opened just before 18:00 never rotated. The baseline is now recorded at render time.

**Unchanged on purpose:**
- legacy accounts;
- browsing history;
- So far, deep counts, closeout and reviews (calendar evidence);
- Planning Streak and readiness (audited: already on My Day ids; midnight does not roll them,
  18:00 does).

**Open owner decision:** the Routines checklist is still calendar-day. Its completions are
keyed `[routineId, calendarDate]` and its actions key on that date, so I did not change it
without a decision.

**Verification at `cd4c1ae`:**
- `npm test` exits 0 (53 suites, 0 failures). `my-day-window.test.js` passes 14/14.
- `tests/my-day-timeline.spec.js` passes 10/10.
- A focused 11-spec Playwright set passes 155/155.
- Full Playwright, run 1: 652/653. The failure was `smoke.spec.js:861` (`#retro-activity` empty,
  the known flake). It is equally flaky on the base under the same repeat counts: base `795ce08`
  passed 9/10 and 27/30; candidate passed 7/10 and 28/30.
- Full Playwright, run 2: **653/653 clean.**
- Lint: 0 errors, 38 warnings (the base count). www parity OK. `git diff --check` clean.

---

## 2026-09-19 — Planning Continuity V1 FIX FIRST corrections (review candidate, NOT integrated)

Strict review of `7e3e491` returned FIX FIRST. The corrections are on the same branch,
`feat/future-planning-capacity-v1`. Nothing is merged or deployed; `main` is still `795ce08`.

**This entry corrects the 2026-09-18 entry below.** That entry claimed commitment sync
(including the offline reconnect push) worked. **In production it did not:** the bridge read
`globalThis.fbRoomRef`, which is never on `window`, so no commitment ever synced. The unit
suite could not catch it because it builds the bridge with fake dependencies. Fixed in B1.

- **B1 (`2949759`, critical):** commitment sync now reads the room through
  `getChronaSenseRoomRef()`. It also attaches itself if the room was joined before the module
  loaded. New `tests/commitments-sync-wiring.spec.js` (6 tests) runs against the real signed-in
  path with a recording Firebase stub and checks: the room is resolved, a listener is registered
  on `rooms/<room>/commitments`, a transaction runs at `.../commitments/<id>`, remote updates are
  applied, and an offline write is pushed by storage.js's own reconnect handler. **Against
  `7e3e491` all 6 fail; with the fix all 6 pass.**
- **B2 (`13ebeb8`):** moving a stale task now respects the Top 3. A priority moved into a full
  Top 3 becomes an Other planned task, with the notice "Moved to Other planned tasks because your
  Top 3 is already full." Recovery-action errors are now visible; they previously went to a
  message line that only shows inside the commitment form.
- **B3 (`13ebeb8`):** "Make task" / "Make priority" via `PlanAuthority.setItemKind`, on Today's
  strip and in Prepare Tomorrow. The id and all other fields are kept. Promoting into a full
  Top 3 is refused. Readiness now follows each prepared item's current kind.
- **B4 (`13ebeb8`):** the duration input now allows 5 to 720 in 5-minute steps (it used to
  reject 15/30/45/60/90). A blank duration or note is sent as `null`, so it is cleared instead
  of silently kept.

**Docs:** APP_CONTEXT.md now:
- makes no claim of a UI to undo a dismissal or to reschedule an already-moved task (both exist
  only in the model);
- states that the Top 3 applies to stale moves and to promotion;
- records two limits from the review: a far-future day that exists only on another device, and
  simultaneous offline moves to different destinations.

**Verification at `13ebeb8`:**
- `npm test` exits 0 (52 suites, 0 failures). Focused suites green: commitments-model 43,
  commitments-sync 23, planning-capacity 17, stale-plan-recovery 33, plan-authority 48,
  planning-streak 21, shared-accountability 25, partner-view 15, planning-continuity-fixes 22,
  future-day-planning 28.
- Planning browser specs: 34/34 (planning-continuity 21, planning-continuity-fixes 7,
  commitments-sync-wiring 6).
- **Full Playwright: 643/643 in one clean run.** `smoke.spec.js:861` did not recur.
- Lint: 0 errors, 38 warnings (same as base). www parity OK. `git diff --check` clean.

**Next:** targeted re-review. Do not merge or deploy before it.

---

## 2026-09-18 — Planning Continuity V1 (review candidate, NOT integrated)

**Branch `feat/future-planning-capacity-v1`**, cut from `origin/main` `795ce08`, which was
verified live along with the repo root, common git dir, a clean tree and no staged files. It
lives in an isolated worktree, `Time audit app - future-planning-v1`. The primary worktree's
uncommitted README change, which belongs to another branch, was not touched. The branch is
pushed; nothing is merged or deployed. Full contract: `APP_CONTEXT.md` → "Planning Continuity V1".

**Slices:**
- S1 `ea6ffb8`: Top 3 priorities separated from planning capacity (`PlanItem.kind`; absent means
  priority).
- S2 `bc10532`: commitment model and repository that store the real instant, not a day.
- S3 `37d1767`: commitment sync with no date horizon, under the existing owner-only rules.
- S4 `aafcf04`: planning for any future personal day, plus the G1/G2/G3 sync and warning fixes.
- S5 `41cabd4`: "Unfinished from previous days" recovery across both plan stores.
- S6 `5d4d959` + `ec3b5fc`: the UI, plus a follow-up so existing test selectors stay
  unambiguous.
- S7: these docs.

**Verification (candidate, project-local tooling):**
- `npm ci --legacy-peer-deps` OK.
- New unit suites 144/144: planning-capacity 17, commitments-model 43, commitments-sync 23,
  future-day-planning 28, stale-plan-recovery 33.
- Existing focused suites green: plan-authority 48, personal-day-boundary-live 41 / -sync 32 /
  -model 46, operational-plan-sync 8 / -repository 12 / -model 34, plan-tomorrow 41,
  planning-streak 21, partner-view-model 15, shared-accountability-model 25, tomorrow-view 7,
  tomorrow-timeline 20.
- Full `npm test` exits 0.
- New `tests/planning-continuity.spec.js` 21/21. The Playwright specs that touch the plan strip
  (plan, plan-linkage-up-next, single-plan-authority, planning-continuity) pass 80/80.
- Lint: 0 errors, 38 warnings, the same count as at base. `check:www-parity` OK (69-file
  closure). `git diff --check` clean.

**Full Playwright: not one clean run. Reported as such, not as a pass.** Three full runs:
- **Run 1: 9 failures, all caused by this branch** (a second "Add" button and a second
  `.plan-count` in the plan strip). Fixed in the product in `ec3b5fc`, with no existing test
  edited.
- **Run 2: 629/630.** The failure was `learning-plan-ui.spec.js:2238` (element not found, a
  timing issue). I could not reproduce it: candidate 5/5 alone and 234/234 across the whole file
  ×3 with 4 workers; base `795ce08` 10/10. No learning-plan file is changed.
- **Run 3: 629/630.** The failure was `smoke.spec.js:861` ("editing an auto-logged schedule…").
  It **fails on base too**: base `795ce08` 7/10, candidate 8/10, same error. The base was checked
  in a temporary detached worktree, since deleted and pruned.

**Findings recorded along the way:**
- Re-proposing the *same* boundary time is not a no-op. It adds a revision that re-identifies
  later days, and the widened boundary-change warning now reports that.
- Pre-existing, not fixed: `plan-tomorrow-model.validPlanDate('2026-13-01')` throws a RangeError
  instead of returning false. No caller currently passes such a value. The new
  `validCommitmentDate` guards against it.
- index.html's `settings` and its item-stamping helper are not on `window`. New modules must read
  them through `getOperationalPlanAppContext()`.

**Next:** independent strict review of `feat/future-planning-capacity-v1`. Do not merge or
deploy without that review, and do not start Phase 12.0B or the Boundary Turn Off work without
a fresh request.

---

## 2026-09-18 — Personal Day UX V1.1 + Partner View Provenance Fix (integrated)

**Integrated to `main` at `0bf7a76`** by fast-forward from `edf4122` (4 commits: `0bb5ff6`,
`66cc287`, `8d1781b`, `0bf7a76`; no merge commit, no rebase, no force). The reviewed feature
branch `feat/personal-day-ux-cleanup-v1.1` is pushed and preserved at the same SHA.

**What changed.** Terminology cleanup on top of the Single Plan Authority + Personal Day
Boundary V1 work below: a custom-boundary account now reads "Plan next personal day" /
"Prepare next personal day" / "Starts today at 18:00" immediately on enabling an upcoming
boundary, before it has taken effect -- across the Plan Tomorrow modal, the hamburger menu,
the Tomorrow tab, the Today quick action, the closeout card, and the review-flow action.
Legacy accounts keep "Tomorrow" wording unchanged everywhere.

**Partner View FIX FIRST correction.** Independent targeted review found that Partner View had
been labeling the PUBLISHER's shared upcoming plan using the VIEWER's own local
`personalDayBoundaryConfigured()` state -- truthful only when both accounts share the same
boundary configuration, and mislabeling the publisher's actual plan in the other two of the
four publisher/viewer combinations (publisher-custom/viewer-legacy and
publisher-legacy/viewer-custom). The shared wire payload carries no publisher boundary flag,
and no schema change was made to add one -- out of scope for this correction. Partner Card and
the Partner View screen now use a fixed, provenance-neutral **"Upcoming plan"** label (empty
state: "No upcoming plan yet") that never branches on any local/viewer signal, closing the
mislabel for all four combinations. Two now-pointless render-trigger calls in
`personal-day-boundary-live.js`, which existed only to keep the old viewer-dependent label in
sync, were removed as part of the same correction. Re-reviewed PASS.

**Verification against the integrated ref** (`0bf7a76`, project-local tooling): focused
Playwright (`personal-day-boundary`, `partner-view`, `wife-shared-accountability`,
`partner-view-mobile-navigation`, `single-plan-authority`, `tomorrow-view`,
`plan-tomorrow-ui`) 90/90; `npm test` exits 0, 1027 checks across ~70 files, 0 failures; full
Playwright suite 609/609 on a clean run (two earlier runs in the same session surfaced
unrelated transient failures under 6-way parallel load in `daily-routines-ui`,
`focus-reload-recovery`, `guided-measurement-loop`, `install-interruption`, and
`smoke.spec.js` -- all reproduced as passing in isolation with a single worker, and GitHub
Actions' own clean runner ran the identical suite green, so these are local worker-contention
flakes, not regressions); `npm run lint` 0 errors (38 pre-existing warnings); `npm run
check:www-parity` OK; `git diff --check` clean. Install with `npm ci --legacy-peer-deps`.

**GitHub Actions CI on `main` is green for this push** -- run `35383941016`, head SHA
`0bf7a76`, conclusion `success`, all steps passed (unit tests and smoke tests included). Pages
build and deployment succeeded automatically as a consequence of the `main` push; no manual
deploy, no Firebase write, and no Android build were performed as part of this integration.

**Known non-blocking, reconfirmed during this integration (not fixed here, per scope):**
`tests/partner-view.spec.js:613` remains wall-clock-sensitive (seeds ~3.6h backward from real
`Date.now()`, undercounting near Asia/Manila midnight) -- observed both failing and passing
across different runs in this session purely as a function of real clock time, and reproduced
with an identical count against `origin/main` under equivalent clock conditions before
integration. Same defect first documented at integration time in the entry below.

---

## 2026-09-18 — Single Plan Authority + Personal Day Boundary V1 (integrated)

**Integrated to `main` at `8914751`** by fast-forward from `9f5773e` (14 commits, no merge
commit, no rebase, no force). The reviewed feature branch
`feat/single-plan-authority-personal-day-v1` is pushed and preserved at the same SHA; the
earlier `feat/personal-day-boundary-live-wiring-v1` is preserved unchanged at `677931f` for
provenance. Independent strict review returned FIX FIRST on one defect (below), which was
corrected in `8914751` and re-reviewed PASS.

**What is now live.** The adjustable Personal Day Boundary ships: a user enables it once and
can change the start time and its timezone afterwards, prospectively. The graveyard case works
end to end — at 08:00 the owner prepares the personal day beginning at 18:00 that same calendar
date, that exact plan becomes current at 18:00, calendar midnight does not rotate it, and the
next personal day begins at the following 18:00. Custom `00:00` remains an operational boundary,
not a return to legacy, and there is deliberately no Disable / Return-to-legacy affordance in V1.

**One plan authority.** `plan-authority.js` is the single access layer every user-facing planning
consumer resolves through. It speaks in authoritative-day targets rather than bare calendar
dates, and authority always comes from `resolvePlanAuthority()` plus the governing boundary
revision — never from which store happens to hold data. The second editable planning surface
introduced during Live Wiring V1 is gone: Today's own priorities strip edits the current
authoritative day and Prepare Tomorrow edits the upcoming one. Planning Streak, tomorrow-ready
state, Daily Reconciliation, routine/template participation, Partner View, Review Plan vs Actual
and calendar-date history all resolve through authoritative-day semantics. Two product rules
were settled this milestone: a routine is owned by the personal day containing its own start
instant, or — for untimed routines — a 12:00 noon anchor on its own calendar date resolved in
the routine subsystem's own timezone; and a calendar date is a history lookup key, so a history
screen shows every authoritative day overlapping it, read-only and labeled by its real interval,
never merged into one invented plan.

**Legacy accounts are unchanged.** An account that never enabled a boundary keeps calendar-day
behavior, keeps `plans[dateKey]` as its authority, calls the existing `planningStreak()`
function, and creates no boundary revision, no operational record and no listener merely by
using the app.

**Prepared Plans.** When a boundary change would push an already-prepared future personal day
out of Now/Upcoming, the Settings panel names that day before the change is saved, and the plan
stays discoverable under Prepared Plans on Today — never deleted, moved, copied or merged.

**FIX FIRST defect corrected before integration.** The enabled-account Planning Streak `best`
was capped at 400 authoritative days by a traversal guard, silently shortening real historical
runs (measured 350 instead of 450 on a synthetic history). The walk now terminates on available
history — the earliest instant either store can still speak for — plus a structural no-progress
guard, so `best` is exact and bounded by data rather than by a constant.

**Verification against the integrated ref** (fresh worktree at `8914751`, project-local
tooling): `npm test` exits 0 — 1027 `node --test` checks pass with 1 opt-in control skip
(requires `CROSS_REPO_COMPAT_CONTROL_PROOF=1`), plus 453/453 from the plain-`node` suites; full
Playwright 600/600; focused suites plan-authority 48/48, personal-day-boundary 136/136,
operational-plan 54/54; `npm run lint` 0 errors (38 pre-existing warnings);
`npm run check:www-parity` OK; `git diff --check` clean. Install with
`npm ci --legacy-peer-deps` — plain `npm ci` still fails on the pre-existing peer-dependency
conflict.

**GitHub Actions CI on `main` is red, unchanged by this work.** The same three
`obsidian-life-ledger-writer` tests fail on the Linux runner before and after this integration
(they assert denial of hardcoded Windows vault roots, which cannot resolve there): 453 tests,
450 passed, 3 failed — identical on run `35128378788` (previous main commit) and `35294888075`
(this one). Pages build and deployment succeeded automatically.

**Known non-blocking technical debt carried forward (not fixed here):**
- Exact enabled-account historical streak computation is O(days since the earliest stored
  history) — roughly 3.4 ms per day locally, cached per minute and invalidated on writes and on
  inbound remote merges. If real-device performance ever becomes a problem, deriving run lengths
  from the prepared records directly (rather than walking every day) is the natural optimization;
  exactness must not be traded back for a horizon.
- `operational-plan-model.js` contains three pre-existing literal NUL delimiter bytes, which make
  Git classify the file as binary in diffs. Edit it byte-safely.
- Separately identified, not attributable to this feature: two wall-clock-sensitive Playwright
  tests. `tests/partner-view.spec.js:613` fails when the real clock is within ~3.6 h after Manila
  midnight, and `tests/plan.spec.js:224` fails in the first ~50 min after UTC midnight. Both were
  reproduced failing on the pre-integration commits under the same conditions and pass outside
  those windows.

**Phase numbering unchanged.** This is independent-track work completed before Phase 12.0B.
Phase 12.0B (Android runtime compatibility + offline cold start safety) is still the next
Phase-12-specific step and is still NOT started.

---

## 2026-09-16 — Documentation reconciliation (docs only, no runtime/code/test changes)

**This entry supersedes the "Next task: Phase 12.0B ... NOT started" framing below.**
Phase 12.0A (2026-09-06 entry below) was real, but it was **not** followed directly by
Phase 12.0B. Instead, 47 further commits of independent, ungated feature-branch work
landed on `main` between `a80c4a1` (Phase 12.0A housekeeping) and `14a2031` (current
`origin/main`), none of it part of the Phase 12 Personal Intelligence design. `STATUS.md`,
`CHANGELOG.md`, `planning/ROADMAP.md`, `APP_CONTEXT.md`, and `CODEMAP.md` had not been
updated to reflect this and still read as if Phase 12.0A were the latest checkpoint.

**Milestones integrated since Phase 12.0A** (verified against live `git log`, not
inferred from branch names): Coarse Life Evidence V1 (`2948e2e`), Coarse Life Evidence
Durability V1 (`4e95098`), Phase 6I/J Review Reconciliation (`02bc5d1`), Plan Linkage +
Up Next Ordering V1 (`724f305`), Onboarding Rewrite V1 (`baa001b`), Motivation Pressure
Cleanup V1 (`57ce9aa`), Shared Access Hardening V1 (`6d491e6`), Time Truth V1
(`e86bc2b`), Timeline Truth Follow-up V1 (`c80134d`), Wife/Shared Accountability V1
(`d8761e4`), Scheduled Auto-Log Reliability V1 (`6de1260`), Partner View V1 (`5096abe`),
Today Persistent Sections V1 (`931c40c`), Plan Tomorrow Quick Time V1 (`3345c64`), Daily
Reconciliation V1 (`ee1fd1a` + review-fix `3463126`), Tomorrow View V1 (`73eefb8`), Plan
Time Range + Faster Scheduling V1 (`980129a` + `fc68b12`), Tomorrow Timeline Preview V1
(`45fce6a`), Partner View mobile navigation V1 (`b0b3ab8` — the planning-reminder half
was explicitly held, not shipped, see `da4e332`), Personal Day Boundary Foundation V1
(`76f04ff` + `e045d50`), and Personal Day Boundary Persistence + Operational Plan
Authority V1 (`6e624b5` + hardening `a1982ad`/`444f3eb`/`14a2031`). Full detail in
`CHANGELOG.md`.

**Roadmap sequence verified, not changed.** `docs/PHASE12_PERSONAL_INTELLIGENCE.md`
(§18/§19) still specifies 12.0A → 12.0B → 12.1–12.4 (deterministic engine) → 12.5
(Claude phrase-only layer), and nothing in the 47 intervening commits touches Phase 12
code. **Phase 12.0B (Android runtime compatibility + offline cold start safety) is
still the next Phase-12-specific step and is still NOT started.** A stale local-only
branch `fix/phase12-0b-android-runtime` (worktree `chronasense-phase12-0b`, tip
`a146565`) exists from far behind current `main`; it is an unfinished, unmerged
reference implementation only — not suitable for direct integration. Future 12.0B work
should be rebuilt against current `main`, not rebased off that branch.

**Test accounting (independently rerun today, not copied from the prior recon
hypothesis of "910/909/1"):** `npm test` exits 0. Aggregating every `node --test`
invocation in the `test` script: 917 tests total, 916 passed, 1 skipped, 0 failed.
Thirteen additional suites run via plain `node <file>.js` (not the `node --test`
runner) contribute 453 further assertions, all passing (suite exits 0; `npm test`'s
`&&`-chained script would abort non-zero on any failure). The lockfile-clean
`npm ci` fails in a fresh worktree on an unrelated pre-existing peer-dependency
conflict (`@codetrix-studio/capacitor-google-auth` wants `@capacitor/core@^6`, root
has `^8`); `npm install --legacy-peer-deps` was used to verify tests only, and no
`package.json`/lockfile change was made or committed.

**Known non-blocking technical debt carried forward (not fixed here):**
`personal-day-boundary-sync.js` initializes its transaction `outcome` variable
outside the Firebase transaction callback. Deferred to the next intentional
production-code change in that file, per explicit scope for this phase.

**Documentation still not fully current — deliberately not expanded further here:**
`CODEMAP.md` (module-by-module structural reference) has not been updated with
entries for the newer modules (`tomorrow-view-*`, `partner-view-*`,
`personal-day-boundary-*`, `operational-plan-*`, `shared-accountability-*`, etc.) —
doing so at its existing per-module technical depth is a substantial task of its own,
out of scope for this bounded reconciliation pass. `APP_CONTEXT.md`'s "Current Repo
State As Of This Update" section (further down that file) is a frozen Phase 11.5
snapshot (HEAD `1fe439a`, 2026-09-04) and was left as historical record rather than
rewritten; a pointer note was added directing readers to this file for current state.

**This session's scope:** documentation only. No `.js`/`.css`/`.html`, tests, Firebase
config/rules, Android/Capacitor code, adapters, dependencies, or build tooling were
modified. Nothing was merged to `main`, pushed, or deployed. Done on an isolated
worktree/branch (`docs/current-state-reconciliation-v1`) from `origin/main`
(`14a2031`) — the primary worktree's pre-existing uncommitted `README.md` change (on
`docs/phase12-personal-intelligence-design`) was left completely untouched.

**Next task:** independent review of this reconciliation pass, then resume Phase
12.0B (Android runtime compatibility + offline cold start safety) as a fresh build
against current `main` — NOT started by this session.

---

## 2026-09-06 — Phase 12.0A (static root↔www parity + safe tooling) integrated

**Phase 12.0A is built, independently reviewed (verdict: PASS), and integrated to
`main`** — fast-forward, `main` now `922297d4e4b1748d7b6f69cc3ca33c90a6f04828`
(implementation) on top of `bf95046` (approved Phase 12 design doc, also now on
`main`). Built on branch `fix/phase12-0a-www-runtime-parity` in a worktree from the
approved design commit; branch preserved, not deleted.

What shipped: `scripts/runtime-mirror.mjs` computes the browser-runtime dependency
closure live from `index.html` (`<script>`/`<link>`/`serviceWorker` + transitive
local ES imports) — 31 files — and mirrors it into `www/` byte-for-byte (`--check` /
`--write`); `sync.bat`/`sync.sh` are now thin mirror/check-only wrappers with **no**
`git add`/`commit`/`push`/`cap sync` path (the old unconditional-push-to-main
pipeline is gone); `scripts/deploy-release.ps1` is the sole, explicit, opt-in
`cap sync android` path (refuses `main`, dry-run by default, no VCS mutations,
never run yet); `www/` gained the 8 missing module entrypoints + 15 transitive
modules + `capability-career.css` (Learn/Career/Life/Next/Life-Ledger-export/sync
views were previously absent from the Android bundle entirely), and dropped 3
stale dev-only copies. Parity is enforced by `scripts/runtime-mirror.test.js` (14
tests) + two live guards in `test.js`, wired into CI (`check:www-parity`).
Verified post-integration: runtime-mirror tests 14/14, `node test.js` 444/444,
`npm test` pass, lint 0 errors / 19 pre-existing warnings, smoke 217/217 — no
regressions. No Android runtime compatibility work; no APK; no Personal
Intelligence code.

Non-blocking observations carried forward (not fixed in 12.0A, not blocking): the
`../` escape-reporting path in `runtime-mirror.mjs` has no direct unit test;
empty-directory cleanup after removing stale `www/` files isn't automatic;
`package.json`'s `"sync": "npx cap sync"` script is a residual, separate from the
new safe tooling.

**Next task: Phase 12.0B** (Android runtime compatibility + APK smoke — feature-
detect `showDirectoryPicker`/browser-only APIs, resync any further drift, manual
APK smoke checklist). NOT started.

Base: `main` @ `922297d4e4b1748d7b6f69cc3ca33c90a6f04828`. `README.md` remains
intentionally ` M` (stale identity reference) — untouched, not staged.

---

## 2026-09-06 — Phase 11.8 integrated; Phase 12 Personal Intelligence design fixed

**Phase 11.8 is integrated to `main`** (`bc552ca`) and its independent review is done —
the review fix `254ab57` is the current HEAD (`origin/main` == HEAD). The entry below is
stale: "(built, NOT integrated)", "Stop for independent review; do not push main / integrate /
start Phase 12", and "Next task: independent Phase 11.8 review" no longer hold; this entry
supersedes them. Test count is **26** attention-signal tests (the "24" below predates the
review fix). `CHANGELOG.md`, `planning/ROADMAP.md`, and `APP_CONTEXT.md` (Phase 11.8 status
lines) corrected accordingly.

**Phase 12 — Personal Intelligence v1** went through an independent adversarial design review
(verdict: FIX FIRST — direction accepted, 14 bounded fixes). The corrected design is now a
committed document: `docs/PHASE12_PERSONAL_INTELLIGENCE.md`, on branch
`docs/phase12-personal-intelligence-design` (this pass — documentation only, not merged).
Key shape: extend Cross-Domain Intelligence as the single recommendation engine (no parallel
ranker); deterministic v1 shipped and reviewed **before** any Claude layer; Claude 12.5 is
**phrase-only**; one primary next action or explicit INSUFFICIENT_DATA; read-only advisory
(no durable override state); "Life → Next" is the home + a soft-branch-only Today teaser.
`DECISIONS.md` gains #26 (one-next-action) and #27 (extend-CDI / deterministic-first /
phrase-only / read-only). The old single 12.0 slice is split into 12.0A (static root↔www
parity + mirror/check-only `sync.bat` + parity test/CI) and 12.0B (Android runtime compat +
APK smoke), each independently reviewed.

**Next task:** re-review `docs/PHASE12_PERSONAL_INTELLIGENCE.md`. No Phase 12 code, no 12.0A,
no `sync.bat`/`www/` changes yet.

Base: `main` @ `254ab57e1a6453a7301fd79110d9b1dd4ee5089f`. `README.md` remains intentionally
` M` (stale identity reference) — untouched, not staged.

---

## 2026-09-05 — Phase 11.8: Minimal distraction signals (built, NOT integrated)

Branch `feat/minimal-distraction-signals-v1`, worktree `chronasense-phase11-8`, from `origin/main`
`ff28aa9`. **Phase 11.7 is now integrated to main** (`b1b0fa0`, directly under HEAD) — the
"(built, NOT integrated)" wording on the 11.7 entry below is stale; this entry supersedes it.
`planning/ROADMAP.md` and `CHANGELOG.md` corrected accordingly.

A thin attention-awareness layer over data already captured. No new collector, tab, dashboard,
score, daemon, blocker, Firebase subsystem, or Life Ledger coupling.

- **`attention-signals.js`** (+ `www/` mirror) — pure deterministic `deriveAttentionSignals(entries,
  opts)`: longest coherent focus stretch, meaningful attention breaks, likely distraction
  (`~N min`, withheld < 15 min), recoveries + median recovery time. Blocks classified focus /
  neutral / distraction by their own energy label or Today Plan membership — never by app/window —
  so related-tool switching stays one stretch. Thresholds documented in the module header.
- **Surface:** an "Attention today" block in the existing end-of-day review modal only
  (`renderReviewAttention()` in `insights.js`). Progressive disclosure — only data-supported
  metrics render.
- **Calibration:** one optional `reviews[dateKey].focusRating` (`focused` / `mixed` /
  `distracted`), stored in the existing `reviews` object, synced via the existing path. Never
  fused into the automatic numbers.
- FREEZE / KEEP unchanged: Awareness Signal, Focus Wallet, streaks, Focus Mode,
  penalty/escalation. `focus-mode.js` untouched (module reads finished entries).

Tests: `npm test` (446 unit incl. 24 new attention-signal tests, 0 fail), `npm run lint`
(0 errors), Playwright smoke (217 passed), `node --check` on changed JS, `git diff --check`
clean, root/www parity verified for the 3 runtime files. Stop for independent review; do not push
main / integrate / start Phase 12.

Next task: independent Phase 11.8 review.

---

## 2026-09-05 — Phase 11.7: Bloat consolidation / UX simplification (built, NOT integrated)

Branch `refactor/bloat-consolidation-v1`, worktree `chronasense-phase11-7`, from `origin/main`
`dbbbc31`. Phase 11.6 is now **integrated to main** (`f3887db` + `dbbbc31`) — the "(built, NOT
integrated)" wording on older entries below is stale; this entry supersedes it.

A simplification phase. Two high-confidence, reversible changes:

1. **Removed identity level.** `computeIdentityScore()` / `getIdentityLevelWithEmoji()`, the
   `#s-identity` stat tile (already `display:none` since `21af9cc`, 2026-07-10), and the
   tier/colour render block in `renderToday()`. Its only input was today's deep-block count —
   identical to the `#s-deep` tile beside it. No behavior gated on it, no persisted data. Dead
   test blocks and the CODEMAP entry removed too.
2. **Consolidated the two decision records.** Root `DECISIONS.md` is now the single canonical log.
   `docs/DECISIONS.md` D-002/D-003/D-004 migrated in verbatim as entries 23/24/25 (ids kept as
   aliases); `docs/DECISIONS.md` reduced to a pointer stub (retained — `tools/Verify-Decisions.ps1`
   and `tools/Check-DocsConsistency.ps1` still read the path). Pointers in PROMPTS.md/AGENTS.md
   updated.

FREEZE / KEEP verified live and unchanged: penalty/escalation (already quiet — two toasts, no UI),
Awareness Signal, streaks, Focus Wallet, Focus Mode, daily/weekly/missed-recovery reviews.
Learn / Career / Life modules all KEEP. Everything else audited + deferred — see
`planning/ROADMAP.md` "Deferred from Phase 11.7".

Tests: `npm test` (unit), `npm run lint`, Playwright smoke, `node --check`, `git diff --check`,
root/www parity — see report. Stop for independent review; do not push main / integrate / start 11.8.

Next task: independent Phase 11.7 review.

---

## 2026-09-04 — Phase 11.6 review fix: Capacitor www runtime parity (built, NOT integrated)

Same branch/worktree as below (`fix/core-loop-bugs-v1` / `chronasense-phase11-6`), on top of
`f3887db`. Independent review of the Phase 11.6 commit passed all three source fixes but found
one blocking gap: Capacitor's `webDir` is `"www"`, so `www/*.js`/`www/index.html` are the runtime
an Android build actually ships — not stale reference output — and nothing regenerates them
automatically except `sync.bat`, which also commits and pushes to `origin main` and so was not
run. `www/index.html`, `www/storage.js`, and `www/focus-wallet.js` had drifted from root (the
three PROP-007/004/009 fixes were missing there) before this phase even started; they are now
byte-identical to the reviewed root files (sha256-verified, straight copy, no fix re-edited).

`npx cap sync android` was attempted in the feature worktree to determine necessity and failed
immediately (`android platform has not been added yet`) — the real native `android/` project is
gitignored and lives only in the authoritative main working directory outside this branch, so it
produces zero tracked diff here regardless; that step belongs to an actual Android build, which
remains out of scope. `sync.bat` was read, not executed, because it also commits and pushes.

Added a parity regression test (`test.js`, "Capacitor www runtime mirror parity") asserting the
three mirrored files stay byte-identical to root; verified it fails on a stale mirror and passes
once synced.

Two findings from the review pass were logged, not fixed, per the review's explicit scope: Focus
Wallet's sports-keyword match still lets "sportscar"/"sports-car" count as a sports session (no
existing spec defines compound-word semantics; recorded as a PROP-009 follow-up) — and a
pre-existing, Phase-11.6-unrelated DST defect: `tzParseTime()` collapses to a zero-width day
window on `America/New_York`'s 2026-03-08 spring-forward date. Logged as `PROP-014`. Neither PROP-013's original symptom nor this phase's fixes are affected by it; the earlier "already
correctly timezone-aware" wording for PROP-013 was corrected in `CHANGELOG.md`/`planning/PROPOSALS.md`
to not overclaim universal DST correctness.

Gates run clean: full `npm test` (453/453, incl. the new parity test), `npm run lint` (0 errors,
same 19 pre-existing warnings), full `tests/smoke.spec.js` Playwright suite (69/69), `git diff
--check`, `node --check` on all changed `.js` files. No Android build/install/deploy. Production
and main untouched; README protected hash re-verified unchanged.

Next action: owner: targeted re-review of just the www-parity fix (see final report). Same
Phase 11.7 backlog as below, plus PROP-014 and the PROP-009 compound-word follow-up.

---

## 2026-09-04 — Phase 11.6: Core-loop bug cleanup (built, NOT integrated)

Branch `fix/core-loop-bugs-v1`, worktree `chronasense-phase11-6`, base `28f56e7` (== `origin/main`
at the time this phase started). Live-verified all five historical bug candidates from
`planning/PROPOSALS.md` against current source, per the Phase 11.5 Known Live Bugs handoff.

Fixed (all with a regression test that fails before the fix and passes after; full detail in
`CHANGELOG.md`):
- **PROP-007** `triggerPenaltyMode()` ReferenceError — defined it in `index.html`, reusing the
  existing `startSprint()`-style safe timer-duration pattern instead of the dead prototype's
  force-start approach. Penalty/escalation stays FREEZE (Phase 11.5) — no new mechanism added.
- **PROP-004** timer restore drops `blockStartTime` on reopen — `persist()`/`load()` in
  `storage.js` now round-trip it through `ta3-timer`. Confirmed this caused real silent time
  loss (a running block auto-log-guard in `enterFocusMode()` silently skipped, no entry, `running`
  left stuck true) — not just a display issue.
- **PROP-009** Focus Wallet "sport" substring matches "transport" — `focus-wallet.js`'s
  `isFocusWalletSportsEntry()` now uses a left-word-boundary regex per keyword.

Not fixed, both documented in `CHANGELOG.md`'s Phase 11.6 entry with reasoning:
- **PROP-013** unlogged-day navigation off-by-one — live-verified, could not reproduce against
  current code (full timezone-aware date chain traced and empirically tested against a real
  negative-UTC-offset timezone, direct call and real DOM click both correct). STALE / CANNOT
  REPRODUCE.
- **PROP-008** Focus Mode auto-log has no undo — confirmed live, but classified UX debt: the
  entry is editable/deletable like any other, nothing is irreversible. Deferred to 11.7+.

Gates run clean: `npm test` (450/450), `npm run lint` (0 errors, same 19 pre-existing warnings),
full `tests/smoke.spec.js` Playwright suite (69/69, including the two new regression tests),
`git diff --check`, `node --check` on every changed `.js` file. Production untouched (no
scheduler/config/outbox/vault file in the diff). Main's protected `M README.md` verified
unchanged (hash-matched) before and after this phase.

Next action: owner: independent review of this branch. Do not integrate, deploy, or begin Phase
11.7 until reviewed. The two-track split and motivation-layer overlap from Phase 11.5 are still
open, plus PROP-013 and PROP-008 above, all carried into Phase 11.7.

---

## 2026-09-04 — Phase 11.5: Context Reconciliation + Product Boundary

This entry exists because every entry below is stale in a specific, important way: they are all
from the gated `captures -> PROPOSALS -> ROADMAP -> BUILD_QUEUE -> TASKS` pipeline, which has been
stalled since 2026-07-20 (human never set `planning/ROADMAP.md`'s Current Objective). Real feature
work did not stop -- it moved to a separate, ungated Phase-branch track that never touched this
file. **Phase 6 (Unified Life Feed) through Phase 11 (production hardening + review-fix pass)
shipped between 2026-09-01 and 2026-09-04, entirely outside this pipeline** -- see `CHANGELOG.md`
for the real history, not the entries below.

STEP A/B (as this file's own template would report them): unchanged from 2026-08-17 -- the 13
`planning/PROPOSALS.md` proposals are still `pending`, `planning/ROADMAP.md`'s Current Objective
and Approved Backlog are still empty. This is not a new finding; it is carried-forward and, per
Phase 11.5's scope, explicitly not resolved here (resolving the two-track split is a Phase 11.7
question).

What Phase 11.5 actually did (docs/context only, no feature code, no production systems touched):
verified HEAD (`1fe439a`) and the intentionally dirty state (`M README.md`, `?? APP_CONTEXT.md`)
live against the briefed values (hash-matched); inventoried every context file in the repo;
reconciled `APP_CONTEXT.md` against live code (`CODEMAP.md`) and live production state (the
`ChronaSense Life Ledger Sync` Windows Scheduled Task, confirmed `Enabled`/`Ready`, 15-min cadence,
last run succeeded at 11:47 AM today -- genuinely live despite `CHANGELOG.md`'s Phase 10/11 entries
correctly saying "NOT activated" as of their own commits); established the ChronaSense/Life
Ledger/Obsidian/intelligence-layer product boundary and classified Learning Plans,
Capability/Career, Life Character Sheet, Cross-Domain Intelligence, and Life Feed against it (all
B, i.e. legitimately-colocated Personal-OS modules for now -- Cross-Domain Intelligence flagged as
the strongest future migration-out candidate, since it does the "recommendation/synthesis" job the
boundary assigns to an eventual Claude/intelligence layer); inventoried the motivation layer (Focus
Wallet, identity level, streaks, penalty/escalation, Awareness Signal, Focus Mode) and review
surfaces (Day Review Modal, Review Plan Picker, Reflect View) for overlap; live-reconfirmed the
`triggerPenaltyMode()` ReferenceError from `planning/PROPOSALS.md` PROP-007 is still present
(`insights.js:248` calls it, it is defined nowhere but the two dead `ai_studio_code (1)*.html`
prototype files); scope-limited the future distraction-signals direction to derived metrics on
existing screens only. Full detail in `APP_CONTEXT.md`.

Next action: owner: you. Per the Phase 11.5 review-fix pass, the confirmed-live
`triggerPenaltyMode()` bug moved Phase 11.6 to core-loop bug cleanup (it lives inside the same
motivation/escalation subsystem that consolidation decisions below will evaluate). The two-track
split (this pipeline vs. the Phase-branch track) and the motivation-layer overlap (identity level
vs. Awareness Signal) are the two concrete decisions carried into Phase 11.7 (bloat
consolidation). No blockers to Phase 11.6 starting.

---

## 2026-08-17 — Triage + Plan

STEP A: 0 new captures. All 15 `captures/inbox/*.md` carry `status: triaged` — verified by reading the
`status:` line of every file, not a spot-check. A repo-wide scan of `captures/` for `status: new`
matches only three documentation lines (`captures/README.md:37`, `captures/commands/README.md:29`
and `:74`), which are frontmatter examples and prose, not captures. Archive is complete 1:1:
`captures/processed/2026/07/` holds exactly the same 15 filenames as `captures/inbox/`. Nothing to
categorize, dedupe, enrich, or archive. All 13 proposals in `planning/PROPOSALS.md`
(PROP-001 … PROP-013) remain `status: pending` — 13 of 13 `**status:**` lines matched, zero
approved/rejected.

STEP B: `planning/BUILD_QUEUE.md` still empty (file body is literally `*(empty)*`); no `source: BQ-*`
tasks to create — the only `source: BQ-<id>` string in `TASKS.md` is inside the commented-out task
template. No existing TASKS.md entries added, reordered, or restatused; there are no `status: codex`
tasks to order (001–003 are all `status: done`). `PLAN.md` unchanged (no milestone to describe).
`planning/ROADMAP.md` Current Objective (line 19) and Approved Backlog (line 25) both still unset.
**Action needed (carried forward, unresolved since 2026-07-20 — 28 days, unchanged this run):** human
sets the Current Objective in `planning/ROADMAP.md` and moves PROP-004 (P1), PROP-007 (P1), PROP-008
(P2), PROP-009 (P2), PROP-011 (P2), PROP-013 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md` per the
`/approve all` signal from msg_id 82. This remains the ONLY thing blocking the build pipeline: triage
has zero backlog and TASKS.md entries 001–003 are all `status: done`. Autonomous runs cannot cross the
approval gate, so every further triage-only run will report this same line until a human acts — this is
now the 15th consecutive run to do so.

---

## 2026-08-16 — Triage + Plan (run 2)

STEP A: 0 new captures. Every one of the 15 `captures/inbox/*.md` files carries `status: triaged`
(verified by reading the `status:` line of all 15, not a spot-check). A repo-wide scan of `captures/`
for `status: new` matches only two frontmatter examples — `captures/README.md:37` and
`captures/commands/README.md:29` — which are documentation, not captures. Archive is complete 1:1:
`captures/processed/2026/07/` holds exactly the same 15 filenames as `captures/inbox/`. Nothing to
categorize, dedupe, enrich, or archive. All 13 proposals in `planning/PROPOSALS.md`
(PROP-001 … PROP-013) remain `status: pending` — verified by matching all 13 `**status:**` lines,
zero approved/rejected.

STEP B: `planning/BUILD_QUEUE.md` still empty (file body is literally `*(empty)*`); no `source: BQ-*`
tasks to create — the only `source: BQ-<id>` string in `TASKS.md` is inside the commented-out task
template. No existing TASKS.md entries added, reordered, or restatused; there are no `status: codex`
tasks to order (001–003 are all `status: done`). `PLAN.md` unchanged (no milestone to describe).
`planning/ROADMAP.md` Current Objective and Approved Backlog both still unset.
**Action needed (carried forward, unresolved since 2026-07-20 — 27 days, unchanged this run):** human
sets the Current Objective in `planning/ROADMAP.md` and moves PROP-004 (P1), PROP-007 (P1), PROP-008
(P2), PROP-009 (P2), PROP-011 (P2), PROP-013 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md` per the
`/approve all` signal from msg_id 82. This remains the ONLY thing blocking the build pipeline: triage
has zero backlog and TASKS.md entries 001–003 are all `status: done`. Autonomous runs cannot cross the
approval gate, so every further triage-only run will report this same line until a human acts — this is
now the 14th consecutive run to do so.

---

## 2026-08-16 — Triage + Plan

STEP A: 0 new captures. A repo-wide scan of `captures/` for `status: new` returns only the two
frontmatter examples in `captures/README.md` and `captures/commands/README.md` (documentation, not
captures) — so all 15 `captures/inbox/*.md` are `status: triaged`. Archive is complete 1:1: both
`captures/inbox/` and `captures/processed/2026/07/` list the same 15 filenames. Nothing to
categorize, dedupe, enrich, or archive. All 13 proposals in `planning/PROPOSALS.md`
(PROP-001 … PROP-013) remain `status: pending` — verified by matching all 13 `**status:**` lines,
zero approved/rejected.

STEP B: `planning/BUILD_QUEUE.md` still empty (file body is literally `*(empty)*`); no `source: BQ-*`
tasks to create — the only `source: BQ-<id>` string in `TASKS.md` is inside the commented-out task
template. No existing TASKS.md entries added, reordered, or restatused; there are no `status: codex`
tasks to order (001–003 are all `status: done`). `PLAN.md` unchanged (no milestone to describe).
`planning/ROADMAP.md` Current Objective and Approved Backlog both still unset.
**Action needed (carried forward, unresolved since 2026-07-20 — 27 days, unchanged this run):** human
sets the Current Objective in `planning/ROADMAP.md` and moves PROP-004 (P1), PROP-007 (P1), PROP-008
(P2), PROP-009 (P2), PROP-011 (P2), PROP-013 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md` per the
`/approve all` signal from msg_id 82. This remains the ONLY thing blocking the build pipeline: triage
has zero backlog and TASKS.md entries 001–003 are all `status: done`. Autonomous runs cannot cross the
approval gate, so every further triage-only run will report this same line until a human acts — this is
now the 13th consecutive run to do so.

---

## 2026-08-15 — Triage + Plan (run 2)

STEP A: 0 new captures. All 15 `captures/inbox/*.md` are `status: triaged` (verified by reading the
`status:` line of every file, not by spot-check), and the archive is complete 1:1 — all 15 filenames
match exactly against `captures/processed/2026/07/`. A repo-wide scan for `status: new` under
`captures/` returns only the frontmatter examples in `captures/README.md` and
`captures/commands/README.md` (documentation, not captures). Nothing to categorize, dedupe, enrich, or
archive. All 13 proposals in `planning/PROPOSALS.md` (PROP-001 … PROP-013) remain enriched and
`status: pending` — verified count, zero approved/rejected.

STEP B: `planning/BUILD_QUEUE.md` still empty (confirmed — the file body is literally `*(empty)*`); no
`source: BQ-*` tasks to create — the only `source: BQ-<id>` string in `TASKS.md` is inside the
commented-out task template. No existing TASKS.md entries reordered or restatused; there are no
`status: codex` tasks to order (001–003 are all `status: done`). `PLAN.md` unchanged (no milestone to
describe). `planning/ROADMAP.md` Current Objective and Approved Backlog both still unset.
**Action needed (carried forward, unresolved since 2026-07-20 — 26 days, unchanged this run):** human
sets the Current Objective in `planning/ROADMAP.md` and moves PROP-004 (P1), PROP-007 (P1), PROP-008
(P2), PROP-009 (P2), PROP-011 (P2), PROP-013 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md` per the
`/approve all` signal from msg_id 82. This remains the ONLY thing blocking the build pipeline: triage
has zero backlog and TASKS.md entries 001–003 are all `status: done`. Autonomous runs cannot cross the
approval gate, so every further triage-only run will report this same line until a human acts — this is
now the 12th consecutive run to do so.

---

## 2026-08-15 — Triage + Plan

STEP A: 0 new captures. All 15 `captures/inbox/*.md` are `status: triaged`, and the archive is complete
1:1 — all 15 filenames match exactly against `captures/processed/2026/07/` (verified by listing both
directories, not by spot-check). A repo-wide scan for `status: new` under `captures/` returns only the
frontmatter examples in `captures/README.md` and `captures/commands/README.md` (documentation, not
captures). Nothing to categorize, dedupe, enrich, or archive. All 13 proposals in
`planning/PROPOSALS.md` (PROP-001 … PROP-013) remain enriched and `status: pending` — verified count,
zero approved/rejected.

STEP B: `planning/BUILD_QUEUE.md` still empty (confirmed); no `source: BQ-*` tasks to create — the only
`source: BQ-<id>` string in `TASKS.md` is line 237, inside the commented-out task template. No existing
TASKS.md entries reordered or restatused; there are no `status: codex` tasks to order (001–003 are all
`status: done`). `PLAN.md` unchanged (no milestone to describe). `planning/ROADMAP.md` Current Objective
and Approved Backlog both still unset.
**Action needed (carried forward, unresolved since 2026-07-20 — 26 days, unchanged this run):** human
sets the Current Objective in `planning/ROADMAP.md` and moves PROP-004 (P1), PROP-007 (P1), PROP-008
(P2), PROP-009 (P2), PROP-011 (P2), PROP-013 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md` per the
`/approve all` signal from msg_id 82. This remains the ONLY thing blocking the build pipeline: triage
has zero backlog and TASKS.md entries 001–003 are all `status: done`. Autonomous runs cannot cross the
approval gate, so every further triage-only run will report this same line until a human acts — this is
now the 11th consecutive run to do so.

---

## 2026-08-14 — Triage + Plan (run 2)

STEP A: 0 new captures. All 15 `captures/inbox/*.md` are `status: triaged`, and all 15 have a matching
archive under `captures/processed/2026/07/` — archive complete, nothing outstanding. A repo-wide scan
for `status: new` under `captures/` returns only the frontmatter examples in `captures/README.md` and
`captures/commands/README.md` (documentation, not captures); the 20 real command captures are all
terminal (19 `applied`, 1 `cancelled`). Nothing to categorize, dedupe, enrich, or archive. All 13
proposals in `planning/PROPOSALS.md` (PROP-001 … PROP-013) remain enriched and `status: pending`.

STEP B: `planning/BUILD_QUEUE.md` still empty (confirmed); no `source: BQ-*` tasks to create (the only
`source: BQ-<id>` string in `TASKS.md` is inside the commented-out task template); no existing TASKS.md
entries reordered or restatused — 001–003 are all `status: done`; `PLAN.md` unchanged (no milestone to
describe). `planning/ROADMAP.md` Current Objective and Approved Backlog both still unset.
**Action needed (carried forward, unresolved since 2026-07-20 — 25 days, unchanged this run):** human
sets the Current Objective in `planning/ROADMAP.md` and moves PROP-004 (P1), PROP-007 (P1), PROP-008
(P2), PROP-009 (P2), PROP-011 (P2), PROP-013 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md` per the
`/approve all` signal from msg_id 82. This remains the ONLY thing blocking the build pipeline: triage
has zero backlog and TASKS.md entries 001–003 are all `status: done`. Autonomous runs cannot cross the
approval gate, so every further triage-only run will report this same line until a human acts.

---

## 2026-08-14 — Triage + Plan

STEP A: 0 new captures. All 15 `captures/inbox/*.md` are `status: triaged`, and all 15 have a matching
archive under `captures/processed/2026/07/` — archive complete, nothing outstanding. A repo-wide scan
for `status: new` under `captures/` returns only the frontmatter examples in `captures/README.md` and
`captures/commands/README.md` (documentation, not captures); the 20 real command captures are all
terminal (`applied`/`cancelled`). Nothing to categorize, dedupe, enrich, or archive. All 13 proposals
in `planning/PROPOSALS.md` (PROP-001 … PROP-013) remain enriched and `status: pending`.

STEP B: `planning/BUILD_QUEUE.md` still empty (confirmed); no `source: BQ-*` tasks to create; no
existing TASKS.md entries reordered or restatused; `PLAN.md` unchanged (no milestone to describe).
`planning/ROADMAP.md` Current Objective and Approved Backlog both still unset.
**Action needed (carried forward, unresolved since 2026-07-20 — 25 days, unchanged this run):** human
sets the Current Objective in `planning/ROADMAP.md` and moves PROP-004 (P1), PROP-007 (P1), PROP-008
(P2), PROP-009 (P2), PROP-011 (P2), PROP-013 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md` per the
`/approve all` signal from msg_id 82. This remains the ONLY thing blocking the build pipeline: triage
has zero backlog and TASKS.md entries 001–003 are all `status: done`. Autonomous runs cannot cross the
approval gate, so every further triage-only run will report this same line until a human acts.

---

## 2026-08-13 — Triage + Plan (run 2)

STEP A: 0 new captures. All 15 `captures/inbox/*.md` are `status: triaged`, and all 15 have a matching
archive under `captures/processed/2026/07/` — archive complete, nothing outstanding. A repo-wide scan
for `status: new` under `captures/` returns only the frontmatter examples in `captures/README.md` and
`captures/commands/README.md` (documentation, not captures). Nothing to categorize, dedupe, enrich, or
archive. All 13 proposals in `planning/PROPOSALS.md` (PROP-001 … PROP-013) remain enriched and
`status: pending`.

STEP B: `planning/BUILD_QUEUE.md` still empty (confirmed); no `source: BQ-*` tasks to create; no
existing TASKS.md entries reordered or restatused; `PLAN.md` unchanged (no milestone to describe).
`planning/ROADMAP.md` Current Objective and Approved Backlog both still unset.
**Action needed (carried forward, unresolved since 2026-07-20 — 24 days, unchanged this run):** human
sets the Current Objective in `planning/ROADMAP.md` and moves PROP-004 (P1), PROP-007 (P1), PROP-008
(P2), PROP-009 (P2), PROP-011 (P2), PROP-013 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md` per the
`/approve all` signal from msg_id 82. This remains the ONLY thing blocking the build pipeline: triage
has zero backlog and TASKS.md entries 001–003 are all `status: done`. Autonomous runs cannot cross the
approval gate, so every further triage-only run will report this same line until a human acts.

---

## 2026-08-13 — Triage + Plan

STEP A: 0 new captures. All 15 `captures/inbox/*.md` are `status: triaged` and all 15 have a matching
archive in `captures/processed/2026/07/` — archive complete, nothing outstanding. A repo-wide scan for
`status: new` under `captures/` returns only the two frontmatter examples inside
`captures/commands/README.md` and `captures/README.md` (documentation, not captures). Nothing to
categorize, dedupe, enrich, or archive. All 13 proposals in `planning/PROPOSALS.md` remain enriched and
`status: pending`.

STEP B: `planning/BUILD_QUEUE.md` still empty (confirmed); no tasks added; `PLAN.md` unchanged (no
milestone to describe). `planning/ROADMAP.md` Current Objective and Approved Backlog both still unset.
**Action needed (carried forward, unresolved since 2026-07-20 — 24 days, unchanged this run):** human
sets the Current Objective in `planning/ROADMAP.md` and moves PROP-004 (P1), PROP-007 (P1), PROP-008
(P2), PROP-009 (P2), PROP-011 (P2), PROP-013 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md` per the
`/approve all` signal from msg_id 82. This remains the ONLY thing blocking the build pipeline: triage
has zero backlog and TASKS.md entries 001–003 are all `status: done`. Autonomous runs cannot cross the
approval gate, so every further triage-only run will report this same line until a human acts.

---

## 2026-08-12 — Triage + Plan (run 2)

STEP A: 0 new captures — all 15 `captures/inbox/*.md` are `status: triaged`, and all 15 are present in
`captures/processed/2026/07/`, so the archive is complete with nothing outstanding. (The only
`status: new` string anywhere in `captures/` is the frontmatter example inside
`captures/commands/README.md`, which is documentation, not a capture; the 20 real command captures are
all `applied`/`cancelled`.) Nothing to route or enrich. All 13 proposals in `planning/PROPOSALS.md`
remain enriched and `status: pending`.

STEP B: `planning/BUILD_QUEUE.md` still empty (confirmed); no tasks added; `PLAN.md` unchanged (no
milestone to describe). **Action needed (carried forward, unresolved since 2026-07-20 — unchanged this
run):** human sets the Current Objective in `planning/ROADMAP.md` (still unset) and moves PROP-004 (P1),
PROP-007 (P1), PROP-008 (P2), PROP-009 (P2), PROP-011 (P2), PROP-013 (P2) to `ROADMAP.md` +
`BUILD_QUEUE.md` per the `/approve all` signal from msg_id 82. This remains the ONLY thing blocking the
build pipeline: triage has zero backlog, and TASKS.md entries 001–003 are all `status: done`.

---

## 2026-08-12 — Triage + Plan

STEP A: 0 new captures (all 15 inbox files already `status: triaged`). Nothing to route or enrich.
**Carried-forward blocker RESOLVED:** msg 120's archive is now complete —
`captures/processed/2026/07/20260724T1519Z-120-unknown.md` exists, with the usual archive frontmatter
(`triaged: 2026-08-05`, `proposal: PROP-013`, `disposition: approve`). The two previous runs treated
this as blocked on a `git mv` needing human approval; that was the wrong mechanism. Verified against
git history (commit `168ecf3`, and every other archive commit): this repo's actual, committed archive
pattern is **add a copy under `captures/processed/` + leave the inbox file in place marked
`status: triaged`** — all 14 prior captures exist in BOTH directories. No move, no deletion, so no
mutating shell command was ever required. Nothing is now outstanding from the msg-120 archive.

STEP B: `planning/BUILD_QUEUE.md` still empty (confirmed); no tasks added; `PLAN.md` unchanged (no
milestone to describe). `planning/ROADMAP.md` Current Objective and Approved Backlog remain unset.
**Action needed (carried forward, unresolved since 2026-07-20):** human moves PROP-004 (P1), PROP-007
(P1), PROP-008 (P2), PROP-009 (P2), PROP-011 (P2), PROP-013 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md`
per the `/approve all` signal from msg_id 82, to unblock the build pipeline. All TASKS.md entries
(001–003) remain `status: done`. This is now the ONLY thing blocking the pipeline — triage has no
backlog left, and 13 of 13 proposals are enriched and awaiting the approval gate.

---

## 2026-08-06 — Triage + Plan

STEP A: 0 new captures (all 15 inbox files already `status: triaged`; msg_id 120/PROP-013 confirmed
already enriched in `planning/PROPOSALS.md` from the prior run). Nothing to route or enrich.
**Carried forward, unresolved since 2026-08-05:** msg 120's `git mv` to `captures/processed/2026/07/`
is still incomplete — this autonomous run has no human available to approve the mutating shell
command (`git mv` requires approval same as last run; plain reads still work fine). The file's
frontmatter already reads `status: triaged` so it will not be reprocessed, but it remains physically
in `captures/inbox/` instead of `captures/processed/2026/07/`. **Action needed:** a human, or a run
with shell-write permission, completes `git mv captures/inbox/20260724T1519Z-120-unknown.md
captures/processed/2026/07/20260724T1519Z-120-unknown.md`.

STEP B: `planning/BUILD_QUEUE.md` still empty (confirmed); no tasks added. `planning/ROADMAP.md`
Approved Backlog and Current Objective remain unset. **Action needed (carried forward, unresolved
since 2026-07-20):** human moves PROP-004 (P1), PROP-007 (P1), PROP-008 (P2), PROP-009 (P2), PROP-011
(P2), PROP-013 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md` per the `/approve all` signal from msg_id 82,
to unblock the build pipeline. All TASKS.md entries (001–003) remain `status: done`.

---

## 2026-08-05 — Triage + Plan

STEP A: 1 new capture processed (msg_id 120). Real usage bug report: from an unlogged-time day list,
clicking a specific day (e.g. Wednesday while viewing Friday) opens the *next* day's (Thursday's)
timeline instead — header date stays correct, so it's isolated to how the clicked day resolves to a
timeline date key → **PROP-013** (Approve, P2, Goal #2 "capture the truth", Risk: Low-leaning — display/
navigation bug, not confirmed to touch entry schema or RTDB sync; escalate to High if root cause turns
out to be inside `computeGaps()`/`getWorkDayStartTs()`, Hard Rule #3). Enriched into `planning/
PROPOSALS.md`. **Archive incomplete:** the inbox file's frontmatter was updated to `status: triaged`
(satisfies Triage idempotency — will not be reprocessed), but the `git mv` to `captures/processed/2026/
07/` could not be completed this run — every mutating shell command (git mv, rm, mkdir, even git status
initially) required approval that has no human to grant in this autonomous session (plain read-only git
commands like `git log` worked fine). **Action needed:** a human or a run with shell-write permission
should `git mv captures/inbox/20260724T1519Z-120-unknown.md captures/processed/2026/07/
20260724T1519Z-120-unknown.md` to finish the archive.

STEP B: `planning/BUILD_QUEUE.md` still empty; no tasks added. **Action needed (carried forward,
unresolved since 2026-07-20):** human moves PROP-004 (P1), PROP-007 (P1), PROP-008 (P2), PROP-009 (P2),
PROP-011 (P2) to `ROADMAP.md` + `BUILD_QUEUE.md` per the `/approve all` signal from msg_id 82. New this
run: PROP-013 (P2) is also Approve-recommended and awaiting the same human gate.

---

## 2026-07-23 — Triage + Plan

STEP A: 0 new captures (all 14 inbox files already `status: triaged`; no new inbox arrivals since 2026-07-20). STEP B: BUILD_QUEUE.md still empty; no tasks added. **Action needed:** human moves PROP-004 (P1), PROP-007 (P1), PROP-008 (P2), PROP-009 (P2), PROP-011 (P2) to ROADMAP.md + BUILD_QUEUE.md per the `/approve all` signal from msg_id 82 (see 2026-07-20 entry). TASKS 001/002/003 are all `status: done`.

---

## 2026-07-22 — Triage + Plan (run 2)

STEP A: 0 new captures (all 14 inbox files already `status: triaged`; 20 command captures + README checked, all `status: applied`; no new ideas or bug reports). STEP B: BUILD_QUEUE.md still empty; no tasks added. **Action needed:** human moves PROP-004 (P1), PROP-007 (P1), PROP-008 (P2), PROP-009 (P2), PROP-011 (P2) to ROADMAP.md + BUILD_QUEUE.md per the `/approve all` signal from msg_id 82 (see 2026-07-20 entry). TASKS 001/002/003 are all `status: done`.

---

## 2026-07-22 — Triage + Plan

STEP A: 0 new captures (all 14 inbox files already `status: triaged`; 21 command captures checked, all `/merge` commands with `status: applied`; no new ideas or bug reports). STEP B: BUILD_QUEUE.md still empty; no tasks added. **Action needed:** human moves PROP-004 (P1), PROP-007 (P1), PROP-008 (P2), PROP-009 (P2), PROP-011 (P2) to ROADMAP.md + BUILD_QUEUE.md per the `/approve all` signal from msg_id 82 (see 2026-07-20 entry). TASKS 001/002/003 are all `status: done`.

---

## 2026-07-21 — Triage + Plan (run 2)

STEP A: 0 new captures (all 14 inbox files already `status: triaged`; spot-checked msg_ids 82/84/86 confirmed); nothing to process. STEP B: BUILD_QUEUE.md still empty; no tasks added. **Action needed:** human moves PROP-004 (P1), PROP-007 (P1), PROP-008 (P2), PROP-009 (P2), PROP-011 (P2) to ROADMAP.md + BUILD_QUEUE.md per the `/approve all` signal from msg_id 82 (see 2026-07-20 entry).

---

## 2026-07-21 — Triage + Plan

STEP A: 0 new captures (all 14 inbox files already `status: triaged`); nothing to process. STEP B: BUILD_QUEUE.md still empty; no tasks added. **Action needed:** human moves PROP-004 (P1), PROP-007 (P1), PROP-008 (P2), PROP-009 (P2), PROP-011 (P2) to ROADMAP.md + BUILD_QUEUE.md per the `/approve all` signal from msg_id 82 (see 2026-07-20 entry).

---

## 2026-07-20 — Triage + Plan

STEP A: 3 new captures processed (msg_ids 82, 84, 86). Capture 82: `/approve all` bot command — user signaling approval of all pending Approve-recommended proposals; cannot execute approval gate in triage mode → PROP-010 (Reject as proposal, P3). **⚠ Human action needed: move PROP-004/007/008/009 to ROADMAP.md + BUILD_QUEUE.md.** Capture 84: auto-timer annoys user when not working → PROP-011 (Approve, P2, Goal #1, Risk: High — timer red-zone). Capture 86: in-app calendar/appointment planning with optional Google Calendar sync → PROP-012 (Park, P3, Goal #2, Risk: High — new RTDB schema + possible OAuth). STEP B: BUILD_QUEUE.md still empty; no tasks added. **Action needed:** human moves PROP-004 (P1), PROP-007 (P1), PROP-008 (P2), PROP-009 (P2), PROP-011 (P2) to ROADMAP.md + BUILD_QUEUE.md per the `/approve all` signal from msg_id 82.

---

## 2026-07-19 — Triage + Plan (run 2)

STEP A: 1 new capture processed (msg_id 75, /idea). Category clarity idea ("where do cooking/church work go?") → PROP-006 (Park, P2, Goal #1). Archived to captures/processed/2026/07/. STEP B: BUILD_QUEUE.md empty; no tasks added. No blockers. **Action needed:** human approves PROP-004 (timer-restore bug, P1) and moves it to BUILD_QUEUE.md to unlock the build pipeline. PROP-006 parked pending PROP-004 resolution and Current Objective being set.

---

## 2026-07-19 — Triage + Plan

STEP A: 0 new captures (all 10 inbox files already `status: triaged`); nothing to process. STEP B: BUILD_QUEUE.md empty; no tasks added. No blockers. **Action needed:** human approves PROP-004 (timer-restore bug, P1) and moves it to BUILD_QUEUE.md to unlock the build pipeline.

---

## 2026-07-18 — Triage + Plan

STEP A: 0 new captures (all 10 inbox files already `status: triaged`); nothing to process. STEP B: BUILD_QUEUE.md empty; no tasks added. No blockers. **Action needed:** human approves PROP-004 (timer-restore bug, P1) and moves it to BUILD_QUEUE.md to unlock the build pipeline.

---

## 2026-07-17 — Triage + Plan

STEP A: 0 new captures (all 10 inbox files already `status: triaged`); nothing to process. STEP B: BUILD_QUEUE.md empty; no tasks added. No blockers. **Action needed:** human approves PROP-004 (timer-restore bug, P1) and moves it to BUILD_QUEUE.md to unlock the build pipeline.

---

## 2026-07-16 — Triage + Plan (run 2)

STEP A: 0 new captures (all 10 inbox files already `status: triaged`); nothing to process. STEP B: BUILD_QUEUE.md empty; no tasks added. No blockers. **Action needed:** human approves PROP-004 (timer-restore bug, P1) and moves it to BUILD_QUEUE.md to unlock the build pipeline.

---

## 2026-07-16 — Triage + Plan

STEP A: 5 new captures processed (msg_ids 52, 55, 61, 63, 67). Capture 52: real bug report (timer state not restored on app reopen) → PROP-004 (Approve, P1, Goal #3). Captures 55/61/63/67: bot noise → PROP-005 (Reject). STEP B: BUILD_QUEUE.md empty; no tasks added. No blockers. **Action needed:** set Current Objective in ROADMAP.md, then approve PROP-004 to unlock build pipeline for the timer-restore bug fix.

---

## 2026-07-15 — Triage + Plan

STEP A: 0 new captures (all 5 inbox files already `status: triaged` from 2026-07-14 run); nothing to process. STEP B: BUILD_QUEUE.md empty; no tasks added to TASKS.md. No blockers. Awaiting: human sets Current Objective in ROADMAP.md and approves a PROPOSALS.md item to unlock the build pipeline.

---

## 2026-07-14 — Triage

5 captures processed (msg_ids 12, 16, 20, 36, 40): all Reject (Telegram bot-setup test noise) → 3 grouped PROPOSALS.md entries (PROP-001/002/003). BUILD_QUEUE empty; no tasks added. Incidentally confirms capture pipeline is end-to-end functional.

**Blockers:** none. Current Objective not yet set in ROADMAP.md — set it to focus the next triage scoring round.

---

## 2026-07-12 -- AI Dev OS installed in ChronaSense

**Scaffolded the AI Dev OS** (installed from the `ai-dev-os` repo, per `AI-DEV-OS.md`'s
"Bootstrap a new app"). Zero app code touched -- `index.html`, `storage.js`, `insights.js`,
`focus-mode.js`, `focus-wallet.js`, `style.css` are all untouched.

**Added:** process docs (WORKFLOW, OPERATOR, PROMPTS, QA, SELF_REVIEW, GUIDE, SYSTEM-OVERVIEW,
AI-DEV-OS), instance scaffolds (TASKS, PLAN, REVIEW, TEST_REPORT, STATUS, planning/, captures/),
automation (run-claude.ps1, tools/*.ps1, setup-*.ps1, 3 n8n workflow JSONs), and `docs/PROJECT.md`
with the approved north-star goals.

**Rewritten:** `CLAUDE.md` and `AGENTS.md` -- the OS router/roles/pipeline merged with ChronaSense's
existing content. **Nothing was lost:** the CODEMAP-first rule, the 8 DO-NOT-TOUCH fragile sections
(now Hard Rules), the branch strategy (now the D-032 risk gate), Key Files, and the CODEMAP-currency
rules are all preserved.

**Automation is OFF.** `$AUTOMATION_ENABLED = $false` in `run-claude.ps1` until validated.
Scheduled tasks are NOT registered yet.

**Next:** wire Telegram (Phase 3) -- import the 3 n8n workflows against the new bot + Time-audit
repo, then register the scheduled tasks (`ChronaSense Claude Overnight`, `ChronaSense Command
Dispatcher`).

**Blockers:** none.
