# Independent TASK-037 review

Reviewer: `/root/task037_independent_review` (read-only delegated review explicitly included in owner authorization).
Verdict: **PASS for bounded local repair and retest-harness source; no remaining must-fix findings.**
This is repository handoff evidence, not owner/Claude release approval.

Independently ran model, notification and wiring tests: 68 passed, 0 failed/skipped. Initial default-
sandbox subprocess execution encountered EPERM; authorized rerun passed. No files edited by reviewer.

Findings fixed and regression-covered:

1. Separate register()/ready resolution could let a stale visibility cancellation clear a new backup.
   Only terminal cancellation bypasses the epoch; hidden transitions invalidate old nonterminal posts.
2. A stopped session's existing notification card could reopen logging. Ended keyed cards now close
   without dispatching open-log.
3. Real-SDK verification now attempts stale Save, asserts source-change refusal and re-reads committed
   remote data. Detecting a warning alone was insufficient evidence.

Reviewer approved the single calendar-model test correction: valid persisted preparation whose empty
arrays were pruned must equal its exact original preparation. Calendar merge/restore, malformed-list
and incomplete-confirmation assertions remain. The negative counterfactual described the repaired bug.

Confirmed source preservation: static HTML unchanged; index changes outside reviewed notification
sections are governed generation only; storage, Plan Authority, fence/rules and original seven-case
test file unchanged. Runtime/shared mirrors match their roots.

Harness review: only 127.0.0.1:8767 plus a separate loopback emulator; exact selected-HEAD runtime hash
checks, verified JAR checksum, capability/runtime allowlist, namespace-pinned proxy and same-origin
data CSP. Separate private state/namespace preserves TASK-036. Stop checks exact server path and
emulator parent/JAR and saves a snapshot before termination. Private state/logs ignored; JS/PowerShell
syntax checks passed. Actual post-commit startup/phone delivery remains separately verified.

Accurately retained limits: worker termination loses timers/in-memory deduplication; existing pending
break/takeover and periodic-snooze interaction is not strengthened; physical/hosted/integration gates
still require their own evidence. Final reviewed hashes are validated in SOURCE_REVIEW_HASHES.json.
