# TASK-039 CI blocker repair — APPROVED / HELD

**No confirmed must-fix findings in the local repair. Production remains NO-GO.**

Reviewer: `/root/task039_formal_fallback`, separate read-only Codex agent.
Reviewed checkout: `task-039-hosted-ci-repair`, based on pushed candidate `ddb6c6d4456085ca30b8cc8ccae847dcb791792d`.
PR base: `ce24092f4037cbacd9e2cf79a7465638bb8ef2ec`.

This verdict binds the source hashes below. Final commit binding must be confirmed after packaging. The repaired candidate has not passed hosted CI or been authorized for push.

## Repair assessment

| Hosted blocker | Local repair | Review |
|---|---|---|
| Real-SDK browser setup lacked the emulator in the separate test runner | Java21 and existing checksum-pinned provisioner before unchanged full smoke | Appropriate prerequisite repair; failure remains fatal through `&&`; no skipped or softened tests. |
| Exact44 reference capture measured58.375 under Linux hinting | File-scoped `--font-render-hinting=none` | Acceptable reference-render stabilization; original test bodies/assertions/timeouts remain byte-identical. |

With bundled Inter loaded, default Linux text measured100px against Windows94.812683px. The isolated flag restores Windows advance and44px height without app, CSS, font-asset or viewport changes. The app specifies minimum44px; default Linux still satisfies that minimum. This fixture repair does not claim every native browser renders exactly44px. Existing native Linux wrapping remains.

## Independent checks

- Functional delta is exactly the workflow and three inserted fixture lines. Removing those bytes reproduces the original test file after checkout line normalization.
- All remaining non-evidence tracked files match ddb6c6d; runtime/assets/accounting/backend/ownership/fences/rules are unchanged. `git diff --check` passed.
- Actual archived Linux and Node logs match recorded decompressed SHA256 values.
- Linux affected files: **102 passed**, 34 unique cases ×3, zero failed/skipped/expected/retried,6.3minutes; network disconnected.
- Full Node: **2392 passed /1 existing diagnostic skip /0 failed**; legacy455/455 as recorded.
- Windows visual3 and SDK21 passes; runtime98/www/shared/rules parity passed as recorded. These are tool-captured implementation evidence; reviewer did not rerun tests.

Canonical-LF SHA256:

- `.github/workflows/ci.yml`: `4979dac5617e4f7e8e5fa8913faad9e663fdeb735a1b7c4adc1bf401223b9372`
- `tests/daily-command-center.spec.js`: `f463f1b05360f23f41625f3e53b878acf5caa716deac7d02e71b9f2af078af34`

Original hosted run remains FAILED:1019 browser passes,2 failures,6 not run. Earlier local1027-pass suite is historical, not a newly executed full repaired suite. **Full new hosted CI NOT RUN.**

## Limits and disposition

This is separate-agent **Codex D-048 fallback review**. Builder/reviewer both use Codex; not independent-provider review or GitHub human approval.

**Claude Guardian Gauntlet NOT RUN / NOT PASSED**: actual Claude attempt hit its API usage limit. No substitute advisors are represented as that gate passing.

Recommended **approved, HELD**, subject to final commit/hash binding and required hosted verification. Never done. Reviewer changed no files, statuses, commits or remote state.

Next requires separate owner authorization to push the exact newly packaged repair and rerun both hosted checks. Keep PR draft. No merge/auto-merge, deployment, live rules/data changes or additional phone tests authorized.
