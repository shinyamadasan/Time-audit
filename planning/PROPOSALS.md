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
