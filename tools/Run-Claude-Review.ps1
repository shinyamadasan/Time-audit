<#
.SYNOPSIS
  /review phase runner: runs Claude's review against the first `status: review` task's branch.

.DESCRIPTION
  Checks out task-<id>, invokes Claude non-interactively to do exactly what the interactive "Review"
  command already documents in CLAUDE.md (read the branch diff, CHANGELOG.md, TEST_REPORT.md,
  acceptance criteria; write REVIEW.md; set TASKS.md status to done or back to codex/rework) --
  never touching app code. A commit-scope guard (same fail-fast mechanism as run-claude.ps1's)
  allows only REVIEW.md and TASKS.md; anything else halts with no commit/push. If Claude approves,
  this runner verifies the reviewed branch with npm test, fast-forwards main, and pushes main.

  Writes its final human-readable result to .last-phase-result.txt (gitignored) for
  Dispatch-Commands.ps1 to relay.

.EXAMPLE
  ./tools/Run-Claude-Review.ps1
  ./tools/Run-Claude-Review.ps1 -DryRun
  ./tools/Run-Claude-Review.ps1 -NoAutoMerge
#>
param([switch]$DryRun, [switch]$NoAutoMerge, [switch]$NoPush)

$ErrorActionPreference = 'Stop'
$root       = Split-Path $PSScriptRoot -Parent
$logFile    = Join-Path $root 'claude-session.log'
$resultFile = Join-Path $root '.last-phase-result.txt'
$tasksFile  = Join-Path $root 'TASKS.md'
$utf8       = New-Object System.Text.UTF8Encoding($false)
$AUTO_MERGE_AFTER_REVIEW = -not $NoAutoMerge
$AUTO_PUSH_AFTER_MERGE   = -not $NoPush
$AUTO_MERGE_TEST_TIMEOUT_MINUTES = 10

# Under $ErrorActionPreference = 'Stop', ANY stderr text from a native command -- even a benign
# warning like git's LF-will-be-replaced-by-CRLF notice, on a call that otherwise succeeds -- gets
# promoted to a terminating exception, regardless of whether stderr is redirected to $null. This
# showed up twice in live testing on different git calls (rev-parse --verify, then add), so every
# git invocation is routed through here rather than patched one call site at a time: EAP is lowered
# to 'Continue' only for the duration of the native call, which stops the promotion, while
# $LASTEXITCODE still reflects git's real exit code exactly as before.
function Invoke-Git {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & git @args 2>$null }
    finally { $ErrorActionPreference = $prevEAP }
}

function Write-Result {
    param([string]$Text)
    if (-not $DryRun) { [System.IO.File]::WriteAllText($resultFile, $Text, $utf8) }
    Add-Content -Path $logFile -Value "[Run-Claude-Review] $Text"
    Write-Host $Text
}

function Get-TaskStatus {
    param([string]$TaskId)
    $text = Get-Content $tasksFile -Raw -Encoding UTF8
    $m = [regex]::Match($text, "(?ms)^###\s+$TaskId\b.*?^status:\s*(?<s>[\w-]+)")
    if ($m.Success) { $m.Groups['s'].Value } else { $null }
}

function Invoke-NpmTest {
    Add-Content -Path $logFile -Value "[Run-Claude-Review] running npm test before auto-merge (timeout: $AUTO_MERGE_TEST_TIMEOUT_MINUTES minute(s))."

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/c npm test'
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $proc.Start() | Out-Null
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    $exited = $proc.WaitForExit($AUTO_MERGE_TEST_TIMEOUT_MINUTES * 60 * 1000)
    if (-not $exited) {
        & taskkill /PID $proc.Id /T /F 2>$null | Out-Null
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        $proc.WaitForExit()
        Add-Content -Path $logFile -Value "[Run-Claude-Review] npm test TIMED OUT after $AUTO_MERGE_TEST_TIMEOUT_MINUTES minute(s)."
        return 124
    }

    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    if ($stdout) { Add-Content -Path $logFile -Value "[Run-Claude-Review] --- npm test stdout ---`n$stdout" }
    if ($stderr) { Add-Content -Path $logFile -Value "[Run-Claude-Review] --- npm test stderr ---`n$stderr" }
    $proc.ExitCode
}

function Invoke-AutoMerge {
    param([string]$TaskId, [string]$BranchName)

    if (-not $AUTO_MERGE_AFTER_REVIEW) {
        Invoke-Git -C $root checkout main | Out-Null
        return "$TaskId APPROVED. Auto-merge disabled; merge $BranchName into main when you're ready."
    }

    $branchDirty = @(Invoke-Git -C $root status --porcelain)
    if ($branchDirty.Count -gt 0) {
        return "Review passed, but auto-merge BLOCKED: $BranchName has $($branchDirty.Count) uncommitted change(s) after review. Main was not changed."
    }

    $testExit = Invoke-NpmTest
    if ($testExit -ne 0) {
        Invoke-Git -C $root checkout main | Out-Null
        return "Review passed, but auto-merge BLOCKED: npm test failed on $BranchName (exit $testExit). Main was not changed."
    }

    $postTestDirty = @(Invoke-Git -C $root status --porcelain)
    if ($postTestDirty.Count -gt 0) {
        return "Review passed, but auto-merge BLOCKED: npm test changed $($postTestDirty.Count) tracked/visible file(s) on $BranchName. Main was not changed."
    }

    Invoke-Git -C $root merge-base --is-ancestor main $BranchName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Invoke-Git -C $root checkout main | Out-Null
        return "Review passed, but auto-merge BLOCKED: main is not an ancestor of $BranchName. Rebase or merge by hand."
    }

    Invoke-Git -C $root checkout main | Out-Null
    $mainDirty = @(Invoke-Git -C $root status --porcelain)
    if ($mainDirty.Count -gt 0) {
        return "Review passed, but auto-merge BLOCKED: main has $($mainDirty.Count) uncommitted change(s)."
    }

    Invoke-Git -C $root merge --ff-only $BranchName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        return "Review passed, but auto-merge BLOCKED: git merge --ff-only $BranchName failed."
    }

    if ($AUTO_PUSH_AFTER_MERGE) {
        Invoke-Git -C $root push origin main | Out-Null
        if ($LASTEXITCODE -ne 0) {
            return "$TaskId APPROVED and auto-merged $BranchName into local main, but push to origin/main FAILED. Inspect main and push manually."
        }
        return "$TaskId APPROVED and auto-merged $BranchName into main, then pushed origin/main."
    }

    "$TaskId APPROVED and auto-merged $BranchName into local main. Push origin/main when you're ready."
}

# --- Find the first status: review task ---
$text = Get-Content $tasksFile -Raw -Encoding UTF8
$body = ($text -split '<!-- TASK TEMPLATE')[0]
$blocks = [regex]::Matches($body, '(?ms)^###\s+(?<id>TASK-\d+)\s*\p{Pd}?\s*[·•]?\s*(?<title>.+?)\r?\n(?<rest>.*?)(?=^###\s|\z)')
$target = $null
foreach ($b in $blocks) {
    $m = [regex]::Match($b.Groups['rest'].Value, '(?m)^status:\s*(?<s>[\w-]+)')
    if ($m.Success -and $m.Groups['s'].Value -eq 'review') { $target = $b; break }
}
if (-not $target) {
    Write-Result "Nothing to review -- no TASKS.md entry has status: review right now."
    exit 0
}
$taskId = $target.Groups['id'].Value
$title  = $target.Groups['title'].Value.Trim()
$branchName = ($taskId -replace 'TASK-', 'task-').ToLower()

if ($DryRun) {
    $mergeMode = if ($AUTO_MERGE_AFTER_REVIEW) { 'enabled' } else { 'disabled' }
    $pushMode = if ($AUTO_PUSH_AFTER_MERGE) { 'enabled' } else { 'disabled' }
    Write-Result "[DRY RUN] would checkout $branchName and review $taskId ($title). Auto-merge after approval: $mergeMode. Push after merge: $pushMode."
    exit 0
}

# --- Preflight: the task branch must exist and be clean before Claude reviews it. ---
Invoke-Git -C $root rev-parse --verify $branchName | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Result "ABORTED: branch '$branchName' for $taskId does not exist. Nothing to review."
    exit 2
}
Invoke-Git -C $root checkout $branchName | Out-Null
$dirty = @(Invoke-Git -C $root status --porcelain)
if ($dirty.Count -gt 0) {
    Write-Result "ABORTED: $branchName has $($dirty.Count) uncommitted change(s). Commit/stash/clean before reviewing."
    exit 2
}

$prompt = @"
You are running in autonomous mode. No human is available. Follow CLAUDE.md's Reviewer role exactly
as the interactive "Review" command already documents.

Review task $taskId ($title) on the current branch ($branchName). Read the branch diff against main,
CHANGELOG.md, TEST_REPORT.md, and $taskId's acceptance criteria in TASKS.md.

You may ONLY write to REVIEW.md and TASKS.md (only $taskId's status field) -- do not touch app.js,
index.html, style.css, tests, or any other file. Do not attempt git commit or git push (not
available to you this run).

Write a REVIEW.md entry: verdict (APPROVED or REWORK), must-fix items if any, nits if any. Then set
$taskId's status in TASKS.md. Never rubber-stamp.

RISK-GATED MERGE (see DECISIONS D-032). Choose the status by what the task TOUCHES:
  - codex    = REWORK needed (must-fix items exist).
  - approved = APPROVED, but the task touches a RED-ZONE surface: Firestore / sync / storage, the
               tombstone-merge-deletion machinery, saveData() or the cloudReady write-guard, auth,
               security, or the AI Dev OS / automation itself. This HOLDS the branch: main is NOT
               merged, and the human merges after a glance. Lost data cannot be reverted, so these
               never auto-ship.
  - done     = APPROVED and the change is reversible (UI, CSS, copy, additive non-data features).
               This AUTO-MERGES into main and deploys.
If you are torn between done and approved, choose approved.
State which gate you picked, and why, at the end of the REVIEW.md entry.
"@

# Pipe the PROMPT itself via stdin (not `claude -p $prompt`): under Windows PowerShell 5.1 a long
# multi-line prompt passed as a native-command argument loses its tail -- confirmed live in the
# planner, where Claude only received the head of the prompt. Piping via stdin delivers it intact
# AND gives claude an immediate EOF (no ~3s stall). Lowering EAP to 'Continue' for the call prevents
# claude's benign stderr from being promoted to a terminating exception under EAP = 'Stop'.
# Match run-claude.ps1: prefer the logged-in Claude subscription over API-key billing for reviews.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $prompt | claude -p `
        --allowedTools "Read" "Glob" "Grep" "Edit" "Write" "Bash(git status)" "Bash(git diff *)" "Bash(git log *)" `
        2>$null | Tee-Object -FilePath $logFile -Append
} finally {
    $ErrorActionPreference = $prevEAP
}
if ($LASTEXITCODE -ne 0) {
    # Deliberately do NOT checkout main -- Claude's session may have left partial, uncommitted edits;
    # leave $branchName exactly as it is for inspection rather than risk carrying stray changes onto main.
    Write-Result "$taskId review FAILED: claude -p exited with code $LASTEXITCODE. See claude-session.log."
    exit 1
}

# --- Commit-scope guard: ONLY REVIEW.md and TASKS.md allowed ---
$allowedPatterns = @('^REVIEW\.md$', '^TASKS\.md$')
$changed = @(Invoke-Git -C $root status --porcelain | ForEach-Object { $_.Substring(3).Trim() } | Where-Object { $_ })
$violations = @($changed | Where-Object { $path = $_; -not ($allowedPatterns | Where-Object { $path -match $_ }) })

if ($violations.Count -gt 0) {
    # Same reasoning as above -- leave the dirty tree on $branchName for a human, never auto-switch.
    Write-Result "$taskId review HALTED: touched file(s) outside the review surface: $($violations -join ', '). NOT committed/pushed -- inspect $branchName by hand."
    exit 1
}
if ($changed.Count -eq 0) {
    # Nothing changed at all -- tree is clean, safe to return to main.
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "$taskId review produced no changes -- investigate; a real review should at least update REVIEW.md."
    exit 1
}

Invoke-Git -C $root add -- $changed
Invoke-Git -C $root commit -m "${taskId}: Claude review" | Out-Null
Invoke-Git -C $root push origin $branchName | Out-Null
# Read the final status BEFORE switching back to main -- checking out main first would make this
# read main's untouched TASKS.md (task-006 was never merged there), always reporting the task's
# pre-review status regardless of what Claude actually decided. Confirmed live: a real APPROVED
# review with status correctly set to `done` on $branchName was misreported as "needs REWORK"
# because $tasksFile was read after the branch switch.
$newStatus = Get-TaskStatus -TaskId $taskId
if ($newStatus -eq 'done') {
    Write-Result (Invoke-AutoMerge -TaskId $taskId -BranchName $branchName)
} elseif ($newStatus -eq 'codex') {
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "$taskId needs REWORK -- see REVIEW.md on $branchName for must-fix items."
} elseif ($newStatus -eq 'approved') {
    # Risk gate (D-032): approved-but-red-zone. Reviewed OK, but it touches data/sync/auth/OS, so it
    # is deliberately NOT auto-merged -- a human eyeballs and merges. main is untouched.
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "$taskId APPROVED but HELD for your merge -- red-zone surface (data/sync/auth/OS). main NOT changed. Review the diff on $branchName, then: git checkout main; git merge --ff-only $branchName; git push origin main"
} else {
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "$taskId reviewed (status now '$newStatus') -- pushed to $branchName. Check REVIEW.md for detail."
}
exit 0
