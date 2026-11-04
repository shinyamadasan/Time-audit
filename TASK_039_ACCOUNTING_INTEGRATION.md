# TASK-039 unified accounting integration — consolidated progress and evidence

Approved design:73739e9; branch:task-039-unified-accounting.
Owner authorization: October 29, 2026, current session, one coordinated LOCAL project.
Contract:TASK_039_ACCOUNTING_CONTRACT.md C1–C5 and G1–G9; complete writer inventory applies.

Status: **Bounded Focus authority V1 implemented and independently APPROVED locally; frozen SDK308/308 and npm PASS. Full TASK-039 G1–G9 remain incomplete; release NO-GO.**
The prior worktree and evidence were archived and verified before source changes. Bounded correction
checks pass; independent correction, cancellation/hydration bridge and bounded Focus reviews APPROVED
their exact source snapshots. Correction checkpoint:4eaa67e; bridge checkpoint:ead1403. Focus evidence
and reviewed hashes are recorded below. Full integration is still incomplete; no release candidate yet.
No push, merge, deployment or production access occurred.
Guardian **NOT RUN / NOT PASSED**. Production **NO-GO**.

## Milestones

1. Durable coordinator/local envelope → verify capture, sealing, retries and crash-safe local apply.
2. Physical identity/rules/Undo/storage → verify atomic guards, cancellation and replay/listeners.
3. All deliberate and automatic/native/Away/Focus writers → verify original facts and unchanged pre-ACK effects.
4. Extension, packaging, integrated gates → verify G1–G9 within the authorized local boundary.
5. Independent exact-source review → record final commit, remaining gates and one release decision.

## Gate ledger

| Gate | Result | Evidence / outstanding work |
| --- | --- | --- |
| G1 capture/interruption | PARTIAL / NOT PASSED | Six native/Focus assertions repaired; frozen SDK308/308 passes. Complete all-writer kill/quota/size matrix remains. |
| G2 no loss/duplication | PARTIAL / NOT PASSED | Prior bounded cursor corrections preserved; final SDK308/308 passes. Complete all-writer loss/duplication matrix remains incomplete. |
| G3 physical/tombstones | PARTIAL / NOT PASSED | Both-account physical-key/Delete/Undo regressions pass in final SDK; full alias/tombstone/concurrency matrix remains incomplete. |
| G4 authorization/atomicity | PARTIAL / NOT PASSED | Existing ownership/stale-write guards preserved; invalid Focus identity refused through reconnect. Full supported-operation/atomicity matrix remains. |
| G5 UNKNOWN/retry/cancellation | PARTIAL / NOT PASSED | Original capture/retry/cancellation protections preserved. Focus V1 retains unproven legacy without adoption; complete overwrite/delay matrix remains. |
| G6 local apply/listeners | PARTIAL / NOT PASSED | Final SDK308/308 passes; two CDP Promise-collection reproductions and one original-cause inference documented. Full cross-tab/listener/cache kill matrix remains. |
| G7 automatic/native/multistore | PARTIAL / NOT PASSED | Native readback and Focus AutoStart assertions pass on final source; bounded source review approved. Full multistore matrix and historical Bob uncertainty remain. |
| G8 bootstrap/legacy/extension | PARTIAL / NOT PASSED | Earlier bounded MV3 evidence retained; Focus V1 covers retained legacy bytes. Complete historical-package upgrade/installed-writer/cutover census remains unrun. |
| G9 behavior/artifacts | PARTIAL / NOT PASSED | Final SDK308/308 includes48 FA-V1 and6 O1; npm PASS, mirrors101, bounded review APPROVED. Original Focus26 not newly qualified; full integration/QA not passed. |

## Progress

- Startup: confirmed clean approved worktree/checkpoint, read contract, complete inventory and canonical
  architecture/decision context. Created a separate local implementation branch; prior branches preserved.
- Scope: no optional orchestration workflow is activated; the requested independent source review will
  use a fresh reviewer context after integration. No external service or production access needed.
- Coordinator milestone in progress: immutable capture intake is persisted before Web Lock acquisition;
  unique intake slots are durably imported into the single projection/command envelope under the lock.
  This closes same-origin capture races without unlocked envelope read/modify/write. Original facts
  and sealed commands remain immutable, exact original-base retry is supported, and projection/apply
  receipt commit precedes cache materialization. Runtime capability defaults to fail-closed.
- Focused coordinator checks: `node --test --test-isolation=none accounting-hazards/staged-effects.test.js`
  **13/13 pass** (durable capture, lost reply/restart, exact retry, all-path evidence, commit/cache
  interruption, account detach, occurrence identity and unreadable envelope). Initial normal Node test
  invocation was sandbox-blocked by worker spawn EPERM; in-process isolation avoids that limit.
- Latest actual runtime regression subset: `node node_modules/@playwright/test/cli.js test
  tests/accounting-staged-effects.spec.js --grep-invert 'G2 boundary' --workers=1`:
  **10 passed, 0 failed**, 23.2 seconds, real SDK/emulator, both accounts. Delayed ACK leaves
  committed entries/cursor/Undo unchanged despite realtime echo; lost reply recovers original command
  after clock change. Numeric physical source remains singular through entry extension/Delete/Undo;
  acknowledged Undo rewinds the cursor and Stop records its complete next span. These tests exercise
  migrated application paths, not all writers or all gates. The four excluded G2 boundary tests
  were run separately and FAILED; this subset is not a full-suite PASS.
- Local rule mutation command: `node --test --test-isolation=none --test-name-pattern
  'accountingRevision|accountingProtocol|accountingCancellation|accountingPhysicalBinding|accountingMarkerPermanent'
  firebase-rules-mutation.test.js`: **5 passed, 0 failed**. A distinct staged protocol marker rejects
  older sealed requests without upgrading or deleting those pending requests. Strict rule sources
  remain local and incompatible with unmigrated writers; no partial activation is safe.

## Prior STOP evidence: resolved by bounded owner authorization

Boundary command: `node node_modules/@playwright/test/cli.js test
 tests/accounting-staged-effects.spec.js --grep 'G2 boundary' --workers=1
 --output=test-results/accounting-boundary --reporter=json`.
Result: **0 passed, 4 failed, no skips or retries**; latest capture 25.8 seconds. Alice and Bob each
fail both cases. Assertions demand preserved work coverage; these are not expected-failure tests.

| Sequence, minutes relative to original start | Actual accepted server records | Safety failure |
| --- | --- | --- |
| Start 0; notification-only ping 30; Switch 35 | Writing 30–35, 5 minutes; new task cursor 35 | Pending work 0–30 disappears from entries and the current task cursor. |
| Start 0; Break starts 10, ends 15; Save 20 | Writing 0–10; Break 10–15; Writing 0–20 | Repeats 0–10 and includes the separately logged Break as work. |

These commands have accepted local apply receipts and empty pending queues. Retention/atomicity alone
does not repair their source intervals. Display clipping cannot establish source-record safety.
Exact server records, operation phases, command statistics and source hashes are preserved in
[integration-boundary-evidence.json](accounting-hazards/integration-boundary-evidence.json).
Large Playwright traces remain in ignored `test-results/accounting-boundary/`; the JSON evidence is
standalone and does not require those traces to inspect accepted records.

At approved checkpoint 73739e9, doPing advances blockStartTime without logging, while switchToTask
starts its log at that anchor. startBreak logs from taskStartTime but does not advance it; endBreak
resumes without a new task accounting anchor. Current reducers preserve those calculations. Fixing
these cases changes Switch's credited interval from 5 to 35 minutes and the second work span after
Break from 20 to 5 minutes. The contract's unchanged-domain/formula requirements and the owner's
explicit mathematics STOP preclude silently selecting those corrections. TASK-035's earlier
pending-through-Save decision is a relevant precedent, not clear authorization for new Switch/Break
interval semantics. No historical records have been rewritten.

## Independent source verdict

A fresh read-only reviewer inspected approved contract, checkpoint functions, current reducers and
boundary tests. Verdict: **explicit STOP applies; these defects predate staging; narrow owner decision
required**. The reviewer did not independently rerun the failures and did not approve unfinished
integration. Full independent exact-source integrated-candidate review is **NOT RUN**.

Reviewed Git blob IDs:

- index.html: `908965c70dce57e8246640b7ddde793d7441a1ac`
- tests/accounting-staged-effects.spec.js: `87d2787cef34be406f3721697b902a8908739ad4`
- Approved contract: `6d05a3a7b9d4839febe68b07ed172f5c9bd7c6fe`

The evidence JSON pins all 13 implementation/verification/baseline artifacts using SHA-256 and Git
blob IDs. Runtime/test sources have not changed since review; only evidence, task status, CODEMAP
and append-only logs changed afterward. This is a boundary review, not integrated release approval.

## Scheduled-event risk

Both accounts pass controlled actual-runtime abort-window/template-edit/reload prevention. Original
occurrence and immutable command recover exactly once, with original interval/classification. This
addresses the design's observed UNKNOWN retry defect for that sequence. The single historical Bob
failure is still not conclusively attributed; the previously identified abort-before-unroute race
remains its supported explanation. Passing repeats do not close it. Full G7, dependent multievent
ordering, native usage and Focus coverage remain required.

## Exact remaining implementation boundary

All work remains in the SAME coordinated project and approved C1–C5 scope:

1. Resolve only the demonstrated pending-span cursor decision, then complete deliberate callers and
   automatic/Away/Break transitions, including contradictory-state refusal and full post-ACK
   heartbeat/notification/UI effect recovery. Preserve rounding, event instants, IDs, ownership and Undo.
2. Complete coordinator cancellation/fenced Keep server resolution, retention of dependent facts,
   cross-tab intake/apply, coherent newer-generation reconciliation and full interruption matrix.
3. Complete storage.js bootstrap/listener/reconnect migration. Remove incompatible SDK publication
   fallbacks only after retaining original pending facts; quarantine unknown owner/version/conflicts.
   Finish legacy TimeAck handling without rewriting sealed requests or abandoning UNKNOWN.
4. Integrate native request/result persistence and account-scoped usage watermark in index.html;
   integrate Focus accounting/stores/completion hooks in focus-mode.js. Audit/await conditional
   daily-routines-ui.js, learning-plan-ui.js and plan/deep-link callers as the contract specifies.
5. Complete browser-extension/pending-writes.js and background.js producer/capability/replay integration,
   actual MV3 lifecycle and mixed-client tests. Physical resolver changes alone are insufficient.
6. Qualify every supported operation against strict LOCAL rules, including positive compatibility,
   stale/unauthorized replay and permanent cancellation. Historical counterexamples retain original
   rule fixtures; do not relabel them as current application safety.
7. Package governed runtime/extension generations, manifest, generated www closure and parity;
   run every mandatory G1–G9 matrix/regression and full npm test, then obtain independent exact-source
   review of the actual integrated commit. No partial source or rules rollout.

Not completed: seven-source migration, packaging, full npm/Focus/account/rules suites, full
SELF_REVIEW/QA and exact integrated-candidate review. They halted at the explicit STOP; their results
are not inferred from focused checks. Would I ship this working tree? **No.**

## One strategy and one next authorization

Retain **Path A**. No independently safe reduced accounting release has been demonstrated.
No release authorization is currently appropriate.

Previous requested authorization, now explicitly GRANTED by the owner: permit correction of the demonstrated
pending-span cursor defects—Switch records the complete unlogged task span; accepted Break start
closes work and accepted Break end establishes the next work anchor—while preserving rounding,
captured event instants, IDs, ownership and Undo. No historical rewrite or general timer redesign.
Then finish the remaining boundary and nine gates before requesting separate release/cutover
permission. PR #20 and gateway remain frozen; live rules/data/production were not accessed.
Guardian **NOT RUN / NOT PASSED**. Production **NO-GO**.


## Bounded pending-span correction — October 29, 2026

The owner explicitly authorized the two demonstrated cursor attribution corrections and continuation
of this same project, with the original remaining integration contract. No new feature task created.
Preservation archive (28 files including old ignored failure traces and patch/ref snapshots):
`../task-039-preserved-local/pre-pending-span-20261029T190115Z.zip`.
SHA-256: `905a330fffde1ea36af9c4c8c994291ae6bda3ab8c25207747a9fa5fec779a53`.
Every archived file was read back and hash-verified before source edits. Prior evidence remains intact.

Fresh unchanged-source reproduction: **0 passed, 4 failed**, no skips/retries, 28.1 seconds.
The same original four assertions after the correction: **4 passed**, 10.8 seconds.
Expanded pending-span matrix: **22 passed**, 61.6 seconds; additional caller/device/capture checks:
**6 passed**, 14.1 seconds. Existing affected runtime regressions: **10 passed**, 22.8 seconds.
All use actual runtime source, real Firebase SDK and synthetic loopback emulator for Alice and Bob.
No external browser traffic is permitted. No unchanged full suite was repeatedly run.

Changed source behavior:
- Both Switch entry points prefer the existing task accounting anchor over the notification phase.
  Mid-block Switch closes that pending span and retains its original presentation/session origin.
  Its explicit owner/device check rejects a different owner before capturing a command.
- Accepted Break start closes work at the original invocation time. Accepted Break end establishes
  work's next anchor at its frozen observation time. Neither cursor moves before the atomic ACK/apply.
- No rounding formula, event timestamp, entry creation ID, tombstone/Undo meaning, historical-record
  migration or time-engine architecture was changed by these corrections.

Verified boundary cases: delayed ACK with realtime echo, deliberate Save blocked while pending,
pre-send offline capture, lost reply after server commit, immutable same-ID/same-payload retry after
clock changes and reload, failure before local apply receipt, capture storage failure, both Switch
callers, device refusal, Save extension/Undo/Stop, Save Undo after Break (cannot cross its endpoint),
fractional event instants/rounding and an unrelated historical tombstone's exact preservation.
Current runtime correction delta and versioned evidence:
[pending-span-correction.patch](accounting-hazards/pending-span-correction.patch),
[pending-span-evidence.json](accounting-hazards/pending-span-evidence.json).

G2 and affected G7 have been reevaluated: demonstrated boundaries pass; neither full gate is passed.
The historical Bob failure remains unresolved. Both controlled scheduled-event prevention cases
still pass after these changes; that is not substituted for historical root-cause proof.
Independent correction review APPROVED the exact bounded delta. Remaining authorized integration has not been waived.


### Independent review repairs and final affected checks

The first independent review withheld approval for short-Break merge eligibility and already logged
PC-Time. Both findings were repaired within the pending-span boundary:

- `crossesAccountingBreak` uses the existing committed Break start to prevent merge extension across
  that transition, including after a user rename, Break Undo or reload. Existing seam tolerance
  remains for other extensions. No user-edited or tombstoned record is rewritten to invent a barrier.
- Accepted automatic PC-Time now advances the owned task frontier in the SAME entry+timer command.
  Its producer captures from the pending task anchor; notification phase timing is unchanged.
  A lost reply/reload reuses the original entry/command and never counts the acknowledged span again.
- A second review found a reversed-clock automatic child could shrink an accepted parent while its
  cursor stayed ahead. SDK reproduction: **0 passed, 2 failed**. Preparation now retains the original
  child as a visible conflict before sealing; accepted parent records/cursor stay unchanged across
  reload/retry. The pending fact is retained with its original ID/input, not silently acknowledged.

Short-Break before-repair run: **6 passed, 2 failed** (Undo exposed the merge). PC-Time frontier
before-repair: **0 passed, 4 failed**. Repaired short-Break/PC cases: **12 passed**.
Complete affected browser matrix before the final no-shrink guard: **50 passed, no skips/retries**,
106.7 seconds. After that guard, the affected PC-Time/clock/scheduled subset: **8 passed**, 20.2 seconds,
including the two new reversed-clock cases. This covers 52 distinct affected browser cases across
these recorded runs; it is not a claimed single 52-case run. Unchanged cases were not repeated again.
An intermediate clock test failed solely because its nested stamp matcher required an exact one-field
object; only that matcher was corrected. Exact timestamp/duration/ID and retention assertions remained.
All outcomes, including this harness failure, are retained in pending-span-evidence.json.

Static checks: all three executable inline script blocks parse; local rules source matches its
builder; git diff --check passes. Coordinator's existing 13 checks and five rule mutation controls
remain reusable because those modules/rules have not changed during the correction.
Full npm, packaging/parity, legacy/MV3/native/Focus and full integrated-candidate review remain pending.
Final independent bounded review APPROVED the exact corrected source; full G2/G7 remain NOT PASSED.


### Bounded correction review verdict

Independent exact-source verdict: **APPROVED for bounded corrections only**.
Index Git blob `b8b379bd3be02152e4e09a861be7b26e87187d8e`; tests blob
`3b60d3b3900b3516432930a2a82ce4f050c0cf9b`. The reviewer independently ran three exact-source
checks (backward endpoint retention, forward frontier/identity, short-Break separation); **3 passed**.
Browser evidence was inspected, not independently rerun. The reviewed source was hash-verified
unchanged before this local milestone commit. No full integrated-candidate approval is claimed.

This is a LOCAL correction checkpoint of the preserved partial integration, not a production commit.
Full-project SELF_REVIEW/QA and qualification remain incomplete; production ship answer remains No.
The same TASK-039 project remains status codex and resumes its already authorized remaining milestones.
No further routine implementation authorization is required; no release authorization is appropriate
until all nine gates and the separate external release conditions are satisfied.


## Continued authorized integration after the correction checkpoint

Bounded correction commit: `4eaa67e62da4b4ff4d004469d542b272bd2b181d`.
This same project continued after G2/affected G7 reevaluation and independent bounded approval.
The following changes are currently UNCOMMITTED integration work, not part of that review approval.

- Coordinator permanent cancellation now records resolution intent before marker creation, checks
  coherent fence proof, and commits reconciliation plus receipt atomically. Lost cancellation replies,
  detach and local receipt failure retain the original request. Unsupported capability sends no marker.
  Captured new work cannot be discarded by Keep server; its original payload remains held.
- Existing status surface now offers confirmed Keep server resolution. Both accounts pass the real
  SDK lost-cancellation-reply/late-original-Undo rejection case and captured-work retention case:
  **4 passed**. Legacy TimeAck adoption/resolution and broader cancellation qualification remain.
- Coherent read-only hydration now uses the same durable coordinator and atomic local apply receipt.
  Four accounting listeners plus historical redemptions route to it. Their previous LWW/global cursor
  effects were removed. Source readiness and ordinary command dependencies are explicit; triggers
  arriving during a drain schedule a subsequent coherent read instead of disappearing.
- Newer accepted server generations can supersede a late local ACK without replaying its stale timer.
  A two-client SDK case holds Save ACK while the peer takes over and stops; both accounts pass
  **2/2**, preserving both logged intervals and Stop through subsequent Undo.
- Investigation of an initially retained refresh found a consumed row-animation pointer differed from
  the canonical frame. It is presentation state, so hydration preserves its current value without
  using it as a guard on recorded time. The initial failed outcomes remain recorded.
- Cache restore now captures unknown compatibility data before installing a canonical projection;
  known interrupted cache materialization is repaired from receipts. Unreadable source bytes are
  preserved, with protected cache writes and new accounting publication paused. A backward clock
  cannot shorten the original heartbeat observation. The repaired cache/boundary/peer SDK batch:
  **12 passed**, 30.6 seconds, both accounts. Before the heartbeat fix:10 passed2 failed.
- Coordinator checks now **21 passed**: original13, five cancellation and three hydration/ordering
  checks. No full project gate is inferred from these focused checks.
- Static inspection only of the local ignored Android UsageStats plugin confirms permission denial
  is rejected distinctly from a successful empty result; the JS continuation can preserve this
  distinction without changing Android source. No phone, native binary or production testing occurred.

Incremental outcomes (including failures):
[integration-runtime-evidence.json](accounting-hazards/integration-runtime-evidence.json).
The SDK harness now snapshots the whole runtime closure before serving it and attaches exact file
hashes, preventing edits between page loads from mixing candidate versions. Service workers are
blocked in this harness; worker behavior remains a separate required qualification gate.

G1/G3/G4/G5/G6/G7/G8 remain PARTIAL or NOT RUN, never PASSED. G2's bounded corrections passed;
full G2 remains NOT PASSED. Full G9 is NOT RUN. Source fallbacks/bootstrap replay, native, Focus,
conditional callers, extension MV3, rules positive compatibility, packaging and full exact integrated
review remain unfinished. Historical Bob uncertainty remains unresolved. Guardian NOT RUN / NOT PASSED;
production NO-GO. No further implementation approval is being requested for the existing scope.

### Independent bridge findings and repairs

The first bounded cancellation/hydration review was NOT APPROVED and identified three must-fix
issues: heartbeat deletion beside unreadable caches during stopped/foreign-owned restore; an accepted
Save reconciled with an Undo missing its guarded origin receipt; and resumed cancellation missing the
captured device check. Each received a regression before repair. The device regression failed first,
then all22 coordinator checks passed. The shared Undo receipt constructor now serves normal apply and
fenced reconciliation; uncommitted Undo preserves its prior slot, while accepted Undo consumes it.

The review also prompted a real mixed-writer materialization test: hold an actual SDK Save ACK, write
an unacknowledged record into the compatibility cache, then release ACK. Both accounts previously
lost that cache fact (0/2). Cache preservation now reads actual cache bytes immediately before
materialization, retaining unknown facts in intake before any replacement. Existing receipts prevent
duplicate quarantine of the same bytes. Unreadable bytes pause protected writes and heartbeat cleanup.

Final affected SDK batch: **18 passed,0 failed**,40.8 seconds, both accounts, served from an immutable
runtime snapshot with source manifest. This covers stopped/foreign restore with unreadable caches,
accepted Save→fence→usable Undo, accepted Undo→fence→consumed slot, lost fence reply/late replay denial,
held-ACK cache race and all three prior bootstrap cases. The uncommitted-Undo preservation batch was
4/4, and accepted-Undo interruption was2/2 before this final batch. No case count is inferred beyond
the actual reports. All intermediate failures remain in integration-runtime-evidence.json.

The first repair batch was9/10: Bob's invalid cache was overwritten before reload by a still-running
materialization, revealing the broader cache-write race. The restore test now installs its corrupt
bytes before app boot, and the separate delayed-ACK test directly qualifies the live race. A later
12/18 batch exposed redundant parsing of already-known unreadable caches during drain; the recovery
guard now preserves the error/bytes while allowing the confirmed model to remain readable.

The second independent exact-source bridge review is **APPROVED for this bounded bridge only**.
The reviewer independently reran22 coordinator checks (all pass) and inspected, without rerunning,
the18/18 immutable SDK repair batch. Reviewed Git blobs: coordinator `e02df9278cf73a89dd6796cf3b1eb267b302513a`,
index `b87220f2533d1f33c76792f5f5e5edf737923a08`, storage `04f6daf1f92b3ebd5d98edd7d38f95efaafc7453`,
TimeAck `2c254d50f6539888b6f7acc616d02f068169e2e6`, SDK tests `2ed585db4386533192769851c53b797358525e67`,
coordinator tests `61681ed491e0217515c2f39c705c8557cb01b495`.
Full Focus/native/legacy/extension integration and
all nine project gates remain incomplete. No production or integrated-candidate approval is implied.

### Expanded bridge boundary qualification

The broader bridge batch initially produced14 passes4 failures. Two peer-start failures were caused
by treating absent timer caches as unknown legacy facts; absence has no captured interval and is now
repaired from the canonical envelope. The Break test allowed a coherent readback to acknowledge its
lost PATCH response before asserting pending state. Its interruption now also aborts subsequent
coherent GETs until reload, preserving every original interval/Undo/pending assertion. The diagnostic
2-pass2-fail run is retained; no accounting assertion was relaxed.

Concurrent drain triggers are now coalesced per full attachment identity without dropping a trigger
that arrives during a read. The new unit first failed with102 lock requests; the repaired coordinator
passes23/23 checks, including101 overlapping triggers, one child fact and at most one queued recheck.

Final expanded SDK batch: **36 passed,0 failed**,86.5 seconds. It includes both-account G2 boundaries,
short Break, offline/lost-reply Break, controlled scheduled replay, newer peer takeover/Stop, the18
review repair cases and cache races. Final small-delta review is pending; previous bounded approval
does not automatically cover these subsequent changes.

The unchanged Focus writer's first real-runtime strict-rule integration regression is **0 passed,
2 failed** (Alice/Bob): original full-phase logging does not reach the server through the coordinator.
No Focus migration code has been written yet. This records a required failing baseline, not a release
gate pass. Native, Focus, replay/legacy, extension, packaging and full candidate review remain pending.


Final small-delta independent review: **APPROVED for the bounded bridge only**. The reviewer found a
drain-completion microtask gap, reproduced as a failing unit. The successful finalizer now chains any
late trigger to a fresh drain and returns that result. All24 coordinator tests pass independently.
Reviewed coordinator blob98aae533d24c528006ee794e63a8848e23cadecf; index
baaebc895220978e45ee17b432de86971912ebd3; remaining exact hashes are in integration-runtime-evidence.json.
After this finalizer change the affected scheduled/Break/peer SDK subset passed **6/6**,25.3seconds.
The earlier36/36 run predates it and is recorded separately. No unchanged full suite was repeated.
This incremental local checkpoint remains status codex; no full integrated-candidate approval or
G1-G9 release PASS is implied. The authorized same project continues with the remaining writers.

## Initial Focus draft after reviewed bridge checkpoint — superseded by repaired review below

Reviewed local bridge commit: `ead1403279114c984e2aa37c13c116a0ba35cf03`.
Subsequent Focus/coordinator/caller edits are UNCOMMITTED and have not received source approval.
The draft stages Focus entry/phase/timer/checkpoint changes, retains callback effects with the atomic
local receipt, retries idempotent routine/Learning delivery, reads canonical restore state and guards
ownership. Conditional callers now await acceptance. No native/extension/replay implementation began.

Verification recorded separately in integration-runtime-evidence.json.focusDraft: original Focus
SDK baseline0/2, first endpoint/Break integration2/2; expanded lifecycle7/8 then8/8 (22.5s).
The one intermediate failure asserted all journal history remained fixed, although history includes
permitted background hydration; it now checks the specific forbidden writer receipt and exact server
timer/entry equality. Unknown Focus checkpoint version2/2 passes with original bytes retained and
publication paused. Coordinator30/30 passes, including effect receipt interruption, failed callback
retention, account/device detach and unreadable effect state. These are focused proofs, not G7 PASS.

### Timing boundary under investigation

The original live tick decrements its remaining counter once per callback. Original reload recovery
instead derives elapsed time from absolute phase timestamps and can finish both overdue phases at
the original restore invocation. The current draft derives live countdown from wall clock and can
defer restored phase observation until a later tick/ACK. That may change later AutoStart timestamps
under throttling/long ACK, beyond the owner's explicitly authorized Switch/Break corrections.

Focus edits are paused for independent exact-source timing comparison and contract-boundary review.
No approval is inferred from the passing endpoint cases. If preservation requires changed accounting
math or a materially different time engine, the existing STOP applies. Guardian NOT RUN / NOT PASSED;
production NO-GO. No full integrated candidate exists yet.

The unapproved Focus draft and its evidence were preserved in a verified26-file archive before the
timing decision: `../task-039-preserved-local/focus-draft-before-timing-decision-20261029T221933Z.zip`,
SHA256 `49533066500cc229abdaeca1d5d319eaf4ccb46cca25053321b94de154425941`.
Comparison against the original archive's refs-before.txt confirms every local branch and remote
tracking ref remains unchanged except the authorized task-039-unified-accounting branch. No push,
merge, deployment, live rules/data access or manual phone testing occurred.


## Repaired Focus milestone — independently APPROVED, local only

The timing review did not require a new authorization: the approved C2/C5 boundary already permits
a private producer continuation while committed phase/UI/cache state waits. Original live callback
counting is preserved; reload alone performs wall-clock catch-up. Work entries keep their planned
endpoints; AutoStart keeps its original callback/restore invocation, even through a held ACK.
The real SDK timing regressions first failed0/4, then passed in the14-case repaired lifecycle batch.
Two further cases held Start ACK across work25 and Break30, preserving both source facts while
committed Focus stayed idle, then accepted the original intervals at a later acknowledgement.

Independent Focus review initially found two must-fixes: capture failure retried with a later instant,
and restore resurrected a producer behind an already-captured terminal Learning Stop. Hash-verified
exact before-source SDK reproduction now demonstrates both:0/4, with actual late/config-changed
AutoStart and phantom Break-end assertions failing. The same assertions after repair passed4/4.
Initial diagnostics with an unhandled intentional navigation and unstable network timing were not
accepted as closure; their reports remain retained.

Capture failures now freeze original facts/configuration per account/device and pause the source
clock. The status truthfully says an unpersisted original is held in this page; it does not promise
crash survival when storage cannot write. Check now retries that original instant. Failed post-write
readback also reuses the original operation ID;2/2 SDK cases pass. Network UNKNOWN after successful
capture continues retaining subsequent source facts behind the same causal parent. Terminal pending
Focus observations prevent reconstruction of an older committed producer. Normal duplicate delivery
uses its original captured fact; a failed capture with a contradictory recovered fact remains held.

Current coverage:26 valid Focus cases in the final broader batch, plus2 corrected post-write
readback cases on the same runtime. This is28 distinct cases across runs, not one28-case run.
The first readback injector failed at the pre-write collision lookup; the corrected injector fails
after reservation bytes exist and verifies the original ID through acceptance. All intermediate
reports and source manifests are retained. Both accounts also pass accepted Learning finish, failed
callback-receipt continuation, actual SDK peer takeover/fencing, partial exit/reload, Undo and original
endpoint checks. No original npm/Focus regression or complete G7 PASS is inferred from these cases.

Independent verdict: **APPROVED for the bounded Focus integration only**. The reviewer independently
ran31 coordinator checks (all pass) and an exact-source capture-pause/retry/account refusal probe.
SDK results were inspected, not rerun by the reviewer. Exact reviewed Git blobs are in
integration-runtime-evidence.json.focusDraft.review. No runtime change followed that approval.
The exact before-source fixture and test are preserved in focus-reviewed-before-fixture-20261029.zip,
SHA256614ff1d02069033d17d0443f0e61b76ca9d92c0b3f0c1eab596ec84cb185750e.

Next implementation boundary in this same authorized project: native reservation/result/watermark
and continuation; all surviving storage/reconnect/legacy accounting sinks; extension coordination
and actual MV3 lifecycle; complete supported-operation rules/lens tests; full G1-G9 matrices and
original behavior suites; packaging/parity and final integrated exact-source review. None is waived.
Task remains codex; Guardian NOT RUN / NOT PASSED; historical Bob uncertainty retained; production NO-GO.


## Native request/result integration — reviewed bounded checkpoint, same project

The single coordinator now retains an owned immutable query reservation before handoff and a separate
immutable unprocessed result intake before classification. Failed queries remain distinct from empty
successful results. Incomplete queries do not become ordinary command predecessors or block unrelated
ready commands. Successful results join the original command lifecycle under their original identity;
source/result evidence is retained with receipts. Device continuations and watermarks live in the
account's atomic committed envelope. There is no new backend node or Android-source change.

Native sessions retain the original pairing, rounding, entry IDs, invocation timestamps, activity
classification and manual/duplicate policy. Open foreground events cross windows without moving the
committed watermark before ACK. Query failure/reload retries the original window. A failed request or
result storage/readback retains its original payload in page memory when necessary; this is not a
claim of crash durability for bytes the browser refused to store. Stored raw results can be recovered
without re-querying. Account detach retains the result in its original partition, with no new-account
application. Undo and tombstones are protected by the existing coordinator/physical resolver.

The legacy unscoped watermark is captured as unproven source bytes and left unchanged. A new request's
existing14-day lookback is a request-scoped retrospective observation; it does not establish which
account held the phone at every historical timestamp. It never relabels another account's pending
reservation or result. Known expired continuation ranges remain retained rather than silently clamped.
A later independent peer manual retro preserves its existing overlap meaning; no global interval
exclusion or automatic removal of accepted phone history is claimed. Two-context SDK evidence covers
this ordering for Alice and Bob.

Incremental evidence (all source manifests/reports retained in integration-runtime-evidence.json.nativeDraft):
- Four new coordinator checks initially fail; source APIs bring the coordinator suite to35/35.
- First native SDK run:2 passed4 failed on startup ordering. Moving recovery-status helpers into the
  main script fixes that initialization race; a focused1/1 and the wired6/6 batch pass.
- Interruption run:4 passed4 failed. Two expose a renderer readback exception, repaired with guarded
  status inspection. Two are invalid lost-ACK assumptions: exact authoritative postimage readback had
  legitimately confirmed the command. The controlled tests now also block that readback until reload.
  Repaired readback/UNKNOWN4/4, ownership/Undo/tombstone6/6, request capture4/4 and peer ordering2/2 pass.
- Frozen pre-schema-review candidate:32/32 (26 native plus4 pending-span boundary and2 Focus callback).
- Independent reviewer independently runs35/35 units and requests a schema correction. Exact-source
  probe and SDK regression show corrupt range/open can reach a local-only receipt:0/4 before repair,
  then4/4 after request/open/checkpoint validation before query, preparation and commit/application.
- Repaired exact-source SDK run:38/38 pass (32 native,4 pending-span boundary,2 Focus callback),58.3s.
  Independent bounded native APPROVED after eight exact-source schema probes and the unchanged35/35
  coordinator suite. Reviewer inspected38/38 SDK evidence without rerunning that browser suite.
  Full G7, npm/legacy/MV3/packaging and integrated-candidate review remain pending.

Runtime capability still defaults to refusal outside the pinned loopback harness. PR20, gateway and
production remain unchanged. Task remains codex; Guardian NOT RUN / NOT PASSED; production NO-GO.

The schema-before index was reconstructed only in test-results/native-schema-source-before and its
Git blob1194eb924c679309d1b73ed826ce4721271c0b87 verified exactly. Current reviewed runtime/test blobs
are in integration-runtime-evidence.json.nativeDraft.review. Local preservation archive includes both
that before-source and reviewed runtime, all native reports and source manifests; no older working
source or evidence was overwritten. Next boundary is surviving storage/reconnect/legacy sinks and
unbound quarantine, then extension/MV3, full gates and package closure in this same authorized project.

Native preservation: C:\Users\Admin\Desktop\Vibe code\Time audit app\.worktrees\task-039-preserved-local\native-reviewed-and-schema-before-20261030T003441Z.zip
SHA256 7b67645edaecc5459bb752b4e03cd9916cb68ed69bfd012b1879044b717c79b9;23 files, manifest/readback verified.


## Storage/reconnect/legacy milestone — uncommitted, in progress

Native checkpoint b5d1087cfcd889e13ca565fbfaf786e8f692057e is committed; this is still the same
coordinated project. Storage-boundary SDK regression initially0/4: old sync functions attempt direct
SDK accounting writes, and an UNKNOWN Save hides a newer peer Stop. The coordinator now permits only
a dependency-free read-only confirmed hydration beside a retained head. Its receipt removes only its
own operation. Own exact pending postimages stay masked to the previous committed generation until
full acknowledgement; their raw bytes remain in receipt evidence and the original pending proposal.
A newer foreign Stop can update the confirmed view without rewriting or retiring that command.

Core read-only checks initially0/2, then37/37 overall. Early independent review finds a stored
proposal could disguise a mutating request as a captured read-only side operation. Five corruption
regressions initially0/5; unconditional no-send checks and stored proposal path/stamp/base validation
bring the suite to42/42, independently rerun42/42. No additional demonstrated masking defect was
found in that early source review; this is not final milestone approval.

syncEntries/Timer/Redemptions/Away/Break no longer publish SDK accounting updates. Redundant calls
request coherent hydration; drift/unsupported explicit legacy intent is captured for quarantine.
forceSyncNow/reconcile and remote-apply compatibility triggers use the coordinator. Connection means
connected, not accounting acknowledgement. Public-stat projection follows accepted entry changes.
Focused SDK results: unknown-view2/2, no-fallback2/2, expanded drift/partial-own-postimage8/8, and
storage/legacy-reader plus original pending-span boundaries12/12. These reports use different exact
source snapshots recorded in integration-runtime-evidence.json.storageDraft, not one final suite.

The app no longer invokes the old Undo engine's recover/retry/finalize/apply path. Active, unsupported
or unreadable legacy acknowledgement envelopes are captured verbatim as unproven quarantine; their
original slot is left unchanged. No old request is restamped/resubmitted or applied through a second
local authority. The shared legacy reader also stops accepting a surviving single operation stamp:
corrected historical fixture0/2 on exact before-source, then2/2 on the current module. An earlier
uncontrolled test did not establish a surviving stamp; a first controlled attempt used the begin()
return wrapper incorrectly. Both invalid outcomes remain recorded and are not qualifying evidence.

Legacy Undo before-source browser batch has6 semantic failures and2 setup/navigation failures. A
first current run fails beforeAll emulator startup (1 hook failure,7 skipped); no application verdict
from it. A subsequent isolated current run passes8/8 (accepted, UNKNOWN, foreign and unreadable old
records for both accounts),0 skipped. Full raw data and Undo/cursors stay unchanged. Old records need
recovery review; this is deliberate retention rather than a claim of automatic migration completion.

Remaining in this milestone: old-record storage-event capture and canonical cross-tab notification
handling; timer interval/settings callbacks that still change accounting fields outside staging;
complete reconnect/cache/legacy and own-postimage/Undo/reload matrices; exact-source independent
review and preservation/commit. Complete extension/MV3, full G1–G9, original suites and packaging
remain. Broader stored domain-frame corruption must be covered in G1; no checksum/architecture change
has been introduced speculatively. No full npm or integrated candidate qualification is claimed.
Guardian NOT RUN / NOT PASSED. Historical Bob uncertainty remains; production NO-GO.


### Storage-event and interval source follow-up — still uncommitted

Old acknowledgement deletion can erase a slot before a callback reads it. Event old/new bytes now
enter quarantine directly; failed capture holds exact bytes in a per-owner page job until durable
recovery, with explicit in-page wording. Before: Bob missing-retention semantic failure and an Alice
timeout during an extended tool stall; after:2/2. Shared receipt notifications initially triggered
mutual offline exact retries (Alice29→63 and Bob38→73 attempts over successive700ms windows). Ignoring
queue-phase/attempt-only notifications and intake-removal echoes stops amplification:4/4 combined
retry/deletion cases pass. SDK-offline receipt+Undo repair and legacy quota recovery pass4/4.

Interval controls exposed two new integration regressions: a valid prospective change stranded
hydration/retro, and an idle preview changed a held Start's original30-minute active clock to15.
Before0/4; repaired4/4. The settings store keeps the prospective preference; the accepted timer command
installs every captured clock field even when original before/after values were equal. Only proven
nonrunning preference-display divergence is allowed; raw ownership and Focus domain guards remain.
Late runtime helper writes no longer overwrite preferences. Startup native queries now wait until a
canonical/coherent account is ready rather than treat an initial raw frontier as an applied clock.

The approved73739e9 Sprint contains TWO original facts: local timerStartedAt stays at the earlier
start; unchanged buildTimerPublication publishes the Sprint invocation after remaining is reset.
Independent exact-source VM confirms local remaining1140 vs published mirror1440 at minute6 in the
controlled example. A test's equal-server-anchor assumption was wrong and is corrected. No anchor,
formula or historical record is normalized. The old timer listener did apply ordinary equal-stamp
own echoes (stale comparison strictly<), so that old echo race must not be described as a universal
own-echo skip. C2/C5 retain the accepted local frame on the exact established snapshot; changed
external/first authoritative snapshots adopt their published source. Source-preserving interval
batch10/10 passes. Save/Undo/reload/takeover initially0/2 reveals an initial raw snapshot was mistaken
for established canonical clock (peer running=true but timerStartedAt=null); the fix requires an
established canonical base. Its repaired coverage run is pending. No new owner math approval is
needed to preserve both original producer facts; changing either anchor would require one.

Early independent Focus lease audit finds TWO must-fix integrated-source gaps, despite backend stale
write refusal: retrying a page-held failed work-end after coherent peer Stop can restart old private
Break; pending imperative focus-start replay can overlay its old after-frame onto newer Stop. The
observational work-end-only replay is already fenced. These findings reopen affected G6/G7 source
qualification. Original failed/pending facts must be retained; only stale continuation must stop.
Real-SDK failing baselines and repairs are next, followed by the remaining source-failure ordering,
local frame schema, UI-effect, reconnect and full gate matrices. No release/candidate approval.


### Shared capture retention, source leases and schema follow-up — local, uncommitted

Verified storage-WIP preservation archive before this work: storage-wip-before-capture-consolidation-20261030T045244869391Z.zip,
SHA256 aa5c3e070814f653eea1a0131c7c48eb4abae9358c09b2a0a704433420106ac2;110 files, manifest/readback verified.
Sprint Save/Undo/reload/takeover repair passes2/2. Two Focus continuation bugs reproduce through the
real SDK/emulator for both accounts (0/4): late failed-work capture and pending imperative Start can
restart a private producer after coherent peer Stop. Exact causal source checks now fence adoption,
replay and ticking while preserving the original facts/command. Cyclic/missing ancestry fails closed.

The coordinator retains complete failed capture records in-page with original ID/input/timestamp and
callback, flushes the same unique intake/readback before sending, and exposes failed facts as causal
predecessors. No durability claim is made while storage is failing. A read-only recovery exception can
observe peer Stop without sending or retiring failed facts. Independent review catches duplicate
hydration receipt on repeated recovery; intake now retires after durable queue/history ownership.
Coordinator46/46 passes. Original native result-failure retention still preserves its raw result.

Domain local-frame corruption initially reaches remote publication/receipt before application throws.
An initial test omitted autoStart and was invalid; corrected tests expose the actual failure. Pure
validation now runs before proposal send, projection receipt and restore. A zero-duration clock case
also fails before repair0/2. Positive durations/owned active anchors are required. Review then finds
valid fresh-peer paused Break has timerStartedAt=null; paused validation preserves that original fact,
with both-account hydration/reload regression0/2 before repair and current repair still running.

Cross-source test initially0/2: a hydration between native reservation and result severed the original
failed Focus predecessor. Native preparation now verifies both retained request-time and result-time
causal chains; it cannot reinterpret an independent later edit as its predecessor. The affected source
boundary batch passes26/26; prior schema/source batch34/34 passes on its own frozen snapshot. Full SDK
milestone qualification and exact frozen-source independent review remain pending. No gate is promoted
to full PASS from these partial runs; extension/MV3, runtime effects, full G1-G9 and packaging remain.
Historical Bob uncertainty remains. Guardian NOT RUN / NOT PASSED; production NO-GO.


### Storage/source milestone qualification — 2026-10-30 Phoenix

The complete frozen SDK/emulator matrix passes188/188,0 skipped/0 flaky (382.4s), report
accounting-hazards/.storage-source-qualified.tmp. Its attached exact runtime manifest binds the actual
sources. Coordinator46/46 independently passes. Independent bounded exact-source review PASS covers
core719a03db, index829ea1b, storage6ae400d, Focus8c4e781 and TimeAck8c397e7, with full hashes and every
incremental run in integration-runtime-evidence.json.storageDraft.captureLeaseFollowup.

The first full matrix passed169 and failed15. These failures were resolved rather than omitted:
read-only hydrations cannot become a command/Focus continuation parent; bootstrap directly hydrates
instead of classifying deferred Focus's temporary idle state as a legacy write; lost-reply controls
also block authoritative postimage readback until recovery; assertions count factual commands apart
from independent read-only refreshes. A repeated post-ACK Playwright evaluation error was NOT a page
navigation: raw CDP returns-32000/Promise was collected. The test retains each single returned Promise
and polls its result, preserving all Undo/device/timer/entry assertions without command resubmission.
The full failed report/protocol evidence is retained. This does not explain the original Bob failure.

Repeated identical legacy-byte capture during quota initially allocates six IDs for the same intent
in each account (0/2). Deduplication now includes the shared failed capture store; independent probe
proves one original ID survives, and both storage-event and quota recovery cases pass4/4. Distinct
original byte events remain distinct. The old TimeAck module's full run initially16/28 passes under
new strict rules because12 cases expected old engine writes to succeed. Its historical lifecycle
now uses exact73739e9 rule bytes (28 passing historical cases), with TWO separate current strict-rule
legacy-refusal checks (both pass, no path changes). This is not30 current-rule operation proofs.

Existing frozen branch/tag/remote refs match the pre-correction archive except this task branch.
Two additional OAuth grant refs are present relative to that archive; this task issued no fetch,
push or mutations of those refs and leaves them untouched. PR20/gateway/main frozen refs are unchanged.

This is a LOCAL implementation milestone, not completion of the coordinated project. G2 and affected
G7 have stronger integrated evidence, but their full inventory remains open. Extension transport and
actual MV3, remaining writer/physical/authorization matrices, runtime effects, npm/original browser
suites, generated packaging/parity and final exact-source review remain required. Historical Bob
safety uncertainty remains unresolved. Guardian NOT RUN / NOT PASSED; production NO-GO.

Reviewed storage/source preservation: C:\Users\Admin\Desktop\Vibe code\Time audit app\.worktrees\task-039-preserved-local\storage-source-reviewed-20261030T093600061006Z.zip
SHA256 769b5a00b0ff28963d65fdd2c99c48ebe7ea459239854dab472809b53a2c0b0e;148 files, manifest/readback verified.


## Extension integration milestone — LOCAL checkpoint, project incomplete

Storage/source checkpoint f2b5377 is committed, with188/188 frozen app SDK checks and bounded exact
review. The same coordinated project continues; no next feature task or release authorization.

New canonical-rule extension baselines0/6: actual transport lacks alias PATCH (2 cases); corrupt
stored commands can publish outside entries or under a different operation ID (4 cases). Original
basis/fact reconstruction validates sealed commands before any handoff; the actual adapter limits
all sinks to entries and implements one multi-alias PATCH. A first repaired batch28/30 passes; two
old unsupported-transport tests now explicitly remove the newly supplied method to preserve that
failure scenario. Original typed keys and time calculations remain unchanged.

Capture tests0/4 expose mutable facts before the first storage await and absence of an intake if
outbox import fails. Immutable original facts/IDs now enter a separate capture slot; recovery imports
that slot once before its removal. UID/room/device/attachment metadata0/2 is corrected. Concurrent
captures with reversed UUID order initially0/2; explicit original causal predecessors fix ordering,
with alias receipts unable to release an unaccepted parent. Complete affected extension suite grows
to56/56 (canonical transport, physical/SDK races, idle mathematics and real Node worker interruption).

Independent review demonstrates401 credential retry can cross sameUID reattachment; deterministic
sameUID/otherUID regressions0/2 then pass after pinning the whole transport call. A separate exact
function probe0/1 exposes a credential-cache/tracking transition cycle. A short authentication cache
lock, shared by refresh and account-switch commits but never waiting on producer/outbox work, fixes
it. Current affected suite59/59; independent focused3/3 and stale-refresh probes pass. No current-rule
source/production activation occurs. Default runtime capability still refuses unqualified sends.
Retained operations are visible through existing extension badge/title/status, with account-fenced
responses; no popup redesign or time engine rewrite is introduced.

Actual bounded MV3 qualification now passes BOTH accounts2/2,0 skipped/0 flaky (12.2s),
accounting-hazards/.extension-mv3-process-kill.tmp. An original10-minute capture survives503,
forced termination of ONLY the synthetic browser PID obtained from that browser's CDP session,
restart of its isolated profile, then candidate manifest1.0→1.1 upgrade one day later. Exact
payload/ETag remain unchanged. The actual app SDK deletes and Undoes the accepted numeric entry,
leaving one physical key and the original timestamps. The test supplies loopback-only configuration,
explicit trusted rule capability and controlled time; it does not activate production capability.

Three earlier actual-browser runs failed in harness lifecycle handling and remain preserved:
runtime.reload unloads a command-line unpacked headless extension; Target.closeTarget does not
produce the awaited replacement worker; awaiting Browser.crash never returns its CDP response.
These failures are not suppressed or counted as candidate passes. The final isolated-PID test
completes recovery assertions. Real user browser profiles are untouched.

Additional current-rule lost-reply restart, permanent cancellation and opaque legacy owner-missing
cases pass for both accounts. Canonical suite23/23; final affected extension suite65/65,0 skipped,
10.4s, accounting-hazards/.extension-milestone-qualified.tmp. Current runtime hashes remain the
independently reviewed pending18c01b1d and background2093a89b. Independent bounded extension milestone review PASS: no remaining demonstrated must-fix. The
reviewer decoded both outcome attachments and verified exact tested runtime hashes, original
command bytes and the final app physical identity/time facts. This is not a full-candidate review. No application runtime source changed since storage/source checkpointf2b5377;
its frozen188/188 SDK evidence is reused, not rerun without cause.

### Thread handoff — owner requested a milestone, 2026-10-30

Historical checkpoint: superseded by "Resumed qualification / acceptance conflict" below.
Current TASKS status is blocked and the newer changes are preserved uncommitted; do not resume the
older codex instruction without resolving the newer acceptance blocker.

Use the exact local commit containing this section on branch task-039-unified-accounting in
.worktrees/task-039-unknown-resolution. TASKS.md remains codex: this is a paused thread boundary,
not a completed task or release candidate. HANDOFF.md at root is stale automation context; this
consolidated record is the current TASK-039 handoff. Read CODEMAP, this record, the owner-direct
unified entry in TASKS and TASK_039_ACCOUNTING_CONTRACT.md; resume the same authorized project.
Do not discard the local source, reports, earlier failure evidence or preserved archives.

Remaining implementation/qualification order:
1. Close historical-code extension upgrade, remaining capture/seal/ACK/cache kill points and
   mixed app/extension stale replay/tombstone proofs. Current candidate version upgrade is only
   one covered lifecycle, not evidence that every old installed queue is migratable.
2. Map EVERY WRITER_COMPATIBILITY inventory row to actual integrated-source evidence; fill missing
   real-SDK manual/merged/midnight/delayed-delete/bulk-maintenance/Away/dispatcher coverage. Make
   only necessary contract-authorized repairs, with failing regressions first.
3. Audit once-only runtime materialization, especially native scheduling after receipt/handler
   interruption; prove crash repair for G6/G7. Do not change sw/HUD/Android/backend architecture.
4. Complete physical/tombstone mutation, authorization/Action API/Functions compatibility and
   UNKNOWN overwrite/cancellation matrices; preserve the historical Bob unresolved blocker.
5. Complete required npm/original F1–F7/account/Focus/browser checks, governed generation,
   extension release version, generated www closure/parity and package exclusions, then obtain
   independent review of the EXACT complete integrated candidate. No partial-deployment activation.

| Gate | Status at thread checkpoint | Remaining boundary |
| --- | --- | --- |
| G1 capture/interruption | PARTIAL / NOT PASSED | Six native/Focus assertions repaired; frozen SDK308/308 passes. Complete all-writer kill/quota/size matrix remains. |
| G2 time preservation | NOT PASSED in full | Authorized cursor corrections and frozen app188 pass; every inventoried writer's complete matrix remains. |
| G3 physical/tombstones | PARTIAL / NOT PASSED | Both-account physical-key/Delete/Undo regressions pass in final SDK; full alias/tombstone/concurrency matrix remains incomplete. |
| G4 authorization/atomicity | PARTIAL / NOT PASSED | Existing ownership/stale-write guards preserved; invalid Focus identity refused through reconnect. Full supported-operation/atomicity matrix remains. |
| G5 UNKNOWN/cancellation | NOT PASSED in full | Exact retry/lost reply/permanent fence probes pass; complete later-overwrite/day-delay/lost-cancel matrix remains. |
| G6 once-only apply/listeners | NOT PASSED in full | App capture/lease/read-model proofs pass; runtime effect and mid-cache crash repair qualification remains. |
| G7 automatic/native/multistore | PARTIAL / NOT PASSED | Native readback and Focus AutoStart assertions pass on final source; bounded source review approved. Full multistore matrix and historical Bob uncertainty remain. |
| G8 bootstrap/legacy/extension | PARTIAL / NOT PASSED | Earlier bounded MV3 evidence retained; Focus V1 covers retained legacy bytes. Complete historical-package upgrade/installed-writer/cutover census remains unrun. |
| G9 behavior/artifact | NOT PASSED | Full required suites, generated packaging/parity/exclusions and exact integrated-candidate review remain. |

No full npm/QA/SELF_REVIEW completion is claimed at this intermediate milestone. No phone testing,
Guardian or production access occurred. Existing local main/PR20/gateway task refs are preserved; this task advances only its own branch.
The shared repository now has origin/main (and symbolic origin/HEAD) atf73edd4 versus the initial
a9e22af, plus the previously recorded additional OAuth refs. This task issued no fetch/push or
remote-ref mutation and leaves those external changes untouched. All prior and current failures remain in local evidence.

Release strategy stays Path A with release held. Next thread needs only the owner's instruction to
resume this already-authorized LOCAL project; no new implementation scope approval is needed.
Production/cutover/phone authorization is not requested or implied. STOP for the existing approved
architecture/mathematics/security/scope conditions. Historical Bob remains unresolved.
Guardian NOT RUN / NOT PASSED. Production NO-GO.

Verified precommit extension/source/evidence preservation: C:\Users\Admin\Desktop\Vibe code\Time audit app\.worktrees\task-039-preserved-local\extension-reviewed-thread-checkpoint-20261030T145457657104Z.zip
SHA256 9b78a82bc5416f094062f9d387fd3945b61ac12a7bef5b3283bfbada04ab5674;192 files, manifest/readback verified.

## Resumed qualification / acceptance conflict — October 30, 2026 (Phoenix)

Resumed clean at owner-specified ed7fedca4d1f83ace0be8b0c990e6d96ffd598df, same worktree and branch.
TASKS is now **blocked**, not review. Changes remain uncommitted because the required acceptance/QA
gate fails. No later task, commit, push, merge, deployment, production access or phone testing occurred.

### Demonstrated repairs and bounded qualification

- A delayed extension response acknowledged across attachment changes: 0/2 before, 2/2 after.
  The old operation remains pending in its own partition; a fresh attachment confirms all original
  postimages without another write. Transport and outbox both recheck the attachment after response.
- Independent review found malformed original revision provenance accepted by the resolver/core,
  stale timezone results crossing same-owner reattachment, and invisible device-unbound captures.
  Failing regressions were retained, then repaired. Complete historical stamps remain recognized;
  malformed baseExists/baseRevision/operationId are refused rather than normalized. Timezone cache
  commits use the existing authentication lock and generation guards. Existing badge/title exposes
  generic unbound retention without assigning or revealing the old source to a current account.
- Extension command process-kill matrix:16/16, both accounts, after capture/import/intake removal/
  seal/ETag/pending/server commit/accepted save. Abrupt self-SIGKILL avoids a Windows Node graceful-exit
  libuv assertion. One-day recovery keeps original fact/command/ETag and exactly one accepted write.
- Expanded isolated extension/core/historical-TimeAck/idle matrix:174/174. Canonical extension
  cases include later manual edits/tombstones, lost-reply evidence overwritten, and concurrent app
  alias creation: retained original commands, no rebase or resurrection. This total includes
  historical TimeAck cases; it is not174 current-rule command-operation proofs.
- Actual bounded MV3 matrix:4/4. Historical73739e9 queue survives profile/candidate upgrade unmodified
  and remains visible/unpublished with unproven ownership; current candidate process-kill/restart/
  version-upgrade plus actual app SDK Delete/Undo also passes both accounts. Chromium reused old
  unpacked worker graphs despite reporting a new manifest; the historical proof uses a pinned
  extension ID and test-specific URLs for the candidate's three modules to force code evaluation.
  This is an actual isolated MV3 profile test with disclosed instrumentation, not a store-installed
  historical-package upgrade or a live installed-client census.
- Missing writer subset:20/20 actual SDK checks cover manual form, retro midnight splits, merged
  edit, Delete, all three bulk clears, metadata repair and Away start/end. Each checks unchanged
  committed frame until ACK, exact physical/postimage facts and once-only reload recovery. Initial
  15/20 run is retained: form setup could be reset before invocation (trace shows validation toast),
  and the old Away record has no away:true flag. Setup now supplies fields in the same invocation;
  the original time/key/ACK/reload assertions remain. This is not every inventory row's full matrix.
- Native scheduling crash repair reproduced0/2: an accepted Start interrupted at compatibility
  materialization never scheduled on restore. The accepted Stop equivalent also needed cancellation
  even when interrupted live globals already looked idle. Native scheduling now projects only the
  canonical committed frame, after recovery invalidation and before the Focus early return.
  One volatile key and one Promise tail serialize cancel/schedule/follow-up. Owner/attachment,
  immutable due endpoint, provider readiness and captured quiet lineage survive repair; pending
  Stop cannot change the prior committed native state. Independent review caught and verified the
  pending-Stop, quiet guard-lineage and recovery-order corrections. Native/notification checks29/29;
  actual SDK/provider Start/Stop/initialization/reload cases6/6. No Android/native/sw/backend edits.
- Full frozen app SDK matrix:213/214,0 skipped/0 flaky,508.7s. The failure is Bob Focus readback
  capture at endWorkSession's awaited browser Promise. Its existing V8/DevTools retention issue was
  previously documented at the storage milestone. That test now retains the one original Promise
  and polls its result without resubmission; all four Focus quota/readback cases pass in the final
  six-case run. No214/214 rerun is claimed, and the final index generation-token-only delta is newer
  than that broad manifest. Final six-case run also proves the original offline Start retention.
- Complete current-rule mutation plus pinned historical external-writer counterexamples:47/47.
  The historical syncEntries counterexample now loads exact021d1ee function bytes and historical
  canonical rules, instead of incorrectly treating migrated current source as the old writer.
  Calendar-barrier owner audit26/26 now uses valid staged protected writes and adds explicit legacy
  refusal/entry-leaf/redemption-parent assertions. Canonical rules and builder themselves unchanged.

### Packaging and scope interpretation

Local packaging now has a101-file byte-identical generated www closure, no missing dependencies,
and no dev leak. Governed group plus coordinator/resolver use20261030-task039-unified-accounting-v1;
extension manifest is1.1. Runtime capability still defaults to refusal, and no release activation
or partial-deployment claim is made. Existing mirrors were regenerated by the standard tool only.

The required pure resolver was rejected by the packager's blanket extension-directory exclusion.
Root DECISIONS §23 / D-002 explicitly makes a necessary small extra file touch advisory, not a
blocker. That specific approved decision resolves the apparent conflict with the task file list:
scripts/runtime-mirror.mjs has one exact-path exception, with affected tests. All other extension
paths stay forbidden, including a forbidden transitive import from the allowed resolver. Independent
packaging review passes; record this dependency touch for the eventual full reviewer. Mirror+owner
rule review43/43, no capability activation. No resolver duplication, hidden load or broad allowlist.

### Blocking acceptance contradiction — do not waive

Original daily-use F1–F3 call goOffline() BEFORE startThenTerminate()/missedPingThenTerminate(),
whose startTimer() requires _startTimer() === true. F2 additionally requires an offline exit to
have committed its log before reconnect. C5 explicitly requires committed running/cursor/entries/
Undo/heartbeat effects to stay unchanged before ACK. G9 simultaneously requires the original cases.
Those observable behaviors cannot both be satisfied. The earlier documented mathematics exception
does not authorize overriding this acknowledgement/behavior contract.

The original seven assertions remain unchanged. Their test fixture now supplies the current staged
transport rather than only the quarantined Undo engine, retains its offline refusal and records
accepted local publications in the existing audit. Established prior history is seeded remotely,
and the retro helper awaits the actual command. F4–F7 pass4/4; F1–F3 fail3/3 at the exact offline
Start success precondition. No fake offline acknowledgement, expected-failure annotation, test skip
or relaxed assertion was added. Independent review confirms this is an acceptance-contract blocker.

Both-account actual SDK proof passes: C5 offline Start retains its original T0 invocation and full
input across reload45 minutes later, leaves committed running/cursor/Undo unchanged, then applies
the original T0 anchor exactly once after connection. It fabricates no entry. This establishes
retention under C5, not compliance with the contradictory original offline success requirement.

Required npm test was run and its failures retained. Initial sandbox EPERM was rerun with process
permission. Packaging failures were corrected, then the stale unstamped owner audit corrected.
Latest npm reaches entry-validation.test.js and fails32/32 because its source extractor removes
async from now-asynchronous applyAutoTemplateEntries, producing an await syntax error. Later npm
commands therefore did not run. This fixture migration remains undone at the contract STOP; no
full npm PASS, full QA or production-commit approval is claimed.

### Remaining gates and next permitted action

G1–G8 remain PARTIAL / NOT PASSED in full: the above narrower proofs do not replace complete
all-writer inventory mapping, full size/schema/quota and mixed-generation matrices, Functions/
Action API compatibility, complete cancellation/overwrite matrix or external installed-writer census.
G9 is FAILED / BLOCKED. Historical Bob data-safety uncertainty remains unresolved. Guardian
NOT RUN / NOT PASSED; phone testing unrun by owner constraint; production NO-GO.

Obtain an owner/Claude acceptance decision reconciling C5 with original offline F1–F3 before further
implementation. Then resume this preserved working tree, finish fixture migration and the remaining
local matrices, rerun the exact complete candidate, and obtain full independent review. Do not
discard pending work or weaken server gates to force old behavior. No release authorization is requested.

Machine-readable resumed reports/source hashes and compressed original failures/passes are in
accounting-hazards/resume-qualification-evidence.json and evidence/resume-20261030/.
The initial HEAD remains ed7fedca; main0e04ebb and origin/mainf73edd4 were read only, not modified.
## O1 approval and implementation — October 30, 2026

The owner explicitly approved O1 and resumed LOCAL work in this same project. The earlier C5/offline
acceptance blocker is resolved by that approval, not by waiving failed tests. Effective amendment:
TASK_039_ACCOUNTING_CONTRACT.md § O1. Original F1–F3 and their failures remain preserved; F1-O1–F3-O1
will be distinct acceptance cases. The 32 fixture errors remain a separate maintenance issue.
Before any O1 source change, all299 preserved files and the final archive were re-read and hash-verified:
resume-c5-blocked-final-20261030T214208586969Z.zip,
SHA2563a660412ea9b662bd6ef7f47c3b5dc3062bac09659651725bb6f7cec6f9709f5.
Plan: retain provisional ordinary state through the existing account envelope/captures; verify
offline Start/Stop/recovery and exclusion; repair fixture maintenance separately; qualify G1–G9
and obtain independent exact-source review. No release activation or external access authorized.
## O1 implementation / new Focus acceptance boundary — October 30, 2026

The approved O1 implementation is preserved locally. No further product implementation follows the
new material authority/acceptance boundary below. HEAD remains ed7fedca; newer source is uncommitted.

Ordinary Start/Stop and their recovery now capture immutable original before/after facts, operation
identity, invocation and causal parent through the existing coordinator intake. A separate selector
drives a labelled provisional timer and pending interval surface. Provisional entries never enter
confirmed globals, totals, CSV, Undo or completion effects. Typed recovery reuses unchanged draftPing:
nonexpired recovery preserves the original phase, while expired recovery freezes its original event.
Expiry is frozen when the recovery prompt is created, including delayed choice and ACK transfer.
The original doPing guard, rounding and task accounting anchors remain. No backend/Android/HUD/SW
architecture, rules activation, historical rewrite or general timer-engine redesign was introduced.

Local heartbeat facts are captured/read back before awaiting the same account lock. Restore includes
those durable unimported observations; source IDs, rather than timestamp coincidence, establish the
session lineage. Check now resumes a paused producer only after the original failed observations
are retained. An applied canonical generation or existing proven provisional lineage permits narrow
offline continuation without realtime listeners; exact original server guards still control sending.
Capture/readback failures return false and retain original page-held facts, without crash-durability
claims for refused storage. UNKNOWN, backward-clock and peer conflicts retain their original input.
Late ACK cannot restart an already captured Stop or clear the next session's heartbeat.

Independent bounded reviews found and verified repairs for unimported heartbeat loss, stranded
recovery after Start ACK, missing pending interval display, heartbeat pause after successful recovery,
native projection before recovery transfer, and delayed-choice expiry recomputation. Original-fact
accidental recovery itself received a failing0/4 baseline before typed recovery was added. The final
affected expiry/capture/versioned acceptance batch passes14/14. Full frozen verification follows;
these are bounded proofs, not a full gate PASS. All intermediate reports remain retained.

The separate entry-validation fixture migration preserves async declarations and awaits actual
producers through an explicit domain ACK seam. All original behavioral assertion values remain.
Three listener/source-write cases are explicitly historical: exact73739e9 listener and021d1ee
syncEntries bytes; a separate current-listener refusal case is added. Independent audit and run:
33/33 pass. This is not33 current coordinator/SDK proofs. The governed-generation fixture now names
the O1 generation and retires prior tokens. package.json adds the coordinator and resolver to the
existing lint list after npm exposed that omission. This narrow packaging/test dependency touch is
recorded for review under DECISIONS §23/D-002; no runtime exemption or assertion was weakened.

### Newly demonstrated STOP: original Focus acceptance is outside O1

An independent read-only audit of tests/focus-reload-recovery.spec.js finds fourteen cases whose
outcomes can be qualified with lawful stateful fixtures and awaited producers, plus twelve cases
containing legacy authority/reconciliation expectations requiring explicit disposition:

- The count-clamp case injects a cache-only work session with ownerDeviceId:null and count999999999,
  then demands confirmed active work/count720. The approved contract makes that unproven source
  recoverable evidence, not authority to activate an owned Focus session. Adopting it would cross
  the ownership/acknowledgement boundary. O1 applies to ordinary Start/Stop/recovery, not this adoption.
- The corrupt-source case expects removal of its original key. Current code retains those exact
  bytes and blocks. Durable quarantine elsewhere before canonical cache repair could retain data,
  but simple deletion is not permitted and no such change is silently selected here.
- Direct unstamped applyRemoteTimerState payloads demand synchronous ownership decisions and old
  one-shot reconciliation flags. Current code requests a coherent read. Some genuine peer outcomes
  can be tested with lawful commands, but the old flags/raw-payload authority are distinct demands.
  One case assumes a stateless server forgets the winning peer on reload; a durable server should
  retain that peer. Focus rejection of newer generic sources also needs an explicit policy decision.

The original26-case file and all its assertions remain untouched. A single unchanged regression
baseline fails because its old fixture neither awaits acceptance nor provides the staged transport;
that failure alone is not a product verdict. Separate actual-SDK/coherent-state counterexamples in
tests/accounting-focus-acceptance-boundary.spec.js preserve the original count/activation and key
removal expectations and fail0/4, both accounts. Their attached raw bytes, queues and confirmed
states demonstrate the new boundary without stateless-stub or missing-transport ambiguity. No skip,
expected-failure annotation, mocked owner authority or historical-runtime PASS substitutes for it.

Next owner decision: explicitly choose a bounded Focus acceptance amendment preserving C1/C5
retention and coherent confirmed authority, with versioned replacements for the twelve legacy cases
and unchanged historical assertions/evidence; or request a separately reviewed Focus authority
design. Fourteen compatible cases can then receive fixture migration without weakened outcomes.
No weaker ownership, timestamp-only replay authority or ownerless adoption is recommended or authorized.
This is the same TASK-039 project, not a new task or a release request. G1–G9 remain incomplete;
historical Bob uncertainty remains. Guardian NOT RUN / NOT PASSED; production NO-GO.
### Frozen verification and independent verdict — O1 blocked checkpoint

Actual final source: index SHA256 a148a07db7b9b80581675edde107ce631a289db287587b88d9b5c762ee719eca;
coordinator e5fc9406be2b5b3cc2b184d807181db71bbf0ebbab54cd522bfe68873da5641b;
storage fc122413c9d669565eff13ee047460b4c8b9ac3fbf5828923275877886080099.
Frozen manifest SHA2567685e12d4c5bb16cd3cfbbacf9e471cf48ec0d8ba8b17dabbcdd5cecd2a39cfe:
101 runtime files plus live-pinned test specification/rules,103 unique source hashes. Every worker
uses that same immutable runtime fixture, and all live pinned sources were rechecked unchanged.
The initial copy command printed102 paths because sw.js appeared twice; there are101 unique files.

| Verification | Actual result / scope |
| --- | --- |
| F1-O1 | Alice/Bob2/2 pass in the frozen full run. |
| F2-O1 | Alice/Bob2/2 pass in the frozen full run. |
| F3-O1 | Alice/Bob2/2 pass in the frozen full run. |
| Full real-SDK accounting matrix | 251 passed,9 failed,0 skipped/0 flaky;606.3s. NOT a full PASS. |
| Isolated12-file accounting/extension/rules/historical matrix | 252/252 pass,0 skipped. Includes prototypes, historical TimeAck/writer counterexamples; not252 current-rule operation proofs. |
| Actual isolated MV3 candidate/historical lifecycle | 4/4 pass,0 skipped/flaky. Existing test-specific historical module URLs remain disclosed; no installed-store census claim. |
| Required npm test | PASS, process exit0. This package runs Node suites, not all Playwright browser acceptance. No full browser/QA PASS inferred. |
| Lint | Exit0;0 errors,153 warnings. |
| Packaging/static | www101 byte-identical closure, rules match builder; all3 actual executable inline script elements parse. |
| Original F1–F7, assertions unchanged | 4 pass/3 fail; F1–F3 remain failed, F4–F7 pass. O1 acceptance is separately versioned; originals are never relabelled passes. |
| Original Focus26 | Unchanged. One old asynchronous/stateless-fixture baseline fails; full original suite not qualified. Independent authority audit and actual-SDK boundary counterexamples0/4 remain. |
| Independent exact-source review | NOT APPROVED. Independent coordinator51/native projection12/domain+historical fixture33 checks pass96/96; full report inspected, not independently rerun. |

Six full-SDK failures are assertion failures, not presumed infrastructure:
- Both-account native request readback and native result readback each expect true but return false.
- Both-account Focus AutoStart readback phase expects1793203560000 but observes1793203260000.
Three additional failures report destroyed browser execution contexts: both Learning outcome cases
and Bob's pending mid-block Switch. Their cause is unproven in this frozen run. Previous V8 issues
are not substituted for diagnosis, and historical Bob uncertainty is still not closed.

Independent actual-Chromium visual review finds the new provisional panel uses undefined --accent
and --surface variables: computed background is transparent and border absent. It overlaps the
opaque higher-layer accounting banner, obscuring pending facts at mobile and desktop widths.
This is an O1 must-fix, not a passed visual check. Review also finds the prior detached-start tail
in _startTimer is unreachable after the new ordinary routing. SELF_REVIEW and complete QA are
therefore NOT PASSED. These issues and all six assertions remain open at the material Focus STOP;
the Focus decision does not waive them or authorize their tests to be weakened.

The earlier broad diagnostic run was234 passes/2 browser evaluation errors. Source/test changes
between restarted workers mean it is not one exact-candidate qualification. Its reports/traces
remain retained separately. Subsequent narrow retained-Promise harness checks6/6 pass without
resubmission or weakened accounting assertions. Only the later frozen run above is the full exact
snapshot result. Temporary Windows config and regex script-extraction setup errors were corrected;
they are harness diagnostics, not candidate failures or qualifying passes. The proper inert-HTML
script parser, mirror check, builder check and manifest check all pass on the frozen source.

No commit is made because the required acceptance/QA gate is failed. TASKS remains blocked. The
verified preservation archive and machine-readable o1-qualification-evidence.json identify this
uncommitted local checkpoint on ed7fedca. No push, merge, deployment, production access/rule change
or phone testing occurred. Guardian NOT RUN / NOT PASSED; production NO-GO.

## Focus authority acceptance V1 — October 31, 2026, bounded local closure

The owner's current-session amendment resolves the October30 Focus acceptance STOP above. The
versioned contract appendix changes only those contradictory legacy ownership/raw-payload/cache
expectations. This is the same TASK-039 project and branch, not another architecture or release.
The active unified entry remains `blocked` for its previously incomplete overall G1–G9 contract;
the bounded amendment itself has no remaining implementation or independent-review must-fix.

Before mutation,146 dirty/untracked files were archived and re-read/hash-verified in
`accounting-hazards/evidence/focus-authority-v1-20261031/before.zip`, SHA256
b2ee0af94736bb42f20dcca052a5449ab1c1d90befc85dc843b610fb320589ab.
HEAD remains ed7fedca on task-039-unified-accounting; changes remain uncommitted locally.

### Recovery authority and necessary repairs

- Authenticated coherent Focus restores through the existing canonical accounting projection.
  Durable provisional Focus sources require the original account/device/schema/session anchors and
  causal lease. Confirmed and provisional states remain separate; no new optimistic accounting,
  formulas, backend, timer engine, cancellation or ownership exception was introduced.
- `retainUnconfirmedCompatibilityCaches` preserves the exact Focus source key even for malformed
  JSON, null/false/zero/string/empty-array/empty-object payloads. Local Focus compatibility images
  compare exactly; Firebase wire equality itself is unchanged. `persistFocusSession` cannot delete
  or replace retained-unproven originals. Legacy evidence cannot block coherent server hydration.
- `renderFocusRecoveryStatus` clearly labels confirmed, provisional and retained-unproven recovery.
  The ordinary provisional panel and accounting banner now stack with existing opaque theme colors.
  Actual Chromium390px/1280px screenshots and element hit checks confirm readable, separate panels;
  this is not real-device or phone acceptance.
- Six assertions were independently understood and reproduced: temporary native/Focus intake
  read failures caused the ordinary selector to permanently label the source unreadable. Coordinator
  `readStored` identifies storage access exceptions; temporary reads pause/retry, while invalid
  data still fails closed. Focus restore uses the same distinction. Existing event facts/IDs/times,
  query ranges, AutoStart configuration and exact retries remain original.
- Independent review additionally exposed an invalid captured session that could remain paused
  offline but publish after reconnect. Both-account failure was reproduced4pass/2fail. Shared
  `validateAccountingFrame` now verifies Focus phase/session-anchor agreement before sealing and
  application; adoption reuses that validator. Final independent reconnect checks pass6/6.
- `_startTimer`'s earlier ordinary routing covers every inactive state; the later active-state path
  always switches. Its orphaned detached-start tail was unreachable and is removed. The shared
  runtime-start helper remains referenced by ordinary capture and existing callers.

### Browser-context diagnosis, without an invented app-defect verdict

Independent protocol diagnostics reproduced CDP `-32000: Promise was collected` for Bob's
`stopAndLog` and Alice's `endWorkSession`. Playwright rewrites it as execution-context destruction.
The same frame/URL continued with no navigation/crash. Bob's original Learning trace has the same
failure site and stable frame, but its underlying original CDP error was not recorded; the shared
cause remains an explicit inference. Neither an app defect nor a historical Bob safety waiver is
inferred from these errors. The two affected test flows retain their single invoked Promise and
poll its exact true result; accounting assertions are unchanged. Repeated affected checks12/12 pass.
Sanitized protocol evidence and trace hashes: `context-diagnosis.json` and adjacent raw-error files.

### Exact-source verification

Final frozen manifest SHA256
b6a4b7f7b717f1cb4f60f67b1c6709f3dab22e31090ccc2170cc182b4c4619d5:
101 unique runtime files plus rules and both test sources,104 hashes. Final live sources were
rechecked against every frozen hash. Governed generation:20261031-task039-focus-authority-v1.

| Check | Actual result and limit |
| --- | --- |
| Original six assertions/context reproduction |5passed/7failed of12: six assertions plus Bob Switch context error; original evidence preserved. |
| Focused native/Focus readback+quota after repair |12/12 pass. |
| Repeated Learning/Switch retained-Promise checks |12/12 pass; single producer invocation, original result assertions. |
| Versioned authority focused |46/46 pass before the additional sealing guard; final ten invalid-reconnect/FA4 cases pass10/10 afterward. |
| Final frozen real-SDK accounting plus Focus V1 |308/308 pass,0skips/0flaky,600.8s;260 accounting plus48 versioned Focus/visual cases. |
| F1-O1/F2-O1/F3-O1 in final full run |2/2 each,6/6 total, both accounts. |
| Final independent checks |63 Node +6 real-SDK reconnect checks pass69/69. Earlier independent28+63 belongs to its explicitly recorded preceding snapshot. |
| Required npm test |PASS, exit0. Current package runs Node suites; no full app Playwright PASS is claimed. Coverage not measured. |
| Static/artifacts/lint |3 executable inline scripts parse;101 www mirrors byte-identical; rules match builder and unchanged within this amendment; lint0errors/160warnings. |
| Independent exact-source review |APPROVED for the bounded amendment, no remaining must-fix; not a whole-integration/release approval. |

Original `tests/focus-reload-recovery.spec.js`26 assertions and original boundary counterexamples
remain unchanged. The versioned file explicitly maps all12 superseded expectations and reasons.
Their old failures remain failures, not renamed passes. Original Focus26 is not newly qualified by
this matrix. Early versioned fixture mistakes (missing autoStart and an overbroad queue comparison),
then discovered empty-array retention and invalid-session reconnect failures, all remain in their
separate reports; only the final frozen report is claimed as full candidate-runtime evidence.

Evidence: `accounting-hazards/evidence/focus-authority-v1-20261031/qualification.json`,
`source-manifest.json`, `sdk-full.json`, `npm-test.log`, `static-qa.json` and
`independent-final-review.json`. Source hashes reviewed: index
dbad24eb42d5feb5e4a3bb8789b635fa4c15735be6856cef6169fb818a82c6f9;
coordinator9639508e3b660b0fe7fe45d8754a5a2780b294a9e93663d0055128d692ff1a39;
Focus7c36583281ea4673325bb71a6bfcd88d82ca2b404880d5cac655b087d92a13c1.

Code health and affected AI-verifiable QA for this bounded amendment pass. The overall ship
question remains NO: all-writer/interruption/size/schema, physical/atomicity, listener/multistore,
legacy/cutover qualification and historical Bob uncertainty remain incomplete as the ledger states.
No complete G1–G9 or full integration QA PASS is inferred. No commit, push, merge, deployment,
production access, production-rule change or phone testing occurred. Release **NO-GO**.
Guardian **NOT RUN / NOT PASSED**. Stop here; no automatic expansion or new project.

## Qualification and release closure - owner resumed October31

Phase1: all104 reviewed source/test/rule hashes matched; local preservation commit b5dfe0f.
No push or merge. Prior exact308/308/O1 and npm evidence retained in that commit.
The original evidence whitespace (verbatim diff/plaintext captures) is preserved; executable source
checks are separate from archival evidence whitespace exceptions.

Phase2 audit: accounting-hazards/evidence/qualification-closure-20261031/gate-scenarios.json
records each mandatory gate clause, exact missing producer/kill/alias/atomicity/lens/capacity cases,
evidence scope and external blockers. It distinguishes superseded O1/Focus expectations, prototype
controls and new current failures. Both historical Bob scheduled and original Bob Learning
uncertainties stay documented. All gates remain unclosed pending this ledger; no implied PASS.

Phase3 initial missing checks: original mandatory SDK43 ->34pass/9fail, original affected browser42
->15pass/27fail. These include old unstamped allow assumptions and missing staged fixture transport,
not automatically27 or9 app defects. Exact outputs preserved. New actual SDK no-envelope offline
bootstrap14 ->4pass/10fail confirmed legacy timer/Away/Break/entries/redemptions were exposed as
confirmed before coherent authority; first repair14/14 passes. Storage read/schema fault extension
then2pass/8fail exposed confirmed-array leakage and an overly strict transient-error fixture
assertion; repaired exact read/schema branch and explicit retained-readback assertion24/24 passes.
Crossmode Start/deep-link controls pass4/4 without any corresponding product edit.

The bootstrap correction is within existing C1/C5/G8, independently assessed as no new policy or
architecture. Source originals are captured/read back before discarding their confirmed projection;
compatibility keys are held until a canonical local receipt, and opaque Focus originals retain their
separate FocusV1 protection. Confirmed fields stay blank on failed storage/unknown schema.
Current Web Lock absent/refused4/4 and two distinct scheduled-date cases2/2 pass. The initial2032
capacity attempt used a Save without reopening Quick Log and hit its existing busy guard; that
fixture result remains, with the actual repeated UI-opening flow now under qualification.

G8 installed-writer census/live cutover and G9 Guardian/phone are external NOT RUN under the owner
constraints. Production NO-GO; Guardian NOT RUN / NOT PASSED.

### Local qualification handoff checkpoint — November 1, 2026

The integrated candidate remained byte-frozen at manifest SHA256
`6a04def40dfc08c8b88aacb8e42c7557a89c0cda849f83017bf7bcea329e978a` (101 runtime files,
706 verification files). The final integrated SDK attempt expected442 cases but stalled in the
capacity-and-interval test area. Its JSON reporter remained empty; the runner was interrupted with
exit1 after no result-directory progress for several hours. Thirty result directories existed, but
that is not a completed-test count. No integrated pass/fail totals or app defect are inferred.
The interruption record is `final-integrated-sdk-v2-interrupted.json`. The separate focused
capacity-and-interval check remains4/4; it cannot substitute for the required full regression.

The final `npm test` command exited0. The independent exact-source review verified all101 runtime
hashes and706 verification-source hashes against the frozen manifest, and returned overall FAIL
because the full integrated suite is incomplete; see `independent-integrated-final.json`. The
bounded targeted evidence remains in the ledger. G1/G2 are PASS_BOUNDED on targeted evidence with
the final integrated run incomplete; G3–G6 PASS_BOUNDED; G7 FAIL on unresolved historical Bob
scheduled-event uncertainty; G8 FAIL pending installed-writer/queue census and cutover evidence;
G9 FAIL for incomplete full regression, with Guardian and phone NOT RUN. Exact superseded legacy
expectations, original Focus tests/failures, Bob Learning's inferred-only context diagnosis, and
Bob Scheduled's missing durable snapshot remain preserved.

**Handoff state:** TASK-039 is blocked at this local checkpoint. No push, merge, deployment,
production access, rule change or phone test occurred. Guardian remains NOT RUN / NOT PASSED and
production remains NO-GO. Next owner decision: authorize a future bounded read-only census of
installed writers and pending queues, without activating or changing anything; otherwise G8 stays
blocked. This decision does not erase the independent G7/G9 blockers.

### Sharded integrated qualification update — November 1, 2026

The frozen manifest above was retained. A deterministic 21-shard run completed all 442 mandatory
integrated Playwright cases with per-case 180s timeout, one worker, preflight title/count checks,
per-shard JSON/log/artifacts and exact manifest/runtime/verification hash checks before each shard.
Aggregate: 440 passed, 2 failed, 0 skipped, 0 timed out, 0 flaky. This completes the test run but not
qualification. It does not establish the cause of the earlier no-progress unsharded stall; resource
exhaustion was not demonstrated.

The two failures are retained. Bob's G3 numeric physical-source edit case failed once because the
expected local-applied history operation was absent during the assertion window, then passed 3/3 and
10/10 exact-manifest focused repeats; cause remains unresolved. Alice's pending short-Break rename-save
case failed 2/3 focused repeats with a Playwright execution-context-destroyed error at staging, before
the test's explicit reload; one repeat passed. The retained trace showed the same local frame/URL with
no recorded page crash/page error. This is an unresolved context-loss symptom, not a proven app or
harness root cause. No confirmed runtime defect or in-contract repair resulted.

The current scheduled replay through abort-window/template edit/reload, Learning finish/receipt and
midnight Focus cases passed for both Alice and Bob. Historical Bob Scheduled remains unresolved:
the original missing-record run has no durable snapshots, so record existence and recovery outcome
cannot be established. Bob Learning's original low-level CDP error is unavailable; common context
loss remains an inference. Current prevention results do not resolve the historical record state.

Updated G1-G9 disposition: G1/G2 and G4-G6 remain PASS_BOUNDED only; G3 is
FAIL_INTERMITTENT_CASE_UNRESOLVED; G7 remains FAIL on historical Bob Scheduled uncertainty; G8 stays
BLOCKED with census NOT RUN; G9 is FAIL with the completed 440/442 run and two retained failures.
Independent review of the completed integrated result is pending. Guardian remains NOT RUN / NOT
PASSED, phone testing remains unrun, and production remains NO-GO. The reconciliation and prepared,
unexecuted G8 plan are in
`accounting-hazards/evidence/qualification-shards-20261101/G1-G9-RECONCILIATION.md` and
`G8-READ-ONLY-CENSUS-PLAN.md` respectively. Runner, reports and traces are retained in the same
directory. No app/runtime code, candidate source, frozen manifest or gate-scenarios ledger was
changed.

### Generation-2 integrated qualification update - November 1, 2026

The integrated suite passed 442/442 on generation-2 manifest 8e3b1308. Runtime is unchanged. Current gate status is in `accounting-hazards/evidence/qualification-rerun-20261101/G1-G9-LEDGER.md`. G7, G8, Guardian and phone remain open; production remains NO-GO.

### Pre-release risk assessment - November 1, 2026

Owner-authorized G8 census ran on this PC's Chrome and Edge profiles, metadata only. Independent review found that shipped web and extension sources carry no accounting capability, so the packaged candidate sends no accounting writes and refuses other deliberate time actions; the 442/442 suite injects it. G7 has no concrete scheduled loss or duplication defect and awaits an owner risk decision. G8 stays blocked. Evidence: `accounting-hazards/evidence/pre-release-risk-20261101/`. Guardian NOT RUN / NOT PASSED; production NO-GO.

### Shipped web and Android capability update - November 2, 2026

Packaged web and Android bytes now provide accounting through the unchanged coordinator, with no injected transport. On frozen commit 456acec the mandatory suite passed 442/442 and the packaged release spec 62/62. Results, hashes and open items are in `accounting-hazards/evidence/shipped-capability-20261101/G1-G9-LEDGER.md`.

The wider Playwright suite was already failing at b729d47: 318 of 1,071 tests, and 314 on the candidate. See `accounting-hazards/evidence/shipped-capability-20261101/WIDER-SUITE-CLASSIFICATION.md`. G7 stays open, G8 is not passed, Guardian and phone are not run, and production stays NO-GO.
