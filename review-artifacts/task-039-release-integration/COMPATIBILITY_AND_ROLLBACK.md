# Compatibility and rules-first release requirements

This is a local integration task. No live rules, accounts, deployment revisions, bindings or data
were read or changed. TASK032/TASK029 handoff deployment markers are historical evidence, not a
fresh inventory of what serves production now. Capture actual artifacts only within a separately
authorized release operation; keep private identities/configuration outside public logs/repo.

## Compatibility evidence

| Boundary | Retained contract and local verification | Deployment-stage requirement |
|---|---|---|
| Commitments | Current-main root/shared/www model preserved. Date-only absent time equals null; malformed/timed validation remains strict. Real warm-cache upgrade loads the pinned fixed model. | Verify actually published old/new client versions read valid date-only records for both accounts. |
| Ownership | Current-main API/Worker identity, second-subject mapping, fail-closed configuration and subject-derived rooms unchanged; independent two-user tests pass. | Capture actual deployed revisions and binding/config hashes; preserve both mappings and grants. |
| Planning/source protection | Approved rules source exact; no new rule authored. Combined emulator gate includes ordinary/fenced legacy completion plus source-change refusal, old-client compatibility and mutation attacks. | Rules first, live guard verification, then old/new-client canaries. Failed unsafe promotions must remain refused, with original captures/time intact. |
| Recorded time | Approved strict recovery/collision/Save/Stop/account guards retained; original seven strict scenarios and actual SDK adapters pass. | No migration, storage clearing, record replay, historical overwrite or tombstone resurrection. |
| Reminders | Approved worker/protocol retained; prior owner Android delivery evidence preserved. Model-cache fix changes no reminder timing contract. | Worker/process termination remains an existing browser delivery limit; no always-on guarantee or new phone gate is claimed. |

## Authorized rollout order (not executed)

1. After hosted CI and formal head/base approval, capture the actually serving web/client artifact,
   rules file/digest, deployment IDs and rollback artifacts. Capture Functions/Worker versions and
   redacted configuration/binding/IAM hashes if those components are in the release. Verify the
   rollback client retains TASK032 compatibility and both-account ownership controls; old visual or
   reliability branches alone are not a safe whole-stack rollback target.
2. Obtain explicit production authorization. Deploy only the reviewed Firebase rules **first**;
   verify the live guard and backward compatibility before client publication. Do not weaken fences.
3. Confirm live backend/Worker protocol compatibility. Current main contains legacy-completion code
   that is not assumed deployed. If a reviewed component update is needed, obtain its explicit scoped
   authorization and preserve all bindings/identity mappings. Compatible backend changes precede
   dependent Worker exposure. No unnecessary redeployment or old rollout instructions replay.
4. Run authorized automated old/new-client and two-account canaries with a bounded, separately
   authorized canary identity/data plan. No extra owner phone walkthrough; no unapproved personal
   record writes. If compatibility/guard verification fails, stop before publication.
5. Separately authorize integrated client publication. **Merging main is a publication action**
   because Pages auto-publishes it; the CI/PR approval explicitly excludes that action.

## Safe rollback

- Hold/stop the new publication on failed canaries. Roll back to the captured compatible client
  artifact through the reviewed hosting/repository process, with explicit production authorization.
  Do not force-push/reset main or blindly deploy ab0c601/bd96ccc over current-main compatibility.
- Retain protective rules during client rollback. A rules rollback requires its own review and
  authorization; no rollback to weaker source-protection behavior is automatic.
- If Functions/Worker were updated, restore captured compatible revisions/configuration/bindings as
  a coordinated authorized operation. Retain both users' mappings and grants. Do not reuse historical
  rollback commands that disable the second account or point to obsolete one-user revisions.
- Preserve every valid historical record, account cache and deletion marker. Do not restore an old
  database snapshot, re-import time, undo TASK032's authorized tombstones or clear browser storage.
