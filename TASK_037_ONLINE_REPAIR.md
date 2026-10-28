# TASK-037 — bounded online release repair

**Local repair: GO for repository review and a brief online phone retest. Production: NO-GO.**
Owner authorized the proposed bounded local repair on October 27, 2026 America/Phoenix. Branch:
`task-037-online-release-repair`, isolated from approved reliability `9aaf021` and visual `ab0c601`.
No push, merge, production data/rules access, deployment, migration or UI redesign occurred.

## Defect-to-resolution evidence

| Blocker | Cause and smallest repair | Strict evidence |
|---|---|---|
| Planner Save reports source change after its own acknowledgement | RTDB omits empty ID arrays. Persisted `normalizePreparation` now restores only omitted lists to `[]`; malformed lists, required metadata and confirmation inputs retain validation. Shared source/fence comparison is unchanged. | Baseline: 6 failures among 50 model/SDK cases. Fixed: 50/50; own Firebase-shaped UI echoes 3/3. Fresh actual-SDK UI Save/reload/second-browser persistence plus attempted stale-Save refusal passed 3 repetitions. |
| One-minute sound without an Android notification card | Hidden-page ticker could schedule then asynchronously cancel its own backup. Page and worker now share owned session/due keys, one due receipt, next-interval backup and terminal cancellation. Cancellation epochs fence deferred registration messages. | Initial scheduler run: 5 failures among 9 cases and an unhandled notification rejection. Final: 17/17 strict cases, covering both orders, repeats, Stop, old-account cancellation, quiet/ownership guards, old unkeyed clients and stale card clicks. Physical delivery remains pending for this candidate. |

Both diagnosed source paths already existed in the approved visual baseline. Original TASK-035
seven-scenario bodies are byte unchanged. No recorded-time schema, sync path, accounting cursor,
Plan Authority or source-protection rule was modified. Notifications introduce only transient local
worker receipts; they do not write time records or Firebase data.

## Local gates

- Complete existing browser suite: **1,017 passed**, no failed/skipped/expected-failed/retried cases.
  The fresh actual-SDK UI test was added after that run's discovery; it ran separately **3/3**, so
  all **1,018 unique browser cases** were exercised on the same frozen product source.
- Original seven strict reliability scenarios: **21/21** across three repetitions, unchanged assertions.
- Full `npm test`: **2,342 passed / 1 existing opt-in diagnostic skip**, zero failures; legacy harness
  **455/455**. Skip: lower-case-drive diagnostic requiring `CROSS_REPO_COMPAT_CONTROL_PROOF=1`.
- Required Firebase rules/fence/SDK/mutation gate: **170/170**, no skips.
- Worker: **32/32**, bundle dry run passed without upload. Lint: **0 errors / 48 existing warnings**.
- Runtime closure **98 files**, shared-domain and generated-rules parity passed.
- Protected historical worktrees: **5,512 hashes across seven trees unchanged**; approved TASK-035
  tracked tree clean. Static app markup, styles, rendering adapters, storage, Plan Authority,
  Brain Dump/fence/rules and original seven-scenario file remain unchanged.

Exact results, source/test hashes and compressed logs are indexed in
`review-artifacts/task-037-online-release-repair/`.

## Review and verification corrections

Independent source/test review passed after two findings were fixed: a stale visibility cancellation
could arrive after registration independently resolved, and an ended-session card could reopen logging.
Separate register/ready promises and ended-card regressions cover both. See the review record and hashes.

One existing calendar test asserted the old defect as a negative counterfactual: raw persisted
preparation with RTDB-omitted empty lists must be unreadable. Independent review approved replacing
that single assertion with exact equality to the valid original preparation. Calendar restore/merge
and all malformed-list/input-refusal assertions remain; none of the original seven assertions changed.

The first full Node attempt stopped at that obsolete counterfactual. A later attempt hit an unchanged
Windows stale-lock rename `EPERM`; the isolated test passed unchanged and the subsequent complete
Node gate passed. No unrelated lock code or timeouts were changed. New real-SDK fixture iterations
corrected startup/authority ordering and an unpinned third-client cache; final verification uses actual
second-browser Plan Authority and asserts committed remote data plus attempted stale-Save refusal.
Failed-attempt logs are retained and are not counted as passes.

Full browser tests regenerated historical visual-output copies inside this new worktree. Their new
screenshots/metrics were saved under this task's evidence, then only those owned baseline copies were
restored. Protected historical worktrees were untouched.

## Self review / QA

Code health: scoped changes, existing patterns, named bounded receipt limit, no new runtime module,
no unreferenced helper, no UI input/style changes and realistic rejection paths absorbed. Every new
notification helper is called; dedup state is bounded. Account cancellation captures the old session
instead of relying on mutable roomCode. Persisted-only ID defaults do not relax input construction.

Applicable AI QA passed: tests/parity/source validation, original heartbeat/restore/display invariants,
device guard and source fences retained; generated copies exact; no unrelated tracked source drift.
Would ship as a **local review candidate**, with `ship-pending-human-review` for physical delivery.
Repository status is review only; independent review is not Claude/owner release approval.

## Brief online retest

Separate USB-only instance, **port 8767**; original port-8765 test instance and its records are preserved.
No certificate, Wi-Fi firewall rule or real Google account is used. Source hash checks pin the exact
local candidate; emulator/admin transport remains loopback-only and production connections are blocked.

Phone Chrome app URL:

<http://localhost:8767/?access=9bfb71241b96f525371afd55375afbd1a8cbdfd6d75d4134>

1. My Day → Plan your next day → Plan Tomorrow. Add one priority, Save plan, reload; confirm saved.
2. With only this app tab open, start a test task and allow notifications. Background Chrome. Tap
   the one-minute Android card, Save, then Stop after another minute; reload and check retained time.

This is a short **online** retest. Remaining manual offline walkthroughs are deferred by owner;
automated offline/data-preservation gates remain required and passed. Instance readiness/USB reachability
is recorded separately after launch; the URL alone does not claim completed physical acceptance.

## Remaining limits and release order

Service-worker termination still loses timers/in-memory deduplication; this repair adds no background
delivery infrastructure or guarantee. Existing pending-backup break/takeover and snooze/periodic-tick
interactions are not strengthened or claimed fixed. Snooze alone and Stop cancellation are verified.
Old unkeyed worker messages retain their backup protocol. Dedicated completion backend, real Google
sign-in and native Android distribution are outside this isolated browser instance.

Current main/TASK-032 backend changes remain separate from this old-base candidate. A safe integration,
required hosted `test` and `Firebase fence / rules integration` checks, and formal exact-head/base
repository review require separate authorization. No merge, rebase, push or protection bypass occurred.

After those and physical acceptance: capture actual live client/rules and rollback artifacts → explicitly
authorized reviewed **rules first** → verify live guard and older/newer-client canaries → separately
authorized integrated client publication. Pages auto-publishes main; merging main is a production action.

Rollback uses the captured compatible client while retaining source protection and every historical
record. Do not clear storage/captures, replay plan writes, restore old user data or remove fences.
Rules rollback needs its own review/authorization. No production deployment is authorized here.
