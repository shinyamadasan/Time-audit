# PR20 — final local reconciliation and stale-session safety STOP

**Source reconciliation PASS. Release safety closure BLOCKED. Production NO-GO.**

Branch `task-039-final-local-safety` is based on pinned main
`a9e22afba5370f426c4066c94bf216eac3cced94`. Approved PR20 input:
`122d3835f7114503d9be5ea581227b0d95fb9d9d`, common base
`ce24092f4037cbacd9e2cf79a7465638bb8ef2ec`. October28,2026 America/Phoenix.
Exact candidate SHA is the local checkpoint reported in the owner handoff; SOURCE_HASHES.json binds
reviewed candidate/proof bytes without a circular self-commit hash.

## Reconciliation and preservation

413 paths imported from the approved PR20 patch, verified against original Git blob IDs/hashes.
No executable overlap with main: its Worker offline_access/consent/test changes are retained exactly.
Only the three known documentation conflicts were resolved: current-main CHANGELOG/TEST_REPORT
history plus PR20 append-only tails; TASKS retains main's TASK038 closure and adds only the new
owner-direct TASK039 entry. No git merge, main/PR update, product rewrite or gateway import.

Approved root/www UI, planning/Daily Command Center, Brain Dump/Eisenhower, reminder, timer/accounting,
source guards, generated rules and approved regression bodies are exact PR20 imports or unchanged
main bytes. Full earlier source-bound evidence is reused for this unchanged surface. Main's Worker
only forwards the one scope required per tool; offline_access is consent/refresh authority, not a
new backend/domain scope. No backend redeployment requirement is inferred from this reconciliation.

Actual local checks:

| Check | Result |
|---|---|
| Worker OAuth/consent/scopes/both-account tests | 45 passed, no failures/skips |
| Worker bundle | dry-run PASS, no upload |
| Root/www runtime closure | 98 files byte-identical |
| Functions shared sources | exact parity PASS |
| Generated Firebase rules/builder | exact parity PASS |
| Focused local emulator/SDK safety observations | 10 passed, no final failures/skips |

The ten observation passes prove the described behavior and incompatibility; **they do not mean a
safe replacement rules contract passed**. No full root/browser/fence/phone audit was repeated.
Prior hosted success remains bound to122d383/ce24092; this new composition still needs exact-head/
a9e22af hosted CI and Guardian before any release. Local test runtime is Node24; hosted Node22
verification of a future approved final combination remains required.

## Smallest rule variants investigated — test only

Canonical firebase.rules.json and its builder are unchanged. Three isolated emulator variants:

1. **Preparation presence:** for existing legacy/calendar/operational plan records, require an
   existing preparation child to remain present on a non-delete replacement. Both accounts' old
   mergeDatePlans omissions are refused; current model saves succeed and retain preparation/time/
   tombstones. A genuinely queued old SDK write is refused on reconnect. This is useful but incomplete:
   firstPreparedAt can still be replaced; whole-plan deletion skips that node's validation.
2. **Description freeze:** retain description equality while an array slot retains the same item ID.
   It rejects a stale overwrite, but also rejects an actual current PlanAuthority.updateItem edit.
   Reordering/changing array positions bypasses identity-sensitive equality at that physical slot.
   No assertion claims this variant safely covers arrays or legitimate description editing.
3. **Entry timestamp monotonicity:** require updatedAt not to decrease in addition to existing
   tombstone rules. An older queued entry is rejected, but a stale activity edit freshly stamped
   after the remote edit passes. A legitimate activity revert can have the identical entry replacement.
   This is a source-compatible wire counterexample, not a claim that the real browser editor was
   executed in this focused case. The existing editor reconstructs mutable entry fields with Date.now.

Existing Brain Dump source-change claim refusal remains enforced. Both-account read/write isolation,
physical entry deletion refusal, tombstone resurrection refusal and untouched historical time bytes
pass with the preparation variant. These positive subsets do not resolve the incompatibility below.

## Precise incompatible transition and required STOP

The current task editor allows description changes. The proof calls actual PlanAuthority.updateItem
on a valid legacy plan and changes `Protected context` to `Earlier description`. The current merge
and the exact pre-release old merge can produce the **same full plan replacement** when the old
session retained that earlier description and stamps an ordinary edit after the server's newer edit.
The controlling existing inputs are identical: authenticated UID, path, stored data, proposed newData
and all writer/timestamp fields. No trusted intent/before-image/client generation distinguishes them.

The verified full-transition SHA256 is
`0ea95d1ef9b1032f807fa6bcbdb762ab9007a5243854d8a8ba6bb8209c6bf1a4`.
The presence variant permits both; the description-freeze variant denies both. Any deterministic rule
over those identical existing inputs must make the same decision. Requiring version strings or refresh
prompts cannot change that fact; old owner-authenticated code is not a distinct security principal.

Thus the **unchanged PR20 direct-owner replacement protocol** cannot both reject every demonstrated
destructive stale metadata replacement and preserve all currently supported intentional edits.
This is not a claim that every future non-gateway contract is impossible. A changed write-intent/
revision/retention contract could expose additional information and must be separately designed/proven.
The demonstrated collision triggers owner stop6. No canonical-rule patch or partial protection is
offered as deployable, no workflow is silently disabled, and no gateway/redesign was started.

## Smallest viable alternatives and one next authorization

Recommended next authorization: **bounded LOCAL design/offline/emulator proof of an explicit
non-gateway revision/before-image and protected-metadata retention contract**, using the existing
direct RTDB path. Require untrusted old blind writes to fail while current edits retain conflicts/
pending work and preserve supported saves/carries/deletes/Undo/time behavior. Scope stable plan/item
addressing and transitions only as necessary, including the existing array-identity and deleted-node
validation limitations. Return the exact proposed contract/minimal client+rules files for approval
before integration or live changes. This is a proposal, not authority to begin it here.

Alternative decisions, requiring explicit owner approval, are to restrict the affected mutable
operations under a documented maintenance/read-only policy, or later select a trusted command
boundary. The former does not satisfy today's full-functionality scope; the latter includes the
frozen gateway as only one possible future workstream. Neither is silently adopted.

Use only the approved time-safe release as forward-recovery baseline. The raw/metadata-patched older
fallback remains rejected, including its seven strict-time failures; no old-client rollback is approved.
Do not clear browser storage, replay historical writes, restore a database, weaken source fences,
resurrect tombstones or change account mappings. Refreshing sessions is helpful UX but not enforcement.

## Remaining release gates

- Resolve and approve the above write-contract incompatibility, then exact-source integration proof.
- Focused independent review of this local composition/STOP evidence is recorded in the own packet;
  same-provider review is not Claude Guardian or GitHub human approval.
- Actual security/quality Guardians must assess the final approved head/base/rules/recovery/policy.
  Guardian remains **NOT RUN / NOT PASSED**. Old green CI and Codex review cannot waive it.
- Required hosted test/fence checks must bind the final approved head/a9e22af combination (and a
  rechecked base), followed by separately authorized compatibility/rollback capture, reviewed rules/
  readback and bounded canaries, then separately approved publication/main merge.

PR20 is frozen and the gateway remains frozen atc224180 outside this candidate. No push, PR update,
merge, deployment, live Firebase rules/data access/write or phone testing occurred. Production **NO-GO**.
