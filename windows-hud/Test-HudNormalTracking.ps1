#Requires -Version 7.0
# TASK-014 — Normal Tracking HUD V1: deterministic checks of the companion's
# payload validation, multi-tab arbitration and tracking presentation. Pulls
# the real functions out of ChronaSenseHud.ps1 by AST (as
# Test-HudDogfoodPolish.ps1 does) — no window, listener or network is started.

$ErrorActionPreference = 'Stop'
$assertions = 0

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw "ASSERTION FAILED: $message" }
  $script:assertions++
}

$hudPath = Join-Path $PSScriptRoot 'ChronaSenseHud.ps1'
$tokens = $null; $errors = $null
$hudAst = [System.Management.Automation.Language.Parser]::ParseFile($hudPath, [ref]$tokens, [ref]$errors)
Assert-True ($errors.Count -eq 0) 'ChronaSenseHud.ps1 parses without errors'

function Get-FunctionSource([string]$name) {
  $match = @($hudAst.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
    Where-Object Name -eq $name)
  Assert-True ($match.Count -eq 1) "exactly one $name function exists"
  return $match[0].Extent.Text
}

$sources = @('Test-HudNumber', 'Test-ValidFocusPayload', 'Resolve-HudSnapshotUpdate', 'Format-Elapsed',
  'Hide-HudUntilFocusEnds', 'Show-Hud', 'Render-HudState') | ForEach-Object { Get-FunctionSource $_ }

$hudText = Get-Content -LiteralPath $hudPath -Raw
Assert-True ($hudText.Contains('Content="Hide until Focus ends"')) 'Focus Hide wording is preserved as the default'
Assert-True (-not ($hudText -match 'Invoke-RestMethod|Invoke-WebRequest|System\.Net\.Http\.|WebClient|OutputStream')) 'the companion makes no outbound request and writes no response body'
Assert-True ($hudText.Contains('$listener.Prefixes.Add("http://127.0.0.1:$Port/focus-bridge/")')) 'the listener stays loopback-only'
Assert-True ($hudText.Contains("`$AllowedOrigins = @('https://shinyamadasan.github.io')")) 'the exact-origin allow-list is unchanged'

$module = New-Module -ArgumentList (, $sources) -ScriptBlock {
  param($sources)
  foreach ($s in $sources) { Invoke-Expression $s }

  $script:hiddenUntilEnd = $false
  $script:hiddenForType = ''
  $script:privacyMode = $false
  $script:StaleAfterHiddenMs = 90000
  $script:StaleAfterVisibleMs = 15000
  $script:LinkTypeLabelText = @{ 'daily-routine' = 'Scheduled routine'; 'learning-plan' = 'Learning plan' }
  $script:shared = [hashtable]::Synchronized(@{ Snapshot = $null; LastReceivedAt = [DateTime]::UtcNow; ClaimFloor = [double]0 })
  $script:shared.Lock = New-Object object
  $script:window = [pscustomobject]@{ IsVisible = $false }
  $script:window | Add-Member ScriptMethod Show { $this.IsVisible = $true }
  $script:window | Add-Member ScriptMethod Hide { $this.IsVisible = $false }
  function New-TestLabel { [pscustomobject]@{ Text = ''; Fill = ''; Visibility = 'Collapsed'; Content = '' } }
  foreach ($n in 'PhaseLabel','PhaseLabelExp','StatusDot','StatusDotExp','TitleLabelCollapsed','TitleLabelExp',
                 'EndLabelCollapsed','EndLabelExp','StartedLabel','LinkTypeLabel','ConnLabel','HideBtn','hideItem') {
    Set-Variable -Scope Script -Name $n -Value (New-TestLabel)
  }
  function Format-EndTime { 'Ends ~10:30 AM' }
  function Format-Started { 'Started 10:00 AM' }
  function Render-Privacy { }
  function Write-HudDebug { }

  function Parse([string]$json) { $json | ConvertFrom-Json }

  # Applies one POST exactly as the listener does, returning whether it was accepted.
  function Post($payload) {
    $d = Resolve-HudSnapshotUpdate $payload $script:shared.Snapshot ([double]$script:shared.ClaimFloor)
    if ($d.Accept) {
      $script:shared.Snapshot = $d.Snapshot
      $script:shared.ClaimFloor = $d.Floor
      $script:shared.LastReceivedAt = [DateTime]::UtcNow
    }
    return [bool]$d.Accept
  }

  function Reset-Hud {
    $script:shared.Snapshot = $null; $script:shared.ClaimFloor = [double]0
    $script:hiddenUntilEnd = $false; $script:window.IsVisible = $false; $script:privacyMode = $false
  }

  function Tracking([string]$title, [long]$start, [long]$claim, [string]$vis = 'visible') {
    Parse "{`"type`":`"tracking-active`",`"title`":`"$title`",`"startedAt`":$start,`"pageVisibility`":`"$vis`",`"sessionKey`":`"tracking:$start`",`"claimedAt`":$claim}"
  }
  function Focus([long]$start, [long]$claim) {
    Parse "{`"type`":`"focus-active`",`"title`":`"Focus`",`"phase`":`"work`",`"startedAt`":$start,`"plannedEndAt`":$($start + 1500000),`"linkType`":`"none`",`"deviceOwned`":true,`"pageVisibility`":`"visible`",`"sessionKey`":`"focus:work:$start`",`"claimedAt`":$claim}"
  }
  function Ended([string]$key, [long]$claim) {
    Parse "{`"type`":`"focus-ended`",`"sessionKey`":`"$key`",`"claimedAt`":$claim}"
  }

  function Invoke-Checks {
    $r = [ordered]@{}
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    # ── Validation ──
    $r.ValidTracking = Test-ValidFocusPayload (Tracking 'Deep work' 1000 2000)
    $r.ValidLegacyFocusNoStamp = Test-ValidFocusPayload (Parse '{"type":"focus-active","title":"F","phase":"work","startedAt":1,"plannedEndAt":2,"linkType":"none","pageVisibility":"visible"}')
    $r.ValidLegacyEnded = Test-ValidFocusPayload (Parse '{"type":"focus-ended"}')
    $r.RejectsTrackingNoStart = -not (Test-ValidFocusPayload (Parse '{"type":"tracking-active","title":"x","pageVisibility":"visible"}'))
    $r.RejectsTrackingLongTitle = -not (Test-ValidFocusPayload (Parse "{`"type`":`"tracking-active`",`"title`":`"$('x' * 201)`",`"startedAt`":1,`"pageVisibility`":`"visible`"}"))
    $r.RejectsBadVisibility = -not (Test-ValidFocusPayload (Parse '{"type":"tracking-active","title":"x","startedAt":1,"pageVisibility":"maybe"}'))
    $r.RejectsStringClaim = -not (Test-ValidFocusPayload (Parse '{"type":"focus-ended","claimedAt":"soon"}'))
    $r.RejectsLongSessionKey = -not (Test-ValidFocusPayload (Parse "{`"type`":`"focus-ended`",`"sessionKey`":`"$('k' * 65)`"}"))
    $r.RejectsUnknownType = -not (Test-ValidFocusPayload (Parse '{"type":"start-timer","title":"x"}'))

    # ── Start / heartbeat / stop ──
    Reset-Hud
    $r.StartAccepted = Post (Tracking 'Deep work' 1000 2000)
    $r.HeartbeatAccepted = Post (Tracking 'Deep work' 1000 2000)
    $r.StopAccepted = Post (Ended 'tracking:1000' 3000)
    $r.StopClears = $null -eq $script:shared.Snapshot

    # ── Two tabs: a stale tab's heartbeat cannot resurrect an ended session ──
    $r.StaleTabHeartbeatDropped = -not (Post (Tracking 'Deep work' 1000 1500))
    $r.StillCleared = $null -eq $script:shared.Snapshot

    # ── Two tabs: a stale tab cannot replace a newer session, nor end it ──
    Reset-Hud
    [void](Post (Tracking 'Old task' 1000 1000))   # tab B learned of Old task
    [void](Post (Ended 'tracking:1000' 2000))      # tab A stopped it
    $r.NewSessionAccepted = Post (Tracking 'New task' 2500 2600)   # tab A started New task
    $r.StaleOldSessionDropped = -not (Post (Tracking 'Old task' 1000 1000))
    $r.StaleEndForOldSessionIgnored = -not (Post (Ended 'tracking:1000' 9000))
    $r.NewSessionStillShown = $script:shared.Snapshot.title -eq 'New task'
    $r.SecondTabSameSessionAccepted = Post (Tracking 'New task' 2500 2550)

    # ── Activity change and Focus handover ──
    Reset-Hud
    [void](Post (Tracking 'Email' 1000 1000))
    $r.ActivityChangeAccepted = (Post (Tracking 'Report' 5000 5000)) -and $script:shared.Snapshot.title -eq 'Report'
    $r.FocusStartAccepted = (Post (Focus 6000 6000)) -and $script:shared.Snapshot.type -eq 'focus-active'
    $r.FocusToTrackingAccepted = (Post (Tracking 'Report' 5000 7000)) -and $script:shared.Snapshot.type -eq 'tracking-active'
    $r.EndForAnotherSessionKeepsShown = (-not (Post (Ended 'tracking:1' 99999))) -and $script:shared.Snapshot.title -eq 'Report'
    Reset-Hud
    $r.EndedWithNothingShownIsNoop = (-not (Post (Ended 'tracking:1' 1))) -and $script:shared.ClaimFloor -eq 0

    # ── Legacy page (no stamps) keeps last-write-wins Focus behavior ──
    Reset-Hud
    $r.LegacyFocusShown = (Post (Parse '{"type":"focus-active","title":"F","phase":"work","startedAt":1,"plannedEndAt":2,"linkType":"none","pageVisibility":"visible"}')) -and $null -ne $script:shared.Snapshot
    $r.LegacyEndClears = (Post (Parse '{"type":"focus-ended"}')) -and $null -eq $script:shared.Snapshot

    # ── Rendering ──
    Reset-Hud
    [void](Post (Tracking 'Write the report' ($now - 65 * 60000) $now))
    Render-HudState
    $r.TrackingVisible = $script:window.IsVisible
    $r.TrackingLabel = $script:PhaseLabel.Text -eq 'TRACKING'
    $r.TrackingTitle = $script:TitleLabelCollapsed.Text -eq 'Write the report'
    $r.TrackingElapsed = $script:EndLabelCollapsed.Text -eq '1h 5m on task'
    $r.TrackingStarted = $script:StartedLabel.Text -eq 'Started 10:00 AM'
    $r.TrackingNoLinkLabel = $script:LinkTypeLabel.Visibility -eq 'Collapsed'
    $r.TrackingHideWording = $script:HideBtn.Content -eq 'Hide until tracking ends' -and $script:hideItem.Text -eq 'Hide until tracking ends'

    $script:privacyMode = $true
    Render-HudState
    $r.PrivacyHidesTrackingTitle = $script:TitleLabelCollapsed.Text -eq '' -and $script:TitleLabelExp.Text -eq '(hidden — privacy mode)'
    $r.PrivacyKeepsElapsed = $script:EndLabelCollapsed.Text -eq '1h 5m on task'
    $script:privacyMode = $false

    $script:shared.LastReceivedAt = [DateTime]::UtcNow.AddSeconds(-20)
    Render-HudState
    $r.VisibleStaleAfter15s = $script:EndLabelCollapsed.Text -eq 'Syncing…' -and $script:StatusDot.Fill -eq '#9CA3AF'
    $script:shared.Snapshot = Tracking 'Write the report' ($now - 65 * 60000) $now 'hidden'
    Render-HudState
    $r.HiddenTabToleratesThrottling = $script:EndLabelCollapsed.Text -eq '1h 5m on task'
    $script:shared.LastReceivedAt = [DateTime]::UtcNow

    # Hide until tracking ends; Focus handover lifts the hide; Focus wording returns.
    Render-HudState
    Hide-HudUntilFocusEnds
    Render-HudState
    $r.HideHoldsDuringSameTracking = -not $script:window.IsVisible
    $script:shared.Snapshot = Focus $now ($now + 1)
    Render-HudState
    $r.HideLiftedOnHandover = $script:window.IsVisible -and $script:PhaseLabel.Text -eq 'FOCUS'
    $r.FocusHideWordingRestored = $script:HideBtn.Content -eq 'Hide until Focus ends'
    $r.FocusShowsEndTime = $script:EndLabelCollapsed.Text -eq 'Ends ~10:30 AM'

    # Cleared → hidden, nothing invented.
    $script:shared.Snapshot = $null
    Render-HudState
    $r.ClearedHides = -not $script:window.IsVisible
    Show-Hud
    $r.ShowWithNothingDoesNotFabricate = -not $script:window.IsVisible

    return [pscustomobject]$r
  }
}

$results = & $module { Invoke-Checks }
foreach ($p in $results.PSObject.Properties) { Assert-True ([bool]$p.Value) "normal tracking: $($p.Name)" }

Write-Output "PASS: $assertions assertions"
