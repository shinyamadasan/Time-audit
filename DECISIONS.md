# DECISIONS.md — ChronaSense Architectural Decisions

Non-obvious choices baked into the code. Read before refactoring.

---

## 1. Single-file SPA — no build step

**Decision:** The entire app lives in `index.html` (+ extracted `.js` siblings). No bundler, no npm build, no compilation.

**Why:** The app is deployed as a static GitHub Pages site and loaded directly into a Capacitor Android WebView. Both targets need exactly one file to serve. A build step would require configuring output paths, asset hashing, and a CI pipeline — all complexity that buys nothing for a solo-maintained app.

**What NOT to do:** Do not add a bundler (Webpack, Vite, Rollup) unless you also set up deployment to handle hashed filenames. The current `sync.bat` simply copies `index.html` and `*.js` into `www/` — that breaks the moment filenames become dynamic.

---

## 2. Classic `<script>` tags, not ES modules

**Decision:** All scripts use classic `<script>` (no `type="module"`). Variables declared at top level with `let` or `var` are global and shared across script tags.

**Why:** ES modules are scoped — a `let` in one `<script type="module">` is invisible to another. Since `focus-mode.js` and `insights.js` read dozens of variables from `index.html`'s main script (timers, settings, entries, etc.), modules would require explicit exports/imports — a large refactor. Classic scripts share a single global lexical environment, so the split into multiple files is purely organizational.

**What NOT to do:** Do not add `type="module"` to any script tag without also converting all cross-file variable access to proper imports/exports. Mixing module and classic scripts silently breaks the global sharing.

---

## 3. `position:fixed` side panels, not CSS Grid

**Decision:** Desktop side panels use `position:fixed; left:0` / `right:0` with `body{padding-left:232px; padding-right:232px}`.

**Why:** CSS Grid (`grid-template-columns: 200px 1fr 200px`) was tried first. The panels rendered below the content instead of beside it — likely because `display:flex!important` on the panels conflicted with the grid item placement. `position:sticky` also failed: it requires the panel's scrollable ancestor to scroll, but the panels are in the outer layout context. `position:fixed` pins to the viewport unconditionally, bypasses all layout context issues, and the body padding reserves the center space.

**What NOT to do:** Do not try to replace `position:fixed` with Grid or Flex layout for panels without testing on the actual device. The failure mode is panels silently collapsing to the bottom of the page.

---

## 4. Two goal systems: `dailyCommitment` vs `settings.deepGoal`

**Decision:** There are two separate "goal" values:
- `settings.deepGoal` — stored in localStorage as **hours per week** (divided by 5 to get daily hours). Persistent across sessions. Used in Reflect/weekly views.
- `dailyCommitment` — a `let` variable, **session-only**, defaults to `0`. Set by the user at the start of each day via the commitment prompt. Used for the day's progress ring.

**Why:** `deepGoal` is a long-term target ("I want to do 20h of deep work per week"). `dailyCommitment` is "today I'm committing to X hours" — it resets because some days you plan 2h, others 6h. Combining them into one field would require storing the commitment date alongside the value and adding migration logic.

**What NOT to do:** Do not replace `dailyCommitment` with a persistent field without adding logic to reset it daily. If persistent, the prior day's commitment silently carries over.

**Note on `deepGoal` units:** `settings.deepGoal` is stored in hours per **week**. The daily value is `deepGoal / 5`. This is non-obvious — always divide by 5 before comparing to daily totals.

---

## 5. `missed` flag — auto-generated placeholder entries

**Decision:** The app creates synthetic `{missed: true}` entries to fill untracked gaps in the timeline. These entries are never logged by the user.

**Why:** The timeline must show continuous time. Gaps appear as "Untracked" blocks so the user can see exactly where time was lost. But the gap entries must be excluded from all analytics, streak calculations, and edit operations — hence the `missed` flag as a universal filter.

**What NOT to do:** Do not include `missed` entries in any calculation of deep hours, block counts, or streaks. Every analytical filter must include `.filter(e => !e.missed)`. Forgetting this inflates totals.

---

## 6. `retro: true` — retroactively added entries vs live-logged

**Decision:** Entries logged via the "Add past block" UI have `retro: true`. Entries logged by the running timer or quick-log have `retro: false`.

**Why:** The distinction matters for streak calculation and coaching. A streak day is only valid if at least some entries were live-logged — a user who retroactively fills in a whole day shouldn't get the same streak credit as one who actually tracked in real time.

**What NOT to do:** Do not remove `retro` or default all entries to `retro: false`. The streak and coach logic depends on it.

---

## 7. `onPlan` defaults differ by entry type

**Decision:**
- Timer-logged entries: `onPlan: true` unconditionally (user explicitly started a timer, so it's planned).
- Quick-log and retro entries: `onPlan: energy !== 'distraction' && energy !== 'waste'` (distraction/waste is never "on plan").

**Why:** When using the timer, the act of starting it implies the block was intentional. Quick-log entries might capture distractions the user is logging after the fact, so the energy level determines the default.

**What NOT to do:** Do not change the timer path to also exclude distraction energy from `onPlan`. Users sometimes run the timer through a distraction period intentionally (e.g., a necessary but low-quality meeting) and it should still count as planned.

---

## 8. `blockIntervalMin` stored explicitly, not calculated

**Decision:** Every entry stores `blockIntervalMin` — the duration in minutes. It is computed at logging time and stored, not re-derived from `ts - tsStart`.

**Why:** `tsStart` is sometimes absent on older entries. The interval is also used for fallback rendering when `tsStart` is missing: `tsS = entry.ts - entry.blockIntervalMin * 60000`. Storing it explicitly means the rendered width is stable even if timestamps are edited.

**What NOT to do:** Do not delete `blockIntervalMin` when editing an entry's timestamps without also recomputing it. The rendering code uses `blockIntervalMin || settings.intervalMin` as a fallback — a stale value causes wrong bar widths.

---

## 9. 5-minute merge threshold in `mergeConsecutiveForDisplay`

**Decision:** Consecutive entries of the same activity/energy are merged into one display block if the gap between them is ≤ 5 minutes (`MAX_GAP_MS = 5 * 60000`).

**Why:** The timer pings every 25–30 minutes by default. Back-to-back blocks of the same activity would show as two bars when they're really one continuous stretch. The 5-minute window absorbs clock drift and brief pause time without merging truly separate sessions.

**What NOT to do:** Do not increase this threshold beyond ~10 minutes. At 30 minutes it would merge separate blocks of the same activity type that happened in different parts of the day.

**Critical:** Merged blocks carry a `_mergedIds` array. The edit dialog (`openEditMergedEntry`) requires this array to apply edits to all constituent entries. Never strip `_mergedIds` from display objects.

---

## 10. 5-minute minimum gap in `computeGaps`

**Decision:** `computeGaps` only shows a gap block if the unlogged span is ≥ 5 minutes (`MIN_GAP_MIN = 5`).

**Why:** Sub-5-minute gaps are noise — clock skew, network lag on sync, or the timer firing 30 seconds late. Showing them as "Untracked" would be misleading and visually cluttered.

**What NOT to do:** Do not lower this threshold without testing on a real logging session. At 1 minute, normal timer jitter produces phantom gap blocks.

---

## 11. Gap detection anchored to work-day start, not first entry

**Decision:** `computeGaps` uses `getWorkDayStartTs()` as the anchor, not the timestamp of the first entry.

**Why:** If anchored to the first entry, the timeline would never show a gap at the start of the day — even if the user started logging 3 hours after work began. Anchoring to the configured work-day start makes the "untracked from 9am" gap visible.

**What NOT to do:** Do not change the anchor to "first entry start time." This silently hides morning untracked time, which is one of the most common patterns the app is designed to surface.

---

## 12. `viewingDateKey = null` means today

**Decision:** `viewingDateKey` is `null` when viewing the current day, and a `"YYYY-MM-DD"` string when browsing a past day.

**Why:** Using `null` for "now" means no date string needs to be kept in sync as midnight rolls over. Any code path that needs today's key calls `getDateInTZ(Date.now(), tz)` fresh. If the user is on the app at 11:59pm and midnight passes, the next render automatically gets tomorrow's date because `null` resolves dynamically.

**What NOT to do:** Do not cache today's date string in `viewingDateKey`. The dynamic resolution via `null` is the entire point.

---

## 13. `__FORCE__` sentinel in `_todayRenderKey`

**Decision:** `_todayRenderKey` caches the render key to skip unnecessary re-renders. `setViewDate()` sets it to the string `'__FORCE__'` to force a re-render on the next call, even if the day's entries are empty (which would otherwise produce the same render key as the previous empty state).

**Why:** Past days with no entries would never re-render after navigation because empty arrays hash to the same key. The sentinel bypasses the cache exactly once, then the next render replaces it with the real key.

**What NOT to do:** Do not change `'__FORCE__'` to `null` or `''` — both of those are valid cached states (null = uninitialized, '' = empty string key). The sentinel must be a value that can never appear as a real render key.

---

## 14. `settings.deepGoal` divided by 5 for daily target

**Decision:** The weekly deep-work goal is stored as `settings.deepGoal` (hours/week). The daily equivalent is always `deepGoal / 5`.

**Why:** Users think in weekly terms ("I want to do 20 hours of deep work this week") but the daily view shows daily progress. Storing weekly avoids needing a separate "days per week" setting.

**What NOT to do:** Do not treat `settings.deepGoal` as a daily hours value. All rendering code must divide by 5. Search for `deepGoal` and verify the `/ 5` before adding any new display that references the goal.

---

## 15. Streak and heatmap in side panels, not the Reflect tab

**Decision:** On desktop, the streak calendar and focus heatmap render in `#left-panel` and `#side-panel` respectively. On mobile, they render inline in the Reflect tab.

**Why:** The Reflect tab felt data-heavy when it included both summary charts and the detailed streak/heatmap visualizations. On desktop the side panels are always visible, so moving the at-a-glance visualizations there reduces tab-switching friction.

**What NOT to do:** Do not remove the inline Reflect tab rendering for mobile — the side panels are hidden on mobile (`display:none` by default, only shown via the `@media(min-width:1100px)` rule).

---

## 16. Timer state stored in `localStorage` for cross-reload persistence

**Decision:** Timer state (`blockStartTime`, `taskStartTime`, active task, etc.) is written to `localStorage` and restored on page load.

**Why:** Mobile browsers aggressively background-kill tabs. Without persistence, a phone lock during a timer session would lose the active block. The restore logic on page load reconstructs the timer state and resumes the heartbeat.

**What NOT to do:** Do not add `sessionStorage` as a fallback — it doesn't survive tab kills on mobile. Do not remove the `ta3-heartbeat-ts` cleanup on clean exit; a stale heartbeat key causes the next load to think a crash occurred and triggers a recovery prompt incorrectly.

---

## 18. `www/` is auto-generated — do not edit directly

**Decision:** The `www/` folder is a build artifact copied from the project root by `sync.bat` (Windows) or `sync.sh` (Linux/Mac). It exists solely for Capacitor's Android build and mirrors the root files exactly.

**Why:** Capacitor requires a `webDir` folder (`www/`) as the source for the Android WebView. Rather than maintaining two copies, `sync.bat`/`sync.sh` copies root → `www/` before each Android build. All editing happens at the root.

**What NOT to do:** Do not edit files inside `www/` directly — they will be overwritten on the next sync. Do not commit `www/` changes manually; always run `sync.sh` (or `sync.bat` on Windows) to regenerate it, then commit the result.

---

## 17. `timerOwnerDeviceId` guard in `doPing()`

**Decision:** Each device generates a random `deviceId` stored in `localStorage`. The running timer also stores `timerOwnerDeviceId` — the device that started it. `doPing()` checks `timerOwnerDeviceId === deviceId` before logging a ping.

**Why:** ChronaSense has a shared-room Firebase feature where multiple devices see the same data. Without the guard, all connected devices would each log a ping on the same interval, inflating the entry count by N× the number of connected devices.

**What NOT to do:** Do not remove this guard even if you think only one device will be used. It also protects against re-opened tabs in the same browser logging double entries.

---

## 18. `www/` is auto-generated — do not edit directly

**Decision:** The `www/` folder is a build artifact copied from the project root by `sync.bat` (Windows) or `sync.sh` (Linux/Mac). It exists solely for Capacitor's Android build and mirrors the root files exactly.

**Why:** Capacitor requires a `webDir` folder (`www/`) as the source for the Android WebView. Rather than maintaining two copies, `sync.bat`/`sync.sh` copies root → `www/` before each Android build. All editing happens at the root.

---

## 19. `tools/Dispatch-Commands.ps1` / `tools/Run-Codex-Build.ps1` fixed to match the Meal Prep app's D-051 (ported, not independently discovered)

**Decision:** Two automation bugs, found and fixed in the sibling Meal Prep app first, ported here directly: (1) `Run-Codex-Build.ps1` now refuses to auto-chain a build into review unless it actually touched `CHANGELOG.md` or `TEST_REPORT.md` — a rework retry that only flips a status field, changing nothing else, is now caught as a "no-op" before it ever reaches review. (2) `Dispatch-Commands.ps1`'s `Invoke-Autopilot` classification was factored into a shared `Resolve-ReviewOutcome` function, gaining a case for a crashed review engine (mirrors `status: review` onto `main` with no strike cap — transient infra flakiness, not a task defect) and a case for the new "build NO-OP" signal (bounded `strike N/3`, same idiom REWORK already uses). A third bug was caught while consolidating: the old inline classifier matched the bare word "APPROVED" against a red-zone "APPROVED but HELD" message and would have marked that task `done` on `main` even though it was never merged — now checked and excluded first. `Invoke-Autopilot` also gained a pending-review-resume step so a plain `/go` (not just an explicit `/review`) resumes a task stuck at `status: review`.

**Why:** This project and the Meal Prep app share the exact same `tools/Dispatch-Commands.ps1` / `tools/Run-Codex-Build.ps1` template (confirmed byte-for-byte identical before this change) — a bug found in one is latent in the other, whether or not it has actually fired here yet. Since the developer runs both projects the same way and wants their AI Dev OS setups kept in parity, porting the fix immediately (rather than waiting for this project to independently hit the same incident) closes the gap before it causes a real stuck task here.

**What NOT to do:** Do not assume this port is fully verified the same way a live incident would be — it's confirmed via parse-checks and an isolated fixture harness against this repo's own copy of the code (9/9 assertions pass), not a real crashed `claude -p`/`codex exec` run. Held at `status: approved` (not auto-merged) for the same reason the Meal Prep app holds this class of change — it touches the AI Dev OS itself.

---

## 20. Digest length capped at ~4000 chars; stale automation.lock wait cut from 2 hours to 45 minutes with a visible notice

**Decision:** Two fixes to the same class of problem (an automation failure that was silent until a human happened to notice). (1) `Generate-Digest.ps1` now builds the Telegram digest incrementally and stops adding proposal items once the message would approach Telegram's 4096-character hard limit, appending a "+N more waiting, see planning/PROPOSALS.md" note instead of letting the raw message grow unbounded. (2) `Dispatch-Commands.ps1`'s `automation.lock` staleness check now verifies whether the lock's recorded PID is actually still running (a crashed process clears the lock immediately, no waiting), and for a PID that's genuinely still alive, the wait before treating it as stuck was cut from 2 hours to 45 minutes — with a Telegram notice sent through the existing reply relay the moment a stale lock is cleared, instead of clearing silently.

**Why:** Both bugs were found live in the same session, back to back. A 12-proposal digest hit ~5000 characters and Telegram rejected the send outright — the human got nothing that morning, not even a partial digest, and had no way to know delivery had failed at all. Separately, a genuinely hung process (confirmed by hand: 0% CPU, no log output since before the run even started, no working child process) held `automation.lock` for 48+ minutes with two `/merge` commands queued uselessly behind it, and the only way anyone found out was a human happening to open Task Manager. Two hours was never a considered number — it was inherited from "this repo's Task Scheduler execution-time limit," a completely different constraint from "how long could a legitimate run plausibly take," which this codebase's own numbers already answer: 20 minutes (`Run-Codex-Build.ps1`'s build cap) plus 10 minutes (`Run-Merge.ps1`'s npm-test cap), with room to spare at 45.

**What NOT to do:** Do not have the stale-lock check also kill the lingering process automatically. Clearing a lock file is reversible and low-stakes; killing a process based on a time heuristic alone is not, and this project already has a deliberate, human-triggered way to do that (`/stop`) rather than needing an unattended one. Do not truncate the digest by cutting the final joined string at a character count — build it up incrementally and stop at an item boundary instead, or a truncation can land mid-Markdown-entity and turn one delivery failure into a different one ("can't parse entities").
