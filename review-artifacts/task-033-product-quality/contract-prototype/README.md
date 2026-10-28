# Unsafe, unconnected contract experiment

This directory is evidence, not application runtime or a deployment artifact.
Do not deploy its rules. Direct selection was never connected to the planner.

To inspect/replay the positive checks, use a disposable copy of d7e01d0. Decompress
UNCONNECTED_EXPERIMENT.patch.gz, apply the resulting patch, and place brain-dump-confirmation.js and its test
at that disposable root. Install the pinned dependencies, then run the model/
sync/promotion/confirmation tests and npm run test:fence (Java 21 required).
No production account, Firebase project or real user data is needed.

Those checks passed after correcting two fixture errors. They are incomplete:
the later replay-writer-probe demonstrates the invariant they failed to cover.
TASK_033_PROMOTION_CONTRACT.md records the independent findings and remaining policy.
All experimental production changes were removed from the final visual candidate.

Patch and raw logs are byte-preserving gzip archives; ARCHIVE_MANIFEST.json records original and archive hashes.
