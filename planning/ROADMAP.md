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
- Phase 11.6 -- Core-loop Bug Cleanup (built, NOT integrated; 2026-09-04, branch
  `fix/core-loop-bugs-v1`, awaiting independent review). Fixed the confirmed-live
  `triggerPenaltyMode()` `ReferenceError` (`insights.js:248`; see `APP_CONTEXT.md` Known Live
  Bugs), plus two other confirmed core-loop bugs found during live reconciliation (timer restore
  dropping `blockStartTime`; Focus Wallet's "sport" substring matching "transport"). See
  `CHANGELOG.md` for full detail.
- Phase 11.7 -- Bloat Consolidation / UX Simplification. Concrete candidates already identified:
  the identity-level vs. Awareness Signal overlap, the two-DECISIONS.md duplication
  (`docs/DECISIONS.md` -- one placeholder entry, D-001, plus three real filled decisions,
  D-002/D-003/D-004 -- vs. root `DECISIONS.md`), and whether to resume or retire the stalled
  gated pipeline (`PROPOSALS.md`/`BUILD_QUEUE.md`/`TASKS.md`/`HANDOFF.md`).
- Phase 11.8 -- Minimal Distraction Signals. Scope-limited to derived metrics on existing
  screens (attention switches today, longest uninterrupted focus stretch) surfaced on the
  Awareness Signal / Reflect view. Explicitly excludes a new tab, dashboard, tracking engine,
  OS-level daemon, leaderboard, blocker, Firebase subsystem, or Life Ledger coupling.
- Phase 12 -- Personal Intelligence v1.

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

*(none recorded yet)*

---

## Do Not Work On

- Team / manager / surveillance features -- ChronaSense is private, personal time.
- Billing / invoicing / client-hours tracking.
- Introducing a framework or build step.
