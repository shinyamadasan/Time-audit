# TASK-018 — Implementation safety gate

2026-10-15. **BLOCKED before production implementation. Not REVIEW-READY.**

The owner's current instruction authorizes implementing Refined A. This stop is the result of its explicit
persistence safety gate, not a request for visual approval again. Refined A remains the approved visual direction.

## Verified base and preserved work

- Fetched `origin/main`: `bb171a287ac67d76ae27634b5227bc24f66919de`.
- `git merge-base HEAD origin/main` is that same SHA; no newer main commits were fetched.
- Approved design commit and current branch HEAD at audit start: `26e24b46214cf6ae12828d5bd8389171a5644b28`.
- The worktree was already dirty: `TASK_018_UX_PROPOSAL.html`, `design/task-018/A-refined.css` and
  `design/task-018/A-REFINEMENT.md`. Preserved without staging them into this audit checkpoint. The latter two
  contain the owner's later timeline-checkbox visual refinement. No reset, rebase or stash was performed.
- Original uncommitted proposal SHA256 remains
  `455a32329367119d64a62ad8837fb3a1eef8bad1d8ad80fcea111498c5095f86`.

## Specific blocker

The proposed item-owned annotation has **no proven server-enforced retention and transition protocol covering
all existing writers and all historical source stores**. Merely adding a field, awaiting a sync call, or adding
a new-client compare-and-set can report success and subsequently lose the completion fact.

1. **Ordinary pre-cutover history cannot currently accept the required write.**
   `PlanAuthority.recoverableDays()` includes legacy and operational tasks after calendar activation.
   `scripts/firebase-rules-builder.mjs` grants writes to `plans` and `operationalPlans` only while
   `calendarPlanAuthority` is absent. The original source is therefore discoverable but not remotely writable.
   This is the deliberate read-only cutover contract in DECISIONS #29. A server operation using the owner's
   token is subject to the same rules; an Admin bypass is not a remedy. Supporting those tasks needs a narrow
   resolution-only exception that cannot reopen historical planning or change authority routing.

2. **Stale writers can erase a confirmed completion.**
   `mergeCalendarPlanRecords`, `mergeDatePlans` and `mergeOperationalPlanRecords` choose a whole item using
   relocation order, timestamp and tie-break. An offline snapshot from before the completion, edited later,
   replaces the item including its annotation. This reproduced in current code and the released cf43080
   fixtures for all three stores. It is not blanket stripping of unknown fields: a stale snapshot never had
   that field. `mergeFencedItem` protects origin/generation/tombstones, then delegates to the same choice for
   same-generation live items. An additional reproduction confirms this loss for a fenced item.

   The offline rules interpreter also accepts an ordinary calendar record overwrite that removes the
   annotation. A successful new-client CAS cannot prevent a later authorized old write. Firebase ordinary
   items are arrays, so an index is not stable task identity when items reorder. DECISIONS #33 describes this
   identity problem; a per-index monotonic flag alone is insufficient.

3. **The existing local write return value is not proof of completion durability.**
   `CalendarPlanLive.writePlanItems()` writes locally, starts `sync.syncPlan()` and returns no acknowledgement.
   Its sync layer does expose transaction outcomes, but not an exact historical-resolution operation receipt.
   `saveItems()` and existing dismissal Undo cannot be presented as the owner's requested durable completion
   and concurrent-safe reversal. A timed-out pending write must be reconciled under the same operation identity;
   clearing an annotation or restoring a whole old item is not safe Undo.

4. **Historical records do not have the required continuous convergence.**
   `CalendarPlanLive.liveDateKeys()` excludes past dates; operational live subscriptions likewise follow live
   days. Hydration is not a continuous historical-source listener. Two already-running clients cannot be
   promised prompt completion/Undo convergence without bounded source subscriptions and account-generation
   teardown. Existing account-bound ordinary writes are useful foundations, not a proof of the new protocol.

These are remediable architecture gaps. They do not establish that the feature is impossible. They establish
why a UI-only slice, a calendar-only partial slice, or a new field using today's merges would fail this task.

## Completion truth and minimum contract required

Keep the original item, planned date/interval, `done`, `doneAt`, preparation, provenance and tracked entries.
An explicit reported calendar completion date and frozen IANA timezone must be distinct from when the report
was recorded. No exact completion time is inferred from date-only input. Today uses the current civil date;
Done earlier uses the owner's explicit valid nonfuture date. Overlapping operational intervals must not imply
a precise before/after boundary. No Review result, streak credit, timer entry or Ledger event is generated.

`TASK_017_COMPLETION_DELETE_DESIGN.md`'s `completionResolution { date, timezone, recordedAt, recordedBy }` is the
starting fact shape, **not a sufficient write protocol**. Before implementation, the protected contract needs:

- One canonical original source identity across store/target/item, without an array-position identity shortcut
  or a second task store; canonical moved copies and conflicts must be explicitly handled.
- An exact revision and operation identity bound to account/session, plus server-enforced conflict checks with
  completion, move, dismissal, edit and delete writers. Duplicate intent replays must reconcile the same result.
- Retention and conditional reversal semantics that remain monotonic under replay. Undo must name the applied
  resolution and refuse newer/conflicting state; it must not remove revision protection or restore an old item.
- A rules-enforced compatibility policy for stale writers, including whole-plan/collection writes and both
  fenced namespaces. If incompatible old writes are denied, define the affected scope, visible recovery of
  those devices' unsynced edits and release order. Do not silently choose a policy that can strand other edits.
- A narrow post-cutover historical-resolution exception preserving the original authority guard.
- Confirmed exact write/readback outcomes, recoverable unknown outcomes, bounded historical subscriptions,
  account-switch cancellation and two-real-SDK-client/emulator proof.

No new schema or protocol has been implemented or declared safe by this report. The next step is protected
contract review resolving stable identity, compatibility and the cutover exception, followed by emulator and
old-client replay proof. Then implement the approved UI and its operation together.

## Affected consumers and implementation boundary

The baseline still has `classifyOneOffActual` and `PlanAuthority.classifyItemActual` treating late `doneAt` as
original-day `done`; the backend `planMutation('plan_set_completion')` rejects arbitrary ended tasks and only
permits the constrained carryover exception. Do not widen those operations. The audit reproduces both the
backend refusal and the misleading original-day classification of a hypothetical late `done:true` write.

Annotation-only input preserves `not-done` in the original-day classifier, but `itemIsRecoverable` still includes
it. Backlog resolution therefore needs its own projection rather than changing historical `done`.
Timeline (`tomorrow-timeline-model.js`), Intelligence (`intelligence-read-model.js`), shared status
(`shared-accountability-model.js`) and Partner (`partner-view-model.js`) read `done` directly. Their eventual
resolution presentation must remain separate from old-day success. No claim is made that a new contract is
verified across these consumers; implementation has stopped before that work.

Exact future change map: Plan Authority/stale-recovery model; calendar/operational/legacy models, repositories,
live and sync bridges including `storage.js`; origin/fence sync; rules builder and generated rules; existing
backend readers/mutation writers; reconciliation/Today/Review/Timeline/Intelligence/shared/Partner projections;
then `planning-continuity-ui.js`/CSS, runtime wiring/generation and generated mirrors. Only layers proven
necessary should change. TASK-014 tracking, TASK-015 promotion behavior and TASK-016 remain outside the fix.

## Evidence and limits

Reproduce offline: `node design/task-018/audit-completion-safety.mjs`.

- **18 observations reproduced**, exit 0 with explicit `gate: BLOCKED`. This exit code means the current
  failure modes reproduced as expected, not that completion is safe or feature acceptance passed.
- All **14 released-fixture hashes** checked against its pinned cf43080 manifest, normalizing Windows CRLF
  as the repository's existing fixture test does.
- Rules observations use the existing `targaryen` offline interpreter, not the Firebase emulator. The sync
  acknowledgement example uses a synthetic failed sync result, not a network failure or two-client test.
- Existing focused baseline: `node --test calendar-plan-model.test.js calendar-plan-live.test.js
  calendar-plan-sync.test.js plan-authority-calendar.test.js plan-authority-fence.test.js firebase-rules.test.js`:
  **116 passed, 0 failed, 0 skipped**. These validate the current contract; they do not validate new completion.
- `check:firebase-rules`: matches builder. `check:www-parity`: all 92 runtime files byte-identical.
  `git diff --check`: passes.
- Initial audit needed local dependencies. Offline `npm ci` initially failed cached peer resolution; retry with
  `--offline --legacy-peer-deps --ignore-scripts --no-audit --no-fund` succeeded without lockfile changes.
  Early audit fixture issues (CRLF hash and operational wire key) were corrected before the final reproduction.
  Initial isolated Node tests could not spawn under the sandbox (`EPERM`); permission-approved retry passed.
- Full `npm test`, production browser suite, real completion/Undo, concurrency/unknown-write/account-switch
  acceptance, RTDB emulator/two-client tests and physical Android tests **not run**: there is no implementation
  candidate after this stop. No new production screenshots exist; earlier screenshots remain labelled mocks.
- Known TASK-015 contention/reconciliation issues, TASK-017 unseen-remote Undo limitations and legacy dismissal
  durability are unchanged. Existing expected-failure tests were not rerun, reclassified or claimed fixed.
- Production/runtime/rules/sync/backend/Brain Dump/Android files, live data and original history are unchanged.
  No merge, push or deployment.

## Independent review and delivery

Independent read-only source audit agrees with the stop: the missing all-store server representation and
compatibility protocol is a concrete blocker; an absent API alone would not justify it. Exact audit-checkpoint
review is requested after local commit. This is not a PASS verdict for an implementation.

This phase changes only `TASKS.md`, this report, the offline audit script, and append-only `CHANGELOG.md` /
`TEST_REPORT.md`. No implementation SHA is available. TASK-018 remains **blocked**, with Refined A frozen.
