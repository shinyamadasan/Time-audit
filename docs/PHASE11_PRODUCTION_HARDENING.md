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

**Active-latch protection is absolute — for both a healthy latch and a corrupt one, by different
mechanisms:**
- A **healthy (parseable)** `intervention-required.json` protects exactly its referenced evidence:
  the run log for its `runId` and the receipt directory at its `receiptPath` are never candidates
  for deletion — proven under load in the chaos suite (many real cycles, a real latch, retention run
  against artificially-aged evidence, the latch's receipt survives).
- A **corrupt (present but unparseable)** latch is the more dangerous case — its `runId`/`receiptPath`
  can't be read, so exactly which run/receipt it references is *unknown*. Silently falling back to
  "protect nothing specific, count-floor still applies" (the pre-fix behavior) could prune the exact
  evidence an active incident depends on. Fixed: a corrupt latch now blocks **all** run-log and
  receipt pruning outright — `retentionBlocked: true, retentionBlockedReason:
  'corrupt_intervention_latch'` in the plan, printed plainly by the CLI — regardless of age or count
  floor, until a human clears it via `--clear-intervention` (see §3). Lock-tombstone cleanup is
  **not** blocked by a corrupt latch: tombstones are always-orphaned by construction (the worker
  never reads a tombstone name back) and never reference incident evidence, so pruning them stays
  safe even while everything else is frozen. `restore-evidence/` (see §2) is outside this module's
  scope entirely, corrupt latch or not.

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

**Deliberately scoped narrower than "undo everything a receipt saw" — and narrower still after the
Phase 11 review's fix pass.** A rollback receipt's `backup` is a *pre-apply* snapshot of the whole
managed subtree — it only ever contains files that already existed before that apply ran (a file
the same apply newly *created* is absent from its own receipt; there is nothing to "roll back" to
for it). This tool **never deletes anything**, full stop — a delete-capable restore was considered
and explicitly not built (see the original scoping note below), and that has not changed.

**Automated overwrite is never safe (Review Finding 2) — this is the single biggest behavior
change from the tool's first version.** The first version treated any existing file whose bytes
differed from the pre-incident backup as a safe "restore_overwrite" candidate. That was wrong: this
system keeps **no durable evidence of what the expected post-incident bytes should be**.
`applyObsidianSync`'s partial-failure evidence (`written[]` / `failedRelativePath`) records only
relative *paths*, never target content or its hash, and the in-memory plan that had that
information is gone the instant the failed process exits — nothing persists it. So
`currentHash != preIncidentBackupHash` can mean the failed apply's own (correct!) partial write, a
human edit made afterward, or something else entirely — and there is no way to tell those apart
from evidence this system actually keeps. Inventing a comparison against a hash that was never
recorded would be trust theater, not verification (see the "Option A vs Option B" note below).

So the tool now only ever performs two kinds of automated action:
- **`restore_create`** — a file the receipt backed up is currently *missing*. Recreating it risks
  nothing existing (there is no data to lose), so this stays fully automated.
- **`noop_already_matches`** — current bytes already equal the backup; nothing to do.

Any existing file whose bytes differ from the backup is classified **`ambiguous_current_state`**
and is **never** written — preview reports it with full diagnostic evidence (current sha256,
pre-incident sha256, the exact backup source path to diff against by hand, and an explanation of
why it's ambiguous); apply refuses to touch it, unconditionally. `applyRestore` also re-checks each
`restore_create` target is *still* missing immediately before writing it (closing the gap between
preview and apply) — if something now exists there, that entry is downgraded to ambiguous on the
spot rather than silently overwritten.

**Residual CREATE-before-failure files (Review Finding 3).** A file newly *created* by the same
apply that later failed is, by construction, absent from that apply's own pre-incident backup —
there was nothing to back up. Write-only restore cannot remove such a residual (removal is out of
scope by design, same as above), so it is never silently treated as "handled": any file present
under the managed root now but not in the receipt's backup set is classified
**`residual_created_file`**, named exactly, and forces the overall result to
`manual_review_required`.

**Result vocabulary — the one field a human needs to answer "did this actually return my Life
Ledger to the exact pre-incident state?":** every `previewRestore`/`applyRestore` result carries a
top-level `completeness`:
- `'noop'` — every backed-up file already matches; nothing to do; no residuals.
- `'exact_restore_possible'` (preview) / `'exact_restore_complete'` (after apply) — every
  difference is a safe create, there are no ambiguous or residual files; the exact pre-incident
  state was (or would be) fully achieved.
- `'manual_review_required'` — at least one ambiguous-overwrite or residual-created file exists.
  Restore still writes the independently-safe subset (missing-file creates), but **never** reports
  `exact_restore_complete` while this is true. The CLI prints every ambiguous/residual path with
  its diagnostic detail whenever this state is reached.

A receipt from a **fully successful** apply is, honestly, a poor restore target: its own
manifest.json/sentinel legitimately differ from the pre-apply backup (that's the point of a
successful sync), and this tool has no more evidence for those two files than for any content file
— so they show up as ambiguous too, correctly, under the same rule. Restore is really only
"clean" (able to reach `exact_restore_complete`) against a receipt whose OTHER tracked files still
match their pre-apply state — realistically, a genuinely-incomplete apply, or a snapshot taken
specifically to guard an otherwise-untouched file.

Flow: `loadRestoreReceipt` (exact path, must be a plain file, basic shape validation) →
`verifyRestoreReceipt` (independently re-verifies CURRENT vault ownership via the same read-only
sentinel+manifest inspection the worker already runs every cycle; confirms the receipt is bound to
this exact vault/managed root; reproduces every backed-up file's sha256 AND the aggregate
`backupManifestSha256` from the actual bytes still on disk, fails closed on any mismatch; refuses a
first-run receipt outright — restoring one would mean deleting the current managed root, out of
scope) → `previewRestore` → `applyRestore`, gated behind explicit `--apply-restore`. Because
nothing existing is ever overwritten, there is nothing to preserve evidence of before writing — the
untouched ambiguous/residual file *is* the evidence, sitting exactly where it was (the tool no
longer needs or accepts a `--backups-root` flag for an evidence-copy step). Every write is confined
via `resolveObsidianLifeLedgerPath` / `writeFileAtomically` — the same reparse-safety the reviewed
Phase 9/10 write path uses — so `.git`, `.obsidian`, `.rag`, and anything outside `Life Ledger/`
are structurally unreachable, not just policy-excluded.

**Two designs were on the table for handling ambiguity (Review Finding 2); Option B was chosen.**
Option A — "proven automated restore" — would only overwrite when the current bytes are proven to
equal the exact expected post-incident bytes. That proof is theoretically reconstructible in a
narrower case (re-deriving the failed plan from the exact original outbox snapshot bytes plus the
receipt's own backup as a baseline, since the renderer is deterministic) — but doing that correctly
would mean building a second, parallel "virtual replan" code path in this fix pass, which is exactly
the kind of scope expansion the brief says to avoid ("do NOT redesign Phase 11"), and depends on the
original outbox snapshot bytes still being available (the outbox is a mutable browser-owned mirror
with no such guarantee). Option B — conservative manual recovery, block on ambiguity — needs no new
inference machinery, degrades safely, and is what the review explicitly said to prefer when in
doubt. This tool implements Option B.

**Note on "receipt cryptographically verified" — integrity is not authentication.** The on-disk
receipt (as written by `prepareObsidianRollbackArtifact`) does not carry a persisted top-level
self-hash of its own bytes — that hash is computed once, in-memory, purely for the writer's own
immediate self-check. What this tool actually re-verifies cryptographically, fresh from disk, is
the receipt's *backup content integrity*: every individual file hash and their aggregate,
reproduced from the backup artifact's actual current bytes and compared against what the receipt
claims. Reproducing a hash proves the backup bytes have not silently changed since they were
written — it is **not** authentication (it does not prove who wrote the receipt, or that no one
could regenerate a self-consistent-but-wrong one). This system has no adversarial threat model
(single-user local desktop automation) and makes no such claim.

**`planFingerprint` trust semantics, precisely.** The receipt's `planFingerprint` field is
validated as present, non-empty shape — nothing more. It is **never** compared against a freshly
re-derived plan anywhere in this tool. Doing that legitimately would require the exact original
outbox snapshot bytes the failed plan was built from, which are not guaranteed to still exist (see
the Option A/B note above). It is carried through as informational provenance only. The bindings
this tool actually verifies are vault/root identity (live re-check) and backup content integrity
(hash reproduction), described above.

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
storage footprint, whether pruning is due, and outbox-processed staleness — see below) by always
taking the **worse** of the two — a healthy-looking task with a real problem underneath is never
reported as fine. Never says HEALTHY when vault ownership or worker status could not be determined
(both fold to UNAVAILABLE); a vault that is merely unreachable right now (e.g. OneDrive still
mounting) is UNAVAILABLE, not ACTION REQUIRED — see OneDrive reality below.

**Current-outbox vs. last-processed-outbox (Review Finding 4).** Health already computed both the
current outbox snapshot's sha256 and the worker's last-*processed* outbox sha256
(`backupsRoot/status.json`'s `outboxSha256`) but never compared them — a scheduler stuck reporting
a stale success while a newer browser-mirrored event sat unprocessed would have read as HEALTHY.
Fixed: the two hashes are compared and surfaced as `facts.outboxProcessed = { currentSha256,
processedSha256, matches }`.
- Snapshot present, no worker status yet at all → **PENDING** ("waiting for the first sync").
- `backupsRoot/status.json` exists but doesn't parse → **UNAVAILABLE** (worker status is
  genuinely unknown, not merely stale — never HEALTHY when the thing that would prove it can't be
  read).
- Snapshot present, hashes differ → **PENDING** (not yet processed — waiting for the next cycle).
- Hashes match and everything else is clean → may be **HEALTHY**.

**Wall-clock freshness was deliberately NOT added on the Node side.** The reviewer separately asked
for a conservative "the last successful evidence is implausibly old" signal. Node-side health has
no reliable cadence context to judge that against — the configured scheduling interval lives only
in the registered Windows Task Scheduler trigger, which this module cannot read; that is
PowerShell-only information, and the PowerShell side already folds a non-zero `LastTaskResult` into
the merged classification. Inventing a hardcoded clock threshold here (e.g. "stale after N hours")
risks misclassifying a machine that was legitimately off or asleep overnight as unhealthy — exactly
what the review warned against — so, per the review's own stated escape hatch, no clock-based
freshness rule was added; the hash-mismatch check above is the freshness signal Node-side health
can respond to truthfully.

## 6. Long-run / chaos testing (`scripts/life-ledger-sync-chaos.test.js`)

Real worker, real fs, disposable temp fixtures, run through: many consecutive unchanged cycles
(idempotent, bounded run-log growth, exactly one receipt for the one cycle that actually wrote
something); many days of incremental new events (no duplicate events ever appear in a daily file);
worker-restart-safety (every cycle is its own process invocation — no lock ever leaks between
calls); the browser replacing the outbox snapshot between every cycle; true concurrent contention
(`Promise.all` on two simultaneous invocations — exactly one runs, exactly one backs off); the
outbox and the vault each becoming transiently unavailable and then recovering, with zero data
loss and zero crash in between; a rollback-preparation failure failing closed before any vault
write with no latch created; an end-to-end scenario combining many real cycles, a real
partial-apply-triggered (healthy) latch, artificially-aged evidence, and retention pruning —
proving the latch-protected receipt survives while genuinely stale evidence gets pruned; and the
same scenario again with the latch made **corrupt** afterward — proving retention blocks *all*
run/receipt pruning outright, not just the one receipt the latch used to reference (Review Finding
1). A malformed run-log file is proven harmless to retention (which never parses run-log JSON, only
`lstat`s for mtime). The human-edit-after-failure and CREATE-before-failure/residual-file scenarios
(Review Findings 2 & 3) use the same real-injected-failure technique but live in
`life-ledger-sync-restore.test.js` alongside the rest of that tool's coverage, rather than being
duplicated here.

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

## Test-harness isolation (Review Finding 7)

`scripts/test-life-ledger-sync-scheduler-install.ps1`'s Part D (dynamic `RunOnce` proof) previously
moved the **real** `scripts/life-ledger-sync-worker.config.json` aside, copied a disposable test
config over that exact path, ran `RunOnce`, then restored the original — because `-Action RunOnce`
had no way to point at an arbitrary config file. That is precisely the kind of real-production-
config risk this project's own safety rules forbid (a crash, a Ctrl-C, or an AV/OneDrive lock
between the swap and the restore could lose or corrupt the real config), and it made the harness
non-isolated. Root cause: a missing capability in the script under test, not a worker regression.
Fixed by adding an optional `-ConfigPath` parameter to `setup-life-ledger-sync-scheduler.ps1`,
forwarded straight to the worker's own `--config` flag; the harness now points `RunOnce` at its
disposable fixture directly and never reads, writes, or moves the real config path. Two new
regression checks were added: a static one (the `RunOnce` branch really does forward `-ConfigPath`
to `--config`) and a dynamic one (the real config path's presence/absence and bytes are identical
before and after Part D runs, whatever state it started in). Reproducibly 27/27 across repeated
runs and independent of working directory.

## Cross-machine locking

Out of scope, by design. The lock file, latch, and every tool in this phase assume a single
Windows PC owns this worker and this vault — there is no evidence today of a second machine running
the same worker against the same OneDrive vault. Building distributed locking now would be
speculative infrastructure for a scenario that doesn't exist; if that ever changes, it stays
future work, not retrofitted here.

## What Phase 11 still does NOT do

- No autonomous destructive rollback — restore is always human-initiated, preview-first, and
  write-only; it never deletes, and never overwrites an existing file it cannot prove is safe.
- No automated overwrite of an existing file whose bytes differ from a receipt's pre-incident
  backup, ever — flagged `ambiguous_current_state` and left for manual review instead (Review
  Finding 2).
- No removal of a file created by a partial apply that later failed — flagged
  `residual_created_file`, and its presence always prevents restore from reporting complete success
  (Review Finding 3).
- No pruning of run logs or receipts while an intervention latch exists and is corrupt/unparseable
  — pruning is blocked outright until a human clears it (Review Finding 1).
- No auto-clearing of a healthy intervention latch — only a corrupt one's *removal path* was
  hardened; the human-review requirement is unchanged.
- No wall-clock-based "stale evidence" freshness rule on the Node health side (documented
  escape-hatch reason: no reliable cadence context available there — Review Finding 4).
- No pruning, restore, or scheduler changes were ever run against the real production
  backupsRoot/vault/task during this Builder pass, or during the review fix pass.
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
node scripts/life-ledger-sync-restore.mjs --receipt <path> --vault <path>                     # preview only
node scripts/life-ledger-sync-restore.mjs --receipt <path> --vault <path> --apply-restore      # writes only the safe subset; see completeness
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action Health
pwsh ./setup-life-ledger-sync-scheduler.ps1 -Action RunOnce -ConfigPath <path>                 # diagnostic cycle against any config, real or disposable
```

All of the above default to preview/dry-run; every mutating action requires an explicit flag.
