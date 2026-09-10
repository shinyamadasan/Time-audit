# ChronaSense evidence contract V1

Canonical semantic authority for evidence use. This foundation does not change source
schemas, capture flows, accounting code, or historical records. Existing wire contracts
remain authoritative for serialization; this document governs what those bytes justify.

**Truthful evidence -> honest missingness -> interpretation -> advice.** An observation
must not silently become an interpretation; missingness must not become behavior; an
assumption must not become an actual fact. These rules supersede older behavioral wording,
including references to gaps as lost time and source-recorded confidence as certainty.

## Accounting and missingness

- **Accounting day:** midnight to the next midnight in an explicit, stable accounting
  timezone, using actual elapsed time between those boundaries. Never assume 1,440 minutes
  across timezone offset transitions. Source timezone and accounting timezone have different
  jobs; preserve source context while declaring the accounting timezone. This is the
  whole-life denominator, not a claim that every minute is understood. V1 defines this
  rule only: no new timezone setting, date behavior, or accounting engine is implemented.
- **Timeline gap:** no qualifying interval record in a diagnostic scan window. Its meaning
  depends on that window, record eligibility, and threshold. Current gap totals MUST NOT
  become whole-day coverage, unknown time, or a coverage percentage.
- **Unobserved time:** no relevant source observation, relative to the source and question.
- **Unknown time:** activity meaning or allocation cannot be established for the question.
  Observed time can still be unknown. Unknown is not zero, waste, drift, distraction,
  avoidance, recovery, or failure.
- **Known occurrence:** evidence that something happened; it does not establish duration.
- **Known duration:** evidence of an elapsed or estimated duration; it need not establish
  exact placement or purpose. Preserve whether it is measured or estimated.

A browser interval may remove a timeline gap while purpose remains unknown. A completed
workout may have known occurrence but unknown duration. User-asserted cooking of about
60 minutes can have approximately known duration without exact clock placement.
Unknown and unobserved are absence states, never synthetic positive activity records.
A known count of zero source records is not proof of zero behavior.

## Resolution, provenance, and measurement

**Evidence resolution** describes what temporal evidence exists, independently of origin:

| Positive form | Establishes | Does not establish |
|---|---|---|
| Interval | Source/user supplies start and end; supports temporal allocation | Uninterrupted attention, productivity, purpose, or label correctness |
| Duration without placement | Stated duration within a declared date/window | Exact start/end or hourly placement |
| Occurrence only | Something happened | Any duration without another duration source |

Duration-without-placement has a first storage/capture implementation as of Phase 6H
(`feat/coarse-life-evidence-v1`, uncommitted candidate) — see "Implementation status
(Phase 6H)" below. Do not use fallback timestamps, a schedule, a default duration,
start=end placeholders, or arbitrary estimates to manufacture missing duration. Existing
source equal-endpoint encodings can be preserved as compatibility data, but do not turn
an occurrence into a measured zero-minute interval. Date precision alone supplies no duration.

**Provenance** describes origin and transformation, not resolution. Reuse source IDs,
source references, `captureMethod`, Ledger provenance, adapter fields, and source flags:

| Distinction | Current evidence / interpretation limits |
|---|---|
| User assertion | Manual/retro/quick log or explicit completion; meaning asserted by user, not independently verified |
| Timer observation + user label | Timer interval plus chosen activity; elapsed recording is not uninterrupted attention |
| Passive device observation | `browserUsage`, `source: browser-extension`, `phoneUsage`; adapter `browser_usage` / `phone_usage`; only source-limited device/site state |
| Schedule assumption | `scheduledAutoLog` and template linkage; adapter `scheduled_template`; intended/assumed, never confirmed actual just because auto-logged |
| Imported/source fact | Source ID/reference, adapter and observation context; imported does not mean verified, source-recorded does not mean behavioral certainty |

These are semantic distinctions, not a new enum or a claim that legacy metadata is complete.
The ordinary-entry adapter's default `timer` is a fallback classification, not proof of a
particular capture path. `autoLogged` alone does not distinguish schedule from observation.
Current capture-method precedence can hide one flag when incompatible flags coexist; do
not infer a complete history from the normalized field or invent retrospective provenance.

**Measured vs estimated:** measured/source-reported means a source reports duration from
its recording (for example a 47-minute workout); estimated means an explicitly approximate
assertion (for example "cooking took about an hour"). Neither proves purpose or correctness.
An exact-looking timestamp or integer minute value does not prove measurement. Keep an
approximate assertion approximate; no estimate schema or universal score is introduced.

## Question-specific evidence fitness and allowed use

**Evidence fitness** is whether the evidence's resolution, provenance, meaning, lineage,
and limitations support a particular question. It is not a property conferred by valid
JSON, a successful import, a Ledger copy, or a numeric score.

| Evidence | Allowed | Not automatically allowed |
|---|---|---|
| Interval + user meaning | Recorded duration, asserted project allocation, overlap analysis | Productivity, uninterrupted focus, total work performed |
| Duration without placement | Explicitly approximate time budgets when estimated | Exact timestamps or hourly placement |
| Occurrence | Completion/adherence when occurrence is established | Invented duration |
| Passive device observation | Observed foreground/device patterns within source limits | Confirmed purpose, value, learning, distraction, waste, or productive work |
| Schedule | Intention, planning, plan-v-actual comparison target | Actual occurrence |
| Unknown | Missingness and limitation statements | Zero behavior, waste, drift, distraction, avoidance, recovery, or failure |

A recorded GHL interval supports "How much GHL time did ChronaSense record?" It does not
by itself answer "How much did I work today?" or "Was today productive?" YouTube and
Facebook are not waste by identity; GitHub is not deep work by identity. A user interpretation
must remain explicitly attributed, not recast as source-confirmed behavioral truth.

**Overlap:** primary elapsed allocation counts each elapsed moment once. Simultaneous
contextual evidence may describe that same moment but cannot add it again. Sixty minutes
of client work plus browser observation during the same hour is sixty elapsed minutes,
not 120. Per-category unions are not a mutually exclusive allocation. No allocation engine
is implemented here.

**Ledger lineage:** source record -> normalized Ledger projection is one evidence lineage,
not independent corroboration. Preserve source IDs, logical keys, references and provenance.
A retry, revision, physical replica, normalized copy, or multiple references to the same
source is not another witness. The Learning Focus bridge supplies `focusEntryId` and
`additiveForTimeTotals: false`; retain that relation when using its interval context.

**Confidence fields:** the existing `confidence.score: 1, basis: source-recorded` is a
producer's deterministic assertion about source-recorded facts/normalization, not a
calibrated probability and never 100% behavioral certainty. Existing adapters assign other
values/bases for source-specific limitations. Interpret the basis and producer contract;
do not rank different producers as a universal evidence score. Structural validation
cannot establish attention, purpose, truthfulness, or fitness for a new question. Existing
Career/CDI confidence or evidence-strength labels describe their rule outputs, not this
contract's universal confidence. No new confidence framework is added.

## Production boundary decision and quarantine scope

There is no shared confirmed-behavior gateway across all current consumers. The ordinary
ChronaSense adapter/date reader is outside the loaded app runtime and emits source drafts,
not higher-level judgments. Ledger validation checks schema, temporal consistency and
identity; deleting schedule or passive observations there would lose legitimate source
facts and planning/device evidence. Life Feed is a display projection, not a fitness gate.

One existing, active, bounded boundary fits: `capability-career-analytics.js`:
`currentEvidenceScope()` already excludes future, unavailable and tombstoned evidence
before capability counts, dimensions, momentum, project signals and next actions.
It now also excludes a referenced Ledger event whose payload OR provenance has
`captureMethod: scheduled_template`, with reason `life-ledger-schedule-assumption`.
The original profile, mappings and Ledger records are preserved. This prevents recognizable
schedule assumptions from counting as current capability proof, even with a user mapping.
It does not claim all unmarked legacy assumptions can be identified. No new API or
unused future-Advisor layer is created. The browser runtime mirror is identical.

Passive facts are not automatically capability mappings: the user explicitly supplies the
meaning/dimension. This existing user-assertion path remains available; it is not passive
identity proving purpose. The scope function does not calculate duration or turn gaps into
behavior. No broad passive exclusion, duration rewrite, lineage deduplicator, or attention
rewrite is justified at this mapping boundary. Those rules remain canonical requirements
for future question-specific consumers, not a claim of universal runtime enforcement.

Quarantined semantics: schedule-as-actual, unknown-as-drift/waste, app-as-purpose,
manufactured duration, additive overlap, Ledger-copy corroboration, confidence-as-certainty,
and suspect expired-Focus duration MUST NOT be promoted into higher-level confirmed
behavior. Apart from the narrow schedule exclusion, this is a semantic quarantine, not
new persisted flags, a record filter applied everywhere, or historical data repair.

## Consumer inspection and current implementation deviations

Inspection baseline: `eb977d007ab7082a0cdf8329613b008a0e502c4d`.
The canonical rules above are normative. The following describes current implementation,
including deviations deliberately left in place, rather than redefining those rules.

| Consumer / entry point | Finding and disposition |
|---|---|
| `storage.js:getWorkDayStartTs`, `index.html:computeGaps` | Actual anchor is earliest supplied non-missed entry; empty input returns `Date.now()`. Empty days can have no gaps, especially past days; morning before the first entry disappears. The five-minute threshold, interval union and active-timer suppression are diagnostic only. Older AGENTS/DECISIONS wording about a configured work-start anchor contradicts current code; this inspection follows the code. No gap/date change. |
| `storage.js` date readers; `index.html:sumEntryMinutes` | Configured timezone can fall back to device timezone. UI clips/unions intervals within viewed days, while date export owns whole source records by start date. Neither establishes complete behavioral understanding. Stable accounting timezone is not newly persisted. |
| `index.html:autoLogDueTemplates` | Writes scheduled start/end, category/energy, `onPlan`, `autoLogged`, `scheduledAutoLog`, `templateId`; existing time/plan/insight surfaces can look actual. Templates and those surfaces deferred; recognizable Ledger schedule mappings excluded only at Career scope. |
| `browser-extension/background.js` session writer; Android `syncPhoneUsage` in `index.html` | Browser configuration maps site to energy (default waste) and onPlan; Android writes waste for tracked app sessions. Foreground/source limitations and merge windows cannot prove purpose. Classifications retained, not promoted to canonical meaning. |
| `insights.js:analyzeBehavior`, `renderAwarenessSignal`, `computeInsights`, `generateInsights` | Consume legacy entry labels/totals; elapsed time since last deep block can become reactive-mode/value judgments. Whole-day wording can exceed recorded evidence. No centralized fitness predicate here; broad rewrite deferred. |
| `attention-signals.js:deriveAttentionSignals`, `attentionSignalLines` | Energy/plan membership classifies focus/distraction. An idle gap ends a stretch, enters break/recovery matching, and can yield "Recovered from drift". Gap minutes are not directly added to distraction minutes, but the behavioral recovery interpretation exceeds missing evidence. Deferred. |
| `index.html:sumEntryMinutes`, `sumEnergyMinutes`; `focus-wallet.js` | Whole-set union avoids some overlap, but separate energy unions can both count the same hour and distort percentages. Duration fallback paths and wallet scoring retain legacy assumptions. This is not exclusive whole-life allocation. Deferred. |
| `chronasense-life-ledger-adapter.js:normalizeChronaSenseEntry`, date reader | Rejects missed/template/gap placeholders and invalid intervals; preserves capture method, identity and source references. `scheduledAutoLog` is not `template` and still produces a draft. `intervalFor` can infer start from end minus stored `blockIntervalMin`; that backward-compatible fallback does not prove exact placement or measured duration. No adapter change. |
| `life-ledger-core.js`, `life-ledger-runtime.js` | Validation and immutable source lineage are not behavioral fitness. Runtime publishes Learning completion and linked Focus outcome; ordinary activity adapter is not live ingestion. Source-recorded score is not behavioral certainty. No schema/store change. |
| `life-feed-model.js`, `life-character-sheet-model.js` | Feed projects accepted source records. Character Sheet sums recorded Focus/activity durations; it tracks known workout duration separately, but does not provide full overlap allocation or detect expired Focus. Source connection states are not a whole-day coverage model; zero events does not establish zero behavior. Deferred. |
| `capability-career-analytics.js:currentEvidenceScope`, Career UI | Explicit user evidence dimensions, not keyword/app inference. Narrow schedule exclusion added here; identity/copy corroboration and general evidence-quality scoring are not introduced. |
| `cross-domain-intelligence-model.js`, corresponding UI | Consumes Character Sheet and Career analysis, uses explicit plan/event/skill/target links and live-source restrictions. Receives corrected Career outputs transitively; no separate rule rewrite. Its learning alignment references plan-step completion, not ordinary scheduled activity. |
| CDI `explanation` output; `docs/PHASE12_PERSONAL_INTELLIGENCE.md` | Current model prepares deterministic explanatory output. Personal intelligence/LLM planning is not an active shared raw-evidence input gate. No Advisor/model-input infrastructure added. |
| `life-ledger-transport.js`, `obsidian-life-ledger-renderer.js:buildObsidianLifeLedgerExport` | Snapshot/export preserves source facts and lineage; renderer's workout unknown duration stays explicit. Export validation is not confirmation of category/purpose. No real vault write or interpretive-export redesign. |

Current workout compatibility encodes some unknown-duration history with equal endpoints
and omitted duration; the canonical interpretation is occurrence with unknown duration,
not a new zero interval. Current `_insightMinutes` and entry duration helpers can fall back
to configured/default duration. These deviations remain unsafe for confirmed behavioral
time budgets. Existing tests cover adapter rejection/provenance, unknown workout duration,
non-additive Focus metadata, temporal exports and lineage; this milestone does not alter
Meal or Workout to broaden those semantics.

## Expired Focus: traced defect, no reliable retrospective quarantine

`focus-mode.js:restoreFocusSession()` restores saved start/phase/work minutes and calculates
elapsed time against `Date.now()`. An expired work phase calls `endWorkSession()`, which
uses `Date.now()` as `tsEnd` and the old `focusStartTime` as start. `logFocusSession()` then
writes an ordinary deep/onPlan entry with `id = tsEnd`, `ts`, `tsStart`, computed
`blockIntervalMin`, date, category and originalLabel. A short session restored hours later
can therefore produce hours of apparent deep work.

The resulting entry does not persist planned end, configured work duration, restored-expiry
status or a reliable Focus-origin flag. The restore reconciliation flag is in-memory only.
A long deep record cannot be reliably distinguished from legitimate long timer/manual work.
The linked Learning outcome can retain `pomodoro` capture and the entry reference, but not
the planned end or a marker proving this defect. It inherits the same elapsed interval.
Therefore deterministic affected-record detection is impossible with these stored fields;
no retrospective filter, threshold, guessed metadata, or blanket timer exclusion is added.

Downstream: Today/Review recorded/deep totals, insights, attention signals and Focus Wallet
read ordinary entries. Routine completion hooks and Learning outcomes receive the completed
session; `buildLearningPlanFocusSessionCompletedDraft()` emits non-additive linked metadata
that feeds Life Feed, Character Sheet, CDI and exports, and can be referenced by Career.
Ordinary-entry draft exports also preserve the inflated interval. A source-recorded score
cannot cure this defect. Treat duration from the affected path as unsafe pending a fix;
this milestone does not identify or rewrite uncertain history.

**Next deterministic truth fix:** expired Focus completion boundary V1. Cap an expired
restored work phase at its persisted phase start plus configured work duration rather than
reopen time; reconcile owner/phase identity and guarantee exactly-once logging across reload,
remote takeover and repeat restoration. Test delayed reopen, non-expired restore, manual
exit, break restore, repeated restore and downstream interval parity before changing capture.
Keep historical repair separate: do not infer which old long sessions were affected.
Subsequent separate milestones can address schedule-v-actual capture and diagnostic gaps
versus stable accounting boundaries. No estimate storage or full allocation engine here.

**Implementation status (Phase 6G.1, branch `feat/source-truth-fixes-v1`, uncommitted
candidate):** implemented. `endWorkSession()` now derives its end timestamp from the
planned endpoint — phase start (`focusStartTime`, or `pomodoroPhaseStartedAt` as fallback)
plus configured work minutes — instead of `Date.now()`. It is only ever reached by a phase
that ran to its configured length (`tickPomodoro()` at zero, or `restoreFocusSession()`
after the planned end passed), so the planned endpoint is the truthful end in every caller;
early manual exit stays on `saveActiveFocusSession()` with real elapsed time and is
unchanged. `restoreFocusSession()` additionally re-derives the following break's real
remaining from the wall clock and concludes it once via the existing `endPomodoroBreak()`
when that window also elapsed. Exactly-once: the planned-end timestamp is deterministic, so
a repeat restoration, a second tab, or a page/HUD race recompute the same entry `id`;
`logFocusSession()` now returns the existing entry instead of appending a duplicate when one
with that `id`/`tsStart`/`energy` is already present. Downstream Daily-Routine and
Learning-Plan hooks are keyed by that entry id and converge. Historical repair remains
unavailable and was not attempted: stored fields still cannot distinguish a legitimate long
timer/manual session from an old inflated restored one, so no history scan, cap, deletion or
manufactured restoration metadata was added. Still deferred to 6G.2: Today/Review/insights/
attention-signals/Focus-Wallet interpretation of any pre-fix inflated entries, and the
schedule-v-actual, passive-device-purpose, PC-Time-purpose and unknown-as-drift semantics
below.

**Implementation status (Phase 6G.2, branch `feat/analytics-truth-fixes-v1`, uncommitted
candidate):** implemented for Today, Review, weekly Insights, attention signals and Focus
Wallet. One small shared helper, `evidence-interpretation.js`, answers the single bounded
question every one of those consumers needed: does an entry's `energy` reflect a confirmed
classification (user assertion, or timer + chosen label) or only a passive default / schedule
assumption / "PC Time" computer-session default? It reads existing markers
(`browserUsage`, `phoneUsage`, `source`, `scheduledAutoLog`, `captureMethod`, "PC Time"/
"Screen time" + `autoLogged`/`quickLogged`) — no new schema, confidence score, or persisted
field. `attention-signals.js` inlines the same marker set rather than importing the helper, to
stay dependency-free as designed.

Corrected against the deviation table above:
- `browser-extension/background.js` / Android `syncPhoneUsage` row: default site/app energy no
  longer counts as confirmed deep work or confirmed waste in `computeDailySummary`,
  `computeCloseoutSummary`, the weekly `insights.js` totals, `deriveAttentionSignals`
  classification, or `computeFocusWallet` scoring. The raw entry, its duration and its
  `browserUsage`/`phoneUsage`/`source` markers are unchanged and still render on the timeline.
  A user who reclassifies a passive entry through the retro editor produces a fresh entry
  without those markers (`makeEntry()` never copies them), so an entry that still carries a
  passive marker is provably un-reclassified — explicit user evidence wins wherever the
  metadata can actually distinguish it, and only there.
- `index.html:autoLogDueTemplates` row: the same consumers now exclude `scheduledAutoLog`
  entries from confirmed-behavior totals. Scheduling, storage, provenance and
  plan-v-actual/intent use are unchanged; only actual-behavior metrics are affected.
- PC Time (`startPCTimeLive` → `autoLogBlock('PC Time', lastEntry?.energy || 'deep', ...)`):
  the fallback itself is unchanged (stored fields still cannot distinguish real inherited
  session context from the `|| 'deep'` fallback, so both are treated the same, as documented
  here rather than guessed at). The interpretation layer now excludes any "PC Time"/"Screen
  time" auto/quick-logged block from confirmed deep-work claims and Wallet points.
- `insights.js` row: `_insightMinutes`/`_insightEnergyMinutes` now pre-filter to confirmed
  entries, so `analyzeBehavior`, `renderAwarenessSignal`, `computeInsights`, `checkEscalation`
  (punitive focus-lock escalation) and `renderHonestSummary` all inherit the correction.
  Denominator copy that said "of today"/"of your day" now says "of tracked time"; "clean week"
  is now "No confirmed waste logged this week" / "`N` of confirmed waste logged this week."
- `attention-signals.js` row: a passive, scheduled, or computer-session ("PC Time"/"Screen
  Time") segment classifies `'neutral'`, never focus or distraction, regardless of its
  `energy` — it no longer ends a coherent stretch, feeds the likely-distraction number, or
  manufactures a refocus/recovery claim. The first Phase 6G.2 pass covered the passive and
  scheduled markers but missed the computer-session marker (a real auto-logged PC Time
  `energy: 'deep'` entry could still read as confirmed focus); the targeted independent-review
  fix pass closed that gap with the identical check `isComputerSessionEntry()` uses. Full
  parity with `evidence-interpretation.js`'s three predicates is now confirmed
  regression-tested. `attentionSignalLines()` no longer says "Recovered from drift"; it says
  "Refocused after a break" (an idle gap is unlogged time, and even a user-logged distraction
  only shows a break in the record — neither is established drift by this contract's rules).
  `ATTENTION_SIGNALS_VERSION` bumped 1 → 2 for this classification change.
- Today `#s-deep` ("Deep blocks today") / `#s-streak` ("Deep streak days") row (added in the
  targeted independent-review fix pass): `renderToday()`'s `deepCount` and `computeStreak()`
  counted raw `entry.energy === 'deep'` with no confirmed-energy boundary, unlike the adjacent
  `computeDailySummary()`/`computeCloseoutSummary()` — so a scheduled, passive, or PC-Time
  'deep' entry could inflate the two most prominent Today numbers even though the pulse card
  right next to them already excluded it. Both now filter through
  `hasConfirmedEnergyClassification()` before counting. `computeStreak()` is the one function
  behind `#s-streak`, the Streaks widget, and the Week view day badge, so the fix is consistent
  across all three.
- `buildWeekShareSummary()` row (Low finding, addressed in the targeted independent-review fix
  pass): the "Share week" export made the same unfiltered-energy claim ("Deep work: `X`
  (`Y`% of logged time)", "Best day: … `Z`h deep", "Weekly deep work goal hit"). Deep/waste
  minutes, per-category lines, and the "Best day" deep-hours figure now use the same
  confirmed-only filter; the "Logged" total and "Where my time went" activity breakdown are
  unchanged (presence/duration facts, not energy-classification claims).
- `index.html:sumEntryMinutes`, `sumEnergyMinutes`; `focus-wallet.js` row: the common
  overlap case — a passive browser/phone observation layered over a confirmed work block — no
  longer double-counts, because the passive side is excluded from the energy sums entirely
  (`computeDailySummary`/`computeCloseoutSummary` now summarise
  `dayEntries.filter(hasConfirmedEnergyClassification)`). deep% + waste% can no longer exceed
  100% from that cause. Two *confirmed* different-energy entries genuinely overlapping (a user
  manual-entry error) is unchanged and still deferred — no general allocation engine was built.
  Focus Wallet no longer earns or costs points for unconfirmed-energy entries.
- "Sharpest hour" / "Peak focus hour" copy (`insights.js`, `index.html`): unchanged
  calculation (an entry is still bucketed entirely by its start hour), relabelled to describe
  exactly that — "Deep blocks start" / "most deep blocks started around `X`" / "`N`m of deep
  blocks began then" — instead of implying a stronger per-hour measurement.
- Coverage/completeness: audited, nothing found to correct. No "coverage score",
  "fully tracked", or "all accounted for" claim exists in the current UI; the timeline-gap
  system already speaks only in "unlogged"/"blank ok" language (Phase 6E Review
  simplification), so §15 of this milestone's scope required no change here.
- `computeCleanStreak` label: unchanged detection logic (any waste/distraction entry, passive
  included, still ends the streak — conservative), relabelled "days clean" → "days, no waste
  logged" so absence of a waste record is not read as proof of a clean day.

Unaffected by design: `chronasense-life-ledger-adapter.js`, `life-ledger-core.js`,
`life-ledger-runtime.js`, `life-feed-model.js`, `life-character-sheet-model.js`,
`capability-career-analytics.js`, `cross-domain-intelligence-model.js`, CDI `explanation`
output, `life-ledger-transport.js`, `obsidian-life-ledger-renderer.js` — none of these consume
`evidence-interpretation.js` and none were touched. Their rows above stand as written. Review
reconciliation, coarse-life storage, generic Today-gap removal, Wife/Shared, and Personal
Model/Advisor were explicitly out of scope and not started. Historical Focus data affected by
the pre-6G.1 restoration defect is still not identified, capped or repaired — this milestone
only changed how *currently computed* metrics interpret entries going forward; it does not
know which past entries were inflated and did not guess.

**Implementation status (Phase 6H, branch `feat/coarse-life-evidence-v1`, uncommitted
candidate):** implemented — the minimum truthful storage/capture form for duration without
placement. `coarse-life-evidence-model.js` defines the record shape (`id`, `date`, `timezone`,
`label`, `estimatedMinutes`, `resolution: 'duration_without_placement'`,
`measurement: 'estimated'`, `provenance: 'user_assertion'`, `createdAt`, `updatedAt`) and
rejects any record carrying a `tsStart`/`tsEnd`/`start`/`end` field — this form structurally
cannot smuggle in a fabricated placement. `coarse-life-evidence-repository.js` persists it
locally (`ta3-coarse-life-evidence-v1`, the same local-storage-envelope pattern as
`daily-routines-repository.js` / `capability-career-repository.js`) with a deterministic
`(date, normalized label)` identity: saving the same identity again — unchanged, or with an
edited duration — replaces that one record; it never appends an additive duplicate.
`coarse-life-evidence-ui.js` is the reusable capture/edit modal, mounted as one small optional
access point inside Review's existing optional-details section — not a new tab, not a
mandatory card, not a recurring prompt.

Ordinary interval entries (`entries[]`) were deliberately NOT reused: their schema means
start/end, and this evidence form has neither. The two stores are independent — a coarse
record and a same-category exact interval are surfaced separately (e.g. Review shows
"`X`m recorded" from `entries` and "~`Y`m" from the coarse store) rather than summed into one
"actual" total, since overlap compatibility between them is unknown (per the Overlap rule
above). Nothing in this milestone reads or writes `entries`, the timeline/gap engine
(`computeGaps`), `insights.js`, `attention-signals.js`, `focus-wallet.js`, or
`evidence-interpretation.js` — a coarse record cannot manufacture a timeline block, close a
gap, or acquire deep/waste/streak/Wallet/attention meaning.

Life Ledger projection was deliberately deferred, not built. The generic validator in
`life-ledger-core.js` already tolerates a date-precision, no-instant-fields, `duration: true`
payload shape in principle (the same combination `meal_prepared`'s `temporalPrecision: 'date'`
and `workout_completed`'s `duration: 'optional'` each demonstrate separately, just not
together), so a future `PAYLOAD_RULES` entry is architecturally plausible without changing the
generic validation engine. But actually wiring a new Ledger event type also means the Obsidian
renderer's supported-type list, `life-feed-model.js`'s domain mapping, and any parity-fixture
tests would all need deliberate extension — none of which this milestone's "smallest storage
form" mandate covers. Per this contract's own rule ("do not mutate the canonical Ledger wire
contract casually... a missing projection is better than a lying projection"), 6H ships no
Ledger projection at all rather than a half-wired one. A future milestone can add it.

Cross-device sync was deliberately deferred, matching the existing local-only precedent
(Learning Plans, Daily Routines, Capability/Career are none of them Firebase-synced in this
app either). Not wired into the CSV export or the Life Ledger snapshot export: neither is a
centralized "export everything" backup surface today (CSV covers only `entries`; the Life
Ledger snapshot covers only Ledger events), so there was no existing seam to extend without
redesigning backup, which was out of scope. Both are documented limitations, not oversights.

Still future (as of 6H): daily Review reconciliation, a whole-day coverage model, replacing
the generic Today gap prompt, combined exact+estimated allocation, Life Ledger projection,
cross-device sync, export/import, Wife/Shared, Personal Model/Advisor.

**Implementation status (Phase 6I/J, branch `feat/review-reconciliation-v1`, uncommitted
candidate):** implemented — the minimum end-of-day reconciliation flow, plus removal of the
generic daytime Today gap interruption. No new coverage engine, no interval-allocation
engine, no schema migration, no life taxonomy, no AI inference, no mandatory gap repair.

Reconciliation: Review's existing `#rv-unlogged-decision` block was reworked into one small,
optional, whole-day prompt — "Anything important missing?" (helper text: food, care,
household time, travel, people, or downtime). It is no longer gated on a detected gap
(`unloggedMin >= 30`); it shows on every open of an un-acknowledged day, because ordinary
life can be underrepresented even when `computeGaps()` reports zero gaps, and a raw gap does
not by itself require the user to add anything. Actions: **Add broad activity** (opens the
6H `openCoarseEvidenceEditor(dateKey)` for Review's selected date — no duplicate storage,
no fake placement); **Log time** (only when a >=30m diagnostic gap exists — the existing
gap-jump to the retro editor, unchanged); **Leave unknown** ("there is uncertainty and I
choose not to resolve it" — never fabricates an activity/duration, never closes a gap; when
a real detected gap is present it also sets the existing `unloggedOk`, same user intent);
**Looks about right** ("reviewed, nothing more to add right now" — does NOT claim all time
known, all gaps resolved, 24h complete, or verified). Exact-activity addition for an
arbitrary Review date was NOT built as a new subsystem (§5): `openRetroLog()` is anchored to
"now" and cannot be safely retargeted to a past Review date without new architecture; the
gap-scoped "Log time" path already covers exact entry against a specific detected gap, and
Today's own retro editor covers today.

Persistence: one narrow new review field, `reviews[dateKey].reconciliation` ∈
{`undefined`/`null`, `'reviewed_ok'`, `'left_unknown'`}, saved through the existing durable
Review path (`persist()` + `fbRoomRef.update({ reviews/<key> })`) — no second store, no
score, no `complete`/`closed`/`reviewed` boolean. `unloggedOk` keeps its exact prior meaning
and its `unloggedMin >= 30` save gate (§18 — old and new semantics differ materially, so a
new field rather than reinterpretation). Backward compatibility: an old review with
`unloggedOk: true` and no `reconciliation` field is read as `'left_unknown'` (a truthful
inference — unlogged time was seen and left unknown — not a fabrication); old records are
never rewritten. Reopening an acknowledged day shows a compact "Looks about right" /
"Left unknown" summary, not the full prompt, until the user explicitly clicks **Revisit**;
adding coarse evidence afterwards does not force reconfirmation (§21). "Looks about right"
is review-workflow state only and is never fed to productivity/deep%/waste%/Wallet/
attention/capability/streak analytics (§36).

Today gap interruption removed (§14, ONLY after reconciliation was working): the generic
"first timeline gap >= 30m → Needs You / fill gap" card is gone. `renderGapRecoveryInbox()`
now only ever hides `#gap-recovery`; `GAP_RECOVERY_OPTIONS`, `fillGapRecovery`,
`openGapRecoveryOther`, `logGapRecoveryActivity`, `currentGapRecoveryRange` were removed as
orphaned by that change. `computeGaps()` / `getCloseoutGaps()` are unchanged and still feed
Review's factual summary, Full analysis' "Unlogged intervals" list, and Today Health's quiet
`unlogged` stat. `getGapRecoveryCandidate()` is retained as a pure diagnostic (§16 — raw
gaps must remain available to internal reasoning / debugging / tests). Concrete Needs You
signals (configured sleep reminder, daily-routine due/error, active-Focus reload recovery)
are untouched (§15). The "Close day" CTA sub-copy "Fill or mark missing time, then pick
tomorrow." was dropped — it carried the same gap-based pressure.

Deliberately NOT done in 6I/J: whole-day coverage model / coverage %, combined
exact+estimated allocation, coarse-evidence durability / cross-device sync (still local-only
through 6I — **durability is still required before Wife/Shared or serious dogfood**), Life
Ledger projection of coarse evidence, export/import, Wife/Shared, Personal Model/Advisor. No
passive-source / energy-classification semantics were reopened (§26). Review's core stays
simple — factual summary, optional feeling, optional one win, Save/Close, optional details,
Full analysis, subordinate Plan Tomorrow — no Reality Score, judgment grade, gap worksheet,
waste form, mandatory repair, or completion score was reintroduced.

Day-to-day UX correction pass (same candidate): a REMOVE / QUIETEN pass, no semantic change.
The reconciliation prompt was retoned off its amber-alarm styling to a calm neutral surface
with one primary exit ("Looks about right"), "Add broad activity" / "Leave unknown" as equal
secondary options and "Log time" as a demoted link; the acknowledged state collapsed to one
quiet `✓` line. The `#th-unlogged` "Xh Ym unlogged" Today stat was removed (raw gaps stay in
Timeline / Full analysis / Week view — this contract's "current gap totals MUST NOT become
whole-day coverage" rule is better served by not showing a running debt figure at all). The
four hard-coded generic meal/chore check-in prompts (`ROUTINE_PROMPTS`) were removed —
ordinary life is handled by passive evidence and the one bounded Review reconciliation, not
daytime check-ins; the passive Daily-basics quick-log grid and explicit user routines are
untouched. "Close day" copy: "name the leak" → "then prepare tomorrow". Reconciliation
acknowledgment is still review-workflow-only and still not fed to analytics.

Still future (as of 6I/J): whole-day coverage model, combined exact+estimated allocation,
coarse-evidence durability / sync, Life Ledger projection, export/import, Wife/Shared,
Personal Model/Advisor. Gates before Wife/Shared or serious dogfood: (1) coarse-evidence
durability, (2) onboarding rewrite, (3) Focus Wallet / streak pressure decision.

**Implementation status (Coarse Evidence Durability V1, branch
`feat/coarse-evidence-durability-v1`, uncommitted candidate):** implemented — closes gate (1)
above. **DURABILITY GATE SATISFIED.** Coarse life evidence now has an account-scoped durable
remote copy (Firebase Realtime Database, `rooms/<roomCode>/coarseLifeEvidence/<id>` — the same
private per-user room `entries`/`reviews`/`plans` already sync through; no rules change, no new
sharing surface). Local storage (`ta3-coarse-life-evidence-v1`) stays the fast/offline cache and
immediate source of truth; nothing about capture, validation, identity, or the Review UI changed
— this milestone is durability only.

Reused, not reinvented: the identical record-level `updatedAt`-last-write-wins pattern
`storage.js` already runs live for `entries`/`reviews`/`plans` (`resolveEntrySync()`,
`syncEntries()`, `saveReview()`). `resolveCoarseEvidenceSync()` in
`coarse-life-evidence-model.js` is the pure conflict rule; `coarse-life-evidence-sync.js` is the
dependency-injected bridge that subscribes, merges record-by-record (never a collection
replace), and pushes.

Conflict rule (exact, not "conflict-free"): whichever side's `updatedAt` is greater wins —
plain last-write-wins on the record's own client timestamp, the same clock-trust level
`entries`/`reviews` already accept. One override: a local tombstone (`deleted: true`, previously
only meaningful for `entries[]`, now also on coarse records) can never be resurrected by a
merely-newer non-deleted remote value — only an explicit `undoRestoredAt` marker newer than the
tombstone may restore it. This prevents the specific resurrection scenario a remote copy
introduces that 6H's local-only delete never had to consider: a device that goes offline before
a delete and reconnects later with a stale pre-delete copy must not un-delete it. Rekey
(rename/date-move) preserves 6H's exact collision semantics — a tombstoned identity counts as
free — and additionally tombstones the vacated old identity (rather than erasing it) so a
durable remote copy of the old id also converges to "deleted" instead of orphaning.

Bootstrap/migration: on the first remote snapshot after connecting, remote records are merged
into local first, then every locally-known record (tombstones included) is pushed once — this
is what makes an existing pre-durability install's local-only records durable automatically,
with no export, no import, no settings toggle, no user action. Bootstrapping local-present/
remote-empty does not wait for or require an existing remote node, and bootstrapping local-empty/
remote-present needs no manual pull. Neither can drop the other side's unique records (record-
level merge only, verified by dedicated tests, not asserted).

Offline/UX: capture is unaffected (still ~20-30s, still local-first); a push after save/remove is
best-effort and fire-and-forget — a network failure or being signed out never blocks, throws, or
surfaces an error to the capture flow, matching `saveReview()`'s existing failure handling. No
sync-status widget, no "N records waiting to sync" indicator, no "Sync now" action, and no change
to Today/Review/Plan Tomorrow beyond an already-open Review silently refreshing if another device
changes a record while it's open (`refreshCoarseEvidenceListIfMounted()` — a no-op whenever
Review isn't currently open).

Not built, and not required for this gate: Wife/Shared (a future shared feature would need its
own separate state — this durable copy stays in the same private per-user room every other
ChronaSense collection already uses, so durability does not force sharing), export/import
(redundant once real sync exists), Life Ledger projection of coarse evidence, a general
merge/CRDT framework (last-write-wins was sufficient and is the same trust level already accepted
elsewhere in this app).

## Verification and UX limit

Two production-path regression tests in `test.js` cover schedule exclusion through either
existing capture-method location, non-mutation, and preserved timer/retro/quick/manual
capability evidence. The negative test failed before the guard. Existing adapter and
semantic suites exercise unchanged paths; no artificial future-boundary tests are added.

Phase 6G.2 adds: `evidence-interpretation.test.js` (predicate matrix incl. non-entry inputs);
3 new `attention-signals.test.js` cases (passive observation stays neutral, a user-asserted
positive control still creates a break/recovery, a scheduled entry stays neutral) plus a
recovery-label update on the two existing recovery-line assertions, **plus 5 more added in the
targeted independent-review fix pass** (auto-logged PC Time deep stays neutral, quick-logged
Screen Time deep stays neutral, PC Time does not extend an adjacent real focus stretch, PC Time
alone after a real break does not manufacture a recovery, a positive-control non-auto-logged
deep entry still counts) — 34 cases total; 5 new `focus-wallet.js`
gating tests in `test.js` (passive deep, passive waste, scheduled deep, PC-Time deep all score
0; positive control still scores); `tests/analytics-truth.spec.js` — 5 Playwright cases in the
first pass (Today-pulse overlap no longer exceeds 100%, Review close-out is confirmed-only,
Wallet abstains on unconfirmed entries, the weekly summary uses the corrected wording, and the
retired "Recovered from drift" string is gone from the served page), **plus 8 more added in the
targeted independent-review fix pass** — 13 total: 6 asserting the actual rendered Today
`#s-deep`/`#s-streak` DOM text across scheduled/browser-passive/phone-passive/PC-Time/genuine-
confirmed/mixed evidence, and 2 on `buildWeekShareSummary()`.

No new screens, prompts, fields, settings, badges, scores, coverage, daily steps, Today/Review
redesign, Focus fix, or user-facing workflow step. Existing capability counts/recommendations
may change when they previously relied on a recognizable schedule assumption (Phase 6G.1); this
milestone's percentages, split-bar segments, Wallet balance, and "clean"/"peak hour" copy may
also change when they previously relied on a passive observation, a schedule assumption, or PC
Time context — this is the intended bounded semantic correction, not a claim of byte-identical
analytics output.
