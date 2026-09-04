<#
Regression coverage for the Phase 10 scheduler installer's `Install` action
(setup-life-ledger-sync-scheduler.ps1), added after a live disposable Task Scheduler proof found
that a case-insensitive variable-name collision between the script's own -Action parameter (an
[ValidateSet]-constrained variable) and a local $action variable silently prevented
Register-ScheduledTask from ever running, while the script printed a false "Task registered"
success message.

This is deliberately NOT a new test framework: no Pester dependency (the repo has none today).
It is one focused PowerShell script combining:
  Part A - static AST checks against the script's source (no execution, no real/mocked task ever
           touches Task Scheduler for this part)
  Part B - dynamic checks that run the real Install branch logic with the six ScheduledTasks
           cmdlets it depends on REPLACED by mock functions in a disposable child pwsh process,
           so success and failure are both proven without ever registering a real scheduled task

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
