#Requires -Version 7.0

$ErrorActionPreference = 'Stop'
$assertions = 0

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw "ASSERTION FAILED: $message" }
  $script:assertions++
}

function Parse-Script([string]$path) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $path, [ref]$tokens, [ref]$errors)
  Assert-True ($errors.Count -eq 0) "$path parses without errors"
  return $ast
}

function Get-FunctionSource($ast, [string]$name) {
  $functions = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
  }, $true))
  $match = @($functions | Where-Object Name -eq $name)
  Assert-True ($match.Count -eq 1) "exactly one $name function exists"
  return $match[0].Extent.Text
}

$hudPath = Join-Path $PSScriptRoot 'ChronaSenseHud.ps1'
$installPath = Join-Path $PSScriptRoot 'Install-HudStartup.ps1'
$removePath = Join-Path $PSScriptRoot 'Remove-HudStartup.ps1'

$hudAst = Parse-Script $hudPath
[void](Parse-Script $installPath)
[void](Parse-Script $removePath)

$hudText = Get-Content -LiteralPath $hudPath -Raw
Assert-True ($hudText.Contains('Content="Hide until Focus ends"')) 'expanded Hide wording is explicit'
Assert-True ($hudText.Contains("`$menu.Items.Add('Show HUD')")) 'tray recovery says Show HUD'
Assert-True ($hudText.Contains("`$menu.Items.Add('Hide until Focus ends')")) 'tray Hide wording is explicit'
Assert-True (([regex]::Matches($hudText, 'Add_Click\(\{ Hide-HudUntilFocusEnds \}\)')).Count -eq 2) 'both Hide actions share the same behavior'
Assert-True ($hudText.Contains("`$showItem.Add_Click({ Show-Hud })")) 'tray Show uses the recovery behavior'

$mutexAt = $hudText.IndexOf("Local\ChronaSenseHud_SingleInstance", [StringComparison]::Ordinal)
$listenerAt = $hudText.IndexOf('$listener.Start()', [StringComparison]::Ordinal)
Assert-True ($mutexAt -ge 0 -and $mutexAt -lt $listenerAt) 'single-instance mutex remains before listener startup'

$hideSource = Get-FunctionSource $hudAst 'Hide-HudUntilFocusEnds'
$showSource = Get-FunctionSource $hudAst 'Show-Hud'
$renderSource = Get-FunctionSource $hudAst 'Render-HudState'

$stateModule = New-Module -ScriptBlock {
  param($hideSource, $showSource, $renderSource)

  $script:hiddenUntilEnd = $false
  $script:privacyMode = $false
  $script:StaleAfterHiddenMs = 90000
  $script:StaleAfterVisibleMs = 15000
  $script:LinkTypeLabelText = @{}
  $script:shared = [hashtable]::Synchronized(@{
    Snapshot = $null
    LastReceivedAt = [DateTime]::UtcNow
  })
  $script:shared.Lock = New-Object object

  $script:window = [pscustomobject]@{ IsVisible = $false }
  $script:window | Add-Member ScriptMethod Show { $this.IsVisible = $true }
  $script:window | Add-Member ScriptMethod Hide { $this.IsVisible = $false }

  function New-TestLabel {
    return [pscustomobject]@{ Text = ''; Fill = ''; Visibility = 'Collapsed' }
  }
  $script:PhaseLabel = New-TestLabel
  $script:PhaseLabelExp = New-TestLabel
  $script:StatusDot = New-TestLabel
  $script:StatusDotExp = New-TestLabel
  $script:TitleLabelCollapsed = New-TestLabel
  $script:TitleLabelExp = New-TestLabel
  $script:EndLabelCollapsed = New-TestLabel
  $script:EndLabelExp = New-TestLabel
  $script:StartedLabel = New-TestLabel
  $script:LinkTypeLabel = New-TestLabel
  $script:ConnLabel = New-TestLabel

  function Format-EndTime { return 'Ends ~10:30 AM' }
  function Format-Started { return 'Started 10:00 AM' }
  function Render-Privacy { }
  function Write-HudDebug { }

  Invoke-Expression $hideSource
  Invoke-Expression $showSource
  Invoke-Expression $renderSource

  function New-ActiveSnapshot([string]$title) {
    return [pscustomobject]@{
      title = $title
      phase = 'work'
      startedAt = 1
      plannedEndAt = 2
      linkType = 'none'
      pageVisibility = 'visible'
    }
  }

  function Invoke-PresentationContract {
    $script:shared.Snapshot = New-ActiveSnapshot 'Current Focus'
    $script:shared.LastReceivedAt = [DateTime]::UtcNow
    Render-HudState
    $activeInitiallyVisible = $script:window.IsVisible

    Hide-HudUntilFocusEnds
    $hiddenCurrentFocus = $script:hiddenUntilEnd -and -not $script:window.IsVisible

    Show-Hud
    $showClearsSuppression = -not $script:hiddenUntilEnd
    $showRestoresCurrentFocus = $script:window.IsVisible -and $script:TitleLabelCollapsed.Text -eq 'Current Focus'

    Hide-HudUntilFocusEnds
    $script:shared.Snapshot = $null
    Render-HudState
    $endClearsSuppression = -not $script:hiddenUntilEnd -and -not $script:window.IsVisible

    $script:shared.Snapshot = New-ActiveSnapshot 'Next Focus'
    $script:shared.LastReceivedAt = [DateTime]::UtcNow
    Render-HudState
    $nextFocusVisible = $script:window.IsVisible -and $script:TitleLabelCollapsed.Text -eq 'Next Focus'

    $script:shared.Snapshot = $null
    $script:hiddenUntilEnd = $true
    $script:window.Hide()
    Show-Hud
    $noFocusShowDoesNotFabricate = -not $script:window.IsVisible
    $noFocusShowClearsSuppression = -not $script:hiddenUntilEnd

    return [pscustomobject]@{
      ActiveInitiallyVisible = $activeInitiallyVisible
      HiddenCurrentFocus = $hiddenCurrentFocus
      ShowClearsSuppression = $showClearsSuppression
      ShowRestoresCurrentFocus = $showRestoresCurrentFocus
      EndClearsSuppression = $endClearsSuppression
      NextFocusVisible = $nextFocusVisible
      NoFocusShowDoesNotFabricate = $noFocusShowDoesNotFabricate
      NoFocusShowClearsSuppression = $noFocusShowClearsSuppression
    }
  }
} -ArgumentList $hideSource, $showSource, $renderSource

$state = & $stateModule { Invoke-PresentationContract }
foreach ($property in $state.PSObject.Properties) {
  Assert-True ([bool]$property.Value) "presentation contract: $($property.Name)"
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("chronasense-hud-startup-test-$([guid]::NewGuid().ToString('N'))")
$testStartup = Join-Path $testRoot 'Startup'
try {
  & $installPath -StartupDirectory $testStartup | Out-Null
  & $installPath -StartupDirectory $testStartup | Out-Null

  $links = @(Get-ChildItem -LiteralPath $testStartup -Filter '*.lnk')
  Assert-True ($links.Count -eq 1) 'rerunning install creates exactly one shortcut'

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($links[0].FullName)
  $expectedHudPath = [System.IO.Path]::GetFullPath($hudPath)
  $expectedPwshPath = (Get-Process -Id $PID).Path
  $expectedArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}"' -f $expectedHudPath
  Assert-True ($shortcut.TargetPath -eq $expectedPwshPath) 'shortcut targets the installed pwsh executable'
  Assert-True ($shortcut.Arguments -eq $expectedArguments) 'shortcut arguments quote the current HUD script path'
  Assert-True ($shortcut.Arguments -notmatch 'DevOrigin|127\.0\.0\.1:4173') 'normal startup contains no development origin override'
  Assert-True ($shortcut.WorkingDirectory -eq $PSScriptRoot) 'shortcut working directory is the HUD directory'

  $unrelatedPath = Join-Path $testStartup 'Unrelated Startup Item.lnk'
  $unrelated = $shell.CreateShortcut($unrelatedPath)
  $unrelated.TargetPath = Join-Path $env:SystemRoot 'System32\notepad.exe'
  $unrelated.Description = 'Unrelated test startup item'
  $unrelated.Save()

  & $removePath -StartupDirectory $testStartup | Out-Null
  Assert-True (-not (Test-Path -LiteralPath $links[0].FullName)) 'remove deletes the installer-owned shortcut'
  Assert-True (Test-Path -LiteralPath $unrelatedPath) 'remove preserves unrelated startup items'

  & $removePath -StartupDirectory $testStartup | Out-Null
  Assert-True (Test-Path -LiteralPath $unrelatedPath) 'rerunning remove remains safe'

  $unmanagedPath = Join-Path $testStartup 'ChronaSense Focus HUD.lnk'
  $unmanaged = $shell.CreateShortcut($unmanagedPath)
  $unmanaged.TargetPath = Join-Path $env:SystemRoot 'System32\notepad.exe'
  $unmanaged.Description = 'Not managed by ChronaSense'
  $unmanaged.Save()
  $removeRefused = $false
  try {
    & $removePath -StartupDirectory $testStartup | Out-Null
  } catch {
    $removeRefused = $true
  }
  Assert-True $removeRefused 'remove refuses a same-named unmanaged shortcut'
  Assert-True (Test-Path -LiteralPath $unmanagedPath) 'remove leaves a same-named unmanaged shortcut intact'
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}

Write-Output "PASS: $assertions assertions"
