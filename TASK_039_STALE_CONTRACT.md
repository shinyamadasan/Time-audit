# TASK-039 — local stale-session contract proof

**Local protocol feasibility: PASS, 26/26 focused tests. Integration and production: NO-GO.**

Baseline: `b662d14616e5744807304d0621f6354392d2c2be`, containing pinned main
`a9e22afba5370f426c4066c94bf216eac3cced94` and frozen PR20
`122d3835f7114503d9be5ea581227b0d95fb9d9d`. This branch adds test-only adapters,
synthetic rule variants, evidence and the owner-direct task record. No runtime, canonical rules,
Worker, Functions, approved UI, time engine or gateway source changes.

## One proposed contract

The existing direct Firebase RTDB path remains. Every ordinary plan record, keyed fenced item and
recorded entry carries reserved transport metadata:

```json
"_csWrite": { "v": 1, "baseExists": true, "baseRevision": 7, "revision": 8 }
```

`v` identifies this metadata format; it conveys no client identity or authorization. Rules keep the
existing owner/token/source/claim/tombstone/cutover predicates and additionally require:

- A non-null post-image; physical deletion cannot reset a revision or skip validation.
- A positive safe-integer next revision equal to the asserted base revision plus one.
- The asserted base revision equal to the stored revision, or zero if the metadata is absent.
- `baseExists` equal to the actual existence of the stored record. Missing and existing-unversioned
  records both have effective revision zero, but are distinct before-images.
- Existing malformed/reserved metadata cannot be silently replaced as revision zero. Revision
  exhaustion fails closed and requires explicit recovery; there is no wraparound.

Close the broad `.write` grants on `plans`, `calendarPlans` and `operationalPlans`; authorize each
record at its existing key. Append the gate to the existing `entries/$entryId` and each item under
`planFences`, `calendarPlanFences` and `operationalPlanFences`. Existing source predicates remain
conjoined. No authorization is widened. A child denial cannot override an ancestor grant; a node's
`.validate` is skipped when that node is deleted. The proof tests both facts on the real emulator.

**Client before-image rule is inseparable from the server gate.** Capture the account, physical
path, complete original wire before-image, intended delta/post-image and base exactly once when the
intent is created. Preserve untouched fields, including unknown historical fields, preparation and
origin metadata. A direct SDK transaction compares the exact before-image on every invocation and
aborts on mismatch; RTDB's transaction hash supplies commit-time compare-and-set. Never mint a new
base from retry data and reattach an old replacement. A first-null SDK cache result is not evidence
of server absence or success: retain the intent, load the record and retry the same frozen intent.
Check account ownership inside every callback and before consuming an acknowledgement.

For existing unversioned records, the first supported mutation conditionally enrolls revision one.
No mass data rewrite is required. Full before-image comparison is essential here: pre-cutover
snapshots can have different contents while both have effective revision zero. Legacy queues lacking
a trustworthy original base must remain pending for explicit comparison/reapplication/export; they
must never be automatically stamped as new revision-zero commands. A user's newly reviewed change,
including an intentional earlier description, receives a new base and is accepted normally.

This is optimistic concurrency, not proof of human intent. An authorized owner can deliberately
submit an earlier value with a current base. A broken adapter can also fabricate that transition;
the unsafe-adapter control demonstrates that the rules admit it. No deterministic rule can infer
the difference. The guarantee is rejection of the actual legacy blind/merge writers and of stale
base writes, combined with exact-before-image checks in the supported adapter. It is not a claim
that arbitrary owner-authenticated code cannot lie about its intent. No version strings or refresh
prompts are part of the security boundary.

## Actual local results

Command: `node --test --test-concurrency=1 stale-contract/proof.test.js`, with
`TZ=America/Phoenix`. Node24, real cached Firebase RTDB emulator4.11.2, Firebase JS SDK10.12.2.
Only synthetic `alice`/`bob` namespaces on localhost were accessed. Emulator auth tokens prove rule
evaluation and account separation, not live authentication provisioning.

| Focused evidence | Result |
|---|---|
| All three ordinary plan stores, both accounts | Unversioned enrollment and legitimate description edit/revert accepted; stale/direct/descendant/whole-parent writes denied |
| All three keyed fence stores, both accounts | Description edit/revert accepted; stale writes, origin alteration, prohibited moves, physical deletion and resurrection refused |
| Actual pinned pre-release merge, SDK transactions and offline queues | Refused in all three ordinary stores for both accounts; server contents unchanged |
| Real SDK conflict retry | Callback observed revisions0 then1; frozen stale intent aborted, retained unchanged; later current intentional revert committed |
| Account changes and cross-account access | Callback refuses foreign owner; foreign reads/writes refused; no cross-account mutation |
| Recorded entries, both accounts | Legitimate correction/delete/explicit Undo accepted; stale time replacement, physical removal and unauthorized resurrection refused; historical fields and unrelated tombstone preserved |
| Atomic two-plan move using per-record expectations | Both ends commit together; stale source or destination and duplicate update reject without partial mutation |
| Existing Action API fences | Scoped create, owner edit, server-timed move lock and atomic move accepted after wrapping their existing payloads; lock/token/cutover refusals retained |
| Strict mutated-rule controls | Removing revision comparison, existence comparison or ancestor closure admits the targeted unsafe write |
| Other negative controls | Unsafe fresh-base reauthorization is demonstrably admitted; invalid revisions, exhausted revisions and unknown before-images fail closed |
| Pre-cutover unversioned snapshot mismatch / first-null cache | Exact comparison aborts stale intent despite equal revision zero; retained unchanged intent can succeed after valid cache loading |
| Before-image and receipt compatibility | Reveals the two required adapter corrections described below; semantic edits still change the existing API revision |

**Final: 26 passed, zero failed/cancelled/skipped/todo.** See RESULTS.json, OBSERVATIONS.json,
TEST_ONLY_RULES.json and emulator-final-26.log.gz in `review-artifacts/task-039-stale-contract/`.
The historical three-file fixture closure is copied from exact baseline Git blobs into
`stale-contract/fixtures/`, avoiding checkout line-ending conversion. PINNED_FIXTURES.json records
the original SHA256 values; this exact-byte fixture run also passed26/26.
The observations and rule mutations are not deployed product code. Pending-intent retention here
is verified in the isolated adapter; durable production reload/quota/recovery handling is not
implemented or claimed by this proof.

Earlier attempts are retained with their outcomes. The initial sandboxed runner could not spawn;
the explicitly authorized local subprocess run succeeded. First emulator run:13 pass/7 fail,
exposing repeated fixture timestamps, transient SDK cache lifetime and the actual operational
preparation omission. Corrected proposed retention/fixtures and added controls:23/23, then25/25,
then the final26/26. No failed attempt is substituted for a passing release gate.

## Minimum required implementation, not performed here

1. **Rules builder and generated artifact:** the narrow record grants and additional gate above;
   retain all existing source/Action API predicates. Canonical rules remain unchanged in this proof.
2. **Existing client repositories and writers:** preserve the owned original wire before-image and
   transport metadata separately from mutable projections/pending post-images, across local saves,
   reloads and account changes. Update `storage.js` (`syncPlans`/`syncEntries`),
   `calendar-plan-sync.js`, `operational-plan-sync.js` and `plan-fence-sync.js`, with their existing
   account-bound repository/persistence boundaries. Capture bases before mutation, retain conflicted
   work and display a refused/conflict state. Unknown-base legacy work needs explicit recovery;
   never clear it or announce a save on denial. Bound any automatic retry and preserve idempotent
   acknowledgement handling by exact committed-image comparison.
3. **Untouched-field retention:** existing merge functions produce explicit top-level shapes and
   can omit unknown fields. The operational model also drops valid preparation when RTDB has
   pruned empty ID arrays. The proposed adapter overlays the intended result onto the complete
   before-image and retains untouched preparation/metadata; it does not treat absence in a merge
   projection as an intentional deletion. Intentional preparation confirmation remains accepted.
   Production integration needs targeted model/repository tests for this case; no model fix was
   silently applied here.
4. **Existing Action API compatibility:** `functions/src/user-scoped-rtdb.js`,
   `plan-create-action.js` and `plan-mutation-action.js` must carry the record expectations on every
   mutation, including move locks. Replace the ordinary legacy/calendar whole-collection move PUT
   with an atomic multi-path update of the two changed records, checking each before revision and
   existence. This is demonstrated on RTDB without a new service, schema store or authorization
   principal. Keep the existing scoped fenced move/lock protocol and receipt state machine.
5. **Semantic revision compatibility:** `functions/src/plan-read.js` currently hashes unknown item
   metadata. Exclude the reserved `_csWrite` transport metadata from its semantic `itemRevision`,
   just as it already excludes `moveLock`; otherwise enrollment/locking changes existing receipt
   semantics even with unchanged item content. The proof demonstrates the incompatibility and the
   minimal exclusion. Existing receipts/retry scenarios still need affected integration tests.
6. Generate governed runtime/shared mirrors after approved production changes. No approved UI,
   OAuth/consent/scope forwarding, Brain Dump/Eisenhower/reminder or time-accounting behavior needs
   redesign. Test their affected adapters, exact parity and unchanged strict time scenarios when
   production source changes; do not infer those future passes from today's fixture proof.

The exact repository file surface must be finalized during bounded implementation; these are the
identified write/persistence boundaries, not authority to modify unrelated architecture. The reserved
metadata name must be collision-checked rather than overwrite any existing historical field.

## Release implications and next decision

**Feasible non-gateway contract; not an integrated release candidate.** Current unchanged b662d14
clients and existing backend writers do not implement it and will be denied by these test rules.
Deploying the rule variant alone would interrupt supported saves/time sync and API operations.
Deploying a new client alone under old broad rules would leave destructive old writes possible.
Coordinated, separately approved cutover/forward-recovery policy is required, including retained
old-session offline work, collision/writer inventory, conflict/recovery UX and appropriate canaries.
Do not downgrade to an old client, relax rules, reset revisions, clear storage, replay old queues or
restore an older database. Refresh prompts remain advisory. A temporary write hold may be needed
to make an authorized rollout coherent; no live rollout design or action is authorized here.

All existing production/approved regression test bytes are unchanged. PRESERVATION.json binds this to the
baseline and earlier source-bound evidence: its45 Worker tests/bundle/parity and prior hosted PR20
results are reused. No full suite or seven strict time tests were rerun because their source bytes
were not changed. Of1108 baseline paths,1053 match the prior checkout byte-for-byte;52 inherited
proof/fixture/evidence text paths have checkout-only CRLF/LF differences, listed explicitly in
PRESERVATION.json, and the three append-only task/log documents change. Their original Git blobs
and evidence remain intact in the frozen baseline worktree; no earlier evidence file was edited.
No new Guardian or independent-provider approval is claimed.

The **smallest next authorization** is bounded LOCAL implementation/integration of this direct-RTDB
contract at the existing client/rules/API boundaries, with durable pending/conflict recovery and
focused adapter/receipt/time/parity verification. Gateway work remains frozen and is not required
by this demonstrated approach. Only after that exact combination is approved can exact-head/base
Guardian, hosted CI and separately authorized production compatibility/rollout gates proceed.

PR20 is unchanged. No push, merge, deployment, live rules, production access/write or phone testing.
**Guardian NOT RUN / NOT PASSED. Production NO-GO.**
