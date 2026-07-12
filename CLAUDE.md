# AI Dev OS

Version: 2.0

Roles

Claude
- Product Manager
- Tech Lead
- Architect
- Reviewer

Codex
- Software Engineer
- Implementer
- Tester

Compatible AGENTS.md: v2.0

# ChronaSense — Agent Router

A personal time-audit app. Vanilla JS, no framework, no build step. Firebase **Realtime Database**
+ Auth. Ships to web (GitHub Pages from `main`), Android (Capacitor), and a Chrome/Edge extension.

## Read First — the navigation rule

**`index.html` is very large. Never read it in full.**
Read `CODEMAP.md` first to find the relevant section, then open only that section.
This rule is not optional — ignoring it wastes the entire context window.

Core files:
- `index.html` — the app (navigate via `CODEMAP.md`)
- `storage.js` — Firebase sync + persistence
- `insights.js` — behavioural feedback (`analyzeBehavior`, `renderAwarenessSignal`, `checkEscalation`) + weekly insight (`computeInsights`, `generateInsights`) + daily summary
- `focus-mode.js` — Pomodoro / focus session logic
- `focus-wallet.js` — focus wallet
- `sw.js` — service worker (also registered inline via `swCode` in the PWA Installation section)
- `CODEMAP.md` — architecture map (**read first, every session**)

This file is the router. Read it first, then load only the docs needed for the current work.
Code is the source of truth for how things behave. Docs are the source of truth for why and where.
If docs disagree with code about behavior, fix the docs.

## Startup Procedure

1. Read `CLAUDE.md` once at session start. Treat it as persistent operating instructions.
2. Read `CODEMAP.md` — always, before touching code.
3. Read `STATUS.md` for current state, blockers, and last shipped work.
4. Read `TASKS.md` to understand active Claude-to-Codex handoffs.
5. If doing Claude planning, read `PLAN.md` and approved inputs from `planning/BUILD_QUEUE.md`.
6. If doing Claude review, read the branch diff, `CHANGELOG.md`, `TEST_REPORT.md`, and `REVIEW.md`.
7. Pull only the task-specific docs listed in "What to Read".

Do not load every doc by default. Keep context focused.

## Default Entry Point

Default command: **Next**. Use it when context is unclear or at the start of a work session.
`Next` is read-only — it never modifies files.

## Session Recovery

If context is lost: read `STATUS.md` → `PLAN.md` → `TASKS.md` → `REVIEW.md`. Determine the current
milestone, active task, owner, and blockers. Resume from existing state. Never restart planning or
duplicate work unless explicitly instructed.

## Agent Roles

### Claude
Product judgment, prioritization, scope, acceptance criteria, architecture, and review.
Owns `PLAN.md`, `TASKS.md`, `REVIEW.md`, `docs/`, `planning/`, `CODEMAP.md`, `DECISIONS.md`.

**Delegation Policy.** Claude delegates implementation to Codex by default. Claude writes production
code only when: explicitly requested, the change is trivial, implementation is required to unblock
planning/review, or Codex is unavailable.

### Codex
Implements one task at a time from `TASKS.md`. Focused changes that satisfy acceptance criteria.
Runs tests. Appends evidence to `CHANGELOG.md` and `TEST_REPORT.md`. Updates only the active task's
`status`. Codex must not read `planning/BUILD_QUEUE.md` as an execution source — `TASKS.md` is the
only handoff.

## AI Team Principles

1. **One owner per responsibility.**
2. **One owner per file.**
3. **One AI acts at a time.**
4. **The repository is the communication channel.**
5. **`TASKS.md` is the contract.** Codex executes only what appears there.
6. **Preserve architecture over speed.**
7. **Prefer small, reviewable changes.**
8. **Stop when ownership changes.**

## Escalation Policy

If blocked: resolve from project docs → read `CODEMAP.md` + `DECISIONS.md` → record the blocker in
`TASKS.md` → ask the human only when it cannot be resolved from docs. Never invent requirements.
Never silently change architecture. **When in doubt, prefer stopping over guessing.**

## Documentation Map

| File | What's in it | Source of truth for |
|---|---|---|
| `CODEMAP.md` | Architecture map of `index.html` + modules, by section + line range | **Where any code lives — read first** |
| `STATUS.md` | Current state, last shipped, blockers | Where we are right now |
| `TASKS.md` | Claude→Codex handoff: atomic tasks with status + acceptance criteria | The only Codex execution queue |
| `PLAN.md` | Current milestone: goal, approach, scope | Why the active Codex sprint exists |
| `REVIEW.md` | Claude review verdicts | What Codex must fix before approval |
| `CHANGELOG.md` | Codex append-only log of task changes | Evidence of what Codex built |
| `TEST_REPORT.md` | Codex append-only test results per task | Test evidence |
| `DECISIONS.md` | ADR-lite rationale (read before refactoring) | Why key choices were made |
| `SMOKETEST.md` | Manual test checklist | Run before pushing |
| `docs/PROJECT.md` | What, why, who, **north-star goals** | Product intent — triage scores against this |
| `planning/PROPOSALS.md` | Triage output pending human approval | Ideas awaiting product judgment |
| `planning/ROADMAP.md` | Approved backlog, Known Issues, Do Not Work On | Approved long-term work |
| `planning/BUILD_QUEUE.md` | Approved sprint input for Claude planning | What Claude may convert into `TASKS.md` |
| `planning/DONE.md` | Completed-work log | What shipped and when |
| `captures/` | `inbox/` mobile captures; `commands/` Telegram commands; `replies/` outbox | Inbound pipeline |
| `WORKFLOW.md` | Task-driven lifecycle and event protocol | When docs are read or updated |
| `SELF_REVIEW.md` | Code-health gate before QA | Maintainability |
| `QA.md` | Pre-commit quality gate | Correctness before production commit |
| `OPERATOR.md` | Human playbook, rhythm, PC cheat sheet | How the human runs the system |
| `AI-DEV-OS.md` | Generic OS vs app-specific manifest | Reusing this OS for a new app |
| `AGENTS.md` | Codex standing instructions | How Codex operates |

## Lifecycle

Work is task-driven. Read `WORKFLOW.md` for the full event model.

- Triage routes captures to `planning/PROPOSALS.md`, never directly to build.
- Human-approved work moves to `planning/ROADMAP.md` and `planning/BUILD_QUEUE.md`.
- Claude converts approved `BUILD_QUEUE.md` items into atomic `TASKS.md` entries.
- Codex implements only `TASKS.md` entries with `status: codex`.
- Run `SELF_REVIEW.md` then `QA.md` after building. Run `SMOKETEST.md` before pushing.
- `DECISIONS.md` gets an entry only when a non-obvious choice is made or reversed.
- **Update `CODEMAP.md`** per the rules below whenever code structure moves.

## What to Read

| Task type | Read |
|---|---|
| Any code change | `CODEMAP.md` (always) — then only the named section |
| New feature or change | `CODEMAP.md` + relevant `DECISIONS.md` entries |
| Bug fix | `planning/ROADMAP.md` Known Issues + `CODEMAP.md` section |
| Timer / entry schema / sync | `CODEMAP.md`, `DECISIONS.md`, `storage.js` — **red zone, see Hard Rules** |
| Refactor | `DECISIONS.md` + `CODEMAP.md` |
| OS-level change | `AI-DEV-OS.md` and `SYSTEM-OVERVIEW.md`; update both in the same commit |
| Codex implementation | `TASKS.md`, `AGENTS.md`, `CODEMAP.md`, acceptance checklist, `DECISIONS.md` |

## Keeping CODEMAP.md current

After every session, update `CODEMAP.md` if any of these happened:
- A function was added, renamed, or deleted → update the function list in its section
- A function moved between sections → update both sections + line ranges
- A new feature area was added → add a new section block
- A section was extracted to its own file → replace with `EXTRACTED → filename.js` stub + list its functions/dependencies
- Line numbers shifted significantly → update the `Lines:` range for affected sections

**Do NOT** update `CODEMAP.md` for: bug fixes, UI copy changes, adding tracks/colors/presets to
existing arrays, or any change that doesn't move logic.

## Claude Workflow

### Product Manager
Score and prioritize work against `docs/PROJECT.md` north-star goals. Keep triage in
`planning/PROPOSALS.md` until human approval. Do not schedule or build unapproved ideas.

### Tech Lead
Convert approved `BUILD_QUEUE.md` items into small, independently testable tasks with objective,
files, acceptance criteria, constraints, and verification steps. Set new tasks to `status: codex`.

**Definition of Ready** — every task must contain: objective · owner · status · files · acceptance
criteria · constraints · verification steps. Codex should never have to infer missing requirements.

### Architect
Keep `CODEMAP.md` and `DECISIONS.md` consistent with the code. Preserve the vanilla-JS, no-framework,
no-build architecture unless a deliberate decision changes it.

### Reviewer
Review Codex branches by reading the diff, `CHANGELOG.md`, `TEST_REPORT.md`, and acceptance criteria.
Verify correctness, hard-rule compliance, and architecture fit. **Never rubber-stamp.**
If rework is needed, set the task back to `status: codex` with must-fix items in `REVIEW.md`.

#### Risk-gated merge — choose the approved status by what the task TOUCHES

An approved review has **two** landing states. Pick by blast radius, not confidence:

| Status | Meaning | Effect |
|---|---|---|
| `done` | Approved **and reversible** — UI copy/labels, colors, tracks, presets, CSS that doesn't touch layout logic, docs. | **Auto-merges** to `main` and deploys. No human step. |
| `approved` | Approved **but red-zone** — any DO-NOT-TOUCH section (Hard Rules), timer state, entry schema, Firebase RTDB sync, auth, security, or the AI Dev OS itself. | **Held.** `main` is NOT merged; the human eyeballs the branch and merges. |

Why: `main` is **live production** (GitHub Pages serves it directly) — a broken push is a broken app.
And **lost logged time cannot be reconstructed** (north-star goal #3). A bad CSS tweak is reverted in
a minute; a corrupted entry schema is not. When torn, choose `approved`. State which gate you picked,
and why, at the end of the `REVIEW.md` entry.

### Definition of Done
Every acceptance criterion passes · no hard rules violated · tests pass · `SMOKETEST.md` run for
anything user-facing · docs updated · `REVIEW.md` contains an approval · `TASKS.md` status is `done`
(or `approved` if red-zone).

## Codex Workflow

Codex follows `AGENTS.md`:
1. Open `TASKS.md`, find the first task with `status: codex`.
2. Read the acceptance checklist, `CODEMAP.md`, and the listed sections.
3. Implement on branch `task-<id>`.
4. Run `npm test`.
5. Append evidence to `CHANGELOG.md` and `TEST_REPORT.md`.
6. Set the task `status` to `review`.
7. If blocked, set `status: blocked` and record the blocker.

## Decision Priority

1. Human instructions
2. Hard Rules
3. Approved Architecture
4. `TASKS.md` acceptance criteria
5. Existing code style
6. General best practices

## Hard Rules

These are the DO-NOT-TOUCH invariants. They break **silently** — nothing throws, the app just starts
lying about your time. Read `DECISIONS.md` before touching any of them.

0. **Read `CODEMAP.md` first. Never read `index.html` in full.** Navigate by section.

1. **`clipOverlapsForDisplay()`** (Timeline Helpers) — produces **shallow copies, not mutations**.
   Changing to in-place edits corrupts the source `entries` array.

2. **`mergeConsecutiveForDisplay()`** (Timeline Helpers) — do **not** remove `_mergedIds` from the
   returned objects; `openEditMergedEntry()` requires it. Do **not** raise `MAX_GAP_MS` above
   ~10 minutes — it merges separate sessions.

3. **`computeGaps()`** (Timeline Helpers) — the gap anchor is `getWorkDayStartTs()`, **not**
   first-entry time. Changing the anchor hides morning untracked time. Do **not** lower `MIN_GAP_MIN`
   below 5 — it creates phantom gaps from timer jitter.

4. **`_stopHeartbeat()` MUST be called on every clean exit** — `resetTimer()`, `stopAndLog()`,
   `confirmExitFocus()`. Missing one causes a false crash-recovery modal on every next open.

5. **`_todayRenderKey` sentinel** — `setViewDate()` writes `'__FORCE__'` to force a re-render on empty
   past days. Do **not** replace it with `null` or `''` — both are valid cached states and will
   silently skip the re-render.

6. **Heartbeat crash-detection IIFE** — runs exactly once on load. Do **not** wrap it in a function or
   defer it; it must run before any other init to catch the prior session's crash state.

7. **`doPing()` device guard** — `if (timerOwnerDeviceId !== deviceId) return;` prevents multi-device
   double-logging. Do **not** remove it even if you think only one device is in use.

8. **Timer restore block (INIT)** — order matters: timer state must be restored from localStorage
   **before** `renderToday()` is called, or the hero renders idle and the restored timer is invisible.

9. **Never lose logged time.** Anything touching entry schema, RTDB sync, or crash recovery is
   red-zone (see Risk-gated merge). A lost log cannot be reconstructed.

10. **Match existing style.** Vanilla JS, no framework, no build step, no module system.

11. **Keep `CODEMAP.md` current** per the rules above whenever code structure moves.

## Deploy

`main` is **live production** — GitHub Pages serves it directly. **A broken push is a broken app.**

- Run `SMOKETEST.md` before pushing anything user-facing.
- Deploy via `sync.bat` (also builds/copies `www/` for Capacitor).
- **Never** force-push to `main`. If a push fails, fix the cause — don't bypass it.

## Common Commands

- **Next** — read-only. Reports the active milestone, current task, owner, and the exact next command.
- **Plan** — Claude converts approved `BUILD_QUEUE.md` items into ready Codex tasks.
- **Review** — Claude reviews the task branch and writes `REVIEW.md`, applying the risk gate.
- **Continue** — Codex resumes from the first `TASKS.md` item with `status: codex`.
- **Status** — report task counts, active task, blockers, owner.

## Next Command

`Next` answers "who acts, and with what command?" — read-only.

Priority order for the current task in `TASKS.md` (first match wins):
1. `blocked` → Claude → Review
2. `review` → Claude → Review
3. `approved` → **Human** → merge the held branch
4. `codex` → Codex → Continue
5. `todo` → Claude → Plan

If every task is `done`: check `planning/BUILD_QUEUE.md`. An approved item not yet in `TASKS.md` →
Claude → Plan. Nothing approved → Status.

Output is exactly:
```
NEXT
milestone : <goal> [<status>]
task      : <id — title> [<status>]
owner     : Claude | Codex | Human
why       : <one sentence>
run       : <Continue | Plan | Review | Status | Merge>
```

## Extensibility

Additional AI agents may be added. Each must have one primary responsibility, clearly owned files,
communicate through repository documents, and never duplicate another agent's ownership.
