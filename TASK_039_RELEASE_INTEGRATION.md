# TASK-039 — final local release integration

**GO for hosted CI and formal review preparation. Production: NO-GO.**

Branch: `task-039-release-integration`. Final local commit is reported with this handoff and in
`review-artifacts/task-039-release-integration/POSTCOMMIT_STATUS.json` after the commit is saved.
Current-main base: **ce24092f4037cbacd9e2cf79a7465638bb8ef2ec**. Approved app input:
**bd96cccfec9bb893a44bc6573d0e04356cd80333**, retaining ab0c601 visuals and 9aaf021 reliability.

## Combined candidate

- Carries the approved planning/Daily Command Center, Eisenhower/Brain Dump, visual, reliability,
  notification, planner wire-normalization and two-line Save repair. Direct Eisenhower insertion
  remains deferred; no feature/design work was added.
- Preserves current-main TASK032 root/shared/www commitment model, both-account API/Worker isolation,
  legacy completion/rescheduling and desktop PC Time autostart removal. Backend/Worker source is
  exactly current main; approved time accounting, offline recovery and device/account guards remain.
- The one integration-authored runtime repair pins `commitments-model.js` in the existing governed
  import map. An actual warm-cache test proved an old cached model otherwise rejects valid RTDB-pruned
  date-only records despite correct new model bytes. Model/validation unchanged; unified generation:
  `20261027-task039-release-integration-v1`. Root/www mirror exact, 98 runtime files.
- Reviewed Firebase rules and builder match the approved candidate exactly. No new rule logic,
  live rules change, migration or production-data access occurred.

Both applications of source patches were clean. Four overlapping source/test paths combined without
manual contract changes. Canonical main documents/history were retained; only this task's entry and
append-only logs were authored. There was **no git merge**, main update, push, deploy or publication.
The unpublished integration branch alone was softly reparented when remote main advanced.

## Exact local gates

| Gate | Actual result |
|---|---|
| Complete browser suite | **1,027 passed**, 0 failed/skipped/expected failures; 17.1 minutes |
| Complete final `npm test` | **2,392 passed / 1 existing opt-in diagnostic skip**, 0 failed; 2,393 Node tests total; legacy harness **455/455** |
| Focused combined browser checks | **30/30**, ten cases repeated three times: planner/Save adapters, desktop startup/restoration, warm upgrade |
| Final self-contained warm-cache test | **3/3**, unchanged strict assertions; actual pre-fix red **1 failure** |
| Original seven strict scenarios | **21/21**, three repetitions; original file unchanged from approved input |
| Final rules/fence/SDK/mutation | **177/177**, 0 skips; includes latest-main legacy moves/completion under approved source guards |
| Final Worker | **44/44**, bundle **dry-run PASS**, no upload |
| Lint / generated parity | **0 errors / 48 existing warnings**; runtime/shared/rules parity PASS |
| Independent review | **PASS**, no product must-fix; independent backend **86/86**, warm browser **1/1** |
| Preservation | **11 protected trees / 9,091 tracked hashes unchanged**; 340 approved imports and 35 retained-main paths verified |

The one Node skip is the existing lower-case-drive diagnostic gated by
`CROSS_REPO_COMPAT_CONTROL_PROOF=1`; it is not an expected failure or a hidden strict scenario.

Remote main advanced from 0d9ab8f to ce24092 during verification. All 98 browser-runtime files,
59 browser test files and their 94-file static dependency closure had zero intersection with that
delta; the completed browser result therefore covers identical final browser/test/server bytes.
Full Node, Firebase and Worker gates were rerun on the refreshed backend, not borrowed from old main.
See BROWSER_GATE_SURFACE_PROOF.json. Remote main was rechecked at ce24092 before final packaging.

## Evidence, self review and limits

IMPORT_PROVENANCE.json binds each approved input blob and final-main retention. PRESERVATION.json,
SOURCE_REVIEW_HASHES.json, INDEPENDENT_REVIEW.md and GATE_RESULTS.json bind the tested composition.
Compressed logs/failed setup attempts are indexed by original/archive SHA256. All 11 generated visual
outputs were archived, then only this checkout's imported historical output copies were restored.

Self review/AI QA passed: minimum metadata fix, no new runtime helper/state/schema, centralized guards
and accounting intact, UI static markup frozen, required hooks/heartbeat/restore ordering retained,
all local gates green and exact source verified. Would ship as a local repository-review candidate:
yes. TASK039 status is review; independent review does not grant formal/production approval.

Setup attempts are not counted as passes: initial warm fixture needed explicit date precision; its
actual red then reproduced the old-cache defect. The initial broad run was interrupted to remove
Git-history dependence from the test fixture. The final frozen historical fixture is self-contained.
Evidence-only CRLF copies were restored; long Windows evidence paths were verified via blob IDs,
without skipping files or relaxing assertions. No application timeout or assertion was weakened.

No additional phone test was requested/performed. Prior physical planner/reminder evidence remains
historical, not a new phone Save/Stop claim. Browser worker/process termination still limits reminder
delivery guarantees. Existing legacy API whole-history validation refusals stay fail-closed with app
fallback; they were not relaxed or repaired by touching production records.

## Remaining gates and single next approval

No unresolved **local integration implementation** blocker remains. Still required:

1. Hosted **test** and **Firebase fence / rules integration** on the exact pushed head/base.
2. Formal repository/Claude exact-head/base review, without protection bypass or auto-merge.
3. Separately authorized live inventory/compatibility/rollback capture and rules-first rollout,
   verified guard plus old/new-client canaries, then separately authorized client publication.
   **Merging main can publish Pages**, so it remains a production action.

The single next approval is:

> Authorize pushing the exact final task-039-release-integration commit and opening a draft PR
> against main for required hosted CI and formal repository review only. No merge or deployment.

CI_AND_REVIEW_STEPS.md and PR_BODY.md contain the ready agent steps/content; no owner terminal work
is requested. COMPATIBILITY_AND_ROLLBACK.md specifies rules-first order, both-account compatibility,
required live artifacts and data-preserving rollback. Live versions were not inspected in this local
task; historical deployment markers are not substituted for fresh capture. Rollback retains source
fences, TASK032 compatibility, both account mappings and every valid record/tombstone.
