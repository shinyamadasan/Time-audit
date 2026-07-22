# DECISIONS

> ADR-lite. One entry per **non-obvious** choice made or reversed. Reference the task ID.
>
> Not every choice belongs here. A decision earns an entry when a future reader would
> otherwise ask "why on earth is it done this way?" — or worse, "fix" it.

## D-001 — No framework, no build step

**Decision:** TODO (or delete this entry if it does not apply to your stack).

**Why:** TODO.

## D-002 — Per-task scope note: soft-gate builds that touch files their own task never declared (ported from Meal Prep)

**Context:** Prompted by comparing the shared AI Dev OS template against
`github.com/cathrynlavery/codex-build`, a similar Claude-orchestrates/Codex-builds skill, at the
user's request. `Run-Codex-Build.ps1` already has `$deniedPatterns`, a repo-wide deny-list that
blocks Codex/Claude from ever touching `tools/`, `docs/`, `CLAUDE.md`, and the rest of the OS
surface, regardless of which task is running. `codex-build` does something narrower and
complementary: `check_scope.py` mechanically fails a run if a task touches a file outside an
allowlist declared for THAT specific task. This app had no equivalent — a task declaring
`files: app.js` that also edited `style.css` would pass the deny-list untouched (CSS is legitimate
app-code surface), with nothing prompting the reviewer to notice the extra file was never
requested.

**Decision:** Added `Get-TaskBlockText`/`Get-TaskDeclaredFiles` to `Run-Codex-Build.ps1`, parsing a
task's `files:` field into a flat path list, stripping `(new)` annotations. After the existing
deny-list guard passes, the script computes the union of declared files across every tracked task
in the invocation and flags any changed file that's neither declared nor a standard evidence file
(`CHANGELOG.md`/`TEST_REPORT.md`/`TASKS.md`). Deliberately a **soft gate**: a mismatch never blocks
the build or marks anything blocked — it only writes a note to a new gitignored
`.scope-note.txt`, prefixed with the covered task ID(s), when the tracked set reaches
`status: review`. `Run-Claude-Review.ps1` reads that file, uses it only if the task currently under
review is one of the named IDs (always deleting it after reading either way, so a stale note from
an unrelated run can never attach to the wrong task), and folds it into the Claude reviewer's
prompt as an explicit item: state in `REVIEW.md` whether the extra file is a legitimate dependency
or unrequested scope creep. This is a direct port of the Meal Prep app's TASK-034/D-053 — both
apps share the identical template file, confirmed via direct diff before porting (only two
comment-line differences, no logic differences).

**Why:** The soft-gate choice was explicit and deliberate, not a compromise — when asked, the user
specifically flagged that a hard-block version of `codex-build`'s allowlist enforcer would
"occasionally block a legitimate small necessary touch outside the declared scope... and trade
silent scope creep for false-positive blocks that need you to intervene." That's the same class of
problem this app's own TASK-001 already fixed elsewhere on this codebase (a no-op rework retry and
a crashed review both existed because automation was *silently* wrong, not because it was too
permissive) — recreating that shape as a rigid hard gate here, on a purely heuristic signal, would
have been a step backward dressed as a safety improvement.

**Trade-off:** Purely heuristic — a task with an out-of-date or incompletely-declared `files:`
field will generate false-positive notes the reviewer has to dismiss, and a task with no `files:`
field at all skips the check entirely rather than defaulting to "flag everything." The
Codex-as-reviewer fallback path does not receive this signal — only the Claude reviewer's inline
prompt was wired up, consistent with that path's existing degraded-capability status (no Guardian
Gauntlet either). Verified via a fixture harness re-run against this app's own copy of the ported
functions (8/8 assertions pass) plus a direct diff confirming the note round-trip logic is
character-for-character identical to Meal Prep's already-tested version; no live end-to-end run in
either app, disclosed as unverified-live in `TEST_REPORT.md` rather than claimed. Same
same-session build+review caveat as TASK-001/TASK-002: held at `approved`, not auto-merged, for a
human `/merge`.

**Supersedes:** nothing directly; extends the existing deny-list scope guard with a narrower,
task-specific, advisory-only companion check.
