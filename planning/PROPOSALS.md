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
