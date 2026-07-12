# Run this ONCE (as Administrator) to register the Telegram-command dispatcher with Windows Task
# Scheduler. After running, it fires every 2 minutes while the PC is on.
# To change the interval: edit -RepetitionInterval below and re-run this script.
#
# Deliberately NOT -WakeToRun, unlike "ChronaSense Claude Overnight": this task should only ever act
# when the PC is already awake. Waking the PC every 2 minutes overnight just to check for a Telegram
# command would defeat the point of letting it sleep -- the twice-daily "ChronaSense Claude Overnight"
# task (which DOES use -WakeToRun) remains the backup path for anything sent while the PC was asleep.

$scriptPath = "C:\Users\Admin\Desktop\Vibe code\Time audit app\tools\Dispatch-Commands.ps1"
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
# 10 years is comfortably "indefinite" for a task meant to be re-registered if ever changed anyway.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 2) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description "Polls captures/commands/ for new Telegram control commands (/status /next /go /run /build /review /stop /enable /disable) every 2 minutes and dispatches them. See docs/09-automation.md." `
        -Force -ErrorAction Stop | Out-Null
} catch {
    Write-Host ""
    Write-Host "FAILED to register '$taskName': $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Task registered: '$taskName'" -ForegroundColor Green
Write-Host "Runs every 2 minutes while the PC is on (no WakeToRun -- see the file header comment)" -ForegroundColor Green
Write-Host ""
Write-Host "To verify: open Task Scheduler and look for '$taskName'"
Write-Host "To test now: Right-click the task > Run"
Write-Host "Output log: $((Split-Path (Split-Path $scriptPath)))\claude-session.log (shared with run-claude.ps1)"
