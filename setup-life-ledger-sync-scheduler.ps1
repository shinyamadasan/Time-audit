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
  pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Health
  pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Uninstall
  pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action RunOnce [-Apply]
  pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action ClearIntervention

Health (Phase 11) is the one command the owner should run to answer "is this OK?" without
understanding hashes, manifests, or receipts. It is entirely READ-ONLY: it never writes, prunes,
or touches the vault beyond the same read-only ownership check the worker already performs every
cycle. It combines the one fact only Windows can see (the registered Scheduled Task's own
state/LastTaskResult) with everything scripts/life-ledger-sync-health.mjs can see from this repo
(config validity, outbox state, the worker's last-run status, the intervention latch, current
vault ownership, backup-root storage footprint, and whether pruning is due), and prints one of
five classifications: HEALTHY, PENDING, BLOCKED, ACTION REQUIRED, UNAVAILABLE — always the WORSE
of the two sides, so a healthy-looking task with an actual problem underneath is never reported as
fine.

-Apply controls whether SCHEDULED runs perform real writes. Without it, Install registers a task
that only ever dry-runs (identifies pending changes, writes nothing) — useful for observing
worker behavior for a while before trusting it with real applies. RunOnce is for a single manual
diagnostic cycle outside the scheduler entirely; pass -Apply there too if you want that one run to
be able to write.

ClearIntervention explicitly clears the worker's persisted intervention latch (see
scripts/life-ledger-sync-worker.mjs) after a human has reviewed and resolved whatever caused it.
Until this is run, every scheduled or manual --apply invocation is refused outright — no rollback
receipt preparation, no backup copy, no managed write — regardless of how many times the
scheduler fires. This script only forwards to the worker's own --clear-intervention flag; it does
not itself decide anything about the vault or backups.

Task Scheduler behavior (intentional, for this single-user desktop setup): the registered task
runs only while the owner is logged on to Windows (no stored credentials, no "run whether user is
logged on or not"), and requires no elevation (no admin rights, no -RunLevel Highest). If the
machine is off, asleep, or logged out at a trigger time, that cycle is simply skipped — the next
trigger a few minutes later covers it. This is a deliberate simplicity choice, not an oversight.

Required local configuration (not committed — see scripts/life-ledger-sync-worker.config.example.json):
  scripts/life-ledger-sync-worker.config.json — { "outboxDir", "vault", "expectedVault", "backupsRoot" }
#>
param(
    [ValidateSet('Install', 'Uninstall', 'Status', 'Health', 'RunOnce', 'ClearIntervention')]
    [string]$Action = 'Status',
    [string]$TaskName = 'ChronaSense Life Ledger Sync',
    [int]$IntervalMinutes = 15,
    [switch]$Apply,
    # Phase 11 fix pass (Review Finding 7) — RunOnce previously had no way to point at a
    # disposable config, which forced test harnesses to temporarily overwrite the REAL
    # scripts/life-ledger-sync-worker.config.json in place (move it aside, copy a test config
    # over it, run, restore it) just to exercise RunOnce against a throwaway fixture. That is
    # exactly the kind of real-production-config risk this project's own safety rules forbid, and
    # it left the harness fragile to any interruption between the swap and the restore. -ConfigPath
    # forwards straight to the worker's own --config flag, so RunOnce (and diagnostics) can target
    # a disposable config directly and never need to touch the real one. Optional — omitted, RunOnce
    # behaves exactly as before (the worker's own default: scripts/life-ledger-sync-worker.config.json).
    [string]$ConfigPath
)

$OnWindows = if ($null -eq $IsWindows) { $true } else { $IsWindows }
if (-not $OnWindows) {
    Write-Host "This installer targets Windows Task Scheduler only. On another OS, run the worker directly via cron/launchd: node scripts/life-ledger-sync-worker.mjs [--apply]" -ForegroundColor Yellow
    exit 1
}

$repoRoot = $PSScriptRoot
$workerScript = Join-Path $repoRoot 'scripts\life-ledger-sync-worker.mjs'

# A large FINITE repetition duration, not [TimeSpan]::MaxValue -- some Windows Task Scheduler
# builds have been reported to handle an unbounded/near-int64-max repetition duration
# inconsistently. Ten years comfortably outlives this single-user desktop setup and is trivially
# re-registered (Install is idempotent) well before it would ever matter.
$RepetitionDuration = New-TimeSpan -Days 3650

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

        # Idempotent: remove any prior registration of this exact task name first (exact name
        # only -- never a wildcard, never touches any other task). NOTE: if registration below
        # fails after this succeeds, the owner is left with NO task registered under this name
        # until Install is re-run successfully -- there is no transactional rollback here by
        # design (Phase 10 does not build Task Scheduler rollback machinery). That failure is now
        # always reported loudly (see below), so it is never silently mistaken for success.
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

        try {
            # No -Principal is supplied, so this registers to run as the current user, "only when
            # user is logged on", with no elevation -- see the top-of-file note. That is
            # intentional. The CIM action object below is deliberately named $taskAction, NOT
            # $action -- PowerShell variable names are case-insensitive, and $action would
            # silently collide with this script's own [ValidateSet]-constrained -Action
            # parameter, causing the assignment to fail its validation set while looking like an
            # ordinary local variable (confirmed live during the disposable scheduler proof: the
            # script printed "Task registered" while Register-ScheduledTask had never actually
            # run). Every step below uses -ErrorAction Stop so any real failure here throws
            # instead of being silently swallowed.
            $taskAction = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$workerScript`"$applyArg" -WorkingDirectory $repoRoot -ErrorAction Stop
            $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
                -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
                -RepetitionDuration $RepetitionDuration -ErrorAction Stop
            $settings = New-ScheduledTaskSettingsSet `
                -MultipleInstances IgnoreNew `
                -StartWhenAvailable `
                -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
                -DontStopOnIdleEnd -ErrorAction Stop

            $modeDescription = if ($Apply) { 'REAL WRITES ENABLED (--apply).' } else { 'Dry-run only (no --apply) -- identifies pending changes, writes nothing.' }
            Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings `
                -Description "Runs the ChronaSense Life Ledger background sync worker every $IntervalMinutes minute(s). $modeDescription Runs only while logged on; no elevation required." `
                -Force -ErrorAction Stop | Out-Null

            # Never trust Register-ScheduledTask's own success alone -- independently verify the
            # EXACT task now exists before printing any success text. This is what would have
            # caught the collision bug above instead of reporting a false success.
            $verifiedTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
            if (-not $verifiedTask) {
                throw "Register-ScheduledTask reported success but Get-ScheduledTask -TaskName '$TaskName' found nothing."
            }
        } catch {
            Write-Host ""
            Write-Host "FAILED to register scheduled task '$TaskName'." -ForegroundColor Red
            Write-Host "Error: $_" -ForegroundColor Red
            exit 1
        }

        Write-Host ""
        Write-Host "Task registered: '$TaskName'" -ForegroundColor Green
        Write-Host "Runs every $IntervalMinutes minute(s), only while logged on (no elevation required)."
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
        $configFile = Join-Path $repoRoot 'scripts\life-ledger-sync-worker.config.json'
        if (-not (Test-Path $configFile)) {
            Write-Host "WARNING: no scripts\life-ledger-sync-worker.config.json found -- every scheduled run will fail with missing_config until one is created." -ForegroundColor Yellow
        }
        $latchFile = $null
        if (Test-Path $configFile) {
            try {
                $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
                if ($cfg.backupsRoot) { $latchFile = Join-Path $cfg.backupsRoot 'intervention-required.json' }
            } catch { }
        }
        if ($latchFile -and (Test-Path $latchFile)) {
            Write-Host "INTERVENTION LATCH IS SET -- automated applies are blocked until 'ClearIntervention' is run after review." -ForegroundColor Red
            Write-Host "Latch details: $latchFile"
        }
    }
    'Health' {
        $severity = @{ HEALTHY = 0; PENDING = 1; BLOCKED = 2; ACTION_REQUIRED = 3; UNAVAILABLE = 4 }

        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $taskClassification = 'UNAVAILABLE'
        $taskReason = "Scheduled task '$TaskName' is not registered — run -Action Install."
        $info = $null
        if ($task) {
            $info = Get-ScheduledTaskInfo -TaskName $TaskName
            if ($task.State -eq 'Disabled') {
                $taskClassification = 'ACTION_REQUIRED'
                $taskReason = "Scheduled task '$TaskName' is registered but DISABLED."
            } elseif ($info.LastRunTime -and $info.LastTaskResult -ne 0) {
                $taskClassification = 'BLOCKED'
                $taskReason = "Last scheduled run did not report success (result code $($info.LastTaskResult))."
            } else {
                $taskClassification = 'HEALTHY'
                $taskReason = 'Scheduled task is registered and its last recorded result was healthy.'
            }
        }

        $nodePath = Get-NodeCommand
        $healthScript = Join-Path $repoRoot 'scripts\life-ledger-sync-health.mjs'
        $nodeOutputRaw = & $nodePath $healthScript '--json' 2>&1
        $nodeHealth = $null
        try { $nodeHealth = $nodeOutputRaw | ConvertFrom-Json } catch { }
        $nodeClassification = if ($nodeHealth) { $nodeHealth.classification } else { 'UNAVAILABLE' }

        $overall = if ($severity[$taskClassification] -ge $severity[$nodeClassification]) { $taskClassification } else { $nodeClassification }
        $displayOverall = $overall -replace '_', ' '

        $color = switch ($overall) {
            'HEALTHY' { 'Green' }
            'PENDING' { 'Cyan' }
            'BLOCKED' { 'Yellow' }
            'ACTION_REQUIRED' { 'Red' }
            default { 'Red' }
        }

        Write-Host ""
        Write-Host "ChronaSense Life Ledger Sync — Health: $displayOverall" -ForegroundColor $color
        Write-Host ""
        Write-Host "Scheduler:" -ForegroundColor DarkGray
        if ($task) {
            Write-Host "  Task state: $($task.State)"
            Write-Host "  Last run: $($info.LastRunTime)  (result code: $($info.LastTaskResult))"
            Write-Host "  Next run: $($info.NextRunTime)"
        }
        Write-Host "  $taskReason"
        Write-Host ""
        if ($nodeHealth) {
            Write-Host "Worker / vault / storage:" -ForegroundColor DarkGray
            foreach ($reason in $nodeHealth.reasons) { Write-Host "  - $reason" }
            if ($nodeHealth.facts.footprint) {
                $mb = [math]::Round($nodeHealth.facts.footprint.totalBytes / 1MB, 2)
                Write-Host "  Local automation storage: $($nodeHealth.facts.footprint.fileCount) file(s), $mb MB under backupsRoot."
            }
            if ($nodeHealth.facts.evidence) {
                Write-Host "  Latest run log: $($nodeHealth.facts.evidence.latestRunAt)"
                Write-Host "  Latest receipt: $($nodeHealth.facts.evidence.latestReceiptAt)"
            }
        } else {
            Write-Host "Worker / vault / storage: UNAVAILABLE — could not parse scripts\life-ledger-sync-health.mjs output:" -ForegroundColor Red
            Write-Host "  $nodeOutputRaw"
        }
        Write-Host ""
        if ($overall -eq 'ACTION_REQUIRED' -or $overall -eq 'UNAVAILABLE') { exit 1 }
    }
    'RunOnce' {
        $nodePath = Get-NodeCommand
        # NOTE: do not write `$applyArgs = if ($Apply) { @('--apply') } else { @() }`. Capturing
        # an if/else statement's output collapses a one-element array literal to its bare scalar
        # element (confirmed live: $applyArgs ended up as the STRING "--apply", not an array
        # containing it), and splatting a string with @ then expands it character-by-character --
        # this produced the observed "Unknown argument: -" from the worker CLI. Building the
        # array by explicit accumulation (+=) instead never goes through that collapse. -ConfigPath
        # (optional) is forwarded the same way, for the same reason -- see its param() comment.
        [string[]]$applyArgs = @()
        if ($Apply) {
            $applyArgs += '--apply'
        }
        if ($ConfigPath) {
            $applyArgs += '--config'
            $applyArgs += $ConfigPath
        }
        Write-Host "Running one diagnostic Life Ledger sync cycle$(if ($Apply) { ' WITH --apply (real writes possible)' } else { ' as a dry run (no writes)' })..." -ForegroundColor Cyan
        & $nodePath $workerScript @applyArgs
        exit $LASTEXITCODE
    }
    'ClearIntervention' {
        $nodePath = Get-NodeCommand
        Write-Host "Clearing the Life Ledger sync intervention latch (only after you have reviewed and resolved the underlying issue)..." -ForegroundColor Cyan
        & $nodePath $workerScript '--clear-intervention'
        exit $LASTEXITCODE
    }
}
