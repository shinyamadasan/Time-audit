# Run this ONCE (as Administrator) to register the Telegram-command dispatcher with Windows Task
# Scheduler.
#
# SLEEP-AND-WAKE MODEL (DECISIONS D-033):
#   This task DOES use -WakeToRun, and fires every 30 minutes -- not every 2.
#
#   The original design polled every 2 minutes with WakeToRun OFF, on the assumption that the PC was
#   always on. It isn't: the PC sleeps after 15 min idle. With WakeToRun off, a /go sent from the
#   phone would just sit in the repo until someone physically woke the machine -- remote development
#   was impossible. With WakeToRun ON, a 2-minute interval would wake the PC ~720x/day and defeat
#   sleeping entirely. 30 minutes is the balance: the PC sleeps, wakes on the half-hour to drain any
#   queued command (build -> review -> merge -> deploy), then idles back to sleep.
#
#   Nothing is lost while asleep: n8n writes commands into the repo via GitHub, and
#   -StartWhenAvailable drains the whole backlog on the next wake.
#
#   Dispatch-Commands.ps1 asserts ES_SYSTEM_REQUIRED for the life of its process, so a 10-15 minute
#   Codex build dispatched from a timer-wake cannot be suspended mid-flight by the unattended-sleep
#   timer.
#
#   Every app installed by the AI Dev OS uses this SAME 30-minute interval, deliberately -- never
#   staggered. Aligned triggers mean ONE wake of the PC serves EVERY app. Staggering them would wake
#   the machine once per app for no benefit. The apps cannot collide: each repo has its own
#   automation.lock.
#
# To change the cadence: edit -RepetitionInterval below and re-run this script.

$scriptPath = "C:/Users/Admin/Desktop/Vibe code/Time audit app\tools\Dispatch-Commands.ps1"
$taskName   = "ChronaSense Command Dispatcher"

# Remove existing task if it exists (so re-running this script is safe)
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""

# A single "Once" trigger with a repetition interval is Task Scheduler's standard way to express
# "run every N minutes, indefinitely" -- StartBoundary is "now" so it begins immediately.
# RepetitionDuration is deliberately NOT [TimeSpan]::MaxValue: that serializes to an ISO-8601
# duration (P99999999DT23H59M59S) that Task Scheduler's XML schema rejects as out of range --
# confirmed live, and Register-ScheduledTask throws but doesn't stop the script, so a prior run of
# this file printed a false "Task registered" success message while nothing was actually created.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 30) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# -WakeToRun: wake the sleeping PC to drain queued Telegram commands (D-033).
# -StartWhenAvailable: if a scheduled fire was missed (PC off), run as soon as it can.
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -StartWhenAvailable `
    -WakeToRun `
    -MultipleInstances IgnoreNew

try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description "Wakes the PC every 30 min to drain captures/commands/ (Telegram control commands: /status /next /go /run /build /review /stop /enable /disable) and dispatch them. Sleep-and-wake model: DECISIONS D-033." `
        -Force -ErrorAction Stop | Out-Null
} catch {
    Write-Host ""
    Write-Host "FAILED to register '$taskName': $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Are you running this as Administrator? Set-ScheduledTask/Register-ScheduledTask require it." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Task registered: '$taskName'" -ForegroundColor Green
Write-Host "Wakes the PC every 30 minutes to drain queued Telegram commands (WakeToRun, D-033)." -ForegroundColor Green
Write-Host ""
Write-Host "Verify with:" -ForegroundColor Cyan
Write-Host "  Get-ScheduledTask -TaskName '$taskName' | Select-Object State, @{n='Wake';e={`$_.Settings.WakeToRun}}, @{n='Every';e={`$_.Triggers[0].Repetition.Interval}}"
Write-Host "Expect: Ready | True | PT30M"
Write-Host ""
Write-Host "To test now: Right-click the task in Task Scheduler > Run"
Write-Host "Output log: $((Split-Path (Split-Path $scriptPath)))\claude-session.log (shared with run-claude.ps1)"
