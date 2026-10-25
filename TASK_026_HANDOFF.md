# TASK-026 — Zero-minute entries at their creation source: BLOCKED (browser gate)

Owner-direct, 2026-10-24 America/Phoenix. Branch `task-026`, worktree `.worktrees/task-026`, base
GitHub main `e7d8b87`. Commit `828b289` is the independently reviewed TASK-025 candidate, copied
byte-for-byte (all 13 manifest SHA-256 hashes verified) and left otherwise unchanged; `storage.js`
is identical to it. TASK-026 is the working-tree diff on top. Local only: nothing pushed or merged.

## Entry-duration contract

- `[tsStart, ts]` (ms) is the tracked time. Producers never alter it.
- **Empty record**: `ts <= tsStart`. It contains no time. It is invalid and is never created.
- **Legitimate sub-minute activity**: `0 < ts - tsStart < 30 s`. It is kept, with exact timestamps,
  as `blockIntervalMin = max(1, round(ms / 60000))`. This matches `entryDurationMinutes()`, which the
  daily total and timeline already use, and the existing away/quick/common-log producers.
- **Midnight**: a block ending exactly at 00:00 belongs to its start day. It is not split.
- `validateEntry()` is unchanged. `blockIntervalMin < 1` remains a meaningful warning.

Why it matters: a stored 0 already counts as 1 minute in `entryDurationMinutes()`, but as
`settings.intervalMin` (30) in `insights.js:29`, `storage.js:2241` and the `|| settings.intervalMin`
aggregations in `index.html`. Zero-minute records make totals depend on which view reads them.

Pattern conflict, surfaced rather than blended: `stopAndLog`, `switchTaskMidBlock` and `autoLogBlock`
drop positive blocks under 30 s, while retro/away/common logs clamp to 1. For the defective producers
I chose the clamp, because the owner said not to discard legitimate time. The existing drop policy is
unchanged and is reported below.

## Changes (index.html only; www/ is the generated mirror)

- `endBreak()`: a positive interval logs at least 1 minute, with exact timestamps. An empty or
  clock-skewed interval logs no entry; the timer still resumes and the toast reads "Break over".
  The new record is validated at creation.
- `saveRetroEntry()`, `quickRetroLog()`: `spansMidnight` now also requires `tsEnd > midnight`.
  `makeQEntry()` clamps to 1 and validates at creation; the split toast uses the stored minutes.
- Side effect: editing a single, merged or scheduled block to end at midnight now keeps its original
  ID (and scheduled markers). Previously the split path replaced the ID with `midnight - 1`.

No generation-token bump: the service worker does not cache the app shell, and no module changed.
TASK-025's token (never published) covers the combined candidate.

## Repeated validation (determination; no change)

- Steady-state listener: unchanged rows are not revalidated. TASK-025 evidence: 20 replays give
  1 warning.
- Account bind: every genuinely malformed row is reported once per bind (page load, A→B→A).
  These warnings are accurate and meaningful, so they are not suppressed.
- Only loop on unchanged rows: remote rows missing both `ts` and `updatedAt` revalidate through the
  `resolveEntrySync()` `nowTs` fallback. Fixing it changes conflict resolution (red zone), so it was
  not changed. It produces zero Firebase entry writes.
- After this fix, new zero-minute records stop. The historical warning count therefore cannot grow;
  existing rows keep warning until a separately authorized history decision.

## The four owner duration records

Not attributable. Only the first redacted example was supplied: numeric ID, 0 minutes, 5.4 s,
no retro/auto/scheduled/away markers. Among current producers, that shape matches only `endBreak()`.
That is consistent with it, not proof, because older app versions could also have produced it.
The quick-retro empty fragment carries `retro: true` and has `ts === tsStart`, so it does not match.
The other three records have no data. Nothing was guessed and no historical row was changed.

## Verification

| Check | Result |
|---|---|
| Regressions before fix | 22 pass / 8 expected fail (`node-before/`) |
| After fix, plus two review-gap tests | 32/32 |
| Focused Node (entry, wiring, runtime generation) | 50/50 |
| `npm test` (final files) | exit 0; 2,307 pass, 0 fail, 1 existing skip; legacy 455/455 |
| `npm run lint` | exit 0; 0 errors, 48 pre-existing warnings |
| www mirror | 95 files byte-identical |
| Full browser QA, candidate | **0 of 4 full runs green**; each run had 1–2 failures from the two tests below |
| Full browser QA, unchanged TASK-025 baseline | 1 of 2 green; the back-to-back run failed the same two tests |
| Independent review | PASS-with-notes, no must-fix; its two test-gap notes were added |

Flaky tests, not caused by this change (neither can reach the changed functions):

- `brain-dump-plan-tray.spec.js:315` (two-tab convergence): 4/50 failures on each tree under load.
- `normal-tracking-hud.spec.js:287` (HUD poll race): same failure signature on the baseline; 24/24
  in isolation on both trees.

## Out-of-scope findings (reported, not built)

- `autoLogBlock` and `_doQuickSave` extensions recompute `prev.blockIntervalMin` without `max(1)`.
  With the 2-minute seam tolerance this can rarely produce 0.
- `_doQuickSave` new entry: `round(..) || settings.intervalMin` over-counts a sub-30 s block as the
  full interval.
- Live-timer producers drop sub-30 s blocks, which conflicts with the contract above.

## Release hold

Entry-creation paths are red-zone, so the gate is `approved`, never auto-merged. Not done: no
production data access, migration, push, PR, merge, Firebase rules change or deploy. Hosted CI,
native/Android and signed-in production acceptance were not run.
