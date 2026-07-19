# Audit Summary — persistent state for /audit (D-043)

> Auto-maintained by `tools/Run-Audit.ps1`. The two state lines below are written by the script
> itself (deterministic, not the LLM); the sections after are Claude's own running notes. Don't
> hand-edit `last-audited-commit`/`last-full-refresh` — a wrong value here just means the next audit
> re-reads more (or less) than it needs to, not a correctness risk to the app itself.

## State
- last-audited-commit: bfb8f015700a6fb60a70dccfee26da998d06d9e2
- last-full-refresh: 2026-07-19

## App summary
ChronaSense is a personal time-audit app built in vanilla JS (no framework, no build step). Core loop: interval timer pings the user every N minutes → user logs what they were doing → timeline + insight layer turns the log into behavioural feedback. Data lives in localStorage with real-time Firebase RTDB sync across devices. Firebase auth (Google sign-in) uses the UID as the room code, so the same account on any device auto-syncs. Logic is split across four extracted modules (`storage.js`, `insights.js`, `focus-wallet.js`, `focus-mode.js`) plus a large `index.html` (≈10k+ lines). Key sub-systems: interval timer (heartbeat crash detection, multi-device owner guard), Focus Mode (Pomodoro + lo-fi music served from GitHub Pages CDN), Focus Wallet (weekly gamification scoring with sports-session cost rules), Today Plan (1–3 daily intentions with evidence-based done detection), Gap Recovery (surfaces untracked periods), Awareness Signal (real-time behavioural commentary from `insights.js`), Day Review + Review Plan Picker (nightly ritual), Partner accountability (publish/subscribe via Firebase public node — partly hidden behind setup). Day templates (recurring schedule blocks with auto-log), Sleep tracking, Away mode, Break tracking, and Android UsageStats auto-logging complete the capture surface. The app ships to web (GitHub Pages from `main`), Android (Capacitor), and Chrome/Edge extension.

Architecture notes worth remembering:
- **Hard red zones** (see CLAUDE.md): `clipOverlapsForDisplay`, `mergeConsecutiveForDisplay`, `computeGaps`, `_stopHeartbeat`, `_todayRenderKey`, heartbeat IIFE, `doPing` device guard, timer restore block, anything touching entry schema/RTDB sync.
- **Risk gate rule**: red-zone tasks land as `approved` (human-merge), not `done` (auto-merge). `main` is live production.
- `index.html` is ≈10k lines — always navigate via `CODEMAP.md`, never read in full.
- Firebase security relies on Auth (UID-scoped room codes), not on API key secrecy (Firebase web API keys are public by design).
- `computeFocusWallet()` is correctly timezone-aware: `getCurrentFocusWallet()` passes `dateKeyForTs` using `getDateInTZ(ts, tz)` — the UTC fallback in `focus-wallet.js:84` is never hit in production.

## Already-surfaced findings
The following findings have been proposed or were considered and rejected during the 2026-07-19 full audit. Future audits must not re-propose them.

**Proposed (PROP-007):** `triggerPenaltyMode()` is called in `insights.js:checkEscalation()` but is NOT defined in `index.html`. Zero matches on `grep triggerPenaltyMode index.html`. The function body exists only in old prototype files. Produces a silent ReferenceError on any 5+ consecutive waste/missed-entry streak, suppressing both penalty-mode activation and `checkBudget()`.

**Proposed (PROP-008):** `enterFocusMode()` in `focus-mode.js:608–626` auto-logs the running timer block but calls `showToast()` instead of `showUndoToast()` and never calls `rememberCreatedUndo()`. The auto-logged entry cannot be undone via the undo toast; the user must edit/delete from the timeline. The energy heuristic (`entries.find(...)?.energy || 'deep'`) may assign the wrong energy if the most recent past entry differs from the current task type.

**Proposed (PROP-009):** `isFocusWalletSportsEntry()` in `focus-wallet.js:89–91` uses `label.includes("sport")`. The word "transport" contains "sport" as a substring, so activities named "Public transport", "Transport to work", etc. are falsely classified as sports sessions, consuming weekly free-session slots and potentially accruing wallet costs.

**Considered and not proposed:**
- `_buildEntriesByDate` is listed in CODEMAP.md's storage.js function list but does not exist in the code. Nothing calls it. It's a stale CODEMAP entry (minor doc drift; not a runtime issue).
- `computeInsights()` "bestDay" uses `new Date(d+'T12:00:00').getDay()` (browser local time) rather than a timezone-aware variant. Verified safe: `d` is already the correct YYYY-MM-DD in user's timezone; noon local time is unambiguously on date `d` for all real-world timezone offsets, so `getDay()` always returns the correct weekday.
- `getEntryDateKey()` UTC fallback in `focus-wallet.js:84` was suspected but confirmed safe: `getCurrentFocusWallet()` always passes `dateKeyForTs = getDateInTZ(ts, tz)`, so the fallback is never reached in production.
- Focus Music served from `shinyamadasan.github.io` CDN: graceful error handling (`.catch(() => {})`) exists on all play calls. Offline or CDN-unavailable just silences the music. Not proposable.
- Awareness signal "Recovery > deep work" fires when recovery time (naps, meals) exceeds deep work. Verified as intentional design; overnight sleep entries go to yesterday's date via tsStart attribution so they don't inflate today's recovery count.
- `checkReviewPrompt()` is not called at app startup — only after each log action. By design: review opens when the user is active, not on cold open. Not a gap.
- Partner nudge potential double-toast: if two devices both receive `child_added` before the first device's `.remove()` propagates, both could show the toast. Minor race, low frequency, not proposable at this time.
- PROP-004 (timer state not restored on reopen, reported by user) is already in PROPOSALS.md — confirmed related to the INIT section and Hard Rule #8. Not re-proposed.
- PROP-006 (category confusion for cooking/church work) is already in PROPOSALS.md. Not re-proposed.
- `snoozeLog()` limit of 2: after limit is hit, dismissal (not logging) is still allowed. This is by design — gaps from dismissed pings are caught by the Gap Recovery inbox system.
- `autoLogBlock()` (phone usage tracking, template auto-log) does not call `checkBudget()`. Minor coverage gap in the budget system; intentional omission (auto-logs are background events, not user-initiated choices).
- `enterFocusMode()` energy heuristic may assign wrong energy in cold-start scenarios (no prior entries today). Heuristic `entries.find(...)?.energy || 'deep'` is reasonable in practice; deep is the correct default for focus mode context.
- Focus Wallet `getDailyGoalMin()` returns 0 if no goal is set — daily bonus is correctly withheld. By design.
