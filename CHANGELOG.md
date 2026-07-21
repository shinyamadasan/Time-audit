# ChronaSense — Changelog

## TASK-002 — approved, held for /merge (branch: task-002) — 2026-07-21
changed:
  - tools/Generate-Digest.ps1 (builds the digest incrementally, stops before a safe char threshold,
    appends a "+N more" note instead of truncating the raw string)
  - tools/Dispatch-Commands.ps1 (stale-lock check now verifies the recorded PID is actually still
    running; lowered the still-running staleness wait from 2 hours to 45 min; sends a Telegram
    notice via the existing OUTBOX relay when it clears a stale lock instead of clearing silently)
tests: `[System.Management.Automation.Language.Parser]::ParseFile` on both files (pass); digest fix
  run against the real, live-failing planning/PROPOSALS.md (12 proposals) -- output 3911 chars,
  under Telegram's 4096 limit, all Approve/Park items kept; isolated 4-case fixture test of the
  stale-lock decision logic (dead PID, live+fresh, live+46min, live+44min-boundary), all pass
blockers: none
deviations: found live in the same session as TASK-001 -- a real Telegram digest-delivery failure
  ("message is too long") led to investigating why the queued TASK-001 /merge commands sat
  unprocessed, which led to discovering the hung-process/2-hour-stale-lock gap. The emergency
  DIGEST.md content regeneration already landed on main directly, ahead of this branch, since it's
  a data refresh rather than automation-surface code
→ status set to `approved` in TASKS.md (red-zone automation surface, held for human /merge)

## TASK-001 — approved, held for /merge (branch: task-001) — 2026-07-20
changed:
  - tools/Run-Codex-Build.ps1 (before auto-chaining a status:-review build into review, requires the
    build touched CHANGELOG.md or TEST_REPORT.md; blocks as a no-op with a clear note otherwise)
  - tools/Dispatch-Commands.ps1 (factored build/review classification into a shared
    Resolve-ReviewOutcome; added crashed-review-retry and no-op-retry cases; fixed a HELD-vs-APPROVED
    false-positive; added a pending-review-resume step to Invoke-Autopilot so plain /go resumes a
    stuck review; RETRYING vs NEEDS YOU summary wording)
tests: `[System.Management.Automation.Language.Parser]::ParseFile` on both files (pass); isolated
  fixture harness against Resolve-ReviewOutcome, extracted from this repo's own copy of the code (5
  cases / 9 assertions, all pass)
blockers: none
deviations: ported directly from the Meal Prep app (sibling project, sharing this exact
  tools/Dispatch-Commands.ps1 / tools/Run-Codex-Build.ps1 template) after that app found and fixed
  this bug live as its own TASK-032/D-051; full live end-to-end verification (a real crashed review,
  a real no-op retry) not attempted here either -- not safely reproducible without spawning real
  codex/claude CLI processes against a live branch
→ status set to `approved` in TASKS.md (red-zone automation surface, held for human /merge)

## [0.4.0] — 2026-04-19
### Added
- **Phone usage auto-tracking (Android)** — detects Instagram, YouTube, TikTok, Facebook, Twitter/X, Reddit, Snapchat, Pinterest, Netflix, Google Meet, Telegram, WhatsApp, Chrome and more via Android UsageStats API. Sessions logged automatically every 15 minutes.
- **Browser extension (Chrome/Edge)** — silent background tracker logs active browser tabs to your account. Supports YouTube, Reddit, LinkedIn, Notion, GitHub, Figma, Slack and more. Sign in with Google once, works for multiple users each with their own account.
- **URL scheme shortcuts** — `chronasense://start?task=X` starts the timer, `chronasense://quicklog?task=X&energy=Y` instantly logs a past block. Use with home screen launchers or Tasker.
- **PC Time auto-start** — timer starts automatically as "PC Time" when Edge/Chrome opens, so no time is lost before you set a task.
- **2-way full sync** — timer start/stop/task name, Away state, Settings, Reviews, and Weekly Plans all sync instantly across all devices via Firebase.
- **Edit buttons on entries** — pencil icon on Today timeline and Week all-entries list to edit past logs.
- **Unlogged hours card** — stacked bar below Top Activities showing unlogged time per day this week.
- **Timer block details** — shows start time, current time, and elapsed in h+m format.
- **Onboarding updated** — new steps covering phone tracking, browser extension, and URL shortcuts.

### Fixed
- Phone auto-logs skip time windows already covered by manual entries (manual always wins)
- Stop syncs correctly as full reset (not pause) across devices
- Away state syncs to other devices in real time
- Settings sync now applies all fields, not just timezone
- Reviews and weekly plans sync bidirectionally by timestamp

---

## [0.3.0] — 2026-04-09
### Added
- Pomodoro focus mode (25/5 default, adjustable work/break durations)
- Auto-logs work session on pomodoro completion
- Session dots showing completed pomodoros
- Deep work progress bar in focus mode
- Editable task input in focus mode (instead of showing today's intention)
- Current task label shown above timer when running
- Editable timeline entries — tap any entry to edit time, activity, energy

### Fixed
- Switch task button now skips "Still on" — opens form pre-filled with current task
- Focus mode "Switch task" calls correct function (no more duplicate log)
- Two timers conflicting when main timer + pomodoro both running
- End early break button broken (endBreak name collision with pomodoro)
- Untracked blocks removed — gap detection handles missed pings instead
- "YOU SAID" bar removed from ping modal (redundant with "Still on" button)
- Sync pill removed from header (always synced when signed in)

### Changed
- Week view day tabs redesigned to two-row layout with actual dates
- Elapsed time on ping modal shows actual block time, not hardcoded interval

### Renamed
- App renamed from "Time Audit" to "ChronaSense"
- New icon applied to all Android densities + splash screens

---

## [0.2.0] — 2026-04-08
### Added
- Google sign-in via Firebase Auth
- Break timer with auto-resume
- Gap detection — auto-detects unlogged time between entries
- Retro log (Past block) — log anything with custom start/end time
- Away stamper — mark gaps as Sleep, Commute, Break, Offline
- Recent activity chips in log modal
- Quick log redesigned as bottom sheet with chips and energy grid
- Activity colors — 32 curated palette + HSL golden-angle overflow
- Timeline bucketed in 30-min windows, expandable to micro detail
- Week view redesign — day detail, month view, energy split, top activities
- "YOU SAID" context bar in ping modal showing committed task
- Switch task mid-block — logs current, opens pre-commit for new task
- Capacitor Android setup with local notifications for background pings
- Settings tab black space fixed

---

## [0.1.0] — 2026-04-06
### Initial version
- Ping timer with adjustable interval (default 30 min)
- Log modal — activity, energy type, on-plan flag
- Firebase Realtime Database for persistence
- Today's timeline view
- Basic week view
- Settings tab
- Daily review — win, waste, tomorrow's focus
- Live cost tracker ($x drifting)
