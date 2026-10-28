# TASK-039 formal fallback review — APPROVED / HELD

**No confirmed implementation must-fix findings. Production remains NO-GO.**

Reviewed PR: https://github.com/shinyamadasan/Time-audit/pull/20

- **Head:** `ddb6c6d4456085ca30b8cc8ccae847dcb791792d`
- **Base:** `ce24092f4037cbacd9e2cf79a7465638bb8ef2ec`
- **Approved application input:** `bd96cccfec9bb893a44bc6573d0e04356cd80333`
- **Reviewer:** `/root/task039_formal_fallback`, separate read-only Codex agent.

This is the documented **D-048 fallback review**, following the actual Claude quota failure. The builder and fallback reviewer both use Codex; this provides separate-agent review, not independent-provider review or GitHub human approval.

**Claude Guardian Gauntlet: NOT RUN / NOT PASSED.** Claude failed before reviewing or spawning its security and quality guardians. This gap remains explicit and prevents a `done` verdict.

## Acceptance and source findings

| Area | Review result |
|---|---|
| Approved application imports | Independently compared all **340 imported paths** against approved input. Only the six declared combination paths differ. |
| Current-main retention | Retained-main paths match the exact base, except permitted task/log additions. Backend, Worker, identity and TASK-032 model blobs are preserved. |
| Frozen UI and bounded integration | Reconstructed `index.html` independently: approved application plus main’s desktop PC-autostart removal, the commitments-model import-map pin and unified generation. Root/www copies match. |
| Commitment compatibility | `normalizeCommitment()` preserves absent/null date-only compatibility while rejecting competing time values. The cache fix pins the unchanged model rather than relaxing validation. |
| Planner/source protection | `normalizePreparation()` defaults only omitted persisted arrays. Planner account, target, timezone and `sameOnWire` source checks remain. Brain Dump claim arbitration and generated rules preserve authoritative source facts. |
| Recorded time and ownership | `_doQuickSave()` retains its centralized busy/account/device guards and accounting-cursor advancement. `restoreTimerAwayState()` and `syncTimerState()` retain owned recovery and conditional publication against newer remote decisions. |
| Reminder behavior | Keyed due receipts, terminal cancellation and stale asynchronous-message fencing remain as approved. Worker termination limitations are disclosed; no always-on delivery guarantee is introduced. |
| Protected history | Fresh read-only audit confirmed **11 protected trees / 9,091 tracked-file hashes unchanged**. |
| Scope | Direct Eisenhower insertion remains deferred. No new feature, migration, redesign, deployment shortcut or production-data operation found. |

Critical inspected paths/functions include:

- `index.html`: `openQuickLog`, `_doQuickSave`, `resetTimer`, `stopAndLog`, `doPing`, `swPostPing`, `swDeliverPing`, `swSchedulePing`, recovery handling and display invariants.
- `storage.js`: `restoreTimerAwayState`, `applyRemoteTimerState`, `syncTimerState`, `resolveEntrySync`.
- `plan-tomorrow-ui.js`: draft ownership, source comparison and `confirmDraft`.
- `plan-tomorrow-model.js`: `normalizePreparation`.
- `brain-dump-model.js`: `arbitratePromotionClaim`.
- `scripts/firebase-rules-builder.mjs`: `claimSourcePreserved`.
- `sw.js`: delivery receipts, ended-session handling and old-client protocol.
- Current-main identity binding and legacy mutation/CAS paths.

## Evidence verification

I independently verified all **24 archived logs** against their compressed and decompressed SHA256 values. Their actual results support:

| Gate | Verified recorded result |
|---|---:|
| Full browser suite | **1,027 passed** |
| Full Node suite | **2,392 passed / 1 skipped / 0 failed** |
| Firebase rules/fence/SDK/mutation | **177 passed / 0 skipped / 0 failed** |
| Worker | **44 passed / 0 skipped / 0 failed** |
| Focused combined browser checks | **30 passed** |
| Original seven strict scenarios | **21 passed** across three repetitions |
| Warm-cache regression | **3 passed**, with retained actual pre-fix failure |
| Earlier independent backend review | **86 passed** |
| Lint | **0 errors / 48 existing warnings** |
| Worker bundle | **Dry-run passed; no upload** |

The original strict-scenario file’s Git blob matches the approved input exactly. The single Node skip remains the existing opt-in diagnostic; it is not counted as a pass.

All **11 canonical source-review hashes** match. Two raw hashes differ in this fresh detached checkout because of checkout line endings; their canonical hashes and committed contents match. This is not source drift.

I did not rerun mutating test harnesses, contact production services, change files or create commits. The detached reviewed tree remained clean. `git diff --check` passed.

Hosted CI is monitored by the parent separately. At the latest supplied checkpoint, the required Firebase check had passed **177/177** and the full `test` job was still running. **This review does not claim that pending job passed.**

## Verdict and remaining gates

**Recommended status: `approved`, HELD — never `done`.** No source rework is requested. The integration touches time/sync/security surfaces, and the Claude Guardian Gauntlet has not passed. No repository status was changed.

Release still requires:

1. Terminal success for both required hosted checks on the exact reviewed head/base.
2. Explicit disposition of the missing Claude Guardian Gauntlet through the repository’s owner/reviewer process; this fallback must not be represented as that gate passing.
3. Separately authorized live compatibility and rollback-artifact capture.
4. Explicit reviewed rules-first rollout, live source-guard verification and older/newer-client/two-account canaries.
5. Separate client-publication authorization; merging main can publish Pages.

Rollback must retain source fences, TASK-032 compatibility, both-account mappings and all historical records/tombstones. No rules rollback, database restoration or weaker historical client deployment is implicitly approved.

**Stop with the PR draft and held. No merge, auto-merge, production deployment, Firebase rules deployment, additional phone testing or protection bypass is authorized by this verdict.**
