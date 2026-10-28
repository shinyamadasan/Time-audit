$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCandidate = (& git -C $taskRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify candidate' }
$taskPrivate = Join-Path $PSScriptRoot 'private'
New-Item -ItemType Directory -Path $taskPrivate -Force | Out-Null
$taskSessionFile = Join-Path $taskPrivate 'session.json'
if (Test-Path -LiteralPath $taskSessionFile) {
    $taskSession = Get-Content -LiteralPath $taskSessionFile -Raw | ConvertFrom-Json
    if ($taskSession.serverPid -and (Get-Process -Id $taskSession.serverPid -ErrorAction SilentlyContinue)) {
        if ($taskSession.candidate -ne $taskCandidate) { throw 'Existing test instance is a different candidate; preserve it before restarting' }
        Write-Output $taskSession.usbAppUrl
        exit 0
    }
}
$taskNode = (Get-Command node).Source
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('"' + (Join-Path $PSScriptRoot 'server.mjs') + '"', $taskCandidate) `
    -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $taskPrivate 'server.log') -RedirectStandardError (Join-Path $taskPrivate 'server-error.log')
for ($taskAttempt = 0; $taskAttempt -lt 60; $taskAttempt++) {
    Start-Sleep -Milliseconds 200
    if ($taskProcess.HasExited) { throw 'Test server failed; inspect private/server-error.log' }
    if (Test-Path -LiteralPath $taskSessionFile) {
        $taskSession = Get-Content -LiteralPath $taskSessionFile -Raw | ConvertFrom-Json
        if ($taskSession.serverPid -eq $taskProcess.Id) { Write-Output $taskSession.usbAppUrl; exit 0 }
    }
}
throw 'Test server startup did not finish'
