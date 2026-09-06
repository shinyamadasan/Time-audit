# Phase 12 — Personal Intelligence v1

> **Status: DESIGN / NOT BUILT.** Canonical design checkpoint, post independent
> adversarial review (verdict: *FIX FIRST* — direction accepted, 14 bounded fixes
> applied here). This document is the fixed target that implementation and
> re-review share. No feature code exists.

Last updated: 2026-09-06. Base: `main` @ `254ab57e1a6453a7301fd79110d9b1dd4ee5089f`.

---

## 1. North star

ChronaSense already records intentions (Today's Plan), measures behaviour (timer
`entries` + `energy` labels + `deriveAttentionSignals`), tracks progress (Learning
Plans, Capability/Career), and connects cross-domain facts (Life Ledger,
Cross-Domain Intelligence). It cannot yet answer, in one place, with cited evidence
and honest confidence:

> **KNOW WHERE I AM + KNOW WHERE I WANT TO GO + KNOW WHAT I ACTUALLY DID
> → WHAT IS THE HIGHEST-LEVERAGE NEXT ACTION?**

The Phase 11.5 product boundary (`APP_CONTEXT.md`) already reserves this slot —
*"Apps record facts. Life Ledger connects them. Obsidian remembers them. Claude
interprets them."* — and names `cross-domain-intelligence-model.js` the deterministic
stand-in, *"the strongest C candidate to migrate out once [an intelligence layer]
exists."* `DECISIONS.md` #21: *"Do not add an LLM to pick or phrase the
recommendation in V1 (AI interpretation is a later layer)."* Phase 12 is that layer.

Phase 12 v1 = the **smallest trustworthy** surface that answers the question once
per meaningful change, **read-only**, with a fact/inference/recommendation firewall
and an explicit "not enough evidence" state. Not a tracker, dashboard, score,
chatbot, or second Life Ledger.

---

## 2. What changed vs the reviewed checkpoint (the 14 fixes)

| # | Reviewer finding | Resolution in this design |
|---|---|---|
| 1 | `sync.bat` pushes `main` unconditionally; one 12.0 slice hides a large broken Android surface | 12.0 **split** into 12.0A (static parity + mirror/check-only tooling + parity test + CI) and 12.0B (Android runtime compat + APK smoke), each independently reviewed & integrated (§13) |
| 2 | INSUFFICIENT_DATA reused Phase 11.8's 15-min display floor | Dedicated **PI sufficiency rule** (§8), structural-first, Phase-12-owned |
| 3 | Same as #2 | §8 enumerates the 7 required cases |
| 4 | `overall = min(nextAction, mainConstraint)` undefined for null/unknown; "≥2 independent facts" unsafe | §7 defines **producer-class independence** and **null/unknown constraint semantics** |
| 5 | Same as #4 | §7 |
| 6 | Durable `ta3-…-override` contradicts "read-only advisory / no schema migration" | §11 — **no durable override state**; behaviour is the override signal |
| 7 | Precedence double-counts tiers 1 & 3; tier 2 has no v1 source; risk of paternalistic override | §9 — merge into **CURRENT SIGNAL OF INTENT**; drop the "urgent commitment" tier; no hidden override |
| 8 | Today teaser risked a second "Next action" CTA | §10 — teaser **annotates the chosen soft branch only**; never a second title/button |
| 9 | Claude role under-specified; could choose candidates | §12 — **PHRASE ONLY**; deterministic code chooses everything |
| 10 | Evidence table not pinned; `attentionSignal` has no record id; unresolvable ids could pass through | §6 — pinned table + synthetic-id rule + `attention::<dateKey>` + **drop-and-recompute** on unresolved |
| 11 | Deterministic v1 never independently shipped before Claude | §13 — deterministic v1 integrated + reviewed **before** 12.5 |
| 12 | Fingerprint (`count + latest ts`) misses in-place entry edits | §11 — fingerprint folds per-entry `updatedAt` + mutable fields + id-set + `dateKey`; explicit test |
| 13 | Claude localStorage key assumed safe | §12 — **security precondition** recorded; decided before 12.5, not during |
| 14 | Design lived only in-thread | This document (committed on `docs/phase12-personal-intelligence-design`) |

Additional accepted review points: CDI regression fence (§14); the extra chaos
scenarios (§ Acceptance); Meal/Workout/Ledger "not evaluated" discipline inherited
verbatim (§4); the exact 12.0A dependency closure (§13).

---

## 3. Architecture

**Extend Cross-Domain Intelligence as the single recommendation engine. Do not
build a second ranker.** (`DECISIONS.md` #27.)

`buildCrossDomainIntelligence({characterSheet, ledgerEvents, learningPlans,
capabilityProfile})` already provides the machinery Phase 12 needs: the
`FACT → SIGNAL → CANDIDATE → RECOMMENDATION` firewall, the
`HIGH/MEDIUM/LOW/INSUFFICIENT` vocabulary, coverage-aware "not evaluated" discipline,
at-most-one `recommendedAction` + ≤2 `alternatives`, abstention rather than
invention, determinism (injected clock, sorted-by-id, `candidateId` tie-break), the
synthetic composite-id pattern (`learning-plan-step::<planId>::<stepId>`), and the
`DECISIONS.md` #21/#22 rationale. It has **59 model tests** that are a regression
fence, not legacy (§14).

Phase 12 widens it, additively:

- **Inputs** gain `{ todayPlan, todayEntries, attentionSignals, todayReview,
  weeklyContext, now, referenceTimeZone }` — read from the **native `ta3-*` stores**
  (`ta3-plans`, `ta3-entries`, `ta3-reviews`, `ta3-weekly-reviews`) directly, **not**
  through the Life Ledger (whose live store holds only `plan_step_completed` +
  Learning-Plan-linked `focus_session_completed` — the time-audit `entries` are never
  bridged, so the Ledger is starved for this purpose).
- **Candidate sources** gain `today-plan-item` (the current/next unfinished plan
  item) and `resume-unfinished` (a plan item with `planTrackedMin > 0 && !done`).
  `learning-plan-step` and `capability-next-action` are unchanged.
- A deterministic **constraint classifier** (`time | focus | planning | execution |
  unknown`) is added as a SIGNAL and as the brief's `mainConstraint` — never as an
  action.
- CDI's coverage gate ("do not turn absence of data into a signal") is **kept
  verbatim** and extended: no plan → not a negative signal; no review → not a
  negative signal.

### Architecture options — verdicts

- **Option A — pure deterministic engine.** Highest reliability, zero hallucination,
  total explainability/privacy, fully offline, matches every `DECISIONS.md` entry.
  **This is v1.**
- **Option B — deterministic engine + Claude interpretation (phrase-only).** The
  eventual shape (the "Claude interprets" north star). Ships as **slice 12.5**, after
  deterministic v1 is a real integrated feature. Claude is bounded to phrasing
  (§12); the deterministic brief is the guaranteed fallback.
- **Option C — runtime LLM with data access / free-form.** **Rejected.** Violates
  the Life Ledger contract (*"LLM confidence is not accepted as factual confidence"*,
  *"statistics must be reproducible without an LLM"*, *"LLM-authored facts … prohibited"*).
  An LLM recomputing authoritative metrics from prose is the exact failure mode the
  codebase is built to prevent.

---

## 4. Scope boundary

### v1 IN

- Read deterministic facts from native `ta3-*` stores + `deriveAttentionSignals`
  output + (if present) Learning Plans / Capability / Character Sheet / CDI.
- Summarise what happened today (≤3 derived facts).
- Name **one** likely constraint (`time|focus|planning|execution|unknown`), hedged,
  `medium` cap.
- Recommend **one** next action (+ ≤2 subordinate supporting items) — or abstain.
- Explain **why** in the fact/inference/recommendation split.
- Cite **evidence** by ids that resolve at build time.
- Expose **uncertainty** (`confidence`, `missingData`, abstention).
- Home: the "Life → Next" subview renders the full brief; the Today action-strip
  teaser annotates a soft branch (§10).
- Refresh on-change only; writeback: none (navigation links only).
- Deterministic engine (Option A). Claude phrase-only layer = slice 12.5.
- Correct the stale Phase 11.8 planning-doc status lines.

### v1 OUT / NOT v1

- Automatic plan edits · autonomous scheduling · "apply this recommendation".
- Continuous / background AI · any daemon · scheduled compute.
- Accountability buddy / social / messaging other people (→ Phase 13, §16).
- Any **new tracking**, collector, or data source.
- A new productivity **score** or index.
- Rewriting / re-deriving historical facts, or altering `deriveAttentionSignals`.
- A general chatbot / conversational surface / AI persona.
- A new top-level nav tab (7 bottom-nav items — "no 8th" invariant).
- Career-leverage recommendations when Capability/Career is unpopulated (silent).
- Cross-day "resume / reschedule / drop" triage (→ later 12.x).
- Firebase sync of the brief.
- Bridging `activity_logged` into the Life Ledger.
- Durable user-override state (§11).
- Any `www/` fix beyond the `index.html` dependency closure; Node-only
  `scripts/*.mjs` workers stay out.

### Meal / Workout / Life-Ledger boundary

Inherit CDI's discipline verbatim. A domain whose source is not live is **"not
evaluated"** — never inactive / healthy / unhealthy / behind — and *"no
recommendation is ever generated from UNKNOWN as though it were ZERO."* Meal /
Workout / Life-Ledger absence is never a negative signal and never evidence for or
against a recommendation while their producers are incomplete. Do not add them to
the packet until their producers are live.

---

## 5. The Personal Intelligence Brief — output contract

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "<ISO — injected clock, never Date.now()>",
  "referenceTimeZone": "<IANA — resolved as CDI/Life Feed/Character Sheet do>",
  "todayKey": "YYYY-MM-DD",
  "inputFingerprint": "fnv1a:…",              // §11

  "whatHappened": [ "<=3 DERIVED FACT strings>" ],
  "whatMatters":  "<one sentence, or null>",

  "mainConstraint": {                          // or null — see §7
    "type": "time|focus|planning|execution|unknown",
    "statement": "<hedged sentence>",
    "confidence": "high|medium|low"            // capped at medium in v1
  },

  "nextAction": {                              // or null when abstaining
    "candidateId": "<sourceKind>::<stable id>",
    "sourceKind": "today-plan-item|resume-unfinished|learning-plan-step|capability-next-action",
    "title": "<imperative>",
    "reason": "<why this, now>",
    "homeView": "today|learning|career",       // deep-link target
    "confidence": "high|medium|low"
  },

  "supporting": [ { "kind": "...", "title": "...", "confidence": "..." } ],  // <=2, subordinate

  "facts":        [ { "statement": "...", "evidenceRefs": [ "<evidence[] index>" ] } ],
  "derivedFacts": [ { "statement": "...", "evidenceRefs": [ ... ] } ],
  "inferences":   [ { "statement": "...", "confidence": "...", "evidenceRefs": [ ... ] } ],

  "evidence": [ { "sourceType": "...", "sourceId": "...", "date": "YYYY-MM-DD",
                 "fact": "...", "confidence": "high|medium|low" } ],

  "confidence": "high|medium|low|insufficient_data",   // §7
  "missingData": [ "<what would raise confidence>" ],
  "abstained": false,
  "abstentionReason": null
}
```

**One `nextAction`. Never a list.** `supporting[]` ≤ 2 and visually subordinate —
not a second CTA (`DECISIONS.md` #26). Two indistinguishable candidates with no
evidence to separate them → prefer abstention or a low-confidence current-intent
fallback over a coin-flip presented as confidence. The shape deliberately mirrors
CDI's existing `explanation` object so the renderer and tests are a small delta.

---

## 6. Fact / Derived-fact / Inference / Recommendation firewall + evidence

Four layers, each consuming only the layers below. **Code owns FACT + DERIVED FACT.
The deterministic engine owns INFERENCE + RECOMMENDATION in v1. Claude (12.5) may
only phrase INFERENCE and RECOMMENDATION — never author a FACT, a DERIVED FACT, a
number, or a confidence value.**

| Layer | Definition | Producer |
|---|---|---|
| **FACT** | Directly recorded value, zero computation | native stores |
| **DERIVED FACT** | Deterministic computation over facts; reproducible; carries no confidence | engine, reusing `planTrackedMin`, `computeInsights`, `deriveAttentionSignals`, `getLearningPlanProgress` — **never recomputed or overridden** by the engine |
| **INFERENCE** | A pattern claim beyond arithmetic — probabilistic, falsifiable, carries an explicit confidence + evidence ids | engine rules (v1); Claude phrasing only (12.5) |
| **RECOMMENDATION** | The single next action + rationale, from the precedence model (§9) | engine chooses (always); Claude phrasing only (12.5) |

A RECOMMENDATION or INFERENCE may cite **only** already-resolved evidence ids.
Neither is ever persisted as history. The only durable write in v1 is the disposable
brief cache (§11).

### Evidence identifier contract (pinned)

| `sourceType` | `sourceId` | kind |
|---|---|---|
| `planItem` | `plans[dateKey].items[].id` (`'p'+base36`) | real record id |
| `timeEntry` | `entries[].id` (number) — pair with `updatedAt` for edit-detection | real record id |
| `dayReview` | `dateKey` (`YYYY-MM-DD`) | real record key |
| `weeklyReview` | `weekKey` (`getWeekKey()`) | real record key |
| `learningPlan` | `plan.id` (UUID) | real record id |
| `learningPlanStep` | `learning-plan-step::<planId>::<stepId>` | **valid synthetic** (CDI already ships it) |
| `capabilityEvidence` | evidence UUID | real record id |
| `capabilityStall` / `capabilityNextAction` | `capability-next-action::<kind>[::<projectId>]` / `capability-stall::<type>::<skillId\|projectId>` | **valid synthetic** (CDI already ships it) |
| `lifeLedgerEvent` | `eventId` (UUID) — coverage-gated | real record id |
| `derivedMetric` | `computeInsights::<weekKey>::<field>` — `<field>` from the FROZEN `computeInsights` return shape only | **valid synthetic** |
| `attentionSignal` | `attention::<dateKey>` (day-level deterministic derivation) — OR, for an event-level claim, anchor to real surrounding entry ids: `attention-break::<entryIdBefore>::<entryIdAfter>` | **valid synthetic** (no persisted record exists — do not pretend one does) |

**Synthetic-id rule.** A synthetic reference is legal only when it is a *total, pure*
function of identifiers/keys that already exist and are themselves stable — a real
object id, an ISO date, a `weekKey`, or a field name drawn from a **frozen enumerated
list**. It must resolve deterministically back to a real object/value, and contain
**no free text, no display string, no array index, no value that changes on a
non-semantic edit**.

```
VALID:   computeInsights::2026-W36::deepPct        capability-stall::<skillId>
         learning-plan-step::<planId>::<stepId>    attention-break::<entryIdA>::<entryIdB>
INVALID: plan-item::<task text>                    attention-break::<wallClockOffset>
```

**Unresolved evidence.** If an evidence id does not resolve at brief-build time, that
evidence is **dropped and confidence is recomputed** — it never silently passes
through, and a deep-link is never left dangling.

---

## 7. Confidence contract

Four values only, never percentages (CDI's `CDI_EVIDENCE_STRENGTH`):
`high | medium | low | insufficient_data`.

### Producer-class independence

Two facts are **independent** for HIGH confidence only if they originate from
different source **records** produced by different **producer classes**:

```
producer classes (v1):
  self-report            reviews[].focusRating
  plan-state             plan item status / planTrackedMin
  time-entry behaviour   a timeEntry's energy / duration
  learning-plan structure findNextLearningPlanStep / progress
  capability-analyzer output  analyzeCapabilityCareer()
  weekly-review          weeklyReviews[wk].plan / stats
```

```
INDEPENDENT:      plan-state + time-entry behaviour
                  self-report + automatic attention derivation
                  weekly-review intent + today behaviour
NOT INDEPENDENT:  two fields of one computeInsights object
                  attentionBreaks + likelyDistractionMin from one deriveAttentionSignals call
                  a Ledger event + a metric derived solely from that event
                  a plan item + another field derived solely from that same plan record
```

**HIGH requires ≥ 2 facts from ≥ 2 distinct producer classes.** Otherwise cap at
MEDIUM. `medium` = single-source, a close precedence call, or a WEAK-CONTEXT input is
load-bearing. `low` = sparse/partial/stale (> 48 h) load-bearing input, or the
constraint type is a guess.

### null / unknown constraint

- `mainConstraint == null` (engine chose not to name one): **overall confidence =
  `nextAction` confidence, unchanged.** The constraint line is omitted from the UI. A
  missing constraint is not a defect in the recommendation.
- `mainConstraint.type == 'unknown'` (engine tried, could not classify): **overall
  confidence = `min(nextAction, MEDIUM)`.** Shown as an honest "not sure what's in the
  way" line — never a fifth pseudo-category, never forcing INSUFFICIENT_DATA on its
  own.
- Otherwise: **overall confidence = `min(nextAction, mainConstraint)`.**

`mainConstraint` is capped at `medium` in v1 — deterministic pattern-matching on one
day / one week of data is not a `high`-confidence diagnosis.

---

## 8. PI sufficiency rule (Phase-12-owned — NOT `distractionSupportMin`)

`attention-signals.js` `distractionSupportMin = 15` is a **display-suppression floor**
for the `~N min` likely-distraction number only (`attention-signals.js:59`, used at
`:289`). It is **not** a measure of "has the user done enough today to reason about",
and Phase 12 must not couple its abstention decision to a Phase 11.8 display tuning.

**Structural rule (checked first).** Personal Intelligence has enough evidence to act
if **any** reliable candidate source exists:

- an unfinished / current Today Plan item, OR
- a running / current work signal (timer on a task, actively-logged unplanned work), OR
- an active incomplete Learning Plan, OR
- an eligible CDI / Capability candidate, OR
- sufficiently interpretable recent behaviour (see the heuristic below), OR
- sufficiently current weekly intent (a weekly Reflect saved in the last 7 days).

**Behaviour-only heuristic (only when structural sources are all absent).** A
Phase-12-owned number, its value to be set from data during slice 12.1 and documented
here with rationale — *not* imported from `attention-signals.js`. Working definition:
"sufficiently interpretable recent behaviour today" ≈ **≥ 1 non-neutral classified
block AND ≥ 30 classified minutes today** (enough to name a `focus` or `planning`
constraint at LOW confidence). The 30 is provisional and will be validated against
real logs in 12.1.

### Enumerated cases (design intent — locked)

| Situation | Behaviour |
|---|---|
| no plan + shallow/admin only | INSUFFICIENT for a "work next" rec; may still say "plan the day" (planning constraint), LOW confidence |
| no plan + deep work | NOT insufficient — "continue the deep block you're in", MEDIUM |
| no plan + waste/distraction | NOT insufficient — name a focus/planning constraint, LOW |
| plan + zero logging | NOT insufficient — recommend starting plan item 1; constraint = execution |
| Learning Plan only | NOT insufficient — recommend the next step, MEDIUM, constraint = planning |
| Capability only | NOT insufficient — existing CDI path |
| rich weekly context only | NOT insufficient — weekly Reflect + learning carry it; constraint from the week |

### INSUFFICIENT_DATA gate

Abstain (`abstained: true`, `nextAction: null`, `confidence: "insufficient_data"`,
plain `abstentionReason`) **only when** plan **and** behaviour **and** learning
**and** capability are *all* empty/insufficient per the rule above. Then the brief
shows **what to add and the one action that would fix it** — never fabricated advice.
`unknown` constraint alone never triggers this gate (§7).

---

## 9. Recommendation precedence

Small, explicit, ordered. First tier that yields a candidate wins; lower tiers become
`supporting[]`.

| # | Tier | Trigger (data that exists in v1) |
|---|---|---|
| 1 | **CURRENT SIGNAL OF INTENT** | a running timer, OR an explicitly chosen / active plan item (`isPlanTaskActive`), OR actively-logged unplanned work |
| 2 | **CURRENT REMAINING INTENTION** | `getNextPlanItem()` returns an unstarted unfinished plan item |
| 3 | **LEARNING PLAN** | active plan, incomplete step, and (CDI rule) target-aligned OR actively tracked |
| 4 | **ELIGIBLE CAREER / CAPABILITY** | Capability/Career populated + a stall anchored to a target-linked project (CDI tiers) |
| 5 | **OPTIONAL SUPPORTING OPTIMISATION** | "close the loop", "log the 40-min gap", "you're at 3 plan items — don't add a 4th" — usually `supporting[]` only |

- The former separate "explicit current intention" and "unfinished in-progress work"
  tiers are **merged** into tier 1 (a running timer *is* the unfinished work — they
  double-counted).
- The former "genuinely urgent commitment" tier is **dropped** — v1 has no reliable
  data source for it; dead/fake scaffolding is not shipped. An urgent commitment is
  handled purely by the user acting (which becomes tier 1 on the next build).
- **Stale / recency-only plan items do not automatically outrank obviously current
  work.** Within the "remaining intention" band, compare on evidence strength, not
  rigid app-state order (mirrors CDI's demotion of recency-only picks). A high-value
  Learning step may outrank a stale low-value Today item.
- **Explicit current behaviour wins.** The engine states "you're on X"; it never
  silently overrides to "you should really be on Y". If the logs contradict a
  self-rating, confidence drops and the conflict is stated — **no hidden
  paternalistic override.** The reasoning is always shown.
- The `mainConstraint` may *reorder within a tier* but never *skip* a tier — e.g. a
  `planning` (overplanning) constraint with 3 unstarted items → "start item 1, drop
  the lowest", not "replan".

---

## 10. UI home + Today teaser

### Primary — the "Life → Next" subview

`#view-life` → "Next" subview (`#cross-domain-intelligence-root`,
`renderCrossDomainIntelligence()`) re-rendered to paint the full brief: *What
happened · What matters · Constraint · Next action · Why (facts / what this suggests
/ recommended) · Evidence · Confidence · Missing data*. **No 8th nav tab.** The
existing subtitle already fits: *"What deserves attention next … Facts first, then at
most one suggested next action."*

### Secondary — the Today action-strip teaser (annotation only)

`renderTodayActionStrip()` (`index.html:4903–5005`) is a strict mechanical cascade:

```
remoteActiveTimer > focusSessionRunning > missedCloseout > break > away >
running > noPlan > unlogged>=30min > nextPlanItem > closeoutDue > planClear
```

The first seven are **URGENT MECHANICAL STATE**. Personal Intelligence **never
appears on those branches and never suppresses them.**

On the **soft branches only** (`noPlan` / `nextPlanItem` / `closeoutDue` /
`planClear`), the teaser **annotates the branch the cascade already chose** — one
line, e.g.:

```
Next: Finish opportunity architecture           ← the strip's existing branch, unchanged
Personal Intelligence — Why this? (high) →       ← the teaser: label + confidence + deep-link
```

It does **not** render a second "Next action" title, does **not** swap the branch's
button, and uses distinct labelling ("Personal Intelligence" / "Why this") so there
are never two "Next" claims. **One visible primary action on Today, always.**

---

## 11. Refresh, fingerprint, and writeback

### Refresh — compute on change, never in the background

Recompute the brief when **any** of: the subview or the Today teaser is opened **and**
the `inputFingerprint` differs from the cached brief's; the user taps "Refresh";
`saveReview()` completes. **No** background compute, daemon, once-per-day cron, or
continuous tokens. (12.5: the Claude call fires only on an explicit open/refresh with
a changed fingerprint.)

### Fingerprint contract (edit-safe)

A deterministic canonical change-hash (FNV-1a is fine — change-detection, not a
security hash; reuse `life-ledger-core.js`'s hasher). It **must** detect ordinary
in-place edits, so `entry count + latest ts` is **insufficient** (`ts` is the block
end time, not an edit time). Fold in:

- **entries in window** — per entry `{ id, updatedAt, energy, activity (only if the
  recommendation consumes it), onPlan, blockIntervalMin }` + the **entry id-set**
  (detects deletions).
- **plan items** — `{ id, task, when, done, doneAt, updatedAt }` + the **plan
  item id-set**.
- **reviews** — `reviews[dateKey]` relevant values + `_savedAt`.
- **learning** — active plan id + the step ids / completion states that drive the
  candidate.
- **capability** — the candidate-driving state (not merely `nextAction.kind` if more
  detail can change the candidate).
- **time** — resolved `referenceTimeZone` + `todayKey`/`dateKey` (so a midnight
  rollover invalidates).

`entries` and `plans` both already carry `updatedAt` (`storage.js:636` stamps every
entry; plans merge per-item by `updatedAt`, `:945`) — no migration needed.

**Mandatory test:** edit an earlier entry's `energy` — same entry count, same latest
`ts` — the fingerprint **MUST** change.

### Cache

`{ brief, inputFingerprint, generatedAt }` in `localStorage` key
`ta3-personal-intelligence-v1`. **Local-only — never Firebase-synced** (it's a
derived view; a stale synced brief is worse than a recompute). May come back empty;
the engine rebuilds silently.

### Writeback — READ-ONLY ADVISORY

v1 will **not** automatically edit Today's Plan · mark Learning steps complete ·
reschedule · edit capability/career evidence · write the Life Ledger · write Obsidian
· change a career target · store the brief in Firebase. The brief may only
**navigate** (`showView()`), like CDI today.

**No durable override state.** There is no `ta3-…-override` key. User disagreement is
represented by **real behaviour** — they start another task / timer, change the plan,
edit logs — and the next build re-reads reality (tier 1). If a within-session "not
now" dismissal is ever added, it lives **inside the disposable brief cache object**,
same-day only, local-only, never Firebase-synced, dropped on fingerprint/date change
— a render hint, never a fact. Preference: no explicit dismissal state unless UX
genuinely needs it.

---

## 12. The Claude interpretation layer (slice 12.5)

### Role — PHRASE ONLY

Deterministic code owns: candidate generation, ranking, the chosen `nextAction`, the
constraint, facts, derived facts, confidence, and abstention. Claude receives the
chosen `candidateId` + the evidence ids + the deterministic constraint and returns
**only**: `whatMatters`, `whyLines`, `constraintSentence` — bound to ids that already
exist, **no new number, no new evidence id, no raised confidence, no alternative
candidate, no rewritten fact**. Any invalid field → **deterministic fallback** (the
Option A brief renders unchanged). Letting Claude *choose* among candidates would
contradict `DECISIONS.md` #21 and is where silent, hard-to-debug failure enters
(global `CLAUDE.md` §5).

The packet sent to Claude is **derived-facts-only** — no raw activity strings, no
browsing data, opt-in, schema-validated on the way out, size-capped. Log the packet
shape, never its values.

### Security precondition (must be resolved before 12.5 implementation, not during)

`index.html` is a 552 KB single file with extensive `innerHTML` assembly; any
stored-XSS sink exfiltrates a raw key from `localStorage`. **Do not assume a raw
Anthropic key in `localStorage` is safe.** Before writing 12.5 code, explicitly
choose among:

- **session / in-memory key** (prompt per session; nothing persisted) — preferred;
- **persisted local key with a documented, accepted threat model**;
- **proxy / backend** (changes the key-storage story entirely).

Required regardless of choice: the key is **never** included in any Firebase sync
path (audit `storage.js`'s sync key fan-out — `weeklyReviews`/`plans`/`settings` show
how easily a new key rides along); **never** written to `claude-session.log` or any
console; **never** in the evidence packet. Ship a "clear key" control and a clean
deterministic fallback on a 401. Confirm client-side Anthropic API / CORS viability
(or the need for a thin proxy) **before** choosing the architecture. None of this
blocks deterministic v1.

---

## 13. Implementation slice sequence

```
12.0A  Static root <-> www parity + safe tooling
       - mirror EXACTLY the browser-runtime dependency closure rooted at index.html
         (NOT a blind "*.js" glob):
           classic:  storage.js, insights.js, focus-wallet.js, focus-mode.js
           modules:  attention-signals.js (present) + the 7 currently-missing entrypoints
                     learning-plan-ui.js, capability-career-ui.js, life-feed-ui.js,
                     cross-domain-intelligence-ui.js, life-character-sheet-ui.js,
                     life-ledger-export-ui.js, life-ledger-sync-status-ui.js
           + every transitive import of those (~22 -model/-repository/-import/
             -analytics/-core/-runtime/-adapter files, none in www/ today)
           css:      style.css (stale in www/), capability-career.css (missing)
           pwa:      sw.js
           EXCLUDE:  *.test.js, tests/*.spec.js, test.js, eslint.config.js,
                     playwright.config.js, scripts/**, setup-*.ps1, sync.bat/sh,
                     contracts/**, fixtures/**, android/**
       - sync.bat / sync.sh become MIRROR / CHECK-ONLY: compute the closure, copy it,
         exit non-zero on drift. NO git add/commit/push. NO `npx cap sync android`.
       - a separate, explicitly-named script (e.g. scripts/deploy-release.ps1) is the
         ONLY path that runs `cap sync` / does git work; it branches before committing
         and never pushes main directly.
       - a parity test PARSES index.html's <script>/<link> graph and asserts every
         referenced file (and its imports) exists in www/ and is byte-identical;
         wired into CI (--check mode on every PR).
       -> INDEPENDENT REVIEW -> INTEGRATE

12.0B  Android runtime compatibility + APK smoke
       - activate the now-mirrored Life-OS modules under the Capacitor https scheme
       - feature-detect browser-only APIs (life-ledger-sync-bridge.js
         showDirectoryPicker is Chromium-only; also Intl zones, structuredClone,
         dynamic import) with graceful degradation — a throw at module load must not
         white-screen the app
       - resync stale www/style.css + www/focus-mode.js
       - manual APK smoke checklist: each Life-OS view (Life / Learn / Career / Next)
         renders, no console 404s, Obsidian-sync UI shows "unavailable on this device"
         not a crash
       -> REVIEW -> INTEGRATE

12.1   Canonical contracts finalised in this doc: evidence resolver
       (sourceType/sourceId), synthetic-id rule, dedicated PI sufficiency rule
       (set the behaviour-only number from real logs, document why), input windows
       (7-day today-reasoning / up to 30-day weekly context), timezone-consistent
       windowing (referenceTimeZone()).

12.2   Deterministic engine: extend buildCrossDomainIntelligence with the merged
       precedence tiers (§9) + the constraint classifier + the confidence contract
       (§7) + the INSUFFICIENT_DATA gate (§8). The 59 CDI model tests stay green
       UNCHANGED; new Today/attention/plan tiers = new additive test files (§14).

12.3   Brief cache + edit-safe fingerprint (§11), incl. the mandatory in-place-edit
       test.

12.4   Today teaser as soft-branch annotation only (§10).

  ---> INDEPENDENT REVIEW OF DETERMINISTIC v1 -> INTEGRATE -> VERIFY -> HOUSEKEEPING
       (deterministic Personal Intelligence v1 is now a real shipped feature;
        DECISIONS #26 + #27 already recorded)

12.5   Claude PHRASE-ONLY interpretation layer (§12), after the security precondition
       is resolved in writing.
       -> ITS OWN REVIEW -> ITS OWN INTEGRATION   (never bundled into deterministic v1)
```

User intervention points: 4 review/integrate gates (12.0A, 12.0B, deterministic v1,
12.5).

### Files (future implementation — none touched now)

- `cross-domain-intelligence-model.js` (+ `.test.js` — additive files only) — widen
  inputs, add candidate sources, constraint classifier, merged precedence.
- `cross-domain-intelligence-ui.js` (+ spec) — full-brief render, native-store reads,
  refresh control.
- `index.html` — `renderTodayActionStrip()` soft-branch annotation; Life subview copy.
- `sync.bat` / `sync.sh` + new `scripts/deploy-release.*` + `test.js` (parity test) —
  **12.0A only**.
- `www/` — **12.0A only** (the dependency closure).
- New: `personal-intelligence-*.test.js` (trust / chaos / insufficient-data);
  `personal-intelligence-interpret.js` (12.5 only).

### Protected / not touched (ever, by Phase 12)

- `README.md` — SHA256-locked.
- `attention-signals.js` — read its output; **never** change its computation.
- Life Ledger core/runtime/transport/sync, Obsidian sync, Meal/Workout adapters.
- `storage.js` schema — no migration; read-only over existing `ta3-*` keys.
- Focus Mode, Focus Wallet, streaks, penalty/escalation (FREEZE).
- Firebase paths / RTDB rules — no new synced subtree.

---

## 14. CDI regression fence

- **One ranking engine only.** Phase 12's tiers *extend* CDI's discrete-tier ranking;
  there is no second scoring function and no second `recommendedAction` producer. The
  Today action strip's mechanical cascade is **not** a recommendation engine and
  stays purely mechanical.
- CDI's **59 existing model tests** and its abstention guarantees are a **fence, not
  legacy**. If extending the candidate set / ranking forces a change to an existing
  CDI assertion about learning/capability behaviour or abstention, that is a signal
  the extension broke a guarantee — **investigate the design, do not update the
  test**. New Today / attention / plan cases are **additive** test files.

---

## 15. Chaos / acceptance scenarios

The 14 base scenarios (almost-no-data · overplanning · valuable unplanned work ·
productive app-switching · wrong browser-ext "waste" label · mid-day priority change ·
client emergency vs Learning Plan · stale career target · Meal/Workout missing ·
self-rating vs auto-attention disagreement · domains disagree · recommendation already
completed · yesterday's pattern doesn't generalise · stale Life Ledger) **plus** the
reviewer's additions:

1. **Entry edited in place** — same count, same latest `ts` — fingerprint **MUST**
   change (§11). Highest priority.
2. `www/` module 404 on Android (regression of the 12.0 fix) — degrades that surface
   only; never white-screens the app or the teaser.
3. Mirror script run mid-review — structurally impossible after 12.0A (no push path);
   test that the mirror script contains no `git push`.
4. `computeInsights` throws / returns partial for an incomplete week — packet builder
   catches, marks `derivedMetric` coverage **ABSENT** (not zero); engine reasons
   without it.
5. Two "independent" facts that are both `computeInsights` fields (or both
   `deriveAttentionSignals` outputs) — confidence **MUST NOT** reach HIGH (§7).
6. `mainConstraint == null` and `mainConstraint.type == 'unknown'` — overall
   confidence is defined and correct (§7).
7. Claude returns a `candidateId` that resolved at packet-build but whose plan step
   was completed (possibly on another synced client) before render — deterministic
   fallback + re-derive; never "finish X" for a done X.
8. Learning plan mutated (step added/removed/reordered) between build and click — the
   `learning-plan-step::<planId>::<stepId>` id still resolves or the recommendation is
   dropped; never a dangling deep-link.
9. Self-rating "focused" while the same day's logs are majority waste — engine
   surfaces the conflict, drops confidence, picks no side silently.
10. Empty plan + a timer running on an accidental task — tier 1 fires, but confidence
    is **LOW** and the runner-up (plan / learning) is shown as a supporting item.

---

## 16. Accountability — Phase 13 disposition

**Do NOT implement in Phase 12.** Design and `DECISIONS.md` #21 agree.

Phase 13 direction (Plan → Execute → Measure → **Supportive Accountability** → Review
→ Better Plan) is acceptable as a **high-level direction only**: mutual opt-in;
high-level adherence, not raw surveillance; no public leaderboard; a schedule
adjustment is **not** an automatic failure. No design commitment beyond that now.

**Why after Phase 12:** supportive accountability needs a trustworthy, sharable "are
you following your plan?" signal — exactly Phase 12's deterministic plan-adherence
derived facts (`planCount` vs `planDone` vs `planTrackedMin`, weekly planned-vs-
completed). Building 13 first would invent that signal twice.

**Pre-Phase-13 task (not Phase 12):** inventory the existing Firebase room state —
`rooms/<code>/reviews` and `rooms/<code>/weeklyReviews` already exist, and the
codebase carries "accountability-partner" / "weekly accountability summary" terms.
Any such state must be audited (live / legacy / dormant) before Phase 13 designs on
top of it.

**Not locked:** if the live roadmap after Phase 12 review suggests a better next step
(e.g. bridging `activity_logged` into the Life Ledger to feed richer intelligence, or
the cross-day resume/reschedule triage), that can take the Phase 13 slot instead.

---

## 17. Accepted limitations

- CDI's input surface genuinely widens (Today Plan, entries, reviews, attention
  signals added to a 2-source engine). Accepted as **bounded** because it stays one
  precedence cascade and existing CDI behaviour is regression-locked (§14).
- v1 names at most **one** constraint from five coarse categories; nuance (energy,
  recovery, motivation, priority) is only *evidence*, folded under the five, never a
  separate actionable lever in a read-only advisory. Revisit only if Phase 13 gains
  the ability to act on them.
- Android APK smoke is **manual** (`android/` is gitignored, no device CI). 12.0B
  ships a written checklist, not automation.
- The brief cache is best-effort per-device (`localStorage`); it can come back empty
  and the engine must rebuild silently.
- No cross-day resume / reschedule / drop in v1 (deferred by design).
- `DECISIONS.md` #2 ("classic `<script>`, not ES modules") is already partially stale
  — 8 module entrypoints load as `type="module"` today. **Not a Phase 12 fix**; noted,
  not acted on.

---

## 18. Open questions for re-review

- The behaviour-only PI-sufficiency number (§8) is provisional (30 classified min) —
  confirm against real logs in 12.1.
- Constraint taxonomy: is `time | focus | planning | execution | unknown` the right
  five, or is one missing for this user's patterns?
- 12.0A parity test: parse `index.html` at test time (robust to new `<script>` tags)
  vs a maintained manifest (simpler, drifts) — recommend parse-at-test.
- Does the "Life → Next" subview need a rename now that it carries the full brief, or
  does "Next" still read correctly?

---

## 19. What Phase 12 v1 still does NOT do

- It never edits your plan, completes a step, reschedules, or writes anything you'd
  have to undo.
- It never runs in the background or spends tokens on its own.
- It never tells you about a domain it can't actually see (Workout / Meal / career
  when unpopulated stay silent, not "behind").
- It never presents more than one primary next action.
- It never lets an LLM compute a number, a confidence, or choose the recommendation.
- It never invents advice to fill an empty screen — it says what's missing instead.

---

## 20. Activation (post-review)

1. Re-review **this document** (not an in-thread summary).
2. On sign-off: begin **12.0A** on its own branch → independent review → integrate.
3. Then 12.0B → review → integrate.
4. Then 12.1–12.4 → independent review of deterministic v1 → integrate → verify →
   `STATUS.md` / `CHANGELOG.md` / `ROADMAP.md` / `APP_CONTEXT.md` housekeeping →
   `DECISIONS.md` #26 + #27 confirmed against the shipped behaviour.
5. Resolve the §12 security precondition in writing.
6. Then 12.5 → its own review → its own integration.

Phase 12 is **not** built until 12.4 integrates. It is **not** complete until 12.5
integrates or is explicitly deferred.
