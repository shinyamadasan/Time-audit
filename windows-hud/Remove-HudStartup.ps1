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

$shortcutPath = Join-Path ([System.IO.Path]::GetFullPath($StartupDirectory)) $ShortcutName
if (-not (Test-Path -LiteralPath $shortcutPath)) {
  Write-Output 'ChronaSense Focus HUD auto-start is not installed.'
  return
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ($shortcut.Description -ne $ManagedDescription) {
  throw "Refusing to remove an unmanaged startup item: $shortcutPath"
}

Remove-Item -LiteralPath $shortcutPath -Force
Write-Output 'ChronaSense Focus HUD auto-start removed for the current user.'
