# Independent review record

Recorded by the implementer from read-only reviewer `/root/task028_independent_review` messages.
This is not formal Claude release approval or owner visual approval.

## Stage 1

The reviewer inspected the actual laptop/phone renders and the source delta against d7e01d0.
One must-fix was found: the generic recommendation absence claim was untrue for a pending promotion
whose destination may already exist. It was replaced with neutral Brain Dump review wording.

The final source recheck found no must-fix. It explicitly covered the specific inset timeline focus
ring, recommendation movement before fold restoration, matching mobile visual/DOM order, preserved
draft-instance input capture/restore, Normal/Quick plan/intentional-blank layouts and preserved controls.
Promotion, storage, rules and shared-model files were confirmed unchanged from the baseline.
Automated gates and physical/owner visual acceptance remain separate evidence.
The final frozen-source/image review also found no material must-fix in the header label/touch size,
Inter button spacing, compact card controls or footer. The reviewer inspected the final laptop,
phone planner and expanded phone task comparisons. Final full-browser results remained pending at
that review; no tests were rerun by the reviewer.

## Stage 2

Initial boundedness review accepted existing local Top 3 semantics with explicit recoverable capacity
conflicts; a strict global-cap reservation was correctly rejected as an unnecessary new requirement.
The review also required server-only confirmation rather than cached SDK `.once()` readback, preservation
of the new version through expiry/reopen, and exact edited creation intent through recovery.

The subsequent implementation review found these must-fix gaps before UI connection:

1. The ordinary outbound fence merge can replace an unseen owner edit with a newly stamped creation
   candidate. Local ID checks plus a pre-read do not close that race.
2. New-version finalization needs unconditional origin/epoch binding, not only exact payload comparison.
3. Every new-version foreground revoke/finalize/recover wait must be bounded as unknown while retaining
   eventual transaction processing.

An active-only refusal guard does not complete the contract: delayed creation can arrive after promotion,
and a divergent/tombstoned destination prevents both strict-exact finalization and absence-only recovery.
The remaining policy is whether a capture may finalize as initially applied while UI truthfully reports
subsequent changes for review. A create-only initial writer must also prevent delayed replay overwrite.

The reviewer suggested first considering existing immutable origin plus destination-absence at fresh
claim and exact-content create, rather than adding a new marker. This is a recommended contract refinement,
not a claim that it has been implemented/proven. Direct selection remains gated.
