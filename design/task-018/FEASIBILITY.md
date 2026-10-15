# TASK-018 — Technical feasibility, design only

2026-10-15. No implementation authorization, schema decision, production changes or real persistence proof.
All three prototypes use the same mock completion meaning. UI selection does not approve an architecture.
Starting point: [TASK_017_COMPLETION_DELETE_DESIGN.md](../../TASK_017_COMPLETION_DELETE_DESIGN.md).

## Current model: a real blocker exists

There is no general, confirmed-persistence historical completion operation to connect to these checkboxes today.
`PlanAuthority.updateItem` refuses ended targets. `completeCarryoverItem` permits only a constrained same-calendar-date
carryover, not completion of arbitrary old tasks. TASK-012's `planMutation('plan_set_completion')` mirrors that limit.

Setting `done: true, doneAt: now` on an old source is unsafe. `classifyOneOffActual` and `classifyItemActual` classify
that source as done, while Timeline, shared/Partner status and Intelligence also consume `done` directly. That can
claim the original day succeeded. Moving a task to today is a different explicit planning action, not a substitute
for reporting work completed earlier. The prototypes never use a hidden move to simulate a completion.

## Proposed fact contract — not yet an approved schema

An item-owned annotation on the original existing plan item remains the starting proposal:

```text
completionResolution: {
  date: owner's reported calendar completion date,
  timezone: frozen IANA timezone used for that report,
  recordedAt: when the assertion was entered,
  recordedBy: asserting actor/device
}
```

The original planned date/interval, item identity, provenance, `done` and `doneAt` remain intact. A date-only report
must not invent a completion instant or duration. Even a date overlapping the original operational interval does
not prove completion within that interval: show “completion date reported” where boundary order is ambiguous.
Validate a real date, frozen zone and nonfuture actual date. Actual completion and assertion time are different facts.

Active backlog discovery can exclude a valid resolution independently of the original day's classification. No
tracked entry, Ledger event, daily Review result, day-completion flag or streak credit should be generated.

This field alone is not a sufficient protocol. Expected revision, idempotency identity and correction/reversal
semantics remain to be designed and reviewed. They must belong to the same authoritative task, not a second task store.

## Required safety work before a production checkbox

| Boundary | Finding in current source | Required production work / release gate |
| --- | --- | --- |
| Exact authority | `plan-authority.js` owns target/source eligibility; legacy, operational and calendar stores coexist. | Narrow semantic historical-resolution operation. Bind room, store, target and item; reject unknown authority, stale/moved/deleted/dismissed/conflicted/already-resolved sources. Do not widen generic edit guards. |
| Confirmed persistence | `CalendarPlanLive.writePlanItems` writes local state and starts `sync.syncPlan` without awaiting it. Other legacy recovery routes also cannot be treated as confirmed cloud writes by their local return value. | Return an authoritative acknowledgement of the exact resolution. Keep the item pending in Unfinished until confirmed. Permission errors retain it; unknown acknowledgement must reconcile the same intent before retry. |
| Concurrency | Ordinary plan merge chooses whole items by relocation order, timestamp and deterministic tie-break. A later stale snapshot may omit an annotation. | Server-enforced revision comparison and idempotent replay. Same intent is a no-op; two different completion dates surface a conflict, not arbitrary last-writer-wins. Completion versus move/dismiss must share eligibility/concurrency protections. |
| Server representation | Ordinary items sit in id-sorted arrays; Brain Dump/API items are separate location-bound fence children. | Review both representations. Do not protect an array index as if it were stable task identity. Preserve origin/capture/action markers, recovery provenance and relocation authority. |
| Post-cutover history | Generated rules block ordinary writes to `plans` and `operationalPlans` once calendar authority exists. | A historical source in those stores cannot simply be patched. Define a narrow, reviewed existing-source resolution path/exception that preserves cutover protection. Do not bypass rules, mutate a today copy, or add another task store. |
| Old clients | Released cf43080 code and later clients may re-push whole plan records. Whole-item LWW is not monotonic resolution retention. | Prove stale replay cannot erase, contradict or resurrect a resolution. Choose a reviewed compatibility/version rejection strategy and test real released fixtures. A successful new-client write alone is insufficient. |
| Historical live updates | `CalendarPlanLive.liveDateKeys` subscribes to today/future dates, while older records hydrate without staying subscribed. | Bounded historical-source coverage for the displayed backlog and pending operations, with teardown/rebind and remote reconciliation; explicitly handle midnight and offline reopen. |
| Account isolation | Existing repositories/bridges guard room and listener generations. The mocks have no accounts. | Capture owner and generation at action start. Recheck before write, acknowledgement, error and Undo; cancel old account work and clear DOM/receipts on switch. Prove with two accounts and delayed callbacks. |
| Undo | TASK-017 Undo is session/local-observed-state dismissal recovery, not an unseen-remote CAS guarantee. | Completion reversal needs a new reviewed, conditional operation against the exact applied resolution. Never restore a whole pre-action item over an unseen edit or delete a resolution field opportunistically. Corrected/reversed state and remote propagation must be explicit. |
| Batch C | Mock batch applies all selected outcomes in memory and Undo restores that set. | Cross-source/store operations require per-item authoritative outcomes, partial-failure UI, independent retries and conditional reversals. Do not promise atomic all-or-nothing batch persistence without a proven protocol. |

## Exact consumers to audit in the future implementation design

- `stale-plan-recovery-model.js`: `itemIsRecoverable`, source/destination/conflict projections, recovery copy construction.
- `plan-authority.js`: stale discovery, `updateItem`, `saveItems`, `completeCarryoverItem`, `classifyItemActual`, recovery/move/
  dismiss paths and the proposed narrow resolution API. Completion must coexist with relocation and fenced identity.
- `plan-tomorrow-model.js`: `classifyOneOffActual`, `summarizeActual`, `reconciliationBucket`, merge/read/retention behavior.
- `index.html` named Today/Review/plan renderers; `tomorrow-timeline-model.js`, `tomorrow-view-ui.js`.
- `intelligence-read-model.js` / `intelligence-ui.js`, `shared-accountability-model.js`, `partner-view-model.js`:
  expose the resolution without converting original-day unknown/unfinished into original-day done.
- Calendar/operational/legacy models, repositories, sync/live layers and `storage.js`; `plan-item-origin.js`,
  `plan-fence-sync.js`; rules builder and generated rules; held old-client fixtures.
- `functions/src/plan-mutation-action.js`, envelope/read/revision helpers and their tests: existing writers must retain
  or refuse the new fact even if no new conversational command is added. Do not silently widen API completion semantics.
- Focus/Learning/Ledger linked-plan consumers: determine whether they consume `done` or completion classification;
  assert no new measured time or cross-domain completion is manufactured by this annotation.

This is a read-only audit map, not a production file-change manifest or an instruction to edit all listed files.

## TASK-016 and Brain Dump remain separate

`TASKS.md` records F-B: after a same-browser two-tab promotion race, a capture may retain an open claim while exactly
one `bdp1` item exists; reload recovery can leave it stuck, while a manual reconciler finalizes it. It reproduced
without the tray (3/240 at six workers). Shared-localStorage overwrite is suspected, not established. F-A is the
related misleading contention message; S3 is the tray's missing in-flight guard. These are existing issues, not fixed
or retested by these prototypes. TASK-016 is recorded as proposed, not authorized for implementation here.

Historical completion must not finalize, revoke or recreate a Brain Dump claim, change its generation, move a fenced
item, or turn a completion report into a new promotion. Preserve TASK-015 behavior. Before a future release, explicitly
test promoted/fenced items and recovery copies alongside these known reliability limitations. Resolving TASK-016 must
be a separate owner-authorized task; this design phase does not use it as an excuse to alter protected code.

## Minimum future test and rollout contract

After design selection and separate architecture/implementation authorization: deterministic validator/merge tests,
same-intent duplicates and conflicting dates, completion-versus-move/dismiss races, failed/unknown writes, old-client
replay, all three stores and both item representations, post-cutover historical sources, real RTDB emulator and two
SDK clients, account switches with delayed acknowledgements, historical listener convergence, untouched original-day
Review/Partner/Intelligence/streak/time evidence, and conditional Undo. Preserve baseline expected-failure records.
Any rules/client deployment sequence must be separately reviewed and authorized. No deployment is performed here.

**Feasibility verdict:** all three UIs are plausible; production completion and Undo are **not ready to wire up under
the current contract**. A is the smallest interaction slice, B adds client presentation state, C materially broadens
the persistence/error protocol. Design selection alone does not resolve any protected data-model blocker.
