<#
.SYNOPSIS
  Generate a compact AI OS state packet for Claude/Codex handoffs.

.DESCRIPTION
  Reads the hot-path workflow files and writes OPS_STATE.md. This gives agents a
  short first-read summary before they decide which larger files are actually
  needed. The script is deterministic and performs no git writes.
#>
param([string]$OutFile)

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
if (-not $OutFile) { $OutFile = Join-Path $root 'OPS_STATE.md' }

function Read-Text([string]$Path) {
    if (-not (Test-Path $Path)) { return '' }
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Collapse-Text([string]$Text, [int]$Max = 220) {
    $oneLine = (($Text -replace '\r?\n', ' ') -replace '\s+', ' ').Trim()
    if ($oneLine.Length -le $Max) { return $oneLine }
    return $oneLine.Substring(0, $Max - 3) + '...'
}

function Get-Section([string]$Text, [string]$Heading) {
    $pattern = "(?ms)^##\s+$([regex]::Escape($Heading))\s*\r?\n(?<body>.*?)(?=^##\s+|\z)"
    $m = [regex]::Match($Text, $pattern)
    if ($m.Success) { return $m.Groups['body'].Value.Trim() }
    return ''
}

function Get-FirstHeading([string]$Text, [string]$Pattern) {
    $m = [regex]::Match($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if ($m.Success) { return $m.Groups[1].Value.Trim() }
    return 'none'
}

function Get-LastHeading([string]$Text, [string]$Pattern) {
    $matches = [regex]::Matches($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if ($matches.Count -eq 0) { return 'none' }
    return $matches[$matches.Count - 1].Groups[1].Value.Trim()
}

function Invoke-Git([string[]]$GitArgs) {
    try {
        $output = & git @GitArgs 2>$null
        if ($LASTEXITCODE -ne 0) { return @() }
        return @($output)
    } catch {
        return @()
    }
}

function Get-Field([string]$Text, [string]$Name) {
    $m = [regex]::Match($Text, "(?m)^$([regex]::Escape($Name)):\s*(?<value>[^\r\n]+)")
    if ($m.Success) { return $m.Groups['value'].Value.Trim() }
    return ''
}

function Get-TaskBlocks([string]$TasksText) {
    $body = ($TasksText -split '<!-- TASK TEMPLATE')[0]
    $matches = [regex]::Matches(
        $body,
        '(?ms)^###\s+(?<id>TASK-\d+)\s*(?:[^\p{L}\p{N}\r\n]+\s*)?(?<title>.+?)\r?\n(?<rest>.*?)(?=^###\s+TASK-\d+|\z)'
    )

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($m in $matches) {
        $rest = $m.Groups['rest'].Value
        $items.Add([pscustomobject]@{
            Id      = $m.Groups['id'].Value.Trim()
            Title   = $m.Groups['title'].Value.Trim()
            Status  = (Get-Field $rest 'status')
            Owner   = (Get-Field $rest 'owner')
            Source  = (Get-Field $rest 'source')
            Depends = (Get-Field $rest 'depends-on')
            Files   = (Get-Field $rest 'files')
        })
    }
    return $items.ToArray()
}

function Get-OwnerForStatus([string]$Status) {
    switch ($Status) {
        'codex' { return 'Codex' }
        'in-progress' { return 'Codex' }
        'review' { return 'Claude' }
        'approved' { return 'Claude' }
        'blocked' { return 'Claude' }
        'rework' { return 'Claude' }
        default { return 'Unknown' }
    }
}

$tasksPath = Join-Path $root 'TASKS.md'
$planPath = Join-Path $root 'PLAN.md'
$changelogPath = Join-Path $root 'CHANGELOG.md'
$testReportPath = Join-Path $root 'TEST_REPORT.md'
$reviewPath = Join-Path $root 'REVIEW.md'
$codexReadyPath = Join-Path $root 'planning/CODEX_READY.md'

$tasksText = Read-Text $tasksPath
$planText = Read-Text $planPath
$changelogText = Read-Text $changelogPath
$testReportText = Read-Text $testReportPath
$reviewText = Read-Text $reviewPath
$codexReadyText = Read-Text $codexReadyPath

$tasks = Get-TaskBlocks $tasksText
$activeStatuses = @('codex', 'in-progress', 'review', 'blocked', 'approved', 'rework')
$activeTasks = @($tasks | Where-Object { $activeStatuses -contains $_.Status })
$nextTask = $null
if ($activeTasks.Count -gt 0) { $nextTask = $activeTasks[0] }

$statusOrder = @('codex', 'in-progress', 'review', 'blocked', 'approved', 'rework', 'done', 'todo')
$statusParts = New-Object System.Collections.Generic.List[string]
foreach ($status in $statusOrder) {
    $count = @($tasks | Where-Object { $_.Status -eq $status }).Count
    if ($count -gt 0) { $statusParts.Add("${status}: $count") }
}
if ($statusParts.Count -eq 0) { $statusParts.Add('none') }

$codexIds = @($tasks | Where-Object { $_.Status -eq 'codex' } | ForEach-Object { $_.Id })
$readyIds = @([regex]::Matches($codexReadyText, '\*?(TASK-\d+)\*?') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
$extraReady = @($readyIds | Where-Object { $codexIds -notcontains $_ })
$missingReady = @($codexIds | Where-Object { $readyIds -notcontains $_ })

if (-not (Test-Path $codexReadyPath)) {
    $codexReadyStatus = 'missing'
} elseif ($extraReady.Count -eq 0 -and $missingReady.Count -eq 0) {
    $codexReadyStatus = "fresh ($($readyIds.Count) tasks)"
} else {
    $details = New-Object System.Collections.Generic.List[string]
    if ($extraReady.Count -gt 0) { $details.Add("extra: $($extraReady -join ', ')") }
    if ($missingReady.Count -gt 0) { $details.Add("missing: $($missingReady -join ', ')") }
    $codexReadyStatus = "stale ($($details -join '; '))"
}

$gitStatus = Invoke-Git @('status', '--short', '--branch')
$branchLine = 'unknown'
if ($gitStatus.Count -gt 0 -and $gitStatus[0] -match '^##\s*(?<branch>.+)$') {
    $branchLine = $Matches['branch']
}
$dirtyLines = @($gitStatus | Where-Object { $_ -notmatch '^##\s' })
$modifiedCount = @($dirtyLines | Where-Object { $_ -notmatch '^\?\?' }).Count
$untrackedCount = @($dirtyLines | Where-Object { $_ -match '^\?\?' }).Count
$workspaceState = if ($dirtyLines.Count -eq 0) {
    'clean'
} else {
    "$modifiedCount modified, $untrackedCount untracked"
}
$taskBranches = @(Invoke-Git @('branch', '--list', 'task-*', '--format=%(refname:short)'))
$taskBranchSummary = if ($taskBranches.Count -gt 0) { $taskBranches -join ', ' } else { 'none' }

$planGoal = Collapse-Text (Get-Section $planText 'Goal') 260
$planStatus = Collapse-Text (Get-Section $planText 'Status') 220
if (-not $planGoal) { $planGoal = 'none' }
if (-not $planStatus) { $planStatus = 'none' }

$latestChangelog = Get-FirstHeading $changelogText '(?m)^##\s+(TASK-\d+.+)$'
$latestTest = Get-FirstHeading $testReportText '(?m)^##\s+(TASK-\d+.+)$'
$latestReview = Get-LastHeading $reviewText '(?m)^##\s+(Review\s+TASK-\d+.+)$'

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# OPS State')
$lines.Add('')
$lines.Add('> Generated by `tools/Generate-Ops-State.ps1`. Do not hand-edit.')
$lines.Add('')
$lines.Add("generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
$lines.Add('')
$lines.Add('## Next')
if ($nextTask) {
    $lines.Add("owner: $(Get-OwnerForStatus $nextTask.Status)")
    $lines.Add("task: $($nextTask.Id) [$($nextTask.Status)] - $($nextTask.Title)")
    $lines.Add("source: $($nextTask.Source)")
    $lines.Add("files: $($nextTask.Files)")
} else {
    $lines.Add('owner: Claude')
    $lines.Add('task: none active')
    $lines.Add('source: n/a')
    $lines.Add('files: n/a')
}
$lines.Add('')
$lines.Add('## Tasks')
$lines.Add("counts: $($statusParts -join '; ')")
if ($activeTasks.Count -eq 0) {
    $lines.Add('active: none')
} else {
    $lines.Add('active:')
    foreach ($task in $activeTasks) {
        $depends = if ($task.Depends) { $task.Depends } else { 'none' }
        $lines.Add("- $($task.Id) [$($task.Status)] $($task.Title) (source: $($task.Source); depends: $depends; files: $($task.Files))")
    }
}
$lines.Add('')
$lines.Add('## Plan')
$lines.Add("status: $planStatus")
$lines.Add("goal: $planGoal")
$lines.Add('')
$lines.Add('## Evidence')
$lines.Add("latest_changelog: $latestChangelog")
$lines.Add("latest_test_report: $latestTest")
$lines.Add("latest_review: $latestReview")
$lines.Add('')
$lines.Add('## Git')
$lines.Add("branch: $branchLine")
$lines.Add("workspace: $workspaceState")
$lines.Add("task_branches: $taskBranchSummary")
$lines.Add('')
$lines.Add('## Generated File Health')
$lines.Add("planning/CODEX_READY.md: $codexReadyStatus")
$lines.Add('')
$lines.Add('## Read Guidance')
$lines.Add('- For routing/status: read this file first, then only the specific source file called out by the active state.')
$lines.Add('- For Codex implementation: still read the active TASKS.md block and required architecture/decision anchors.')
$lines.Add('- For Claude review: prefer the current task diff, CHANGELOG/TEST_REPORT entry, and REVIEW.md only when reviewing.')

$text = ($lines -join "`n") + "`n"
[System.IO.File]::WriteAllText($OutFile, $text, (New-Object System.Text.UTF8Encoding($false)))

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output $text
Write-Host "[wrote $OutFile]"
