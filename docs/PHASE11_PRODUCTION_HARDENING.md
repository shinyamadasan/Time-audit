# Phase 11 — Production Hardening

Status: **built, NOT integrated.** Every tool described here exists and is tested against
disposable temp vaults/backups roots. The real Windows scheduled task, the real worker config,
the real outbox, the real backups root, and the real OneDrive vault were **never mutated** by this
Builder pass — verified read-only before and after (see the Phase 11 final report for the exact
hashes/state captured). Integration into daily use, and any real pruning/restore, happens only
after independent review.

## Scope: operational hardening only

Phase 10 made the sync automatic. Phase 11 makes it dependable to leave running unattended for
months: bounded local storage growth, safer failure recovery, one command to check health. It adds
**zero** product features, changes **zero** sync/plan/apply logic in `life-ledger-sync-cycle.js` /
`obsidian-life-ledger-sync.js`, and does not touch the browser-side mirror, the outbox transport
format, or the intervention-latch trigger conditions (only how a *corrupt* latch file is cleared —
see below).

## Debt classification

The Phase 11 brief listed ten items of known debt from Phase 10. Classification and disposition:

| # | Debt | Classification | Disposition |
|---|---|---|---|
| 1 | Run logs grow without pruning | MUST FIX NOW | Built — `life-ledger-sync-retention.mjs` |
| 2 | Receipts/backups grow without pruning | MUST FIX NOW | Built — same module |
| 3 | No automated rollback/restore executor | SHOULD FIX NOW | Built, deliberately scoped — `life-ledger-sync-restore.mjs` (write-only, see below) |
| 4 | Orphan `.tmp` files after a hard kill | SHOULD FIX NOW (worker-owned names) / ACCEPTED DEBT (vault-content `.tmp`) | Built for the two worker-owned `.tmp` names; vault-content `.tmp` explicitly deferred |
| 5 | Orphan `.lock.stale-*` tombstones | MUST FIX NOW | Built — folded into the retention module |
| 6 | Intervention latch recovery is manual | ACCEPTED DEBT | Intentional by design; unchanged — the brief itself says never auto-clear a healthy latch |
| 7 | Corrupted latch may need manual file deletion | MUST FIX NOW | Built — `--clear-intervention` now handles a corrupt latch itself |
| 8 | Browser mirror retries once per Settings open | ACCEPTED DEBT | Frontend/browser concern, outside every Required Outcome in this phase; not touched |
| 9 | No cross-machine locking | ACCEPTED DEBT | No evidence of multi-machine use; building it now would be speculative — see below |
| 10 | No chaos/stress testing | MUST FIX NOW | Built — `life-ledger-sync-chaos.test.js` |

## 1. Retention (`scripts/life-ledger-sync-retention.mjs`)

Policy: **age, with a count floor.** For `runs/*.json` and `receipts/<runId>/` independently: an
entry is deleted only if it is BOTH older than `retentionDays` (default 30) AND ranked outside the
most recent `minKeep` (default 20, floor of 1 always enforced) entries by mtime. Whichever rule
would keep *more* wins — a misconfigured `retentionDays=0` can never delete every last piece of
diagnostic evidence. `life-ledger-sync-worker.lock.stale-*` tombstones (always-orphaned by
construction — the worker never reads a tombstone name back) use a single age threshold (default
60 minutes), no count floor needed.

**Active-latch protection is absolute:** if `intervention-required.json` is present and parses,
the run log for its `runId` and the receipt directory at its `receiptPath` are never candidates
for deletion — proven under load in the chaos suite (many real cycles, a real latch, retention run
against artificially-aged evidence, the latch's receipt survives).

Every candidate is `lstat`'d (never a symlink/reparse point) and realpath-contained inside the
exact `backupsRoot` before deletion; anything that fails either check is skipped and reported, not
deleted or followed. Preview (`planLifeLedgerRetention`) is the default; `applyLifeLedgerRetentionPlan`
requires the caller to have already built a plan, and the CLI requires `--apply`. Idempotent —
running twice deletes nothing further the second time.

Actual production footprint observed (read-only, 2026-09-04): 8 run logs, ~3.4 KB total, zero
receipts (no real content write since the Phase 9B/10 activation — every cycle so far has been an
`unchanged` no-op). At that rate, default retention won't prune anything for months; the policy
exists for steady-state, not because current growth is urgent.

## 2. Recovery tooling (`scripts/life-ledger-sync-restore.mjs`)

**Deliberately scoped narrower than "undo everything a receipt saw."** A rollback receipt's
`backup` is a *pre-apply* snapshot of the whole managed subtree — it only ever contains files that
already existed before that apply ran (a file the same apply newly *created* is absent from its
own receipt; there is nothing to "roll back" to for it). This tool exploits exactly that shape: it
only ever **writes** (creates or overwrites) the exact files a verified receipt backed up, back to
their exact backed-up bytes. **It never deletes anything.** Files that exist now but were not in
the receipt's backup set are listed in the preview and left completely alone.

A delete-capable restore (to fully reconstruct "exactly the state at receipt time," including
removing files created afterward) would materially expand this tool's blast radius for a benefit
the real failure mode doesn't need — the scenario this exists for is a **partial/corrupted apply**,
where some already-owned files need to go back to known-good bytes, not "time-travel the whole
vault." Per the brief's own instruction ("if a safe restore executor would materially expand
risk/scope: STOP and classify it as deferred"), full reconstruct-with-delete is explicitly **not
built** — deferred, not silently dropped.

Flow: `loadRestoreReceipt` (exact path, must be a plain file, basic shape validation) →
`verifyRestoreReceipt` (independently re-verifies CURRENT vault ownership via the same read-only
sentinel+manifest inspection the worker already runs every cycle; confirms the receipt is bound to
this exact vault/managed root; reproduces every backed-up file's sha256 AND the aggregate
`backupManifestSha256` from the actual bytes still on disk, fails closed on any mismatch; refuses a
first-run receipt outright — restoring one would mean deleting the current managed root, out of
scope) → `previewRestore` (file-by-file: create / overwrite / already-matches / unsafe, plus the
never-touched "exists now, not in this receipt" list) → `applyRestore`, gated behind explicit
`--apply-restore`, which preserves the current bytes of anything about to be overwritten (under
`<backupsRoot>/restore-evidence/<restoreRunId>/`) before writing, using the exact same
`resolveObsidianLifeLedgerPath` / `writeFileAtomically` reparse-safety the reviewed Phase 9 write
path uses — so `.git`, `.obsidian`, `.rag`, and anything outside `Life Ledger/` are structurally
unreachable, not just policy-excluded.

**Note on "receipt cryptographically verified":** the on-disk receipt (as written by
`prepareObsidianRollbackArtifact`) does not carry a persisted top-level self-hash of its own bytes
— that hash is computed once, in-memory, purely for the writer's own immediate self-check. What
this tool actually re-verifies cryptographically, fresh from disk, is the receipt's *backup
manifest*: every individual file hash and their aggregate, reproduced from the backup artifact's
actual current bytes and compared against what the receipt claims.

## 3. Intervention-latch recovery (`scripts/life-ledger-sync-worker.mjs`)

`--clear-intervention` no longer routes through the same JSON-parsing read path a normal cycle
uses (which intentionally still throws on a corrupt latch, so every automated cycle keeps failing
loud until a human clears it). It now inspects and clears the exact latch path directly: `lstat`
first (refuses anything that isn't a plain file — a symlink/reparse point or a directory at that
exact path is left completely alone and reported, never removed), then attempts to parse. A
healthy (parseable) latch clears exactly as before. A **corrupt** latch is cleared by renaming it
aside to `intervention-required.json.corrupt-<timestamp>` in the same directory — preserving the
original bytes as evidence rather than deleting them — which still counts as "cleared" because
every future `--apply` check looks for the exact original filename. No other file is ever touched.
A healthy latch is never auto-cleared; this only changes what happens when a human explicitly asks
to clear one.

## 4. Stale-artifact cleanup (`scripts/life-ledger-sync-tmp-cleanup.mjs`)

Narrowly scoped to the **two** fully-known `.tmp` filenames the worker itself can leave behind
after a hard kill between a write and its rename: `<backupsRoot>/intervention-required.json.tmp`
and `<outboxDir>/chronasense-life-ledger-outbox-v1.status.json.tmp`. A candidate is deleted only if
BOTH no worker lock is currently live in `backupsRoot` (reusing the worker's own liveness judgment
via the newly-exported `isBackupsRootLockLive()`) AND its mtime is past a conservative age
threshold (default 10 minutes) — either condition alone already rules out "a worker might still be
writing this," requiring both is belt-and-suspenders.

**Per-vault-content-file `.tmp` cleanup is explicitly out of scope and left as accepted debt.**
`obsidian-life-ledger-writer.js`'s `writeFileAtomically()` can, in principle, leave a
`.<name>.tmp` behind inside the managed `Life Ledger/` subtree after a hard kill. Distinguishing an
orphan from a currently-in-progress write there would require touching the already-reviewed Phase
9 write path, and any cleanup there means reaching into the vault itself — which this Builder phase
must never do. This is exactly the brief's own escape hatch ("if safe `.tmp` cleanup cannot be
distinguished from a potentially-active atomic write artifact: leave it as accepted debt").

## 5. Health command

`pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Health` (or
`node scripts/life-ledger-sync-health.mjs --json` directly). Entirely read-only. Classifies as
**HEALTHY / PENDING / BLOCKED / ACTION REQUIRED / UNAVAILABLE** — the PowerShell side computes its
own classification from the Scheduled Task's state/`LastTaskResult` and merges it with the Node
side's classification (config validity, outbox state, last worker status, the intervention latch,
current vault ownership via the same read-only inspection the worker runs every cycle, backup
storage footprint, and whether pruning is due) by always taking the **worse** of the two — a
healthy-looking task with a real problem underneath is never reported as fine. Never says HEALTHY
when vault ownership or worker status could not be determined (both fold to UNAVAILABLE); a vault
that is merely unreachable right now (e.g. OneDrive still mounting) is UNAVAILABLE, not ACTION
REQUIRED — see OneDrive reality below.

## 6. Long-run / chaos testing (`scripts/life-ledger-sync-chaos.test.js`)

Real worker, real fs, disposable temp fixtures, run through: many consecutive unchanged cycles
(idempotent, bounded run-log growth, exactly one receipt for the one cycle that actually wrote
something); many days of incremental new events (no duplicate events ever appear in a daily file);
worker-restart-safety (every cycle is its own process invocation — no lock ever leaks between
calls); the browser replacing the outbox snapshot between every cycle; true concurrent contention
(`Promise.all` on two simultaneous invocations — exactly one runs, exactly one backs off); the
outbox and the vault each becoming transiently unavailable and then recovering, with zero data
loss and zero crash in between; a rollback-preparation failure failing closed before any vault
write with no latch created; and an end-to-end scenario combining many real cycles, a real
partial-apply-triggered latch, artificially-aged evidence, and retention pruning — proving the
latch-protected receipt survives while genuinely stale evidence gets pruned. A malformed run-log
file is proven harmless to retention (which never parses run-log JSON, only `lstat`s for mtime).

Scenarios already covered more directly elsewhere are **not duplicated**: partial-apply → latch and
repeated latched scheduled runs, and the two-contender stale-lock race
(`life-ledger-sync-worker.test.js`); corrupt/malformed latch recovery
(`life-ledger-sync-intervention-latch-recovery.test.js`); stale lock tombstone pruning and
latch-protected-receipt-survives-pruning under a smaller, more targeted setup
(`life-ledger-sync-retention.test.js`); orphaned `.tmp` artifacts
(`life-ledger-sync-tmp-cleanup.test.js`). Precondition races (a file changing between plan and
apply) are covered upstream in `obsidian-life-ledger-sync.test.js`'s `precondition_changed` suite
and are not re-derived at the worker level.

## 7. OneDrive reality

This system controls the local filesystem only — it never pretends to verify cloud propagation.
`verifyObsidianVaultIdentity()`'s `vault_missing` case (the vault path can't currently be `lstat`'d
at all — e.g. OneDrive hasn't finished mounting) is treated by the health command as **UNAVAILABLE**
("unknown"), not ACTION REQUIRED ("proven broken") — a transient-unknown is not the same severity
as a tampered sentinel/manifest. The chaos suite proves the worker itself already fails closed
correctly on both a transiently-missing outbox (`no_source`, zero vault writes) and a
transiently-missing vault (`error`/`vault_missing`, zero writes), and recovers with no special
handling once either reappears. No bespoke OneDrive API was added or is needed.

## Cross-machine locking

Out of scope, by design. The lock file, latch, and every tool in this phase assume a single
Windows PC owns this worker and this vault — there is no evidence today of a second machine running
the same worker against the same OneDrive vault. Building distributed locking now would be
speculative infrastructure for a scenario that doesn't exist; if that ever changes, it stays
future work, not retrofitted here.

## What Phase 11 still does NOT do

- No autonomous destructive rollback — restore is always human-initiated, preview-first, and
  write-only.
- No auto-clearing of a healthy intervention latch — only a corrupt one's *removal path* was
  hardened; the human-review requirement is unchanged.
- No pruning, restore, or scheduler changes were ever run against the real production
  backupsRoot/vault/task during this Builder pass.
- No vault-content `.tmp` cleanup (accepted debt, see above).
- No cross-machine coordination (accepted debt, see above).
- No product features, no new event types, no AI/intelligence layer, no dashboards beyond the one
  health command.

## Running these tools for real (post-review, NOT part of this Builder pass)

```
node scripts/life-ledger-sync-health.mjs --json
node scripts/life-ledger-sync-retention.mjs                 # preview only
node scripts/life-ledger-sync-retention.mjs --apply          # after reviewing the preview
node scripts/life-ledger-sync-tmp-cleanup.mjs                # preview only
node scripts/life-ledger-sync-tmp-cleanup.mjs --apply
node scripts/life-ledger-sync-restore.mjs --receipt <path> --vault <path>                                   # preview only
node scripts/life-ledger-sync-restore.mjs --receipt <path> --vault <path> --apply-restore --backups-root <path>
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Health
```

All of the above default to preview/dry-run; every mutating action requires an explicit flag.
