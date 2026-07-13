# AI Dev OS â€” Template & App-Creation System

> The reusable operating system this app runs on. Everything listed as **generic** is product-agnostic:
> clone it to start a new app, fill in the app-specific files, and you inherit the whole pipeline:
>
> **Capture â†’ Plan â†’ PRD â†’ Build â†’ Guardian Gauntlet â†’ Document â†’ Commit â†’ Deploy â†’ Human Review.**
>
> Two checklists gate every commit â€” **Self Review** (`SELF_REVIEW.md`, "is it good code?") and
> **QA** (`QA.md`, "does it work?"). AI-verifiable checks block commits; human-only checks are logged,
> never faked. (DECISIONS D-009, D-011, D-012, D-014, D-015.)
>
> See `SYSTEM-OVERVIEW.md` for a plain-language explanation of how all the pieces fit together.

**Version: v1.10 â€” updated 2026-07-11.** The PC now **sleeps by default and wakes to work** (D-033).
The Command Dispatcher runs on a `WakeToRun` timer every 30 min: send `/go` from anywhere, the sleeping
machine wakes, drains the queued command (build â†’ review â†’ merge â†’ deploy), and idles back to sleep.
The overnight run now **sleeps** the PC instead of `shutdown /s` â€” a powered-OFF machine cannot be woken
by a timer, which previously stranded every remote command. The dispatcher holds `ES_SYSTEM_REQUIRED`
while working so a 10â€“15 min Codex build is never suspended mid-flight. v1.9 made auto-merge
**risk-gated** (D-032). An approved review
has two landing states, chosen by blast radius: `done` = approved **and reversible** (UI, CSS, copy,
additive non-data features) â†’ auto-merges and deploys; `approved` = approved **but red-zone**
(the data/sync/storage layer, auth, security, and the AI Dev OS itself
write-guard, auth, security, or the AI Dev OS itself) â†’ **held**, `main` is not merged and the human
merges after a glance. Rationale: a broken UI change is reverted in a minute, but **lost user data
cannot be reverted at all** â€” proven by D-030's `merge:true` regression, which auto-shipped and made
imported data vanish. When torn, the reviewer chooses `approved`. v1.8 introduced the auto-merge
itself: after Claude sets a task to `done`, `tools/Run-Claude-Review.ps1` runs `npm test` on the
reviewed task branch, verifies `main` can fast-forward to it, fast-forwards `main`, and pushes
`origin/main` (D-027). v1.7 made
`/go` a **mission autopilot** (D-026): one Telegram command drives planâ†’buildâ†’reviewâ†’merge to a
verdict and returns an aggregate summary, keeping the Claude/Codex split fully intact internally but
invisible from Telegram. One `/go` = one mission â€” plan if needed, build the single highest-priority
dependency-satisfied task (priority = P1â†’P2â†’P3 file order, which planning maintains), auto-review it,
auto-merge it if approved, and report. Rework auto-blocks with an `auto:` strike note (retries until
3/3), and a task whose dependency isn't merged is parked "waiting on merge"; both share one mechanism
and carry their state in the task's own blocker note (no side file). It's a thin orchestration layer
over the phase runners, so every preflight/guard is preserved by construction. Budget: 30 min or 10
AI actions. v1.6 made `/build` run Codex CLI for real â€”
`codex exec -C <root> --sandbox workspace-write "Continue"`, unattended, with its own `codex`-on-PATH
Preflight check, result classification (review/blocked/failure/no-work), and an automatic chain into
`/review` when a task reaches `status: review` â€” superseding v1.5's "stage a branch and ask a human to
open Codex" fallback, now that headless execution is verified working (D-025). v1.5 added Telegram
remote control â€” `/status /next /go /run /build /review /stop /enable /disable`, dispatched via a new
30-min `-WakeToRun` "ChronaSense Command Dispatcher" Scheduled Task (D-033: the PC sleeps and wakes to drain) reading
`captures/commands/` and replying through `captures/replies/OUTBOX.md`; `/build`/`/review` run on
isolated `task-<id>` branches with their own commit-scope guards and never touch/merge `main` (D-024).
v1.4 added Sprint Execution Mode â€”
risk-gated task chaining (`Risk: Low/Medium/High`, `Execution: Chained/Solo`) with semantic
`checkpoint:` review boundaries and partial-sprint continuation on blocked tasks (D-023). v1.3 added
overnight automation gated behind `$AUTOMATION_ENABLED`, never building app code (D-022). v1.2 added
the `Next` command â€” read-only default entry point for both Claude and Codex sessions (D-021). v1.1
added agents + skills workforce, `library/requirements/` PRD layer, Guardian Gauntlet, gated pipeline
(D-015), 2026-06-29. v1.0 locked 2026-06-25.

> **Living document rule:** Update this file and `SYSTEM-OVERVIEW.md` in the same commit whenever OS-level infrastructure changes â€” new agents, new workflow events, pipeline changes, or new hard rules.

---

## The Pipeline

```
Telegram capture
    â†’ Triage (scores against North-star goals)
    â†’ PROPOSALS.md (pending human approval)
    â†’ [human approves via Telegram reply] â†’ BUILD_QUEUE.md (deterministic: Apply-Decisions.ps1)
    â†’ Claude converts approved items â†’ PLAN.md + TASKS.md (status: codex)
      -- gated behind $AUTOMATION_ENABLED in run-claude.ps1 (default OFF); same conversion also
         available interactively via the "Plan" command. Claude never builds app code in this step.
    â†’ Telegram notified (CODEX_READY.md, sent only when a status: codex task exists)
    â†’ [human runs Codex locally, says "Continue" -- OR sends /build or /go from Telegram, which runs
       Codex CLI unattended on a task-<id> branch (codex exec ... "Continue") and auto-chains into
       Review if it reaches status: review] â†’ Codex implements from TASKS.md
    â†’ Review (Claude, automatically after a successful /build, interactively, or via /review from
       Telegram) â†’ auto-merge after approval/test/fast-forward gates
    â†’ docs/ + DONE + DECISIONS updated
```

Telegram also doubles as a remote control panel â€” `/status /next /go /run /build /review /stop
/enable /disable` (plus `/log`). **`/go` is the everyday driver: a mission autopilot that runs the
whole planâ†’buildâ†’reviewâ†’merge span above for one task per press and returns a single summary**
(D-026/D-027), so
the pipeline's internal handoffs are invisible from Telegram; the other commands force a specific
phase for power-user/debug use. See DECISIONS D-024/D-025/D-026/D-027 and `docs/09-automation.md`.

> **Note:** this supersedes the older `library-guardian` PRD â†’ `thanos-gauntlet-glove` multi-agent
> build path described in `SYSTEM-OVERVIEW.md`'s Layer 6 for day-to-day `BUILD_QUEUE.md` work â€” that
> path predates the Claude/Codex split and hasn't been reconciled with it yet (flagged in D-022, not
> fixed there). `TASKS.md` + Codex is the current path for build-queue items; see `docs/09-automation.md`.

---

## Generic â€” the OS (clone as-is into a new app)

### Process files
| File / folder | Role | Per-app change |
|---|---|---|
| `CLAUDE.md` | Router: doc map + read/update protocol + hard rules | Replace the project summary + hard rules |
| `WORKFLOW.md` | Task-driven lifecycle (Triage + 7 events) | none |
| `SELF_REVIEW.md` | Code-health gate ("would I ship this?") | tweak the "existing patterns" line |
| `QA.md` | Correctness gate | swap the `[app]`-tagged checks |
| `PROMPTS.md` | Engineering (P1â€“P10) + Product (PP1â€“PP7) reusable prompts | none |
| `OPERATOR.md` | Human playbook (principles + rhythm) | none |
| `GUIDE.md` | Phone capture card | none |
| `AI-DEV-OS.md` | This file â€” OS manifest + bootstrap guide | none |
| `SYSTEM-OVERVIEW.md` | Plain-language system explainer | none |

### Automation files
| File / folder | Role | Per-app change |
|---|---|---|
| `run-claude.ps1` Â· `setup-task-scheduler.ps1` | Scheduled autonomous runs â€” gated by `$AUTOMATION_ENABLED` (default off) at the top of `run-claude.ps1` | set project path; flip the flag once validated |
| `n8n-telegram-inbox.json` | Mobile capture workflow + Telegram control-command recognition | set repo, bot token, user id |
| `n8n-telegram-digest.json` | Morning digest + Codex-ready notification | set repo, bot token, user id |
| `n8n-telegram-replies.json` | Fast (~2 min) relay of `captures/replies/OUTBOX.md` to Telegram | set repo, bot token, user id |
| `tools/Generate-Digest.ps1` Â· `tools/Generate-Codex-Notice.ps1` | Deterministic PROPOSALSâ†’DIGEST and TASKSâ†’CODEX_READY generators (no LLM) | none |
| `tools/Dispatch-Commands.ps1` Â· `setup-command-dispatcher-scheduler.ps1` | Telegram command router â€” gated by the same `$AUTOMATION_ENABLED`-style checks, 30-min `-WakeToRun` Scheduled Task so a sleeping PC still drains queued commands (D-033) | set project path |
| `tools/Run-Codex-Build.ps1` Â· `tools/Run-Claude-Review.ps1` | `/build` (runs `codex exec` unattended, auto-chains into review) and `/review` phase runners â€” isolated `task-<id>` branches, own commit-scope guards, approved review fast-forwards `main` | none |

### Scaffold folders (start empty)
| Folder | Role |
|---|---|
| `captures/` (inbox Â· processed Â· README) | Capture pipeline scaffold |
| `planning/` (ROADMAP Â· TASK Â· DONE Â· PROPOSALS Â· BUILD_QUEUE) | Strategy/tactics scaffold |
| `STATUS.md` | Working-memory scaffold |
| `docs/DECISIONS.md` | ADR-lite scaffold â€” keep D-001 (no-framework) if it applies |

### Build workforce (the agents + skills)
| Folder | Role | Per-app change |
|---|---|---|
| `.claude/agents/` | Specialist sub-agents â€” each owns a domain | Swap agents for your stack's domains |
| `.claude/skills/` | Deep playbooks each agent wields (guides, research, templates) | Swap skills to match your agents |

**Standard agent roster for a JS/TS web app:**

| Agent | Domain |
|---|---|
| `library-guardian` | PRD + IRD authorship |
| `thanos-gauntlet-glove` | PRD execution orchestrator (skill-only, no agent) |
| `security-guardian` | Security audit after every build |
| `quality-guardian` | AC verification against PRD after every build |
| `auth-guardian` | Authentication implementation |
| `db-guardian` | Database schema + queries |
| `ux-ui-guardian` | Design system + UI review |
| `modal-toast-dialog-guardian` | Accessible overlays |
| `image-optimization-guardian` | Image delivery + performance |
| `lighthouse-pagespeed-guardian` | Performance audits |
| `github-repo-health-guardian` | Repo hygiene |
| `dark-mode-theming-guardian` | Theming + dark mode |
| `csv-xlsx-import-export-guardian` | Spreadsheet import/export |

Swap any of these for your stack. A Python/Django app would replace several with `python-guardian`, `react-guardian`, etc.

---

## App-specific â€” fill in per app

### Docs
| File | What you write |
|---|---|
| `CLAUDE.md` project block + hard rules | Stack, the 3 files, and the bug-causing rules |
| `docs/PROJECT.md` | What/why/who + **North-star goals** (triage scores against these â€” write them first) |
| `docs/ARCHITECTURE.md` | Subsystems by named entry point, data flow |
| `docs/DATA_MODEL.md` | State shapes, storage keys, hardcoded DBs |
| `docs/FEATURES.md` | Feature catalog by area + status |
| `QA.md` `[app]` items | The app's hard-rule greps |

### Implementation specs
| Folder | What you write |
|---|---|
| `library/requirements/features/` | PRDs â€” one folder per feature, written before building |
| `library/requirements/issues/` | IRDs â€” one folder per bug, written before fixing |

PRDs and IRDs are **immutable implementation contracts**. Changes after work begins = amendment blocks or new revisions. Never rewrite accepted sections.

---

## Bootstrap a new app

1. **Copy** the generic file set into the new repo.
2. **Empty** the instance files: `planning/*`, `STATUS.md`, `captures/inbox/*`; clear `docs/PROJECT|ARCHITECTURE|DATA_MODEL|FEATURES`. Keep `docs/DECISIONS.md` as a starting log.
3. **Write `docs/PROJECT.md` first** â€” especially the North-star goals; triage ranking depends on them.
4. **Fill `CLAUDE.md`'s** project summary + hard rules.
5. **Swap the `[app]` checks** in `QA.md` for the new app's hard-rule greps.
6. **Install agents + skills** â€” copy the `.claude/agents/` and `.claude/skills/` folders; swap any agents that don't match your stack.
7. **Wire capture** â€” import `n8n-telegram-inbox.json` (new repo + bot token + your Telegram id); register `run-claude.ps1` in Task Scheduler.
8. **Seed work** â€” write the first PRD in `library/requirements/features/`, add it to `planning/BUILD_QUEUE.md`, and go.

---

## What "generic vs app-specific" buys you

The boundary is the whole point: the **protocol** (how work flows, how quality is gated, how the workforce is orchestrated) is identical across products, while the **content** (what the app is, its rules, its agents) is per-app. New apps start with a mature pipeline on day one instead of re-inventing process.

---

## Not yet done â€” true extraction (parked)

Today the OS and this app share one repo. To make cloning real, lift the generic set into its own `ai-dev-os/` repo and consume it via template-repo / submodule / copy-on-init. See ROADMAP â†’ Research. This file is the manifest that extraction will follow.
