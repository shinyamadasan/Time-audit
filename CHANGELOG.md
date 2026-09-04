# ChronaSense — Changelog

## Phase 10 — Life Ledger background sync automation (built, NOT activated) (branch: feat/life-ledger-background-automation-v1) — 2026-09-03
Removes the manual "export JSON, run the sync CLI by hand" step from the proven Phase 9 flow.
Adds a browser-side durable outbox mirror, a one-shot Windows background worker, and an
existing-root safe sync transaction (fresh rollback artifact per changing cycle, fail-closed on
any conflict, no blind retry after a partial write). All Phase 9 write-path safety logic
(ownership sentinel, manifest binding, preflight precondition re-check, production authorization
chain) is reused unchanged — Phase 10 is transport and scheduling around it, not a rewrite of it.
The real Windows scheduled task was never registered and the real OneDrive vault was never
written to during this build; see `docs/PHASE10_BACKGROUND_AUTOMATION.md` for the full design and
the post-review activation steps.
changed:
  - life-ledger-sync-cycle.js (new) — `runLifeLedgerSyncCycle()`: parses an outbox snapshot,
    plans (read-only), classifies into `no_source` / `unchanged` / `would_sync` (dry run) /
    `conflict` / `synced` / `intervention_required` / `error`, and — only for safe changes —
    prepares a fresh `prepareObsidianRollbackArtifact()`, verifies it, applies, and re-plans to
    verify the resulting state. Refuses to auto-acknowledge a first-run state
    (`unexpected_first_run_state`) — recreating a managed root stays a human-only decision via
    the existing `--first-run-ack` CLI path. `summarizeCycleResultForOutbox()` trims a result to
    a small, path-free subset safe for the browser-writable outbox folder.
  - scripts/life-ledger-sync-worker.mjs (new) — one-shot CLI: config resolution (flags override
    `scripts/life-ledger-sync-worker.config.json`, gitignored), a single-instance lock file with
    stale-lock detection (dead PID or >30min old), reads the outbox snapshot, calls the cycle
    (dry run unless `--apply`), writes a run log + `status.json` under `backupsRoot`, and writes
    a truthful status file back into the outbox folder.
  - life-ledger-sync-bridge.js (new) — browser-side durable transport: a one-time
    `showDirectoryPicker()` grant (persisted in IndexedDB) lets every successful Life Ledger
    write mirror the exact deterministic `exportLifeLedgerSnapshotJson()` envelope into a local
    outbox file, with no manual export click. Never throws into the caller; never auto-prompts
    for a lapsed permission (only an explicit user-gesture `resume()` re-requests it). Fully
    dependency-injected for testing (fake handle store / picker / digest).
  - life-ledger-sync-status-ui.js (new) — Settings UI wiring plus the pure, DOM-free
    `describeLifeLedgerSyncStatus()`: only ever renders "Life Ledger synced." when the worker's
    own reported outcome AND its recorded outbox hash match the CURRENT local snapshot — local
    persistence alone is never treated as proof of sync.
  - learning-plan-ui.js — added `mirrorLifeLedgerToOutbox()` (fire-and-forget, swallows its own
    errors) called after each of the five existing successful Life Ledger record paths (manual
    complete, manual reopen, focus-session-completed, plan-step-completed, and the retry-queue
    success path). No existing function signature changed.
  - index.html — added the Background Sync button/status elements under Settings → Data, and the
    `life-ledger-sync-status-ui.js` module script include. No existing markup removed or altered.
  - setup-life-ledger-sync-scheduler.ps1 (new) — `-Action Install|Uninstall|Status|RunOnce`
    Windows Task Scheduler install/start/stop/diagnostic interface, mirroring the existing
    `setup-task-scheduler.ps1` registration pattern (`MultipleInstances = IgnoreNew`). `Install`
    defaults to dry-run-only scheduled cycles unless `-Apply` is passed. Not run against the real
    task name during this Builder phase.
  - scripts/life-ledger-sync-worker.config.example.json (new) — committed placeholder shape;
    the real, machine-specific config file is gitignored.
  - eslint.config.js — added the three new browser-facing `.js` files to the ESM file list (and
    its `sourceType:'script'` fallback block's `ignores`), matching the existing pattern for
    every other `import`/`export`-using root file.
  - package.json — wired the four new test files (`life-ledger-sync-cycle.test.js`,
    `life-ledger-sync-bridge.test.js`, `life-ledger-sync-status-ui.test.js`,
    `scripts/life-ledger-sync-worker.test.js`) into the aggregate `test` script plus individual
    `test:life-ledger-sync-*` shortcuts, added `life-ledger-sync:run-once`, and added the four
    new source files to `lint`.
  - .gitignore — ignores the real (non-example) worker config file.
  - CODEMAP.md — five new module entries; corrected two stale "production sync is hard-disabled
    (`OBSIDIAN_PRODUCTION_SYNC_ENABLED = false`)" claims left over from before Phase 9B enabled
    it, found while documenting the module Phase 10 builds directly on top of.
  - docs/PHASE10_BACKGROUND_AUTOMATION.md (new) — full architecture writeup: transport authority,
    worker model, existing-root transaction, rollback-artifact lifecycle, failure taxonomy, status
    truthfulness contract, install/start/stop, what's automated vs. manual, known limitations.
  - New test files: life-ledger-sync-cycle.test.js (20), life-ledger-sync-bridge.test.js (14),
    life-ledger-sync-status-ui.test.js (11), scripts/life-ledger-sync-worker.test.js (9),
    tests/life-ledger-background-sync-ui.spec.js (2, Playwright) — 54 new Node tests + 2 new
    Playwright tests, all against disposable temp vaults/dirs; the real vault was never touched
    by any test.
verification: `npm test` 356/357 pass, 0 fail (the one skip is the pre-existing env-gated
  cross-repo control test, same as baseline); `npm run lint` 0 errors (same 19 pre-existing
  warnings in files this phase did not touch); `npx playwright test` 216/216 (214 pre-existing +
  2 new); STRICT `npm run test:cross-repo-compat` (explicit MEAL_REPO_PATH / OPENGYM_REPO_PATH)
  PASS ChronaSense / PASS Meal / PASS Workout 29/29, zero leg skips, exit 0. Real vault
  (`C:\Users\Admin\OneDrive\2nd Brain\Life Ledger`) hashes verified byte-identical before and
  after this entire build. Sibling repos (Meal prep app, openGym-longevity) and the authoritative
  main ChronaSense checkout were not modified. `OBSIDIAN_PRODUCTION_SYNC_ENABLED` left
  untouched at `true`. Real Windows Task Scheduler registration and any real-vault write were
  both explicitly NOT performed — see `docs/PHASE10_BACKGROUND_AUTOMATION.md`'s Activation
  section for the deliberate post-review steps.

## Phase 9B — receipt activation-path hardening (pre-production, still disabled) (branch: fix/phase9b-receipt-activation-hardening) — 2026-09-03
Small hardening slice closing the two activation-path findings from the independent review of
the approved first-run rollback receipt. No production enablement, no real-vault write, no
receipt modification. `OBSIDIAN_PRODUCTION_SYNC_ENABLED` stays `false`. One local commit; not
pushed, not integrated. Stops for independent hardening review.
changed:
  - obsidian-life-ledger-sync.js — FIX 1: `verifyObsidianRollbackReceipt()` now requires
    `receipt.backup === null` (strict) whenever `receipt.managedRootExistedBefore === false`.
    A first-run receipt carrying any backup payload is structurally wrong and is rejected
    before the pre-state check. The existing-root path (`managedRootExistedBefore === true`)
    is untouched — it still requires a present, byte-verified backup.
  - scripts/sync-life-ledger-to-obsidian.mjs — FIX 2: `--rollback-receipt` is now loaded via
    `loadRollbackReceiptFromDisk()` (exported), which resolves/canonicalises the path, reads
    the exact on-disk bytes, `JSON.parse`s them, and attaches runtime-only `receiptPath`
    (resolved path) + `receiptSha256` (SHA-256 of the live bytes — never a caller-supplied
    hash) to the in-memory object only. Nothing is written back to the receipt JSON. Fails
    closed on a missing / unreadable receipt, invalid JSON, or non-object JSON. The previous
    bare `JSON.parse(readFile(...))` (which never attached the runtime metadata the verifier
    needs) is replaced.
  - obsidian-life-ledger-sync.test.js — +13 tests: first-run receipt backup:null valid;
    backup:{...} / backup:"anything" / backup:{} / backup:undefined invalid; non-first-run
    semantics preserved (real backup valid, backup:null rejected); first-run managed root
    appears -> invalid; CLI loader reads real bytes / computes SHA-256 / attaches
    receiptPath+receiptSha256 / does not mutate the file; post-load byte change rejected;
    reloaded-modified receipt still rejected on plan binding; missing receipt / malformed
    JSON fail closed; planFingerprint mismatch and canonical-vault mismatch fail closed; CLI
    production --apply with a real receipt path stays `production_sync_disabled` and never
    rewrites the receipt.
verification: `node obsidian-life-ledger-sync.test.js` 63/63; `npm test` all green (0 fail;
  the single skip is the pre-existing env-gated cross-repo control test); `npm run lint` 0
  errors (19 pre-existing warnings); STRICT `npm run test:cross-repo-compat` PASS ChronaSense
  / PASS Meal / PASS Workout 29/29, zero leg skips, exit 0; `git diff --check` clean;
  `node --check` on all three changed files OK; non-ASCII scan clean (em-dash only, matching
  the file). Real approved receipt (Phase9B-FirstRun-Receipt-20260903-102747), READ-ONLY:
  disk SHA-256 still cb5dea254938e7cfa9da9c7a1906c3b5eda6192b2c4c48bd264f2f141168763f; the
  CLI loader enriches it (receiptPath resolved, receiptSha256 = live-byte hash, file
  unmodified); `verifyObsidianRollbackReceipt()` returns true against a plan carrying the
  approved fingerprint 10cb4dc2326674ebc141c1ff2c358b108cb63690341aaf9ad90d00251a153286
  (the approved plan's source snapshot is live-only and not persisted, so the plan was
  reconstructed from the receipt's own bindings — the receipt→planFingerprint binding is the
  generic mechanism). Real vault `C:\Users\Admin\OneDrive\2nd Brain\Life Ledger` absent
  before and after. Authoritative main unchanged at 90ea1f0 (M README.md / ?? APP_CONTEXT.md
  intact, protected hashes unchanged).
future work (NOT in this slice):
  - No `delete_managed_root` rollback executor exists. Any future one MUST call
    `inspectManagedRoot`, require `state === 'owned'`, verify the sentinel↔manifest binding,
    and never blindly `rm -rf` an unverified subtree. Separately reviewed change.

## Phase 9 — Obsidian ownership + rollback hardening (post independent review) (branch: feat/real-obsidian-integration-v1) — 2026-09-02
FIX FIRST pass. Architecture unchanged (Ledger → renderer → planner → authorization → apply);
one consolidated filesystem/ownership hardening pass, one local fix commit. Still no push, no
merge, no production enablement, no real-vault write. Ready for targeted independent re-review.
changed:
  - obsidian-life-ledger-sync.js — 12 hardening fixes; the plan/apply architecture is intact:
    - FIX 1 NO SENTINEL-ONLY OWNERSHIP: a root counts as owned ONLY when a schema-v2 sentinel
      validates, manifest.json exists and validates, AND `sha256(manifest bytes)` equals the
      sentinel's `manifestSha256`. Sentinel-valid + manifest-absent → BLOCK
      `missing_manifest_baseline`. Legacy v1 sentinel (no binding) → BLOCK
      `legacy_sentinel_migration_required` — old Phase-1-pass content is never silently adopted.
    - FIX 2 SENTINEL↔MANIFEST BINDING: sentinel schema advanced to v2 with a required
      `manifestSha256: <sha-256>` field. Manifest bytes edited → mismatch → BLOCK
      `manifest_integrity_mismatch`. Sentinel prose edited → `sentinelContent()` is fully
      deterministic given its hash, so any deviation → BLOCK `sentinel_content_mismatch`.
      Manifest present + sentinel missing → BLOCK. (Not called cryptographic authentication —
      integrity detection for hand edits, OneDrive conflict copies, partial applies.)
    - FIX 3 PER-FILE BASELINE REQUIRED: deleted the `adopting_sentinel_owned_file` UPDATE
      branch. An existing generated file: byte-identical → UNCHANGED; differs + no sentinel
      marker → CONFLICT `unowned_collision`; differs + marker + NO trusted manifest baseline →
      CONFLICT `missing_manifest_baseline` (never UPDATE); differs + baseline ≠ disk → CONFLICT
      `human_modified_owned_file`; differs + baseline == disk → UPDATE `content_drift`.
    - FIX 4 WINDOWS-NORMALIZED MANIFEST KEYS: `manifestKeyIdentity()` lowercases + slash-
      normalizes for identity/dedup only; the stored/rendered path stays the code-owned
      canonical form. Case-only and slash-vs-backslash duplicates reject the whole manifest.
    - FIX 5 MANIFEST ALLOWLIST: every manifest entry must be a known generated CONTENT path
      (`System/README.md` or `Daily/YYYY-MM-DD.md`), 64-hex sha256, Windows-safe. Unknown /
      absolute / traversal / duplicate entries reject the manifest → BLOCK.
    - FIX 6 UNCHANGED TOCTOU: apply preflight now re-hashes EVERY operation (UNCHANGED and
      STALE included), not just CREATE/UPDATE. Any drift → `precondition_changed`, zero writes.
    - FIX 7 PER-WRITE LINK RECHECK: `guardedAtomicWrite()` re-resolves the destination and
      re-runs containment + `assertNoLinkEscape` + `assertSafeExistingLeaf` immediately before
      each write, and again after `mkdir` so a junction inserted for a not-yet-existing parent
      is caught.
    - FIX 8 CONTENT HASH ASSERTION: `sha256(operation.content) === operation.contentSha256`
      is asserted before each write → `invalid_plan_content`, zero further writes.
    - FIX 9 EXPLICIT APPLY ORDER: operations carry a `phase` (0 content, 1 manifest, 2
      sentinel). Apply writes strictly by phase — content, then manifest, then sentinel LAST —
      never by filename sort. A valid on-disk sentinel therefore implies a matching manifest
      and complete content.
    - FIX 10 PARTIAL-APPLY RECOVERY: a mid-apply failure throws `partial_apply_failure` with
      the written list; a fresh plan afterward always fails closed (sentinel missing, or
      `manifest_integrity_mismatch`) — partial state is never auto-adopted.
    - FIX 11 REAL ROLLBACK ARTIFACT API: `prepareObsidianRollbackArtifact({ target, plan,
      backupRoot })` → frozen receipt bound to canonical vault + managed root + plan
      fingerprint + `managedRootExistedBefore`. First run: a pre-state receipt (managed root
      must still be absent at verify time). Existing root: copies ONLY the `Life Ledger/`
      subtree, hashes every file, invalidates on backup mutation. Refuses a `backupRoot`
      inside the vault; never overwrites an existing artifact.
      `verifyObsidianRollbackReceipt()` re-checks all bindings + the on-disk receipt hash +
      the backup bytes.
    - FIX 12 WINDOWS PATH HARDENING: `assertSyncRelativePath()` also rejects any `:` in a
      segment, trailing dot/space, and reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9).
    - PRODUCTION AUTH: `evaluateProductionAuthorization()` now requires `rollbackReceiptValid`
      (verified receipt) before the first-run token. `OBSIDIAN_PRODUCTION_SYNC_ENABLED` stays
      false; `applyObsidianSync` still throws `production_sync_disabled` before any receipt
      check.
  - scripts/sync-life-ledger-to-obsidian.mjs — `--first-run-backup-confirmed` replaced by
    `--rollback-receipt <path>` (reads a receipt JSON); summary carries `blockState` +
    `planFingerprint`.
  - obsidian-life-ledger-sync.test.js — rewritten: 50 tests including the review's A–I
    ownership-chaos matrix, J–M file-baseline matrix, N–Q manifest-identity matrix, R–T TOCTOU
    matrix, explicit apply-order assertion (rename order instrumented), sentinel↔manifest
    binding, rollback-artifact first-run + existing-root + tamper cases, production hard-block
    with a valid receipt, and the CLI surface.
  - obsidian-life-ledger-writer.js — no further change (still additive exports only from the
    first pass). `writeFileAtomically` is no longer imported by the sync module (it uses
    `guardedAtomicWrite`).
  - CODEMAP.md — sync-module + CLI entries updated for the v2 schema and rollback API.
verification: `node obsidian-life-ledger-sync.test.js` 50/50; `node test.js` 448/448; `npm test`
  721 (0 fail, 0 skip); `npm run test:adapter-contracts` PASS; `npm run lint` 0 errors (19
  pre-existing warnings); Playwright NOT run (no UI change). Test-vault E2E proof
  (Second-Brain-Test-Vault): v1 pass-1 fixture correctly BLOCKED
  `legacy_sentinel_migration_required` → Phase-9 test artifacts reset (authorized) → 5-file
  CREATE → apply → schema-v2 sentinel with a matching `manifestSha256` binding, manifest lists
  content files only → second plan all UNCHANGED → human edit → CONFLICT
  `human_modified_owned_file`, apply refused, edit preserved → manifest byte appended → BLOCK
  `manifest_integrity_mismatch` → clean restore. Real active vault
  (C:\Users\Admin\OneDrive\2nd Brain): READ-ONLY; `Life Ledger/` absent before and after; git
  HEAD d265b96 and 35-line status unchanged before and after; test mode → `denied_vault_root`,
  production with every flag → `production_sync_disabled`, zero writes. `node --check` all
  changed files OK; `git diff --check` clean; UTF-8/control-byte scan clean (only non-ASCII is
  the em-dash, matching the renderer). STRICT `npm run test:cross-repo-compat`: ChronaSense +
  Meal legs PASS; Workout leg STILL FAILS via the spawnSync path with the SAME pre-existing
  Windows environment artifact ("Cannot read properties of undefined (reading 'config')" at
  workout-ledger-source-contract.test.js:69) — reproduces identically on unmodified main and
  when this Builder runs the compat script directly; the workout suite passes 29/29 invoked
  directly and the Meal leg (also vitest) passes via the identical spawn path; NOT a Phase 9
  regression; per review instruction the compat runner and the Workout repo were NOT modified.

## Phase 9 — Real Obsidian Integration V1 (production-safe, real-write-DISABLED) (branch: feat/real-obsidian-integration-v1) — 2026-09-02
FIRST-PASS builder milestone. No commit beyond one local feature commit; no push, no merge, no
real-vault write. Production apply is hard-blocked pending independent adversarial review.
added:
  - obsidian-life-ledger-sync.js (new — the production-capable Obsidian sync planner/applier,
    deliberately separate from obsidian-life-ledger-writer.js because that writer is
    test-vault-only by design and its own tests assert it unconditionally blocks both real
    vaults):
    - TARGET MODEL: `createObsidianSyncTarget({ vaultPath, managedRoot:'Life Ledger',
      mode:'test'|'production', allowApply:false })` — frozen, validated; managedRoot must be
      exactly 'Life Ledger' (an arbitrary caller string can never pick the filesystem target).
    - IDENTITY CHECK: `verifyObsidianVaultIdentity()` — read-only, never throws for an ordinary
      "not safe" outcome (returns `{ ok:false, reason }`). Canonical realpath; rejects a
      missing path, a non-directory, a symlink/junction vault root, the stale Desktop vault
      (always), the real OneDrive vault (test mode), the test vault (production mode), and a
      vault path inside a supplied known-repo-root list. Production mode additionally requires
      an exact `expectedCanonicalVaultPath` match — it never auto-discovers a vault. Soft
      signals: `.obsidian` presence, OneDrive-path heuristic.
    - OWNERSHIP SENTINEL: `Life Ledger/System/MANAGED-BY-CHRONASENSE.md` — deterministic
      machine-readable frontmatter (owner + schemaVersion + managedRoot), no volatile fields.
      Presence alone is NOT ownership proof; it is one signal.
    - MANIFEST: `Life Ledger/System/manifest.json` — deterministic (sorted, SHA-256 per file,
      schema version, relative managed paths only, duplicate entries reject the whole
      manifest). Drives human-edit drift detection. manifest.json is treated as pure
      operational metadata (always safe to rewrite once the sentinel proves the root owned).
    - PLAN / APPLY SPLIT: `planObsidianSync()` returns a frozen plan of
      `CREATE|UPDATE|UNCHANGED|CONFLICT|BLOCKED|STALE` ops (sorted by relativePath, each with
      contentSha256 + previousSha256) plus `rollbackPlan`. `applyObsidianSync(plan,
      authorization)` re-verifies every writable target's precondition hash against the plan
      (TOCTOU) with ZERO writes if anything changed, then two-phase preflight-then-write.
    - OWNERSHIP MODEL (safest coherent V1): only code-allowlisted generated paths
      (`System/README.md`, `System/MANAGED-BY-CHRONASENSE.md`, `System/manifest.json`,
      `Daily/YYYY-MM-DD.md`) are app-owned. An existing `Life Ledger/` without a valid
      sentinel (INCLUDING an empty dir, and INCLUDING the pre-Phase-9 old-schema test-vault
      folder) is classified `unmanaged_conflict` and never auto-adopted or merged. A
      sentinel-bearing generated file whose on-disk SHA-256 ≠ its last manifest hash is a
      `human_modified_owned_file` CONFLICT — never silently overwritten. Any CONFLICT blocks
      the entire apply.
    - NO DELETION BY ABSENCE: a manifested Daily file absent from a later snapshot is reported
      `STALE` and left on disk (this new module supersedes the legacy writer's stale-Daily
      cleanup for production-capable flows; the legacy CLI/writer behavior is unchanged).
    - PARTIAL FAILURE: a mid-apply write error throws `partial_apply_failure` carrying the
      list of files already written — never a bare fs error that looks like "nothing
      happened", never a false success.
    - PRODUCTION HARD BLOCK: `OBSIDIAN_PRODUCTION_SYNC_ENABLED = false` — every production
      apply throws `production_sync_disabled` before any other check, regardless of flags or
      tokens. `evaluateProductionAuthorization()` is the pure, separately-testable second
      layer (mode + allowApply + apply + exact canonical-path match + path-bound
      `FIRST-RUN-CONFIRMED:<path>` token + first-run backup acknowledgement) for when the
      constant is deliberately flipped after review.
  - scripts/sync-life-ledger-to-obsidian.mjs (new — production-capable CLI parallel to the
    untouched export-life-ledger-to-obsidian.mjs. `--mode test|production` required, no
    default; plans + previews always; writes only with `--apply`; production needs
    `--expected-vault` / `--first-run-ack` / `--first-run-backup-confirmed` and is still
    refused by the build constant).
  - obsidian-life-ledger-sync.test.js (new — 54 tests: target-model validation, denied/stale
    vault rejection in both modes, exact canonical-path binding, known-repo-root rejection,
    unmanaged-root conflict (incl. empty dir), valid/invalid sentinel, malformed manifest,
    unowned collision, manifest-drift human-edit conflict, block-entire-apply-on-conflict,
    idempotency, deterministic ordering + byte-identical plan content, STALE-not-delete,
    TOCTOU abort with zero writes, symlink-after-plan abort, manifest shape (SHA-256, sorted,
    no dupes, relative paths), production hard-block via applyObsidianSync even with perfect
    auth, second-layer authorization via evaluateProductionAuthorization, rollback artifact,
    partial-failure honesty, preview format (no absolute paths leaked), plus 10 CLI tests).
changed:
  - obsidian-life-ledger-writer.js — additive `export` keywords only on the denylist-agnostic
    containment primitives (assertRelativePath, assertNoLinkEscape, assertSafeExistingLeaf,
    pathEqualsOrContains, isLinkStats, realPathOrResolved, readTextIfExists, writeFileAtomically,
    defaultFsAdapter) + a read-only `OBSIDIAN_LIFE_LEDGER_DENIED_VAULT_ROOTS` alias. Zero logic
    or behavior change; existing 448 test.js tests unaffected.
  - package.json — `test` chains `node obsidian-life-ledger-sync.test.js`; new
    `test:obsidian-sync` script; `lint` covers the two new files.
  - eslint.config.js — obsidian-life-ledger-sync.js added to both file lists (scripts/**/*.mjs
    glob already covered the new CLI).
  - CODEMAP.md — entries for obsidian-life-ledger-sync.js and scripts/sync-life-ledger-to-obsidian.mjs.
verification: `node obsidian-life-ledger-sync.test.js` 54/54; `npm test` 725 model/unit
  (0 fail, 0 skip — test.js 448 + workout-adapter 33 + meal-adapter 45 + meal-cross-repo 10 +
  temporal 20 + life-feed 36 + life-character-sheet 34 + cross-domain 45 + obsidian-sync 54);
  `npm run test:adapter-contracts` PASS; `npm run lint` 0 errors (19 pre-existing warnings);
  Playwright NOT run (no UI change). Strict `npm run test:cross-repo-compat`: ChronaSense +
  Meal legs PASS; Workout leg FAILS via the spawnSync path with a pre-existing Windows
  nested-npm/vitest environment artifact ("Cannot read properties of undefined (reading
  'config')") that reproduces IDENTICALLY on unmodified main and is NOT a Phase 9 regression —
  the workout source-contract suite itself passes 29/29 when invoked directly. `node --check`
  on all changed/new files OK; `git diff --check` clean; UTF-8/control-byte scan clean.
  Test-vault E2E proof (real Second-Brain-Test-Vault): old-schema fixture correctly BLOCKED as
  unmanaged_conflict → fixture reset (authorized by TEST-VAULT.md + spec §22) → CREATE plan →
  authorized test apply (4 files) → second plan all UNCHANGED → human edit → CONFLICT + apply
  refused + edit preserved on disk → reset to a clean Phase-9 managed subtree. Real active
  vault (C:\Users\Admin\OneDrive\2nd Brain): READ-ONLY inspection only; `Life Ledger/` absent
  before and after; git status 29 lines and HEAD d265b96 unchanged before and after; test
  mode → denied_vault_root, production mode with every correct flag → production_sync_disabled,
  zero writes.

## Phase 8 — recommendation-honesty fixes (post independent review) (branch: feat/cross-domain-intelligence-v1) — 2026-09-02
changed:
  - cross-domain-intelligence-model.js — two bounded fixes from the independent review; no
    redesign, no UI code change:
    - BLOCKER 1 (bare recency-fallback plan): `learningCandidate()` now returns null when the
      active plan is neither target-aligned nor actively tracked. The Character Sheet's
      active-plan pick can fall back to `updatedAt` (a metadata-only edit can flip it) — that
      heuristic alone must never become a top-level recommendation. The
      `learning-plan-incomplete` attention signal still carries plan title + progress + next
      step; the engine abstains (`recommendedAction: null`, confidence INSUFFICIENT). "Actively
      tracked" = ≥1 current-truth `plan_step_completed` maps to the plan (derived from the feed,
      not the `latestCompletedStep` proxy).
    - BLOCKER 2 (plan-level historical alignment): `learningAlignment()` now imports
      `CAPABILITY_CAREER_ANALYTICS_RULES` and requires a linking evidence record within
      `recentDays` of `generatedAt` (identical temporal test to `analytics.recentEvidence()` —
      no new magic number). An old historical link no longer grants HIGH / tier 2 indefinitely;
      it falls through to non-aligned logic (MEDIUM when the plan is actively tracked).
    - explanation: HIGH now says recent evidence links *past completed steps* to the target
      "— not the next step itself"; MEDIUM (tracked, unaligned) states factual tracking only;
      the recency-fallback abstention reason names the plan as "picked only by recency".
  - cross-domain-intelligence-model.test.js — 45 model tests (was 35): scenarios M / M2 / N /
    N2 / O added; alignment recency-boundary tests (observedAt at the lower bound / 1 ms before
    / in the future); the "Character Sheet parity: step counts" test split into an abstention
    variant + a tracked-plan variant; B / C / J / L / analyzer-throw / hostile-text /
    performance / revised-planId / non-target-project fixtures updated to seed an actively
    tracked completion where a candidate is genuinely expected (they previously encoded the
    now-removed bare-LOW behavior).
  - tests/cross-domain-intelligence-ui.spec.js — 13 tests (was 12): a new "recency-only plan
    is not recommended" abstention-rendering test; the shipping-beats-learning fixture now
    seeds a tracked completion so learning is a valid alternative; the "aligned learning" test
    renamed to "actively tracked learning" and asserts the MEDIUM strength tag exactly.
verification: `node cross-domain-intelligence-model.test.js` 45/45; `npm test` 671 model/unit
  (0 fail, 0 skip); `npm run test:adapter-contracts` PASS; `npm run lint` 0 errors (19
  pre-existing warnings); Playwright full suite 208/208; strict `npm run test:cross-repo-compat`
  3/3 legs PASS, no skips, exit 0; `node --check`, `git diff --check`, control-byte scan (0).

## Phase 8 — Cross-Domain Intelligence / Highest-Leverage Next Action V1 (branch: feat/cross-domain-intelligence-v1) — 2026-09-01
added:
  - cross-domain-intelligence-model.js (new — the pure, deterministic, rule-based engine that
    answers "what deserves my attention next, and what is the single highest-leverage next
    action I can actually take?". `buildCrossDomainIntelligence({ characterSheet, ledgerEvents,
    learningPlans, capabilityProfile })` → { coverage, capability, signals[], candidates[],
    recommendedAction, alternatives[], blockedDomains[], abstained, abstentionReason,
    explanation }. No LLM. Never persisted as a new truth store; never mutates its inputs;
    order-independent. FOUR LAYERS kept separate: FACT (read off the Character Sheet /
    analyzer) → SIGNAL (a factual condition that may deserve attention, no step implied) →
    CANDIDATE (a bounded thing the system could recommend, with stable provenance) →
    RECOMMENDATION (the single highest-ranked justified candidate + a fully traceable "why").)
  - COVERAGE-AWARE REASONING: a domain participates only when its Character Sheet coverage is
    `active` or `no-events-yet` (a truthful live zero). Workout / Meal / free-form activity are
    reported in `blockedDomains` as "not evaluated" — never inactive / healthy / unhealthy /
    on-track / off-track / behind. An old imported workout never becomes "you haven't worked
    out"; no focus session today never becomes a productivity verdict. Missing data is never
    turned into a negative signal.
  - CANDIDATE SOURCES (V1): (a) `learning-plan-step` — the Character Sheet's active-plan next
    unfinished step (reused verbatim, not re-traversed); (b) `capability-next-action` — the
    analyzer's own `nextAction`, but only when it is stall-driven AND (for ship / portfolio
    kinds) points at an explicit target-linked project. Setup states and bare shipping stalls
    with nothing concrete to act on stay SIGNALS — no task is invented to fill the slot.
  - ALIGNMENT CHAIN (explicit ids only, no keyword matching): a learning candidate is "aligned"
    iff there is capability evidence (source: life-ledger, not future-dated) that points at a
    plan_step_completed event of the active plan AND is attached to a skill linked to the
    active career target — plan step → Ledger event → evidence → target skill → career target.
  - RANKING: four discrete transparent tiers — (1) resolve a stall with a concrete
    target-linked project, (2) advance target-aligned committed work, (3) resolve a bare
    stall, (4) advance the learning plan — then evidence strength (HIGH / MEDIUM / LOW), then
    a stable domain / candidateId tie-break. No fake points or percentages. First-time career
    setup is an attention signal, never a candidate.
  - ABSTENTION is a feature: `recommendedAction: null` + a plain-language reason when there is
    no active plan step and no explicit career action. The engine never forces a recommendation
    to fill the UI.
  - cross-domain-intelligence-ui.js (new — renders the read-only "Next" view into
    #cross-domain-intelligence-root. Reads the Life Ledger runtime, Learning Plan repository
    and Capability profile ONCE per render, builds the pure Character Sheet, hands it to the
    pure engine, and paints: recommendation (headline + "why this" + evidence + strength tag) →
    other valid options → what's driving attention (signals) → data not evaluated. The only
    control is a plain `showView()` navigation link — no plan-step completion, no focus start,
    no writes. Semantic headings, textual (not colour-only) confidence, keyboard-operable,
    escaped rendering.)
  - cross-domain-intelligence-model.test.js (new — 35 model tests: scenario matrix A–L,
    abstention, Character Sheet / Capability analyzer / Learning parity, driving-stall parity,
    non-target-linked project → signal-not-candidate, determinism under event & profile
    reordering, temporal chaos (stale import, future evidence, cross-zone step), coverage
    chaos (imported-not-live, analyzer throw, malformed sheet), read-only,
    hostile-text-stays-inert, neutral-language, performance.)
  - tests/cross-domain-intelligence-ui.spec.js (new — 12 Playwright tests: third "Next"
    sub-tab with still-7 bottom-nav, honest empty state, aligned recommendation with traceable
    why + evidence, shipping-beats-learning with learning as alternative, data-not-evaluated
    explained in words, "Open in Learning Plans" navigates with zero writes, byte-level
    read-only proof across tab switches, keyboard operability, hostile-HTML escaping,
    aria-live, no-horizontal-overflow on a 390px phone, no moral/productivity language.)
changed:
  - life-character-sheet-model.js (learning section now also exposes stable ids —
    `activePlan.id`, `activePlan.nextStep.{stepId,lessonId,phaseId}`,
    `latestCompletedStep.planId`. Additive only; ids are facts. Phase 8 consumes these for
    candidate provenance and to reuse the exact active plan / next step the sheet already
    picked, guaranteeing learning parity by construction. No change to any existing field.)
  - life-character-sheet-model.test.js (2 new tests covering the exposed ids.)
  - life-character-sheet-ui.js (the Life sub-navigation is now three-way — Character Sheet ·
    Timeline · Next. `showLifeSubview()` / `initialSubview()` handle the third view and call
    `window.renderCrossDomainIntelligence()`; the stored `ta3-life-subview` preference accepts
    `next`. No change to the Character Sheet render itself.)
  - index.html (#view-life gains a third `.life-subnav` button (`#life-subnav-next`) and a
    `#cross-domain-intelligence-root` mount that starts hidden; new module `<script>` include.
    Still 7 bottom-nav items — no 8th.)
  - style.css (appended `.cdi-*` block — committed dark theme, reuses existing tokens; strength
    tag is bordered text, never colour-only.)
  - package.json (test script runs cross-domain-intelligence-model.test.js; new
    test:cross-domain-intelligence script; lint covers the two new modules.)
  - eslint.config.js (registers cross-domain-intelligence-model.js + -ui.js.)
verification: npm test (661 model/unit — test.js 448 + 35 new intelligence + 2 new Character
  Sheet id tests + the existing suites), test:adapter-contracts, strict test:cross-repo-compat
  (3/3 legs, no skips, exit 0), lint (0 errors, 19 pre-existing warnings), Playwright smoke /
  learning-plan-ui / capability-career-ui / plan / life-feed-ui / life-character-sheet-ui /
  cross-domain-intelligence-ui (207/207), node --check, git diff --check, control-byte scan (0).

## Phase 7 — Life Character Sheet V1 (branch: feat/life-character-sheet-v1) — 2026-09-01
added:
  - life-character-sheet-model.js (new — the canonical, UI-independent "where am I right now?"
    projection. `buildLifeCharacterSheet({ ledgerEvents, learningPlans, capabilityProfile, now,
    referenceTimeZone, liveIngestedTypes })` → a pure derived snapshot with focus / time /
    learning / capability / workout / meal / coverage sections. Never persisted as a new truth
    store; never mutates its inputs. Feed parity by construction: every Ledger-derived fact is
    read off the item set produced by buildLifeFeed() (same accept / tombstone / revision /
    day-bucketing rules), then joined back to the raw event only for a numeric payload value.
    Capability facts come straight from analyzeCapabilityCareer() (tombstone-aware evidence
    scope, no title/keyword inference). Learning progress + next step reuse
    getLearningPlanProgress() and findNextLearningPlanStep().)
  - life-character-sheet-ui.js (new — renders the snapshot into #life-character-sheet-root and
    owns the new Life view sub-navigation (Character Sheet ⇄ Timeline). Reads the Life Ledger
    runtime store, Learning Plan repository, and Capability profile ONCE per render; never
    writes to any of them. <progress> element for bounded plan progress; semantic headings;
    no color-only status; factual copy only — no scores, no advice, no red/yellow/green.)
  - life-character-sheet-model.test.js (new — 32 model tests: focus today/7-day counts &
    minutes, midnight/timezone/DST, learning active-plan selection + progress + next step,
    workout unknown-duration vs zero, meal date-only prep, capability explicit-evidence-only,
    coverage chaos A–F, Feed/Learning/Capability parity, revision & tombstone truth,
    order-independence, read-only, performance.)
  - tests/life-character-sheet-ui.spec.js (new — 10 Playwright tests: default-to-sheet, honest
    empty state with no faked zeros, real focus/learning render with bounded progress bar,
    imported-Workout "not updating automatically" coverage line, capability mirror,
    sub-nav keyboard operability, no-coaching-language scan, byte-level read-only proof,
    hostile-HTML escaping, aria-live.)
  - ZERO vs UNKNOWN: `liveIngestedTypes` (default focus_session_completed + plan_step_completed)
    controls when a domain may state a literal 0. Focus/Learning report a truthful 0 when live
    and empty; Workout/Meal/activity_logged report "Not connected to the Life Ledger yet" (or
    "loaded from an import · not updating automatically" when snapshot events exist) — an
    absent adapter is never rendered as behavioural zero.
changed:
  - index.html (#view-life restructured: adds .life-subnav with Character Sheet / Timeline
    buttons, #life-character-sheet-root mount, #life-feed-root now starts hidden. showView('life')
    now calls window.renderLifeView() (falls back to renderLifeFeed). New module <script> include.
    No 8th bottom-nav button — still 7 items.)
  - life-feed-ui.js (now resolves a reference timezone the same way the Character Sheet does —
    an explicit 'UTC' setting maps to 'Etc/UTC' — and passes it to buildLifeFeed so the two Life
    surfaces bucket "today" identically for the same events. No change to the feed model.)
  - style.css (appended .life-subnav + .lcs-* block — committed dark theme, matches existing
    tokens; <progress> styled for the plan bar.)
  - package.json (test script runs life-character-sheet-model.test.js; new
    test:life-character-sheet script; lint covers the two new modules.)
  - eslint.config.js (registers life-character-sheet-model.js + life-character-sheet-ui.js.)
  - tests/life-feed-ui.spec.js (openLife() now selects the Timeline sub-tab, since the Life
    view opens on the Character Sheet.)
verification: npm test (219 model/unit incl. 32 new), test:adapter-contracts, strict
  test:cross-repo-compat (no SKIPs, exit 0), lint (0 errors), Playwright 195 (life-character-sheet
  10 + life-feed 9 + smoke/learning-plan/career/plan), node --check, git diff --check,
  UTF-8/control-byte scan — all pass. Original main untouched.

## Phase 6 — Unified Life Feed V1: targeted review fixes (branch: feat/unified-life-feed-v1) — 2026-09-01
changed:
  - life-feed-model.js (BLOCKER 1 — revision/tombstone-aware raw dedupe. `buildLifeFeed` now
    resolves duplicate raw records that share an eventId into ONE deterministic current record
    BEFORE any display or tombstone decision, via `resolveCurrentRecords()`: highest valid
    `revision` wins regardless of input array order; records tied at the top revision must be
    equivalent (exact-duplicate case) or the event is reported as a `revision_conflict` skip;
    the winner then passes through the normal readable-guard + tombstone-exclusion checks, so a
    newer tombstoned revision correctly supersedes an older active one. Replaces the previous
    first-seen `seenEventIds` guard, which let output depend on array order and let a discarded
    tombstone fail to supersede an older active revision. No Ledger-store redesign; no mutation
    of input; comparison scoped to feed-relevant facts via a small `stableSerialize`.)
  - life-feed-ui.js (BLOCKER 2 — honest empty state: "Nothing here yet. Finish a learning step
    or a focus session and it shows up on your timeline." — no longer implies time logging /
    workouts / meals populate the feed today. BLOCKER 3 — reason-neutral skipped footnote:
    "N Ledger events could not be displayed." replaces "... not shown (unrecognized type)".
    The model still preserves detailed `reason` codes.)
  - index.html (BLOCKER 2 — honest Life tab subtitle: "Your timeline from the Life Ledger.
    Learning steps and focus sessions appear now; time, workouts and meals join as their
    integrations are connected.")
  - life-feed-model.test.js (+6 tests: rev1/rev2 order-independence with byte-equal output,
    newer-tombstone-supersedes-older-active in either order, older-active-never-wins,
    same-revision contradiction → conflict skip, no input mutation, per-skip reason codes)
  - tests/life-feed-ui.spec.js (empty-state test rewritten to assert honesty + absence of
    over-promised domains; new subtitle-honesty test; note explaining the skipped footnote is
    defensive-only and unreachable through the runtime store)
verification: npm test, test:adapter-contracts, strict test:cross-repo-compat (no SKIPs,
  exit 0), lint (0 errors), Playwright (life-feed 9, smoke + learning-plan 141, career + plan
  35), node --check, git diff --check, UTF-8/control-byte scan — all pass.

## Phase 6 — Unified Life Feed V1 (branch: feat/unified-life-feed-v1) — 2026-09-01
added:
  - life-feed-model.js (new — the canonical, UI-independent Unified Life Feed projection. Pure
    read over stored Life Ledger events: `buildLifeFeed(events, {now, referenceTimeZone})` →
    `{ items, days, counts, skipped, isEmpty }`, plus `filterLifeFeed(feed, domain)` and the
    exported `compareFeedItems` comparator. Domain mapping: activity_logged/focus_session_completed
    → Time, plan_step_completed → Learning, workout_completed → Workout,
    meal_prepared/meal_consumed → Meal. Ordering mirrors obsidian-life-ledger-renderer.js's
    sortEvents() exactly — occurredAt (instant) / occurredDate (date-only, a lexicographic prefix
    that sorts before the same day's timed events) as the primary key, recordedAt as a tiebreak
    ONLY when a date-only event is involved, then type + eventId. Never fabricates a time for a
    date-only meal_prepared, never assumes a weight unit, omits unknown durations rather than
    printing "unknown". Tombstoned events excluded; unsupported/unreadable events collected into
    `skipped[]` (never thrown, never reinterpreted). Intl.DateTimeFormat instances are cached per
    zone so a multi-thousand-event history builds in well under a second.)
  - life-feed-model.test.js (new — 30 tests: domain mapping, instant ordering, date-only handling,
    deterministic ties, tombstone exclusion, revision/current-fact, unknown duration, unknown
    workout unit, missing optional fields, unicode/HTML-like/long titles, unknown-event policy,
    Today/Yesterday grouping, filtering, empty feed, no-input-mutation, temporal chaos (midnight,
    multi-timezone, recordedAt≠occurredAt, DST boundary, equal start/end), the mixed-life chaos
    day, a 3000-event performance check, and Obsidian fact-parity.)
  - life-feed-ui.js (new — the Life tab renderer. Reads the runtime Life Ledger store once, builds
    the feed with a cheap event-signature cache, renders date-grouped scannable rows with domain
    filter chips + counts, domain-aware empty states, and an "N events not shown" footnote for
    unrecognized types. role="tablist" filters, aria-selected state, keyboard-operable chips,
    aria-live feed region, domain conveyed by text label + left border (not colour alone).
    Strictly read-only w.r.t. the Life Ledger, Meal, and Workout.)
  - tests/life-feed-ui.spec.js (new — 8 Playwright tests: empty state, mixed-life day render + order
    + domains through the product, filter subsetting + aria state, zero-match domain empty message,
    tombstone exclusion, hostile-HTML-is-text, read-only ledger after view/filter, keyboard filters.)
  - index.html (new `#nav-life` bottom-nav button + `#view-life` container with `#life-feed-root`;
    `showView('life')` calls `window.renderLifeFeed()`; `life-feed-ui.js` module script include)
  - style.css (appended `.life-feed-*` block — mobile-first compact rows, sticky day headers,
    filter chips, focus-visible outlines, per-domain left-border accents)
  - eslint.config.js / package.json (new module files added to lint + module-config lists; new
    `test:life-feed` script; `life-feed-model.test.js` added to `npm test`)
  - CODEMAP.md (new life-feed-model.js / life-feed-ui.js stubs + "HTML — Unified Life Feed View")
verification:
  - npm test — all suites pass (test.js 448, node:test groups incl. life-feed-model 30/30)
  - npm run test:adapter-contracts — pass
  - npm run test:cross-repo-compat (STRICT, MEAL_REPO_PATH + OPENGYM_REPO_PATH set) — all legs
    executed and passed, no SKIPs
  - npm run lint — 0 errors (pre-existing warnings only)
  - npx playwright test — smoke 64, learning-plan/career 85, plan 27, life-feed 8 — all pass
  - node --check on all new/changed JS + eslint.config.js; git diff --check clean;
    UTF-8/no-BOM/zero-control-byte scan clean on all changed files
notes:
  - The live app currently only writes plan_step_completed / focus_session_completed into the
    runtime Life Ledger (via learning-plan-ui.js). activity_logged / workout_completed /
    meal_prepared / meal_consumed have adapters + contracts but are not yet wired into the
    ChronaSense runtime store — that wiring is source-adapter integration work, out of Phase 6
    scope. The feed model + tests fully support and exercise all six types today.


## Workout → Life Ledger Adapter V1 — third targeted fix pass (branch: feat/workout-life-ledger-adapter-v1) — 2026-08-31
changed:
  - obsidian-life-ledger-renderer.js (the previous pass's renderer/core "field-for-field mirror" claim
    was incomplete: it did not cover the `startedAt`/`endedAt`/`durationMinutes` time-and-interval
    contract at all, so the renderer still accepted and rendered a workout_completed event with a
    missing `startedAt`/`endedAt`, `durationMinutes: 0`, an end before its start, or an `endedAt` that
    disagreed with the top-level `occurredAt` — all cases the shared core already rejected. Added an
    independent time-facts guard mirroring `life-ledger-core.js`'s `PAYLOAD_RULES.workout_completed`
    time/duration contract exactly (required valid ISO instants, positive-duration-or-omitted-with-
    zero-interval, occurredAt/endedAt agreement), and removed the `event.payload?.startedAt ||
    event.occurredAt` silent fallback from the rendered line — a missing/invalid workout timestamp now
    fails validation before any Markdown is generated, instead of rendering a fabricated time)
  - workout-life-ledger-adapter.js (fixed a genuine correctness defect, not merely a theoretical one:
    a 32-bit FNV-1a fingerprint collision — reproduced end-to-end through this adapter's own
    normalization pipeline — could cause a changed same-ID workout's `note` to be silently treated as
    an idempotent unchanged retry instead of an `immutable_workout_conflict`, discarding the incoming
    change without any conflict signal. Both places in the adapter that compare "is this the same
    workout" — the within-batch duplicate/conflict grouping in `normalizeWorkoutBackup()`, and the
    against-existing-stored-record check in `importWorkoutBackup()` — now compare the actual canonical
    factual serialization (`serializeLifeLedgerFacts()`) directly rather than trusting fingerprint
    equality as sufficient proof. The shared fingerprint algorithm in `life-ledger-core.js` itself is
    unchanged; this is scoped entirely to the workout adapter's own conflict/duplicate comparisons.
    `life-ledger-core.js`'s generic `upsertManyLifeLedgerEvents()` duplicate-physical-input check
    still compares by fingerprint only — that generic path is out of this bounded fix's scope and is
    called out as a remaining risk, not silently left undocumented)
  - docs/LIFE_LEDGER_CONTRACT.md (corrected the "Immutable-after-first-acceptance conflict policy"
    section, which previously described the comparison as fingerprint-based; it now documents the
    canonical-factual-content comparison and explicitly notes the fingerprint collision risk that
    motivated it. Expanded "Optional duration" to state the full time/interval contract explicitly and
    that both validators enforce it identically)
  - test.js and workout-life-ledger-adapter.test.js (expanded `WORKOUT_PARITY_FIXTURES` with 9 new
    time/interval cases — missing/invalid startedAt or endedAt, end before start, zero duration, a
    duration claimed against a zero interval, occurredAt/endedAt disagreement, and the valid
    unknown-duration case — all proven to reject/accept identically in both validators; added a
    verified real fingerprint-collision regression proving `immutable_workout_conflict` still fires,
    the original event/eventId/revision/note are preserved unchanged, no duplicate event is created,
    and a separate test confirming a true identical-facts retry still resolves to `unchanged`)
tests:
  - `npm run test:workout-adapter` — 33 passed
  - `npm test` — 471 passed (438 ChronaSense/core/export tests + 33 adapter tests)
blockers: none
deviations: same as the entries below — openGym remained read-only, deletion/restore remain
  unsupported, and no commit/push/merge/deploy/production write occurred in this fix pass either. The
  reviewer's own example note-value collision pair (`n1v5w5xb15ui35j` / `n1h9c8k30sht75r`) could not
  be reproduced against this repo's specific canonical fixture shape and was not used verbatim; an
  equivalent genuine collision (`n6vl8` / `nnpd6`, both hashing to `fnv1a32:9ce28ae5`) was found by
  direct search against this adapter's real serialization/hash output, independently re-verified
  end-to-end before being committed to the regression test, and proves the identical class of defect.

## Workout → Life Ledger Adapter V1 — second targeted fix pass (branch: feat/workout-life-ledger-adapter-v1) — 2026-08-31
changed:
  - life-ledger-core.js (the `workout_completed` payload shape validator is now a fully allowlisted
    schema, not a type-check that tolerates arbitrary extra keys: `program` and a top-level `sets`
    field are removed from the allowed payload keys and now rejected outright rather than passing
    through unchecked; `payload.source`, `exercises[]`, `exercises[].sets[]`, and
    `exercises[].prescription` each reject any key outside their documented allowlist;
    `payload.source.timezoneContext`/`weightUnitContext` reject extra nested keys, and a
    `weightUnitContext` of `{ authority: 'unknown', unit: 'lb' }` — a contradictory combination — is
    now rejected instead of silently accepted; `recordOrigin` and `completionBasis` are now enum-locked
    to the exact values the adapter produces instead of accepting any non-empty string, so an
    overclaiming value such as `definitely_native` or `cryptographically_verified` is rejected.
    Scoped entirely to `event.type === 'workout_completed'`; no other event type's validation changed)
  - obsidian-life-ledger-renderer.js (the renderer's independent workout_completed payload guard is
    now a field-for-field, allowlist-for-allowlist mirror of the core validator above — closing a
    semantic-drift gap where the renderer previously accepted payloads the core rejected: missing
    `exerciseId`, missing/invalid `mode` paired with an unchecked `sets` array, an empty `sets` array,
    out-of-range `rir`/`rpe`, an entirely unvalidated `prescription` object, and a `bodyWeight` with
    extra fields. `test.js`'s `WORKOUT_PARITY_FIXTURES` matrix now runs every fixture against both
    validators and asserts they agree, acting as an ongoing drift guard between the two independent
    copies)
  - workout-life-ledger-adapter.js (a fatal batch/context rejection — missing observation clock,
    invalid timezone/weight-unit assertion — now returns one `invalid` outcome per physical input
    record, once the physical record count is known from a confirmed `backup.workouts` array, instead
    of an empty `outcomes: []` that understated what was actually in the batch. A backup that isn't a
    well-formed object, or whose `.workouts` isn't an array, still returns `outcomes: []` since no
    coherent physical record set exists to enumerate in that case)
  - docs/LIFE_LEDGER_CONTRACT.md (documented the exact allowlisted `workout_completed` payload shape —
    per-mode set fields, prescription fields, the full `payload.source` enum/shape table — and the
    complete top-level `importWorkoutBackup()` status matrix, including fatal-context outcome
    accounting)
  - test.js and workout-life-ledger-adapter.test.js (added the shared core/renderer parity matrix and
    regression coverage for every case above, plus fatal-context outcome proofs for 3-record and
    0-record batches and re-confirmed all previously approved source-authority behaviors)
tests:
  - `npm run test:workout-adapter` — 30 passed
  - `npm test` — 468 passed (438 ChronaSense/core/export tests + 30 adapter tests)
  - `npx playwright test` — 176 passed
  - `node --check` on the adapter, adapter tests, core, runtime, transport, renderer, CLI export
    script, and `test.js` — passed
  - `git diff --check` — passed
  - control-byte/UTF-8 round-trip scan over every changed file — passed
  - ESLint — 0 errors; 19 pre-existing warnings outside the adapter/core/renderer
blockers: none
deviations: same as the entry below — openGym remained read-only, deletion/restore remain
  unsupported, and no commit/push/merge/deploy/production write occurred in this fix pass either.

## Workout → Life Ledger Adapter V1 — final consolidated fix pass (branch: feat/workout-life-ledger-adapter-v1) — 2026-08-31
changed:
  - workout-life-ledger-adapter.js (new deterministic openGym backup normalization/import boundary;
    first-valid immutable acceptance; explicit same-ID conflicts; stable ID mapping; source-compatible
    native/CSV fixtures; unknown duration; asserted timezone/optional weight-unit context; strength,
    timed, cardio, bw, topW, rating, note, PR, and prescription facts; record-level partial results;
    no inferred deletion or restore. Fix pass: bounded/control-character-safe text and identifier
    validation (workout/exercise name, exercise/routine/PR IDs, progression rule, note); malformed
    exercise-name values are now rejected instead of silently dropped; an explicit per-physical-record
    outcome — `accepted` / `duplicate` / `conflict` / `invalid` / `failed` — for every backup row, so
    identical duplicate rows are never silently collapsed without a trace; top-level `importWorkoutBackup()`
    `status` now also reflects individual ledger-upsert rejections, not only normalization/conflict
    counts; `iw`-prefixed records are now labeled `csv_import_path_compatible` with
    `confidence.basis: 'validated-supplied-backup-record'` instead of the overclaiming
    `csv_imported_history` / `validated-imported-history-record` labels)
  - life-ledger-core.js (allows `workout_completed` to omit duration only for equal start/end instants;
    removed the rejected generic source-snapshot watermark behavior. Fix pass: added a `workout_completed`-
    only deep payload shape validator — reachable through `validateLifeLedgerEvent`/`validateLifeLedgerEventDraft`
    for any caller, not only the adapter — so a hand-built or corrupted event with a wrong-typed
    `workoutName`/`exercises`/`bodyWeight`/`rating`/`note`/nested set no longer passes shared validation.
    Scoped to `event.type === 'workout_completed'` only; no other event type's validation changed)
  - obsidian-life-ledger-renderer.js (deterministic compact Workout section for mixed Ledger exports.
    Fix pass: added a self-contained `workout_completed` payload guard — mirroring the core validator's
    checks without importing it, keeping the renderer dependency-free — so a malformed workout event
    handed to the renderer directly throws an explicit error instead of producing a plausible-looking
    fabricated line such as `Workout **[object Object]** · 0 exercises`)
  - workout-life-ledger-adapter.test.js and test.js (source-compatible, adversarial, core-contract,
    mixed-renderer, hostile-input, retry, conflict, and fail-closed coverage, plus fix-pass regression
    coverage: malformed-payload rejection at the shared-validation and renderer layers, oversized/control-
    character text and identifier rejection, per-record duplicate/conflict outcome classification with
    reversed input order, forced ledger-upsert-rejection status proof, and a forged `iw`-prefixed record)
  - package.json and eslint.config.js (included the adapter in focused/full test and lint tooling)
  - CODEMAP.md (documented the adapter authority model and renderer support)
  - docs/LIFE_LEDGER_CONTRACT.md (rewrote the `workout_completed` section to document the actual
    reviewed V1 contract: stable source-owned identity, optional duration, the adapter-enforced
    immutable-after-first-acceptance conflict policy as a documented exception to the general revision
    rule, no `_ts` causal versioning, unit/timezone/observation-time assertion semantics, `payload.source`
    field meanings, `iw`-prefix provenance uncertainty, unsupported deletion/restore, and per-record
    malformed-input outcomes)
tests:
  - `npm run test:workout-adapter` — 27 passed
  - `npm test` — 464 passed (437 ChronaSense/core/export tests + 27 adapter tests)
  - `npx playwright test` — 176 passed
  - `node --check` on the adapter, adapter tests, core, runtime, transport, renderer, CLI export
    script, and `test.js` — passed
  - `git diff --check` — passed
  - ESLint — 0 errors; 19 pre-existing warnings outside the adapter/core/renderer
blockers: none
deviations: openGym remained read-only. Its backup supplies stable workout IDs, but no durable
  per-workout version or historical unit; global `_ts` and current `unit` are therefore not authority.
  Backup JSON cannot prove whether a structurally valid record was native, restored, or injected, so
  provenance says supplied backup plus validation rather than claiming native origin. Deletion/restore
  remain unsupported. No TASKS/status workflow file was changed because this was the user-directed
  Goal Mode milestone. No commit, push, merge, deploy, production/Firebase/Obsidian write, Meal change,
  openGym mutation, or real user-data import was performed.

## Capability/Career V1 reviewer fix packet — ready (branch: feat/capability-career-v1) — 2026-08-31
changed:
  - capability-career-analytics.js (filters current evidence to exclude future timestamps and
    unavailable/tombstoned Life Ledger references; treats active targets with no linked active
    skills as setup; prevents archived/paused project portfolio stalls and project next actions)
  - capability-career-model.js (repository/hydration validation now enforces the same string caps as
    constructors for names, titles, summaries, notes, references, and evidence fields)
  - capability-career-ui.js and capability-career.css (Life Ledger picker only offers live events,
    dashboard shows held-aside historical evidence, analytics receives full Ledger availability, and
    actionable projects can be explicitly marked portfolio-ready)
  - test.js and tests/capability-career-ui.spec.js (regressions for archived/paused projects,
    target-skill mapping, future evidence boundaries, Ledger tombstone/restore, portfolio-ready UI
    resolution, and oversized durable strings)
tests:
  - `npm test` — 424 passed, 0 failed
  - `npx playwright test tests/capability-career-ui.spec.js` — 8 passed
  - `npx playwright test tests/learning-plan-ui.spec.js` — 77 passed
  - `npm run test:smoke` — 176 passed
  - `npm run lint` — 0 errors; 19 pre-existing warnings outside Career files
  - `node --check capability-career-model.js capability-career-repository.js capability-career-import.js capability-career-analytics.js capability-career-ui.js test.js tests/capability-career-ui.spec.js` — passed
  - `git diff --check` — passed; only existing LF/CRLF normalization warnings on touched files
blockers: none
deviations: no TASKS.md status was changed because this was a bounded reviewer fix packet, not an
  active TASKS.md Codex task; no commit, push, merge, deploy, Firebase write, Obsidian write, or
  external data access was performed.

## Capability/Career V1 — milestone ready (branch: feat/capability-career-v1) — 2026-08-31
changed:
  - capability-career-model.js (new local profile schema, constructors, validation, archival, and
    mutation helpers for explicit skills, targets, projects, artifacts, and evidence)
  - capability-career-repository.js (new versioned localStorage repository at
    `ta3-capability-career-v1`, with read/write validation and corruption-safe errors)
  - capability-career-import.js (new strict JSON preview/import pipeline with name/title references,
    no caller-supplied durable IDs, and no partial persistence on invalid imports)
  - capability-career-analytics.js (new deterministic, non-LLM stall and next-action analysis over
    explicit evidence dimensions)
  - capability-career-ui.js and capability-career.css (new Career dashboard, progressive setup,
    import preview, Life Ledger evidence picker, project/proof/artifact flows, and mobile-safe
    styling)
  - index.html (wired the Career view, nav entry, stylesheet, module script, and render hook)
  - test.js and tests/capability-career-ui.spec.js (new model/repository/import/analytics unit
    coverage and browser workflow coverage)
  - package.json and eslint.config.js (included new Career modules in lint/test tooling)
  - CODEMAP.md, docs/ARCHITECTURE.md, docs/DECISIONS.md (documented the new Career module map,
    storage boundary, Life Ledger read-only evidence rule, and deterministic analytics rule)
tests:
  - `npm test` — 412 passed, 0 failed
  - `npm run lint` — 0 errors; 19 pre-existing warnings outside the Career files
  - `npx playwright test tests/capability-career-ui.spec.js` — 7 passed
  - `npx playwright test tests/learning-plan-ui.spec.js` — 77 passed
  - `npm run test:smoke` — 175 passed
  - `node --check capability-career-model.js capability-career-repository.js capability-career-import.js capability-career-analytics.js capability-career-ui.js` — passed
  - `git diff --check` — passed; only existing LF/CRLF normalization warnings on touched files
blockers: none
deviations: no TASKS.md status was changed because this was a bounded Goal Mode milestone, not an
  active TASKS.md Codex task; no commit, push, merge, deploy, Firebase write, or Obsidian write was
  performed.

## TASK-003 — approved, held for /merge (branch: task-003) — 2026-07-21
changed:
  - tools/Run-Codex-Build.ps1 (new `Get-TaskBlockText`/`Get-TaskDeclaredFiles` helpers; after the
    existing deny-list guard, computes changed files not declared by any tracked task and not a
    standard evidence file; writes a task-ID-tagged note to gitignored `.scope-note.txt` on
    mismatch, soft -- never blocks the build)
  - tools/Run-Claude-Review.ps1 (reads `.scope-note.txt`, uses it only if it names the task
    currently under review, always deletes it after reading; folds it into the Claude reviewer
    prompt as an explicit item to address in REVIEW.md)
  - .gitignore (added `.scope-note.txt`, same transient-handoff-file convention as
    `.last-phase-result.txt`)
tests: `[System.Management.Automation.Language.Parser]::ParseFile` on both changed files (pass);
  direct diff against Meal Prep's pre-port versions confirmed both files were functionally
  identical beforehand; fixture harness against the ported file/scope-parsing helpers, re-run
  against this app's own copy (8/8 assertions pass)
blockers: none
deviations: ported from the sibling Meal Prep app (its TASK-034/D-053), which built this first
  after comparing the shared AI Dev OS template against github.com/cathrynlavery/codex-build; no
  live end-to-end run in either app -- disclosed as unverified-live in TEST_REPORT.md
→ status set to `approved` in TASKS.md (red-zone automation surface, held for human /merge)

## TASK-002 — approved, held for /merge (branch: task-002) — 2026-07-21
changed:
  - tools/Generate-Digest.ps1 (builds the digest incrementally, stops before a safe char threshold,
    appends a "+N more" note instead of truncating the raw string)
  - tools/Dispatch-Commands.ps1 (stale-lock check now verifies the recorded PID is actually still
    running; lowered the still-running staleness wait from 2 hours to 45 min; sends a Telegram
    notice via the existing OUTBOX relay when it clears a stale lock instead of clearing silently)
tests: `[System.Management.Automation.Language.Parser]::ParseFile` on both files (pass); digest fix
  run against the real, live-failing planning/PROPOSALS.md (12 proposals) -- output 3911 chars,
  under Telegram's 4096 limit, all Approve/Park items kept; isolated 4-case fixture test of the
  stale-lock decision logic (dead PID, live+fresh, live+46min, live+44min-boundary), all pass
blockers: none
deviations: found live in the same session as TASK-001 -- a real Telegram digest-delivery failure
  ("message is too long") led to investigating why the queued TASK-001 /merge commands sat
  unprocessed, which led to discovering the hung-process/2-hour-stale-lock gap. The emergency
  DIGEST.md content regeneration already landed on main directly, ahead of this branch, since it's
  a data refresh rather than automation-surface code
→ status set to `approved` in TASKS.md (red-zone automation surface, held for human /merge)

## TASK-001 — approved, held for /merge (branch: task-001) — 2026-07-20
changed:
  - tools/Run-Codex-Build.ps1 (before auto-chaining a status:-review build into review, requires the
    build touched CHANGELOG.md or TEST_REPORT.md; blocks as a no-op with a clear note otherwise)
  - tools/Dispatch-Commands.ps1 (factored build/review classification into a shared
    Resolve-ReviewOutcome; added crashed-review-retry and no-op-retry cases; fixed a HELD-vs-APPROVED
    false-positive; added a pending-review-resume step to Invoke-Autopilot so plain /go resumes a
    stuck review; RETRYING vs NEEDS YOU summary wording)
tests: `[System.Management.Automation.Language.Parser]::ParseFile` on both files (pass); isolated
  fixture harness against Resolve-ReviewOutcome, extracted from this repo's own copy of the code (5
  cases / 9 assertions, all pass)
blockers: none
deviations: ported directly from the Meal Prep app (sibling project, sharing this exact
  tools/Dispatch-Commands.ps1 / tools/Run-Codex-Build.ps1 template) after that app found and fixed
  this bug live as its own TASK-032/D-051; full live end-to-end verification (a real crashed review,
  a real no-op retry) not attempted here either -- not safely reproducible without spawning real
  codex/claude CLI processes against a live branch
→ status set to `approved` in TASKS.md (red-zone automation surface, held for human /merge)

## [0.4.0] — 2026-04-19
### Added
- **Phone usage auto-tracking (Android)** — detects Instagram, YouTube, TikTok, Facebook, Twitter/X, Reddit, Snapchat, Pinterest, Netflix, Google Meet, Telegram, WhatsApp, Chrome and more via Android UsageStats API. Sessions logged automatically every 15 minutes.
- **Browser extension (Chrome/Edge)** — silent background tracker logs active browser tabs to your account. Supports YouTube, Reddit, LinkedIn, Notion, GitHub, Figma, Slack and more. Sign in with Google once, works for multiple users each with their own account.
- **URL scheme shortcuts** — `chronasense://start?task=X` starts the timer, `chronasense://quicklog?task=X&energy=Y` instantly logs a past block. Use with home screen launchers or Tasker.
- **PC Time auto-start** — timer starts automatically as "PC Time" when Edge/Chrome opens, so no time is lost before you set a task.
- **2-way full sync** — timer start/stop/task name, Away state, Settings, Reviews, and Weekly Plans all sync instantly across all devices via Firebase.
- **Edit buttons on entries** — pencil icon on Today timeline and Week all-entries list to edit past logs.
- **Unlogged hours card** — stacked bar below Top Activities showing unlogged time per day this week.
- **Timer block details** — shows start time, current time, and elapsed in h+m format.
- **Onboarding updated** — new steps covering phone tracking, browser extension, and URL shortcuts.

### Fixed
- Phone auto-logs skip time windows already covered by manual entries (manual always wins)
- Stop syncs correctly as full reset (not pause) across devices
- Away state syncs to other devices in real time
- Settings sync now applies all fields, not just timezone
- Reviews and weekly plans sync bidirectionally by timestamp

---

## [0.3.0] — 2026-04-09
### Added
- Pomodoro focus mode (25/5 default, adjustable work/break durations)
- Auto-logs work session on pomodoro completion
- Session dots showing completed pomodoros
- Deep work progress bar in focus mode
- Editable task input in focus mode (instead of showing today's intention)
- Current task label shown above timer when running
- Editable timeline entries — tap any entry to edit time, activity, energy

### Fixed
- Switch task button now skips "Still on" — opens form pre-filled with current task
- Focus mode "Switch task" calls correct function (no more duplicate log)
- Two timers conflicting when main timer + pomodoro both running
- End early break button broken (endBreak name collision with pomodoro)
- Untracked blocks removed — gap detection handles missed pings instead
- "YOU SAID" bar removed from ping modal (redundant with "Still on" button)
- Sync pill removed from header (always synced when signed in)

### Changed
- Week view day tabs redesigned to two-row layout with actual dates
- Elapsed time on ping modal shows actual block time, not hardcoded interval

### Renamed
- App renamed from "Time Audit" to "ChronaSense"
- New icon applied to all Android densities + splash screens

---

## [0.2.0] — 2026-04-08
### Added
- Google sign-in via Firebase Auth
- Break timer with auto-resume
- Gap detection — auto-detects unlogged time between entries
- Retro log (Past block) — log anything with custom start/end time
- Away stamper — mark gaps as Sleep, Commute, Break, Offline
- Recent activity chips in log modal
- Quick log redesigned as bottom sheet with chips and energy grid
- Activity colors — 32 curated palette + HSL golden-angle overflow
- Timeline bucketed in 30-min windows, expandable to micro detail
- Week view redesign — day detail, month view, energy split, top activities
- "YOU SAID" context bar in ping modal showing committed task
- Switch task mid-block — logs current, opens pre-commit for new task
- Capacitor Android setup with local notifications for background pings
- Settings tab black space fixed

---

## [0.1.0] — 2026-04-06
### Initial version
- Ping timer with adjustable interval (default 30 min)
- Log modal — activity, energy type, on-plan flag
- Firebase Realtime Database for persistence
- Today's timeline view
- Basic week view
- Settings tab
- Daily review — win, waste, tomorrow's focus
- Live cost tracker ($x drifting)
