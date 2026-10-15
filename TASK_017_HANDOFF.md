# TASK-017 — Unfinished Task UX Improvement V1

Owner-direct, 2026-10-15. Target: REVIEW-READY ONLY. Branch/worktree: `task-017`, `.worktrees/task-017`.
Fresh fetch verified `origin/main` at `cbbfab625dd143199d74e934e6c2d79aae3ce081` before branching.
No integration, push, deployment, live-user data mutation, TASK-016 work, or historical completion/deletion implementation.
The referenced owner screenshot was unavailable in this thread; the written feedback and existing My Day were the baseline.

## Implemented safe UI

- Existing collapsed Unfinished indicator, count and Close behavior retained. Expanded ordinary backlog renders five
  rows per page with Previous tasks / Next tasks and an exact range; all 125 fixture tasks are reachable.
- Task title has a two-line clamp, readable planned-day/interval and age, primary Move to today, native More actions
  disclosure. Full text is available in the disclosure and title attribute. More actions contains the existing
  Move & edit, Reschedule and Not doing this actions plus an explanation of history preservation.
- Not doing this uses existing `PlanAuthority.dismissStaleItem`. No done state, original schedule, identity,
  duration, original owning plan or logged time is rewritten. Only dismissal/mutation stamps change.
- Session-only Undo calls existing `undismissStaleItem`. One receipt for the latest dismissal, scoped to the joined
  room, exact source day and item, and the observed post-dismissal item. The receipt is memory-only, not a store.
  It expires on reload, account change, notice Close, replacement dismissal or an attempted Undo.
- Undo refuses changed/deleted/completed sources or a known recovery destination; `sameOnWire` tolerates RTDB null
  pruning/key order while comparing all item facts and stamps. Both dismissal and Undo advance `updatedAt` beyond
  the source revision, including frozen clock/repeated actions. Older inbound snapshots cannot reverse them.
- All Unfinished buttons/disclosures have 44px minimum targets, wrapping date text, escaped user text and visible
  keyboard focus. Ordinary refresh preserves an open disclosure and its focused summary/action where available.
- Brain Dump tray code/styles/generation and My Day timeline logic are unchanged. The existing governed generation
  moves together to `20261015-task017-unfinished-ux-v1` because planning-continuity-ui belongs to that import graph.
  This changes URLs only for protected modules, not their contents. CSS gets the same new URL; www is generated.

## Safety boundary and limitations

Undo is guarded against **observed local state**, not an authoritative remote compare-and-set. Existing sync uses
per-item last-writer-wins (and existing relocation/fence rules). Offline or unseen concurrent edits can still race.
A guarantee against overwriting *any unseen remote revision* would need separately authorized protected authority/
sync work; this task does not claim or implement it. The notice says local backlog removal, not confirmed cloud sync.

`CalendarPlanLive.liveDateKeys` subscribes to today/future plans. Historical source plans hydrate but do not remain
live-subscribed by default. Therefore cross-device historical dismissal/Undo **live propagation is not verified by
the default UI**. Tests of calendar listener convergence explicitly attach the historical source via the existing
test-accessible `CalendarPlanSync.attachPlan`. They prove listener/merge mechanics, not default source-listener coverage.
This existing gap is a protected-layer follow-up, not silently repaired here.

Pagination bounds ordinary task DOM, not the authority projection's scan of stored history. Existing recovery
conflicts and unresolved-day explanations retain their previous visibility/semantics. The exceptional conflict
surface is not paginated. Only the last dismissal can be undone; session expiration is intentional, and a failed
Undo consumes its receipt. No durable dismissed-items manager was added.

No physical phone, Android build, live Firebase, or real cross-device/account race was exercised. Browser transport
uses synthetic accounts and recording Firebase fixtures. TASK-015 known F-A/F-B/S3 issues remain outside scope.

## Part B — separate design

See [TASK_017_COMPLETION_DELETE_DESIGN.md](TASK_017_COMPLETION_DELETE_DESIGN.md). No historical completion/deletion semantics are implemented.

## Evidence, verification and review

Exact source/evidence file manifest (generated images and ignored local logs are listed separately below):

- `planning-continuity-ui.js`, `planning-continuity.css` — bounded recovery rows, action hierarchy, guarded Undo.
- `index.html` — release URLs only; `personal-day-boundary-web-runtime.test.js` and
  `tests/calendar-native-plan-identity.spec.js` — corresponding generation assertions.
- `tests/unfinished-ux.spec.js` — 17 focused regressions; `tests/planning-continuity.spec.js` — updated bounded-list
  and More actions expectations (no weakened recovery/history assertions).
- `www/index.html`, `www/planning-continuity-ui.js`, `www/planning-continuity.css` — generated exact mirrors.
- `CODEMAP.md`, `TASKS.md`, `CHANGELOG.md`, `TEST_REPORT.md`, `TASK_017_HANDOFF.md`,
  `TASK_017_COMPLETION_DELETE_DESIGN.md` — task contract, stable-anchor map, evidence and design/handoff.

SELF_REVIEW: Code Health checklist passes; existing helpers reused, no new store/abstraction or dead code, all
production changes scoped to the task. “Would I ship this?” — yes for the bounded UI under the documented existing
sync semantics, subject to independent approval; real-device feel is unverified. QA static checks pass: escaped
user text, event dispatch cases resolve, no new raw colors/inputs/DOM-id collisions, no debug leftovers, protected
sources byte-identical to base, index token-only, mirror/rules/lint/diff checks recorded in TEST_REPORT.md.
The older QA.md planning/STATUS/doc-edit instructions conflict with current AGENTS ownership; use this handoff
and append-only evidence rather than edit those off-limits files. No pull/rebase/integration performed: isolated
branch was created from the freshly verified remote base.

Desktop/mobile images: `playwright-report/task-017/unfinished-{360,390,1920}.png` and corresponding
`unfinished-more-{360,390,1920}.png` (local generated artifacts; not deployed).

Independent review was explicitly requested by the owner. The read-only reviewer identified same-tick repeated
dismissal ordering and RTDB null/key normalization issues; both were repaired using caller-local stamps and the
existing `sameOnWire`. No protected source was edited to resolve them. Final independent source/design verdict:
**PASS, no remaining must-fix findings**. Reviewer did not independently execute the suites; inspected two earlier screenshots;
that evidence is builder-verified and must not be described as reviewer-executed.

Final verification: npm test exit 0 (2190 Node passes, separate 455-case legacy harness, 0 failures, one existing
opt-in skip); affected Playwright 154/154; final contrast-only layouts 3/3; lint 0 errors / 48 baseline warnings;
parity/rules/diff/static checks PASS. See appended TASK-017 entry in TEST_REPORT.md for resolved test-environment
failures and exact gaps. Builder visually inspected final brighter 390px expanded and 1920px default screenshots.
Reviewer inspected two earlier screenshots and retained PASS on the final contrast adjustment. Status: `review`.
No integration, push or deployment. Ready for owner/Claude review of this local candidate.
