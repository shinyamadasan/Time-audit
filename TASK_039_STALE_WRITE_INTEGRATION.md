# TASK-039 — integration STOP: entry/cursor acknowledgement boundary

**BLOCKED before application wiring. No integrated release candidate. Production NO-GO.**

Authorized baseline: `c7951add89bd0b4adcee13ebc9287f4c7caed875`, containing reconciled
`b662d14616e5744807304d0621f6354392d2c2be`, main
`a9e22afba5370f426c4066c94bf216eac3cced94` and frozen PR20
`122d3835f7114503d9be5ea581227b0d95fb9d9d`.

The independent source/emulator investigation found an accounting lifecycle boundary missing from the
record-level feasibility proof. The owner's instruction says to stop if integration requires changing
the approved time engine. No accounting lifecycle change was silently selected. An unwired helper
prototype was removed; canonical runtime, Firebase rules/builder, API, mirrors and gateway remain
unchanged. This checkpoint records the STOP and its reproducible evidence, not a completed integration.

## Demonstrated incompatibility

Actual `undoLastAction` clears `lastUndoAction`, tombstones/restores local entries, then immediately
rewinds the owned `taskStartTime` and `blockStartTime` and calls actual `syncTimerState`.
Only afterward does it persist and call `syncEntries`; it does not await or handle the entry outcome.
The existing owner/device/session guards do run; the counterexample satisfies them.

Under the proposed record rules, a correct stale entry request is refused because its captured base
revision differs from the stored revision. Timer writes still use the existing broad owner grant.
Consequently a validly authenticated Undo can publish its cursor rewind while its recorded-entry
mutation is rejected, leaving a live entry in the interval behind the now-rewound cursor and no
remaining Undo action. This is an acknowledged cursor/entry mismatch, not an assertion that the
emulator rejected authentication or merely rejected a missing metadata field.

The local reproduction extracts the actual Undo/tombstone helpers from index.html and actual
syncTimerState from storage.js and executes them with synthetic owned state against the real RTDB
emulator using the proven rule variant. Strict current-base and ownership controls distinguish a
stale-CAS rejection from unrelated denial. Actual output and executable source are retained in
`review-artifacts/task-039-stale-write-integration/independent-review/`.

Observed event order: timer publication requested, persistence after local cursor rewind, then entry
CAS requested. The stale entry mutation is refused while the timer publication is accepted; the
authoritative entry remains live. A separate legacy owner timer replacement remains authorized too.
The subsequent duplicate-span risk is an inference from unchanged `_doQuickSave`, which starts at
taskStartTime/blockStartTime; no subsequent Save is claimed unless explicitly recorded in the harness.

Deferring only the network call is insufficient: the local cursor has already changed, a refusal
is not consumed, the Undo receipt is cleared, and later Save/Stop may continue from that changed
state. An atomic entry+timer PATCH would protect that one publication but still needs a guarded
local acknowledgement/refusal/uncertain-result lifecycle and a decision about legacy timer writers.
This crosses the approved accounting-state boundary even if its code is placed in an adapter.
No duration calculation needs to change, and no gateway is inherently required; the additional
accounting lifecycle contract must be explicitly authorized and proven first.

## Other actual integration requirements surfaced

- `saveRetroEntry` merged edits splice source IDs; midnight edits can replace an original ID with
  two timestamp-derived descendant IDs. Source tombstones and all replacement descendants need one
  atomic operation batch. Independent per-entry transactions could leave duplicate or partial time.
  A collision must retain the pending edit, never silently adopt a destination's current base.
- `openEditEntry`/`openEditMergedEntry` currently retain IDs/time context rather than complete edit-start
  before-images. Capturing only at repository write/persist time can silently reauthorize form values
  after a remote change while the editor was open. Planning forms require the same source-bound audit.
- Old tabs rewrite existing cache envelopes and can discard unknown envelope metadata. The only
  durable bases/pending copy cannot be embedded there. Unknown or unexpectedly changed cache contents
  must be quarantined, not promoted to new commands; folded fenced items have separate physical bases.
- Edits during an in-flight write must retain their generations. Only an exact own acknowledgement
  may advance a dependent local intent's base. Entry Undo snapshots can contain obsolete counters.
- Actual API moves still require per-record atomic CAS and transport-counter exclusion from semantic
  receipt revisions, as identified by c7951ad. No API adapter change has been applied.
- Existing connection status says synced before domain acknowledgement. A compatible integration must
  distinguish connection, durable pending state, confirmed save, conflict and recovery/storage failure.

These are requirements, not implemented features or permission to start an alternative architecture.
The accepted c7951ad proof remains valid for its tested record-level scope. It did not demonstrate the
complete application entry/cursor handoff, durable pending adapters or final receipt integration.

## Verification disposition

The focused independent emulator reproduction has **8 successful assertion scenarios, zero failures
or skips**, across alice and bob. Both the current-base allow/stale-base deny controls and the
separate-versus-atomic publication controls run for each account. These passes demonstrate the
STOP condition; they are not a safety or integration PASS. See the actual results and capture record.
Production-source hashes and Git differences prove that all
application/rules/API sources remain the baseline. The earlier 26-case record protocol proof and
source-bound UI/time/OAuth/Worker/rules parity evidence are retained and reused for unchanged source.

The complete client/rules/API implementation was not completed. Its required full integration gates,
new hosted exact-head/base CI, and a new seven-scenario time-integrity pass were **NOT RUN**. Prior
strict time passes are not counted as proof of safety under the proposed new network refusal path.
No current-client compatibility PASS, deployment-ready rule artifact or successful release is claimed.

## Concrete rollout and forward-recovery policy

There is no approved executable rollout while the entry/cursor issue remains. The following is the
required order and recovery policy for any future approved combination; no step has been executed:

1. Resolve and approve the local accounting acknowledgement boundary; finish compatible client/rules/
   API integration, exact mirrors, focused then complete gates, independent review and final Guardian.
   Bind the final commit and actual main/base; c7951ad or this STOP checkpoint cannot substitute.
2. Separately authorize a read-only live compatibility/writer inventory and capture a compatible
   forward-recovery artifact. Include already-open pages, browser storage/queued work, backend tokens,
   both account mappings and any writer able to change timer authority. No production data was read here.
3. Before enabling the new contract, obtain authorization for a maintenance write fence covering all
   protected planning records, entries **and affected timer/cursor writes**. Staging compatible assets
   while leaving old broad grants active is unsafe. Do not deploy the new record gate alone to existing
   incompatible clients/backend writers. An owner-approved hold must explicitly explain interrupted
   sync and retain local active/offline work; it must not clear storage, force cache eviction or replay
   old queues. Old tabs may continue local work, but must not retain destructive server authority.
4. Already-open/offline legacy sessions need lossless account-bound recovery of complete cached
   records and pending operations before any storage replacement. Do not rely on CSV, refresh prompts,
   version strings, sign-out or a claim that queued work was saved. Unknown-base work requires explicit
   comparison with current server data and user-selected reapplication through a supported editor.
   Preserve both copies; a stale replacement must never be automatically given a fresh revision.
5. Under the hold, publish only the explicitly approved compatible backend/client combination and
   then install its final, jointly reviewed enforcement rules. Reopen writes only after separately
   authorized current/legacy, online/offline and both-account canaries demonstrate allowed saves,
   denied legacy writes, preserved pending work, timer ownership and entry/cursor consistency.
6. If compatibility or canaries fail, retain/reinstate the protective write hold and roll forward to
   a reviewed compatible artifact. Do not downgrade to an unsafe old client, weaken source fences,
   reset revisions, restore an old database, resurrect tombstones or clear/replay browser storage.
   Preserve the original record and pending command before any recovery action. No rollback is safe
   merely because its UI looks familiar or its client predates the new contract.

Steps requiring live rules, publication, data access or canaries need separate owner authorization;
this document is policy, not that authorization. Manual phone testing remains outside this task.

## Single next decision

Authorize a bounded LOCAL extension to prove guarded entry-operation/timer-cursor acknowledgement,
refusal, uncertain-result and offline/reload recovery, including Undo, while preserving all existing
time-span calculations and ownership/device guards. Once that boundary is proven and approved,
resume the remaining direct-RTDB contract integration. Do not start a gateway or broader migration.

**Compatibility verdict: BLOCKED / NO-GO. PR20 remains frozen. Gateway remains frozen.**
No push, merge, deploy, live rules, production access/write or phone testing occurred.
**Guardian NOT RUN / NOT PASSED. Production NO-GO.**
