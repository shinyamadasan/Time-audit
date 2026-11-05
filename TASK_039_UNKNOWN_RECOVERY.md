# TASK-039 — final UNKNOWN Undo recovery proof

Historical proof record, before the accounting-hazards follow-up. Statements below about uncommitted
work and unchanged runtime describe that earlier checkpoint. Current results and integration limits:
`TASK_039_ACCOUNTING_HAZARDS.md`.

Verdict: **BLOCKED for app integration / release. PASS for the isolated cancellation primitive.**
Guardian **NOT RUN / NOT PASSED**. Production **NO-GO**.

Owner-authorized local base: `9b0671ba8deca394170aeff84f12825341ff7b71`.
Worktree: `.worktrees/task-039-unknown-resolution`, branch `task-039-unknown-resolution`.
The proof and evidence are saved as uncommitted changes in this isolated worktree; no production commit was made.
The checkpoint is accepted as the tested integration candidate, with no release approval.
Runtime, canonical rules, time arithmetic, timestamps, Undo functions and device guards are byte-identical
to that checkpoint. No broader stale-write integration was resumed. No push, PR update, merge,
deployment, live data access or phone testing occurred. All account data below is synthetic.

## Smallest enforceable mechanism

`unknown-recovery-proof/recovery.js` builds a LOCAL-ONLY rules variant:

- An owner may create `rooms/<owner>/timeAckCancellations/<originalOperationId> = true`, or write the
  identical `true` again. No update, deletion, collection overwrite or room overwrite is granted.
- Entry and timer writes reject a new `_csWrite.operationId` found in that cancellation set.
  Redemption records receive the equivalent validation beneath their existing collection grant.
- The original Undo remains one atomic multi-path PATCH with its original ID and immutable payload.
  It either commits before the cancellation, or is refused in its entirety. Every subsequent exact
  replay is refused. A racing original that committed first is part of the server version retained.
- Cancellation never expires. Marker retention is permanent; no age-based cleanup is safe while
  old requests can still arrive. An ID may never be recycled.

A create-only, idempotent PUT is smaller than a revision bump or transaction here: it changes no
accounting record and has no read/modify/write race. The existing per-record revision metadata remains
unchanged. Bumping only a revision cannot fence the existing unconditional original PATCH under the
canonical rules. A client abort, elapsed 120-second wait, local Web Lock or ETag read also cannot
revoke an already-submitted unconditional PATCH. A whole-room conditional PUT would need a new
parent write grant, so it is not the small safe option.

The permanent marker needs the corresponding server rules. Marker readback by itself is NOT proof
that those rules are installed: the predicate-mutation negative control explicitly demonstrates this.
The prototype transport is pinned to the local emulator with the tested rules. A production client
must not infer rule enforcement from arbitrary marker presence. Canonical rules remain unchanged and
deny marker creation; under them the prototype retains UNKNOWN.

## Recovery and reconciliation proof

`createRecoveryProof()` persists the owner, original operation ID and immutable intent before sending
the cancellation. It checks durable readback and account/device attachment before and after network
work. Mutable observation metadata may change; the original before-images, patch, local frame,
proposed cursor and timestamps cannot. A lost cancellation reply/read or offline interruption yields
UNKNOWN and retries the same marker after reload. No deadline retires an operation.

After confirmed cancellation, one authenticated, uncached room GET supplies a coherent account-owned
snapshot containing the marker, entries, redemptions and timer. `reconcileCandidate()` constructs a
candidate local projection from those exact records and the server cursor/device. It performs no
arithmetic, merging, timestamp generation or domain writes. Concurrent edits, other-device ownership,
historical fields and unrelated entries are retained.

The candidate is refused if the timer's owner is unproven, the local timer changed independently, or
local accounting facts differ from both the captured original and authoritative data. It never drops
local-only automatic logs to manufacture a successful exit.

This is a proof, **not a connected app recovery button**. It never calls the Undo applier, retires the
app envelope, flushes deferred writes or releases the accounting barrier. The original UNKNOWN remains
durable. An atomic snapshot is a point-in-time observation, not a lock against later ordinary writers.
Per-tab quiescence, durable local reconciliation and cross-tab recovery still need integration.
The room GET is exercised on bounded synthetic fixtures; large-account sizing is not established here.

## Confirmed remaining accounting hazards

The browser tests load the unchanged app with the real Firebase SDK, canonical emulator rules and
only local assets. All other HTTP destinations are blocked by the new hazard harness. Passing a
hazard reproduction means the fault is present, not that accounting safety passed.

### First-read cross-tab gap — reproduced for Alice and Bob

Named paths: `requestAcknowledgedUndo()`, `createTimeAck().begin()`, `timeAckBlocks()`,
`_doQuickSave()`, `applyRemoteTimerState()` and `resolveEntrySync()`.

1. Save Writing for minutes 0–10. Tab A presses Undo; its authoritative agreement reads are captured
   and delayed. `_timeAckPreparing` is tab-local; the shared durable operation does not yet exist.
2. Tab B sees no barrier and extends the saved entry through minute 12. Tab A's independent realtime
   channel is offline, so it cannot learn this change while its already-captured REST reads wait.
3. Deliver the earlier reads. The original PATCH still commits under canonical rules, replacing the
   12-minute record with the older 10-minute tombstone and rewinding the server cursor.
4. Tab B ignores the older timer timestamp and retains its minute-12 cursor. Its next Save writes
   only minutes 12–14 and publishes a minute-14 cursor. Authoritative data then has no live 0–12
   record and no running cursor covering that span.

This is a data-loss reproduction, not merely another tab missing a status message. The existing
Web Lock serializes Undo lifecycles; ordinary Save does not acquire it. Sharing a preparation flag
alone also needs care for writes already in flight before that flag was created.

### Automatic crash-recovery logging — reproduced for Alice and Bob

Named paths: `restoreHeartbeatRecoveryForAccount()`, `handleRecovery(true)`, `autoLogBlock()`,
`resetTimer()`, held-path `syncEntries()` and `timeAckFlushDeferred()`.

1. Save Writing for minutes 0–10; submit an Undo whose request remains delayed/UNKNOWN.
2. Simulate a valid heartbeat shutdown at minute 12 and recovery at minute 15. The real intentional
   recovery handler extends the original record to 12 minutes and stops the timer despite UNKNOWN.
   Held-path deferral correctly prevents that entry and stopped timer publication from reaching RTDB.
3. Deliver the original Undo. Its tombstone replaces the local 12-minute extension. Reconciliation
   and deferred stopped-state publication finish with no live entry and a stopped server timer.
   The newly recovered minutes 10–12 are lost.

The previous assumption that automatic paths merely make Undo locally "superseded" is insufficient:
authoritative listener replacement can erase the automatic extension before that local check runs.
Scheduled template logging, break expiry and PC-time auto-logging remain unbarred by source inspection;
their complete interaction matrices were not run. The concrete crash-recovery loss is already blocking.

### Existing 120-second Keep original — counterexample for Alice and Bob

The unchanged lifecycle can retire UNKNOWN as `abandoned` after its quiet period while the server
still has the before-state. Delivering the exact original bytes afterward succeeds under canonical
rules and changes authoritative records. A timeout is not cancellation. The prototype never uses
this retirement path. The original UI remains unchanged and must not be treated as policy-compliant.

## Verification and limits

Reproducible local commands (from this worktree):

```text
node --test unknown-recovery-proof/recovery.test.js
node --test time-ack.test.js
npx playwright test tests/time-ack-undo.spec.js tests/time-ack-unknown-hazards.spec.js --workers=1
npm test
node scripts/runtime-mirror.mjs --check
node scripts/firebase-rules-builder.mjs
git diff --exit-code 9b0671b -- index.html storage.js time-ack.js firebase.rules.json scripts/firebase-rules-builder.mjs www
git diff --check
```

Exact final results are recorded in `unknown-recovery-proof/RESULTS.json` and appended to
`TEST_REPORT.md`. Local full logs are retained alongside the proof under ignored `*.log` files.
The proof includes logical one-day delay and a real 125-second delay for both accounts; lost original
and cancellation responses; every original stamp overwritten; concurrent edits; racing original and
fence; duplicate replay; simulated two-client/reload/offline recovery; permanent marker protection;
account isolation; local timer drift and unsynced automatic records. The browser regressions include
actual two tabs, reload and offline reconnect. Both accounts are fixtures, not production accounts.

No full browser suite, strict-seven repetition, hosted CI, Guardian, live writer inventory or phone
acceptance was run for this proof-only change. No runtime structure moved, so CODEMAP is unchanged.
No new architecture was approved or entered into DECISIONS. Code-health review permits this local
proof artifact; it does not permit shipping the unchanged unsafe app or enabling an exit button.
Self-review found no runtime dependency, unused helper, speculative framework or changed time function.
QA source/parse/parity/rules checks pass. The app data-integrity gate fails on the explicitly reproduced
losses, so the task is marked `blocked`, not `review`; the evidence files do not claim a release-ready result.

## Smallest viable alternative and single next approval

Keep UNKNOWN durable and keep conflicting commands blocked. Do not use elapsed time as an exit.
Retain the permanent operation-ID fence as the smallest demonstrated cancellation mechanism.

**Single next approval:** authorize one bounded LOCAL follow-up to close the shared preparation /
in-flight-write gap and preserve automatic/recovery accounting mutations, then integrate the proven
cancellation and authoritative reconciliation path under that accounting fence. Preserve the original
automatic interval timestamps and all approved calculations. Limit the follow-up to these accounting
writers; the rest of stale-write integration stays held. No deployment or production approval is requested.

The two loss reproductions must become prevention regressions before an app-level PASS. If safe
writer serialization cannot stay inside that scope, report the exact larger contract required before
proceeding. Guardian remains **NOT RUN / NOT PASSED**; production remains **NO-GO**.
