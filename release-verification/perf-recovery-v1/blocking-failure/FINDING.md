# Jomar: one blocking failure investigation

**Recommendation: NO-GO. No implementation or test-harness correction is justified by the available evidence.**

Original failed release run: [42269983544](https://github.com/shinyamadasan/Time-audit/actions/runs/42269983544).
Matched diagnostic run: [42280197609](https://github.com/shinyamadasan/Time-audit/actions/runs/42280197609),
diagnostic tooling commit `a3d461c029263b06d158f3067af76231ac666f7a`.

| Exact subject | Unchanged control | Separately instrumented copy |
| --- | --- | --- |
| Candidate `fbe1c38cbeefb4b37bbb8bfa15ecfbf942f060cc` | 10/10 passed | 10/10 passed |
| Predecessor `9fd8c912349219481908bccce8efb3fad35c5273` | 10/10 passed | 10/10 passed |

All 40 cases had one attempt, expected passing status, no skips and intact count checks. Both subjects used
Node 22.23.4, Playwright 1.61.0, Chromium 149.0.7827.55, two workers and the same Ubuntu 24.04 configuration.
Their target-spec and package-lock hashes matched; instrumented copies retained the original spec bytes
after an observer-only prefix. The instrumented observations have extra logging/CDP/sampling overhead and
are not performance benchmarks. The controls used the original spec/config without that instrumentation.

## Why the original context was lost

**Still unresolved.** Installed Playwright Chromium code maps non-JavaScript/non-session protocol errors to
the generic execution-context-destroyed message; the message does not establish a navigation. The original
run did not retain its raw CDP reply, lifecycle trace or terminal accounting snapshot. No natural
`Promise was collected` response or `stopAndLog` Runtime error was observed in the matched diagnostics.
The existing retained-action helper's comment remains a hypothesis for this incident, not its proven cause.

## Browser, resources and accounting

Each of the 20 instrumented cases recorded two main-frame navigations: initial load and the explicit test
reload. No monitored in-test page-crash, browser-disconnect or Inspector crash callback occurred.
Raw protocol logs nevertheless contain Inspector.targetCrashed notifications (10 candidate, 7 predecessor),
temporally near afterEach/teardown windows, plus non-probe session-not-found/no-resource error responses.
After deduplication those responses number 12 candidate and 12 predecessor. They must not be suppressed or
called proof of application crashes: raw session-to-test ownership is incomplete and two workers overlap.
The deliberately induced invalid-context probes were issued after assertions/terminal snapshots, tagged
separately, and are only evidence that error capture works. Unparsed, truncated and dropped record counts were all zero.

There were 72 candidate and 79 predecessor resource samples. Minimum MemAvailable was approximately
13.17 GiB and 13.23 GiB respectively; peak enumerated per-browser RSS sums were about 684 MiB and 694 MiB.
No sampled exhaustion or monitored in-test crash explains a reproduced failure. Cgroup event/limit files
were unavailable, so there is no cgroup OOM-history proof. These clean runs cannot exclude resource pressure
or crashes in the original run, and do not show that the performance changes caused its failure.

All 20 terminal snapshots contained two distinct contiguous live entry spans, matching both local storage
and the fixture server, with the timer stopped and the coordinator queue empty. They satisfied the original
**rounded 75-minute assertion**, not a new assertion of exactly 75.000 minutes. The unchanged HUD assertions
passed in all 40 tests; terminal HUD state was not separately captured by the observer.

## Limits and disposition

The original failure ran in a 278-case wider shard. Its worker had only five earlier cases from the same
daily-use spec; neither it nor the original successful comparator inherited an earlier holdEvaluates installer.
Other-worker work overlapped both original tests, but concrete concurrent cases differed. The successful
original comparator was commit `2b8857cb5e1decbb7d7d1762f3bff839b6c02ea8`; the fresh predecessor above is `9fd8c912`.
The isolated matched runs did not replay the original wider workload or recover its missing trace.

No source correction is proposed. Assertions, required counts, baseline catalog, accounting protections
and runtime remain unchanged. The green diagnostic run does not replace the failed required release gates.
Keep the original failure blocking; do not reclassify it as harmless or force release. No Phase 2 work.

Machine evidence: `MATCHED_SUMMARY.json`, `SOURCE_EVIDENCE.json`, `WORKER_PROVENANCE.json`, retained hosted
artifacts and `analysis/summarize.mjs`. The parent release report and independent Priya review remain authoritative
for the final owner handoff.
