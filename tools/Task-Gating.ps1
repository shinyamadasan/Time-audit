# Task-Gating.ps1 -- dot-sourced by Dispatch-Commands.ps1 and Run-Codex-Build.ps1 (never run directly).
#
# ONE definition of "may this `status: codex` task start?", shared by the unattended dispatcher
# (/go, /build) and the manual builder, so the two can never drift apart. Execution gating ONLY:
# nothing here edits TASKS.md, approves, merges, or deploys.
#
#   1. DEPENDENCIES  -- a task may start only when every `depends-on:` task's branch (task-<n>) is
#                       already merged into main. This is the definition /go has always used.
#   2. OWNER-DIRECT  -- a task whose `source:` field is `owner-direct` (DECISIONS #35) is
#                       interactive/manual only: unattended runs (/go, /build) never start it.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less script files as ANSI.
# Callers define $tasksFile (script scope) before calling Get-TaskTable.

# Parse every task block once: id, title, status, priority (P1<P2<P3, default P3), depends-on list,
# source, and its blocker note (first line). Pure function over TASKS.md text.
function ConvertFrom-TasksText {
    param([string]$Text)
    $body = ($Text -split '<!-- TASK TEMPLATE')[0]
    $blocks = [regex]::Matches($body, '(?ms)^###\s+(?<id>TASK-\d+)\s*\p{Pd}?\s*[\u00B7\u2022]?\s*(?<title>.+?)\r?\n(?<rest>.*?)(?=^###\s|\z)')
    $out = @()
    foreach ($b in $blocks) {
        $rest = $b.Groups['rest'].Value
        $status = ([regex]::Match($rest, '(?m)^status:\s*(?<s>[\w-]+)')).Groups['s'].Value
        $pm = [regex]::Match($rest, '(?m)^priority:\s*P(?<p>[0-9])')
        $priority = if ($pm.Success) { [int]$pm.Groups['p'].Value } else { 3 }
        $dm = [regex]::Match($rest, '(?m)^depends-on:\s*(?<d>.+)$')
        $deps = @()
        if ($dm.Success -and $dm.Groups['d'].Value.Trim() -notmatch '^(none|n/a|-)$') {
            $deps = @($dm.Groups['d'].Value -split '[,\s]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^TASK-\d+$' })
        }
        # `source:` is a column-0 field line, never free text elsewhere in the block (task prose is
        # indented). A task is owner-direct if ANY such field line starts with the token
        # `owner-direct` (case-insensitive) -- prose that merely mentions it, a BQ-<id> source, a
        # missing source, or a free-text source (TASK-001..003) is NOT owner-direct. Ambiguity
        # (a stray second `source:` line) resolves toward exclusion from unattended runs.
        $source = ''
        $ownerDirect = $false
        foreach ($sm in [regex]::Matches($rest, '(?m)^source:[ \t]*(?<s>[^\r\n]*)')) {
            $val = $sm.Groups['s'].Value.Trim()
            if (-not $source) { $source = $val }
            if ($val -match '(?i)^owner-direct\b') { $ownerDirect = $true }
        }
        $bn = [regex]::Match($rest, '(?ms)^blocker:\s*\r?\n\s*-\s*(?<n>.+?)$')
        $note = if ($bn.Success) { $bn.Groups['n'].Value.Trim() } else { '' }
        $out += [pscustomobject]@{
            Id = $b.Groups['id'].Value; Title = $b.Groups['title'].Value.Trim()
            Status = $status; Priority = $priority; Deps = $deps; Source = $source
            OwnerDirect = $ownerDirect; Note = $note
        }
    }
    $out
}

function Get-TaskTable {
    if (-not (Test-Path $tasksFile)) { return @() }
    ConvertFrom-TasksText -Text (Get-Content $tasksFile -Raw -Encoding UTF8)
}

# The dependency ids of $Task whose task branch is NOT yet merged into main. $MergedBranches is the
# trimmed output of `git branch --merged main`.
function Get-UnresolvedDepIds {
    param($Task, $MergedBranches)
    foreach ($d in $Task.Deps) {
        $depBranch = ($d -replace 'TASK-', 'task-').ToLower()
        if ($depBranch -notin $MergedBranches) { $d }
    }
}

# A dependency is satisfied only if its task branch is already merged into main.
function Test-DepsSatisfied {
    param($Task, $MergedBranches)
    @(Get-UnresolvedDepIds -Task $Task -MergedBranches $MergedBranches).Count -eq 0
}

# Human-readable blockers (id, its TASKS.md status, why) for a refusal message.
function Get-UnresolvedDepDetails {
    param($Task, $MergedBranches, $Table)
    foreach ($d in @(Get-UnresolvedDepIds -Task $Task -MergedBranches $MergedBranches)) {
        $row = @($Table | Where-Object { $_.Id -eq $d })[0]
        $st = if ($row) { "status: $($row.Status)" } else { 'not found in TASKS.md' }
        "$d ($st; branch '$(($d -replace 'TASK-', 'task-').ToLower())' is not merged into main)"
    }
}

# Owner-direct tasks are interactive/manual only (DECISIONS #35). Unattended callers must skip them.
function Test-OwnerDirectTask {
    param($Task)
    [bool]($Task -and $Task.OwnerDirect)
}
