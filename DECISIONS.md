# DECISIONS.md — ChronaSense Architectural Decisions

Non-obvious choices baked into the code. Read before refactoring.

**This is the canonical decision log.** Numbered entries are architecture/code rationale. The
`D-0NN` entries at the end were migrated here from `docs/DECISIONS.md` in Phase 11.7 (the two
files had drifted into a parallel decision record); their original `D-0NN` ids are retained as
aliases. Record new decisions here — `docs/DECISIONS.md` is now a pointer stub, kept only because
some `tools/*.ps1` automation still reads that path.

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

---

## 21. Cross-Domain Intelligence (Phase 8) is a pure rule-based engine that CONSUMES the Character Sheet + analyzer — it is not a new analyzer, not a truth store, and not an LLM

**Decision:** `cross-domain-intelligence-model.js` answers "what deserves attention next / what is the highest-leverage next action" with a deterministic, rule-based `buildCrossDomainIntelligence({ characterSheet, ledgerEvents, learningPlans, capabilityProfile })`. It keeps four layers separate — FACT → SIGNAL → CANDIDATE → RECOMMENDATION — and produces at most one `recommendedAction` plus up to two `alternatives`, or abstains (`recommendedAction: null`). It calls `analyzeCapabilityCareer()` with the Character Sheet's own `generatedAt` + the same `ledgerEvents`, and reuses the Character Sheet's `learning.activePlan.nextStep` verbatim. It never calls `Date.now()` (only the injected Character Sheet clock), never mutates an input, and is order-independent. There is no LLM call anywhere in the path.

**Why:** Phase 8's value is *auditable, offline-capable, stable* attention triage. An LLM router would introduce silent failure modes that are hard to debug (global CLAUDE.md §5). A second career analyzer would drift from the first. Recomputing factual metrics would let the "Next" view contradict the Character Sheet. Consuming the two established derivations makes parity a property of construction: the recommended step *is* the sheet's next step; the stalls *are* the analyzer's stalls; the driving stall behind a capability action *is* the one `chooseNextAction()` acted on (re-derived with the identical priority order + id tie-break). Determinism (same facts, any array order → identical output) is what makes the engine testable at all — so every list that comes from a possibly-unordered source (`analysis.stalls`, `profile.skills`) is sorted by stable id before use, and ranking ends in a `candidateId` tie-break. Ranking is four discrete tiers, not a score: (1) resolve a stall with a concrete target-linked project, (2) advance target-aligned committed work, (3) resolve a bare stall, (4) advance the plan.

**What NOT to do:** Do not add an LLM to pick or phrase the recommendation in V1 (AI interpretation is a later layer). Do not let the engine write capability evidence, complete a plan step, start a focus session, or change a career target — the only UI control is a plain `showView()` navigation. Do not turn absence of data into a signal: Workout / Meal / free-form activity are `not evaluated` (their sources are not live), never inactive / healthy / unhealthy / behind, and an old imported workout never becomes "you haven't worked out". Do not infer a goal from events — a workout does not mean fitness is a priority, a focus session does not mean "work more". Do not fabricate a task to fill the UI: when a stall exists but no concrete action does (e.g. a shipping stall with no explicit project), surface the stall as an attention SIGNAL and let the engine abstain or recommend the learning step instead. Do not claim a learning plan is "aligned" to a career target without the explicit id chain (plan step → Ledger event → capability evidence → target skill → target) — no keyword matching. Do not use fake confidence percentages — only HIGH / MEDIUM / LOW / INSUFFICIENT with documented meaning.

**Post-review honesty tightening (2026-09-02):** Two failure modes were closed. (1) The Character Sheet's active-plan pick can fall back to "most recently updated" — a heuristic a metadata-only `updatedAt` edit can flip. A plan that is neither target-aligned nor **actively tracked** (≥ 1 current-truth `plan_step_completed` maps to it) is therefore NOT a candidate at all: the `learning-plan-incomplete` attention signal still states the plan, progress and next step, but the engine abstains rather than escalating the guess into "Recommended next: Complete Step X". Do not resurrect a bare LOW learning candidate. (2) A plan→target capability link only counts as **current** alignment (HIGH / tier 2) when a linking evidence record is within `CAPABILITY_CAREER_ANALYTICS_RULES.recentDays` of `generatedAt` — the same window `analytics.recentEvidence()` uses. An old historical link falls through to non-aligned logic (MEDIUM when the plan is actively tracked). Do not introduce a separate recency constant; import the analyzer's.

---

## 22. The Character Sheet's learning section now exposes stable ids (additive) so Phase 8 can reuse its picks instead of re-deriving them

**Decision:** `life-character-sheet-model.js` `buildLearning()` now also returns `activePlan.id`, `activePlan.nextStep.{stepId, lessonId, phaseId}`, and `latestCompletedStep.planId`. These are additive — no existing field changed, no existing test touched a whole-object shape.

**Why:** Phase 8 needs the active plan / next step *that the Character Sheet already selected* (via the private `pickActivePlan()` + `findNextLearningPlanStep()`), both to build stable candidate provenance (`learning-plan-step::<planId>::<stepId>` — never derived from mutable display text) and to guarantee "learning parity" (Phase 8 must not run its own plan traversal). Exposing the ids the sheet already computed is a smaller, safer surface change than exporting internal helpers or duplicating the selection logic, and an id is itself a fact — squarely within the Character Sheet's "facts only" mandate.

**What NOT to do:** Do not let Phase 8 (or anything downstream) re-implement "which plan is active" or "what is the next step" — always read `characterSheet.learning.activePlan`. Do not add interpretation, scores, or recommendations to the Character Sheet model to serve Phase 8 — the boundary is: Character Sheet states facts, Cross-Domain Intelligence interprets them.

---

# Migrated from docs/DECISIONS.md (Phase 11.7)

These three entries were the only substantive content in the parallel `docs/DECISIONS.md` record
(its `D-001` was never filled in — see entry 1 above for the real "no framework, no build step"
decision). They are reproduced verbatim here; original `D-0NN` ids kept as aliases.

## 23. (alias D-002) — Per-task scope note: soft-gate builds that touch files their own task never declared (ported from Meal Prep)

**Context:** Prompted by comparing the shared AI Dev OS template against
`github.com/cathrynlavery/codex-build`, a similar Claude-orchestrates/Codex-builds skill, at the
user's request. `Run-Codex-Build.ps1` already has `$deniedPatterns`, a repo-wide deny-list that
blocks Codex/Claude from ever touching `tools/`, `docs/`, `CLAUDE.md`, and the rest of the OS
surface, regardless of which task is running. `codex-build` does something narrower and
complementary: `check_scope.py` mechanically fails a run if a task touches a file outside an
allowlist declared for THAT specific task. This app had no equivalent — a task declaring
`files: app.js` that also edited `style.css` would pass the deny-list untouched (CSS is legitimate
app-code surface), with nothing prompting the reviewer to notice the extra file was never
requested.

**Decision:** Added `Get-TaskBlockText`/`Get-TaskDeclaredFiles` to `Run-Codex-Build.ps1`, parsing a
task's `files:` field into a flat path list, stripping `(new)` annotations. After the existing
deny-list guard passes, the script computes the union of declared files across every tracked task
in the invocation and flags any changed file that's neither declared nor a standard evidence file
(`CHANGELOG.md`/`TEST_REPORT.md`/`TASKS.md`). Deliberately a **soft gate**: a mismatch never blocks
the build or marks anything blocked — it only writes a note to a new gitignored
`.scope-note.txt`, prefixed with the covered task ID(s), when the tracked set reaches
`status: review`. `Run-Claude-Review.ps1` reads that file, uses it only if the task currently under
review is one of the named IDs (always deleting it after reading either way, so a stale note from
an unrelated run can never attach to the wrong task), and folds it into the Claude reviewer's
prompt as an explicit item: state in `REVIEW.md` whether the extra file is a legitimate dependency
or unrequested scope creep. This is a direct port of the Meal Prep app's TASK-034/D-053 — both
apps share the identical template file, confirmed via direct diff before porting (only two
comment-line differences, no logic differences).

**Why:** The soft-gate choice was explicit and deliberate, not a compromise — when asked, the user
specifically flagged that a hard-block version of `codex-build`'s allowlist enforcer would
"occasionally block a legitimate small necessary touch outside the declared scope... and trade
silent scope creep for false-positive blocks that need you to intervene." That's the same class of
problem this app's own TASK-001 already fixed elsewhere on this codebase (a no-op rework retry and
a crashed review both existed because automation was *silently* wrong, not because it was too
permissive) — recreating that shape as a rigid hard gate here, on a purely heuristic signal, would
have been a step backward dressed as a safety improvement.

**Trade-off:** Purely heuristic — a task with an out-of-date or incompletely-declared `files:`
field will generate false-positive notes the reviewer has to dismiss, and a task with no `files:`
field at all skips the check entirely rather than defaulting to "flag everything." The
Codex-as-reviewer fallback path does not receive this signal — only the Claude reviewer's inline
prompt was wired up, consistent with that path's existing degraded-capability status (no Guardian
Gauntlet either). Verified via a fixture harness re-run against this app's own copy of the ported
functions (8/8 assertions pass) plus a direct diff confirming the note round-trip logic is
character-for-character identical to Meal Prep's already-tested version; no live end-to-end run in
either app, disclosed as unverified-live in `TEST_REPORT.md` rather than claimed. Same
same-session build+review caveat as TASK-001/TASK-002: held at `approved`, not auto-merged, for a
human `/merge`.

**Supersedes:** nothing directly; extends the existing deny-list scope guard with a narrower,
task-specific, advisory-only companion check.

## 24. (alias D-003) — Capability/Career evidence is explicit interpretation, not Life Ledger history

**Context:** Capability/Career V1 needs to answer career questions such as what skills are developing,
what proof exists, and what should happen next. The existing Life Ledger contract already owns durable
facts and event identity, and it must not become a generic profile database.

**Decision:** Capability/Career data lives in a separate local-only repository at
`ta3-capability-career-v1`. It stores skills, knowledge areas, tools, career targets, projects,
portfolio artifacts, and evidence mappings. Evidence mappings can reference a Life Ledger `eventId`
and logical key, but they never copy the event into a pseudo-event, mutate the source event, infer
meaning from the event title, or write Career metadata back to Life Ledger.

**Why:** The product needs both factual history and user-owned interpretation. Keeping them separate
preserves Life Ledger's "this happened" semantics while letting Capability/Career say "this fact
demonstrates this capability in this dimension."

**Trade-off:** V1 relies on explicit user selection and can feel less automatic than keyword tagging.
That is intentional: conservative empty/insufficient states are better than fabricated career
intelligence.

## 25. (alias D-004) — Career intelligence V1 uses deterministic rules and visible dimensions

**Context:** Momentum, stalls, and next action recommendations can easily look more precise than they
are. The feature must distinguish learning from practice, execution, shipping, and portfolio proof.

**Decision:** `capability-career-analytics.js` centralizes thresholds and returns explainable,
deterministic classifications: momentum (`no-evidence`, `active`, `growing`, `stale`), neutral stall
signals, dimension counts, and one primary next action. Business logic takes an injected `now` for
tests and does not call an LLM.

**Why:** Deterministic rules are inspectable, testable, and safer for local private career context.
Separate dimensions prevent a pile of learning notes from masquerading as execution or portfolio
readiness.

**Trade-off:** Recommendations are useful but deliberately conservative. When context is thin, the
system recommends setup/evidence capture instead of pretending to know the highest-leverage career
move.
