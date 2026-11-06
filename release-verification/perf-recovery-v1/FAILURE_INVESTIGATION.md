# Remaining test failures: investigation and limits

Baseline: hosted run 41985833075, commit 2b8857cb5e1decbb7d7d1762f3bff839b6c02ea8.
Its wider suite reports 1,071 cases: 772 passed, 299 failed, zero skipped, across 29 failing files.
All 299 failures are in the pre-existing catalog; that catalog has not been changed in this work.
Candidate run 42269983544 on fbe1c38cbeefb4b37bbb8bfa15ecfbf942f060cc is complete and FAILED.
CI_COMPARISON.json independently recounts all 1,071 cases: 771 passed, 300 failed, zero skipped;
zero absent/added cases, all 299 previous failures retained, one additional failure outside the catalog.
PARTIAL_CI_COMPARISON.json is an earlier partial checkpoint, not the final result.

## New blocking failure

daily-use-reliability.spec.js: "two reminders retain pending time; Save/reload/Stop has no duplicate
coverage or HUD restart". The report records "Execution context was destroyed, most likely because of a
navigation" at page.evaluate(() => stopAndLog()), after reload and the retained-span/HUD assertions.
The final two-record, contiguous-span and 75-minute-total assertions were not reached.
The error text suggests navigation but does not prove a navigation or its cause. There is no retained
hosted browser trace or authoritative record snapshot proving the terminal accounting outcome.

The exact unchanged committed case was run locally with --repeat-each=5: 5/5 passed. This only establishes
non-reproduction in those local attempts; it neither erases the hosted failure nor establishes a baseline
flake. No test was changed, added to the catalog, skipped, given retries or marked expected-failing.
Required release verdict remains NO-GO. Hosted original evidence and new-failure-isolation.json are retained.

## Existing failures

The independent reviewer inspected representative raw errors and fixtures. These observations describe
what the reports demonstrate; catalog membership does not establish a harmless root cause.

| Observed category | Evidence and consequence |
| --- | --- |
| Missing historical fixture | Two accounting-extension-mv3 cases invoke git show on unpublished commit 73739e9. Their historical-writer behavior is not exercised. |
| Stale generation expectation | One calendar-native-plan-identity case pins an older runtime generation. The governed generation tests pass, but this case still fails. |
| Legacy/mock integration mismatch | Inspected fixtures simulate SDK persistence without the shipped REST accounting capability or insert records directly before legacy persistence. Their assertions are not verified by labeling the fixtures obsolete. |
| Setup fails before the named safety hazard | The inspected UNKNOWN-hazard cases fail while establishing the initial saved timer. The inspected Focus reload case remains idle where work is expected, before reload is exercised; baseline and candidate partial signatures match. |
| Unresolved assertions | Focus recovery, account isolation, entry preservation, logging, learning outcomes and UI behavior remain among the failures. This bounded performance preparation does not fix or prove those guarantees. |

Largest baseline failing files: smoke (52), learning-plan-ui (30), time-ack-unknown-hazards (28),
focus-reload-recovery (24), daily-use-reliability (22), remaining-remote-account-isolation (18),
normal-tracking-hud (14) and plan-linkage-up-next (14). Exact test titles/errors are retained in downloaded
baseline reports and the deterministic comparison output. No failure has been relabeled by this work.

The rules job also executes nine existing failures through its unchanged superseded evaluator:
four entry-tombstone rules cases and five entry-reliability SDK cases. The existing catalog says these
expect unfenced owner writes that the strict rules refuse. They remain reported failures, not passes.
Other required rules/fence checks and all 43 mutation cases pass. No rules change was made.

Hosted Node TAP summaries: 2,414 passed, zero failed, six existing platform/opt-in skips. They comprise
two Windows/opt-in path controls and four Windows dispatcher cases. The local Windows default chain
passed with its one opt-in skip; the explicit real-checkout control then passed 15/15 with zero skips.
No skip annotation was added or changed. Mandatory browser accounting and packaged jobs enforce zero skips.

Optional fresh performance audit: the unchanged temporary harness was attempted twice, each time yielding
one beforeAll timeout and one case not run; no app measurements were produced. Direct emulator-helper
startup succeeded in 1,688 ms and direct JVM/loopback probes worked. The Playwright setup cause remains
unresolved. Windows also reported paging-file exhaustion when subsequently launching GitHub CLI; this
is context, not proof of the timeout cause. No test timeout, assertion or selection was weakened.
Harness SHA256: 1ca6082709bb64f044eca595aa140bc5d7029830c2f4e0aa126d40819fcf6bd7.
Original measurements from the removed-compaction candidate do not establish final-candidate timings.

Release interpretation: distinguish an unchanged-baseline CI gate from all tests passing, and distinguish
mandatory accounting coverage from the safety scenarios that failed before their assertions were reached.
No full safety or final performance guarantee follows from a green aggregate job alone.
