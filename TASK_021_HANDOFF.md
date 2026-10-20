# TASK-021 — project-only merge-runner output repair

Owner separately authorized this bounded infrastructure repair on 2026-10-20 after the legitimate TASK-020 held gate stalled. Baseline: `bb171a287ac67d76ae27634b5227bc24f66919de`. Branch: task-021, isolated from the approved HUD branch. No canonical AI Dev OS or other installed project is changed.

## Exact runtime scope

Only the npm subprocess block in `tools/Run-Merge.ps1` changes:

- Start `ReadToEndAsync()` on stdout and stderr immediately after process launch, before the existing ten-minute wait, preventing full output pipes from deadlocking npm.
- Capture both results after exit and append diagnostics to the existing ignored session log, including on a nonzero test exit.
- On timeout, terminate the spawned test tree (`taskkill /T /F` on Windows PowerShell 5.1/7; .NET tree kill on non-Windows PowerShell 7), retaining a guarded root-kill fallback. No new unbounded wait is introduced; the original timeout refusal/return remains.

Task status/approval, matching branch, clean main/branch, test exit, post-test cleanliness, ancestor/fast-forward checks and existing merge/status/push path remain untouched. No HUD, timer, application data, rules, credential, shared instruction, unrelated project or installed companion change.

`scripts/merge-runner-output.test.js` runs the real full runner in disposable Git repositories with local bare remotes and a test-only npm fixture. Its sole source substitution shortens the ten-minute timeout to six seconds for deterministic tests. No production branch/remote is used. It tests 512 KiB on each stream with successful real fixture landing, nonzero refusal plus diagnostics, timeout refusal plus both npm and descendant termination, and refusal before npm when task approval is absent. The script stays ASCII for Windows PowerShell 5.1 parsing. package.json wires it into the existing npm test chain.

## Actual evidence

Durable logs: `C:\Users\Admin\Desktop\Vibe code\ChronaSense pilot archive\2026-10-20-hud-234a5ca\runner-repair-evidence`.

- Before repair: large-output regressions fail on BOTH Windows PowerShell 5.1 and PowerShell 7 (`baseline-large-output.log`). The initial broader baseline run also exposed surviving timeout descendants; those identified disposable children were explicitly cleaned up, and fixture teardown now records/cleans its own npm and child PIDs even after a failed assertion. No real companion was involved.
- Local supported versions: Windows PowerShell 5.1.19041.7802 and PowerShell 7.6.7. Both exercised the real runner.
- Initial repaired suite: 9/9 passed. Self-review removed an unnecessary unbounded cleanup wait before final verification.
- Final focused runner plus existing task-gating suite: 37/37 passed (`focused-final.log`). Full npm additionally checks the final assertion that npm itself, as well as its descendant, exited on timeout.
- Lint: 0 errors, 48 existing warnings. Runtime mirror (92-file closure), rules builder parity and repository no-op build pass. No runtime application files changed.
- Full npm result and formal review are recorded in TEST_REPORT.md/REVIEW.md when actually available; neither is fabricated here. Hosted Linux/pwsh coverage belongs to the actual required candidate CI, not to these local Windows results.

## Release boundaries

The owner explicitly requires independent review of the exact repair. Use the existing formal reviewer and hold at approved at most, then obtain both required candidate hosted checks. A failed review or a scope/approval change is a stop condition, not authorization to silently expand this repair.

Land the project-scoped repair through its legitimate held gate only after review/checks. Any resulting repair-only main advance is expected and must be documented. Reconcile that explicit repair-only baseline into TASK-020 without changing the original HUD files or rewriting 234a5ca; obtain refreshed formal review and CI on the exact combined release candidate before using TASK-020's held gate. Do not directly push main or bypass the runner.

The original TASK-020 review, approval and old green CI stay preserved as historical evidence; new review/check results must be real and labelled with their actual commit. Installed Windows companion replacement/restart remains unapproved throughout.

## Minimal follow-up proposal

The original pilot was missing a legitimate task/matching branch and formal held approval because its custom isolated workflow stopped at advisory review. That gap was correctly registered as TASK-020. Propose a deterministic preflight in the existing app-development procedure to check owner-authorized TASK identity, matching branch, exact baseline, formal review and required candidate CI before claiming integration readiness. This proposal does not modify global infrastructure. Propagating this runner fix to canonical AI Dev OS or other projects requires separate approval.
