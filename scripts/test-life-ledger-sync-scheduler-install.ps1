<#
Regression coverage for the Phase 10 scheduler installer's `Install` action
(setup-life-ledger-sync-scheduler.ps1), added after a live disposable Task Scheduler proof found
that a case-insensitive variable-name collision between the script's own -Action parameter (an
[ValidateSet]-constrained variable) and a local $action variable silently prevented
Register-ScheduledTask from ever running, while the script printed a false "Task registered"
success message.

Also covers the `RunOnce` action's argument construction, added after the disposable Task
Scheduler proof's retry found a SEPARATE, narrowly-isolated defect: `RunOnce -Apply` raised
"Unknown argument: -" because `$applyArgs = if ($Apply) { @('--apply') } else { @() }` let
PowerShell collapse the one-element array literal to its bare scalar string when captured this
way, and splatting that string then expanded it character-by-character. The fix builds the array
by explicit typed accumulation (`[string[]]$applyArgs = @()` then `+=`) instead, which never goes
through that collapse. This bug was isolated to `RunOnce` -- `Install`'s argument string (built by
plain concatenation, not an array/splat) was never affected, nor was the actual scheduled task's
registered arguments.

This is deliberately NOT a new test framework: no Pester dependency (the repo has none today).
It is one focused PowerShell script combining:
  Part A - static AST checks against the Install action's source (no execution, no real/mocked
           task ever touches Task Scheduler for this part)
  Part B - dynamic checks that run the real Install branch logic with the six ScheduledTasks
           cmdlets it depends on REPLACED by mock functions in a disposable child pwsh process,
           so success and failure are both proven without ever registering a real scheduled task
  Part C - static checks against the RunOnce action's source, guarding against a regression back
           to the exact collapsing-assignment pattern
  Part D - dynamic checks that run the real RunOnce action against a disposable owned vault +
           outbox (no Task Scheduler involved), proving --apply is forwarded as exactly one
           argument, no --apply is forwarded as zero arguments, the worker script path survives
           intact despite containing spaces, and both success (exit 0) and business-failure
           (exit non-zero) worker outcomes propagate correctly

Run:  pwsh -NoProfile -File scripts/test-life-ledger-sync-scheduler-install.ps1
Exit: 0 if every check passes, 1 otherwise. Prints a PASS/FAIL line per check.
#>

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptUnderTest = Join-Path $repoRoot 'setup-life-ledger-sync-scheduler.ps1'

$failures = [System.Collections.Generic.List[string]]::new()
function Assert-True {
    param([bool]$Condition, [string]$Label)
    if ($Condition) {
        Write-Host "PASS: $Label" -ForegroundColor Green
    } else {
        Write-Host "FAIL: $Label" -ForegroundColor Red
        $failures.Add($Label)
    }
}

# ===========================================================================
# Part A -- static AST checks
# ===========================================================================

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptUnderTest, [ref]$tokens, [ref]$parseErrors)
Assert-True ($parseErrors.Count -eq 0) 'Part A.1: script parses with zero PowerShell syntax errors'

# A.2 -- no local variable named exactly "action" (case-insensitive) is ever assigned. That exact
# name is what collides with the script's [ValidateSet]-constrained -Action parameter.
$assignedVariableNames = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [System.Management.Automation.Language.VariableExpressionAst]
}, $true) | ForEach-Object { $_.Left.VariablePath.UserPath }

$collidesWithActionParam = $assignedVariableNames | Where-Object { $_ -ieq 'action' }
Assert-True ($collidesWithActionParam.Count -eq 0) 'Part A.2: no local variable named "action" collides with the -Action parameter'

# A.3 -- the renamed variable is present, confirming the fix landed (not just the absence of the bug).
Assert-True (($assignedVariableNames | Where-Object { $_ -ieq 'taskAction' }).Count -ge 1) 'Part A.3: the scheduled-task action object is held in a distinctly-named $taskAction variable'

# A.4 -- Register-ScheduledTask is invoked from inside a Try block (so a thrown terminating error
# is actually caught, rather than a bare call whose non-terminating errors could be missed).
$tryStatements = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.TryStatementAst] }, $true)
$registerInsideTry = $tryStatements | Where-Object {
    $_.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Register-ScheduledTask' }, $true).Count -gt 0
}
Assert-True ($registerInsideTry.Count -ge 1) 'Part A.4: Register-ScheduledTask is called inside a try block'

# A.5 -- Register-ScheduledTask passes -ErrorAction Stop (terminating-error semantics), so a
# cmdlet-level failure actually throws instead of being silently swallowed as a non-terminating error.
$registerCalls = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Register-ScheduledTask' }, $true)
$registerHasErrorActionStop = $registerCalls | Where-Object {
    $text = $_.Extent.Text
    $text -match '-ErrorAction\s+Stop'
}
Assert-True ($registerCalls.Count -ge 1 -and $registerHasErrorActionStop.Count -eq $registerCalls.Count) 'Part A.5: every Register-ScheduledTask call uses -ErrorAction Stop'

# A.6 -- a Get-ScheduledTask verification call exists inside the SAME try block that registers the
# task (i.e. success is verified before the try block exits, not left to chance afterward).
$verifyInsideSameTry = $registerInsideTry | Where-Object {
    $_.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Get-ScheduledTask' }, $true).Count -gt 0
}
Assert-True ($verifyInsideSameTry.Count -ge 1) 'Part A.6: Get-ScheduledTask verification runs inside the same try block as Register-ScheduledTask'

# A.7 -- the "Task registered" success message is emitted strictly AFTER (later in script source
# order than) the Get-ScheduledTask verification call, so it can never print before verification
# has had a chance to throw.
$successWriteHost = $ast.FindAll({
    param($n) $n -is [System.Management.Automation.Language.CommandAst] -and
    $n.GetCommandName() -eq 'Write-Host' -and
    $n.Extent.Text -match 'Task registered'
}, $true)
$verifyCall = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Get-ScheduledTask' }, $true) | Select-Object -First 1
Assert-True (
    $successWriteHost.Count -ge 1 -and $verifyCall -and
    ($successWriteHost | ForEach-Object { $_.Extent.StartOffset } | Measure-Object -Minimum).Minimum -gt $verifyCall.Extent.StartOffset
) 'Part A.7: the "Task registered" success text appears after the Get-ScheduledTask verification call'

# ===========================================================================
# Part B -- dynamic mock-based success/failure proof (no real Task Scheduler involved)
# ===========================================================================
#
# Each scenario runs the REAL script in a disposable child pwsh process with the six
# ScheduledTasks cmdlets it calls replaced by mock functions defined in that same process/scope
# before the script is dot-sourced. PowerShell resolves a bare command name to a function ahead of
# a module cmdlet within the same scope chain, so the script's calls hit the mocks, not the real
# Task Scheduler API -- nothing here can register an actual task.

function Invoke-MockedInstall {
    param([string]$MockBody, [string]$TaskName)
    # IMPORTANT: `exit N` inside a dot-sourced/called nested script does NOT by itself set this
    # wrapper's own process exit code -- it only sets $LASTEXITCODE in the calling scope and
    # returns; execution then continues here. Confirmed empirically (not assumed) while writing
    # this harness. The wrapper must explicitly re-exit with that captured code as its own final
    # top-level statement for the child pwsh process's real exit code to reflect it.
    $childScript = @"
`$ErrorActionPreference = 'Stop'
$MockBody
. '$scriptUnderTest' -Action Install -TaskName '$TaskName' -IntervalMinutes 15
exit `$LASTEXITCODE
"@
    $tempScript = New-TemporaryFile
    Rename-Item $tempScript "$tempScript.ps1" -Force
    $tempScriptPs1 = "$tempScript.ps1"
    Set-Content -Path $tempScriptPs1 -Value $childScript -Encoding UTF8
    try {
        $output = & pwsh -NoProfile -File $tempScriptPs1 2>&1 | Out-String
        return [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Output = $output }
    } finally {
        Remove-Item $tempScriptPs1 -Force -ErrorAction SilentlyContinue
    }
}

$successMocks = @'
function New-ScheduledTaskAction { param([string]$Execute, [string]$Argument, [string]$WorkingDirectory, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Action' } }
function New-ScheduledTaskTrigger { param([switch]$Once, $At, $RepetitionInterval, $RepetitionDuration, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Trigger' } }
function New-ScheduledTaskSettingsSet { param([string]$MultipleInstances, [switch]$StartWhenAvailable, $ExecutionTimeLimit, [switch]$DontStopOnIdleEnd, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Settings' } }
function Register-ScheduledTask { param([string]$TaskName, $Action, $Trigger, $Settings, [string]$Description, [switch]$Force, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Registered'; TaskName = $TaskName } }
function Get-ScheduledTask { param([string]$TaskName, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Task'; TaskName = $TaskName; State = 'Ready' } }
function Unregister-ScheduledTask { param([string]$TaskName, [switch]$Confirm, [string]$ErrorAction) }
'@

$successResult = Invoke-MockedInstall -MockBody $successMocks -TaskName 'Mock-Success-Test'
Assert-True ($successResult.ExitCode -eq 0) 'Part B.1 (success scenario): mocked Install exits 0'
Assert-True ($successResult.Output -match 'Task registered') 'Part B.1 (success scenario): success text is printed when every step succeeds'

$failureMocks = @'
function New-ScheduledTaskAction { param([string]$Execute, [string]$Argument, [string]$WorkingDirectory, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Action' } }
function New-ScheduledTaskTrigger { param([switch]$Once, $At, $RepetitionInterval, $RepetitionDuration, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Trigger' } }
function New-ScheduledTaskSettingsSet { param([string]$MultipleInstances, [switch]$StartWhenAvailable, $ExecutionTimeLimit, [switch]$DontStopOnIdleEnd, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Settings' } }
function Register-ScheduledTask { param([string]$TaskName, $Action, $Trigger, $Settings, [string]$Description, [switch]$Force, [string]$ErrorAction) throw 'Simulated Register-ScheduledTask failure (access denied / scheduler service unavailable / etc.)' }
function Get-ScheduledTask { param([string]$TaskName, [string]$ErrorAction) $null }
function Unregister-ScheduledTask { param([string]$TaskName, [switch]$Confirm, [string]$ErrorAction) }
'@

$failureResult = Invoke-MockedInstall -MockBody $failureMocks -TaskName 'Mock-Failure-Test'
Assert-True ($failureResult.ExitCode -ne 0) 'Part B.2 (failure scenario): mocked Install exits non-zero when Register-ScheduledTask throws'
Assert-True ($failureResult.Output -notmatch 'Task registered') 'Part B.2 (failure scenario): success text is NEVER printed when registration fails'
Assert-True ($failureResult.Output -match 'FAILED') 'Part B.2 (failure scenario): a clear failure message is printed'

# B.3 -- also prove the verification step itself catches a "succeeded but not actually there" case:
# Register-ScheduledTask succeeds but Get-ScheduledTask (the independent check) returns nothing.
$phantomMocks = @'
function New-ScheduledTaskAction { param([string]$Execute, [string]$Argument, [string]$WorkingDirectory, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Action' } }
function New-ScheduledTaskTrigger { param([switch]$Once, $At, $RepetitionInterval, $RepetitionDuration, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Trigger' } }
function New-ScheduledTaskSettingsSet { param([string]$MultipleInstances, [switch]$StartWhenAvailable, $ExecutionTimeLimit, [switch]$DontStopOnIdleEnd, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Settings' } }
function Register-ScheduledTask { param([string]$TaskName, $Action, $Trigger, $Settings, [string]$Description, [switch]$Force, [string]$ErrorAction) [PSCustomObject]@{ MockType = 'Registered'; TaskName = $TaskName } }
function Get-ScheduledTask { param([string]$TaskName, [string]$ErrorAction) $null }
function Unregister-ScheduledTask { param([string]$TaskName, [switch]$Confirm, [string]$ErrorAction) }
'@
$phantomResult = Invoke-MockedInstall -MockBody $phantomMocks -TaskName 'Mock-Phantom-Test'
Assert-True ($phantomResult.ExitCode -ne 0) 'Part B.3 (phantom-registration scenario): exits non-zero when Register succeeds but verification finds nothing'
Assert-True ($phantomResult.Output -notmatch 'Task registered') 'Part B.3 (phantom-registration scenario): success text is NEVER printed when verification fails'

# ===========================================================================
# Part C -- static checks against the RunOnce action's argument construction
# ===========================================================================
#
# Targeted regression guards against the exact fixed defect: capturing an if/else statement's
# output directly into $applyArgs collapses a one-element array literal to its bare scalar
# element, which then gets character-split when splatted. Full-AST generality is deliberately not
# attempted here -- these checks target the exact known anti-pattern, the same way Part A's
# checks target the exact known -Action/$action collision.

# AST-based, not raw-text regex: the script's own explanatory comment on this fix intentionally
# quotes the exact buggy pattern as a documentation example ("do not write ..."), which a plain
# text search would false-positive on. The AST has no comment nodes at all, so it only ever sees
# real code.
function Test-IsApplyArgsTarget {
    param($left)
    # A typed declaration ([string[]]$applyArgs = ...) wraps the variable in a ConvertExpressionAst
    # rather than exposing it as a bare VariableExpressionAst -- both forms must be recognized.
    if ($left -is [System.Management.Automation.Language.VariableExpressionAst]) {
        return $left.VariablePath.UserPath -ieq 'applyArgs'
    }
    if ($left -is [System.Management.Automation.Language.ConvertExpressionAst] -and $left.Child -is [System.Management.Automation.Language.VariableExpressionAst]) {
        return $left.Child.VariablePath.UserPath -ieq 'applyArgs'
    }
    return $false
}

$applyArgsAssignments = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    (Test-IsApplyArgsTarget $node.Left)
}, $true)

$collapsingAssignment = $applyArgsAssignments | Where-Object {
    # The exact fixed defect: a plain `=` whose right-hand side is (or contains) an if/else used
    # as a value -- that is what collapses a one-element array to its scalar element.
    $_.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals -and
    $_.Right.FindAll({ param($n) $n -is [System.Management.Automation.Language.IfStatementAst] }, $true).Count -gt 0
}
Assert-True ($collapsingAssignment.Count -eq 0) 'Part C.1: RunOnce no longer assigns $applyArgs directly from an if/else statement (the collapsing pattern)'

$typedArrayInit = $applyArgsAssignments | Where-Object {
    $_.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals -and
    $_.Left.Extent.Text -match '^\[string\[\]\]'
}
Assert-True ($typedArrayInit.Count -ge 1) 'Part C.2: $applyArgs is declared as an explicitly-typed, always-array initializer'

$accumulation = $applyArgsAssignments | Where-Object {
    $_.Operator -eq [System.Management.Automation.Language.TokenKind]::PlusEquals -and
    $_.Right.Extent.Text -match "'--apply'"
}
Assert-True ($accumulation.Count -ge 1) 'Part C.3: --apply is added via explicit array accumulation (+=), not a captured if/else value'

# ===========================================================================
# Part D -- dynamic RunOnce proof against a disposable owned vault (no Task Scheduler involved)
# ===========================================================================

function New-DisposableRunOnceFixture {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) "ChronaSense-P10-RunOnce-Fix-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
    New-Item -ItemType Directory -Path (Join-Path $root 'outbox') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $root 'vault') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $root 'backups') -Force | Out-Null

    $seedScript = @'
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const REPO = process.argv[3];
const { createObsidianSyncTarget, planObsidianSync, applyObsidianSync } = await import(pathToFileURL(path.join(REPO, "obsidian-life-ledger-sync.js")));
const { serializeLifeLedgerSnapshot, createLifeLedgerSnapshotFromEvents } = await import(pathToFileURL(path.join(REPO, "life-ledger-transport.js")));
const root = process.argv[2];
const vault = path.join(root, "vault");
const outboxDir = path.join(root, "outbox");
function focusEvent() {
  return {
    schemaVersion: 1, eventId: "40404040-4040-4040-8040-404040404040", sourceApp: "chronasense",
    sourceEntityId: "runonce-fix-harness", type: "focus_session_completed",
    occurredAt: "2026-08-30T16:00:00.000Z", recordedAt: "2026-08-30T16:00:00.000Z", revisedAt: null,
    sourceTimezone: "America/Phoenix",
    payload: { activity: "RunOnce fix harness", startedAt: "2026-08-30T15:35:00.000Z", endedAt: "2026-08-30T16:00:00.000Z", durationMinutes: 25, additiveForTimeTotals: false, source: { focusEntryId: "runonce-fix-harness" } },
    provenance: { source: "chronasense", sourceRecordKind: "chronasense.focus_outcome", adapterVersion: "test-v1", observedAt: "2026-08-30T16:00:00.000Z", captureMethod: "pomodoro", evidence: ["synthetic:1"] },
    confidence: { score: 1, basis: "source-recorded" }, revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null }
  };
}
await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
const target = createObsidianSyncTarget({ vaultPath: vault, mode: "test", allowApply: true });
const plan = await planObsidianSync(target, [focusEvent()]);
if (plan.blocked) throw new Error("seed plan blocked");
await fs.writeFile(path.join(vault, "TEST-VAULT.md"), "test\n", "utf8");
await applyObsidianSync(plan, { mode: "test", apply: true });
await fs.rm(path.join(vault, "TEST-VAULT.md"));
const snapshot = createLifeLedgerSnapshotFromEvents([focusEvent()]);
await fs.writeFile(path.join(outboxDir, "chronasense-life-ledger-outbox-v1.json"), serializeLifeLedgerSnapshot(snapshot), "utf8");
'@
    $seedPath = Join-Path $root 'seed.mjs'
    Set-Content -Path $seedPath -Value $seedScript -Encoding UTF8
    $nodeCmd = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $nodeCmd) { throw "node is not on PATH -- cannot run Part D" }
    & $nodeCmd.Source $seedPath $root $repoRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "disposable fixture seed failed" }

    $config = [PSCustomObject]@{
        outboxDir     = (Join-Path $root 'outbox').Replace('\', '/')
        vault         = (Join-Path $root 'vault').Replace('\', '/')
        expectedVault = (Join-Path $root 'vault').Replace('\', '/')
        backupsRoot   = (Join-Path $root 'backups').Replace('\', '/')
    }
    return @{ Root = $root; Config = $config }
}

function Invoke-RealRunOnce {
    param([bool]$Apply, [string]$ConfigJsonPath)
    $configTarget = Join-Path $repoRoot 'scripts\life-ledger-sync-worker.config.json'
    $existedBefore = Test-Path $configTarget
    $backupPath = "$configTarget.harness-backup"
    if ($existedBefore) { Move-Item $configTarget $backupPath -Force }
    try {
        Copy-Item $ConfigJsonPath $configTarget -Force
        $args = @('-Action', 'RunOnce')
        if ($Apply) { $args += '-Apply' }
        $output = & pwsh -NoProfile -File $scriptUnderTest @args 2>&1 | Out-String
        return [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Output = $output }
    } finally {
        Remove-Item $configTarget -Force -ErrorAction SilentlyContinue
        if ($existedBefore) { Move-Item $backupPath $configTarget -Force }
    }
}

$disposable = $null
try {
    $disposable = New-DisposableRunOnceFixture
    $configJsonPath = Join-Path $disposable.Root 'harness-config.json'
    $disposable.Config | ConvertTo-Json | Set-Content -Path $configJsonPath -Encoding UTF8

    $noApplyResult = Invoke-RealRunOnce -Apply $false -ConfigJsonPath $configJsonPath
    Assert-True ($noApplyResult.Output -notmatch 'Unknown argument') 'Part D.1: RunOnce without -Apply never produces "Unknown argument" (worker script path + zero flags parsed correctly)'
    Assert-True ($noApplyResult.Output -match 'unchanged') 'Part D.1: RunOnce without -Apply runs the real dry-run cycle to a normal outcome'
    Assert-True ($noApplyResult.ExitCode -eq 0) 'Part D.1: RunOnce without -Apply exits 0 on a normal outcome'

    $applyResult = Invoke-RealRunOnce -Apply $true -ConfigJsonPath $configJsonPath
    Assert-True ($applyResult.Output -notmatch 'Unknown argument') 'Part D.2: RunOnce WITH -Apply never produces "Unknown argument" (--apply forwarded as exactly one argument)'
    Assert-True ($applyResult.Output -match 'unchanged') 'Part D.2: RunOnce WITH -Apply runs the real apply-mode cycle to a normal outcome (proves --apply, not a mangled flag, reached the worker)'
    Assert-True ($applyResult.ExitCode -eq 0) 'Part D.2: RunOnce WITH -Apply exits 0 on a normal (worker exit 0) outcome -- exit code propagates correctly'

    # D.3 -- a genuine business failure (nonexistent vault) must still propagate non-zero, and must
    # never be confused with the argument-parsing bug.
    $badConfig = [PSCustomObject]@{
        outboxDir     = $disposable.Config.outboxDir
        vault         = (Join-Path $disposable.Root 'does-not-exist').Replace('\', '/')
        expectedVault = (Join-Path $disposable.Root 'does-not-exist').Replace('\', '/')
        backupsRoot   = $disposable.Config.backupsRoot
    }
    $badConfigPath = Join-Path $disposable.Root 'harness-config-bad.json'
    $badConfig | ConvertTo-Json | Set-Content -Path $badConfigPath -Encoding UTF8
    $failureResult = Invoke-RealRunOnce -Apply $true -ConfigJsonPath $badConfigPath
    Assert-True ($failureResult.ExitCode -ne 0) 'Part D.3: a genuine business failure (missing vault) propagates a non-zero exit code'
    Assert-True ($failureResult.Output -notmatch 'Unknown argument') 'Part D.3: a genuine business failure is never mistaken for the argument-parsing bug'
} catch {
    Assert-True $false "Part D: harness setup/execution failed unexpectedly: $_"
} finally {
    if ($disposable -and (Test-Path $disposable.Root)) {
        Remove-Item $disposable.Root -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ===========================================================================
# Summary
# ===========================================================================

Write-Host ""
if ($failures.Count -eq 0) {
    Write-Host "ALL CHECKS PASSED" -ForegroundColor Green
    exit 0
} else {
    Write-Host "$($failures.Count) CHECK(S) FAILED:" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    exit 1
}
