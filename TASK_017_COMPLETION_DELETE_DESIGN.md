# TASK-017 — Historical Completed/Delete design

Design only, 2026-10-15. No semantics in this document are implemented or authorized by TASK-017.

### Model finding

The owning plan/target already records the original planned date/interval. `doneAt` can represent an actual instant
distinct from that date, and recovery copies link to their original source with `carriedFromId`/`carriedFromDayId`.
However this is **not sufficient for arbitrary late completion as currently interpreted**:

- `PlanAuthority.updateItem` refuses ended targets. `completeCarryoverItem` only permits an ended source whose own
  start still lands on today's calendar date; it is not a general historical completion API.
- `plan-tomorrow-model.classifyOneOffActual` distinguishes early completion but flattens later `doneAt` to `done`.
  `PlanAuthority.classifyItemActual` does the equivalent for operational intervals.
- Timeline, Intelligence, Partner/shared status and other consumers often read `done` directly. Merely widening
  the ended-day guard and setting `done:true, doneAt:now` would make the original day appear completed.
- TASK-012 server `planMutation('plan_set_completion')` mirrors the same constrained carryover exception, not
  arbitrary historical completion; `plan_delete` also refuses ended plans.

Existing **Move to today → mark done today** can already represent work explicitly completed today on a recovery
copy, preserving the unfinished original. It adds a recovery item to today's plan and should keep that exact UX
meaning. It cannot honestly backdate work completed yesterday, and should not become a hidden implementation
of a historical Completed button.

### Minimal proposed UX and facts

| Choice | Meaning | Original day | Actual completion |
| --- | --- | --- | --- |
| Completed | Owner asserts the task was finished, with an explicitly chosen date | Original planned date/schedule stays; label “Completed later · <date>” separately | Explicit date and frozen timezone; optional exact time must be a later scope |
| Not doing | Existing abandonment/backlog removal | Still planned and not completed; dismissal stamp retained | No completion fact or duration |
| Delete | Explicit accidental-entry removal using a preserved tombstone, subject to separate authorization | Show removal distinctly where historical plan/reconciliation needs it | No completion fact or duration; never delete linked logs/captures |

Recommended smallest truthful historical-completion extension: an optional **item-owned resolution annotation**,
`completionResolution: { date, timezone, recordedAt, recordedBy }`, on the existing original plan item, with no new
task store. The original `done`/`doneAt` and planned schedule remain unchanged. `date` is the owner-confirmed actual
calendar completion date, `timezone` is frozen at recording, and `recordedAt` is when that assertion was entered.
Do not fabricate an exact completion instant for date-only input. Validate real date/zone and refuse future dates;
when the selected date overlaps the original operational interval or extended item span, retain “completion date
reported” without asserting an exact before/after boundary. “Completed later” requires an unambiguous later date.
Do not change an entire day's completion, streak, tracked minutes or Review evidence to manufacture a result.

This is a **new historical resolution semantic and item field**. It requires separate owner approval, architecture
review, version compatibility/rules validation review, and rollout design before implementation. It is not a
workaround permitted by TASK-017's no-schema/no-protected-changes constraints.

### Exact proposed follow-up changes

1. `stale-plan-recovery-model.js`: recognize an explicit completion resolution as resolved for active backlog,
   independent of `done`; pure validator/normalizer and display projection. Retain the original item and provenance.
2. `plan-authority.js`: a narrow `resolveStaleCompletion` operation with exact source identity, expected revision,
   explicit date/zone, ended-source validation and current-account proof. Refuse already moved/resolved/conflicted
   items, or route to their canonical destination for explicit resolution. Do not widen `updateItem` or
   `completeCarryoverItem`. Decide concurrency/CAS and historical live-listener coverage before exposing this API.
3. `plan-tomorrow-model.js` (`classifyOneOffActual`, `summarizeActual`, `reconciliationBucket`) and `plan-authority.js`
   (`classifyItemActual`): expose separate original-day outcome and later resolution; late resolution must not
   become original-day “done”. Preserve existing preparation and streak semantics.
4. `planning-continuity-ui.js`/`.css`: Completed in More actions opens an explicit date form (default Today, original
   plan date visible); confirmation states both dates and no duration implication. Validation/error state before
   one explicit resolution write. Do not introduce a Completed control until the authority/model is approved.
5. `index.html` named plan/reconciliation renderers, `tomorrow-timeline-model.js`/`tomorrow-view-ui.js`,
   `intelligence-read-model.js`/`intelligence-ui.js`, `shared-accountability-model.js`/`partner-view-model.js`:
   audit completion readers and render the resolution separately; no original-day completion/statistic inflation.
   Audit Learning/Ledger and Focus linked-plan consumers before claiming cross-domain completion support; no logged
   time or Ledger event should be created merely by a historical plan assertion.
6. `calendar-plan-model.js`, `operational-plan-model.js`, `plan-tomorrow-model.js`, their repositories/sync bridges,
   `plan-item-origin.js`, `plan-fence-sync.js`, `storage.js`, `scripts/firebase-rules-builder.mjs` and generated rules:
   review acceptance/retention/validation and merge of the annotation for ordinary, `bdp1|` and `api1_` items. Only
   change the layers proven necessary; protected review is mandatory. Old clients must not discard/resurrect a
   resolution; settle rollout/merge policy explicitly. No schema migration is authorized here.
7. Delete, separately: propose `deleteStaleItem` using existing `deleted:true` tombstone shape, expected revision,
   source/account/recovery guards and explicit confirmation. Retain task text/schedule/provenance and linked work;
   no Firebase child remove, array filtering or bulk operation. Define original-day “removed later” display before
   coding. A deletion timestamp may need a new field because `updatedAt` can change later. Fenced tombstones are
   monotonic (`mergeFencedItem`); **do not promise Delete Undo** without a separately reviewed restore contract.
8. Backend/bridge API support, if later requested: `functions/src/envelope.js`, `plan-mutation-action.js`, domain
   readers/rules, Worker MCP command contract, consent and revision/idempotency tests must mirror the approved new
   semantics. No automatic widening of existing `plan_set_completion`/`plan_delete` or conversational tools.
9. Add regressions across all stores, post-cutover legacy sources, fences/API items, DST/date-only ambiguity,
   duplicate/stale requests, failed/unknown acknowledgements, account switches, two real sync clients, old-client
   replay, original-day Review/Partner/Intelligence/streak invariants, and preserved linked logs. Generate www and
   advance the governed generation only after the approved implementation.

Owner decisions needed for that **future task**: date-only vs exact-time completion, how historical removal is
presented in prepared plans, and whether strict remote CAS/live historical convergence is a release requirement.
Recommended sequencing: resolve the historical-source listener/revision contract first, then implement the explicit
completion annotation and tombstone UX in separately reviewed tasks. TASK-016 remains unrelated and unauthorized.
