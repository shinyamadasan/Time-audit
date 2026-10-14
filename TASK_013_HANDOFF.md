# TASK-013 — Independent Review Handoff

For a fresh reviewer who did not build this task. The builder self-reviewed; that is not independent review.

- Branch `task-013`, base `origin/main` `bc71f146a374edeafe141073adb8ce0d46330048`. Not pushed, not merged.
- Diff is test + docs only: `tests/daily-use-reliability.spec.js`, `docs/RELIABILITY_BASELINE_V1.md`, `TASKS.md`,
  `CHANGELOG.md`, `TEST_REPORT.md`, this file. Confirm: `git diff --stat bc71f14..task-013` shows no runtime file.

## Reproduce

```
npm ci --legacy-peer-deps
npx playwright test tests/daily-use-reliability.spec.js --workers=1              # 29 passed (7 expected-fail)
T13_STRICT=1 npx playwright test tests/daily-use-reliability.spec.js --workers=1 # 22 passed, 7 failed = F-1..F-7
npm test; npm run test:smoke; npm run lint; npm run check:www-parity; npm run check:firebase-rules; npm run test:fence
```

## What to check

1. **Harness fidelity.** The Firebase stub and clock (top of the spec) must not manufacture the failures. In
   particular: offline = no data snapshots until reconnect + rejected writes; termination = page closed without
   `beforeunload`; a normal reload moves the live clock so `beforeunload` stamps the heartbeat "now".
2. **Each F-n is a real contract violation, not desired future behavior.** Contracts cited in
   `docs/RELIABILITY_BASELINE_V1.md` (recovery modal copy, Hard Rules 4/9, notification copy, Evidence Contract
   computed `blockIntervalMin`, exactly-once entries). Challenge especially F-4 (which interval a ping-tap log
   should cover) and the offline framing of F-1..F-3 (online they are masked by remote re-adoption).
3. **PASS rows are executed**, not inferred from source; "existing" rows cite suites that passed in this run.
4. **Smoke flake.** `planning-continuity.spec.js:161` timed out in both candidate full runs; a control run without
   the new spec failed a different pre-existing test. Decide whether that evidence is sufficient.
5. **Next task.** One recommendation only (TASK-014, F-4 + F-5), dependent on owner decision D-2.

Gate if accepted: test-only, but it documents red-zone behavior; hold at `approved` (owner merges), no auto-merge.
