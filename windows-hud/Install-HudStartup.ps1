#Requires -Version 7.0
[CmdletBinding()]
param(
  [string]$StartupDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
)

$ErrorActionPreference = 'Stop'
$ShortcutName = 'ChronaSense Focus HUD.lnk'
$ManagedDescription = 'ChronaSense Focus HUD startup shortcut managed by Install-HudStartup.ps1'

if ([string]::IsNullOrWhiteSpace($StartupDirectory)) {
  throw 'The current user Startup folder could not be resolved.'
}

$hudScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'ChronaSenseHud.ps1'))
if (-not (Test-Path -LiteralPath $hudScript -PathType Leaf)) {
  throw "ChronaSense HUD script not found: $hudScript"
}

$pwshPath = (Get-Process -Id $PID).Path
$startupPath = [System.IO.Path]::GetFullPath($StartupDirectory)
$shortcutPath = Join-Path $startupPath $ShortcutName
$arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}"' -f $hudScript

New-Item -ItemType Directory -Force -Path $startupPath | Out-Null
$shell = New-Object -ComObject WScript.Shell

if (Test-Path -LiteralPath $shortcutPath) {
  $existing = $shell.CreateShortcut($shortcutPath)
  if ($existing.Description -ne $ManagedDescription) {
    throw "Refusing to replace an unmanaged startup item: $shortcutPath"
  }
}

$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pwshPath
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Description = $ManagedDescription
$shortcut.Save()

Write-Output "ChronaSense Focus HUD auto-start installed for the current user."
Write-Output "Shortcut: $shortcutPath"
Write-Output "Target: $pwshPath $arguments"
Write-Output 'The HUD will start automatically at the next Windows login.'
