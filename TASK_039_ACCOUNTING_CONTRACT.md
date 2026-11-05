# TASK-039 — final accounting integration contract and release strategy

Date: October 29, 2026 (America/Phoenix).
Design base: `d50a44f1b2d4b14de99efac76f3ac3793cb0c4a5`.
Local branch: `task-039-accounting-contract`, existing worktree
`.worktrees/task-039-unknown-resolution`.
Source inventory: [complete WRITER_COMPATIBILITY.md](accounting-hazards/WRITER_COMPATIBILITY.md).
The inventory's source base is 021d1ee; its examined physical candidate is 40e4ade, recorded by d50a44f.
This document covers EVERY inventory family, including exclusions. It does not assert a live client census.

**Release strategy: A — complete one coherent staged-command accounting integration, then assess release.
No reduced accounting release is demonstrated safe. Implementation is NOT authorized by this document.**
The design/investigation is ready for review; application integration remains BLOCKED.
Guardian **NOT RUN / NOT PASSED**. Production **NO-GO**.

## 1. Authority, assumptions and STOP

The owner's current message authorizes local investigation and design only. Earlier blocked tasks are
context, not renewed implementation permission. PR #20, gateway branches, production rules/builder,
runtime sources and generated mirrors are preserved. No push, merge, deployment, live-account access,
phone testing or unrelated development is part of this work.

Design assumptions: preserve existing time formulas, IDs, timestamps, classification, manual-over-automatic
precedence, Undo meaning, timer owner/device guards and UI semantics. Keep vanilla JS/classic-script
architecture. Use deterministic code for identity, routing, retries and reduction; no model decisions.
No new backend or gateway write authority is proposed. No optimistic draft-preview UI is assumed.
Account-bound pending status and actionable errors must be truthful within existing status surfaces.

This is a PROPOSED contract, not a canonical architecture decision. Root DECISIONS and docs remain
unchanged. A need to change formulas, introduce a backend, silently migrate contradictions, expand
authority or redesign UI is a STOP for the future implementer.

## 2. Scheduled-event investigation

### Observed evidence

Original evidence: accounting-hazards/physical-browser.log and PHYSICAL_RESULTS.json report 27/28,
with Bob's scheduled record absent after resume. The subsequent five isolated passes contain no
durable-state evidence for that failure. Its reported trace is no longer present in the local test
output. Consequently the exact historical interleaving and retention in THAT run cannot be proved.

The new diagnostic generator copies the checkpoint's original browser test without weakening its
assertions, adds snapshots of entries/cursor, the event outbox and journal, and records local REST
requests/responses. Runtime, adapter, journal and original test sources are unchanged.
All network destinations except loopback/local SDK asset fulfillment are blocked.

Evidence: [observed-failure.json](accounting-hazards/scope-decision/observed-failure.json).
Ten instrumented scheduled tests (five per account) produced **9 pass / 1 fail**, reproducing the
same absent-record assertion for Alice. No page error occurred. This defeats an account-specific or
“five passes cleared it” explanation.

In the captured failure:
- The original event contains Scheduled work, 07:00–08:00 Phoenix, 14:00–15:00Z, 60 minutes and
  `tpllog_scheduled-proof_2026-10-28`, despite the later 06:00 / Edited later template.
- Immediately after keepServerVersion resolves, an event command is already in phase ready.
  Automatic replay began before explicit resume, while the test still had its PATCH-abort route.
- The PATCH is attempted once, never acknowledged, and the command becomes UNKNOWN.
- After route removal and awaited resumeEvents, both the complete frozen event and immutable command
  remain in localStorage; no accepted history receipt exists. The scheduled server record is absent.

### Mechanism established, historical attribution bounded

The app calls autoLogDueTemplates from renderToday and autoLogHeartbeatTick. Clearing the Undo
barrier allows those automatic calls to start the queued occurrence before the test removes its
abort route. invokeOne then sends the immutable journal command. Aborting that request leaves UNKNOWN.
command-journal.recover only observes pending/unknown/intent commands; when the server still has the
before-image, it leaves UNKNOWN and DOES NOT retry. resumeEvents sees the pending journal and stops.
Awaiting resumeEvents therefore promises neither a successful send nor a drained event outbox.

The controlled tests force the existing heartbeat path into precisely this window, for Alice AND Bob:
1. Capture the scheduled occurrence behind UNKNOWN Undo, then edit its template.
2. Confirm permanent Undo cancellation while keeping PATCH aborts installed.
3. Call the existing autoLogHeartbeatTick and wait for the event command to reach UNKNOWN.
4. Remove the route and await resumeEvents. Assert server absence AND exact retained command/event.
5. Reload, reinstall the unchanged local adapter and resume. Assert the same command/event still exist.
6. From the TEST harness, deliver the original captured PATCH bytes under the owner token.
   Resume observes acceptance; exactly one original 60-minute record exists and the event retires.

Both tests pass, including a second evidence-saving run. Durable snapshots:
[evidence-controlled-0-alice.json](accounting-hazards/scope-decision/evidence-controlled-0-alice.json) and
[evidence-controlled-0-bob.json](accounting-hazards/scope-decision/evidence-controlled-0-bob.json).

**Finding:** a replay/abort ordering race plus observe-only UNKNOWN recovery explains the reproduced
failure. This is an adapter liveness/contract defect, not evidence that it lost the captured fact in
the new runs. The original Bob run has the same symptom but lacks the necessary historical snapshots:
its exact cause and durability remain an **unresolved historical data-safety risk**, not closed.

No retry fix or assertion change is made here. A future fix must prove exact retry, visible retained
UNKNOWN and completion under controlled interleavings; adding a sleep or accepting repeated passes
is insufficient. The new tests deliberately prove the current defect and recoverability, not safety
of the current app. The local adapter is still not loaded by index.html.

## 3. One staged-command contract

### C1 — ownership, coordination and durability

Use one account-scoped accounting coordinator shared by ordinary commands, Undo, automatic events and
recovery. A Web Lock covers each same-origin account transition, including a receipt recheck INSIDE
the lock; cross-device/extension concurrency is resolved by server preconditions, not the Web Lock.
Fail closed if the required durable storage/coordination capability is unavailable.

Before the FIRST authoritative read or asynchronous handoff, persist and read back a reservation with
version, UID, room, device, attachment generation, session/source identity, stable operation/event ID
and captured invocation input. Reservation ownership is rechecked after every await. Account changes
retain old-account work in its original partition and prevent its effects reaching a new account.
Device/attachment generation is local fencing metadata, never authentication.

Use an account-scoped, single-write local accounting envelope containing the committed accounting
projection, pending operations/events and local apply receipts. This can remain localStorage + Web
Locks: a single replace/readback is the commit point. Existing per-key caches become reconstructible
compatibility caches, never competing authority. Do not attempt a multi-key “atomic” commit through
several setItem calls. The envelope must preserve the full entry/auxiliary fields it owns; unrelated
settings/reviews/plans remain in their existing stores.

This is the minimum proposed persistence change required by unchanged-cursor/Undo semantics.
No IndexedDB migration is required by the design. Quota, corrupt/unknown versions, unavailable storage
or failed readback stop capture/send/apply; keep the original durable envelope, pause the affected
producer and report the reason. Readback proves the tested browser-storage boundary, not survival of
arbitrary disk failure. Account size/quota and actual runtime support are implementation gates.

### C2 — observations versus sealed commands

Two explicit records, under the SAME lifecycle, prevent recapture:
- A captured observation retains complete original automatic/native fact, occurrence identity, source
  generation, original timestamps/classification and dependency. It can wait behind an unresolved
  command without changing live entries, cursor, Undo or auxiliary state.
- A sealed command contains the complete immutable physical before-images, exact changed records,
  remote patch, proposed local effects and expected committed local generation. Seal once and read
  back before send; retries reuse the same ID, paths, bytes and timestamps.

Ordinary user commands reserve, capture, inspect the authoritative base and compute their complete
effects on detached copies. They must never run the existing mutating handler on live globals and
try to undo its effects later. Confirmation choices finish before sealing; no network command may
depend on a later UI answer. Deliberate conflicting actions wait while a predecessor is unresolved.

Automatic facts can arrive meanwhile: freeze them at the producer boundary, not at eventual retry.
Scheduled identity is template + occurrence date/range; ping/Break/Focus/recovery identity includes the
owned session and original due/phase endpoint. Do not coalesce all events merely by function name:
distinct occurrences must survive, repeated delivery of ONE occurrence must deduplicate.
Phone capture includes the original query window, owned continuation and returned native events.

An observation may be sealed after its causal predecessor settles, using only its frozen facts and
a proven parent outcome. Use the unchanged domain reducer once on isolated state; no new “now,”
template lookup, reclassification or source ID on retry. A source revision change is not permission
to rebase. If the original effect cannot be applied without overwriting a later manual edit,
tombstone or ownership change, retain a visible conflict/UNKNOWN for explicit resolution.
Do not silently truncate it or treat “skipped” as acknowledged.

Cursor-dependent events must carry their parent command/covered interval and enqueue order.
A newer Save cannot pass an earlier automatic event. Do not recalculate from a stale live cursor
and create overlapping new records. Existing merged extensions retain their proven identity/basis.
Crash recovery preserves the actual newly observed 10–12 minute fact if an earlier 0–10 Undo wins;
it must not reintroduce the undone 0–10 minutes or discard the recovered 2 minutes.
Conflicting/ambiguous dependencies remain retained instead of speculative automatic completion.

### C3 — physical identity and preconditions

Inspect raw physical entries, including tombstones; keep typed logical IDs distinct from raw keys.
Reuse EntryPhysicalKeys.resolve/project/prepare/unchanged and Firebase wire comparison, with these
required outcomes:
- One existing numeric or e_ key: update THAT key, never manufacture its counterpart.
- Identical existing aliases: one logical projection, retaining ALL original physical before-images;
  change aliases atomically with one operation ID and each source's own next revision.
- Absent typed identity: bind one chosen new key under enforced counterpart-exclusion rules.
- Contradictory aliases, live/tombstone contradictions, type collisions, malformed/unrecognized
  metadata, noncanonical keys or occupied physical keys: keep all originals and full intent UNKNOWN.
  No automatic migration, repair, winner selection or physical source deletion.
- A tombstone restores only through the explicit original Undo/restoration authorization and valid
  newer undoRestoredAt semantics. A new Add or cleanup cannot gain that authority by coincidence.

Each changed path has an exact authoritative before-image, base existence/revision and a next
_csWrite stamp; record-level revisions must be safe integers. Timer, focusRedemptions, awayState and
breakState need equivalent enforced revision/cancellation gates when used by causal commands.
Rules retain owner isolation, Action-API claim denial and existing tombstone/source protection.
A stamp is not authorization. No new collection/room parent grant may bypass child checks.
No unconditional room PUT or sequential alias-write fallback.

A timer-only command must also precondition any active Away/Break source it relies on: include that
source in the atomic command (with unchanged domain content and an advanced metadata revision).
A fact/logging command that depends on the timer similarly includes its guard-only timer revision.
This prevents a stale source read from authorizing a fresh revision on an unrelated target.
Truly independent retro entries need no irrelevant timer write.
Conflicting commands share their causal guard record; disjoint factual retro operations may proceed.

The transport performs ONE user-token-authenticated atomic multi-path PATCH for each causal
command. Single-record extension commands may retain their existing conditional If-Match PUT.
Precondition failure rejects the entire command. Rules must reject stale/unstamped old writers
and alias races; app-side agreement reads alone cannot close an already-submitted-write race.
Unrecognized old command metadata remains quarantined until an explicit compatible policy exists.

### C4 — acknowledgement, retries and cancellation

States: reserved/captured -> sealed -> pending -> accepted -> local-applied -> retired.
Branch states: refused (known never committed), conflict, UNKNOWN, or cancelling -> fenced/reconciled.
Persist pending BEFORE handing bytes to the transport. An interrupted “sealed” send boundary is
potentially submitted unless its transport can prove otherwise.

Acceptance requires an authenticated exact successful response for the entire patch, or a coherent
authoritative read of ALL exact post-images. A partial echo, optimistic SDK event, any ONE matching
stamp, empty queue, callback return or presence of a marker is insufficient. Immutable operation
identity may explain later revisions, but missing evidence stays UNKNOWN. No new backend receipt
service is required; if all evidence was overwritten, fence and reconcile or retain UNKNOWN.

Retry only the original sealed request. After lost response, inspect acceptance first. If every
original base is still authoritative and installed gates are proven, retry the same bytes under
those gates; a request still in flight can only win once against that base. A 412/permission failure
after an earlier unknown attempt does not prove the earlier attempt never committed.
Credential refresh never changes command identity or payload. No automatic counter/timestamp rebase.

Expose/checkpoint progress so resume/drain returns a structured outcome (drained, retained UNKNOWN,
conflict, detached, storage failure), not a completion-looking void. Resume, online, visibility,
startup and relevant listener notifications may deterministically schedule observation/exact retry.
Coalesce concurrent drain calls, but do not drop a trigger arriving during a drain. Retained work
must remain discoverable and actionable; avoid unbounded busy retry or silent background waiting.

Reuse the permanent original-operation cancellation primitive: record resolution intent, create-only
owner marker, authoritative readback under proven deny rules, coherent account reconciliation.
Every protected sink, including auxiliary states, must refuse a cancelled operation ID forever.
A request commits wholly before the fence or is refused wholly afterward. No expiry/ID recycling.
No elapsed time, abort(), quiet period or marker presence proves cancellation capability.
Cancellation/reconciliation must retain captured observations, local-only facts and unresolved effects.
It cannot release a barrier by dropping them. Aliased raw records are reconciled without flattening
away contradictions. If clean reconciliation cannot be proved, remain blocked.

### C5 — once-only local application

Before ACK, the committed entries, accounting cursor, one-slot Undo, Focus/Away/Break state, native
watermark and accounting heartbeat transitions stay at their prior committed generation. Timer
display can continue deriving elapsed time from committed anchors; that grants no write authority.

After acceptance, persist the new committed projection AND an operation apply receipt in ONE envelope
replace/readback before updating live globals or compatibility caches. Undo is created/replaced/
consumed exactly at that commit, never at capture/send. Source before/after guard makes local apply
idempotent. A crash after this commit rehydrates the same generation; it cannot apply twice.
A newer authoritative generation must not be overwritten by a late ACK. Retain receipt and reconcile
the accepted delta against that generation; never replay the old whole-array frame.

Listeners update the confirmed read model but cannot mutate/remove a pending immutable draft.
Hydration must reconcile the envelope before restore, rendering and bootstrap publication; preserve
the existing restore-before-render ordering and first undeferred heartbeat detection.
Schedule heartbeat start/stop, ticker/notification and modal effects after the local commit as
idempotent projections of the committed state. A crash between commit and these side effects is
repaired at boot. _stopHeartbeat remains on every clean resetTimer/stopAndLog/confirmExitFocus exit;
do not remove device or restore/takeover guards.

Legacy per-key cache repair occurs after the canonical envelope commit and is repeatable. Failure
cannot falsely acknowledge an unapplied generation. A callback that resumes after detach rechecks
owner/generation and cannot modify another account's cache/DOM/state.
Unbound legacy data is retained separately, never assigned to the currently signed-in account.

## 4. Complete writer mapping and reuse

This table is the implementation boundary, not an authorization to edit these files now.
“Stage” means capture -> detached reduction -> enforced atomic publication -> durable local apply,
including all C1–C5 requirements.

| Inventory family / exact anchors | Required integration or disposition |
| --- | --- |
| storage.js syncEntries, syncTimerState, syncFocusRedemptions | Replace collection publication/republication with sealed command submission. Preserve buildTimerPublication and restored timer guards; route physical keys through the resolver. No fallback SDK queue of derived whole arrays. |
| index clearAll, clearTodayOnly, clearSelectedDay | Capture explicitly selected physical sources and tombstones once; stage each all-or-nothing bounded batch. Selection cannot expand after ACK/reload. No direct e_ SET/PATCH. Oversize work stays retained and requires an explicitly approved batch boundary; never partial success disguised as one clear. |
| time-ack.js REST patch; requestAcknowledgedUndo, undoLastAction, applyAcknowledgedUndo | Enroll Undo in the same coordinator/physical resolver/local apply envelope; preserve copied arithmetic, revision-aware cursor receipt and one-slot semantics. Keep signed-out work explicitly local/account-unbound; no later automatic attribution. |
| _doQuickSave, stopAndLog, switchTaskMidBlock | Reuse time calculations and cursor receipt logic as reducers over isolated state; stage entry extension, cursor, heartbeat and Undo together. Never mutate live state before ACK. |
| toggleTimer, _startTimer, resetTimer, startBreak, startSprint, takeOverActiveTimer | Stage owned timer creation/stop/takeover and any causal Break state. Capture async precommit choices and recheck ownership after awaits. |
| switchToTask, fillSwitch, confirmSwitch; start/continue/template/plan helpers; handleDeepLink(start) | One command for prior span and new task/cursor. Route all callers into that command; native deep-link delivery provides no independent permission or owner proof. |
| saveRetroEntry, saveEntry | Freeze edits/midnight splits/merged IDs and Undo; resolve every physical member, then publish/apply atomically. Existing _mergedIds and shallow display copies remain. |
| deleteEntry, persistEntryDeleteAfterPaint and edit aliases | Reserve/capture exact tombstones at invocation before RAF/setTimeout. Delayed callback carries only command ID/owner generation; it cannot re-read “current” selection or persist an old mutable array. Consume Undo after ACK. |
| quickRetroLog, quickLogSameAsLast, logCommonActivity, logSleepEntry | Same staged records including existing split semantics. Keep original times/IDs and deliberate source checks. |
| autoLogBlock, handleRecovery, endBreak, doPing | Freeze original factual span/phase event, owner and parent. Stage entries/cursor/Break/heartbeat effects together. Keep doPing device guard and accidental-expired recovery behavior. |
| autoLogDueTemplates, applyAutoTemplateEntries; renderToday and autoLogHeartbeatTick triggers | Reuse captureOnly calculation, but isolate its non-entry helper side effects. Per-occurrence durable deduplication; never re-read an edited template to retry. Replace live publication tail with staged effects. Close the replay defect in section 2 with controlled regressions. |
| toggleAway, startAway | One entry + timer + awayState command, including prior unsynced span and local owner/store effects. No cursor publication without its log. |
| syncPhoneUsage, native init/permission callbacks | Persist owned request/window before await; persist native result before processing; freeze returned sessions and skip evidence, and stage records plus PHONE_USAGE_KEY advancement. Make watermark account-scoped. Legacy unscoped watermark is unproven, not blindly adopted. Query failure/empty result must be distinguishable; cursor cannot hide an unprocessed range. |
| applyActivityCleanup; repairDataDoctorMetadata, repairDataDoctorDuplicates, repairDataDoctorFlaggedEntries | Stage exact changes; preserve unknown fields/raw aliases. No duplicate cleanup may discard contradictory same-ID records. Existing unsafe repair refuses rather than “fixing” a conflict. Classification choices remain explicit. |
| focus-mode logFocusSession, saveActiveFocusSession, endWorkSession, restoreFocusSession, enterFocusMode, confirmExitFocus | Stage entry, Focus checkpoint/phase, shared timer, Undo/causal auxiliary state and heartbeat effects. Restore reads pending journal before publishing. Existing Focus owner/reconciliation behavior remains. |
| syncFocusTimerState, refreshFocusTimerSync, startPomodoro, endPomodoroBreak, skipBreak, finishLearningPlanFocusSession, takeOverSyncedFocusTimer | Route timer-only and automatic phases through the same command boundary. Preserve original phase endpoints and causal completion hooks; no completion/Learning side effect before accounting acceptance. Audit learning-plan-ui and daily-routines-ui callbacks for success-result propagation, not new semantics. |
| syncAwayState, syncBreakState; local heartbeat and Focus stores | Add revision/cancellation gates and join causal commands. Local heartbeat/focus cache actions project committed envelope, not a second source of truth. |
| startSync, bootstrap/device receipts, reconnect, forceSyncNow, reconcileRemoteActiveState, syncLocalActiveTimerState | Recover/inspect original pending commands before enabling producers; never flush stale local arrays or advance unrelated device receipts as proof of accounting. Non-accounting device metadata keeps its current meaning. |
| resolveEntrySync, applyRemoteTimerState, hydration/persist; timeAckFlushDeferred, retry/recover/connection hooks | Raw physical read model plus conflict preservation; separate confirmed state from pending effects. Remove accounting use of blanket deferred flags/collection replay; drain journal by exact operation identity. Preserve narrower restore transaction until migrated equivalence is proven. |
| focus-wallet; historical redemption hydration/listeners/Undo | Reuse pure scoring unchanged; no active redemption creator was found. Preserve and stage historical redemption tombstones/restores with their entry/cursor; do not invent a new creator. |
| extension logSession -> pending-writes; multi-alias transport | Reuse enqueue-before-producer-cache advancement, captured producer receipts, known bases, immutable retry, ETag PUT, account partition and key resolver. Provide verified strict-rule capability and atomic multi-alias transport. Do not enable current default sends on marker presence. Keep unbound legacy sessions UNKNOWN. |
| extension startup/install/update, periodic alarm, idle/lock, tab/window activity, auth transitions | Preserve original session/merge arithmetic; prove actual MV3 process stop/upgrade and offline capture recovery. Capture frontier may advance ONLY after full fact readback; it is separate from acknowledged remote projection and never deletes pending work. Missing storage pauses tracking. |
| Functions createCompletionDomain.cas / assertCompletionLens | Reuse unchanged: room ETag CAS preserves EVERY non-completion sibling. Prove added metadata/envelope-facing reads do not weaken the lens. No gateway/Functions implementation anticipated. |
| Archived ai_studio HTML copies; available old SDK/extension writers | No new functionality/migration inside archives. Exclude from packaging; old open/installed/queued writers require the coordinated cutover gate below. Their incompatible writes must be denied without declaring their unretained local facts safely migrated. |
| www/ | Generate from final runtime closure only, with parity/version gate. No independent edits. |
| accounting-hazards, unknown-recovery-proof, time-ack-proof, review-artifacts/tests/device harnesses | Local proofs, not runtime authority. Preserve historical counterexamples; add separate prevention regressions, never relabel a counterexample PASS as application safety. |
| Coarse evidence, Life Ledger/Obsidian, Capability/Career, learning/planning/task-completion, settings/templates/reviews/devices/public/partner/intention stores, HUD/bridge/sw/native forwards | No independent entry/timer sink found. Keep their own contracts. Verify any calls into the above writers await/propagate accepted results; read-only HUD and notification delivery remain projections. No unrelated rewrites. |

Existing primitives reduce implementation work but NONE supplies the whole contract:
TimeAckCore supplies wire equality/stamps/locks/authenticated transport and durable original Undo;
EntryPhysicalKeys supplies conservative physical identity; pending-writes supplies captured extension
facts; unknown-recovery-proof supplies permanent fence/readback; buildTimerPublication and existing
time helpers supply preserved calculations. command-journal is only a prototype: it mutates live
state, checkpoints incomplete drafts, permits any-one-stamp recovery and lacks the required local
atomic apply. browser-adapter is test-only and must not be promoted as an all-writer wrapper.

## 5. Dependency order and prevention of partial deployment

1. **Contract review and regression boundary.** Accept this exact C1–C5 scope, confirm writer mapping,
   resolve owner policy for legacy/unbound conflicts, retain historical Bob uncertainty and add its
   controlled prevention cases. No activation.
2. **Coordinator/local envelope.** Build durable capture/seal/apply/receipt state machine and boot
   recovery first. Kill-point tests must pass before migrating handlers.
3. **Physical authority + LOCAL server gates.** Integrate resolver for app/Undo, exact causal guards,
   auxiliary revision/cancellation predicates and atomic transport. Mutation tests prove each predicate
   is necessary and old parent grants cannot bypass it. Test capability is pinned to the rules artifact.
4. **Storage/Undo boot and replay boundary.** Enroll listeners, hydrate, bootstrap, deferred writes,
   cancellation/reconciliation and signed-out quarantine. No surviving legacy accounting sync fallback.
5. **Deliberate producers.** Save/Stop/Switch/start/deep-link/retro/edit/delete/clear and maintenance;
   migrate callers and delayed callbacks. Prove unchanged cursor/Undo before ACK.
6. **Automatic/multistore producers.** Recovery/templates/PC-Time/pings, native usage/watermark,
   Away/Break and Focus transitions. Prove original observations across waits and dependent ordering.
7. **Extension and all-writer integration.** Supply strict capability + multi-alias path; exercise real
   MV3 lifetime and mixed app/extension clients. Complete fresh source inventory and package closure.
8. **Candidate qualification.** Exact-source independent review, full integration suite and Guardian.
   Produce a cutover/rollback manifest; stop for the owner's SEPARATE release authorization.
9. **Future coordinated cutover ONLY if separately authorized and evidenced.** Quiesce existing writers,
   snapshot/export all provable pending/local facts, upgrade/verify writers, install gates while
   accounting remains quiesced, verify mixed-generation rejection, then activate the compatible set.
   These are dependency requirements, not permission to do them in this session.

Steps 2–7 remain local and disabled as a release unit until all pass. Subcommits are reviewable;
they are not deployable slices. Do not turn on strict gates against old clients and call a denied
write harmless. Old handlers may already have advanced local cursors or lack an outbox.

The cutover manifest must pair exact web/service-worker/Capacitor/extension artifact generations,
rule hash, storage/command version and tested capability. A database marker alone is forgeable/stale
evidence; verify the installed rules through trusted release tooling plus synthetic allow/deny
checks. Old SDK queues can arrive after new code loads; close tabs and force-refresh alone are
insufficient. Server predicates must reject stale bytes, and their local pending facts must already
be retained/recovered. No dual-write or permissive rollback interval.

A source census is not an installed-client census. Without live evidence that relevant devices,
open generations and queues are quiesced/upgraded or their facts preserved, the cutover gate FAILS
and production stays NO-GO. This cannot be settled by this authorized local-only investigation.
Older clients with never-retained facts cannot be made safe by pretending the new envelope contains
them. Obtain explicit owner resolution of those facts; do not silently discard or waive them.

Rollback after any accepted v1 command keeps strict fences, tombstones, cancellation markers and
pending envelopes intact; freeze writes or roll forward to compatible code. Reinstalling permissive
rules/legacy writers can resurrect records and is not an accounting-safe rollback.

## 6. Mandatory safety acceptance gates

All are release-blocking; passing one producer or five repeats never substitutes for another gate.
Use both synthetic owners plus an unauthorized third identity, real SDK/cache semantics and REST.

| Gate | Evidence required |
| --- | --- |
| G1 Capture and interruption | Kill before/after every reservation, fact capture/readback, seal, pending send, ACK save, atomic local apply and compatibility cache write. Original facts remain durable; failed capture changes no cursor/Undo. Unknown versions/quota fail visibly without clearing records. |
| G2 No time loss / no duplication | Exact original intervals, IDs, fields and classification survive every writer's reload/offline/delay matrix. Pre-ACK committed cursor/Undo unchanged; post-ACK applied once. Split/merge/manual/automatic facts preserved. Check exact records AND coverage/source facts, not just total minutes (overlapping observations retain their existing meaning). |
| G3 Physical keys and tombstones | Numeric/e_/identical/contradictory/typed-conflict/malformed cases, concurrent new aliases and offline replay. No duplicate physical identity, dropped contradictory source or tombstone restoration except explicit authorized Undo. Mutation tests remove each protective predicate and must expose failure. |
| G4 Authorization and causal atomicity | Wrong UID, detached account/device/session, Action API claim and direct parent writes refused. Delay any changed path; observe all entries/timer/redemptions/Away/Break or none. Takeover/revision races reject whole stale commands. Functions completion lens preserves new siblings. |
| G5 UNKNOWN/retry/cancellation | Lost reply, one-path/all-path later overwrites, requests delayed beyond a day, duplicates and lost cancellation reply. Exact immutable retry or retained UNKNOWN; permanent fence refuses every original late replay. No timeout release, new operation ID or one-stamp acceptance. |
| G6 Once-only local apply and listeners | Concurrent tabs, newer remote generation during ACK/apply, stale receipt check and crash mid-cache materialization. Atomic envelope/apply receipt repairs caches without cursor/Undo duplication; listeners never erase pending facts. |
| G7 Automatic/native/multistore | Controlled scheduled abort-before-unroute cases must become completion-or-visible-retention prevention tests; freeze template edits/dates. Two distinct due occurrences both retained. PC-Time/recovery/Break/Focus endpoints, ownership changes and native-query detach/kill/watermark are covered. Full command survives native failure; no skipped range is acknowledged. |
| G8 Bootstrap/legacy/extension | Offline SDK queue vs strict gates, startup migration and unknown owner, extension producer kill points and actual MV3 upgrade. No blanket replay/rebase, no silent legacy discard; verified writer census/cutover procedure before activation. |
| G9 Preserved behavior / artifact | Original F-1–F-7, affected browser/account/Focus suites, npm test, rule emulator/SDK/mutation, exact-source review, runtime parity/governed generation and package exclusion checks all pass. Guardian must run and pass separately; phone acceptance requires later owner authorization and remains unrun here. |

“No loss” includes work captured offline but not yet acknowledged. Pending does not equal lost, but a
permanent invisible pending state is unacceptable. Recovery must either finish exactly or show a
specific retained operation/conflict and a safe next action. Neither sign-out, upgrade, retention
cleanup nor selecting Keep server may silently erase an observation. No pending/event/receipt
garbage collection is mandatory for v1; do not prune evidence needed to prevent replay.

## 7. Actual implementation scope and estimate

Mandatory production source boundary:
- **One new runtime coordinator module**, proposed `accounting-command.js`: durable envelope,
  captured facts/sealed commands, exact retry/drain outcomes, atomic local apply and migration.
  Reuse the prototype's tested pieces; do not import test adapters into production.
- **Seven existing runtime sources**: index.html (only named accounting sections/callers),
  storage.js, time-ack.js, focus-mode.js, browser-extension/entry-physical-keys.js,
  browser-extension/pending-writes.js and browser-extension/background.js.
- **Two rule artifacts**: scripts/firebase-rules-builder.mjs and generated firebase.rules.json,
  ONLY under a later explicit owner authorization; expand the proven local gates to causal auxiliary
  paths without adding broader grants.
- **Release packaging**: extension manifest/version, governed index runtime generation, generated
  www closure/parity and canonical CODEMAP when structure moves. Current mirror has 99 files;
  final added dependencies must be measured, not presumed to leave that count unchanged.
- **Conditional caller-only edits**: daily-routines-ui.js, learning-plan-ui.js and any audited
  plan/intelligence dispatcher that currently treats a synchronous return as completed accounting.
  Modify only if a traced caller requires awaiting/propagating the new result. No domain redesign.
- **No anticipated implementation in** functions/, workers/, gateway, Android native UsageStats,
  HUD, sw.js or read-only analytics. Tests must confirm their compatibility; finding a needed change
  outside this boundary is a STOP rather than implied permission.

Mandatory verification sources: extend time-ack.test.js, accounting-hazards/command-journal.test.js,
physical-writer.test.js, extension-interruption.test.js and external-writer-boundary.test.js;
tests/time-ack-undo.spec.js and time-ack-unknown-hazards.spec.js; entry-validation.test.js,
entry-reliability-sdk.test.js; rules/emulator/mutation suites and the cancellation proof.
Run existing tests/daily-use-reliability.spec.js, timer-away-account-isolation.spec.js,
focus-reload-recovery.spec.js and focus-redemption-account-isolation.spec.js.
Add one staged-effects interruption/browser matrix and one actual MV3 lifecycle harness if existing
coverage cannot exercise G1–G8. Test-server stubs must model accepted/pending/refused outcomes.
Do not turn the existing historical counterexamples into misleading current-prevention tests.

Planning estimate, one engineer with review, after contract approval:
| Work package | Engineering days | Exit dependency |
| --- | --- | --- |
| Coordinator, envelope, migration, interruption harness | 3–5 | G1, G6 |
| Physical transport/rules, Undo and storage/bootstrap/replay | 3–5 | G3–G5, after coordinator |
| Deliberate producers, delayed deletes, maintenance/callers | 3–5 | G2/G4/G6, after storage |
| Automatic/native/Away/Break/Focus, scheduled recovery | 4–7 | G2/G7, after storage |
| Extension MV3/mixed writers and candidate qualification | 3–5 | G8/G9, after all writers |
| **Total** | **16–27 engineering days** | Review/repair included as a range, not a delivery promise |

This is roughly 8 runtime sources including the new module, 2 rule artifacts, packaging/generated
closure, at least 10 existing verification files plus the rule/Focus regression families and up to
2 new harnesses. Exact changed lines cannot be estimated honestly before extracting staged reducers.
The estimate excludes owner decisions, device availability, production writer census/cutover,
Guardian service delays and separately authorized phone acceptance. Those can block release
indefinitely even if implementation is complete.

Optional, NOT in the mandatory boundary: new backend/global operation receipt service, automatic
alias migration/conflict UI, optimistic draft previews, general timer-engine refactor, replacing
localStorage with IndexedDB, batching/performance tuning, receipt GC, new notifications/observability
dashboards and broader feature cleanup. If measured size or deterministic resolution requires any
of these, stop and request a revised scope rather than adding it silently.

## 8. Path comparison and one recommendation

| Path | Evidence and engineering consequence | Release conclusion |
| --- | --- | --- |
| A — complete integration | Reuses the demonstrated revision/physical/cancellation/retention primitives, but requires C1–C5 across the full listed boundary and G1–G9. Provides a single source of command truth and removes incompatible fallback writers. Estimated 16–27 engineering days plus external gates. | Selected development/release strategy. NO-GO until all gates and separate owner release authorization. |
| B — defer and release a smaller scope | Disabling Undo removes one race participant but does not fix pre-ACK Save cursor advance, separate entry/timer publication, native watermark, Away/Focus, physical aliases or old-client queues. Shipping the extension alone currently retains UNKNOWN and cannot prove production fencing. Installing strict rules alone causes legacy refusal after possible cursor advance. Removing these features and all automatic/replay callers would itself require a new product boundary, caller/source proof, pending-work migration and mixed-generation qualification. A read-only artifact could be a separate product choice, but is not a demonstrated safe time-tracking release. | No independently safe reduced accounting release shown. No lower implementation estimate is defensible without a different approved scope and evidence. Do not release this checkpoint under path B. |

**Recommend A, with release held.** It is the minimum demonstrated route to preserving the requested
time-tracking behavior: it reuses existing primitives and avoids a second feature-disable/migration
project that still cannot bypass shared persistence, server gates or legacy safety.
This is an evidence-based boundary, not proof A is safe today or a claim all conceivable reduced
products require more work. Shipping unrelated protected PR #20 is outside this decision and is
neither authorized nor blocked/modified by an invented accounting exception.

## 9. Verification record and next owner authorization

Reproduction commands and bounded outcomes are saved in
[scope-decision/RESULTS.json](accounting-hazards/scope-decision/RESULTS.json).
The sandbox initially refused Playwright child spawning (EPERM); the same local harness ran with
the approved process permission. No production network/data was used.
No full npm/browser/Guardian/phone run is claimed for this design-only, runtime-identical change.
The contract requires those checks for implementation/candidate qualification where applicable.

The next owner authorization is ONE bounded LOCAL implementation authorization for C1–C5 and the
mandatory source/test boundary above, with G1–G9 as the acceptance contract and the explicit stop
conditions in section 1. It must specifically permit canonical rule SOURCE design/edits and local
rule testing, while forbidding activation/deployment; the current instruction keeps those sources frozen.
It should also authorize the reviewed recovery/status wording needed to expose retained UNKNOWN,
without authorizing an optimistic preview or automatic conflict winner.

Suggested authorization:
> Authorize one local staged-command accounting integration against the TASK-039 accounting contract
> at the recorded design checkpoint. Cover the mandatory runtime, rule-source, generated parity and
> test boundary in section 7; preserve formulas, IDs/timestamps, Undo and owner/device/source protections.
> Meet G1–G9 or report a specific retained blocker. Do not waive the original Bob uncertainty using
> repeats. Stop for formula/backend/UI-policy expansion, unresolved legacy ownership or unproven
> cutover safety. Obtain independent exact-source review. No push, merge, deployment, production
> access or phone tests. Return the candidate, evidence and remaining release gates, then STOP.

This proposed authorization is not given by this report. No next implementation task is recorded or
started. A later production cutover and phone acceptance require their own explicit owner permissions.
Guardian remains **NOT RUN / NOT PASSED**. Production remains **NO-GO**.
## O1 — approved offline ordinary timer amendment (October 30, 2026)

Owner message "TASK-039 — O1 Contract Amendment Approved" authorizes LOCAL implementation in the
existing unified project. This appendix supersedes only contradictory C2/C5/G9 offline requirements
above. The original design, tests and failure evidence remain historical, not relabelled passes.

C5 distinguishes the server-confirmed accounting projection from a visibly provisional local
projection. After durable capture and readback, ordinary Start/Stop and their recovery may update
the provisional timer, local heartbeat/recovery and visibly pending entries. Original invocation
time, operation/session/account/device identity, complete facts and causal order remain immutable.
Pending entries do not enter confirmed entries, totals, exports, Undo or completion effects.
Confirmed projection and apply receipts change atomically and once only after authoritative ACK.
A server may already have committed a request whose reply was lost; local UNKNOWN is not refusal.

The narrow C2 exception permits causally ordered ordinary Start/Stop captures behind an unresolved
ordinary predecessor. It does not permit unrelated conflicting writers, revised sealed bytes,
automatic rebasing, a new backend or weakened ownership/revision/tombstone/cancellation rules.
Late ACK updates confirmed accounting without rolling back the newer provisional continuation.
UNKNOWN/conflicts keep the original pending facts visible and recoverable. Local persistence or
readback failure pauses the affected producer, preserves prior durable state and original in-page
intent, and must not report successful capture or promise crash survival for unstored bytes.

Offline UX after successful capture: Start runs a timer labelled "Started offline — awaiting sync";
Stop freezes its original endpoint and shows "Saved on this device — awaiting sync". Reload restores
that provisional state. Failure shows "Local save failed — tracking paused". Confirmed Undo is
unchanged and unavailable for provisional effects; other shared/completion effects remain ACK-gated.

Versioned acceptance, explicitly replacing the original pre-ACK committed-state expectations:
- F1-O1: offline Start survives termination/expired recovery with original session and observed facts;
  accidental-close recovery preserves continuation. Reconnect confirms exactly once or retains conflict.
- F2-O1: intentional-close recovery captures the Stop/log using the existing last-observed endpoint
  and arithmetic; provisional Stop retires its recovery heartbeat only after capture. Reload repeats
  neither the recovery prompt nor the log; server confirmation still requires ACK.
- F3-O1: missed ping/short reopen cannot discard the provisional session/start/heartbeat evidence;
  restore retains continuation or explicit uncertainty, then reconciles without loss or duplication.

Keep original F1–F3 assertions and failures unchanged. Add separately named F1-O1–F3-O1 tests;
never count original failures as O1 passes. New safety qualification covers persistence/readback,
Start→Stop before either ACK, repeated sessions, reload/kill boundaries, lost/late replies, peer
takeover/account changes, physical/tombstone conflicts, and exclusion from confirmed consumers.
The 32 async-extraction fixture errors are a separate maintenance step after this approved decision.
Full G1–G9 and exact-source independent review remain required. Stop for material new design,
mathematics or security boundaries. No push/merge/deploy/production rules or data access/phone tests.
Guardian NOT RUN / NOT PASSED; production NO-GO.

## Focus authority acceptance V1 — owner approved October 31, 2026

Bounded amendment within TASK-039, preserving C1–C5 and O1. Recovery must not automatically
activate a session without established ownership and authority. Authenticated coherent server
Focus restores normally; a durable provisional capture restores only with proven account/device/
session identity and causal lineage. Confirmed and provisional accounting remain distinct.
Ownerless caches and ambiguous legacy raw payloads remain exact retained-unproven evidence:
no deletion, relabeling, automatic activation, or override of newer coherent server state.

Versioned FA1-V1 (confirmed), FA2-V1 (provisional), FA3-V1 (retained-unproven), FA4-V1
(coherent state beats raw legacy) replace contradictory legacy recovery expectations only.
Original focus-reload-recovery tests and boundary counterexamples/failures remain untouched.
The twelve legacy expectations are dispositioned explicitly in the versioned regression file;
compatible outcomes retain their existing strength under lawful stateful SDK fixtures.
Ownership, stale-write, cancellation, time arithmetic, accounting ACK and completion protections
remain mandatory. No new architecture or timer engine redesign. Stop/report material expansion.
Local focused regressions before broad qualification; independent exact-source review required.
Release NO-GO. Guardian NOT RUN / NOT PASSED. No push, merge, deploy, production access,
production-rule changes or phone testing.

## Shipped web and Android capability — owner-directed amendment, November 1, 2026

Bounded amendment within TASK-039, preserving C1–C5, O1 and Focus authority V1. It adds no second
sync system, backend or rule change. The packaged capability is `accounting-capability.js`: a
descriptor paired with one exact `firebase.rules.json` (SHA-256 `93f0a774…5be00`) around the existing
`TimeAckCore` REST transport. No database marker activates it. Before any read or send, it checks that
installed rules behave like the paired rules; only `proven` reads or sends.

| State | Meaning | Effect |
|---|---|---|
| `proven` | Sink accepts a fence, fence cannot be erased, no parent grant over `focusRedemptions` | Reads and sends. Proof lasts 5 minutes per page and account; a refused write discards it |
| `unverified` | Offline, expired token, server error or inconclusive check | Nothing sent; retried |
| `incompatible` | Authorized reads show the rules fail the check, or the coordinator protocol differs | Nothing sent; retried |
| `missing` | The capability file did not load | Nothing sent; recovers on a real file |

The proof samples behaviour. It does not read the installed rules: `rulesSha256` is pinned by a test,
never compared at runtime, and a ruleset passing all three checks without a timer gate would prove.
The exact-hash check below is therefore a required cutover step and nothing in the app replaces it.

### Corrected cutover order (details section 5, step 9; its sequence is unchanged)

Installing the exact paired rules IS activation: nothing holds a client back, and every upgraded client
proves on its next retry. Section 5 requires gates installed while accounting stays quiesced, so the
gates go in two stages. Every step below still needs separate owner authorization. None is authorized now.

1. Quiesce every installed and previously connected writer (G8), and snapshot or export all provable
   pending and local facts. The extension stays excluded here; its generation must still be paired
   in the cutover manifest and separately qualified before it is enabled.
2. Run the synthetic CORS preflight from `https://shinyamadasan.github.io` and `https://localhost`
   for REST `PUT` and `PATCH` with a disposable account. Unproven today: production has never received
   these calls. A failure leaves every client `unverified` until fixed: safe, but effectively down.
3. Measure inspect, patch and readback on a real-size room over a throttled link. Worst case by
   arithmetic is six sequential calls at the 60-second timeout under the web lock, about six minutes.
4. Upgrade and verify web and Android. **From here until step 7, keep the window as short as possible.**
   Packaged clients gate reads as well as sends, so inbound accounting sync stops, not only logging. A
   device with an empty cache may show no history until Stage B (inferred from source, not measured).
5. **Stage A.** Install the candidate rules minus `timeAckCancellations`. All other gates are live and
   the probe reports `incompatible`. Verify the installed rules with trusted tooling against the hash of
   that exact file. No such verifier exists yet; it must be built and qualified first.
6. Verify mixed-generation rejection and synthetic allow/deny checks under Stage A.
7. **Stage B.** Check the file about to be installed against hash `93f0a774…5be00` BEFORE installing,
   because verification after install follows activation. Install it, then immediately read the rules
   back, confirm the hash, one disposable proof and one synthetic Start/Stop. A wrong file that passes
   the three behavioural checks would activate clients until this read-back catches it.
8. Device-test Android cold start with an evicted cache. It has no identity until proven otherwise.

Rollback after any accepted v1 command remains the rule at the end of section 5: keep fences,
tombstones, markers and pending envelopes; freeze writes or roll forward. Stage A can freeze writes
within one proof lifetime. It is not yet qualified as a post-activation rollback and must be before use.

Do not install the exact rules as a single step, upgrade clients without owner acceptance of the
step 4 sync freeze, or treat a passing probe as proof of the installed hash.
No push, merge, deploy, production access, rule change or phone test is authorized by this amendment.
