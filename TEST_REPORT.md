# Test Report

> **Codex writes; Claude reads.** Append-only. One entry per task run.
> Tests: `npm test` (node test.js) and Playwright. Manual: `SMOKETEST.md`.

---

## Phase 8 — recommendation-honesty fixes (post independent review) · 2026-09-02
branch: `feat/cross-domain-intelligence-v1`. Pre-fix HEAD `5fb7dc280732c26cd7fb2ba81ca0a8de32708d9a`,
  base `4857dc4d2a63c4aac4660edf8940f63c6e7f6d16` (verified). Isolated worktree; original `main`,
  Meal, and Workout untouched (status + protected hashes re-verified).
scope: the two BLOCKER fixes only — bare recency-fallback plan must not be a recommendation
  (Finding 1); plan-level historical alignment must not grant HIGH indefinitely (Finding 2,
  reuses `CAPABILITY_CAREER_ANALYTICS_RULES.recentDays`). 3 files changed:
  `cross-domain-intelligence-model.js`, `cross-domain-intelligence-model.test.js`,
  `tests/cross-domain-intelligence-ui.spec.js`. No UI code, no `index.html`, no `style.css`, no
  Character Sheet model.
suite: `node cross-domain-intelligence-model.test.js`; `npm test`; `npm run test:adapter-contracts`;
  `npm run lint`; `npx playwright test tests/cross-domain-intelligence-ui.spec.js` + the full
  Playwright suite; strict `npm run test:cross-repo-compat` with `MEAL_REPO_PATH` /
  `OPENGYM_REPO_PATH`; `node --check`; `git diff --check`; control-byte / UTF-8 scan.
result:
  - `node cross-domain-intelligence-model.test.js`: 45/45 (was 35). New: M (single recency
    plan → no candidate, abstain, signal stays), M2 (multiple recency plans → same), N
    (metadata-only `updatedAt` bump makes the sheet pick Plan B, engine still abstains, Plan B
    never in `candidates`, abstention reason says "picked only by recency"), N2 (flipping which
    plan is newest doesn't change the abstained outcome), O (old target-linked completion link
    → candidate stays MEDIUM/tier-4 because the plan is actively tracked, `aligned:false`,
    explanation does not imply current alignment), and 3 recency-boundary tests (observedAt ==
    lower bound → HIGH; 1 ms before → MEDIUM; future → MEDIUM). "Character Sheet parity: step
    counts" split into an abstention variant (signal carries `6 of 10` / `6/10`, never `5 of
    10`) and a tracked-plan variant (count in the recommendation `why`).
  - self-audit script (10 explicit proofs) — all PASS: bare recency → no candidate; metadata
    `updatedAt` → no recommendation; recent explicit chain → HIGH; old linkage → MEDIUM not
    HIGH; tracked-not-aligned → MEDIUM/tier-4 actionable; neither → abstain; coverage behavior
    unchanged; capability ranking unchanged; Character Sheet unchanged; no source/project
    stores modified.
  - `npm test`: PASS. 671 model/unit — `test.js` 448; workout-adapter 33, meal-adapter 45,
    meal-cross-repo 10, temporal-regression 20, life-feed-model 36, life-character-sheet-model
    34, cross-domain-intelligence-model 45. 0 fail, 0 skip.
  - Scenario A–L re-checked: A still HIGH when the link is recent; B anchored shipping still
    beats (now genuinely) aligned learning, learning kept as alternative; C shipping-without-
    project stays a signal, an actively tracked learning plan is recommended; D no-target but
    actively tracked → MEDIUM candidate; E empty → abstain; F/G/H workout/meal never
    recommend; I focus-zero context only; J tombstone/revision — tombstoned completion can't
    create alignment (candidate is MEDIUM via a separate live completion); K dedupe unchanged;
    L capability tier-3 still beats non-aligned tracked learning (MEDIUM alternative).
  - `npm run test:adapter-contracts`: PASS (33 / 45 / 10 / 12 / 12 / 20).
  - `npm run lint`: 0 errors, 19 pre-existing warnings, exit 0.
  - Playwright: `cross-domain-intelligence-ui` 13/13; full suite 208/208, 0 failures.
  - strict `npm run test:cross-repo-compat`: 3/3 legs PASS (ChronaSense / Meal / Workout), no
    skips, exit 0.
  - `node --check` clean; `git diff --check` clean; control-byte / UTF-8 scan: 0 control bytes,
    all UTF-8 valid.
untested: unchanged from the first-pass entry — no deployment, mobile install, Firebase, Obsidian,
  background automation, or real end-user data. Pre-integration `origin/main` re-fetch +
  new-commit inspection still owed. STOPPED for targeted independent re-review; not pushed,
  not merged, not integrated.

## Phase 8 — Cross-Domain Intelligence / Highest-Leverage Next Action V1 — first-pass build · 2026-09-01
branch: `feat/cross-domain-intelligence-v1` (base `4857dc4d2a63c4aac4660edf8940f63c6e7f6d16`,
  == origin/main after fetch at phase start). Isolated git worktree; original `main` untouched.
suite: `npm test`; `npm run test:adapter-contracts`; `npm run lint`; strict
  `npm run test:cross-repo-compat` with `MEAL_REPO_PATH` / `OPENGYM_REPO_PATH` set; Playwright
  `smoke`, `learning-plan-ui`, `capability-career-ui`, `plan`, `life-feed-ui`,
  `life-character-sheet-ui`, and the new `cross-domain-intelligence-ui`; `node --check` on every
  new / changed `.js`; `git diff --check`; a control-byte / UTF-8 scan over every changed file.
result:
  - `npm test`: PASS. 661 model/unit tests — `test.js` 448/448; node:test suites
    workout-adapter 33, meal-adapter 45, meal-cross-repo 10, temporal-regression 20,
    life-feed-model 36, life-character-sheet-model 34 (+2 new: exposed learning ids),
    cross-domain-intelligence-model 35 (new). 0 failures, 0 skips.
  - Scenario matrix A–L: all pass. A concrete aligned learning candidate (HIGH); B a
    concrete shipping/portfolio project beats more learning, learning kept as an alternative;
    C a bare shipping stall with no project stays an attention signal and learning is
    recommended (no task invented); D no target -> learning candidate at MEDIUM; E empty
    profile -> abstain; F/G/H workout & meal never evaluated / never "you haven't ..."; I no
    focus today -> no productivity verdict; J tombstoned completion cannot create alignment;
    K duplicate candidates collapse by stable id; L deterministic tier + strength ordering.
  - Parity: `intelligence.capability.{dimensionTotals,target,nextActionKind,stalls}` equals a
    fresh `analyzeCapabilityCareer()` with the Character Sheet's own args; the recommended
    learning step is exactly `characterSheet.learning.activePlan.nextStep` (no independent
    traversal); explanation step counts equal the sheet exactly (never "5 of 10").
  - `npm run test:adapter-contracts`: PASS (workout 33, meal 45, meal-cross-repo 10, workout
    source-gate 12, meal source-gate 12, temporal 20).
  - strict `npm run test:cross-repo-compat`: PASS — all 3 legs executed and passed
    (ChronaSense adapter-contract gate, Meal source-contract gate, Workout source-contract
    gate — 29 vitest tests). No skips, exit 0.
  - `npm run lint`: 0 errors, 19 pre-existing warnings (all in index.html-extracted scripts,
    none in the two new modules).
  - Playwright: `cross-domain-intelligence-ui` 12/12, `life-character-sheet-ui` 10/10,
    `life-feed-ui` 9/9, `capability-career-ui` 8/8, `learning-plan-ui` 77/77, `plan` 27/27,
    `smoke` 64/64. Total 207/207, 0 failures.
  - `node --check` clean on all new / changed files; `git diff --check` clean (autocrlf=true,
    repo normalises to LF); control-byte / UTF-8 scan: 0 control bytes, all UTF-8 valid.
untested: no production deployment, no mobile install, no Firebase / shared-storage path, no
  Obsidian export or vault write (Phase 8 does not touch Obsidian — Phase 9), no background
  automation (Phase 10), no real end-user data. The OUTBOX main-automation race is only
  mitigated by worktree isolation so far — a fresh `origin/main` fetch + new-commit inspection
  is still required before integration. STOPPED at the independent-review checkpoint; not
  pushed, not merged, not deployed.

## Workout → Life Ledger Adapter V1 — third targeted fix pass · 2026-08-31
suite: `npm run test:workout-adapter`; `npm test`; `npx playwright test`; ESLint over the repository's
  configured production modules; `node --check` on the adapter, adapter tests, core, runtime,
  transport, renderer, CLI export script, and `test.js`; `git diff --check`; a control-byte/UTF-8
  round-trip scan over every changed file.
result: focused adapter tests passed 33/33 (3 new: a real verified FNV-1a 32-bit fingerprint collision
  between two distinct `note` values still produces `immutable_workout_conflict` — proven with the
  original event's `eventId`/revision/note unchanged, no duplicate event created, and the top-level
  `status` correctly `partial`, plus a sanity check that the collision genuinely occurs and a
  companion test proving true identical-facts retries still resolve to `unchanged`). Full Node
  regression passed 471/471 (438 ChronaSense/core/export tests, including 9 new time/interval cases
  added to the `workout_completed core/renderer validator parity matrix`, + 33 adapter tests). Full
  Playwright passed 176/176. ESLint completed with 0 errors and the same 19 pre-existing warnings
  outside the adapter/core/renderer. Syntax checks, `git diff --check`, and the control-byte scan all
  passed clean.
  Independently confirmed by direct script proof that the renderer now rejects every one of the
  reviewer's five reproduced time/interval cases (missing `endedAt`, missing `startedAt`,
  `durationMinutes: 0`, end earlier than start, `endedAt` disagreeing with top-level `occurredAt`)
  identically to the shared core, while the approved unknown-duration case (`startedAt === endedAt`,
  `durationMinutes` omitted) still renders correctly. Also independently confirmed, end to end through
  `importWorkoutBackup()`, that a genuine fingerprint collision (two distinct notes both hashing to
  `fnv1a32:9ce28ae5`) no longer causes a changed workout to be silently accepted as unchanged.
  Re-confirmed unchanged: `_ts` never orders corrections, restored backups cannot roll history
  backward, future `_ts` cannot freeze ingestion, kg/lb toggles never relabel history, `observedAt`
  comes only from the injected clock, unknown-duration history omits rather than fabricates duration,
  a missing later record never tombstones, a forged `iw`-prefixed record remains path-compatible
  provenance only, one outcome per physical record holds (including the fatal-context case), fatal
  context rejection remains `rejected`, the malformed-payload allowlists remain strict, valid mixed
  Obsidian export remains deterministic, and core validation remains scoped to `workout_completed`.
untested: unchanged from the entries below — no production deployment, mobile install, Firebase/
  shared storage, Obsidian export/write, Meal app, openGym source mutation, or real user backup
  import was exercised in this fix pass either.

## Workout → Life Ledger Adapter V1 — second targeted fix pass · 2026-08-31
suite: `npm run test:workout-adapter`; `npm test`; `npx playwright test`; ESLint over the repository's
  configured production modules; `node --check` on the adapter, adapter tests, core, runtime,
  transport, renderer, CLI export script, and `test.js`; `git diff --check`; a control-byte/UTF-8
  round-trip scan over every changed file.
result: focused adapter tests passed 30/30 (3 new: fatal batch/context rejection returning one
  `invalid` outcome per physical record for a 3-record batch, zero outcomes for a 0-record batch, and
  zero outcomes for a structurally-malformed backup). Full Node regression passed 468/468 (438
  ChronaSense/core/export tests, including the new `workout_completed core/renderer validator parity
  matrix` test covering 15 fixtures, + 30 adapter tests). Full Playwright passed 176/176. ESLint
  completed with 0 errors and the same 19 pre-existing warnings outside the adapter/core/renderer.
  Syntax checks, `git diff --check`, and the control-byte scan all passed clean.
  Confirmed by direct script proof (not just the test files) that every reviewer-reproduced case is
  now rejected identically by both `validateLifeLedgerEvent()` and `buildObsidianLifeLedgerExport()`:
  `program: {bad:true}`, a top-level `sets: "bad"`, an unknown `payload.source` key, an extra key
  inside `timezoneContext`, a contradictory `{ authority: 'unknown', unit: 'lb' }` weightUnitContext,
  an invalid `weightUnitContext.authority` enum, an overclaiming `recordOrigin`, an overclaiming
  `completionBasis`, a missing `exerciseId`, a missing `mode` paired with an invalid set, an empty
  `sets` array, an out-of-range `rir`, an invalid `prescription`, and a `bodyWeight` with an extra
  field. Also re-confirmed unchanged: higher/future/newly-restamped `_ts` cannot revise or freeze
  accepted facts, kg/lb toggles never relabel historical loads, observation time comes only from the
  injected clock, unknown-duration history is represented without fabrication, backup absence never
  implies deletion, and a forged `iw`-prefixed record is labeled shape-compatible only.
untested: unchanged from the entries below — no production deployment, mobile install, Firebase/
  shared storage, Obsidian export/write, Meal app, openGym source mutation, or real user backup
  import was exercised in this fix pass either.

## Workout → Life Ledger Adapter V1 · 2026-08-31
suite: `npm run test:workout-adapter`; `npm test`; `npx playwright test`; ESLint over the repository's
  configured production modules; `node --check` on the adapter, adapter tests, core, runtime,
  renderer, and `test.js`; `git diff --check`; source-path inspection of openGym persist, finish,
  rating/note, CSV import, backup replacement/export, deletion, reset, server pull, and native mirror.
result: focused adapter tests passed 20/20. Full Node regression passed 447/447 (427 existing/core/
  export + 20 adapter). Full Playwright passed 176/176. ESLint completed with 0 errors and the same
  19 pre-existing warnings in `focus-mode.js`, `insights.js`, and `storage.js`; changed production
  files had no warnings. Syntax checks and `git diff --check` passed. Adversarial proofs confirmed
  higher/future/newly-restamped global `_ts` cannot revise or freeze facts, unit toggles cannot relabel
  loads, observation time comes from the injected clock, unknown duration omits rather than fabricates
  duration, partial batches remain explicit/retryable, and mixed focus/plan/workout export succeeds.
  ESLint first hit sandbox `ENOTCACHED` and passed after the required approved registry retry.
untested: no production deployment, mobile install, Firebase/shared storage, Obsidian export/write,
  Meal app, openGym source mutation, or real user backup import was exercised. Deletion and restore
  remain intentionally unsupported until openGym emits explicit durable evidence. Backup-only record
  origin remains indeterminate when arbitrary/restored data matches a valid source shape.

## Workout → Life Ledger Adapter V1 — final consolidated fix pass · 2026-08-31
suite: `npm run test:workout-adapter`; `npm test`; `npx playwright test`; ESLint over the repository's
  configured production modules; `node --check` on the adapter, adapter tests, core, runtime,
  transport, renderer, CLI export script, and `test.js`; `git diff --check`.
result: focused adapter tests passed 27/27 (7 new: duplicate/conflict per-record outcomes with
  reversed order, forced ledger-upsert-rejection status, forged `iw`-prefixed record, oversized/
  control-character text and identifier rejection). Full Node regression passed 464/464 (437
  ChronaSense/core/export tests, including 10 new adversarial validation/renderer tests, + 27 adapter
  tests). Full Playwright passed 176/176. ESLint completed with 0 errors and the same 19 pre-existing
  warnings in `focus-mode.js`, `insights.js`, and `storage.js`; changed production files (adapter,
  core, renderer) had no warnings. Syntax checks and `git diff --check` passed.
  Reviewer-reproduced malformed payloads (null payload, object `workoutName`, string `exercises`,
  string `bodyWeight`, numeric `rating`, object `note`) are now confirmed rejected by both
  `validateLifeLedgerEvent()` (shared core) and `buildObsidianLifeLedgerExport()` (renderer) directly,
  independent of the adapter. Two identical physical backup rows now produce an explicit `accepted` +
  `duplicate` outcome pair (order-independent) instead of a silent collapse. A forced non-UUID
  `createId` reproduces a rejected ledger upsert whose top-level `importWorkoutBackup()` `status` is
  confirmed `partial`, never `ok`, and a retry with a valid `createId` is confirmed idempotent. A
  forged `iw`-prefixed record is confirmed labeled `csv_import_path_compatible` /
  `validated-supplied-backup-record`, never the old overclaiming `csv_imported_history` label.
untested: unchanged from the entry above — no production deployment, mobile install, Firebase/shared
  storage, Obsidian export/write, Meal app, openGym source mutation, or real user backup import was
  exercised in this fix pass either.

## Capability/Career V1 reviewer fix packet · 2026-08-31
suite: `npm test`; `npx playwright test tests/capability-career-ui.spec.js`;
  `npx playwright test tests/learning-plan-ui.spec.js`; `npm run test:smoke`; `npm run lint`;
  `node --check capability-career-model.js capability-career-repository.js
  capability-career-import.js capability-career-analytics.js capability-career-ui.js test.js
  tests/capability-career-ui.spec.js`; `git diff --check`; targeted `rg` boundary checks over the
  Career runtime modules for Firebase/sync, Obsidian/file writes, fetch/XHR, Meal/Workout coupling,
  Life Ledger write APIs, title/keyword inference, random IDs, hidden Date.now, and raw code eval.
result: `npm test` passed 424/424. Career Playwright spec passed 8/8. Learning Plan UI regression
  spec passed 77/77. Full smoke passed 176/176 after the final code change. Lint completed with 0
  errors and the same 19 pre-existing warnings in `focus-mode.js`, `insights.js`, and `storage.js`;
  no Career file warnings. Syntax checks passed. `git diff --check` reported no whitespace errors,
  only the repository's existing LF/CRLF normalization warnings. Boundary checks found no forbidden
  integration calls in the Career runtime modules. `npm run lint` first hit sandbox `ENOTCACHED` and
  was rerun with approved escalation. `npm run test:smoke` first hit sandbox EPERM creating
  Playwright artifacts and was rerun with approved escalation.
untested: no production deploy, mobile device install, Firebase sync, Obsidian write/export, external
  service, or real user data flow was exercised; those remain intentionally outside this local-only
  reviewer fix packet.

## Capability/Career V1 · 2026-08-31
suite: `npm test`; `npm run lint`; `npx playwright test tests/capability-career-ui.spec.js`;
  `npx playwright test tests/learning-plan-ui.spec.js`; `npm run test:smoke`;
  `node --check capability-career-model.js capability-career-repository.js
  capability-career-import.js capability-career-analytics.js capability-career-ui.js`;
  `git diff --check`; targeted `rg` boundary checks over the new Career modules for Firebase,
  Obsidian/file writes, fetch/XHR, Meal/Workout coupling, and Life Ledger write APIs.
result: `npm test` passed 412/412. Career Playwright spec passed 7/7. Learning Plan UI regression
  spec passed 77/77. Smoke suite passed 175/175. Lint completed with 0 errors and 19 pre-existing
  warnings outside the new Career files. New Career JS modules passed syntax checks. `git diff
  --check` reported no whitespace errors, only the repository's existing LF/CRLF normalization
  warnings for touched files. Boundary checks found no Firebase calls, no Obsidian/file writes, no
  fetch/XHR, no Meal/Workout coupling, and no Life Ledger write API usage in the new Career modules.
  `npm run lint` initially hit an npm cache/network `ENOTCACHED` condition inside the sandbox and
  was rerun with approved escalation. `npm run test:smoke` initially hit a sandbox EPERM creating
  Playwright artifacts and was rerun with approved escalation.
untested: no production deploy, mobile device install, Firebase sync flow, or Obsidian integration
  was exercised; those are intentionally outside this local-only Capability/Career V1 milestone.

## TASK-003 · 2026-07-21
suite: [System.Management.Automation.Language.Parser]::ParseFile on tools/Run-Codex-Build.ps1 and
  tools/Run-Claude-Review.ps1; direct diff against Meal Prep's pre-port versions of both files;
  fixture harness against `Get-TaskBlockText`/`Get-TaskDeclaredFiles` re-run against this app's own
  copy of the ported functions (extracted via brace-matching)
result: both files parse clean. Direct diff confirmed both files were functionally identical to
  Meal Prep's pre-fix versions before porting (Run-Claude-Review.ps1 byte-identical;
  Run-Codex-Build.ps1 differed only in two comment lines referencing the other app's name/path,
  no logic differences). Fixture harness: 8/8 assertions pass -- single-line files field,
  multi-line continuation with `(new)` annotations stripped, missing field returns `@()`, correct
  isolation of one task among several with no bleed into neighbors, unknown task ID handled
  without crash, out-of-scope diff logic correct for both an in-scope build and one with an extra
  undeclared file. The note read/match/consume logic (task-ID matching, stale-note rejection,
  always-delete-after-read) was not re-derived separately here -- it's character-for-character
  identical to Meal Prep's already-tested version (6/6 assertions there), confirmed via the same
  direct diff rather than re-running a duplicate fixture for no new signal.
untested: no live end-to-end run in either app -- reproducing a real build that touches a file its
  task never declared, and confirming the note actually reaches a real REVIEW.md entry, isn't
  safely reproducible without running the real headless build/review pipeline against a live
  branch. Honestly disclosed as unverified-live here rather than claimed.

## TASK-002 · 2026-07-21
suite: [System.Management.Automation.Language.Parser]::ParseFile on tools/Generate-Digest.ps1 and
  tools/Dispatch-Commands.ps1; tools/Generate-Digest.ps1 executed against the real, live-failing
  planning/PROPOSALS.md (12 pending proposals) with -OutFile pointed at a scratch file; isolated
  fixture harness against the stale-lock decision logic (same branching as the real fix, run against
  constructed lock files with real Get-Process checks, not mocked)
result: both files parse clean, no syntax errors. Digest run against real data: output 3911 chars
  (Telegram's limit is 4096) -- all 5 RECOMMEND APPROVE items and both RECOMMEND PARK items kept in
  full, only 1 of 5 RECOMMEND REJECT items shown before the safe-length threshold was reached,
  followed by a "+4 more waiting ... see planning/PROPOSALS.md" note. Stale-lock logic: 4/4 cases
  pass -- a lock file whose recorded PID is not currently running clears immediately regardless of
  timestamp age; a lock with a live PID and a fresh timestamp stays busy; a lock with a live PID and
  a 46-minute-old timestamp clears; a lock with a live PID and a 44-minute-old timestamp (2 minutes
  under the new 45-min threshold) stays busy, confirming no false-positive right at the boundary.
untested: full live end-to-end verification -- a real Telegram send of the truncated digest, and a
  real hung process actually getting auto-cleared with its Telegram notice actually arriving -- was
  not attempted beyond the isolated checks above.

## TASK-001 · 2026-07-20
suite: [System.Management.Automation.Language.Parser]::ParseFile on tools/Run-Codex-Build.ps1 and
  tools/Dispatch-Commands.ps1; isolated fixture harness against Resolve-ReviewOutcome (extracted from
  THIS repo's own copy of the file, along with its real Split-TaskBlock/Set-TaskStatus/
  Set-TaskBlockedAuto dependencies, Publish-TasksChange stubbed to a no-op so the test never touches
  git)
result: both files parse clean, no syntax errors. Resolve-ReviewOutcome: 9/9 assertions pass across 5
  cases -- a real auto-merge message sets status: done with NeedsHuman false; an "APPROVED but HELD"
  red-zone message correctly sets status: approved (NOT done) rather than false-positive-matching the
  literal word APPROVED; a REWORK message increments an existing strike 1/3 note to 2/3; a
  crashed-review-engine message ("Left at status: review for automatic retry") sets status: review
  with no strike; a "build NO-OP" message sets status: blocked with strike 1/3 recorded.
untested: full live end-to-end verification -- a real crashed claude/codex review process, and a real
  no-op rework retry -- was not attempted; not safely reproducible without spawning real codex/claude
  CLI processes against a live git branch. This is the first task run through this project's own
  TASKS.md/REVIEW.md/CHANGELOG.md/TEST_REPORT.md loop (ported directly from the Meal Prep app, which
  hit and fixed this bug live first).

<!-- Entries go here, newest first. -->

## Date-scoped ChronaSense Life Ledger read V1 · 2026-09-07

status: ready for independent review; uncommitted.
base / fetched origin/main: `059a5ce204a12ff1c425e635f491b677fd706f5c`.
worktree: `C:\Users\Admin\Desktop\Vibe code\Time audit app - date-scoped-ledger-export`.
branch: `feat/date-scoped-life-ledger-export-v1`.
execution contract: explicit user slice request; no unrelated TASKS status changed.

Implementation and safety:
- `readChronaSenseLifeLedgerForDate()` validates the query, calls the supplied existing
  `storage.js:getEntriesForDate()`, then delegates directly to `normalizeChronaSenseEntries()`.
- Real source-read semantics tested: effective configured/device timezone; `tsStart || ts`
  local date; deleted rows excluded; stale stored date ignored. Source intervals and end
  occurrence instants are not rewritten or clipped.
- Existing `{ drafts, rejected }` output, draft validator, identity, canonical factual
  serialization, fingerprints, and dedup semantics are unchanged. This is not a persistent
  snapshot: no event IDs/revisions are minted, and transport/UI remain unchanged.
- Frozen source records and storage snapshots remain unchanged. Tests load the real
  storage reader, arm localStorage/network/UUID traps after its normal startup, and prove
  no read-time calls. A separate global-access trap covers the exported API itself.
- No changes to source storage code, core, transport, Meal, Workout, Phase 5C contracts,
  Firebase, or real Obsidian. No merge, push, commit, or deployment.
- Self-review: additive 15-line read wrapper; no duplicated selection/normalization logic,
  schema, identity, persistence, UI, or unnecessary abstraction. Existing hard-rule runtime
  functions remain byte-unchanged. Applicable code-health and data-integrity checks pass.

Verification:
- `node --test chronasense-life-ledger-date.test.js`: 15 passed, 0 failed/skipped.
- `npm test`: 948 total; 947 passed, 0 failed, 1 skipped.
  Includes legacy `test.js`: 444 passed (ChronaSense adapter, Life Ledger core,
  runtime/transport/export, and existing shared-stack checks).
- The single default skip is `scripts/cross-repo-compat-check.test.js`'s opt-in
  raw-lower-case-drive versus canonicalized-cwd control proof. It requires
  `CROSS_REPO_COMPAT_CONTROL_PROOF=1` and runs against a real openGym checkout;
  it was not enabled for this bounded change. No mandatory suite was omitted.
- `npm run test:adapter-contracts`: Workout adapter 33, Meal adapter 45,
  Meal cross-repo fixture replay 11, Workout source gate 12, Meal source gate 12,
  temporal regression 20; all 133 passed, no failures/skips.
  Meal fixture resolved read-only from the existing sibling repo.
- `npm run test:smoke`: 217 passed, 0 failed (Chromium, isolated app fixtures).
- `npm run lint`: exit 0, 0 errors, 19 warnings in unchanged
  `focus-mode.js`, `insights.js`, and `storage.js`; no new adapter warnings.
- `node --check`: adapter and new test file passed.
- `npm run check:www-parity`: passed, 32-file runtime closure. The adapter is not
  loaded by the runtime entrypoint, so no mirror changes are necessary.
- `git diff --check` and strict UTF-8/control-character scan of all six changed/new
  files passed.
- Initial sandbox Node test invocation could not spawn (EPERM); rerun outside the sandbox
  passed. Initial offline dependency install hit the existing Capacitor 8 / Google Auth
  Capacitor 6 peer conflict; `npm ci --ignore-scripts --offline --legacy-peer-deps`
  succeeded without changing the manifest dependencies or lockfile.
- Ignored evidence logs: `date-export-npm-test.log`, `date-export-contracts.log`,
  `date-export-smoke.log`, `date-export-lint.log`.

Date and determinism evidence:
- Normal day, empty date, before/exact/after midnight: passed.
- Asia/Tokyo (+09:00), America/Phoenix (-07:00): passed.
- America/New_York spring-forward (2026-03-08) and repeated fall-back hour
  (2026-11-01): passed; distinct instants preserved and next local day excluded.
- Missing start selects by end even when inferred duration starts on the previous day.
- Source IDs preserved; same source/context serializes identically; permuted valid source
  rows produce identical output; changed observation time preserves canonical facts and
  fingerprints. Selected malformed and duplicate rows exactly match the legacy adapter.
- Caller must supply the existing synchronous read-only date reader and its matching
  effective timezone. Explicit fixed observation context is required for replayable draft
  bytes; a changing clock changes operational provenance. Rejection indexes retain selected
  input order. Source-reader failures propagate rather than inventing a recovery policy.
- No new UI was requested or added; no real-device checks apply to this API-only slice.

Independent-review priorities:
1. Confirm the existing start-or-end date ownership (including cross-midnight and deleted
   rows) is the intended source-selection boundary.
2. Confirm existing draft output is the correct read-only boundary; stored transport requires
   durable Ledger-owned fields and is intentionally not used.
3. Review caller obligations for timezone/observation context and the distinction between
   canonical fact determinism and operational provenance/rejection indexes.

## Date-scoped ChronaSense export V1 — bounded review fixes · 2026-09-07

status: ready for targeted re-review; uncommitted. This entry supersedes the pre-review
implementation/context statements and counts in the preceding date-scoped export report.
worktree: `C:\Users\Admin\Desktop\Vibe code\Time audit app - date-scoped-ledger-export`.
branch: `feat/date-scoped-life-ledger-export-v1`.
HEAD and local origin/main verified unchanged at `059a5ce204a12ff1c425e635f491b677fd706f5c`.

Bounded fixes:
- The wrapper reuses `isIanaTimezone()` to validate required sourceTimezone before reading,
  independent of row count. Missing/invalid values throw RangeError, with no implicit fallback.
- The same explicit sourceTimezone is passed to `getEntriesForDate(date, { sourceTimezone })`
  and unchanged normalization. The storage reader accepts this optional override; legacy
  one-argument calls retain configured/device timezone behavior. Required www mirror updated.
- CODEMAP distinguishes whole source-record ownership, UI day clipping, and physical source
  splits. Export never clips/splits records or changes canonical occurrence timestamps.
- Injected readers remain trusted synchronous read-only callbacks that must honor the second
  argument. The API does not inspect arbitrary callback implementations. UTC aliases remain
  unsupported by the unchanged normalizer predicate; use a supported name such as Etc/UTC.

Regression-first evidence:
- Before production changes, the expanded date suite had 16 passes and 5 expected failures:
  exact Tokyo/Phoenix mismatch plus empty/populated missing/invalid timezone cases.
- After the fix, `node chronasense-life-ledger-date.test.js`: 21 passed, no failures/skips.
- Exact original bug separately reproduced during self-review using the real Tokyo-configured
  storage reader and a Sept 7 00:05 Tokyo record: Phoenix export Sept 6 includes the record;
  Phoenix Sept 7 is empty. Draft sourceTimezone is Phoenix and original UTC instants survive.
- Missing/invalid timezone on empty/populated days throws before reader invocation (zero calls).
  Valid timezone plus empty date still returns the legitimate empty result.
- Positive/negative offsets, midnight boundaries, spring-forward/fall-back, deleted/stale-date
  records, and missing-start fallback pass. Unsplit 23:55–00:10 stays wholly on day 1;
  physical 23:55–00:00 and 00:00–00:10 records land on day 1 and day 2 respectively.
- Replaced the device-fallback equality test with successful explicit-timezone draft validation
  while storage settings have no configured timezone.
- Deep-frozen source and store snapshots plus localStorage/Firebase/network/UUID traps pass.
  No source mutation, durable ID/revision minting, or persistent Ledger access during export.
- Fixed-context replay and changed-observation canonical facts/fingerprints remain stable.

Full checks on the fixed implementation:
- `npm test`: 954 total, 953 passed, 0 failed, 1 existing opt-in skip. Includes 444 legacy
  checks covering ChronaSense adapter and Life Ledger core/runtime/transport, plus 21 date tests.
- Existing skip: cross-repo control proof requiring CROSS_REPO_COMPAT_CONTROL_PROOF=1.
- `npm run test:adapter-contracts`: 133 passed (Workout 33, Meal 45, Meal cross-repo 11,
  Workout gate 12, Meal gate 12, temporal 20), no failures/skips.
- Playwright with output redirected to a temporary directory: 217 passed, no failures.
- `npm run lint`: 0 errors, 19 pre-existing warnings at unchanged code locations.
- `node --check`: storage, www/storage, adapter, and date test passed.
- `npm run check:www-parity`: passed, 32-file closure; storage mirror byte-identical.
- `git diff --check` and strict UTF-8/control-byte scan: passed on all eight changed/new files.
- Existing adapter prefix matches HEAD: no existing normalizer implementation changed.
  An initial Node-based comparison could not spawn git under sandbox (EPERM); the equivalent
  direct Git pipeline comparison succeeded. Full npm and browser suites used approved
  child-process execution; no required test suite was skipped.

Scope and safety:
- Seven files edited for this repair: adapter, date tests, storage, www/storage, CODEMAP,
  CHANGELOG, TEST_REPORT. package.json retains only the original date-test script addition.
- No Meal, Workout/openGym, core/transport, Phase 5C machinery, or original checkout edits.
- No commit, staging, push, merge, deployment, Firebase write, or real Obsidian write.
- Remaining blocker: none found. Ready for targeted independent re-review.

## Phase 6 — Daily Operating Loop V1 · original implementation evidence (superseded by review fixes below)

Execution contract: user's explicit Phase 6 brief. Review candidate on
`feat/daily-operating-loop-v1`, based on freshly fetched and finally re-fetched
`origin/main` = `c1d9a96b22abbcefb17736f112d756e477ef8700`.

- Full `npm test`: **973 passed, 0 failed**, including existing Focus/Learning,
  Life Ledger, Workout, Meal/cross-repo fixture, temporal/date-scoped export,
  background-sync and runtime-mirror regressions. Log: `phase6-npm-test-final.log`.
- Pre-review Playwright run: **228 passed, 0 failed** (`phase6-playwright-final.log`).
  After the small initial Focus countdown fix, the affected Focus/Learning/routine
  suites were re-run: **159 passed** (`phase6-focus-regression.log`).
  Final launch-error and exact-plan-link hardening: focused Node **19 passed**,
  final routine browser suite **12 passed** (`phase6-focused-final.log`).
- ESLint: **0 errors, 19 pre-existing warnings** in Focus/storage/insights.
  New scheduler modules: no warnings. `phase6-lint-final.log`.
- `node --check`: changed JS and both actual inline scripts pass. Initial regex
  extraction incorrectly included a commented script marker; the HTML-parser
  extraction correctly checks real script elements and passes.
- Runtime parity: all **36 files** in the loaded dependency closure match `www/`.
- `git diff --check`, strict UTF-8 decode/control-byte scan: pass.
- Browser viewport checks: 390×844 and 844×390, no horizontal overflow; 16px
  inputs; compact, scrollable active Focus overlay. Screenshots inspected under
  `test-results/daily-routines-landscape.png` and
  `test-results/daily-routines-active-focus-landscape.png`.
- Chaos cases 1–10: pass across focused model/browser checks; source ambiguity
  was covered under the original policy. The unsafe completion-derived Learning
  binding and weak Workout policy are superseded by the review fixes below.
- Local dependency install required `npm ci --ignore-scripts --offline
  --legacy-peer-deps` due to the existing Capacitor 8 / google-auth peer conflict.
  No package versions or lockfile changes. No production credentials needed.

Self-review: scoped modules and small Focus hooks, no new timer/Plan/factual
schema, no source mutations, escaped UI text, fail-visible storage, stable IDs,
no sample-data writes, unchanged timer heartbeat/device guard/timeline rules.
Fixed own test fixture/selector issues and verified actual adapter/runtime events.
No task was silently skipped; legacy TASKS.md has no Phase 6 entry and was not
repurposed. No production/native release was attempted. Physical iOS/Android
usability is pending human review; no new strict live-sibling compatibility gate
was claimed (the requested adapter/full regression suites use existing fixtures).

Safety: protected Workout adapter checkout remains clean at `eed35fec8492bfed72225522771a0bdc14dbcadc`;
protected stabilization checkout remains clean at `4b3ac04`. No Meal/openGym source,
production Firebase, real Obsidian, main merge/push, or deployment writes.
See `docs/DAILY_OPERATING_LOOP_V1.md` for semantics, limitations, friction and
highest-risk independent-review targets.


## Phase 6 — independent-review bounded fixes · 2026-09-07

Status: ready for targeted re-review after the FIX FIRST findings. Original feature
commit `51173dc38f263be64db3bc63ee15c50f02f2118e` retained. Fetched main is unchanged
at `c1d9a96b22abbcefb17736f112d756e477ef8700`; no rebase/reconciliation.

Findings reproduced with failing regressions before implementation, then fixed:

- Workout requires explicit `workoutRoutineId == payload.source.routineId`, an
  enabled occurring routine, exactly one distinct Ledger event and exactly one
  eligible linked routine. Duplicate event IDs collapse. No same-day uniqueness,
  longest-duration, nearest-time, or title heuristic. Preserved source local date
  and start date in the scheduler timezone must agree with the instance date;
  date disagreement abstains without changing source facts. Overnight Sept 8 ->
  Sept 9 cannot satisfy Sept 9 evening. Disabled/non-occurring routines do not
  create ambiguity. A pre-existing Manual assertion remains one completion when
  factual evidence later arrives; ambiguous evidence cannot replace it.
- Learning binds only the existing Next Step. Out-of-order completed B cannot
  replace unfinished A before materialization. A remains pinned after completion,
  Next Step advancement, B completion, reopening/tombstone, and reload. Historical
  unbound dates cannot borrow same-plan facts. No next step means no new binding.
- Calendar streak first gates every completion lookup on current occurrence;
  disabled or non-scheduled today returns zero. Weekend gaps and cadence edits
  break streaks even with retained manual assertions or Focus receipts. Minimum
  and Manual completion count only on scheduled occurrences; no revision history.

Validation:

- Targeted final scheduler/domain suite: **29 passed, 0 failed**
  (`phase6-review-domain-final.log`). Browser routine suite: **14 passed**
  (`phase6-review-targeted.log`).
- Current full Playwright discovery/run: **231/231 passed**, not the stale 228
  (`phase6-review-playwright.log`). The reviewed branch had 229 cases; two added
  Learning browser regressions raise the current count to 231.
- Final full `npm test`: **983 passed, 0 failed**
  (`phase6-review-npm-final.log`), covering Focus/Learning/Ledger/date export,
  Workout/Meal adapters, temporal and remaining existing regressions.
- Workout source gate: **12/12 passed**, zero skipped.
  Meal source gate: **12/12 passed**, zero skipped. These are the existing
  adapter-side captured-source fixture gates, not production source mutations.
- ESLint: **0 errors, 19 existing warnings**; changed modules have no warnings.
- Changed JS and both real inline scripts pass `node --check`; strict UTF-8 and
  control-byte scan, `git diff --check`, and all **36** runtime mirror files pass.

Self-chaos: all five reproduced cases now fail closed or retain the correct
intention/streak: overnight workout; unrelated morning workout; two same-day
workouts; B completed before A binding; cadence edit removing a completed date.

Friction: normally **2 tracking-only Done taps/day** when Workout needs Manual
completion (Workout + unsupported habit), or **1** with strong Workout linkage,
unique factual delivery, and agreeing dates. Manual uses the existing Completion
option; no new assertion model. No live ingestion claim.

Scope: scheduler matching/binding/streak logic, corrective user copy, adversarial
tests, exact runtime mirrors, and corrected existing documentation only. Focus,
manual persistence, IDs, schedule modes, timezone, and Phase 5 machinery unchanged.
Protected adapter/stabilization worktrees remain clean. No push/merge/deploy,
Firebase writes, real Obsidian writes, or Meal/openGym modifications. Real-device
checks and the previously documented V1 limitations remain deferred.
