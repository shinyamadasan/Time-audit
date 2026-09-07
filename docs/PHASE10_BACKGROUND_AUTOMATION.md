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

**Mirror write serialization.** Ledger mutations can fire two mirror calls back-to-back (e.g. a
focus session's outcome followed immediately by its plan-step completion). `writeOutboxSnapshotIfEnabled()`
captures the current snapshot only when its queued task actually starts executing, and every call
is chained through one strict FIFO promise queue — a later call's task literally cannot begin
until every call enqueued before it has fully settled. This guarantees disk-commit order always
matches call order and the final on-disk content always reflects the *last* call's state at
execution time, even if an earlier call's I/O happens to be slower (proven in
`life-ledger-sync-bridge.test.js` with an artificially delayed older write). A failed write
resolves rather than throws, so one failure never blocks later calls.

**Self-healing mirror refresh (best-effort).** A mirror write can fail transiently (a lapsed
permission, a momentary I/O error) and previously would only recover on the next unrelated Ledger
mutation. `getStatus()` now compares the current canonical hash against the hash of what this
bridge instance itself last successfully wrote, and — when they differ — schedules exactly one
refresh attempt through the same serialized queue (never an aggressive retry loop, never blocking
the status read). Opening Settings or reloading the app is enough to trigger recovery.

## Background worker (`scripts/life-ledger-sync-worker.mjs`)

**One-shot, not a daemon.** The script runs exactly one cycle and exits; a repeating Windows Task
Scheduler trigger is what gives it a cadence (`setup-life-ledger-sync-scheduler.ps1`,
`-IntervalMinutes`, default 15). This was chosen over a long-running Node process because it needs
no crash-recovery machinery of its own — every run starts from nothing, reads current state, and
exits — matching "safe startup/restart" and "no dependence on VS Code or the coding agent being
active" directly.

- **Concurrency:** a lock file (`<backupsRoot>/life-ledger-sync-worker.lock`, PID + timestamp) is
  the worker's own belt; Task Scheduler's `MultipleInstances = IgnoreNew` setting is the
  suspenders. **Liveness is authoritative over age:** a lock whose PID is confirmed running is
  held regardless of how old it is; a lock whose PID is confirmed dead is reclaimable immediately
  regardless of age; only a lock whose content can't even be parsed (no usable PID at all) falls
  back to a 30-minute age ceiling as a documented, conservative last resort. Breaking a stale lock
  is an atomic rename-to-a-unique-tombstone, not an unconditional delete-then-recreate — if two
  contenders both judge the same lock stale, exactly one wins the rename; the other gets a clean
  `ENOENT` and backs off as "already running," never a crash, never a double-acquisition (proven
  in `scripts/life-ledger-sync-worker.test.js` with two concurrent contenders racing one stale
  lock).
- **Config:** `scripts/life-ledger-sync-worker.config.json` (gitignored — see the committed
  `.example.json`) supplies `outboxDir` / `vault` / `expectedVault` / `backupsRoot`; CLI flags
  override it.
- **Default is a dry run.** `--apply` is required for the worker to actually write; without it,
  every cycle only reports what it *would* do. This is a second, independent safety layer beyond
  not-registering-the-real-task.
- **Intervention latch:** see the dedicated section below — a real apply that reports
  `intervention_required` persists a durable latch that blocks every later `--apply` invocation
  until a human explicitly clears it.

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
| `intervention_required` / `after_write_partial` | `applyObsidianSync` threw `partial_apply_failure` mid-write | **Never auto-retried within the same call, and now latched** (see below) — every later `--apply` invocation is refused until a human explicitly clears it. Reported with exact `written` + `failedRelativePath` evidence. |
| `intervention_required` / `unexpected_first_run_state` | Managed root unexpectedly absent | Never auto-resolved, and latched — human-only path |
| `intervention_required` / `after_write_verification` | Apply succeeded but the post-apply replan doesn't show a fully-synced state | Apply already happened; latched — report only |
| `intervention_required` / `latched` | A prior real apply already latched; this `--apply` invocation was refused before touching anything | Not applicable — clear the latch first (see below) |

### Persisted intervention latch

The cycle module (`life-ledger-sync-cycle.js`) itself is unchanged and still never loops or
retries within a single call — that part of the design held up under review. What was missing was
persistence *across* calls: on its own, nothing stopped the *next* scheduled worker invocation,
15 minutes later, from re-planning, preparing another rollback artifact, and attempting to
continue an interrupted write automatically. That contradicted the intended "action required, no
blind auto-retry" behavior, so the worker (`scripts/life-ledger-sync-worker.mjs`) now owns a
durable latch on top of the cycle's per-call result:

- **Trigger:** any *real* (`--apply`, non-dry-run) cycle result with `outcome === 'intervention_required'`
  writes `<backupsRoot>/intervention-required.json` — schema version, `createdAt`, `runId`,
  `outcome`/`category`/`reason`/`message`, `planFingerprint`, `outboxSha256`, `receiptPath`,
  `written`, `failedRelativePath`. No vault contents, no secrets, no arbitrary paths beyond the
  receipt location. Dry runs never create or touch the latch — they may still observe and report
  the same underlying state (e.g. an unexpected first-run condition), purely informationally.
- **While latched, every `--apply` invocation is refused before the cycle is ever called:** zero
  rollback-artifact preparation, zero backup copy, zero managed write, and — critically — zero new
  receipt-directory churn no matter how many times the scheduler fires (proven with three
  consecutive blocked `--apply` invocations creating no new receipts). The worker still writes a
  run log and outbox status each time (`outcome: 'intervention_required', category: 'latched'`) so
  the audit trail stays honest, but nothing under the vault or the backup receipts is touched.
- **Explicit human clear:** `node scripts/life-ledger-sync-worker.mjs --clear-intervention` (or
  `setup-life-ledger-sync-scheduler.ps1 -Action ClearIntervention`) removes only the latch file —
  never receipts, never backups, never the vault — and reports what was cleared. Idempotent: with
  no latch present it reports `no_intervention_latch` and exits cleanly rather than erroring.
- **Recovery:** once cleared, the next `--apply` invocation runs the cycle normally. If the
  underlying vault state is actually safe (per the content→manifest→sentinel ordering, an
  already-landed file is byte-identical and simply gets skipped, not rewritten), that invocation
  can complete the interrupted sync and report `synced` without re-creating the latch.
- **Status:** while latched, the Settings UI shows "Sync is paused pending manual review... Action
  required" — it never says "synced" (the worker's recorded hash for a latched result never
  matches the current one) and never says the generic transient-error "will retry automatically"
  wording, because a latch is not a transient condition.

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
- **"Sync is paused pending manual review... Action required."** — an intervention latch is set
  (see above). Distinct wording from the generic "needs attention" case, and never rendered as
  "temporarily unavailable / will retry automatically" — a latch is not a transient condition.

This is unit-tested directly (`life-ledger-sync-status-ui.test.js`): every non-synced/non-unchanged
worker outcome is asserted to never render the string "Life Ledger synced."

## Install / start / stop / diagnose (`setup-life-ledger-sync-scheduler.ps1`)

```
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Install [-IntervalMinutes 15] [-Apply]
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Status
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Uninstall
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action RunOnce [-Apply]
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action ClearIntervention
```

`Install` registers a Task Scheduler task named `ChronaSense Life Ledger Sync` running
`node scripts/life-ledger-sync-worker.mjs` on a repeating trigger with
`MultipleInstances = IgnoreNew` and a 10-year finite `-RepetitionDuration` (a large but *finite*
`TimeSpan`, not `[TimeSpan]::MaxValue` — some Windows Task Scheduler builds have been reported to
handle a near-int64-max repetition duration inconsistently; `Install` is idempotent and trivially
re-registered long before ten years matters). Without `-Apply`, the scheduled task runs forever in
dry-run mode (useful to observe worker behavior before trusting it with real writes). `RunOnce`
runs a single diagnostic cycle directly, no scheduler involved. `ClearIntervention` forwards to the
worker's own `--clear-intervention` (see the latch section above) and does not itself touch the
vault, receipts, or backups.

**Runs only while logged on; no elevation.** No `-Principal` is supplied to `Register-ScheduledTask`,
so the task runs as the current interactive user, only while that user is logged on to Windows —
no stored credentials, no "run whether user is logged on or not". It requires no admin rights (no
`-RunLevel Highest`). If the machine is off, asleep, or logged out at a trigger time, that cycle is
simply skipped; the next trigger a few minutes later covers it. This is a deliberate simplicity
choice for the current single-user desktop setup, not an oversight — `Status` surfaces the task's
actual last/next run times so this is always observable.

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
- Clearing an intervention latch (`--clear-intervention` / `-Action ClearIntervention`) — a
  deliberate, explicit human action; automation never clears its own latch.

## Known limitations / Phase 11 debt

- **Browser support is Chromium-only.** File System Access API (`showDirectoryPicker`) is not
  available in Firefox or the Capacitor Android WebView. On those, Background Sync reports
  "not available" and the Phase 9 manual export/CLI path remains the only option — this is an
  accepted, documented gap, not a silent failure.
- **No automated retention or pruning of run logs, receipts, or backups.** The worker writes
  `<backupsRoot>/runs/<runId>.json` and `<backupsRoot>/status.json` on **every** invocation,
  including `unchanged`/`no_source` cycles, and `<backupsRoot>/receipts/<runId>/` on every
  *changing* cycle — none of it is ever pruned by Phase 10. Left running indefinitely, these will
  grow without bound. The intervention latch (above) *does* prevent one specific runaway case — a
  fault loop where a broken condition would otherwise cause a fresh receipt directory on every
  scheduled tick — by refusing all further `--apply` cycles (and therefore all further receipt
  creation) until a human clears it. Outside that specific case, retention/pruning policy is
  explicitly Phase 11's to own.
- **No automated rollback executor.** A `partial_apply_failure` or a conflict leaves the operator
  with a verified receipt and backup, but restoring from it is still a manual step — building a
  safe, ownership-reverifying automated restore is explicitly out of scope for Phase 10 (per the
  existing debt already noted in `obsidian-life-ledger-sync.js`'s own design notes).
- **The one-shot worker lock check is not cross-machine.** It protects one machine's Task
  Scheduler + manual invocations from racing each other (including an atomic stale-lock takeover
  so two local contenders can never both proceed); it says nothing about two different machines
  pointed at the same vault (not a scenario this single-user setup creates today).
- **No automatic cleanup of orphaned `.tmp` files.** `guardedAtomicWrite()` in
  `obsidian-life-ledger-sync.js` writes to a `.<name>.tmp` file before renaming it into place; a
  hard-killed process (not a clean `partial_apply_failure`, an actual crash mid-syscall) could in
  principle leave an orphaned `.tmp` file behind in a managed directory. This is a pre-existing,
  Phase-9-level characteristic, not something Phase 10 introduces — flagged here as Phase 11 info,
  not a Phase 10 gap, and no automatic deletion of unrecognized files was added (that would be its
  own new risk surface not justified by this Phase's scope).
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
