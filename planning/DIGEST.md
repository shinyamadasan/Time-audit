🌅 *ChronaSense — Morning Digest*
Tue 21 Jul · 12 proposals waiting · 🎯 Objective: *unset*

✅ *RECOMMEND APPROVE (5)*
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

💤 *RECOMMEND PARK (2)*
*6* · Category clarity: where do cooking and church work go? (capture 75)
   → — Real usage friction: user couldn't tell which category bucket to use for "cooking" or "church work." Worth addressing, but needs clarification (relabeling? new presets? descriptions?) before it can be specced. Park behind PROP-004 bug fix and pending Current Objective.
*12* · In-app calendar / appointment planning (capture 86)
   → — The user wants to plan appointments during the day inside the app (like Google Calendar), with an optional Google Calendar sync. Valid product direction for closing the "planned vs actual" gap, but this is a large-scope feature addition — effectively a second major subsystem alongside the timer/audit core. Park behind current P1/P2 bug fixes and pending Current Objective. Revisit once the app is stable and the Current Objective is set.

🗑 *RECOMMEND REJECT (5)*
*1* · Keysmash test noise (captures 12, 16, 36)
   → — Three keysmash/filler test messages ("tesss", "test capture,", "sda") sent during Telegram bot setup. No actionable content.
*2* · Orphaned /approve command (capture 20)
   → — `/approve` arrived on 2026-07-13 with no pending proposal in context and nothing in BUILD_QUEUE. Likely a bot-command routing test, not intent to approve a specific proposal.
*3* · Bot routing confirmation (capture 40)
   → — Explicit end-to-end pipeline test ("routing test chronasense"). No feature request. Confirms the Telegram → n8n → captures/inbox pipeline is fully functional.
*5* · Bot noise batch (captures 55, 61, 63, 67)
   → — Four noise messages: "test" (bot-setup test), "/reject" (mistyped bot command sent as plain text), and two single-character "s" keysmashes. No actionable content.
*10* · `/approve all` approval command (capture 82)
   → (as a product proposal) — `/approve all` is a human approval-gate command, not a feature request or bug report. The user intends to approve all currently pending "Approve"-recommended proposals (PROP-004, PROP-007, PROP-008, PROP-009). Triage cannot execute approvals; ROADMAP.md and BUILD_QUEUE.md are write-protected in this step. The signal is noted and flagged in STATUS.md for the next human review.

—
*Reply:* `Accept` (take all my recs) · `Approve all` · `Approve 14-19` · `Park 7` · `Reject 12`
Approved → built next run. Silence → nothing happens.
