# TASK-039 — bounded time-accounting acknowledgement proof

**Technically viable for the tested ordinary entry/timer lifecycle. Local design proof only.**
**Production NO-GO. Application integration remains blocked/unperformed.**

Baseline: `cfa2864576d5cac6a7ecfbedbc1d7791e2eb5806`. The exact original source, proof and
post-checkpoint review records are preserved. Nothing imports this fixture into the application.
No production UI, rules/builder, API, time algorithm, runtime mirror, PR20 or frozen gateway changes.

## One lifecycle contract

The fixture stores one account-bound recovery envelope containing the full original accounting
frame (entry records, cursor/timer, Undo, device/session and local generation), stable operation ID,
frozen proposed result, exact server before-images and exact atomic entry/timer patch. Capture the
original before evaluating an edit; reject a proposal if that captured frame has already changed.
The original engine functions execute in a detached synthetic frame to obtain their existing
results. Their UI/network hooks are intercepted in the fixture; their calculations are not rewritten.

| State | Meaning and permitted local effect |
|---|---|
| INTENT | Original/proposed state durably staged and read back; live cursor/Undo unchanged |
| PENDING | Durable attempt recorded before sending the complete atomic patch; live cursor/Undo unchanged |
| ACCEPTED | Authenticated server200 acknowledges the entire exact patch, or a fresh authoritative snapshot matches every exact operation post-image |
| REFUSED | Before the first attempt, authoritative state conflicts, or an unambiguous first-attempt server401/403 refuses the atomic batch; original cursor/Undo retained |
| UNKNOWN | Lost/incomplete response, failed read, interrupted acknowledgement, ambiguous advanced state or retry refusal after an uncertain attempt; retain full intent and original local consequences |

ACCEPTED is a durable receipt of this operation, not a claim that no later server edit occurred.
Apply its frozen local result only when the active account/device/session and entire original local
generation/frame still match. Commit the resulting frame, Undo consumption and applied operation
identity in one local envelope replacement. Rehydrate that envelope after reload; never execute
Undo a second time. A newer local Stop/replacement makes application fail closed and preserves
both frames for reconciliation. This proves logical local state application once, not exactly-once
DOM rendering, notifications or arbitrary external side effects.

Every affected entry and the timer receive the existing proposed per-record revision/existence
metadata plus the stable operation ID. The server commit is one Firebase multi-path PATCH; it either
accepts the whole set or refuses it. The fixture uses a fresh authenticated room snapshot to compare
all original before-images, including unversioned records. It never treats an optimistic SDK cache,
UI mutation, a local projection, connection status or absence of an exception as acceptance.

The timer must also be protected by a revision/existence gate. The original eight cases demonstrate
why the entry-only gate is insufficient: a legacy owner may still publish a rewound timer. This
test-only gate reuses the same existing owner/revision predicate. It adds no identity principal,
backend service or gateway; device/session checks are adapter guards, not trusted client identity.
Rules do not infer human intent or force arbitrary authorized owner code to send a complete batch.
A deliberately split transport control can partially change the server, but its incomplete200 is
never accepted by the coordinator. All supported writers must use the atomic adapter, and the
existing Action API writer compatibility work remains necessary.

## Recovery and uncertainty

After any uncertain attempt, read authoritative server state. Matching *all* frozen post-images,
including operation ID and next revisions, proves acceptance. Matching all original before-images
allows only an identical retry, with the same ID, timestamps, bases and payload. A before-image read
does not itself prove that an earlier request cannot still arrive. Any other state stays UNKNOWN.
A retry refusal cannot prove that an earlier uncertain attempt never committed.

This intentionally matches the existing conservative Action API recovery principle documented in
DECISIONS: advanced state after a lost reply can remain pending indefinitely. No new server receipt
store is introduced just to eliminate that ambiguity. The proof retains sufficient state for safe
reconciliation, not guaranteed automatic completion in every failure sequence. An unknown or
pending operation creates an accounting barrier; conflicting later commands are refused before
local mutation. The fixture does not implement continued unrestricted offline Save/Stop/Undo
interaction while that barrier exists. Such an availability/UX policy must be approved and tested
at integration; it must not be described as unchanged offline interaction behavior.

Before staging, storage failure produces no domain access and no local accounting transition.
Failure while saving acceptance leaves the pending envelope recoverable from server evidence.
Failure before local apply retains the original frame. Interruption after the local envelope commit
rehydrates the applied identity without another rewind or Undo consumption. The disk fixture uses
write/fsync/rename/readback and a fresh Node process; this is actual process-restart evidence, not
proof of browser IndexedDB/localStorage quota, eviction, power-loss or multi-tab concurrency.

## Exact automated results

Commands, timezone America/Phoenix:

```text
node --test --test-concurrency=1 time-ack-proof/proof.test.js
node time-ack-proof/rerun-baseline.mjs
```

| Actual focused check | Final result |
|---|---|
| New lifecycle/unchanged-engine/emulator cases | **35 passed;0 failed/cancelled/skipped/todo** |
| Original eight failure observations, exact pinned harness bytes | **8 scenarios;0 failed/skipped**; original STOP reproduced |
| Production source and frozen-ref preservation | See PRESERVATION.json; no canonical change |
| Source, extracted function and compressed-log hashes | See SOURCE_HASHES/EXTRACTED_FUNCTION_HASHES/RESULTS |

These are two different results: the eight original observations demonstrate the existing unsafe
flow; the35 new scenarios test the proposed coordination. They do not amount to an integrated
application release PASS. Real cached Firebase RTDB emulator4.11.2, Node version recorded in
RESULTS.json, synthetic alice/bob owner tokens and localhost only. No live identity provisioning
or production account/data access was tested.

New scenarios cover accepted Undo applied once; concurrent stale-entry and takeover refusal;
both accounts; foreign-owner refusals; account/device/session transitions; offline retention;
lost responses; complete-post-image recovery; ambiguous later edits; exact retries; simultaneous
duplicates; fresh-process recovery; staging/acceptance/local-apply interruption; newer local Stop;
actual Save/Undo and extension/restore arithmetic; current-tombstone Undo; original timestamps,
Unicode/unknown metadata, historical records and tombstones; multi-record source/replacement
atomicity and collision; partial acknowledgements; pre-cutover unversioned mismatch; stale captured
proposals; timer-gate negative control and pending-operation barrier. A rejected Undo followed by
actual Save records only the new span, not the prior live interval.

The baseline harness is copied from cfa2864's exact Git blob with SHA256
`c9667bb3a30a4e20abdf67388c682b8fe48b1641ef0e07dd85769eddae428f12`, pinned against text
conversion. Its redirected output leaves the original evidence unchanged. The first rerun before
pinning had checkout-only line-ending differences; its log is retained, but the final rerun uses
the exact original bytes.

Attempts are retained honestly: first lifecycle run12 pass/13 fail because the real PATCH reply is
a nested tree while the fixture compared flat request paths. The conservative result was UNKNOWN,
not false acceptance. Normalizing response paths fixed it:25/25, expanded33/33, final35/35. A later
command was not executed because automatic approval review hit a configured usage limit; after the
owner requested continuation, the final pinned eight-case rerun was authorized and completed.
No rejected/unexecuted command is counted as a pass. Coverage percentage was not measured.

## Impact and minimum implementation boundary

**No impact on time-calculation algorithms in this checkpoint.** The proof extracts unchanged
`_doQuickSave`, `undoLastAction`, tombstone/restore/Undo helpers and `syncTimerState`. The unchanged
Save formula produces2 minutes for the new interval, extension produces12 minutes for the original
start through the later Save, and restore-Undo recovers the original10-minute interval. Original
timestamps are frozen before retries. Device guards, timer-cursor calculations and tombstone rules
remain intact. UI, category/date dependencies, reminder hooks and notifications are stubbed in the
isolated frame, so their full runtime behavior is not verified by this harness.

The smallest future production boundary is:

1. Capture entry-operation intent and edit-start before-images before actual UI handlers mutate
   shared entries/cursors or clear Undo. Compute their existing results once; retain explicit
   field changes and source tombstones for merged/split edits. Do not rerun time calculations at retry.
2. Use separate account/session-bound durable pending storage with a serialized local transaction
   covering original/proposed state, operation identity, accepted receipt and applied marker. Browser
   implementation must prove multi-tab exclusion, cache upgrade/quota/reload behavior and retain
   unknown-provenance legacy data; a new backend is not required by this design.
3. Commit affected entry records and timer cursor publication through one atomic direct-RTDB adapter
   with existing owner/source checks and revision/existence gates on both entries and timer. Audit
   every timer writer, takeover, restore, heartbeat and Stop path before any rules change. This proof
   does not validate every ordinary/Focus/break/away client against the proposed timer gate.
4. After acceptance, atomically apply the unchanged frozen result only to its original owned session
   and generation. Refusal retains Undo/cursor and intended edit; unknown retains the accounting
   barrier. Observe newer remote/local state before allowing subsequent conflicting operations.
5. Explicitly approve and test pending/unknown UX and recovery, then finish the previously blocked
   client/rules/API stale-write integration, exact mirrors and its independent/final-head gates.

The fixture supports ordinary Save and entry Undo. It explicitly refuses unmodeled Focus redemption
side effects and physical source removal without an explicit tombstone batch. It is not production
code, not a general executable engine replacement, and not a guarantee that all current handlers
can be swapped without further integration work. Envelopes are isolated single-writer test fixtures;
cross-process concurrent writers, arbitrary storage loss and a production retention policy for
operation history are not implemented here. No new unrestricted receipt log is proposed.

## Recommendation

**Proceed to a separately authorized bounded implementation of the acknowledgement boundary, with
the stated availability/recovery restrictions explicitly approved.** A material rewrite of time
arithmetic or new backend architecture was not needed for this proof. It is not justified to stop
all non-gateway work as impossible, and it is not justified to resume application-wide integration
automatically. Preserving automatic offline interaction while every result is unknowable would
require an additional contract; this proof does not promise that behavior.

Retain PR20 and gateway freeze. Do not deploy the timer/entry rule variant independently of
compatible clients/backend writers. All prior release compatibility, exact-head/base Guardian,
hosted CI and separately authorized rollout/canary gates remain. No production action, push, merge,
PR update or phone testing occurred. No new independent review is claimed for this proof turn.
**Guardian NOT RUN / NOT PASSED. Production NO-GO.**
