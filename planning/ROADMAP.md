# ChronaSense -- Roadmap

**The approved product backlog.** Vision/scope: [../docs/PROJECT.md](../docs/PROJECT.md).

## How work flows (gated pipeline)
**This file is protected -- only the Human Approval gate writes to it.**

```
captures/inbox -> Triage -> PROPOSALS.md -> (you approve) -> ROADMAP.md (here)
   -> Claude Plan -> (you approve the batch) -> BUILD_QUEUE.md -> Codex -> review -> merge
```

**Nothing is built without your approval.**

---

## Current Objective

_(still unset for the gated `captures -> PROPOSALS -> ROADMAP` pipeline below -- this remains a
human decision. Phase 6 through 11's actual feature work shipped through a separate, ungated
Phase-branch track instead; see `CHANGELOG.md` and `APP_CONTEXT.md`'s "Two Parallel Tracks"
section for how the two relate. The sequence below is that Phase-branch track's own forward plan,
reconciled against live repo evidence as of 2026-09-04 -- it is not itself an approved-proposal
Current Objective.)_

### Reconciled phase sequence (from Phase 11.5, order corrected in Phase 11.5 review-fix)

- Phase 11.5 -- Context Reconciliation + Product Boundary (this phase; done 2026-09-04).
- Phase 11.6 -- Core-loop Bug Cleanup (integrated to main 2026-09-04, commits `f3887db` +
  `dbbbc31`). Fixed the confirmed-live `triggerPenaltyMode()` `ReferenceError` (`insights.js:248`),
  plus two other confirmed core-loop bugs found during live reconciliation (timer restore dropping
  `blockStartTime`; Focus Wallet's "sport" substring matching "transport"). See `CHANGELOG.md`.
- Phase 11.7 -- Bloat Consolidation / UX Simplification (integrated and complete; reviewed and
  merged to main as `b1b0fa0`, 2026-09-05). Two high-confidence changes:
  (1) removed **identity level** (a hidden-since-July stat tile whose only input was the deep-block
  count already shown beside it; no unique behavioral value, no persisted data); (2) consolidated
  the **two decision records** -- root `DECISIONS.md` is now the single canonical log,
  `docs/DECISIONS.md` D-002/D-003/D-004 migrated into it as entries 23/24/25 (ids kept as aliases),
  `docs/DECISIONS.md` reduced to a pointer stub. Awareness Signal, streaks, Focus Wallet,
  penalty/escalation (FREEZE, audited as already quiet), Focus Mode, and all review surfaces
  unchanged. Everything else audited and deferred -- see below.
- Phase 11.8 -- Minimal Distraction Signals (integrated and complete; independently reviewed
  and merged to main as `bc552ca`, with the review fix `254ab57` -- current HEAD -- 2026-09-05).
  Adds `attention-signals.js` -- a pure deterministic `deriveAttentionSignals()` over the existing
  `entries` array -- and surfaces longest coherent focus stretch, meaningful attention breaks,
  likely distraction (`~N min`), and recoveries inside the existing end-of-day review only. One
  optional `reviews[].focusRating` self-rating (Focused / Mixed / Distracted). No new collector,
  tab, dashboard, score, daemon, blocker, Firebase subsystem, or Life Ledger coupling. Related
  work-tool switching is not treated as distraction.
- Phase 12.0A -- static root<->www parity + safe tooling (integrated to main, `922297d`,
  2026-09-06). See `docs/PHASE12_PERSONAL_INTELLIGENCE.md` and `CHANGELOG.md`.
- **Independent feature-branch track, 2026-09-09 through 2026-09-16 (NOT part of Phase 12):**
  47 further commits landed on `main` after Phase 12.0A, none touching Phase 12 code --
  Coarse Life Evidence V1 + Durability V1, Phase 6I/J Review Reconciliation, Plan Linkage +
  Up Next Ordering V1, Onboarding Rewrite V1, Motivation Pressure Cleanup V1, Shared Access
  Hardening V1, Time Truth V1 + Timeline Truth Follow-up V1, Wife/Shared Accountability V1,
  Scheduled Auto-Log Reliability V1, Partner View V1 + mobile navigation, Today Persistent
  Sections V1, Plan Tomorrow Quick Time V1, Daily Reconciliation V1, Tomorrow View V1, Plan
  Time Range V1, Tomorrow Timeline Preview V1, and Personal Day Boundary Foundation +
  Persistence/Operational Plan Authority V1. Full detail and commit SHAs: `CHANGELOG.md` and
  `STATUS.md`'s 2026-09-16 entry. This is the same kind of separate, ungated Phase-branch
  track the "Current Objective" preamble above already describes for Phase 6-11.
- Phase 12.0B -- Android runtime compatibility + offline cold start safety. **Still the next
  Phase-12-specific step. NOT started.** A stale local-only branch
  `fix/phase12-0b-android-runtime` (tip `a146565`, far behind current `main`) exists as an
  unfinished, unmerged reference implementation only -- not suitable for direct integration;
  rebuild against current `main` rather than rebasing it.
- Phase 12.1-12.4 -- deterministic Personal Intelligence engine (extends Cross-Domain
  Intelligence; one primary next action or explicit INSUFFICIENT_DATA; read-only advisory).
  NOT built. Sequence confirmed still current against `docs/PHASE12_PERSONAL_INTELLIGENCE.md`
  §18-19 as of 2026-09-16.
- Phase 12.5 -- Claude phrase-only interpretation layer, after its own security precondition
  (see `docs/PHASE12_PERSONAL_INTELLIGENCE.md` §12). NOT built.

---

## Approved Backlog

*(empty -- approve a proposal in `PROPOSALS.md` to populate this. The reconciled phase sequence
above tracks the separate, already-running Phase-branch track and is recorded here for
visibility, not as an approval.)*

---

## Ideas (parked -- never auto-built)

*(none)*

---

## Known Issues & Debt

### Deferred from Phase 11.7 (audited, not actioned -- kept scope to high-confidence changes)

- **Gated-pipeline dormant layers.** `PLAN.md`, `planning/BUILD_QUEUE.md`, `planning/DONE.md`,
  `planning/CODEX_READY.md`, `planning/DIGEST.md`, `HANDOFF.md`, and `TASKS.md` describe a
  captures -> PROPOSALS -> ROADMAP -> BUILD_QUEUE -> TASKS -> Codex pipeline that has been dormant
  since 2026-07-20 (real work ships via Phase branches). Retiring them is blocked on the fact that
  six `tools/*.ps1` scripts read/write them -- an AI-Dev-OS (`tools/` red-zone) task. The intended
  single workflow after cleanup: idea in `planning/PROPOSALS.md` -> accepted into this roadmap's
  phase sequence -> built on a `feat/`|`refactor/` branch -> `CHANGELOG.md` on integration.
- **`tools/Verify-Decisions.ps1` + `tools/Check-DocsConsistency.ps1` still hardcode
  `docs/DECISIONS.md`.** They keep working against the Phase 11.7 pointer stub (Verify finds no
  pointers -> pass; Check-Docs drift went 10 -> 8 items, all pre-existing in `CLAUDE.md` /
  `docs/ARCHITECTURE.md`). Rewire to the root `DECISIONS.md` in a dedicated `tools/` task; also
  consider adding root `DECISIONS.md` to `Check-DocsConsistency.ps1`'s scan scope.
- **Dead prototype files** `ai_studio_code (1) - Copy.html` (~97 KB) and `ai_studio_code (1)
  copy.html` (~150 KB), plus `New Text Document.txt` (empty). Confirmed dead; deletion is pure
  repo hygiene, out of Phase 11.7's conceptual/UI scope.
- **`www/` mirror is only partially synced at HEAD.** `www/style.css`, `www/focus-mode.js`,
  `www/eslint.config.js`, and `www/test.js` differ from root by more than line endings (prior
  phases synced only the files they touched). `www/index.html` is in parity. Not widened here.
- **Settings section titled "Identity"** contains only "Coach tone" -- a stale label; rename to
  "Coaching" in a future labels pass.
- **`README.md` still lists a removed feature.** Its feature list contains the bullet
  "Identity level based on deep work percentage", but Identity Level was removed in Phase 11.7.
  The README correction is deferred because `README.md` is protected (no edits) during this phase.
  Future housekeeping should remove or update that stale feature bullet.
- **Adjacent Personal-OS modules** (Learn, Career, Life = Character Sheet / Life Feed /
  Cross-Domain Intelligence): all KEEP -- each has a nav entry, a model with tests, and a
  Playwright spec; none abandoned. Life Feed and Cross-Domain Intelligence remain the strongest
  "eventually relocate" candidates (per `APP_CONTEXT.md`) but are already behind the Life tab's
  subnav, not top-level, so no prominence change was warranted now.

---

## Do Not Work On

- Team / manager / surveillance features -- ChronaSense is private, personal time.
- Billing / invoicing / client-hours tracking.
- Introducing a framework or build step.
