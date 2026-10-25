# TASK-027 — Browser QA stability: PASS

Owner-direct, 2026-10-24 America/Phoenix. Branch `task-027`, worktree `.worktrees/task-027`.
History: `e7d8b87` (main) → `828b289` (TASK-025, byte-exact) → `a056713` (TASK-026, byte-exact
copy of its candidate) → TASK-027 working-tree diff. Only test files and records change; TASK-025/026
implementation is identical to `a056713`. Local only.

## Causes

**C8 (`tests/brain-dump-plan-tray.spec.js`) — test harness clock.** Each new tab started its own
mock clock from the same `now`, so tab B (opened after A had created the capture) ran behind A.
B's claim was stamped before the capture's `createdAt`; `normalizeCapture()` correctly rejects a
record with `updatedAt < createdAt`, so B's committed transaction carried no claim and A's later
claim won. That gave two signatures: line 349 (wrong winner; reachable only on odd
`repeatEachIndex`, so full-suite runs rarely hit it) and line 347 (local/remote `promotedAt`
offset by the same inter-tab clock gap). Two real tabs share one device clock, so the harness was
unrealistic. Fix: a second tab (`fresh: false`) adopts the context's clock origin from
localStorage. The assertions are unchanged. Reload and `__setNow` behaviour are unchanged.

**HUD (`tests/normal-tracking-hud.spec.js:287`) — test sampling race.** Timeline:
- `focus-ended` arrives at ~10 ms.
- The selector confirms the normal session at ~0.8–0.95 s.
- The 1 s tracking poll projects `tracking-active` at ~1.41–1.46 s.

The test sampled once at 1500 ms, inside that window under load. The HUD behaves to its 1 s poll
contract. Fix: keep the 1500 ms settle wait and both branches. In the tracking branch, wait (bounded,
5 s) for the exact `tracking-active` projection. Added assertion: every post-break `tracking-active`
message must carry the authoritative title and start time.

No app code, entry, Firebase record, duration or sync change. No sleeps, retries or skips added.

## Verification

| Check | Before | After |
|---|---|---|
| C8 x12 (w4 / w2) | 9/48, 12/48 failed | x24: 96/96, 96/96 passed |
| HUD sampled inside the race window | 12/12 failed (exact TASK-026 signature) | 12/12 passed |
| Both specs x8 under load (w4 / w2) | — | 336/336, 336/336 |
| HUD mutant (companion down after the break) | — | fails 3/3 (wait is not vacuous) |
| Full browser suite, 4 workers | 0 of 4 TASK-026 runs green | **972/972** |
| Full browser suite, 2 workers | 0 of 1 TASK-026 run green | **972/972** |
| Independent review of combined candidate | — | PASS-with-notes; no must-fix in test changes |

Unchanged gates from TASK-026 still hold: npm 2307 pass / 0 fail, lint 0 errors, 95-file mirror,
because runtime and Node tests are byte-identical to `a056713`. Diagnostic specs and raw logs are in
`release-verification/task-027/`.

## Separate defect (recorded, not fixed)

The review found a pre-existing Brain Dump cross-device clock-skew defect, which was confirmed. It is
recorded as a P1 Approved Backlog item in `planning/ROADMAP.md`. It is not caused by TASK-025/026/027
and was not needed to stabilize these tests.

## Release state

- TASK-026 → `approved` (red zone: held for the owner's merge).
- TASK-027 → `approved` (tests only, but held with its red-zone parent).
- TASK-025 remains `review` per its own assessment.
- No push, PR, merge or deploy.
