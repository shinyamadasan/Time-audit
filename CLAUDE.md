# ChronaSense — Project Context

## Read First
Before every session, read CODEMAP.md to understand the codebase structure.
Do not read index.html in full — use CODEMAP.md to find the relevant section,
then read only that section.

## Stack
- Frontend: Vanilla JS, single-file SPA (index.html)
- Backend: Firebase Realtime Database + Auth
- Mobile: Capacitor (Android)
- Extension: Chrome/Edge browser extension
- Extracted modules: storage.js, insights.js, focus-mode.js

## Rules
- One change at a time
- Never modify working functionality unless explicitly asked
- Always explain your plan before editing
- Scope every change to the smallest possible section
- After changes: confirm what was modified and what was not touched

## Keeping CODEMAP.md current
After every session, update CODEMAP.md if any of these happened:
- A function was added, renamed, or deleted → update the function list in its section
- A function moved between sections → update both sections + line ranges
- A new feature area was added → add a new section block
- A section was extracted to its own file → replace with "EXTRACTED → filename.js" stub and list its functions + dependencies
- Line numbers shifted significantly → update the `Lines:` range for affected sections

Do NOT update CODEMAP.md for: bug fixes, UI copy changes, adding tracks/colors/presets to existing arrays, or any change that doesn't move logic.

## Key Files
- index.html — main app (use CODEMAP.md to navigate, do not read in full)
- storage.js — Firebase sync and persistence
- insights.js — per-entry behavioral feedback (`analyzeBehavior`, `renderAwarenessSignal`, `renderFeedbackFlash`, `checkEscalation`) + weekly insight computation (`computeInsights`, `generateInsights`) + daily summary HTML (`buildDailySummaryHTML`, `getDailySummaryInsight`)
- focus-mode.js — Pomodoro / focus session logic
- sw.js — service worker (cache-first strategy; also registered inline via swCode string in PWA Installation section ~line 7198)
- CODEMAP.md — architecture map (read this first every session)

## DO NOT TOUCH — Fragile Sections

These areas have non-obvious invariants that are easy to break silently. Read DECISIONS.md before touching any of them.

**`clipOverlapsForDisplay()` (Timeline Helpers, ~3709)**
Do not modify clipping logic. It produces shallow copies, not mutations. Changing to in-place edits corrupts the source `entries` array.

**`mergeConsecutiveForDisplay()` (Timeline Helpers, ~3731)**
Do not remove `_mergedIds` from the returned objects. `openEditMergedEntry()` requires it. Do not raise `MAX_GAP_MS` above ~10 minutes — merges separate sessions.

**`computeGaps()` (Timeline Helpers, ~3753)**
Gap anchor is `getWorkDayStartTs()`, not first-entry time. Do not change the anchor — it would hide morning untracked time. Do not lower `MIN_GAP_MIN` below 5 — creates phantom gaps from timer jitter.

**`_startHeartbeat()` / `_stopHeartbeat()` (Heartbeat, ~3000)**
`_stopHeartbeat()` MUST be called on every clean exit: `resetTimer()`, `stopAndLog()`, `confirmExitFocus()`. Missing one causes a false crash-recovery modal on every next open.

**`_todayRenderKey` sentinel (Today View Rendering, ~4045)**
`setViewDate()` writes `'__FORCE__'` to force a re-render on empty past days. Do not replace the sentinel with `null` or `''` — both are valid cached states and will silently skip the re-render.

**Heartbeat crash-detection IIFE (~7309)**
Runs exactly once on load. Do not wrap it in a function or defer it — it must run before any other init to catch the prior session's crash state.

**`doPing()` device guard (~2669)**
`if (timerOwnerDeviceId !== deviceId) return;` prevents multi-device double-logging in shared rooms. Do not remove this check even if you think only one device is in use.

**Timer restore block (INIT section, ~7271)**
Reads localStorage timer state on page load and resumes the active block. Order matters: state must be restored before `renderToday()` is called, or the hero renders in idle state and the restored timer is invisible.

## Branch Strategy

`main` is live production — GitHub Pages serves it directly. A broken push is a broken app.

**Safe to push straight to `main`:**
- UI copy / label changes
- Color, track, or preset additions
- CSS tweaks that don't touch layout logic
- CODEMAP / DECISIONS / CLAUDE.md updates

**Create a feature branch first:**
- Any change to a section listed in DO NOT TOUCH above
- New features that touch timer state, entry schema, or Firebase sync
- Anything that required reading more than one section of CODEMAP to understand

**How to branch (run in terminal):**
```
git checkout -b feature/your-description
# make changes, test with SMOKETEST.md
git checkout main
git merge feature/your-description
# then run sync.bat
```

**Never** force-push to `main`. If a push fails, fix the cause — don't bypass it.

## Reference Docs
- DECISIONS.md — why non-obvious choices were made (read before refactoring)
- SMOKETEST.md — manual test checklist (run before pushing)