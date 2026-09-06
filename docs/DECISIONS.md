# DECISIONS — moved

> **This file is no longer the decision log.** The canonical, single decision log is the root
> [`../DECISIONS.md`](../DECISIONS.md). Record all new decisions there.

## Why this file still exists

Phase 11.5 found two parallel decision records; Phase 11.7 consolidated them into the root
`DECISIONS.md`. This stub is retained (not deleted) because some automation still reads this
exact path:

- `tools/Verify-Decisions.ps1` — runs `Verify:` pointer checks found in this file
- `tools/Check-DocsConsistency.ps1` — scans this file for stale identifier references
- `tools/Apply-Decisions.ps1` — unrelated (operates on `captures/decisions/`), listed for completeness

Rewiring those scripts to the root file is deferred to a dedicated AI-Dev-OS task (they touch the
`tools/` red zone). Until then: this file may carry `Verify:` DSL lines for automated decision
checks, but the prose of every decision lives in the root log.

## Migrated entries

| Was | Now |
|---|---|
| D-001 — "No framework, no build step" (was an unfilled placeholder, never written) | Root `DECISIONS.md` entry **1** — "Single-file SPA — no build step" (the real decision) |
| `D-002` — Per-task scope note soft-gate | Root `DECISIONS.md` entry **23** (alias D-002) |
| `D-003` — Capability/Career evidence is explicit interpretation | Root `DECISIONS.md` entry **24** (alias D-003) |
| `D-004` — Career intelligence V1 uses deterministic rules | Root `DECISIONS.md` entry **25** (alias D-004) |

No decision content was lost in the move — entries 23–25 reproduce D-002/D-003/D-004 verbatim.
