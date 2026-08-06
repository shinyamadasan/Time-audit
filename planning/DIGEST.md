🌅 *ChronaSense — Morning Digest*
Wed 05 Aug · 13 proposals waiting · 🎯 Objective: *unset*

✅ *RECOMMEND APPROVE (6)*
*4* · Timer state not restored on app reopen (capture 52)
   → — First user-reported bug; maps directly to Hard Rule #8 (timer restore order in INIT). When the app is closed mid-session and reopened, the hero resets to starting "work" instead of resuming the active entry. Data correctness issue: the gap between close and reopen is untracked, and the resumed state is wrong.
*7* · `triggerPenaltyMode()` undefined — escalation dead-letters on 5-waste streaks
   → — Confirmed runtime bug. `checkEscalation()` in `insights.js:248` calls `triggerPenaltyMode()` which is not defined in `index.html`. A `ReferenceError` is thrown silently whenever five or more consecutive waste/missed entries are logged in a day. The function exists only in old prototype files and the `eslint.config.js` legacy globals list — it was never ported. The escalation path (the most forceful behavioral nudge in the app) silently never fires.
*8* · `enterFocusMode()` auto-log has no undo — wrong energy silently sticks
   → — UX gap confirmed in `focus-mode.js:608–626`. When the user opens Focus Mode with an active interval timer, `enterFocusMode()` auto-logs the running block. It calls `showToast()` (not `showUndoToast()`), so no undo action is registered. If the wrong energy is assigned (heuristic: most recent logged entry's energy, defaulting to `'deep'`), the user must manually find and edit or delete the entry from the timeline — there is no 1-tap correction.
*9* · Focus Wallet "sport" substring match false-positives on "transport" entries
   → — Confirmed precision bug in `focus-wallet.js:isFocusWalletSportsEntry()`. The function uses `label.includes("sport")` where `label` is the lowercased activity name. The word "transport" contains "sport" as a substring (positions 4–8 of "transport"). Any activity logged as "Public transport", "Transport to office", "Air transport", etc. is silently classified as a weekly sports session, consuming a free-session slot and potentially incurring wallet costs (10 pts for session 4, 25 pts for each beyond that).
*11* · Auto-timer toggle: enable / disable auto-start (capture 84)
   → — Real usage frustration: the timer auto-starts when the app opens even when the user is not working. A user-controlled toggle (on/off for auto-start) would eliminate unwanted entries and reduce noise in the audit log. First direct UX complaint about timer behavior from real use (not testing).
*13* · Unlogged-day navigation opens the wrong day's timeline (capture 120)
   → — Real usage bug report: from an unlogged-time day list, clicking a specific day (user's example: Wednesday, while today is Friday) opens the *next* day's timeline (Thursday) instead. The header date label stays correct, so this isn't a global date-state bug — it's isolated to whatever click handler resolves the clicked day into a date key for the timeline view. The "off by one, toward the future" pattern is the classic symptom of a `YYYY-MM-DD` string being parsed as UTC midnight and re-rendered in a negative-UTC-offset local timezone, but that's a hypothesis, not a confirmed root cause.

💤 *RECOMMEND PARK (2)*
*6* · Category clarity: where do cooking and church work go? (capture 75)
   → — Real usage friction: user couldn't tell which category bucket to use for "cooking" or "church work." Worth addressing, but needs clarification (relabeling? new presets? descriptions?) before it can be specced. Park behind PROP-004 bug fix and pending Current Objective.

_...+6 more waiting, too many to fit in one message — see planning/PROPOSALS.md, or reply to approve/park/reject by number anyway._

—
*Reply:* `Accept` (take all my recs) · `Approve all` · `Approve 14-19` · `Park 7` · `Reject 12`
Approved → built next run. Silence → nothing happens.
