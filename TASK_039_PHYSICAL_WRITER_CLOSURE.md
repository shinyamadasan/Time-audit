# TASK-039 — physical-key and legacy-writer compatibility closure

**Integration verdict: BLOCKED.** The isolated physical-key and extension-retention candidate passes
its bounded checks. This is a local checkpoint, not a release candidate. Guardian **NOT RUN / NOT
PASSED**; production **NO-GO**.

Owner-authorized base: `021d1eecb963d75fabd09735095e54c1fa6ff4b7`. Branch:
`task-039-physical-writer-closure`, in `.worktrees/task-039-unknown-resolution`. The final local commit
is returned in the session; the independent review record names the exact reviewed source commit.

## Implemented and proved locally

`browser-extension/entry-physical-keys.js` resolves typed logical IDs to their actual existing keys.
It does not migrate/delete a physical source. Existing aliases must have identical domain content;
their revision metadata may differ and is advanced separately in one atomic patch. The logical
projection collapses only proven-identical aliases. Contradictory live/tombstone aliases, foreign
occupants, unknown metadata, noncanonical physical keys and typed-ID conflicts remain UNKNOWN with
their complete original records. Tombstone protection is retained; no automatic resurrection is used.

The separate LOCAL `physicalWriterRules()` variant adds physical binding to the prior cancellation
and revision gates. Creating either alias prohibits simultaneous/later creation of its counterpart.
Existing duplicate sources must advance together with the same operation ID, preserving IDs and
individual revision before-images. Real SDK clients demonstrate offline numeric creation losing
to a prior `e_` creation without duplication. Identical pre-existing aliases can be tombstoned or
extended atomically, without deleting either source. The original rule predicates stay in force.
Canonical production rules are unchanged.

`browser-extension/pending-writes.js` retains a complete immutable entry before the background
producer advances its merge/active-session cache. Conditional commands freeze original before-images,
bytes, operation identity and ETag before sending. Failed storage/readback pauses tracking with the
original session retained. Offline, refusal, lost reply and account detachment retain the command.
An exact authoritative post-image can acknowledge a lost response; fresh reads never rebase a stale
proposal over a later manual edit. Explicit authentication refusal refreshes credentials once while
preserving the original conditional request. No timeout drops a fact or pending operation.

Captured producer receipts reconstruct the merge cache/session endpoint after interruption between
enqueue and the old cache writes. Process exits after enqueue, after merge persistence and before
active-session removal retain the original ten-minute entry across a logical one-day offline restart
for both accounts. A stale shorter capture is retained UNKNOWN and cannot truncate an earlier capture.
Sign-out/sign-in keeps listeners and partitions full intents/merge caches per account. Legacy sessions
without owner proof are retained as unbound UNKNOWN rather than assigned to the signed-in account.
The original extension merge calculation, entry fields and timestamps are preserved verbatim.

**Default extension sends are disabled by the missing physical-fence capability.** Canonical rules
cannot supply that proof. This candidate captures UNKNOWN entries and has no production activation
switch. Marker presence is never accepted as proof. The pinned emulator transport alone supplies
the tested capability; multi-alias publication additionally requires an explicit atomic transport.
Do not ship this extension while treating it as ordinary acknowledged logging.

## Complete inventory and STOP boundary

[WRITER_COMPATIBILITY.md](accounting-hazards/WRITER_COMPATIBILITY.md) inventories every examined
physical sink, logical producer, replay trigger, auxiliary store, archive and exclusion. Independent
review checks completeness. No source writer family remains unexamined; many remain **unprotected**.
This is a source inventory, not a live inventory of installed/open/queued older clients.

The remaining change is materially broader than physical routing. Ordinary handlers mutate live
entries, timer cursor, one-slot Undo and auxiliary state before asynchronous ACK. The existing local
journal records drafts but cannot meet the owner's unchanged-cursor/Undo interruption requirement by
wrapping publication alone. Delayed delete callbacks, async native phone usage, Away/Focus transitions,
bulk tombstones and bootstrap/reconnect replay need an explicit common staged-effects contract:
capture original effects before mutation, publish the immutable command, then apply local effects
durably once after ACK. A visible draft-preview contract would require separate UI approval; none
is assumed. No time formula redesign or new backend was shown necessary.

Implementation stopped at this boundary. App/Undo physical routing, the accounting adapter and
permanent cancellation/reconciliation path remain unwired. index.html, storage.js, time-ack.js,
Focus sources, the original cancellation proof, canonical rules/builder and gateway remain identical
to the base. The complete 99-file app mirror is unchanged. Broader stale-write integration stays held.

Remaining accounting hazards include the legacy `e_` sync/direct-clear/Undo paths, command-local
cursor and Undo mutation before ACK, delayed deletes, native phone usage cursor advancement,
Away/Focus multistore transitions, metadata/duplicate cleanup, reconnect replay and available older
writers. Conflicting aliases and unbound legacy sessions require resolution rather than migration.

One additional **unresolved verification failure** remains: the affected browser run passed 27/28;
Bob's scheduled record was absent after resume once. Five isolated repeats passed, but the failed
run did not establish whether the frozen event remained durable. Those repeats do not clear the
failure or prove a benign timing cause. The unchanged adapter must investigate this before integration.

## Verification and review

[PHYSICAL_RESULTS.json](accounting-hazards/PHYSICAL_RESULTS.json) records exact commands/results.
Compressed local logs are in `accounting-hazards/evidence/physical-closure/`.

- Focused new physical/extension regressions plus existing lifecycle/journal and pinned historical
  counterexamples: **88/88 passed**. The old counterexamples deliberately prove the old hazard;
  current producer prevention tests are separate and use the actual new modules/background source.
- Entry/time-provenance affected tests: **42/42 passed**.
- Original strict F-1 through F-7: **7/7 passed**.
- Existing real-browser SDK/accounting prevention suite: **27 passed, 1 failed**; targeted scheduled
  diagnostic repeats **5/5 passed**, failure remains open. No assertion weakened or test skipped.
- Preservation: twelve frozen sources, verbatim extension calculations, exact historical fixture,
  canonical builder, 99-file mirror, syntax and whitespace checks passed.

Independent exact-source review of `40e4ade0d7083a615e4b214938eb70aee6956cff` passed this bounded
local handoff with no must-fix findings. [Review receipt](accounting-hazards/PHYSICAL_INDEPENDENT_REVIEW.md).
It confirms the inventory and BLOCKED integration verdict; it does not approve activation or release.
The reviewer independently ran the extension tests (10/10); its child-process tests could not spawn
inside its sandbox, so it does not claim another full emulator/process run. Earlier findings on
shorter recapture, expired credentials and listener lifetime were repaired with prevention tests.

Self Review/QA: bounded artifact code health is reviewable; app-level "Would I ship this?" is **no**.
Data-integrity/acceptance gates remain blocked for the explicit uncovered contracts and browser failure;
TASKS status is `blocked`, not `review`. No architecture decision is silently entered into DECISIONS.
No full npm/browser suite was repeated while the adapter remains unwired. Chrome MV3 lifecycle
acceptance, hosted CI, Guardian, live writer availability and phone testing were not run. No push,
PR update, merge, deployment or production access/write occurred.

## Single next release decision

**Keep release NO-GO and approve one explicit staged-command contract for the inventoried active
accounting writers**, including durable once-only local application and the async/multistore boundaries
listed above, before any app integration or release reconsideration. Include investigation of the
scheduled-event failure. This is a local contract/integration decision; canonical rules, PR #20 and
gateway stay frozen. Guardian remains **NOT RUN / NOT PASSED**; production remains **NO-GO**.
