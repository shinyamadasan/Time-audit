# Revised candidate independent review

November 6, 2026. Reviewer: independent_release_review (separate agent, read-only).
Input: revised uncommitted perf/recovery-v1 candidate based on 9fd8c912349219481908bccce8efb3fad35c5273.
Verdict: suitable for a preparation commit. Initial authorization blocker resolved; no release approval.

Owner replied "whichever is better" to the explicit choice between removing compaction and allowing it.
The implementer chose preservation under the original no-trimming condition.
accounting-command.js now changes only snapshot() to return the freshly parsed envelope.
Compaction and relaxed replay comparisons are removed. Historical frames, source caches, operation
identities and receipts remain intact.

Independent verification: revised regressions 8/8 passed, including complete historical-payload retention
and rejection of altered bootstrap frames/sourceCaches; root/www 102-file byte parity passed;
git diff --check passed; no diff in Firebase rules, rules builder, Functions or Worker directories.
No additional blocking correctness finding in the revised bounded diff.

Final committed SHA, packaged fingerprints, hosted CI and final independent verification are outstanding.
