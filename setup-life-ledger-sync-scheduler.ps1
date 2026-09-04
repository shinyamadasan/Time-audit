<#
Phase 10 — Life Ledger background sync install / start / stop / diagnostic interface.

Manages a Windows Task Scheduler task that runs scripts/life-ledger-sync-worker.mjs on an
interval, so the owner never has to type a sync command by hand. This script does NOT register
anything by being present in the repo — it only acts when explicitly run with -Action Install.

REAL PRODUCTION ACTIVATION IS A DELIBERATE, SEPARATE STEP. Phase 10's Builder work stops short of
running this with -Action Install -Apply against the real vault; that happens only after
independent review.

Usage:
  pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Install [-IntervalMinutes 15] [-Apply]
  pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Status
  pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Uninstall
  pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action RunOnce [-Apply]

-Apply controls whether SCHEDULED runs perform real writes. Without it, Install registers a task
that only ever dry-runs (identifies pending changes, writes nothing) — useful for observing
worker behavior for a while before trusting it with real applies. RunOnce is for a single manual
diagnostic cycle outside the scheduler entirely; pass -Apply there too if you want that one run to
be able to write.

Required local configuration (not committed — see scripts/life-ledger-sync-worker.config.example.json):
  scripts/life-ledger-sync-worker.config.json — { "outboxDir", "vault", "expectedVault", "backupsRoot" }
#>
param(
    [ValidateSet('Install', 'Uninstall', 'Status', 'RunOnce')]
    [string]$Action = 'Status',
    [string]$TaskName = 'ChronaSense Life Ledger Sync',
    [int]$IntervalMinutes = 15,
    [switch]$Apply
)

$OnWindows = if ($null -eq $IsWindows) { $true } else { $IsWindows }
if (-not $OnWindows) {
    Write-Host "This installer targets Windows Task Scheduler only. On another OS, run the worker directly via cron/launchd: node scripts/life-ledger-sync-worker.mjs [--apply]" -ForegroundColor Yellow
    exit 1
}

$repoRoot = $PSScriptRoot
$workerScript = Join-Path $repoRoot 'scripts\life-ledger-sync-worker.mjs'

function Get-NodeCommand {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Host "FAILED: 'node' is not on PATH." -ForegroundColor Red
        exit 1
    }
    return $node.Source
}

switch ($Action) {
    'Install' {
        $nodePath = Get-NodeCommand
        $applyArg = if ($Apply) { ' --apply' } else { '' }

        # Idempotent: remove any prior registration of this exact task name first.
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

        $action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$workerScript`"$applyArg" -WorkingDirectory $repoRoot
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
            -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
            -RepetitionDuration ([TimeSpan]::MaxValue)
        $settings = New-ScheduledTaskSettingsSet `
            -MultipleInstances IgnoreNew `
            -StartWhenAvailable `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
            -DontStopOnIdleEnd

        $modeDescription = if ($Apply) { 'REAL WRITES ENABLED (--apply).' } else { 'Dry-run only (no --apply) -- identifies pending changes, writes nothing.' }
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
            -Description "Runs the ChronaSense Life Ledger background sync worker every $IntervalMinutes minute(s). $modeDescription" `
            -Force | Out-Null

        Write-Host ""
        Write-Host "Task registered: '$TaskName'" -ForegroundColor Green
        Write-Host "Runs every $IntervalMinutes minute(s)."
        if ($Apply) {
            Write-Host "Mode: REAL WRITES (--apply)" -ForegroundColor Yellow
        } else {
            Write-Host "Mode: DRY RUN ONLY" -ForegroundColor Cyan
        }
        Write-Host "Concurrency: MultipleInstances=IgnoreNew (Task Scheduler will not start a new instance while one is already running)."
        Write-Host ""
        Write-Host "Config file expected at: $repoRoot\scripts\life-ledger-sync-worker.config.json"
        Write-Host "See scripts\life-ledger-sync-worker.config.example.json for the shape."
    }
    'Uninstall' {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "Task '$TaskName' removed (if it existed)." -ForegroundColor Green
    }
    'Status' {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $task) {
            Write-Host "Task '$TaskName' is not registered." -ForegroundColor Yellow
            exit 0
        }
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Host "Task '$TaskName': $($task.State)" -ForegroundColor Green
        Write-Host "Last run: $($info.LastRunTime)  (result code: $($info.LastTaskResult))"
        Write-Host "Next run: $($info.NextRunTime)"
        $statusFile = Join-Path $repoRoot 'scripts\life-ledger-sync-worker.config.json'
        if (-not (Test-Path $statusFile)) {
            Write-Host "WARNING: no scripts\life-ledger-sync-worker.config.json found -- every scheduled run will fail with missing_config until one is created." -ForegroundColor Yellow
        }
    }
    'RunOnce' {
        $nodePath = Get-NodeCommand
        $applyArgs = if ($Apply) { @('--apply') } else { @() }
        Write-Host "Running one diagnostic Life Ledger sync cycle$(if ($Apply) { ' WITH --apply (real writes possible)' } else { ' as a dry run (no writes)' })..." -ForegroundColor Cyan
        & $nodePath $workerScript @applyArgs
        exit $LASTEXITCODE
    }
}
