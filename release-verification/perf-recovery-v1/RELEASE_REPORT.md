# Performance Recovery V1 release preparation

November 6, 2026. Decision: NO-GO. Hosted CI rejected a new required wider-suite failure.

Branch: perf/recovery-v1. Release candidate: fbe1c38cbeefb4b37bbb8bfa15ecfbf942f060cc.
Runtime commit: 8986703977a3cda51551fad040e9f2c293bece5f; the pin commit changes no runtime bytes.
Predecessor: 9fd8c912349219481908bccce8efb3fad35c5273. Both candidate commits are pushed.
Independent final committed-diff/accounting/CI review confirms NO-GO; see FINAL_INDEPENDENT_REVIEW.md.
Any subsequent evidence-only commit is separate from the CI-tested candidate above.

## Scope resolution

Initial independent review found that compactSettled() discarded historical bootstrap observation
payloads, conflicting with the no-trimming condition. Owner answered "whichever is better" to the explicit
scope choice. Compaction was removed, preserving all historical payloads and strict replay comparisons.
Revised independent review approves proceeding to a preparation commit. Both review records are retained.

## Verification

- Focused performance/preservation regression tests: 8/8 passed by the independent reviewer.
- Root/www runtime parity: 102 files, passed.
- Rules builder and Functions shared-copy checks: passed; no rules/Functions/Worker diff.
- Lint: passed, zero errors and 162 existing warnings.
- git diff --check: passed.
- npm test: exit 0, 2,420 passed, zero failed, one existing opt-in control skipped by the default chain.
  Explicit Windows control run: 15/15 passed, zero skipped; actual sibling path supplied after discovery failure.
- Exact web/Android packages: built from runtime commit and independently rehashed before pin update.
  See CANDIDATE_ARTIFACT_MANIFEST.json. Web and extracted bundle hashes match the hosted build.
- Pins updated only after verification; mandatory counts, failure catalog, evaluators and rules pin unchanged.
- Hosted [CI run 42269983544](https://github.com/shinyamadasan/Time-audit/actions/runs/42269983544): FAILED.
  Unit/lint/parity, Worker, rules job and packaged suite passed; packaged tests 62/62, zero failed/skipped.
  Rules job reports nine existing failures through its unchanged superseded evaluator; these are not passes.
  Mandatory accounting: 490/490 passed, zero failed/skipped; independently recounted from downloaded reports.
  Wider suite: 1,071 ran, 771 passed, 300 failed, zero skipped. One failure is outside the unchanged catalog.
  The wider aggregate and final release gate failed; no green-workflow claim is made.
- Prior successful wider run 41985833075: 1,071 tests, 772 passed, 299 failed, zero skipped. Baseline is not all-green.
- Complete comparison: CI_COMPARISON.json has zero absent/added cases, one newly failing case, no newly
  passing cases. All 299 prior failures remain; the new failure is additional.
- Final independent committed-diff/accounting/CI review: complete, NO-GO confirmed. No code-safety defect was
  identified in the bounded performance diff; the required hosted failure remains blocking.

No test-selection, skip annotation, outcome expectation or evaluator was changed. Existing platform/opt-in
Node skips remain visible; mandatory browser jobs enforce zero skips. The temporary untracked
tests/zz-perf-audit.spec.js declares itself an uncommitted audit harness; it remains untouched.

## Remaining risks and separate follow-ups

The new blocking case is daily-use-reliability's "two reminders retain pending time; Save/reload/Stop has no
duplicate coverage or HUD restart". page.evaluate(stopAndLog) lost its execution context; its final
no-duplicate/75-minute assertions were not reached. Five unchanged local repetitions passed. This does not
erase the hosted failure, establish its root cause or prove it harmless. No test or catalog was changed.

Accounting-history payload preservation is covered by regression tests. Known baseline failures include
safety assertions that fail during fixture setup or remain unresolved; being pre-existing does not prove safety.
An optional fresh synthetic audit and its unchanged rerun both timed out in emulator setup before measurements.
No new performance result is claimed, especially for removed compaction or slow devices. Details and limits
are in FAILURE_INVESTIGATION.md; no timeout, assertion or required test was weakened.

Keep storage/history growth, external-writer accounting conflicts, and slow-device performance as three
separate follow-up issues. This preparation attempt adds no implementation for those issues.
The separate API reliability and DevLabs integration workstreams are not modified. Active repository PRs
were inspected for boundaries; public connected searches yielded no current workstream handoff. No live
cross-workstream status is claimed. No API/backend edit, cross-workstream merge or production change occurred.

## Rollback and deployment boundary

Nothing was deployed or merged, so this attempt requires no production rollback. Predecessor packages were
built from 9fd8c912 and independently rehashed; web bf2443d9f1ee2b20d03ad223bca3b8e1678a9ea0f74248d2299885cc2c4e8cfc
and bundle 5ff0b43550193d85b8591afeb29bb9786c94a4268fb3a42046f49c2fad368e96 match the prior release pins.
See ROLLBACK_ARTIFACT_MANIFEST.json. Procedure for a separately authorized rollback:

1. Confirm the predecessor against the actual deployed version and retain the exact production artifacts.
2. Obtain owner approval for rollback to the predecessor; verify its web/bundle hashes before publishing
   through the approved release mechanism. No rollback command was executed by this task.
3. Use the release channel's compatible Android signing identity/version code. Do not uninstall, clear app
   data or force a data-destructive downgrade. Local debug APKs do not establish production signing parity.
4. Verify the restored version and retained entries/pending operations under the approved canary plan.
   Keep Firebase rules unchanged; do not repair/delete/trim/reconstruct accounting history.

Local and hosted APKs are debug-signed and have different binary hashes; verified bundle hashes match.
Production signing and real-device acceptance remain unverified.

Next approval: none requested for deployment. Resolve the required hosted failure and obtain successful
unchanged-gate CI plus independent review before returning for a separate deployment decision.

No main merge, production deployment, Firebase/rules change, production repair, or history modification
was performed by this preparation attempt. Deployment remains a separate owner decision.
