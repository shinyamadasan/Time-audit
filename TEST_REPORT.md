# Test Report

> **Codex writes; Claude reads.** Append-only. One entry per task run.
> Tests: `npm test` (node test.js) and Playwright. Manual: `SMOKETEST.md`.

---

## Phase 6I/J — Day-to-day UX correction pass (same candidate) · 2026-09-10
branch: `feat/review-reconciliation-v1`. Base still `2948e2e2e591e18d7f40bade92c531338b77885a`
  (re-verified: `git rev-parse origin/main` and `HEAD` both unchanged, nothing committed).
scope: REMOVE / HIDE / QUIETEN pass on the 6I/J candidate. Reconciliation prompt retoned
  (neutral surface, one primary exit, demoted "Log time" link) and its acknowledged state
  reduced to one quiet line; `#th-unlogged` Today debt stat removed; generic ROUTINE_PROMPTS
  meal/chore check-ins removed; Close Day "name the leak" copy neutralised; "Reflect" nav tab
  → "Trends". No new persistence, no new daily action, architecture unchanged. Touched:
  `index.html`, `style.css` (+ `www/` mirror), `tests/review-reconciliation.spec.js`,
  `tests/smoke.spec.js`, `tests/review-simplification.spec.js`, docs.
suite: focused specs; `npm test`; `npm run lint`; `npx playwright test` (full);
  `node scripts/runtime-mirror.mjs --check`; `node --check` on touched specs; `git diff --check`.
result:
  - focused: `tests/review-reconciliation.spec.js` 24/24; `tests/review-simplification.spec.js`
    36/36; combined `smoke + today-simplification + plan + coarse-life-evidence + review-
    reconciliation` run 143/143.
  - `npm test`: PASS (full node chain, exit 0, reached `runtime-mirror.test.js`).
  - `npm run lint`: PASS — 0 errors, 29 pre-existing warnings (unchanged; `index.html`/tests
    not in the lint set).
  - `npx playwright test` (full): see landing report AE — all pass after the test updates.
  - `node scripts/runtime-mirror.mjs --check`: OK — www/ byte-identical (`--write` updated
    `index.html` + `style.css`).
  - `node --check` touched specs: PASS. `git diff --check`: clean.
state: candidate still uncommitted / unpushed for one independent milestone review.

## Phase 6I/J — Review reconciliation + Today gap replacement V1 (candidate) · 2026-09-10
branch: `feat/review-reconciliation-v1`. Base `2948e2e2e591e18d7f40bade92c531338b77885a`
  (origin/main, verified via `git rev-parse origin/main` after `git fetch origin --prune`).
  Isolated worktree; primary worktree (dirty `README.md`) untouched; Meal/Workout untouched.
scope: reworked Review's unlogged-decision block into an always-available (until acknowledged)
  optional "Anything important missing?" reconciliation prompt with Add broad activity /
  Log time / Leave unknown / Looks about right; then removed the generic Today "first gap
  >= 30m → Needs You / fill gap" interruption. `computeGaps()` and every raw-gap diagnostic
  preserved. Touched: `index.html` (+ `www/` mirror), `tests/smoke.spec.js`,
  `tests/today-simplification.spec.js`, `tests/plan.spec.js`; new
  `tests/review-reconciliation.spec.js`; docs (`CHANGELOG.md`, `CODEMAP.md`,
  `contracts/CHRONASENSE_EVIDENCE_CONTRACT_V1.md`, this file). No new production file. No
  Ledger, sync, export/import, schema migration, coverage engine, allocation engine, Meal/
  Workout change.
suite: `npm test` (full node chain); `npm run lint`; `npx playwright test` (full suite) +
  targeted `tests/review-reconciliation.spec.js`; `node scripts/runtime-mirror.mjs --check`;
  `node --check` on touched/new `.spec.js`; `git diff --check`.
result:
  - `npm test`: PASS — full node chain completed through `scripts/runtime-mirror.test.js`
    (last in the `&&` chain); no file in the chain was modified by this milestone.
  - `npm run lint`: PASS — 0 errors, 29 pre-existing warnings (all in unmodified `.js` files;
    `index.html` and `tests/**` are not in the lint set).
  - `npx playwright test` (full): **397/397 pass** (2.9m, exit 0). An earlier full run
    surfaced 1 failure (my own new smoke test asserted `#needs-you` hidden while the
    configured sleep reminder was firing); fixed by `sleepSetupDone:false` in that test's
    setup to isolate it to the gap question, then the full suite was re-run clean.
  - `tests/review-reconciliation.spec.js`: 13/13 — see §38/§39 matrix in the landing report.
  - `node scripts/runtime-mirror.mjs --check`: OK — www/ byte-identical (closure 44 files);
    `--write` updated only `index.html`.
  - `node --check`: PASS on `tests/review-reconciliation.spec.js`, `tests/smoke.spec.js`,
    `tests/today-simplification.spec.js`, `tests/plan.spec.js`. (`index.html` JS validated
    transitively by the 397-test Playwright load.)
  - `git diff --check`: clean.
state: candidate left uncommitted / unpushed for one independent milestone review.

## Phase 6H — coarse life evidence V1 (candidate) · 2026-09-09
branch: `feat/coarse-life-evidence-v1`. Base `3c4678a7cd1688476b9b0b35849c25b7fd26d479`
  (origin/main, verified). Isolated worktree; `main`, Meal and Workout untouched.
scope: duration-without-placement storage + reusable capture/edit UI mounted inside Review's
  optional details. 5 new files: `coarse-life-evidence-model.js`,
  `coarse-life-evidence-repository.js`, `coarse-life-evidence-ui.js`,
  `coarse-life-evidence.test.js`, `tests/coarse-life-evidence.spec.js`. Touched:
  `index.html` (modal markup, `#rv-coarse-evidence` mount, module script include, one call in
  `openReview()`), `package.json` (test script + lint file list), `eslint.config.js` (module
  sourceType for the 3 new files), `www/` mirror. No Ledger, no sync, no export/import, no
  Today/gap-engine, no Meal/Workout source changes.
suite: `node --test coarse-life-evidence.test.js`; `npm test` (full chain); `npm run lint`;
  `npx playwright test tests/coarse-life-evidence.spec.js` + full Playwright suite;
  `node scripts/runtime-mirror.mjs --check`; `node --check` on every touched/new file;
  `git diff --check`.
result:
  - `node --test coarse-life-evidence.test.js`: 16/16. Covers model validation (duration
    zero/negative/non-integer/NaN/>1440min, empty label, malformed date, resolution/measurement/
    provenance mismatch, placement-field rejection), deterministic (date, normalized-label)
    identity, the day read model (`getCoarseEvidenceForDate`), and repository behavior: create/
    reload persistence, edit-replaces-not-adds (60→90 stays 90), repeated-save idempotency
    (incl. case/whitespace-only differences), independent records per distinct label/date,
    label-rename merge onto the new identity with the stale row removed, delete-by-id, and a
    corrupt storage envelope throwing rather than silently discarding data.
  - `npm test`: PASS, 0 fail — new suite included in the chain; `test.js`'s own count unchanged
    at 451/451 (this milestone did not touch any file `test.js` covers).
  - `npm run lint`: 0 errors, 0 new warnings (one `no-unused-vars` on `catch (err)` was found and
    fixed during this pass); pre-existing warnings elsewhere unchanged.
  - `npx playwright test tests/coarse-life-evidence.spec.js`: 7/7 — add (no tsStart/tsEnd
    written), edit-replaces (80→100, not 180), reopen-unchanged (no duplicate), remove (only the
    coarse record, exact entries untouched), coarse + same-category exact interval shown
    separately (no combined "2h" total), malformed input rejected without saving (empty label,
    zero duration, >24h), evidence-only day (`computeDailySummary()` stays `null` — no
    fabricated deep/waste claim, `entries` array stays empty — no fabricated timeline block).
  - Full Playwright suite: 380/380, 0 failures (373 pre-existing + 7 new) — no regression.
  - `node scripts/runtime-mirror.mjs --check`: OK after `--write` (3 new files added, `index.html`
    resynced).
  - `node --check`: clean on all 5 new/touched executable JS files.
  - `git diff --check`: exit 0 (only benign CRLF-on-checkout warnings, no whitespace errors).

## Phase 6H — targeted independent-review fix pass (same candidate) · 2026-09-09
branch: `feat/coarse-life-evidence-v1` (still uncommitted). Base unchanged, re-verified
  `3c4678a7cd1688476b9b0b35849c25b7fd26d479` (origin/main) before starting.
scope: the three required FIX FIRST findings only — destructive rename/date-edit ID
  collision, inline-`onclick` id injection, corrupted-store blocking Review from opening.
  Storage architecture, record semantics, capture model, and all isolation properties
  (analytics/gap/timeline/Ledger) were re-verified unchanged. 2 files touched:
  `coarse-life-evidence-repository.js` (collision guard in `save()`),
  `coarse-life-evidence-ui.js` (`data-cle-id` + delegated click handler replacing inline
  `onclick`; try/catch containment in `renderCoarseEvidenceList()`). No schema change, no new
  files, no 6I/sync/backup work.
suite: `node --test coarse-life-evidence.test.js`; `npx playwright test
  tests/coarse-life-evidence.spec.js`; `npm test` (full chain); `npm run lint`; full
  Playwright suite; `node scripts/runtime-mirror.mjs --check` (after `--write`); `node --check`
  on both touched files; `git diff --check`.
result:
  - `node --test coarse-life-evidence.test.js`: **22/22** (was 16, +6). New: A/B — rename and
    date-edit onto an existing independent record are rejected, both original records verified
    byte-identical (`deepEqual`) after the rejected save; C/D — rename/date-move onto a *free*
    identity still succeeds; E — a case/whitespace-only label edit on the same record (
    `previousId === nextId`) is not a false collision; one more test confirming ordinary
    same-id duration edits and repeated unchanged saves are unaffected by the new guard.
  - `npx playwright test tests/coarse-life-evidence.spec.js`: **12/12** (was 7, +5). New:
    rename-onto-existing-label rejected in the live UI with both rows surviving with correct
    values; a label containing `'`/`"`/`<`/`>`/`&` and the exact reviewer-reported
    `x'); window.__xssFired = true; // <>&"'` breakout pattern — confirmed inert (global flag
    never set) through both Edit (which reopens the *correct* record, proving the id
    round-tripped through the `data-cle-id` attribute) and Remove; three corrupted-store
    variants (invalid JSON, unsupported `schemaVersion`, a structurally invalid record) each
    confirming Review still opens, `#rv-win` stays fillable, the widget shows "unavailable",
    and the corrupted value is left byte-identical in storage (never auto-repaired/wiped).
  - `npm test`: PASS, 0 fail — `test.js`'s own count still 451/451 (fix touched no file it
    covers).
  - `npm run lint`: 0 errors, 0 new warnings in the 2 touched files; pre-existing warnings
    elsewhere unchanged.
  - Full Playwright suite: **385/385**, 0 failures (373 pre-existing + 12 coarse-evidence) — no
    regression from the fix.
  - `node scripts/runtime-mirror.mjs --check`: OK after `--write` (2 files updated in `www/`,
    no new/removed files).
  - `node --check`: clean on both touched files.
  - `git diff --check`: exit 0.
  - Findings explicitly reviewed and left as-is per the fix brief (not defects): same-label
    "+ Add" silently updating an existing estimate (documented intended behavior, §13 of the
    milestone spec); "Approximate activities: ~X total" wording nuance around possible
    category overlap (copy-polish, deferred). Durability (sync or export/backup) recorded as a
    roadmap gate required before Wife/Shared or serious dogfood — not implemented in this pass.

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
- Final full `npm test`: **983 total: 982 passed, 1 skipped, 0 failed**
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


## Phase 6C — Guided Measurement Loop V1 · 2026-09-08

A. Status: candidate implemented for independent milestone review; uncommitted and unpushed.
B. Base/main: fetched origin/main, 471c041c295bc0628cd43800b78a89c455a3cea7 (expected hash matched).
C. Worktree: C:/Users/Admin/Desktop/Vibe code/Time audit app - guided-measurement-loop-v1;
branch feat/guided-measurement-loop-v1, registered from origin/main.

| Requested area | Result |
| --- | --- |
| D–E. Hierarchy and daily loop | Today owns execution. Plan Tomorrow and Review are directly accessible secondary actions. Execution records continue through the existing timer/Focus/source paths. Review contrasts intent and factual activity. |
| F. Today primary action | Deterministic precedence: remote execution, local Focus, break/away/tracking, Now routine, unfinished priority, anytime routine, generic work. Missing plans, gaps, and yesterday’s Review never displace work. |
| G. Plan Tomorrow | Existing normal/Rescue, live recurring preview, skip/restore, optional three priorities and open-day confirmation retained. No automatic Learning suggestion merely because a Learning Plan exists. |
| H. Review | Saves without tomorrow preparation; canonical preparation link preserves the reflection draft on return. Existing legacy tomorrow reflection text preserved. Planned outcomes and unplanned tracked activity shown. |
| I–L. Prepared states | Priorities, routine-only, intentional-open and Rescue days remain executable without Morning Startup. No-plan day offers ordinary work and optional priorities. |
| M–N. Terminology/routines | Priorities replaces Today Plan in the active user interface. Routine occurrences stay on Today; definitions, disabled routines and editing move behind Manage routines. Date skip/restore preserves the existing contract. |
| O–Q. Learning/capabilities | Scheduled Learning resolves the pinned next step from Today and retains provenance. No scheduled Learning means no daily Learning obligation. Client work and admin remain ordinary factual work without inferred skill credit. |
| R–U. Handoff/tracking/Focus/continuity | Priority labels pass directly to ordinary tracking or Focus. Scheduled Focus/Learning retain existing identity and reload paths. Focus for a manual routine carries its label without marking Done. Learning Done/Continue returns to Today after successful semantic/Ledger resolution. Existing Pomodoro break behavior remains. |
| V–X. Measurement | No storage/model/schema, timestamp, timezone, source-completion, sync-merge, HUD, workout, sleep or Ledger contract changed. Actual time and explicit Done remain separate. Plan-vs-actual and unplanned comparisons retain existing label-based matching; routine/linked Learning labels are included. |
| Y–AB. Interruptions/toasts | Auto-Review removed; passive Review CTAs remain. Startup no longer opens sleep setup. Eligible sleep reminder is a passive Today button. Setup is explicitly reachable from Settings. Visible Review/Plan Tomorrow/Focus-save success toasts removed; partial/offline saves and errors retained. |
| AC–AD. Strategic/navigation hierarchy | Life Next becomes Guidance; Career Primary next action becomes Career next step. Learn nav label becomes Learning plans. No Do tab or arbitrary tab deletion. |
| AE. Decision fatigue | Before: missing-plan/gap/close-yesterday detours and duplicate Review preparation. After: one dominant execution action, one click to start a known priority, one click to Focus the selected work, optional preparation. Human timing targets (5 seconds, 1–3 minutes, Rescue under 60 seconds) require dogfood, not claimed as measured. |
| AF. Tracking burden | Existing factual sources continue completing linked routines automatically. No extra logging, capability classification, or requirement to account for every minute. Generic Focus no longer asks users to use Learning for work to count. |
| AG. Files | Runtime: index.html, daily-routines-ui.js, plan-tomorrow-ui.js, learning-plan-ui.js, focus-mode.js, capability-career-ui.js, cross-domain-intelligence-ui.js, and byte-identical www mirrors. Tests: guided-measurement-loop.spec.js plus plan, plan-tomorrow, routines, Learning and smoke regression updates. Documentation: CODEMAP.md, CHANGELOG.md, TEST_REPORT.md. |
| AM–AN. Git/safety | HEAD stays at the base; nothing staged, committed, pushed, deployed or merged. No production Firebase, real Obsidian vault, unrelated worktree, or synthetic desktop input writes. Tests use local fixtures/stubbed Firebase; npm’s existing test suite uses temporary fake vault fixtures. |
| AO–AP. Risks/physical checks | Existing Capacitor peer mismatch required npm ci --ignore-scripts --legacy-peer-deps; lockfile unchanged. Physical phone/Android/HUD and whole-day dogfood not performed. Learning semantic outcome still appears in the existing Learning surface, then returns to Today. Routine state remains local-only as before. Label matching is not identity proof. |
| AQ. Deferred | No Personal Model, personality/skill grading, behavioral inference, adaptive scheduling, optimizer, AI coach, recommendation engine, new capability UI, shared/Wife accountability or Phase 7 work. |

### AH–AL. Verification

- Main Chromium run: 168 passed across plan, Plan Tomorrow, Daily Routines, Learning UI, Focus reload and guided-loop suites.
- Additional Chromium: 90 passed initially across smoke and strategic-guidance suites; one obsolete generic-Focus-toast assertion failed, was updated to the approved behavior, and passed individually.
- Follow-up guided suite: 14 passed, including manual routine Focus without semantic completion and responsive widths 390/1280.
- Final measurement/preparation run and final npm result are recorded below after completion.
- npm test passed after the initial implementation; final full rerun follows the last measurement change.
- Runtime mirror check: all 40 runtime closure files byte-identical.
- ESLint changed modules: zero errors; three existing focus-mode warnings (numberFromStorage, TIMER_SYNC_STAMP_KEY, unused catch variable). Module-aware Plan Tomorrow ESLint passes.
- node --check: touched runtime JS and extracted classic inline scripts pass. git diff --check passes.
- Headless screenshots inspected at phone and desktop sizes; stable screenshots use animations disabled. Initial snapshot caught a closing-overlay transition and was replaced with stable captures.
- Early runs exposed outdated tests for the removed morning ceremony, Review picker, routine Edit buttons, and success toasts. These were migrated to the approved workflows, not skipped. No production integrations were exercised.

### Chaos coverage and practical limits

| Cases from request | Evidence |
| --- | --- |
| 1–5. Priority, routine-only, open, Rescue, no-plan | Guided-loop prepared-state matrix; Plan Tomorrow normal/Rescue tests; ordinary admin start without preparation. |
| 6–8. Due routine, Learning due, no Learning | Guided precedence/skip test; Learning start from Today; unscheduled Learning Plan creates no obligation. |
| 9, 30. Real client work and ordinary admin | Label handoff and generic tracking/Focus tests; no inference writes added. Meaningful capability growth is intentionally not assessed. |
| 10–13. Active Focus, ordinary tracking, reload, Learning completion | Focus recovery suite, existing smoke timer tests, new Learning-from-Today Done test, existing Done/Continue/Ledger retry suite. |
| 14. Strong routine evidence | Existing imported Workout, Learning facts, scheduled Focus receipt, duplicate and ambiguous-source tests retained and passing. |
| 15–16, 29. Unplanned work and untouched plans | Review contrasts Not done with unplanned debugging time; planned routine work excluded from the unplanned list. No automatic value judgment. |
| 17. Morning edits | Existing live routine edit/disable/re-enable, date skip, plan add/remove/tombstone, and preparation readiness tests. |
| 18–19. Independent Review, tomorrow ready | Guided save with no plan; canonical editor return retains draft, shows ready, and subsequent Review save leaves plans unchanged. |
| 20–22. Sleep/optional prompts, startup/recovery | Guided Focus/Review/sleep eligibility test; sleep setup remains closed after startup; existing smoke and reload restoration tests. |
| 23–24. Offline and cross-device plan | Existing local failure/offline acknowledgement and real two-browser transaction-convergence tests with stubbed Firebase. |
| 25–26. Whole day without Learn/planning | Automated execution paths demonstrate no required Learn/configuration/planning visit. A physical whole-day session remains a dogfood check. |
| 27–28. Over-cap and intentional routine skip | Existing concurrent over-cap preservation tests, three-priority cap, date-scoped skip/restore, and Today skip precedence test. |

Measurement invariants remain in existing plan items/preparation/tombstones, entries, Focus receipts,
routine state, Learning/Ledger events and imported facts. This milestone does not manufacture
historical plan versions beyond the existing model or turn missing time into activity.


### Final verification completion

- Final npm test: exit 0, all chained suites completed after the final runtime changes.
- Final guided/preparation Chromium: 31 passed (15 guided + 16 Plan Tomorrow), including the
  routine/linked-label measurement correction; no failures or skipped tests.
- Relevant unique Chromium coverage across the recorded runs: 261 tests passed (main suite
  plus two added guided regressions plus 91 smoke/strategic tests; overlapping reruns excluded).
- Final runtime mirror: 40/40 byte-identical. Final changed external JS and freshly extracted
  inline scripts pass node --check. Direct node --check on HTML is unsupported; the corrected
  validation extracts its script bodies without executing them.
- ESLint: zero errors; only the three pre-existing Focus warnings described above.
- Final git diff --check passes; index empty; HEAD remains the fetched base. No commit/push.


## Phase 6C — Bounded review fixes · 2026-09-09

A. Fix status: both blockers corrected; existing candidate remains uncommitted.
B. Worktree: C:/Users/Admin/Desktop/Vibe code/Time audit app - guided-measurement-loop-v1.
Branch: feat/guided-measurement-loop-v1. Rediscovered base/HEAD:
471c041c295bc0628cd43800b78a89c455a3cea7. Earlier candidate edits preserved.

C–E. Review: `unplannedHtml` was appended from inside each planned-row callback and after
the complete list. Removed only the inner append. Existing grouping, label attribution,
routine/Learning exclusions, classifications, totals and entries are unchanged. Three new
actual-browser cases use two priorities with zero, one or two unplanned activities. Structural
selectors prove section/row uniqueness; planned denominator/status and exact entry preservation
are asserted. Before the fix, both nonempty cases reproduced the three-section defect.

F–K. Install: eligibility previously displayed an optional z-index-400 banner unconditionally,
above Focus. `installUiBlocked()` / `refreshInstallBanner()` now defer it during initial parsing,
sign-in, pending/open timer recovery, active/restored Focus, ordinary tracking, break/away,
remote execution, and first-visit/open onboarding. `pendingInstallPlatform` retains eligibility;
`deferredPrompt` retains the browser event on the current page. A scoped MutationObserver watches
class/style changes on the existing surfaces and hides an already-visible banner before paint.
The native install button also checks the gate. Visibility is reconsidered after blockers clear;
standalone/dismissal rules still apply. First-visit onboarding and delayed iOS help use the same gate.
No auth/recovery/Focus/onboarding lifecycle handlers or z-index values were changed.

L. Files changed in this fix round: index.html and its www/index.html mirror;
tests/guided-measurement-loop.spec.js; new tests/install-interruption.spec.js;
CODEMAP.md, CHANGELOG.md and TEST_REPORT.md. No other runtime file was edited in this round.
Runtime-only round diff saved as test-results/bounded-runtime.diff for scope verification.

M–O. Targeted browser command: npx playwright test tests/install-interruption.spec.js
tests/guided-measurement-loop.spec.js tests/plan.spec.js tests/plan-tomorrow-ui.spec.js
tests/focus-reload-recovery.spec.js --project=chromium --workers=2.
Includes all guided-loop tests, relevant Review/preparation paths, real Focus reload/reconciliation,
nine install cases, and the three new uniqueness cases. The first red run reproduced both blockers.
Two initial recovery-test failures were mismatched button labels, corrected to the actual UI label;
no production recovery change was needed.

P. Existing execution/startup smoke subset: 26 passed using tests/smoke.spec.js with grep
'focus|timer|reopening|restor|away|break'. Full npm test/broader Chromium not rerun: production
changes stay inside Review rendering and the bounded PWA install path; shared startup, storage,
Focus and recovery handlers are unchanged.

Q. node --check passes on both actual inline classic scripts (HTMLParser extraction) and the two
touched browser test files. Runtime mirror/check and git diff --check are recorded at final handoff.

R–S. Candidate is unstaged/uncommitted/unpushed on the original base. No production Firebase,
real Obsidian, deployment, commit, push, merge, unrelated worktree edits, or synthetic desktop input.
Browser tests use local HTTP servers, stubbed Firebase and synthetic browser install eligibility
events; the OS/browser installation prompt is stubbed, not invoked on the user's desktop.

T. Remaining practical limits: native install-prompt UX and a physical iOS Add to Home Screen flow
were not exercised. Browser install events are only retained within the current document; after
reload, eligibility depends on the browser firing a new event, as before. Review's existing
label-based attribution and aggregation remain unchanged; no source events were deduplicated.
U. The LOW generic Start versus guided-action visual dominance finding remains deferred to dogfood.

Final bounded results: 90/90 targeted Chromium tests passed; 26/26 relevant execution/startup smoke tests passed. Runtime parity passes for all 40 files; node --check and git diff --check pass. No tests skipped within these runs. Index remains empty and HEAD unchanged.


## Phase 6D — Today Surface Simplification V1 · 2026-09-09

### Milestone handoff (A–AS)

| Requested item | Result |
|---|---|
| A. Final status | Implemented, validated, uncommitted candidate for one independent milestone review. |
| B. Base/main | Fetched origin/main first; exact match: `4f430a5787c519447867910eed17037f77775d4a`. No reconciliation required. |
| C. Worktree/branch | Fresh registered `C:\Users\Admin\Desktop\Vibe code\Time audit app - today-simplification-v1`; `feat/today-simplification-v1`. |
| D. Hierarchy | Before: guided action + hero + priority/routine Start controls + logging/measurement/attention cards. After: Up Next → commitments → conditional Needs You → So Far → intentional secondary actions. |
| E. Up Next | Existing `todayGuidedAction()` remains authoritative; known action has one dominant Start/Done; free-form input is available directly on empty days or through Choose something else. |
| F. Execution states | Remote ownership, Focus, break, away, tracker, Now routine, priority, Anytime routine, free-form retain their existing precedence. Native controls live inside the single execution shell. Focus overlay, HUD, heartbeat and takeover semantics are unchanged. |
| G. Routine discovery | Replaced DOM queries/clicks with eligible occurrence lookup and `performRoutineAction()`. Every launch rereads current state and checks routine/date identity. No storage or completion-model redesign. |
| H. Routine regressions | 14 existing daily-routine browser cases plus Phase 6D/guided-loop tests pass: collapsed/unrendered Now and Anytime actions, Learning IDs, manual minimum/Done/undo, full-session Focus, imported Workout, reload, dates, errors. |
| I. Commitments | One region contains priorities and a two-row compact routine projection, with intentional details. |
| J. Priorities | Add/remove and row Start are behind Edit; existing tracked minutes, explicit Done, cap, IDs, tombstones, and convergence remain. Ordinary tracking does not set Done. |
| K. Routines | Current/due rows are bounded; full Now/Next/Later/Anytime/Done/skipped lists expand intentionally. Manage routines remains visible. Workout never receives a fabricated manual Done action. |
| L. Open/no-plan | Neutral open-day state and optional priorities; free-form execution works immediately without preparation. Empty routines show no setup advertisement. |
| M. Needs You | One conditional region: leading actionable item plus count/expand. Qualifying gap, configured sleep, ambiguous routine evidence, or contextual routine error. Empty region is not displayed. |
| N. Missing time | Uses the existing qualifying interval and original anchors. Fix opens exact prefilled retro times; optional quick corrections are expandable. No activity is inferred. |
| O. Acknowledged unknown | Existing saved `reviews[date].unloggedOk` suppresses Today gap attention for that date. Review save updates the surface immediately. Raw gaps remain unchanged in Timeline/Review. |
| P. Sleep | One configured reminder in Needs You; duplicate default pill hidden. Logging, snooze, existing records/settings remain; logging/snooze refresh attention immediately. Missing sleep without a due configured reminder creates no attention item. |
| Q. So Far | Existing deep minutes and waste + distraction minutes, or “No time recorded yet.” Details opens Review. Deep is not renamed Focus. |
| R. Default metrics removed | Health duplication, Pulse/Signal, ratios, detailed categories, streak tiles, wallet points, yesterday/distraction interpretations, and inline timeline summaries. Calculations remain. |
| S. Analytics destinations | Existing Review, Reflect, Week, and Timeline/details remain; no analytics backend added. |
| T. Routine Prompt | Retrospective shortcuts moved under Log time; independent of scheduled-routine completion. |
| U. Daily Basics | All eight existing shortcuts preserved under Log time: Sleep, Eat, Cooking, Dishes, Hygiene, Walk, Commute, Exercise. |
| V. Same-as-last | Preserved under Log time with its existing explicit “log + start” behavior. Tested distinct from Away state. |
| W. Yesterday | Quiet secondary review link, conditional on an existing unresolved prior-day review; disappears when reviewed. No preparation claim. |
| X. Timeline | One button opens the detailed timeline directly. Date browsing, gaps, nested browser data, recurring blocks, edit/correction and merged identities remain. |
| Y. Recent Entries | Parity audit found direct delete controls worth retaining. Kept under Timeline → Entry actions; Past block also available under Log time. |
| Z. Focus Wallet | Header secondary menu opens existing wallet/spending UI; scoring/debt/redemptions/persistence unchanged and tested. |
| AA. Accountability | Existing buddy card is behind a dedicated secondary destination; no nudge inbox/scoring/lifecycle added. |
| AB. Removed/collapsed | Separate hero authority, header Focus, always-open priority editor, full routine cards, full basics grid, standalone Routine Prompt/repeat, independent sleep pill, large closeout cards, default analytics and inline history. Legacy Details preference stored API remains without global expansion. |
| AC. Conditional sections | Needs You only with candidates; yesterday link only while useful; full routine list only when occurrences/skips exist; detail destinations only when opened; active execution replaces idle input. |
| AD. Measured heights | Prepared fixture: 390px width, 1766 → 849px (51.9% shorter); 1280px width, 1426 → 753px (47.2% shorter). Measured `#view-today` bounding boxes, including existing view padding; identical date/data before and after. Above the aspirational 450–650px phone estimate, but within the requested proportional reduction. |
| AE. Phone inspection | Actual 390px screenshots inspected: main action appears immediately, one strong Start, no horizontal overflow, 44px main action, usable secondary controls, absent empty attention, long titles/routines bounded by row count, Focus controls usable. |
| AF. Desktop inspection | Actual 1280px screenshots inspected: single dominant execution region, compact commitments, quiet metrics, no duplicated hero; active Focus remains unchanged and usable. |
| AG. Decision fatigue | Prepared-day next action is visibly explicit. Five-second comprehension is a human dogfood target, not a measured user-study result. |
| AH. Entry points | Representative prepared fixture previously exposed 6 execution controls: guided Start, header Focus, hero Start, priority-next Start, two row Starts. Now 1 dominant Start plus 1 quiet Focus-mode entry in the same component. Routine details/alternative work are intentional access. |
| AI. Advisor compatibility | Existing Up Next space can host a future explanation/action. No AI, Advisor card, model, or inference was added. |
| AJ. Files | Runtime: `index.html`, `style.css`, `daily-routines-ui.js`, their three `www/` mirrors. Tests: new `today-simplification.spec.js`; adapted guided-loop, routines, priorities, Plan Tomorrow and smoke specs. Documentation: CODEMAP, CHANGELOG, TEST_REPORT. |
| AK. Targeted tests | 17 new Phase 6D Chromium cases, including parameterized execution states, compact routines, unknown-time/sleep handling, metrics, repeat/correction access, rendered before/after and stress screenshots. |
| AL. Existing regressions | Guided loop 18; routines 14; priorities 27; Plan Tomorrow 16; Focus recovery 20; Learning 78; smoke 70; install interruption 9. Underlying npm model/adapter/sync tests also pass. |
| AM. npm test | Passed twice; full retained log: `test-results/phase6d-npm.log`. One existing opt-in lower-case-drive control proof skipped by its environment gate (`CROSS_REPO_COMPAT_CONTROL_PROOF=1`); no failed tests. |
| AN. Chromium | 269 unique affected-surface cases passed across final 141-case Today/Review/smoke run and 128-case source/Focus run. Earlier failures exposed stale UI selectors plus a real post-Review refresh defect; both repaired and verified. |
| AO. Runtime/static | `runtime-mirror --check`: 40-file closure byte-identical. `npm run lint`: 0 errors, 29 warnings in unchanged files. `node --check`: touched JS/specs and all 3 extracted inline scripts pass. `git diff --check` passes. |
| AP. Git state | HEAD remains the base; branch contains only unstaged/untracked milestone changes. No staged changes, commits, pushes or merges. |
| AQ. Safety | Only requested worktree edited. Source/protected worktrees unchanged. No deployment, production Firebase write, real Obsidian write, or synthetic input against the active desktop. Browser tests use local fixtures and Firebase stubs; sync tests use temporary fixtures. |
| AR. Remaining risks | Unknown acknowledgement is date-wide and therefore also suppresses later gaps that day; this honors existing semantics, not interval-scoped storage. Hidden analytics remain computed, so this is presentation reduction rather than a performance redesign. Full routine/timeline detail can still be long by intent. Existing dependency peer conflict required cached `npm ci --ignore-scripts --offline --legacy-peer-deps`; manifests/lockfile unchanged. |
| AS. Physical/dogfood | Still needs independent review, real phone touch/scroll checks, actual cross-device/HUD dogfood, and five-second next-action comprehension assessment. Headless screenshots do not establish physical-device or human comprehension results. |

### Reproduction

```text
npm test
npx playwright test tests/today-simplification.spec.js tests/plan.spec.js tests/guided-measurement-loop.spec.js tests/smoke.spec.js tests/install-interruption.spec.js --workers=3
npx playwright test tests/daily-routines-ui.spec.js tests/plan-tomorrow-ui.spec.js tests/focus-reload-recovery.spec.js tests/learning-plan-ui.spec.js --workers=3
node scripts/runtime-mirror.mjs --check
npm run lint
git diff --check
```

Screenshots (local verification artifacts, ignored by Git):

- `test-results/phase6d/before-390.png`, `after-390.png`
- `test-results/phase6d/before-1280.png`, `after-1280.png`
- `test-results/phase6d/long-commitments-390.png`, `long-commitments-1280.png`
- `test-results/phase6d/focus-390.png`, `focus-1280.png`

### Chaos coverage mapping

| Required scenarios | Evidence |
|---|---|
| 1, 2, 14, 15, 33: planned/no priority, open/unprepared, three priorities | Guided loop, priority suite, Phase 6D known/free-form case. |
| 3–7: Focus, tracker, break, away, remote | Five explicit Phase 6D state cases; Focus reload/ownership suites; smoke takeover. |
| 8–13, 34: Now/several/no routines, Learning/manual/Workout, many routines | DOM-removal regression, bounded two-row tests, existing routine/Learning/imported Workout cases. |
| 16–22: gap, acknowledged/no gap, due/not-due sleep, multiple/empty attention | Phase 6D attention cases and actual Review save regression; sleep log/snooze resolution. |
| 23–25: productive/waste/no time | Parameterized factual So Far cases. |
| 26–27: yesterday unreviewed/reviewed | Prior-day closeout/date-cutoff priority tests, linked review/save state. |
| 28–31: basics/repeat/raw timeline/correction | Phase 6D intentional-access and repeat cases; smoke logging/edit/delete/merge suites. |
| 32: many entries | 80-entry stress fixture with detailed timeline closed by default; recurring/nested/merged smoke cases. |
| 35: no Learning activity | Guided test: unscheduled Learning plan creates no daily obligation. |
| 36–37: active Focus + gap/sleep | Stress fixture retains qualifying history gap and due sleep behind uninterrupted active Focus. |
| 38–39: phone/desktop | Measured actual renders and inspected screenshots at 390 and 1280px, including long commitments and Focus. |
| 40: Advisor absent | Phase 6D assertion plus runtime diff inspection; no AI source added. |

### Explicit self-review

1. One visual execution authority: Up Next shell; no default second generic Start.
2. Free-form work remains directly usable on unprepared/empty days and intentionally selectable otherwise.
3. Manual, Focus, Learning, and source-backed routine paths retain their distinct semantics.
4. DOM-based action discovery removed; executable behavior tested after removing rendered routine cards.
5. Tracking does not set priority Done or manually complete source-backed routines.
6. Retrospective basics/repeat actions remain separate from Away timer actions.
7. Saved unknown-time acknowledgement removes attention while raw gaps stay unknown.
8. No plan is required to execute.
9. No routine is required; no primary setup advertisement appears.
10. Active Focus/tracker/break/away/remote state replaces idle execution input; reminder overlays remain passive.
11. Timeline opens directly with one intentional action.
12. Review remains reflection/analysis and delegates preparation to the one Plan Tomorrow editor.
13. Source models, stores, identity/provenance, ownership, clipping, gap calculation and sync contracts unchanged.
14. Rendered default phone height is 51.9% lower in the representative prepared fixture.
15. Default removes competing logging/analytics/history surfaces rather than simply repositioning them.

No independent review was performed in this implementation session. Leave this candidate uncommitted and unpushed.

## Phase 6D.1 - 2026-09-09
suite: npx playwright test tests/today-simplification.spec.js tests/guided-measurement-loop.spec.js tests/plan.spec.js tests/daily-routines-ui.spec.js tests/focus-reload-recovery.spec.js
result: 97 passed (53.1 seconds).
static: runtime-mirror --check passed (40 files); npm run lint passed with 29 warnings in unchanged JS; node --check tests/today-simplification.spec.js passed; git diff --check passed.
visual: inspected actual Chromium screenshots in test-results/phase6d at 390 and 1280 widths: idle/no plan, known priority, Needs You present/absent, commitments/empty, long names, active Focus, keyboard focus. Start remains dominant; Edit/Manage routines/Fix/action row are bounded neutral controls; Details/More/Quick correction/Leave unknown are underlined and quieter. No new cards or metric emphasis.
height: representative commitments state 390px 849 -> 849; 1280px 753 -> 753.
contrast: calculated default secondary label 12.81:1, secondary border against control 3.49:1, tertiary label against page 10.13:1, primary label 9.93:1, focus ring against control 7.71:1. Disabled labels 3.78:1 are intentionally subdued.
self-review: scoped CSS only in runtime; existing sizes and information hierarchy preserved; no business logic, handlers, persistence or sync changed. No excessive large controls; static copy remains quieter.
untested: npm test model suite intentionally not rerun because production JS/markup is unchanged; dedicated Plan Tomorrow suite not rerun because its styles are unaffected (existing plan regression suite covers its flows). Physical Safari/Android devices not tested. Existing fixed navigation/sync toast overlaps portions of long full-page screenshots. Active Focus overlay controls retain their existing styling.
safety: local fixtures with Firebase stub; no production Firebase or real Obsidian writes; no commit, push, merge or deploy; no unrelated worktree edits.


## Phase 6E — Review Simplification V1 · 2026-09-09

### Status and candidate (A–C, AM–AN)

Ready for independent milestone review; uncommitted, unstaged, unpushed.
Fetched origin/main: `34b06e261d3ea6b45de0ef77c0af9118923291e8`, exactly the requested base.
Registered worktree: `C:/Users/Admin/Desktop/Vibe code/Time audit app - review-simplification-v1`.
Branch: `feat/review-simplification-v1`. No commits, merges, deployments, production Firebase
writes, real Obsidian writes, or edits to unrelated worktrees. The explicit Phase 6E request
supersedes stale task-dispatch instructions; TASKS.md and other phases remain untouched.

### Implementation record (D–AB)

| Return item | Result |
|---|---|
| D Before/after hierarchy | Before: score, five tiles, attention/feeling, gaps, actuals, three text inputs, preparation warning, Save. After: factual summary, feeling, optional win, conditional missing time, Save/Close, separate optional reflection details and Full analysis, preparation link. |
| E Reality Score | Active markup and count-based calculation removed; not promoted elsewhere. |
| F Judgmental wording | Both “You moved forward” and “You regressed” removed from active Review. Existing stored category labels remain. |
| G Replacement score | NO. |
| H Factual summary | Existing `sumEntryMinutes(getEntriesForDateWindow(...), null, dateKey)` with missed/deleted entries excluded. |
| I Summary semantics | Recorded duration uses existing overlap-union/date-window logic. Optional Plan count is exactly existing `planDone/planCount`, labeled “done or worked on”; never merged with full actuals/routine population. No productive/completed inference. |
| J Feeling | Focused/Mixed/Distracted always independent of analytics availability, optional, toggleable to null, stored as existing focusRating. |
| K Win | Optional, never prefilled, same win field. Empty Save and feeling-only/win-only Save remain valid. |
| L Missing time | Existing 30-minute threshold, one compact item, Log time and Leave unknown; no mandatory repair. Raw intervals remain in analysis and the existing Timeline model. |
| M Unknown acknowledgement | Existing date-wide unloggedOk; only durable through Save. Original threshold-conditioned Save behavior retained. Acknowledgement creates no entry and removes no raw gaps; existing Today suppression verified. |
| N Repair detour | A bounded in-memory flag returns from the explicit retro editor to the existing Review DOM. Evidence refresh does not reinitialize inputs. Cancel and successful repair preserve date, focusRating, win, waste, avoid, acknowledgement and edited legacy tomorrow. |
| O Plan vs actual | Existing renderer/classifications unchanged, behind Full analysis. Done early, Done, Worked on, Not done, Removed, routine levels and tracked attribution remain distinct. |
| P Unplanned activity | Existing grouping/exclusions and “Unplanned tracked activity” label unchanged, behind Full analysis. |
| Q Waste | Existing saved values remain editable in Optional reflection details; same semantics. |
| R Automatic waste prefill | Removed, including saved empty waste on today's review. |
| S Avoid | Same optional avoid field, behind Optional reflection details. |
| T Hidden historical fields | Inputs initialize even while collapsed; Save preserves them and other existing record properties. Legacy tomorrow uses a textarea; untouched original text, including CRLF, is retained exactly. Explicit edits/clears still save. |
| U Tomorrow preparation | Secondary link after Save/details; no preparation warning or Review auto-save. Uses canonical editor. |
| V Historical preparation | Existing tomorrow-relative-to-now target retained; historical link names target ISO date and says “relative to today.” No planning-contract change. |
| W Save | Primary “Save reflection”; preserves record/persistence, _savedAt, existing reviews/date Firebase payload, close and dependent refresh calls. |
| X Close | Secondary “Close”; backdrop also dismisses without saving. Ordinary reopen restores saved data, not a claimed saved draft. |
| Y Completion | Existing record-existence semantics; no closed/completed workflow flags. |
| Z Full analysis | Separate native details disclosure for existing metric tiles, attention calculations/caveat, full actuals/unplanned and raw gaps. No new destination/backend. |
| AA Today Details | Opens Review with Full analysis expanded and scrolled into view; verified. Existing Timeline destination remains on Today. |
| AB Default inputs | Four inputs (feeling, win, waste, avoid) become two optional inputs (feeling and win). Legacy fields have a separate disclosure from analytics. |

### Responsive evidence (AC–AE, AP)

Same fixture at 390×844, current day with a morning entry and missing time:

- Base content height 1,263px; Save top approximately 1,229px from viewport top.
- Candidate content height 606px; Save top approximately 523px. About 52% less content.
- The audit's approximately 1,540px was a different fixture; not presented as our measured baseline.
- Simulated 390×480 viewport: 606px scroll content, 438px client height; Save within viewport
  (top 413px, bottom 447px). Keyboard Tab navigation from win reaches Save.
- 1280×900 desktop: centered 420px form, 606px content; no unnecessary stretched whitespace.
- No horizontal overflow in tested phone/desktop sizes, including expanded historical analysis
  with a very long activity label. Historical date wraps and legacy inputs remain editable.
- Phone and desktop screenshots were visually inspected; default input font is 16px. Expanded
  analysis scrolls within the modal. Native disclosures remain keyboard-operable.
- No physical mobile keyboard, iOS Safari, Android device, or human nightly dogfood session was
  performed. Height reduction is measured browser evidence, not a claim about physical typing.

Screenshots retained under ignored `test-results/phase6e/review-verified-results/` and baseline
under `test-results/phase6e/baseline-test-results/`. Logs: `phase6e-verified.log`,
`phase6e-browser-final.log`, `phase6e-regressions.log`, `phase6e-baseline.log`,
`phase6e-npm-test.log`, `phase6e-lint.log` (ignored local evidence).

### Chaos verification (AF)

All 33 requested scenarios were covered by synthetic browser cases or the relevant existing
regressions. These verify functional behavior, not the subjective quality of a real day.

| Requested cases | Evidence |
|---|---|
| 1 perfect planned day; 2 no plan; 3 partial plan | Dedicated chaos cases; save and unchanged source data, correct done-or-worked-on summary. |
| 4 valuable unplanned work | Dedicated learning-category case plus guided-loop unmatched-list population assertions. |
| 5 classified distraction; 6 intentional Facebook | Dedicated distraction/social cases; no new grade or reclassification, empty waste stays empty. |
| 7 no deep work; 8 long deep session; 9 no tracked time | Dedicated cases, nullable feeling and zero-input saves. |
| 10 many gaps; 11 acknowledged unknown | Multiple-gap case plus durable acknowledgement/no gap deletion and Today suppression assertions. |
| 12 remembered repair | Actual retro save returns to historical Review; new entry has the historical date and selected social category. |
| 13 sleep missing; 14 routines incomplete | Dedicated cases and existing routines/Today suites; Review save remains independent. |
| 15 difficult debugging; 16 emergency | Dedicated cases, source arrays/plans unchanged by reflection save. |
| 17 productive feeling/weak metrics; 18 bad feeling/strong metrics | Independent subjective ratings saved exactly; no metric override. |
| 19 empty win; 20 empty waste | Zero-input save and waste-prefill tests. |
| 21 historical waste; 22 historical avoid | Collapsed save tests, retained exact strings, then explicit editing. |
| 23 detailed analysis | Default hidden, disclosure reachable, collapse retains draft; exact existing terminology regressions. |
| 24 30-second closeout | Zero-input save path without repair/preparation (workflow tested; no timed human session claimed). |
| 25 prepared tomorrow; 26 unprepared tomorrow | Existing preparation regression plus confirmed Open day return; Review saves independently. |
| 27 Advisor absent | No Advisor dependency; feeling also verified with attention derivation unavailable. |
| 28 mobile | 390×844 and 390×480, keyboard navigation, screenshots, overflow checks. |
| 29 historical edit | Collapsed field retention, multiline tomorrow, all explicit detours and long-label mobile test. |
| 30 offline/local | Browser offline with no room ref; localStorage review persisted and reopened. |
| 31 repair detour | Cancel and save both preserve all unsaved inputs without Review persistence. |
| 32 Plan Tomorrow detour | Cancel and confirm both preserve all unsaved inputs without Review persistence. |
| 33 Today Details | Expands and reaches Full analysis immediately. |

### Files and verification (AG–AL)

Changed runtime sources: `index.html`, `insights.js`, `style.css` and their three generated
`www/` mirrors. Tests: new `tests/review-simplification.spec.js`; adjusted
`tests/guided-measurement-loop.spec.js`, `tests/plan.spec.js`, `tests/plan-tomorrow-ui.spec.js`.
Documentation: `CODEMAP.md`, `CHANGELOG.md`, `TEST_REPORT.md`.

- Focused browser coverage: 32 passing tests in the final candidate.
- Final command: `npx playwright test tests/review-simplification.spec.js tests/guided-measurement-loop.spec.js tests/plan-tomorrow-ui.spec.js --project=chromium --output=review-verified-results`: **66 passed**.
- Existing regression command included guided measurement loop, plan, Plan Tomorrow, Today
  simplification, daily routines and smoke (including Timeline correction). Initial result:
  162 passed, 1 stale visibility assertion failed. Updated that assertion to explicitly open
  analysis; the entire 27-case plan suite then passed. All 163 selected existing cases passed
  across these runs; there is no unresolved failure.
- Initial detour fixtures had no source entries, so the existing gap helper produced no gap.
  Fixtures now supply real interval evidence. An empty preparation fixture now explicitly chooses
  Open day before confirming. No gap/planning semantics were changed to make tests pass.
- `npm test`: **passed, exit 0**, all chained suites completed.
- `node scripts/runtime-mirror.mjs --check`: **passed**, 40-file closure byte-identical.
- `npm run lint`: **passed**, 0 errors, 29 existing warnings.
- `node --check`: **passed** on insights.js, all four touched test JS files, and both actual
  executable inline script blocks parsed from HTML (excluding dormant commented markup).
- `git diff --check`: **passed**.
- Fresh `npm ci --ignore-scripts` encountered the repository's existing Capacitor 8 vs Google Auth
  Capacitor 6 peer conflict. `npm ci --ignore-scripts --legacy-peer-deps` succeeded. No dependency
  manifest/lockfile changes. No package remediation was folded into this task.
- Temporary baseline test removed; measurement screenshots retained only as ignored artifacts.

### Explicit self-review answers

1. Reality Score gone from default Review: **yes**, also removed its active computation.
2. “You regressed” gone: **yes**.
3. New replacement grade: **no**.
4. Factual summary accurate: **yes**, existing union duration and separate existing Plan population.
5. Feeling visible without analysis: **yes**, even if derivation is unavailable.
6. Win optional: **yes**.
7. Missing time optional: **yes**.
8. Save with unresolved gaps: **yes**, tested.
9. Unknown stays unknown: **yes**, no synthetic activity or removed gap.
10. Full plan-v-actual behind analysis: **yes**.
11. Unplanned activity behind analysis: **yes**.
12. Automatic waste prefill gone: **yes**.
13. Historical waste/avoid preserved: **yes**, tested.
14. Collapsed fields survive Save: **yes**, including multiline tomorrow and unknown existing properties.
15. Gap repair preserves unsaved inputs: **yes**, cancel/save tested on historical Review.
16. Plan Tomorrow return preserves inputs: **yes**, cancel/confirm tested.
17. Tomorrow subordinate: **yes**.
18. Save obvious primary action: **yes**, inspected at phone/desktop sizes.
19. Close clearly no-save: **yes**, tested and not called Skip.
20. Today Details reaches analysis: **yes**, expanded by the route.
21. Offline/local works: **yes**, tested.
22. Default mobile height materially fell: **yes**, 1,263 to 606px with the same fixture.
23. Data contracts preserved: **yes**, no changes to source entries, calculations, classifications,
    planning/routine/Focus/Ledger models, date keys, nullable rating or sync path.
24. Simpler rather than one giant toggle: **yes**, a standalone two-input reflection, separate
    optional legacy editing and analysis disclosures, with no score or automatic waste suggestion.

Code-health self-review: small presentation changes using existing helpers; only bounded detour
state; no new persistence/backend/grade; no unrelated refactor. Existing timer/gap/model code and
hard-rule call sites were not modified. No new hardcoded CSS colors. User instructions to stop
uncommitted supersede legacy commit/status handoff checklist items.

### Remaining risks and physical checks (AO–AP)

In-memory detour preservation is intentionally limited to the explicit Review retro editor and
existing Plan Tomorrow return. It is not reload persistence; ordinary Close discards unsaved edits.
Historical preparation still means tomorrow relative to now, now stated explicitly. Existing gap
helper behavior for days with no entries is unchanged. Real cloud connectivity, physical keyboards,
iOS/Android rendering and actual nightly dogfood require human/device checks; no such results are
claimed. No remaining automated blocker; candidate is ready for independent review.


## Phase 6E — bounded keyboard focus fix · 2026-09-09

A. Fix status: ready for targeted re-review.
B. Root cause: keyboard activation called `renderReviewFeeling`, replacing the focused
button through innerHTML. All three new keyboard tests reproduced focus loss before the fix.
C. Approach: initialize button values, then update aria-pressed and the existing primary/ghost
classes in place in `setReviewFocusRating`. The focused DOM node survives activation.
D–F. Actual Enter activation (Mixed, Focused) and Space activation (Distracted) retain focus
on selection and toggle-to-null. Tab advances Mixed → Distracted, Focused → Mixed,
Distracted → One win. Shift+Tab returns coherently before testing the clear activation.
G–I. Mouse behavior, local saved-state restoration and historical editing passed, including
historical mouse selection → Save → reopen selected → clear → Save null. Existing tests
also retain optional feeling, independent strong/weak metric cases, detours and sync payloads.
J. Production changes for this rework only: index.html and generated www/index.html.
K. Test changes: tests/review-simplification.spec.js (four new cases). Documentation appended
to CHANGELOG.md and TEST_REPORT.md. Other dirty files belong to the existing Phase 6E candidate.
L. New regressions: three parameterized real keyboard cases and one historical mouse/persistence case.
M. `npx playwright test tests/review-simplification.spec.js --project=chromium`: 36 passed.
Directly relevant plan/guided-loop/Plan Tomorrow cases (`--grep 'Review|review'`): 14 passed.
N. `node scripts/runtime-mirror.mjs --check`: exact 40-file closure parity.
O. Both actual executable inline scripts and the modified test file pass node --check;
git diff --check passes. No unrelated full-suite rerun was needed for this bounded helper fix.
P. Product logic/data-semantic changes: NONE. Only DOM update behavior changed to retain focus.
Q. origin/main fetched first and unchanged; HEAD remains
34b06e261d3ea6b45de0ef77c0af9118923291e8 on feat/review-simplification-v1.
The candidate remains unstaged, uncommitted and unpushed.
R. No styling, wording, layout, Save/Close, analytics, gap, planning, or unrelated worktree changes.
No production Firebase or real Obsidian writes; no commit, push, merge or deployment.
S. No remaining required finding identified; targeted independent re-review remains outstanding.

Explicit self-review:
1. Keyboard activation retained focus: yes, all three buttons.
2. Toggle-to-null retained focus: yes, all three buttons.
3. Subsequent Tab moved forward: yes, asserted after selection and clearing.
4. Mouse behavior unchanged: yes, selection and clearing tested.
5. focusRating semantics unchanged: yes, same values, null behavior and persistence.
6. Historical editing unchanged: yes, saved selection restored and then cleared successfully.
7. Any other Phase 6E behavior changed: no.
8. www parity exact: yes.
9. Scope bounded: yes, two runtime functions and their mirror, tests and verification notes only.

Evidence: ignored phase6e-keyboard-before.log (three reproduced failures),
phase6e-keyboard-after.log (36 passes), phase6e-keyboard-regressions.log (14 passes).

## Evidence contract V1 - 2026-09-09
Base: eb977d007ab7082a0cdf8329613b008a0e502c4d, fetched origin/main and verified before worktree creation.
Branch: feat/evidence-contract-v1. Registered worktree: C:/Users/Admin/Desktop/Vibe code/Time audit app - evidence-contract-v1.

Validation:
- Red/green: node test.js before guard: 445 passed, 1 failed (new schedule exclusion regression). After guard: 446 passed, 0 failed.
- npm test: exit 0; 1,028 passed across the custom runner and Node suites, 0 failed, 1 opt-in control skipped. The skipped lower-case-drive reproduction requires CROSS_REPO_COMPAT_CONTROL_PROOF=1; it is not needed for this change.
- Initial sandbox npm test failed with spawn EPERM; approved child-process execution passed the full suite.
- node scripts/runtime-mirror.mjs --check: pass, 40-file closure byte-identical.
- npm run lint: exit 0, 0 errors, 29 warnings. Initial attempt without local dependencies failed ENOTCACHED; final run reused existing dependencies through an ignored node_modules junction to adapter-stabilization, without installing or changing donor packages.
- node --check: capability-career-analytics.js, www/capability-career-analytics.js, test.js all pass. No inline script changed.
- git diff --check: pass. New contract whitespace and documentation links checked.
- No browser/device test: no DOM/CSS/capture/UI path changes. Existing analytics outputs can change when excluding schedule-backed capability mappings.
- No real source-app integration, Firebase, deployment, or real Obsidian writes. Export tests use fixture/temporary vaults only. Meal and Workout files unchanged.

Self-review (numbers match the user milestone):
1. YES: timeline gap and unknown are canonically separate.
2. YES: interval, duration without placement and occurrence are separate.
3. YES: provenance and resolution are separate.
4. NO at the changed scope for explicit scheduled_template markers; unmarked legacy assumptions and existing direct-entry consumers are not universally quarantined.
5. NO canonically: app/site identity alone is not confirmed meaning; existing passive UI labels remain a documented deviation, and capability mappings require explicit user interpretation.
6. NO at the changed scope: it creates no duration. Existing duration fallbacks elsewhere remain documented deviations, not newly fixed behavior.
7. NO canonically: unknown is not confirmed drift/waste. Legacy attention idle-recovery wording remains deferred.
8. NO canonically: Ledger copy is one lineage, not corroboration; no universal new deduplication engine is claimed.
9. NO universal confidence score created.
10. NO coarse estimate storage added.
11. NO Today gap prompting change.
12. NO Review redesign.
13. NO Focus behavior fix; reliable retrospective affected-record detection is unavailable.
14. NO new user-facing complexity; schedule-backed capability counts/recommendations may correctly change.
15. NO speculative unused infrastructure; two lines extend the existing evidence scope.

Code-health review: minimal existing-path predicate, no new state/API/dependencies, no source mutation, preserved future/tombstone precedence and positive evidence controls; acceptable for independent review.
Next: deterministic expired-Focus completion boundary and exactly-once restore logging, with planned end rather than reopen time; historical repair remains separate.
Safety: candidate uncommitted, unstaged, unpushed and unmerged. No branch/worktree deletion, migration, production writes or unrelated worktree edits.

## Evidence contract V1 - bounded notice review fix - 2026-09-09
Fetched origin/main first: still eb977d007ab7082a0cdf8329613b008a0e502c4d, matching candidate HEAD on feat/evidence-contract-v1.
Root cause: renderExcludedEvidenceNotice() grouped every life-ledger-prefixed reason into unavailable/tombstoned wording, including the valid schedule-assumption exclusion.
Fix: count exact unavailable/tombstoned reasons and scheduled assumptions independently; preserve the existing notice surface and missing-link wording.

Verification:
- Before correction, six new browser cases: 3 passed, 3 failed (single/multiple schedule and mixed cases reproduced the false notice).
- After correction, npx playwright test tests/capability-career-ui.spec.js --reporter=line: 14 passed, 0 failed, including all six new rendered-dashboard cases.
- Cases cover no exclusions, one/two schedule assumptions, one unavailable link, one tombstoned link, and two schedule assumptions plus one unavailable and one tombstoned link. Actual adapter/analyzer and runtime-backed UI are exercised; profile/Ledger state remains unchanged.
- node test.js: 446 passed, 0 failed.
- node scripts/runtime-mirror.mjs --check: pass, 40-file closure byte-identical.
- node --check: capability-career-ui.js, www/capability-career-ui.js and tests/capability-career-ui.spec.js pass.
- git diff --check: pass.
- Full npm test intentionally not rerun: explanation-only formatter change, no broader coupling or focused-test regression; the prior candidate full-suite result remains recorded above.
- Analyzer SHA256 before/after correction remains D82973BC25700F9DBDC58121F6E363F116B7ED95D4E207D416474F20CCC4133D.

Self-review:
1. YES: schedule evidence remains excluded from confirmed current capability proof.
2. NO: schedule exclusion no longer says unavailable/tombstoned.
3. YES: genuine unavailable/tombstoned links retain their existing notice.
4. YES: mixed exclusion reasons have independent correct counts and wording.
5. NO: currentEvidenceScope() did not change in this correction.
6. NO: evidence semantics did not change.
7. NO: source/Ledger records did not change.
8. NO: no new UI surface.
9. NO: no later truth-fix work.
10. YES: scope remained bounded.

Deferred Low findings: unloggedOk acknowledges missingness without adding activity evidence; accounting boundaries are independent of sleep/wake/planning boundaries. Contract wording left unchanged as requested.
Safety: local fixture browser tests with Firebase stub; no production Firebase/real Obsidian writes, Meal/Workout edits, history migration, Focus/gap changes, Review redesign or unrelated worktree modifications. No commit/push/merge/deploy. Candidate remains uncommitted and unpushed; no required finding remains unaddressed, pending independent targeted re-review.

## Phase 6G.1 - Deterministic source truth fixes V1: expired Focus completion boundary - 2026-09-09
Fetched origin/main first: c47f1e5227c0a9993bf1c004b6939b7ce332cb71, matching the expected base. Fresh registered worktree `Time audit app - source-truth-fixes-v1`, branch `feat/source-truth-fixes-v1`. `main`, Meal and Workout source repos untouched.

Scope: the single deterministic source-truth defect whose fix is self-contained - a short Focus work session restored long after its planned end logging through `Date.now()` (traced in the Evidence Contract "Expired Focus" section). Sections 6-11 audited; corrections that would require touching Today/Review/analytics deferred to 6G.2. 1 production file changed: `focus-mode.js` (+ `www/focus-mode.js` mirror). 1 test file changed: `tests/focus-reload-recovery.spec.js`.

Root cause: `restoreFocusSession()`, on an expired work phase, calls `endWorkSession()`, which used `tsEnd = Date.now()` with `tsStart = focusStartTime` (the persisted phase start). Reopen hours later => `blockIntervalMin` = hours; `logFocusSession()` writes an ordinary `energy: deep`, `onPlan: true` entry with `id = tsEnd`. Break transition and downstream (Today/Review deep totals, insights, attention signals, Focus Wallet, Daily-Routine + Learning-Plan hooks, ordinary-entry + Learning-Plan-focus drafts) all inherit the inflated interval.

Fix:
- `endWorkSession()` end timestamp = planned endpoint: `(focusStartTime ?? pomodoroPhaseStartedAt) + pomodoroWorkMin*60000`, falling back to `Date.now()` only if neither is finite. `endWorkSession()` is reached only by a phase that ran its configured length (`tickPomodoro()` at zero; `restoreFocusSession()` past planned end), so planned end is truthful for every caller. Early manual exit (`saveActiveFocusSession()`) is a separate path and still logs real elapsed time.
- `restoreFocusSession()` expired-work branch: after `endWorkSession()`, if it entered a break, re-derive the break's real remaining from the wall clock; conclude it once via existing `endPomodoroBreak()` when that window also elapsed, else resume with the true remaining.
- `logFocusSession()` exactly-once guard: planned-end timestamp is deterministic, so repeat restoration / second tab / page+HUD race recompute the same `id`; return the existing entry instead of appending a duplicate when one with the same `id`/`tsStart`/`energy: deep` exists. Downstream Daily-Routine (`state.focus[entry.id]`) and Learning-Plan (`sourceEntityId = focusEntryId`, upsert) hooks are id-keyed and converge.

Verification:
- `tests/focus-reload-recovery.spec.js`: 26/26 (was 20). 6 new deterministic regressions: 40-min reopen capped at 25 and dated/ended at planned end; 5-hour reopen produces no 5-hour deep entry and returns to idle once; repeated reopen after a delayed restore => exactly one receipt; reopen exactly at the endpoint => 25 min + single transition to break; manual Stop at 8 min stays 8 (not 25); delayed expired restore crossing midnight dates the receipt to the planned-end calendar day.
- Full `npm test`: exit 0, all suites green (`test.js` 446/446; one pre-existing env-gated control test skipped, unrelated).
- Full `npx playwright test`: 360/360 passed, exit 0 (no regression in smoke / learning-plan / life-* / today / review specs).
- `node scripts/runtime-mirror.mjs --check`: OK, 40-file closure byte-identical.
- `npm run lint`: 0 errors, 29 warnings (all pre-existing cross-file globals; none in the changed hunks).
- `node --check focus-mode.js www/focus-mode.js tests/focus-reload-recovery.spec.js`: pass.
- `git diff --check`: clean.

Historical Focus data: NOT repaired and NOT attempted. Stored entry fields still cannot deterministically separate a legitimate long timer/manual session from an old inflated restored one (Evidence Contract finding stands). No history scan, blind cap, deletion, or manufactured restoration metadata.

Audits (sections 6-11), no code change this milestone:
- Scheduled templates (`autoLogDueTemplates`): entries already carry `scheduledAutoLog`/`autoLogged`/`templateId`; adapter `captureMethodFor()` -> `scheduled_template` preserves the assumption marker through payload + provenance; Career scope already excludes it. No changed path upgrades schedule -> confirmed actual. Time/plan/insight surfaces still reading scheduled as actual -> 6G.2.
- Missing duration: adapter `intervalFor()` already rejects non-positive; equal-endpoint workout history stays occurrence-with-unknown-duration. This milestone's `logFocusSession()` keeps its `dur < 1 => null` guard and never manufactures an interval.
- Passive device observation (`browser-extension/background.js` default `energy: 'waste'`; Android `syncPhoneUsage`): unchanged; the default classification is consumed directly by Today/Review/Wallet, so a source-level correction cannot be made without changing those surfaces (out of scope) -> 6G.2.
- PC Time (`startPCTimeLive` -> `autoLogBlock('PC Time', lastEntry?.energy || 'deep', ...)`): the `|| 'deep'` fallback manufactures deep-work meaning from a "computer is on" signal, but `energy` is the exact field Today/Review/deep-count/Wallet read; no provenance/derived layer exists and none may be added here -> 6G.2.
- `confidence.score: 1, basis: source-recorded`: only transported by the adapter; no changed path interprets it as behavioral certainty.
- Ledger lineage: the Focus entry -> ordinary draft and Focus entry -> Learning-Plan `focus_session_completed` draft (`additiveForTimeTotals: false`, keyed by `focusEntryId`) remain one lineage each; the dedup guard reduces, not adds, duplication risk.

Self-review: Q1 NO (25-min restore 5h later cannot create 5h deep - regression-tested). Q2 YES (deterministic id + guard). Q3 YES (manual Stop path untouched, regression-tested). Q4 NO (no history rewrite). Q5 NO (no scheduled path changed). Q6 NO (no fabricated interval). Q7 NO (no passive-observation promotion changed). Q8 NO (no numeric confidence). Q9 NO (Ledger copies not independent). Q10 NO (no analytics truth fixes). Q11 NO (no new routine UX). Q12 NO. Q13 NO (Today/Review unchanged).

Safety: candidate uncommitted, unstaged, unpushed, unmerged. No branch/worktree deletion, migration, production Firebase/Obsidian writes, Meal/Workout edits, or unrelated worktree/artifact changes.

## Phase 6G.2 - Deterministic analytics truth fixes V1 - 2026-09-09
Fetched origin/main first: `9db74858a8da9c6f44a2a51e9c6cc26619cb8302`, matching the expected base. Fresh registered worktree `Time audit app - analytics-truth-fixes-v1`, branch `feat/analytics-truth-fixes-v1`. `main`, Meal and Workout source repos untouched.

Scope: Today / Review / weekly Insights / attention signals / Focus Wallet interpretation of passive site/app observations, schedule assumptions and "PC Time" computer-session context - the four items 6G.1 deferred. 5 production files changed (`evidence-interpretation.js` new, `index.html`, `insights.js`, `focus-wallet.js`, `attention-signals.js`) + `www/*` mirrors. 3 test files changed (`evidence-interpretation.test.js` new, `attention-signals.test.js`, `test.js`) + 1 new Playwright spec (`tests/analytics-truth.spec.js`).

Root cause (per file): `computeDailySummary`/`computeCloseoutSummary` and the `insights.js` totals summed every entry's `energy` regardless of whether it was a user assertion or a default; `deriveAttentionSignals` classified by energy alone; `computeFocusWallet` scored by energy alone. None distinguished a confirmed classification from a passive default, a schedule assumption, or PC-Time context - so a foregrounded YouTube tab, a recurring template, or the ambient "PC Time" tracker could all read as confirmed deep work or confirmed waste, and a browser observation layered over a real work block could push deep% + waste% past 100%.

Fix - one shared interpretation decision, not a new evidence system:
- `evidence-interpretation.js` (new): `hasConfirmedEnergyClassification(entry)` = not `isPassiveObservationEntry` (`browserUsage`/`phoneUsage`/`source`) AND not `isScheduledAssumptionEntry` (`scheduledAutoLog`/`captureMethod`) AND not `isComputerSessionEntry` ("PC Time"/"Screen time" + `autoLogged`/`quickLogged`). No new schema, no confidence score. Classic-script IIFE on `globalThis`, same pattern as `focus-wallet.js`.
- `index.html` `computeDailySummary()`/`computeCloseoutSummary()`: operate on `dayEntries.filter(hasConfirmedEnergyClassification)`. Fixes the overlap-inflation case directly (excluded entries no longer land in any energy bucket, so they can't double-count against a confirmed block). `computeCleanStreak()` logic unchanged, label "days clean" -> "days, no waste logged". `renderHonestSummary()`: "clean week" -> "No confirmed waste logged this week"; "sharpest at X" -> "most deep blocks started around X". Review-history rows append "of N recorded". "Peak focus hour" -> "Deep blocks start" everywhere (calculation unchanged - still buckets by block start hour, so the label was relabelled to match, not the math redone).
- `insights.js` `_insightMinutes`/`_insightEnergyMinutes` pre-filter to confirmed entries; `analyzeBehavior`, `renderAwarenessSignal`, `computeInsights`, `checkEscalation` (punitive escalation) all inherit it. "of today"/"of your day" -> "of tracked time" in `getDailySummaryInsight`, `renderAwarenessSignal`, and the currently-unwired `generateInsights` (fixed for consistency). "Reactive mode" (elapsed-time-only claim) softened to "no deep work logged for X".
- `focus-wallet.js` `computeFocusWallet()`: deep-earn and waste-cost branches gate on `hasConfirmedEnergyClassification(entry)` (via `globalThis`, falls back to true if the helper isn't loaded). Sports scoring untouched.
- `attention-signals.js` `classifyEntry()`: passive/scheduled entry -> `'neutral'` regardless of energy (markers inlined, module stays dependency-free). `attentionSignalLines()`: "Recovered from drift" -> "Refocused after a break". `ATTENTION_SIGNALS_VERSION` 1 -> 2.
- Coverage/completeness audited: no "coverage score"/"fully tracked"/"all accounted for" claim exists in the current UI - nothing to fix for that item.

Verification:
- `evidence-interpretation.test.js`: 6/6 new (predicate matrix incl. non-entry inputs, and a user-reclassified-entry case proving explicit assertion wins once the passive marker is gone).
- `attention-signals.test.js`: 29/29 (was 26). 3 new (passive browser observation stays neutral / no false break; positive control - equivalent user-asserted waste block still creates a break+recovery; scheduled-template entry stays neutral), 2 existing recovery-line assertions updated to the new label, 1 existing case rewritten (was asserting a passive observation as a confirmed attention break - that assertion encoded the exact defect this milestone fixes).
- `test.js`: 451/451 (was 445). +5 new: passive-browser-deep earns 0, passive-phone-waste costs 0, scheduled-deep earns 0, PC-Time-deep earns 0, positive control (user-asserted deep/waste) unaffected.
- `tests/analytics-truth.spec.js` (new): 5/5. Today-pulse overlap case (confirmed deep 60/60, browser-waste-over-the-same-hour = 0, deep%+waste% <= 100), Review close-out confirmed-only, Wallet abstains on unconfirmed entries, weekly summary uses "No confirmed waste logged", served markup no longer contains "Recovered from drift".
- Full `npm test`: exit 0, every runner in the chain 0 failures (`test.js` 451/451; all `node --test` suites green; `runtime-mirror.test.js` 14/14).
- Full `npx playwright test`: run twice for confidence - 364/365 then 365/365. The one failure (`smoke.spec.js:968` "editing an auto-logged schedule can update the recurring template") did not touch any file this milestone changed (template-edit UI, unrelated to energy classification/Wallet/attention/pulse); reproduced 0/3 with `--repeat-each=3` in isolation and 0/1 on the immediate full-suite re-run - treated as a pre-existing flake, not a regression.
- `node scripts/runtime-mirror.mjs --check`: OK, 41-file closure (was 40) byte-identical.
- `npm run lint`: 0 errors, 29 warnings (same count as baseline; none in changed hunks).
- `node --check` on `evidence-interpretation.js`, `insights.js`, `focus-wallet.js`, `attention-signals.js`, `evidence-interpretation.test.js`, `attention-signals.test.js`, `test.js`: pass. (`index.html` has no JS-file syntax checker; its script content is exercised by the Playwright suite above.)
- `git diff --check`: clean.

Historical Focus data: untouched, per the Evidence Contract's "no reliable retrospective quarantine" finding - unaffected by this milestone either way, since it changes interpretation of currently computed metrics going forward, not which past entries are affected.

Self-review: Q1 NO (scheduled block excluded from confirmed metrics, still stored/usable as intent). Q2 NO (default site identity alone no longer proves confirmed waste/deep). Q3 NO (default app identity alone no longer proves confirmed waste). Q4 NO (PC-Time fallback excluded from confirmed deep-work claims). Q5 NO (idle/unknown gap not promoted to drift). Q6 NO ("Recovered from drift" removed; label now "Refocused after a break"). Q7 NO ("clean week" -> "No confirmed waste logged"). Q8 YES (Review rows show "of N recorded"; pulse card denominator is the confirmed-classification total it actually sums). Q9 NO in changed analytics (overlap fix removes the common passive-over-confirmed case; two confirmed different-energy entries overlapping is unchanged/deferred, documented). Q10 YES ("sharpest hour"/"peak hour" relabelled to match the start-hour-bucket calculation; math unchanged, label no longer overclaims). Q11 NO (no coverage claim existed to begin with - audited). Q12 YES (a user-reclassified entry loses its passive marker in `makeEntry()`, so `hasConfirmedEnergyClassification` treats it as confirmed - regression-tested). Q13 YES (raw entries/durations/provenance untouched; only interpretation). Q14 NO (0 new screens/prompts/confirmations/controls). Q15 NO (Review reconciliation not built). Q16 NO (generic Today gap prompt untouched). Q17 NO (no coarse-life estimates added). Q18 NO (Wife/Shared not started). Q19 NO (Personal Model/Advisor not started). Q20 NO (uncertain historical Focus data not modified).

Safety: candidate uncommitted, unstaged, unpushed, unmerged. No branch/worktree deletion, migration, production Firebase/Obsidian writes, Meal/Workout edits, or unrelated worktree/artifact changes.

## Phase 6G.2 — targeted fix for independent review findings · 2026-09-09
Same worktree/branch as above (`Time audit app - analytics-truth-fixes-v1`, `feat/analytics-truth-fixes-v1`). Re-fetched origin/main: still `9db74858a8da9c6f44a2a51e9c6cc26619cb8302`, unchanged from the base — no reconciliation needed. Candidate remains uncommitted. This is a targeted fix, not a broadened milestone: no new architecture, no confidence system, no schema migration, no user-confirmation workflow, no 6H work.

Independent review verdict: FIX FIRST, two blocker-level implementation misses plus one verification/report correction. All three addressed below.

REQUIRED FIX 1 — `attention-signals.js` PC-Time parity: `isUnconfirmedEnergyEntry()` reproduced the passive-observation (`browserUsage`/`phoneUsage`/`source`) and schedule-assumption (`scheduledAutoLog`/`captureMethod`) markers from `evidence-interpretation.js`, but omitted its third predicate, `isComputerSessionEntry()` (auto/quick-logged "PC Time"/"Screen Time" blocks). Result: a real auto-logged PC Time entry with `energy: 'deep'` could still classify `'focus'` in `classifyEntry()` and feed a coherent stretch, a refocus/recovery claim, and the attention interpretation layer — contradicting the milestone's own semantics. Fix: added the identical computer-session check (same activity-string/`autoLogged`/`quickLogged` markers `isComputerSessionEntry()` uses), inlined to preserve the file's intentional dependency-free design — no import added. Mirrored byte-identical to `www/attention-signals.js`.

REQUIRED FIX 2 — Today top-level stats: `computeStreak()` (`#s-streak`, "Deep streak days" — also feeds the Streaks widget and the Week view day badge, all via the one shared function) and `renderToday()`'s `deepCount` (`#s-deep`, "Deep blocks today") both summed/tested raw `entry.energy === 'deep'` with no confirmed-energy boundary, unlike the adjacent `computeDailySummary()`/`computeCloseoutSummary()` which already filter through `hasConfirmedEnergyClassification()`. Fix: both now filter through the same helper before counting/testing, using the established `typeof hasConfirmedEnergyClassification === 'function' ? arr.filter(...) : arr` guard pattern already used at the two prior call sites.

LOW FINDING (Section 10) — `buildWeekShareSummary()`: inspected as instructed. Confirmed ACTIVE and user-visible — the "Share week" button (`#week-share-btn` → `openWeekShare()`) generates exported/copied text with the same unsupported-behavioral-claim pattern ("Deep work: `X` (`Y`% of logged time)", "Best day: … `Z`h deep", "Weekly deep work goal hit"), all sourced from unfiltered energy. The correction is literally the same bounded `hasConfirmedEnergyClassification()` filter with no new semantics, so fixed in this candidate per the review's stated criterion: `deepMins`, `wasteMins`, per-category `categoryLines`, and the `bestDay` deep-hours figure (both the comparison and the display line) now use a confirmed-only entry set. `totalMins` ("Logged: `X`"), `topActivities` ("Where my time went") and `unloggedMins` are unchanged — those are presence/duration facts, not energy-classification claims, and filtering them was not requested. 2 new Playwright regressions added.

Attention-signals regression (Section 3): 5 new cases in `attention-signals.test.js` — auto-logged "PC Time" deep entry classifies neutral; quick-logged "Screen Time" deep entry classifies neutral; a PC-Time block adjacent to a real focus block does not extend the coherent stretch (stays 30 min, not 60); PC Time alone after a real break does not manufacture a recovery (`recoveries: 0`); positive control — a non-auto-logged deep entry (real manual/timer session) still counts as confirmed focus. `attention-signals.test.js`: 34/34 (was 29).

Today regressions (Section 6): 6 new Playwright cases in `tests/analytics-truth.spec.js`, asserting the actual rendered `#s-deep`/`#s-streak` DOM text (not just the underlying function) — scheduled-template-only deep (0/0), browser-passive-only deep (0/0), Android phone-passive-only deep (0/0), auto-PC-Time-only deep (0/0), one genuine confirmed manual/timer deep entry (1/1), and a mixed day with one confirmed entry plus two unconfirmed ones (1/1 — only the confirmed entry contributes). Plus 2 Week Share regressions (PC-Time+scheduled deep → 0 deep minutes and "Deep work: 0m" in the export text; one genuine confirmed deep entry → 60 deep minutes). `tests/analytics-truth.spec.js`: 13/13 (was 5).

Playwright discrepancy investigation (Section 8) — established per the "do not casually fix, reproduce first" instruction:
- The independent reviewer reported full Playwright 363/365 with 2 reproducible failures in `daily-routines-ui.spec.js`, unrelated files unchanged, `smoke.spec.js` 70/70.
- Candidate, `tests/daily-routines-ui.spec.js` in isolation, 3 consecutive runs: 14/14 passed every run.
- Candidate, full suite, 2 consecutive runs: 373/373 passed both times, 0 failures (373 = 365 the reviewer saw + 8 new cases added by this fix pass).
- Clean base comparison: used the already-registered `main` worktree (`Time audit app - hud-main-integrate`), verified `git status` clean and HEAD exactly at `9db74858a8da9c6f44a2a51e9c6cc26619cb8302` before and after. It had no `node_modules` (gitignored); rather than running `npm install` inside the authoritative main worktree, a temporary Windows directory junction to the candidate's `node_modules` was created (package.json dependency versions are unchanged between base and candidate — only npm script wiring differs, confirmed by `git diff package.json`), used for the read-only test runs, then removed immediately after — `git status --porcelain` on the main worktree confirmed clean before and after.
- Base, `tests/daily-routines-ui.spec.js` in isolation, 3 consecutive runs: 14/14 passed every run.
- Base, full suite, 1 run: 360/360 passed, 0 failures (360 = 373 candidate total minus the 13 `tests/analytics-truth.spec.js` cases that don't exist at the base commit).
- Total: 9 runs across candidate and base (5 candidate + 4 base), 0 failures anywhere. The reviewer's 2 `daily-routines-ui.spec.js` failures were not reproduced on either side.
- Determination: not classified as a confirmed candidate regression (the candidate never failed) and not classified as a confirmed pre-existing defect (the base never failed either). Recorded honestly as: not reproducible in 9/9 attempts under this environment; most likely environment- or timing-sensitive in whatever context the reviewer ran in (a real full-suite run elsewhere, different machine/load, or Playwright's default multi-worker parallelism producing a transient timing interaction not seen across these 9 serial single-file runs plus multi-worker full-suite runs). No daily-routines-ui.js, daily-routines-model.js, daily-routines-repository.js, or daily-routines-ui.spec.js file was touched — there was nothing reproducible to fix, and fixing an unreproduced failure would risk masking a real one later.
- `CHANGELOG.md`'s Phase 6G.2 entry corrected in place: the prior claim of a specific `smoke.spec.js:968` flake (not what was actually observed by the independent reviewer, and not the final reproducible evidence from this fix pass either) was removed and replaced with the paragraph above. `TEST_REPORT.md` is append-only per its header, so this is a new entry rather than an edit to the original Phase 6G.2 entry above.

Files changed in this fix pass: production — `attention-signals.js` + `www/attention-signals.js` (PC-Time predicate parity), `index.html` + `www/index.html` (`computeStreak()`, `renderToday()` `deepCount`, `buildWeekShareSummary()`). Tests — `attention-signals.test.js` (+5), `tests/analytics-truth.spec.js` (+8). Docs — `CHANGELOG.md` (Phase 6G.2 entry corrected in place), `TEST_REPORT.md` (this entry, appended). No other file touched.

Verification:
- `node --test attention-signals.test.js`: 34/34, 0 failed.
- `node --test evidence-interpretation.test.js`: 6/6, 0 failed (unchanged by this pass — re-run to confirm no regression).
- `npx playwright test tests/analytics-truth.spec.js`: 13/13, 0 failed.
- `node test.js`: 451/451, 0 failed — includes the `www/` byte-identical mirror check, which passed with the new mirrored files.
- `npm test`: exit 0, 27 suites, every suite `fail 0`.
- Full `npx playwright test`, 2 runs on candidate: 373/373 both times. 1 run on clean base: 360/360.
- `node scripts/runtime-mirror.mjs --check`: OK, 41-file closure, byte-identical (unchanged file count — no new runtime-loaded file was added, only existing ones edited).
- `npm run lint`: 0 errors, 29 warnings — identical count to the pre-fix baseline; zero warnings in either touched file.
- `node --check` on `attention-signals.js`, `www/attention-signals.js`, `attention-signals.test.js`, `tests/analytics-truth.spec.js`: all pass. (`index.html` has no standalone JS syntax checker; its script content is exercised by the full Playwright suite above.)
- `git diff --check`: clean.

Self-review (per the review's required questions):
1. Can auto PC Time still become confirmed focus in attention-signals? NO — `isUnconfirmedEnergyEntry()` now excludes it via the added computer-session check; regression-tested.
2. Can scheduled/passive/PC-Time deep entries increase Today's `#s-deep`? NO — `deepCount` now filters through `hasConfirmedEnergyClassification()`; regression-tested for all three marker types individually.
3. Can scheduled/passive/PC-Time-only days extend `#s-streak`? NO — `computeStreak()` now filters through the same helper per day; regression-tested.
4. Can genuine confirmed Focus/manual deep evidence still count? YES — positive-control regressions pass in both attention-signals and Today.
5. Did `hasConfirmedEnergyClassification()` semantics change? NO — `evidence-interpretation.js` itself is byte-unchanged in this fix pass; only its consumers were brought into parity with it.
6. Did raw observations change? NO — no entry field, storage shape, or provenance marker was added, removed, or renamed.
7. Did Wallet/Review/Insights semantics change beyond the prior approved candidate? NO — `focus-wallet.js`, and the `computeDailySummary()`/`computeCloseoutSummary()`/`insights.js` code from the original candidate, are untouched in this pass; re-run tests confirm no regression.
8. Was new architecture added? NO — no confidence system, classification framework, schema migration, or evidence service; both fixes reuse the exact filter pattern already established at the two prior call sites.
9. Was user burden increased? NO — no new prompt, field, screen, setting, confirmation, daily action, classification chore, or notification.
10. Were Playwright results reported exactly as observed? YES — see the discrepancy investigation above; the prior report's specific-flake claim was corrected rather than defended.
11. If daily-routines failures remain, were they compared against the clean base? YES (no failures remained to explain, but the comparison was still run as instructed — see above).
12. Was unrelated daily-routines behavior modified without candidate-regression proof? NO — no daily-routines file was touched.

Safety: candidate remains uncommitted, unstaged, unpushed, unmerged. No branch/worktree deletion, migration, production Firebase/Obsidian writes, Meal/Workout edits. The temporary `node_modules` junction created on the `main` worktree for the base comparison was removed before this entry was written; `git status --porcelain` on that worktree confirmed clean afterward.
