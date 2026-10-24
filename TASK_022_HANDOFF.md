# TASK-022 — Nudge fix implemented; QA BLOCKED / RELEASE HOLD

Owner-direct, 2026-10-23 America/Phoenix. Branch `task-022`, based on recorded
`origin/main` `1f171a29b55819c7b96872234a1b095d1e80d48c`. This task is separate from the
held TASK-020 HUD candidate. No existing checkout, archive or release candidate was replaced.
Live remote refresh failed in the sandbox; this is an exact local-base claim only.

## Cause and repair

`startSync()` listened to `uid_<recipient>/nudges/child_added` and unconditionally removed
every delivered child. Existing rules granted writes only to the linked partner. The Firebase
compat SDK optimistically removed the child, received `permission_denied`, restored it and
emitted `child_added` again. The unguarded callback repeated both notification and removal.
Stale/malformed records also repeated deletion indefinitely while the app appeared idle.

The deterministic pre-fix test hit its safety cap of eight deletes from one child and failed
all five regressions. A separate real Firebase 10.12.2 compat SDK test, using the old nudge
rules, observes three deliveries and two denied deletes, then detaches deliberately. The
server record is unchanged. No console output was suppressed in production to solve this.

The repair stays within the existing listener:

- Bind callbacks to the existing sync generation, authenticated UID and exact active inbox ref.
  Detach an earlier inbox ref before attaching again. Queued old-account/same-account callbacks
  cannot issue writes or show notifications.
- Mark the child ID **before** notification or removal. Per-UID Sets survive account switches
  and reattachment; `sessionStorage` receipts survive same-tab reload. A synchronous rollback
  replay therefore sees the marker before it can issue another remove.
- Attempt cleanup at most once per ID per tab session, including stale/malformed children.
  Catch the rejected promise and report `Nudge cleanup failed`; no retry timer, reconnect retry
  or receipt deletion starts another failed operation. New IDs continue to deliver.
- Missing/non-numeric/nonfinite/nonpositive timestamps never notify; timestamps older than the
  existing 30-second window never notify. Existing future-clock and sender-display behavior is
  preserved; this is not a new sender schema or clock-policy change.

Receipts are delivery/attempt markers, **not** proof of server deletion. They contain only
UID-scoped child IDs, no nudge contents, logs or plan data. They last for the tab session and
are not synchronized across tabs/devices. Each independent tab may notify once. If session
storage is unavailable/corrupt/full, the in-memory guard still prevents repeated operations
and duplicate notifications until that page is destroyed. Across reload with unavailable
storage, that guarantee cannot persist. Receipts grow with encountered IDs during a tab
session; quota failure retains the in-memory guard. Push IDs are not reused. A failed cleanup
is deliberately not retried for that ID in that tab session, even after a rules change;
a new tab session can clean up retained stale records without notifying about old history.

## Permanent least-privilege rules candidate

The builder adds one `$nudgeId/.write` grant requiring authenticated normal-token ownership
of the inbox and `!newData.exists()` at the individual nudge. The recipient cannot create,
replace, edit or retain a partially modified record. Removing a last nested property is
equivalent to deleting the entire individual nudge and may be authorized by Firebase's
cascading semantics; the guarantee concerns the final nudge state, not URL spelling.

The pre-existing linked-partner write grant remains at the inbox level with one narrowing:
the partner must be a different UID. Otherwise a self-link would bypass recipient delete-only
restrictions. Existing non-self partner send/edit/delete permissions are preserved, not newly
expanded. Inbox reads are unchanged. Root, user-node and all room/log/planning rules are unchanged.

Recipient parent/root PUT replacement/deletion remains denied. A root PATCH of individually
authorized nudge deletions is valid Firebase child-scoped authorization, not a root grant.
Mixed foreign/create/edit/foreign-log patches are denied atomically. Scoped Action API tokens,
strangers, former partners and unauthenticated recipients gain no cleanup authority.

Rules design follows Firebase's [cascading rules](https://firebase.google.com/docs/database/security/core-syntax)
and [newData conditions](https://firebase.google.com/docs/database/security/rules-conditions).
The real emulator, rather than the interpreter alone, verifies these boundaries.

## Verification and review

Local Node is 24.19.0, Java 21.0.12.1, Firebase compat 10.12.2 and checksum-provisioned RTDB
emulator 4.11.2. No hosted CI was run on this uncommitted candidate.

| Check | Recorded result |
|---|---|
| `npm test` clean complete run | exit 0; 2,275 Node-runner passes, zero failures, one existing opt-in skip across 2,276 cases; legacy 455/455 |
| Focused listener/rules/real-SDK tests | 35/35 pass, including same-account stale-ref regression |
| `npm run test:fence` | 157/157 pass, zero skips/failures |
| `npm run lint` final | exit 0; zero errors, 48 pre-existing warnings, no new warning |
| Generated rules / runtime mirror | pass; mirror closure 95 files, byte-identical |
| Deterministic scope / whitespace | pass; unrelated rules/storage/history preserved, release-token-only index/test change |
| First complete full browser run, six workers | exit 1; 967 expected outcomes, three unexpected failures |
| Focused three-repeat browser investigation | exit 1; 8/9 pass, one editor Save failure; token/layout each 3/3 pass |
| Untouched base editor comparison | 3/3 trace-off and 7/7 trace-on pass; all 100 exported runtime/config/test files match base Git blobs after checkout newline normalization |
| Final complete full browser run, four workers | exit 1; 969 expected outcomes, one Unfinished 390px layout failure |

Browser expected totals include seven existing annotated expected failures F-1–F-7. Those timer/logging
defects remain unfixed. Coverage was not measured. No fresh native-device, Android build or signed-in
production acceptance was attempted. Main/PR/protection/production-rule drift preflights remain deferred.

The first browser run exposed a retired `TOKEN` expectation in
`tests/calendar-native-plan-identity.spec.js`; it was updated only to the new governed generation,
preserving every assertion. Its other failures were the editor range and Unfinished 1920px layout.
The token and editor checks passed in the final full rerun; Unfinished 390px then failed with
`boundingBox()` returning null during the visible-control measurement. The unchanged test/UI paths
were not repaired or weakened in this task.

The independently inspected failed editor trace shows the live end-time input reached `03:00`
and remained there through and after the Save click. The editor stayed open and the timeline still
showed its prior `01:00` end; Playwright had retried the click while the element was unstable.
Submission apparently did not complete. The cause is unproven: this is **not** evidence of a database
overwrite or proven baseline flakiness. Ten passing baseline repetitions do not explain the candidate
failure. A later passing full-run editor check does not cancel the unresolved focused failure.

Independent agent `/root/nudge_review` inspected the actual diff, new tests, rules boundaries,
handoff, raw focused/fence/lint evidence and failed browser trace. Verdict: **no nudge implementation
must-fix identified; readiness BLOCKED by unresolved QA failure**. The repository's explicit
`QA.md`/AGENTS rule requires this hold. TASK-022 is `blocked`, not review/approved/done. No commit
was created; a final local file-hash manifest binds the retained uncommitted worktree. The formal
repository REVIEW.md was not edited. The final bound independent assessment is retained privately.

Self-review: scoped implementation is simple, no dead code/new warning/duplicate runtime helper or
unrelated refactor; its code-health checklist passes. Overall ship answer is **no while QA is blocked**.
Applicable data-integrity checks pass by exact scope comparison: timer exits, heartbeat, display
helpers, restore order, logged-time schema/write paths and planning implementation are unchanged.
No new controls/styles/layout were introduced. Existing task records/evidence are preserved.
No CODEMAP structure changed; protected planning/docs/status files were not edited. Git live-pull
and production checks were not performed or claimed. Independent assessment is not formal release approval.

Private local raw evidence is outside this worktree at the original workspace's
`release-verification/task-022/`. It must not be swept into a public commit. It includes
complete clean and interrupted logs, command/exit receipts, the deterministic scope audit
and final candidate binding. Early tool-only outcomes are explicitly labelled transcript
records in `initial-attempts.txt`, not represented as raw process logs.

The disk filled after installing this task's dependencies and interrupted initial full checks.
Those runs are not counted as successful. Only this task's newly installed dependency tree was
removed; an existing local tree is reused through a junction after matching lockfile SHA-256
`a6a6ebde32e95b43a088c474910b3509b411bb03a72c7bc04b97b28cfd259b7f`.
The existing tree is not edited by this task. Initial missing-package/spawn/peer-cache failures
and the corrected foreign-inbox fixture expectation are retained/disclosed in that record.
Two complete browser runs still failed after the environmental retries. Output-path quoting failures
in the private Windows evidence runner occurred before assertions and are also retained. A too-large
baseline export was removed (its dependency junction detached safely first), then replaced with a
size-checked 2.9 MB runtime-only baseline. Only task-created dependencies/transient artifacts/partial
baseline were reclaimed. Original checkouts, existing dependency source and prior evidence were preserved.

## Release hold and exact approvals still needed

No push, PR publication, merge, deployment, production Firebase read/write, GitHub security
change, AI Dev OS restart, dispatcher/Run-Merge or installed companion operation occurred.
The local fix does not change the warning behavior of any currently deployed client.

**Before any production approval request:** resolve or explicitly rescope the failed editor/layout
verification in a separately authorized bounded task, rerun the relevant gates and obtain independent
review of the resulting exact candidate. This task grants no authority to repair unrelated planning.
There is currently no review-ready release commit to approve or publish.

1. **Publication GO:** explicitly authorize publishing the final task-022 commit to a new
   branch/PR only. Recheck live main/head and scope first; obtain required CI and formal review
   on the exact published candidate and approved base. No force-push or security bypass.
2. **Client integration GO:** separately approve that exact candidate, the independently
   approved protected integration route and its automatic Pages publication consequence.
   The unresolved historical runner trust boundary is not solved by this task; do not use
   Run-Merge or treat this local security test as a substitute for that decision. Reconcile
   any changed main and reverify before requesting integration approval.
3. **Firebase rules deployment GO:** separately authorize the exact generated rules artifact,
   named production Firebase project/database, a live-rule drift comparison, preservation of
   the existing rules for rollback, deployment and post-deploy acceptance. Do not overwrite
   unknown production rule changes. None of those production actions is currently authorized.
4. **Acceptance/Android GO where applicable:** explicitly authorize any signed-in production
   test nudge/cleanup and a separate Android build/install/distribution. No fresh native-device
   or production acceptance is claimed here.

A safe proposed sequence is client first (bounds denied operations under old rules), then the
separately approved rules deployment (permits cleanup, including old clients). This sequence
is a proposal for release approval, not deployment authority. The fixed listener is exercised
against both old and candidate rules. Old-client cleanup compatibility follows from the tested
individual-delete authorization and code trace; the original listener under new rules was not
run as a separate SDK case. Rollback the rules only to a verified preserved live
artifact; retaining the repaired client avoids reintroducing the original loop under old rules.
Any code rollback must preserve later main changes and generated runtime parity.

STOP: scoped fix retained locally and independently assessed; mandatory QA blocked, release held.
