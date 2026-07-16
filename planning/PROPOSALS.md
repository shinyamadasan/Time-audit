# Proposals

> **Triage output, pending human approval.** Claude writes; the human decides.
> Approve one and it moves to `ROADMAP.md` + `BUILD_QUEUE.md`. Nothing here is built.

Each proposal is scored against the north-star goals in `docs/PROJECT.md`.

---

### PROP-001 — Keysmash test noise (captures 12, 16, 36)

id: PROP-001
captures: 20260712T2058Z-12, 20260712T2108Z-16, 20260714T1411Z-36
status: pending
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
status: pending

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
status: pending

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
status: pending
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
status: pending
dup-count: 4

> **Decision: Reject** — Four noise messages: "test" (bot-setup test), "/reject" (mistyped bot command sent as plain text), and two single-character "s" keysmashes. No actionable content.

**Goal alignment:** none — does not serve any North-star goal.
**User value:** none.
**Evidence:** 4 noise messages in quick succession (2026-07-15 to 2026-07-16); pattern matches previous noise batches (PROP-001, PROP-002, PROP-003). The "/reject" message was likely an accidental plain-text send of a bot command.
**Effort:** n/a | **Dependencies:** n/a | **Confidence:** high (noise) | **Ambiguity:** low.
**Why now vs later:** never — discard.
**Goal-adjusted priority:** P3 (reject-class).

---
