<#
.SYNOPSIS
  /build phase runner: builds the first `status: codex` task(s) in TASKS.md on a dedicated branch by
  invoking Codex CLI unattended.

.DESCRIPTION
  The build step never touches main. It creates/checks out task-<id> from a clean main (named after
  the first status: codex task found), then invokes:
      codex exec -C <repo root> --sandbox workspace-write "Continue"
  This is a verified, real headless invocation -- confirmed to read AGENTS.md/TASKS.md, follow the AI
  Dev OS, and refuse to act when no status: codex task exists. There is no more "prepare branch and
  ask a human to open Codex" fallback (see docs/DECISIONS.md D-025, superseding D-024's fallback design).

  Before invoking, this script snapshots every TASK-<id> currently status: codex (the "tracked set" --
  plural, because Sprint Execution Mode/D-023 chaining means one invocation can legitimately advance
  more than one task on the same branch; the chaining logic itself lives in AGENTS.md, which Codex
  reads on its own -- this wrapper just checks the outcome across the whole tracked set afterward,
  never assumes exactly one task changed.

  A commit-scope guard (mirroring AGENTS.md's documented Codex ownership, unchanged from before) checks
  every changed file before anything is committed: app code, tests, CHANGELOG.md, TEST_REPORT.md, and
  TASKS.md are allowed; CLAUDE.md/AGENTS.md/docs//planning//captures//tools/ and this repo's own
  automation scripts are not. Any violation halts with no commit/push, same fail-fast contract as
  run-claude.ps1 -- this applies regardless of whether Codex's own exit code was 0 or not.

  If the tracked set reaches status: review, this script automatically invokes
  tools/Run-Claude-Review.ps1 (goal: no separate manual /review step needed after a clean build) and
  folds both results into one reply. If Claude approves, the review runner can fast-forward main
  after its own tests and guards pass.

  Writes its final human-readable result to .last-phase-result.txt (gitignored) for
  Dispatch-Commands.ps1 to relay -- this script does not talk to Telegram itself.

.EXAMPLE
  ./tools/Run-Codex-Build.ps1
  ./tools/Run-Codex-Build.ps1 -DryRun
#>
param([switch]$DryRun)

# WHICH IMPLEMENTER BUILDS THE CODE. Set by the installer from the app's config ("builder" key).
#
#   codex   -- `codex exec`. The default, and the stronger option: the model that WRITES the code is
#              not the model that REVIEWS it, so their blind spots do not line up.
#   claude  -- headless `claude -p`. For anyone who has Claude Code but not Codex. Builder and
#              reviewer are then the same model and DO share blind spots -- a real cost, honestly
#              stated. What survives is what matters most: separate processes, separate prompts, zero
#              shared context, and the builder gets NO GIT TOOLS, so it cannot commit, push, merge,
#              or mark its own work approved.
#
# Everything else in this file is engine-agnostic. Only the process we start changes.
$BUILDER = 'codex'
if ($BUILDER -notin @('codex', 'claude')) { $BUILDER = 'codex' }

$ErrorActionPreference = 'Stop'
$root       = Split-Path $PSScriptRoot -Parent
$logFile    = Join-Path $root 'claude-session.log'
$resultFile = Join-Path $root '.last-phase-result.txt'
$tasksFile  = Join-Path $root 'TASKS.md'
$utf8       = New-Object System.Text.UTF8Encoding($false)

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

# DENY-list (not allow-list): Codex's legitimate surface (app code) is open-ended, so this blocks the
# specific planning/architecture/automation surfaces it must never touch, and allows everything else.
$deniedPatterns = @(
    '^CLAUDE\.md$', '^AGENTS\.md$', '^PLAN\.md$', '^REVIEW\.md$', '^WORKFLOW\.md$',
    '^SELF_REVIEW\.md$', '^QA\.md$', '^PROMPTS\.md$', '^OPERATOR\.md$', '^GUIDE\.md$',
    '^AI-DEV-OS\.md$', '^SYSTEM-OVERVIEW\.md$', '^STATUS\.md$',
    '^docs/', '^planning/', '^captures/', '^library/', '^config/', '^\.claude/',
    '^tools/', '^run-claude\.ps1$', '^setup-.*\.ps1$', '^n8n-.*\.json$'
)

function Write-Result {
    param([string]$Text)
    if (-not $DryRun) { [System.IO.File]::WriteAllText($resultFile, $Text, $utf8) }
    Add-Content -Path $logFile -Value "[Run-Codex-Build] $Text"
    Write-Host $Text
}

function Set-TaskStatus {
    param([string]$TaskId, [string]$NewStatus, [string]$BlockerNote)
    $text = Get-Content $tasksFile -Raw -Encoding UTF8
    $pattern = "(?ms)(^###\s+$TaskId\b.*?^status:)[^\r\n]*"
    $newText = [regex]::Replace($text, $pattern, "`${1} $NewStatus")
    if ($BlockerNote) {
        $newText = [regex]::Replace($newText, "(?ms)(^###\s+$TaskId\b.*?^status:\s*$NewStatus\s*\r?\n)", "`${1}blocker:`n  - $(Get-Date -Format 'yyyy-MM-dd'): $BlockerNote`n")
    }
    if (-not $DryRun) { [System.IO.File]::WriteAllText($tasksFile, $newText, $utf8) }
}

function Get-TaskStatusById {
    param([string]$TaskId)
    $text = Get-Content $tasksFile -Raw -Encoding UTF8
    $m = [regex]::Match($text, "(?ms)^###\s+$TaskId\b.*?^status:\s*(?<s>[\w-]+)")
    if ($m.Success) { $m.Groups['s'].Value } else { $null }
}

function Get-TrackedTasks {
    $text = Get-Content $tasksFile -Raw -Encoding UTF8
    $body = ($text -split '<!-- TASK TEMPLATE')[0]
    $blocks = [regex]::Matches($body, '(?ms)^###\s+(?<id>TASK-\d+)\s*\p{Pd}?\s*[·•]?\s*(?<title>.+?)\r?\n(?<rest>.*?)(?=^###\s|\z)')
    $tracked = @()
    foreach ($b in $blocks) {
        $m = [regex]::Match($b.Groups['rest'].Value, '(?m)^status:\s*(?<s>[\w-]+)')
        if ($m.Success -and $m.Groups['s'].Value -eq 'codex') {
            $tracked += [pscustomobject]@{ Id = $b.Groups['id'].Value; Title = $b.Groups['title'].Value.Trim() }
        }
    }
    $tracked
}

# --- Preflight: main must be clean before branching off it; codex must actually be invokable ---
$branch = Invoke-Git -C $root branch --show-current
if ($branch -ne 'main') {
    Write-Result "ABORTED: expected to start from 'main', found '$branch'. Run 'git checkout main' and retry."
    exit 2
}
$dirty = @(Invoke-Git -C $root status --porcelain)
if ($dirty.Count -gt 0) {
    Write-Result "ABORTED: main has $($dirty.Count) uncommitted change(s). Commit/stash/clean before building."
    exit 2
}
if (-not (Get-Command $BUILDER -ErrorAction SilentlyContinue)) {
    Write-Result "ABORTED: the '$BUILDER' CLI is not on PATH for this session (builder = '$BUILDER'). Install/authenticate it, or check the account running this scheduled task has it on PATH."
    exit 2
}

# --- Find the tracked set: every status: codex task right now (same FIFO rule Codex's own "Continue"
#     uses to pick where to start; a chained group may advance more than one during one invocation) ---
$tracked = @(Get-TrackedTasks)
if ($tracked.Count -eq 0) {
    Write-Result "Nothing to build -- no TASKS.md entry has status: codex right now."
    exit 0
}
$first = $tracked[0]
$branchName = ($first.Id -replace 'TASK-', 'task-').ToLower()

if ($DryRun) {
    Write-Result "[DRY RUN] would checkout/create $branchName from main and run 'codex exec -C $root --sandbox workspace-write `"Continue`"' to advance $($tracked.Count) tracked task(s) starting at $($first.Id) ($($first.Title))."
    exit 0
}

# --- Branch: create if new, checkout if it already exists (a retried /build after a prior attempt,
#     or a chained group already partway through on this branch). "Doesn't exist yet" is the normal
#     first-build case. ---
Invoke-Git -C $root rev-parse --verify $branchName | Out-Null
$branchExists = ($LASTEXITCODE -eq 0)

if ($branchExists) {
    Invoke-Git -C $root checkout $branchName | Out-Null
} else {
    Invoke-Git -C $root checkout -b $branchName | Out-Null
}

# --- Invoke Codex CLI, unattended. Captures stdout/stderr/exit code/duration for the log. ---
# Driven via System.Diagnostics.Process directly rather than the Start-Process cmdlet: confirmed
# live that Start-Process -PassThru (without -Wait) never reliably populates .ExitCode even after
# the process exits and Refresh() is called, which this wrapper's whole classification logic
# depends on. The two other live-confirmed fixes carry over: closing StandardInput immediately
# gives codex an instant EOF (without it, codex exec hung indefinitely reading "additional input
# from stdin" -- 7+ hours, 0.1s of CPU used, holding automation.lock the whole time and silently
# refusing every real Telegram command); the WaitForExit timeout is a second, independent safety
# net against any other cause of a hang.
$CODEX_TIMEOUT_MINUTES = 20   # tune per how long a real build/chained group legitimately takes
$startTime = Get-Date

# ---------------------------------------------------------------------------------------------
# THE IMPLEMENTER IS PLUGGABLE. Everything above and below this block -- branch isolation, the
# clean-main preflight, the tracked-task snapshot, the commit-scope guard, the timeout kill, the
# blocked-task classification -- is engine-agnostic and stays exactly as it is. Only the process we
# start changes.
#
#   builder = codex   -> `codex exec`, the default. Two vendors means uncorrelated blind spots:
#                        the model that writes the code is not the model that reviews it.
#   builder = claude  -> headless `claude -p`, for anyone who has Claude Code but not Codex.
#
# The claude path is a REAL trade, and it is worth naming: the builder and the reviewer are then the
# same model, so they share blind spots -- if the builder misreads a task, the reviewer is likelier
# to misread it the same way. What survives is the part that matters most: they are separate
# processes with separate prompts, zero shared context, and DIFFERENT TOOL GRANTS. The builder gets
# no git at all -- it cannot commit, cannot push, cannot merge, and cannot mark its own work
# approved. The runner commits; the reviewer (which has no Edit/Write on app code) judges the diff
# it has never seen the reasoning behind. That is a far stronger gate than one session doing both.
# ---------------------------------------------------------------------------------------------
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true

$builderPrompt = $null

if ($BUILDER -eq 'claude') {
    # Prefer the logged-in Claude subscription over API-key billing, same as the other runners.
    Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

    # NO GIT TOOLS. The runner commits; the builder must not. Without this the builder could commit
    # straight to the branch, bypass the commit-scope guard, and (worse) set its own task to a status
    # the reviewer never granted.
    #
    # LAUNCH VIA cmd.exe. `codex` is a real .exe, but `claude` is an npm shim (claude.ps1 / claude.cmd)
    # -- and System.Diagnostics.Process with UseShellExecute=false CANNOT start a script by bare name.
    # It throws Win32Exception, which is exactly what a Claude-only user would hit on their very first
    # /go. cmd.exe /c resolves the shim the same way a human typing `claude` in a terminal does.
    # (Run-Claude-Review.ps1 already uses this pattern for `npm test`, for the same reason.)
    $claudeArgs = '-p --allowedTools "Read" "Glob" "Grep" "Edit" "Write" "Bash(npm test)" "Bash(npm run *)" "Bash(node *)"'
    $psi.FileName  = 'cmd.exe'
    $psi.Arguments = "/c claude $claudeArgs"

    # Codex reads AGENTS.md and knows this OS. Claude has to be told to -- so point it at the exact
    # same contract rather than inventing a second, drifting definition of the Implementer role.
    $builderPrompt = @"
You are running in autonomous mode as the IMPLEMENTER. No human is available.

Follow AGENTS.md exactly -- it is the Implementer's manual and it is the contract you are held to.

Implement the first task in TASKS.md with 'status: codex' ($($first.Id): $($first.Title)). ONLY that
task. Read its acceptance criteria and the files it names. Read docs/ARCHITECTURE.md and
docs/DECISIONS.md before you touch anything, and obey CLAUDE.md's Hard Rules without exception --
they exist because each one has already caused a production bug.

Then:
  1. Run 'npm test'. If it fails, fix your own change until it passes. Do not weaken a test to make
     it pass -- that converts a real failure into a silent one, which is worse than shipping nothing.
  2. Append implementation evidence to CHANGELOG.md and test evidence to TEST_REPORT.md.
  3. Set that task's 'status:' to 'review' in TASKS.md.

If the task is ambiguous, or you would have to guess at a requirement, or a Hard Rule blocks the only
approach you can see: set 'status: blocked', write the blocker under the task, and STOP. A blocked
task with an honest reason is a good outcome. A guessed one is not -- you would be inventing a
requirement the human never asked for, and the reviewer has no way to know you did.

You CANNOT commit, push, or merge -- you have no git tools, by design. The runner commits what you
changed and a separate reviewer judges it. Do not attempt to approve your own work.

Touch only the files this task requires. Every changed line must trace to an acceptance criterion.
"@
}
else {
    # Start-Process -ArgumentList, given an array, does not reliably quote elements containing spaces
    # (confirmed live: $root's "ChronaSense" path split into separate positional args, and codex
    # rejected 'prep' as an unexpected argument). A single pre-quoted command-line string avoids this.
    $psi.FileName  = 'codex'
    $psi.Arguments = "exec -C `"$root`" --sandbox workspace-write `"Continue`""
}

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$proc.Start() | Out-Null

# Pipe the prompt via stdin rather than as an argument: under Windows PowerShell 5.1 a long
# multi-line prompt passed as a native-command argument loses its tail (confirmed live in the
# planner, where Claude received only the head of the prompt). Closing stdin immediately afterwards
# is also what gives the child an instant EOF -- without it, `codex exec` once hung for 7+ hours
# holding automation.lock and silently refusing every Telegram command.
if ($builderPrompt) { $proc.StandardInput.Write($builderPrompt) }
$proc.StandardInput.Close()
$stdoutTask = $proc.StandardOutput.ReadToEndAsync()
$stderrTask = $proc.StandardError.ReadToEndAsync()
$exited = $proc.WaitForExit($CODEX_TIMEOUT_MINUTES * 60 * 1000)
if (-not $exited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Add-Content -Path $logFile -Value "[Run-Codex-Build] codex exec for $($first.Id) TIMED OUT after $CODEX_TIMEOUT_MINUTES minute(s) -- killed."
    $proc.WaitForExit()
}
$duration = (Get-Date) - $startTime
$codexExit = $proc.ExitCode
$stdout = $stdoutTask.Result
$stderr = $stderrTask.Result

Add-Content -Path $logFile -Value "[Run-Codex-Build] codex exec for $($first.Id) -- exit $codexExit, duration $([int]$duration.TotalSeconds)s"
Add-Content -Path $logFile -Value "[Run-Codex-Build] --- stdout ---`n$stdout"
if ($stderr) { Add-Content -Path $logFile -Value "[Run-Codex-Build] --- stderr ---`n$stderr" }

# --- Commit-scope guard: applies regardless of Codex's exit code -- whatever Codex touched, if it's
#     outside the allowed surface, this halts uncommitted for human inspection, same as always. ---
$changed = @(Invoke-Git -C $root status --porcelain | ForEach-Object { $_.Substring(3).Trim() } | Where-Object { $_ })
$violations = @($changed | Where-Object { $path = $_; ($deniedPatterns | Where-Object { $path -match $_ }) })

if ($violations.Count -gt 0) {
    # Deliberately do NOT checkout main here -- the whole point is leaving the dirty tree exactly as
    # Codex left it, on $branchName, for a human to inspect. Switching branches now could either be
    # refused by git (dirty tree) or silently carry the stray edits onto main. Both are worse than
    # just staying put.
    Write-Result "$($first.Id) build HALTED: touched file(s) outside Codex's allowed surface: $($violations -join ', '). NOT committed/pushed -- inspect $branchName by hand."
    exit 1
}

# --- Failure: Codex CLI itself exited non-zero. Commit whatever safe partial progress exists, mark
#     every tracked task blocked so the next /build doesn't silently retry the same broken task. ---
if ($codexExit -ne 0) {
    if ($changed.Count -gt 0) { Invoke-Git -C $root add -- $changed; Invoke-Git -C $root commit -m "$($first.Id): partial progress before codex exec failure" | Out-Null }
    foreach ($t in $tracked) {
        if ((Get-TaskStatusById $t.Id) -eq 'codex') {
            Set-TaskStatus -TaskId $t.Id -NewStatus 'blocked' -BlockerNote "codex exec exited $codexExit after $([int]$duration.TotalSeconds)s. See claude-session.log for stdout/stderr."
        }
    }
    Invoke-Git -C $root add TASKS.md
    Invoke-Git -C $root diff --cached --quiet
    if ($LASTEXITCODE -ne 0) { Invoke-Git -C $root commit -m "$($first.Id): codex exec failed (exit $codexExit), marked blocked" | Out-Null }
    Invoke-Git -C $root push origin $branchName | Out-Null
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "$($first.Id) build FAILED: codex exec exited $codexExit after $([int]$duration.TotalSeconds)s. Marked blocked on $branchName. See claude-session.log."
    exit 1
}

# --- codex exec exited 0. Commit whatever it changed, then classify by re-checking the tracked set. ---
if ($changed.Count -gt 0) {
    Invoke-Git -C $root add -- $changed
    Invoke-Git -C $root commit -m "$($first.Id): codex exec build" | Out-Null
}
Invoke-Git -C $root push origin $branchName | Out-Null

$statuses = $tracked | ForEach-Object { [pscustomobject]@{ Id = $_.Id; Status = (Get-TaskStatusById $_.Id) } }
$anyBlocked = @($statuses | Where-Object { $_.Status -eq 'blocked' })
$anyReview  = @($statuses | Where-Object { $_.Status -eq 'review' })
$noChange   = @($statuses | Where-Object { $_.Status -eq 'codex' })

if ($anyBlocked.Count -gt 0) {
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "$($first.Id) build reached BLOCKED ($($anyBlocked.Count) of $($tracked.Count) tracked task(s)) after $([int]$duration.TotalSeconds)s. See the blocker note(s) in TASKS.md on $branchName."
    exit 1
}

if ($anyReview.Count -gt 0) {
    $buildMsg = "$($first.Id) build reached REVIEW ($($anyReview.Count) of $($tracked.Count) tracked task(s)) after $([int]$duration.TotalSeconds)s, pushed to $branchName."
    Add-Content -Path $logFile -Value "[Run-Codex-Build] $buildMsg"
    # Auto-chain: goal 6 -- no separate manual /review step needed after a clean build. Stay on
    # $branchName for this call (Run-Claude-Review.ps1 checks it out itself, harmless no-op since
    # we're already there) -- it returns the repo to main itself when it finishes.
    Add-Content -Path $logFile -Value "[Run-Codex-Build] auto-chaining into Run-Claude-Review.ps1 for $branchName."
    & (Join-Path $root 'tools\Run-Claude-Review.ps1')
    $reviewResultFile = Join-Path $root '.last-phase-result.txt'
    $reviewMsg = if (Test-Path $reviewResultFile) { $r = Get-Content $reviewResultFile -Raw; Remove-Item $reviewResultFile -Force; $r } else { "Review phase runner exited $LASTEXITCODE with no result -- check claude-session.log." }
    # Defensive: ensure main regardless of what the review runner left behind (idempotent if it
    # already returned there itself).
    $curBranch = Invoke-Git -C $root branch --show-current
    if ($curBranch -ne 'main') { Invoke-Git -C $root checkout main | Out-Null }
    Write-Result "$buildMsg`n`n-> auto-review: $reviewMsg"
    exit 0
}

# codex exec exited 0 but none of the tracked tasks moved off status: codex -- fail loud rather than
# silently reporting success for a run that made no verifiable progress.
foreach ($t in $noChange) {
    Set-TaskStatus -TaskId $t.Id -NewStatus 'blocked' -BlockerNote "codex exec exited 0 after $([int]$duration.TotalSeconds)s but made no tracked progress on this task. See claude-session.log."
}
Invoke-Git -C $root add TASKS.md
Invoke-Git -C $root diff --cached --quiet
if ($LASTEXITCODE -ne 0) { Invoke-Git -C $root commit -m "$($first.Id): codex exec made no tracked progress, marked blocked" | Out-Null; Invoke-Git -C $root push origin $branchName | Out-Null }
Invoke-Git -C $root checkout main | Out-Null
Write-Result "$($first.Id) build FAILED: codex exec exited 0 after $([int]$duration.TotalSeconds)s but no tracked task changed status. Marked blocked on $branchName. See claude-session.log."
exit 1
