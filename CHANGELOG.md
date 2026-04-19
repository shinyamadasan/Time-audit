# ChronaSense — Changelog

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
