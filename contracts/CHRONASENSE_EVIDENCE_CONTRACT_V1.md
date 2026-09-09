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

Duration-without-placement is a semantic contract for a later milestone. No storage for
coarse estimates is added. Do not use fallback timestamps, a schedule, a default duration,
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

## Verification and UX limit

Two production-path regression tests in `test.js` cover schedule exclusion through either
existing capture-method location, non-mutation, and preserved timer/retro/quick/manual
capability evidence. The negative test failed before the guard. Existing adapter and
semantic suites exercise unchanged paths; no artificial future-boundary tests are added.

No new screens, prompts, fields, settings, labels, badges, scores, coverage, daily steps,
Today/Review redesign or Focus fix. Existing capability counts/recommendations may change
when they previously relied on a recognizable schedule assumption; this is the intended
bounded semantic correction, not a claim of byte-identical analytics output.
