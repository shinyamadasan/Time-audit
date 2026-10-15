# TASK-018 — Compact Unfinished proposal

2026-10-15. Awaiting owner acceptance before production implementation, as explicitly required by the build sequence.
Base: `bb171a287ac67d76ae27634b5227bc24f66919de`. Local branch: `task-018`.
TASK-017 failed owner real-use UX acceptance; this proposal replaces its expanded action-panel layout.

## Proposed interaction

- Retain the collapsible Unfinished section. Show five tasks at a time, with previous/next paging and an exact count.
- Each row is 64px: a cyan checkmark on the left, a two-line task title and subtle original planned date,
  then a small ellipsis. Checkmark and ellipsis each have a 44px tap target.
- One intentional checkmark action reports **completed today**, using today's calendar date in the account timezone
  captured when the action starts. It requires no completion form or second confirmation.
- The ellipsis opens an anchored 224px menu: **Done earlier…**, Move to today, Move & edit, Reschedule…, Not doing this.
  It overlays the list and does not enlarge the row. Escape/outside click closes it; keyboard arrows navigate the menu.
- Done earlier opens an anchored 272px date form with the task name, original planned date, actual completion date
  initially today, Cancel and Save completion. Native date input; future dates refused. No full-screen app form.
- A pending task remains visible, with its controls disabled. Confirmed success removes only that task, fills the
  fifth slot from the remaining queue, updates the count and announces the task and reported completion date.
- A definite failure keeps the task and offers Retry. A lost acknowledgement keeps it visible as unconfirmed and
  offers Check again; the real implementation must reconcile the same operation rather than invent a second write.
- Existing Move, Reschedule, Not doing and history-preserving dismissal meaning remain secondary. Completion Undo
  is not promised; a real reversal needs its own safe, reviewed contract.

`TASK_018_UX_PROPOSAL.html` is an isolated, interactive simulation. The preview badge, heading and state selector
are review aids only; they are not proposed additions to My Day. No production file imports it. It has no network,
localStorage, Firebase, account credentials or application-module access. The example titles/dates are synthetic;
22 records reproduce the owner's reported backlog size without reading or changing live tasks.

## Screenshots and measurements

Generated local evidence: `playwright-report/task-018-proposal/`.

| Viewport | Row height | Five-row section including header, hint and pager | Menu / date form | Overflow |
| --- | --- | --- | --- | --- |
| 360 × 800 | 64px | 445px | 224px / 272px | None |
| 390 × 844 | 64px | 445px | 224px / 272px | None |
| 1280 × 900 | 64px | 445px | 224px / 272px | None |

Each viewport has `unfinished-{ready,menu,date,saving,error,unknown,success}-<width>.png`.
The builder inspected ready views at all three widths, plus 390px menu, date, error and success renders.
The browser renderer also checked paging to all 22 distinct ids, date default, task retention during pending/unknown/
failed states, intended simulated success removal, unchanged menu-open section height, final-page menu containment,
Escape, collapse, tap targets, zero external requests and zero browser errors. `verification.json` contains measurements;
`render.mjs` reproduces them. These ignored artifacts remain local.

## Completion contract to confirm after UX acceptance

Starting design: `TASK_017_COMPLETION_DELETE_DESIGN.md`. No data-model changes are implemented by this proposal.

The proposed fact is a date-only `completionResolution` annotation on the existing original plan item, with reported
`date`, frozen `timezone`, assertion `recordedAt` and actor `recordedBy`. The original planned date, interval,
`done` and `doneAt` must remain unchanged. The annotation resolves active Unfinished discovery, independently of
the original day's outcome. A reported date does not imply an exact completion instant, tracked duration, original-day
completion, streak or Review result. Use a neutral reported-date label where date-only input cannot establish an
unambiguous before/after relationship to an operational interval.

Before implementation, the audit must settle exact source identity/revision, owner proof, source eligibility, concurrent
conflicting dates, same-intent replay, failed/unknown acknowledgements, authoritative persistence confirmation,
historical listener coverage, account-switch cancellation and old-client write rejection/retention. Local mutation or
a fulfilled enqueue is not sufficient proof of persistence. No second task store or hidden Move-to-today copy.

Consumer-audit starting points, not an approved production change manifest:

- Recovery and authority: `stale-plan-recovery-model.js`, `plan-authority.js` (`classifyItemActual`, stale actions).
- Original-day classification: `plan-tomorrow-model.js` (`classifyOneOffActual`, `summarizeActual`,
  `reconciliationBucket`); named plan/Review renderers in `index.html`; `tomorrow-timeline-model.js` and
  `tomorrow-view-ui.js`.
- Other completion readers: `intelligence-read-model.js` / `intelligence-ui.js`,
  `shared-accountability-model.js`, `partner-view-model.js`, linked Focus/Learning/Ledger consumers.
- Retention, merge, persistence and account boundaries: calendar/operational/legacy models, repositories, sync/live
  bridges, `storage.js`, `plan-item-origin.js`, `plan-fence-sync.js`, generated Firebase rules and their builder.
- Existing writers and compatibility: TASK-012 backend mutation/read/revision paths, `api1_` and `bdp1|` fenced items,
  recovery-copy identity, ordinary array items, post-cutover legacy plans and released old-client fixtures.

This audit is not yet complete. In particular, existing post-cutover write barriers, whole-plan old-client replay and
historical live subscriptions cannot be treated as solved by merely adding an optional field. A production file list
and bounded protocol must be confirmed before any runtime edits. If a safe complete slice cannot be proven, stop
with the specific blocker rather than exposing a nonfunctional checkmark.

## Current checkpoint

- Owner UX acceptance: **pending**. This is the owner's explicit build-sequence gate, not an additional approval rule.
- Production implementation, real completion write, data-model changes: **not started**.
- Full repository tests and final independent exact-candidate review: **pending implementation**; not claimed passed.
- Physical Android, live Firebase and real cross-device tests: **not performed**.
- No merge, push, deployment, TASK-016 work, deletion behavior or live-user task mutations.
- Final review-ready candidate SHA: **not available at this proposal checkpoint**.
