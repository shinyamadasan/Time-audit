# TASK-013 — Independent Review Handoff

For a fresh reviewer who did not build this task. The builder self-reviewed; that is not independent review.

- Branch `task-013`, base `origin/main` `bc71f146a374edeafe141073adb8ce0d46330048`. Not pushed, not merged.
- First candidate `6d9dbb9`: independent review verdict **FIX FIRST** (R1–R3). The rework commit on top of
  it carries only those corrections.
- Diff vs main is test + docs only: `tests/daily-use-reliability.spec.js`, `docs/RELIABILITY_BASELINE_V1.md`,
  `TASKS.md`, `CHANGELOG.md`, `TEST_REPORT.md`, this file. Confirm: `git diff --stat bc71f14..task-013`.

## Reproduce

```
npm ci --legacy-peer-deps
npx playwright test tests/daily-use-reliability.spec.js --workers=1                  # 29 expected outcomes (7 expected-fail)
npx playwright test tests/daily-use-reliability.spec.js --workers=6 --repeat-each=3  # 87/87
T13_STRICT=1 npx playwright test tests/daily-use-reliability.spec.js --workers=1     # 22 pass; F-1..F-7 fail on the line after knownFailure()
npm test; npm run test:smoke; npm run lint; npm run check:www-parity; npm run check:firebase-rules; npm run test:fence
```

Mutations (edit `index.html` temporarily, then `git checkout -- index.html`):

- **M2**: make `_doQuickSave()` return at its first line. F-4, F-5 and D-2 must fail for real.
- **M3**: make `quickRetroLog()` return at its first line. F-6 and F-7 must fail for real, at their
  local-creation preconditions.

## Targeted re-review: R1–R3

**R1 (expected-failure integrity).** Each `knownFailure()` call sits directly before the single contract
assertion, after:
- setup and UI presence (recovery prompt, quick-log overlay and Continue button);
- creation of the entries under test, in memory and in the account's local slot;
- for F-6/F-7, a sync push that reached the remote.

**R2 (stronger passing assertions).**
- D-2 asserts the quick-log entry exists before Stop, and exactly one quick-log entry plus one Stop entry
  after it.
- S5 native asserts that `schedule` was called.

**R3 (documentation), in `docs/RELIABILITY_BASELINE_V1.md`:**
- F-4 → DESIGN_DECISION_NEEDED (D-4: notification copy vs quick-log UI).
- F-5 frequency marked unverified.
- TASK-014's dependencies (D-1/D-2/D-4) and possible red-zone reach.
- The forced `ta3-session-started` flag and the reopen-with-auto-start gap.
- Stub vs SDK differences (offline `once()`, rejected vs pending writes, reconnect order).
- The stub-dependent toast.
- The corrected clock description.

## Still open for the reviewer

Smoke flake: in the first candidate's full runs `planning-continuity.spec.js:161` timed out (30 s budget),
and a control run without the new spec failed a different pre-existing test. Check this rework's smoke
result in `TEST_REPORT.md`.

Gate if accepted: test-only, but it documents red-zone behavior. Hold at `approved` (the owner merges);
no auto-merge.
