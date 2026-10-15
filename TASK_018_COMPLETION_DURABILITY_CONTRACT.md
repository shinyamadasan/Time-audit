# TASK-018 — Completion durability contract recommendation

2026-10-15. **CONTRACT DESIGN + OFFLINE PROOF ONLY. Owner approval gate.**

Base: `bb171a287ac67d76ae27634b5227bc24f66919de`. Starting audit:
`07ae51cf28b0aed41a2b5061fcc50dfd5baeb4d9`. Refined A remains approved and unchanged.
No production functionality, deployed rules, live mutations, integration, push or deployment.

## RECOMMENDED_CONTRACT

Store a separately protected **resolution-only record for each original task**, outside every plan collection.
Use a dedicated authenticated backend operation whose only semantic change is to that record. Atomically compare
the original source, authority context and resolution revision using an ETag conditional PUT of the owner's
room. Keep the original plan and every other room sibling unchanged in Firebase wire form.

**This requires explicit owner approval of a new privileged-domain enforcement boundary.** The existing
Action API deliberately has no Admin domain fallback. Leave it that way. The proposed dedicated service is an
alternative enforcement layer, not an attempt to sneak privileged writes into `user-scoped-rtdb.js`.
`docs/CHRONASENSE_ACTION_API_V1.md` section 3 permits proposing such an alternative only with reviewed equivalent
UID/room/schema/fence/revision/invariant enforcement. This document and emulator proof are that proposal, not
authorization to implement or deploy it. The service credential would have broad database capability; its
code allowlist is **not** Firebase IAM path isolation. A credential compromise would exceed this operation's scope.

The smallest strictly source-atomic approach found is room CAS: all existing source stores, relocation/recovery
evidence and resolution state share that ancestor. It avoids a new plan lock, rewriting historical items,
changing released merge algorithms, migrating task identities or reopening frozen history. Its tradeoffs are
the privileged boundary, whole-room payload and contention, documented below.

| Candidate | Result |
| --- | --- |
| Item-owned annotation | Rejected by the existing audit: current/released whole-item merges erase it; post-cutover ordinary sources reject the write. Protecting it needs changed array/old-writer contracts. |
| Independent record + only child CAS | Protects completion retention, but separately reading the source leaves a source-edit/move race before commit. Insufficient for strict stale-source refusal. |
| Independent record + dedicated room CAS | Recommended bounded contract. Source validation and resolution change share one conditional write; old plan writers cannot reach the record. |
| Broad owner/custom-claim room write | Not recommended: a parent grant bypasses child write restrictions. Rules `.val()` is not deep object equality. No such grant is proposed or tested. |

No UI alternatives were explored. The first two findings reuse the prior audit; only the recommended persistence
candidate was prototyped.

## STABLE_IDENTITY

Canonical identity, stored as provenance in the resolution:

```text
{ store: calendar | operational | legacy,
  targetId: exact original Plan Authority id,
  itemId: exact original stored id,
  representation: array | fence,
  origin: "unmarked" | exact Brain Dump origin | { creationActionId } }
```

- Calendar target: `cal1:<date>`. Legacy target: exact stored date key. Operational target: full `odv1` ref
  containing boundary revision id, frozen timezone and original boundary start date; its physical key is the
  existing `physicalTargetKey()` encoding. Never remap an old target using today's boundary.
- Ordinary items are found by exact id within that original record, scanning its wire array/object. An index
  can be an implementation locator, never identity. Reordering does not change identity or the source hash.
- Brain Dump fences bind the exact path **and** version/claimEpoch/type/store/targetKey. A later promotion epoch
  is a different identity, so an earlier completion cannot hide it. Action API fences bind `creationActionId`
  and its derived id; no change to Action API completion, locks or relocation semantics is proposed.
- Reject duplicate ids in one record, unexplained array/fence duplication and same-id placements across
  different source records. V1 conservatively refuses all selected moves/relocations/locks/recovery copies,
  and discovered recovery destinations, including older id-only provenance. Never guess an original using
  title, time or a deterministic tie-break. Ordinary **unmoved** historical tasks in all three stores are supported.
  Supporting proven moved chains later is not hidden in this first contract.
- Existing `createPlanRead` routing/range/fence/boundary/stale checks run against the **same frozen room snapshot**
  used for CAS. Unknown boundaries, inconsistent activation or malformed source authority fail closed.
  Boundary/authority changes invalidate the expected source revision; no automatic re-identification occurs.
- Ordinary pre-existing ids have no independently immutable birth marker. Reuse of the exact same physical
  tuple with a byte-identical source cannot be distinguished from the existing logical task. Assume the existing
  no-id-reuse invariant; do not claim a new incarnation guarantee. Changed source content after completion is
  quarantined as `needs-review`, preserving the completion fact rather than silently applying it to new content.

The expected **source revision** is a SHA-256 of the authenticated UID, typed identity, full selected item,
original plan metadata excluding the items array, activation facts, boundary revisions and account timezone.
It is a precondition, not identity or a timestamp-only version. The prototype is deliberately conservative:
an unrelated edit that changes the same plan's metadata can also require review/refuse Undo.

## STORAGE_LOCATION

```text
rooms/uid_<verifiedUid>/taskCompletionResolutions/r1_<base64url(SHA256([1, uid, identity]))>
```

Record envelope:

```text
v: 1
identity: original typed identity above
revision: monotonic positive safe integer
state: completed | open
completionOpId: most recent completion operation UUID, retained after Undo
operations/<UUID>:
  intentHash, kind: complete | undo, revision, recordedAt, actorUid, sourceRevision
  complete: date, timezone
  undo: undoOf
```

This is resolution truth and narrow idempotency/provenance metadata, **not a second task store**: no task title,
schedule, duration, task copy, timer entry or independent task lifecycle. The original planned date remains on
the untouched target, while `operations/<completion UUID>/date` records the reported actual calendar date.
`recordedAt` is assertion time, never an invented completion time. Use non-null markers: Firebase prunes nulls.

Keep operation receipts through Undo and later completion. A last-operation-only receipt is insufficient to
reconcile a delayed response after a newer action. No receipt pruning, event subscriptions framework, arbitrary
event kinds, general patch API, delete operation or separate global event log is introduced.

## WRITE_AND_ACK_PROTOCOL

1. **Authenticate first.** A future app endpoint verifies the Firebase ID token for the configured project,
   checks revocation/disabled account and derives `uid_<uid>` internally. Reject caller-supplied UID, room,
   database path, actor or timestamp. Its request schema permits only the typed source identity, operation UUID,
   source revision, expected resolution revision and the explicit `complete`/`undo` intent. No Action API/Worker
   command is added. Reuse strict JSON parsing to reject duplicate keys before canonical intent hashing.
   The offline proof receives an already-verified UID; real signature verification is not
   implemented or claimed by this prototype.
2. Persist the account-bound pending intent locally **before dispatch**, including the exact UUID/body and
   whether any attempt became uncertain. This is a pending command receipt, not a task store. Do not replace
   it with a new UUID when retrying. An account switch must detach listeners, clear visible state and invalidate
   callbacks by generation; A's pending command is never dispatched as B.
3. Backend GETs only the derived owner room with `X-Firebase-ETag: true` and `format=export`. Bound the payload
   (prototype: 16 MiB); reject priority/export metadata anywhere rather than risk dropping it on PUT. Future
   HTTP transport must enforce the size bound while streaming, before JSON allocation. No privileged whole-room
   response is returned to the app or written into logs.
4. In that snapshot, validate the record version/schema, unique original source, unchanged origin and eligibility,
   full source revision and resolution revision (0 means absent). Refuse moved/dismissed/deleted/done/conflicted
   sources. Before source checks, an existing matching operation receipt returns its historical result; a reused
   UUID with a different intent is refused. Replaying a completed operation after Undo **does not** reapply it.
5. Complete requires the explicitly supplied, valid nonfuture civil date and the account IANA timezone from
   that snapshot. Checkbox Today derives that account's date, not UTC/server-local date. A changed account zone
   requires a fresh intent. Done earlier supplies an explicit date; no completion instant is synthesized.
   Date-only evidence overlapping a planned interval must not be called exact early/on-time/late work.
6. Build `nextRoom` from the exact wire preimage, replacing only this resolution record, incrementing its revision
   and appending its immutable operation receipt. Production needs an independent resolution-lens diff assertion:
   no original source, unknown sibling, linked capture, authority, entries, review or timer changes are allowed.
7. Conditional PUT **the same room** with `If-Match: <room ETag>`. A source, boundary, fence, resolution or timer
   edit invalidates it. On 412 reread/revalidate, at most three attempts; do not preserve a stale candidate over
   a fresh room. Unrelated concurrent writes are retained. Definite contention/permission refusal does not hide
   the task. No room lock or unrelated-write suspension is introduced.
8. A committed response is followed by authoritative readback of the exact operation receipt and its intent
   hash. Only then return **CONFIRMED**, with both that operation result and the **current head**. A historical
   confirmed receipt does not imply the current head is still completed; Undo or a newer operation may supersede it.
   Readback loss, timeout, connection loss or uncertain write status is **UNKNOWN**, never success or definite
   failure. No receipt in a read is not proof that an earlier in-flight write cannot still land.
9. **REJECTED** is definite only when no attempt in this pending intent could have written: validation before
   dispatch, explicit permission refusal or only failed conditional writes. Once an earlier attempt is unknown,
   later conflicts/denials stay unknown for that intent until its receipt is found. Retry/reconcile with the same
   UUID/body. A contradictory new date is not an automatic recovery action. Some unknown operations can remain
   unresolved indefinitely; retain the task and pending intent, surface the state and allow status refresh.

Exact owner-authenticated resolution-child reads/listeners remain available if whole-room mutation later refuses
for size or priority metadata. `operationStatus` proves receipt recovery without rewriting or reading the entire
room; a missing receipt stays UNKNOWN. Confirming an old operation still does not suppress a task whose current
source cannot be revalidated. Future-version/malformed records yield needs-review, never active completion.

For active Unfinished suppression require a remotely confirmed record with current state `completed` **and** a
matching current remote source revision. Pending or local-only cache state never removes a task. Changed/missing
source evidence yields a distinct `needs-review` state, preserving the reported completion, not a new unresolved
checkbox or silent completion. A future client needs an owner-bound resolution listener plus source/context
refresh for displayed/pending identities. On reconnect/reload obtain a fresh source+resolution snapshot; do not
combine an A-account cache or stale source with B's confirmed facts. Prototype projection demonstrates this
decision rule; a production account-reset/listener integration is not implemented here.

Firebase documents conditional PUT and 412 retry semantics in
[REST conditional requests](https://firebase.google.com/docs/database/rest/save-data#updating_data_with_conditional_requests).
Token verification must follow [Firebase's verification contract](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

## OLD_CLIENT_COMPATIBILITY

The **14 files are one hash-pinned released cf43080 client**, not 14 client versions. All hashes are verified.
Its current/released plan merges touch only their plan paths; those collections are siblings of resolution facts.
Existing calendar owner writes stay allowed, and legacy/operational writes stay frozen after cutover. Old whole-room
or multi-path writes involving resolution facts are denied because there is no ancestor write grant.

Proof: existing released merges for all three stores cannot affect the sibling. A real cf43080 calendar repository
and sync bridge edits and re-pushes a plan twice through the real JS SDK under the proposed local rules; completion
receipts remain unchanged. Two independent SDK readers and a reloaded reader recover the record. The emulator
also denies direct owner/outsider deletion, overwrite and atomic parent-patch attacks.

Old UIs do not understand the new resolution and may still display unfinished tasks, move them or alter their
old `done` flag under their existing permissions. **We do not promise old-client UI correctness or prevent their
existing plan edits.** We preserve resolution truth and make the new client flag changed source evidence for
review. Record-only retention cannot retroactively repair unrelated old-client history corruption.

## UNDO_CONTRACT

Undo is a new operation UUID with the exact current resolution revision, source revision and `undoOf` completion
UUID. It succeeds only while that completion remains the current active head and its source is unchanged.
The same room CAS appends the reversal receipt and sets state `open`, retaining every completion date/provenance
fact. It never restores a source snapshot, removes a record/receipt, edits `done`, or erases newer facts.

An unseen newer completion/reversal/source edit refuses Undo. A response lost after Undo is reconciled by the same
UUID. A delayed old completion response returns its old receipt plus the newer open head; the client must not hide
the task. Correction is explicit Undo followed by a new reported completion, not an overwrite of the earlier date.

## FIREBASE_RULES_IMPACT

Future builder addition: explicit `.write: false` under the new resolution sibling; owner-only reads inherit the
existing room read rule. No room/root write grant, no calendar/legacy/operational write exceptions, no changes to
fence/capture/action grants. The fixture builds this **in memory** from committed rules; deployed/generated rules
are untouched. Admin writes bypass rules, so **all new resolution schema and source checks are the dedicated
service's responsibility**, not a fictitious new rules guarantee.

Do not simulate unchanged objects via Rules `.val()` equality: child-bearing snapshots return a sentinel,
[per Firebase](https://firebase.google.com/docs/reference/security/database#val). Parent grants cascade and cannot
be revoked by child denies, [per the rules syntax](https://firebase.google.com/docs/database/security/core-syntax#read_and_write_rules_cascade).

## MINIMAL_FILES_TO_CHANGE — future, only after approval

- New `task-completion-model.js`, `task-completion-repository.js` and `task-completion-sync.js`: resolution-only
  validation/projection, account-scoped metadata/pending receipts and listener/command adapter.
- New `functions/src/completion-api.js` and `functions/src/completion-domain.js`, wired by `functions/index.js`:
  dedicated authenticated completion handler, snapshot-source validation and guarded privileged room-CAS adapter.
  Read-only `functions/src/plan-read.js` extraction only if needed to avoid duplicating authority.
  Deployment/IAM configuration must explicitly isolate this handler from existing user-scoped Action API code.
- `plan-authority.js` / `stale-plan-recovery-model.js`: read-only resolution overlay and conflict projection;
  `storage.js` or its existing account-reset seam: lifecycle binding. Do **not** change plan item merges, historical
  completion classifications or fence writers merely to retain resolution metadata.
- `planning-continuity-ui.js` / `.css`: wire the already-approved Refined A to real acknowledged operations;
  account-bound pending/error/unknown states and safe Undo. `index.html` generation/wiring;
  `scripts/functions-shared.mjs` and generated `functions/shared/` if the model is shared; generated `www/` mirrors.
- `scripts/firebase-rules-builder.mjs` plus generated `firebase.rules.json`: the narrow deny/read boundary above. Deterministic, rules/emulator,
  two-client/account-boundary and browser regressions. Historical UI consumers need separate resolution labels
  only where shown; no blanket rewrite of Review/Intelligence/Partner/timeline `done` semantics.

Existing Brain Dump promotion, Action API mutation kinds and TASK-014 tracking stay untouched. No TASK-016 work.

## OFFLINE_PROOF_RESULTS

Isolated files: `design/task-018/contract/{prototype,fixtures,contract.test,emulator.test}.mjs`.

```powershell
$env:PATH = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:PATH
node --test design/task-018/contract/contract.test.mjs design/task-018/contract/emulator.test.mjs
node --test calendar-plan-model.test.js operational-plan-model.test.js plan-tomorrow.test.js
```

**46 checks passed: 35 deterministic, 11 real local RTDB emulator tests; 0 failures/skips.**
**99 existing calendar/operational/legacy model tests passed; 0 failures/skips.**

Coverage: all three stores and ordinary/fenced representations; Action API identity; exact sibling/history
preservation; original-day `not-done` classification; account-derived keys/revisions/paths and outsider denials;
idempotency and changed-intent rejection; different-date conflict; source race; bounded contention; unknown
before/after commit and lost readback; same-ID recovery; Undo/newer resolution conflict; malformed inputs/future
version refusal; explicit account-zone date boundary; reorder/duplicate/move/generation/boundary refusals;
released merge replay/real calendar bridge replay; two SDK readers, live listener and reload; priority refusal.

The first emulator run found null-pruning in the identity marker; fixed with non-null `unmarked`, then real Undo
passed. Early fixture-only import/test-signature errors were corrected before the final run. These were isolated
proof defects, not production fixes or newly resolved expected failures. Existing audit's 18 observations still
describe the unmodified application. Production browser/full regression, physical devices, real Auth/IAM/token
revocation, streaming limits and real-data scale were not tested. Emulator admin/unsigned auth test capabilities
are not evidence of deployed authorization. No production credentials or account data were used.

## RESIDUAL_RISKS / owner decisions

1. Approve or reject the dedicated privileged-domain exception. The code-level write lens does not constrain
   a compromised Admin credential to one subtree. Require deployment/IAM, real verified-auth and negative transport
   tests before release; no fallback from existing user-scoped APIs.
2. Accept the bounded initial identity policy: refuse moves, recovery copies, duplicates and unresolved sources.
   Ordinary id reuse/byte-identical incarnation ambiguity remains an existing-model limitation. Changed source
   evidence creates a review state, never an automatic correction or deletion of completion history.
3. Whole-room CAS conflicts with timer/entry writes; three retries may reject busy rooms. It reads/writes the
   entire room wire image even though only one record changes. Reject prioritized or >16 MiB rooms. No live room
   was inspected to assess whether these bounds fit the owner's data. Priority-preserving export support or a
   narrower lock/authority design would be separately scoped only if this bound proves unsuitable.
4. Conservative plan/context revision changes can refuse Undo or flag completed work for review after harmless
   source-plan metadata changes. Old UIs still lack completion awareness. Some unknowns cannot be conclusively
   settled after transient/ABA histories; keep recovery available without claiming a definite negative.
5. Receipts are retained, so growth and payload contention require measurement. No automatic pruning policy is
   approved. Production account-switch, listener teardown and current-source convergence still need integration
   tests. These offline proofs do not establish release readiness.

## INDEPENDENT_REVIEW / READY_FOR_PRODUCTION_IMPLEMENTATION

Independent technical review is requested against the exact local contract checkpoint. Its verdict is delivered
separately; it cannot authorize the new privileged boundary or production work.

**READY_FOR_PRODUCTION_IMPLEMENTATION: NO — pending owner approval of this concrete contract, privileged boundary
and bounded limitations.** Contract proof completed locally; original TASK-018 implementation remains blocked.
No further UI design or production work proceeds automatically.
