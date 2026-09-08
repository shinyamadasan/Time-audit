#Requires -Version 7.0
<#
  ChronaSense Windows Ambient Focus HUD — Phase 6B.1

  A small always-on-top WPF window that mirrors the ONE authoritative Focus
  session already running in the ChronaSense web app (focus-mode.js). This
  process never invents Focus state and never mutates it either — it is a
  pure one-way projection of the last snapshot posted to it by
  windows-hud-bridge.js, over a loopback-only HTTP endpoint. There is no
  command channel back to the browser of any kind.

  Run directly:      pwsh -File ChronaSenseHud.ps1
  Run silently:       pwsh -WindowStyle Hidden -File ChronaSenseHud.ps1
  Exit:               right-click the tray icon -> Exit HUD companion
                       (this never ends your Focus session — see README.md)

  -DevOrigin: an EXACT additional Origin string to allow, for local testing
  only (e.g. a specific "http://localhost:8899", or the literal string "null"
  for a page opened via file://, which is ChronaSense's actual local
  dev/test workflow — see tests/smoke.spec.js). Never a wildcard/prefix.
#>

param(
  [int]$Port = 51739,
  [string]$DevOrigin = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── Singleton guard ──────────────────────────────────────────────────────
$mutexCreated = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\ChronaSenseHud_SingleInstance', [ref]$mutexCreated)
if (-not $mutexCreated) {
  [System.Windows.MessageBox]::Show(
    'ChronaSense HUD is already running (check your system tray).',
    'ChronaSense HUD', 'OK', 'Information') | Out-Null
  exit 0
}

# ── Config / allow-list ──────────────────────────────────────────────────
# Fix round 1: exact-match only, no wildcard/prefix acceptance of any port.
# ChronaSense's real local dev/test workflow loads index.html via file://
# (tests/smoke.spec.js uses pathToFileURL) — a file:// page's Origin header
# is the literal string "null", not a localhost URL, so there was never a
# real "any-port localhost" convention to preserve here.
$AllowedOrigins = @('https://shinyamadasan.github.io')
if ($DevOrigin) { $AllowedOrigins += $DevOrigin }

# Fix round 1: visibility-aware staleness. 15s was too aggressive for a
# genuinely backgrounded Chrome tab, where the browser throttles timers.
# pageVisibility is bridge-health metadata reported by windows-hud-bridge.js
# (never Focus truth) — it selects which threshold applies, it never changes
# what is displayed beyond that.
$StaleAfterVisibleMs = 15000  # tab foregrounded: ~3-4 missed 4s heartbeats
$StaleAfterHiddenMs  = 90000  # tab backgrounded: see windows-hud/README.md
                              # "Real background test" for the measured
                              # justification of this value
$HeartbeatRenderMs = 20000    # how often the UI re-renders "Ends ~..." purely from wall clock
$MaxBodyBytes = 8192          # the Focus snapshot is a handful of small fields

function Test-AllowedOrigin([string]$origin) {
  if ([string]::IsNullOrEmpty($origin)) { return $false }
  return $AllowedOrigins -contains $origin
}

# ── Settings persistence (window position, privacy mode) ────────────────
$SettingsDir = Join-Path $env:LOCALAPPDATA 'ChronaSenseHud'
$SettingsPath = Join-Path $SettingsDir 'settings.json'
New-Item -ItemType Directory -Force -Path $SettingsDir | Out-Null

function Load-HudSettings {
  $defaults = [pscustomobject]@{ x = $null; y = $null; privacyMode = $false }
  if (Test-Path $SettingsPath) {
    try {
      $loaded = Get-Content $SettingsPath -Raw | ConvertFrom-Json
      if ($null -ne $loaded.x) { $defaults.x = [double]$loaded.x }
      if ($null -ne $loaded.y) { $defaults.y = [double]$loaded.y }
      if ($null -ne $loaded.privacyMode) { $defaults.privacyMode = [bool]$loaded.privacyMode }
    } catch { }
  }
  return $defaults
}

function Save-HudSettings([double]$x, [double]$y, [bool]$privacyMode) {
  try {
    [pscustomobject]@{ x = $x; y = $y; privacyMode = $privacyMode } |
      ConvertTo-Json | Set-Content -Path $SettingsPath -Encoding utf8
  } catch { }
}

$hudSettings = Load-HudSettings

# ── Shared state between the HTTP listener thread and the UI thread ─────
# One-way only: there is no PendingCommand of any kind here. The HUD cannot
# mutate Focus state — see windows-hud-bridge.js and README.md.
$shared = [hashtable]::Synchronized(@{
  Snapshot        = $null   # last 'focus-active' payload, or $null
  LastReceivedAt  = [DateTime]::MinValue
})
$shared.Lock = New-Object object

# ══════════════════════════════════════════════════════
# WPF WINDOW
# ══════════════════════════════════════════════════════

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="ChronaSense Focus HUD"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        ResizeMode="NoResize"
        ShowInTaskbar="False"
        Topmost="True"
        SizeToContent="WidthAndHeight"
        UseLayoutRounding="True"
        SnapsToDevicePixels="True">
  <Border x:Name="RootBorder" CornerRadius="10" Background="#F0202028" BorderBrush="#33FFFFFF" BorderThickness="1" Padding="12,10">
    <StackPanel>
      <StackPanel x:Name="CollapsedPanel" Cursor="Hand">
        <StackPanel Orientation="Horizontal">
          <Ellipse x:Name="StatusDot" Width="8" Height="8" Fill="#4ade80" Margin="0,1,7,0" VerticalAlignment="Center"/>
          <TextBlock x:Name="PhaseLabel" Text="FOCUS" Foreground="#E5E7EB" FontWeight="Bold" FontSize="11" FontFamily="Segoe UI"/>
        </StackPanel>
        <TextBlock x:Name="TitleLabelCollapsed" Text="" Foreground="White" FontSize="13" FontFamily="Segoe UI"
                    TextTrimming="CharacterEllipsis" MaxWidth="230" Margin="0,3,0,0"/>
        <TextBlock x:Name="EndLabelCollapsed" Text="" Foreground="#9CA3AF" FontSize="11" FontFamily="Segoe UI" Margin="0,2,0,0"/>
      </StackPanel>

      <StackPanel x:Name="ExpandedPanel" Visibility="Collapsed" Width="250">
        <StackPanel Orientation="Horizontal">
          <Ellipse x:Name="StatusDotExp" Width="8" Height="8" Fill="#4ade80" Margin="0,1,7,0" VerticalAlignment="Center"/>
          <TextBlock x:Name="PhaseLabelExp" Text="FOCUS" Foreground="#E5E7EB" FontWeight="Bold" FontSize="12" FontFamily="Segoe UI"/>
        </StackPanel>
        <TextBlock x:Name="TitleLabelExp" Text="" Foreground="White" FontSize="14" FontFamily="Segoe UI"
                    TextWrapping="Wrap" Margin="0,6,0,0"/>
        <TextBlock x:Name="StartedLabel" Text="" Foreground="#9CA3AF" FontSize="11" FontFamily="Segoe UI" Margin="0,8,0,0"/>
        <TextBlock x:Name="EndLabelExp" Text="" Foreground="#9CA3AF" FontSize="11" FontFamily="Segoe UI" Margin="0,2,0,0"/>
        <TextBlock x:Name="LinkTypeLabel" Text="" Foreground="#7DD3FC" FontSize="11" FontFamily="Segoe UI" Margin="0,2,0,0" Visibility="Collapsed" TextWrapping="Wrap"/>
        <TextBlock x:Name="ConnLabel" Text="" Foreground="#6B7280" FontSize="10" FontFamily="Segoe UI" Margin="0,6,0,0" TextWrapping="Wrap"/>
        <StackPanel Margin="0,10,0,0">
          <Button x:Name="OpenChronaSenseBtn" Content="Open ChronaSense" Padding="8,3" HorizontalAlignment="Stretch" Margin="0,0,0,6"/>
          <StackPanel Orientation="Horizontal">
            <Button x:Name="PrivacyBtn" Content="Privacy" Padding="8,3" Margin="0,0,6,0"/>
            <Button x:Name="HideBtn" Content="Hide" Padding="8,3" Margin="0,0,6,0"/>
            <Button x:Name="CollapseBtn" Content="Collapse" Padding="8,3"/>
          </StackPanel>
        </StackPanel>
      </StackPanel>
    </StackPanel>
  </Border>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)

$find = { param($name) $window.FindName($name) }
$RootBorder          = & $find 'RootBorder'
$CollapsedPanel       = & $find 'CollapsedPanel'
$ExpandedPanel        = & $find 'ExpandedPanel'
$StatusDot            = & $find 'StatusDot'
$StatusDotExp         = & $find 'StatusDotExp'
$PhaseLabel           = & $find 'PhaseLabel'
$PhaseLabelExp        = & $find 'PhaseLabelExp'
$TitleLabelCollapsed  = & $find 'TitleLabelCollapsed'
$TitleLabelExp        = & $find 'TitleLabelExp'
$EndLabelCollapsed    = & $find 'EndLabelCollapsed'
$EndLabelExp          = & $find 'EndLabelExp'
$StartedLabel         = & $find 'StartedLabel'
$LinkTypeLabel        = & $find 'LinkTypeLabel'
$ConnLabel            = & $find 'ConnLabel'
$OpenChronaSenseBtn   = & $find 'OpenChronaSenseBtn'
$PrivacyBtn           = & $find 'PrivacyBtn'
$HideBtn              = & $find 'HideBtn'
$CollapseBtn          = & $find 'CollapseBtn'

$window.Topmost = $true
$window.ShowActivated = $false  # don't steal keyboard focus when it first appears

# ── Position: restore + clamp to visible bounds ──────────────────────────
function Get-DefaultCorner {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  return @{ x = $wa.Right - 280; y = $wa.Bottom - 140 }
}

function Clamp-ToVisibleBounds([double]$x, [double]$y) {
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $wa = $s.WorkingArea
    if ($x -ge ($wa.Left - 260) -and $x -le $wa.Right -and $y -ge ($wa.Top - 140) -and $y -le $wa.Bottom) {
      return @{ x = $x; y = $y }
    }
  }
  $d = Get-DefaultCorner
  return $d
}

$startPos = if ($null -ne $hudSettings.x -and $null -ne $hudSettings.y) {
  Clamp-ToVisibleBounds -x $hudSettings.x -y $hudSettings.y
} else {
  Get-DefaultCorner
}
$window.Left = $startPos.x
$window.Top = $startPos.y

$privacyMode = [bool]$hudSettings.privacyMode

# ── Collapse / expand ─────────────────────────────────────────────────────
# Re-clamp after every size change: the default/persisted position anchors
# the window's top-left corner, so growing from a bottom-right corner (the
# default) would otherwise push the taller expanded card off the bottom of
# the screen. UpdateLayout() forces WPF to recompute ActualWidth/Height
# immediately so the clamp uses real post-resize dimensions, not stale ones.
function Clamp-WindowToScreen {
  $probe = New-Object System.Drawing.Rectangle([int]$window.Left, [int]$window.Top, [Math]::Max(1,[int]$window.ActualWidth), [Math]::Max(1,[int]$window.ActualHeight))
  $wa = [System.Windows.Forms.Screen]::FromRectangle($probe).WorkingArea
  $newLeft = [Math]::Min($window.Left, $wa.Right - $window.ActualWidth)
  $newLeft = [Math]::Max($newLeft, $wa.Left)
  $newTop = [Math]::Min($window.Top, $wa.Bottom - $window.ActualHeight)
  $newTop = [Math]::Max($newTop, $wa.Top)
  $window.Left = $newLeft
  $window.Top = $newTop
}

$isExpanded = $false
function Set-Expanded([bool]$expand) {
  $script:isExpanded = $expand
  $CollapsedPanel.Visibility = if ($expand) { 'Collapsed' } else { 'Visible' }
  $ExpandedPanel.Visibility = if ($expand) { 'Visible' } else { 'Collapsed' }
  $window.UpdateLayout()
  Clamp-WindowToScreen
}
$CollapseBtn.Add_Click({ Set-Expanded $false })

# ── Dragging + click-to-expand ───────────────────────────────────────────
# Deliberately NOT using Window.DragMove(): it runs its own internal modal
# loop and swallows the MouseLeftButtonUp that follows, which would silently
# break "click the collapsed card to expand it". Tracking the drag manually
# lets a plain click (no movement) still reach MouseLeftButtonUp.
$dragStart = $null
$dragMoved = $false
$RootBorder.Add_MouseLeftButtonDown({
  param($s, $e)
  if ($e.OriginalSource -is [System.Windows.Controls.Button]) { return }
  $script:dragStart = $e.GetPosition($window)
  $script:dragMoved = $false
  $RootBorder.CaptureMouse()
})
$RootBorder.Add_MouseMove({
  param($s, $e)
  if ($e.LeftButton -ne 'Pressed' -or $null -eq $script:dragStart) { return }
  $pos = $e.GetPosition($window)
  $dx = $pos.X - $script:dragStart.X
  $dy = $pos.Y - $script:dragStart.Y
  if (-not $script:dragMoved -and ([Math]::Abs($dx) -lt 3 -and [Math]::Abs($dy) -lt 3)) { return }
  $script:dragMoved = $true
  $window.Left += $dx
  $window.Top += $dy
})
$RootBorder.Add_MouseLeftButtonUp({
  param($s, $e)
  if ($e.OriginalSource -is [System.Windows.Controls.Button]) { return }
  $RootBorder.ReleaseMouseCapture()
  if ($script:dragMoved) {
    Save-HudSettings -x $window.Left -y $window.Top -privacyMode $privacyMode
  } elseif (-not $script:isExpanded) {
    Set-Expanded $true
  }
  $script:dragStart = $null
  $script:dragMoved = $false
})

# ── Hide until Focus ends (does not touch Focus state at all) ───────────
$hiddenUntilEnd = $false
$HideBtn.Add_Click({
  $script:hiddenUntilEnd = $true
  $window.Hide()
})

# ── Privacy mode: conceal the task title, keep phase + time only ────────
function Render-Privacy {
  if ($script:privacyMode) {
    $TitleLabelCollapsed.Text = ''
    $PrivacyBtn.Content = 'Show title'
  } else {
    $PrivacyBtn.Content = 'Privacy'
  }
}
$PrivacyBtn.Add_Click({
  $script:privacyMode = -not $script:privacyMode
  Save-HudSettings -x $window.Left -y $window.Top -privacyMode $script:privacyMode
  Render-HudState
})

# ── Open ChronaSense: the only "action" button. Opens the real app so the
# user can use its authoritative controls (End Focus, etc). Never mutates
# Focus state itself — it's just Start-Process on a URL.
$OpenChronaSenseBtn.Add_Click({
  try { Start-Process 'https://shinyamadasan.github.io/Time-audit/' } catch { }
})

# ══════════════════════════════════════════════════════
# RENDERING — pure projection of $shared.Snapshot, no local timer math
# beyond wall-clock formatting of an already-known plannedEndAt.
# ══════════════════════════════════════════════════════

function Format-EndTime([double]$plannedEndAtMs) {
  $end = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$plannedEndAtMs).ToLocalTime()
  return "Ends ~$($end.ToString('h:mm tt'))"
}

function Format-Started([double]$startedAtMs) {
  $start = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$startedAtMs).ToLocalTime()
  return "Started $($start.ToString('h:mm tt'))"
}

function Write-HudDebug([string]$msg) {
  if ($env:CHRONASENSE_HUD_DEBUG) { Add-Content -Path $env:CHRONASENSE_HUD_DEBUG -Value "$(Get-Date -Format o) $msg" }
}

$LinkTypeLabelText = @{ 'daily-routine' = 'Scheduled routine'; 'learning-plan' = 'Learning plan' }

function Render-HudState {
 try {
  [System.Threading.Monitor]::Enter($shared.Lock)
  try {
    $snap = $shared.Snapshot
    $lastAt = $shared.LastReceivedAt
  } finally { [System.Threading.Monitor]::Exit($shared.Lock) }

  if ($null -eq $snap) {
    # "Hide until Focus ends" means exactly that — once there is no active
    # Focus (this snapshot is null on focus-ended, same as on companion
    # startup with nothing running yet), the hide is fulfilled and clears.
    # Presentation-state only: this does not touch $shared, the listener, or
    # anything Focus-related — a later focus-active snapshot is then free to
    # show the HUD normally again.
    $script:hiddenUntilEnd = $false
    if ($window.IsVisible) { $window.Hide() }
    return
  }

  # Fix round 1: visibility-aware staleness. pageVisibility is bridge-health
  # metadata reported by the page itself — it only selects which threshold
  # applies below; it is never displayed as Focus truth.
  $staleThresholdMs = if ($snap.pageVisibility -eq 'hidden') { $StaleAfterHiddenMs } else { $StaleAfterVisibleMs }
  $isStale = ([DateTime]::UtcNow - $lastAt).TotalMilliseconds -gt $staleThresholdMs
  $phaseText = if ($snap.phase -eq 'break') { 'BREAK' } else { 'FOCUS' }
  $dotColor = if ($isStale) { '#9CA3AF' } elseif ($snap.phase -eq 'break') { '#60A5FA' } else { '#4ade80' }

  $PhaseLabel.Text = $phaseText; $PhaseLabelExp.Text = $phaseText
  $StatusDot.Fill = $dotColor; $StatusDotExp.Fill = $dotColor

  $title = if ($privacyMode) { '' } else { [string]$snap.title }
  $TitleLabelCollapsed.Text = $title
  $TitleLabelExp.Text = if ($privacyMode) { '(hidden — privacy mode)' } else { $title }

  $endText = if ($isStale) { 'Syncing…' } else { Format-EndTime -plannedEndAtMs $snap.plannedEndAt }
  $EndLabelCollapsed.Text = $endText
  $EndLabelExp.Text = $endText
  $StartedLabel.Text = Format-Started -startedAtMs $snap.startedAt

  $linkLabel = $LinkTypeLabelText[[string]$snap.linkType]
  if ($linkLabel) {
    $LinkTypeLabel.Text = $linkLabel
    $LinkTypeLabel.Visibility = 'Visible'
  } else {
    $LinkTypeLabel.Visibility = 'Collapsed'
  }

  $ConnLabel.Text = if ($isStale) { 'Not confirmed — companion has not heard from ChronaSense recently.' } else { 'Synced' }
  Render-Privacy

  if (-not $script:hiddenUntilEnd -and -not $window.IsVisible) { $window.Show() }
 } catch {
  Write-HudDebug "Render-HudState ERROR: $_"
 }
}

$renderTimer = New-Object System.Windows.Threading.DispatcherTimer
$renderTimer.Interval = [TimeSpan]::FromMilliseconds($HeartbeatRenderMs)
$renderTimer.Add_Tick({ Render-HudState })
$renderTimer.Start()

# ══════════════════════════════════════════════════════
# LOCAL HTTP BRIDGE — loopback only, Origin allow-listed
# ══════════════════════════════════════════════════════

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/focus-bridge/")
$listener.Start()

# A bare .NET Thread has no PowerShell engine/runspace attached to it at all —
# not even variable lookups work there. The listener loop needs its own real
# runspace (via System.Management.Automation.PowerShell), with the shared
# objects handed in explicitly; it marshals back to the UI thread for every
# render via $window.Dispatcher, which runs on the main runspace correctly.
# IMPORTANT: this delegate must be built HERE, in the main runspace, where
# Render-HudState is actually defined. A PowerShell scriptblock resolves
# commands against the runspace it was PARSED in, not the thread that later
# invokes it — building "[action]{ Render-HudState }" inline inside the
# listener's own .AddScript() text (a different runspace) fails at
# invocation time with "Render-HudState is not recognized", even though
# Dispatcher.Invoke correctly marshals execution to the UI thread. Passing
# this pre-built delegate in as a variable sidesteps that entirely.
$renderOnUiThread = [action]{ Render-HudState }

$listenerRunspace = [runspacefactory]::CreateRunspace()
$listenerRunspace.Open()
$listenerRunspace.SessionStateProxy.SetVariable('listener', $listener)
$listenerRunspace.SessionStateProxy.SetVariable('shared', $shared)
$listenerRunspace.SessionStateProxy.SetVariable('window', $window)
$listenerRunspace.SessionStateProxy.SetVariable('renderOnUiThread', $renderOnUiThread)
$listenerRunspace.SessionStateProxy.SetVariable('AllowedOrigins', $AllowedOrigins)
$listenerRunspace.SessionStateProxy.SetVariable('MaxBodyBytes', $MaxBodyBytes)

$listenerPS = [powershell]::Create()
$listenerPS.Runspace = $listenerRunspace
[void]$listenerPS.AddScript({
  function Test-AllowedOriginLocal([string]$origin) {
    if ([string]::IsNullOrEmpty($origin)) { return $false }
    return $AllowedOrigins -contains $origin
  }

  # Strict, bounded shape check — the snapshot is a handful of small,
  # explicit fields; reject anything that doesn't match rather than trusting
  # whatever ConvertFrom-Json happened to produce.
  function Test-ValidFocusPayload($payload) {
    if ($null -eq $payload) { return $false }
    if ($payload.type -eq 'focus-ended') { return $true }
    if ($payload.type -ne 'focus-active') { return $false }
    if ($payload.title -isnot [string] -or $payload.title.Length -gt 200) { return $false }
    if ($payload.phase -ne 'work' -and $payload.phase -ne 'break') { return $false }
    if ($payload.startedAt -isnot [double] -and $payload.startedAt -isnot [int] -and $payload.startedAt -isnot [long]) { return $false }
    if ($payload.plannedEndAt -isnot [double] -and $payload.plannedEndAt -isnot [int] -and $payload.plannedEndAt -isnot [long]) { return $false }
    if ($payload.linkType -ne 'daily-routine' -and $payload.linkType -ne 'learning-plan' -and $payload.linkType -ne 'none') { return $false }
    if ($payload.pageVisibility -ne 'visible' -and $payload.pageVisibility -ne 'hidden') { return $false }
    return $true
  }

  while ($listener.IsListening) {
    try {
      $ctx = $listener.GetContext()
    } catch {
      if ($listener.IsListening) { continue } else { break }
    }
    try {
      $req = $ctx.Request
      $res = $ctx.Response
      $origin = $req.Headers['Origin']
      $allowed = Test-AllowedOriginLocal $origin

      if ($allowed) {
        $res.Headers.Add('Access-Control-Allow-Origin', $origin)
        $res.Headers.Add('Access-Control-Allow-Methods', 'POST, OPTIONS')
        $res.Headers.Add('Access-Control-Allow-Headers', 'Content-Type')
        $res.Headers.Add('Access-Control-Allow-Private-Network', 'true')
      }

      if ($req.HttpMethod -eq 'OPTIONS') {
        $res.StatusCode = 204
        $res.Close()
        continue
      }

      if (-not $allowed -or $req.HttpMethod -ne 'POST') {
        $res.StatusCode = 403
        $res.Close()
        continue
      }

      if ($req.ContentLength64 -gt $MaxBodyBytes) {
        $res.StatusCode = 413
        $res.Close()
        continue
      }

      $body = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
      $text = $body.ReadToEnd()
      $body.Dispose()

      if ($text.Length -gt $MaxBodyBytes) {
        $res.StatusCode = 413
        $res.Close()
        continue
      }

      $payload = $null
      try { $payload = $text | ConvertFrom-Json } catch { }

      if (-not (Test-ValidFocusPayload $payload)) {
        $res.StatusCode = 400
        $res.Close()
        continue
      }

      # Opt-in only (env var gated, zero cost otherwise) — used to measure
      # real bridge-contact intervals under background throttling. Written
      # directly here rather than via the main runspace's Write-HudDebug:
      # a function defined in one runspace is not resolvable from a
      # scriptblock parsed in another (see the note above on
      # $renderOnUiThread) — env vars are process-wide, so this is the
      # simplest way to log from inside this runspace.
      if ($env:CHRONASENSE_HUD_DEBUG) {
        [System.IO.File]::AppendAllText($env:CHRONASENSE_HUD_DEBUG, "$(Get-Date -Format o) recv type=$($payload.type) pageVisibility=$($payload.pageVisibility)`n")
      }

      if ($payload.type -eq 'focus-active') {
        [System.Threading.Monitor]::Enter($shared.Lock)
        try {
          $shared.Snapshot = $payload
          $shared.LastReceivedAt = [DateTime]::UtcNow
        } finally { [System.Threading.Monitor]::Exit($shared.Lock) }
      } else {
        [System.Threading.Monitor]::Enter($shared.Lock)
        try {
          $shared.Snapshot = $null
          $shared.LastReceivedAt = [DateTime]::UtcNow
        } finally { [System.Threading.Monitor]::Exit($shared.Lock) }
      }

      $window.Dispatcher.BeginInvoke($renderOnUiThread) | Out-Null

      # One-way only: no response body, no command of any kind is ever
      # returned to the browser.
      $res.StatusCode = 204
      $res.Close()
    } catch {
      try { $ctx.Response.StatusCode = 500; $ctx.Response.Close() } catch { }
    }
  }
}) | Out-Null
$listenerAsyncResult = $listenerPS.BeginInvoke()

# ══════════════════════════════════════════════════════
# SYSTEM TRAY
# ══════════════════════════════════════════════════════

function New-TrayIcon {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillEllipse([System.Drawing.Brushes]::MediumSeaGreen, 1, 1, 14, 14)
  $g.Dispose()
  $hIcon = $bmp.GetHicon()
  return [System.Drawing.Icon]::FromHandle($hIcon)
}

$trayIcon = New-Object System.Windows.Forms.NotifyIcon
$trayIcon.Icon = New-TrayIcon
$trayIcon.Text = 'ChronaSense Focus HUD'
$trayIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$showItem = $menu.Items.Add('Show HUD')
$hideItem = $menu.Items.Add('Hide HUD')
$openItem = $menu.Items.Add('Open ChronaSense')
$menu.Items.Add('-') | Out-Null
$exitItem = $menu.Items.Add('Exit HUD companion')
$trayIcon.ContextMenuStrip = $menu

$showItem.Add_Click({ $script:hiddenUntilEnd = $false; Render-HudState })
$hideItem.Add_Click({ $script:hiddenUntilEnd = $true; $window.Hide() })
$openItem.Add_Click({ Start-Process 'https://shinyamadasan.github.io/Time-audit/' })
function Stop-HudListener {
  try { $listener.Stop() } catch { }
  try { $listenerPS.Stop() } catch { }
  try { $listenerPS.Dispose() } catch { }
  try { $listenerRunspace.Close() } catch { }
}

$exitItem.Add_Click({
  # Exiting the companion NEVER ends Focus — it just stops projecting it.
  $trayIcon.Visible = $false
  Stop-HudListener
  $window.Close()
  [System.Windows.Application]::Current.Shutdown()
})

$window.Add_Closed({
  $trayIcon.Visible = $false
  Stop-HudListener
  $mutex.ReleaseMutex()
})

# ── First paint: hidden until a real 'focus-active' snapshot arrives ────
$window.Hide()
Render-Privacy

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnExplicitShutdown'
$app.Add_DispatcherUnhandledException({
  param($s, $e)
  Write-HudDebug "DispatcherUnhandledException: $($e.Exception)"
  $e.Handled = $true
})
$app.Run() | Out-Null
