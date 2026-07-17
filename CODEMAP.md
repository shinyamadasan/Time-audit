# ChronaSense — CODEMAP
> index.html structural reference. Generated 2026-05-07. Update when adding/moving sections.

---

## FILE OVERVIEW

| Block | Lines | Notes |
|-------|-------|-------|
| `<style>` CSS | 1–1018 | All styles inline |
| HTML structure | 1019–2128 | Views, overlays, panels, nav |
| Main `<script>` | 2129–7612 | All app logic |
| Second `<script>` | 7740–7895 | Onboarding init + phone-usage tracking |

**External files loaded (in order):**
- `firebase-app-compat.js` / `firebase-database-compat.js` / `firebase-auth-compat.js` — CDN, line 1296–1298
- `storage.js` — line 1299 → **EXTRACTED** (see below)
- `insights.js` — line 1300 → **EXTRACTED** (see below)
- `focus-wallet.js` — line 1301 → **EXTRACTED** (see below)
- `focus-mode.js` — line 7562 → **EXTRACTED** (see below)

---

## EXTRACTED FILES

### storage.js
Lines: external file
Purpose: All localStorage/Firebase persistence, data loading, debounced Today rendering, and cross-device sync helpers with throttled sync-failure feedback, timer sync visibility, and periodic timer/away reconciliation.
Functions: `persist()`, `scheduleRenderToday()`, `numberFromStorage()`, `rememberTimerSyncStamp()`, `currentTimerSyncStamp()`, `remoteTimerSyncStamp()`, `isStaleRemoteTimerState()`, `rememberAwaySyncStamp()`, `currentAwaySyncStamp()`, `remoteAwaySyncStamp()`, `isStaleRemoteAwayState()`, `loadSyncEventLog()`, `syncEventWriterId()`, `syncEventCloudAt()`, `recordSyncEvent()`, `syncEventEscape()`, `renderSyncEventLog()`, `forceSyncNow()`, `reconcileRemoteActiveState()`, `syncDeviceLabel()`, `syncAgeLabel()`, `updateTimerSyncDetail()`, `renderTimerSyncDetail()`, `startSyncDetailAgeTicker()`, `stopSyncDetailAgeTicker()`, `startSyncReconcileTicker()`, `stopSyncReconcileTicker()`, `isLocalFocusTimerActive()`, `syncLocalActiveTimerState()`, `applyRemoteTimerState()`, `applyRemoteAwayState()`, `notifySyncWriteFailed()`, `resolveEntrySync()`, `syncEntries()`, `syncFocusRedemptions()`, `syncPlans()`, `normalizePlanItems()`, `getEntriesForDate()`, `_buildEntriesByDate()`, `getDateInTZ()`, `toDateKey()`, `getWeekKey()`, `tzDow()`, `tzHour()`, `tzParseTime()`
Variables: `_renderTodayPending`, `_lastSyncErrorToastAt`, `_lastTimerSyncDetail`, `_syncDetailAgeTicker`, `_syncReconcileTicker`, `_syncReconcileInFlight`, `_syncEventLog`, `TIMER_SYNC_STAMP_KEY`, `AWAY_SYNC_STAMP_KEY`, `SYNC_EVENT_LOG_KEY`, `SYNC_EVENT_LOG_LIMIT`, `SYNC_RECONCILE_MS`
Depends on: Firebase SDK globals, `focusRedemptions` global, `sumEnergyMinutes()`

### insights.js
Lines: external file
Purpose: Weekly insight computation (deep hours, waste patterns, best day, peak hour).
Functions: `computeInsights(weekKey)`
Variables: (managed internally)
Depends on: `entries` global, `storage.js` helpers, `sumEntryMinutes()`, `sumEnergyMinutes()`

### focus-wallet.js
Lines: external file
Purpose: Pure Focus Wallet scoring rules: compute weekly earned points, waste/sports costs, reward redemption spend, carried negative debt, and current balance.
Functions: `getFocusWalletSettings()`, `getFocusWalletWeekKey()`, `getFocusWalletEntryDurationMin()`, `isFocusWalletSportsEntry()`, `computeFocusWallet()`
Variables: `DEFAULT_FOCUS_WALLET_SETTINGS`
Depends on: no app globals; attaches helpers to `globalThis`

### focus-mode.js
Lines: external file
Purpose: All Pomodoro timer, lo-fi music, focus blocker overlay, and focus task suggestions.
Functions: `canonicalFocusActivity()`, `enterFocusMode()`, `tryExitFocusMode()`, `exitFocusConfirm()`, `confirmExitFocus()`, `syncFocusTimerState()`, `refreshFocusTimerSync()`, `isSyncedFocusMirrorActive()`, `renderSyncedFocusOverlay()`, `syncFocusOverlayFromRemote()`, `clearSyncedFocusOverlay()`, `takeOverSyncedFocusTimer()`, `startPomodoro()`, `getFocusTaskLabel()`, `logFocusSession()`, `saveActiveFocusSession()`, `tickPomodoro()`, `endWorkSession()`, `endPomodoroBreak()`, `skipBreak()`, `playAlertSound()`, `setPomodoroCountdown()`, `renderPomoDots()`, `updateFocusDeepBar()`, `togglePomodoroAutoStart()`, `startFocusMusic()`, `stopFocusMusic()`, `setFocusMusicVolume()`, `toggleFocusPlaylist()`, `selectFocusMusicOff()`, `resumeFocusMusic()`, `_nextTrackIdx()`, `_updateTrackLabel()`, `_startWorkOutro()`, `_enterBreakMusic()`, `_exitBreakMusic()`, `_skipBreakMusic()`, `_effectiveVolume()`, `showFocusBlocker()`, `requestExitFocus()`, `returnToFocus()`, `showFocusSuggestions()`, `hideFocusSuggestions()`, `selectFocusSuggestion()`, `handleFocusKey()`
Variables: `focusModeOn`, `focusBlockCountdown`, `pomodoroPhase`, `pomodoroTimer`, `pomodoroRemaining`, `pomodoroWorkMin`, `pomodoroBreakMin`, `pomodoroCount`, `focusStartTime`, `pomodoroPhaseStartedAt`, `pomodoroWasPaused`, `_lastFocusSyncAt`, `_pomodoroAutoStart`, `_focusMusicVolume`, `_lofiTrackIdx`, `_shuffleMode`, `_shuffleQueue`, `_inBreakMode`, `_outroActive`, `_focusSugIndex`, `_LOFI_TRACKS`, `_BREAK_TRANSITION`, `_BREAK_LOOP`, `_OUTRO_LEAD_SEC`, `FOCUS_SYNC_REFRESH_MS`
Depends on: `entries`, `settings`, `running`, `ticker`, `blockStartTime`, `currentTask`, `intention`, `lastTaskForRepeat`, `timerStartedAt`, `totalSecs`, `remaining`, `dailyCommitment`, `persist()`, `syncEntries()`, `syncTimerState()`, `showToast()`, `resetTimer()`, `getTodayEntries()`, `getActivityColor()`, `toDateKey()`, `fmtDur()`, `getBucket()`, `renderToday()`, `updateRing()`, `doPing()`, `buildHeroSuggestions()`, `buildSugItem()`, `canonicalizeActivityInput()`, `_startHeartbeat()`, `_stopHeartbeat()`

---

## CSS SECTIONS

## [CSS — Base & Layout]
Lines: 1–46
Purpose: CSS custom properties (color tokens, spacing), body reset, scrollbar.
Functions: —
Variables: `--deep`, `--bg`, `--bg2`–`--bg4`, `--border`, `--border2`, `--muted`, `--muted2`, `--text`, `--head`, `--mono`, `--r`, `--safe-bottom`, `--ring-sz`, `--distraction`, `--waste`, `--recovery`, `--exercise`, `--errands`
Depends on: —

## [CSS — Component Styles]
Lines: 47–983
Purpose: All visual styling for nav, timer ring, entry rows, modals, overlays, hero states, week view, reflect view, settings, focus overlay, onboarding.
Functions: —
Variables: (animations) `shake`, `tickAnim`, `slideInEntry`, `lpPulse`
Depends on: CSS base variables

## [CSS — Desktop Panels]
Lines: 985–1014
Purpose: Side panel cards (`#left-panel`, `#side-panel`) and the `@media(min-width:1100px)` grid that activates them.
Functions: —
Variables: `.sp-card`, `.sp-label`
Depends on: —

---

## HTML SECTIONS

## [HTML — Today View]
Lines: 1020–1332
Purpose: All markup for the Today tab: header with date picker, status banner, day bar, hero section (idle/active/away states), Today Plan strip with generated morning startup state, contextual next-action strip, Today Health strip, Gap Recovery inbox, Routine Prompt card, Daily Basics quick logs, Focus Wallet card, same-as-last CTA, sleep pill, quick-retro bar, awareness signal, timeline, stat cards, recent entries list.
Functions: —
Key IDs: `view-today`, `today-date`, `date-picker-dropdown`, `today-details-toggle`, `status-banner`, `active-device-banner`, `active-device-title`, `active-device-detail`, `active-device-takeover-btn`, `day-bar`, `activity-hero`, `hero-idle`, `hero-active`, `hero-away`, `plan-strip`, `morning-startup`, `plan-task`, `today-action-strip`, `today-action-title`, `today-action-primary`, `today-health`, `gap-recovery`, `routine-prompt`, `daily-basics`, `daily-basics-grid`, `missed-closeout-card`, `closeout-card`, `focus-wallet-card`, `same-as-last-btn`, `sleep-pill-btn`, `quick-retro-bar`, `awareness-signal`, `timeline-section`, `timeline-blocks`, `timeline-date-label`, `timeline-summary`, `recent-entries-section`, `recent-list`
Depends on: —

## [HTML — Week / Reflect / Settings Views]
Lines: 1335–1587
Purpose: Markup for the Week tab (day tabs, energy split, top activities), Reflect tab (honest summary, week comparison, reflections, weekly review), and Settings tab (timezone, intervals, presets, data management, performance readout).
Functions: —
Key IDs: `view-week`, `view-reflect`, `view-settings`, `reflect-streak-cal` (streak cal mount), `reflect-heatmap` (heatmap mount), `sync-now-btn`, `sync-event-log`, `data-doctor-results`, `perf-debug-results`, `app-build-label`
Depends on: —

## [HTML — Desktop Side Panels]
Lines: 1579–1613
Purpose: Left panel (60-day streak calendar) and right panel (plan progress, energy breakdown, week bars, streaks, heatmap) shown only on ≥1100px screens.
Functions: —
Key IDs: `left-panel`, `side-panel`, `sp-status-content`, `sp-day-bar`, `sp-energy-bars`, `sp-week-bars`, `sp-streak-content`
Depends on: —

## [HTML — Overlays & Modals]
Lines: 1616–1812
Purpose: Sign-in overlay, bottom nav, quick-log ping modal, pre-commit modal (task naming before starting timer), Focus Wallet reward-log modal.
Functions: —
Key IDs: `signin-overlay`, `nav`, `quicklog-overlay`, `precommit-overlay`, `focus-wallet-overlay`
Depends on: —

## [HTML — Focus Mode Overlays]
Lines: 1813–1900
Purpose: Focus block overlay (shows when user leaves focus mode) and focus overlay (Pomodoro timer UI, music controls, task input).
Functions: —
Key IDs: `focus-block-overlay`, `focus-overlay`, `focus-task-input`, `focus-suggestions`, `focus-countdown`, `focus-pomo-dots`, `focus-music` (audio element)
Depends on: focus-mode.js

## [HTML — Review, Sleep, Away, Break, Sync Modals]
Lines: 46–1346
Purpose: Review/reflections/sleep overlay HTML plus related header/away controls and the install/recovery prompts.
Functions: —
Key IDs: `review-overlay`, `rv-closeout-summary`, `rv-unlogged-decision`, `sleep-reminder-overlay`, `away-picker`, `break-modal`, `hdr-menu`, `reflections-history-overlay`
Depends on: —

---

## JAVASCRIPT SECTIONS

## [State — Global Variables]
Lines: 1353–1423
Purpose: All top-level mutable state and one-time constants shared across the entire app.
Functions: —
Variables: `APP_BUILD`, `currentTask`, `viewingDateKey`, `entries`, `settings`, `reviews`, `weeklyReviews`, `focusRedemptions`, `intention`, `running`, `ticker`, `pcTimeLiveTicker`, `totalSecs`, `remaining`, `distractionDebt`, `pingCount`, `sortKey`, `sortDir`, `selectedEnergy`, `selectedOnPlan`, `QUICK_ACTIVITY_OPTIONS`, `COMMON_LOG_OPTIONS`, `GAP_RECOVERY_OPTIONS`, `ROUTINE_PROMPTS`, `blockStartTime`, `lastStateChange`, `currentState`, `blockSegments`, `focusExitTimer`, `fbApp`, `fbDb`, `fbRoomRef`, `roomCode`, `fbTimerReceived`, `currentUser`, `timerStartedAt`, `snoozesUsedToday`, `snoozeTimer`, `quickLogBusy`, `switchingTask`, `dailyCommitment`, `lastTaskForRepeat`, `breakActive`, `breakEndsAt`, `breakTicker`, `breakStartTs`, `timerOwnerDeviceId`, `syncedFocusTimer`, `awayActive`, `awayStartTime`, `awayLabel`, `continueBannerTimer`, `continueBannerCountdown`, `recentChipTasks`, `taskStartTime`, `awayElapsedTicker`, `lastUndoAction`, `CIRCUM`
Depends on: —

## [Undo — Last Action]
Lines: ~1447–1549
Purpose: One-slot in-memory undo for deliberate daily actions. Created entries/redemptions are tombstoned; deleted/extended entries are restored from snapshots with newer sync stamps.
Functions: `cloneUndoValue()`, `sameUndoId()`, `rememberUndoAction()`, `rememberCreatedUndo()`, `rememberRestoreEntriesUndo()`, `tombstoneUndoEntries()`, `restoreUndoEntries()`, `tombstoneUndoRedemptions()`, `undoLastAction()`, `showUndoToast()`
Variables: `lastUndoAction`
Depends on: `entries`, `focusRedemptions`, `persist()`, `scheduleRenderToday()`, `renderWeek()`, `renderWeekTable()`, `syncEntries()`, `syncFocusRedemptions()`, `showToast()`

## [Timer — Core Interval Tracking]
Lines: 2197–2476
Purpose: Start/stop/reset the 30-min countdown ring, pre-commit modal for naming tasks, state switching, coverage-context display annotation, heartbeat, and the `beforeunload` guard.
Functions: `fmt()`, `normalizeActivity()`, `activityBaseName()`, `activityGroupKey()`, `activityDisplayLabel()`, `preferActivityLabel()`, `canonicalActivityBase()`, `canonicalizeActivityInput()`, `expandPCTimeEntries()`, `isPcTimeEntry()`, `overlapMs()`, `displayEntryIds()`, `exactDisplayDuplicateKey()`, `collapseExactDuplicatesForDisplay()`, `entryMatchesScheduleTemplate()`, `entryMatchesPlanItem()`, `isScheduleOrPlanBlock()`, `isRecurringCoverageBlock()`, `isLegacyJobCoverageBlock()`, `isCoverageContextBlock()`, `annotateCoverageContextForDisplay()`, `squashTinyPCTimeFragments()`, `fmtDur()`, `updateRing()`, `toggleTimer()`, `continueLastTask()`, `switchToNewTask()`, `confirmPreCommit()`, `updateTimerTaskLabel()`, `_startTimer()`, `switchState()`, `playAlert()`, `resetTimer()`, `stopAndLog()`, `switchTaskMidBlock()`
Variables: `CIRCUM` (314.2 SVG circumference)
Depends on: State globals, `persist()`, `syncEntries()`, `showToast()`, `renderToday()`, Firebase sync section

## [Break Tracking]
Lines: 2553–2760
Purpose: Break modal, custom/preset break durations, countdown display, early break end.
Functions: `openBreakModal()`, `startBreakCustom()`, `startBreak()`, `_updateBreakDisplay()`, `endBreak()`
Variables: `breakActive`, `breakEndsAt`, `breakTicker`, `breakStartTs`
Depends on: Timer section (`resetTimer`, `running`), `renderToday()`

## [Ping & Quick-Log Modal]
Lines: 2761–2957
Purpose: Ping delivery (sound + modal), PC Time live tracking, quick-log UI (same-as-last, energy chips, full form), snooze, behavioral feedback flash.
Functions: `stopAlertLoop()`, `showPingBanner()`, `hidePingBanner()`, `doPing()`, `startPCTimeLive()`, `stopPCTimeLive()`, `autoLogBlock()`, `openQuickLog()`, `setQlEnergy()`, `populateQlChips()`, `showQuickForm()`, `quickSaveLast()`, `renderQuickLogPlan()`, `quickSaveFromPlan()`, `saveQuickEntry()`, `learnWastePattern()`, `_doQuickSave()`, `dismissQuickLog()`, `snoozeLog()`, `showLogFeedback()`, `fireBehavioralFeedback()`

⚠ The ping only fires **mid-block** (`openQuickLog()` returns early unless `running || blockStartTime`),
so the plan chips here mean "was this block one of your planned items?" — not "go start your plan".
Logging through a chip writes the **exact** planned label, which is what makes `planTrackedMin()`
match reliably instead of missing a hand-typed variant. `quickSaveFromPlan()` asks for a category
rather than guessing when the task has no logging history (`inferPlanEnergy()` returns null).
Variables: `alertLoop`, `qlEnergy`, `quickLogBusy`, `snoozesUsedToday`, `snoozeTimer`, `_feedbackTimer`
Depends on: Timer section, State globals, `persist()`, `syncEntries()`, `entries`, `renderToday()`, `showToast()`, Native notifications section

## [Today Plan]
Lines: ~5050–5190
Purpose: The 1–3 daily intentions that drive execution — the single daily target. Renders the
plan strip (which replaced the old commit-bar), enforces the 3-item WIP cap, wires one-tap start,
and derives evidence of "done" from actually-tracked entries rather than a self-reported checkbox.
Functions: `planTodayKey()`, `normalizePlanTask()`, `getPlanItems()`, `getPlanItemsRaw()`,
`createPlanItem()`, `syncCommitmentFromPlan()`, `syncIntentionFromPlan()`, `inferPlanEnergy()`, `savePlanItems()`,
`planTrackedMin()`, `fmtPlanMin()`, `isPlanTaskActive()`, `getPlanItemStatus()`,
`getActivePlanItem()`, `getNextPlanItem()`, `renderMorningStartup()`, `setMorningPlan()`,
`renderTodayPlan()`, `addPlanItem()`, `removePlanItem()`, `togglePlanDone()`,
`startPlanItem()`, `startNextPlanItem()`
Variables: `PLAN_MAX` (3), `MORNING_PLAN_PRESETS`, `plans` (state global)
Depends on: `getEntriesForDateWindow()`, `entryDurationMinutes()`, `getViewingDateKey()`,
`isViewingToday()`, `getDateInTZ()`, `_startTimer()`, `switchToTask()`, `persist()`,
`showToast()`, `renderTodayActionStrip()`, `syncPlans()` + `normalizePlanItems()` (storage.js)

⚠ `renderTodayPlan()` is called **directly** by every mutation — never routed through
`renderToday()`, whose `_todayRenderKey` cache only tracks entries and would silently swallow
plan edits.

⚠ Removed items are **tombstoned** (`deleted:true`), not spliced — a hard delete gets resurrected
by the per-item sync merge on the next inbound snapshot.

⚠ `dailyCommitment` is now **derived** (= today's plan item count), not user-set; the daily
commitment modal was retired (the plan is the target). `focus-mode.js:110` still reads
`dailyCommitment` for the focus deep bar, so the global must keep existing.

## [Focus Wallet]
Lines: 2173–2353
Purpose: Weekly Focus Wallet UI bridge: compute current balance from entries/redemptions, render the Today card and reward modal, create linked time entries + wallet redemptions, and allow negative focus debt.
Functions: `getCurrentFocusWallet()`, `formatFocusPoints()`, `focusWalletEscape()`, `renderFocusWallet()`, `openFocusWallet()`, `selectFocusRewardPreset()`, `getFocusRewardEndTs()`, `renderFocusRewardPreview()`, `logFocusReward()`
Variables: `focusRedemptions`
Depends on: `computeFocusWallet()`, `getDateInTZ()`, `getWeekKey()`, `tzHHMM()`, `tzParseTime()`, `normalizeActivity()`, `getBucket()`, `validateEntry()`, `persist()`, `syncEntries()`, `syncFocusRedemptions()`, `showToast()`

## [Heartbeat / Session Persistence]
Lines: 3000–3068
Purpose: Write a heartbeat timestamp every 15 s so unexpected-close can be detected on next open; `beforeunload` guard warning.
Functions: `_startHeartbeat()`, `_stopHeartbeat()`
Variables: `_heartbeatTicker`
Depends on: `running`, localStorage

## [View Management]
Lines: 3070–3087
Purpose: Tab switching — activate the correct view div, highlight the nav button, trigger view-specific renders.
Functions: `showView()`
Variables: —
Depends on: `renderToday()`, `renderWeek()`, `renderSettings()`

## [Utility — Formatting & Quick Actions]
Lines: 3084–3160
Purpose: Recent-log helpers, quick-action grid rendering, entry-time aggregation, energy label formatting.
Functions: `getRecentLogOptions()`, `formatEnergyLabel()`, `renderQuickActionGrid()`, `renderRecentTaskGrid()`, `saveLogChoice()`, `getTimeByActivity()`
Variables: `QUICK_ACTIVITY_OPTIONS`
Depends on: `entries`, `persist()`

## [Entry Logging & Editing]
Lines: 3088–3521
Purpose: Full retro log modal — open, energy selection, time-range inputs, save new entry, edit existing entry, delete entry with immediate active-view refresh, merge-edit multiple entries.
Functions: `openLog()`, `saveLastEntry()`, `showLogForm()`, `entryIdJsArg()`, `sameEntryId()`, `populateRetroChips()`, `openRetroLog()`, `setRetroEnergy()`, `saveRetroEntry()`, `dismissLog()`, `setEnergy()`, `setOnPlan()`, `toggleDetail()`, `saveEntry()`, `isSameDeletionTarget()`, `isViewActive()`, `refreshAfterEntryDelete()`, `persistEntryDeleteAfterPaint()`, `deleteEntry()`, `openRetroLogPrefilled()`, `openEditEntry()`, `openEditMergedEntry()`, `cancelRetroEdit()`, `renderEntryRow()`, `renderGapRow()`, `renderTimelineCombined()`, `toggleTlBucket()`
Variables: `retroEnergy`, `editingEntryId`, `editingMergedIds`, `editingEntryBase`, `logIsPing`, `tlExpandedBuckets`
Depends on: `entries`, `persist()`, `syncEntries()`, `showToast()`, `renderToday()`, `getActivityColor()`, `toDateKey()`, `getBucket()`

## [Date Picker & Navigation]
Lines: 3547–3613
Purpose: Browse past days in the Today view — get/set viewing date, navigate by delta, build the 14-day dropdown list.
Functions: `getViewingDateKey()`, `getViewingEntries()`, `clipEntryToDateForDisplay()`, `getEntriesForDateWindow()`, `isViewingToday()`, `dayEndTs()`, `setViewDate()`, `navigateDateBy()`, `toggleDatePicker()`
Variables: `viewingDateKey`
Depends on: `entries`, `getDateInTZ()`, `entryTimeRange()`, `tzParseTime()`, `_dateKeyPlusDays()`, `renderToday()`

## [Statistics & Scoring]
Lines: 3025–3124
Purpose: Per-array metrics: deep score %, overlap-safe duration/deep-hour helpers, consecutive-day streaks, identity score + level label.
Functions: `computeDeepScore()`, `_dateKeyPlusDays()`, `entryDurationMinutes()`, `entryTimeRange()`, `sumEntryMinutes()`, `sumEnergyMinutes()`, `computeDeepHrs()`, `computeStreak()`, `computeCleanStreak()`, `computeIdentityScore()`, `getIdentityLevelWithEmoji()`
Variables: —
Depends on: `entries`, `getDateInTZ()`, `toDateKey()`

## [Activity Color Management]
Lines: 3663–3705
Purpose: Assign and retrieve a stable hex color per custom activity name; persist color map.
Functions: `getActivityColor()`
Variables: `ACTIVITY_PALETTE`, `eLabel`
Depends on: `settings`, `persist()`

## [Timeline Helpers]
Lines: 3706–3853
Purpose: Work-day start detection, timeline display preprocessing — overlap clipping, consecutive-entry merging, gap computation, scroll-to.
Functions: `getWorkDayStartTs()`, `clipOverlapsForDisplay()`, `displayEntryIds()`, `exactDisplayDuplicateKey()`, `collapseExactDuplicatesForDisplay()`, `mergeConsecutiveForDisplay()`, `displayLoggedBlockCount()`, `computeGaps()`, `scrollToTimeline()`, `scrollToFirstEnergy()`, `localTime()`
Variables: —
Depends on: `entries`, `settings` (timezone)

## [Today View — Rendering]
Lines: 3901–4945
Purpose: Main `renderToday()` and all its sub-renders: day bar, status banner, Today Health strip, Focus Wallet card, timeline (blocks + gaps), stat cards, recent entries list, contextual-visibility rules, hero state machine, same-as-last CTA, awareness signal, side-panel refresh trigger, render performance checkpoints.
Functions: `renderToday()`, `isTodayDetailsOpen()`, `setTodayDetailsOpen()`, `applyTodayDetailsMode()`, `toggleTodayDetails()`, `shouldRenderOnDateTick()`, `renderTodayOnDateChange()`, `getCloseoutGaps()`, `computeCloseoutSummary()`, `closeoutSummaryParts()`, `closeoutTimeValue()`, `closeoutTimeMinutes()`, `closeoutCutoffTs()`, `isCloseoutDue()`, `nextUnreviewedCloseoutDateKey()`, `openCloseoutReview()`, `missedCloseoutDateKey()`, `getMissedCloseout()`, `openMissedCloseoutReview()`, `renderMissedCloseoutCta()`, `renderCloseoutCta()`, `computeTodayHealth()`, `renderTodayHealth()`, `getGapRecoveryCandidate()`, `renderGapRecoveryInbox()`, `routinePromptStorageKey()`, `getDismissedRoutinePrompts()`, `markRoutinePromptDismissed()`, `routinePromptWindow()`, `routinePromptAlreadyLogged()`, `getRoutinePromptCandidate()`, `renderRoutinePrompt()`, `focusTodayPlanInput()`, `renderTodayActionStrip()`, `renderReviewCloseoutSummary()`, `renderReviewUnloggedDecision()`, `markReviewUnloggedIntentional()`, `openReviewFirstGap()`, `renderDayBar()`, `renderStatusBanner()`, `getActiveTimerOwnerSnapshot()`, `renderActiveDeviceBanner()`, `takeOverActiveTimer()`, `applyContextualVisibility()`, `showHeroState()`, `getContextualPrompt()`, `updateHeroPrompt()`, `setStatVal()`, `renderRecentChips()`, `useChip()`, `renderDailyBasics()`, `quickLogCommon()`, `logCommonActivity()`, `quickLogRoutinePrompt()`, `dismissRoutinePrompt()`, `currentGapRecoveryRange()`, `fillGapRecovery()`, `openGapRecoveryOther()`, `logGapRecoveryActivity()`, `renderSidePanel()`, `renderLeftPanel()`
Variables: `_todayRenderKey`, `_lastTodayDateKey`, `_lastLoggedEntryId`
Depends on: Timeline helpers, Statistics (including `sumEntryMinutes()` / `sumEnergyMinutes()`), Entry logging, Date picker, Focus Wallet, `persist()`

## [Hero Prompt & Task Suggestions]
Lines: 4950–5046
Purpose: "Name your task" hero input — start timer from hero, suggestion dropdown (recent + presets), keyboard navigation, dismiss individual suggestions.
Functions: `startFromHero()`, `buildHeroSuggestions()`, `buildSugItem()`, `hideActivitySuggestion()`, `showHeroSuggestions()`, `hideHeroSuggestions()`, `selectHeroSuggestion()`, `handleHeroKey()`
Variables: `_heroSugIndex`
Depends on: Timer section (`_startTimer`), `settings`, `entries`

## [Retro Log Suggestions]
Lines: 4886–4943
Purpose: Suggestion dropdown for the retroactive log modal's activity input, with auto-energy inference from past usage.
Functions: `showRetroSuggestions()`, `hideRetroSuggestions()`, `selectRetroSuggestion()`, `handleRetroKey()`
Variables: `_retroSugIndex`
Depends on: `buildHeroSuggestions()`, `buildSugItem()`, Entry logging section

## [Quick-Retro Bar]
Lines: 4944–5162
Purpose: The inline "log a past block" bar on the Today tab — text + time inputs, suggestion dropdown with waste-pattern hints, save handler.
Functions: `showQuickRetroSuggestions()`, `hideQuickRetroSuggestions()`, `selectQuickRetroSuggestion()`, `handleQuickRetroKey()`, `quickRetroLog()`
Variables: `_quickRetroSugIndex`
Depends on: `buildHeroSuggestions()`, `buildSugItem()`, `entries`, `persist()`, `syncEntries()`, `renderToday()`

## [Task Switching Panel]
Lines: 5023–5092
Purpose: In-hero switch-task panel (filter list of recent tasks, confirm switch mid-block).
Functions: `openSwitchPanel()`, `renderSwitchList()`, `fillSwitch()`, `filterSwitchList()`, `confirmSwitch()`, `switchToTask()`
Variables: `_switchTasks`
Depends on: Timer section (`switchTaskMidBlock`), `entries`

## [Quick-Log Special Shortcuts]
Lines: 5162–5266
Purpose: One-tap shortcuts on the Today tab — "log same as last" button and the sleep quick-log pill.
Functions: `quickLogSameAsLast()`, `getQuickSleepWindow()`, `quickLogSleep()`
Variables: —
Depends on: `entries`, `persist()`, `syncEntries()`, `renderToday()`, `showToast()`

## [Away & Status Management]
Lines: 5267–5415
Purpose: Header menu toggle, idle away-picker dropdown, toggle away on/off, start named away session (Sleep, Eat, Walk, etc.) with elapsed ticker.
Functions: `toggleHdrMenu()`, `toggleIdleAwayPicker()`, `toggleAway()`, `startAway()`, `showContinueBanner()`, `hideContinueBanner()`, `doContinueBlock()`, `doSwitchFromBanner()`
Variables: `awayActive`, `awayStartTime`, `awayLabel`, `awayElapsedTicker`, `continueBannerTimer`, `continueBannerCountdown`
Depends on: `persist()`, `syncEntries()`, `renderToday()`, `entries`

## [Week View]
Lines: 5427–6009
Purpose: Week and month overview — day tab navigation, energy split chart, top-activities list, untracked-hours summary, sortable entries table, single-day detail drilldown, and shareable weekly accountability summary.
Functions: `renderWeek()`, `setWeekMode()`, `shiftRange()`, `selectWeekDay()`, `renderMonthOverview()`, `entryMins()`, `renderEnergySplit()`, `renderTopActivities()`, `renderUnloggedHours()`, `weekShareDuration()`, `weekShareRangeLabel()`, `weekShareAppUrl()`, `weekShareUnloggedMinutes()`, `weekShareTopActivities()`, `weekShareSignal()`, `buildWeekShareSummary()`, `getCurrentWeekShareSummary()`, `openWeekShare()`, `copyWeekShareText()`, `copyWeekShare()`, `nativeShareWeek()`, `renderEntryList()`, `renderWeekOverview()`, `renderDayDetail()`, `renderWeekTable()`, `sortBy()`
Variables: `weekSelectedDay`, `weekRangeOffset`, `_weekShareText`, `sortKey`, `sortDir`
Depends on: `entries`, Statistics section, `getDateInTZ()`, `toDateKey()`, `computeInsights()`

## [Sleep Tracking]
Lines: 6083–6211
Purpose: Sleep reminder logic, sleep-setup modal, sleep entry logging, duration formatting.
Functions: `makeDateAtTime()`, `prevDateKey()`, `getSleepDefaults()`, `fmtSleepDur()`, `logSleepEntry()`, `checkSleepSetup()`, `saveSleepSetup()`, `skipSleepSetup()`, `checkSleepReminder()`, `openSleepReminder()`, `confirmSleepLog()`, `snoozeSleepReminder()`
Variables: —
Depends on: `entries`, `settings`, `persist()`, `renderToday()`

## [Day Review Modal]
Lines: ~6665–7335
Purpose: Open and save the end-of-day reflection for any date; render yesterday's waste-trap
accountability banner; format week labels and save timestamps. `checkReviewPrompt()` auto-opens
this at `settings.reviewTime` (default 22:00); morning times such as 08:00 make the prior
calendar day due the next morning for graveyard-shift closeout. **This is the daily habit hook
the whole plan loop hangs on.**
Functions: `openReview()`, `saveReview()`, `renderYesterdayPromise()`, `formatWeekLabel()`, `formatSavedAt()`, `computeDailySummary()`, `renderDailySummary()`, `checkReviewPrompt()`
Variables: `_reviewDateKey`, `_reviewUnloggedOk`
Depends on: `reviews`, `plans`, `entries`, `persist()`, `renderToday()`, Review Plan Picker, Statistics section

⚠ `applyPromiseAsIntention()` and the banner's "Set focus" row were **retired** — the Today Plan
strip owns "what you said you'd do today". The banner now renders only yesterday's waste traps and
avoid strategy. `saveReview()` writes `plans[reviewedDay + 1]` and keeps `reviews[k].tomorrow`
populated (joined item labels) so Reflect history and older records still render.

## [Review Plan Picker]
Lines: ~6210–6360
Purpose: Turns the review's single "Tomorrow's focus" string into the 1–3 item plan the next day
runs on. Offers one-tap chips (unfinished items from the reviewed day, this week's p1/p2/p3, recent
tasks), shows a reference-class line, and renders plan-vs-actual for the day being reviewed.
Functions: `reviewPlanTargetKey()`, `openReviewPlan()`, `reviewPlanVisible()`, `reviewPlanChips()`,
`reviewPlanReferenceLine()`, `renderReviewPlan()`, `pushReviewPlanItem()`, `addReviewPlanItem()`,
`addReviewPlanChip()`, `removeReviewPlanItem()`, `renderReviewPlanVsActual()`
Variables: `_reviewPlanDraft` (carries tombstones), `_reviewPlanTargetKey`
Depends on: Today Plan section, `weeklyReviews`, `buildHeroSuggestions()`, `sumEnergyMinutes()`,
`tzDow()`, `tzParseTime()`, `_dateKeyPlusDays()`, `getWeekKey()`

⚠ Unfinished items from the reviewed day are **offered as chips, never auto-added**. Auto-carrying
them into a 3-capped list would make it impossible to plan on a bad day — the same deadlock the
original "circle of tasks" design had.

⚠ `_reviewPlanDraft` holds tombstoned items so a removal made in the review still propagates
through the per-item sync merge.

## [Reflect View]
Lines: 6465–7085
Purpose: Reflect tab render — honest summary card, week-over-week comparison, streak calendar (60-day heatmap), focus heatmap (hour×day), daily reflection cards, reflections history modal.
Functions: `renderReflectView()`, `renderHonestSummary()`, `renderWeekComparison()`, `renderStreakCalendar()`, `renderFocusHeatmap()`, `renderDailyReflections()`, `openReflectionsHistory()`, `renderReflectHistory()`, `saveWeeklyReview()`, `saveWeeklyPlan()`
Variables: —
Depends on: `entries`, `reviews`, `weeklyReviews`, Statistics section, `computeInsights()`, `getDateInTZ()`, `tzDow()`, `tzHour()`

## [Day Templates]
Lines: 6729–6910
Purpose: Recurring block templates, selected-day Settings skeleton editor, modal task/day add form, content-sized hourly weekly calendar, 30-minute blank-slot calendar creation, Today-row template actions, optional auto-log after scheduled end, and template suppression against real/deleted entries.
Functions: `generateTemplateEntries()`, `findTemplateById()`, `openTemplateLog()`, `templateSlotRange()`, `hhmmToMinutes()`, `minutesToHHMM()`, `addMinutesHHMM()`, `normalizeTemplateDays()`, `sameTemplateDays()`, `dayTemplateLabel()`, `dayTemplateFullLabel()`, `selectedDayTemplateDay()`, `templateEnergyColor()`, `templateTaskChoice()`, `templatesForDay()`, `templateItemsForDay()`, `renderDayTemplatePanel()`, `resetTemplateForm()`, `selectTemplateTaskChoice()`, `applyTemplateTaskChoice()`, `showTemplateForm()`, `hideTemplateForm()`, `cancelTemplateEdit()`, `startTemplateBlockForDay()`, `startTemplateBlockAt()`, `startTemplateBlockForSelectedDay()`, `templateDuplicateKey()`, `findDuplicateTemplate()`, `templateSkippedOnDate()`, `skipTemplateOnDate()`, `autoTemplateEntryId()`, `templateSlotCovered()`, `autoLogDueTemplates()`, `entryCoversTemplateSlot()`, `scheduleTemplateDiffersFromEntry()`, `updateTemplateFromEntry()`, `maybeOfferTemplateUpdate()`, `renderTemplateList()`, `toggleTplDay()`, `persistTemplatesAfterPaint()`, `addTemplate()`, `editTemplate()`, `removeTemplate()`
Variables: `_editingTplIdx`
Depends on: `settings`, Date Picker, `entries`, `persist()`, `renderToday()`, Firebase sync

## [Settings View]
Lines: 6010–6092
Purpose: Render settings form (timezone, ping interval, deep-work goal, presets, coach tone, exit delay, review hour, sleep times, sync, account, activity cleanup); save handler; add/remove presets.
Functions: `activityOutputSuffix()`, `activityWithCanonicalLabel()`, `chooseActivityCleanupCanonical()`, `getActivityCleanupGroups()`, `renderActivityCleanup()`, `setActivityCleanupCanonical()`, `applyActivityCleanup()`, `renderSettings()`, `saveSettings()`, `addPreset()`, `removePreset()`, `renderTonePreview()`
Variables: `TONE_PREVIEWS`
Depends on: `settings`, `persist()`, `syncEntries()`, Firebase auth section

## [Sync & Firebase UI]
Lines: 7086–7105
Purpose: Sync connect button, instructions toggle, live cost display update.
Functions: `toggleSyncInstructions()`, `connectSync()`, `updateLiveCost()`
Variables: —
Depends on: `fbDb`, `fbRoomRef`, storage.js sync helpers

## [Overlay, Toast & Modal Utilities]
Lines: 7106–7181
Purpose: Generic close-modal helper, background-click close, and toast notification (with optional undo action).
Functions: `closeModal()`, `overlayClose()`, `toastBorderColor()`, `showToast()`, `showActionToast()`
Variables: `_toastTimer`
Depends on: Undo section (`lastUndoAction`, `undoLastAction()`)

## [Export & Data Management]
Lines: 7138–7657
Purpose: Data Doctor scan/repair for duplicate and suspicious records, CSV export, clear-all entries (with confirm), clear a single selected day, and in-memory performance timing for expensive renders.
Functions: `dataDoctorEscape()`, `dataDoctorIssueEntry()`, `dataDoctorDuplicateKey()`, `dataDoctorAddDayMinutes()`, `dataDoctorAddDayInterval()`, `dataDoctorKeepScore()`, `dataDoctorChooseOverlapLoser()`, `dataDoctorFindOverflowOverlaps()`, `scanDataDoctorEntries()`, `dataDoctorEntryLine()`, `dataDoctorList()`, `getDataDoctorExactDuplicateIndexes()`, `getDataDoctorDuplicateIdExtraIndexes()`, `getDataDoctorFlaggedIndexes()`, `renderDataDoctorResults()`, `runDataDoctor()`, `repairDataDoctorMetadata()`, `repairDataDoctorDuplicates()`, `repairDataDoctorFlaggedEntries()`, `exportCSV()`, `clearAll()`, `clearSelectedDay()`, `clearTodayOnly()`, `perfNow()`, `shouldRenderPerfDebug()`, `recordPerfSample()`, `recordPerfStage()`, `renderPerfDebug()`, `perfWrap()`, `installPerfInstrumentation()`
Variables: `PERF_SLOW_LIMITS`, `PERF_LABELS`, `PERF_GROUPS`, `perfStats`, `perfSlowEvents`
Depends on: `entries`, `persist()`, `syncEntries()`, `renderToday()`, `renderWeek()`, `scanDataDoctorEntries()`

## [PWA Installation]
Lines: 7202–7228
Purpose: Service Worker registration, PWA install-prompt banner, iOS install hint, `beforeinstallprompt` capture.
Functions: `showInstallBanner()`, `installApp()`, `dismissInstall()`
Variables: `isIOS`, `isStandalone`, `installDismissed`, `deferredPrompt`, `_swReg`
Depends on: Service Worker scheduler section

## [Voice Input]
Lines: 7229–7270
Purpose: Voice-recognition entry logging (Web Speech API → parse activity + energy keywords).
Functions: `startVoiceLog()`
Variables: `VOICE_ENERGY_KEYWORDS`
Depends on: Entry logging section, `saveRetroEntry()`

## [Heartbeat Crash Detection]
Lines: 7309–7346
Purpose: On app load, check for unclean shutdown (heartbeat timestamp in localStorage without proper reset) and offer to log the lost time.
Functions: (IIFE — runs once on load)
Variables: —
Depends on: `entries`, `persist()`, `renderToday()`

## [Native Notifications (Capacitor)]
Lines: 7347–7495
Purpose: Capacitor `LocalNotifications` setup, schedule/cancel ping notifications, schedule follow-up notification after task start.
Functions: `initNativeNotifications()`, `scheduleNativePing()`, `scheduleFollowUpPing()`, `cancelNativePing()`
Variables: `isNative`, `LocalNotifications`, `PING_NOTIF_ID`, `PING_FOLLOWUP_ID`, `followupNotifTimer`
Depends on: Capacitor plugin globals

## [URL Scheme / Deep Link Handler]
Lines: 7496–7546
Purpose: Handle `chronasense://` URLs opened from notifications or other apps (start timer, open quick log, set task).
Functions: `handleDeepLink()`, `initUrlSchemeHandler()`
Variables: `isMobileBrowser`
Depends on: Timer section, Ping section, Capacitor `App` plugin

## [Service Worker Ping Scheduler]
Lines: 7547–7587
Purpose: Post messages to the Service Worker to schedule or cancel the next ping alarm.
Functions: `swSchedulePing()`, `swCancelPing()`
Variables: `_swReg`
Depends on: PWA Installation section

## [Onboarding]
Lines: 7588–7726 (first script) + HTML between scripts + second script init
Purpose: 5-step onboarding overlay shown on first visit — step navigation, step rendering, completion handler.
Functions: `openOnboarding()`, `closeOnboarding()`, `obNext()`, `_renderObStep()`
Variables: `_obStep`, `OB_STEPS`
Depends on: `persist()`, `showView()`

## [Phone Usage Tracking (Android)]
Lines: 7727–7895
Purpose: Request Android UsageStats permission, poll app-usage events, reconstruct sessions from FOREGROUND/BACKGROUND events, auto-log sessions above minimum duration.
Functions: `initPhoneUsageTracking()`, `getUsageStatsPlugin()`, `showPhoneUsageBanner()`, `requestPhoneUsagePermission()`, `syncPhoneUsage()`, `buildSessions()`
Variables: `TRACKED_APPS`, `PHONE_USAGE_KEY`, `MIN_SESSION_MS`
Depends on: `autoLogBlock()`, `entries`, `persist()`, Capacitor plugin globals

---

## QUICK LOOKUP TABLE

| I want to change… | Read section | Lines |
|---|---|---|
| Timer ring / countdown display | Timer — Core Interval Tracking | 2197–2476 |
| Pre-commit modal (name task before starting) | Timer — Core Interval Tracking | 2197–2476 |
| Break timer (5/15/30 min breaks) | Break Tracking | 2477–2554 |
| Ping sound / ping modal (same-as-last, quick chips) | Ping & Quick-Log Modal | 2555–2960 |
| Behavioral feedback flash after logging | Ping & Quick-Log Modal | 2555–2960 |
| Today's 1–3 plan / plan strip / WIP cap | Today Plan | ~5050–5190 |
| Daily target (now = plan item count) | Today Plan → `syncCommitmentFromPlan()` | ~5080 |
| Plan-vs-actual tracked minutes | Today Plan → `planTrackedMin()` | ~5095 |
| Focus Wallet points / weekend rewards | Focus Wallet + focus-wallet.js | 2173–2353 + EXTRACTED |
| Crash/heartbeat recovery on reopen | Heartbeat / Session Persistence | 2985–3065 |
| Tab switching (Today / Week / Reflect / Settings) | View Management | 3066–3083 |
| Quick-action preset buttons | Utility — Formatting & Quick Actions | 3084–3160 |
| Retro log modal (energy, time range, save, edit, delete) | Entry Logging & Editing | 3088–3521 |
| Timeline gap detection / overlap clipping | Timeline Helpers | 3706–3853 |
| Browse yesterday / past days | Date Picker & Navigation | 3547–3613 |
| Streak count / deep hours % / identity score | Statistics & Scoring | 3025–3124 |
| Custom activity colors | Activity Color Management | 3663–3705 |
| Today view full re-render | Today View — Rendering | 3923–4292 |
| Day bar (colored hour-by-hour bar) | Today View — Rendering | 3923–4292 |
| Status banner (deep today / time left / plan progress) | Today View — Rendering | 3923–4292 |
| Desktop right panel (plan progress, energy, week bars) | Today View — Rendering → `renderSidePanel()` | ~4468 |
| Desktop left panel (streak calendar) | Today View — Rendering → `renderLeftPanel()` | ~4417 |
| Hero task input / start-from-hero | Hero Prompt & Task Suggestions | 4777–4895 |
| Task suggestion dropdown (hero) | Hero Prompt & Task Suggestions | 4777–4895 |
| Retro modal suggestion dropdown | Retro Log Suggestions | 4886–4943 |
| Quick-retro bar (inline past-block logger) | Quick-Retro Bar | 4944–5162 |
| Task switch panel (mid-block) | Task Switching Panel | 5023–5092 |
| "Log same as last" CTA / sleep pill shortcut | Quick-Log Special Shortcuts | 5162–5266 |
| Away mode (Sleep, Eat, Walk…) | Away & Status Management | 5267–5415 |
| Week view (energy split, top activities, table) | Week View | 5427–6009 |
| Month overview | Week View → `renderMonthOverview()` | ~5490 |
| Sleep reminder / sleep entry logging | Sleep Tracking | 6083–6211 |
| Yesterday's waste traps / day review modal | Day Review Modal | ~6090–6480 |
| Nightly ritual: picking tomorrow's 1–3 | Review Plan Picker | ~6210–6360 |
| "On a typical Tuesday you track…" line | Review Plan Picker → `reviewPlanReferenceLine()` | ~6260 |
| Plan-vs-actual in the review | Review Plan Picker → `renderReviewPlanVsActual()` | ~6340 |
| Plan chips inside the ping modal | Ping & Quick-Log → `renderQuickLogPlan()` | ~2160 |
| Honest summary card (Reflect tab) | Reflect View | 6465–7085 |
| Week comparison (this vs last week) | Reflect View → `renderWeekComparison()` | 6805 |
| 60-day streak calendar | Reflect View → `renderStreakCalendar()` | ~6700 |
| Focus heatmap (hour × day grid) | Reflect View → `renderFocusHeatmap()` | ~6750 |
| Daily reflection cards | Reflect View → `renderDailyReflections()` | ~6928 |
| Weekly review form (wins, waste, change) | Reflect View → `saveWeeklyReview()` | ~6982 |
| Recurring schedule templates | Day Templates | ~6729 |
| Settings form (timezone, interval, presets…) | Settings View | 6010–6092 |
| Toast notifications | Overlay, Toast & Modal Utilities | 7106–7181 |
| Data Doctor / CSV export / clear data | Export & Data Management | ~7123 |
| PWA install banner / Service Worker setup | PWA Installation | 7202–7228 |
| Voice logging | Voice Input | 7229–7270 |
| Push notifications (Capacitor) | Native Notifications (Capacitor) | 7347–7495 |
| `chronasense://` deep links | URL Scheme / Deep Link Handler | 7496–7546 |
| SW ping scheduling | Service Worker Ping Scheduler | 7547–7587 |
| Onboarding flow | Onboarding | 7588–7726 |
| Android app-usage auto-logging | Phone Usage Tracking (Android) | 7727–7895 |
| Pomodoro timer / session control | focus-mode.js | EXTRACTED |
| Focus Wallet scoring rules | focus-wallet.js | EXTRACTED |
| Lo-fi music / playlist | focus-mode.js | EXTRACTED |
| Focus mode blocker overlay | focus-mode.js | EXTRACTED |
| Persistence / Firebase sync | storage.js | EXTRACTED |
| Weekly insight computation | insights.js | EXTRACTED |
| Color tokens / dark theme variables | CSS — Base & Layout | 1–46 |
| Desktop side panel layout / breakpoint | CSS — Desktop Panels | 985–1014 |
