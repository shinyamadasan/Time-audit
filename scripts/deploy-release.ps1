#Requires -Version 5.1
<#
.SYNOPSIS
  Explicit, opt-in native (Capacitor Android) sync for a release build.

.DESCRIPTION
  This is the ONLY script in the repo that runs `npx cap sync android`. It is a
  deliberate, user-initiated action — it is never called by sync.bat, sync.sh,
  the runtime-mirror helper, the test suite, or CI.

  What it does:
    1. Refuses to run on `main` (release work happens on a branch).
    2. Requires an explicit -Confirm switch — a bare run only prints the plan.
    3. Verifies static root <-> www/ parity (scripts/runtime-mirror.mjs --check)
       and aborts on drift.
    4. Runs `npx cap sync android`.
    5. STOPS. It performs no version-control mutations of any kind and never
       publishes `main`. Staging the synced native project and opening
       Android Studio to build the APK are manual steps the user takes next.

.PARAMETER Confirm
  Actually perform the native sync. Without it, the script is a dry run.

.EXAMPLE
  pwsh scripts/deploy-release.ps1            # dry run: prints the plan
  pwsh scripts/deploy-release.ps1 -Confirm   # runs the parity check + cap sync
#>
[CmdletBinding()]
param(
  [switch]$Confirm
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -eq 'main') {
  Write-Error "Refusing to run on 'main'. Native/release sync must happen on a release branch (e.g. release/android-<version>). This script never publishes main directly."
  exit 2
}

Write-Host "deploy-release — native (Capacitor Android) sync"
Write-Host "  repo    : $RepoRoot"
Write-Host "  branch  : $branch"
Write-Host ""
Write-Host "Plan:"
Write-Host "  1. node scripts/runtime-mirror.mjs --check   (abort on drift)"
Write-Host "  2. npx cap sync android"
Write-Host "  3. STOP — review 'git status', stage + record the native project"
Write-Host "     yourself, then open Android Studio to build the APK."
Write-Host ""

if (-not $Confirm) {
  Write-Host "Dry run only. Re-run with -Confirm to execute steps 1-2." -ForegroundColor Yellow
  exit 0
}

Write-Host "[1/2] Verifying static root <-> www/ runtime parity..."
& node "$RepoRoot/scripts/runtime-mirror.mjs" --check
if ($LASTEXITCODE -ne 0) {
  Write-Error "www/ runtime parity check failed. Run 'node scripts/runtime-mirror.mjs --write', review and commit the mirror, then retry."
  exit 1
}

Write-Host ""
Write-Host "[2/2] Running native sync (npx cap sync android)..."
& npx cap sync android
if ($LASTEXITCODE -ne 0) {
  Write-Error "cap sync android failed."
  exit 1
}

Write-Host ""
Write-Host "Native sync complete. Next steps (manual, on this branch):" -ForegroundColor Green
Write-Host "  - review 'git status'; stage and record android/ yourself"
Write-Host "  - open the Android project and build/sign the APK"
Write-Host "  - open a PR from the release branch; never publish main directly"
