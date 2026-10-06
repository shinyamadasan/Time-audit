# Build Queue

> **Approved sprint input.** Claude's planning reads this and converts items into `TASKS.md`.
> Only the human approval gate writes here. Codex must NEVER read this file as an execution source.
> This remains the normal path for planned, backlog and Claude/Tech-Lead-created work. It is no longer
> a mandatory relay for a bounded task the owner explicitly instructs (`source: owner-direct` in
> `TASKS.md`; see CLAUDE.md § Owner-Direct Tasks). Anything the owner did not explicitly request still
> goes through here.

---

### BQ-001 — Owner-direct task governance
- source: explicit owner instruction, 2026-10-06 (the human approval gate; temporary bootstrap item — the old rule requires this relay to change the rule itself) · priority: P1 · approved: 2026-10-06 (owner, direct)
- build: docs-only governance change — an explicit owner instruction may authorize a bounded task directly (`source: owner-direct`) without a BUILD_QUEUE relay; agents still may never self-authorize work.
- detail: scope = CLAUDE.md, AGENTS.md, TASKS.md, planning/BUILD_QUEUE.md, WORKFLOW.md, AI-DEV-OS.md, SYSTEM-OVERVIEW.md, DECISIONS.md. No runtime code, tools/, deploy, push, or Firebase/production change.
