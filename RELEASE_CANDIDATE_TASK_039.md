# TASK-039 published release candidate

This branch publishes the reviewed two-user release candidate **1ed7da0** for hosted CI. It is not
merged and not deployed. Production stays NO-GO until the owner's later gates (G-DEVICE, G-PROD-READ,
G-DEPLOY, G-CUTOVER), G7, G8 and final acceptance are complete.

## What is published

- The tree of 1ed7da0, minus the local qualification evidence. The 49 local TASK-039 commits are not
  published; one commit on top of `main` (f73edd4) carries the candidate tree instead.
- Left out: `accounting-hazards/evidence/`, `review-artifacts/`, and the evidence result files in
  `accounting-hazards/` and `unknown-recovery-proof/`. They include device-census metadata and stay in
  local private storage. Documents may still name those paths.
- The first commit changes no runtime, rules, verifier or test file from 1ed7da0. Later commits change
  only CI: `.github/workflows/ci.yml`, three `scripts/ci-*` files, Linux and online-Gradle support in
  `scripts/build-release-artifacts.mjs`, this file, and the CI guard in `npm-test-wiring.test.js`.
  The guard still forbids any soft-failing step; it now requires every fence suite file to run whole,
  with only the 9 recorded superseded tests allowed to fail.

## Runtime identity (checked in CI on every run)

| Artifact | SHA-256 |
|---|---|
| Packaged web tree (102 files) | `1a91a98fe48d472a25d27e5ce65c58c3a6891232423d576c4a3cfdaf1703fb4f` |
| Android bundle tree (APK `assets/public`) | `2639ff910c8cf5a9aa4ff6f5a62db24f9dc83d69f48690ba014da127227b42a6` |
| Stage B rules (`firebase.rules.json`) | `93f0a77424e730aa5996825af4183e0d42d5f29251260b8f85eea3756645be00` |

The APK binary itself depends on the build machine and its debug key, so CI builds its own debug APK and
checks the bundle inside it. The reviewed APK (`21ab0f99…56444d`) stays the installation artifact.

## CI layout (`.github/workflows/ci.yml`)

Runs on pushes to `main` and `release/**`, pull requests to `main`, and manual dispatch.

Required (all feed the `Required / release gate` job):

- unit: `npm test`, lint, `www/` parity, rules builder and functions-shared checks;
- rules: rules emulator suites, installed-rules verifier, real-SDK fence suites, rules mutation;
- accounting: the 9 accounting specs, 482 tests, one worker, 3 shards; a count job requires exactly
  482 passes;
- packaged: builds the web and Android release bytes, checks the hashes above, runs the packaged spec
  (62 tests);
- worker: Conversational Read Worker tests and bundle;
- regression: the other 62 browser specs (1,071 tests, 4 shards, exact total checked). Any failure
  outside the recorded known failures fails CI.

Reported, not blocking (`scripts/ci-known-failures.json`):

- 9 emulator tests whose expectations the strict rules supersede. They still run inside their files,
  every other test in those files is required, and their results appear in the job summary;
- 314 known wider-suite failures recorded at 629ace0. Each run lists which still fail and which now pass;
- 2 MV3 extension tests that read their fixture from a local commit absent from the published history.
