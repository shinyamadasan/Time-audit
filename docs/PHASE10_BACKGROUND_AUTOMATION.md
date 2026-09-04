# Phase 10 — Life Ledger Background Automation

Status: **built, not activated.** Every mechanism described here exists and is tested. The real
Windows scheduled task is **not registered** and the real OneDrive vault has **never** received a
Phase 10 write. Real activation is a deliberate, separate step that happens after independent
review (see "Activation" at the end of this document).

## What changed vs. Phase 9

Phase 9 proved the vault could be synced safely — but only manually:

```
ChronaSense (browser) → click "Export Life Ledger" → downloaded JSON
  → by hand: node scripts/sync-life-ledger-to-obsidian.mjs --apply ... → Obsidian
```

Phase 10 removes the two manual steps in the middle. The safety machinery underneath (ownership
sentinel + manifest, fail-closed conflict detection, rollback receipts, production authorization)
is **Phase 9's, unchanged.** Phase 10 only adds transport and scheduling around it.

```
ChronaSense (browser) → Life Ledger localStorage write (unchanged)
  → best-effort mirror to a local outbox file (life-ledger-sync-bridge.js)
  → Windows Task Scheduler fires scripts/life-ledger-sync-worker.mjs on an interval
  → life-ledger-sync-cycle.js runs the same plan/backup/verify/apply pipeline Phase 9 built
  → a status file is written back into the same outbox folder
  → the Settings UI reads it and shows truthful sync status
```

## Transport authority (who owns the facts)

**`localStorage` (`ta3-life-ledger-v1`) remains the sole source of truth for the live app.**
The outbox file the browser writes is a *mirror*, not a second store — it is always the exact,
deterministic, full-snapshot output of the same `exportLifeLedgerSnapshotJson()` the manual
"Export Life Ledger" button already used. No new envelope shape, no lossy projection, no separate
identity scheme. If the outbox mirror write fails (permission lapsed, disk full, unsupported
browser), the Life Ledger event is **not lost** — it is still safely in `localStorage`, exactly as
durable as it always was; the only thing that's delayed is background transport.

Firebase Realtime Database was considered and explicitly **rejected** as the transport. It already
exists in this codebase, but only for real-time room/timer/accountability-partner state — it
carries zero Life Ledger data today, and using it would mean designing a new identity model (which
Firebase `uid`?), a new conflict model, and new offline semantics from scratch, on top of a system
that isn't itself a source of truth. The File System Access API mirror needs none of that: it's
local, requires no network, and reuses the existing deterministic snapshot format outright.

## Durable local bridge (`life-ledger-sync-bridge.js`)

One-time opt-in ("Enable Background Sync" in Settings → Data) grants a persisted, read/write
handle to a local folder via `showDirectoryPicker()`. The handle is stored in IndexedDB and
survives browser restarts (Chromium remembers File System Access grants per origin until revoked).
After that, every successful Life Ledger write (`learning-plan-ui.js`'s five ledger-record call
sites) triggers a best-effort, non-blocking mirror of the current full snapshot into
`<outbox>/chronasense-life-ledger-outbox-v1.json`. Writes never throw into the caller and never
silently request permission — a lapsed grant is reported truthfully as "paused," with a
user-gesture-triggered "Resume" action, never a surprise native prompt.

**Extensibility for future producers:** because the mirror hook sits at the UI layer right after
each already-existing `recordLearningPlan*` call, and always mirrors the *entire* current ledger
(not a per-event queue), any future producer that writes into the same `ta3-life-ledger-v1` store
via the existing `life-ledger-runtime.js` upsert path is transported automatically the next time
any mirror fires — no new wiring required per producer. Workout/Meal adapters exist as *models*
today but are not wired into a live runtime producer path in this app; Phase 10 does not change
that (see "What is NOT automated" below).

## Background worker (`scripts/life-ledger-sync-worker.mjs`)

**One-shot, not a daemon.** The script runs exactly one cycle and exits; a repeating Windows Task
Scheduler trigger is what gives it a cadence (`setup-life-ledger-sync-scheduler.ps1`,
`-IntervalMinutes`, default 15). This was chosen over a long-running Node process because it needs
no crash-recovery machinery of its own — every run starts from nothing, reads current state, and
exits — matching "safe startup/restart" and "no dependence on VS Code or the coding agent being
active" directly.

- **Concurrency:** a lock file (`<backupsRoot>/life-ledger-sync-worker.lock`, PID + timestamp) is
  the worker's own belt; Task Scheduler's `MultipleInstances = IgnoreNew` setting is the
  suspenders. A lock is only ever broken if its PID is no longer running or it is older than 30
  minutes (far beyond the expected sub-minute cycle time) — never on a live, fresh lock.
- **Config:** `scripts/life-ledger-sync-worker.config.json` (gitignored — see the committed
  `.example.json`) supplies `outboxDir` / `vault` / `expectedVault` / `backupsRoot`; CLI flags
  override it.
- **Default is a dry run.** `--apply` is required for the worker to actually write; without it,
  every cycle only reports what it *would* do. This is a second, independent safety layer beyond
  not-registering-the-real-task.

## Existing-root safe sync transaction (`life-ledger-sync-cycle.js`)

This is pure orchestration over Phase 9's already-reviewed primitives — it invents no new write
logic. One call performs, in order:

1. Parse the outbox snapshot (or report `no_source` if none exists yet).
2. `planObsidianSync()` — read-only.
3. **First-run guard:** if the plan reports `isFirstRun === true`, the cycle refuses to proceed
   and reports `intervention_required`. Recreating a whole managed root from nothing is an
   irreversible, one-time decision that stays human-operated (via
   `scripts/sync-life-ledger-to-obsidian.mjs --first-run-ack`, unchanged from Phase 9) —
   automation never supplies that acknowledgement on anyone's behalf.
4. **Ownership/conflict check:** an unmanaged root, an invalid sentinel, or any per-file conflict
   reports `conflict` with the exact reason and zero writes.
5. **Nothing pending:** if every operation is `UNCHANGED`/`STALE`, reports `unchanged`, zero
   writes.
6. **Safe changes exist:** `prepareObsidianRollbackArtifact()` writes a *fresh*, run-scoped
   backup+receipt outside the vault, `verifyObsidianRollbackReceipt()` confirms it, then
   `applyObsidianSync()` runs with full production authorization (mode, allowApply, apply, exact
   expected-vault match, the just-verified receipt). Phase 9's own preflight re-checks every
   operation's on-disk precondition immediately before writing (catches a plan/apply race:
   `precondition_changed`, zero writes) and writes content → manifest → sentinel, in that order,
   so a sentinel on disk can never imply an incomplete write.
7. **Verify:** re-plans read-only after applying and confirms nothing is still pending; a mismatch
   reports `intervention_required` (the apply already happened — this can only report, not undo).

### Rollback artifact lifecycle

Every changing cycle prepares a **fresh** receipt at `<backupsRoot>/receipts/<runId>/` (never
reused across runs — a stale or pre-existing receipt at that path is refused outright, `error`,
zero writes). `backupsRoot` defaults to `Second-Brain-Backups\life-ledger-sync\` (same backup root
family as the Phase 9B first-run receipt, kept entirely outside the vault). Old run receipts are
never deleted by this Phase — Phase 10 only ever *creates* new receipt directories; pruning is a
Phase 11 concern (see Known Limitations).

### Failure taxonomy

| Category | Meaning | Retry? |
|---|---|---|
| `error` / `before_write` | Nothing was written (bad config, unreadable vault, transient I/O, a receipt-prep failure) | Safe — a later cycle with the same inputs can succeed |
| `conflict` | Ownership/content mismatch, or a plan/apply-window precondition race | Safe to re-run (it only replans); requires a human to resolve the underlying conflict |
| `intervention_required` / `after_write_partial` | `applyObsidianSync` threw `partial_apply_failure` mid-write | **Never auto-retried within the same call.** Reported with exact `written` + `failedRelativePath` evidence. (The underlying content→manifest→sentinel ordering means a *later, independent* cycle can often safely complete an interrupted apply — proven in `life-ledger-sync-cycle.test.js` — but the failure is still always surfaced, never silently absorbed.) |
| `intervention_required` / `unexpected_first_run_state` | Managed root unexpectedly absent | Never auto-resolved — human-only path |
| `intervention_required` / `after_write_verification` | Apply succeeded but the post-apply replan doesn't show a fully-synced state | Apply already happened; report only |

## Sync status (truthfulness contract)

The worker never talks to the browser directly. It writes a small, secret-free status summary
(`summarizeCycleResultForOutbox()`) back into the *same* outbox folder the browser already has
write access to; the Settings UI reads it back from there. `describeLifeLedgerSyncStatus()`
(`life-ledger-sync-status-ui.js`) renders exactly one of:

- **Not available** — browser lacks File System Access support.
- **Off** — not yet enabled (Enable button shown).
- **Paused** — enabled, but folder permission lapsed (Resume button shown).
- **Waiting for the first sync** — enabled and granted, but no worker status yet.
- **"Life Ledger synced."** — **only** when the worker's last reported outcome was
  `synced`/`unchanged` **and** the hash it recorded matches the hash of the *current* local
  snapshot. A worker report for an older snapshot never renders as synced.
- **"...changes waiting to sync."** — worker succeeded, but for an outbox snapshot older than what
  is currently in localStorage.
- **Blocked: conflict** / **needs attention** / **temporarily unavailable** — the corresponding
  worker outcome, verbatim reason included where available.

This is unit-tested directly (`life-ledger-sync-status-ui.test.js`): every non-synced/non-unchanged
worker outcome is asserted to never render the string "Life Ledger synced."

## Install / start / stop / diagnose (`setup-life-ledger-sync-scheduler.ps1`)

```
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Install [-IntervalMinutes 15] [-Apply]
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Status
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Uninstall
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action RunOnce [-Apply]
```

`Install` registers a Task Scheduler task named `ChronaSense Life Ledger Sync` running
`node scripts/life-ledger-sync-worker.mjs` on a repeating trigger with
`MultipleInstances = IgnoreNew`. Without `-Apply`, the scheduled task runs forever in dry-run mode
(useful to observe worker behavior before trusting it with real writes). `RunOnce` runs a single
diagnostic cycle directly, no scheduler involved — the manual-run path required for diagnostics
without touching Task Scheduler at all.

## What is automated vs. what remains manual

**Automated (Phase 10):**
- Life Ledger events reaching the background worker (no manual export).
- Deterministic snapshot construction, plan, conflict detection, rollback-artifact preparation,
  apply, and post-apply verification for an **already-owned, existing-root** vault.
- Truthful sync status in the app.

**Still manual (by design):**
- The very first onboarding of a managed root (`--first-run-ack`) — unchanged from Phase 9.
- Resolving any reported conflict (human-edited file, manifest/sentinel tamper, unowned
  collision) — the worker only ever reports these, never resolves them.
- Enabling Background Sync itself (one-time folder pick) and re-granting a lapsed permission
  (one click) — both require a user gesture by browser design.
- Registering the real scheduled task (this Builder phase deliberately stops short of that).
- Recovering from a `partial_apply_failure` — the receipt + backup exist for a human to restore
  from if needed; Phase 10 does not build an automated restore executor (see Known Limitations).

## Known limitations / Phase 11 debt

- **Browser support is Chromium-only.** File System Access API (`showDirectoryPicker`) is not
  available in Firefox or the Capacitor Android WebView. On those, Background Sync reports
  "not available" and the Phase 9 manual export/CLI path remains the only option — this is an
  accepted, documented gap, not a silent failure.
- **No automated receipt/backup retention or pruning.** `Second-Brain-Backups\life-ledger-sync\`
  will accumulate one receipt directory per changing cycle indefinitely.
- **No automated rollback executor.** A `partial_apply_failure` or a conflict leaves the operator
  with a verified receipt and backup, but restoring from it is still a manual step — building a
  safe, ownership-reverifying automated restore is explicitly out of scope for Phase 10 (per the
  existing debt already noted in `obsidian-life-ledger-sync.js`'s own design notes).
- **The one-shot worker lock check is not cross-machine.** It protects one machine's Task
  Scheduler + manual invocations from racing each other; it says nothing about two different
  machines pointed at the same vault (not a scenario this single-user setup creates today).
- **Workout/Meal are not live producers into this app's runtime Life Ledger** — their adapters and
  model support exist, but Phase 10 does not fabricate a live wiring the source apps don't
  actually provide (see `docs/LIFE_LEDGER_CONTRACT.md` for the adapter contract; ChronaSense's own
  live path is `focus_session_completed` / `plan_step_completed` only).

## Activation (post-review, NOT part of the Phase 10 Builder deliverable)

1. Create `scripts/life-ledger-sync-worker.config.json` from the committed `.example.json`,
   pointing at the real outbox folder, the real vault, and a real `backupsRoot`.
2. In the app, click "Enable Background Sync" once and pick the same outbox folder.
3. `pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Install -Apply` (omit `-Apply` first to
   observe a few dry-run cycles if preferred, then re-run with `-Apply` once satisfied).
4. `pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Status` to confirm registration.
