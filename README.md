# ChronaSense — Time Audit App

A personal time tracking system built for radical honesty about where your time actually goes. Combines interval-based manual logging, automatic phone and browser tracking, cross-device sync, and behavioral insights — all in a single mobile-first app.

**Stack:** Vanilla JS · Firebase Realtime Database · Capacitor (Android) · Chrome/Edge Extension

---

## How It Works

ChronaSense runs a configurable timer in the background (default: 30 minutes). When the interval ends, it pings you and asks one question: *what were you just doing?* Log it, and move on. Over time, patterns emerge that are hard to argue with.

Gaps between manual logs are filled automatically — by phone usage detection on Android, by the browser extension on PC, or by the built-in retroactive log tool.

---

## Features

### Core Timer
- Start/pause/resume timer with task name pre-commit
- Switch tasks mid-block — auto-logs the previous block
- Elapsed time display with start time, current time, and h+m duration
- Configurable ping interval (default 30 min)
- Repeat last task shortcut

### Logging
- **Quick log modal** — activity name, energy category, on-plan flag
- **9 energy categories** — Deep Work, Shallow Work, Job Work, Learning, Exercise, Social, Maintenance, Errands, Waste
- **Retroactive logging** — log past blocks with custom start/end times
- **Gap detection** — auto-detects unlogged time between entries and prompts to fill it
- **Edit past entries** — pencil icon on Today timeline and Week all-entries list
- **Voice input** — speech-to-text for hands-free logging
- **Activity presets** — saved shortcuts for common tasks (customizable)
- **Recent activity chips** — learns your most-used activities

### Away & Break Tracking
- Away state with preset labels (Sleep, Eat, Walk, Exercise, Commute, Rest, Errand, Personal) or custom
- Break timer with countdown and auto-resume
- Both states sync in real time across all devices

### Focus Mode (Pomodoro)
- Configurable work/break durations (default 25/5)
- Full-screen blocker during focus with exit delay countdown
- Session dots tracking completed pomodoros
- Deep work progress bar toward daily goal
- Auto-logs session as Deep Work on exit
- Optional focus music

### Auto-Tracking
- **Phone usage (Android)** — detects foreground/background events via Android UsageStats API. Tracks Instagram, TikTok, YouTube, Facebook, Twitter/X, Reddit, Snapchat, Pinterest, Netflix, Google Meet, Telegram, WhatsApp, Chrome and more. Syncs every 15 minutes. Sessions under 1 minute ignored. Auto-logged entries never overwrite manual logs.
- **Browser extension (Chrome/Edge/Brave)** — silent background tracker logs active browser tabs. Tracks YouTube, Reddit, LinkedIn, Notion, GitHub, Figma, Slack, Gmail, Zoom and more. Google sign-in per user — each person's data goes to their own account.

### URL Scheme (Deep Linking)
- `chronasense://start?task=Work` — starts the timer with a task pre-filled
- `chronasense://quicklog?task=Gym&energy=invest` — instantly logs a past block
- Works with home screen launchers, Tasker, iOS Shortcuts, or any automation tool

### Statistics & Insights
- Energy split by day and week (Deep Work %, Waste %, etc.)
- Top activities ranked by time spent
- Unlogged hours card — stacked bar per day showing gaps in coverage
- Deep work streak counter
- Identity level based on deep work percentage
- Live cost tracker ($/hr × time logged)
- Behavioral feedback — detects waste patterns and escalation spirals
- Penalty mode — optional 60-min recovery session after consecutive waste blocks

### Reviews & Planning
- Daily review — win, waste, avoidance plan, tomorrow's focus
- Weekly review — what worked, what didn't, energy drains
- Weekly planning — P1/P2/P3 priorities for the coming week
- All reviews sync across devices with timestamp-based conflict resolution

### Multi-Device Sync (Firebase)
- Google Sign-In via Firebase Auth
- Real-time sync of entries, timer state, settings, reviews, breaks, and away state
- Room code system — share a code to link multiple devices to one account
- Connected devices list with last-seen timestamps
- Timer ownership — one device drives pings to prevent duplicates
- Conflict resolution via `updatedAt` timestamps
- Offline-first — data saved locally, syncs automatically when reconnected

### Settings
- Timezone (auto-applies to all date calculations)
- Ping interval, deep work goal, daily commitment target
- Coach tone (how the app gives feedback)
- Review prompt hour
- Hourly rate for cost tracking
- Focus mode exit delay

### Onboarding & Help
- 6-step guided onboarding on first launch
- Covers core loop, energy categories, phone tracking, browser extension, URL shortcuts, and setup
- Replayable anytime from Settings

---

## Browser Extension

A separate companion extension that tracks browser activity and logs it automatically to your ChronaSense account.

**Files:** `browser-extension/`

**Tracked sites (configurable):**
YouTube, Instagram, TikTok, Facebook, Twitter/X, Reddit, Snapchat, Pinterest, Netflix, Twitch, LinkedIn, Gmail, Google Meet, Zoom, Google Docs, Google Sheets, Notion, Slack, Figma, GitHub

**How it works:**
1. Install as unpublished extension via Load Unpacked (no store required)
2. Sign in with Google — links to your existing ChronaSense account
3. Runs silently in background — no interaction needed
4. Active tab sessions logged to Firebase in real time
5. Sessions under 1 minute are ignored
6. Token refresh handled automatically (Firebase idToken lasts 1 hour)

**Sharing:**
Zip the `browser-extension/` folder and send it. Each person signs in with their own Google account — data goes to their own ChronaSense, not yours. Works on Mac (Chrome) and Windows (Edge/Chrome).

---

## Android App

Built with Capacitor. Features beyond the web app:

- Native push notifications for timer pings
- Phone usage auto-tracking via `UsageStats` Android API (custom Capacitor plugin)
- URL scheme handler (`chronasense://`) for home screen shortcuts
- Native `FileProvider` for local file access
- Permissions: `PACKAGE_USAGE_STATS`, `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM`

---

## Project Structure

```
/
├── index.html              # Main app (single-file SPA)
├── storage.js              # Firebase sync, persistence, timer state
├── insights.js             # Behavioral feedback engine
├── sw.js                   # Service worker (offline support)
├── android/                # Capacitor Android project
│   └── app/src/main/java/com/timeaudit/app/
│       ├── MainActivity.java
│       └── UsageStatsPlugin.java   # Custom native plugin
├── browser-extension/      # Chrome/Edge companion extension
│   ├── manifest.json
│   ├── background.js       # Tab tracking + Firebase logging
│   ├── firebase-config.js  # Shared config + tracked sites
│   ├── popup.html/js       # Sign in / sign out UI
│   └── SETUP.md
└── sync.bat                # Copies root files → www/, runs cap sync, commits
```

---

## Version History

| Version | Date | Highlights |
|---------|------|------------|
| 0.4.0 | 2026-04-19 | Phone usage tracking, browser extension, URL scheme, full 2-way sync, edit buttons, unlogged hours card |
| 0.3.0 | 2026-04-09 | Pomodoro focus mode, editable timeline entries, app renamed to ChronaSense |
| 0.2.0 | 2026-04-08 | Google sign-in, break timer, gap detection, retroactive log, week view redesign, Android notifications |
| 0.1.0 | 2026-04-06 | Initial version — ping timer, log modal, Firebase, today/week/settings views |
