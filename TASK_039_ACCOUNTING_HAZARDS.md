# TASK-039 — accounting hazards: local closure candidate and compatibility STOP

**Overall verdict: BLOCKED for full app integration.** The demonstrated paths pass in the connected
local adapter. The adapter is deliberately not loaded by `index.html`; this is not an app-wide safety PASS.
Guardian **NOT RUN / NOT PASSED**. Production **NO-GO**.

Base: `9b0671ba8deca394170aeff84f12825341ff7b71`; branch `task-039-accounting-hazards` in the preserved
`.worktrees/task-039-unknown-resolution` worktree. No broader stale-write integration was resumed.
Canonical production rules/builder, PR #20/gateway, storage.js, focus-mode.js and extension source
remain unchanged. No push, merge, deployment, live data access or phone testing occurred.

## Actual application changes

- `createTimeAck().begin()` durably records `preparing`, including identity and immutable proposed
  values, **before** its first agreement read. Other tabs' deliberate accounting guards and sync
  deferral see that preparation. An interrupted unsent preparation can be authoritatively refused.
- `abandon()` cannot clear UNKNOWN. The UI no longer offers time-based Keep original. A recorded
  keep-server cancellation resolution cannot be retried or finalized as the original Undo.
- The existing scheduled occurrence calculation is unchanged. `captureOnly` returns its computed
  records before mutation; `applyAutoTemplateEntries()` contains the verbatim publication tail.
  The normal default path retains its original behavior. This lets the local adapter freeze an
  eligible occurrence before a later template edit, without recalculating its timestamps.
- Governed token: `20261028-task039-accounting-hazards-v1`; generated www mirror updated.

## Connected local implementation

The browser harness explicitly installs `accounting-hazards/command-journal.js` and
`browser-adapter.js` against `accounting-hazards/rules.js`. Neither script is a production dependency.
The journal contains publication bookkeeping, not duration or cursor calculations.

1. Ordinary Save/Stop/Switch bodies run under the same account Web Lock as Undo. Durable preparation
   precedes mutation; checkpoints precede the legacy independent cache writes. Their frozen entry,
   redemption and timer changes publish in one atomic PATCH with one identity and original bases.
   A pending/uncertain prior command blocks Undo. Fresh reads cannot reauthorize a stale local
   timer/device/session. Conflicts and interrupted commands retain their originals and drafts.
2. Automatic recovery, template occurrences, Break expiry, PC Time intervals and pings are frozen
   into account/device-bound durable events before mutation or waiting. Earlier events drain before
   later manual commands; repeated resumptions share the same event execution. Completion receipts
   retain the event ID, so interruption before queue-key removal cannot repeat a completed effect.
3. The local rules variant adds the existing proven revision/existence gate only to accounting
   records, plus the permanent original-operation-ID cancellation marker. It changes no planning
   grant or authentication principal. Old packets are refused; no whole-room write grant is added.
4. User-confirmed Keep server version persists its resolution, confirms permanent cancellation,
   then reads one authoritative account snapshot. Unsynced entries/redemptions or an unproven local
   cursor prevent retirement. The cursor must actually agree with the authoritative timer after
   reconciliation; a rejected stale-timestamp update is not success. Frozen automatic events remain
   separate and resume with their original intervals. Lost replies retain the original identity.

Process-interruption tests prove that a partial ordinary command stays durable and blocked without
publishing a partial entry/cursor pair. They do **not** prove automatic completion of an arbitrary
interrupted UI command. Likewise, local adapter sync calls outside its selected command boundaries
are refused; unwrapped forms, Focus/Away/native and independent writers are not silently supported.
That is a remaining integration boundary, not permission to enable these rules in production.

## Verification

`accounting-hazards/RESULTS.json` is the machine-readable result record; logs remain locally alongside
it under ignored `*.log` files. Core commands:

```text
node --test time-ack.test.js accounting-hazards/command-journal.test.js accounting-hazards/external-writer-boundary.test.js accounting-hazards/before-image-probe.test.js
node --test unknown-recovery-proof/recovery.test.js
npx playwright test tests/time-ack-unknown-hazards.spec.js --workers=1
npx playwright test tests/time-ack-undo.spec.js tests/smoke.spec.js tests/calendar-native-plan-identity.spec.js --workers=1
npm test
npm run lint
node accounting-hazards/preservation.mjs
node scripts/runtime-mirror.mjs --check
node scripts/firebase-rules-builder.mjs
git diff --check
```

Both synthetic accounts cover the original first-read loss and original recovered 10–12 minute loss,
already-submitted ordinary writes, atomic entry/cursor identity, delayed Undo, offline retention,
reload, actual child-process interruption, lost ordinary/cancellation replies, concurrent replay,
template edits, Break timestamps, PC Time classification, accidental expired recovery, device takeover,
local-only redemptions and refusal to claim an unapplied cursor as reconciled.

`PRESERVATION.json` verifies byte-identical protected source functions and frozen files against the
base, plus the verbatim scheduled calculation/publication. The earlier cancellation proof is preserved
against an exact copy of the baseline lifecycle, including its unsafe legacy-abandon counterexample.
Its real >120-second test remains distinct from the new connected-client prevention tests.

Independent review found and required fixes for automatic event ordering, post-receipt interruption,
fresh-revision/stale-local-timer reauthorization, redemption/cursor reconciliation and accidental
expired recovery. Dedicated regressions cover each. The final review is tied to the local commit;
the review record states its artifact-only scope, not production approval.
Independent exact-source review approved `fac8dd00d9132171d42c03b103b73e749804811c` for this
**BLOCKED local handoff**, with no remaining must-fix within the declared artifact scope. The
scope/findings record is `accounting-hazards/INDEPENDENT_REVIEW.md`; it grants no deployment approval.

Exact review of `55aa1cd` requested two further repairs: recheck completed event receipts inside the
shared lock, and reject unknown/malformed existing revision metadata in the local rules. Both were
fixed. Final prevention counts are **28 browser / 47 emulator**, including a deliberately paused
second-tab refresh across the first tab's completed event and the metadata-refusal controls.

Not run: full browser suite, repeated strict-seven matrix, hosted CI, Guardian, live writer inventory,
production compatibility/canaries or phone acceptance. These are not counted as passing gates.

## Confirmed STOP: independent writer retention and physical entry keys

The real extension `logSession()` and real app `syncEntries()` are extracted and executed against
the emulator for both accounts in `external-writer-boundary.test.js`:

- Under the strict accounting gate the extension advances persisted `lastSessionByDomain`, then
  its unconditional numeric-key PUT is refused. It interprets 401 as expired authentication and
  retains no complete failed command. Enabling the gate would risk losing that automatic session.
- Under canonical rules, the extension writes `entries/<startTs>`. The app discards the physical
  key while reading and republishes the same logical ID as `entries/e_<id>`. Entry-only Undo can
  tombstone `e_<id>` while the numeric source remains live and reappears to another fresh reader.
- Exempting this independent writer preserves its delayed unconditional authority. Renaming or
  erasing aliases would silently choose a data identity/migration policy, potentially over
  contradictory records or legacy work without original before-images.

This is an additional accounting compatibility boundary under objective 5. It does **not** prove
that time arithmetic needs redesign, and complexity is not the reason for stopping. A safe path
requires an explicit physical-key/legacy-retention contract and complete participating-writer proof.
Full app promotion and rule activation are stopped; the local adapter remains unwired.

The two original scenarios are prevention regressions **within the local implementation**. They
must not be represented as closed for every legacy/canonical app writer. The actual application
still lacks that complete accounting integration, including safe command-specific interrupted-draft
recovery and all affected automatic/manual writer boundaries.

## Single next approval

Authorize one bounded LOCAL compatibility follow-up: preserve original physical entry keys; update
only proven-identical numeric/`e_` aliases atomically; retain contradictory aliases and unknown-base
legacy work without choosing a winner; give the extension a durable immutable pending command; then
finish wiring and verifying the accounting journal across the remaining affected writers. No automatic
alias deletion/migration, planning/API stale-write work, rule deployment or production approval.

Guardian remains **NOT RUN / NOT PASSED**. Production remains **NO-GO**.
