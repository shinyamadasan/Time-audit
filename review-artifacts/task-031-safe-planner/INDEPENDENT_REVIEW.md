# Independent source review — TASK-031 safe planner

Recorded by the implementer from the read-only review messages of `/root/task028_independent_review`.
The owner explicitly requested independent review. The reviewer did not edit files, rerun suites, access
production, approve deployment or act as the repository's formal Claude release reviewer.

## Final assessment

No remaining must-fix found in the reviewed candidate source/tests/rules. Full Node/browser gate results
are supplied by the builder and must pass separately; source review is not a production/device guarantee.

Confirmed in the final recheck:

- All five planner lifecycle findings were corrected.
- Client arbitration refuses changed sources and preserves authoritative provenance.
- The new-claim server predicate blocks the demonstrated pre-fix stale-source payload in all three stores,
  with matching-source and ordinary-edit compatibility controls.
- Tests cover transaction retries, recovery/provenance, preserved draft identity and edited headline/notes
  through preparation failure and retry.
- Reviewed root/runtime mirrors match by SHA-256.
- Final UI-only comparison correction: copied item list is sorted by ID, and existing `sameOnWire`
  handles key order/Firebase-null pruning. Authoritative source data is untouched; actual-change refusal
  tests remain. Reviewer found no must-fix in this narrow delta; full-browser verification is separate.

## Decisions and corrected findings

1. Refuse semantic source mismatch rather than always using the remote source. An unconditional rebase
   could discard a genuinely newer local classification whose ordinary asynchronous push is still pending.
   No new wire fields or promotion intent contract is needed for the narrow existing-flow correction.
2. Invalidate old DOM/input ownership by draft instance, so explicit discard or Start from latest cannot
   recapture unfinished text from the previous same-owner/same-target draft.
3. Preserve unmounted form values across Normal/Rescue, clearing only an explicitly submitted/reset form.
4. Freeze the whole mutable scroll region during save, including mode controls; check the submitted
   signature before clearing its recovery state or closing on success.
5. A late save completion may update its own receipt but must not restore old focus or reopen Review after
   the user has closed/navigated elsewhere.
6. Reconciliation reason writes must validate current owner, current canonical source/item, source editability
   and draft context before writing; a retained textarea must not write across account/day changes.
7. Client-only correction plus voluntary device reload is insufficient to claim a safe cross-device release.
   Add only source-fact equality to the existing server `newClaim`; do not alter ordinary edits or existing
   claim transitions. Include Firebase-pruned pre-fix-output denial and matching-source acceptance controls.

The reviewer found no must-fix in the final rule delta or planning-timezone pin. The rule applies only
to a new claim. It is not a broad audit of every old-client mutation or an edited-draft promotion protocol.

## Scope boundary

Direct Eisenhower insertion remains deferred. No edited-promotion claim payload, second authoritative task
store, source classifier, timer, schedule authority or logged-time schema is introduced. Final source/image
hashes are in `SOURCE_MANIFEST.json`; runtime gates and limitations are in `TASK_031_RELEASE_HANDOFF.md`
and `TEST_REPORT.md`. No push, merge or deployment is approved by this review.
