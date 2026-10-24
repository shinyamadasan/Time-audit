# TASK-023 — TASK-022 QA unblock — local gates PASS / RELEASE HOLD

Owner-direct, 2026-10-23 America/Phoenix. Isolated branch `task-023`, parent
`1f171a29b55819c7b96872234a1b095d1e80d48c`. Worktree:
`D:/ChronaSense-local-qa/task-023/implementation`. No publication or production authority.

The exact original TASK-022 overlay was copied from its uncommitted worktree, bound by
manifest SHA-256 `80aed9542b2f631b3a123d6069bba169232342ebde33340889175c49a8088d94`.
The original `.worktrees/task-022`, its blocked status/handoff and all prior private evidence
remain preserved. Its historical QA hold is resolved only by the new combined candidate if
this task's final gates and review pass; no original record is rewritten as if it had passed.

## Root causes and classification

### Editor Save: pre-existing application interaction defect

`PlanningContinuityUI.editTask()` rendered the editor and started an animated
`scrollIntoView({ block: 'start', behavior: 'smooth' })`. The retained failed trace already
showed scroll movement while Playwright aimed and delivered its Save click; the input stayed
at `03:00`, the editor remained open, and the timeline still showed its prior `01:00` end.

Fresh passive browser event recording under a controlled three-animation-frame input-delivery
gap confirmed the mechanism: the pointer was aimed at Save at y496.875 with scrollY203.
At trusted pointerdown, scrollY232 put Save at y447.875–487.875. The trusted pointerdown,
pointerup and click at the original point hit the FORM, not Save. Every field was valid,
endTime was still `03:00`, and neither submit nor invalid followed. The previous Save in
that same test had generated a trusted submit. The persistence operation was never requested
by the missed click; this is not evidence of a database overwrite or lost logged time.

The untouched baseline and exact TASK-022 runtime both reproduced this mechanism under the
same controlled conditions (three editor failures each). In the baseline ledger, Save moved
from sampled center y549.875 to bounds 455.875–495.875; the old click point hit the sleep
reminder item below it. That is the destination after Save moved, not evidence that an
overlay intercepted an unmoved Save. Their `editTask()` implementation
and global smooth-scroll CSS are identical. This establishes a pre-existing interaction
problem exposed by timing, not a nudge permission/rules regression. The original trace is
consistent with this independently recorded hit-target failure; its own native event ledger
was not available and is not invented here.

**Minimal correction:** change only `editTask()` navigation to `behavior: 'instant'`. Using
`auto` would still inherit the existing global smooth-scroll CSS. Other navigation animations,
editor fields, form validation, scheduling, persistence, sync and time-log paths are unchanged.
The same controlled pointer probe then hits Save, submits, closes the form and persists the
same item/day with the intended 240-minute range. A permanent browser regression uses genuine
mouse input after that frame gap, with no forced click, synthetic DOM click, repeated Save or
programmatic submission. It checks form closure, canonical identity/day and persisted duration.

### Unfinished layout: pre-existing test-harness sampling race

The test enumerated `button:visible, summary:visible` via `locator.all()` and then made a
separate asynchronous `boundingBox()` request per control. The app's ordinary `render()`
replaces `recovery.innerHTML`; a refresh between locator resolution and geometry retrieval
can detach that particular element. The observed failure is `null.height`, not height below
44px. Real read-only refresh pressure reproduces the original failure on both baseline and
TASK-022 (three failures each), without any nudge callback or CSS change.

The first prototype using `locator.evaluateAll()` also caught detached elements: selection
can precede callback evaluation across protocol turns. That rejected prototype and its three
layout failures are retained. The accepted test queries the controls **inside** one
`page.evaluate()` callback, selecting visibility and measuring geometry in that same browser
turn. It requires exactly 12 expected controls, both five-row action sets with IDs 000–004,
connected nodes and every height >=44. Missing or undersized controls fail; no failed result
is filtered away or retried. The original dates, title, menu/history, overflow, screenshot
and refresh-preservation checks remain intact. No application layout change is needed.

This is consistent with Playwright's documented [dynamic-list limitations](https://playwright.dev/docs/api/class-locator#locator-all)
and [nullable geometry result](https://playwright.dev/docs/api/class-locator#locator-bounding-box),
and is proven locally rather than inferred from those descriptions alone.

### Environment and reproducibility limits

Fresh ordinary matched probes passed 8/8 on both baseline and candidate. Controlled probes
in the primary comparison failed 6/6 on each old variant and passed 6/6 on the accepted fixed
variant (editor 3 + layout 3). The independent reviewer's shorter before-fix probe happened to
pass 2/2, and its fixed probe passed 2/2. These timing-dependent probes are **not** claimed to
fail on every execution or to estimate a natural failure rate. The failing trusted-event
ledger, matching old-source behavior, rejected stale-handle prototype and successful narrow
interventions explain the failures; later green repetitions are not their explanation.

Both matched variants use Node 24.19.0, the same installed Firebase/Playwright/Chromium,
configuration, one worker, tracing on, synthetic data, passive event hooks, D: temp/cache and
identical probe source changes. Input binding/inventory receipts distinguish baseline from
candidate; no production Firebase is used. Existing valid TASK-022 raw logs/traces were reused.

C: remained nearly full despite D: test temp, so only the new task-023 worktree was relocated.
Git's cross-drive move returned `Improper link`; 662 source files were copied and byte-verified, its two dependency/audio junctions were detached before removing the temporary C:
copy, and `git worktree repair` registered the D: location. TASK-022 was never moved/deleted.
The relocation receipt is retained. All new evidence/temp stays on D:, with about 50 GB free.
No old evidence or dependency source was cleaned up.

## Exact delta beyond the reviewed TASK-022 input

- `planning-continuity-ui.js`: one editor-navigation scroll option, smooth to instant.
- `tests/calendar-native-plan-identity.spec.js`: one genuine-pointer regression and expected
  governed generation; all prior assertions remain.
- `tests/unfinished-ux.spec.js`: atomic geometry sample with stricter expected-set checks.
- `index.html` and `personal-day-boundary-web-runtime.test.js`: governed generation
  `20261023-task023-qa-unblock-v1` and retirement of TASK-022's generation only.
- Generated `www/index.html` / `www/planning-continuity-ui.js` mirror those source changes.
- TASK-023's own TASKS.md entry, this handoff and append-only CHANGELOG/TEST_REPORT evidence.

Storage, nudge receipt logic, rules builder/generated rules, nudge tests, package/test wiring
and TASK_022_HANDOFF.md remain exact TASK-022 input bytes. All other tracked inputs are
unchanged. No Plan Authority, source schema, Firebase sync or timer implementation was edited.
No code structure moved; CODEMAP/doc/AI Dev OS files were not changed.

## Verification and independent review

All scoped local gates pass. The independent exact-candidate assessment is retained in the
private evidence packet; it is distinct from formal repository/release approval. Completed checks:

| Check | Result |
|---|---|
| Reused TASK-022 failing full browser runs | 967 expected/3 unexpected; later 969 expected/1 unexpected |
| Fresh matched ordinary probes | baseline 8/8; candidate 8/8 |
| Matched controlled pre-fix probes | baseline 0/6; candidate 0/6 (same editor/layout mechanisms) |
| Rejected evaluateAll prototype | editor 3/3; layout 0/3, detached-handle checks fail |
| Accepted controlled prototype | 6/6 pass, original outcome assertions plus stricter geometry |
| New permanent pointer test on unchanged TASK-022 runtime | 0/3; form remains visible after missed click |
| Final focused checks, three repetitions | 18/18 pass; editor, pointer, generation, 360/390/1920px layouts |
| npm test | exit 0; 2275 Node passes, 0 failures, 1 existing opt-in skip; legacy 455/455 |
| Firebase fence/rules integration | 157/157 pass, no skips/failures |
| Lint | exit 0; 0 errors, 48 existing warnings, no new warnings |
| Full browser QA, four workers | exit 0; 971 expected outcomes (964 ordinary passes, seven annotated expected failures), no unexpected failure |
| Rules generation / runtime mirror / whitespace / scope | pass; 95-file mirror; one runtime option only |

Raw logs, command receipts, source/probe scripts, before/after traces, rejected prototype and
preservation/hash audits: `D:/ChronaSense-local-qa/task-023/evidence/`. These private artifacts,
like the old TASK-022 packet, must not be swept into a public commit. Full browser QA includes
the complete affected specs; no extra duplicate full-spec run is needed. Known annotated
expected failures F-1–F-7 remain outside this correction; no claim that those defects are fixed.

## Status and release boundary

**PASS:** local scoped implementation, preservation, self-review, applicable AI QA, complete
browser/Node/Firebase checks and independent review. No nudge/QA implementation must-fix
was identified. TASK-023 is `review`; independent assessment is not formal release approval.
**FAIL (historical, explained):** the preserved pre-fix editor and layout reproductions and
rejected stale-handle prototype. No unexplained final gate failure remains.
**UNVERIFIED:** hosted CI, live main/PR/protection drift, production rules/state, signed-in
production acceptance, native-device feel/rendering and Android build/install/distribution.
Coverage was not measured. Seven existing annotated timer/logging defects remain unfixed.

TASK-022 **can advance to local release preparation through this combined TASK-023 candidate**.
Original TASK-022 stays frozen/blocked as historical evidence; this candidate supersedes its
QA blocker without rewriting the failed packet. It remains uncommitted and unpushed, bound
by the final file-hash manifest. No exact release commit or publication approval is claimed.
Git pull/live remote checks are deferred; the base claim is local only.

Code Health passes: one runtime option, no new runtime helper/state/query, no orphan/debug
code, no new lint warning, and no unrelated refactor. The scoped ship answer is yes for
review/release preparation, with the production approvals below still held. Applicable AI
QA is satisfied by the complete suites and exact scope audit: timer exits/heartbeat,
device guard, display helpers, force sentinel, restore ordering, logged-time schema/write
paths and all planning persistence remain unchanged. No CSS/input/handler was introduced.
No architecture decision or CODEMAP structure change is needed. Protected AI Dev OS/docs
files are untouched; human-device limits are recorded here under the owner's local scope.

Publication, integration/automatic Pages publication, exact-project Firebase rules deployment,
production acceptance and Android release still require the separate approvals described in
TASK_022_HANDOFF.md. The historical runner trust boundary is unchanged: no Run-Merge use or
claim that these QA corrections establish a trusted integration route. Recheck live main/head,
required protections/CI and production rule drift under the relevant later authorization.
No push, merge, deployment, production data/security change or AI Dev OS modification occurred.
