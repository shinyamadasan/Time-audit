# TASK-020 — reviewed HUD pilot integration

Registered 2026-10-20 under the owner's current direct instruction. Existing source-integration approval includes automatic Pages publication. Installed-companion replacement/restart is excluded.

## Exact candidate

Original reviewed commit: `234a5ca4fbd998d39519949c1fd72363acc12222`.
Baseline and rollback reference: `bb171a287ac67d76ae27634b5227bc24f66919de`.
Matching branch: `task-020`, in the separate `C:\Users\Admin\Desktop\Vibe code\ChronaSense HUD integration TASK-020` checkout.

The original commit remains in history. Its three HUD files are byte-identical; subsequent changes are explicit task registration, handoff and append-only evidence, then formal-review metadata. No original advisory result is represented as a past task approval. The task is submitted at status review; only the actual formal reviewer may choose approved or rework. The owner explicitly requires the held gate even if the implementation is otherwise reversible.

Runtime effect: Hide remembers the authoritative tracking start and lifts when a different activity starts. Same-session heartbeats/title changes retain hiding, and Focus work/break hiding is preserved. Six runtime lines added, one replaced. No application timer/heartbeat/data/auth/rules/transport or global-system changes.

## Existing evidence, accurately scoped

Durable archive: `C:\Users\Admin\Desktop\Vibe code\ChronaSense pilot archive\2026-10-20-hud-234a5ca`.

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
