# Performance Recovery V1: initial independent review

Date: November 6, 2026. Reviewer: independent_release_review (separate agent, read-only).
Input: uncommitted candidate on perf/recovery-v1, base 9fd8c912349219481908bccce8efb3fad35c5273.
Verdict: BLOCKED on authorization scope. This is not final committed-diff or release approval.

Blocking finding: accounting-command.js compactSettled() replaces input.frame and input.sourceCaches
with null inside historical hydrate-accounting operations. Operation rows, identities, receipts and
current state survive, but original historical observations cannot be reconstructed from that history.
sameInput() intentionally excludes the removed payloads from replay identity comparison. This conflicts
with the owner's explicit no-trimming condition and separately deferred storage/history growth scope.

No logged-time loss was demonstrated by the bounded review. Unresolved legacy facts receive a separate
retained capture and the committed projection survives. That does not establish permission to trim
historical inputs. Either explicitly authorize limited compaction or remove it, preserving payloads.

Other inspected changes: indexed physical-key resolution preserves strict identity and conflict checks;
callers bind resolvers to unmodified trees. snapshot() remains independent through freshly parsed storage.
No additional blocking correctness defect found in the inspected diff.

Reviewer verification: node --test perf-recovery.test.js passed 8/8, including 3,000 seeded equivalence
rounds, independent copies, retained-fact replay rejection and compaction-storage failure behavior.
Initial sandbox invocation failed with spawn EPERM; approved execution passed. git diff --check passed.

Not verified: final committed diff, exact packaged fingerprints, mandatory accounting/preservation hosted
CI, wider-suite evidence or final release approval. No production write or deployment was performed.
