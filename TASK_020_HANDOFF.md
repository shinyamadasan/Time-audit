# TASK-020 — local reconciliation (2026-10-22)

Current authority: owner message "ChronaSense TASK-020 — Isolated Reconciliation" permits local
reconciliation, verification, independent review and a local commit only. No integration, push, PR update,
publication, installed-companion action or AI Dev OS change is authorized. This section supersedes the
historical release sequence below; the older integration approval cannot bypass current prerequisites.

- Reverified remote main: `1f171a29b55819c7b96872234a1b095d1e80d48c`.
- Reverified PR #8 head: `780e733fe1697bc78a4ea5fa992ddc96ecdf2cbe`.
- Isolated branch: `task-020-reconcile-20261022`; explicit normal merge, no rebase/history rewrite.
- Observed conflicts: TASKS.md, REVIEW.md, CHANGELOG.md and TEST_REPORT.md only. Both sides' historical
  records are retained. TASK-016/TASK-018 remain done; TASK-015/TASK-017 remain approved.
- The three reviewed HUD files remain byte-identical to `234a5ca4fbd998d39519949c1fd72363acc12222`.
  Main's complete intervening releases, including backend/rules, web runtime, generated mirrors and tests,
  are preserved. No infrastructure, timer, sync, data or runtime behavior is changed by reconciliation.
- The old review input `8b02066` changed nine files; review commit `780e733` added REVIEW.md as the tenth.
  This explains the historical nine-file statement. The runtime diff itself is six insertions and one
  deletion, including a comment; those Git counts are not six wholly new runtime statements.
- Publication copies use path placeholders; original pilot history and the private archive remain intact.
  Sanitizing current text does not erase paths already published in PR history.

Fresh local verification passed: companion 60/30 assertions, bridge 33/33, focused browser 14/14;
full npm 2,269 Node passes, zero failures, one existing opt-in skip, plus legacy 455/455;
Firebase emulator/fence 151/151; full browser exit 0 with 970 expected outcomes (963 ordinary passes
and seven documented expected failures; CLI summary says 970 passed). Lint has zero errors and
48 pre-existing warnings; 95-file mirror, rules and shared-function consistency checks pass.
The known offline-timer/logging expected failures remain unfixed and outside TASK-020.
Local versions: Node 24.19.0, PowerShell 7.6.7 and Java 21; hosted CI uses Node 22.
Code Health / applicable AI QA pass by trace, preservation audit and these local checks. No new
symbols, CSS, handlers, schemas or architecture were introduced; reference-document updates are unnecessary.
Generic QA workflow writes/pull/rebase/release steps are superseded by the owner's exact ten-file,
local-only scope. New native/phone/production acceptance remains unverified, as stated below.
The new independent local review belongs in a separate REVIEW.md entry; it conveys no publication approval.
The tested staged tree was `618197a21d417dddc708292b3a5afc6fbf3765c2`; subsequent edits are evidence only.
Detailed logs and the final review/tree/commit binding belong only in the uncommitted private packet
`release-verification/task-020/reconciliation-20261022/`; do not publish that directory.
The historical CI run `39449147372` passed both jobs on `780e733` against `bb171a2`; it does not verify
this reconciliation against current main. Fresh hosted CI requires separately authorized publication.

Integration remains held: the retained TASK-021 trust-boundary investigation ended at STOP with no approved
runner repair/trusted bootstrap. Do not invoke Run-Merge, release scripts or dispatchers. A separately
approved integration route must address that prerequisite without bypassing protection/checks.
For a future release, record its then-current pre-integration main for rollback and reverse only this
HUD delta if needed; do not reset main to `bb171a2` and lose subsequent TASK-016/TASK-018 releases.
No fresh native WPF/installed-companion, signed-in production, first LNA prompt or physical-device
acceptance is claimed. H-1, background staleness and clock-jump limitations remain outside this task.

---

# Historical TASK-020 reviewed HUD pilot integration (2026-10-20)

Registered 2026-10-20 under the owner's current direct instruction. Existing source-integration approval includes automatic Pages publication. Installed-companion replacement/restart is excluded.

## Exact candidate

Original reviewed commit: `234a5ca4fbd998d39519949c1fd72363acc12222`.
Baseline and rollback reference: `bb171a287ac67d76ae27634b5227bc24f66919de`.
Matching branch: `task-020`, in the separate `<original-task-020-checkout>` checkout.

The original commit remains in history. Its three HUD files are byte-identical; subsequent changes are explicit task registration, handoff and append-only evidence, then formal-review metadata. No original advisory result is represented as a past task approval. The task is submitted at status review; only the actual formal reviewer may choose approved or rework. The owner explicitly requires the held gate even if the implementation is otherwise reversible.

Runtime effect: Hide remembers the authoritative tracking start and lifts when a different activity starts. Same-session heartbeats/title changes retain hiding, and Focus work/break hiding is preserved. Six runtime lines added, one replaced. No application timer/heartbeat/data/auth/rules/transport or global-system changes.

## Existing evidence, accurately scoped

Durable archive: `<private-pilot-archive>/2026-10-20-hud-234a5ca`.

- `evidence/baseline-regression.log`: new regression fails on baseline at ActivitySwitchLiftsHide.
- `evidence/companion-normal.log`, `companion-dogfood.log`, `hud-bridge.log`, `hud-browser.log`: 60/30 assertions, 33 bridge and 14 browser tests pass.
- `evidence/npm-test-complete.log`: full npm test exit 0, 2190 Node passes plus 455 legacy cases, zero failures, one documented opt-in skip.
- Original lint: zero errors, 48 existing warnings; mirror and rules parity pass. Original full browser/emulator suites were not run locally; required hosted CI must run them for the formal candidate.
- `PILOT_REVIEW.md` in this branch: fresh independent advisory verdict ship, no actionable findings; both companion suites independently rerun. This is not the task-specific approval now being sought.
- Archive `desktop-results.jsonl`, `DESKTOP_ACCEPTANCE.md`, `desktop-after.json`: owner observed all five native WPF/tray scenarios PASS: A Hide/Show and heartbeat suppression; hidden A -> B and real tray Hide/Show; rapid stop/start C; Focus -> hidden Break -> Show BREAK -> tracking handover; clear/empty Show/test Exit. Test HUD/sender exited; installed companion PID 25204 continued running, settings/startup hashes unchanged.
- `desktop-session-final/isolation.json`: test-only copy changed four environment/identification strings, and used existing port/origin parameters. Actual WPF and tray exercised with synthetic snapshots, not production auth/data. No signed-in production browser/device or first LNA prompt claim.

## Remaining release sequence

1. Formal task-specific review using the existing reviewer contract. Guardian results must be real or explicitly unavailable; no fabricated findings. Hold as approved at most under the owner's integration instruction.
2. Publish only task-020 and a candidate PR to trigger the existing required CI. Verify both test and Firebase fence / rules integration on the actual formal candidate; do not infer from baseline or advisory evidence.
3. Recheck exact baseline, cleanliness and HUD parity; Run-Merge.ps1 preview then Confirm under the already-given owner approval. Do not alter the runner, push main directly, force/rebase on a changed baseline, or bypass branch protection.
4. Verify final main/CI/Pages and preserve release evidence. No installed-companion replacement/restart.

## Missing prerequisite: cause and minimal proposal

The overnight pilot ran in a custom isolated branch without first registering an owner-direct TASK entry. Its fresh review was advisory and intentionally did not amend approval records. The later handoff incorrectly assumed that source integration approval alone made it eligible for Run-Merge.ps1, whose task/branch contract is stricter. This is an agent workflow omission, not a reason to weaken the gate.

Propose one small deterministic preflight in the existing procedure: verify a genuine owner-authorized TASK entry and its matching task-NNN branch before implementation; before release, verify that same task's formal held approval, exact baseline/candidate and required CI evidence. Fail with the missing prerequisite before describing a pilot as integration-ready. This is a proposal only; no shared procedure or infrastructure was edited.
