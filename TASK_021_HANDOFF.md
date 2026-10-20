# TASK-021 - Windows merge-test containment

Owner authorized the project-only repair, one corrective pass, then explicitly expanded scope to
launch-time Windows Job Object containment on 2026-10-20. Baseline remains
`bb171a287ac67d76ae27634b5227bc24f66919de`; isolated branch `task-021`.

## Why the earlier repair is insufficient

Implementation `102d7af` starts concurrent pipe reads, fixing large-output deadlock. Formal review
`086010f` returned REWORK because `.Result` can wait indefinitely after npm exits. A native Windows
fixture proved something worse: npm exits zero while a descendant keeps stdout/stderr handles; after
that child self-expires the old runner incorrectly merges the disposable fixture. Both shells reproduced
this. Killing an already-exited parent PID cannot reliably find that descendant. The earlier handoff's
claim that no unbounded wait was added was incorrect and is superseded here; historical evidence remains.

## Corrected runtime scope

`tools/Run-Merge.ps1` uses `tools/Merge-TestProcess.cs` only on Windows. This single-purpose helper:

- Creates an unnamed, non-inheritable Job Object with kill-on-close and no breakaway permission.
- Creates the fixed system `cmd.exe /c npm test` suspended, assigns its process HANDLE to the job,
  then resumes its one suspended thread. Assignment failure terminates the still-suspended root by
  its owned handle; no npm code or descendant can execute before assignment.
- Whitelists only stdin/stdout/stderr handles using STARTUPINFOEX. Job/process handles are not inherited.
  stdin is NUL; stdout/stderr use separate temporary files, avoiding pipe capacity and EOF/drain-task
  waits entirely. Diagnostics are read only after the owned job is confirmed empty.
- Preserves the ten-minute root timeout. After parent exit, allows one second for empty job accounting;
  surviving descendants refuse even with exit zero. Failure terminates the job and allows three seconds
  for empty accounting. Native-call, query, cleanup, output-read/delete or handle-close errors refuse.
  Closing the job provides kill-on-close fallback; failed cleanup never becomes success even if that
  fallback works. No PID lookup, taskkill or process-name cleanup is used in this Windows path.

This is bounded process containment, not a general process-management API. Native structure/API
signatures account for most helper code. C# syntax works with Add-Type on both supported shells.
Filesystem I/O has ordinary OS semantics; there is no task or pipe-drain completion wait.

The non-Windows subprocess path is retained from `102d7af`, including its known post-parent-exit drain
limitation. The owner explicitly requested unchanged non-Windows behavior. Windows-only tests are
explicitly skipped elsewhere; no corrected Linux orphan behavior or Linux containment is claimed.
All task approval, matching branch, clean-tree, nonzero exit, post-test cleanliness, ancestry,
fast-forward/status/push safeguards remain. No HUD/application, data, installed companion, canonical
AI Dev OS template or other project change.

## Regressions and evidence

`scripts/merge-runner-output.test.js` exercises the real held runner in disposable repositories with
local bare remotes and a PATH npm shim. Deadline substitutions and native-call fault injection change
only copied fixture source; there is no production opt-out or bypass.

Fifteen focused checks passed on Windows PowerShell 5.1.19041.7802 and PowerShell 7.6.7:
512 KiB per output with successful real fixture landing; nonzero exit and diagnostics; timeout and
child termination; missing approval; parent-exits/descendant-retains-output-handles; explicit descendant
cleanup failure with kill-on-close fallback; failed assignment before npm executes. Every failure
fixture checks local AND bare-remote main remain at baseline. Native orphan fixtures handshake before
parent exit so the child records actual parent death within the cleanup grace. Children self-expire;
teardown never terminates a recorded/reusable PID.

Earlier evidence remains in `runner-repair-evidence` and `runner-corrective-evidence`. Current logs,
patch, bundle and SHA-256 manifest are preserved beneath:
`C:\Users\Admin\Desktop\Vibe code\ChronaSense pilot archive\2026-10-20-hud-234a5ca\runner-containment-evidence`.
TEST_REPORT.md records actual full-suite results. REVIEW.md belongs only to the formal reviewer.

## Integration hold and repeatability

Fresh formal independent review of the complete corrected diff is required; hold at `approved` at most.
Required hosted candidate test/fence checks and all existing held-gate checks must pass before landing.
Stop on failed review, unexpected baseline/permissions or inability to achieve reliable narrow containment.
No direct main push, runner bypass, canonical propagation or companion replacement/restart is authorized.

TASK-020 stays held at reviewed `780e733`, preserving original HUD `234a5ca`. If the repair later lands,
explicitly reconcile that repair-only baseline, preserve HUD source bytes, obtain refreshed formal review
and hosted CI, then use the legitimate held gate under existing owner authorization. No integration or
Pages publication is claimed by this handoff.

Root cause of the initial prerequisite gap: the custom pilot workflow stopped at advisory review without
a registered task, matching branch or formal held approval. The runner then exposed an untested output
lifecycle assumption: root exit was treated as tree/output completion. Minimal future preflight: verify
task identity, matching branch/baseline, formal review and exact-candidate CI before claiming readiness;
retain these lifecycle regressions. This proposal does not build new global infrastructure.

API contracts: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw),
[job accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information).
