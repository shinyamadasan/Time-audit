# TASK-039 — hosted CI and bounded local closure

**Production NO-GO. Draft PR #20 remains on the exact authorized ddb6c6d commit.**
PR: https://github.com/shinyamadasan/Time-audit/pull/20
Head: `ddb6c6d4456085ca30b8cc8ccae847dcb791792d`.
Base: `ce24092f4037cbacd9e2cf79a7465638bb8ef2ec`; remote main was rechecked unchanged.
CI run: https://github.com/shinyamadasan/Time-audit/actions/runs/40669652533
GitHub tested synthetic PR merge `c42fad10655ca694c15a8bba72919685e9c9cd1c`, explicitly combining those head/base SHAs. No main merge occurred.

## Actual hosted outcome

| Check | Result |
|---|---|
| Required `test` | **FAIL**: browser 1,019 passed, 2 failed, 6 did not run; 17.5 minutes |
| Unit portion of `test` | 2,386 passed / 6 existing platform or opt-in skips / 0 failed; legacy 455/455 |
| Worker portion | 44/44, bundle dry-run passed; no upload |
| Required `Firebase fence / rules integration` | **PASS**, 177/177: rules110 + SDK29 + mutation38; no skips |

HOSTED_FAILURE.json records the exact tests, assertion and prerequisite failures. Both hosted checks retain their real terminal statuses. No rerun or passing result is invented.

## Confirmed blockers and smallest local repair

1. `TASK-033 actual product review captures` expected height44 and measured58.375 on Linux. Reproduced exactly in an isolated Linux container. Bundled Inter was loaded; identical width113.5 nevertheless had text advance100 versus Windows94.81268310546875. Changing only Chromium hinting to `none` reproduced the Windows advance and height44. The affected test file now uses that reference-render setting. **Every original test body, assertion and timeout is byte unchanged.** Native Linux hinting may still produce the taller, valid wrapped control; product CSS specifies a minimum44 height. This is a reference-render fixture repair, not a claim that all platforms have identical native metrics.
2. The real-SDK browser file failed beforeAll because its separate GitHub runner lacked the emulator jar, leaving six more cases unrun. The test job now installs Java21 and invokes the existing version/SHA256-pinned provisioner before the unchanged full smoke command, chained with `&&`. Missing or corrupt prerequisites still fail strictly.

Only `.github/workflows/ci.yml` and `tests/daily-command-center.spec.js` have executable changes: Java/provisioner setup and three test-fixture lines. No product file, style, schema, accounting, identity mapping, guard, Firebase rules or runtime generation changed. No dependencies were upgraded. Direct Eisenhower insertion stays deferred.

## Local verification of the repair

- Linux: **102/102 actual passes**, 34 unique cases across both affected files, each repeated three times; zero failures, skips, expected failures or retries. External networking was disconnected during tests. Fresh emulator download/checksum and Java21 startup passed.
- Windows: reference capture **3/3**; all seven SDK planner/Save cases **21/21** across three repetitions. Original unmodified visual case also passed on Windows.
- Complete local `npm test`: **2,392 passed / 1 existing opt-in diagnostic skip / 0 failed**, 2,393 total; legacy **455/455**. Full output is compressed and hashed.
- Runtime closure **98**, www/shared/rules parity and diff whitespace checks passed. Discovery remains **1,027 tests in 58 files**. Independent comparison confirms all runtime/assets/backend/fence bytes and original test bodies unchanged from ddb6c6d after normal checkout line handling.
- Earlier passing fence/Worker/local full-browser/strict-scenario records remain evidence for unchanged source. They are not described as a fresh full hosted pass of this new local commit. Full hosted rerun is pending push authorization.

Actual red/diagnostic/probe attempts are retained locally. The initial describe-scoped launch option failed Playwright discovery and was corrected to supported file scope before final tests; it is not counted as a pass. Windows' sandbox initially refused a child process; authorized execution passed. A Linux attempt could not use Windows dependency junctions; the final container installed the same locked dependencies. No application code or assertion was changed to accommodate these setup attempts.

Self-review/AI QA: minimum prerequisite reuse and supported scoped fixture; no runtime helper/state, UI change, timeout change, assertion weakening or guard bypass. Would ship this test-only repair as a CI/review candidate: yes. Formal fallback verdict and source hashes are archived separately; repository task remains review, never done.

## Review, limits and single next approval

Claude's actual review attempt hit its API usage limit before any model work or guardians. The separate Codex CLI also failed before review. The documented D-048 fallback used a separate read-only Codex agent; builder and reviewer share the same provider/engine. Original candidate review was **APPROVED / HELD**, with no source must-fix, and a new delta review covers this local repair. **Claude Guardian Gauntlet NOT RUN / NOT PASSED**; no GitHub human approval is claimed.

The local repair branch is `task-039-hosted-ci-repair`, based directly on ddb6c6d. Final local commit and its source binding are recorded after commit in POSTCOMMIT_STATUS.json and the owner response. Nothing newer than the authorized ddb6c6d has been pushed. PR stays draft, auto-merge disabled; no source-protection settings were changed. All original candidates, records and historical worktrees remain intact. No phone test, production access/write, merge, rules deployment or publication occurred.

**Single next approval:** authorize pushing the exact reviewed local repair commit to the existing `task-039-release-integration` PR branch for hosted CI and exact-head/base review only. The previous authorization explicitly limited pushing to ddb6c6d, so it cannot be extended silently. This is not release or merge authorization.

Remaining release gates: green hosted checks on the new head; owner/reviewer disposition of the missing Claude Guardian review; separately authorized live compatible-artifact/rollback capture; reviewed rules first, live guard and older/newer-client/two-account canaries, then separate client-publication approval. Merging main can publish Pages. Rollback retains source fences, TASK-032 compatibility, both account mappings and every historical record/tombstone; it does not restore old user data or automatically weaken rules. See the existing COMPATIBILITY_AND_ROLLBACK.md.
