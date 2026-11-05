# TASK-031 — safe combined planner candidate

Local branch/worktree: `task-031-safe-planner` / `.worktrees/task-031-safe-planner`.
Base: TASK-028 `17608cdd19900290843d0a86d29bddb5139d5c44`; design reference: TASK-030 `07411dd`.
Owner's October 26, 2026 decision defers direct Eisenhower-to-draft insertion and authorizes the existing-risk
determination/narrow fix, then the approved read-only planner. No unrelated tasks are created.

This file is a local review handoff, not merge/deployment permission. Final gate results are recorded below
and in `TEST_REPORT.md`. Original TASK-028, TASK-030 and audit TASK-031 remain protected.

## Existing production-path exposure and narrow correction

The demonstrated overwrite is reachable through the existing application workflow, independently of the
proposed Add to Tomorrow integration:

`BrainDumpUI.doToday` / `confirmSchedule` / tray Today/Tomorrow → `promoteFromUi` / `scheduleTo` →
`promoteCaptureToPlan` → `BrainDumpSync.claimPromotionRemote` → `arbitratePromotionClaim`.

The UI first stamps a candidate from its local source; the transaction can then see another device's newer
active source. The pre-fix claim rank outranks that newer unclaimed record and replaces its text/answers.
Actual application APIs permit the race: triage is local-first with an asynchronous push; handled captures
can be edited and reopened. A delayed listener/cache or transaction retry can therefore expose it through
ordinary Do Today/Schedule, without any new planning feature.

Four focused before-fix production-path cases failed because the unchanged code reported success instead
of refusing changed source. The corrected fixtures use independent repositories and the actual sync bridge
with a shared transaction-shaped fake room. The first setup attempt had invalid synthetic creation/triage
ordering and was corrected before counting the four reproductions. No real accounts or records were read;
this proves code-path exposure, not a measured production incident or count of affected historical records.

The narrow correction does not extend the promotion intent:

- Existing terminal, competing/revoked claim and exact-retry rules retain precedence.
- A fresh claim whose normalized source ID/text/importance/urgency/status differs aborts with no plan write.
  This protects both a stale local cache and a newer local classification whose ordinary push is pending.
- A matching claim overlays only claim/stamp fields on the authoritative remote source, retaining creation
  attribution, reopen count, claim epoch and expired-claim provenance; timestamps do not roll back.
- A typed `source-changed` outcome asks the owner to review and retry. Existing ordinary synchronization
  merges the result; it does not discard a newer unsynced local edit or silently promote another version.
- A narrowly added `claimSourcePreserved` predicate in the existing rules builder's `newClaim` requires
  unchanged text/importance/urgency/status. This is necessary because unchanged server rules would still
  authorize the exact stale payload from an older installed client. Ordinary source edits remain permitted.
  No wire fields, schema version, destination identity, fence or promotion protocol changes.
  Older clients can receive their existing generic refusal/offline message for a stale claim; refreshing
  to the corrected client provides the specific source-changed wording. Denial does not delete the capture.

This server predicate addresses the demonstrated initial-claim overwrite. It is not a claim that every
possible old-client source/provenance mutation has been audited or prohibited. No general audit was done.

Retained positive controls include exact retry identity, terminal/revoked/competing claims, unknown pending
and late settlement, account changes, wire null-pruning, higher-epoch recovery and source attribution.
The original TASK-031 safety-gate evidence remains unchanged and still correctly describes the old baseline
and the separately unsupported edited-draft promotion contract.

## Approved UI mapped to existing components

| Owner requirement | Integrated behavior |
|---|---|
| Preserve approved My Day | TASK-028 dashboard, timeline, entry/timer algorithms and actions remain unchanged; index changes only versioned runtime URLs. |
| Floating desktop / mobile sheet | Existing Plan Tomorrow overlay, 880px desktop, dimmed My Day, full-height phone, one body scroller and header/footer outside it. |
| Top 3 / preparation | Existing item IDs, kinds, cap, open-day/rescue, schedule controls, reconciliation and `PlanAuthority.confirmPreparation`; no second planner or task store. |
| Worth Considering | Up to two explicit Q1 and two Q2 captures from the current account's existing repository, interleaved while retaining source order in each quadrant. Cache availability is labeled; nothing is auto-classified/ranked/promoted. |
| Existing source workflow | Read-only source buttons navigate with existing `showView('braindump')` in the same tab. A return control resumes the suspended planning draft; existing promotion owns all cross-store operations. |
| Draft protection | Bounded per-account session checkpoint tied to the original target, source snapshot, timezone and exact draft instance. Explicit Keep editing / Keep draft and close / Discard; old DOM cannot refill a replacement draft. |
| Editing / scheduling | Existing schedule/day-offset controls remain. Planned headline and optional notes edit the existing draft item metadata; no capture text/classification is edited. |
| Honest outcomes | In-flight and unchanged submission guards; actual localSaved/syncPromise outcomes; failed, unconfirmed, changed-source and changed-owner/day states preserve recoverable work and do not claim current cloud confirmation. |

Draft checkpoints are uncommitted UI state and recovery metadata in `sessionStorage`, bounded to 128 KiB.
They are never loaded as Plan Authority truth and do not hold promotion claims or a second authoritative
task list. Recovery requires the same account and original target; Save revalidates loaded owner, canonical
target, source plan, Personal Day and timezone. A changed source is displayed for review, not silently
merged or overwritten. Starting from latest requires explicit discard. An ended/default target is never
silently re-owned as a new tomorrow.

The existing immediate routine-skip and reconciliation-reason actions remain existing domain actions;
the dialog does not promise to roll them back on Cancel. The reconciliation write seam now also checks
owner, current canonical source/item and source editability, so an old textarea cannot write after an
account switch or rollover. A source task changed elsewhere requires a new review.

Direct “+ Add to Tomorrow” from Eisenhower remains **deferred**. The UI has no new selection, claim,
promotion or cross-store save coordinator. That follow-up needs the original safety-gate contract decisions;
this handoff documents it without creating another task or blocking the read-only release on it.

## Independent review and refinements

Read-only independent reviewer `/root/task028_independent_review` confirmed existing exposure and recommended
semantic mismatch refusal instead of unconditional remote rebasing, which could lose a newer local edit.
Its narrow-fix recheck found no must-fix and requested explicit recovery/provenance/callback retry coverage.

The first integrated UI pass identified five must-fix lifecycle cases; all now have targeted regressions:
discarded-form recapture; Normal/Rescue partial-input loss; mutable mode controls during pending Save;
late completion stealing navigation/focus; and reconciliation writes after account/day changes. Corrections
use draft-instance DOM binding, per-form retention, full mutable-region inertness plus signature guards,
open-instance-only closing, and canonical write-context checks. The reviewer's source recheck found them fixed.

Independent review also required the narrow server rule to protect the demonstrated old-client payload,
not just a voluntary update/reload instruction. Final rule/fence and exact-candidate source review passed:
161/161 fence checks and no remaining must-fix. Review is not formal Claude release approval, and the reviewer does not claim
production or physical-device verification.

## Verification — final local candidate

- Before-fix corrected production-path regression: 0/4 passed, four expected failures (unsafe success).
- Model/sync/promotion after correction, including additional source text/reopen/provenance/retry cases:
  101/101 passed. Rules interpreter/builder: 36/36 passed.
- Firebase fence: 161/161 passed, no skips (103 real emulator/rules, 20 real-SDK, 38 mutation). Removing
  `claimSourcePreserved` allows the prohibited old-client write; the committed predicate refuses it.
- Focused integrated app journeys, account-bound receipt and sync-order regression pass. Final focused
  reconciliation/range/planning/Tomorrow-view set: 87/87 passed, including all new planner cases.
- Lint: zero errors/48 existing warnings. Runtime closure: 97 byte-identical mirrored files. Generated
  shared-model/rules and whitespace checks pass. Worker CI: 32/32 plus bundle dry run, explicitly no upload.
- Full Node gate passed twice, including after the UI-only source-comparison correction: 2321 Node-runner
  tests, 2320 passed, one existing opt-in diagnostic skipped; legacy 455/455. The skipped cross-repository
  lower-case-drive control requires `CROSS_REPO_COMPAT_CONTROL_PROOF=1` and was not enabled.
- First full browser: 982/994 passed, 12 failed. Eleven were retained tests expecting permanently visible
  secondary sections; they now explicitly disclose them while keeping the original domain assertions.
  One was a real UI false conflict: ordinary sync sorts raw items by ID. Before/after snapshots show
  identical fields with only array order changed. A deterministic item/key-order/null-pruning regression
  failed before the correction and passes afterward. The UI now sorts a copy and reuses existing
  `sameOnWire`; substantive source edits/deletions still refuse. No sync/merge/domain algorithm changed.
- Final complete browser gate: **995/995 passed**, exit 0, two workers, 22.6 minutes. No retry, skip,
  deadline increase or weaker assertion was added. No other heavy suite overlapped the full browser run.

Every attempt and final outcome is recorded in `TEST_REPORT.md`. Coverage is not measured. Fixture
setup/retained presentation failures are disclosed rather than counted as passing runs.

## SELF_REVIEW and applicable QA

Code-health review: existing preparation, claim, Plan Authority, field/time validation and wire comparison
are reused. New state is limited to the presented draft/checkpoint/receipt/lifecycle; no speculative
task store or execution service. Descriptions/headlines are escaped, CSS uses existing tokens, touched
inputs are 16px and source-specific handlers remain referenced. Independent must-fix findings were fixed
before the final gates. Code judgment is `ship-pending-human-review`; all final automated gates passed;
headless checks cannot approve real-device feel or owner visual acceptance.

`INVARIANTS.json` proves all 19 protected My Day/domain files unchanged and `index.html` changed only in
the two runtime generations. This includes timer/heartbeat initialization/exits/device guards, gap/overlap
functions, recording schema, authority, Personal Day resolvers and existing promotion construction.
The original TASK-028/TASK-030/audit TASK-031 and all review artifacts match `PROTECTED_BASELINES.json`.
The original audit's blocked status/evidence is deliberately preserved; this separate current owner-direct
entry is the execution contract for the narrowed safe candidate.

Repository ownership takes precedence over legacy QA instructions to edit Claude-owned STATUS/planning/
decision documents. Human-check and implementation evidence is recorded in this permitted handoff/logs.
No pull/rebase is run in another worktree; the owner-selected exact TASK-028 base is retained. No unrelated
files or secrets may be staged. The rules integrity boundary stays held for formal review/owner release.

## Actual application screenshots

`review-artifacts/task-031-safe-planner/screenshots/` contains actual local application renders at desktop,
small laptop and phone sizes, plus phone headline/notes editing. The fixture is synthetic, uses a fixed clock
and Asia/Manila 18:00 Personal Day, and stubs Firebase. These are integrated application captures, not the
TASK-030 standalone prototype or a signed-in production session. `SOURCE_MANIFEST.json` binds the final
source and screenshot hashes. `integrated-review.png` combines the actual laptop and phone captures.
Original screenshots in the protected review directory are untouched.

Status: `review` in this candidate's TASKS.md, held for formal review and owner visual/device acceptance.
The original audit-only TASK-031 worktree remains blocked at its original contract decision, unchanged;
the current owner explicitly deferred that direct-insertion scope and authorized this narrowed candidate.

## Release boundary and remaining human checks

No push, merge, deployment, production rules/data access or historical migration. The rules change is local
and **not protecting currently deployed users yet**. Proposed release order, only after explicit owner
approval: deploy/verify the narrow rules guard first, then release the combined client; retain existing
decision-33 compatibility and rollback gates. Do not publish the client alone and claim old-client risk solved.

Rollback preparation: the original TASK-028 commit/worktree/artifacts remain the presentation rollback
reference, and the approved TASK-030 prototype remains the design reference. Any rollback is separately
owner-authorized. Keep the narrow server source-preservation guard when rolling back presentation, since
removing it reopens the reproduced stale-client allowance. Older clients can refuse a stale claim and need
refresh/review; do not solve that refusal by weakening the rule. Never roll back user records, clear captures,
erase drafts or replay plan writes as a UI rollback step. No rollback action has been performed.

The rules/client change is an integrity boundary and stays held for owner/formal release review. Physical
iOS/Android rendering, real keyboard/scroll feel, native builds, screen-reader behavior, owner five-minute
planning acceptance, hosted exact-commit checks and signed-in production acceptance remain separate.
Headless reduced-viewport keyboard/zoom checks, synthetic device changes and local emulators do not prove them.
