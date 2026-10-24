# TASK-024 — Local release candidate / PUBLICATION HOLD

Owner-direct, 2026-10-24 America/Phoenix. Authority is local release preparation and one local
commit only. Branch `task-024`; isolated worktree `D:/ChronaSense-local-qa/task-024/candidate`.
This record is part of the candidate; its final commit/tree binding is retained outside Git
in the new private preparation packet. No push, PR, merge, deployment or production action.

## Candidate and preservation

The combined TASK-022 nudge fix plus TASK-023 QA correction was verified against all 22 raw
file SHA-256 values in the retained manifest:
`787cc36936a6c8569714f3f96f141b165719f11022527fd60a98ef1b97722186`.
Independent assessment SHA-256:
`13c17920a812fcf1c8544e0e7c238c86f4314fbb059b8cb9174a649ab95b100d`.
Reviewer `/root/qa_unblock_review`: PASS for scoped local QA unblock and local release
preparation; no implementation must-fix. That assessment covers the exact reviewed inputs,
not new administrative records or formal repository/release approval. The earlier nudge
review and original blocked packet remain intact; TASK-023 explains the resolved QA hold.

Original TASK-022 and TASK-023 worktrees, statuses, handoffs, manifests and private evidence
remain unchanged. The new worktree contains the same runtime, rules, tests, generation and
package wiring as the reviewed candidate. Only TASK-024's entry/status, this new handoff and
append-only CHANGELOG/TEST_REPORT preparation records differ. Historical records are retained,
including the old blocked/uncommitted descriptions of the original worktrees.

Private raw evidence is not in this commit. No logs, credentials, dependency trees, traces,
probes or temporary artifacts are included. The private preparation packet retains source
and assessment hashes, complete non-junction preservation inventories, GitHub receipts,
commands/exits, staged/committed blobs and final commit binding.

## Main, ancestry and exact scope

Read-only GitHub comparison confirmed live main remains
`1f171a29b55819c7b96872234a1b095d1e80d48c`, identical to the reviewed base (zero commits/files).
The release branch starts at that exact commit; one new local commit is prepared on it.
No reconciliation, rebasing, force update or replacement of an existing checkout is needed.
GitHub main must be rechecked immediately before the local commit and again for any later
publication/integration request. An unexpected change stops this preparation.

The expected release diff contains exactly these 23 paths:

- CHANGELOG.md
- TASKS.md
- TASK_022_HANDOFF.md
- TASK_023_HANDOFF.md
- TASK_024_HANDOFF.md
- TEST_REPORT.md
- firebase-rules.test.js
- firebase.rules.json
- index.html
- npm-test-wiring.test.js
- nudge-listener.test.js
- nudge-rules-emulator.test.js
- nudge-test-support.js
- package.json
- personal-day-boundary-web-runtime.test.js
- planning-continuity-ui.js
- scripts/firebase-rules-builder.mjs
- storage.js
- tests/calendar-native-plan-identity.spec.js
- tests/unfinished-ux.spec.js
- www/index.html
- www/planning-continuity-ui.js
- www/storage.js

No extra implementation delta. Client receipts stop denied-delete rollback replay and duplicate
notifications; rules permit only individual recipient deletion with normal-token ownership,
without broadening parent/root permissions. The self-link restriction and existing non-self
partner authority are preserved. TASK-023 changes only editor navigation from smooth to instant
and fixes the layout test's sampling race with stronger control identity/size checks.
The governed generation stays `20261023-task023-qa-unblock-v1`.

## Complete validation record

Runtime/test inputs are unchanged, so full-suite evidence is retained rather than rerun.
Results below distinguish the reviewed candidate's suites from fresh preparation checks.
Local test environment: Node 24.19.0, Java 21.0.12.1, Firebase compat 10.12.2,
checksum-provisioned RTDB emulator 4.11.2. No hosted CI has run on this local commit.

| Verification | Result / origin |
|---|---|
| Nudge pre-fix deterministic test | All five regressions fail; one child reaches safety cap of eight delete attempts, retained TASK-022 evidence |
| Real old-rules compat replay | Three deliveries/two denied deletes before deliberate detach; server unchanged, retained TASK-022 |
| Focused listener/rules/real-SDK | 35/35, retained TASK-022; final combined fence revalidates authorization |
| Earlier browser failures | TASK-022 full 967 expected/3 unexpected, focused 8/9, later full 969 expected/1 unexpected; retained, not silently discarded |
| Matched ordinary QA probes | Baseline 8/8; candidate 8/8 |
| Controlled pre-fix QA probes | Baseline 0/6; candidate 0/6, three moving-Save and three detached-geometry failures each |
| Rejected evaluateAll prototype | Editor 3/3; layout 0/3; not included |
| Corrected controlled QA probe | 6/6 |
| New pointer regression on old runtime | 0/3, form remains open after missed click |
| Independent shorter probes | Before 2/2 and after 2/2; timing-dependent reproduction, no universal failure-rate claim |
| Final focused browser repetitions | 18/18, retained TASK-023 |
| Final complete browser, four workers | Exit 0; 971 expected outcomes: 964 ordinary passes plus seven annotated expected failures; zero unexpected failures, retained TASK-023 |
| npm test | Exit 0; 2,275 Node passes/zero failures/one existing opt-in skip across 2,276 cases; legacy 455/455, retained TASK-023 |
| Firebase fence/rules integration | 157/157, zero skips/failures, retained TASK-023 |
| Lint | Exit 0; zero errors, 48 existing warnings, no new warning, retained TASK-023 |
| Fresh preparation tests | 30/30, rules-builder/runtime-mirror/test-wiring checks, TASK-024 |
| Fresh generated Firebase rules | Exact builder artifact (LF/CRLF allowance only), TASK-024 |
| Fresh generated runtime mirror | 95-file byte-identical source closure, TASK-024 |
| Preservation / scope / staged diff / whitespace / secret scan | Mandatory pre-commit verification, receipts in private TASK-024 packet |

The known annotated timer/logging defects F-1–F-7 remain unfixed. Coverage was not measured.
The npm cross-repository opt-in control proof was not enabled; no hidden skip is counted as
pass. Ordinary passing repetitions do not explain historical failures: trusted-event geometry
shows Save moved before delivery; same-turn DOM query/measurement removes the refresh race.
Prior failed/environment-interrupted runs remain preserved in the original packets.

Code Health and applicable AI QA pass for this local preparation: no implementation changes,
new helpers/state/CSS/handlers/schema, dead code or new warnings. Existing timer exits,
heartbeat, device guard, display helpers, restore ordering, logged-time and planning persistence
remain unchanged. No CODEMAP structure/architecture decision or AI Dev OS edit is required.
The scoped ship answer is yes for local release preparation; later production approvals remain
held. Human-device behavior and polish are unverified and are recorded here under the owner's
bounded scope, without editing protected STATUS/planning files.

## Rollback baseline and release limitations

Code rollback baseline: main commit `1f171a29b55819c7b96872234a1b095d1e80d48c`,
tree `1d0f7ab3b3efcb800f485345bc7885f438641479`. The local candidate's parent is that exact base.
Baseline `firebase.rules.json` Git blob: `f1628cd95d8d3f2286672be12bf1207091dd2ddd`.
Candidate generated rules SHA-256:
`266d6577dfdf1708b1eb4464dd1b49ba16175880d2ea96519a35b49ccf8f2864`.

This is a source rollback reference, not a verified copy of current production rules.
No live Firebase rules or production data were read or changed. Before any separately
approved rules deployment, compare live drift and preserve the exact live rules artifact for
rollback; never overwrite unknown changes or roll back production to an assumed Git baseline.
If rules alone are rolled back, retain the repaired client to avoid reintroducing its old
permission-denied loop. Any later code rollback must reverse only this candidate's code delta
against then-current main, preserve later work and keep generated mirrors in parity. Do not
replace user data or revert unrelated releases. Rollback is a plan, not action authority.

PASS: local candidate preparation and retained scoped implementation/QA review.
UNVERIFIED: hosted CI/formal PR review/effective protections, production-rule drift, signed-in
production acceptance, native-device/iOS/Android behavior and Android build/install/distribution.
Original worktree statuses remain historical; TASK-024 uses `review`, not approved/done.

Remaining approvals are separate:

1. Publication GO for the exact final local commit to a new remote branch/PR only, after main
   and scope recheck. Required hosted checks and formal review must cover the published exact
   head/base; no force push or permissions bypass.
2. Integration GO for the exact approved candidate, a separately security-approved protected
   route and automatic Pages publication. Historical Run-Merge trust-boundary concerns remain
   unresolved; this task does not approve or run that route or establish its replacement.
3. Firebase rules deployment GO for the exact artifact and named production project/database,
   live drift comparison, preserved rollback rules, deployment and post-deploy acceptance.
4. Explicit signed-in production nudge/cleanup acceptance and Android build/install/distribution
   authority wherever applicable. No fresh production/native acceptance is claimed.

Proposed release sequence remains client first, then separately authorized least-privilege rules.
No push, PR creation, merge, Pages/rules deployment, production-data/security modification,
dispatcher/Run-Merge or AI Dev OS restart/modification is authorized or performed.

STOP: local release preparation only; publication requires separate owner GO.
