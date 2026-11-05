# TASK-039 complete source writer inventory

Base: `021d1eecb963d75fabd09735095e54c1fa6ff4b7`. Scope: tracked first-party app, extension,
native/worker/bridge and Functions source; generated `www/` mirrors; archived HTML; local proof/test
writers. No production writer availability or live queued-write inventory was accessed.

**Full integration: BLOCKED. Unexamined source writer families: zero.** Classification means code was
examined; it does not assert every listed handler has a passing interruption matrix. Runtime app,
Undo, Focus, canonical rules and gateway are frozen at the base. The browser adapter remains unwired.

## Physical sinks

| Source / sink | Compatibility with acknowledgement lifecycle | Required boundary / disposition |
| --- | --- | --- |
| storage.js `syncEntries` | Legacy room PATCH of all logical entries to `entries/e_<id>`; held paths defer only the pending Undo's named paths. Can create a second physical alias. | Unprotected in app. Must preserve physical before-images, alias conflicts, atomic per-command intent and acknowledgement. |
| storage.js `syncTimerState` | Ordinary room PATCH; restored timer uses child transaction and saved restore stamp. Restore guard protects that case; ordinary command and entries remain separate. | Unprotected general command boundary. Preserve the existing restore/device guards. |
| storage.js `syncFocusRedemptions` | Separate `r_<id>` room PATCH with held-path deferral. | Adjacent causal store must join a command that changes its entry/cursor. No change in this checkpoint. |
| index.html `clearAll`, `clearTodayOnly` | Direct room updates of `e_<id>` tombstones, bypassing syncEntries. | Unprotected physical alias and durable command boundary. |
| index.html `clearSelectedDay` | Direct individual child SETs of `e_<id>` tombstones. | Unprotected multi-record completion and physical alias boundary. |
| time-ack.js `createRestTransport().patch`; index `requestAcknowledgedUndo` | Durable original Undo identity, shared preparing barrier and atomic PATCH. Proposal/applier still name `e_` entries; cancellation path is a local proof. | Original Undo is preserved, but cannot safely resolve numeric/contradictory aliases through app projection. Keep integration held. |
| extension `logSession` -> pending-writes.js conditional PUT | New full captured facts and conditional commands retained before producer cache advances; immutable retries, account partition and readback. | PASS for bounded tested local capability. Default transport cannot prove alias fencing and sends no writes; retains UNKNOWN. Not a releasable extension. |
| extension multi-alias case | Existing aliases with identical domain content retain their individual keys/revisions. | Queue needs explicit pinned atomic transport; default has none and retains UNKNOWN. Local prevention proves atomic update. No sequential partial fallback. |
| Functions `createCompletionDomain().cas` | Privileged whole-room If-Match PUT; `assertCompletionLens` canonical-compares every non-completion sibling, including entries/timer. | Accounting preserving and conditional; compatible as-is. Gateway frozen. Reads are not new accounting authority. |
| Archived `ai_studio_code (1) copy.html`, `ai_studio_code (1) - Copy.html` | Legacy unconditional entry/timer writers; first archive also has collection remove / null writes. | Incompatible. Not in active runtime closure. Existing open/queued old generations cannot be ruled out locally. Release must address their availability. |
| www/ | Generated copy of active runtime; 99-file closure verified byte-identical. | Same status as source, no independent implementation. |
| accounting-hazards/, unknown-recovery-proof/, time-ack-proof/, review-artifacts/, tests and device-acceptance harnesses | Explicit local synthetic proof/test transports, not loaded in app. | Local only. Historical extension counterexample now pinned to exact baseline function; it is not a test of the new producer. |

## Logical producers and triggers

Every family below reaches one of the physical sinks above or changes its causal local cursor/store.
An existing `timeAckBlocks` check is a barrier check, not proof that an earlier write completed.

| Source / functions | Current compatibility / remaining hazard |
| --- | --- |
| index `_doQuickSave`, `stopAndLog`, `switchTaskMidBlock` | Local adapter demonstrates account-locked atomic publication. Original body still mutates live local cursor/Undo before ACK; interrupted draft recovery cannot meet the new unchanged-cursor contract. Unwired. |
| index `autoLogBlock`, `handleRecovery`, `endBreak`, `autoLogDueTemplates` / `applyAutoTemplateEntries`, `doPing` | Local adapter freezes automatic events for the tested crash recovery, scheduled, break and PC-Time paths. Current affected run: 27/28 passed; Bob scheduled-event record was absent after resume once, then five isolated repeats passed. Cause/event durability in that failed run remains unproven. All original interval endpoints/calculations preserved; no app-level safety claim. |
| index `toggleTimer`, `_startTimer`, `resetTimer`, `startBreak`, `startSprint`, `takeOverActiveTimer` | Ordinary timer creation/stop/ownership and async starts mutate local state outside the journal; need staged causal command. Existing owner/device guards remain. |
| index `switchToTask` and callers `fillSwitch`, `confirmSwitch`, normal start/continue/template start helpers | Logs prior span and starts/relabels another timer via separate writes/local mutation. Must join one acknowledged command. No local wrapper claims this complete. |
| index `handleDeepLink(start)` | Direct task/cursor change and publication without acknowledgement barrier/owner proof at that entry point. Confirmed uncovered path. Native link forwarding has no independent accounting writer. |
| index `saveRetroEntry`, `saveEntry` | Single or multiple records (including midnight splits/merge edits), persist and sync; some UI choices delayed. Need one physical-key-aware intent, with preserved original timestamps and Undo. |
| index `deleteEntry`, `persistEntryDeleteAfterPaint`, edit aliases | Local tombstone/Undo first, later RAF/setTimeout persistence; commands already scheduled can cross preparation. Needs durable capture at invocation and acknowledged delayed completion. |
| index `quickRetroLog`, `quickLogSameAsLast`, `logCommonActivity`, `logSleepEntry` | Ordinary automatic/manual records, sometimes midnight splits. Existing deliberate guards do not create an acknowledgement boundary. |
| index `toggleAway`, `startAway` | Entry, timer and awayState are separate. startAway can create an unsynced prior-work entry and publish new cursor, without the shared barrier. Needs a causal multi-store command. |
| index `syncPhoneUsage` | Awaits native usage, mutates entries, syncs, then advances PHONE_USAGE_KEY without ACK. Need a retained native result and owned continuation; never re-query/recalculate original interval on retry. |
| index `applyActivityCleanup`, `repairDataDoctorMetadata`, `repairDataDoctorDuplicates`, `repairDataDoctorFlaggedEntries` | Maintenance edits/removals and source normalization. Metadata repair lacks barrier; duplicate cleanup can discard same-ID local array members. Needs conflict-preserving physical identity before any cleanup. |
| focus-mode `logFocusSession`, `saveActiveFocusSession`, `endWorkSession`, `restoreFocusSession`, `enterFocusMode`, `confirmExitFocus` | Entry logging, local Focus state, shared timer and heartbeat transitions span separate persistence/publication. Must stage and acknowledge together where causal. Frozen. |
| focus-mode `syncFocusTimerState`, `refreshFocusTimerSync`, `startPomodoro`, `endPomodoroBreak`, `skipBreak`, `finishLearningPlanFocusSession`, `takeOverSyncedFocusTimer` | Timer-only and automatic phase writers use syncTimerState with existing guards; not enrolled in command journal. Frozen. |
| focus-wallet; storage/index historical redemption hydration, listeners and Undo | focus-wallet computes balances; no active redemption creator was found in current source. Historical redemptions hydrate/merge locally and can be Undo-tombstoned through syncFocusRedemptions. Preserve their causal linkage and reconciliation guards; no independent direct entry sink in focus-wallet. |
| storage `startSync` bootstrap/device receipts, reconnect callbacks, `forceSyncNow`, `reconcileRemoteActiveState`, `syncLocalActiveTimerState` | Bootstrap/replay/restore can republish stale local state. Per-command receipt and original physical before-image must survive reconnect before release of deferred writes. Existing timer restore transaction is narrower. |
| storage entry/timer listeners (`resolveEntrySync`, `applyRemoteTimerState`), account hydration / persist | Reconciliation/local projection, not independent remote mutation; listeners can replace local draft while it is awaiting ACK. Need protected draft plus durable once-only post-ACK local application. No alias projection integration yet. |
| index `undoLastAction`, `applyAcknowledgedUndo`, `timeAckFlushDeferred`, retry/recover/connection hooks | Signed-in Undo is acknowledged; offline signed-out Undo is local. After settling, deferred sync funnels can publish broader stale state. Applier/held paths still assume `e_`; do not enable physical resolver or Keep-server path piecemeal. |
| storage `syncAwayState`, `syncBreakState`; heartbeat/local Focus stores | Auxiliary causal state, not separate entry sinks. Required in interrupted Away/Focus/Break command boundaries so a cursor cannot move independently of its logged span. |
| extension startup, periodic alarm, idle/lock, tab activation/update, window focus, sign-in/out | All producer transitions serialized, capture receipts recover old cache windows. Untyped-owner legacy sessions quarantined UNKNOWN, both-account outboxes separate. Failed storage pauses tracking with original state retained. Full browser MV3 shutdown/upgrade matrix not established by Node worker tests. |

## Examined exclusions and completeness method

The source audit searched tracked JS/HTML/MJS/TS for syncEntries/syncTimerState callers, direct
entry paths/child references, entry array mutation, SDK update/set/transaction/remove and REST
PUT/PATCH/whole-room writers, then traced their callers. Independent review separately checks the
sink and producer classification. Stable function anchors above identify the inspected paths.

coarse-life-evidence-sync references syncEntries in comments but writes its own coarse store only.
Life Ledger, Obsidian/outbox workers, source adapters, Capability/Career, learning/planning/task
completion, settings/templates/reviews/devices/intention/public/partner stores do not independently
write entries/timer; their dispatches into the timer use the listed entry points. Functions
user-scoped RTDB and entry read-queries are read-only for accounting. HUD/bridge projects state;
sw.js delivers notifications/audio; native usage queries return data to syncPhoneUsage. None is a
hidden acknowledgement-compatible accounting sink. Generated/vendor code and local harnesses are
classified separately above. No live client inventory is implied.

## Exact STOP boundary

The remaining work is materially broader than replacing physical key names: original handlers
mutate live timer/entries/Undo and effects in several stores before asynchronous acknowledgement.
Wrapping syncEntries cannot undo those effects safely after interruption or listener replacement.
The required contract is staged original effects plus a durable once-only local apply after server
ACK, including async native results, delayed deletes, Away/Focus stores, bootstrap replay and direct
bulk tombstones. A draft-preview UI would be a different owner-approved contract; none is assumed.
No formula redesign/new backend was shown necessary. Implementation stops before this broader
transition change, rule activation or adapter wiring. All unprotected families remain explicit.
