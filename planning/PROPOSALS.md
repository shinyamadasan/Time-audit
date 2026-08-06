# Proposals

> **Triage output, pending human approval.** Claude writes; the human decides.
> Approve one and it moves to `ROADMAP.md` + `BUILD_QUEUE.md`. Nothing here is built.

Each proposal is scored against the north-star goals in `docs/PROJECT.md`.

---

### PROP-001 — Keysmash test noise (captures 12, 16, 36)

id: PROP-001
captures: 20260712T2058Z-12, 20260712T2108Z-16, 20260714T1411Z-36
- **status:** pending
dup-count: 3

> **Decision: Reject** — Three keysmash/filler test messages ("tesss", "test capture,", "sda") sent during Telegram bot setup. No actionable content.

**Goal alignment:** none — does not serve any North-star goal. Current Objective not yet set.
**User value:** none.
**Evidence:** 3 noise messages across 3 days; no recurring friction or feature signal.
**Effort:** n/a | **Dependencies:** n/a | **Confidence:** high (noise) | **Ambiguity:** low.
**Why now vs later:** never — discard.
**Goal-adjusted priority:** P3 (reject-class; not actionable regardless of Current Objective).

---

### PROP-002 — Orphaned /approve command (capture 20)

id: PROP-002
captures: 20260713T0942Z-20
- **status:** pending

> **Decision: Reject** — `/approve` arrived on 2026-07-13 with no pending proposal in context and nothing in BUILD_QUEUE. Likely a bot-command routing test, not intent to approve a specific proposal.

**Goal alignment:** none — no feature content, only bot-test behaviour.
**User value:** none.
**Evidence:** single occurrence; no surrounding approval context (PROPOSALS.md was empty at capture time).
**Effort:** n/a | **Dependencies:** n/a | **Confidence:** high (bot test) | **Ambiguity:** low.
**Why now vs later:** never — discard.
**Goal-adjusted priority:** P3.

---

### PROP-003 — Bot routing confirmation (capture 40)

id: PROP-003
captures: 20260714T1414Z-40
- **status:** pending

> **Decision: Reject** — Explicit end-to-end pipeline test ("routing test chronasense"). No feature request. Confirms the Telegram → n8n → captures/inbox pipeline is fully functional.

**Goal alignment:** none — operational validation, not a product proposal.
**User value:** none as a proposal; incidentally confirms capture pipeline health.
**Evidence:** self-described test; arrived cleanly alongside 4 others across 3 days.
**Effort:** n/a | **Dependencies:** n/a | **Confidence:** high | **Ambiguity:** low.
**Why now vs later:** never — discard as proposal.
**Goal-adjusted priority:** P3.

**Incidental note:** The Telegram → n8n → repo capture pipeline is confirmed working end-to-end (5 messages landed cleanly across 2026-07-12 to 2026-07-14).

---

### PROP-004 — Timer state not restored on app reopen (capture 52)

id: PROP-004
captures: 20260715T1346Z-52
- **status:** pending
dup-count: 1

> **Decision: Approve** — First user-reported bug; maps directly to Hard Rule #8 (timer restore order in INIT). When the app is closed mid-session and reopened, the hero resets to starting "work" instead of resuming the active entry. Data correctness issue: the gap between close and reopen is untracked, and the resumed state is wrong.

**Goal alignment:** supports — directly serves Goal #3 ("Never lose logged time") and Goal #1 ("Make logging frictionless"). A wrong state on reopen means the user either logs a wrong entry or loses time. Mixed with Goal #5 (stay maintainable) — the fix touches red-zone INIT code.

**User value:** High. User noticed this during real usage, not testing. The symptom (app wakes to "work" start rather than continuing an active timer) causes a silent gap or a wrong entry — both undermine the audit's truthfulness.

**Evidence:** 1 occurrence, first direct bug report from real usage. Maps to a documented fragile section (Hard Rule #8, CODEMAP INIT section). No prior PROPOSALS.md dupe. ROADMAP Known Issues is empty.

**Effort:** Medium. Requires reading CODEMAP INIT section to locate the restoration block, then verifying the timer-state localStorage keys and their load order. Red-zone (risk gate: `approved`, not `done`). | **Dependencies:** CODEMAP.md (INIT section), DECISIONS.md (D-008 or equivalent timer-restore decision). | **Confidence:** High that the bug exists; Medium on root cause until CODEMAP INIT section is read. | **Ambiguity:** Low on what the expected behaviour is; Medium on precise file location.

**Why now vs later:** Now — this is a data-correctness bug affecting every session closure, not a cosmetic issue. A wrong entry created on reopen cannot be reconstructed retroactively.

**Goal-adjusted priority:** P1 — Current Objective not yet set, but Goal #3 is the highest-ranked applicable goal and this directly violates it. Would remain P1 under any stability-focused objective.

---

### PROP-005 — Bot noise batch (captures 55, 61, 63, 67)

id: PROP-005
captures: 20260715T1407Z-55, 20260716T0025Z-61, 20260716T0025Z-63, 20260716T0025Z-67
- **status:** pending
dup-count: 4

> **Decision: Reject** — Four noise messages: "test" (bot-setup test), "/reject" (mistyped bot command sent as plain text), and two single-character "s" keysmashes. No actionable content.

**Goal alignment:** none — does not serve any North-star goal.
**User value:** none.
**Evidence:** 4 noise messages in quick succession (2026-07-15 to 2026-07-16); pattern matches previous noise batches (PROP-001, PROP-002, PROP-003). The "/reject" message was likely an accidental plain-text send of a bot command.
**Effort:** n/a | **Dependencies:** n/a | **Confidence:** high (noise) | **Ambiguity:** low.
**Why now vs later:** never — discard.
**Goal-adjusted priority:** P3 (reject-class).

---

### PROP-007 — `triggerPenaltyMode()` undefined — escalation dead-letters on 5-waste streaks

id: PROP-007
source: /audit (this run)
- **status:** pending

> **Decision: Approve** — Confirmed runtime bug. `checkEscalation()` in `insights.js:248` calls `triggerPenaltyMode()` which is not defined in `index.html`. A `ReferenceError` is thrown silently whenever five or more consecutive waste/missed entries are logged in a day. The function exists only in old prototype files and the `eslint.config.js` legacy globals list — it was never ported. The escalation path (the most forceful behavioral nudge in the app) silently never fires.

> **Risk:** Low — Entry data is safe; `persist()` runs before the crash. The only consequence is that the penalty-mode activation and the `checkBudget()` warning both fail to run when the system should be at its most assertive. No data is lost and no sync is corrupted.

**Goal alignment:** Directly violates Goal #4 (Insight must change behaviour). The escalation fires exactly when the user's behaviour is worst (5+ consecutive waste blocks in a row). Silently dead-lettering there is the worst possible moment for the feedback system to fail.

**User value:** High. This is the strongest behavioural nudge in the app. Users who reach 5-waste streaks are exactly the users who most need it — and they're getting nothing.

**Evidence:** `grep triggerPenaltyMode index.html` returns zero matches. The function appears only in prototype files (`ai_studio_code (1) - Copy.html:1360`) and the ESLint readonly-globals list (`eslint.config.js:53`), confirming it was never ported. The call sequence is: `_doQuickSave()` / `autoLogBlock()` / `saveEntry()` → `checkEscalation()` → `triggerPenaltyMode()` → ReferenceError. `checkBudget()` is never reached on the same path.

**Effort:** Low — Two options: (a) add `typeof triggerPenaltyMode === 'function'` guard and document the missing function; or (b) port/implement `triggerPenaltyMode()` from the prototype file. The prototype version (at line 1360 in `ai_studio_code (1) - Copy.html`) is the right reference. | **Dependencies:** `insights.js:checkEscalation()`, `index.html` (location to add the function). | **Confidence:** High — reproduces deterministically on any 5th consecutive waste log. | **Ambiguity:** Low — the function is simply missing from the current production file.

**Why now vs later:** Now — this bug fires in real usage whenever a user has a bad focus day (not a rare edge case). Every 5-waste streak since this code was split into modules has produced a silent ReferenceError. The fix is low-effort and the risk is low.

**Goal-adjusted priority:** P1 — Goal #4 is the highest applicable goal and the bug silently nullifies its most impactful mechanism.

---

### PROP-008 — `enterFocusMode()` auto-log has no undo — wrong energy silently sticks

id: PROP-008
source: /audit (this run)
- **status:** pending

> **Decision: Approve** — UX gap confirmed in `focus-mode.js:608–626`. When the user opens Focus Mode with an active interval timer, `enterFocusMode()` auto-logs the running block. It calls `showToast()` (not `showUndoToast()`), so no undo action is registered. If the wrong energy is assigned (heuristic: most recent logged entry's energy, defaulting to `'deep'`), the user must manually find and edit or delete the entry from the timeline — there is no 1-tap correction.

> **Risk:** Low — UI change only. Touches `enterFocusMode()` in `focus-mode.js` and the undo helper (`rememberCreatedUndo()` from `index.html`). Does not touch entry schema, Firebase sync, or timer state.

**Goal alignment:** Goal #1 (Make logging frictionless) — a log that can't be undone with a single tap is friction. Goal #2 (Capture the truth) — a miscategorised block silently survives, distorting the audit record.

**User value:** Medium. The auto-log is useful (it closes the running block before entering Pomodoro mode), but users who enter Focus Mode and immediately see "Deep work — 12m" toasted when they were actually doing email have no fast recovery path.

**Evidence:** `focus-mode.js:625` — `showToast(\`Logged: ${task} · ${fmtDur(dur)}\`)`. Compare with `_doQuickSave()` in `index.html:2689-2690` which uses `showUndoToast()` and `rememberCreatedUndo()`. The energy heuristic is `entries.find(e => !e.missed && !e.break && !e.away)?.energy || 'deep'` (focus-mode.js:615) — it reads the most recently logged entry's energy, which may be from a previous day or a different energy category than the current block.

**Effort:** Low — replace `showToast()` with `showUndoToast()` and add `rememberCreatedUndo('focus-mode auto-log', [entry])` before `resetTimer()`. | **Dependencies:** `focus-mode.js`, `rememberCreatedUndo()` / `showUndoToast()` (defined in `index.html`). | **Confidence:** High — reproducible on every Focus Mode open with an active timer. | **Ambiguity:** Low on the fix; medium on whether to also fix the energy heuristic at the same time or track it as a separate proposal.

**Why now vs later:** Later than PROP-004 and PROP-007 (both are higher priority) but before any UX polish work. This is a small, targeted fix once PROP-007 is resolved.

**Goal-adjusted priority:** P2 — Goal #1 alignment, but a workaround exists (timeline edit). Outranked by PROP-004 (data loss) and PROP-007 (broken escalation).

---

### PROP-009 — Focus Wallet "sport" substring match false-positives on "transport" entries

id: PROP-009
source: /audit (this run)
- **status:** pending

> **Decision: Approve** — Confirmed precision bug in `focus-wallet.js:isFocusWalletSportsEntry()`. The function uses `label.includes("sport")` where `label` is the lowercased activity name. The word "transport" contains "sport" as a substring (positions 4–8 of "transport"). Any activity logged as "Public transport", "Transport to office", "Air transport", etc. is silently classified as a weekly sports session, consuming a free-session slot and potentially incurring wallet costs (10 pts for session 4, 25 pts for each beyond that).

> **Risk:** Low — Focus Wallet is a UI scoring layer; no entry data or Firebase schema is touched. The fix is a word-boundary check on the sports-activity keyword list.

**Goal alignment:** Goal #3 (Never lose logged time) — the wallet score is computed incorrectly for affected users, misrepresenting the cost/reward balance. Goal #5 (stay maintainable) — the substring match violates the principle of precision for a feature that deducts points from a user's account.

**User value:** Medium. Users who log commuting as any phrase containing "transport" will see unexpected sports-session costs accumulate over weeks. The confusion ("why am I being penalised for commuting?") undermines trust in the wallet feature.

**Evidence:** `focus-wallet.js:89-91` — `cfg.sportsActivities.some(term => label.includes(String(term).toLowerCase()))`. The default `sportsActivities` array contains `'sport'` (line 27). `"transport".includes("sport")` evaluates to `true`. Other affected substrings: any phrase with "transport" in the activity name. The fix is to use word-boundary matching: `label.split(/\W+/).includes(term)` or `new RegExp('\\b' + term + '\\b').test(label)`.

**Effort:** Low — one-line change per keyword check strategy, plus a test case. Could also remove the bare `'sport'` term from the defaults and rely on the more specific sport names (pickleball, basketball, tennis, soccer, etc.) already in the list. | **Dependencies:** `focus-wallet.js:isFocusWalletSportsEntry()`. | **Confidence:** High — `"transport".includes("sport")` is verifiable in any JS console. | **Ambiguity:** Low on the bug; low-medium on the best fix (remove 'sport' term vs. word-boundary regex).

**Why now vs later:** After PROP-007 and PROP-004. The wallet feature is in use, so every week that passes with this bug adds miscounted sessions for affected users. But it's not a data-loss issue and can be batched with other wallet fixes.

**Goal-adjusted priority:** P2 — Goal #3 alignment (incorrect score), but only affects users who log "transport" activities. Low blast radius, medium evidence of actual user impact.

---

### PROP-006 — Category clarity: where do cooking and church work go? (capture 75)

id: PROP-006
captures: 20260719T1656Z-75
- **status:** pending
dup-count: 1

> **Decision: Park** — Real usage friction: user couldn't tell which category bucket to use for "cooking" or "church work." Worth addressing, but needs clarification (relabeling? new presets? descriptions?) before it can be specced. Park behind PROP-004 bug fix and pending Current Objective.

> **Risk:** Low — Most natural fixes (clearer category labels, new preset items, or in-picker examples) are UI-only changes that don't touch entry schema or Firebase sync. Escalates to High if a solution requires renaming or restructuring stored category keys — flag before building.

**Goal alignment:** Supports Goal #1 (Make logging frictionless) — category confusion slows the ping→log loop and risks mislabeled entries. Weakly supports Goal #4 (Insight must change behaviour) — insights built on miscategorised entries are less meaningful.

**User value:** Medium. First idea-type capture from real usage (not a bot test). If users can't confidently pick a category, they log wrong, skip, or quietly undermine the audit's truthfulness.

**Evidence:** 1 occurrence, genuine usage. No dups in PROPOSALS.md or ROADMAP.md. Category confusion is a known friction point for any time-tracker — the user names two concrete examples (cooking, church work) that don't obviously fit existing buckets.

**Effort:** Low–Medium depending on solution: adding/relabeling presets is very small; a guided category picker or inline descriptions is Medium. | **Dependencies:** CODEMAP.md (Category/Preset section — need to locate where category definitions live before scoping). | **Confidence:** High that friction exists; Low on exact fix until scope is clarified. | **Ambiguity:** High — "making the category clearer" could mean: (a) add cooking/church work as default presets, (b) rename or regroup existing category buckets, (c) add descriptions/examples to the picker UI, or (d) build a category hierarchy. Needs one clarifying follow-up before speccing.

**Why now vs later:** Later — no data is lost from category confusion (entries are still logged, just possibly mislabeled). PROP-004 (timer restore bug, P1, data-correctness) takes priority. Re-evaluate once Current Objective is set and PROP-004 is in the build queue.

**Goal-adjusted priority:** P2 — genuine UX friction tied to Goal #1, but outranked by a P1 data-correctness bug (PROP-004) and an unset Current Objective.

---

### PROP-010 — `/approve all` approval command (capture 82)

id: PROP-010
captures: 20260720T0849Z-82
- **status:** pending
dup-count: 1

> **Decision: Reject** (as a product proposal) — `/approve all` is a human approval-gate command, not a feature request or bug report. The user intends to approve all currently pending "Approve"-recommended proposals (PROP-004, PROP-007, PROP-008, PROP-009). Triage cannot execute approvals; ROADMAP.md and BUILD_QUEUE.md are write-protected in this step. The signal is noted and flagged in STATUS.md for the next human review.

> **Risk:** Low — no code or data touched by the capture itself. The downstream approval action (moving proposals to ROADMAP.md) carries the risk profile of the individual approved proposals.

**Goal alignment:** none as a proposal — this is an administrative command, not a product change.
**User value:** none intrinsic; the value is in the downstream approvals it signals.
**Evidence:** 1 occurrence; clear intent given 4 pending proposals with "Approve" decisions in PROPOSALS.md at time of capture. Distinct from PROP-002 (lone `/approve` when PROPOSALS.md was empty — noise); this one has clear referents.
**Effort:** n/a | **Dependencies:** human manually moves PROP-004/007/008/009 to ROADMAP.md + BUILD_QUEUE.md | **Confidence:** high (intent is unambiguous) | **Ambiguity:** low.
**Why now vs later:** never (as a proposal) — the approval action itself is what matters, not logging it as a feature.
**Goal-adjusted priority:** P3 (reject-class as proposal; the approved items have their own priorities).

**⚠ Action required:** Human should move PROP-004 (P1), PROP-007 (P1), PROP-008 (P2), PROP-009 (P2) to `planning/ROADMAP.md` (Approved Backlog) and add them to `planning/BUILD_QUEUE.md` to unblock the build pipeline.

---

### PROP-011 — Auto-timer toggle: enable / disable auto-start (capture 84)

id: PROP-011
captures: 20260720T0850Z-84
- **status:** pending
dup-count: 1

> **Decision: Approve** — Real usage frustration: the timer auto-starts when the app opens even when the user is not working. A user-controlled toggle (on/off for auto-start) would eliminate unwanted entries and reduce noise in the audit log. First direct UX complaint about timer behavior from real use (not testing).

> **Risk:** High — The timer system is the most fragile part of the codebase. Hard Rules #4 (stop heartbeat on every exit), #7 (device guard in `doPing()`), and #8 (timer-restore block order in INIT) all touch the same code path as any auto-start toggle. A poorly placed guard could break crash detection, multi-device safety, or timer restore — silently. Must be implemented with CODEMAP INIT + Timer sections read first. Risk gate: `approved`, not `done`.

**Goal alignment:** Supports Goal #1 (Make logging frictionless) — forced auto-start creates friction and can produce wrong or unwanted log entries. Weakly supports Goal #2 (Capture the truth) — auto-entries the user didn't intend distort the audit record. Mixed with Goal #5 (stay maintainable) — the timer is the red-zone core of the app.

**User value:** Medium-High. The user explicitly called this "annoying" in real daily use. If auto-start fires on non-work opens (e.g., checking a past entry, opening for a break-log), it silently starts a new entry the user must then delete or correct — classic log-pollution. A toggle is the minimum corrective.

**Evidence:** 1 occurrence, genuine usage frustration (not a bot test). No PROPOSALS.md or ROADMAP.md dup. Likely recurring — timer auto-start on any app open is a behavioral trigger every time the app is used.

**Effort:** Medium. Requires reading CODEMAP INIT + Timer sections to locate where auto-start fires, adding a `localStorage`-persisted preference key, and threading a guard through the start sequence without breaking Hard Rules. | **Dependencies:** CODEMAP.md (INIT section, Timer section), DECISIONS.md (any timer-start decisions), Hard Rules #4/#7/#8. | **Confidence:** High that the frustration is real and the feature is buildable; Medium on root cause (need to confirm which specific auto-start path fires on open). | **Ambiguity:** Medium — "auto timer" is not defined; could mean (a) timer auto-resumes an idle session on app open, (b) interval ping auto-fires on first load, or (c) the hero auto-transitions to "working" without user confirmation. Needs one clarifying read of CODEMAP INIT before speccing.

**Why now vs later:** After PROP-004 and PROP-007 (both P1 data-correctness bugs). The auto-timer annoyance is a daily frustration but produces recoverable log entries (user can delete/correct), whereas PROP-004 (timer restore) and PROP-007 (broken escalation) produce silent data loss and dead behavioral feedback. Once P1 bugs land, this should be next.

**Goal-adjusted priority:** P2 — Goal #1 alignment, real daily friction, but outranked by two confirmed P1 bugs (PROP-004, PROP-007).

---

### PROP-012 — In-app calendar / appointment planning (capture 86)

id: PROP-012
captures: 20260720T0856Z-86
- **status:** pending
dup-count: 1

> **Decision: Park** — The user wants to plan appointments during the day inside the app (like Google Calendar), with an optional Google Calendar sync. Valid product direction for closing the "planned vs actual" gap, but this is a large-scope feature addition — effectively a second major subsystem alongside the timer/audit core. Park behind current P1/P2 bug fixes and pending Current Objective. Revisit once the app is stable and the Current Objective is set.

> **Risk:** High — A calendar feature requires new data structures (appointment/event schema), new Firebase RTDB nodes, and potentially Google Calendar OAuth (external API, credential management). Any new schema touching RTDB sync is red-zone per DECISIONS.md D-032. If planned events need to appear on the timeline alongside logged entries, that also risks touching the fragile Timeline Helpers (Hard Rules #1/#2/#3). Risk gate will be `approved` for any implementation touching those paths.

**Goal alignment:** Supports Goal #2 (Capture the truth of your day) — knowing what was planned vs what actually happened is a meaningful audit dimension. Partially supports Goal #1 (Make logging frictionless) — pre-scheduled blocks could auto-suggest category/task at log time. Conflicts with current priority (stability / P1 bugs). No direct conflict with any North-star goal, but the Current Objective is unset, so full alignment cannot be scored.

**User value:** Medium. The feature closes a genuine gap — ChronaSense currently captures what you *did*, not what you *planned*. The planned-vs-actual comparison is high value for a personal time audit. However, the user also mentions Google Calendar integration, which many users already have running — the in-app planning option may serve users who don't use Google Calendar (e.g., the "recurring things" use case the user mentions).

**Evidence:** 1 occurrence, genuine product vision from real usage. No PROPOSALS.md or ROADMAP.md dup. The "recurring things" mention suggests the user is already thinking in terms of schedule patterns, not one-off events. No demand signal beyond this one capture.

**Effort:** High. This is a new major feature, not a bug fix or small UX change. Minimum scope: (a) appointment data model + Firebase schema, (b) calendar day-view UI, (c) integration with the timeline display. Optional scope: Google Calendar OAuth + two-way sync. Likely 3–5 tasks minimum. | **Dependencies:** CODEMAP.md (Timeline, INIT, Firebase Sync sections), DECISIONS.md (RTDB schema decisions), docs/DATA_MODEL.md (existing entry schema). | **Confidence:** Low on scope until further scoped (the user's request spans a wide range from "simple appointment list" to "full Google Calendar sync"). | **Ambiguity:** High — "planning" could mean: (a) add appointment/reminder entries to the timeline, (b) a separate calendar view with time blocks, (c) recurring schedule templates, or (d) bi-directional Google Calendar sync. Needs significant scoping before speccing.

**Why now vs later:** Later — two P1 bugs (PROP-004, PROP-007) and two P2 UX fixes (PROP-008, PROP-009, PROP-011) should land first. This is a product expansion, not a stability fix. Revisit when Current Objective is set and the bug backlog is clear.

**Goal-adjusted priority:** P3 — Valid product direction but large scope, high ambiguity, and not aligned with current stability/bug-fix priority. Down-weighted further by unset Current Objective.

---

### PROP-013 — Unlogged-day navigation opens the wrong day's timeline (capture 120)

id: PROP-013
captures: 20260724T1519Z-120
- **status:** pending
dup-count: 1

> **Decision: Approve** — Real usage bug report: from an unlogged-time day list, clicking a specific day (user's example: Wednesday, while today is Friday) opens the *next* day's timeline (Thursday) instead. The header date label stays correct, so this isn't a global date-state bug — it's isolated to whatever click handler resolves the clicked day into a date key for the timeline view. The "off by one, toward the future" pattern is the classic symptom of a `YYYY-MM-DD` string being parsed as UTC midnight and re-rendered in a negative-UTC-offset local timezone, but that's a hypothesis, not a confirmed root cause.

> **Risk:** Low — This reads as a display/navigation bug (which date key gets loaded into the timeline view), not a write path. It does not obviously touch entry schema or Firebase RTDB sync. Flagging Medium-lean-Low instead of flat Low because the fix location is unconfirmed: if root cause turns out to be inside `computeGaps()`'s work-day-start anchor or `getWorkDayStartTs()` (Timeline Helpers, Hard Rule #3) rather than the day-selection click handler, that section is explicitly red-zone and the gate should move to `approved`. Confirm the exact function before scoping as build-ready.

**Goal alignment:** Supports Goal #2 (capture the truth of your day) — a user reviewing "did I log Wednesday?" and landing on Thursday's data instead is being shown the wrong truth, which is the core failure mode this app exists to prevent. Weakly supports Goal #1 (frictionless) — the user now has to double back and re-navigate, and may lose trust in day navigation generally.

**User value:** High. This is a trust bug, not a cosmetic one — a time-audit app whose day navigation can't be trusted to show the day you clicked undermines the entire premise of the tool. First direct report of this specific symptom.

**Evidence:** 1 occurrence, genuine usage report with a precise repro (unlogged-day list → click Wednesday while viewing Friday → Thursday's timeline renders; header date stays correct). No PROPOSALS.md or ROADMAP.md dup — distinct from PROP-004 (timer-restore-on-reopen) and PROP-006 (category-label clarity), the only other date/timer-adjacent open proposals. No dup in DONE.md (empty).

**Effort:** Low–Medium. Needs CODEMAP.md read of the Timeline / date-navigation sections (`setViewDate()`, `navigateDateBy()`, `getViewingDateKey()` per CODEMAP, plus wherever the unlogged-day list's click handler lives — likely `renderUnloggedHours()` / `selectWeekDay()` in the Week view section per CODEMAP) before the exact fix location is known. | **Dependencies:** CODEMAP.md (Timeline Helpers + date-navigation sections), Hard Rule #3 (`computeGaps()` anchor — must confirm the fix doesn't touch it, or escalate risk if it does), Hard Rule #5 (`_todayRenderKey` sentinel — check for interaction). | **Confidence:** High that the bug is real and reproducible; Low-Medium on root cause until the click handler is traced. | **Ambiguity:** Low on expected behavior (clicking Wednesday must show Wednesday); Medium on root cause location.

**Why now vs later:** Now-ish — this is a correctness/trust bug in the app's core "review your day" loop, same category of concern as PROP-004, though it doesn't destroy data (the underlying entries are presumably intact; only the wrong day's data is displayed). Should be scoped once PROP-004 (data loss, higher severity) is handled.

**Goal-adjusted priority:** P2 — Real correctness bug affecting trust in day navigation, but ranked below PROP-004 (actual data loss) and PROP-007 (silently dead escalation feedback) since no data is lost or miscomputed here, only mis-displayed.

---
