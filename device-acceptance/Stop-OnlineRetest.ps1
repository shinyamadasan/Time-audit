$ErrorActionPreference = 'Stop'
$taskPrivate = Join-Path $PSScriptRoot 'private'
$taskSession = Get-Content -LiteralPath (Join-Path $taskPrivate 'session.json') -Raw | ConvertFrom-Json
if ($taskSession.emulatorBase -notmatch '^http://127\.0\.0\.1:\d+$' -or $taskSession.namespace -notmatch '^deviceacceptance[a-f0-9]+$') { throw 'Refusing a non-local test session' }
$taskServerPath = Join-Path $PSScriptRoot 'server.mjs'
$taskServer = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskSession.serverPid)" -ErrorAction SilentlyContinue
$taskEmulator = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskSession.emulatorPid)" -ErrorAction SilentlyContinue
if ($taskServer -and -not $taskServer.CommandLine.Contains($taskServerPath)) { throw 'Server PID is no longer this test server' }
if ($taskEmulator -and ($taskEmulator.ParentProcessId -ne $taskSession.serverPid -or $taskEmulator.CommandLine -notmatch 'firebase-database-emulator-v4\.11\.2\.jar')) { throw 'Emulator PID is no longer this test instance' }
$taskResponse = Invoke-WebRequest -Uri "$($taskSession.emulatorBase)/.json?ns=$($taskSession.namespace)" -Headers @{Authorization='Bearer owner'} -UseBasicParsing
$taskSnapshot = Join-Path $taskPrivate ('snapshot-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.json')
[System.IO.File]::WriteAllText($taskSnapshot, $taskResponse.Content, [System.Text.UTF8Encoding]::new($false))
if ($taskServer) { Stop-Process -Id $taskServer.ProcessId }
if ($taskEmulator) { Stop-Process -Id $taskEmulator.ProcessId }
Write-Output "Test snapshot saved: $taskSnapshot"
Write-Output 'Only the matching TASK-037 test server and emulator were stopped.'
