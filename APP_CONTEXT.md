# ChronaSense App Context

Last updated: 2026-09-04 (Phase 11.5 — Context Reconciliation)

This is the current high-signal context for ChronaSense. Use this when starting a new thread,
onboarding a contributor, or recovering from stale chat context.

## What This App Is

ChronaSense is a personal time-audit app built for honest, low-friction tracking of where time
actually goes. The core loop is:

1. A configurable timer runs in the background.
2. The app pings the user at the interval, usually 30 minutes.
3. The user quickly logs what they were doing.
4. Gaps are filled through retroactive logging, Android phone usage, or browser-extension activity.
5. Daily and weekly views turn the record into behavioral feedback.

The product is personal, not managerial. It is not a team surveillance tool, invoicing system, or
generic dashboard.

## North Star

The product priorities, from `docs/PROJECT.md`, are:

1. Make logging frictionless.
2. Capture the truth with no silent gaps.
3. Never lose logged time.
4. Make insight change behavior.
5. Keep the app simple and maintainable.

The most important safety principle is that logged time must not be lost. Sync, storage, deletion,
tombstones, timer recovery, and crash recovery should be treated as high-risk areas.

## Stack And Shape

- Vanilla HTML, CSS, and JavaScript.
- No framework and no build step.
- Firebase Realtime Database and Firebase Auth.
- Capacitor Android app.
- Chrome/Edge browser extension.
- Service worker for offline/PWA behavior.
- Tests run with `npm test`; Playwright smoke tests run with `npm run test:smoke`.

The app is still centered on a large root `index.html`. Do not read it in full. Read `CODEMAP.md`
first, then open only the named section needed for the task.

Extracted root modules:

- `storage.js`: localStorage, Firebase sync, debounced Today rendering, timer/away sync, entries,
  plans, templates, reviews, and sync event helpers.
- `insights.js`: weekly insight computation.
- `focus-mode.js`: Pomodoro/focus mode, focus blocker overlay, focus music, focus suggestions.
- `focus-wallet.js`: pure Focus Wallet scoring rules.
- `sw.js`: service worker and ping scheduling support.
- `browser-extension/`: companion extension for browser activity tracking.
- `www/`: Capacitor web asset mirror.

## Core Product Areas

- Today view: timer, current state, daily plan, quick logging, gaps, timeline, recent entries, daily
  health, routine prompts, Focus Wallet, and side panels on desktop.
- Timer and ping loop: start, stop, reset, task naming, quick-log modal, native/browser ping paths,
  heartbeat recovery, and timer ownership across devices.
- Logging: quick log, retroactive log, same-as-last, sleep shortcut, common activities, voice input,
  editing, deletion, merged display rows, and undo.
- Gap and timeline display: day windows, overlap clipping, display-only merging, untracked-time
  recovery, and day browsing.
- Planning and review: 1-3 item Today Plan, daily review, tomorrow plan picker, weekly planning,
  and Reflect history.
- Focus mode: Pomodoro sessions, blocker overlay, break flow, deep-work progress, lo-fi music, and
  focus session logging.
- Focus Wallet: weekly points, rewards, redemptions, waste/sports costs, and negative focus debt.
- Away and break tracking: away labels, elapsed timer, break modal, and synced active state.
- Week and Reflect views: energy split, top activities, unlogged hours, week comparison, streak
  calendar, focus heatmap, daily reflections, and weekly review.
- Day templates: recurring schedule blocks, selected-day editor, auto-log due templates, template
  suppression, and update offers from real entries.
- Settings: timezone, ping interval, deep-work goal, review hour, hourly rate, presets, activity
  cleanup, sync controls, and account state.
- Android tracking: UsageStats sessions are rebuilt from foreground/background events and logged
  when above the minimum duration.
- Browser extension: tracks active tab sessions for supported sites and writes to Firebase under
  the signed-in user's account.

## Product Boundary (established Phase 11.5)

Between Phase 6 and Phase 11 this repo grew four "Life OS" surfaces (Learning Plans,
Capability/Career, the Life Character Sheet, Cross-Domain Intelligence) plus a shared Life Ledger
and an Obsidian sync pipeline, on top of the original time-audit product. This section is the
product-boundary decision that resulted, so a feature request can be placed correctly without
re-litigating it.

**Canonical loop (ChronaSense):** CAPTURE TRUTH → UNDERSTAND TODAY → INTERRUPT DRIFT → REVIEW
BEHAVIOR → IMPROVE NEXT ACTION. A feature belongs in *core* ChronaSense only if it materially
improves at least one of: (1) frictionless capture, (2) no silent gaps, (3) truthful time
awareness, (4) focus/accountability, (5) behavioral correction from recent activity. Otherwise
it is adjacent, not core — see below.

**Cross-repo architecture principle** (already stated in `docs/LIFE_LEDGER_CONTRACT.md`, reused
here as the north star for the split): *Apps record facts. Life Ledger connects them. Obsidian
remembers them. Claude interprets them.*

- **ChronaSense owns:** time/activity capture, timer/pings, gap recovery, browser/Android
  activity capture, intentions / Today Plan, Focus Mode, the Awareness Signal card (today's
  behavioral read), immediate accountability (Focus Wallet, streaks, escalation), and
  daily/weekly time-awareness review. Everything in "Core Product Areas" above.
- **Life Ledger owns:** the append-first, cross-app factual event history
  (`life-ledger-core.js`, `life-ledger-runtime.js`, `life-ledger-transport.js`,
  `life-ledger-sync-*.js`). ChronaSense is one of three source apps that write into it
  (alongside the sibling Workout and Meal apps) — it is shared infrastructure hosted in this
  repo, not a ChronaSense feature.
- **Obsidian owns:** durable human-readable memory (`obsidian-life-ledger-*.js`,
  `scripts/*obsidian*`) — a one-way, append-only export of Life Ledger facts. Also shared
  infrastructure, not a ChronaSense feature.
- **Claude / intelligence layer owns:** interpretation, recommendations, synthesis, "what
  should I do next." `cross-domain-intelligence-model.js` currently does a deterministic,
  rule-based (non-LLM) version of this job *inside* ChronaSense — see classification below.

**Ambiguous subsystem classification** (A = legitimately ChronaSense, B = shared Personal-OS
module correctly colocated in this repo for now, C = should eventually live elsewhere):

| Subsystem | Class | Why |
|---|---|---|
| Learning Plans (`learning-plan-*.js`) | B | Personal knowledge-development tracking with its own top-level nav tab; writes `plan_step_completed` evidence into Life Ledger and reads Focus outcomes, but browsing/editing plans is not time-audit capture. |
| Capability/Career (`capability-career-*.js`) | B | Explicitly documented (`docs/ARCHITECTURE.md`) as *contextual interpretation* ("this fact demonstrates this capability"), distinct from Life Ledger's *factual history*. Career development, not time tracking. |
| Life Character Sheet (`life-character-sheet-*.js`) | B leaning C | A cross-domain "where am I right now" snapshot with 6 raw domain-coverage fields (`focus`, `time`, `learning`, `capability`, `workout`, `meal`) — 4 of 5 conceptual sections are about domains outside ChronaSense, with `focus` + `time` grouped as one ChronaSense section. |
| Cross-Domain Intelligence (`cross-domain-intelligence-*.js`) | B, strongest C candidate | Does the job the boundary above assigns to "Claude / intelligence layer" (recommendation/synthesis), just without an LLM. Legitimate today because no external intelligence layer exists yet; first candidate to migrate out once one does. |
| Life Feed (`life-feed-*.js`) | B | A read-only unified timeline over Life Ledger events. A viewer for shared infrastructure, not itself time-audit capture. |

No subsystem was moved in Phase 11.5 — this table is the conceptual-ownership decision only,
per the phase's own scope boundary.

**Legacy / consolidation candidates:**
- `ai_studio_code (1) - Copy.html` and `ai_studio_code (1) copy.html` — dead prototype files
  (~250 KB). No longer the only home of `triggerPenaltyMode()` (Phase 11.6 defined it in
  `index.html`). Still dead weight; deletion deferred (Phase 11.7 kept scope to conceptual/UI
  duplication, not repo file hygiene).
- `docs/DECISIONS.md` — **resolved in Phase 11.7.** Was a parallel decision record (D-001 an
  unfilled placeholder; D-002/D-003/D-004 real, substantive — D-003/D-004 are the
  Capability/Career architectural decisions this file relies on above). Root `DECISIONS.md` is now
  the single canonical log; D-002/D-003/D-004 were migrated into it verbatim as entries 23/24/25
  (original ids kept as aliases); `docs/DECISIONS.md` is now a pointer stub, retained only because
  `tools/Verify-Decisions.ps1` / `tools/Check-DocsConsistency.ps1` still read that path.

## Motivation Layer (current inventory, Phase 11.5; Phase 11.7 outcomes noted inline)

| Mechanism | Behavior it targets | Disposition |
|---|---|---|
| Focus Wallet | Turns deep-work minutes into spendable "points," costs waste/sports time against balance; allows negative debt. Weekly-scoped, reward-redemption loop. | KEEP — unique job (the only mechanism with a spendable balance and rewards). |
| Identity level (`computeIdentityScore()` / `getIdentityLevelWithEmoji()`) | Labelled the user by deep-work block count ("who you're becoming"), shown in a Today stat tile. | **REMOVED (Phase 11.7).** The tile had been `display:none` since 2026-07-10; its only input was today's deep-block count, identical to the `#s-deep` tile beside it. No unique behavioral value, no persisted data. Awareness Signal covers the honest deep/waste read. |
| Streaks (`computeStreak()`, `computeCleanStreak()`, 60-day streak calendar) | Consecutive-day consistency pressure. | KEEP — distinct time axis (day-to-day) from Focus Wallet's within-week axis. |
| Penalty / escalation (`checkEscalation()` → `triggerPenaltyMode()`) | The most forceful nudge: 5+ consecutive waste/missed entries set a 60-min recovery-block duration and lock the focus-mode exit delay to 60s. | FREEZE — functional as of Phase 11.6 (`triggerPenaltyMode()` restored, commit `f3887db`). Audited in Phase 11.7: surface is two `showToast()` calls, no dedicated UI or settings, so no "quieter" change was needed. Do not expand. |
| Awareness Signal ("Today's Signal", `renderAwarenessSignal()`) | Real-time honest read of today (deep/waste %, peak focus hour, worst waste activity, time since last deep block). | KEEP — this is Goal #4 ("insight must change behaviour") made concrete; the natural home for any future minimal distraction metrics (see below). |
| Focus Mode | Pomodoro session + full-screen blocker + exit-delay friction. | KEEP — the only mechanism that *intervenes* in the moment rather than reporting after the fact. |

## Review Surfaces (current inventory, Phase 11.5)

| Surface | Covers | KEEP / MERGE-CANDIDATE / LEGACY-CANDIDATE |
|---|---|---|
| Day Review Modal (`openReview()`, `checkReviewPrompt()`) | Daily review + closeout, including missed-closeout graveyard-shift handling (a morning review hour makes the prior calendar day due the next morning). Documented in `CODEMAP.md` as "the daily habit hook the whole plan loop hangs on." | KEEP — this is daily review, closeout, and missed closeout combined already; no separate missed-closeout surface exists to merge. |
| Review Plan Picker (`openReviewPlan()`) | Turns the review's "tomorrow's focus" into the next day's 1–3 item Today Plan; the plan picker. | KEEP — tightly coupled to the Day Review Modal, not a separate concern. |
| Reflect View (`renderReflectView()`) | Weekly review, weekly planning, streak calendar, focus heatmap, daily-reflection history — Week/Month view lives here too (`renderMonthOverview()` is a mode toggle inside the Week tab, not a separate view). | KEEP — already the single consolidated weekly surface; Week/Month is one view, not two. |

Net finding: this inventory is already consolidated. Phase 11.7 re-verified all three surfaces
against live code — daily review / weekly Reflect / missed-closeout each serve a distinct job —
and left them unchanged (KEEP). The Phase 11.7 change in the motivation layer was removing
identity level (see above); Awareness Signal, streaks, Focus Wallet, and Focus Mode are untouched.

## Distraction Signals — Explicitly Scope-Limited (Phase 11.5; built as Phase 11.8)

Existing infrastructure already covers distraction *detection* (browser tab sessions, Android
UsageStats, distraction heuristics in `insights.js`, Focus Mode intervention). Phase 11.8 built
**derived metrics surfaced on existing screens only** — no new collector, tab, dashboard, score,
daemon, blocker, Firebase subsystem, or Life Ledger coupling:

- `attention-signals.js` — pure, deterministic `deriveAttentionSignals(entries, opts)`. Reads the
  `entries` array only. Classifies each block as focus / neutral / distraction by its own energy
  label or Today Plan membership (never by app/window), so related-tool switching stays one
  coherent stretch. Outputs: longest coherent stretch (min), attention breaks, likely distraction
  (`~N min`, withheld below 15 classified min), recoveries + median recovery time. Hedged
  language throughout — an estimate of attention, not an exact cognitive measure.
- Surface: the existing end-of-day review modal (`openReview()`), in an "Attention today" block
  above the win/waste fields. No other surface.
- Manual calibration: one optional `reviews[dateKey].focusRating` — `'focused' | 'mixed' |
  'distracted'` or `null`. Stored in the existing `reviews` object, synced via the existing
  `rooms/<code>/reviews` path. Never fused into the automatic numbers; Phase 12 may interpret the
  two side by side. Awareness Signal, streaks, Focus Wallet, Focus Mode, and penalty/escalation
  (FREEZE) are untouched. Not integrated to main.

## Known Live Bugs (bounded)

- **`triggerPenaltyMode()` was undefined in production — FIXED in Phase 11.6** (`f3887db`,
  integrated to main). `insights.js:248` calls it from `checkEscalation()` on a 5+ consecutive
  waste/missed streak; the function had only ever existed in the dead `ai_studio_code (1)*.html`
  prototypes and as an ESLint `readonly` global, so every call threw a silent `ReferenceError`
  (`exitDelay` was still set to 60s just before the throw, so that half worked). It is now defined
  next to `startSprint()` in `index.html`. Penalty/escalation remains FREEZE — this was a
  correctness fix, not an expansion. (Original audit: `planning/PROPOSALS.md` PROP-007.)

## Fragile Areas

These rules come from `AGENTS.md` and `CODEMAP.md`. Read the relevant implementation before touching
any of them.

- `clipOverlapsForDisplay()` must return shallow copies, not mutate source entries.
- `mergeConsecutiveForDisplay()` must preserve `_mergedIds`.
- `computeGaps()` must anchor to `getWorkDayStartTs()`, not first-entry time.
- `_stopHeartbeat()` must run on clean exits such as `resetTimer()`, `stopAndLog()`, and
  `confirmExitFocus()`.
- `_todayRenderKey` must keep the `'__FORCE__'` sentinel.
- The heartbeat crash-detection IIFE must run once, first, and undeferred.
- `doPing()` must keep the device-owner guard.
- Timer restore must happen before `renderToday()`.
- Entry schema, RTDB sync, tombstone merge/delete behavior, and crash recovery are red-zone areas.

## Documentation Reality

Useful and reasonably current:

- `APP_CONTEXT.md`: this current context snapshot — stable purpose + durable invariants +
  the Phase 11.5 product boundary.
- `README.md`: user-facing overview and feature list (does not cover the Life OS surfaces —
  that gap is intentional; README is onboarding, not volatile project state).
- `docs/PROJECT.md`: product north star and non-goals. Still accurate; changes rarely.
- `CODEMAP.md`: structural map for `index.html` and every extracted module, including the
  Learning Plan / Capability-Career / Life Ledger / Obsidian / Life OS files. This is current
  through Phase 11 and is the single source of truth for "what code exists."
- `CHANGELOG.md`: accurate, append-at-top history through Phase 11 (2026-09-04). Read this,
  not `STATUS.md`, for what actually shipped — see the note below.
- `STATUS.md`: see "Two parallel tracks" below — its own stated role (current working memory)
  had gone stale until the 2026-09-04 entry added during this reconciliation.
- `docs/LIFE_LEDGER_CONTRACT.md`: current; source of the cross-repo architecture principle used
  above.
- `SMOKETEST.md`: manual verification checklist.

Known stale or incomplete (corrected 2026-09-04):

- `docs/ARCHITECTURE.md`: **no longer a pure placeholder** — it now documents Capability/Career
  V1 in real detail (entry points, storage, evidence semantics). It just doesn't cover any other
  subsystem yet. Treat it as "real but partial," not "placeholder."
- `docs/DATA_MODEL.md`: still a placeholder (`TODO.` only, 4 lines).
- `docs/FEATURES.md`: still a placeholder (`TODO.` only, 5 lines).
- `docs/DECISIONS.md`: **resolved in Phase 11.7** — now a pointer stub. Root `DECISIONS.md` is the
  single canonical decision log; D-002/D-003/D-004 were migrated into it (entries 23/24/25).
- `planning/ROADMAP.md`, `planning/PROPOSALS.md`, `planning/BUILD_QUEUE.md`, `TASKS.md`,
  `HANDOFF.md`: structurally fine but describe a pipeline (captures → triage → PROPOSALS →
  human-approves → ROADMAP → BUILD_QUEUE → TASKS → Codex) that has been stalled since
  2026-07-20 and was not how Phase 6 through 11 actually got built — see "Two parallel tracks."

## Two Parallel Tracks (the core Phase 11.5 finding)

This repo has been running two disconnected workflows since late July:

1. **The gated pipeline** (`captures/` → `planning/PROPOSALS.md` → human approval →
   `planning/ROADMAP.md` → `planning/BUILD_QUEUE.md` → `TASKS.md` → Codex). `STATUS.md` shows
   15+ consecutive automated triage runs (2026-08-14 through 2026-08-17) reporting the same
   stuck state: 13 proposals enriched and scored, zero approved, because the human step
   ("set the Current Objective") never happened. `planning/ROADMAP.md`'s "Current Objective"
   and "Approved Backlog" are still literally empty as of this update.
2. **An ad-hoc Phase-branch track** that bypassed the pipeline entirely: Phase 6 (Unified Life
   Feed) through Phase 11 (production hardening) were each built and merged to `main` directly,
   tracked only via `CHANGELOG.md` `## Phase N` headers and branch names
   (`feat/<name>-v1`) — never touched `planning/PROPOSALS.md`, `ROADMAP.md`, `BUILD_QUEUE.md`,
   `TASKS.md`, or `HANDOFF.md`. This is where essentially all real feature work since
   2026-09-01 lives.

Practical effect: reading `STATUS.md`, `HANDOFF.md`, or `TASKS.md` alone gives a *false* picture
that the app has been frozen since 2026-07-21. Reading `CHANGELOG.md` gives the true picture.
This split itself was a Phase 11.7 candidate (either retire the unused gated-pipeline docs, or
resume feeding them). **Phase 11.7 verdict: DEFER.** The dormant layers (`PLAN.md`,
`planning/BUILD_QUEUE.md`, `planning/DONE.md`, `planning/CODEX_READY.md`, `planning/DIGEST.md`,
`HANDOFF.md`, `TASKS.md`) are wired into six `tools/*.ps1` scripts; retiring them safely is an
AI-Dev-OS (`tools/` red-zone) task on its own, out of scope for a phase that must stop for
independent review. `planning/PROPOSALS.md` (13 real enriched proposals) and `planning/ROADMAP.md`
stay as the live idea/backlog record. See `planning/ROADMAP.md` "Deferred (Phase 11.7)".

## Current Repo State As Of This Update

- Branch: `main`, HEAD `1fe439af9e47c74d1100eba6e6b551eda7d4001a`, tracking `origin/main`.
- Working tree: exactly `M README.md` (a small, already-sensible "Start Here" pointer to this
  file and `CODEMAP.md`, uncommitted) + `?? APP_CONTEXT.md` (this file, uncommitted) — both
  verified live and hash-matched against the values Phase 11.5 was briefed with.
- Phase 11 (production hardening + its review-fix pass) is the latest work in `CHANGELOG.md`,
  both logged as "(built, NOT integrated)" / "(built, NOT activated)" — accurate descriptions of
  what the Builder pass itself did (real scheduler/config/outbox/vault never touched during the
  build). **What those entries do not capture: a human has since installed the real Windows
  Scheduled Task for real.** Verified live on 2026-09-04: task `ChronaSense Life Ledger Sync` is
  `Enabled`/`Ready`, 15-minute cadence, last run succeeded (`Last Result: 0`) at 11:47 AM, next
  run 12:02 PM. Production background sync is genuinely live — this is a real gap between
  "what the CHANGELOG says as of the commit" and "what is true today," caused by the activation
  step being an intentionally-separate, out-of-band human action (`setup-life-ledger-sync-
  scheduler.ps1 -Action Install -Apply`, not a Codex/Claude build task) that nothing writes back
  into `CHANGELOG.md` for. Treat the Task Scheduler state, not the CHANGELOG wording, as the
  source of truth for "is it live."
- `triggerPenaltyMode()` bug: confirmed still live — see Known Live Bugs above.
- `TASKS.md`: TASK-001 through TASK-003 are `done`/`approved`; no active `status: codex` task.
  Irrelevant to how Phase 6-11 actually shipped — see "Two parallel tracks."

## How To Resume Work

For development tasks:

1. Read `CODEMAP.md` (current through Phase 11 — includes every Life OS module).
2. Read `CHANGELOG.md`'s top entry for the actual latest work — not `HANDOFF.md`/`TASKS.md`,
   which track a separate, currently-stalled pipeline (see "Two parallel tracks").
3. Read only the relevant `index.html` section named in `CODEMAP.md`.
4. Run the requested verification, usually `npm test`.

For product/context work:

1. Start with this file — it now carries the product boundary, subsystem ownership, motivation
   and review-surface inventories, and the scope-limited distraction direction (Phase 11.5).
2. Use `README.md` for the core ChronaSense feature inventory (Life OS surfaces intentionally
   excluded there).
3. Use `docs/PROJECT.md` for north-star decisions.
4. Use `planning/ROADMAP.md` for the forward-looking phase sequence.
